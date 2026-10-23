"""SIMUMAV §28 — KARAKTER YARATMA + SAHNEDE PİLOT görselleri → /tmp/pilot3d-shots/*.png (sahte SITL; yazılım WebGL — SwiftShader).
  01 düzenleyici erkek tam boy (Beden) · 02 kadın yüz yakın (Yüz) · 03 saç, kasksız (Saç) · 04 kask vizör açık (Aksesuar) · 05 rastgele 6 örnek ızgarası ·
  06 düzenleyici mobil (EN) · 07 uçuş: Takip kamerası, dron yanında RC kumandalı pilot · 08 Yer kamerası · 09 Pilot gözü (omuz üstü) ·
  10 gimbal kamerası pilota bakıyor · 11 Düşük grafik (basit pilot) · 12 uçuş mobil · 13 yapay zekâya karşı: rakip AI pilot kendi kalkış noktasında ·
  14 kayıttan oynatma (Cesium; açılamazsa atlanır).
Ortam: PILOT_ONLY=editor|fly|match|replay (yalnız o bölüm). Çalıştırma: ./.venv/bin/python -m tests.simumav_pilot3d_shots
"""
import json
import math
import os
import shutil
import socket
import sys
import threading
import time

os.environ.setdefault('LD_LIBRARY_PATH', '/home/gelistirici/build/chromelibs/root/usr/lib/x86_64-linux-gnu')
DATA = '/tmp/sm-pilot3d-data'
SHOTS = '/tmp/pilot3d-shots'
shutil.rmtree(DATA, ignore_errors=True)
os.makedirs(DATA, exist_ok=True)
os.makedirs(SHOTS, exist_ok=True)
os.environ.update(SIMUMAV_DATA_DIR=DATA, SIMUMAV_DEV_LOGIN='1', HEPGO_SITL='0', SIMUMAV_UDP_BASE='29950', SIMUMAV_MAX_FLIGHTS='4',
                  SIMUMAV_MP_PORT_BASE='30900', SIMUMAV_MP_PORT_COUNT='20', SIMUMAV_SECURE_COOKIE='0', SIMUMAV_ENV_FILE=os.path.join(DATA, 'yok.env'),
                  SIMUMAV_MT_INTERNAL='http://127.0.0.1:1', GOOGLE_MAPS_API_KEY='')
PORT = int(os.environ.get('SHOT_PORT') or 8673)
BASE = f'http://127.0.0.1:{PORT}'
EXE = os.path.expanduser('~/.cache/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell')
ARGS = ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist']
ONLY = os.environ.get('PILOT_ONLY') or ''

import requests  # noqa: E402
import uvicorn  # noqa: E402
from playwright.sync_api import sync_playwright  # noqa: E402

import app.simumav.main as smain  # noqa: E402
from app import flightsim  # noqa: E402
from app import flightsim_match_core as core  # noqa: E402
from app.simumav import config as SC  # noqa: E402
from app.simumav import match as M  # noqa: E402

core.HAZIRLIK_ZAMAN_ASIMI_S = 900.0
for _k in ('session', 'write', 'read'):
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


def shot(pg, ad, el=None):
    (el or pg).screenshot(path=f'{SHOTS}/{ad}.png')
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


def baglam(b, oturum, lang='tr', vp=(1440, 900), mobile=False, extra=''):
    ctx = b.new_context(viewport={'width': vp[0], 'height': vp[1]}, locale='tr-TR' if lang == 'tr' else 'en-US', is_mobile=mobile, has_touch=mobile, device_scale_factor=2 if mobile else 1)
    ctx.add_cookies([{'name': 'smsid', 'value': oturum.cookies['smsid'], 'url': BASE}])
    ctx.add_init_script(f"try {{ localStorage.setItem('sm:lang', '{lang}'); localStorage.setItem('simumav.lang', '{lang}'); localStorage.setItem('simumav.consent', 'denied'); localStorage.setItem('sm:bgfx', '0'); localStorage.setItem('fs.rec.on', '0'); {extra} }} catch (e) {{}}")
    pg = ctx.new_page()
    pg.set_default_timeout(180000)
    pg.on('pageerror', lambda e: hatalar.append('SAYFA: ' + str(e)[:300]))
    pg.on('console', lambda m: hatalar.append(f'KONSOL: {m.text[:300]}') if m.type == 'error' and 'WebGL' not in m.text and 'GPU stall' not in m.text and 'Failed to load resource' not in m.text else None)
    return ctx, pg


ali = giris('ali')
ali_pid = ali.get(f'{BASE}/api/crew').json()['pilots'][0]['id']
AV_ALI = {'body': 'm', 'build': 'avg', 'skin': 's5', 'hair': 'short', 'hair_color': '#3b2a1e', 'beard': 'stubble', 'face': 'square', 'eyes': 'almond', 'eye_color': '#5b3a1e',
          'brows': 'straight', 'brow_w': 'thick', 'mouth': 'smile', 'headgear': 'headset', 'helmet': '#f97316', 'suit': '#1e3a5f', 'patch': 'wing', 'patch_color': '#f5c542',
          'outfit': 'suit', 'glasses': 'aviator'}
r = ali.put(f'{BASE}/api/crew/{ali_pid}', json={'name': 'Ali Kaptan', 'avatar': AV_ALI}, headers=H)
assert r.status_code == 200, r.text


def editor_ac(pg, yeni=False):
    if yeni:
        pg.goto(f'{BASE}/app/#/crew/new', wait_until='domcontentloaded')
    else:
        pg.goto(f'{BASE}/app/#/crew', wait_until='domcontentloaded')
        pg.wait_for_selector('.pilot-card .face.av3d img')
        pg.locator('.pilot-card').first.locator('.row-actions button').nth(1).click()
    pg.wait_for_selector('.av-editor .av-stage canvas')
    pg.wait_for_timeout(2500)


def av_set(pg, cfg):
    pg.evaluate(f'window.__smAvatarEditor.set({json.dumps(cfg)})')
    pg.wait_for_timeout(1800)


GRID_JS = r'''async ([list, view]) => {
  const [{ loadThree, snapshot }, mesh] = await Promise.all([import('/app/core/three.js'), import('/app/crew/avatar_mesh.js')]);
  const lib = await loadThree(), { THREE } = lib;
  const scene = new THREE.Scene(), cam = new THREE.PerspectiveCamera(30, 0.75, 0.05, 60);
  mesh.addAvatarLights(THREE, scene); mesh.framePortrait(cam, { view });
  const wrap = document.createElement('div');
  wrap.id = 'pilot-grid'; wrap.style.cssText = 'position:fixed;inset:0;z-index:99999;display:grid;grid-template-columns:repeat(3,1fr);gap:10px;padding:16px;background:radial-gradient(circle at 50% 20%,#1d3557,#060a12)';
  for (const a of list) {
    const g = mesh.buildAvatar(THREE, a, { pose: 'full' }); g.rotation.y = -0.35; scene.add(g);
    const cv = snapshot(lib, scene, cam, 360, 480); scene.remove(g); g.userData.dispose();
    const cell = document.createElement('div'); cell.style.cssText = 'display:flex;flex-direction:column;align-items:center;color:#cbd5e1;font:600 13px system-ui';
    const img = document.createElement('img'); img.src = cv.toDataURL('image/png'); img.style.cssText = 'height:390px';
    const cap = document.createElement('div'); cap.textContent = [a.body === 'f' ? '♀' : '♂', a.hair, a.headgear, a.beard !== 'none' ? a.beard : '', a.glasses !== 'none' ? a.glasses : ''].filter(Boolean).join(' · ');
    cell.append(img, cap); wrap.append(cell);
  }
  document.body.append(wrap);
  return list.length;
}'''

try:
    with sync_playwright() as p:
        b = p.chromium.launch(executable_path=EXE, args=ARGS)
        # ================================================================ düzenleyici
        if ONLY in ('', 'editor'):
            _, pa = baglam(b, ali)
            editor_ac(pa)
            kontrol('düzenleyici: 5 sekme (Beden · Yüz · Saç · Kıyafet · Aksesuar)', pa.locator('.av-tabs .av-tab').count() == 5)
            kontrol('düzenleyici: tek paylaşılan WebGL bağlamı', pa.evaluate('window.__smGl()') <= 1)
            kontrol('tam boy model (kemikler: kök/gövde/baş)', pa.evaluate("(() => { const m = window.__smAvatarEditor.live.model; return m && m.name === 'sm-avatar-full' && !!m.userData.bones.torso && !!m.userData.head; })()"))
            av_set(pa, {**AV_ALI, 'headgear': 'none', 'glasses': 'none'})
            shot(pa, '01-duzenleyici-erkek-tam-boy')
            # kadın, yüz sekmesi + yüz yakın
            pa.click('.av-tab[data-tab="body"]'); pa.click('.av-field[data-f="body"] .av-opt[data-v="f"]'); pa.wait_for_timeout(600)
            a = pa.evaluate('window.__smAvatarEditor.avatar')
            kontrol(f"kadına geçiş: sakal kalktı, saç kadın listesinde ({a['hair']}/{a['beard']})", a['beard'] == 'none' and a['hair'] in ('long', 'ponytail', 'bun', 'bob', 'curly', 'short', 'sidepart'))
            av_set(pa, {**a, 'hair': 'bun', 'hair_color': '#9a3b1b', 'face': 'heart', 'eyes': 'wide', 'eye_color': '#3f7d4e', 'brows': 'arched', 'brow_w': 'thin', 'nose': 'small',
                        'mouth': 'smile', 'freckles': True, 'skin': 's2', 'headgear': 'none', 'glasses': 'none'})
            pa.click('.av-tab[data-tab="face"]'); pa.click('.av-zoom-btn[data-zoom="face"]'); pa.wait_for_timeout(2200)
            kontrol('kadın bedende sakal alanı gizli', pa.locator('.av-field[data-f="beard"]').is_hidden())
            shot(pa, '02-duzenleyici-kadin-yuz')
            pa.click('.av-zoom-btn[data-zoom="body"]')
            av_set(pa, {**a, 'body': 'f', 'hair': 'ponytail', 'hair_color': '#d6b370', 'headgear': 'none', 'outfit': 'jacket', 'suit': '#4d7c0f', 'skin': 's3', 'glasses': 'sun', 'mouth': 'grin'})
            pa.click('.av-tab[data-tab="hair"]'); pa.wait_for_timeout(2000)
            shot(pa, '03-duzenleyici-sac-kasksiz')
            av_set(pa, {**AV_ALI, 'headgear': 'helmet', 'visor_open': True, 'beard': 'full', 'hair': 'curly', 'helmet': '#b91c1c', 'visor': '#1a1a1a', 'accessory': 'mic', 'glasses': 'none'})
            pa.click('.av-tab[data-tab="acc"]'); pa.click('.av-zoom-btn[data-zoom="face"]'); pa.wait_for_timeout(2200)
            shot(pa, '04-duzenleyici-kask-vizor-acik')
            # kayıt (sunucu doğrulaması + geri okuma)
            pa.click('.av-zoom-btn[data-zoom="body"]')
            pa.locator('.modal .btn-row .btn.primary').click(); pa.wait_for_timeout(1500)
            kayit = ali.get(f'{BASE}/api/crew').json()['pilots'][0]['avatar']
            kontrol(f"kayıt: v{kayit['v']} {kayit['headgear']}/{kayit['visor_open']}/{kayit['beard']}/{kayit['hair']}", kayit['v'] == 2 and kayit['headgear'] == 'helmet' and kayit['visor_open'] is True and kayit['beard'] == 'full')
            # rastgele 6 örnek (Rastgele düğmesiyle üretilir; "Cinsiyeti koru" ile 3 kadın)
            editor_ac(pa)
            ornek = []
            for i in range(6):
                if i == 3:
                    pa.click('.av-tab[data-tab="body"]'); pa.click('.av-field[data-f="body"] .av-opt[data-v="f"]'); pa.check('.av-keep')
                pa.click('.av-dice'); pa.wait_for_timeout(250)
                ornek.append(pa.evaluate('window.__smAvatarEditor.avatar'))
            kontrol('rastgele: "Cinsiyeti koru" son 3 örnekte kadın, kadında sakal yok', all(o['body'] == 'f' and o['beard'] == 'none' for o in ornek[3:]))
            pa.keyboard.press('Escape'); pa.wait_for_timeout(600)
            pa.evaluate(GRID_JS, [ornek, 'body']); pa.wait_for_timeout(800)
            shot(pa, '05-rastgele-6-ornek')
            pa.context.close()
            _, pm = baglam(b, ali, 'en', (390, 844), True)
            editor_ac(pm, yeni=True)
            pm.fill('.av-field[data-f="name"] input', 'Maverick')
            av_set(pm, {'body': 'f', 'hair': 'long', 'hair_color': '#1b1b1b', 'headgear': 'cap', 'helmet': '#0e7490', 'skin': 's7', 'outfit': 'casual', 'suit': '#be185d', 'mouth': 'smile'})
            pm.click('.av-tab[data-tab="hair"]'); pm.wait_for_timeout(1500)
            shot(pm, '06-editor-mobile-en')
            pm.context.close()

        # ================================================================ uçuş (multikopter; sahte SITL)
        if ONLY in ('', 'fly'):
            b.close(); b = p.chromium.launch(executable_path=EXE, args=ARGS)
            ali.put(f'{BASE}/api/crew/{ali_pid}', json={'avatar': {**AV_ALI, 'headgear': 'headset'}}, headers=H)
            dr = ali.post(f'{BASE}/api/hangar', json={'name': 'IRIS', 'type': 'multirotor', 'model_key': 'glb:iris', 'color': '#f97316'}, headers=H).json()
            trk = ali.post(f'{BASE}/api/tracks', json={'name': 'Pilot Sahası', 'lat': 40.10, 'lon': 33.40, 'radius_m': 800, 'world_mode': 'procedural', 'weather': 'clear',
                                                       'world': {'seed': 9, 'runway': True, 'tree_density': 0.12, 'building_count': 6, 'runway_deg': 0}}, headers=H).json()

            def ucus_ac(vp=(1440, 900), mobile=False, gfx='high'):
                f = ali.post(f'{BASE}/api/fly/start', json={'drone_id': dr['id'], 'pilot_id': ali_pid, 'track_id': trk['id'], 'record': {'bin': False, 'video': False}}, headers=H)
                assert f.status_code == 201, f.text
                fid, sid = f.json()['flight_id'], f.json()['sim_id']
                ss = flightsim.MANAGER.sessions[sid]
                ctx, pg = baglam(b, ali, 'tr', vp, mobile, f"localStorage.setItem('sm.gfx', JSON.stringify({{ preset: '{gfx}' }})); localStorage.setItem('sm.rcOn', 'false');")
                pg.goto(f'{BASE}/app/#/menu', wait_until='domcontentloaded'); pg.wait_for_timeout(400)
                pg.goto(f'{BASE}/app/#/fly/{fid}', wait_until='domcontentloaded')
                pg.wait_for_function('() => window.__smSim && window.__smSim.pilotInfo && window.__smSim.pilotInfo()?.pilots?.length > 0', timeout=300000)
                pg.wait_for_timeout(9000)   # giriş sekansı
                return fid, ss, pg

            def asili(ss, x, y, z, yaw_deg, cember=0.0):
                """Sahte kinematik: evden (x doğu, y kuzey) noktada z m'de asılı; isteğe bağlı yavaş çember + RC çubukları (pilotun başparmakları)."""
                k = ss.sahte
                st = {'t': 0.0}

                def adim(dt):
                    st['t'] += dt
                    k.sure_ms += dt * 1000
                    k.armed, k.mode = True, 'LOITER'
                    a = st['t'] * cember
                    px, py = x + 4 * math.sin(a) * (1 if cember else 0), y + 4 * (math.cos(a) - 1) * (1 if cember else 0)
                    k.lat, k.lon = core.latlon(k.lat0, k.lon0, px, py)
                    k.alt_rel = z
                    k.yaw = math.radians(yaw_deg)
                    k.vn = k.ve = 0.0
                    k.throttle = 55.0
                    k.rc = [1500 + int(260 * math.sin(st['t'] * 1.7)), 1500 - 300, 1650, 1500 + 280, 1500, 1500, 1500, 1500]
                k.adim = adim

            fid, ss, pg = ucus_ac()
            info = pg.evaluate('window.__smSim.pilotInfo()')
            me = next((x for x in info['pilots'] if x['id'] == 'me'), None)
            kontrol(f"pilot sahnede: {me and (me['tris'], me['drawCalls'])} üçgen/çağrı", bool(me) and me['tris'] <= 5000 and me['drawCalls'] <= 6)
            d = math.hypot(me['x'] - info['home']['x'], me['y'] - info['home']['y']) if me else 0
            kontrol(f'pilot evden {d:.1f} m uzakta (6–10 m)', 6 <= d <= 10)
            asili(ss, 3, 9, 6, 20)
            pg.wait_for_timeout(5000)
            info = pg.evaluate('window.__smSim.pilotInfo()')
            me = next(x for x in info['pilots'] if x['id'] == 'me')
            print('  konum:', pg.evaluate("(() => { const s = window.__smSim; return { dron: s.position(), z0: s.terrainHeight(0, 0), pilot: s.pilotInfo().pilots[0] }; })()"), flush=True)
            kontrol(f"çubuklar RC kanallarını izliyor (sol {me['sticks']['l']}, sağ {me['sticks']['r']}), baş/gövde dronu izliyor (baş {me['head']}, yunuslama {me['pitch']})",
                    abs(me['sticks']['r'][0]) > 0.1 and me['sticks']['l'][0] > 0.05 and me['pitch'] > 0.1)
            # Takip kamerası: biraz uzaklaşıp pilotun tarafına döndür (fare tekerleği + sürükle)
            pg.keyboard.press('p'); pg.wait_for_timeout(400)   # dron paneli gizli (sahne görünsün)
            # Takip kamerası dronun güneybatısından kuzeydoğuya bakar → dron pilotun güneybatısında alçakta: pilot dronun arkasında, kadrajda
            asili(ss, me['x'] - 4.0, me['y'] + 2.0, 3.0, 300)
            pg.evaluate("window.__smSim.setCamera('follow')"); pg.wait_for_timeout(5000)
            shot(pg, '07-ucus-takip-pilot')
            asili(ss, 3, 9, 6, 20)
            pg.evaluate("window.__smSim.setCamera('ground')"); pg.wait_for_timeout(3000)
            shot(pg, '08-ucus-yer-kamerasi')
            pg.keyboard.press('6'); pg.wait_for_timeout(3000)
            kontrol(f"Pilot gözü: Yer + omuz üstü ({pg.evaluate('window.__smSim.getGroundView()')}), düğme metni", pg.evaluate('window.__smSim.getGroundView()') == 'pilot')
            shot(pg, '09-pilot-gozu')
            # gimbal kamerası: dron pilota dönük, alçakta
            pl = pg.evaluate("window.__smSim.pilotInfo().pilots.find(x => x.id === 'me')")
            asili(ss, 0, 2, 3, math.degrees(math.atan2(pl['x'] - 0, pl['y'] - 2)))
            pg.evaluate("window.__smSim.setCamera('fpv'); window.__smSim.setGimbal(-8)"); pg.wait_for_timeout(4000)
            shot(pg, '10-gimbal-kamerasi-pilot')
            ngl = pg.evaluate('window.__smGl ? window.__smGl() : 0')
            kontrol(f'uçuşta ek WebGL bağlamı yok (__smGl = {ngl})', ngl <= 1)
            # Düşük grafik: basit pilot + gölgesiz
            pg.evaluate("(() => { const s = window.__smSim; s.setGraphics(s.resolveGfx({ preset: 'low' })); })()"); pg.wait_for_timeout(2500)
            pi = pg.evaluate("window.__smSim.pilotInfo().pilots.find(x => x.id === 'me')")
            kontrol(f"Düşük: lod {pi['lod']}, gölge {pi['shadow']}, {pi['tris']} üçgen", pi['lod'] == 'low' and pi['shadow'] is False and pi['tris'] < 3600)
            pg.evaluate("window.__smSim.setCamera('pilot_eye')"); asili(ss, 3, 9, 6, 20); pg.wait_for_timeout(2500)
            shot(pg, '11-dusuk-grafik-pilot-gozu')
            ali.post(f'{BASE}/api/fly/{fid}/stop', json={}, headers=H)
            pg.context.close()
            fid, ss, pg = ucus_ac((844, 390), True)
            asili(ss, 3, 9, 6, 20)
            pg.keyboard.press('p'); pg.keyboard.press('v')   # mobil: panel + PiP kapalı
            pg.evaluate("window.__smSim.setCamera('pilot_eye')"); pg.wait_for_timeout(3500)
            shot(pg, '12-ucus-mobil-pilot-gozu')
            ali.post(f'{BASE}/api/fly/{fid}/stop', json={}, headers=H)
            pg.context.close()

        # ================================================================ yapay zekâya karşı: rakip pilot
        if ONLY in ('', 'match'):
            b.close(); b = p.chromium.launch(executable_path=EXE, args=ARGS)
            ctx, pa = baglam(b, ali, extra="localStorage.setItem('sm.gfx', JSON.stringify({ preset: 'medium' })); localStorage.setItem('sm.rcOn', 'false');")
            trk2 = ali.post(f'{BASE}/api/tracks', json={'name': 'Yarış Sahası', 'lat': 40.1, 'lon': 33.4, 'radius_m': 1000, 'world_mode': 'procedural',
                                                        'world': {'seed': 5, 'tree_density': 0.1, 'building_count': 2}}, headers=H).json()
            pa.goto(f'{BASE}/app/#/fly', wait_until='domcontentloaded')
            pa.wait_for_selector('.sm-mode-ai'); pa.click('.sm-mode-ai')
            pa.wait_for_selector('.sm-wizard-match .sm-cards-drones'); pa.click('.sm-nav-btn.primary')
            pa.locator('.sm-cards-tracks .sm-card', has_text='Yarış Sahası').click(); pa.click('.sm-nav-btn.primary')
            pa.wait_for_selector('.sm-df-kind[data-kind="rings"]')
            for k, v in (('count', 3), ('min_alt_m', 12), ('max_alt_m', 24), ('diameter_m', 16), ('radius_m', 110)):
                pa.fill(f'.sm-mt-field input[data-k="{k}"]', str(v)); pa.dispatch_event(f'.sm-mt-field input[data-k="{k}"]', 'input')
            pa.wait_for_timeout(500); pa.click('.sm-nav-btn.primary')
            pa.wait_for_selector('.sm-ai-step'); pa.click('.sm-ai-levels button[data-level="hard"]')
            pa.locator('.sm-ai-step .sm-mt-seg').nth(1).locator('button', has_text='1').click(); pa.wait_for_timeout(300)
            pa.click('.sm-mt-create')
            pa.wait_for_function("() => /#\\/fly\\/match\\/\\d+/.test(location.hash)", timeout=60000)
            mid = int(pa.evaluate("location.hash.match(/match\\/(\\d+)/)[1]"))
            m = M.MANAGER.get(mid)
            kontrol('yarış başladı', bekle(lambda: m.k is not None and m.k.durum == core.YARIS, 600, 0.5))
            pa.wait_for_function("() => window.__smSim && window.__smSim.pilotInfo && window.__smSim.pilotInfo()?.pilots?.length >= 2", timeout=240000)
            pa.wait_for_timeout(4000)
            info = pa.evaluate('window.__smSim.pilotInfo()')
            rakip = [x for x in info['pilots'] if x['id'] != 'me']
            kontrol(f"rakip AI pilot kendi kalkış noktasında ({len(rakip)})", len(rakip) == 1)
            if rakip:
                rp, mp = rakip[0], next(x for x in info['pilots'] if x['id'] == 'me')
                rakip_id = int(rp['id'][1:])
                # serbest kamera rakip pilotun önünde-yanında (yüzü + AI kaskı görünsün), ona bakar; yaw: 0 kuzey, + batı
                pa.evaluate("window.__smSim.setFreeView(0, -60, 30, 0, -20)"); pa.wait_for_timeout(2500)
                rp = next(x for x in pa.evaluate('window.__smSim.pilotInfo()')['pilots'] if x['id'] != 'me')   # güncel gövde yönü (hayaleti izler)
                ry = rp['face'] if rp.get('face') is not None else rp['yaw'] + rp['torso'] + rp['head']   # yüzün baktığı yön (baş kemiği)
                print('  rakip:', rp, 'hayalet:', pa.evaluate(f"window.__smMatch?.layer?.ghostPos?.({rakip_id})"), flush=True)
                cx, cy = rp['x'] + math.sin(ry) * 4.0 + math.cos(ry) * 1.5, rp['y'] + math.cos(ry) * 4.0 - math.sin(ry) * 1.5
                yaw = math.degrees(math.atan2(-(rp['x'] - cx), rp['y'] - cy))
                pa.evaluate(f"window.__smSim.setFreeView({cx}, {cy}, {rp['z'] + 2.2}, {yaw}, -12)")
                pa.wait_for_timeout(1200)
                shot(pa, '13-ai-karsilasma-rakip-pilot')
                d = math.hypot(rp['x'] - mp['x'], rp['y'] - mp['y'])
                kontrol(f'iki pilot ayrı kalkış noktalarında ({d:.1f} m)', d > 5)
            ali.post(f'{BASE}/api/match/{mid}/cancel', json={}, headers=H)
            ctx.close()
        # ================================================================ kayıttan oynatma (Cesium): sahte SITL .bin üretmez → /replay yanıtı yapay kayıtla (rota)
        if ONLY in ('', 'replay'):
            b.close(); b = p.chromium.launch(executable_path=EXE, args=ARGS)
            dr2 = ali.post(f'{BASE}/api/hangar', json={'name': 'IRIS-R', 'type': 'multirotor', 'model_key': 'glb:iris'}, headers=H).json()
            trk3 = ali.post(f'{BASE}/api/tracks', json={'name': 'Kayıt Sahası', 'lat': 40.10, 'lon': 33.40, 'radius_m': 600, 'world_mode': 'procedural'}, headers=H).json()
            f = ali.post(f'{BASE}/api/fly/start', json={'drone_id': dr2['id'], 'pilot_id': ali_pid, 'track_id': trk3['id'], 'record': {'bin': False, 'video': False}}, headers=H)
            fid = f.json()['flight_id']
            time.sleep(2); ali.post(f'{BASE}/api/fly/{fid}/stop', json={}, headers=H)
            lat0, lon0 = 40.10, 33.40
            F = ['t', 'lat', 'lon', 'alt_rel', 'yaw', 'pitch', 'roll', 'gs', 'hdg', 'mode', 'armed', 'batt_pct', 'thr']
            fr = []
            for i in range(300):
                t = i * 0.2
                z = min(15.0, t * 2.0)
                a = max(0.0, t - 7.5) * 0.12
                x, y = 25 * math.sin(a), 25 * (1 - math.cos(a))
                la, lo = core.latlon(lat0, lon0, x, y)
                fr.append([round(t, 2), la, lo, z, 20.0, 0, 0, 3.0 if t > 7.5 else 0, 20.0, 0, 1, 90, 55])
            REPLAY = {'fields': F, 'frames': fr, 'hz': 5, 'duration_s': 60, 'home': {'lat': lat0, 'lon': lon0, 'alt': 900}, 'events': [], 'modes': ['LOITER']}
            ctx, pr = baglam(b, ali)
            pr.route(f'**/api/ops/{fid}/replay', lambda route: route.fulfill(status=200, content_type='application/json', body=json.dumps(REPLAY)))
            pr.goto(f'{BASE}/app/#/ops/{fid}', wait_until='domcontentloaded')
            ok = True
            try:
                pr.wait_for_function('() => window.__smReplay && window.__smReplay.pilot', timeout=90000)
            except Exception as e:   # noqa: BLE001
                ok = False
                print('  (Cesium/pilot yüklenemedi; kayıt görseli atlandı)', str(e)[:200], flush=True)
            if ok:
                pi = pr.evaluate('window.__smReplay.pilot')
                kontrol(f"kayıtta pilot: avatar {pi['avatar']}, konum {pi['lat']:.6f},{pi['lon']:.6f}", pi['avatar'] is True)
                pr.wait_for_timeout(3500)   # flyToBoundingSphere animasyonu bitsin
                pr.evaluate("(() => { const { viewer, Cesium } = window.__smCesium; viewer.camera.cancelFlight(); const p = window.__smReplay.pilot; viewer.camera.lookAt(Cesium.Cartesian3.fromDegrees(p.lon, p.lat, p.alt + 1), new Cesium.HeadingPitchRange(2.6, -0.25, 22)); viewer.scene.requestRender(); })()")
                pr.evaluate('window.__smReplay.seek(14)')
                pr.wait_for_timeout(6000)
                shot(pr, '14-kayittan-oynatma-pilot')
            ctx.close()
        b.close()
finally:
    server.should_exit = True
    time.sleep(1)
    print('görseller:', len(sonuc), SHOTS)
    print('hatalar:', hatalar or 'yok')
