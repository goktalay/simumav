"""`/api/crew` — pilotlar (≤ 20) ve 10 karakter (p01 pilot şapkalı erkek; en az 4 kadın). SVG'ler static/simumav/app/img/pilots/<key>.svg
(tek doğruluk kaynağı: `common.PILOT_SVG`; /app/img/pilots/<key>.svg).
§25: pilotun 3B avatarı `avatar` (avatar.py doğrular; verilmezse karakterin 3B karşılığı). `GET /api/crew/avatar-options` seçenek listeleri."""
import json
from typing import List, Optional

from fastapi import APIRouter, Request
from pydantic import BaseModel, Field

from .. import auth, avatar, bridge, config, db, modes, xp
from .common import PILOT_SVG, User, flight_api, kota, pilot_api, sahip

router = APIRouter(prefix='/api/crew')
CHARACTERS = [
    {'key': 'p01', 'label': 'Pilot (şapkalı)', 'gender': 'm'}, {'key': 'p02', 'label': 'Teknisyen', 'gender': 'f'},
    {'key': 'p03', 'label': 'Yarışçı', 'gender': 'm'}, {'key': 'p04', 'label': 'Mühendis', 'gender': 'f'},
    {'key': 'p05', 'label': 'Kaptan', 'gender': 'm'}, {'key': 'p06', 'label': 'FPV ustası', 'gender': 'f'},
    {'key': 'p07', 'label': 'Ziraat pilotu', 'gender': 'm'}, {'key': 'p08', 'label': 'Harita uzmanı', 'gender': 'f'},
    {'key': 'p09', 'label': 'Kurtarma pilotu', 'gender': 'm'}, {'key': 'p10', 'label': 'Eğitmen', 'gender': 'f'},
]
KEYS = {c['key'] for c in CHARACTERS}


class PilotIn(BaseModel):
    name: str = Field(..., min_length=1, max_length=40)
    character: str = Field('p01', max_length=4)
    avatar: Optional[dict] = None


class PilotPatch(BaseModel):
    name: Optional[str] = Field(None, min_length=1, max_length=40)
    character: Optional[str] = Field(None, max_length=4)
    is_default: Optional[bool] = None
    avatar: Optional[dict] = None


def _avatar_json(a, character):
    if a is not None and len(json.dumps(a)) > avatar.MAX_JSON:
        raise auth.hata(422, 'invalid', 'avatar çok büyük')
    try:
        return avatar.dump(avatar.normalize(a, character, strict=True))
    except avatar.AvatarHata as e:
        raise auth.hata(422, 'invalid', str(e))


@router.get('/avatar-options')
def avatar_options(user=User):
    return {'skins': avatar.SKINS, 'patches': list(avatar.PATCHES), 'accessories': list(avatar.ACCESSORIES), 'default': avatar.DEFAULT,
            'enums': {k: list(v) for k, v in avatar.ENUMS.items()},   # §28 karakter yaratma seçenekleri
            'legacy': {k: avatar.legacy(k) for k in avatar.LEGACY}}


@router.get('/characters')
def characters(user=User):
    return {'characters': [{**c, 'svg': PILOT_SVG.format(key=c['key'])} for c in CHARACTERS]}


class XpEntry(BaseModel):
    xp: int = Field(..., ge=0, le=xp.IMPORT_MAX_ENTRY)
    at: Optional[str] = Field(None, max_length=32)
    mode: Optional[str] = Field(None, max_length=20)
    duration_s: Optional[int] = Field(None, ge=0, le=36000)


class XpImportIn(BaseModel):
    entries: List[XpEntry] = Field(..., min_length=1, max_length=xp.IMPORT_MAX_ENTRIES)


@router.get('/levels')
def levels(user=User):
    """Seviye eğrisi (1…100 için gereken toplam XP), madalya eşikleri, XP kaynakları ve sınırlar."""
    return xp.kurallar()


@router.get('')
def list_pilots(user=User):
    with db.connect() as conn:
        xp.esitle(conn, user['id'])
        conn.commit()
        return {'pilots': [pilot_api(p) for p in db.rows(conn.execute('SELECT * FROM pilots WHERE user_id = ? ORDER BY is_default DESC, id', (user['id'],)))],
                'quota': config.QUOTA['pilots']}


@router.post('', status_code=201)
def add_pilot(body: PilotIn, request: Request, user=User):
    if body.character not in KEYS:
        raise auth.hata(422, 'invalid', 'character p01…p10 olmalı')
    t = db.now()
    with db.connect() as conn:
        kota(conn, 'pilots', user, request)
        pid = conn.execute('INSERT INTO pilots (user_id, name, character, avatar, created_at, updated_at) VALUES (?,?,?,?,?,?)',
                           (user['id'], body.name.strip(), body.character, _avatar_json(body.avatar, body.character), t, t)).lastrowid
        conn.commit()
        return pilot_api(sahip(conn, 'pilots', pid, user))


@router.put('/{pid}')
def update_pilot(pid: int, body: PilotPatch, user=User):
    if body.character is not None and body.character not in KEYS:
        raise auth.hata(422, 'invalid', 'character p01…p10 olmalı')
    with db.connect() as conn:
        p = sahip(conn, 'pilots', pid, user)
        if body.is_default:
            conn.execute('UPDATE pilots SET is_default = 0 WHERE user_id = ?', (user['id'],))
        ch = body.character or p['character']
        av = _avatar_json({**avatar.normalize(p.get('avatar'), ch), **body.avatar}, ch) if body.avatar is not None else p.get('avatar')
        conn.execute('UPDATE pilots SET name = ?, character = ?, is_default = ?, avatar = ?, updated_at = ? WHERE id = ?',
                     ((body.name or p['name']).strip(), ch,
                      1 if body.is_default else (0 if body.is_default is False else p['is_default']), av, db.now(), pid))
        conn.commit()
        return pilot_api(sahip(conn, 'pilots', pid, user))


@router.delete('/{pid}')
def delete_pilot(pid: int, user=User):
    fid, _ = bridge.aktif_ucus(user['id'])
    with db.connect() as conn:
        sahip(conn, 'pilots', pid, user)
        if conn.execute('SELECT COUNT(*) FROM pilots WHERE user_id = ?', (user['id'],)).fetchone()[0] <= 1:
            raise auth.hata(409, 'last_pilot', 'En az bir pilot kalmalı')
        if fid is not None and db.row(conn.execute('SELECT 1 FROM flights WHERE id = ? AND pilot_id = ?', (fid, pid))):
            raise auth.hata(409, 'in_use', 'Bu pilot şu an uçuşta')
        conn.execute('DELETE FROM pilots WHERE id = ?', (pid,))
        conn.commit()
    return {'ok': True, 'deleted': pid}


@router.get('/{pid}/level')
def pilot_level(pid: int, user=User):
    """Pilotun seviyesi, madalyaları (kazanıldı / doğrulanmış XP ile mi) ve son 20 XP kaydı."""
    with db.connect() as conn:
        sahip(conn, 'pilots', pid, user)
        xp.esitle(conn, user['id'])
        conn.commit()
        p = sahip(conn, 'pilots', pid, user)
        ev = db.rows(conn.execute('SELECT source, ref_id, xp, verified, detail, created_at FROM xp_events WHERE pilot_id = ? ORDER BY id DESC LIMIT 20', (pid,)))
    return {'pilot_id': pid, **xp.bilgi(p['xp'], p['xp_unverified']),
            'events': [{**{k: e[k] for k in ('source', 'xp', 'created_at')}, 'ref_id': e['ref_id'] if e['ref_id'] > 0 else None, 'verified': bool(e['verified']),
                        'parts': db.j(e['detail']).get('parts', {}), 'mode': db.j(e['detail']).get('mode'), 'capped': db.j(e['detail']).get('capped', False)} for e in ev]}


@router.get('/{pid}/flights')
def pilot_flights(pid: int, limit: int = 30, offset: int = 0, mode: Optional[str] = None, user=User):
    """ÖNCEKİ UÇUŞLARIM: pilot bazında uçuş geçmişi (Operasyon kartı biçimi + kazanılan XP + tür)."""
    limit, offset = max(1, min(100, limit)), max(0, offset)
    if mode is not None and mode not in modes.MODES and mode != 'fpv':
        raise auth.hata(422, 'invalid', 'mode geçersiz')
    with db.connect() as conn:
        sahip(conn, 'pilots', pid, user)
        xp.esitle(conn, user['id'])
        conn.commit()
        w, a = 'user_id = ? AND pilot_id = ?', [user['id'], pid]
        rows = db.rows(conn.execute(f'SELECT * FROM flights WHERE {w} ORDER BY started_at DESC LIMIT 500', a))
        if mode:
            rows = [f for f in rows if xp.ucus_modu(f) == mode]
        total = len(rows)
        rows = rows[offset:offset + limit]
        xm = xp.ucus_xp_haritasi(conn, [f['id'] for f in rows])
        st = conn.execute('SELECT COUNT(*), COALESCE(SUM(duration_s), 0), SUM(CASE WHEN result = "crash" THEN 1 ELSE 0 END) FROM flights WHERE user_id = ? AND pilot_id = ? '
                          'AND ended_at IS NOT NULL', (user['id'], pid)).fetchone()
    return {'pilot_id': pid, 'flights': [{**flight_api(f, kisa=True), 'mode': xp.ucus_modu(f), 'xp': xm.get(f['id'])} for f in rows], 'total': total,
            'stats': {'flights': st[0], 'flight_s': int(st[1] or 0), 'crashes': int(st[2] or 0)}}


@router.post('/{pid}/xp/import')
def pilot_xp_import(pid: int, body: XpImportIn, request: Request, user=User):
    """Misafir / yerel uçuş XP aktarımı (istemci tutar) — doğrulanmamış olarak ayrı işaretlenir; toplam ≤ IMPORT_CAP (seviye 10)."""
    auth.oran('xp_import', 5, 3600, user_id=user['id'])
    with db.connect() as conn:
        sahip(conn, 'pilots', pid, user)
        out = xp.ice_aktar(conn, user['id'], pid, [e.model_dump() for e in body.entries])
        db.audit(conn, 'xp_import', user['id'], auth.client_ip(request), f"pilot {pid} · {out['imported']} XP")
        conn.commit()
        p = sahip(conn, 'pilots', pid, user)
    return {**out, **xp.bilgi(p['xp'], p['xp_unverified'])}
