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
assert.deepEqual(routes.map(r => r[0]), ['menu', 'hangar', 'crew', 'tracks', 'missions', 'fly', 'ops', 'settings'], 'rota tablosu');
for (const [name, path] of routes) {
  if (name === 'fly') { assert.equal(path, 'fly/index'); continue; }
  const p = join(APP, `${path}.js`);
  assert.ok(existsSync(p), `${p} yok`);
  assert.ok(/export async function mount\(/.test(readFileSync(p, 'utf8')), `${path} mount dışa aktarmıyor`);
}
ok('router: 8 rota; fly/index.js Uç ajanına bırakıldı; diğer 7 modül mount() veriyor');

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

console.log(`\n${n} denetim geçti`);
