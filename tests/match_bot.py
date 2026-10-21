"""§33 testleri ve görsel betikler için "rota pilotu": sahte kinematiğin (HEPGO_SITL=0) adımını değiştirip aracı halkaların içinden sırayla
geçirir (her halkanın normali boyunca 35 m önünden merkezine, 35 m arkasına). Yalnız test aracıdır; sunucu kodunda kullanılmaz."""
import math

from app import flightsim_match_core as core


def rota_noktalari(halkalar, merkez, bas=None, pay=35.0):
    """[(x, y, z_agl)] — başlangıçtan (bas: (x, y)) her halkanın önüne, içinden, arkasına."""
    zemin = float(merkez.get('alt') or 0)
    pts = [(bas[0], bas[1], 0.0)] if bas else []
    for h in halkalar:
        z = h['alt_msl'] - zemin
        pts.append((h['x'] - h['nx'] * pay, h['y'] - h['ny'] * pay, z))
        pts.append((h['x'], h['y'], z))
        pts.append((h['x'] + h['nx'] * pay, h['y'] + h['ny'] * pay, z))
    return pts


def rota_pilotu(s, halkalar, merkez, hiz=60.0, kadar=None):
    """Oturumun sahte kinematiğini rota boyunca uçurur (hiz m/s; ARM'lı sayılır). kadar: yalnız ilk N halka (sonra son noktada askıda)."""
    k = s.sahte
    bx, by = core.enu(merkez['lat'], merkez['lon'], k.lat0, k.lon0)
    pts = rota_noktalari(halkalar[:kadar] if kadar else halkalar, merkez, (bx, by))
    st = {'i': 1, 'p': list(pts[0])}

    def adim(dt):
        k.sure_ms += dt * 1000
        k.armed, k.mode = True, 'GUIDED'
        kalan = hiz * dt
        while kalan > 0 and st['i'] < len(pts):
            hx, hy, hz = pts[st['i']]
            dx, dy, dz = hx - st['p'][0], hy - st['p'][1], hz - st['p'][2]
            d = math.sqrt(dx * dx + dy * dy + dz * dz)
            if d <= kalan:
                st['p'] = [hx, hy, hz]
                st['i'] += 1
                kalan -= d
            else:
                f = kalan / d
                st['p'] = [st['p'][0] + dx * f, st['p'][1] + dy * f, st['p'][2] + dz * f]
                k.yaw = math.atan2(dx, dy)
                k.vn, k.ve = dy / d * hiz, dx / d * hiz
                kalan = 0
        lat, lon = core.latlon(merkez['lat'], merkez['lon'], st['p'][0], st['p'][1])
        k.lat, k.lon, k.alt_rel = lat, lon, st['p'][2]
        if st['i'] >= len(pts):
            k.vn = k.ve = 0.0
    k.adim = adim
    return st


def it_pilotu(s, merkez, yon_deg, bas, hiz=10.0, alt=40.0, gecikme_m=0.0, takip=None):
    """§41 it dalaşı test pilotu (yalnız sahte kinematik): araç `bas` (x, y) noktasından `yon_deg` doğrultusunda `alt` irtifada `hiz` ile düz uçar.
    `takip` (başka pilotun durum sözlüğü) verilirse onun `gecikme_m` gerisinde, ona dönük uçar (kovalayan). Dönüş: durum {'p': [x, y, z]}."""
    k = s.sahte
    h = math.radians(yon_deg)
    st = {'p': [bas[0], bas[1], 0.0], 'yaw': h}

    def adim(dt):
        k.sure_ms += dt * 1000
        k.armed, k.mode = True, 'GUIDED'
        if takip is not None:
            tx, ty, tz = takip['p']
            st['p'] = [tx - math.sin(h) * gecikme_m, ty - math.cos(h) * gecikme_m, tz]
            st['yaw'] = math.atan2(tx - st['p'][0], ty - st['p'][1])
        else:
            st['p'] = [st['p'][0] + math.sin(h) * hiz * dt, st['p'][1] + math.cos(h) * hiz * dt, min(alt, st['p'][2] + 8.0 * dt)]
        lat, lon = core.latlon(merkez['lat'], merkez['lon'], st['p'][0], st['p'][1])
        k.lat, k.lon, k.alt_rel = lat, lon, st['p'][2]
        k.yaw, k.pitch = st['yaw'], 0.0
        k.vn, k.ve = math.cos(h) * hiz, math.sin(h) * hiz
    k.adim = adim
    return st
