"""Uçuş Simülatörü — SERVO TETİK (docs/ucus-simulatoru.md §34; HEPGO + SIMUMAV ortak çekirdek).

Kullanıcı isteği: "Simülasyon ortamında altta bir Servo kanalı seçme olsun, yanında PWM değeri olsun, gecikme milisaniye cinsinden olsun, Dinle
düğmesi olsun. Dinle'ye basarsa o servo kanalından gelen PWM değerini dinlesin ve komut gelirse gecikme süresini bekleyip sanki dağa ya da bir
nesneye çarpmış gibi hareket edip simülasyonu bitirip özet ekranı gelsin. Son özette de bu işlemin kaç metrede çalıştığını görebilelim."

Tetik mantığı SUNUCUDADIR (istemci kapalı / yavaş olsa da güvenilir):
- `cmd servo_trigger {on, ch 1…16, pwm 800…2200 µs, cmp 'ge'|'le'|'eq', tol 1…500 µs (eq için ±), delay_ms 0…60000}`. `on:false` dinlemeyi
  bırakır (bekleyen gecikme de iptal). Kaynak: SITL'in SERVO_OUTPUT_RAW akışı (servo1…16_raw; 9…16 MAVLink2 uzantı alanları) — kanal Mission
  Planner'dan (DO_SET_SERVO / RC geçişli kanal RCINn / görev öğesi), HEPGO'dan (`servo_set`) ya da otopilotun kendisinden sürülebilir.
- KENAR TETİKLİ: dinleme başladıktan sonra koşulun YENİ sağlandığı ilk örnek tetiktir. Dinleme açıldığında kanal zaten koşuldaysa (ör. eşik ≥ 1100
  ve kanal 1500'de duruyor) bu bir "komut" değildir — olay şeridine "zaten koşulda; yeni komut bekleniyor" yazılır ve koşulun önce bozulup sonra
  yeniden sağlanması beklenir. Gerekçe: kullanıcı "komut gelirse" dedi; seviye tetiği Dinle'ye basıldığı an çarpışma üretip anlamsız olurdu.
  PWM 0 / 65535 (kanal çıkış vermiyor) "koşul sağlanmıyor" sayılır: gerçek SITL'de SERVO9_FUNCTION 0 iken kanal 0 bildirir, Mission Planner
  DO_SET_SERVO 9 1900 → 0 → 1900 geçişi tetiktir (SITL'de ölçüldü).
- GECİKME SİMÜLASYON ZAMANIYLA sayılır (SITL time_boot_ms; SIM_SPEEDUP 4× iken 2000 ms gecikme ~0,5 sn gerçek zamanda dolar). Gerekçe: gecikme
  fiziksel bir süreyi (yükün bırakılıp etkimesi, sigorta vb.) taklit eder; araç da simülasyon zamanında hareket eder → çarpma konumu hızdan
  bağımsız aynı çıkar. SITL dondu ve saat ilerlemezse duvar saati bekçisi (gecikme × 2 + 5 sn) çarpmayı yine üretir.
- ÇARPMA: araç o andaki konum / hız / yönüyle "çarpmış" sayılır — GorevIzleyici.carpisma('servo_trigger', hız) (drone_sim_events crash satırı,
  WS `crash`, ön yüzde crashfx patlama/toz + darbe sesi), araç zorla disarm (gerçek SITL; sahte kipte disarm), `end_reason = 'servo_trigger'`,
  3B görüntü DONDURULUR (sonraki `tele` yayınlanmaz — çarpma anı pozu kalır), STATUSTEXT SITL'e yazılır (ArduPilot GCS metnini DataFlash MSG
  olarak kaydeder → .bin kayıttan oynatmada olay şeridinde görünür). WS `{t:'servo_trigger', phase:'fired', …}` → ön yüz 2,5 sn sonra kendi
  Bitir akışını onaysız çalıştırır (kayıt → özet raporu → kapat). İzleyici kalmazsa (BOS_KAPANIS_S) ya da AZAMI_BEKLEME_S dolarsa sunucu
  oturumu kendisi kapatır (`end_reason servo_trigger`; özet + drone_sim_runs satırı kapanışta yazılır).
- ÖZET: `ozet()` → rapor `servo_trigger` bölümü: kanal + işlev, eşik / koşul / tolerans, gecikme (istenen + ölçülen sim/duvar), TETİK ANI ve
  ÇARPMA ANI anlık görüntüleri (AGL — TERRAIN_REPORT varsa arazi üstü, yoksa ev seviyesine göre —, MSL, evden yatay mesafe, lat/lon, hava/yer
  hızı, yön, mod, uçuş süresi = ilk ARM'dan bu yana simülasyon saniyesi). Kapanışta drone_sim_runs.servo_trig (JSON kısa özet) ve dron kaydına
  son ayarlar (drone_sitl_options srvtrig_*; sonraki oturumda öneri).
"""
import asyncio
import math
import time

KANAL_SAYISI = 16
PWM_MIN, PWM_MAX = 800, 2200
GECIKME_MAX_MS = 60000
TOL_VARSAYILAN, TOL_MIN, TOL_MAX = 50, 1, 500
KARSILASTIRMA = ('ge', 'le', 'eq')
CMP_KOD = {'ge': 0, 'le': 1, 'eq': 2}            # drone_sitl_options sayısal saklar
CMP_IMLEC = {'ge': '≥', 'le': '≤', 'eq': '='}
BOS_KAPANIS_S = 5.0          # çarpmadan sonra izleyici (ön yüz) yoksa bu süre sonra sunucu kapatır
AZAMI_BEKLEME_S = 300.0      # izleyici rapor ekranında kalsa da en geç bu süre sonra kapanış
MAV_CMD_DO_SET_SERVO = 183

# ArduPilot SERVOn_FUNCTION kodları (SRV_Channel::Aux_servo_function_t) → kısa ad; yük (payload) sayılanlar ayrıca işaretlenir
SERVO_ISLEVLERI = {-1: 'GPIO', 0: 'Disabled', 1: 'RCPassThru', 2: 'Flap', 3: 'FlapAuto', 4: 'Aileron', 6: 'MountPan', 7: 'MountTilt', 8: 'MountRoll',
                   9: 'MountOpen', 10: 'CameraTrigger', 12: 'Mount2Pan', 13: 'Mount2Tilt', 14: 'Mount2Roll', 15: 'Mount2Open', 16: 'DifferentialSpoilerL1',
                   17: 'DifferentialSpoilerR1', 19: 'Elevator', 21: 'Rudder', 22: 'SprayerPump', 23: 'SprayerSpinner', 24: 'FlaperonLeft',
                   25: 'FlaperonRight', 26: 'GroundSteering', 27: 'Parachute', 28: 'Gripper', 29: 'LandingGear', 30: 'EngineRunEnable',
                   31: 'HeliRSC', 32: 'HeliTailRSC', 41: 'TiltMotorsFront', 45: 'TiltMotorsRear', 46: 'TiltMotorRearLeft', 47: 'TiltMotorRearRight',
                   67: 'Ignition', 69: 'Starter', 70: 'Throttle', 73: 'ThrottleLeft', 74: 'ThrottleRight', 75: 'TiltMotorFrontLeft',
                   76: 'TiltMotorFrontRight', 77: 'ElevonLeft', 78: 'ElevonRight', 79: 'VTailLeft', 80: 'VTailRight', 81: 'BoostThrottle',
                   88: 'Winch', 120: 'NeoPixel1', 121: 'NeoPixel2', 122: 'NeoPixel3', 123: 'NeoPixel4'}
SERVO_ISLEVLERI.update({32 + i: f'Motor{i}' for i in range(1, 9)})          # 33…40 Motor1…8
SERVO_ISLEVLERI.update({81 + i: f'Motor{8 + i}' for i in range(1, 5)})      # 82…85 Motor9…12
SERVO_ISLEVLERI.update({50 + i: f'RCIN{i}' for i in range(1, 17)})         # 51…66 RCIN1…16
SERVO_ISLEVLERI.update({93 + i: f'Script{i}' for i in range(1, 17)})       # 94…109 Script1…16
YUK_ISLEVLERI = {1, 9, 10, 15, 22, 23, 27, 28, 88} | set(range(51, 67)) | set(range(94, 110))   # geçişli RC / bırakma / tetik / kanca / betik: "yük"


class ServoTetikHata(ValueError):
    pass


def islev_adi(kod):
    """SERVOn_FUNCTION → ('RCIN9', yük_mü). Bilinmeyen kod 'F<kod>'; None → (None, False)."""
    if kod is None:
        return None, False
    k = int(kod)
    return SERVO_ISLEVLERI.get(k, f'F{k}'), k in YUK_ISLEVLERI


def dogrula(p):
    """`servo_trigger` gövdesi → normalize sözlük. Hatalı alan → ServoTetikHata (oturum komutu 'invalid' döner)."""
    p = p if isinstance(p, dict) else {}
    on = p.get('on')
    if not isinstance(on, bool):
        raise ServoTetikHata('servo_trigger.on doğru/yanlış (true/false) olmalı')
    if not on:
        return {'on': False}

    def tamsayi(ad, alt, ust, vars_=None):
        v = p.get(ad, vars_)
        if isinstance(v, bool) or not isinstance(v, (int, float)) or (isinstance(v, float) and not math.isfinite(v)) or not (alt <= v <= ust):
            raise ServoTetikHata(f'servo_trigger.{ad} {alt}…{ust} olmalı')
        return int(round(v))
    ch = tamsayi('ch', 1, KANAL_SAYISI)
    pwm = tamsayi('pwm', PWM_MIN, PWM_MAX)
    delay = tamsayi('delay_ms', 0, GECIKME_MAX_MS, 0)
    tol = tamsayi('tol', TOL_MIN, TOL_MAX, TOL_VARSAYILAN)
    cmp_ = p.get('cmp', 'ge')
    if cmp_ not in KARSILASTIRMA:
        raise ServoTetikHata("servo_trigger.cmp 'ge' | 'le' | 'eq' olmalı")
    return {'on': True, 'ch': ch, 'pwm': pwm, 'cmp': cmp_, 'tol': tol, 'delay_ms': delay}


def kosul(cfg, pwm):
    """PWM örneği koşulu sağlıyor mu. None → None (örnek yok). 0 / 65535 = kanal çıkış VERMİYOR (SERVOn_FUNCTION 0, komut gelmemiş) → koşul
    sağlanmıyor (False; ≤ karşılaştırmasında da) — gerçek SITL'de DO_SET_SERVO kanal 9'u 0 → 1900 yapar, bu bir kenar (komut) sayılır."""
    if pwm is None:
        return None
    v = int(pwm)
    if v <= 0 or v >= 65535:
        return False
    if cfg['cmp'] == 'ge':
        return v >= cfg['pwm']
    if cfg['cmp'] == 'le':
        return v <= cfg['pwm']
    return abs(v - cfg['pwm']) <= cfg['tol']


def kosul_metni(cfg):
    if cfg['cmp'] == 'eq':
        return f"= {cfg['pwm']} ±{cfg['tol']} µs"
    return f"{CMP_IMLEC[cfg['cmp']]} {cfg['pwm']} µs"


def mesafe_m(lat1, lon1, lat2, lon2):
    if None in (lat1, lon1, lat2, lon2):
        return None
    cos = math.cos(math.radians((float(lat1) + float(lat2)) / 2))
    return math.hypot((float(lat2) - float(lat1)) * 110574.0, (float(lon2) - float(lon1)) * 111320.0 * cos)


def servo_raw_dizisi(m):
    """SERVO_OUTPUT_RAW → 16 elemanlı µs listesi (MAVLink1'de 9…16 alanları yok → 0)."""
    return [int(getattr(m, f'servo{i}_raw', 0) or 0) for i in range(1, KANAL_SAYISI + 1)]


def kisa_ozet(o):
    """drone_sim_runs.servo_trig sütunu (liste/kart için kısa JSON): kanal, eşik, gecikme, tetik/çarpma AGL + evden mesafe."""
    if not o or not o.get('trigger'):
        return None
    t, c = o.get('trigger') or {}, o.get('hit') or {}
    return {'ch': o.get('ch'), 'fn': o.get('fn_name'), 'pwm': o.get('pwm'), 'cmp': o.get('cmp'), 'delay_ms': o.get('delay_ms'),
            'trig_agl': t.get('agl'), 'trig_msl': t.get('alt_msl'), 'trig_dist_m': t.get('dist_home_m'),
            'hit_agl': c.get('agl'), 'hit_dist_m': c.get('dist_home_m'), 'fired': bool(c)}


class ServoTetik:
    """Bir SimSession'ın servo tetik durumu. Kancalar (flightsim.SimSession): `gozlem_mesaj(SERVO_OUTPUT_RAW)`, `param(ad, değer)`,
    `adim(tbm)` (her telemetri adımı; gecikme sayacı), `komut(name, p)`, `ozet()`, `durum()`, `donuk` (tele yayını dondur)."""

    def __init__(self, s):
        self.s = s
        self.cfg = None                 # son dogrula() çıktısı (on: True olan)
        self.on = False
        self.phase = 'idle'             # idle | listening | pending | fired
        self.pwm = [0] * KANAL_SAYISI   # son SERVO_OUTPUT_RAW (µs)
        self.fn = [None] * KANAL_SAYISI  # SERVOn_FUNCTION
        self._onceki = None             # son örneğin koşul durumu (kenar algısı)
        self._zaten_bildirildi = False
        self.trigger = None             # tetik anı anlık görüntüsü
        self.hit = None                 # çarpma anı anlık görüntüsü
        self.seen_pwm = None            # tetikteki PWM
        self._tetik_tbm = None
        self._tetik_duvar = None
        self._ilk_arm_tbm = None
        self._bekci = None
        self._kapanis = None
        self.donuk = False
        self.oneri = None               # dron kaydından son ayarlar (drone_sitl_options srvtrig_*)
        self.kullanildi = False         # en az bir kez dinlendi (özet bölümü)
        self._sahte_cikis = None        # sahte kip: servo_set ile verilen çıkışlar

    # ---------------- dışa görünüm ----------------
    def durum(self):
        c = self.cfg or {}
        ch = c.get('ch')
        return {'on': self.on, 'phase': self.phase, 'ch': ch, 'pwm': c.get('pwm'), 'cmp': c.get('cmp'), 'tol': c.get('tol'), 'delay_ms': c.get('delay_ms'),
                'pwm_now': self.pwm[ch - 1] if ch else None, 'fn': list(self.fn), 'trigger': dict(self.trigger) if self.trigger else None,
                'hit': dict(self.hit) if self.hit else None, 'suggest': dict(self.oneri) if self.oneri else None}

    def _yay(self, phase=None):
        self.s._yay({'t': 'servo_trigger', **self.durum(), **({'phase': phase} if phase else {})})

    # ---------------- kancalar ----------------
    def param(self, ad, deger):
        if ad.startswith('SERVO') and ad.endswith('_FUNCTION') and ad[5:-9].isdigit() and 1 <= int(ad[5:-9]) <= KANAL_SAYISI:
            try:
                yeni = int(round(float(deger)))
            except (TypeError, ValueError):
                return
            i = int(ad[5:-9]) - 1
            if self.fn[i] != yeni:
                self.fn[i] = yeni
                if self.s.viewers:
                    self.s._yay({'t': 'servo_trigger', 'phase': 'fn', 'fn': list(self.fn)})

    def islev_iste(self):
        """İlk kalp atışında SERVO1…16_FUNCTION değerlerini iste (kanal etiketleri; PARAM_VALUE → param())."""
        s = self.s
        if s.sahte is not None or not s._heartbeat_alindi:
            return
        for i in range(1, KANAL_SAYISI + 1):
            try:
                s._gonder(s.mav.param_request_read_encode(s.sysid, s.comp, f'SERVO{i}_FUNCTION'.encode(), -1))
            except Exception:   # noqa: BLE001
                return

    def gozlem_mesaj(self, m):
        """SERVO_OUTPUT_RAW (gerçek SITL). port > 0 (servo 17…32 grubu) yok sayılır."""
        if int(getattr(m, 'port', 0) or 0) != 0:
            return
        arr = servo_raw_dizisi(m)
        self.s.tele['servo16'] = arr
        tbm = int(getattr(m, 'time_usec', 0) or 0) // 1000 or None
        self.gozlem(arr, tbm)

    def gozlem(self, arr, tbm=None):
        self.pwm = list(arr)[:KANAL_SAYISI] + [0] * max(0, KANAL_SAYISI - len(arr))
        if not self.on or self.phase != 'listening':
            return
        k = kosul(self.cfg, self.pwm[self.cfg['ch'] - 1])
        if k is None:
            return
        onceki, self._onceki = self._onceki, k
        if onceki is None:   # dinleme sonrası ilk örnek: taban
            if k and not self._zaten_bildirildi:
                self._zaten_bildirildi = True
                self.s._olay(f"Servo tetik: S{self.cfg['ch']} zaten koşulda ({self.pwm[self.cfg['ch'] - 1]} µs {kosul_metni(self.cfg)}) — "
                             'tetik için kanalın koşuldan çıkıp YENİDEN girmesi (yeni komut) bekleniyor', 4)
            return
        if k and not onceki:
            self._tetikle(tbm)

    def adim(self, tbm=None):
        """Her telemetri adımı: ilk ARM saati + gecikme sayacı (simülasyon zamanı)."""
        te = self.s.tele
        t = tbm if tbm is not None else te.get('tbm')
        if self._ilk_arm_tbm is None and te.get('armed') and t is not None:
            self._ilk_arm_tbm = int(t)
        if self.phase == 'pending' and t is not None and self._tetik_tbm is not None:
            if int(t) < self._tetik_tbm:   # SITL saati geri gitti (yeniden başlatma): duvar saatine düş
                self._tetik_tbm = None
            elif int(t) - self._tetik_tbm >= self.cfg['delay_ms']:
                self._carp(int(t))

    # ---------------- olaylar ----------------
    def _an(self, tbm=None):
        """Anlık görüntü (rapor 'tetik anı' / 'çarpma anı')."""
        s, te = self.s, self.s.tele
        home = te.get('home') or ({'lat': s.center.get('lat'), 'lon': s.center.get('lon'), 'alt': s.center.get('alt')} if s.center else {})
        alt_rel = te.get('alt_rel')
        agl_arazi = te.get('terrain_agl')
        t = tbm if tbm is not None else te.get('tbm')
        d = mesafe_m(home.get('lat'), home.get('lon'), te.get('lat'), te.get('lon'))
        r = lambda v, n=1: round(float(v), n) if v is not None else None   # noqa: E731
        return {'t': round(time.time(), 3), 'tbm': int(t) if t is not None else None,
                'lat': r(te.get('lat'), 7), 'lon': r(te.get('lon'), 7), 'alt_msl': r(te.get('alt_msl')), 'alt_rel': r(alt_rel),
                'agl': r(agl_arazi if agl_arazi is not None else alt_rel), 'agl_src': 'terrain' if agl_arazi is not None else 'home',
                'dist_home_m': r(d), 'airspeed': r(te.get('airspeed')), 'groundspeed': r(te.get('groundspeed')), 'heading': r(te.get('heading'), 0),
                'climb': r(te.get('climb')), 'mode': te.get('mode'), 'armed': bool(te.get('armed')),
                'flight_s': round((int(t) - self._ilk_arm_tbm) / 1000.0, 1) if (t is not None and self._ilk_arm_tbm is not None and int(t) >= self._ilk_arm_tbm) else None,
                'pwm': self.pwm[self.cfg['ch'] - 1] if self.cfg else None}

    def _tetikle(self, tbm):
        cfg = self.cfg
        self.seen_pwm = self.pwm[cfg['ch'] - 1]
        self.trigger = self._an(tbm)
        self._tetik_tbm = self.trigger['tbm']
        self._tetik_duvar = time.time()
        self.phase = 'pending'
        t = self.trigger
        self.s._olay(f"SERVO TETİK: S{cfg['ch']} = {self.seen_pwm} µs ({kosul_metni(cfg)}) · AGL {t['agl'] if t['agl'] is not None else '—'} m · "
                     f"evden {t['dist_home_m'] if t['dist_home_m'] is not None else '—'} m — {cfg['delay_ms']} ms sonra çarpma", 4)
        self._statustext(f"SERVO TRIG S{cfg['ch']} {self.seen_pwm}us AGL {t['agl'] or 0:.0f}m D {t['dist_home_m'] or 0:.0f}m", 4)
        self._yay('pending')
        if cfg['delay_ms'] == 0:
            self._carp(tbm if tbm is not None else self.s.tele.get('tbm'))
            return
        loop = self.s.loop
        if loop is not None and not loop.is_closed():
            self._bekci = loop.create_task(self._bekci_gorev(cfg['delay_ms'] / 1000.0 * 2 + 5.0))

    async def _bekci_gorev(self, sure):
        """SITL saati ilerlemezse (dondu / telemetri kesildi) duvar saatiyle çarpma."""
        try:
            await asyncio.sleep(sure)
        except asyncio.CancelledError:
            return
        if self.phase == 'pending':
            self._carp(None, bekci=True)

    def _carp(self, tbm, bekci=False):
        if self.phase != 'pending':
            return
        s = self.s
        self.phase = 'fired'
        if self._bekci is not None and not self._bekci.done() and self._bekci is not asyncio.current_task():
            self._bekci.cancel()
        self.hit = self._an(tbm)
        if self.trigger and self.trigger.get('tbm') is not None and self.hit.get('tbm') is not None:
            self.hit['delay_sim_ms'] = int(self.hit['tbm'] - self.trigger['tbm'])
        self.hit['delay_wall_ms'] = int((time.time() - (self._tetik_duvar or time.time())) * 1000)
        self.hit['watchdog'] = bool(bekci)
        te = s.tele
        hiz = max(float(te.get('airspeed') or 0), float(te.get('groundspeed') or 0))
        s.end_reason = 'servo_trigger'
        try:
            s.gorev.carpisma('servo_trigger', hiz, f"Servo tetik S{self.cfg['ch']} {self.seen_pwm} µs · {self.cfg['delay_ms']} ms")
        except Exception:   # noqa: BLE001 — kayıt hatası çarpmayı durdurmasın
            pass
        self._statustext(f"SERVO HIT S{self.cfg['ch']} AGL {self.hit['agl'] or 0:.0f}m D {self.hit['dist_home_m'] or 0:.0f}m", 2)
        if s.sahte is not None:   # sahte kinematik `crash` sıfırlar (eve ışınlar) → yalnız disarm; görüntü zaten donuyor
            if getattr(s, 'motor_cut', False):
                s._motor_kes(False, olay=False)
            s.sahte.komut('disarm', {})
            s._olay('ÇARPIŞMA — araç zorla disarm edildi', 2)
        else:
            s.zorla_disarm()
        self.donuk = True
        self._yay('fired')
        s._olay(f"SERVO TETİK ÇARPMA: AGL {self.hit['agl'] if self.hit['agl'] is not None else '—'} m · evden {self.hit['dist_home_m'] if self.hit['dist_home_m'] is not None else '—'} m"
                ' — simülasyon bitiriliyor, özet raporu açılacak', 2)
        loop = s.loop
        if loop is not None and not loop.is_closed():
            self._kapanis = loop.create_task(self._kapanis_gorev())

    async def _kapanis_gorev(self):
        """Ön yüz kendi Bitir akışını (kayıt → özet → kapat) çalıştırır; izleyici yoksa / çok beklerse sunucu kapatır."""
        s = self.s
        t0, bos = time.time(), None
        try:
            while s.state != 'KAPANDI':
                await asyncio.sleep(0.5)
                now = time.time()
                if s.viewers:
                    bos = None
                else:
                    bos = bos or now
                if (bos is not None and now - bos >= BOS_KAPANIS_S) or now - t0 >= AZAMI_BEKLEME_S:
                    await s.kapat('servo_trigger')
                    return
        except asyncio.CancelledError:
            return

    def _statustext(self, metin, sev):
        """SITL'e STATUSTEXT (ArduPilot GCS metnini DataFlash MSG'ye yazar → .bin kayıttan oynatmada olay)."""
        s = self.s
        if s.sahte is not None or not s._heartbeat_alindi:
            return
        try:
            s._gonder(s.mav.statustext_encode(int(sev), metin.encode('ascii', 'replace')[:50]))
        except Exception:   # noqa: BLE001
            pass

    # ---------------- komutlar ----------------
    async def komut(self, name, p):
        """`servo_trigger` / `servo_set`. Döner: {'ok', 'servo_trigger': durum}. Hata → ServoTetikHata."""
        s = self.s
        if name == 'servo_set':
            return self._servo_set(p)
        cfg = dogrula(p)
        if self.phase == 'fired':
            raise ServoTetikHata('Servo tetik çalıştı; oturum kapanıyor')
        if not cfg['on']:
            onceki = self.phase
            self.on, self.phase = False, 'idle'
            if self._bekci is not None and not self._bekci.done():
                self._bekci.cancel()
            if onceki in ('listening', 'pending'):
                s._olay('Servo tetik dinlemesi kapatıldı' + (' (bekleyen çarpma iptal)' if onceki == 'pending' else ''), 6)
            self._yay()
            return {'ok': True, 'servo_trigger': self.durum()}
        if s.state != 'HAZIR':
            raise ServoTetikHata('Oturum hazır değil')
        if self._bekci is not None and not self._bekci.done():
            self._bekci.cancel()
        self.cfg, self.on, self.phase = cfg, True, 'listening'
        self._onceki, self._zaten_bildirildi = None, False
        self.trigger, self.hit, self.seen_pwm, self._tetik_tbm = None, None, None, None
        self.kullanildi = True
        ad, _ = islev_adi(self.fn[cfg['ch'] - 1])
        s._olay(f"Servo tetik DİNLENİYOR: S{cfg['ch']}{f' ({ad})' if ad else ''} {kosul_metni(cfg)} · gecikme {cfg['delay_ms']} ms (simülasyon zamanı)", 6)
        self._yay()
        self._drona_yaz(cfg)
        if s.sahte is not None and self._sahte_cikis is not None:   # sahte kip: son verilen çıkış taban örneği
            self.gozlem(self._sahte_cikis, s.tele.get('tbm'))
        return {'ok': True, 'servo_trigger': self.durum()}

    def _servo_set(self, p):
        """`servo_set {ch, pwm}`: gerçek SITL'de MAV_CMD_DO_SET_SERVO (Mission Planner "Servo/Relay" sekmesinin gönderdiği komut);
        sahte kipte sanal çıkış (SERVO_OUTPUT_RAW taklidi) → gözlem. Test ve otomasyon içindir."""
        p = p if isinstance(p, dict) else {}
        ch, pwm = p.get('ch'), p.get('pwm')
        if isinstance(ch, bool) or not isinstance(ch, int) or not (1 <= ch <= KANAL_SAYISI):
            raise ServoTetikHata(f'servo_set.ch 1…{KANAL_SAYISI} olmalı')
        if isinstance(pwm, bool) or not isinstance(pwm, (int, float)) or not (PWM_MIN <= pwm <= PWM_MAX):
            raise ServoTetikHata(f'servo_set.pwm {PWM_MIN}…{PWM_MAX} olmalı')
        s = self.s
        if s.state != 'HAZIR':
            raise ServoTetikHata('Oturum hazır değil')
        if s.sahte is not None:
            arr = list(self._sahte_cikis or self.pwm)
            arr[ch - 1] = int(pwm)
            self._sahte_cikis = arr
            s.tele['servo16'] = list(arr)
            self.gozlem(arr, s.tele.get('tbm'))
            return {'ok': True, 'sim': True}
        if not s._heartbeat_alindi:
            raise ServoTetikHata('SITL henüz kalp atışı göndermedi')
        s._gonder(s.mav.command_long_encode(s.sysid, s.comp, MAV_CMD_DO_SET_SERVO, 0, float(ch), float(pwm), 0, 0, 0, 0, 0))
        return {'ok': True}

    def sifirla(self):
        """Oturum `reset` (SITL yeniden başlar): bekleyen çarpma iptal, dinleme sürer (taban yeniden alınır), ilk ARM saati sıfırlanır."""
        if self._bekci is not None and not self._bekci.done():
            self._bekci.cancel()
        if self.phase == 'pending':
            self.phase = 'listening'
            self.trigger, self._tetik_tbm = None, None
        self._onceki, self._ilk_arm_tbm = None, None

    # ---------------- dron kaydı önerisi ----------------
    def oneri_oku(self):
        d = self.s.drone or {}
        if d.get('id') is None:
            return
        try:
            from . import drone_params
            o = drone_params.secenekleri_oku(d['id'])
        except Exception:   # noqa: BLE001 — SIMUMAV çekirdeğinde tablo olmayabilir
            return
        if o.get('srvtrig_ch'):
            ters = {v: k for k, v in CMP_KOD.items()}
            self.oneri = {'ch': int(o['srvtrig_ch']), 'pwm': int(o.get('srvtrig_pwm') or 1900), 'cmp': ters.get(int(o.get('srvtrig_cmp') or 0), 'ge'),
                          'tol': int(o.get('srvtrig_tol') or TOL_VARSAYILAN), 'delay_ms': int(o.get('srvtrig_delay_ms') or 0)}

    def _drona_yaz(self, cfg):
        d = self.s.drone or {}
        loop = self.s.loop
        if d.get('id') is None or loop is None or loop.is_closed():
            return
        deg = {'srvtrig_ch': cfg['ch'], 'srvtrig_pwm': cfg['pwm'], 'srvtrig_cmp': CMP_KOD[cfg['cmp']], 'srvtrig_tol': cfg['tol'], 'srvtrig_delay_ms': cfg['delay_ms']}
        self.oneri = {k: cfg[k] for k in ('ch', 'pwm', 'cmp', 'tol', 'delay_ms')}

        def yaz():
            try:
                from . import drone_params
                drone_params.secenek_yaz(d['id'], deg, (self.s.owner or {}).get('id'))
            except Exception:   # noqa: BLE001
                pass
        loop.run_in_executor(None, yaz)

    # ---------------- özet ----------------
    def ozet(self):
        if not self.kullanildi or not self.cfg:
            return None
        c = self.cfg
        ad, yuk = islev_adi(self.fn[c['ch'] - 1])
        return {'ch': c['ch'], 'fn': self.fn[c['ch'] - 1], 'fn_name': ad, 'payload': yuk, 'pwm': c['pwm'], 'cmp': c['cmp'], 'tol': c['tol'],
                'delay_ms': c['delay_ms'], 'seen_pwm': self.seen_pwm, 'phase': self.phase, 'listening': self.on and self.phase == 'listening',
                'trigger': dict(self.trigger) if self.trigger else None, 'hit': dict(self.hit) if self.hit else None, 'time_base': 'sim'}
