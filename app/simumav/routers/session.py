"""`/api/session` — hesap servisi belirteci → SIMUMAV oturumu (§1, §4). Dev: SIMUMAV_DEV_LOGIN=1 iken {dev_user}."""
import re
from typing import Optional

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from .. import auth, bridge, config, db
from .common import User

router = APIRouter(prefix='/api/session')
_DEV_AD = re.compile(r'^[a-z0-9_.-]{2,32}$')


class SessionIn(BaseModel):
    token: Optional[str] = Field(None, max_length=200)
    dev_user: Optional[str] = Field(None, max_length=32)


class LogoutIn(BaseModel):
    token: Optional[str] = Field(None, max_length=200)


def _ozet(conn, u):
    say = lambda t: conn.execute(f'SELECT COUNT(*) FROM {t} WHERE user_id = ?', (u['id'],)).fetchone()[0]   # noqa: E731
    fid, _ = bridge.aktif_ucus(u['id'])
    return {'user': db.user_public(u), 'pilots_count': say('pilots'), 'drones_count': say('drones'), 'tracks_count': say('tracks'),
            'missions_count': say('missions'), 'flights_count': say('flights'), 'active_flight': fid, 'settings': db.j(u.get('settings'))}


@router.post('')
async def login(body: SessionIn, request: Request):
    auth.oran('session', *config.RATE['session'], request=request)
    auth.csrf_denetle(request)
    ip = auth.client_ip(request)
    if body.dev_user:
        if not config.DEV_LOGIN:
            raise auth.hata(403, 'dev_disabled', 'Geliştirici girişi kapalı')
        ad = body.dev_user.strip().lower()
        if not _DEV_AD.match(ad):
            raise auth.hata(422, 'invalid', 'dev_user geçersiz')
        mt_id = -(int.from_bytes(auth.dev_imza(ad).encode()[:4], 'big') % 10 ** 8 + 1)   # negatif: hesap servisi kimlikleriyle çakışmaz
        acct = {'id': mt_id, 'email': f'{ad}@dev.simumav.local', 'name': ad, 'verified': True}
    else:
        if not body.token:
            raise auth.hata(422, 'invalid', 'token gerekir')
        acct = auth.hesap_dogrula(body.token)
        if not acct:
            db.audit_bagimsiz('login_fail', None, ip, 'geçersiz belirteç')
            raise auth.hata(401, 'bad_token', 'Belirteç geçersiz ya da süresi dolmuş; yeniden giriş yapın')
        if not acct.get('verified', True):
            db.audit_bagimsiz('login_unverified', None, ip, acct.get('email'))
            raise auth.hata(403, 'unverified', 'E-posta adresiniz doğrulanmamış; gelen kutunuzdaki bağlantıya tıklayın')
    with db.connect() as conn:
        u = db.kullanici_esle(conn, acct['id'], acct['email'], acct['name'])
        tok = auth.oturum_ac(conn, u['id'], request)
        db.audit(conn, 'login', u['id'], ip, 'dev' if body.dev_user else 'mt')
        out = _ozet(conn, u)
        conn.commit()
    resp = JSONResponse(out)
    auth.cerez_yaz(resp, tok)
    return resp


@router.get('')
def me(request: Request, user=User):
    with db.connect() as conn:
        return _ozet(conn, user)


@router.delete('')
def logout(request: Request, body: Optional[LogoutIn] = None, user=User):
    with db.connect() as conn:
        auth.oturum_kapat(conn, request.cookies.get(auth.COOKIE))
        db.audit(conn, 'logout', user['id'], auth.client_ip(request))
        conn.commit()
    if body and body.token and not config.DEV_LOGIN:
        auth.hesap_cikis(body.token)   # hesap servisi oturumu da kapanır (çıkış ikisini de kapatır)
    resp = JSONResponse({'ok': True})
    auth.cerez_sil(resp)
    return resp
