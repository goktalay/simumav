"""Uçuş Simülatörü — görev izleme, çarpışma kaydı ve özet rapor (docs/ucus-simulatoru.md §18).

Her SimSession'a bir `GorevIzleyici` bağlanır:
- GÖREV: SITL'deki görev iki kaynaktan gelir — HEPGO harekât paneli (`hub_komut mission_upload` → `SimSession._rota_ayarla`) ya da Mission Planner
  (UDP). MP yüklemesi sunucuda MAVLink akışından algılanır: SITL'in MP'ye yolladığı MISSION_ACK (hedef bileşen bizim 191 değil) → 0,4 sn sonra
  görev SITL'den KENDİ indirilir (MavKomut.mission_download; bekleyici kalıbı); MISSION_CURRENT.total bilinen toplamdan farklıysa da indirilir
  (ACK kaçırılmış olabilir); MISSION_CURRENT.seq değişimi `{t:'mission_cur'}` yayınıdır (3B'de aktif bacak). Rota noktalarının `seq` değeri SITL
  seq'idir (ev öğesi 0; HEPGO yüklemesinde ofset eklenir) → MISSION_CURRENT ile birebir eşleşir.
- GÖREV BİTİŞ NOKTASI: görev yüklenince son konumlu öğe (LAND → o konum, RTL → ev, aksi son WP) `mission_end` olayı olarak `drone_sim_events`'e
  yazılır; görev değişirse aynı satır güncellenir.
- ÇARPIŞMA: asıl kaynak SITL FİZİĞİ — STATUSTEXT "SIM Hit ground at X m/s" (X = düşey hız; `statustext_sinifla` → 'sitl_hit'). X ≥ SITL_HIT_HIZ_MIN ve
  araç yerde-durağan değilse `crash` (sebep `sitl_hit`). Yavaş temaslar (taksi zıplaması, iniş, yerde titreşim; PROD'da 0,2–4,3 m/s ile dakikada 8
  sahte kayıt görüldü) çarpışma DEĞİLDİR. ArduPlane'in yazılımsal tespiti ("Crash: Disarming", "Crash detected" → 'autopilot_detect') çarpışma
  sayılmaz: sarı uyarı olayı + `warning` satırı. 3B algılaması (`cmd crash {kind, speed}`): bina/su kesin (SITL bina bilmez); ARAZİ yalnız ADAYDIR —
  ADAY_TEYIT_S içinde SITL "Hit ground" gelirse `crash` (sebep `terrain`), gelmezse yok sayılır (Google karo / SRTM farkı). Sahte kipte 3B doğrudan.
  Çarpışma kaydı aracı zorla disarm eder. CARPISMA_TEKIL_S içinde ikinci bildirim tekilleştirilir (metin ilk kayda eklenir).
- İZ ve ÖZET: `_dongu` 1 Hz'de telemetri izi (en çok TRACK_MAX örnek) + anlık istatistikler (en yüksek AGL/MSL, en yüksek hız, kat edilen mesafe,
  ARM sayısı, havada süre, modlar, batarya). `ozet()` raporu üretir: temel uçuş bilgileri, görev bilgisi, çarpışma, SAPMA (çarpışma ↔ görev bitiş
  noktası yatay mesafe + yükseklik farkı; çarpışma yoksa dronun son konumu ↔ bitiş noktası; iniş dairesi yarıçapıyla karşılaştırma) ve güvenlik notu.
  `GET /sessions/{id}/summary` özeti `summary` olayı olarak kaydeder (oturum başına tek satır, güncellenir); oturum kapanırken de yazılır.
Tablo: drone_sim_events (app/db.py). DB yazımları olay döngüsünü tıkamaz (run_in_executor).
"""
import asyncio
import json
import math
import re
import time

from . import db

TRACK_MAX = 7400            # 1 Hz · 120 dk + pay
TRACK_RAPOR = 600           # rapora giden seyreltilmiş iz örneği sayısı
CARPISMA_TEKIL_S = 30.0     # ikinci bildirim (3B + SITL, yerde sürüklenme temasları) tek kayıt
SITL_HIT_HIZ_MIN = 3.0      # "SIM Hit ground at X m/s": X (düşey hız) bu eşiğin altında → temas, çarpışma değil (iniş ≈ 0,5–1,5; sert iniş 2–3)
YERDE_AGL_M = 1.0           # bu AGL altında ve yer hızı YERDE_HIZ_MS altında hiçbir metin çarpışma sayılmaz
YERDE_HIZ_MS = 3.0
ADAY_TEYIT_S = 3.0          # 3B arazi adayı bu süre içinde SITL temasıyla teyit edilmezse düşer
OTOPILOT_TEKIL_S = 30.0     # ArduPlane yazılımsal tespit uyarısı tekilleştirme
ADAY_OLAY_ARALIK_S = 60.0   # teyitsiz 3B adayı olayı: ilk ikisi hemen, sonra en çok bu aralıkla
INDIR_GECIKME_S = 0.4       # MP MISSION_ACK sonrası indirme gecikmesi (SITL görevi kaydetsin)
MP_TRANSFER_S = 3.0         # SITL→MP MISSION_REQUEST(_INT) görüldükten sonra bu süre MP transferi 'sürüyor' sayılır: toplam-farkı tetiği bastırılır
TOTAL_TETIK_ARALIK_S = 3.0  # MISSION_CURRENT.total farkı kaynaklı indirmeler arası en az süre (ACK tetiği anlıktır)
_HIT_RE = re.compile(r'hit ground at\s*(-?\d+(?:\.\d+)?)')   # SITL SIM_Aircraft: "SIM Hit ground at %f m/s" (velocity_ef.z, m/s)
_OTOPILOT_HARIC = ('crash check', 'no crash', 'crash_dump', 'crash dump')
GCS_COMP = 191              # flightsim.GCS_COMP (döngüsel içe alma olmasın)
SEBEP_ADLARI = {'terrain': 'arazi', 'water': 'su', 'building': 'bina', 'sitl_hit': 'SITL yer teması', 'sitl': 'SITL', 'manual': 'el ile'}


def statustext_sinifla(txt):
    """SITL / ArduPilot STATUSTEXT → ('sitl_hit', düşey hız | None) fiziksel yer teması; ('autopilot_detect', None) ArduPlane yazılımsal çarpışma
    tespiti ("Crash: Disarming", "Crash detected", "Flare crash detected…"); (None, None) ilgisiz. "Crash check"/"crash_dump" metinleri ilgisizdir."""
    low = str(txt or '').lower()
    m = _HIT_RE.search(low)
    if m:
        try:
            return 'sitl_hit', abs(float(m.group(1)))
        except ValueError:
            return 'sitl_hit', None
    if 'hit ground' in low:
        return 'sitl_hit', None
    if 'crash' in low and not any(k in low for k in _OTOPILOT_HARIC):
        return 'autopilot_detect', None
    return None, None


def mesafe_m(lat1, lon1, lat2, lon2):
    """Haversine (m)."""
    try:
        p1, p2 = math.radians(float(lat1)), math.radians(float(lat2))
        dl = math.radians(float(lon2) - float(lon1))
        a = math.sin((p2 - p1) / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
        return 2 * 6371008.8 * math.asin(min(1.0, math.sqrt(a)))
    except (TypeError, ValueError):
        return None


def gorev_bitis(points, home=None):
    """Görevin bitiş noktası: son öğe LAND (21) → o konum (alt_rel 0); RTL (20) → ev; aksi son konumlu nokta. Yoksa None."""
    pts = [p for p in (points or []) if p.get('lat') is not None]
    if not pts:
        return None
    son = pts[-1]
    cmd = int(son.get('cmd') or 0)
    if cmd == 20 and home and home.get('lat') is not None:
        return {'lat': float(home['lat']), 'lon': float(home['lon']), 'alt_rel': 0.0, 'cmd': 20, 'seq': son.get('seq')}
    if cmd == 21:
        return {'lat': float(son['lat']), 'lon': float(son['lon']), 'alt_rel': 0.0, 'cmd': 21, 'seq': son.get('seq')}
    return {'lat': float(son['lat']), 'lon': float(son['lon']), 'alt_rel': float(son.get('alt_rel', son.get('alt')) or 0), 'cmd': cmd, 'seq': son.get('seq')}


def guvenlik_notu(ozet):
    """Rapor 'Güvenlik notu' (Türkçe; ön yüz `safety.code` ile kendi dilinde üretir)."""
    s = ozet.get('safety') or {}
    c = s.get('code')
    d = s.get('dist_m')
    if c == 'crash_deviation':
        return (f"Görev bitiş noktası ile çarpışma arasında {round(d)} m sapma ({SEBEP_ADLARI.get(s.get('reason'), s.get('reason') or '—')}) — "
                "rota irtifası arazi profiline göre gözden geçirilmeli; engel/arazi payı artırılmalı.")
    if c == 'crash_no_mission':
        return f"Görev yüklü değilken çarpışma ({SEBEP_ADLARI.get(s.get('reason'), s.get('reason') or '—')}) — el ile uçuşta irtifa ve hız sınırları gözden geçirilmeli."
    if c == 'in_circle':
        return f"Dron görev bitiş noktasına {round(d)} m mesafede, iniş dairesi içinde — güvenlik açısından uygun."
    if c == 'out_of_circle':
        return f"Dron görev bitiş noktasından {round(d)} m uzakta, iniş dairesi dışında — iniş yaklaşması ve rüzgâr payı gözden geçirilmeli."
    if c == 'no_mission':
        return 'Görev yüklenmedi; sapma hesaplanamadı. Güvenlik değerlendirmesi için görev yükleyip uçuşu yineleyin.'
    return ''


class GorevIzleyici:
    def __init__(self, s):
        self.s = s
        self.started = time.time()
        self.ended = None
        self.track = []                 # [t, lat, lon, alt_msl, alt_rel, gs, mode, armed]
        self.max_agl = 0.0
        self.max_msl = None
        self.max_speed = 0.0
        self.dist_m = 0.0
        self.arm_count = 0
        self.air_s = 0
        self.modes = []
        self.batt = {'first_v': None, 'last_v': None, 'first_pct': None, 'last_pct': None}
        self._armed_prev = False
        self._son = None                # son iz örneği (mesafe için)
        self.source = None              # 'hepgo' | 'mp' | None
        self.mission_total = None       # SITL'deki toplam öğe (ev dâhil); MISSION_CURRENT.total ile karşılaştırılır
        self.mission_seq = None
        self.max_seq = 0
        self.end = None                 # görev bitiş noktası {lat, lon, alt_rel, cmd, seq}
        self.crashes = []
        self._aday = None               # 3B arazi teması adayı {t, kind, speed, …}: SITL "Hit ground" teyidi bekler
        self._aday_task = None
        self._aday_dusen = 0            # teyitsiz düşen 3B arazi adayı sayısı
        self._aday_olay_son = 0.0
        self._otopilot_son = 0.0
        self.warnings = []              # ArduPlane yazılımsal tespit uyarıları (çarpışma değil)
        self._indir_task = None
        self._mp_istek_son = 0.0        # SITL'in MP'ye son MISSION_REQUEST(_INT) gönderme anı (MP yüklemesi sürüyor)
        self._total_ref = None          # son yükleme/indirme SONRASI ilk gözlenen MISSION_CURRENT.total (ArduPilot'un sayımı bizimkiyle birebir olmayabilir)
        self._son_indirme = 0.0
        self.event_ids = {}             # 'mission_end' / 'summary' → drone_sim_events.id
        self.summary_id = None
        self._son_ozet = None           # GET /summary ile üretilen son rapor (kapanışta korunur)

    # ---------------- telemetri izi (1 Hz; SimSession._dongu) ----------------
    def tik(self):
        te = self.s.tele
        now = time.time()
        armed = bool(te.get('armed'))
        if armed and not self._armed_prev:
            self.arm_count += 1
        self._armed_prev = armed
        lat, lon = te.get('lat'), te.get('lon')
        if lat is None or lon is None:
            return
        alt_rel = float(te.get('alt_rel') or 0)
        alt_msl = te.get('alt_msl')
        gs = float(te.get('groundspeed') or 0)
        mode = te.get('mode')
        if armed:
            self.max_agl = max(self.max_agl, alt_rel)
            if alt_msl is not None:
                self.max_msl = alt_msl if self.max_msl is None else max(self.max_msl, float(alt_msl))
            self.max_speed = max(self.max_speed, gs)
            if alt_rel > 1.0:
                self.air_s += 1
            if self._son is not None and self._son[7]:
                d = mesafe_m(self._son[1], self._son[2], lat, lon)
                if d is not None and d < 500:   # sıçrama (reset/set_home) mesafeye girmez
                    self.dist_m += d
        if mode and (not self.modes or self.modes[-1] != mode):
            if mode not in self.modes or self.modes[-1] != mode:
                self.modes.append(mode)
        bv, bp = te.get('batt_v'), te.get('batt_pct')
        if bv is not None and bv > 0:
            if self.batt['first_v'] is None:
                self.batt['first_v'] = bv
            self.batt['last_v'] = bv
        if bp is not None:
            if self.batt['first_pct'] is None:
                self.batt['first_pct'] = bp
            self.batt['last_pct'] = bp
        orn = [round(now, 1), round(float(lat), 7), round(float(lon), 7), round(float(alt_msl), 1) if alt_msl is not None else None, round(alt_rel, 1), round(gs, 1), mode, armed]
        self._son = orn
        if len(self.track) < TRACK_MAX:
            self.track.append(orn)

    # ---------------- MAVLink (SimSession._isle) ----------------
    def mesaj(self, m):
        t = m.get_type()
        if t in ('MISSION_REQUEST', 'MISSION_REQUEST_INT'):
            self._mp_istek_son = time.time()   # görev transferi sürüyor (MP ya da bizim yüklememiz; ArduPilot bu sırada MISSION_CURRENT.total'ı yeni sayıya çeker)
        elif t == 'MISSION_CURRENT':
            seq = int(m.seq)
            total = getattr(m, 'total', 65535)
            now = time.time()
            sakin = now - self._mp_istek_son > MP_TRANSFER_S and now - self._son_indirme > TOTAL_TETIK_ARALIK_S and (self._indir_task is None or self._indir_task.done())
            if total not in (65535, None) and self.s.hub is not None and self.s.sahte is None and sakin:
                total = int(total)
                if self._total_ref is None:
                    self._total_ref = total   # referans: bu görev için SITL'in bildirdiği sayı
                    if total > 1 and not self.s.route and self.mission_total is None:
                        self.indir_planla('mp')   # oturuma geç katıldık / ACK kaçtı: SITL'de görev var ama bizde yok
                elif total != self._total_ref:
                    self._total_ref = None
                    self.indir_planla('mp')   # dış değişiklik (ACK kaçtı): SITL'deki toplam değişti
            if seq != self.mission_seq:
                self.mission_seq = seq
                self.max_seq = max(self.max_seq, seq)
                self.s._yay({'t': 'mission_cur', 'seq': seq, 'total': None if total in (65535, None) else int(total)})
        elif t == 'MISSION_ACK':
            # SITL → Mission Planner yükleme onayı (bize gelen ACK'ların hedef bileşeni GCS_COMP'tur; MP'ninki 190 vb.)
            if int(getattr(m, 'target_component', 0) or 0) != GCS_COMP and int(m.type) == 0 and int(getattr(m, 'mission_type', 0) or 0) == 0:
                self.indir_planla('mp')
        elif t == 'STATUSTEXT':
            txt = str(m.text).rstrip('\x00')
            tur, hiz = statustext_sinifla(txt)
            if tur == 'sitl_hit':
                self.sitl_temas(hiz, txt)
            elif tur == 'autopilot_detect':
                self.otopilot_tespit(txt)

    def indir_planla(self, source='mp'):
        """SITL'den görevi indir (tek seferde bir indirme; kısa gecikme). Sahte kipte bellek içi görev."""
        if self._indir_task is not None and not self._indir_task.done():
            return
        loop = self.s.loop or asyncio.get_event_loop()
        self._indir_task = loop.create_task(self._indir(source))

    async def _indir(self, source):
        from . import flightsim_hub
        s = self.s
        try:
            await asyncio.sleep(INDIR_GECIKME_S)
            if s.state != 'HAZIR':
                return
            if s.sahte is not None:
                res = s._sahte_hub_komut('mission_download', {})
            else:
                res = await s.komutcu.execute('mission_download', {})
            items = res.get('items') or []
            total = int(res.get('count') or (len(items) + 1))
            self._son_indirme = time.time()
            self._total_ref = None
            s._rota_ayarla(flightsim_hub.rota_noktalari(items, offset=1), source=source, total=total)
        except Exception as e:   # noqa: BLE001 — indirme başarısızsa olay; görev çizimi eski kalır
            self._son_indirme = time.time()
            s._olay(f'Görev SITL\'den indirilemedi: {e}'[:200], 4)

    # ---------------- görev değişti (SimSession._rota_ayarla) ----------------
    def transfer(self):
        """Hub görev komutu (mission_upload/clear/download) başlıyor: toplam-farkı tetiği bastırılır."""
        self._mp_istek_son = time.time()

    def rota(self, points, source, total=None):
        self.source = source if points else None
        self.mission_total = total if points else None
        self._total_ref = None
        self._son_indirme = time.time()   # yükleme sonrası kısa süre toplam-farkı tetiği yok (ArduPilot sayımı otursun)
        if not points:
            self.end = None
            self.max_seq = 0
            return
        self.end = gorev_bitis(points, self.s.tele.get('home') or self.s.center)
        if self.end is not None:
            self.end['alt_msl'] = round(self._ev_irtifa() + float(self.end.get('alt_rel') or 0), 1)
            detay = {'source': source, 'count': len(points), 'total': total, 'end': self.end}
            self._kaydet('mission_end', self.end['lat'], self.end['lon'], self.end.get('alt_msl'), self.end.get('alt_rel'), None, None, detay, tekil=True)

    def _ev_irtifa(self):
        h = self.s.tele.get('home')
        if h and h.get('alt') is not None:
            return float(h['alt'])
        return float(self.s.center.get('alt') or 0)

    def yayin_alanlari(self):
        """`{t:'route'}` yayını ve to_dict `mission` için ek alanlar."""
        h = self.s.tele.get('home') or ({'lat': self.s.center.get('lat'), 'lon': self.s.center.get('lon'), 'alt': self.s.center.get('alt')} if self.s.center else None)
        return {'source': self.source, 'home': dict(h) if h else None, 'current': self.mission_seq, 'end': dict(self.end) if self.end else None,
                'landing_circle_m': float((self.s.world or {}).get('landing_circle_m') or 30)}

    # ---------------- çarpışma ----------------
    def yerde_duragan(self):
        te = self.s.tele
        return float(te.get('alt_rel') or 0) < YERDE_AGL_M and float(te.get('groundspeed') or 0) < YERDE_HIZ_MS

    def sitl_temas(self, vz, txt):
        """SITL fiziği yere temas etti ("SIM Hit ground at vz m/s"). 3B arazi adayı bekliyorsa teyit → `terrain` çarpışması; yoksa yalnız sert temas
        (vz ≥ SITL_HIT_HIZ_MIN) ve yerde-durağan değilken `sitl_hit` çarpışması. Diğer temaslar (taksi zıplaması, normal iniş) yok sayılır."""
        now = time.time()
        aday, self._aday = self._aday, None
        if self._aday_task is not None and not self._aday_task.done():
            self._aday_task.cancel()
        if aday is not None and now - aday['t'] <= ADAY_TEYIT_S:
            c = self.carpisma(aday['kind'], max(float(aday.get('speed') or 0), float(vz or 0)), txt, vz=vz)
            self.s.zorla_disarm()
            return c
        if self.crashes and now - self.crashes[-1]['t'] < CARPISMA_TEKIL_S:
            return self.carpisma('sitl_hit', vz, txt, vz=vz)   # az önceki çarpışmanın yer teması (disarm sonrası düşüş/sürüklenme): metin ilk kayda eklenir
        if vz is None:
            vz_ok = float(self.s.tele.get('groundspeed') or 0) >= SITL_HIT_HIZ_MIN
        else:
            vz_ok = vz >= SITL_HIT_HIZ_MIN
        if not vz_ok or self.yerde_duragan():
            return None
        c = self.carpisma('sitl_hit', max(float(vz or 0), float(self.s.tele.get('groundspeed') or 0)), txt, vz=vz)
        self.s.zorla_disarm()
        return c

    def otopilot_tespit(self, txt):
        """ArduPlane yazılımsal çarpışma tespiti (is_flying sezgisi; CRASH_DETECT): çarpışma kaydı DEĞİL — sarı uyarı + `warning` satırı."""
        now = time.time()
        if now - self._otopilot_son < OTOPILOT_TEKIL_S:
            return None
        self._otopilot_son = now
        te = self.s.tele
        w = {'t': round(now, 3), 'reason': 'autopilot_detect', 'text': txt, 'lat': te.get('lat'), 'lon': te.get('lon'), 'alt_rel': te.get('alt_rel'),
             'speed': te.get('groundspeed'), 'mode': te.get('mode')}
        self.warnings.append(w)
        self._kaydet('warning', w['lat'], w['lon'], te.get('alt_msl'), w['alt_rel'], w['speed'], w['mode'], w, tekil=False, t=now)
        self.s._olay(f'Otopilot çarpışma tespiti (ArduPlane yazılımsal): "{txt}" — fiziksel temas değil, çarpışma kaydı yapılmadı', 4)
        self.s._yay({'t': 'warn', 'kind': 'autopilot_detect', 'text': txt, 'ts': round(now, 3)})
        return w

    def ucboyut_bildirim(self, kind, speed, ekstra=None):
        """3B çarpışma algılaması (`cmd crash`). Döner: (kayıt | None, disarm_gerekli). Bina/su ve sahte kip: kesin. Gerçek SITL'de ARAZİ adaydır:
        SITL fiziği ADAY_TEYIT_S içinde "Hit ground" demezse (3B arazi ↔ SITL SRTM farkı) yok sayılır ve sarı olay yazılır."""
        kind = kind or 'manual'
        if kind != 'terrain' or self.s.sahte is not None:
            return self.carpisma(kind, speed), True
        now = time.time()
        if self.crashes and now - self.crashes[-1]['t'] < CARPISMA_TEKIL_S:
            return self.crashes[-1], False
        self._aday = {'t': now, 'kind': kind, 'speed': speed, 'extra': dict(ekstra or {})}
        if self._aday_task is not None and not self._aday_task.done():
            self._aday_task.cancel()
        loop = self.s.loop or asyncio.get_event_loop()
        self._aday_task = loop.create_task(self._aday_dusur())
        return None, False

    async def _aday_dusur(self):
        try:
            await asyncio.sleep(ADAY_TEYIT_S)
        except asyncio.CancelledError:
            return
        a, self._aday = self._aday, None
        if a is None:
            return
        self._aday_dusen += 1
        now = time.time()
        if self._aday_dusen <= 2 or now - self._aday_olay_son >= ADAY_OLAY_ARALIK_S:   # olay şeridi spam'i yok: ilk ikisi hemen, sonra en çok dakikada bir (sayaçla)
            self._aday_olay_son = now
            self.s._olay(f"3B arazi teması ({float(a.get('speed') or 0):.1f} m/s) SITL fiziğiyle doğrulanmadı — çarpışma sayılmadı (3B arazi ↔ SITL arazi verisi farkı; toplam {self._aday_dusen})", 4)

    def carpisma(self, sebep, hiz=None, detay_metin=None, vz=None):
        now = time.time()
        if self.crashes and now - self.crashes[-1]['t'] < CARPISMA_TEKIL_S:
            c = self.crashes[-1]
            if detay_metin and not c.get('sitl_text'):
                c['sitl_text'] = detay_metin   # 3B kaydına SITL metni eklenir
            return c
        te = self.s.tele
        hiz = float(hiz) if hiz is not None else float(te.get('groundspeed') or 0)
        c = {'t': round(now, 3), 'lat': te.get('lat'), 'lon': te.get('lon'), 'alt_msl': te.get('alt_msl'), 'alt_rel': te.get('alt_rel'),
             'speed': round(hiz, 2), 'mode': te.get('mode'), 'reason': sebep or 'manual', 'target_seq': self.mission_seq,
             'mission_end': dict(self.end) if self.end else None, 'sitl_text': detay_metin, 'sitl_vz': round(float(vz), 2) if vz is not None else None}
        if self.end and c['lat'] is not None:
            c['deviation_m'] = round(mesafe_m(c['lat'], c['lon'], self.end['lat'], self.end['lon']) or 0, 1)
            c['dz_m'] = round(float(c.get('alt_rel') or 0) - float(self.end.get('alt_rel') or 0), 1)
        self.crashes.append(c)
        self._kaydet('crash', c['lat'], c['lon'], c['alt_msl'], c['alt_rel'], c['speed'], c['mode'], c, tekil=False, t=now)
        self.s._yay({**c, 'ts': c['t'], 't': 'crash'})   # ('t' çerçeve türü; olay anı 'ts')
        return c

    # ---------------- özet ----------------
    def ozet(self):
        s = self.s
        te = s.tele
        now = self.ended or time.time()
        from . import flightsim
        crash = self.crashes[-1] if self.crashes else None
        son = {'lat': te.get('lat'), 'lon': te.get('lon'), 'alt_msl': te.get('alt_msl'), 'alt_rel': te.get('alt_rel')}
        R = float((s.world or {}).get('landing_circle_m') or 30) / 2
        sapma = None
        safety = {'code': 'no_mission'}
        if self.end:
            if crash and crash.get('lat') is not None:
                d = mesafe_m(crash['lat'], crash['lon'], self.end['lat'], self.end['lon'])
                sapma = {'from': 'crash', 'dist_m': round(d or 0, 1), 'dz_m': round(float(crash.get('alt_rel') or 0) - float(self.end.get('alt_rel') or 0), 1), 'in_circle': (d or 0) <= R}
                safety = {'code': 'crash_deviation', 'dist_m': sapma['dist_m'], 'reason': crash.get('reason')}
            elif son['lat'] is not None:
                d = mesafe_m(son['lat'], son['lon'], self.end['lat'], self.end['lon'])
                sapma = {'from': 'last', 'dist_m': round(d or 0, 1), 'dz_m': round(float(son.get('alt_rel') or 0) - float(self.end.get('alt_rel') or 0), 1), 'in_circle': (d or 0) <= R}
                safety = {'code': 'in_circle' if sapma['in_circle'] else 'out_of_circle', 'dist_m': sapma['dist_m']}
        elif crash:
            safety = {'code': 'crash_no_mission', 'reason': crash.get('reason')}
        pts = list(s.route or [])
        completed = len([p for p in pts if int(p.get('seq') or 0) < self.max_seq]) if pts else 0
        adim = max(1, len(self.track) // TRACK_RAPOR)
        iz = [[o[0], o[1], o[2], o[4]] for o in self.track[::adim]]
        if self.track and iz and iz[-1][0] != self.track[-1][0]:
            o = self.track[-1]
            iz.append([o[0], o[1], o[2], o[4]])
        model = s.model or {}
        drone = s.drone or {}
        out = {
            'v': 1, 'session_id': s.id, 'created_at': s.created_at, 'ended_at': db.now() if self.ended else None, 'end_reason': s.end_reason,
            'owner': dict(s.owner) if s.owner else None,
            'session': {'type': s.type, 'type_name': flightsim.TIP_ADLARI.get(s.type, s.type), 'model': model.get('name') or model.get('id'),
                        'drone': {'code': drone.get('code'), 'name': drone.get('name'), 'model': drone.get('model')} if drone else None,
                        'center': dict(s.center) if s.center else None, 'world_mode': (s.world or {}).get('mode'), 'world_time': (s.world or {}).get('time'),
                        'launch': dict(s.launch) if getattr(s, 'launch', None) else None, 'landing_circle_m': R * 2,
                        'layout': getattr(s, 'layout', None), 'layout_effective': getattr(s, 'layout_etkin', None), 'layout_sitl_model': getattr(s, 'layout_sitl_model', None),
                        'wind_ms': (s.world or {}).get('wind_ms'), 'wind_dir': (s.world or {}).get('wind_dir')},
            'flight': {'start_ts': round(self.started, 1), 'end_ts': round(now, 1), 'duration_s': int(now - self.started), 'air_s': self.air_s,
                       'max_agl': round(self.max_agl, 1), 'max_msl': round(self.max_msl, 1) if self.max_msl is not None else None, 'max_speed': round(self.max_speed, 1),
                       'dist_m': round(self.dist_m, 1), 'arm_count': self.arm_count, 'modes': list(self.modes), 'last_mode': te.get('mode'),
                       'batt': dict(self.batt), 'last_pos': son, 'home': dict(te['home']) if te.get('home') else None, 'armed': bool(te.get('armed'))},
            'mission': {'source': self.source, 'count': len(pts), 'completed': completed, 'end': dict(self.end) if self.end else None, 'points': pts,
                        'current': self.mission_seq, 'total': self.mission_total} if pts else None,
            'crash': crash, 'crash_count': len(self.crashes), 'autopilot_detect_count': len(self.warnings), 'deviation': sapma, 'safety': safety, 'track': iz,
            # §23 güç ve yakıt: ayarlar + harcanan yakıt / ölçülen km/L + batarya Wh / ortalama W + simülasyon hızı (GucDurumu.ozet; kayıttan oynatmada yok)
            'power': s.guc.ozet() if getattr(s, 'guc', None) is not None else None,
            # §24 hedefler: önleme sayısı / ilk önleme süresi / en yakın geçiş + puan ve rozetler (kayıttan oynatmada istemci yeniden hesaplar)
            'targets': s.hedef_iz.ozet() if getattr(s, 'hedef_iz', None) is not None else None,
        }
        out['safety_note'] = guvenlik_notu(out)
        return out

    def ozet_kaydet_sync(self, ozet):
        """`summary` olayı: oturum başına tek satır (güncellenir). Döner: satır id."""
        c = ozet.get('crash') or {}
        son = (ozet.get('flight') or {}).get('last_pos') or {}
        lat, lon = (c.get('lat'), c.get('lon')) if c else (son.get('lat'), son.get('lon'))
        rid = self._kaydet_sync('summary', lat, lon, son.get('alt_msl'), son.get('alt_rel'), (ozet.get('flight') or {}).get('max_speed'),
                                (ozet.get('flight') or {}).get('last_mode'), ozet, tekil=True, t=time.time())
        self.summary_id = rid
        return rid

    async def ozet_kaydet(self):
        o = self.ozet()
        loop = asyncio.get_running_loop()
        rid = await loop.run_in_executor(None, self.ozet_kaydet_sync, o)
        o['id'] = rid
        self._son_ozet = o
        return o

    async def kapanis(self):
        """Oturum kapanırken (her nedenle): bitiş zamanı + özet satırı."""
        if self.ended is not None:
            return
        self.ended = time.time()
        if self._aday_task is not None and not self._aday_task.done():
            self._aday_task.cancel()
        if not self.track and not self.crashes and not self.s.route:
            return   # hiç telemetri gelmedi (SITL açılamadı): rapor anlamsız
        try:
            son = getattr(self, '_son_ozet', None)
            if son is not None and self.summary_id:
                # Bitir'de gösterilen rapor korunur (kullanıcının gördüğüyle kayıt aynı kalsın); yalnız bitiş alanları güncellenir
                son = dict(son)
                son.update(ended_at=db.now(), end_reason=self.s.end_reason)
                son['flight'] = {**son.get('flight', {}), 'end_ts': round(self.ended, 1), 'duration_s': int(self.ended - self.started)}
                await asyncio.get_running_loop().run_in_executor(None, self.ozet_kaydet_sync, son)
            else:
                await self.ozet_kaydet()
        except Exception:   # noqa: BLE001 — kapanış DB hatasıyla bozulmaz
            pass

    # ---------------- DB ----------------
    def _kaydet(self, tur, lat, lon, alt_msl, alt_rel, speed, mode, detail, tekil, t=None):
        loop = self.s.loop
        if loop is None or loop.is_closed():
            return
        loop.run_in_executor(None, self._kaydet_sync, tur, lat, lon, alt_msl, alt_rel, speed, mode, detail, tekil, t)

    def _kaydet_sync(self, tur, lat, lon, alt_msl, alt_rel, speed, mode, detail, tekil, t=None):
        s = self.s
        owner = (s.owner or {}).get('id')
        try:
            with db.connect() as conn:
                dj = json.dumps(detail, ensure_ascii=False, default=str)
                rid = self.event_ids.get(tur) if tekil else None
                if rid:
                    conn.execute('UPDATE drone_sim_events SET lat=?, lon=?, alt_msl=?, alt_rel=?, t=?, speed=?, mode=?, detail=? WHERE id=?',
                                 (lat, lon, alt_msl, alt_rel, t, speed, mode, dj, rid))
                else:
                    cur = conn.execute('''INSERT INTO drone_sim_events (session_id, owner_id, type, lat, lon, alt_msl, alt_rel, t, speed, mode, detail, created_at)
                                          VALUES (?,?,?,?,?,?,?,?,?,?,?,?)''', (s.id, owner, tur, lat, lon, alt_msl, alt_rel, t, speed, mode, dj, db.now()))
                    rid = cur.lastrowid
                    if tekil:
                        self.event_ids[tur] = rid
                conn.commit()
                return rid
        except Exception:   # noqa: BLE001 — kayıt hatası simülasyonu durdurmaz
            return None


# ---------------- raporlar (router) ----------------
def raporlar(conn, limit=20, owner_id=None):
    """Son özet raporları (type 'summary'), yeniden eskiye. Satır: id, session_id, owner, created_at, kısa alanlar (detail içinden)."""
    limit = max(1, min(100, int(limit or 20)))
    sql = '''SELECT e.id, e.session_id, e.owner_id, u.full_name AS owner_name, e.created_at, e.detail FROM drone_sim_events e
             LEFT JOIN users u ON u.id = e.owner_id WHERE e.type = 'summary' '''
    args = []
    if owner_id is not None:
        sql += ' AND e.owner_id = ?'
        args.append(owner_id)
    sql += ' ORDER BY e.id DESC LIMIT ?'
    args.append(limit)
    out = []
    for r in db.rows(conn.execute(sql, args)):
        try:
            d = json.loads(r.get('detail') or '{}')
        except ValueError:
            d = {}
        ses, fl, dev = d.get('session') or {}, d.get('flight') or {}, d.get('deviation') or {}
        out.append({'id': r['id'], 'session_id': r['session_id'], 'owner_id': r['owner_id'], 'owner_name': r['owner_name'] or (d.get('owner') or {}).get('name'),
                    'created_at': r['created_at'], 'type': ses.get('type'), 'type_name': ses.get('type_name'), 'center': (ses.get('center') or {}).get('name'),
                    'world_mode': ses.get('world_mode'), 'duration_s': fl.get('duration_s'), 'max_agl': fl.get('max_agl'), 'dist_m': fl.get('dist_m'),
                    'crash': bool(d.get('crash')), 'deviation_m': dev.get('dist_m'), 'in_circle': dev.get('in_circle'), 'mission': bool(d.get('mission')),
                    'safety_code': (d.get('safety') or {}).get('code'), 'end_reason': d.get('end_reason')})
    return out


def rapor(conn, rid):
    r = db.row(conn.execute("SELECT id, session_id, owner_id, created_at, detail FROM drone_sim_events WHERE id = ? AND type = 'summary'", (rid,)))
    if not r:
        return None
    try:
        d = json.loads(r['detail'] or '{}')
    except ValueError:
        d = {}
    d['id'] = r['id']
    d['saved_at'] = r['created_at']
    d.setdefault('owner', {'id': r['owner_id']})
    return d


def rapor_metni(d):
    """Şirketten Haberler paylaşımı için Türkçe özet (istemci kendi dilinde `text` gönderebilir)."""
    ses, fl, ms, cr, dev = d.get('session') or {}, d.get('flight') or {}, d.get('mission') or {}, d.get('crash'), d.get('deviation') or {}
    sat = [f"Uçuş Simülatörü raporu · {ses.get('type_name') or ses.get('type') or '—'} · {(ses.get('center') or {}).get('name') or '—'} · "
           f"{int((fl.get('duration_s') or 0) // 60)} dk {int((fl.get('duration_s') or 0) % 60)} sn"]
    sat.append(f"En yüksek AGL {fl.get('max_agl') or 0} m · en yüksek hız {fl.get('max_speed') or 0} m/s · mesafe {round((fl.get('dist_m') or 0) / 1000, 2)} km · ARM {fl.get('arm_count') or 0}")
    if ms:
        e = ms.get('end') or {}
        sat.append(f"Görev: {ms.get('count')} WP ({'Mission Planner' if ms.get('source') == 'mp' else 'HEPGO'}) · bitiş {e.get('lat')}, {e.get('lon')}")
    if cr:
        sat.append(f"ÇARPIŞMA: {cr.get('lat')}, {cr.get('lon')} · {cr.get('speed')} m/s · {SEBEP_ADLARI.get(cr.get('reason'), cr.get('reason'))}")
    if dev:
        sat.append(f"Sapma: {dev.get('dist_m')} m yatay, {dev.get('dz_m')} m dikey" + (' · iniş dairesi içinde' if dev.get('in_circle') else ''))
    pw = d.get('power') or {}
    if pw.get('fuel') or pw.get('elec'):   # §23
        parca = []
        f, e = pw.get('fuel') or {}, pw.get('elec') or {}
        if f:
            parca.append(f"yakıt {f.get('used_l')} L / {f.get('start_l')} L" + (f" · ölçülen {f.get('km_per_l')} km/L" if f.get('km_per_l') else '') + (' · YAKIT BİTTİ' if f.get('empty_t') is not None else ''))
        if e:
            parca.append(f"batarya {e.get('wh_used')} Wh / {e.get('wh_cap')} Wh" + (f" · ortalama {e.get('w_avg')} W" if e.get('w_avg') else '') + (' · BATARYA BİTTİ' if e.get('empty_t') is not None else ''))
        if (pw.get('settings') or {}).get('max_speed_ms'):
            parca.append(f"azami hız {pw['settings']['max_speed_ms']:g} m/s (en yüksek {pw.get('max_speed_seen')} m/s)")
        if (pw.get('speedup') or {}).get('max', 1) > 1:
            parca.append(f"simülasyon hızı en çok {pw['speedup']['max']:g}×")
        sat.append('Güç ve yakıt: ' + ' · '.join(parca))
    if d.get('safety_note'):
        sat.append(f"Güvenlik notu: {d['safety_note']}")
    return '\n'.join(sat)
