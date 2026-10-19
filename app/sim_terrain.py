"""Uçuş Simülatörü — gerçek topoğrafya vekili (`drone.sim`, docs/ucus-simulatoru.md §8).

Tarayıcı dış kaynaklara doğrudan gitmez; üç önbellekli uç sunulur (router: app/routers/flightsim.py):
- `GET /api/drone/sim/terrain?lat&lon&size_m` → karo planı: yükseklik (AWS Terrain Tiles, terrarium PNG, z 12–13) ve uydu doku
  (Esri World Imagery, z+3) karolarının x/y listesi, URL şablonları (bizim vekilimize), merkez yüksekliği `home_elev` (m).
- `GET /api/drone/sim/tile/{kind}/{z}/{x}/{y}` → disk önbelleği `DATA_DIR/sim_terrain/{kind}/…` (LRU, 2 GB), 10 sn zaman aşımı.
- `GET /api/drone/sim/osm?lat&lon&size_m` → Overpass (binalar / orman / su / pist) sadeleştirilmiş JSON; 7 gün önbellek.

Güvenlik: URL'ler sabit şablon (SSRF yok); z/x/y sayı ve sınır denetimli; kaynak hataları 502 (HTTP) / 503 (ulaşılamadı, zaman aşımı).
Testler `FETCH` işlevini sahte ile değiştirir (ağsız).

ArduPilot arazi protokolü (§18, `terrain_bloklari`): SITL'in `TERRAIN_REQUEST`'ine (blok SW köşesi lat/lon 1e7, grid_spacing, 56 bitlik maske)
sunucu GCS gibi `TERRAIN_DATA` (gridbit 0..55, 4×4 int16 m) üretir; yükseklik aynı terrarium karolarından (z 13, bilineer; ev irtifasıyla aynı kaynak).
"""
import hashlib
import json
import math
import os
import re
import threading
import time
import zlib

import httpx

from . import config

ELEV_URL = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png'
IMG_URL = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'
OVERPASS_URL = 'https://overpass-api.de/api/interpreter'
OVERPASS_URLS = (OVERPASS_URL, 'https://overpass.kumi.systems/api/interpreter')   # sabit liste; ilki başarısızsa yedek
ATTRIBUTION = {'img': 'Esri, Maxar, Earthstar Geographics', 'elev': 'Mapzen / AWS Terrain Tiles', 'osm': '© OpenStreetMap katkıcıları'}
CACHE_DIR = config.DATA_DIR / 'sim_terrain'
CACHE_LIMIT = int(os.environ.get('SIM_TERRAIN_CACHE_MB', '2048')) * 1024 * 1024
OSM_TTL = 7 * 86400
TIMEOUT = 10.0
OSM_TIMEOUT = 60.0           # Overpass: yoğun şehir merkezi (Ankara 4 km) ham yanıt ~6 MB, 20–40 sn sürebilir
HEADERS = {'User-Agent': 'HEPGO-FlightSim/1.0 (+https://hepgo.com; drone flight simulator)', 'Accept': 'application/json, image/*;q=0.9, */*;q=0.5'}   # Overpass UA'sız 406 döner
IMG_Z_EK = 3                 # uydu dokusu yükseklik karolarından 3 seviye ince (≈ 2–4 m/px)
KINDS = {'elev': ('image/png', ELEV_URL), 'img': ('image/jpeg', IMG_URL)}
SIZE_MIN, SIZE_MAX = 1000, 12000
# Uzak arazi halkası (§9): ana dünyanın dışında ufka dek kaba arazi — yükseklik z 10 (≈ 100–150 m/px), uydu z 12 (≈ 30 m/px); kenar 24–64 km
UZAK_SIZE_MIN, UZAK_SIZE_MAX, UZAK_SIZE_VARSAYILAN = 24000, 64000, 48000
UZAK_Z, UZAK_IMG_Z = 10, 12
_kilit = threading.Lock()
_toplam = None               # önbellek bayt sayacı (ilk kullanımda taranır)


class KaynakHata(Exception):
    """kod: 502 (kaynak HTTP hatası) · 503 (kaynağa ulaşılamadı / zaman aşımı)"""
    def __init__(self, kod, mesaj):
        super().__init__(mesaj)
        self.kod = kod


def _fetch(url, timeout=TIMEOUT, data=None):
    """Sabit URL'den bayt çeker; httpx. Testlerde `FETCH` değiştirilir."""
    try:
        r = (httpx.post(url, data=data, headers=HEADERS, timeout=timeout, follow_redirects=False) if data is not None
             else httpx.get(url, headers=HEADERS, timeout=timeout, follow_redirects=False))
    except httpx.TimeoutException as e:
        raise KaynakHata(503, 'Kaynak zaman aşımı') from e
    except httpx.HTTPError as e:
        raise KaynakHata(503, f'Kaynağa ulaşılamadı: {e.__class__.__name__}') from e
    if r.status_code != 200:
        raise KaynakHata(502, f'Kaynak {r.status_code} döndü')
    return r.content


FETCH = _fetch


# ---------------------------------------------------------------- Web Mercator
def lonlat_karo(lon, lat, z):
    """(lon, lat) → kesirli karo koordinatı (x, y) z seviyesinde."""
    n = 2 ** z
    x = (lon + 180.0) / 360.0 * n
    lat_r = math.radians(max(-85.05112878, min(85.05112878, lat)))
    y = (1.0 - math.log(math.tan(lat_r) + 1.0 / math.cos(lat_r)) / math.pi) / 2.0 * n
    return x, y


def karo_lonlat(x, y, z):
    """Karo köşesi (x, y) → (lon, lat)."""
    n = 2 ** z
    lon = x / n * 360.0 - 180.0
    lat = math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * y / n))))
    return lon, lat


def bbox(lat, lon, size_m):
    """Merkez ve kenar uzunluğundan (lat_min, lon_min, lat_max, lon_max)."""
    half = size_m / 2.0
    dlat = half / 110574.0
    dlon = half / (111320.0 * max(0.05, math.cos(math.radians(lat))))
    return lat - dlat, lon - dlon, lat + dlat, lon + dlon


def _z_sec(size_m):
    return 13 if size_m <= 6000 else 12


def _karolar(lat, lon, size_m, z):
    s, w, n, e = bbox(lat, lon, size_m)
    x0, y1 = lonlat_karo(w, s, z)
    x1, y0 = lonlat_karo(e, n, z)
    xs = range(int(math.floor(x0)), int(math.floor(x1)) + 1)
    ys = range(int(math.floor(y0)), int(math.floor(y1)) + 1)
    lim = 2 ** z
    return [{'x': x % lim, 'y': y} for y in ys for x in xs if 0 <= y < lim]


def parametre_dogrula(lat, lon, size_m, uzak=False):
    try:
        lat, lon = float(lat), float(lon)
        size_m = int(float(size_m if size_m is not None else (UZAK_SIZE_VARSAYILAN if uzak else 4000)))
    except (TypeError, ValueError):
        raise ValueError('lat, lon, size_m sayı olmalı')
    if not (-85 <= lat <= 85 and -180 <= lon <= 180):
        raise ValueError('lat −85…85, lon −180…180 olmalı')
    size_m = max(UZAK_SIZE_MIN, min(UZAK_SIZE_MAX, size_m)) if uzak else max(SIZE_MIN, min(SIZE_MAX, size_m))
    return lat, lon, size_m


# ---------------------------------------------------------------- disk önbelleği (LRU, boyut sınırı)
def _tara():
    global _toplam
    top = 0
    if CACHE_DIR.is_dir():
        for p in CACHE_DIR.rglob('*'):
            if p.is_file():
                try:
                    top += p.stat().st_size
                except OSError:
                    pass
    _toplam = top
    return top


def _temizle():
    """Sınır aşılınca en eski erişilenler (mtime) silinir; %85'e inilir."""
    global _toplam
    dosyalar = []
    for p in CACHE_DIR.rglob('*'):
        if p.is_file():
            try:
                st = p.stat()
                dosyalar.append((st.st_mtime, st.st_size, p))
            except OSError:
                pass
    dosyalar.sort()
    top = sum(d[1] for d in dosyalar)
    hedef = CACHE_LIMIT * 0.85
    for _, boyut, p in dosyalar:
        if top <= hedef:
            break
        try:
            p.unlink()
            top -= boyut
        except OSError:
            pass
    _toplam = top


def _onbellek_oku(yol, ttl=None):
    try:
        st = yol.stat()
    except OSError:
        return None
    if ttl is not None and time.time() - st.st_mtime > ttl:
        return None
    try:
        data = yol.read_bytes()
    except OSError:
        return None
    if ttl is None:
        try:
            os.utime(yol, None)   # LRU: erişim damgası
        except OSError:
            pass
    return data


def _onbellek_yaz(yol, data):
    global _toplam
    yol.parent.mkdir(parents=True, exist_ok=True)
    gecici = yol.with_suffix(yol.suffix + '.tmp')
    gecici.write_bytes(data)
    os.replace(gecici, yol)
    with _kilit:
        if _toplam is None:
            _tara()
        else:
            _toplam += len(data)
        if _toplam > CACHE_LIMIT:
            _temizle()


def onbellek_ozeti():
    with _kilit:
        top = _toplam if _toplam is not None else _tara()
    return {'bytes': top, 'limit': CACHE_LIMIT, 'dir': str(CACHE_DIR)}


# ---------------------------------------------------------------- karolar
def karo_yolu(kind, z, x, y):
    ext = 'png' if kind == 'elev' else 'jpg'
    return CACHE_DIR / kind / str(z) / str(x) / f'{y}.{ext}'


def karo(kind, z, x, y):
    """Karo baytları (önbellek → kaynak). Geçersiz parametre → ValueError; kaynak hatası → KaynakHata."""
    if kind not in KINDS:
        raise ValueError('kind elev | img olmalı')
    z, x, y = int(z), int(x), int(y)
    if not (0 <= z <= 19) or not (0 <= x < 2 ** z) or not (0 <= y < 2 ** z):
        raise ValueError('z/x/y sınır dışı')
    yol = karo_yolu(kind, z, x, y)
    data = _onbellek_oku(yol)
    if data is None:
        data = FETCH(KINDS[kind][1].format(z=z, x=x, y=y), TIMEOUT)
        if not data:
            raise KaynakHata(502, 'Boş karo')
        _onbellek_yaz(yol, data)
    return data, KINDS[kind][0]


# ---------------------------------------------------------------- terrarium PNG çözme (saf Python; Pillow gerekmez)
def png_coz(data):
    """8 bit RGB/RGBA (filtreli, zlib) PNG → (genişlik, yükseklik, kanal, bytearray ham piksel). Sadece non-interlaced."""
    if data[:8] != b'\x89PNG\r\n\x1a\n':
        raise ValueError('PNG değil')
    pos, idat, w, hgt, kanal = 8, [], 0, 0, 0
    while pos + 8 <= len(data):
        ln = int.from_bytes(data[pos:pos + 4], 'big')
        tip = data[pos + 4:pos + 8]
        govde = data[pos + 8:pos + 8 + ln]
        pos += 12 + ln
        if tip == b'IHDR':
            w, hgt = int.from_bytes(govde[0:4], 'big'), int.from_bytes(govde[4:8], 'big')
            derinlik, renk, interlace = govde[8], govde[9], govde[12]
            if derinlik != 8 or renk not in (2, 6) or interlace:
                raise ValueError('desteklenmeyen PNG biçimi')
            kanal = 3 if renk == 2 else 4
        elif tip == b'IDAT':
            idat.append(govde)
        elif tip == b'IEND':
            break
    ham = zlib.decompress(b''.join(idat))
    satir = w * kanal
    out = bytearray(hgt * satir)
    onceki = bytearray(satir)
    p = 0
    for y in range(hgt):
        f = ham[p]
        cur = bytearray(ham[p + 1:p + 1 + satir])
        p += 1 + satir
        if f == 1:
            for i in range(kanal, satir):
                cur[i] = (cur[i] + cur[i - kanal]) & 255
        elif f == 2:
            for i in range(satir):
                cur[i] = (cur[i] + onceki[i]) & 255
        elif f == 3:
            for i in range(satir):
                sol = cur[i - kanal] if i >= kanal else 0
                cur[i] = (cur[i] + ((sol + onceki[i]) >> 1)) & 255
        elif f == 4:
            for i in range(satir):
                a = cur[i - kanal] if i >= kanal else 0
                b = onceki[i]
                c = onceki[i - kanal] if i >= kanal else 0
                pa, pb, pc = abs(b - c), abs(a - c), abs(a + b - 2 * c)
                pr = a if (pa <= pb and pa <= pc) else (b if pb <= pc else c)
                cur[i] = (cur[i] + pr) & 255
        elif f != 0:
            raise ValueError('bilinmeyen PNG filtresi')
        out[y * satir:(y + 1) * satir] = cur
        onceki = cur
    return w, hgt, kanal, out


def terrarium_yukseklik(png, px, py):
    """Terrarium karosunda (px, py) pikselinin yüksekliği (m): R·256 + G + B/256 − 32768."""
    w, hgt, kanal, pix = png_coz(png)
    px, py = max(0, min(w - 1, int(px))), max(0, min(hgt - 1, int(py)))
    i = (py * w + px) * kanal
    return pix[i] * 256 + pix[i + 1] + pix[i + 2] / 256.0 - 32768.0


def ev_irtifa(lat, lon, z=13):
    """Merkezin deniz seviyesinden yüksekliği (m), terrarium karosundan. Kaynak yoksa KaynakHata."""
    fx, fy = lonlat_karo(lon, lat, z)
    tx, ty = int(math.floor(fx)), int(math.floor(fy))
    data, _ = karo('elev', z, tx, ty)
    return round(terrarium_yukseklik(data, (fx - tx) * 256, (fy - ty) * 256), 1)


# ---------------------------------------------------------------- ArduPilot arazi protokolü (TERRAIN_REQUEST → TERRAIN_DATA; §18)
# ArduPilot AP_Terrain: blok 28×32 ızgara noktası = 7 (kuzey, x) × 8 (doğu, y) adet 4×4 MAVLink parçası; TERRAIN_REQUEST.mask biti
# `gridbit = (x/4)·8 + (y/4)`; TERRAIN_DATA.data[i] → ızgara [idx_x + i//4][idx_y + i%4]; nokta konumu = SW köşe + (x·spacing kuzey, y·spacing doğu)
# (Location::offset). Yükseklik int16 m, MSL (SRTM/EGM96; terrarium da EGM96 MSL).
ARAZI_Z = 13                      # yükseklik karosu seviyesi (≈ 14 m/px, 40° enlemde); ev irtifasıyla (ev_irtifa) aynı kaynak
BLOK_MUL_X, BLOK_MUL_Y, PARCA = 7, 8, 4
BLOK_BIT = BLOK_MUL_X * BLOK_MUL_Y   # 56
M_PER_DEG = 1e7 * 0.011131884502145034   # ArduPilot LOCATION_SCALING_FACTOR: metre / derece (≈ 111 318,8)
COZ_LIMIT = 48                    # bellekte çözülmüş karo (256×256×3 B ≈ 196 KB) sayısı — LRU
_coz = {}                         # (z, x, y) → (son erişim, (w, h, kanal, pix))
_coz_kilit = threading.Lock()


def _cozulmus_karo(z, x, y):
    """Çözülmüş terrarium karosu (bellek LRU → disk önbelleği/kaynak). Kaynak yoksa KaynakHata."""
    k = (int(z), int(x), int(y))
    with _coz_kilit:
        v = _coz.get(k)
        if v is not None:
            v[0] = time.time()
            return v[1]
    data, _ = karo('elev', *k)
    png = png_coz(data)
    with _coz_kilit:
        _coz[k] = [time.time(), png]
        while len(_coz) > COZ_LIMIT:
            del _coz[min(_coz, key=lambda kk: _coz[kk][0])]
    return png


def _piksel(z, gx, gy):
    """Küresel piksel koordinatı (karo·256 + piksel) → yükseklik (m); karo sınırını aşan komşu piksel komşu karodan okunur."""
    lim = 256 * 2 ** z
    gx %= lim
    gy = max(0, min(lim - 1, gy))
    w, _h, kanal, pix = _cozulmus_karo(z, gx // 256, gy // 256)
    i = ((gy % 256) * w + (gx % 256)) * kanal
    return pix[i] * 256 + pix[i + 1] + pix[i + 2] / 256.0 - 32768.0


def yukseklik(lat, lon, z=ARAZI_Z):
    """(lat, lon) yüksekliği (m MSL), terrarium karosundan bilineer (piksel merkezleri; ön yüz `sampleRaw` ile aynı yöntem). Kaynak yoksa KaynakHata."""
    fx, fy = lonlat_karo(lon, lat, z)
    px, py = fx * 256 - 0.5, fy * 256 - 0.5
    x0, y0 = int(math.floor(px)), int(math.floor(py))
    ax, ay = px - x0, py - y0
    h00, h10 = _piksel(z, x0, y0), _piksel(z, x0 + 1, y0)
    h01, h11 = _piksel(z, x0, y0 + 1), _piksel(z, x0 + 1, y0 + 1)
    return (h00 * (1 - ax) + h10 * ax) * (1 - ay) + (h01 * (1 - ax) + h11 * ax) * ay


def konum_ofset(lat, lon, kuzey_m, dogu_m):
    """ArduPilot Location::offset: (lat, lon) derece + kuzey/doğu metre → (lat, lon) derece (boylam ölçeği orta enlemde)."""
    dlat = kuzey_m / M_PER_DEG
    return lat + dlat, lon + dogu_m / (M_PER_DEG * max(0.01, math.cos(math.radians(lat + dlat / 2))))


def terrain_bloklari(lat_e7, lon_e7, spacing, mask, yukseklik_fn=None):
    """TERRAIN_REQUEST → [(gridbit, [16 int16 m])] (yalnız maskede istenen parçalar; yüksekliği alınamayan parça atlanır → SITL yeniden ister).
    `yukseklik_fn(lat, lon)` → m (varsayılan `yukseklik`); hata (KaynakHata/ValueError/zlib.error) o parçayı düşürür. Dönüş ikinci öğe: atlanan parça sayısı."""
    fn = yukseklik_fn or yukseklik
    lat0, lon0, spacing, mask = lat_e7 / 1e7, lon_e7 / 1e7, int(spacing), int(mask)
    if spacing <= 0:
        return [], 0
    out, atlanan = [], 0
    for bit in range(BLOK_BIT):
        if not (mask >> bit) & 1:
            continue
        bx, by = (bit // BLOK_MUL_Y) * PARCA, (bit % BLOK_MUL_Y) * PARCA   # kuzey (x) / doğu (y) ızgara indisleri
        data = []
        try:
            for i in range(PARCA * PARCA):
                la, lo = konum_ofset(lat0, lon0, (bx + i // PARCA) * spacing, (by + i % PARCA) * spacing)
                data.append(max(-32768, min(32767, int(round(fn(la, lo))))))
        except (KaynakHata, ValueError, zlib.error, OSError):
            atlanan += 1
            continue
        out.append((bit, data))
    return out, atlanan


def terrain_plani(lat, lon, size_m, uzak=False):
    """GET /terrain yanıtı. Yükseklik karoları z (12–13), uydu karoları z+IMG_Z_EK; `home_elev` merkez yüksekliği (alınamazsa null).
    `uzak=True` (`?far=1`): ufuk için kaba "uzak arazi" planı — kenar 24–64 km (varsayılan 48), yükseklik z 10, uydu z 12; `home_elev`
    yine z 13 merkez karosundan (ana dünya ile aynı referans; ön yüz uzak ızgarayı ana arazinin h0'ına göre hizalar)."""
    lat, lon, size_m = parametre_dogrula(lat, lon, size_m, uzak)
    z = UZAK_Z if uzak else _z_sec(size_m)
    img_z = UZAK_IMG_Z if uzak else z + IMG_Z_EK
    s, w, n, e = bbox(lat, lon, size_m)
    try:
        home = ev_irtifa(lat, lon, 13 if uzak else z)
    except (KaynakHata, ValueError, zlib.error):
        home = None
    return {'z': z, 'tiles': _karolar(lat, lon, size_m, z), 'img_z': img_z, 'img_tiles': _karolar(lat, lon, size_m, img_z),
            'elev_url_template': '/api/drone/sim/tile/elev/{z}/{x}/{y}', 'img_url_template': '/api/drone/sim/tile/img/{z}/{x}/{y}',
            'home_elev': home, 'bbox': {'south': s, 'west': w, 'north': n, 'east': e}, 'size_m': size_m, 'far': bool(uzak), 'attribution': ATTRIBUTION}


# ---------------------------------------------------------------- Overpass (OSM) sadeleştirme
def _osm_sorgu(s, w, n, e):
    bb = f'{s:.6f},{w:.6f},{n:.6f},{e:.6f}'
    return (f'[out:json][timeout:{int(OSM_TIMEOUT)}];('
            f'way["building"]({bb});relation["building"]({bb});'
            f'way["landuse"="forest"]({bb});way["natural"="wood"]({bb});'
            f'way["natural"="water"]({bb});relation["natural"="water"]({bb});'
            f'way["aeroway"="runway"]({bb});'
            ');out geom;')


def _sayi(v):
    """'12', '12 m', '12.5m', '40 ft' → metre; olmazsa None."""
    if v is None:
        return None
    m = re.match(r'^\s*([0-9]+(?:[.,][0-9]+)?)\s*(m|ft|\'|")?\s*$', str(v))
    if not m:
        return None
    x = float(m.group(1).replace(',', '.'))
    if m.group(2) in ('ft', "'"):
        x *= 0.3048
    return x


def bina_yuksekligi(tags, osm_id=0):
    """`height` → `building:levels`×3 → deterministik 6–12 m (kimlik karmasından)."""
    h = _sayi(tags.get('height'))
    if h is not None and 2 <= h <= 600:
        return round(h, 1)
    lv = _sayi(tags.get('building:levels'))
    if lv is not None and 0 < lv <= 200:
        return round(lv * 3.0 + (1.0 if _sayi(tags.get('roof:levels')) else 0.0), 1)
    return 6 + (int(osm_id) * 2654435761 % 7)   # 6…12


def _geom(el, en_az=3):
    """Way → [[lat, lon]…]; relation → dış halkaların (outer) listesi [[[lat, lon]…]…]. `en_az` nokta sayısı (pist çizgisi 2)."""
    def halka(pts):
        g = [[round(p['lat'], 6), round(p['lon'], 6)] for p in pts or []]
        if len(g) >= 4 and g[0] == g[-1]:
            g.pop()   # kapalı halka: tekrarlı son nokta atılır (ön yüz çokgen olarak kapatır)
        return g if len(g) >= en_az else None
    if el.get('type') == 'way':
        g = halka(el.get('geometry'))
        return [g] if g else []
    halkalar = []
    for m in el.get('members') or []:
        if m.get('type') == 'way' and m.get('role', 'outer') in ('outer', ''):
            g = halka(m.get('geometry'))
            if g:
                halkalar.append(g)
    return halkalar


def _heading(poly):
    """Pist yönü (0–180°, kuzeyden saat yönü) ilk-son noktadan."""
    (lat0, lon0), (lat1, lon1) = poly[0], poly[-1]
    if len(poly) >= 4 and poly[0] == poly[-1]:   # kapalı alan: en uzun köşegen
        en = max(((math.hypot((b[0] - a[0]) * 110574, (b[1] - a[1]) * 111320 * math.cos(math.radians(a[0]))), a, b)
                  for i, a in enumerate(poly) for b in poly[i + 1:]), default=None)
        if en:
            (lat0, lon0), (lat1, lon1) = en[1], en[2]
    dn = (lat1 - lat0) * 110574.0
    de = (lon1 - lon0) * 111320.0 * math.cos(math.radians(lat0))
    return round(math.degrees(math.atan2(de, dn)) % 180.0, 1)


def osm_sadelestir(ham):
    """Overpass JSON → {buildings:[{poly, h}], forests:[poly], water:[poly], runways:[{poly, heading, width}]}."""
    out = {'buildings': [], 'forests': [], 'water': [], 'runways': []}
    for el in (ham or {}).get('elements') or []:
        tags = el.get('tags') or {}
        polys = _geom(el, 2 if tags.get('aeroway') == 'runway' else 3)
        if not polys:
            continue
        if 'building' in tags and tags.get('building') != 'no':
            h = bina_yuksekligi(tags, el.get('id', 0))
            for p in polys:
                out['buildings'].append({'poly': p, 'h': h})
        elif tags.get('landuse') == 'forest' or tags.get('natural') == 'wood':
            out['forests'].extend(polys)
        elif tags.get('natural') == 'water':
            out['water'].extend(polys)
        elif tags.get('aeroway') == 'runway':
            w = _sayi(tags.get('width'))
            for p in polys:
                out['runways'].append({'poly': p, 'heading': _heading(p), 'width': round(w, 1) if w else 45.0})
    return out


def osm_yolu(lat, lon, size_m):
    anahtar = hashlib.sha1(f'{lat:.4f},{lon:.4f},{size_m}'.encode()).hexdigest()[:20]
    return CACHE_DIR / 'osm' / f'{anahtar}.json'


def osm(lat, lon, size_m):
    """GET /osm: 7 gün önbellekli sadeleştirilmiş OSM. Kaynak hatası → KaynakHata (502/503)."""
    lat, lon, size_m = parametre_dogrula(lat, lon, size_m)
    yol = osm_yolu(lat, lon, size_m)
    data = _onbellek_oku(yol, OSM_TTL)
    if data is not None:
        try:
            return json.loads(data)
        except ValueError:
            pass
    s, w, n, e = bbox(lat, lon, size_m)
    sorgu = {'data': _osm_sorgu(s, w, n, e)}
    ham, son = None, None
    for url in OVERPASS_URLS:   # ilk kaynak hata/zaman aşımı → yedek
        try:
            ham = FETCH(url, OSM_TIMEOUT, data=sorgu)
            break
        except KaynakHata as ex:
            son = ex
    if ham is None:
        raise son
    try:
        sade = osm_sadelestir(json.loads(ham))
    except ValueError as ex:
        raise KaynakHata(502, 'Overpass yanıtı çözülemedi') from ex
    sade['cached_at'] = int(time.time())
    sade['bbox'] = {'south': s, 'west': w, 'north': n, 'east': e}
    _onbellek_yaz(yol, json.dumps(sade, ensure_ascii=False, separators=(',', ':')).encode())
    return sade
