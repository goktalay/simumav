"""SIMUMAV — HEPGO §44 yapay zekâ pilot + oyun efektleri görselleri → /tmp/aibot-shots/sm-*.png (sahte SITL; bot sürücüleri sunucuda):
  01 Uç seçim ekranı ("Yapay zekâya karşı" Çok oyunculu altında) · 02 salonda kurucu bot ekler (AI · seviye rozeti, ekle düğmeleri) ·
  03 "Yapay zekâya karşı" sihirbazı: yapay zekâ adımı (seviye + rakip sayısı) · 04 yarış ekranı: 3B'de botlar + sıralama ·
  05 sonuç: AI rozeti + puan sayacı · 06 ses kapsülü menüsünde "Oyun efektleri".
Çalıştırma: .venv/bin/python -m tests.simumav_aibot_shots
"""
import os
import shutil
import socket
import sys
import threading
import time

os.environ.setdefault('LD_LIBRARY_PATH', '/home/gelistirici/build/chromelibs/root/usr/lib/x86_64-linux-gnu')
DATA = '/tmp/sm-aibot-shots-data'
SHOTS = '/tmp/aibot-shots'
shutil.rmtree(DATA, ignore_errors=True)
os.makedirs(DATA, exist_ok=True)
os.makedirs(SHOTS, exist_ok=True)
os.environ.update(SIMUMAV_DATA_DIR=DATA, SIMUMAV_DEV_LOGIN='1', HEPGO_SITL='0', SIMUMAV_UDP_BASE='28750', SIMUMAV_MAX_FLIGHTS='4',
                  SIMUMAV_MP_PORT_BASE='29700', SIMUMAV_MP_PORT_COUNT='20', SIMUMAV_SECURE_COOKIE='0', SIMUMAV_ENV_FILE=os.path.join(DATA, 'yok.env'),
                  SIMUMAV_MT_INTERNAL='http://127.0.0.1:1', GOOGLE_MAPS_API_KEY='')
PORT = 8653
BASE = f'http://127.0.0.1:{PORT}'
EXE = os.path.expanduser('~/.cache/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell')
ARGS = ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist']

import requests  # noqa: E402
import uvicorn  # noqa: E402
from playwright.sync_api import sync_playwright  # noqa: E402

import app.simumav.main as smain  # noqa: E402
from app import flightsim  # noqa: E402
from app import flightsim_match_core as core  # noqa: E402
from app.simumav import match as M  # noqa: E402
from tests.match_bot import rota_pilotu  # noqa: E402

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


def giris(ad):
    s = requests.Session()
    assert s.post(f'{BASE}/api/session', json={'dev_user': ad}, headers=H).status_code == 200
    return s


ali = giris('ali')
tr = ali.post(f'{BASE}/api/tracks', json={'name': 'Yarış Sahası', 'lat': 40.1, 'lon': 33.4, 'radius_m': 1000, 'world_mode': 'procedural',
                                          'world': {'seed': 5, 'tree_density': 0.15, 'building_count': 4}}, headers=H).json()
assert tr.get('id'), tr
sonuc, hatalar = [], []


def shot(pg, ad, el=None):
    (el or pg).screenshot(path=f'{SHOTS}/{ad}.png')
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


def baglam(b, oturum=None):
    ctx = b.new_context(viewport={'width': 1440, 'height': 900}, locale='tr-TR')
    if oturum is not None:
        ctx.add_cookies([{'name': 'smsid', 'value': oturum.cookies['smsid'], 'url': BASE}])
    ctx.add_init_script("try { localStorage.setItem('sm:lang', 'tr'); localStorage.setItem('simumav.consent', 'denied'); } catch (e) {}")
    pg = ctx.new_page()
    pg.set_default_timeout(90000)
    pg.on('pageerror', lambda e: hatalar.append(str(e)[:300]))
    return ctx, pg


def sihirbaz(pa, mod):
    pa.goto(f'{BASE}/app/#/fly', wait_until='domcontentloaded')
    pa.wait_for_selector('.sm-mode-ai')
    pa.click('.sm-mode-ai' if mod == 'ai' else '.sm-mode-card.multi')
    pa.wait_for_selector('.sm-wizard-match .sm-cards-drones')
    pa.click('.sm-nav-btn.primary')
    pa.locator('.sm-cards-tracks .sm-card', has_text='Yarış Sahası').click()
    pa.click('.sm-nav-btn.primary')
    pa.wait_for_selector('.sm-df-kind[data-kind="rings"]')
    for k, v in (('count', 3), ('min_alt_m', 12), ('max_alt_m', 24), ('diameter_m', 16), ('radius_m', 110)):
        pa.fill(f'.sm-mt-field input[data-k="{k}"]', str(v)); pa.dispatch_event(f'.sm-mt-field input[data-k="{k}"]', 'input')
    pa.wait_for_timeout(600)
    pa.click('.sm-nav-btn.primary')


try:
    with sync_playwright() as p:
        b = p.chromium.launch(executable_path=EXE, args=ARGS)
        _, pa = baglam(b, ali)
        pa.goto(f'{BASE}/app/#/fly', wait_until='domcontentloaded')
        pa.wait_for_selector('.sm-mode-ai'); pa.wait_for_timeout(900)
        shot(pa, 'sm-01-uc-secim-yapay-zekaya-karsi')
        # ---- salonda bot ekleme (davetli çok oyunculu karşılaşma)
        sihirbaz(pa, 'multi')
        pa.wait_for_selector('.sm-mt-pw'); pa.fill('.sm-mt-pw', 'BOT42X')
        pa.locator('.sm-mt-seg button', has_text='3').first.click()
        pa.click('.sm-mt-create')
        pa.wait_for_selector('.sm-ai-add button[data-level="hard"]')
        pa.click('.sm-ai-add button[data-level="hard"]')
        pa.wait_for_selector('.sm-mt-players li.bot'); pa.wait_for_timeout(900)
        rozet = pa.locator('.sm-mt-players .sm-ai-badge').all_inner_texts()
        kontrol(f'salonda bot rozeti: {rozet}', rozet == ['AI · Zor'])
        shot(pa, 'sm-02-salon-bot-ekle')
        mid0 = int(pa.evaluate('window.__smLobby.match.id'))
        ali.post(f'{BASE}/api/match/{mid0}/cancel', json={}, headers=H)
        # ---- yapay zekâya karşı (hızlı başlat)
        sihirbaz(pa, 'ai')
        pa.wait_for_selector('.sm-ai-step')
        pa.click('.sm-ai-levels button[data-level="hard"]')
        pa.locator('.sm-ai-step .sm-mt-seg').nth(1).locator('button', has_text='2').click()
        pa.wait_for_timeout(500)
        shot(pa, 'sm-03-yapay-zeka-adimi')
        pa.click('.sm-mt-create')
        pa.wait_for_function("() => /#\\/fly\\/match\\/\\d+/.test(location.hash)", timeout=60000)
        mid = int(pa.evaluate("location.hash.match(/match\\/(\\d+)/)[1]"))
        m = M.MANAGER.get(mid)
        kontrol('hızlı başlat: 1 insan + 2 bot, HAZIRLIK', m.k is not None and len(m.k.botlar()) == 2)
        kontrol('yarış başladı', bekle(lambda: m.k.durum == core.YARIS, 600, 0.5))
        insan = next(o.uid for o in m.k.oyuncular.values() if not o.bot)
        ses = flightsim.MANAGER.get(m.sessions[insan].id)
        rota_pilotu(ses, m.k.halkalar, m.merkez, hiz=2.5)
        pa.evaluate("window.__smMatch?.sim?.setCamera?.('follow')"); pa.mouse.click(720, 300); pa.keyboard.press('1')   # takip kamerası: botlar önde görünsün
        pa.wait_for_timeout(16000)
        ghost = pa.evaluate("window.__smMatch?.layer?.ghostInfo?.() || []")
        kontrol(f'3B: 2 bot görünüyor: {ghost}', len(ghost) == 2)
        shot(pa, 'sm-04-yarista-botlar')
        kontrol('karşılaşma bitti (bot kazandı)', bekle(lambda: m.k.durum == core.BITTI and (m.k.kazanan or 0) < 0, 400, 1.0))
        pa.wait_for_selector('.sm-mt-result:not([hidden]) table', timeout=60000); pa.wait_for_timeout(4500)
        kontrol('sonuçta AI rozetleri', pa.locator('.sm-mt-result .sm-ai-badge').count() == 2)
        kontrol(f"puan sayacı tamam: {pa.locator('.sm-mt-score b').inner_text()}", pa.locator('.sm-mt-score b').inner_text() == pa.locator('.sm-mt-score b').get_attribute('data-score'))
        shot(pa, 'sm-05-sonuc-ai-rozeti-puan')
        pa.click('.sm-mt-result .acts .btn'); pa.wait_for_timeout(300)
        pa.evaluate("document.querySelector('.fs-audio-more')?.click()"); pa.wait_for_timeout(500)
        kontrol('ses menüsünde Oyun efektleri', pa.locator('.fs-audio-menu .fs-sfx-row').count() == 1)
        try:
            shot(pa, 'sm-06-ses-menusu-oyun-efektleri', pa.locator('.fs-audio-menu:has(.fs-sfx-row)').first)
        except Exception as e:   # noqa: BLE001
            hatalar.append(f'ses menüsü: {str(e)[:150]}')
        b.close()
finally:
    server.should_exit = True
    time.sleep(1)
    print('hatalar:', hatalar or 'yok')
