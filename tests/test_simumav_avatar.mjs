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
  const py = execFileSync('python3', ['-c', `import importlib.util,json;s=importlib.util.spec_from_file_location('a','app/simumav/avatar.py');m=importlib.util.module_from_spec(s);s.loader.exec_module(m);print(json.dumps({'L':m.LEGACY,'S':m.SKINS,'P':list(m.PATCHES),'A':list(m.ACCESSORIES),'D':m.DEFAULT}))`], { cwd: ROOT }).toString();
  const S = JSON.parse(py);
  assert.deepEqual(core.LEGACY, S.L); assert.deepEqual(core.SKINS, S.S); assert.deepEqual(core.PATCHES, S.P); assert.deepEqual(core.ACCESSORIES, S.A); assert.deepEqual(core.DEFAULT, S.D);
  assert.equal(Object.keys(core.SKINS).length, 8);
});

await test('normAvatar: geçersiz alan → karakter varsayılanı, JSON dizesi, küçük harf, bilinmeyen alan atılır', () => {
  assert.deepEqual(core.normAvatar(null, 'p04'), core.legacy('p04'));
  assert.equal(core.normAvatar('{"helmet":"#ABCDEF"}').helmet, '#abcdef');
  const a = core.normAvatar({ helmet: 'red', skin: 's9', patch: 'skull', accessory: 'x', mirror: 'evet', evil: '<script>' }, 'p09');
  assert.deepEqual(a, core.legacy('p09'));
  assert.equal(core.normAvatar('bozuk{').v, 1);
  assert.deepEqual(Object.keys(core.avatarBody({ helmet: '#000000', bot: true })).sort(), ['accessory', 'helmet', 'mirror', 'patch', 'patch_color', 'skin', 'suit', 'visor']);
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
  assert.ok(maxMesh <= 40, `düşük poli: ${maxMesh} parça`);
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
