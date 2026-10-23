"""SIMUMAV ÇOK OYUNCULU KARŞILAŞMA testleri (docs/simumav.md §18) — sahte kinematik (HEPGO_SITL=0), tek TestClient (tek olay döngüsü).

Kapsam: göç (matches / match_players / match_attempts + flights.match_id, idempotent), meta sınırları (oyuncu ≤ SIMUMAV_MAX_FLIGHTS), halka
önizlemesi (deterministik), oluşturma doğrulaması (kara aracı / kısa şifre / oyuncu sınırı / ikinci açık karşılaşma), şifre yalnız scrypt özeti,
davet kodu tahmin edilemez (22 karakter), davet özeti (şifresiz), bilinmeyen kod 404, YANLIŞ ŞİFRE 403 + kalan hak, kaba kuvvet 429 (doğru şifre
de reddedilir), katılım → lobi, oyuncu olmayan 404 / WS 4403, dolu 409, çıkarılan yeniden giremez, hazır olmadan başlatma 409, açık uçuşu olan
oyuncu 409, SITL yuvası yetersiz 429 (anlaşılır mesaj), BAŞLAT → HAZIRLIK → her oyuncuya kendi uçuşu (farklı başlangıç, MP köprüsü yok,
flights.match_id, kurucunun dronu başkasına yazılmaz), komut kapısı (kalkış/ARM yarıştan önce 400; hız 1× sabit; başkasının oturumu 404),
WS ready → countdown → YARIS → halka geçişleri 1…n → kazanan → iki WS'de sonuç → uçuşlar kapanır, DB BITTI + sıralama, geçmiş listesi,
iptal / kurucu ayrılırsa iptal / terk edilen lobi temizliği.

Çalıştırma: ./.venv/bin/python -m tests.test_simumav_match
"""
import json
import math
import os
import sys
import tempfile
import time

D = tempfile.mkdtemp(prefix='simumav-match-test-')
os.environ.update(SIMUMAV_DATA_DIR=D, SIMUMAV_DEV_LOGIN='1', HEPGO_SITL='0', SIMUMAV_UDP_BASE='26750', SIMUMAV_MAX_FLIGHTS='3', SIMUMAV_MP_PORT_BASE='27600',
                  SIMUMAV_MP_PORT_COUNT='40', SIMUMAV_SECURE_COOKIE='0', SIMUMAV_ENV_FILE=os.path.join(D, 'yok.env'), SIMUMAV_MT_INTERNAL='http://127.0.0.1:1',
                  GOOGLE_MAPS_API_KEY='')
for k in [k for k in sys.modules if k == 'app' or k.startswith('app.')]:
    del sys.modules[k]

from fastapi.testclient import TestClient  # noqa: E402

import app.simumav.main as smain  # noqa: E402
from app import flightsim  # noqa: E402
from app import flightsim_match_core as core  # noqa: E402
from app.simumav import bridge, config, db  # noqa: E402
from app.simumav import match as M  # noqa: E402
from tests.match_bot import it_pilotu, rota_pilotu  # noqa: E402

ORIGIN = 'http://127.0.0.1:8600'
A = '/api/match'


def ok(r, code=200):
    assert r.status_code == code, (r.request.method, r.request.url, r.status_code, r.text)
    return r.json()


class K:
    """Tek TestClient üzerinde kullanıcı başına çerez başlığı (oturum görevleri ve WS aynı olay döngüsünde)."""

    def __init__(self, c, ad):
        c.cookies.clear()
        r = c.post('/api/session', json={'dev_user': ad}, headers={'Origin': ORIGIN})
        assert r.status_code == 200, r.text
        self.tok = r.cookies.get('smsid')
        self.user = r.json()['user']
        self.id = self.user['id']
        c.cookies.clear()
        self.c = c

    def _h(self, kw, yaz=False):
        h = kw.setdefault('headers', {})
        h['Cookie'] = f'smsid={self.tok}'
        if yaz:
            h['Origin'] = ORIGIN
        return kw

    def get(self, url, **kw):
        return self.c.get(url, **self._h(kw))

    def post(self, url, **kw):
        return self.c.post(url, **self._h(kw, True))

    def ws(self, url):
        return self.c.websocket_connect(url, headers={'Cookie': f'smsid={self.tok}'})


def bekle(fn, sn=10.0, adim=0.05):
    bitis = time.time() + sn
    while time.time() < bitis:
        v = fn()
        if v:
            return v
        time.sleep(adim)
    return fn()


def ws_bekle(ws, kosul, sn=15.0, biriktir=None):
    bitis = time.time() + sn
    while time.time() < bitis:
        m = json.loads(ws.receive_text())
        if biriktir is not None:
            biriktir.append(m)
        if kosul(m):
            return m
    return None


def main():
    config.RATE['write'] = (100000, 60)
    config.RATE['read'] = (100000, 60)
    core_geri, kapanis = core.GERI_SAYIM_S, M.KAPANIS_GECIKME_S
    core.GERI_SAYIM_S = 1.0
    M.KAPANIS_GECIKME_S = 0.3
    try:
        with TestClient(smain.app, base_url=ORIGIN) as c:
            calis(c)
    finally:
        core.GERI_SAYIM_S, M.KAPANIS_GECIKME_S = core_geri, kapanis
    # göç idempotent: ikinci init hata vermez, sürüm 5 (HEPGO §41: matches.kind + game_cfg; §44: match_players FK'siz + is_bot/level)
    db.init()
    db.init()
    with db.connect() as conn:
        assert conn.execute('SELECT version FROM schema_version').fetchone()[0] == db.SCHEMA_VERSION >= 5   # §25 v6
        assert {'is_bot', 'level'} <= {r[1] for r in conn.execute('PRAGMA table_info(match_players)')}
        assert [r[2] for r in conn.execute('PRAGMA foreign_key_list(match_players)')] == ['matches'], 'user_id FK kalktı'
        # v4 → v5: eski tablo (users FK'li) satırlarıyla yeniden kurulur
        n0 = conn.execute('SELECT COUNT(*) FROM match_players').fetchone()[0]
        conn.executescript("""
            DROP TRIGGER IF EXISTS tr_match_players_user_sil;
            CREATE TABLE mp_eski (match_id INTEGER NOT NULL REFERENCES matches(id) ON DELETE CASCADE, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                name TEXT NOT NULL, is_host INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL, flight_id INTEGER, rank INTEGER, rings INTEGER, time_s REAL,
                joined_at TEXT NOT NULL, PRIMARY KEY (match_id, user_id));
            INSERT INTO mp_eski SELECT match_id, user_id, name, is_host, status, flight_id, rank, rings, time_s, joined_at FROM match_players WHERE is_bot = 0;
            DROP TABLE match_players; ALTER TABLE mp_eski RENAME TO match_players; UPDATE schema_version SET version = 4;
        """)
        n_insan = conn.execute('SELECT COUNT(*) FROM match_players').fetchone()[0]
    db.init()
    with db.connect() as conn:
        assert conn.execute('SELECT version FROM schema_version').fetchone()[0] == db.SCHEMA_VERSION
        assert {'is_bot', 'level'} <= {r[1] for r in conn.execute('PRAGMA table_info(match_players)')}
        assert conn.execute('SELECT COUNT(*) FROM match_players').fetchone()[0] == n_insan <= n0 and n_insan > 0
        assert {'kind', 'game_cfg'} <= {r[1] for r in conn.execute('PRAGMA table_info(matches)')}
        tabs = {r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type = 'table'")}
        assert {'matches', 'match_players', 'match_attempts'} <= tabs, tabs
        assert 'match_id' in {r[1] for r in conn.execute('PRAGMA table_info(flights)')}
    print('test_simumav_match: TAMAM')


def calis(c):
    ali, veli, ayse, can, dora = (K(c, n) for n in ('ali', 'veli', 'ayse', 'can', 'dora'))
    # ---- meta
    m = ok(ali.get(f'{A}/meta'))
    assert m['limits']['players'] == [2, 3] and 'rover' not in m['limits']['types'] and m['capacity'] == {'max': 3, 'used': 0} and m['current'] is None, m
    # ---- parkur (prosedürel: ağsız) + dronlar
    tr = ok(ali.post('/api/tracks', json={'name': 'Yarış', 'lat': 40.1, 'lon': 33.4, 'world_mode': 'procedural', 'world': {'seed': 7}}), 201)
    drone = ok(ali.get('/api/hangar'))['drones'][0]
    rover = ok(ali.post('/api/hangar', json={'name': 'R1', 'type': 'rover', 'model_key': 'glb:rover_4x4'}), 201)
    halka = {'count': 3, 'min_alt_m': 20, 'max_alt_m': 40, 'diameter_m': 10, 'radius_m': 150, 'seed': 11}
    pv = ok(ali.post(f'{A}/rings-preview', json={'drone_id': drone['id'], 'track_id': tr['id'], 'rings': halka, 'players': 3}))
    pv2 = ok(ali.post(f'{A}/rings-preview', json={'drone_id': drone['id'], 'track_id': tr['id'], 'rings': halka, 'players': 3}))
    assert len(pv['rings']) == 3 and pv['rings'] == pv2['rings'] and len(pv['starts']) == 3, pv
    assert sorted(round(r['agl_m']) for r in pv['rings']) == [20, 30, 40]
    assert ali.post(f'{A}/rings-preview', json={'drone_id': drone['id'], 'track_id': tr['id'], 'rings': {'min_alt_m': 90, 'max_alt_m': 20}}).status_code == 422
    assert veli.post(f'{A}/rings-preview', json={'drone_id': drone['id'], 'track_id': tr['id']}).status_code == 404   # başkasının dronu/parkuru

    # ---- oluşturma doğrulaması
    govde = {'drone_id': drone['id'], 'track_id': tr['id'], 'rings': halka, 'password': 'Gizli-42', 'max_players': 3}
    assert ali.post(A, json={**govde, 'drone_id': rover['id']}).status_code == 422
    assert ali.post(A, json={**govde, 'password': 'abc'}).status_code == 422
    r = ali.post(A, json={**govde, 'max_players': 5}); assert r.status_code == 422 and '2–3' in r.json()['detail']['message'], r.text
    assert veli.post(A, json=govde).status_code == 404
    mt = ok(ali.post(A, json=govde), 201)
    mid, code = mt['id'], mt['code']
    assert mt['state'] == 'LOBI' and len(code) >= 20 and mt['host_id'] == ali.id and len(mt['players']) == 1 and mt['players'][0]['host'], mt
    assert 'password' not in json.dumps(mt) and 'Gizli-42' not in json.dumps(mt) and 'pass_hash' not in mt
    with db.connect() as conn:
        row = db.row(conn.execute('SELECT * FROM matches WHERE id = ?', (mid,)))
    assert row['pass_hash'].startswith('scrypt$') and 'Gizli-42' not in row['pass_hash'] and row['code'] == code and row['state'] == 'LOBI'
    r = ali.post(A, json=govde); assert r.status_code == 409 and r.json()['detail']['error'] == 'match_open', r.text
    assert ok(ali.get(f'{A}/meta'))['current']['id'] == mid

    # ---- davet sayfası + şifre
    inv = ok(veli.get(f'{A}/invite/{code}'))
    assert inv['host_name'] == 'ali' and inv['joined'] is False and inv['id'] is None and inv['rings'] == 3 and inv['players'] == 1 and inv['max_players'] == 3, inv
    assert inv['me']['email'] and 'players_list' not in inv
    assert veli.get(f'{A}/invite/yanlis-kod-12345').status_code == 404
    assert veli.post(f'{A}/join', json={'code': 'yanlis-kod-12345', 'password': 'x'}).status_code == 404
    r = veli.post(f'{A}/join', json={'code': code, 'password': 'yanlis'})
    assert r.status_code == 403 and r.json()['detail']['error'] == 'bad_password' and r.json()['detail']['remaining'] == 4, r.text
    assert veli.get(f'{A}/{mid}').status_code == 404   # henüz oyuncu değil
    # kaba kuvvet: ayşe 5 yanlış → 6. denemede doğru şifre de 429
    for i in range(5):
        assert ayse.post(f'{A}/join', json={'code': code, 'password': f'tahmin{i}'}).status_code == 403
    r = ayse.post(f'{A}/join', json={'code': code, 'password': 'Gizli-42'})
    assert r.status_code == 429 and r.json()['detail']['error'] == 'too_many_attempts' and r.json()['detail']['retry_after'] > 0, r.text
    j = ok(veli.post(f'{A}/join', json={'code': code, 'password': 'Gizli-42'}))
    assert {p['id'] for p in j['players']} == {ali.id, veli.id} and j['me'] == veli.id and not j['can_start']
    assert all(p['avatar'] and p['avatar']['v'] == 2 and p['avatar']['helmet'].startswith('#') for p in j['players'])   # §25 salon avatarı (varsayılan pilot)
    assert ok(veli.get(f'{A}/invite/{code}'))['joined'] is True
    ok(veli.post(f'{A}/join', json={'code': code, 'password': 'Gizli-42'}))   # yeniden: değişiklik yok
    # 3. oyuncu can katılır, dora dolu
    ok(can.post(f'{A}/join', json={'code': code, 'password': 'Gizli-42'}))
    r = dora.post(f'{A}/join', json={'code': code, 'password': 'Gizli-42'}); assert r.status_code == 409 and r.json()['detail']['error'] == 'full', r.text
    # yalnız kurucu çıkarır; çıkarılan yeniden giremez
    assert veli.post(f'{A}/{mid}/kick', json={'user_id': can.id}).status_code == 403
    k1 = ok(ali.post(f'{A}/{mid}/kick', json={'user_id': can.id}))
    assert can.id not in {p['id'] for p in k1['players']}
    r = can.post(f'{A}/join', json={'code': code, 'password': 'Gizli-42'}); assert r.status_code == 403 and r.json()['detail']['error'] == 'kicked', r.text

    with veli.ws(f'/ws/match/{mid}') as wv, ali.ws(f'/ws/match/{mid}') as wa:
        h = ws_bekle(wv, lambda x: x['t'] == 'hello')
        assert h['me'] == veli.id and h['match']['id'] == mid
        ws_bekle(wa, lambda x: x['t'] == 'hello')
        with dora.ws(f'/ws/match/{mid}') as wd:
            assert json.loads(wd.receive_text())['error'] == 'forbidden'
        # hazır olmadan başlatılamaz; yalnız kurucu başlatır
        r = ali.post(f'{A}/{mid}/start'); assert r.status_code == 409 and r.json()['detail']['error'] == 'not_ready', r.text
        assert veli.post(f'{A}/{mid}/start').status_code == 403
        rd = ok(veli.post(f'{A}/{mid}/ready', json={'ready': True}))
        assert rd['can_start'] is True and next(p for p in rd['players'] if p['id'] == veli.id)['ready'] is True
        ws_bekle(wa, lambda x: x['t'] == 'match' and x['match']['can_start'])
        # açık uçuşu olan oyuncu → 409
        vd = ok(veli.get('/api/hangar'))['drones'][0]; vp = ok(veli.get('/api/crew'))['pilots'][0]; vt = ok(veli.get('/api/tracks'))['tracks'][0]
        fl = ok(veli.post('/api/fly/start', json={'drone_id': vd['id'], 'pilot_id': vp['id'], 'track_id': vt['id'], 'launch': 'wheels'}), 201)
        r = ali.post(f'{A}/{mid}/start'); assert r.status_code == 409 and r.json()['detail']['error'] == 'flight_open' and 'veli' in r.text, r.text
        ok(veli.post(f"/api/fly/{fl['flight_id']}/stop", json={}))
        # SITL yuvası yetersiz → 429 anlaşılır mesaj
        eski = config.MAX_FLIGHTS
        config.MAX_FLIGHTS = 1
        r = ali.post(f'{A}/{mid}/start')
        config.MAX_FLIGHTS = eski
        assert r.status_code == 429 and r.json()['detail']['error'] == 'server_full' and 'yuva' in r.json()['detail']['message'] and r.json()['detail']['need'] == 2, r.text
        # BAŞLAT → HAZIRLIK → oturumlar
        st = ok(ali.post(f'{A}/{mid}/start'))
        assert st['state'] == 'HAZIRLIK', st
        ws_bekle(wv, lambda x: x['t'] == 'state' and x['state'] == 'HAZIRLIK')
        d = bekle(lambda: (lambda x: x if all(p['session_id'] and p['flight_id'] for p in x['players']) else None)(ok(ali.get(f'{A}/{mid}'))))
        assert all(p.get('avatar') for p in d['players']), 'yarışta da avatar (lobi kaydından)'
        assert d, d
        sids = {p['id']: p['session_id'] for p in d['players']}
        fids = {p['id']: p['flight_id'] for p in d['players']}
        ss = {u: flightsim.MANAGER.get(s) for u, s in sids.items()}
        assert all(s is not None and s.match_id == mid and s.start for s in ss.values())
        assert bridge.aktif_sayisi() == 2 and not bridge.MAC_REZERV, bridge.MAC_REZERV
        merkez = d['center']
        pts = [core.enu(merkez['lat'], merkez['lon'], s.start['lat'], s.start['lon']) for s in ss.values()]
        assert math.dist(*pts) >= core.AYRIK_M - 0.1, pts
        assert abs(merkez['alt'] - float(ss[ali.id].center.get('alt') or flightsim.EV_IRTIFA)) < 0.01   # halka yükseklikleri SITL ev irtifasıyla
        assert abs(d['rings'][0]['alt_msl'] - merkez['alt'] - d['rings'][0]['agl_m']) < 0.01
        with db.connect() as conn:
            fr = {r['user_id']: r for r in db.rows(conn.execute('SELECT * FROM flights WHERE match_id = ?', (mid,)))}
        assert set(fr) == {ali.id, veli.id} and fr[ali.id]['drone_id'] == drone['id'] and fr[veli.id]['drone_id'] is None and fr[veli.id]['track_id'] is None, fr
        assert fr[veli.id]['mp_port'] is None and json.loads(fr[veli.id]['snapshot'])['match']['id'] == mid
        assert ok(veli.get(f"/api/fly/{fids[veli.id]}"))['mp'] is None
        assert all(bekle(lambda s=s: s.state == 'HAZIR') for s in ss.values())
        # komut kapısı + hız sabit + başkasının oturumu
        sv = sids[veli.id]
        r = veli.post(f'/api/drone/sim/sessions/{sv}/cmd', json={'name': 'takeoff', 'params': {'alt': 20}})
        assert r.status_code == 400 and 'başlamadı' in r.text, r.text
        r = veli.post(f'/api/drone/sim/sessions/{sv}/cmd', json={'name': 'speed', 'params': {'factor': 2}})
        assert r.status_code == 400 and 'hızı' in r.text, r.text
        assert ali.post(f'/api/drone/sim/sessions/{sv}/cmd', json={'name': 'mode', 'params': {'mode': 'GUIDED'}}).status_code == 404
        ok(veli.post(f'/api/drone/sim/sessions/{sv}/cmd', json={'name': 'mode', 'params': {'mode': 'GUIDED'}}))
        for w in (wv, wa):
            w.send_text(json.dumps({'t': 'ready'}))
        cd = ws_bekle(wv, lambda x: x['t'] == 'countdown')
        assert cd and cd['start_at'] > time.time() - 1, cd
        assert veli.post(f'/api/drone/sim/sessions/{sv}/cmd', json={'name': 'arm'}).status_code == 400   # geri sayımda da kapalı
        ws_bekle(wv, lambda x: x['t'] == 'state' and x['state'] == 'YARIS', sn=6)
        ok(veli.post(f'/api/drone/sim/sessions/{sv}/cmd', json={'name': 'arm'}))   # yarışta serbest
        pos = ws_bekle(wv, lambda x: x['t'] == 'pos' and len(x['p']) == 2)
        assert pos and {'id', 'lat', 'lon', 'alt_msl', 'rings', 'next', 'dist'} <= set(pos['p'][0]), pos
        rota_pilotu(ss[ali.id], d['rings'], merkez, hiz=120.0)
        rota_pilotu(ss[veli.id], d['rings'], merkez, hiz=60.0, kadar=1)
        gorulen = []
        res = ws_bekle(wv, lambda x: x['t'] == 'result', sn=30, biriktir=gorulen)
        assert res, ([x for x in gorulen if x['t'] == 'pos'][-1], d['rings'], merkez, {u: (s.center, s.start) for u, s in ss.items()})
        rs = res['result']
        assert rs['winner'] == ali.id and rs['reason'] == 'birinci_bitirdi' and rs['standings'][0]['id'] == ali.id and rs['standings'][0]['rings'] == 3, rs
        assert rs['standings'][0]['time_s'] > 0 and rs['standings'][1]['id'] == veli.id and rs['standings'][1]['rings'] == 1, rs
        assert [x['i'] for x in gorulen if x['t'] == 'ring' and x['id'] == ali.id] == [1, 2, 3]
        assert ws_bekle(wa, lambda x: x['t'] == 'result')['result']['winner'] == ali.id   # kurucuda da sonuç
        assert bekle(lambda: all(flightsim.MANAGER.get(s) is None for s in sids.values()), sn=20)
    assert bekle(lambda: all(bridge.ucus_durumu(f) is None for f in fids.values()), sn=20)
    with db.connect() as conn:
        row = db.row(conn.execute('SELECT * FROM matches WHERE id = ?', (mid,)))
        mp = {r['user_id']: r for r in db.rows(conn.execute('SELECT * FROM match_players WHERE match_id = ?', (mid,)))}
        fr = {r['user_id']: r for r in db.rows(conn.execute('SELECT * FROM flights WHERE match_id = ?', (mid,)))}
    assert row['state'] == 'BITTI' and row['winner_id'] == ali.id and json.loads(row['result'])['winner'] == ali.id and row['started_at'] and row['ended_at'], row
    assert mp[ali.id]['rank'] == 1 and mp[veli.id]['rank'] == 2 and mp[ali.id]['rings'] == 3 and mp[ali.id]['flight_id'] == fids[ali.id], mp
    assert all(f['ended_at'] for f in fr.values())
    from app import flightsim_runs   # çekirdek drone_sim_runs (SIMUMAV shim DB): match_id sütunu var → kayıt düşmez
    assert bekle(lambda: len(flightsim_runs.db.rows(flightsim_runs.db.connect().execute('SELECT id FROM drone_sim_runs WHERE match_id = ?', (mid,)))) == 2, sn=20), 'drone_sim_runs match_id kaydı'
    g = ok(veli.get(f'{A}/{mid}'))
    assert g['state'] == 'BITTI' and g['result']['winner'] == ali.id
    hl = ok(veli.get(A))
    assert hl and hl[0]['id'] == mid and hl[0]['winner_name'] == 'ali' and hl[0]['rank'] == 2, hl
    r = dora.post(f'{A}/join', json={'code': code, 'password': 'Gizli-42'}); assert r.status_code == 409, r.text   # bitmiş karşılaşma

    # ---- iptal: kurucu iptal eder; kurucu ayrılırsa iptal; terk edilen lobi temizlenir
    m2 = ok(veli.post(A, json={**govde, 'drone_id': vd['id'], 'track_id': vt['id']}), 201)
    ok(dora.post(f'{A}/join', json={'code': m2['code'], 'password': 'Gizli-42'}))
    assert dora.post(f"{A}/{m2['id']}/cancel").status_code == 403
    assert ok(veli.post(f"{A}/{m2['id']}/cancel"))['state'] == 'IPTAL'
    m3 = ok(veli.post(A, json={**govde, 'drone_id': vd['id'], 'track_id': vt['id']}), 201)
    ok(dora.post(f'{A}/join', json={'code': m3['code'], 'password': 'Gizli-42'}))
    l3 = ok(dora.post(f"{A}/{m3['id']}/leave"))
    assert dora.id not in {p['id'] for p in l3['players']} and l3['state'] == 'LOBI'
    r3 = ok(veli.post(f"{A}/{m3['id']}/leave"))
    assert r3['state'] == 'IPTAL' and r3['reason'] == 'kurucu_ayrildi', r3
    eski, eski_g = config.MATCH_ABANDON_S, M.GORULDU_S
    config.MATCH_ABANDON_S, M.GORULDU_S = 0.5, 0.5
    try:
        m4 = ok(dora.post(A, json={**govde, 'drone_id': ok(dora.get('/api/hangar'))['drones'][0]['id'], 'track_id': ok(dora.get('/api/tracks'))['tracks'][0]['id']}), 201)
        assert bekle(lambda: M.MANAGER.get(m4['id']).durum == 'IPTAL', sn=6)
        assert M.MANAGER.get(m4['id']).neden == 'terk_edildi'
    finally:
        config.MATCH_ABANDON_S, M.GORULDU_S = eski, eski_g
    print('  API uçtan uca geçti (karşılaşma', mid, ')')
    it_dalasi(ali, veli, dora, drone, tr)


def it_dalasi(ali, veli, dora, drone, tr):
    """HEPGO §41 it dalaşı (SIMUMAV): tür doğrulaması, oyuncu 2'ye sabit, önizlemede iki başlangıç (kaçan önde), davet özetinde tür, roller,
    Sıfırla kapısı, sahte kinematikle kovalayan kaçanı tutar → ANGAJE → kovalayan kazanır; pos.df; DB kind/game_cfg; geçmişte tür."""
    df = {'distance_m': 400, 'alt_m': 30, 'range_m': 150, 'cone_deg': 25, 'hold_s': 2, 'time_limit_min': 3, 'roles': 'host_evader'}
    pv = ok(ali.post(f'{A}/rings-preview', json={'drone_id': drone['id'], 'track_id': tr['id'], 'kind': 'dogfight', 'dogfight': df}))
    assert pv['kind'] == 'dogfight' and pv['rings'] == [] and [x['role'] for x in pv['starts']] == ['chaser', 'evader'], pv
    assert abs(math.dist((pv['starts'][0]['x'], pv['starts'][0]['y']), (pv['starts'][1]['x'], pv['starts'][1]['y'])) - 400) < 0.5
    govde = {'drone_id': drone['id'], 'track_id': tr['id'], 'password': 'Dalas-77', 'max_players': 2, 'kind': 'dogfight', 'dogfight': df}
    assert ali.post(A, json={**govde, 'max_players': 3}).status_code == 422
    assert ali.post(A, json={**govde, 'dogfight': {**df, 'hold_s': 9}}).status_code == 422
    assert ali.post(A, json={**govde, 'kind': 'kovala'}).status_code == 422
    mt = ok(ali.post(A, json=govde), 201)
    mid, code = mt['id'], mt['code']
    assert mt['kind'] == 'dogfight' and mt['max_players'] == 2 and mt['rings'] == [] and mt['rings_cfg']['cone_deg'] == 25, mt
    with db.connect() as conn:
        row = db.row(conn.execute('SELECT kind, game_cfg, rings_cfg FROM matches WHERE id = ?', (mid,)))
    assert row['kind'] == 'dogfight' and json.loads(row['game_cfg'])['hold_s'] == 2 and row['rings_cfg'] == '{}', dict(row)
    assert ok(veli.get(f'{A}/invite/{code}'))['kind'] == 'dogfight'
    ok(veli.post(f'{A}/join', json={'code': code, 'password': 'Dalas-77'}))
    r = dora.post(f'{A}/join', json={'code': code, 'password': 'Dalas-77'}); assert r.status_code == 409 and r.json()['detail']['error'] == 'full', r.text
    ok(veli.post(f'{A}/{mid}/ready', json={'ready': True}))
    with veli.ws(f'/ws/match/{mid}') as wv, ali.ws(f'/ws/match/{mid}') as wa:
        ws_bekle(wv, lambda x: x['t'] == 'hello'); ws_bekle(wa, lambda x: x['t'] == 'hello')
        st = ok(ali.post(f'{A}/{mid}/start'))
        assert {p['id']: p['role'] for p in st['players']} == {ali.id: 'evader', veli.id: 'chaser'}, st['players']
        d = bekle(lambda: (lambda x: x if all(p['session_id'] and p['flight_id'] for p in x['players']) else None)(ok(ali.get(f'{A}/{mid}'))))
        sids = {p['id']: p['session_id'] for p in d['players']}
        ss = {u: flightsim.MANAGER.get(sx) for u, sx in sids.items()}
        assert all(bekle(lambda sx=sx: sx.state == 'HAZIR') for sx in ss.values())
        merkez = d['center']
        P = core.it_baslangiclari(d['rings_cfg'], 'multirotor')
        pc = core.enu(merkez['lat'], merkez['lon'], ss[veli.id].start['lat'], ss[veli.id].start['lon'])
        pe = core.enu(merkez['lat'], merkez['lon'], ss[ali.id].start['lat'], ss[ali.id].start['lon'])
        assert math.dist(pc, P['chaser'][:2]) < 0.5 and math.dist(pe, P['evader'][:2]) < 0.5, (pc, pe, P)
        for w in (wv, wa):
            w.send_text(json.dumps({'t': 'ready'}))
        ws_bekle(wv, lambda x: x['t'] == 'state' and x['state'] == 'YARIS', sn=8)
        r = veli.post(f"/api/drone/sim/sessions/{sids[veli.id]}/cmd", json={'name': 'reset'})
        assert r.status_code == 400 and 'Sıfırla' in r.text, r.text
        yon = P['evader'][2]
        kac = it_pilotu(ss[ali.id], merkez, yon, P['evader'][:2], hiz=8.0, alt=30.0)
        it_pilotu(ss[veli.id], merkez, yon, P['chaser'][:2], gecikme_m=100.0, takip=kac)
        gorulen = []
        res = ws_bekle(wa, lambda x: x['t'] == 'result', sn=30, biriktir=gorulen)
        assert res, [x['t'] for x in gorulen][-15:]
        rs = res['result']
        assert rs['kind'] == 'dogfight' and rs['winner'] == veli.id and rs['reason'] == 'angaje' and rs['dogfight']['engage_s'] >= 2, rs
        assert any(x.get('df', {}).get('in_cone') for x in gorulen if x['t'] == 'pos'), 'pos.df'
        assert ws_bekle(wv, lambda x: x['t'] == 'result')['result']['winner'] == veli.id
        assert bekle(lambda: all(flightsim.MANAGER.get(sx) is None for sx in sids.values()), sn=20)
    with db.connect() as conn:
        row = db.row(conn.execute('SELECT state, reason, winner_id FROM matches WHERE id = ?', (mid,)))
    assert row['state'] == 'BITTI' and row['reason'] == 'angaje' and row['winner_id'] == veli.id, dict(row)
    hl = ok(veli.get(A))
    assert hl[0]['id'] == mid and hl[0]['kind'] == 'dogfight' and hl[0]['rank'] == 1, hl[0]
    print('  it dalaşı API geçti (karşılaşma', mid, ')')
    yapay_zeka(ali, veli, dora, drone, tr)


def yapay_zeka(ali, veli, dora, drone, tr):
    """HEPGO §44 yapay zekâ pilot (SIMUMAV): salonda bot ekle/çıkar (yalnız kurucu, oyuncu sınırı, hazır + çevrimiçi sayılır), BAŞLAT'ta botlar
    da SITL yuvası (429 mesajında), "Yapay zekâya karşı" hızlı başlat (davetsiz; hemen HAZIRLIK; botun uçuş kaydı yok) → BOT KAZANIR (DB
    is_bot/level, geçmişte kazanan adı) ve insan hızlı uçunca İNSAN KAZANIR."""
    from app.simumav import auth as sauth
    sauth.oran_sifirla()   # oluşturma oranı (saatte 10) önceki bölümlerde doldu
    assert ok(ali.get(f'{A}/meta'))['limits']['bot']['levels'] == ['easy', 'normal', 'hard']
    halka = {'count': 2, 'min_alt_m': 10, 'max_alt_m': 16, 'diameter_m': 14, 'radius_m': 80, 'seed': 5}
    govde = {'drone_id': drone['id'], 'track_id': tr['id'], 'rings': halka, 'password': 'Bot-1234', 'max_players': 3}
    mt = ok(ali.post(A, json=govde), 201)
    mid = mt['id']
    ok(veli.post(f'{A}/join', json={'code': mt['code'], 'password': 'Bot-1234'}))
    assert veli.post(f'{A}/{mid}/bot', json={'level': 'hard'}).status_code == 403
    assert ali.post(f'{A}/{mid}/bot', json={'level': 'uzman'}).status_code == 422
    b = ok(ali.post(f'{A}/{mid}/bot', json={'level': 'hard'}))
    bot = next(p for p in b['players'] if p['is_bot'])
    assert bot['id'] < 0 and bot['name'] == 'AI-Şahin' and bot['level'] == 'hard' and bot['ready'] and bot['online'] and bot['color'], bot
    r = ali.post(f'{A}/{mid}/bot', json={'level': 'easy'}); assert r.status_code == 409 and r.json()['detail']['error'] == 'full', r.text
    k = ok(ali.post(f'{A}/{mid}/kick', json={'user_id': bot['id']}))
    assert not any(p['is_bot'] for p in k['players'])
    ok(ali.post(f'{A}/{mid}/bot', json={'level': 'normal'}))   # çıkarılan bot yasaklanmaz; yeniden eklenebilir
    ok(veli.post(f'{A}/{mid}/ready', json={'ready': True}))
    eski = config.MAX_FLIGHTS
    config.MAX_FLIGHTS = 2
    r = ali.post(f'{A}/{mid}/start')
    config.MAX_FLIGHTS = eski
    assert r.status_code == 429 and 'yapay zekâ' in r.json()['detail']['message'] and r.json()['detail']['need'] == 3, r.text
    assert ok(ali.post(f'{A}/{mid}/cancel'))['state'] == 'IPTAL'

    # ---- yapay zekâya karşı (hızlı başlat): insan uçmaz → bot kazanır
    r = ali.post(f'{A}/ai', json={'drone_id': drone['id'], 'track_id': tr['id'], 'rings': halka, 'level': 'x'}); assert r.status_code == 422, r.text
    q = ok(ali.post(f'{A}/ai', json={'drone_id': drone['id'], 'track_id': tr['id'], 'rings': halka, 'level': 'hard'}), 201)
    mid = q['id']
    assert q['state'] == 'HAZIRLIK' and len(q['players']) == 2 and sum(p['is_bot'] for p in q['players']) == 1, q
    bot = next(p for p in q['players'] if p['is_bot'])
    d = bekle(lambda: (lambda x: x if all(p['session_id'] for p in x['players']) else None)(ok(ali.get(f'{A}/{mid}'))))
    assert d and next(p for p in d['players'] if p['is_bot'])['flight_id'] is None, d
    sids = {p['id']: p['session_id'] for p in d['players']}
    sb = flightsim.MANAGER.get(sids[bot['id']])
    assert sb.bot == {'uid': bot['id'], 'level': 'hard'} and all(bekle(lambda sx=sx: flightsim.MANAGER.get(sx).state == 'HAZIR') for sx in sids.values())
    with ali.ws(f'/ws/match/{mid}') as wa:
        ws_bekle(wa, lambda x: x['t'] == 'hello')
        wa.send_text(json.dumps({'t': 'ready'}))
        ws_bekle(wa, lambda x: x['t'] == 'state' and x['state'] == 'YARIS', sn=8)
        gorulen = []
        res = ws_bekle(wa, lambda x: x['t'] == 'result', sn=120, biriktir=gorulen)
        assert res, [x for x in gorulen if x['t'] == 'ring']
        rs = res['result']
        assert rs['winner'] == bot['id'] and rs['standings'][0]['is_bot'] and rs['standings'][0]['level'] == 'hard', rs
        assert bekle(lambda: all(flightsim.MANAGER.get(sx) is None for sx in sids.values()), sn=20)

    def satirlar():
        with db.connect() as conn:
            row = db.row(conn.execute('SELECT * FROM matches WHERE id = ?', (mid,)))
            mp = {r['user_id']: r for r in db.rows(conn.execute('SELECT * FROM match_players WHERE match_id = ?', (mid,)))}
            fl = db.rows(conn.execute('SELECT user_id FROM flights WHERE match_id = ?', (mid,)))
        return (row, mp, fl) if row['state'] == 'BITTI' and mp[bot['id']]['rank'] == 1 else None
    row, mp, fl = bekle(satirlar, sn=5)
    assert row['winner_id'] == bot['id'] and mp[bot['id']]['is_bot'] == 1 and mp[bot['id']]['level'] == 'hard' and mp[ali.id]['is_bot'] == 0, mp
    assert [f['user_id'] for f in fl] == [ali.id], fl   # botun uçuş kaydı yok
    hl = ok(ali.get(A))
    assert hl[0]['id'] == mid and hl[0]['winner_name'] == 'AI-Şahin', hl[0]
    g = ok(ali.get(f'{A}/{mid}'))
    assert any(p['is_bot'] and p['level'] == 'hard' for p in g['players']), g['players']

    # ---- insan hızlı uçar → insan kazanır (bot Kolay)
    q = ok(ali.post(f'{A}/ai', json={'drone_id': drone['id'], 'track_id': tr['id'], 'rings': halka, 'level': 'easy'}), 201)
    mid = q['id']
    d = bekle(lambda: (lambda x: x if all(p['session_id'] for p in x['players']) else None)(ok(ali.get(f'{A}/{mid}'))))
    sids = {p['id']: p['session_id'] for p in d['players']}
    assert all(bekle(lambda sx=sx: flightsim.MANAGER.get(sx) is not None and flightsim.MANAGER.get(sx).state == 'HAZIR') for sx in sids.values())
    with ali.ws(f'/ws/match/{mid}') as wa:
        ws_bekle(wa, lambda x: x['t'] == 'hello')
        wa.send_text(json.dumps({'t': 'ready'}))
        ws_bekle(wa, lambda x: x['t'] == 'state' and x['state'] == 'YARIS', sn=8)
        rota_pilotu(flightsim.MANAGER.get(sids[ali.id]), d['rings'], d['center'], hiz=40.0)
        res = ws_bekle(wa, lambda x: x['t'] == 'result', sn=40)
        assert res and res['result']['winner'] == ali.id and res['result']['standings'][1]['is_bot'], res
        assert bekle(lambda: all(flightsim.MANAGER.get(sx) is None for sx in sids.values()), sn=20)
    print('  yapay zekâ pilot geçti (karşılaşma', mid, ')')


if __name__ == '__main__':
    main()
