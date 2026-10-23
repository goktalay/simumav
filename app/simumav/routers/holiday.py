"""SIMUMAV bayram temaları (docs/bayram-temalari.md) — veri ve kurallar HEPGO ile ortak `app/holiday_themes.py` (saf modül, dışa aktarmada kopyalanır).

GET /api/holiday-theme?country=TR&date=YYYY-MM-DD&lang=tr   oturumsuz (tanıtım sitesi de kullanır); o gün etkin temalar + sıradaki bayram
GET /api/holiday-theme/me                                    oturumlu; ayar (settings.holiday_fx / holiday_country) + KULLANICININ GİRDİĞİ konumdan ülke:
                                                             en son düzenlenen kendi parkurunun merkezi (varsayılan TRTEST hariç). IP'den konum sorgusu YOK.
"""
import datetime as dt

from fastapi import APIRouter, Query
from fastapi.responses import JSONResponse

from ... import holiday_themes
from .. import auth, db
from .common import User

router = APIRouter(prefix='/api/holiday-theme')


@router.get('')
def holiday_theme(country: str = Query(..., max_length=2), date: str | None = Query(None, max_length=10), lang: str | None = Query(None, max_length=5)):
    c = holiday_themes.norm_country(country)
    if not c:
        raise auth.hata(422, 'invalid', 'country ISO 3166-1 alfa-2 olmalı (ör. TR)')
    try:
        d = dt.date.fromisoformat(date[:10]) if date else dt.date.today()
    except ValueError:
        raise auth.hata(422, 'invalid', 'date YYYY-MM-DD olmalı')
    if abs((d - dt.date.today()).days) > 3700:
        raise auth.hata(422, 'invalid', 'Tarih aralık dışında')
    return JSONResponse(holiday_themes.day_info(c, d, lang), headers={'Cache-Control': 'public, max-age=3600'})


def parkurdan_ulke(conn, user_id: int):
    """Kullanıcının kendi parkurlarından (en son güncellenen; varsayılan TRTEST hariç) merkez → ülke."""
    for la, lo in conn.execute('SELECT lat, lon FROM tracks WHERE user_id = ? AND is_default = 0 ORDER BY updated_at DESC, id DESC LIMIT 5', (user_id,)):
        c = holiday_themes.country_at(la, lo)
        if c:
            return c
    return None


@router.get('/me')
def holiday_me(user=User):
    s = db.j(user.get('settings'))
    with db.connect() as conn:
        located = parkurdan_ulke(conn, user['id'])
    return {'enabled': s.get('holiday_fx', True) is not False, 'country': holiday_themes.norm_country(s.get('holiday_country')), 'located': located,
            'located_source': 'track' if located else None, 'countries': holiday_themes.countries(), 'themes': list(holiday_themes.THEME_CODES)}
