"""`/api/hangar` — dronlar (≤ 20) ve katalog (flightsim_models dahili modeller + prosedürel şablonlar)."""
import json
import re
from typing import Optional

from fastapi import APIRouter, Request
from pydantic import BaseModel, Field

from .. import auth, bridge, db
from .common import User, drone_api, hata_cevir, kota, sahip

router = APIRouter(prefix='/api/hangar')
_RENK = re.compile(r'^#[0-9a-fA-F]{6}$')


class DroneIn(BaseModel):
    name: str = Field(..., min_length=1, max_length=40)
    type: str = Field(..., max_length=16)
    model_key: str = Field(..., max_length=40)
    params: Optional[dict] = None
    color: Optional[str] = Field('#ff6a00', max_length=7)
    airframe: Optional[str] = Field(None, max_length=12)   # kontrol düzeni classic | elevon | vtail (sabit kanat ailesi); eksik → katalog modelinin düzeni


class DronePatch(BaseModel):
    name: Optional[str] = Field(None, min_length=1, max_length=40)
    model_key: Optional[str] = Field(None, max_length=40)
    params: Optional[dict] = None
    color: Optional[str] = Field(None, max_length=7)
    is_default: Optional[bool] = None
    airframe: Optional[str] = Field(None, max_length=12)


def _dogrula(tip, model_key, params, color, request, user):
    if tip not in bridge.TYPES:
        raise auth.hata(422, 'invalid', 'type multirotor | plane | heli | fpv | interceptor | vtol olmalı')
    if not bridge.model_gecerli(tip, model_key):
        raise auth.hata(422, 'invalid', 'model_key bu tip için katalogda yok')
    if color is not None and not _RENK.match(color):
        raise auth.hata(422, 'invalid', 'color #rrggbb olmalı')
    try:
        return bridge.params_dogrula(params)
    except bridge.BridgeHata as e:
        db.audit_bagimsiz('param_reject', user['id'], auth.client_ip(request), e.message)
        hata_cevir(e)


@router.get('/catalog')
def catalog(user=User):
    return bridge.katalog()


@router.get('')
def list_drones(user=User):
    with db.connect() as conn:
        return {'drones': [drone_api(d) for d in db.rows(conn.execute('SELECT * FROM drones WHERE user_id = ? ORDER BY is_default DESC, id', (user['id'],)))],
                'quota': bridge.config.QUOTA['drones']}


@router.post('', status_code=201)
def add_drone(body: DroneIn, request: Request, user=User):
    params = _dogrula(body.type, body.model_key, body.params, body.color, request, user)
    try:
        airframe = bridge.airframe_dogrula(body.type, body.airframe, body.model_key)
    except bridge.BridgeHata as e:
        hata_cevir(e)
    t = db.now()
    with db.connect() as conn:
        kota(conn, 'drones', user, request)
        did = conn.execute('INSERT INTO drones (user_id, name, type, model_key, params, color, airframe, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)',
                           (user['id'], body.name.strip(), body.type, body.model_key, json.dumps(params), body.color or '#ff6a00', airframe, t, t)).lastrowid
        conn.commit()
        return drone_api(sahip(conn, 'drones', did, user))


@router.put('/{did}')
def update_drone(did: int, body: DronePatch, request: Request, user=User):
    with db.connect() as conn:
        d = sahip(conn, 'drones', did, user)
        model_key = body.model_key or d['model_key']
        params = _dogrula(d['type'], model_key, body.params if body.params is not None else db.j(d['params']), body.color, request, user)
        try:   # düzen: gönderilmişse doğrula; model değişip düzen gönderilmediyse yeni modelin düzeni; aksi eski değer
            airframe = bridge.airframe_dogrula(d['type'], body.airframe, model_key) if (body.airframe is not None or (body.model_key and body.model_key != d['model_key'])) else d.get('airframe')
        except bridge.BridgeHata as e:
            hata_cevir(e)
        if body.is_default:
            conn.execute('UPDATE drones SET is_default = 0 WHERE user_id = ?', (user['id'],))
        conn.execute('UPDATE drones SET name = ?, model_key = ?, params = ?, color = ?, is_default = ?, airframe = ?, updated_at = ? WHERE id = ?',
                     ((body.name or d['name']).strip(), model_key, json.dumps(params), body.color or d['color'],
                      1 if body.is_default else (0 if body.is_default is False else d['is_default']), airframe, db.now(), did))
        conn.commit()
        return drone_api(sahip(conn, 'drones', did, user))


@router.delete('/{did}')
def delete_drone(did: int, user=User):
    fid, a = bridge.aktif_ucus(user['id'])
    with db.connect() as conn:
        d = sahip(conn, 'drones', did, user)
        if fid is not None and db.row(conn.execute('SELECT 1 FROM flights WHERE id = ? AND drone_id = ?', (fid, did))):
            raise auth.hata(409, 'in_use', 'Bu dron şu an uçuşta')
        conn.execute('DELETE FROM drones WHERE id = ?', (did,))
        conn.commit()
    return {'ok': True, 'deleted': d['id']}
