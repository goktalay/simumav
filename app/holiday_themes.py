"""Ülkeye göre bayram / tatil temaları — SAF modül (yalnız stdlib; HEPGO ve SIMUMAV ortak; SIMUMAV dışa aktarma manifestinde).

Veri ÇALIŞMA ZAMANINDA bağımlılık gerektirmez: `tools/holiday_themes_build.py` python-holidays ile DERLENMİŞ statik JSON üretir:
  static/data/holidays/<yıl>.json   — {"v":1,"year":Y,"countries":{"TR":[{"d":"2027-03-08","t":"ramazan","n":"Eid al-Fitr","l":{...},"h":1,"e":1,"c":"half_day"},…]}}
      d: tarih · t: tema kodu (THEMES) · n: İngilizce ad (parantez ekleri ayıklanmış) · l: {dil: yerel ad} (yalnız İngilizceden farklıysa; '_' = ülkenin kendi dili)
      h: 1 = yarım gün (arife; 13.00'ten itibaren) · e: 1 = tahmini tarih (Hicri / ay takvimi; ülkeye göre ±1 gün kayabilir) · o: 1 = ertelenmiş (observed) gün
      c: kategori (public | half_day | optional | observance | …)
  static/data/holidays/borders.json — Natural Earth 1:50m ülke sınırları (kamu malı), 0,05° nicemlenmiş; konum → ülke (country_at).
Yıllık yenileme: `docs/bayram-temalari.md`.

Tema kataloğu (20) ve eşleme kuralları `~/mt-work/raporlar/ulke-bayramlari-uret.py` ile BİREBİR: İngilizce ad küçük harfe çevrilir, anahtarlar kelime
sınırlı aranır (önünde/arkasında harf yok), İLK eşleşen tema kazanır (liste sırası = öncelik); hiçbiri tutmazsa `genel`.
Tek bilinçli sapma: Ay Yeni Yılı (cin_yeni) Yılbaşı'ndan önce denenir (MATCH_ORDER) — "Lunar New Year" Yılbaşı'na düşmesin.
"""
from __future__ import annotations

import datetime as dt
import json
import re
from functools import lru_cache
from pathlib import Path

DATA_DIR = Path(__file__).resolve().parent.parent / 'static' / 'data' / 'holidays'
YEARS = range(2026, 2031)          # derlenmiş veri aralığı (build betiği --years ile genişletilir)
UI_LANGS = ('tr', 'en', 'de', 'fr', 'es', 'ru', 'ar')

# (kod, Türkçe ad, eşleşme anahtarları (İngilizce ad, küçük harf)) — sıra = öncelik (aynı gün birden çok bayram: ilk sıradaki ana tema)
THEMES: list[tuple[str, str, list[str]]] = [
    ('kurban', 'Kurban Bayramı', ['eid al-adha', 'eid al adha', 'kurban', 'feast of sacrifice', 'tabaski', 'hari raya haji', 'bakrid', 'eid ul-adha', 'eid-ul-adha',
                                  'idul adha', 'eid el kebir', 'greater bairam', 'id al-adha', 'eid al-adha']),
    ('ramazan', 'Ramazan Bayramı', ['eid al-fitr', 'eid al fitr', 'ramazan', 'ramadan feast', 'hari raya puasa', 'hari raya aidilfitri', 'idul fitri', 'eid ul-fitr',
                                    'eid-ul-fitr', 'lesser bairam', 'korité', 'id al-fitr', 'eid el fitr', 'end of ramadan', 'ramadan bayram']),
    ('hicri', 'Hicri Yılbaşı / Mevlid / Kandiller', ['islamic new year', 'hijri new year', 'muharram', 'mawlid', 'prophet', 'milad un nabi', 'ashura', 'isra', 'miraj',
                                                    "mi'raj", 'laylat', 'arafat', 'mouloud', 'maulid', 'arafah', 'ramadan', 'shab-e-barat', 'qadr']),
    ('noel', 'Noel', ['christmas', 'nativity', 'boxing day', 'st. stephen', 'saint stephen']),
    ('paskalya', 'Paskalya', ['easter', 'good friday', 'holy saturday', 'holy thursday', 'maundy thursday', 'pascha', 'whit', 'pentecost', 'ascension',
                              'corpus christi', 'holy week']),
    ('hristiyan', 'Diğer Hristiyan günleri', ['assumption', 'all saints', 'all souls', 'epiphany', 'immaculate', 'saint', 'st. ', 'our lady', 'virgin', 'candlemas',
                                              'carnival', 'shrove', 'ash wednesday', 'annunciation', 'transfiguration', 'reformation', 'kings']),
    ('yilbasi', 'Yılbaşı', ['new year', "new year's", 'yılbaşı', 'hogmanay', 'sylvester']),
    ('cin_yeni', 'Ay Yeni Yılı (Çin/Tet/Seollal)', ['lunar new year', 'chinese new year', 'spring festival', 'tet', 'seollal', 'losar', 'tsagaan sar']),
    ('diwali', 'Diwali / Deepavali', ['diwali', 'deepavali', 'tihar', 'dipawali']),
    ('holi', 'Holi', ['holi', 'phagwah']),
    ('hindu', 'Diğer Hindu/Budist/Sih günleri', ['vesak', 'buddha', 'wesak', 'visakha', 'magha', 'asalha', 'navaratri', 'dussehra', 'durga', 'ganesh', 'janmashtami',
                                                'ram navami', 'mahashivratri', 'pongal', 'onam', 'vaisakhi', 'guru nanak', 'thaipusam', 'chuseok', 'mid-autumn',
                                                'dragon boat', 'qingming', 'obon', 'bon ']),
    ('yahudi', 'Yahudi bayramları', ['hanukkah', 'passover', 'pesach', 'rosh hashanah', 'yom kippur', 'sukkot', 'shavuot', 'purim', 'simchat']),
    ('cocuk_genclik', 'Çocuk / Gençlik / Öğretmen', ['children', 'youth', 'sport', 'child', 'teacher', 'students']),
    ('kadin_anne', 'Kadınlar / Anneler / Babalar / Aile günü', ['women', 'mother', 'mothers', 'father', 'family']),
    ('sevgi', 'Sevgililer günü', ['valentine']),
    ('cadilar', 'Cadılar Bayramı', ['halloween']),
    ('bagimsizlik', 'Bağımsızlık / Ulusal gün / Cumhuriyet', ['independence', 'national day', 'republic', 'liberation', 'freedom', 'unity', 'victory', 'constitution',
                                                              'statehood', 'sovereignty', 'revolution', 'restoration', 'foundation', 'proclamation', 'heroes',
                                                              'armed forces', 'flag', 'birthday of', 'king', 'queen', 'emperor', 'martyrs', 'democracy', 'national',
                                                              'commemoration', 'remembrance', 'veterans', 'memorial', 'armistice', 'emancipation', 'abolition', 'army',
                                                              'europe day', 'africa day', 'united nations', 'president', 'washington', 'founder', 'hero', 'anzac',
                                                              'thanksgiving', 'canada day', 'australia day', 'waitangi', 'bastille']),
    ('emek', 'Emek ve Dayanışma Günü', ['labour', 'labor', 'workers', 'worker', "worker's", 'may day', 'work', 'may holidays']),
    ('bahar', 'Bahar / Nevruz / Hasat', ['nowruz', 'navruz', 'newroz', 'spring', 'harvest', 'equinox', 'midsummer', 'st. john', 'solstice']),
    ('genel', 'Diğer resmi tatiller', []),
]
THEME_CODES = tuple(t[0] for t in THEMES)
THEME_TR = {t[0]: t[1] for t in THEMES}
PRIORITY = {c: i for i, c in enumerate(THEME_CODES)}
# Eşleme sırası = THEMES sırası, TEK sapma: 'cin_yeni' 'yilbasi'den ÖNCE denenir — aksi hâlde "Lunar New Year" / "Chinese New Year" adları
# 'new year' anahtarıyla Yılbaşı temasına düşüyordu (rapor betiğinde cin_yeni yalnız tet/seollal/losar ile tutuyordu). Gösterim önceliği THEMES sırasıdır.
MATCH_ORDER = [c for c in THEME_CODES if c != 'cin_yeni']
MATCH_ORDER.insert(MATCH_ORDER.index('yilbasi'), 'cin_yeni')
_KEYS = {kod: keys for kod, _ad, keys in THEMES}
_RX = [(kod, [re.compile(r'(?<![a-z])' + re.escape(k.strip()) + r'(?![a-z])') for k in _KEYS[kod]]) for kod in MATCH_ORDER]


def theme_for(name_en: str) -> str:
    """İngilizce bayram adı → tema kodu (rapor betiğiyle birebir kural)."""
    a = (name_en or '').lower()
    for kod, rxs in _RX:
        if any(r.search(a) for r in rxs):
            return kod
    return 'genel'


# --------------------------------------------------------------------------- ad temizleme (build betiği de kullanır)
_PAREN = re.compile(r'\s*\(([^()]*)\)\s*$')


def clean_name(name: str) -> tuple[str, dict]:
    """'Eid al-Fitr (from 1pm)' → ('Eid al-Fitr', {'h':1}); '(estimated)' → e; '(observed)' → o. Sondaki tüm parantez ekleri ve '*' ayıklanır."""
    s, flags = (name or '').strip(), {}
    while True:
        s = s.rstrip(' *').strip()
        m = _PAREN.search(s)
        if not m:
            break
        ic = m.group(1).lower()
        if 'from 1pm' in ic or 'from 13' in ic or 'half' in ic or 'afternoon' in ic:
            flags['h'] = 1
        if 'estimated' in ic or 'tahmini' in ic:
            flags['e'] = 1
        if 'observed' in ic or 'substitute' in ic:
            flags['o'] = 1
        s = s[:m.start()]
    return s.strip(), flags


# --------------------------------------------------------------------------- veri
@lru_cache(maxsize=8)
def _year_file(year: int) -> dict:
    p = DATA_DIR / f'{int(year)}.json'
    try:
        return json.loads(p.read_text(encoding='utf-8'))
    except (OSError, ValueError):
        return {}


def year_data(year: int) -> dict:
    """Derlenmiş yıl verisi (ülke → kayıtlar); dosya yoksa boş sözlük."""
    return _year_file(int(year)).get('countries', {})


def local_lang(country: str, year: int | None = None) -> str:
    """Ülkenin kendi dili (ör. TR → 'tr'); kayıtlardaki '_' adı bu dildedir."""
    return _year_file(int(year or dt.date.today().year)).get('local_lang', {}).get(country, '') or next(
        (f.get('local_lang', {}).get(country, '') for y in YEARS if (f := _year_file(y))), '')


def countries() -> list[str]:
    """Verisi olan ülke kodları (en yakın yılın dosyasından)."""
    for y in (dt.date.today().year, *YEARS):
        d = year_data(y)
        if d:
            return sorted(d)
    return []


def norm_country(code) -> str | None:
    c = str(code or '').strip().upper()
    return c if re.fullmatch(r'[A-Z]{2}', c) else None


@lru_cache(maxsize=4096)
def _by_date(country: str, iso: str) -> tuple:
    rows = year_data(int(iso[:4])).get(country, ())
    return tuple(r for r in rows if r.get('d') == iso)


def holidays_on(country: str, day: dt.date) -> list[dict]:
    """O gün o ülkedeki bayram kayıtları (öncelik sırasına göre)."""
    c = norm_country(country)
    if not c:
        return []
    return sorted(_by_date(c, day.isoformat()), key=lambda r: PRIORITY.get(r.get('t'), 99))


def _themes_on(country: str, day: dt.date) -> set:
    return {r.get('t') for r in holidays_on(country, day)}


def run_of(country: str, day: dt.date, theme: str) -> tuple[int, int]:
    """Aynı temanın ardışık günleri (ör. Kurban 15–19 Mayıs): (bugün kaçıncı gün, toplam gün). En çok 10 gün geri/ileri bakılır."""
    i = 0
    while i < 10 and theme in _themes_on(country, day - dt.timedelta(days=i + 1)):
        i += 1
    j = 0
    while j < 10 and theme in _themes_on(country, day + dt.timedelta(days=j + 1)):
        j += 1
    return i + 1, i + j + 1


def _name(r: dict, lang: str | None, country: str = '') -> str:
    loc = r.get('l') or {}
    if lang and lang in loc:
        return loc[lang]
    if lang and '_' in loc and lang == local_lang(country, int(r['d'][:4])):
        return loc['_']
    return r.get('n', '')


def _item(country: str, day: dt.date, r: dict, lang: str | None) -> dict:
    di, dn = run_of(country, day, r['t'])
    loc = r.get('l') or {}
    out = {'theme': r['t'], 'theme_tr': THEME_TR.get(r['t'], ''), 'name': _name(r, lang, country), 'name_en': r.get('n', ''), 'name_local': loc.get('_', r.get('n', '')),
           'country': country, 'date': day.isoformat(), 'day_index': di, 'days_total': dn, 'category': r.get('c', 'public')}
    if r.get('h'):
        out['half_day'] = True          # arife: 13.00'ten itibaren
    if r.get('e'):
        out['estimated'] = True         # Hicri / ay takvimi tahmini (±1 gün)
    if r.get('o'):
        out['observed'] = True
    return out


def day_info(country, date=None, lang: str | None = None, horizon: int = 120) -> dict:
    """Uç nokta gövdesi: {'country','date','active':[…], 'next':{…}|None}. Aynı tema birden çok kayıtla gelirse (ör. Noel arifesi + Noel) tek öğe."""
    c = norm_country(country)
    day = date if isinstance(date, dt.date) else (dt.date.fromisoformat(str(date)) if date else dt.date.today())
    lang = lang if lang in UI_LANGS else None
    out = {'country': c, 'date': day.isoformat(), 'active': [], 'next': None}
    if not c:
        return out
    seen = set()
    for r in holidays_on(c, day):
        if r['t'] in seen:
            continue
        seen.add(r['t'])
        out['active'].append(_item(c, day, r, lang))
    surup = set(seen)          # bugünkü bayramın ardışık devam günleri "sonraki" sayılmaz (Kurban 2. gün ≠ yeni bayram)
    for k in range(1, horizon + 1):
        d2 = day + dt.timedelta(days=k)
        rs = holidays_on(c, d2)
        tem = {r['t'] for r in rs}
        if surup and tem and tem <= surup:
            continue
        surup = set()
        if rs:
            yeni = [r for r in rs if r['t'] not in seen] or rs
            it = _item(c, d2, yeni[0], lang)
            it['in_days'] = k
            out['next'] = it
            break
    return out


# --------------------------------------------------------------------------- konum → ülke (Natural Earth sınırları; ters coğrafi kodlama / IP sorgusu YOK)
@lru_cache(maxsize=1)
def _borders() -> list:
    """[(kod, (minx,miny,maxx,maxy), [halka…])] — halka: [(lon,lat)…]; çok parçalı ülkeler ayrı satırlar."""
    try:
        d = json.loads((DATA_DIR / 'borders.json').read_text(encoding='utf-8'))
    except (OSError, ValueError):
        return []
    out = []
    for kod, polys in d.get('countries', {}).items():
        for poly in polys:                     # poly: [dış halka, delik…]; halka: düz liste [x0,y0,x1,y1,…] (0,05° tamsayı birimi)
            rings = [[(ring[i] * d['q'], ring[i + 1] * d['q']) for i in range(0, len(ring), 2)] for ring in poly]
            xs = [p[0] for p in rings[0]]
            ys = [p[1] for p in rings[0]]
            out.append((kod, (min(xs), min(ys), max(xs), max(ys)), rings))
    return out


def _in_ring(x: float, y: float, ring) -> bool:
    ins = False
    n = len(ring)
    j = n - 1
    for i in range(n):
        xi, yi = ring[i]
        xj, yj = ring[j]
        if (yi > y) != (yj > y) and x < (xj - xi) * (y - yi) / ((yj - yi) or 1e-12) + xi:
            ins = not ins
        j = i
    return ins


@lru_cache(maxsize=2048)
def _country_at_q(lat_q: float, lon_q: float) -> str | None:
    lat, lon = lat_q, lon_q
    best = None
    for kod, (x0, y0, x1, y1), rings in _borders():
        if not (x0 <= lon <= x1 and y0 <= lat <= y1):
            continue
        if _in_ring(lon, lat, rings[0]) and not any(_in_ring(lon, lat, h) for h in rings[1:]):
            return kod
    # Kıyı / nicemleme payı: en yakın sınır kutusu 0,3° içindeyse onu al (kıyıdaki şehirler poligon dışında kalabilir)
    for kod, (x0, y0, x1, y1), rings in _borders():
        if x0 - .3 <= lon <= x1 + .3 and y0 - .3 <= lat <= y1 + .3:
            for dx, dy in ((.15, 0), (-.15, 0), (0, .15), (0, -.15), (.3, 0), (-.3, 0), (0, .3), (0, -.3)):
                if _in_ring(lon + dx, lat + dy, rings[0]):
                    best = best or kod
    return best


def country_at(lat, lon) -> str | None:
    """Enlem/boylam → ISO 3166-1 alfa-2 (bulunamazsa None). ~0,01° yuvarlanır (önbellek)."""
    try:
        la, lo = float(lat), float(lon)
    except (TypeError, ValueError):
        return None
    if not (-90 <= la <= 90 and -180 <= lo <= 180) or (la == 0 and lo == 0):
        return None
    return _country_at_q(round(la, 2), round(lo, 2))
