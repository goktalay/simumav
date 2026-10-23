"""Bayram temaları (docs/bayram-temalari.md) — saf modül app/holiday_themes.py + derlenmiş veri + SIMUMAV uç noktaları/ayarları.

  * tema kataloğu rapor betiğiyle (~/mt-work/raporlar/ulke-bayramlari-uret.py) BİREBİR (varsa AST ile karşılaştırılır), eşleme kuralı örnekleri
  * derlenmiş veri: 2026–2030 dosyaları, tema kodları geçerli, TR 2027 listesi kullanıcı tablosuyla birebir (arife = yarım gün)
  * TR 2027-05-19: Kurban 5/5 + Gençlik ve Spor birleşik; sonraki bayram; ardışık gün sayımı; Hicri tahmini bayrağı; dil seçimi
  * konum → ülke (Natural Earth sınırları; ada ülkeler, kıyı payı, okyanus → None)
  * SIMUMAV: GET /api/holiday-theme (oturumsuz, önbellek başlığı, 422), /api/holiday-theme/me (parkur merkezinden ülke; TRTEST sayılmaz),
    /api/settings holiday_fx / holiday_country gidiş-dönüş + doğrulama
Çalıştırma: ./.venv/bin/python -m tests.test_simumav_holiday
"""
import ast
import datetime as dt
import json
import os
import pathlib
import sys
import tempfile

ROOT = pathlib.Path(__file__).resolve().parents[1]
D = tempfile.mkdtemp(prefix='simumav-holiday-')
os.environ.update(SIMUMAV_DATA_DIR=D, SIMUMAV_DEV_LOGIN='1', HEPGO_SITL='0', SIMUMAV_SECURE_COOKIE='0', SIMUMAV_ENV_FILE=os.path.join(D, 'yok.env'),
                  SIMUMAV_MT_INTERNAL='http://127.0.0.1:1', GOOGLE_MAPS_API_KEY='', SIMUMAV_MP_PORT_BASE='25700', SIMUMAV_UDP_BASE='24850')
for k in [k for k in sys.modules if k == 'app' or k.startswith('app.')]:
    del sys.modules[k]

from app import holiday_themes as HT  # noqa: E402

ORIGIN = 'http://127.0.0.1:8600'
H = {'Origin': ORIGIN}
RAPOR = pathlib.Path.home() / 'mt-work' / 'raporlar' / 'ulke-bayramlari-uret.py'


def katalog():
    assert len(HT.THEMES) == 20 and len(set(HT.THEME_CODES)) == 20
    assert HT.THEME_CODES[0] == 'kurban' and HT.THEME_CODES[-1] == 'genel'
    if RAPOR.is_file():   # rapor betiğindeki TEMALAR ile birebir (kod, anahtarlar, sıra)
        tree = ast.parse(RAPOR.read_text(encoding='utf-8'))
        lit = next(ast.literal_eval(n.value) for n in ast.walk(tree) if isinstance(n, ast.Assign) and getattr(n.targets[0], 'id', '') == 'TEMALAR')
        assert [t[0] for t in lit] == list(HT.THEME_CODES)
        for (kod, _ad, _g, keys, _tur), (kod2, _ad2, keys2) in zip(lit, HT.THEMES):
            assert keys == keys2, kod
        print('  rapor betiği TEMALAR ile birebir')
    ornek = {"Eid al-Adha": 'kurban', 'Eid al-Fitr (estimated)': 'ramazan', 'Day of Arafah': 'hicri', 'Christmas Day': 'noel', 'Easter Monday': 'paskalya',
             'Assumption Day': 'hristiyan', "New Year's Day": 'yilbasi', 'Lunar New Year': 'cin_yeni', 'Deepavali': 'diwali', 'Holi': 'holi', 'Vesak Day': 'hindu',
             'Yom Kippur': 'yahudi', "National Sovereignty and Children's Day": 'cocuk_genclik', "Mother's Day": 'kadin_anne', "Valentine's Day": 'sevgi',
             'Halloween': 'cadilar', 'Victory Day': 'bagimsizlik', 'Labour and Solidarity Day': 'emek', 'Nowruz': 'bahar', 'Bank Holiday': 'genel',
             'Tet holiday': 'cin_yeni', 'Pentecost': 'paskalya', 'Workers Day': 'emek', 'Teton day': 'genel'}   # kelime sınırı: 'tet' 'Teton' içinde eşleşmez
    for ad, kod in ornek.items():
        assert HT.theme_for(ad) == kod, (ad, HT.theme_for(ad), kod)
    assert HT.clean_name('Eid al-Fitr (from 1pm)') == ('Eid al-Fitr', {'h': 1})
    assert HT.clean_name('Eid al-Adha (estimated)') == ('Eid al-Adha', {'e': 1})
    assert HT.clean_name("Christmas Day (observed)") == ('Christmas Day', {'o': 1})
    print('  katalog + eşleme kuralı tamam')


def veri():
    for y in range(2026, 2031):
        p = HT.DATA_DIR / f'{y}.json'
        assert p.is_file(), p
        d = json.loads(p.read_text(encoding='utf-8'))
        assert d['year'] == y and len(d['countries']) >= 200, (y, len(d['countries']))
        for c, rows in d['countries'].items():
            assert len(c) == 2 and c.isupper()
            for r in rows:
                assert r['t'] in HT.THEME_CODES and r['d'].startswith(str(y)) and r['n'], (c, r)
        print(f'  {y}.json: {len(d["countries"])} ülke, {p.stat().st_size // 1024} KB')
    assert (HT.DATA_DIR / 'borders.json').stat().st_size < 600_000
    # TR 2027 — kullanıcı tablosuyla birebir
    tr = HT.year_data(2027)['TR']
    beklenen = [('2027-01-01', 'yilbasi'), ('2027-03-08', 'ramazan'), ('2027-03-09', 'ramazan'), ('2027-03-10', 'ramazan'), ('2027-03-11', 'ramazan'),
                ('2027-04-23', 'cocuk_genclik'), ('2027-05-01', 'emek'), ('2027-05-15', 'kurban'), ('2027-05-16', 'kurban'), ('2027-05-17', 'kurban'),
                ('2027-05-18', 'kurban'), ('2027-05-19', 'cocuk_genclik'), ('2027-05-19', 'kurban'), ('2027-07-15', 'bagimsizlik'), ('2027-08-30', 'bagimsizlik'),
                ('2027-10-28', 'bagimsizlik'), ('2027-10-29', 'bagimsizlik')]
    assert sorted((r['d'], r['t']) for r in tr) == sorted(beklenen), sorted((r['d'], r['t']) for r in tr)
    yarim = {r['d'] for r in tr if r.get('h')}
    assert yarim == {'2027-03-08', '2027-05-15', '2027-10-28'}, yarim   # arifeler 13.00'ten itibaren
    adlar = {r['d']: r.get('l', {}).get('_') for r in tr}
    assert adlar['2027-03-09'] == 'Ramazan Bayramı' and adlar['2027-08-30'] == 'Zafer Bayramı' and adlar['2027-04-23'] == 'Ulusal Egemenlik ve Çocuk Bayramı'
    print('  TR 2027 listesi kullanıcı tablosuyla birebir (1 Oca, Ramazan 8–11 Mar, 23 Nis, 1 May, Kurban 15–19 May, 19 May, 15 Tem, 30 Ağu, 28–29 Eki)')


def gun_bilgisi():
    i = HT.day_info('TR', '2027-05-19', 'tr')
    assert [a['theme'] for a in i['active']] == ['kurban', 'cocuk_genclik'], i
    k = i['active'][0]
    assert (k['day_index'], k['days_total'], k['name']) == (5, 5, 'Kurban Bayramı'), k
    assert i['active'][1]['name'] == "Atatürk'ü Anma, Gençlik ve Spor Bayramı"
    assert i['next']['date'] == '2027-07-15' and i['next']['in_days'] == 57
    i = HT.day_info('TR', '2027-05-18', 'en')   # Kurban sürerken "sonraki" = 19 Mayıs Gençlik ve Spor (yeni tema), Kurban 5. gün değil
    assert i['active'][0]['day_index'] == 4 and i['next']['theme'] == 'cocuk_genclik' and i['next']['in_days'] == 1, i
    assert i['active'][0]['name'] == 'Eid al-Adha' and i['active'][0]['name_local'] == 'Kurban Bayramı'
    i = HT.day_info('TR', '2027-03-08', 'tr')
    assert i['active'][0]['half_day'] and i['active'][0]['days_total'] == 4 and i['active'][0]['day_index'] == 1
    i = HT.day_info('TR', '2027-06-01')
    assert i['active'] == [] and i['next']['date'] == '2027-07-15'
    assert HT.day_info('XX', '2027-01-01')['active'] == [] and HT.day_info('', '2027-01-01')['country'] is None
    sa = HT.day_info('SA', '2027-03-10', 'ar')
    assert sa['active'][0]['theme'] == 'ramazan' and any('؀' <= ch <= 'ۿ' for ch in sa['active'][0]['name'])
    de = HT.day_info('DE', '2027-12-25', 'de')
    assert de['active'][0]['theme'] == 'noel' and de['active'][0]['name'] != de['active'][0]['name_en']
    us = HT.day_info('US', '2027-07-04')
    assert us['active'][0]['theme'] == 'bagimsizlik' or HT.day_info('US', '2027-07-05')['active'][0]['theme'] == 'bagimsizlik'
    # tahmini (Hicri) bayrak en az bir ülkede işaretli
    assert any(r.get('e') for rows in HT.year_data(2027).values() for r in rows)
    print('  gün bilgisi: birleşik tema, ardışık gün, sonraki bayram, yerel ad, arife')


def konum():
    ornek = {(39.93, 32.85): 'TR', (41.01, 28.98): 'TR', (40.099, 33.41): 'TR', (52.52, 13.40): 'DE', (40.71, -74.0): 'US', (1.35, 103.82): 'SG',
             (35.9, 14.5): 'MT', (26.2, 50.58): 'BH', (24.7, 46.7): 'SA', (35.68, 139.69): 'JP', (48.85, 2.35): 'FR', (-33.87, 151.21): 'AU', (36.885, 30.70): 'TR'}
    for (la, lo), c in ornek.items():
        assert HT.country_at(la, lo) == c, ((la, lo), HT.country_at(la, lo), c)
    assert HT.country_at(30, -40) is None and HT.country_at(0, 0) is None and HT.country_at('x', 1) is None and HT.country_at(95, 0) is None
    print('  konum → ülke (13 örnek, okyanus/geçersiz → None)')


def simumav():
    from fastapi.testclient import TestClient
    import app.simumav.main as smain
    with TestClient(smain.app, base_url=ORIGIN) as c:
        r = c.get('/api/holiday-theme', params={'country': 'tr', 'date': '2027-05-19', 'lang': 'tr'})
        assert r.status_code == 200 and 'max-age=3600' in r.headers.get('cache-control', ''), (r.status_code, r.headers)
        assert [a['theme'] for a in r.json()['active']] == ['kurban', 'cocuk_genclik']
        assert c.get('/api/holiday-theme', params={'country': 'TUR'}).status_code == 422
        assert c.get('/api/holiday-theme', params={'country': 'T1'}).status_code == 422
        assert c.get('/api/holiday-theme', params={'country': 'TR', 'date': '2027-13-40'}).status_code == 422
        assert c.get('/api/holiday-theme/me').status_code == 401
        r = c.post('/api/session', json={'dev_user': 'bayram'}, headers=H); assert r.status_code == 200, r.text
        me = c.get('/api/holiday-theme/me').json()
        assert me['enabled'] is True and me['country'] is None and me['located'] is None, me   # yalnız varsayılan TRTEST parkuru → konum sayılmaz
        assert 'TR' in me['countries'] and len(me['themes']) == 20
        r = c.post('/api/tracks', json={'name': 'Berlin', 'lat': 52.52, 'lon': 13.40}, headers=H); assert r.status_code in (200, 201), r.text
        me = c.get('/api/holiday-theme/me').json()
        assert me['located'] == 'DE' and me['located_source'] == 'track', me
        s = c.get('/api/settings').json()
        assert s['holiday_fx'] is True and s['holiday_country'] == ''
        s = c.put('/api/settings', json={'holiday_fx': False, 'holiday_country': 'sa'}, headers=H).json()
        assert s['holiday_fx'] is False and s['holiday_country'] == 'SA', s
        me = c.get('/api/holiday-theme/me').json()
        assert me['enabled'] is False and me['country'] == 'SA'
        assert c.put('/api/settings', json={'holiday_country': '1A'}, headers=H).status_code == 422
        s = c.put('/api/settings', json={'holiday_country': ''}, headers=H).json()
        assert s['holiday_country'] == '' and s['holiday_fx'] is False
    print('  SIMUMAV uç noktaları + ayarlar')


def main():
    katalog(); veri(); gun_bilgisi(); konum(); simumav()
    print('test_simumav_holiday: TAMAM')


if __name__ == '__main__':
    main()
