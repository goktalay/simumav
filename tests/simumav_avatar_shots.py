"""SIMUMAV §25 — 3B pilot avatarı + TOP 10 PİLOT görselleri → /tmp/smavatar-shots/*.png (sahte SITL; yazılım WebGL):
  01 Mürettebat kartları (3B avatar PNG) · 02/03 avatar düzenleyici TR / EN (dönen 3B önizleme) · 04 salon: oyuncu + bot avatarları ·
  05 yarış: canlı sıralama avatarları (uçuşta ikinci WebGL bağlamı YOK — __smGl denetimi) · 06 sonuç: podyum + tablo avatarları ·
  07/08 oyun menüsü TOP 10 TR / EN · 09/10 tanıtım sitesi TOP 10 masaüstü TR / EN · 11/12 site mobil TR / EN · 13 Ayarlar "Liderlik tablosunda görünme".
Çalıştırma: .venv/bin/python -m tests.simumav_avatar_shots
"""
import json
import os
import random
import shutil
import socket
import sys
import threading
import time

os.environ.setdefault('LD_LIBRARY_PATH', '/home/gelistirici/build/chromelibs/root/usr/lib/x86_64-linux-gnu')
DATA = '/tmp/sm-avatar-shots-data'
SHOTS = '/tmp/smavatar-shots'
shutil.rmtree(DATA, ignore_errors=True)
os.makedirs(DATA, exist_ok=True)
os.makedirs(SHOTS, exist_ok=True)
os.environ.update(SIMUMAV_DATA_DIR=DATA, SIMUMAV_DEV_LOGIN='1', HEPGO_SITL='0', SIMUMAV_UDP_BASE='28950', SIMUMAV_MAX_FLIGHTS='4',
                  SIMUMAV_MP_PORT_BASE='29900', SIMUMAV_MP_PORT_COUNT='20', SIMUMAV_SECURE_COOKIE='0', SIMUMAV_ENV_FILE=os.path.join(DATA, 'yok.env'),
                  SIMUMAV_MT_INTERNAL='http://127.0.0.1:1', GOOGLE_MAPS_API_KEY='')
PORT = 8657
BASE = f'http://127.0.0.1:{PORT}'
EXE = os.path.expanduser('~/.cache/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell')
ARGS = ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist']

import requests  # noqa: E402
import uvicorn  # noqa: E402
from playwright.sync_api import sync_playwright  # noqa: E402

import app.simumav.main as smain  # noqa: E402
from app import flightsim  # noqa: E402
from app import flightsim_match_core as core  # noqa: E402
from app.simumav import avatar as AV  # noqa: E402
from app.simumav import db  # noqa: E402
from app.simumav import match as M  # noqa: E402
from tests.match_bot import rota_pilotu  # noqa: E402

from app.simumav import config as SC  # noqa: E402

core.HAZIRLIK_ZAMAN_ASIMI_S = 900.0
for _k in ('session', 'write', 'read'):   # veri hazırlığı çok sayıda oturum/yazma açar
    SC.RATE[_k] = (100000, 60)
server = uvicorn.Server(uvicorn.Config(smain.app, host='127.0.0.1', port=PORT, log_level='error'))
threading.Thread(target=server.run, daemon=True).start()
for _ in range(120):
    try:
        socket.create_connection(('127.0.0.1', PORT), 0.3).close()
        break
    except OSError:
        time.sleep(0.25)
else:
    sys.exit('sunucu açılmadı')

H = {'Origin': BASE}
sonuc, hatalar = [], []


def giris(ad):
    s = requests.Session()
    assert s.post(f'{BASE}/api/session', json={'dev_user': ad}, headers=H).status_code == 200
    return s


def shot(pg, ad, el=None, full=False):
    (el or pg).screenshot(path=f'{SHOTS}/{ad}.png', **({'full_page': True} if full and el is None else {}))
    sonuc.append(ad)
    print('  ·', ad, flush=True)


def kontrol(ad, kosul):
    print(('  ✓ ' if kosul else '  ✗ ') + ad, flush=True)
    if not kosul:
        hatalar.append(ad)


def bekle(fn, sn=120, adim=0.5):
    t = time.time() + sn
    while time.time() < t:
        v = fn()
        if v:
            return v
        time.sleep(adim)
    return fn()


# ---------------------------------------------------------------- liderlik verisi (10+ pilot; Türkçe adlar; maske sunucuda)
ADLAR = [('Muhammed Kaderoğlu', 'mkaderoglu@gmail.com'), ('Zeynep İnce', 'zeynep.ince@outlook.com'), ('Çağrı Öztürk', 'cagri@mail.uni.edu.tr'),
         ('Ayşe Nur Yılmaz', 'ayse@posta.com'), ('Emre', 'emre.k@proton.me'), ('Şule Ünal', 'sule.unal@gmail.com'), ('İlker Işık', 'ilker@isik.dev'),
         ('Gökhan Tan', 'g@tan.io'), ('Derya Aksoy', 'derya.aksoy@yandex.com.tr'), ('Burak Er', 'burak@er.net'), ('Selin Kaya', 'selin@kaya.org'),
         ('Gizli Pilot', 'gizli@pilot.com')]
rnd = random.Random(25)
oturumlar = []
for i, (ad, ep) in enumerate(ADLAR):
    s = giris(f'lb{i}')
    pid = s.get(f'{BASE}/api/crew').json()['pilots'][0]['id']
    av = {'helmet': rnd.choice(['#1e3a5f', '#b91c1c', '#f8fafc', '#111111', '#0e7490', '#d9a441', '#16a34a', '#7c3aed']), 'visor': rnd.choice(['#f5c542', '#9fd3ff', '#1a1a1a', '#f08080', '#22d3ee']),
          'mirror': rnd.random() < 0.7, 'suit': rnd.choice(['#1e3a5f', '#0f766e', '#374151', '#be185d', '#ea580c', '#57534e']), 'skin': rnd.choice(list(AV.SKINS)),
          'patch': rnd.choice(AV.PATCHES[1:]), 'patch_color': rnd.choice(['#f5c542', '#ffffff', '#9fd3ff', '#22c55e']), 'accessory': rnd.choice(AV.ACCESSORIES)}
    r = s.put(f'{BASE}/api/crew/{pid}', json={'avatar': av}, headers=H); assert r.status_code == 200, r.text
    oturumlar.append(s)
uids = []
with db.connect() as conn:
    for i, (ad, ep) in enumerate(ADLAR):
        uid = conn.execute('SELECT id FROM users WHERE display_name = ?', (f'lb{i}',)).fetchone()[0]
        conn.execute('UPDATE users SET display_name = ?, email = ? WHERE id = ?', (ad, ep, uid))
        uids.append(uid)
    t = db.now()
    mid = 9000
    for k in range(40):
        a, b = rnd.sample(range(len(uids)), 2)
        a, b = sorted((a, b))   # küçük sıra numarası daha sık kazanır → anlamlı sıralama
        ra, rb = rnd.randint(4, 8), rnd.randint(1, 6)
        conn.execute("INSERT INTO matches (id, code, host_id, pass_hash, state, max_players, rings, result, winner_id, created_at, ended_at, kind) VALUES (?,?,?,?, 'BITTI', 2, ?, ?, ?, ?, ?, 'rings')",
                     (mid, f'lb{mid}', uids[a], 'x', json.dumps([{'i': j + 1} for j in range(8)]), json.dumps({'kind': 'rings', 'total': 8}), uids[a], t, t))
        conn.execute("INSERT INTO match_players (match_id, user_id, name, is_host, status, rank, rings, time_s, joined_at) VALUES (?,?,?,?,?,?,?,?,?)", (mid, uids[a], 'a', 1, 'hazir', 1, 8, 40 + rnd.random() * 60, t))
        conn.execute("INSERT INTO match_players (match_id, user_id, name, is_host, status, rank, rings, time_s, joined_at) VALUES (?,?,?,?,?,?,?,?,?)", (mid, uids[b], 'b', 0, 'hazir', 2, rb, None, t))
        mid += 1
    for k, uid in enumerate(uids):
        for _ in range(rnd.randint(1, 6)):
            oz = {'v': 1, 'alerts': {'score': rnd.randint(55, 100)}}
            if rnd.random() < 0.4:
                oz['targets'] = {'score': rnd.randint(300, 1800)}
            conn.execute("INSERT INTO flights (user_id, started_at, ended_at, duration_s, result, summary, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)",
                         (uid, t, t, rnd.randint(90, 600), 'ok', json.dumps(oz), t, t))
    conn.commit()
gizli = oturumlar[-1]
gizli.put(f'{BASE}/api/settings', json={'leaderboard_hidden': True}, headers=H)

ali = giris('ali')
ali_pid = ali.get(f'{BASE}/api/crew').json()['pilots'][0]['id']
ali.put(f'{BASE}/api/crew/{ali_pid}', json={'name': 'Ali Kaptan', 'avatar': {'helmet': '#f8fafc', 'visor': '#f5c542', 'mirror': True, 'suit': '#1e3a5f', 'skin': 's5', 'patch': 'wing', 'patch_color': '#f5c542', 'accessory': 'mic'}}, headers=H)
ali.post(f'{BASE}/api/crew', json={'name': 'Deniz', 'character': 'p06'}, headers=H)
ali.post(f'{BASE}/api/crew', json={'name': 'Kartal', 'character': 'p09', 'avatar': {'accessory': 'crest', 'patch': 'cross'}}, headers=H)
veli = giris('veli')
vpid = veli.get(f'{BASE}/api/crew').json()['pilots'][0]['id']
veli.put(f'{BASE}/api/crew/{vpid}', json={'avatar': {'helmet': '#b91c1c', 'suit': '#374151', 'skin': 's7', 'patch': 'star', 'accessory': 'crest', 'visor': '#9fd3ff'}}, headers=H)
trk = ali.post(f'{BASE}/api/tracks', json={'name': 'Yarış Sahası', 'lat': 40.1, 'lon': 33.4, 'radius_m': 1000, 'world_mode': 'procedural',
                                           'world': {'seed': 5, 'tree_density': 0.15, 'building_count': 4}}, headers=H).json()
lb = requests.get(f'{BASE}/api/leaderboard?period=30d').json()['pilots']
kontrol(f"API: 10 pilot, maskeli ({lb[0]['name']} · {lb[0]['email']}), gizli yok", len(lb) == 10 and all('*' in p['name'] and '***@' in p['email'] for p in lb)
        and not any(p['email'].startswith('gi***@pi') for p in lb))


def baglam(b, oturum=None, lang='tr', vp=(1440, 900), mobile=False):
    ctx = b.new_context(viewport={'width': vp[0], 'height': vp[1]}, locale='tr-TR' if lang == 'tr' else 'en-US', is_mobile=mobile, has_touch=mobile, device_scale_factor=2 if mobile else 1)
    if oturum is not None:
        ctx.add_cookies([{'name': 'smsid', 'value': oturum.cookies['smsid'], 'url': BASE}])
    ctx.add_init_script(f"try {{ localStorage.setItem('sm:lang', '{lang}'); localStorage.setItem('simumav.lang', '{lang}'); localStorage.setItem('simumav.consent', 'denied'); localStorage.setItem('sm:bgfx', '0'); }} catch (e) {{}}")
    pg = ctx.new_page()
    pg.set_default_timeout(90000)
    pg.on('pageerror', lambda e: hatalar.append(str(e)[:300]))
    return ctx, pg


def sihirbaz(pa, mod):
    pa.goto(f'{BASE}/app/#/fly', wait_until='domcontentloaded')
    pa.wait_for_selector('.sm-mode-ai')
    pa.click('.sm-mode-ai' if mod == 'ai' else '.sm-mode-card.multi')
    pa.wait_for_selector('.sm-wizard-match .sm-cards-drones')
    pa.click('.sm-nav-btn.primary')
    pa.locator('.sm-cards-tracks .sm-card', has_text='Yarış Sahası').click()
    pa.click('.sm-nav-btn.primary')
    pa.wait_for_selector('.sm-df-kind[data-kind="rings"]')
    for k, v in (('count', 3), ('min_alt_m', 12), ('max_alt_m', 24), ('diameter_m', 16), ('radius_m', 110)):
        pa.fill(f'.sm-mt-field input[data-k="{k}"]', str(v)); pa.dispatch_event(f'.sm-mt-field input[data-k="{k}"]', 'input')
    pa.wait_for_timeout(600)
    pa.click('.sm-nav-btn.primary')


def avatarlar_hazir(pg, sel):
    return pg.wait_for_function(f"() => [...document.querySelectorAll('{sel}')].length > 0 && [...document.querySelectorAll('{sel}')].every(i => i.complete && i.naturalWidth > 0)", timeout=180000)


try:
    with sync_playwright() as p:
        b = p.chromium.launch(executable_path=EXE, args=ARGS)
        # ---- 01–03 mürettebat + düzenleyici
        _, pa = baglam(b, ali)
        pa.goto(f'{BASE}/app/#/crew', wait_until='domcontentloaded')
        pa.wait_for_selector('.pilot-card .face.av3d img'); avatarlar_hazir(pa, '.pilot-card .face img'); pa.wait_for_timeout(2500)
        kontrol('mürettebat: 3 pilot kartı 3B avatar PNG', pa.locator('.pilot-card .face.av3d img').count() == 3)
        shot(pa, '01-murettebat-kartlar')
        pa.locator('.pilot-card').first.locator('.row-actions button').nth(1).click()
        pa.wait_for_selector('.av-editor .av-stage canvas'); pa.wait_for_timeout(3500)
        kontrol('düzenleyici: tek paylaşılan WebGL bağlamı', pa.evaluate('window.__smGl()') <= 1)
        shot(pa, '02-avatar-duzenleyici-tr')
        pa.click('.av-dice'); pa.wait_for_timeout(400)
        # §28 sekmeli düzenleyici: alanlar kendi sekmesinde (aksesuar yalnız kaskta görünür)
        pa.click('.av-tab[data-tab="acc"]'); pa.click('.av-field[data-f="headgear"] .av-opt[data-v="helmet"]')
        pa.click('.av-field[data-f="accessory"] .av-opt[data-v="antenna"]'); pa.click('.av-tab[data-tab="outfit"]'); pa.click('.av-field[data-f="patch"] .av-opt[data-v="star"]')
        pa.click('.av-tab[data-tab="body"]'); pa.click('.av-field[data-f="skin"] .av-dot[data-v="s6"]'); pa.wait_for_timeout(1500)
        pa.locator('.modal .btn-row .btn.primary').click(); pa.wait_for_timeout(1500)
        kayit = ali.get(f'{BASE}/api/crew').json()['pilots'][0]['avatar']
        kontrol(f"düzenleyici kaydı: {kayit['accessory']}/{kayit['patch']}/{kayit['skin']}", (kayit['accessory'], kayit['patch'], kayit['skin']) == ('antenna', 'star', 's6'))
        ali.put(f'{BASE}/api/crew/{ali_pid}', json={'avatar': {'helmet': '#f8fafc', 'visor': '#f5c542', 'mirror': True, 'suit': '#1e3a5f', 'skin': 's5', 'patch': 'wing', 'accessory': 'mic'}}, headers=H)
        _, pe = baglam(b, ali, 'en')
        pe.goto(f'{BASE}/app/#/crew/new', wait_until='domcontentloaded')
        pe.wait_for_selector('.av-editor .av-stage canvas'); pe.fill('.av-field[data-f="name"] input', 'Maverick')
        pe.click('.av-presets .av-preset[data-c="p04"]'); pe.wait_for_timeout(3500)
        shot(pe, '03-avatar-editor-en')
        pe.context.close()

        # ---- 04 salon: ali (kurucu) + veli + bot   (SMAV_ONLY_SITE=1 → 04–06 atlanır; hızlı yineleme)
        if not os.environ.get('SMAV_ONLY_SITE'):
            sihirbaz(pa, 'multi')
            pa.wait_for_selector('.sm-mt-pw'); pa.fill('.sm-mt-pw', 'AVATAR42')
            pa.locator('.sm-mt-seg button', has_text='3').first.click()
            pa.click('.sm-mt-create')
            pa.wait_for_selector('.sm-ai-add button[data-level="hard"]')
            mid0 = int(pa.evaluate('window.__smLobby.match.id'))
            code = M.MANAGER.get(mid0).code
            r = veli.post(f'{BASE}/api/match/join', json={'code': code, 'password': 'AVATAR42'}, headers=H); kontrol('veli katıldı', r.status_code == 200)
            pa.wait_for_selector('.sm-mt-players li[data-uid]:nth-child(2)'); pa.wait_for_timeout(600)
            pa.click('.sm-ai-add button[data-level="hard"]')
            pa.wait_for_selector('.sm-mt-players li.bot'); avatarlar_hazir(pa, '.sm-mt-players img.sm-av'); pa.wait_for_timeout(1500)
            kontrol('salon: 3 oyuncu avatarı', pa.locator('.sm-mt-players img.sm-av').count() == 3)
            shot(pa, '04-salon-avatarlar')
            ali.post(f'{BASE}/api/match/{mid0}/cancel', json={}, headers=H)

            # ---- 05–06 yapay zekâya karşı: yarış skor tablosu + sonuç
            sihirbaz(pa, 'ai')
            pa.wait_for_selector('.sm-ai-step')
            pa.click('.sm-ai-levels button[data-level="normal"]')
            pa.locator('.sm-ai-step .sm-mt-seg').nth(1).locator('button', has_text='2').click()
            pa.wait_for_timeout(400)
            pa.click('.sm-mt-create')
            pa.wait_for_function("() => /#\\/fly\\/match\\/\\d+/.test(location.hash)", timeout=60000)
            mid = int(pa.evaluate("location.hash.match(/match\\/(\\d+)/)[1]"))
            m = M.MANAGER.get(mid)
            kontrol('yarış başladı', bekle(lambda: m.k.durum == core.YARIS, 600, 0.5))
            insan = next(o.uid for o in m.k.oyuncular.values() if not o.bot)
            ses = flightsim.MANAGER.get(m.sessions[insan].id)
            rota_pilotu(ses, m.k.halkalar, m.merkez, hiz=4.0)
            pa.wait_for_selector('.sm-mt-board img.sm-av'); pa.wait_for_timeout(9000)
            ngl = pa.evaluate('window.__smGl()')
            kontrol(f'uçuşta WebGL bağlamı = {ngl} (avatarlar ikinci bağlam açmadı)', ngl <= 1)
            kontrol('skor tablosunda 3 avatar', pa.locator('.sm-mt-board img.sm-av').count() == 3)
            shot(pa, '05-yaris-siralama-avatarlar')
            kontrol('karşılaşma bitti', bekle(lambda: m.k.durum == core.BITTI, 500, 1.0))
            pa.wait_for_selector('.sm-mt-result:not([hidden]) table', timeout=60000); pa.wait_for_timeout(5000)
            kontrol('sonuç: podyum + tablo avatarları', pa.locator('.sm-mt-result .sm-mt-podium img.sm-av').count() >= 1 and pa.locator('.sm-mt-result table img.sm-av').count() == 3)
            kontrol(f"sonuçta WebGL bağlamı = {pa.evaluate('window.__smGl()')}", pa.evaluate('window.__smGl()') <= 1)
            shot(pa, '06-sonuc-podyum-avatarlar')
            pa.context.close()

        # yazılım WebGL (swiftshader) uzun uçuştan sonra GPU sürecini yavaşlatıyor → menü/site görselleri yeni tarayıcıyla
        b.close()
        b = p.chromium.launch(executable_path=EXE, args=ARGS)
        # ---- 07–08 oyun menüsü TOP 10
        for lang, ad in (('tr', '07-menu-top10-tr'), ('en', '08-menu-top10-en')):
            _, pm = baglam(b, ali, lang)
            pm.goto(f'{BASE}/app/#/menu', wait_until='domcontentloaded')
            pm.wait_for_selector('.menu-top10-btn'); pm.click('.menu-top10-btn')
            pm.wait_for_selector('.sm-top10 li[data-rank="10"]', state='attached'); avatarlar_hazir(pm, '.sm-top10 img.sm-av'); pm.wait_for_timeout(1500)
            kontrol(f'menü TOP 10 ({lang}): 10 satır', pm.locator('.sm-top10 li[data-rank]').count() == 10)
            shot(pm, ad)
            pm.context.close()

        # ---- 09–12 tanıtım sitesi TOP 10 (masaüstü + mobil, TR + EN)
        for lang, vp, mob, ad in (('tr', (1440, 900), False, '09-site-top10-masaustu-tr'), ('en', (1440, 900), False, '10-site-top10-desktop-en'),
                                  ('tr', (390, 844), True, '11-site-top10-mobil-tr'), ('en', (390, 844), True, '12-site-top10-mobile-en')):
            _, ps = baglam(b, None, lang, vp, mob)
            ps.goto(f'{BASE}/?lang={lang}#top10', wait_until='domcontentloaded')
            ps.wait_for_selector('#top10 .t10-row[data-rank="10"]', timeout=60000)
            ps.evaluate("document.getElementById('top10').scrollIntoView()"); ps.wait_for_timeout(4000)
            dolu = ps.evaluate("[...document.querySelectorAll('#top10 canvas.t10-av')].filter(c => c.width > 0).length")
            kontrol(f'site TOP 10 ({lang}, {"mobil" if mob else "masaüstü"}): 10 avatar tuvali ({dolu}), bağlam {ps.evaluate("window.__smSiteGl?.()")}', dolu == 10 and (ps.evaluate('window.__smSiteGl?.() ?? 0') <= 1))
            shot(ps, ad, ps.locator('#top10'))
            ps.context.close()

        # ---- 13 ayarlar: liderlik gizliliği
        _, pz = baglam(b, ali)
        pz.goto(f'{BASE}/app/#/settings', wait_until='domcontentloaded')
        pz.wait_for_selector('[data-set="lb_hidden"]'); pz.wait_for_timeout(1200)
        pz.locator('[data-set="lb_hidden"]').scroll_into_view_if_needed()
        shot(pz, '13-ayarlar-liderlik-gizliligi', pz.locator('[data-set="lb_hidden"]'))
        b.close()
finally:
    server.should_exit = True
    time.sleep(1)
    print('görseller:', len(sonuc), SHOTS)
    print('hatalar:', hatalar or 'yok')
