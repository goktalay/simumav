"""HANGAR donanımı (yol haritası "Hangar"): kamera türü, eklentiler (ilaçlama / paket bırakma / paraşüt), görünüm (renk, desen, logo/çıkartma),
azami irtifa — `drones.equipment` JSON (v8). NULL = gündüz kamerası, eklenti yok.

SITL karşılığı (ArduPilot; uçuş açılışında dronun parametrelerine SUNUCU ekler, kullanıcı beyaz listesine girmez):
  · sprayer   → SPRAY_ENABLE=1, SERVO9_FUNCTION=22 (SprayerPump), SERVO10_FUNCTION=23 (SprayerSpinner) [+ SPRAY_PUMP_RATE] — yalnız ArduCopter
  · gripper   → GRIP_ENABLE=1, GRIP_TYPE=1 (servo), SERVO11_FUNCTION=28 (Gripper)
  · parachute → CHUTE_ENABLED=1, CHUTE_TYPE=10 (servo), SERVO12_FUNCTION=27 (Parachute) [+ CHUTE_ALT_MIN] — Copter / Plane
İnce ayar (SPRAY_*, GRIP_*, CHUTE_* öneki) kullanıcı parametresi olarak beyaz listededir; Mission Planner'dan değiştirilenler uçuş sonunda
kalıcı kayda alınır (bridge.params_hasat). Kamera: çekirdek day | night | thermal | none; `multispectral` çekirdekte 'day' olarak koşar,
istemci renk bantlarını kendisi işler (NDVI benzeri görünüm)."""
import re

CAMERAS = ('day', 'night', 'thermal', 'multispectral')
CAMERA_CORE = {'day': 'day', 'night': 'night', 'thermal': 'thermal', 'multispectral': 'day'}
PATTERNS = ('solid', 'stripe', 'split', 'camo', 'checker')
DECAL_SLOTS = ('top', 'bottom', 'left', 'right', 'front', 'rear', 'tail')
DECAL_MAX = 6
_RENK = re.compile(r'^#[0-9a-fA-F]{6}$')
_CAGRI = re.compile(r'^[A-Z0-9-]{1,8}$')
KOPTER = ('multirotor', 'fpv', 'heli')
UCAN = ('multirotor', 'fpv', 'heli', 'plane', 'interceptor', 'vtol')
ADDONS = {
    'sprayer': {'label': {'tr': 'İlaçlama aparatı', 'en': 'Sprayer'}, 'types': KOPTER,
                'options': {'tank_l': (1.0, 40.0, 10.0), 'width_m': (1.0, 12.0, 4.0), 'pump_rate': (0.0, 100.0, 10.0)},
                'params': {'SPRAY_ENABLE': 1, 'SERVO9_FUNCTION': 22, 'SERVO10_FUNCTION': 23}},
    'gripper': {'label': {'tr': 'Paket bırakma aparatı', 'en': 'Package release (gripper)'}, 'types': UCAN + ('rover',),
                'options': {'payload_kg': (0.1, 20.0, 1.0)},
                'params': {'GRIP_ENABLE': 1, 'GRIP_TYPE': 1, 'SERVO11_FUNCTION': 28}},
    'parachute': {'label': {'tr': 'Paraşüt', 'en': 'Parachute'}, 'types': UCAN,
                  'options': {'alt_min_m': (0.0, 100.0, 10.0)},
                  'params': {'CHUTE_ENABLED': 1, 'CHUTE_TYPE': 10, 'SERVO12_FUNCTION': 27}},
}
SABIT_PARAMLAR = frozenset(k for a in ADDONS.values() for k in a['params'])   # kullanıcı kaydına hasat edilmez (eklenti açık/kapalı sunucuda)
MAX_ALT = (10.0, 5000.0)
DEFAULT = {'camera': 'day', 'addons': {}, 'livery': {'pattern': 'solid', 'color2': None, 'callsign': None, 'decals': []}, 'max_alt_m': None}


class DonanimHata(ValueError):
    pass


def _sayi(v, lo, hi, ad):
    if isinstance(v, bool) or not isinstance(v, (int, float)) or v != v or not (lo <= v <= hi):
        raise DonanimHata(f'{ad} {lo:g}…{hi:g} olmalı')
    return float(v)


def dogrula(tip, eq, decal_ids=()):
    """Gövde → normalize. Bilinmeyen anahtar, tipe uymayan eklenti, sınır dışı değer, sahibi olmadığı çıkartma → DonanimHata."""
    if eq is None:
        return None
    if not isinstance(eq, dict):
        raise DonanimHata('equipment bir nesne olmalı')
    fazla = set(eq) - set(DEFAULT)
    if fazla:
        raise DonanimHata(f'equipment bilinmeyen alan: {sorted(fazla)[0]}')
    out = {'camera': 'day', 'addons': {}, 'livery': dict(DEFAULT['livery'], decals=[]), 'max_alt_m': None}
    cam = eq.get('camera', 'day')
    if cam not in CAMERAS:
        raise DonanimHata(f"camera {' | '.join(CAMERAS)} olmalı")
    out['camera'] = cam
    ad = eq.get('addons') or {}
    if not isinstance(ad, dict):
        raise DonanimHata('addons bir nesne olmalı')
    for k, v in ad.items():
        if k not in ADDONS:
            raise DonanimHata(f"addons {' | '.join(ADDONS)} olabilir")
        if v in (None, False):
            continue
        if tip not in ADDONS[k]['types']:
            raise DonanimHata(f"{ADDONS[k]['label']['tr']} bu araç tipine takılamaz")
        v = {} if v is True else v
        if not isinstance(v, dict):
            raise DonanimHata(f'addons.{k} nesne ya da true olmalı')
        sec = {}
        for ok, (lo, hi, df) in ADDONS[k]['options'].items():
            sec[ok] = _sayi(v.get(ok, df), lo, hi, f'addons.{k}.{ok}')
        if set(v) - set(ADDONS[k]['options']):
            raise DonanimHata(f'addons.{k} bilinmeyen alan')
        out['addons'][k] = sec
    lv = eq.get('livery') or {}
    if not isinstance(lv, dict) or set(lv) - set(DEFAULT['livery']):
        raise DonanimHata('livery {pattern, color2, callsign, decals}')
    if lv.get('pattern', 'solid') not in PATTERNS:
        raise DonanimHata(f"livery.pattern {' | '.join(PATTERNS)} olmalı")
    out['livery']['pattern'] = lv.get('pattern', 'solid')
    if lv.get('color2') is not None:
        if not isinstance(lv['color2'], str) or not _RENK.match(lv['color2']):
            raise DonanimHata('livery.color2 #rrggbb olmalı')
        out['livery']['color2'] = lv['color2'].lower()
    if lv.get('callsign'):
        cs = str(lv['callsign']).strip().upper()
        if not _CAGRI.match(cs):
            raise DonanimHata('livery.callsign 1–8 karakter A–Z 0–9 -')
        out['livery']['callsign'] = cs
    dec = lv.get('decals') or []
    if not isinstance(dec, list) or len(dec) > DECAL_MAX:
        raise DonanimHata(f'livery.decals en çok {DECAL_MAX}')
    izin = set(decal_ids)
    for d in dec:
        if not isinstance(d, dict) or set(d) - {'id', 'slot', 'scale', 'rot'}:
            raise DonanimHata('livery.decals[] {id, slot, scale, rot}')
        if d.get('id') not in izin:
            raise DonanimHata('livery.decals[].id bu dronun yüklenmiş çıkartmalarından biri olmalı')
        if d.get('slot', 'top') not in DECAL_SLOTS:
            raise DonanimHata(f"livery.decals[].slot {' | '.join(DECAL_SLOTS)} olmalı")
        out['livery']['decals'].append({'id': int(d['id']), 'slot': d.get('slot', 'top'), 'scale': _sayi(d.get('scale', 1.0), 0.2, 2.0, 'scale'),
                                        'rot': _sayi(d.get('rot', 0.0), 0.0, 360.0, 'rot')})
    if eq.get('max_alt_m') is not None:
        out['max_alt_m'] = _sayi(eq['max_alt_m'], MAX_ALT[0], MAX_ALT[1], 'max_alt_m')
    return out


def oku(raw):
    """DB değeri → normalize sözlük (bozuk/NULL → varsayılan)."""
    import json
    try:
        d = json.loads(raw) if raw else None
    except (TypeError, ValueError):
        d = None
    if not isinstance(d, dict):
        return {'camera': 'day', 'addons': {}, 'livery': dict(DEFAULT['livery'], decals=[]), 'max_alt_m': None}
    base = {'camera': 'day', 'addons': {}, 'livery': dict(DEFAULT['livery'], decals=[]), 'max_alt_m': None}
    base.update({k: d[k] for k in base if k in d})
    return base


def sitl_params(tip, eq):
    """Eklentilerin SITL parametreleri (sunucu üretir). Sprayer yalnız kopter ailesinde."""
    p = {}
    for k, v in (eq or {}).get('addons', {}).items():
        a = ADDONS.get(k)
        if not a or tip not in a['types']:
            continue
        p.update(a['params'])
        if k == 'sprayer':
            p['SPRAY_PUMP_RATE'] = float(v.get('pump_rate', 10.0))
        if k == 'parachute':
            p['CHUTE_ALT_MIN'] = float(v.get('alt_min_m', 10.0))
    return {k: float(v) for k, v in p.items()}


def katalog():
    return {'cameras': list(CAMERAS), 'camera_core': CAMERA_CORE, 'patterns': list(PATTERNS), 'decal_slots': list(DECAL_SLOTS), 'decal_max': DECAL_MAX,
            'addons': {k: {'label': a['label'], 'types': list(a['types']), 'options': {o: {'min': lo, 'max': hi, 'default': df} for o, (lo, hi, df) in a['options'].items()},
                           'sitl_params': a['params']} for k, a in ADDONS.items()},
            'max_alt_m': list(MAX_ALT), 'default': DEFAULT}
