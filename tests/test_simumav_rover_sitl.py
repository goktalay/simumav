"""SIMUMAV kara aracı — GERÇEK ArduRover SITL ile kısa sürüş (docs/simumav.md §15; HEPGO §31).

Her sürüş biçimi için (Ackermann `rover` / paletli `rover-skid`): fly/start → SITL HAZIR + kalp atışı (kip MANUAL) → takeoff reddi → hub `arm`
(pre-arm/EKF oturana dek yeniden denenir) → WS `rc` (roverRcChannels biçimi: RC1 direksiyon, RC3 gaz) → yer hızı > 1,5 m/s, irtifa ~0, yön değişir →
`mode HOLD` → hız düşer → stop (SITL kapanır).

Çalıştırma: HEPGO_SITL_DIR=/opt/hepgo/sitl/bin ./.venv/bin/python -m tests.test_simumav_rover_sitl
"""
import faulthandler
import json
import os
import sys
import tempfile
import time

faulthandler.dump_traceback_later(900, exit=True)
D = tempfile.mkdtemp(prefix='simumav-rover-sitl-')
os.environ.update(SIMUMAV_DATA_DIR=D, SIMUMAV_DEV_LOGIN='1', HEPGO_SITL='1', SIMUMAV_UDP_BASE='25350', SIMUMAV_MAX_FLIGHTS='2', SIMUMAV_MP_PORT_BASE='26900',
                  SIMUMAV_MP_PORT_COUNT='40', SIMUMAV_SECURE_COOKIE='0', SIMUMAV_ENV_FILE=os.path.join(D, 'yok.env'), SIMUMAV_MT_INTERNAL='http://127.0.0.1:1', GOOGLE_MAPS_API_KEY='')
os.environ.setdefault('HEPGO_SITL_DIR', '/opt/hepgo/sitl/bin')
for k in [k for k in sys.modules if k == 'app' or k.startswith('app.')]:
    del sys.modules[k]

from fastapi.testclient import TestClient  # noqa: E402

import app.simumav.main as smain  # noqa: E402
from app import flightsim  # noqa: E402
from app.simumav import bridge  # noqa: E402

ORIGIN = 'http://127.0.0.1:8600'
H = {'Origin': ORIGIN}
VERBOSE = os.environ.get('SITL_VERBOSE') == '1'


class Akis:
    def __init__(self, ws):
        self.ws, self.tele, self.res, self.state, self.console = ws, None, {}, None, []

    def pump(self, sec, until=None, every=None):
        end, nxt = time.time() + sec, 0.0
        while time.time() < end:
            if every and time.time() >= nxt:
                every(); nxt = time.time() + 0.1
            m = json.loads(self.ws.receive_text())
            t = m.get('t')
            if t == 'tele':
                self.tele = m
            elif t == 'res':
                self.res[m.get('rid')] = m
            elif t == 'state':
                self.state = m.get('state')
            elif t == 'hello':
                self.state = (m.get('session') or {}).get('state')
            elif t in ('console', 'event'):
                self.console.append(m.get('text') or '')
                if VERBOSE:
                    print('   ', t, m.get('text'))
            if until and until():
                return True
        return bool(until and until())


def surus(c, ck, sid, fid, drive):
    s = bridge.oturum(sid)
    assert s._sitl_modeli() == ('rover-skid' if drive == 'skid' else 'rover'), s._sitl_modeli()
    with c.websocket_connect(f'/ws/fly/{sid}', headers=ck) as ws:
        a = Akis(ws)
        assert a.pump(150, lambda: a.state == 'HAZIR'), f'SITL HAZIR olmadı: {a.state}'
        assert a.pump(60, lambda: a.tele is not None and a.tele.get('mode') == 'MANUAL'), f"kip: {a.tele and a.tele.get('mode')}"
        ws.send_json({'t': 'cmd', 'rid': 'to', 'name': 'takeoff', 'params': {'alt': 20}})
        assert a.pump(10, lambda: 'to' in a.res) and a.res['to']['ok'] is False, a.res.get('to')
        bid = -(9000 + sid)
        t0, n = time.time(), 0
        while time.time() - t0 < 120 and not (a.tele and a.tele.get('armed')):
            n += 1
            ws.send_json({'t': 'cmd', 'rid': f'arm{n}', 'bridge_id': bid, 'sysid': 1, 'name': 'arm', 'params': {}})
            a.pump(4, lambda: bool(a.tele and a.tele.get('armed')))
        print(f'  {drive}: armed={a.tele.get("armed")} ({n} deneme, {time.time() - t0:.1f} sn) son yanıt={a.res.get(f"arm{n}")}')
        if not a.tele.get('armed'):
            print('  konsol:', *a.console[-12:], sep='\n    ')
        assert a.tele.get('armed'), 'ARM olmadı'
        hdg0 = float(a.tele.get('heading') or 0)
        gaz = lambda: ws.send_json({'t': 'rc', 'ch': [1500, 0, 1950, 0, 1500, 0, 0, 0]})   # noqa: E731 — düz ileri, tam gaz
        hiz_esik = 1.5
        ok = a.pump(25, lambda: float(a.tele.get('groundspeed') or 0) > hiz_esik, every=gaz)
        gs, alt = float(a.tele.get('groundspeed') or 0), float(a.tele.get('alt_rel') or 0)
        print(f'  {drive}: ileri gaz → yer hızı {gs:.2f} m/s, alt_rel {alt:.2f} m, kip {a.tele.get("mode")}, rc {a.tele.get("rc")}')
        assert ok, f'araç hızlanmadı ({gs:.2f} m/s)'
        assert abs(alt) < 3.0, alt
        don = lambda: ws.send_json({'t': 'rc', 'ch': [1950, 0, 1800, 0, 1500, 0, 0, 0]})   # noqa: E731 — sağa direksiyon
        fark = lambda: abs(((float(a.tele.get('heading') or 0) - hdg0 + 540) % 360) - 180)   # noqa: E731
        ok = a.pump(20, lambda: fark() > 30, every=don)
        print(f'  {drive}: sağa direksiyon → yön farkı {fark():.0f}°')
        assert ok, 'yön değişmedi'
        ws.send_json({'t': 'rc', 'ch': [0] * 8})
        ws.send_json({'t': 'cmd', 'rid': 'hold', 'bridge_id': bid, 'sysid': 1, 'name': 'mode', 'params': {'mode': 'HOLD'}})
        ok = a.pump(25, lambda: a.tele.get('mode') == 'HOLD' and float(a.tele.get('groundspeed') or 0) < 0.5)
        print(f'  {drive}: HOLD → kip {a.tele.get("mode")}, yer hızı {float(a.tele.get("groundspeed") or 0):.2f} m/s')
        assert ok, 'HOLD ile durmadı'
    r = c.post(f'/api/fly/{fid}/stop', json={}, headers=H); assert r.status_code == 200, r.text


def main():
    with TestClient(smain.app, base_url=ORIGIN) as c:
        assert c.post('/api/session', json={'dev_user': 'surucu'}, headers=H).status_code == 200
        ck = {'Cookie': f"smsid={c.cookies['smsid']}"}
        pid = c.post('/api/crew', json={'name': 'Sürücü', 'character': 'p04'}, headers=H).json()['id']
        tr = c.post('/api/tracks', json={'name': 'Saha', 'lat': 40.10, 'lon': 33.40, 'radius_m': 1500, 'world_mode': 'procedural', 'world': {'seed': 7}}, headers=H)
        assert tr.status_code == 201, tr.text
        tid = tr.json()['id']
        for model, drive in (('glb:rover_4x4', None), ('glb:rover_ugv', None)):
            d = c.post('/api/hangar', json={'name': model[4:], 'type': 'rover', 'model_key': model}, headers=H); assert d.status_code == 201, d.text
            d = d.json()
            print(f'ArduRover ({d["drive"]}): SITL başlatılıyor…')
            r = c.post('/api/fly/start', json={'drone_id': d['id'], 'pilot_id': pid, 'track_id': tid, 'record': {'bin': False}, **({'drive': drive} if drive else {})}, headers=H)
            assert r.status_code == 201, r.text
            f = r.json()
            try:
                surus(c, ck, f['sim_id'], f['flight_id'], f['drive'])
            finally:
                if f['sim_id'] in flightsim.MANAGER.sessions:
                    c.post(f"/api/fly/{f['flight_id']}/stop", json={}, headers=H)
    print('test_simumav_rover_sitl: TAMAM')


if __name__ == '__main__':
    main()
