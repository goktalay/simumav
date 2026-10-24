"""`/api/hangar` ekleri (yol haritası "Hangar"): donanım kataloğu, dron başına kalıcı Lua script'leri, logo / çıkartma görselleri.

- Script'ler `drone_scripts` (dron başına ≤ 8, her biri ≤ 64 KB, ad `[a-z0-9_-]{1,40}.lua`, UTF-8 metin). SUNUCU SITL'inde kullanıcı Lua'sı
  varsayılan olarak ÇALIŞTIRILMAZ (`SIMUMAV_LUA_RUN=0`; dünyaya açık sunucu — ArduPilot Lua'sının dosya/ağ yakını API'leri kum havuzu ve güvenlik
  incelemesi olmadan açılmaz). Script'ler kalıcıdır, indirilebilir (Mission Planner ile gerçek araca / yerel SITL'e yükleme).
- Görseller `drone_decals`: data URL (PNG/JPEG/WebP ≤ 1 MB, ≤ 16 MP) → Pillow ile YENİDEN KODLANMIŞ PNG (EXIF ve gömülü içerik atılır; en uzun
  kenar ≤ 1024 px), `DATA_DIR/files/decals/<uid>/<belirteç>.png`; servis `GET /api/hangar/decals/<belirteç>.png` oturumsuz (karşılaşmada diğer
  oyuncular da görür; 32 bayt rastgele belirteç, nosniff, sandbox CSP). Dron başına ≤ 6; görünümde (equipment.livery.decals) kimlikle kullanılır."""
import base64
import hashlib
import io
import json
import os
import re
import secrets
from typing import Optional

from fastapi import APIRouter, Request
from fastapi.responses import FileResponse, Response
from pydantic import BaseModel, Field

from .. import auth, config, db, equipment
from .common import User, sahip

router = APIRouter(prefix='/api/hangar')

SCRIPT_MAX = 8
SCRIPT_BYTES = 64 * 1024
SCRIPT_AD = re.compile(r'^[a-z0-9_-]{1,40}\.lua$')
LUA_RUN = os.environ.get('SIMUMAV_LUA_RUN', '0') == '1'
DECAL_BYTES = 1024 * 1024
DECAL_PX = 1024
DECAL_DIR = 'decals'
_MAGIC = (b'\x89PNG\r\n\x1a\n', b'\xff\xd8\xff', b'RIFF')
_DTOKEN = re.compile(r'^[A-Za-z0-9_-]{43}$')


class ScriptIn(BaseModel):
    name: str = Field(..., max_length=44)
    content: str = Field(..., max_length=SCRIPT_BYTES)
    enabled: bool = True


class ScriptPatch(BaseModel):
    content: Optional[str] = Field(None, max_length=SCRIPT_BYTES)
    enabled: Optional[bool] = None


class DecalIn(BaseModel):
    image: str = Field(..., max_length=int(DECAL_BYTES * 1.4) + 64)   # data:image/png|jpeg|webp;base64,…
    kind: str = Field('sticker', max_length=8)


@router.get('/equipment')
def equipment_catalog(user=User):
    """Kamera türleri, eklentiler (seçenek sınırları + SITL parametre karşılığı), görünüm desenleri, çıkartma yuvaları, script/görsel sınırları."""
    return {**equipment.katalog(), 'scripts': {'max': SCRIPT_MAX, 'max_bytes': SCRIPT_BYTES, 'name': SCRIPT_AD.pattern, 'run_on_server': LUA_RUN},
            'decals': {'max': equipment.DECAL_MAX, 'max_bytes': DECAL_BYTES, 'max_px': DECAL_PX, 'types': ['image/png', 'image/jpeg', 'image/webp']}}


# ---------------------------------------------------------------- Lua script'leri
def _script_dogrula(name, content):
    if name is not None and not SCRIPT_AD.match(name):
        raise auth.hata(422, 'invalid', 'Script adı küçük harf/rakam/_/- ve .lua uzantılı (≤ 40 karakter) olmalı')
    if content is None:
        return None
    b = content.encode('utf-8')
    if len(b) > SCRIPT_BYTES:
        raise auth.hata(413, 'too_large', f'Script en çok {SCRIPT_BYTES // 1024} KB')
    if '\x00' in content:
        raise auth.hata(422, 'invalid', 'Script metin olmalı')
    return b


def _script_api(r, icerik=False):
    out = {k: r[k] for k in ('id', 'drone_id', 'name', 'size', 'sha256', 'created_at', 'updated_at')}
    out['enabled'] = bool(r['enabled'])
    out['run_on_server'] = LUA_RUN and bool(r['enabled'])
    if icerik:
        out['content'] = r['content']
    return out


def _script(conn, did, sid, user):
    sahip(conn, 'drones', did, user)
    r = db.row(conn.execute('SELECT * FROM drone_scripts WHERE id = ? AND drone_id = ?', (int(sid), int(did))))
    if not r:
        raise auth.hata(404, 'not_found', 'Script bulunamadı')
    return r


@router.get('/{did}/scripts')
def scripts_list(did: int, user=User):
    with db.connect() as conn:
        sahip(conn, 'drones', did, user)
        rs = db.rows(conn.execute('SELECT * FROM drone_scripts WHERE drone_id = ? ORDER BY name', (did,)))
    return {'scripts': [_script_api(r) for r in rs], 'max': SCRIPT_MAX, 'run_on_server': LUA_RUN}


@router.post('/{did}/scripts', status_code=201)
def scripts_add(did: int, body: ScriptIn, request: Request, user=User):
    b = _script_dogrula(body.name, body.content)
    t = db.now()
    with db.connect() as conn:
        sahip(conn, 'drones', did, user)
        if conn.execute('SELECT COUNT(*) FROM drone_scripts WHERE drone_id = ?', (did,)).fetchone()[0] >= SCRIPT_MAX:
            raise auth.hata(409, 'quota', f'Dron başına en çok {SCRIPT_MAX} script')
        if db.row(conn.execute('SELECT 1 FROM drone_scripts WHERE drone_id = ? AND name = ?', (did, body.name))):
            raise auth.hata(409, 'exists', 'Bu adla bir script var (güncellemek için PUT)')
        sid = conn.execute('INSERT INTO drone_scripts (drone_id, user_id, name, content, size, sha256, enabled, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)',
                           (did, user['id'], body.name, body.content, len(b), hashlib.sha256(b).hexdigest(), int(body.enabled), t, t)).lastrowid
        db.audit(conn, 'script_add', user['id'], auth.client_ip(request), f'drone {did} {body.name} {len(b)} B')
        conn.commit()
        return _script_api(db.row(conn.execute('SELECT * FROM drone_scripts WHERE id = ?', (sid,))))


@router.get('/{did}/scripts/{sid}')
def scripts_get(did: int, sid: int, user=User):
    with db.connect() as conn:
        return _script_api(_script(conn, did, sid, user), icerik=True)


@router.get('/{did}/scripts/{sid}/download')
def scripts_download(did: int, sid: int, user=User):
    with db.connect() as conn:
        r = _script(conn, did, sid, user)
    return Response(r['content'].encode('utf-8'), media_type='text/x-lua; charset=utf-8',
                    headers={'Content-Disposition': f'attachment; filename="{r["name"]}"', 'Cache-Control': 'private, no-store'})


@router.put('/{did}/scripts/{sid}')
def scripts_update(did: int, sid: int, body: ScriptPatch, user=User):
    b = _script_dogrula(None, body.content)
    with db.connect() as conn:
        r = _script(conn, did, sid, user)
        if b is not None:
            conn.execute('UPDATE drone_scripts SET content = ?, size = ?, sha256 = ?, updated_at = ? WHERE id = ?',
                         (body.content, len(b), hashlib.sha256(b).hexdigest(), db.now(), r['id']))
        if body.enabled is not None:
            conn.execute('UPDATE drone_scripts SET enabled = ?, updated_at = ? WHERE id = ?', (int(body.enabled), db.now(), r['id']))
        conn.commit()
        return _script_api(db.row(conn.execute('SELECT * FROM drone_scripts WHERE id = ?', (r['id'],))))


@router.delete('/{did}/scripts/{sid}')
def scripts_delete(did: int, sid: int, user=User):
    with db.connect() as conn:
        r = _script(conn, did, sid, user)
        conn.execute('DELETE FROM drone_scripts WHERE id = ?', (r['id'],))
        conn.commit()
    return {'ok': True, 'deleted': r['id']}


# ---------------------------------------------------------------- logo / çıkartma görselleri
def dosya_sil(rel):
    try:
        kok = (config.DATA_DIR / 'files' / DECAL_DIR).resolve()
        p = (config.DATA_DIR / rel).resolve()
        if str(p).startswith(str(kok) + os.sep):
            p.unlink(missing_ok=True)
    except OSError:
        pass


def _decal_api(r):
    return {'id': r['id'], 'drone_id': r['drone_id'], 'kind': r['kind'], 'width': r['width'], 'height': r['height'], 'size': r['size'],
            'url': f"/api/hangar/decals/{r['token']}.png", 'created_at': r['created_at']}


def gorsel_coz(veri):
    """data URL → yeniden kodlanmış PNG (RGBA; en uzun kenar ≤ DECAL_PX). Hatalı → 413 / 422."""
    m = re.match(r'^data:image/(png|jpeg|jpg|webp);base64,', veri or '')
    if not m:
        raise auth.hata(422, 'invalid', 'image data:image/png|jpeg|webp;base64,… olmalı')
    try:
        ham = base64.b64decode(veri[m.end():], validate=True)
    except (ValueError, TypeError):
        raise auth.hata(422, 'invalid', 'base64 çözülemedi')
    if len(ham) > DECAL_BYTES:
        raise auth.hata(413, 'too_large', f'Görsel en çok {DECAL_BYTES // 1024} KB')
    if not ham.startswith(_MAGIC) or (ham.startswith(b'RIFF') and ham[8:12] != b'WEBP'):
        raise auth.hata(422, 'invalid', 'Yalnız PNG / JPEG / WebP')
    from PIL import Image
    try:
        im = Image.open(io.BytesIO(ham))
        if im.format not in ('PNG', 'JPEG', 'WEBP') or im.width * im.height > 4096 * 4096:
            raise ValueError('biçim')
        im.load()
        im = im.convert('RGBA')
        im.thumbnail((DECAL_PX, DECAL_PX))
        out = io.BytesIO()
        im.save(out, 'PNG', optimize=True)
    except Exception:   # noqa: BLE001 — bozuk / sıkıştırma bombası
        raise auth.hata(422, 'invalid', 'Görsel çözümlenemedi')
    return out.getvalue(), im.width, im.height


@router.get('/{did}/decals')
def decals_list(did: int, user=User):
    with db.connect() as conn:
        sahip(conn, 'drones', did, user)
        rs = db.rows(conn.execute('SELECT * FROM drone_decals WHERE drone_id = ? ORDER BY id', (did,)))
    return {'decals': [_decal_api(r) for r in rs], 'max': equipment.DECAL_MAX}


@router.post('/{did}/decals', status_code=201)
def decals_add(did: int, body: DecalIn, request: Request, user=User):
    if body.kind not in ('logo', 'sticker'):
        raise auth.hata(422, 'invalid', 'kind logo | sticker')
    auth.oran('decal', 20, 3600, user_id=user['id'])
    with db.connect() as conn:
        sahip(conn, 'drones', did, user)
        if conn.execute('SELECT COUNT(*) FROM drone_decals WHERE drone_id = ?', (did,)).fetchone()[0] >= equipment.DECAL_MAX:
            raise auth.hata(409, 'quota', f'Dron başına en çok {equipment.DECAL_MAX} görsel')
    png, w, h = gorsel_coz(body.image)
    tok = secrets.token_urlsafe(32)
    rel = f"files/{DECAL_DIR}/{user['id']}/{tok}.png"
    p = config.DATA_DIR / rel
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_bytes(png)
    with db.connect() as conn:
        iid = conn.execute('INSERT INTO drone_decals (drone_id, user_id, token, kind, width, height, size, path, created_at) VALUES (?,?,?,?,?,?,?,?,?)',
                           (did, user['id'], tok, body.kind, w, h, len(png), rel, db.now())).lastrowid
        db.audit(conn, 'decal_add', user['id'], auth.client_ip(request), f'drone {did} {w}x{h} {len(png)} B')
        conn.commit()
        return _decal_api(db.row(conn.execute('SELECT * FROM drone_decals WHERE id = ?', (iid,))))


@router.delete('/{did}/decals/{iid}')
def decals_delete(did: int, iid: int, user=User):
    with db.connect() as conn:
        d = sahip(conn, 'drones', did, user)
        r = db.row(conn.execute('SELECT * FROM drone_decals WHERE id = ? AND drone_id = ?', (int(iid), int(did))))
        if not r:
            raise auth.hata(404, 'not_found', 'Görsel bulunamadı')
        conn.execute('DELETE FROM drone_decals WHERE id = ?', (r['id'],))
        eq = equipment.oku(d.get('equipment'))
        if any(x.get('id') == r['id'] for x in eq['livery']['decals']):   # görünümden de düşer
            eq['livery']['decals'] = [x for x in eq['livery']['decals'] if x.get('id') != r['id']]
            conn.execute('UPDATE drones SET equipment = ?, updated_at = ? WHERE id = ?', (json.dumps(eq), db.now(), did))
        conn.commit()
    dosya_sil(r['path'])
    return {'ok': True, 'deleted': r['id']}


@router.get('/decals/{name}')
def decal_file(name: str):
    """Çıkartma görseli (oturumsuz) — yalnız yeniden kodlanmış PNG, nosniff + sandbox CSP."""
    tok = name[:-4] if name.endswith('.png') else ''
    if not _DTOKEN.match(tok):
        raise auth.hata(404, 'not_found', 'Bulunamadı')
    with db.connect() as conn:
        r = db.row(conn.execute('SELECT path FROM drone_decals WHERE token = ?', (tok,)))
    p = (config.DATA_DIR / r['path']) if r else None
    if not p or not p.is_file():
        raise auth.hata(404, 'not_found', 'Bulunamadı')
    return FileResponse(p, media_type='image/png', headers={'Cache-Control': 'public, max-age=86400', 'X-Content-Type-Options': 'nosniff',
                                                             'Content-Security-Policy': "default-src 'none'; sandbox"})
