"""SIMUMAV gerçek SITL kalkış paritesi (docs/simumav.md §5 Uç; HEPGO docs/ucus-simulatoru.md §13/§14): ArduCopter ve ArduPlane ile
panelin "Kalkış" komutu ARM düğmesine basılmadan armed + havada olmalı.

  • Çok rotorlu: panel hub yolu `cmd takeoff{alt_rel_m, kontrol}` → drone_hub _takeoff_flow (GUIDED → ARM → NAV_TAKEOFF; ARM reddinde
    pre-arm/EKF beklemesi ve yeniden deneme) → 60 sn içinde armed ve alt_rel ≥ 3 m.
  • Sabit kanat (tekerlekli): panel sim yolu `cmd takeoff{alt}` → flightsim _kalkis_dizisi (TAKEOFF + ARM) → `launch` aşamaları armed → launch → released,
    armed ve alt_rel ≥ 3 m.
  • Sanal kumanda: WS `rc{ch}` → SITL RC_CHANNELS_OVERRIDE → tele.rc kanalları değişir; 8×0 → serbest.

Çalıştırma: HEPGO_SITL_DIR=/opt/hepgo/sitl/bin CAYMAZ_FORCE_SECURE_COOKIE=0 ./.venv/bin/python -m tests.test_simumav_sitl
"""
import faulthandler
import json
import os
import sys
import tempfile
import time

faulthandler.dump_traceback_later(600, exit=True)
D = tempfile.mkdtemp(prefix='simumav-sitl-')
os.environ.update(SIMUMAV_DATA_DIR=D, SIMUMAV_DEV_LOGIN='1', HEPGO_SITL='1', SIMUMAV_UDP_BASE='24850', SIMUMAV_MAX_FLIGHTS='2', SIMUMAV_MP_PORT_BASE='25700',
                  SIMUMAV_MP_PORT_COUNT='40', SIMUMAV_SECURE_COOKIE='0', SIMUMAV_ENV_FILE=os.path.join(D, 'yok.env'), SIMUMAV_MT_INTERNAL='http://127.0.0.1:1', GOOGLE_MAPS_API_KEY='')
os.environ.setdefault('HEPGO_SITL_DIR', '/opt/hepgo/sitl/bin')
for k in [k for k in sys.modules if k == 'app' or k.startswith('app.')]:
    del sys.modules[k]

from fastapi.testclient import TestClient  # noqa: E402

import app.simumav.main as smain  # noqa: E402
from app import flightsim  # noqa: E402

ORIGIN = 'http://127.0.0.1:8600'
H = {'Origin': ORIGIN}
VERBOSE = os.environ.get('SITL_VERBOSE') == '1'


class Akis:
    """WS mesaj pompası: tele/launch/console/res/state toplanır."""

    def __init__(self, ws, sid):
        self.ws, self.sid = ws, sid
        self.tele, self.launch, self.console, self.res, self.state = None, [], [], {}, None

    def pump(self, sec, until=None):
        end = time.time() + sec
        while time.time() < end:
            m = json.loads(self.ws.receive_text())
            t = m.get('t')
            if t == 'tele':
                self.tele = m
            elif t == 'launch':
                self.launch.append(m.get('phase'))
            elif t in ('console', 'event'):
                self.console.append(m.get('text') or '')
                if VERBOSE:
                    print('   ', t, m.get('text'))
            elif t == 'res':
                self.res[m.get('rid')] = m
            elif t == 'state':
                self.state = m.get('state')
            elif t == 'hello':
                self.state = (m.get('session') or {}).get('state')
            if until and until():
                return True
        return False

    def hazir(self, sec=120):
        assert self.pump(sec, lambda: self.state == 'HAZIR'), f'SITL HAZIR olmadı: {self.state}'


def kalkis_kopter(c, ck, sid, fid):
    with c.websocket_connect(f'/ws/fly/{sid}', headers=ck) as ws:
        a = Akis(ws, sid)
        a.hazir()
        bid = -(9000 + sid)
        t0 = time.time()
        # panel akışı birebir: kontrol listesi onaylandı → hub takeoff{alt_rel_m, kontrol}; ARM düğmesine BASILMAZ
        kontrol = [{'sira': i, 'anahtar': k, 'soru': k, 'grup': 'sim', 'cevap': True, 'zorunlu': True, 'kaynak': 'flightsim_panel'} for i, k in enumerate(('alan', 'batarya', 'gps', 'mod'))]
        ws.send_json({'t': 'cmd', 'rid': 'to1', 'bridge_id': bid, 'sysid': 1, 'name': 'takeoff', 'params': {'alt_rel_m': 20, 'kontrol': kontrol}})
        okdu = a.pump(90, lambda: a.tele is not None and a.tele.get('armed') and (a.tele.get('alt_rel') or 0) >= 3)
        sure = time.time() - t0
        print(f'  kopter: armed={a.tele and a.tele.get("armed")} alt={a.tele and a.tele.get("alt_rel")} mode={a.tele and a.tele.get("mode")} süre={sure:.1f} sn res={a.res.get("to1")}')
        if not okdu:
            print('  konsol:', *a.console[-12:], sep='\n    ')
        assert okdu, 'kopter kalkış: ARM düğmesine basılmadan armed+havada olmadı'
        assert a.res.get('to1', {}).get('ok') is True, a.res.get('to1')
        # sanal kumanda: rc override → tele.rc; 8×0 → serbest
        ws.send_json({'t': 'rc', 'ch': [1500, 1500, 1500, 1500, 1800, 0, 0, 0]})
        assert a.pump(8, lambda: a.tele and a.tele.get('rc') and a.tele['rc'][4] == 1800), f"rc override tele'ye yansımadı: {a.tele and a.tele.get('rc')}"
        ws.send_json({'t': 'rc', 'ch': [0] * 8})
        a.pump(1.5)
        print('  rc override SITL\'e ulaştı, ch5 =', a.tele['rc'][4])
    assert c.post(f'/api/fly/{fid}/stop', json={}, headers=H).status_code == 200


def kalkis_ucak(c, ck, sid, fid):
    with c.websocket_connect(f'/ws/fly/{sid}', headers=ck) as ws:
        a = Akis(ws, sid)
        a.hazir()
        t0 = time.time()
        ws.send_json({'t': 'cmd', 'rid': 'to2', 'name': 'takeoff', 'params': {'alt': 60}})   # panel: launch varsa cmdSim('takeoff',{alt}) → sim yolu
        okdu = a.pump(90, lambda: a.tele is not None and a.tele.get('armed') and (a.tele.get('alt_rel') or 0) >= 3)
        sure = time.time() - t0
        print(f'  uçak: armed={a.tele and a.tele.get("armed")} alt={a.tele and a.tele.get("alt_rel")} mode={a.tele and a.tele.get("mode")} launch={a.launch} süre={sure:.1f} sn res={a.res.get("to2")}')
        if not okdu:
            print('  konsol:', *a.console[-12:], sep='\n    ')
        assert okdu, 'uçak kalkış: ARM düğmesine basılmadan armed+havada olmadı'
        assert a.launch[:2] == ['armed', 'launch'] and 'released' in a.launch, a.launch
    assert c.post(f'/api/fly/{fid}/stop', json={}, headers=H).status_code == 200


def main():
    with TestClient(smain.app, base_url=ORIGIN) as c:
        assert c.post('/api/session', json={'dev_user': 'ali'}, headers=H).status_code == 200
        ck = {'Cookie': f"smsid={c.cookies['smsid']}"}
        kop = c.post('/api/hangar', json={'name': 'Kopter', 'type': 'multirotor', 'model_key': 'builtin:quad'}, headers=H); assert kop.status_code == 201, kop.text
        uck = c.post('/api/hangar', json={'name': 'Uçak', 'type': 'plane', 'model_key': 'builtin:delta'}, headers=H); assert uck.status_code == 201, uck.text
        pid = c.post('/api/crew', json={'name': 'Ayşe', 'character': 'p04'}, headers=H).json()['id']
        tr = c.post('/api/tracks', json={'name': 'Pist', 'lat': 40.10, 'lon': 33.40, 'radius_m': 1500, 'world_mode': 'procedural', 'world': {'seed': 7, 'runway': True}}, headers=H)
        assert tr.status_code == 201, tr.text
        tid = tr.json()['id']
        for ad, drone, launch, fn in (('ArduCopter', kop.json(), 'wheels', kalkis_kopter), ('ArduPlane', uck.json(), 'wheels', kalkis_ucak)):
            print(f'{ad}: SITL başlatılıyor…')
            r = c.post('/api/fly/start', json={'drone_id': drone['id'], 'pilot_id': pid, 'track_id': tid, 'launch': launch, 'record': {'bin': False}}, headers=H)
            assert r.status_code == 201, r.text
            f = r.json()
            try:
                fn(c, ck, f['sim_id'], f['flight_id'])
            finally:
                if f['sim_id'] in flightsim.MANAGER.sessions:
                    c.post(f"/api/fly/{f['flight_id']}/stop", json={}, headers=H)
    print('test_simumav_sitl: TAMAM')


if __name__ == '__main__':
    main()
