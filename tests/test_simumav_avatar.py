"""SIMUMAV §25 — 3B pilot avatarı + TOP 10 PİLOT (docs/simumav.md §25).

Sınananlar: ad/e-posta maskesi (kısa ad, tek kelime, Türkçe karakter, orta ad, e-posta biçimli ad, alt alan adlı / tek harfli / geçersiz e-posta);
avatar doğrulama (eksik alan → karakter varsayılanı, geçersiz → 422, kısmi PUT birleşir); v6 göçü (eski taban: avatar sütunu yok → eklenir, NULL'lar
2B karakterin 3B karşılığıyla dolar, ikinci init idempotent); sıralama formülü (karşılaşma puanı + galibiyet + tempo + §42 disiplin + §24 önleme;
bota karşı yarım ağırlık; 30 gün / tüm zamanlar); botlar listede yok; "Liderlik tablosunda görünme" ayarı; oturumsuz uç yalnız maskeli veri
(ham ad/e-posta/kimlik yok), önbellek başlığı, oran sınırı 429; karşılaşma anlık görüntüsünde oyuncu avatarı.

Çalıştırma: ./.venv/bin/python -m tests.test_simumav_avatar
"""
import json
import os
import sqlite3
import sys
import tempfile
from datetime import datetime, timedelta

D = tempfile.mkdtemp(prefix='simumav-avatar-')
os.environ.update(SIMUMAV_DATA_DIR=D, SIMUMAV_DEV_LOGIN='1', HEPGO_SITL='0', SIMUMAV_UDP_BASE='24950', SIMUMAV_MAX_FLIGHTS='2', SIMUMAV_MP_PORT_BASE='25800',
                  SIMUMAV_MP_PORT_COUNT='20', SIMUMAV_SECURE_COOKIE='0', SIMUMAV_ENV_FILE=os.path.join(D, 'yok.env'),
                  SIMUMAV_MT_INTERNAL='http://127.0.0.1:1', GOOGLE_MAPS_API_KEY='')
for k in [k for k in sys.modules if k == 'app' or k.startswith('app.')]:
    del sys.modules[k]

from fastapi.testclient import TestClient  # noqa: E402

import app.simumav.main as smain  # noqa: E402
from app.simumav import auth, avatar, config, db  # noqa: E402
from app.simumav.routers import leaderboard  # noqa: E402

ORIGIN = 'http://127.0.0.1:8600'
H = {'Origin': ORIGIN}


def maske_testleri():
    m = avatar.maske_ad
    assert m('Muhammed Kaderoğlu') == 'M***** K*****', m('Muhammed Kaderoğlu')
    assert m('ali') == 'A*****'                                    # tek kelime
    assert m('Al') == 'A*****' and m('X Y') == 'X***** Y*****'      # kısa ad: uzunluk sızmaz (sabit 5 yıldız)
    assert m('ilker ışık') == 'İ***** I*****'                       # Türkçe büyük harf (i → İ, ı → I)
    assert m('Çağrı Öztürk') == 'Ç***** Ö*****' and m('şule ünal') == 'Ş***** Ü*****'
    assert m('Ayşe Nur Yılmaz') == 'A***** Y*****'                  # orta ad atılır
    assert m('  ') == '*****' and m(None) == '*****' and m('---') == '*****'
    assert m('mkaderoglu@gmail.com') == 'M*****'                    # e-posta biçimli hesap adı → yalnız yerel kısmın baş harfi
    assert m('ali.veli@x.com') == 'A***** V*****'
    e = avatar.maske_eposta
    assert e('mkaderoglu@gmail.com') == 'mk***@gm***.com', e('mkaderoglu@gmail.com')
    assert e('MK@Veilox.com.tr') == 'mk***@ve***.tr'                # büyük harf → küçük; çok etiketli TLD'de yalnız son etiket
    assert e('ab@mail.uni.edu.tr') == 'ab***@ma***.tr'              # alt alan adı
    assert e('a@b.io') == 'a***@b***.io'                            # tek harfli yerel kısım / alan adı
    assert e('ayşe@posta.com') == 'ay***@po***.com'
    assert e('localhost@intranet') == 'lo***@in***'
    for bad in ('', None, 'yok', '@x.com', 'a@', 'a@b@c.com', 'a@.'):
        assert e(bad) == '***', bad
    # ham veri maskede yok
    assert 'kaderoglu' not in e('mkaderoglu@gmail.com') and 'gmail' not in e('mkaderoglu@gmail.com')


def avatar_birim():
    a = avatar.normalize(None, 'p04')
    assert a['helmet'] == '#b91c1c' and a['skin'] == 's6' and a['v'] == 1
    assert avatar.normalize('bozuk json', 'p09')['helmet'] == '#ea580c'
    assert avatar.normalize({'helmet': '#ABCDEF', 'x': 1}, 'p01') == {**avatar.legacy('p01'), 'helmet': '#abcdef'}
    assert avatar.normalize({'helmet': 'red'}, 'p01')['helmet'] == '#1e3a5f'   # okumada geçersiz alan → varsayılan
    for bad in ({'helmet': 'red'}, {'skin': 's9'}, {'patch': 'skull'}, {'accessory': 'gun'}, {'mirror': 'yes'}, [1]):
        try:
            avatar.normalize(bad, 'p01', strict=True)
            raise AssertionError(bad)
        except avatar.AvatarHata:
            pass
    assert set(avatar.LEGACY) == {f'p{i:02d}' for i in range(1, 11)}
    for k in avatar.LEGACY:
        assert avatar.normalize(avatar.legacy(k), k, strict=True) == avatar.legacy(k)
    # puan yardımcıları (flightsim_match.js matchScore ile aynı)
    assert avatar.mac_puani('rings', 5, True, 1, True) == 500 + 250 + 150
    assert avatar.mac_puani('rings', 3, False, 2, False) == 300
    assert avatar.mac_puani('dogfight', 0, False, None, True, 'chaser', 2.5) == 1250
    assert avatar.mac_puani('dogfight', 0, False, None, False, 'evader', 9) == 0
    assert avatar.tempo_puani(50, 10) == 200 and avatar.tempo_puani(100, 10) == 100 and avatar.tempo_puani(300, 10) == 0 and avatar.tempo_puani(None, 5) == 0


def goc_testi():
    """v5 tabanı (pilots.avatar yok) → init → sütun + doldurma; ikinci init idempotent (kullanıcı değişikliği ezilmez)."""
    yol = os.path.join(D, 'eski.db')
    eski = config.DB_PATH
    config.DB_PATH = type(eski)(yol)
    try:
        c = sqlite3.connect(yol)
        c.executescript("""CREATE TABLE users (id INTEGER PRIMARY KEY, mt_user_id INTEGER NOT NULL UNIQUE, email TEXT NOT NULL, display_name TEXT NOT NULL, avatar TEXT,
                lang TEXT NOT NULL DEFAULT 'tr', theme TEXT NOT NULL DEFAULT 'dark', settings TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL, updated_at TEXT NOT NULL, last_login TEXT);
            CREATE TABLE pilots (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, name TEXT NOT NULL, character TEXT NOT NULL DEFAULT 'p01',
                is_default INTEGER NOT NULL DEFAULT 0, flights INTEGER NOT NULL DEFAULT 0, hours REAL NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
            CREATE TABLE schema_version (version INTEGER NOT NULL); INSERT INTO schema_version VALUES (5);
            INSERT INTO users (id, mt_user_id, email, display_name, created_at, updated_at) VALUES (1, 5, 'a@b.c', 'A', 't', 't');
            INSERT INTO pilots (user_id, name, character, created_at, updated_at) VALUES (1, 'x', 'p03', 't', 't'), (1, 'y', 'p08', 't', 't');""")
        c.commit(); c.close()
        db.init()
        with db.connect() as conn:
            av = [json.loads(r[0]) for r in conn.execute('SELECT avatar FROM pilots ORDER BY id')]
            assert av[0]['helmet'] == '#111111' and av[0]['skin'] == 's8' and av[1]['suit'] == '#be185d', av
            assert conn.execute('SELECT version FROM schema_version').fetchone()[0] == db.SCHEMA_VERSION == 6
            conn.execute("UPDATE pilots SET avatar = ? WHERE id = 1", (avatar.dump({**avatar.legacy('p03'), 'helmet': '#00ff00'}),)); conn.commit()
        db.init()
        with db.connect() as conn:
            assert json.loads(conn.execute('SELECT avatar FROM pilots WHERE id = 1').fetchone()[0])['helmet'] == '#00ff00'
    finally:
        config.DB_PATH = eski


def giris(c, ad):
    r = c.post('/api/session', json={'dev_user': ad}, headers=H)
    assert r.status_code == 200, r.text
    return r.json()['user']['id']


def ts(gun_once=0):
    return (datetime.now() - timedelta(days=gun_once)).isoformat(timespec='seconds')


def mac_ekle(conn, mid, oyuncular, kazanan, kind='rings', rings=5, gun_once=0, result=None):
    """oyuncular: [(uid, rank, rings, time_s, is_bot)]"""
    conn.execute("INSERT INTO matches (id, code, host_id, pass_hash, state, max_players, rings, result, winner_id, created_at, ended_at, kind) "
                 "VALUES (?,?,?,?, 'BITTI', 4, ?, ?, ?, ?, ?, ?)",
                 (mid, f'kod{mid}', oyuncular[0][0], 'x', json.dumps([{'i': i + 1} for i in range(rings)]), json.dumps(result or {'kind': kind, 'total': rings}),
                  kazanan, ts(gun_once), ts(gun_once), kind))
    for uid, rank, rg, t, bot in oyuncular:
        conn.execute("INSERT INTO match_players (match_id, user_id, name, is_host, status, rank, rings, time_s, joined_at, is_bot, level) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                     (mid, uid, 'Yapay zekâ' if bot else f'u{uid}', 0, 'hazir', rank, rg, t, ts(gun_once), int(bot), 'hard' if bot else None))


def ucus_ekle(conn, uid, alert=None, target=None, sure=120, gun_once=0):
    oz = {'v': 1}
    if alert is not None:
        oz['alerts'] = {'score': alert}
    if target is not None:
        oz['targets'] = {'score': target}
    conn.execute("INSERT INTO flights (user_id, started_at, ended_at, duration_s, result, summary, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)",
                 (uid, ts(gun_once), ts(gun_once), sure, 'ok', json.dumps(oz), ts(gun_once), ts(gun_once)))


def main():
    maske_testleri()
    avatar_birim()
    config.RATE['write'] = (100000, 60)
    config.RATE['read'] = (100000, 60)
    with TestClient(smain.app, base_url=ORIGIN) as c:
        # ---- avatar CRUD
        ali = giris(c, 'ali')
        p0 = c.get('/api/crew').json()['pilots'][0]
        assert p0['avatar'] == avatar.legacy('p01'), p0['avatar']
        opt = c.get('/api/crew/avatar-options').json(); assert len(opt['skins']) == 8 and 'star' in opt['patches'] and opt['legacy']['p04']['helmet'] == '#b91c1c'
        r = c.post('/api/crew', json={'name': 'Ayşe', 'character': 'p04'}, headers=H); assert r.status_code == 201 and r.json()['avatar']['helmet'] == '#b91c1c'
        pid = r.json()['id']
        r = c.post('/api/crew', json={'name': 'Can', 'character': 'p02', 'avatar': {'helmet': '#123456', 'skin': 's7', 'patch': 'bolt', 'mirror': False}}, headers=H)
        assert r.status_code == 201 and r.json()['avatar']['helmet'] == '#123456' and r.json()['avatar']['suit'] == '#7c3aed'   # eksik alan → karakter varsayılanı
        for bad in ({'helmet': 'javascript:1'}, {'skin': 's0'}, {'patch': '<svg>'}, {'helmet': '#' + 'a' * 700}):
            assert c.post('/api/crew', json={'name': 'X', 'character': 'p01', 'avatar': bad}, headers=H).status_code == 422, bad
        r = c.put(f'/api/crew/{pid}', json={'avatar': {'visor': '#00ffaa'}}, headers=H).json()
        assert r['avatar']['visor'] == '#00ffaa' and r['avatar']['helmet'] == '#b91c1c'      # kısmi PUT mevcut ayarla birleşir
        assert c.put(f'/api/crew/{pid}', json={'name': 'Ayşe K'}, headers=H).json()['avatar']['visor'] == '#00ffaa'   # avatar verilmezse korunur
        assert c.put(f'/api/crew/{pid}', json={'avatar': {'accessory': 'bomb'}}, headers=H).status_code == 422
        c.put(f'/api/crew/{pid}', json={'is_default': True, 'avatar': {'helmet': '#ff00ff'}}, headers=H)

        # ---- ayar: liderlik gizliliği (varsayılan görünür)
        assert c.get('/api/settings').json()['leaderboard_hidden'] is False

        # ---- kullanıcılar + veriler
        veli = giris(c, 'veli'); zeyn = giris(c, 'zeynep'); gizli = giris(c, 'gizli'); bos = giris(c, 'bos')
        c.cookies.clear(); giris(c, 'ali')
        with db.connect() as conn:
            for uid, ad, ep in ((ali, 'Muhammed Kaderoğlu', 'mkaderoglu@gmail.com'), (veli, 'veli', 'veli.can@mail.uni.edu.tr'),
                                (zeyn, 'Zeynep İnce', 'zi@posta.com'), (gizli, 'Gizli Kisi', 'gizli@kisi.com')):
                conn.execute('UPDATE users SET display_name = ?, email = ? WHERE id = ?', (ad, ep, uid))
            # 1) ali vs veli (insan): ali 1. bitirdi (5 halka, 50 sn), veli 2. (3 halka)
            mac_ekle(conn, 1, [(ali, 1, 5, 50.0, 0), (veli, 2, 3, None, 0)], ali)
            # 2) zeynep vs bot: zeynep kazandı → yarım ağırlık; bot satırı listede olmamalı
            mac_ekle(conn, 2, [(zeyn, 1, 5, 40.0, 0), (-1, 2, 2, None, 1)], zeyn)
            # 3) eski (40 gün önce) it dalaşı: veli kovalayan kazandı (tüm zamanlarda sayılır, 30 günde sayılmaz)
            mac_ekle(conn, 3, [(veli, None, 0, None, 0), (ali, None, 0, None, 0)], veli, kind='dogfight', rings=0, gun_once=40,
                     result={'kind': 'dogfight', 'dogfight': {'max_hold_s': 3.0, 'roles': {str(veli): 'chaser', str(ali): 'evader'}}})
            # 4) gizli kullanıcı büyük puanlı ama "görünme" diyecek
            mac_ekle(conn, 4, [(gizli, 1, 9, 30.0, 0), (veli, 2, 1, None, 0)], gizli, rings=9)
            # uçuşlar: §42 disiplin + §24 önleme
            ucus_ekle(conn, ali, alert=90); ucus_ekle(conn, ali, alert=70); ucus_ekle(conn, ali, alert=100, sure=30)   # 30 sn uçuş disipline sayılmaz
            ucus_ekle(conn, zeyn, target=1200); ucus_ekle(conn, zeyn, target=0)
            ucus_ekle(conn, bos)   # puansız uçuş → listede yok
            conn.commit()
        gecici = c.cookies.get('smsid')
        c.cookies.clear(); giris(c, 'gizli')
        assert c.put('/api/settings', json={'leaderboard_hidden': True}, headers=H).json()['leaderboard_hidden'] is True
        c.cookies.clear()   # oturumsuz uç

        # ---- beklenen puanlar (§25.3)
        # ali (30g): maç1 = 5×100 + 250 + 150 + galibiyet 300 = 1200; tempo 50/5 = 10 s → 20×(15−10) = 100; disiplin ort(90,70)=80 × 1,5 × 2 = 240 → 1540
        # zeynep: maç2 yarım: (500+250+150+300)/2 = 600; tempo 40/5 = 8 → 140/2 = 70; önleme 1200×0,5 = 600 → 1270
        # veli (30g): maç1 = 300 (+ maç4: 100) = 400; tüm zamanlar: + it dalaşı 1000 + 300 (kovalayan 3 sn → 300) + galibiyet 300 = 2000
        r = c.get('/api/leaderboard?period=30d')
        assert r.status_code == 200 and 'max-age=300' in r.headers['cache-control'], r.headers
        L = r.json()['pilots']
        assert [p['name'] for p in L] == ['M***** K*****', 'Z***** İ*****', 'V*****'], L
        assert [p['score'] for p in L] == [1540, 1270, 400], [p['score'] for p in L]
        assert L[0]['parts'] == {'match': 1200, 'pace': 100, 'discipline': 240, 'intercept': 0} and L[0]['wins'] == 1 and L[0]['rank'] == 1
        assert L[1]['parts'] == {'match': 600, 'pace': 70, 'discipline': 0, 'intercept': 600}
        assert L[0]['email'] == 'mk***@gm***.com' and L[2]['email'] == 've***@ma***.tr'
        assert L[0]['avatar']['helmet'] == '#ff00ff'   # varsayılan pilotun avatarı
        txt = r.text
        for ham in ('Kaderoğlu', 'mkaderoglu', 'gmail', 'Gizli', 'gizli@', 'Yapay', '"id"', 'user_id'):
            assert ham not in txt, ham
        assert all(set(p) == {'rank', 'name', 'email', 'avatar', 'score', 'wins', 'matches', 'flights', 'parts'} for p in L)
        A = c.get('/api/leaderboard?period=all').json()['pilots']
        assert A[0]['name'] == 'V*****' and A[0]['score'] == 2000 and A[0]['wins'] == 1, A[0]
        assert c.get('/api/leaderboard?period=7y').status_code == 422
        # gizlilik geri alınınca (önbellek düşer) listede görünür
        c.cookies.clear(); giris(c, 'gizli')
        c.put('/api/settings', json={'leaderboard_hidden': False}, headers=H)
        c.cookies.clear()
        L2 = c.get('/api/leaderboard?period=30d').json()['pilots']
        # (yeniden giriş hesap adını/e-postayı hesap servisinden tazeler: dev → 'gizli', gizli@dev.simumav.local)
        assert L2[0]['name'] == 'G*****' and L2[0]['email'] == 'gi***@de***.local' and L2[0]['score'] == 1800, L2[0]
        # önbellek: veri değişse de 5 dk aynı yanıt
        with db.connect() as conn:
            ucus_ekle(conn, bos, target=99999); conn.commit()
        assert all(p['name'] != 'B*****' for p in c.get('/api/leaderboard?period=30d').json()['pilots'])
        leaderboard.gecersiz()
        assert c.get('/api/leaderboard?period=30d').json()['pilots'][0]['name'] == 'B*****'
        # oran sınırı (IP başına 30/dk)
        auth.oran_sifirla()
        kodlar = [c.get('/api/leaderboard').status_code for _ in range(32)]
        assert kodlar[:30] == [200] * 30 and kodlar[-1] == 429, kodlar
        auth.oran_sifirla()

        # ---- karşılaşma anlık görüntüsünde avatar (DB satırı yolu; bot → None)
        c.cookies.set('smsid', gecici)
        from app.simumav import match as smatch
        with db.connect() as conn:
            r = db.row(conn.execute('SELECT * FROM matches WHERE id = 2'))
        ps = {p['id']: p for p in smatch.satir_dict(r, zeyn)['players']}
        assert ps[zeyn]['avatar']['v'] == 1 and ps[-1]['avatar'] is None
        assert smatch.pilot_avatari(ali)['helmet'] == '#ff00ff' and smatch.pilot_avatari(-3) is None
    goc_testi()
    print('test_simumav_avatar: TAMAM')


if __name__ == '__main__':
    main()
