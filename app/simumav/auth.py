"""SIMUMAV kimlik katmanı (docs/simumav.md §1 "SIMUMAV oturumu", §7 "Kimlik", "Oran sınırlama").

- Hesap servisi istemcisi: tarayıcının mastertool.download girişinden aldığı Bearer belirteci SUNUCU-SUNUCU (iç adres SIMUMAV_MT_INTERNAL)
  `GET /api/<app>/me` ile doğrulanır; yanıtta `verified` yoksa / false ise oyun reddedilir (e-posta doğrulanmamış hesap giremez).
- Oturum çerezi `smsid`: 32 bayt rastgele, DB'de sha256; HttpOnly, Secure (PROD), SameSite=Lax, 30 gün + boşta 7 gün.
- CSRF: durum değiştiren her istekte `Origin` (ya da yoksa `Sec-Fetch-Site: same-origin`) denetimi; izinli kökenler config.ALLOWED_ORIGINS.
- Oran sınırlayıcı: bellek içi kayan pencere (IP ya da kullanıcı anahtarı); aşımda 429 + denetim kaydı.
- Hata biçimi (§4): HTTPException(detail={'error': kod, 'message': metin}).
"""
import hashlib
import hmac
import secrets
import threading
import time
from collections import defaultdict, deque

import httpx
from fastapi import HTTPException, Request

from . import config, db

COOKIE = 'smsid'
_RATE = defaultdict(deque)
_RATE_KILIT = threading.Lock()


def hata(status, error, message):
    return HTTPException(status, {'error': error, 'message': message})


def client_ip(request):
    h = request.headers
    return (h.get('cf-connecting-ip') or (h.get('x-forwarded-for') or '').split(',')[0].strip() or (request.client.host if request.client else ''))[:64]


def oran(key, limit, window, *, request=None, user_id=None, ip=None):
    """Kayan pencere: `key` kovasında `window` sn içinde `limit` aşıldıysa 429. Anahtar IP (varsayılan) ya da kullanıcı."""
    kim = f'u{user_id}' if user_id is not None else (ip or (client_ip(request) if request is not None else '-'))
    k = f'{key}:{kim}'
    t = time.time()
    with _RATE_KILIT:
        q = _RATE[k]
        while q and q[0] < t - window:
            q.popleft()
        if len(q) >= limit:
            retry = max(1, int(q[0] + window - t) + 1)
            db.audit_bagimsiz('rate', user_id, ip or (client_ip(request) if request is not None else None), f'{key} {limit}/{window}s')
            raise HTTPException(429, {'error': 'rate_limited', 'message': 'Çok fazla istek; biraz sonra tekrar deneyin', 'retry_after': retry},
                                headers={'Retry-After': str(retry)})
        q.append(t)
        if len(_RATE) > 50000:   # bellek sınırı: eski kovaları at
            for kk in [kk for kk, qq in _RATE.items() if not qq or qq[-1] < t - 600][:10000]:
                _RATE.pop(kk, None)


def oran_sifirla():
    with _RATE_KILIT:
        _RATE.clear()


def csrf_denetle(request):
    """Durum değiştiren istek: Origin izinli kökenlerden olmalı; Origin yoksa Sec-Fetch-Site same-origin kabul; ikisi de yoksa red."""
    origin = (request.headers.get('origin') or '').rstrip('/')
    if origin:
        if origin in config.ALLOWED_ORIGINS or origin == _kendi_koken(request):
            return
    else:
        sfs = request.headers.get('sec-fetch-site')
        if sfs in ('same-origin', 'none'):
            return
    db.audit_bagimsiz('csrf', None, client_ip(request), f'{request.method} {request.url.path} origin={origin or "-"}')
    raise hata(403, 'csrf', 'İstek kaynağı doğrulanamadı')


def _kendi_koken(request):
    host = (request.headers.get('x-forwarded-host') or request.headers.get('host') or '').split(',')[0].strip()
    proto = request.headers.get('x-forwarded-proto') or request.url.scheme
    return f'{proto}://{host}' if host else ''


def _hash(tok):
    return hashlib.sha256(tok.encode()).hexdigest()


# ---------------- hesap servisi ----------------
def hesap_dogrula(token):
    """Bearer belirteci hesap servisinde doğrular. Dönüş: {'id', 'email', 'name', 'verified'} | None (geçersiz). Servis hatası → HTTPException 503."""
    tok = str(token or '').strip()
    if not (20 <= len(tok) <= 200) or any(c.isspace() for c in tok):
        return None
    try:
        r = httpx.get(f'{config.MT_INTERNAL}/api/{config.MT_APP}/me', headers={'Authorization': f'Bearer {tok}'}, timeout=6.0)
    except httpx.HTTPError:
        raise hata(503, 'account_service', 'Hesap servisine ulaşılamıyor; biraz sonra tekrar deneyin')
    if r.status_code in (401, 403):
        return None
    if r.status_code != 200:
        raise hata(503, 'account_service', 'Hesap servisi hata döndürdü')
    try:
        u = (r.json() or {}).get('user') or {}
        return {'id': int(u['id']), 'email': str(u.get('email') or ''), 'name': str(u.get('name') or ''), 'verified': bool(u.get('verified', True))}
    except (ValueError, KeyError, TypeError):
        return None


def hesap_cikis(token):
    """Hesap servisindeki belirteci de kapat (çıkış ikisini de kapatır). Hata yutulur."""
    try:
        httpx.post(f'{config.MT_INTERNAL}/api/{config.MT_APP}/auth/logout', headers={'Authorization': f'Bearer {token}'}, timeout=4.0)
    except httpx.HTTPError:
        pass


def profil_yaz(mt_user_id, profile):
    """Hesap servisindeki sv_profiles özeti (pilot adı, toplam uçuş/saat) — yalnız paylaşılan gizli ile, arka planda; hata yutulur."""
    if not config.MT_SHARED_SECRET:
        return False
    try:
        r = httpx.put(f'{config.MT_INTERNAL}/api/{config.MT_APP}/profile', json={'user_id': int(mt_user_id), 'profile': profile},
                      headers={'X-Simumav-Secret': config.MT_SHARED_SECRET}, timeout=4.0)
        return r.status_code == 200
    except httpx.HTTPError:
        return False


# ---------------- oturum ----------------
def oturum_ac(conn, user_id, request):
    tok = secrets.token_urlsafe(32)
    t = time.time()
    conn.execute('INSERT INTO sessions (user_id, token_hash, created_at, last_seen, ip, ua) VALUES (?,?,?,?,?,?)',
                 (user_id, _hash(tok), t, t, client_ip(request), (request.headers.get('user-agent') or '')[:200]))
    db.oturum_temizle(conn)
    return tok


def oturum_kapat(conn, tok):
    if tok:
        conn.execute('DELETE FROM sessions WHERE token_hash = ?', (_hash(tok),))


def cerez_yaz(resp, tok):
    resp.set_cookie(COOKIE, tok, max_age=config.SESSION_DAYS * 86400, httponly=True, secure=config.SECURE_COOKIE, samesite='lax', path='/')


def cerez_sil(resp):
    resp.delete_cookie(COOKIE, path='/')


def kullanici_cozumle(conn, tok, dokun=True):
    """Çerez değeri → users satırı (dict) | None. Süre (30 gün) ve boşta (7 gün) denetimi; `dokun` last_seen günceller."""
    if not tok or len(tok) > 100:
        return None
    s = db.row(conn.execute('SELECT * FROM sessions WHERE token_hash = ?', (_hash(tok),)))
    if not s:
        return None
    t = time.time()
    if t - s['created_at'] > config.SESSION_DAYS * 86400 or t - s['last_seen'] > config.SESSION_IDLE_DAYS * 86400:
        conn.execute('DELETE FROM sessions WHERE id = ?', (s['id'],))
        return None
    u = db.row(conn.execute('SELECT * FROM users WHERE id = ?', (s['user_id'],)))
    if not u:
        return None
    if dokun and t - s['last_seen'] > 60:
        conn.execute('UPDATE sessions SET last_seen = ? WHERE id = ?', (t, s['id']))
    u['session_id'] = s['id']
    return u


def kullanici_ws(tok):
    """WebSocket açılışı: çerezden kullanıcı (ayrı bağlantı; iş parçacığında çağrılır)."""
    with db.connect() as conn:
        u = kullanici_cozumle(conn, tok)
        conn.commit()
        return u


async def require_user(request: Request):
    """Oturum zorunlu uçlar: çerez → kullanıcı; yoksa 401. Yazma yöntemlerinde CSRF + yazma oran sınırı; okumada okuma sınırı."""
    tok = request.cookies.get(COOKIE)
    with db.connect() as conn:
        u = kullanici_cozumle(conn, tok)
        conn.commit()
    if not u:
        raise hata(401, 'unauthorized', 'Oturum açın')
    if request.method in ('POST', 'PUT', 'PATCH', 'DELETE'):
        csrf_denetle(request)
        oran('write', *config.RATE['write'], user_id=u['id'], ip=client_ip(request))
    else:
        oran('read', *config.RATE['read'], user_id=u['id'], ip=client_ip(request))
    request.state.user = u
    return u


def dev_imza(name):
    return hmac.new(config.SECRET.encode(), name.encode(), hashlib.sha256).hexdigest()[:16]
