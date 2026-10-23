#!/opt/hepgo/fabrika-yonetim/.venv/bin/python
"""Bayram temaları görsel doğrulama (Playwright headless shell): SIMUMAV oyun menüsü ve tanıtım sitesi — 20 temanın her biri önizleme kipiyle
(?bayram=<tema>), birleşik tema (Kurban + Gençlik), Ayarlar satırları, uçuş oturumunda katmanın gizlenmesi, prefers-reduced-motion (durağan kare),
kutlama şeridi. Sunucu alt süreç (port 8631, sahte SITL, dev giriş). Görüntüler /tmp/bayram-shots/simumav-*.png ve site-*.png.
Çalıştır: tests/simumav_holiday_shots.py [tema …]"""
import os, pathlib, re, shutil, signal, subprocess, sys, time, urllib.request

ROOT = pathlib.Path(__file__).resolve().parents[1]
OUT = pathlib.Path('/tmp/bayram-shots'); OUT.mkdir(exist_ok=True)
DATA = pathlib.Path('/tmp/bayram-shots-data')
PORT = int(os.environ.get('HOLIDAY_PORT', '8631'))
B = f'http://127.0.0.1:{PORT}'
os.environ.setdefault('LD_LIBRARY_PATH', '/home/gelistirici/build/chromelibs/root/usr/lib/x86_64-linux-gnu')
EXE = os.path.expanduser('~/.cache/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell')
ARGS = ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist']
THEMES = ['kurban', 'ramazan', 'hicri', 'noel', 'paskalya', 'hristiyan', 'yilbasi', 'cin_yeni', 'diwali', 'holi', 'hindu', 'yahudi',
          'cocuk_genclik', 'kadin_anne', 'sevgi', 'cadilar', 'bagimsizlik', 'emek', 'bahar', 'genel']
from playwright.sync_api import sync_playwright  # noqa: E402


def start_server():
    if DATA.exists():
        shutil.rmtree(DATA)
    env = {**os.environ, 'SIMUMAV_DATA_DIR': str(DATA), 'SIMUMAV_DEV_LOGIN': '1', 'HEPGO_SITL': '0', 'GOOGLE_MAPS_API_KEY': '', 'SIMUMAV_PUBLIC_HOST': '127.0.0.1',
           'SIMUMAV_SECURE_COOKIE': '0', 'SIMUMAV_MT_INTERNAL': 'http://127.0.0.1:1', 'SIMUMAV_MP_PORT_BASE': '25900', 'SIMUMAV_UDP_BASE': '24950'}
    log = open(OUT / 'simumav-server.log', 'w')
    p = subprocess.Popen([str(ROOT / '.venv/bin/python'), '-m', 'uvicorn', 'app.simumav.main:app', '--port', str(PORT)], cwd=str(ROOT), env=env, stdout=log, stderr=subprocess.STDOUT)
    for _ in range(80):
        try:
            if urllib.request.urlopen(f'{B}/healthz', timeout=1).status == 200:
                return p
        except Exception:
            time.sleep(0.5)
    p.kill(); raise SystemExit('sunucu açılmadı')


def main():
    only = [a for a in sys.argv[1:] if a in THEMES] or THEMES
    srv = start_server()
    errors = []
    try:
        with sync_playwright() as pw:
            br = pw.chromium.launch(executable_path=EXE, args=ARGS)

            def new_page(ctx):
                pg = ctx.new_page()
                pg.on('console', lambda m: errors.append(f'[console.{m.type}] {m.text[:300]}') if m.type == 'error' and not re.search(r'favicon|tile|maps|net::ERR|Failed to load resource', m.text) else None)
                pg.on('pageerror', lambda e: errors.append(f'[pageerror] {str(e)[:300]}'))
                return pg

            def api(pg, method, path, body=None):
                return pg.evaluate("""async ([m, p, b]) => { const r = await fetch(p, { method: m, headers: { 'Content-Type': 'application/json' }, body: b == null ? undefined : JSON.stringify(b) }); let d = null; try { d = await r.json(); } catch {} return [r.status, d]; }""", [method, path, body])

            def fx_state(pg):
                return pg.evaluate('window.__holidayFx ? window.__holidayFx() : null')

            # ---- SIMUMAV oyun menüsü
            ctx = br.new_context(viewport={'width': 1440, 'height': 900}, locale='tr-TR', timezone_id='Europe/Istanbul')
            pg = new_page(ctx)
            pg.goto(B + '/'); pg.wait_for_timeout(300)
            st, d = api(pg, 'POST', '/api/session', {'dev_user': 'bayram-pilot'}); assert st in (200, 201), (st, d)
            for th in only:
                pg.goto(f'{B}/app/?bayram={th}#/menu')
                pg.wait_for_selector('.menu-grid', timeout=30000)
                pg.wait_for_function('window.__holidayFx && window.__holidayFx().frames > 20', timeout=30000)
                pg.wait_for_timeout(2600 if th not in ('bagimsizlik', 'noel', 'cin_yeni') else 5200)
                s = fx_state(pg); assert s and s['themes'][0] == th, s
                pg.screenshot(path=str(OUT / f'simumav-{th}.png')); print(f'  simumav-{th}.png  {s["avgMs"]} ms/kare  ülke={s["detected"]["country"]}', flush=True)
            # birleşik tema (TR 19 Mayıs 2027 örneği)
            pg.goto(f'{B}/app/?bayram=kurban,cocuk_genclik#/menu'); pg.wait_for_selector('.menu-grid', timeout=30000)
            pg.wait_for_function('window.__holidayFx && window.__holidayFx().frames > 20', timeout=30000); pg.wait_for_timeout(3000)
            s = fx_state(pg); assert s['themes'] == ['kurban', 'cocuk_genclik'], s
            pg.screenshot(path=str(OUT / 'simumav-birlesik-kurban-genclik.png')); print('  simumav-birlesik-kurban-genclik.png', flush=True)
            # uçuş oturumu: katman gizlenir (kabuk #view.sm-fly-session)
            pg.evaluate("document.getElementById('view').classList.add('sm-fly-session')")
            pg.wait_for_function("document.querySelector('canvas.holiday-fx').style.opacity === '0'", timeout=15000)   # uçuşta gizli
            pg.evaluate("document.getElementById('view').classList.remove('sm-fly-session')")
            pg.wait_for_function("document.querySelector('canvas.holiday-fx').style.opacity === '1'", timeout=15000)
            print('  uçuş oturumunda katman gizlendi / döndü', flush=True)
            # Ayarlar satırları (önizleme seçicisi dev oturumunda)
            pg.goto(f'{B}/app/#/settings'); pg.wait_for_selector('[data-set="holiday_fx"]', timeout=20000); pg.wait_for_timeout(1500)
            pg.locator('[data-set="holiday_fx"]').scroll_into_view_if_needed(); pg.wait_for_timeout(600)
            pg.screenshot(path=str(OUT / 'simumav-ayarlar.png')); print('  simumav-ayarlar.png', flush=True)
            assert pg.locator('[data-set="holiday_country"] option').count() > 200
            pg.select_option('[data-set="holiday_preview"]', 'ramazan'); pg.wait_for_timeout(2500)
            assert fx_state(pg)['themes'] == ['ramazan']
            pg.screenshot(path=str(OUT / 'simumav-ayarlar-onizleme-ramazan.png'))
            ctx.close()

            # ---- prefers-reduced-motion → durağan köşe süsü (döngü yok)
            ctx = br.new_context(viewport={'width': 1440, 'height': 900}, locale='tr-TR', reduced_motion='reduce')
            pg = new_page(ctx); pg.goto(B + '/'); api(pg, 'POST', '/api/session', {'dev_user': 'bayram-pilot'})
            pg.goto(f'{B}/app/?bayram=kurban#/menu'); pg.wait_for_selector('.menu-grid', timeout=30000); pg.wait_for_timeout(2500)
            s = fx_state(pg); assert s['reduced'] and not s['running'] and s['frames'] == 0, s
            pg.screenshot(path=str(OUT / 'simumav-reduced-kurban.png')); print('  simumav-reduced-kurban.png (durağan)', flush=True)
            ctx.close()

            # ---- tanıtım sitesi (oturumsuz; kutlama şeridi)
            ctx = br.new_context(viewport={'width': 1440, 'height': 900}, locale='tr-TR', timezone_id='Europe/Istanbul')
            pg = new_page(ctx)
            for th in only:
                pg.goto(f'{B}/?bayram={th}')
                pg.wait_for_selector('.hfx-banner', state='attached', timeout=30000)   # kutlama şeridi
                pg.wait_for_function('window.__holidayFx && window.__holidayFx().frames > 20', timeout=30000)
                pg.wait_for_timeout(1800 if th not in ('bagimsizlik', 'noel', 'cin_yeni') else 4800)
                pg.screenshot(path=str(OUT / f'site-{th}.png')); print(f'  site-{th}.png', flush=True)
            for lng in ('en', 'ar', 'ru'):
                pg.goto(f'{B}/?bayram=ramazan&lang={lng}'); pg.wait_for_selector('.hfx-banner b', timeout=30000); serit = pg.locator('.hfx-banner b').inner_text()
                pg.wait_for_function('window.__holidayFx && window.__holidayFx().frames > 20', timeout=30000); pg.wait_for_timeout(1500)
                pg.screenshot(path=str(OUT / f'site-ramazan-{lng}.png')); print(f'  site-ramazan-{lng}.png  şerit: {serit}', flush=True)
            # mobil
            ctx.close()
            ctx = br.new_context(viewport={'width': 390, 'height': 844}, locale='tr-TR', is_mobile=True, has_touch=True, device_scale_factor=2)
            pg = new_page(ctx); pg.goto(f'{B}/?bayram=kurban'); pg.wait_for_function('window.__holidayFx && window.__holidayFx().frames > 20', timeout=30000); pg.wait_for_timeout(2000)
            pg.screenshot(path=str(OUT / 'site-mobil-kurban.png')); print('  site-mobil-kurban.png', flush=True)
            ctx.close()
            br.close()
    finally:
        srv.send_signal(signal.SIGTERM)
        try:
            srv.wait(20)
        except subprocess.TimeoutExpired:
            srv.kill(); srv.wait(5)
    if errors:
        print('HATALAR:'); [print(' ', e) for e in errors[:30]]
        sys.exit(1)
    print('simumav_holiday_shots: TAMAM')


if __name__ == '__main__':
    main()
