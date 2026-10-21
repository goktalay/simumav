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
  const all = [...htmls.map(([, h]) => h), ...['js/site.js', 'js/hero3d.js', 'js/hangar3d.js', 'js/stage.js', 'js/fleet.js', 'js/theme-boot.js', 'js/auth.js', 'js/lang.js', 'css/site.css', 'css/consent.css'].map(f => readFileSync(join(SITE, f), 'utf8'))];
  for (const s of all) assert.ok(!/https?:\/\/(cdn\.|unpkg\.com|cdnjs\.|jsdelivr\.net|fonts\.googleapis|esm\.sh|googletagmanager)/i.test(s), 'CDN/GA başvurusu');
  const st = readFileSync(join(SITE, 'js/stage.js'), 'utf8');
  assert.match(st, /from '\/vendor\/three\/three\.module\.min\.js'/); assert.match(st, /from '\/vendor\/three\/GLTFLoader\.js'/);
  for (const f of ['js/hero3d.js', 'js/hangar3d.js']) assert.ok(!/vendor\/three|new THREE\.WebGLRenderer/.test(readFileSync(join(SITE, f), 'utf8')), `${f}: kendi çizicisini açmamalı (tek bağlam: stage.js)`);
  assert.equal((st.match(/new THREE\.WebGLRenderer/g) || []).length, 1, 'stage.js tek çizici');
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

// ---------- filo, sinematik, tema, bölümler (fleet.js; saf) ----------
const FL = await import(pathToFileURL(join(SITE, 'js/fleet.js')).href);
const bridge = readFileSync(join(ROOT, 'app/simumav/bridge.py'), 'utf8');
const targetsPy = readFileSync(join(ROOT, 'app/flightsim_targets.py'), 'utf8');

test('filo: anahtarlar bridge.GLB_MODELS ile aynı; hızlar HEDEF_HIZ/BUILTIN_HIZ ile aynı; GLB dosyaları var', () => {
  const glb = bridge.slice(bridge.indexOf('GLB_MODELS = {'), bridge.indexOf('VARSAYILAN_MODEL'));
  const keys = [...glb.matchAll(/^\s{4}'(glb:[a-z0-9_]+)':/gm)].map(m => m[1]);
  const fleetGlb = FL.FLEET.filter(m => m.key.startsWith('glb:')).map(m => m.key);
  assert.deepEqual([...fleetGlb].sort(), [...keys].sort(), 'site filosu = GLB kataloğu');
  const hizOf = ad => [...bridge.slice(bridge.indexOf(`${ad} = {`)).split('}')[0].matchAll(/'(glb:[a-z0-9_]+)': \((\d+), (\d+)\)/g)].map(m => [m[1], [+m[2], +m[3]]]);
  const hiz = Object.fromEntries([...hizOf('HEDEF_HIZ'), ...hizOf('ROVER_HIZ')]);   // §13 kara araçları hedef değil: ayrı hız tablosu
  for (const m of FL.FLEET.filter(x => x.key.startsWith('glb:'))) assert.deepEqual([m.cruise, m.max], hiz[m.key], m.key);
  const cz = targetsPy.match(/'caymaz': \(([\d.]+), ([\d.]+)\)/);
  const caymaz = FL.byId('caymaz'); assert.deepEqual([caymaz.cruise, caymaz.max], [+cz[1], +cz[2]]); assert.equal(caymaz.nose, 'z');
  for (const m of FL.FLEET) {
    assert.ok(m.url.startsWith('/static/') && m.url.endsWith('.glb'), m.url);
    const f = m.url.startsWith('/static/simumav/') ? join(ROOT, 'static/simumav', m.url.slice('/static/simumav/'.length)) : join(ROOT, 'static', m.url.slice('/static/'.length));
    assert.ok(readFileSync(f).length > 1000, f);
    for (const l of LANGS) assert.ok(dicts[l][`fleet.${m.id}.d`]?.trim() && dicts[l][`type.${m.type}`]?.trim(), `${l} fleet.${m.id}`);
  }
});

test('sinematik: sıra CAYMAZ → INTERCEPTOR → diğerleri; reelAt/shotFade karartma ve döngü', () => {
  const r = FL.reelModels();
  assert.equal(r[0].id, 'caymaz'); assert.deepEqual(r.slice(1, 4).map(m => m.type), ['interceptor', 'interceptor', 'interceptor']);
  assert.ok(r.length >= 8 && new Set(r.map(m => m.id)).size === r.length);
  const S = FL.SHOT_SEC, F = FL.FADE_SEC, n = r.length;
  assert.deepEqual(FL.reelAt(0, n), { index: 0, local: 0, fade: 1, progress: 0 });
  assert.equal(FL.reelAt(S / 2, n).fade, 0); assert.equal(FL.reelAt(S / 2, n).index, 0);
  assert.equal(FL.reelAt(S + 0.01, n).index, 1); assert.equal(FL.reelAt(S * n + 0.5, n).index, 0, 'döngü başa sarar');
  assert.ok(Math.abs(FL.shotFade(S - F / 2) - 0.5) < 1e-9); assert.ok(Math.abs(FL.shotFade(F / 2) - 0.5) < 1e-9);
  assert.equal(FL.shotFade(S), 1); assert.equal(FL.reelAt(-5, n).index, 0); assert.equal(FL.reelAt(3, 0).index, 0);
  assert.equal(FL.specLine(FL.byId('caymaz'), 'tr'), '3,03 m · 90–162 km/h');
  assert.equal(FL.specLine(FL.byId('icept_x4'), 'en'), '216–400 km/h');
  assert.ok(FL.isRotor(FL.byId('typhoon_h480')) && !FL.isRotor(FL.byId('icept_x4')));
});

test('tema: kayıt > sistem; düğme tersini kaydeder, sistemle aynıysa kaydı siler', () => {
  assert.equal(FL.resolveTheme(null, true), 'light'); assert.equal(FL.resolveTheme(null, false), 'dark');
  assert.equal(FL.resolveTheme('dark', true), 'dark'); assert.equal(FL.resolveTheme('light', false), 'light'); assert.equal(FL.resolveTheme('bozuk', false), 'dark');
  assert.deepEqual(FL.nextTheme('dark', false), { theme: 'light', store: 'light' });
  assert.deepEqual(FL.nextTheme('light', false), { theme: 'dark', store: null });
  assert.deepEqual(FL.nextTheme('dark', true), { theme: 'light', store: null });
  assert.equal(FL.THEME_KEY, 'simumav.theme');
  const boot = readFileSync(join(SITE, 'js/theme-boot.js'), 'utf8'), h = htmls[0][1];
  assert.ok(boot.includes("'simumav.theme'") && boot.includes('prefers-color-scheme: light'));
  assert.ok(h.indexOf('<script src="js/theme-boot.js"></script>') > 0 && h.indexOf('js/theme-boot.js') < h.indexOf('css/site.css'), 'tema ön yükleyici CSS\'ten önce, src\'li');
  assert.ok(readFileSync(join(SITE, 'css/site.css'), 'utf8').includes(':root[data-theme="light"]'));
});

test('bölümler: hash yalnız bilinen bölüm; modül kartları ilgili bölüme bağlanır; her bölüm sayfada var', () => {
  assert.equal(FL.sectionFromHash('#hangar'), 'hangar'); assert.equal(FL.sectionFromHash('#Crew'), 'crew');
  assert.equal(FL.sectionFromHash('#x"><img'), null); assert.equal(FL.sectionFromHash(''), null); assert.equal(FL.sectionFromHash(null), null);
  const h = htmls[0][1];
  for (const id of FL.SECTIONS) assert.match(h, new RegExp(`<section[^>]*id="${id}"`), id);
  for (const mod of ['hangar', 'crew', 'tracks', 'missions', 'fly', 'ops']) assert.match(h, new RegExp(`data-mod="${mod}"[\\s\\S]*?href="#${mod}"`), mod);
});

test('görseller: index.html img/ başvuruları WEBP, mevcut, ≤ 260 KB; alt metni i18n', () => {
  const h = htmls[0][1];
  const imgs = [...h.matchAll(/<img[^>]*src="(img\/[^"]+)"[^>]*>/g)];
  assert.ok(imgs.length >= 14, `görsel sayısı ${imgs.length}`);
  for (const [tag, src] of imgs) {
    assert.ok(src.endsWith('.webp'), src);
    const size = readFileSync(join(SITE, src)).length; assert.ok(size > 2000 && size <= 260 * 1024, `${src} ${size}`);
    assert.match(tag, /loading="lazy"/, src); assert.match(tag, /data-i18n-attr="alt:[a-z.]+"/, src); assert.match(tag, /width="\d+" height="\d+"/, src);
  }
});

console.log(`\n${ok} test geçti`);
