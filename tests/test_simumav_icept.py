"""SIMUMAV INTERCEPTOR (HEPGO §25) + HEDEFLER (§24) testleri (docs/simumav.md §11).

Kapsam: göç v2 (eski sabit kanat "interceptor" jet/delta dronları ve uçuş anlık görüntüleri → 'plane'; tailsitter tipi dokunulmaz; model/parametre
korunur), katalog (INTERCEPTOR = 3 tailsitter GLB'si; jet/zephyr/proc:interceptor 'plane' altında), çekirdek eşlemesi (interceptor → interceptor,
dikey; kontrol düzeni yok; güç varsayılanı elektrikli 111,1 m/s), GET /api/fly/targets kataloğu (HEPGO şirket modelleri yok), fly/start `targets`
doğrulaması (422: model, sınırlar, > 8 öğe, yarıçap), geçerli hedeflerle uçuş → çekirdek oturumda hedefler + snapshot, WS hello'da hedefler,
stop → flights.summary.targets.

Çalıştırma: ./.venv/bin/python -m tests.test_simumav_icept
"""
import json
import os
import sqlite3
import sys
import tempfile
import time

D = tempfile.mkdtemp(prefix='simumav-icept-')
os.environ.update(SIMUMAV_DATA_DIR=D, SIMUMAV_DEV_LOGIN='1', HEPGO_SITL='0', SIMUMAV_UDP_BASE='24950', SIMUMAV_MAX_FLIGHTS='2', SIMUMAV_MP_PORT_BASE='25800',
                  SIMUMAV_MP_PORT_COUNT='40', SIMUMAV_SECURE_COOKIE='0', SIMUMAV_ENV_FILE=os.path.join(D, 'yok.env'), SIMUMAV_MAX_SPEEDUP='4',
                  SIMUMAV_MT_INTERNAL='http://127.0.0.1:1', GOOGLE_MAPS_API_KEY='')
for k in [k for k in sys.modules if k == 'app' or k.startswith('app.')]:
    del sys.modules[k]

from fastapi.testclient import TestClient  # noqa: E402

import app.simumav.main as smain  # noqa: E402
from app.simumav import bridge, config  # noqa: E402
from app.simumav import db as sdb  # noqa: E402

ORIGIN = 'http://127.0.0.1:8600'
H = {'Origin': ORIGIN}


def eski_taban():
    """Göç v1 tabanı: eski "interceptor" jet + delta dronları ve jet uçuşu (snapshot drone.type 'interceptor')."""
    with sqlite3.connect(config.DB_PATH) as c:
        c.executescript(sdb.SCHEMA)
        c.execute('INSERT INTO schema_version (version) VALUES (1)')
        t = '2026-01-01T00:00:00'
        c.execute("INSERT INTO users (id, mt_user_id, email, display_name, created_at, updated_at) VALUES (1, -77, 'e@x', 'eski', ?, ?)", (t, t))
        for i, mk in ((1, 'glb:jet'), (2, 'proc:interceptor'), (3, 'glb:zephyr'), (4, 'glb:icept_x4')):
            c.execute("INSERT INTO drones (id, user_id, name, type, model_key, params, color, created_at, updated_at) VALUES (?, 1, ?, 'interceptor', ?, ?, '#ff0000', ?, ?)",
                      (i, f'D{i}', mk, json.dumps({'AIRSPEED_MAX': 170}), t, t))
        snap = {'drone': {'id': 1, 'name': 'D1', 'type': 'interceptor', 'model_key': 'glb:jet'}}
        c.execute("INSERT INTO flights (id, user_id, drone_id, launch, started_at, snapshot, created_at, updated_at) VALUES (1, 1, 1, 'wheels', ?, ?, ?, ?)", (t, json.dumps(snap), t, t))
        c.commit()


def main():
    eski_taban()
    config.RATE['write'] = (100000, 60)
    config.RATE['read'] = (100000, 60)
    with TestClient(smain.app, base_url=ORIGIN) as c:
        # ---- göç v2
        with sqlite3.connect(config.DB_PATH) as cc:
            tipler = dict(cc.execute('SELECT model_key, type FROM drones').fetchall())
            assert tipler == {'glb:jet': 'plane', 'proc:interceptor': 'plane', 'glb:zephyr': 'plane', 'glb:icept_x4': 'interceptor'}, tipler
            assert json.loads(cc.execute('SELECT params FROM drones WHERE id = 1').fetchone()[0]) == {'AIRSPEED_MAX': 170}
            assert json.loads(cc.execute('SELECT snapshot FROM flights WHERE id = 1').fetchone()[0])['drone']['type'] == 'plane'
            assert cc.execute('SELECT version FROM schema_version').fetchone()[0] == sdb.SCHEMA_VERSION   # göç zinciri en son sürüme (v2 icept göçü dahil)
        sdb.init()   # idempotent
        # ---- katalog / eşleme
        r = c.post('/api/session', json={'dev_user': 'icept'}, headers=H); assert r.status_code == 200, r.text
        cat = c.get('/api/hangar/catalog').json()['types']
        keys = {t['key']: [m['key'] for m in t['models']] for t in cat}
        assert keys['interceptor'] == ['glb:icept_x4', 'glb:p1sun', 'glb:sting'] and {'glb:jet', 'glb:zephyr', 'proc:interceptor'} <= set(keys['plane']), keys
        assert bridge.TIP_ESLEME['interceptor'] == 'interceptor' and bridge.airframe_dogrula('interceptor', None, 'glb:icept_x4') is None
        assert bridge.MODEL_ESLEME['glb:icept_x4'] == 'builtin:icept_x4' and bridge.model_airframe('glb:jet') == 'classic'
        assert all(c.get(f'/static/simumav/models/{f}.glb').status_code == 200 for f in ('icept_x4', 'p1sun', 'sting', 'tgt_sw300', 'tgt_lancet', 'tgt_altius', 'tgt_octopus'))
        tg = c.get('/api/fly/targets').json()
        tk = {m['key'] for m in tg['models']}
        assert {'tgt:sw300', 'tgt:lancet', 'tgt:altius', 'tgt:octopus', 'glb:icept_x4', 'glb:jet'} <= tk and not any(k.startswith('builtin:') for k in tk), tk
        assert tg['max'] == 8 and tg['diameter_m'] == [50.0, 5000.0] and tg['alt_m'] == [10.0, 3000.0]
        r = c.post('/api/hangar', json={'name': 'Önleyici', 'type': 'interceptor', 'model_key': 'glb:icept_x4'}, headers=H)
        assert r.status_code == 201, r.text
        d = r.json()
        assert d['airframe'] is None and d['power']['engine'] == 'electric' and d['power']['max_speed_ms'] == 111.1 and d['power']['fuel_l'] == 0.0, d
        tid = c.get('/api/tracks').json()['tracks'][0]['id']
        pid = c.get('/api/crew').json()['pilots'][0]['id']
        base = {'drone_id': d['id'], 'pilot_id': pid, 'track_id': tid, 'launch': 'wheels', 'record': {'bin': False}}
        hedef = {'model': 'tgt:lancet', 'alt_m': 150, 'diameter_m': 800, 'dir': 'ccw', 'name': 'L1'}
        for kotu in ({'items': [{'model': 'builtin:caymaz', 'alt_m': 100, 'diameter_m': 300}]}, {'items': [{**hedef, 'diameter_m': 6000}]}, {'items': [{**hedef, 'alt_m': 5}]},
                     {'items': [{**hedef, 'speed_ms': 90}]}, {'items': [hedef] * 9}, {'items': [hedef], 'radius_m': 300}, {'items': 'x'}):
            r = c.post('/api/fly/start', json={**base, 'targets': kotu}, headers=H)
            assert r.status_code == 422, (kotu, r.text)
        r = c.post('/api/fly/start', json={**base, 'targets': {'items': [hedef, {'model': 'glb:iris', 'alt_m': 40, 'diameter_m': 120}], 'radius_m': 30}}, headers=H)
        assert r.status_code == 201, r.text
        f = r.json()
        s = bridge.oturum(f['sim_id'])
        assert s.type == 'interceptor' and s.layout is None and s.hedefler['radius_m'] == 30 and [h['model'] for h in s.hedefler['items']] == ['tgt:lancet', 'glb:iris']
        assert s.hedefler['items'][1]['glb_url'] == '/static/simumav/models/iris.glb' and s.hedefler['items'][0]['speed_ms'] == round(110 / 3.6, 2)
        st = c.get(f"/api/fly/{f['flight_id']}").json()
        assert st['snapshot']['targets']['items'][0]['name'] == 'L1' and st['session']['targets']['radius_m'] == 30 and st['session']['vertical'] is True
        son = time.time() + 20
        while time.time() < son and s.state != 'HAZIR':
            time.sleep(0.1)
        with c.websocket_connect(f"/ws/fly/{f['sim_id']}", headers={**H, 'Cookie': f"smsid={c.cookies.get('smsid')}"}) as ws:
            hl = json.loads(ws.receive_text())
            assert hl['t'] == 'hello' and hl['session']['targets']['items'][0]['model'] == 'tgt:lancet', str(hl)[:300]
        r = c.post(f"/api/fly/{f['flight_id']}/stop", json={}, headers=H); assert r.status_code == 200, r.text
        sm = r.json()['flight']['summary']
        assert sm['targets']['count'] == 2 and sm['targets']['radius_m'] == 30 and 'score' in sm['targets'], sm.get('targets')
        # ---- HEPGO §27 fırlatıcılar: doğrulama (sınırlar), çekirdek world.launch, flights.launch, WS takeoff{aim} → aşamalar
        for kotu in ({'method': 'pod4', 'loaded': 9}, {'method': 'handheld', 'aim_el_deg': 5}, {'method': 'handheld', 'aim_az_deg': 400}, {'method': 'pod9'}):
            r = c.post('/api/fly/start', json={**base, 'launch': kotu}, headers=H)
            assert r.status_code == 422, (kotu, r.text)
        assert bridge.launch_dogrula({'method': 'pod8'})['loaded'] == 8 and bridge.LAUNCH_CEKIRDEK['handheld'] == 'handheld'
        r = c.post('/api/fly/start', json={**base, 'launch': {'method': 'handheld', 'aim_az_deg': 90, 'aim_el_deg': 30}}, headers=H)
        assert r.status_code == 201, r.text
        f = r.json()
        s = bridge.oturum(f['sim_id'])
        assert s.launch['method'] == 'handheld' and s.launch['aim_az_deg'] == 90.0 and s.launch['aim_el_deg'] == 30.0, s.launch
        st = c.get(f"/api/fly/{f['flight_id']}").json()
        assert st['launch']['method'] == 'handheld' and st['session']['launch']['method'] == 'handheld', st['launch']
        with sqlite3.connect(config.DB_PATH) as cc:
            assert cc.execute('SELECT launch FROM flights WHERE id = ?', (f['flight_id'],)).fetchone()[0] == 'handheld'
        son = time.time() + 20
        while time.time() < son and s.state != 'HAZIR':
            time.sleep(0.1)
        with c.websocket_connect(f"/ws/fly/{f['sim_id']}", headers={**H, 'Cookie': f"smsid={c.cookies.get('smsid')}"}) as ws:
            json.loads(ws.receive_text())
            ws.send_json({'t': 'cmd', 'rid': 'a1', 'name': 'takeoff', 'params': {'alt': 40, 'aim': {'az_deg': 120, 'el_deg': 40}}})
            fazlar, son = [], time.time() + 15
            while time.time() < son and (not fazlar or fazlar[-1] != 'released'):
                m = json.loads(ws.receive_text())
                if m.get('t') == 'launch':
                    fazlar.append(m['phase'])
                    if m['phase'] == 'launch':
                        assert m['method'] == 'handheld' and m['aim_az_deg'] == 120.0 and m['aim_el_deg'] == 40.0, m
            assert fazlar == ['armed', 'launch', 'released'], fazlar
        assert s.launch['aim_az_deg'] == 120.0
        r = c.post(f"/api/fly/{f['flight_id']}/stop", json={}, headers=H); assert r.status_code == 200, r.text
        r = c.post('/api/fly/start', json={**base, 'launch': {'method': 'pod8', 'loaded': 5}}, headers=H)
        assert r.status_code == 201, r.text
        f = r.json(); s = bridge.oturum(f['sim_id'])
        assert s.launch['method'] == 'pod8' and s.launch['loaded'] == 5, s.launch
        r = c.post(f"/api/fly/{f['flight_id']}/stop", json={}, headers=H); assert r.status_code == 200, r.text
    print('SIMUMAV INTERCEPTOR + hedefler + fırlatıcı (§27) testleri geçti.')


if __name__ == '__main__':
    main()
