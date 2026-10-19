#!/opt/hepgo/fabrika-yonetim/.venv/bin/python
"""SIMUMAV oyun kabuğu görsel doğrulama (Playwright headless shell + SwiftShader): menü canlı uçuş sahnesi (3 farklı an), kart hover,
geçiş ortası karesi, hangar/parkur/operasyon, mobil 390 px, Arapça RTL, prefers-reduced-motion. Her adımda window.__smGl() ≤ 1
(tek paylaşılan WebGL bağlamı) ve __smFlight() kare süresi/kalite ölçümleri. Sunucu alt süreç (port 8607, sahte SITL, dev giriş).
Görüntüler /tmp/simumav-shell/. Çalıştır: tests/simumav_shell_shots.py [--keep]"""
import json, os, pathlib, re, shutil, signal, subprocess, sys, time, urllib.request

ROOT = pathlib.Path(__file__).resolve().parents[1]
OUT = pathlib.Path('/tmp/simumav-shell'); OUT.mkdir(exist_ok=True)
DATA = pathlib.Path('/tmp/simumav-shell-data')
PORT = int(os.environ.get('SHELL_PORT', '8607'))
B = f'http://127.0.0.1:{PORT}'
os.environ.setdefault('LD_LIBRARY_PATH', '/home/gelistirici/build/chromelibs/root/usr/lib/x86_64-linux-gnu')
EXE = os.path.expanduser('~/.cache/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell')
ARGS = ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required']
from playwright.sync_api import sync_playwright  # noqa: E402


def start_server():
    if DATA.exists():
        shutil.rmtree(DATA)
    env = {**os.environ, 'SIMUMAV_DATA_DIR': str(DATA), 'SIMUMAV_DEV_LOGIN': '1', 'HEPGO_SITL': '0', 'GOOGLE_MAPS_API_KEY': '', 'SIMUMAV_PUBLIC_HOST': '127.0.0.1',
           'SIMUMAV_SECURE_COOKIE': '0', 'SIMUMAV_MT_INTERNAL': 'http://127.0.0.1:1', 'SIMUMAV_MP_PORT_BASE': '25800'}
    log = open(OUT / 'server.log', 'w')
    p = subprocess.Popen([str(ROOT / '.venv/bin/python'), '-m', 'uvicorn', 'app.simumav.main:app', '--port', str(PORT)], cwd=str(ROOT), env=env, stdout=log, stderr=subprocess.STDOUT)
    for _ in range(80):
        try:
            if urllib.request.urlopen(f'{B}/healthz', timeout=1).status == 200:
                return p
        except Exception:
            time.sleep(0.5)
    p.kill(); raise SystemExit('sunucu açılmadı')


def stop_server(p):
    p.send_signal(signal.SIGTERM)
    try:
        p.wait(20)
    except subprocess.TimeoutExpired:
        p.kill(); p.wait(5)


def main():
    srv = start_server()
    errors, gl_errors, measures, perf = [], [], [], []
    n = [0]; rc = 0
    try:
        with sync_playwright() as pw:
            br = pw.chromium.launch(executable_path=EXE, args=ARGS)

            def new_page(ctx):
                pg = ctx.new_page()
                def on_console(m):
                    txt = m.text[:400]
                    if re.search(r'WebGL|context (loss|lost|could not)', txt, re.I): gl_errors.append(txt)
                    if m.type == 'error' and 'favicon' not in txt: errors.append(f'[console.error] {txt}')
                pg.on('console', on_console)
                pg.on('pageerror', lambda e: errors.append(f'[pageerror] {str(e)[:300]}'))
                return pg

            def shot(pg, name):
                n[0] += 1; pg.screenshot(path=str(OUT / f'{n[0]:02d}-{name}.png')); print('  görüntü', f'{n[0]:02d}-{name}.png', flush=True)

            def gl(pg, label, limit=1):
                v = pg.evaluate('window.__smGl ? window.__smGl() : -1')
                measures.append((label, v)); print(f'  __smGl @ {label}: {v}', flush=True)
                assert v <= limit, f'bağlam sayısı {v} > {limit} ({label})'
                return v

            def flight(pg, label):
                st = pg.evaluate('window.__smFlight ? window.__smFlight() : null')
                if st: perf.append((label, st)); print(f'  __smFlight @ {label}: kalite={st["quality"]} ort={st["gov"]["avgMs"]}ms kötü={st["gov"]["worstMs"]}ms kare={st["frames"]} kip={st["mode"]} arazi={"gerçek" if st["real"] else "prosedürel"} model={st["model"]}', flush=True)
                return st

            def login(pg):
                # geliştirici oturumu doğrudan API ile (site modalındaki düğme meta yüklenmesine bağlı; görsel hedef kabuk)
                pg.goto(B + '/'); pg.wait_for_timeout(300)
                st, d = api(pg, 'POST', '/api/session', {'dev_user': 'shell-pilot'}); assert st in (200, 201), (st, d)
                pg.goto(B + '/app/#/menu'); pg.wait_for_selector('#chip:not([hidden])', timeout=20000)

            def api(pg, method, path, body=None):
                return pg.evaluate("""async ([m, p, b]) => { const r = await fetch(p, { method: m, headers: { 'Content-Type': 'application/json' }, body: b == null ? undefined : JSON.stringify(b) }); let d = null; try { d = await r.json(); } catch {} return [r.status, d]; }""", [method, path, body])

            # ---- Masaüstü
            ctx = br.new_context(viewport={'width': 1440, 'height': 900}, locale='tr-TR')
            pg = new_page(ctx); login(pg)
            pg.wait_for_selector('.menu-grid', timeout=20000)
            # sahne hazır (rozet) — arazi karoları ağdan gelir; en çok 60 sn
            t0 = time.time(); pg.wait_for_selector('.menu-live.on', state='attached', timeout=60000); print('sahne hazır (sn):', round(time.time() - t0, 1))
            pg.wait_for_timeout(1500); shot(pg, 'menu-an1'); gl(pg, 'menü an 1'); flight(pg, 'menü an 1')
            pg.wait_for_timeout(9000); shot(pg, 'menu-an2'); flight(pg, 'menü an 2')
            pg.mouse.move(300, 300); pg.wait_for_timeout(9000); shot(pg, 'menu-an3'); gl(pg, 'menü an 3'); st = flight(pg, 'menü an 3')
            # veri: dron/pilot/parkur/görev
            st1, d1 = api(pg, 'POST', '/api/hangar', {'name': 'Quad-Shell', 'type': 'fpv', 'model_key': 'proc:quad250', 'color': '#38bdf8'}); assert st1 == 201, (st1, d1)
            st1, d2 = api(pg, 'POST', '/api/hangar', {'name': 'Albatros', 'type': 'plane', 'model_key': 'builtin:caymaz', 'color': '#fbbf24'}); assert st1 == 201, (st1, d2)
            st1, p1 = api(pg, 'POST', '/api/crew', {'name': 'Defne', 'character': 'p04'}); assert st1 == 201, (st1, p1)
            st1, trk = api(pg, 'GET', '/api/tracks'); t_first = trk['tracks'][0]
            st1, t2 = api(pg, 'POST', '/api/tracks', {'name': 'Vadi Rüzgârlı', 'lat': 39.925, 'lon': 32.837, 'radius_m': 1500, 'world_mode': 'procedural', 'wind': {'speed_ms': 9, 'dir_deg': 270, 'gust': 2}, 'time_of_day': 'dusk', 'weather': 'cloudy', 'world': {}, 'gates': []}); assert st1 == 201, (st1, t2)
            api(pg, 'POST', '/api/missions', {'track_id': t_first['id'], 'name': 'Serbest', 'kind': 'free', 'plan': {'route': {'points': []}}})
            # hover kart (3B eğilme + kenar + ikon)
            card = pg.locator('.mcard[data-key="hangar"]'); bb = card.bounding_box()
            pg.mouse.move(bb['x'] + bb['width'] * 0.72, bb['y'] + bb['height'] * 0.3); pg.wait_for_timeout(700); shot(pg, 'menu-hover-hangar')
            # geçiş ortası karesi: tıkla, ~260 ms sonra kare
            card.click(); pg.wait_for_timeout(260); shot(pg, 'gecis-ortasi')
            pg.wait_for_selector('.strip', timeout=20000); pg.wait_for_timeout(1800); shot(pg, 'hangar'); gl(pg, 'hangar')
            assert pg.evaluate('!window.__smFlight'), 'menü sahnesi hangarda kapanmalı'
            pg.goto(B + '/app/#/tracks'); pg.wait_for_selector('.track-card', timeout=20000); pg.wait_for_timeout(2200); shot(pg, 'parkur'); gl(pg, 'parkur')
            pg.goto(B + '/app/#/ops'); pg.wait_for_selector('.empty, .op-card', timeout=20000); pg.wait_for_timeout(1500); shot(pg, 'operasyon'); gl(pg, 'operasyon')
            pg.goto(B + '/app/#/settings'); pg.wait_for_selector('.settings-panel', timeout=20000); pg.wait_for_timeout(1200); shot(pg, 'ayarlar'); gl(pg, 'ayarlar')
            # geri dönüş geçişi ortası
            pg.locator('#back').click(); pg.wait_for_timeout(230); shot(pg, 'geri-gecis-ortasi')
            pg.wait_for_selector('.menu-grid', timeout=20000); pg.wait_for_selector('.menu-live.on', state='attached', timeout=60000); pg.wait_for_timeout(1500); gl(pg, 'menü (dönüş)'); flight(pg, 'menü (dönüş)')
            # yükleme bileşeni (radar) — doğrudan ekle ve çek
            pg.evaluate("""(async () => { const m = await import('/app/ui/components.js'); document.getElementById('view').append(m.loading('Sahne yükleniyor')); })()"""); pg.wait_for_timeout(500); shot(pg, 'yukleme-radar')
            # açık tema
            pg.evaluate("document.documentElement.dataset.theme='light'; window.dispatchEvent(new CustomEvent('sm:theme',{detail:'light'}))"); pg.evaluate("document.querySelector('.loading')?.remove()"); pg.wait_for_timeout(1500); shot(pg, 'menu-acik-tema')
            pg.evaluate("document.documentElement.dataset.theme='dark'; window.dispatchEvent(new CustomEvent('sm:theme',{detail:'dark'}))")
            assert not gl_errors, gl_errors
            ctx.close()

            # ---- Mobil 390×844
            ctx = br.new_context(viewport={'width': 390, 'height': 844}, locale='tr-TR', is_mobile=True, has_touch=True, device_scale_factor=2)
            pg = new_page(ctx); login(pg); pg.wait_for_selector('.menu-grid', timeout=20000); pg.wait_for_selector('.menu-live.on', state='attached', timeout=60000); pg.wait_for_timeout(2500)
            shot(pg, 'mobil-menu'); gl(pg, 'mobil menü'); flight(pg, 'mobil menü')
            pg.goto(B + '/app/#/hangar'); pg.wait_for_selector('.strip', timeout=20000); pg.wait_for_timeout(1500); shot(pg, 'mobil-hangar'); gl(pg, 'mobil hangar')
            ctx.close()

            # ---- Arapça RTL
            ctx = br.new_context(viewport={'width': 1440, 'height': 900}, locale='ar')
            pg = new_page(ctx); pg.add_init_script("localStorage.setItem('sm:lang','ar')"); login(pg)
            pg.wait_for_selector('.menu-grid', timeout=20000); pg.wait_for_selector('.menu-live.on', state='attached', timeout=60000); pg.wait_for_timeout(2000)
            assert pg.evaluate('document.documentElement.dir') == 'rtl'
            shot(pg, 'rtl-menu'); gl(pg, 'rtl menü')
            pg.goto(B + '/app/#/tracks'); pg.wait_for_selector('.track-card', timeout=20000); pg.wait_for_timeout(1800); shot(pg, 'rtl-parkur')
            ctx.close()

            # ---- prefers-reduced-motion: statik kare, kart eğilmesi yok, geçiş kısa fade
            ctx = br.new_context(viewport={'width': 1440, 'height': 900}, locale='tr-TR', reduced_motion='reduce')
            pg = new_page(ctx); login(pg); pg.wait_for_selector('.menu-grid', timeout=20000); pg.wait_for_selector('.menu-live.on', state='attached', timeout=60000); pg.wait_for_timeout(1500)
            f1 = pg.evaluate('window.__smFlight().frames'); pg.wait_for_timeout(1200); f2 = pg.evaluate('window.__smFlight().frames')
            print('  reduced-motion kare sayısı:', f1, '→', f2); assert f2 - f1 <= 1, 'reduced-motion\'da sahne statik kalmalı'
            assert pg.evaluate("window.__smFlight().running") is False
            shot(pg, 'reduced-motion-menu'); gl(pg, 'reduced menü')
            pg.locator('.mcard[data-key="crew"]').click(); pg.wait_for_selector('.crew-grid', timeout=20000); pg.wait_for_timeout(600); shot(pg, 'reduced-crew'); gl(pg, 'reduced mürettebat')
            ctx.close()
            assert not gl_errors, gl_errors
            br.close()
    except Exception as e:
        rc = 1; print('HATA:', repr(e)[:800], flush=True)
    finally:
        (OUT / 'olcumler.json').write_text(json.dumps({'gl': measures, 'flight': perf, 'gl_errors': gl_errors, 'errors': errors}, ensure_ascii=False, indent=1))
        print('GL ölçümleri:', ', '.join(f'{l}={v}' for l, v in measures))
        print(f'WebGL hata: {len(gl_errors)}  konsol hata: {len(errors)}')
        for e in errors[:20]: print('  ', e)
        if '--keep' not in sys.argv: stop_server(srv)
        else: print('sunucu açık bırakıldı pid', srv.pid)
    sys.exit(rc)


if __name__ == '__main__':
    main()
