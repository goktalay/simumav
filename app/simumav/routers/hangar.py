"""`/api/hangar` — dronlar (≤ 20) ve katalog (flightsim_models dahili modeller + prosedürel şablonlar).
Güç ve yakıt (§10): `power` {engine, max_speed_ms, fuel_l, fuel_km_per_l, elec_cells, elec_mah, elec_w} — power.dogrula (sunucu sınırları; ölçüm
alanları *_last yalnız sunucu yazar); `null`/eksik → katalog modelinin varsayılanı; PUT `power: {}` gövdesi değişmez, `reset_power: true` varsayılana döner."""
import json
import re
from typing import Optional

from fastapi import APIRouter, Request
from pydantic import BaseModel, Field

from .. import auth, bridge, config, db, equipment, power
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
    power: Optional[dict] = None                           # güç ve yakıt (§10); eksik → modelin varsayılanı
    equipment: Optional[dict] = None                       # yol haritası: {camera, addons, livery, max_alt_m} (equipment.dogrula)


class DronePatch(BaseModel):
    name: Optional[str] = Field(None, min_length=1, max_length=40)
    model_key: Optional[str] = Field(None, max_length=40)
    params: Optional[dict] = None
    color: Optional[str] = Field(None, max_length=7)
    is_default: Optional[bool] = None
    airframe: Optional[str] = Field(None, max_length=12)
    power: Optional[dict] = None
    reset_power: Optional[bool] = None
    equipment: Optional[dict] = None


def _guc(tip, govde, taban, request, user):
    try:
        return power.dogrula(tip, govde, taban)
    except power.GucHata as e:
        db.audit_bagimsiz('power_reject', user['id'], auth.client_ip(request), str(e)[:200])
        raise auth.hata(422, 'invalid', str(e))


def _dogrula(tip, model_key, params, color, request, user):
    if tip not in bridge.TYPES:
        raise auth.hata(422, 'invalid', 'type multirotor | plane | heli | fpv | interceptor | vtol | rover olmalı')
    if not bridge.model_gecerli(tip, model_key):
        raise auth.hata(422, 'invalid', 'model_key bu tip için katalogda yok')
    if color is not None and not _RENK.match(color):
        raise auth.hata(422, 'invalid', 'color #rrggbb olmalı')
    try:
        return bridge.params_dogrula(params)
    except bridge.BridgeHata as e:
        db.audit_bagimsiz('param_reject', user['id'], auth.client_ip(request), e.message)
        hata_cevir(e)


def _donanim(tip, eq, conn=None, did=None):
    ids = [r[0] for r in conn.execute('SELECT id FROM drone_decals WHERE drone_id = ?', (did,))] if conn is not None and did else []
    try:
        d = equipment.dogrula(tip, eq, ids)
    except equipment.DonanimHata as e:
        raise auth.hata(422, 'invalid', str(e))
    return json.dumps(d) if d is not None else None


@router.get('/catalog')
def catalog(user=User):
    out = bridge.katalog()
    for t in out['types']:   # §10: her modelin güç varsayılanı (sihirbaz/hangar önizlemesi)
        for m in t['models']:
            m['power'] = power.varsayilan(t['key'], m['key'])
    out['power'] = power.api_bilgisi(config.MAX_SPEEDUP)
    return out


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
    pw = power.kayit_json(_guc(body.type, body.power, power.varsayilan(body.type, body.model_key), request, user)) if body.power is not None else None
    eq = _donanim(body.type, body.equipment) if body.equipment is not None else None   # yeni dronda çıkartma yok (yükleme kayıttan sonra)
    t = db.now()
    with db.connect() as conn:
        kota(conn, 'drones', user, request)
        did = conn.execute('INSERT INTO drones (user_id, name, type, model_key, params, color, airframe, power, equipment, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
                           (user['id'], body.name.strip(), body.type, body.model_key, json.dumps(params), body.color or '#ff6a00', airframe, pw, eq, t, t)).lastrowid
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
        # güç (§10): gönderilmişse mevcut etkin ayarın üstüne doğrulanır (ölçümler korunur); reset_power → NULL (model varsayılanı);
        # model değişip güç gönderilmediyse ve kayıt varsayılanla çalışıyorsa NULL kalır (yeni modelin varsayılanı)
        pw = d.get('power')
        if body.reset_power:
            pw = None
        elif body.power is not None:
            dd = {**d, 'model_key': model_key}
            mevcut = power.kayit_oku(dd)
            pw = power.kayit_json(_guc(d['type'], body.power, {k: mevcut.get(k) for k in power.GIRIS_ALANLARI}, request, user), power.ham(d))
        eq = _donanim(d['type'], body.equipment, conn, did) if body.equipment is not None else d.get('equipment')
        if body.is_default:
            conn.execute('UPDATE drones SET is_default = 0 WHERE user_id = ?', (user['id'],))
        conn.execute('UPDATE drones SET name = ?, model_key = ?, params = ?, color = ?, is_default = ?, airframe = ?, power = ?, equipment = ?, updated_at = ? WHERE id = ?',
                     ((body.name or d['name']).strip(), model_key, json.dumps(params), body.color or d['color'],
                      1 if body.is_default else (0 if body.is_default is False else d['is_default']), airframe, pw, eq, db.now(), did))
        conn.commit()
        return drone_api(sahip(conn, 'drones', did, user))


@router.delete('/{did}')
def delete_drone(did: int, user=User):
    fid, a = bridge.aktif_ucus(user['id'])
    with db.connect() as conn:
        d = sahip(conn, 'drones', did, user)
        if fid is not None and db.row(conn.execute('SELECT 1 FROM flights WHERE id = ? AND drone_id = ?', (fid, did))):
            raise auth.hata(409, 'in_use', 'Bu dron şu an uçuşta')
        dosyalar = [r[0] for r in conn.execute('SELECT path FROM drone_decals WHERE drone_id = ?', (did,))]
        conn.execute('DELETE FROM drones WHERE id = ?', (did,))
        conn.commit()
    from .hangar_extra import dosya_sil
    for rel in dosyalar:   # yol haritası: dronun çıkartma dosyaları da silinir (satırlar FK ile)
        dosya_sil(rel)
    return {'ok': True, 'deleted': d['id']}
