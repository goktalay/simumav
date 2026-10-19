#!/opt/hepgo/fabrika-yonetim/.venv/bin/python
"""SIMUMAV destek (§9) görsel doğrulama — Playwright headless shell: menüde "?" (yaşam simidi) düğmesi, Sorun bildir modalı, hangarda otomatik
ekran görüntüsü yakalama, gönderim → talep numarası, Taleplerim listesi, ayrıntı + Merkez yanıtı + kullanıcı cevabı, Ayarlar kartı, mobil, RTL.
Sunucular alt süreç (PID ile kapatılır): SIMUMAV port 8612 (SIMUMAV_DATA_DIR=/tmp/simumav-ticket-data, dev giriş, sahte SITL) + sahte hesap
servisi/Merkez tests/simumav_fake_mt.py port 8613. Görüntüler /tmp/simumav-ticket/. Çalıştır: tests/simumav_support_shots.py"""
import json
import os
import pathlib
import shutil
import signal
import subprocess
import sys
import time
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parents[1]
OUT = pathlib.Path('/tmp/simumav-ticket'); OUT.mkdir(exist_ok=True)
DATA = pathlib.Path('/tmp/simumav-ticket-data')
PORT, MT_PORT = int(os.environ.get('SUP_PORT', '8612')), int(os.environ.get('SUP_MT_PORT', '8613'))
B, MT = f'http://127.0.0.1:{PORT}', f'http://127.0.0.1:{MT_PORT}'
os.environ.setdefault('LD_LIBRARY_PATH', '/home/gelistirici/build/chromelibs/root/usr/lib/x86_64-linux-gnu')
EXE = os.path.expanduser('~/.cache/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell')
ARGS = ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist']
from playwright.sync_api import sync_playwright  # noqa: E402


def wait_http(url, n=80):
    for _ in range(n):
        try:
            if urllib.request.urlopen(url, timeout=1).status < 500:
                return True
        except Exception:
            time.sleep(0.5)
    return False


def start():
    if DATA.exists():
        shutil.rmtree(DATA)
    logs = open(OUT / 'server.log', 'w')
    mt = subprocess.Popen([sys.executable, '-m', 'tests.simumav_fake_mt', '--port', str(MT_PORT), '--secret', 'sv-gizli'], cwd=str(ROOT), stdout=logs, stderr=subprocess.STDOUT)
    env = {**os.environ, 'SIMUMAV_DATA_DIR': str(DATA), 'SIMUMAV_DEV_LOGIN': '1', 'HEPGO_SITL': '0', 'GOOGLE_MAPS_API_KEY': '', 'SIMUMAV_PUBLIC_HOST': '127.0.0.1',
           'SIMUMAV_SECURE_COOKIE': '0', 'SIMUMAV_MT_INTERNAL': MT, 'SIMUMAV_MT_SHARED_SECRET': 'sv-gizli', 'SIMUMAV_PUBLIC_URL': B, 'SIMUMAV_MP_PORT_BASE': '25900',
           'SIMUMAV_ALLOWED_ORIGINS': B}
    sv = subprocess.Popen([str(ROOT / '.venv/bin/python'), '-m', 'uvicorn', 'app.simumav.main:app', '--port', str(PORT)], cwd=str(ROOT), env=env, stdout=logs, stderr=subprocess.STDOUT)
    if not wait_http(f'{MT}/__fake/calls') or not wait_http(f'{B}/healthz'):
        stop(mt); stop(sv); raise SystemExit('sunucular açılmadı')
    return mt, sv


def stop(p):
    if p.poll() is None:
        p.send_signal(signal.SIGTERM)
        try:
            p.wait(20)
        except subprocess.TimeoutExpired:
            p.kill(); p.wait(5)


def mt_post(path, body):
    req = urllib.request.Request(MT + path, data=json.dumps(body).encode(), headers={'Content-Type': 'application/json'}, method='POST')
    return json.loads(urllib.request.urlopen(req, timeout=5).read())


def main():
    mt, sv = start()
    errors, n = [], [0]
    try:
        with sync_playwright() as pw:
            br = pw.chromium.launch(executable_path=EXE, args=ARGS)

            def page(ctx):
                pg = ctx.new_page()
                pg.on('console', lambda m: errors.append(f'[console.error] {m.text[:300]}') if m.type == 'error' and 'favicon' not in m.text else None)
                pg.on('pageerror', lambda e: errors.append(f'[pageerror] {str(e)[:300]}'))
                return pg

            def shot(pg, name):
                n[0] += 1; pg.screenshot(path=str(OUT / f'{n[0]:02d}-{name}.png')); print('  görüntü', f'{n[0]:02d}-{name}.png', flush=True)

            def api(pg, method, path, body=None):
                return pg.evaluate("""async ([m, p, b]) => { const r = await fetch(p, { method: m, headers: { 'Content-Type': 'application/json' }, body: b == null ? undefined : JSON.stringify(b) }); let d = null; try { d = await r.json(); } catch {} return [r.status, d]; }""", [method, path, body])

            def login(pg, user='ticket-pilot'):
                pg.goto(B + '/'); pg.wait_for_timeout(300)
                st, d = api(pg, 'POST', '/api/session', {'dev_user': user}); assert st == 200, (st, d)
                pg.goto(B + '/app/#/hangar'); pg.wait_for_selector('#chip:not([hidden])', timeout=20000); pg.wait_for_selector('.strip', timeout=20000)

            # ---- masaüstü: hangarda "?" düğmesi, modal, otomatik yakalama, gönderim
            ctx = br.new_context(viewport={'width': 1440, 'height': 900}, locale='tr-TR')
            ctx.add_init_script("localStorage.setItem('sm:bgfx','0')")   # menü arka plan sahnesi kapalı (SwiftShader'da yavaş); yakalama hangar önizlemesinden
            pg = page(ctx); login(pg)
            pg.wait_for_timeout(2500)
            assert pg.evaluate("!document.getElementById('help').hidden") and pg.evaluate("document.getElementById('help').title") == 'Sorun bildir'
            shot(pg, 'hangar-help-dugmesi')
            pg.locator('#help').click(); pg.wait_for_selector('.sup-modal', timeout=10000); pg.wait_for_timeout(400)
            shot(pg, 'modal-bos')
            assert pg.locator('.sup-cats button').count() == 7 and pg.locator('.sup-ctx pre').inner_text().startswith('Uçuş #')
            pg.locator('.sup-cats button[data-cat="flight"]').click()
            pg.locator('.sup-modal input[name="subject"]').fill('Kalkışta dron çakılıyor')
            pg.locator('.sup-modal textarea[name="body"]').fill('FPV-1 ile TRTEST parkurunda elden atışta hemen yere çakılıyor. Gaz %100, rüzgâr 3 m/s.')
            pg.locator('.sup-modal button[data-act="capture"]').click(); pg.wait_for_timeout(600)
            assert pg.evaluate("!document.querySelector('.sup-shot img').hidden && document.querySelector('.sup-shot img').src.startsWith('data:image/jpeg')"), 'otomatik yakalama'
            shot(pg, 'modal-dolu-ekran-goruntusu')
            pg.locator('.sup-modal .btn-row .btn.primary').last.click(); pg.wait_for_selector('.sup-done', timeout=15000); pg.wait_for_timeout(400)
            code = pg.locator('.sup-done .code').inner_text(); assert code == 'T-0001', code
            shot(pg, 'gonderildi-talep-no')
            calls = json.loads(urllib.request.urlopen(f'{MT}/__fake/calls', timeout=5).read())
            created = [c for c in calls if c['method'] == 'POST' and c['path'] == '/api/sv/tickets'][-1]
            assert created['secret'] == 'sv-gizli' and created['body']['app'] == 'sv' and created['body']['subject'].startswith('[Uçuş / Simülasyon]') and 'Tarayıcı:' in created['body']['body'] and '/api/support/att/' in created['body']['body'], created
            # ek bağlantısı oturumsuz açılıyor (Merkez personeli)
            url = next(l.split()[-1] for l in created['body']['body'].splitlines() if l.startswith('Ek:'))
            assert urllib.request.urlopen(url, timeout=5).headers['Content-Type'] == 'image/jpeg'
            # Taleplerim
            pg.locator('.modal .btn-row .btn.primary').last.click(); pg.wait_for_selector('.sup-row', timeout=10000); pg.wait_for_timeout(600)
            shot(pg, 'taleplerim-liste')
            # Merkez yanıtı → okunmamış işareti + ayrıntı zinciri + kullanıcı cevabı
            mt_post('/__fake/reply/1', {'body': 'Merhaba, .bin günlüğünü inceledik: TKOFF_THR_MINACC değeri düşük. Hangar › parametrelerden 4 yapıp tekrar dener misin?'})
            pg.reload(); pg.wait_for_selector('.sup-row.unread', timeout=15000); pg.wait_for_timeout(500); shot(pg, 'taleplerim-yeni-yanit')
            pg.locator('.sup-row').first.click(); pg.wait_for_selector('.sup-thread', timeout=10000); pg.wait_for_timeout(500)
            assert pg.locator('.sup-msg').count() == 2 and pg.locator('.sup-files img').count() == 1
            shot(pg, 'talep-ayrinti')
            pg.locator('textarea[name="reply"]').fill('Teşekkürler, 4 yaptım; şimdi kalkıyor.'); pg.locator('button[data-act="reply"]').click()
            pg.wait_for_function("document.querySelectorAll('.sup-msg').length === 3", timeout=10000); pg.wait_for_timeout(400)
            assert 'Yanıt bekliyor' in pg.locator('.sup-row .badge').inner_text()
            shot(pg, 'talep-cevap-yazildi')
            # Ayarlar kartı
            pg.goto(B + '/app/#/settings'); pg.wait_for_selector('.sup-card', timeout=10000); pg.wait_for_timeout(800); shot(pg, 'ayarlar-destek-karti')
            pg.locator('.sup-card button[data-act="report"]').click(); pg.wait_for_selector('.sup-modal', timeout=10000); pg.wait_for_timeout(300); shot(pg, 'ayarlar-modal')
            pg.keyboard.press('Escape')
            # Uç ekranında "?" gizli
            pg.goto(B + '/app/#/fly'); pg.wait_for_timeout(1500)
            assert pg.evaluate("document.getElementById('help').hidden"), 'fly ekranında help gizli olmalı'
            ctx.close()

            # ---- mobil 390×844
            ctx = br.new_context(viewport={'width': 390, 'height': 844}, locale='tr-TR', is_mobile=True, has_touch=True, device_scale_factor=2)
            ctx.add_init_script("localStorage.setItem('sm:bgfx','0')")
            pg = page(ctx); login(pg); pg.wait_for_timeout(1200); shot(pg, 'mobil-hangar-help')
            pg.locator('#help').click(); pg.wait_for_selector('.sup-modal', timeout=10000); pg.wait_for_timeout(400); shot(pg, 'mobil-modal')
            pg.keyboard.press('Escape'); pg.goto(B + '/app/#/support'); pg.wait_for_selector('.sup-row', timeout=10000); pg.wait_for_timeout(500); shot(pg, 'mobil-taleplerim')
            ctx.close()

            # ---- Arapça RTL: düğme solda, form sağdan sola
            ctx = br.new_context(viewport={'width': 1440, 'height': 900}, locale='ar')
            ctx.add_init_script("localStorage.setItem('sm:lang','ar'); localStorage.setItem('sm:bgfx','0')")
            pg = page(ctx); login(pg); pg.wait_for_timeout(1000)
            assert pg.evaluate('document.documentElement.dir') == 'rtl' and pg.locator('#help').bounding_box()['x'] < 200
            pg.locator('#help').click(); pg.wait_for_selector('.sup-modal', timeout=10000); pg.wait_for_timeout(400); shot(pg, 'rtl-modal')
            ctx.close()
            br.close()
        assert not errors, errors
        print(f'simumav_support_shots: TAMAM — {n[0]} görüntü /tmp/simumav-ticket/')
    finally:
        stop(sv); stop(mt)


if __name__ == '__main__':
    main()
