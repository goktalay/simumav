// Uçuş Simülatörü §27.3 — alt ortadaki güç paneli kadranlarının (createPowerGauges, .fs-gauges) TASARIM SEÇENEKLERİ (HEPGO + SIMUMAV ortak).
// Temalar: classic (Klasik otomobil — §23.6 mevcut görünüm; SIMUMAV'da oyun teması .sm-game), cockpit (Uçak kokpiti: siyah kadran, beyaz ibre,
// kokpit tipografisi, gece kırmızı-amber arka aydınlatma), glass (Dijital cam kokpit: MFD karoları, büyük sayısal değer + seviye şeridi),
// minimal (Minimal / şeffaf: HUD ile uyumlu ince halkalar, zeminsiz), military (Retro askerî: zeytin yeşili gövde, fosfor yeşili rakamlar).
// Seçim kalıcıdır (localStorage fs.gauge.theme); başlangıç sihirbazında önizlemeli kartlarla (HEPGO Kamera adımı, SIMUMAV Pilot adımı) ve uçuşta
// kadran ayrıntı kutusunda / G tuşuyla değiştirilir. Tema yalnız istemci görünümüdür (sunucuya gitmez; geçersiz değer → classic).
// Gün/gece: her tema açık (HEPGO html[data-theme=light|yok]) ve koyu (html[data-theme=dark], SIMUMAV .sm-game) için ayrı ayar taşır.
// Saf kısım (tests/test_flightsim_flyui.mjs): GAUGE_THEMES, isGaugeTheme, normGaugeTheme, nextGaugeTheme, loadGaugeTheme/saveGaugeTheme, gaugeFrac,
// gaugeThemePreviewSvg. DOM: ensureGaugeThemeCss (bir kez), createGaugeThemePicker.

export const GAUGE_THEMES = [
  ['classic', 'Klasik otomobil', 'Açık kadran, siyah ibre; otomobil gösterge paneli.'],
  ['cockpit', 'Uçak kokpiti', 'Siyah kadran, beyaz ibre ve rakamlar; gece amber aydınlatma.'],
  ['glass', 'Dijital cam kokpit', 'MFD karoları: büyük sayısal değer ve seviye şeridi.'],
  ['minimal', 'Minimal / şeffaf', 'Zeminsiz ince halkalar; HUD ile uyumlu.'],
  ['military', 'Retro askerî', 'Zeytin yeşili gövde, fosfor yeşili rakamlar.'],
];
export const GAUGE_THEME_KEYS = GAUGE_THEMES.map(([k]) => k);
export const GAUGE_THEME_DEFAULT = 'classic';
export const GAUGE_THEME_PREF = 'fs.gauge.theme';
export const isGaugeTheme = v => GAUGE_THEME_KEYS.includes(v);
export const normGaugeTheme = v => (isGaugeTheme(v) ? v : GAUGE_THEME_DEFAULT);
export const nextGaugeTheme = v => GAUGE_THEME_KEYS[(GAUGE_THEME_KEYS.indexOf(normGaugeTheme(v)) + 1) % GAUGE_THEME_KEYS.length];
export const gaugeThemeLabel = v => (GAUGE_THEMES.find(([k]) => k === v) || GAUGE_THEMES[0])[1];
/** İbre açısından (−sweep/2 … +sweep/2) doluluk 0…1 (cam kokpit seviye şeridi). */
export const gaugeFrac = (angle, sweep = 240) => (Number.isFinite(Number(angle)) ? Math.round(Math.min(1, Math.max(0, (Number(angle) + sweep / 2) / sweep)) * 1000) / 1000 : 0);

const lsOf = st => st || (typeof localStorage !== 'undefined' ? localStorage : null);
export function loadGaugeTheme(storage = null) { try { return normGaugeTheme(lsOf(storage)?.getItem(GAUGE_THEME_PREF)); } catch { return GAUGE_THEME_DEFAULT; } }
export function saveGaugeTheme(v, storage = null) { const t = normGaugeTheme(v); try { lsOf(storage)?.setItem(GAUGE_THEME_PREF, t); } catch { /* özel kip */ } return t; }

// ---------------------------------------------------------------- metinler ----------------------------------------------------------------
export const GTHEME_TEXTS = [
  ['gtheme.title', 'Gösterge tasarımı'], ['gtheme.sub', 'Alt ortadaki yakıt · hız · motor · batarya kadranlarının görünümü. Uçuşta kadranlara tıklayıp ya da G tuşuyla değiştirilebilir.'],
  ['gtheme.short', 'Tasarım'], ['gtheme.cycle', 'Gösterge tasarımı (G)'], ['gtheme.changed', 'Gösterge tasarımı: {t}'],
  ...GAUGE_THEMES.flatMap(([k, n, d]) => [[`gtheme.${k}`, n], [`gtheme.${k}_desc`, d]]),
];
const TXT = Object.fromEntries(GTHEME_TEXTS);
const fill = (s, p) => (p ? String(s).replace(/\{(\w+)\}/g, (m, k) => (p[k] != null ? String(p[k]) : m)) : String(s));
export const makeGThemeT = (tr, keyed = false) => (k, p) => {
  const tx = TXT[k] ?? k;
  if (!tr) return fill(tx, p);
  if (!keyed) return tr(tx, p);
  const r = tr(k, p);
  return r && r !== k ? r : fill(tx, p);
};

// ---------------------------------------------------------------- önizleme (SVG; WebGL yok) ----------------------------------------------------------------
const PAL = {
  classic: { face: '#f7f8fa', edge: '#d9dde6', ring: 'rgba(255,255,255,.92)', tick: '#aab1bf', num: '#9aa2b1', needle: '#1c2130', digit: '#1f2533', red: '#e2443a' },
  classicDark: { face: '#2a2f3a', edge: '#454c5c', ring: 'rgba(96,104,122,.9)', tick: '#aab2c2', num: '#b4bccb', needle: '#eef1f6', digit: '#f3f5f9', red: '#e2443a' },
  classicGame: { face: '#0c1424', edge: 'rgba(56,189,248,.35)', ring: 'rgba(56,189,248,.55)', tick: '#9fb4d8', num: '#9fb4d8', needle: '#ff8a3d', digit: '#f1f6ff', red: '#ff4d5e' },
  cockpit: { face: '#0b0d10', edge: '#6b7280', ring: '#2c3036', tick: '#f2f2f2', num: '#f4f4f4', needle: '#ffffff', digit: '#ffffff', red: '#ef4444', rw: 7 },
  minimal: { face: 'rgba(8,14,22,.18)', edge: 'rgba(255,255,255,.75)', ring: 'none', tick: 'rgba(255,255,255,.9)', num: 'rgba(255,255,255,.85)', needle: '#ffffff', digit: '#ffffff', red: '#ff6b5e', thin: true },
  military: { face: '#1c2417', edge: '#56653f', ring: '#3d4a2f', tick: '#a9f06a', num: '#b8f27a', needle: '#dcffb0', digit: '#c8ff8c', red: '#f97316', rw: 6, glow: true },
};
function dialPrev(cx, cy, r, p, frac, big) {
  const P = (a, rr) => { const t = (a - 90) * Math.PI / 180; return [cx + rr * Math.cos(t), cy + rr * Math.sin(t)]; };
  const arc = (a0, a1, rr) => { const [x0, y0] = P(a0, rr), [x1, y1] = P(a1, rr); return `M${x0.toFixed(1)} ${y0.toFixed(1)}A${rr} ${rr} 0 ${a1 - a0 > 180 ? 1 : 0} 1 ${x1.toFixed(1)} ${y1.toFixed(1)}`; };
  let s = p.ring !== 'none' ? `<path d="${arc(-126, 126, r * 1.03)}" fill="none" stroke="${p.ring}" stroke-width="${p.rw || 3}" stroke-linecap="round"/>` : '';
  s += `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${p.face}" stroke="${p.edge}" stroke-width="${p.thin ? 0.9 : 0.7}"/>`;
  s += `<path d="${arc(84, 120, r * 0.9)}" fill="none" stroke="${p.red}" stroke-width="${r * 0.08}"/>`;
  for (let i = 0; i <= (big ? 10 : 8); i++) {
    const a = -120 + 240 * i / (big ? 10 : 8), major = i % 2 === 0;
    if (p.thin && !major) continue;
    const [x0, y0] = P(a, r * (major ? 0.78 : 0.85)), [x1, y1] = P(a, r * 0.95);
    s += `<line x1="${x0.toFixed(1)}" y1="${y0.toFixed(1)}" x2="${x1.toFixed(1)}" y2="${y1.toFixed(1)}" stroke="${p.tick}" stroke-width="${major ? 1.2 : 0.7}"/>`;
  }
  const a = -120 + 240 * frac, [nx, ny] = P(a, r * 0.8);
  s += `<line x1="${cx}" y1="${cy}" x2="${nx.toFixed(1)}" y2="${ny.toFixed(1)}" stroke="${p.needle}" stroke-width="${p.thin ? 1.1 : 2}" stroke-linecap="round"${p.glow ? ' filter="url(#gl)"' : ''}/>`;
  s += `<circle cx="${cx}" cy="${cy}" r="${p.thin ? 1.6 : 2.6}" fill="${p.thin ? p.needle : p.edge}"/>`;
  s += `<text x="${cx}" y="${(cy + r * 0.55).toFixed(1)}" fill="${p.digit}" font-size="${(r * 0.36).toFixed(1)}" font-weight="800" text-anchor="middle" font-family="${p.glow ? 'ui-monospace,monospace' : 'system-ui,sans-serif'}"${p.glow ? ' filter="url(#gl)"' : ''}>${Math.round(frac * (big ? 120 : 100))}</text>`;
  return s;
}
/** Kart önizlemesi: gökyüzü/arazi zemininde iki kadran (ya da cam kokpitte iki MFD karosu). dark: gece/koyu tema renkleri. */
export function gaugeThemePreviewSvg(theme, { dark = false, game = false } = {}) {
  const t = normGaugeTheme(theme);
  const bg = `<defs><linearGradient id="sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${dark ? '#0b1730' : '#7fb2e5'}"/><stop offset=".62" stop-color="${dark ? '#1d2a44' : '#cfe3f5'}"/><stop offset=".63" stop-color="${dark ? '#1b2a1c' : '#7a9b5a'}"/><stop offset="1" stop-color="${dark ? '#101a10' : '#5d7e43'}"/></linearGradient><filter id="gl" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation=".9" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter></defs><rect width="160" height="90" fill="url(#sky)"/>`;
  let body = '';
  if (t === 'glass') {
    const tile = (x, w, label, val, unit, frac, col) => `<g transform="translate(${x} 22)"><rect width="${w}" height="46" rx="4" fill="${dark ? 'rgba(4,8,16,.82)' : 'rgba(6,12,22,.78)'}" stroke="rgba(56,232,255,.45)" stroke-width=".8"/><text x="5" y="10" fill="#7dd3fc" font-size="6.5" font-weight="700" font-family="ui-monospace,monospace" letter-spacing=".8">${label}</text><text x="${w - 5}" y="31" fill="#ffffff" font-size="17" font-weight="800" text-anchor="end" font-family="ui-monospace,monospace">${val}</text><text x="5" y="31" fill="#22d3ee" font-size="6" font-family="ui-monospace,monospace">${unit}</text><rect x="5" y="37" width="${w - 10}" height="4" rx="2" fill="rgba(255,255,255,.14)"/><rect x="5" y="37" width="${((w - 10) * frac).toFixed(1)}" height="4" rx="2" fill="${col}"/></g>`;
    body = tile(8, 46, 'FUEL', '3.9', 'L', 0.78, '#22c55e') + tile(57, 50, 'SPD', '72', 'KM/H', 0.6, '#38bdf8') + tile(110, 42, 'BATT', '24', '%', 0.24, '#fbbf24');
  } else {
    const p = t === 'classic' ? (game ? PAL.classicGame : dark ? PAL.classicDark : PAL.classic) : PAL[t];
    body = dialPrev(36, 52, 20, p, 0.82, false) + dialPrev(80, 48, 28, p, 0.55, true) + dialPrev(124, 52, 20, p, 0.3, false);
  }
  return `<svg viewBox="0 0 160 90" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">${bg}${body}</svg>`;
}

// ---------------------------------------------------------------- CSS (bir kez; HEPGO app.css + SIMUMAV power.css kurallarını tema özniteliğiyle ezer) ----------------------------------------------------------------
// Seçici özgüllüğü: .fs-stage .fs-gauges[data-gtheme=x] (SIMUMAV .fs-gauges.sm-game ve html[data-theme=dark] .fs-gauges kurallarının önünde).
const D = 'html[data-theme="dark"] .fs-stage';
const CSS = `
.fs-gauge-bar{display:none}
/* ---------- Uçak kokpiti ---------- */
.fs-stage .fs-gauges[data-gtheme="cockpit"]{--fsg-face:#0b0d10;--fsg-ring:#2c3036;--fsg-edge:#6b7280;--fsg-tick:#f4f4f4;--fsg-tick2:#b9bec6;--fsg-num:#f4f4f4;--fsg-needle:#ffffff;--fsg-pin:#1a1d22;--fsg-pin2:#9ca3af;--fsg-digit:#ffffff;--fsg-unit:#c9cdd4;--fsg-ico:#c9cdd4;--fsg-red:#ef4444;--fsg-blue:#38bdf8;font-family:"B612","Bahnschrift","DIN Alternate","Roboto Condensed","Arial Narrow",system-ui,sans-serif}
${D} .fs-gauges[data-gtheme="cockpit"],.fs-stage .fs-gauges.sm-game[data-gtheme="cockpit"]{--fsg-num:#ffe7b8;--fsg-tick:#ffe7b8;--fsg-digit:#ffefcc;--fsg-unit:#e8c88f;--fsg-ring:#25282d}
.fs-stage .fs-gauges[data-gtheme="cockpit"] .fs-gauge-ring{stroke-width:7;stroke:var(--fsg-ring);stroke-linecap:butt}
.fs-stage .fs-gauges[data-gtheme="cockpit"] .fs-gauge-face{stroke-width:1.4}
.fs-stage .fs-gauges[data-gtheme="cockpit"] .fs-gauge-num{font-weight:700;font-size:7.4px;letter-spacing:0}
.fs-stage .fs-gauges[data-gtheme="cockpit"] .fs-gauge.small .fs-gauge-num{font-size:8px}
.fs-stage .fs-gauges[data-gtheme="cockpit"] .fs-gauge-tick.major{stroke-width:2}
.fs-stage .fs-gauges[data-gtheme="cockpit"] .fs-gauge-main{font-weight:700;letter-spacing:.02em}
.fs-stage .fs-gauges[data-gtheme="cockpit"] .fs-gauge-dial{filter:drop-shadow(0 6px 12px rgba(0,0,0,.55))}
.fs-stage .fs-gauges[data-gtheme="cockpit"] .fs-gauge-lbl{letter-spacing:.24em;font-weight:800}
.fs-stage .fs-gauges[data-gtheme="cockpit"] .fs-gauge[data-g] { --fsg-ring:#2c3036; --fsg-edge:#6b7280 }
/* ---------- Minimal / şeffaf (HUD) ---------- */
.fs-stage .fs-gauges[data-gtheme="minimal"]{--fsg-face:rgba(10,18,28,.2);--fsg-ring:transparent;--fsg-edge:rgba(255,255,255,.8);--fsg-tick:rgba(255,255,255,.95);--fsg-tick2:rgba(255,255,255,.45);--fsg-num:rgba(255,255,255,.9);--fsg-needle:#ffffff;--fsg-pin:#ffffff;--fsg-pin2:transparent;--fsg-digit:#ffffff;--fsg-unit:rgba(255,255,255,.75);--fsg-ico:rgba(255,255,255,.8);--fsg-red:#ff6b5e;--fsg-blue:#5cc8ff}
${D} .fs-gauges[data-gtheme="minimal"],.fs-stage .fs-gauges.sm-game[data-gtheme="minimal"]{--fsg-face:rgba(0,0,0,.26);--fsg-edge:rgba(160,255,210,.75);--fsg-tick:rgba(190,255,225,.95);--fsg-needle:#c8ffe4;--fsg-pin:#c8ffe4;--fsg-digit:#e9fff4;--fsg-num:rgba(200,255,228,.85)}
.fs-stage .fs-gauges[data-gtheme="minimal"] .fs-gauge[data-g]{--fsg-ring:transparent}
.fs-stage .fs-gauges[data-gtheme="minimal"] .fs-gauge-ring{display:none}
.fs-stage .fs-gauges[data-gtheme="minimal"] .fs-gauge-face{stroke-width:.7;stroke:var(--fsg-edge)}
.fs-stage .fs-gauges[data-gtheme="minimal"] .fs-gauge-tick:not(.major){display:none}
.fs-stage .fs-gauges[data-gtheme="minimal"] .fs-gauge-tick.major{stroke-width:1}
.fs-stage .fs-gauges[data-gtheme="minimal"] .fs-gauge-zone{stroke-width:1.6}
.fs-stage .fs-gauges[data-gtheme="minimal"] .fs-gauge-needle path{transform:scaleX(.45);transform-box:fill-box;transform-origin:center;filter:drop-shadow(0 0 1.5px rgba(0,0,0,.8))}
.fs-stage .fs-gauges[data-gtheme="minimal"] .fs-gauge-pin{r:2.2}
.fs-stage .fs-gauges[data-gtheme="minimal"] .fs-gauge-pin2{display:none}
.fs-stage .fs-gauges[data-gtheme="minimal"] .fs-gauge-dial{filter:none}
.fs-stage .fs-gauges[data-gtheme="minimal"] .fs-gauge-num,.fs-stage .fs-gauges[data-gtheme="minimal"] .fs-gauge-tick{filter:drop-shadow(0 0 1px rgba(0,0,0,.9))}
.fs-stage .fs-gauges[data-gtheme="minimal"] .fs-gauge-main{font-weight:600;text-shadow:0 1px 3px rgba(0,0,0,.85)}
.fs-stage .fs-gauges[data-gtheme="minimal"] .fs-gauge-unit{text-shadow:0 1px 2px rgba(0,0,0,.8)}
.fs-stage .fs-gauges[data-gtheme="minimal"] .fs-gauge[data-level="crit"] .fs-gauge-face,.fs-stage .fs-gauges[data-gtheme="minimal"] .fs-gauge.warn .fs-gauge-face{animation:none;stroke:var(--fsg-red);stroke-width:1.4}
/* ---------- Retro askerî ---------- */
.fs-stage .fs-gauges[data-gtheme="military"]{--fsg-face:#1c2417;--fsg-ring:#3d4a2f;--fsg-edge:#56653f;--fsg-tick:#a9f06a;--fsg-tick2:#5f7d3c;--fsg-num:#b8f27a;--fsg-needle:#dcffb0;--fsg-pin:#2b3524;--fsg-pin2:#a9f06a;--fsg-digit:#c8ff8c;--fsg-unit:#8fbf5c;--fsg-ico:#8fbf5c;--fsg-red:#f97316;--fsg-blue:#facc15;font-family:"Courier New",ui-monospace,SFMono-Regular,Menlo,monospace}
${D} .fs-gauges[data-gtheme="military"],.fs-stage .fs-gauges.sm-game[data-gtheme="military"]{--fsg-face:#141b11;--fsg-ring:#323d26}
.fs-stage .fs-gauges[data-gtheme="military"] .fs-gauge[data-g]{--fsg-ring:#3d4a2f;--fsg-edge:#56653f}
.fs-stage .fs-gauges[data-gtheme="military"] .fs-gauge-ring{stroke-width:6;stroke-linecap:butt}
.fs-stage .fs-gauges[data-gtheme="military"] .fs-gauge-face{stroke-width:1.6}
.fs-stage .fs-gauges[data-gtheme="military"] .fs-gauge-num,.fs-stage .fs-gauges[data-gtheme="military"] .fs-gauge-needle path,.fs-stage .fs-gauges[data-gtheme="military"] .fs-gauge-tick.major{filter:drop-shadow(0 0 1.2px rgba(169,240,106,.85))}
.fs-stage .fs-gauges[data-gtheme="military"] .fs-gauge-num{font-weight:700;font-size:7px}
.fs-stage .fs-gauges[data-gtheme="military"] .fs-gauge-main{font-weight:700;text-shadow:0 0 6px rgba(169,240,106,.55)}
.fs-stage .fs-gauges[data-gtheme="military"] .fs-gauge-dial{filter:drop-shadow(0 6px 12px rgba(0,0,0,.5))}
.fs-stage .fs-gauges[data-gtheme="military"] .fs-gauge-lbl{color:#d9f99d;letter-spacing:.22em}
.fs-stage .fs-gauges[data-gtheme="military"] .fs-gauge[data-level="low"] .fs-gauge-main{color:#facc15}
/* ---------- Dijital cam kokpit (MFD karoları) ---------- */
.fs-stage .fs-gauges[data-gtheme="glass"]{gap:6px;align-items:flex-end;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;--gl-bg:rgba(6,12,22,.8);--gl-bd:rgba(56,232,255,.42);--gl-lbl:#7dd3fc;--gl-val:#ffffff;--gl-unit:#22d3ee;--gl-track:rgba(255,255,255,.14);--gl-ok:#22c55e;--gl-sub:#cbd5e1}
html:not([data-theme="dark"]) .fs-stage .fs-gauges[data-gtheme="glass"]:not(.sm-game){--gl-bg:rgba(250,252,255,.88);--gl-bd:rgba(3,105,161,.45);--gl-lbl:#0369a1;--gl-val:#0b1220;--gl-unit:#0e7490;--gl-track:rgba(15,23,42,.12);--gl-ok:#16a34a;--gl-sub:#ffffff}
.fs-stage .fs-gauges[data-gtheme="glass"] .fs-gauge.big{width:132px}.fs-stage .fs-gauges[data-gtheme="glass"] .fs-gauge.small{width:104px;margin-bottom:0}
.fs-stage .fs-gauges[data-gtheme="glass"] .fs-gauge-dial{aspect-ratio:auto;height:62px;border-radius:7px;background:var(--gl-bg);border:1px solid var(--gl-bd);box-shadow:0 8px 20px rgba(0,0,0,.35),inset 0 1px 0 rgba(255,255,255,.06);filter:none;backdrop-filter:blur(6px)}
.fs-stage .fs-gauges[data-gtheme="glass"] .fs-gauge.big .fs-gauge-dial{height:72px}
.fs-stage .fs-gauges[data-gtheme="glass"] .fs-gauge-dial svg{display:none}
.fs-stage .fs-gauges[data-gtheme="glass"] .fs-gauge-ico{left:auto;right:6px;top:6px;width:13px;height:13px;transform:none;color:var(--gl-lbl)}
.fs-stage .fs-gauges[data-gtheme="glass"] .fs-gauge-digits{left:8px;right:8px;top:auto;bottom:15px;flex-direction:row;align-items:baseline;justify-content:flex-end;gap:4px}
.fs-stage .fs-gauges[data-gtheme="glass"] .fs-gauge-main{color:var(--gl-val);font-size:22px;font-weight:700;letter-spacing:-.01em}
.fs-stage .fs-gauges[data-gtheme="glass"] .fs-gauge.big .fs-gauge-main{font-size:30px}
.fs-stage .fs-gauges[data-gtheme="glass"] .fs-gauge-unit{order:-1;margin:0 auto 0 0;color:var(--gl-unit);font-size:8px;letter-spacing:.08em}
.fs-stage .fs-gauges[data-gtheme="glass"] .fs-gauge.big .fs-gauge-unit{font-size:9px}
.fs-stage .fs-gauges[data-gtheme="glass"] .fs-gauge-bar{display:block;position:absolute;left:8px;right:8px;bottom:7px;height:5px;border-radius:3px;background:var(--gl-track);overflow:hidden}
.fs-stage .fs-gauges[data-gtheme="glass"] .fs-gauge-bar i{display:block;height:100%;width:calc(var(--f,0) * 100%);border-radius:3px;background:var(--gl-ok);transition:width .25s ease-out,background .3s}
.fs-stage .fs-gauges[data-gtheme="glass"] .fs-gauge[data-g="speed"] .fs-gauge-bar i,.fs-stage .fs-gauges[data-gtheme="glass"] .fs-gauge[data-g="engine"] .fs-gauge-bar i{background:linear-gradient(90deg,#0ea5e9,#22d3ee)}
.fs-stage .fs-gauges[data-gtheme="glass"] .fs-gauge[data-level="low"] .fs-gauge-bar i{background:#f59e0b}
.fs-stage .fs-gauges[data-gtheme="glass"] .fs-gauge[data-level="crit"] .fs-gauge-bar i,.fs-stage .fs-gauges[data-gtheme="glass"] .fs-gauge[data-level="empty"] .fs-gauge-bar i,.fs-stage .fs-gauges[data-gtheme="glass"] .fs-gauge.warn .fs-gauge-bar i{background:#ef4444}
.fs-stage .fs-gauges[data-gtheme="glass"] .fs-gauge[data-level="crit"] .fs-gauge-dial,.fs-stage .fs-gauges[data-gtheme="glass"] .fs-gauge.warn .fs-gauge-dial{border-color:#ef4444;animation:fs-gl-warn 1s ease-in-out infinite}
.fs-stage .fs-gauges[data-gtheme="glass"] .fs-gauge[data-level="crit"] .fs-gauge-main,.fs-stage .fs-gauges[data-gtheme="glass"] .fs-gauge.warn .fs-gauge-main{color:#f87171}
.fs-stage .fs-gauges[data-gtheme="glass"] .fs-gauge[data-level="low"] .fs-gauge-main{color:#fbbf24}
.fs-stage .fs-gauges[data-gtheme="glass"] .fs-gauge-sub{top:auto;bottom:-15px;font-size:9.5px;color:var(--gl-sub)}
.fs-stage .fs-gauges[data-gtheme="glass"] .fs-gauge-lbl{position:absolute;left:8px;top:7px;margin:0;font-size:8px;letter-spacing:.12em;color:var(--gl-lbl);text-shadow:none;pointer-events:none}
.fs-stage .fs-gauges[data-gtheme="glass"] .fs-gauge{padding-bottom:16px}
.fs-stage .fs-gauges[data-gtheme="glass"] .fs-gauge-badge{top:-9px}
.fs-stage .fs-gauges[data-gtheme="glass"].no-fuel::before{margin:0 6px 30px 0}
@keyframes fs-gl-warn{50%{box-shadow:0 0 0 2px rgba(239,68,68,.55),0 8px 20px rgba(0,0,0,.35)}}
/* ---------- uçuş içi seçici (kadran ayrıntı kutusu) + sihirbaz kartları ---------- */
.fs-gt-row{display:flex;flex-wrap:wrap;align-items:center;gap:4px;margin-top:8px;padding-top:8px;border-top:1px solid var(--border,rgba(127,140,160,.25))}
.fs-gt-row > span{font-size:10px;font-weight:700;letter-spacing:.12em;color:var(--muted,#94a3b8);margin-right:4px;text-transform:uppercase}
.fs-gt-row button{padding:3px 8px;border-radius:999px;border:1px solid var(--border,rgba(127,140,160,.35));background:transparent;color:inherit;font:600 11px system-ui,sans-serif;cursor:pointer}
.fs-gt-row button.on{background:var(--primary,#0ea5e9);border-color:var(--primary,#0ea5e9);color:#fff}
.fs-gt-wiz{margin-top:18px;padding-top:14px;border-top:1px solid var(--border,rgba(127,140,160,.25))}
.fs-gt-pick{display:flex;flex-direction:column;gap:8px}
.fs-gt-pick h4{margin:0;font-size:14px}
.fs-gt-pick .fs-gt-sub{margin:0;font-size:12px;opacity:.75}
.fs-gt-cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:10px}
.fs-gt-card{display:flex;flex-direction:column;gap:5px;padding:7px;border-radius:12px;border:1.5px solid rgba(127,140,160,.3);background:rgba(127,140,160,.06);color:inherit;font:inherit;text-align:left;cursor:pointer;transition:border-color .15s,transform .15s,box-shadow .15s}
.fs-gt-card:hover{transform:translateY(-1px);border-color:rgba(14,165,233,.6)}
.fs-gt-card.on{border-color:#0ea5e9;box-shadow:0 0 0 3px rgba(14,165,233,.18);background:rgba(14,165,233,.08)}
.fs-gt-card svg{display:block;width:100%;height:auto;border-radius:8px}
.fs-gt-card b{font-size:12.5px}
.fs-gt-card small{font-size:11px;opacity:.72;line-height:1.3}
`;
export function ensureGaugeThemeCss() {
  if (typeof document === 'undefined' || document.getElementById('fs-gtheme-css')) return;
  const st = document.createElement('style'); st.id = 'fs-gtheme-css'; st.textContent = CSS; document.head.append(st);
}

/**
 * Sihirbaz bölümü: önizlemeli tema kartları. opts { tr, keyed, value, onChange(theme), dark? () → bool (önizleme gece renkleri) }.
 * Seçim kalıcı tercihe yazılır (saveGaugeTheme). Dönüş { el, value, set(v), redraw() }.
 */
export function createGaugeThemePicker({ tr = null, keyed = false, value = null, onChange = () => {}, dark = null, game = false, storage = null, title = true } = {}) {
  ensureGaugeThemeCss();
  const T = makeGThemeT(tr, keyed);
  let cur = normGaugeTheme(value ?? loadGaugeTheme(storage));
  const isDark = () => (typeof dark === 'function' ? !!dark() : typeof document !== 'undefined' && document.documentElement.getAttribute('data-theme') === 'dark');
  const mk = (tag, cls, txt) => { const e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; };
  const root = mk('div', 'fs-gt-pick');
  if (title) root.append(mk('h4', null, T('gtheme.title')), mk('p', 'fs-gt-sub', T('gtheme.sub')));
  const grid = mk('div', 'fs-gt-cards');
  const cards = GAUGE_THEMES.map(([k]) => {
    const b = mk('button', 'fs-gt-card'); b.type = 'button'; b.dataset.gtheme = k;
    const pv = mk('span'); pv.innerHTML = gaugeThemePreviewSvg(k, { dark: isDark(), game });
    b.append(pv, mk('b', null, T(`gtheme.${k}`)), mk('small', null, T(`gtheme.${k}_desc`)));
    b.addEventListener('click', () => set(k, true));
    return b;
  });
  grid.append(...cards); root.append(grid);
  function sync() { cards.forEach(b => { const on = b.dataset.gtheme === cur; b.classList.toggle('on', on); b.setAttribute('aria-pressed', String(on)); }); }
  function set(v, user = false) { cur = normGaugeTheme(v); if (user) saveGaugeTheme(cur, storage); sync(); if (user) onChange(cur); }
  sync();
  return { el: root, get value() { return cur; }, set, redraw() { const d = isDark(); cards.forEach(b => { b.firstChild.innerHTML = gaugeThemePreviewSvg(b.dataset.gtheme, { dark: d, game }); }); } };
}
