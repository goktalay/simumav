"""SIMUMAV yer kontrol sahası + "Yer kontrolünü koru" (HEPGO §26; docs/simumav.md §12) testleri.

Kapsam: fly/start `site` / `defend` katı doğrulaması (422: tip zorlaması, bilinmeyen alan, menzil sınırları, INTERCEPTOR dışı dron), Görevler modülünde
kind='defend' (plan.defend doğrulaması, tohum kayda sabitlenir, rota yok; kötü plan 422), defend görevi + saha ile uçuş → çekirdek oturumda saha/görev
(tohum görevden), başlatma yanıtında saha yerleşimi, snapshot, GET /api/fly/{id} oturumu, WS hello, WS `defend next` (uçmamış → ücretsiz), dalga olayı,
stop → flights.summary.defend + site; meta mission_kinds.

Çalıştırma: ./.venv/bin/python -m tests.test_simumav_gcs
"""
import json
import os
import sys
import tempfile
import time

D = tempfile.mkdtemp(prefix='simumav-gcs-')
os.environ.update(SIMUMAV_DATA_DIR=D, SIMUMAV_DEV_LOGIN='1', HEPGO_SITL='0', SIMUMAV_UDP_BASE='25150', SIMUMAV_MAX_FLIGHTS='2', SIMUMAV_MP_PORT_BASE='26800',
                  SIMUMAV_MP_PORT_COUNT='40', SIMUMAV_SECURE_COOKIE='0', SIMUMAV_ENV_FILE=os.path.join(D, 'yok.env'), SIMUMAV_MAX_SPEEDUP='8',
                  SIMUMAV_MT_INTERNAL='http://127.0.0.1:1', GOOGLE_MAPS_API_KEY='')
for k in [k for k in sys.modules if k == 'app' or k.startswith('app.')]:
    del sys.modules[k]

from fastapi.testclient import TestClient  # noqa: E402

import app.simumav.main as smain  # noqa: E402
from app import flightsim_gcs as GC  # noqa: E402
from app.simumav import bridge, config  # noqa: E402

ORIGIN = 'http://127.0.0.1:8600'
H = {'Origin': ORIGIN}


def ws_bekle(ws, kosul, sn=5.0):
    bitis = time.time() + sn
    while time.time() < bitis:
        m = json.loads(ws.receive_text())
        if kosul(m):
            return m
    return None


def main():
    config.RATE['write'] = (100000, 60)
    config.RATE['read'] = (100000, 60)
    with TestClient(smain.app, base_url=ORIGIN) as c:
        r = c.post('/api/session', json={'dev_user': 'gcs'}, headers=H); assert r.status_code == 200, r.text
        assert 'defend' in c.get('/api/meta').json()['mission_kinds']
        ic = c.post('/api/hangar', json={'name': 'Av', 'type': 'interceptor', 'model_key': 'glb:icept_x4'}, headers=H).json()
        kp = c.post('/api/hangar', json={'name': 'Kopter', 'type': 'multirotor', 'model_key': 'glb:iris'}, headers=H).json()
        tr = c.get('/api/tracks').json()['tracks'][0]
        pid = c.get('/api/crew').json()['pilots'][0]['id']
        base = {'drone_id': ic['id'], 'pilot_id': pid, 'track_id': tr['id'], 'launch': 'wheels', 'record': {'bin': False}}
        # ---- katı doğrulama (dünyaya açık)
        for kotu in ({'site': {'radar': 'true'}}, {'site': {'radar': 1}}, {'site': {'radar': True, 'radar_km': 99}}, {'site': {'eo': True, 'eo_km': 0.1}},
                     {'site': {'radar': True, 'kötü': 1}}, {'site': {'radar_km': '20'}}, {'defend': {'waves': 11}}, {'defend': {'seed': -1}}, {'defend': {'difficulty': 'x'}},
                     {'defend': {'interceptors': True}}, {'defend': {'evil': 1}}, {'defend': {'radius_m': 500}}):
            r = c.post('/api/fly/start', json={**base, **kotu}, headers=H)
            assert r.status_code == 422, (kotu, r.status_code, r.text[:200])
        r = c.post('/api/fly/start', json={**base, 'drone_id': kp['id'], 'defend': {'seed': 1}}, headers=H)
        assert r.status_code == 422 and 'INTERCEPTOR' in r.text, r.text[:300]
        # ---- Görevler: kind='defend'
        r = c.post('/api/missions', json={'track_id': tr['id'], 'name': 'Savunma', 'kind': 'defend', 'plan': {'kind': 'defend', 'defend': {'waves': 2, 'difficulty': 'hard', 'prep_s': 15}}}, headers=H)
        assert r.status_code == 201, r.text
        m = r.json()
        assert m['kind'] == 'defend' and m['plan']['defend']['waves'] == 2 and m['plan']['defend']['difficulty'] == 'hard' and 1 <= m['plan']['defend']['seed'] <= 2 ** 31 - 1, m['plan']
        seed = m['plan']['defend']['seed']
        for kotu in ({'kind': 'defend', 'defend': {'waves': 11}}, {'kind': 'defend', 'defend': {'seed': 'x'}}, {'kind': 'defend', 'route': {'points': []}, 'extra': 1}):
            r = c.post('/api/missions', json={'track_id': tr['id'], 'name': 'Kötü', 'kind': 'defend', 'plan': kotu}, headers=H)
            assert r.status_code == 422, (kotu, r.text[:200])
        r = c.put(f"/api/missions/{m['id']}", json={'plan': {'kind': 'defend', 'defend': {'waves': 2, 'difficulty': 'hard', 'prep_s': 15, 'seed': seed}}}, headers=H)
        assert r.status_code == 200 and r.json()['plan']['defend']['seed'] == seed, r.text[:200]
        # ---- uçuş: defend görevi + saha (radar 12 km, EO kapalı; istasyon görev için açılır)
        r = c.post('/api/fly/start', json={**base, 'mission_id': m['id'], 'site': {'station': False, 'radar': True, 'radar_km': 12, 'eo': False}, 'defend': {'seed': 999}}, headers=H)
        assert r.status_code == 201, r.text
        f = r.json()
        s = bridge.oturum(f['sim_id'])
        assert s.savunma is not None and s.savunma.cfg['seed'] == seed and s.savunma.cfg['waves'] == 2 and s.savunma.cfg['difficulty'] == 'hard', s.savunma.cfg   # görev kaydı önceliklidir
        assert s.gcs == {'station': True, 'radar': True, 'radar_km': 12.0, 'eo': False, 'eo_km': 5.0}, s.gcs
        assert f['site']['layout']['tower'] == GC.yerlesim(s.world.get('runway_heading', 0))['tower'] and f['site']['station'] is True, f['site']
        st = c.get(f"/api/fly/{f['flight_id']}").json()
        assert st['snapshot']['site']['radar_km'] == 12.0 and st['snapshot']['defend']['seed'] == seed and st['session']['site']['layout'] and len(st['session']['defend']['plan']) == 3 + 4, st['snapshot'].get('defend')
        son = time.time() + 20
        while time.time() < son and s.state != 'HAZIR':
            time.sleep(0.1)
        with c.websocket_connect(f"/ws/fly/{f['sim_id']}", headers={**H, 'Cookie': f"smsid={c.cookies.get('smsid')}"}) as ws:
            hl = json.loads(ws.receive_text())
            assert hl['t'] == 'hello' and hl['session']['site']['radar_km'] == 12.0 and hl['session']['defend']['config']['seed'] == seed, str(hl)[:300]
            ws.send_text(json.dumps({'t': 'cmd', 'rid': 'n1', 'name': 'defend', 'params': {'action': 'next'}}))
            res = ws_bekle(ws, lambda x: x.get('t') == 'res' and x.get('rid') == 'n1', 8)
            assert res and res.get('ok') and res.get('spent') is False and res['defend']['icept']['used'] == 1, res
            ws.send_text(json.dumps({'t': 'cmd', 'rid': 'n2', 'name': 'defend', 'params': {'action': 'yok'}}))
            res = ws_bekle(ws, lambda x: x.get('t') == 'res' and x.get('rid') == 'n2', 8)
            assert res and not res.get('ok'), res
        son = time.time() + 20
        while time.time() < son and s.state != 'HAZIR':
            time.sleep(0.1)
        with c.websocket_connect(f"/ws/fly/{f['sim_id']}", headers={**H, 'Cookie': f"smsid={c.cookies.get('smsid')}"}) as ws:
            json.loads(ws.receive_text())
            ws.send_text(json.dumps({'t': 'cmd', 'rid': 's1', 'name': 'speed', 'params': {'factor': 8}}))
            w = ws_bekle(ws, lambda x: x.get('t') == 'defend' and x.get('kind') == 'wave', 15)
            assert w and w['wave'] == 1 and w['count'] == 3 and w['state']['waves'] == 2, w
        r = c.post(f"/api/fly/{f['flight_id']}/stop", json={}, headers=H); assert r.status_code == 200, r.text
        sm = r.json()['flight']['summary']
        assert sm['defend']['config']['seed'] == seed and sm['defend']['spawned'] >= 1 and 'score' in sm['defend'] and 'rank' in sm['defend'] and sm['site']['radar_km'] == 12.0, sm.get('defend')
        # ---- sihirbazdan görev (görev kaydı yok) + yalnız EO
        r = c.post('/api/fly/start', json={**base, 'site': {'eo': True, 'eo_km': 3}, 'defend': {'seed': 77, 'waves': 1}}, headers=H)
        assert r.status_code == 201, r.text
        s2 = bridge.oturum(r.json()['sim_id'])
        assert s2.savunma.cfg['seed'] == 77 and s2.gcs['station'] is True and s2.gcs['eo_km'] == 3.0 and s2.gcs['radar'] is False
        assert c.post(f"/api/fly/{r.json()['flight_id']}/stop", json={}, headers=H).status_code == 200
    print('SIMUMAV yer kontrol sahası + "Yer kontrolünü koru" testleri geçti.')


if __name__ == '__main__':
    main()
