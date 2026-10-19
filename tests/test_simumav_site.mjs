// SIMUMAV tanıtım sitesi: i18n anahtar seti tutarlılığı, CSP (inline script/style yok), her dilde CTA, dil seçimi kuralı (lang.js), GA4/rıza (analytics.js), hreflang.
// Çalıştır: node tests/test_simumav_site.mjs
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SITE = join(ROOT, 'static/simumav/site');
const APP = join(ROOT, 'static/simumav/app');
const LANGS = ['tr', 'en', 'de', 'fr', 'es', 'ru', 'ar'];
let ok = 0;
const test = (name, fn) => { fn(); ok++; console.log('ok -', name); };

const dicts = Object.fromEntries(LANGS.map(l => [l, JSON.parse(readFileSync(join(SITE, 'i18n', `${l}.json`), 'utf8'))]));
const appDicts = Object.fromEntries(LANGS.map(l => [l, JSON.parse(readFileSync(join(APP, 'i18n', `${l}.json`), 'utf8'))]));
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
const appHtml = readFileSync(join(APP, 'index.html'), 'utf8');

test('CSP: HTML içinde inline script yok (yalnız src\'li, module)', () => {
  for (const [f, h] of [...htmls, ['app/index.html', appHtml]]) {
    for (const m of h.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
      assert.ok(/\bsrc=/.test(m[1]), `${f}: src'siz script`);
      assert.equal(m[2].trim(), '', `${f}: script gövdesi dolu`);
    }
    assert.ok(!/\son[a-z]+\s*=/i.test(h), `${f}: on* olay niteliği`);
    assert.ok(!/href\s*=\s*["']javascript:/i.test(h), `${f}: javascript: bağlantısı`);
    assert.ok(!/googletagmanager|gtag\(/i.test(h), `${f}: gtag HTML'de (analytics.js dışında) olmamalı`);
  }
});

test('CSP: inline style yok (<style> ya da style=)', () => {
  for (const [f, h] of htmls) {
    assert.ok(!/<style\b/i.test(h), `${f}: <style> etiketi`);
    assert.ok(!/\sstyle\s*=/i.test(h), `${f}: style= niteliği`);
  }
});

test('CSP: CDN yok; three.js /vendor/three yolundan; tek dış alan googletagmanager (analytics.js, dinamik)', () => {
  const all = [...htmls.map(([, h]) => h), ...['js/site.js', 'js/hero3d.js', 'js/auth.js', 'js/lang.js', 'css/site.css', 'css/consent.css'].map(f => readFileSync(join(SITE, f), 'utf8'))];
  for (const s of all) assert.ok(!/https?:\/\/(cdn\.|unpkg\.com|cdnjs\.|jsdelivr\.net|fonts\.googleapis|esm\.sh|googletagmanager)/i.test(s), 'CDN/GA başvurusu');
  assert.match(readFileSync(join(SITE, 'js/hero3d.js'), 'utf8'), /from '\/vendor\/three\/three\.module\.min\.js'/);
});

test('kimlik: hesap servisi adresi sabit yazılmamış; akış prelogin → login → /api/session; signup/login olayları', () => {
  const a = readFileSync(join(SITE, 'js/auth.js'), 'utf8');
  assert.ok(!/https:\/\/mastertool\.download/.test(a.replace(/\/\/.*$/gm, '')), 'mt_url sabit yazılmış');
  for (const s of ['/auth/prelogin', '/auth/login', '/auth/register', '/auth/forgot', '/auth/resend-verify', "'/api/session'", '/api/meta', 'computeAuthHash', 'dev_user', "onEvent('signup'", "onEvent('login'"]) assert.ok(a.includes(s), s);
  assert.ok(!/onEvent\([^)]*email/.test(a), 'olaylarda e-posta yok');
});

test('SEO: başlık, açıklama, og görseli, canonical; hreflang 7 dil (?lang=xx) + x-default', () => {
  const h = htmls[0][1];
  for (const s of ['<title', 'name="description"', 'property="og:image"', 'rel="canonical"', 'rel="icon"']) assert.ok(h.includes(s), s);
  for (const l of LANGS) assert.ok(h.includes(`<link rel="alternate" hreflang="${l}" href="https://simumav.com/?lang=${l}">`), `hreflang ${l}`);
  assert.match(h, /<link rel="alternate" hreflang="x-default" href="https:\/\/simumav\.com\/">/);
  assert.match(h, /<title data-i18n="meta\.title">/); assert.match(h, /<meta name="description" data-i18n-attr="content:meta\.desc"/);
  for (const l of LANGS) assert.ok(dicts[l]['meta.title'] && dicts[l]['meta.desc'], `${l} meta`);
});

// ---------- dil seçimi (saf kural; lang.js) ----------
const { pickLang, fromBrowser, langCode, LANGS: L2, DEFAULT_LANG } = await import(pathToFileURL(join(SITE, 'js/lang.js')).href);

test('dil: navigator.languages sırasına göre ilk desteklenen; yoksa İngilizce', () => {
  assert.deepEqual(L2, LANGS); assert.equal(DEFAULT_LANG, 'en');
  assert.equal(pickLang({ languages: ['de-DE', 'de', 'en-US'] }), 'de');
  assert.equal(pickLang({ languages: ['ja-JP', 'ja'] }), 'en');
  assert.equal(pickLang({ languages: ['ja-JP', 'fr-CA', 'en'] }), 'fr');
  assert.equal(pickLang({ languages: ['pt-BR', 'es-419'] }), 'es');
  assert.equal(pickLang({ languages: ['ar-SA'] }), 'ar');
  assert.equal(pickLang({ languages: ['ru'] }), 'ru');
  assert.equal(pickLang({ languages: ['tr-TR'] }), 'tr');
  assert.equal(pickLang({ languages: [] }), 'en'); assert.equal(pickLang({}), 'en'); assert.equal(pickLang(), 'en');
  assert.equal(fromBrowser('de-AT'), 'de'); assert.equal(langCode('ZH-Hant'), 'zh'); assert.equal(langCode(null), '');
});

test('dil: kayıtlı seçim tarayıcı dilini ezer; ?lang ikisini de ezer; geçersiz değerler atlanır', () => {
  assert.equal(pickLang({ stored: 'fr', languages: ['de-DE'] }), 'fr');
  assert.equal(pickLang({ query: 'ar', stored: 'fr', languages: ['de-DE'] }), 'ar');
  assert.equal(pickLang({ query: 'xx', stored: 'fr', languages: ['de-DE'] }), 'fr');
  assert.equal(pickLang({ query: 'xx', stored: 'yy', languages: ['de-DE'] }), 'de');
  assert.equal(pickLang({ query: '<script>', stored: '', languages: ['ja'] }), 'en');
  assert.equal(pickLang({ query: 'DE' }), 'de');
});

test('dil: site.js ve oyun kabuğu i18n.js lang.js kuralını kullanır; varsayılan tr değil', () => {
  const s = readFileSync(join(SITE, 'js/site.js'), 'utf8'), i = readFileSync(join(APP, 'i18n/i18n.js'), 'utf8'), a = readFileSync(join(APP, 'app.js'), 'utf8');
  assert.ok(s.includes("from './lang.js'") && s.includes('detectLang(') && !/\|\|\s*'tr'/.test(s));
  assert.ok(i.includes("from '/js/lang.js'") && !/navigator\.language\b/.test(i) && !/\|\|\s*'tr'/.test(i));
  assert.ok(a.includes('hasDeviceLang()') && a.includes('state.settings.lang'), 'kabuk: hesap ayarı (settings.lang) cihaz seçimi yoksa uygulanır');
  for (const [f, h] of htmls) assert.match(h, /<html lang="[a-z]{2}" dir="ltr">/, f);
});

// ---------- GA4 + rıza (analytics.js) ----------
const AN = await import(pathToFileURL(join(SITE, 'js/analytics.js')).href);

test('analitik: harici modül; gtag.js yalnız rıza "granted" iken yüklenir; rıza yokken bant', () => {
  const src = readFileSync(join(SITE, 'js/analytics.js'), 'utf8');
  assert.equal(AN.GTAG_SRC, 'https://www.googletagmanager.com/gtag/js'); assert.equal(AN.CONSENT_KEY, 'simumav.consent');
  assert.deepEqual(AN.decide({ consent: null, gaId: 'G-1' }), { load: false, banner: true });
  assert.deepEqual(AN.decide({ consent: 'denied', gaId: 'G-1' }), { load: false, banner: false });
  assert.deepEqual(AN.decide({ consent: 'granted', gaId: 'G-1' }), { load: true, banner: false });
  assert.deepEqual(AN.decide({ consent: 'granted', gaId: '' }), { load: false, banner: false });
  assert.deepEqual(AN.decide({ consent: 'granted', gaId: '', adsId: 'AW-1' }), { load: true, banner: false });   // yalnız Google Ads etiketi
  assert.deepEqual(AN.decide({ consent: 'denied', gaId: '', adsId: 'AW-1' }), { load: false, banner: false });
  const mem = new Map(), storage = { getItem: k => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, v), removeItem: k => mem.delete(k) };
  assert.equal(AN.getConsent(storage), null); AN.storeConsent('granted', storage); assert.equal(AN.getConsent(storage), 'granted');
  AN.storeConsent('denied', storage); assert.equal(AN.getConsent(storage), 'denied'); mem.set('simumav.consent', 'bozuk'); assert.equal(AN.getConsent(storage), null);
  // Consent Mode v2: varsayılan denied, kabulde update granted; anonymize_ip; reklam sinyalleri kapalı
  assert.match(src, /'consent',\s*'default',\s*\{\s*analytics_storage:\s*'denied'/); assert.match(src, /'consent',\s*'update',\s*\{\s*analytics_storage:\s*'granted'/);
  assert.match(src, /anonymize_ip:\s*true/); assert.match(src, /allow_google_signals:\s*false/);
  assert.ok(src.includes("'simumav:consent'") && src.includes('data-consent="manage"'));
});

test('analitik: çerez bandı metinleri 7 dilde (site + oyun kabuğu); gizlilikte GA paragrafı; yasal sayfalarda "Çerez tercihlerini değiştir"', () => {
  const keys = ['cookie.title', 'cookie.text', 'cookie.more', 'cookie.necessary', 'cookie.analytics', 'cookie.settings', 'cookie.reject', 'cookie.accept', 'cookie.save', 'cookie.manage'];
  for (const l of LANGS) for (const k of keys) { assert.ok(dicts[l][k]?.trim(), `site ${l}:${k}`); assert.ok(appDicts[l][k]?.trim(), `app ${l}:${k}`); }
  for (const l of LANGS) { assert.match(dicts[l]['legal.privacy.p5'], /Google Analytics 4/); assert.match(dicts[l]['legal.privacy.p3'], /Google[ -]Analytics/); assert.ok(dicts[l]['legal.privacy.ga.t']); }
  for (const [f, h] of htmls.slice(1)) assert.ok(h.includes('data-consent="manage"') && h.includes('data-i18n="cookie.manage"') && h.includes('css/consent.css'), f);
  assert.ok(htmls[1][1].includes('data-i18n="legal.privacy.p5"'));
  assert.ok(htmls[0][1].includes('css/consent.css') && appHtml.includes('/css/consent.css'));
});

test('analitik: oyun kabuğu aynı modülü kullanır; page_view hash rotası; flight_start/flight_end/signup/login olayları kişisel veri taşımaz', () => {
  const a = readFileSync(join(APP, 'app.js'), 'utf8'), f = readFileSync(join(APP, 'fly/index.js'), 'utf8'), s = readFileSync(join(APP, 'fly/session.js'), 'utf8');
  assert.ok(a.includes("from '/js/analytics.js'") && a.includes('spa: true') && a.includes('pageView(`/app/#/') && a.includes('ga_id'));
  assert.ok(f.includes("'flight_start'") && s.includes("'flight_end'") && s.includes('duration_s'));
  for (const src of [a, f, s]) for (const m of src.matchAll(/track\?*\((?:'flight_start'|'flight_end'|'signup'|'login')[^\n]*/g)) assert.ok(!/email|display_name|user_id|\bname\b|pilot/.test(m[0]), m[0]);
});

console.log(`\n${ok} test geçti`);
