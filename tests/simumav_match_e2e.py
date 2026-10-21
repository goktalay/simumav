"""SIMUMAV ÇOK OYUNCULU KARŞILAŞMA (docs/simumav.md §18) — tarayıcı uçtan uca + ekran görüntüleri (/tmp/smmatch-shots).

İki tarayıcı bağlamı (kurucu ali + davetli veli) + oturumsuz üçüncü bağlam; sunucu aynı süreçte (uvicorn iş parçacığı, sahte kinematik HEPGO_SITL=0)
→ yarışta araçlar tests/match_bot.rota_pilotu ile halkalardan geçirilir. Adımlar: Uç › Tek/Çok oyunculu seçimi · kurucu sihirbazı (dron, parkur,
HALKALAR önizlemesi, DAVET oyuncu sayısı + şifre) · salon (bağlantı + şifre) · oturumsuz davet → giriş penceresi (sonra=…) · davetli şifre ekranı
(yanlış şifre → kalan hak) · doğru şifre → salon · Hazırım → BAŞLAT · HAZIRLIK bekleme kutusu · yarış HUD'u (halkalar, diğer oyuncu, sıralama) ·
sonuç (iki tarafta) · salonda sonuç tablosu.

Çalıştırma: .venv/bin/python -m tests.simumav_match_e2e
"""
import os
import shutil
import socket
import sys
import threading
import time

os.environ.setdefault('LD_LIBRARY_PATH', '/home/gelistirici/build/chromelibs/root/usr/lib/x86_64-linux-gnu')
DATA = '/tmp/sm-match-e2e-data'
SHOTS = '/tmp/smmatch-shots'
shutil.rmtree(DATA, ignore_errors=True)
os.makedirs(DATA, exist_ok=True)
os.makedirs(SHOTS, exist_ok=True)
os.environ.update(SIMUMAV_DATA_DIR=DATA, SIMUMAV_DEV_LOGIN='1', HEPGO_SITL='0', SIMUMAV_UDP_BASE='28450', SIMUMAV_MAX_FLIGHTS='4',
                  SIMUMAV_MP_PORT_BASE='29400', SIMUMAV_MP_PORT_COUNT='20', SIMUMAV_SECURE_COOKIE='0', SIMUMAV_ENV_FILE=os.path.join(DATA, 'yok.env'),
                  SIMUMAV_MT_INTERNAL='http://127.0.0.1:1', GOOGLE_MAPS_API_KEY='')
PORT = 8647
BASE = f'http://127.0.0.1:{PORT}'
EXE = os.path.expanduser('~/.cache/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell')
ARGS = ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist']

import requests  # noqa: E402
import uvicorn  # noqa: E402
from playwright.sync_api import sync_playwright  # noqa: E402

import app.simumav.main as smain  # noqa: E402
from app.simumav import match as M  # noqa: E402
from tests.match_bot import rota_pilotu  # noqa: E402

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
        # 1) Uç: Tek / Çok oyunculu seçimi
        pa.goto(f'{BASE}/app/#/fly', wait_until='domcontentloaded')
        pa.wait_for_selector('.sm-mode-card.multi')
        pa.wait_for_timeout(700)
        shot(pa, '01-secim-tek-cok')
        # 2) kurucu sihirbazı: dron → parkur → halkalar → davet
        pa.click('.sm-mode-card.multi')
        pa.wait_for_selector('.sm-wizard-match .sm-cards-drones')
        pa.click('.sm-nav-btn.primary')
        pa.locator('.sm-cards-tracks .sm-card', has_text='Yarış Sahası').click()
        pa.click('.sm-nav-btn.primary')
        pa.wait_for_selector('.sm-mt-map .ring')
        pa.fill('.sm-mt-field input[data-k="count"]', '4')
        pa.fill('.sm-mt-field input[data-k="min_alt_m"]', '15')
        pa.fill('.sm-mt-field input[data-k="max_alt_m"]', '35')
        pa.fill('.sm-mt-field input[data-k="radius_m"]', '160')
        pa.wait_for_timeout(1200)
        shot(pa, '02-kurucu-halkalar')
        pa.click('.sm-nav-btn.primary')
        pa.wait_for_selector('.sm-mt-pw')
        pa.fill('.sm-mt-pw', 'YARIS42')
        pa.wait_for_timeout(300)
        shot(pa, '03-kurucu-davet-sifre')
        pa.click('.sm-mt-create')
        pa.wait_for_selector('.sm-mt-invite input.mono')
        pa.wait_for_timeout(800)
        shot(pa, '04-kurucu-salon-link-sifre')
        link = pa.eval_on_selector('.sm-mt-invite input.mono', 'e => e.value')
        mid = int(pa.evaluate('window.__smLobby.match.id'))
        assert '/app/#/fly/join/' in link, link
        # 3) oturumsuz davet bağlantısı → giriş penceresi (girişten sonra davete döner)
        cz, pz = baglam(b)
        pz.goto(link, wait_until='domcontentloaded')
        pz.wait_for_url('**/?giris=1&sonra=*', timeout=30000)
        pz.wait_for_selector('#auth:not([hidden])', timeout=30000)
        pz.wait_for_timeout(600)
        shot(pz, '05a-davet-oturumsuz-giris')
        assert 'sonra=%2Fapp%2F%23%2Ffly%2Fjoin%2F' in pz.url, pz.url
        cz.close()
        # 4) davetli: şifre ekranı → yanlış → doğru → salon
        _, pv = baglam(b, veli)
        pv.goto(link, wait_until='domcontentloaded')
        pv.wait_for_selector('.sm-mt-joinform')
        pv.wait_for_timeout(500)
        shot(pv, '05b-davetli-sifre-ekrani')
        pv.fill('.sm-mt-joinform .sm-mt-pw', 'yanlis')
        pv.click('.sm-mt-joinbtn')
        pv.wait_for_selector('.sm-mt-joinform .sm-mt-err:not([hidden])')
        shot(pv, '05c-davetli-yanlis-sifre')
        pv.fill('.sm-mt-joinform .sm-mt-pw', 'YARIS42')
        pv.click('.sm-mt-joinbtn')
        pv.wait_for_selector('.sm-mt-ready')
        pv.click('.sm-mt-ready')
        pv.wait_for_timeout(800)
        shot(pv, '06a-davetli-salon-hazir')
        pa.wait_for_selector('.sm-mt-start:not([disabled])')
        pa.wait_for_timeout(500)
        shot(pa, '06b-kurucu-salon-herkes-hazir')
        # 5) BAŞLAT → HAZIRLIK → iki taraf yarış ekranına
        pa.click('.sm-mt-start')
        for pg in (pa, pv):
            pg.wait_for_function('() => location.hash.endsWith("/race")', timeout=30000)
        pa.wait_for_selector('.sm-mt-bar', timeout=60000)
        try:
            pa.wait_for_selector('.sm-mt-wait:not([hidden])', timeout=20000)
            shot(pa, '07-hazirlik-bekleme')
        except Exception:   # noqa: BLE001 — iki taraf çok hızlı hazırsa kutu görünmeyebilir
            pass
        for pg in (pa, pv):
            pg.wait_for_function("() => window.__smMatch && window.__smMatch.match && window.__smMatch.match.state === 'YARIS'", timeout=180000)
            pg.evaluate("() => { try { window.__smSession.sim.setCamera('follow'); } catch (e) {} }")
        pa.wait_for_timeout(1500)
        shot(pa, '08-yaris-hud-baslangic')
        # 6) rota pilotları (sunucu aynı süreçte): kurucu tüm parkur, davetli 2 halka
        mt = M.MANAGER.get(mid)
        uid_a = next(o.uid for o in mt.k.oyuncular.values() if o.kurucu)
        uid_v = next(o.uid for o in mt.k.oyuncular.values() if not o.kurucu)
        rota_pilotu(mt.sessions[uid_v], mt.k.halkalar, mt.merkez, hiz=18.0, kadar=2)
        rota_pilotu(mt.sessions[uid_a], mt.k.halkalar, mt.merkez, hiz=25.0)
        pa.wait_for_function("() => (window.__smMatch.layer.ringInfo() || []).some(r => r.state === 'done')", timeout=60000)
        pa.wait_for_timeout(2500)
        shot(pa, '09a-yaris-hud-halkalar-kurucu')
        shot(pv, '09b-yaris-hud-davetli')
        for pg, ad in ((pa, '10a-sonuc-kurucu'), (pv, '10b-sonuc-davetli')):
            pg.wait_for_selector('.sm-mt-result:not([hidden]) .sm-mt-table', timeout=120000)
            pg.wait_for_timeout(600)
            shot(pg, ad)
        # 7) salona dön → sonuç tablosu
        pv.click('.sm-mt-result .btn.primary')
        pv.wait_for_selector('.sm-mt-results:not([hidden]) .sm-mt-table', timeout=30000)
        pv.wait_for_timeout(600)
        shot(pv, '11-salon-sonuc')
        ozet = M.MANAGER.get(mid).k.sonuc()
        print('  kazanan:', ozet['winner'], '· sıralama:', [(r['name'], r['rank'], r['rings'], r['time_s']) for r in ozet['standings']])
        assert ozet['winner'] == uid_a
        b.close()
finally:
    server.should_exit = True
    time.sleep(1.0)
    shutil.rmtree(DATA, ignore_errors=True)

print('sayfa hataları:', hatalar or 'yok')
print(f'{len(sonuc)} görüntü → {SHOTS}')
