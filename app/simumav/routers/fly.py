"""`/api/fly` + WebSocket'ler (§4) ve HEPGO ön yüz modülleri için uyumluluk yüzeyi.

- `POST /api/fly/start`, `GET /api/fly/{flight_id}`, `POST /api/fly/{flight_id}/stop {gates?}`.
- `WS /ws/fly/{sim_id}` (= HEPGO `/ws/drone/sim/{id}` mesaj biçimi: hello/tele/event/state/route/end; cmd/rc/ping). Aynı döngü `/ws/drone/sim/{sid}`
  yolunda da sunulur (flightsim.js değişmeden). `/ws/drone/live`: harekât paneli (flightsim_panel.js) için drone_hub izleyici kalıbı — yalnız
  `{t:'watch', sim_id}` kendi oturumu; `cmd` yalnız kendi oturumunun köprüsüne.
- `/api/drone/sim/*` alt kümesi: HEPGO sim modüllerinin (flightsim.js, flightsim3d.js, flightsim_g3d.js, flightsim_panel.js) çağırdığı okuma/komut uçları,
  oturum sahipliğiyle: meta, g3d-key, sessions, sessions/{id}(GET/DELETE/cmd/summary/live), terrain, tile, osm, models (salt okunur).
Güvenlik: WS açılışında çerez doğrulanır, oturum sahibi değilse 4403; WS mesaj oranı 100/sn (aşımda bağlantı kapanır); komutlar çekirdeğin
`komut` doğrulamasından geçer (KOMUTLAR + aralıklar)."""
import asyncio
import json
import re
import secrets
import time
from typing import Optional, Union

from fastapi import APIRouter, Request, Response, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

from .. import auth, bridge, config, db
from ... import drone_hub, flightsim, flightsim_hub, flightsim_models, flightsim_rec, sim_terrain
from .common import User, flight_api, hata_cevir, sahip

router = APIRouter(prefix='/api/fly')
compat = APIRouter(prefix='/api/drone/sim')
ws_router = APIRouter()


class RecordIn(BaseModel):
    video: bool = False
    bin: bool = True


class LaunchIn(BaseModel):
    method: str = Field('wheels', max_length=8)
    angle_deg: Optional[float] = Field(None, ge=10, le=30)
    release_kmh: Optional[float] = Field(None, ge=40, le=110)
    hand_speed_ms: Optional[float] = Field(None, ge=6, le=8)
    hand_pitch_deg: Optional[float] = Field(None, ge=10, le=15)


class StartIn(BaseModel):
    drone_id: int
    pilot_id: int
    track_id: int
    mission_id: Optional[int] = None
    launch: Union[LaunchIn, str, None] = None     # {method, angle_deg, release_kmh, hand_speed_ms, hand_pitch_deg} ya da yalnız yöntem adı
    record: Optional[RecordIn] = None


class RecStartIn(BaseModel):
    mime: Optional[str] = Field(None, max_length=40)


class RecFinishIn(BaseModel):
    duration_s: Optional[float] = Field(None, ge=0, le=36000)
    mime: Optional[str] = Field(None, max_length=40)
    text: Optional[str] = Field(None, max_length=300)
    share: Optional[bool] = None


class StopIn(BaseModel):
    gates: Optional[dict] = None
    reason: Optional[str] = Field(None, max_length=20)


class CmdIn(BaseModel):
    name: str = Field(..., max_length=20)
    params: Optional[dict] = None


@router.post('/start', status_code=201)
async def start(body: StartIn, request: Request, user=User):
    with db.connect() as conn:
        drone = sahip(conn, 'drones', body.drone_id, user)
        pilot = sahip(conn, 'pilots', body.pilot_id, user)
        track = sahip(conn, 'tracks', body.track_id, user)
        mission = sahip(conn, 'missions', body.mission_id, user) if body.mission_id is not None else None
        if mission and mission['track_id'] != track['id']:
            raise auth.hata(422, 'invalid', 'Görev bu parkura ait değil')
    launch = body.launch.model_dump(exclude_none=True) if isinstance(body.launch, LaunchIn) else {'method': body.launch or 'wheels'}
    try:
        out = await bridge.ucus_baslat(user, pilot, drone, track, mission, launch, body.record.model_dump() if body.record else None, request)
    except bridge.BridgeHata as e:
        if e.error in ('server_full', 'flight_open'):
            db.audit_bagimsiz('quota', user['id'], auth.client_ip(request), e.message)
        hata_cevir(e)
    return out


@router.get('/current')
def current(request: Request, user=User):
    """Kullanıcının açık uçuşu `{flight_id, sim_id, started_at, state, drone, track, pilot, …}` ya da null. (`/{fid}`'den ÖNCE tanımlı: int yol eşleşmesin.)"""
    return bridge.aktif_ucus_ozeti(user['id'], request)


def _ucus(conn, fid, user):
    return sahip(conn, 'flights', fid, user)


@router.get('/{fid}')
def status(fid: int, request: Request, user=User):
    with db.connect() as conn:
        f = _ucus(conn, fid, user)
    out = flight_api(f)
    d = bridge.ucus_durumu(fid)
    out['live'] = d
    out['flight_id'] = f['id']
    out['sim_id'] = d['sim_id'] if d else None
    out['state'] = d['state'] if d else 'KAPANDI'
    s = bridge.oturum(d['sim_id']) if d else None
    out['session'] = s.to_dict(bridge.host_adi(request)) if s is not None else None
    snap = out.get('snapshot') or {}
    out['launch'] = snap.get('launch') or {'method': f.get('launch') or 'wheels'}
    out['record'] = snap.get('record') or {'bin': True, 'video': False}
    if d and d.get('mp'):
        out['mp'] = {'host': bridge.host_adi(request), 'port': d['mp']['port'], 'proto': 'tcp', 'locked_ip': d['mp']['locked_ip'], 'connected': d['mp']['connected']}
    else:
        out['mp'] = None
    out['ws'] = f"/ws/fly/{d['sim_id']}" if d else None
    return out


# ---------------- ekran kaydı (flightsim_rec kalıbı; dosyalar core/sim_rec; video → flights.video_path) ----------------
def _rec_hata(e):
    raise auth.hata(e.kod, 'rec', str(e))


def _rec_user(user):
    return {'id': user['id'], 'full_name': user['display_name']}


@router.post('/{fid}/rec/start', status_code=201)
def rec_start(fid: int, body: RecStartIn, user=User):
    with db.connect() as conn:
        _ucus(conn, fid, user)
    d = bridge.ucus_durumu(fid)
    s = bridge.oturum(d['sim_id']) if d else None
    if s is None:
        raise auth.hata(404, 'not_found', 'Süren uçuş bulunamadı')
    try:
        m = flightsim_rec.basla(s.to_dict(), _rec_user(user), False, body.mime)
    except flightsim_rec.RecHata as e:
        _rec_hata(e)
    with db.connect() as conn:
        conn.execute('UPDATE flights SET video_path = ?, updated_at = ? WHERE id = ?', (f"sim_rec/{m['id']}{m['ext']}", db.now(), fid))
        conn.commit()
    return {'rec_id': m['id'], 'max_bytes': m['max_bytes'], 'chunk_max': flightsim_rec.CHUNK_MAX, 'ext': m['ext']}


async def _govde(request, sinir):
    try:
        cl = int(request.headers.get('content-length') or 0)
    except ValueError:
        cl = 0
    if cl > sinir:
        raise auth.hata(413, 'too_large', f'Gövde {sinir // 1024 ** 2} MB sınırını aşıyor')
    data = await request.body()
    if len(data) > sinir:
        raise auth.hata(413, 'too_large', f'Gövde {sinir // 1024 ** 2} MB sınırını aşıyor')
    return data


def _rid(rid):
    if not re.fullmatch(r'[0-9a-f]{16}', rid or ''):
        raise auth.hata(404, 'not_found', 'Kayıt bulunamadı')
    return rid


@router.put('/rec/{rid}/chunk')
async def rec_chunk(rid: str, request: Request, seq: int = 0, user=User):
    data = await _govde(request, flightsim_rec.CHUNK_MAX)
    try:
        m = await asyncio.get_running_loop().run_in_executor(None, flightsim_rec.parca, _rid(rid), _rec_user(user), False, seq, data)
    except flightsim_rec.RecHata as e:
        _rec_hata(e)
    return {'ok': True, 'seq': m['seq'], 'size': m['size'], 'max_bytes': m.get('max_bytes')}


@router.put('/rec/{rid}/thumb')
async def rec_thumb(rid: str, request: Request, user=User):
    data = await _govde(request, flightsim_rec.THUMB_MAX)
    try:
        flightsim_rec.kucuk_resim(_rid(rid), _rec_user(user), False, data)
    except flightsim_rec.RecHata as e:
        _rec_hata(e)
    return {'ok': True}


@router.post('/rec/{rid}/finish')
def rec_finish(rid: str, body: RecFinishIn, user=User):
    """Bitir: video sunucuda saklanır (paylaşım yok) → `{ok, kept:true, rec_id, size, text, file}`; flights.video_path bu kayda işaret eder."""
    try:
        r = flightsim_rec.sakla(_rid(rid), _rec_user(user), False, body.duration_s, body.text)
    except flightsim_rec.RecHata as e:
        _rec_hata(e)
    return {'ok': True, 'kept': True, 'rec_id': rid, 'size': r['size'], 'text': r['text'], 'file': f'/api/fly/rec/{rid}/file', 'link': None}


@router.get('/rec/{rid}/file')
def rec_file(rid: str, user=User):
    try:
        p, mime, ad = flightsim_rec.dosya(_rid(rid), _rec_user(user), False)
    except flightsim_rec.RecHata as e:
        _rec_hata(e)
    return FileResponse(p, media_type=mime, filename=ad.replace('ucus-simulatoru', 'simumav'), headers={'Cache-Control': 'private, no-store'})


@router.delete('/rec/{rid}')
def rec_delete(rid: str, user=User):
    try:
        flightsim_rec.sil(_rid(rid), _rec_user(user), False)
    except flightsim_rec.RecHata as e:
        _rec_hata(e)
    with db.connect() as conn:
        conn.execute('UPDATE flights SET video_path = NULL WHERE user_id = ? AND video_path LIKE ?', (user['id'], f'sim_rec/{rid}%'))
        conn.commit()
    return {'ok': True}


@router.post('/{fid}/stop')
async def stop(fid: int, request: Request, body: Optional[StopIn] = None, user=User):
    with db.connect() as conn:
        _ucus(conn, fid, user)
    try:
        gates = bridge.gates_sonuc_dogrula(body.gates if body else None)
    except bridge.BridgeHata as e:
        hata_cevir(e)
    if not await bridge.ucus_durdur(fid, 'kapatildi', gates):
        with db.connect() as conn:
            f = _ucus(conn, fid, user)
        if f.get('ended_at'):
            return {'ok': True, 'already': True, 'flight': flight_api(f)}
        raise auth.hata(404, 'not_found', 'Süren uçuş bulunamadı')
    with db.connect() as conn:
        f = _ucus(conn, fid, user)
    return {'ok': True, 'flight': flight_api(f)}


# ---------------- uyumluluk: /api/drone/sim/* ----------------
def _oturum(sid, user):
    s = bridge.oturum_sahibi(sid, user['id'])
    if s is None:
        raise auth.hata(404, 'not_found', 'Oturum bulunamadı')
    return s


def _tracks_as_centers(conn, user):
    return [{'id': t['id'], 'name': t['name'], 'lat': t['lat'], 'lon': t['lon'], 'alt': None, 'location_name': None}
            for t in db.rows(conn.execute('SELECT id, name, lat, lon FROM tracks WHERE user_id = ? ORDER BY is_default DESC, id', (user['id'],)))]


@compat.get('/meta')
def c_meta(request: Request, user=User):
    with db.connect() as conn:
        centers = _tracks_as_centers(conn, user)
    return {'types': flightsim.tipler(), 'centers': centers, 'world_defaults': dict(flightsim.WORLD_DEFAULTS),
            'limits': {'max_sessions': config.MAX_FLIGHTS, 'max_minutes': config.FLIGHT_MINUTES}, 'host': bridge.host_adi(request), 'can_command': True,
            'replay': {'logs_allowed': False, 'hz': 25, 'formats': ['.bin']}, 'google3d': {'enabled': flightsim.google3d_etkin()}, 'simumav': True}


@compat.get('/g3d-key')
def c_g3d(user=User):
    if not flightsim.google3d_etkin():
        raise auth.hata(404, 'not_configured', 'Google 3B kipi yapılandırılmamış')
    return Response(content=json.dumps({'key': config.GOOGLE_KEY}), media_type='application/json', headers={'Cache-Control': 'no-store', 'Pragma': 'no-cache'})


@compat.get('/sessions')
def c_sessions(request: Request, user=User):
    return [s.to_dict(bridge.host_adi(request)) for s in flightsim.MANAGER.sessions.values() if s.state != 'KAPANDI' and (s.owner or {}).get('id') == user['id']]


@compat.get('/sessions/{sid}')
def c_session(sid: int, request: Request, user=User):
    s = _oturum(sid, user)
    return {**s.to_dict(bridge.host_adi(request)), 'gates': list(getattr(s, 'sm_gates', []) or []), 'flight_id': getattr(s, 'sm_flight_id', None)}


@compat.delete('/sessions/{sid}')
async def c_close(sid: int, user=User):
    s = _oturum(sid, user)
    fid = getattr(s, 'sm_flight_id', None)
    if fid is not None:
        await bridge.ucus_durdur(fid)
    else:
        await flightsim.MANAGER.kapat(sid)
    return {'ok': True, 'bin': getattr(s, 'bin_sonuc', None)}


@compat.post('/sessions/{sid}/cmd')
async def c_cmd(sid: int, body: CmdIn, user=User):
    s = _oturum(sid, user)
    try:
        return await s.komut(body.name, body.params or {}, kaynak=user['id'])
    except flightsim.SimHata as e:
        raise auth.hata(400, e.kod, str(e))


@compat.get('/sessions/{sid}/summary')
async def c_summary(sid: int, user=User):
    s = _oturum(sid, user)
    return await s.gorev.ozet_kaydet()


@compat.get('/sessions/{sid}/live')
def c_live(sid: int, request: Request, user=User):
    s = _oturum(sid, user)
    y = flightsim_hub.live_payload(s, _hub_user(user))
    if y is None:
        raise auth.hata(400, 'no_bridge', 'Oturumun paneli henüz açılmadı')
    y['session'] = s.to_dict(bridge.host_adi(request))
    return y


@compat.get('/terrain')
def c_terrain(lat: float, lon: float, size_m: float = None, far: int = 0, user=User):
    try:
        return sim_terrain.terrain_plani(lat, lon, size_m, uzak=bool(far))
    except ValueError as e:
        raise auth.hata(400, 'invalid', str(e))


@compat.get('/tile/{kind}/{z}/{x}/{y}')
def c_tile(kind: str, z: int, x: int, y: int, user=User):
    try:
        data, ctype = sim_terrain.karo(kind, z, x, y)
    except ValueError as e:
        raise auth.hata(404, 'invalid', str(e))
    except sim_terrain.KaynakHata as e:
        raise auth.hata(e.kod, 'tile_source', str(e))
    return Response(content=data, media_type=ctype, headers={'Cache-Control': 'private, max-age=86400'})


@compat.get('/osm')
def c_osm(lat: float, lon: float, size_m: float = 4000, user=User):
    try:
        return sim_terrain.osm(lat, lon, size_m)
    except ValueError as e:
        raise auth.hata(400, 'invalid', str(e))
    except sim_terrain.KaynakHata as e:
        raise auth.hata(e.kod, 'osm_source', str(e))


@compat.get('/models')
def c_models(type: Optional[str] = None, user=User):
    """Yalnız dahili modeller (yükleme yok, v1)."""
    out = []
    for t in ([type] if type else list(flightsim.TIP_ADLARI)):
        for key, b in flightsim_models.BUILTIN.items():
            if t in b['types']:
                out.append(flightsim_models.builtin_api(key, t))
    return {'models': out, 'defaults': dict(flightsim_models.VARSAYILAN), 'can_write': False, 'design_allowed': False, 'limits': {'max_bytes': 0, 'formats': []}}


@compat.get('/models/{mid}')
def c_model(mid: str, type: Optional[str] = None, user=User):
    k = flightsim_models.kimlik_coz(mid)
    if not k or k[0] != 'builtin':
        raise auth.hata(404, 'not_found', 'Model bulunamadı')
    return flightsim_models.builtin_api(k[1], type)


@compat.get('/runs/stats')
def c_runs_stats(user=User):
    with db.connect() as conn:
        n = conn.execute('SELECT COUNT(*), COALESCE(SUM(duration_s), 0) FROM flights WHERE user_id = ? AND ended_at IS NOT NULL', (user['id'],)).fetchone()
    return {'total': n[0], 'flight_s': int(n[1] or 0), 'open_sessions': 1 if bridge.aktif_ucus(user['id'])[0] else 0}


@compat.get('/reports')
def c_reports(user=User):
    return {'items': []}


@compat.get('/rec/pending')
def c_rec_pending(user=User):
    return {'items': [], 'max_mb': 0}


@ws_router.get('/api/drone/routes')
def c_routes(user=User):
    """flightsim_panel.js (hub:true) HEPGO rota listesini ister; SIMUMAV'da kayıtlı rota yok → boş liste (404 yerine)."""
    return []


# ---------------- WebSocket ----------------
def _hub_user(u):
    """drone_hub izleyici/komut kalıbının beklediği kullanıcı sözlüğü (yalnız drone.sim yetkisi; field.live yok)."""
    return {'id': u['id'], 'full_name': u['display_name'], 'username': u['email'], 'modules': ['drone.sim'], 'write_modules': ['drone.sim'], 'roles': [], 'master': False}


class _Oran:
    def __init__(self, limit, window):
        self.limit, self.window, self.q = limit, window, []

    def tik(self):
        t = time.time()
        self.q = [x for x in self.q if x > t - self.window]
        self.q.append(t)
        return len(self.q) <= self.limit


async def _sender(ws, q):
    try:
        while True:
            await ws.send_text(await q.get())
    except Exception:   # noqa: BLE001
        pass


async def _ws_ac(ws):
    """Ortak açılış: accept + çerezden kullanıcı; yoksa 4403 ve None."""
    await ws.accept()
    user = await asyncio.get_running_loop().run_in_executor(None, auth.kullanici_ws, ws.cookies.get(auth.COOKIE))
    if not user:
        await drone_hub._safe_send(ws, {'t': 'error', 'error': 'auth'})
        await ws.close(code=4403)
        return None
    return user


SIM_KOMUT = set(flightsim.KOMUTLAR)   # arm, disarm, mode, takeoff, rtl, reset, crash, set_home, rc — çekirdek SimSession.komut


def _hello(s, user, host):
    """TEK soket: HEPGO sim `hello{session…}` + hub `hello{bridges, me, caps}` alanları birlikte (flightsim_panel.js watch beklemeden de dolu)."""
    hub = getattr(s, 'hub', None)
    bridges = [hub.info()] if hub is not None else []
    return {'t': 'hello', 'v': drone_hub.PROTO, 'session': s.to_dict(host), 'can_command': True, 'gates': list(getattr(s, 'sm_gates', []) or []),
            'flight_id': getattr(s, 'sm_flight_id', None), 'me': {'id': user['id'], 'name': user['display_name'], 'can_command': True},
            'bridges': bridges, 'caps': drone_hub.all_caps([hub]) if hub is not None else list(drone_hub.CAPS),
            'task': hub.task_info() if hub is not None else None, 'flights': [hub.flight_info()] if hub is not None else []}


async def _sim_ws(ws, sid):
    """`/ws/fly/{sim_id}`: sim mesajları (tele/event/state/route/launch/end — SimSession izleyici kuyruğu) + hub mesajları (status/console/konsol/params/
    event — drone_hub Viewer, yalnız bu oturumun köprüsü) aynı akışta. İstemci: `ping`, `watch{sim_id}` (hello yeniden), `rc{ch}`,
    `cmd{rid, name, params, bridge_id?, sysid?}` → `res{rid, name, ok, error?, result?}`: çekirdek komutları (KOMUTLAR; takeoff{alt, launch:'hand', …}
    dâhil) SimSession.komut ile, hub komutları (set_mode, land, goto, mission_*, param_*, altitude_change, arm_check, arm{force} …) drone_hub.send_command
    ile (bileşik kalkış/görev akışları). `param_cache`/`console_hist` hub kalıbı."""
    user = await _ws_ac(ws)
    if not user:
        return
    s = bridge.oturum_sahibi(sid, user['id'])
    if s is None:
        await drone_hub._safe_send(ws, {'t': 'error', 'error': 'not_found'})
        await ws.close(code=4404)
        return
    host = bridge.host_adi(ws)
    hu = _hub_user(user)
    bridge.ws_goruldu(s.id)   # yetim denetimi: sahne bağlandı
    q = s.izleyici_ekle(ws)
    v = drone_hub.Viewer(ws, hu)
    v.sim_only = True
    v.q = q                      # hub yayınları aynı kuyruğa
    hub = getattr(s, 'hub', None)
    if hub is not None:
        flightsim_hub.apply_viewer(v, s.id)
    drone_hub.VIEWERS[ws] = v
    sender = asyncio.create_task(_sender(ws, q))
    flightsim._kuyruga(q, json.dumps(_hello(s, user, host), ensure_ascii=False))
    oran = _Oran(*config.RATE['ws'])
    yanit = lambda **k: flightsim._kuyruga(q, json.dumps({'t': 'res', **k}, ensure_ascii=False))   # noqa: E731
    try:
        while True:
            raw = await ws.receive_text()
            if not oran.tik():
                db.audit_bagimsiz('rate', user['id'], None, 'ws 100/s')
                await ws.close(code=4429)
                break
            if len(raw) > 65536:
                continue
            try:
                msg = json.loads(raw)
            except ValueError:
                continue
            if not isinstance(msg, dict):
                continue
            t = msg.get('t')
            if t == 'ping':
                flightsim._kuyruga(q, json.dumps({'t': 'pong'}))
            elif t == 'watch':
                if getattr(s, 'hub', None) is not None and v.sim_id is None:
                    flightsim_hub.apply_viewer(v, s.id)
                flightsim._kuyruga(q, json.dumps(_hello(s, user, host), ensure_ascii=False))
            elif t == 'rc':
                try:
                    await s.rc(msg.get('ch'))
                except flightsim.SimHata:
                    pass
            elif t in ('param_cache', 'console_hist'):
                b = getattr(s, 'hub', None)
                st = b.drones.get(int(msg.get('sysid') or 1)) if b is not None else None
                if t == 'param_cache':
                    flightsim._kuyruga(q, json.dumps({'t': 'param_cache', 'bridge_id': b.id if b else None, 'sysid': msg.get('sysid'), 'params': dict(st.params) if st else {}}, ensure_ascii=False))
                else:
                    flightsim._kuyruga(q, json.dumps({'t': 'console_hist', 'bridge_id': b.id if b else None, 'sysid': msg.get('sysid'), 'lines': list(st.console) if st else []}, ensure_ascii=False))
            elif t == 'cmd':
                name = str(msg.get('name') or '')[:30]
                rid = str(msg.get('rid') or secrets.token_hex(8))[:40]
                params = msg.get('params') if isinstance(msg.get('params'), dict) else {}
                b = getattr(s, 'hub', None)
                if msg.get('bridge_id') is not None and b is not None:
                    try:
                        if int(msg['bridge_id']) != b.id:
                            yanit(rid=rid, name=name, ok=False, error='Bu oturum size ait değil')
                            continue
                    except (TypeError, ValueError):
                        yanit(rid=rid, name=name, ok=False, error='bridge_id geçersiz')
                        continue
                sim_yolu = name in SIM_KOMUT and (name not in ('arm', 'disarm') or b is None) and not (name == 'takeoff' and 'alt_rel_m' in params and 'alt' not in params)
                if sim_yolu:
                    try:
                        if name == 'takeoff' and params.get('launch') == 'hand':
                            bridge.elden_atis_ayarla(s, params)
                        res = await s.komut(name, params, kaynak=user['id'])
                        yanit(rid=rid, name=name, **res)
                    except flightsim.SimHata as e:
                        yanit(rid=rid, name=name, ok=False, error=str(e))
                    continue
                if b is None:
                    yanit(rid=rid, name=name, ok=False, error='Oturum paneli henüz hazır değil')
                    continue

                async def run_cmd(m=msg, rid=rid, name=name, params=params, b=b):
                    try:
                        res = await drone_hub.send_command(hu, b.id, int(m.get('sysid') or 1), name, params, ws, rid)
                        yanit(rid=rid, name=name, **res)
                    except Exception as e:   # noqa: BLE001
                        yanit(rid=rid, name=name, ok=False, error=str(e)[:200])
                if name in drone_hub.SEQ_CMDS:
                    asyncio.get_running_loop().create_task(run_cmd())
                else:
                    await run_cmd()
    except (WebSocketDisconnect, Exception):   # noqa: BLE001
        pass
    finally:
        drone_hub.VIEWERS.pop(ws, None)
        s.izleyici_sil(ws)
        sender.cancel()


@ws_router.websocket('/ws/fly/{sid}')
async def ws_fly(ws: WebSocket, sid: int):
    await _sim_ws(ws, sid)


@ws_router.websocket('/ws/drone/sim/{sid}')
async def ws_sim_compat(ws: WebSocket, sid: int):
    await _sim_ws(ws, sid)


@ws_router.websocket('/ws/drone/live')
async def ws_live(ws: WebSocket):
    """Harekât paneli (flightsim_panel.js): drone_hub Viewer kalıbı; yalnız kendi oturumu izlenir ve komutlanır."""
    user = await _ws_ac(ws)
    if not user:
        return
    hu = _hub_user(user)
    v = drone_hub.Viewer(ws, hu)
    v.sim_only = True
    drone_hub.VIEWERS[ws] = v
    sender = asyncio.create_task(drone_hub._viewer_sender(v))
    hello = lambda: json.dumps(drone_hub.hello_msg(v), ensure_ascii=False)   # noqa: E731
    v.put(hello())
    oran = _Oran(*config.RATE['ws'])
    try:
        while True:
            raw = await ws.receive_text()
            if not oran.tik():
                await ws.close(code=4429)
                break
            if len(raw) > 65536:
                continue
            try:
                msg = json.loads(raw)
            except ValueError:
                continue
            if not isinstance(msg, dict):
                continue
            t = msg.get('t')
            if t == 'ping':
                v.put(json.dumps({'t': 'pong'}))
            elif t == 'watch':
                try:
                    s = bridge.oturum_sahibi(int(msg.get('sim_id') or 0), user['id'])
                except (TypeError, ValueError):
                    s = None
                b = flightsim_hub.apply_viewer(v, s.id) if s is not None else None
                if b is None:
                    v.sim_id, v.task, v.flights, v.allowed = None, None, [], set()
                    v.put(json.dumps({'t': 'error', 'error': 'Simülatör oturumu bulunamadı'}))
                    continue
                v.put(hello())
            elif t in ('param_cache', 'console_hist'):
                b = drone_hub._bridge_or_sim(msg.get('bridge_id'))
                if b is None or b.id not in v.allowed:
                    continue
                st = b.drones.get(int(msg.get('sysid') or 0))
                if t == 'param_cache':
                    v.put(json.dumps({'t': 'param_cache', 'bridge_id': msg.get('bridge_id'), 'sysid': msg.get('sysid'), 'params': dict(st.params) if st else {}}, ensure_ascii=False))
                else:
                    v.put(json.dumps({'t': 'console_hist', 'bridge_id': msg.get('bridge_id'), 'sysid': msg.get('sysid'), 'lines': list(st.console) if st else []}, ensure_ascii=False))
            elif t == 'cmd':
                rid = str(msg.get('rid') or secrets.token_hex(8))[:40]
                try:
                    bid = int(msg.get('bridge_id'))
                except (TypeError, ValueError):
                    bid = None
                if bid is None or bid not in v.allowed:
                    v.put(json.dumps({'t': 'res', 'rid': rid, 'ok': False, 'error': 'Bu oturum size ait değil'}, ensure_ascii=False))
                    continue

                async def run_cmd(m=msg, rid=rid, bid=bid):
                    try:
                        res = await drone_hub.send_command(hu, bid, int(m.get('sysid') or 1), str(m.get('name') or '')[:30], m.get('params') or {}, ws, rid)
                        v.put(json.dumps({'t': 'res', 'rid': rid, **res}, ensure_ascii=False))
                    except Exception as e:   # noqa: BLE001
                        v.put(json.dumps({'t': 'res', 'rid': rid, 'ok': False, 'error': str(e)[:200]}, ensure_ascii=False))
                if str(msg.get('name') or '') in drone_hub.SEQ_CMDS:
                    asyncio.get_running_loop().create_task(run_cmd())
                else:
                    await run_cmd()
    except (WebSocketDisconnect, Exception):   # noqa: BLE001
        pass
    finally:
        drone_hub.VIEWERS.pop(ws, None)
        sender.cancel()
