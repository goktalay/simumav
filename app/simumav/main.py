"""SIMUMAV ASGI uygulaması (docs/simumav.md §1–§2, §7 başlıklar/CSP).

Yollar: `/api/*` router'lar; `/ws/fly/{sim_id}` (+ HEPGO `/ws/drone/sim/{id}`, `/ws/drone/live`); statik:
  `/`            → static/simumav/site (tanıtım; index.html)      `/app` → static/simumav/app (oyun kabuğu; index.html)
  `/brand`       → static/simumav/brand                            `/vendor`, `/static/vendor` → static/vendor (three.js, xterm …)
  `/static/models` → static/models (dahili GLB)                    `/sim` → static/js/modules (HEPGO simülatör ön yüz modülleri)
  `/sim/api.js`, `/api.js` → static/simumav/app/simapi.js          `/<ad>.js` (ui.js, i18n.js, icons.js, …) → static/js/<ad>.js (modüllerin ../ içe aktarımları)
Güvenlik başlıkları her yanıtta; CSP inline script'siz; hata yanıtları iç ayrıntı sızdırmaz (500 → genel mesaj, ayrıntı günlüğe).
"""
import logging
import re
import traceback
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import FileResponse, JSONResponse, RedirectResponse, Response
from fastapi.staticfiles import StaticFiles

from . import config  # noqa: F401 — ilk: çekirdek yollarını yönlendirir
from . import bridge, db
from .routers import crew, fly, hangar, meta, missions, ops, session, settings, tracks

log = logging.getLogger('simumav')
# CSP (§7): inline script yok; 'unsafe-eval' ZORUNLU: Cesium 1.145 CDN paketi (replay3d.js / görev harita katmanı) içindeki Knockout `(0,eval)("this")`
# yüklemede eval ister, aksi hâlde Cesium hiç açılmaz (HEPGO app.main CSP'si ile aynı); 'wasm-unsafe-eval': 3DTilesRenderer/draco WebAssembly. Google Maps JS + 3B karolar (googleapis/gstatic/ggpht), Cesium (replay3d.js cdn.jsdelivr.net v1.145 sabit + ion/arcgis),
# arazi/uydu (arcgisonline, amazonaws terrarium), hesap servisi (mastertool.download), kendi WS'si.
CSP = ("default-src 'self'; "
       "script-src 'self' 'unsafe-eval' 'wasm-unsafe-eval' https://static.cloudflareinsights.com https://maps.googleapis.com https://maps.gstatic.com https://cdn.jsdelivr.net https://*.cesium.com; "
       "style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; "
       "connect-src 'self' https://mastertool.download https://maps.googleapis.com https://*.googleapis.com https://*.gstatic.com https://*.ggpht.com "
       "https://tile.googleapis.com https://cdn.jsdelivr.net https://*.cesium.com https://*.arcgisonline.com https://*.amazonaws.com "
       "wss://simumav.com wss://www.simumav.com ws://127.0.0.1:8600 ws://localhost:8600; "
       "img-src 'self' data: blob: https:; media-src 'self' blob: data:; font-src 'self' data:; worker-src 'self' blob: https://cdn.jsdelivr.net; "
       "child-src 'self' blob:; frame-ancestors 'none'; object-src 'none'; base-uri 'self'; form-action 'self'")
HEADERS = {'Content-Security-Policy': CSP, 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'strict-origin-when-cross-origin',
           'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), fullscreen=(self), gamepad=(self), display-capture=(self)',
           'X-Frame-Options': 'DENY', 'Cross-Origin-Opener-Policy': 'same-origin'}
JS_KOK = re.compile(r'^(i18n|icons|segicons|fa-icons|imgopt|step3d|gcode3d|engine3d)\.js$')   # ui.js → fly/simui.js (ayrı route)


@asynccontextmanager
async def lifespan(app):
    db.init()
    bridge.cekirdek_baslat()
    log.info('SIMUMAV %s · veri %s · SITL %s · dev login %s', config.VERSION, config.DATA_DIR, 'açık' if config.SITL_ENABLED else 'SAHTE', config.DEV_LOGIN)
    yield
    await bridge.hepsini_kapat()


app = FastAPI(title='SIMUMAV', docs_url=None, redoc_url=None, openapi_url=None, lifespan=lifespan)


@app.middleware('http')
async def _guvenlik(request: Request, call_next):
    resp = await call_next(request)
    for k, v in HEADERS.items():
        resp.headers.setdefault(k, v)
    if request.url.path.startswith('/api/'):
        resp.headers.setdefault('Cache-Control', 'no-store')
    return resp


@app.exception_handler(HTTPException)
async def _http(request, e: HTTPException):
    d = e.detail if isinstance(e.detail, dict) and 'error' in e.detail else {'error': 'error' if e.status_code < 500 else 'server_error', 'message': str(e.detail or 'Hata')}
    return JSONResponse({'detail': d}, status_code=e.status_code, headers=dict(e.headers or {}))


@app.exception_handler(RequestValidationError)
async def _val(request, e):
    alanlar = sorted({str(x['loc'][-1]) for x in e.errors() if x.get('loc')})[:10]
    return JSONResponse({'detail': {'error': 'invalid', 'message': 'Eksik ya da hatalı alan: ' + ', '.join(alanlar) if alanlar else 'İstek gövdesi geçersiz', 'fields': alanlar}},
                        status_code=422)


@app.exception_handler(Exception)
async def _genel(request, e):
    log.error('İç hata %s %s: %s', request.method, request.url.path, ''.join(traceback.format_exception(e))[-2000:])
    return JSONResponse({'detail': {'error': 'server_error', 'message': 'Sunucu hatası; lütfen tekrar deneyin'}}, status_code=500, headers=HEADERS)


for r in (session.router, settings.router, hangar.router, crew.router, tracks.router, missions.router, fly.router, fly.compat, ops.router, meta.router, fly.ws_router):
    app.include_router(r)


def _js(path):
    return FileResponse(path, media_type='text/javascript; charset=utf-8', headers={'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff'})


@app.get('/sim/api.js')
@app.get('/static/js/api.js')
@app.get('/api.js')
def simapi():
    """HEPGO modüllerinin `../api.js` / `./api.js` içe aktarımı → SIMUMAV API sarmalayıcısı."""
    return _js(config.SM_STATIC / 'app' / 'simapi.js')


@app.get('/sim/ui.js')
@app.get('/ui.js')
def simui():
    """HEPGO modüllerinin `../ui.js` içe aktarımı → ince SIMUMAV ui (fly/simui.js; HEPGO ui.js kabuğa bağlıdır)."""
    return _js(config.SM_STATIC / 'app' / 'fly' / 'simui.js')


@app.get('/static/img/google-logo.png')
def google_logo():
    """flightsim_g3d.js G3D_LOGO sabiti (Google 3B atıf logosu) — HEPGO static'teki aynı dosya."""
    p = config.STATIC_DIR / 'img' / 'google-logo.png'
    if not p.is_file():
        return JSONResponse({'detail': {'error': 'not_found', 'message': 'Bulunamadı'}}, status_code=404)
    return FileResponse(p, media_type='image/png', headers={'Cache-Control': 'public, max-age=86400'})


@app.get('/{name}.js')
def kok_js(name: str):
    """Modüllerin kök seviye bağımlılıkları (ui.js, i18n.js, step3d.js …) — yalnız beyaz liste."""
    f = f'{name}.js'
    p = config.STATIC_DIR / 'js' / f
    if JS_KOK.match(f) and p.is_file():
        return _js(p)
    site = config.SM_STATIC / 'site' / f   # tanıtım sitesinin kök betikleri (/site.js …) — mount'tan önce bu route yakalar
    if re.fullmatch(r'[a-z0-9_-]+\.js', f) and site.is_file():
        return _js(site)
    return JSONResponse({'detail': {'error': 'not_found', 'message': 'Bulunamadı'}}, status_code=404)


@app.get('/app')
def app_kabuk():
    """`/app` (eğik çizgisiz; tanıtım sitesi girişten sonra buraya yönlendirir) → `/app/` (StaticFiles html=True index.html)."""
    return RedirectResponse('/app/', status_code=307)


@app.get('/healthz')
def healthz():
    return {'ok': True, 'version': config.VERSION}


def _mount(path, directory, html=False):
    directory.mkdir(parents=True, exist_ok=True)
    app.mount(path, StaticFiles(directory=str(directory), html=html), name=path.strip('/') or 'site')


_mount('/static/vendor', config.STATIC_DIR / 'vendor')
_mount('/static/models', config.STATIC_DIR / 'models')
_mount('/vendor', config.STATIC_DIR / 'vendor')
_mount('/sim', config.STATIC_DIR / 'js' / 'modules')
_mount('/brand', config.SM_STATIC / 'brand')
_mount('/app', config.SM_STATIC / 'app', html=True)
_mount('/', config.SM_STATIC / 'site', html=True)


@app.head('/')
def head_root():
    return Response(status_code=200)
