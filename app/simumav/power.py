"""SIMUMAV — GÜÇ VE YAKIT (docs/simumav.md §10; HEPGO çekirdeği app/flightsim_power.py, docs/ucus-simulatoru.md §23).

Hangar kaydı (`drones.power` JSON; NULL → katalog modelinin varsayılanı, göç verisi bozmaz):
  {engine: 'fuel'|'electric', max_speed_ms, fuel_l, fuel_km_per_l, elec_cells, elec_mah, elec_w,
   fuel_km_per_l_last?, elec_w_last?, measured_at?}   — *_last / measured_at YALNIZ sunucu yazar (uçuş sonu ölçümü).
Kurallar (HEPGO `flightsim_power.dogrula` ile aynı): yakıtlı motor yalnız sabit kanat ailesinde (plane / interceptor / vtol → çekirdek
sabit_kanat | vtol); kopterlerde (multirotor / fpv / heli) motor 'electric', yakıt 0 L ve azami hız yok (None). Elektrikli uçakta yakıt 0 L
(gösterge yok). Sayısal sınırlar çekirdeğin SINIRLAR tablosundan; bool / NaN / ∞ / dize / bilinmeyen anahtar reddedilir (422).
Uçuş açılışı (`ucus_power`): hangar değerleri + sihirbaz gövdesi (aynı doğrulama) → çekirdeğe TAM `power` sözlüğü (ALANLAR) gider; çekirdeğin
drone_sitl_options önerisi kullanılmaz (SIMUMAV dron kimlikleri yeniden kullanılabilir → başka kullanıcının ölçümü sızmasın).
Uçuş sonu (`olcum_yaz`): GucDurumu özeti → geçerli ölçümler (ölçülen km/L, ortalama W) drones.power'a `*_last` olarak (sonraki uçuşta "Önerilen").
"""
import json
import math
from datetime import datetime

from .. import flightsim_power as P

ENGINES = ('fuel', 'electric')
YAKIT_TIPLERI = ('plane', 'interceptor', 'vtol')          # yakıtlı motor anlamlı (çekirdek PLANE_TIPLERI: sabit_kanat, vtol)
ALANLAR = P.ALANLAR                                        # max_speed_ms, fuel_l, fuel_km_per_l, elec_cells, elec_mah, elec_w
SINIRLAR = dict(P.SINIRLAR)
OLCUM_ALANLARI = ('fuel_km_per_l_last', 'elec_w_last', 'measured_at')
GIRIS_ALANLARI = frozenset(('engine', *ALANLAR))
YAKIT_MIN_L = 0.1                                          # yakıtlı motorda depo en az 0,1 L (0 = elektrikli demektir)

# Hazır modeller için makul varsayılanlar (gerçek sınıf değerleri; kopterde W = itki + elektronik ortalaması → uçuş süresi gerçekçi):
#   FPV 4S 1500 mAh 180 W ≈ 7 dk · Iris 3S 5100 mAh ≈ 19 dk · CAYMAZ (HEPGO) 45 m/s 5 L 25 km/L 4S 10000 mAh 30 W · jet 150 m/s 6 L 20 km/L
_E = 'electric'
MODEL_VARSAYILAN = {
    'glb:iris_fpv': {'engine': _E, 'elec_cells': 4, 'elec_mah': 1500, 'elec_w': 180},
    'proc:quad250': {'engine': _E, 'elec_cells': 4, 'elec_mah': 1500, 'elec_w': 180},
    'glb:iris': {'engine': _E, 'elec_cells': 3, 'elec_mah': 5100, 'elec_w': 180},
    'builtin:quad': {'engine': _E, 'elec_cells': 3, 'elec_mah': 5100, 'elec_w': 180},
    'glb:x500': {'engine': _E, 'elec_cells': 4, 'elec_mah': 5000, 'elec_w': 220},
    'glb:typhoon_h480': {'engine': _E, 'elec_cells': 4, 'elec_mah': 5400, 'elec_w': 260},
    'builtin:hexa': {'engine': _E, 'elec_cells': 4, 'elec_mah': 5400, 'elec_w': 260},
    'glb:heli': {'engine': _E, 'elec_cells': 6, 'elec_mah': 5000, 'elec_w': 450},
    'builtin:heli': {'engine': _E, 'elec_cells': 6, 'elec_mah': 5000, 'elec_w': 450},
    'glb:rc_cessna': {'engine': _E, 'max_speed_ms': 28, 'elec_cells': 3, 'elec_mah': 2200, 'elec_w': 120},
    'glb:believer': {'engine': _E, 'max_speed_ms': 30, 'elec_cells': 6, 'elec_mah': 10000, 'elec_w': 200},
    'glb:talon_vtail': {'engine': _E, 'max_speed_ms': 28, 'elec_cells': 4, 'elec_mah': 10000, 'elec_w': 150},
    'builtin:talon': {'engine': _E, 'max_speed_ms': 28, 'elec_cells': 4, 'elec_mah': 10000, 'elec_w': 150},
    'builtin:caymaz': {'engine': 'fuel', 'max_speed_ms': 45, 'fuel_l': 5, 'fuel_km_per_l': 25, 'elec_cells': 4, 'elec_mah': 10000, 'elec_w': 30},
    'builtin:delta': {'engine': _E, 'max_speed_ms': 35, 'elec_cells': 4, 'elec_mah': 5000, 'elec_w': 140},
    'glb:standard_vtol': {'engine': 'fuel', 'max_speed_ms': 30, 'fuel_l': 4, 'fuel_km_per_l': 20, 'elec_cells': 6, 'elec_mah': 16000, 'elec_w': 120},
    'glb:jet': {'engine': 'fuel', 'max_speed_ms': 150, 'fuel_l': 6, 'fuel_km_per_l': 20, 'elec_cells': 4, 'elec_mah': 5000, 'elec_w': 60},
    'proc:interceptor': {'engine': 'fuel', 'max_speed_ms': 150, 'fuel_l': 6, 'fuel_km_per_l': 20, 'elec_cells': 4, 'elec_mah': 5000, 'elec_w': 60},
    'glb:zephyr': {'engine': _E, 'max_speed_ms': 120, 'elec_cells': 4, 'elec_mah': 5000, 'elec_w': 160},
}
TIP_VARSAYILAN = {
    'fpv': MODEL_VARSAYILAN['glb:iris_fpv'], 'multirotor': MODEL_VARSAYILAN['glb:iris'], 'heli': MODEL_VARSAYILAN['glb:heli'],
    'plane': MODEL_VARSAYILAN['builtin:caymaz'], 'vtol': MODEL_VARSAYILAN['glb:standard_vtol'], 'interceptor': MODEL_VARSAYILAN['glb:jet'],
}


class GucHata(ValueError):
    pass


def yakit_olabilir(tip):
    return tip in YAKIT_TIPLERI


def _tam(tip, kaynak):
    """Eksik alanları çekirdek tip varsayılanıyla doldurup kurallara uydurur (engine, yakıt 0, azami hız None)."""
    ctip = 'sabit_kanat' if yakit_olabilir(tip) else 'multirotor'
    out = {'engine': 'fuel' if yakit_olabilir(tip) else 'electric', **P.varsayilanlar(ctip)}
    out.update({k: v for k, v in (kaynak or {}).items() if k in GIRIS_ALANLARI and v is not None})
    return _kurallar(tip, out)


def _kurallar(tip, out):
    if not yakit_olabilir(tip):
        out['engine'] = 'electric'
        out['max_speed_ms'] = None
    if out['engine'] == 'electric':
        out['fuel_l'] = 0.0
    if out.get('max_speed_ms') is None and yakit_olabilir(tip):
        out['max_speed_ms'] = float(P.CAYMAZ_VARSAYILAN['max_speed_ms'])
    for k in ALANLAR:
        v = out.get(k)
        if v is None:
            continue
        out[k] = int(round(v)) if k in P.TAMSAYI else float(v)
    return out


def varsayilan(tip, model_key=None):
    """Katalog modeli (yoksa tip) için güç varsayılanı — tam sözlük (engine + ALANLAR)."""
    return _tam(tip, MODEL_VARSAYILAN.get(str(model_key or '')) or TIP_VARSAYILAN.get(tip) or {})


def _sayi(k, v):
    if isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(float(v)):
        raise GucHata(f'power.{k} sayı olmalı')
    alt, ust = SINIRLAR[k]
    if not (alt <= float(v) <= ust):
        raise GucHata(f'power.{k} {alt:g}…{ust:g} arasında olmalı')
    return int(round(v)) if k in P.TAMSAYI else float(v)


def dogrula(tip, govde, taban=None):
    """İstemci gövdesi (hangar PUT/POST ya da sihirbaz) → tam ayar. `taban`: mevcut kayıt (eksik alanlar oradan). Hatalı → GucHata (422).
    Kötü niyetli giriş: nesne değil / > 12 anahtar / bilinmeyen anahtar / ölçüm alanı (*_last) / sınır dışı / bool / NaN → red."""
    if govde is None:
        govde = {}
    if not isinstance(govde, dict):
        raise GucHata('power bir nesne olmalı')
    if len(govde) > 12:
        raise GucHata('power en çok 12 alan içerebilir')
    bilinmeyen = [str(k)[:24] for k in govde if k not in GIRIS_ALANLARI]
    if bilinmeyen:
        raise GucHata(f'power alanı tanınmıyor: {bilinmeyen[0]}')
    out = dict(taban or {})
    out = {k: out.get(k) for k in GIRIS_ALANLARI}
    if 'engine' in govde and govde['engine'] is not None:
        if govde['engine'] not in ENGINES:
            raise GucHata('power.engine fuel | electric olmalı')
        if govde['engine'] == 'fuel' and not yakit_olabilir(tip):
            raise GucHata('Yakıtlı motor yalnız sabit kanat / interceptor / VTOL için seçilebilir')
        out['engine'] = govde['engine']
    for k in ALANLAR:
        if k in govde and govde[k] is not None:
            if k == 'max_speed_ms' and not yakit_olabilir(tip):
                continue   # kopterde azami hız yok (HEPGO dogrula: yok sayılır)
            out[k] = _sayi(k, govde[k])
    out = _tam(tip, out)
    if out['engine'] == 'fuel' and float(out['fuel_l'] or 0) < YAKIT_MIN_L:
        if govde.get('fuel_l') is not None:
            raise GucHata(f'Yakıtlı motorda yakıt deposu en az {YAKIT_MIN_L:g} L olmalı')
        out['fuel_l'] = float(P.CAYMAZ_VARSAYILAN['fuel_l'])   # elektrikliden yakıtlıya geçiş: depo tip varsayılanı
    return out


def kayit_oku(d):
    """drones satırı → etkin güç ayarı + ölçümler: {…tam ayar, defaults: bool, measured: {fuel_km_per_l, elec_w, at} | None}."""
    tip = d.get('type')
    ham = None
    try:
        ham = json.loads(d['power']) if d.get('power') else None
    except (TypeError, ValueError):
        ham = None
    if not isinstance(ham, dict):
        out = varsayilan(tip, d.get('model_key'))
        out['defaults'] = True
        out['measured'] = None
        return out
    try:
        out = dogrula(tip, {k: ham.get(k) for k in GIRIS_ALANLARI if k in ham}, varsayilan(tip, d.get('model_key')))
    except GucHata:   # bozuk/eski kayıt: varsayılana düş (kayıt değiştirilmez)
        out = varsayilan(tip, d.get('model_key'))
    out['defaults'] = False
    m = {k: ham.get(k) for k in OLCUM_ALANLARI if ham.get(k) is not None}
    out['measured'] = {'fuel_km_per_l': m.get('fuel_km_per_l_last'), 'elec_w': m.get('elec_w_last'), 'at': m.get('measured_at')} if m else None
    if out['measured'] and out['engine'] != 'fuel':
        out['measured']['fuel_km_per_l'] = None
    return out


def kayit_json(ayar, onceki_ham=None):
    """drones.power sütununa yazılacak JSON: giriş alanları + (varsa) önceki ölçümler korunur."""
    out = {k: ayar.get(k) for k in GIRIS_ALANLARI}
    for k in OLCUM_ALANLARI:
        if isinstance(onceki_ham, dict) and onceki_ham.get(k) is not None:
            out[k] = onceki_ham[k]
    return json.dumps(out)


def ham(d):
    try:
        v = json.loads(d['power']) if d.get('power') else None
    except (TypeError, ValueError):
        v = None
    return v if isinstance(v, dict) else None


def ucus_power(d, govde=None):
    """Uçuş açılışı: hangar ayarı + sihirbaz gövdesi (aynı kurallar) → (çekirdek power sözlüğü [ALANLAR], tam ayar [engine dâhil])."""
    taban = kayit_oku(d)
    ayar = dogrula(d.get('type'), govde or {}, {k: taban.get(k) for k in GIRIS_ALANLARI})
    core = {k: ayar.get(k) for k in ALANLAR}
    return core, ayar


def olcum_yaz(conn, drone_id, user_id, ozet):
    """Uçuş sonu: GucDurumu özeti → geçerli ölçümler (P.drona_yazilacaklar) dron kaydına. Dron silinmiş / başkasının → yazılmaz. Dönüş: yazılanlar."""
    yaz = P.drona_yazilacaklar(ozet)
    if not yaz or drone_id is None:
        return {}
    r = conn.execute('SELECT id, type, model_key, power FROM drones WHERE id = ? AND user_id = ?', (int(drone_id), int(user_id))).fetchone()
    if not r:
        return {}
    d = dict(r)
    h = ham(d)
    if h is None:   # varsayılanla çalışan dron: varsayılan ayar kalıcılaşır + ölçüm
        h = {k: v for k, v in varsayilan(d['type'], d['model_key']).items() if k in GIRIS_ALANLARI}
    out = {}
    if 'fuel_km_per_l_last' in yaz and SINIRLAR['fuel_km_per_l'][0] <= yaz['fuel_km_per_l_last'] <= SINIRLAR['fuel_km_per_l'][1]:
        out['fuel_km_per_l_last'] = round(float(yaz['fuel_km_per_l_last']), 2)
    if 'elec_w_last' in yaz and SINIRLAR['elec_w'][0] <= yaz['elec_w_last'] <= SINIRLAR['elec_w'][1]:
        out['elec_w_last'] = round(float(yaz['elec_w_last']), 1)
    if not out:
        return {}
    h.update(out)
    h['measured_at'] = datetime.now().isoformat(timespec='seconds')
    conn.execute('UPDATE drones SET power = ? WHERE id = ?', (json.dumps(h), d['id']))
    return out


def api_bilgisi(max_speedup):
    """Katalog/meta: sınırlar, motor türleri, yakıt tipleri, hız seçenekleri (sunucu üst sınırıyla), stok SITL tam gaz hızı."""
    return {'limits': {k: list(v) for k, v in SINIRLAR.items()}, 'engines': list(ENGINES), 'fuel_types': list(YAKIT_TIPLERI), 'fuel_min_l': YAKIT_MIN_L,
            'speedups': [x for x in P.SPEEDUPS if x <= max_speedup], 'max_speedup': max_speedup, 'stock_max_ms': round(P.plane_tam_gaz_hizi(), 1),
            'cell_v': P.HUCRE_V}
