"""`/api/support` — "Sorun bildir" (docs/simumav.md §9). Talep SIMUMAV'da TUTULMAZ: hesap servisinin Master Tool destek köprüsü
(`/api/sv/tickets*`, X-Simumav-Secret + user_id — `profil_yaz` kalıbı) üzerinden HEPGO Merkez'in talep ekranına `app='sv'` (etiket SIMUMAV)
ile düşer; liste/ayrıntı/yanıt her açılışta oradan çekilir (webhook yok). Yalnız ekler (ekran görüntüsü PNG/JPG ≤ 3 MB) burada
`SIMUMAV_DATA_DIR/files/support/<uid>/` altında saklanır; Merkez gövdesine `PUBLIC_URL/api/support/att/<token>` bağlantısı yazılır
(32 bayt rastgele token, oturumsuz indirme — Merkez personeli tıklar). Oran: talep 5/sa/kullanıcı, yanıt 30/sa; denetim `support_*`."""
import base64
import re
import secrets
from typing import Optional

import httpx
from fastapi import APIRouter, Request
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

from .. import auth, config, db
from .common import User

router = APIRouter(prefix='/api/support')
# SIMUMAV kategorisi → (Merkez kategorisi, Türkçe etiket — başlık öneki ve bağlam bloğunda; Merkez ekibi Türkçe okur)
CATEGORIES = {'flight': ('teknik', 'Uçuş / Simülasyon'), 'account': ('teknik', 'Hesap / Giriş'), 'hangar': ('teknik', 'Hangar / Modeller'),
              'track': ('teknik', 'Parkur / Görev'), 'mp': ('teknik', 'Mission Planner bağlantısı'), 'perf': ('teknik', 'Performans / Görüntü'),
              'other': ('diger', 'Diğer')}
_TOKEN = re.compile(r'^[A-Za-z0-9_-]{40,48}$')
_MAGIC = {b'\x89PNG\r\n\x1a\n': ('image/png', 'png'), b'\xff\xd8\xff': ('image/jpeg', 'jpg')}
_NAME_RE = re.compile(r'[^\w.\- ]+', re.U)


class Context(BaseModel):
    ua: Optional[str] = Field(None, max_length=300)
    lang: Optional[str] = Field(None, max_length=12)
    screen: Optional[str] = Field(None, max_length=60)
    gl: Optional[str] = Field(None, max_length=200)
    flight_id: Optional[int] = Field(None, ge=1)
    route: Optional[str] = Field(None, max_length=80)


class TicketIn(BaseModel):
    category: str = Field(..., max_length=16)
    subject: str = Field(..., min_length=1, max_length=120)
    body: str = Field(..., min_length=1, max_length=4000)
    screenshot: Optional[str] = Field(None, max_length=6 * 1024 * 1024)   # data:image/png;base64,… (≤ 3 MB ham; base64 ~4 MB)
    attach_name: Optional[str] = Field(None, max_length=120)
    include_context: bool = True
    context: Optional[Context] = None


class ReplyIn(BaseModel):
    body: str = Field(..., min_length=1, max_length=4000)


# ---------------- hesap servisi köprüsü ----------------
def _mt(method, path, user, *, json=None, params=None):
    """Hesap servisi `/api/<sv>/tickets…` — SIMUMAV sunucusu kullanıcı adına (X-Simumav-Secret + user_id). Hata → 503 `support_unavailable`
    (iç adres/ayrıntı sızmaz); hesap servisinin 4xx mesajı (kısa, adres içermeyen) kullanıcıya aynen geçer."""
    if not config.MT_SHARED_SECRET or (user['mt_user_id'] < 0 and not config.DEV_LOGIN):   # dev kullanıcı (negatif kimlik) yalnız dev girişi açıkken (sahte servis)
        raise auth.hata(503, 'support_unavailable', 'Destek sistemi bu ortamda kullanılamıyor')
    try:
        r = httpx.request(method, f'{config.MT_INTERNAL}/api/{config.MT_APP}{path}', json=json, params={**(params or {}), 'user_id': user['mt_user_id']},
                          headers={'X-Simumav-Secret': config.MT_SHARED_SECRET}, timeout=20.0)
    except httpx.HTTPError:
        raise auth.hata(503, 'support_unavailable', 'Destek sistemine şu an ulaşılamıyor; biraz sonra tekrar deneyin')
    if r.status_code >= 400:
        try:
            d = r.json()
        except ValueError:
            d = {}
        msg = d.get('message') if isinstance(d, dict) else None
        if r.status_code >= 500 or not isinstance(msg, str) or len(msg) > 200 or '://' in msg:
            raise auth.hata(503, 'support_unavailable', 'Destek sistemine şu an ulaşılamıyor; biraz sonra tekrar deneyin')
        raise auth.hata(404 if r.status_code == 404 else 400, 'support_error', msg)
    try:
        return r.json()
    except ValueError:
        raise auth.hata(503, 'support_unavailable', 'Destek sistemi geçersiz yanıt verdi')


def _ek_coz(data_url):
    """data:image/*;base64,… → (ham, mime, uzantı); PNG/JPEG imzası zorunlu; 3 MB üstü 413."""
    s = str(data_url or '')
    m = re.match(r'^data:(image/(?:png|jpeg|jpg));base64,([A-Za-z0-9+/=\s]+)$', s)
    if not m:
        raise auth.hata(422, 'invalid', 'Ek yalnız PNG ya da JPG görüntü olabilir')
    try:
        raw = base64.b64decode(m.group(2), validate=False)
    except ValueError:
        raise auth.hata(422, 'invalid', 'Ek verisi okunamadı')
    if len(raw) > config.SUPPORT_MAX_BYTES:
        raise auth.hata(413, 'too_large', f'Ek en fazla {config.SUPPORT_MAX_BYTES // (1024 * 1024)} MB olabilir')
    for sig, (mime, ext) in _MAGIC.items():
        if raw.startswith(sig):
            return raw, mime, ext
    raise auth.hata(422, 'invalid', 'Ek PNG ya da JPG değil')


def _ek_kaydet(conn, user, raw, mime, ext, name):
    tok = secrets.token_urlsafe(32)
    rel = f'files/support/{user["id"]}/{tok}.{ext}'
    p = config.DATA_DIR / rel
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_bytes(raw)
    ad = (_NAME_RE.sub('_', str(name or '')).strip() or f'ekran.{ext}')[:120]
    conn.execute('INSERT INTO support_files (user_id, token, name, mime, size, path, created_at) VALUES (?,?,?,?,?,?,?)',
                 (user['id'], tok, ad, mime, len(raw), rel, db.now()))
    return {'token': tok, 'name': ad, 'mime': mime, 'size': len(raw), 'path': p, 'url': f'{config.PUBLIC_URL}/api/support/att/{tok}'}


def _ucus_satiri(conn, user, fid):
    f = db.row(conn.execute('SELECT id, started_at, ended_at, duration_s, result, launch, snapshot FROM flights WHERE id = ? AND user_id = ?', (fid, user['id'])))
    if not f:
        return None
    snap = db.j(f.get('snapshot'))
    parca = [f'#{f["id"]}', f'başlangıç {f["started_at"]}', f'sonuç {f.get("result") or "sürüyor"}']
    if f.get('duration_s') is not None:
        parca.append(f'{f["duration_s"]} sn')
    for k, lbl in (('drone', 'dron'), ('track', 'parkur'), ('pilot', 'pilot'), ('mission', 'görev')):
        ad = (snap.get(k) or {}).get('name')
        if ad:
            parca.append(f'{lbl} {ad}')
    return ' · '.join(parca)


def baglam_metni(conn, user, body: TicketIn, ek=None):
    """Merkez gövdesine eklenen bağlam bloğu (sunucu üretir; istemci yalnız ham değerleri gönderir). include_context kapalıysa yalnız sürüm/kategori/ek."""
    cat = CATEGORIES[body.category][1]
    sat = ['', '--- SIMUMAV bağlamı ---', f'Kategori: {cat}', f'Sürüm: {config.VERSION}', f'Hesap: #{user["mt_user_id"]} · {user["email"]}']
    c = body.context
    if body.include_context and c:
        if c.flight_id:
            u = _ucus_satiri(conn, user, c.flight_id)
            sat.append(f'Uçuş: {u}' if u else f'Uçuş: #{c.flight_id} (kullanıcıya ait kayıt bulunamadı)')
        if c.ua:
            sat.append(f'Tarayıcı: {c.ua.strip()}')
        if c.lang or c.screen:
            sat.append(f'Dil/ekran: {c.lang or "-"} · {c.screen or "-"}')
        if c.gl:
            sat.append(f'GPU: {c.gl.strip()}')
        if c.route:
            sat.append(f'Ekran: {c.route.strip()}')
    if ek:
        sat.append(f'Ek: {ek["name"]} ({ek["size"] // 1024} KB) {ek["url"]}')
    return '\n'.join(sat)


def _ekler(conn, user, tid):
    return [{'name': r['name'], 'mime': r['mime'], 'size': r['size'], 'url': f'/api/support/att/{r["token"]}', 'created_at': r['created_at']}
            for r in db.rows(conn.execute('SELECT token, name, mime, size, created_at FROM support_files WHERE user_id = ? AND ticket_id = ? ORDER BY id',
                                          (user['id'], int(tid))))]


def _liste_ogesi(t):
    return {k: t.get(k) for k in ('id', 'code', 'subject', 'status', 'category', 'unread', 'created_at', 'updated_at')}


# ---------------- uçlar ----------------
@router.get('')
def liste(request: Request, user=User):
    """Taleplerim — hesap servisinden (Merkez) çekilir; yalnız SIMUMAV (`app == 'sv'`) kayıtları."""
    rows = _mt('GET', '/tickets', user)
    out = [_liste_ogesi(t) for t in (rows if isinstance(rows, list) else []) if isinstance(t, dict) and t.get('app') == config.MT_APP]
    return {'tickets': out, 'categories': [{'key': k, 'merkez': v[0]} for k, v in CATEGORIES.items()]}


@router.post('', status_code=201)
def olustur(body: TicketIn, request: Request, user=User):
    if body.category not in CATEGORIES:
        raise auth.hata(422, 'invalid', 'Kategori geçersiz')
    ip = auth.client_ip(request)
    auth.oran('support', *config.RATE['support'], user_id=user['id'], ip=ip)
    ek_ham = _ek_coz(body.screenshot) if body.screenshot else None
    with db.connect() as conn:
        ek = _ek_kaydet(conn, user, *ek_ham, body.attach_name) if ek_ham else None
        conn.commit()
        govde = body.body.strip() + baglam_metni(conn, user, body, ek)
        konu = f'[{CATEGORIES[body.category][1]}] {body.subject.strip()}'[:200]
        try:
            r = _mt('POST', '/tickets', user, json={'app': config.MT_APP, 'subject': konu, 'body': govde[:8000], 'category': CATEGORIES[body.category][0]})
        except Exception:
            if ek:   # gönderilemeyen talebin eki kalmaz
                conn.execute('DELETE FROM support_files WHERE token = ?', (ek['token'],)); conn.commit()
                try:
                    ek['path'].unlink()
                except OSError:
                    pass
            db.audit(conn, 'support_fail', user['id'], ip, body.category); conn.commit()
            raise
        tid = int(r.get('id') or 0)
        if ek and tid:
            conn.execute('UPDATE support_files SET ticket_id = ? WHERE token = ?', (tid, ek['token']))
        db.audit(conn, 'support_create', user['id'], ip, {'ticket': tid, 'code': r.get('code'), 'category': body.category, 'attach': bool(ek)})
        conn.commit()
    return {'id': tid, 'code': r.get('code'), 'attachment': ek and {'name': ek['name'], 'size': ek['size'], 'url': f'/api/support/att/{ek["token"]}'}}


@router.get('/{tid}')
def ayrinti(tid: int, user=User):
    t = _mt('GET', f'/tickets/{int(tid)}', user)
    if not isinstance(t, dict) or t.get('app') not in (None, config.MT_APP):
        raise auth.hata(404, 'not_found', 'Talep bulunamadı')
    msgs = [{k: m.get(k) for k in ('id', 'author_kind', 'author_name', 'body', 'created_at')} for m in (t.get('messages') or []) if isinstance(m, dict)]
    with db.connect() as conn:
        ekler = _ekler(conn, user, tid)
    return {**_liste_ogesi(t), 'messages': msgs, 'files': ekler}


@router.post('/{tid}/reply')
def yanit(tid: int, body: ReplyIn, request: Request, user=User):
    ip = auth.client_ip(request)
    auth.oran('support_reply', *config.RATE['support_reply'], user_id=user['id'], ip=ip)
    t = _mt('POST', f'/tickets/{int(tid)}/messages', user, json={'body': body.body.strip()[:4000]})
    with db.connect() as conn:
        db.audit(conn, 'support_reply', user['id'], ip, {'ticket': int(tid)}); conn.commit()
        ekler = _ekler(conn, user, tid)
    msgs = [{k: m.get(k) for k in ('id', 'author_kind', 'author_name', 'body', 'created_at')} for m in (t.get('messages') or []) if isinstance(m, dict)]
    return {**_liste_ogesi(t), 'messages': msgs, 'files': ekler}


@router.get('/att/{token}')
def ek_indir(token: str):
    """Ek indirme — oturumsuz, yalnız 32 bayt rastgele token ile (Merkez personelinin bağlantısı); inline görüntü, nosniff + sandbox CSP."""
    if not _TOKEN.match(token or ''):
        raise auth.hata(404, 'not_found', 'Dosya bulunamadı')
    with db.connect() as conn:
        f = db.row(conn.execute('SELECT * FROM support_files WHERE token = ?', (token,)))
    p = (config.DATA_DIR / f['path']).resolve() if f else None
    if not f or not str(p).startswith(str(config.DATA_DIR.resolve())) or not p.is_file():
        raise auth.hata(404, 'not_found', 'Dosya bulunamadı')
    return FileResponse(p, media_type=f['mime'], filename=f['name'], content_disposition_type='inline',
                        headers={'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; sandbox", 'Cache-Control': 'private, max-age=3600'})
