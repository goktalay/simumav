"""Sanal dron (SITL) KALICI PARAMETRELERİ — tablo `drone_sitl_params` (docs/dron-kopru-protokolu.md "Kalıcı parametreler").

Kullanıcı isteği: "sanal dron ile yaptığımız uçuşlar esnasında, gerek sistemden gerekse Mission Planner üzerinde bir parametre
değiştirdiğimizde kalıcı olarak kaydetsin; aynı dronu tekrar kullandığımızda eski parametreler ile gelsin."

İki yüzey aynı izleyiciyi kullanır:
  - saha görevinin sanal dronu (drone_hub.SitlDrone, drone_id) — HEPGO harekât paneli `param_set` komutu,
  - uçuş simülatörü oturumu (flightsim.SimSession, sihirbazda dron kaydı seçildiyse) — panel `param_set` + Mission Planner (UDP, ham).

İZLEME (Izleyici): SITL'den gelen her PARAM_VALUE "bilinen değer"le karşılaştırılır.
  (a) HEPGO `param_set` → `hepgo_set` bekleyen kaydı → yankı PARAM_VALUE gelince kaydedilir (source hepgo, kullanıcı).
  (b) Mission Planner PARAM_SET (UDP ham baytlar `gcs_bayt` ile ayrıca ayrıştırılır; SITL'e ham geçer) → bekleyen → yankı gelince (source mp).
  (c) Bekleyen yokken tabandaki değerden farklı PARAM_VALUE → source 'sitl' (araç kendi değiştirdi; ör. öğrenilen ofset) — yalnız ilk TAM
      parametre listesi (param_count'un %90'ı görüldü) alındıktan sonra.
  Taban: SITL'den ilk görülen değer (MP'nin açılıştaki param listesi / tekil okuma). Açılışta bizim yazdığımız kayıtlı parametrelerin
  yankıları (`yukleme_isaretle`) yalnız tabana işlenir, yeniden kaydedilmez. Niyet (bekleyen) yalnız hedef değerle eşleşen yankıda tüketilir.
HARİÇ (hiç kaydedilmez): STAT_*, LOG_*, SIM_WIND_*, SIM_GPS1_*, TKOFF_*, MAV1_/MAV2_/MAV3_* ve SR0_…SR3_* (akış hızları), MIS_TOTAL, FENCE_TOTAL, RALLY_TOTAL, FORMAT_VERSION, SYSID_THISMAV,
  MAV_SYSID, SIM_SPEEDUP, SIM_RC_FAIL ve simülatör oturumunun kalp atışında yazdığı set (flightsim RC_PARAMLAR / GPS_RTK_PARAMLARI /
  PLANE_YER_PARAMLARI / launch_parametreleri — `oturum_adlari`). Diğer SIM_* (ör. SIM_BATT_VOLTAGE) kaydedilir.
YÜKLEME: `yukle` → `parm_satirlari` varsayilan.parm'a (HEPGO varsayılanlarından sonra) eklenir; ayrıca ilk kalp atışında PARAM_SET ile
  yeniden yazılır (eeprom.bin'deki eski değer defaults dosyasını ezebilir) ve olay şeridine "N kayıtlı parametre yüklendi" düşer.
MONTAJ PARAMETRELERİ (`montaj_mi`: SERVO1..16_REVERSED): gerçek uçakta servo montaj yönünü düzeltir; ArduPilot SITL'in stok uçak fiziği ise
  servo PWM'ini doğrudan kontrol yüzeyi açısına çevirir (sanal montaj hep "düz") → REVERSED=1 stok SITL'de yüzeyi gerçekten ters çalıştırır ve
  kontrol tersine döner (CAYMAZ: SERVO1_REVERSED=1 ile uçak simülasyonda düzgün uçmuyordu). Kullanıcı kararı: "sanal uçak gerçek uçağın servo
  MONTAJINI da taklit etmeli; SERVO1_REVERSED=1 / SERVO2_REVERSED=0 ile düzgün uçmalı". Çözüm HEPGO'nun SITL yaması (tools/sitl/, parametre
  `SIM_SRV_REV` bit maskesi: bit n-1 = SERVOn ters monteli; fizik ilgili kanalın PWM'ini 1500 ekseninde yansıtır): kayıtlı SERVOn_REVERSED
  SITL'e AYNEN yazılır ve `srv_rev_mask` ile üretilen SIM_SRV_REV de yazılır (varsayilan.parm + ilk kalp atışı PARAM_SET) → ArduPlane'in ters
  çevirdiği sinyali sanal montaj geri çevirir, net yüzey hareketi gerçek uçakla aynı. SIM_SRV_REV kalıcı kayda GİRMEZ (HARIC_ADLAR). Oturum
  sırasında SERVOn_REVERSED değişirse (MP/panel) izleyici kaydeder ve `srv_rev_yaz` ile SIM_SRV_REV'i anında günceller.
  ESKİ İKİLİ (resmi firmware.ardupilot.org; `drone_sitl.sanal_montaj_destegi` False): nötr yola düşer — SITL'e 0 yazılır, kayıt/dışa aktarım
  gerçek değeri korur, sarı uyarı "SITL ikilisi sanal montaj desteklemiyor; servo ters çevirme nötr uygulandı".
  RCn_REVERSED'e DOKUNULMAZ: RC girişleri kumanda tarafıdır; SITL'de de sanal kumanda / Mission Planner joystick aynı gerçek kumanda yönüyle
  çalışmalı (RC ters çevirme SITL fiziğinde değil, pilot girişinde anlamlıdır) — nötrlenirse kumanda yönü gerçek uçaktan sapar.
"""
import re
import threading
import time

from . import db

NIYET_SURESI_S = 30.0     # param_set niyeti bu süre içinde yankılanmazsa düşer

# MAVn_* / SRn_*: MAVLink akış hızları — REQUEST_DATA_STREAM (sunucu 10 Hz, Mission Planner kendi hızları) bunları SITL'de değiştirir ve
# PARAM_VALUE yayınlanır (gerçek SITL'de ölçüldü: MAV1_EXTRA1/EXTRA2/POSITION "sitl" kaydı üretiyordu) → oturum ayarıdır, kaydedilmez.
# INS_GYR*OFFS_ (açılış gyro kalibrasyonu), BARO*_GND_PRESS / ARSPD*_OFFSET (açılış/ARM yer basıncı ve hava hızı kalibrasyonu): araç her
# açılışta kendisi yeniden hesaplar ve kaydeder (gerçek SITL'de BARO1/2_GND_PRESS "sitl" kaydı üretiyordu) → kullanıcı değişikliği değil.
HARIC_ONEKLER = ('STAT_', 'LOG_', 'SIM_WIND_', 'SIM_GPS1_', 'TKOFF_', 'MAV1_', 'MAV2_', 'MAV3_', 'SR0_', 'SR1_', 'SR2_', 'SR3_',
                 'INS_GYROFFS_', 'INS_GYR2OFFS_', 'INS_GYR3OFFS_')
HARIC_ADLAR = frozenset({'MIS_TOTAL', 'FENCE_TOTAL', 'RALLY_TOTAL', 'FORMAT_VERSION', 'SYSID_THISMAV', 'MAV_SYSID', 'SIM_SPEEDUP', 'SIM_RC_FAIL',
                         'FS_THR_ENABLE', 'THR_FAILSAFE', 'RC_OVERRIDE_TIME', 'SERVO3_MIN', 'SERVO3_TRIM', 'TKOFF_THR_MINACC',
                         'BARO1_GND_PRESS', 'BARO2_GND_PRESS', 'BARO3_GND_PRESS', 'GND_ABS_PRESS', 'ARSPD_OFFSET', 'ARSPD2_OFFSET',
                         'SIM_SRV_REV',    # sanal montaj maskesi, kayıtlı SERVOn_REVERSED'den üretilir (kalıcı kayda girmez)
                         'SIM_PLN_THR_MUL'})   # §23 azami hız itki çarpanı: oturumun `power.max_speed_ms` alanından üretilir (dron kaydı: drone_sitl_options)
TABAN_TAM_ORAN = 0.9      # param_count'un bu oranı görülünce "ilk tam param listesi" alınmış sayılır (niyetsiz fark kaydı bundan sonra)
# Ön ek hariç olsa da KAYDEDİLEN adlar: flap yüzdeleri dron yapılandırmasıdır (flightsim.FLAP_PARAMLARI oturum başlangıcı; kullanıcı değiştirirse kalıcı)
HARIC_DEGIL = frozenset({'TKOFF_FLAP_PCNT', 'LAND_FLAP_PERCNT'})
AD_DESENI = re.compile(r'^[A-Z][A-Z0-9_]{0,15}$')
# Donanım montaj parametreleri (modül açıklaması): SITL'e aynen gider + SIM_SRV_REV maskesi (sanal montaj); eski ikilide nötr (0). RCn_REVERSED bilerek dışarıda.
MONTAJ_DESENI = re.compile(r'^SERVO([1-9]|1[0-6])_REVERSED$')
MONTAJ_ACIKLAMA = 'SERVO1..16_REVERSED'
MONTAJ_ROZET = 'montaj (sanal uçakta aynen uygulanır)'
MONTAJ_ROZET_NOTR = 'montaj (simülasyonda nötr)'   # SITL ikilisi SIM_SRV_REV tanımıyorsa
MONTAJ_UYARI = 'Simülasyonda servo ters çevirme montaj parametresidir; sanal uçakta nötr uygulanır'
MONTAJ_DESTEK_YOK = 'SITL ikilisi sanal montaj desteklemiyor; servo ters çevirme nötr uygulandı'
# SENSÖR KALİBRASYONU / YÖNELİMİ (gerçek uçağın fiziksel sensörlerine özgü): SITL'in sanal manyetometre/IMU'su idealdir (kendi SIM_MAG*/SIM_ACC*
# ofsetleriyle) ve ArduPilot'un SITL varsayılan COMPASS_*/INS_* değerleriyle eşleşir. Gerçek uçağın pusula ofseti/çapraz ekseni/yönelimi, ikinci-
# üçüncü pusulayı kapatma (COMPASS_USE2/3 0), sapma (COMPASS_DEC + AUTODEC 0), kart yönelimi ve ivmeölçer kalibrasyonu SITL'e yazılınca sanal sensör
# "bozuk" ölçer → ArduPilot ön kontrolü (gerçek ArduPlane 4.7.2 SITL, Ankara 39,92 K 32,85 D, ölçüldü):
#   COMPASS_USE2/3 0 + COMPASS_OFS_X 250 / _Y −200   → "PreArm: Check mag field (xy diff:327>100)" (harekât panelindeki uyarının birebiri)
#   COMPASS_AUTODEC 0 + COMPASS_DEC 1,5              → "PreArm: Check mag field (xy diff:235>100)"
#   COMPASS_ORIENT / tek pusulada OFS                → "PreArm: Compasses inconsistent"
#   kayıt yok (temiz SITL; Ankara / 41 K 29 D / 37 K 35 D) → uyarı yok
# Bu adlar kayıtta ve .param dışa aktarımında KORUNUR ama SITL'e yazılmaz (varsayilan.parm + PARAM_SET), olay şeridine bilgi satırı düşer; SITL'in
# kendi ürettiği değerleri (ör. simülatörde pusula kalibrasyonu, AUTODEC) gerçek uçağın kaydının üstüne YAZILMAZ (Izleyici 'sitl' kaynağı).
SENSOR_ONEKLER = ('COMPASS_', 'INS_ACCOFFS_', 'INS_ACCSCAL_', 'INS_ACC2OFFS_', 'INS_ACC2SCAL_', 'INS_ACC3OFFS_', 'INS_ACC3SCAL_')
SENSOR_ADLAR = frozenset({'AHRS_ORIENTATION', 'INS_ACC_ID', 'INS_ACC2_ID', 'INS_ACC3_ID', 'INS_GYR_ID', 'INS_GYR2_ID', 'INS_GYR3_ID'})
SENSOR_ROZET = 'sensör kalibrasyonu (simülasyonda nötr)'
SIM_SRV_REV = 'SIM_SRV_REV'       # HEPGO SITL yaması: sanal montaj bit maskesi (bit n-1 = SERVOn ters monteli)
SIM_SRV_REV_PTYPE = 6             # MAV_PARAM_TYPE_INT32
# Motor (ESC) kanallarına sanal montaj biti KONMAZ: ArduPilot motor çıkışını ham yazar (AP_Motors::rc_write → SRV_Channels::set_output_pwm;
# SERVOn_REVERSED uygulanmaz) → gerçek araçta etkisiz olan REVERSED fizikte ters çevrilse çok rotorlu düşerdi. Kayıtlı SERVOn_FUNCTION motor
# koduysa ya da kayıt yokken araç tipinin varsayılan motor kanalıysa bit atlanır. Helikopterde swash/kuyruk (motor1..4 fonksiyonları) set_output_pwm_trimmed /
# set_output_scaled ile yazılır → REVERSED etkili → dışlama yok. Uçak gazı (70) da scaled → etkili.
MOTOR_FONKSIYONLARI = frozenset(range(33, 41)) | frozenset(range(82, 86)) | frozenset(range(120, 140))   # motor1..8, motor9..12, motor13..32
VARSAYILAN_MOTOR_KANALLARI = {'multirotor': frozenset(range(1, 9)), 'hexarotor': frozenset(range(1, 9)), 'vtol': frozenset(range(5, 9))}
KAYNAKLAR = {'hepgo': 'HEPGO', 'mp': 'Mission Planner', 'sitl': 'SITL (araç)'}
MAX_PARAM = 2000          # dron başına kayıt üst sınırı (içe aktarma)
_oturum_cache = None
_cache_kilit = threading.Lock()


def oturum_adlari():
    """Uçuş simülatörü oturumunun kendisi için yazdığı parametre adları (flightsim'den türetilir; tembel import — döngü yok)."""
    global _oturum_cache
    with _cache_kilit:
        if _oturum_cache is not None:
            return _oturum_cache
        adlar = {'SIM_WIND_SPD', 'SIM_WIND_DIR', 'SIM_SPEEDUP'}
        try:
            from . import flightsim as fs
            for grup in (fs.RC_PARAMLAR, fs.GPS_RTK_PARAMLARI, fs.PLANE_YER_PARAMLARI, fs.TERRAIN_PARAMLARI):   # TERRAIN_ENABLE/SPACING: §18 arazi sunumu oturum ayarı
                adlar |= {a for a, _ in grup}
            for m in ('ramp', 'vehicle', 'wheels'):
                adlar |= {a for a, _ in fs.launch_parametreleri({'method': m, 'angle_deg': 15, 'release_kmh': 70}, 50)}
        except Exception:   # noqa: BLE001 — simülatör modülü yüklenemese bile sabit liste geçerli
            pass
        _oturum_cache = frozenset(adlar)
        return _oturum_cache


def haric_mi(name):
    """Kalıcı yazmadan hariç parametre mi (oturum/simülatör/HEPGO yönetir ya da sayaç)."""
    n = str(name or '')
    if not n:
        return True
    if n in HARIC_DEGIL:
        return False
    if n.startswith(HARIC_ONEKLER) or n in HARIC_ADLAR:
        return True
    return n in oturum_adlari()


def haric_listesi():
    return {'prefixes': list(HARIC_ONEKLER), 'names': sorted(set(HARIC_ADLAR) | set(oturum_adlari())), 'mount': MONTAJ_ACIKLAMA,
            'mount_badge': MONTAJ_ROZET, 'mount_badge_neutral': MONTAJ_ROZET_NOTR,
            'sensor': {'prefixes': list(SENSOR_ONEKLER), 'names': sorted(SENSOR_ADLAR), 'badge': SENSOR_ROZET}}


def sensor_mu(name):
    """Gerçek uçağın sensör kalibrasyonu / yönelimi parametresi mi (SENSOR_ONEKLER / SENSOR_ADLAR): kayıtta kalır, SITL'e yazılmaz."""
    n = str(name or '').upper()
    return n.startswith(SENSOR_ONEKLER) or n in SENSOR_ADLAR


def montaj_mi(name):
    """Donanım montaj parametresi mi (SERVOn_REVERSED, n=1..16): SITL'e aynen gider + SIM_SRV_REV biti (eski ikilide 0)."""
    return bool(MONTAJ_DESENI.match(str(name or '').upper()))


def montaj_kanal(name):
    """SERVOn_REVERSED → n (1..16); montaj değilse None."""
    m = MONTAJ_DESENI.match(str(name or '').upper())
    return int(m.group(1)) if m else None


def motor_kanali_mi(n, fonksiyonlar, tip=None):
    """SERVOn motor (ESC) kanalı mı: kayıtlı SERVOn_FUNCTION motor koduysa; kayıt yoksa araç tipinin varsayılan motor kanalı (helikopterde hiç)."""
    fn = fonksiyonlar.get(n)
    if fn is not None:
        return fn in MOTOR_FONKSIYONLARI
    return n in VARSAYILAN_MOTOR_KANALLARI.get(str(tip or ''), ())


def srv_rev_mask(rows, tip=None, atlanan=None, notr=0, varsayilan=None):
    """Kayıtlı satırlardan SIM_SRV_REV bit maskesi: SERVOn_REVERSED ≠ 0 → bit n-1 (rows: {name, value} dizisi ya da ad→değer sözlüğü).
    Motor kanalları atlanır (`motor_kanali_mi`; `tip` araç tipi — varsayılan fonksiyonlar); atlanan adlar `atlanan` listesine eklenir.
    `notr`: SITL fizik modelinin NÖTR montaj maskesi (ör. `plane-elevon` kanal 1/2 REVERSED 1 ile düz uçar → 0b11; `plane-vtail` kanal 2 → 0b10;
    düz plane 0). Bit = (etkin REVERSED ≠ 0) XOR nötr — kullanıcının gerçek değeri modelin beklediğinden farklıysa fizik o kanalı yansıtır.
    `varsayilan`: kayıtta olmayan REVERSED adlarının oturumda SITL'e giden değeri (düzen seti; ad → değer) — etkin değer kayıt ?? varsayılan ?? 0."""
    cift = list(rows.items()) if isinstance(rows, dict) else [(r['name'], r['value']) for r in rows]
    if varsayilan:
        var = {str(a).upper() for a, _ in cift}
        cift = cift + [(a, v) for a, v in dict(varsayilan).items() if str(a).upper() not in var]
    fonksiyonlar = {}
    for ad, deger in cift:
        a = str(ad or '').upper()
        if a.startswith('SERVO') and a.endswith('_FUNCTION') and a[5:-9].isdigit():
            try:
                fonksiyonlar[int(a[5:-9])] = int(round(float(deger)))
            except (TypeError, ValueError):
                continue
    mask = 0
    for ad, deger in cift:
        n = montaj_kanal(ad)
        try:
            if n is None or float(deger) == 0.0:
                continue
        except (TypeError, ValueError):
            continue
        if motor_kanali_mi(n, fonksiyonlar, tip):
            if atlanan is not None:
                atlanan.append(str(ad).upper())
            continue
        mask |= 1 << (n - 1)
    return mask ^ (int(notr or 0) & 0xFFFF)


def sitl_kayitlari(rows, sanal_montaj=True, tip=None, notr=0, varsayilan=None):
    """Kayıtlı satırların SITL'e gidecek biçimi (varsayilan.parm + ilk kalp atışı PARAM_SET).
    `sanal_montaj` True (ikili SIM_SRV_REV tanır; `drone_sitl.sanal_montaj_destegi`): satırlar aynen + sonuna SIM_SRV_REV = `srv_rev_mask`
    (0 dahil: eski oturumdan eeprom'da kalan maske silinsin). False (eski ikili): montaj parametreleri 0'a çekilir (sanal montaj düz).
    `tip`: araç tipi (motor kanalı dışlaması; `srv_rev_mask`). Sensör kalibrasyonu/yönelimi adları (`sensor_mu`) SITL'e gitmez → 'sensor_skipped'.
    Dönüş: ([{name, value, ptype}], {'virtual_mount': bool, 'mask': int, 'neutral': [adlar], 'reversed': [adlar], 'motor_skipped': [adlar],
    'sensor_skipped': [adlar]})."""
    notr_mask = notr
    out, notr, ters, motor, sensor = [], [], [], [], []
    for r in rows:
        if sensor_mu(r['name']):
            sensor.append(str(r['name']))
            continue
        v = float(r['value'])
        if montaj_mi(r['name']) and v != 0.0:
            if sanal_montaj:
                ters.append(str(r['name']))
            else:
                v = 0.0
                notr.append(str(r['name']))
        out.append({'name': r['name'], 'value': v, 'ptype': r.get('ptype')})
    mask = srv_rev_mask(rows, tip, motor, notr_mask, varsayilan) if sanal_montaj else 0
    if sanal_montaj:
        out.append({'name': SIM_SRV_REV, 'value': float(mask), 'ptype': SIM_SRV_REV_PTYPE})
    return out, {'virtual_mount': bool(sanal_montaj), 'mask': mask, 'neutral': notr, 'reversed': [a for a in ters if a not in motor], 'motor_skipped': motor,
                 'sensor_skipped': sensor}


def sensor_olayi(bilgi):
    """Sensör kalibrasyonu parametreleri SITL'e yazılmadıysa olay şeridi metni + önem (6); yoksa None."""
    adlar = list((bilgi or {}).get('sensor_skipped') or [])
    if not adlar:
        return None
    ozet = ', '.join(adlar[:6]) + (f' … (+{len(adlar) - 6})' if len(adlar) > 6 else '')
    return (f'{len(adlar)} sensör kalibrasyonu/yönelimi parametresi ({ozet}) simülasyonda uygulanmadı — SITL ideal sanal pusula/IMU kullanır '
            '(gerçek uçağın değerleri "PreArm: Check mag field" / "Compasses inconsistent" üretirdi); kayıt ve .param dışa aktarımı korunur', 6)


def montaj_olayi(bilgi):
    """Oturum açılışı olay şeridi metni + önem (6 bilgi / 4 sarı uyarı); montaj kaydı yoksa None."""
    if bilgi['neutral']:
        return f"{', '.join(bilgi['neutral'])}: {MONTAJ_DESTEK_YOK} (SITL'e 0 yazıldı; kayıt ve .param dışa aktarımı gerçek değeri korur)", 4
    if bilgi['reversed']:
        ek = f" ({', '.join(bilgi['motor_skipped'])}: motor kanalı, ArduPilot REVERSED uygulamaz → bit yok)" if bilgi.get('motor_skipped') else ''
        return f"{', '.join(bilgi['reversed'])}: sanal uçakta servo montajı da ters (SIM_SRV_REV = {bilgi['mask']}) — gerçek uçakla aynı davranış{ek}", 6
    if bilgi.get('mask'):
        return f"Sanal montaj: SITL uçuş modelinin nötr servo yönü kayıtlı yapılandırmadan farklı → SIM_SRV_REV = {bilgi['mask']} (gerçek yapılandırmayla düzgün uçar)", 6
    if bilgi.get('motor_skipped'):
        return f"{', '.join(bilgi['motor_skipped'])}: motor (ESC) kanalında servo ters çevirme etkisizdir (ArduPilot ham PWM yazar) — sanal montaj biti konmadı (SIM_SRV_REV = {bilgi['mask']})", 6
    return None


def _ad(name):
    n = str(name or '').strip().upper().rstrip('\x00')
    return n if AD_DESENI.match(n) else None


# ---------------- veritabanı ----------------
def yukle(drone_id, conn=None):
    """Dronun kayıtlı parametreleri: [{name, value, ptype, source, source_text, updated_at, updated_by, updated_by_name}] (ada göre)."""
    sql = '''SELECT p.name, p.value, p.ptype, p.source, p.updated_at, p.updated_by, u.full_name AS updated_by_name
             FROM drone_sitl_params p LEFT JOIN users u ON u.id = p.updated_by WHERE p.drone_id = ? ORDER BY p.name'''
    if conn is not None:
        rows = db.rows(conn.execute(sql, (int(drone_id),)))
    else:
        with db.connect() as c:
            rows = db.rows(c.execute(sql, (int(drone_id),)))
    for r in rows:
        r['source_text'] = KAYNAKLAR.get(r['source'], r['source'])
        r['mount'] = montaj_mi(r['name'])   # montaj parametresi: UI rozeti (MONTAJ_ROZET / ikili desteklemiyorsa MONTAJ_ROZET_NOTR)
        r['sensor'] = sensor_mu(r['name'])  # sensör kalibrasyonu/yönelimi: kayıtta kalır, SITL'e yazılmaz (UI rozeti SENSOR_ROZET)
    return rows


def kaydet(drone_id, name, value, ptype=None, source='hepgo', user_id=None, conn=None):
    """Tek parametreyi yazar/günceller (UPSERT). Hariç ya da geçersiz ad → False."""
    n = _ad(name)
    if n is None or haric_mi(n):
        return False
    try:
        v = float(value)
    except (TypeError, ValueError):
        return False
    args = (int(drone_id), n, v, int(ptype) if ptype else None, db.now(), user_id, source if source in KAYNAKLAR else 'hepgo')
    sql = '''INSERT INTO drone_sitl_params (drone_id, name, value, ptype, updated_at, updated_by, source) VALUES (?,?,?,?,?,?,?)
             ON CONFLICT(drone_id, name) DO UPDATE SET value = excluded.value, ptype = COALESCE(excluded.ptype, drone_sitl_params.ptype),
             updated_at = excluded.updated_at, updated_by = excluded.updated_by, source = excluded.source'''
    if conn is not None:
        conn.execute(sql, args)
    else:
        with db.connect() as c:
            c.execute(sql, args)
            c.commit()
    return True


def sil(drone_id, name=None, conn=None):
    """Tek parametreyi (name) ya da dronun tüm kayıtlarını siler; silinen satır sayısı."""
    if name is not None:
        sql, args = 'DELETE FROM drone_sitl_params WHERE drone_id = ? AND name = ?', (int(drone_id), str(name).upper())
    else:
        sql, args = 'DELETE FROM drone_sitl_params WHERE drone_id = ?', (int(drone_id),)
    if conn is not None:
        return conn.execute(sql, args).rowcount
    with db.connect() as c:
        n = c.execute(sql, args).rowcount
        c.commit()
    return n


# ---------------- .param (Mission Planner) biçimi ----------------
def param_metni(rows, baslik=None):
    """Mission Planner `.param` biçimi: `AD,DEĞER` satırları (# yorum). Tam sayı değerler ondalıksız yazılır."""
    out = [f'#NOTE: {baslik}'] if baslik else []
    montaj = [str(r['name']) for r in rows if montaj_mi(r['name'])]
    if montaj and baslik:   # gerçek uçağa giden dosyada montaj değeri korunur; yorum satırı MP tarafından yok sayılır
        out.append(f"#NOTE: {', '.join(montaj)}: montaj parametresi — gerçek uçak değeri; sanal uçakta aynen uygulanır (SIM_SRV_REV)")
    for r in rows:
        v = float(r['value'])
        out.append(f"{r['name']},{int(v) if v == int(v) and abs(v) < 1e15 else repr(v)}")
    return '\n'.join(out) + '\n'


def param_ayristir(text):
    """`.param` / `.parm` metnini çözer: `AD,DEĞER`, `AD DEĞER`, `AD\\tDEĞER`; # ve // yorum, boş satır atlanır.
    Dönüş: (gecerli [(ad, değer)], atlanan [{line, reason}])."""
    gecerli, atlanan = [], []
    for i, ham in enumerate(str(text or '').splitlines(), 1):
        s = ham.strip()
        if not s or s.startswith(('#', '//')):
            continue
        parca = [p for p in re.split(r'[,\t ]+', s) if p]
        if len(parca) < 2:
            atlanan.append({'line': i, 'text': s[:60], 'reason': 'biçim'})
            continue
        n = _ad(parca[0])
        if n is None:
            atlanan.append({'line': i, 'text': s[:60], 'reason': 'ad'})
            continue
        try:
            v = float(parca[1])
        except ValueError:
            atlanan.append({'line': i, 'text': s[:60], 'reason': 'değer'})
            continue
        if haric_mi(n):
            atlanan.append({'line': i, 'text': n, 'reason': 'hariç'})
            continue
        gecerli.append((n, v))
    return gecerli, atlanan


def ice_aktar(drone_id, text, user_id=None, conn=None):
    """`.param` metnini dronun kayıtlarına yazar (source hepgo). Dönüş: {imported, skipped[], count}."""
    gecerli, atlanan = param_ayristir(text)
    if len(gecerli) > MAX_PARAM:
        raise ValueError(f'En çok {MAX_PARAM} parametre içe aktarılabilir')
    own = conn is None
    c = conn or db.connect()
    try:
        for n, v in gecerli:
            kaydet(drone_id, n, v, None, 'hepgo', user_id, conn=c)
        if own:
            c.commit()
        toplam = c.execute('SELECT COUNT(*) FROM drone_sitl_params WHERE drone_id = ?', (int(drone_id),)).fetchone()[0]
    finally:
        if own:
            c.close()
    return {'imported': len(gecerli), 'skipped': atlanan[:50], 'skipped_count': len(atlanan), 'count': toplam}


# ---------------- dron simülasyon seçenekleri (tablo drone_sitl_options; §23 güç ve yakıt) ----------------
# key: max_speed_ms · fuel_l · fuel_km_per_l_last · elec_cells · elec_mah · elec_w_last (değerler metin; sayı olarak okunur).
# Oturum sonunda ölçülen km/L ve ortalama W (`*_last`) yazılır → sonraki sihirbazda önerilir; kullanıcı PUT ile tüm alanları değiştirebilir.
SECENEK_ANAHTARLARI = ('max_speed_ms', 'fuel_l', 'fuel_km_per_l_last', 'elec_cells', 'elec_mah', 'elec_w_last')


def secenekleri_oku(drone_id, conn=None):
    """Dronun simülasyon seçenekleri: {key: float} (yalnız SECENEK_ANAHTARLARI; sayıya çevrilemeyen atlanır) + `updated_at` (en son)."""
    sql = 'SELECT key, value, updated_at FROM drone_sitl_options WHERE drone_id = ?'
    if conn is not None:
        rows = db.rows(conn.execute(sql, (int(drone_id),)))
    else:
        with db.connect() as c:
            rows = db.rows(c.execute(sql, (int(drone_id),)))
    out, son = {}, None
    for r in rows:
        if r['key'] not in SECENEK_ANAHTARLARI:
            continue
        try:
            out[r['key']] = float(r['value'])
        except (TypeError, ValueError):
            continue
        son = max(son or '', r['updated_at'] or '')
    if 'elec_cells' in out:
        out['elec_cells'] = int(round(out['elec_cells']))
    if son:
        out['updated_at'] = son
    return out


def secenek_yaz(drone_id, degerler, user_id=None, conn=None):
    """Seçenekleri yazar (UPSERT; None → satır silinir). Bilinmeyen anahtar yok sayılır. Dönüş: yazılan anahtar sayısı."""
    own = conn is None
    c = conn or db.connect()
    n = 0
    try:
        for k, v in (degerler or {}).items():
            if k not in SECENEK_ANAHTARLARI:
                continue
            if v is None:
                c.execute('DELETE FROM drone_sitl_options WHERE drone_id = ? AND key = ?', (int(drone_id), k))
                n += 1
                continue
            try:
                fv = float(v)
            except (TypeError, ValueError):
                continue
            c.execute('''INSERT INTO drone_sitl_options (drone_id, key, value, updated_at, updated_by) VALUES (?,?,?,?,?)
                         ON CONFLICT(drone_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by''',
                      (int(drone_id), k, repr(fv) if fv != int(fv) else str(int(fv)), db.now(), user_id))
            n += 1
        if own:
            c.commit()
    finally:
        if own:
            c.close()
    return n


def guc_onerisi(drone_id, conn=None):
    """Dron kaydından sihirbaz/`power` önerisi (flightsim_power.ALANLAR adlarıyla): kayıtlı değerler; yoksa boş sözlük."""
    s = secenekleri_oku(drone_id, conn)
    esleme = {'max_speed_ms': 'max_speed_ms', 'fuel_l': 'fuel_l', 'fuel_km_per_l_last': 'fuel_km_per_l', 'elec_cells': 'elec_cells', 'elec_mah': 'elec_mah', 'elec_w_last': 'elec_w'}
    return {alan: s[k] for k, alan in esleme.items() if k in s}


def parm_satirlari(rows, sanal_montaj=True, tip=None, notr=0, varsayilan=None):
    """varsayilan.parm'a eklenecek `AD DEĞER` satırları (drone_sitl.parm_metni `ekstra`); `sitl_kayitlari` biçimi (SIM_SRV_REV dahil;
    eski ikilide montaj 0). Hariç adlar (haric_mi) yazılmaz; SIM_SRV_REV hariç olsa da yazılır (kayıt değil, üretilen maske)."""
    sitl, _ = sitl_kayitlari(rows, sanal_montaj, tip, notr, varsayilan)
    return [f"{r['name']} {float(r['value']):g}" for r in sitl if r['name'] == SIM_SRV_REV or not haric_mi(r['name'])]


# ---------------- canlı izleme ----------------
class Izleyici:
    """Bir dronun (drone_id) çalışan SITL'i için PARAM_VALUE izleyicisi. Olay döngüsünde çağrılır (kısa sqlite yazımı).
    `bildir(metin, severity)`: olay şeridi/konsol (isteğe bağlı)."""

    def __init__(self, drone_id, bildir=None, sanal_montaj=True, srv_rev_yaz=None, tip=None):
        self.drone_id = int(drone_id)
        self.bildir = bildir
        self.tip = tip                           # araç tipi (drone_sitl.TIP_ESLEME anahtarı): motor kanalı dışlaması (srv_rev_mask)
        self.sanal_montaj = bool(sanal_montaj)   # SITL ikilisi SIM_SRV_REV tanır: montaj kaydında maske anında güncellenir (srv_rev_yaz(mask))
        self.srv_rev_yaz = srv_rev_yaz           # callable(mask:int) → SITL'e SIM_SRV_REV PARAM_SET (oturum sağlar); None → yalnız bildirim
        self.srv_rev_mask = None                 # son yazılan/gözlenen maske
        self.notr_mask = 0                       # SITL modelinin nötr montaj maskesi (srv_rev_mask notr; oturum düzeni belirler)
        self.varsayilan_rev = None               # kayıtta olmayan REVERSED adlarının oturum değeri (düzen seti)
        self.taban = {}       # ad → son bilinen değer (SITL'den öğrenilen)
        self.bekleyen = {}    # ad → (source, user_id, hedef, zaman): PARAM_SET gönderildi, yankı bekleniyor
        self.yukleme = set()  # açılışta bizim yazdığımız kayıtlılar: yankı yalnız tabana işlenir
        # Niyetsiz fark ("sitl" kaynağı) yalnız ilk TAM parametre listesi (Mission Planner / param_list akışı) alındıktan sonra kaydedilir:
        # tekil yankılar tabanı kurar ama aracın açılış kalibrasyonları gibi ara değişimler kayıt üretmez (gerçek SITL ölçümü)
        self.taban_tam = False
        self.param_count = None
        self._listelenen = set()
        self.kayit_sayisi = 0
        self.son_kayit = None
        self._gcs_parser = None

    # -- niyet bildirimleri (ad → (source, user_id, hedef değer, zaman)); yankı yalnız hedef değerle eşleşince niyeti tüketir:
    #    köprü çekirdeği / MavKomut tip bilinmiyorsa önce PARAM_REQUEST_READ yapar, o ESKİ değerli yankı niyeti düşürmemeli (gerçek SITL'de ölçüldü) --
    def hepgo_set(self, name, value=None, user_id=None):
        self._niyet(name, value, 'hepgo', user_id)

    def mp_set(self, name, value=None):
        self._niyet(name, value, 'mp', None)

    def _niyet(self, name, value, source, user_id):
        n = _ad(name)
        if n is None:
            return
        try:
            hedef = float(value) if value is not None else None
        except (TypeError, ValueError):
            hedef = None
        self.bekleyen[n] = (source, user_id, hedef, time.time())

    @staticmethod
    def _esit(a, b):
        return abs(a - b) <= 1e-4 * max(1.0, abs(b))

    def yukleme_isaretle(self, names):
        for a in names:
            n = _ad(a)
            if n is not None:
                self.yukleme.add(n)

    def gcs_bayt(self, data):
        """GCS'den (Mission Planner, UDP) gelen ham baytlar: yalnız PARAM_SET mesajları yakalanır (SITL'e iletim değişmez)."""
        if self._gcs_parser is None:
            try:
                from pymavlink.dialects.v20 import ardupilotmega as d
                self._gcs_parser = d.MAVLink(None)
                self._gcs_parser.robust_parsing = True
            except Exception:   # noqa: BLE001
                return
        try:
            msgs = self._gcs_parser.parse_buffer(data) or []
        except Exception:   # noqa: BLE001
            return
        for m in msgs:
            try:
                if m.get_type() == 'PARAM_SET':
                    self.mp_set(str(m.param_id).rstrip('\x00'), m.param_value)
            except Exception:   # noqa: BLE001
                continue

    # -- SITL yankısı --
    def tam_liste_isaretle(self):
        self.taban_tam = True

    def param_value(self, name, value, ptype=None, index=None, count=None):
        """SITL'den PARAM_VALUE (`index`/`count`: param_index/param_count — liste akışında taban tamlığı için). Kaydedildiyse {name, value, source}."""
        n = _ad(name)
        if n is None:
            return None
        try:
            v = float(value)
        except (TypeError, ValueError):
            return None
        if not self.taban_tam and count and index is not None and 0 <= int(index) < 65535:
            self.param_count = int(count)
            self._listelenen.add(n)
            if len(self._listelenen) >= TABAN_TAM_ORAN * self.param_count:
                self.taban_tam = True
        bek = self.bekleyen.get(n)
        if bek is not None:
            if time.time() - bek[3] > NIYET_SURESI_S:
                self.bekleyen.pop(n, None)   # eski niyet (yazma reddedildi / yankı gelmedi)
                bek = None
            elif bek[2] is None or self._esit(v, bek[2]):
                self.bekleyen.pop(n, None)   # hedef değerle eşleşen yankı: niyet tüketildi
            else:
                bek = None                   # ara okuma (eski değer): niyet bekler, değer yalnız tabana işlenir
                self.taban[n] = v
                return None
        if haric_mi(n):
            self.taban[n] = v
            return None
        if n in self.yukleme:
            self.yukleme.discard(n)
            self.taban[n] = v
            return None
        eski = self.taban.get(n)
        self.taban[n] = v
        if bek is None:
            if eski is None or self._esit(v, eski) or not self.taban_tam:
                return None   # ilk öğrenme (taban), değişmedi ya da tam liste henüz alınmadı
            if sensor_mu(n):
                return None   # SITL'in sanal sensörüne ait değer (simülatörde kalibrasyon, AUTODEC): gerçek uçağın kaydına yazılmaz
            source, user_id = 'sitl', None
        else:
            source, user_id = bek[0], bek[1]
        try:
            if not kaydet(self.drone_id, n, v, ptype, source, user_id):
                return None
        except Exception as e:   # noqa: BLE001 — veritabanı hatası uçuşu bozmasın
            self._bildir(f'Parametre kaydedilemedi: {n} ({e})'[:200], 4)
            return None
        self.kayit_sayisi += 1
        self.son_kayit = {'name': n, 'value': v, 'source': source}
        self._bildir(f'Parametre kalıcı kaydedildi: {n} = {v:g} ({KAYNAKLAR.get(source, source)})', 6)
        if montaj_mi(n):   # montaj parametresi değişti: sanal montaj maskesini SITL'de anında güncelle (ikili destekliyorsa), yoksa sarı uyarı
            self._montaj_degisti(n, v)
        return self.son_kayit

    def _montaj_degisti(self, n, v):
        if not self.sanal_montaj:
            if v != 0.0:
                self._bildir(self.montaj_uyarisi(n), 4)
            return
        try:
            motor = []
            mask = srv_rev_mask(yukle(self.drone_id), self.tip, motor, self.notr_mask, self.varsayilan_rev)   # kayıt az önce güncellendi → tüm kanalların güncel maskesi
        except Exception as e:   # noqa: BLE001
            self._bildir(f'SIM_SRV_REV hesaplanamadı: {e}'[:200], 4)
            return
        self.srv_rev_mask = mask
        if self.srv_rev_yaz is not None:
            try:
                self.srv_rev_yaz(mask)
            except Exception as e:   # noqa: BLE001
                self._bildir(f'SIM_SRV_REV yazılamadı: {e}'[:200], 4)
                return
        if n in motor:
            self._bildir(f'{n} = {v:g}: motor (ESC) kanalında servo ters çevirme etkisizdir (ArduPilot ham PWM yazar) — sanal montaj biti konmadı (SIM_SRV_REV = {mask})', 6)
        else:
            self._bildir(f'{n} = {v:g}: sanal uçakta servo montajı güncellendi (SIM_SRV_REV = {mask}) — gerçek uçakla aynı davranış', 6)

    def montaj_uyarisi(self, n):
        """Eski ikili (SIM_SRV_REV yok): REVERSED≠0 bu oturumda SITL'de etkili (kontrol tersine döner), yeni oturumda 0 yazılır."""
        return f'{n}: {MONTAJ_UYARI}. Kayıt korunur (dışa aktarımda gerçek değer); bu oturumda SITL\'de etkili, yeni oturumda 0 yazılır ({MONTAJ_DESTEK_YOK})'

    def _bildir(self, metin, sev):
        if self.bildir is not None:
            try:
                self.bildir(metin, sev)
            except Exception:   # noqa: BLE001
                pass
