"""drone_hub SHIM — HEPGO `app/drone_hub.py`'nin SIMUMAV'da gerekli SAF bölümleri (tools/simumav_export.py HEPGO'ya özgü modülleri kopyalamaz;
`app/simumav/shim.kur()` bu modülü `sys.modules['app.drone_hub']` olarak kaydeder). Kaynak dosyadan birebir alınan bölümler: sabitler, MAVLink
çözümleme yardımcıları, DroneState, Viewer, _broadcast/_bridge_or_sim/_safe_send/all_caps, _feed_mavlink…arm_check_report (konsol/ARM CHECK),
hello_msg, can_read/can_command/_viewer_sender, send_command + bileşik komut akışları (takeoff/mission_*), _dispatch (yalnız sanal/simülatör yolu).
ÇIKARILANLAR: köprü WebSocket'i (/ws/drone/bridge), .bin aktarımı, saha görevi bağlamı (task_live, SimDrone/SitlDrone), /ws/drone/live (SIMUMAV
kendi WS'sini app/simumav/routers/fly.py'de sunar), kalkış kontrol listesi DB kaydı (drone_takeoff_checks → SIMUMAV'da kayıt yok; kontrol_id None).
Yetki: SIMUMAV kullanıcı sözlüğü {'modules':['drone.sim'], 'write_modules':['drone.sim']} ile SimBridge.can_command geçer; can_read False
(field.live yok) → izleyici her zaman sim_only. Bu dosya HEPGO drone_hub.py değişince `tools/simumav_shim_sync.py` yoktur: elle eşitlenir (test:
tests/test_simumav.py "çekirdek importları shim ile yüklenir").
"""
import asyncio
import json
import os
import secrets
import time

from . import db

SIMUMAV_SHIM = True
ws_router = None   # HEPGO: APIRouter; SIMUMAV'da köprü WS yok

PROTO = 1
CAPS = ['console', 'arm_check']   # tarayıcıya bildirilen sunucu yetenekleri (harekât arayüzü HEPGO_OZ bayrakları); set_home/param köprü desteğiyle gelir
CONSOLE_MAX = 200         # Haberleşme konsolu: dron (sysid) başına saklanan satır
PAIR_TTL = 600            # eşleştirme kodu ömrü (sn)
AUTH_TIMEOUT = 15         # ilk mesaj için bekleme
STATUS_HZ = 10            # tarayıcıya en çok durum paketi/sn (sysid başına)
VIEWER_QUEUE = 32         # izleyici kuyruğu (dolunca en eskisi atılır; parametre akışı toplu 'params' paketleriyle gider)
LOG_MAX = 2 * 1024 ** 3   # köprüden gelen .bin üst sınırı
RATE_WINDOW, RATE_MAX = 60, 10
CMD_TIMEOUT = 10
CMD_TIMEOUTS = {'mission_upload': 60, 'mission_download': 60, 'log_list': 60}
# Sunucu-içi bileşik komutlar (GÖKTUNGU dron.py / gorev.py akışı birebir; köprüye v1 set_mode/arm/takeoff olarak gider):
#  takeoff       → [SIMUMAV: SITL kalp atışı beklenir ≤ 45 sn] → set_mode GUIDED → mod teyidi (4 sn) → (ARM değilse) ARM (zorlamasız) →
#                  ARM teyidi (6 sn; reddedilirse pre-arm/EKF beklenip ≤ 45 sn yeniden denenir) → NAV_TAKEOFF. Sabit kanat: TKOFF_ALT → TAKEOFF → ARM (aynı yeniden deneme).
#                  Pilot ayrıca ARM etmez. Akış arka planda yürür; yanıt akış başlayınca döner, adımlar dron konsoluna düşer.
#  mission_start → (ARM değilse) GUIDED → 0,3 sn → ARM → teyit (5 sn) → AUTO → 0,3 sn → MISSION_START (köprü 'mission_start'
#                  yeteneği bildirdiyse). NAV_TAKEOFF gönderilmez: rotanın ilk öğesi TAKEOFF'tur (routes/{id}/mission ekler).
TAKEOFF_ALT = 10.0
GUIDED_CONFIRM_S = 4.0
ARM_CONFIRM_S = 6.0
MISSION_ARM_CONFIRM_S = 5.0
SEQ_CMDS = {'takeoff', 'mission_start', 'mission_pause', 'mission_resume', 'mission_cancel', 'mission_resume_at'}
MOD_TEYIT_SURESI = 2.5     # GÖKTUNGU gorev.py: set_mode sonrası mod adının telemetride görünmesi için bekleme
# GÖKTUNGU dron.py v2.4.33: COMMAND_ACK → konsol. Yalnız kullanıcının tetiklediği komutlar bildirilir.
KOMUT_ADLARI = {22: 'KALKIŞ (TAKEOFF)', 21: 'İNİŞ (LAND)', 20: 'EVE DÖN (RTL)', 400: 'ARM / DISARM', 176: 'MOD DEĞİŞTİRME',
                252: 'İRTİFA DEĞİŞTİRME', 178: 'HIZ DEĞİŞTİRME', 192: 'KONUMA GİT (REPOSITION)', 16: 'NOKTAYA GİT (WAYPOINT)',
                300: 'GÖREVİ BAŞLAT', 241: 'KALİBRASYON', 246: 'YENİDEN BAŞLATMA'}
MAV_RESULT_ADLARI = {0: 'kabul edildi', 1: 'geçici olarak reddedildi (araç şu an bu komutu alamıyor)',
                     2: 'reddedildi (komut veya parametre bu araca uygun değil)', 3: 'desteklenmiyor (uçuş yazılımı bu komutu tanımıyor)',
                     4: 'yürütülemedi (ön koşullar sağlanmadı)', 6: 'iptal edildi'}
# Komut başlangıç satırı "-> aksiyon" (GÖKTUNGU dkonsol) — HEPGO komut adı → GÖKTUNGU aksiyon adı
AKSIYON_ADI = {'arm': 'arm', 'disarm': 'disarm', 'land': 'land', 'rtl': 'rtl', 'set_mode': 'set_mode', 'reboot': 'reboot',
               'takeoff': 'takeoff', 'altitude_change': 'altitude_change', 'kalib_gyro': 'kalib_gyro', 'kalib_baro': 'kalib_baro',
               'kalib_ivme': 'kalib_ivme', 'kalib_level': 'kalib_level', 'kalib_esc': 'kalib_esc', 'kalib_radyo': 'kalib_radyo',
               'kalib_pusula_baslat': 'kalib_pusula_baslat', 'kalib_pusula_kabul': 'kalib_pusula_kabul', 'kalib_pusula_iptal': 'kalib_pusula_iptal'}
_FLOWS = {}         # (bridge_id, sysid) → sürmekte olan kalkış/görev akışı   # öğe başına MISSION_REQUEST_INT turu (telsizde 0,2–1 sn) → uzun rotalar
CMD_NAMES = {'arm', 'disarm', 'set_mode', 'takeoff', 'land', 'rtl', 'goto', 'mission_upload', 'mission_download', 'disconnect', 'arm_check',
             # protokol v1.1 (isteğe bağlı; köprü auth çerçevesinde caps ile bildirir, desteklemiyorsa res.error döner)
             'set_home', 'param_list', 'param_get', 'param_set', 'reboot', 'mission_set_current', 'altitude_change',
             # v1.1 cap 'link': köprünün drona yerel bağlantısını (uçuşun link ayarı) açma/kapama
             'link_open', 'link_close',
             # protokol v1.2 taslağı (docs/dron-kopru-protokolu.md; caps 'bakim' / 'log' bildiren köprüler)
             'kalib_gyro', 'kalib_baro', 'kalib_ivme', 'kalib_level', 'kalib_esc', 'kalib_radyo',
             'kalib_pusula_baslat', 'kalib_pusula_kabul', 'kalib_pusula_iptal', 'motor_test', 'motor_test_dur', 'log_list', 'log_fetch', 'log_erase',
             # sunucu-içi bileşik komut (bkz. SEQ_CMDS); köprü 'mission_start' yeteneği bildirirse MAV_CMD_MISSION_START olarak da gider
             'mission_start', 'mission_clear', 'mission_pause', 'mission_resume', 'mission_cancel', 'mission_resume_at'}
BRIDGE_CAPS = {'set_home', 'param', 'arm_force', 'reboot', 'mission_set_current', 'altitude_change', 'log', 'bakim', 'link', 'mission_start', 'mission_clear'}   # köprünün bildirebileceği yetenekler
OPEN_TASK = ('BASLANGIC', 'GOREVDE')   # sanal dron yalnız açık görevde uçar
# Sanal dron = gerçek ArduPilot SITL süreci (GÖKTUNGU). HEPGO_SITL=0 → eski sunucu içi kinematik simülatör (yalnız testler).
SITL_ENABLED = os.environ.get('HEPGO_SITL', '1') != '0'
SITL_CONNECT_S = 40                     # SITL ayağa kalkıp SERIAL0'ı dinleyene dek bağlanma denemesi (GÖKTUNGU Tuzak D)
SIM_IDLE = 600                          # izleyici kalmayınca sanal dronun durma süresi (sn)

BRIDGES = {}        # bridge_id → Bridge (yalnız canlı bağlantılar)
SIMS = {}           # -drone_id → SimDrone (çalışan sanal dronlar)
VIEWERS = {}        # ws → Viewer
PAIR_CODES = {}     # kod → {'bridge_id', 'exp'}
_fails = {}         # ip → [zaman damgası…]
_pending = {}       # rid → (Future, viewer_ws | None, bridge_id)


def _db(fn, *a):
    return asyncio.to_thread(fn, *a)


# ---------------- MAVLink çözümleme ----------------
def _mav():
    from pymavlink.dialects.v20 import ardupilotmega as dialect
    p = dialect.MAVLink(None)
    p.robust_parsing = True
    return p


def _mode_name(mav_type, num):
    try:
        from pymavlink import mavutil
        mp = mavutil.mode_mapping_bynumber(mav_type) or {}
        return mp.get(num) or str(num)
    except Exception:   # noqa: BLE001
        return str(num)


MAV_TYPES = {1: 'Sabit kanat', 2: 'Quadrotor', 3: 'Koaksiyel', 4: 'Helikopter', 10: 'Kara aracı', 11: 'Deniz aracı', 12: 'Denizaltı', 13: 'Hexarotor',
             14: 'Octorotor', 15: 'Tricopter', 19: 'VTOL tailsitter', 20: 'VTOL tiltrotor', 21: 'VTOL', 22: 'VTOL tailsitter', 23: 'VTOL tiltwing',
             24: 'VTOL', 29: 'Dodecarotor', 35: 'Decarotor'}
# MAV_SYS_STATUS_SENSOR bit maskesi (SYS_STATUS.onboard_control_sensors_*): panelde sensör sağlığı rozetleri için
SENSOR_BITS = {'gyro': 1, 'accel': 2, 'mag': 4, 'baro': 8, 'diff_press': 16, 'gps': 32, 'optflow': 64, 'vision': 128, 'laser': 256, 'ext_gnd_truth': 512,
               'rate_ctrl': 1024, 'att_stab': 2048, 'yaw_pos': 4096, 'z_alt_ctrl': 8192, 'xy_pos_ctrl': 16384, 'motor': 32768, 'rc': 65536,
               'ahrs': 2097152, 'terrain': 4194304, 'battery': 33554432, 'prearm': 268435456, 'logging': 1073741824, 'geofence': 1048576}


def _dist_m(lat1, lon1, lat2, lon2):
    import math
    p1, p2 = math.radians(lat1), math.radians(lat2)
    a = math.sin((p2 - p1) / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(math.radians(lon2 - lon1) / 2) ** 2
    return 2 * 6371000 * math.asin(math.sqrt(a))



class DroneState:
    """Bir sysid'nin son bilinen durumu (JSON'a çevrilebilir sözlük). Alanlar GÖKTUNGU harekât paneliyle uyumlu (README eşlemesi)."""
    __slots__ = ('d', 'emitted', 'dirty', 'timer', 'armed_at', 'last_pos', 'console', 'rc_at', 'texts', 'params', 'param_buf', 'param_timer', 'prearm_hata', 'prearm_ani', 'hedef_rel')

    def __init__(self, sysid):
        self.timer = None   # hız sınırına takılan güncellemeyi sonradan yayınlayan zamanlayıcı
        self.params = {}    # PARAM_VALUE önbelleği: ad → [değer, index, count, type] (status paketine GİRMEZ; param_cache ile istenir)
        self.param_buf = []   # yayın bekleyen PARAM_VALUE'lar (200 ms'de bir toplu 'params' paketi)
        self.param_timer = None
        self.armed_at = None   # ARM anı (uçuş süresi)
        self.last_pos = None   # kat edilen mesafe için son konum
        self.console = []      # Haberleşme konsolu satırları (son CONSOLE_MAX): {ts, tag, text, sev, repeat}
        self.rc_at = None      # son RC_CHANNELS zamanı (ARM CHECK: kumanda bağlı mı)
        self.texts = []        # son STATUSTEXT'ler (ARM CHECK mesajlar sekmesi): {ts, text, severity}
        self.prearm_hata, self.prearm_ani = '', 0.0   # son PreArm/ARM reddi metni ve zamanı (GÖKTUNGU: ACK reddi gerekçesi)
        self.hedef_rel = None  # GÖKTUNGU hedef_irtifa_rel: takeoff/altitude_change hedefi; goto bu irtifayı korur
        self.d = {'sysid': sysid, 'type': None, 'type_name': None, 'autopilot': None, 'armed': False, 'mode': None, 'mode_num': None,
                  'lat': None, 'lon': None, 'alt': None, 'alt_rel': None, 'hdg': None, 'vx': None, 'vy': None, 'vz': None,
                  'airspeed': None, 'groundspeed': None, 'throttle': None, 'climb': None, 'roll': None, 'pitch': None, 'yaw': None,
                  'volt': None, 'curr': None, 'batt_pct': None, 'fix': None, 'sats': None, 'hdop': None, 'rpm': None,
                  'wp_dist': None, 'mission_seq': None, 'mission_count': None, 'home_lat': None, 'home_lon': None, 'home_alt': None,
                  'sensors': None, 'ekf_flags': None, 'prearm': [], 'last_text': None, 'flight_s': 0, 'dist_m': 0.0,
                  'magkal_pct': None, 'magkal_durum': None, 'magkal_rapor': None, 'kalib': None,   # v1.2 pusula kalibrasyonu / kalibrasyon oturumu
                  'last_hb': None, 'updated': None, 'msgs': 0}
        self.emitted = 0.0
        self.dirty = False

    def feed(self, m):
        t = m.get_type(); d = self.d
        d['msgs'] += 1
        if t == 'HEARTBEAT':
            if getattr(m, 'type', None) in (6,):   # GCS kalp atışı — dron değil
                return False
            d['type'] = m.type; d['type_name'] = MAV_TYPES.get(m.type, f'Tip {m.type}'); d['autopilot'] = m.autopilot
            armed = bool(m.base_mode & 128)
            now = time.time()
            if armed and not d['armed']:
                self.armed_at = now; d['dist_m'] = 0.0; d['prearm'] = []
            elif not armed and d['armed']:
                self.armed_at = None
            d['armed'] = armed
            if self.armed_at:
                d['flight_s'] = int(now - self.armed_at)
            d['mode_num'] = m.custom_mode; d['mode'] = _mode_name(m.type, m.custom_mode)
            d['last_hb'] = now
        elif t == 'GLOBAL_POSITION_INT':
            lat, lon = m.lat / 1e7, m.lon / 1e7
            if d['armed'] and self.last_pos and lat and lon:
                d['dist_m'] = round(d['dist_m'] + _dist_m(self.last_pos[0], self.last_pos[1], lat, lon), 1)
            if lat or lon:
                self.last_pos = (lat, lon)
            d['lat'] = lat; d['lon'] = lon; d['alt'] = m.alt / 1000; d['alt_rel'] = m.relative_alt / 1000
            d['vx'] = m.vx / 100; d['vy'] = m.vy / 100; d['vz'] = m.vz / 100; d['hdg'] = (m.hdg / 100) if m.hdg != 65535 else None
        elif t == 'NAV_CONTROLLER_OUTPUT':
            d['wp_dist'] = m.wp_dist
        elif t == 'MISSION_CURRENT':
            d['mission_seq'] = m.seq
            if getattr(m, 'total', 65535) not in (65535, None):
                d['mission_count'] = m.total
        elif t == 'HOME_POSITION':
            d['home_lat'] = m.latitude / 1e7; d['home_lon'] = m.longitude / 1e7; d['home_alt'] = m.altitude / 1000
        elif t == 'EKF_STATUS_REPORT':
            d['ekf_flags'] = m.flags
        elif t in ('RC_CHANNELS', 'RC_CHANNELS_RAW'):
            self.rc_at = time.time()
            return False
        elif t == 'MAG_CAL_PROGRESS':   # v1.2 pusula kalibrasyonu ilerlemesi
            d['magkal_pct'] = m.completion_pct; d['magkal_durum'] = m.cal_status
        elif t == 'MAG_CAL_REPORT':
            d['magkal_durum'] = m.cal_status
            d['magkal_rapor'] = {'compass_id': m.compass_id, 'fitness': m.fitness, 'cal_status': m.cal_status, 'autosaved': m.autosaved,
                                 'ofs': [m.ofs_x, m.ofs_y, m.ofs_z], 'diag': [m.diag_x, m.diag_y, m.diag_z], 'offdiag': [m.offdiag_x, m.offdiag_y, m.offdiag_z]}
        elif t == 'PARAM_VALUE':   # v1.1 param_list/param_get/param_set yankısı: önbelleğe + toplu yayın kuyruğuna
            name = str(m.param_id).rstrip('\x00')
            self.params[name] = [m.param_value, m.param_index, m.param_count, m.param_type]
            self.param_buf.append([name, m.param_value, m.param_index, m.param_count, m.param_type])
            return False
        elif t == 'VFR_HUD':
            d['airspeed'] = m.airspeed; d['groundspeed'] = m.groundspeed; d['throttle'] = m.throttle; d['climb'] = m.climb
            if d['hdg'] is None:
                d['hdg'] = m.heading
        elif t == 'ATTITUDE':
            import math
            d['roll'] = round(math.degrees(m.roll), 1); d['pitch'] = round(math.degrees(m.pitch), 1); d['yaw'] = round(math.degrees(m.yaw) % 360, 1)
        elif t == 'SYS_STATUS':
            d['volt'] = m.voltage_battery / 1000 if m.voltage_battery != 65535 else None
            d['curr'] = m.current_battery / 100 if m.current_battery != -1 else None
            d['batt_pct'] = m.battery_remaining if m.battery_remaining != -1 else None
            pres, en, ok = m.onboard_control_sensors_present, m.onboard_control_sensors_enabled, m.onboard_control_sensors_health
            d['sensors'] = {k: ('ok' if ok & b else 'fail') for k, b in SENSOR_BITS.items() if (pres & b) and (en & b)}
        elif t == 'GPS_RAW_INT':
            d['fix'] = m.fix_type; d['sats'] = m.satellites_visible; d['hdop'] = m.eph / 100 if m.eph != 65535 else None
        elif t == 'RPM':
            d['rpm'] = getattr(m, 'rpm1', None)
        else:
            return False
        d['updated'] = time.time()
        self.dirty = True
        return True


class Viewer:
    def __init__(self, ws, user):
        self.ws, self.user = ws, user
        self.q = asyncio.Queue(maxsize=VIEWER_QUEUE)
        self.watch = None     # bridge_id ya da None (hepsi) — eski davranış
        self.loop = asyncio.get_running_loop()   # izleyicinin olay döngüsü (task_changed istek iş parçacığından buraya aktarır)
        self.task_id = None   # Faz 1: görev bağlamı ({t:'watch',task_id}); doluysa yalnız görevin köprüleri/sanal dronları geçer
        self.allowed = set()  # görevin uçuşlarına bağlı köprü kimlikleri (+ sanal dron -drone_id)
        self.task = None      # hello.task {id, code, status, location_name, lat, lon}
        self.flights = []     # hello.flights (task_live ile aynı satırlar)
        self.sim_id = None    # §14: Uçuş Simülatörü oturumu bağlamı ({t:'watch', sim_id}); allowed = {-(9000+N)}
        self.sim_only = not can_read(user)   # field.live yok, yalnız drone.sim: görev/köprü akışı görünmez, yalnız izlenen simülatör

    def kisitli(self):
        return self.task_id is not None or self.sim_id is not None or self.sim_only

    def passes(self, bridge_id):
        """Bu izleyiciye bridge_id kaynaklı bir mesaj gider mi? (None: kaynaksız mesaj, herkese)"""
        if bridge_id is None:
            return True
        if self.kisitli():
            return bridge_id in self.allowed
        return self.watch is None or self.watch == bridge_id

    def put(self, txt):
        try:
            self.q.put_nowait(txt)
        except asyncio.QueueFull:   # yetişemiyor: en eskisini at (telemetride eski paket değersiz)
            try:
                self.q.get_nowait()
            except asyncio.QueueEmpty:
                pass
            try:
                self.q.put_nowait(txt)
            except asyncio.QueueFull:
                pass




def _broadcast(msg, bridge_id=None):
    """İzleyicilere yayın. Kaynak köprü: bridge_id parametresi, yoksa mesajın bridge_id alanı (köprü çevrimiçi/çevrimdışı
    bildirimleri) — görev bağlamındaki izleyiciler yalnız kendi görevlerinin köprülerini görür."""
    txt = json.dumps(msg, ensure_ascii=False)
    src = bridge_id if bridge_id is not None else msg.get('bridge_id')
    for v in list(VIEWERS.values()):
        if v.passes(src):
            v.put(txt)


def _bridge_or_sim(bridge_id):
    """Gerçek köprü (pozitif) ya da sanal dron (negatif, -drone_id); yoksa None."""
    try:
        bid = int(bridge_id or 0)
    except (TypeError, ValueError):
        return None
    return SIMS.get(bid) if bid < 0 else BRIDGES.get(bid)


async def _safe_send(ws, msg):
    try:
        await ws.send_text(json.dumps(msg, ensure_ascii=False))
    except Exception:   # noqa: BLE001
        pass



def all_caps(bridges=None):
    """Tarayıcıya bildirilen yetenekler: sunucu yetenekleri + bağlı köprülerin bildirdikleri (köprü bazlı ayrım hello.bridges[].caps'te).
    bridges verilirse (görev bağlamı) yalnız o köprülerin yetenekleri eklenir."""
    caps = set(CAPS)
    for b in (bridges if bridges is not None else [*BRIDGES.values(), *SIMS.values()]):
        caps |= set(b.caps)
    return sorted(caps)



def _feed_mavlink(bridge, data):
    try:
        msgs = bridge.parser.parse_buffer(data) or []
    except Exception:   # noqa: BLE001 — bozuk çerçeve: atla
        return
    _feed_msgs(bridge, msgs)


def _feed_msgs(bridge, msgs):
    """Ayrıştırılmış MAVLink mesajları → DroneState / STATUSTEXT olayı / COMMAND_ACK konsolu (köprü, SITL sanal dron ve simülatör oturumu
    — flightsim_hub.SimBridge kendi ayrıştırdığı mesajları ikinci kez çözmeden buraya verir)."""
    for m in msgs:
        try:
            sysid = m.get_srcSystem()
        except Exception:   # noqa: BLE001
            continue
        if m.get_type() == 'BAD_DATA':
            continue
        if m.get_type() == 'STATUSTEXT':
            text = str(m.text).rstrip('\x00')[:200]
            st = bridge.drones.setdefault(sysid, DroneState(sysid))
            st.d['last_text'] = text
            if text.startswith(('PreArm', 'Arm:')):   # ARM CHECK rozetleri: son 8 ön-kol uyarısı
                st.d['prearm'] = (st.d['prearm'] + [text])[-8:]
            low = text.lower()
            if low.startswith('prearm') or low.startswith('arm:') or 'arm' in low.split(':')[0]:   # GÖKTUNGU kuralı
                st.prearm_hata, st.prearm_ani = text, time.time()
            last = st.texts[-1] if st.texts else None   # ARM CHECK mesajlar sekmesi biçimi (arm_check.js acMesajCiz): ts, metin, sev, tekrar
            if last and last['metin'] == text and last['sev'] == m.severity:
                last['tekrar'] += 1; last['ts'] = time.time()
            else:
                st.texts = (st.texts + [{'ts': time.time(), 'metin': text, 'sev': m.severity, 'tekrar': 1}])[-50:]
            _broadcast({'t': 'event', 'bridge_id': bridge.id, 'sysid': sysid, 'text': text, 'severity': m.severity, 'ts': time.time()}, bridge.id)
            console_line(bridge, sysid, 'STATUS', text, 'hata' if m.severity <= 3 else 'uyari' if m.severity == 4 else 'bilgi')   # GÖKTUNGU: 0-3 hata, 4 uyarı, 5+ bilgi
            continue
        if m.get_type() == 'COMMAND_ACK':
            _command_ack(bridge, sysid, m)
        elif m.get_type() == 'PARAM_VALUE':   # sanal dron (SitlDrone): kalıcı parametre izleyicisi (drone_params); simülatör oturumu kendi _isle'sinde
            iz = getattr(bridge, 'param_izleyici', None)
            if iz is not None:
                try:
                    iz.param_value(str(m.param_id).rstrip('\x00'), m.param_value, m.param_type, m.param_index, m.param_count)
                except Exception:   # noqa: BLE001
                    pass
        st = bridge.drones.setdefault(sysid, DroneState(sysid))
        if st.feed(m):
            _emit(bridge, st)
        elif st.param_buf and st.param_timer is None:   # PARAM_VALUE'lar 200 ms'de bir toplu gider (binlerce parametre kuyruğu boğmasın)
            st.param_timer = asyncio.get_running_loop().call_later(0.2, _flush_params, bridge, st)


def global_line(bridge, sysid, tag, text, sev='bilgi'):
    """GÖKTUNGU genel konsolu (konsol.js; hata/uyarı satırları sağ üstte bildirim olur). İzleyicilere {t:'konsol'}."""
    _broadcast({'t': 'konsol', 'bridge_id': bridge.id, 'sysid': sysid, 'tag': tag, 'text': text, 'sev': sev, 'ts': time.time()}, bridge.id)


def _command_ack(bridge, sysid, m):
    """GÖKTUNGU dron.py _komut_ack_isle: kabul → dron konsolu; red → gerekçeli BAŞARISIZ satırı (dron + genel konsol + ARM CHECK)."""
    try:
        no, sonuc = int(m.command), int(m.result)
    except (TypeError, ValueError, AttributeError):
        return
    ad = KOMUT_ADLARI.get(no)
    if ad is None or sonuc == 5:   # yalnız kullanıcı komutları; IN_PROGRESS ara durum
        return
    st = bridge.drones.setdefault(sysid, DroneState(sysid))
    if sonuc == 0:
        console_line(bridge, sysid, 'KOMUT', f'{ad} kabul edildi', 'basari')
        return
    metin = f"[{sysid}] {ad} BAŞARISIZ: {MAV_RESULT_ADLARI.get(sonuc, f'sonuç={sonuc}')}"
    if st.prearm_hata and time.time() - st.prearm_ani < 15.0:
        metin += f' ({st.prearm_hata})'
    console_line(bridge, sysid, 'KOMUT', metin, 'hata')
    global_line(bridge, sysid, 'KOMUT', metin, 'hata')
    st.texts = (st.texts + [{'ts': time.time(), 'metin': metin, 'sev': 2, 'tekrar': 1}])[-50:]


def _flush_params(bridge, st):
    st.param_timer = None
    if not st.param_buf:
        return
    items, st.param_buf = st.param_buf, []
    _broadcast({'t': 'params', 'bridge_id': bridge.id, 'sysid': st.d['sysid'], 'items': items, 'count': items[-1][3], 'cached': len(st.params)}, bridge.id)


def _emit(bridge, st, force=False):
    """En çok STATUS_HZ paket/sn; sınıra takılan güncelleme kaybolmaz, süre dolunca son durum yayınlanır."""
    wait = 1.0 / STATUS_HZ - (time.time() - st.emitted)
    if not force and wait > 0:
        if st.timer is None:
            st.timer = asyncio.get_running_loop().call_later(wait, _flush, bridge, st)
        return
    _flush(bridge, st)


def _flush(bridge, st):
    if st.timer is not None:
        st.timer.cancel(); st.timer = None
    st.emitted = time.time(); st.dirty = False
    st.d['ready'] = ready_summary(st)
    _broadcast({'t': 'status', 'bridge_id': bridge.id, 'sysid': st.d['sysid'], 'state': st.d}, bridge.id)


# ---------------- Haberleşme konsolu ve ARM CHECK (sunucu-yalnız; köprüye gitmez) ----------------
def console_line(bridge, sysid, tag, text, sev='bilgi'):
    """Dron (sysid) başına halka tampon + izleyicilere yayın. Ardışık aynı satır birleştirilir (repeat ×N, fresh False)."""
    st = bridge.drones.setdefault(int(sysid or 0), DroneState(int(sysid or 0)))
    now = time.time()
    last = st.console[-1] if st.console else None
    if last and last['tag'] == tag and last['text'] == text:
        last['repeat'] += 1; last['ts'] = now
        line, fresh = last, False
    else:
        line = {'ts': now, 'tag': tag, 'text': text, 'sev': sev, 'repeat': 1}
        st.console = (st.console + [line])[-CONSOLE_MAX:]
        fresh = True
    _broadcast({'t': 'console', 'bridge_id': bridge.id, 'sysid': st.d['sysid'], 'fresh': fresh, **line}, bridge.id)


def ready_summary(st):
    """Kart rozeti / PFD köşe kutusu için uçuşa hazırlık özeti: {hazir, uyari, sebep}."""
    d = st.d
    if d['armed']:
        return {'hazir': None, 'uyari': 0, 'sebep': 'ARM · uçuşta'}
    fails = [k for k, v in (d['sensors'] or {}).items() if v == 'fail']
    sebep = d['prearm'][-1] if d['prearm'] else (f'Sensör: {fails[0]}' if fails else None)
    if sebep is None and (d['fix'] is None or d['fix'] < 3):
        sebep = 'GPS fix yok'
    return {'hazir': sebep is None, 'uyari': len(fails), 'sebep': sebep}


def arm_check_report(st):
    """ARM CHECK penceresi (GÖKTUNGU arm_check.js) için rapor: PreArm mesajları, sensör sağlığı, konum, güç, kumanda."""
    d = st.d; now = time.time()
    maddeler = []
    for t in d['prearm']:
        maddeler.append({'grup': 'prearm', 'ad': t, 'durum': 'hata', 'aciklama': 'Otopilot ön-kol denetimi', 'oncelik': 1})
    for k, v in (d['sensors'] or {}).items():
        maddeler.append({'grup': 'sensor', 'ad': k, 'durum': 'tamam' if v == 'ok' else 'hata', 'aciklama': 'SYS_STATUS sensör sağlığı', 'oncelik': 2})
    fix = d['fix']
    maddeler.append({'grup': 'konum', 'ad': 'GPS fix', 'durum': 'bilinmiyor' if fix is None else 'tamam' if fix >= 3 else 'uyari' if fix == 2 else 'hata',
                     'aciklama': f"fix {fix} · {d['sats'] if d['sats'] is not None else '?'} uydu · HDOP {d['hdop'] if d['hdop'] is not None else '?'}", 'oncelik': 1})
    if d['hdop'] is not None and d['hdop'] > 2:
        maddeler.append({'grup': 'konum', 'ad': 'HDOP', 'durum': 'uyari', 'aciklama': f"HDOP {d['hdop']} > 2", 'oncelik': 3})
    maddeler.append({'grup': 'konum', 'ad': 'HOME', 'durum': 'tamam' if d['home_lat'] else 'uyari', 'aciklama': 'Ev konumu alındı' if d['home_lat'] else 'HOME_POSITION gelmedi', 'oncelik': 0})
    pct = d['batt_pct']
    maddeler.append({'grup': 'guc', 'ad': 'Batarya', 'durum': 'bilinmiyor' if d['volt'] is None else 'hata' if (pct is not None and pct < 20) else 'uyari' if (pct is not None and pct < 40) else 'tamam',
                     'aciklama': f"{d['volt']} V" + (f" · %{pct}" if pct is not None else ''), 'oncelik': 1})
    rc_ok = st.rc_at is not None and now - st.rc_at < 3
    maddeler.append({'grup': 'rc', 'ad': 'Kumanda', 'durum': 'tamam' if rc_ok else 'bilinmiyor', 'aciklama': 'RC_CHANNELS alınıyor' if rc_ok else 'Kumanda verisi gelmiyor', 'oncelik': 2})
    hb_ok = d['last_hb'] is not None and now - d['last_hb'] < 5
    maddeler.append({'grup': 'sensor', 'ad': 'Kalp atışı', 'durum': 'tamam' if hb_ok else 'hata', 'aciklama': 'Telemetri canlı' if hb_ok else 'Kalp atışı yok', 'oncelik': 0})
    for x in maddeler:   # GÖKTUNGU arm_check.js acDenetimCiz 'deger' alanını gösterir
        x['deger'] = x['aciklama']
    kritik = sum(1 for x in maddeler if x['durum'] == 'hata'); uyari = sum(1 for x in maddeler if x['durum'] == 'uyari')
    sebep = next((x['ad'] for x in maddeler if x['durum'] == 'hata'), None) or next((x['ad'] for x in maddeler if x['durum'] == 'uyari'), None)
    return {'bulundu': True, 'sysid': d['sysid'], 'armed': d['armed'], 'mod': d['mode'],
            'ozet': {'hazir': kritik == 0, 'uyari': uyari, 'kritik': kritik, 'sebep': sebep},
            'maddeler': maddeler, 'parametreler': [], 'mesajlar': list(st.texts), 'ts': now}




def hello_msg(v):
    """İzleyiciye hello: görev bağlamında yalnız görevin köprüleri/sanal dronları + task/flights; aksi hâlde hepsi."""
    user = v.user
    msg = {'t': 'hello', 'v': PROTO, 'me': {'id': user['id'], 'name': user['full_name'], 'can_command': can_command(user)}}
    if v.kisitli():
        bridges = [b for b in [*BRIDGES.values(), *SIMS.values()] if b.id in v.allowed]
        if v.task_id is not None or v.sim_id is not None:
            msg['task'] = v.task
            msg['flights'] = v.flights
        if v.sim_id is not None:   # simülatör bağlamında komut yetkisi drone.sim yazma iznidir (SimBridge.can_command)
            msg['me']['can_command'] = any(getattr(b, 'can_command', None) and b.can_command(user) for b in bridges)
    else:
        bridges = [*BRIDGES.values(), *SIMS.values()]
    msg['caps'] = all_caps(bridges)
    msg['bridges'] = [b.info() for b in bridges]
    return msg



def can_read(user):
    """Rol Yönetimi: 'field.live' alt düğümü (ayar yoksa 'field' modülünden miras alır — rbac.node_chain)."""
    return 'field.live' in user['modules']


def can_command(user):
    return 'field.live' in user['write_modules'] and (user.get('master') or 'Pilot' in user.get('roles', []) or 'Yönetici' in user.get('roles', []))   # SIMUMAV: field.live yok → her zaman False


async def _viewer_sender(v: Viewer):
    try:
        while True:
            await v.ws.send_text(await v.q.get())
    except Exception:   # noqa: BLE001
        pass




async def send_command(user, bridge_id, sysid, name, params, viewer_ws=None, rid=None):
    """Tarayıcıdan (ya da REST'ten) köprüye komut: yetki + audit + req/res (CMD_TIMEOUT)."""
    if name not in CMD_NAMES:
        raise RuntimeError('Bilinmeyen komut')
    sim = int(bridge_id) < 0   # sanal dron (bridge_id = -drone_id): komut sunucu içi simülatöre gider
    b = _bridge_or_sim(bridge_id)
    if b is None:
        raise RuntimeError('Sanal dron çalışmıyor (görev izlenmiyor ya da kapandı)' if sim else 'Köprü bağlı değil')
    if name == 'arm_check':   # sunucu-yalnız rapor (okuma; komut yetkisi gerekmez, köprüye gitmez)
        st = b.drones.get(int(sysid))
        if st is None:
            raise RuntimeError('Bu dronun telemetrisi henüz gelmedi')
        return {'ok': True, 'result': arm_check_report(st)}
    if hasattr(b, 'can_command'):   # §14 simülatör oturumu: drone.sim yazma izni (Pilot rolü / field.live gerekmez)
        if not b.can_command(user):
            raise RuntimeError('Komut için Uçuş Simülatörü yazma izni gerekir')
    elif not can_command(user):
        raise RuntimeError('Komut için Canlı Uçuş yazma yetkisi ve Pilot rolü gerekir')

    def audit():
        with db.connect() as conn:
            if getattr(b, 'sim_id', None) is not None:
                db.audit(conn, user['id'], 'Simülatör komutu (harekât paneli)', 'drone_sim', b.sim_id, f'{name} · {json.dumps(params or {}, ensure_ascii=False)[:200]}')
            elif sim:
                db.audit(conn, user['id'], 'Sanal dron komutu', 'drone', b.drone_id, f'{name} · görev {b.task_id} · {json.dumps(params or {}, ensure_ascii=False)[:200]}')
            else:
                db.audit(conn, user['id'], 'Dron komutu', 'drone_bridge', b.id, f'{name} · sysid {sysid} · {json.dumps(params or {}, ensure_ascii=False)[:200]}')
            conn.commit()
    params = dict(params or {})
    if sim and name == 'param_set':   # kalıcı parametre izleme (drone_params): yankı PARAM_VALUE gelince kullanıcı adına kaydedilir
        iz = getattr(b, 'param_izleyici', None) or getattr(getattr(b, 's', None), 'param_izleyici', None)
        if iz is not None:
            iz.hepgo_set(params.get('name'), params.get('value'), user.get('id'))
    if name in SEQ_CMDS:
        return await _start_sequence(user, b, sim, sysid, name, params, viewer_ws, audit)
    return await _single_command(b, sim, int(sysid), name, params, viewer_ws, rid, audit)


async def _single_command(b, sim, sysid, name, params, viewer_ws, rid, audit):
    """GÖKTUNGU dron.py komut_gonder / goto_gonder / set_home_gonder / param_ayarla kuralları (tek komut; ön adımlar burada)."""
    st = b.drones.get(sysid)
    d = st.d if st else {}
    zorla = name == 'arm' and bool(params.get('force'))

    def fail(msg, genel=None):
        console_line(b, sysid, 'KOMUT', msg, 'hata')
        if genel:
            global_line(b, sysid, 'KOMUT', genel, 'hata')
        return {'ok': False, 'error': msg}

    if name in AKSIYON_ADI:
        console_line(b, sysid, 'KOMUT', f"-> {'arm_zorla' if zorla else AKSIYON_ADI[name]}", 'bilgi')
    if name == 'reboot' and d.get('armed'):
        # Havada uçuş kontrolcüsünü yeniden başlatmak düşüş demektir; karar operatöre bırakılmaz
        return fail('REBOOT REDDEDİLDİ: araç arm edilmiş durumda. Önce disarm edin.', f'D{sysid} reboot reddedildi: armlı')
    if name == 'disarm':
        params['force'] = True   # GÖKTUNGU: DISARM her zaman ZORLA (param2=21196; havada da motorları keser)
    if name == 'set_home' and params.get('lat') is not None and params.get('lon') is not None:
        if d.get('lat') is None:   # zemin AMSL'i kestirilemez: uydurma irtifa yazmak tehlikeli bir HOME hatası üretir
            return fail('Telemetri yok: HOME irtifası kestirilemiyor', f'D{sysid} HOME ayarlanamadı: telemetri yok (irtifa kestirilemiyor)')
        params['alt'] = float(d.get('alt') or 0.0) - float(d.get('alt_rel') or 0.0)
    if name == 'goto' and params.get('alt_rel_m') is None:
        # Kayıtlı REL hedefi (takeoff / altitude_change) korunur: süren tırmanış/alçalma konum değişikliğiyle iptal olmaz
        if st is not None and st.hedef_rel is not None:
            params['alt_rel_m'], irtifa_not = st.hedef_rel, f'{st.hedef_rel:.0f}m rel (hedef korundu)'
        else:
            params['alt_rel_m'] = float(d.get('alt_rel') or 0.0)
            irtifa_not = f"{float(d.get('alt') or 0.0):.0f}m MSL (mevcut)"
    elif name == 'goto':
        irtifa_not = f"{float(params['alt_rel_m']):.0f}m rel"
    await _db(audit)
    if name == 'altitude_change':   # GUIDED + mevcut konumda yalnız irtifa (GÖKTUNGU); hedef hafızaya alınır
        try:
            hedef = min(500.0, max(1.0, float(params.get('alt_rel_m') if params.get('alt_rel_m') is not None else 10.0)))
        except (TypeError, ValueError):
            hedef = 10.0
        if d.get('lat') is None or d.get('lon') is None:
            return fail('Aracın konumu bilinmiyor')
        if st is not None:
            st.hedef_rel = hedef
        r = await _dispatch(b, sim, sysid, 'set_mode', {'mode': 'GUIDED'}, viewer_ws)
        if not r['ok']:
            return r
        r = await _dispatch(b, sim, sysid, 'goto', {'lat': d['lat'], 'lon': d['lon'], 'alt_rel_m': hedef}, viewer_ws)
        if r['ok']:
            console_line(b, sysid, 'KOMUT', f'İRTİFA -> {hedef:.0f}m', 'basari')
        return r
    res = await _dispatch(b, sim, sysid, name, params, viewer_ws, rid)
    if not res['ok']:
        return res
    if name in ('land', 'rtl', 'disarm') and st is not None:
        st.hedef_rel = None
    done = {'land': ('LAND', 'basari'), 'rtl': ('RTL', 'basari'), 'disarm': ('DISARM', 'basari'),
            'arm': ('ARM (ZORLA — denetimler atlandı)', 'uyari') if zorla else ('ARM', 'basari'),
            'reboot': ('REBOOT gönderildi — bağlantı kesilecek ve yeniden kurulacak', 'uyari')}.get(name)
    if name == 'set_mode':
        done = (f"MOD -> {str(params.get('mode') or '').upper()}", 'basari')
    elif name == 'goto':
        done = (f"GOTO {float(params['lat']):.5f},{float(params['lon']):.5f} @ {irtifa_not}", 'basari')
    elif name == 'set_home':
        done = ((f"HOME = {float(params['lat']):.6f},{float(params['lon']):.6f} @ {params['alt']:.0f}m AMSL (zemin kestirimi)", 'basari')
                if params.get('lat') is not None else ('HOME = aracın mevcut konumu', 'basari'))
    elif name == 'param_set':
        done = (f"{params.get('name')} = {params.get('value')}", 'basari')
    if done:
        console_line(b, sysid, 'KOMUT', *done)
    if zorla:
        global_line(b, sysid, 'KOMUT', f'D{sysid} ZORLA ARM: arming denetimleri atlandı', 'uyari')
    return res


def _flow_key(b, sysid):
    return (b.id, int(sysid))


def _alive(b):
    return _bridge_or_sim(b.id) is b


async def _wait_for(pred, timeout, step=0.15):
    t0 = time.time()
    while time.time() - t0 < timeout:
        if pred():
            return True
        await asyncio.sleep(step)
    return pred()


async def _start_sequence(user, b, sim, sysid, name, params, viewer_ws, audit):
    st = b.drones.get(int(sysid))
    key = _flow_key(b, sysid)
    if name == 'takeoff':
        try:
            hedef = float(params.get('alt_rel_m') or TAKEOFF_ALT)
        except (TypeError, ValueError):
            hedef = TAKEOFF_ALT
        hedef = min(500.0, max(1.0, hedef))
        checklist = params.get('kontrol')
        kontrol_id = None
        if checklist is not None:
            # GÖKTUNGU kalkis_kontrol: kayıt ve takeoff aynı işlem; kayıt yazılamazsa takeoff GÖNDERİLMEZ.
            # Tarih/saat ve pilot kimliği istemciden alınmaz, sunucuda damgalanır.
            viewer = VIEWERS.get(viewer_ws) if viewer_ws is not None else None
            task_id = getattr(b, 'task_id', None) if sim else (viewer.task_id if viewer else None)
            kontrol_id = await _db(_save_takeoff_check, user, b, sim, sysid, task_id, hedef, checklist)
        if key in _FLOWS:
            console_line(b, sysid, 'KOMUT', 'Kalkış hazırlık akışı zaten sürüyor; tekrar komut gönderilmedi.', 'uyari')
            if kontrol_id:
                await _db(_mark_takeoff_check, kontrol_id, False, 'Kalkış hazırlık akışı zaten sürüyordu')
            return {'ok': False, 'error': 'Kalkış hazırlık akışı zaten sürüyor; tekrar komut gönderilmedi.'}
        if st is None:
            if kontrol_id:
                await _db(_mark_takeoff_check, kontrol_id, False, 'Telemetri bağlantısı yok')
            return {'ok': False, 'error': 'Telemetri bağlantısı yok; kalkış komutu gönderilemedi'}
        await _db(audit)
        console_line(b, sysid, 'KOMUT', '-> takeoff', 'bilgi')
        if kontrol_id:
            console_line(b, sysid, 'KOMUT', f'Kontrol listesi onaylandı (kayıt #{kontrol_id}), takeoff {hedef:.0f} m', 'bilgi')
        _FLOWS[key] = asyncio.get_running_loop().create_task(_takeoff_flow(b, sim, sysid, hedef, kontrol_id, viewer_ws))
        return {'ok': True, 'result': {'kontrol_id': kontrol_id}}
    # Görev akışları (rota başlat / duraklat / devam / iptal / sürdür): yanıt akış bitince döner (istemci aşamayı buna göre günceller)
    if key in _FLOWS:
        return {'ok': False, 'error': 'Bu dron için kalkış/görev akışı zaten sürüyor'}
    if st is None:
        return {'ok': False, 'error': 'baglanti_yok'}
    await _db(audit)
    flow = {'mission_start': _mission_flow, 'mission_pause': _mission_pause, 'mission_resume': _mission_resume,
            'mission_cancel': _mission_cancel, 'mission_resume_at': _mission_resume_at}[name]
    task = asyncio.get_running_loop().create_task(flow(b, sim, sysid, params, viewer_ws))
    _FLOWS[key] = task
    return await task




def _save_takeoff_check(user, b, sim, sysid, task_id, hedef, items):
    """SIMUMAV: kalkış kontrol listesi veritabanına yazılmaz; yalnız zorunlu maddeler denetlenir (HEPGO ile aynı kural), kayıt kimliği yok."""
    if not isinstance(items, list) or not items:
        raise RuntimeError('Eksik istek (sysid veya madde listesi yok)')
    zorunlu = [m for m in items[:80] if isinstance(m, dict) and m.get('zorunlu') is not False]
    if not zorunlu:
        raise RuntimeError('Kontrol listesi boş')
    eksik = sum(1 for m in zorunlu if m.get('cevap') is not True)
    if eksik:
        raise RuntimeError(f'{eksik} zorunlu madde onaylanmadı; kalkış reddedildi')
    return None


def _mark_takeoff_check(kid, sent, error):
    return None


HEARTBEAT_WAIT_S = 45.0   # oturum HAZIR'a SITL TCP bağlanınca geçer; kalp atışı/EKF birkaç sn sonra gelir → komutlar o ana kadar bekler
ARM_RETRY_S = 45.0        # ARM reddi (PreArm: EKF/GPS henüz oturmadı) → pre-arm beklenir ve yeniden denenir (tek denemede düşmez)
ARM_RETRY_STEP_S = 2.0


def _kalp_atisi_var(b, d):
    """Simülatör oturumunda SITL kalp atışı alındı mı (flightsim.SimSession._heartbeat_alindi; sahte kipte her zaman)."""
    s = getattr(b, 's', None)
    if s is None:
        return bool(d.get('mode'))
    return s.sahte is not None or bool(getattr(s, '_heartbeat_alindi', False))


async def _kalp_atisi_bekle(b, sim, sysid, d):
    """SIMUMAV paritesi (kullanıcı: "Kalkış ARM olmadan çalışmıyor"): panel HAZIR görür görmez Kalkış'a basar; SITL kalp atışı gelmeden
    set_mode/arm 'SITL henüz kalp atışı göndermedi' ile düşüyordu (kullanıcı sonradan ARM'a basınca akış çalışıyordu). Kalp atışı
    HEARTBEAT_WAIT_S içinde beklenir; konsola yazılır. Dönüş: alındı mı."""
    if _kalp_atisi_var(b, d):
        return True
    console_line(b, sysid, 'KOMUT', 'SITL kalp atışı bekleniyor (otopilot açılıyor)...', 'uyari')
    ok = await _wait_for(lambda: _kalp_atisi_var(b, d) or not _alive(b), HEARTBEAT_WAIT_S, 0.25)
    return ok and _alive(b) and _kalp_atisi_var(b, d)


POS_WAIT_S = 60.0   # EKF konum (GUIDED/TAKEOFF "requires position") beklemesi


def kalkis_konum_hazir(s, d=None):
    """Otopilot kalkışa hazır mı: GPS 3B fix + EKF yatay konum (EKF_STATUS_REPORT POS_HORIZ_ABS 16 | PRED_POS_HORIZ_ABS 512; rapor yoksa
    HOME_POSITION alınmış olması) + SYS_STATUS pre-arm sağlık biti 'fail' değil. Sahte kipte her zaman. SITL'de EKF oturmadan ARM kabul edilse
    de GUIDED/TAKEOFF modu 'requires position' ile reddedilir ve araç DISARM olur (ölçüldü) — bu yüzden ARM öncesi beklenir."""
    if s is None or s.sahte is not None:
        return True
    te = s.tele or {}
    if (te.get('gps_fix') or 0) < 3:
        return False
    if d is None:
        hub = getattr(s, 'hub', None)
        st = hub.drones.get(1) if hub is not None else None
        d = st.d if st is not None else {}
    flags = d.get('ekf_flags')
    pos = bool(flags & 528) if flags is not None else te.get('home') is not None
    prearm_ok = (d.get('sensors') or {}).get('prearm') != 'fail'
    return pos and prearm_ok


async def _konum_bekle(b, sim, sysid, d):
    s = getattr(b, 's', None)
    if kalkis_konum_hazir(s, d):
        return True
    console_line(b, sysid, 'KOMUT', 'EKF/GPS konumu bekleniyor (kalkış için gerekli)...', 'uyari')
    bitis = time.time() + POS_WAIT_S
    son_yazi = time.time()
    while time.time() < bitis and _alive(b):
        if kalkis_konum_hazir(s, d):
            console_line(b, sysid, 'KOMUT', 'EKF konumu hazır', 'basari')
            return True
        if time.time() - son_yazi >= 6:
            son_yazi = time.time()
            console_line(b, sysid, 'KOMUT', f"EKF/GPS konumu bekleniyor: {d.get('last_text') or 'GPS fix ' + str((s.tele or {}).get('gps_fix') if s else '?')}", 'uyari')
        await asyncio.sleep(0.25)
    return kalkis_konum_hazir(s, d)


def _prearm_metni(b, sysid):
    st = b.drones.get(int(sysid))
    if st is None:
        return ''
    if st.prearm_hata and time.time() - st.prearm_ani < 30:
        return st.prearm_hata
    return (st.d.get('prearm') or [''])[-1]


async def _arm_dene(b, sim, sysid, d, viewer_ws, teyit_s):
    """ARM (zorlamasız) + teyit; reddedilir ya da teyit gelmezse pre-arm (EKF/GPS/baro oturması) beklenir ve ARM_RETRY_S içinde yeniden
    denenir. Her denemede son PreArm metni konsola düşer. Dönüş: armed mi."""
    bitis = time.time() + ARM_RETRY_S
    deneme = 0
    while _alive(b):
        deneme += 1
        r = await _dispatch(b, sim, sysid, 'arm', {}, viewer_ws)
        if await _wait_for(lambda: bool(d.get('armed')), teyit_s if r['ok'] else min(teyit_s, 1.5)):
            if deneme > 1:
                console_line(b, sysid, 'KOMUT', f'ARM teyit edildi ({deneme}. deneme)', 'basari')
            return True
        if time.time() >= bitis:
            return False
        sebep = _prearm_metni(b, sysid) or (r.get('error') if not r['ok'] else '') or 'otopilot henüz hazır değil'
        console_line(b, sysid, 'KOMUT', f'ARM bekleniyor: {sebep} — {ARM_RETRY_STEP_S:.0f} sn sonra yeniden denenecek', 'uyari')
        await asyncio.sleep(ARM_RETRY_STEP_S)
        if d.get('armed'):
            return True
    return False


async def _takeoff_flow(b, sim, sysid, hedef, kontrol_id, viewer_ws):
    """GÖKTUNGU dron.py _kalkis_islemi (HEPGO drone_hub ile aynı sıra: GUIDED → ARM → NAV_TAKEOFF); SIMUMAV eki: kalp atışı beklemesi ve
    ARM yeniden denemesi (_kalp_atisi_bekle / _arm_dene) — pilot ayrıca ARM düğmesine basmaz."""
    d = b.drones[int(sysid)].d
    sent, hata = False, None

    def fail(msg):
        nonlocal hata
        hata = msg
        console_line(b, sysid, 'KOMUT', msg, 'hata')
    try:
        if not await _kalp_atisi_bekle(b, sim, sysid, d):
            return fail('SITL kalp atışı alınamadı; kalkış başlatılmadı. Oturumu "Sıfırla" ile yeniden başlatın.')
        if not await _konum_bekle(b, sim, sysid, d):
            return fail(f"EKF/GPS konumu {POS_WAIT_S:.0f} sn içinde oturmadı; kalkış başlatılmadı ({d.get('last_text') or '—'}).")
        if d.get('type') == 1:   # SABİT KANAT (MAV_TYPE_FIXED_WING): ArduPlane'in kendi kalkışı (GÖKTUNGU'da yok; GUIDED+NAV_TAKEOFF reddedilir)
            sent = await _plane_takeoff(b, sim, sysid, hedef, viewer_ws, d, fail)
            return
        console_line(b, sysid, 'KOMUT', 'GUIDED/ARM teyidi bekleniyor...', 'uyari')
        r = await _dispatch(b, sim, sysid, 'set_mode', {'mode': 'GUIDED'}, viewer_ws)
        if not r['ok'] or not await _wait_for(lambda: str(d.get('mode') or '').upper() == 'GUIDED', GUIDED_CONFIRM_S):
            return fail('GUIDED modu teyit edilmedi; takeoff gönderilmedi.')
        if not d.get('armed'):
            if not await _arm_dene(b, sim, sysid, d, viewer_ws, ARM_CONFIRM_S):
                return fail(f"ARM teyidi alınamadı ({ARM_RETRY_S:.0f} sn); takeoff gönderilmedi. Pre-arm: {_prearm_metni(b, sysid) or '—'}")
        if not _alive(b):
            return fail('Takeoff öncesi MAVLink bağlantısı kesildi.')
        r = await _dispatch(b, sim, sysid, 'takeoff', {'alt_rel_m': hedef}, viewer_ws)
        if not r['ok']:
            return fail(f"Kalkış komut hatası: {r.get('error') or 'reddedildi'}")
        sent = True
        b.drones[int(sysid)].hedef_rel = hedef   # GÖKTUNGU hedef_irtifa_rel: sonraki goto bu irtifayı korur
        console_line(b, sysid, 'KOMUT', f'TAKEOFF komutu iletildi: {hedef:.0f} m', 'basari')
        global_line(b, sysid, 'KOMUT', f'D{sysid} TAKEOFF {hedef:.0f}m', 'basari')
    except Exception as e:   # noqa: BLE001
        fail(f'Kalkış komut hatası: {e}')
    finally:
        _FLOWS.pop(_flow_key(b, sysid), None)
        if sim and _alive(b):
            b._publish()
        if kontrol_id:
            try:
                await _db(_mark_takeoff_check, kontrol_id, sent, hata)
            except Exception:   # noqa: BLE001
                pass


async def _plane_takeoff(b, sim, sysid, hedef, viewer_ws, d, fail):
    """Sabit kanat kalkışı (ArduPlane yöntemi; sanal ve gerçek tüm sabit kanatlar): seçilen irtifa TKOFF_ALT'a yazılır, TAKEOFF
    moduna geçilir (4 sn teyit), ARM edilir (6 sn teyit). Araç TKOFF_ALT'a kendi tırmanır ve orada düzleşir. Çok rotorlu
    akıştaki gibi GUIDED + MAV_CMD_NAV_TAKEOFF gönderilmez: ArduPlane bunu reddeder ve uçak yerde ARM'lı kalır (SITL'de ölçüldü).
    Köprü parametre yazmayı desteklemiyorsa ya da yazma reddedilirse dronun kayıtlı TKOFF_ALT değeriyle kalkılır (uyarı yazılır)."""
    hedef = min(hedef, 200.0)   # TKOFF_ALT aralığı 0–200 m
    console_line(b, sysid, 'KOMUT', 'Sabit kanat: TAKEOFF/ARM teyidi bekleniyor...', 'uyari')
    if sim or 'param' in b.caps:
        r = await _dispatch(b, sim, sysid, 'param_set', {'name': 'TKOFF_ALT', 'value': float(hedef), 'type': 9}, viewer_ws)
        if r['ok']:
            console_line(b, sysid, 'KOMUT', f'TKOFF_ALT = {hedef:.0f}', 'basari')
        else:
            console_line(b, sysid, 'KOMUT', f"TKOFF_ALT yazılamadı ({r.get('error') or 'reddedildi'}); dronun kayıtlı kalkış irtifası kullanılacak", 'uyari')
    else:
        console_line(b, sysid, 'KOMUT', 'Köprü parametre yazmayı desteklemiyor; dronun kayıtlı kalkış irtifası (TKOFF_ALT) kullanılacak', 'uyari')
    r = await _dispatch(b, sim, sysid, 'set_mode', {'mode': 'TAKEOFF'}, viewer_ws)
    if not r['ok'] or not await _wait_for(lambda: str(d.get('mode') or '').upper() == 'TAKEOFF', GUIDED_CONFIRM_S):
        fail('TAKEOFF modu teyit edilmedi; kalkış başlatılmadı.')
        return False
    if not d.get('armed'):
        if not _alive(b):
            fail('Kalkış öncesi MAVLink bağlantısı kesildi.')
            return False
        if not await _arm_dene(b, sim, sysid, d, viewer_ws, ARM_CONFIRM_S):
            fail(f"ARM teyidi alınamadı ({ARM_RETRY_S:.0f} sn); kalkış başlatılmadı. Pre-arm: {_prearm_metni(b, sysid) or '—'}")
            return False
    b.drones[int(sysid)].hedef_rel = hedef
    console_line(b, sysid, 'KOMUT', f'TAKEOFF modu: sabit kanat kalkışı başladı ({hedef:.0f} m)', 'basari')
    global_line(b, sysid, 'KOMUT', f'D{sysid} TAKEOFF (sabit kanat) {hedef:.0f}m', 'basari')
    return True


async def _mission_flow(b, sim, sysid, params, viewer_ws):
    """GÖKTUNGU gorev.py _gorevi_baslat: ARM değilse GUIDED → ARM → teyit; sonra AUTO → MISSION_START."""
    d = b.drones[int(sysid)].d
    try:
        if not d.get('armed'):
            r = await _dispatch(b, sim, sysid, 'set_mode', {'mode': 'GUIDED'}, viewer_ws)
            if not r['ok']:
                return r
            await asyncio.sleep(0.3)
            r = await _dispatch(b, sim, sysid, 'arm', {}, viewer_ws)
            if not r['ok'] or not await _wait_for(lambda: bool(d.get('armed')), MISSION_ARM_CONFIRM_S, 0.2):
                msg = f'D{sysid} ARM teyidi alınamadı (pre-arm kontrolleri?). Görev başlatılamadı.'
                console_line(b, sysid, 'KOMUT', msg, 'hata')
                return {'ok': False, 'error': msg}
        r = await _dispatch(b, sim, sysid, 'set_mode', {'mode': 'AUTO'}, viewer_ws)
        if not r['ok']:
            return r
        await asyncio.sleep(0.3)
        if not sim and 'mission_start' in b.caps:
            r = await _dispatch(b, sim, sysid, 'mission_start', {}, viewer_ws)
            if not r['ok']:
                return r
        name = str(params.get('rota') or '').strip()
        console_line(b, sysid, 'KOMUT', f"D{sysid} göreve gönderildi{': ' + repr(name) if name else ''}", 'basari')
        return {'ok': True}
    except Exception as e:   # noqa: BLE001
        return {'ok': False, 'error': str(e)}
    finally:
        _FLOWS.pop(_flow_key(b, sysid), None)
        if sim and _alive(b):
            b._publish()


async def _mod_ayarla(b, sim, sysid, mode, viewer_ws, yedek=None):
    """GÖKTUNGU gorev.py _mod_ayarla: modu gönderir, MOD_TEYIT_SURESI içinde telemetride doğrular; olmazsa yedek modu dener.
    Dönüş: uygulanan mod adı | None."""
    d = b.drones[int(sysid)].d

    async def dene(m):
        r = await _dispatch(b, sim, sysid, 'set_mode', {'mode': m}, viewer_ws)
        return r['ok'] and await _wait_for(lambda: str(d.get('mode') or '').upper() == m, MOD_TEYIT_SURESI)
    if await dene(mode):
        return mode
    if yedek is None:
        return None
    global_line(b, sysid, 'GÖREV', f'D{sysid} {mode} modu doğrulanamadı; {yedek} deneniyor', 'uyari')
    return yedek if await dene(yedek) else None


async def _gorev_flow(fn, b, sysid):
    try:
        return await fn()
    except Exception as e:   # noqa: BLE001
        return {'ok': False, 'error': str(e)}
    finally:
        _FLOWS.pop(_flow_key(b, sysid), None)
        if hasattr(b, '_publish') and _alive(b):
            b._publish()


async def _mission_pause(b, sim, sysid, params, viewer_ws):
    """GÖKTUNGU gorev.py durdur: 'bekle' → BRAKE (doğrulanamazsa LOITER); 'basa_don' → RTL. Doğrulanamazsa aşama değişmez."""
    async def fn():
        basa_don = params.get('davranis') == 'basa_don'
        mod = await (_mod_ayarla(b, sim, sysid, 'RTL', viewer_ws) if basa_don else _mod_ayarla(b, sim, sysid, 'BRAKE', viewer_ws, 'LOITER'))
        if not mod:
            global_line(b, sysid, 'GÖREV', f'D{sysid} DURAKLATMA DOĞRULANAMADI — araç mod değişimini kabul etmedi; görev sürüyor olabilir', 'hata')
            return {'ok': False, 'error': 'mod_dogrulanamadi'}
        aciklama = 'başlangıca dönüyor' if basa_don else 'durduğu yerde bekliyor'
        global_line(b, sysid, 'GÖREV', f'D{sysid} görev duraklatıldı — {aciklama} ({mod})', 'uyari')
        return {'ok': True, 'result': {'mode': mod}}
    return await _gorev_flow(fn, b, sysid)


async def _mission_resume(b, sim, sysid, params, viewer_ws):
    """GÖKTUNGU gorev.py devam: AUTO (telemetriden doğrulanır)."""
    async def fn():
        if not await _mod_ayarla(b, sim, sysid, 'AUTO', viewer_ws):
            global_line(b, sysid, 'GÖREV', f'D{sysid} AUTO moda geçiş doğrulanamadı — görev devam etmiyor', 'hata')
            return {'ok': False, 'error': 'mod_dogrulanamadi'}
        global_line(b, sysid, 'GÖREV', f'D{sysid} görev devam ediyor', 'basari')
        return {'ok': True, 'result': {'mode': 'AUTO'}}
    return await _gorev_flow(fn, b, sysid)


async def _mission_cancel(b, sim, sysid, params, viewer_ws):
    """GÖKTUNGU gorev.py iptal: BRAKE (doğrulanamazsa LOITER) ile anında durdur, dronun görev listesini temizle (MISSION_CLEAR_ALL)."""
    async def fn():
        isim = str(params.get('rota') or '?')
        mod = await _mod_ayarla(b, sim, sysid, 'BRAKE', viewer_ws, 'LOITER')
        if not mod:
            global_line(b, sysid, 'GÖREV', f'D{sysid} iptalde durdurma modu doğrulanamadı; görev listesi yine de temizleniyor', 'uyari')
        if sim or 'mission_clear' in b.caps:
            r = await _dispatch(b, sim, sysid, 'mission_clear', {}, viewer_ws)
            if not r['ok']:
                global_line(b, sysid, 'GÖREV', f"İptal hatası: {r.get('error')}", 'hata')
                return r
            temiz = 'görev listesi temizlendi'
        else:
            temiz = 'görev listesi temizlenemedi (köprü mission_clear desteklemiyor)'
        global_line(b, sysid, 'GÖREV', f"D{sysid} GÖREV İPTAL EDİLDİ ('{isim}') - dron {mod or 'durdurulamadı'}, {temiz}", 'uyari')
        return {'ok': True, 'result': {'mode': mod}}
    return await _gorev_flow(fn, b, sysid)


async def _mission_resume_at(b, sim, sysid, params, viewer_ws):
    """GÖKTUNGU gorev.py surdur: MISSION_SET_CURRENT(kalınan nokta) → ARM değilse GUIDED → ARM → teyit → AUTO → MISSION_START."""
    async def fn():
        d = b.drones[int(sysid)].d
        try:
            seq = int(params.get('seq'))
        except (TypeError, ValueError):
            return {'ok': False, 'error': 'surdurulecek_gorev_yok'}
        r = await _dispatch(b, sim, sysid, 'mission_set_current', {'seq': seq}, viewer_ws)
        if not r['ok']:
            global_line(b, sysid, 'GÖREV', f"Sürdürme (set_current) hatası: {r.get('error')}", 'hata')
            return r
        if d.get('armed') is False:
            if not await _mod_ayarla(b, sim, sysid, 'GUIDED', viewer_ws):
                global_line(b, sysid, 'GÖREV', f'D{sysid} sürdürme için GUIDED moda geçilemedi', 'hata')
                return {'ok': False, 'error': 'mod_dogrulanamadi'}
            r = await _dispatch(b, sim, sysid, 'arm', {}, viewer_ws)
            if not r['ok'] or not await _wait_for(lambda: bool(d.get('armed')), MISSION_ARM_CONFIRM_S, 0.2):
                global_line(b, sysid, 'GÖREV', f'D{sysid} sürdürme için ARM teyidi alınamadı', 'hata')
                return {'ok': False, 'error': 'arm_teyidi_yok'}
        if not await _mod_ayarla(b, sim, sysid, 'AUTO', viewer_ws):
            return {'ok': False, 'error': 'mod_dogrulanamadi'}
        if not sim and 'mission_start' in b.caps:
            await _dispatch(b, sim, sysid, 'mission_start', {}, viewer_ws)   # AUTO doğrulandı; gönderilemese de araç sürdürür
        toplam = params.get('toplam_oge')
        global_line(b, sysid, 'GÖREV', f"D{sysid} GÖREV SÜRDÜRÜLDÜ ('{params.get('rota') or '?'}') — nokta {seq}"
                    + (f' ({seq + 1}/{toplam})' if toplam else '') + ' itibarıyla devam', 'basari')
        return {'ok': True}
    return await _gorev_flow(fn, b, sysid)


async def _dispatch(b, sim, sysid, name, params, viewer_ws=None, rid=None):
    """Tek komutu köprüye (ya da sanal drona) gönderir, sonucu konsola yazar."""
    if sim:
        res = await b.acommand(name, params) if hasattr(b, 'acommand') else b.command(name, params)   # SitlDrone / flightsim_hub.SimBridge eşzamansız
        ok = bool(res.get('ok'))
        err = str(res.get('error') or 'reddedildi')
        if not ok and 'MAV_RESULT' not in err:   # SITL: reddi COMMAND_ACK satırı yazar
            console_line(b, sysid, 'KOMUT', f'{name}: {err}', 'hata')
        b._publish()
        return {'ok': ok, 'result': res.get('result'), 'error': res.get('error')}
    if name == 'disconnect':
        return {'ok': False, 'error': 'SIMUMAV: gerçek köprü yok'}
    rid = rid or secrets.token_hex(8)
    fut = asyncio.get_running_loop().create_future()
    _pending[rid] = (fut, viewer_ws, b.id)
    if name.startswith('kalib_'):   # v1.2 kalibrasyon oturumu: pencere yalnız bu andan sonraki STATUSTEXT'leri gösterir
        st = b.drones.get(int(sysid))
        if st is not None:
            st.d['kalib'] = {'tur': name[6:], 'bas': time.time()}
            if name == 'kalib_pusula_baslat':
                st.d['magkal_pct'] = 0; st.d['magkal_durum'] = None; st.d['magkal_rapor'] = None
    try:
        raise RuntimeError('SIMUMAV: gerçek köprü yok (yalnız simülatör oturumları)')
        res = await asyncio.wait_for(fut, CMD_TIMEOUTS.get(name, CMD_TIMEOUT))
        ok = bool(res.get('ok'))
        err = str(res.get('error') or 'reddedildi')
        if not ok and 'MAV_RESULT' not in err:   # MAV_RESULT reddini COMMAND_ACK satırı gerekçesiyle yazar
            console_line(b, sysid, 'KOMUT', f'{name}: {err}', 'hata')
        return {'ok': ok, 'result': res.get('result'), 'error': res.get('error')}
    except asyncio.TimeoutError:
        console_line(b, sysid, 'KOMUT', f'{name}: köprü yanıt vermedi (zaman aşımı)', 'hata')
        raise RuntimeError('Köprü komuta yanıt vermedi (zaman aşımı)')
    finally:
        _pending.pop(rid, None)

