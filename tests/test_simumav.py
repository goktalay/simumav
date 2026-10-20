"""SIMUMAV testleri (docs/simumav.md §4, §7): shim ile çekirdek yüklemesi, oturum (dev login), CSRF reddi, oran sınırı 429, hangar/crew/tracks/missions
CRUD + kota aşımı, parametre beyaz listesi reddi, parkur önizlemesi (ağsız sahte karo), fly/start sahte kipte (HEPGO_SITL=0) → flight kaydı + MP TCP
dinleyici IP kilidi (127.0.0.2'den ikinci bağlantı reddi), WS hello, stop → flights satırı, GET /fly/current + 409 flight_open gövdesi + yetim uçuş
(WS bağlanmayan uçuş ORPHAN_S sonra kapanır, audit fly_orphan), ops listesi / sahiplik 404, meta.

Çalıştırma: CAYMAZ_FORCE_SECURE_COOKIE=0 ./.venv/bin/python -m tests.test_simumav
"""
import io
import json
import os
import socket
import sys
import tempfile
import time

D = tempfile.mkdtemp(prefix='simumav-test-')
os.environ.update(SIMUMAV_DATA_DIR=D, SIMUMAV_DEV_LOGIN='1', HEPGO_SITL='0', SIMUMAV_UDP_BASE='24750', SIMUMAV_MAX_FLIGHTS='2', SIMUMAV_MP_PORT_BASE='25600',
                  SIMUMAV_MP_PORT_COUNT='40', SIMUMAV_SECURE_COOKIE='0', SIMUMAV_ENV_FILE=os.path.join(D, 'yok.env'), SIMUMAV_MP_IDLE_S='4',
                  SIMUMAV_MT_INTERNAL='http://127.0.0.1:1', GOOGLE_MAPS_API_KEY='', SIMUMAV_GA_ID='G-8946D4RPGK', SIMUMAV_ADS_ID='AW-18523043628')
for k in [k for k in sys.modules if k == 'app' or k.startswith('app.')]:   # temiz başlangıç: çekirdek shim ile yüklenmeli
    del sys.modules[k]

from fastapi.testclient import TestClient  # noqa: E402

import app.simumav.main as smain  # noqa: E402
from app import flightsim, sim_terrain  # noqa: E402
from app.simumav import bridge, config  # noqa: E402
from app.simumav.db import connect as sdb_connect  # noqa: E402

ORIGIN = 'http://127.0.0.1:8600'
H = {'Origin': ORIGIN}


def terrarium_png(taban=900.0):
    from PIL import Image
    im = Image.new('RGB', (256, 256))
    px = im.load()
    for y in range(256):
        for x in range(256):
            v = int(round((taban + x * 0.5 + 32768) * 256))
            px[x, y] = ((v >> 16) & 255, (v >> 8) & 255, v & 255)
    buf = io.BytesIO(); im.save(buf, 'PNG'); return buf.getvalue()


def sahte_jpeg():
    from PIL import Image
    im = Image.new('RGB', (256, 256), (90, 120, 60))
    buf = io.BytesIO(); im.save(buf, 'JPEG'); return buf.getvalue()


class SahteFetch:
    def __init__(self):
        self.n = 0
        self.png, self.jpg = terrarium_png(), sahte_jpeg()

    def __call__(self, url, timeout=10, data=None):
        self.n += 1
        return self.png if 'terrarium' in url else self.jpg


def giris(c, ad):
    r = c.post('/api/session', json={'dev_user': ad}, headers=H)
    assert r.status_code == 200, r.text
    return r.json()


def oturum(c, ad):
    """Aynı TestClient üzerinden ek kullanıcı: çerez başlığı ile (ayrı TestClient nesnesi her istekte kendi olay döngüsünü kapatır ve
    sunucudaki oturum görevlerini iptal eder — test artefaktı). Dönüş: (okuma başlıkları, yazma başlıkları)."""
    asil = c.cookies.get('smsid')
    r = c.post('/api/session', json={'dev_user': ad}, headers=H)
    assert r.status_code == 200, r.text
    tok = r.cookies.get('smsid')
    c.cookies.clear()
    c.cookies.set('smsid', asil)
    return {'Cookie': f'smsid={tok}'}, {'Cookie': f'smsid={tok}', 'Origin': ORIGIN}


def main():
    # ---- shim: HEPGO'ya özgü modüller SIMUMAV karşılıklarıyla yüklendi
    for k in ('app.config', 'app.db', 'app.drone_hub', 'app.feed', 'app.flightlog', 'app.flight_analysis'):
        assert getattr(sys.modules.get(k), 'SIMUMAV_SHIM', False), f'{k} shim değil'
    assert 'app.main' not in sys.modules and 'app.auth' not in sys.modules
    import app.flightsim_hub as fh
    assert fh.drone_hub.__name__ == 'app.simumav.shim.drone_hub' and fh.db.__name__ == 'app.simumav.shim.db'
    from app import config as core_cfg
    assert str(core_cfg.DATA_DIR).startswith(D) and str(core_cfg.UPLOAD_DIR).startswith(D)
    sim_terrain.FETCH = SahteFetch()
    config.RATE['write'] = (100000, 60)   # CRUD/kota sınamaları 60/dk yazma sınırını aşar; oran sınırı ayrı sınanır (session 10/dk)
    config.RATE['read'] = (100000, 60)

    with TestClient(smain.app, base_url=ORIGIN) as c:
        # ---- meta oturumsuz: 200, maps_key yok; güvenlik başlıkları
        r = c.get('/api/meta')
        assert r.status_code == 200 and r.json()['maps_key'] is None and r.json()['authenticated'] is False
        assert 'frame-ancestors' in r.headers['content-security-policy'] and r.headers['x-content-type-options'] == 'nosniff'
        assert "'unsafe-inline'" not in r.headers['content-security-policy'].split('script-src')[1].split(';')[0]
        # GA4: meta.ga_id (SIMUMAV_GA_ID) + CSP alanları (gtag.js script-src; collect beacon'ları connect-src); analytics.js harici dosya, HTML'de gtag yok
        assert r.json()['ga_id'] == 'G-8946D4RPGK'
        assert r.json()['ads_id'] == 'AW-18523043628'   # Google Ads etiketi (SIMUMAV_ADS_ID)
        _csp = r.headers['content-security-policy']
        _scr = _csp.split('script-src')[1].split(';')[0]; _con = _csp.split('connect-src')[1].split(';')[0]
        assert 'https://www.googletagmanager.com' in _scr and 'google-analytics.com' not in _scr
        for _h in ('https://www.google-analytics.com', 'https://analytics.google.com', 'https://*.google-analytics.com', 'https://www.googletagmanager.com'):
            assert _h in _con, _h
        assert 'https:' in _csp.split('img-src')[1].split(';')[0]
        _an = c.get('/js/analytics.js'); assert _an.status_code == 200 and 'googletagmanager.com/gtag/js' in _an.text and "'simumav.consent'" in _an.text
        assert c.get('/js/lang.js').status_code == 200 and c.get('/css/consent.css').status_code == 200
        assert 'googletagmanager' not in c.get('/').text and 'googletagmanager' not in c.get('/app/').text   # gtag yalnız rızayla, JS'ten yüklenir
        # statik yönlendirmeler
        assert c.get('/sim/api.js').status_code == 200 and 'export const api' in c.get('/api.js').text and c.get('/static/js/api.js').status_code == 200
        assert c.get('/sim/flightsim.js').status_code == 200 and 'yerine' in c.get('/ui.js').text[:300] and c.get('/sim/ui.js').status_code == 200 and c.get('/main.js').status_code == 404
        assert c.get('/static/img/google-logo.png').headers['content-type'] == 'image/png' and c.get('/static/models/caymaz-sim.glb').status_code == 200
        assert c.get('/static/vendor/three/three.module.min.js').status_code == 200 and c.get('/app/simapi.js').status_code == 200 and c.get('/i18n.js').status_code == 200
        assert c.get('/api/drone/sim/terrain?lat=40&lon=33').status_code == 401 and c.get('/api/drone/sim/tile/img/13/1/1').status_code == 401   # arazi vekili oturum ister
        csp = c.get('/app/').headers['content-security-policy']; assert 'https://cdn.jsdelivr.net' in csp and 'https://maps.gstatic.com' in csp and 'https://*.ggpht.com' in csp
        assert c.get('/').status_code == 200 and c.get('/app/').status_code == 200 and c.get('/brand/simumav.svg').status_code == 200
        # oturumsuz API → 401 {detail:{error}}
        r = c.get('/api/hangar'); assert r.status_code == 401 and r.json()['detail']['error'] == 'unauthorized'

        # ---- oturum (dev login) + varsayılanlar
        s = giris(c, 'ali')
        assert s['user']['display_name'] == 'ali' and s['pilots_count'] == 1 and s['drones_count'] == 1 and s['tracks_count'] == 1
        assert 'smsid' in c.cookies
        s_tok = c.cookies['smsid']
        me = c.get('/api/session').json(); assert me['user']['id'] == s['user']['id'] and me['active_flight'] is None
        tr = c.get('/api/tracks').json()['tracks'][0]
        assert tr['name'] == 'TRTEST' and abs(tr['lat'] - 40.0990) < 1e-6 and tr['is_default'] and tr['world_mode'] == 'google3d' and tr['gates'] == []
        d0 = c.get('/api/hangar').json()['drones'][0]; assert d0['name'] == 'FPV-1' and d0['type'] == 'fpv' and d0['model_key'] == 'glb:iris_fpv' and not d0['proc']
        assert d0['preview'] == '/static/simumav/models/iris_fpv.glb' and d0['orient']['forward'] == '+x' and d0['model_label'] == 'Iris FPV' and c.get(d0['preview']).status_code == 200
        p0 = c.get('/api/crew').json()['pilots'][0]; assert p0['character'] == 'p01' and p0['name'] == 'ali'
        assert c.get('/api/meta').json()['authenticated'] is True
        # dev login kapalıyken token zorunlu; geçersiz token (hesap servisi erişilemez) → 503
        r = c.post('/api/session', json={}, headers=H); assert r.status_code == 422
        r = c.post('/api/session', json={'token': 'A' * 40}, headers=H); assert r.status_code == 503 and r.json()['detail']['error'] == 'account_service'

        # ---- CSRF: Origin yok / yabancı → 403; GET etkilenmez
        assert c.post('/api/crew', json={'name': 'x', 'character': 'p02'}).status_code == 403
        r = c.post('/api/crew', json={'name': 'x', 'character': 'p02'}, headers={'Origin': 'https://kotu.example'}); assert r.status_code == 403 and r.json()['detail']['error'] == 'csrf'
        assert c.post('/api/crew', json={'name': 'x', 'character': 'p02'}, headers={'Sec-Fetch-Site': 'same-origin'}).status_code == 201
        assert c.get('/api/crew').status_code == 200

        # ---- settings: dil seçilmedikçe None (kabuk tarayıcı dilini uygular); tema PUT'u dili "seçilmiş" yapmaz; dil PUT'u → lang_chosen
        assert c.get('/api/settings').json()['lang'] is None
        assert c.put('/api/settings', json={'theme': 'dark'}, headers=H).json()['lang'] is None
        st = c.put('/api/settings', json={'lang': 'en', 'theme': 'light', 'sound': False}, headers=H).json()
        assert st['lang'] == 'en' and st['theme'] == 'light' and st['sound'] is False
        assert c.get('/api/settings').json()['lang'] == 'en'
        assert c.put('/api/settings', json={'lang': 'xx'}, headers=H).status_code == 422
        assert c.get('/api/session').json()['user']['lang'] == 'en'

        # ---- hangar: katalog, CRUD, param beyaz listesi, kota
        cat = c.get('/api/hangar/catalog').json()['types']
        keys = {t['key']: [m['key'] for m in t['models']] for t in cat}
        assert 'proc:interceptor' in keys['plane'] and 'glb:jet' in keys['plane'] and 'glb:zephyr' in keys['plane'] and keys['interceptor'] == ['glb:icept_x4', 'glb:p1sun', 'glb:sting'] and 'proc:quad250' in keys['fpv'] and 'builtin:caymaz' in keys['plane'] and 'builtin:quad' in keys['multirotor']
        assert keys['fpv'][0] == 'glb:iris_fpv' and keys['interceptor'][0] == 'glb:icept_x4' and keys['heli'][0] == 'glb:heli' and keys['vtol'][0] == 'glb:standard_vtol' and 'glb:typhoon_h480' in keys['multirotor']
        assert all(c.get(m['glb']).status_code == 200 for t in cat for m in t['models'] if m['key'].startswith('glb:'))   # gerçekçi GLB'ler sunuluyor
        # §13.1 kontrol düzeni: katalog modellerinde `airframe` (talon vtail, caymaz/delta/zephyr elevon, cessna/believer classic); kayıtta kalıcı
        af = {m['key']: m.get('airframe') for t in cat for m in t['models']}
        assert af['glb:talon_vtail'] == 'vtail' and af['builtin:talon'] == 'vtail' and af['builtin:caymaz'] == 'elevon' and af['glb:rc_cessna'] == 'classic' and af['glb:believer'] == 'classic' and af['glb:zephyr'] == 'elevon' and af['proc:interceptor'] == 'elevon', af
        assert 'glb:talon_vtail' in keys['plane'] and c.get('/static/simumav/models/talon_vtail.glb').status_code == 200
        r = c.post('/api/hangar', json={'name': 'Talon', 'type': 'plane', 'model_key': 'glb:talon_vtail'}, headers=H); assert r.status_code == 201, r.text
        tal = r.json(); assert tal['airframe'] == 'vtail', tal   # eksik → modelin düzeni
        r = c.put(f"/api/hangar/{tal['id']}", json={'airframe': 'classic'}, headers=H); assert r.json()['airframe'] == 'classic'
        r = c.put(f"/api/hangar/{tal['id']}", json={'model_key': 'builtin:caymaz'}, headers=H); assert r.json()['airframe'] == 'elevon', r.text   # model değişti, düzen gönderilmedi → yeni modelin düzeni
        assert c.post('/api/hangar', json={'name': 'K', 'type': 'plane', 'model_key': 'builtin:delta', 'airframe': 'canard'}, headers=H).status_code == 422
        r = c.post('/api/hangar', json={'name': 'Q', 'type': 'multirotor', 'model_key': 'builtin:quad', 'airframe': 'vtail'}, headers=H); assert r.status_code == 201 and r.json()['airframe'] is None   # kopterde düzen yok
        c.delete(f"/api/hangar/{r.json()['id']}", headers=H); c.delete(f"/api/hangar/{tal['id']}", headers=H)
        inter = next(m for t in cat for m in t['models'] if m['key'] == 'proc:interceptor')
        assert inter['proc'] and inter['defaults']['AIRSPEED_MAX'] == 170 and inter['defaults']['THR_MAX'] == 100 and inter['defaults']['TKOFF_THR_MAX'] == 100
        r = c.post('/api/hangar', json={'name': 'Ok', 'type': 'plane', 'model_key': 'proc:interceptor', 'params': inter['defaults'], 'color': '#00ff88'}, headers=H)
        assert r.status_code == 201, r.text
        okid = r.json()['id']; assert r.json()['params']['AIRSPEED_MAX'] == 170.0
        for kotu in ({'SERIAL1_BAUD': 57}, {'LOG_BITMASK': 1}, {'SYSID_THISMAV': 2}, {'BRD_SAFETYENABLE': 0}, {'SCR_ENABLE': 1}, {'ARMING_CHECK': 0},
                     {'thr_max': 'yüz'}, {'THR_MAX': 1e9}, {'../x': 1}, {'FS_GCS_ENABLE': 0}, {'RC1_MIN': 1000}):
            r = c.post('/api/hangar', json={'name': 'K', 'type': 'plane', 'model_key': 'builtin:delta', 'params': kotu}, headers=H)
            assert r.status_code == 422 and r.json()['detail']['error'] == 'param_rejected', (kotu, r.text)
        assert c.post('/api/hangar', json={'name': 'K', 'type': 'plane', 'model_key': 'proc:quad250'}, headers=H).status_code == 422   # tip/model uyumsuz
        assert c.post('/api/hangar', json={'name': 'K', 'type': 'uzaygemisi', 'model_key': 'builtin:quad'}, headers=H).status_code == 422
        assert c.post('/api/hangar', json={'name': 'x' * 41, 'type': 'plane', 'model_key': 'builtin:delta'}, headers=H).status_code == 422
        ok = next(d for d in c.get('/api/hangar').json()['drones'] if d['id'] == okid); assert ok['model_key'] == 'proc:interceptor' and ok['preview'] == '/static/simumav/models/jet.glb' and ok['orient'] and not ok['proc']   # eski anahtar → GLB görseli (MODEL_YUKSELT)
        r = c.put(f'/api/hangar/{okid}', json={'name': 'Ok-2', 'is_default': True, 'params': {'THR_MAX': 90}}, headers=H)
        assert r.json()['name'] == 'Ok-2' and r.json()['is_default'] and r.json()['params'] == {'THR_MAX': 90.0}
        for i in range(config.QUOTA['drones']):
            r = c.post('/api/hangar', json={'name': f'Q{i}', 'type': 'multirotor', 'model_key': 'builtin:quad'}, headers=H)
            if r.status_code != 201:
                break
        assert r.status_code == 409 and r.json()['detail']['error'] == 'quota' and len(c.get('/api/hangar').json()['drones']) == config.QUOTA['drones']
        assert c.delete(f'/api/hangar/{okid}', headers=H).json()['ok'] and c.get('/api/hangar/catalog').status_code == 200

        # ---- crew
        chars = c.get('/api/crew/characters').json()['characters']
        assert all(ch['svg'] == f"/app/img/pilots/{ch['key']}.svg" for ch in chars), chars   # pilot SVG tek doğruluk kaynağı (common.PILOT_SVG)
        assert c.get('/api/crew').json()['pilots'][0]['svg'].startswith('/app/img/pilots/')
        assert c.get('/app/img/pilots/p01.svg').status_code == 200 and c.get('/app', follow_redirects=False).status_code == 307
        assert len(chars) == 10 and chars[0]['key'] == 'p01' and chars[0]['gender'] == 'm' and sum(1 for x in chars if x['gender'] == 'f') >= 4
        assert c.post('/api/crew', json={'name': 'Ayşe', 'character': 'p99'}, headers=H).status_code == 422
        pid = c.post('/api/crew', json={'name': 'Ayşe', 'character': 'p04'}, headers=H).json()['id']
        assert c.put(f'/api/crew/{pid}', json={'is_default': True}, headers=H).json()['is_default']
        assert c.delete(f'/api/crew/{pid}', headers=H).json()['ok'] and c.delete(f'/api/crew/{pid}', headers=H).status_code == 404

        # ---- tracks: doğrulama, gates, world, preview
        tid0 = tr['id']
        r = c.post('/api/tracks', json={'name': 'Göl', 'lat': 40.10, 'lon': 33.40, 'radius_m': 100}, headers=H); assert r.status_code == 422   # yarıçap 200–5000
        r = c.post('/api/tracks', json={'name': 'Göl', 'lat': 40.10, 'lon': 33.40, 'wind': {'speed_ms': 45}}, headers=H); assert r.status_code == 422
        r = c.post('/api/tracks', json={'name': 'Göl', 'lat': 40.10, 'lon': 33.40, 'world_mode': 'mars'}, headers=H); assert r.status_code == 422
        r = c.post('/api/tracks', json={'name': 'Göl', 'lat': 40.10, 'lon': 33.40, 'world': {'size_m': 99999}}, headers=H); assert r.status_code == 422
        gates = [{'i': 0, 'lat': 40.1005, 'lon': 33.4005, 'agl_m': 5, 'yaw_deg': 90, 'radius_m': 3, 'kind': 'ring'}, {'i': 1, 'lat': 40.101, 'lon': 33.401, 'agl_m': 8, 'radius_m': 4, 'kind': 'gate'}]
        r = c.post('/api/tracks', json={'name': 'Göl', 'lat': 40.10, 'lon': 33.40, 'radius_m': 1500, 'world_mode': 'procedural', 'world': {'seed': 7, 'runway': False, 'tree_density': 0.5},
                                        'gates': gates + [{'i': 2, 'lat': 41.0, 'lon': 33.4, 'radius_m': 3}]}, headers=H)
        assert r.status_code == 422 and 'dışında' in r.json()['detail']['message']
        r = c.post('/api/tracks', json={'name': 'Göl', 'lat': 40.10, 'lon': 33.40, 'radius_m': 1500, 'world_mode': 'procedural', 'world': {'seed': 7, 'runway': False, 'tree_density': 0.5}, 'gates': gates}, headers=H)
        assert r.status_code == 201, r.text
        t2 = r.json(); assert t2['world'] == {'seed': 7, 'runway': False, 'tree_density': 0.5} and len(t2['gates']) == 2 and t2['gates'][1]['kind'] == 'gate' and t2['world_mode'] == 'procedural'
        assert c.put(f"/api/tracks/{t2['id']}", json={'gates': [{'i': 5, 'lat': 40.1, 'lon': 33.4}]}, headers=H).status_code == 422   # sıra 0..n-1
        r = c.get(f'/api/tracks/{tid0}/preview.png'); assert r.status_code == 200 and r.headers['content-type'] == 'image/png' and r.content[:4] == b'\x89PNG', r.text[:200]
        from PIL import Image
        assert Image.open(io.BytesIO(r.content)).size == (512, 512)
        n = sim_terrain.FETCH.n; assert c.get(f'/api/tracks/{tid0}/preview.png').status_code == 200 and sim_terrain.FETCH.n == n   # önbellek
        for i in range(config.QUOTA['tracks']):
            r = c.post('/api/tracks', json={'name': f'T{i}', 'lat': 40.0 + i / 100, 'lon': 33.0}, headers=H)
            if r.status_code != 201:
                break
        assert r.status_code == 409 and r.json()['detail']['error'] == 'quota'

        # ---- missions: plan doğrulama (yarıçap dışı nokta, 500+ nokta), fpv_gates
        items = [{'seq': 1, 'command': 16, 'frame': 3, 'x': int(40.1002e7), 'y': int(33.4003e7), 'z': 60}]
        r = c.post('/api/missions', json={'track_id': t2['id'], 'name': 'Koridor', 'kind': 'corridor', 'plan': {'items': items}}, headers=H); assert r.status_code == 201, r.text
        mid = r.json()['id']
        # oyun arayüzü editörünün `route.points` biçimi (lat/lon/alt_rel/cmd) kabul edilir ve bridge.plan_items MAVLink öğelerine çevirir
        pts = [{'seq': 0, 'cmd': 22, 'lat': t2['lat'], 'lon': t2['lon'], 'alt_rel': 50, 'frame': 3}, {'seq': 1, 'cmd': 16, 'lat': t2['lat'] + 0.001, 'lon': t2['lon'], 'alt_rel': 60, 'frame': 3}]
        r = c.post('/api/missions', json={'track_id': t2['id'], 'name': 'Editör', 'kind': 'free', 'plan': {'kind': 'free', 'route': {'points': pts}, 'shape': [], 'params': {'alt': 50}}}, headers=H)
        assert r.status_code == 201, r.text
        it = bridge.plan_items(r.json()['plan']); assert len(it) == 2 and it[0]['command'] == 22 and it[1]['x'] == int(round((t2['lat'] + 0.001) * 1e7)) and it[1]['z'] == 60, it
        r = c.post('/api/missions', json={'track_id': t2['id'], 'name': 'Editör uzak', 'kind': 'free', 'plan': {'route': {'points': [{'cmd': 16, 'lat': 41.0, 'lon': 33.4, 'alt_rel': 50}]}}}, headers=H)
        assert r.status_code == 422 and r.json()['detail']['error'] == 'plan_rejected'
        assert c.get('/api/drone/routes', headers=H).json() == []
        r = c.post('/api/missions', json={'track_id': t2['id'], 'name': 'Uzak', 'kind': 'free', 'plan': {'items': [{'command': 16, 'x': int(41e7), 'y': int(33.4e7), 'z': 50}]}}, headers=H)
        assert r.status_code == 422 and r.json()['detail']['error'] == 'plan_rejected'
        r = c.post('/api/missions', json={'track_id': t2['id'], 'name': 'Çok', 'kind': 'free', 'plan': {'items': items * 501}}, headers=H); assert r.status_code == 422
        r = c.post('/api/missions', json={'track_id': t2['id'], 'name': 'Tur', 'kind': 'fpv_gates', 'plan': {'order': [0, 1, 0], 'laps': 3}}, headers=H); assert r.status_code == 201
        assert c.post('/api/missions', json={'track_id': t2['id'], 'name': 'Tur', 'kind': 'fpv_gates', 'plan': {'order': [7], 'laps': 3}}, headers=H).status_code == 422
        assert c.post('/api/missions', json={'track_id': t2['id'], 'name': 'Tur', 'kind': 'fpv_gates', 'plan': {'order': [0], 'laps': 11}}, headers=H).status_code == 422
        assert c.post('/api/missions', json={'track_id': t2['id'], 'name': 'x', 'kind': 'yok', 'plan': {}}, headers=H).status_code == 422
        assert len(c.get(f"/api/missions?track_id={t2['id']}").json()['missions']) == 3   # Koridor + Editör + Tur

        # ---- sahiplik: ikinci kullanıcı başkasının kayıtlarını göremez (404)
        HV, HVW = oturum(c, 'veli')
        assert c.get(f"/api/tracks/{tid0}/preview.png", headers=HV).status_code == 404 and c.put(f'/api/missions/{mid}', json={'name': 'x'}, headers=HVW).status_code == 404
        assert c.delete(f"/api/hangar/{d0['id']}", headers=HVW).status_code == 404

        # ---- fly/start (sahte kip): flight kaydı + MP TCP dinleyici + IP kilidi
        drone_id = d0['id']
        pilot_id = c.get('/api/crew').json()['pilots'][0]['id']
        r = c.post('/api/fly/start', json={'drone_id': drone_id, 'pilot_id': pilot_id, 'track_id': tid0, 'mission_id': mid, 'launch': 'hand'}, headers=H)
        assert r.status_code == 422   # görev başka parkura ait
        r = c.post('/api/fly/start', json={'drone_id': drone_id, 'pilot_id': pilot_id, 'track_id': t2['id'], 'mission_id': mid, 'launch': 'wheels', 'record': {'bin': True}}, headers=H)
        assert r.status_code == 201, r.text
        f = r.json(); fid, sid, port = f['flight_id'], f['sim_id'], f['mp']['port']
        assert f['mp']['proto'] == 'tcp' and 25600 <= port < 25640 and f['ws'] == f'/ws/fly/{sid}'
        # GET /api/fly/current → açık uçuş özeti (ön yüz "Süren uçuşunuz var" kartı); başka kullanıcıda null
        cur = c.get('/api/fly/current').json()
        assert cur['flight_id'] == fid and cur['sim_id'] == sid and cur['started_at'] and cur['ws'] == f'/ws/fly/{sid}' and cur['drone']['id'] == drone_id and cur['track']['id'] == t2['id'] and cur['ws_seen'] is False, cur
        assert c.get('/api/fly/current', headers=HV).json() is None
        # ikinci uçuş → 409 {error:'flight_open', flight_id, sim_id}
        r = c.post('/api/fly/start', json={'drone_id': drone_id, 'pilot_id': pilot_id, 'track_id': t2['id'], 'launch': 'wheels'}, headers=H)
        assert r.status_code == 409 and r.json()['detail']['error'] == 'flight_open' and r.json()['detail']['flight_id'] == fid and r.json()['detail']['sim_id'] == sid, r.text
        # dron silinemez (uçuşta)
        assert c.delete(f'/api/hangar/{drone_id}', headers=H).status_code == 409
        st = c.get(f'/api/fly/{fid}').json()
        assert st['active'] and st['live']['sim_id'] == sid and st['live']['mp']['port'] == port and st['live']['mp']['locked_ip'] is None and st['live']['gates'] and st['mp']['connected'] is False
        assert c.get(f'/api/fly/{fid}', headers=HV).status_code == 404
        # MP TCP: 127.0.0.1'den bağlan, GCS kalp atışı gönder → SITL (sahte kip) kalp atışı TCP'den döner
        from pymavlink.dialects.v20 import ardupilotmega as D20
        enc = D20.MAVLink(None, srcSystem=255, srcComponent=190)
        hb = enc.heartbeat_encode(6, 8, 0, 0, 0).pack(enc)
        for _ in range(100):   # oturum HAZIR olsun
            if (bridge.oturum(sid) or flightsim.MANAGER.sessions[sid]).state == 'HAZIR':
                break
            time.sleep(0.05)
        s1 = socket.create_connection(('127.0.0.1', port), timeout=5)
        s1.sendall(hb)
        s1.settimeout(5)
        gelen = b''
        while len(gelen) < 8:
            gelen += s1.recv(4096)
        assert gelen[0] in (0xFE, 0xFD), gelen[:4]   # MAVLink çerçevesi (sahte kip 1 Hz HEARTBEAT)
        for _ in range(50):
            if c.get(f'/api/fly/{fid}').json()['live']['mp']['locked_ip'] == '127.0.0.1':
                break
            time.sleep(0.05)
        assert c.get(f'/api/fly/{fid}').json()['live']['mp']['locked_ip'] == '127.0.0.1'
        # farklı IP'den ikinci bağlantı reddedilir (127.0.0.2 → kaynak adresi farklı)
        s2 = socket.socket(); s2.bind(('127.0.0.2', 0)); s2.settimeout(5); s2.connect(('127.0.0.1', port))
        try:
            s2.sendall(hb)
            assert s2.recv(1024) == b''   # sunucu kapattı
        except (ConnectionResetError, BrokenPipeError):
            pass
        s2.close()
        # aynı IP'den aynı anda ikinci bağlantı da reddedilir (tek bağlantı)
        s3 = socket.create_connection(('127.0.0.1', port), timeout=5); s3.settimeout(5)
        try:
            assert s3.recv(1024) == b''
        except (ConnectionResetError, BrokenPipeError):
            pass
        s3.close()
        for _ in range(40):
            if c.get(f'/api/fly/{fid}').json()['live']['mp']['rejected'] >= 2:
                break
            time.sleep(0.05)
        assert c.get(f'/api/fly/{fid}').json()['live']['mp']['rejected'] >= 2
        # WS hello (çerezle) + başkası 4403
        CK = {'Cookie': f"smsid={c.cookies['smsid']}"}   # TestClient WS'e çerez eklemez
        with c.websocket_connect(f'/ws/fly/{sid}', headers=CK) as ws:
            hello = ws.receive_json(); assert hello['t'] == 'hello' and hello['session']['id'] == sid and hello['flight_id'] == fid and len(hello['gates']) == 2, json.dumps(hello)[:600]
            # TEK soket: hub alanları da hello'da (flightsim_panel.js watch beklemeden); bridge_id = -(9000+sim_id)
            assert hello['me']['can_command'] is True and hello['bridges'] and hello['bridges'][0]['bridge_id'] == -(9000 + sid) and hello['bridges'][0]['sim_id'] == sid, json.dumps(hello)[:400]
            assert hello['session']['hub']['bridge_id'] == -(9000 + sid) and 'console' in hello['caps']
            ws.send_json({'t': 'watch', 'sim_id': sid}); m = ws.receive_json()
            while m.get('t') != 'hello':
                m = ws.receive_json()
            assert m['bridges'][0]['bridge_id'] == -(9000 + sid)
            # hub komutu (set_mode) bridge_id ile → res{rid, ok}; status mesajı aynı sokette
            ws.send_json({'t': 'cmd', 'rid': 'h1', 'bridge_id': -(9000 + sid), 'sysid': 1, 'name': 'set_mode', 'params': {'mode': 'GUIDED'}})
            m = ws.receive_json(); gorulen = set()
            while not (m.get('t') == 'res' and m.get('rid') == 'h1'):
                gorulen.add(m.get('t')); m = ws.receive_json()
            assert m['ok'] is True, m
            ws.send_json({'t': 'cmd', 'rid': 'h2', 'bridge_id': 12345, 'name': 'arm'}); m = ws.receive_json()
            while not (m.get('t') == 'res' and m.get('rid') == 'h2'):
                m = ws.receive_json()
            assert m['ok'] is False and 'ait' in m['error']
            ws.send_json({'t': 'ping'});
            m = ws.receive_json()
            while m.get('t') not in ('pong',):
                m = ws.receive_json()
            ws.send_json({'t': 'cmd', 'name': 'arm', 'rid': 'r1'})
            while m.get('t') != 'res':
                m = ws.receive_json()
            assert m['ok'] is True
            # Kalkış paritesi (HEPGO drone_hub _takeoff_flow): panelin hub yolu takeoff{alt_rel_m, kontrol} → sahte SITL'e giden komut SIRASI
            # mode GUIDED → arm → takeoff; pilot ARM düğmesine basmaz. Sahte kinematik komutları sarmalanarak kaydedilir.
            ss = flightsim.MANAGER.sessions[sid]
            ss.sahte.komut('disarm', {})
            kayit = []
            orj = ss.sahte.komut
            ss.sahte.komut = lambda name, p, _o=orj: (kayit.append((name, dict(p or {}))), _o(name, p))[1]
            try:
                kontrol = [{'sira': 0, 'anahtar': 'alan', 'soru': 'Alan boş', 'grup': 'sim', 'cevap': True, 'zorunlu': True, 'kaynak': 'flightsim_panel'}]
                ws.send_json({'t': 'cmd', 'rid': 'to1', 'bridge_id': -(9000 + sid), 'sysid': 1, 'name': 'takeoff', 'params': {'alt_rel_m': 25, 'kontrol': kontrol}})
                m = ws.receive_json()
                while not (m.get('t') == 'res' and m.get('rid') == 'to1'):
                    m = ws.receive_json()
                assert m['ok'] is True, m
                t0 = time.time()
                while time.time() - t0 < 15 and [k for k, _ in kayit][-1:] != ['takeoff']:
                    m = ws.receive_json()
                assert [k for k, _ in kayit] == ['mode', 'arm', 'takeoff'] and kayit[0][1] == {'mode': 'GUIDED'} and kayit[2][1]['alt'] == 25.0, kayit
                assert ss.sahte.armed and ss.sahte.hedef_alt == 25.0
                # zorunlu madde onaysız → kalkış gönderilmez
                ws.send_json({'t': 'cmd', 'rid': 'to2', 'bridge_id': -(9000 + sid), 'sysid': 1, 'name': 'takeoff', 'params': {'alt_rel_m': 25, 'kontrol': [{**kontrol[0], 'cevap': False}]}})
                m = ws.receive_json()
                while not (m.get('t') == 'res' and m.get('rid') == 'to2'):
                    m = ws.receive_json()
                assert m['ok'] is False, m
                # sanal kumanda: WS rc → sahte SITL RC override (ch5 2000); 8×0 → serbest (varsayılan kanallar)
                ws.send_json({'t': 'rc', 'ch': [1600, 1400, 1900, 1500, 2000, 0, 0, 0]})
                t0 = time.time()
                while time.time() - t0 < 5 and not (kayit and kayit[-1][0] == 'rc'):
                    m = ws.receive_json()
                assert kayit[-1] == ('rc', {'ch': [1600, 1400, 1900, 1500, 2000, 0, 0, 0]}) and ss.sahte.rc[4] == 2000 and ss.sahte.rc[2] == 1900, (kayit[-1], ss.sahte.rc)
                ws.send_json({'t': 'rc', 'ch': [0] * 8})
                t0 = time.time()
                while time.time() - t0 < 5 and ss.sahte.rc[4] != 1500:
                    m = ws.receive_json()
                assert list(ss.sahte.rc) == list(flightsim.SahteKinematik.RC_VARSAYILAN), ss.sahte.rc
            finally:
                ss.sahte.komut = orj
        # başkası (geçerli oturum, sahibi değil) → {'t':'error','error':'not_found'} + 4404; çerezsiz → auth
        with c.websocket_connect(f'/ws/fly/{sid}', headers=HV) as ws:
            assert ws.receive_json() == {'t': 'error', 'error': 'not_found'}
        with c.websocket_connect(f'/ws/fly/{sid}', headers={'Cookie': 'smsid=yok'}) as ws:
            assert ws.receive_json() == {'t': 'error', 'error': 'auth'}
        # uyumluluk yüzeyi: /api/drone/sim/sessions/{id}, cmd, meta
        assert c.get(f'/api/drone/sim/sessions/{sid}').json()['id'] == sid and c.get(f'/api/drone/sim/sessions/{sid}', headers=HV).status_code == 404
        assert c.post(f'/api/drone/sim/sessions/{sid}/cmd', json={'name': 'mode', 'params': {'mode': 'LOITER'}}, headers=H).json()['ok']
        cm = c.get('/api/drone/sim/meta').json(); assert cm['simumav'] and cm['centers'][0]['name'] == 'TRTEST' and cm['limits']['max_minutes'] == 45
        # sunucu genel sınır (2): veli bir uçuş açar, üçüncü kullanıcı 429 bekleme odası
        tv = c.get('/api/tracks', headers=HV).json()['tracks'][0]; dv = c.get('/api/hangar', headers=HV).json()['drones'][0]; pv = c.get('/api/crew', headers=HV).json()['pilots'][0]
        r = c.post('/api/fly/start', json={'drone_id': dv['id'], 'pilot_id': pv['id'], 'track_id': tv['id'], 'launch': 'wheels'}, headers=HVW); assert r.status_code == 201, r.text
        fv = r.json()['flight_id']
        assert bridge.aktif_sayisi() == 2
        HC, HCW = oturum(c, 'can')
        t3 = c.get('/api/tracks', headers=HC).json()['tracks'][0]; d3 = c.get('/api/hangar', headers=HC).json()['drones'][0]; p3 = c.get('/api/crew', headers=HC).json()['pilots'][0]
        r = c.post('/api/fly/start', json={'drone_id': d3['id'], 'pilot_id': p3['id'], 'track_id': t3['id'], 'launch': 'wheels'}, headers=HCW)
        assert r.status_code == 429 and r.json()['detail']['error'] == 'server_full' and 'Retry-After' in r.headers, r.text
        # stop (gates sonucu ile) → flights satırı tamam; MP dinleyici kapandı
        s1.close()
        assert c.post(f'/api/fly/{fid}/stop', json={'gates': {'passed': 3, 'missed': 1, 'laps': 1, 'best_lap_s': 42.5}}, headers=H).json()['ok']
        r = c.post(f'/api/fly/{fid}/stop', json={'gates': {'passed': -1}}, headers=H); assert r.status_code == 422
        fl = c.get(f'/api/ops/{fid}').json()
        assert fl['ended_at'] and fl['result'] == 'ok' and fl['duration_s'] is not None and fl['active'] is False and fl['pilot']['name'] == 'ali' and fl['track']['name'] == 'Göl'
        assert fl['summary']['gates'] == {'passed': 3, 'missed': 1, 'laps': 1, 'best_lap_s': 42.5} and fl['mission']['name'] == 'Koridor'
        assert 'bin_path' not in fl and 'params_path' not in fl
        time.sleep(0.3)
        try:
            socket.create_connection(('127.0.0.1', port), timeout=1).close()
            assert False, 'MP portu kapanmalıydı'
        except OSError:
            pass
        assert c.get('/api/session').json()['active_flight'] is None and c.get('/api/crew').json()['pilots'][0]['flights'] == 1
        assert c.post(f'/api/fly/{fv}/stop', headers=HVW).json()['ok']
        # ---- yetim uçuş: WS hiç bağlanmazsa ORPHAN_S sonra sunucu kapatır (audit fly_orphan); WS bağlanan uçuş kapanmaz
        assert c.get('/api/fly/current').json() is None
        config.ORPHAN_S = 1.5
        try:
            r = c.post('/api/fly/start', json={'drone_id': drone_id, 'pilot_id': pilot_id, 'track_id': t2['id'], 'launch': 'wheels'}, headers=H); assert r.status_code == 201, r.text
            fo, so = r.json()['flight_id'], r.json()['sim_id']
            assert c.get('/api/fly/current').json()['flight_id'] == fo
            for _ in range(80):
                if c.get('/api/fly/current').json() is None:
                    break
                time.sleep(0.1)
            assert c.get('/api/fly/current').json() is None, 'yetim uçuş kapanmadı'
            fo_row = c.get(f'/api/fly/{fo}').json(); assert fo_row['ended_at'] and fo_row['state'] == 'KAPANDI' and fo_row['active'] is False, fo_row
            with sdb_connect() as conn:
                assert conn.execute("SELECT COUNT(*) FROM audit WHERE event = 'fly_orphan' AND detail LIKE ?", (f'flight {fo} sim {so}:%',)).fetchone()[0] == 1
            # WS bağlanan uçuş yetim sayılmaz
            r = c.post('/api/fly/start', json={'drone_id': drone_id, 'pilot_id': pilot_id, 'track_id': t2['id'], 'launch': 'wheels'}, headers=H); assert r.status_code == 201, r.text
            fw, sw = r.json()['flight_id'], r.json()['sim_id']
            with c.websocket_connect(f'/ws/fly/{sw}', headers=CK) as ws:
                assert ws.receive_json()['t'] == 'hello'
                assert c.get('/api/fly/current').json()['ws_seen'] is True
                time.sleep(2.2)
                assert c.get('/api/fly/current').json()['flight_id'] == fw
            time.sleep(0.5)
            assert c.get('/api/fly/current').json()['flight_id'] == fw
            assert c.post(f'/api/fly/{fw}/stop', json={'reason': 'webgl'}, headers=H).json()['ok'] and c.get('/api/fly/current').json() is None
        finally:
            config.ORPHAN_S = 90.0

        # ---- ikinci uçuş: launch nesnesi (hand, sabit kanat), GET /fly/{id} start biçimi, kayıt (video) REST akışı
        pl = c.post('/api/hangar', json={'name': 'Kanat', 'type': 'plane', 'model_key': 'builtin:delta'}, headers=H).json()
        r = c.post('/api/fly/start', json={'drone_id': pl['id'], 'pilot_id': pilot_id, 'track_id': t2['id'], 'launch': {'method': 'hand', 'hand_speed_ms': 9}}, headers=H); assert r.status_code == 422
        r = c.post('/api/fly/start', json={'drone_id': pl['id'], 'pilot_id': pilot_id, 'track_id': t2['id'], 'launch': 'wheels', 'camera': 'ir'}, headers=H); assert r.status_code == 422   # HEPGO §22.3 kamera türü enum
        r = c.post('/api/fly/start', json={'drone_id': pl['id'], 'pilot_id': pilot_id, 'track_id': t2['id'], 'launch': {'method': 'hand', 'hand_speed_ms': 7.5, 'hand_pitch_deg': 12}, 'record': {'video': True, 'bin': False}, 'camera': 'thermal'}, headers=H)
        assert r.status_code == 201, r.text
        f2 = r.json(); fid2, sid2 = f2['flight_id'], f2['sim_id']
        g = c.get(f'/api/fly/{fid2}').json()
        assert g['camera'] == 'thermal' and g['session']['camera'] == 'thermal' and flightsim.MANAGER.sessions[sid2].camera == 'thermal', (g.get('camera'), g['session'].get('camera'))
        assert g['flight_id'] == fid2 and g['sim_id'] == sid2 and g['ws'] == f'/ws/fly/{sid2}' and g['session']['id'] == sid2 and g['launch'] == {'method': 'hand', 'angle_deg': 15.0, 'release_kmh': 70.0, 'hand_speed_ms': 7.5, 'hand_pitch_deg': 12.0}
        assert g['record'] == {'bin': False, 'video': True} and g['drone']['name'] == 'Kanat' and g['track']['gates'] and g['mp']['port'] and g['pilot']['name'] == 'ali'
        for _ in range(100):
            if flightsim.MANAGER.sessions[sid2].state == 'HAZIR':
                break
            time.sleep(0.05)
        with c.websocket_connect(f'/ws/fly/{sid2}', headers=CK) as ws:
            assert ws.receive_json()['t'] == 'hello'
            ws.send_json({'t': 'cmd', 'rid': 'k1', 'name': 'takeoff', 'params': {'alt': 60, 'launch': 'hand', 'hand_speed_ms': 7.5, 'hand_pitch_deg': 12}})
            m = ws.receive_json(); evler = []
            while not (m.get('t') == 'res' and m.get('rid') == 'k1'):
                evler.append(m.get('t')); m = ws.receive_json()
            assert m['ok'] is True, m
            t0 = time.time()
            while time.time() - t0 < 5:
                m = ws.receive_json()
                if m.get('t') == 'launch' and m.get('phase') == 'armed':
                    break
            assert m.get('t') == 'launch' and m.get('phase') == 'armed', m
            ws.send_json({'t': 'cmd', 'rid': 'cam1', 'name': 'camera', 'params': {'type': 'night'}})   # uçuş içinde tür değişimi (sim yolu; SITL'e gitmez)
            m = ws.receive_json()
            while not (m.get('t') == 'res' and m.get('rid') == 'cam1'):
                m = ws.receive_json()
            assert m['ok'] is True and m.get('camera') == 'night' and flightsim.MANAGER.sessions[sid2].camera == 'night', m
        s2 = flightsim.MANAGER.sessions[sid2]; assert s2.launch.get('hand') and s2.launch['method'] == 'ramp' and s2.launch['hand_speed_ms'] == 7.5
        # kayıt: start → chunk (sıralı) → thumb → finish(kept) → file → flights.video_path; sahiplik
        r = c.post(f'/api/fly/{fid2}/rec/start', json={'mime': 'video/webm'}, headers=H); assert r.status_code == 201, r.text
        rid = r.json()['rec_id']; assert r.json()['ext'] == '.webm' and r.json()['chunk_max'] == 8 * 1024 * 1024
        assert c.put(f'/api/fly/rec/{rid}/chunk?seq=0', content=b'\x1aE\xdf\xa3' + b'v' * 500, headers=H | {'Content-Type': 'application/octet-stream'}).json()['size'] == 504
        assert c.put(f'/api/fly/rec/{rid}/chunk?seq=1', content=b'w' * 300, headers=H | {'Content-Type': 'application/octet-stream'}).json()['size'] == 804
        assert c.put(f'/api/fly/rec/{rid}/chunk?seq=3', content=b'x', headers=H | {'Content-Type': 'application/octet-stream'}).status_code == 409   # atlama
        assert c.put(f'/api/fly/rec/{rid}/chunk?seq=1', content=b'w' * 300, headers=HVW | {'Content-Type': 'application/octet-stream'}).status_code == 403   # başkası
        assert c.put(f'/api/fly/rec/{rid}/thumb', content=terrarium_png(), headers=H | {'Content-Type': 'image/png'}).json()['ok']
        assert c.put(f'/api/fly/rec/{rid}/thumb', content=b'degil', headers=H | {'Content-Type': 'image/png'}).status_code == 415
        r = c.post(f'/api/fly/rec/{rid}/finish', json={'duration_s': 12.5, 'mime': 'video/webm', 'text': 'SIMUMAV test'}, headers=H)
        assert r.json()['kept'] is True and r.json()['size'] == 804 and r.json()['file'] == f'/api/fly/rec/{rid}/file', r.text
        r = c.get(f'/api/fly/rec/{rid}/file'); assert r.status_code == 200 and len(r.content) == 804 and r.headers['content-type'].startswith('video/webm')
        assert c.get(f'/api/fly/rec/{rid}/file', headers=HV).status_code == 403 and c.get('/api/fly/rec/zzzz/file').status_code == 404
        assert c.post(f'/api/fly/{fid2}/stop', headers=H).json()['ok']
        with sdb_connect() as conn:
            assert conn.execute('SELECT video_path FROM flights WHERE id = ?', (fid2,)).fetchone()[0] == f'sim_rec/{rid}.webm'
        assert c.get(f'/api/ops/{fid2}').json()['launch'] == 'hand'
        assert c.delete(f'/api/fly/rec/{rid}', headers=H).json()['ok'] and c.get(f'/api/fly/rec/{rid}/file').status_code == 404
        # ops: liste, sahiplik 404, replay yok (sahte kipte .bin yok) → 404 no_bin, silme
        ops = c.get('/api/ops').json(); assert ops['total'] == 4 and ops['flights'][0]['id'] == fid2 and ops['stats']['flights'] == 4   # fid, yetim, ws, fid2
        assert c.get(f'/api/ops/{fid}', headers=HV).status_code == 404 and c.delete(f'/api/ops/{fid}', headers=HVW).status_code == 404
        r = c.get(f'/api/ops/{fid}/replay'); assert r.status_code == 404 and r.json()['detail']['error'] == 'no_bin'
        assert c.get(f'/api/ops/{fid}/bin').status_code == 404
        assert c.delete(f'/api/ops/{fid}', headers=H).json()['ok'] and c.get('/api/ops').json()['total'] == 3
        # denetim kayıtları
        from app.simumav import db as sdb
        with sdb.connect() as conn:
            olaylar = {r[0] for r in conn.execute('SELECT DISTINCT event FROM audit')}
        assert {'login', 'csrf', 'quota', 'param_reject', 'plan_reject', 'fly_start', 'fly_stop', 'fly_orphan', 'mp_reject'} <= olaylar, olaylar
        # dosya yolu denetimi: kök dışı yollar reddedilir
        assert bridge.dosya_yolu('../simumav.db') is None and bridge.dosya_yolu('/etc/passwd') is None and bridge.dosya_yolu('') is None

        # ---- destek (§9): sahte hesap servisi (tests/simumav_fake_mt.py) → /api/sv/tickets* X-Simumav-Secret + user_id; talep SIMUMAV'da tutulmaz
        from tests import simumav_fake_mt as fake
        fsrv, fport = fake.serve()
        eski_mt = (config.MT_INTERNAL, config.MT_SHARED_SECRET)
        from app.simumav import auth as sauth
        try:
            ali_fid = c.get('/api/ops').json()['flights'][0]['id']
            config.MT_INTERNAL, config.MT_SHARED_SECRET = f'http://127.0.0.1:{fport}', ''
            r = c.get("/api/support"); assert r.status_code == 503 and r.json()["detail"]["error"] == "support_unavailable", (r.status_code, r.text[:300])   # paylaşılan gizli yok
            config.MT_SHARED_SECRET = 'sv-gizli'
            assert c.get('/api/support').json() == {'tickets': [], 'categories': [{'key': k, 'merkez': 'diger' if k == 'other' else 'teknik'} for k in ('flight', 'account', 'hangar', 'track', 'mp', 'perf', 'other')]}
            # oluştur: ek (PNG), bağlam (uçuş kimliği, tarayıcı) → gövdede bağlam bloğu; app=sv, başlıkta kategori öneki; attachment url
            png = terrarium_png()
            import base64
            durl = 'data:image/png;base64,' + base64.b64encode(png).decode()
            body = {'category': 'flight', 'subject': 'Dron düşüyor', 'body': 'Kalkışta hemen çakılıyor.', 'screenshot': durl, 'attach_name': 'ekran.png', 'include_context': True,
                    'context': {'ua': 'TestBrowser/1.0', 'lang': 'tr', 'screen': '1440x900@1.0', 'gl': 'SwiftShader', 'flight_id': ali_fid, 'route': '#/fly'}}
            r = c.post('/api/support', json=body, headers=H); assert r.status_code == 201, r.text
            tk = r.json(); assert tk['code'] == 'T-0001' and tk['id'] == 1 and tk['attachment']['name'] == 'ekran.png' and tk['attachment']['url'].startswith('/api/support/att/')
            gelen = [x for x in fake.STATE['calls'] if x[0] == 'POST' and x[1] == '/api/sv/tickets'][-1]
            assert gelen[2].get('X-Simumav-Secret') == 'sv-gizli' and gelen[3]['app'] == 'sv' and gelen[3]['category'] == 'teknik' and gelen[3]['subject'] == '[Uçuş / Simülasyon] Dron düşüyor', gelen
            g = gelen[3]['body']
            assert g.startswith('Kalkışta hemen çakılıyor.') and '--- SIMUMAV bağlamı ---' in g and f'Uçuş: #{ali_fid}' in g and 'Tarayıcı: TestBrowser/1.0' in g and 'GPU: SwiftShader' in g, g
            assert f'Sürüm: {config.VERSION}' in g and 'Ek: ekran.png' in g and f'https://simumav.com{tk["attachment"]["url"]}' in g, g
            # user_id sorguda (hesap servisi kullanıcıyı buradan çözer)
            assert '/api/sv/tickets' in gelen[1] and [x for x in fake.STATE['calls'] if x[1].startswith('/api/sv/tickets')][-1][1] == '/api/sv/tickets'
            # ek: oturumsuz indirme token ile; yanlış token 404; dosya diskte
            att = c.get(tk['attachment']['url'], headers={'Cookie': ''}); assert att.status_code == 200 and att.headers['content-type'] == 'image/png' and att.content == png and 'sandbox' in att.headers['content-security-policy']
            assert c.get('/api/support/att/' + 'A' * 43).status_code == 404 and c.get('/api/support/att/kisa').status_code == 404
            assert any((config.DATA_DIR / 'files' / 'support').rglob('*.png'))
            # bağlam kapalı: tarayıcı/uçuş satırı yok, sürüm/kategori var; ek yok; kategori other → diger
            r = c.post('/api/support', json={'category': 'other', 'subject': 'Öneri', 'body': 'Gece modu', 'include_context': False, 'context': {'ua': 'X', 'flight_id': ali_fid}}, headers=H)
            assert r.status_code == 201 and r.json()['attachment'] is None
            g2 = [x for x in fake.STATE['calls'] if x[0] == 'POST' and x[1] == '/api/sv/tickets'][-1][3]
            assert g2['category'] == 'diger' and 'Tarayıcı' not in g2['body'] and 'Uçuş:' not in g2['body'] and 'Kategori: Diğer' in g2['body']
            # geçersizler: kategori, ek türü (GIF), 3 MB üstü → 413, boş başlık 422
            assert c.post('/api/support', json={'category': 'uzay', 'subject': 'a', 'body': 'b'}, headers=H).status_code == 422
            r = c.post('/api/support', json={'category': 'perf', 'subject': 'a', 'body': 'b', 'screenshot': 'data:image/gif;base64,R0lGODlh'}, headers=H); assert r.status_code == 422
            buyuk = 'data:image/png;base64,' + base64.b64encode(b'\x89PNG\r\n\x1a\n' + b'\0' * (3 * 1024 * 1024 + 10)).decode()
            r = c.post('/api/support', json={'category': 'perf', 'subject': 'a', 'body': 'b', 'screenshot': buyuk}, headers=H); assert r.status_code == 413 and r.json()['detail']['error'] == 'too_large', r.text
            r = c.post('/api/support', json={'category': 'perf', 'subject': 'a', 'body': 'b', 'screenshot': 'data:image/png;base64,' + base64.b64encode(b'GIF89a' + b'\0' * 50).decode()}, headers=H); assert r.status_code == 422   # imza PNG değil
            assert c.post('/api/support', json={'category': 'perf', 'subject': '', 'body': 'b'}, headers=H).status_code == 422
            assert c.post('/api/support', json={'category': 'perf', 'subject': 'a', 'body': 'b'}).status_code == 403   # CSRF
            # liste yalnız sv kayıtları; ayrıntı mesaj + ek listesi; Merkez yanıtı → unread + mesaj zinciri; kullanıcı yanıtı
            fake.STATE['tickets'][2]['app'] = 'fm'   # başka Mastertool aracının talebi listede görünmez
            lst = c.get('/api/support').json()['tickets']; assert [x['id'] for x in lst] == [1] and lst[0]['status'] == 'acik' and lst[0]['unread'] == 0
            httpx_post = __import__('httpx').post
            httpx_post(f'http://127.0.0.1:{fport}/__fake/reply/1', json={'body': 'Merhaba, günlüğü inceledik; THR_MAX düşük.'})
            assert c.get('/api/support').json()['tickets'][0]['unread'] == 1
            d = c.get('/api/support/1').json()
            assert d['code'] == 'T-0001' and [m['author_kind'] for m in d['messages']] == ['company', 'support'] and d['messages'][1]['body'].startswith('Merhaba') and len(d['files']) == 1 and d['files'][0]['name'] == 'ekran.png'
            assert set(d['messages'][0]) == {'id', 'author_kind', 'author_name', 'body', 'created_at'}
            r = c.post('/api/support/1/reply', json={'body': 'Teşekkürler, deniyorum.'}, headers=H); assert r.status_code == 200, r.text
            assert r.json()['status'] == 'yanit_bekliyor' and r.json()['messages'][-1]['body'] == 'Teşekkürler, deniyorum.' and len(r.json()['files']) == 1
            assert c.get('/api/support/99').status_code == 404 and c.post('/api/support/99/reply', json={'body': 'x'}, headers=H).status_code == 404
            # oran: talep 5/sa/kullanıcı (reddedilen ek/kategori denemeleri de sayılır — yukarıda kova doldu) → 429 + Retry-After; sıfırla → 5 × 201, 6. 429
            r = c.post('/api/support', json={'category': 'perf', 'subject': 'o', 'body': 'b'}, headers=H); assert r.status_code == 429 and r.headers.get('Retry-After')
            sauth.oran_sifirla()
            kodlar = [c.post('/api/support', json={'category': 'perf', 'subject': f'o{i}', 'body': 'b'}, headers=H).status_code for i in range(6)]
            assert kodlar == [201] * 5 + [429], kodlar
            sauth.oran_sifirla()
            # başka kullanıcı kendi talep listesini görür (hesap servisi e-posta ile ayırır); gönderim hatasında ek dosyası silinir
            assert c.get('/api/support', headers=HC).json()['tickets'] == []
            n_once = len(list((config.DATA_DIR / 'files' / 'support').rglob('*')))
            config.MT_INTERNAL = 'http://127.0.0.1:1'
            r = c.post('/api/support', json={'category': 'perf', 'subject': 'a', 'body': 'b', 'screenshot': durl}, headers=H); assert r.status_code == 503 and r.json()['detail']['error'] == 'support_unavailable'
            assert len(list((config.DATA_DIR / 'files' / 'support').rglob('*'))) == n_once
            with sdb_connect() as conn:
                ev = {r[0] for r in conn.execute("SELECT event FROM audit WHERE event LIKE 'support%'").fetchall()}
            assert ev == {'support_create', 'support_reply', 'support_fail'}, ev
        finally:
            config.MT_INTERNAL, config.MT_SHARED_SECRET = eski_mt
            fsrv.shutdown(); fsrv.server_close()

        # ---- hesap servisi özeti (Merkez › Mastertool): sahte hesap servisine PUT /api/sv/profile X-Simumav-Secret ile
        # {pilot, pilots, drones, flights, hours, last_flight_at, version, updated_at}; dev kullanıcı (mt_user_id < 0) göndermez; gizli yoksa göndermez
        from http.server import BaseHTTPRequestHandler, HTTPServer
        import threading
        gelen = []

        class Sahte(BaseHTTPRequestHandler):
            def do_PUT(self):
                gelen.append((self.path, self.headers.get('X-Simumav-Secret'), json.loads(self.rfile.read(int(self.headers['Content-Length'])))))
                self.send_response(200); self.send_header('Content-Type', 'application/json'); self.end_headers(); self.wfile.write(b'{"ok":true}')

            def log_message(self, *a):
                pass
        srv = HTTPServer(('127.0.0.1', 0), Sahte)
        threading.Thread(target=srv.serve_forever, daemon=True).start()
        eski = (config.MT_INTERNAL, config.MT_SHARED_SECRET)
        ali_id = s['user']['id']
        with sdb_connect() as conn:
            dev_mt_id = conn.execute('SELECT mt_user_id FROM users WHERE id = ?', (ali_id,)).fetchone()[0]
        try:
            assert dev_mt_id < 0 and bridge.profil_ozeti(ali_id) is False and not gelen   # dev kullanıcı: mt_user_id negatif
            with sdb_connect() as conn:
                conn.execute('UPDATE users SET mt_user_id = 4242 WHERE id = ?', (ali_id,)); conn.commit()
            config.MT_INTERNAL = f'http://127.0.0.1:{srv.server_address[1]}'
            config.MT_SHARED_SECRET = ''
            assert bridge.profil_ozeti(ali_id) is False and not gelen   # paylaşılan gizli tanımsız → gönderim yok
            config.MT_SHARED_SECRET = 'sv-gizli'
            assert bridge.profil_ozeti(ali_id) is True and len(gelen) == 1
            yol, gizli, govde = gelen[0]
            assert yol == '/api/sv/profile' and gizli == 'sv-gizli' and govde['user_id'] == 4242, gelen
            p = govde['profile']
            assert p['flights'] == 3 and p['hours'] >= 0 and p['pilots'] >= 1 and p['drones'] >= 1 and p['last_flight_at'] and p['version'] == config.VERSION and p['pilot'], p
            assert set(p) == {'pilot', 'pilots', 'drones', 'flights', 'hours', 'last_flight_at', 'version', 'updated_at'}, set(p)
            # çıkış yolu da arka planda gönderir
            c.delete('/api/session', headers=H)
            t0 = time.time()
            while len(gelen) < 2 and time.time() - t0 < 3:
                time.sleep(0.05)
            assert len(gelen) == 2 and gelen[1][2]['profile']['flights'] == 3, len(gelen)
        finally:
            config.MT_INTERNAL, config.MT_SHARED_SECRET = eski
            srv.shutdown(); srv.server_close()
            with sdb_connect() as conn:
                conn.execute('UPDATE users SET mt_user_id = ? WHERE id = ?', (dev_mt_id, ali_id)); conn.commit()
        c.cookies.clear(); giris(c, 'ali'); s_tok = c.cookies.get('smsid')   # aynı users satırı (dev mt_user_id geri yazıldı)

        # ---- oran sınırı: /api/session 10/dk/IP → 429 + Retry-After
        from app.simumav import auth as sauth
        sauth.oran_sifirla()
        codes = [c.post('/api/session', json={'dev_user': 'can'}, headers=HCW).status_code for _ in range(11)]
        assert codes[:10] == [200] * 10 and codes[10] == 429, codes
        r = c.post('/api/session', json={'dev_user': 'can'}, headers=HCW); assert r.status_code == 429 and r.headers.get('Retry-After') and r.json()['detail']['error'] == 'rate_limited'
        sauth.oran_sifirla()
        # çıkış
        c.cookies.clear(); c.cookies.set('smsid', s_tok)   # oran sınaması jar'a 'can' çerezi yazdı; ali'ye dön
        r1 = c.delete('/api/session', headers=H); r2 = c.get('/api/session')
        assert r1.json()['ok'] and r2.status_code == 401, (r1.text, r2.status_code, r2.text[:200])
    print('test_simumav: TAMAM')


if __name__ == '__main__':
    main()
