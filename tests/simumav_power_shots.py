"""SIMUMAV › Güç ve yakıt (docs/simumav.md §10) — görsel doğrulama (Playwright headless shell + SwiftShader; sahte SITL, isteğe bağlı gerçek SITL).
Sunucu aynı süreçte iş parçacığı olarak açılır (arka plan süreci bırakılmaz; betik bitince ölür). Görüntüler /tmp/smpower-shots/:
  01 hangar (güç özeti) · 02 hangar güç düzenleyici · 03 sihirbaz "Güç ve yakıt" (uçak; ★ Önerilen) · 04 sihirbaz (FPV, İngilizce)
  05 uçuş: takip kamerası kadranlar · 08 yakıt bitti bandı · 06 FPV (pilot + OSD) kadranlar · 07 gimbal (askeri HUD) kadranlar · 09 uçuş sonu raporu
  10 Operasyon replay kadranları (yalnız SMP_REAL=1 + HEPGO_SITL_DIR: gerçek SITL .bin kaydı gerekir)
Çalıştırma: export LD_LIBRARY_PATH=/home/gelistirici/build/chromelibs/root/usr/lib/x86_64-linux-gnu
            ./.venv/bin/python -m tests.simumav_power_shots            (SMP_REAL=1 HEPGO_SITL_DIR=/opt/hepgo/sitl/bin → gerçek SITL + replay)
"""
import json
import os
import pathlib
import shutil
import socket
import sqlite3
import sys
import threading
import time

os.environ.setdefault('LD_LIBRARY_PATH', '/home/gelistirici/build/chromelibs/root/usr/lib/x86_64-linux-gnu')
REAL = os.environ.get('SMP_REAL') == '1'
DATA = os.environ.get('SIMUMAV_DATA_DIR') or '/tmp/smpower-data'
shutil.rmtree(DATA, ignore_errors=True)
os.makedirs(DATA, exist_ok=True)
os.environ.update(SIMUMAV_DATA_DIR=DATA, SIMUMAV_DEV_LOGIN='1', HEPGO_SITL='1' if REAL else '0', SIMUMAV_UDP_BASE='25050', SIMUMAV_MAX_FLIGHTS='2',
                  SIMUMAV_MP_PORT_BASE='25900', SIMUMAV_MP_PORT_COUNT='40', SIMUMAV_SECURE_COOKIE='0', SIMUMAV_ENV_FILE=os.path.join(DATA, 'yok.env'),
                  SIMUMAV_MT_INTERNAL='http://127.0.0.1:1', GOOGLE_MAPS_API_KEY='', SIMUMAV_MAX_SPEEDUP='8')
PORT = int(os.environ.get('SHOT_PORT') or 8613)
BASE = f'http://127.0.0.1:{PORT}'
OUT = pathlib.Path('/tmp/smpower-shots'); OUT.mkdir(parents=True, exist_ok=True)
EXE = os.path.expanduser('~/.cache/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell')
ARGS = ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist']

import requests  # noqa: E402
import uvicorn  # noqa: E402
from playwright.sync_api import sync_playwright  # noqa: E402

import app.simumav.main as smain  # noqa: E402
from app import flightsim  # noqa: E402
from app.simumav import config  # noqa: E402

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
cay = s.post(f'{BASE}/api/hangar', json={'name': 'CAYMAZ', 'type': 'plane', 'model_key': 'builtin:caymaz', 'color': '#f97316'}, headers=H).json()
s.put(f"{BASE}/api/hangar/{cay['id']}", json={'is_default': True}, headers=H)
with sqlite3.connect(config.DB_PATH) as c:   # son uçuş ölçümü (★ Önerilen rozeti için)
    pw = {k: v for k, v in cay['power'].items() if k not in ('defaults', 'measured')}
    pw.update(fuel_km_per_l_last=27.8, elec_w_last=33.4, measured_at='2026-10-20T11:42:00')
    c.execute('UPDATE drones SET power = ? WHERE id = ?', (json.dumps(pw), cay['id'])); c.commit()
pid = s.get(f'{BASE}/api/crew').json()['pilots'][0]['id']
tr = s.post(f'{BASE}/api/tracks', json={'name': 'Pist', 'lat': 40.10, 'lon': 33.40, 'radius_m': 1500, 'world_mode': 'procedural',
                                        'world': {'seed': 7, 'runway': True, 'tree_density': 0.0, 'building_count': 0}}, headers=H).json()
s.put(f"{BASE}/api/tracks/{tr['id']}", json={'is_default': True}, headers=H)
hatalar = []


def bekle(pred, sec, ad):
    t0 = time.time()
    while time.time() - t0 < sec:
        if pred():
            return True
        time.sleep(0.2)
    hatalar.append(f'{ad}: {sec} sn içinde olmadı'); return False


def shot(pg, ad):
    pg.screenshot(path=str(OUT / ad))
    print('  kare', ad, flush=True)


try:
    with sync_playwright() as p:
        b = p.chromium.launch(executable_path=EXE, args=ARGS)
        ctx = b.new_context(viewport={'width': 1440, 'height': 900}, locale='tr-TR')
        ctx.add_cookies([{'name': 'smsid', 'value': tok, 'url': BASE}])
        ctx.add_init_script("try { if (!localStorage.getItem('sm:lang')) localStorage.setItem('sm:lang', 'tr'); localStorage.setItem('simumav.consent', 'denied'); } catch (e) {}")
        pg = ctx.new_page()
        pg.on('console', lambda m: hatalar.append(f'KONSOL {m.type}: {m.text[:300]}') if m.type == 'error' and 'WebGL' not in m.text and 'GPU stall' not in m.text and 'Failed to load resource' not in m.text else None)
        pg.on('pageerror', lambda e: hatalar.append('SAYFA: ' + str(e)[:400]))
        pg.on('response', lambda r: hatalar.append(f'HTTP {r.status} {r.url[len(BASE):][:120]}') if r.status >= 400 else None)
        # ---- 01/02 hangar
        pg.goto(f'{BASE}/app/#/hangar', wait_until='domcontentloaded')
        pg.wait_for_selector('.hangar-power .pw-summary', timeout=20000)
        pg.wait_for_timeout(2500)
        shot(pg, '01-hangar.png')
        pg.click('.pw-edit-btn')
        pg.wait_for_selector('.pw-editor .sm-pw-field', timeout=10000)
        pg.wait_for_timeout(600)
        shot(pg, '02-hangar-power-editor.png')
        pg.keyboard.press('Escape')
        # ---- 03 sihirbaz güç adımı (uçak)
        pg.goto(f'{BASE}/app/#/fly', wait_until='domcontentloaded')
        pg.wait_for_selector('.sm-wizard .sm-cards-drones', timeout=60000)
        for _ in range(3):
            pg.click('.sm-nav-btn.primary'); pg.wait_for_timeout(400)
        pg.wait_for_selector('.sm-pw-field', timeout=10000)
        pg.wait_for_timeout(700)
        shot(pg, '03-wizard-power-plane.png')
        assert pg.locator('.sm-pw-chip.sug.on').count() >= 2, 'önerilen rozetleri yok'
        # ---- 04 sihirbaz (FPV, İngilizce)
        pg.evaluate("localStorage.setItem('sm:lang', 'en')")
        pg.goto(f'{BASE}/app/#/fly', wait_until='domcontentloaded'); pg.reload(wait_until='commit', timeout=120000)
        pg.wait_for_selector('.sm-wizard .sm-cards-drones', timeout=60000)
        pg.click('.sm-card.type-fpv'); pg.wait_for_timeout(300)
        for _ in range(2):
            pg.click('.sm-nav-btn.primary'); pg.wait_for_timeout(400)
        pg.wait_for_selector('.sm-pw-field', timeout=10000)
        pg.click('.sm-pw-spd[data-speed="4"]'); pg.wait_for_timeout(500)
        shot(pg, '04-wizard-power-fpv-en.png')
        pg.evaluate("localStorage.setItem('sm:lang', 'tr')"); pg.reload(wait_until='commit', timeout=120000); pg.wait_for_timeout(800)
        # ---- uçuş (sahte SITL): küçük tank ki "yakıt bitti" görülsün; 4× simülasyon hızı
        f = s.post(f'{BASE}/api/fly/start', json={'drone_id': cay['id'], 'pilot_id': pid, 'track_id': tr['id'], 'launch': 'wheels', 'record': {'bin': REAL},
                                                 'power': {'fuel_l': 1.6, 'fuel_km_per_l': 4}, 'speedup': 8}, headers=H)
        assert f.status_code == 201, f.text
        fid, sid = f.json()['flight_id'], f.json()['sim_id']
        ss = flightsim.MANAGER.sessions[sid]
        pg.goto(f'{BASE}/app/#/menu', wait_until='domcontentloaded'); pg.wait_for_timeout(500)
        pg.goto(f'{BASE}/app/#/fly/{fid}', wait_until='domcontentloaded')
        pg.wait_for_function('() => window.__smSession && window.__smSession.sim', timeout=180000)
        bekle(lambda: ss.state == 'HAZIR' and (ss.sahte is not None or getattr(ss, '_heartbeat_alindi', False)), 120, 'HAZIR')
        r = s.post(f'{BASE}/api/drone/sim/sessions/{sid}/cmd', json={'name': 'takeoff', 'params': {'alt': 40}}, headers=H)
        if r.status_code != 200:
            hatalar.append(f'takeoff {r.status_code} {r.text[:200]}')
        bekle(lambda: (ss.tele.get('alt_rel') or 0) > 15 and ss.guc.fuel_l < 1.4, 120, 'kalkış + yakıt düşüşü')
        pg.wait_for_function("() => !document.querySelector('.fs-gauges').hidden", timeout=60000)
        pg.evaluate("window.__smSession.sim.setCamera('follow')"); pg.wait_for_timeout(2500)
        shot(pg, '05-fly-follow.png')
        pg.wait_for_selector('.sm-pw-alert.empty:not([hidden])', timeout=400000)   # bant 5 sn görünür: bitme anında yakala (kare çekimi yavaş)
        pg.wait_for_timeout(900)
        print('  bant:', pg.evaluate("(() => { const e = document.querySelector('.sm-pw-alert'); const c = getComputedStyle(e); return [e.className, c.backgroundImage.slice(0, 60), c.opacity, c.zIndex]; })()"), flush=True)
        shot(pg, '08-fly-fuel-empty.png')
        pg.evaluate("window.__smSession.sim.setCamera('pilot')"); pg.wait_for_timeout(2500)
        shot(pg, '06-fly-fpv.png')
        pg.evaluate("window.__smSession.sim.setCamera('fpv')"); pg.wait_for_timeout(2500)
        shot(pg, '07-fly-gimbal.png')
        pg.evaluate("window.__smSession.sim.setCamera('follow')")
        # ölçüm için ≥ 60 sn simülasyon zamanı
        bekle(lambda: ss.guc.time_s >= 65 and ss.guc.dist_m >= 400, 120, 'ölçüm süresi')
        pg.click('.fs-end-btn'); pg.wait_for_timeout(500)
        pg.click('.modal-foot .btn.danger, .modal-foot .btn.primary')
        pg.wait_for_selector('.sm-pw-report', timeout=90000)
        pg.wait_for_timeout(1200)
        shot(pg, '09-report.png')
        if REAL:
            pg.keyboard.press('Escape'); pg.wait_for_timeout(800)
            pg.goto(f'{BASE}/app/#/ops/{fid}', wait_until='domcontentloaded')
            pg.wait_for_selector('.sm-replay-power .fs-gauges', timeout=180000)
            pg.wait_for_timeout(1500)
            pg.evaluate('window.__smReplay && window.__smReplay.seek(window.__smReplay.t + 40)')
            pg.wait_for_timeout(3000)
            shot(pg, '10-ops-replay.png')
        b.close()
except Exception:
    try:
        pg.screenshot(path=str(OUT / 'hata.png'))
    except Exception:   # noqa: BLE001
        pass
    raise
finally:
    print('\n'.join(hatalar) if hatalar else 'hata yok')
    server.should_exit = True
    time.sleep(1.0)
