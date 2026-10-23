"""Uçuş Simülatörü — HAZIR FPV PARKURLARI çekirdeği (SAF; docs/ucus-simulatoru.md §47; HEPGO + SIMUMAV ortak).

Platformdan bağımsızdır (DB/ağ/asyncio yok). Kapsam: yalnız SPOR / YARIŞ ve BECERİ parkuru (kapı, bayrak, tünel, pencere, dalış kapısı, merdiven
kapı, slalom). Hedefe dalış / çarpma / hedef vurma senaryosu YOKTUR.

Koordinatlar: parkur merkezine (karşılaşma merkezi) göre yerel ENU metre — x doğu, y kuzey, z ZEMİNDEN yükseklik. `yaw` pusula açısı (0 = kuzey,
saat yönünde); bir kapının `yaw`'ı GEÇİŞ yönüdür. Dalış kapısı (`dive`) yatay düzlemdir, yukarıdan aşağı geçilir (normal (0, 0, −1)).

İçerik
  · ilkel engeller (`box` — delikli olabilir: pencere/kapı boşluğu, tünel, raf aralığı, döşeme boşluğu —, `cyl`, `sph`, `pipe`, `torus`) ve
    nokta / doğru parçası çarpışması (`EngelDunyasi`: AABB kaba eleme + örnekleme; dron yarıçapı kadar şişirme);
  · kapı geometrisi ve geçiş denetimi (`kapi_kesisim`: doğru yönde düzlem kesişimi + açıklık içinde — kare/daire/dikdörtgen, yatay dalış kapısı);
  · 8 hazır parkur (`PARKURLAR`; kodla üretilir, deterministik): hangar, orman, yarı yıkık şehir, stadyum, rafineri, kanyon, tepedeki ahşap ev
    iskeleti, yarım beton bina — her biri: kapılar (sıra, konum, yön, boyut, sektör), engeller, dekor, başlangıç, tur, zorluk, ortam;
  · yarış hattı (`yaris_hatti`): her kapı için giriş → merkez → çıkış (+ tanımdaki ara noktalar) — yapay zekâ pilotun izlediği ve doğrulamanın
    (engelsiz hat) denetlediği çizgi; uzunluk;
  · karşılaşma kontrol noktaları (`kontrol_noktalari`): [başlangıç/bitiş kapısı] + (kapılar 1…m−1 + başlangıç/bitiş) × tur;
  · parkur izleyici (`ParkurIzleyici`; §33 HalkaIzleyici'nin genişlemesi): tur ve sektör süreleri, en iyi tur, kaçırılan kapı (en çok 2 kapı ileri
    bakış) cezası, engel çarpışması (kural: `reset` başlangıca dön · `penalty` ceza süresi · `continue` yalnız sayılır), hayalet örnekleri;
  · hayalet (ghost) kaydı sıkıştırma (`hayalet_kodla` / `hayalet_coz`: santim/mrad nicemleme + fark + zigzag varint + base64);
  · parkur doğrulama (`parkur_dogrula`) ve puan (`fpv_puani`).
"""
import base64
import math
import random

# ---------------------------------------------------------------- sabitler
DRON_R = 0.25                    # dron yarıçapı (m; 5" FPV)
CERCEVE_B = 0.25                 # kapı çerçevesi bordür genişliği (m)
CERCEVE_T = 0.22                 # çerçeve kalınlığı (geçiş yönünde)
GIRIS_M = 3.0                    # yarış hattında kapının önünde/arkasında giriş/çıkış noktası
HAT_PAY = 0.45                   # doğrulama: yarış hattı engellere en az bu kadar (dron yarıçapı dahil) uzak
ORNEK_ADIM = 0.35                # doğru parçası çarpışma örnekleme adımı (m)
ILERI_BAKIS = 2                  # kaçırılan kapı: sıradakinden en çok bu kadar ileri kapı geçilirse aradakiler "kaçırıldı"
CARPMA_ARALIK_S = 1.0            # aynı temas sürerken yeni çarpma sayılmaz
HAYALET_ARALIK_S = 0.1           # hayalet örnek aralığı (10 Hz)
HAYALET_MAX = 36000              # 60 dk × 10 Hz
FPV_TIPLER = ('multirotor', 'hexarotor', 'helikopter')   # parkurlar dar alan: FPV kopter sınıfı
CARPMA_KURALLARI = ('penalty', 'reset', 'continue')
TUR = (1, 10)
CEZA_S = (0.0, 30.0)
SURE_DK = (2, 30)
ZORLUK_AD = {1: 'Kolay', 2: 'Orta', 3: 'Zor', 4: 'Çok zor', 5: 'Uzman'}
SON_CAGRI_S = 30.0               # çok oyunculuda ilk bitirenden sonra diğerlerine tanınan süre
KAPI_TURLERI = ('start', 'gate', 'circle', 'window', 'dive', 'ladder', 'tunnel', 'flag', 'slalom')
DEG = math.pi / 180.0


class FpvHata(Exception):
    pass


# ---------------------------------------------------------------- vektör yardımcıları
def _sub(a, b):
    return (a[0] - b[0], a[1] - b[1], a[2] - b[2])


def _dot(a, b):
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]


def _cross(a, b):
    return (a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0])


def _norm(a):
    L = math.sqrt(_dot(a, a)) or 1.0
    return (a[0] / L, a[1] / L, a[2] / L)


def _dist(a, b):
    return math.sqrt(_dot(_sub(a, b), _sub(a, b)))


def ileri(yaw_deg):
    a = float(yaw_deg) * DEG
    return (math.sin(a), math.cos(a), 0.0)


def sag(yaw_deg):
    a = float(yaw_deg) * DEG
    return (math.cos(a), -math.sin(a), 0.0)


def yon(a, b):
    """a → b yatay pusula açısı (°)."""
    return math.degrees(math.atan2(b[0] - a[0], b[1] - a[1])) % 360


# ---------------------------------------------------------------- kapı geometrisi
def kapi_eksenleri(g):
    """(normal n, sağ u, yukarı v) — dikey kapıda n = ileri(yaw), u = sağ, v = (0,0,1); dalış kapısında n = (0,0,−1), u = sağ(yaw), v = ileri(yaw)."""
    if g.get('kind') == 'dive':
        return (0.0, 0.0, -1.0), sag(g['yaw']), ileri(g['yaw'])
    return ileri(g['yaw']), sag(g['yaw']), (0.0, 0.0, 1.0)


def kapi_acikligi(g):
    """('rect', w, h) | ('circle', r, r)."""
    if g.get('kind') == 'circle':
        return 'circle', float(g['r']), float(g['r'])
    return 'rect', float(g['w']), float(g['h'])


def kapi_kesisim(p0, p1, g):
    """p0 → p1 (yerel x, y, z ZEMİNDEN) kapı düzlemini kesiyor mu. Dönüş (yon 'ileri' | 'ters' | None, açıklık içinde mi, merkeze uzaklık)."""
    c = (g['x'], g['y'], g['z'])
    n, u, v = kapi_eksenleri(g)
    d0, d1 = _dot(_sub(p0, c), n), _dot(_sub(p1, c), n)
    if d0 < 0 <= d1:
        y = 'ileri'
    elif d0 >= 0 > d1:
        y = 'ters'
    else:
        return None, False, None
    t = d0 / (d0 - d1)
    q = (p0[0] + (p1[0] - p0[0]) * t, p0[1] + (p1[1] - p0[1]) * t, p0[2] + (p1[2] - p0[2]) * t)
    r = _sub(q, c)
    a, b = _dot(r, u), _dot(r, v)
    sekil, w, h = kapi_acikligi(g)
    ic = math.hypot(a, b) <= w if sekil == 'circle' else (abs(a) <= w / 2 and abs(b) <= h / 2)
    return y, ic, math.sqrt(_dot(r, r))


# ---------------------------------------------------------------- ilkel engeller
def _box_yerel(p, e):
    """Kutunun yerel koordinatları (u sağ / w boyunca, v ileri / d boyunca, z tabandan)."""
    dx, dy = p[0] - e['x'], p[1] - e['y']
    f, r = ileri(e.get('yaw', 0)), sag(e.get('yaw', 0))
    return dx * r[0] + dy * r[1], dx * f[0] + dy * f[1], p[2] - e['z']


def engel_icinde(p, e, inf=DRON_R):
    """p noktası (dron yarıçapı `inf` kadar şişirilmiş) engelin içinde mi."""
    t = e['t']
    if t == 'box':
        u, v, z = _box_yerel(p, e)
        if abs(u) > e['w'] / 2 + inf or abs(v) > e['d'] / 2 + inf or z < -inf or z > e['h'] + inf:
            return False
        ax = e.get('axis', 'y')
        for hl in e.get('holes') or ():
            if ax == 'y':
                if abs(u - hl['u']) <= hl['w'] / 2 - inf and abs(z - hl['v']) <= hl['h'] / 2 - inf:
                    return False
            else:   # 'z': döşeme boşluğu (u, v düzleminde)
                if abs(u - hl['u']) <= hl['w'] / 2 - inf and abs(v - hl['v']) <= hl['h'] / 2 - inf:
                    return False
        return True
    if t == 'cyl':
        return math.hypot(p[0] - e['x'], p[1] - e['y']) <= e['r'] + inf and e['z'] - inf <= p[2] <= e['z'] + e['h'] + inf
    if t == 'sph':
        return _dist(p, (e['x'], e['y'], e['z'])) <= e['r'] + inf
    if t == 'pipe':
        a, b = e['a'], e['b']
        ab = _sub(b, a)
        L2 = _dot(ab, ab) or 1e-9
        s = max(0.0, min(1.0, _dot(_sub(p, a), ab) / L2))
        q = (a[0] + ab[0] * s, a[1] + ab[1] * s, a[2] + ab[2] * s)
        return _dist(p, q) <= e['r'] + inf
    if t == 'torus':
        n = (0.0, 0.0, 1.0) if e.get('flat') else ileri(e.get('yaw', 0))
        d = _sub(p, (e['x'], e['y'], e['z']))
        dn = _dot(d, n)
        pl = (d[0] - n[0] * dn, d[1] - n[1] * dn, d[2] - n[2] * dn)
        rho = math.sqrt(_dot(pl, pl))
        return math.hypot(rho - e['R'], dn) <= e['tube'] + inf
    return False


def engel_aabb(e, inf=DRON_R):
    t = e['t']
    if t == 'box':
        r = math.hypot(e['w'], e['d']) / 2
        return (e['x'] - r - inf, e['y'] - r - inf, e['z'] - inf, e['x'] + r + inf, e['y'] + r + inf, e['z'] + e['h'] + inf)
    if t == 'cyl':
        return (e['x'] - e['r'] - inf, e['y'] - e['r'] - inf, e['z'] - inf, e['x'] + e['r'] + inf, e['y'] + e['r'] + inf, e['z'] + e['h'] + inf)
    if t == 'sph':
        r = e['r'] + inf
        return (e['x'] - r, e['y'] - r, e['z'] - r, e['x'] + r, e['y'] + r, e['z'] + r)
    if t == 'pipe':
        a, b, r = e['a'], e['b'], e['r'] + inf
        return (min(a[0], b[0]) - r, min(a[1], b[1]) - r, min(a[2], b[2]) - r, max(a[0], b[0]) + r, max(a[1], b[1]) + r, max(a[2], b[2]) + r)
    if t == 'torus':
        r = e['R'] + e['tube'] + inf
        return (e['x'] - r, e['y'] - r, e['z'] - r, e['x'] + r, e['y'] + r, e['z'] + r)
    return (0, 0, 0, 0, 0, 0)


class EngelDunyasi:
    """Engel listesi üstünde çarpışma sorguları (ızgara kaba eleme, hücre 8 m)."""

    HUCRE = 8.0

    def __init__(self, engeller, inf=DRON_R):
        self.engeller = list(engeller)
        self.inf = inf
        self.izgara = {}
        for k, e in enumerate(self.engeller):
            a = engel_aabb(e, inf)
            for i in range(int(math.floor(a[0] / self.HUCRE)), int(math.floor(a[3] / self.HUCRE)) + 1):
                for j in range(int(math.floor(a[1] / self.HUCRE)), int(math.floor(a[4] / self.HUCRE)) + 1):
                    self.izgara.setdefault((i, j), []).append(k)

    def nokta(self, p, inf=None):
        """p'yi içeren ilk engelin sırası ya da None."""
        inf = self.inf if inf is None else inf
        for k in self.izgara.get((int(math.floor(p[0] / self.HUCRE)), int(math.floor(p[1] / self.HUCRE))), ()):
            if engel_icinde(p, self.engeller[k], inf):
                return k
        return None

    def parca(self, p0, p1, inf=None, adim=ORNEK_ADIM):
        """p0 → p1 boyunca ilk temas (engel sırası, nokta) ya da (None, None)."""
        L = _dist(p0, p1)
        n = max(1, int(math.ceil(L / adim)))
        for s in range(1, n + 1):
            f = s / n
            q = (p0[0] + (p1[0] - p0[0]) * f, p0[1] + (p1[1] - p0[1]) * f, p0[2] + (p1[2] - p0[2]) * f)
            k = self.nokta(q, inf)
            if k is not None:
                return k, q
        return None, None


# ---------------------------------------------------------------- parkur kurucu yardımcıları
class _Kurucu:
    def __init__(self, cid, venue, seed=1):
        self.cid = cid
        self.venue = venue
        self.gates = []
        self.obstacles = []
        self.decor = []
        self.rng = random.Random(seed)

    # kapılar
    def kapi(self, kind, x, y, z, yaw, w=3.0, h=3.0, r=None, frame=True, sector_end=False, via=None, side=None, label=None, a=None):
        assert kind in KAPI_TURLERI
        g = {'kind': kind, 'x': round(float(x), 2), 'y': round(float(y), 2), 'z': round(float(z), 2), 'yaw': round(float(yaw) % 360, 1),
             'w': float(w), 'h': float(h), 'frame': bool(frame), 'sector_end': bool(sector_end)}
        if r is not None:
            g['r'] = float(r)
            g['w'] = g['h'] = 2 * float(r)
        if via:
            g['via'] = [[round(float(c), 2) for c in p] for p in via]
        if side:
            g['side'] = side
        if label:
            g['label'] = label
        if a is not None:
            g['a'] = float(a)   # yarış hattı giriş/çıkış uzaklığı (tünelde uzun)
        self.gates.append(g)
        return g

    def bayrak(self, px, py, yaw, side, w=10.0, h=6.0, kind='flag', pole_r=0.09, pole=True, **kw):
        """Bayrak / slalom direği (px, py): `side` 'left' | 'right' — direğin hangi yanından geçilir (gidiş yönüne göre). Sanal kapı direkten
        `w` genişliğinde; direk engeldir."""
        r = sag(yaw)
        s = 1.0 if side == 'right' else -1.0
        o = pole_r + w / 2 + 0.3
        cx, cy = px + r[0] * s * o, py + r[1] * s * o
        g = self.kapi(kind, cx, cy, h / 2, yaw, w=w, h=h, frame=False, side=side, **kw)
        g['pole'] = [round(px, 2), round(py, 2)]
        g['pole_r'] = pole_r
        hp = 5.5 if kind == 'flag' else 3.2
        if pole:
            self.obstacles.append({'t': 'cyl', 'x': px, 'y': py, 'z': 0.0, 'r': 0.09, 'h': hp, 'mat': 'pole', 'part': kind})
        return g

    # engeller
    def kutu(self, x, y, z, w, d, h, yaw=0.0, mat='concrete', holes=None, axis='y', vis=True, decor=False, **kw):
        e = {'t': 'box', 'x': round(float(x), 3), 'y': round(float(y), 3), 'z': round(float(z), 3), 'w': float(w), 'd': float(d), 'h': float(h),
             'yaw': round(float(yaw) % 360, 2), 'mat': mat}
        if holes:
            e['holes'] = [{k: round(float(v), 3) for k, v in hl.items()} for hl in holes]
            e['axis'] = axis
        if not vis:
            e['vis'] = False
        e.update(kw)
        (self.decor if decor else self.obstacles).append(e)
        return e

    def silindir(self, x, y, z, r, h, mat='steel', decor=False, **kw):
        e = {'t': 'cyl', 'x': round(float(x), 3), 'y': round(float(y), 3), 'z': round(float(z), 3), 'r': float(r), 'h': float(h), 'mat': mat, **kw}
        (self.decor if decor else self.obstacles).append(e)
        return e

    def kure(self, x, y, z, r, mat='rock', decor=False, **kw):
        e = {'t': 'sph', 'x': round(float(x), 3), 'y': round(float(y), 3), 'z': round(float(z), 3), 'r': float(r), 'mat': mat, **kw}
        (self.decor if decor else self.obstacles).append(e)
        return e

    def boru(self, a, b, r, mat='pipe', decor=False, **kw):
        e = {'t': 'pipe', 'a': [round(float(c), 3) for c in a], 'b': [round(float(c), 3) for c in b], 'r': float(r), 'mat': mat, **kw}
        (self.decor if decor else self.obstacles).append(e)
        return e

    def agac(self, x, y, h, kind='conifer', decor=False):
        """Ağaç: gövde silindiri + taç (iğne yapraklıda koni → üst üste iki küre yaklaşımı; geniş yapraklıda küre). Çarpışma: gövde + taç."""
        tr = 0.18 + h * 0.012
        self.silindir(x, y, 0, tr, h * 0.55, mat='bark', decor=decor, part='tree', tree=kind, th=round(h, 2))
        if kind == 'conifer':
            rr = h * 0.2
            self.kure(x, y, h * 0.45, rr * 1.15, mat='needle', decor=decor, part='crown')
            self.kure(x, y, h * 0.72, rr * 0.75, mat='needle', decor=decor, part='crown')
        else:
            rr = h * 0.3
            self.kure(x, y, h * 0.62, rr, mat='leaf', decor=decor, part='crown')

    def duvar(self, x0, y0, x1, y1, h, t=0.3, z=0.0, holes=None, mat='concrete', **kw):
        """(x0,y0) → (x1,y1) boyunca duvar; `holes` [{s (başlangıçtan uzaklık), v (tabandan merkez yüksekliği), w, h}] — pencere / kapı boşluğu.
        Kutunun sağ (w) ekseni duvar doğrultusudur → yaw = doğrultu − 90 (kutunun 'ileri' normali doğrultunun soluna bakar)."""
        L = math.hypot(x1 - x0, y1 - y0)
        dog = yon((x0, y0), (x1, y1))
        yaw = (dog - 90.0) % 360   # sağ(yaw) = doğrultu
        hl = [{'u': hh['s'] - L / 2, 'v': hh['v'], 'w': hh['w'], 'h': hh['h']} for hh in (holes or ())]
        return self.kutu((x0 + x1) / 2, (y0 + y1) / 2, z, L, t, h, yaw=yaw, mat=mat, holes=hl, axis='y', **kw)

    def sonuc(self, **meta):
        # çerçeve engelleri (çarpışma; görseli kapıdan çizilir → vis False)
        for i, g in enumerate(self.gates):
            self.obstacles.extend(kapi_engelleri(g, i))
        return {'id': self.cid, 'venue': self.venue, **meta, 'gates': self.gates, 'obstacles': self.obstacles, 'decor': self.decor}


def kapi_engelleri(g, i=None):
    """Çerçeveli kapıların çarpışma ilkelleri (çerçeve + ayaklar). Görünmez (`vis: False`): istemci kapıyı neon çerçeve olarak kendisi çizer."""
    if not g.get('frame') or g['kind'] in ('window', 'tunnel', 'flag', 'slalom'):
        return []
    out = []
    b = CERCEVE_B
    o = {'vis': False, 'gate': i, 'part': 'frame', 'mat': 'frame'}
    if g['kind'] == 'circle':
        R = g['r'] + 0.15
        out.append({'t': 'torus', 'x': g['x'], 'y': g['y'], 'z': g['z'], 'yaw': g['yaw'], 'R': R, 'tube': 0.15, **o})
        alt = g['z'] - R - 0.15
        if alt > 0.3:
            out.append({'t': 'cyl', 'x': g['x'], 'y': g['y'], 'z': 0.0, 'r': 0.08, 'h': alt, **o})
        return out
    if g['kind'] == 'dive':
        w, d = g['w'] + 2 * b, g['h'] + 2 * b
        out.append({'t': 'box', 'x': g['x'], 'y': g['y'], 'z': g['z'] - CERCEVE_T / 2, 'w': w, 'd': d, 'h': CERCEVE_T, 'yaw': g['yaw'],
                    'holes': [{'u': 0.0, 'v': 0.0, 'w': g['w'], 'h': g['h']}], 'axis': 'z', **o})
        r, f = sag(g['yaw']), ileri(g['yaw'])
        for su in (-1, 1):
            for sv in (-1, 1):
                px = g['x'] + r[0] * su * (w / 2 - b / 2) + f[0] * sv * (d / 2 - b / 2)
                py = g['y'] + r[1] * su * (w / 2 - b / 2) + f[1] * sv * (d / 2 - b / 2)
                out.append({'t': 'cyl', 'x': round(px, 3), 'y': round(py, 3), 'z': 0.0, 'r': 0.07, 'h': max(0.1, g['z'] - CERCEVE_T), **o})
        return out
    w, h = g['w'] + 2 * b, g['h'] + 2 * b
    taban = g['z'] - g['h'] / 2 - b
    out.append({'t': 'box', 'x': g['x'], 'y': g['y'], 'z': taban, 'w': w, 'd': CERCEVE_T, 'h': h, 'yaw': g['yaw'],
                'holes': [{'u': 0.0, 'v': b + g['h'] / 2, 'w': g['w'], 'h': g['h']}], 'axis': 'y', **o})
    if taban > 0.3 and g['kind'] != 'ladder':
        r = sag(g['yaw'])
        for s in (-1, 1):
            out.append({'t': 'cyl', 'x': round(g['x'] + r[0] * s * (w / 2 - b / 2), 3), 'y': round(g['y'] + r[1] * s * (w / 2 - b / 2), 3), 'z': 0.0,
                        'r': 0.07, 'h': taban, **o})
    return out


def _dongu_yaw(noktalar, k):
    a, b = noktalar[k - 1], noktalar[(k + 1) % len(noktalar)]
    return yon(a, b)


# ================================================================= HAZIR PARKURLAR
def _hangar():
    """Kapalı depo / hangar: 60 × 36 m, tavan 9 m; raflar, tavan kirişleri, alçak kanal borusu, bölme duvarında kapı aralığı, merdiven kapı."""
    K = _Kurucu('hangar', 'hangar', 11)
    X, Y, H = 30.0, 18.0, 9.0
    # kabuk: duvarlar + tavan (çatı) — iç yüzeyler çarpışır
    K.kutu(0, -Y - 0.3, 0, 2 * X + 1.2, 0.6, H + 0.6, mat='hangar_wall', side='S')
    K.kutu(0, Y + 0.3, 0, 2 * X + 1.2, 0.6, H + 0.6, mat='hangar_wall', side='N')
    K.kutu(-X - 0.3, 0, 0, 0.6, 2 * Y, H + 0.6, mat='hangar_wall')
    K.kutu(X + 0.3, 0, 0, 2 * Y, 0.6, H + 0.6, mat='hangar_wall', holes=[{'u': 0, 'v': 3.0, 'w': 10, 'h': 6}], axis='y', yaw=90)   # açık kapı (ışık)
    K.kutu(0, 0, H, 2 * X, 2 * Y, 0.6, mat='hangar_roof')
    for x in range(-24, 25, 8):   # çatı makas kirişleri (alt başlık 7,8 m)
        K.kutu(x, 0, 7.8, 0.35, 2 * Y, 0.4, mat='steel_beam')
    # orta raf sırası (y = 0), yükseklik 6 m — şeritleri ayırır
    for x0 in (-14.0, -4.0, 6.0):
        K.kutu(x0 + 4, 0, 0, 8.0, 1.4, 6.0, mat='rack', yaw=0)
        for k in range(3):   # raf üstü koliler (dekor)
            K.kutu(x0 + 1.5 + k * 2.5, 0, 6.0, 1.6, 1.2, 0.9, mat='crate', decor=True)
    # duvar dibi raflar (kuzey/güney)
    for x in range(-26, 27, 9):
        K.kutu(x, -Y + 1.0, 0, 7.0, 1.6, 4.5, mat='rack')
        K.kutu(x, Y - 1.0, 0, 7.0, 1.6, 4.5, mat='rack')
    # bölme duvarı (x = 0, kuzey yarı) — kapı aralığı (pencere kapısı)
    K.duvar(0, 4.5, 0, Y, H, t=0.35, holes=[{'s': 6.5, 'v': 2.0, 'w': 3.6, 'h': 3.2}], mat='block')
    # güney şerit: alçak kanal borusu (altından geçiş)
    K.boru((10, -Y, 3.6), (10, -2.2, 3.6), 0.45, mat='duct')
    # forklift + paletler (dekor ve engel)
    K.kutu(26, -14.5, 0, 1.4, 2.6, 2.2, mat='forklift', yaw=20)
    for k in range(4):
        K.kutu(-26 + k * 1.4, 8, 0, 1.2, 1.0, 0.3 + 0.15 * (k % 3), mat='pallet', decor=True)
    # merdiven kapı (kuzeybatı): 2 kat üst üste, ters yönlerde
    lx, ly = -18.0, 10.0
    K.kutu(lx, ly, 0, 4.6, 0.3, 7.2, mat='truss', yaw=90, holes=[{'u': 0, 'v': 1.9, 'w': 3.4, 'h': 2.8}, {'u': 0, 'v': 5.3, 'w': 3.4, 'h': 2.6}], axis='y')
    # kapılar
    K.kapi('start', -16, -11, 2.2, 90, w=3.4, h=2.8, label='S/F')
    K.kapi('circle', -3, -11, 2.4, 90, r=1.6)
    K.kapi('gate', 10, -11, 1.6, 90, w=3.0, h=2.2, sector_end=True)          # boru altı
    K.kapi('gate', 24, 0, 2.6, 0, w=3.4, h=3.2, via=[[22, -8, 2.4]])
    K.kapi('window', 0, 11, 2.0, 270, w=3.6, h=3.2, frame=False, via=[[16, 9, 2.2]], sector_end=True)
    K.kapi('ladder', lx, ly, 1.9, 270, w=3.4, h=2.8, frame=False, via=[[-10, 11.5, 2.0]])
    K.kapi('ladder', lx, ly, 5.3, 90, w=3.4, h=2.6, frame=False, via=[[-24, 8.0, 3.2], [-24, 9.5, 5.3]])
    K.kapi('circle', -6, 6.0, 4.6, 90, r=1.5, via=[[-12, 9.5, 5.2]])
    K.kapi('gate', -24, -2, 2.4, 180, w=3.4, h=3.0, via=[[-2, 3.2, 3.8], [-15, 3.0, 3.0], [-24, 4, 2.6]])
    return K.sonuc(difficulty=2, laps=3, start={'x': -22.5, 'y': -11.0, 'yaw': 90.0, 'cols': 3, 'gap': 2.0},
                   env={'time': 'day', 'fog': 0.05, 'sky': 'indoor', 'ground': 'concrete', 'light': 'warm', 'ceiling': H, 'size': [2 * X, 2 * Y]},
                   bot_vmax=6.5, par_lap_s=28.0)


def _orman():
    """Çam ormanı: ağaç aralıklarından geçiş, devrik gövde altından geçiş, açıklıkta bayrak dönüşü."""
    K = _Kurucu('forest', 'forest', 23)
    pts = [(0, -42), (-30, -30), (-46, 0), (-30, 30), (0, 40), (30, 28), (44, 0), (26, -26)]
    z = [2.2, 2.6, 2.0, 2.8, 2.4, 2.0, 2.6, 2.2]
    for k, (x, y) in enumerate(pts):
        yaw = _dongu_yaw(pts, k)
        if k == 0:
            K.kapi('start', x, y, z[k], yaw, w=4.0, h=3.2, label='S/F')
        elif k == 2:   # devrik gövde altı
            K.kapi('gate', x, y, 1.6, yaw, w=4.0, h=2.2, frame=False)
            f = sag(yaw)
            K.boru((x - f[0] * 7, y - f[1] * 7, 3.2), (x + f[0] * 7, y + f[1] * 7, 3.0), 0.42, mat='log')
            K.kutu(x - f[0] * 2.6, y - f[1] * 2.6, 0, 0.5, 0.5, 3.0, yaw=yaw, mat='log', part='stump')
            K.kutu(x + f[0] * 2.6, y + f[1] * 2.6, 0, 0.5, 0.5, 2.8, yaw=yaw, mat='log', part='stump')
        elif k == 4:   # açıklıkta bayrak etrafından dönüş
            K.kapi('circle', x, y, z[k], yaw, r=1.8, sector_end=True)
        elif k == 6:
            K.kapi('gate', x, y, z[k], yaw, w=3.6, h=3.0, sector_end=True)
        else:
            K.kapi('gate' if k % 2 else 'circle', x, y, z[k], yaw, w=3.6, h=3.0, r=None if k % 2 else 1.8)
    # açıklık (0, 0) çevresinde bayrak: kuzeydoğu girişinden güneye — iç hat
    K.bayrak(10, 8, 150, 'left', w=9.0, via=None)
    K.gates[-1]['via'] = [[18, 22, 2.6]]
    # bayrak kapısını hatta yerleştir: 5 (30, 28) ile 6 (44, 0) arasına değil — sıra: … 5, bayrak, 6 …
    flag = K.gates.pop()
    K.gates.insert(6, flag)
    K.gates[7]['via'] = [[26, 2, 2.4]]
    hat = yaris_hatti({'gates': K.gates, 'start': {'x': 0, 'y': -52, 'yaw': 0}}, kapali=True)
    # ağaçlar: 150 × 130 m alana tohumlu; hatta 4,5 m'den, kapı/direk çevresine 5 m'den, açıklık merkezine 9 m'den yakın olanlar atlanır
    for _ in range(900):
        x, y = K.rng.uniform(-75, 75), K.rng.uniform(-65, 65)
        if math.hypot(x - 4, y - 2) < 9:
            continue
        h = K.rng.uniform(11, 21)
        if _hat_uzakligi(hat, (x, y)) < 4.8 + h * 0.06 or any(math.hypot(x - g['x'], y - g['y']) < 6 for g in K.gates):
            continue
        if math.hypot(x, y + 52) < 10:
            continue
        if sum(1 for e in K.obstacles if e.get('part') == 'tree') >= 190:
            break
        K.agac(x, y, h, 'conifer' if K.rng.random() < 0.7 else 'broad')
    for _ in range(140):   # çalılar / taşlar (dekor)
        x, y = K.rng.uniform(-80, 80), K.rng.uniform(-70, 70)
        K.kure(x, y, 0.2, K.rng.uniform(0.4, 1.1), mat='bush' if K.rng.random() < 0.7 else 'rock', decor=True)
    return K.sonuc(difficulty=3, laps=2, start={'x': 0.0, 'y': -52.0, 'yaw': 0.0, 'cols': 4, 'gap': 2.4},
                   env={'time': 'day', 'fog': 0.35, 'sky': 'overcast', 'ground': 'forest', 'light': 'soft', 'size': [160, 140]},
                   bot_vmax=8.0, par_lap_s=40.0)


def _hat_uzakligi(hat, p):
    """Yatay (x, y) noktanın yarış hattı çoklu doğrusuna en kısa uzaklığı."""
    best = 1e9
    for seg in hat:
        for a, b in zip(seg[:-1], seg[1:]):
            ax, ay, bx, by = a[0], a[1], b[0], b[1]
            dx, dy = bx - ax, by - ay
            L2 = dx * dx + dy * dy or 1e-9
            s = max(0.0, min(1.0, ((p[0] - ax) * dx + (p[1] - ay) * dy) / L2))
            best = min(best, math.hypot(p[0] - ax - dx * s, p[1] - ay - dy * s))
    return best


def _bina(K, cx, cy, w, d, katlar, kat_h=3.4, yaw=0.0, mat='brick', pencere=None, yikik=0.0, cati=True):
    """Kat kat bina kabuğu: dört duvar (pencere boşluklu) + döşemeler. `pencere` {(cephe, kat, s): (w, h)} özel boşluklar; varsayılan küçük
    pencereler. `yikik` (0…1): üst katlarda eksik duvar parçaları (dekor). Cephe: 'S','N','W','E' (yaw = 0 için)."""
    r, f = sag(yaw), ileri(yaw)
    def P(u, v):
        return (cx + r[0] * u + f[0] * v, cy + r[1] * u + f[1] * v)
    H = katlar * kat_h
    kenar = {'S': (P(-w / 2, -d / 2), P(w / 2, -d / 2), w), 'N': (P(w / 2, d / 2), P(-w / 2, d / 2), w),
             'E': (P(w / 2, -d / 2), P(w / 2, d / 2), d), 'W': (P(-w / 2, d / 2), P(-w / 2, -d / 2), d)}
    for ad, (a, b, L) in kenar.items():
        holes = []
        for kat in range(katlar):
            ozel = [(s, wh) for (c, kk, s), wh in (pencere or {}).items() if c == ad and kk == kat]
            if ozel:
                for s, (pw, ph) in ozel:
                    holes.append({'s': s, 'v': kat * kat_h + 0.9 + ph / 2 if ph < kat_h - 1.2 else kat * kat_h + ph / 2 + 0.1, 'w': pw, 'h': ph})
            n = max(1, int(L // 4.5))
            for j in range(n):
                s = (j + 0.5) * L / n
                if any(abs(s - so) < (pw / 2 + 1.4) for so, (pw, _) in ozel):
                    continue
                holes.append({'s': s, 'v': kat * kat_h + 1.7, 'w': 1.2, 'h': 1.4})
        K.duvar(a[0], a[1], b[0], b[1], H, t=0.35, holes=holes, mat=mat)
    for kat in range(1, katlar + (1 if cati else 0)):
        K.kutu(cx, cy, kat * kat_h - 0.3, w, d, 0.3, yaw=yaw, mat='slab')


def _sehir():
    """Yarı yıkık şehir: sokak aralığı, pencereden içeri-dışarı (bina içinden geçiş), köprü altı, devrik direk."""
    K = _Kurucu('city', 'city', 37)
    # A binası (içinden geçilir): batı cephe penceresinden gir, doğu cephe penceresinden çık (zemin kat)
    _bina(K, -20, 10, 14, 10, 3, pencere={('W', 0, 5.0): (3.0, 2.4), ('E', 0, 5.0): (3.0, 2.4), ('S', 1, 7.0): (3.0, 2.2)}, mat='brick')
    # B ve C binaları arasında dar sokak (sokak aralığı 6 m)
    _bina(K, 14, 18, 12, 14, 4, mat='plaster')
    _bina(K, 14, -2, 12, 14, 2, mat='plaster', cati=False)
    # köprü (yaya üst geçidi) — altından geçiş: tabla z 5,5 … 6,3, ayaklar
    K.kutu(36, 8, 5.5, 4.0, 26, 0.8, mat='bridge')
    for yy in (-4.0, 20.0):
        K.kutu(36, yy, 0, 3.0, 1.2, 5.5, mat='concrete', part='pier')
    # yıkıntı / moloz (dekor) + devrik elektrik direği
    for _ in range(40):
        K.kure(K.rng.uniform(-40, 50), K.rng.uniform(-30, 40), 0.0, K.rng.uniform(0.3, 0.9), mat='rubble', decor=True)
    K.boru((-4, -24, 0.4), (4, -16, 3.6), 0.18, mat='pole')
    # çevre binaları (sahne dekoru ve engel)
    for bx, by, bw, bd, bk in ((-44, -26, 12, 10, 4), (-46, 38, 14, 12, 5), (54, 36, 12, 12, 6), (56, -22, 10, 14, 3), (2, 44, 16, 8, 3)):
        _bina(K, bx, by, bw, bd, bk, mat='plaster' if bk % 2 else 'brick')
    # kapılar
    K.kapi('start', -6, -20, 2.4, 0, w=4.0, h=3.0, label='S/F')
    K.kapi('window', -27.0, 10.0, 1.3, 90, w=2.8, h=2.2, frame=True, via=[[-30, -10, 2.0], [-33, 10, 1.5]])   # A batı penceresi → içeri
    K.kapi('window', -13.0, 10.0, 1.3, 90, w=2.8, h=2.2, frame=True, sector_end=True)                          # A doğu penceresi → dışarı
    K.kapi('gate', 14, 8, 2.6, 90, w=3.6, h=3.2, via=[[2, 10, 2.4]])       # sokak aralığı (B ile C arası, y 5…11)
    K.kapi('gate', 36, 8, 2.4, 90, w=3.4, h=3.6, sector_end=True)         # köprü altı
    K.kapi('circle', 44, -14, 3.0, 200, r=1.8, via=[[46, 4, 2.6]])
    K.bayrak(26, -22, 270, 'left', w=10.0)
    K.kapi('gate', 4, -28, 2.6, 270, w=3.6, h=3.0, via=[[12, -24, 2.6]])
    K.gates[-1]['via'] = [[10, -27, 2.6]]
    K.kapi('circle', -14, -26, 2.2, 0, r=1.6, via=[[-12, -30, 2.4], [-14, -30.5, 2.2]])
    # son: S/F'ye dönüş için ilk kapı tekrar kontrol (sıra kapalı döngü)
    return K.sonuc(difficulty=4, laps=2, start={'x': -6.0, 'y': -30.0, 'yaw': 0.0, 'cols': 4, 'gap': 2.2},
                   env={'time': 'dusk', 'fog': 0.3, 'sky': 'hazy', 'ground': 'asphalt', 'light': 'warm', 'size': [120, 90]},
                   bot_vmax=7.5, par_lap_s=32.0)


def _stadyum():
    """Stadyum: klasik yarış kapıları, bayraklar, tünel, dalış kapısı, merdiven kapı, slalom direkleri."""
    K = _Kurucu('stadium', 'stadium', 5)
    # tribünler (kademeli; engel) + çatı (dekor)
    for side in (-1, 1):
        for k in range(6):
            K.kutu(0, side * (40 + k * 1.6), 0, 110, 1.6, 1.2 + k * 1.1, mat='stand', yaw=0)
        K.kutu(side * (62 + 4.8), 0, 0, 1.6 * 6, 80, 4.0, mat='stand', decor=True)
    for x in (-50, 50):   # ışık direkleri
        for y in (-46, 46):
            K.silindir(x, y, 0, 0.5, 30, mat='steel', part='floodlight')
    # kapılar: saat yönünün tersine oval
    K.kapi('start', 0, -20, 2.4, 90, w=4.0, h=3.0, label='S/F')
    K.kapi('gate', 22, -20, 2.4, 90, w=3.6, h=3.0)
    # tünel (8 m; şişme) — kontrol noktası tünel ortasında
    tx, ty = 38.0, -12.0
    K.kapi('tunnel', tx, ty, 1.6, 30, w=3.0, h=2.6, frame=False, a=6.5, via=[[33, -19, 1.6]])
    f = ileri(30)
    K.kutu(tx, ty, 0, 4.0, 8.0, 3.4, yaw=30, mat='inflatable', holes=[{'u': 0, 'v': 1.6, 'w': 3.0, 'h': 2.6}], axis='y')
    # bayrak dönüşü (doğu uç)
    K.bayrak(50, 6, 0, 'right', w=9.0, sector_end=True, via=[[44 + f[0], -2, 2.4]])
    # dalış kapısı: 7 m iskelede, yukarıdan aşağı
    K.kapi('dive', 30, 18, 6.0, 270, w=3.4, h=3.4, via=[[42, 18, 6.0], [33, 18, 9.0]])
    for sx in (-1, 1):
        for sy in (-1, 1):
            K.silindir(30 + sx * 2.3, 18 + sy * 2.3, 0, 0.12, 5.8, mat='scaffold', decor=True)
    # merdiven kapı (2 kat; iskele) — alt kat batıya, üst kat doğuya
    lx, ly = 8.0, 20.0
    K.kutu(lx, ly, 0, 4.4, 0.3, 7.0, yaw=90, mat='truss', holes=[{'u': 0, 'v': 1.8, 'w': 3.2, 'h': 2.6}, {'u': 0, 'v': 5.1, 'w': 3.2, 'h': 2.6}], axis='y')
    K.kapi('ladder', lx, ly, 1.8, 270, w=3.2, h=2.6, frame=False, via=[[22, 19, 1.8]])
    K.kapi('ladder', lx, ly, 5.1, 90, w=3.2, h=2.6, frame=False, via=[[1, 18.5, 2.6], [1, 20, 5.1]], sector_end=True)
    # slalom (4 direk) batıya
    for k, sx in enumerate((-4.0, -12.0, -20.0, -28.0)):
        K.bayrak(sx, 12.0, 270, 'left' if k % 2 else 'right', w=6.0, h=4.0, kind='slalom',
                 via=[[14, 21, 4.6], [4, 14, 3.0]] if k == 0 else None)
    # batı bayrağı ve dönüş
    K.bayrak(-46, 0, 180, 'right', w=9.0, via=[[-40, 10, 2.4]])
    K.kapi('circle', -26, -20, 2.4, 90, r=1.8, via=[[-42, -14, 2.4]])
    return K.sonuc(difficulty=2, laps=3, start={'x': -10.0, 'y': -20.0, 'yaw': 90.0, 'cols': 4, 'gap': 2.4},
                   env={'time': 'night', 'fog': 0.08, 'sky': 'night_stadium', 'ground': 'turf', 'light': 'flood', 'size': [130, 100]},
                   bot_vmax=9.0, par_lap_s=41.0)


def _rafineri():
    """Rafineri / endüstriyel tesis: boru köprüleri altından alçak geçiş, sarı korkuluklu ızgara yürüyüş yolu, tanklar, konteyner koridoru, baca
    etrafında dönüş."""
    K = _Kurucu('refinery', 'refinery', 71)
    # boru köprüsü 1 (doğu-batı, y = −10): portal ayaklar (iki direk + kiriş z 2,8…3,1) + 5 boru (z 3,4 … 3,65) — altından alçak geçiş
    for x in range(-40, 41, 10):
        for yy in (-12.8, -7.2):
            K.silindir(x, yy, 0, 0.2, 3.1, mat='steel_frame', part='pipe_rack_leg')
        K.kutu(x, -10, 2.8, 0.35, 6.0, 0.3, mat='steel_frame', part='pipe_rack_beam')
    for k, yy in enumerate((-12.2, -11.1, -10.0, -8.9, -7.8)):
        K.boru((-42, yy, 3.4 + 0.25 * (k % 2)), (42, yy, 3.4 + 0.25 * (k % 2)), 0.42 if k == 2 else 0.3, mat='pipe_insulated' if k == 2 else 'pipe')
    # boru köprüsü 2 (kuzey-güney, x = 30): yüksek portal (kiriş z 5,4) + 4 boru z 6
    for y in range(-2, 31, 8):
        for xx in (27.2, 32.8):
            K.silindir(xx, y, 0, 0.2, 5.8, mat='steel_frame', part='pipe_rack_leg')
        K.kutu(30, y, 5.4, 6.0, 0.35, 0.4, mat='steel_frame', part='pipe_rack_beam')
    for k, xx in enumerate((28.0, 29.3, 30.6, 31.9)):
        K.boru((xx, -4, 6.0), (xx, 32, 6.0), 0.35, mat='pipe')
    # yürüyüş yolu (ızgara platform z 2,5, sarı korkuluk) — üstünden geçiş yok; yanından
    K.kutu(-20, 10, 2.3, 26, 2.4, 0.2, mat='grating')
    for s in (-1, 1):
        K.kutu(-20, 10 + s * 1.15, 2.5, 26, 0.08, 1.1, mat='railing_yellow')
    for x in (-32, -20, -8):
        K.silindir(x, 10, 0, 0.18, 2.3, mat='steel')
    # tanklar
    for tx, ty, tr, th in ((-34, 30, 7.0, 12.0), (-14, 34, 6.0, 10.0), (8, 40, 7.5, 13.0)):
        K.silindir(tx, ty, 0, tr, th, mat='tank')
    # konteyner koridoru (iki sıra, 2 kat; koridor 5 m)
    for k in range(5):
        for s in (-1, 1):
            K.kutu(-2 + k * 6.3, 18 + s * 3.8, 0, 6.06, 2.44, 2.6, mat=f'container_{(k + (s > 0)) % 4}', yaw=90)
            if k % 2 == 0:
                K.kutu(-2 + k * 6.3, 18 + s * 3.8, 2.6, 6.06, 2.44, 2.6, mat=f'container_{(k + 2) % 4}', yaw=90)
    # baca (z 0 … 42) — etrafında dönüş
    bx, by = 54.0, 20.0
    K.silindir(bx, by, 0, 2.2, 42, mat='chimney')
    # kapılar
    K.kapi('start', -30, -22, 2.2, 90, w=3.8, h=3.0, label='S/F')
    K.kapi('gate', -12, -10, 1.6, 0, w=3.2, h=2.2, via=[[-14, -17, 1.7]])           # boru köprüsü altı (kuzeye)
    K.kapi('gate', 8, -10, 1.6, 180, w=3.2, h=2.2, via=[[0, -2, 2.0], [8, -3, 1.7]])   # yeniden altından (güneye)
    K.kapi('circle', 24, -20, 2.4, 90, r=1.7, via=[[12, -18, 2.2]], sector_end=True)
    K.kapi('gate', 30, 10, 3.2, 0, w=3.4, h=3.0, via=[[34, -14, 2.2]])                     # boru köprüsü 2 portalları arasında
    K.bayrak(bx, by, 0, 'right', w=8.0, pole_r=2.2, pole=False, via=[[30, 17.5, 3.2], [bx + 6, by - 8, 3.0]])   # bacanın doğusundan kuzeye
    K.bayrak(bx, by, 180, 'right', w=8.0, pole_r=2.2, pole=False, via=[[bx + 6, by + 8, 3.0], [bx, by + 9, 3.0]], sector_end=True)   # batısından güneye (tam tur)
    K.kapi('gate', 26, 18, 2.0, 270, w=3.2, h=2.6)                                        # konteyner koridoruna giriş
    K.kapi('gate', -6, 18, 2.0, 270, w=3.2, h=2.6)                                        # koridor çıkışı
    K.kapi('circle', -36, 4, 2.6, 180, r=1.8, via=[[-24, 20, 3.0], [-36, 16, 3.0]])
    return K.sonuc(difficulty=4, laps=2, start={'x': -40.0, 'y': -22.0, 'yaw': 90.0, 'cols': 4, 'gap': 2.2},
                   env={'time': 'day', 'fog': 0.2, 'sky': 'clear', 'ground': 'industrial', 'light': 'sun', 'size': [140, 90]},
                   bot_vmax=8.0, par_lap_s=42.0)


def _kanyon():
    """Kanyon / dağ geçidi: dar vadi (iki kaya duvarı), kaya kemeri, şelale arkasından geçiş, sırt etrafından dönüş."""
    K = _Kurucu('canyon', 'canyon', 91)
    # iki paralel vadi (x = −14 ve x = +14), arada sırt (x −6…6), dış duvarlar; vadi tabanı y −70…70
    for y0 in range(-70, 71, 10):
        jitter = K.rng.uniform(-0.8, 0.8)
        K.kutu(-27 + jitter, y0, 0, 6, 10.5, 26, mat='rock_wall')        # batı dış duvar
        K.kutu(27 - jitter, y0, 0, 6, 10.5, 24, mat='rock_wall')         # doğu dış duvar
        if -54 < y0 < 54:
            K.kutu(0, y0, 0, 10 + jitter, 10.5, 30, mat='rock_wall')       # orta sırt
    # kaya kemeri (batı vadisinde, y = 10): vadiyi kapatan kaya, ortasında geçit
    K.kutu(-13.5, 10, 0, 16, 5, 18, mat='rock_arch', yaw=0, holes=[{'u': 0, 'v': 3.2, 'w': 5.0, 'h': 4.6}], axis='y')
    # dar boğaz (doğu vadisinde y = −20): iki yandan çıkıntı
    K.kutu(9.5, -20, 0, 5, 4, 20, mat='rock_wall')
    K.kutu(19.0, -20, 0, 5, 4, 20, mat='rock_wall')
    # şelale: kuzey uçta (y = 70) kaya yüzü; su perdesi y = 64 (dekor, geçilir), arkasında mağara geçidi
    K.kutu(0, 76, 0, 60, 6, 30, mat='rock_wall')
    K.kutu(0, 63.8, 0.0, 8.0, 0.2, 14.0, mat='waterfall', decor=True)
    K.kutu(0, 58, 0, 26, 9.0, 0.25, mat='water', decor=True)   # şelale havuzu
    # düşen kayalar (engel) ve dağınık kayalar (dekor)
    for x, y, r in ((-10, -40, 1.6), (-17, 34, 1.4), (12, 30, 1.8), (17, -48, 1.5)):
        K.kure(x, y, 0.6, r, mat='rock')
    for _ in range(60):
        K.kure(K.rng.choice((-1, 1)) * K.rng.uniform(8, 22), K.rng.uniform(-70, 70), 0.0, K.rng.uniform(0.4, 1.0), mat='rock', decor=True)
    # kapılar (saat yönünün tersine: batı vadisinden kuzeye, şelale arkasından doğuya, doğu vadisinden güneye, güney uçtan batıya)
    K.kapi('start', -14, -50, 3.0, 0, w=4.4, h=3.6, label='S/F')
    K.kapi('gate', -12, -24, 4.0, 0, w=4.0, h=3.4)
    K.kapi('window', -13.5, 10, 3.2, 0, w=4.6, h=4.2, frame=False, label='arch', a=4.5)                 # kaya kemeri
    K.kapi('circle', -14, 42, 6.0, 0, r=2.2, sector_end=True)
    K.kapi('gate', 0, 62, 3.4, 90, w=4.0, h=3.6, via=[[-13, 56, 4.0], [-8, 62, 3.6]], label='waterfall')   # şelale arkası
    K.kapi('gate', 14, 40, 5.0, 180, w=4.0, h=3.6, via=[[13, 58, 4.4]], sector_end=True)
    K.kapi('gate', 14.25, -20, 2.6, 180, w=3.2, h=3.0, label='gorge')                                    # dar boğaz
    K.kapi('circle', 14, -50, 3.0, 180, r=2.0)
    K.bayrak(0, -62, 270, 'left', w=10.0, via=[[13, -60, 3.0]])
    return K.sonuc(difficulty=5, laps=1, start={'x': -14.0, 'y': -62.0, 'yaw': 0.0, 'cols': 3, 'gap': 2.4},
                   env={'time': 'day', 'fog': 0.25, 'sky': 'clear', 'ground': 'rock', 'light': 'sun_low', 'size': [70, 160], 'canyon': True},
                   bot_vmax=9.0, par_lap_s=34.0)


def _ahsap_ev():
    """Tepedeki ahşap ev iskeleti (çayır + sis + dağ manzarası): kapı/pencere boşluklarına oturtulmuş neon kapılar; üst kat penceresi."""
    K = _Kurucu('woodframe', 'woodframe', 17)
    cx, cy, W, D, kh = 0.0, 0.0, 12.0, 9.0, 3.0
    # iskelet: köşe ve ara dikmeler (0,15 m), kat kirişleri, çatı makasları
    def dikme(x, y, h=2 * kh):
        K.kutu(x, y, 0, 0.16, 0.16, h, mat='timber', part='stud')
    xs = [-6, -4.4, -1.6, 1.6, 4.4, 6]
    ys = [-4.5, -2.4, 0.0, 2.4, 4.5]
    for x in xs:
        dikme(x, -4.5)
        dikme(x, 4.5)
    for y in ys[1:-1]:
        dikme(-6, y)
        dikme(6, y)
    for z in (kh, 2 * kh):   # kuşak kirişleri (dört cephe)
        K.kutu(cx, -4.5, z - 0.2, W, 0.18, 0.2, mat='timber')
        K.kutu(cx, 4.5, z - 0.2, W, 0.18, 0.2, mat='timber')
        K.kutu(-6, cy, z - 0.2, 0.18, D, 0.2, mat='timber')
        K.kutu(6, cy, z - 0.2, 0.18, D, 0.2, mat='timber')
    # üst kat döşemesi: yarısı kaplı (doğu yarısı), batı yarısı açık kirişler
    K.kutu(3.0, 0, kh - 0.2, 6.0, D, 0.2, mat='planks')
    for x in (-4.4, -1.6):
        K.kutu(x, 0, kh - 0.2, 0.16, D, 0.2, mat='timber')
    # pencere denizlikleri (alt kat pencere boşluklarını tanımlar; güney cephe x −4,4…−1,6 ve 1,6…4,4)
    K.kutu(-3.0, -4.5, 0.0, 2.8, 0.16, 0.8, mat='timber')
    K.kutu(3.0, 4.5, 0.0, 2.8, 0.16, 0.8, mat='timber')
    # çatı makasları (beşik çatı; mahya z 9, kuzey-güney yönünde)
    for x in (-6, -3, 0, 3, 6):
        K.boru((x, -4.6, 2 * kh), (x, 0, 9.0), 0.1, mat='timber')
        K.boru((x, 4.6, 2 * kh), (x, 0, 9.0), 0.1, mat='timber')
    K.boru((-6.3, 0, 9.0), (6.3, 0, 9.0), 0.12, mat='timber')
    for k in range(1, 4):   # aşıklar
        z = 2 * kh + (9.0 - 2 * kh) * k / 4
        yy = 4.6 * (1 - k / 4)
        for s in (-1, 1):
            K.boru((-6.3, s * yy, z), (6.3, s * yy, z), 0.07, mat='timber')
    # çevre: çit, kayalar, ağaçlar (uzak), saman balyaları
    for x in range(-30, 31, 3):
        K.kutu(x, -22, 0, 0.12, 0.12, 1.1, mat='timber', decor=True)
    K.kutu(0, -22, 0.75, 60, 0.08, 0.12, mat='timber', decor=True)
    for x, y in ((-18, 12), (20, -8), (-22, -10)):
        K.kutu(x, y, 0, 1.6, 1.2, 1.1, mat='hay', yaw=K.rng.uniform(0, 90))
    for _ in range(30):
        a, r = K.rng.uniform(0, 2 * math.pi), K.rng.uniform(38, 70)
        K.agac(r * math.sin(a), r * math.cos(a), K.rng.uniform(9, 16), 'conifer' if K.rng.random() < 0.6 else 'broad', decor=True)
    # kapılar — neon çerçeveler yapının boşluklarına oturur
    K.kapi('start', 0, -16, 2.0, 0, w=3.6, h=3.0, label='S/F')
    K.kapi('window', 0, -4.5, 1.3, 0, w=2.6, h=2.2, label='door')                                     # ön kapı (güney, x −1,6…1,6) → içeri
    K.kapi('window', 6.0, -1.2, 1.4, 90, w=2.0, h=2.0, label='window', sector_end=True)               # doğu cephe penceresi → dışarı
    K.kapi('circle', 16, 6, 3.0, 0, r=1.7, via=[[12, -1, 2.0]])
    K.kapi('window', 3.0, 4.5, 4.3, 180, w=2.4, h=2.2, label='upper_window', via=[[12, 14, 4.0], [3.0, 10, 4.3]])   # kuzey üst kat penceresi → üst kata
    K.kapi('window', -3.0, -4.5, 4.3, 180, w=2.4, h=2.2, label='upper_window', sector_end=True)                     # güney üst kat penceresi → dışarı
    K.kapi('circle', -14, -6, 2.6, 0, r=1.8, via=[[-4, -10, 3.4], [-12, -12, 2.8]])
    K.kapi('window', -6.0, 1.2, 1.4, 90, w=2.0, h=2.0, label='window', via=[[-12, 2, 1.6]])                        # batı pencere → içeri
    K.kapi('window', -3.0, -4.5, 1.6, 180, w=2.4, h=1.6, label='window', via=[[-4, -1, 1.6]])                     # güney alt pencere → dışarı (denizlik üstü)
    return K.sonuc(difficulty=3, laps=3, start={'x': 0.0, 'y': -24.0, 'yaw': 0.0, 'cols': 4, 'gap': 2.2},
                   env={'time': 'dusk', 'fog': 0.45, 'sky': 'misty', 'ground': 'meadow', 'light': 'golden', 'size': [80, 80], 'hill': True},
                   bot_vmax=6.0, par_lap_s=24.0)


def _beton_bina():
    """Yarım kalmış çok katlı beton bina: kolon ızgarası, döşemeler, yarım duvarlarda pencere boşlukları; kat kat içeri-dışarı geçiş, merdiven
    boşluğundan aşağı dalış."""
    K = _Kurucu('concrete', 'concrete', 53)
    W, D, kh, n = 24.0, 12.0, 3.6, 4
    # kolonlar (6 × 3)
    for x in (-12, -7.2, -2.4, 2.4, 7.2, 12):
        for y in (-6, 0, 6):
            K.kutu(x, y, 0, 0.45, 0.45, n * kh, mat='concrete_raw', part='column')
    # döşemeler (1…4. kat tavanları); 2. kat döşemesinde merdiven boşluğu (x 6…10, y −5…−1)
    for k in range(1, n + 1):
        holes = [{'u': 8.0, 'v': -3.0, 'w': 4.0, 'h': 4.0}] if k == 2 else ([{'u': 8.0, 'v': -3.0, 'w': 4.0, 'h': 4.0}] if k == 3 else None)
        K.kutu(0, 0, k * kh - 0.3, W + 0.6, D + 0.6, 0.3, mat='slab_raw', holes=holes, axis='z')
    # yarım duvarlar (tuğla dolgu) güney cephe 1. ve 2. kat, pencere boşluklu
    K.duvar(-12, -6.1, 12, -6.1, kh - 0.3, t=0.25, holes=[{'s': 7.2, 'v': 1.6, 'w': 3.2, 'h': 2.4}, {'s': 16.8, 'v': 1.7, 'w': 2.4, 'h': 1.6}], mat='block')
    K.duvar(-12, -6.1, 12, -6.1, kh - 0.3, t=0.25, z=kh, holes=[{'s': 12.0, 'v': 1.5, 'w': 3.0, 'h': 2.2}, {'s': 21.6, 'v': 1.5, 'w': 2.4, 'h': 1.8}], mat='block')
    K.duvar(12, 6.1, -12, 6.1, kh - 0.3, t=0.25, z=2 * kh, holes=[{'s': 2.4, 'v': 1.5, 'w': 2.4, 'h': 1.8}, {'s': 12.0, 'v': 1.5, 'w': 3.0, 'h': 2.2}], mat='block')
    # iskele (doğu cephe) ve vinç (dekor)
    for z in (kh, 2 * kh):
        K.kutu(14.2, 0, z - 0.1, 1.2, D, 0.1, mat='scaffold_deck')
    for y in (-6, 0, 6):
        K.silindir(14.8, y, 0, 0.06, 3 * kh, mat='scaffold')
    K.silindir(-26, 18, 0, 0.9, 34, mat='crane', decor=True)
    K.kutu(-16, 18, 34, 26, 1.2, 1.2, mat='crane', decor=True)
    # moloz / malzeme yığınları
    for x, y in ((-20, -14), (18, -16), (-4, 14)):
        K.kutu(x, y, 0, 3.0, 2.0, 1.2, mat='rebar', yaw=K.rng.uniform(0, 60))
    # kapılar
    K.kapi('start', -6.0, -18, 2.0, 0, w=3.6, h=3.0, label='S/F')
    K.gates[-1]['via_lap'] = [[-2.5, -24.5, 2.0]]
    K.kapi('window', -4.8, -6.1, 1.6, 0, w=3.0, h=2.2)                                                  # zemin kat penceresi → içeri
    K.kapi('gate', 4.8, 6.3, 1.7, 0, w=3.0, h=2.4, label='floor_exit', sector_end=True)                # kuzey açık cephe → dışarı
    K.kapi('circle', 0, 16, 5.4, 270, r=1.6)
    K.kapi('window', 0.0, 6.1, 2 * kh + 1.5, 180, w=2.8, h=2.0)                                          # 3. kat kuzey penceresi → içeri
    K.kapi('dive', 8.0, -3.0, 2 * kh - 0.15, 90, w=3.4, h=3.4, a=2.2, via=[[0.0, -1.5, 2 * kh + 1.6]], sector_end=True)   # merdiven boşluğundan dalış
    K.kapi('window', 0.0, -6.1, kh + 1.5, 180, w=2.8, h=2.0)                                             # 2. kat güney penceresi → dışarı
    K.kapi('circle', -18, -10, 2.4, 0, r=1.7, via=[[-18, -16, 2.6]])
    K.kapi('gate', -14.5, -3.0, 1.6, 90, w=2.4, h=2.4)                                                   # batı açık cephe → içeri
    K.kapi('window', 4.8, -6.1, 1.7, 180, w=2.2, h=1.4, via=[[4.8, -2.5, 1.7]])                           # güney küçük pencere → dışarı (zor)
    return K.sonuc(difficulty=4, laps=2, start={'x': -6.0, 'y': -26.0, 'yaw': 0.0, 'cols': 4, 'gap': 2.2},
                   env={'time': 'day', 'fog': 0.15, 'sky': 'clear', 'ground': 'dirt', 'light': 'sun', 'size': [80, 70]},
                   bot_vmax=6.0, par_lap_s=30.0)


_KURUCULAR = (('hangar', _hangar), ('forest', _orman), ('city', _sehir), ('stadium', _stadyum), ('refinery', _rafineri), ('canyon', _kanyon),
              ('woodframe', _ahsap_ev), ('concrete', _beton_bina))
PARKUR_IDLER = tuple(k for k, _ in _KURUCULAR)
PARKUR_ADLARI = {'hangar': 'Kapalı Hangar', 'forest': 'Çam Ormanı', 'city': 'Yarı Yıkık Şehir', 'stadium': 'Gece Stadyumu', 'refinery': 'Rafineri',
                 'canyon': 'Kanyon Geçidi', 'woodframe': 'Tepedeki Ahşap Ev İskeleti', 'concrete': 'Yarım Beton Bina'}
MEKAN_ADLARI = {'hangar': 'Kapalı depo / hangar', 'forest': 'Orman', 'city': 'Şehir / yarı yıkık yapılar', 'stadium': 'Stadyum',
                'refinery': 'Endüstriyel tesis', 'canyon': 'Kanyon / dağ geçidi', 'woodframe': 'Çayır tepesi', 'concrete': 'İnşaat alanı'}
_ONBELLEK = {}


def parkur(cid):
    """Tam parkur tanımı (önbellekli; değiştirilmemeli — kopya için `dict(...)`). Bilinmeyen → FpvHata."""
    if cid not in PARKUR_IDLER:
        raise FpvHata('Bilinmeyen FPV parkuru')
    if cid not in _ONBELLEK:
        c = dict(_KURUCULAR[PARKUR_IDLER.index(cid)][1]())
        c['name'] = PARKUR_ADLARI[cid]
        c['venue_name'] = MEKAN_ADLARI[cid]
        hat = yaris_hatti(c)
        c['line'] = [[list(p) for p in seg] for seg in hat]
        c['length_m'] = round(hat_uzunlugu(hat[1:]), 1)   # bir tur (başlangıç → S/F parçası hariç)
        c['gate_count'] = len(c['gates'])
        c['sectors'] = 1 + sum(1 for g in c['gates'][1:] if g.get('sector_end'))
        c['difficulty_name'] = ZORLUK_AD[c['difficulty']]
        c['kinds'] = sorted({g['kind'] for g in c['gates']})
        c['triangles_hint'] = len(c['obstacles']) + len(c['decor'])
        _ONBELLEK[cid] = c
    return _ONBELLEK[cid]


def parkur_ozet(cid):
    c = parkur(cid)
    return {k: c[k] for k in ('id', 'venue', 'name', 'venue_name', 'difficulty', 'difficulty_name', 'laps', 'length_m', 'gate_count', 'sectors', 'kinds',
                              'par_lap_s', 'env', 'start')}


def parkur_listesi():
    return [parkur_ozet(c) for c in PARKUR_IDLER]


def dunya(cid):
    """Parkurun çarpışma dünyası (önbellekli)."""
    key = ('dunya', cid)
    if key not in _ONBELLEK:
        _ONBELLEK[key] = EngelDunyasi(parkur(cid)['obstacles'])
    return _ONBELLEK[key]


# ---------------------------------------------------------------- yarış hattı
def kapi_giris_cikis(g):
    """(giriş, merkez, çıkış) noktaları (zeminden z)."""
    n, _, _ = kapi_eksenleri(g)
    a = float(g.get('a') or GIRIS_M)
    c = (g['x'], g['y'], g['z'])
    if g['kind'] == 'dive':
        return (c[0], c[1], c[2] + a), c, (c[0], c[1], max(1.2, c[2] - 1.6))
    return (c[0] - n[0] * a, c[1] - n[1] * a, c[2]), c, (c[0] + n[0] * a, c[1] + n[1] * a, c[2])


def yaris_hatti(c, kapali=True):
    """Kapı başına çoklu doğru: hat[0] başlangıç → S/F çıkışı; hat[k] (k ≥ 1) önceki kapının çıkışı → ara noktalar → giriş → merkez → çıkış.
    Kapalı döngüde son parça S/F'ye döner (hat[len] = son kapı çıkışı → S/F)."""
    gates = c['gates']
    st = c['start']
    out = []
    g0 = kapi_giris_cikis(gates[0])
    out.append([(st['x'], st['y'], max(1.2, gates[0]['z'])), *[tuple(p) for p in gates[0].get('via') or ()], g0[0], g0[1], g0[2]])
    sira = list(range(1, len(gates))) + ([0] if kapali else [])
    onceki = g0[2]
    for k in sira:
        g = gates[k]
        gi = kapi_giris_cikis(g)
        via = [tuple(p) for p in g.get('via_lap' if k == 0 else 'via') or ()]
        out.append([onceki, *via, gi[0], gi[1], gi[2]])
        onceki = gi[2]
    return out


def hat_uzunlugu(hat):
    return sum(_dist(a, b) for seg in hat for a, b in zip(seg[:-1], seg[1:]))


# ---------------------------------------------------------------- doğrulama
def parkur_dogrula(c, pay=HAT_PAY):
    """Sorun listesi ([] = geçerli): her kapının açıklığı engelsiz (içten 0,3 m pay), çerçeve başka kapının açıklığına girmiyor, yarış hattı
    engellere en az `pay` uzak (kapı → kapı sıralı, başlangıç → bitiş), başlangıç noktaları engelsiz, kapı sırası başlangıç/bitişle başlıyor."""
    sorun = []
    gates = c['gates']
    if not gates or gates[0]['kind'] != 'start':
        sorun.append('İlk kapı başlangıç/bitiş (start) olmalı')
    W = EngelDunyasi(c['obstacles'], inf=0.0)
    for i, g in enumerate(gates):
        if g['kind'] not in KAPI_TURLERI:
            sorun.append(f'kapı {i}: bilinmeyen tür')
        n, u, v = kapi_eksenleri(g)
        sekil, w, h = kapi_acikligi(g)
        for a in (-0.5, 0.0, 0.5):
            for b in (-0.5, 0.0, 0.5):
                au, bv = a * (w - 0.6), b * (h - 0.6)
                if sekil == 'circle' and math.hypot(au, bv) > w - 0.3:
                    continue
                for dn in (-0.4, 0.0, 0.4):
                    p = (g['x'] + u[0] * au + v[0] * bv + n[0] * dn, g['y'] + u[1] * au + v[1] * bv + n[1] * dn, g['z'] + u[2] * au + v[2] * bv + n[2] * dn)
                    k = W.nokta(p, 0.0)
                    if k is not None:
                        sorun.append(f"kapı {i} ({g['kind']}): açıklık engelli ({c['obstacles'][k].get('mat')}, {c['obstacles'][k]['t']})")
                        break
                else:
                    continue
                break
            else:
                continue
            break
        if g['z'] - (h / 2 if g['kind'] != 'dive' else 0) < -0.01:
            sorun.append(f'kapı {i}: zeminin altında')
    hat = yaris_hatti(c)
    Wp = EngelDunyasi(c['obstacles'], inf=pay)
    for k, seg in enumerate(hat):
        for a, b in zip(seg[:-1], seg[1:]):
            e, q = Wp.parca(a, b, pay, adim=0.25)
            if e is not None:
                ob = c['obstacles'][e]
                sorun.append(f"hat {k} ({'başlangıç' if k == 0 else 'kapı ' + str(k % len(gates))}): {tuple(round(x, 1) for x in q)} engele yakın ({ob.get('mat')} {ob['t']}"
                             + (f" kapı {ob['gate']} çerçevesi" if ob.get('gate') is not None else '') + ')')
                break
            if min(a[2], b[2]) < 0.8:
                sorun.append(f'hat {k}: zemine çok yakın (z < 0,8 m)')
                break
    sz = (c.get('env') or {}).get('size')
    if sz:   # engeller parkur alanının içinde (yanlış eksenli kutu alan dışına taşmasın)
        for k, e in enumerate(c['obstacles']):
            if e['t'] == 'box':   # tam köşe kutusu (engel_aabb dönük kutuda çevrel daireyi kullanır)
                r, f = sag(e.get('yaw', 0)), ileri(e.get('yaw', 0))
                xs = [e['x'] + r[0] * su * e['w'] / 2 + f[0] * sv * e['d'] / 2 for su in (-1, 1) for sv in (-1, 1)]
                ys = [e['y'] + r[1] * su * e['w'] / 2 + f[1] * sv * e['d'] / 2 for su in (-1, 1) for sv in (-1, 1)]
                a = (min(xs), min(ys), 0, max(xs), max(ys), 0)
            else:
                a = engel_aabb(e, 0.0)
            if max(abs(a[0]), abs(a[3])) > sz[0] / 2 * 1.25 + 5 or max(abs(a[1]), abs(a[4])) > sz[1] / 2 * 1.25 + 5:
                sorun.append(f"engel {k} ({e.get('mat')}) parkur alanının dışına taşıyor")
    for p in parkur_baslangiclari(c, 8):
        if W.nokta((p[0], p[1], 0.3), DRON_R) is not None:
            sorun.append(f'başlangıç noktası {p} engelli')
    return sorun


# ---------------------------------------------------------------- başlangıç noktaları
def parkur_baslangiclari(c, n):
    """n oyuncu: başlangıç pedi çevresinde `cols` sütunlu ızgara (`gap` m), satırlar geriye (−ileri) 2,5 m. Dönüş [(x, y, yaw)]."""
    st = c['start']
    yaw = float(st['yaw'])
    f, r = ileri(yaw), sag(yaw)
    cols, gap = int(st.get('cols') or 4), float(st.get('gap') or 2.2)
    out = []
    for k in range(max(1, int(n))):
        row, col = divmod(k, cols)
        m = min(cols, n - row * cols)
        o = (col - (m - 1) / 2.0) * gap
        out.append((round(st['x'] + r[0] * o - f[0] * 2.5 * row, 2), round(st['y'] + r[1] * o - f[1] * 2.5 * row, 2), round(yaw, 1)))
    return out


# ---------------------------------------------------------------- ayar
def fpv_ayar_varsayilan(cid='hangar'):
    c = parkur(cid)
    return {'course_id': cid, 'laps': c['laps'], 'crash_rule': 'penalty', 'crash_penalty_s': 2.0, 'miss_penalty_s': 3.0, 'time_limit_min': 10, 'seed': None}


def _sayi(v, ad, a, b, tam=False):
    if isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(float(v)):
        raise FpvHata(f'{ad} sayı olmalı')
    v = float(v)
    if tam and v != int(v):
        raise FpvHata(f'{ad} tam sayı olmalı')
    if not (a <= v <= b):
        raise FpvHata(f'{ad} {a:g}…{b:g} olmalı')
    return int(v) if tam else v


def fpv_ayar_dogrula(r, tip):
    """{course_id, laps?, crash_rule?, crash_penalty_s?, miss_penalty_s?, time_limit_min?, seed?} → normalize. Hata FpvHata."""
    if tip not in FPV_TIPLER:
        raise FpvHata('FPV parkurları yalnız çok rotorlu araçlarla (kopter / heksakopter / helikopter) uçulur')
    if not isinstance(r, dict):
        raise FpvHata('FPV parkur ayarı nesne olmalı')
    cid = r.get('course_id')
    if cid not in PARKUR_IDLER:
        raise FpvHata(f"course_id {' | '.join(PARKUR_IDLER)} olmalı")
    v = fpv_ayar_varsayilan(cid)
    if r.get('laps') is not None:
        v['laps'] = _sayi(r['laps'], 'Tur sayısı', *TUR, tam=True)
    if r.get('crash_rule') is not None:
        if r['crash_rule'] not in CARPMA_KURALLARI:
            raise FpvHata(f"Çarpma kuralı {' | '.join(CARPMA_KURALLARI)} olmalı")
        v['crash_rule'] = r['crash_rule']
    for k, ad in (('crash_penalty_s', 'Çarpma cezası'), ('miss_penalty_s', 'Kaçırılan kapı cezası')):
        if r.get(k) is not None:
            v[k] = _sayi(r[k], ad, *CEZA_S)
    if r.get('time_limit_min') is not None:
        v['time_limit_min'] = _sayi(r['time_limit_min'], 'Süre sınırı', *SURE_DK, tam=True)
    if r.get('seed') is not None:
        v['seed'] = _sayi(r['seed'], 'Tohum', 1, 2 ** 31 - 1, tam=True)
    v['type'] = 'fpv'
    return v


# ---------------------------------------------------------------- kontrol noktaları
def kontrol_noktalari(cfg, merkez):
    """Karşılaşma 'halkaları' (§33 biçimiyle uyumlu): [S/F] + (kapı 1…m−1 + S/F) × tur. Alanlar: i (1…), gate, lap (S/F ilk geçişi 0),
    sector, sector_end, kind, x, y, z, agl_m, alt_msl, lat, lon, yaw_deg, nx, ny, nz, w, h, shape, radius_m (sınır yarıçapı), line (yarış hattı
    parçası; bot)."""
    from .flightsim_match_core import latlon
    c = parkur(cfg['course_id'])
    gates, hat = c['gates'], yaris_hatti(c)
    zemin = float(merkez.get('alt') or 0.0)
    sira = [(0, 0)]
    for lap in range(1, int(cfg['laps']) + 1):
        sira += [(k, lap) for k in range(1, len(gates))] + [(0, lap)]
    out = []
    sektor = 1
    for i, (k, lap) in enumerate(sira):
        g = gates[k]
        n, _, _ = kapi_eksenleri(g)
        lat, lon = latlon(merkez['lat'], merkez['lon'], g['x'], g['y'])
        sekil, w, h = kapi_acikligi(g)
        line = hat[0] if i == 0 else hat[k if k else len(gates)]
        se = k == 0 or bool(g.get('sector_end'))
        out.append({'i': i + 1, 'gate': k, 'lap': lap, 'sector': sektor if lap else 0, 'sector_end': se and lap > 0, 'kind': g['kind'],
                    'x': g['x'], 'y': g['y'], 'z': g['z'], 'agl_m': g['z'], 'alt_msl': round(zemin + g['z'], 2), 'lat': round(lat, 7), 'lon': round(lon, 7),
                    'yaw_deg': g['yaw'], 'nx': round(n[0], 5), 'ny': round(n[1], 5), 'nz': round(n[2], 5), 'w': w if sekil == 'rect' else 2 * w,
                    'h': h if sekil == 'rect' else 2 * w, 'shape': sekil, 'radius_m': round(math.hypot(w, h) / (1 if sekil == 'circle' else 2), 2),
                    'line': [[round(q, 2) for q in p] for p in line]})
        if lap:
            sektor = 1 if k == 0 else (sektor + 1 if se else sektor)
    return out


def kontrol_kapisi(h):
    """Kontrol noktası → kapı geometrisi (kapi_kesisim için)."""
    g = {'kind': h['kind'], 'x': h['x'], 'y': h['y'], 'z': h['z'], 'yaw': h['yaw_deg'], 'w': h['w'], 'h': h['h']}
    if h.get('shape') == 'circle':
        g['r'] = h['w'] / 2
    return g


# ---------------------------------------------------------------- izleyici
class ParkurIzleyici:
    """Bir oyuncunun FPV parkur ilerlemesi (§33 HalkaIzleyici arayüzüyle: sira, gecisler, bitti, bitis_t, mesafe). `konum(x, y, z_msl, t, yaw,
    roll, pitch)` → olaylar: ring {i, t, lap, gate} · lap {lap, s, best} · sector {lap, sector, s, best} · miss {i} · hit {obstacle, rule} · reset ·
    wrong_way {i} · finish {t}. Zaman t0 (yarış başlangıcı) referanslı. Ceza `ceza` (sn)."""

    def __init__(self, noktalar, cfg, merkez, t0, dunya_=None):
        self.halkalar = list(noktalar)
        self.cfg = dict(cfg)
        self.zemin = float(merkez.get('alt') or 0.0)
        self.t0 = float(t0)
        self.dunya = dunya_ if dunya_ is not None else dunya(cfg['course_id'])
        self.sira = 0
        self.son = None
        self.gecisler = []            # [(i, t)]
        self.bitis_t = None
        self.mesafe = None
        self.ceza = 0.0
        self.kacan = []               # kaçırılan kontrol noktası i'leri
        self.carpma = 0
        self._temas = False
        self._temas_t = -1e9
        self.tur_t0 = None
        self.sektor_t0 = None
        self.turlar = []              # tur süreleri
        self.sektorler = []           # [[s1, s2, …] her tur]
        self.en_iyi_sektor = {}
        self.ara = []                 # kontrol noktası geçiş süreleri (t − t0; hayalet farkı)
        self.ornekler = []            # hayalet: [(t_rel, x, y, z, yaw_rad, roll, pitch)]
        self._ornek_t = -1e9

    @property
    def bitti(self):
        return self.sira >= len(self.halkalar)

    @property
    def tur(self):
        if self.bitti:
            return int(self.cfg['laps'])
        return max(1, self.halkalar[self.sira]['lap'])

    def en_iyi_tur(self):
        return min(self.turlar) if self.turlar else None

    def _ilerle(self, t, gecti, ev):
        h = self.halkalar[self.sira]
        rel = round(t - self.t0, 3)
        if gecti:
            self.gecisler.append((h['i'], t))
            ev.append({'kind': 'ring', 'i': h['i'], 't': t, 'lap': h['lap'], 'gate': h['gate']})
        else:
            self.kacan.append(h['i'])
            self.ceza += float(self.cfg.get('miss_penalty_s') or 0)
            ev.append({'kind': 'miss', 'i': h['i'], 'gate': h['gate'], 'lap': h['lap'], 'pen_s': float(self.cfg.get('miss_penalty_s') or 0)})
        self.ara.append(rel)
        if h['lap'] == 0:   # holeshot: ilk tur başlar
            self.tur_t0 = self.sektor_t0 = t
            self.sektorler.append([])
        else:
            if h['sector_end'] and self.sektor_t0 is not None:
                s = round(t - self.sektor_t0, 3)
                no = h['sector']
                onceki = self.en_iyi_sektor.get(no)
                self.en_iyi_sektor[no] = s if onceki is None else min(onceki, s)
                if self.sektorler:
                    self.sektorler[-1].append(s)
                ev.append({'kind': 'sector', 'lap': h['lap'], 'sector': no, 's': s, 'best': onceki is None or s < onceki})
                self.sektor_t0 = t
            if h['gate'] == 0 and self.tur_t0 is not None:
                s = round(t - self.tur_t0, 3)
                onceki = self.en_iyi_tur()
                self.turlar.append(s)
                ev.append({'kind': 'lap', 'lap': h['lap'], 's': s, 'best': onceki is None or s < onceki})
                self.tur_t0 = t
                if h['lap'] < int(self.cfg['laps']):
                    self.sektorler.append([])
        self.sira += 1
        if self.bitti:
            self.bitis_t = t
            ev.append({'kind': 'finish', 't': t, 'total_s': round(t - self.t0 + self.ceza, 3)})

    def konum(self, x, y, z_msl, t, yaw=None, roll=None, pitch=None):
        z = float(z_msl) - self.zemin
        p = (float(x), float(y), z)
        ev = []
        onceki, self.son = self.son, p
        if t - self._ornek_t >= HAYALET_ARALIK_S - 1e-6 and len(self.ornekler) < HAYALET_MAX and not self.bitti:
            self._ornek_t = t
            self.ornekler.append((round(t - self.t0, 2), p[0], p[1], p[2], float(yaw or 0), float(roll or 0), float(pitch or 0)))
        if onceki is not None and _dist(onceki, p) <= 250.0:
            # engel çarpışması (giriş anı; temas sürerken CARPMA_ARALIK_S'de bir)
            k, _ = self.dunya.parca(onceki, p) if _dist(onceki, p) > 1e-3 else (self.dunya.nokta(p), None)
            if k is not None:
                if not self._temas and t - self._temas_t >= CARPMA_ARALIK_S:
                    self.carpma += 1
                    self._temas_t = t
                    kural = self.cfg.get('crash_rule') or 'penalty'
                    e = {'kind': 'hit', 'obstacle': k, 'mat': self.dunya.engeller[k].get('mat'), 'rule': kural, 't': t}
                    if kural == 'penalty':
                        self.ceza += float(self.cfg.get('crash_penalty_s') or 0)
                        e['pen_s'] = float(self.cfg.get('crash_penalty_s') or 0)
                    ev.append(e)
                    if kural == 'reset':
                        ev.append({'kind': 'reset', 't': t})
                self._temas = True
            else:
                self._temas = False
            # kapılar: sıradaki + en çok ILERI_BAKIS ileri (kaçırma)
            if not self.bitti:
                for j in range(0, ILERI_BAKIS + 1):
                    if self.sira + j >= len(self.halkalar):
                        break
                    h = self.halkalar[self.sira + j]
                    yon_, ic, _ = kapi_kesisim(onceki, p, kontrol_kapisi(h))
                    if yon_ == 'ileri' and ic:
                        for _ in range(j):
                            self._ilerle(t, False, ev)
                        self._ilerle(t, True, ev)
                        break
                    if j == 0 and yon_ == 'ters' and ic:
                        ev.append({'kind': 'wrong_way', 'i': h['i']})
        if not self.bitti:
            h = self.halkalar[self.sira]
            self.mesafe = _dist(p, (h['x'], h['y'], h['z']))
        else:
            self.mesafe = 0.0
        return ev

    def toplam(self):
        """Bitiş süresi (ceza dahil) ya da None."""
        return round(self.bitis_t - self.t0 + self.ceza, 3) if self.bitis_t is not None else None

    def ozet(self):
        return {'laps_done': len(self.turlar), 'laps': int(self.cfg['laps']), 'lap_times': list(self.turlar), 'best_lap_s': self.en_iyi_tur(),
                'sectors': [list(s) for s in self.sektorler], 'best_sectors': {str(k): v for k, v in sorted(self.en_iyi_sektor.items())},
                'misses': len(self.kacan), 'hits': self.carpma, 'pen_s': round(self.ceza, 2), 'splits': list(self.ara), 'total_s': self.toplam()}


# ---------------------------------------------------------------- hayalet kodlama
_B64 = base64.urlsafe_b64encode


def _varint(n, out):
    n = (n << 1) ^ (n >> 63)   # zigzag
    while True:
        b = n & 0x7F
        n >>= 7
        if n:
            out.append(b | 0x80)
        else:
            out.append(b)
            return


def hayalet_kodla(ornekler):
    """[(t_s, x, y, z, yaw_rad, roll_rad, pitch_rad)] → 'g1.' + base64url(zigzag varint farkları). Nicemleme: t 10 ms, konum 2 cm, açı 2 mrad.
    yaw farkı en kısa yay (mod 3142); çözücü yaw'ı tam sayı uzayında mod 3142 ile [−π, π)'ye indirir. 10 Hz × 60 sn ≈ 4–6 kB."""
    out = bytearray()
    _varint(len(ornekler), out)
    onceki = [0] * 7
    olc = (100.0, 50.0, 50.0, 50.0, 500.0, 500.0, 500.0)
    for o in ornekler:
        q = [int(round(float(v) * s)) for v, s in zip(o, olc)]
        for k in range(7):
            d = q[k] - onceki[k]
            if k == 4:   # yaw sarması: en kısa fark
                tam = int(round(2 * math.pi * olc[4]))
                d = (d + tam // 2) % tam - tam // 2
            _varint(d, out)
            onceki[k] += d
    return 'g1.' + _B64(bytes(out)).decode('ascii').rstrip('=')


def hayalet_coz(s):
    if not isinstance(s, str) or not s.startswith('g1.'):
        raise FpvHata('Hayalet verisi tanınmadı')
    b = base64.urlsafe_b64decode(s[3:] + '=' * (-len(s[3:]) % 4))
    pos = 0

    def oku():
        nonlocal pos
        n, sh = 0, 0
        while True:
            c = b[pos]
            pos += 1
            n |= (c & 0x7F) << sh
            sh += 7
            if not c & 0x80:
                break
        return (n >> 1) ^ -(n & 1)
    cnt = oku()
    olc = (100.0, 50.0, 50.0, 50.0, 500.0, 500.0, 500.0)
    cur = [0] * 7
    out = []
    for _ in range(cnt):
        for k in range(7):
            cur[k] += oku()
        tam = int(round(2 * math.pi * olc[4]))   # yaw: tam sayı uzayında mod (sarma farkları birikmez) → [−π, π)
        yaw_q = (cur[4] + tam // 2) % tam - tam // 2
        out.append(tuple((yaw_q if k == 4 else cur[k]) / olc[k] for k in range(7)))
    return out


# ---------------------------------------------------------------- puan (SIMUMAV TOP 10 "FPV parkur" bileşeni; gösterim)
FPV_PUAN_K = 250          # parkur başına: 250 × (par / tur ortalaması), en çok 375 (1,5 × par hızı)


def fpv_puani(cid, en_iyi_s, laps):
    """Parkur puanı: par tur süresine göre (tur başına ortalama). Bitirilmemiş → 0."""
    if en_iyi_s is None or not laps:
        return 0
    c = parkur(cid)
    ort = float(en_iyi_s) / int(laps)
    return int(max(0, min(1.5 * FPV_PUAN_K, round(FPV_PUAN_K * float(c['par_lap_s']) / max(1.0, ort)))))


# ---------------------------------------------------------------- dünya ayarı (oturum gövdesi `world`)
def dunya_ayari(cid, base=None):
    """Parkur karşılaşmasında oturum dünyası: prosedürel, DÜZ merkez (pist / bina / ağaç / su yok — sahneyi parkur kurar), ortam (saat, sis)
    parkurdan; kapalı mekanda rüzgâr yok. `base` (sihirbazın world'ü) yalnız fırlatma (launch) gibi diğer alanları taşır."""
    c = parkur(cid)
    env = c.get('env') or {}
    w = dict(base or {})
    kapali = env.get('sky') == 'indoor'
    w.update({'mode': 'procedural', 'seed': 4000 + PARKUR_IDLER.index(cid), 'size_m': 4000, 'tree_density': 0.0, 'building_count': 0, 'runway': False,
              'water': 0.0, 'mountain_count': 0 if kapali else (8 if env.get('canyon') or env.get('hill') else 3),
              'mountain_height': 600 if env.get('canyon') else 300, 'time': env.get('time') or 'day', 'fog': float(env.get('fog') or 0.1),
              'wind_ms': 0.0 if kapali else 1.5, 'wind_gust': 0.0, 'wind_turb': 0.0, 'weather': 'clear', 'runway_heading': float(c['start']['yaw'])})
    w['fpv_course'] = cid
    return w
