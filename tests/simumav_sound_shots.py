#!/opt/hepgo/fabrika-yonetim/.venv/bin/python
"""SIMUMAV ses + hareketli arka planlar görsel/davranış doğrulaması (Playwright headless shell + SwiftShader).

Her bölüm (menü, hangar, mürettebat, parkur, görevler, Uç seçimi, Uç sihirbazı, ayarlar) × masaüstü 1440×900 + mobil 390×844 × TR + EN
ekran görüntüsü → /tmp/smsound-shots. Ölçümler: window.__smBackdrop() (sahne, kare süresi ort./en kötü), window.__smMusic() (ilk
etkileşimden sonra çalıyor, uçuş oturumunda 0'a iner ve zamanlayıcı durur), __smGl() ≤ 1 (arka plan WebGL açmaz), reduced-motion → durağan,
sekme gizli → döngü durur, Ayarlar › Ses düzeyleri kaydırıcısı localStorage'a yazar. Sunucu alt süreç (port 8651, dev giriş, sahte SITL).
Çalıştır: tests/simumav_sound_shots.py
"""
import json, os, pathlib, re, shutil, signal, subprocess, sys, time, urllib.request

ROOT = pathlib.Path(__file__).resolve().parents[1]
OUT = pathlib.Path('/tmp/smsound-shots'); OUT.mkdir(exist_ok=True)
DATA = pathlib.Path('/tmp/smsound-shots-data')
PORT = int(os.environ.get('SMSOUND_PORT', '8651'))
B = f'http://127.0.0.1:{PORT}'
os.environ.setdefault('LD_LIBRARY_PATH', '/home/gelistirici/build/chromelibs/root/usr/lib/x86_64-linux-gnu')
EXE = os.path.expanduser('~/.cache/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell')
ARGS = ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required']
from playwright.sync_api import sync_playwright  # noqa: E402

SECTIONS = [('menu', '#/menu', None), ('hangar', '#/hangar', 'hangar'), ('crew', '#/crew', 'crew'), ('tracks', '#/tracks', 'tracks'),
            ('missions', '#/missions', 'missions'), ('fly', '#/fly', 'caymaz'), ('fly-solo', '#/fly/solo', 'caymaz'), ('settings', '#/settings', None)]


def start_server():
    if DATA.exists():
        shutil.rmtree(DATA)
    env = {**os.environ, 'SIMUMAV_DATA_DIR': str(DATA), 'SIMUMAV_DEV_LOGIN': '1', 'HEPGO_SITL': '0', 'GOOGLE_MAPS_API_KEY': '', 'SIMUMAV_PUBLIC_HOST': '127.0.0.1',
           'SIMUMAV_SECURE_COOKIE': '0', 'SIMUMAV_MT_INTERNAL': 'http://127.0.0.1:1', 'SIMUMAV_MP_PORT_BASE': '25900'}
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
    errors, perf, checks = [], [], []
    rc = 0
    try:
        with sync_playwright() as pw:
            br = pw.chromium.launch(executable_path=EXE, args=ARGS)

            def new_page(ctx):
                ctx.set_default_timeout(120000); ctx.set_default_navigation_timeout(120000)
                pg = ctx.new_page()
                pg.on('console', lambda m: errors.append(f'[console.error] {m.text[:300]}') if m.type == 'error' and 'favicon' not in m.text and 'tile' not in m.text.lower() and 'Failed to load resource' not in m.text else None)
                pg.on('pageerror', lambda e: errors.append(f'[pageerror] {str(e)[:300]}'))
                return pg

            def api(pg, method, path, body=None):
                return pg.evaluate("""async ([m, p, b]) => { const r = await fetch(p, { method: m, headers: { 'Content-Type': 'application/json' }, body: b == null ? undefined : JSON.stringify(b) }); let d = null; try { d = await r.json(); } catch {} return [r.status, d]; }""", [method, path, body])

            def login(pg, lang, user):
                pg.add_init_script(f"localStorage.setItem('sm:lang','{lang}')")
                pg.goto(B + '/'); pg.wait_for_timeout(300)
                st, d = api(pg, 'POST', '/api/session', {'dev_user': user}); assert st in (200, 201), (st, d)
                pg.goto(B + '/app/#/menu'); pg.wait_for_selector('#chip:not([hidden])', timeout=20000)

            def check(label, cond, info=''):
                checks.append((label, bool(cond), info)); print(('  ✓ ' if cond else '  ✗ ') + label, info, flush=True)
                assert cond, f'{label} {info}'

            def run(lang, kind, vp, extra):
                ctx = br.new_context(viewport=vp, locale='tr-TR' if lang == 'tr' else 'en-US', **extra)
                pg = new_page(ctx); login(pg, lang, f'snd-{lang}-{kind}')
                if lang == 'tr' and kind == 'desk':   # örnek veri: hangar/mürettebat/parkur dolu görünsün
                    api(pg, 'POST', '/api/hangar', {'name': 'Albatros', 'type': 'plane', 'model_key': 'builtin:caymaz', 'color': '#fbbf24'})
                    api(pg, 'POST', '/api/crew', {'name': 'Defne', 'character': 'p04'})
                pg.mouse.click(5, vp['height'] - 5)   # ilk etkileşim → ses kilidi + müzik
                for key, hsh, scene in SECTIONS:
                    pg.goto(B + '/app/' + hsh)
                    pg.wait_for_function(f"window.__smBackdrop && document.body.dataset.screen === '{hsh.split('/')[1]}' && window.__smBackdrop().scene === {json.dumps(scene)}", timeout=45000)
                    pg.wait_for_timeout(2200 if kind == 'desk' else 1800)
                    st = pg.evaluate('window.__smBackdrop ? window.__smBackdrop() : null')
                    gl = pg.evaluate('window.__smGl ? window.__smGl() : -1')
                    print('  ', key, json.dumps(st), flush=True)
                    name = f'{kind}-{lang}-{key}.png'; pg.screenshot(path=str(OUT / name), timeout=120000); print('  görüntü', name, flush=True)
                    check(f'{kind}/{lang}/{key}: sahne={scene}', st and st['scene'] == scene, json.dumps(st))
                    check(f'{kind}/{lang}/{key}: WebGL bağlamı ≤ 1', gl <= 1, f'gl={gl}')
                    if scene: perf.append({'lang': lang, 'kind': kind, 'section': key, **st})
                return ctx, pg

            only_reduced = '--reduced' in sys.argv   # yalnız reduced-motion bölümü (hızlı yeniden koşu)
            # ---- masaüstü TR (+ davranış denetimleri)
            if not only_reduced:
                ctx, pg = run('tr', 'desk', {'width': 1440, 'height': 900}, {})
                pg.goto(B + '/app/#/hangar'); pg.wait_for_timeout(1500)
                m = pg.evaluate('window.__smMusic()'); check('müzik ilk etkileşimden sonra çalıyor', m['playing'] and m['built'] and m['target'] > 0.1, json.dumps(m))
                pg.wait_for_timeout(2500); m = pg.evaluate('window.__smMusic()'); check('müzik yumuşak fade-in ile düzeye ulaştı', m['level'] > 0.05, json.dumps(m))
                # uçuş oturumu benzetimi: #view.sm-fly-session → arka plan kapanır, müzik 0'a iner ve zamanlayıcı durur
                pg.goto(B + '/app/#/fly'); pg.wait_for_timeout(1500)
                m = pg.evaluate('window.__smMusic()'); check('Uç girişinde müzik kısık (0,7×)', abs(m['target'] - 0.7 * pg.evaluate("Math.pow(0.55,1.5)*0.9")) < 0.01, json.dumps(m))
                pg.evaluate("document.getElementById('view').classList.add('sm-fly-session')"); pg.wait_for_timeout(1800)
                st = pg.evaluate('window.__smBackdrop()'); m = pg.evaluate('window.__smMusic()')
                check('uçuş oturumunda arka plan yok + döngü durdu', st['scene'] is None and not st['running'], json.dumps(st))
                check('uçuş oturumunda müzik 0 + zamanlayıcı durdu', m['target'] == 0 and not m['timer'] and m['level'] < 0.01, json.dumps(m))
                pg.evaluate("document.getElementById('view').classList.remove('sm-fly-session')"); pg.wait_for_timeout(800)
                st = pg.evaluate('window.__smBackdrop()'); m = pg.evaluate('window.__smMusic()')
                check('oturumdan çıkınca sahne + müzik geri', st['scene'] == 'caymaz' and m['timer'], json.dumps([st['scene'], m]))
                # sekme gizli → döngü durur
                pg.evaluate("Object.defineProperty(document, 'hidden', { configurable: true, get: () => true }); document.dispatchEvent(new Event('visibilitychange'))"); pg.wait_for_timeout(600)
                f1 = pg.evaluate('window.__smBackdrop().frames'); pg.wait_for_timeout(800); f2 = pg.evaluate('window.__smBackdrop().frames')
                check('sekme gizliyken kare çizilmez', f2 == f1 and not pg.evaluate('window.__smBackdrop().running'), f'{f1}→{f2}')
                pg.evaluate("Object.defineProperty(document, 'hidden', { configurable: true, get: () => false }); document.dispatchEvent(new Event('visibilitychange'))"); pg.wait_for_timeout(600)
                check('sekme görünür olunca devam', pg.evaluate('window.__smBackdrop().running'))
                # Ayarlar › Ses düzeyleri
                pg.goto(B + '/app/#/settings'); pg.wait_for_selector('.mix-row[data-mix="music"]', timeout=20000); pg.wait_for_timeout(800)
                pg.evaluate("""(() => { const i = document.querySelector('.mix-row[data-mix="music"] input'); i.value = 30; i.dispatchEvent(new Event('input', { bubbles: true })); })()""")
                pg.locator('.mix-row[data-mix="alert"] .switch').click(); pg.locator('.mix-row[data-mix="sfx"] .switch').click()
                ls = pg.evaluate("({ music: localStorage.getItem('sm.music'), gpws: localStorage.getItem('sm.gpws'), sfx: localStorage.getItem('sm.sfx') })")
                check('ayar: müzik düzeyi sm.music', json.loads(ls['music'])['vol'] == 30, ls['music'])
                check('ayar: uyarı sesi kapalı → sm.gpws.mode=visual', json.loads(ls['gpws'])['mode'] == 'visual', ls['gpws'])
                check('ayar: efekt kapalı → sm.sfx.on=false', json.loads(ls['sfx'])['on'] is False, ls['sfx'])
                pg.locator('.mix-row[data-mix="music"]').scroll_into_view_if_needed(); pg.wait_for_timeout(300); pg.screenshot(path=str(OUT / 'desk-tr-settings-mix.png'), timeout=120000)
                m = pg.evaluate('window.__smMusic()'); check('müzik düzeyi canlı güncellendi', abs(m['target'] - pow(0.3, 1.5) * 0.9) < 0.01, json.dumps(m))
                # açık tema (silik arka plan)
                pg.goto(B + '/app/#/tracks'); pg.wait_for_timeout(1200)
                pg.evaluate("document.documentElement.dataset.theme='light'; window.dispatchEvent(new CustomEvent('sm:theme',{detail:'light'}))"); pg.wait_for_timeout(1600)
                pg.screenshot(path=str(OUT / 'desk-tr-tracks-light.png'), timeout=120000); print('  görüntü desk-tr-tracks-light.png')
                ctx.close()
                # ---- masaüstü EN, mobil TR + EN
                run('en', 'desk', {'width': 1440, 'height': 900}, {})[0].close()
                for lang in ('tr', 'en'):
                    run(lang, 'mob', {'width': 390, 'height': 844}, {'is_mobile': True, 'has_touch': True, 'device_scale_factor': 2})[0].close()
            # ---- reduced-motion: durağan tek kare
            ctx = br.new_context(viewport={'width': 1440, 'height': 900}, locale='tr-TR', reduced_motion='reduce')
            pg = new_page(ctx); login(pg, 'tr', 'snd-reduced')
            for key, hsh, scene in SECTIONS[1:6]:
                pg.goto(B + '/app/' + hsh)
                pg.wait_for_function(f"window.__smBackdrop && window.__smBackdrop().scene === '{scene}'", timeout=60000); pg.wait_for_timeout(2500)   # atlas yüklemesi sonrası tek yeniden çizim dahil
                f1 = pg.evaluate('window.__smBackdrop().frames'); pg.wait_for_timeout(1500); st = pg.evaluate('window.__smBackdrop()')
                check(f'reduced-motion {key}: durağan', st['reduced'] and not st['running'] and st['frames'] - f1 <= 1, json.dumps(st))   # döngü yok; atlas yüklenmesi / yeniden boyutlanmada tek yeniden çizim olabilir
            pg.screenshot(path=str(OUT / 'reduced-tr-missions.png'), timeout=120000)
            ctx.close()
            br.close()
    except Exception as e:
        rc = 1; print('HATA:', repr(e)[:800], flush=True)
    finally:
        (OUT / 'olcumler.json').write_text(json.dumps({'perf': perf, 'checks': checks, 'errors': errors}, ensure_ascii=False, indent=1))
        if perf:
            print('\nKare süresi (Canvas2D, SwiftShader/CPU headless):')
            for p in perf: print(f"  {p['kind']:4} {p['lang']} {p['section']:9} {p['scene']:8} ort={p['avgMs']:.2f} ms  en kötü={p['worstMs']:.2f} ms  {p['w']}×{p['h']} @ {p['fps']} fps  düşük güç={p['lowPower']}")
        print(f'konsol hata: {len(errors)}')
        for e in errors[:20]: print('  ', e)
        stop_server(srv)
    sys.exit(rc or (1 if errors else 0))


if __name__ == '__main__':
    main()
