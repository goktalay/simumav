"""SIMUMAV KARA ARACI (HEPGO §31; docs/simumav.md §15) testleri — sahte kip (HEPGO_SITL=0).

Kapsam: tip eşlemesi (rover → çekirdek rover), katalog (3 GLB; dahili rover modelleri çift listelenmez; pervane yok; sürüş biçimi), hedef kataloğunda
kara aracı yok, hangar kaydı (drive alanı, düzen yok, elektrikli güç varsayılanı), fly/start `drive` (eksik → modelin; geçersiz → 422; diğer tiplerde
yok sayılır), kalkış yöntemi yok sayılır (flights.launch 'wheels'), snapshot/start yanıtında drive, WS hello (ground/drive), takeoff reddi, ARM + RC ile
sürüş (sahte kinematik hız kazanır, irtifa 0), land → HOLD, stop → özet.

Çalıştırma: ./.venv/bin/python -m tests.test_simumav_rover
"""
import json
import os
import sqlite3
import sys
import tempfile
import time

D = tempfile.mkdtemp(prefix='simumav-rover-')
os.environ.update(SIMUMAV_DATA_DIR=D, SIMUMAV_DEV_LOGIN='1', HEPGO_SITL='0', SIMUMAV_UDP_BASE='25150', SIMUMAV_MAX_FLIGHTS='2', SIMUMAV_MP_PORT_BASE='26800',
                  SIMUMAV_MP_PORT_COUNT='40', SIMUMAV_SECURE_COOKIE='0', SIMUMAV_ENV_FILE=os.path.join(D, 'yok.env'), SIMUMAV_MAX_SPEEDUP='4',
                  SIMUMAV_MT_INTERNAL='http://127.0.0.1:1', GOOGLE_MAPS_API_KEY='')
for k in [k for k in sys.modules if k == 'app' or k.startswith('app.')]:
    del sys.modules[k]

from fastapi.testclient import TestClient  # noqa: E402

import app.simumav.main as smain  # noqa: E402
from app.simumav import bridge, config  # noqa: E402

ORIGIN = 'http://127.0.0.1:8600'
H = {'Origin': ORIGIN}


def bekle(kosul, sure=20.0):
    son = time.time() + sure
    while time.time() < son:
        if kosul():
            return True
        time.sleep(0.1)
    return kosul()


def ws_yanit(ws, rid, sure=15.0):
    son = time.time() + sure
    while time.time() < son:
        m = json.loads(ws.receive_text())
        if m.get('t') == 'res' and m.get('rid') == rid:
            return m
    raise AssertionError(f'yanıt yok: {rid}')


def main():
    config.RATE['write'] = (100000, 60)
    config.RATE['read'] = (100000, 60)
    # ---- saf: eşleme / katalog / doğrulama
    assert bridge.TIP_ESLEME['rover'] == 'rover' and 'rover' in bridge.TYPES and bridge.TYPE_LABELS['rover'] == 'Kara aracı'
    assert bridge.VARSAYILAN_MODEL['rover'] == 'glb:rover_4x4'
    assert {bridge.MODEL_ESLEME[k] for k in ('glb:rover_4x4', 'glb:rover_ugv', 'glb:rover_bot')} == {'builtin:rover_4x4', 'builtin:rover_ugv', 'builtin:rover_bot'}
    assert bridge.drive_dogrula('rover', None, 'glb:rover_ugv') == 'skid' and bridge.drive_dogrula('rover', None, 'glb:rover_4x4') == 'ackermann'
    assert bridge.drive_dogrula('rover', 'skid', 'glb:rover_4x4') == 'skid' and bridge.drive_dogrula('plane', 'skid', 'glb:rc_cessna') is None
    assert bridge.model_drive('rover', 'builtin:rover_bot') == 'skid' and bridge.model_drive('multirotor', 'glb:iris') is None
    try:
        bridge.drive_dogrula('rover', 'tank'); raise AssertionError('tank kabul edildi')
    except bridge.BridgeHata as e:
        assert e.status == 422
    assert bridge.airframe_dogrula('rover', None, 'glb:rover_4x4') is None
    assert not any(m.get('type') == 'rover' or 'rover' in m['key'] for m in bridge.hedef_katalogu()), 'kara aracı hava hedefi olmamalı'
    with TestClient(smain.app, base_url=ORIGIN) as c:
        r = c.post('/api/session', json={'dev_user': 'rover'}, headers=H); assert r.status_code == 200, r.text
        assert 'rover' in c.get('/api/meta').json()['types']
        cat = c.get('/api/hangar/catalog').json()
        rv = next(t for t in cat['types'] if t['key'] == 'rover')
        assert rv['label'] == 'Kara aracı' and [m['key'] for m in rv['models']] == ['glb:rover_4x4', 'glb:rover_ugv', 'glb:rover_bot'], rv['models']
        assert all(m['has_prop'] is False and m['glb'].endswith(f"{m['key'][4:]}.glb") and m['power']['engine'] == 'electric' for m in rv['models'])
        assert [m['drive'] for m in rv['models']] == ['ackermann', 'skid', 'skid']
        assert all(c.get(f'/static/simumav/models/{f}.glb').status_code == 200 for f in ('rover_4x4', 'rover_ugv', 'rover_bot'))
        assert not any(m['key'].startswith('glb:rover') for m in c.get('/api/fly/targets').json()['models'])
        # ---- hangar
        r = c.post('/api/hangar', json={'name': 'UGV-1', 'type': 'rover', 'model_key': 'glb:rover_ugv', 'airframe': 'classic'}, headers=H); assert r.status_code == 201, r.text
        d = r.json()
        assert d['drive'] == 'skid' and d['airframe'] is None and d['has_prop'] is False and d['preview'] == '/static/simumav/models/rover_ugv.glb', d
        assert d['power']['engine'] == 'electric' and d['power']['max_speed_ms'] is None and d['power']['elec_cells'] == 6
        assert c.post('/api/hangar', json={'name': 'X', 'type': 'rover', 'model_key': 'glb:iris'}, headers=H).status_code == 422
        tid = c.get('/api/tracks').json()['tracks'][0]['id']
        pid = c.get('/api/crew').json()['pilots'][0]['id']
        base = {'drone_id': d['id'], 'pilot_id': pid, 'track_id': tid, 'record': {'bin': False}}
        # ---- fly/start: geçersiz drive → 422; kalkış yöntemi yok sayılır; eksik drive → modelin (skid)
        r = c.post('/api/fly/start', json={**base, 'drive': 'tank'}, headers=H); assert r.status_code == 422, r.text
        r = c.post('/api/fly/start', json={**base, 'launch': {'method': 'pod4', 'loaded': 4}}, headers=H); assert r.status_code == 201, r.text
        f = r.json(); s = bridge.oturum(f['sim_id'])
        assert f['drive'] == 'skid' and s.type == 'rover' and s.drive == 'skid' and s._sitl_modeli() == 'rover-skid', (f.get('drive'), s.drive)
        with sqlite3.connect(config.DB_PATH) as cc:
            assert cc.execute('SELECT launch FROM flights WHERE id = ?', (f['flight_id'],)).fetchone()[0] == 'wheels'
        st = c.get(f"/api/fly/{f['flight_id']}").json()
        assert st['snapshot']['drone']['drive'] == 'skid' and st['drone']['drive'] == 'skid' and st['session']['ground'] is True and st['session']['drive'] == 'skid'
        assert st['launch']['method'] == 'wheels' and 'loaded' not in st['launch'], st['launch']
        assert bekle(lambda: s.state == 'HAZIR')
        with c.websocket_connect(f"/ws/fly/{f['sim_id']}", headers={**H, 'Cookie': f"smsid={c.cookies.get('smsid')}"}) as ws:
            hl = json.loads(ws.receive_text())
            assert hl['t'] == 'hello' and hl['session']['ground'] is True and hl['session']['drive'] == 'skid' and hl['session']['type'] == 'rover', str(hl)[:300]
            ws.send_json({'t': 'cmd', 'rid': 't1', 'name': 'takeoff', 'params': {'alt': 20}})
            m = ws_yanit(ws, 't1'); assert m['ok'] is False and 'kalkış' in m['error'].lower(), m
            ws.send_json({'t': 'cmd', 'rid': 'c1', 'name': 'motor_cut', 'params': {'on': True}})
            m = ws_yanit(ws, 'c1'); assert m['ok'] is False, m
            ws.send_json({'t': 'cmd', 'rid': 'a1', 'name': 'arm', 'params': {}})
            m = ws_yanit(ws, 'a1'); assert m['ok'] is True, m
            # sanal kumanda (roverRcChannels biçimi): RC1 direksiyon, RC3 gaz ileri; RC2/RC4 0 = dokunma
            hiz, irt = 0.0, 0.0
            son = time.time() + 8
            while time.time() < son and hiz < 1.0:
                ws.send_json({'t': 'rc', 'ch': [1600, 0, 1900, 0, 1500, 0, 0, 0]})
                m = json.loads(ws.receive_text())
                if m.get('t') == 'tele':
                    hiz = max(hiz, float(m.get('groundspeed') or 0)); irt = max(irt, abs(float(m.get('alt_rel') or 0)))
            assert hiz >= 1.0 and irt < 0.5, (hiz, irt)
            assert s.sahte.mode == 'MANUAL' and s.sahte.armed
            ws.send_json({'t': 'cmd', 'rid': 'l1', 'name': 'land', 'params': {}})
            m = ws_yanit(ws, 'l1'); assert m['ok'] is True, m
            assert bekle(lambda: s.sahte.mode == 'HOLD', 5), s.sahte.mode
            ws.send_json({'t': 'rc', 'ch': [0] * 8})
        r = c.post(f"/api/fly/{f['flight_id']}/stop", json={}, headers=H); assert r.status_code == 200, r.text
        # ---- seçilen sürüş biçimi modelinkini ezer (4×4 → skid; UGV → ackermann)
        r = c.post('/api/hangar', json={'name': 'K4', 'type': 'rover', 'model_key': 'glb:rover_4x4'}, headers=H); assert r.status_code == 201, r.text
        d4 = r.json(); assert d4['drive'] == 'ackermann'
        r = c.post('/api/fly/start', json={**base, 'drone_id': d4['id'], 'drive': 'skid'}, headers=H); assert r.status_code == 201, r.text
        f = r.json(); s = bridge.oturum(f['sim_id'])
        assert s.drive == 'skid' and f['drive'] == 'skid' and c.get(f"/api/fly/{f['flight_id']}").json()['snapshot']['drone']['drive'] == 'skid'
        assert c.post(f"/api/fly/{f['flight_id']}/stop", json={}, headers=H).status_code == 200
        r = c.post('/api/fly/start', json={**base, 'drive': 'ackermann'}, headers=H); assert r.status_code == 201, r.text
        f = r.json(); assert bridge.oturum(f['sim_id']).drive == 'ackermann' and bridge.oturum(f['sim_id'])._sitl_modeli() == 'rover'
        assert c.post(f"/api/fly/{f['flight_id']}/stop", json={}, headers=H).status_code == 200
        # ---- diğer tiplerde drive yok sayılır
        fpv = next(x for x in c.get('/api/hangar').json()['drones'] if x['type'] == 'fpv')
        assert fpv['drive'] is None
        r = c.post('/api/fly/start', json={**base, 'drone_id': fpv['id'], 'drive': 'skid'}, headers=H); assert r.status_code == 201, r.text
        f = r.json(); assert f['drive'] is None and bridge.oturum(f['sim_id']).drive is None
        assert c.post(f"/api/fly/{f['flight_id']}/stop", json={}, headers=H).status_code == 200
    print('SIMUMAV kara aracı (§15) testleri geçti.')


if __name__ == '__main__':
    main()
