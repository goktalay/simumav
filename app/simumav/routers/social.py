"""`/api/invites` (gelen davetler, e-posta bağlantısı), `/api/friends` (Arkadaşlarım), `/api/modes` (oyun türleri) — yol haritası.
Mantık: app/simumav/social.py, modes.py; kurucu tarafı `/api/match/{id}/invites` (routers/match.py)."""
from typing import Optional

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

from .. import auth, avatar, config, db, mailer, modes, social
from .common import User
from .match import davet_kabul, davet_ret, mac_canli

router = APIRouter()


class DeclineIn(BaseModel):
    block: bool = False   # "bu kişiden davet alma"


class FriendIn(BaseModel):
    user_id: Optional[int] = None
    email: Optional[str] = Field(None, max_length=254)


def _s(e):
    raise HTTPException(e.status, {'error': e.error, 'message': e.message, **e.extra})


# ---------------------------------------------------------------- davetler
@router.get('/api/invites')
def inbox(user=User):
    """Oyun içi bildirim: bana gelen bekleyen davetler (e-postayla eşleşen dahil)."""
    with db.connect() as conn:
        out = social.gelen_kutusu(conn, user, mac_canli)
        conn.commit()
    return {'invites': out, 'count': len(out)}


def _benim(conn, iid, user):
    r = db.row(conn.execute('SELECT * FROM match_invites WHERE id = ?', (int(iid),)))
    if not r or not social.alici_mi(r, user) or r['mail'] == 'blocked':
        raise auth.hata(404, 'not_found', 'Davet bulunamadı')
    return r


@router.post('/api/invites/{iid}/accept')
async def accept(iid: int, request: Request, user=User):
    with db.connect() as conn:
        r = _benim(conn, iid, user)
    return davet_kabul(r, user, auth.client_ip(request))


@router.post('/api/invites/{iid}/decline')
async def decline(iid: int, request: Request, body: Optional[DeclineIn] = None, user=User):
    with db.connect() as conn:
        r = _benim(conn, iid, user)
    return davet_ret(r, user, bool(body and body.block), auth.client_ip(request))


def _token(conn, tok, request):
    r = social.token_ile(conn, tok)
    if not r:
        auth.oran('invite_token_fail', 30, 600, request=request)
        raise auth.hata(404, 'not_found', 'Davet bağlantısı geçersiz')
    return r


@router.get('/api/invites/t/{tok}')
def by_token(tok: str, request: Request):
    """E-posta bağlantısının ön izlemesi (OTURUMSUZ; hesabı olmayan da görür): kurucunun maskeli adı, tür, parkur, süre, alıcı ipucu."""
    auth.oran('invite_token', 60, 600, request=request)
    with db.connect() as conn:
        r = _token(conn, tok, request)
        social._durum_tazele(conn, r, mac_canli)
        m = db.row(conn.execute('SELECT m.kind, m.mode, m.settings, m.max_players, u.display_name FROM matches m JOIN users u ON u.id = m.host_id WHERE m.id = ?',
                                (r['match_id'],))) or {}
        conn.commit()
    st = db.j(m.get('settings'))
    return {'state': r['state'], 'inviter': avatar.maske_ad(m.get('display_name')), 'mode': m.get('mode') or m.get('kind'), 'kind': m.get('kind'),
            'track': (st.get('track') or {}).get('name'), 'max_players': m.get('max_players'), 'expires_at': social._iso(r['expires_ts']),
            'email_hint': avatar.maske_eposta(r['email']), 'login_url': f'{config.MT_URL}', 'register_url': f'{config.MT_URL}',
            'download_url': f'{config.PUBLIC_URL}/#download', 'requires_login': True}


@router.post('/api/invites/t/{tok}/accept')
async def accept_token(tok: str, request: Request, user=User):
    with db.connect() as conn:
        r = _token(conn, tok, request)
    return davet_kabul(r, user, auth.client_ip(request))


@router.post('/api/invites/t/{tok}/decline')
async def decline_token(tok: str, request: Request, body: Optional[DeclineIn] = None):
    """Ret oturumsuz da olur (e-postadaki bağlantı); engelleme yalnız oturumla (kimin engellediği bilinmeli)."""
    auth.csrf_denetle(request)
    auth.oran('invite_token', 60, 600, request=request)
    tk = request.cookies.get(auth.COOKIE)
    with db.connect() as conn:
        user = auth.kullanici_cozumle(conn, tk) if tk else None
        r = _token(conn, tok, request)
        conn.commit()
    if user is not None and not social.alici_mi(r, user):
        user = None
    return davet_ret(r, user, bool(body and body.block), auth.client_ip(request))


@router.get('/api/invites/blocks')
def blocks(user=User):
    with db.connect() as conn:
        rs = db.rows(conn.execute('SELECT b.blocked_id, b.created_at, u.display_name FROM invite_blocks b JOIN users u ON u.id = b.blocked_id WHERE b.user_id = ?',
                                  (user['id'],)))
    return {'blocks': [{'user_id': r['blocked_id'], 'name': avatar.maske_ad(r['display_name']), 'created_at': r['created_at']} for r in rs]}


@router.delete('/api/invites/blocks/{bid}')
def unblock(bid: int, user=User):
    with db.connect() as conn:
        conn.execute('DELETE FROM invite_blocks WHERE user_id = ? AND blocked_id = ?', (user['id'], int(bid)))
        conn.commit()
    return {'ok': True}


# ---------------------------------------------------------------- arkadaşlar
@router.get('/api/friends')
def friends(user=User):
    with db.connect() as conn:
        return {'friends': social.liste(conn, user['id'])}


@router.post('/api/friends', status_code=201)
def friend_add(body: FriendIn, request: Request, user=User):
    if body.email:
        auth.oran('friend_email', 20, 86400, user_id=user['id'])   # e-postayla arama: üyelik taramasına karşı günlük sınır
    try:
        with db.connect() as conn:
            oid = social.arkadas_ekle(conn, user['id'], body.user_id, body.email)
            conn.commit()
            out = next((f for f in social.liste(conn, user['id']) if f['user_id'] == oid), None)
    except social.SosyalHata as e:
        _s(e)
    return out


@router.delete('/api/friends/{oid}')
def friend_delete(oid: int, user=User):
    try:
        with db.connect() as conn:
            social.arkadas_sil(conn, user['id'], oid)
            conn.commit()
    except social.SosyalHata as e:
        _s(e)
    return {'ok': True, 'removed': int(oid)}


# ---------------------------------------------------------------- oyun türleri
@router.get('/api/modes')
def modes_list(lang: str = 'tr', user=User):
    return {'modes': modes.katalog(lang if lang in config.LANGS else 'tr'), 'engagement_rule': modes.ENGAGEMENT_RULE, 'mail_enabled': mailer.enabled()}


@router.get('/api/modes/{mode}/ai')
def modes_ai(mode: str, players: int = 1, waves: Optional[int] = None, user=User):
    if mode not in modes.MODES:
        raise auth.hata(404, 'not_found', 'Oyun türü bulunamadı')
    return modes.ai_onerisi(mode, max(1, min(8, players)), max(1, min(10, waves)) if waves else None)
