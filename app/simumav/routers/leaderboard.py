"""`/api/leaderboard` — TOP 10 PİLOT (docs/simumav.md §25.3). Herkese açık (oturumsuz); YALNIZ maskeli veri döner (avatar.siralama: ad/e-posta
maskesi sunucuda, kullanıcı kimliği yok). Dönem başına 5 dk bellek önbelleği (gizlilik ayarı değişince `gecersiz()` ile hemen düşer); IP başına
dakikada 30 istek (aşımda 429)."""
import threading
import time

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from .. import auth, avatar, db

router = APIRouter(prefix='/api/leaderboard')
TTL_S = 300
_CACHE = {}
_KILIT = threading.Lock()


def gecersiz():
    with _KILIT:
        _CACHE.clear()


def hesapla(period):
    t = time.time()
    with _KILIT:
        c = _CACHE.get(period)
        if c and t - c['t'] < TTL_S:
            return c['body']
    with db.connect() as conn:
        rows = avatar.siralama(conn, period)
    body = {'period': period, 'generated_at': db.now(), 'ttl_s': TTL_S, 'formula': 'v1', 'pilots': rows}
    with _KILIT:
        _CACHE[period] = {'t': t, 'body': body}
    return body


@router.get('')
def leaderboard(request: Request, period: str = '30d'):
    auth.oran('leaderboard', 30, 60, request=request)
    if period not in avatar.PERIODS:
        raise auth.hata(422, 'invalid', 'period 30d | all olmalı')
    return JSONResponse(hesapla(period), headers={'Cache-Control': f'public, max-age={TTL_S}'})
