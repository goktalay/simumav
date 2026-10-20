"""Uçuş Simülatörü — KAYITTAN OYNATMA (`drone.sim`, mode 'replay'; sözleşme docs/ucus-simulatoru.md §8).

Kullanıcı sisteme yüklenmiş bir uçuş logunu (flight_logs: ArduPilot DataFlash .bin/.log ya da MAVLink .tlog) seçer; SITL ve UDP
AÇILMAZ, komut yok: log sunucuda bir kez ayrıştırılır, sabit frekansta (REPLAY_HZ, varsayılan 25 Hz) yeniden örneklenir, gzip JSON
olarak önbelleğe yazılır (`DATA_DIR/sim_replay/<log_id>.json.gz`) ve tarayıcı kareleri tek seferde çekip 3B dünyada oynatır.

Kare biçimi (`fields` ile aynı sırada dizi; `rc` ve `servo` 8 kanallı iç dizi):
  [t, lat, lon, alt_msl, alt_rel, roll, pitch, yaw (rad), vn, ve, vd (m/s), gs, as (m/s), hdg (°), thr (%), mode (modes dizini),
   armed (0/1), batt_v, batt_pct, sats, fix, rc, servo]
  `servo`: servo ÇIKIŞLARI µs (DataFlash RCOU C1…C8 · tlog SERVO_OUTPUT_RAW servo1…8_raw) — 3B kontrol yüzeylerinin (elevon/aileron/elevator/
  rudder/flap) birincil kaynağı (§5, §8). `rc` RC GİRİŞİ (RCIN / RC_CHANNELS): AUTO/TAKEOFF gibi modlarda kumanda ortada durur, yüzeyler otopilotun
  servo çıkışıyla oynar; bu yüzden yalnız `rc` ile kayıtta flap/elevon hareket etmiyordu (sürüm 3 ile `servo` eklendi).
Önbellek JSON: {v, hz, fields, frames, modes:[ad…], events:[{t,text,sev}], duration_s, home:{lat,lon,alt}, takeoff_t, start_utc,
                vehicle, type, n, servo_fn:[SERVO1…8_FUNCTION | null] (PARM / PARAM_VALUE; 3B flap/elevon kanal eşlemesi için)}
- `home`: ilk ARM anındaki konum (ARM/EV 10/STAT.Armed · tlog: HEARTBEAT armed geçişi); yoksa ORGN/HOME_POSITION; yoksa ilk geçerli konum.
  `home.alt` MSL; `alt_rel = alt_msl − home.alt` (3B dünyada pist seviyesi 0 = merkez alt).
- Alanlar ArduPilot sürümüne göre değişir (NKF1/XKF1, ThO/ThrOut, BAT.RemPct…); okuma toleranslıdır (flightlog.analyze kalıbı).
"""
import asyncio
import gzip
import json
import math
import os
import re
import time
from datetime import datetime, timezone

from . import config, db

REPLAY_HZ = int(os.environ.get('SIM_REPLAY_HZ', '25'))          # 20–50 Hz
REPLAY_MAX_FRAMES = 150000                                       # üstü seyreltilir (2 saat × 25 Hz = 180k)
MAX_EVENTS = 400
ONBELLEK_SURUM = 3   # 3: `servo` kare alanı + `servo_fn` (kayıtta kontrol yüzeyleri)
FIELDS = ['t', 'lat', 'lon', 'alt_msl', 'alt_rel', 'roll', 'pitch', 'yaw', 'vn', 've', 'vd', 'gs', 'as', 'hdg', 'thr', 'mode', 'armed',
          'batt_v', 'batt_pct', 'sats', 'fix', 'rc', 'servo']
BIN_TIPLERI = ['GPS', 'POS', 'ATT', 'RCIN', 'RCOU', 'BAT', 'CURR', 'MODE', 'ARM', 'EV', 'STAT', 'MSG', 'NKF1', 'XKF1', 'CTUN', 'ARSP', 'ORGN', 'PARM']
TLOG_TIPLERI = ['HEARTBEAT', 'GLOBAL_POSITION_INT', 'ATTITUDE', 'RC_CHANNELS', 'RC_CHANNELS_RAW', 'SERVO_OUTPUT_RAW', 'SYS_STATUS', 'VFR_HUD',
                'GPS_RAW_INT', 'STATUSTEXT', 'HOME_POSITION', 'PARAM_VALUE']
SERVO_N = 8
_SERVO_FN_RE = re.compile(r'^SERVO(\d+)_FUNCTION$')
UZANTILAR = ('.bin', '.log', '.tlog')


def onbellek_dizini():
    d = config.DATA_DIR / 'sim_replay'
    d.mkdir(parents=True, exist_ok=True)
    return d


def onbellek_yolu(log_id):
    return onbellek_dizini() / f'{int(log_id)}.json.gz'


def _r(v, n=2):
    if v is None:
        return None
    try:
        if math.isnan(v) or math.isinf(v):
            return None
    except TypeError:
        return v
    return round(v, n)


def _num(v):
    return None if v is None or (isinstance(v, float) and (math.isnan(v) or math.isinf(v))) else v


def _thin(points, limit):
    if len(points) <= limit:
        return points
    step = len(points) / limit
    out = [points[int(i * step)] for i in range(limit)]
    out.append(points[-1])
    return out


def arac_tipi(vehicle):
    """Firmware adından simülatör dron tipi (3B model): ArduPlane → sabit_kanat, ArduCopter heli → helikopter, diğer → multirotor."""
    v = (vehicle or '').lower()
    if 'plane' in v:
        return 'sabit_kanat'
    if 'heli' in v:
        return 'helikopter'
    return 'multirotor'


class _Toplayici:
    """Sample-and-hold yeniden örnekleyici: her mesajda `cur` güncellenir; konum varsa ve 1/hz geçtiyse kare yazılır."""

    def __init__(self, hz):
        self.hz = hz
        self.adim = 1.0 / hz
        self.cur = {'lat': None, 'lon': None, 'alt_msl': None, 'roll': 0.0, 'pitch': 0.0, 'yaw': 0.0, 'vn': None, 've': None, 'vd': None,
                    'gs': None, 'as': None, 'hdg': None, 'thr': None, 'mode': None, 'armed': 0, 'batt_v': None, 'batt_pct': None,
                    'sats': None, 'fix': None, 'rc': None, 'servo': None}
        self.servo_fn = [None] * SERVO_N   # SERVOn_FUNCTION (PARM/PARAM_VALUE); 3B flap (2/3) ve elevon (77/78) kanal eşlemesi
        self.frames = []
        self.events = []
        self.modes = []          # ad listesi (kare 'mode' dizini)
        self.mode_idx = {}
        self.home = None         # (lat, lon, alt) ilk ARM
        self.home_bekliyor = False
        self.arm_times = []      # ARM geçiş zamanları (kalkış anı: ilk havalanmadan önceki son ARM)
        self.origin = None       # ORGN / HOME_POSITION
        self.takeoff_t = None
        self.start_utc = None
        self.vehicle = None
        self.next_t = 0.0
        self.t0 = None
        self.son_t = 0.0

    def zaman(self, t_abs):
        if self.t0 is None:
            self.t0 = t_abs
        t = t_abs - self.t0
        self.son_t = max(self.son_t, t)
        return t

    def mod(self, ad):
        ad = str(ad or '').strip() or '?'
        if ad not in self.mode_idx:
            self.mode_idx[ad] = len(self.modes)
            self.modes.append(ad)
        return self.mode_idx[ad]

    def mod_degis(self, t, ad):
        i = self.mod(ad)
        if self.cur['mode'] != i:
            self.cur['mode'] = i
            self.olay(t, f'Mod: {ad}', 6)

    def arm(self, t, armed):
        armed = 1 if armed else 0
        if armed == self.cur['armed']:
            return
        self.cur['armed'] = armed
        if armed:
            self.arm_times.append(t)
        self.olay(t, 'ARM — motorlar kuruldu' if armed else 'DISARM — motorlar devre dışı', 5 if armed else 6)
        if armed and self.home is None:
            if self.cur['lat'] is not None:
                self.home = (self.cur['lat'], self.cur['lon'], self.cur['alt_msl'] or 0.0)
            else:
                self.home_bekliyor = True   # ARM konumdan önce geldi (kayıt kurulu başladı): ilk konumda ev atanır
            self.takeoff_t = t

    def parametre(self, ad, deger):
        m = _SERVO_FN_RE.match(str(ad or '').strip().rstrip('\x00'))
        if m and 1 <= int(m.group(1)) <= SERVO_N and deger is not None:
            try:
                self.servo_fn[int(m.group(1)) - 1] = int(float(deger))
            except (TypeError, ValueError):
                pass

    def olay(self, t, text, sev=6):
        if len(self.events) < MAX_EVENTS:
            self.events.append({'t': _r(t, 2), 'text': str(text)[:200], 'sev': int(sev)})

    def kare(self, t):
        c = self.cur
        if c['lat'] is None:
            return
        if self.home_bekliyor and self.home is None:
            self.home, self.home_bekliyor = (c['lat'], c['lon'], c['alt_msl'] or 0.0), False
        if t < self.next_t:
            return
        self.next_t = t + self.adim
        self.frames.append([_r(t, 3), round(c['lat'], 7), round(c['lon'], 7), _r(c['alt_msl'], 2), None, _r(c['roll'], 4), _r(c['pitch'], 4),
                            _r(c['yaw'], 4), _r(c['vn'], 2), _r(c['ve'], 2), _r(c['vd'], 2), _r(c['gs'], 2), _r(c['as'], 2), _r(c['hdg'], 1),
                            _r(c['thr'], 1), c['mode'], c['armed'], _r(c['batt_v'], 2), c['batt_pct'], c['sats'], c['fix'],
                            list(c['rc']) if c['rc'] else None, list(c['servo']) if c['servo'] else None])

    def bitir(self, kaynak):
        if len(self.frames) < 2:
            raise ValueError('Logda kayıttan oynatma için konum verisi yok')
        frames = _thin(self.frames, REPLAY_MAX_FRAMES)
        home = self.home or self.origin
        if home is None:
            f0 = frames[0]
            home = (f0[1], f0[2], f0[3] or 0.0)
        if home[2] is None:   # ORGN irtifasız: ilk kare
            home = (home[0], home[1], frames[0][3] or 0.0)
        for f in frames:   # alt_rel = alt_msl − home.alt
            f[4] = _r((f[3] if f[3] is not None else home[2]) - home[2], 2)
        duration = frames[-1][0]
        # Kalkış anı (oynatma başlangıcı): ilk havalanma (AGL > 5 m ve yer hızı > 3 m/s) öncesindeki son ARM; havalanma yoksa ilk ARM.
        # (Gerçek loglarda ilk ARM çoğu kez kalibrasyon içindir; kalkış dakikalar sonra gelir.)
        havada = next((f[0] for f in frames if f[4] is not None and f[4] > 5 and (f[11] or 0) > 3), None)
        if havada is not None:
            onceki = [t for t in self.arm_times if t <= havada]
            self.takeoff_t = onceki[-1] if onceki else (self.takeoff_t if self.takeoff_t is not None else havada)
            if self.takeoff_t is not None and havada - self.takeoff_t > 120:   # ARM'den 2 dk+ sonra havalanma: havalanmadan 10 sn önce
                self.takeoff_t = max(self.takeoff_t, havada - 10)
            # Ev irtifası kalkış anındaki irtifa: ARM ile kalkış arasında baro/EKF kalibrasyonu irtifayı kaydırabilir (yerde AGL ≠ 0 olmasın)
            kalkis = next((f for f in frames if f[0] >= self.takeoff_t), None) if self.takeoff_t is not None else None
            if kalkis is not None and kalkis[3] is not None and abs(kalkis[3] - home[2]) > 0.5:
                home = (home[0], home[1], kalkis[3])
                for f in frames:
                    f[4] = _r((f[3] if f[3] is not None else home[2]) - home[2], 2)
        return {'v': ONBELLEK_SURUM, 'hz': self.hz, 'fields': FIELDS, 'frames': frames, 'modes': self.modes, 'events': self.events,
                'duration_s': _r(duration, 2), 'home': {'lat': round(home[0], 7), 'lon': round(home[1], 7), 'alt': _r(home[2], 2)},
                'takeoff_t': _r(self.takeoff_t, 2), 'start_utc': self.start_utc, 'vehicle': self.vehicle, 'type': arac_tipi(self.vehicle),
                'n': len(frames), 'source': kaynak, 'servo_fn': list(self.servo_fn)}


def _mode_names(firmware):
    from .flightlog import _mode_names as mn
    return mn(firmware)


def _bin_ayristir(path, hz, ilerleme=None):
    """ArduPilot DataFlash (.bin / .log): GPS/POS, ATT, RCIN, RCOU (servo çıkışı), BAT, MODE, ARM/EV, MSG, NKF1/XKF1 (VN/VE/VD), CTUN, ARSP,
    ORGN, PARM (SERVOn_FUNCTION)."""
    from pymavlink import mavutil
    from .flightlog import WARN_RE
    log = mavutil.mavlink_connection(str(path), zero_time_base=False, progress_callback=ilerleme) if ilerleme else \
        mavutil.mavlink_connection(str(path), zero_time_base=False)
    T = _Toplayici(hz)
    names = None
    gps_alt, pos_var, hiz_ekf = None, False, False
    bekleyen_mod = []   # firmware öğrenilmeden gelen MODE kayıtları (numara) — ad sonra çözülür
    while True:
        m = log.recv_match(type=BIN_TIPLERI)
        if m is None:
            break
        tus = getattr(m, 'TimeUS', None)
        if tus is None:
            tms = getattr(m, 'TimeMS', None)
            if tms is None:
                continue
            tus = tms * 1000
        t = T.zaman(tus / 1e6)
        tp = m.get_type()
        c = T.cur
        if tp == 'MSG':
            text = str(m.Message)
            if T.vehicle is None and text.startswith(('ArduPlane', 'ArduCopter', 'ArduRover', 'ArduSub', 'ArduHeli', 'Blimp')):
                T.vehicle = text
                names = _mode_names(text)
                for bt, num in bekleyen_mod:
                    T.mod(names.get(num, f'Mod {num}'))
            T.olay(t, text, 4 if WARN_RE.search(text) else 6)
        elif tp == 'GPS':
            if getattr(m, 'I', 0) not in (0, None):
                continue
            st = getattr(m, 'Status', 0) or 0
            c['fix'], c['sats'] = int(st), getattr(m, 'NSats', None)
            if st >= 3:
                gps_alt = _num(getattr(m, 'Alt', None))
                c['gs'] = _num(getattr(m, 'Spd', None))
                if not pos_var:
                    c['lat'], c['lon'], c['alt_msl'] = m.Lat, m.Lng, gps_alt
                if not hiz_ekf and c['gs'] is not None:
                    crs = math.radians(_num(getattr(m, 'GCrs', None)) or 0.0)
                    c['vn'], c['ve'] = c['gs'] * math.cos(crs), c['gs'] * math.sin(crs)
                    vz = _num(getattr(m, 'VZ', None))
                    c['vd'] = -vz if vz is not None else c['vd']
                if T.start_utc is None and getattr(m, 'GWk', 0) and getattr(m, 'GWk', 0) > 0:
                    unix = 315964800 + m.GWk * 604800 + m.GMS / 1000.0 - 18 - t   # GPS→UTC (18 sn artık saniye); kayıt başına çekilir
                    T.start_utc = datetime.fromtimestamp(unix, timezone.utc).isoformat()
        elif tp == 'POS':
            if m.Lat and m.Lng:
                pos_var = True
                c['lat'], c['lon'] = m.Lat, m.Lng
                alt = _num(getattr(m, 'Alt', None))
                c['alt_msl'] = alt if alt is not None else gps_alt
        elif tp == 'ATT':
            c['roll'], c['pitch'], c['yaw'] = math.radians(m.Roll), math.radians(m.Pitch), math.radians(m.Yaw)
            c['hdg'] = float(m.Yaw) % 360.0
        elif tp == 'RCIN':
            c['rc'] = [int(getattr(m, f'C{i}', 0) or 0) for i in range(1, 9)]
        elif tp == 'RCOU':
            c['servo'] = [int(getattr(m, f'C{i}', 0) or 0) for i in range(1, SERVO_N + 1)]
        elif tp == 'PARM':
            T.parametre(getattr(m, 'Name', None), getattr(m, 'Value', None))
            continue   # parametre kare yazdırmaz
        elif tp in ('BAT', 'CURR'):
            if getattr(m, 'Inst', getattr(m, 'Instance', 0)) not in (0, None):
                continue
            v = _num(getattr(m, 'Volt', None))
            if v and v > 0.5:
                c['batt_v'] = v
            pct = _num(getattr(m, 'RemPct', None))
            if pct is not None and pct >= 0:
                c['batt_pct'] = int(pct)
        elif tp == 'MODE':
            num = getattr(m, 'ModeNum', getattr(m, 'Mode', None))
            if names is None:
                bekleyen_mod.append((t, num))
                T.mod_degis(t, f'Mod {num}')
            else:
                T.mod_degis(t, names.get(num, f'Mod {num}'))
        elif tp == 'ARM':
            T.arm(t, bool(m.ArmState))
        elif tp == 'STAT':
            # ArduPlane durum mesajı (Armed 0/1, ~5 Hz). KÖK NEDEN: ARM sonrası başlayan kayıtlarda (LOG_DISARMED 0 — SITL .bin kaydı dahil) ARM/EV 10
            # olayı logda yoktur → `armed` hiç 1 olmuyordu → kayıtta motor sesi ve kontrol yüzeyleri (ctrlInputs disarm → nötr) hiç çalışmıyordu.
            T.arm(t, bool(getattr(m, 'Armed', 0)))
        elif tp == 'EV':
            if m.Id in (10, 11):
                T.arm(t, m.Id == 10)
            elif m.Id == 25 and c['lat'] is not None and T.origin is None:
                T.origin = (c['lat'], c['lon'], c['alt_msl'])
        elif tp in ('NKF1', 'XKF1'):
            if getattr(m, 'C', 0) != 0:
                continue
            hiz_ekf = True
            c['vn'], c['ve'], c['vd'] = _num(m.VN), _num(m.VE), _num(m.VD)
        elif tp == 'CTUN':
            thr = getattr(m, 'ThO', None)
            if thr is None:
                thr = getattr(m, 'ThrOut', None)
            if thr is not None:
                c['thr'] = thr * 100 if thr <= 1.5 else thr
            a = _num(getattr(m, 'As', None))
            if a is not None and c['as'] is None:
                c['as'] = a
        elif tp == 'ARSP':
            if getattr(m, 'I', 0) in (0, None):
                c['as'] = _num(m.Airspeed)
        elif tp == 'ORGN':
            if getattr(m, 'Type', 0) == 0 and T.origin is None:
                T.origin = (m.Lat, m.Lng, _num(m.Alt))
        T.kare(t)
    # MODE adları firmware'den sonra çözülmüşse 'Mod N' → ad (dizin aynı kalır)
    if names and bekleyen_mod:
        for i, ad in enumerate(T.modes):
            if ad.startswith('Mod '):
                try:
                    yeni = names.get(int(ad[4:]))
                except ValueError:
                    yeni = None
                if yeni:
                    T.modes[i] = yeni
                    for e in T.events:
                        if e['text'] == f'Mod: {ad}':
                            e['text'] = f'Mod: {yeni}'
    return T.bitir('bin')


def _tlog_ayristir(path, hz):
    """MAVLink telemetri kaydı (.tlog: 8 bayt big-endian µs zaman damgası + paket)."""
    from pymavlink import mavutil
    from .flightlog import WARN_RE
    # mavlink_connection dosyada mmap'li mavmmaplog seçer; tanımsız/bozuk paketlerde (köprü kayıtları) ön indeksleme pymavlink içinde
    # düşer → akış okuyucu mavlogfile (robust_parsing: BAD_DATA atlanır).
    log = mavutil.mavlogfile(str(path), robust_parsing=True)
    T = _Toplayici(hz)
    sysid = None
    while True:
        m = log.recv_match(type=TLOG_TIPLERI)
        if m is None:
            break
        ts = getattr(m, '_timestamp', None)
        if not ts:
            continue
        if T.t0 is None:
            T.start_utc = datetime.fromtimestamp(ts, timezone.utc).isoformat()
        t = T.zaman(float(ts))
        tp = m.get_type()
        c = T.cur
        src = m.get_srcSystem()
        if tp == 'HEARTBEAT':
            if m.type in (6, 18) or m.autopilot == 8:   # GCS / yer bileşeni / geçersiz otopilot
                continue
            if sysid is None:
                sysid = src
                T.vehicle = {1: 'ArduPlane', 2: 'ArduCopter', 10: 'ArduRover', 12: 'ArduSub', 4: 'ArduHeli', 20: 'ArduPlane', 21: 'ArduPlane',
                             22: 'ArduPlane'}.get(m.type, 'MAVLink')
            if src != sysid:
                continue
            try:   # araç tipine göre custom_mode → mod adı (mode_string_v10 base_mode CUSTOM bayrağı ister; kayıtlarda her zaman yok)
                ad = (mavutil.mode_mapping_bynumber(m.type) or {}).get(m.custom_mode) or str(m.custom_mode)
            except Exception:   # noqa: BLE001
                ad = str(m.custom_mode)
            T.mod_degis(t, ad)
            T.arm(t, bool(m.base_mode & 128))
            continue
        if sysid is not None and src != sysid:
            continue
        if tp == 'GLOBAL_POSITION_INT':
            if m.lat or m.lon:
                c['lat'], c['lon'], c['alt_msl'] = m.lat / 1e7, m.lon / 1e7, m.alt / 1000.0
                c['vn'], c['ve'], c['vd'] = m.vx / 100.0, m.vy / 100.0, m.vz / 100.0
                if m.hdg != 65535:
                    c['hdg'] = m.hdg / 100.0
        elif tp == 'ATTITUDE':
            c['roll'], c['pitch'], c['yaw'] = m.roll, m.pitch, m.yaw
            if c['hdg'] is None:
                c['hdg'] = math.degrees(m.yaw) % 360.0
        elif tp in ('RC_CHANNELS', 'RC_CHANNELS_RAW'):
            c['rc'] = [int(getattr(m, f'chan{i}_raw', 0) or 0) for i in range(1, 9)]
        elif tp == 'SERVO_OUTPUT_RAW':
            c['servo'] = [int(getattr(m, f'servo{i}_raw', 0) or 0) for i in range(1, SERVO_N + 1)]
        elif tp == 'PARAM_VALUE':
            T.parametre(m.param_id, m.param_value)
            continue
        elif tp == 'SYS_STATUS':
            c['batt_v'] = m.voltage_battery / 1000.0 if m.voltage_battery not in (65535, 0) else c['batt_v']
            c['batt_pct'] = m.battery_remaining if m.battery_remaining >= 0 else None
        elif tp == 'VFR_HUD':
            c['as'], c['gs'], c['thr'] = _num(m.airspeed), _num(m.groundspeed), float(m.throttle)
            c['hdg'] = float(m.heading)
        elif tp == 'GPS_RAW_INT':
            c['fix'] = int(m.fix_type)
            c['sats'] = m.satellites_visible if m.satellites_visible != 255 else None
        elif tp == 'STATUSTEXT':
            text = str(m.text).rstrip('\x00')
            T.olay(t, text, m.severity if m.severity <= 4 else (4 if WARN_RE.search(text) else 6))
        elif tp == 'HOME_POSITION':
            if T.origin is None:
                T.origin = (m.latitude / 1e7, m.longitude / 1e7, m.altitude / 1000.0)
        T.kare(t)
    return T.bitir('tlog')


def ayristir(path, hz=REPLAY_HZ, ilerleme=None):
    """Log dosyasını kare dizisine çevirir (uzantıya göre .tlog → MAVLink, aksi DataFlash). ValueError: okunamaz / konum yok."""
    p = str(path)
    ext = os.path.splitext(p)[1].lower()
    if not os.path.isfile(p):
        raise ValueError('Log dosyası bulunamadı')
    try:
        if ext == '.tlog':
            return _tlog_ayristir(p, hz)
        return _bin_ayristir(p, hz, ilerleme)
    except ValueError:
        raise
    except Exception as e:   # noqa: BLE001 — pymavlink bozuk dosyada çeşitli hatalar üretir
        raise ValueError(f'Log çözümlenemedi: {e}') from e


def onbellek_meta(gz_path):
    """Önbellek dosyasından kareler olmadan meta (oturum için): v, hz, n, duration_s, home, takeoff_t, start_utc, vehicle, type, modes."""
    with gzip.open(gz_path, 'rt', encoding='utf-8') as f:
        d = json.load(f)
    if d.get('v') != ONBELLEK_SURUM:
        raise ValueError('eski önbellek')
    return {k: d.get(k) for k in ('v', 'hz', 'n', 'duration_s', 'home', 'takeoff_t', 'start_utc', 'vehicle', 'type', 'source')} | {'modes': d.get('modes')}


def hazirla(log_id, path, ilerleme=None):
    """Önbellek varsa (ve sürümü güncelse) metasını döner; yoksa ayrıştırır, gzip yazar (atomik), metayı döner. İş parçacığında çağrılır."""
    gz = onbellek_yolu(log_id)
    if gz.exists():
        try:
            return onbellek_meta(gz)
        except (OSError, ValueError, json.JSONDecodeError):
            gz.unlink(missing_ok=True)
    data = ayristir(path, ilerleme=ilerleme)
    tmp = gz.with_suffix('.tmp')
    with gzip.open(tmp, 'wt', encoding='utf-8', compresslevel=6) as f:
        json.dump(data, f, separators=(',', ':'), ensure_ascii=False)
    os.replace(tmp, gz)
    data.pop('frames', None)
    data.pop('events', None)
    return data


async def hazirla_async(log_id, path, ilerleme=None):
    """`hazirla` ayrı bir süreçte (python -m app.flightsim_replay <log_id> <yol>): pymavlink saf Python'dur ve GIL'i bırakmaz; iş
    parçacığında çalışsa sunucu olay döngüsü 250 MB'lık logda ~30 sn tıkanır. Alt süreç stdout'a `P <yüzde>` satırları, sonunda
    `OK <meta json>` ya da `ERR <mesaj>` yazar. ValueError: hata."""
    import sys
    proc = await asyncio.create_subprocess_exec(sys.executable, '-m', 'app.flightsim_replay', str(int(log_id)), str(path),
                                                stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL, cwd=str(config.BASE_DIR))
    meta, hata = None, None
    try:
        while True:
            satir = await proc.stdout.readline()
            if not satir:
                break
            s = satir.decode('utf-8', 'replace').rstrip('\n')
            if s.startswith('P ') and ilerleme:
                try:
                    ilerleme(int(s[2:]))
                except ValueError:
                    pass
            elif s.startswith('OK '):
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


def _main(argv):
    """Alt süreç girişi (hazirla_async): ilerleme satırları + sonuç."""
    import sys
    log_id, path = int(argv[0]), argv[1]
    son = [-1]

    def ilerleme(pct):
        pct = int(pct or 0)
        if pct - son[0] >= 5 or pct >= 100:
            son[0] = pct
            print(f'P {pct}', flush=True)
    try:
        meta = hazirla(log_id, path, ilerleme)
    except ValueError as e:
        print(f'ERR {e}', flush=True)
        sys.exit(1)
    print('OK ' + json.dumps(meta, ensure_ascii=False), flush=True)


# ======================================================================
# Kayıttan oynatma oturumu (SimSession ile aynı dış yüz; SITL/UDP yok, WS'te tele yok)
# ======================================================================
class ReplaySession:
    mode = 'replay'

    def __init__(self, sid, log, world, owner, yonetici):
        from . import flightsim
        self.id = int(sid)
        self.log = dict(log)                 # flight_logs satırı: id, file, file_name, size, aircraft, …
        self.world, self.owner, self.yonetici = world, owner, yonetici
        self.type = arac_tipi(log.get('vehicle'))
        # Sabit kanat kalkış yöntemi (§13) kayıtta da: world.launch (sunucu doğruladı) → session.launch; düzenek/aşamalar ön yüzde logdan türetilir
        # (sunucu `launch` olayı yaymaz, `phase` her zaman None). Tip HAZIR'da firmware'den kesinleşince yeniden normalize edilir.
        self.launch = flightsim.launch_normalize(self.type, (world or {}).get('launch'))
        # Merkez = kaydın kalkış noktası. Ayrıştırma bitmeden de bilinsin (ön yüz dünyayı doğru yerde kurar; §8 kök neden: BASLIYOR'da
        # center null → 3B dünya (0,0)'da yükleniyordu): uçuş logu analizinin özetindeki ev (home.lat/lng/alt) ön değer; ayrıştırma
        # sonucu (ilk ARM konumu) HAZIR'da üzerine yazar.
        self.center = {'id': None, 'name': log.get('file_name'), 'lat': _num(log.get('home_lat')), 'lon': _num(log.get('home_lon')),
                       'alt': _num(log.get('home_alt'))}
        self.state = 'BASLIYOR'
        self.udp_port = None
        self.created_at = db.now()
        self.started = time.time()
        self.sitl = {'pid': None, 'port': None, 'error': None}
        self.viewers = {}
        self.last_viewer = time.time()
        self.loop = None
        self.task = None
        self.end_reason = None
        self.client = None                   # CAYSIM istemcisi açtıysa {id, name} (docs/caysim-api.md)
        self.video = None                    # §21: ekran kaydı bağı (rec_finish → flightsim_runs.video_bagla)
        self.run_sonuc = None
        self.replay = {'log_id': int(log['id']), 'file_name': log.get('file_name'), 'size': log.get('size'), 'progress': 0, 'frames': None,
                       'duration_s': None, 'home': None, 'hz': REPLAY_HZ, 'takeoff_t': None, 'start_utc': None, 'vehicle': log.get('vehicle'),
                       'aircraft': log.get('aircraft'), 'pilot': log.get('pilot'), 'modes': None}
        self._fs = flightsim
        self.model = flightsim._model_eski(self.type, None)   # görsel model (§12): router kütüphaneden seçileni atar; yoksa tipin dahili modeli
        # §23: kaydın canlı oturumundaki güç/yakıt ayarları (drone_sim_runs.power → settings; bin_log_id = bu log) → ön yüz göstergeleri
        # aynı modeli (flightsim_power.js) karelerden hesaplar. Kayıt bu simülatörden değilse (dış .bin) None → gösterge yok.
        self.power = None
        # §22.3: kaydın canlı oturumundaki kamera türü (drone_sim_runs.camera) → kayıttan oynatma aynı türle açılır; yoksa ac_replay verilen türü atar
        self.camera = None
        try:
            with db.connect() as conn:
                r = db.row(conn.execute('SELECT power FROM drone_sim_runs WHERE bin_log_id = ? AND power IS NOT NULL ORDER BY id DESC LIMIT 1', (int(log['id']),)))
                c = db.row(conn.execute('SELECT camera FROM drone_sim_runs WHERE bin_log_id = ? AND camera IS NOT NULL ORDER BY id DESC LIMIT 1', (int(log['id']),)))
            if r and r.get('power'):
                self.power = (json.loads(r['power']) or {}).get('settings') or None
            if c and c.get('camera') in flightsim.KAMERA_TURLERI:
                self.camera = c['camera']
        except Exception:   # noqa: BLE001
            self.power = None

    # ---- dışa görünüm ----
    def to_dict(self, host=None):
        return {'id': self.id, 'mode': 'replay', 'type': self.type, 'model': dict(self.model) if self.model else None,
                'center': dict(self.center), 'world': dict(self.world), 'state': self.state, 'launch': {**self.launch, 'phase': None},
                'udp_port': None, 'host': host or self._fs.PUBLIC_HOST or None, 'created_at': self.created_at, 'owner': dict(self.owner),
                'client': dict(self.client) if self.client else None,
                'gcs': {'connected': False, 'addr': None, 'since': None}, 'sitl': dict(self.sitl), 'replay': dict(self.replay),
                'power': dict(self.power) if self.power else None, 'camera': self.camera or 'day'}

    def _yay(self, obj):
        txt = json.dumps(obj, ensure_ascii=False)
        for q in list(self.viewers.values()):
            self._fs._kuyruga(q, txt)

    def _olay(self, text, severity=6):
        self._yay({'t': 'event', 'text': str(text)[:300], 'severity': int(severity), 'ts': time.time()})

    def _durum(self, state):
        self.state = state
        self._yay({'t': 'state', 'state': state, 'replay': dict(self.replay), 'center': dict(self.center)})   # center: ön yüz dünyayı kalkış noktasına taşır (§8)

    def izleyici_ekle(self, ws):
        q = asyncio.Queue(maxsize=self._fs.VIEWER_QUEUE)
        self.viewers[ws] = q
        self.last_viewer = time.time()
        return q

    def izleyici_sil(self, ws):
        self.viewers.pop(ws, None)
        self.last_viewer = time.time()

    # ---- komutlar: yalnız reset (ön yüz "Baştan"; izleyicilere olay) ----
    async def komut(self, name, params, kaynak=None):
        if name == 'camera':   # §22.3: izleyici türü değiştirdi (kayıt satırına yazılır)
            self.camera = self._fs.kamera_dogrula((params or {}).get('type'), self.camera or 'day')
            return {'ok': True, 'camera': self.camera}
        if name != 'reset':
            raise self._fs.SimHata('invalid', 'Kayıttan oynatma oturumunda komut verilemez (yalnız reset)')
        if self.state == 'KAPANDI':
            raise self._fs.SimHata('invalid', 'Oturum kapandı')
        self._yay({'t': 'replay', 'action': 'reset', 'by': (self.owner or {}).get('name')})
        return {'ok': True}

    async def rc(self, ch):
        return None   # kayıtta RC yok; sessizce yoksay

    async def reset(self):
        return await self.komut('reset', {})

    # ---- yaşam döngüsü ----
    def _ilerleme(self, pct):   # olay döngüsünde çağrılır (hazirla_async)
        pct = int(pct or 0)
        if pct - self.replay['progress'] >= 10 or pct >= 100:
            self.replay['progress'] = pct
            self._yay({'t': 'state', 'state': self.state, 'replay': dict(self.replay)})

    async def run(self):
        self.loop = asyncio.get_running_loop()
        try:
            yol = config.UPLOAD_DIR / self.log['file']
            self._olay(f'Kayıt hazırlanıyor: {self.log.get("file_name")}', 6)
            try:
                meta = await hazirla_async(self.log['id'], yol, self._ilerleme)
            except ValueError as e:
                self.sitl['error'] = str(e)
                self._olay(str(e), 2)
                self._durum('HATA')
                meta = None
            if meta:
                self.replay.update(progress=100, frames=meta.get('n'), duration_s=meta.get('duration_s'), home=meta.get('home'), hz=meta.get('hz'),
                                   takeoff_t=meta.get('takeoff_t'), start_utc=meta.get('start_utc'), vehicle=meta.get('vehicle') or self.replay['vehicle'],
                                   modes=meta.get('modes'))
                self.type = meta.get('type') or self.type
                self.launch = self._fs.launch_normalize(self.type, self.world.get('launch'))
                h = meta.get('home') or {}
                self.center.update(lat=h.get('lat'), lon=h.get('lon'), alt=h.get('alt'))
                self._olay(f'Kayıt hazır: {meta.get("n")} kare · {meta.get("duration_s")} sn', 6)
                self._durum('HAZIR')
            await self._dongu()
        except asyncio.CancelledError:
            pass
        except Exception as e:   # noqa: BLE001
            self.sitl['error'] = f'Oturum hatası: {e}'[:300]
            self._olay(self.sitl['error'], 2)
        finally:
            await self._temizle()

    async def _dongu(self):
        """1 sn: izleyici yok → BOSTA_SURE sonra kapanır; MAX_MINUTES dolunca kapanır."""
        while True:
            await asyncio.sleep(1.0)
            now = time.time()
            if self.viewers:
                self.last_viewer = now
            if not self.viewers and now - self.last_viewer > self._fs.BOSTA_SURE:
                self.end_reason = 'bosta'
                return
            if now - self.started > self._fs.MAX_MINUTES * 60:
                self.end_reason = 'sure'
                return

    async def kapat(self, reason='kapatildi'):
        if self.state == 'KAPANDI':
            return
        self.end_reason = self.end_reason or reason
        if self.task is not None and not self.task.done() and self.task is not asyncio.current_task():
            self.task.cancel()
            try:
                await asyncio.wait_for(asyncio.shield(self.task), 10)
            except (asyncio.CancelledError, asyncio.TimeoutError, Exception):   # noqa: BLE001
                pass
        else:
            await self._temizle()

    async def _temizle(self):
        if self.state == 'KAPANDI':
            return
        self.state = 'KAPANDI'
        # §21: kayıttan oynatma oturumu da Simülasyon Kayıtları'na düşer (mode replay, kaynak log; parametre/script yok)
        from . import flightsim_runs
        run = None
        try:
            run = await asyncio.get_running_loop().run_in_executor(None, flightsim_runs.kaydet, self)
        except Exception:   # noqa: BLE001 — kayıt hatası kapanışı bozmasın
            run = None
        self.run_sonuc = run
        self._yay({'t': 'end', 'reason': self.end_reason or 'kapatildi', 'run': dict(run) if run else None})
        self.yonetici.sessions.pop(self.id, None)


def log_izinli(user, log):
    """flightlogs yetkisi (routers/flightlogs.get_log ile aynı): `tools` → her log; `field` → yalnız göreve bağlı log."""
    mods = set(user.get('modules') or [])
    if 'tools' in mods:
        return True
    return bool(log.get('task_id')) and 'field' in mods


def loglari_listele(conn, user, q=None, limit=300):
    """Kayıttan oynatılabilir loglar (status TAMAM, desteklenen uzantı) — kullanıcının flightlogs yetkisiyle kesişim."""
    mods = set(user.get('modules') or [])
    if 'tools' not in mods and 'field' not in mods:
        return []
    sql = '''SELECT l.id, l.task_id, l.file, l.file_name, l.size, l.status, l.aircraft, l.pilot, l.location, l.note, l.uploaded_at, l.source,
                    u.full_name AS uploaded_by_name, t.code AS task_code,
                    json_extract(l.analysis, '$.summary.vehicle') AS vehicle,
                    json_extract(l.analysis, '$.summary.flight_s') AS flight_s,
                    json_extract(l.analysis, '$.summary.duration_s') AS duration_s,
                    json_extract(l.analysis, '$.summary.takeoff_utc') AS takeoff_utc,
                    json_extract(l.analysis, '$.summary.start_utc') AS start_utc,
                    json_extract(l.analysis, '$.summary.home.lat') AS home_lat,
                    json_extract(l.analysis, '$.summary.home.lng') AS home_lon,
                    json_extract(l.analysis, '$.summary.distance_m') AS distance_m
             FROM flight_logs l LEFT JOIN users u ON u.id = l.uploaded_by LEFT JOIN field_tasks t ON t.id = l.task_id
             WHERE l.status = 'TAMAM' '''
    args = []
    if 'tools' not in mods:
        sql += ' AND l.task_id IS NOT NULL'
    if q:
        like = f'%{q.strip()}%'
        sql += ' AND (l.file_name LIKE ? OR l.aircraft LIKE ? OR l.pilot LIKE ? OR l.location LIKE ? OR t.code LIKE ? OR l.note LIKE ?)'
        args += [like] * 6
    sql += ' ORDER BY l.id DESC LIMIT ?'
    args.append(int(limit))
    rows = db.rows(conn.execute(sql, args))
    out = []
    for r in rows:
        ext = os.path.splitext(r['file_name'] or r['file'] or '')[1].lower()
        if ext and ext not in UZANTILAR:
            continue
        r['ext'] = ext.lstrip('.')
        r['type'] = arac_tipi(r.get('vehicle'))
        r['cached'] = onbellek_yolu(r['id']).exists()
        out.append(r)
    return out


def log_getir(conn, lid):
    return db.row(conn.execute('''SELECT l.id, l.task_id, l.file, l.file_name, l.size, l.status, l.aircraft, l.pilot, l.location,
                                         json_extract(l.analysis, '$.summary.vehicle') AS vehicle,
                                         json_extract(l.analysis, '$.summary.home.lat') AS home_lat,
                                         json_extract(l.analysis, '$.summary.home.lng') AS home_lon,
                                         json_extract(l.analysis, '$.summary.home.alt') AS home_alt
                                  FROM flight_logs l WHERE l.id = ?''', (lid,)))


if __name__ == '__main__':
    import sys as _sys
    _main(_sys.argv[1:])
