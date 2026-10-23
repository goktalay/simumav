// SIMUMAV §25 — 3B pilot avatarı istemci testleri (node): avatar_core (normalize, eski karakter eşlemesi sunucu LEGACY ile birebir, bot avatarı,
// önbellek anahtarı, rastgele avatar), avatar_mesh (gerçek three.js ile tüm yama/aksesuar/bot birleşimleri kurulur, WebGL'siz; 2B yedek çizim),
// WebGL kuralı (yarış HUD'u three/çizici çağırmaz; avatar3d uçuşta snapshot'a gitmez; core/three.js snapshot paylaşılan çiziciyi kullanır),
// i18n (avatar.* / top10.* / settings.lb_hidden 7 dilde, yer tutucular eşit; site top10.* 7 dilde), site TOP 10 bölümü + maskeli veri yolu.
// Çalıştırma: node tests/test_simumav_avatar.mjs
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const APP = join(ROOT, 'static/simumav/app'), SITE = join(ROOT, 'static/simumav/site');
let n = 0;
const test = async (name, fn) => { await fn(); n++; console.log(`  ✓ ${name}`); };

// ---- sahte DOM tuvali (CanvasTexture / 2B çizim için) — tüm çağrıları kaydeder
const calls = [];
const ctx2d = new Proxy({}, { get: (o, k) => (k in o ? o[k] : (k === 'createLinearGradient' || k === 'createRadialGradient' ? () => ({ addColorStop() {} }) : (...a) => { calls.push(k); })), set: (o, k, v) => { o[k] = v; return true; } });
globalThis.document = { createElement: tag => ({ tagName: tag, width: 0, height: 0, style: {}, getContext: () => ctx2d, toDataURL: () => 'data:image/png;base64,AAA' }), querySelector: () => null };

const core = await import(pathToFileURL(join(APP, 'crew/avatar_core.js')).href);
const mesh = await import(pathToFileURL(join(APP, 'crew/avatar_mesh.js')).href);
const THREE = await import(pathToFileURL(join(ROOT, 'static/vendor/three/three.module.min.js')).href);

await test('avatar_core: eski 2B karakter eşlemesi, deriler, yama/aksesuar listeleri sunucu (avatar.py) ile birebir', () => {
  const py = execFileSync('python3', ['-c', `import importlib.util,json;s=importlib.util.spec_from_file_location('a','app/simumav/avatar.py');m=importlib.util.module_from_spec(s);s.loader.exec_module(m);print(json.dumps({'L':m.LEGACY,'S':m.SKINS,'P':list(m.PATCHES),'A':list(m.ACCESSORIES),'D':m.DEFAULT,'E':{k:list(v) for k,v in m.ENUMS.items()},'C':list(m.COLORS),'B':list(m.BOOLS)}))`], { cwd: ROOT }).toString();
  const S = JSON.parse(py);
  assert.deepEqual(core.LEGACY, S.L); assert.deepEqual(core.SKINS, S.S); assert.deepEqual(core.PATCHES, S.P); assert.deepEqual(core.ACCESSORIES, S.A); assert.deepEqual(core.DEFAULT, S.D);
  assert.deepEqual(core.ENUMS, S.E, '§28 karakter seçenekleri'); assert.deepEqual(core.COLOR_KEYS, S.C); assert.deepEqual(core.BOOL_KEYS, S.B);
  assert.deepEqual([...core.AVATAR_FIELDS].sort(), Object.keys(S.D).filter(k => k !== 'v').sort(), 'gövde alanları = şema');
  assert.equal(Object.keys(core.SKINS).length, 8);
});

await test('normAvatar: geçersiz alan → karakter varsayılanı, JSON dizesi, küçük harf, bilinmeyen alan atılır', () => {
  assert.deepEqual(core.normAvatar(null, 'p04'), core.legacy('p04'));
  assert.equal(core.normAvatar('{"helmet":"#ABCDEF"}').helmet, '#abcdef');
  const a = core.normAvatar({ helmet: 'red', skin: 's9', patch: 'skull', accessory: 'x', mirror: 'evet', evil: '<script>' }, 'p09');
  assert.deepEqual(a, core.legacy('p09'));
  assert.equal(core.normAvatar('bozuk{').v, 2);
  assert.deepEqual(Object.keys(core.avatarBody({ helmet: '#000000', bot: true })), core.AVATAR_FIELDS);
  assert.deepEqual(core.normAvatar({ hair: 'dreadlock', headgear: 'tac', body: 'x', freckles: 'evet', hair_color: 'mavi' }), core.legacy('p01'), '§28 geçersiz alanlar');
});

await test('bot avatarı (HEPGO §44): AI kask, seviye rengi; oyuncu → avatar eşlemesi (negatif kimlik = bot)', () => {
  const b = core.playerAvatar({ id: -2, is_bot: true, level: 'hard' });
  assert.equal(b.bot, true); assert.equal(b.patch_color, core.BOT_LEVEL_COLOR.hard); assert.equal(b.helmet, '#2b2f36');
  assert.equal(core.playerAvatar({ id: -5 }).bot, true);
  const p = core.playerAvatar({ id: 3, avatar: { helmet: '#123456' } }); assert.equal(p.helmet, '#123456'); assert.ok(!p.bot);
  assert.deepEqual(core.playerAvatar({ id: 3 }), core.legacy('p01'));
  assert.notEqual(core.avatarKey(core.botAvatar('easy')), core.avatarKey(core.botAvatar('hard')));
});

await test('avatarKey kararlı (alan sırası), boyut anahtarda; rastgele avatar geçerli ve tohumla belirlenimci', () => {
  const a = { helmet: '#111111', suit: '#222222' }, b = { suit: '#222222', helmet: '#111111' };
  assert.equal(core.avatarKey(a), core.avatarKey(b)); assert.notEqual(core.avatarKey(a, 128), core.avatarKey(a, 256));
  let s = 7; const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  const r1 = core.randomAvatar(rnd); s = 7; const r2 = core.randomAvatar(rnd);
  assert.deepEqual(r1, r2); assert.deepEqual(core.normAvatar(r1), r1);
  assert.equal(core.shade('#808080', -0.5), '#404040'); assert.equal(core.shade('#000000', 1), '#ffffff');
});

await test('§28 geriye uyum: v1 kayıt (yalnız kask/tulum alanları) → v2, karakter alanları varsayılan (erkek, kısa saç, kasklı, vizör kapalı)', () => {
  const v1 = { v: 1, helmet: '#b91c1c', visor: '#1a1a1a', mirror: true, suit: '#b91c1c', skin: 's6', patch: 'star', patch_color: '#f5c542', accessory: 'crest' };
  const a = core.normAvatar(JSON.stringify(v1), 'p04');
  assert.equal(a.v, 2); assert.equal(a.helmet, '#b91c1c'); assert.equal(a.accessory, 'crest');
  for (const k of ['body', 'hair', 'headgear', 'visor_open', 'beard', 'glasses', 'outfit', 'face']) assert.equal(a[k], core.DEFAULT[k], k);
  assert.equal(a.headgear, 'helmet'); assert.equal(a.visor_open, false);
  assert.notEqual(core.avatarKey(v1), core.avatarKey({ ...v1, hair: 'long' }), 'anahtar §28 alanlarını içerir');
  assert.ok(core.avatarKey(v1).startsWith('v2|'));
});

await test('§28 rastgele karakter: tutarlı (kadında sakal yok), "Cinsiyeti koru", bedene göre saç olasılığı, belirlenimci, switchBody', () => {
  let s = 99; const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  const cnt = { m: 0, f: 0 }, hairIn = { m: 0, f: 0 };
  for (let i = 0; i < 2000; i++) {
    const a = core.randomAvatar(rnd);
    assert.deepEqual(core.normAvatar(a), a, 'geçerli');
    cnt[a.body]++;
    if (core.HAIR_BY_BODY[a.body].includes(a.hair)) hairIn[a.body]++;
    if (a.body === 'f') assert.equal(a.beard, 'none');
    if (a.headgear !== 'helmet') assert.equal(a.visor_open, false);
  }
  assert.ok(cnt.m > 800 && cnt.f > 800, JSON.stringify(cnt));
  assert.ok(hairIn.m / cnt.m > 0.8 && hairIn.f / cnt.f > 0.8, 'saç bedene uygun ağırlıklı');
  for (let i = 0; i < 200; i++) assert.equal(core.randomAvatar(rnd, { body: 'f' }).body, 'f');
  s = 5; const r1 = core.randomAvatar(rnd); s = 5; assert.deepEqual(core.randomAvatar(rnd), r1);
  const m = core.normAvatar({ body: 'm', beard: 'full', hair: 'mohawk' });
  const f = core.switchBody(m, 'f'); assert.equal(f.body, 'f'); assert.equal(f.beard, 'none'); assert.ok(core.HAIR_BY_BODY.f.includes(f.hair));
  assert.equal(core.switchBody(core.normAvatar({ body: 'f', hair: 'bun' }), 'm').hair, 'short');
  assert.equal(core.switchBody(core.normAvatar({ body: 'f', hair: 'curly' }), 'm').hair, 'curly', 'iki listede de olan saç korunur');
});

await test('§28 tam boy karakter (avatar_body): her saç × başlık × beden, yüz seçenekleri; ayak → baş yüksekliği; kemikler; RC tutuşu; dispose', () => {
  const body = mesh;
  for (const b of core.BODIES) for (const hair of core.HAIRS) for (const headgear of core.HEADGEAR) {
    const g = body.buildAvatar(THREE, { body: b, hair, headgear, beard: 'goatee', glasses: 'sun', freckles: true, mole: true }, { pose: 'full', name: 'X' });
    const bb = new THREE.Box3().setFromObject(g);
    assert.ok(bb.min.y < -2.8 && bb.min.y > -3.05 && bb.max.y > 0.85 && bb.max.y < 1.5, `${b}/${hair}/${headgear} ${bb.min.y} ${bb.max.y}`);
    assert.ok(g.userData.bones.torso && g.userData.bones.head && g.userData.head);
    g.userData.dispose();
  }
  for (const [k, list] of Object.entries(core.ENUMS)) for (const v of list) { const g = body.buildAvatar(THREE, { [k]: v, headgear: 'none' }, { pose: 'full' }); g.userData.dispose(); }
  const rc = body.buildAvatar(THREE, core.legacy('p02'), { pose: 'full', rc: true });
  assert.ok(rc.userData.bones.rc && rc.userData.bones.stickL && rc.userData.bones.stickR, 'kumanda + çubuk kemikleri');
  rc.userData.dispose();
  const cam = new THREE.PerspectiveCamera(); assert.equal(mesh.framePortrait(cam, { view: 'face' }), mesh.FRAMES.face); assert.equal(mesh.framePortrait(cam, { view: 'body' }), mesh.FRAMES.body);
  mesh.framePortrait(cam); assert.ok(cam.position.z > 2 && cam.fov === 28, 'büst kadrajı değişmedi (önbellek portreleri)');
});

await test('avatar_mesh: tüm yama × aksesuar × vizör birleşimleri + bot gerçek three.js ile kurulur (WebGL yok), dispose', () => {
  let maxMesh = 0;
  for (const patch of core.PATCHES) for (const accessory of core.ACCESSORIES) for (const mirror of [true, false]) {
    const g = mesh.buildAvatar(THREE, { ...core.legacy('p01'), patch, accessory, mirror }, { name: 'Ayşe' });
    let k = 0; g.traverse(o => { if (o.isMesh) { k++; assert.ok(o.geometry.attributes.position.count > 0); } });
    maxMesh = Math.max(maxMesh, k);
    const box = new THREE.Box3().setFromObject(g);
    assert.ok(box.max.y > 0.9 && box.max.y < 1.4 && box.min.y > -0.9, `boyut ${box.min.y} ${box.max.y}`);
    g.userData.dispose();
  }
  assert.ok(maxMesh <= 80, `düşük poli büst: ${maxMesh} parça`);
  const bot = mesh.buildAvatar(THREE, core.botAvatar('hard'));
  let tex = 0; bot.traverse(o => { if (o.material?.map) tex++; });
  assert.ok(tex >= 3, 'AI kask yazıları (alın + iki yan)');
  const scene = new THREE.Scene(); assert.equal(mesh.addAvatarLights(THREE, scene).length, 3);
  const cam = new THREE.PerspectiveCamera(); mesh.framePortrait(cam); assert.ok(cam.position.z > 2);
});

await test('2B yedek portre + yama çizimi her türde hata vermez', () => {
  calls.length = 0;
  for (const p of core.PATCHES) mesh.drawPatch(ctx2d, p, '#fff', 20, 20, 18);
  mesh.drawAvatar2D(ctx2d, core.botAvatar(), 128);
  for (const c of Object.keys(core.LEGACY)) mesh.drawAvatar2D(ctx2d, core.legacy(c), 64);
  for (const hair of core.HAIRS) for (const headgear of core.HEADGEAR) for (const body of core.BODIES) mesh.drawAvatar2D(ctx2d, { hair, headgear, body, beard: 'full', glasses: 'aviator', freckles: true, visor_open: true }, 64);   // §28
  assert.ok(calls.includes('fill') && calls.includes('ellipse') && calls.includes('fillText'));
});

await test('WebGL kuralı: yarış HUD\'u/salon three çağırmaz; avatar3d uçuşta (.sm-fly-session) snapshot\'a gitmez; snapshot paylaşılan çizicide', () => {
  const hud = readFileSync(join(APP, 'fly/match_hud.js'), 'utf8'), lobby = readFileSync(join(APP, 'fly/match.js'), 'utf8');
  for (const src of [hud, lobby]) { assert.ok(!/core\/three\.js|loadThree|WebGLRenderer|makeStage|mountAvatarStage/.test(src)); }
  assert.match(hud, /playerImg\(p\)/); assert.match(hud, /rowImg\(/); assert.match(lobby, /precacheAvatars\(/);
  const av = readFileSync(join(APP, 'crew/avatar3d.js'), 'utf8');
  assert.match(av, /\.sm-fly-session/);
  const fn = av.slice(av.indexOf('export function avatarImage'), av.indexOf('export function precacheAvatars'));
  assert.ok(fn.indexOf('inFlight()') > -1 && fn.indexOf('inFlight()') < fn.indexOf('snapshot('), 'uçuş denetimi snapshot\'tan önce');
  assert.equal((fn.match(/inFlight\(\)/g) || []).length >= 2, true, 'kuyruktan sonra da denetlenir');
  assert.ok(!/new THREE\.WebGLRenderer|getContext\('webgl/.test(av), 'avatar3d kendi bağlamını açmaz');
  const th = readFileSync(join(APP, 'core/three.js'), 'utf8');
  const sn = th.slice(th.indexOf('export function snapshot'), th.indexOf('export function makeStage'));
  assert.match(sn, /ensureShared\(lib\)/); assert.ok(!/new THREE\.WebGLRenderer/.test(sn));
  const site = readFileSync(join(SITE, 'js/top10.js'), 'utf8');
  assert.ok(!/WebGLRenderer/.test(site) && /renderTo\(/.test(site), 'site: stage.js tek bağlam');
});

await test('i18n: avatar.* / top10.* / settings.lb_hidden 7 dilde (oyun), top10.* + nav.top10 7 dilde (site); yer tutucular eşit', () => {
  const used = new Set();
  for (const f of ['crew/index.js', 'menu/top10.js', 'menu/index.js', 'settings/index.js']) {
    const src = readFileSync(join(APP, f), 'utf8');
    for (const m of src.matchAll(/\bt\(\s*[`']((?:avatar|top10)\.[\w.]+|settings\.lb_\w+)[`']/g)) used.add(m[1]);
    for (const m of src.matchAll(/t\(`avatar\.(patch|acc)_\$\{k\}`\)/g)) for (const k of (m[1] === 'patch' ? core.PATCHES : core.ACCESSORIES)) used.add(`avatar.${m[1]}_${k}`);
  }
  for (const k of ['helmet', 'visor', 'suit', 'patch_color']) used.add(`avatar.${k}`);
  for (const [k, list] of Object.entries(core.ENUMS)) { used.add(`avatar.${k}`); for (const v of list) used.add(`avatar.${k}_${v}`); }   // §28 opts(key, list) → avatar.<key>_<v>
  for (const k of ['body', 'face', 'hair', 'outfit', 'acc']) used.add(`avatar.tab_${k}`);
  for (const v of ['body', 'face']) used.add(`avatar.view_${v}`);
  used.add('camera.view_pilot_eye');
  used.add('top10.p_30d'); used.add('top10.p_all');
  assert.ok(used.size > 30, `${used.size}`);
  const ph = s => [...String(s).matchAll(/\{(\w+)\}/g)].map(m => m[1]).sort().join(',');
  const tr = JSON.parse(readFileSync(join(APP, 'i18n/tr.json'), 'utf8'));
  for (const l of ['tr', 'en', 'de', 'fr', 'es', 'ru', 'ar']) {
    const d = JSON.parse(readFileSync(join(APP, `i18n/${l}.json`), 'utf8'));
    for (const k of used) { assert.ok(typeof d[k] === 'string' && d[k], `${l} ${k}`); assert.equal(ph(d[k]), ph(tr[k]), `${l} ${k} yer tutucu`); }
    const s = JSON.parse(readFileSync(join(SITE, `i18n/${l}.json`), 'utf8'));
    for (const k of ['nav.top10', 'top10.kicker', 'top10.title', 'top10.sub', 'top10.period', 'top10.p_30d', 'top10.p_all', 'top10.formula', 'top10.privacy', 'top10.loading', 'top10.empty', 'top10.error', 'top10.pts', 'top10.wins', 'top10.flights'])
      assert.ok(typeof s[k] === 'string' && s[k], `site ${l} ${k}`);
  }
});

await test('site TOP 10 bölümü: dönem sekmeleri, tembel modül, maskeli veri yalnız textContent/escape ile; ham kimlik alanı kullanılmaz', () => {
  const html = readFileSync(join(SITE, 'index.html'), 'utf8');
  assert.match(html, /id="top10"/); assert.match(html, /data-top10-period="30d"/); assert.match(html, /data-top10-period="all"/); assert.match(html, /css\/top10\.css/);
  assert.match(html, /href="#top10"/);
  const js = readFileSync(join(SITE, 'js/top10.js'), 'utf8');
  assert.match(js, /\/api\/leaderboard/); assert.match(js, /esc\(p\.name\)/); assert.match(js, /esc\(p\.email\)/); assert.ok(!/user_id|\.id\b/.test(js));
  assert.match(readFileSync(join(SITE, 'js/site.js'), 'utf8'), /initTop10Lazy\(\)/);
});

console.log(`\n${n} test geçti`);
