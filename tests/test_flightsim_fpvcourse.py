"""§47 HAZIR FPV PARKURLARI — saf çekirdek testleri (`app/flightsim_fpv.py` + `flightsim_match_core` FPV türü + `flightsim_match_bot.parkur_adim`).

Çalıştır: .venv/bin/python -m tests.test_flightsim_fpvcourse
  · kapı geçiş algılama: yön (ileri/ters), düzlem kesişimi, açıklık (kare/daire/dikdörtgen), yatay dalış kapısı, bayrak sanal kapısı
  · ilkel engel çarpışması (delikli kutu: pencere / tünel / döşeme boşluğu, silindir, küre, boru, torus) ve doğru parçası örneklemesi
  · tur / sektör hesabı, kaçırılan kapı cezası (ileri bakış), çarpma kuralları (ceza / sıfırla / devam), hayalet örnekleri
  · hayalet kodlama/çözme (nicemleme sınırı, yaw sarması, boyut)
  · 8 parkur tanımının doğrulanması (açıklık engelsiz, yarış hattı engelsiz, başlangıç → bitiş sıralı, başlangıç noktaları serbest)
  · sahte kinematikle her parkurun yapay zekâ pilotla uçtan uca tamamlanması (Zor < Normal < Kolay)
  · Karsilasma FPV: tek kişilik zaman denemesi (tamamlandi), çok oyunculu (son çağrı, ceza dahil sıralama), it dalaşı tek kişilik olamaz
"""
import math
import sys

from app import flightsim_fpv as F
from app import flightsim_match_bot as B
from app import flightsim_match_core as core

MERKEZ = {'lat': 39.9, 'lon': 32.8, 'alt': 900.0}


def yaklas(a, b, e=1e-6):
    return abs(a - b) <= e


def kapi_testleri():
    g = {'kind': 'gate', 'x': 0, 'y': 0, 'z': 2, 'yaw': 0, 'w': 3, 'h': 2}
    assert F.kapi_kesisim((0, -1, 2), (0, 1, 2), g)[:2] == ('ileri', True)
    assert F.kapi_kesisim((0, 1, 2), (0, -1, 2), g)[:2] == ('ters', True)
    assert F.kapi_kesisim((1.6, -1, 2), (1.6, 1, 2), g)[:2] == ('ileri', False)          # yanından (w/2 = 1,5)
    assert F.kapi_kesisim((1.4, -1, 2.9), (1.4, 1, 2.9), g)[:2] == ('ileri', True)       # köşe içinde
    assert F.kapi_kesisim((0, -1, 3.1), (0, 1, 3.1), g)[:2] == ('ileri', False)          # üstünden (h/2 = 1)
    assert F.kapi_kesisim((0, -3, 2), (0, -1, 2), g)[0] is None                          # düzleme varmadı
    # kesişim noktası: eğik geçişte doğru ara değer (z 1 → 3 ortada 2)
    y, ic, d = F.kapi_kesisim((0, -1, 1), (0, 1, 3), g)
    assert y == 'ileri' and ic and yaklas(d, 0.0)
    # yaw 90 (doğuya geçiş)
    g2 = {**g, 'yaw': 90}
    assert F.kapi_kesisim((-1, 0, 2), (1, 0, 2), g2)[:2] == ('ileri', True)
    assert F.kapi_kesisim((-1, 1.6, 2), (1, 1.6, 2), g2)[:2] == ('ileri', False)
    # daire
    c = {'kind': 'circle', 'x': 0, 'y': 0, 'z': 3, 'yaw': 0, 'r': 1.5, 'w': 3, 'h': 3}
    assert F.kapi_kesisim((1.0, -1, 4.0), (1.0, 1, 4.0), c)[:2] == ('ileri', True)        # √2 < 1,5
    assert F.kapi_kesisim((1.2, -1, 4.2), (1.2, 1, 4.2), c)[:2] == ('ileri', False)       # kare içinde ama daire dışında (1,7 > 1,5)
    # dalış kapısı (yatay; yukarıdan aşağı)
    d_ = {'kind': 'dive', 'x': 5, 'y': 5, 'z': 6, 'yaw': 0, 'w': 3, 'h': 3}
    n, u, v = F.kapi_eksenleri(d_)
    assert n == (0.0, 0.0, -1.0)
    assert F.kapi_kesisim((5, 5, 7), (5, 5, 5), d_)[:2] == ('ileri', True)
    assert F.kapi_kesisim((5, 5, 5), (5, 5, 7), d_)[:2] == ('ters', True)               # aşağıdan yukarı ters
    assert F.kapi_kesisim((6.6, 5, 7), (6.6, 5, 5), d_)[:2] == ('ileri', False)
    assert F.kapi_kesisim((5, 6.4, 7), (5, 6.4, 5), d_)[:2] == ('ileri', True)            # h ileri ekseni boyunca 1,5
    # bayrak: direğin sağından geçen sanal kapı (direk engel)
    K = F._Kurucu('t', 't')
    fl = K.bayrak(0, 0, 0, 'right', w=10, h=6)
    assert fl['x'] > 5 and yaklas(fl['y'], 0) and K.obstacles[-1]['t'] == 'cyl'
    assert F.kapi_kesisim((3, -1, 2), (3, 1, 2), fl)[:2] == ('ileri', True)
    assert F.kapi_kesisim((-3, -1, 2), (-3, 1, 2), fl)[:2] == ('ileri', False)           # solundan geçen sayılmaz
    print('  kapı geçiş algılama geçti')


def engel_testleri():
    duvar = {'t': 'box', 'x': 0, 'y': 0, 'z': 0, 'w': 10, 'd': 0.4, 'h': 4, 'yaw': 0, 'holes': [{'u': 2, 'v': 1.5, 'w': 2, 'h': 2}], 'axis': 'y'}
    assert F.engel_icinde((0, 0, 1), duvar, 0) and not F.engel_icinde((2, 0, 1.5), duvar, 0)     # pencerede boşluk
    assert F.engel_icinde((2.9, 0, 1.5), duvar, 0.25)                                               # şişirilmiş: kenara 0,1 m
    assert not F.engel_icinde((0, 0.5, 1), duvar, 0.0) and F.engel_icinde((0, 0.5, 1), duvar, 0.35)
    doseme = {'t': 'box', 'x': 0, 'y': 0, 'z': 3, 'w': 10, 'd': 10, 'h': 0.3, 'yaw': 0, 'holes': [{'u': 2, 'v': -2, 'w': 3, 'h': 3}], 'axis': 'z'}
    assert F.engel_icinde((0, 0, 3.1), doseme, 0) and not F.engel_icinde((2, -2, 3.1), doseme, 0)
    donuk = {'t': 'box', 'x': 0, 'y': 0, 'z': 0, 'w': 4, 'd': 1, 'h': 2, 'yaw': 90}   # yaw 90: w ekseni güneye (sağ = (0,−1))
    assert F.engel_icinde((0, 1.9, 1), donuk, 0) and not F.engel_icinde((1.9, 0, 1), donuk, 0)
    assert F.engel_icinde((0.3, 0.4, 1.0), {'t': 'cyl', 'x': 0, 'y': 0, 'z': 0, 'r': 0.5, 'h': 3}, 0)
    assert not F.engel_icinde((0, 0, 3.3), {'t': 'cyl', 'x': 0, 'y': 0, 'z': 0, 'r': 0.5, 'h': 3}, 0.25)
    assert F.engel_icinde((1, 1, 1), {'t': 'sph', 'x': 0, 'y': 0, 'z': 0, 'r': 1.8}, 0)
    boru = {'t': 'pipe', 'a': [0, 0, 3], 'b': [10, 0, 3], 'r': 0.4}
    assert F.engel_icinde((5, 0.3, 3.2), boru, 0) and not F.engel_icinde((5, 0, 2.3), boru, 0.25) and not F.engel_icinde((11, 0, 3), boru, 0.25)
    tor = {'t': 'torus', 'x': 0, 'y': 0, 'z': 3, 'yaw': 0, 'R': 1.6, 'tube': 0.15}
    assert F.engel_icinde((1.6, 0, 3), tor, 0) and not F.engel_icinde((0, 0, 3), tor, 0.25)
    W = F.EngelDunyasi([duvar, boru])
    assert W.parca((2, -2, 1.5), (2, 2, 1.5), 0.25) == (None, None)                                # pencereden geçiş serbest
    k, q = W.parca((0, -2, 1.5), (0, 2, 1.5), 0.25)
    assert k == 0 and q[1] < 0                                                                     # duvara çarpar
    assert W.parca((8, -2, 2.0), (8, 2, 2.0), 0.25)[0] is None and W.parca((8, -2, 3.0), (8, 2, 3.0), 0.25)[0] == 1
    # çerçeve ilkelleri: açıklığı engellemez, çerçeveyi engeller
    g = {'kind': 'gate', 'x': 0, 'y': 0, 'z': 3, 'yaw': 0, 'w': 3, 'h': 2, 'frame': True}
    fr = F.EngelDunyasi(F.kapi_engelleri(g), 0)
    assert fr.nokta((0, 0, 3)) is None and fr.nokta((1.6, 0, 3)) is not None and fr.nokta((1.62, 0, 0.5)) is not None   # ayak
    print('  ilkel engel çarpışması geçti')


def izleyici_kur(cid='hangar', **kw):
    cfg = F.fpv_ayar_dogrula({'course_id': cid, **kw}, 'multirotor')
    N = F.kontrol_noktalari(cfg, MERKEZ)
    return cfg, N, F.ParkurIzleyici(N, cfg, MERKEZ, 100.0)


def hattan(iz, h, t, yaw=0.0):
    """Kontrol noktasının yarış hattı parçası boyunca uç (doğrulanmış engelsiz çizgi); son nokta t anında."""
    pts = h['line']
    out = []
    for k, p in enumerate(pts):
        out += iz.konum(p[0], p[1], MERKEZ['alt'] + p[2], t - 0.05 * (len(pts) - 1 - k), yaw)
    return out


def carp(iz, t):
    """Hangar bölme duvarına (x = 0, y 4,5…18; pencere z 0,4…3,6) z = 6 m'de batıdan doğuya çarp (önce > 250 m ışınlanma: süreklilik kesilir)."""
    iz.konum(-5000, 0, MERKEZ['alt'] + 6, t - 0.2)
    return iz.konum(-2.0, 14, MERKEZ['alt'] + 6, t - 0.1) + iz.konum(2.0, 14, MERKEZ['alt'] + 6, t)


def gecir(iz, h, t, yaw=0.0, kacik=(0.0, 0.0)):
    """Kontrol noktasından doğru yönde geçir (önce 1 m geride, sonra 1 m ileride)."""
    n = (h['nx'], h['ny'], h['nz'])
    u = (n[1], -n[0], 0.0) if abs(n[2]) < 0.9 else (1.0, 0.0, 0.0)
    c = (h['x'] + u[0] * kacik[0], h['y'] + u[1] * kacik[0], h['z'] + kacik[1])
    a = [c[i] - n[i] * 1.0 for i in range(3)]
    b = [c[i] + n[i] * 1.0 for i in range(3)]
    return iz.konum(a[0], a[1], MERKEZ['alt'] + a[2], t - 0.05, yaw) + iz.konum(b[0], b[1], MERKEZ['alt'] + b[2], t, yaw)


def izleyici_testleri():
    cfg, N, iz = izleyici_kur('hangar', laps=2, miss_penalty_s=3, crash_penalty_s=2)
    m = F.parkur('hangar')['gate_count']
    assert len(N) == 1 + 2 * m and N[0]['lap'] == 0 and N[0]['gate'] == 0 and N[-1]['gate'] == 0 and N[-1]['lap'] == 2
    assert [h['i'] for h in N] == list(range(1, len(N) + 1))
    se = [h for h in N if h['lap'] == 1 and h['sector_end']]
    assert len(se) == F.parkur('hangar')['sectors'] and se[-1]['gate'] == 0                     # son sektör S/F'de kapanır
    assert sorted({h['sector'] for h in N if h['lap'] == 1}) == list(range(1, F.parkur('hangar')['sectors'] + 1))
    t = 110.0
    ev = hattan(iz, N[0], t)
    assert [e['kind'] for e in ev] == ['ring'] and iz.tur_t0 == t - 0.05 and iz.ara == [9.95], (ev, iz.tur_t0, iz.ara)
    # 1. tur: her kapı 2 sn arayla (yarış hattı boyunca)
    out = []
    for h in N[1:m + 1]:
        t += 2.0
        out += hattan(iz, h, t)
    laps = [e for e in out if e['kind'] == 'lap']
    secs = [e for e in out if e['kind'] == 'sector']
    assert len(laps) == 1 and yaklas(laps[0]['s'], 2.0 * m, 1e-3) and laps[0]['best'] and len(secs) == F.parkur('hangar')['sectors']
    assert yaklas(sum(e['s'] for e in secs), laps[0]['s'], 1e-3) and iz.tur == 2
    # 2. tur: bir kapıyı atla (sıradakinden sonraki geçilir) → kaçırma + ceza; bir engele çarp → ceza (penalty kuralı)
    t += 2.0
    h1 = N[m + 1]
    assert iz.konum(h1['x'] - h1['ny'] * 4, h1['y'] + h1['nx'] * 4, MERKEZ['alt'] + h1['z'], t - 1.0) == []   # kapının yanından (açıklık dışından) geç
    out = hattan(iz, N[m + 2], t)                                                           # N[m+1] atlandı
    assert [e['kind'] for e in out][:2] == ['miss', 'ring'] and iz.ceza == 3.0 and iz.kacan == [N[m + 1]['i']], (out, iz.ceza, iz.kacan, iz.carpma)
    son = N[m + 2]['line'][-1]
    out = carp(iz, t + 0.5)
    hit = [e for e in out if e['kind'] == 'hit']
    assert len(hit) == 1 and hit[0]['rule'] == 'penalty' and hit[0]['mat'] == 'block' and iz.ceza == 5.0 and iz.carpma == 1, out
    assert not [e for e in iz.konum(2.6, 14, MERKEZ['alt'] + 6.0, t + 0.7) if e['kind'] == 'hit']   # temas bitti; aynı temas tekrar sayılmaz
    iz.konum(5000, 0, MERKEZ['alt'] + 6, t + 0.8)
    out = iz.konum(son[0], son[1], MERKEZ['alt'] + son[2], t + 0.85) + iz.konum(son[0], son[1] + 0.01, MERKEZ['alt'] + son[2], t + 0.9)   # ışınlanma: sayılmaz
    for h in N[m + 3:]:
        t += 2.0
        out = hattan(iz, h, t)
    assert out[-1]['kind'] == 'finish' and iz.bitti and yaklas(iz.toplam(), t - 0.05 - 100.0 + 5.0, 1e-3), (out, iz.toplam(), t)
    oz = iz.ozet()
    assert oz['laps_done'] == 2 and oz['misses'] == 1 and oz['hits'] == 1 and oz['pen_s'] == 5.0 and len(oz['splits']) == len(N)
    assert oz['best_lap_s'] == min(oz['lap_times']) and len(oz['sectors']) == 2 and len(iz.ornekler) > 10
    # ters yön uyarısı + sıfırla / devam kuralları
    cfg2, N2, iz2 = izleyici_kur('hangar', crash_rule='reset')
    h = N2[0]
    ev = iz2.konum(h['x'] + 1, h['y'], MERKEZ['alt'] + h['z'], 1) + iz2.konum(h['x'] - 1, h['y'], MERKEZ['alt'] + h['z'], 1.1)
    assert [e['kind'] for e in ev] == ['wrong_way'], ev
    ev = carp(iz2, 2)
    assert [e['kind'] for e in ev] == ['hit', 'reset'] and iz2.ceza == 0
    _, _, iz3 = izleyici_kur('hangar', crash_rule='continue')
    ev = carp(iz3, 2)
    assert [e['kind'] for e in ev] == ['hit'] and iz3.ceza == 0 and iz3.carpma == 1
    # sıçrama (> 250 m) geçiş/çarpma sayılmaz
    _, N4, iz4 = izleyici_kur('hangar')
    h = N4[0]
    assert iz4.konum(h['x'] - 400, h['y'], MERKEZ['alt'] + h['z'], 1) + iz4.konum(h['x'] + 1, h['y'], MERKEZ['alt'] + h['z'], 1.1) == []
    print('  tur / sektör / ceza / kural geçti')


def hayalet_testleri():
    ornek = []
    for k in range(600):   # 60 sn × 10 Hz; yaw 0 ↔ 2π sarması dahil
        t = k * 0.1
        ornek.append((round(t, 2), 30 * math.sin(t / 5), 20 * math.cos(t / 7), 2 + math.sin(t), (t * 0.9) % (2 * math.pi) - math.pi, 0.4 * math.sin(t), -0.2 * math.cos(t)))
    s = F.hayalet_kodla(ornek)
    assert s.startswith('g1.') and len(s) < 12000, len(s)
    c = F.hayalet_coz(s)
    assert len(c) == len(ornek)
    for a, b in zip(ornek, c):
        assert abs(a[0] - b[0]) <= 0.006 and all(abs(a[i] - b[i]) <= 0.011 for i in (1, 2, 3)) and all(abs(a[i] - b[i]) <= 0.0011 for i in (5, 6)), (a, b)
        dy = (a[4] - b[4] + math.pi) % (2 * math.pi) - math.pi
        assert abs(dy) <= 0.002, (a[4], b[4])
    assert F.hayalet_coz(F.hayalet_kodla([])) == []
    try:
        F.hayalet_coz('x1.abc')
        assert False
    except F.FpvHata:
        pass
    print(f'  hayalet kodlama geçti ({len(s)} karakter / 600 örnek)')


def parkur_testleri():
    assert len(F.PARKUR_IDLER) >= 6 and {'hangar', 'forest', 'city', 'stadium', 'refinery', 'canyon', 'woodframe', 'concrete'} <= set(F.PARKUR_IDLER)
    turler = set()
    for cid in F.PARKUR_IDLER:
        c = F.parkur(cid)
        sorun = F.parkur_dogrula(c)
        assert sorun == [], (cid, sorun)
        assert c['gates'][0]['kind'] == 'start' and 1 <= c['difficulty'] <= 5 and c['laps'] >= 1 and c['length_m'] > 80 and c['par_lap_s'] > 0
        assert len(c['line']) == len(c['gates']) + 1                                              # başlangıç → … → S/F
        turler |= set(c['kinds'])
        # kapılar birbirinin açıklığına girmiyor (çerçeve çakışması yok)
        W = F.EngelDunyasi([e for e in c['obstacles'] if e.get('part') == 'frame'], 0.0)
        for i, g in enumerate(c['gates']):
            k = W.nokta((g['x'], g['y'], g['z']))
            assert k is None, (cid, i, c['obstacles'][k])
        # kontrol noktaları: sıralı i, yerel → lat/lon tutarlı
        N = F.kontrol_noktalari(F.fpv_ayar_dogrula({'course_id': cid}, 'multirotor'), MERKEZ)
        x, y = core.enu(MERKEZ['lat'], MERKEZ['lon'], N[1]['lat'], N[1]['lon'])
        assert abs(x - N[1]['x']) < 0.05 and abs(y - N[1]['y']) < 0.05 and N[1]['alt_msl'] == round(MERKEZ['alt'] + N[1]['z'], 2)
        bas = F.parkur_baslangiclari(c, 8)
        assert len({(p[0], p[1]) for p in bas}) == 8 and min(math.dist(p[:2], q[:2]) for i, p in enumerate(bas) for q in bas[i + 1:]) >= 1.9
    assert {'gate', 'circle', 'window', 'dive', 'ladder', 'tunnel', 'flag', 'slalom', 'start'} <= turler, turler
    # doğrulayıcı yanlış eksenli kutuyu yakalar (eski hangar doğu duvarı hatası: w/d yer değiştirmiş → alan dışına taşan kiriş)
    import copy
    bozuk = copy.deepcopy(F.parkur('hangar'))
    duvar = next(e for e in bozuk['obstacles'] if e.get('mat') == 'hangar_wall' and e.get('yaw') == 90)
    duvar['w'], duvar['d'] = duvar['d'], duvar['w']
    assert any('dışına taşıyor' in x for x in F.parkur_dogrula(bozuk))
    # ayar doğrulama
    for bad in ({'course_id': 'yok'}, {'course_id': 'hangar', 'laps': 0}, {'course_id': 'hangar', 'laps': 11}, {'course_id': 'hangar', 'crash_rule': 'x'},
                {'course_id': 'hangar', 'crash_penalty_s': 31}, {'course_id': 'hangar', 'time_limit_min': 1}, {'course_id': 'hangar', 'laps': 2.5}):
        try:
            F.fpv_ayar_dogrula(bad, 'multirotor')
            assert False, bad
        except F.FpvHata:
            pass
    try:
        F.fpv_ayar_dogrula({'course_id': 'hangar'}, 'sabit_kanat')
        assert False
    except F.FpvHata:
        pass
    v = F.fpv_ayar_dogrula({'course_id': 'stadium'}, 'hexarotor')
    assert v['laps'] == F.parkur('stadium')['laps'] and v['crash_rule'] == 'penalty' and v['type'] == 'fpv'
    w = F.dunya_ayari('hangar', {'launch': {'method': 'wheels'}})
    assert w['mode'] == 'procedural' and w['runway'] is False and w['building_count'] == 0 and w['wind_ms'] == 0 and w['fpv_course'] == 'hangar' and w['launch']
    from app import flightsim
    assert flightsim.world_dogrula(w)['fpv_course'] == 'hangar'
    # puan: par hızında 250, daha hızlı en çok 375, bitirmeyen 0
    c = F.parkur('hangar')
    assert F.fpv_puani('hangar', c['par_lap_s'] * c['laps'], c['laps']) == 250 and F.fpv_puani('hangar', 1.0, c['laps']) == 375 and F.fpv_puani('hangar', None, 3) == 0
    print(f'  {len(F.PARKUR_IDLER)} parkur tanımı doğrulandı')


def sahte_ucus(cid, lvl, dt=0.1, tmax=900.0, laps=None):
    """Sahte kinematik: hız komutunu 6 m/s² ivme sınırıyla izleyen nokta kütle + gerçek ParkurIzleyici."""
    c = F.parkur(cid)
    cfg = F.fpv_ayar_dogrula({'course_id': cid, 'laps': laps or c['laps']}, 'multirotor')
    N = F.kontrol_noktalari(cfg, MERKEZ)
    iz = F.ParkurIzleyici(N, cfg, MERKEZ, 0.0)
    p = B.BotPilot(lvl, 'dikey', 7)
    x, y, _ = F.parkur_baslangiclari(c, 1)[0]
    z, vx, vy, vz, t = 0.0, 0.0, 0.0, 0.0, 0.0
    while z < max(1.5, N[0]['z']) * 0.9:
        z += 1.5 * dt
        t += dt
        iz.konum(x, y, MERKEZ['alt'] + z, t)
    while t < tmax and not iz.bitti:
        cmd = p.parkur_adim(t, {'x': x, 'y': y, 'z': z, 'heading': None, 'gs': math.hypot(vx, vy)}, N, iz.sira, c['bot_vmax'])
        a = 6.0 * dt
        vx += max(-a, min(a, cmd['vx'] - vx))
        vy += max(-a, min(a, cmd['vy'] - vy))
        vz += max(-a, min(a, cmd['vz'] - vz))
        x, y, z, t = x + vx * dt, y + vy * dt, max(0.0, z + vz * dt), t + dt
        iz.konum(x, y, MERKEZ['alt'] + z, t, math.atan2(vx, vy), 0.0, 0.0)
    return iz


def uctan_uca_testleri():
    for cid in F.PARKUR_IDLER:
        sure = {}
        for lvl in ('hard', 'normal', 'easy'):
            iz = sahte_ucus(cid, lvl)
            assert iz.bitti and iz.toplam() is not None, (cid, lvl, iz.sira, len(iz.halkalar))
            assert len(iz.kacan) == 0 and iz.carpma == 0, (cid, lvl, iz.kacan, iz.carpma)
            sure[lvl] = iz.toplam()
        assert sure['hard'] < sure['normal'] < sure['easy'], (cid, sure)
        print(f"    {cid:10s} Zor {sure['hard']:6.1f} s · Normal {sure['normal']:6.1f} s · Kolay {sure['easy']:6.1f} s")
    print('  sahte kinematikle uçtan uca (8 parkur × 3 seviye) geçti')


def karsilasma_testleri():
    cfg = F.fpv_ayar_dogrula({'course_id': 'woodframe', 'laps': 1}, 'multirotor')
    N = F.kontrol_noktalari(cfg, MERKEZ)
    try:
        core.Karsilasma(1, (10, 'K'), [], {'type': 'sabit_kanat'}, cfg, MERKEZ, 0, N, tur='fpv')
        assert False
    except core.MacHata:
        pass
    # tek kişilik zaman denemesi
    k = core.Karsilasma(1, (10, 'Kurucu'), [], {'type': 'multirotor'}, cfg, MERKEZ, 0.0, N, tur='fpv')
    assert k.min_oyuncu == 1 and k.lobi_denetle(1)[-1]['state'] == core.HAZIRLIK
    k.hazir(10, 2)
    k.tik(2 + core.GERI_SAYIM_S)
    assert k.durum == core.YARIS and isinstance(k.oyuncu(10).iz, F.ParkurIzleyici)
    t0 = k.baslangic_t
    ev = []
    for j, h in enumerate(N):
        a = core.latlon(MERKEZ['lat'], MERKEZ['lon'], h['x'] - h['nx'] * 1, h['y'] - h['ny'] * 1)
        b = core.latlon(MERKEZ['lat'], MERKEZ['lon'], h['x'] + h['nx'] * 1, h['y'] + h['ny'] * 1)
        za, zb = MERKEZ['alt'] + h['z'] - h['nz'], MERKEZ['alt'] + h['z'] + h['nz']
        ev += k.konum(10, *a, za, t0 + 3 * j + 1, yaw=0.0) + k.konum(10, *b, zb, t0 + 3 * j + 1.1, yaw=0.0)
    tipler = [e['t'] for e in ev]
    assert tipler.count('ring') == len(N) and 'lap' in tipler and 'sector' in tipler and tipler[-3:] == ['finish', 'state', 'result'], tipler
    r = ev[-1]['result']
    assert k.neden == 'tamamlandi' and r['solo'] and r['kind'] == 'fpv' and r['fpv']['course_id'] == 'woodframe' and r['winner'] == 10
    st = r['standings'][0]
    assert st['time_s'] == round(3 * (len(N) - 1) + 1.1, 2) and st['fpv']['laps_done'] == 1 and st['rings'] == len(N), st
    ring = next(e for e in ev if e['t'] == 'ring')
    assert {'lap', 'gate', 'pen_s', 'elapsed_s'} <= set(ring)
    # çok oyunculu: A bitirir (cezalı), B daha geç ama cezasız bitirir → sıralama ceza dahil; son çağrı
    k2 = core.Karsilasma(2, (10, 'A'), [(20, 'B')], {'type': 'multirotor'}, cfg, MERKEZ, 0.0, N, tur='fpv')
    k2.katil(20, 1)
    k2.hazir(10, 2)
    k2.hazir(20, 2)
    k2.tik(2 + core.GERI_SAYIM_S)
    t0 = k2.baslangic_t
    for uid, dt_, atla in ((10, 1.0, True), (20, 1.2, False)):
        for j, h in enumerate(N):
            if atla and j == 2:
                continue
            a = core.latlon(MERKEZ['lat'], MERKEZ['lon'], h['x'] - h['nx'] * 1, h['y'] - h['ny'] * 1)
            b = core.latlon(MERKEZ['lat'], MERKEZ['lon'], h['x'] + h['nx'] * 1, h['y'] + h['ny'] * 1)
            k2.konum(uid, *a, MERKEZ['alt'] + h['z'] - h['nz'], t0 + dt_ * j + 1)
            ev = k2.konum(uid, *b, MERKEZ['alt'] + h['z'] + h['nz'], t0 + dt_ * j + 1.05)
            if uid == 10 and j == len(N) - 1:
                assert k2.durum == core.YARIS and k2.son_cagri_t is not None   # ilki bitirdi; diğerine süre tanındı
    assert k2.durum == core.BITTI and k2.neden == 'hepsi_bitirdi', k2.neden
    r = k2.sonuc()
    A, Bb = (next(p for p in r['standings'] if p['id'] == u) for u in (10, 20))
    assert A['pen_s'] > 0 and A['finish_t'] < Bb['finish_t'] and A['time_s'] > Bb['time_s'] and r['standings'][0]['id'] == 20 and r['winner'] == 20 and not r['solo'], r['standings']
    # son çağrı: biri bitirir, diğeri bitiremez → SON_CAGRI_S sonra biter
    k3 = core.Karsilasma(3, (10, 'A'), [(20, 'B')], {'type': 'multirotor'}, cfg, MERKEZ, 0.0, N, tur='fpv')
    k3.katil(20, 1)
    k3.hazir(10, 2)
    k3.hazir(20, 2)
    k3.tik(2 + core.GERI_SAYIM_S)
    t0 = k3.baslangic_t
    for j, h in enumerate(N):
        a = core.latlon(MERKEZ['lat'], MERKEZ['lon'], h['x'] - h['nx'] * 1, h['y'] - h['ny'] * 1)
        b = core.latlon(MERKEZ['lat'], MERKEZ['lon'], h['x'] + h['nx'] * 1, h['y'] + h['ny'] * 1)
        k3.konum(10, *a, MERKEZ['alt'] + h['z'] - h['nz'], t0 + j + 1)
        k3.konum(10, *b, MERKEZ['alt'] + h['z'] + h['nz'], t0 + j + 1.05)
    fin = k3.son_cagri_t
    assert k3.tik(fin - 0.1) == [] and k3.tik(fin)[0]['state'] == core.BITTI and k3.neden == 'son_cagri' and k3.kazanan == 10
    # halka yarışı tek kişilik; it dalaşı tek kişilik olamaz
    hc = core.halka_ayar_dogrula({'count': 2, 'seed': 3}, 'multirotor')
    assert core.Karsilasma(4, (10, 'K'), [], {}, hc, MERKEZ, 0, core.halkalar_uret(hc, MERKEZ)).min_oyuncu == 1
    try:
        core.Karsilasma(5, (10, 'K'), [], {}, core.it_ayar_dogrula({}, 'multirotor'), MERKEZ, 0, [], tur='dogfight')
        assert False
    except core.MacHata:
        pass
    # bot: FPV'de kalkış irtifası parkur başlangıç kapısı (kapalı mekan)
    kb = core.Karsilasma(6, (10, 'K'), [], {'type': 'multirotor'}, F.fpv_ayar_dogrula({'course_id': 'hangar'}, 'multirotor'), MERKEZ, 0,
                         F.kontrol_noktalari(F.fpv_ayar_dogrula({'course_id': 'hangar'}, 'multirotor'), MERKEZ), tur='fpv', botlar=[(-1, 'AI-Şahin', 'hard')])

    class _S:
        tele = {}
        state = 'HAZIR'
    sur = B.BotSurucu(kb, -1, _S(), 'multirotor')
    assert sur._kalkis_irtifasi() < 3.0
    print('  karşılaşma (tek kişilik, çok oyunculu, son çağrı, bot) geçti')


def main():
    kapi_testleri()
    engel_testleri()
    izleyici_testleri()
    hayalet_testleri()
    parkur_testleri()
    karsilasma_testleri()
    uctan_uca_testleri()
    print('test_flightsim_fpvcourse: TAMAM')


if __name__ == '__main__':
    sys.exit(main())
