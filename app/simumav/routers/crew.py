"""`/api/crew` — pilotlar (≤ 20) ve 10 karakter (p01 pilot şapkalı erkek; en az 4 kadın). SVG'ler static/simumav/app/img/pilots/<key>.svg
(tek doğruluk kaynağı: `common.PILOT_SVG`; /app/img/pilots/<key>.svg).
§25: pilotun 3B avatarı `avatar` (avatar.py doğrular; verilmezse karakterin 3B karşılığı). `GET /api/crew/avatar-options` seçenek listeleri."""
import json
from typing import Optional

from fastapi import APIRouter, Request
from pydantic import BaseModel, Field

from .. import auth, avatar, bridge, config, db
from .common import PILOT_SVG, User, kota, pilot_api, sahip

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
    if a is not None and len(json.dumps(a)) > 600:
        raise auth.hata(422, 'invalid', 'avatar çok büyük')
    try:
        return avatar.dump(avatar.normalize(a, character, strict=True))
    except avatar.AvatarHata as e:
        raise auth.hata(422, 'invalid', str(e))


@router.get('/avatar-options')
def avatar_options(user=User):
    return {'skins': avatar.SKINS, 'patches': list(avatar.PATCHES), 'accessories': list(avatar.ACCESSORIES), 'default': avatar.DEFAULT,
            'legacy': {k: avatar.legacy(k) for k in avatar.LEGACY}}


@router.get('/characters')
def characters(user=User):
    return {'characters': [{**c, 'svg': PILOT_SVG.format(key=c['key'])} for c in CHARACTERS]}


@router.get('')
def list_pilots(user=User):
    with db.connect() as conn:
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
