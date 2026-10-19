#!/opt/hepgo/fabrika-yonetim/.venv/bin/python
"""SIMUMAV tanıtım sitesi — tarayıcı dili algılama + GA4 çerez rızası görsel/işlevsel doğrulama (Playwright headless shell).
Sunucu uvicorn SUBPROCESS olarak 8611 portunda açılır (PID ile kapatılır; arka plan süreci kalmaz). Görüntüler /tmp/simumav-lang/.
  01 locale de-DE → site Almanca (html lang=de, başlık Almanca)     02 locale ja-JP → İngilizce (desteklenmeyen dil → en)
  03 ?lang=ar → Arapça, dir=rtl                                     04 rıza bandı görünür (de)
  05 Kabul → gtag.js isteği (googletagmanager; ağ yoksa deneme yeter) + localStorage granted; yenilemede bant yok, gtag yine yüklenir
  06 Reddet → googletagmanager isteği YOK, bant kapanır; yasal sayfa "Çerez tercihlerini değiştir" → ayarlar bandı
  07 Dil seçici fr → localStorage; yeni sayfa de-DE tarayıcıda Fransızca kalır   08 oyun kabuğu (/app, dev login) aynı bant + page_view
Çalıştırma: ./.venv/bin/python tests/simumav_lang_shots.py"""
import os
import pathlib
import shutil
import socket
import subprocess
import sys
import time

os.environ.setdefault('LD_LIBRARY_PATH', '/home/gelistirici/build/chromelibs/root/usr/lib/x86_64-linux-gnu')
from playwright.sync_api import sync_playwright  # noqa: E402

ROOT = pathlib.Path(__file__).resolve().parents[1]
PORT = int(os.environ.get('SHOT_PORT') or 8611)
BASE = f'http://127.0.0.1:{PORT}'
DATA = '/tmp/simumav-lang-data'
OUT = pathlib.Path('/tmp/simumav-lang'); shutil.rmtree(OUT, ignore_errors=True); OUT.mkdir(parents=True)
EXE = os.path.expanduser('~/.cache/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell')
GA = 'G-8946D4RPGK'

shutil.rmtree(DATA, ignore_errors=True); os.makedirs(DATA)
env = dict(os.environ, SIMUMAV_DATA_DIR=DATA, SIMUMAV_DEV_LOGIN='1', SIMUMAV_GA_ID=GA, HEPGO_SITL='0', SIMUMAV_SECURE_COOKIE='0',
           SIMUMAV_ENV_FILE=os.path.join(DATA, 'yok.env'), SIMUMAV_MT_INTERNAL='http://127.0.0.1:1', GOOGLE_MAPS_API_KEY='',
           SIMUMAV_UDP_BASE='24990', SIMUMAV_MP_PORT_BASE='25900', SIMUMAV_MP_PORT_COUNT='20', SIMUMAV_ALLOWED_ORIGINS=BASE)
srv = subprocess.Popen([sys.executable, '-m', 'uvicorn', 'app.simumav.main:app', '--host', '127.0.0.1', '--port', str(PORT), '--log-level', 'error'], cwd=ROOT, env=env)
hatalar, sonuc = [], {}
try:
    for _ in range(160):
        try:
            socket.create_connection(('127.0.0.1', PORT), 0.3).close(); break
        except OSError:
            time.sleep(0.25)
    else:
        sys.exit('sunucu açılmadı')

    def kontrol(ad, kosul, bilgi=''):
        sonuc[ad] = bool(kosul)
        if not kosul:
            hatalar.append(f'{ad} {bilgi}'.strip())
        print(('ok  ' if kosul else 'HATA'), ad, bilgi if not kosul else '')

    with sync_playwright() as p:
        b = p.chromium.launch(executable_path=EXE)

        def sayfa(locale, url, ad, gtag_rota=True):
            """Yeni bağlam (temiz localStorage) + sayfa; googletagmanager istekleri sayılır (route ile boş betik döner: dış ağ gerekmez)."""
            ctx = b.new_context(viewport={'width': 1366, 'height': 820}, locale=locale)
            istek = []
            if gtag_rota:
                ctx.route('**/www.googletagmanager.com/**', lambda r: (istek.append(r.request.url), r.fulfill(status=200, content_type='text/javascript', body='window.__gtagFake=1;')))
            pg = ctx.new_page()
            pg.on('pageerror', lambda e: hatalar.append(f'{ad} SAYFA: {str(e)[:300]}'))
            pg.on('console', lambda m: hatalar.append(f'{ad} KONSOL: {m.text[:300]}') if m.type == 'error' and 'WebGL' not in m.text and 'favicon' not in m.text else None)
            pg.goto(url, wait_until='networkidle')
            pg.wait_for_function("() => document.documentElement.lang && document.querySelector('[data-i18n=\"hero.title\"], [data-i18n=\"legal.privacy.title\"], #view')")
            return ctx, pg, istek

        # 01 de-DE → Almanca
        ctx, pg, istek = sayfa('de-DE', f'{BASE}/', '01')
        pg.wait_for_timeout(400)
        kontrol('01 de-DE → lang=de', pg.evaluate('document.documentElement.lang') == 'de', pg.evaluate('document.documentElement.lang'))
        kontrol('01 başlık Almanca', 'Drohnen' in pg.title() or 'Simulation' in pg.title(), pg.title())
        kontrol('01 tarayıcı dili localStorage\'a YAZILMAZ', pg.evaluate("localStorage.getItem('simumav.lang')") is None)
        kontrol('01 rıza yokken gtag yok', not istek and pg.evaluate("!document.querySelector('script[data-ga]')"))
        pg.screenshot(path=str(OUT / '01-de.png'))
        # 04 rıza bandı görünür
        bar = pg.locator('#cookie-bar')
        kontrol('04 rıza bandı görünür', bar.is_visible())
        kontrol('04 bant Almanca', 'Analyse' in bar.inner_text(), bar.inner_text()[:80])
        kontrol('04 Kabul/Reddet/Ayarlar', all(bar.locator(f'[data-consent="{k}"]').count() == 1 for k in ('accept', 'reject', 'settings')))
        pg.screenshot(path=str(OUT / '04-consent-bar.png'))
        # 05 Kabul → gtag isteği
        bar.locator('[data-consent="accept"]').click()
        pg.wait_for_function('() => window.__gtagFake === 1 || document.querySelector("script[data-ga]")', timeout=10000)
        pg.wait_for_timeout(500)
        kontrol('05 Kabul → googletagmanager isteği', any('googletagmanager.com/gtag/js?id=' + GA in u for u in istek), str(istek))
        kontrol('05 localStorage granted', pg.evaluate("localStorage.getItem('simumav.consent')") == 'granted')
        kontrol('05 bant kapandı', pg.locator('#cookie-bar').count() == 0)
        dl = pg.evaluate('JSON.stringify((window.dataLayer||[]).map(a => Array.from(a)))')
        kontrol('05 consent default denied → update granted → config anonymize_ip', '"default",{"analytics_storage":"denied"' in dl and '"update",{"analytics_storage":"granted"}' in dl and '"anonymize_ip":true' in dl, dl[:400])
        pg.screenshot(path=str(OUT / '05-accepted.png'))
        n0 = len(istek); pg.reload(wait_until='networkidle'); pg.wait_for_timeout(600)
        kontrol('05 yenilemede bant yok, gtag yine yüklenir', pg.locator('#cookie-bar').count() == 0 and len(istek) > n0)
        # 07 dil seçici → fr kalıcı
        pg.select_option('#lang', 'fr'); pg.wait_for_function("() => document.documentElement.lang === 'fr'", timeout=8000)
        kontrol('07 seçici fr → localStorage', pg.evaluate("localStorage.getItem('simumav.lang')") == 'fr')
        pg2 = ctx.new_page(); pg2.goto(f'{BASE}/legal/gizlilik.html', wait_until='networkidle'); pg2.wait_for_timeout(400)
        kontrol('07 yeni sayfa (de-DE tarayıcı) Fransızca kalır', pg2.evaluate('document.documentElement.lang') == 'fr')
        kontrol('07 gizlilikte GA paragrafı + tercih bağlantısı', pg2.locator('[data-i18n="legal.privacy.p5"]').inner_text().startswith('Uniquement') and pg2.locator('[data-consent="manage"]').count() == 1)
        pg2.screenshot(path=str(OUT / '07-fr-legal.png'), full_page=True)
        ctx.close()

        # 02 ja-JP → İngilizce
        ctx, pg, istek = sayfa('ja-JP', f'{BASE}/', '02'); pg.wait_for_timeout(300)
        kontrol('02 ja-JP → lang=en', pg.evaluate('document.documentElement.lang') == 'en', pg.evaluate('document.documentElement.lang'))
        kontrol('02 başlık İngilizce', 'Real world' in pg.title(), pg.title())
        pg.screenshot(path=str(OUT / '02-ja-en.png'))
        # 06 Reddet → istek yok
        pg.locator('#cookie-bar [data-consent="reject"]').click(); pg.wait_for_timeout(600)
        kontrol('06 Reddet → googletagmanager isteği YOK', not istek and pg.evaluate("!document.querySelector('script[data-ga]')"), str(istek))
        kontrol('06 localStorage denied, bant kapandı', pg.evaluate("localStorage.getItem('simumav.consent')") == 'denied' and pg.locator('#cookie-bar').count() == 0)
        pg.reload(wait_until='networkidle'); pg.wait_for_timeout(500)
        kontrol('06 yenilemede bant yok ve gtag yok', pg.locator('#cookie-bar').count() == 0 and not istek)
        pg.goto(f'{BASE}/legal/kvkk.html', wait_until='networkidle'); pg.wait_for_timeout(300)
        pg.locator('[data-consent="manage"]').click(); pg.wait_for_timeout(500)
        kontrol('06 "Çerez tercihlerini değiştir" → ayarlar bandı (onay kutuları)', pg.locator('#cookie-bar .ck-opts').is_visible() and pg.locator('#ck-an').is_checked() is False)
        pg.screenshot(path=str(OUT / '06-manage.png'))
        pg.locator('#ck-an').check(); pg.locator('#cookie-bar [data-consent="accept"]').click(); pg.wait_for_timeout(800)
        kontrol('06 ayarlardan analitik açılınca gtag yüklenir', pg.evaluate("localStorage.getItem('simumav.consent')") == 'granted' and any('googletagmanager' in u for u in istek))
        ctx.close()

        # 03 ?lang=ar → RTL (tarayıcı de-DE olsa da)
        ctx, pg, istek = sayfa('de-DE', f'{BASE}/?lang=ar', '03'); pg.wait_for_timeout(300)
        kontrol('03 ?lang=ar → lang=ar dir=rtl', pg.evaluate('document.documentElement.lang') == 'ar' and pg.evaluate('document.documentElement.dir') == 'rtl')
        kontrol('03 ?lang kaydedilir (bağlantıdan gelen ziyaretçi dili korur)', pg.evaluate("localStorage.getItem('simumav.lang')") == 'ar')
        kontrol('03 hreflang etiketleri', pg.evaluate("document.querySelectorAll('link[rel=alternate][hreflang]').length") == 8)
        pg.screenshot(path=str(OUT / '03-ar-rtl.png'))
        ctx.close()

        # 08 oyun kabuğu: dev login → /app aynı bant; page_view hash rotası
        import requests
        s = requests.Session(); r = s.post(f'{BASE}/api/session', json={'dev_user': 'ali'}, headers={'Origin': BASE}); assert r.status_code == 200, r.text
        ctx = b.new_context(viewport={'width': 1366, 'height': 820}, locale='es-ES')
        istek = []
        ctx.route('**/www.googletagmanager.com/**', lambda rq: (istek.append(rq.request.url), rq.fulfill(status=200, content_type='text/javascript', body='window.__gtagFake=1;')))
        ctx.add_cookies([{'name': 'smsid', 'value': s.cookies['smsid'], 'url': BASE}])
        pg = ctx.new_page()
        pg.on('pageerror', lambda e: hatalar.append(f'08 SAYFA: {str(e)[:300]}'))
        pg.goto(f'{BASE}/app/#/menu', wait_until='networkidle')
        pg.wait_for_selector('#cookie-bar', timeout=15000); pg.wait_for_timeout(600)
        kontrol('08 kabuk: tarayıcı es-ES → lang=es (hesap ayarı yok)', pg.evaluate('document.documentElement.lang') == 'es', pg.evaluate('document.documentElement.lang'))
        kontrol('08 kabuk: rıza bandı İspanyolca', 'anal' in pg.locator('#cookie-bar b').inner_text().lower(), pg.locator('#cookie-bar b').inner_text())
        pg.screenshot(path=str(OUT / '08-app-consent.png'))
        pg.locator('#cookie-bar [data-consent="accept"]').click(); pg.wait_for_timeout(800)
        pg.evaluate("location.hash = '#/settings'"); pg.wait_for_timeout(1200)
        dl = pg.evaluate('JSON.stringify((window.dataLayer||[]).map(a => Array.from(a)))')
        kontrol('08 kabuk: gtag yüklendi, send_page_view:false + page_view page_path=/app/#/settings', any('googletagmanager' in u for u in istek) and '"send_page_view":false' in dl and '"page_path":"/app/#/settings"' in dl, dl[:600])
        pg.screenshot(path=str(OUT / '08-app-settings.png'))
        ctx.close()
        b.close()
finally:
    srv.terminate()
    try:
        srv.wait(10)
    except subprocess.TimeoutExpired:
        srv.kill()

print('\nGörüntüler:', *sorted(str(p) for p in OUT.glob('*.png')), sep='\n  ')
if hatalar:
    print('\nHATALAR:'); [print(' -', h) for h in hatalar]
    sys.exit(1)
print(f'\n{sum(sonuc.values())}/{len(sonuc)} kontrol geçti')
