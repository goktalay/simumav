"""Uçuş Simülatörü — HEDEFLER (docs/ucus-simulatoru.md §24): SITL'siz, kinematik olarak dairesel yörüngede sürekli uçan hedefler.

Kullanıcı isteği: "Uçuşa geçeceğimizde Hedefler diye bir bölüm ekle; sistemdeki dron türleri gelsin ve seçelim, hedefin uçacağı irtifa gelsin, dairesel bir
yörüngede uçsun ve bizden yörüngenin çapını sorsun. Simülasyona girdiğimizde havada sürekli uçan seçtiğimiz hedef olsun."

ZAMAN TABANI: hedefin konumu yalnız `t` (saniye) ile belirlenir ve `t = tbm / 1000` — SITL `time_boot_ms` (sahte kipte kinematik saati). Böylece
  * simülasyon hızı (SIM_SPEEDUP) hedefleri de aynı oranda hızlandırır,
  * istemci hedefi dronun enterpolasyon oynatma başıyla (aynı kaynak saati) çizer → dron ile hedef arasında gecikme farkı yok,
  * kayıttan oynatmada (.bin TimeUS) aynı yörünge birebir yeniden üretilir (deterministik); "Sıfırla" SITL'i yeniden başlattığından hedefler de başa döner.
Ön yüz eşleniği: static/js/modules/flightsim_targets.js (`targetState`) — aynı formül; tests.test_flightsim ve tests/test_flightsim_targets.mjs aynı
sayısal değerleri sınar.

YEREL ÇERÇEVE: merkez (oturum `center`) referanslı ENU, flightsim3d ile aynı düz yaklaşım: x = (lon − lon0)·111320·cos(lat0), y = (lat − lat0)·110574,
z = irtifa (m, ev irtifasına göre — `alt_m` "AGL" ev noktasının zeminine göredir; gerçek arazide hedef arazinin üstünde/altında kalabilir, belgelenmiştir).

YÖRÜNGE: merkez (east_m, north_m), yarıçap R = diameter_m / 2, hız v, açısal hız ω = v / R. Saat yönü (cw, yukarıdan bakınca): θ(t) = θ0 − ω·t;
saat yönü tersi (ccw): θ(t) = θ0 + ω·t (θ doğudan saat yönü tersine). Yön (kuzeyden saat yönünde) hız vektöründen; yatış açısı koordineli dönüş
φ = atan(v² / (R·g)) — cw sağa (+), ccw sola (−). Pitch 0.

ÖNLEME: oyuncu dronu bir hedefe `radius_m` (varsayılan 25 m) içine girince "önleme" olayı (bir geçiş = bir önleme; çıkış 1,5×R histerezisiyle). Rapor:
hedef başına önleme sayısı, ilk önleme süresi (ilk ARM'dan), yarıçap içinde geçen süre, en yakın mesafe; toplam; SIMUMAV puanı ve rozetler.
"""
import math

HEDEF_MAX = 8
CAP_SINIR = (50.0, 5000.0)          # m
IRTIFA_SINIR = (10.0, 3000.0)       # m (ev noktasına göre)
OFSET_SINIR = 20000.0               # m (merkezden doğu/kuzey)
YARICAP_SINIR = (5.0, 200.0)        # m (önleme yarıçapı)
YARICAP_VARSAYILAN = 25.0
CIKIS_HISTEREZ = 1.5                # yarıçapın bu katından uzaklaşınca geçiş biter
G = 9.80665
M_LAT = 110574.0
M_LON = 111320.0

# Hedef olarak seçilebilen modeller. `tgt:*` kullanıcının verdiği hedef modelleri (static/simumav/models/tgt_*.glb; LICENSES.md); hızlar km/h
# (araştırma notları docs §24.1): Switchblade 300 seyir 101 / atılım 161 (AeroVironment veri sayfası); Lancet-3 seyir 80–110 (varsayılan 110) / dalış
# 300; Altius-600M seyir ~60 / azami ~90 (kaynaklar tutarsız — bazı kaynaklar knot verir); Octopus-100 normatif azami 300 (geliştirilmiş 360), seyir
# kaynakta yok → 200 km/h seçildi (azami hızın ~2/3'ü; elektrikli pervaneli önleyicilerde seyir/azami oranı ~0,6–0,7).
# `builtin:*` sistemdeki dron türlerinin dahili modelleri (flightsim_models.BUILTIN) — sihirbaz bunları da hedef olarak listeler.
GLB_ORIENT = {'forward': '+x', 'up': '+y', 'scale': 1.0, 'offset': [0.0, 0.0, 0.0], 'prop': {'mode': 'none', 'pos': [0.0, 0.0, 0.0], 'r': 0.3}}
HEDEF_MODELLERI = {
    'tgt:sw300': {'name': 'Switchblade 300', 'glb': 'simumav/models/tgt_sw300.glb', 'kind': 'plane', 'cruise_kmh': 101.0, 'max_kmh': 161.0,
                  'desc': 'Tüp atımlı küçük kanatlı dron (~0,5 m); seyir 101, atılım 161 km/h'},
    'tgt:lancet': {'name': 'ZALA Lancet-3', 'glb': 'simumav/models/tgt_lancet.glb', 'kind': 'plane', 'cruise_kmh': 110.0, 'max_kmh': 300.0,
                   'desc': 'Çift X kanatlı (~1,65 m); seyir 80–110, dalış 300 km/h'},
    'tgt:altius': {'name': 'Altius-600M', 'glb': 'simumav/models/tgt_altius.glb', 'kind': 'plane', 'cruise_kmh': 60.0, 'max_kmh': 90.0,
                   'desc': 'Açılır kanatlı tüp gövde (~1 m, açıklık ~2,5 m); seyir ~60, azami ~90 km/h (kaynaklar tutarsız)'},
    'tgt:octopus': {'name': 'Octopus-100', 'glb': 'simumav/models/tgt_octopus.glb', 'kind': 'plane', 'cruise_kmh': 200.0, 'max_kmh': 300.0,
                    'desc': 'Küçük hızlı önleyici; normatif azami 300 (geliştirilmiş 360), seyir 200 km/h (seçilen)'},
}
# Dahili (sistem) modellerin hedef hızları (km/h): seyir, azami — tür sınıfından makul değerler
BUILTIN_HIZ = {'caymaz': (90.0, 162.0), 'delta': (72.0, 126.0), 'talon': (65.0, 110.0), 'quad': (36.0, 65.0), 'hexa': (36.0, 60.0), 'heli': (60.0, 110.0),
               'icept_x4': (216.0, 400.0), 'p1sun': (150.0, 300.0), 'sting': (150.0, 315.0)}


def _yuvarla(v, n=2):
    return round(float(v), n)


def katalog():
    """Hedef seçilebilen modeller: [{key, name, kind, glb_url, orient, has_prop, cruise_ms, max_ms, desc, source}] — önce hedef modelleri, sonra
    sistemdeki dron türlerinin dahili modelleri (tip adıyla)."""
    from . import flightsim, flightsim_models
    out = []
    for k, m in HEDEF_MODELLERI.items():
        out.append({'key': k, 'name': m['name'], 'kind': m['kind'], 'type': None, 'glb_url': f"/static/{m['glb']}", 'orient': dict(GLB_ORIENT, prop=dict(GLB_ORIENT['prop'])),
                    'has_prop': True, 'cruise_ms': _yuvarla(m['cruise_kmh'] / 3.6), 'max_ms': _yuvarla(m['max_kmh'] / 3.6), 'desc': m['desc'], 'source': 'target'})
    for ad, b in flightsim_models.BUILTIN.items():
        tip = b['types'][0]
        hz = BUILTIN_HIZ.get(ad, (60.0, 100.0))
        api = flightsim_models.builtin_api(ad, tip)
        out.append({'key': f'builtin:{ad}', 'name': f"{flightsim.TIP_ADLARI.get(tip, tip)} · {api['name']}", 'kind': 'rotor' if tip in ('multirotor', 'hexarotor', 'helikopter') else 'plane',
                    'type': tip, 'glb_url': api.get('glb_url'), 'orient': api.get('orient'), 'has_prop': bool(api.get('has_prop')), 'cruise_ms': _yuvarla(hz[0] / 3.6),
                    'max_ms': _yuvarla(hz[1] / 3.6), 'desc': api.get('desc'), 'source': 'builtin'})
    return out


def model_bul(key):
    for m in katalog():
        if m['key'] == key:
            return m
    return None


class HedefHata(ValueError):
    pass


def _sayi(v, ad, alt, ust):
    if isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(float(v)):
        raise HedefHata(f'{ad} sayı olmalı')
    v = float(v)
    if not (alt <= v <= ust):
        raise HedefHata(f'{ad} {alt:g}…{ust:g} arasında olmalı')
    return v


def dogrula(t, katalog_listesi=None):
    """`targets` gövdesi: liste ya da {items:[…], radius_m}. Her öğe {model, alt_m, diameter_m, speed_ms?, dir? cw|ccw, east_m?, north_m?, phase_deg?, name?}.
    `katalog_listesi`: seçilebilir modeller (varsayılan HEPGO `katalog()`; SIMUMAV kendi GLB kataloğunu verir). Öğelere modelin görsel bilgisi
    (glb_url, orient, has_prop, kind, model_name, type) gömülür → oturum yanıtı, kayıt (drone_sim_runs.targets) ve kayıttan oynatma katalogdan bağımsız.
    Dönüş: {'items': [...], 'radius_m': R} (boş liste → None). Hatalı → HedefHata (router 400 / SIMUMAV 422)."""
    if t is None:
        return None
    radius = YARICAP_VARSAYILAN
    if isinstance(t, dict):
        items = t.get('items')
        if t.get('radius_m') is not None:
            radius = _sayi(t['radius_m'], 'targets.radius_m', *YARICAP_SINIR)
    else:
        items = t
    if items is None:
        items = []
    if not isinstance(items, list):
        raise HedefHata('targets bir liste olmalı')
    if len(items) > HEDEF_MAX:
        raise HedefHata(f'En çok {HEDEF_MAX} hedef')
    if not items:
        return None
    kat = {m['key']: m for m in (katalog_listesi if katalog_listesi is not None else katalog())}
    out = []
    for i, h in enumerate(items):
        if not isinstance(h, dict):
            raise HedefHata('hedef bir nesne olmalı')
        key = h.get('model')
        if not isinstance(key, str) or key not in kat:
            raise HedefHata(f'hedef {i + 1}: bilinmeyen model')
        m = kat[key]
        alt = _sayi(h.get('alt_m', 120), f'hedef {i + 1} irtifa (alt_m)', *IRTIFA_SINIR)
        cap = _sayi(h.get('diameter_m', 800), f'hedef {i + 1} yörünge çapı (diameter_m)', *CAP_SINIR)
        v = h.get('speed_ms')
        v = m['cruise_ms'] if v is None else _sayi(v, f'hedef {i + 1} hız (speed_ms)', 1.0, m['max_ms'])
        yon = h.get('dir', 'cw')
        if yon not in ('cw', 'ccw'):
            raise HedefHata(f'hedef {i + 1}: dir cw | ccw olmalı')
        e = _sayi(h.get('east_m', 0) or 0, f'hedef {i + 1} doğu ofseti (east_m)', -OFSET_SINIR, OFSET_SINIR)
        n = _sayi(h.get('north_m', 0) or 0, f'hedef {i + 1} kuzey ofseti (north_m)', -OFSET_SINIR, OFSET_SINIR)
        faz = h.get('phase_deg')
        faz = (i * 137.5) % 360 if faz is None else _sayi(faz, f'hedef {i + 1} başlangıç açısı (phase_deg)', 0, 360)
        ad = h.get('name')
        ad = (str(ad).strip()[:40] if isinstance(ad, str) and ad.strip() else f"{m['name']} #{i + 1}")
        ad = ''.join(c for c in ad if c.isprintable() and c not in '<>')
        out.append({'i': i, 'model': key, 'name': ad, 'alt_m': alt, 'diameter_m': cap, 'speed_ms': round(v, 2), 'dir': yon, 'east_m': e, 'north_m': n,
                    'phase_deg': round(faz, 2), 'model_name': m.get('name'), 'kind': m.get('kind'), 'type': m.get('type'), 'glb_url': m.get('glb_url'),
                    'orient': m.get('orient'), 'has_prop': bool(m.get('has_prop', True))})
    return {'items': out, 'radius_m': radius}


def zenginlestir(cfg):
    """Oturum yanıtı / hello için hedef listesi. Görsel bilgi doğrulamada gömülür; eski kayıtlarda eksikse HEPGO kataloğundan tamamlanır."""
    if not cfg:
        return None
    kat = None
    items = []
    for h in cfg.get('items') or []:
        if 'glb_url' not in h:
            kat = kat or {m['key']: m for m in katalog()}
            m = kat.get(h.get('model')) or {}
            h = {**h, 'model_name': m.get('name'), 'kind': m.get('kind'), 'glb_url': m.get('glb_url'), 'orient': m.get('orient'),
                 'has_prop': m.get('has_prop', True), 'type': m.get('type')}
        items.append(dict(h))
    return {'items': items, 'radius_m': cfg.get('radius_m', YARICAP_VARSAYILAN)}


def durum(h, t):
    """Hedefin t (sn) anındaki durumu (yerel ENU): {x, y, z, vx, vy, heading (derece, kuzeyden saat yönü), roll (rad, + sağa), yaw (rad, ArduPilot
    uzlaşımı = heading), speed}."""
    R = float(h['diameter_m']) / 2.0
    v = float(h['speed_ms'])
    w = v / R
    s = -1.0 if h.get('dir', 'cw') == 'cw' else 1.0
    th = math.radians(float(h.get('phase_deg') or 0)) + s * w * float(t)
    cx, cy = float(h.get('east_m') or 0), float(h.get('north_m') or 0)
    x, y = cx + R * math.cos(th), cy + R * math.sin(th)
    vx, vy = -R * math.sin(th) * s * w, R * math.cos(th) * s * w
    hd = math.degrees(math.atan2(vx, vy)) % 360.0
    bank = math.atan(v * v / (R * G)) * (1.0 if s < 0 else -1.0)
    return {'x': x, 'y': y, 'z': float(h['alt_m']), 'vx': vx, 'vy': vy, 'heading': hd, 'yaw': math.radians(hd), 'roll': bank, 'speed': v}


def yerel(lat0, lon0, lat, lon):
    return (float(lon) - lon0) * M_LON * math.cos(math.radians(lat0)), (float(lat) - lat0) * M_LAT


def latlon(lat0, lon0, x, y):
    return lat0 + y / M_LAT, lon0 + x / (M_LON * math.cos(math.radians(lat0)))


class HedefIzleyici:
    """Oturum boyunca önleme takibi. `adim(t, x, y, z, armed)` → yeni önleme olayları listesi."""

    def __init__(self, cfg):
        self.cfg = cfg
        self.R = float(cfg['radius_m'])
        self.iz = [{'i': h['i'], 'name': h['name'], 'model': h['model'], 'intercepts': 0, 'first_s': None, 'in_s': 0.0, 'min_dist_m': None, 'inside': False}
                   for h in cfg['items']]
        self.t_arm = None
        self.t_son = None

    def adim(self, t, x, y, z, armed):
        olaylar = []
        t = float(t)
        dt = 0.0 if self.t_son is None or not (0 < t - self.t_son < 5) else t - self.t_son
        if self.t_son is not None and t < self.t_son - 1:   # SITL yeniden başladı (Sıfırla): geçişler kapanır, ARM zamanı yeniden ölçülür
            self.t_arm = None
            for d in self.iz:
                d['inside'] = False
        self.t_son = t
        if armed and self.t_arm is None:
            self.t_arm = t
        for h, d in zip(self.cfg['items'], self.iz):
            st = durum(h, t)
            dist = math.sqrt((st['x'] - x) ** 2 + (st['y'] - y) ** 2 + (st['z'] - z) ** 2)
            if d['min_dist_m'] is None or dist < d['min_dist_m']:
                d['min_dist_m'] = round(dist, 1)
            if d['inside']:
                d['in_s'] += dt
                if dist > self.R * CIKIS_HISTEREZ:
                    d['inside'] = False
            elif dist <= self.R and armed:
                d['inside'] = True
                d['intercepts'] += 1
                ilk = d['first_s'] is None
                if ilk:
                    d['first_s'] = round(t - (self.t_arm if self.t_arm is not None else t), 1)
                olaylar.append({'i': h['i'], 'name': h['name'], 'model': h['model'], 'dist_m': round(dist, 1), 'n': d['intercepts'], 'first': ilk,
                                'after_s': d['first_s'] if ilk else round(t - (self.t_arm or t), 1)})
        return olaylar

    def ozet(self):
        items = [{k: (round(v, 1) if isinstance(v, float) else v) for k, v in d.items() if k != 'inside'} for d in self.iz]
        toplam = sum(d['intercepts'] for d in items)
        vurulan = sum(1 for d in items if d['intercepts'])
        out = {'radius_m': self.R, 'count': len(items), 'items': items, 'total': toplam, 'hit_targets': vurulan,
               'all_hit': bool(items) and vurulan == len(items)}
        out.update(puan(out))
        return out


def puan(oz):
    """SIMUMAV oyunlaştırma (HEPGO raporunda da bilgi): hedef başına ilk önleme 1000 − 5·saniye (≥ 200), sonraki her geçiş +100, en yakın geçiş
    bonusu (≤ 5 m: +150). Rozetler: first (ilk önleme), ace (tüm hedefler), quick (ilk önleme ≤ 60 sn), close (≤ 5 m), hunter (≥ 5 önleme)."""
    p = 0
    rozet = []
    ilkler = [d['first_s'] for d in oz['items'] if d.get('first_s') is not None]
    for d in oz['items']:
        if d.get('intercepts'):
            p += max(200, int(1000 - 5 * float(d.get('first_s') or 0)))
            p += 100 * (int(d['intercepts']) - 1)
            if d.get('min_dist_m') is not None and d['min_dist_m'] <= 5:
                p += 150
    if ilkler:
        rozet.append('first')
        if min(ilkler) <= 60:
            rozet.append('quick')
    if oz.get('all_hit') and oz['count'] > 1:
        rozet.append('ace')
    if any(d.get('min_dist_m') is not None and d['min_dist_m'] <= 5 and d.get('intercepts') for d in oz['items']):
        rozet.append('close')
    if oz.get('total', 0) >= 5:
        rozet.append('hunter')
    return {'score': p, 'badges': rozet}


# ---- Mission Planner trafiği: ADSB_VEHICLE ----
ADSB_COMP = 156                     # MAV_COMP_ID_ADSB
ADSB_ICAO_TABANI = 0xE0C000         # hedef i → ICAO adresi (sahte, özel blok)
ADSB_BAYRAK = 0x01 | 0x02 | 0x04 | 0x08 | 0x10 | 0x40   # LATLON | ALTITUDE | HEADING | VELOCITY | CALLSIGN | SIMULATED geçerli
ADSB_EMITTER_UAV = 14


def adsb_alanlari(cfg, lat0, lon0, alt0_msl, t):
    """Her hedef için `adsb_vehicle_encode` argümanları (pymavlink sırasıyla): ICAO, lat, lon, altitude_type (1 = geometrik), altitude (mm MSL), heading
    (cdeg), hor_velocity (cm/s), ver_velocity, callsign (8 bayt), emitter_type, tslc, flags, squawk."""
    out = []
    for h in (cfg or {}).get('items', []):
        st = durum(h, t)
        lat, lon = latlon(lat0, lon0, st['x'], st['y'])
        cs = f"TGT{h['i'] + 1}".encode()[:8]
        out.append((ADSB_ICAO_TABANI + int(h['i']), int(lat * 1e7), int(lon * 1e7), 1, int((float(alt0_msl or 0) + st['z']) * 1000),
                    int(round(st['heading'] * 100)) % 36000, int(st['speed'] * 100), 0, cs, ADSB_EMITTER_UAV, 0, ADSB_BAYRAK, 0))
    return out
