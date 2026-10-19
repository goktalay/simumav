#!/usr/bin/env python3
"""SIMUMAV gerçekçi dron modelleri görsel doğrulama (Playwright headless shell + SwiftShader).
Geçici SIMUMAV sunucusu (uvicorn, port SIMUMAV_SHOT_PORT=8606, SIMUMAV_DATA_DIR geçici, dev login, sahte SITL, Google anahtarı yok → prosedürel dünya):
dev oturumu → her tür için katalogdaki ilk GLB modelle dron eklenir → Hangar şeridi + her dronun dönen 3B'si, sihirbaz tür seçici, Uç sihirbazı
dron önizlemesi (prosedürel dünyada gerçek sahne modeli) görüntülenir → /tmp/simumav-mdl/*.png. Konsol/sayfa hataları raporlanır.
Çalıştırma: tests/simumav_models_shots.py  (çıkış kodu 1: sayfa hatası ya da GLB yüklenemedi)."""
import json
import os
import pathlib
import socket
import subprocess
import sys
import tempfile
import time

os.environ.setdefault('LD_LIBRARY_PATH', '/home/gelistirici/build/chromelibs/root/usr/lib/x86_64-linux-gnu')
from playwright.sync_api import sync_playwright  # noqa: E402

ROOT = pathlib.Path(__file__).resolve().parents[1]
OUT = pathlib.Path(os.environ.get('SIMUMAV_SHOT_OUT', '/tmp/simumav-mdl'))
PORT = int(os.environ.get('SIMUMAV_SHOT_PORT', '8606'))
EXE = os.path.expanduser('~/.cache/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell')
ARGS = ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist']


def bekle_port(port, sn=40):
    t0 = time.time()
    while time.time() - t0 < sn:
        with socket.socket() as s:
            s.settimeout(0.5)
            if s.connect_ex(('127.0.0.1', port)) == 0:
                return True
        time.sleep(0.3)
    return False


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    data = os.environ.get('SIMUMAV_DATA_DIR') or tempfile.mkdtemp(prefix='simumav-mdl-data-')
    base = f'http://127.0.0.1:{PORT}'
    env = {**os.environ, 'SIMUMAV_DATA_DIR': data, 'SIMUMAV_DEV_LOGIN': '1', 'SIMUMAV_SECURE_COOKIE': '0', 'HEPGO_SITL': '0', 'GOOGLE_MAPS_API_KEY': '',
           'SIMUMAV_ALLOWED_ORIGINS': base, 'SIMUMAV_MT_INTERNAL': 'http://127.0.0.1:1', 'SIMUMAV_ENV_FILE': os.path.join(data, 'yok.env'),
           'SIMUMAV_MP_PORT_BASE': '25700', 'SIMUMAV_UDP_BASE': '24850'}
    srv = subprocess.Popen([str(ROOT / '.venv/bin/uvicorn'), 'app.simumav.main:app', '--host', '127.0.0.1', '--port', str(PORT), '--log-level', 'warning'],
                           cwd=str(ROOT), env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    hatalar, glb_ok = [], {}
    try:
        assert bekle_port(PORT), 'sunucu açılmadı'
        with sync_playwright() as p:
            b = p.chromium.launch(executable_path=EXE, args=ARGS)
            ctx = b.new_context(viewport={'width': 1440, 'height': 900}, locale='tr-TR', base_url=base)
            r = ctx.request.post('/api/session', data={'dev_user': 'modelci'}, headers={'Origin': base, 'Content-Type': 'application/json'})
            assert r.ok, r.text()
            cat = ctx.request.get('/api/hangar/catalog').json()['types']
            adlar = {'multirotor': 'Iris', 'plane': 'Cessna', 'heli': 'Heli', 'vtol': 'VTOL', 'interceptor': 'Jet'}
            for t in cat:
                if t['key'] == 'fpv':
                    continue
                m = t['models'][0]
                r = ctx.request.post('/api/hangar', data=json.dumps({'name': adlar[t['key']], 'type': t['key'], 'model_key': m['key'], 'color': '#38bdf8'}),
                                     headers={'Origin': base, 'Content-Type': 'application/json'})
                assert r.status == 201, r.text()
            # ek: hexa ve Zephyr (ikincil modeller)
            for ad, tip, key in (('Typhoon', 'multirotor', 'glb:typhoon_h480'), ('Zephyr', 'interceptor', 'glb:zephyr'), ('X500', 'multirotor', 'glb:x500'), ('Believer', 'plane', 'glb:believer')):
                r = ctx.request.post('/api/hangar', data=json.dumps({'name': ad, 'type': tip, 'model_key': key, 'color': '#f97316'}), headers={'Origin': base, 'Content-Type': 'application/json'})
                assert r.status == 201, r.text()
            drones = ctx.request.get('/api/hangar').json()['drones']
            for d in drones:
                glb_ok[d['name']] = ctx.request.get(d['preview']).ok if d.get('preview') else None
            pg = ctx.new_page()
            pg.on('console', lambda m: hatalar.append(f'KONSOL {m.type}: {m.text[:300]}') if m.type == 'error' else None)
            pg.on('pageerror', lambda e: hatalar.append('SAYFA: ' + str(e)[:400]))
            # ---- Hangar: şerit + seçili dronun dönen GLB'si
            pg.goto('/app/#/hangar', wait_until='networkidle')
            pg.wait_for_selector('.strip-card', timeout=60000)
            pg.wait_for_timeout(3500)
            pg.screenshot(path=str(OUT / '01-hangar.png'))
            for i, d in enumerate(drones):
                pg.click(f'.strip-card[data-id="{d["id"]}"]')
                pg.wait_for_timeout(2500)
                pg.screenshot(path=str(OUT / f'02-hangar-{i:02d}-{d["name"].lower()}.png'))
            # ---- Sihirbaz: tür seçici (katalogdaki ilk GLB ile önizleme)
            pg.click('.plus-btn')
            pg.wait_for_selector('.hsel', timeout=20000)
            pg.wait_for_timeout(3000)
            pg.screenshot(path=str(OUT / '03-wizard-type-fpv.png'))
            pg.focus('.hsel')
            for k, ty in enumerate(['multirotor', 'plane', 'heli', 'vtol', 'interceptor'][:0]):
                pass
            for k in range(5):
                pg.keyboard.press('ArrowRight'); pg.wait_for_timeout(2200)
                pg.screenshot(path=str(OUT / f'03-wizard-type-{k + 1}.png'))
            # ---- Uç sihirbazı: dron adımı — prosedürel dünyada sahne modeli (flightsim3d buildLibrary)
            pg.goto('/app/#/fly', wait_until='networkidle')
            pg.wait_for_selector('.sm-cards-drones .sm-card', timeout=60000)
            n = len(pg.query_selector_all('.sm-cards-drones .sm-card'))
            for i in range(n):   # kartlar her seçimde yeniden çizilir → her seferinde yeniden seç
                c = pg.locator('.sm-cards-drones .sm-card').nth(i)
                ad = drones[i]['name'].lower() if i < len(drones) else str(i)
                c.click()
                pg.wait_for_timeout(6000)
                pg.screenshot(path=str(OUT / f'04-fly-{i:02d}-{ad}.png'))
            b.close()
    except Exception:
        print('hatalar (kesinti anında):', json.dumps(hatalar, ensure_ascii=False, indent=1)); raise
    finally:
        srv.terminate()
        try:
            srv.wait(timeout=8)
        except subprocess.TimeoutExpired:
            srv.kill()
    print('GLB önizlemeleri:', glb_ok)
    print('görüntüler:', sorted(p.name for p in OUT.iterdir()))
    print('hatalar:', json.dumps(hatalar, ensure_ascii=False, indent=1) if hatalar else 'yok')
    return 1 if any('SAYFA' in h for h in hatalar) or not all(glb_ok.values()) else 0


if __name__ == '__main__':
    sys.exit(main())
