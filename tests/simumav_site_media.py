"""SIMUMAV tanıtım sitesi görselleri — GERÇEK uygulamadan (Playwright headless shell + SwiftShader; sahte SITL, dev giriş, prosedürel arazi).
Sunucu aynı süreçte iş parçacığı olarak açılır (arka plan süreci bırakılmaz). Ham PNG'ler /tmp/smsite-media/, yayınlanan WEBP'ler
static/simumav/site/img/ (docs/simumav.md §5.3 tablo). Üretilen kareler:
  modüller : menu · hangar · crew · tracks · missions · wizard (Uç sihirbazı) · ops (Operasyon kartları)
  savunma  : defend-fly (radar + EO + görev şeridi) · radar (kırpım) · eo-day / eo-thermal / eo-night (EO penceresi kırpımı) · defend-report
  hedef    : tgt-gimbal (F-16 tarzı semboloji, gündüz) · tgt-thermal · launcher-wizard (dört fırlatıcı + 3B önizleme; yayın) · launcher-scope (ham)
Çalıştırma: ./.venv/bin/python -m tests.simumav_site_media            (yalnız WEBP yeniden üretimi: --publish-only;
            bölüm seçimi: MEDIA_ONLY=mod,defend,tgt,launch,ops)
"""
import os
import pathlib
import shutil
import socket
import sys
import threading
import time

ROOT = pathlib.Path(__file__).resolve().parents[1]
RAW = pathlib.Path('/tmp/smsite-media'); RAW.mkdir(parents=True, exist_ok=True)
IMG = ROOT / 'static/simumav/site/img'

# yayın tablosu: ham ad → (webp adı, genişlik, kırpım kutusu None | (x, y, w, h) ham pikselde)
PUBLISH = {
    'hangar.png': ('mod-hangar.webp', 1200, None), 'crew.png': ('mod-crew.webp', 1200, None),
    'tracks.png': ('mod-tracks.webp', 1200, None), 'missions.png': ('mod-missions.webp', 1200, None), 'wizard.png': ('mod-fly.webp', 1200, None),
    'ops.png': ('mod-ops.webp', 1200, None), 'defend-fly.png': ('sys-defend.webp', 1400, None), 'radar.png': ('sys-radar.webp', 640, None),
    'eo-day.png': ('sys-eo-day.webp', 640, None), 'eo-thermal.png': ('sys-eo-thermal.webp', 640, None), 'eo-night.png': ('sys-eo-night.webp', 640, None),
    'defend-report.png': ('sys-report.webp', 1000, None), 'tgt-gimbal.png': ('sys-tgt-gimbal.webp', 1400, None), 'tgt-thermal.png': ('sys-tgt-thermal.webp', 1400, None),
    'launcher-wizard.png': ('sys-launcher.webp', 1400, None),
}


def publish():
    from PIL import Image
    IMG.mkdir(parents=True, exist_ok=True)
    out = []
    for raw, (ad, w, box) in PUBLISH.items():
        p = RAW / raw
        if not p.is_file():
            print('  YOK (atlandı):', raw); continue
        im = Image.open(p).convert('RGB')
        if box:
            im = im.crop((box[0], box[1], box[0] + box[2], box[1] + box[3]))
        if im.width > w:
            im = im.resize((w, round(im.height * w / im.width)), Image.LANCZOS)
        im.save(IMG / ad, 'WEBP', quality=74, method=6)
        out.append((ad, im.size, (IMG / ad).stat().st_size))
    for ad, sz, b in out:
        print(f'  {ad:28s} {sz[0]}×{sz[1]}  {b // 1024} KB')
    return out


if '--publish-only' in sys.argv:
    publish(); sys.exit(0)

os.environ.setdefault('LD_LIBRARY_PATH', '/home/gelistirici/build/chromelibs/root/usr/lib/x86_64-linux-gnu')
DATA = '/tmp/smsite-media-data'
shutil.rmtree(DATA, ignore_errors=True)
os.makedirs(DATA, exist_ok=True)
os.environ.update(SIMUMAV_DATA_DIR=DATA, SIMUMAV_DEV_LOGIN='1', HEPGO_SITL='0', SIMUMAV_UDP_BASE='25650', SIMUMAV_MAX_FLIGHTS='2',
                  SIMUMAV_MP_PORT_BASE='26700', SIMUMAV_MP_PORT_COUNT='40', SIMUMAV_SECURE_COOKIE='0', SIMUMAV_ENV_FILE=os.path.join(DATA, 'yok.env'),
                  SIMUMAV_MT_INTERNAL='http://127.0.0.1:1', GOOGLE_MAPS_API_KEY='', SIMUMAV_MAX_SPEEDUP='8')
PORT = int(os.environ.get('SHOT_PORT') or 8747)
BASE = f'http://127.0.0.1:{PORT}'
EXE = os.path.expanduser('~/.cache/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell')
ARGS = ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist']

import requests  # noqa: E402
import uvicorn  # noqa: E402
from playwright.sync_api import sync_playwright  # noqa: E402

import app.simumav.main as smain  # noqa: E402
from app import flightsim  # noqa: E402

server = uvicorn.Server(uvicorn.Config(smain.app, host='127.0.0.1', port=PORT, log_level='error'))
threading.Thread(target=server.run, daemon=True).start()
for _ in range(120):
    try:
        socket.create_connection(('127.0.0.1', PORT), 0.3).close(); break
    except OSError:
        time.sleep(0.25)
else:
    sys.exit('sunucu açılmadı')

H = {'Origin': BASE}
s = requests.Session()
assert s.post(f'{BASE}/api/session', json={'dev_user': 'kaptan'}, headers=H).status_code == 200
tok = s.cookies['smsid']


def api(m, path, body=None):
    r = s.request(m, f'{BASE}{path}', json=body, headers=H)
    assert r.status_code < 300, (path, r.status_code, r.text[:300])
    return r.json() if r.content else None


# ---- tohum: hangar (gerçekçi modeller), mürettebat, parkurlar, görevler
dr = {}
for name, typ, key, color in (('Önleyici X4', 'interceptor', 'glb:icept_x4', '#ef4444'), ('Typhoon Gözcü', 'multirotor', 'glb:typhoon_h480', '#38bdf8'),
                              ('CAYMAZ V3', 'plane', 'builtin:caymaz', '#fbbf24'), ('Yarışçı', 'fpv', 'glb:iris_fpv', '#a78bfa'),
                              ('Haritacı', 'vtol', 'glb:standard_vtol', '#22c55e'), ('Sting', 'interceptor', 'glb:sting', '#f97316')):
    try:
        dr[key] = api('POST', '/api/hangar', {'name': name, 'type': typ, 'model_key': key, 'color': color})
    except AssertionError as e:   # katalogda olmayan anahtar → atla
        print('  hangar atlandı:', e)
icept = dr['glb:icept_x4']
api('PUT', f"/api/hangar/{icept['id']}", {'is_default': True})
for nm, ch in (('Defne', 'p04'), ('Atlas', 'p02'), ('Mira', 'p07'), ('Kuzey', 'p03'), ('Ece', 'p05'), ('Baran', 'p06'), ('Lina', 'p08'), ('Tuna', 'p09'), ('Ada', 'p10')):
    try:
        api('POST', '/api/crew', {'name': nm, 'character': ch})
    except AssertionError as e:
        print('  pilot atlandı:', e)
pid = api('GET', '/api/crew')['pilots'][0]['id']
tr = api('POST', '/api/tracks', {'name': 'Savunma Sahası', 'lat': 40.10, 'lon': 33.40, 'radius_m': 1500, 'world_mode': 'procedural',
                                 'world': {'seed': 21, 'runway': True, 'tree_density': 0.25, 'building_count': 24, 'runway_deg': 30}})
api('PUT', f"/api/tracks/{tr['id']}", {'is_default': True})
api('POST', '/api/tracks', {'name': 'Kapadokya Vadisi', 'lat': 38.643, 'lon': 34.828, 'radius_m': 2000, 'world_mode': 'procedural', 'wind': {'speed_ms': 6, 'dir_deg': 240, 'gust': 2},
                            'time_of_day': 'dusk', 'weather': 'clear', 'world': {'seed': 7}, 'gates': []})
api('POST', '/api/tracks', {'name': 'Karlı Geçit', 'lat': 39.92, 'lon': 41.27, 'radius_m': 1500, 'world_mode': 'procedural', 'time_of_day': 'day', 'weather': 'snow', 'world': {'seed': 3}, 'gates': []})
mis = api('POST', '/api/missions', {'track_id': tr['id'], 'name': 'Üs savunması', 'kind': 'defend',
                                    'plan': {'kind': 'defend', 'defend': {'seed': 4242, 'waves': 1, 'difficulty': 'easy', 'prep_s': 25, 'radius_m': 100, 'interceptors': 10}}})
# rota görevleri (kart önizlemeleri dolu görünsün): parkur merkezinin çevresinde
import math  # noqa: E402


def rota(noktalar, alt=60):
    return {'route': {'points': [{'seq': i, 'cmd': 16, 'lat': round(40.10 + n / 111320, 7), 'lon': round(33.40 + e / (111320 * math.cos(math.radians(40.10))), 7),
                                  'alt_rel': alt, 'frame': 3} for i, (e, n) in enumerate(noktalar)]}}


kor = [(-600, -300), (-200, -100), (200, 50), (600, 250), (900, 500)]
tar = [(x, y) for i, x in enumerate(range(-500, 501, 125)) for y in ((-400, 400) if i % 2 == 0 else (400, -400))]
ila = [(x, y) for i, x in enumerate(range(-300, 301, 60)) for y in ((-250, 250) if i % 2 == 0 else (250, -250))]
ser = [(400 * math.cos(a / 8 * math.tau), 300 * math.sin(a / 8 * math.tau)) for a in range(9)]
for nm, kind, pts, alt in (('Vadi koridoru', 'corridor', kor, 80), ('Tarla taraması', 'survey', tar, 70), ('İlaçlama 3. parsel', 'spray', ila, 8),
                           ('Serbest tur', 'free', ser, 90)):
    try:
        api('POST', '/api/missions', {'track_id': tr['id'], 'name': nm, 'kind': kind, 'plan': rota(pts, alt)})
    except AssertionError as e:
        print('  görev atlandı:', e)
hatalar = []
ONLY = {x for x in os.environ.get('MEDIA_ONLY', '').split(',') if x}
secili = lambda k: not ONLY or k in ONLY   # noqa: E731


def bekle(pred, sec, ad):
    t0 = time.time()
    while time.time() - t0 < sec:
        try:
            if pred():
                return True
        except Exception:   # noqa: BLE001
            pass
        time.sleep(0.25)
    hatalar.append(f'{ad}: {sec} sn içinde olmadı'); return False


def shot(pg, ad, el=None, **kw):
    if el:
        pg.locator(el).first.screenshot(path=str(RAW / ad), **kw)
    else:
        pg.screenshot(path=str(RAW / ad), **kw)
    print('  kare', ad, flush=True)


SIMJ = 'window.__smSession.sim'
HUD = "(document.querySelector('.fs-mhud')?.__hud?.targets?.() || null)"


def kilit(pg, i):
    for _ in range(6):
        if pg.evaluate(f"{SIMJ}.targetLock && {SIMJ}.targetLock.auto === false && {SIMJ}.targetLock.i === {i}"):
            return True
        pg.keyboard.press('Tab'); pg.wait_for_timeout(150)
    return False


def uc_ac(pg, body, hazir_js):
    f = s.post(f'{BASE}/api/fly/start', json=body, headers=H)
    assert f.status_code == 201, f.text
    fid, sid = f.json()['flight_id'], f.json()['sim_id']
    pg.goto(f'{BASE}/app/#/menu', wait_until='domcontentloaded'); pg.wait_for_timeout(500)
    pg.goto(f'{BASE}/app/#/fly/{fid}', wait_until='domcontentloaded')
    pg.wait_for_function(hazir_js, timeout=240000)
    ss = flightsim.MANAGER.sessions[sid]
    bekle(lambda: ss.state == 'HAZIR', 60, 'HAZIR')
    return fid, sid, ss


def cmd(sid, name, **params):
    s.post(f'{BASE}/api/drone/sim/sessions/{sid}/cmd', json={'name': name, 'params': params}, headers=H)


def surukle(pg, sel, dx, dy, steps=12):
    bb = pg.locator(sel).first.bounding_box()
    x, y = bb['x'] + min(40, bb['width'] / 2), bb['y'] + bb['height'] / 2
    pg.mouse.move(x, y); pg.mouse.down()
    for i in range(1, steps + 1):
        pg.mouse.move(x + dx * i / steps, y + dy * i / steps); pg.wait_for_timeout(16)
    pg.mouse.up(); pg.wait_for_timeout(300)


def buyut(pg, scr, dx, dy):
    """Radar/EO penceresini taşı-büyüt (HEPGO §29 taşınabilir pencereler): sağ alt tutamaç."""
    surukle(pg, f'.fs-site-scr.{scr} .fs-site-grip', dx, dy)


ORTU_GIZLE = """() => { const hid = [];
  const site = [...document.querySelectorAll('.fs-site-scr')];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const RE = /MISSION PLANNER|Simülasyon hızı|VURULDU|ÖNLEME ·|DALGA|tehdit/;
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (!RE.test(n.nodeValue || '')) continue;
    let e = n.parentElement;
    if (!e || site.some(w => w.contains(e))) continue;
    while (e.parentElement && !/absolute|fixed/.test(getComputedStyle(e).position)) e = e.parentElement;
    if (e && e !== document.body && !site.some(w => e.contains(w)) && !e.querySelector('canvas')) { e.style.visibility = 'hidden'; hid.push(String(e.className).slice(0, 40)); }
  }
  return hid; }"""


def ortu_gizle(pg):
    """Radar/EO kırpımlarının ÜSTÜNE binen geçici katmanları (bildirim akışı, MP kartı) gizle (metinle bulunur; pencere içi hariç)."""
    return pg.evaluate(ORTU_GIZLE)


def panel_gizle(pg):
    """Harekât panelini gizle (sade, sinematik kare): açıkken düğme .primary."""
    pg.evaluate("(() => { const b = document.querySelector('.fs-ops-btn.primary'); if (b) b.click(); })()")
    pg.wait_for_timeout(700)


try:
    with sync_playwright() as p:
        b = p.chromium.launch(executable_path=EXE, args=ARGS)
        ctx = b.new_context(viewport={'width': 1440, 'height': 900}, locale='tr-TR', device_scale_factor=float(os.environ.get('MEDIA_DSF') or 1))
        ctx.add_cookies([{'name': 'smsid', 'value': tok, 'url': BASE}])
        ctx.add_init_script("try { localStorage.setItem('sm:lang', 'tr'); localStorage.setItem('simumav.consent', 'denied'); localStorage.setItem('fs.cam.pip', JSON.stringify({ on: false })); } catch (e) {}")
        pg = ctx.new_page()
        pg.set_default_timeout(150000)
        pg.on('pageerror', lambda e: hatalar.append('SAYFA: ' + str(e)[:400]))
        pg.on('console', lambda m: hatalar.append(f'KONSOL: {m.text[:300]}') if m.type == 'error' and 'WebGL' not in m.text and 'GPU stall' not in m.text and 'Failed to load resource' not in m.text else None)
        # ---- modül ekranları
        pg.goto(f'{BASE}/app/#/menu', wait_until='domcontentloaded')
        pg.wait_for_timeout(1500)
        if secili('mod'):
            pg.wait_for_selector('.menu-grid', timeout=60000)
            try:
                pg.wait_for_selector('.menu-live.on', state='attached', timeout=60000)
            except Exception:   # noqa: BLE001
                hatalar.append('menü canlı sahne gelmedi')
            pg.wait_for_timeout(5000); shot(pg, 'menu.png')
            for ad, rota, sec, bek in (('hangar.png', 'hangar', '.strip', 5000), ('crew.png', 'crew', '.crew-grid', 2500), ('tracks.png', 'tracks', '.track-card', 4000),
                                       ('missions.png', 'missions', '.mission-card', 2500)):
                pg.goto(f'{BASE}/app/#/{rota}', wait_until='domcontentloaded'); pg.wait_for_selector(sec, timeout=60000); pg.wait_for_timeout(bek); shot(pg, ad)
            pg.goto(f'{BASE}/app/#/fly', wait_until='domcontentloaded'); pg.wait_for_selector('.sm-wizard .sm-cards-drones', timeout=60000); pg.wait_for_timeout(6000)
            shot(pg, 'wizard.png')
            # fırlatıcı adımı (dron → parkur → fırlatıcı)
            try:
                for _ in range(2):
                    pg.click('.sm-nav-btn.primary'); pg.wait_for_timeout(600)
                pg.wait_for_selector('.sm-icept-pod4', timeout=20000); pg.wait_for_timeout(9000)
                shot(pg, 'launcher-wizard.png')
            except Exception as e:   # noqa: BLE001
                hatalar.append(f'fırlatıcı adımı: {str(e)[:160]}')

        # ---- uçuş 1: "Yer kontrolünü koru" (görev şeridi, radar, EO, istasyon) + görev raporu
        if secili('defend'):
            fid1, sid, ss = uc_ac(pg, {'drone_id': icept['id'], 'pilot_id': pid, 'track_id': tr['id'], 'mission_id': mis['id'], 'record': {'bin': False},
                                       'site': {'station': True, 'radar': True, 'radar_km': 10, 'eo': True, 'eo_km': 5}},
                                  '() => window.__smSession && window.__smSession.sim && window.__smSession.sim.siteInfo() && window.__smSession.sim.siteInfo().rackN === 10')
            panel_gizle(pg)
            cmd(sid, 'takeoff', alt=60); cmd(sid, 'speed', factor=2)   # istasyon üstünde askı: önleme yarıçapına (100 m) giren tehdit önlenir
            bekle(lambda: (ss.tele.get('alt_rel') or 0) > 50, 90, 'kalkış')
            pg.evaluate(f"{SIMJ}.setCamera('follow')")
            bekle(lambda: ss.savunma.durum()['spawned'] >= 1, 240, 'tehdit doğuşu')
            items = pg.evaluate(f'({SIMJ}.radarInfo()?.items || [])')
            if items:
                bb = pg.locator('.fs-site-scr.radar .fs-site-bd').bounding_box()
                pg.mouse.click(bb['x'] + items[0]['x'], bb['y'] + items[0]['y'])
                bekle(lambda: pg.evaluate(f'{SIMJ}.eoInfo()?.status') in ('track', 'out'), 30, 'EO izleme')
            shot(pg, 'defend-fly.png')
            cmd(sid, 'speed', factor=8)
            if bekle(lambda: ss.savunma.bitti is not None, 480, 'görev sonu'):
                try:
                    pg.wait_for_selector('.fs-def-rp', timeout=150000); pg.wait_for_timeout(2500)
                    shot(pg, 'defend-report.png', el='.fs-def-rp', animations='disabled')
                    print('  rapor:', pg.inner_text('.fs-def-rp')[:120].replace('\n', ' '), flush=True)
                except Exception as e:   # noqa: BLE001
                    hatalar.append(f'rapor: {str(e)[:160]}')
            s.post(f'{BASE}/api/fly/{fid1}/stop', json={}, headers=H)
            pg.goto(f'{BASE}/app/#/menu', wait_until='domcontentloaded'); pg.wait_for_timeout(3000)

        # ---- uçuş 2: hedefler (görev yok → zaman baskısı yok) + yer kontrol sahası: radar / EO kırpımları; sonra gimbal F-16 sembolojisi + termal
        if secili('tgt'):
            targets = {'items': [{'model': 'tgt:lancet', 'alt_m': 40, 'diameter_m': 300, 'speed_ms': 30, 'dir': 'cw', 'name': 'Lancet-1'},
                                 {'model': 'tgt:octopus', 'alt_m': 70, 'diameter_m': 600, 'east_m': 200, 'north_m': 150, 'speed_ms': 50, 'dir': 'ccw', 'name': 'Octopus-1'},
                                 {'model': 'tgt:altius', 'alt_m': 55, 'diameter_m': 400, 'east_m': -250, 'north_m': -100, 'dir': 'cw', 'name': 'Altius-1'}], 'radius_m': 25}
            fid2, sid, ss = uc_ac(pg, {'drone_id': icept['id'], 'pilot_id': pid, 'track_id': tr['id'], 'record': {'bin': False}, 'targets': targets,
                                       'site': {'station': True, 'radar': True, 'radar_km': 5, 'eo': True, 'eo_km': 5}},
                                  '() => window.__smSession && window.__smSession.sim && window.__smSession.sim.targetsInfo().length === 3')
            panel_gizle(pg)
            try:   # radar/EO pencerelerini büyüt (yukarı taşı + tutamaçla genişlet)
                surukle(pg, '.fs-site-scr.radar .fs-site-hd', 0, -330); pg.wait_for_timeout(900); buyut(pg, 'radar', 260, 190); pg.wait_for_timeout(600)
                surukle(pg, '.fs-site-scr.eo .fs-site-hd', 300, -330); pg.wait_for_timeout(900); buyut(pg, 'eo', 260, 190)
                print('  pencereler:', pg.evaluate("[...document.querySelectorAll('.fs-site-scr')].map(e => [e.className, Math.round(e.getBoundingClientRect().width), Math.round(e.getBoundingClientRect().height)])"), flush=True)
            except Exception as e:   # noqa: BLE001
                hatalar.append(f'pencere büyütme: {str(e)[:160]}')
            pg.wait_for_timeout(4000)
            items = pg.evaluate(f'({SIMJ}.radarInfo()?.items || [])')
            print('  radar öğeleri:', len(items), flush=True)
            if items:   # radar tıklamasıyla aynı yol: lockTarget(i) (EO izler); en yavaş/uzak hedef (Altius-1) → gimbal kadrajda tutar
                pg.evaluate(f"{SIMJ}.lockTarget({items[-1]['i']})")
            bekle(lambda: pg.evaluate(f'{SIMJ}.eoInfo()?.status') == 'track' and not pg.evaluate(f'{SIMJ}.eoInfo()?.slewing'), 60, 'EO izleme')
            pg.wait_for_timeout(4000)
            print('  eo:', pg.evaluate(f'{SIMJ}.eoInfo()'), flush=True)
            print('  gizlenen:', ortu_gizle(pg), flush=True)
            shot(pg, 'radar.png', el='.fs-site-scr.radar')
            for typ in ('day', 'thermal', 'night'):
                pg.evaluate(f"{SIMJ}.setEoType('{typ}')"); pg.wait_for_timeout(1500)
                ortu_gizle(pg)
                shot(pg, f'eo-{typ}.png', el='.fs-site-scr.eo')
            pg.evaluate(f"{SIMJ}.setEoType('day')")
            pg.evaluate("document.querySelectorAll('.fs-site-scr').forEach(e => { e.style.visibility = 'hidden'; })")   # gimbal karelerinde pencereler yok
            cmd(sid, 'takeoff', alt=40)
            bekle(lambda: (ss.tele.get('alt_rel') or 0) > 39 and (ss.tele.get('groundspeed') or 0) > 5, 60, 'kalkış + daire')
            pg.evaluate(f"{SIMJ}.setCamera('fpv'); {SIMJ}.setGimbal(8)"); pg.wait_for_timeout(3500)
            acik = pg.evaluate(f"({HUD}?.items || []).filter(r => r.on).map(r => r.i)")
            if acik:
                kilit(pg, acik[0]); pg.wait_for_timeout(1200)
            shot(pg, 'tgt-gimbal.png')
            pg.evaluate(f"{SIMJ}.setCamType('thermal')"); pg.wait_for_timeout(3000)
            shot(pg, 'tgt-thermal.png')
            pg.evaluate(f"{SIMJ}.setCamType('day')")
            s.post(f'{BASE}/api/fly/{fid2}/stop', json={}, headers=H)
            pg.goto(f'{BASE}/app/#/menu', wait_until='domcontentloaded'); pg.wait_for_timeout(3000)

        # ---- uçuş 3: el fırlatıcısı NİŞANGÂH
        if secili('launch'):
            targets = {'items': [{'model': 'tgt:lancet', 'alt_m': 120, 'diameter_m': 400, 'east_m': 250, 'north_m': 350, 'speed_ms': 25, 'dir': 'cw', 'name': 'Lancet-1'},
                                 {'model': 'tgt:octopus', 'alt_m': 180, 'diameter_m': 600, 'east_m': 400, 'north_m': 500, 'speed_ms': 40, 'dir': 'ccw', 'name': 'Octopus-1'}], 'radius_m': 25}
            fid3, sid, ss = uc_ac(pg, {'drone_id': icept['id'], 'pilot_id': pid, 'track_id': tr['id'], 'record': {'bin': False}, 'targets': targets,
                                       'launch': {'method': 'handheld', 'aim_az_deg': 30, 'aim_el_deg': 25}},
                                  '() => window.__smSession && window.__smSession.sim && window.__smSession.sim.targetsInfo().length === 2 && window.__smSession.sim.launcherInfo()')
            pg.wait_for_timeout(2000)
            pg.evaluate(f'{SIMJ}.aimAtTarget()'); pg.evaluate(f"{SIMJ}.setScopeZoom(2)")
            pg.evaluate(f"{SIMJ}.setCamera('follow')"); panel_gizle(pg); pg.wait_for_timeout(4000)
            shot(pg, 'launcher-scope.png')
            s.post(f'{BASE}/api/fly/{fid3}/stop', json={}, headers=H)

        # ---- Operasyon (uçuş kartları)
        if secili('ops'):
            pg.goto(f'{BASE}/app/#/ops', wait_until='domcontentloaded'); pg.wait_for_selector('.op-card', timeout=60000); pg.wait_for_timeout(4000)
            shot(pg, 'ops.png')
        b.close()
except Exception:
    try:
        pg.screenshot(path=str(RAW / 'hata.png'))
    except Exception:   # noqa: BLE001
        pass
    raise
finally:
    print('\n'.join(hatalar) if hatalar else 'hata yok')
    server.should_exit = True
    time.sleep(1.0)

publish()
