// Bayram temaları — ortak istemci modülü (static/js/modules/holiday_fx.js + holiday_fx_themes.js) saf mantık + sahte tuvalle 20 temanın çizim duman testi.
// Çalıştırma: node tests/test_simumav_holiday.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fx = await import(path.join(ROOT, 'static/js/modules/holiday_fx.js'));
const { TZ_COUNTRY } = await import(path.join(ROOT, 'static/js/modules/holiday_tz.js'));
let n = 0;
const ok = (name, fn) => { fn(); n++; console.log(`  ✓ ${name}`); };

ok('tema listesi sunucu kataloğuyla aynı sırada (app/holiday_themes.py)', () => {
  const py = readFileSync(path.join(ROOT, 'app/holiday_themes.py'), 'utf8');
  const blk = py.slice(py.indexOf('THEMES: list'), py.indexOf('THEME_CODES ='));
  const codes = [...blk.matchAll(/^\s{4}\('([a-z_]+)',/gm)].map(m => m[1]);
  assert.deepEqual(codes, fx.THEMES);
  assert.equal(fx.THEMES.length, 20);
});

ok('kutlama metni + tema adı: 20 tema × 7 dil', () => {
  for (const t of fx.THEMES) {
    for (const l of fx.LANGS) {
      assert.ok(fx.GREET[t][l], `${t}/${l}`);
      assert.ok(fx.themeName(t, l), `${t}/${l}`);
    }
  }
  const g = fx.greeting({ theme: 'kurban', name: 'Kurban Bayramı', day_index: 5, days_total: 5 }, 'tr');
  assert.equal(g.title, 'Kurban Bayramınız mübarek olsun!');
  assert.equal(g.sub, 'Kurban Bayramı · 5. gün / 5');
  assert.equal(fx.greeting({ theme: 'ramazan' }, 'xx').title, 'Eid Mubarak!');   // bilinmeyen dil → en
  assert.match(fx.greeting({ theme: 'noel', preview: true }, 'de').sub, /Vorschau/);
});

ok('saat dilimi → ülke (zone.tab + eski adlar)', () => {
  assert.equal(fx.countryFromTz('Europe/Istanbul'), 'TR');
  assert.equal(fx.countryFromTz('Asia/Istanbul'), 'TR');
  assert.equal(fx.countryFromTz('America/New_York'), 'US');
  assert.equal(fx.countryFromTz('Asia/Calcutta'), 'IN');
  assert.equal(fx.countryFromTz('Asia/Riyadh'), 'SA');
  assert.equal(fx.countryFromTz('Etc/UTC'), null);
  assert.equal(fx.countryFromTz(null), null);
  assert.ok(Object.keys(TZ_COUNTRY).length > 400);
});

ok('tarayıcı dili → bölge', () => {
  assert.equal(fx.countryFromLangs(['tr-TR', 'en']), 'TR');
  assert.equal(fx.countryFromLangs(['en']), null);
  assert.equal(fx.countryFromLangs(['zh-Hant-TW']), 'TW');
  assert.equal(fx.countryFromLangs(['de_AT']), 'AT');
  assert.equal(fx.countryFromLangs([]), null);
});

ok('ülke tespit önceliği: ayar → konum → saat dilimi → dil', () => {
  assert.deepEqual(fx.detectCountry({ setting: 'de', located: 'TR', tz: 'Asia/Tokyo', langs: ['fr-FR'] }), { country: 'DE', source: 'setting' });
  assert.deepEqual(fx.detectCountry({ setting: '', located: 'TR', tz: 'Asia/Tokyo', langs: ['fr-FR'] }), { country: 'TR', source: 'location' });
  assert.deepEqual(fx.detectCountry({ located: null, tz: 'Asia/Tokyo', langs: ['fr-FR'] }), { country: 'JP', source: 'timezone' });
  assert.deepEqual(fx.detectCountry({ tz: 'Etc/UTC', langs: ['fr-FR'] }), { country: 'FR', source: 'language' });
  assert.deepEqual(fx.detectCountry({ tz: null, langs: ['en'] }), { country: null, source: null });
  assert.equal(fx.detectCountry({ setting: 'TUR', tz: 'Europe/Istanbul', langs: [] }).source, 'timezone');   // geçersiz ayar yok sayılır
});

ok('birleşik tema: TR 2027-05-19 Kurban (5/5) + Gençlik ve Spor', () => {
  const active = [
    { theme: 'cocuk_genclik', name: "Atatürk'ü Anma, Gençlik ve Spor Bayramı", day_index: 1, days_total: 1 },
    { theme: 'kurban', name: 'Kurban Bayramı', day_index: 5, days_total: 5 },
  ];
  const p = fx.pickThemes(active, new Date(2027, 4, 19, 10));
  assert.equal(p.primary.theme, 'kurban');
  assert.equal(p.secondary.theme, 'cocuk_genclik');
  assert.equal(p.items.length, 2);
});

ok('arife (yarım gün) 13.00\'ten önce etkin değil', () => {
  const it = { theme: 'ramazan', half_day: true };
  assert.equal(fx.isActiveNow(it, new Date(2027, 2, 8, 10)), false);
  assert.equal(fx.isActiveNow(it, new Date(2027, 2, 8, 13, 5)), true);
  assert.equal(fx.pickThemes([it], new Date(2027, 2, 8, 9)).primary, null);
});

ok('genel tema yalnız başka tema yoksa; aynı tema tekrarları tekilleşir', () => {
  const p = fx.pickThemes([{ theme: 'genel' }, { theme: 'noel' }, { theme: 'noel' }, { theme: 'yok' }]);
  assert.equal(p.primary.theme, 'noel'); assert.equal(p.secondary, null);
  assert.equal(fx.pickThemes([{ theme: 'genel' }]).primary.theme, 'genel');
  assert.equal(fx.pickThemes([]).primary, null);
});

ok('önizleme parametresi', () => {
  assert.deepEqual(fx.previewFromSearch('?bayram=kurban,xyz&bayram_ulke=tr'), { themes: ['kurban'], country: 'TR' });
  assert.deepEqual(fx.previewFromSearch('?holiday=noel,yilbasi,holi'), { themes: ['noel', 'yilbasi'], country: null });
  assert.equal(fx.previewFromSearch('?bayram=abc'), null);
  assert.equal(fx.previewFromSearch(''), null);
  const it = fx.previewItems(['holi'], 'IN');
  assert.equal(it[0].preview, true); assert.equal(it[0].country, 'IN');
});

ok('kare bütçesi: reduced-motion → durağan; düşük güç; sakin kip', () => {
  assert.equal(fx.fxBudget({ reduced: true }).animate, false);
  assert.equal(fx.fxBudget({}).animate, true);
  const lp = fx.fxBudget({ lowPower: true, dpr: 3 });
  assert.equal(lp.fps, 24); assert.equal(lp.density, 0.5); assert.equal(lp.scale, 1);
  assert.equal(fx.fxBudget({ mode: 'ambient' }).density, 0.35);
  assert.equal(fx.fxBudget({ dpr: 3 }).scale, 1.5);
  assert.equal(fx.isLowPower({ hardwareConcurrency: 4 }), true);
  assert.equal(fx.isLowPower({ hardwareConcurrency: 16, deviceMemory: 16 }), false);
  assert.equal(fx.isLowPower({ hardwareConcurrency: 16, connection: { saveData: true } }), true);
});

ok('yardımcılar: ülke kodu, bayrak yolu, yerel tarih', () => {
  assert.equal(fx.normCountry(' tr '), 'TR'); assert.equal(fx.normCountry('TUR'), null);
  assert.equal(fx.flagUrl('TR'), '/static/vendor/flag-icons/4x3/tr.svg'); assert.equal(fx.flagUrl('x'), null);
  assert.equal(fx.localDate(new Date(2027, 4, 9)), '2027-05-09');
});

await (async () => {
  let url = null;
  const fake = async u => { url = u; return { ok: true, json: async () => ({ active: [{ theme: 'kurban' }] }) }; };
  const r = await fx.fetchHoliday('tr', { date: '2027-05-19', lang: 'tr', fetchFn: fake });
  assert.equal(url, '/api/holiday-theme?country=TR&date=2027-05-19&lang=tr');
  assert.equal(r.active[0].theme, 'kurban');
  assert.equal(await fx.fetchHoliday('', { fetchFn: fake }), null);
  assert.equal(fx.createHolidayFx({}), null);   // DOM yok → null (sunucu/test ortamı)
  n++; console.log('  ✓ fetchHoliday URL + DOM yokken motor null');
})();

// ---- sahte tuval: 20 temanın her biri (tek + birleşik) 240 kare hatasız çizilir; durağan kare çizilir
const calls = { n: 0 };
const ctx2d = new Proxy({}, {
  get(t, k) {
    if (k === 'canvas') return { width: 1280, height: 720 };
    if (k === 'getTransform') return () => ({ d: 1 });
    if (k === 'getImageData') return () => ({ data: new Uint8ClampedArray(48 * 36 * 4) });
    if (k === 'createLinearGradient' || k === 'createRadialGradient') return () => ({ addColorStop() {} });
    if (k in t) return t[k];
    return () => { calls.n++; };
  },
  set(t, k, v) { t[k] = v; return true; },
});
globalThis.document = { createElement: () => ({ width: 0, height: 0, getContext: () => ctx2d }) };
globalThis.Image = class { set src(v) { this._s = v; } };
const th = await import(path.join(ROOT, 'static/js/modules/holiday_fx_themes.js'));
assert.deepEqual([...th.THEME_LIST].sort(), [...fx.THEMES].sort());
for (const t of fx.THEMES) {
  for (const combo of [[t], [t, 'cocuk_genclik'], ['kurban', t]]) {
    const sc = th.createScene(combo, { W: 1280, H: 720, density: 1, country: 'TR' });
    for (let i = 0; i < 240; i++) sc.frame(ctx2d, 4 + i / 30, 1 / 30);
    sc.setDensity(0.35); sc.resize(390, 800);
    for (let i = 0; i < 60; i++) sc.frame(ctx2d, 20 + i / 30, 1 / 30);
    sc.still(ctx2d);
    sc.dispose();
  }
}
assert.ok(calls.n > 10000);
n++; console.log(`  ✓ 20 tema × (tek + birleşik) çizim duman testi (${calls.n} çizim çağrısı)`);

console.log(`test_simumav_holiday.mjs: ${n} test TAMAM`);
