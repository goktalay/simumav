"""Uçuş Simülatörü §27 — INTERCEPTOR fırlatıcıları (sunucu tarafı saf mantık; istemci eşleniği static/js/modules/flightsim_launcher.js).

Yöntemler (`world.launch.method`, yalnız INTERCEPTOR'da anlamlı; sabit kanatta wheels | ramp | vehicle §13):
  pod4 (4 hücreli kutu) · pod8 (8 hücreli kutu) · tube (yerden tekli tüp) · handheld (pilot elinde silah benzeri aparat + nişangâh ekranı).
Ek alanlar (`launch_dogrula` doğrular; tip zorlaması yok — sınırlar):
  loaded       — dolu hücre (1…hücre sayısı; görevsiz uçuşta; "Yer kontrolünü koru"da envanter görevin interceptor sayısıdır)
  aim_az_deg   — el fırlatıcısı nişan yönü (0…360, gerçek kuzeyden saat yönü)
  aim_el_deg   — el fırlatıcısı nişan açısı (10…85°)
Kalkış (`cmd takeoff {alt, aim?}`): tüm fırlatıcılarda GUIDED + ARM + NAV_TAKEOFF (VTOL; kuyruk üstünden dikey) + WS `launch` aşamaları
(armed → launch → released). El fırlatıcısında NAV_TAKEOFF HAND_CLIMB_M'ye, ardından nişan noktasına (aim_noktasi) DO_REPOSITION → ArduPlane
sabit kanada geçip nişan doğrultusunda uçar.
"""
import math

ICEPT_LAUNCHERS = {'pod4': 4, 'pod8': 8, 'tube': 1, 'handheld': 1}   # yöntem → hücre sayısı
ICEPT_METHODS = tuple(ICEPT_LAUNCHERS)
AIM_AZ = (0.0, 360.0)
AIM_EL = (10.0, 85.0)
AIM_DEFAULTS = {'aim_az_deg': 0.0, 'aim_el_deg': 55.0}
HAND_CLIMB_M = 8.0
AIM_PATH_M = 500.0
AIM_ALT = (30.0, 350.0)
AIM_MIN_H = 120.0
RELEASE_AGL_M = 1.5          # `released`: AGL ≥ 1,5 m (dron hücreden/tüpten çıktı)


class LauncherHata(ValueError):
    pass


def firlatici_mi(method):
    return method in ICEPT_LAUNCHERS


def _sayi(v, ad, alt, ust):
    if isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(float(v)) or not (alt <= v <= ust):
        raise LauncherHata(f'world.launch.{ad} {alt:g}…{ust:g} arasında olmalı')
    return float(v)


def ek_alanlar(l, method):
    """`world.launch` fırlatıcı alanları (loaded, aim_az_deg, aim_el_deg): verilmişse doğrulanır; yöntem fırlatıcıysa eksikler varsayılanla dolar.
    Dönüş: eklenecek sözlük (sabit kanat yönteminde ve alan verilmemişse boş — eski gövdeler birebir aynı kalır)."""
    out = {}
    if l.get('loaded') is not None:
        v = l['loaded']
        if isinstance(v, bool) or not isinstance(v, int) and not (isinstance(v, float) and v.is_integer()):
            raise LauncherHata('world.launch.loaded tam sayı olmalı')
        ust = ICEPT_LAUNCHERS.get(method, 8)
        out['loaded'] = int(_sayi(v, 'loaded', 1, ust))
    if l.get('aim_az_deg') is not None:
        out['aim_az_deg'] = _sayi(l['aim_az_deg'], 'aim_az_deg', *AIM_AZ) % 360.0
    if l.get('aim_el_deg') is not None:
        out['aim_el_deg'] = _sayi(l['aim_el_deg'], 'aim_el_deg', *AIM_EL)
    if method in ICEPT_LAUNCHERS:
        if ICEPT_LAUNCHERS[method] > 1:
            out.setdefault('loaded', ICEPT_LAUNCHERS[method])
        if method == 'handheld':
            for k, v in AIM_DEFAULTS.items():
                out.setdefault(k, v)
    return out


def aim_dogrula(aim):
    """`cmd takeoff` `aim: {az_deg, el_deg}` (el fırlatıcısı canlı nişanı). Dönüş (az, el) ya da None."""
    if aim is None:
        return None
    if not isinstance(aim, dict):
        raise LauncherHata('takeoff.aim nesne olmalı')
    az = _sayi(aim.get('az_deg'), 'aim.az_deg', *AIM_AZ) % 360.0
    el = _sayi(aim.get('el_deg'), 'aim.el_deg', *AIM_EL)
    return az, el


def aim_noktasi(az_deg, el_deg):
    """Nişan noktası (eve göre doğu/kuzey/irtifa, m): AIM_PATH_M yol boyu ışın üzerinde; irtifa 30…350, yatay ≥ 120 (istemci aimWaypoint ile birebir)."""
    az = float(az_deg) % 360.0
    el = max(AIM_EL[0], min(AIM_EL[1], float(el_deg)))
    alt = max(AIM_ALT[0], min(AIM_ALT[1], AIM_PATH_M * math.sin(math.radians(el))))
    hz = max(AIM_MIN_H, alt / math.tan(math.radians(el)))
    return {'east_m': round(hz * math.sin(math.radians(az)), 2), 'north_m': round(hz * math.cos(math.radians(az)), 2), 'alt_m': round(alt, 2), 'horiz_m': round(hz, 2)}


def enlem_boylam(lat0, lon0, east_m, north_m):
    """Yerel ENU ofseti → enlem/boylam (küçük uzaklık; flightsim yerel çerçevesiyle aynı yaklaşım)."""
    return lat0 + north_m / 110574.0, lon0 + east_m / (111320.0 * math.cos(math.radians(lat0)))


def firlatici_sayisi(method, toplam):
    if method in ('pod4', 'pod8'):
        return max(1, math.ceil(max(1, int(toplam)) / ICEPT_LAUNCHERS[method]))
    return 1 if method in ICEPT_LAUNCHERS else 0


def etiket(launch):
    """Kısa etiket (olay satırı, rapor): 'Fırlatıcı 4'lü (3/4)' · 'El fırlatıcısı 45° / 120°' …"""
    m = (launch or {}).get('method')
    if m == 'pod4' or m == 'pod8':
        return f"{ICEPT_LAUNCHERS[m]}'lü fırlatıcı ({int((launch or {}).get('loaded') or ICEPT_LAUNCHERS[m])} dolu)"
    if m == 'tube':
        return 'Yerden tekli tüp'
    if m == 'handheld':
        return f"El fırlatıcısı {round(float(launch.get('aim_el_deg') or 55))}° / {round(float(launch.get('aim_az_deg') or 0))}°"
    return m or 'wheels'
