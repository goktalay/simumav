"""Uçuş Simülatörü — GÜÇ VE YAKIT modeli (docs/ucus-simulatoru.md §23): azami hız, yakıt (karbüratörlü motor), elektronik batarya, simülasyon hızı.

Kullanıcı isteği (özet): "CAYMAZ'da 222cc karbüratörlü motor var; simülasyonda hız yarı yarıya düşük; tam gazda 45 m/s olmalı. Sihirbazda yakıt (L) ve
tüketim (km/L); hücre sayısı, kapasite (mAh), saatlik tüketim (W). Her kamera kipinde yakıt ve batarya göstergesi; biterse yalnız kırmızı uyarı,
uçuş sürer. Uçuş sonu raporda mesafe, harcanan yakıt, ölçülen km/L ve ortalama W → dron kaydına yazılır, sonraki uçuşta önerilir."

AZAMİ HIZ. ArduPilot SITL `plane` modeli (libraries/SITL/SIM_Plane.cpp): itki = gaz × thrust_scale, thrust_scale = m·g / 0,7 (m = 2 kg → 28 N);
sürükleme = ½ρV²S·(c_drag_p + CL²/(π·e·AR)) (S 0,45 m², b 1,88 m, c_drag_p 0,1, e 0,9). Tam gaz seviye uçuş hızı T = D çözümü ≈ 31,7 m/s; stok
SITL'de bunu değiştiren parametre YOK (SIM_ENGINE_MUL yalnız SIM_ENGINE_FAIL maskesindeki motorlar için ve plane modelinde kullanılmaz). HEPGO
SITL yaması `SIM_PLN_THR_MUL` (tools/sitl/0002-sim-pln-thr-mul.patch; var_info3 idx 3, float, varsayılan 1) itkiyi çarpar → hız √mul ile ölçeklenir.
`thr_mul_icin(v)` hedef hız için çarpanı aynı fizikten çözer (45 m/s → ≈ 2,0). ArduPilot tarafında da oturum başında AIRSPEED_MAX = v,
AIRSPEED_CRUISE oranla (kayıtlı cruise/max oranı; yoksa ArduPlane varsayılanı 12/22), THR_MAX 100 yazılır (otomatik gaz modları hızı bu
sınırlarla hedefler). Yamalı olmayan ikilide (`drone_sitl.hiz_olcegi_destegi` False) yalnız ArduPilot parametreleri yazılır + sarı uyarı.

YAKIT (yalnız armed): L/dk = (v_km/h / 60) / (km/L) × (0,5 + 0,5·gaz) — mesafeye bağlı taban + gaz ağırlığı. Kalan menzil = kalan L × km/L.
Ölçülen km/L = kat edilen km / harcanan L (≥ 0,3 km ve ≥ 0,02 L).
BATARYA (elektronik; SITL'in SIM_BATT göstergesi DEĞİL): Wh = mAh/1000 × hücre × 3,7; harcama = W × saat + servo aktivitesi (Σ|Δpwm| µs ×
SERVO_J_PER_US J). Kalan süre = kalan Wh / anlık W. Ortalama W = harcanan Wh / saat (≥ 60 s).
Zaman kaynağı SITL `time_boot_ms` (speedup'ta hızlı akar → tüketim simülasyon zamanıyla); sahte kipte kinematik saati.
Saf fonksiyonlar (yakit_lpm, batarya_wh, plane_tam_gaz_hizi, thr_mul_icin, dogrula) tests.test_flightsim'de sınanır; ön yüz eşleniği
static/js/modules/flightsim_power.js (göstergeler + kayıttan oynatmada aynı model karelerden hesaplanır).
"""
import math

HUCRE_V = 3.7                     # LiPo nominal hücre gerilimi (Wh hesabı)
SERVO_J_PER_US = 0.0005           # servo aktivitesi: 1000 µs tam sapma ≈ 0,5 J
YAKIT_MIN_KM, YAKIT_MIN_L = 0.3, 0.02    # ölçülen km/L için en az mesafe / yakıt
ELEC_MIN_S = 60.0                        # ortalama W için en az süre
W_PENCERE_S = 30.0                       # anlık W (kalan süre) için kayan pencere
SPEEDUPS = (1, 2, 4, 8)                  # panel/üst çubuk seçici (SIM_SPEEDUP)
# Dron kaydı seçenekleri (drone_sitl_options anahtarları) ↔ start gövdesi `power` alanları
ALANLAR = ('max_speed_ms', 'fuel_l', 'fuel_km_per_l', 'elec_cells', 'elec_mah', 'elec_w')
KAYIT_ANAHTARLARI = {'max_speed_ms': 'max_speed_ms', 'fuel_l': 'fuel_l', 'fuel_km_per_l': 'fuel_km_per_l_last', 'elec_cells': 'elec_cells',
                     'elec_mah': 'elec_mah', 'elec_w': 'elec_w_last'}
SINIRLAR = {'max_speed_ms': (5.0, 150.0), 'fuel_l': (0.0, 500.0), 'fuel_km_per_l': (0.5, 500.0), 'elec_cells': (1, 16), 'elec_mah': (100.0, 200000.0), 'elec_w': (0.0, 2000.0)}
TAMSAYI = ('elec_cells',)
# Varsayılanlar (kullanıcı: CAYMAZ 45 m/s, 5 L, 25 km/L, 4S 10000 mAh 30 W); kopterlerde yakıt yok (0 L) ve azami hız yazılmaz
CAYMAZ_VARSAYILAN = {'max_speed_ms': 45.0, 'fuel_l': 5.0, 'fuel_km_per_l': 25.0, 'elec_cells': 4, 'elec_mah': 10000.0, 'elec_w': 30.0}
KOPTER_VARSAYILAN = {'max_speed_ms': None, 'fuel_l': 0.0, 'fuel_km_per_l': 25.0, 'elec_cells': 4, 'elec_mah': 10000.0, 'elec_w': 30.0}
# §25 INTERCEPTOR: elektrikli 4 pervaneli tailsitter — yakıt yok, 400 km/h (111,1 m/s) azami hız, 6S aviyonik bataryası
INTERCEPTOR_VARSAYILAN = {'max_speed_ms': 111.1, 'fuel_l': 0.0, 'fuel_km_per_l': 25.0, 'elec_cells': 6, 'elec_mah': 8000.0, 'elec_w': 40.0}
# §31 KARA ARACI (ArduRover): varsayılan elektrikli (yakıt 0 L; içten yanmalı 4×4 için sihirbazda L / km/L girilir), 4S 16000 mAh, sürüş elektroniği 60 W
ROVER_VARSAYILAN = {'max_speed_ms': None, 'fuel_l': 0.0, 'fuel_km_per_l': 12.0, 'elec_cells': 4, 'elec_mah': 16000.0, 'elec_w': 60.0}
PLANE_TIPLERI = ('sabit_kanat', 'vtol', 'interceptor')
SIM_PLN_THR_MUL = 'SIM_PLN_THR_MUL'
SIM_SPEEDUP = 'SIM_SPEEDUP'
# SIM_Plane varsayılan gövdesi (SIM_Plane.h default_coefficients + kurucu): kütle 2 kg, hover_throttle 0,7
PLANE = {'mass': 2.0, 'hover_throttle': 0.7, 's': 0.45, 'b': 1.88, 'c_drag_p': 0.1, 'oswald': 0.9, 'rho': 1.225, 'g': 9.80665}
HIZ_DESTEK_YOK = 'SITL ikilisi itki ölçeği (SIM_PLN_THR_MUL) desteklemiyor; azami hız yalnız ArduPilot sınırlarına (AIRSPEED_MAX/CRUISE, THR_MAX) uygulandı'


def varsayilanlar(tip):
    if tip == 'interceptor':
        return dict(INTERCEPTOR_VARSAYILAN)
    if tip == 'rover':
        return dict(ROVER_VARSAYILAN)
    return dict(CAYMAZ_VARSAYILAN if tip in PLANE_TIPLERI else KOPTER_VARSAYILAN)


def dogrula(p, tip, oneri=None):
    """`power` gövdesi → tam sözlük (eksikler: dron önerisi → tip varsayılanı). Hatalı değer → ValueError (router 400)."""
    if p is None:
        p = {}
    if not isinstance(p, dict):
        raise ValueError('power bir nesne olmalı')
    out = varsayilanlar(tip)
    for k, v in (oneri or {}).items():
        if k in out and v is not None:
            out[k] = v
    for k in ALANLAR:
        if k not in p or p[k] is None:
            continue
        v = p[k]
        if isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(float(v)):
            raise ValueError(f'power.{k} sayı olmalı')
        alt, ust = SINIRLAR[k]
        if not (alt <= v <= ust):
            raise ValueError(f'power.{k} {alt:g}…{ust:g} arasında olmalı')
        out[k] = int(round(v)) if k in TAMSAYI else float(v)
    if tip not in PLANE_TIPLERI:
        out['max_speed_ms'] = None   # kopter / kara aracında itki ölçeği/AIRSPEED yok
    if out['elec_cells'] is not None:
        out['elec_cells'] = int(out['elec_cells'])
    return out


# ---------------- azami hız (SIM_Plane fiziği) ----------------
def plane_suruklenme(v, p=PLANE):
    """Seviye uçuşta (L = W) hız v'deki sürükleme kuvveti (N): ½ρV²S·(c_drag_p + CL²/(π·e·AR))."""
    if v <= 0:
        return 0.0
    q = 0.5 * p['rho'] * v * v
    ar = p['b'] ** 2 / p['s']
    cl = p['mass'] * p['g'] / (q * p['s'])
    cd = p['c_drag_p'] + cl * cl / (math.pi * p['oswald'] * ar)
    return q * p['s'] * cd


def plane_tam_itki(mul=1.0, p=PLANE):
    return p['mass'] * p['g'] / p['hover_throttle'] * float(mul)


def plane_tam_gaz_hizi(mul=1.0, p=PLANE):
    """Tam gazda (gaz 1,0) seviye uçuş hızı (m/s): T(mul) = D(v) çözümü (ikiye bölme)."""
    t = plane_tam_itki(mul, p)
    lo, hi = 1.0, 400.0
    for _ in range(80):
        mid = (lo + hi) / 2
        if plane_suruklenme(mid, p) > t:
            hi = mid
        else:
            lo = mid
    return (lo + hi) / 2


def thr_mul_icin(v_hedef, p=PLANE):
    """Hedef tam gaz hızı için SIM_PLN_THR_MUL: D(v) / T(1). 45 m/s → ≈ 2,0 (ölçümle doğrulandı, §23)."""
    v = float(v_hedef)
    if v <= 0:
        return 1.0
    return round(plane_suruklenme(v, p) / plane_tam_itki(1.0, p), 4)


def thr_mul_tip(v, tip=None):
    """Tipe göre SIM_PLN_THR_MUL: INTERCEPTOR tailsitter ölçüm uyumu (flightsim_icept; dörtlü motor itkisi ölçeklenmez), diğer uçaklar SIM_Plane fiziği."""
    if tip == 'interceptor':
        from . import flightsim_icept
        return flightsim_icept.thr_mul_icin(v)
    return thr_mul_icin(v)


def stok_hiz(tip=None):
    """Stok (SIM_PLN_THR_MUL 1) tam gaz seviye hız (m/s) — bilgi satırları."""
    if tip == 'interceptor':
        from . import flightsim_icept
        return flightsim_icept.tam_gaz_hizi(1.0)
    return plane_tam_gaz_hizi()


def hiz_parametreleri(v_max, kayitli=None, itki_olcegi=True, tip=None):
    """Oturum başında yazılacak ArduPlane (+ SITL) parametreleri: AIRSPEED_MAX = v, AIRSPEED_CRUISE = v × (kayıtlı cruise/max oranı; yoksa 12/22),
    THR_MAX 100, yamalı ikilide SIM_PLN_THR_MUL. `kayitli`: ad → değer (dronun kalıcı parametreleri). Dönüş: [(ad, değer)]."""
    if v_max is None:
        return []
    v = float(v_max)
    k = {str(a).upper(): float(b) for a, b in (kayitli or {}).items()} if isinstance(kayitli, dict) else {str(r['name']).upper(): float(r['value']) for r in (kayitli or [])}
    oran = 12.0 / 22.0
    if tip == 'interceptor':   # §25 tailsitter: seyir azami hızın %80'i (düşük seyirde TECS gazı keser → kontrol otoritesi düşer; flightsim_icept)
        from . import flightsim_icept
        oran = flightsim_icept.CRUISE_ORAN
    if k.get('AIRSPEED_MAX') and k.get('AIRSPEED_CRUISE') and k['AIRSPEED_MAX'] > 0:
        oran = max(0.2, min(0.95, k['AIRSPEED_CRUISE'] / k['AIRSPEED_MAX']))
    cruise = round(v * oran, 1)
    vmin = k.get('AIRSPEED_MIN')
    if vmin and cruise <= vmin:
        cruise = round(min(v, vmin + 2.0), 1)
    out = [('AIRSPEED_MAX', round(v, 1)), ('AIRSPEED_CRUISE', cruise), ('THR_MAX', 100.0)]
    if itki_olcegi:
        out.append((SIM_PLN_THR_MUL, thr_mul_tip(v, tip)))
    return out


# ---------------- yakıt / batarya saf hesaplar ----------------
def yakit_lpm(v_ms, thr_pct, km_per_l):
    """Anlık tüketim (L/dk): (v km/h ÷ 60) ÷ (km/L) × (0,5 + 0,5·gaz)."""
    if not km_per_l or km_per_l <= 0:
        return 0.0
    v_kmh = max(0.0, float(v_ms or 0)) * 3.6
    thr = max(0.0, min(1.0, float(thr_pct or 0) / 100.0))
    return (v_kmh / 60.0) / float(km_per_l) * (0.5 + 0.5 * thr)


def batarya_wh(mah, cells, hucre_v=HUCRE_V):
    return float(mah or 0) / 1000.0 * int(cells or 0) * hucre_v


def servo_joule(servo, onceki):
    """Servo aktivitesi enerjisi (J): Σ|Δpwm| µs × SERVO_J_PER_US (yalnız 1000–2000 arası gerçek çıkışlar)."""
    if not servo or not onceki:
        return 0.0
    j = 0.0
    for a, b in zip(servo, onceki):
        try:
            a, b = int(a), int(b)
        except (TypeError, ValueError):
            continue
        if 800 <= a <= 2200 and 800 <= b <= 2200:
            j += abs(a - b) * SERVO_J_PER_US
    return j


def olculen_km_per_l(dist_m, used_l):
    if dist_m is None or used_l is None or dist_m / 1000.0 < YAKIT_MIN_KM or used_l < YAKIT_MIN_L:
        return None
    return round(dist_m / 1000.0 / used_l, 2)


def ortalama_w(wh_used, sure_s):
    if not sure_s or sure_s < ELEC_MIN_S or wh_used is None:
        return None
    return round(wh_used / (sure_s / 3600.0), 1)


class GucDurumu:
    """Oturumun yakıt + batarya + hız istatistiği. `adim(tele, t_ms)` her telemetri karesinde (SITL time_boot_ms); dönüş: yeni biten kaynaklar listesi."""

    def __init__(self, ayar):
        self.ayar = dict(ayar)
        self.fuel_on = float(ayar.get('fuel_l') or 0) > 0 and float(ayar.get('fuel_km_per_l') or 0) > 0
        self.fuel_l0 = float(ayar.get('fuel_l') or 0)
        self.fuel_l = self.fuel_l0
        self.fuel_used = 0.0
        self.fuel_lpm = 0.0
        self.fuel_empty_t = None
        self.wh_cap = batarya_wh(ayar.get('elec_mah'), ayar.get('elec_cells'))
        self.elec_on = self.wh_cap > 0
        self.wh_used = 0.0
        self.w_now = float(ayar.get('elec_w') or 0)
        self.elec_empty_t = None
        self.dist_m = 0.0
        self.time_s = 0.0          # telemetri aktığı simülasyon süresi (batarya)
        self.armed_s = 0.0         # armed süre (yakıt)
        self._t_ms = None
        self._servo = None
        self._pencere = []         # (t_s, J) son W_PENCERE_S içindeki harcama (anlık W)
        self.speedup = 1.0
        self.speedup_max = 1.0
        self.speedup_degisim = 0
        self.max_speed_seen = 0.0

    def hiz_ayarla(self, f):
        f = float(f)
        if f != self.speedup:
            self.speedup_degisim += 1
        self.speedup = f
        self.speedup_max = max(self.speedup_max, f)

    def sifirla_zaman(self):
        self._t_ms = None
        self._servo = None

    def adim(self, te, t_ms):
        if t_ms is None:
            return []
        t_ms = int(t_ms)
        if self._t_ms is None or t_ms < self._t_ms:   # ilk kare ya da SITL yeniden başladı (reset): zaman sıfırdan
            self._t_ms = t_ms
            self._servo = list(te.get('servo') or []) or None
            return []
        dt = (t_ms - self._t_ms) / 1000.0
        self._t_ms = t_ms
        if dt <= 0 or dt > 5.0:   # boşluk (bağlantı kesintisi): entegre etme
            self._servo = list(te.get('servo') or []) or None
            return []
        biten = []
        armed = bool(te.get('armed'))
        gs = float(te.get('groundspeed') or 0)
        thr = float(te.get('throttle') or 0)
        self.time_s += dt
        self.max_speed_seen = max(self.max_speed_seen, gs) if armed else self.max_speed_seen
        if armed:
            self.armed_s += dt
            self.dist_m += gs * dt
        # yakıt
        if self.fuel_on:
            self.fuel_lpm = yakit_lpm(gs, thr, self.ayar.get('fuel_km_per_l')) if armed else 0.0
            if armed and self.fuel_l > 0:
                kullan = min(self.fuel_l, self.fuel_lpm * dt / 60.0)
                self.fuel_l -= kullan
                self.fuel_used += kullan
                if self.fuel_l <= 1e-9:
                    self.fuel_l = 0.0
                    self.fuel_empty_t = round(self.time_s, 1)
                    biten.append('fuel')
        # batarya (elektronik; telemetri aktığı sürece)
        if self.elec_on:
            servo = list(te.get('servo') or []) or None
            j = float(self.ayar.get('elec_w') or 0) * dt + servo_joule(servo, self._servo)
            self._servo = servo
            self._pencere.append((self.time_s, j))
            while self._pencere and self.time_s - self._pencere[0][0] > W_PENCERE_S:
                self._pencere.pop(0)
            span = self.time_s - self._pencere[0][0] if len(self._pencere) > 1 else 0
            self.w_now = (sum(x[1] for x in self._pencere) / span) if span > 1.0 else float(self.ayar.get('elec_w') or 0)
            if self.wh_used < self.wh_cap:
                self.wh_used = min(self.wh_cap, self.wh_used + j / 3600.0)
                if self.wh_cap - self.wh_used <= 1e-9:
                    self.wh_used = self.wh_cap
                    self.elec_empty_t = round(self.time_s, 1)
                    biten.append('elec')
        return biten

    # ---- yayın / özet ----
    def tele_alanlari(self):
        out = {'speedup': self.speedup}
        if self.fuel_on:
            kml = float(self.ayar.get('fuel_km_per_l') or 0)
            out['fuel'] = {'l': round(self.fuel_l, 3), 'pct': round(100.0 * self.fuel_l / self.fuel_l0, 1) if self.fuel_l0 else 0.0,
                           'lpm': round(self.fuel_lpm, 4), 'range_km': round(self.fuel_l * kml, 2), 'empty': self.fuel_l <= 0}
        else:
            out['fuel'] = None
        if self.elec_on:
            left = self.wh_cap - self.wh_used
            out['elec'] = {'wh': round(left, 2), 'pct': round(100.0 * left / self.wh_cap, 1), 'w': round(self.w_now, 1),
                           'min_left': round(left / self.w_now * 60.0, 1) if self.w_now > 0.01 else None, 'cells': int(self.ayar.get('elec_cells') or 0),
                           'v': round(int(self.ayar.get('elec_cells') or 0) * (3.5 + 0.7 * max(0.0, left / self.wh_cap)), 2), 'empty': left <= 0}
        else:
            out['elec'] = None
        return out

    def ozet(self):
        kml = olculen_km_per_l(self.dist_m, self.fuel_used) if self.fuel_on else None
        w_avg = ortalama_w(self.wh_used, self.time_s) if self.elec_on else None
        return {
            'settings': dict(self.ayar),
            'dist_m': round(self.dist_m, 1), 'time_s': round(self.time_s, 1), 'armed_s': round(self.armed_s, 1), 'max_speed_seen': round(self.max_speed_seen, 1),
            'fuel': {'start_l': round(self.fuel_l0, 3), 'used_l': round(self.fuel_used, 3), 'left_l': round(self.fuel_l, 3),
                     'pct': round(100.0 * self.fuel_l / self.fuel_l0, 1) if self.fuel_l0 else None, 'km_per_l': kml, 'empty_t': self.fuel_empty_t} if self.fuel_on else None,
            'elec': {'wh_cap': round(self.wh_cap, 2), 'wh_used': round(self.wh_used, 3), 'wh_left': round(self.wh_cap - self.wh_used, 3),
                     'pct': round(100.0 * (self.wh_cap - self.wh_used) / self.wh_cap, 1), 'w_avg': w_avg, 'empty_t': self.elec_empty_t,
                     'cells': int(self.ayar.get('elec_cells') or 0), 'mah': self.ayar.get('elec_mah'), 'w_set': self.ayar.get('elec_w')} if self.elec_on else None,
            'speedup': {'max': self.speedup_max, 'changes': self.speedup_degisim, 'last': self.speedup},
        }


def drona_yazilacaklar(ozet):
    """Oturum sonunda dron kaydına önerilecek ölçümler: {fuel_km_per_l_last, elec_w_last} (yalnız geçerli ölçümler)."""
    out = {}
    f, e = (ozet or {}).get('fuel') or {}, (ozet or {}).get('elec') or {}
    if f.get('km_per_l'):
        out['fuel_km_per_l_last'] = float(f['km_per_l'])
    if e.get('w_avg'):
        out['elec_w_last'] = float(e['w_avg'])
    return out


# ---------------- §27 sihirbaz özeti: azami uçuş süresi ve azami menzil (saf; istemci eşleniği flightsim_power.js `flightBudget`) ----------------
# Aynı model (yukarıdaki yakıt L/dk ve batarya Wh / W) SEYİR koşulunda çözülür:
#   seyir hızı  = uçakta AIRSPEED_CRUISE oranı (hiz_parametreleri: 12/22; INTERCEPTOR 0,8) × azami hız · kopterde KOPTER_SEYIR_MS (ArduCopter WPNAV_SPEED 10 m/s)
#   seyir gazı  = uçakta (v_seyir / v_azami)² (sürükleme ∝ V², tam gaz = azami hız) · kopterde KOPTER_ASKI_GAZ (askı gazı)
#   yakıt       : menzil = L × km/L ÷ (0,5 + 0,5·gaz), süre = menzil ÷ v_seyir  (yakit_lpm'in tersi)
#   batarya     : süre = Wh ÷ W (servo ek yükü hariç — ölçüm biraz daha kısa verir), menzil = süre × v_seyir
#   sınırlayan  : süresi kısa olan enerji kaynağı ('fuel' | 'elec'); yalnız biri varsa o. Azami hızda (gaz 1) aynı hesap ayrıca verilir.
# Yuvarlama iki tarafta aynı: yuvarla(x, n) = floor(x·10ⁿ + 0,5) / 10ⁿ (Python round'un banker yuvarlaması JS ile ayrışmasın).
KOPTER_SEYIR_MS = 10.0       # ArduCopter WPNAV_SPEED varsayılanı 1000 cm/s
KOPTER_AZAMI_MS = 12.5       # ArduCopter LOIT_SPEED varsayılanı 1250 cm/s
KOPTER_ASKI_GAZ = 0.5        # MOT_THST_HOVER ≈ 0,5
ROVER_SEYIR_MS = 5.0         # §31 ArduRover CRUISE_SPEED (rover.parm 5 m/s; skid 3)
ROVER_AZAMI_MS = 20.0        # SIM_Rover max_speed (Ackermann; skid 4 m/s)
ROVER_SEYIR_GAZ = 0.3        # rover.parm CRUISE_THROTTLE %30
SEYIR_ORAN = 12.0 / 22.0     # ArduPlane AIRSPEED_CRUISE / AIRSPEED_MAX varsayılanı (hiz_parametreleri ile aynı)
ICEPT_SEYIR_ORAN = 0.8       # flightsim_icept.CRUISE_ORAN (döngüsel içe aktarma yerine sabit; tests.test_flightsim eşitliği denetler)


def yuvarla(x, n=1):
    if x is None:
        return None
    k = 10 ** n
    return math.floor(float(x) * k + 0.5) / k


def _sayi(v, d=0.0):
    try:
        f = float(v)
        return f if math.isfinite(f) else d
    except (TypeError, ValueError):
        return d


def menzil_sure(p, tip):
    """`power` ayarları (eksikler tip varsayılanı) → {speed:{cruise_ms, max_ms, cruise_thr}, fuel|None, elec|None, limit, time_min, range_km,
    time_min_max, range_km_max}. fuel/elec: {time_min, range_km, time_min_max, range_km_max} (+ elec.wh). Kaynak yoksa time/range None."""
    a = varsayilanlar(tip)
    for k, v in (p or {}).items():
        if k in a and v is not None:
            a[k] = v
    if tip in PLANE_TIPLERI:
        vmax = _sayi(a.get('max_speed_ms')) or varsayilanlar(tip)['max_speed_ms']
        vc = vmax * (ICEPT_SEYIR_ORAN if tip == 'interceptor' else SEYIR_ORAN)
        thr = min(1.0, max(0.0, (vc / vmax) ** 2))
    elif tip == 'rover':   # §31 kara aracı: rover.parm CRUISE_SPEED 5 m/s @ CRUISE_THROTTLE %30; SIM_Rover azami ≈ 20 m/s
        vmax, vc, thr = ROVER_AZAMI_MS, ROVER_SEYIR_MS, ROVER_SEYIR_GAZ
    else:
        vmax, vc, thr = KOPTER_AZAMI_MS, KOPTER_SEYIR_MS, KOPTER_ASKI_GAZ
    kmh_c, kmh_m = vc * 3.6, vmax * 3.6
    fl, kml = _sayi(a.get('fuel_l')), _sayi(a.get('fuel_km_per_l'))
    fuel = None
    if fl > 0 and kml > 0:
        r_c = fl * kml / (0.5 + 0.5 * thr)
        r_m = fl * kml   # gaz 1 → çarpan 1
        fuel = {'range_km': yuvarla(r_c, 1), 'time_min': yuvarla(r_c / kmh_c * 60.0, 1), 'range_km_max': yuvarla(r_m, 1), 'time_min_max': yuvarla(r_m / kmh_m * 60.0, 1)}
    wh, w = batarya_wh(a.get('elec_mah'), a.get('elec_cells')), _sayi(a.get('elec_w'))
    elec = None
    if wh > 0 and w > 0:
        t_h = wh / w
        elec = {'wh': yuvarla(wh, 1), 'time_min': yuvarla(t_h * 60.0, 1), 'range_km': yuvarla(t_h * kmh_c, 1), 'time_min_max': yuvarla(t_h * 60.0, 1), 'range_km_max': yuvarla(t_h * kmh_m, 1)}
    kaynak = [(k, v) for k, v in (('fuel', fuel), ('elec', elec)) if v]
    limit = min(kaynak, key=lambda kv: kv[1]['time_min'])[0] if kaynak else None
    sec = fuel if limit == 'fuel' else elec if limit == 'elec' else None
    sec_m = min((v for _, v in kaynak), key=lambda v: v['time_min_max']) if kaynak else None
    return {'speed': {'cruise_ms': yuvarla(vc, 1), 'max_ms': yuvarla(vmax, 1), 'cruise_thr': yuvarla(thr, 2)}, 'fuel': fuel, 'elec': elec, 'limit': limit,
            'time_min': sec['time_min'] if sec else None, 'range_km': sec['range_km'] if sec else None,
            'time_min_max': sec_m['time_min_max'] if sec_m else None, 'range_km_max': sec_m['range_km_max'] if sec_m else None}
