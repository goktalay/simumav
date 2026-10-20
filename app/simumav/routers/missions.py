"""`/api/missions` — görevler (≤ 50). plan JSON: HEPGO görev biçimi {items:[{seq, command, frame, x(lat·1e7), y(lon·1e7), z, param1..4}], …} YA DA
oyun arayüzü editörünün `route` biçimi {route:{points:[{seq, cmd, lat, lon, alt_rel, frame}]}, shape, params, order, laps} (flightsim_mission `route`;
bridge._gorev_yukle items'a çevirir) + tür parametreleri; fpv_gates: {order:[halka i…], laps 1–10}. Doğrulama: ≤ 500 öğe, tüm konumlu öğeler parkur
yarıçapı içinde, z 0–1000 m."""
import json
from typing import Optional

from fastapi import APIRouter, Request
from pydantic import BaseModel, Field

from .. import auth, bridge, config, db
from ... import flightsim_gcs
from ...flightsim_mission import mesafe_m
from .common import User, kota, mission_api, sahip

router = APIRouter(prefix='/api/missions')
PLAN_MAX = 500
PLAN_BYTES = 256 * 1024


class MissionIn(BaseModel):
    track_id: int
    name: str = Field(..., min_length=1, max_length=40)
    kind: str = Field(..., max_length=12)
    plan: dict = Field(default_factory=dict)


class MissionPatch(BaseModel):
    name: Optional[str] = Field(None, min_length=1, max_length=40)
    kind: Optional[str] = Field(None, max_length=12)
    plan: Optional[dict] = None


def plan_ogeleri(plan):
    """plan.items (HEPGO) ya da plan.route.points / plan.route (editör) → öğe listesi (doğrulama için; biçim dönüşümü bridge'de)."""
    items = plan.get('items')
    if isinstance(items, list) and items:
        return items
    route = plan.get('route')
    if isinstance(route, dict):
        return route.get('points') or []
    return route or []


def plan_dogrula(plan, kind, track, request, user):
    def red(msg):
        db.audit_bagimsiz('plan_reject', user['id'], auth.client_ip(request), msg)
        raise auth.hata(422, 'plan_rejected', msg)
    if kind not in bridge.KINDS:
        red('kind corridor | free | spray | fpv_flags | fpv_gates | survey | defend olmalı')
    if not isinstance(plan, dict):
        red('plan bir nesne olmalı')
    if kind == 'defend':   # HEPGO §26 "Yer kontrolünü koru": rota yok; plan.defend parametreleri (tohum kayda sabitlenir → aynı görev aynı senaryo)
        fazla = [k for k in plan if k not in ('kind', 'defend', 'params', 'shape', 'order', 'laps', 'route')]
        if fazla:
            red('defend planında bilinmeyen alan')
        try:
            d = flightsim_gcs.savunma_dogrula(plan.get('defend') if isinstance(plan.get('defend'), dict) else {}, None)
        except flightsim_gcs.GcsHata as e:
            red(str(e))
        return {'kind': 'defend', 'defend': d}
    if len(json.dumps(plan)) > PLAN_BYTES:
        red('plan çok büyük (256 KB)')
    items = plan_ogeleri(plan)
    if not isinstance(items, list) or len(items) > PLAN_MAX:
        red(f'plan en çok {PLAN_MAX} nokta içerebilir')
    for it in items:
        if not isinstance(it, dict):
            red('görev öğesi bir nesne olmalı')
        try:
            x, y = it.get('x'), it.get('y')
            z = float((it.get('z') if it.get('z') is not None else it.get('alt_rel', it.get('alt'))) or 0)
            lat = float(x) / 1e7 if x not in (None, 0) and abs(float(x)) > 1000 else float(it.get('lat', x or 0))
            lon = float(y) / 1e7 if y not in (None, 0) and abs(float(y)) > 1000 else float(it.get('lon', y or 0))
            cmd = int(it.get('command', it.get('cmd', 16)) or 16)
        except (TypeError, ValueError):
            red('görev öğesi alanları sayı olmalı')
        if not (0 <= z <= 1000):
            red('görev irtifası 0–1000 m olmalı')
        if (lat or lon) and (not (-90 <= lat <= 90 and -180 <= lon <= 180) or (mesafe_m(track['lat'], track['lon'], lat, lon) or 0) > track['radius_m']):
            red('görev noktası parkur yarıçapı dışında')
        if cmd in (217, 218, 219, 220, 221, 222, 223, 224, 225, 226, 227, 228, 229, 230, 231, 232, 233, 234, 235, 236, 237, 238, 239, 240, 241, 242, 243, 244, 245, 246, 247, 248, 249, 250):
            red('bu görev komutu simülatörde izinli değil')   # preflight/calibration/reboot aralığı
    if kind == 'fpv_gates':
        gates = db.j(track.get('gates'), [])
        order = plan.get('order') or []
        laps = plan.get('laps', 1)
        if not isinstance(order, list) or len(order) > 500 or any(not isinstance(i, int) or not any(g['i'] == i for g in gates) for i in order):
            red('order parkurdaki halka numaralarından oluşmalı')
        if isinstance(laps, bool) or not isinstance(laps, int) or not (1 <= laps <= 10):
            red('laps 1–10 olmalı')
    return plan


@router.get('')
def list_missions(track_id: Optional[int] = None, user=User):
    with db.connect() as conn:
        if track_id is not None:
            rows = db.rows(conn.execute('SELECT * FROM missions WHERE user_id = ? AND track_id = ? ORDER BY id DESC', (user['id'], track_id)))
        else:
            rows = db.rows(conn.execute('SELECT * FROM missions WHERE user_id = ? ORDER BY id DESC', (user['id'],)))
        return {'missions': [mission_api(m) for m in rows], 'quota': config.QUOTA['missions']}


@router.post('', status_code=201)
def add_mission(body: MissionIn, request: Request, user=User):
    t = db.now()
    with db.connect() as conn:
        track = sahip(conn, 'tracks', body.track_id, user)
        plan = plan_dogrula(body.plan, body.kind, track, request, user)
        kota(conn, 'missions', user, request)
        mid = conn.execute('INSERT INTO missions (user_id, track_id, name, kind, plan, created_at, updated_at) VALUES (?,?,?,?,?,?,?)',
                           (user['id'], track['id'], body.name.strip(), body.kind, json.dumps(plan, ensure_ascii=False), t, t)).lastrowid
        conn.commit()
        return mission_api(sahip(conn, 'missions', mid, user))


@router.put('/{mid}')
def update_mission(mid: int, body: MissionPatch, request: Request, user=User):
    with db.connect() as conn:
        m = sahip(conn, 'missions', mid, user)
        track = sahip(conn, 'tracks', m['track_id'], user)
        kind = body.kind or m['kind']
        plan = plan_dogrula(body.plan if body.plan is not None else db.j(m['plan']), kind, track, request, user)
        conn.execute('UPDATE missions SET name = ?, kind = ?, plan = ?, updated_at = ? WHERE id = ?',
                     ((body.name or m['name']).strip(), kind, json.dumps(plan, ensure_ascii=False), db.now(), mid))
        conn.commit()
        return mission_api(sahip(conn, 'missions', mid, user))


@router.delete('/{mid}')
def delete_mission(mid: int, user=User):
    with db.connect() as conn:
        sahip(conn, 'missions', mid, user)
        conn.execute('DELETE FROM missions WHERE id = ?', (mid,))
        conn.commit()
    return {'ok': True, 'deleted': mid}
