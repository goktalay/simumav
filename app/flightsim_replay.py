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
import contextlib
import gzip
import json
import math
import os
import re
import time
from datetime import datetime, timezone

import numpy as np

from . import config, db

REPLAY_HZ = int(os.environ.get('SIM_REPLAY_HZ', '25'))          # 20–50 Hz
REPLAY_MAX_FRAMES = 150000                                       # üstü seyreltilir (2 saat × 25 Hz = 180k)
MAX_EVENTS = 400
ONBELLEK_SURUM = 5   # 5: hızlı ikili yol (tam ızgara) + büyük kayıtta LOD genel bakış ve zaman parçaları (`lod`) · 3: `servo` kare alanı + `servo_fn` (kayıtta kontrol yüzeyleri) · 4: `body` (SITL SIM gövde yönelimi; §25 tailsitter) + `t0`
FIELDS = ['t', 'lat', 'lon', 'alt_msl', 'alt_rel', 'roll', 'pitch', 'yaw', 'vn', 've', 'vd', 'gs', 'as', 'hdg', 'thr', 'mode', 'armed',
          'batt_v', 'batt_pct', 'sats', 'fix', 'rc', 'servo', 'body']
# SIM: SITL fiziğinin gerçek yönelimi (yalnız SITL .bin'lerinde; derece) → `body` [roll, pitch, yaw] rad — INTERCEPTOR kaydında ATT Q kiplerinde
# "VTOL görünümü"dür (askıda pitch ≈ 0); 3B gövde `body` ile çizilir (canlıdaki tele.att_body eşleniği)
BIN_TIPLERI = ['GPS', 'POS', 'ATT', 'RCIN', 'RCOU', 'BAT', 'CURR', 'MODE', 'ARM', 'EV', 'STAT', 'MSG', 'NKF1', 'XKF1', 'CTUN', 'ARSP', 'ORGN', 'PARM', 'SIM']
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
                    'sats': None, 'fix': None, 'rc': None, 'servo': None, 'body': None}
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
                            list(c['rc']) if c['rc'] else None, list(c['servo']) if c['servo'] else None, list(c['body']) if c.get('body') else None])

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
                'n': len(frames), 'source': kaynak, 'servo_fn': list(self.servo_fn),
                't0': _r(self.t0, 3)}   # kare t = 0 anının kaynak saati (sn; SITL .bin'de time_boot) — §24 hedef yörüngeleri tt = t0 + t ile canlıdakiyle aynı


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
        elif tp == 'SIM':
            try:
                c['body'] = [round(math.radians(float(m.Roll)), 4), round(math.radians(float(m.Pitch)), 4), round(math.radians(float(m.Yaw)), 4)]
            except (AttributeError, TypeError, ValueError):
                pass
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



# ======================================================================
# Hızlı ikili DataFlash yolu (dataflash.oku + numpy): akış halinde okuma, sabit ızgaraya sample-and-hold yeniden örnekleme.
# 700 MB / 3+ saatlik gerçek uçuşta pymavlink yolu ~2 dk ve ~2 GB RSS idi (ilerleme indekslemede %100'e çıkıp kalıyordu);
# bu yol ~10 sn ve ~0,4 GB, ilerleme okunan bayta göre gerçek. Kare anlamı `_bin_ayristir` ile aynıdır (alan sırası FIELDS).
# ======================================================================
BIN_SUTUNLAR = {
    'GPS': ['TimeUS', 'TimeMS', 'I', 'Instance', 'Status', 'NSats', 'Lat', 'Lng', 'Alt', 'Spd', 'GCrs', 'VZ', 'GWk', 'GMS'],
    'POS': ['TimeUS', 'Lat', 'Lng', 'Alt'],
    'ATT': ['TimeUS', 'TimeMS', 'Roll', 'Pitch', 'Yaw'],
    'SIM': ['TimeUS', 'Roll', 'Pitch', 'Yaw'],
    'RCIN': ['TimeUS', 'TimeMS'] + [f'C{i}' for i in range(1, SERVO_N + 1)],
    'RCOU': ['TimeUS', 'TimeMS'] + [f'C{i}' for i in range(1, SERVO_N + 1)],
    'BAT': ['TimeUS', 'Inst', 'Instance', 'Volt', 'RemPct'],
    'CURR': ['TimeUS', 'TimeMS', 'Inst', 'Instance', 'Volt'],
    'MODE': ['TimeUS', 'TimeMS', 'Mode', 'ModeNum'],
    'ARM': ['TimeUS', 'ArmState'],
    'EV': ['TimeUS', 'TimeMS', 'Id'],
    'STAT': ['TimeUS', 'Armed'],
    'MSG': ['TimeUS', 'TimeMS', 'Message'],
    'NKF1': ['TimeUS', 'C', 'VN', 'VE', 'VD'],
    'XKF1': ['TimeUS', 'C', 'VN', 'VE', 'VD'],
    'CTUN': ['TimeUS', 'TimeMS', 'ThO', 'ThrOut', 'As'],
    'ARSP': ['TimeUS', 'I', 'Airspeed'],
    'ORGN': ['TimeUS', 'Type', 'Lat', 'Lng', 'Alt'],
    'PARM': ['TimeUS', 'TimeMS', 'Name', 'Value'],
}
_ARAC_ONEKI = ('ArduPlane', 'ArduCopter', 'ArduRover', 'ArduSub', 'ArduHeli', 'Blimp')


def _zaman_dizisi(cols):
    from . import dataflash
    return dataflash.zaman(cols)


def _tut(zaman, deger, izgara):
    """Sample-and-hold: ızgaradaki her an için o ana kadarki son değer (öncesi NaN). `deger` (n,) ya da (n, k)."""
    if zaman is None or not len(zaman):
        shp = (len(izgara),) + tuple(np.shape(deger)[1:])
        return np.full(shp, np.nan, dtype=np.float32)
    i = np.searchsorted(zaman, izgara, side='right') - 1
    out = deger[np.maximum(i, 0)].astype(np.float64 if deger.dtype == np.float64 else np.float32, copy=True)
    if out.ndim == 1:
        out[i < 0] = np.nan
    else:
        out[i < 0, :] = np.nan
    return out


def _sec(cols, maske):
    return {k: (v[maske] if hasattr(v, 'shape') else [x for x, m in zip(v, maske) if m]) for k, v in cols.items()}


def _orn0(cols, ad='I'):
    """Örnek (instance) 0 maskesi: I / Inst / Instance sütunu yoksa hepsi."""
    for k in (ad, 'Inst', 'Instance'):
        if k in cols:
            v = cols[k]
            return np.isnan(v) | (v == 0)
    return None


def _bin_hizli(path, hz, ilerleme=None):
    """İkili DataFlash → {meta…, 'K': {alan: np.ndarray}} (kareler sütunlu; `frames` yok). ValueError: konum yok."""
    from . import dataflash
    from .flightlog import WARN_RE
    D = dataflash.oku(str(path), BIN_SUTUNLAR, ilerleme=(lambda y: ilerleme(int(y * 0.8))) if ilerleme else None)
    zam = {}
    for ad, cols in list(D.items()):
        z = dataflash.zaman(cols)
        if z is None or not len(z):
            D.pop(ad)
            continue
        zam[ad] = z
    if not zam:
        raise ValueError('Logda kayıttan oynatma için konum verisi yok')
    t0 = min(float(z[0]) for z in zam.values())
    for ad in zam:
        zam[ad] = zam[ad] - t0
    T = _Toplayici(hz)
    T.t0 = t0
    # --- araç (firmware) ---
    msg = D.get('MSG')
    if msg:
        T.vehicle = next((m for m in msg['Message'] if m.startswith(_ARAC_ONEKI)), None)
    names = _mode_names(T.vehicle) if T.vehicle else {}
    # --- konum: POS (EKF) varsa ilk POS'tan sonra o, öncesinde GPS (fix ≥ 3) ---
    gps = D.get('GPS')
    g0 = None
    if gps:
        m0 = _orn0(gps)
        g0 = _sec(gps, m0) if m0 is not None else gps
        zg = _zaman_dizisi(g0) - t0
        g_fix = g0['Status'] >= 3 if 'Status' in g0 else np.ones(len(zg), bool)
    pos = D.get('POS')
    if pos:
        pm = (pos['Lat'] != 0) & (pos['Lng'] != 0)
        pos = _sec(pos, pm)
        zp = zam['POS'][pm]
        if not len(zp):
            pos = None
    gps_fix = None
    if g0 is not None and g_fix.any():
        gps_fix = {k: g0[k][g_fix] for k in ('Lat', 'Lng', 'Alt', 'Spd', 'GCrs', 'VZ') if k in g0}
        zgf = zg[g_fix]
    ilk = [x for x in ((zp[0] if pos else None), (zgf[0] if gps_fix else None)) if x is not None]
    if not ilk:
        raise ValueError('Logda kayıttan oynatma için konum verisi yok')
    bas = float(min(ilk))
    son = float(max(z[-1] for z in zam.values()))
    izgara = np.arange(bas, son + 1e-9, 1.0 / hz)
    if len(izgara) < 2:
        raise ValueError('Logda kayıttan oynatma için konum verisi yok')
    n = len(izgara)
    K = {'t': izgara}
    lat = np.full(n, np.nan); lon = np.full(n, np.nan); alt = np.full(n, np.nan)
    gps_alt_h = None
    if gps_fix:
        lat = _tut(zgf, gps_fix['Lat'], izgara); lon = _tut(zgf, gps_fix['Lng'], izgara)
        gps_alt_h = _tut(zgf, gps_fix['Alt'], izgara) if 'Alt' in gps_fix else None
        alt = gps_alt_h.astype(np.float64) if gps_alt_h is not None else alt
    if pos:
        sonra = izgara >= zp[0]
        plat, plon = _tut(zp, pos['Lat'], izgara), _tut(zp, pos['Lng'], izgara)
        palt = _tut(zp, pos['Alt'], izgara).astype(np.float64) if 'Alt' in pos else np.full(n, np.nan)
        if gps_alt_h is not None:
            palt = np.where(np.isnan(palt), gps_alt_h, palt)
        lat[sonra], lon[sonra], alt[sonra] = plat[sonra], plon[sonra], palt[sonra]
    K['lat'], K['lon'], K['alt_msl'] = lat, lon, alt
    # --- yönelim ---
    att = D.get('ATT')
    if att:
        za = zam['ATT']
        for k, a in (('roll', 'Roll'), ('pitch', 'Pitch'), ('yaw', 'Yaw')):
            v = _tut(za, np.radians(att[a].astype(np.float64)), izgara)
            K[k] = np.where(np.isnan(v), 0.0, v)
        K['hdg'] = _tut(za, np.mod(att['Yaw'].astype(np.float64), 360.0), izgara)
    else:
        K['roll'] = K['pitch'] = K['yaw'] = np.zeros(n)
        K['hdg'] = np.full(n, np.nan)
    sim = D.get('SIM')
    K['body'] = (np.stack([_tut(zam['SIM'], np.radians(sim[a].astype(np.float64)), izgara) for a in ('Roll', 'Pitch', 'Yaw')], axis=1)
                 if sim else None)
    # --- hız: GPS (yer hızı + rota) · EKF (NKF1/XKF1 çekirdek 0) ilk EKF anından sonra ---
    K['gs'] = _tut(zgf, gps_fix['Spd'], izgara) if gps_fix and 'Spd' in gps_fix else np.full(n, np.nan, np.float32)
    vn = np.full(n, np.nan); ve = np.full(n, np.nan); vd = np.full(n, np.nan)
    if gps_fix and 'Spd' in gps_fix:
        crs = np.radians(np.nan_to_num(gps_fix['GCrs'].astype(np.float64))) if 'GCrs' in gps_fix else np.zeros(len(zgf))
        spd = gps_fix['Spd'].astype(np.float64)
        vn, ve = _tut(zgf, spd * np.cos(crs), izgara), _tut(zgf, spd * np.sin(crs), izgara)
        if 'VZ' in gps_fix:
            vd = _tut(zgf, -gps_fix['VZ'].astype(np.float64), izgara)
    ekf_ad = 'XKF1' if 'XKF1' in D else ('NKF1' if 'NKF1' in D else None)
    if ekf_ad:
        e = D[ekf_ad]
        em = (np.isnan(e['C']) | (e['C'] == 0)) if 'C' in e else np.ones(len(zam[ekf_ad]), bool)
        ze = zam[ekf_ad][em]
        if len(ze):
            sonra = izgara >= ze[0]
            for hedef, a in ((vn, 'VN'), (ve, 'VE'), (vd, 'VD')):
                hedef[sonra] = _tut(ze, e[a][em], izgara)[sonra]
    K['vn'], K['ve'], K['vd'] = vn, ve, vd
    # --- hava hızı: ARSP (örnek 0); yoksa CTUN.As · gaz: CTUN ThO / ThrOut (≤ 1,5 ise oran → %) ---
    ctun = D.get('CTUN')
    arsp = D.get('ARSP')
    if arsp:
        am = _orn0(arsp)
        am = am if am is not None else np.ones(len(zam['ARSP']), bool)
        K['as'] = _tut(zam['ARSP'][am], arsp['Airspeed'][am], izgara)
    elif ctun and 'As' in ctun:
        K['as'] = _tut(zam['CTUN'], ctun['As'], izgara)
    else:
        K['as'] = np.full(n, np.nan, np.float32)
    if ctun and ('ThO' in ctun or 'ThrOut' in ctun):
        thr = (ctun['ThO'] if 'ThO' in ctun else ctun['ThrOut']).astype(np.float64)
        thr = np.where(thr <= 1.5, thr * 100.0, thr)
        K['thr'] = _tut(zam['CTUN'], thr, izgara)
    else:
        K['thr'] = np.full(n, np.nan, np.float32)
    # --- batarya: BAT (yoksa CURR) örnek 0, Volt > 0,5 ---
    bat_ad = 'BAT' if 'BAT' in D else ('CURR' if 'CURR' in D else None)
    K['batt_v'] = K['batt_pct'] = np.full(n, np.nan, np.float32)
    if bat_ad:
        b = D[bat_ad]
        bm = _orn0(b, 'Inst')
        bm = bm if bm is not None else np.ones(len(zam[bat_ad]), bool)
        if 'Volt' in b:
            vm = bm & (b['Volt'] > 0.5)
            K['batt_v'] = _tut(zam[bat_ad][vm], b['Volt'][vm], izgara)
        if 'RemPct' in b:
            pm_ = bm & (b['RemPct'] >= 0)
            K['batt_pct'] = np.floor(_tut(zam[bat_ad][pm_], b['RemPct'][pm_], izgara))
    # --- GPS durumu ---
    if g0 is not None:
        K['fix'] = _tut(zg, g0['Status'], izgara) if 'Status' in g0 else np.full(n, np.nan, np.float32)
        K['sats'] = _tut(zg, g0['NSats'], izgara) if 'NSats' in g0 else np.full(n, np.nan, np.float32)
        if T.start_utc is None and 'GWk' in g0 and 'GMS' in g0:
            ok = g_fix & (g0['GWk'] > 0)
            if ok.any():
                i = int(np.argmax(ok))
                unix = 315964800 + float(g0['GWk'][i]) * 604800 + float(g0['GMS'][i]) / 1000.0 - 18 - float(zg[i])
                T.start_utc = datetime.fromtimestamp(unix, timezone.utc).isoformat()
    else:
        K['fix'] = K['sats'] = np.full(n, np.nan, np.float32)
    # --- RC girişi / servo çıkışı (8 kanal) ---
    for alan, ad in (('rc', 'RCIN'), ('servo', 'RCOU')):
        r = D.get(ad)
        if r:
            m8 = np.stack([np.nan_to_num(r[f'C{i}']) if f'C{i}' in r else np.zeros(len(zam[ad]), np.float32) for i in range(1, SERVO_N + 1)], axis=1)
            K[alan] = _tut(zam[ad], m8.astype(np.float32), izgara)
        else:
            K[alan] = None
    # --- seyrek olaylar (zaman sırasıyla): MSG, MODE, ARM/STAT/EV, ORGN, PARM ---
    def konum_an(t):
        i = int(np.searchsorted(izgara, t, side='right')) - 1
        if i < 0 or np.isnan(lat[i]):
            return None
        return (float(lat[i]), float(lon[i]), None if np.isnan(alt[i]) else float(alt[i]))

    olaylar = []   # (t, sıra, tür, değer)
    if msg:
        for t, txt in zip(zam['MSG'].tolist(), msg['Message']):
            olaylar.append((t, 0, 'msg', txt))
    if 'MODE' in D:
        md = D['MODE']
        num = md['ModeNum'] if 'ModeNum' in md else md.get('Mode')
        if num is not None:
            for t, v in zip(zam['MODE'].tolist(), num.tolist()):
                olaylar.append((t, 1, 'mode', None if v != v else int(v)))
    if 'ARM' in D:
        for t, v in zip(zam['ARM'].tolist(), D['ARM']['ArmState'].tolist()):
            olaylar.append((t, 2, 'arm', bool(v)))
    if 'STAT' in D and 'Armed' in D['STAT']:
        a_ = D['STAT']['Armed']
        degis = np.flatnonzero(np.concatenate([[True], a_[1:] != a_[:-1]]))   # yalnız geçişler (T.arm tekrarı yok sayar)
        for i in degis.tolist():
            olaylar.append((float(zam['STAT'][i]), 2, 'arm', bool(a_[i])))
    if 'EV' in D:
        for t, v in zip(zam['EV'].tolist(), D['EV']['Id'].tolist()):
            if v in (10, 11):
                olaylar.append((t, 2, 'arm', v == 10))
            elif v == 25:
                olaylar.append((t, 3, 'ev25', None))
    if 'ORGN' in D:
        o = D['ORGN']
        for i, t in enumerate(zam['ORGN'].tolist()):
            if ('Type' not in o or o['Type'][i] == 0) and T.origin is None:
                olaylar.append((t, 3, 'orgn', (float(o['Lat'][i]), float(o['Lng'][i]), _num(float(o['Alt'][i])) if 'Alt' in o else None)))
                break
    if 'PARM' in D:
        p_ = D['PARM']
        for ad, v in zip(p_['Name'], p_['Value'].tolist()):
            if ad.startswith('SERVO'):
                T.parametre(ad, v)
    olaylar.sort(key=lambda x: (x[0], x[1]))
    mod_adim, arm_adim = [], []   # (t, değer) basamak fonksiyonları
    for t, _s, tur, v in olaylar:
        if tur == 'msg':
            T.olay(t, v, 4 if WARN_RE.search(v) else 6)
        elif tur == 'mode':
            onceki = T.cur['mode']
            T.mod_degis(t, names.get(v, f'Mod {v}'))
            if T.cur['mode'] != onceki:
                mod_adim.append((t, T.cur['mode']))
        elif tur == 'arm':
            k = konum_an(t)
            T.cur['lat'], T.cur['lon'], T.cur['alt_msl'] = (k if k else (None, None, None))
            onceki = T.cur['armed']
            T.arm(t, v)
            if T.cur['armed'] != onceki:
                arm_adim.append((t, T.cur['armed']))
        elif tur == 'ev25':
            k = konum_an(t)
            if k and T.origin is None:
                T.origin = k
        elif tur == 'orgn':
            if T.origin is None:
                T.origin = v
    if T.home_bekliyor and T.home is None:   # ARM konumdan önce: ilk konum (ızgaranın ilk karesi)
        T.home = (float(lat[0]), float(lon[0]), 0.0 if np.isnan(alt[0]) else float(alt[0]))

    def basamak(adim, bos):
        if not adim:
            return np.full(n, bos, np.float32)
        zt = np.array([a for a, _ in adim]); dv = np.array([np.nan if b is None else b for _, b in adim], np.float32)
        out = _tut(zt, dv, izgara)
        return np.where(np.isnan(out), bos, out)
    K['mode'] = basamak(mod_adim, np.nan)
    K['armed'] = basamak(arm_adim, 0)
    del D
    return _bitir_kolon(T, K, 'bin')


def _bitir_kolon(T, K, kaynak):
    """_Toplayici.bitir'in sütunlu karşılığı: ev (ilk ARM / ORGN / ilk kare), alt_rel, kalkış anı (ilk havalanma öncesi son ARM)."""
    t = K['t']
    n = len(t)
    home = T.home or T.origin
    if home is None:
        home = (float(K['lat'][0]), float(K['lon'][0]), 0.0 if np.isnan(K['alt_msl'][0]) else float(K['alt_msl'][0]))
    if home[2] is None:
        home = (home[0], home[1], 0.0 if np.isnan(K['alt_msl'][0]) else float(K['alt_msl'][0]))
    alt = K['alt_msl']
    K['alt_rel'] = np.where(np.isnan(alt), 0.0, alt - home[2])
    gs = np.nan_to_num(K['gs'])
    havada_m = (K['alt_rel'] > 5) & (gs > 3)
    if havada_m.any():
        havada = float(t[int(np.argmax(havada_m))])
        onceki = [a for a in T.arm_times if a <= havada]
        T.takeoff_t = onceki[-1] if onceki else (T.takeoff_t if T.takeoff_t is not None else havada)
        if T.takeoff_t is not None and havada - T.takeoff_t > 120:
            T.takeoff_t = max(T.takeoff_t, havada - 10)
        if T.takeoff_t is not None:
            i = int(np.searchsorted(t, T.takeoff_t - 1e-9))
            if i < n and not np.isnan(alt[i]) and abs(alt[i] - home[2]) > 0.5:
                home = (home[0], home[1], float(alt[i]))
                K['alt_rel'] = np.where(np.isnan(alt), 0.0, alt - home[2])
    return {'v': ONBELLEK_SURUM, 'hz': T.hz, 'fields': FIELDS, 'K': K, 'modes': T.modes, 'events': T.events,
            'duration_s': _r(float(t[-1]), 2), 'home': {'lat': round(home[0], 7), 'lon': round(home[1], 7), 'alt': _r(home[2], 2)},
            'takeoff_t': _r(T.takeoff_t, 2), 'start_utc': T.start_utc, 'vehicle': T.vehicle, 'type': arac_tipi(T.vehicle),
            'n': n, 'source': kaynak, 'servo_fn': list(T.servo_fn), 't0': _r(T.t0, 3)}


# kare alanı → (yuvarlama basamağı | 'i' tamsayı)
_YUV = {'t': 3, 'lat': 7, 'lon': 7, 'alt_msl': 2, 'alt_rel': 2, 'roll': 4, 'pitch': 4, 'yaw': 4, 'vn': 2, 've': 2, 'vd': 2, 'gs': 2, 'as': 2,
        'hdg': 1, 'thr': 1, 'mode': 'i', 'armed': 'i', 'batt_v': 2, 'batt_pct': 'i', 'sats': 'i', 'fix': 'i'}


def _liste(v, yuv):
    """np dizisi → JSON listesi: NaN → None, yuvarlama / tamsayı."""
    if yuv == 'i':
        nan = np.isnan(v)
        out = v.astype(np.float64)
        out = np.where(nan, 0, out).astype(np.int64).tolist()
        if nan.any():
            for i in np.flatnonzero(nan).tolist():
                out[i] = None
        return out
    out = np.round(v.astype(np.float64), yuv).tolist()
    if np.isnan(v).any():
        out = [None if x != x else x for x in out]
    return out


def kareler(K, a=0, b=None, adim=1):
    """Sütunlu kareler → [[t, lat, …, rc, servo, body]] (FIELDS sırası) — [a:b:adim] dilimi."""
    sl = slice(a, b, adim)
    n = len(K['t'][sl])
    sut = []
    for f in FIELDS:
        if f in _YUV:
            sut.append(_liste(K[f][sl], _YUV[f]))
        elif f in ('rc', 'servo'):
            m = K.get(f)
            if m is None:
                sut.append([None] * n)
            else:
                mm = m[sl]
                bos = np.isnan(mm[:, 0])
                rows = np.nan_to_num(mm).astype(np.int64).tolist()
                sut.append([None if e else r for r, e in zip(rows, bos.tolist())])
        elif f == 'body':
            m = K.get('body')
            if m is None:
                sut.append([None] * n)
            else:
                mm = m[sl]
                bos = np.isnan(mm[:, 0])
                rows = np.round(np.nan_to_num(mm).astype(np.float64), 4).tolist()
                sut.append([None if e else r for r, e in zip(rows, bos.tolist())])
    return [list(r) for r in zip(*sut)]


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


def _ayristir_ham(path, hz=REPLAY_HZ, ilerleme=None):
    """Uzantı/içeriğe göre ayrıştırıcı: .tlog → MAVLink; ikili DataFlash (A3 95) → hızlı sütunlu yol (`K`); metin .log → pymavlink."""
    from . import dataflash
    p = str(path)
    ext = os.path.splitext(p)[1].lower()
    if not os.path.isfile(p):
        raise ValueError('Log dosyası bulunamadı')
    try:
        if ext == '.tlog':
            return _tlog_ayristir(p, hz)
        if dataflash.ikili_mi(p):
            return _bin_hizli(p, hz, ilerleme)
        return _bin_ayristir(p, hz, ilerleme)
    except ValueError:
        raise
    except Exception as e:   # noqa: BLE001 — bozuk dosyada çeşitli hatalar
        raise ValueError(f'Log çözümlenemedi: {e}') from e


def ayristir(path, hz=REPLAY_HZ, ilerleme=None):
    """Log dosyasını kare dizisine çevirir (`frames` listesi; FIELDS sırası). ValueError: okunamaz / konum yok.
    Büyük kayıtlarda bellek için `hazirla` kullanılır (kareleri parça parça yazar); bu işlev tüm kareleri listeye çevirir."""
    d = _ayristir_ham(path, hz, ilerleme)
    if 'K' in d:
        d['frames'] = kareler(d.pop('K'))
    return d


# ---- önbellek (v5): küçük kayıt tek dosya; büyük kayıt = genel bakış (LOD) + zaman parçaları ----
TEK_PARCA_KARE = int(os.environ.get('SIM_REPLAY_TEK_PARCA', '45000'))   # 25 Hz'de 30 dk; üstü parçalı
PARCA_S = 120                                                            # parça süresi (sn)
GENEL_HZ = 1.0                                                           # büyük kayıtta genel bakış kare hızı


def onbellek_parca_yolu(log_id, k):
    return onbellek_dizini() / f'{int(log_id)}.p{int(k)}.json.gz'


def onbellek_sil(log_id):
    """Kaydın tüm önbellek dosyaları (meta + parçalar)."""
    d = onbellek_dizini()
    for f in [onbellek_yolu(log_id)] + list(d.glob(f'{int(log_id)}.p*.json.gz')):
        try:
            f.unlink(missing_ok=True)
        except OSError:
            pass


def onbellek_boyutu(log_id):
    d = onbellek_dizini()
    return sum(f.stat().st_size for f in [onbellek_yolu(log_id)] + list(d.glob(f'{int(log_id)}.p*.json.gz')) if f.exists())


def _gz_yaz(yol, obj, seviye=6):
    """Atomik gzip JSON yazımı. Tek seferde dumps + compress (gzip metin akışına json.dump binlerce küçük yazım yapar: ~2× yavaş)."""
    tmp = yol.with_name(yol.name + '.tmp')
    with open(tmp, 'wb') as f:
        f.write(gzip.compress(json.dumps(obj, separators=(',', ':'), ensure_ascii=False).encode('utf-8'), seviye, mtime=0))
    os.replace(tmp, yol)


ISCI = max(1, int(os.environ.get('SIM_REPLAY_ISCI', '4') or 4))   # parça yazımında paralel süreç (alt süreçte; fork)
_PK = None   # fork edilen işçilerin paylaştığı sütunlu kareler (yazarken kopyalanır; salt okunur)


def _parca_yaz(is_):
    log_id, k, a, b = is_
    _gz_yaz(onbellek_parca_yolu(log_id, k), {'v': ONBELLEK_SURUM, 'k': k, 'a': a, 'frames': kareler(_PK, a, b)}, 5)
    return k


def onbellek_meta(gz_path):
    """Önbellek dosyasından kareler olmadan meta (oturum için): v, hz, n, duration_s, home, takeoff_t, start_utc, vehicle, type, modes, lod."""
    with gzip.open(gz_path, 'rt', encoding='utf-8') as f:
        d = json.load(f)
    if d.get('v') != ONBELLEK_SURUM:
        raise ValueError('eski önbellek')
    lod = d.get('lod')
    if lod:   # parçaların hepsi diskte mi (yarım kalmış üretim)?
        for k in range(int(lod.get('chunks') or 0)):
            if not onbellek_parca_yolu(int(os.path.basename(gz_path).split('.')[0]), k).exists():
                raise ValueError('eksik parça')
    return {k: d.get(k) for k in ('v', 'hz', 'n', 'duration_s', 'home', 'takeoff_t', 'start_utc', 'vehicle', 'type', 'source', 'lod')} | {'modes': d.get('modes')}


def onbellek_hazir_meta(log_id):
    """Güncel ve tam önbellek varsa metası, yoksa None (bozuk/eski önbellek silinmez; `hazirla` yeniden üretir)."""
    gz = onbellek_yolu(log_id)
    if not gz.exists():
        return None
    try:
        return onbellek_meta(gz)
    except (OSError, ValueError, json.JSONDecodeError):
        return None


def hazirla(log_id, path, ilerleme=None, paralel=False):
    """Önbellek varsa (ve sürümü güncelse) metasını döner; yoksa ayrıştırır, gzip yazar (atomik), metayı döner. İş parçacığında / alt süreçte.
    Büyük kayıt (n > TEK_PARCA_KARE): `<id>.p<k>.json.gz` parçaları ({k, a, frames} — PARCA_S saniyelik tam hızda kareler) ÖNCE yazılır,
    sonra `<id>.json.gz` meta + genel bakış karesi (GENEL_HZ; `frames`) + `lod` {chunk_s, chunks, chunk_n, step, n_overview}. Meta
    dosyası en son yazıldığından varlığı tamamlanmış önbellek demektir. İlerleme: ayrıştırma %0–80, yazma %80–100.
    `paralel`: parçalar fork'lu işçilerle yazılır — yalnız tek iş parçacıklı alt süreçte (`_main`) açılır."""
    gz = onbellek_yolu(log_id)
    if gz.exists():
        try:
            return onbellek_meta(gz)
        except (OSError, ValueError, json.JSONDecodeError):
            onbellek_sil(log_id)
    data = _ayristir_ham(path, ilerleme=ilerleme)
    K = data.pop('K', None)
    for f in onbellek_dizini().glob(f'{int(log_id)}.p*.json.gz'):
        f.unlink(missing_ok=True)
    if K is not None:
        n = data['n']
        if n <= TEK_PARCA_KARE:
            data['frames'] = kareler(K)
        else:
            hz = data['hz']
            parca_n = int(PARCA_S * hz)
            parca = (n + parca_n - 1) // parca_n
            global _PK
            _PK = K
            isler = [(log_id, k, k * parca_n, min(n, (k + 1) * parca_n)) for k in range(parca)]
            try:
                if paralel and ISCI > 1 and parca >= 8:   # JSON üretimi GIL'e bağlı: alt süreçte fork'lu işçilere bölünür (K paylaşılır)
                    import multiprocessing as mp
                    with mp.get_context('fork').Pool(min(ISCI, os.cpu_count() or 1)) as havuz:
                        for i, _k in enumerate(havuz.imap_unordered(_parca_yaz, isler)):
                            if ilerleme:
                                ilerleme(80 + int(19 * (i + 1) / parca))
                else:
                    for i, is_ in enumerate(isler):
                        _parca_yaz(is_)
                        if ilerleme:
                            ilerleme(80 + int(19 * (i + 1) / parca))
            finally:
                _PK = None
            adim = max(1, int(round(hz / GENEL_HZ)))
            genel = kareler(K, 0, None, adim)
            if (n - 1) % adim:
                genel += kareler(K, n - 1, n)
            data['frames'] = genel
            data['lod'] = {'chunk_s': PARCA_S, 'chunks': parca, 'chunk_n': parca_n, 'step': adim, 'n_overview': len(genel)}
        del K
    else:
        data['frames'] = _thin(data['frames'], REPLAY_MAX_FRAMES)
    _gz_yaz(gz, data)
    if ilerleme:
        ilerleme(100)
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
        meta = hazirla(log_id, path, ilerleme, paralel=True)
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
        # §24/§25: kaydın canlı oturumu hedefliyse aynı yörüngeler (tt = t0 + t) ve tip INTERCEPTOR ise gövde `body` ile çizilir
        self.hedefler = None
        self.sim_tip = None
        self.site = None
        self.savunma_kayit = None
        self.site_heading = None
        try:
            with db.connect() as conn:
                r = db.row(conn.execute('SELECT power FROM drone_sim_runs WHERE bin_log_id = ? AND power IS NOT NULL ORDER BY id DESC LIMIT 1', (int(log['id']),)))
                c = db.row(conn.execute('SELECT camera FROM drone_sim_runs WHERE bin_log_id = ? AND camera IS NOT NULL ORDER BY id DESC LIMIT 1', (int(log['id']),)))
                h = db.row(conn.execute('SELECT type, targets, world FROM drone_sim_runs WHERE bin_log_id = ? AND mode = ? ORDER BY id DESC LIMIT 1', (int(log['id']), 'sitl')))
            if r and r.get('power'):
                self.power = (json.loads(r['power']) or {}).get('settings') or None
            if c and c.get('camera') in flightsim.KAMERA_TURLERI:
                self.camera = c['camera']
            if h:
                self.sim_tip = h.get('type') if h.get('type') in flightsim.TIP_ADLARI else None
                if h.get('targets'):
                    tj = json.loads(h['targets']) or {}
                    self.hedefler = tj.get('config') or None
                    self.site = tj.get('site') or None                       # §26 yer kontrol sahası
                    self.savunma_kayit = tj.get('defend') or None            # §26 {config, result}: plan tohumdan yeniden üretilir
                    with contextlib.suppress(Exception):
                        self.site_heading = float((json.loads(h.get('world') or '{}') or {}).get('runway_heading') or 0)   # canlı oturumun pist yönü (yerleşim)
            if self.sim_tip == 'interceptor':
                self.type = 'interceptor'
                self.model = flightsim._model_eski(self.type, None)
        except Exception:   # noqa: BLE001
            self.power = None

    # ---- dışa görünüm ----
    def to_dict(self, host=None):
        return {'id': self.id, 'mode': 'replay', 'type': self.type, 'model': dict(self.model) if self.model else None,
                'center': dict(self.center), 'world': dict(self.world), 'state': self.state, 'launch': {**self.launch, 'phase': None},
                'udp_port': None, 'host': host or self._fs.PUBLIC_HOST or None, 'created_at': self.created_at, 'owner': dict(self.owner),
                'client': dict(self.client) if self.client else None,
                'gcs': {'connected': False, 'addr': None, 'since': None}, 'sitl': dict(self.sitl), 'replay': dict(self.replay),
                'power': dict(self.power) if self.power else None, 'camera': self.camera or 'day',
                'targets': self._fs.flightsim_targets.zenginlestir(self.hedefler) if self.hedefler else None, 'vertical': self.type in self._fs.DIKEY_TIPLER,
                **self._site_dict()}

    def _site_dict(self):
        """§26: kaydın canlı oturumundaki yer kontrol sahası + görev (plan tohumdan, sonuç önleme/sızma zamanlarıyla; görev saati = kayıt saati,
        ilk SITL bölümü — yeniden konuşlandırma sonrası bölümler ayrı .bin'dedir)."""
        from . import flightsim_gcs as GC
        out = {'site': None, 'defend': None}
        try:
            heading = self.site_heading if self.site_heading is not None else (self.world or {}).get('runway_heading', 0)
            sv = self.savunma_kayit
            site = self.site or ({'station': True, 'radar': True, 'radar_km': GC.RADAR_KM_VARSAYILAN, 'eo': True, 'eo_km': GC.EO_KM_VARSAYILAN} if sv else None)
            if site:
                yer = GC.yerlesim(heading)
                out['site'] = {**site, 'layout': yer}
                if sv and sv.get('config'):
                    r = sv.get('result') or {}
                    ist = {'x': yer['station']['x'], 'y': yer['station']['y'], 'z': GC.ISTASYON_Z}
                    out['defend'] = {'config': sv['config'], 'plan': GC.savunma_plani(sv['config']), 'station': ist, 'result': r, 'replay': True,
                                     'state': {'base': 0, 'health': r.get('health'), 'killed': [[k['k'], k['t']] for k in r.get('kills') or []],
                                               'leaked': [[k['k'], k['t']] for k in r.get('leaks') or []], 'icept': r.get('icept'), 'ended': r.get('ended'),
                                               'waves': (sv['config'] or {}).get('waves'), 'total': r.get('total')}}
        except Exception:   # noqa: BLE001 — eski/bozuk kayıt: saha gösterilmez
            return {'site': None, 'defend': None}
        return out

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
                # önbellek güncelse alt süreç açılmaz (python + numpy açılışı ~1–2 sn); yoksa alt süreçte ayrıştırılır (ilerlemeli)
                meta = await asyncio.get_running_loop().run_in_executor(None, onbellek_hazir_meta, self.log['id'])
                if meta is None:
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
                self.type = self.sim_tip if self.sim_tip == 'interceptor' else (meta.get('type') or self.type)   # §25: firmware adı ArduPlane der
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
    sql = '''SELECT l.id, l.task_id, l.file, l.file_name, l.size, l.status, l.aircraft, l.pilot, l.location, l.note, l.uploaded_at, l.source, l.origin,
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
