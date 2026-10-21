"""Uçuş Simülatörü — ÇOK OYUNCULU KARŞILAŞMA çekirdeği (SAF; docs/ucus-simulatoru.md §33).

Platformdan bağımsızdır: veritabanı, ağ, asyncio, kullanıcı/yetki ya da bildirim YOKTUR — zaman (`now`, Unix sn) ve konumlar dışarıdan verilir.
HEPGO çalışma zamanı `app/flightsim_match.py` (SITL oturumları, WS yayını, DB, davet bildirimi) ve SIMUMAV aşama 2 aynı modülü kullanır.

İçerik
  · halka ayarı doğrulama (`halka_ayar_dogrula`) ve deterministik halka üretimi (`halkalar_uret`): parkur merkezinin çevresinde, tohumlu, numaralı
    ve sıralı; yükseklikler [min, max] aralığına eşit adımla dağılır (karıştırılır → "farklı yüksekliklerde"), her halkanın düzlem normali bir
    önceki halkadan (ilk halkada başlangıç ağırlık merkezinden) bu halkaya doğru → sırayla uçan oyuncu halkayı DOĞRU yönde keser.
  · başlangıç noktaları (`baslangic_noktalari`): aynı dünya/merkez, oyuncu başına farklı nokta (≥ AYRIK_M); dikey kalkanlar merkez çevresinde
    eşit aralıklı çember, sabit kanat pist yönüne DİK şeritlerde (pist yönünde, yan yana kalkış koridoru).
  · geçiş tespiti (`HalkaIzleyici`): ardışık iki konum (yerel ENU) halka düzlemini −→+ yönde keserse ve kesişim noktası halka yarıçapı içindeyse
    geçiş; yalnız SIRADAKİ halka denetlenir; ters yön ve dışından geçiş sayılmaz; sıçrama (reset / ışınlanma, > SICRAMA_M) yok sayılır.
  · karşılaşma durum makinesi (`Karsilasma`): LOBI → HAZIRLIK → GERI_SAYIM → YARIS → BITTI (+ IPTAL). İlk tüm halkaları bitiren birinci olur ve
    karşılaşma o anda biter; süre sınırı dolarsa da biter (birinci = en çok ilerleyen).
  · sıralama (`siralama`): bitirenler süreyle; bitirmeyenler geçtiği halka sayısı (çok → önde) + sıradaki halkaya mesafe (az → önde);
    yarışa katılmayanlar (çıkarılan / düşen / ayrılan) sonda.
  · §41 İT DALAŞI türü (`tur='dogfight'`; tam 2 oyuncu, roller KOVALAYAN / KAÇAN): ayar doğrulama (`it_ayar_dogrula`), başlangıç noktaları
    (`it_baslangiclari`: aynı hat üstünde mesafe kadar ayrık, kaçan önde, ikisi aynı yöne bakar), angajman izleyicisi (`ItDalasi`: kovalayan kaçanı
    menzil + burun konisi içinde gerekli süre KESİNTİSİZ tutarsa ANGAJE → kovalayan kazanır; süre biterse kaçan; alan dışı / çarpan kaybeder;
    iki araç da başlangıç irtifasına yaklaşana dek — en geç KORUMA_S — angajman sayılmaz: SITL'de araçlar yerden kalkar). Kapsam: yalnız oyun
    mekaniği; araca güdüm/takip komutu yoktur.
"""
import math
import random

# ---------------------------------------------------------------- sınırlar / varsayılanlar
OYUNCU_MAX = 8                   # kurucu dahil
DAVET_MIN = 1                    # en az 1 davetli (kurucu + 1 = 2 oyuncu)
HALKA_SAYI = (1, 30)
HALKA_SAYI_VARSAYILAN = 8
YUKSEKLIK = (5.0, 400.0)         # m, parkur merkezinin zemininden (pist seviyesi 0)
YUKSEKLIK_VARSAYILAN = {'dikey': (15.0, 60.0), 'ucak': (40.0, 140.0)}
CAP = (4.0, 80.0)                # halka çapı (m)
CAP_VARSAYILAN = {'dikey': 12.0, 'ucak': 36.0}
PARKUR = (80.0, 3000.0)          # parkur yarıçapı (m): halkalar merkezden 0,45R…R uzaklıkta
PARKUR_VARSAYILAN = {'dikey': 220.0, 'ucak': 700.0}
SURE_DK = (2, 60)                # yarış süre sınırı (dk)
SURE_DK_VARSAYILAN = 15
GERI_SAYIM_S = 6.0               # tüm oyuncular hazır → yarış başlangıcı (istemcide son 3 sn giriş sekansı 3‑2‑1)
HAZIRLIK_ZAMAN_ASIMI_S = 150.0   # SITL açılışı + 3B dünya; hazır olmayan oyuncu düşer
LOBI_ZORLA_S = 60.0              # kurucu "gelmeyenler olmadan başlat"ı bu süreden sonra kullanabilir
LOBI_ZAMAN_ASIMI_S = 30 * 60.0   # kimse başlatmazsa lobi iptal
AYRIK_M = 40.0                   # başlangıç noktaları arası en az mesafe
SICRAMA_M = 250.0                # tek adımda bundan büyük yer değişimi (reset/ışınlanma) geçiş sayılmaz
DIKEY_TIPLER = ('multirotor', 'hexarotor', 'helikopter', 'vtol', 'interceptor')
UCAK_TIPLER = ('sabit_kanat',)
TIPLER = DIKEY_TIPLER + UCAK_TIPLER   # kara aracı (rover) havadaki halkalardan geçemez → karşılaşmada yok

# §41 karşılaşma türleri
TUR_HALKA, TUR_IT = 'rings', 'dogfight'
TURLER = (TUR_HALKA, TUR_IT)
IT_MESAFE = (300.0, 1500.0)      # başlangıçta aradaki mesafe (m)
IT_IRTIFA = (20.0, 400.0)        # başlangıç irtifası (m, merkez zemininden)
IT_SURE_DK = (2, 10)
IT_MENZIL = (50.0, 400.0)        # angajman menzili (m)
IT_KONI = (15.0, 45.0)           # kovalayanın burnundan ±açı (°)
IT_TUTMA = (2.0, 5.0)            # kesintisiz tutma süresi (sn)
IT_ALAN = (300.0, 5000.0)        # alan sınırı yarıçapı (m, merkezden yatay)
IT_ROLLER = ('random', 'host_chaser', 'host_evader')
IT_VARSAYILAN = {'dikey': {'distance_m': 400.0, 'alt_m': 40.0, 'time_limit_min': 5, 'range_m': 120.0, 'cone_deg': 30.0, 'hold_s': 3.0, 'area_radius_m': 800.0},
                 'ucak': {'distance_m': 1000.0, 'alt_m': 120.0, 'time_limit_min': 6, 'range_m': 300.0, 'cone_deg': 25.0, 'hold_s': 3.0, 'area_radius_m': 3000.0}}
KORUMA_S = 60.0                  # kalkış koruması: iki araç da başlangıç irtifasının KORUMA_ORAN'ına çıkana ya da bu süre dolana dek angajman sayılmaz
KORUMA_ORAN = 0.8
TELE_BAYAT_S = 2.0               # iki oyuncunun konum örnekleri arasında en çok fark (daha eskisiyle angajman hesaplanmaz)
KOVALAYAN, KACAN = 'chaser', 'evader'

# durumlar
LOBI, HAZIRLIK, GERI_SAYIM, YARIS, BITTI, IPTAL = 'LOBI', 'HAZIRLIK', 'GERI_SAYIM', 'YARIS', 'BITTI', 'IPTAL'
SON_DURUMLAR = (BITTI, IPTAL)
# oyuncu durumları
DAVETLI, GELDI, HAZIRLANIYOR, HAZIR, AYRILDI, CIKARILDI, DUSTU = 'davetli', 'geldi', 'hazirlaniyor', 'hazir', 'ayrildi', 'cikarildi', 'dustu'
KATILMAYAN = (AYRILDI, CIKARILDI, DUSTU)

R_DUNYA = 6378137.0


class MacHata(Exception):
    def __init__(self, kod, mesaj):
        super().__init__(mesaj)
        self.kod = kod   # invalid | forbidden | conflict | notfound | limit


def sinif(tip):
    return 'ucak' if tip in UCAK_TIPLER else 'dikey'


# ---------------------------------------------------------------- koordinat
def enu(lat0, lon0, lat, lon):
    """(lat, lon) → merkez (lat0, lon0) referanslı yerel doğu/kuzey (m); eşdikdörtgen (≤ birkaç km'de hata < 1 m)."""
    x = math.radians(float(lon) - float(lon0)) * R_DUNYA * math.cos(math.radians(float(lat0)))
    y = math.radians(float(lat) - float(lat0)) * R_DUNYA
    return x, y


def latlon(lat0, lon0, x, y):
    lat = float(lat0) + math.degrees(float(y) / R_DUNYA)
    lon = float(lon0) + math.degrees(float(x) / (R_DUNYA * math.cos(math.radians(float(lat0)))))
    return lat, lon


# ---------------------------------------------------------------- halka ayarı
def _sayi(v, ad, a, b, tam=False):
    if isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(float(v)):
        raise MacHata('invalid', f'{ad} sayı olmalı')
    v = float(v)
    if tam and v != int(v):
        raise MacHata('invalid', f'{ad} tam sayı olmalı')
    if not (a <= v <= b):
        raise MacHata('invalid', f'{ad} {a:g}…{b:g} olmalı')
    return int(v) if tam else v


def halka_ayar_varsayilan(tip):
    s = sinif(tip)
    lo, hi = YUKSEKLIK_VARSAYILAN[s]
    return {'count': HALKA_SAYI_VARSAYILAN, 'min_alt_m': lo, 'max_alt_m': hi, 'diameter_m': CAP_VARSAYILAN[s], 'radius_m': PARKUR_VARSAYILAN[s],
            'time_limit_min': SURE_DK_VARSAYILAN, 'seed': None}


def halka_ayar_dogrula(r, tip):
    """{count, min_alt_m, max_alt_m, diameter_m?, radius_m?, time_limit_min?, seed?} → normalize sözlük (eksikler tipin varsayılanı). Hata → MacHata."""
    if tip not in TIPLER:
        raise MacHata('invalid', 'Karşılaşmada bu araç tipi yok (halkalar havada; kara aracı seçilemez)')
    v = halka_ayar_varsayilan(tip)
    if r is None:
        r = {}
    if not isinstance(r, dict):
        raise MacHata('invalid', 'rings nesne olmalı')
    if r.get('count') is not None:
        v['count'] = _sayi(r['count'], 'Halka sayısı', *HALKA_SAYI, tam=True)
    if r.get('min_alt_m') is not None:
        v['min_alt_m'] = _sayi(r['min_alt_m'], 'Minimum yükseklik', *YUKSEKLIK)
    if r.get('max_alt_m') is not None:
        v['max_alt_m'] = _sayi(r['max_alt_m'], 'Maksimum yükseklik', *YUKSEKLIK)
    if v['min_alt_m'] > v['max_alt_m']:
        raise MacHata('invalid', 'Minimum yükseklik maksimum yükseklikten büyük olamaz')
    if r.get('diameter_m') is not None:
        v['diameter_m'] = _sayi(r['diameter_m'], 'Halka çapı', *CAP)
    if r.get('radius_m') is not None:
        v['radius_m'] = _sayi(r['radius_m'], 'Parkur yarıçapı', *PARKUR)
    if r.get('time_limit_min') is not None:
        v['time_limit_min'] = _sayi(r['time_limit_min'], 'Süre sınırı', *SURE_DK, tam=True)
    if r.get('seed') is not None:
        v['seed'] = _sayi(r['seed'], 'Tohum', 1, 2 ** 31 - 1, tam=True)
    return v


# ---------------------------------------------------------------- §41 it dalaşı ayarı
def it_ayar_varsayilan(tip):
    return {'type': TUR_IT, **IT_VARSAYILAN[sinif(tip)], 'roles': 'random', 'seed': None}


def it_ayar_dogrula(r, tip):
    """{distance_m, alt_m, time_limit_min, range_m, cone_deg, hold_s, area_radius_m, roles, seed} → normalize (eksikler tip sınıfının varsayılanı)."""
    if tip not in TIPLER:
        raise MacHata('invalid', 'Karşılaşmada bu araç tipi yok (kara aracı seçilemez)')
    v = it_ayar_varsayilan(tip)
    if r is None:
        r = {}
    if not isinstance(r, dict):
        raise MacHata('invalid', 'İt dalaşı ayarı nesne olmalı')
    for k, ad, sinir, tam in (('distance_m', 'Başlangıç mesafesi', IT_MESAFE, False), ('alt_m', 'Başlangıç irtifası', IT_IRTIFA, False),
                              ('time_limit_min', 'Süre', IT_SURE_DK, True), ('range_m', 'Angajman menzili', IT_MENZIL, False),
                              ('cone_deg', 'Angajman konisi', IT_KONI, False), ('hold_s', 'Angajman süresi', IT_TUTMA, False),
                              ('area_radius_m', 'Alan sınırı yarıçapı', IT_ALAN, False)):
        if r.get(k) is not None:
            v[k] = _sayi(r[k], ad, *sinir, tam=tam)
    if r.get('area_radius_m') is None:   # varsayılan alan, mesafeye yetmezse büyür
        v['area_radius_m'] = max(v['area_radius_m'], min(IT_ALAN[1], v['distance_m'] / 2 + 400.0))
    if v['area_radius_m'] < v['distance_m'] / 2 + 150.0:
        raise MacHata('invalid', 'Alan sınırı yarıçapı başlangıç mesafesinin yarısından en az 150 m büyük olmalı')
    if r.get('roles') is not None:
        if r['roles'] not in IT_ROLLER:
            raise MacHata('invalid', f"Roller {' | '.join(IT_ROLLER)} olmalı")
        v['roles'] = r['roles']
    if r.get('seed') is not None:
        v['seed'] = _sayi(r['seed'], 'Tohum', 1, 2 ** 31 - 1, tam=True)
    v['vclass'] = sinif(tip)
    return v


def it_baslangiclari(ayar, tip, pist_yonu=0.0):
    """{rol: (x, y, yaw_deg)}: iki araç merkezden geçen ortak hatta `distance_m` ayrık, ikisi de hat yönüne bakar → KAÇAN önde, KOVALAYAN
    arkada. Hat yönü sabit kanatta pist yönü (kalkış koridoru), dikeyde tohumdan."""
    if tip in UCAK_TIPLER:
        yon = float(pist_yonu or 0) % 360
    else:
        yon = round(random.Random(int(ayar.get('seed') or 1) * 7 + 3).uniform(0, 360), 1)
    h = math.radians(yon)
    fx, fy = math.sin(h), math.cos(h)
    d = float(ayar['distance_m']) / 2.0
    return {KOVALAYAN: (round(-fx * d, 2), round(-fy * d, 2), yon), KACAN: (round(fx * d, 2), round(fy * d, 2), yon)}


def burun(heading_deg, pitch_rad, vclass):
    """Burun birim vektörü (ENU). Sabit kanatta yunuslama dahil; dikey kalkanlarda gövde eğimi burun yönü değildir → yatay (yön)."""
    h = math.radians(float(heading_deg or 0))
    p = float(pitch_rad or 0) if vclass == 'ucak' else 0.0
    return (math.sin(h) * math.cos(p), math.cos(h) * math.cos(p), math.sin(p))


def koni_acisi(nose, d):
    """Burun vektörü ile görüş hattı d arasındaki açı (°)."""
    L = math.sqrt(d[0] ** 2 + d[1] ** 2 + d[2] ** 2)
    if L < 1e-6:
        return 0.0
    c = (nose[0] * d[0] + nose[1] * d[1] + nose[2] * d[2]) / L
    return math.degrees(math.acos(max(-1.0, min(1.0, c))))


class ItDalasi:
    """§41 angajman izleyicisi. `konum(rol, x, y, z_rel, heading_deg, pitch_rad, t)` → olay listesi: {'kind': 'engage', ...} (kazanan kovalayan),
    {'kind': 'area', 'role'} (alan dışı → o rol kaybeder), {'kind': 'lock_on' | 'lock_off'} (koniye giriş / çıkış; kaçana uyarı). Zaman t (sn,
    duvar saati — karşılaşmada simülasyon hızı 1×). `durum()` HUD için anlık ölçüler."""

    def __init__(self, ayar, t0):
        self.a = dict(ayar)
        self.t0 = float(t0)
        self.poz = {}                 # rol → (x, y, z, heading, pitch, t)
        self.tutma = 0.0              # kesintisiz koni içi süre
        self.tutma_azami = 0.0
        self.koni_toplam = 0.0
        self.min_mesafe = None
        self.son_t = None
        self.koni_ici = False
        self.koruma = True
        self.bitti = False
        self.olcum = None             # son hesap {dist, off_deg, rel_alt, bearing_deg}

    def konum(self, rol, x, y, z, heading, pitch, t):
        if self.bitti:
            return []
        t = float(t)
        self.poz[rol] = (float(x), float(y), float(z), float(heading or 0), float(pitch or 0), t)
        ev = []
        if math.hypot(x, y) > float(self.a['area_radius_m']):
            self.bitti = True
            return [{'kind': 'area', 'role': rol}]
        if KOVALAYAN not in self.poz or KACAN not in self.poz:
            return ev
        c, e = self.poz[KOVALAYAN], self.poz[KACAN]
        if abs(c[5] - e[5]) > TELE_BAYAT_S:
            return ev
        d = (e[0] - c[0], e[1] - c[1], e[2] - c[2])
        dist = math.sqrt(d[0] ** 2 + d[1] ** 2 + d[2] ** 2)
        off = koni_acisi(burun(c[3], c[4], self.a.get('vclass')), d)
        self.olcum = {'dist': dist, 'off_deg': off, 'rel_alt': d[2], 'bearing_deg': math.degrees(math.atan2(d[0], d[1])) % 360}
        if self.koruma:
            esik = float(self.a['alt_m']) * KORUMA_ORAN
            if (c[2] >= esik and e[2] >= esik) or t - self.t0 >= KORUMA_S:
                self.koruma = False
                ev.append({'kind': 'guard_off'})
        if self.min_mesafe is None or dist < self.min_mesafe:
            self.min_mesafe = dist
        dt = 0.0 if self.son_t is None else max(0.0, min(0.5, t - self.son_t))
        self.son_t = t if self.son_t is None else max(self.son_t, t)
        icinde = (not self.koruma) and dist <= float(self.a['range_m']) and off <= float(self.a['cone_deg'])
        if icinde:
            self.tutma += dt if self.koni_ici else 0.0
            self.koni_toplam += dt if self.koni_ici else 0.0
            if not self.koni_ici:
                ev.append({'kind': 'lock_on'})
        else:
            if self.koni_ici:
                ev.append({'kind': 'lock_off', 'held_s': round(self.tutma, 2)})
            self.tutma = 0.0
        self.koni_ici = icinde
        self.tutma_azami = max(self.tutma_azami, self.tutma)
        if icinde and self.tutma >= float(self.a['hold_s']):
            self.bitti = True
            ev.append({'kind': 'engage', 'held_s': round(self.tutma, 2), 'dist_m': round(dist, 1), 'off_deg': round(off, 1)})
        return ev

    def durum(self):
        o = self.olcum or {}
        return {'dist': round(o['dist'], 1) if o else None, 'off_deg': round(o['off_deg'], 1) if o else None, 'rel_alt': round(o['rel_alt'], 1) if o else None,
                'bearing_deg': round(o['bearing_deg'], 1) if o else None, 'in_cone': self.koni_ici, 'hold_s': round(self.tutma, 2),
                'need_s': float(self.a['hold_s']), 'guard': self.koruma, 'max_hold_s': round(self.tutma_azami, 2),
                'min_dist_m': round(self.min_mesafe, 1) if self.min_mesafe is not None else None}


# ---------------------------------------------------------------- halka üretimi
def halkalar_uret(ayar, merkez, baslangic=None):
    """Deterministik halkalar. `ayar` halka_ayar_dogrula çıktısı (seed zorunlu), `merkez` {lat, lon, alt} (alt: zemin MSL; yoksa 0),
    `baslangic` [(x, y)] başlangıç noktaları (ilk halkanın yönü için; yoksa merkez). Dönüş: [{i, lat, lon, x, y, agl_m, alt_msl, yaw_deg,
    nx, ny, radius_m}] — `yaw_deg` geçiş yönü (kuzeyden saat yönünde; normal = (sin, cos)). i 1'den başlar."""
    n = int(ayar['count'])
    rng = random.Random(int(ayar.get('seed') or 1))
    R = float(ayar['radius_m'])
    lo, hi = float(ayar['min_alt_m']), float(ayar['max_alt_m'])
    zemin = float(merkez.get('alt') or 0.0)
    # yükseklikler: eşit adımlı (tek halkada orta) → karıştır (komşu halkalar farklı yükseklikte)
    alts = [lo + (hi - lo) * (k / (n - 1)) for k in range(n)] if n > 1 else [(lo + hi) / 2.0]
    rng.shuffle(alts)
    # yatay: merkez çevresinde dolanan parkur (açı adımı 360/n ± %30, başlangıç açısı rastgele; uzaklık 0,45R…R)
    a0 = rng.uniform(0, 2 * math.pi)
    yon = 1 if rng.random() < 0.5 else -1
    adim = 2 * math.pi / max(n, 3)
    pts, a = [], a0
    for k in range(n):
        r = R * rng.uniform(0.45, 1.0)
        pts.append((r * math.sin(a), r * math.cos(a)))
        a += yon * adim * rng.uniform(0.7, 1.3)
    bx, by = (0.0, 0.0)
    if baslangic:
        bx = sum(p[0] for p in baslangic) / len(baslangic)
        by = sum(p[1] for p in baslangic) / len(baslangic)
    out = []
    onceki = (bx, by)
    rad = float(ayar['diameter_m']) / 2.0
    for k, (x, y) in enumerate(pts):
        dx, dy = x - onceki[0], y - onceki[1]
        L = math.hypot(dx, dy) or 1.0
        nx, ny = dx / L, dy / L
        lat, lon = latlon(merkez['lat'], merkez['lon'], x, y)
        agl = round(alts[k], 1)
        out.append({'i': k + 1, 'lat': round(lat, 7), 'lon': round(lon, 7), 'x': round(x, 2), 'y': round(y, 2), 'agl_m': agl,
                    'alt_msl': round(zemin + agl, 2), 'yaw_deg': round(math.degrees(math.atan2(nx, ny)) % 360, 1),
                    'nx': round(nx, 5), 'ny': round(ny, 5), 'radius_m': round(rad, 2)})
        onceki = (x, y)
    return out


# ---------------------------------------------------------------- başlangıç noktaları
def baslangic_noktalari(n, tip, pist_yonu=0.0, ayrik=AYRIK_M, hedef=None):
    """n oyuncu için yerel (x, y, yaw_deg). Dikey kalkanlar: merkez çevresinde eşit aralıklı çember (komşular arası ≥ ayrik), burun ilk halkaya
    (`hedef` (x, y) verilirse) ya da dışa. Sabit kanat: pist yönüne dik şeritlerde (aralık ayrik), hepsi pist yönünde (kalkış koridorları paralel)."""
    n = max(1, int(n))
    if tip in UCAK_TIPLER:
        h = math.radians(float(pist_yonu or 0))
        px, py = math.cos(h), -math.sin(h)   # pist yönüne dik (sağ taraf)
        out = []
        for k in range(n):
            o = (k - (n - 1) / 2.0) * ayrik
            out.append((round(px * o, 2), round(py * o, 2), round(float(pist_yonu or 0) % 360, 1)))
        return out
    if n == 1:
        return [(0.0, 0.0, 0.0)]
    r = max(ayrik / (2 * math.sin(math.pi / n)), ayrik / 2.0)
    out = []
    for k in range(n):
        a = 2 * math.pi * k / n
        x, y = r * math.sin(a), r * math.cos(a)
        if hedef is not None:
            yaw = math.degrees(math.atan2(hedef[0] - x, hedef[1] - y)) % 360
        else:
            yaw = math.degrees(a) % 360
        out.append((round(x, 2), round(y, 2), round(yaw, 1)))
    return out


# ---------------------------------------------------------------- geçiş tespiti
def halka_kesisim(p0, p1, h):
    """p0 → p1 (yerel x, y, z_msl) doğru parçası halkanın düzlemini kesiyor mu. Dönüş: ('ileri' | 'ters' | None, kesişimin halka merkezine
    uzaklığı (m) | None). Halka düzlemi dikey; normal (nx, ny, 0); 'ileri' = −→+ (yaw yönünde)."""
    cx, cy, cz = h['x'], h['y'], h['alt_msl']
    nx, ny = h['nx'], h['ny']
    d0 = (p0[0] - cx) * nx + (p0[1] - cy) * ny
    d1 = (p1[0] - cx) * nx + (p1[1] - cy) * ny
    if d0 < 0 <= d1:
        yon = 'ileri'
    elif d0 >= 0 > d1:
        yon = 'ters'
    else:
        return None, None
    t = d0 / (d0 - d1)
    qx, qy, qz = (p0[0] + (p1[0] - p0[0]) * t, p0[1] + (p1[1] - p0[1]) * t, p0[2] + (p1[2] - p0[2]) * t)
    return yon, math.sqrt((qx - cx) ** 2 + (qy - cy) ** 2 + (qz - cz) ** 2)


class HalkaIzleyici:
    """Bir oyuncunun parkur ilerlemesi. `konum(x, y, z_msl, t)` → olay sözlüğü listesi: {'kind': 'ring', 'i', 't'} / {'kind': 'finish', 't'} /
    {'kind': 'wrong_way', 'i'} (sıradaki halkayı ters yönde kesti; bilgi). Sıradaki halkaya mesafe `mesafe`."""

    def __init__(self, halkalar):
        self.halkalar = list(halkalar)
        self.sira = 0                 # sıradaki halka (0 tabanlı); len → bitti
        self.son = None               # (x, y, z)
        self.gecisler = []            # [(i, t)]
        self.bitis_t = None
        self.mesafe = None

    @property
    def bitti(self):
        return self.sira >= len(self.halkalar)

    def _mesafe(self, p):
        if self.bitti:
            return 0.0
        h = self.halkalar[self.sira]
        return math.sqrt((p[0] - h['x']) ** 2 + (p[1] - h['y']) ** 2 + (p[2] - h['alt_msl']) ** 2)

    def konum(self, x, y, z, t):
        p = (float(x), float(y), float(z))
        olaylar = []
        onceki, self.son = self.son, p
        if onceki is not None and not self.bitti and math.dist(onceki, p) <= SICRAMA_M:
            h = self.halkalar[self.sira]
            yon, uz = halka_kesisim(onceki, p, h)
            if yon == 'ileri' and uz is not None and uz <= h['radius_m']:
                self.gecisler.append((h['i'], t))
                self.sira += 1
                olaylar.append({'kind': 'ring', 'i': h['i'], 't': t})
                if self.bitti:
                    self.bitis_t = t
                    olaylar.append({'kind': 'finish', 't': t})
            elif yon == 'ters' and uz is not None and uz <= h['radius_m']:
                olaylar.append({'kind': 'wrong_way', 'i': h['i']})
        self.mesafe = self._mesafe(p)
        return olaylar


# ---------------------------------------------------------------- karşılaşma
class Oyuncu:
    def __init__(self, uid, ad, kurucu=False):
        self.uid = int(uid)
        self.ad = str(ad or '')
        self.kurucu = bool(kurucu)
        self.durum = GELDI if kurucu else DAVETLI
        self.geldi_t = None
        self.sira_no = None           # başlangıç noktası sırası
        self.baslangic = None         # {x, y, lat, lon, yaw_deg}
        self.oturum = None            # platformun oturum kimliği (HEPGO: SimSession.id)
        self.iz = None                # HalkaIzleyici (yarışta)
        self.azami_hiz = 0.0
        self.carpisma = 0
        self.poz = None               # son yayın konumu {lat, lon, alt_msl, yaw, roll, pitch, gs}
        self.dusme_nedeni = None
        self.rol = None               # §41 it dalaşı: 'chaser' | 'evader'

    def dict(self, halka_sayisi=0):
        iz = self.iz
        return {'id': self.uid, 'name': self.ad, 'host': self.kurucu, 'status': self.durum, 'joined_at': self.geldi_t, 'slot': self.sira_no,
                'start': dict(self.baslangic) if self.baslangic else None, 'session_id': self.oturum,
                'rings': len(iz.gecisler) if iz else 0, 'total': halka_sayisi, 'next': (iz.sira + 1) if iz and not iz.bitti else None,
                'dist_next_m': round(iz.mesafe, 1) if iz and iz.mesafe is not None else None,
                'finished': bool(iz and iz.bitti), 'finish_t': iz.bitis_t if iz else None,
                'max_speed_ms': round(self.azami_hiz, 1), 'crashes': self.carpisma, 'drop_reason': self.dusme_nedeni, 'role': self.rol}


class Karsilasma:
    """Durum makinesi. Zaman `now` (Unix sn) dışarıdan; olaylar döndürülür (platform yayınlar/kaydeder). Kurucu kendisi de oyuncudur."""

    def __init__(self, mid, kurucu, davetliler, ayar, halka_ayar, merkez, now, halkalar=None, baslangiclar=None, tur=TUR_HALKA):
        if tur not in TURLER:
            raise MacHata('invalid', 'Bilinmeyen karşılaşma türü')
        self.tur = tur                           # §41 'rings' (halka yarışı) | 'dogfight' (it dalaşı; halka_ayar = it_ayar_dogrula çıktısı)
        self.it = None                           # ItDalasi (yarışta)
        self.it_sonuc = None
        self.id = mid
        self.ayar = dict(ayar or {})             # oturum ayarları (platforma özgü gövde; çekirdek yalnız taşır)
        self.halka_ayar = dict(halka_ayar)
        self.merkez = dict(merkez)
        self.durum = LOBI
        self.olusturma_t = float(now)
        self.hazirlik_t = None
        self.baslangic_t = None                  # yarış başlangıcı (GERI_SAYIM'da gelecekteki an)
        self.bitis_t = None
        self.neden = None                        # bitiş / iptal nedeni
        self.kazanan = None
        kid, kad = kurucu
        self.oyuncular = {int(kid): Oyuncu(kid, kad, kurucu=True)}
        self.oyuncular[int(kid)].geldi_t = float(now)
        for uid, ad in davetliler:
            if int(uid) != int(kid) and int(uid) not in self.oyuncular:
                self.oyuncular[int(uid)] = Oyuncu(uid, ad)
        if len(self.oyuncular) - 1 < DAVET_MIN:
            raise MacHata('invalid', 'En az bir kullanıcı davet edin')
        if len(self.oyuncular) > OYUNCU_MAX:
            raise MacHata('limit', f'Karşılaşmada en çok {OYUNCU_MAX} oyuncu olabilir (siz dahil)')
        if tur == TUR_IT and len(self.oyuncular) != 2:
            raise MacHata('invalid', 'İt dalaşı tam 2 oyuncuyla oynanır (siz + 1 davetli)')
        self.halkalar = halkalar
        self.baslangiclar = baslangiclar        # [(x, y, yaw)] sıra no → nokta (platform verir ya da HAZIRLIK'ta üretilir)

    # ---- sorgular
    @property
    def kurucu_id(self):
        return next(o.uid for o in self.oyuncular.values() if o.kurucu)

    def oyuncu(self, uid):
        try:
            return self.oyuncular.get(int(uid))
        except (TypeError, ValueError):
            return None

    def aktifler(self):
        return [o for o in self.oyuncular.values() if o.durum not in KATILMAYAN]

    def gelmeyenler(self):
        return [o for o in self.oyuncular.values() if o.durum == DAVETLI]

    def zorla_baslatilabilir(self, now):
        """Kurucu "gelmeyenler olmadan başlat": LOBI'de, LOBI_ZORLA_S geçmiş, gelmeyen var, gelen ≥ 2."""
        gelen = [o for o in self.aktifler() if o.durum != DAVETLI]
        return self.durum == LOBI and bool(self.gelmeyenler()) and len(gelen) >= 2 and now - self.olusturma_t >= LOBI_ZORLA_S

    # ---- geçişler (her biri olay listesi döndürür)
    def _durum(self, d, now, neden=None):
        self.durum = d
        if neden:
            self.neden = neden
        return [{'t': 'state', 'state': d, 'reason': neden, 'ts': now}]

    def katil(self, uid, now):
        o = self.oyuncu(uid)
        if o is None:
            raise MacHata('forbidden', 'Bu karşılaşmaya davetli değilsiniz')
        if o.durum in (CIKARILDI,):
            raise MacHata('forbidden', 'Kurucu sizi karşılaşmadan çıkardı')
        if o.durum != DAVETLI:
            return []                            # zaten geldi (yeniden bağlanma)
        if self.durum != LOBI:
            raise MacHata('conflict', 'Karşılaşma başladı ya da bitti; bekleme salonuna artık katılınamaz')
        o.durum, o.geldi_t = GELDI, float(now)
        return [{'t': 'player', 'id': o.uid, 'status': o.durum}] + self._lobi_denetle(now)

    def ayril(self, uid, now):
        o = self.oyuncu(uid)
        if o is None or o.durum in KATILMAYAN:
            return []
        if o.kurucu and self.durum in (LOBI, HAZIRLIK, GERI_SAYIM):
            return self.iptal(now, 'kurucu_ayrildi')
        o.durum = AYRILDI
        ev = [{'t': 'player', 'id': o.uid, 'status': o.durum}]
        return ev + self._sayi_denetle(now) + (self._lobi_denetle(now) if self.durum == LOBI else [])

    def cikar(self, istek_uid, uid, now):
        if int(istek_uid) != self.kurucu_id:
            raise MacHata('forbidden', 'Yalnız kurucu oyuncu çıkarabilir')
        o = self.oyuncu(uid)
        if o is None or o.kurucu:
            raise MacHata('invalid', 'Oyuncu bulunamadı')
        if self.durum not in (LOBI, HAZIRLIK):
            raise MacHata('conflict', 'Yarış başladıktan sonra oyuncu çıkarılamaz')
        if o.durum in KATILMAYAN:
            return []
        o.durum = CIKARILDI
        ev = [{'t': 'player', 'id': o.uid, 'status': o.durum}]
        return ev + self._sayi_denetle(now) + (self._lobi_denetle(now) if self.durum == LOBI else self._hazir_denetle(now))

    def iptal(self, now, neden='kurucu_iptal'):
        if self.durum in SON_DURUMLAR:
            return []
        self.bitis_t = float(now)
        return self._durum(IPTAL, now, neden)

    def zorla_baslat(self, istek_uid, now):
        if int(istek_uid) != self.kurucu_id:
            raise MacHata('forbidden', 'Yalnız kurucu başlatabilir')
        if not self.zorla_baslatilabilir(now):
            raise MacHata('conflict', f'Gelmeyenler olmadan başlatmak için en az 2 oyuncu gelmiş olmalı ve {int(LOBI_ZORLA_S)} sn beklenmeli')
        ev = []
        for o in self.gelmeyenler():
            o.durum, o.dusme_nedeni = DUSTU, 'gelmedi'
            ev.append({'t': 'player', 'id': o.uid, 'status': o.durum})
        return ev + self._lobi_denetle(now)

    def _sayi_denetle(self, now):
        """Yarışa katılabilecek oyuncu 2'nin altına düştüyse: LOBI dışındaki hazırlık durumlarında iptal; yarışta kalan tek kişiyse bitir."""
        if self.durum in SON_DURUMLAR:
            return []
        n = len(self.aktifler())
        if self.durum == LOBI:
            return self.iptal(now, 'oyuncu_kalmadi') if n < 2 and not self.gelmeyenler() else []
        if self.durum in (HAZIRLIK, GERI_SAYIM) and n < 2:
            return self.iptal(now, 'oyuncu_kalmadi')
        if self.durum == YARIS and n == 0:
            return self.bitir(now, 'oyuncu_kalmadi')
        if self.durum == YARIS and self.tur == TUR_IT and n == 1:   # §41 rakip ayrıldı / düştü → kalan kazanır
            self.kazanan = self.aktifler()[0].uid
            return self.bitir(now, 'rakip_ayrildi')
        return []

    def _lobi_denetle(self, now):
        """LOBI → HAZIRLIK: davetli kalmadı (hepsi geldi / çıkarıldı / düştü) ve en az 2 oyuncu."""
        if self.durum != LOBI or self.gelmeyenler():
            return []
        akt = self.aktifler()
        if len(akt) < 2:
            return self.iptal(now, 'oyuncu_kalmadi')
        if self.tur == TUR_IT and len(akt) != 2:
            return self.iptal(now, 'oyuncu_kalmadi')
        self.hazirlik_t = float(now)
        for k, o in enumerate(akt):
            o.sira_no = k
            o.durum = HAZIRLANIYOR
        if self.tur == TUR_IT:
            self._roller_ata(akt)
        return self._durum(HAZIRLIK, now)

    def _roller_ata(self, akt):
        """§41: kurucu seçimi ya da tohumlu rastgele (aynı tohum = aynı roller)."""
        r = self.halka_ayar.get('roles') or 'random'
        kur = next(o for o in akt if o.kurucu) if any(o.kurucu for o in akt) else akt[0]
        diger = next(o for o in akt if o is not kur)
        if r == 'random':
            kur_kovalar = random.Random(int(self.halka_ayar.get('seed') or 1)).random() < 0.5
        else:
            kur_kovalar = r == 'host_chaser'
        kur.rol, diger.rol = (KOVALAYAN, KACAN) if kur_kovalar else (KACAN, KOVALAYAN)

    def rol_oyuncusu(self, rol):
        return next((o for o in self.oyuncular.values() if o.rol == rol), None)

    def oturum_bagla(self, uid, oturum_id):
        o = self.oyuncu(uid)
        if o is not None:
            o.oturum = oturum_id

    def hazir(self, uid, now):
        """Oyuncunun simülatörü ve 3B dünyası hazır (platform: SITL HAZIR + istemci `ready`)."""
        o = self.oyuncu(uid)
        if o is None or self.durum != HAZIRLIK or o.durum != HAZIRLANIYOR:
            return []
        o.durum = HAZIR
        return [{'t': 'player', 'id': o.uid, 'status': o.durum}] + self._hazir_denetle(now)

    def dusur(self, uid, now, neden):
        o = self.oyuncu(uid)
        if o is None or o.durum in KATILMAYAN:
            return []
        o.durum, o.dusme_nedeni = DUSTU, str(neden)[:120]
        ev = [{'t': 'player', 'id': o.uid, 'status': o.durum, 'reason': o.dusme_nedeni}]
        return ev + self._sayi_denetle(now) + (self._hazir_denetle(now) if self.durum == HAZIRLIK else [])

    def _hazir_denetle(self, now):
        if self.durum != HAZIRLIK:
            return []
        akt = self.aktifler()
        if len(akt) >= 2 and all(o.durum == HAZIR for o in akt):
            self.baslangic_t = float(now) + GERI_SAYIM_S
            return self._durum(GERI_SAYIM, now) + [{'t': 'countdown', 'start_at': self.baslangic_t, 'ts': now}]
        return []

    def tik(self, now):
        """Zamanla geçişler: lobi zaman aşımı, hazırlık zaman aşımı (hazır olmayan düşer), geri sayım → YARIS, süre sınırı → BITTI."""
        if self.durum == LOBI and now - self.olusturma_t > LOBI_ZAMAN_ASIMI_S:
            return self.iptal(now, 'zaman_asimi')
        if self.durum == HAZIRLIK and now - (self.hazirlik_t or now) > HAZIRLIK_ZAMAN_ASIMI_S:
            ev = []
            for o in self.aktifler():
                if o.durum != HAZIR:
                    ev += self.dusur(o.uid, now, 'hazirlanamadi')
            return ev
        if self.durum == GERI_SAYIM and now >= self.baslangic_t:
            if self.tur == TUR_IT:
                self.it = ItDalasi(self.halka_ayar, self.baslangic_t)
            else:
                for o in self.aktifler():
                    o.iz = HalkaIzleyici(self.halkalar or [])
            return self._durum(YARIS, now)
        if self.durum == YARIS and now - self.baslangic_t >= float(self.halka_ayar.get('time_limit_min') or SURE_DK_VARSAYILAN) * 60:
            if self.tur == TUR_IT and self.kazanan is None:   # §41 süre bitti → kaçan kazanır
                ka = self.rol_oyuncusu(KACAN)
                self.kazanan = ka.uid if ka is not None and ka.durum not in KATILMAYAN else None
            return self.bitir(now, 'sure')
        return []

    def konum(self, uid, lat, lon, alt_msl, now, hiz=None, heading=None, pitch=None):
        """Oyuncu konumu (yalnız YARIS'ta işlenir). Olaylar: ring / finish (+ state BITTI); §41 it dalaşında dogfight olayları (+ BITTI)."""
        o = self.oyuncu(uid)
        if o is not None and self.tur == TUR_IT:
            return self._it_konum(o, lat, lon, alt_msl, now, hiz, heading, pitch)
        if o is None or self.durum != YARIS or o.iz is None or o.durum in KATILMAYAN:
            return []
        if hiz is not None and math.isfinite(float(hiz)):
            o.azami_hiz = max(o.azami_hiz, float(hiz))
        x, y = enu(self.merkez['lat'], self.merkez['lon'], lat, lon)
        ev = []
        for e in o.iz.konum(x, y, alt_msl, now):
            if e['kind'] == 'ring':
                ev.append({'t': 'ring', 'id': o.uid, 'i': e['i'], 'total': len(self.halkalar), 'elapsed_s': round(now - self.baslangic_t, 2), 'ts': now})
            elif e['kind'] == 'finish':
                ev.append({'t': 'finish', 'id': o.uid, 'elapsed_s': round(now - self.baslangic_t, 2), 'ts': now})
                if self.kazanan is None:
                    self.kazanan = o.uid
                    ev += self.bitir(now, 'birinci_bitirdi')
            elif e['kind'] == 'wrong_way':
                ev.append({'t': 'wrong_way', 'id': o.uid, 'i': e['i'], 'ts': now})
        return ev

    # ---- §41 it dalaşı
    def _it_konum(self, o, lat, lon, alt_msl, now, hiz, heading, pitch):
        if self.durum != YARIS or self.it is None or o.durum in KATILMAYAN or o.rol is None:
            return []
        if hiz is not None and math.isfinite(float(hiz)):
            o.azami_hiz = max(o.azami_hiz, float(hiz))
        x, y = enu(self.merkez['lat'], self.merkez['lon'], lat, lon)
        z = float(alt_msl) - float(self.merkez.get('alt') or 0.0)
        ev = []
        for e in self.it.konum(o.rol, x, y, z, heading, pitch, now):
            k = e['kind']
            if k == 'engage':
                ko = self.rol_oyuncusu(KOVALAYAN)
                self.kazanan = ko.uid if ko else None
                self.it_sonuc = {'engage_s': e['held_s'], 'dist_m': e['dist_m'], 'off_deg': e['off_deg']}
                ev.append({'t': 'dogfight', 'kind': 'engaged', 'id': self.kazanan, 'held_s': e['held_s'], 'ts': now})
                ev += self.bitir(now, 'angaje')
            elif k == 'area':
                kaybeden = self.rol_oyuncusu(e['role'])
                diger = next((p for p in self.aktifler() if p is not kaybeden), None)
                self.kazanan = diger.uid if diger else None
                ev.append({'t': 'dogfight', 'kind': 'area', 'id': kaybeden.uid if kaybeden else None, 'ts': now})
                ev += self.bitir(now, 'alan_disi')
            elif k in ('lock_on', 'lock_off', 'guard_off'):
                ev.append({'t': 'dogfight', 'kind': k, 'ts': now, **({'held_s': e['held_s']} if 'held_s' in e else {})})
        return ev

    def carpti(self, uid, now):
        """Oyuncu yere / engele çarptı (platformun kesin çarpışma kaydı). §41 it dalaşında YARIS'ta çarpan kaybeder; halka yarışında yalnız sayılır."""
        o = self.oyuncu(uid)
        if o is None or self.tur != TUR_IT or self.durum != YARIS or o.durum in KATILMAYAN:
            return []
        diger = next((p for p in self.aktifler() if p is not o), None)
        self.kazanan = diger.uid if diger else None
        if self.it is not None:
            self.it.bitti = True
        return [{'t': 'dogfight', 'kind': 'crash', 'id': o.uid, 'ts': now}] + self.bitir(now, 'carpti')

    def it_durum(self):
        """HUD (pos çerçevesi) için: {roles {uid: rol}, dist, off_deg, rel_alt, in_cone, hold_s, need_s, guard, …} ya da None."""
        if self.tur != TUR_IT:
            return None
        d = self.it.durum() if self.it is not None else {}
        return {'roles': {str(o.uid): o.rol for o in self.oyuncular.values() if o.rol}, **d}

    def bitir(self, now, neden):
        if self.durum in SON_DURUMLAR:
            return []
        self.bitis_t = float(now)
        if self.tur == TUR_IT:
            return self._durum(BITTI, now, neden) + [{'t': 'result', 'result': self.sonuc(), 'ts': now}]
        if self.kazanan is None:
            sira = self.siralama()
            if sira and sira[0]['rings'] > 0 and sira[0]['status'] not in KATILMAYAN:
                self.kazanan = sira[0]['id']
        return self._durum(BITTI, now, neden) + [{'t': 'result', 'result': self.sonuc(), 'ts': now}]

    # ---- sonuç
    def siralama(self):
        if self.tur == TUR_IT:   # §41: kazanan önde, sonra rakip; katılmayanlar sonda
            rows = sorted((o.dict(0) for o in self.oyuncular.values()), key=lambda p: (p['id'] != self.kazanan, p['status'] in (CIKARILDI, DUSTU, DAVETLI), p['id']))
            return [{**p, 'rank': k + 1, 'time_s': None} for k, p in enumerate(rows)]
        return siralama([o.dict(len(self.halkalar or [])) for o in self.oyuncular.values()], self.baslangic_t)

    def sonuc(self):
        out = {'winner': self.kazanan, 'reason': self.neden, 'started_at': self.baslangic_t, 'ended_at': self.bitis_t,
               'duration_s': round(self.bitis_t - self.baslangic_t, 2) if self.bitis_t and self.baslangic_t else None,
               'total': len(self.halkalar or []), 'standings': self.siralama(), 'kind': self.tur}
        if self.tur == TUR_IT:
            d = self.it.durum() if self.it is not None else {}
            out['dogfight'] = {'engage_s': (self.it_sonuc or {}).get('engage_s'), 'max_hold_s': d.get('max_hold_s'), 'min_dist_m': d.get('min_dist_m'),
                               'need_s': float(self.halka_ayar.get('hold_s') or 0), 'roles': {str(o.uid): o.rol for o in self.oyuncular.values() if o.rol}}
        return out

    def dict(self, now=None):
        return {'id': self.id, 'state': self.durum, 'reason': self.neden, 'host_id': self.kurucu_id, 'created_at': self.olusturma_t,
                'prepare_at': self.hazirlik_t, 'start_at': self.baslangic_t, 'ended_at': self.bitis_t, 'winner': self.kazanan,
                'settings': dict(self.ayar), 'rings_cfg': dict(self.halka_ayar), 'rings': list(self.halkalar or []), 'center': dict(self.merkez),
                'players': [o.dict(len(self.halkalar or [])) for o in self.oyuncular.values()],
                'result': self.sonuc() if self.durum == BITTI else None,
                'can_force': self.zorla_baslatilabilir(now) if now is not None else False,
                'force_after_s': LOBI_ZORLA_S, 'countdown_s': GERI_SAYIM_S, 'now': now, 'kind': self.tur,
                'dogfight': self.it_durum()}


def siralama(oyuncular, baslangic_t=None):
    """oyuncular: Oyuncu.dict listesi. Bitirenler bitiş zamanıyla; bitirmeyenler halka sayısı (çok önde) + sıradaki halkaya mesafe (az önde);
    katılmayanlar (çıkarılan/düşen/ayrılan) — ayrılan yarıştaki ilerlemesiyle yine sıralanır ama yarışanların ardından — ve davetli kalanlar sonda.
    Her satıra `rank` (1…) ve `time_s` (bitirenlerde başlangıçtan süre) eklenir."""
    def anahtar(p):
        yarisdi = p['status'] not in (CIKARILDI, DUSTU, DAVETLI)
        grup = 0 if (yarisdi and p['status'] != AYRILDI) else (1 if p['status'] == AYRILDI else 2)
        if p['finished'] and p.get('finish_t') is not None:
            return (0, p['finish_t'])
        d = p['dist_next_m'] if p['dist_next_m'] is not None else float('inf')
        return (1 + grup, -p['rings'], d, p['id'])
    out = []
    for k, p in enumerate(sorted(oyuncular, key=anahtar)):
        q = dict(p)
        q['rank'] = k + 1
        q['time_s'] = round(p['finish_t'] - baslangic_t, 2) if p['finished'] and p.get('finish_t') is not None and baslangic_t else None
        out.append(q)
    return out
