"""SIMUMAV geri düğmesi (İSTEK 57): Görevler / Parkurlar / Hangar alt ekranlarında üst sol "geri" düğmesi listeye döndürür.

Kök neden: alt ekran (görev düzenleyici, parkur düzenleyici, hangar sihirbazı) aynı hash rotasında açılıyordu; setBack('…', 'missions')
location.hash'i aynı değere yazınca hashchange olmuyor, düğme hiçbir şey yapmıyordu. app.js setBack artık aynı rotada modülü yeniden kurar.
Çalıştırma: .venv/bin/python -m tests.simumav_back_e2e
"""
import os
import shutil
import socket
import sys
import threading
import time

os.environ.setdefault('LD_LIBRARY_PATH', '/home/gelistirici/build/chromelibs/root/usr/lib/x86_64-linux-gnu')
DATA = '/tmp/sm-back-data'
shutil.rmtree(DATA, ignore_errors=True)
os.makedirs(DATA, exist_ok=True)
os.environ.update(SIMUMAV_DATA_DIR=DATA, SIMUMAV_DEV_LOGIN='1', HEPGO_SITL='0', SIMUMAV_UDP_BASE='25450', SIMUMAV_MAX_FLIGHTS='2',
                  SIMUMAV_MP_PORT_BASE='26400', SIMUMAV_MP_PORT_COUNT='20', SIMUMAV_SECURE_COOKIE='0', SIMUMAV_ENV_FILE=os.path.join(DATA, 'yok.env'),
                  SIMUMAV_MT_INTERNAL='http://127.0.0.1:1', GOOGLE_MAPS_API_KEY='')
PORT = 8631
BASE = f'http://127.0.0.1:{PORT}'
EXE = os.path.expanduser('~/.cache/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell')
ARGS = ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist']

import requests  # noqa: E402
import uvicorn  # noqa: E402
from playwright.sync_api import sync_playwright  # noqa: E402

import app.simumav.main as smain  # noqa: E402

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
s = requests.Session()
assert s.post(f'{BASE}/api/session', json={'dev_user': 'ayse'}, headers=H).status_code == 200
tok = s.cookies['smsid']
tr = s.post(f'{BASE}/api/tracks', json={'name': 'Geri Testi', 'lat': 40.1, 'lon': 33.4, 'radius_m': 800, 'world_mode': 'procedural', 'world': {'seed': 3}}, headers=H).json()
s.post(f'{BASE}/api/missions', json={'track_id': tr['id'], 'name': 'Rota', 'kind': 'defend', 'plan': {'kind': 'defend', 'defend': {'seed': 7, 'waves': 1, 'difficulty': 'easy', 'prep_s': 20, 'radius_m': 100, 'interceptors': 10}}}, headers=H)
assert s.get(f'{BASE}/api/missions').json()['missions'], 'görev oluşturulamadı'
sonuc = []
try:
    with sync_playwright() as p:
        b = p.chromium.launch(executable_path=EXE, args=ARGS)
        ctx = b.new_context(viewport={'width': 1440, 'height': 900}, locale='tr-TR')
        ctx.add_cookies([{'name': 'smsid', 'value': tok, 'url': BASE}])
        ctx.add_init_script("try { localStorage.setItem('sm:lang', 'tr'); localStorage.setItem('simumav.consent', 'denied'); } catch (e) {}")
        pg = ctx.new_page()
        pg.set_default_timeout(60000)
        hatalar = []
        pg.on('pageerror', lambda e: hatalar.append(str(e)[:300]))

        def geri_dene(ad, rota, ac, liste_sec, alt_sec):
            pg.goto(f'{BASE}/app/#/{rota}', wait_until='domcontentloaded')
            pg.wait_for_selector(liste_sec, timeout=60000)
            pg.wait_for_timeout(800)
            ac()
            pg.wait_for_selector(alt_sec, timeout=60000)
            pg.wait_for_timeout(800)
            assert pg.locator('#back').is_visible(), f'{ad}: geri düğmesi görünmüyor'
            pg.click('#back')
            try:
                pg.wait_for_selector(alt_sec, state='detached', timeout=15000)
                pg.wait_for_selector(liste_sec, timeout=15000)
                sonuc.append((ad, True))
            except Exception as e:   # noqa: BLE001
                sonuc.append((ad, False, str(e)[:200]))

        # Görevler: mevcut görev kartı → düzenleyici → geri
        geri_dene('Görevler › düzenleyici', 'missions', lambda: pg.locator('.mission-card').first.click(), '.mission-card', '.track-editor, canvas.plan')
        # Görevler: yeni → parkur seçimi → geri
        geri_dene('Görevler › parkur seçimi', 'missions', lambda: pg.locator('.plus-holder button, .plus-holder .plus').first.click(), '.mission-card', '.steps')
        # Parkurlar: kart → düzenleyici → geri
        geri_dene('Parkurlar › düzenleyici', 'tracks', lambda: pg.locator('.strip-card').first.click(), '.strip-card', '.track-editor')
        print('sayfa hataları:', hatalar or 'yok')
        b.close()
finally:
    server.should_exit = True
    shutil.rmtree(DATA, ignore_errors=True)

for r in sonuc:
    print(('TAMAM ' if r[1] else 'HATA  ') + r[0] + ('' if r[1] else ' — ' + r[2]))
sys.exit(0 if sonuc and all(r[1] for r in sonuc) else 1)
