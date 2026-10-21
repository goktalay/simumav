"""Uçuş Simülatörü (`drone.sim`) — sunucu tarafı (sözleşme: docs/ucus-simulatoru.md §1–§4).

Oturum = gerçek ArduPilot SITL süreci (app/drone_sitl.py yöneticisi, kimlik 9000+N) + UDP sunucu (Mission Planner bağlanır)
+ MAVLink köprüsü (SITL SERIAL0 TCP ↔ UDP, ham bayt) + telemetri ayrıştırıcı (pymavlink) + WebSocket yayını (ATTITUDE/konum geldikçe, 50 Hz tavan; sahte kip 50 Hz).

Kurallar:
- SERIAL0 TCP bağlantısı oturum boyunca AÇIK tutulur (kapanınca SITL çıkar — drone_sitl Tuzak F).
- UDP'de ilk paket gönderen adres GCS olarak kilitlenir; 30 sn sessizlikte kilit kalkar. Başka adresten gelen paketler iletilmez.
- İzleyici yok + GCS yok → BOSTA_SURE sonra oturum kapanır; SIM_MAX_MINUTES dolunca kapanır; lifespan kapanışında hepsi kapanır.
- `HEPGO_SITL=0` (testler): SITL yerine sahte kinematik (merkez etrafında daire); köprü, `MANAGER.sahte_tcp_port` verilirse
  o TCP adresine bağlanır (test içindeki sahte "SITL" sunucusu) — böylece TCP↔UDP yolu gerçek kodla sınanır.

Ortam değişkenleri: SIM_UDP_BASE (14550; +99'a kadar boş port aranır), SIM_MAX_SESSIONS (2), SIM_MAX_MINUTES (120),
SIM_PUBLIC_HOST (Mission Planner'a verilecek adres; yoksa istek Host'u), HEPGO_SITL, HEPGO_SITL_DIR (drone_sitl).
"""
import asyncio
import contextlib
import json
import math
import os
import re
import time

from . import db, drone_params, drone_sitl, flightsim_gcs, flightsim_hub, flightsim_icept, flightsim_launcher, flightsim_mission, flightsim_power, flightsim_targets

SITL_ENABLED = os.environ.get('HEPGO_SITL', '1') != '0'
UDP_BASE = int(os.environ.get('SIM_UDP_BASE', '14550'))
UDP_ARALIK = 100                      # SIM_UDP_BASE … SIM_UDP_BASE+99
MAX_SESSIONS = max(1, int(os.environ.get('SIM_MAX_SESSIONS', '2')))
MAX_MINUTES = max(1, int(os.environ.get('SIM_MAX_MINUTES', '120')))
PUBLIC_HOST = os.environ.get('SIM_PUBLIC_HOST', '').strip()
KIMLIK_TABANI = 9000                  # SITL yöneticisinde oturum kimliği (saha görevlerinin sanal dronlarıyla çakışmaz)
TELE_HZ = 50                          # sahte kinematik adımı ve yayın üst sınırı (gerçek SITL: her ATTITUDE/GLOBAL_POSITION_INT'te yayın)
TELE_MIN_ARALIK = 1.0 / TELE_HZ       # sn: iki `tele` arası en az (olay güdümlü yayında 50 Hz tavanı)
TELE_BEKCI = 0.25                     # sn: SITL'den konum/yönelim gelmese de HUD için en az 4 Hz yayın
GCS_SESSIZLIK = 30.0                  # sn: GCS kilidi kalkar
BOSTA_SURE = 600.0                    # sn: izleyici + GCS yokken oturum kapanır
PARAM_DOKUM_S = max(0.0, float(os.environ.get('SIM_PARAM_DUMP_S', '6') or 6))   # §21: kapanışta PARAM_REQUEST_LIST bekleme üst sınırı (sn)
SITL_BAGLANTI_S = 40                  # SITL SERIAL0'ı dinleyene dek bağlanma denemesi (Tuzak D)
VIEWER_QUEUE = 64
GCS_SYSID, GCS_COMP = 255, 191        # kendi MAVLink kaynağımız (255 = SYSID_MYGCS: RC override kabul edilir; 191 ≠ Mission Planner'ın 190'ı)
EV_IRTIFA = 100.0
EV_FARK_UYARI = 15.0                  # m: merkez kaydındaki `alt` ile arazi yüksekliği farkı bundan büyükse sihirbaz/olay şeridinde uyarı (§9 ev irtifası kuralı)
RC_HZ_MIN_ARALIK = 1.0 / 40           # WS `rc` tavanı (ön yüz 20 Hz gönderir; jitter payı). Serbest bırakma paketi (8×0) sınırlanmaz.
# Yüksek hızlı akış: MAV_CMD_SET_MESSAGE_INTERVAL (msgid → µs). REQUEST_DATA_STREAM 10 Hz (ALL) de gönderilir; Mission Planner bağlanıp kendi
# akış isteklerini yolladığında bizim aralıklar ezilebilir → `_dongu` içinde düzenli olarak yeniden istenir.
MESAJ_ARALIKLARI = ((30, 20000), (33, 20000), (32, 20000), (74, 50000), (65, 100000), (36, 50000))   # ATTITUDE, GLOBAL_POSITION_INT, LOCAL_POSITION_NED, VFR_HUD, RC_CHANNELS, SERVO_OUTPUT_RAW
# ArduPlane (50 Hz ana döngü) 20 ms SET_MESSAGE_INTERVAL'ı REDDEDER (MAV_RESULT 2); ArduCopter kabul eder. Red görülürse akış bazlı
# REQUEST_DATA_STREAM'e geçilir (ikisi de kabul eder; plane ≈ 52 Hz, copter 66 Hz verir — bu yüzden önce SMI denenir, tam 50 Hz).
AKIS_HIZLARI = ((10, 50), (6, 50), (11, 20), (3, 10))   # EXTRA1 (ATTITUDE), POSITION (GLOBAL_POSITION_INT, LOCAL_POSITION_NED), EXTRA2 (VFR_HUD), RC_CHANNELS
AKIS_YENILE_S = 3.0                   # sn: mesaj aralıklarını yeniden iste
TELE_TBM_KAPI = 18                    # ms: iki yayın arası en az SITL zamanı (50 Hz akışta her kare geçer; TCP parçalanmasından bağımsız)
# Sanal kumanda (RC_CHANNELS_OVERRIDE) için SITL parametreleri: RC failsafe akışı bozmasın (override kesilince RTL/kayıp yok)
RC_PARAMLAR = (('SIM_RC_FAIL', 0), ('FS_THR_ENABLE', 0), ('THR_FAILSAFE', 0), ('RC_OVERRIDE_TIME', 3.0))

TIP_ADLARI = {'multirotor': 'Multikopter', 'hexarotor': 'Hexakopter', 'helikopter': 'Helikopter', 'sabit_kanat': 'Sabit Kanat', 'vtol': 'VTOL',
              'interceptor': 'INTERCEPTOR', 'rover': 'Kara Aracı'}
PLANE_TIPLERI = ('sabit_kanat', 'vtol', 'interceptor')   # ArduPlane ikilisi (interceptor = quadplane tailsitter, §25)
DIKEY_TIPLER = ('interceptor',)   # §25: dikey kalkış/iniş yapan uçak tipi (pist/rampa yok; GUIDED VTOL kalkışı, RTL → dikey iniş)
# §31 KARA ARACI (ArduRover): kalkış/iniş yok, motor kesme yok; sürüş biçimi `drive` — ackermann (ön tekerlek direksiyonu; SITL `rover`) | skid
# (paletli / diferansiyel; SITL `rover-skid`, SERVO1 sol / SERVO3 sağ gaz). Eksikse modelin `drive`'ı (dahili 4×4 → ackermann, palet/robot → skid).
ROVER_TIPLERI = ('rover',)
DRIVES = ('ackermann', 'skid')
MAV_TYPE_GROUND_ROVER = 10
KOMUTLAR = ('arm', 'disarm', 'mode', 'takeoff', 'rtl', 'reset', 'crash', 'set_home', 'rc', 'speed', 'camera', 'defend', 'motor_cut', 'wind', 'launch_aim')   # speed: §23 SIM_SPEEDUP {factor: 1|2|4|8}; camera: §22.3 {type}; defend: §26 {action: 'next'}; motor_cut: {on: bool}; wind: §31 {ms, dir, gust, turb} (uçuşta rüzgâr); launch_aim: §31 {azimuth_deg, angle_deg} (rampa, ARM öncesi)
# Motor kesme (`motor_cut {on}`; yalnız uçak tipleri): ARM'lı kalır, motor durur, kumanda yüzeyleri ve uçuş kipi çalışmaya devam eder → süzülme.
# Gerçek ArduPlane 4.7.2 SITL'de ölçüldü (100–145 m AGL; FBWA/FBWB/CRUISE/AUTO/RTL/MANUAL):
#   · zorla DISARM (400, 21196): yüzeyler stabilize etmeye devam eder ve fizik süzülür, AMA ArduPlane disarm'lıyken HOME'u anlık konuma taşır →
#     `relative_alt` 0,7 sn'de 145 m → −11 m'ye düşer (alt_msl doğru kalır); yeniden ARM'da HOME geri gelmez, RTL disarm noktasına döner.
#   · THR_MAX 0: otomatik gaz kiplerinde keser ama MANUAL'de gaz doğrudan geçer (motor çalışmaya devam eder) + kalıcı parametre kaydını kirletir.
#   · MAV_CMD_DO_AUX_FUNCTION (218) · RC seçeneği 31 MOTOR_ESTOP HIGH/LOW: tüm kiplerde SERVO3 = 1000 µs (itki 0), ARM korunur, HOME/irtifa
#     doğru, kip değişimi ve ARM komutundan etkilenmez, LOW ile motor anında geri gelir (ACK 0). Parametre yazmaz → SEÇİLEN YOL.
MOTOR_ESTOP_AUX = 31        # RC_Channel::AUX_FUNC::MOTOR_ESTOP
MAV_CMD_DO_AUX_FUNCTION = 218
MOTOR_CUT_RED_S = 3.0       # sn: bu süre içinde 218 reddedilirse bayrak geri alınır
# Sahte kinematik süzülmesi (HEPGO_SITL=0): süzülme oranı ve hızı (gerçek SITL `plane` modelinin ölçülen en iyi L/D'si ≈ 7; sahte kip istenen 1:8–1:12 bandında)
SAHTE_SUZULME_ORANI = 10.0  # L/D (yatay / düşey)
SAHTE_SUZULME_HIZ = 12.0    # m/s hava hızı
SAHTE_ROLL_AZAMI = math.radians(45)
# §22.3 kamera türü (gimbal/FPV kamerası ve PiP): sunucu yalnız enum doğrular; oturumda/kayıt satırında saklanır, kayıttan oynatma aynı türü açar
KAMERA_TURLERI = ('day', 'thermal', 'night')


def kamera_dogrula(v, varsayilan='day'):
    """`camera`: None/boş → varsayılan; 'day' | 'thermal' | 'night' dışı → SimHata('invalid')."""
    if v is None or v == '':
        return varsayilan
    if not isinstance(v, str) or v not in KAMERA_TURLERI:
        raise SimHata('invalid', 'camera day | thermal | night olmalı')
    return v

# Sabit kanat kalkış yöntemi (§13): wheels (tekerlekli pist koşusu) · ramp (pnömatik fırlatma rampası; açı 10–30°) · vehicle (pickup üstünden bırakma; hız 40–110 km/h)
LAUNCH_DEFAULTS = {'method': 'wheels', 'angle_deg': 15, 'release_kmh': 70}
LAUNCH_METHODS = ('wheels', 'ramp', 'vehicle') + flightsim_launcher.ICEPT_METHODS   # §27 INTERCEPTOR fırlatıcıları: pod4 | pod8 | tube | handheld
SABIT_KANAT_LAUNCH = ('wheels', 'ramp', 'vehicle')
LAUNCH_SITL_MODEL = {'ramp': 'plane-catapult'}   # SITL `--model` geçersizleştirmesi: mancınık modeli (servo 7 tetiği ile 15 m/s² · 2 sn fırlatma ivmesi)
LAUNCH_SERVO = 7                                 # SIM_Plane: servos[6] > 1700 → fırlatma (DO_SET_SERVO 7)
RAMP_ACCEL = 8.0                                 # TKOFF_THR_MINACC (m/s²): fırlatma ivmesi algılanınca gaz
# Yerde kayma düzeltmesi (§13; arduplane 4.7.2 SITL ile ölçüldü): SITL ServoModel gaz kanalını SABİT 1000–2000 µs aralığına eşler
# (filter_range: (pwm-1000)/1000); ArduPlane disarm'da / gaz 0'da çıkışı SERVO3_MIN=SERVO3_TRIM=1100 (varsayılan) yapar → SITL %10 itki
# (plane: 2,8 N ≈ 1,4 m/s²) → yer sürtünmesi (0,3·v) ile denge 3,97 m/s: uçak disarm'da burun yönünde kayar (60 sn'de 236 m; SIMSTATE = GPS,
# gürültü değil). SIM_GND_BEHAV plane modelinde okunmaz. SERVO3_MIN/TRIM 1000 → itki 0 → 60 sn'de 0,000 m (rüzgâr 3 m/s'de de). Uçuşta gaz
# eşlemesi SITL'in varsaydığı 1000–2000 ile birebir örtüşür (0 → 0 itki, 100 → tam itki).
PLANE_YER_PARAMLARI = (('SERVO3_MIN', 1000.0), ('SERVO3_TRIM', 1000.0), ('CRASH_DETECT', 0.0))   # CRASH_DETECT 0: ArduPlane yazılımsal çarpışma tespiti/disarm kapalı — çarpışma kararı SITL fiziği + 3B (§18)
# Flaplar (yalnız sabit_kanat; VTOL hariç): SERVO5/6 = flap_auto (3) → ArduPlane kalkışta TKOFF_FLAP_PCNT, inişte LAND_FLAP_PERCNT ile flapları kendisi
# açar; 3B model (flightsim3d.js) SERVOn_FUNCTION kodlarını `tele.servo_fn` ile eşler. Oturum BAŞLANGIÇ değeridir ama dron yapılandırması sayılır:
# kullanıcı MP/panelden değiştirirse kalıcı kaydedilir (drone_params hariç listesine GİRMEZ) ve kayıtlı değer varsa oturum bu başlangıcı yazmaz.
FLAP_PARAMLARI = (('SERVO5_FUNCTION', 3.0), ('SERVO6_FUNCTION', 3.0), ('TKOFF_FLAP_PCNT', 50.0), ('LAND_FLAP_PERCNT', 100.0))
# GPS kalitesi: SITL u-blox arka ucu (SIM_GPS1_TYPE 1) PVT carrsoln=fixed bayrağıyla zaten RTK Fixed (fix_type 6) bildirir ve yatay konuma
# gürültü eklemez (SIM_GPS1_NOISE yalnız irtifa sinüsü). Raporlanan doğruluk (SIM_GPS1_ACC 0,3 → 0,02 m; EKF ağırlığı), uydu sayısı, hız hatası,
# aksaklık ve irtifa sürüklenmesi RTK düzeyine çekilir. Tüm tiplerde ilk kalp atışında yazılır; parametre adları ikilide doğrulandı.
GPS_RTK_PARAMLARI = (('SIM_GPS1_ACC', 0.02), ('SIM_GPS1_NUMSATS', 18.0), ('SIM_GPS1_NOISE', 0.0), ('SIM_GPS1_VERR_X', 0.0), ('SIM_GPS1_VERR_Y', 0.0),
                     ('SIM_GPS1_VERR_Z', 0.0), ('SIM_GPS1_GLTCH_X', 0.0), ('SIM_GPS1_GLTCH_Y', 0.0), ('SIM_GPS1_GLTCH_Z', 0.0), ('SIM_GPS1_DRFTALT', 0.0))
# Arazi (§18): gerçek arazi / Google 3B kiplerinde sunucu GCS gibi SITL'in TERRAIN_REQUEST'lerine sim_terrain (terrarium z13) verisiyle TERRAIN_DATA
# yanıtlar → SITL fiziği gerçek topoğrafyayı görür (önceden yalnız Mission Planner yollardı; MP yoksa düz zemin). Oturum parametreleri (kalıcı kayda girmez):
# TERRAIN_ENABLE 1 (ArduPilot varsayılanı 1; kullanıcı kapatmışsa açılır), TERRAIN_SPACING 100 m. TERRAIN_FOLLOW'a dokunulmaz (kullanıcı MP'den açabilir).
# SIM_TERRAIN_SERVE=0 → sunum kapalı (ölçüm/acil durum). Prosedürel kipte kapalı (yükseklik istemcide üretilir; sunucu bilmez).
TERRAIN_PARAMLARI = (('TERRAIN_ENABLE', 1.0), ('TERRAIN_SPACING', 100.0))
TERRAIN_SERVE = os.environ.get('SIM_TERRAIN_SERVE', '1') != '0'
TERRAIN_KIPLER = ('real', 'google3d')
TERRAIN_HATA_OLAY_S = 60.0            # sn: yükseklik kaynağı hatası uyarısı en çok bu sıklıkta
BLOK_HATA = 56                        # tüm istek başarısız (iş parçacığı hatası): 56 parça atlandı sayılır
WORLD_DEFAULTS = {'mode': 'procedural', 'seed': 12345, 'size_m': 4000, 'tree_density': 0.3, 'mountain_height': 300, 'mountain_count': 4,
                  'building_count': 40, 'runway': True, 'runway_heading': 0, 'water': 0.1, 'time': 'day', 'wind_ms': 3, 'wind_dir': 270, 'fog': 0.2,
                  'landing_circle_m': 30, 'launch': dict(LAUNCH_DEFAULTS), 'weather': 'clear', 'wind_gust': 0.0, 'wind_turb': 0.0}   # landing_circle_m: görev bitiş noktasındaki iniş dairesi çapı (§18)
_WORLD_KIP = ('procedural', 'real', 'google3d')   # real: gerçek yükseklik + uydu doku + OSM (sim_terrain vekili); google3d: Google Photorealistic 3D Tiles (§10)
# Google 3B kipi: Map Tiles API anahtarı (HTTP referrer kısıtlı; tarayıcıya /g3d-key ile verilir, sunucu Google'a istek atmaz ve önbelleklemez)
GOOGLE_KEY = os.environ.get('GOOGLE_MAPS_API_KEY', '').strip()


def google3d_etkin():
    """Google 3B dünya kipi kullanılabilir mi (GOOGLE_MAPS_API_KEY tanımlı). meta.google3d.enabled ve oturum açma denetimi."""
    return bool(GOOGLE_KEY)
# alan → (tür, alt, üst) — sayısal alanlar; 'time' ve 'runway' ayrı denetlenir
_WORLD_SINIR = {'seed': (int, 0, 2 ** 31 - 1), 'size_m': (int, 500, 20000), 'tree_density': (float, 0, 1), 'mountain_height': (float, 0, 3000),
                'mountain_count': (int, 0, 50), 'building_count': (int, 0, 500), 'runway_heading': (float, 0, 359.99), 'water': (float, 0, 1),
                'wind_ms': (float, 0, 30), 'wind_dir': (float, 0, 359.99), 'fog': (float, 0, 1), 'landing_circle_m': (float, 10, 200),
                'wind_gust': (float, 0, 20), 'wind_turb': (float, 0, 10)}
_WORLD_ZAMAN = ('day', 'dusk', 'night')
# §31 hava durumu (görsel: bulut/yağış/ıslak zemin/kar örtüsü/görüş — flightsim_weather.js WEATHER_PRESETS) ve rüzgâr (fizik: SITL SIM_WIND_*).
# wind_gust (m/s): esinti — sunucu 1 Hz'de SIM_WIND_SPD = wind_ms + wind_gust·g(t) yazar (g: esinti_carpani, JS gustFactor ile aynı formül);
# wind_turb (m/s): SITL SIM_WIND_TURB (rastgele türbülans; ArduPilot SITL fiziği) — ikisi de sahte kinematikte de etkili.
WEATHER = ('clear', 'cloudy', 'rain', 'snow', 'fog', 'storm')
ESINTI_ARALIK_S = 1.0     # sn: esinti PARAM_SET sıklığı (SITL fiziği arada sabit hız; MP de PARAM_VALUE görür — SIM_WIND_* kalıcı kayda girmez)


def esinti_carpani(t, seed=0):
    """Esinti çarpanı g(t) ∈ [0, 1] (flightsim_weather.js gustFactor ile birebir aynı): üç uyumsuz sinüs, kare (seyrek sert esinti)."""
    s = float(seed or 0) * 0.7311
    a = (0.55 * math.sin(2 * math.pi * t / 11.3 + s) + 0.3 * math.sin(2 * math.pi * t / 4.7 + 2.1 * s)
         + 0.15 * math.sin(2 * math.pi * t / 1.9 + 3.3 * s))
    g = min(1.0, max(0.0, 0.5 + 0.5 * a))
    return round(g * g, 4)


def ruzgar_vektoru(ms, gelis_deg):
    """Hava hareketi (kuzey, doğu) m/s: rüzgâr `gelis_deg`den GELİR (SIM_WIND_DIR uzlaşımı) → akış from + 180°."""
    a = math.radians(float(gelis_deg or 0))
    v = max(0.0, float(ms or 0))
    return -v * math.cos(a), -v * math.sin(a)


def ruzgar_dogrula(p, world=None):
    """`wind` komutu (§31; uçuşta rüzgâr): {ms?, dir?, gust?, turb?} — verilmeyen alan mevcut dünyadan. Hatalı → SimHata('invalid')."""
    if not isinstance(p, dict):
        raise SimHata('invalid', 'wind parametreleri nesne olmalı')
    w = world or {}
    out = {}
    for k, wk in (('ms', 'wind_ms'), ('dir', 'wind_dir'), ('gust', 'wind_gust'), ('turb', 'wind_turb')):
        v = p.get(k)
        tur, alt, ust = _WORLD_SINIR[wk]
        if v is None:
            out[wk] = float(w.get(wk, WORLD_DEFAULTS[wk]) or 0)
            continue
        if isinstance(v, bool) or not isinstance(v, (int, float)) or not (alt <= v <= ust):
            raise SimHata('invalid', f'wind.{k} {alt}…{ust} arasında olmalı')
        out[wk] = float(v)
    if not any(p.get(k) is not None for k in ('ms', 'dir', 'gust', 'turb')):
        raise SimHata('invalid', 'wind: ms / dir / gust / turb alanlarından en az biri gerekir')
    return out


def rampa_aim_dogrula(p):
    """`launch_aim` komutu (§31; rampa yön/açı, ARM öncesi): {azimuth_deg 0…359.99, angle_deg 10…30} — en az biri. Hatalı → SimHata('invalid')."""
    if not isinstance(p, dict):
        raise SimHata('invalid', 'launch_aim parametreleri nesne olmalı')
    out = {}
    for k, alt, ust in (('azimuth_deg', 0, 359.99), ('angle_deg', 10, 30)):
        v = p.get(k)
        if v is None:
            continue
        if isinstance(v, bool) or not isinstance(v, (int, float)) or not (alt <= v <= ust):
            raise SimHata('invalid', f'launch_aim.{k} {alt}…{ust} arasında olmalı')
        out[k] = round(float(v), 2)
    if not out:
        raise SimHata('invalid', 'launch_aim: azimuth_deg ya da angle_deg gerekir')
    return out


def kalkis_yonu(tip, launch, world):
    """SITL ev yönü (°; `--home lat,lon,alt,yön`): sabit kanatta kalkış yönü — rampa azimutu (launch.azimuth_deg) varsa o, yoksa pist yönü
    (tekerlekli/araç pist boyunca koşar). Diğer tiplerde 0 (eski davranış)."""
    if tip != 'sabit_kanat':
        return 0.0
    l = launch or {}
    if l.get('method') == 'ramp' and l.get('azimuth_deg') is not None:
        return float(l['azimuth_deg']) % 360.0
    return float((world or {}).get('runway_heading') or 0) % 360.0


class SimHata(Exception):
    """kod: 'invalid' (400) · 'limit' (409) · 'sitl' (503)"""
    def __init__(self, kod, mesaj):
        super().__init__(mesaj)
        self.kod = kod


AIRFRAMES = ('caymaz', 'delta')   # sabit kanat / VTOL 3B gövdesi (ön yüz modeli); varsayılan caymaz

# ---- Kontrol düzeni (§13.1; yalnız sabit_kanat): klasik aileron + elevatör (+ rudder) · elevon (delta / uçan kanat) · V-kuyruk (ruddervator) ----
# ArduPlane 4.7 SERVOn_FUNCTION kodları (libraries/SRV_Channel/SRV_Channel.h): 4 Aileron, 19 Elevator, 21 Rudder, 77 ElevonLeft, 78 ElevonRight,
# 79 VTailLeft, 80 VTailRight. Karışım (MIXING_GAIN, varsayılan 0,5 — doymaz) ArduPlane içinde (SRV_Channels::channel_function_mixer):
# elevon L = g·(e − a), R = g·(e + a); V-kuyruk L = g·(e + r), R = g·(e − r) (+ = arka kenar yukarı).
# SITL fiziği (SIM_Plane.cpp) KANAL SABİTLİDİR ve karışımı geri çözer: `-elevon` son eki kanal 1/2'yi elevon çifti (aileron = (ch2−ch1)/2,
# elevator = −(ch2+ch1)/2), `-vtail` kanal 2/4'ü ruddervator çifti (elevator = (ch4−ch2)/2, rudder = (ch4+ch2)/2) olarak okur; düz `plane`
# kanal 1 aileron / 2 elevator / 4 rudder okur. Bu yüzden düzen ↔ SITL modeli birlikte seçilir ve setler ArduPilot'un KENDİ SITL kurulumlarıdır
# (Tools/autotest/default_params/plane-elevons.parm: SERVO1 78, SERVO2 77, SERVO1/2_REVERSED 1; plane-vtail.parm: SERVO2 80, SERVO4 79,
# SERVO2_REVERSED 1) — REVERSED burada karışım işaretini SITL fiziğinin beklediği yöne çevirir (kalıcı kayıtta SERVOn_REVERSED yoksa SIM_SRV_REV
# maskesine girmez; stok davranış = autotest ile aynı). Karşılık gelmeyen kanallar nötrlenir (klasikte REVERSED 0, elevonda SERVO4 0: rudder yok).
# Oturum BAŞLANGIÇ setidir ama dron yapılandırması sayılır (FLAP_PARAMLARI gibi): dronun kalıcı kaydında olan ad yazılmaz (kalıcı öncelikli, konsola
# not); SITL model son eki ETKİN fonksiyonlardan (kalıcı kayıt ∪ düzen seti) türetilir — CAYMAZ kalıcı kaydı 4/19 ise düzen "elevon" seçilse de SITL
# düz `plane` ile açılır (eski §20.1 davranışı birebir korunur; 77/78 yalnız `-elevon` modelinde doğru uçar).
LAYOUTS = ('classic', 'elevon', 'vtail')
LAYOUT_ADLARI = {'classic': 'Aileron + Elevatör (T-kuyruk)', 'elevon': 'Elevon (delta kanat)', 'vtail': 'V-kuyruk (ruddervator)'}
LAYOUT_PARAMLARI = {
    'classic': (('SERVO1_FUNCTION', 4.0), ('SERVO2_FUNCTION', 19.0), ('SERVO4_FUNCTION', 21.0),
                ('SERVO1_REVERSED', 0.0), ('SERVO2_REVERSED', 0.0), ('SERVO4_REVERSED', 0.0)),
    'elevon': (('SERVO1_FUNCTION', 78.0), ('SERVO2_FUNCTION', 77.0), ('SERVO4_FUNCTION', 0.0),
               ('SERVO1_REVERSED', 1.0), ('SERVO2_REVERSED', 1.0), ('SERVO4_REVERSED', 0.0), ('MIXING_GAIN', 0.5)),
    'vtail': (('SERVO1_FUNCTION', 4.0), ('SERVO2_FUNCTION', 80.0), ('SERVO4_FUNCTION', 79.0),
              ('SERVO1_REVERSED', 0.0), ('SERVO2_REVERSED', 1.0), ('SERVO4_REVERSED', 0.0), ('MIXING_GAIN', 0.5)),
}
LAYOUT_SITL_EKI = {'elevon': '-elevon', 'vtail': '-vtail'}
# SITL modelinin NÖTR montajı: autotest .parm setlerinin REVERSED değerleri (fizik bu değerlerle doğru yöne uçar). Kullanıcının kalıcı kaydındaki
# gerçek REVERSED farklıysa (ör. CAYMAZ 78/77 + REVERSED 0/0) SIM_SRV_REV o kanalı yansıtır → gerçek yapılandırmayla sanal uçak düzgün uçar.
SITL_NOTR_REV = {'-elevon': (1, 2), '-vtail': (2,)}


def sitl_notr_mask(ek):
    """SITL model son eki → nötr montaj maskesi (bit n-1 = kanal n REVERSED 1 bekler)."""
    return sum(1 << (n - 1) for n in SITL_NOTR_REV.get(ek or '', ()))
ARDUPLANE_VARSAYILAN_FN = {1: 4, 2: 19, 3: 70, 4: 21}   # SERVOn_FUNCTION fabrika değerleri (kanal 1..4)
_FN_RE = re.compile(r'^SERVO([1-9]|1[0-6])_FUNCTION$')


def layout_dogrula(tip, layout, model=None):
    """Kontrol düzeni: yalnız sabit kanatta anlamlı (aksi None). Eksikse modelin düzeni (`model.layout`; dahili Caymaz/Delta → elevon,
    Talon → vtail), o da yoksa 'classic'. Bilinmeyen değer → SimHata('invalid')."""
    if tip != 'sabit_kanat':
        return None
    if layout is None or layout == '':
        m = (model or {}).get('layout') if isinstance(model, dict) else None
        return m if m in LAYOUTS else 'classic'
    if not isinstance(layout, str) or layout not in LAYOUTS:
        raise SimHata('invalid', 'layout classic | elevon | vtail olmalı')
    return layout


def layout_parametreleri(layout, kayitli_adlar=()):
    """Düzen başlangıç seti → (yazılacak (ad, değer) listesi, kalıcı kayıt yüzünden atlanan adlar). Kayıtlı ad kullanıcı yapılandırmasıdır, ezilmez."""
    kayitli = set(kayitli_adlar or ())
    sett = LAYOUT_PARAMLARI.get(layout or 'classic', LAYOUT_PARAMLARI['classic'])
    return [(a, v) for a, v in sett if a not in kayitli], [a for a, _ in sett if a in kayitli]


def layout_etkin_fn(layout, kayitli_rows=()):
    """SITL'de etkin olacak SERVOn_FUNCTION'lar (kanal → kod): ArduPlane varsayılanı ← düzen seti ← kalıcı kayıt (öncelikli)."""
    fn = dict(ARDUPLANE_VARSAYILAN_FN)
    for a, v in LAYOUT_PARAMLARI.get(layout or 'classic', ()):
        m = _FN_RE.match(a)
        if m:
            fn[int(m.group(1))] = int(round(float(v)))
    for r in kayitli_rows or ():
        m = _FN_RE.match(str(r.get('name') or ''))
        if m:
            try:
                fn[int(m.group(1))] = int(round(float(r.get('value'))))
            except (TypeError, ValueError):
                pass
    return fn


def sitl_model_eki(fn):
    """Etkin fonksiyonlardan SITL `plane` son eki: kanal 1/2 elevon çifti (77/78) → '-elevon'; kanal 2/4 V-kuyruk çifti (79/80) → '-vtail';
    aksi '' (düz plane: 1 aileron / 2 elevator / 4 rudder). SIM_Plane kanal sabitlidir: çift başka kanaldaysa fizik onu göremez → düz."""
    f1, f2, f4 = fn.get(1), fn.get(2), fn.get(4)
    if {f1, f2} == {77, 78}:
        return '-elevon'
    if {f2, f4} == {79, 80}:
        return '-vtail'
    return ''


def layout_etkin(fn):
    """Etkin fonksiyonlardan fiilen uçan düzen adı (konsol notu / kayıt): elevon | vtail | classic."""
    ek = sitl_model_eki(fn)
    return 'elevon' if ek == '-elevon' else 'vtail' if ek == '-vtail' else 'classic'


def drive_dogrula(tip, drive, model=None):
    """§31 sürüş biçimi: yalnız kara aracında anlamlı (aksi None). Eksikse modelin `drive`'ı, o da yoksa 'ackermann'. Bilinmeyen → SimHata('invalid')."""
    if tip not in ROVER_TIPLERI:
        return None
    if drive is None or drive == '':
        m = (model or {}).get('drive') if isinstance(model, dict) else None
        return m if m in DRIVES else 'ackermann'
    if not isinstance(drive, str) or drive not in DRIVES:
        raise SimHata('invalid', 'drive ackermann | skid olmalı')
    return drive


def airframe_dogrula(tip, a):
    """Gövde seçimi yalnız uçak tiplerinde anlamlı: eksikse 'caymaz'; bilinmeyen değer SimHata('invalid'). Kopterlerde None."""
    if tip not in ('sabit_kanat', 'vtol'):
        return None
    if a is None or a == '':
        return 'caymaz'
    if not isinstance(a, str) or a not in AIRFRAMES:
        raise SimHata('invalid', 'airframe caymaz | delta olmalı')
    return a


def _model_eski(tip, airframe):
    """`model` verilmeden açılan oturum (eski istemci / doğrudan MANAGER.ac): dahili modelin özet nesnesi (DB'siz; §12 kütüphanesinde her zaman var)."""
    if tip in DIKEY_TIPLER or tip in ROVER_TIPLERI:   # §25 INTERCEPTOR / §31 kara aracı dahili GLB'si (yönelimli; buildLibrary)
        from . import flightsim_models
        return flightsim_models.builtin_api('icept_x4' if tip in DIKEY_TIPLER else 'rover_4x4', tip)
    key = {'multirotor': 'quad', 'hexarotor': 'hexa', 'helikopter': 'heli'}.get(tip) or (airframe if airframe in AIRFRAMES else 'caymaz')
    return {'id': f'builtin:{key}', 'source': 'builtin', 'type': tip, 'orient': None, 'has_prop': True, 'glb_url': None, 'ready': True}


def _airframe_adi(model, tip):
    if not model or tip not in PLANE_TIPLERI:
        return None
    return {'builtin:caymaz': 'caymaz', 'builtin:delta': 'delta'}.get(model.get('id'))


def launch_dogrula(l):
    """`world.launch` (§13): {method: wheels|ramp|vehicle, angle_deg 10…30, release_kmh 40…110}; eksikler varsayılan. Hatalıysa SimHata('invalid')."""
    if l is None:
        return dict(LAUNCH_DEFAULTS)
    if not isinstance(l, dict):
        raise SimHata('invalid', 'world.launch bir nesne olmalı')
    out = dict(LAUNCH_DEFAULTS)
    if l.get('method') is not None:
        if l['method'] not in LAUNCH_METHODS:
            raise SimHata('invalid', f"world.launch.method {' | '.join(LAUNCH_METHODS)} olmalı")
        out['method'] = l['method']
    for k, alt, ust in (('angle_deg', 10, 30), ('release_kmh', 40, 110), ('azimuth_deg', 0, 359.99)):   # azimuth_deg (§31): rampa yönü; yoksa pist yönü
        v = l.get(k)
        if v is None:
            continue
        if isinstance(v, bool) or not isinstance(v, (int, float)) or not (alt <= v <= ust):
            raise SimHata('invalid', f'world.launch.{k} {alt}…{ust} arasında olmalı')
        out[k] = float(v)
    try:   # §27 fırlatıcı alanları (loaded, aim_az_deg, aim_el_deg): verilmişse sınır denetimi; fırlatıcı yönteminde varsayılanla dolar
        out.update(flightsim_launcher.ek_alanlar(l, out['method']))
    except flightsim_launcher.LauncherHata as e:
        raise SimHata('invalid', str(e))
    return out


def launch_normalize(tip, launch):
    """Yöntem tipe göre: sabit kanat wheels | ramp | vehicle; INTERCEPTOR §27 fırlatıcıları (pod4 | pod8 | tube | handheld; yoksa 'wheels' = pad,
    düzeneksiz — eski gövdeler); diğer tipler dikey kalkar → 'wheels' (etkisiz). Fırlatıcı olmayan yöntemde fırlatıcı alanları atılır."""
    l = dict(launch or LAUNCH_DEFAULTS)
    m = l.get('method')
    if tip == 'sabit_kanat':
        ok = m in SABIT_KANAT_LAUNCH
    elif tip in DIKEY_TIPLER:
        ok = flightsim_launcher.firlatici_mi(m)
    else:
        ok = False
    if not ok:
        l['method'] = 'wheels'
    if not flightsim_launcher.firlatici_mi(l['method']):
        for k in ('loaded', 'aim_az_deg', 'aim_el_deg'):
            l.pop(k, None)
    return l


def launch_parametreleri(launch, alt=None):
    """Kalkış yöntemine göre ArduPlane parametreleri (ad, değer) — ilk kalp atışında ve `cmd takeoff`ta yazılır.
    wheels: ivme tetiği kapalı, pist koşusu; döndürme hızı 12 m/s. ramp: TKOFF_THR_MINACC (fırlatma ivmesi algılanınca gaz), 2 sn gecikme,
    seviye pitch'i fırlatma açısı; döndürme/asgari hız yok. vehicle: döndürme hızı = bırakma hızı (uçak o hıza dek yerde/araçta kalır; gaz baştan açık).
    Her yöntemde PLANE_YER_PARAMLARI (SERVO3_MIN/TRIM 1000): disarm'da itki 0 → uçak/düzenek yerde kaymaz."""
    m = (launch or {}).get('method', 'wheels')
    out = list(PLANE_YER_PARAMLARI)
    if alt is not None:
        out.append(('TKOFF_ALT', float(alt)))
    if m == 'ramp':
        out += [('TKOFF_THR_MINACC', RAMP_ACCEL), ('TKOFF_THR_DELAY', 2.0), ('TKOFF_THR_MINSPD', 0.0), ('TKOFF_ROTATE_SPD', 0.0),
                ('TKOFF_LVL_PITCH', float(max(10.0, min(30.0, (launch or {}).get('angle_deg', 15))))), (f'SERVO{LAUNCH_SERVO}_FUNCTION', 0.0)]
    elif m == 'vehicle':
        ms = float((launch or {}).get('release_kmh', 70)) / 3.6
        out += [('TKOFF_THR_MINACC', 0.0), ('TKOFF_THR_MINSPD', 0.0), ('TKOFF_ROTATE_SPD', round(ms, 2)), ('TKOFF_LVL_PITCH', 15.0)]
    else:
        out += [('TKOFF_THR_MINACC', 0.0), ('TKOFF_THR_MINSPD', 0.0), ('TKOFF_ROTATE_SPD', 12.0), ('TKOFF_LVL_PITCH', 15.0)]
    return out


def world_dogrula(w):
    """Ön yüzün ürettiği dünya tanımını doğrular; eksik alanlar varsayılanla dolar. Hatalıysa SimHata('invalid')."""
    if w is None:
        w = {}
    if not isinstance(w, dict):
        raise SimHata('invalid', 'world bir nesne olmalı')
    out = dict(WORLD_DEFAULTS)
    out['launch'] = launch_dogrula(w.get('launch'))
    for k, (tur, alt, ust) in _WORLD_SINIR.items():
        if k not in w or w[k] is None:
            continue
        v = w[k]
        if isinstance(v, bool) or not isinstance(v, (int, float)):
            raise SimHata('invalid', f'world.{k} sayı olmalı')
        if not (alt <= v <= ust):
            raise SimHata('invalid', f'world.{k} {alt}…{ust} arasında olmalı')
        out[k] = tur(v)
    if 'runway' in w and w['runway'] is not None:
        if not isinstance(w['runway'], bool):
            raise SimHata('invalid', 'world.runway doğru/yanlış olmalı')
        out['runway'] = w['runway']
    if 'time' in w and w['time'] is not None:
        if w['time'] not in _WORLD_ZAMAN:
            raise SimHata('invalid', 'world.time day | dusk | night olmalı')
        out['time'] = w['time']
    if 'weather' in w and w['weather'] is not None:   # §31
        if w['weather'] not in WEATHER:
            raise SimHata('invalid', f"world.weather {' | '.join(WEATHER)} olmalı")
        out['weather'] = w['weather']
    if 'mode' in w and w['mode'] is not None:
        if w['mode'] not in _WORLD_KIP:
            raise SimHata('invalid', 'world.mode procedural | real | google3d olmalı')
        out['mode'] = w['mode']
    if out['mode'] == 'google3d' and not google3d_etkin():
        raise SimHata('invalid', 'Google 3B kipi sunucuda yapılandırılmamış (GOOGLE_MAPS_API_KEY)')
    return out


def tipler():
    """GET /meta types: SITL tipleri + ikili var mı (sahte kipte her zaman var sayılır)."""
    return [{'key': k, 'name': TIP_ADLARI.get(k, k), 'binary': (not SITL_ENABLED) or drone_sitl.ikili_yolu(k).is_file()}
            for k in drone_sitl.TIP_ESLEME]


def _dialect():
    from pymavlink.dialects.v20 import ardupilotmega as d
    return d


def _mod_adi(vtype, num):
    try:
        from pymavlink import mavutil
        return (mavutil.mode_mapping_bynumber(vtype) or {}).get(num) or str(num)
    except Exception:   # noqa: BLE001
        return str(num)


def _modlar(vtype):
    from pymavlink import mavutil
    return mavutil.mode_mapping_byname(vtype) or {}


def _varsayilan_vtype(tip):
    return 1 if tip in PLANE_TIPLERI else MAV_TYPE_GROUND_ROVER if tip in ROVER_TIPLERI else 2


def _rc_dogrula(ch):
    if not isinstance(ch, (list, tuple)) or len(ch) != 8:
        raise SimHata('invalid', 'rc.ch 8 kanal olmalı')
    out = []
    for v in ch:
        if isinstance(v, bool) or not isinstance(v, (int, float)):
            raise SimHata('invalid', 'rc kanal değeri sayı olmalı')
        v = int(v)
        if v != 0 and not (1000 <= v <= 2000):
            raise SimHata('invalid', 'rc kanal değeri 1000–2000 (0 = yoksay) olmalı')
        out.append(v)
    return out


def _kuyruga(q, txt, onemli=False):
    """İzleyici kuyruğu kalıbı (drone_hub.Viewer.put): dolunca en eskisi atılır — eski telemetri değersiz. `onemli` (tele dışı: route, crash,
    event, state…) çerçeve dolu kuyrukta en eski TELE çerçevesinin yerini alır; yavaş izleyicide tekil olaylar düşmez (§18)."""
    try:
        q.put_nowait(txt)
    except asyncio.QueueFull:
        try:
            if onemli:
                dq = q._queue   # asyncio.Queue iç deque'i: en eski tele'yi çıkar (yoksa en eskisi)
                for i, eski in enumerate(dq):
                    if '"t": "tele"' in eski[:16]:
                        del dq[i]
                        break
                else:
                    q.get_nowait()
            else:
                q.get_nowait()
        except (asyncio.QueueEmpty, AttributeError, IndexError):
            pass
        try:
            q.put_nowait(txt)
        except asyncio.QueueFull:
            pass


# ======================================================================
# Sahte kinematik (HEPGO_SITL=0): merkez etrafında daire; komutlara mantıklı tepki
# ======================================================================
class SahteKinematik:
    YARICAP = 150.0      # m
    HIZ = 12.0           # m/s
    TIRMANMA = 3.0       # m/s

    # §31 kara aracı sahte sürüşü (SIM_Rover sabitleri: Ackermann azami 20 m/s, 35° teker, 1,8 m dönüş çapı; skid 4 m/s, 140°/sn)
    ROVER_VMAX = {'ackermann': 20.0, 'skid': 4.0}
    ROVER_IVME = {'ackermann': 10.0, 'skid': 14.0}
    ROVER_SEYIR = 5.0
    ROVER_TEKER = math.radians(35.0)
    ROVER_DONUS_CAPI = 1.8
    ROVER_SKID_DONUS = math.radians(140.0)

    def __init__(self, tip, lat, lon, alt, ruzgar_ms, launch=None, heading=0, ruzgar_yon=0, esinti=0, turb=0, drive=None):
        self.tip = tip
        self.rover = tip in ROVER_TIPLERI
        self.drive = drive if drive in DRIVES else 'ackermann'
        self.plane = tip in PLANE_TIPLERI
        self.dikey = tip in DIKEY_TIPLER   # §25 INTERCEPTOR: dikey kalkış (pist koşusu yok), havada yatay uçuş; gövde yönelimi `att_body`
        self.lat0, self.lon0, self.alt0 = float(lat), float(lon), float(alt or 0)
        self.ruzgar_ayarla(ruzgar_ms, ruzgar_yon, esinti, turb)
        self.launch = dict(launch or LAUNCH_DEFAULTS)   # sabit kanat kalkış yöntemi (§13): yer koşusu / rampa / araç taklidi
        self.heading = math.radians(float(heading or 0))   # pist yönü (kalkış koşusu bu yönde)
        self.speedup = 1.0   # §23 simülasyon hızı: adım dt × speedup (SITL SIM_SPEEDUP karşılığı; sure_ms de hızlı akar)
        self.sifirla()

    def sifirla(self):
        self.lat, self.lon, self.alt_rel = self.lat0, self.lon0, 0.0
        self.home = {'lat': self.lat0, 'lon': self.lon0, 'alt': self.alt0}
        self.armed = False
        self.mode = 'MANUAL' if (self.plane or self.rover) else 'STABILIZE'
        self.hedef_alt = 0.0
        self.aci = 0.0
        self.hiz = 0.0                              # §31 kara aracı: ileri hız (m/s; geri vites −)
        self.direksiyon = 0.0                       # §31 −1…1 (sağ +); servo çıkışı ve 3B teker açısı
        self.kalkis = None   # sabit kanat kalkış aşaması: {'faz': 'run'|'air', 'hiz', 'yol', 'tetik'}
        self.nisan = None    # §27 el fırlatıcısı: (az, el) derece → dikey yerine nişan ışını boyunca tırmanış
        self.roll = self.pitch = self.yaw = 0.0
        self.rs = self.ps = self.ys = 0.0          # açısal hızlar (rad/s; ATTITUDE rollspeed/pitchspeed/yawspeed karşılığı)
        self.vn = self.ve = self.vd = 0.0
        self.rc = list(self.RC_VARSAYILAN_ROVER if self.rover else self.RC_VARSAYILAN)
        self.throttle = 0.0
        self.batt_v = 12.6
        self.eve = False
        self.motor_cut = False                      # motor kesildi (uçak): itki yok → süzülme; ARM korunur
        self._daireye_don = False                   # süzülmeden sonra motor geri verildi: daireye ışınlanmadan yaklaş
        self.sure_ms = 0.0                          # time_boot_ms karşılığı

    RC_VARSAYILAN = (1500, 1500, 1000, 1500, 1500, 1500, 1500, 1500)
    RC_VARSAYILAN_ROVER = (1500, 1500, 1500, 1500, 1500, 1500, 1500, 1500)   # ArduRover: gaz ortası = dur (ileri/geri çift yönlü)

    def ruzgar_ayarla(self, ms, yon=None, esinti=None, turb=None):
        """§31 rüzgâr (SITL SIM_WIND_SPD/DIR/TURB + sunucu esintisi karşılığı): taban hız, geldiği yön (°), esinti genliği, türbülans (m/s)."""
        self.ruzgar = float(ms or 0)
        if yon is not None:
            self.ruzgar_yon = float(yon or 0)
        if esinti is not None:
            self.ruzgar_esinti = float(esinti or 0)
        if turb is not None:
            self.ruzgar_turb = float(turb or 0)
        for k in ('ruzgar_yon', 'ruzgar_esinti', 'ruzgar_turb'):
            if not hasattr(self, k):
                setattr(self, k, 0.0)

    def ruzgar_simdi(self):
        """Anlık rüzgâr hızı (m/s): taban + esinti·g(t) (t = oturum saati; SITL esintisiyle aynı formül)."""
        return self.ruzgar + self.ruzgar_esinti * esinti_carpani(getattr(self, 'sure_ms', 0.0) / 1000.0)

    def ruzgar_kd(self):
        """Anlık hava hareketi (kuzey, doğu) m/s — türbülans: küçük yumuşak salınım (rastgele değil; testler deterministik)."""
        wn, we = ruzgar_vektoru(self.ruzgar_simdi(), self.ruzgar_yon)
        if self.ruzgar_turb > 0:
            t = getattr(self, 'sure_ms', 0.0) / 1000.0
            wn += self.ruzgar_turb * 0.5 * math.sin(t * 2.3 + 0.4)
            we += self.ruzgar_turb * 0.5 * math.sin(t * 1.7 + 1.9)
        return wn, we

    def komut(self, name, p):
        p = p or {}
        if name == 'arm':
            self._motor_ver()
            self.armed = True
        elif name == 'motor_cut':
            if p.get('on'):
                self.motor_cut = True
                self.kalkis = None   # pist koşusu / fırlatma itkisi de biter
            else:
                self._motor_ver()
        elif name == 'disarm':
            self.armed = False
            self.kalkis = None
            if self.alt_rel < 0.5:
                self.alt_rel, self.hedef_alt = 0.0, 0.0
        elif name == 'mode':
            self.mode = str(p.get('mode') or '').upper() or self.mode
            self.eve = self.mode in ('RTL', 'QRTL', 'SMART_RTL')
        elif name == 'takeoff':
            self._motor_ver()
            self.armed = True
            self.mode = 'TAKEOFF' if self.plane and not self.dikey else 'GUIDED'
            self.hedef_alt = max(1.0, float(p.get('alt') or (50 if self.plane else 10)))
            self.nisan = tuple(p['aim']) if self.dikey and p.get('aim') else None
            self.eve = False
            if self.plane and not self.dikey and self.alt_rel < 1.0:
                self.kalkis = {'faz': 'run', 'hiz': 0.0, 'yol': 0.0, 'tetik': self.launch.get('method') != 'ramp'}   # rampa: fırlatma tetiğini bekler
        elif name == 'rtl':
            self.mode = 'RTL'
            self.eve = True
        elif name in ('reset', 'crash'):
            self.sifirla()
        elif name == 'set_home':
            if p.get('lat') is not None and p.get('lon') is not None:
                self.home = {'lat': float(p['lat']), 'lon': float(p['lon']), 'alt': float(p.get('alt') or self.alt0)}
            else:
                self.home = {'lat': self.lat, 'lon': self.lon, 'alt': self.alt0 + self.alt_rel}
        elif name == 'rc':
            ch = list(p['ch'])
            if not any(ch):                        # 8×0 = override serbest: kanallar varsayılana döner
                self.rc = list(self.RC_VARSAYILAN_ROVER if self.rover else self.RC_VARSAYILAN)
                return
            self.rc = [v if v else eski for v, eski in zip(ch, self.rc)]   # 0 = o kanalı değiştirme
            if ch[2] and not self.rover:
                self.throttle = max(0.0, min(100.0, (self.rc[2] - 1000) / 10.0))

    def _motor_ver(self):
        """Motor kesmesi kalkar; havadaysa daireye (ışınlanmadan) yaklaşarak döner."""
        if self.motor_cut and self.alt_rel > 1.0:
            self._daireye_don = True
        self.motor_cut = False

    def havada(self):
        return self.alt_rel > 0.0   # süzülme yere (0) değene dek sürer

    def adim(self, dt):
        dt = dt * float(self.speedup or 1.0)
        self.sure_ms += dt * 1000.0
        r0, p0, y0 = self.roll, self.pitch, self.yaw
        self._adim(dt)
        if dt > 0:   # açısal hızlar: ardışık açılardan (yaw sarmalı)
            dy = (self.yaw - y0 + math.pi) % (2 * math.pi) - math.pi
            self.rs, self.ps, self.ys = (self.roll - r0) / dt, (self.pitch - p0) / dt, dy / dt

    def _suzul(self, dt):
        """Motorsuz süzülme (uçak; motor_cut ya da havada disarm — ArduPlane disarm'lıyken de yüzeyleri stabilize eder): itki 0, hava hızı
        SAHTE_SUZULME_HIZ'a yaklaşır, batış = hız / SAHTE_SUZULME_ORANI; RC 1 (aileron) yatış açısı → koordineli dönüş (ψ̇ = g·tanφ / V).
        Yere değince durur (yerde kalır; ARM durumu değişmez)."""
        self.throttle = 0.0
        hs = math.hypot(self.vn, self.ve)
        v = hs + (SAHTE_SUZULME_HIZ - hs) * min(1.0, dt / 3.0) if hs > 0.5 else SAHTE_SUZULME_HIZ
        ail = self.rc[0] if self.rc and self.rc[0] else 1500
        hedef_roll = max(-1.0, min(1.0, (ail - 1500) / 500.0)) * SAHTE_ROLL_AZAMI
        adim_r = math.radians(90) * dt
        self.roll += max(-adim_r, min(adim_r, hedef_roll - self.roll))
        self.yaw = (self.yaw + 9.81 * math.tan(self.roll) / max(v, 1.0) * dt + math.pi) % (2 * math.pi) - math.pi
        batis = v / SAHTE_SUZULME_ORANI
        self.pitch = -math.atan2(batis, v)
        wn, we = self.ruzgar_kd()   # §31: hava kütlesiyle sürüklenir (yer hızı = hava hızı + rüzgâr)
        self.vn, self.ve, self.vd = v * math.cos(self.yaw) + wn, v * math.sin(self.yaw) + we, batis
        cos_lat = math.cos(math.radians(self.lat0))
        self.lat += self.vn * dt / 110574.0
        self.lon += self.ve * dt / (111320.0 * cos_lat)
        self.alt_rel = max(0.0, self.alt_rel - batis * dt)
        if self.alt_rel <= 0.0:   # yere indi (süzülerek): durur
            self.vn = self.ve = self.vd = 0.0
            self.roll = self.pitch = 0.0
            self.hedef_alt = 0.0

    def _surus(self, dt):
        """§31 kara aracı: yerde (alt_rel 0) sürüş. MANUAL/ACRO/STEERING: RC1 direksiyon, RC3 gaz (1500 dur, çift yönlü); HOLD durur;
        RTL/SMART_RTL eve sürer ve HOLD'a geçer; diğer otomatik kipler (AUTO/GUIDED/LOITER/FOLLOW/SIMPLE) merkez çevresinde seyir hızıyla tur."""
        vmax, ivme = self.ROVER_VMAX[self.drive], self.ROVER_IVME[self.drive]
        cos_lat = math.cos(math.radians(self.lat0))
        hedef_v, hedef_s = 0.0, 0.0
        if self.armed and not self.eve and self.mode in ('MANUAL', 'ACRO', 'STEERING'):
            hedef_v = max(-1.0, min(1.0, ((self.rc[2] or 1500) - 1500) / 500.0)) * vmax
            hedef_s = max(-1.0, min(1.0, ((self.rc[0] or 1500) - 1500) / 500.0))
        elif self.armed and self.eve:
            dn = (self.home['lat'] - self.lat) * 110574.0
            de = (self.home['lon'] - self.lon) * 111320.0 * cos_lat
            mesafe = math.hypot(dn, de)
            if mesafe > 2.0:
                hedef_v = min(self.ROVER_SEYIR, vmax, mesafe)
                hata = (math.atan2(de, dn) - self.yaw + math.pi) % (2 * math.pi) - math.pi
                hedef_s = max(-1.0, min(1.0, hata * 1.5))
            else:
                self.eve, self.mode = False, 'HOLD'
        elif self.armed and self.mode not in ('HOLD', 'MANUAL', 'ACRO', 'STEERING', 'INITIALISING'):
            dn, de = (self.lat - self.lat0) * 110574.0, (self.lon - self.lon0) * 111320.0 * cos_lat
            r = math.hypot(dn, de)
            teget = math.atan2(de, dn) + math.pi / 2 if r > 1.0 else self.yaw   # saat yönünde tur + yarıçapa çekim
            hedef_yon = teget - max(-0.6, min(0.6, (r - self.YARICAP) / self.YARICAP))
            hata = (hedef_yon - self.yaw + math.pi) % (2 * math.pi) - math.pi
            hedef_v, hedef_s = min(self.ROVER_SEYIR, vmax), max(-1.0, min(1.0, hata * 1.5))
        adim_v = ivme * dt
        self.hiz += max(-adim_v, min(adim_v, hedef_v - self.hiz))
        self.direksiyon += max(-3.0 * dt, min(3.0 * dt, hedef_s - self.direksiyon))
        if self.drive == 'skid':
            yr = self.direksiyon * self.ROVER_SKID_DONUS * (1.0 if abs(self.hiz) > 0.05 or self.armed else 0.0)
        elif abs(self.direksiyon) > 1e-3:
            R = self.ROVER_DONUS_CAPI * math.sin(self.ROVER_TEKER) / math.sin(abs(self.direksiyon) * self.ROVER_TEKER)
            yr = math.copysign(self.hiz / R, self.direksiyon)
        else:
            yr = 0.0
        if not self.armed:
            yr = 0.0
        self.yaw = (self.yaw + yr * dt + math.pi) % (2 * math.pi) - math.pi
        self.vn, self.ve, self.vd = self.hiz * math.cos(self.yaw), self.hiz * math.sin(self.yaw), 0.0
        self.lat += self.vn * dt / 110574.0
        self.lon += self.ve * dt / (111320.0 * cos_lat)
        self.alt_rel = 0.0
        self.roll = self.pitch = 0.0
        self.throttle = round(abs(self.hiz) / vmax * 100.0, 1) if self.armed else 0.0
        if self.armed:
            self.batt_v = max(10.5, self.batt_v - 0.0004 * dt)

    def servo(self):
        """§31 kara aracı servo çıkışı (ArduRover SERVO_OUTPUT_RAW taklidi): Ackermann SERVO1 direksiyon / SERVO3 gaz; skid SERVO1 sol / SERVO3 sağ."""
        g = max(-1.0, min(1.0, self.hiz / self.ROVER_VMAX[self.drive]))
        if self.drive == 'skid':
            sol, sag = max(-1.0, min(1.0, g + self.direksiyon)), max(-1.0, min(1.0, g - self.direksiyon))
            a, b = sol, sag
        else:
            a, b = self.direksiyon, g
        return [int(1500 + 500 * a), 1500, int(1500 + 500 * b), 1500, 0, 0, 0, 0]

    def _adim(self, dt):
        if self.rover:
            self._surus(dt)
            return
        if self.plane and (self.motor_cut or not self.armed) and self.havada():
            self.kalkis = None
            if not self.armed:
                self.eve = False
            self._suzul(dt)
            return
        if self.motor_cut:   # yerde, motor kesik: kıpırdamaz (ARM'lı kalabilir)
            self.vn = self.ve = self.vd = 0.0
            self.roll = self.pitch = 0.0
            self.throttle = 0.0
            self.kalkis = None
            return
        if not self.armed:
            self.vn = self.ve = self.vd = 0.0
            self.roll = self.pitch = 0.0
            self.throttle = 0.0
            return
        self.batt_v = max(10.5, self.batt_v - 0.0004 * dt)
        if self.eve:   # eve dön: önce eve yaklaş, sonra alçal; yerde kendiliğinden disarm
            dn = (self.home['lat'] - self.lat) * 110574.0
            de = (self.home['lon'] - self.lon) * 111320.0 * math.cos(math.radians(self.lat0))
            mesafe = math.hypot(dn, de)
            if mesafe > 2.0:
                adim = min(mesafe, self.HIZ * dt)
                self.lat += dn / mesafe * adim / 110574.0
                self.lon += de / mesafe * adim / (111320.0 * math.cos(math.radians(self.lat0)))
                self.vn, self.ve = dn / mesafe * self.HIZ, de / mesafe * self.HIZ
                self.yaw = math.atan2(de, dn)
            else:
                self.vn = self.ve = 0.0
                self.alt_rel = max(0.0, self.alt_rel - self.TIRMANMA * dt)
                self.vd = self.TIRMANMA if self.alt_rel > 0 else 0.0
                if self.alt_rel <= 0.0:
                    self.armed, self.eve = False, False
                    self.mode = 'MANUAL' if self.plane else 'STABILIZE'
            self.throttle = 50.0
            return
        if self.kalkis is not None:   # sabit kanat kalkış koşusu (pist yönünde düz): yöntem taklidi
            k, m = self.kalkis, self.launch.get('method', 'wheels')
            wn, we = self.ruzgar_kd()
            bas = -(wn * math.cos(self.heading) + we * math.sin(self.heading))   # §31 baş rüzgârı bileşeni (m/s; < 0 kuyruk)
            if k['faz'] == 'run':
                if m == 'ramp':
                    if k['tetik']:
                        k['hiz'] = min(22.0, k['hiz'] + 44.0 * dt)   # kızak 0,5 sn'de ~22 m/s
                        if k['hiz'] >= 21.9:
                            k['faz'] = 'air'
                    self.throttle = 100.0 if k['tetik'] else 0.0
                elif m == 'vehicle':
                    hedef = float(self.launch.get('release_kmh', 70)) / 3.6
                    k['hiz'] = min(hedef, k['hiz'] + 2.5 * dt)     # araç ivmesi
                    self.throttle = 0.0
                    if k['hiz'] >= hedef - 0.01:
                        k['faz'] = 'air'
                else:
                    donus = 12.0 - min(4.0, max(0.0, bas))           # tekerlekli: 12 m/s HAVA hızında döner — baş rüzgârı yer koşusunu kısaltır (§31)
                    k['hiz'] = min(donus, k['hiz'] + 4.0 * dt)
                    self.throttle = 100.0
                    if k['hiz'] >= donus - 0.01:
                        k['faz'] = 'air'
            else:
                self.throttle = 85.0
                self.alt_rel = min(self.hedef_alt, self.alt_rel + self.TIRMANMA * dt)
                self.vd = -self.TIRMANMA
                self.pitch = 0.2
            self.yaw = self.heading
            # §31: koşu (run) yer hızıyla; havada (air) yer hızı = hava hızı − baş rüzgârı (tırmanırken rüzgârla sürüklenir)
            yer = k['hiz'] if k['faz'] == 'run' else max(2.0, k['hiz'] - bas)
            self.vn, self.ve = yer * math.cos(self.heading), yer * math.sin(self.heading)
            k['yol'] += yer * dt
            cos_lat = math.cos(math.radians(self.lat0))
            self.lat = self.lat0 + k['yol'] * math.cos(self.heading) / 110574.0
            self.lon = self.lon0 + k['yol'] * math.sin(self.heading) / (111320.0 * cos_lat)
            if self.alt_rel > 1.0:   # havalandı: daireye geç (konumdan açı)
                dn, de = (self.lat - self.lat0) * 110574.0, (self.lon - self.lon0) * 111320.0 * cos_lat
                self.aci = math.atan2(de, dn)
                self.kalkis = None
            return
        if self.alt_rel < self.hedef_alt:   # tırmanış
            self.alt_rel = min(self.hedef_alt, self.alt_rel + self.TIRMANMA * dt)
            self.vd = -self.TIRMANMA
            self.throttle = 75.0
        else:
            self.vd = 0.0
            self.throttle = 50.0
        if self.dikey and self.alt_rel < self.hedef_alt - 0.01:   # §25 dikey tırmanış (yerinde; gövde burun yukarı)
            if self.nisan:   # §27 el fırlatıcısı: nişan ışını boyunca (yatay hız = tırmanma / tan(el), ≤ 2×seyir)
                az, el = math.radians(self.nisan[0]), math.radians(self.nisan[1])
                vh = min(self.HIZ * 2, self.TIRMANMA / max(0.05, math.tan(el)))
                self.vn, self.ve = vh * math.cos(az), vh * math.sin(az)
                self.lat += self.vn * dt / 110574.0
                self.lon += self.ve * dt / (111320.0 * math.cos(math.radians(self.lat0)))
                self.yaw = az
                self.aci = az   # tırmanış bitince daire bu kerterizden sürer
                return
            self.vn = self.ve = 0.0
            return
        if self.alt_rel > 1.0 and self._daireye_don:   # süzülmeden sonra motor geri geldi: dairenin en yakın noktasına uç (ışınlanma yok)
            cos_lat = math.cos(math.radians(self.lat0))
            dn, de = (self.lat - self.lat0) * 110574.0, (self.lon - self.lon0) * 111320.0 * cos_lat
            r = math.hypot(dn, de)
            ux, uy = (dn / r, de / r) if r > 1e-6 else (1.0, 0.0)
            hn, he = ux * self.YARICAP - dn, uy * self.YARICAP - de
            kalan = math.hypot(hn, he)
            if kalan <= self.HIZ * dt:   # daire noktasına otur (adım ≤ HIZ·dt), sonraki adımdan daire
                self.aci = math.atan2(uy, ux)
                self._daireye_don = False
                self.lat = self.lat0 + ux * self.YARICAP / 110574.0
                self.lon = self.lon0 + uy * self.YARICAP / (111320.0 * cos_lat)
                return
            else:
                self.vn, self.ve = hn / kalan * self.HIZ, he / kalan * self.HIZ
                self.lat += self.vn * dt / 110574.0
                self.lon += self.ve * dt / (111320.0 * cos_lat)
                self.yaw = math.atan2(self.ve, self.vn)
                self.roll, self.pitch = 0.0, 0.05
                return
        if self.alt_rel > 1.0:   # merkez etrafında daire (saat yönü). §31 rüzgâr: yer izi daire kalır (ArduPilot loiter rüzgârı telafi eder),
            # yer hızı = hava hızı + rüzgârın iz boyunca bileşeni (rüzgâr altında hızlı, rüzgâr üstünde yavaş); burun hava hızı yönünde (yengeç açısı);
            # kopter rüzgâra doğru yatar.
            tn, te = -math.sin(self.aci), math.cos(self.aci)
            wn, we = self.ruzgar_kd()
            boy = wn * tn + we * te                                   # rüzgârın iz boyunca bileşeni; yanal bileşen yengeç açısıyla karşılanır
            vg = max(2.0, boy + math.sqrt(max(1.0, self.HIZ ** 2 - (wn * wn + we * we - boy * boy))))   # hava hızı = HIZ sabit
            self.aci += vg / self.YARICAP * dt
            cos_lat = math.cos(math.radians(self.lat0))
            self.lat = self.lat0 + self.YARICAP * math.cos(self.aci) / 110574.0
            self.lon = self.lon0 + self.YARICAP * math.sin(self.aci) / (111320.0 * cos_lat)
            self.vn, self.ve = vg * -math.sin(self.aci), vg * math.cos(self.aci)
            an, ae = self.vn - wn, self.ve - we   # hava hızı vektörü
            self.yaw = math.atan2(ae, an)
            self.roll = math.atan((vg ** 2) / (self.YARICAP * 9.81)) if self.plane else 0.12
            self.pitch = 0.05 if self.plane else -0.05
            if not self.plane and (wn or we):   # kopter: rüzgâra karşı eğim (gövde çerçevesinde; ~1° / m/s, ≤ 25°)
                cy, sy = math.cos(self.yaw), math.sin(self.yaw)
                ileri, sag = wn * cy + we * sy, -wn * sy + we * cy   # hava hareketinin gövde bileşenleri
                self.pitch += max(-0.44, min(0.44, ileri * 0.0175))
                self.roll += max(-0.44, min(0.44, -sag * 0.0175))
            if self.ruzgar_turb > 0:   # türbülans: yönelimde küçük salınım
                t = self.sure_ms / 1000.0
                self.roll += self.ruzgar_turb * 0.012 * math.sin(t * 6.1)
                self.pitch += self.ruzgar_turb * 0.008 * math.sin(t * 4.3 + 1.0)
        else:
            self.vn = self.ve = 0.0

    def govde(self):
        """§25 INTERCEPTOR gövde (sabit kanat çerçevesi) yönelimi: yerde ve dikey tırmanış/inişte burun yukarı (pitch 90°), yatay uçuşta görünüm = gövde."""
        yatay = self.armed and self.alt_rel > 1.0 and self.alt_rel >= self.hedef_alt - 0.01 and not (self.eve and math.hypot(self.vn, self.ve) < 0.5)
        if yatay:
            return [round(self.roll, 4), round(self.pitch, 4), round(self.yaw, 4)]
        if self.nisan and self.armed and self.alt_rel > 0.05:   # §27 el fırlatıcısı: nişan açısıyla tırmanış
            return [0.0, round(math.radians(self.nisan[1]), 4), round(math.radians(self.nisan[0]), 4)]
        return [0.0, round(math.pi / 2, 4), round(self.yaw, 4)]

    def hava_hizi(self):
        """Hava hızı (m/s): havada yer hızı vektörü − rüzgâr; yerde yer hızı (rüzgâr hava hızı göstergesine yerde yansımaz — basit)."""
        if self.alt_rel <= 0.5:
            return math.hypot(self.vn, self.ve)
        wn, we = self.ruzgar_kd()
        return math.hypot(self.vn - wn, self.ve - we)

    def tele(self):
        hs = math.hypot(self.vn, self.ve)
        ek = {'att_body': self.govde()} if self.dikey else {'servo': self.servo()} if self.rover else {}
        return {**ek, 'lat': round(self.lat, 7), 'lon': round(self.lon, 7), 'alt_msl': round(self.alt0 + self.alt_rel, 2), 'alt_rel': round(self.alt_rel, 2),
                'roll': round(self.roll, 4), 'pitch': round(self.pitch, 4), 'yaw': round(self.yaw, 4),
                'rs': round(self.rs, 3), 'ps': round(self.ps, 3), 'ys': round(self.ys, 3), 'tbm': int(self.sure_ms), 'tbm_pos': int(self.sure_ms),
                'vn': round(self.vn, 2), 've': round(self.ve, 2), 'vd': round(self.vd, 2),
                'airspeed': round(self.hava_hizi(), 2), 'groundspeed': round(hs, 2), 'heading': round(math.degrees(self.yaw) % 360, 1),
                'climb': round(-self.vd, 2), 'mode': self.mode, 'armed': self.armed, 'gps_fix': 6, 'sats': 18,   # RTK Fixed (gerçek SITL ile tutarlı)
                'batt_v': round(self.batt_v, 2), 'batt_pct': int(max(0, min(100, (self.batt_v - 10.5) / 2.1 * 100))),
                'throttle': round(self.throttle, 1), 'rc': list(self.rc), 'home': dict(self.home)}


# ======================================================================
# UDP sunucu (Mission Planner tarafı)
# ======================================================================
class _UdpProto(asyncio.DatagramProtocol):
    def __init__(self, oturum):
        self.oturum = oturum
        self.transport = None

    def connection_made(self, transport):
        self.transport = transport

    def datagram_received(self, data, addr):
        self.oturum._udp_geldi(data, addr)

    def error_received(self, exc):
        pass


# ======================================================================
# Oturum
# ======================================================================
class SimSession:
    def __init__(self, sid, tip, center, world, owner, yonetici, airframe=None, model=None, drone=None, rec=None, power=None, layout=None, camera=None,
                 targets=None, gcs=None, defend=None, drive=None):
        self.id = int(sid)
        # §26 yer kontrol merkezi + EO/radar kulesi (doğrulanmış flightsim_gcs.gcs_dogrula) ve "Yer kontrolünü koru" görevi (SavunmaGorevi; yalnız INTERCEPTOR).
        # Görev istasyonu gerektirir: gcs yoksa istasyon + radar + EO varsayılanlarla açılır, istasyon kapalı seçildiyse açılır.
        if defend and (not gcs or not gcs.get('station')):
            gcs = {**(gcs or {'radar': True, 'radar_km': flightsim_gcs.RADAR_KM_VARSAYILAN, 'eo': True, 'eo_km': flightsim_gcs.EO_KM_VARSAYILAN}), 'station': True}
        self.gcs = gcs or None
        self.gcs_yer = flightsim_gcs.yerlesim((world or {}).get('runway_heading', 0)) if self.gcs else None
        self.savunma = flightsim_gcs.SavunmaGorevi(defend, self.gcs_yer) if defend else None
        self._savunma_crash = 0
        # §24 hedefler: doğrulanmış {items, radius_m} (flightsim_targets.dogrula) — SITL'siz kinematik yörüngeler; önleme izleyicisi; MP'ye ADSB_VEHICLE
        self.hedefler = targets or None
        self.hedef_iz = flightsim_targets.HedefIzleyici(self.hedefler) if self.hedefler else None
        self._adsb_son = 0.0
        self._simstate_son = 0.0   # §25 INTERCEPTOR: son SIMSTATE (gövde yönelimi `att_body`) alımı
        self.camera = kamera_dogrula(camera)   # §22.3 kamera türü (son seçim; `camera` komutu günceller → kayıt satırı)
        self.kimlik = KIMLIK_TABANI + self.id
        self.type, self.center, self.world, self.owner = tip, center, world, owner
        # §23 güç ve yakıt: doğrulanmış `power` (azami hız, yakıt L / km/L, batarya hücre/mAh/W) → GucDurumu (her telemetri karesinde entegre;
        # tele.fuel / tele.elec / tele.speedup); SIM_PLN_THR_MUL desteği ikili taramasından (drone_sitl.hiz_olcegi_destegi)
        self.power = flightsim_power.dogrula(power, tip) if not isinstance(power, dict) or set(power) != set(flightsim_power.ALANLAR) else dict(power)
        self.guc = flightsim_power.GucDurumu(self.power)
        self.hiz_olcegi = drone_sitl.hiz_olcegi_destegi(tip)   # ikili SIM_PLN_THR_MUL tanıyor mu (sahte kipte False)
        self.thr_mul_sitl = None                                # SITL'den gözlenen SIM_PLN_THR_MUL (PARAM_VALUE)
        self.speedup_istek = 1.0                                # son `speed` komutu (reset sonrası yeniden yazılır)
        # §19 kayıt seçenekleri: rec.bin → SITL DataFlash .BIN açık (yalnız armed süre), kapanışta uçuş loglarına kaydedilir (flightsim_bin)
        self.rec = {'bin': bool((rec or {}).get('bin'))}
        self.bin_sonuc = None            # kapanışta {log_id, file_name, size} | {error} | None
        self.alt_not = None              # §9 ev irtifası kuralı: merkez `alt` ≠ arazi (ya da arazi alınamadı) notu; SITL açılışında olay şeridine düşer
        # §21 simülasyon kaydı (flightsim_runs): oturumun gördüğü son parametre değerleri (PARAM_VALUE; kapanışta PARAM_REQUEST_LIST ile tamamlanır),
        # ekran kaydı bağı (rec_finish → video_bagla) ve kapanışta yazılan drone_sim_runs satırı
        self.param_son = {}
        self._param_count = None
        self.video = None
        self.run_sonuc = None
        # §14 harekât paneli: hub köprüsü (flightsim_hub.SimBridge; run() içinde attach), isteğe bağlı dron kaydı {id, code, name, model}
        # (telemetri o dronun adıyla akar; yoksa "Simülatör #N"), SITL'e yüklenen son görevin 3B rota noktaları, komut yürütücü ve bekleyiciler
        self.hub = None
        self.drone = dict(drone) if drone else None
        # Kalıcı parametreler (drone_params; yalnız dron kaydı seçiliyse): panel param_set + Mission Planner PARAM_SET yankıları kaydedilir,
        # açılışta kayıtlılar varsayilan.parm + ilk kalp atışında PARAM_SET ile yüklenir
        self.param_izleyici = drone_params.Izleyici(self.drone['id'], self._olay, srv_rev_yaz=self._srv_rev_yaz, tip=tip) if self.drone and self.drone.get('id') else None
        self.kayitli_params = []
        # Montaj parametreleri (SERVOn_REVERSED; drone_params modül açıklaması §20.1): SITL'e aynen + SIM_SRV_REV maskesi (sanal montaj = gerçek montaj);
        # ikili SIM_SRV_REV tanımıyorsa (drone_sitl.sanal_montaj_destegi) nötr 0 + sarı uyarı
        self.sanal_montaj = drone_sitl.sanal_montaj_destegi(self.type)   # ikili dosya taraması (önbellekli; sahte kipte ikili yok → False)
        self.montaj_arg = {'notr': 0, 'varsayilan': None}   # _montaj_baglami (SITL modelinin nötr montajı)
        self.montaj = {'virtual_mount': self.sanal_montaj, 'mask': 0, 'neutral': [], 'reversed': [], 'motor_skipped': []}   # sitl_kayitlari bilgisi (son açılış)
        self.srv_rev_sitl = None         # SITL'den gözlenen SIM_SRV_REV (PARAM_VALUE); eski ikilide hiç gelmez
        self.route = []
        self.komutcu = flightsim_hub.MavKomut(self)
        self.gorev = flightsim_mission.GorevIzleyici(self)   # §18: görev izleme (MP yüklemesi algılama), iz, çarpışma/özet kayıtları
        self._bekleyenler = []           # [(types, cond, asyncio.Queue)] — _isle içinde dağıtılır (MavKomut ACK/ACK bekleyicileri)
        # §18 arazi sunumu: SITL TERRAIN_REQUEST → sim_terrain → TERRAIN_DATA (gerçek arazi / Google 3B; SIM_TERRAIN_SERVE); sayaçlar + son TERRAIN_REPORT
        self.arazi = {'serve': bool(TERRAIN_SERVE and SITL_ENABLED and world.get('mode') in TERRAIN_KIPLER), 'requests': 0, 'blocks': 0, 'skipped': 0,
                      'errors': 0, 'last_ts': None, 'report': None}
        self._arazi_is, self._arazi_sonraki, self._arazi_hata_son = None, None, 0.0
        self._sahte_gorev, self._sahte_params = [], {}   # sahte kip: hub mission_upload / param_set yankıları
        # Görsel model (§12): kütüphane nesnesi {id, name, source, orient, glb_url, has_prop, …}; yalnız görsel, SITL modelini değiştirmez.
        # `airframe` geriye uyum: dahili caymaz/delta için kısa ad (uçak tiplerinde), aksi None.
        self.model = model if model is not None else _model_eski(tip, airframe)
        self.airframe = airframe if model is None else _airframe_adi(self.model, tip)
        # §13.1 kontrol düzeni (yalnız sabit kanat): classic | elevon | vtail; eksikse modelin düzeni. `layout_etkin` SITL'de fiilen uçan düzen
        # (kalıcı kayıt öncelikli olabilir), `layout_sitl_model` açılan SITL modeli (`plane[-elevon|-vtail][-catapult]`), `layout_atlanan` kalıcı yüzünden yazılmayanlar.
        self.layout = layout_dogrula(tip, layout, self.model)
        self.drive = drive_dogrula(tip, drive, self.model)   # §31 kara aracı sürüş biçimi (ackermann | skid); diğer tiplerde None
        self.layout_etkin = self.layout
        self.layout_sitl_model = None
        self.layout_atlanan = []
        self.yonetici = yonetici
        self.state = 'BASLIYOR'          # BASLIYOR | HAZIR | HATA | KAPANDI
        self.udp_port = None
        self.created_at = db.now()
        self.started = time.time()
        self.sitl = {'pid': None, 'port': None, 'error': None}
        self.gcs_addr, self.gcs_since, self.gcs_last = None, None, 0.0
        self.gcs_rx = 0                  # GCS'den gelen datagram sayısı
        self.gcs_atilan = 0              # kilit dışı adreslerden gelen (iletilmeyen) datagram
        self.sitl_rx = 0                 # SITL'den gelen bayt
        self.viewers = {}                # ws → asyncio.Queue
        self.last_viewer = time.time()
        self.loop = None
        self.task = None
        self._tcp_task = None
        self._udp = None                 # DatagramTransport
        self._tcp_w = None
        self._tcp_r = None
        self._rc_son = 0.0
        self.end_reason = None
        self.client = None               # CAYSIM istemcisi açtıysa {id, name} (docs/caysim-api.md); web oturumunda None
        # Sabit kanat kalkış yöntemi (§13): world.launch (yalnız sabit_kanat'ta anlamlı); aşama: None | armed | launch | released
        self.launch = launch_normalize(tip, world.get('launch'))
        self.launch_phase = None
        self._launch_task = None
        # Motor kesme (`motor_cut`; yalnız uçak tipleri): SITL'de MOTOR_ESTOP (DO_AUX_FUNCTION 31) — ARM korunur, süzülme. tele/to_dict `motor_cut`.
        self.motor_cut = False
        self._motor_cut_istek = None     # (on, zaman): son 218 isteği (red ACK'inde bayrak geri alınır)
        self.sahte = None
        if not SITL_ENABLED:
            self.sahte = SahteKinematik(tip, center['lat'], center['lon'], center.get('alt'), world.get('wind_ms'), self.launch, kalkis_yonu(tip, self.launch, world) if tip == 'sabit_kanat' else world.get('runway_heading'),
                                        world.get('wind_dir'), world.get('wind_gust'), world.get('wind_turb'), drive=self.drive)
        d = _dialect()
        self.mav = d.MAVLink(None, srcSystem=GCS_SYSID, srcComponent=GCS_COMP)   # kodlayıcı
        self.mav_arac = d.MAVLink(None, srcSystem=1, srcComponent=1)             # sahte kip: hub'a araç çerçeveleri (sysid 1)
        self.parser = d.MAVLink(None)                                             # ayrıştırıcı (SITL → telemetri)
        self.parser.robust_parsing = True
        self.sysid, self.comp, self.vtype = 1, 1, None
        self._heartbeat_alindi = False
        self.param_types = {}
        alt0 = float(center.get('alt') or 0)
        self.tele = {'lat': float(center['lat']), 'lon': float(center['lon']), 'alt_msl': alt0, 'alt_rel': 0.0, 'roll': 0.0, 'pitch': 0.0, 'yaw': 0.0,
                     'rs': 0.0, 'ps': 0.0, 'ys': 0.0, 'tbm': 0, 'tbm_pos': 0,
                     'vn': 0.0, 've': 0.0, 'vd': 0.0, 'airspeed': 0.0, 'groundspeed': 0.0, 'heading': 0.0, 'climb': 0.0, 'mode': None, 'armed': False,
                     'gps_fix': 0, 'sats': 0, 'batt_v': None, 'batt_pct': None, 'throttle': 0.0, 'rc': [0] * 8, 'home': None,
                     'servo': None,   # SERVO_OUTPUT_RAW 1…8 µs (gerçek SITL; kontrol yüzeyi animasyonu, §5) — sahte kipte None → istemci rc'den türetir
                     'servo_fn': [None] * 8,   # SERVO1..8_FUNCTION (PARAM_VALUE'dan; 3B model flap/aileron/elevon/ruddervator eşlemesi için)
                     'servo_rev': [None] * 8,  # SERVO1..8_REVERSED (PARAM_VALUE'dan; 3B yüzeyi MANTIKSAL yönde oynatır — §13.1)
                     'wind_spd': float(world.get('wind_ms') or 0), 'wind_dir': float(world.get('wind_dir') or 0)}   # §31 anlık rüzgâr (esintili; HUD/tulum/akış çizgileri)
        self._tele_son = 0.0             # son `tele` yayını (duvar saati; bekçi)
        self._tele_tbm = -10 ** 9        # son yayının SITL time_boot_ms'i (kapı: TELE_TBM_KAPI)
        self._att_son = 0.0              # son ATTITUDE alımı (ATTITUDE akıyorsa GLOBAL_POSITION_INT yayın tetiklemez)
        self._akis_son = 0.0             # son akış isteği
        self._smi_red = False            # SET_MESSAGE_INTERVAL reddedildi → akış bazlı REQUEST_DATA_STREAM
        self.att_sayac = 0               # SITL'den gelen ATTITUDE sayısı (akış hızı ölçümü)

    # ---- dışa görünüm ----
    def to_dict(self, host=None):
        return {'id': self.id, 'mode': 'sitl', 'type': self.type, 'airframe': self.airframe, 'model': dict(self.model) if self.model else None,
                'layout': self.layout, 'layout_effective': self.layout_etkin, 'layout_sitl_model': self.layout_sitl_model, 'layout_skipped': list(self.layout_atlanan),
                'center': dict(self.center), 'alt_note': self.alt_not, 'world': dict(self.world), 'state': self.state, 'launch': {**self.launch, 'phase': self.launch_phase},
                'udp_port': self.udp_port, 'host': host or PUBLIC_HOST or None, 'created_at': self.created_at, 'owner': dict(self.owner),
                'client': dict(self.client) if self.client else None,
                'gcs': {'connected': self.gcs_addr is not None, 'addr': f'{self.gcs_addr[0]}:{self.gcs_addr[1]}' if self.gcs_addr else None,
                        'since': self.gcs_since},
                'sitl': dict(self.sitl),
                # §14: harekât paneli köprüsü (bridge_id = -kimlik), dron kaydı, SITL'deki görevin rota noktaları
                'hub': {'bridge_id': -self.kimlik, 'online': self.hub is not None, 'name': self.hub.name if self.hub else None},
                'drone': dict(self.drone) if self.drone else None, 'route': list(self.route), 'mission': self.gorev.yayin_alanlari(),
                'rec': {**self.rec, 'bin_log': dict(self.bin_sonuc) if self.bin_sonuc else None},
                'params': {'tracked': self.param_izleyici is not None, 'loaded': len(self.kayitli_params),
                           'saved': self.param_izleyici.kayit_sayisi if self.param_izleyici else 0,
                           # montaj parametreleri (SERVOn_REVERSED; §20.1): sanal montaj desteği, SIM_SRV_REV maskesi (yazılan / SITL'de gözlenen), nötrlenen adlar
                           'virtual_mount': bool(self.montaj['virtual_mount']), 'srv_rev_mask': int(self.montaj['mask']), 'srv_rev_sitl': self.srv_rev_sitl,
                           'mount_neutral': list(self.montaj['neutral']), 'mount_reversed': list(self.montaj['reversed']), 'motor_skipped': list(self.montaj.get('motor_skipped') or [])},
                'terrain': {**self.arazi, 'report': dict(self.arazi['report']) if self.arazi['report'] else None},   # §18 arazi sunumu sayaçları + son TERRAIN_REPORT
                # §23 güç ve yakıt: ayarlar + anlık durum + azami hız uygulaması (itki ölçeği destek/gözlenen çarpan) + simülasyon hızı
                'camera': self.camera,   # §22.3
                'power': dict(self.power), 'power_state': self.guc.tele_alanlari(), 'speedup': self.guc.speedup,
                'speed_scale': {'supported': bool(self.hiz_olcegi), 'thr_mul': flightsim_power.thr_mul_tip(self.power['max_speed_ms'], self.type) if self.power.get('max_speed_ms') else None,
                                'thr_mul_sitl': self.thr_mul_sitl, 'stock_ms': round(flightsim_power.stok_hiz(self.type), 1)},
                # §24 hedefler (model görsel bilgisiyle) + önleme durumu; §25 dikey kalkış tipi
                'targets': flightsim_targets.zenginlestir(self.hedefler), 'targets_state': self.hedef_iz.ozet() if self.hedef_iz else None,
                'vertical': self.type in DIKEY_TIPLER,
                'ground': self.type in ROVER_TIPLERI, 'drive': self.drive,   # §31 kara aracı (kalkış yok; 3B zemine oturur) + sürüş biçimi
                'motor_cut': bool(self.motor_cut),   # motor kesik (süzülüyor); uçak dışı tiplerde hep False
                # §26 yer kontrol merkezi (yerleşimiyle) + "Yer kontrolünü koru" görevi (yapılandırma, deterministik plan, anlık durum)
                'site': {**self.gcs, 'layout': self.gcs_yer} if self.gcs else None,   # ('gcs' anahtarı Mission Planner bağlantısıdır)
                'defend': self.savunma_dict()}

    def savunma_dict(self):
        if self.savunma is None:
            return None
        return {'config': dict(self.savunma.cfg), 'plan': self.savunma.plan, 'station': dict(self.savunma.ist), 'state': self.savunma.durum()}

    # ---- §14: bekleyici kuyrukları (MavKomut) ----
    @contextlib.contextmanager
    def bekleyici(self, types, cond=None):
        """`with s.bekleyici(('COMMAND_ACK',), cond) as q:` — _isle bu türdeki (ve koşulu sağlayan) araç mesajlarını q'ya koyar."""
        q = asyncio.Queue()
        ent = (tuple(types), cond, q)
        self._bekleyenler.append(ent)
        try:
            yield q
        finally:
            with contextlib.suppress(ValueError):
                self._bekleyenler.remove(ent)

    def _dagit(self, m):
        t = m.get_type()
        for types, cond, q in list(self._bekleyenler):
            if t in types:
                try:
                    if cond is None or cond(m):
                        q.put_nowait(m)
                except Exception:   # noqa: BLE001 — koşul hatası bekleyiciyi bozmasın
                    continue

    # ---- yayın ----
    def _yay(self, obj):
        txt = json.dumps(obj, ensure_ascii=False)
        onemli = obj.get('t') != 'tele'
        for q in list(self.viewers.values()):
            _kuyruga(q, txt, onemli)

    def _olay(self, text, severity=6):
        self._yay({'t': 'event', 'text': str(text)[:300], 'severity': int(severity), 'ts': time.time()})

    def _durum(self, state):
        self.state = state
        self._yay({'t': 'state', 'state': state})

    def _konsol(self, metin, sev='bilgi'):   # SITL yöneticisi (iş parçacığı) → olay döngüsü
        if self.loop is not None and not self.loop.is_closed():
            self.loop.call_soon_threadsafe(self._olay, metin, 2 if sev == 'hata' else 4 if sev == 'uyari' else 6)

    def izleyici_ekle(self, ws):
        q = asyncio.Queue(maxsize=VIEWER_QUEUE)
        self.viewers[ws] = q
        self.last_viewer = time.time()
        return q

    def izleyici_sil(self, ws):
        self.viewers.pop(ws, None)
        self.last_viewer = time.time()

    # ---- UDP (GCS) ----
    def _udp_geldi(self, data, addr):
        now = time.time()
        if self.gcs_addr is None or now - self.gcs_last > GCS_SESSIZLIK:
            if self.gcs_addr != addr:
                self.gcs_addr, self.gcs_since = addr, db.now()
                self._olay(f'GCS bağlandı: {addr[0]}:{addr[1]}', 6)
        elif addr != self.gcs_addr:
            self.gcs_atilan += 1   # GCS kilidi: başka adresten gelen iletilmez
            return
        self.gcs_last = now
        self.gcs_rx += 1
        if self.param_izleyici is not None:   # Mission Planner PARAM_SET'leri ham geçer; izleyici yalnız niyeti not eder (yankı PARAM_VALUE kaydettirir)
            self.param_izleyici.gcs_bayt(data)
        if self._tcp_w is not None and not self._tcp_w.is_closing():
            try:
                self._tcp_w.write(data)
            except Exception:   # noqa: BLE001
                pass

    def _gcs_gonder(self, data):
        if self._udp is not None and self.gcs_addr is not None and not self._udp.is_closing():
            try:
                self._udp.sendto(data, self.gcs_addr)
            except Exception:   # noqa: BLE001
                pass

    async def _udp_ac(self):
        """SIM_UDP_BASE … +99 arasında boş UDP portuna bağlanır."""
        kullanilan = {s.udp_port for s in self.yonetici.sessions.values() if s is not self}
        son = None
        for p in range(UDP_BASE, UDP_BASE + UDP_ARALIK):
            if p in kullanilan:
                continue
            try:
                tr, _ = await self.loop.create_datagram_endpoint(lambda: _UdpProto(self), local_addr=('0.0.0.0', p))
            except OSError as e:
                son = e
                continue
            self._udp, self.udp_port = tr, p
            return
        raise SimHata('sitl', f'Boş UDP portu yok ({UDP_BASE}–{UDP_BASE + UDP_ARALIK - 1}): {son}')

    # ---- SITL / TCP ----
    async def _sitl_ac(self):
        """SITL'i başlatır ve SERIAL0 TCP'ye bağlanır (sahte kipte MANAGER.sahte_tcp_port'a). Hata → state HATA."""
        ex = self.loop.run_in_executor
        if SITL_ENABLED:
            c = self.center
            self._olay(f'SITL başlatılıyor ({TIP_ADLARI.get(self.type, self.type)}) · {c.get("name") or ""}', 6)
            await self._kayitli_oku()
            sitl_model = self._sitl_modeli()   # sabit kanat: plane[-elevon|-vtail][-catapult] (düzen §13.1 + rampa §13); diğer tipler None (TIP_ESLEME)
            port, err = await ex(None, lambda: drone_sitl.YONETICI.baslat(self.kimlik, self.type, c['lat'], c['lon'], sysid=1,
                                                                          irtifa=c.get('alt') or EV_IRTIFA, konsol=self._konsol, model=sitl_model,
                                                                          yon=kalkis_yonu(self.type, self.launch, self.world),   # §31: uçak burnu kalkış yönünde (rampa azimutu / pist)
                                                                          log_bin=self.rec['bin'], ekstra_parm=drone_params.parm_satirlari(self.kayitli_params, self.sanal_montaj, self.type, **self.montaj_arg)
                                                                          + [f'{a} {v:g}' for a, v in self.layout_parametreleri()[0]], temiz=True))   # §13.1 düzen seti parm dosyasına da (SITL ilk andan doğru; ilk kalp atışında PARAM_SET yinelenir)
            if port and self.rec['bin']:
                self._olay('DataFlash kaydı açık: uçuş logu (.bin) oturum kapanışında Uçuş Logları\'na kaydedilir', 6)
            if not port:
                self.sitl['error'] = err or 'SITL başlatılamadı'
                self._olay(self.sitl['error'], 2)
                self._durum('HATA')
                return False
            self.sitl.update(port=port, pid=drone_sitl.YONETICI.bilgi(self.kimlik).get('pid'), error=None)
        else:
            await self._kayitli_oku()
            self._sitl_modeli()   # sahte kip: etkin düzen / model adı yalnız bilgi (SITL açılmaz)
            port = self.yonetici.sahte_tcp_port
            self.sitl.update(port=port, pid=None, error=None)
        if port:
            son = None
            bitis = time.time() + (SITL_BAGLANTI_S if SITL_ENABLED else 5)
            while time.time() < bitis:
                try:
                    self._tcp_r, self._tcp_w = await asyncio.wait_for(asyncio.open_connection('127.0.0.1', port), 3)
                    break
                except (OSError, asyncio.TimeoutError) as e:
                    son = e
                    await asyncio.sleep(1.0)
            if self._tcp_w is None:
                self.sitl['error'] = f'SITL portuna bağlanılamadı (tcp:127.0.0.1:{port}): {son}'
                self._olay(self.sitl['error'], 2)
                self._durum('HATA')
                return False
            self._tcp_task = self.loop.create_task(self._tcp_okuyucu())
            self._olay(f'SITL bağlandı: tcp:127.0.0.1:{port}', 6)
        self._heartbeat_alindi = False
        self._durum('HAZIR')
        return True

    async def _kayitli_oku(self):
        """Dron kaydının kalıcı parametreleri (drone_sitl_params) → `kayitli_params` (SITL açılışından önce; okunamazsa boş)."""
        self.kayitli_params, self.srv_rev_sitl = [], None
        self.montaj = {'virtual_mount': self.sanal_montaj, 'mask': 0, 'neutral': [], 'reversed': [], 'motor_skipped': []}
        if self.param_izleyici is None:
            return
        try:
            self.kayitli_params = await self.loop.run_in_executor(None, drone_params.yukle, self.param_izleyici.drone_id)
        except Exception as e:   # noqa: BLE001
            self._olay(f'Kayıtlı parametreler okunamadı: {e}'[:200], 4)
        # ikili SIM_SRV_REV tanıyor mu (dosya taraması; sahte kipte ikili yok → False → nötr yol)
        self.sanal_montaj = await self.loop.run_in_executor(None, drone_sitl.sanal_montaj_destegi, self.type)
        self.param_izleyici.sanal_montaj = self.sanal_montaj
        self._montaj_baglami()
        _, self.montaj = drone_params.sitl_kayitlari(self.kayitli_params, self.sanal_montaj, self.type, **self.montaj_arg)

    def _montaj_baglami(self):
        """Sanal montaj maskesinin SITL modeline göre nötr noktası (`montaj_arg`: notr + düzen setinin REVERSED değerleri); izleyiciye de verilir."""
        notr, var = 0, None
        if self.type == 'sabit_kanat':
            notr = sitl_notr_mask(sitl_model_eki(layout_etkin_fn(self.layout, self.kayitli_params)))
            var = {a: v for a, v in LAYOUT_PARAMLARI.get(self.layout or 'classic', ()) if drone_params.montaj_mi(a)}
        self.montaj_arg = {'notr': notr, 'varsayilan': var}
        if self.param_izleyici is not None:
            self.param_izleyici.notr_mask, self.param_izleyici.varsayilan_rev = notr, var

    def _kayitli_yaz(self):
        """İlk kalp atışında kayıtlı parametreleri PARAM_SET ile yeniden yazar (eeprom'daki eski değer parm dosyasını ezebilir); yankılar
        tabana işlenir (yeniden kaydedilmez). Montaj parametreleri (SERVOn_REVERSED) aynen + SIM_SRV_REV maskesi (sanal montaj); ikili
        desteklemiyorsa 0 gider → sarı olay. Olay: "N kayıtlı parametre yüklendi"."""
        if not self.kayitli_params or self.param_izleyici is None:
            return
        sitl, self.montaj = drone_params.sitl_kayitlari(self.kayitli_params, self.sanal_montaj, self.type, **self.montaj_arg)
        self.param_izleyici.yukleme_isaretle([r['name'] for r in sitl])
        self.param_izleyici.srv_rev_mask = self.montaj['mask'] if self.sanal_montaj else None
        for r in sitl:
            self._gonder(self.mav.param_set_encode(self.sysid, self.comp, str(r['name']).encode(), float(r['value']), int(r.get('ptype') or 9)))
        kayit = [r for r in sitl if r['name'] != drone_params.SIM_SRV_REV]
        self._olay(f'{len(kayit)} kayıtlı parametre yüklendi ({self.drone.get("code") or self.drone.get("name") or ""})'.replace(' ()', ''), 6)
        for olay in (drone_params.montaj_olayi(self.montaj), drone_params.sensor_olayi(self.montaj)):   # sensör kalibrasyonu (COMPASS_* …): SITL'de nötr
            if olay:
                self._olay(*olay)

    def _srv_rev_yaz(self, mask):
        """İzleyici geri çağrısı: oturum sırasında SERVOn_REVERSED değişti → SIM_SRV_REV maskesi SITL'e anında (PARAM_SET INT32)."""
        self.montaj['mask'] = int(mask)
        if self.mav is None or self._tcp_w is None:
            return
        self._gonder(self.mav.param_set_encode(self.sysid, self.comp, drone_params.SIM_SRV_REV.encode(), float(mask), drone_params.SIM_SRV_REV_PTYPE))

    def _param_value_gozlendi(self, m):
        """SITL'den PARAM_VALUE (gerçek SITL `_isle`; sahte kipte `_sahte_param_ayristir`): tip önbelleği + kalıcı izleyici."""
        ad = str(m.param_id).rstrip('\x00')
        self.param_types[ad] = m.param_type
        try:   # §21: son değer dökümü (kapanışta params.param)
            self.param_son[ad] = float(m.param_value)
            if m.param_count and 0 < int(m.param_count) < 65535:
                self._param_count = int(m.param_count)
        except (TypeError, ValueError):
            pass
        if ad == drone_params.SIM_SRV_REV:   # sanal montaj maskesi SITL'de gerçekten var (yamalı ikili): params.srv_rev_sitl
            try:
                self.srv_rev_sitl = int(round(float(m.param_value)))
            except (TypeError, ValueError):
                pass
        elif ad == flightsim_power.SIM_SPEEDUP:   # §23: simülasyon hızı SITL'in bildirdiği değer (tele.speedup; yakıt/batarya istatistiği)
            try:
                self.guc.hiz_ayarla(float(m.param_value))
            except (TypeError, ValueError):
                pass
        elif ad == flightsim_power.SIM_PLN_THR_MUL:
            try:
                self.thr_mul_sitl = round(float(m.param_value), 4)
            except (TypeError, ValueError):
                pass
        if ad.startswith('SERVO') and ad.endswith('_FUNCTION') and ad[5:-9].isdigit() and 1 <= int(ad[5:-9]) <= 8:
            try:
                self.tele['servo_fn'][int(ad[5:-9]) - 1] = int(round(float(m.param_value)))
            except (TypeError, ValueError):
                pass
        elif ad.startswith('SERVO') and ad.endswith('_REVERSED') and ad[5:-9].isdigit() and 1 <= int(ad[5:-9]) <= 8:
            try:
                self.tele['servo_rev'][int(ad[5:-9]) - 1] = int(round(float(m.param_value)))
            except (TypeError, ValueError):
                pass
        if self.param_izleyici is not None:
            try:
                self.param_izleyici.param_value(ad, m.param_value, m.param_type, m.param_index, m.param_count)
            except Exception:   # noqa: BLE001
                pass

    def _sahte_param_ayristir(self, data):
        """Sahte kip (HEPGO_SITL=0): sahte SITL'den gelen baytlarda yalnız PARAM_VALUE aranır (Mission Planner yankısı sınaması)."""
        try:
            msgs = self.parser.parse_buffer(data) or []
        except Exception:   # noqa: BLE001
            return
        for m in msgs:
            if m.get_type() == 'PARAM_VALUE':
                self._param_value_gozlendi(m)

    async def _tcp_kapat(self):
        if self._tcp_task is not None:
            self._tcp_task.cancel()
            self._tcp_task = None
        if self._tcp_w is not None:
            try:
                self._tcp_w.close()
            except Exception:   # noqa: BLE001
                pass
        self._tcp_r = self._tcp_w = None

    async def _tcp_okuyucu(self):
        """SITL → (UDP GCS'ye ham) + (pymavlink ayrıştırıcı → telemetri)."""
        try:
            while True:
                data = await self._tcp_r.read(4096)
                if not data:
                    break
                self.sitl_rx += len(data)
                self._gcs_gonder(data)
                if SITL_ENABLED:
                    self._ayristir(data)
                else:
                    self._sahte_param_ayristir(data)   # sahte kip: PARAM_VALUE → kalıcı izleyici (varsa) + son değer dökümü (§21)
        except asyncio.CancelledError:
            return
        except Exception:   # noqa: BLE001
            pass
        if self.state not in ('KAPANDI',):
            self.sitl['error'] = 'SITL bağlantısı koptu'
            self._olay(self.sitl['error'], 2)
            self._durum('HATA')

    def _gonder(self, msg):
        """MAVLink mesajını SITL'e yazar (kodlayıcı seq'i elle artırılır: MAVLink.send yok, dosya yok)."""
        if self._tcp_w is None or self._tcp_w.is_closing():
            return False
        try:
            buf = msg.pack(self.mav)
            self.mav.seq = (self.mav.seq + 1) % 256
            self._tcp_w.write(buf)
            return True
        except Exception:   # noqa: BLE001
            return False

    def _ayristir(self, data):
        try:
            msgs = self.parser.parse_buffer(data) or []
        except Exception:   # noqa: BLE001
            return
        for m in msgs:
            try:
                self._isle(m)
            except Exception:   # noqa: BLE001
                continue
        if self.hub is not None:   # §14: aynı mesajlar harekât paneline (hub DroneState/olay/konsol); ikinci ayrıştırma yok
            arac = [m for m in msgs if m.get_type() != 'BAD_DATA' and m.get_srcSystem() != GCS_SYSID]
            if arac:
                try:
                    self.hub.feed_msgs(arac)
                except Exception:   # noqa: BLE001
                    pass

    def _isle(self, m):
        t = m.get_type()
        if t == 'BAD_DATA':
            return
        src = m.get_srcSystem()
        if src == GCS_SYSID:
            return   # GCS yankısı
        if self._bekleyenler:
            self._dagit(m)
        if t in ('MISSION_CURRENT', 'MISSION_ACK', 'MISSION_REQUEST', 'MISSION_REQUEST_INT', 'STATUSTEXT'):
            try:
                self.gorev.mesaj(m)   # §18: MP görev yüklemesi / aktif WP / SITL çarpışma metni
            except Exception:   # noqa: BLE001
                pass
        te = self.tele
        if t == 'HEARTBEAT':
            if m.type in (6, 18):   # GCS / ONBOARD_CONTROLLER değil, araç lazım
                return
            self.sysid, self.comp, self.vtype = src, m.get_srcComponent(), m.type
            te['armed'] = bool(m.base_mode & 128)
            te['mode'] = _mod_adi(m.type, m.custom_mode)
            if not self._heartbeat_alindi:
                self._heartbeat_alindi = True
                self._ilk_heartbeat()
        elif src != self.sysid:
            return
        elif t == 'GLOBAL_POSITION_INT':
            if m.lat or m.lon:   # EKF kökeni oluşmadan SITL 0/0 yollar: merkez konumu korunur (3B'de dron 4000 km uzağa gitmesin)
                te['lat'], te['lon'] = m.lat / 1e7, m.lon / 1e7
            te['alt_msl'], te['alt_rel'] = m.alt / 1000.0, m.relative_alt / 1000.0
            te['vn'], te['ve'], te['vd'] = m.vx / 100.0, m.vy / 100.0, m.vz / 100.0
            if m.hdg != 65535:
                te['heading'] = m.hdg / 100.0
            te['tbm'] = te['tbm_pos'] = int(m.time_boot_ms)   # tbm_pos: konum damgası (ATTITUDE ile farklı zamanlı; istemci ayrı enterpole eder, §5)
            if time.time() - self._att_son > 0.1:   # ATTITUDE akmıyorsa konum yayını tetikler
                self._tele_yay(te['tbm'])
        elif t == 'ATTITUDE':
            te['roll'], te['pitch'], te['yaw'] = round(m.roll, 4), round(m.pitch, 4), round(m.yaw, 4)
            te['rs'], te['ps'], te['ys'] = round(m.rollspeed, 3), round(m.pitchspeed, 3), round(m.yawspeed, 3)
            te['tbm'] = int(m.time_boot_ms)
            self.att_sayac += 1
            self._att_son = time.time()
            if self.type not in DIKEY_TIPLER or time.time() - self._simstate_son > 0.2:
                self._tele_yay(te['tbm'])   # INTERCEPTOR: yayın aynı EXTRA1 tikindeki SIMSTATE'te (gövde yönelimi ile birlikte)
        elif t == 'SIMSTATE' and self.type in DIKEY_TIPLER:
            # §25 tailsitter: ArduPlane ATTITUDE'ı Q kiplerinde ve geçişte "VTOL görünümü"yle yollar (quadplane.show_vtol_view: ahrs_view = gövde ·
            # PITCH_90 → askıda pitch ≈ 0). HUD/FPV OSD bu görünümü kullanır (pilot için doğal); 3B gövde ise SITL fiziğinin GERÇEK yönelimini (SIMSTATE,
            # sabit kanat çerçevesi: askıda burun yukarı ~90°) `att_body` ile çizer. Açısal hızlar (rs/ps/ys) zaten gövde çerçevesindedir.
            te['att_body'] = [round(m.roll, 4), round(m.pitch, 4), round(m.yaw, 4)]
            self._simstate_son = time.time()
            self._tele_yay(te.get('tbm'))
        elif t == 'VFR_HUD':
            # motor kesikken VFR_HUD.throttle gaz TALEBİNİ bildirir (ör. 68) ama çıkış 1000 µs → gösterge ve yakıt modeli (flightsim_power) için 0
            te['airspeed'], te['groundspeed'], te['throttle'], te['climb'] = round(m.airspeed, 2), round(m.groundspeed, 2), 0 if self.motor_cut else m.throttle, round(m.climb, 2)
            te['heading'] = float(m.heading)
        elif t == 'SYS_STATUS':
            te['batt_v'] = m.voltage_battery / 1000.0 if m.voltage_battery != 65535 else None
            te['batt_pct'] = m.battery_remaining if m.battery_remaining >= 0 else None
        elif t == 'GPS_RAW_INT':
            te['gps_fix'] = m.fix_type
            te['sats'] = m.satellites_visible if m.satellites_visible != 255 else None
        elif t == 'RC_CHANNELS':
            te['rc'] = [m.chan1_raw, m.chan2_raw, m.chan3_raw, m.chan4_raw, m.chan5_raw, m.chan6_raw, m.chan7_raw, m.chan8_raw]
        elif t == 'SERVO_OUTPUT_RAW':   # servo çıkışları µs (ArduPlane: 1 aileron, 2 elevator, 3 gaz, 4 rudder; flap SERVOn_FUNCTION 2/3) → 3B kontrol yüzeyleri (§5)
            te['servo'] = [m.servo1_raw, m.servo2_raw, m.servo3_raw, m.servo4_raw, m.servo5_raw, m.servo6_raw, m.servo7_raw, m.servo8_raw]
        elif t == 'STATUSTEXT':
            self._olay(str(m.text).rstrip('\x00'), m.severity)
        elif t == 'TERRAIN_REPORT':   # §18: ArduPilot arazi veritabanına (SRTM; GCS'ten / bizden TERRAIN_DATA ile dolar) göre AGL → 3B tutarlılık süzgeci. Veri yoksa terrain_height 0 → None
            yuklu = int(getattr(m, 'loaded', 0) or 0)
            te['terrain_agl'] = round(float(m.current_height), 2) if (yuklu > 0 and abs(float(m.terrain_height)) > 0.5) else None
            te['terrain_h'] = round(float(m.terrain_height), 1) if te['terrain_agl'] is not None else None   # SITL'in bulunduğu noktadaki arazi yüksekliği (m MSL)
            self.arazi['report'] = {'lat': m.lat / 1e7, 'lon': m.lon / 1e7, 'spacing': int(m.spacing), 'terrain_height': round(float(m.terrain_height), 1),
                                    'current_height': round(float(m.current_height), 1), 'pending': int(m.pending), 'loaded': yuklu, 'ts': round(time.time(), 1)}
        elif t == 'TERRAIN_REQUEST':   # §18: SITL arazi bloğu istiyor → sim_terrain'den TERRAIN_DATA (yalnız gerçek arazi / Google 3B kipi)
            self._terrain_istek(m)
        elif t == 'HOME_POSITION':
            te['home'] = {'lat': m.latitude / 1e7, 'lon': m.longitude / 1e7, 'alt': m.altitude / 1000.0}
        elif t == 'COMMAND_ACK':
            if m.command == 511:   # SET_MESSAGE_INTERVAL: plane 20 ms'yi reddeder → akış bazlı isteğe geç (tek sefer, olay spam'i yok)
                if m.result not in (0, 5) and not self._smi_red:
                    self._smi_red = True
                    self._akis_iste(tam=False)
                    self._olay('Mesaj aralığı isteği reddedildi; 50 Hz akış REQUEST_DATA_STREAM ile istendi', 6)
            elif m.command == MAV_CMD_DO_AUX_FUNCTION and m.result not in (0, 5):
                istek = self._motor_cut_istek
                if istek is not None and time.time() - istek[1] <= MOTOR_CUT_RED_S and self.motor_cut == istek[0]:
                    self.motor_cut = not istek[0]   # araç reddetti: bayrak gerçeği yansıtsın
                self._olay(f'Motor {"kesme" if istek and istek[0] else "geri verme"} komutu reddedildi (MAV_RESULT {m.result})', 3)
            elif m.result not in (0, 5):
                self._olay(f'Komut {m.command} reddedildi (MAV_RESULT {m.result})', 4)
        elif t == 'PARAM_VALUE':
            self._param_value_gozlendi(m)

    def _ilk_heartbeat(self):
        """İlk araç kalp atışı: genel akış 10 Hz + yüksek hızlı mesaj aralıkları, HOME iste, kayıtlı parametreler (dron kaydı), rüzgâr ve RC
        parametreleri (oturum ayarları kayıtlılardan SONRA yazılır: son söz oturumun)."""
        d = _dialect()
        self._akis_iste()
        self._gonder(self.mav.command_long_encode(self.sysid, self.comp, 512, 0, 242, 0, 0, 0, 0, 0, 0))         # HOME bir kez
        self._kayitli_yaz()
        self._ruzgar_yaz(d)
        for ad, deger in RC_PARAMLAR:   # araçta olmayan ad (kopterde THR_FAILSAFE vb.) sessizce yok sayılır
            self._gonder(self.mav.param_set_encode(self.sysid, self.comp, ad.encode(), float(deger), d.MAV_PARAM_TYPE_REAL32))
        self._param_set(GPS_RTK_PARAMLARI)   # RTK düzeyi GPS (fix 6 zaten; doğruluk/uydu/hata sıfırlama)
        if self.type == 'sabit_kanat':   # kalkış yöntemi + yerde kayma düzeltmesi parametreleri (§13)
            self._param_set(launch_parametreleri(self.launch))
            self._param_set(self.flap_parametreleri())   # otomatik flaplar (kayıtlı değeri olanlar atlanır: kullanıcı yapılandırması)
            self._layout_yaz()                           # kontrol düzeni başlangıç seti (§13.1; kayıtlı adlar atlanır) + konsol notu
        if self.type in DIKEY_TIPLER:   # §25 tailsitter: açık etkinleştirme + RTL dikey iniş (parm dosyasında da var; eeprom'daki eski değer ezilir) + yerde itki 0
            self._param_set(flightsim_icept.OTURUM_PARAMLARI + PLANE_YER_PARAMLARI)
        self._hiz_yaz()   # §23 azami hız (uçak): AIRSPEED_MAX/CRUISE, THR_MAX + SIM_PLN_THR_MUL (yamalı ikili)
        if self.speedup_istek != 1.0:   # reset sonrası yeni SITL: seçili simülasyon hızı korunur
            self._param_set(((flightsim_power.SIM_SPEEDUP, self.speedup_istek),))
        if self.arazi['serve']:   # §18: arazi veritabanı açık, 100 m ızgara; istekler sim_terrain'den yanıtlanır
            self._param_set(TERRAIN_PARAMLARI)
            self._olay('Arazi verisi: SITL\'in arazi istekleri gerçek yükseklik verisinden (terrarium z13) yanıtlanıyor — fizik gerçek topoğrafyayı görür', 6)
        self._olay('SITL kalp atışı alındı; veri akışı istendi (ATTITUDE/konum 50 Hz)', 6)
        # §9 ev irtifası kuralı: izleyiciler artık bağlı (HAZIR öncesi yayınlar WS'ye ulaşmaz) → kullanılan ev irtifası + uyumsuzluk notu olay şeridine
        c = self.center
        self._olay(f'Ev irtifası {float(c.get("alt") or EV_IRTIFA):.1f} m MSL ({"arazi verisi (terrarium)" if self.world.get("mode") in TERRAIN_KIPLER and c.get("alt") is not None else "merkez kaydı/varsayılan"})', 6)
        if self.alt_not:
            self._olay(self.alt_not, 4)

    # ---- §18 arazi sunumu (TERRAIN_REQUEST → TERRAIN_DATA) ----
    def _terrain_istek(self, m):
        """SITL'in TERRAIN_REQUEST'i (blok SW köşesi, grid_spacing, 56 bit maske): blok yükseklikleri iş parçacığında sim_terrain'den (karo indirme
        bloklayabilir) hesaplanır, olay döngüsünde TERRAIN_DATA olarak yazılır. Aynı anda tek iş; iş sürerken gelen son istek sıraya alınır (SITL
        yanıtlanmayan parçaları zaten yeniden ister). Mission Planner bağlıysa o da yanıtlayabilir (aynı SRTM kaynağı değilse 1–3 m fark; SITL son geleni yazar)."""
        if not self.arazi['serve'] or self.loop is None:
            return
        self.arazi['requests'] += 1
        istek = (int(m.lat), int(m.lon), int(m.grid_spacing), int(m.mask))
        if self._arazi_is is not None and not self._arazi_is.done():
            self._arazi_sonraki = istek
            return
        self._arazi_baslat(istek)

    def _arazi_baslat(self, istek):
        from . import sim_terrain
        lat, lon, spacing, mask = istek
        self._arazi_is = self.loop.run_in_executor(None, sim_terrain.terrain_bloklari, lat, lon, spacing, mask)
        self._arazi_is.add_done_callback(lambda fut, istek=istek: self._arazi_bitti(fut, istek))

    def _arazi_bitti(self, fut, istek):
        lat, lon, spacing, _mask = istek
        try:
            bloklar, atlanan = fut.result()
        except Exception as e:   # noqa: BLE001 — kaynak hatası: SITL bloğu yeniden ister
            bloklar, atlanan = [], BLOK_HATA
            self.arazi['errors'] += 1
            if time.time() - self._arazi_hata_son > TERRAIN_HATA_OLAY_S:
                self._arazi_hata_son = time.time()
                self._olay(f'Arazi verisi alınamadı (SITL düz zeminde kalabilir): {e}'[:200], 4)
        for bit, data in bloklar:
            self._gonder(self.mav.terrain_data_encode(lat, lon, spacing, bit, data))
        self.arazi['blocks'] += len(bloklar)
        self.arazi['skipped'] += atlanan
        self.arazi['last_ts'] = round(time.time(), 1)
        if atlanan and atlanan != BLOK_HATA and time.time() - self._arazi_hata_son > TERRAIN_HATA_OLAY_S:
            self._arazi_hata_son = time.time()
            self._olay(f'Arazi verisi: {atlanan} parça alınamadı (yükseklik kaynağı); SITL yeniden isteyecek', 4)
        sonraki, self._arazi_sonraki = self._arazi_sonraki, None
        if sonraki is not None and self._tcp_w is not None:
            self._arazi_baslat(sonraki)

    def hiz_parametreleri(self):
        """§23 azami hız: `power.max_speed_ms` → flightsim_power.hiz_parametreleri (kayıtlı AIRSPEED oranı; itki çarpanı yalnız yamalı ikilide).
        Uçak tiplerinde max_speed yoksa da SIM_PLN_THR_MUL 1 yazılır (eeprom'da önceki oturumdan kalan çarpan silinsin)."""
        if self.type not in PLANE_TIPLERI:
            return []
        out = flightsim_power.hiz_parametreleri(self.power.get('max_speed_ms'), self.kayitli_params, self.hiz_olcegi, tip=self.type)
        if self.hiz_olcegi and not any(a == flightsim_power.SIM_PLN_THR_MUL for a, _ in out):
            out.append((flightsim_power.SIM_PLN_THR_MUL, 1.0))
        return out

    def _hiz_yaz(self):
        p = self.hiz_parametreleri()
        if not p:
            return
        if self.param_izleyici is not None:   # oturum ayarı: yankılar kalıcı kayda girmez (kullanıcı sonra MP'den değiştirirse kaydedilir)
            self.param_izleyici.yukleme_isaretle([a for a, _ in p])
        self._param_set(p)
        v = self.power.get('max_speed_ms')
        if v:
            mul = next((d for a, d in p if a == flightsim_power.SIM_PLN_THR_MUL), None)
            cruise = next((d for a, d in p if a == 'AIRSPEED_CRUISE'), None)
            if mul is not None:
                self._olay(f'Azami hız {v:g} m/s ({v * 3.6:.0f} km/h): AIRSPEED_MAX {v:g}, AIRSPEED_CRUISE {cruise:g}, THR_MAX 100, SITL itki çarpanı SIM_PLN_THR_MUL {mul:g} (stok tam gaz ≈ {flightsim_power.stok_hiz(self.type):.0f} m/s)', 6)
            else:
                self._olay(f'Azami hız {v:g} m/s: {flightsim_power.HIZ_DESTEK_YOK} (stok fizik tam gazda ≈ {flightsim_power.stok_hiz(self.type):.0f} m/s verir)', 4)

    def flap_parametreleri(self):
        """FLAP_PARAMLARI'ndan dronun kalıcı kaydında olmayanlar (kayıtlı SERVOn_FUNCTION / *_FLAP_* kullanıcı kararıdır, ezilmez)."""
        kayitli = {r['name'] for r in self.kayitli_params}
        return [(a, v) for a, v in FLAP_PARAMLARI if a not in kayitli]

    def layout_parametreleri(self):
        """§13.1 düzen başlangıç setinden dronun kalıcı kaydında olmayanlar → (yazılacak, atlanan). Sabit kanat dışı boş."""
        if self.type != 'sabit_kanat':
            return [], []
        return layout_parametreleri(self.layout, [r['name'] for r in self.kayitli_params])

    def _sitl_modeli(self):
        """Sabit kanat SITL modeli: `plane` + düzen son eki (ETKİN fonksiyonlardan: kalıcı kayıt öncelikli) + rampa `-catapult`; kara aracı (§31)
        `rover` | `rover-skid` (sürüş biçimi); diğer tiplerde None."""
        if self.type in ROVER_TIPLERI:
            return drone_sitl.ROVER_SKID_MODEL if self.drive == 'skid' else 'rover'
        if self.type != 'sabit_kanat':
            return None
        fn = layout_etkin_fn(self.layout, self.kayitli_params)
        self.layout_etkin = layout_etkin(fn)
        model = 'plane' + sitl_model_eki(fn) + ('-catapult' if self.launch.get('method') == 'ramp' else '')
        self.layout_sitl_model = model
        return model

    def _layout_yaz(self):
        """İlk kalp atışı: düzen seti PARAM_SET (kayıtlı adlar atlanır) + konsol notu (etkin düzen, SITL modeli, atlananlar)."""
        yaz, atla = self.layout_parametreleri()
        self.layout_atlanan = atla
        if yaz:
            self._param_set(yaz)
        ad = LAYOUT_ADLARI.get(self.layout, self.layout)
        ozet = ', '.join(f'{a} {v:g}' for a, v in yaz)
        if self.layout_etkin != self.layout:
            self._olay(f'Kontrol düzeni {ad}: dronun kalıcı kaydı öncelikli ({", ".join(atla)}) → SITL fiilen {LAYOUT_ADLARI.get(self.layout_etkin)} '
                       f'kurulumuyla uçuyor (model {self.layout_sitl_model})' + (f'; yazılan: {ozet}' if ozet else ''), 4)
        else:
            self._olay(f'Kontrol düzeni {ad}: SITL modeli {self.layout_sitl_model or "plane"}' + (f' · yazılan {ozet}' if ozet else '')
                       + (f' · kalıcı kayıt öncelikli: {", ".join(atla)}' if atla else ''), 6)

    def _param_set(self, ciftler):
        d = _dialect()
        for ad, deger in ciftler:
            self._gonder(self.mav.param_set_encode(self.sysid, self.comp, ad.encode(), float(deger), d.MAV_PARAM_TYPE_REAL32))

    # ---- sabit kanat kalkış dizisi (§13) ----
    def _launch_yay(self, phase, **extra):
        self.launch_phase = phase
        self._yay({'t': 'launch', 'method': self.launch.get('method'), 'phase': phase, 'ts': round(time.time(), 3), **extra})
        # §14: aşama harekât paneli konsoluna da düşer (genel konsol yalnız hata/uyarı STATUSTEXT gösterir; bu satır KOMUT gibi doğrudan yazılır)
        hub = getattr(self, 'hub', None)
        if hub is not None:
            m = self.launch.get('method', 'wheels')
            kutu = {'pod4': 'hücre', 'pod8': 'hücre', 'tube': 'tüp', 'handheld': 'el fırlatıcısı'}   # §27
            metin = {'armed': {'ramp': 'Kalkış: TAKEOFF + ARM, uçak rampada', 'vehicle': 'Kalkış: TAKEOFF + ARM, uçak araçta', 'wheels': 'Kalkış: TAKEOFF + ARM, pist koşusu',
                               **{k: f'Fırlatıcı: GUIDED + ARM, interceptor {v} içinde' for k, v in kutu.items()}},
                     'launch': {'ramp': f"FIRLATMA (rampa {round(float(extra.get('angle_deg') or 0))}°)", 'vehicle': f"Araç hızlanıyor ({round(float(extra.get('release_kmh') or 0))} km/h)", 'wheels': 'Pist koşusu',
                                **{k: 'FIRLATMA (kapak açıldı)' for k in ('pod4', 'pod8', 'tube')},
                                'handheld': f"FIRLATMA (el · az {round(float(extra.get('aim_az_deg') or 0))}° el {round(float(extra.get('aim_el_deg') or 0))}°)"},
                     'released': {'ramp': 'Uçak rampadan ayrıldı', 'vehicle': 'BIRAKILDI', 'wheels': 'Uçak havalandı', **{k: f'Interceptor {v} dışında' for k, v in kutu.items()}}}.get(phase, {}).get(m, phase)
            if extra.get('speed_kmh') is not None:
                metin += f" · {round(float(extra['speed_kmh']))} km/h"
            try:
                flightsim_hub.drone_hub.global_line(hub, hub.sysid, 'SİM', metin, 'uyari' if phase in ('launch', 'released') else 'bilgi')
                flightsim_hub.drone_hub.console_line(hub, hub.sysid, 'SİM', metin, 'bilgi')
            except Exception:   # noqa: BLE001 — konsol satırı kalkış dizisini bozmasın
                pass

    async def _kalkis_dizisi(self, alt):
        """Yönteme göre kalkış: parametreler → TAKEOFF + ARM (`armed`) → `launch` (rampa: 1,2 sn sonra servo 7 fırlatma tetiği; araç: araç sürüyor;
        tekerlekli: pist koşusu) → telemetri izlenir → `released` (rampa: yer hızı ≥ 8 m/s ya da AGL ≥ 2 m; araç: yer hızı ≥ bırakma hızının %95'i ya da
        AGL ≥ 3 m; tekerlekli: AGL ≥ 1 m). 90 sn'de aşama gelmezse dizi sessizce biter."""
        m = self.launch.get('method', 'wheels')
        te = self.tele
        try:
            if self.sahte is not None:
                self.sahte.komut('takeoff', {'alt': alt})
            else:
                self._param_set(launch_parametreleri(self.launch, alt))
                self._mod_gonder('TAKEOFF')
                await asyncio.sleep(0.3)
                self._gonder(self.mav.command_long_encode(self.sysid, self.comp, 400, 0, 1, 21196, 0, 0, 0, 0, 0))
            self._launch_yay('armed', alt=alt)
            if m == 'ramp':
                await asyncio.sleep(1.2)
                if self.sahte is not None:
                    if self.sahte.kalkis:
                        self.sahte.kalkis['tetik'] = True
                else:
                    self._gonder(self.mav.command_long_encode(self.sysid, self.comp, 183, 0, LAUNCH_SERVO, 1900, 0, 0, 0, 0, 0))   # MAV_CMD_DO_SET_SERVO → mancınık
                self._launch_yay('launch', angle_deg=self.launch.get('angle_deg'))
                kosul = lambda: te.get('groundspeed', 0) >= 8 or te.get('alt_rel', 0) >= 2   # noqa: E731
            elif m == 'vehicle':
                hedef = float(self.launch.get('release_kmh', 70)) / 3.6
                self._launch_yay('launch', release_kmh=self.launch.get('release_kmh'))
                kosul = lambda: te.get('groundspeed', 0) >= hedef * 0.95 or te.get('alt_rel', 0) >= 3   # noqa: E731
            else:
                self._launch_yay('launch')
                kosul = lambda: te.get('alt_rel', 0) >= 1   # noqa: E731
            bitis = time.time() + 90
            while time.time() < bitis and self.state == 'HAZIR':
                if kosul():
                    break
                await asyncio.sleep(0.05)
            else:
                return
            hiz = float(te.get('groundspeed') or 0)
            self._launch_yay('released', speed_kmh=round(hiz * 3.6, 1))
            if m == 'ramp' and self.sahte is None:
                await asyncio.sleep(2.5)
                self._gonder(self.mav.command_long_encode(self.sysid, self.comp, 183, 0, LAUNCH_SERVO, 1100, 0, 0, 0, 0, 0))   # tetik sıfırlanır (yeniden fırlatma)
        except asyncio.CancelledError:
            return
        except Exception as e:   # noqa: BLE001
            self._olay(f'Kalkış dizisi hatası: {e}'[:200], 3)

    async def _dikey_kalkis(self, alt):
        """§25 INTERCEPTOR dikey kalkış: GUIDED → ARM → NAV_TAKEOFF (ArduPlane quadplane GUIDED'da VTOL kalkışı yapar; tailsitter kuyruk üstünden
        dikey tırmanır). ARM'dan hemen sonra gelen NAV_TAKEOFF "Already flying" ile reddedilebildiğinden (ölçüldü) yükseklik artmazsa 2 kez yinelenir."""
        te = self.tele
        try:
            self._mod_gonder('GUIDED')
            await asyncio.sleep(0.4)
            if not te.get('armed'):
                self._gonder(self.mav.command_long_encode(self.sysid, self.comp, 400, 0, 1, 21196, 0, 0, 0, 0, 0))
                await asyncio.sleep(1.0)
            self._olay(f'Dikey kalkış: GUIDED + ARM + NAV_TAKEOFF {alt:g} m (kuyruk üstünden)', 6)
            for _ in range(3):
                self._gonder(self.mav.command_long_encode(self.sysid, self.comp, 22, 0, 0, 0, 0, 0, 0, 0, alt))
                bitis = time.time() + 3.0
                while time.time() < bitis:
                    if float(te.get('alt_rel') or 0) > 1.0:
                        return
                    await asyncio.sleep(0.2)
        except asyncio.CancelledError:
            return
        except Exception as e:   # noqa: BLE001
            self._olay(f'Dikey kalkış hatası: {e}'[:200], 3)

    async def _icept_kalkis(self, alt, aim=None):
        """§27 INTERCEPTOR fırlatıcıdan kalkış: GUIDED + ARM (`armed`) → kapak açılır / NAV_TAKEOFF (`launch`) → dron hücreden/tüpten çıkar
        (AGL ≥ 1,5 m → `released`). Kutu/tüp: dikey NAV_TAKEOFF `alt`. El fırlatıcısı: NAV_TAKEOFF HAND_CLIMB_M (8 m) → QHOVER + RC yaw ile nişan
        azimutuna dönüş (_icept_yon_hizala) → GUIDED + nişan noktasına (aim_noktasi: nişan doğrultusunda 500 m yol, irtifa 30…350 m)
        MAV_CMD_DO_REPOSITION → ArduPlane sabit kanada geçip nişan yönünde uçar (docs §27 ölçümleri).
        Sahte kipte kinematik nişan ışını boyunca tırmanır."""
        te = self.tele
        m = self.launch.get('method')
        hand = m == 'handheld'
        if hand and aim is not None:
            self.launch['aim_az_deg'], self.launch['aim_el_deg'] = float(aim[0]), float(aim[1])
        az, el = float(self.launch.get('aim_az_deg') or 0.0), float(self.launch.get('aim_el_deg') or 55.0)
        wp = flightsim_launcher.aim_noktasi(az, el) if hand else None
        ek = {'aim_az_deg': round(az, 1), 'aim_el_deg': round(el, 1)} if hand else {}
        if self.savunma is not None:
            ek['cell'] = int(self.savunma.icept['used'])   # görev: ateşlenen hücre sırası (1 tabanlı)
        try:
            if self.sahte is not None:
                self.sahte.komut('takeoff', {'alt': wp['alt_m'] if hand else alt, 'aim': (az, el) if hand else None})
                self._launch_yay('armed', alt=alt, **ek)
                await asyncio.sleep(0.4)
                self._launch_yay('launch', **ek)
            else:
                self._mod_gonder('GUIDED')
                await asyncio.sleep(0.4)
                if not te.get('armed'):
                    self._gonder(self.mav.command_long_encode(self.sysid, self.comp, 400, 0, 1, 21196, 0, 0, 0, 0, 0))
                    await asyncio.sleep(1.0)
                self._launch_yay('armed', alt=alt, **ek)
                hedef = flightsim_launcher.HAND_CLIMB_M if hand else alt
                self._olay(f'Fırlatma: {flightsim_launcher.etiket(self.launch)} · GUIDED + ARM + NAV_TAKEOFF {hedef:g} m'
                           + (f' → nişan noktası {wp["horiz_m"]:.0f} m / {wp["alt_m"]:.0f} m' if hand else ''), 6)
                self._launch_yay('launch', **ek)
                for _ in range(3):   # ARM'dan hemen sonra "Already flying" reddi görülebilir (§25) → 3 sn'de yükselmezse yinele
                    self._gonder(self.mav.command_long_encode(self.sysid, self.comp, 22, 0, 0, 0, 0, 0, 0, 0, hedef))
                    bitis = time.time() + 3.0
                    while time.time() < bitis and float(te.get('alt_rel') or 0) <= 1.0:
                        await asyncio.sleep(0.1)
                    if float(te.get('alt_rel') or 0) > 1.0:
                        break
            bitis = time.time() + 40
            while time.time() < bitis and self.state == 'HAZIR' and float(te.get('alt_rel') or 0) < flightsim_launcher.RELEASE_AGL_M:
                await asyncio.sleep(0.05)
            if float(te.get('alt_rel') or 0) < flightsim_launcher.RELEASE_AGL_M:
                return
            self._launch_yay('released', speed_kmh=round(float(te.get('groundspeed') or 0) * 3.6, 1), **ek)
            if hand and self.sahte is None:
                bitis = time.time() + 20
                while time.time() < bitis and self.state == 'HAZIR' and float(te.get('alt_rel') or 0) < flightsim_launcher.HAND_CLIMB_M * 0.7:
                    await asyncio.sleep(0.1)
                # Yön hizalama (ölçüldü: GUIDED askıda CONDITION_YAW etkisiz; tailsitter geçişi askıdaki "VTOL görünümü" yönünde olur — ilk denemede
                # 49° askı yönüyle 120° nişana 71° sapma): QHOVER + RC yaw ile nişan azimutuna döndürülür (ATTITUDE yaw = VTOL görünümü), sonra GUIDED.
                await self._icept_yon_hizala(az)
                self._mod_gonder('GUIDED')
                await asyncio.sleep(0.3)
                c = self.center
                lat, lon = flightsim_launcher.enlem_boylam(float(c['lat']), float(c['lon']), wp['east_m'], wp['north_m'])
                # MAV_CMD_DO_REPOSITION (192), COMMAND_INT, GLOBAL_RELATIVE_ALT_INT; param2 bit 0: GUIDED'a geç
                self._gonder(self.mav.command_int_encode(self.sysid, self.comp, 6, 192, 0, 0, -1, 1, 0, float('nan'), int(lat * 1e7), int(lon * 1e7), float(wp['alt_m'])))
                self._olay(f"Nişan yönüne: az {az:.0f}° · el {el:.0f}° → {wp['horiz_m']:.0f} m ileride {wp['alt_m']:.0f} m (DO_REPOSITION)", 6)
        except asyncio.CancelledError:
            return
        except Exception as e:   # noqa: BLE001
            self._olay(f'Fırlatma dizisi hatası: {e}'[:200], 3)

    async def _icept_yon_hizala(self, az, sure=7.0):
        """§27 el fırlatıcısı: askıda (QHOVER, gaz orta = irtifa tut) RC yaw ile VTOL görünümü yönünü nişan azimutuna getirir; |hata| < 6° ya da süre
        dolunca RC serbest bırakılır. Dönüş: son hata (°)."""
        te = self.tele
        self._mod_gonder('QHOVER')
        await asyncio.sleep(0.3)
        hata = 180.0
        try:
            bitis = time.time() + sure
            while time.time() < bitis and self.state == 'HAZIR':
                yaw = math.degrees(float(te.get('yaw') or 0.0)) % 360.0
                hata = ((az - yaw + 180.0) % 360.0) - 180.0
                if abs(hata) < 6.0:
                    break
                pwm = int(1500 + max(-350.0, min(350.0, hata * 5.0)))
                self._gonder(self.mav.rc_channels_override_encode(self.sysid, self.comp, 1500, 1500, 1500, pwm, 0, 0, 0, 0))
                await asyncio.sleep(0.1)
        finally:
            self._gonder(self.mav.rc_channels_override_encode(self.sysid, self.comp, 0, 0, 0, 0, 0, 0, 0, 0))   # serbest bırak
        self._olay(f'Nişan yönüne dönüldü: hata {hata:+.0f}° (QHOVER + yaw)', 6)
        return hata

    def _icept_kalkis_baslat(self, alt, aim=None):
        if self._launch_task is not None and not self._launch_task.done():
            self._launch_task.cancel()
        self._launch_task = self.loop.create_task(self._icept_kalkis(alt, aim))

    def _dikey_kalkis_baslat(self, alt):
        if self._launch_task is not None and not self._launch_task.done():
            self._launch_task.cancel()
        self._launch_task = self.loop.create_task(self._dikey_kalkis(alt))

    def _kalkis_baslat(self, alt):
        if self._launch_task is not None and not self._launch_task.done():
            self._launch_task.cancel()
        self._launch_task = self.loop.create_task(self._kalkis_dizisi(alt))

    def _akis_iste(self, tam=True):
        """tam: REQUEST_DATA_STREAM 10 Hz (ALL) + HOME_POSITION 5 sn. Sonra ya MAV_CMD_SET_MESSAGE_INTERVAL (MESAJ_ARALIKLARI; copter kabul eder,
        tam 50 Hz) ya da reddedildiyse (`_smi_red`, plane) akış bazlı REQUEST_DATA_STREAM (AKIS_HIZLARI). Sıra önemli: ALL isteği akış
        kovalarını sıfırlar, hızlı aralıklar sonra yazılır. Mission Planner bağlanınca kendi istekleriyle ezebilir → `_dongu` AKIS_YENILE_S'de bir
        yeniden ister."""
        self._akis_son = time.time()
        if tam:
            self._gonder(self.mav.request_data_stream_encode(self.sysid, self.comp, 0, 10, 1))   # MAV_DATA_STREAM_ALL
            self._gonder(self.mav.command_long_encode(self.sysid, self.comp, 511, 0, 242, 5000000, 0, 0, 0, 0, 0))
        if self._smi_red:
            for sid, hz in AKIS_HIZLARI:
                self._gonder(self.mav.request_data_stream_encode(self.sysid, self.comp, sid, hz, 1))
        else:
            for msgid, us in MESAJ_ARALIKLARI:
                self._gonder(self.mav.command_long_encode(self.sysid, self.comp, 511, 0, msgid, us, 0, 0, 0, 0, 0))

    def ruzgar_simdi(self, t=None):
        """§31 anlık rüzgâr (m/s, geldiği yön °): taban + esinti·g(t); t = SITL saati (sn; tele.tbm) — sahte kipte kinematiğin saati."""
        w = self.world
        if t is None:
            t = float(self.tele.get('tbm') or 0) / 1000.0
        hiz = float(w.get('wind_ms') or 0) + float(w.get('wind_gust') or 0) * esinti_carpani(t)
        return round(hiz, 2), float(w.get('wind_dir') or 0)

    def _ruzgar_yaz(self, d=None, yalniz_hiz=False):
        """SITL rüzgârı (§31): SIM_WIND_SPD (esintili anlık), SIM_WIND_DIR (geldiği yön), SIM_WIND_TURB (türbülans). `yalniz_hiz`: esinti döngüsü."""
        d = d or _dialect()
        hiz, yon = self.ruzgar_simdi()
        self.tele['wind_spd'], self.tele['wind_dir'] = hiz, yon
        satirlar = (('SIM_WIND_SPD', hiz),) if yalniz_hiz else (('SIM_WIND_SPD', hiz), ('SIM_WIND_DIR', yon), ('SIM_WIND_TURB', float(self.world.get('wind_turb') or 0)))
        for ad, deger in satirlar:
            self._gonder(self.mav.param_set_encode(self.sysid, self.comp, ad.encode(), float(deger), d.MAV_PARAM_TYPE_REAL32))

    def _esinti_adim(self):
        """_dongu (1 Hz): esinti açıksa SIM_WIND_SPD güncellenir (gerçek SITL); sahte kipte kinematik kendisi hesaplar, yalnız tele alanı."""
        if not float(self.world.get('wind_gust') or 0):
            return
        if self.sahte is not None:
            self.tele['wind_spd'] = round(self.sahte.ruzgar_simdi(), 2)
            return
        if self._heartbeat_alindi and self.state == 'HAZIR':
            self._ruzgar_yaz(yalniz_hiz=True)

    async def ruzgar_degistir(self, p):
        """`wind` komutu (§31): uçuşta rüzgâr — dünya güncellenir, SITL'e yazılır (sahte: kinematik), olay + WS `wind` yayını."""
        yeni = ruzgar_dogrula(p, self.world)
        self.world.update(yeni)
        if self.sahte is not None:
            self.sahte.ruzgar_ayarla(yeni['wind_ms'], yeni['wind_dir'], yeni['wind_gust'], yeni['wind_turb'])
            self.tele['wind_spd'], self.tele['wind_dir'] = round(self.sahte.ruzgar_simdi(), 2), yeni['wind_dir']
        elif self._heartbeat_alindi:
            self._ruzgar_yaz()
        else:
            self.tele['wind_spd'], self.tele['wind_dir'] = self.ruzgar_simdi()
        ek = (f" · esinti {yeni['wind_gust']:g}" if yeni['wind_gust'] else '') + (f" · türbülans {yeni['wind_turb']:g}" if yeni['wind_turb'] else '')
        self._olay(f"Rüzgâr: {yeni['wind_ms']:g} m/s · {yeni['wind_dir']:.0f}°{ek}", 6)
        w = {'wind_ms': yeni['wind_ms'], 'wind_dir': yeni['wind_dir'], 'wind_gust': yeni['wind_gust'], 'wind_turb': yeni['wind_turb']}
        self._yay({'t': 'wind', 'ts': round(time.time(), 3), **w})
        return w

    async def rampa_ayarla(self, p):
        """`launch_aim` komutu (§31): rampa yönü/açısı — yalnız sabit kanat + rampa, ARM ÖNCESİ (disarm, yerde, kalkış dizisi yok).
        Açı → TKOFF_LVL_PITCH (yeniden başlatma yok). Yön → SITL ev/burun yönü yalnız açılışta verilebilir (`--home …,yön`; ArduPlane'de yerdeki
        uçağın yönünü değiştiren parametre/komut yok — SIM_OPOS_HDG de yalnız --home verilmezse okunur) → oturum AYNI ayarlarla yeniden
        konuşlandırılır (reset: SITL yeniden başlar, ~5 sn). Sahte kipte kinematiğin kalkış yönü anında değişir."""
        if self.type != 'sabit_kanat' or self.launch.get('method') != 'ramp':
            raise SimHata('invalid', 'Rampa ayarı yalnız fırlatma rampalı sabit kanatta')
        yeni = rampa_aim_dogrula(p)
        if self.tele.get('armed') or float(self.tele.get('alt_rel') or 0) > 1.0 or self.launch_phase not in (None, 'idle') or \
                (self._launch_task is not None and not self._launch_task.done()):
            raise SimHata('invalid', 'Rampa yalnız kalkıştan önce (DISARM, yerde) ayarlanır')
        eski_yon = kalkis_yonu(self.type, self.launch, self.world)
        eski_aci = float(self.launch.get('angle_deg') or 15)
        self.launch.update(yeni)
        if isinstance(self.world.get('launch'), dict):
            self.world['launch'].update(yeni)
        yon = kalkis_yonu(self.type, self.launch, self.world)
        yon_degisti = abs((yon - eski_yon + 180) % 360 - 180) >= 0.5
        aci_degisti = abs(float(self.launch.get('angle_deg') or 15) - eski_aci) >= 0.25
        yeniden = False
        if self.sahte is not None:
            self.sahte.heading = math.radians(yon)
            self.sahte.launch = dict(self.launch)
        elif aci_degisti and self._heartbeat_alindi:
            self._param_set((('TKOFF_LVL_PITCH', float(self.launch['angle_deg'])),))
        self._olay(f"Rampa: yön {yon:.0f}° · açı {float(self.launch['angle_deg']):g}°" + (' — yeniden konuşlandırılıyor (SITL yönü)' if yon_degisti and self.sahte is None else ''), 6)
        self._yay({'t': 'launch_cfg', 'ts': round(time.time(), 3), 'launch': dict(self.launch), 'redeploy': bool(yon_degisti and self.sahte is None)})
        if yon_degisti and self.sahte is None and self.state == 'HAZIR':
            yeniden = True
            await self.reset()
        return {'launch': dict(self.launch), 'heading': round(yon, 2), 'redeploy': yeniden}

    def _tele_yay(self, tbm=None, zorla=False):
        """`tele` yayını: gerçek SITL'de her ATTITUDE'da (ATTITUDE akmıyorsa GLOBAL_POSITION_INT'te); kapı SITL zamanıyla (TELE_TBM_KAPI ms) —
        TCP parçasında birlikte gelen ardışık kareler düşmez, 66 Hz akış ~50 Hz'e iner. Sahte kipte adım başına (zorla).
        `ts` sunucu alım zamanı (Unix sn), `tbm` SITL time_boot_ms (sahte: oturum ms)."""
        self._guc_adim(tbm)   # §23: izleyici olmasa da yakıt/batarya simülasyon zamanıyla entegre edilir
        if not self.viewers:
            return
        now = time.time()
        if not zorla:
            if tbm is not None:
                if tbm - self._tele_tbm < TELE_TBM_KAPI:
                    return
                if self.guc.speedup > 1.0 and now - self._tele_son < TELE_MIN_ARALIK * 0.9:
                    return   # hızlandırılmış simülasyon: SITL saati hızlı akar; WS yayını gerçek zamanda 50 Hz tavanında kalır
            elif now - self._tele_son < TELE_MIN_ARALIK * 0.9:
                return
        self._tele_tbm = tbm if tbm is not None else self.tele.get('tbm', 0)
        self._tele_son = now
        self._yay({'t': 'tele', 'ts': round(now, 3), **self.tele, **self.guc.tele_alanlari(), 'motor_cut': bool(self.motor_cut), 'gcs_connected': self.gcs_addr is not None,
                   'gcs_addr': f'{self.gcs_addr[0]}:{self.gcs_addr[1]}' if self.gcs_addr else None})

    def _guc_adim(self, tbm):
        """Yakıt/batarya adımı (flightsim_power.GucDurumu): SITL time_boot_ms farkıyla (speedup'ta hızlı akar). Biten kaynak → kırmızı olay +
        WS `warn` (kind fuel_empty | elec_empty); uçuş sürer (kullanıcı kararı: yalnız uyarı)."""
        t = tbm if tbm is not None else self.tele.get('tbm')
        if self.hedef_iz is not None and t is not None:
            try:
                self._hedef_adim(t)
            except Exception:   # noqa: BLE001 — hedef izleme telemetriyi bozmasın
                pass
        if self.savunma is not None and t is not None:
            try:
                self._savunma_adim(t)
            except Exception:   # noqa: BLE001 — görev izleme telemetriyi bozmasın
                pass
        try:
            biten = self.guc.adim(self.tele, t)
        except Exception:   # noqa: BLE001 — gösterge hatası telemetriyi bozmasın
            return
        for k in biten:
            if k == 'elec' and self.savunma is not None:
                self._savunma_dustu('battery')
            if k == 'fuel':
                metin = f'YAKIT BİTTİ — {self.guc.fuel_l0:g} L tükendi ({self.guc.dist_m / 1000:.1f} km); motor gerçek uçakta dururdu, simülasyon sürüyor'
            else:
                metin = f'ELEKTRONİK BATARYA BİTTİ — {self.guc.wh_cap:.0f} Wh tükendi ({self.guc.time_s / 60:.0f} dk); gerçek uçakta kumanda/telemetri kesilirdi, simülasyon sürüyor'
            self._olay(metin, 2)
            self._yay({'t': 'warn', 'kind': f'{k}_empty', 'text': metin, 'ts': time.time()})

    # ---- §24 hedefler ----
    def _hedef_adim(self, tbm):
        """Önleme izleme: hedef zamanı t = tbm/1000 (SITL saati); oyuncu dronu yerel ENU'da; yarıçap içine giriş → olay şeridi + WS `target`."""
        te = self.tele
        if te.get('lat') is None:
            return
        c = self.center
        x, y = flightsim_targets.yerel(float(c['lat']), float(c['lon']), te['lat'], te['lon'])
        for o in self.hedef_iz.adim(float(tbm) / 1000.0, x, y, float(te.get('alt_rel') or 0), bool(te.get('armed'))):
            ek = f" · ilk önleme {o['after_s']:g} sn" if o['first'] else f" · {o['n']}. geçiş"
            self._yay({'t': 'target', 'kind': 'intercept', **o, 'tt': round(float(tbm) / 1000.0, 3), 'ts': round(time.time(), 3),
                       'state': self.hedef_iz.ozet()})
            self._olay(f"ÖNLEME · {o['name']} · {o['dist_m']:g} m{ek}", 5)

    # ---- §26 "Yer kontrolünü koru" ----
    def _savunma_adim(self, tbm):
        """Görev saati (taban + tbm/1000) ile tehditler: doğuş, dalga, önleme (yarıçap içinde ARM'lı interceptor), sızma (istasyon hasarı), bitiş.
        Her olay WS `{t:'defend', kind, …, state}` + olay şeridi (Türkçe; ön yüz kendi dilinde yazar)."""
        te = self.tele
        if te.get('lat') is None:
            return
        c = self.center
        x, y = flightsim_targets.yerel(float(c['lat']), float(c['lon']), te['lat'], te['lon'])
        sv = self.savunma
        for o in sv.adim(tbm, x, y, float(te.get('alt_rel') or 0), bool(te.get('armed'))):
            k = o['kind']
            ev = dict(o)
            if 't' in ev:   # kayıt zamanı (görev saati) → `tt`; `t` WS çerçeve türüdür
                ev['tt'] = ev.pop('t')
            self._yay({**ev, 't': 'defend', 'ts': round(time.time(), 3), 'state': sv.durum()})
            if k == 'wave':
                self._olay(f"DALGA {o['wave']}/{o['waves']} — {o['count']} tehdit yer kontrol istasyonuna yöneldi", 4)
            elif k == 'kill':
                self._olay(f"TEHDİT ÖNLENDİ · {o['name']} · istasyona {o['station_m'] / 1000:.2f} km · {o['ttk_s']:g} sn", 5)
            elif k == 'leak':
                self._olay(f"İSTASYON VURULDU · {o['name']} · −{o['damage']:g} · sağlık %{o['health']:g}", 2)
            elif k == 'end':
                r = o['result']
                self._olay(f"GÖREV {'BAŞARILI' if o['success'] else 'BAŞARISIZ'} · önlenen {len(r['kills'])}/{r['spawned']} · sağlık %{r['health']:g} · "
                           f"{r['score']} puan · {r['rank_name']}", 5 if o['success'] else 2)
        n = len(getattr(self.gorev, 'crashes', None) or [])
        if n > self._savunma_crash:
            self._savunma_crash = n
            self._savunma_dustu('crash')

    def _savunma_dustu(self, neden):
        sv = self.savunma
        if sv is None or not sv.dustu(neden):
            return
        kalan = sv.icept['total'] - sv.icept['used']
        metin = (f"INTERCEPTOR {'DÜŞTÜ' if neden == 'crash' else 'BATARYASI BİTTİ'} — "
                 + (f'sıradakini fırlatın ({kalan} kaldı)' if kalan > 0 else 'rafta interceptor kalmadı'))
        self._olay(metin, 2)
        self._yay({'t': 'defend', 'kind': 'down', 'reason': neden, 'remaining': kalan, 'ts': round(time.time(), 3), 'state': sv.durum()})

    async def _savunma_konuslandir(self):
        """Sıradaki interceptor: aynı SITL aracı yeniden başlatılır (pad'de doğar); ARM edilmiş olan harcanır; yeni araç için güç durumu taze
        (batarya dolu, seçili simülasyon hızı korunur). Görev saati SavunmaGorevi.zaman tabanıyla sürer."""
        sv = self.savunma
        try:
            harcandi = sv.konuslandir()
        except flightsim_gcs.GcsHata as e:
            raise SimHata('invalid', str(e))
        sp = self.guc.speedup
        self.guc = flightsim_power.GucDurumu(self.power)
        self.guc.hiz_ayarla(sp)
        self._savunma_crash = len(getattr(self.gorev, 'crashes', None) or [])
        kalan = sv.icept['total'] - sv.icept['used']
        self._olay(f"Sıradaki interceptor konuşlandırıldı: #{sv.icept['used']}/{sv.icept['total']} ({kalan} rafta)" if harcandi
                   else 'Interceptor pad\'e yeniden konuşlandırıldı (uçmadığı için harcanmadı)', 6)
        self._yay({'t': 'defend', 'kind': 'next', 'spent': harcandi, 'ts': round(time.time(), 3), 'state': sv.durum()})
        await self.reset()
        return harcandi

    def _adsb_gonder(self):
        """Hedefleri Mission Planner haritasına trafik olarak (ADSB_VEHICLE, kaynak sysid 1 / comp 156 MAV_COMP_ID_ADSB; yalnız GCS'ye — SITL'e gitmez)."""
        if not self.hedefler or self.gcs_addr is None:
            return
        if getattr(self, 'mav_adsb', None) is None:
            self.mav_adsb = _dialect().MAVLink(None, srcSystem=self.sysid or 1, srcComponent=flightsim_targets.ADSB_COMP)
        c = self.center
        t = float(self.tele.get('tbm') or 0) / 1000.0
        alt0 = (self.tele.get('home') or {}).get('alt')
        if alt0 is None:
            alt0 = float(c.get('alt') or EV_IRTIFA)
        for a in flightsim_targets.adsb_alanlari(self.hedefler, float(c['lat']), float(c['lon']), alt0, t):
            try:
                m = self.mav_adsb.adsb_vehicle_encode(*a)
                self._gcs_gonder(m.pack(self.mav_adsb))
                self.mav_adsb.seq = (self.mav_adsb.seq + 1) % 256
            except Exception:   # noqa: BLE001
                continue

    def _gcs_heartbeat(self):
        self._gonder(self.mav.heartbeat_encode(6, 8, 0, 0, 0))   # MAV_TYPE_GCS, MAV_AUTOPILOT_INVALID

    def _motor_kes(self, on, olay=True):
        """Motor kesme / geri verme (yalnız uçak tipleri; çağıran doğrular). Gerçek SITL: MAV_CMD_DO_AUX_FUNCTION 31 MOTOR_ESTOP HIGH (2) / LOW (0) —
        ARM, kip ve HOME korunur, yüzeyler çalışır (modül başı ölçümler). Sahte kip: SahteKinematik süzülmesi. Durum değiştiyse olay şeridi +
        harekât paneli konsolu: "MOTOR KESİLDİ — süzülüyor" / "Motor geri verildi"."""
        on = bool(on)
        degisti = on != self.motor_cut
        if self.sahte is not None:
            self.sahte.komut('motor_cut', {'on': on})
        elif self._heartbeat_alindi:
            self._gonder(self.mav.command_long_encode(self.sysid, self.comp, MAV_CMD_DO_AUX_FUNCTION, 0, MOTOR_ESTOP_AUX, 2 if on else 0, 0, 0, 0, 0, 0))
            self._motor_cut_istek = (on, time.time())
        self.motor_cut = on
        if on:
            self.tele['throttle'] = 0
        if degisti and olay:
            metin = 'MOTOR KESİLDİ — süzülüyor' if on else 'Motor geri verildi'
            self._olay(metin, 4 if on else 6)
            hub = getattr(self, 'hub', None)
            if hub is not None:
                try:
                    flightsim_hub.drone_hub.console_line(hub, hub.sysid, 'SİM', metin, 'uyari' if on else 'bilgi')
                except Exception:   # noqa: BLE001 — konsol satırı komutu bozmasın
                    pass
        return on

    def zorla_disarm(self):
        """Çarpışma kaydı sonrası (§18): sahte kinematik sıfırlanır; gerçek SITL'e zorla disarm (400, magic 21196). Kırmızı olay satırı.
        Motor kesmesi de kalkar (araç yerde/disarm; sonraki ARM'ı MOTOR_ESTOP engellemesin)."""
        if self.motor_cut:
            self._motor_kes(False, olay=False)
        if self.sahte is not None:
            self.sahte.komut('crash', {})
        elif self._heartbeat_alindi:
            self._gonder(self.mav.command_long_encode(self.sysid, self.comp, 400, 0, 0, 21196, 0, 0, 0, 0, 0))
        self._olay('ÇARPIŞMA — araç zorla disarm edildi', 2)
        if self.savunma is not None:
            self._savunma_crash = len(getattr(self.gorev, 'crashes', None) or [])
            self._savunma_dustu('crash')

    # ---- komutlar ----
    async def komut(self, name, params, kaynak=None):
        """REST ve WS `cmd`: sözleşme §2. Hatalı ad/parametre → SimHata('invalid')."""
        p = params if isinstance(params, dict) else {}
        if name not in KOMUTLAR:
            raise SimHata('invalid', f'Bilinmeyen komut: {name}')
        if name == 'rc':
            p = {'ch': _rc_dogrula(p.get('ch'))}
        elif name == 'takeoff':
            if self.type in ROVER_TIPLERI:   # §31: kara aracı kalkmaz — ARM + kip (MANUAL sürüş / AUTO görev)
                raise SimHata('invalid', 'Kara aracında kalkış yok: ARM edip MANUAL ile sürün ya da AUTO ile görevi başlatın')
            alt = p.get('alt')
            if alt is None:
                alt = 50.0 if self.type in PLANE_TIPLERI else 10.0
            if isinstance(alt, bool) or not isinstance(alt, (int, float)) or not (1 <= alt <= 1000):
                raise SimHata('invalid', 'takeoff.alt 1…1000 m olmalı')
            try:   # §27 el fırlatıcısı: canlı nişan {az_deg, el_deg} (sınır denetimi; yöntem handheld değilse yok sayılır)
                aim = flightsim_launcher.aim_dogrula(p.get('aim'))
            except flightsim_launcher.LauncherHata as e:
                raise SimHata('invalid', str(e))
            p = {'alt': float(alt), 'aim': aim}
        elif name == 'mode':
            mode = str(p.get('mode') or '').upper()
            if mode not in _modlar(self.vtype if self.vtype is not None else _varsayilan_vtype(self.type)):
                raise SimHata('invalid', f'Bilinmeyen uçuş modu: {mode or "-"}')
            p = {'mode': mode}
        elif name == 'speed':
            f = p.get('factor')
            if isinstance(f, bool) or not isinstance(f, (int, float)) or float(f) not in [float(x) for x in flightsim_power.SPEEDUPS]:
                raise SimHata('invalid', f"speed.factor {' | '.join(str(x) for x in flightsim_power.SPEEDUPS)} olmalı")
            p = {'factor': float(f)}
        elif name == 'motor_cut':
            if not isinstance(p.get('on'), bool):
                raise SimHata('invalid', 'motor_cut.on doğru/yanlış (true/false) olmalı')
            if self.type in ROVER_TIPLERI:
                raise SimHata('invalid', 'Kara aracında motor kesme yok: durdurmak için HOLD kipi ya da DISARM kullanın')
            if self.type not in PLANE_TIPLERI:   # kopter: kanat yok, motor kesmek düşürür → ön yüz DISARM'ı onayla göndermeli
                raise SimHata('invalid', 'Motor kesme yalnız uçak tiplerinde (sabit kanat / VTOL / INTERCEPTOR); kopterde havada DISARM aracı düşürür')
            p = {'on': p['on']}
        if name == 'wind':   # §31 uçuşta rüzgâr (hazırlık sırasında da dünyaya yazılır; SITL kalp atışında uygulanır)
            return {'ok': True, 'wind': await self.ruzgar_degistir(p)}
        if name == 'launch_aim':   # §31 rampa yön/açı (ARM öncesi; yön değişirse SITL yeniden konuşlandırılır)
            return {'ok': True, **await self.rampa_ayarla(p)}
        if name == 'camera':   # §22.3: ön yüz türü değiştirdi → oturum (ve kapanışta kayıt satırı) son türü saklar; SITL'e gitmez
            if p.get('type') is None:
                raise SimHata('invalid', 'camera.type gerekir')
            self.camera = kamera_dogrula(p.get('type'))
            return {'ok': True, 'camera': self.camera}
        if name == 'defend':   # §26: {action: 'next'} → sıradaki interceptor (aynı SITL aracı yeniden konuşlandırılır)
            if self.savunma is None:
                raise SimHata('invalid', 'Bu oturumda "Yer kontrolünü koru" görevi yok')
            if p.get('action') != 'next':
                raise SimHata('invalid', "defend.action 'next' olmalı")
            harcandi = await self._savunma_konuslandir()
            return {'ok': True, 'spent': harcandi, 'defend': self.savunma.durum()}
        if name == 'reset':
            if self.savunma is not None:   # §26: görevde "Sıfırla" = yeniden konuşlandırma (uçmuş interceptor harcanır; kalmadıysa 400)
                await self._savunma_konuslandir()
                return {'ok': True}
            await self.reset()
            return {'ok': True}
        if self.state != 'HAZIR':
            raise SimHata('invalid', 'Oturum hazır değil')
        if name == 'speed':   # §23 simülasyon hızı: SITL SIM_SPEEDUP canlı (PARAM_SET); telemetri/kayıt/.bin SITL zamanıyla, video gerçek zaman
            self.speedup_istek = p['factor']
            if self.sahte is not None:
                self.sahte.speedup = p['factor']
                self.guc.hiz_ayarla(p['factor'])
            else:
                if not self._heartbeat_alindi:
                    raise SimHata('invalid', 'SITL henüz kalp atışı göndermedi')
                self._param_set(((flightsim_power.SIM_SPEEDUP, p['factor']),))
            self._olay(f'Simülasyon hızı {p["factor"]:g}× (SITL zamanı; yakıt/batarya ve .bin kaydı simülasyon zamanıyla, video gerçek zamanda; Mission Planner da hızlı görür)', 6)
            return {'ok': True, 'factor': p['factor']}
        if name == 'motor_cut':
            if self.sahte is None and not self._heartbeat_alindi:
                raise SimHata('invalid', 'SITL henüz kalp atışı göndermedi')
            return {'ok': True, 'motor_cut': self._motor_kes(p['on'])}
        if name in ('arm', 'takeoff') and self.motor_cut:   # ARM / kalkış motoru geri verir (MOTOR_ESTOP açıkken ArduPlane ARM'ı reddeder)
            self._motor_kes(False)
        if name == 'takeoff' and self.type == 'sabit_kanat' and (self.sahte is not None or self._heartbeat_alindi):
            self._kalkis_baslat(p['alt'])   # yönteme göre dizi (§13): armed → launch → released olayları
            return {'ok': True}
        if name == 'takeoff' and self.type in DIKEY_TIPLER and flightsim_launcher.firlatici_mi(self.launch.get('method')) and (self.sahte is not None or self._heartbeat_alindi):
            self._icept_kalkis_baslat(p['alt'], p.get('aim'))   # §27 fırlatıcıdan: armed → launch (kapak/tüp) → released; el fırlatıcısında nişan yönüne
            return {'ok': True}
        if name == 'takeoff' and self.type in DIKEY_TIPLER and self.sahte is None and self._heartbeat_alindi:
            self._dikey_kalkis_baslat(p['alt'])   # §25: GUIDED + ARM + NAV_TAKEOFF (VTOL kalkışı; kuyruk üstünden dikey)
            return {'ok': True}
        if name == 'crash':   # §18: 3B algılaması — bina/su (ve sahte kip) kesin → kayıt + zorla disarm; gerçek SITL'de arazi ADAY (SITL "Hit ground" teyidi bekler)
            kayit, disarm = self.gorev.ucboyut_bildirim(p.get('kind') or 'manual', p.get('speed'), p)
            if disarm:
                self.zorla_disarm()
            return {'ok': True, 'crash': kayit is not None, 'pending': kayit is None and not disarm}
        if self.sahte is not None:
            self.sahte.komut(name, p)
            return {'ok': True}
        if not self._heartbeat_alindi:
            raise SimHata('invalid', 'SITL henüz kalp atışı göndermedi')
        enc = self.mav
        s, c = self.sysid, self.comp
        if name == 'arm':
            self._gonder(enc.command_long_encode(s, c, 400, 0, 1, 21196, 0, 0, 0, 0, 0))
        elif name == 'disarm':
            self._gonder(enc.command_long_encode(s, c, 400, 0, 0, 21196, 0, 0, 0, 0, 0))
        elif name == 'mode':
            self._mod_gonder(p['mode'])
        elif name == 'takeoff':
            if self.type not in PLANE_TIPLERI and (self.tele.get('mode') or '').upper() != 'GUIDED':
                self._mod_gonder('GUIDED')   # kopter NAV_TAKEOFF'u yalnız GUIDED'da kabul eder; uçak TAKEOFF moduna geçer
            self._gonder(enc.command_long_encode(s, c, 22, 0, 0, 0, 0, 0, 0, 0, p['alt']))   # MAV_CMD_NAV_TAKEOFF
        elif name == 'rtl':
            self._gonder(enc.command_long_encode(s, c, 20, 0, 0, 0, 0, 0, 0, 0, 0))     # MAV_CMD_NAV_RETURN_TO_LAUNCH
        elif name == 'set_home':
            if p.get('lat') is not None and p.get('lon') is not None:
                try:
                    lat, lon, alt = float(p['lat']), float(p['lon']), float(p.get('alt') or self.tele.get('alt_msl') or 0)
                except (TypeError, ValueError):
                    raise SimHata('invalid', 'set_home lat/lon/alt sayı olmalı')
                if not (-90 <= lat <= 90 and -180 <= lon <= 180):
                    raise SimHata('invalid', 'set_home lat/lon aralık dışı')
                self._gonder(enc.command_long_encode(s, c, 179, 0, 0, 0, 0, 0, lat, lon, alt))   # MAV_CMD_DO_SET_HOME (verilen konum)
            else:
                self._gonder(enc.command_long_encode(s, c, 179, 0, 1, 0, 0, 0, 0, 0, 0))         # mevcut konum
        elif name == 'rc':
            self._gonder(enc.rc_channels_override_encode(s, c, *p['ch']))
        return {'ok': True}

    # ---- §14: harekât paneli (hub) komutları — drone_hub._dispatch → SimBridge.acommand → buraya ----
    async def hub_komut(self, name, params):
        """Hub komut sözleşmesi (drone_hub.CMD_NAMES): {'ok', 'result'} | {'ok': False, 'error'}. Gerçek SITL'de MavKomut (pymavlink + ACK),
        sahte kipte kinematiğe eşleme. Hata metninde 'MAV_RESULT' varsa hub ayrıca konsol satırı yazmaz (COMMAND_ACK satırı düşer)."""
        p = params if isinstance(params, dict) else {}
        if name in ('link_open', 'link_close', 'disconnect'):
            return {'ok': True, 'result': {'sim': True}}
        if self.state != 'HAZIR':
            return {'ok': False, 'error': 'Oturum hazır değil (SITL açılıyor ya da hata)'}
        try:
            if name in ('arm', 'takeoff') and self.motor_cut and (self.sahte is not None or self._heartbeat_alindi):
                self._motor_kes(False)   # panel / SIMUMAV ARM'ı da motoru geri verir (MOTOR_ESTOP açıkken ArduPlane ARM'ı reddeder)
            if name.startswith('mission_'):
                self.gorev.transfer()   # §18: kendi görev transferimiz — MP indirme tetiği bastırılır
            if self.sahte is not None:
                res = self._sahte_hub_komut(name, p)
            else:
                if not self._heartbeat_alindi:
                    return {'ok': False, 'error': 'SITL henüz kalp atışı göndermedi'}
                res = await self.komutcu.execute(name, p)
            if name == 'mission_upload':
                self._rota_ayarla(flightsim_hub.rota_noktalari(p.get('items') or [], offset=int(res.get('offset') or 0)), source='hepgo', total=res.get('uploaded'))
            elif name == 'mission_clear':
                self._rota_ayarla([], source='hepgo')
            return {'ok': True, 'result': res}
        except (KeyError, TypeError, ValueError) as e:
            return {'ok': False, 'error': f'Geçersiz parametre: {e}'}
        except Exception as e:   # noqa: BLE001
            return {'ok': False, 'error': str(e)[:300]}

    def _rota_ayarla(self, points, source='hepgo', total=None):
        """SITL'deki görev değişti (HEPGO yüklemesi ya da Mission Planner'dan indirilen görev): 3B dünyaya rota ({t:'route', points, source, home,
        current, end, landing_circle_m}; hello/to_dict `route` + `mission`), görev bitiş noktası kaydı (§18) ve olay şeridine bildirim."""
        onceki = len(self.route)
        self.route = list(points or [])
        self.gorev.rota(self.route, source, total)
        self._yay({'t': 'route', 'points': self.route, **self.gorev.yayin_alanlari()})
        kaynak = "Mission Planner'dan" if source == 'mp' else 'HEPGO panelinden'
        if self.route:
            self._olay(f'{kaynak} görev yüklendi: {len(self.route)} nokta', 6)
        elif onceki:
            self._olay(f'{kaynak} görev temizlendi', 6)

    def _sahte_hub_komut(self, name, p):
        """Sahte kinematikte hub komutları: arm/disarm/set_mode/takeoff/land/rtl/goto/set_home → SahteKinematik.komut; görev/parametre
        komutları bellek içi (mission_count MISSION_CURRENT ile hub'a yansır)."""
        k = self.sahte
        modlar = _modlar(_varsayilan_vtype(self.type))
        if name == 'arm':
            k.komut('arm', {}); return {'ack': 0}
        if name == 'disarm':
            k.komut('disarm', {}); return {'ack': 0}
        if name == 'set_mode':
            mode = str(p.get('mode') or '').upper()
            if mode not in modlar:
                raise RuntimeError(f'Bilinmeyen uçuş modu: {mode}')
            if mode == 'AUTO' and not self._sahte_gorev:
                raise RuntimeError('Dron komutu reddetti (MAV_RESULT 4): yüklü görev yok')
            k.komut('mode', {'mode': mode}); return {'mode': mode}
        if name == 'takeoff':
            if self.type in ROVER_TIPLERI:
                raise RuntimeError('Kara aracında kalkış yok (MAV_RESULT 3)')
            k.komut('takeoff', {'alt': float(p.get('alt_rel_m') or 30)}); return {'ack': 0}
        if name == 'land':
            if self.type in ROVER_TIPLERI:   # ArduRover'da LAND yok: dur (HOLD)
                k.komut('mode', {'mode': 'HOLD'}); return {'mode': 'HOLD'}
            k.komut('mode', {'mode': 'QLAND' if self.type == 'vtol' else 'LAND'}); k.eve = True; return {'mode': 'LAND'}
        if name == 'rtl':
            k.komut('rtl', {}); return {'mode': 'RTL'}
        if name in ('goto', 'altitude_change'):
            if not k.armed:
                raise RuntimeError('Dron komutu reddetti (MAV_RESULT 1): araç yerde')
            if 'GUIDED' in modlar:
                k.komut('mode', {'mode': 'GUIDED'})
            k.hedef_alt = float(p.get('alt_rel_m') or k.hedef_alt)
            return {'lat': p.get('lat'), 'lon': p.get('lon'), 'alt_rel_m': k.hedef_alt}
        if name == 'set_home':
            k.komut('set_home', p); return {'ack': 0}
        if name == 'mission_upload':
            items = p.get('items') or []
            if not isinstance(items, list) or len(items) > 500:
                raise RuntimeError('items listesi gerekli (≤ 500)')
            self._sahte_gorev = [dict(i) for i in items]
            return {'count': len(items), 'uploaded': len(items) + 1, 'offset': 1}
        if name == 'mission_download':
            return {'items': list(self._sahte_gorev)}
        if name == 'mission_clear':
            self._sahte_gorev = []; return {'cleared': True}
        if name == 'mission_set_current':
            return {'seq': int(p.get('seq') or 0)}
        if name == 'mission_start':
            if not k.armed:
                raise RuntimeError('Dron komutu reddetti (MAV_RESULT 4): araç ARM değil')
            k.komut('mode', {'mode': 'AUTO'}); return {'ack': 0}
        if name == 'param_set':
            self._sahte_params[str(p['name'])] = float(p['value'])
            if self.param_izleyici is not None:   # sahte yankı: gerçek SITL'de PARAM_VALUE _isle'den gelir
                self.param_izleyici.param_value(str(p['name']), float(p['value']), 9)
            return {'name': p['name'], 'value': float(p['value']), 'type': 9}
        if name == 'param_get':
            return {'name': p['name'], 'value': self._sahte_params.get(str(p['name']), 0.0), 'type': 9}
        if name == 'param_list':
            return {'requested': True}
        if name == 'reboot':
            raise RuntimeError('Simülatörde yeniden başlatma için "Sıfırla" kullanın')
        raise RuntimeError(f'Desteklenmeyen komut: {name}')

    def _sahte_hub_cerceve(self, n):
        """Sahte kip (HEPGO_SITL=0): kinematikten MAVLink çerçeveleri üretip hub'a verir (10 Hz konum/yönelim/HUD, 1 Hz HEARTBEAT/SYS_STATUS/GPS,
        5 sn HOME; MISSION_CURRENT yüklü görev sayısıyla) — harekât paneli SITL'siz de dolar (testler)."""
        if self.hub is None or self.sahte is None:
            return
        k, te, enc = self.sahte, self.tele, self.mav_arac
        d = _dialect()
        vt = _varsayilan_vtype(self.type)
        modlar = _modlar(vt)
        tbm = int(k.sure_ms)
        out = []
        if n % 50 == 0:
            out.append(enc.heartbeat_encode(vt, 3, (128 if k.armed else 0) | 1, modlar.get(k.mode, 0), 4))
            bits = sum(d.__dict__[x] for x in ('MAV_SYS_STATUS_SENSOR_3D_GYRO', 'MAV_SYS_STATUS_SENSOR_3D_ACCEL', 'MAV_SYS_STATUS_SENSOR_3D_MAG',
                                                'MAV_SYS_STATUS_SENSOR_ABSOLUTE_PRESSURE', 'MAV_SYS_STATUS_SENSOR_GPS', 'MAV_SYS_STATUS_SENSOR_RC_RECEIVER',
                                                'MAV_SYS_STATUS_AHRS', 'MAV_SYS_STATUS_SENSOR_BATTERY', 'MAV_SYS_STATUS_PREARM_CHECK'))
            out.append(enc.sys_status_encode(bits, bits, bits, 300, int(k.batt_v * 1000), 1500 if k.armed else 40, int(te.get('batt_pct') or 0), 0, 0, 0, 0, 0, 0))
            out.append(enc.gps_raw_int_encode(tbm * 1000, 3, int(k.lat * 1e7), int(k.lon * 1e7), int((k.alt0 + k.alt_rel) * 1000), 80, 100, 0, 0, 12))
            out.append(enc.mission_current_encode(0, len(self._sahte_gorev)))
            h = k.home
            out.append(enc.home_position_encode(int(h['lat'] * 1e7), int(h['lon'] * 1e7), int(float(h.get('alt') or 0) * 1000), 0, 0, 0, [1, 0, 0, 0], 0, 0, 0))
        if n % 25 == 0:
            out.append(enc.rc_channels_encode(tbm, 8, *k.rc, *([0] * 10), 200))
        if n % 5 == 0:
            hs = math.hypot(k.vn, k.ve)
            out.append(enc.global_position_int_encode(tbm, int(k.lat * 1e7), int(k.lon * 1e7), int((k.alt0 + k.alt_rel) * 1000), int(k.alt_rel * 1000),
                                                      int(k.vn * 100), int(k.ve * 100), int(k.vd * 100), int((math.degrees(k.yaw) % 360) * 100)))
            out.append(enc.attitude_encode(tbm, k.roll, k.pitch, k.yaw, k.rs, k.ps, k.ys))
            out.append(enc.vfr_hud_encode(k.hava_hizi(), hs, int(math.degrees(k.yaw) % 360), int(k.throttle), k.alt0 + k.alt_rel, -k.vd))
        if not out:
            return
        buf = b''
        for m in out:
            try:
                buf += m.pack(enc)
                enc.seq = (enc.seq + 1) % 256
            except Exception:   # noqa: BLE001
                continue
        if buf:
            self.hub.feed(buf)

    def _mod_gonder(self, mode):
        mode = mode.upper()
        modlar = _modlar(self.vtype if self.vtype is not None else _varsayilan_vtype(self.type))
        if mode not in modlar:
            raise SimHata('invalid', f'Bilinmeyen uçuş modu: {mode}')
        self._gonder(self.mav.command_long_encode(self.sysid, self.comp, 176, 0, 1, modlar[mode], 0, 0, 0, 0, 0))   # MAV_CMD_DO_SET_MODE

    async def rc(self, ch):
        """WS `rc` (en çok ~40 Hz; fazlası atılır). 8×0 = override serbest bırakma: hız sınırı uygulanmaz, her zaman iletilir."""
        now = time.time()
        serbest = isinstance(ch, (list, tuple)) and len(ch) == 8 and not any(ch)
        if not serbest and now - self._rc_son < RC_HZ_MIN_ARALIK:
            return
        self._rc_son = now
        await self.komut('rc', {'ch': ch})

    async def reset(self):
        """SITL'i aynı ayarlarla yeniden başlatır (sahte kipte kinematiği sıfırlar)."""
        if self.state == 'KAPANDI':
            raise SimHata('invalid', 'Oturum kapandı')
        self._olay('Sıfırlanıyor', 6)
        self._durum('BASLIYOR')
        if self._launch_task is not None and not self._launch_task.done():
            self._launch_task.cancel()
        self.launch_phase = None
        self.motor_cut, self._motor_cut_istek = False, None   # yeni SITL / sıfır kinematik: MOTOR_ESTOP süreç belleğindeydi (yeni süreçte kapalı)
        self.guc.sifirla_zaman()   # §23: yeni SITL saati sıfırdan; yakıt/batarya seviyeleri korunur (tank/batarya değişmez)
        if self.sahte is not None:
            self.sahte.sifirla()
            if self.yonetici.sahte_tcp_port and self._tcp_w is None:
                await self._sitl_ac()
            else:
                await self._kayitli_oku()   # gerçek SITL'de _sitl_ac okur; sahte kipte TCP açık kalır (kayıtlı parametre sınaması)
                self._durum('HAZIR')
            return
        await self._tcp_kapat()
        await self.loop.run_in_executor(None, drone_sitl.YONETICI.durdur, self.kimlik)
        self.tele.update(mode=None, armed=False, alt_rel=0.0, home=None)
        self._tele_tbm, self._smi_red, self._att_son = -10 ** 9, False, 0.0   # yeni SITL: zaman damgası sıfırdan başlar
        if self.route:
            self._rota_ayarla([], source=self.gorev.source or 'hepgo')   # yeni SITL'de görev yok
        await self._sitl_ac()

    # ---- yaşam döngüsü ----
    async def run(self):
        self.loop = asyncio.get_running_loop()
        yayin = None
        try:
            try:
                await self._udp_ac()
            except SimHata as e:
                self.sitl['error'] = str(e)
                self._olay(str(e), 2)
                self._durum('HATA')
            if self.udp_port is not None:
                flightsim_hub.attach(self)   # §14: harekât paneli köprüsü (SITL açılmadan önce; açılış/hata olayları konsola düşer)
                await self._sitl_ac()   # gerçek: SITL + TCP; sahte: TCP yalnız sahte_tcp_port verilmişse
            yayin = self.loop.create_task(self._yayin())
            await self._dongu()
        except asyncio.CancelledError:
            pass
        except Exception as e:   # noqa: BLE001
            self.sitl['error'] = f'Oturum hatası: {e}'[:300]
            self._olay(self.sitl['error'], 2)
        finally:
            if yayin is not None:
                yayin.cancel()
            await self._temizle()

    async def _yayin(self):
        """Sahte kip: 50 Hz kinematik adımı + `tele` (GCS'ye 1 Hz heartbeat). Gerçek SITL: yayın `_isle` içinde olay güdümlüdür; burada
        yalnız bekçi (TELE_BEKCI içinde ATTITUDE/konum gelmediyse HUD için 4 Hz yayın)."""
        aralik = 1.0 / TELE_HZ
        son = time.time()
        hedef = son
        hb = 0.0
        n = 0
        while True:
            hedef += aralik                      # mutlak zamanlama: uyku sapması birikmez (gerçek 50 Hz)
            now = time.time()
            if hedef < now - 0.1:   # CPU kıtlığında en çok 5 kare "yetişme" (uzun patlama tarayıcıda yüzlerce Hz'lik yığın olarak görünürdü)
                hedef = now
            await asyncio.sleep(max(0.0, hedef - now))
            now = time.time()
            dt, son = now - son, now
            n += 1
            if self.hedefler and now - self._adsb_son >= 0.5:   # §24: hedefler Mission Planner'a ADSB trafiği (2 Hz)
                self._adsb_son = now
                self._adsb_gonder()
            if self.sahte is not None:
                self.sahte.adim(min(dt, 0.5))
                self.tele.update(self.sahte.tele())
                if self.state == 'HAZIR':
                    self._sahte_hub_cerceve(n)   # §14: harekât paneline MAVLink çerçeveleri
                if now - hb >= 1.0 and self.gcs_addr is not None:
                    hb = now
                    try:
                        m = self.mav.heartbeat_encode(_varsayilan_vtype(self.type), 3, 128 if self.sahte.armed else 0, 0, 4)
                        self._gcs_gonder(m.pack(self.mav))
                        self.mav.seq = (self.mav.seq + 1) % 256
                    except Exception:   # noqa: BLE001
                        pass
                self._tele_yay(zorla=True)
            elif now - self._tele_son >= TELE_BEKCI:
                self._tele_yay(zorla=True)

    async def _dongu(self):
        """1 sn: GCS sessizliği, SITL süreci, boşta / süre zaman aşımları, GCS kalp atışı."""
        while True:
            await asyncio.sleep(1.0)
            now = time.time()
            try:
                self.gorev.tik()   # §18: 1 Hz iz + istatistikler
            except Exception:   # noqa: BLE001
                pass
            try:
                self._esinti_adim()   # §31 esinti: SIM_WIND_SPD 1 Hz
            except Exception:   # noqa: BLE001
                pass
            if self.gcs_addr is not None and now - self.gcs_last > GCS_SESSIZLIK:
                self._olay(f'GCS bağlantısı kesildi ({self.gcs_addr[0]}:{self.gcs_addr[1]}, {int(GCS_SESSIZLIK)} sn sessizlik)', 4)
                self.gcs_addr, self.gcs_since = None, None
            if SITL_ENABLED and self.state == 'HAZIR':
                if not drone_sitl.YONETICI.calisiyor_mu(self.kimlik):
                    self.sitl['error'] = 'SITL süreci sonlandı'
                    self._olay(self.sitl['error'], 2)
                    self._durum('HATA')
                else:
                    self._gcs_heartbeat()
                    if self._heartbeat_alindi and now - self._akis_son >= AKIS_YENILE_S:
                        self._akis_iste(tam=False)   # Mission Planner'ın akış istekleri bizim 50 Hz aralıkları ezmiş olabilir
            if self.viewers:
                self.last_viewer = now
            if self.gcs_addr is None and not self.viewers and now - max(self.last_viewer, self.gcs_last) > BOSTA_SURE:
                self.end_reason = 'bosta'
                return
            if now - self.started > MAX_MINUTES * 60:
                self.end_reason = 'sure'
                return

    async def kapat(self, reason='kapatildi'):
        """Dışarıdan kapatma (DELETE / lifespan): görev iptal edilir, temizlik run() finally'de."""
        if self.state == 'KAPANDI':
            return
        self.end_reason = self.end_reason or reason
        if self.task is not None and not self.task.done() and self.task is not asyncio.current_task():
            self.task.cancel()
            try:
                await asyncio.wait_for(asyncio.shield(self.task), 30)   # .bin kapanışı: disarm beklemesi + SITL durdurma + dosya taşıma
            except (asyncio.CancelledError, asyncio.TimeoutError, Exception):   # noqa: BLE001
                pass
        else:
            await self._temizle()

    async def _bin_kapat(self):
        """§19: SITL kapanmadan önce DataFlash dosyası kapansın — armed ise zorla disarm (LOG_FILE_DSRMROT 1 → dosya döner) + kısa bekleme."""
        if not self.rec['bin'] or self.sahte is not None:
            return
        try:
            if self._heartbeat_alindi and self._tcp_w is not None and self.tele.get('armed'):
                self._gonder(self.mav.command_long_encode(self.sysid, self.comp, 400, 0, 0, 21196, 0, 0, 0, 0, 0))
                await asyncio.sleep(1.5)
            elif self._heartbeat_alindi:
                await asyncio.sleep(0.5)
        except Exception:   # noqa: BLE001
            pass

    async def _bin_kaydet(self):
        """§19: çalışma dizinindeki en büyük .BIN → Uçuş Logları (flightsim_bin.kaydet); sonuç `bin_sonuc` (DELETE yanıtı) + olay."""
        if not self.rec['bin']:
            return
        from . import flightsim_bin
        yollar = drone_sitl.bin_dosyalari(self.kimlik) if SITL_ENABLED else list(self.yonetici.sahte_bin_dosyalari or [])
        try:
            self.bin_sonuc = await asyncio.get_running_loop().run_in_executor(None, flightsim_bin.kaydet, self.to_dict(), yollar)
        except Exception as e:   # noqa: BLE001
            self.bin_sonuc = {'error': f'Uçuş logu kaydedilemedi: {e}'[:300]}
        if self.bin_sonuc and self.bin_sonuc.get('error'):
            self._olay(self.bin_sonuc['error'], 4)
        elif self.bin_sonuc:
            self._olay(f'Uçuş logu kaydedildi: {self.bin_sonuc["file_name"]} ({self.bin_sonuc["size"] // 1024} KB) — analiz kuyruğunda', 6)
        else:
            self._olay('Uçuş logu yok (armed süre olmadı); .bin kaydedilmedi', 6)

    # ---- §21: simülasyon kaydı (drone_sim_runs) ----
    async def _param_dokumu(self, sure=PARAM_DOKUM_S):
        """Kapanmadan önce SITL'den tam parametre listesi: PARAM_REQUEST_LIST → PARAM_VALUE'lar `param_son`a dolar (`_param_value_gozlendi`).
        Liste zaten büyük ölçüde biliniyorsa (Mission Planner açılışta çekmişti) istenmez; en çok `sure` sn beklenir (count'un %95'i gelince erken)."""
        if self.sahte is not None or not self._heartbeat_alindi or self._tcp_w is None:
            return
        if self._param_count and len(self.param_son) >= 0.95 * self._param_count:
            return
        try:
            self._gonder(self.mav.param_request_list_encode(self.sysid, self.comp))
        except Exception:   # noqa: BLE001
            return
        t0 = time.time()
        while time.time() - t0 < sure:
            await asyncio.sleep(0.25)
            if self._param_count and len(self.param_son) >= 0.95 * self._param_count:
                break

    async def _run_kaydet(self):
        """`drone_sim_runs` satırı + params.param + scripts.zip (flightsim_runs.kaydet; iş parçacığı). Hata oturumu düşürmez."""
        from . import flightsim_runs
        try:
            self.run_sonuc = await asyncio.get_running_loop().run_in_executor(None, flightsim_runs.kaydet, self)
        except Exception as e:   # noqa: BLE001
            self._olay(f'Simülasyon kaydı yazılamadı: {e}'[:200], 4)
            return
        if self.run_sonuc:
            self._olay(f'Simülasyon kaydedildi: #{self.run_sonuc["id"]} · {self.run_sonuc["params_count"]} parametre'
                       + (f' · {self.run_sonuc["scripts_count"]} script' if self.run_sonuc.get('scripts_count') else ''), 6)
            dp = self.run_sonuc.get('drone_power') or {}
            if dp:   # §23: ölçümler dron kaydına yazıldı
                parca = [f"tüketim {dp['fuel_km_per_l_last']:g} km/L" if 'fuel_km_per_l_last' in dp else None, f"ortalama {dp['elec_w_last']:g} W" if 'elec_w_last' in dp else None]
                self._olay('Dron kaydına yazıldı (sonraki simülasyonda önerilir): ' + ' · '.join(p for p in parca if p), 6)

    async def _temizle(self):
        if self.state == 'KAPANDI':
            return
        try:
            await self._param_dokumu()   # §21: son parametreler (SITL hâlâ çalışıyor)
        except Exception:   # noqa: BLE001
            pass
        await self._bin_kapat()
        self.state = 'KAPANDI'
        if self._launch_task is not None and not self._launch_task.done():
            self._launch_task.cancel()
        try:
            await asyncio.wait_for(self.gorev.kapanis(), 5)   # §18: özet raporu satırı (Bitir dışı kapanışlar için de)
        except Exception:   # noqa: BLE001
            pass
        flightsim_hub.detach(self)   # §14: harekât paneli köprüsü çevrimdışı
        await self._tcp_kapat()
        if self._udp is not None:
            try:
                self._udp.close()
            except Exception:   # noqa: BLE001
                pass
            self._udp = None
        if SITL_ENABLED:
            try:
                await asyncio.get_running_loop().run_in_executor(None, drone_sitl.YONETICI.durdur, self.kimlik)
            except Exception:   # noqa: BLE001
                drone_sitl.YONETICI.durdur(self.kimlik)
        await self._bin_kaydet()
        await self._run_kaydet()   # §21: özet + .bin + video + parametreler + scriptler tek satırda
        self._yay({'t': 'end', 'reason': self.end_reason or 'kapatildi', 'run': dict(self.run_sonuc) if self.run_sonuc else None})
        self.yonetici.sessions.pop(self.id, None)


# ======================================================================
# Yönetici (kiracı başına tek örnek)
# ======================================================================
class SimManager:
    def __init__(self):
        self.sessions = {}
        self._next = 1
        self.sahte_tcp_port = None   # HEPGO_SITL=0: testin sahte "SITL" TCP sunucusu (köprü yolu sınaması)
        self.sahte_bin_dosyalari = None   # HEPGO_SITL=0: testin sahte .BIN dosyaları (§19 kapanış kaydı sınaması)

    def get(self, sid):
        try:
            s = self.sessions.get(int(sid))
        except (TypeError, ValueError):
            return None
        return s if s is not None and s.state != 'KAPANDI' else None

    def listele(self, host=None):
        return [s.to_dict(host) for s in self.sessions.values() if s.state != 'KAPANDI']

    def acik_sayisi(self):
        return len([s for s in self.sessions.values() if s.state != 'KAPANDI'])

    async def ac(self, tip, center, world, owner, airframe=None, model=None, drone=None, rec=None, power=None, layout=None, camera=None, targets=None,
                 targets_katalog=None, site=None, defend=None, drive=None):
        """Yeni oturum: doğrulama (400) → limit (409) → SITL ikilisi (503) → UDP port (503, oturum içinde HATA) → görev.
        `model`: flightsim_models.coz ile çözülmüş kütüphane nesnesi (router); yoksa `airframe` ile dahili model.
        `drone` (§14, isteğe bağlı): Dron Envanteri kaydı {id, code, name, model} — harekât panelinde telemetri bu adla akar.
        `rec` (§19, isteğe bağlı): {bin: bool} — SITL DataFlash .BIN kaydı; kapanışta Uçuş Logları'na.
        `power` (§23, isteğe bağlı): {max_speed_ms, fuel_l, fuel_km_per_l, elec_cells, elec_mah, elec_w} — eksikler dron kaydı önerisi → tip varsayılanı.
        `camera` (§22.3, isteğe bağlı): 'day' | 'thermal' | 'night' (varsayılan day)."""
        if rec is not None and not isinstance(rec, dict):
            raise SimHata('invalid', 'rec nesne olmalı')
        camera = kamera_dogrula(camera)
        if tip not in drone_sitl.TIP_ESLEME:
            raise SimHata('invalid', 'Geçersiz dron tipi')
        try:
            oneri = drone_params.guc_onerisi(drone['id']) if drone and drone.get('id') else None
        except Exception:   # noqa: BLE001 — öneri okunamazsa varsayılanlar
            oneri = None
        try:
            power = flightsim_power.dogrula(power, tip, oneri)
        except ValueError as e:
            raise SimHata('invalid', str(e))
        airframe = airframe_dogrula(tip, airframe)
        layout = layout_dogrula(tip, layout, model)   # §13.1 kontrol düzeni (400)
        drive = drive_dogrula(tip, drive, model)      # §31 kara aracı sürüş biçimi (400)
        try:
            targets = flightsim_targets.dogrula(targets, targets_katalog)   # §24 hedefler (≤ 8; irtifa, çap, hız ≤ model azami; 400) — SIMUMAV kendi kataloğunu verir
        except flightsim_targets.HedefHata as e:
            raise SimHata('invalid', str(e))
        try:   # §26 yer kontrol merkezi + "Yer kontrolünü koru" (yalnız INTERCEPTOR)
            site = flightsim_gcs.gcs_dogrula(site)
            defend = flightsim_gcs.savunma_dogrula(defend, tip)
        except flightsim_gcs.GcsHata as e:
            raise SimHata('invalid', str(e))
        if not center or center.get('lat') is None or center.get('lon') is None:
            raise SimHata('invalid', 'Merkez bulunamadı')
        world = world_dogrula(world)
        if self.acik_sayisi() >= MAX_SESSIONS:
            raise SimHata('limit', f'En fazla {MAX_SESSIONS} açık oturum')
        if SITL_ENABLED and not drone_sitl.ikili_yolu(tip).is_file():
            loop = asyncio.get_running_loop()
            try:   # ikili yoksa yönetici indirir (sabit sürüm); olmazsa 503
                yol, err = await asyncio.wait_for(loop.run_in_executor(None, drone_sitl.indir, tip), 180)
            except asyncio.TimeoutError:
                yol, err = None, 'SITL ikilisi indirme zaman aşımı'
            if not yol:
                raise SimHata('sitl', err or 'SITL ikilisi yok')
        if not self._udp_bos_var():
            raise SimHata('sitl', 'Boş UDP portu yok')
        girilen = float(center['alt']) if center.get('alt') is not None else None
        alt, alt_not = girilen, None
        if world.get('mode') in TERRAIN_KIPLER:
            # §9 EV İRTİFASI KURALI: gerçek arazi / Google 3B kiplerinde SITL ev irtifası HER ZAMAN yükseklik verisinden (terrarium z13 bilineer;
            # vekil önbelleği; Google Elevation API kullanılmaz). Merkez kaydındaki `alt` burada KULLANILMAZ: SITL fiziği aynı veriden TERRAIN_DATA
            # alır (§18); ev irtifası yüzeyden farklı kurulursa (Ankara 0 m / Bedesten 1500 m kayıtları; gerçek 1000 / 742 m) uçak yerin yüzlerce metre
            # altında/üstünde doğar ve fizik çıldırır (takla). Girilen değer `alt_entered` olarak saklanır; fark > EV_FARK_UYARI ise olay şeridine not.
            from . import sim_terrain
            try:
                alt = await asyncio.wait_for(asyncio.get_running_loop().run_in_executor(None, sim_terrain.ev_irtifa, float(center['lat']), float(center['lon'])), 12)
                if girilen is not None and abs(girilen - alt) > EV_FARK_UYARI:
                    alt_not = f'Merkezin kayıtlı irtifası {girilen:.0f} m, arazi {alt:.0f} m — SITL ev irtifası arazi değeriyle kuruldu (kayıtlı değer yok sayıldı)'
            except Exception as e:   # noqa: BLE001 — kaynak yok/zaman aşımı: girilen değer ya da EV_IRTIFA ile sürer (arazi sunumu aynı kaynaktan; o da başarısız olur → düz zemin)
                alt = girilen
                alt_not = f'Arazi yüksekliği alınamadı ({str(e)[:80]}); SITL ev irtifası {girilen if girilen is not None else EV_IRTIFA:.0f} m (kayıtlı/varsayılan) ile kuruldu'
        sid = self._next
        self._next += 1
        s = SimSession(sid, tip, {'id': center.get('id'), 'name': center.get('name'), 'lat': float(center['lat']), 'lon': float(center['lon']),
                                  'alt': alt, 'alt_entered': girilen}, world, owner, self, airframe, model, drone, rec, power, layout, camera, targets,
                       site, defend, drive)
        s.alt_not = alt_not
        self.sessions[sid] = s
        s.task = asyncio.get_running_loop().create_task(s.run())
        return s

    async def ac_replay(self, log, world, owner, model=None, camera=None):
        """Kayıttan oynatma oturumu (mode 'replay'; flightsim_replay.ReplaySession): SITL/UDP yok. Doğrulama (400) → limit (409) → görev.
        Log ayrıştırma oturum görevinde arka planda sürer (BASLIYOR → HAZIR / HATA). `camera` (§22.3): kayıt bu simülatörden ise kaydın türü
        (drone_sim_runs.camera) önceliklidir; değilse verilen tür, o da yoksa gündüz."""
        camera = kamera_dogrula(camera)
        from .flightsim_replay import ReplaySession, UZANTILAR
        if not log or log.get('status') != 'TAMAM':
            raise SimHata('invalid', 'Uçuş logu bulunamadı ya da analizi tamamlanmadı')
        import os
        ext = os.path.splitext(log.get('file_name') or log.get('file') or '')[1].lower()
        if ext and ext not in UZANTILAR:
            raise SimHata('invalid', f'Desteklenmeyen log biçimi: {ext} (.bin, .log, .tlog)')
        world = world_dogrula(world)
        if self.acik_sayisi() >= MAX_SESSIONS:
            raise SimHata('limit', f'En fazla {MAX_SESSIONS} açık oturum')
        sid = self._next
        self._next += 1
        s = ReplaySession(sid, log, world, owner, self)
        if model is not None:
            s.model = model
        if s.camera is None:
            s.camera = camera
        self.sessions[sid] = s
        s.task = asyncio.get_running_loop().create_task(s.run())
        return s

    def _udp_bos_var(self):
        import socket
        kullanilan = {s.udp_port for s in self.sessions.values()}
        for p in range(UDP_BASE, UDP_BASE + UDP_ARALIK):
            if p in kullanilan:
                continue
            sk = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            try:
                sk.bind(('0.0.0.0', p))
                return True
            except OSError:
                continue
            finally:
                sk.close()
        return False

    async def kapat(self, sid, reason='kapatildi'):
        s = self.get(sid)
        if s is None:
            return False
        await s.kapat(reason)
        return True

    async def kapat_hepsi(self):
        """main.lifespan kapanışı: tüm oturumlar (SITL süreçleri, UDP) kapanır."""
        for s in list(self.sessions.values()):
            try:
                await s.kapat('sunucu_kapaniyor')
            except Exception:   # noqa: BLE001
                pass
        self.sessions.clear()


MANAGER = SimManager()
