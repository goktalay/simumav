"""SIMUMAV ↔ HEPGO uçuş simülatörü çekirdeği adaptörü (docs/simumav.md §1, §4 fly/ops, §7).

Çekirdek (`app.flightsim.MANAGER`, SimSession) DEĞİŞTİRİLMEZ; buradan yalnız çağrılır. `config` modülü çekirdeğin veri kökünü
SIMUMAV_DATA_DIR/core altına yönlendirmiş olmalıdır (bu modül onu içe aktarır → sıra garantili).

- `ucus_baslat`: kota (kullanıcı başına 1 uçuş; sunucu geneli SIMUMAV_MAX_FLIGHTS → 429 bekleme odası), tip/model/parkur eşlemesi,
  parametre beyaz listesi (drone_params kalıcı tablosu üzerinden SITL'e yüklenir), SimSession açılışı, `flights` satırı, MP TCP dinleyici.
- `MpKopru`: uçuş başına TCP dinleyici (SIMUMAV_MP_PORT_BASE aralığından rastgele boş port). İlk bağlanan istemcinin IP'si kilitlenir, aynı anda
  tek bağlantı; TCP ↔ SimSession'ın iç UDP GCS portu (127.0.0.1) arasında ham MAVLink köprüsü. 60 sn bağlanılmazsa ve uçuş bitince kapanır.
- Uçuş kapanışı (`_izle`): çekirdek oturum görevi bitince flights satırı tamamlanır (süre, sonuç, özet, .bin/params yolları); saklanan uçuş
  kotası (100) aşılırsa en eskisi dosyalarıyla silinir.
- `replay_hazirla`: .bin → flightsim_replay önbelleği (alt süreç), ops replay ucu için.
Sahte kip (HEPGO_SITL=0): çekirdek SahteKinematik ile çalışır; MP köprüsü ve kayıt yolu aynen sınanır.
"""
import asyncio
import json
import os
import re
import secrets
import socket
import time
from pathlib import Path

from . import config, db  # noqa: F401 — config önce: çekirdek yollarını yönlendirir
from .. import config as core_config  # noqa: E402
from .. import db as core_db  # noqa: E402
from .. import drone_sitl, flightsim, flightsim_models, flightsim_replay  # noqa: E402

TIP_ESLEME = {'multirotor': 'multirotor', 'fpv': 'multirotor', 'plane': 'sabit_kanat', 'interceptor': 'sabit_kanat', 'heli': 'helikopter', 'vtol': 'vtol'}
TYPES = tuple(TIP_ESLEME)
LAUNCHES = ('wheels', 'ramp', 'vehicle', 'hand')
LAUNCH_CEKIRDEK = {'wheels': 'wheels', 'ramp': 'ramp', 'vehicle': 'vehicle', 'hand': 'ramp'}   # elden atış: düşük ivmeli mancınık kalıbı (SITL'de özel model yok)
MODEL_ESLEME = {'proc:quad250': 'builtin:quad', 'proc:interceptor': 'builtin:delta'}        # prosedürel şablon → çekirdek dahili görsel model
KINDS = ('corridor', 'free', 'spray', 'fpv_flags', 'fpv_gates', 'survey')
WORLD_MODES = ('real', 'google3d', 'procedural')
# tracks.world: HEPGO WORLD_DEFAULTS alt kümesi (flightsim3d.js ile aynı anahtarlar); rüzgâr/saat/hava ayrı sütunlardan gelir
WORLD_KEYS = ('seed', 'size_m', 'tree_density', 'mountain_height', 'mountain_count', 'building_count', 'runway', 'runway_heading', 'water', 'fog', 'landing_circle_m')
GATE_MAX, GATE_R, GATE_AGL = 50, (1.0, 20.0), (1.0, 120.0)


def world_dogrula(w):
    """tracks.world → yalnız WORLD_KEYS; değer aralıkları çekirdeğin world_dogrula'sı ile (SimHata → BridgeHata 422)."""
    if w is None:
        return {}
    if not isinstance(w, dict):
        raise BridgeHata(422, 'invalid', 'world bir nesne olmalı')
    out = {k: w[k] for k in WORLD_KEYS if k in w and w[k] is not None}
    try:
        flightsim.world_dogrula({**out, 'mode': 'procedural'})
    except flightsim.SimHata as e:
        raise BridgeHata(422, 'invalid', str(e))
    return out


def gates_dogrula(gates, lat, lon, radius_m):
    """FPV halkaları: ≤ 50, radius 1–20 m, agl 1–120 m, parkur yarıçapı içinde, i 0..n-1 benzersiz."""
    if gates is None:
        return []
    if not isinstance(gates, list) or len(gates) > GATE_MAX:
        raise BridgeHata(422, 'invalid', f'gates en çok {GATE_MAX} halka içeren bir liste olmalı')
    from ..flightsim_mission import mesafe_m
    out, idx = [], set()
    for g in gates:
        if not isinstance(g, dict):
            raise BridgeHata(422, 'invalid', 'halka bir nesne olmalı')
        try:
            i, glat, glon = int(g.get('i')), float(g.get('lat')), float(g.get('lon'))
            agl, yaw, r = float(g.get('agl_m', 5)), float(g.get('yaw_deg', 0)) % 360, float(g.get('radius_m', 3))
        except (TypeError, ValueError):
            raise BridgeHata(422, 'invalid', 'halka alanları (i, lat, lon, agl_m, yaw_deg, radius_m) sayı olmalı')
        kind = g.get('kind', 'ring')
        if kind not in ('ring', 'gate'):
            raise BridgeHata(422, 'invalid', 'halka kind ring | gate olmalı')
        if not (GATE_R[0] <= r <= GATE_R[1]) or not (GATE_AGL[0] <= agl <= GATE_AGL[1]):
            raise BridgeHata(422, 'invalid', f'halka radius {GATE_R[0]:g}–{GATE_R[1]:g} m, agl {GATE_AGL[0]:g}–{GATE_AGL[1]:g} m olmalı')
        if not (-90 <= glat <= 90 and -180 <= glon <= 180) or (mesafe_m(lat, lon, glat, glon) or 0) > radius_m:
            raise BridgeHata(422, 'invalid', f'halka {i} parkur yarıçapı dışında')
        if i in idx or i < 0:
            raise BridgeHata(422, 'invalid', 'halka sıra numaraları 0..n-1 ve benzersiz olmalı')
        idx.add(i)
        out.append({'i': i, 'lat': round(glat, 7), 'lon': round(glon, 7), 'agl_m': agl, 'yaw_deg': yaw, 'radius_m': r, 'kind': kind})
    if idx and idx != set(range(len(out))):
        raise BridgeHata(422, 'invalid', 'halka sıra numaraları 0..n-1 olmalı')
    return sorted(out, key=lambda x: x['i'])
WEATHER = ('clear', 'cloudy', 'rain', 'fog', 'snow')
TIME_OF_DAY = ('day', 'dusk', 'night')
TIME_CEKIRDEK = {'day': 'day', 'dusk': 'dusk', 'night': 'night'}
FOG = {'clear': 0.05, 'cloudy': 0.2, 'rain': 0.45, 'fog': 0.8, 'snow': 0.5}

# ---- parametre beyaz listesi (§7 "Girdi") ----
PARAM_AD = re.compile(r'^[A-Z][A-Z0-9_]{1,15}$')
PARAM_ONEK_IZIN = ('ARSPD_', 'AIRSPEED_', 'THR_', 'TKOFF_', 'PTCH_', 'RLL_', 'YAW_', 'WP_', 'LIM_', 'NAVL1_', 'TECS_', 'TRIM_', 'KFF_', 'RTL_',
                   'LAND_', 'FLAP_', 'ATC_', 'PSC_', 'ACRO_', 'PILOT_', 'MOT_', 'LOIT_', 'WPNAV_', 'Q_', 'STAB_', 'GLIDE_', 'MIXING_', 'ANGLE_',
                   'SIM_BATT_', 'FLTMODE', 'CRUISE_', 'MIN_', 'SCALING_', 'STALL_', 'TKOFF_')
PARAM_AD_IZIN = frozenset({'ANGLE_MAX', 'SCALING_SPEED', 'STAB_PITCH_DOWN', 'FBWB_ELEV_REV', 'FBWB_CLIMB_RATE', 'ALT_HOLD_RTL', 'GROUND_STEER_ALT',
                           'TRIM_THROTTLE', 'CRUISE_ALT_FLOOR', 'MIN_GROUNDSPEED', 'STALL_PREVENTION'})
PARAM_YASAK_ONEK = ('SERIAL', 'LOG_', 'SYSID', 'BRD_', 'SCR_', 'NET_', 'SR0_', 'SR1_', 'SR2_', 'SR3_', 'MAV', 'FENCE_', 'GPS', 'INS_', 'COMPASS_',
                    'AHRS_', 'EK2_', 'EK3_', 'FS_', 'ARMING_', 'RC', 'CAN_', 'BATT', 'DEV_', 'STAT_', 'FORMAT_', 'MIS_', 'RALLY_', 'TERRAIN_', 'SIM_WIND',
                    'SIM_GPS', 'SIM_RC', 'SIM_SPEEDUP', 'FLTMODE_CH')
PARAM_MAX = 60
PARAM_DEGER = (-1e6, 1e6)


class BridgeHata(Exception):
    def __init__(self, status, error, message, **extra):
        super().__init__(message)
        self.status, self.error, self.message, self.extra = status, error, message, extra


def params_dogrula(p):
    """{AD: değer} → sayısal, beyaz listeli, ≤ 60 girdi. Hatalı → BridgeHata(422, 'param_rejected')."""
    if p is None:
        return {}
    if not isinstance(p, dict):
        raise BridgeHata(422, 'param_rejected', 'params bir nesne olmalı')
    if len(p) > PARAM_MAX:
        raise BridgeHata(422, 'param_rejected', f'En çok {PARAM_MAX} parametre')
    out = {}
    for k, v in p.items():
        ad = str(k or '').strip().upper()
        if not PARAM_AD.match(ad) or ad.startswith(PARAM_YASAK_ONEK):
            raise BridgeHata(422, 'param_rejected', f'Parametre izinli listede değil: {ad[:20]}', name=ad[:20])
        if not (ad in PARAM_AD_IZIN or ad.startswith(PARAM_ONEK_IZIN)):
            raise BridgeHata(422, 'param_rejected', f'Parametre izinli listede değil: {ad}', name=ad)
        if isinstance(v, bool) or not isinstance(v, (int, float)) or v != v or not (PARAM_DEGER[0] <= v <= PARAM_DEGER[1]):
            raise BridgeHata(422, 'param_rejected', f'{ad} sayısal ve {PARAM_DEGER[0]:g}…{PARAM_DEGER[1]:g} aralığında olmalı', name=ad)
        out[ad] = float(v)
    return out


# ---- hangar kataloğu (§4 /hangar/catalog) ----
# Interceptor: ArduPlane 4.6+ adları (AIRSPEED_* — eski ARSPD_FBW_*); 170 m/s ≈ 612 km/h, tam gaz, sert açı sınırları, hızlı oran döngüleri.
INTERCEPTOR_PARAMS = {'AIRSPEED_MAX': 170, 'AIRSPEED_MIN': 24, 'AIRSPEED_CRUISE': 95, 'THR_MAX': 100, 'THR_MIN': 0, 'THR_SLEWRATE': 0, 'TKOFF_THR_MAX': 100,
                      'TKOFF_THR_MINSPD': 0, 'TKOFF_ROTATE_SPD': 22, 'LIM_ROLL_CD': 7500, 'LIM_PITCH_MAX': 5000, 'LIM_PITCH_MIN': -3500, 'NAVL1_PERIOD': 11,
                      'NAVL1_DAMPING': 0.8, 'PTCH_RATE_P': 0.35, 'PTCH_RATE_I': 0.25, 'PTCH_RATE_D': 0.01, 'PTCH_RATE_FF': 0.5, 'RLL_RATE_P': 0.3,
                      'RLL_RATE_I': 0.2, 'RLL_RATE_FF': 0.45, 'YAW_RATE_ENABLE': 1, 'TECS_CLMB_MAX': 30, 'TECS_SINK_MAX': 20, 'TECS_SINK_MIN': 4,
                      'TECS_PITCH_MAX': 45, 'TECS_PITCH_MIN': -30, 'SCALING_SPEED': 60, 'STALL_PREVENTION': 1, 'TRIM_THROTTLE': 70, 'KFF_RDDRMIX': 0.3,
                      'ACRO_ROLL_RATE': 360, 'ACRO_PITCH_RATE': 240}
QUAD250_PARAMS = {'ATC_RAT_RLL_P': 0.18, 'ATC_RAT_PIT_P': 0.18, 'ATC_RAT_YAW_P': 0.25, 'ATC_ACCEL_R_MAX': 220000, 'ATC_ACCEL_P_MAX': 220000,
                  'ATC_ACCEL_Y_MAX': 60000, 'ANGLE_MAX': 6500, 'PILOT_SPEED_UP': 800, 'PILOT_SPEED_DN': 600, 'WPNAV_SPEED': 2500, 'WPNAV_ACCEL': 500,
                  'LOIT_SPEED': 2500, 'MOT_THST_EXPO': 0.7, 'ACRO_RP_RATE': 540, 'ACRO_Y_RATE': 360, 'SIM_BATT_VOLTAGE': 16.8, 'SIM_BATT_CAP_AH': 1.5}
PROC_MODELS = {
    'proc:quad250': {'key': 'proc:quad250', 'label': 'FPV Quad 250', 'type': 'fpv', 'proc': True, 'glb': None, 'thumb': None, 'defaults': QUAD250_PARAMS,
                     'desc': '5" FPV yarış quad (250 mm, 4S); akro/hız ağırlıklı oran döngüleri', 'core_model': 'builtin:quad'},
    'proc:interceptor': {'key': 'proc:interceptor', 'label': 'Interceptor (delta kanat)', 'type': 'interceptor', 'proc': True, 'glb': None, 'thumb': None,
                         'defaults': INTERCEPTOR_PARAMS, 'desc': 'Yüksek hızlı önleyici delta kanat: 170 m/s (~610 km/h), tam gaz, sert manevra',
                         'core_model': 'builtin:delta'},
}
TYPE_LABELS = {'multirotor': 'Multikopter', 'fpv': 'FPV', 'plane': 'Sabit kanat', 'interceptor': 'Interceptor', 'heli': 'Helikopter', 'vtol': 'VTOL'}


def katalog():
    """{types:[{key,label,models:[{key,label,glb,thumb,defaults,proc,desc}]}]} — flightsim_models dahili modeller + prosedürel şablonlar."""
    out = []
    for t in TYPES:
        models = []
        ctip = TIP_ESLEME[t]
        for key, b in flightsim_models.BUILTIN.items():
            if ctip in b['types'] and t not in ('fpv', 'interceptor'):
                m = flightsim_models.builtin_api(key, ctip)
                models.append({'key': m['id'], 'label': m['name'], 'glb': m['glb_url'], 'thumb': None, 'defaults': {}, 'proc': m['format'] != 'glb',
                               'desc': m.get('desc')})
        for pm in PROC_MODELS.values():
            if pm['type'] == t:
                models.append({k: pm[k] for k in ('key', 'label', 'glb', 'thumb', 'defaults', 'proc', 'desc')})
        out.append({'key': t, 'label': TYPE_LABELS[t], 'models': models})
    return {'types': out}


def model_gecerli(tip, model_key):
    """Katalogda bu tip için var mı."""
    return any(m['key'] == model_key for t in katalog()['types'] if t['key'] == tip for m in t['models'])


def _core_model_id(model_key):
    return MODEL_ESLEME.get(model_key, model_key)


# ---- durum ----
_AKTIF = {}          # flight_id → {'sim_id', 'user_id', 'mp', 'task'}
_KILIT = asyncio.Lock()


def aktif_ucus(user_id):
    for fid, a in _AKTIF.items():
        if a['user_id'] == user_id:
            return fid, a
    return None, None


def aktif_sayisi():
    return flightsim.MANAGER.acik_sayisi()


def bekleme_suresi():
    """Dolu sunucuda tahmini bekleme (sn): en eski açık oturumun kalan süresi."""
    en = None
    for s in flightsim.MANAGER.sessions.values():
        if s.state != 'KAPANDI':
            kalan = max(0, config.FLIGHT_MINUTES * 60 - (time.time() - s.started))
            en = kalan if en is None else min(en, kalan)
    return int(en or 0)


def host_adi(request=None):
    if config.PUBLIC_HOST:
        return config.PUBLIC_HOST
    if request is not None:
        h = (request.headers.get('x-forwarded-host') or request.headers.get('host') or '').split(',')[0].strip()
        return h.rsplit(':', 1)[0] if h.count(':') == 1 else h
    return None


# ---- MP TCP köprüsü ----
class MpKopru:
    """Uçuş başına TCP dinleyici: ilk bağlanan IP kilidi, tek bağlantı, UDP (127.0.0.1:<SimSession.udp_port>) ile ham köprü."""

    def __init__(self, sim, port):
        self.sim, self.port = sim, port
        self.server = None
        self.lock_ip = None
        self.client = None       # (reader, writer)
        self.udp = None          # DatagramTransport
        self.opened = time.time()
        self.last_rx = None
        self.rejected = 0
        self.bytes_in = self.bytes_out = 0
        self._idle_task = None
        self._closed = False

    async def ac(self):
        self.server = await asyncio.start_server(self._istemci, '0.0.0.0', self.port, backlog=4)
        self._idle_task = asyncio.get_running_loop().create_task(self._bosta())

    def durum(self):
        return {'port': self.port, 'proto': 'tcp', 'locked_ip': self.lock_ip, 'connected': self.client is not None, 'rejected': self.rejected,
                'bytes_in': self.bytes_in, 'bytes_out': self.bytes_out, 'open': not self._closed}

    async def _bosta(self):
        try:
            await asyncio.sleep(config.MP_IDLE_S)
            if self.client is None and self.lock_ip is None:
                await self.kapat('bosta')
        except asyncio.CancelledError:
            pass

    async def _istemci(self, reader, writer):
        peer = writer.get_extra_info('peername') or ('?', 0)
        ip = peer[0]
        if self._closed or (self.lock_ip is not None and ip != self.lock_ip) or self.client is not None:
            self.rejected += 1
            db.audit_bagimsiz('mp_reject', None, ip, f'port {self.port} kilit {self.lock_ip}')
            writer.close()
            return
        self.lock_ip = ip
        self.client = (reader, writer)
        if self._idle_task is not None:
            self._idle_task.cancel()
        try:
            await self._udp_ac()
            while True:
                data = await reader.read(4096)
                if not data:
                    break
                self.bytes_in += len(data)
                self.last_rx = time.time()
                if self.udp is not None and not self.udp.is_closing():
                    self.udp.sendto(data)
        except (asyncio.CancelledError, OSError, ConnectionError):
            pass
        finally:
            self.client = None
            try:
                writer.close()
            except Exception:   # noqa: BLE001
                pass
            if self.udp is not None:
                self.udp.close()
                self.udp = None

    async def _udp_ac(self):
        if self.sim.udp_port is None:
            return
        loop = asyncio.get_running_loop()
        kopru = self

        class _P(asyncio.DatagramProtocol):
            def datagram_received(self, data, addr):
                c = kopru.client
                if c is not None and not c[1].is_closing():
                    kopru.bytes_out += len(data)
                    c[1].write(data)

            def error_received(self, exc):
                pass
        self.udp, _ = await loop.create_datagram_endpoint(_P, remote_addr=('127.0.0.1', self.sim.udp_port))

    async def kapat(self, reason='kapatildi'):
        if self._closed:
            return
        self._closed = True
        if self._idle_task is not None:
            self._idle_task.cancel()
        if self.server is not None:
            self.server.close()
            try:
                await asyncio.wait_for(self.server.wait_closed(), 2)
            except (asyncio.TimeoutError, Exception):   # noqa: BLE001
                pass
        if self.client is not None:
            try:
                self.client[1].close()
            except Exception:   # noqa: BLE001
                pass
        if self.udp is not None:
            self.udp.close()
            self.udp = None


def _port_bos(p):
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        s.bind(('0.0.0.0', p))
        return True
    except OSError:
        return False
    finally:
        s.close()


def bos_mp_port():
    kullanilan = {a['mp'].port for a in _AKTIF.values() if a.get('mp')}
    for _ in range(60):
        p = config.MP_PORT_BASE + secrets.randbelow(config.MP_PORT_COUNT)
        if p not in kullanilan and _port_bos(p):
            return p
    return None


# ---- uçuş başlat / durdur ----
HAND_DEFAULTS = {'hand_speed_ms': 7.0, 'hand_pitch_deg': 12.0}


def launch_dogrula(l):
    """fly/start `launch`: {method, angle_deg 10–30, release_kmh 40–110, hand_speed_ms 6–8, hand_pitch_deg 10–15}; dize ise yalnız yöntem."""
    if isinstance(l, str) or l is None:
        l = {'method': l or 'wheels'}
    if not isinstance(l, dict):
        raise BridgeHata(422, 'invalid', 'launch nesne ya da yöntem adı olmalı')
    m = l.get('method') or 'wheels'
    if m not in LAUNCHES:
        raise BridgeHata(422, 'invalid', 'launch.method wheels | ramp | vehicle | hand olmalı')
    out = {'method': m}
    for k, (alt, ust, vars_) in {'angle_deg': (10, 30, 15.0), 'release_kmh': (40, 110, 70.0), 'hand_speed_ms': (6, 8, 7.0), 'hand_pitch_deg': (10, 15, 12.0)}.items():
        v = l.get(k)
        if v is None:
            out[k] = vars_
            continue
        if isinstance(v, bool) or not isinstance(v, (int, float)) or not (alt <= v <= ust):
            raise BridgeHata(422, 'invalid', f'launch.{k} {alt}…{ust} olmalı')
        out[k] = float(v)
    return out


def elden_atis_ayarla(s, params):
    """WS cmd takeoff{launch:'hand', hand_speed_ms, hand_pitch_deg}: çekirdeğin kalkış dizisi 'ramp' (mancınık) kalıbıyla koşar; elden atış için
    düşük ivme/kısa fırlatma — SITL'de TKOFF_THR_MINACC düşürülür, seviye pitch'i el açısına eşitlenir (HEPGO dosyasına dokunulmaz; parametreler PARAM_SET)."""
    try:
        hiz = float(params.get('hand_speed_ms') or HAND_DEFAULTS['hand_speed_ms'])
        aci = float(params.get('hand_pitch_deg') or HAND_DEFAULTS['hand_pitch_deg'])
    except (TypeError, ValueError):
        hiz, aci = HAND_DEFAULTS['hand_speed_ms'], HAND_DEFAULTS['hand_pitch_deg']
    hiz, aci = max(6.0, min(8.0, hiz)), max(10.0, min(15.0, aci))
    s.launch = {**(s.launch or {}), 'method': 'ramp', 'angle_deg': aci, 'hand': True, 'hand_speed_ms': hiz, 'hand_pitch_deg': aci}
    if s.sahte is None and getattr(s, '_heartbeat_alindi', False):
        try:   # elden atış: ivme eşiği düşük (kol hareketi ~4 m/s²), 1 sn gaz gecikmesi, el açısı
            s._param_set((('TKOFF_THR_MINACC', 4.0), ('TKOFF_THR_DELAY', 1.0), ('TKOFF_LVL_PITCH', aci), ('TKOFF_THR_MINSPD', 0.0), ('TKOFF_ROTATE_SPD', 0.0)))
        except Exception:   # noqa: BLE001
            pass


def _world(track, drone_type, launch):
    w = db.j(track.get('wind')) if isinstance(track.get('wind'), str) else (track.get('wind') or {})
    tw = db.j(track.get('world')) if isinstance(track.get('world'), str) else (track.get('world') or {})
    mode = track.get('world_mode') or 'google3d'
    if mode == 'google3d' and not flightsim.google3d_etkin():
        mode = 'real'   # anahtar yoksa gerçek arazi
    if mode not in WORLD_MODES:
        mode = 'real'
    out = {'mode': mode, 'size_m': int(max(500, min(20000, (track.get('radius_m') or 2000) * 2))), 'time': TIME_CEKIRDEK.get(track.get('time_of_day'), 'day'),
           'wind_ms': float(max(0, min(30, w.get('speed_ms') or 0))), 'wind_dir': float(max(0, min(359.99, w.get('dir_deg') or 0))),
           'fog': FOG.get(track.get('weather'), 0.1), 'runway': drone_type in ('plane', 'interceptor') and launch.get('method') != 'hand',
           'launch': {'method': LAUNCH_CEKIRDEK.get(launch.get('method'), 'wheels'), 'angle_deg': launch.get('angle_deg', 15.0), 'release_kmh': launch.get('release_kmh', 70.0)}}
    out.update({k: tw[k] for k in WORLD_KEYS if k in tw and tw[k] is not None})   # parkurun dünya ayarları (seed, pist yönü, ağaç yoğunluğu …)
    if launch.get('method') == 'hand':
        out['launch'].update(angle_deg=launch.get('hand_pitch_deg', 12.0), release_kmh=40)
    return out


async def ucus_baslat(user, pilot, drone, track, mission, launch, record, request=None):
    """Kotalar → çekirdek oturum → flights satırı → MP köprüsü. Dönüş: {flight_id, sim_id, mp, ws}. Hatalar BridgeHata."""
    launch = launch_dogrula(launch)
    if drone['type'] not in TIP_ESLEME:
        raise BridgeHata(422, 'invalid', 'Dron tipi geçersiz')
    params = params_dogrula(db.j(drone.get('params')))
    async with _KILIT:
        fid, _a = aktif_ucus(user['id'])
        if fid is not None:
            raise BridgeHata(409, 'flight_active', 'Zaten süren bir uçuşunuz var; önce onu bitirin', flight_id=fid)
        if aktif_sayisi() >= config.MAX_FLIGHTS:
            raise BridgeHata(429, 'server_full', 'Sunucudaki tüm simülasyon yuvaları dolu — bekleme odası', retry_after=bekleme_suresi() or 60)
        port = bos_mp_port()
        if port is None:
            raise BridgeHata(503, 'no_port', 'Boş Mission Planner portu yok')
        ctip = TIP_ESLEME[drone['type']]
        loop = asyncio.get_running_loop()

        def hazirla():
            with core_db.connect() as conn:
                mdl = flightsim_models.coz(conn, ctip, {'id': _core_model_id(drone['model_key'])})
            # Kullanıcının parametreleri çekirdeğin kalıcı parametre tablosuna (SITL defaults + ilk kalp atışında PARAM_SET); dron id'si tekil
            # drone_params.kaydet TKOFF_* gibi oturum adlarını hariç tutar; SIMUMAV beyaz listesi geçerli → doğrudan yazılır (aynı tablo, çekirdek yukle() okur)
            with core_db.connect() as conn:
                conn.execute('DELETE FROM drone_sitl_params WHERE drone_id = ?', (int(drone['id']),))
                conn.executemany('INSERT INTO drone_sitl_params (drone_id, name, value, ptype, updated_at, updated_by, source) VALUES (?,?,?,?,?,?,?)',
                                 [(int(drone['id']), ad, float(deger), 9, core_db.now(), user['id'], 'hepgo') for ad, deger in params.items()])
                conn.commit()
            return mdl
        try:
            mdl = await loop.run_in_executor(None, hazirla)
        except flightsim.SimHata as e:
            raise BridgeHata(422, 'invalid', str(e))
        center = {'id': track['id'], 'name': track['name'], 'lat': float(track['lat']), 'lon': float(track['lon']), 'alt': None}
        world = _world(track, drone['type'], launch)
        owner = {'id': user['id'], 'name': user['display_name']}
        core_drone = {'id': drone['id'], 'code': drone['name'], 'name': drone['name'], 'model': drone['model_key'], 'protocol': 'sanal'}
        try:
            s = await flightsim.MANAGER.ac(ctip, center, world, owner, None, mdl, core_drone, {'bin': bool((record or {}).get('bin', True))})
        except flightsim.SimHata as e:
            kod = {'invalid': 422, 'limit': 429, 'sitl': 503}.get(e.kod, 400)
            raise BridgeHata(kod, e.kod, str(e))
        t = db.now()
        snap = {'drone': {'id': drone['id'], 'name': drone['name'], 'type': drone['type'], 'model_key': drone['model_key'], 'color': drone.get('color')},
                'pilot': {'id': pilot['id'], 'name': pilot['name'], 'character': pilot['character']},
                'track': {'id': track['id'], 'name': track['name'], 'lat': track['lat'], 'lon': track['lon'], 'radius_m': track.get('radius_m'), 'world_mode': track.get('world_mode'),
                          'world': db.j(track.get('world')) if isinstance(track.get('world'), str) else (track.get('world') or {}),
                          'gates': db.j(track.get('gates'), []) if isinstance(track.get('gates'), str) else list(track.get('gates') or []),
                          'wind': db.j(track.get('wind')) if isinstance(track.get('wind'), str) else (track.get('wind') or {}), 'time_of_day': track.get('time_of_day'), 'weather': track.get('weather')},
                'mission': {'id': mission['id'], 'name': mission['name'], 'kind': mission['kind'], 'plan': db.j(mission.get('plan'))} if mission else None,
                'launch': launch, 'record': {'bin': bool((record or {}).get('bin', True)), 'video': bool((record or {}).get('video'))}}
        with db.connect() as conn:
            fid = conn.execute('INSERT INTO flights (user_id, pilot_id, drone_id, track_id, mission_id, launch, started_at, mp_port, snapshot, created_at, updated_at) '
                               'VALUES (?,?,?,?,?,?,?,?,?,?,?)', (user['id'], pilot['id'], drone['id'], track['id'], mission['id'] if mission else None, launch['method'],
                                                                  s.created_at, port, json.dumps(snap, ensure_ascii=False), t, t)).lastrowid
            conn.execute('INSERT INTO sim_runs_link (flight_id, sim_id) VALUES (?,?)', (fid, s.id))
            db.audit(conn, 'fly_start', user['id'], request and _ip(request), f'flight {fid} sim {s.id} {drone["type"]} {track["name"]} {launch["method"]} mp {port}')
            conn.commit()
        mp = MpKopru(s, port)
        try:
            await mp.ac()
        except OSError:
            mp = None
        s.sm_gates = db.j(track.get('gates'), []) if isinstance(track.get('gates'), str) else list(track.get('gates') or [])   # FPV halkaları (WS hello + durum)
        s.sm_flight_id = fid
        if launch['method'] == 'hand':
            s.launch = {**s.launch, 'hand': True, 'hand_speed_ms': launch['hand_speed_ms'], 'hand_pitch_deg': launch['hand_pitch_deg']}
        a = {'sim_id': s.id, 'user_id': user['id'], 'mp': mp, 'task': None, 'started': time.time(), 'mission': mission, 'gates_result': None}
        _AKTIF[fid] = a
        a['task'] = loop.create_task(_izle(fid, s, mp))
    if mission and mission.get('plan'):
        loop.create_task(_gorev_yukle(s, mission))
    return {'flight_id': fid, 'sim_id': s.id, 'mp': {'host': host_adi(request), 'port': port, 'proto': 'tcp'} if mp else None,
            'ws': f'/ws/fly/{s.id}', 'state': s.state}


def _ip(request):
    from .auth import client_ip
    return client_ip(request)


def plan_items(plan):
    """Görev planı → HEPGO/MAVLink öğe listesi [{seq, command, frame, current, autocontinue, param1..4, x(lat·1e7), y(lon·1e7), z}].
    plan.items varsa olduğu gibi; editörün `route.points` ({seq, cmd, lat, lon, alt_rel, frame}) biçimi çevrilir."""
    if not isinstance(plan, dict):
        return []
    items = plan.get('items')
    if isinstance(items, list) and items:
        return items
    route = plan.get('route')
    pts = route.get('points') if isinstance(route, dict) else (route or [])
    out = []
    for i, p in enumerate(pts or []):
        if not isinstance(p, dict):
            continue
        if 'command' in p and ('x' in p or 'y' in p):
            out.append(p)
            continue
        try:
            lat, lon = float(p.get('lat') or 0), float(p.get('lon') or 0)
            z = float((p.get('alt_rel') if p.get('alt_rel') is not None else p.get('alt', p.get('z'))) or 0)
            cmd = int(p.get('cmd') or p.get('command') or 16)
            frame = int(p.get('frame', 3) or 3)
        except (TypeError, ValueError):
            continue
        out.append({'seq': int(p.get('seq', i) or 0), 'command': cmd, 'frame': frame, 'current': 0, 'autocontinue': 1,
                    'param1': float(p.get('param1') or 0), 'param2': float(p.get('param2') or 0), 'param3': float(p.get('param3') or 0), 'param4': float(p.get('param4') or 0),
                    'x': int(round(lat * 1e7)), 'y': int(round(lon * 1e7)), 'z': z})
    return out


async def _gorev_yukle(s, mission):
    """Görev planı (HEPGO `route`/items biçimi) SITL hazır olunca hub komutuyla yüklenir; hata uçuşu düşürmez."""
    plan = db.j(mission.get('plan')) if isinstance(mission.get('plan'), str) else (mission.get('plan') or {})
    items = plan_items(plan)
    if not items:
        return
    for _ in range(90):
        if s.state == 'HAZIR' and (s.sahte is not None or s._heartbeat_alindi):
            break
        if s.state in ('KAPANDI', 'HATA'):
            return
        await asyncio.sleep(1.0)
    try:
        await s.hub_komut('mission_upload', {'items': items})
    except Exception:   # noqa: BLE001
        pass


async def _izle(fid, s, mp):
    """Çekirdek oturum görevi bitince flights satırını tamamla, MP köprüsünü kapat, kota uygula."""
    try:
        if s.task is not None:
            try:
                await s.task
            except (asyncio.CancelledError, Exception):   # noqa: BLE001
                pass
    finally:
        if mp is not None:
            await mp.kapat('ucus_bitti')
        try:
            await asyncio.get_running_loop().run_in_executor(None, _ucus_kapanis, fid, s)
        except Exception:   # noqa: BLE001
            pass
        _AKTIF.pop(fid, None)


def _sonuc(s, run):
    if run and run.get('result') == 'carpisma':
        return 'crash'
    if run and run.get('result') == 'hata':
        return 'abort'
    if (s.end_reason or '') in ('kapatildi', 'sure', 'bosta') and not (s.sitl or {}).get('error'):
        return 'ok'
    if getattr(s, 'gorev', None) is not None and s.gorev.crashes:
        return 'crash'
    return 'ok' if not (s.sitl or {}).get('error') else 'abort'


def _ucus_kapanis(fid, s):
    run = None
    bin_rel = params_rel = None
    log_id = (s.bin_sonuc or {}).get('log_id') if isinstance(s.bin_sonuc, dict) else None
    rid = (s.run_sonuc or {}).get('id') if isinstance(s.run_sonuc, dict) else None
    with core_db.connect() as cc:
        if rid:
            run = core_db.row(cc.execute('SELECT * FROM drone_sim_runs WHERE id = ?', (rid,)))
            if run and run.get('params_path'):
                params_rel = run['params_path']
        if log_id:
            lg = core_db.row(cc.execute('SELECT file FROM flight_logs WHERE id = ?', (log_id,)))
            if lg and lg.get('file') and '..' not in lg['file']:
                bin_rel = f"uploads/{lg['file']}"
    ozet = None
    try:
        g = getattr(s, 'gorev', None)
        ozet = getattr(g, '_son_ozet', None) or (g.ozet() if g is not None and (g.track or g.crashes) else None)
    except Exception:   # noqa: BLE001
        ozet = None
    gr = getattr(s, 'sm_gates_result', None)
    if gr is not None:
        ozet = dict(ozet or {'v': 1})
        ozet['gates'] = gr
    t = db.now()
    sure = int(time.time() - s.started)
    with db.connect() as conn:
        f = db.row(conn.execute('SELECT * FROM flights WHERE id = ?', (fid,)))
        if not f:
            return
        conn.execute('UPDATE flights SET ended_at = ?, duration_s = ?, result = ?, summary = ?, bin_path = ?, params_path = ?, core_log_id = ?, core_run_id = ?, updated_at = ? WHERE id = ?',
                     (t, sure, _sonuc(s, run), json.dumps(ozet, ensure_ascii=False, default=str) if ozet else None, bin_rel, params_rel, log_id, rid, t, fid))
        conn.execute('DELETE FROM sim_runs_link WHERE flight_id = ?', (fid,))
        if f.get('pilot_id'):
            conn.execute('UPDATE pilots SET flights = flights + 1, hours = hours + ? WHERE id = ?', (sure / 3600.0, f['pilot_id']))
        db.audit(conn, 'fly_stop', f['user_id'], None, f'flight {fid} {sure}s {s.end_reason}')
        kota_uygula(conn, f['user_id'])
        conn.commit()
    _profil_ozeti(f['user_id'])


def _profil_ozeti(user_id):
    """Hesap servisine özet (pilot adı, toplam uçuş/saat) — arka plan; hata yutulur."""
    try:
        with db.connect() as conn:
            u = db.row(conn.execute('SELECT * FROM users WHERE id = ?', (user_id,)))
            p = db.row(conn.execute('SELECT name, flights, hours FROM pilots WHERE user_id = ? ORDER BY is_default DESC, id LIMIT 1', (user_id,)))
            n = conn.execute('SELECT COUNT(*), COALESCE(SUM(duration_s), 0) FROM flights WHERE user_id = ? AND ended_at IS NOT NULL', (user_id,)).fetchone()
        if u and u['mt_user_id'] > 0:
            from .auth import profil_yaz
            profil_yaz(u['mt_user_id'], {'pilot': p['name'] if p else u['display_name'], 'flights': int(n[0]), 'hours': round(n[1] / 3600.0, 2), 'updated_at': db.now()})
    except Exception:   # noqa: BLE001
        pass


def dosya_yolu(rel):
    """core/ altı göreli yol → mutlak; kök dışına çıkış reddi (None)."""
    if not rel or rel.startswith('/') or '..' in rel.split('/'):
        return None
    p = (core_config.DATA_DIR / rel).resolve()
    try:
        p.relative_to(core_config.DATA_DIR.resolve())
    except ValueError:
        return None
    return p if p.is_file() else None


def ucus_dosyalarini_sil(f):
    for rel in (f.get('bin_path'), f.get('params_path'), f.get('replay_cache')):
        p = dosya_yolu(rel)
        if p:
            try:
                p.unlink()
            except OSError:
                pass
    if f.get('core_log_id'):
        try:
            with core_db.connect() as cc:
                cc.execute('DELETE FROM flight_logs WHERE id = ?', (f['core_log_id'],))
                cc.commit()
        except Exception:   # noqa: BLE001
            pass


def kota_uygula(conn, user_id):
    """Saklanan uçuş ≤ 100 (en eskisi silinir) ve disk kotası ≤ 1 GB (en eski dosyalı uçuşlar silinir)."""
    eski = db.rows(conn.execute('SELECT * FROM flights WHERE user_id = ? AND ended_at IS NOT NULL ORDER BY started_at DESC LIMIT -1 OFFSET ?',
                                (user_id, config.QUOTA['flights'])))
    for f in eski:
        ucus_dosyalarini_sil(f)
        conn.execute('DELETE FROM flights WHERE id = ?', (f['id'],))
        db.audit(conn, 'quota', user_id, None, f'flight {f["id"]} silindi (saklanan uçuş > {config.QUOTA["flights"]})')
    while disk_kullanimi(conn, user_id) > config.QUOTA['disk_bytes']:
        f = db.row(conn.execute('SELECT * FROM flights WHERE user_id = ? AND ended_at IS NOT NULL AND (bin_path IS NOT NULL OR replay_cache IS NOT NULL) '
                                'ORDER BY started_at ASC LIMIT 1', (user_id,)))
        if not f:
            break
        ucus_dosyalarini_sil(f)
        conn.execute('UPDATE flights SET bin_path = NULL, replay_cache = NULL, core_log_id = NULL WHERE id = ?', (f['id'],))
        db.audit(conn, 'quota', user_id, None, f'flight {f["id"]} dosyaları silindi (disk > 1 GB)')


def disk_kullanimi(conn, user_id):
    top = 0
    for f in db.rows(conn.execute('SELECT bin_path, params_path, replay_cache, video_path FROM flights WHERE user_id = ?', (user_id,))):
        for rel in f.values():
            p = dosya_yolu(rel)
            if p:
                try:
                    top += p.stat().st_size
                except OSError:
                    pass
    return top


def gates_sonuc_dogrula(g):
    """POST /fly/{id}/stop {gates:{passed, missed, best_lap_s, laps}} — Uç modülünün halka geçiş sayımı (sunucu doğrulamaz; sayısal/aralık denetimi)."""
    if g is None:
        return None
    if not isinstance(g, dict):
        raise BridgeHata(422, 'invalid', 'gates bir nesne olmalı')
    out = {}
    for k, ust in (('passed', 100000), ('missed', 100000), ('laps', 10)):
        v = g.get(k, 0)
        if isinstance(v, bool) or not isinstance(v, (int, float)) or not (0 <= v <= ust):
            raise BridgeHata(422, 'invalid', f'gates.{k} 0…{ust} olmalı')
        out[k] = int(v)
    b = g.get('best_lap_s')
    if b is not None and (isinstance(b, bool) or not isinstance(b, (int, float)) or not (0 <= b <= 36000)):
        raise BridgeHata(422, 'invalid', 'gates.best_lap_s 0…36000 olmalı')
    out['best_lap_s'] = round(float(b), 2) if b is not None else None
    return out


async def ucus_durdur(fid, reason='kapatildi', gates=None):
    a = _AKTIF.get(fid)
    if not a:
        return False
    s = flightsim.MANAGER.sessions.get(a['sim_id'])
    if s is not None and gates is not None:
        s.sm_gates_result = gates
    await flightsim.MANAGER.kapat(a['sim_id'], reason)
    t = a.get('task')
    if t is not None:
        try:
            await asyncio.wait_for(asyncio.shield(t), 35)
        except (asyncio.TimeoutError, Exception):   # noqa: BLE001
            pass
    return True


def ucus_durumu(fid):
    a = _AKTIF.get(fid)
    if not a:
        return None
    s = flightsim.MANAGER.sessions.get(a['sim_id'])
    return {'sim_id': a['sim_id'], 'state': s.state if s else 'KAPANDI', 'gates': list(getattr(s, 'sm_gates', []) or []) if s else [], 'elapsed_s': int(time.time() - a['started']),
            'remaining_s': max(0, config.FLIGHT_MINUTES * 60 - int(time.time() - a['started'])),
            'mp': a['mp'].durum() if a.get('mp') else None, 'sitl': dict(s.sitl) if s else None, 'tele': dict(s.tele) if s else None}


def oturum(sim_id):
    return flightsim.MANAGER.get(sim_id)


def oturum_sahibi(sim_id, user_id):
    s = flightsim.MANAGER.get(sim_id)
    return s if s is not None and (s.owner or {}).get('id') == user_id else None


# ---- ops replay ----
async def replay_hazirla(flight):
    """.bin → flightsim_replay önbelleği (alt süreç). Dönüş: (gz_path, meta). Hata → BridgeHata."""
    p = dosya_yolu(flight.get('bin_path'))
    if not p or not flight.get('core_log_id'):
        raise BridgeHata(404, 'no_bin', 'Bu uçuşun .bin kaydı yok (armed süre olmadı ya da kayıt kapalıydı)')
    log_id = int(flight['core_log_id'])
    gz = flightsim_replay.onbellek_yolu(log_id)
    try:
        meta = await _replay_async(log_id, str(p))
    except ValueError as e:
        raise BridgeHata(422, 'replay_failed', f'Kayıt çözümlenemedi: {str(e)[:120]}')
    rel = str(Path('sim_replay') / gz.name)
    with db.connect() as conn:
        conn.execute('UPDATE flights SET replay_cache = ?, updated_at = ? WHERE id = ?', (rel, db.now(), flight['id']))
        conn.commit()
    return gz, meta


async def _replay_async(log_id, path):
    """flightsim_replay.hazirla_async kalıbı; alt süreç `python -m app.simumav.replay_worker` (SIMUMAV deposunda app.config yok → shim kurulur)."""
    import sys
    proc = await asyncio.create_subprocess_exec(sys.executable, '-m', 'app.simumav.replay_worker', str(int(log_id)), str(path),
                                                stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL, cwd=str(config.BASE_DIR))
    meta, hata = None, None
    try:
        while True:
            satir = await proc.stdout.readline()
            if not satir:
                break
            s = satir.decode('utf-8', 'replace').rstrip('\n')
            if s.startswith('OK '):
                meta = json.loads(s[3:])
            elif s.startswith('ERR '):
                hata = s[4:]
        await proc.wait()
    except asyncio.CancelledError:
        try:
            proc.kill()
        except ProcessLookupError:
            pass
        raise
    if meta is None:
        raise ValueError(hata or f'Log ayrıştırma süreci başarısız (çıkış {proc.returncode})')
    return meta


async def hepsini_kapat():
    for fid in list(_AKTIF):
        try:
            await ucus_durdur(fid, 'sunucu_kapaniyor')
        except Exception:   # noqa: BLE001
            pass
    await flightsim.MANAGER.kapat_hepsi()


def cekirdek_baslat():
    """Çekirdek veritabanı (core.db) şeması + önceki süreçten kalan SITL artıkları."""
    core_db.init()
    if config.SITL_ENABLED:
        try:
            drone_sitl.YONETICI.artiklari_temizle()
        except Exception:   # noqa: BLE001
            pass
    os.makedirs(core_config.DATA_DIR / 'uploads', exist_ok=True)
