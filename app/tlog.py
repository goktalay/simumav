"""MAVLink telemetri kaydı (.tlog — Mission Planner / QGroundControl kaydı): içerik doğrulama, araç (sysid) seçimi, uçuş logu analizi ve
3B oynatma verisi.

Biçim: her kayıt 8 bayt big-endian µs zaman damgası (yer istasyonunun saati, unix) + MAVLink çerçevesi (v1 0xFE / v2 0xFD).
Analiz, DataFlash (.bin) analiziyle (flightlog._sonuclandir) AYNI şemayı doldurur; MAVLink karşılığı olmayan bölümler boş kalır ve
`summary.missing` listesinde adlandırılır (ön yüz "telemetri kaydında bu veri yok" gösterir). Eşleme (docs/ucus-simulatoru.md §8.6):
  konum/rota GLOBAL_POSITION_INT (eve göre irtifa relative_alt) · GPS_RAW_INT (fix ≥ 3; uydu, HDOP = eph/100, hız vel)
  irtifa yedeği VFR_HUD.alt − ev irtifası · hız VFR_HUD groundspeed / airspeed (airspeed yalnız hava hızı sensörü varsa: SYS_STATUS bit 16)
  gaz VFR_HUD.throttle · tutum ATTITUDE (rad → °), istenen tutum NAV_CONTROLLER_OUTPUT nav_roll / nav_pitch
  batarya SYS_STATUS (voltage_battery mV, current_battery cA, battery_remaining) + BATTERY_STATUS id 0 (current_consumed mAh,
  energy_consumed hJ, remaining; SYS_STATUS yoksa hücre toplamı) · titreşim VIBRATION (clipping_0..2 birikimli) · rüzgâr WIND
  modlar HEARTBEAT custom_mode + araç tipi (flightlog._mode_names; PX4: interpret_px4_mode) · ARM/DISARM base_mode bit 7 geçişleri
  uçuş aralıkları EXTENDED_SYS_STATE.landed_state (yoksa kurulu iken irtifa > 2 m / hız > 4 m/s sezgisi) · ev HOME_POSITION
  mesajlar STATUSTEXT (önem ≤ 4 ya da uyarı kalıbı → uyarı) · yazılım STATUSTEXT "ArduXxx V…" / AUTOPILOT_VERSION · parametre PARAM_VALUE.
Tek araç: birden çok sysid varsa en çok HEARTBEAT gönderen otopilot bileşeni (GCS 255, kamera/gimbal/ADSB/yer bileşenleri ve
MAV_AUTOPILOT_INVALID sayılmaz); yalnız o (sysid, compid)'nin mesajları okunur.
"""
import math
import mmap
import os
from collections import Counter

TS_MIN = 946684800 * 10 ** 6     # 2000-01-01 (µs)
TS_MAX = 4102444800 * 10 ** 6    # 2100-01-01
# Otopilot sayılmayan MAV_TYPE'lar: anten izleyici, GCS, yer/eş bilgisayar, gimbal, ADSB, kamera, şarj istasyonu, FLARM, servo, ODID,
# batarya, paraşüt, log, OSD, IMU, GPS, vinç
HARIC_TIP = {5, 6, 18, 26, 27, 30, 31, 32, 33, 34, 36, 37, 38, 39, 40, 41, 42}
MAV_AUTOPILOT_INVALID = 8
MAV_AUTOPILOT_PX4 = 12
DOGRULAMA_BAYT = 2 * 1024 * 1024
# MAV_TYPE → ArduPilot araç adı (yazılım sürümü kayıtta yoksa; mod adları bu adla eşlenir)
ARAC_ADI = {1: 'ArduPlane', 2: 'ArduCopter', 3: 'ArduCopter', 4: 'ArduCopter', 13: 'ArduCopter', 14: 'ArduCopter', 15: 'ArduCopter',
            29: 'ArduCopter', 10: 'ArduRover', 11: 'ArduRover', 12: 'ArduSub', 7: 'Blimp', 19: 'ArduPlane', 20: 'ArduPlane',
            21: 'ArduPlane', 22: 'ArduPlane', 23: 'ArduPlane', 24: 'ArduPlane', 25: 'ArduPlane'}
TIPLER = ['HEARTBEAT', 'GLOBAL_POSITION_INT', 'GPS_RAW_INT', 'ATTITUDE', 'NAV_CONTROLLER_OUTPUT', 'VFR_HUD', 'SYS_STATUS',
          'BATTERY_STATUS', 'VIBRATION', 'WIND', 'STATUSTEXT', 'HOME_POSITION', 'PARAM_VALUE', 'EXTENDED_SYS_STATE', 'AUTOPILOT_VERSION']
# Seri anahtarı → rapordaki adı (summary.missing; ön yüz flightreport.js aynı anahtarları kullanır)
SERI_ADI = {'alt': 'İrtifa', 'gs': 'Yer hızı', 'as': 'Hava hızı', 'volt': 'Batarya voltajı', 'curr': 'Batarya akımı',
            'vx': 'Titreşim', 'roll': 'Tutum', 'droll': 'İstenen tutum', 'sats': 'GPS uydu', 'hdop': 'GPS HDop', 'wind': 'Rüzgâr', 'thr': 'Gaz'}


class TlogHatasi(ValueError):
    pass


# ---------------------------------------------------------------- ham çerçeve tarayıcı (pymavlink'siz; doğrulama + sysid seçimi)
def _uzunluk(b, p, n, z=8):
    """p'deki kayıt geçerliyse toplam uzunluğu, değilse 0. `z` = 8: zaman damgalı (.tlog kaydı); 0: damgasız ham çerçeve."""
    if p + z + 10 > n:
        return 0
    if z:
        ts = int.from_bytes(b[p:p + 8], 'big')
        if not TS_MIN <= ts <= TS_MAX:
            return 0
    mg, ln = b[p + z], b[p + z + 1]
    if mg == 0xFE:
        fl = z + 6 + ln + 2
    elif mg == 0xFD:
        inc = b[p + z + 2]
        if inc & 0xFE:   # tanımsız uyumsuzluk bayrağı
            return 0
        fl = z + 10 + ln + 2 + (13 if inc & 1 else 0)
    else:
        return 0
    return fl if p + fl <= n else 0


def _bas_mi(b, p, n):
    return p >= n or bool(_uzunluk(b, p, n) or _uzunluk(b, p, n, 0))


def tara(path, sinir=None):
    """Dosyayı çerçeve çerçeve tarar: {'cerceve', 'damgali' (zaman damgalı çerçeve), 'atlanan' / 'okunan' (bayt),
    'hb': Counter{(sysid, compid, type, autopilot)}}. Bir çerçeve, ardından gelen de geçerli bir başlangıçsa (ya da dosya sonuysa)
    kabul edilir (rastlantısal 0xFE/0xFD eşleşmesi elenir). Bazı köprü/eski kayıtlarda damgasız çerçeveler araya karışır; sayılır
    ama zaman ekseni pymavlink'in damga taramasına kalır."""
    hb = Counter()
    cerceve = damgali = atlanan = 0
    n0 = os.path.getsize(path)
    if n0 == 0:
        return {'cerceve': 0, 'damgali': 0, 'atlanan': 0, 'okunan': 0, 'hb': hb}
    with open(path, 'rb') as f, mmap.mmap(f.fileno(), 0, access=mmap.ACCESS_READ) as b:
        n = min(n0, sinir) if sinir else n0
        p = 0
        while p < n:
            z = 8
            fl = _uzunluk(b, p, n0)
            if not (fl and _bas_mi(b, p + fl, n0)):
                z = 0
                fl = _uzunluk(b, p, n0, 0)
                if fl and not _bas_mi(b, p + fl, n0):
                    fl = 0
            if fl:
                h = p + z
                if b[h] == 0xFE:
                    sysid, compid, msgid, yuk = b[h + 3], b[h + 4], b[h + 5], h + 6
                else:
                    sysid, compid, msgid, yuk = b[h + 5], b[h + 6], b[h + 7] | (b[h + 8] << 8) | (b[h + 9] << 16), h + 10
                if msgid == 0:   # HEARTBEAT: custom_mode(4) type autopilot base_mode … (v2'de sondaki sıfırlar kırpılabilir)
                    ln = b[h + 1]
                    hb[(sysid, compid, b[yuk + 4] if ln > 4 else 0, b[yuk + 5] if ln > 5 else 0)] += 1
                cerceve += 1
                damgali += z == 8
                p += fl
                continue
            # eşleşme yok: bir sonraki olası başlığa (0xFE/0xFD ya da 8 bayt öncesindeki zaman damgası) atla
            adaylar = [i for i in (b.find(b'\xfe', p + 1, n + 8), b.find(b'\xfd', p + 1, n + 8)) if i >= 0]
            q = n if not adaylar else min(adaylar)
            if q - 8 > p and _uzunluk(b, q - 8, n0):
                q -= 8
            atlanan += q - p
            p = q
    return {'cerceve': cerceve, 'damgali': damgali, 'atlanan': atlanan, 'okunan': min(p, n0), 'hb': hb}


def dogrula(path):
    """Yüklenen .tlog gerçekten MAVLink telemetri kaydı mı? Değilse TlogHatasi (kullanıcıya gösterilecek anlaşılır metin)."""
    try:
        with open(path, 'rb') as f:
            bas = f.read(4096)
    except OSError as e:
        raise TlogHatasi('Dosya okunamadı') from e
    if not bas:
        raise TlogHatasi('Dosya boş')
    if bas[:2] == b'\xa3\x95':
        raise TlogHatasi('Bu dosya ArduPilot DataFlash logu (.BIN), MAVLink telemetri kaydı değil; .bin uzantısıyla yükleyin.')
    r = tara(path, DOGRULAMA_BAYT)
    if r['cerceve'] < 3 or r['atlanan'] > r['okunan'] // 2:
        metin = sum(1 for c in bas if c in (9, 10, 13) or 32 <= c < 127) > len(bas) * 0.9
        if metin:
            raise TlogHatasi('Bu dosya metin; .tlog, yer istasyonunun (Mission Planner / QGroundControl) kaydettiği ikili MAVLink telemetri '
                             'kaydı olmalı (her paketin önünde 8 baytlık zaman damgası).')
        raise TlogHatasi('Dosya MAVLink telemetri kaydı (.tlog) değil: zaman damgalı MAVLink çerçevesi (v1 0xFE / v2 0xFD) bulunamadı.')
    if not r['damgali']:
        raise TlogHatasi('Dosyada MAVLink çerçeveleri var ama zaman damgası yok (ham akış); .tlog, yer istasyonunun her paketin önüne '
                         '8 baytlık zaman damgası yazdığı telemetri kaydı olmalı.')
    return r


def arac_sec(hb):
    """HEARTBEAT sayımından analiz edilecek araç: (sysid, compid, mav_type, autopilot) ya da None. En çok HEARTBEAT'li otopilot bileşeni."""
    say = Counter()
    tip = {}
    for (sysid, compid, t, ap), n in hb.items():
        if sysid == 255 or t in HARIC_TIP or ap == MAV_AUTOPILOT_INVALID:
            continue
        say[(sysid, compid)] += n
        tip.setdefault((sysid, compid), Counter())[(t, ap)] += n
    if not say:
        return None
    sysid = max({s for s, _ in say}, key=lambda s: (sum(n for (s2, _), n in say.items() if s2 == s), -s))
    compid = max((c for s, c in say if s == sysid), key=lambda c: (say[(sysid, c)], -c))
    (t, ap), _ = tip[(sysid, compid)].most_common(1)[0]
    return sysid, compid, t, ap


def _arac(path):
    """Doğrulama + tüm dosyadan araç seçimi: (tarama, (sysid, compid, mav_type, autopilot))."""
    r = dogrula(path)
    if r['okunan'] < os.path.getsize(path):   # doğrulama ilk 2 MB'a bakar; araç seçimi tüm dosyadan
        r = tara(path)
    sec = arac_sec(r['hb'])
    if not sec:
        raise TlogHatasi('Telemetri kaydında araç (otopilot) HEARTBEAT mesajı yok; yalnız yer istasyonu trafiği kaydedilmiş olabilir.')
    return r, sec


def _okuyucu(path):
    from pymavlink import mavutil
    # mavlink_connection .tlog'da mmap'li mavmmaplog seçer; tanımsız/bozuk paketlerde ön indeksleme düşer → akış okuyucu mavlogfile
    # (robust_parsing: BAD_DATA atlanır; flightsim_replay._tlog_ayristir ile aynı)
    return mavutil.mavlogfile(str(path), robust_parsing=True)


def _surum(v):
    """AUTOPILOT_VERSION.flight_sw_version (major<<24 | minor<<16 | patch<<8 | tip) → 'V4.5.7'."""
    return f'V{(v >> 24) & 255}.{(v >> 16) & 255}.{(v >> 8) & 255}' if v else None


# ---------------------------------------------------------------- analiz
def analiz(path, ilerleme=None):
    from pymavlink import mavutil
    from . import flightlog as F
    r, (sysid, compid, mav_tip, ap) = _arac(path)
    arac_adi = ARAC_ADI.get(mav_tip, 'MAVLink')
    boyut = max(1, os.path.getsize(path))
    log = _okuyucu(path)

    s = {k: [] for k in F._SERI}
    gps_pts, pos_pts = [], []
    firmware = board = surum = None
    msgs, modes, events, errors = [], [], [], []
    arm_flags, land_flags = [], []
    bat = {'first': None, 'last': None, 'min_v': None, 'max_a': 0.0, 'mah': None, 'wh': None, 'pct': None}
    bs_volt, bs_curr = [], []          # BATTERY_STATUS (SYS_STATUS'ta voltaj yoksa)
    vfr_gs, gps_gs, vfr_as, vfr_alt = [], [], [], []
    clips = {}
    wind_dirs = []
    origin = None
    params = set()
    arsp_sensor = None                 # SYS_STATUS onboard_control_sensors_present bit 16 (fark basıncı)
    px4_adlar = {}
    t0 = None
    son_mod = son_arm = None
    son_gs = 0.0
    sezgi = []                         # (t, havada mı) — EXTENDED_SYS_STATE yoksa
    roll_t, pitch_t = [], []           # (t, değer) — istenen tutumla zaman eşlemesi için
    nav = []                           # (t, nav_roll, nav_pitch)
    count = say = 0
    while True:
        m = log.recv_match(type=TIPLER)
        if m is None:
            break
        say += 1
        if ilerleme and say % 5000 == 0:
            try:
                ilerleme(min(90, int(log.f.tell() * 90 / boyut)))
            except (OSError, ValueError, AttributeError):
                pass
        if m.get_srcSystem() != sysid:
            continue
        tp = m.get_type()
        if m.get_srcComponent() != compid and tp != 'STATUSTEXT':
            continue
        ts = getattr(m, '_timestamp', None)
        if not ts:
            continue
        if t0 is None:
            t0 = ts
        t = ts - t0
        if t < -1 or t > 30 * 86400:   # bozuk zaman damgası
            continue
        t = max(t, 0.0)
        count += 1

        if tp == 'HEARTBEAT':
            if ap == MAV_AUTOPILOT_PX4:
                try:
                    px4_adlar.setdefault(m.custom_mode, mavutil.interpret_px4_mode(m.base_mode, m.custom_mode))
                except Exception:   # noqa: BLE001
                    pass
            if m.custom_mode != son_mod:
                modes.append((t, m.custom_mode, None))
                son_mod = m.custom_mode
            armed = bool(m.base_mode & 128)
            if son_arm is None:
                if armed:   # kayıt kurulu başladı
                    arm_flags.append((t, True))
            elif armed != son_arm:
                arm_flags.append((t, armed))
                events.append({'t': F._r(t), 'id': 10 if armed else 11, 'text': F.EV_TEXT[10 if armed else 11]})
            son_arm = armed
        elif tp == 'GLOBAL_POSITION_INT':
            if m.lat or m.lon:
                rel = m.relative_alt / 1000.0
                pos_pts.append((t, m.lat / 1e7, m.lon / 1e7, rel))
                s['alt'].append([t, rel])
                on = (rel > 2.0 or son_gs > 4.0) and son_arm is not False
                sezgi.append((t, on))
        elif tp == 'GPS_RAW_INT':
            if m.fix_type >= 3 and (m.lat or m.lon):
                spd = m.vel / 100.0 if m.vel != 65535 else 0.0
                gps_pts.append((t, m.lat / 1e7, m.lon / 1e7, spd))
                if m.vel != 65535:
                    gps_gs.append([t, spd])
            if m.satellites_visible != 255:
                s['sats'].append([t, m.satellites_visible])
            if m.eph != 65535:
                s['hdop'].append([t, m.eph / 100.0])
        elif tp == 'VFR_HUD':
            gs = F._num(m.groundspeed)
            if gs is not None:
                vfr_gs.append([t, gs])
                son_gs = gs
            asp = F._num(m.airspeed)
            if asp is not None:
                vfr_as.append([t, asp])
            s['thr'].append([t, m.throttle])
            a = F._num(m.alt)
            if a is not None:
                vfr_alt.append([t, a])
        elif tp == 'ATTITUDE':
            r_, p_ = math.degrees(m.roll), math.degrees(m.pitch)
            s['roll'].append([t, r_])
            s['pitch'].append([t, p_])
            roll_t.append((t, r_))
            pitch_t.append((t, p_))
        elif tp == 'NAV_CONTROLLER_OUTPUT':
            s['droll'].append([t, m.nav_roll])
            s['dpitch'].append([t, m.nav_pitch])
            nav.append((t, m.nav_roll, m.nav_pitch))
        elif tp == 'SYS_STATUS':
            arsp_sensor = bool(m.onboard_control_sensors_present & 16)
            v = m.voltage_battery / 1000.0 if m.voltage_battery not in (0, 65535) else None
            if v is not None and v > 0.5:
                s['volt'].append([t, v])
                bat['first'] = bat['first'] or v
                bat['last'] = v
                bat['min_v'] = v if bat['min_v'] is None else min(bat['min_v'], v)
                if m.current_battery >= 0:
                    a = m.current_battery / 100.0
                    s['curr'].append([t, a])
                    bat['max_a'] = max(bat['max_a'], a)
            if m.battery_remaining >= 0:
                bat['pct'] = m.battery_remaining
        elif tp == 'BATTERY_STATUS':
            if m.id != 0:
                continue
            if m.current_consumed >= 0:
                bat['mah'] = float(m.current_consumed)
            if m.energy_consumed >= 0:
                bat['wh'] = m.energy_consumed * 100 / 3600.0   # hJ → Wh
            if m.battery_remaining >= 0:
                bat['pct'] = m.battery_remaining
            hucre = [c for c in m.voltages if c != 65535]
            if hucre:
                bs_volt.append([t, sum(hucre) / 1000.0])
                if m.current_battery >= 0:
                    bs_curr.append([t, m.current_battery / 100.0])
        elif tp == 'VIBRATION':
            s['vx'].append([t, m.vibration_x])
            s['vy'].append([t, m.vibration_y])
            s['vz'].append([t, m.vibration_z])
            for i in range(3):
                clips[f'Clip{i}'] = getattr(m, f'clipping_{i}', 0)
        elif tp == 'WIND':
            s['wind'].append([t, m.speed])
            d = math.radians(m.direction)   # rüzgârın geldiği yön → esme vektörü (kuzey, doğu)
            wind_dirs.append((-m.speed * math.cos(d), -m.speed * math.sin(d)))
        elif tp == 'STATUSTEXT':
            text = str(m.text).rstrip('\x00').strip()
            if not text:
                continue
            if firmware is None and text.startswith(('ArduPlane', 'ArduCopter', 'ArduRover', 'ArduSub', 'ArduHeli', 'Blimp', 'AntennaTracker')):
                firmware = text
            elif board is None and ' ' in text and any(text.startswith(b) for b in (
                    'Pixhawk', 'CubeOrange', 'CubeBlack', 'CubePurple', 'CubeYellow', 'Matek', 'fmuv', 'PX4v', 'Durandal', 'KakuteH',
                    'SpeedyBee', 'Holybro', 'MicoAir', 'mRo', 'Pixracer', 'omnibus')):
                board = text.split(' ')[0]
            if len(msgs) < F.MAX_MESSAGES:
                msgs.append({'t': F._r(t), 'text': text, 'warn': m.severity <= 4 or bool(F.WARN_RE.search(text)), 'sev': m.severity})
        elif tp == 'HOME_POSITION':
            if origin is None:
                origin = (m.latitude / 1e7, m.longitude / 1e7, m.altitude / 1000.0)
        elif tp == 'PARAM_VALUE':
            params.add(m.param_id)
        elif tp == 'EXTENDED_SYS_STATE':
            if m.landed_state in (1, 2, 3, 4):
                on = m.landed_state != 1
                if not land_flags or land_flags[-1][1] != on:
                    land_flags.append((t, on))
        elif tp == 'AUTOPILOT_VERSION':
            surum = surum or _surum(m.flight_sw_version)

    if t0 is None or count == 0:
        raise TlogHatasi('Telemetri kaydında seçilen araca ait okunabilir mesaj yok')
    if ilerleme:
        ilerleme(92)

    # Yedekler: konum yoksa irtifa VFR_HUD'dan (ev irtifasına göre), yer hızı VFR_HUD yoksa GPS'ten, voltaj SYS_STATUS yoksa BATTERY_STATUS
    if not s['alt'] and vfr_alt:
        taban = origin[2] if origin else vfr_alt[0][1]
        s['alt'] = [[tt, a - taban] for tt, a in vfr_alt]
    s['gs'] = vfr_gs or gps_gs
    if not gps_pts and pos_pts:   # GPS_RAW_INT akışı yoksa iz / mesafe / ev GLOBAL_POSITION_INT'ten (EKF konumu)
        gps_pts = [(tt, la, lo, 0.0) for tt, la, lo, _ in pos_pts]
    if arsp_sensor is not False:   # hava hızı sensörü yokken VFR_HUD.airspeed tahmindir (yer hızı + rüzgâr); gösterilmez
        s['as'] = vfr_as
    if not s['volt'] and bs_volt:
        s['volt'], s['curr'] = bs_volt, bs_curr
        vs = [v for _, v in bs_volt]
        bat['first'], bat['last'], bat['min_v'] = vs[0], vs[-1], min(vs)
        bat['max_a'] = max([a for _, a in bs_curr], default=0.0)

    # Uçuş aralıkları: EXTENDED_SYS_STATE varsa o; yoksa kurulu iken irtifa/hız sezgisi (≤ 3 sn'lik sıçramalar atılır)
    if land_flags:
        stat_flags = land_flags
    else:
        iv = [x for x in F._intervals(sezgi) if x[1] - x[0] > 3]
        stat_flags = [f for a, b in iv for f in ((a, True), (b, False))] or [(0.0, False)]

    # İstenen ↔ gerçekleşen tutum farkı: her NAV_CONTROLLER_OUTPUT anında en son ATTITUDE
    def esle(seri, idx):
        out, j = [], -1
        for tt, *des in nav:
            while j + 1 < len(seri) and seri[j + 1][0] <= tt:
                j += 1
            if j >= 0:
                out.append((tt, seri[j][1] - des[idx]))
        return out
    takip = (esle(roll_t, 0), esle(pitch_t, 1))

    firmware = firmware or (f'{arac_adi} {surum}' if surum and arac_adi != 'MAVLink' else None)
    if ap == MAV_AUTOPILOT_PX4:
        adlar = dict(px4_adlar)
        firmware = firmware or ('PX4 ' + surum if surum else 'PX4')
    else:
        adlar = F._mode_names(firmware or arac_adi)

    sonuc = F._sonuclandir(s, gps_pts, pos_pts, firmware, board, msgs, modes, events, errors, arm_flags, stat_flags, bat, clips,
                           wind_dirs, origin, len(params), (0.0, t0), mod_adlari=adlar, takip=takip, kaynak='tlog')
    ozet = sonuc['summary']
    if not firmware:
        ozet['vehicle'] = arac_adi
    eksik = [k for k in SERI_ADI if not s[k]]
    eksik += ['errors']            # DataFlash ERR / EV kayıtları telemetride yok (ARM/DISARM HEARTBEAT'ten türetilir)
    if bat['mah'] is None:
        eksik.append('energy')
    if not gps_pts and not pos_pts:
        eksik.append('track')
    if not msgs:
        eksik.append('messages')
    if not modes:
        eksik.append('modes')
    ozet.update({'source': 'tlog', 'sysid': sysid, 'compid': compid, 'mav_type': mav_tip, 'missing': eksik,
                 'other_systems': sorted({k[0] for k in r['hb'] if k[0] != sysid})})
    if ilerleme:
        ilerleme(100)
    return sonuc


# ---------------------------------------------------------------- 3B oynatma (flightlog.replay şeması)
def replay(path):
    """Cesium 3B oynatma: [t, enlem, boylam, eve göre irtifa, roll, pitch, yaw (°), yer hızı, hava hızı, gaz (%), batarya (V), devir]."""
    from . import flightlog as F
    _, (sysid, compid, _, _) = _arac(path)
    log = _okuyucu(path)
    t0 = None
    cur = {'roll': 0.0, 'pitch': 0.0, 'yaw': 0.0, 'gs': None, 'as': None, 'thr': None, 'volt': None, 'rpm': None}
    pos = None
    has_pos = False
    gps_alt0 = None
    samples = []
    step = 1.0 / F.REPLAY_HZ
    next_t = 0.0
    while True:
        m = log.recv_match(type=['GLOBAL_POSITION_INT', 'GPS_RAW_INT', 'ATTITUDE', 'VFR_HUD', 'SYS_STATUS', 'RPM', 'ESC_TELEMETRY_1_TO_4'])
        if m is None:
            break
        if m.get_srcSystem() != sysid or m.get_srcComponent() != compid:
            continue
        ts = getattr(m, '_timestamp', None)
        if not ts:
            continue
        if t0 is None:
            t0 = ts
        t = ts - t0
        if t < -1 or t > 30 * 86400:
            continue
        tp = m.get_type()
        if tp == 'ATTITUDE':
            cur['roll'], cur['pitch'], cur['yaw'] = math.degrees(m.roll), math.degrees(m.pitch), math.degrees(m.yaw)
        elif tp == 'GLOBAL_POSITION_INT':
            if m.lat or m.lon:
                pos, has_pos = (m.lat / 1e7, m.lon / 1e7, m.relative_alt / 1000.0), True
        elif tp == 'GPS_RAW_INT':
            if m.fix_type >= 3 and (m.lat or m.lon) and not has_pos:
                gps_alt0 = m.alt / 1000.0 if gps_alt0 is None else gps_alt0
                pos = (m.lat / 1e7, m.lon / 1e7, m.alt / 1000.0 - gps_alt0)
        elif tp == 'VFR_HUD':
            cur['gs'], cur['as'], cur['thr'] = F._num(m.groundspeed), F._num(m.airspeed), float(m.throttle)
        elif tp == 'SYS_STATUS':
            if m.voltage_battery not in (0, 65535):
                cur['volt'] = m.voltage_battery / 1000.0
        elif tp == 'RPM':
            cur['rpm'] = F._num(m.rpm1)
        elif tp == 'ESC_TELEMETRY_1_TO_4':
            if m.rpm and m.rpm[0]:
                cur['rpm'] = m.rpm[0]
        if pos and t >= next_t:
            samples.append([F._r(t, 2), round(pos[0], 7), round(pos[1], 7), F._r(pos[2], 1), F._r(cur['roll'], 1), F._r(cur['pitch'], 1),
                            F._r(cur['yaw'], 1), F._r(cur['gs'], 1), F._r(cur['as'], 1), F._r(cur['thr'], 0), F._r(cur['volt'], 2),
                            F._r(cur['rpm'], 0)])
            next_t = t + step
    if len(samples) < 2:
        raise TlogHatasi('Telemetri kaydında 3B oynatma için konum verisi yok')
    return {'fields': ['t', 'lat', 'lng', 'alt', 'roll', 'pitch', 'yaw', 'gs', 'as', 'thr', 'volt', 'rpm'], 'samples': F._thin(samples, F.REPLAY_MAX)}

