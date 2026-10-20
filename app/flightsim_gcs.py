"""Uçuş Simülatörü — YER KONTROL MERKEZİ, EO + RADAR KULESİ ve "YER KONTROLÜNÜ KORU" görevi (docs/ucus-simulatoru.md §26).

Kullanıcı isteği (özet): rampanın / kalkış aracının yakınında isteğe bağlı bir yer kontrol istasyonu ve Elektro-Optik (EO) + radar taşıyan bir kule; radar
360° sürekli döner (kapsama varsayılan 20 km), EO yakınlaştırma menzili varsayılan 5 km. Uçuş öncesi RADAR / YER KONTROL İSTASYONU / ELEKTRO-OPTİK var/yok
ve menziller seçilir. Görev "Yer kontrolünü koru": tamamen manuel uçuş; istasyonun yanında yerde 10 interceptor (§25 tailsitter); belirli aralıklarla rastgele
mesafe ve yükseklikten hedefler (Switchblade, Lancet, Altius, Octopus) istasyona dalar; oyuncu interceptor ile önler (önleme yarıçapı §24 mantığı); vurulamayan
hedef istasyona ulaşırsa istasyon hasar alır; zorluk dalgalarla artar; deterministik tohum (aynı tohum → aynı senaryo; replay).

SAF FONKSİYONLAR (ön yüz eşleniği static/js/modules/flightsim_gcs.js — aynı formüller; tests/test_flightsim_gcs.mjs ve tests.test_flightsim gcs_testleri):
  gcs_dogrula · yerlesim · radar_kapsar · eo_bakis · mulberry32 · savunma_dogrula · savunma_plani · tehdit_geometri · tehdit_durum · savunma_puan.

ZAMAN TABANI (görev saati): tm = taban + tbm/1000 — tbm SITL time_boot_ms (sahte kipte kinematik saati; §24 hedefleriyle aynı kaynak → simülasyon hızı
senaryoyu da hızlandırır, istemci tehditleri dronun enterpolasyon oynatma başıyla çizer). Sıradaki interceptor için SITL yeniden başlatılır (aşağıda) ve
time_boot_ms sıfırdan başlar: geri sarma algılanınca `taban` önceki bölümün son saatini ekler → görev saati kesintisiz ve tekdüze artar. SITL'in yeniden
açılışı sürerken telemetri yoktur → senaryo da bekler (adil ve deterministik).

İNTERCEPTOR DEĞİŞİMİ — karar ve gerekçe: SITL tek araç çalıştırır; 10 interceptor'ın her biri için ayrı SITL (bellek/CPU, port, MP bağlantısı) ya da oturum
yenileme (yeni oturum kimliği, MP yeniden bağlanır, WS kopar, kayıt bölünür) ağır ve kırılgandır. Seçilen: AYNI SITL aracı aynı oturumda yeniden
"konuşlandırılır" — mevcut, test edilmiş `reset` yolu (SITL aynı ayarlarla yeniden başlar, araç pad'de kuyruk üstünde doğar; MP aynı TCP/UDP adresinde
kalır, oturum/WS/kayıt sürer). Rafta görünen interceptor sayısı bir azalır; güç durumu (batarya) yeni araç için tamdır. Bir interceptor yalnız ARM
edildiyse (uçtuysa) harcanmış sayılır; hiç ARM edilmeden yeniden konuşlandırma ücretsizdir. Görev saati yukarıdaki taban kuralıyla sürer.
"""
import math
import secrets

# ---- Yer kontrol merkezi / kule ----
RADAR_KM = (1.0, 50.0)
RADAR_KM_VARSAYILAN = 20.0
EO_KM = (0.5, 15.0)
EO_KM_VARSAYILAN = 5.0
RADAR_DONUS_S = 4.0            # anten turu (15 dev/dk) — ön yüz tarama hüzmesi aynı periyotla döner
KULE_EO_Z = 18.0               # EO başlığı yerden yükseklik (m)
KULE_RADAR_Z = 21.5            # radar anteni yerden yükseklik (m)
ISTASYON_Z = 2.6               # istasyon (konteyner) çatısı: dalan tehditlerin nişan noktası (m, ev zeminine göre)
GCS_ANAHTARLAR = ('station', 'radar', 'radar_km', 'eo', 'eo_km')
# Yerleşim (pist/kalkış yönüne göre; f ileri, r sağ): istasyon rampanın / aracın arkasında sağda, kule istasyonun sağında, interceptor rafı pad ile istasyon arasında
YER_ISTASYON = (-40.0, 55.0)
YER_KULE = (-40.0, 85.0)
YER_RAF = (-14.0, 34.0)


class GcsHata(ValueError):
    pass


def _bool(v, ad):
    if not isinstance(v, bool):
        raise GcsHata(f'{ad} doğru/yanlış olmalı')
    return v


def _sayi(v, ad, alt, ust):
    if isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(float(v)):
        raise GcsHata(f'{ad} sayı olmalı')
    v = float(v)
    if not (alt <= v <= ust):
        raise GcsHata(f'{ad} {alt:g}…{ust:g} arasında olmalı')
    return v


def gcs_dogrula(g):
    """`gcs` gövdesi {station: bool, radar: bool, radar_km?, eo: bool, eo_km?} → normalize sözlük; hepsi kapalı / None → None. Bilinmeyen anahtar,
    bool olmayan bayrak, sayı olmayan / aralık dışı menzil → GcsHata (HEPGO 400, SIMUMAV 422). Dünyaya açık SIMUMAV için katı."""
    if g is None:
        return None
    if not isinstance(g, dict):
        raise GcsHata('gcs bir nesne olmalı')
    fazla = [k for k in g if k not in GCS_ANAHTARLAR]
    if fazla:
        raise GcsHata(f'gcs: bilinmeyen alan {str(fazla[0])[:20]}')
    out = {'station': _bool(g.get('station', False), 'gcs.station'), 'radar': _bool(g.get('radar', False), 'gcs.radar'),
           'radar_km': RADAR_KM_VARSAYILAN, 'eo': _bool(g.get('eo', False), 'gcs.eo'), 'eo_km': EO_KM_VARSAYILAN}
    if g.get('radar_km') is not None:
        out['radar_km'] = round(_sayi(g['radar_km'], 'gcs.radar_km', *RADAR_KM), 2)
    if g.get('eo_km') is not None:
        out['eo_km'] = round(_sayi(g['eo_km'], 'gcs.eo_km', *EO_KM), 2)
    if not (out['station'] or out['radar'] or out['eo']):
        return None
    return out


def _yer(heading_deg, f, r):
    h = math.radians(float(heading_deg or 0))
    fx, fy = math.sin(h), math.cos(h)        # ileri (pist yönü; kuzeyden saat yönü)
    rx, ry = math.cos(h), -math.sin(h)       # sağ
    return {'x': round(f * fx + r * rx, 3), 'y': round(f * fy + r * ry, 3), 'yaw_deg': round(float(heading_deg or 0) % 360.0, 3)}


def yerlesim(heading_deg=0.0):
    """Yerel ENU (merkez = pad / rampa / araç başlangıcı) konumları: istasyon, kule, interceptor rafı; `yaw_deg` uzun eksen yönü (pist yönü)."""
    return {'station': _yer(heading_deg, *YER_ISTASYON), 'tower': _yer(heading_deg, *YER_KULE), 'rack': _yer(heading_deg, *YER_RAF),
            'station_z': ISTASYON_Z, 'eo_z': KULE_EO_Z, 'radar_z': KULE_RADAR_Z, 'sweep_s': RADAR_DONUS_S}


def radar_kapsar(gcs, kule, x, y, z=0.0):
    """Radar hedefi görür mü: radar açık ve kuleye yatay uzaklık ≤ kapsama. (Ön yüz radar ekranı kapsama dışındakileri çizmez.)"""
    if not gcs or not gcs.get('radar'):
        return False
    return math.hypot(float(x) - kule['x'], float(y) - kule['y']) <= float(gcs['radar_km']) * 1000.0


def eo_bakis(kule, x, y, z, eo_z=KULE_EO_Z):
    """Kuledeki EO başlığından hedefe bakış: {az (°, kuzeyden saat yönü), el (°, yukarı +), range_m (eğik mesafe), ground_m}."""
    dx, dy, dz = float(x) - kule['x'], float(y) - kule['y'], float(z) - eo_z
    g = math.hypot(dx, dy)
    return {'az': math.degrees(math.atan2(dx, dy)) % 360.0, 'el': math.degrees(math.atan2(dz, g)), 'range_m': math.hypot(g, dz), 'ground_m': g}


# ---- Deterministik rastgele (mulberry32; ön yüzle bit düzeyinde aynı) ----
def _imul(a, b):
    return (a * b) & 0xFFFFFFFF


def mulberry32(seed):
    a = (int(seed) & 0xFFFFFFFF) or 1

    def r():
        nonlocal a
        a = (a + 0x6D2B79F5) & 0xFFFFFFFF
        t = _imul(a ^ (a >> 15), 1 | a)
        t = ((t + _imul(t ^ (t >> 7), 61 | t)) & 0xFFFFFFFF) ^ t
        return ((t ^ (t >> 14)) & 0xFFFFFFFF) / 4294967296.0
    return r


# ---- "Yer kontrolünü koru" görevi ----
SAVUNMA_ANAHTARLAR = ('seed', 'waves', 'interceptors', 'difficulty', 'radius_m', 'prep_s')
SAVUNMA_VARSAYILAN = {'waves': 5, 'interceptors': 10, 'difficulty': 'normal', 'radius_m': 30.0, 'prep_s': 45.0}
SAVUNMA_SINIR = {'waves': (1, 10), 'interceptors': (1, 20), 'radius_m': (10.0, 100.0), 'prep_s': (15.0, 300.0)}
ZORLUKLAR = ('easy', 'normal', 'hard')
# gap: dalgalar arası (sn) · n0: ilk dalga tehdit sayısı (her dalga +1, ≤ 8) · dist/alt: başlangıç uzaklığı / irtifası (m) · spd: seyir hızı çarpanı ·
# spacing: dalga içi ardışık doğuş aralığı (sn)
ZORLUK = {
    'easy': {'gap': 90.0, 'n0': 1, 'dist': (2500.0, 4500.0), 'alt': (120.0, 350.0), 'spd': 0.85, 'spacing': (8.0, 16.0)},
    'normal': {'gap': 70.0, 'n0': 2, 'dist': (3000.0, 6000.0), 'alt': (150.0, 450.0), 'spd': 1.0, 'spacing': (5.0, 12.0)},
    'hard': {'gap': 55.0, 'n0': 3, 'dist': (3500.0, 8000.0), 'alt': (150.0, 600.0), 'spd': 1.15, 'spacing': (3.0, 9.0)},
}
TEHDIT_MODELLERI = ('tgt:sw300', 'tgt:lancet', 'tgt:altius', 'tgt:octopus')
HASAR = {'tgt:sw300': 15.0, 'tgt:lancet': 35.0, 'tgt:altius': 25.0, 'tgt:octopus': 20.0}   # istasyon sağlığı (100) kaybı — harp başlığı sınıfına göre
DALIS_ACI = (25.0, 50.0)       # dalış açısı (°)
TEHDIT_MAX = 60
BASARI_SAGLIK = 50.0          # görev başarılı sayılması için tüm tehditler çözüldüğünde istasyon sağlığı en az (%)
DUSUS_S = 8.0                  # önlenen tehdidin düşüş görünürlüğü (istemci)
RUTBELER = (('colonel', 0.95), ('major', 0.85), ('captain', 0.72), ('lieutenant', 0.58), ('sergeant', 0.42), ('corporal', 0.25), ('private', 0.0))
RUTBE_TR = {'colonel': 'Albay', 'major': 'Binbaşı', 'captain': 'Yüzbaşı', 'lieutenant': 'Teğmen', 'sergeant': 'Çavuş', 'corporal': 'Onbaşı', 'private': 'Er'}


def savunma_dogrula(d, tip=None):
    """`defend` gövdesi {seed?, waves?, interceptors?, difficulty?, radius_m?, prep_s?} → normalize (seed yoksa rastgele). None → None.
    Yalnız INTERCEPTOR tipiyle (tip verilmişse). Hatalı → GcsHata."""
    if d is None:
        return None
    if d is True:
        d = {}
    if not isinstance(d, dict):
        raise GcsHata('defend bir nesne olmalı')
    fazla = [k for k in d if k not in SAVUNMA_ANAHTARLAR]
    if fazla:
        raise GcsHata(f'defend: bilinmeyen alan {str(fazla[0])[:20]}')
    if tip is not None and tip != 'interceptor':
        raise GcsHata('"Yer kontrolünü koru" görevi yalnız INTERCEPTOR ile uçulur')
    out = dict(SAVUNMA_VARSAYILAN)
    s = d.get('seed')
    if s is None:
        out['seed'] = secrets.randbelow(2 ** 31 - 1) + 1
    else:
        if isinstance(s, bool) or not isinstance(s, int) or not (0 <= s <= 2 ** 31 - 1):
            raise GcsHata('defend.seed 0…2147483647 tam sayı olmalı')
        out['seed'] = int(s)
    for k in ('waves', 'interceptors'):
        if d.get(k) is not None:
            v = d[k]
            if isinstance(v, bool) or not isinstance(v, int):
                raise GcsHata(f'defend.{k} tam sayı olmalı')
            if not (SAVUNMA_SINIR[k][0] <= v <= SAVUNMA_SINIR[k][1]):
                raise GcsHata(f'defend.{k} {SAVUNMA_SINIR[k][0]}…{SAVUNMA_SINIR[k][1]} arasında olmalı')
            out[k] = int(v)
    for k in ('radius_m', 'prep_s'):
        if d.get(k) is not None:
            out[k] = round(_sayi(d[k], f'defend.{k}', *SAVUNMA_SINIR[k]), 2)
    if d.get('difficulty') is not None:
        if d['difficulty'] not in ZORLUKLAR:
            raise GcsHata('defend.difficulty easy | normal | hard olmalı')
        out['difficulty'] = d['difficulty']
    return out


def _model_gorsel(key):
    from . import flightsim_targets as FT
    m = FT.HEDEF_MODELLERI[key]
    return {'model_name': m['name'], 'kind': m['kind'], 'glb_url': f"/static/{m['glb']}", 'orient': dict(FT.GLB_ORIENT, prop=dict(FT.GLB_ORIENT['prop'])), 'has_prop': True}


def savunma_plani(cfg, gorsel=True):
    """Tohumdan deterministik tehdit listesi: [{k, wave, model, name, spawn_t, bearing_deg, dist_m, alt_m, dive_deg, cruise_ms, dive_ms, damage, (görsel)}].
    Dalga w: başlangıç prep_s + w·gap; tehdit sayısı min(8, n0 + w); dalga içi doğuşlar spacing aralığıyla; uzaklık her dalga %4, seyir hızı %5 artar;
    dalış hızı modelin azami hızının %85'inden (her dalga +%5) %100'üne. En çok TEHDIT_MAX."""
    from . import flightsim_targets as FT
    z = ZORLUK[cfg['difficulty']]
    r = mulberry32(cfg['seed'])

    def u(a, b):
        return a + (b - a) * r()
    out = []
    for w in range(int(cfg['waves'])):
        t = float(cfg['prep_s']) + w * z['gap']
        n = min(8, z['n0'] + w)
        for k in range(n):
            if len(out) >= TEHDIT_MAX:
                break
            if k:
                t += u(*z['spacing'])
            key = TEHDIT_MODELLERI[min(len(TEHDIT_MODELLERI) - 1, int(r() * len(TEHDIT_MODELLERI)))]
            brg = u(0.0, 360.0)
            dist = u(*z['dist']) * (1.0 + 0.04 * w)
            alt = u(*z['alt'])
            dive = u(*DALIS_ACI)
            m = FT.HEDEF_MODELLERI[key]
            vc = min(m['max_kmh'], m['cruise_kmh'] * z['spd'] * (1.0 + 0.05 * w)) / 3.6
            vd = m['max_kmh'] / 3.6 * min(1.0, 0.85 + 0.05 * w)
            th = {'k': len(out), 'wave': w, 'model': key, 'name': f"{m['name']} · T{len(out) + 1}", 'spawn_t': round(t, 2), 'bearing_deg': round(brg, 2),
                  'dist_m': round(dist, 1), 'alt_m': round(alt, 1), 'dive_deg': round(dive, 2), 'cruise_ms': round(vc, 2), 'dive_ms': round(max(vd, vc + 1.0), 2),
                  'damage': HASAR[key]}
            if gorsel:
                th.update(_model_gorsel(key))
            out.append(th)
    return out


def tehdit_geometri(th, ist):
    """Seyir (sabit irtifa, istasyona doğru) + dalış (düz çizgi, istasyon çatısına) geometrisi: başlangıç, dalış başlangıcı, süreler, çarpma anı."""
    b = math.radians(float(th['bearing_deg']))
    D, z0, zs = float(th['dist_m']), float(th['alt_m']), float(ist.get('z', ISTASYON_Z))
    hgt = max(1.0, z0 - zs)
    dd = min(D, hgt / math.tan(math.radians(float(th['dive_deg']))))
    sx, sy = math.sin(b), math.cos(b)
    x0, y0 = ist['x'] + D * sx, ist['y'] + D * sy
    vc, vd = float(th['cruise_ms']), float(th['dive_ms'])
    tc = (D - dd) / vc
    L = math.hypot(dd, hgt)
    td = L / vd
    return {'x0': x0, 'y0': y0, 'z0': z0, 'ux': -sx, 'uy': -sy, 'x1': ist['x'] + dd * sx, 'y1': ist['y'] + dd * sy, 'xs': ist['x'], 'ys': ist['y'], 'zs': zs,
            'tc': tc, 'td': td, 'L': L, 'dd': dd, 'h': hgt, 'vc': vc, 'vd': vd, 't_impact': float(th['spawn_t']) + tc + td,
            'heading': (math.degrees(b) + 180.0) % 360.0, 'pitch': -math.atan2(hgt, dd)}


def tehdit_durum(th, t, ist, g=None):
    """Tehdidin görev saati t'deki durumu (yerel ENU) ya da None (henüz doğmadı): {x, y, z, vx, vy, vz, heading, yaw, pitch (rad), roll, speed, phase
    'cruise'|'dive'|'impact'}. Çarpma anından sonra konum istasyon çatısında kalır (phase 'impact')."""
    g = g or tehdit_geometri(th, ist)
    tau = float(t) - float(th['spawn_t'])
    if tau < 0:
        return None
    hd = g['heading']
    if tau <= g['tc']:
        s = g['vc'] * tau
        return {'x': g['x0'] + g['ux'] * s, 'y': g['y0'] + g['uy'] * s, 'z': g['z0'], 'vx': g['ux'] * g['vc'], 'vy': g['uy'] * g['vc'], 'vz': 0.0,
                'heading': hd, 'yaw': math.radians(hd), 'pitch': 0.0, 'roll': 0.0, 'speed': g['vc'], 'phase': 'cruise'}
    f = min(1.0, (tau - g['tc']) / g['td'])
    cp, sp = g['dd'] / g['L'], g['h'] / g['L']
    return {'x': g['x1'] + (g['xs'] - g['x1']) * f, 'y': g['y1'] + (g['ys'] - g['y1']) * f, 'z': g['z0'] + (g['zs'] - g['z0']) * f,
            'vx': g['ux'] * g['vd'] * cp, 'vy': g['uy'] * g['vd'] * cp, 'vz': -g['vd'] * sp, 'heading': hd, 'yaw': math.radians(hd), 'pitch': g['pitch'],
            'roll': 0.0, 'speed': g['vd'], 'phase': 'impact' if f >= 1.0 else 'dive'}


def rutbe(oran):
    for k, esik in RUTBELER:
        if oran >= esik:
            return k
    return 'private'


def savunma_puan(oz):
    """Puan ve rütbe (ön yüz scoreDefend eşleniği). Önleme başına 300 + istasyondan uzaklık/10 (≤ 400) + max(0, 200 − önleme süresi sn);
    sızan her tehdit −250; istasyon sağlığı ×10; kullanılmayan interceptor ×100; görev başarıyla bittiyse +1000; ≥ 0.
    İsabet oranı = önlenen / doğan tehdit; rütbe 0,65·isabet + 0,35·sağlık/100 eşiklerinden (Er … Albay)."""
    p = 0
    for k in oz.get('kills') or []:
        p += 300 + min(400, int(round(float(k.get('station_m') or 0) / 10.0))) + max(0, 200 - int(round(float(k.get('ttk_s') or 0))))
    p -= 250 * len(oz.get('leaks') or [])
    p += int(round(max(0.0, float(oz.get('health') or 0)))) * 10
    ic = oz.get('icept') or {}
    p += 100 * max(0, int(ic.get('total') or 0) - int(ic.get('used') or 0))
    if oz.get('success'):
        p += 1000
    p = max(0, p)
    spawned = int(oz.get('spawned') or 0)
    acc = (len(oz.get('kills') or []) / spawned) if spawned else 0.0
    oran = 0.65 * acc + 0.35 * max(0.0, float(oz.get('health') or 0)) / 100.0
    return {'score': p, 'accuracy': round(acc, 3), 'rank': rutbe(oran), 'rank_ratio': round(oran, 3)}


class SavunmaGorevi:
    """Oturum boyunca "Yer kontrolünü koru": `adim(tbm, x, y, z, armed)` → olay listesi (wave | spawn | kill | leak | end). Sunucu otoritedir; istemci planı
    ve önleme/sızma zamanlarını (durum) alıp çizer."""

    def __init__(self, cfg, yer):
        self.cfg = dict(cfg)
        self.plan = savunma_plani(self.cfg)
        self.ist = {'x': yer['station']['x'], 'y': yer['station']['y'], 'z': ISTASYON_Z}
        self.geo = [tehdit_geometri(th, self.ist) for th in self.plan]
        self.durumlar = ['pending'] * len(self.plan)
        self.health = 100.0
        self.taban = 0.0
        self.son_tb = None
        self.t = 0.0
        self.wave = -1
        self.dalga_sayi = {}
        for th in self.plan:
            self.dalga_sayi[th['wave']] = self.dalga_sayi.get(th['wave'], 0) + 1
        self.icept = {'total': int(self.cfg['interceptors']), 'used': 1, 'lost': 0, 'armed': False, 'down': None}
        self.kills = []
        self.leaks = []
        self.bitti = None

    # -- görev saati: SITL yeniden başlayınca (tbm geri) taban önceki bölümün son saatini ekler --
    def zaman(self, tbm):
        tb = float(tbm) / 1000.0
        if self.son_tb is not None and tb < self.son_tb - 1.0:
            self.taban += self.son_tb
        self.son_tb = tb
        return self.taban + tb

    def adim(self, tbm, x, y, z, armed):
        t = self.zaman(tbm)
        self.t = t
        if self.bitti is not None:
            return []
        if armed:
            self.icept['armed'] = True
        R = float(self.cfg['radius_m'])
        ev = []
        for k, th in enumerate(self.plan):
            d = self.durumlar[k]
            if d in ('killed', 'leaked'):
                continue
            if t < th['spawn_t']:
                continue
            if d == 'pending':
                self.durumlar[k] = 'active'
                if th['wave'] > self.wave:
                    self.wave = th['wave']
                    ev.append({'kind': 'wave', 'wave': th['wave'] + 1, 'waves': int(self.cfg['waves']), 'count': self.dalga_sayi.get(th['wave'], 0)})
                ev.append({'kind': 'spawn', 'k': k, 'name': th['name'], 'model': th['model'], 'dist_m': th['dist_m'], 'alt_m': th['alt_m'], 'bearing_deg': th['bearing_deg']})
            g = self.geo[k]
            if t >= g['t_impact']:
                self.durumlar[k] = 'leaked'
                self.health = max(0.0, self.health - float(th['damage']))
                self.leaks.append({'k': k, 't': round(g['t_impact'], 2), 'damage': th['damage'], 'model': th['model']})
                ev.append({'kind': 'leak', 'k': k, 'name': th['name'], 'damage': th['damage'], 'health': round(self.health, 1), 'tt': round(g['t_impact'], 2)})
                continue
            st = tehdit_durum(th, t, self.ist, g)
            dist = math.sqrt((st['x'] - x) ** 2 + (st['y'] - y) ** 2 + (st['z'] - z) ** 2)
            if armed and dist <= R:
                self.durumlar[k] = 'killed'
                sm = math.hypot(st['x'] - self.ist['x'], st['y'] - self.ist['y'])
                kayit = {'k': k, 't': round(t, 2), 'dist_m': round(dist, 1), 'station_m': round(sm, 1), 'ttk_s': round(t - th['spawn_t'], 1),
                         'interceptor': self.icept['used'], 'model': th['model'], 'phase': st['phase'], 'x': round(st['x'], 1), 'y': round(st['y'], 1), 'z': round(st['z'], 1)}
                self.kills.append(kayit)
                ev.append({'kind': 'kill', 'name': th['name'], **kayit})
        if self.health <= 0:
            self.bitti = {'t': round(t, 2), 'success': False, 'reason': 'station_destroyed'}
        elif all(d in ('killed', 'leaked') for d in self.durumlar):
            self.bitti = {'t': round(t, 2), 'success': self.health >= BASARI_SAGLIK, 'reason': 'all_resolved'}
        if self.bitti is not None:
            ev.append({'kind': 'end', **self.bitti, 'result': self.ozet()})
        return ev

    def dustu(self, neden):
        """Aktif interceptor kaybedildi (çarpışma / batarya): bir kez işaretlenir (UI "sıradakini fırlat" ister). Dönüş: yeni işaretlendi mi."""
        if self.icept['down'] or self.bitti is not None:
            return False
        self.icept['down'] = neden
        return True

    def konuslandir(self):
        """Sıradaki interceptor (aynı SITL aracı yeniden): mevcut ARM edildiyse harcanır (used +1); hiç uçmadıysa ücretsiz. Kalmadıysa GcsHata.
        Dönüş: harcandı mı."""
        if not self.icept['armed'] and not self.icept['down']:
            return False
        if self.icept['used'] >= self.icept['total']:
            raise GcsHata('İnterceptor kalmadı')
        self.icept['used'] += 1
        self.icept['lost'] += 1
        self.icept['armed'] = False
        self.icept['down'] = None
        return True

    def durum(self):
        """WS/hello için kompakt durum: istemci planı + bu zamanlarla tehditleri çizer."""
        return {'t': round(self.t, 2), 'base': round(self.taban, 3), 'health': round(self.health, 1), 'wave': self.wave + 1, 'waves': int(self.cfg['waves']),
                'icept': {k: self.icept[k] for k in ('total', 'used', 'lost', 'down')}, 'remaining': self.icept['total'] - self.icept['used'],
                'killed': [[c['k'], c['t']] for c in self.kills], 'leaked': [[c['k'], c['t']] for c in self.leaks],
                'spawned': sum(1 for d in self.durumlar if d != 'pending'), 'total': len(self.plan), 'ended': dict(self.bitti) if self.bitti else None}

    def ozet(self):
        spawned = sum(1 for d in self.durumlar if d != 'pending')
        ttk = [c['ttk_s'] for c in self.kills]
        oz = {'config': dict(self.cfg), 'health': round(self.health, 1), 'kills': [dict(c) for c in self.kills], 'leaks': [dict(c) for c in self.leaks],
              'spawned': spawned, 'total': len(self.plan), 'active': sum(1 for d in self.durumlar if d == 'active'),
              'icept': {k: self.icept[k] for k in ('total', 'used', 'lost')}, 'waves_reached': self.wave + 1,
              'ttk_avg_s': round(sum(ttk) / len(ttk), 1) if ttk else None, 'ttk_min_s': min(ttk) if ttk else None,
              'success': bool(self.bitti and self.bitti['success']), 'ended': dict(self.bitti) if self.bitti else None, 't': round(self.t, 2)}
        oz.update(savunma_puan(oz))
        oz['rank_name'] = RUTBE_TR[oz['rank']]
        return oz
