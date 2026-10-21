#!/opt/hepgo/fabrika-yonetim/.venv/bin/python
"""SIMUMAV tanıtım sitesi görsel doğrulama (Playwright headless shell + SwiftShader) — GERÇEK SIMUMAV uygulaması (app.simumav.main; CSP
başlıklarıyla) aynı süreçte iş parçacığı olarak açılır (arka plan süreci bırakılmaz). Görüntüler /tmp/smsite-shots/ (SITE_SHOTS ile değişir).
Denetimler: CSP ihlali yok (konsol "Content Security Policy"/"Refused to"), sayfa hatası yok, WebGL bağlam sayısı ≤ 1 (window.__smSiteGl),
açılış sinematiğinde model geçişleri (3+ kare, farklı modeller), Hangar galerisi (karolar hazır + büyütülmüş görünüm), modül kartı → hash,
EO kip seçici, gece/gündüz teması (kalıcı), mobil 390 px, Arapça RTL, prefers-reduced-motion (döngü yok).
Çalıştır: ./.venv/bin/python -m tests.simumav_site_shots"""
import json
import os
import pathlib
import shutil
import socket
import sys
import threading
import time

os.environ.setdefault('LD_LIBRARY_PATH', '/home/gelistirici/build/chromelibs/root/usr/lib/x86_64-linux-gnu')
DATA = '/tmp/smsite-shots-data'
shutil.rmtree(DATA, ignore_errors=True)
os.makedirs(DATA, exist_ok=True)
os.environ.update(SIMUMAV_DATA_DIR=DATA, SIMUMAV_DEV_LOGIN='1', HEPGO_SITL='0', SIMUMAV_UDP_BASE='25750', SIMUMAV_MAX_FLIGHTS='1',
                  SIMUMAV_MP_PORT_BASE='26800', SIMUMAV_MP_PORT_COUNT='10', SIMUMAV_SECURE_COOKIE='0', SIMUMAV_ENV_FILE=os.path.join(DATA, 'yok.env'),
                  SIMUMAV_MT_INTERNAL='http://127.0.0.1:1', GOOGLE_MAPS_API_KEY='')
PORT = int(os.environ.get('SHOT_PORT') or 8757)
BASE = f'http://127.0.0.1:{PORT}'
OUT = pathlib.Path(os.environ.get('SITE_SHOTS') or '/tmp/smsite-shots'); OUT.mkdir(parents=True, exist_ok=True)
EXE = os.path.expanduser('~/.cache/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell')
ARGS = ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist']

import uvicorn  # noqa: E402
from playwright.sync_api import sync_playwright  # noqa: E402

import app.simumav.main as smain  # noqa: E402

server = uvicorn.Server(uvicorn.Config(smain.app, host='127.0.0.1', port=PORT, log_level='error'))
threading.Thread(target=server.run, daemon=True).start()
for _ in range(120):
    try:
        socket.create_connection(('127.0.0.1', PORT), 0.3).close(); break
    except OSError:
        time.sleep(0.25)
else:
    sys.exit('sunucu açılmadı')

hatalar, csp = [], []


def izle(pg, etiket):
    def on_console(m):
        txt = m.text[:300]
        if 'Content Security Policy' in txt or 'Refused to' in txt:
            csp.append(f'{etiket}: {txt}')
        elif m.type == 'error' and 'favicon' not in txt and 'GPU stall' not in txt and 'WebGL' not in txt:
            hatalar.append(f'{etiket} KONSOL: {txt}')
    pg.on('console', on_console)
    pg.on('pageerror', lambda e: hatalar.append(f'{etiket} SAYFA: {str(e)[:300]}'))
    pg.on('response', lambda r: hatalar.append(f'{etiket} HTTP {r.status} {r.url[len(BASE):][:100]}') if r.status >= 400 and '/api/' not in r.url else None)


def shot(pg, ad, **kw):
    pg.screenshot(path=str(OUT / ad), **kw)
    print('  kare', ad, flush=True)


def gl(pg, etiket):
    v = pg.evaluate('window.__smSiteGl ? window.__smSiteGl() : 0')
    print(f'  WebGL bağlamı @ {etiket}: {v}', flush=True)
    if v > 1:
        hatalar.append(f'{etiket}: WebGL bağlamı {v} > 1')


def git(pg, sec, bekle=1400):
    pg.evaluate(f"document.getElementById('{sec}').scrollIntoView({{block: 'start', behavior: 'instant'}})")
    pg.wait_for_timeout(bekle)


def hero_bekle(pg, sn=90):
    pg.wait_for_function('() => window.__smHero && window.__smHero.info().loaded >= 1 && document.querySelector("#hero3d.on")', timeout=sn * 1000)


def cekim_ortasi(pg, sn=120):
    """Karartma bitmiş, çekimin ortasında (SwiftShader yavaş: süre yerine çekim zamanı beklenir)."""
    pg.wait_for_function('() => { const i = window.__smHero.info(); return i.paused || (i.shotT > 2.2 && i.shotT < 5.8); }', timeout=sn * 1000)


rc = 0
try:
    with sync_playwright() as p:
        b = p.chromium.launch(executable_path=EXE, args=ARGS)
        INIT = "try { localStorage.setItem('simumav.consent', 'denied'); } catch (e) {}"
        # ---------------- masaüstü, gece ----------------
        ctx = b.new_context(viewport={'width': 1440, 'height': 900}, locale='tr-TR', color_scheme='dark')
        ctx.add_init_script(INIT)
        pg = ctx.new_page(); izle(pg, 'masaüstü')
        t0 = time.time()
        pg.goto(BASE + '/?lang=tr', wait_until='domcontentloaded')
        print('  ilk içerik (sn):', round(time.time() - t0, 2), flush=True)
        hero_bekle(pg); print('  sinematik hazır (sn):', round(time.time() - t0, 1), flush=True)
        # model geçişleri: 4 çekim boyunca birer kare (model kimliği değişince, çekimin ortasında)
        goruldu = []
        for k in range(4):
            pg.wait_for_function('(prev) => { const i = window.__smHero.info(); return i.id !== prev && i.shotT > 2.6; }', arg=goruldu[-1] if goruldu else '', timeout=120000)
            info = pg.evaluate('window.__smHero.info()'); goruldu.append(info['id'])
            shot(pg, f'01-hero-{k + 1}-{info["id"]}.png')
            print('   ', info, '·', pg.inner_text('#reel .reel-meta').replace('\n', ' '), flush=True)
        if len(set(goruldu)) < 3:
            hatalar.append(f'sinematik: yeterli model geçişi yok {goruldu}')
        # geçiş ortası (karartma) karesi
        pg.wait_for_function('() => { const v = parseFloat(getComputedStyle(document.getElementById("hero")).getPropertyValue("--dip")); return v > 0.35 && v < 0.95; }', timeout=60000)
        shot(pg, '02-hero-gecis.png')
        gl(pg, 'açılış')
        # duraklat + sonraki
        pg.click('#reel-pause'); pg.wait_for_timeout(500)
        if pg.evaluate('window.__smHero.paused') is not True:
            hatalar.append('duraklat çalışmadı')
        pg.click('#reel-next'); pg.wait_for_timeout(2500); shot(pg, '03-hero-duraklat-sonraki.png')
        pg.click('#reel-pause')
        # modüller + kart → hash
        git(pg, 'modules'); shot(pg, '04-moduller.png')
        pg.click('.mod-card[data-mod="hangar"] h3 a'); pg.wait_for_timeout(1800)
        print('  hash:', pg.evaluate('location.hash'), flush=True)
        if pg.evaluate('location.hash') != '#hangar':
            hatalar.append('modül kartı hash vermedi')
        pg.wait_for_function('() => window.__smHangar && window.__smHangar.info().ready >= 6', timeout=180000)
        pg.wait_for_timeout(2500)
        git(pg, 'hangar', 2500)
        print('  hangar:', pg.evaluate('window.__smHangar.info()'), flush=True)
        shot(pg, '05-hangar.png')
        pg.evaluate("window.scrollBy(0, 520)"); pg.wait_for_timeout(4000); shot(pg, '05b-hangar-alt.png')
        gl(pg, 'hangar')
        pg.click('.chip[data-type="interceptor"]'); pg.wait_for_timeout(1500); git(pg, 'hangar', 3000); shot(pg, '06-hangar-suzgec.png')
        pg.click('.chip[data-type="all"]')
        pg.click('.fleet-card[data-id="caymaz"]'); pg.wait_for_selector('#fleet-view.ready', timeout=60000); pg.wait_for_timeout(1500)
        shot(pg, '07-hangar-buyut.png')
        pg.keyboard.press('ArrowRight'); pg.keyboard.press('ArrowRight'); pg.click('.fv-next'); pg.wait_for_timeout(2500)
        shot(pg, '07b-hangar-buyut-sonraki.png')
        gl(pg, 'büyütülmüş')
        pg.keyboard.press('Escape'); pg.wait_for_timeout(400)
        if not pg.evaluate("document.getElementById('fleet-view').hidden"):
            hatalar.append('diyalog Esc ile kapanmadı')
        for i, sec in enumerate(['crew', 'tracks', 'missions', 'fly', 'ops'], start=8):
            git(pg, sec, 1800); shot(pg, f'{i:02d}-{sec}.png')
        git(pg, 'systems', 2000); shot(pg, '13-sistemler.png')
        pg.evaluate("window.scrollBy(0, 700)"); pg.wait_for_timeout(1500)
        pg.click('[data-eo-btn="thermal"]'); pg.wait_for_timeout(900); shot(pg, '14-sistemler-eo-termal.png')
        pg.click('[data-eo-btn="night"]'); pg.wait_for_timeout(900); shot(pg, '14b-sistemler-eo-gece.png')
        pg.evaluate("window.scrollBy(0, 800)"); pg.wait_for_timeout(1200); shot(pg, '15-sistemler-hedef.png')
        pg.evaluate("window.scrollBy(0, 800)"); pg.wait_for_timeout(1200); shot(pg, '15b-sistemler-firlatici.png')
        git(pg, 'physics'); shot(pg, '16-fizik.png')
        # ---------------- gündüz teması (düğme; kalıcı) ----------------
        pg.evaluate('scrollTo(0, 0)'); pg.wait_for_timeout(500)
        pg.click('#theme-btn'); pg.wait_for_timeout(1500); cekim_ortasi(pg)
        th = pg.evaluate("[document.documentElement.dataset.theme, localStorage.getItem('simumav.theme')]")
        print('  tema:', th, flush=True)
        if th[0] != 'light':
            hatalar.append(f'tema düğmesi: {th}')
        shot(pg, '20-gunduz-hero.png')
        for i, sec in enumerate(['modules', 'hangar', 'missions', 'systems'], start=21):
            git(pg, sec, 2600); shot(pg, f'{i}-gunduz-{sec}.png')
        pg.evaluate('scrollTo(0, 0)'); pg.reload(wait_until='domcontentloaded'); pg.evaluate('scrollTo(0, 0)'); hero_bekle(pg); cekim_ortasi(pg)
        if pg.evaluate('document.documentElement.dataset.theme') != 'light':
            hatalar.append('tema kalıcı değil')
        shot(pg, '25-gunduz-yeniden-yukle.png')
        pg.click('#theme-btn'); pg.wait_for_timeout(300)   # geri: gece (sistemle aynı → kayıt silinir)
        print('  tema kaydı (sistemle aynı → null):', pg.evaluate("localStorage.getItem('simumav.theme')"), flush=True)
        # kayıt modalı (gece)
        pg.click('.nav [data-auth="register"]'); pg.wait_for_timeout(700); shot(pg, '26-kayit-modal.png'); pg.keyboard.press('Escape')
        # Arapça RTL
        pg.select_option('#lang', 'ar'); pg.wait_for_timeout(1200)
        git(pg, 'hangar', 2500); shot(pg, '27-ar-hangar.png')
        if pg.evaluate('document.documentElement.scrollWidth') > 1440:
            hatalar.append('RTL yatay taşma')
        pg.select_option('#lang', 'tr'); pg.wait_for_timeout(500)
        ctx.close()
        # ---------------- sistem gündüz teması (kayıt yok → prefers-color-scheme) ----------------
        c2 = b.new_context(viewport={'width': 1440, 'height': 900}, locale='en-US', color_scheme='light'); c2.add_init_script(INIT)
        p2 = c2.new_page(); izle(p2, 'sistem-açık')
        p2.goto(BASE + '/', wait_until='domcontentloaded'); hero_bekle(p2); cekim_ortasi(p2); p2.wait_for_timeout(600)
        if p2.evaluate('document.documentElement.dataset.theme') != 'light':
            hatalar.append('sistem açık teması izlenmedi')
        shot(p2, '30-sistem-acik-en.png'); c2.close()
        # ---------------- mobil 390 ----------------
        m = b.new_context(viewport={'width': 390, 'height': 844}, device_scale_factor=2, is_mobile=True, has_touch=True, locale='tr-TR', color_scheme='dark')
        m.add_init_script(INIT)
        mp = m.new_page(); izle(mp, 'mobil')
        mp.goto(BASE + '/?lang=tr', wait_until='domcontentloaded'); hero_bekle(mp); cekim_ortasi(mp)
        shot(mp, '40-mobil-hero.png')
        print('  mobil sinematik:', mp.evaluate('window.__smHero.info()'), flush=True)
        git(mp, 'modules'); shot(mp, '41-mobil-moduller.png')
        git(mp, 'hangar', 1500)
        mp.wait_for_function('() => window.__smHangar && window.__smHangar.info().ready >= 4', timeout=180000); mp.wait_for_timeout(3000)
        shot(mp, '42-mobil-hangar.png')
        mp.evaluate("document.querySelector('.fleet-card[data-id=icept_x4]').click()"); mp.wait_for_selector('#fleet-view.ready', timeout=60000); mp.wait_for_timeout(1500)
        shot(mp, '43-mobil-buyut.png'); mp.keyboard.press('Escape')
        git(mp, 'systems', 1800); shot(mp, '44-mobil-sistemler.png')
        if mp.evaluate('document.documentElement.scrollWidth') > 390:
            hatalar.append(f"mobil yatay taşma {mp.evaluate('document.documentElement.scrollWidth')}")
        gl(mp, 'mobil')
        m.close()
        # ---------------- hareket azaltma ----------------
        r = b.new_context(viewport={'width': 1280, 'height': 800}, reduced_motion='reduce', locale='tr-TR'); r.add_init_script(INIT)
        rp = r.new_page(); izle(rp, 'reduced')
        rp.goto(BASE + '/?lang=tr', wait_until='domcontentloaded'); hero_bekle(rp); rp.wait_for_timeout(1500)
        i1 = rp.evaluate('window.__smHero.info()'); rp.wait_for_timeout(2000); i2 = rp.evaluate('window.__smHero.info()')
        print('  reduced:', i1, '→', i2, flush=True)
        if i1['shotT'] != i2['shotT']:
            hatalar.append('reduced-motion: sinematik ilerliyor')
        shot(rp, '50-reduced.png')
        rp.click('#reel-next'); rp.wait_for_timeout(3000); shot(rp, '51-reduced-sonraki.png')
        r.close()
        b.close()
except Exception as e:   # noqa: BLE001
    rc = 1
    print('HATA:', repr(e)[:600], flush=True)
finally:
    server.should_exit = True
    time.sleep(0.8)
print('CSP ihlali:', json.dumps(csp, ensure_ascii=False, indent=1) if csp else 'yok')
print('hatalar:', json.dumps(hatalar, ensure_ascii=False, indent=1) if hatalar else 'yok')
print('görüntüler:', OUT)
sys.exit(1 if rc or csp or any('SAYFA' in h for h in hatalar) else 0)
