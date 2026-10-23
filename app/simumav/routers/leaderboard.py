"""`/api/leaderboard` — TOP 10 PİLOT (docs/simumav.md §25.3). Herkese açık (oturumsuz); YALNIZ maskeli veri döner (avatar.siralama: ad/e-posta
maskesi sunucuda, kullanıcı kimliği yok). Dönem başına 5 dk bellek önbelleği (gizlilik ayarı değişince `gecersiz()` ile hemen düşer); IP başına
dakikada 30 istek (aşımda 429)."""
import os
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


# Örnek (demo) pilotlar: gerçek puan henüz yokken tablo boş görünmesin diye (kullanıcı isteği, 2026-10-23). Kurgusal Türk adları ve
# e-postalar; yanıtta `demo: true` (arayüzde "örnek" etiketi). Her gerçek pilot listeye girince en düşük puanlı örnek düşer → gerçek kayıtlar
# çoğaldıkça örnekler birer birer kaybolur; 10 gerçek pilot olunca hiç kalmaz. SIMUMAV_LB_DEMO=0 ile tamamen kapanır.
DEMO = (('Mert Yıldırım', 'mert.yildirim@gmail.com', 'p03', 2480, 6), ('Elif Kaya', 'elifkaya@hotmail.com', 'p02', 2215, 5),
        ('Burak Demir', 'burakdemir@outlook.com', 'p05', 1990, 5), ('Zeynep Arslan', 'zeynep.arslan@gmail.com', 'p08', 1760, 4),
        ('Emre Çelik', 'emrecelik@yandex.com', 'p01', 1545, 4), ('Selin Öztürk', 'selinozturk@gmail.com', 'p06', 1320, 3),
        ('Can Şahin', 'can.sahin@icloud.com', 'p04', 1105, 3), ('Ayşe Koç', 'aysekoc@hotmail.com', 'p09', 930, 2),
        ('Oğuz Aydın', 'oguzaydin@gmail.com', 'p07', 760, 2), ('Deniz Güneş', 'deniz.gunes@outlook.com', 'p10', 585, 1))


def _demo_satirlari(period):
    k = 1.0 if period == '30d' else 2.6   # tüm zamanlar: daha yüksek birikim
    out = []
    for ad, eposta, ch, puan, gal in DEMO:
        sc = int(round(puan * k))
        out.append({'name': avatar.maske_ad(ad), 'email': avatar.maske_eposta(eposta), 'avatar': avatar.legacy(ch), 'score': sc,
                    'wins': int(round(gal * k)), 'matches': int(round(gal * k * 1.8)), 'flights': int(round(gal * k * 3)), 'parts': None, 'demo': True})
    return out


def doldur(rows, period, limit=10):
    """Gerçek satırlar + (limit − gerçek) adet en yüksek puanlı örnek; puana göre sıralanır, rank yeniden verilir."""
    if os.environ.get('SIMUMAV_LB_DEMO', '1') == '0':
        return rows
    eksik = max(0, limit - len(rows))
    hepsi = list(rows) + _demo_satirlari(period)[:eksik]
    hepsi.sort(key=lambda r: (r['score'], not r.get('demo')), reverse=True)
    for i, r in enumerate(hepsi):
        r['rank'] = i + 1
    return hepsi


def hesapla(period):
    t = time.time()
    with _KILIT:
        c = _CACHE.get(period)
        if c and t - c['t'] < TTL_S:
            return c['body']
    with db.connect() as conn:
        rows = doldur(avatar.siralama(conn, period), period)
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
