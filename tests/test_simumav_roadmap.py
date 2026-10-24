"""SIMUMAV yol haritası sunucu testleri (docs/simumav.md §30): DB v8 göçü (idempotent), oyun türleri (/api/modes, ai önerisi, fly/start
mode doğrulaması), E-POSTA DAVETİ (test kipi OUTBOX; maskeli adres, bağlantı yanıtta, alıcıya bağlı kabul, yanlış hesap 403, ret + engelleme,
kopya/öz-davet atlanır, istek/karşılaşma sınırı, süre dolumu, e-posta kapalıyken mail 'disabled'), ARKADAŞLAR (birlikte oynayanlar otomatik,
elle ekle/sil → gizle, e-postayla ekle, maskeli e-posta), yapay zekâ insan sınırına sayılmaz, PİLOT SEVİYESİ (eğri, madalyalar, sunucu
özetinden XP, idempotent, günlük üst sınır, kimlik yeniden kullanımı, doğrulanmamış aktarım ayrı ve sınırlı), pilota göre uçuş geçmişi,
HANGAR (donanım doğrulama, eklenti SITL parametreleri, script CRUD + sınırlar, çıkartma yeniden kodlama + oturumsuz servis + silme,
Mission Planner parametre hasadı).

Çalıştırma: ./.venv/bin/python -m tests.test_simumav_roadmap
"""
import base64
import io
import json
import os
import sys
import tempfile
import time

D = tempfile.mkdtemp(prefix='simumav-roadmap-test-')
os.environ.update(SIMUMAV_DATA_DIR=D, SIMUMAV_DEV_LOGIN='1', HEPGO_SITL='0', SIMUMAV_UDP_BASE='28750', SIMUMAV_MAX_FLIGHTS='3', SIMUMAV_MP_PORT_BASE='29600',
                  SIMUMAV_MP_PORT_COUNT='40', SIMUMAV_SECURE_COOKIE='0', SIMUMAV_ENV_FILE=os.path.join(D, 'yok.env'), SIMUMAV_MT_INTERNAL='http://127.0.0.1:1',
                  GOOGLE_MAPS_API_KEY='', SIMUMAV_MAIL_TEST='1')
for k in [k for k in sys.modules if k == 'app' or k.startswith('app.')]:
    del sys.modules[k]

from fastapi.testclient import TestClient  # noqa: E402

import app.simumav.main as smain  # noqa: E402
from app import db as core_db  # noqa: E402
from app.simumav import bridge, db, equipment, mailer, modes, social, xp  # noqa: E402
from app.simumav import match as M  # noqa: E402

ORIGIN = 'http://127.0.0.1:8600'


def ok(r, code=200):
    assert r.status_code == code, (r.request.method, r.request.url, r.status_code, r.text)
    return r.json()


class K:
    def __init__(self, c, ad):
        c.cookies.clear()
        r = c.post('/api/session', json={'dev_user': ad}, headers={'Origin': ORIGIN})
        assert r.status_code == 200, r.text
        self.tok = r.cookies.get('smsid')
        self.user = r.json()['user']
        self.id = self.user['id']
        self.email = self.user['email']
        c.cookies.clear()
        self.c = c

    def _h(self, kw, yaz=False):
        h = kw.setdefault('headers', {})
        h['Cookie'] = f'smsid={self.tok}'
        if yaz:
            h['Origin'] = ORIGIN

    def get(self, u, **kw):
        self._h(kw)
        return self.c.get(u, **kw)

    def post(self, u, **kw):
        self._h(kw, True)
        return self.c.post(u, **kw)

    def put(self, u, **kw):
        self._h(kw, True)
        return self.c.put(u, **kw)

    def delete(self, u, **kw):
        self._h(kw, True)
        return self.c.delete(u, **kw)


def png_data(w=64, h=48, fmt='PNG'):
    from PIL import Image
    im = Image.new('RGB', (w, h), (200, 30, 30))
    b = io.BytesIO()
    im.save(b, fmt)
    return f"data:image/{'png' if fmt == 'PNG' else 'jpeg'};base64," + base64.b64encode(b.getvalue()).decode()


def ucus_ekle(uid, pid, summary, dur=300, result='ok', mode=None, started=None, match_id=None):
    t = db.now()
    with db.connect() as conn:
        fid = conn.execute('INSERT INTO flights (user_id, pilot_id, launch, started_at, ended_at, duration_s, result, summary, snapshot, created_at, updated_at, mode, match_id) '
                           "VALUES (?,?,'wheels',?,?,?,?,?,'{}',?,?,?,?)", (uid, pid, started or t, t, dur, result, json.dumps(summary), t, t, mode, match_id)).lastrowid
        conn.commit()
    return fid


def ozet(air=300, dist=4000, alerts=80, armed=False, alt=0.3, in_circle=True, crashes=0, **kw):
    s = {'v': 1, 'flight': {'air_s': air, 'dist_m': dist, 'duration_s': air + 30, 'armed': armed, 'last_pos': {'alt_rel': alt}},
         'alerts': {'score': alerts}, 'crash_count': crashes, 'deviation': {'in_circle': in_circle}}
    s.update(kw)
    return s


def main():
    db.init()
    db.init()   # idempotent
    with db.connect() as conn:
        assert conn.execute('SELECT version FROM schema_version').fetchone()[0] == 8
        for t, cols in (('pilots', {'xp', 'xp_unverified', 'level'}), ('flights', {'mode'}), ('matches', {'mode'}), ('drones', {'equipment'})):
            assert cols <= {r[1] for r in conn.execute(f'PRAGMA table_info({t})')}, t
        for t in ('xp_events', 'match_invites', 'user_contacts', 'invite_blocks', 'drone_scripts', 'drone_decals'):
            assert conn.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (t,)).fetchone(), t

    # ---- saf: seviye eğrisi ve madalyalar
    assert xp.gereken(1) == 0 and xp.gereken(2) == 100 and xp.seviye(0) == 1 and xp.seviye(10 ** 9) == 100
    assert all(xp.CURVE[i] < xp.CURVE[i + 1] for i in range(99))
    b = xp.bilgi(xp.gereken(25), 0)
    assert b['level'] == 25 and [m['id'] for m in b['medals'] if m['earned']] == ['wings_bronze', 'wings_silver', 'wings_gold']
    assert [m['level'] for m in xp.MEDALS] == [5, 10, 25, 50, 75, 100]
    b = xp.bilgi(0, 10 ** 7)   # doğrulanmamış XP sınırlı (≤ seviye 10)
    assert b['xp_unverified'] == xp.IMPORT_CAP and b['level'] == 10 and b['level_verified'] == 1
    assert all(not m['verified'] for m in b['medals'])
    # saf: tür puanı yalnız sunucu özetinden
    p = modes.puanla('free', ozet(), result='ok')
    assert p['air_time'] == 30 and p['distance'] == 40 and p['discipline'] == 40 and p['soft_landing'] == 40, p
    p = modes.puanla('free', ozet(armed=True), result='ok')
    assert 'soft_landing' not in p
    p = modes.puanla('free', {**ozet(), 'gates': {'passed': 999}}, result='ok')   # istemci sayımı XP'ye girmez
    assert 'gates' not in p and sum(p.values()) == 150
    assert modes.mac_puani('rings', 1, True, 10, True, 2, 3) == {'rings': 50, 'match_rank': 100, 'win': 50}
    assert modes.mac_puani('rings', 1, True, 10, True, 1, 3) == {'rings': 25, 'match_rank': 50, 'win': 25}   # yalnız yapay zekâya karşı × 0,5
    assert modes.ai_onerisi('dogfight')['count'] == 1 and modes.ai_onerisi('rings')['count'] == 0
    assert modes.ai_onerisi('facility_defense', defend_waves=3)['count'] == 2 + 3 + 4
    assert modes.ai_onerisi('rings', players=3)['count'] == 5
    try:
        modes.dogrula('facility_defense', 'fly', 'multirotor')
        raise AssertionError('savunma kopterle açılmamalı')
    except modes.ModHata:
        pass

    c = TestClient(smain.app)
    with c:
        a, b_, x = K(c, 'ali'), K(c, 'berk'), K(c, 'ceyda')
        # ---- oyun türleri
        md = ok(a.get('/api/modes'))
        assert [m['id'] for m in md['modes']] == list(modes.MODE_IDS) and md['engagement_rule'] == 'hud_lock_only'
        assert next(m for m in md['modes'] if m['id'] == 'ship_defense')['engagement'] == 'hud_lock_only'
        assert ok(a.get('/api/modes/dogfight/ai'))['count'] == 1
        assert a.get('/api/modes/yok/ai').status_code == 404
        dr = ok(a.get('/api/hangar'))['drones'][0]
        pid = ok(a.get('/api/crew'))['pilots'][0]['id']
        tid = ok(a.get('/api/tracks'))['tracks'][0]['id']
        r = a.post('/api/fly/start', json={'drone_id': dr['id'], 'pilot_id': pid, 'track_id': tid, 'mode': 'rings'})
        assert r.status_code == 422 and 'karşılaşma' in r.text, r.text
        r = a.post('/api/fly/start', json={'drone_id': dr['id'], 'pilot_id': pid, 'track_id': tid, 'mode': 'facility_defense'})
        assert r.status_code == 422, r.text   # FPV dron savunmaya giremez

        # ---- karşılaşma + e-posta daveti
        mm = ok(a.post('/api/match', json={'drone_id': dr['id'], 'track_id': tid, 'password': 'gizli123', 'max_players': 3, 'mode': 'rings'}), 201)
        mid = mm['id']
        assert mm['mode'] == 'rings' and mm['max_vehicles'] >= 3
        assert a.post('/api/match', json={'drone_id': dr['id'], 'track_id': tid, 'password': 'gizli123', 'max_players': 2, 'mode': 'dogfight', 'kind': 'rings'}).status_code == 422
        with db.connect() as conn:
            assert conn.execute('SELECT mode FROM matches WHERE id = ?', (mid,)).fetchone()[0] == 'rings'
        assert b_.post(f'/api/match/{mid}/invites', json={'emails': ['z@ornek.com']}).status_code == 404   # oyuncu değil
        mailer.OUTBOX.clear()
        inv = ok(a.post(f'/api/match/{mid}/invites', json={'emails': [b_.email, 'yeni.kisi@ornek.com', 'YENI.kisi@ornek.com ', a.email]}), 201)
        assert inv['mail_enabled'] is True and len(inv['invites']) == 2, inv
        assert {s['reason'] for s in inv['skipped']} == {'self'}
        for i in inv['invites']:
            assert '***' in i['email'] and '@' in i['email'] and i['link'].startswith('https://simumav.com/app/#/match/invite/') and i['state'] == 'pending'
        assert len(mailer.OUTBOX) == 2
        hesapsiz = next(o for o in mailer.OUTBOX if o['to'] == 'yeni.kisi@ornek.com')
        assert 'hesabınız yok' in hesapsiz['text'] and 'ali' in hesapsiz['subject']
        hesapli = next(o for o in mailer.OUTBOX if o['to'] == b_.email)
        assert 'Henüz SIMUMAV hesabınız yok' not in hesapli['text']
        with db.connect() as conn:
            assert {r[0] for r in conn.execute('SELECT mail FROM match_invites WHERE match_id = ?', (mid,))} == {'sent'}
            assert all(len(r[0]) == 64 for r in conn.execute('SELECT token_hash FROM match_invites'))   # düz belirteç saklanmaz
        tok_b = next(i['link'] for i in inv['invites'] if i['email'] == social.avatar.maske_eposta(b_.email)).rsplit('/', 1)[1]
        tok_y = next(i['link'] for i in inv['invites'] if i['email'] == social.avatar.maske_eposta('yeni.kisi@ornek.com')).rsplit('/', 1)[1]
        # kopya davet atlanır
        inv2 = ok(a.post(f'/api/match/{mid}/invites', json={'emails': [b_.email]}), 201)
        assert inv2['invites'] == [] and inv2['skipped'][0]['reason'] == 'duplicate'
        assert a.post(f'/api/match/{mid}/invites', json={'emails': ['bozuk']}).status_code == 422
        assert a.post(f'/api/match/{mid}/invites', json={'emails': [f'u{i}@x.com' for i in range(26)]}).status_code == 422
        # oyun içi bildirim
        gk = ok(b_.get('/api/invites'))
        assert gk['count'] == 1 and gk['invites'][0]['match_id'] == mid and gk['invites'][0]['inviter']['name'] == 'ali' and gk['invites'][0]['mode'] == 'rings'
        assert ok(x.get('/api/invites'))['count'] == 0
        # oturumsuz ön izleme
        c.cookies.clear()
        on = ok(c.get(f'/api/invites/t/{tok_y}'))
        assert on['state'] == 'pending' and on['mode'] == 'rings' and '***' in on['email_hint'] and on['requires_login']
        assert c.get('/api/invites/t/' + 'A' * 32).status_code == 404
        # yanlış hesap kabul edemez
        r = x.post(f'/api/invites/t/{tok_y}/accept')
        assert r.status_code == 403 and 'wrong_account' in r.text
        assert x.post(f"/api/invites/{gk['invites'][0]['id']}/accept").status_code == 404
        # doğru alıcı kabul → şifresiz lobi
        lob = ok(b_.post(f'/api/invites/t/{tok_b}/accept'))
        assert b_.id in [p['id'] for p in lob['players']]
        assert b_.post(f'/api/invites/t/{tok_b}/accept').status_code == 409   # zaten kabul
        assert ok(b_.get('/api/invites'))['count'] == 0
        # yapay zekâ insan sınırına sayılmaz (max_players 3 insan; tavan oyuncu_siniri = 3 araç)
        ok(a.post(f'/api/match/{mid}/bot', json={'level': 'easy'}))
        r = a.post(f'/api/match/{mid}/bot', json={'level': 'easy'})
        assert r.status_code == 409 and 'yapay zekâ' in r.text, r.text   # SIMUMAV_MAX_FLIGHTS=3 → toplam 3 araç
        # liste + geri alma
        li = ok(a.get(f'/api/match/{mid}/invites'))
        assert {i['state'] for i in li['invites']} == {'accepted', 'pending'}
        yid = next(i['id'] for i in li['invites'] if i['state'] == 'pending')
        ok(a.delete(f'/api/match/{mid}/invites/{yid}'))
        assert next(i for i in ok(a.get(f'/api/match/{mid}/invites'))['invites'] if i['id'] == yid)['state'] == 'revoked'
        # ret + engelleme: ceyda davet edilir, engeller; sonraki davet e-posta göndermez ama kurucuya 'sent' görünür
        inv3 = ok(a.post(f'/api/match/{mid}/invites', json={'emails': [x.email]}), 201)
        iid3 = inv3['invites'][0]['id']
        assert ok(x.post(f'/api/invites/{iid3}/decline', json={'block': True}))['blocked'] is True
        with db.connect() as conn:
            assert conn.execute('SELECT COUNT(*) FROM invite_blocks WHERE user_id = ? AND blocked_id = ?', (x.id, a.id)).fetchone()[0] == 1
            conn.execute("DELETE FROM match_invites WHERE id = ?", (iid3,))
            conn.commit()
        mailer.OUTBOX.clear()
        inv4 = ok(a.post(f'/api/match/{mid}/invites', json={'emails': [x.email]}), 201)
        assert inv4['invites'][0]['mail'] == 'sent' and mailer.OUTBOX == [] and ok(x.get('/api/invites'))['count'] == 0
        assert len(ok(x.get('/api/invites/blocks'))['blocks']) == 1
        ok(x.delete(f'/api/invites/blocks/{a.id}'))
        # e-posta kapalı: davet oluşur, mail 'disabled', bağlantı yanıtta
        os.environ['SIMUMAV_MAIL_TEST'] = '0'
        try:
            inv5 = ok(a.post(f'/api/match/{mid}/invites', json={'emails': ['kapali@ornek.com']}), 201)
            assert inv5['mail_enabled'] is False and inv5['invites'][0]['mail'] == 'disabled' and inv5['invites'][0]['link']
        finally:
            os.environ['SIMUMAV_MAIL_TEST'] = '1'
        # süre dolumu (karşılaşma salondan çıkınca da): yapay olarak süre geçmişe
        with db.connect() as conn:
            conn.execute("UPDATE match_invites SET expires_ts = ? WHERE email = 'kapali@ornek.com'", (time.time() - 1,))
            conn.commit()
        assert next(i for i in ok(a.get(f'/api/match/{mid}/invites'))['invites'] if i['email'] == social.avatar.maske_eposta('kapali@ornek.com'))['state'] == 'expired'
        # karşılaşma sınırı
        old = social.INVITE_MAX_PER_MATCH
        social.INVITE_MAX_PER_MATCH = 3
        try:
            r = a.post(f'/api/match/{mid}/invites', json={'emails': ['s1@ornek.com', 's2@ornek.com', 's3@ornek.com']})
            assert r.status_code == 409 and 'invite_limit' in r.text
        finally:
            social.INVITE_MAX_PER_MATCH = old
        ok(a.post(f'/api/match/{mid}/cancel'))

        # ---- arkadaşlar: birlikte oynanmış (başlamış/bitmiş) karşılaşma otomatik (bellekteki iptal kaydı bitmiş sayılsın diye bellekten düşürülür)
        time.sleep(0.5)
        M.MANAGER.cikar(M.MANAGER.get(mid))
        with db.connect() as conn:
            conn.execute("UPDATE matches SET state = 'BITTI', started_at = ?, ended_at = ? WHERE id = ?", (db.now(), db.now(), mid))
            conn.commit()
        fr = ok(a.get('/api/friends'))['friends']
        assert [f['user_id'] for f in fr] == [b_.id] and fr[0]['auto'] and fr[0]['played_count'] == 1 and '***' in fr[0]['email'] and fr[0]['last_played_at']
        assert x.post('/api/friends', json={'user_id': a.id}).status_code == 404   # birlikte uçmadılar
        assert x.post('/api/friends', json={'email': 'yok@yok.com'}).status_code == 404
        f2 = ok(x.post('/api/friends', json={'email': a.email.upper()}), 201)
        assert f2['user_id'] == a.id and f2['friend'] and not f2['auto']
        ok(a.delete(f'/api/friends/{b_.id}'))   # otomatik → gizli
        assert ok(a.get('/api/friends'))['friends'] == []
        ok(a.post('/api/friends', json={'user_id': b_.id}), 201)
        assert ok(a.get('/api/friends'))['friends'][0]['friend']
        assert a.post('/api/friends', json={'user_id': a.id}).status_code in (404, 422)
        # davette arkadaştan seç
        m2 = ok(a.post('/api/match', json={'drone_id': dr['id'], 'track_id': tid, 'password': 'gizli123', 'max_players': 2}), 201)
        mailer.OUTBOX.clear()
        inv6 = ok(a.post(f"/api/match/{m2['id']}/invites", json={'friend_ids': [b_.id]}), 201)
        assert len(inv6['invites']) == 1 and mailer.OUTBOX[0]['to'] == b_.email
        assert a.post(f"/api/match/{m2['id']}/invites", json={'friend_ids': [x.id]}).status_code == 404
        ok(a.post(f"/api/match/{m2['id']}/cancel"))
        assert ok(b_.get('/api/invites'))['count'] == 0   # karşılaşma iptal → davet geçersiz

        # ---- XP: sunucu özetinden, idempotent; karşılaşma bileşeni
        bpid = ok(b_.get('/api/crew'))['pilots'][0]['id']
        f1 = ucus_ekle(b_.id, bpid, ozet(), mode='free')
        ucus_ekle(b_.id, bpid, ozet(air=5), mode='free')   # < 10 sn → XP yok
        with db.connect() as conn:
            conn.execute('UPDATE match_players SET flight_id = ?, rank = 2, rings = 6, time_s = 80 WHERE match_id = ? AND user_id = ?', (f1, mid, b_.id))
            conn.commit()
        lv = ok(b_.get(f'/api/crew/{bpid}/level'))
        assert lv['xp_verified'] == 150 + 30 + 60 and lv['level'] == 2, lv   # uçuş 150 + karşılaşma (6 halka 30 + 2. sıra 60; 2 insan → tam)
        lv2 = ok(b_.get(f'/api/crew/{bpid}/level'))
        assert lv2['xp_verified'] == lv['xp_verified']   # idempotent
        assert {e['source'] for e in lv['events']} == {'flight', 'match'}
        pl = ok(b_.get('/api/crew'))['pilots'][0]
        assert pl['level'] == 2 and pl['xp'] == lv['xp'] and 'medals' in pl and pl['next_level_xp'] == xp.gereken(3)
        assert ok(b_.get('/api/crew/levels'))['curve'][99] == xp.gereken(100)
        # pilota göre uçuş geçmişi
        fl = ok(b_.get(f'/api/crew/{bpid}/flights'))
        assert fl['total'] == 2 and fl['flights'][0]['mode'] == 'free' and {f['xp'] for f in fl['flights']} == {150, 0}
        assert ok(b_.get(f'/api/crew/{bpid}/flights?mode=spraying'))['total'] == 0
        assert ok(b_.get(f'/api/ops?pilot_id={bpid}'))['total'] == 2
        assert a.get(f'/api/crew/{bpid}/flights').status_code == 404
        # günlük üst sınır
        old = xp.DAILY_CAP
        xp.DAILY_CAP = 300
        try:
            ucus_ekle(b_.id, bpid, ozet(air=2700, dist=50000), mode='free')
            lv3 = ok(b_.get(f'/api/crew/{bpid}/level'))
            assert lv3['xp_verified'] == 300 and lv3['events'][0]['capped'], lv3['events'][0]
        finally:
            xp.DAILY_CAP = old
        # satır kimliği yeniden kullanımı: en son uçuş silinip yeni uçuş aynı kimliği alırsa eski XP korunur, yeni uçuş da sayılır
        with db.connect() as conn:
            son = conn.execute('SELECT MAX(id) FROM flights').fetchone()[0]
            conn.execute('DELETE FROM flights WHERE id = ?', (son,))
            conn.commit()
        time.sleep(1.1)
        yeni = ucus_ekle(b_.id, bpid, ozet(air=100, dist=0, alerts=None), mode='free', started=db.now())
        assert yeni == son
        lv4 = ok(b_.get(f'/api/crew/{bpid}/level'))
        assert lv4['xp_verified'] == 300 + 10 + 40, lv4['xp_verified']
        # doğrulanmamış aktarım
        im = ok(b_.post(f'/api/crew/{bpid}/xp/import', json={'entries': [{'xp': 1000, 'mode': 'free'}] * 20}))
        assert im['imported'] == xp.IMPORT_CAP and im['xp_unverified'] == xp.IMPORT_CAP and im['level_verified'] < im['level']
        assert b_.post(f'/api/crew/{bpid}/xp/import', json={'entries': [{'xp': 5000}]}).status_code == 422
        im2 = ok(b_.post(f'/api/crew/{bpid}/xp/import', json={'entries': [{'xp': 10}]}))
        assert im2['imported'] == 0 and im2['remaining_cap'] == 0
        with db.connect() as conn:
            assert conn.execute("SELECT COUNT(*) FROM xp_events WHERE source = 'import' AND verified = 1").fetchone()[0] == 0
        # TOP 10 doğrulanmamış XP'yi kullanmaz (avatar.siralama xp_events'e bakmaz)
        from app.simumav import avatar as av
        with db.connect() as conn:
            assert all('xp' not in (r.get('parts') or {}) for r in av.siralama(conn, 'all'))

        # ---- hangar donanımı
        eqc = ok(a.get('/api/hangar/equipment'))
        assert eqc['cameras'] == ['day', 'night', 'thermal', 'multispectral'] and set(eqc['addons']) == {'sprayer', 'gripper', 'parachute'}
        assert eqc['scripts']['run_on_server'] is False
        r = a.post('/api/hangar', json={'name': 'Ilac-1', 'type': 'multirotor', 'model_key': 'glb:iris',
                                        'equipment': {'camera': 'multispectral', 'addons': {'sprayer': {'tank_l': 16}, 'parachute': True}, 'max_alt_m': 120,
                                                      'livery': {'pattern': 'stripe', 'color2': '#00FF00', 'callsign': 'tr-01'}}})
        d1 = ok(r, 201)
        assert d1['equipment']['camera'] == 'multispectral' and d1['equipment']['addons']['sprayer']['tank_l'] == 16 and d1['equipment']['livery']['callsign'] == 'TR-01'
        assert a.post('/api/hangar', json={'name': 'X', 'type': 'plane', 'model_key': 'glb:rc_cessna', 'equipment': {'addons': {'sprayer': True}}}).status_code == 422
        assert a.post('/api/hangar', json={'name': 'X', 'type': 'multirotor', 'model_key': 'glb:iris', 'equipment': {'camera': 'xray'}}).status_code == 422
        assert a.post('/api/hangar', json={'name': 'X', 'type': 'multirotor', 'model_key': 'glb:iris', 'equipment': {'bad': 1}}).status_code == 422
        sp = equipment.sitl_params('multirotor', d1['equipment'])
        assert sp['SPRAY_ENABLE'] == 1 and sp['SERVO9_FUNCTION'] == 22 and sp['CHUTE_ENABLED'] == 1 and sp['SERVO12_FUNCTION'] == 27 and 'GRIP_ENABLE' not in sp
        assert equipment.sitl_params('plane', {'addons': {'sprayer': {}}}) == {}
        # kullanıcı ince ayarı beyaz listede, SERVO işlevi değil
        ok(a.put(f"/api/hangar/{d1['id']}", json={'params': {'SPRAY_PUMP_RATE': 25, 'CHUTE_ALT_MIN': 15}}))
        assert a.put(f"/api/hangar/{d1['id']}", json={'params': {'SERVO9_FUNCTION': 0}}).status_code == 422
        # script'ler
        sc = ok(a.post(f"/api/hangar/{d1['id']}/scripts", json={'name': 'pompa.lua', 'content': 'function update() return update, 1000 end\nreturn update()'}), 201)
        assert sc['size'] > 0 and len(sc['sha256']) == 64 and sc['run_on_server'] is False
        assert a.post(f"/api/hangar/{d1['id']}/scripts", json={'name': 'pompa.lua', 'content': 'x'}).status_code == 409
        assert a.post(f"/api/hangar/{d1['id']}/scripts", json={'name': '../x.lua', 'content': 'x'}).status_code == 422
        assert a.post(f"/api/hangar/{d1['id']}/scripts", json={'name': 'b.lua', 'content': 'x' * (64 * 1024 + 1)}).status_code == 422
        assert b_.get(f"/api/hangar/{d1['id']}/scripts").status_code == 404
        ok(a.put(f"/api/hangar/{d1['id']}/scripts/{sc['id']}", json={'content': '-- v2', 'enabled': False}))
        g = ok(a.get(f"/api/hangar/{d1['id']}/scripts/{sc['id']}"))
        assert g['content'] == '-- v2' and g['enabled'] is False
        dl = a.get(f"/api/hangar/{d1['id']}/scripts/{sc['id']}/download")
        assert dl.status_code == 200 and dl.content == b'-- v2' and 'attachment' in dl.headers['content-disposition']
        # çıkartmalar
        dc = ok(a.post(f"/api/hangar/{d1['id']}/decals", json={'image': png_data(2000, 500), 'kind': 'logo'}), 201)
        assert dc['width'] == 1024 and dc['height'] == 256 and dc['url'].startswith('/api/hangar/decals/')
        c.cookies.clear()
        fr_ = c.get(dc['url'])
        assert fr_.status_code == 200 and fr_.content[:8] == b'\x89PNG\r\n\x1a\n' and fr_.headers['x-content-type-options'] == 'nosniff' and 'sandbox' in fr_.headers['content-security-policy']
        dj = ok(a.post(f"/api/hangar/{d1['id']}/decals", json={'image': png_data(32, 32, 'JPEG')}), 201)
        assert a.post(f"/api/hangar/{d1['id']}/decals", json={'image': 'data:image/png;base64,' + base64.b64encode(b'<svg/>').decode()}).status_code == 422
        assert a.post(f"/api/hangar/{d1['id']}/decals", json={'image': 'data:image/gif;base64,R0lG'}).status_code == 422
        ok(a.put(f"/api/hangar/{d1['id']}", json={'equipment': {**d1['equipment'], 'livery': {'pattern': 'solid', 'decals': [{'id': dc['id'], 'slot': 'top', 'scale': 1.2}]}}}))
        assert a.put(f"/api/hangar/{d1['id']}", json={'equipment': {'livery': {'decals': [{'id': 99999, 'slot': 'top'}]}}}).status_code == 422
        ok(a.delete(f"/api/hangar/{d1['id']}/decals/{dc['id']}"))
        assert c.get(dc['url']).status_code == 404
        assert ok(a.get('/api/hangar'))['drones'][-1]['equipment']['livery']['decals'] == []
        yol = os.path.join(D, 'files', 'decals', str(a.id))
        assert len(os.listdir(yol)) == 1
        ok(a.delete(f"/api/hangar/{d1['id']}"))
        assert os.listdir(yol) == [] and c.get(dj['url']).status_code == 404

        # ---- Mission Planner parametre hasadı (çekirdek drone_sitl_params → drones.params; beyaz liste, eklenti sabitleri hariç)
        with core_db.connect() as cc:
            cc.executemany("INSERT OR REPLACE INTO drone_sitl_params (drone_id, name, value, ptype, updated_at, updated_by, source) VALUES (?,?,?,9,?,?,?)",
                           [(dr['id'], 'ATC_RAT_RLL_P', 0.21, core_db.now(), a.id, 'mp'), (dr['id'], 'SYSID_THISMAV', 7, core_db.now(), a.id, 'mp'),
                            (dr['id'], 'SPRAY_ENABLE', 1, core_db.now(), a.id, 'mp'), (dr['id'], 'WPNAV_SPEED', 900, core_db.now(), a.id, 'sm_base'),
                            (dr['id'], 'LOIT_SPEED', 800, core_db.now(), a.id, 'hepgo')])
            cc.commit()
        deg = bridge.params_hasat(dr['id'], a.id)
        assert sorted(deg) == ['ATC_RAT_RLL_P', 'LOIT_SPEED'], deg
        pp = ok(a.get('/api/hangar'))['drones'][0]['params']
        assert pp['ATC_RAT_RLL_P'] == 0.21 and 'SYSID_THISMAV' not in pp and 'SPRAY_ENABLE' not in pp
        assert bridge.params_hasat(dr['id'], a.id) == []   # değişmeyen yeniden yazılmaz
        assert bridge.params_hasat(dr['id'], b_.id) == []  # başkasının dronu
    print('test_simumav_roadmap: TAMAM')


if __name__ == '__main__':
    main()
