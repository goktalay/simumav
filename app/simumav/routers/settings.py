"""`/api/settings` — dil, tema, ses, FPV analog efekt (users.lang/theme/settings); §25 `leaderboard_hidden` (settings.lb_hidden: TOP 10 PİLOT'ta görünme);
bayram temaları `holiday_fx` (varsayılan AÇIK) + `holiday_country` ('' = otomatik) + `holiday_3d` (uçuş sahnesinde 3B süs; varsayılan AÇIK; docs/bayram-temalari.md)."""
import json
from typing import Optional

from fastapi import APIRouter
from pydantic import BaseModel, Field

from .. import auth, config, db
from . import leaderboard
from .common import User

router = APIRouter(prefix='/api/settings')
THEMES = ('dark', 'light', 'auto')


class SettingsIn(BaseModel):
    lang: Optional[str] = Field(None, max_length=5)
    theme: Optional[str] = Field(None, max_length=10)
    sound: Optional[bool] = None
    analog_fpv: Optional[bool] = None
    music: Optional[bool] = None
    volume: Optional[float] = Field(None, ge=0, le=1)
    reduced_motion: Optional[bool] = None
    units: Optional[str] = Field(None, max_length=8)
    leaderboard_hidden: Optional[bool] = None
    holiday_fx: Optional[bool] = None
    holiday_3d: Optional[bool] = None
    holiday_country: Optional[str] = Field(None, max_length=2)


def _out(u):
    s = db.j(u.get('settings'))
    # lang: yalnız kullanıcı Ayarlar'da seçtiyse (settings.lang_chosen); seçmediyse None → kabuk tarayıcı dili kuralını uygular (users.lang DEFAULT 'tr' tarayıcıyı ezmesin)
    return {'lang': u['lang'] if s.get('lang_chosen') else None, 'theme': u['theme'], 'sound': bool(s.get('sound', True)), 'analog_fpv': bool(s.get('analog_fpv', True)),
            'music': bool(s.get('music', True)), 'volume': float(s.get('volume', 0.8)), 'reduced_motion': bool(s.get('reduced_motion', False)),
            'units': s.get('units', 'metric'), 'leaderboard_hidden': bool(s.get('lb_hidden', False)),
            'holiday_fx': s.get('holiday_fx', True) is not False, 'holiday_country': s.get('holiday_country') or '',
            'holiday_3d': s.get('holiday_3d', True) is not False, 'langs': list(config.LANGS), 'themes': list(THEMES)}


@router.get('')
def get_settings(user=User):
    return _out(user)


@router.put('')
def put_settings(body: SettingsIn, user=User):
    if body.lang is not None and body.lang not in config.LANGS:
        raise auth.hata(422, 'invalid', 'Desteklenmeyen dil')
    if body.theme is not None and body.theme not in THEMES:
        raise auth.hata(422, 'invalid', 'theme dark | light | auto olmalı')
    if body.units is not None and body.units not in ('metric', 'imperial'):
        raise auth.hata(422, 'invalid', 'units metric | imperial olmalı')
    s = db.j(user.get('settings'))
    for k in ('sound', 'analog_fpv', 'music', 'volume', 'reduced_motion', 'units'):
        v = getattr(body, k)
        if v is not None:
            s[k] = v
    if body.leaderboard_hidden is not None:
        s['lb_hidden'] = bool(body.leaderboard_hidden)
        leaderboard.gecersiz()   # gizlilik: önbellekteki liste hemen düşer
    if body.holiday_fx is not None:
        s['holiday_fx'] = bool(body.holiday_fx)
    if body.holiday_3d is not None:
        s['holiday_3d'] = bool(body.holiday_3d)
    if body.holiday_country is not None:
        c = body.holiday_country.strip().upper()
        if c and not (len(c) == 2 and c.isascii() and c.isalpha()):
            raise auth.hata(422, 'invalid', 'holiday_country ISO 3166-1 alfa-2 ya da boş olmalı')
        s['holiday_country'] = c
    if body.lang is not None:
        s['lang_chosen'] = True
    with db.connect() as conn:
        conn.execute('UPDATE users SET lang = ?, theme = ?, settings = ?, updated_at = ? WHERE id = ?',
                     (body.lang or user['lang'], body.theme or user['theme'], json.dumps(s), db.now(), user['id']))
        conn.commit()
        u = db.row(conn.execute('SELECT * FROM users WHERE id = ?', (user['id'],)))
    return _out(u)
