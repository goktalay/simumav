"""SIMUMAV › Uç — HEPGO simülasyon paritesi görsel/işlevsel doğrulama (Playwright headless shell + SwiftShader; sahte SITL kipi).
Sunucu aynı süreçte iş parçacığı olarak 8605 portunda açılır (arka plan süreci bırakılmaz; betik bitince ölür). Görüntüler /tmp/simumav-par/.
  01 sahne (netsim jitter30,delay40 ile; `net:` etiketi) · 02 sanal kumanda açık (çubuklar, ipucu; W basılı → sunucuda RC override ch3 ↑)
  03 FPV kamerasında çubuklar görünür, panel gizli · 04 kalkış: alt çubuk "Kalkış" akışı (hub: GUIDED → ARM → TAKEOFF) ARM düğmesine basılmadan
  armed + havada · titreme ölçümü: 4 sn boyunca ardışık karelerde dron konumu (sim.position()) tek yönlü ilerler (geri sıçrama yok), motionStats.
Çalıştırma: export LD_LIBRARY_PATH=/home/gelistirici/build/chromelibs/root/usr/lib/x86_64-linux-gnu
            CAYMAZ_FORCE_SECURE_COOKIE=0 ./.venv/bin/python -m tests.simumav_par_shots
"""
import os
import pathlib
import shutil
import socket
import sys
import threading
import time

os.environ.setdefault('LD_LIBRARY_PATH', '/home/gelistirici/build/chromelibs/root/usr/lib/x86_64-linux-gnu')
DATA = os.environ.get('SIMUMAV_DATA_DIR') or '/tmp/simumav-par-data'
shutil.rmtree(DATA, ignore_errors=True)
os.makedirs(DATA, exist_ok=True)
os.environ.update(SIMUMAV_DATA_DIR=DATA, SIMUMAV_DEV_LOGIN='1', HEPGO_SITL='0', SIMUMAV_UDP_BASE='24950', SIMUMAV_MAX_FLIGHTS='2', SIMUMAV_MP_PORT_BASE='25800',
                  SIMUMAV_MP_PORT_COUNT='40', SIMUMAV_SECURE_COOKIE='0', SIMUMAV_ENV_FILE=os.path.join(DATA, 'yok.env'), SIMUMAV_MT_INTERNAL='http://127.0.0.1:1', GOOGLE_MAPS_API_KEY='')
PORT = int(os.environ.get('SHOT_PORT') or 8605)
BASE = f'http://127.0.0.1:{PORT}'
OUT = pathlib.Path('/tmp/simumav-par'); OUT.mkdir(parents=True, exist_ok=True)
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
assert s.post(f'{BASE}/api/session', json={'dev_user': 'ali'}, headers=H).status_code == 200
tok = s.cookies['smsid']
d = s.post(f'{BASE}/api/hangar', json={'name': 'Kopter', 'type': 'multirotor', 'model_key': 'builtin:quad'}, headers=H); assert d.status_code == 201, d.text
pid = s.post(f'{BASE}/api/crew', json={'name': 'Ayşe', 'character': 'p04'}, headers=H).json()['id']
tr = s.post(f'{BASE}/api/tracks', json={'name': 'Pist', 'lat': 40.10, 'lon': 33.40, 'radius_m': 1500, 'world_mode': 'procedural', 'world': {'seed': 7, 'runway': True, 'tree_density': 0.0, 'building_count': 0}}, headers=H)   # yazılımsal GPU: ağaç/bina yok (kare hızı)
assert tr.status_code == 201, tr.text
f = s.post(f'{BASE}/api/fly/start', json={'drone_id': d.json()['id'], 'pilot_id': pid, 'track_id': tr.json()['id'], 'launch': 'wheels', 'record': {'bin': False}}, headers=H)
assert f.status_code == 201, f.text
fid, sid = f.json()['flight_id'], f.json()['sim_id']
ss = flightsim.MANAGER.sessions[sid]
hatalar, sonuc = [], {}


def bekle(pred, sec, ad):
    t0 = time.time()
    while time.time() - t0 < sec:
        if pred():
            return True
        time.sleep(0.1)
    hatalar.append(f'{ad}: {sec} sn içinde olmadı'); return False


try:
    with sync_playwright() as p:
        b = p.chromium.launch(executable_path=EXE, args=ARGS)
        ctx = b.new_context(viewport={'width': 1440, 'height': 900}, locale='tr-TR')
        ctx.add_cookies([{'name': 'smsid', 'value': tok, 'url': BASE}])
        pg = ctx.new_page()
        pg.on('console', lambda m: hatalar.append(f'KONSOL {m.type}: {m.text[:300]}') if m.type == 'error' and 'WebGL' not in m.text else None)
        pg.on('pageerror', lambda e: hatalar.append('SAYFA: ' + str(e)[:400]))
        pg.goto(f'{BASE}/app/?netsim=jitter30,delay40#/fly/{fid}', wait_until='domcontentloaded')
        t = time.time()
        pg.wait_for_function('() => window.__smSession && window.__smSession.sim && window.__fsSim', timeout=120000)
        print('3B sahne hazır (sn):', round(time.time() - t, 1))
        pg.wait_for_function("() => document.querySelector('.fs-stage .fs-net') && document.querySelector('.fs-stage .fs-net').textContent.includes('Hz')", timeout=30000)
        pg.wait_for_timeout(1500)
        pg.screenshot(path=str(OUT / '01-sahne.png'))
        sonuc['net'] = pg.evaluate("document.querySelector('.fs-stage .fs-net').textContent")
        # ---- sanal kumanda: düğme → çubuklar görünür; W basılı → sunucuda RC override (sahte SITL rc[2] ↑); kapat → 8×0 → varsayılan
        assert pg.locator('.fs-rc-btn').count() == 1, 'sanal kumanda düğmesi yok'
        pg.click('.fs-rc-btn')
        pg.wait_for_selector('.fs-sticks:not([hidden])', timeout=5000)
        assert pg.evaluate("document.querySelector('.fs-stage').classList.contains('rc-on') && !!window.__smSession.rc"), 'rc-on yok'
        pg.keyboard.down('w')
        bekle(lambda: ss.sahte.rc[2] >= 1700, 6, 'W → RC override ch3')
        sonuc['rc_w'] = list(ss.sahte.rc)
        pg.wait_for_timeout(300)
        pg.screenshot(path=str(OUT / '02-sanal-kumanda.png'))
        pg.keyboard.up('w')
        # ---- FPV kamerasında (tuş 2 = pilot) çubuklar görünür, panel kartı gizli (.fs-fpv)
        pg.keyboard.press('2')
        pg.wait_for_timeout(1200)
        fpv = pg.evaluate("({cam: window.__smSim.getCamera(), fpv: document.querySelector('.fs-stage').classList.contains('fs-fpv'), sticks: !document.querySelector('.fs-sticks').hidden, kart: getComputedStyle(document.querySelector('.fs-pn-kart') || document.body).display})")
        sonuc['fpv'] = fpv
        if not (fpv['cam'] == 'pilot' and fpv['fpv'] and fpv['sticks']):
            hatalar.append(f'FPV kipinde kumanda/panel durumu beklenmedik: {fpv}')
        pg.screenshot(path=str(OUT / '03-fpv-kumanda.png'))
        pg.keyboard.press('1')
        # dokunmatik: sol çubuk pointer (touch) ile en üste → ch3 2000
        box = pg.locator('.fs-stick[data-side="l"]').bounding_box()
        cx, cy = box['x'] + box['width'] / 2, box['y'] + box['height'] / 2
        pg.mouse.move(cx, cy); pg.mouse.down(); pg.mouse.move(cx, cy - box['height'] / 2 + 2, steps=4)
        bekle(lambda: ss.sahte.rc[2] >= 1950, 5, 'çubuk en üst → ch3 2000')
        sonuc['rc_stick'] = list(ss.sahte.rc)
        pg.mouse.up()
        pg.click('.fs-rc-btn')   # kapat → 8×0 → varsayılan kanallar
        bekle(lambda: list(ss.sahte.rc) == list(flightsim.SahteKinematik.RC_VARSAYILAN), 5, 'kapatınca override serbest')
        assert pg.evaluate("document.querySelector('.fs-sticks').hidden && !window.__smSession.rc")
        # ---- kalkış: ARM düğmesine basılmadan alt çubuk "Kalkış" → modal → onay → hub akışı (GUIDED → ARM → TAKEOFF)
        assert not ss.sahte.armed
        pg.evaluate("window.__smSession.takeoffDialog()")
        pg.wait_for_selector('.modal-back', timeout=5000)
        pg.screenshot(path=str(OUT / '04a-kalkis-pencere.png'))
        pg.click('.modal-back .btn.primary')
        bekle(lambda: ss.sahte.armed and ss.sahte.alt_rel >= 3, 25, 'kalkış: armed + havada')
        sonuc['kalkis'] = {'armed': ss.sahte.armed, 'mode': ss.sahte.mode, 'alt': round(ss.sahte.alt_rel, 1), 'hedef': ss.sahte.hedef_alt}
        pg.wait_for_timeout(1500)
        pg.screenshot(path=str(OUT / '04-kalkis.png'))
        # ---- Esc → "Uçuştan çık" onayı (HEPGO onKeyBack paritesi); Vazgeç
        pg.keyboard.press('Escape')
        pg.wait_for_selector('.modal-back', timeout=5000)
        pg.click('.modal-back .btn:not(.primary):not(.danger)')
        pg.wait_for_timeout(300)
        ctx.close()   # büyük tuval SwiftShader'da ~1 fps: ölçüm için küçük tuvalli ikinci izleyici sayfası (aynı uçuş; sahte tele 50 Hz + netsim)
        # ---- titreme: 6 sn ardışık karelerde dron konumu tek yönlü (tırmanış + daire: adım yönü tersine dönmez, irtifa geri gitmez); motionStats
        ctx2 = b.new_context(viewport={'width': 420, 'height': 260}, device_scale_factor=1, locale='tr-TR')
        ctx2.add_cookies([{'name': 'smsid', 'value': tok, 'url': BASE}])
        p2 = ctx2.new_page()
        p2.on('pageerror', lambda e: hatalar.append('SAYFA2: ' + str(e)[:400]))
        p2.goto(f'{BASE}/app/?netsim=jitter30,delay40#/fly/{fid}', wait_until='domcontentloaded')
        p2.wait_for_function('() => window.__smSession && window.__smSession.sim && window.__fsSim', timeout=120000)
        p2.wait_for_timeout(2500)
        olcum = p2.evaluate("""() => new Promise(res => {
          const sim = window.__smSim; sim.motionStats(true);
          let prev = null, prevD = null, frames = 0, back = 0, backZ = 0, maxStep = 0, zero = 0; const t0 = performance.now();
          const tick = () => {
            const q = sim.position();
            if (prev) { const d = { x: q.x - prev.x, y: q.y - prev.y, z: q.z - prev.z }; const L = Math.hypot(d.x, d.y, d.z); frames++;
              if (L < 1e-5) zero++; else { if (d.z < -1e-4) backZ++; if (prevD && (d.x * prevD.x + d.y * prevD.y + d.z * prevD.z) < 0) back++; prevD = d; }
              maxStep = Math.max(maxStep, L); }
            prev = q;
            if (performance.now() - t0 < 6000) requestAnimationFrame(tick); else { const m = sim.motionStats(false), n = sim.netStats();
              res({ frames, back, backZ, zero, maxStep: +maxStep.toFixed(3), fps: Math.round(frames / 6), posJerk: +m.posJerk.toFixed(4), angJerk: +m.angJerk.toFixed(4), dr: m.drEnters, delay: n.delay, jitter: n.jitter, hz: n.hz }); }
          };
          requestAnimationFrame(tick);
        })""")
        sonuc['titreme'] = olcum
        p2.screenshot(path=str(OUT / '05-olcum-kucuk-tuval.png'))
        # Kabul yalnız render döngüsü çalışıyorsa (≥ 12 fps): SwiftShader (GPU'suz) ana iş parçacığını kareler arasında yüzlerce ms bloklar; o zaman
        # alım zamanları da geç damgalanır (jitter > 100 ms görünür) ve ölçüm render'ı değil CPU'yu ölçer. Tam kabul testi tarayıcısızdır:
        # tests/test_simumav_rc.mjs (50 Hz jitter'lı/kayıplı tele → createTimeline → ardışık karelerde tek yönlü ilerleme).
        if olcum['fps'] >= 12:
            if olcum['back'] > max(1, olcum['frames'] * 0.02) or olcum['backZ'] > max(1, olcum['frames'] * 0.02):
                hatalar.append(f'titreme: geri sıçrama var {olcum}')
            if olcum['dr'] > 2:
                hatalar.append(f'titreme: sık ölü hesap {olcum}')
        else:
            print(f"titreme: {olcum['fps']} fps (yazılımsal GPU) → tarayıcı içi kabul atlandı; bkz. tests/test_simumav_rc.mjs")
        ctx2.close()
        b.close()
finally:
    s.post(f'{BASE}/api/fly/{fid}/stop', json={}, headers=H)

for k, v in sonuc.items():
    print(f'{k}: {v}')
print('görüntüler:', sorted(p.name for p in OUT.iterdir()))
if hatalar:
    print('HATALAR:', *hatalar, sep='\n  ')
    sys.exit(1)
print('simumav_par_shots: TAMAM')
