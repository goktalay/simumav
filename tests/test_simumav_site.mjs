// SIMUMAV tanıtım sitesi: i18n anahtar seti tutarlılığı, CSP (inline script/style yok), her dilde CTA.
// Çalıştır: node tests/test_simumav_site.mjs
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SITE = join(ROOT, 'static/simumav/site');
const LANGS = ['tr', 'en', 'de', 'fr', 'es', 'ru', 'ar'];
let ok = 0;
const test = (name, fn) => { fn(); ok++; console.log('ok -', name); };

const dicts = Object.fromEntries(LANGS.map(l => [l, JSON.parse(readFileSync(join(SITE, 'i18n', `${l}.json`), 'utf8'))]));
const trKeys = Object.keys(dicts.tr).sort();

test('i18n: yedi dil dosyası var', () => {
  const files = readdirSync(join(SITE, 'i18n')).filter(f => f.endsWith('.json')).map(f => f.replace('.json', '')).sort();
  assert.deepEqual(files, [...LANGS].sort());
});

test('i18n: tüm dillerde aynı anahtar seti', () => {
  for (const l of LANGS) {
    const keys = Object.keys(dicts[l]).sort();
    const missing = trKeys.filter(k => !keys.includes(k)), extra = keys.filter(k => !trKeys.includes(k));
    assert.deepEqual({ l, missing, extra }, { l, missing: [], extra: [] });
  }
});

test('i18n: boş değer yok; yer tutucular korunmuş', () => {
  for (const l of LANGS) for (const [k, v] of Object.entries(dicts[l])) {
    assert.ok(typeof v === 'string' && v.trim(), `${l}:${k} boş`);
    for (const ph of (dicts.tr[k].match(/\{\w+\}/g) || [])) assert.ok(v.includes(ph), `${l}:${k} ${ph} eksik`);
  }
});

test('i18n: tüm dillerde CTA (kayıt/giriş) var', () => {
  for (const l of LANGS) for (const k of ['hero.cta', 'cta.register', 'cta.login', 'nav.register', 'nav.login', 'auth.submit.register', 'auth.submit.login'])
    assert.ok(dicts[l][k]?.trim(), `${l}:${k}`);
});

const htmls = ['index.html', 'legal/gizlilik.html', 'legal/kvkk.html', 'legal/kosullar.html'].map(f => [f, readFileSync(join(SITE, f), 'utf8')]);

test('CSP: HTML içinde inline script yok (yalnız src\'li, module)', () => {
  for (const [f, h] of htmls) {
    for (const m of h.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
      assert.ok(/\bsrc=/.test(m[1]), `${f}: src'siz script`);
      assert.equal(m[2].trim(), '', `${f}: script gövdesi dolu`);
    }
    assert.ok(!/\son[a-z]+\s*=/i.test(h), `${f}: on* olay niteliği`);
    assert.ok(!/href\s*=\s*["']javascript:/i.test(h), `${f}: javascript: bağlantısı`);
  }
});

test('CSP: inline style yok (<style> ya da style=)', () => {
  for (const [f, h] of htmls) {
    assert.ok(!/<style\b/i.test(h), `${f}: <style> etiketi`);
    assert.ok(!/\sstyle\s*=/i.test(h), `${f}: style= niteliği`);
  }
});

test('CSP: CDN yok; three.js /vendor/three yolundan', () => {
  const all = [...htmls.map(([, h]) => h), ...['js/site.js', 'js/hero3d.js', 'js/auth.js', 'css/site.css'].map(f => readFileSync(join(SITE, f), 'utf8'))];
  for (const s of all) assert.ok(!/https?:\/\/(cdn\.|unpkg\.com|cdnjs\.|jsdelivr\.net|fonts\.googleapis|esm\.sh)/i.test(s), 'CDN başvurusu');
  assert.match(readFileSync(join(SITE, 'js/hero3d.js'), 'utf8'), /from '\/vendor\/three\/three\.module\.min\.js'/);
});

test('kimlik: hesap servisi adresi sabit yazılmamış; akış prelogin → login → /api/session', () => {
  const a = readFileSync(join(SITE, 'js/auth.js'), 'utf8');
  assert.ok(!/https:\/\/mastertool\.download/.test(a.replace(/\/\/.*$/gm, '')), 'mt_url sabit yazılmış');
  for (const s of ['/auth/prelogin', '/auth/login', '/auth/register', '/auth/forgot', '/auth/resend-verify', "'/api/session'", '/api/meta', 'computeAuthHash', 'dev_user']) assert.ok(a.includes(s), s);
});

test('SEO: başlık, açıklama, og görseli, hreflang', () => {
  const h = htmls[0][1];
  for (const s of ['<title', 'name="description"', 'property="og:image"', 'hreflang="ar"', 'rel="canonical"', 'rel="icon"']) assert.ok(h.includes(s), s);
});

console.log(`\n${ok} test geçti`);
