"""`/api/meta` — oturumsuz da 200 (yayın doğrulaması §6); Google anahtarı YALNIZ oturumlu kullanıcıya (§7)."""
from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from .. import auth, bridge, config, db

router = APIRouter(prefix='/api/meta')


@router.get('')
def meta(request: Request):
    tok = request.cookies.get(auth.COOKIE)
    u = None
    if tok:
        with db.connect() as conn:
            u = auth.kullanici_cozumle(conn, tok, dokun=False)
    out = {'version': config.VERSION, 'mt_url': config.MT_URL, 'mt_app': config.MT_APP, 'lang_list': list(config.LANGS), 'dev_login': config.DEV_LOGIN,
           'ga_id': config.GA_ID or None, 'ads_id': config.ADS_ID or None,   # GA4 ölçüm kimliği (SIMUMAV_GA_ID); None → analytics.js gtag yüklemez, rıza bandı çıkmaz
           'limits': {'max_flights': config.MAX_FLIGHTS, 'flight_minutes': config.FLIGHT_MINUTES, **config.QUOTA},
           'sitl': config.SITL_ENABLED, 'google3d': bool(config.GOOGLE_KEY), 'types': list(bridge.TYPES), 'launches': list(bridge.LAUNCHES),
           'mission_kinds': list(bridge.KINDS), 'weather': list(bridge.WEATHER), 'time_of_day': list(bridge.TIME_OF_DAY), 'world_modes': list(bridge.WORLD_MODES),
           'mp': {'proto': 'tcp', 'port_range': [config.MP_PORT_BASE, config.MP_PORT_BASE + config.MP_PORT_COUNT - 1], 'host': bridge.host_adi(request)},
           'active_flights': bridge.aktif_sayisi(), 'authenticated': u is not None,
           'maps_key': config.GOOGLE_KEY if u is not None else None}
    return JSONResponse(out, headers={'Cache-Control': 'no-store'})
