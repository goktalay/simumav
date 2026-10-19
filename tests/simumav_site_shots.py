#!/opt/hepgo/fabrika-yonetim/.venv/bin/python
"""SIMUMAV tanıtım sitesi görsel doğrulama (Playwright headless shell + SwiftShader).
Üretim yerleşimini taklit eden geçici kök (www: site dosyaları + /brand + /vendor sembolik bağları) python -m http.server ile
sunulur (PID ile kapatılır); görüntüler /tmp/simumav/site-shots/ altına yazılır. Konsol hataları raporlanır."""
import os, pathlib, subprocess, sys, time, json, socket
os.environ.setdefault('LD_LIBRARY_PATH', '/home/gelistirici/build/chromelibs/root/usr/lib/x86_64-linux-gnu')
from playwright.sync_api import sync_playwright  # noqa: E402

ROOT = pathlib.Path(__file__).resolve().parents[1]
SITE, BRAND, VENDOR = ROOT / 'static/simumav/site', ROOT / 'static/simumav/brand', ROOT / 'static/vendor'
WWW = pathlib.Path('/tmp/simumav/www'); OUT = pathlib.Path('/tmp/simumav/site-shots')
EXE = os.path.expanduser('~/.cache/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell')
ARGS = ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist']


def free_port():
    with socket.socket() as s:
        s.bind(('127.0.0.1', 0)); return s.getsockname()[1]


def prepare_www():
    WWW.mkdir(parents=True, exist_ok=True); OUT.mkdir(parents=True, exist_ok=True)
    for p in WWW.iterdir():
        if p.is_symlink() or p.is_file(): p.unlink()
    for p in SITE.iterdir(): (WWW / p.name).symlink_to(p)
    (WWW / 'brand').symlink_to(BRAND); (WWW / 'vendor').symlink_to(VENDOR)


def main():
    prepare_www()
    port = free_port()
    srv = subprocess.Popen([sys.executable, '-m', 'http.server', str(port), '--bind', '127.0.0.1', '-d', str(WWW)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    base = f'http://127.0.0.1:{port}'
    hatalar = []
    try:
        time.sleep(0.8)
        with sync_playwright() as p:
            b = p.chromium.launch(executable_path=EXE, args=ARGS)
            ctx = b.new_context(viewport={'width': 1440, 'height': 900}, locale='tr-TR')
            pg = ctx.new_page()
            pg.on('console', lambda m: hatalar.append(f'KONSOL {m.type}: {m.text[:300]}') if m.type in ('error', 'warning') else None)
            pg.on('pageerror', lambda e: hatalar.append('SAYFA: ' + str(e)[:400]))
            pg.goto(base + '/?lang=tr', wait_until='networkidle')
            t = time.time(); pg.wait_for_selector('#hero3d.on', state='attached', timeout=60000); print('3B sahne hazır (sn):', round(time.time() - t, 1))
            pg.wait_for_timeout(2500)   # kamera dolly ilerlesin
            pg.screenshot(path=str(OUT / '01-acilis.png'))
            pg.wait_for_timeout(2500)
            pg.screenshot(path=str(OUT / '02-acilis-sonra.png'))
            # açılış: dört çözünürlükte dron/başlık çakışma denetimi (dron izdüşümü metin bloğunun sağında olmalı)
            for w, h in ((1440, 900), (1920, 1080), (1280, 720), (390, 844)):
                c2 = b.new_context(viewport={'width': w, 'height': h}, locale='tr-TR'); p2 = c2.new_page()
                p2.goto(base + '/?lang=tr', wait_until='networkidle'); p2.wait_for_selector('#hero3d.on', state='attached', timeout=60000); p2.wait_for_timeout(3000)
                p2.screenshot(path=str(OUT / f'01-acilis-{w}x{h}.png')); c2.close()
            # kaydırma bölümleri
            for i, sec in enumerate(['modules', 'physics', 'fpv', 'cta'], start=3):
                pg.evaluate(f"document.getElementById('{sec}').scrollIntoView({{block: 'start', behavior: 'instant'}})")
                pg.wait_for_timeout(1800)
                pg.screenshot(path=str(OUT / f'{i:02d}-{sec}.png'))
            scene = pg.evaluate('document.body.dataset.scene'); print('sahne:', scene)
            # tam sayfa
            pg.evaluate('scrollTo(0,0)'); pg.wait_for_timeout(600)
            # kayıt modalı
            pg.click('.nav [data-auth="register"]'); pg.wait_for_timeout(700)
            assert not pg.evaluate("document.getElementById('auth').hidden")
            pg.screenshot(path=str(OUT / '07-kayit-modal.png'))
            pg.click('[data-auth="login"][data-i18n="auth.to.login"]'); pg.wait_for_timeout(400)
            pg.screenshot(path=str(OUT / '08-giris-modal.png'))
            # hesap servisi yok (statik): /api/meta 404 → kullanıcı dostu hata
            pg.fill('#f-login [name=email]', 'test@example.com'); pg.fill('#f-login [name=password]', 'sifre1234'); pg.click('#f-login button[type=submit]')
            pg.wait_for_timeout(800)
            print('hata iletisi:', pg.inner_text('#auth-msg'))
            pg.screenshot(path=str(OUT / '09-giris-hata.png'))
            pg.keyboard.press('Escape')
            # dil: ar (RTL)
            pg.select_option('#lang', 'ar'); pg.wait_for_timeout(900)
            assert pg.evaluate("document.documentElement.dir") == 'rtl'
            pg.evaluate("document.getElementById('modules').scrollIntoView({behavior:'instant'})"); pg.wait_for_timeout(1200)
            print('rtl durum:', pg.evaluate("({scene: document.body.dataset.scene, y: scrollY, modal: document.getElementById('auth').hidden, ov: document.body.style.overflow, nav: getComputedStyle(document.querySelector('.nav')).opacity})"))
            pg.screenshot(path=str(OUT / '10-ar-rtl.png'))
            pg.select_option('#lang', 'en'); pg.wait_for_timeout(600)
            print('en başlık:', pg.title())
            # yasal sayfa
            assert pg.evaluate('document.documentElement.scrollWidth') <= 1440, 'RTL yatay taşma'
            pg.close()
            pg = ctx.new_page(); pg.goto(base + '/legal/kvkk.html?lang=tr', wait_until='load'); pg.wait_for_timeout(500)
            pg.screenshot(path=str(OUT / '11-kvkk.png'))
            # mobil 390
            m = b.new_context(viewport={'width': 390, 'height': 844}, device_scale_factor=2, is_mobile=True, has_touch=True, locale='tr-TR')
            mp = m.new_page()
            mp.on('pageerror', lambda e: hatalar.append('MOBİL SAYFA: ' + str(e)[:400]))
            mp.goto(base + '/?lang=tr', wait_until='networkidle'); mp.wait_for_timeout(2500)
            mp.screenshot(path=str(OUT / '12-mobil-acilis.png'))
            mp.evaluate("document.getElementById('modules').scrollIntoView({behavior:'instant'})"); mp.wait_for_timeout(1200)
            mp.screenshot(path=str(OUT / '13-mobil-moduller.png'))
            mp.evaluate("document.querySelector('.nav [data-auth=register]').click()"); mp.wait_for_timeout(700)
            assert not mp.evaluate("document.getElementById('auth').hidden"), 'mobil modal açılmadı'
            mp.screenshot(path=str(OUT / '14-mobil-kayit.png'))
            # hareket azaltma
            r = b.new_context(viewport={'width': 1200, 'height': 800}, reduced_motion='reduce', locale='tr-TR')
            rp = r.new_page(); rp.goto(base + '/?lang=tr', wait_until='networkidle'); rp.wait_for_timeout(800)
            rp.screenshot(path=str(OUT / '15-reduced-motion.png'))
            b.close()
    except Exception:
        print('hatalar (kesinti anında):', json.dumps(hatalar, ensure_ascii=False, indent=1)); raise
    finally:
        srv.terminate(); srv.wait(timeout=5)
    print('görüntüler:', sorted(p.name for p in OUT.iterdir()))
    print('hatalar:', json.dumps(hatalar, ensure_ascii=False, indent=1) if hatalar else 'yok')
    return 1 if any('SAYFA' in h for h in hatalar) else 0


if __name__ == '__main__':
    sys.exit(main())
