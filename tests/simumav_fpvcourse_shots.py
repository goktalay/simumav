"""SIMUMAV §29 — HAZIR FPV PARKURLARI + TEK KİŞİLİK KARŞILAŞMA görselleri → /tmp/fpvcourse-shots/sm-*.png (Playwright headless shell + SwiftShader;
sahte SITL HEPGO_SITL=0; araç sunucuda sahte kinematikle parkurun YARIŞ HATTI boyunca uçurulur — `fpv_pilotu`, HEPGO tests/fpvcourse_shots_hepgo.py ile aynı).
  sm-01 Parkur › Hazır FPV parkurları galerisi · sm-02 parkur ayrıntısı + skor tablosu ("siz" vurgusu, en iyi tur/sektörlerim) ·
  sm-03 Uç seçimi (FPV parkuru kartı + karşılaşmalarım: FPV parkur + tek kişilik rozeti) · sm-04/05 Uç › Tek oyunculu › FPV parkuru sihirbazı (parkur galerisi,
  kurallar) · sm-06 çok oyunculu kurucuda FPV türü · sm-07 davet adımı (1 = tek kişilik) · sm-08 salon (tek kişilik BAŞLAT) ·
  sm-10.. yarış ekranı (FPV görünüm + HUD + çubuk göstergesi; takip kamerası + hayalet) — en az 2 mekan · sm-1x tek kişilik sonuç (KİŞİSEL REKOR) ·
  sm-20 TOP 10 (FPV parkur bileşeni) · sm-30.. mobil / tablet.
Skor tablosu için başka pilotların kayıtları doğrudan DB'ye eklenir (örnek veri; hayaletsiz).
Çalıştırma: .venv/bin/python -m tests.simumav_fpvcourse_shots    (SHOT_PHASES=race,venues,ui,top10,mobile — varsayılan hepsi)
"""
import json
import math
import os
import shutil
import socket
import sys
import threading
import time

os.environ.setdefault('LD_LIBRARY_PATH', '/home/gelistirici/build/chromelibs/root/usr/lib/x86_64-linux-gnu')
DATA = '/tmp/sm-fpvcourse-shots-data'
OUT = '/tmp/fpvcourse-shots'            # ortak çıktı dizini (HEPGO betiği de yazar) — kareler önce ayrı dizine, sonda kopyalanır
SHOTS = '/tmp/sm-fpvcourse-shots-tmp'
shutil.rmtree(DATA, ignore_errors=True)
os.makedirs(DATA, exist_ok=True)
os.makedirs(SHOTS, exist_ok=True)
os.makedirs(OUT, exist_ok=True)
os.environ.update(SIMUMAV_DATA_DIR=DATA, SIMUMAV_DEV_LOGIN='1', HEPGO_SITL='0', SIMUMAV_UDP_BASE='28950', SIMUMAV_MAX_FLIGHTS='4',
                  SIMUMAV_MP_PORT_BASE='29900', SIMUMAV_MP_PORT_COUNT='20', SIMUMAV_SECURE_COOKIE='0', SIMUMAV_ENV_FILE=os.path.join(DATA, 'yok.env'),
                  SIMUMAV_MT_INTERNAL='http://127.0.0.1:1', GOOGLE_MAPS_API_KEY='')
PORT = int(os.environ.get('SHOT_PORT') or 8657)
BASE = f'http://127.0.0.1:{PORT}'
EXE = os.environ.get('CHROMIUM_PATH') or os.path.expanduser('~/.cache/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell')
ARGS = ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist']
PHASES = set((os.environ.get('SHOT_PHASES') or 'race,venues,ui,top10,mobile').split(','))

import requests  # noqa: E402
import uvicorn  # noqa: E402
from playwright.sync_api import sync_playwright  # noqa: E402

import app.simumav.main as smain  # noqa: E402
from app import flightsim, flightsim_fpv  # noqa: E402
from app import flightsim_match_core as core  # noqa: E402
from app.simumav import db as sdb  # noqa: E402
from app.simumav import match as M  # noqa: E402

core.HAZIRLIK_ZAMAN_ASIMI_S = 900.0   # yazılım WebGL'de 3B dünya yavaş kurulur
server = uvicorn.Server(uvicorn.Config(smain.app, host='127.0.0.1', port=PORT, log_level='error'))
threading.Thread(target=server.run, daemon=True).start()
for _ in range(120):
    try:
        socket.create_connection(('127.0.0.1', PORT), 0.3).close()
        break
    except OSError:
        time.sleep(0.25)
else:
    sys.exit('sunucu açılmadı')

H = {'Origin': BASE}
sonuc, hatalar = [], []


def giris(ad):
    s = requests.Session()
    r = s.post(f'{BASE}/api/session', json={'dev_user': ad}, headers=H)
    assert r.status_code == 200, r.text
    return s


ali = giris('ali')
ME = ali.get(f'{BASE}/api/session').json()
UID = (ME.get('user') or ME).get('id')


def ornek_kayitlar():
    """Skor tablosu / TOP 10 için başka pilotların örnek kayıtları (DB; hayaletsiz)."""
    pilotlar = ['veli', 'ayse', 'mehmet', 'zeynep', 'can']
    for ad in pilotlar:
        giris(ad)
    t = sdb.now()
    with sdb.connect() as conn:
        ids = [r[0] for r in conn.execute('SELECT id FROM users WHERE id != ? ORDER BY id', (UID,)).fetchall()]
        for cid in flightsim_fpv.PARKUR_IDLER:
            c = flightsim_fpv.parkur(cid)
            par, laps = float(c['par_lap_s']), int(c['laps'])
            for k, uid in enumerate(ids):
                if (k + len(cid)) % 3 == 2 and cid not in ('hangar', 'woodframe'):
                    continue
                f = 0.96 + 0.07 * k + 0.013 * (len(cid) % 5)
                tur = [round(par * f * (1.0 + 0.02 * ((j + k) % 3)), 3) for j in range(laps)]
                ceza = float(3 * (k % 2))
                conn.execute('INSERT INTO fpv_records (course_id, user_id, drone_type, laps, time_s, best_lap_s, lap_times, sectors, splits, misses, hits, penalty_s, crash_rule, ghost, solo, created_at) '
                             'VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)', (cid, uid, 'fpv', laps, round(sum(tur) + ceza, 3), min(tur), json.dumps(tur), '[]', '[]', k % 2, k % 3, ceza, 'penalty', None, 1, t))
        conn.commit()


def shot(pg, ad, el=None, full=False):
    (el or pg).screenshot(path=f'{SHOTS}/{ad}.png', timeout=300000, **({'full_page': True} if full and el is None else {}))
    sonuc.append(ad)
    print('  ·', ad, flush=True)


def kontrol(ad, kosul):
    print(('  ✓ ' if kosul else '  ✗ ') + ad, flush=True)
    if not kosul:
        hatalar.append(ad)


def bekle(fn, sn=120, adim=0.5):
    t = time.time() + sn
    while time.time() < t:
        v = fn()
        if v:
            return v
        time.sleep(adim)
    return fn()


def baglam(b, oturum=None, w=1440, hh=900, mobile=False):
    ctx = b.new_context(viewport={'width': w, 'height': hh}, locale='tr-TR', is_mobile=mobile, has_touch=mobile, device_scale_factor=2 if mobile else 1)
    if oturum is not None:
        ctx.add_cookies([{'name': 'smsid', 'value': oturum.cookies['smsid'], 'url': BASE}])
    ctx.add_init_script("try { localStorage.setItem('sm:lang', 'tr'); localStorage.setItem('simumav.consent', 'denied'); localStorage.setItem('sm.gfx', JSON.stringify({preset: 'high'}));"
                        " localStorage.setItem('fs.cam.pip', JSON.stringify({on: false})); localStorage.setItem('fs.ops.on', '0'); } catch (e) {}")   # dron paneli kapalı (takip karelerini örtmesin)
    pg = ctx.new_page()
    pg.set_default_timeout(120000)
    pg.on('pageerror', lambda e: hatalar.append('SAYFA: ' + str(e)[:400]))
    pg.on('console', lambda m: hatalar.append(f'KONSOL: {m.text[:300]}') if m.type == 'error' and not any(x in m.text for x in ('WebGL', 'GPU stall', 'Failed to load resource', 'favicon')) else None)
    return ctx, pg


# ---------------------------------------------------------------- sahte kinematik: yarış hattı boyunca (HEPGO betiğiyle aynı)
def hat_noktalari(c):
    pts, kapi_i = [], {}
    for k, seg in enumerate(c['line']):
        for j, p in enumerate(seg):
            if pts and j == 0:
                continue
            pts.append(tuple(p))
        g = k if k < len(c['gates']) else 0
        kapi_i.setdefault(g if k else 0, len(pts) - 3)
    return pts, kapi_i


def fpv_pilotu(oturum_, c, merkez, hiz=8.0):
    k = oturum_.sahte
    pts, _ = hat_noktalari(c)
    bx, by = core.enu(merkez['lat'], merkez['lon'], k.lat0, k.lon0)
    st = {'i': 0, 'p': [bx, by, 0.0], 'hedef': len(pts) - 1, 'hiz': hiz, 'pts': pts, 'yaw': math.radians(c['start']['yaw'])}

    def adim(dt):
        k.sure_ms += dt * 1000
        k.armed, k.mode = True, 'ACRO'
        kalan = st['hiz'] * dt
        while kalan > 0 and st['i'] <= min(st['hedef'], len(pts) - 1):
            hx, hy, hz = pts[st['i']]
            dx, dy, dz = hx - st['p'][0], hy - st['p'][1], hz - st['p'][2]
            d = math.sqrt(dx * dx + dy * dy + dz * dz)
            if d > 0.05:
                st['yaw'] = math.atan2(dx, dy) if math.hypot(dx, dy) > 0.2 else st['yaw']
            if d <= kalan:
                st['p'] = [hx, hy, hz]; st['i'] += 1; kalan -= d
            else:
                f = kalan / d
                st['p'] = [st['p'][0] + dx * f, st['p'][1] + dy * f, st['p'][2] + dz * f]; kalan = 0
                k.vn, k.ve = dy / d * st['hiz'], dx / d * st['hiz']
        if st['i'] > st['hedef']:
            k.vn = k.ve = 0.0
            nx = pts[min(st['i'], len(pts) - 1)]
            if math.hypot(nx[0] - st['p'][0], nx[1] - st['p'][1]) > 0.3:
                st['yaw'] = math.atan2(nx[0] - st['p'][0], nx[1] - st['p'][1])
        lat, lon = core.latlon(merkez['lat'], merkez['lon'], st['p'][0], st['p'][1])
        k.lat, k.lon, k.alt_rel = lat, lon, st['p'][2]
        k.yaw, k.roll, k.pitch = st['yaw'], 0.0, -0.06
    k.adim = adim
    return st


def mac_oturumu(mid):
    m = M.MANAGER.get(mid)
    uid = next(o.uid for o in m.k.oyuncular.values() if not o.bot)
    return m, flightsim.MANAGER.get(m.sessions[uid].id)


def sihirbaz_fpv(pg, cid, laps=1, rule='penalty'):
    """Uç › FPV parkuru: dron → parkur → kurallar (tur, çarpma kuralı)."""
    pg.goto(f'{BASE}/app/#/fly/fpv/{cid}', wait_until='domcontentloaded')
    pg.wait_for_selector('.sm-wizard-fpv .sm-cards-drones')
    pg.click('.sm-nav-btn.primary')
    pg.wait_for_selector(f'.sm-fc-card[data-course="{cid}"].sel')
    pg.click('.sm-nav-btn.primary')
    pg.wait_for_selector('.sm-fc-lapseg')
    pg.click(f'.sm-fc-lapseg button[data-laps="{laps}"]')
    pg.click(f'.sm-fc-rule[data-rule="{rule}"]')


def yaris_ui(pg, cid, laps=1, rule='penalty'):
    """Sihirbazdan zaman denemesi başlat → salon → yarış ekranı; 3B parkur katmanı kurulunca (mid, m, oturum)."""
    sihirbaz_fpv(pg, cid, laps, rule)
    pg.click('.sm-start-btn')
    pg.wait_for_function("() => /#\\/fly\\/match\\/\\d+\\/race/.test(location.hash)", timeout=180000)
    mid = int(pg.evaluate("location.hash.match(/match\\/(\\d+)/)[1]"))
    pg.wait_for_function("() => !!(window.__smFpv && window.__smFpv.layer)", timeout=600000)
    m, ses = mac_oturumu(mid)
    kontrol(f'{cid}: yarış başladı (tek kişilik)', bekle(lambda: m.k.durum == core.YARIS, 600, 0.5))
    return mid, m, ses


def tepe(pg):
    """Tıklamalar kaydırma kaplarını aşağı itebilir: kare öncesi her kaydırılmış öğe başa."""
    pg.evaluate("window.scrollTo(0, 0); for (const e of document.querySelectorAll('*')) if (e.scrollTop) e.scrollTop = 0;")
    pg.wait_for_timeout(300)


def kamera(pg, mode):
    pg.evaluate(f"window.__smSim?.setCamera('{mode}')")


try:
    with sync_playwright() as p:
        b = p.chromium.launch(executable_path=EXE, args=ARGS)
        if 'race' in PHASES:
            # ---- MEKAN 1: hangar (1 tur) — koşu 1 (ilk kayıt) → koşu 2 (hayalet önde, sonra hızlı → KİŞİSEL REKOR)
            c = flightsim_fpv.parkur('hangar')
            ctx, pg = baglam(b, ali)
            mid, m, ses = yaris_ui(pg, 'hangar', 1)
            fpv_pilotu(ses, c, m.merkez, hiz=6.0)   # hayalet koşusu (yavaşça: ikinci koşuda önde uçsun)
            kontrol('koşu 1 bitti', bekle(lambda: m.k.durum == core.BITTI, 300, 1.0))
            pg.wait_for_selector('.sm-mt-result:not([hidden]) .sm-fc-res', timeout=60000); pg.wait_for_timeout(3500)
            kontrol('ilk kayıt: KİŞİSEL REKOR (ilk)', pg.locator('.sm-mt-result .sm-fc-res.pb').count() == 1)
            shot(pg, 'sm-12-sonuc-ilk-kayit')
            ctx.close()
            time.sleep(6)
            ctx, pg = baglam(b, ali)
            mid, m, ses = yaris_ui(pg, 'hangar', 1)
            st = fpv_pilotu(ses, c, m.merkez, hiz=4.0)   # yarış saatiyle hemen kalk (hayalet önde)
            pts, kapi = hat_noktalari(c)
            st['hedef'] = max(1, kapi.get(3, 10) - 2)    # 3. kapının önünde askıda dur (kare için)
            pg.wait_for_function("() => window.__smFpv && window.__smFpv.ghost", timeout=60000)
            bekle(lambda: st['i'] > st['hedef'], 200, 0.3)
            kamera(pg, 'pilot'); pg.wait_for_timeout(2500)
            gi = pg.evaluate("window.__smFpv.layer.info()")
            kontrol(f"hayalet görünür: {gi.get('ghostPos')}", bool(gi.get('ghost')))
            hs = pg.evaluate("window.__smFpv.hud.state()")
            kontrol(f"HUD: hayalet farkı {hs.get('delta')} · çubuk göstergesi {hs.get('sticks')}", hs.get('delta') is not None and hs.get('sticks'))
            kontrol('match3d halkaları FPV\'de kapalı', pg.evaluate("window.__smMatch?.layer?.ringCount ?? -1") == 0)
            shot(pg, 'sm-10-yaris-hangar-fpv-hud-hayalet')
            pg.evaluate("window.__smSim?.setFollowView?.(5.5, 2.0)"); pg.wait_for_timeout(2500)
            shot(pg, 'sm-11-yaris-hangar-takip-hayalet')
            st['hiz'] = 30.0; st['hedef'] = len(pts) - 1
            kontrol('koşu 2 bitti', bekle(lambda: m.k.durum == core.BITTI, 300, 1.0))
            pg.wait_for_selector('.sm-mt-result:not([hidden]) .sm-fc-res', timeout=60000); pg.wait_for_timeout(4500)
            shot(pg, 'sm-13a-sonuc-rekor-kirilamadi')   # askıda beklenen koşu: rekor kırılamadı (önceki rekorla fark)
            ctx.close()
            time.sleep(6)
            # koşu 3: kesintisiz hızlı → KİŞİSEL REKOR (fanfar + rozet + önceki rekorla fark)
            ctx, pg = baglam(b, ali)
            mid, m, ses = yaris_ui(pg, 'hangar', 1)
            fpv_pilotu(ses, c, m.merkez, hiz=14.0)
            kontrol('koşu 3 bitti', bekle(lambda: m.k.durum == core.BITTI, 300, 1.0))
            pg.wait_for_selector('.sm-mt-result:not([hidden]) .sm-fc-res', timeout=60000); pg.wait_for_timeout(4500)
            kontrol('KİŞİSEL REKOR rozeti', pg.locator('.sm-mt-result .sm-fc-pb').count() == 1)
            shot(pg, 'sm-13-sonuc-kisisel-rekor')
            ctx.close()
        if 'venues' in PHASES:
            # ---- MEKAN 2 + 3: tepedeki ahşap ev / yarım beton bina (FPV görünüm + takip)
            for cid, dur in (('woodframe', 1), ('concrete', 4)):
                c = flightsim_fpv.parkur(cid)
                ctx, pg = baglam(b, ali)
                mid, m, ses = yaris_ui(pg, cid, 1, 'continue')
                pts, kapi = hat_noktalari(c)
                st = fpv_pilotu(ses, c, m.merkez, hiz=10.0)
                st['hedef'] = max(1, kapi.get(dur, 3) - 2)
                bekle(lambda: st['i'] > st['hedef'], 120, 0.3)
                pg.wait_for_timeout(2500)
                kamera(pg, 'pilot'); pg.wait_for_timeout(6000)
                info = pg.evaluate("window.__smFpv.layer.info()")
                nexts = [g for g in info['gates'] if g['state'] == 'next']
                kontrol(f"{cid}: sıradaki kapı yeşil (kapı {nexts[0]['i'] if nexts else '—'}, beklenen {dur})", bool(nexts) and nexts[0]['i'] == dur)
                shot(pg, f'sm-14-yaris-{cid}-fpv')
                pg.evaluate("window.__smSim?.setFollowView?.(5.5, 2.0)"); pg.wait_for_timeout(5000)
                shot(pg, f'sm-15-yaris-{cid}-takip')
                ali.post(f'{BASE}/api/match/{mid}/cancel', json={}, headers=H)
                ctx.close()
                time.sleep(3)
        if 'ui' in PHASES or 'top10' in PHASES or 'mobile' in PHASES:
            ornek_kayitlar()
        if 'ui' in PHASES:
            ctx, pg = baglam(b, ali)
            # Parkur › Hazır FPV parkurları
            pg.goto(f'{BASE}/app/#/tracks/fpv', wait_until='domcontentloaded')
            pg.wait_for_selector('.sm-fc-card .sm-fc-svg svg'); pg.wait_for_timeout(2500)
            kontrol('galeride 8 parkur', pg.locator('.sm-fc-card').count() == 8)
            shot(pg, 'sm-01-parkur-hazir-fpv-galeri')
            pg.click('.sm-fc-card[data-course="hangar"]')
            pg.wait_for_selector('.sm-fc-detail .sm-fc-lb'); pg.wait_for_timeout(4000)   # rota geçiş animasyonu
            if 'race' in PHASES:   # zaman denemeleri 1 turla koşuldu: skor tablosu 1 tur
                pg.select_option('.sm-fc-lapsel select', '1'); pg.wait_for_selector('.sm-fc-lb tr.me', timeout=30000); pg.wait_for_timeout(1500)
            kontrol('ayrıntı: skor tablosunda "siz"', pg.locator('.sm-fc-lb tr.me').count() == 1 or 'race' not in PHASES)
            shot(pg, 'sm-02-parkur-ayrinti-skor-tablosu')
            # Uç seçimi + karşılaşmalarım
            pg.goto(f'{BASE}/app/#/fly', wait_until='domcontentloaded')
            pg.wait_for_selector('.sm-mode-card.fpv'); pg.wait_for_timeout(1800)
            kontrol('karşılaşmalarım: FPV + tek kişilik rozeti', pg.locator('.sm-mt-hist li.k-fpv .sm-fc-solo').count() >= 1 or 'race' not in PHASES)
            shot(pg, 'sm-03-uc-secim-fpv-karti')
            # Tek oyunculu › FPV parkuru sihirbazı
            pg.click('.sm-mode-card.fpv')
            pg.wait_for_selector('.sm-wizard-fpv .sm-cards-drones'); pg.wait_for_timeout(1500)
            pg.click('.sm-nav-btn.primary')
            pg.wait_for_selector('.sm-fc-card .sm-fc-svg svg'); pg.click('.sm-fc-card[data-course="refinery"]')
            pg.wait_for_selector('.sm-fc-side .sm-fc-lb, .sm-fc-side .sm-fc-lb-empty'); pg.wait_for_timeout(1500); tepe(pg)
            shot(pg, 'sm-04-fpv-sihirbaz-parkur')
            pg.click('.sm-nav-btn.primary')
            pg.wait_for_selector('.sm-fc-lapseg'); pg.click('.sm-fc-rule[data-rule="reset"]'); pg.wait_for_timeout(600)
            kontrol('kurallar: BAŞLAT etkin', not pg.locator('.sm-start-btn').is_disabled())
            shot(pg, 'sm-05-fpv-sihirbaz-kurallar')
            # Çok oyunculu kurucu: FPV türü
            pg.goto(f'{BASE}/app/#/fly/multi', wait_until='domcontentloaded')
            pg.wait_for_selector('.sm-wizard-match .sm-cards-drones')
            pg.click('.sm-nav-btn.primary'); pg.wait_for_selector('.sm-cards-tracks'); pg.click('.sm-nav-btn.primary')
            pg.wait_for_selector('.sm-df-kind[data-kind="fpv"]'); pg.click('.sm-df-kind[data-kind="fpv"]')
            pg.wait_for_selector('.sm-fc-mbox .sm-fc-card .sm-fc-svg svg'); pg.click('.sm-fc-mbox .sm-fc-card[data-course="woodframe"]'); pg.wait_for_timeout(1500)
            adim = pg.locator('.sm-steps .sm-step').all_inner_texts()
            kontrol(f'FPV türünde parkur adımı gizli: {adim}', len(adim) == 3)
            pg.evaluate("document.querySelector('.sm-df-kindhead')?.scrollIntoView({block: 'start'})"); pg.wait_for_timeout(400)
            shot(pg, 'sm-06-cok-oyunculu-fpv-turu')
            pg.click('.sm-nav-btn.primary'); pg.wait_for_selector('.sm-mt-pw')
            pg.click('.sm-mt-seg button[data-n="1"]'); pg.wait_for_timeout(400)
            kontrol('davet: 1 oyuncu = tek kişilik', pg.locator('.sm-fc-sololine .sm-fc-solo').count() == 1)
            shot(pg, 'sm-07-davet-tek-kisilik')
            pg.click('.sm-mt-create')
            pg.wait_for_selector('.sm-mt-start'); pg.wait_for_timeout(2500); tepe(pg)
            kontrol('salon: yalnız kurucu → BAŞLAT etkin (tek kişilik)', not pg.locator('.sm-mt-start').is_disabled() and pg.locator('.sm-mt-start.solo').count() == 1)
            shot(pg, 'sm-08-salon-tek-kisilik')
            mid0 = int(pg.evaluate('window.__smLobby.match.id'))
            ali.post(f'{BASE}/api/match/{mid0}/cancel', json={}, headers=H)
            ctx.close()
        if 'top10' in PHASES:
            ctx, pg = baglam(b, ali)
            pg.goto(f'{BASE}/app/#/menu', wait_until='domcontentloaded')
            pg.wait_for_selector('.menu-top10-btn'); pg.wait_for_timeout(1200)
            pg.click('.menu-top10-btn'); pg.locator('.sm-top10 [data-p="all"]').click()
            pg.wait_for_selector('.sm-top10 li .part.p-fpv'); pg.wait_for_timeout(2500)
            kontrol('TOP 10: FPV parkur bileşeni', pg.locator('.sm-top10 li .part.p-fpv').count() >= 1)
            shot(pg, 'sm-20-top10-fpv-bileseni', pg.locator('.sm-top10-modal'))
            ctx.close()
        if 'mobile' in PHASES:
            ctx, pg = baglam(b, ali, 390, 844, mobile=True)
            pg.goto(f'{BASE}/app/#/tracks/fpv', wait_until='domcontentloaded')
            pg.wait_for_selector('.sm-fc-card .sm-fc-svg svg'); pg.wait_for_timeout(2500)
            shot(pg, 'sm-30-mobil-galeri')
            pg.goto(f'{BASE}/app/#/fly/fpv/canyon', wait_until='domcontentloaded')
            pg.wait_for_selector('.sm-wizard-fpv .sm-cards-drones'); pg.wait_for_timeout(1200)
            pg.click('.sm-nav-btn.primary'); pg.wait_for_selector('.sm-fc-side .sm-fc-detail-map svg'); pg.wait_for_timeout(1500); tepe(pg)
            shot(pg, 'sm-31-mobil-sihirbaz-parkur')
            ctx.close()
            ctx, pg = baglam(b, ali, 820, 1180, mobile=True)
            pg.goto(f'{BASE}/app/#/tracks/fpv/concrete', wait_until='domcontentloaded')
            pg.wait_for_selector('.sm-fc-detail .sm-fc-lb'); pg.wait_for_timeout(2000)
            shot(pg, 'sm-32-tablet-parkur-ayrinti')
            ctx.close()
        b.close()
finally:
    server.should_exit = True
    time.sleep(1)
    for ad in sonuc:
        shutil.copy(f'{SHOTS}/{ad}.png', f'{OUT}/{ad}.png')
    print('görüntüler:', len(sonuc), '→', OUT)
    print('hatalar:', hatalar or 'yok')
sys.exit(1 if [x for x in hatalar if not x.startswith('KONSOL')] else 0)
