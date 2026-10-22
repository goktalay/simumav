// SIMUMAV oyun arayüzü statik denetimleri: i18n anahtar eşitliği (7 dil), inline script/style yok, router tablosu,
// modül dosyaları ve t() ile kullanılan anahtarların sözlükte bulunması. Çalıştır: node tests/test_simumav_ui.mjs
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const APP = join(ROOT, 'static/simumav/app');
const LANGS = ['tr', 'en', 'de', 'fr', 'es', 'ru', 'ar'];
let n = 0;
const ok = msg => { n++; console.log('  ✓', msg); };

// 1) i18n anahtar eşitliği
const dicts = Object.fromEntries(LANGS.map(l => [l, JSON.parse(readFileSync(join(APP, 'i18n', `${l}.json`), 'utf8'))]));
const base = Object.keys(dicts.tr).sort();
assert.ok(base.length > 150, 'tr.json anahtar sayısı');
for (const l of LANGS) {
  const keys = Object.keys(dicts[l]).sort();
  const missing = base.filter(k => !keys.includes(k)), extra = keys.filter(k => !base.includes(k));
  assert.deepEqual([missing, extra], [[], []], `${l}.json anahtarları tr ile eşit değil (eksik: ${missing}, fazla: ${extra})`);
  for (const k of base) assert.ok(typeof dicts[l][k] === 'string' && dicts[l][k].trim(), `${l}.json ${k} boş`);
  // {değişken} yer tutucuları korunmuş mu
  for (const k of base) { const v = (dicts.tr[k].match(/\{\w+\}/g) || []).sort(); const w = (dicts[l][k].match(/\{\w+\}/g) || []).sort(); assert.deepEqual(w, v, `${l}.json ${k} yer tutucu farkı`); }
}
ok(`i18n: ${LANGS.length} dil × ${base.length} anahtar eşit`);

// 2) Kodda kullanılan sabit t('...') anahtarları sözlükte var mı
const files = [];
const walk = d => { for (const f of readdirSync(d)) { const p = join(d, f); if (statSync(p).isDirectory()) walk(p); else if (p.endsWith('.js')) files.push(p); } };
walk(APP);
const used = new Set();
for (const f of files) for (const m of readFileSync(f, 'utf8').matchAll(/\bt\('([a-z0-9_.]+)'[,)]/g)) used.add(m[1]);
const missingKeys = [...used].filter(k => !(k in dicts.tr));
assert.deepEqual(missingKeys, [], `sözlükte olmayan anahtarlar: ${missingKeys}`);
ok(`kodda kullanılan ${used.size} sabit anahtar sözlükte var`);

// 3) index.html: inline script/style yok, CDN yok, three vendor'dan
const html = readFileSync(join(APP, 'index.html'), 'utf8');
assert.ok(!/<script(?![^>]*\ssrc=)[^>]*>[\s\S]*?<\/script>/i.test(html), 'inline script var');
assert.ok(!/<style[\s>]/i.test(html), 'inline <style> var');
assert.ok(!/\sstyle="/i.test(html), 'style= özniteliği var');
assert.ok(!/\son\w+="/i.test(html), 'on* inline olay var');
assert.ok(!/https?:\/\/(cdn|unpkg|cdnjs)/i.test(html), 'CDN referansı var');
for (const f of files) { const s = readFileSync(f, 'utf8'); assert.ok(!/setAttribute\('style'/.test(s), `${f}: setAttribute('style')`); assert.ok(!/\.innerHTML\s*=\s*`[^`]*<script/i.test(s), `${f}: innerHTML script`); }
const three = readFileSync(join(APP, 'core/three.js'), 'utf8');
assert.ok(three.includes("'/vendor/three/'"), 'three.js vendor yolundan yüklenmeli');
ok('CSP: inline script/style yok, CDN yok, three.js /vendor/three/');

// 4) Router tablosu: 8 rota, fly → fly/index.js (bu ajan oluşturmaz), diğer modüller var ve mount dışa aktarır
const app = readFileSync(join(APP, 'app.js'), 'utf8');
const routes = [...app.matchAll(/^\s+(\w+): \(\) => import\('\.\/([\w/]+)\.js'\)/gm)].map(m => [m[1], m[2]]);
assert.deepEqual(routes.map(r => r[0]), ['menu', 'hangar', 'crew', 'tracks', 'missions', 'fly', 'ops', 'settings', 'support'], 'rota tablosu');
for (const [name, path] of routes) {
  if (name === 'fly') { assert.equal(path, 'fly/index'); continue; }
  const p = join(APP, `${path}.js`);
  assert.ok(existsSync(p), `${p} yok`);
  assert.ok(/export async function mount\(/.test(readFileSync(p, 'utf8')), `${path} mount dışa aktarmıyor`);
}
ok('router: 9 rota; fly/index.js Uç ajanına bırakıldı; diğer 8 modül mount() veriyor');

// 4b) Destek (§9): yaşam simidi düğmesi kabukta ve fly'da gizli; ayarlar kartı; uçuş raporunda "sorun bildir"; saf yardımcılar
{
  assert.ok(/id="help" class="help"/.test(html), 'index.html #help düğmesi');
  assert.ok(/help\.hidden = name === 'fly'/.test(app) && /openReportModal\(ctx\)/.test(app), 'app.js: help fly\'da gizli, tıklama → openReportModal');
  assert.ok(/openReportModal\(ctx, \{ source: 'settings' \}\)/.test(readFileSync(join(APP, 'settings/index.js'), 'utf8')), 'ayarlar kartı');
  const sessSrc = readFileSync(join(APP, 'fly/session.js'), 'utf8');
  assert.ok(/support\.report_flight/.test(sessSrc) && /flightId: fid, ctx/.test(sessSrc), 'uçuş raporu → sorun bildir (uçuş kimliğiyle)');
  const sup = await import(join(APP, 'support/rules.js'));
  assert.ok(/from '\.\/rules\.js'/.test(readFileSync(join(APP, 'support/index.js'), 'utf8')), 'support/index.js kuralları rules.js\'den alır');
  assert.deepEqual(sup.CATEGORIES, ['flight', 'account', 'hangar', 'track', 'mp', 'perf', 'other']);
  for (const k of sup.CATEGORIES) assert.ok(`support.cat_${k}` in dicts.tr, `support.cat_${k}`);
  for (const s of ['acik', 'yanit_bekliyor', 'cozuldu', 'kapali']) assert.ok(`support.st_${s}` in dicts.tr, `support.st_${s}`);
  assert.equal(sup.fileProblem(null), 'support.shot_none');
  assert.equal(sup.fileProblem({ type: 'image/gif', size: 10 }), 'support.shot_badtype');
  assert.equal(sup.fileProblem({ type: 'image/png', size: sup.MAX_FILE + 1 }), 'support.shot_toolarge');
  assert.equal(sup.fileProblem({ type: 'image/jpeg', size: 1000 }), null);
  assert.equal(sup.MAX_SUBJECT, 120); assert.equal(sup.MAX_BODY, 4000);
  const cx = sup.collectContext({ ua: 'UA'.repeat(200), lang: 'tr', width: 1440, height: 900, dpr: 2, flightId: 7, route: '#/menu', gl: 'SwiftShader' });
  assert.equal(cx.ua.length, 300); assert.equal(cx.screen, '1440x900@2.0'); assert.equal(cx.flight_id, 7); assert.equal(cx.gl, 'SwiftShader'); assert.equal(sup.collectContext({}).flight_id, null);
  const css = readFileSync(join(APP, 'theme.css'), 'utf8');
  assert.ok(/\.help \{/.test(css) && /\[dir="rtl"\] \.help/.test(css) && /\.sup-form/.test(css), 'theme.css: .help + RTL + .sup-*');
}
ok('destek: #help düğmesi, ayarlar kartı, uçuş raporu düğmesi, kategori/durum i18n, dosya kuralı');

// 5) Pilot karakterleri ve ikon dosyaları
for (let i = 1; i <= 10; i++) assert.ok(existsSync(join(APP, 'img/pilots', `p${String(i).padStart(2, '0')}.svg`)), `p${i} yok`);
for (const ic of ['hangar', 'crew', 'tracks', 'missions', 'fly', 'ops']) assert.ok(existsSync(join(APP, 'img/icons', `${ic}.svg`)), `${ic}.svg yok`);
ok('10 pilot SVG + 6 modül ikonu');

// 6) simapi.js yalnız core/api.js üzerinden kullanılmalı; modüller doğrudan fetch('/api') yapmamalı
for (const f of files) {
  if (f.endsWith('core/api.js')) continue;
  const s = readFileSync(f, 'utf8');
  assert.ok(!/from '\.\.?\/simapi\.js'/.test(s), `${f}: simapi.js doğrudan içe aktarılmış`);
  assert.ok(!/fetch\(['"`]\/api\//.test(s), `${f}: doğrudan fetch('/api')`);
}
ok('API erişimi core/api.js üzerinden');

// 7) WebGL bağlam sayacı (core/gl.js, saf): webgl/webgl2 bağlamları izlenir, kaybedilen bağlam sayılmaz, 2d sayılmaz; sarmalama idempotent
const { createGlCounter, installGlCounter } = await import(join(APP, 'core/gl.js'));
{
  const cnt = createGlCounter();
  const mk = () => { let lost = false; return { width: 1, height: 1, className: 'x', isConnected: true, gl: { isContextLost: () => lost, lose: () => { lost = true; } } }; };
  const a = mk(), b = mk();
  cnt.track(a, a.gl); cnt.track(b, b.gl); cnt.track(a, a.gl);
  assert.equal(cnt.count(), 2); assert.ok(cnt.isGl('webgl2') && cnt.isGl('WebGL') && !cnt.isGl('2d') && !cnt.isGl('bitmaprenderer'));
  a.gl.lose(); assert.equal(cnt.count(), 1); assert.equal(cnt.list().length, 1);
  // sahte pencere: prototip sarmalaması; getContext('2d') izlenmez, 'webgl' izlenir; __smGl() sayı verir; ikinci kurulum aynı sayaç
  const made = [];
  class FakeCanvas { constructor() { this.width = 2; this.height = 2; this.className = ''; this.isConnected = false; } getContext(type) { if (type === '2d') return { fillRect() {} }; const gl = { lost: false, isContextLost() { return this.lost; } }; made.push(gl); return gl; } }
  const win = { HTMLCanvasElement: FakeCanvas };
  const c1 = installGlCounter(win), c2 = installGlCounter(win);
  assert.equal(c1, c2);
  const k1 = new FakeCanvas(), k2 = new FakeCanvas(), k3 = new FakeCanvas();
  k1.getContext('2d'); k2.getContext('webgl'); k3.getContext('webgl2', { alpha: true });
  assert.equal(win.__smGl(), 2); assert.equal(win.__smGl.list().length, 2);
  made[0].lost = true; assert.equal(win.__smGl(), 1);
}
ok('core/gl.js: bağlam sayacı (webgl/webgl2 izlenir, 2d ve kaybedilen sayılmaz, idempotent kurulum)');

// 8) Tek paylaşılan çizici: yalnız core/three.js ve fly/ (HEPGO sahnesi) WebGLRenderer kurar; kabuk modülleri makeStage kullanır; app.js sayacı kurar
for (const f of files) {
  const s = readFileSync(f, 'utf8');
  if (f.endsWith('core/three.js') || f.includes('/fly/')) continue;
  assert.ok(!/new\s+\w+\.WebGLRenderer/.test(s), `${f}: WebGLRenderer doğrudan kurulmuş (makeStage kullanın)`);
}
assert.equal((three.match(/new THREE\.WebGLRenderer/g) || []).length, 1, 'core/three.js tek paylaşılan WebGLRenderer');
assert.ok(/forceContextLoss/.test(three) && /export function releaseShared/.test(three) && /drawImage\(/.test(three), 'paylaşılan çizici: releaseShared + forceContextLoss + 2B kopya');
assert.ok(/installGlCounter\(\)/.test(app), 'app.js __smGl sayacını kurmalı');
assert.ok(/await state\.unmount\?\.\(\)/.test(app), 'router unmount Promise\'ini beklemeli');
const sess = readFileSync(join(APP, 'fly/session.js'), 'utf8');
assert.ok(/releaseShared\(\)/.test(sess) && /\/stop`, \{ reason: 'webgl' \}/.test(sess), 'session.js: sahne öncesi releaseShared; sahne hatasında uçuş stop');
ok('tek paylaşılan WebGLRenderer; Uç sahnesi öncesi bağlam bırakılır; sahne hatasında otomatik stop');

// 9) Oyun kabuğu görsel yükseltme — saf çekirdekler: uçuş yolu/kamera/kalite yöneticisi (menu/flightcore.js), ses tablosu (ui/sfx.js), FLIP (ui/transition.js), ikonlar
{
  const fc = await import(join(APP, 'menu/flightcore.js'));
  // uçuş yolu: sürekli, alçak irtifa (30–65 m), yatış sınırlı, hız > 0
  for (let t = 0; t < 120; t += 0.5) { const p = fc.flightPath(t); assert.ok(p.alt > 30 && p.alt < 65, `irtifa ${p.alt}`); assert.ok(Math.abs(p.bank) <= 0.75); assert.ok(p.speed > 0); assert.ok(Number.isFinite(p.heading)); }
  // kamera döngüsü: 5 kip, toplam süre; her kipte poz araziden yukarıda; FPV geniş açı; parallax hafif kaydırır
  assert.equal(fc.CAM_CYCLE.length, 5); assert.equal(fc.CAM_PERIOD, 62);
  const ground = () => 0;
  const seen = new Set();
  for (let t = 0; t < fc.CAM_PERIOD * 2; t += 0.25) { const p = fc.flightPath(t); const c = fc.cameraPose(t, { x: p.x, y: p.alt, z: p.z, heading: p.heading }, ground); seen.add(c.mode); assert.ok(c.pos.y >= 1.8, `kamera yerin altında (${c.mode})`); assert.ok(c.fov >= 38 && c.fov <= 95); assert.ok(c.blend >= 0 && c.blend <= 1); }
  assert.deepEqual([...seen].sort(), ['chase', 'fpv', 'ground', 'orbit', 'side']);
  assert.equal(fc.cameraPose(fc.CAM_CYCLE[0].dur + fc.CAM_CYCLE[1].dur + 1, { x: 0, y: 50, z: 0, heading: 0 }, ground).mode, 'fpv');
  const base = fc.cameraPose(3, { x: 0, y: 50, z: 0, heading: 0 }, ground), par = fc.cameraPose(3, { x: 0, y: 50, z: 0, heading: 0 }, ground, { x: 1, y: 0 });
  assert.ok(Math.abs(par.pos.x - base.pos.x) > 1 && Math.abs(par.pos.x - base.pos.x) < 8, 'parallax hafif');
  // arazi altına girmez
  assert.ok(fc.cameraPose(45, { x: 0, y: 50, z: 0, heading: 0 }, () => 200).pos.y >= 201.8);
  // prosedürel arazi: merkez düz, sınırlı
  const nz = fc.makeNoise(7); assert.ok(Math.abs(fc.procHeight(nz, 0, 0)) < 1e-9 && Math.abs(fc.procHeight(nz, 100, -100)) < 1e-9, 'merkez düz');
  for (let i = 0; i < 200; i++) { const h = fc.procHeight(nz, (Math.random() - 0.5) * 3000, (Math.random() - 0.5) * 3000); assert.ok(h > -60 && h < 260, `yükseklik ${h}`); }
  // kalite yöneticisi: yavaş kareler → seviye düşer (histerezis), hızlı kareler 3 pencere sonra yükselir; dev dt yoksayılır
  const g = fc.createQualityGovernor({ start: 1, windowFrames: 10 });
  assert.equal(g.level().name, 'high');
  let changed = 0; for (let i = 0; i < 10; i++) changed += g.push(40) ? 1 : 0; assert.equal(changed, 1); assert.equal(g.level().name, 'medium');
  for (let i = 0; i < 10; i++) g.push(40); assert.equal(g.level().name, 'low');
  for (let i = 0; i < 20; i++) g.push(10); assert.equal(g.level().name, 'low', 'iki iyi pencere yetmez');
  for (let i = 0; i < 10; i++) g.push(10); assert.equal(g.level().name, 'medium', 'üçüncü iyi pencerede yükselir');
  for (let i = 0; i < 10; i++) assert.equal(g.push(900), false, 'sekme gizliyken dev dt yoksayılır');
  assert.equal(g.stats().level, 'medium');
  assert.equal(fc.QUALITY_LEVELS.at(-1).particles, 0);
  // model yolu TEK sabitten: önce gerçekçi GLB yolu (static/simumav/models/<tip>.glb), sonra HEPGO caymaz, en son procmodels (kodda)
  assert.deepEqual(fc.modelCandidates('plane'), ['/static/models/caymaz-sim.glb']);   // plane.glb hiç yoktu (konsolda 404)
  // her aday dosya depoda gerçekten var (menü açılışında 404 gürültüsü olmasın)
  for (const urls of Object.values(fc.MODEL_URLS)) for (const u of urls) assert.ok(existsSync(new URL(`..${u}`, import.meta.url)), `model dosyası yok: ${u}`);
  assert.ok(fc.modelCandidates('bilinmeyen').length >= 1);
  const flightSrc = readFileSync(join(APP, 'menu/flight.js'), 'utf8');
  assert.ok(!/\.glb'/.test(flightSrc.replace(/\/\/.*$/gm, '')), 'flight.js model yolunu kendisi yazmaz; flightcore MODEL_URLS kullanır');
  assert.ok(/prefers-reduced-motion/.test(flightSrc) && /renderOnce\(\)/.test(flightSrc), 'reduced-motion: tek statik kare');
  assert.ok(/createQualityGovernor/.test(flightSrc) && /setPixelRatioMax/.test(flightSrc), 'kalite yöneticisi piksel oranını yönetir');
  // ses: tablo + zarf saf
  const sfx = await import(join(APP, 'ui/sfx.js'));
  for (const k of ['hover', 'select', 'back', 'error', 'sweep', 'takeoff', 'land', 'tick']) assert.ok(sfx.SFX_DEFS[k]?.dur > 0 && sfx.SFX_DEFS[k].gain > 0 && sfx.SFX_DEFS[k].gain <= 0.4, `sfx ${k}`);
  assert.equal(sfx.env(-1, 1), 0); assert.equal(sfx.env(2, 1), 0); assert.ok(sfx.env(0.08, 1) > sfx.env(0.9, 1));
  assert.ok(Math.abs(sfx.sweepFreq(0, 1, 100, 400) - 100) < 1e-9 && Math.abs(sfx.sweepFreq(1, 1, 100, 400) - 400) < 1e-9 && Math.abs(sfx.sweepFreq(0.5, 1, 100, 400) - 200) < 1e-9);
  assert.equal(sfx.config().engine, false, 'motor sesi varsayılan kapalı');
  sfx.configure({ volume: 2 }); assert.equal(sfx.config().volume, 1);
  // geçiş: FLIP keyframe + süre sınırı
  const tr = await import(join(APP, 'ui/transition.js'));
  const kf = tr.flipKeyframes({ x: 100, y: 200, w: 300, h: 150 }, 1200, 600);
  assert.equal(kf.length, 2); assert.ok(kf[0].transform.includes('translate(100px, 200px)') && kf[0].transform.includes('scale(0.25, 0.25)')); assert.equal(kf[1].transform, 'translate(0px, 0px) scale(1, 1)');
  assert.equal(tr.clampDuration(100), 400); assert.equal(tr.clampDuration(2000), 700); assert.equal(tr.clampDuration(520), 520); assert.equal(tr.clampDuration(520, true), 150);
  // menü: 6 kart ikonu animasyonlu SVG parçaları; eğilme hesabı simetrik ve sınırlı
  const icons = readFileSync(join(APP, 'menu/icons.js'), 'utf8');
  for (const [k, cls] of [['hangar', 'door'], ['crew', 'eye'], ['tracks', 'flag'], ['missions', 'route'], ['fly', 'plane'], ['ops', 'hand']]) assert.ok(new RegExp(`${k}: \`[^\`]*class="${cls}`).test(icons), `ikon ${k}: .${cls}`);
  const menuSrc = readFileSync(join(APP, 'menu/index.js'), 'utf8');
  assert.ok(/getGamepads/.test(menuSrc) && /rememberOrigin\(card\)/.test(menuSrc) && /sfx\.select\(\)/.test(menuSrc), 'menü: gamepad, FLIP kaynağı, seçim sesi');
  const fx = readFileSync(join(APP, 'fx.css'), 'utf8');
  assert.ok(/prefers-reduced-motion/.test(fx) && /\.flip-ghost/.test(fx) && /\.mcard-border/.test(fx) && /\.land-dust/.test(fx) && /\.wind-fx/.test(fx) && /\.stamp/.test(fx) && /\.radar-dish/.test(fx) && /max-width: 480px/.test(fx) && /\[dir="rtl"\]/.test(fx), 'fx.css: efekt sınıfları + mobil + RTL + reduced-motion');
  assert.ok(/fx\.css/.test(html), 'index.html fx.css bağlar');
  for (const f of files) { const s = readFileSync(f, 'utf8'); assert.ok(!/https?:\/\/(cdn|unpkg|cdnjs)|gsap/i.test(s), `${f}: CDN/GSAP yok`); }
}
ok('oyun kabuğu: uçuş yolu/kamera/kalite yöneticisi, ses tablosu, FLIP geçiş, animasyonlu ikonlar, fx.css');

console.log(`\n${n} denetim geçti`);
