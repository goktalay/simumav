// Uçuş Simülatörü — BAYRAM SÜSLERİ 3B DÜNYADA (docs/bayram-temalari.md › "Uçuş sahnesi"; HEPGO flightsim.js + SIMUMAV fly/session.js ortak).
// Kural: uçuş sahnesinde 2B ekran katmanı (parçacık, şerit, toast) YOKTUR (holiday_fx.js inFlight → gizli). Bayram teması etkinse onun yerine
// 3B dünyaya HAFİF ve ÇARPIŞMASIZ süs konur: kurbanda çayırda otlayan koyunlar, ramazanda fener dizileri + hilal-yıldız tabelası, noelde çam
// ağacı + yer karı + hediye kutuları, cadılarda balkabakları + korkuluk, yılbaşında ışık dizileri (+ gece ufukta havai fişek), ulusal günlerde
// dalgalanan bayraklar … (20 tema; ikincil tema yarı sayıda, büyük figürsüz).
//  • ÇARPIŞMA YOK: süsler flightsim3d'nin engel listesine (buildingsAABB, §18 çarpışma kutuları) EKLENMEZ; arazi yüksekliği (terrainHeight) değişmez.
//  • YÜKSEKLİK: süs ≤ DECOR.MAX_H (4 m); bayrak direkleri ≤ DECOR.POLE_H (8 m) ve evden/düzenekten ≥ DECOR.POLE_MIN (30 m); çatı bayrakları binanın
//    üstünde ≤ 3 m; havai fişek yalnız gece/akşam, evden ≥ DECOR.FW_MIN (1,5 km) ufukta.
//  • TAMPON (keepoutZones): pist + uç koridorları (kalkış/iniş), ev (kalkış noktası), rampa/fırlatıcı (§13/§27), yer kontrol sahası (§26), yer kamerası
//    noktası, rüzgâr tulumu, alçak hedef yörüngeleri (§24) ve dış "engel bölgeleri" (setDecorKeepouts: FPV kapıları/halkaları §33, karşılaşma
//    başlangıçları) — parkur/karşılaşma modülleri sonradan doldurabilir.
//  • KALİTE (§43): Düşük ×0,5 (ışık halesi ve havai fişek yok), Orta ×0,75, Yüksek ×1, Ultra ×1,2; bütçe ≤ 20 000 üçgen, ≤ 2 ms/kare (info()).
//  • TEK WebGL renderer: flightsim3d sahnesine (scene) eklenir; ışık kaynağı EKLENMEZ (malzeme yeniden derlemesi yok) — parlama MeshBasic +
//    toplamsal nokta haleleri (Yüksek/Ultra'da bloom yakalar).
//  • Varlıklar prosedürel (three.js); bayrak dokusu flag-icons (MIT, static/vendor/flag-icons) — dış görsel yok.
// Saf kısım (DOM'suz, node testi tests/test_flightsim_holiday3d.mjs): keepoutZones, clearOf, planDecor, decorCaps, holidayDecorEnabled.
// 3B kısım: createHolidayDecor(T, scene, { terrainHeight }) → { root, place(themes, country, ctx), update(now, dt, o), clear, dispose, info }.
// Uygulama bağlantısı: applyHolidayDecor(sim, { enabled, enabled3d, country, located, lang }) → tema çözülür (holiday_fx.resolveHoliday) → sim.setHoliday.
import { THEMES, resolveHoliday, normCountry, flagUrl } from './holiday_fx.js';

export const DECOR = {
  MAX_H: 4,            // süs azami yüksekliği (m)
  POLE_H: 8,           // bayrak direği (m)
  POLE_MIN: 30,        // direk / tabela evden, düzenekten en az (m)
  HOME_R: 25,          // kalkış noktası çevresi boş (m)
  RUNWAY_PAD: 25,      // pist kenarından yanal tampon (m)
  RUNWAY_END: 200,     // pist uçlarından ileri tampon: kalkış/tırmanış ve yaklaşma koridoru (m)
  RIG_R: 30,           // rampa / fırlatıcı / araç (m)
  SITE_R: 30,          // §26 istasyon / kule / raf (m)
  CAM_R: 12,           // yer kamerası noktası (m)
  ZONE_PAD: 8,         // dış engel bölgelerine ek pay (m)
  MAX_R: 170,          // süslerin evden azami uzaklığı (fişek ve çatı bayrakları hariç)
  ROOF_H: 3,           // çatı bayrağı direği (m)
  FW_MIN: 1500,        // havai fişek bölgesi evden en az (m)
  TRI_MAX: 20000,      // üçgen bütçesi
  MS_MAX: 2,           // kare bütçesi (ms)
};
export const LEVELS = ['low', 'medium', 'high', 'ultra'];
export const QUALITY = { low: 0.5, medium: 0.75, high: 1, ultra: 1.2 };
// Sayı sınırları (Ultra, ana tema) — testler bunlara bakar
export const CAPS = { sheep: 12, lanternString: 4, lanterns: 9, pumpkins: 16, eggs: 22, bunny: 2, gifts: 9, ornaments: 40, flags: 6, roofFlags: 4, diyas: 30,
  stains: 18, balloons: 6, beds: 4, blossom: 5, butterflies: 12, lotus: 9 };

const TAU = Math.PI * 2, DEG = Math.PI / 180;
const num = (v, d = 0) => (v == null || v === '' || !Number.isFinite(Number(v)) ? d : Number(v));
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
function rng(seed) {   // mulberry32 (deterministik yerleşim: aynı dünya + tema → aynı süs)
  let a = (seed >>> 0) || 1;
  return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const hashStr = s => { let h = 2166136261; for (const ch of String(s)) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); } return h >>> 0; };
export const normLevel = l => (LEVELS.includes(l) ? l : 'high');

/** Ayar kuralı: genel bayram teması kapalıysa 3B süs de kapalı; önizleme (?bayram=) her zaman gösterir. */
export const holidayDecorEnabled = ({ enabled = true, enabled3d = true, preview = false } = {}) => !!preview || (enabled !== false && enabled3d !== false);

// ---------------------------------------------------------------- pist çerçevesi + engel bölgeleri (saf)
/** Pist çerçevesi: u pist boyunca (pist yönü, kuzeyden saat yönü), v sağa dik. */
export function runwayFrame(headingDeg = 0) {
  const a = num(headingDeg) * DEG, ax = Math.sin(a), ay = Math.cos(a), cx = Math.cos(a), cy = -Math.sin(a);
  return { toWorld: (u, v) => ({ x: ax * u + cx * v, y: ay * u + cy * v }), toFrame: (x, y) => ({ u: x * ax + y * ay, v: x * cx + y * cy }) };
}
/**
 * Engel (boşluk) bölgeleri. ctx: { heading, runwayL, runwayW, home {x,y}, rig {x,y}, site [{x,y}], camSpot {x,y}, sock {x,y}, targets [{x,y,r,alt}],
 *   extra [{x,y,r, r0?}] (dış: FPV kapıları/halkaları, karşılaşma başlangıçları) } → [{kind:'rect'|'circle'|'ring', id, …}]
 */
export function keepoutZones(ctx = {}) {
  const Z = [];
  const L = num(ctx.runwayL, 1200), Wd = num(ctx.runwayW, 40);
  Z.push({ kind: 'rect', id: 'pist', x: 0, y: 0, heading: num(ctx.heading), hu: L / 2 + DECOR.RUNWAY_END, hv: Wd / 2 + DECOR.RUNWAY_PAD });
  Z.push({ kind: 'circle', id: 'ev', x: 0, y: 0, r: Math.max(DECOR.HOME_R, DECOR.POLE_MIN) });
  if (ctx.home && Number.isFinite(ctx.home.x) && Math.hypot(ctx.home.x, ctx.home.y) > 1) Z.push({ kind: 'circle', id: 'ev2', x: ctx.home.x, y: ctx.home.y, r: Math.max(DECOR.HOME_R, DECOR.POLE_MIN) });
  if (ctx.rig && Number.isFinite(ctx.rig.x)) Z.push({ kind: 'circle', id: 'duzenek', x: ctx.rig.x, y: ctx.rig.y, r: Math.max(DECOR.RIG_R, DECOR.POLE_MIN) });
  for (const p of ctx.site || []) if (p && Number.isFinite(p.x)) Z.push({ kind: 'circle', id: 'saha', x: p.x, y: p.y, r: DECOR.SITE_R });
  if (ctx.camSpot) Z.push({ kind: 'circle', id: 'yerkamera', x: ctx.camSpot.x, y: ctx.camSpot.y, r: DECOR.CAM_R });
  if (ctx.sock) Z.push({ kind: 'circle', id: 'tulum', x: ctx.sock.x, y: ctx.sock.y, r: 8 });
  for (const t of ctx.targets || []) {   // §24 alçak hedef yörüngeleri (çember): halka bölgesi ± 15 m
    if (!t || !Number.isFinite(t.x) || num(t.alt, 0) > 40) continue;
    Z.push({ kind: 'ring', id: 'hedef', x: t.x, y: t.y, r0: Math.max(0, num(t.r) - 15), r: num(t.r) + 15 });
  }
  for (const e of ctx.extra || []) {
    if (!e || !Number.isFinite(e.x) || !Number.isFinite(e.y)) continue;
    const r = Math.max(1, num(e.r, 10)) + DECOR.ZONE_PAD;
    Z.push(e.r0 > 0 ? { kind: 'ring', id: e.id || 'engel', x: e.x, y: e.y, r0: Math.max(0, e.r0 - DECOR.ZONE_PAD), r } : { kind: 'circle', id: e.id || 'engel', x: e.x, y: e.y, r });
  }
  return Z;
}
/** (x, y) merkezli r yarıçaplı daire hiçbir bölgeye değmiyor mu */
export function clearOf(zones, x, y, r = 0) {
  for (const z of zones) {
    if (z.kind === 'rect') {
      const f = runwayFrame(z.heading), p = f.toFrame(x - z.x, y - z.y);
      if (Math.abs(p.u) < z.hu + r && Math.abs(p.v) < z.hv + r) return false;
    } else {
      const d = Math.hypot(x - z.x, y - z.y);
      if (d < z.r + r && (z.kind !== 'ring' || d > z.r0 - r)) return false;
    }
  }
  return true;
}

// ---------------------------------------------------------------- yerleşim planı (saf)
/**
 * planDecor(themes, ctx) → { items, zones, level, q, themes }
 * ctx: keepoutZones alanları + { level ('low'|'medium'|'high'|'ultra'), time ('day'|'dusk'|'night'), seed, far (sis uzaklığı), roofs [{x,y,z}],
 *   blocked(x,y) (su/bina; isteğe bağlı) }
 * Öğe: { kind, theme, x, y, r (taban yarıçapı), h (zeminden azami yükseklik), yaw, pts? [{x,y,…}], … }
 */
export function planDecor(themes, ctx = {}) {
  const level = normLevel(ctx.level), q = QUALITY[level];
  const list = (themes || []).filter(t => THEMES.includes(t)).slice(0, 2);
  const zones = keepoutZones(ctx);
  const rnd = rng(hashStr(`${list.join(',')}|${num(ctx.seed, 1)}|${num(ctx.heading)}`));
  const F = runwayFrame(ctx.heading);
  const items = [], used = [];
  const hv = num(ctx.runwayW, 40) / 2 + DECOR.RUNWAY_PAD;
  const blocked = typeof ctx.blocked === 'function' ? ctx.blocked : null;
  /** Boş yer: pistin yanında (|v| ≥ tampon), evden ≤ MAX_R; diğer süslerle çakışmaz. o: { side (±1), uMin, uMax, vMax } */
  const spot = (r, o = {}) => {
    for (let k = 0; k < 80; k++) {
      const side = o.side || (rnd() < 0.5 ? -1 : 1);
      const vMin = hv + r + 2, vMax = Math.max(vMin + 4, Math.min(num(o.vMax, 125), DECOR.MAX_R - r));
      const v = side * (vMin + rnd() * (vMax - vMin) * (k < 40 ? 0.6 : 1)), u = num(o.uMin, -90) + rnd() * (num(o.uMax, 90) - num(o.uMin, -90));
      const p = F.toWorld(u, v);
      if (Math.hypot(p.x, p.y) + r > DECOR.MAX_R) continue;
      if (!clearOf(zones, p.x, p.y, r)) continue;
      if (used.some(s => Math.hypot(s.x - p.x, s.y - p.y) < s.r + r + 3)) continue;
      if (blocked && [[0, 0], [r, 0], [-r, 0], [0, r], [0, -r]].some(([dx, dy]) => blocked(p.x + dx, p.y + dy))) continue;
      const s = { x: p.x, y: p.y, r, side, u, v, yaw: Math.atan2(p.x, -p.y) };   // yaw: eve (pist ortasına) bakış — ileri yön (−sin yaw, cos yaw)
      used.push(s);
      return s;
    }
    return null;
  };
  /** Küme içinde dağınık noktalar (merkezden ≤ r) */
  const scatter = (s, n, minGap = 1.2, rMin = 0) => {
    const pts = [];
    for (let k = 0; pts.length < n && k < n * 30; k++) {
      const a = rnd() * TAU, d = rMin + Math.sqrt(rnd()) * (s.r - rMin - 0.5);
      const x = s.x + Math.cos(a) * d, y = s.y + Math.sin(a) * d;
      if (pts.some(p => Math.hypot(p.x - x, p.y - y) < minGap)) continue;
      pts.push({ x, y, yaw: rnd() * TAU, s: 0.85 + rnd() * 0.3, c: rnd() });
    }
    return pts;
  };
  const cnt = (base, cap, sk, min = 1) => clamp(Math.round(base * sk), min, cap);
  const add = (it, theme) => { items.push({ theme, ...it }); return it; };
  // Fener / ışık dizisi: iki direk pist boyunca (u ekseni), arada sarkan dizi
  const string = (theme, style, sk, nStr, perStr) => {
    const k = cnt(nStr, CAPS.lanternString, sk);
    for (let i = 0; i < k; i++) {
      const s = spot(8.5, { vMax: 85 });
      if (!s) break;
      const half = 7, d = F.toWorld(1, 0), dx = d.x - F.toWorld(0, 0).x, dy = d.y - F.toWorld(0, 0).y;
      add({ kind: 'string', style, x: s.x, y: s.y, r: s.r, h: 3.8, yaw: s.yaw, x1: s.x - dx * half, y1: s.y - dy * half, x2: s.x + dx * half, y2: s.y + dy * half,
        n: clamp(Math.round(perStr * Math.min(1, sk + 0.25)), 4, CAPS.lanterns) }, theme);
    }
  };
  const sign = (theme, kind) => { const s = spot(3.5, { vMax: 110 }); if (s) add({ kind, x: s.x, y: s.y, r: s.r, h: 4, yaw: s.yaw }, theme); };
  const flags = (theme, sk, base) => {
    const n = cnt(base, CAPS.flags, sk, 2), half = (n - 1) * 3;
    const s = spot(half + 1.5, { vMax: 100 });
    if (!s) return;
    const d = F.toWorld(1, 0);
    add({ kind: 'flags', x: s.x, y: s.y, r: s.r, h: DECOR.POLE_H, yaw: s.yaw, pole: true,
      pts: Array.from({ length: n }, (_, i) => ({ x: s.x + d.x * (i * 6 - half), y: s.y + d.y * (i * 6 - half) })) }, theme);
  };
  const roofFlags = (theme, sk) => {
    const roofs = (ctx.roofs || []).filter(b => b && Number.isFinite(b.x) && Number.isFinite(b.z) && clearOf(zones, b.x, b.y, 2))
      .sort((a, b) => Math.hypot(a.x, a.y) - Math.hypot(b.x, b.y)).slice(0, cnt(4, CAPS.roofFlags, sk));
    if (roofs.length) add({ kind: 'roof_flags', x: roofs[0].x, y: roofs[0].y, r: 1, h: DECOR.ROOF_H, onRoof: true, pts: roofs.map(b => ({ x: b.x, y: b.y, z: b.z })) }, theme);
  };
  const beds = (theme, sk, palette, shape = 'bed', base = 3) => {
    const n = cnt(base, CAPS.beds, sk);
    for (let i = 0; i < n; i++) { const s = spot(shape === 'heart' ? 2.6 : 2.2, { vMax: 95 }); if (s) add({ kind: 'bed', shape, palette, x: s.x, y: s.y, r: s.r, h: 0.6, yaw: s.yaw, seed: Math.floor(rnd() * 1e6) }, theme); }
  };

  const PLAN = {
    kurban: (sk, sec) => {   // çayırda otlayan koyunlar (6–12; Düşük 6; ikincil tema 3–6)
      const s = spot(sec ? 14 : 22, { vMax: 120 });
      if (s) add({ kind: 'sheep', x: s.x, y: s.y, r: s.r, h: 1.2, n: cnt(10, CAPS.sheep, sk, sec ? 3 : 6), seed: Math.floor(rnd() * 1e6) }, 'kurban');
    },
    ramazan: (sk, sec) => { string('ramazan', 'osmanli', sk, 3, 8); if (!sec) sign('ramazan', 'hilal'); },
    hicri: (sk, sec) => { string('hicri', 'osmanli', sk, 2, 7); if (!sec) sign('hicri', 'hilal'); },
    noel: (sk, sec) => {
      const s = spot(sec ? 6 : 15, { vMax: 100 });
      if (!s) return;
      if (!sec) add({ kind: 'xmas_tree', x: s.x, y: s.y, r: 2, h: 4, yaw: s.yaw, n: cnt(32, CAPS.ornaments, sk, 12) }, 'noel');
      add({ kind: 'snow', x: s.x, y: s.y, r: s.r, h: 0.1 }, 'noel');
      add({ kind: 'gifts', x: s.x, y: s.y, r: Math.min(5, s.r), h: 0.7, pts: scatter({ ...s, r: Math.min(5, s.r) }, cnt(7, CAPS.gifts, sk, 3), 0.9, sec ? 0 : 2.2) }, 'noel');
    },
    cadilar: (sk, sec) => {
      const n = cnt(12, CAPS.pumpkins, sk, 4);
      const s = spot(9, { vMax: 100 });
      if (s) add({ kind: 'pumpkins', x: s.x, y: s.y, r: s.r, h: 0.8, pts: scatter(s, n, 1.3) }, 'cadilar');
      if (!sec) { const c = spot(2, { vMax: 90 }); if (c) add({ kind: 'scarecrow', x: c.x, y: c.y, r: c.r, h: 2.6, yaw: c.yaw }, 'cadilar'); }
    },
    paskalya: (sk, sec) => {
      const s = spot(10, { vMax: 100 });
      if (!s) return;
      add({ kind: 'eggs', x: s.x, y: s.y, r: s.r, h: 0.4, pts: scatter(s, cnt(16, CAPS.eggs, sk, 6), 0.8) }, 'paskalya');
      add({ kind: 'bunny', x: s.x, y: s.y, r: s.r, h: 0.6, pts: scatter(s, sec ? 1 : CAPS.bunny, 3) }, 'paskalya');
    },
    hristiyan: (sk, sec) => { if (!sec) sign('hristiyan', 'bell_tower'); beds('hristiyan', sk * 0.5, 'white'); },
    yilbasi: (sk, sec) => {
      string('yilbasi', 'bulbs', sk, 3, 9);
      const night = ctx.time === 'night' || ctx.time === 'dusk';
      if (night && level !== 'low' && !sec) {   // ufukta (uçuş alanının çok dışında), pistin yanına dik yönde
        const far = clamp(num(ctx.far, 4000) * 0.8, DECOR.FW_MIN, 3500), side = rnd() < 0.5 ? -1 : 1, p = F.toWorld((rnd() - 0.5) * 600, side * far);
        add({ kind: 'fireworks', x: p.x, y: p.y, r: 300, h: 320, far: true, dist: Math.hypot(p.x, p.y) }, 'yilbasi');
      }
    },
    cin_yeni: sk => string('cin_yeni', 'cin', sk, 3, 7),
    diwali: sk => {
      const s = spot(6, { vMax: 95 });
      if (!s) return;
      const n = cnt(24, CAPS.diyas, sk, 8), pts = [];
      for (let i = 0; i < n; i++) { const a = i / n * TAU, rr = i % 2 ? 4.2 : 5.2; pts.push({ x: s.x + Math.cos(a) * rr, y: s.y + Math.sin(a) * rr }); }
      add({ kind: 'diyas', x: s.x, y: s.y, r: s.r, h: 0.3, pts }, 'diwali');
    },
    holi: sk => {
      const s = spot(12, { vMax: 100 });
      if (s) add({ kind: 'stains', x: s.x, y: s.y, r: s.r, h: 0.08, pts: scatter(s, cnt(14, CAPS.stains, sk, 6), 2.2).map(p => ({ ...p, rad: 1.2 + p.c * 1.6 })) }, 'holi');
    },
    hindu: (sk, sec) => { const s = spot(5, { vMax: 95 }); if (s) add({ kind: 'lotus_pond', x: s.x, y: s.y, r: s.r, h: 0.4, n: cnt(7, CAPS.lotus, sk, 3) }, 'hindu'); if (!sec) beds('hindu', sk * 0.5, 'saffron'); },
    yahudi: (sk, sec) => { if (!sec) sign('yahudi', 'menorah'); string('yahudi', 'blue', sk * 0.5, 2, 7); },
    cocuk_genclik: (sk, sec) => {
      if (!sec) { const s = spot(3, { vMax: 95 }); if (s) add({ kind: 'kite_stand', x: s.x, y: s.y, r: s.r, h: 2.6, yaw: s.yaw }, 'cocuk_genclik'); }
      const n = cnt(4, CAPS.balloons, sk);
      for (let i = 0; i < n; i++) { const s = spot(1.5, { vMax: 100 }); if (s) add({ kind: 'balloons', x: s.x, y: s.y, r: s.r, h: 3.8, n: 5, seed: Math.floor(rnd() * 1e6) }, 'cocuk_genclik'); }
    },
    kadin_anne: sk => beds('kadin_anne', sk, 'pastel'),
    sevgi: sk => beds('sevgi', sk, 'love', 'heart', 2),
    bagimsizlik: sk => { flags('bagimsizlik', sk, 5); roofFlags('bagimsizlik', sk); },
    emek: sk => beds('emek', sk, 'carnation'),
    bahar: sk => {
      const n = cnt(4, CAPS.blossom, sk), trees = [];
      for (let i = 0; i < n; i++) {   // her ağaç ayrı öğe (kelebekler ağacın ≤ 3 m çevresinde uçar → taban yarıçapı 3,2)
        const s = spot(3.2, { vMax: 100 });
        if (s) { const t = { x: s.x, y: s.y, s: 0.9 + rnd() * 0.2 }; trees.push(t); add({ kind: 'blossom', x: s.x, y: s.y, r: s.r, h: 3.8, pts: [t] }, 'bahar'); }
      }
      if (trees.length && level !== 'low') add({ kind: 'butterflies', x: trees[0].x, y: trees[0].y, r: 3.2, h: 2.2, n: cnt(10, CAPS.butterflies, sk, 4), pts: trees, anchors: true }, 'bahar');
    },
    genel: sk => flags('genel', sk, 3),
  };
  list.forEach((th, i) => PLAN[th]?.(q * (i ? 0.5 : 1), i > 0));
  return { items, zones, level, q, themes: list };
}
/** Plandaki sayılar (teşhis/test): { sheep, lanterns, pumpkins, … } */
export function decorCaps(plan) {
  const c = {};
  for (const it of plan.items) {
    const k = it.kind, n = it.pts ? it.pts.length : it.n || 1;
    c[k] = (c[k] || 0) + (k === 'string' ? it.n : n);
    if (k === 'string') c.strings = (c.strings || 0) + 1;
  }
  return c;
}

// ---------------------------------------------------------------- 3B katman (three.js; aynı sahne / renderer)
const doc = () => globalThis.document || null;
function canvasTex(T, w, h, fn) {
  const d = doc();
  if (!d) return null;
  const c = d.createElement('canvas'); c.width = w; c.height = h;
  fn(c.getContext('2d'), w, h);
  const t = new T.CanvasTexture(c); t.colorSpace = T.SRGBColorSpace;
  return t;
}
const PALETTE = {
  osmanli: [0xef4444, 0xf59e0b, 0x10b981, 0x3b82f6, 0xa855f7], bulbs: [0xfde047, 0xf43f5e, 0x22d3ee, 0x4ade80, 0xfb923c, 0xe879f9], cin: [0xdc2626], blue: [0x60a5fa, 0xf8fafc],
  pastel: [0xf9a8d4, 0xc4b5fd, 0xfde047, 0xfdba74, 0xffffff], love: [0xe11d48, 0xf43f5e, 0xfb7185, 0xec4899], carnation: [0xdc2626, 0xb91c1c, 0xef4444], white: [0xf8fafc, 0xfde68a],
  saffron: [0xf97316, 0xfacc15, 0xfb923c], eggs: [0xf9a8d4, 0x93c5fd, 0xfde047, 0x86efac, 0xc4b5fd, 0xfdba74], holi: [0xec4899, 0x22c55e, 0xfacc15, 0x3b82f6, 0xa855f7, 0xf97316],
  gifts: [0xdc2626, 0x16a34a, 0x2563eb, 0xfacc15, 0xa855f7], balloons: [0xef4444, 0xfacc15, 0x3b82f6, 0x22c55e, 0xec4899, 0xf97316], fw: [0xfde047, 0xf43f5e, 0x60a5fa, 0x4ade80, 0xf0abfc, 0xffffff],
};

/**
 * createHolidayDecor(T, scene, { terrainHeight }) → { root, place(themes, country, ctx), update(now, dt, { wind }), clear(), dispose(), info() }
 */
export function createHolidayDecor(T, scene, o = {}) {
  const root = new T.Group();
  root.name = 'bayram-susleri';
  scene?.add(root);
  const th = typeof o.terrainHeight === 'function' ? o.terrainHeight : () => 0;
  const S = { plan: null, ctx: null, themes: [], country: null, anim: [], glowMats: [], basicMats: [], night: 0, at: 0, avg: 0, max: 0, frames: 0, anchors: [], seatAt: 0, lastFlagAt: 0, flagTex: null, flagKey: '', tex: {} };
  const tmpM = new T.Matrix4(), tmpQ = new T.Quaternion(), tmpE = new T.Euler(0, 0, 0, 'ZXY'), tmpP = new T.Vector3(), tmpS = new T.Vector3(1, 1, 1), tmpC = new T.Color();
  const glowTex = () => (S.tex.glow ??= canvasTex(T, 64, 64, (g, w) => {
    const gr = g.createRadialGradient(w / 2, w / 2, 0, w / 2, w / 2, w / 2);
    gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(0.25, 'rgba(255,255,255,.55)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = gr; g.fillRect(0, 0, w, w);
  }));
  const softTex = () => (S.tex.soft ??= canvasTex(T, 64, 64, (g, w) => {
    const gr = g.createRadialGradient(w / 2, w / 2, w * 0.2, w / 2, w / 2, w / 2);
    gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(0.7, 'rgba(255,255,255,.75)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = gr; g.fillRect(0, 0, w, w);
  }));
  const faceTex = () => (S.tex.face ??= canvasTex(T, 64, 48, g => {   // oyulmuş balkabağı yüzü (gece ışıklı)
    g.fillStyle = '#ffb02e';
    const tri = (x, y, s, up = true) => { g.beginPath(); g.moveTo(x - s, y + (up ? s : -s) * 0.6); g.lineTo(x + s, y + (up ? s : -s) * 0.6); g.lineTo(x, y - (up ? s : -s) * 0.8); g.fill(); };
    tri(18, 16, 7); tri(46, 16, 7); tri(32, 26, 4);
    g.beginPath(); g.moveTo(10, 32); g.quadraticCurveTo(32, 50, 54, 32); g.quadraticCurveTo(32, 40, 10, 32); g.fill();
  }));
  const H = new Map();   // yükseklik önbelleği (0,5 m ızgara)
  const hAt = (x, y) => { const k = `${Math.round(x * 2)},${Math.round(y * 2)}`; let v = H.get(k); if (v === undefined) { v = num(th(x, y), 0); H.set(k, v); } return v; };
  const lam = (color, extra = {}) => new T.MeshLambertMaterial({ color, ...extra });
  const basic = (color, extra = {}) => { const m = new T.MeshBasicMaterial({ color, ...extra }); m.userData.c0 = m.color.clone(); S.basicMats.push(m); return m; };   // ışıklı (gece tam, gündüz hafif kısık)
  const mesh = (geo, mat, x, y, z, heat = 0.15) => { const m = new T.Mesh(geo, mat); m.position.set(x, y, z); m.userData.heat = heat; m.castShadow = false; m.receiveShadow = false; return m; };
  const inst = (geo, mat, n, heat = 0.15) => { const m = new T.InstancedMesh(geo, mat, Math.max(1, n)); m.count = n; m.userData.heat = heat; m.frustumCulled = false; return m; };
  const setI = (im, i, x, y, z, yaw = 0, sx = 1, sy = sx, sz = sx, pitch = 0, roll = 0) => {
    tmpE.set(pitch, roll, yaw, 'ZXY'); tmpQ.setFromEuler(tmpE); tmpP.set(x, y, z); tmpS.set(sx, sy, sz);
    tmpM.compose(tmpP, tmpQ, tmpS); im.setMatrixAt(i, tmpM);
  };
  const colI = (im, i, c) => { tmpC.set(c); im.setColorAt(i, tmpC); };
  // Hale noktaları (toplamsal; tek çizim): ışıklı süslerin parlaması — Düşük'te yok
  const glowPts = [];
  const glow = (x, y, z, color, size = 1.2) => { glowPts.push({ x, y, z, color, size }); };
  const flushGlow = () => {
    if (!glowPts.length || S.level === 'low') { glowPts.length = 0; return; }
    for (const sz of [...new Set(glowPts.map(g => g.size))]) {
      const ps = glowPts.filter(g => g.size === sz), pos = new Float32Array(ps.length * 3), col = new Float32Array(ps.length * 3);
      ps.forEach((g, i) => { pos.set([g.x, g.y, g.z], i * 3); tmpC.set(g.color); col.set([tmpC.r, tmpC.g, tmpC.b], i * 3); });
      const geo = new T.BufferGeometry();
      geo.setAttribute('position', new T.BufferAttribute(pos, 3)); geo.setAttribute('color', new T.BufferAttribute(col, 3));
      const mat = new T.PointsMaterial({ size: sz, map: glowTex(), vertexColors: true, transparent: true, depthWrite: false, blending: T.AdditiveBlending, sizeAttenuation: true, opacity: 0.5 });
      S.glowMats.push(mat);
      const p = new T.Points(geo, mat); p.frustumCulled = false; p.name = 'hale';
      root.add(p);
    }
    glowPts.length = 0;
  };
  // Araziye serili disk (kar, gölet): halka ızgarası her köşede zemin + dz
  const drape = (x, y, r, mat, dz = 0.06, seg = 28, rings = 5) => {
    const g = new T.RingGeometry(0.01, r, seg, rings), p = g.attributes.position;
    for (let i = 0; i < p.count; i++) { const px = p.getX(i) + x, py = p.getY(i) + y; p.setXYZ(i, p.getX(i), p.getY(i), hAt(px, py) + dz); }
    g.computeVertexNormals();
    const m = new T.Mesh(g, mat); m.position.set(x, y, 0); m.renderOrder = 1; m.userData.heat = 0.08;
    return m;
  };
  const decal = extra => lam(0xffffff, { transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2, ...extra });

  // ---------------- yapıcılar (her öğe türü)
  const B = {
    sheep(it) {   // gövde/baş/bacak üç InstancedMesh; çayır yükseklik ızgarası (7×7) → yürürken zemine oturur
      const n = it.n, R = rng(it.seed);
      const body = inst(new T.IcosahedronGeometry(0.5, 1), lam(0xf4efe4, { flatShading: true }), n, 0.62);
      const head = inst(new T.IcosahedronGeometry(0.2, 0), lam(0x2b2622, { flatShading: true }), n, 0.6);
      const legs = inst(new T.CylinderGeometry(0.055, 0.045, 0.55, 5).rotateX(Math.PI / 2).translate(0, 0, -0.275), lam(0x2b2622), n * 4, 0.55);
      root.add(body, head, legs);
      const G = 7, grid = [];
      for (let j = 0; j < G; j++) for (let i = 0; i < G; i++) grid.push(hAt(it.x + (i / (G - 1) - 0.5) * 2 * it.r, it.y + (j / (G - 1) - 0.5) * 2 * it.r));
      const gh = (x, y) => {
        const fx = clamp(((x - it.x) / (2 * it.r) + 0.5) * (G - 1), 0, G - 1.001), fy = clamp(((y - it.y) / (2 * it.r) + 0.5) * (G - 1), 0, G - 1.001);
        const i = Math.floor(fx), j = Math.floor(fy), a = fx - i, b = fy - j, z = (ii, jj) => grid[jj * G + ii];
        return (z(i, j) * (1 - a) + z(i + 1, j) * a) * (1 - b) + (z(i, j + 1) * (1 - a) + z(i + 1, j + 1) * a) * b;
      };
      const rr = it.r - 2;
      const sh = Array.from({ length: n }, () => {
        const a = R() * TAU, d = Math.sqrt(R()) * rr * 0.8;
        return { x: it.x + Math.cos(a) * d, y: it.y + Math.sin(a) * d, yaw: R() * TAU, st: R() < 0.6 ? 'graze' : 'walk', t: R() * 6, sp: 0.3 + R() * 0.25, ph: R() * TAU, tx: 0, ty: 0, sc: 0.85 + R() * 0.3, head: 0 };
      });
      const pickTarget = s => { const a = R() * TAU, d = Math.sqrt(R()) * rr * 0.9; s.tx = it.x + Math.cos(a) * d; s.ty = it.y + Math.sin(a) * d; };
      sh.forEach(s => pickTarget(s));
      const draw = (s, i, now) => {
        const z = gh(s.x, s.y), c = Math.cos(s.yaw), sn = Math.sin(s.yaw), k = s.sc;
        const walk = s.st === 'walk', sw = walk ? Math.sin(now * 7.5 + s.ph) * 0.45 : 0, bob = walk ? Math.abs(Math.sin(now * 7.5 + s.ph)) * 0.03 : Math.sin(now * 1.3 + s.ph) * 0.01;
        setI(body, i, s.x, s.y, z + 0.78 * k + bob, s.yaw, 0.72 * k, 1.12 * k, 0.68 * k);
        const hd = 0.62 * k, hz = s.head;   // baş: otlarken aşağı
        setI(head, i, s.x - sn * hd, s.y + c * hd, z + (0.92 - hz * 0.55) * k + bob, s.yaw, 0.9 * k, 1.5 * k, 1.05 * k, -0.35 - hz * 0.6);
        let li = i * 4;
        for (const [lx, ly, ph] of [[-0.2, 0.3, 0], [0.2, 0.3, Math.PI], [-0.2, -0.3, Math.PI], [0.2, -0.3, 0]]) {
          const px = s.x + (c * lx - sn * ly) * k, py = s.y + (sn * lx + c * ly) * k;
          setI(legs, li++, px, py, z + 0.58 * k + bob, s.yaw, k, k, k, sw * Math.cos(ph));
        }
      };
      sh.forEach((s, i) => draw(s, i, 0));
      S.anim.push((now, dt) => {
        for (let i = 0; i < n; i++) {
          const s = sh[i];
          s.t -= dt;
          if (s.st === 'walk') {
            const dx = s.tx - s.x, dy = s.ty - s.y, d = Math.hypot(dx, dy);
            const want = Math.atan2(-dx, dy);
            let da = want - s.yaw; da = Math.atan2(Math.sin(da), Math.cos(da));
            s.yaw += clamp(da, -1.2 * dt, 1.2 * dt);
            if (Math.abs(da) < 0.6) { s.x -= Math.sin(s.yaw) * s.sp * dt; s.y += Math.cos(s.yaw) * s.sp * dt; }
            s.head = Math.max(0, s.head - dt * 2);
            if (d < 0.5 || s.t < 0) { s.st = R() < 0.7 ? 'graze' : 'look'; s.t = 3 + R() * 7; }
          } else {
            s.head = s.st === 'graze' ? Math.min(1, s.head + dt * 1.5) : Math.max(0, s.head - dt * 2);
            if (s.t < 0) { s.st = 'walk'; s.t = 4 + R() * 6; pickTarget(s); }
          }
          // çayır sınırı (it.r - 2): dışarı çıkmaz
          const ox = s.x - it.x, oy = s.y - it.y, od = Math.hypot(ox, oy);
          if (od > rr) { s.x = it.x + ox / od * rr; s.y = it.y + oy / od * rr; pickTarget(s); }
          draw(s, i, now / 1000);
        }
        body.instanceMatrix.needsUpdate = true; head.instanceMatrix.needsUpdate = true; legs.instanceMatrix.needsUpdate = true;
      });
      S.sheep = sh;
    },
    string(it) {   // iki direk + sarkan tel + fenerler (MeshBasic, gece hale)
      const z1 = hAt(it.x1, it.y1), z2 = hAt(it.x2, it.y2), top = 3.75;
      const poleG = new T.CylinderGeometry(0.06, 0.08, top, 6).rotateX(Math.PI / 2).translate(0, 0, top / 2), pm = lam(0x4b3a2a);
      root.add(mesh(poleG, pm, it.x1, it.y1, z1), mesh(poleG, pm, it.x2, it.y2, z2));
      const N = it.n, pts = [];
      for (let i = 0; i <= 24; i++) { const u = i / 24; pts.push(new T.Vector3(it.x1 + (it.x2 - it.x1) * u, it.y1 + (it.y2 - it.y1) * u, z1 + (z2 - z1) * u + top - 0.05 - Math.sin(u * Math.PI) * 0.9)); }
      const wire = new T.Line(new T.BufferGeometry().setFromPoints(pts), new T.LineBasicMaterial({ color: 0x222222 }));
      root.add(wire);
      const pal = PALETTE[it.style] || PALETTE.osmanli;
      const geo = it.style === 'bulbs' ? new T.IcosahedronGeometry(0.09, 0) : it.style === 'cin' ? new T.IcosahedronGeometry(0.26, 1).scale(1, 1, 0.8) : new T.CylinderGeometry(0.13, 0.1, 0.36, 6).rotateX(Math.PI / 2);
      const lm = inst(geo, basic(0xffffff), N, 0.45);
      const cap = it.style === 'bulbs' ? null : inst(new T.CylinderGeometry(0.06, it.style === 'cin' ? 0.16 : 0.12, 0.1, 6).rotateX(Math.PI / 2), lam(it.style === 'cin' ? 0xd4a017 : 0x3f3f46), N);
      for (let i = 0; i < N; i++) {
        const u = (i + 1) / (N + 1), x = it.x1 + (it.x2 - it.x1) * u, y = it.y1 + (it.y2 - it.y1) * u, z = z1 + (z2 - z1) * u + top - 0.05 - Math.sin(u * Math.PI) * 0.9 - (it.style === 'bulbs' ? 0.1 : 0.32);
        setI(lm, i, x, y, z); colI(lm, i, pal[i % pal.length]);
        if (cap) setI(cap, i, x, y, z + (it.style === 'cin' ? 0.24 : 0.22));
        glow(x, y, z, pal[i % pal.length], it.style === 'bulbs' ? 0.9 : 1.6);
      }
      root.add(lm); if (cap) root.add(cap);
    },
    hilal(it) {   // hilal-yıldız tabelası (iki ayak + altın hilal + yıldız), eve dönük
      const g = new T.Group(); g.position.set(it.x, it.y, hAt(it.x, it.y)); g.rotation.z = it.yaw;
      const leg = new T.CylinderGeometry(0.07, 0.09, 2.1, 6).rotateX(Math.PI / 2).translate(0, 0, 1.05), lm = lam(0x3f3f46);
      g.add(mesh(leg, lm, -0.9, 0, 0), mesh(leg, lm, 0.9, 0, 0), mesh(new T.BoxGeometry(2.1, 0.1, 0.1), lm, 0, 0, 2.05));
      const cr = new T.Shape(); cr.absarc(0, 0, 1, 0.5, TAU - 0.5, false); cr.absarc(0.38, 0, 0.8, TAU - 0.62, 0.62, true);
      const gold = basic(0xfcd34d, { side: T.DoubleSide });
      const c = mesh(new T.ShapeGeometry(cr, 16).rotateX(Math.PI / 2), gold, -0.15, 0, 2.95);
      c.rotation.y = -0.35;
      const st = new T.Shape(); for (let i = 0; i < 10; i++) { const a = -Math.PI / 2 + i * Math.PI / 5, r = i % 2 ? 0.14 : 0.34; i ? st.lineTo(Math.cos(a) * r, -Math.sin(a) * r) : st.moveTo(Math.cos(a) * r, -Math.sin(a) * r); }
      g.add(c, mesh(new T.ShapeGeometry(st).rotateX(Math.PI / 2), gold, 0.75, 0, 3.0));
      root.add(g);
      const wx = (lx, lz) => ({ x: it.x + Math.cos(it.yaw) * lx, y: it.y + Math.sin(it.yaw) * lx, z: g.position.z + lz });
      for (const [lx, lz] of [[-1, 2.95], [-0.4, 3.75], [-0.4, 2.15], [0.75, 3.0]]) { const p = wx(lx, lz); glow(p.x, p.y, p.z, 0xfcd34d, 1.4); }
    },
    menorah(it) {
      const g = new T.Group(); g.position.set(it.x, it.y, hAt(it.x, it.y)); g.rotation.z = it.yaw;
      const gold = lam(0xd4a017, { emissive: 0x3a2a00 });
      g.add(mesh(new T.CylinderGeometry(0.35, 0.45, 0.2, 8).rotateX(Math.PI / 2).translate(0, 0, 0.1), gold, 0, 0, 0));
      g.add(mesh(new T.CylinderGeometry(0.06, 0.06, 2.6, 6).rotateX(Math.PI / 2).translate(0, 0, 1.3), gold, 0, 0, 0));
      for (let k = 1; k <= 3; k++) {   // kollar: yatay çubuk + iki dikey
        const w = k * 0.42, z0 = 2.6 - k * 0.32;
        g.add(mesh(new T.BoxGeometry(2 * w, 0.08, 0.08), gold, 0, 0, z0));
        for (const s of [-1, 1]) g.add(mesh(new T.CylinderGeometry(0.05, 0.05, 2.9 - z0, 6).rotateX(Math.PI / 2).translate(0, 0, (2.9 - z0) / 2), gold, s * w, 0, z0));
      }
      root.add(g);
      for (let k = -3; k <= 3; k++) { const lx = k * 0.42; glow(it.x + Math.cos(it.yaw) * lx, it.y + Math.sin(it.yaw) * lx, g.position.z + 3.02, 0xffd27a, 0.9); }
      const fl = inst(new T.ConeGeometry(0.06, 0.18, 5).rotateX(Math.PI / 2), basic(0xffc861), 7, 0.9);
      for (let k = -3; k <= 3; k++) { const lx = k * 0.42; setI(fl, k + 3, it.x + Math.cos(it.yaw) * lx, it.y + Math.sin(it.yaw) * lx, g.position.z + 3.0); }
      root.add(fl);
    },
    bell_tower(it) {   // çan kulesi süsü: dört ayak + piramit çatı + sallanan çan
      const g = new T.Group(); g.position.set(it.x, it.y, hAt(it.x, it.y)); g.rotation.z = it.yaw;
      const wood = lam(0x7c4a2d), leg = new T.BoxGeometry(0.16, 0.16, 3);
      for (const [x, y] of [[-0.8, -0.8], [0.8, -0.8], [0.8, 0.8], [-0.8, 0.8]]) g.add(mesh(leg, wood, x, y, 1.5));
      const roof = mesh(new T.ConeGeometry(1.45, 0.95, 4).rotateX(Math.PI / 2).rotateZ(Math.PI / 4), lam(0x9f1239), 0, 0, 3.47);
      const bell = new T.Group(); bell.position.set(0, 0, 2.85);
      bell.add(mesh(new T.CylinderGeometry(0.18, 0.42, 0.6, 10, 1, true).rotateX(Math.PI / 2).translate(0, 0, -0.35), lam(0xd4a017, { side: T.DoubleSide, emissive: 0x2a1d00 }), 0, 0, 0));
      g.add(roof, bell, mesh(new T.BoxGeometry(1.76, 0.12, 0.12), wood, 0, 0, 2.9));
      root.add(g);
      S.anim.push(now => { bell.rotation.x = Math.sin(now / 1000 * 1.6) * 0.25; });
    },
    xmas_tree(it) {   // çam (3 koni) + gövde + süs topları + tepe yıldızı (≤ 4 m)
      const z = hAt(it.x, it.y), g = new T.Group(); g.position.set(it.x, it.y, z);
      g.add(mesh(new T.CylinderGeometry(0.16, 0.2, 0.6, 6).rotateX(Math.PI / 2).translate(0, 0, 0.3), lam(0x5b3a1e), 0, 0, 0));
      const green = lam(0x166534, { flatShading: true });
      const tiers = [[1.35, 1.5, 0.5], [1.05, 1.3, 1.45], [0.72, 1.15, 2.3]];
      for (const [r, h, z0] of tiers) g.add(mesh(new T.ConeGeometry(r, h, 10).rotateX(Math.PI / 2).translate(0, 0, h / 2), green, 0, 0, z0));
      const st = new T.Shape(); for (let i = 0; i < 10; i++) { const a = -Math.PI / 2 + i * Math.PI / 5, r = i % 2 ? 0.1 : 0.24; i ? st.lineTo(Math.cos(a) * r, -Math.sin(a) * r) : st.moveTo(Math.cos(a) * r, -Math.sin(a) * r); }
      const star = mesh(new T.ShapeGeometry(st).rotateX(Math.PI / 2), basic(0xfde047, { side: T.DoubleSide }), 0, 0, 3.72);
      g.add(star);
      root.add(g);
      S.anim.push(now => { star.rotation.z = now / 1000 * 0.6; });
      const n = it.n, orn = inst(new T.IcosahedronGeometry(0.085, 0), basic(0xffffff), n, 0.4), R = rng(hashStr(`${it.x},${it.y}`)), pal = [0xef4444, 0xfacc15, 0x60a5fa, 0xf0abfc, 0xffffff];
      for (let i = 0; i < n; i++) {
        const t = tiers[i % 3], u = 0.15 + R() * 0.75, rr = t[0] * (1 - u) + 0.05, a = R() * TAU, oz = t[2] + u * t[1];
        const x = it.x + Math.cos(a) * rr, y = it.y + Math.sin(a) * rr;
        setI(orn, i, x, y, z + oz); colI(orn, i, pal[i % pal.length]);
        if (i % 2 === 0) glow(x, y, z + oz, pal[i % pal.length], 0.55);
      }
      root.add(orn);
      glow(it.x, it.y, z + 3.72, 0xfde047, 1.6);
    },
    snow(it) {   // yer karı: YALNIZ görsel zemin dokusu (fizik/çarpışma yok; yüksekliği değiştirmez)
      root.add(drape(it.x, it.y, it.r, decal({ color: 0xf1f5f9, opacity: 0.92, alphaMap: softTex() || null }), 0.05));
    },
    gifts(it) {
      const n = it.pts.length, box = inst(new T.BoxGeometry(1, 1, 1), lam(0xffffff), n), rib = inst(new T.BoxGeometry(1, 1, 1), lam(0xfde68a, { emissive: 0x332200 }), n * 2);
      it.pts.forEach((p, i) => {
        const s = 0.35 + p.c * 0.35, z = hAt(p.x, p.y) + s / 2;
        setI(box, i, p.x, p.y, z, p.yaw, s, s * 0.9, s); colI(box, i, PALETTE.gifts[i % PALETTE.gifts.length]);
        setI(rib, i * 2, p.x, p.y, z, p.yaw, s * 1.02, s * 0.14, s * 1.02); setI(rib, i * 2 + 1, p.x, p.y, z, p.yaw, s * 0.14, s * 0.92, s * 1.02);
      });
      root.add(box, rib);
    },
    pumpkins(it) {   // oyulmuş, ışıklı balkabakları: gövde + sap + yüz (eve dönük; gece hale)
      const n = it.pts.length;
      const body = inst(new T.IcosahedronGeometry(0.32, 1), lam(0xea580c, { flatShading: true }), n, 0.2);
      const stem = inst(new T.CylinderGeometry(0.035, 0.05, 0.14, 5).rotateX(Math.PI / 2), lam(0x3f6212), n);
      const ft = faceTex();
      const face = inst(new T.PlaneGeometry(0.4, 0.3).rotateX(Math.PI / 2), basic(0xffffff, { map: ft, transparent: !!ft, alphaTest: ft ? 0.3 : 0, side: T.DoubleSide, color: ft ? 0xffffff : 0xffb02e }), n, 0.5);
      it.pts.forEach((p, i) => {
        const s = 0.8 + p.c * 0.6, z = hAt(p.x, p.y) + 0.22 * s, yaw = Math.atan2(p.x, -p.y);   // yüz eve (pist ortasına) dönük
        setI(body, i, p.x, p.y, z, p.yaw, s, s, s * 0.72);
        setI(stem, i, p.x, p.y, z + 0.27 * s, p.yaw, s);
        setI(face, i, p.x - Math.sin(yaw) * 0.3 * s, p.y + Math.cos(yaw) * 0.3 * s, z + 0.02 * s, yaw, s * 0.9);
        glow(p.x - Math.sin(yaw) * 0.34 * s, p.y + Math.cos(yaw) * 0.34 * s, z, 0xff8c1a, 1.1);
      });
      root.add(body, stem, face);
    },
    scarecrow(it) {
      const g = new T.Group(); g.position.set(it.x, it.y, hAt(it.x, it.y)); g.rotation.z = it.yaw;
      const wood = lam(0x6b4423);
      g.add(mesh(new T.CylinderGeometry(0.05, 0.06, 2.2, 6).rotateX(Math.PI / 2).translate(0, 0, 1.1), wood, 0, 0, 0));
      g.add(mesh(new T.CylinderGeometry(0.04, 0.04, 1.6, 6).rotateZ(Math.PI / 2), wood, 0, 0, 1.75));
      g.add(mesh(new T.BoxGeometry(0.62, 0.3, 0.75), lam(0x7f1d1d, { flatShading: true }), 0, 0, 1.45));
      g.add(mesh(new T.BoxGeometry(1.4, 0.18, 0.18), lam(0x7f1d1d), 0, 0, 1.75));
      g.add(mesh(new T.IcosahedronGeometry(0.22, 1), lam(0xea580c, { flatShading: true }), 0, 0, 2.1));
      g.add(mesh(new T.CylinderGeometry(0.42, 0.42, 0.03, 10).rotateX(Math.PI / 2), lam(0x1f2937), 0, 0, 2.28));
      g.add(mesh(new T.ConeGeometry(0.2, 0.32, 8).rotateX(Math.PI / 2).translate(0, 0, 0.16), lam(0x1f2937), 0, 0, 2.28));
      root.add(g);
    },
    eggs(it) {
      const n = it.pts.length, egg = inst(new T.IcosahedronGeometry(0.11, 1).scale(1, 1, 1.35), lam(0xffffff), n, 0.15);
      it.pts.forEach((p, i) => { setI(egg, i, p.x, p.y, hAt(p.x, p.y) + 0.11, p.yaw, p.s, p.s, p.s, 1.1 + p.c * 0.4); colI(egg, i, PALETTE.eggs[i % PALETTE.eggs.length]); });
      root.add(egg);
    },
    bunny(it) {   // tavşan: gövde/baş/kulaklar/kuyruk; ara sıra yerinde sıçrar
      for (const p of it.pts) {
        const g = new T.Group(); g.position.set(p.x, p.y, hAt(p.x, p.y)); g.rotation.z = p.yaw;
        const fur = lam(0xe7e5e4, { flatShading: true });
        g.add(mesh(new T.IcosahedronGeometry(0.2, 1).scale(0.85, 1.15, 0.9), fur, 0, 0, 0.2, 0.6));
        g.add(mesh(new T.IcosahedronGeometry(0.12, 1), fur, 0, 0.2, 0.36, 0.6));
        for (const s of [-1, 1]) g.add(mesh(new T.IcosahedronGeometry(0.04, 0).scale(1, 0.6, 3.6), fur, s * 0.045, 0.2, 0.55, 0.6));
        g.add(mesh(new T.IcosahedronGeometry(0.06, 0), lam(0xffffff), 0, -0.24, 0.24, 0.6));
        root.add(g);
        const ph = p.c * 10, z0 = g.position.z;
        S.anim.push(now => { const t = (now / 1000 + ph) % 4; g.position.z = z0 + (t < 0.45 ? Math.sin(t / 0.45 * Math.PI) * 0.22 : 0); if (t < 0.02) g.rotation.z += 0.6; });
      }
    },
    flags(it) { for (const p of it.pts) addFlag(p.x, p.y, hAt(p.x, p.y), DECOR.POLE_H, 1.8); },
    roof_flags(it) { for (const p of it.pts) addFlag(p.x, p.y, p.z, DECOR.ROOF_H, 1.2); },
    diyas(it) {   // kandiller: kil kâse + alev hale
      const n = it.pts.length, bowl = inst(new T.SphereGeometry(0.12, 8, 3, 0, TAU, Math.PI / 2, Math.PI / 2).rotateX(Math.PI / 2).scale(1, 1, 0.55), lam(0xb45309, { side: T.DoubleSide }), n, 0.3);
      const fl = inst(new T.ConeGeometry(0.035, 0.12, 5).rotateX(Math.PI / 2), basic(0xffb347), n, 0.9);
      it.pts.forEach((p, i) => { const z = hAt(p.x, p.y) + 0.07; setI(bowl, i, p.x, p.y, z); setI(fl, i, p.x, p.y, z + 0.07); glow(p.x, p.y, z + 0.1, 0xffa53a, 0.7); });
      root.add(bowl, fl);
      S.anim.push(now => { const t = now / 1000; for (let i = 0; i < n; i++) { const p = it.pts[i], k = 0.85 + Math.sin(t * 9 + i * 1.7) * 0.15; setI(fl, i, p.x, p.y, hAt(p.x, p.y) + 0.14, 0, k, k, k * 1.2); } fl.instanceMatrix.needsUpdate = true; });
    },
    stains(it) {   // holi: zeminde renkli toz lekeleri (dekal)
      const n = it.pts.length, st = inst(new T.CircleGeometry(1, 14), decal({ opacity: 0.85, alphaMap: softTex() || null }), n, 0.1);
      it.pts.forEach((p, i) => { setI(st, i, p.x, p.y, hAt(p.x, p.y) + 0.05, p.yaw, p.rad, p.rad * (0.7 + p.c * 0.3), 1); colI(st, i, PALETTE.holi[i % PALETTE.holi.length]); });
      st.renderOrder = 1;
      root.add(st);
    },
    lotus_pond(it) {   // nilüfer göleti süsü: su dekali + taş kenar + nilüferler
      const z = hAt(it.x, it.y);
      root.add(drape(it.x, it.y, 3.4, decal({ color: 0x1d4ed8, opacity: 0.8 }), 0.07, 20, 2));
      const stones = inst(new T.IcosahedronGeometry(0.22, 0), lam(0x9ca3af, { flatShading: true }), 18);
      for (let i = 0; i < 18; i++) { const a = i / 18 * TAU; setI(stones, i, it.x + Math.cos(a) * 3.55, it.y + Math.sin(a) * 3.55, hAt(it.x + Math.cos(a) * 3.55, it.y + Math.sin(a) * 3.55) + 0.06, a, 1, 1.3, 0.6); }
      const pad = inst(new T.CircleGeometry(0.35, 8), lam(0x15803d, { side: T.DoubleSide }), it.n), fl = inst(new T.ConeGeometry(0.2, 0.2, 6).rotateX(-Math.PI / 2), basic(0xf9a8d4), it.n, 0.15);
      const R = rng(hashStr(`l${it.x}`));
      for (let i = 0; i < it.n; i++) { const a = R() * TAU, d = Math.sqrt(R()) * 2.5, x = it.x + Math.cos(a) * d, y = it.y + Math.sin(a) * d; setI(pad, i, x, y, z + 0.09); setI(fl, i, x + 0.1, y, z + 0.22); }
      root.add(stones, pad, fl);
    },
    kite_stand(it) {   // uçurtma standı: iki direk + çıta + asılı uçurtmalar + masa
      const g = new T.Group(); g.position.set(it.x, it.y, hAt(it.x, it.y)); g.rotation.z = it.yaw;
      const wood = lam(0x92400e);
      for (const s of [-1, 1]) g.add(mesh(new T.CylinderGeometry(0.05, 0.05, 2.4, 6).rotateX(Math.PI / 2).translate(0, 0, 1.2), wood, s * 1.3, 0, 0));
      g.add(mesh(new T.BoxGeometry(2.7, 0.08, 0.08), wood, 0, 0, 2.35), mesh(new T.BoxGeometry(2, 0.7, 0.06), lam(0xfef3c7), 0, 0.5, 0.8));
      for (const [s, x] of [[-1, -1.3], [1, 1.3]]) g.add(mesh(new T.BoxGeometry(0.06, 0.06, 0.8), wood, x * 0.7, 0.5 + 0.3 * s, 0.4));
      const cols = [0xef4444, 0x3b82f6, 0xfacc15, 0x22c55e];
      cols.forEach((c, i) => {
        const k = new T.Mesh(new T.PlaneGeometry(0.62, 0.62).rotateZ(Math.PI / 4).scale(0.75, 1.05, 1).rotateX(Math.PI / 2), lam(c, { side: T.DoubleSide }));
        k.position.set(-0.9 + i * 0.6, 0.02, 1.75); k.userData.heat = 0.12; g.add(k);
        S.anim.push(now => { k.rotation.x = Math.sin(now / 1000 * 1.8 + i) * 0.12; });
      });
      root.add(g);
    },
    balloons(it) {   // alçak balon demetleri (≤ 3,8 m; bağlı, hafif salınım)
      const n = it.n, R = rng(it.seed), z = hAt(it.x, it.y);
      const bl = inst(new T.IcosahedronGeometry(0.24, 1).scale(1, 1, 1.18), lam(0xffffff, { emissive: 0x111111 }), n, 0.12);
      const off = Array.from({ length: n }, () => ({ dx: (R() - 0.5) * 0.7, dy: (R() - 0.5) * 0.7, h: 2.7 + R() * 0.8, ph: R() * TAU }));
      const lineG = new T.BufferGeometry(), lp = new Float32Array(n * 6);
      lineG.setAttribute('position', new T.BufferAttribute(lp, 3));
      const lines = new T.LineSegments(lineG, new T.LineBasicMaterial({ color: 0xe5e7eb }));
      const put = now => {
        const t = now / 1000;
        off.forEach((b, i) => {
          const sx = Math.sin(t * 0.9 + b.ph) * 0.12, sy = Math.cos(t * 0.7 + b.ph) * 0.12, x = it.x + b.dx + sx, y = it.y + b.dy + sy, bz = z + b.h;
          setI(bl, i, x, y, bz); lp.set([it.x, it.y, z + 0.9, x, y, bz - 0.27], i * 6);
        });
        bl.instanceMatrix.needsUpdate = true; lineG.attributes.position.needsUpdate = true;
      };
      off.forEach((_, i) => colI(bl, i, PALETTE.balloons[i % PALETTE.balloons.length]));
      put(0);
      root.add(bl, lines, mesh(new T.BoxGeometry(0.25, 0.25, 0.9).translate(0, 0, 0.45), lam(0x6b7280), it.x, it.y, z));
      S.anim.push(put);
    },
    bed(it) {   // çiçek tarhı (dikdörtgen ya da kalp): toprak + yeşillik + çiçekler
      const z = hAt(it.x, it.y), R = rng(it.seed), pal = PALETTE[it.palette] || PALETTE.pastel;
      const pts = [];
      if (it.shape === 'heart') for (let i = 0; i < 26; i++) { const t = i / 26 * TAU, hx = 16 * Math.sin(t) ** 3, hy = 13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t); pts.push([hx / 16 * 1.7, hy / 16 * 1.7 + 0.3]); }
      else for (let i = 0; i < 24; i++) pts.push([(i % 8 - 3.5) * 0.38, (Math.floor(i / 8) - 1) * 0.38]);
      const c = Math.cos(it.yaw), s = Math.sin(it.yaw);
      if (it.shape !== 'heart') root.add(mesh(new T.BoxGeometry(3.3, 1.35, 0.22).rotateZ(it.yaw), lam(0x5b3a1e), it.x, it.y, z + 0.06));
      const leaf = inst(new T.IcosahedronGeometry(0.17, 0).scale(1, 1, 0.7), lam(0x15803d, { flatShading: true }), pts.length);
      const fl = inst(new T.IcosahedronGeometry(0.09, 0), lam(0xffffff, { emissive: 0x111111 }), pts.length, 0.12);
      pts.forEach(([lx, ly], i) => {
        const x = it.x + c * lx - s * ly, y = it.y + s * lx + c * ly, zz = hAt(x, y) + (it.shape === 'heart' ? 0 : 0.17);
        setI(leaf, i, x, y, zz + 0.12, R() * TAU); setI(fl, i, x + (R() - 0.5) * 0.08, y + (R() - 0.5) * 0.08, zz + 0.33 + R() * 0.1); colI(fl, i, pal[Math.floor(R() * pal.length)]);
      });
      root.add(leaf, fl);
    },
    blossom(it) {   // çiçekli ağaçlar (≤ 3,8 m)
      const n = it.pts.length, trunk = inst(new T.CylinderGeometry(0.1, 0.15, 1.9, 6).rotateX(Math.PI / 2).translate(0, 0, 0.95), lam(0x6b4423), n);
      const crown = inst(new T.IcosahedronGeometry(1.05, 1), lam(0xffffff, { flatShading: true }), n * 2);
      it.pts.forEach((p, i) => {
        const z = hAt(p.x, p.y);
        setI(trunk, i, p.x, p.y, z, 0, p.s);
        setI(crown, i * 2, p.x, p.y, z + 2.55 * p.s, i, p.s, p.s, p.s * 0.85); colI(crown, i * 2, 0xf9a8d4);
        setI(crown, i * 2 + 1, p.x + 0.45, p.y - 0.3, z + 2.2 * p.s, i + 1, p.s * 0.7); colI(crown, i * 2 + 1, 0xfbcfe8);
      });
      root.add(trunk, crown);
    },
    butterflies(it) {   // yer seviyesinde (0,4–2,2 m) çırpınan kelebekler
      const n = it.n, R = rng(hashStr(`b${it.x}`));
      const wing = new T.BufferGeometry(); wing.setAttribute('position', new T.Float32BufferAttribute([0, 0, 0, 0.16, 0.1, 0, 0.13, -0.08, 0], 3)); wing.computeVertexNormals();
      const L = inst(wing, lam(0xffffff, { side: T.DoubleSide, emissive: 0x111111 }), n, 0.1), Rw = inst(wing, lam(0xffffff, { side: T.DoubleSide, emissive: 0x111111 }), n, 0.1);
      const pal = [0xfacc15, 0xf97316, 0x60a5fa, 0xf0abfc, 0xffffff];
      const bf = Array.from({ length: n }, (_, i) => ({ c: it.pts[i % it.pts.length], ph: R() * TAU, r: 1.2 + R() * 1.6, sp: 0.4 + R() * 0.5, z: 0.5 + R() * 1.5 }));
      bf.forEach((b, i) => { colI(L, i, pal[i % pal.length]); colI(Rw, i, pal[i % pal.length]); });
      const put = now => {
        const t = now / 1000;
        bf.forEach((b, i) => {
          const a = t * b.sp + b.ph, x = b.c.x + Math.cos(a) * b.r, y = b.c.y + Math.sin(a * 1.3) * b.r, z = hAt(b.c.x, b.c.y) + b.z + Math.sin(t * 2 + b.ph) * 0.25;
          const yaw = a + Math.PI / 2, f = Math.sin(t * 18 + b.ph) * 0.9;
          setI(L, i, x, y, z, yaw, 1, 1, 1, 0, -f); setI(Rw, i, x, y, z, yaw + Math.PI, 1, 1, 1, 0, f);
        });
        L.instanceMatrix.needsUpdate = true; Rw.instanceMatrix.needsUpdate = true;
      };
      put(0);
      root.add(L, Rw);
      S.anim.push(put);
    },
    fireworks(it) {   // gece ufukta havai fişek: tek Points havuzu (toplamsal), 3–7 sn'de bir patlama — dikkat dağıtmaz
      const N = 420, pos = new Float32Array(N * 3), col = new Float32Array(N * 3), P = Array.from({ length: N }, () => ({ life: 0, vx: 0, vy: 0, vz: 0, r: 1, g: 1, b: 1 }));
      const geo = new T.BufferGeometry(); geo.setAttribute('position', new T.BufferAttribute(pos, 3)); geo.setAttribute('color', new T.BufferAttribute(col, 3));
      const mat = new T.PointsMaterial({ size: 9, map: glowTex(), vertexColors: true, transparent: true, depthWrite: false, blending: T.AdditiveBlending, sizeAttenuation: true, fog: false });
      const pts = new T.Points(geo, mat); pts.frustumCulled = false; pts.name = 'havai-fisek';
      root.add(pts);
      const R = rng(hashStr(`fw${it.x}`)), z0 = hAt(it.x, it.y);
      let next = 1.5, k = 0;
      S.fw = { bursts: 0 };
      S.anim.push((now, dt) => {
        next -= dt;
        if (next <= 0) {
          next = 3 + R() * 4; S.fw.bursts++;
          const cx = it.x + (R() - 0.5) * 2 * it.r, cy = it.y + (R() - 0.5) * 2 * it.r, cz = z0 + 170 + R() * 120;
          tmpC.set(PALETTE.fw[Math.floor(R() * PALETTE.fw.length)]);
          for (let i = 0; i < 70; i++) {
            const p = P[k], j = k * 3; k = (k + 1) % N;
            const a = R() * TAU, e = Math.acos(2 * R() - 1), sp = 26 + R() * 14;
            p.life = 1.8 + R() * 0.6; p.vx = Math.sin(e) * Math.cos(a) * sp; p.vy = Math.sin(e) * Math.sin(a) * sp; p.vz = Math.cos(e) * sp; p.r = tmpC.r; p.g = tmpC.g; p.b = tmpC.b;
            pos[j] = cx; pos[j + 1] = cy; pos[j + 2] = cz;
          }
        }
        for (let i = 0; i < N; i++) {
          const p = P[i], j = i * 3;
          if (p.life <= 0) { col[j] = col[j + 1] = col[j + 2] = 0; continue; }
          p.life -= dt; p.vx *= 1 - 1.2 * dt; p.vy *= 1 - 1.2 * dt; p.vz = p.vz * (1 - 1.2 * dt) - 9.8 * dt;
          pos[j] += p.vx * dt; pos[j + 1] += p.vy * dt; pos[j + 2] += p.vz * dt;
          const f = clamp(p.life / 1.2, 0, 1);
          col[j] = p.r * f; col[j + 1] = p.g * f; col[j + 2] = p.b * f;
        }
        geo.attributes.position.needsUpdate = true; geo.attributes.color.needsUpdate = true;
      });
    },
  };
  // Dalgalanan bayrak (flag-icons dokusu; rüzgâr yönüne uçar): direk + tepe topu + 12×6 ızgara
  const flags = [];
  function flagTexture() {
    const c = normCountry(S.country) || 'TR';
    if (S.flagTex && S.flagKey === c) return S.flagTex;
    S.flagTex?.dispose?.(); S.flagTex = null; S.flagKey = c;
    const d = doc(), url = flagUrl(c);
    if (!d || !url || typeof Image === 'undefined') return null;
    const cv = d.createElement('canvas'); cv.width = 256; cv.height = 192;
    const g = cv.getContext('2d'); g.fillStyle = '#e11d48'; g.fillRect(0, 0, 256, 192);
    const tex = new T.CanvasTexture(cv); tex.colorSpace = T.SRGBColorSpace;
    const im = new Image();
    im.onload = () => { try { g.drawImage(im, 0, 0, 256, 192); tex.needsUpdate = true; } catch { /* */ } };
    im.src = url;
    S.flagTex = tex;
    return tex;
  }
  function addFlag(x, y, z, poleH, w) {
    const pm = lam(0xd1d5db);
    root.add(mesh(new T.CylinderGeometry(0.045 * (poleH / 8 + 0.5), 0.07 * (poleH / 8 + 0.5), poleH, 6).rotateX(Math.PI / 2).translate(0, 0, poleH / 2), pm, x, y, z));
    root.add(mesh(new T.IcosahedronGeometry(0.09, 0), lam(0xfacc15), x, y, z + poleH + 0.05));
    const h = w * 0.66, geo = new T.PlaneGeometry(w, h, 12, 6).translate(w / 2, 0, 0).rotateX(Math.PI / 2);
    const tex = flagTexture();
    const f = new T.Mesh(geo, lam(tex ? 0xffffff : 0xdc2626, { map: tex, side: T.DoubleSide }));
    f.position.set(x, y, z + poleH - h / 2 - 0.08); f.userData.heat = 0.12;
    const base = Float32Array.from(geo.attributes.position.array);
    flags.push({ m: f, base, w, ph: (x + y) * 0.3 });
    root.add(f);
  }
  const waveFlags = (t, wind) => {
    const dir = num(wind?.dir, 270), ms = clamp(num(wind?.ms, 3), 0, 25), yaw = (90 - (dir + 180)) * DEG;   // rüzgârın estiği yöne (meteorolojik "-den" + 180°)
    const amp = 0.05 + clamp(ms / 12, 0, 1) * 0.12, droop = clamp(1 - ms / 4, 0, 1) * 0.6;   // durgun havada hafif sarkık (okunur kalsın)
    for (const F of flags) {
      F.m.rotation.z = yaw;
      const p = F.m.geometry.attributes.position, a = p.array, b = F.base;
      for (let i = 0; i < p.count; i++) {
        const x = b[i * 3], u = x / F.w;
        a[i * 3] = x * (1 - droop * 0.35);
        a[i * 3 + 1] = Math.sin(t * (3 + ms * 0.25) - u * 6 + F.ph) * amp * F.w * u;
        a[i * 3 + 2] = b[i * 3 + 2] - droop * u * F.w * 0.45;
      }
      p.needsUpdate = true;
    }
  };

  function clear() {
    root.traverse(x => { if (x.geometry) x.geometry.dispose(); const ms = Array.isArray(x.material) ? x.material : x.material ? [x.material] : []; ms.forEach(m => m.dispose?.()); });
    while (root.children.length) root.remove(root.children[0]);
    S.anim = []; S.glowMats = []; S.basicMats = []; flags.length = 0; S.sheep = null; S.fw = null; S.plan = null; S.anchors = []; H.clear();
  }
  function applyLight() {   // gündüz ışıklı süsler hafif kısık, haleler soluk; gece tam
    const night = S.time === 'night' ? 1 : S.time === 'dusk' ? 0.6 : 0;
    for (const m of S.glowMats) m.opacity = 0.18 + night * 0.72;
    for (const m of S.basicMats) m.color.copy(m.userData.c0).multiplyScalar(0.75 + night * 0.25);
  }
  /** Yeniden yerleşim: tema + bağlam (pist yönü, saat, kalite, engeller, çatılar) → plan → nesneler */
  function place(themes, country, ctx = {}) {
    clear();
    S.themes = (themes || []).filter(t => THEMES.includes(t)).slice(0, 2); S.country = country || null; S.ctx = ctx; S.level = normLevel(ctx.level); S.time = ctx.time || 'day';
    if (!S.themes.length) return null;
    const plan = planDecor(S.themes, ctx);
    S.plan = plan;
    for (const it of plan.items) { try { B[it.kind]?.(it); } catch (e) { console.warn('bayram süsü', it.kind, e); } }
    flushGlow(); applyLight();
    S.anchors = plan.items.filter(it => !it.far && !it.onRoof).map(it => ({ x: it.x, y: it.y, z: num(th(it.x, it.y), 0) }));
    S.seatAt = 0;
    return info();
  }
  /** Kare: hareketler (koyun, bayrak, balon, kelebek, fişek …) + (Google 3B) karolar yüklendikçe zemine yeniden oturma denetimi */
  function update(now, dt, o = {}) {
    if (!S.plan || !root.visible) return;
    const a = performance.now();
    const t = now / 1000;
    dt = Math.min(0.1, Math.max(0, num(dt, 0.016)));
    for (const f of S.anim) f(now, dt);
    if (flags.length && now - S.lastFlagAt > 33) { S.lastFlagAt = now; waveFlags(t, o.wind); }
    if (S.ctx?.google && now - S.seatAt > 2500 && S.anchors.length) {   // Google karoları geç gelir: ankraj yükseklikleri 0,3 m'den çok değiştiyse yeniden kur
      S.seatAt = now;
      if (S.anchors.some(p => Math.abs(num(th(p.x, p.y), 0) - p.z) > 0.3)) { place(S.themes, S.country, S.ctx); return; }
    }
    const ms = performance.now() - a;
    S.frames++; S.avg = S.avg ? S.avg * 0.95 + ms * 0.05 : ms; if (S.frames > 30) S.max = Math.max(S.max * 0.999, ms);
  }
  function info() {
    let tris = 0, draws = 0;
    root.traverse(x => {
      if (!(x.isMesh || x.isPoints || x.isLine)) return;
      draws++;
      if (!x.isMesh) return;
      const g = x.geometry, c = g.index ? g.index.count : g.attributes.position.count;
      tris += Math.round(c / 3) * (x.isInstancedMesh ? x.count : 1);
    });
    return { themes: S.themes.slice(), country: S.country, level: S.level, time: S.time, counts: S.plan ? decorCaps(S.plan) : {}, items: S.plan ? S.plan.items.length : 0, tris, draws,
      avgMs: +S.avg.toFixed(3), maxMs: +S.max.toFixed(3), spots: S.plan ? S.plan.items.map(it => ({ kind: it.kind, x: +it.x.toFixed(1), y: +it.y.toFixed(1), r: it.r })) : [], sheep: S.sheep ? S.sheep.length : 0, fireworks: S.fw ? S.fw.bursts : null, visible: root.visible };
  }
  return {
    root, place, update, clear, info, get plan() { return S.plan; }, sheepState: () => (S.sheep || []).map(s => ({ x: +s.x.toFixed(2), y: +s.y.toFixed(2), st: s.st })),
    setVisible(v) { root.visible = !!v; },
    dispose() { clear(); for (const k of Object.keys(S.tex)) S.tex[k]?.dispose?.(); S.tex = {}; S.flagTex?.dispose?.(); S.flagTex = null; scene?.remove(root); },
  };
}

// ---------------------------------------------------------------- uygulama bağlantısı (HEPGO + SIMUMAV)
/**
 * Bugünkü bayram temasını çöz (holiday_fx.resolveHoliday: ayar ülkesi → girilen konum → saat dilimi → dil; ?bayram= önizleme) ve sahneye uygula.
 * o: { enabled (genel bayram teması), enabled3d ("Uçuş sahnesinde bayram süsleri"), country, located, lang, fetchFn, preview }
 * Kayıttan oynatma da aynı yoldan: kaydın tarihine göre DEĞİL, o anki temaya göre (sade; docs/bayram-temalari.md).
 * → Promise<{ themes, country } | null>
 */
export async function holidayDecorSpec(o = {}) {
  const r = await resolveHoliday({ enabled: true, country: o.country, located: o.located, lang: o.lang, fetchFn: o.fetchFn, preview: o.preview, search: o.search });
  if (!r) return null;
  if (!holidayDecorEnabled({ enabled: o.enabled, enabled3d: o.enabled3d, preview: !!r.pv })) return null;
  const p = r.picked;
  if (!p?.primary) return null;
  return { themes: [p.primary, p.secondary].filter(Boolean).map(x => x.theme), country: p.primary.country || r.detected?.country || null, preview: !!r.pv };
}
export async function applyHolidayDecor(sim, o = {}) {
  if (!sim?.setHoliday) return null;
  let spec = null;
  try { spec = await holidayDecorSpec(o); } catch (e) { console.warn('bayram süsü', e); }
  if (!spec) return null;
  return sim.setHoliday(spec);
}
