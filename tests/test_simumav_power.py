"""SIMUMAV güç ve yakıt testleri (docs/simumav.md §10; HEPGO çekirdeği docs/ucus-simulatoru.md §23).

Kapsam: drones.power göçü (eski taban: sütun yok → ALTER, mevcut dron bozulmaz, model varsayılanı), katalog/meta güç bilgisi, hangar doğrulaması
(sınırlar, bool/NaN/dize, bilinmeyen anahtar, ölçüm alanı istemciden, kopterde yakıt, elektrikliden yakıtlıya, reset_power, audit power_reject),
fly/start → power çekirdek oturumuna TAM ulaşır (sihirbaz gövdesi hangarın üstüne), başlangıç simülasyon hızı (≤ SIMUMAV_MAX_SPEEDUP; bekçi yazar),
speed/param_set sınırları (WS + REST; SIM_* yalnız sunucu), bekçi SIM_SPEEDUP'u geri çeker, sahte uçuşta yakıt/batarya biter → WS warn + uçuş sürer,
stop → flights.summary.power (ölçülen km/L, ortalama W) + dron kaydına ölçüm (measured, sonraki uçuşta önerilen), çekirdek drone_sim_runs satırı
(shim şeması §23 sütunları — kaydet INSERT'i artık düşmüyor), başkasının dronu 404.

Çalıştırma: ./.venv/bin/python -m tests.test_simumav_power
"""
import json
import os
import sqlite3
import sys
import tempfile
import time

D = tempfile.mkdtemp(prefix='simumav-power-')
os.environ.update(SIMUMAV_DATA_DIR=D, SIMUMAV_DEV_LOGIN='1', HEPGO_SITL='0', SIMUMAV_UDP_BASE='24850', SIMUMAV_MAX_FLIGHTS='2', SIMUMAV_MP_PORT_BASE='25700',
                  SIMUMAV_MP_PORT_COUNT='40', SIMUMAV_SECURE_COOKIE='0', SIMUMAV_ENV_FILE=os.path.join(D, 'yok.env'), SIMUMAV_MAX_SPEEDUP='4',
                  SIMUMAV_MT_INTERNAL='http://127.0.0.1:1', GOOGLE_MAPS_API_KEY='')
for k in [k for k in sys.modules if k == 'app' or k.startswith('app.')]:
    del sys.modules[k]

from fastapi.testclient import TestClient  # noqa: E402

import app.simumav.main as smain  # noqa: E402
from app import flightsim, flightsim_power  # noqa: E402
from app.simumav import bridge, config, power  # noqa: E402
from app.simumav import db as sdb  # noqa: E402

ORIGIN = 'http://127.0.0.1:8600'
H = {'Origin': ORIGIN}


def eski_taban():
    """Göç öncesi simumav.db: drones tablosunda `power` sütunu YOK; içinde bir kullanıcı + eski CAYMAZ dronu."""
    sema = '\n'.join(s for s in sdb.SCHEMA.splitlines() if not s.strip().startswith(('power TEXT', '--   fuel_km_per_l_last')))
    assert 'power TEXT' not in sema
    with sqlite3.connect(config.DB_PATH) as c:
        c.executescript(sema)
        t = '2026-01-01T00:00:00'
        c.execute("INSERT INTO users (id, mt_user_id, email, display_name, created_at, updated_at) VALUES (1, -77, 'e@x', 'eski', ?, ?)", (t, t))
        c.execute("INSERT INTO drones (id, user_id, name, type, model_key, params, color, created_at, updated_at) VALUES (1, 1, 'Eski Caymaz', 'plane', 'builtin:caymaz', '{}', '#ff0000', ?, ?)", (t, t))
        c.commit()


def bekle(kosul, sure=20.0, adim=0.05):
    son = time.time() + sure
    while time.time() < son:
        if kosul():
            return True
        time.sleep(adim)
    return kosul()


def main():
    eski_taban()
    config.RATE['write'] = (100000, 60)
    config.RATE['read'] = (100000, 60)
    with TestClient(smain.app, base_url=ORIGIN) as c:
        # ---- göç: sütun eklendi, eski kayıt bozulmadı (NULL → model varsayılanı)
        with sqlite3.connect(config.DB_PATH) as cc:
            assert 'power' in {r[1] for r in cc.execute('PRAGMA table_info(drones)')}
            assert cc.execute('SELECT name, power FROM drones WHERE id = 1').fetchone() == ('Eski Caymaz', None)
        r = c.post('/api/session', json={'dev_user': 'eski'}, headers=H); assert r.status_code == 200, r.text
        # dev login 'eski' yeni mt_user_id üretir; eski satırı doğrudan bu kullanıcıya bağlayıp API'den okut
        uid = r.json()['user']['id']
        with sqlite3.connect(config.DB_PATH) as cc:
            cc.execute('UPDATE drones SET user_id = ? WHERE id = 1', (uid,)); cc.commit()
        eski = next(d for d in c.get('/api/hangar').json()['drones'] if d['id'] == 1)
        assert eski['name'] == 'Eski Caymaz' and eski['color'] == '#ff0000' and eski['power']['defaults'] is True, eski['power']
        assert eski['power']['engine'] == 'fuel' and eski['power']['max_speed_ms'] == 45.0 and eski['power']['fuel_l'] == 5.0 and eski['power']['measured'] is None

        # ---- hazır FPV dronu: elektrikli, makul batarya (4S 1500 mAh 180 W ≈ 7 dk)
        fpv = next(d for d in c.get('/api/hangar').json()['drones'] if d['type'] == 'fpv')
        assert fpv['power'] == {'engine': 'electric', 'max_speed_ms': None, 'fuel_l': 0.0, 'fuel_km_per_l': 25.0, 'elec_cells': 4, 'elec_mah': 1500.0, 'elec_w': 180.0,
                                'defaults': True, 'measured': None}, fpv['power']

        # ---- katalog + meta: model başına varsayılan, sınırlar, hız seçenekleri sunucu üst sınırıyla
        cat = c.get('/api/hangar/catalog').json()
        assert cat['power']['limits']['max_speed_ms'] == [5.0, 150.0] and cat['power']['speedups'] == [1, 2, 4] and cat['power']['max_speedup'] == 4
        assert cat['power']['fuel_types'] == ['plane', 'interceptor', 'vtol'] and cat['power']['stock_max_ms'] == 31.8
        mods = {m['key']: m for t in cat['types'] for m in t['models']}
        assert mods['glb:jet']['power']['engine'] == 'fuel' and mods['glb:jet']['power']['max_speed_ms'] == 150.0
        assert mods['glb:iris']['power']['engine'] == 'electric' and mods['glb:iris']['power']['max_speed_ms'] is None
        assert all(m['power']['fuel_l'] == 0.0 for t in cat['types'] if t['key'] in ('fpv', 'multirotor', 'heli') for m in t['models'])
        assert c.get('/api/meta').json()['power']['speedups'] == [1, 2, 4]

        # ---- hangar doğrulaması
        def post(body):
            return c.post('/api/hangar', json={'name': 'G', 'type': 'plane', 'model_key': 'builtin:caymaz', **body}, headers=H)
        kotuler = [{'max_speed_ms': 151}, {'max_speed_ms': 4}, {'fuel_l': 501}, {'fuel_l': -1}, {'fuel_km_per_l': 0.1}, {'elec_cells': 17}, {'elec_cells': 0},
                   {'elec_mah': 50}, {'elec_w': 2001}, {'elec_w': True}, {'fuel_l': '5'}, {'engine': 'nuclear'}, {'fuel_km_per_l_last': 99},
                   {'elec_w_last': 1}, {'measured_at': 'x'}, {'hack': 1}, {'engine': 'fuel', 'fuel_l': 0.05}, {f'k{i}': 1 for i in range(13)}]
        for kotu in kotuler:
            r = post({'power': kotu}); assert r.status_code == 422 and r.json()['detail']['error'] == 'invalid', (kotu, r.text)
        r = c.post('/api/hangar', json={'name': 'G', 'type': 'plane', 'model_key': 'builtin:caymaz', 'power': 'x'}, headers=H); assert r.status_code == 422
        # NaN/∞ JSON'da: Python json NaN'ı yazar → sunucu "sayı olmalı" der
        r = c.post('/api/hangar', content=json.dumps({'name': 'G', 'type': 'plane', 'model_key': 'builtin:caymaz', 'power': {'elec_w': float('nan')}}),
                   headers={**H, 'Content-Type': 'application/json'}); assert r.status_code == 422, r.text
        with sqlite3.connect(config.DB_PATH) as cc:
            assert cc.execute("SELECT COUNT(*) FROM audit WHERE event = 'power_reject'").fetchone()[0] >= len(kotuler)
        # kopterde yakıtlı motor reddi; azami hız yok sayılır
        r = c.post('/api/hangar', json={'name': 'Q', 'type': 'multirotor', 'model_key': 'glb:iris', 'power': {'engine': 'fuel'}}, headers=H); assert r.status_code == 422
        r = c.post('/api/hangar', json={'name': 'Q', 'type': 'multirotor', 'model_key': 'glb:iris', 'power': {'max_speed_ms': 60, 'elec_mah': 6000}}, headers=H)
        assert r.status_code == 201 and r.json()['power']['max_speed_ms'] is None and r.json()['power']['elec_mah'] == 6000.0 and r.json()['power']['fuel_l'] == 0.0
        qid = r.json()['id']
        # uçak: elektrikli ↔ yakıtlı, kısmi PUT (diğer alanlar korunur), reset_power
        r = post({'power': {'engine': 'fuel', 'max_speed_ms': 50, 'fuel_l': 6.5, 'fuel_km_per_l': 22, 'elec_cells': 6, 'elec_mah': 12000, 'elec_w': 35}})
        assert r.status_code == 201, r.text
        pl = r.json(); plid = pl['id']
        assert pl['power']['engine'] == 'fuel' and pl['power']['fuel_l'] == 6.5 and pl['power']['elec_cells'] == 6 and pl['power']['defaults'] is False
        r = c.put(f'/api/hangar/{plid}', json={'power': {'engine': 'electric'}}, headers=H)
        assert r.json()['power']['engine'] == 'electric' and r.json()['power']['fuel_l'] == 0.0 and r.json()['power']['max_speed_ms'] == 50.0 and r.json()['power']['elec_mah'] == 12000.0
        r = c.put(f'/api/hangar/{plid}', json={'power': {'engine': 'fuel'}}, headers=H)   # yakıtlıya dönüş: depo tip varsayılanı (5 L)
        assert r.json()['power']['engine'] == 'fuel' and r.json()['power']['fuel_l'] == 5.0
        r = c.put(f'/api/hangar/{plid}', json={'power': {'fuel_l': 7}, 'name': 'Güçlü'}, headers=H)
        assert r.json()['power']['fuel_l'] == 7.0 and r.json()['name'] == 'Güçlü' and r.json()['power']['elec_cells'] == 6
        r = c.put(f'/api/hangar/{plid}', json={'name': 'Güçlü-2'}, headers=H); assert r.json()['power']['fuel_l'] == 7.0   # güç gönderilmedi → değişmez
        assert c.put(f'/api/hangar/{plid}', json={'power': {'fuel_l': 900}}, headers=H).status_code == 422
        r = c.put(f'/api/hangar/{plid}', json={'reset_power': True}, headers=H); assert r.json()['power']['defaults'] is True and r.json()['power']['fuel_l'] == 5.0
        c.delete(f'/api/hangar/{plid}', headers=H)
        # bozuk JSON kaydı → varsayılana düşer (API patlamaz)
        with sqlite3.connect(config.DB_PATH) as cc:
            cc.execute("UPDATE drones SET power = '{bozuk' WHERE id = ?", (qid,)); cc.commit()
        assert next(d for d in c.get('/api/hangar').json()['drones'] if d['id'] == qid)['power']['defaults'] is True
        with sqlite3.connect(config.DB_PATH) as cc:   # elle bozulmuş (kopterde yakıt) → varsayılan
            cc.execute("""UPDATE drones SET power = '{"engine":"fuel","fuel_l":9}' WHERE id = ?""", (qid,)); cc.commit()
        q = next(d for d in c.get('/api/hangar').json()['drones'] if d['id'] == qid)
        assert q['power']['engine'] == 'electric' and q['power']['fuel_l'] == 0.0
        c.delete(f'/api/hangar/{qid}', headers=H)

        # ---- parametre beyaz listesi: SIM_SPEEDUP / SIM_PLN_THR_MUL / SIM_SRV_REV hangar params'ında reddedilir
        for ad in ('SIM_SPEEDUP', 'SIM_PLN_THR_MUL', 'SIM_SRV_REV'):
            assert post({'params': {ad: 2}}).status_code == 422, ad

        # ---- fly/start: sihirbaz gövdesi hangarın üstüne → çekirdek oturumunda TAM power; speedup ≤ 4; hatalar 422
        tid = c.get('/api/tracks').json()['tracks'][0]['id']
        pid = c.get('/api/crew').json()['pilots'][0]['id']
        r = post({'name': 'Yakıtçı', 'power': {'engine': 'fuel', 'max_speed_ms': 40, 'fuel_l': 0.1, 'fuel_km_per_l': 1, 'elec_cells': 1, 'elec_mah': 100, 'elec_w': 20}})
        dr = r.json(); did = dr['id']
        base = {'drone_id': did, 'pilot_id': pid, 'track_id': tid, 'launch': 'wheels', 'record': {'bin': False}}
        for kotu in ({'power': {'fuel_l': 'çok'}}, {'power': {'elec_cells': 99}}, {'power': {'fuel_km_per_l_last': 5}}, {'speedup': 8}, {'speedup': 3}, {'speedup': True}):
            r = c.post('/api/fly/start', json={**base, **kotu}, headers=H)
            assert r.status_code == 422, (kotu, r.text)
        assert c.post('/api/fly/start', json={**base, 'speedup': 8}, headers=H).json()['detail']['error'] == 'speedup_limit'
        # başkasının dronu → 404
        r2 = c.post('/api/session', json={'dev_user': 'baska'}, headers=H); tok2 = r2.cookies.get('smsid')
        c.cookies.clear(); r = c.post('/api/session', json={'dev_user': 'eski'}, headers=H)
        assert c.post('/api/fly/start', json={**base}, headers={**H, 'Cookie': f'smsid={tok2}'}).status_code == 404
        r = c.post('/api/fly/start', json={**base, 'power': {'elec_w': 20}, 'speedup': 4}, headers=H)
        assert r.status_code == 201, r.text
        f = r.json(); fid, sid = f['flight_id'], f['sim_id']
        assert f['speedup'] == 4 and f['power']['engine'] == 'fuel' and f['power']['fuel_l'] == 0.1
        s = bridge.oturum(sid)
        assert s.power == {'max_speed_ms': 40.0, 'fuel_l': 0.1, 'fuel_km_per_l': 1.0, 'elec_cells': 1, 'elec_mah': 100.0, 'elec_w': 20.0}, s.power
        snap = c.get(f'/api/fly/{fid}').json()
        assert snap['snapshot']['power']['fuel_l'] == 0.1 and snap['snapshot']['speedup'] == 4 and snap['session']['power']['max_speed_ms'] == 40.0
        # bekçi: SITL hazır olunca başlangıç hızı (sahte kinematik hızlanır)
        assert bekle(lambda: s.state == 'HAZIR' and s.sahte is not None and s.sahte.speedup == 4.0), (s.state, getattr(s.sahte, 'speedup', None))
        assert bekle(lambda: s.guc.speedup == 4.0)

        CK = {'Cookie': f"smsid={c.cookies.get('smsid')}"}
        with c.websocket_connect(f'/ws/fly/{sid}', headers=CK) as ws:
            assert ws.receive_json()['t'] == 'hello'

            def res(rid):
                for _ in range(400):
                    m = ws.receive_json()
                    if m.get('t') == 'res' and m.get('rid') == rid:
                        return m
                raise AssertionError(rid)
            # speed > MAX_SPEEDUP ve SIM_* param_set reddedilir; 2× kabul
            ws.send_json({'t': 'cmd', 'rid': 's8', 'name': 'speed', 'params': {'factor': 8}}); m = res('s8')
            assert m['ok'] is False and '4×' in m['error'], m
            for ad in ('SIM_SPEEDUP', 'SIM_PLN_THR_MUL', 'sim_wind_spd'):
                ws.send_json({'t': 'cmd', 'rid': f'p{ad}', 'bridge_id': -(9000 + sid), 'sysid': 1, 'name': 'param_set', 'params': {'name': ad, 'value': 8}})
                m = res(f'p{ad}'); assert m['ok'] is False and 'sunucu' in m['error'], m
            ws.send_json({'t': 'cmd', 'rid': 's2', 'name': 'speed', 'params': {'factor': 2}}); assert res('s2')['ok'] is True
            assert bekle(lambda: s.sahte.speedup == 2.0)
            # bekçi: MP'den 8× yazılmış gibi (SITL PARAM_VALUE → guc.hiz_ayarla) → geri çekilir
            s.guc.hiz_ayarla(8.0)
            assert bekle(lambda: s.guc.speedup == 4.0 and s.sahte.speedup == 4.0, 6), (s.guc.speedup, s.sahte.speedup)
            with sqlite3.connect(config.DB_PATH) as cc:
                assert cc.execute("SELECT COUNT(*) FROM audit WHERE event = 'speed_clamp'").fetchone()[0] >= 1
                assert cc.execute("SELECT COUNT(*) FROM audit WHERE event = 'cmd_reject'").fetchone()[0] >= 4
            # REST uyumluluk ucu da aynı sınırlar
            assert c.post(f'/api/drone/sim/sessions/{sid}/cmd', json={'name': 'speed', 'params': {'factor': 8}}, headers=H).status_code == 400
            # kalkış (sahte sabit kanat: pist koşusu) → yakıt/batarya düşer; küçük tank biter → warn fuel_empty, uçuş sürer
            assert c.post(f'/api/drone/sim/sessions/{sid}/cmd', json={'name': 'takeoff', 'params': {'alt': 30}}, headers=H).status_code == 200
            tele, uyarilar = None, set()
            son = time.time() + 40
            while time.time() < son and not ({'fuel_empty', 'elec_empty'} <= uyarilar and s.guc.dist_m >= 400 and s.guc.time_s >= 65):
                m = ws.receive_json()
                if m.get('t') == 'tele':
                    tele = m
                elif m.get('t') == 'warn' and m.get('kind') in ('fuel_empty', 'elec_empty'):
                    uyarilar.add(m['kind'])
            assert {'fuel_empty', 'elec_empty'} <= uyarilar, (uyarilar, s.guc.time_s, s.guc.dist_m)
            assert tele and tele['speedup'] == 4.0 and tele['fuel']['empty'] is True and tele['elec']['pct'] <= 1 and tele['armed'] and s.guc.elec_empty_t is not None, tele
            assert s.state == 'HAZIR'   # yalnız uyarı: oturum sürüyor
        r = c.post(f'/api/fly/{fid}/stop', json={}, headers=H); assert r.status_code == 200, r.text
        pw = r.json()['flight']['summary']['power']
        assert pw['fuel']['used_l'] == 0.1 and pw['fuel']['km_per_l'] and pw['fuel']['empty_t'] is not None, pw
        assert pw['elec']['wh_cap'] == 0.37 and pw['elec']['w_avg'] and pw['elec']['empty_t'] is not None and pw['speedup']['max'] >= 4.0, pw
        assert pw['drone_written'] == {'fuel_km_per_l_last': pw['fuel']['km_per_l'], 'elec_w_last': pw['elec']['w_avg']}, pw
        # dron kaydına ölçüm → sonraki uçuşta "Önerilen" (measured); ayarlar değişmedi
        dd = next(d for d in c.get('/api/hangar').json()['drones'] if d['id'] == did)
        assert dd['power']['measured']['fuel_km_per_l'] == pw['fuel']['km_per_l'] and dd['power']['measured']['elec_w'] == pw['elec']['w_avg'] and dd['power']['measured']['at']
        assert dd['power']['fuel_km_per_l'] == 1.0 and dd['power']['elec_w'] == 20.0
        # istemci ölçüm alanını PUT ile yazamaz; meşru PUT ölçümü korur
        assert c.put(f'/api/hangar/{did}', json={'power': {'elec_w_last': 1}}, headers=H).status_code == 422
        r = c.put(f'/api/hangar/{did}', json={'power': {'elec_w': 25}}, headers=H)
        assert r.json()['power']['elec_w'] == 25.0 and r.json()['power']['measured']['elec_w'] == pw['elec']['w_avg']
        # ops ayrıntısı özetle; çekirdek drone_sim_runs satırı (§23 sütunları shim şemasında) yazıldı
        op = c.get(f'/api/ops/{fid}').json(); assert op['summary']['power']['fuel']['km_per_l'] == pw['fuel']['km_per_l']
        from app import config as core_cfg
        with sqlite3.connect(str(core_cfg.DATA_DIR / 'core.db')) as cc:
            row = cc.execute('SELECT fuel_used_l, elec_w_avg, speedup_max, power FROM drone_sim_runs ORDER BY id DESC LIMIT 1').fetchone()
            assert row and row[0] == 0.1 and row[1] == pw['elec']['w_avg'] and row[2] >= 4.0 and json.loads(row[3])['fuel'], row
            assert 'drone_sitl_options' in {r[0] for r in cc.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        # kopter (FPV): yakıt göstergesi yok, batarya var; power gövdesindeki yakıt/azami hız yok sayılır / reddedilir
        fpv_body = {'drone_id': fpv['id'], 'pilot_id': pid, 'track_id': tid, 'record': {'bin': False}}
        assert c.post('/api/fly/start', json={**fpv_body, 'power': {'engine': 'fuel'}}, headers=H).status_code == 422
        r = c.post('/api/fly/start', json={**fpv_body, 'power': {'max_speed_ms': 99, 'elec_mah': 1300}}, headers=H); assert r.status_code == 201, r.text
        s2 = bridge.oturum(r.json()['sim_id'])
        assert s2.power['max_speed_ms'] is None and s2.power['fuel_l'] == 0.0 and s2.power['elec_mah'] == 1300.0 and s2.guc.fuel_on is False and s2.guc.elec_on
        assert c.post(f"/api/fly/{r.json()['flight_id']}/stop", json={}, headers=H).status_code == 200
    # saf: HEPGO çekirdeği doğrulaması değişmedi (SIMUMAV yalnız kullanır)
    assert flightsim_power.dogrula({'max_speed_ms': 60}, 'multirotor')['max_speed_ms'] is None
    assert power.varsayilan('vtol', 'glb:standard_vtol')['engine'] == 'fuel' and power.varsayilan('heli')['engine'] == 'electric'
    assert 'speed' in flightsim.KOMUTLAR and 'camera' in flightsim.KOMUTLAR
    print('test_simumav_power: TAMAM')


if __name__ == '__main__':
    main()
