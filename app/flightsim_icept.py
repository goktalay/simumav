"""INTERCEPTOR — 4 pervaneli TAILSITTER (kuyruk üstünde dikey kalkıp havada yatay uçan önleyici) için SITL kurulumu (docs/ucus-simulatoru.md §25).

Kullanıcı isteği: "4 pervane ile dikey kalkıp havada yatay hareket ediyor, o yüzden 400 km/h hızlara çıkabiliyor; ayrı bir tür olarak INTERCEPTOR
altında ekle."

SITL MODELİ: ArduPlane 4.7.2 `quadplane-copter_tailsitter` (libraries/SITL/SIM_QuadPlane.cpp: "+" quad çerçevesi, kuvvetler ROTATION_PITCH_270
ile gövdeye döndürülür → dikeyde burun yukarı, yatayda burun ileri; GROUND_BEHAVIOR_TAILSITTER: yerde kuyruk üstünde durur). Parametre seti
ArduPilot'un kendi autotest kurulumudur (Tools/autotest/default_params/quadplane.parm + quadplane-copter_tailsitter.parm) + HEPGO ekleri.

ÖLÇÜLEN TUZAK (DEV, yamalı arduplane 4.7.2, /tmp/icept-sitl): autotest setinde Q_TAILSIT_ENABLE YOKTUR — ArduPlane Q_TAILSIT_MOTMX ≠ 0 görünce
açılışta `enable.set_and_save(1)` yapar ama bu durumda kuyruk-oturtma görünümü (ahrs_view) kurulmaz: kontrolcü motorları doyurur (M3 1150 /
M4 1950 µs), araç yerden HİÇ kalkmaz (GUIDED NAV_TAKEOFF ACK 0, 30 sn'de 0 m). `Q_TAILSIT_ENABLE 1` defaults dosyasında açıkça verilince
GUIDED kalkış 2,5 m/s ile 76 m'ye 31 sn'de çıkar, FBWA'ya geçiş ~1 sn ("Transition FW done"), QLOITER'a dönüş ve QLAND çalışır.

AZAMİ HIZ: yatay uçuşta itki iki kaynaktan gelir — dörtlü motorlar (Q_TAILSIT_MOTMX) ve SIM_Plane itkisi (SERVO3 gazı; HEPGO yaması
SIM_PLN_THR_MUL bunu ölçekler). CRUISE kipinde seviye uçuş (75 m AGL, rüzgâr 0) ölçümü: SIM_PLN_THR_MUL 4 → 95,1 m/s, 7 → 117,3 m/s yer hızı;
stok (1) FBWA tam gaz ≈ 70 m/s (hafif tırmanışta). Uyum: v² = A + B·mul, A = 2756, B = 1572 (m²/s²) → 400 km/h (111,1 m/s) için mul ≈ 6,1.
"""
import math

SITL_MODEL = 'quadplane-copter_tailsitter'
TIP = 'interceptor'

# Seviye uçuş tam güç hızı uyumu (yer hızı, m/s): v² = A + B·SIM_PLN_THR_MUL (CRUISE, 75 m AGL, 900 m MSL ev; ölçüm 2026-10-20)
HIZ_A, HIZ_B = 2756.0, 1572.0
VARSAYILAN_HIZ_MS = 111.1   # 400 km/h


def tam_gaz_hizi(mul=1.0):
    return math.sqrt(max(0.0, HIZ_A + HIZ_B * float(mul)))


def thr_mul_icin(v):
    """Hedef seviye uçuş hızı (m/s) için SIM_PLN_THR_MUL (0,1…20)."""
    v = float(v)
    return round(max(0.1, min(20.0, (v * v - HIZ_A) / HIZ_B)), 3)


# autotest quadplane.parm (yalnız fizik/kontrol için gerekenler; pusula/INS kalibrasyon ofsetleri dahil) + quadplane-copter_tailsitter.parm + HEPGO
PARM = """# --- INTERCEPTOR (quadplane-copter_tailsitter) — ArduPilot autotest quadplane.parm + quadplane-copter_tailsitter.parm + HEPGO ---
ARMING_RUDDER 2
AIRSPEED_MAX 35
AIRSPEED_MIN 13
ARSPD_USE 1
EK3_ENABLE 1
COMPASS_OFS_X -0.453570
COMPASS_OFS_Y -0.585846
COMPASS_OFS_Z 6.815743
COMPASS_OFS2_X -0.420265
COMPASS_OFS2_Y -0.726942
COMPASS_OFS2_Z 6.665476
COMPASS_OFS3_X -0.420265
COMPASS_OFS3_Y -0.726942
COMPASS_OFS3_Z 6.665476
FBWB_CLIMB_RATE 10
FLTMODE1 10
FLTMODE2 11
FLTMODE3 12
FLTMODE4 5
FLTMODE5 19
FLTMODE6 5
FLTMODE_CH 5
INS_ACCOFFS_X 0.001
INS_ACCOFFS_Y 0.001
INS_ACCOFFS_Z 0.001
INS_ACCSCAL_X 1.001
INS_ACCSCAL_Y 1.001
INS_ACCSCAL_Z 1.001
INS_ACC2OFFS_X 0.001
INS_ACC2OFFS_Y 0.001
INS_ACC2OFFS_Z 0.001
INS_ACC2SCAL_X 1.001
INS_ACC2SCAL_Y 1.001
INS_ACC2SCAL_Z 1.001
INS_GYR_CAL 0
KFF_RDDRMIX 0.5
PTCH_LIM_MAX_DEG 30
PTCH_LIM_MIN_DEG -30
ROLL_LIMIT_DEG 45
NAVL1_PERIOD 14
PTCH_RATE_D 0
PTCH_RATE_I 0.2125
PTCH_RATE_IMAX 0.888889
PTCH_RATE_P 0.309954
PTCH_RATE_FF 1.407055
PTCH2SRV_RLL 1
RLL_RATE_D 0
RLL_RATE_I 0.2125
RLL_RATE_IMAX 0.888889
RLL_RATE_P 0.141009
RLL_RATE_FF 0.552741
Q_ASSIST_SPEED 18
Q_ENABLE 1
RC1_DZ 30
RC1_MAX 1886
RC1_MIN 1087
RC1_TRIM 1500
RC3_MAX 2000
RC3_MIN 1000
SERVO3_MIN 1000
SERVO3_MAX 2000
SCHED_LOOP_RATE 300
THR_MAX 100
AIRSPEED_CRUISE 25
Q_M_THST_EXPO 0.65
Q_M_PWM_MIN 1000
Q_M_PWM_MAX 2000
Q_M_BAT_VOLT_MAX 12.8
Q_M_BAT_VOLT_MIN 9.6
RTL_ALTITUDE 100
Q_FRAME_CLASS 1
Q_FRAME_TYPE 0
Q_TAILSIT_MOTMX 3
Q_A_ACC_P_MAX 2070.69
Q_A_ACC_R_MAX 1178.85
Q_A_ACC_Y_MAX 122.87
Q_A_ANGLE_BOOST 1
Q_A_ANG_LIM_TC 1
Q_A_ANG_PIT_P 18
Q_A_ANG_RLL_P 3.455029
Q_A_ANG_YAW_P 2.068653
Q_A_INPUT_TC 0.2
Q_A_RATE_FF_ENAB 1
Q_A_RATE_P_MAX 0
Q_A_RATE_R_MAX 0
Q_A_RATE_Y_MAX 0
Q_A_RAT_PIT_D 0.004973
Q_A_RAT_PIT_FF 0
Q_A_RAT_PIT_I 0.528246
Q_A_RAT_PIT_IMAX 0.5
Q_A_RAT_PIT_P 0.528246
Q_A_RAT_RLL_D 0.001
Q_A_RAT_RLL_FF 0
Q_A_RAT_RLL_I 0.541613
Q_A_RAT_RLL_IMAX 0.5
Q_A_RAT_RLL_P 0.541613
Q_A_RAT_YAW_D 0
Q_A_RAT_YAW_FF 0
Q_A_RAT_YAW_I 0.039192
Q_A_RAT_YAW_IMAX 0.5
Q_A_RAT_YAW_P 0.391919
Q_TRANS_DECEL 8
SIM_SONAR_ROT 4
SIM_SONAR_SCALE 10
RNGFND1_TYPE 100
RNGFND1_PIN 0
RNGFND1_SCALING 10
RNGFND1_MIN 0.10
RNGFND1_MAX 50
RNGFND1_ORIENT 12
RNGFND_LANDING 1
RNGFND_LND_ORNT 12
# HEPGO: açık etkinleştirme (yoksa kuyruk görünümü kurulmaz, araç kalkmaz — modül başlığı), dikey hızlar, RTL'de VTOL yaklaşma + dikey iniş
Q_TAILSIT_ENABLE 1
Q_WP_SPD_UP 5
Q_WP_SPD_DN 4
Q_PILOT_SPD_UP 5
Q_PILOT_SPD_DN 4
Q_RTL_MODE 1
Q_LAND_FINAL_ALT 6
Q_LAND_FINAL_SPD 0.6
# HEPGO: yüksek hız kararlılığı (ölçüm aşağıda) — TECS ileri beslemesi, hava hızı sensörü arıza tespiti kapalı, yatış 45°, asgari gaz 0
TRIM_THROTTLE 55
ARSPD_OPTIONS 0
THR_MIN 0
"""

# Her oturumun ilk kalp atışında da yazılır (eeprom'da eski değer kalmasın): açık etkinleştirme + RTL dikey iniş
# RTL ölçümleri (exp.py, CRUISE 111 m/s'den RTL): autotest seti (RTL_ALTITUDE 20, AIRSPEED_CRUISE 60 = 12/22 oranı, TRIM_THROTTLE 45, yatış 65°)
# ile TECS 60 m/s'ye yavaşlamak için gazı 0'a çeker → copter tailsitter'da motor itkisi (kontrol otoritesi) düşer, irtifa salınır ve uçak yere
# vurdu ("SIM Hit ground at 12,5 m/s" @ 65 m/s; HEPGO sunucusu üzerinden de 7,9 m/s @ 80 m/s); "Airspeed sensor re-enabled" anında ani dalış.
# Kararlı set: RTL_ALTITUDE 100, AIRSPEED_CRUISE = 0,8 × azami (flightsim_icept.CRUISE_ORAN → flightsim_power.hiz_parametreleri), TRIM_THROTTLE 55, ROLL_LIMIT_DEG 45,
# ARSPD_OPTIONS 0, THR_MIN 0 (THR_MIN 10 askıda servo3 itkisini × SIM_PLN_THR_MUL büyütüp QRTL'de sürekli tırmandırdı). Eve yaklaşınca QRTL
# (Q_RTL_MODE 1): ~90 m/s'den VTOL'e geçişte burun kalkıp ~280 m tırmanarak yavaşlar (kinetik enerji), sonra dikey iner (~2–2,5 m/s).
OTURUM_PARAMLARI = (('Q_TAILSIT_ENABLE', 1.0), ('Q_RTL_MODE', 1.0), ('Q_WP_SPD_UP', 5.0), ('Q_WP_SPD_DN', 4.0), ('RTL_ALTITUDE', 100.0),
                    ('TRIM_THROTTLE', 55.0), ('ROLL_LIMIT_DEG', 45.0), ('ARSPD_OPTIONS', 0.0), ('THR_MIN', 0.0))
CRUISE_ORAN = 0.8   # AIRSPEED_CRUISE / AIRSPEED_MAX (TECS gazı rölantiye düşürmesin)


def parm_satirlari():
    return [s for s in PARM.splitlines() if s.strip()]
