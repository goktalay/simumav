"""SIMUMAV — HEPGO §41 it dalaşı: kurucu sihirbazında tür seçimi, davet (2 oyuncu), salon görüntüleri → /tmp/dogfight-shots/df-sm-*.png.
Çalıştırma: .venv/bin/python -m tests.simumav_dogfight_shots
"""
import os
import shutil
import socket
import sys
import threading
import time

os.environ.setdefault('LD_LIBRARY_PATH', '/home/gelistirici/build/chromelibs/root/usr/lib/x86_64-linux-gnu')
DATA = '/tmp/sm-dogfight-shots-data'
SHOTS = '/tmp/dogfight-shots'
shutil.rmtree(DATA, ignore_errors=True)
os.makedirs(DATA, exist_ok=True)
os.makedirs(SHOTS, exist_ok=True)
os.environ.update(SIMUMAV_DATA_DIR=DATA, SIMUMAV_DEV_LOGIN='1', HEPGO_SITL='0', SIMUMAV_UDP_BASE='28650', SIMUMAV_MAX_FLIGHTS='4',
                  SIMUMAV_MP_PORT_BASE='29600', SIMUMAV_MP_PORT_COUNT='20', SIMUMAV_SECURE_COOKIE='0', SIMUMAV_ENV_FILE=os.path.join(DATA, 'yok.env'),
                  SIMUMAV_MT_INTERNAL='http://127.0.0.1:1', GOOGLE_MAPS_API_KEY='')
PORT = 8649
BASE = f'http://127.0.0.1:{PORT}'
EXE = os.path.expanduser('~/.cache/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell')
ARGS = ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist']

import requests  # noqa: E402
import uvicorn  # noqa: E402
from playwright.sync_api import sync_playwright  # noqa: E402

import app.simumav.main as smain  # noqa: E402
from app.simumav import match as M  # noqa: E402

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


def giris(ad):
    s = requests.Session()
    assert s.post(f'{BASE}/api/session', json={'dev_user': ad}, headers=H).status_code == 200
    return s


ali, veli = giris('ali'), giris('veli')
tr = ali.post(f'{BASE}/api/tracks', json={'name': 'Yarış Sahası', 'lat': 40.1, 'lon': 33.4, 'radius_m': 1000, 'world_mode': 'procedural',
                                          'world': {'seed': 5, 'tree_density': 0.15, 'building_count': 4}}, headers=H).json()
assert tr.get('id'), tr
sonuc, hatalar = [], []


def shot(pg, ad):
    pg.screenshot(path=f'{SHOTS}/{ad}.png')
    sonuc.append(ad)
    print('  ·', ad)


def baglam(b, oturum=None):
    ctx = b.new_context(viewport={'width': 1440, 'height': 900}, locale='tr-TR')
    if oturum is not None:
        ctx.add_cookies([{'name': 'smsid', 'value': oturum.cookies['smsid'], 'url': BASE}])
    ctx.add_init_script("try { localStorage.setItem('sm:lang', 'tr'); localStorage.setItem('simumav.consent', 'denied'); } catch (e) {}")
    pg = ctx.new_page()
    pg.set_default_timeout(90000)
    pg.on('pageerror', lambda e: hatalar.append(str(e)[:300]))
    return ctx, pg


try:
    with sync_playwright() as p:
        b = p.chromium.launch(executable_path=EXE, args=ARGS)
        _, pa = baglam(b, ali)
        pa.goto(f'{BASE}/app/#/fly', wait_until='domcontentloaded')
        pa.wait_for_selector('.sm-mode-card.multi')
        pa.click('.sm-mode-card.multi')
        pa.wait_for_selector('.sm-wizard-match .sm-cards-drones')
        pa.click('.sm-nav-btn.primary')
        pa.locator('.sm-cards-tracks .sm-card', has_text='Yarış Sahası').click()
        pa.click('.sm-nav-btn.primary')
        pa.wait_for_selector('.sm-df-kind[data-kind="dogfight"]')
        pa.click('.sm-df-kind[data-kind="dogfight"]')
        pa.click('.sm-df-roles button[data-role="host_chaser"]')
        pa.wait_for_selector('.sm-df-preview svg path', timeout=30000)
        pa.wait_for_timeout(800)
        shot(pa, 'df-sm-01-tur-secimi')
        pa.click('.sm-nav-btn.primary')
        pa.wait_for_selector('.sm-mt-pw')
        pa.fill('.sm-mt-pw', 'DALAS42')
        pa.wait_for_timeout(300)
        shot(pa, 'df-sm-02-davet-2-oyuncu')
        pa.click('.sm-mt-create')
        pa.wait_for_selector('.sm-mt-invite input.mono')
        pa.wait_for_timeout(1000)
        shot(pa, 'df-sm-03-salon')
        b.close()
finally:
    server.should_exit = True
    time.sleep(1)
    print('hatalar:', hatalar or 'yok')
