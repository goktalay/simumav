"""SIMUMAV düzeltmeleri e2e (smfix): Yeni Parkur harita yedeği, hangar kart mini 3B modelleri, Uç geri düğmesi.

1) Google anahtarı reddedilince (gm_authFailure — PROD'da HTTP yönlendiren kısıtı; burada geçersiz sahte anahtar) harita kutusu Google'ın gri
   "Bu sayfa Google Haritalar'ı düzgün şekilde yükleyemedi" kutusunda KALMAZ: uydu yedeği (.sat-map) + bilgi notu; Google 3B seçiliyken not.
2) Hangar şeridi kartlarında dönen mini 3B model (kart başına 2B tuval; canlı WebGL bağlamı ≤ 1 — paylaşılan çizici).
3) Uç: seçim sayfasında "← Ana Menü"; sihirbazda bir önceki adım, ilk adımda seçim; multi / ai / join alt rotalarında seçim sayfası.
Görseller: /tmp/smfix-shots. Çalıştırma: .venv/bin/python -m tests.simumav_smfix_e2e
"""
import json
import os
import shutil
import socket
import sys
import threading
import time
from pathlib import Path

os.environ.setdefault('LD_LIBRARY_PATH', '/home/gelistirici/build/chromelibs/root/usr/lib/x86_64-linux-gnu')
DATA = '/tmp/sm-smfix-data'
shutil.rmtree(DATA, ignore_errors=True)
os.makedirs(DATA, exist_ok=True)
# geçersiz (sahte) anahtar: Maps JS yüklenir, kimlik doğrulama başarısız → gm_authFailure (PROD'daki 403/RefererNotAllowed ile aynı yol)
os.environ.update(SIMUMAV_DATA_DIR=DATA, SIMUMAV_DEV_LOGIN='1', HEPGO_SITL='0', SIMUMAV_UDP_BASE='25550', SIMUMAV_MAX_FLIGHTS='2',
                  SIMUMAV_MP_PORT_BASE='26600', SIMUMAV_MP_PORT_COUNT='20', SIMUMAV_SECURE_COOKIE='0', SIMUMAV_ENV_FILE=os.path.join(DATA, 'yok.env'),
                  SIMUMAV_MT_INTERNAL='http://127.0.0.1:1', GOOGLE_MAPS_API_KEY='AIzaSyD-sahte-anahtar-smfix-0000000000')
PORT = 8637
BASE = f'http://127.0.0.1:{PORT}'
OUT = Path('/tmp/smfix-shots')
OUT.mkdir(parents=True, exist_ok=True)
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
assert s.post(f'{BASE}/api/session', json={'dev_user': 'smfix'}, headers=H).status_code == 200
tok = s.cookies['smsid']
s.post(f'{BASE}/api/tracks', json={'name': 'Kalecik', 'lat': 40.099, 'lon': 33.4101, 'radius_m': 800, 'world_mode': 'procedural', 'world': {'seed': 3}}, headers=H)
cat = s.get(f'{BASE}/api/hangar/catalog').json()['types']
by = {t['key']: t for t in cat}
plane = next((m for m in by['plane']['models'] if 'caymaz' in m['key']), by['plane']['models'][0])
for name, ty, m, col in (('FPV-1', 'fpv', by['fpv']['models'][0], '#38bdf8'), ('CAYMAZ', 'plane', plane, '#f97316'),
                         ('Interceptor', 'interceptor', by['interceptor']['models'][0], '#a78bfa'), ('Hexa', 'multirotor', by['multirotor']['models'][0], '#34d399')):
    r = s.post(f'{BASE}/api/hangar', json={'name': name, 'type': ty, 'model_key': m['key'], 'color': col}, headers=H)
    assert r.status_code in (200, 201), r.text[:200]

sonuc = []


def kontrol(ad, kosul, ayrinti=''):
    sonuc.append((ad, bool(kosul), ayrinti))


try:
    with sync_playwright() as p:
        b = p.chromium.launch(executable_path=EXE, args=ARGS)
        ctx = b.new_context(viewport={'width': 1440, 'height': 900}, locale='tr-TR')
        ctx.add_cookies([{'name': 'smsid', 'value': tok, 'url': BASE}])
        ctx.add_init_script("try { localStorage.setItem('sm:lang', 'tr'); localStorage.setItem('simumav.consent', 'denied'); } catch (e) {}")
        pg = ctx.new_page()
        pg.set_default_timeout(180000)   # makine yüklüyken (paralel ajanlar) swiftshader ekran görüntüsü yavaş
        hatalar, konsol = [], []
        pg.on('pageerror', lambda e: hatalar.append(str(e)[:300]))
        pg.on('console', lambda m: konsol.append(f'{m.type}: {m.text[:200]}') if m.type in ('error', 'warning') else None)
        yok404 = []
        pg.on('response', lambda r: yok404.append(r.url) if r.status == 404 and '127.0.0.1' in r.url else None)

        # ---------- 1) Yeni Parkur: Google reddi → uydu yedeği ----------
        pg.goto(f'{BASE}/app/#/tracks/new', wait_until='domcontentloaded')
        pg.wait_for_selector('.track-editor', timeout=60000)
        try:
            pg.wait_for_selector('.ed-map .sat-map', timeout=30000)
            sat = True
        except Exception:  # noqa: BLE001
            sat = False
        pg.wait_for_timeout(3500)   # uydu karoları
        kontrol('Parkur: uydu yedeği açıldı', sat)
        kontrol('Parkur: Google hata kutusu yok', pg.locator('.ed-map .gm-err-container, .ed-map .gm-err-content').count() == 0)
        kontrol('Parkur: bilgi notu', pg.locator('.ed-map .sat-note').is_visible() if sat else False, pg.locator('.ed-map .sat-note').inner_text() if sat else '')
        kontrol('Parkur: Google 3B notu (varsayılan kip google3d)', pg.locator('.g3d-note').is_visible())
        # karolar gerçekten çizildi mi (tuvalin ortası koyu zemin #0b1220 değil)
        # karolar başka kökenden (tuval kirlenir; getImageData okunamaz) → ekran görüntüsü boyutu: düz koyu zemin < 30 KB, uydu karoları ≫
        png = pg.locator('.sat-map-canvas').screenshot() if sat else b''
        kontrol('Parkur: uydu karosu çizildi', len(png) > 150000, f'{len(png)} bayt')
        # tıklama → konum değişir
        once = pg.locator('.ed-panel .kv b').inner_text()
        box = pg.locator('.sat-map-canvas').bounding_box()
        pg.mouse.click(box['x'] + box['width'] * 0.7, box['y'] + box['height'] * 0.6)
        pg.wait_for_timeout(400)
        kontrol('Parkur: haritaya tıklama konumu değiştirir', pg.locator('.ed-panel .kv b').inner_text() != once)
        pg.screenshot(path=str(OUT / '01-yeni-parkur-harita-yedegi.png'))

        # ---------- 2) Hangar: kart mini 3B ----------
        pg.goto(f'{BASE}/app/#/hangar', wait_until='domcontentloaded')
        pg.wait_for_selector('.strip .strip-card .thumb.drone-thumb canvas', timeout=60000)
        pg.wait_for_timeout(4000)
        n_canvas = pg.locator('.strip .strip-card .thumb.drone-thumb canvas').count()
        kontrol('Hangar: her kartta mini 3B tuval', n_canvas >= 4, f'{n_canvas} tuval')
        boyali = pg.evaluate("""() => [...document.querySelectorAll('.thumb.drone-thumb canvas')].map(c => { const x = c.getContext('2d'); const d = x.getImageData(0, 0, c.width, c.height).data; let n = 0; for (let i = 3; i < d.length; i += 16) if (d[i] > 0) n++; return n; })""")
        kontrol('Hangar: kart modelleri çizildi', boyali and all(v > 50 for v in boyali), str(boyali))
        gl = pg.evaluate('() => (window.__smGl ? window.__smGl() : null)')
        kontrol('Hangar: canlı WebGL bağlamı ≤ 1 (tek paylaşılan çizici)', gl is None or (gl if isinstance(gl, int) else gl.get('live', 0)) <= 1, json.dumps(gl))
        a1 = pg.locator('.thumb.drone-thumb canvas').first.screenshot()
        pg.wait_for_timeout(1200)
        a2 = pg.locator('.thumb.drone-thumb canvas').first.screenshot()
        kontrol('Hangar: kart modeli dönüyor', a1 != a2)
        pg.screenshot(path=str(OUT / '02-hangar-kartlar.png'))
        pg.locator('.strip').screenshot(path=str(OUT / '02b-hangar-serit.png'))

        # ---------- 3) Uç geri düğmesi ----------
        def geri_lbl():
            return pg.locator('#back-label').inner_text() if pg.locator('#back').is_visible() else None

        pg.goto(f'{BASE}/app/#/fly', wait_until='domcontentloaded')
        pg.wait_for_selector('.sm-mode-grid', timeout=60000)
        pg.wait_for_timeout(700)
        kontrol('Uç seçim: geri görünür (Ana Menü)', geri_lbl() == 'Ana Menü', str(geri_lbl()))
        pg.screenshot(path=str(OUT / '03-uc-secim-geri.png'))
        pg.click('#back')
        pg.wait_for_function("location.hash === '#/menu'", timeout=15000)
        kontrol('Uç seçim → ana menü', True)

        pg.goto(f'{BASE}/app/#/fly/solo', wait_until='domcontentloaded')
        pg.wait_for_selector('.sm-steps', timeout=60000)
        pg.wait_for_timeout(800)
        kontrol('Uç solo: geri görünür (Geri)', geri_lbl() == 'Geri', str(geri_lbl()))
        adim1 = pg.locator('.sm-step-body').get_attribute('data-step')
        pg.locator('.sm-wizard-foot .sm-nav-btn.primary').click()
        pg.wait_for_timeout(500)
        adim2 = pg.locator('.sm-step-body').get_attribute('data-step')
        pg.screenshot(path=str(OUT / '04-uc-sihirbaz-adim2.png'))
        pg.click('#back')
        pg.wait_for_timeout(500)
        kontrol('Uç solo: geri → önceki adım', adim1 != adim2 and pg.locator('.sm-step-body').get_attribute('data-step') == adim1, f'{adim1} → {adim2} → geri')
        kontrol('Uç solo: hâlâ sihirbazda', pg.evaluate('location.hash') == '#/fly/solo')
        pg.click('#back')
        pg.wait_for_selector('.sm-mode-grid', timeout=15000)
        kontrol('Uç solo ilk adım: geri → seçim', pg.evaluate('location.hash') == '#/fly')

        for rota, sec in (('multi', '.sm-steps'), ('ai', '.sm-steps'), ('join/ABCDEFGH1234', '.sm-mt-page')):
            pg.goto(f'{BASE}/app/#/fly/{rota}', wait_until='domcontentloaded')
            pg.wait_for_selector(sec, timeout=60000)
            pg.wait_for_timeout(1200)   # kabuk geçiş animasyonu bitsin
            ok_lbl = geri_lbl() == 'Geri'
            if rota == 'ai':
                pg.screenshot(path=str(OUT / '05-uc-yapay-zeka-geri.png'))
            if rota.startswith('join'):
                pg.screenshot(path=str(OUT / '06-uc-davet-geri.png'))
            pg.click('#back')
            try:
                pg.wait_for_selector('.sm-mode-grid', state='attached', timeout=60000)   # yüklü makinede önizleme sahnesinin bırakılması yavaş
                kontrol(f'Uç {rota}: geri → seçim', ok_lbl and pg.evaluate('location.hash') == '#/fly', str(geri_lbl()))
            except Exception as e:  # noqa: BLE001
                durum = pg.evaluate("[location.hash, document.querySelector('.sm-step-body')?.dataset.step || '-', document.getElementById('view').innerText.slice(0, 160)]")
                pg.screenshot(path=str(OUT / f'hata-{rota.replace("/", "_")}.png'))
                kontrol(f'Uç {rota}: geri → seçim', False, f'{str(e)[:80]} · {durum}')
        kontrol('Sayfa hatası yok', not hatalar, '; '.join(hatalar))
        kontrol('Yerel 404 yok (plane.glb vb.)', not [u for u in yok404 if '.glb' in u], ', '.join(yok404))
        print('konsol (hata/uyarı, ilk 12):')
        for k in konsol[:12]:
            print('   ', k)
        b.close()
finally:
    server.should_exit = True
    shutil.rmtree(DATA, ignore_errors=True)

for ad, ok, ay in sonuc:
    print(('TAMAM ' if ok else 'HATA  ') + ad + (f' — {ay}' if ay else ''))
sys.stdout.flush()
os._exit(0 if sonuc and all(r[1] for r in sonuc) else 1)   # uvicorn iş parçacığı kapanışını bekleme
