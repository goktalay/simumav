// Uçuş Simülatörü §27.1 — sanal kumanda HASSASİYETİ (HEPGO flightsim.js virtualRC + SIMUMAV fly/rc.js ortak; docs/ucus-simulatoru.md §27.1).
// Eksen başına üç ayar: hassasiyet (oran, % 30–100: tam çubukta çıkışın üst sınırı), expo (% 0–90: merkezde yumuşaklık, uçta tam çıkış) ve
// ölü bölge (% 0–20: merkez çevresinde tepkisiz alan; dışarısı 0…1'e yeniden ölçeklenir). Eğri kumandanın ÇIKIŞINA (kanal PWM'i) uygulanır →
// sanal çubuk, klavye (WASD/oklar) ve ileride eklenecek gamepad aynı eğriden geçer (tutarlı). Uçakta gaz tutmalı ve tek yönlü (−1 = rölanti)
// olduğundan gaz eğrisi YALNIZ kopter ailesinde (merkez = askı) uygulanır; uçakta gaz doğrusal kalır.
// Kalıcı tercih: localStorage `fs.rc.feel` (oturumlar arası; dron tipinden bağımsız). Sihirbazda ayar yok; uçuşta küçük panel (⚙ Hassasiyet).
// Saf kısım (tests/test_flightsim_flyui.mjs): RCFEEL_*, normFeel, shapeAxis, makeShaper, curvePoints, presetOf, loadFeel/saveFeel.
// DOM kısmı: createRcFeelPanel (kendi CSS'ini bir kez ekler). Metinler RCFEEL_TEXTS [anahtar, Türkçe] — HEPGO'da Türkçe metin sözlük anahtarı,
// SIMUMAV'da `rcfeel.*` (keyed=true; i18n 7 dil; anahtar yoksa Türkçeye düşer).

export const RC_AXES = ['roll', 'pitch', 'yaw', 'thr'];
export const RCFEEL_LIMITS = { rate: [30, 100], expo: [0, 90], dead: [0, 20] };
export const RCFEEL_KEY = 'fs.rc.feel';
// Hazır ayarlar: Hassas (yeni başlayan / kamera çekimi), Normal (varsayılan), Çevik (yarış / akro)
export const RCFEEL_PRESETS = {
  soft: { roll: { rate: 70, expo: 45, dead: 4 }, pitch: { rate: 70, expo: 45, dead: 4 }, yaw: { rate: 60, expo: 40, dead: 5 }, thr: { rate: 100, expo: 30, dead: 4 } },
  normal: { roll: { rate: 100, expo: 20, dead: 3 }, pitch: { rate: 100, expo: 20, dead: 3 }, yaw: { rate: 90, expo: 20, dead: 4 }, thr: { rate: 100, expo: 10, dead: 3 } },
  sport: { roll: { rate: 100, expo: 0, dead: 2 }, pitch: { rate: 100, expo: 0, dead: 2 }, yaw: { rate: 100, expo: 5, dead: 2 }, thr: { rate: 100, expo: 0, dead: 2 } },
};
export const RCFEEL_DEFAULTS = RCFEEL_PRESETS.normal;
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const num = (v, d) => (v == null || v === '' || !Number.isFinite(Number(v)) ? d : Number(v));

/** Eksik/bozuk değerler varsayılana, aralık dışı sınıra; tam sayıya yuvarlanır. Dönüş her zaman dört eksenli yeni nesne. */
export function normFeel(o) {
  const out = {};
  for (const a of RC_AXES) {
    const src = (o && typeof o === 'object' ? o[a] : null) || {}, d = RCFEEL_DEFAULTS[a];
    out[a] = {};
    for (const k of Object.keys(RCFEEL_LIMITS)) { const [lo, hi] = RCFEEL_LIMITS[k]; out[a][k] = Math.round(clamp(num(src[k], d[k]), lo, hi)); }
  }
  return out;
}

/** Tek eksen eğrisi: v ∈ [−1, 1] → ölü bölge (yeniden ölçekli) → expo (y = (1−e)·x + e·x³) → oran. Tek fonksiyon, işaret korunur, |çıkış| ≤ oran. */
export function shapeAxis(v, { rate = 100, expo = 0, dead = 0 } = {}) {
  const x0 = clamp(num(v, 0), -1, 1), s = Math.sign(x0), m = Math.abs(x0), d = clamp(num(dead, 0), 0, 50) / 100;
  if (m <= d) return 0;
  const x = d > 0 ? (m - d) / (1 - d) : m, e = clamp(num(expo, 0), 0, 100) / 100;
  const y = (1 - e) * x + e * x * x * x;
  return s * y * clamp(num(rate, 100), 0, 100) / 100;
}

/** Kumanda çıkışı için şekillendirici: (eksen, v) → v'. plane: gaz doğrusal (tutmalı, −1…1 = rölanti…tam). feel null → kimlik. */
export function makeShaper(feel, { plane = false } = {}) {
  const f = normFeel(feel);
  return (axis, v) => (axis === 'thr' && plane ? clamp(num(v, 0), -1, 1) : f[axis] ? shapeAxis(v, f[axis]) : v);
}

/** Eğri önizlemesi için n+1 nokta [x, y] (x −1…1). */
export function curvePoints(cfg, n = 40) {
  const out = [];
  for (let i = 0; i <= n; i++) { const x = -1 + 2 * i / n; out.push([Math.round(x * 1000) / 1000, Math.round(shapeAxis(x, cfg) * 1000) / 1000]); }
  return out;
}

/** Ayar bir hazır ayarla birebir aynıysa onun adı ('soft' | 'normal' | 'sport'), değilse 'custom'. */
export function presetOf(feel) {
  const f = normFeel(feel);
  for (const [k, p] of Object.entries(RCFEEL_PRESETS)) if (RC_AXES.every(a => ['rate', 'expo', 'dead'].every(q => f[a][q] === p[a][q]))) return k;
  return 'custom';
}

const lsOf = storage => storage || (typeof localStorage !== 'undefined' ? localStorage : null);
export function loadFeel(storage = null) {
  const st = lsOf(storage);
  try { const raw = st?.getItem(RCFEEL_KEY); return normFeel(raw ? JSON.parse(raw) : null); } catch { return normFeel(null); }
}
export function saveFeel(feel, storage = null) {
  const f = normFeel(feel);
  try { lsOf(storage)?.setItem(RCFEEL_KEY, JSON.stringify(f)); } catch { /* özel kip */ }
  return f;
}

// ---------------------------------------------------------------- metinler ----------------------------------------------------------------
export const RCFEEL_TEXTS = [
  ['rcfeel.btn', 'Hassasiyet'], ['rcfeel.btn_title', 'Kumanda hassasiyeti: eksen başına oran, expo ve ölü bölge (klavye ve sanal çubuk)'],
  ['rcfeel.title', 'Kumanda hassasiyeti'], ['rcfeel.close', 'Kapat'],
  ['rcfeel.p_soft', 'Hassas'], ['rcfeel.p_normal', 'Normal'], ['rcfeel.p_sport', 'Çevik'], ['rcfeel.p_custom', 'Özel'],
  ['rcfeel.roll', 'Roll'], ['rcfeel.pitch', 'Pitch'], ['rcfeel.yaw', 'Yaw'], ['rcfeel.thr', 'Gaz'],
  ['rcfeel.rate', 'Hassasiyet'], ['rcfeel.expo', 'Expo'], ['rcfeel.dead', 'Ölü bölge'],
  ['rcfeel.rate_hint', 'Tam çubukta en çok çıkış'], ['rcfeel.expo_hint', 'Merkezde yumuşaklık'], ['rcfeel.dead_hint', 'Merkezde tepkisiz alan'],
  ['rcfeel.all', 'Roll ve pitch birlikte'], ['rcfeel.reset', 'Varsayılan'],
  ['rcfeel.plane_thr', 'Uçakta gaz doğrusaldır (tutmalı gaz kolu)'],
  ['rcfeel.note', 'Sanal çubuk ve klavye aynı eğriden geçer; ayar bu tarayıcıda saklanır.'],
];
const TXT = Object.fromEntries(RCFEEL_TEXTS);
const fill = (s, p) => (p ? String(s).replace(/\{(\w+)\}/g, (m, k) => (p[k] != null ? String(p[k]) : m)) : String(s));
export const makeRcFeelT = (tr, keyed = false) => (k, p) => {
  const tx = TXT[k] ?? k;
  if (!tr) return fill(tx, p);
  if (!keyed) return tr(tx, p);
  const r = tr(k, p);
  return r && r !== k ? r : fill(tx, p);
};

// ---------------------------------------------------------------- DOM ----------------------------------------------------------------
function el(tag, attrs, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') e.className = v; else if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2), v); else if (k === 'html') e.innerHTML = v; else e.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat(Infinity)) if (c != null && c !== false) e.append(c.nodeType ? c : document.createTextNode(String(c)));
  return e;
}
const CSS = `
.fs-rcf-btn{display:inline-flex;align-items:center;justify-content:center;gap:5px}
.fs-rcf-btn span{display:inline-grid;place-items:center}
.fs-rcf-btn svg{width:15px;height:15px}
.fs-rcf-btn .fs-rcf-lbl{font-weight:600}
@media (max-width:900px){.fs-rcf-btn .fs-rcf-lbl{display:none}}
.fs-rcf-pop{position:absolute;left:12px;bottom:calc(var(--fs-bar-h,54px) + 10px);width:min(340px,calc(100vw - 24px));pointer-events:auto;z-index:40;padding:12px 14px 10px;border-radius:14px;background:rgba(11,18,32,.92);border:1px solid rgba(255,255,255,.16);color:#e2e8f0;font:13px/1.35 system-ui,-apple-system,"Segoe UI",sans-serif;box-shadow:0 14px 40px rgba(0,0,0,.5);backdrop-filter:blur(10px)}
.fs-rcf-pop[hidden]{display:none}
.fs-rcf-h{display:flex;align-items:center;gap:8px;margin-bottom:8px}
.fs-rcf-h b{flex:1;font-size:13.5px}
.fs-rcf-x{border:0;background:transparent;color:#94a3b8;font-size:18px;line-height:1;cursor:pointer;padding:0 4px;border-radius:6px}
.fs-rcf-x:hover{color:#fff;background:rgba(255,255,255,.1)}
.fs-rcf-seg{display:flex;gap:4px;margin-bottom:8px}
.fs-rcf-seg button{flex:1;padding:5px 4px;border-radius:8px;border:1px solid rgba(255,255,255,.16);background:rgba(255,255,255,.04);color:inherit;font:600 12px system-ui,sans-serif;cursor:pointer}
.fs-rcf-seg button.on{background:#0ea5e9;border-color:#0ea5e9;color:#fff}
.fs-rcf-seg.ax button.on{background:rgba(56,189,248,.22);border-color:rgba(56,189,248,.8);color:#e0f2fe}
.fs-rcf-body{display:grid;grid-template-columns:1fr 104px;gap:10px;align-items:center}
.fs-rcf-sl{display:flex;flex-direction:column;gap:6px}
.fs-rcf-row{display:grid;grid-template-columns:76px 1fr 40px;align-items:center;gap:6px;font-size:12px}
.fs-rcf-row span{color:#cbd5e1}
.fs-rcf-row input[type=range]{width:100%;min-width:0;accent-color:#38bdf8;touch-action:pan-y}
.fs-rcf-row output{font:700 12px ui-monospace,SFMono-Regular,Menlo,monospace;text-align:right;color:#f1f5f9}
.fs-rcf-row[data-off]{opacity:.4;pointer-events:none}
.fs-rcf-cv{width:104px;height:104px;border-radius:10px;background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.1)}
.fs-rcf-cv .g{stroke:rgba(255,255,255,.12);stroke-width:.6}
.fs-rcf-cv .lin{stroke:rgba(255,255,255,.25);stroke-width:.8;stroke-dasharray:2 2;fill:none}
.fs-rcf-cv .cur{stroke:#38bdf8;stroke-width:2;fill:none;stroke-linejoin:round}
.fs-rcf-cv .dz{fill:rgba(251,191,36,.18)}
.fs-rcf-cv .dot{fill:#fbbf24}
.fs-rcf-foot{display:flex;align-items:center;gap:8px;margin-top:8px;font-size:11.5px;color:#94a3b8}
.fs-rcf-foot label{display:flex;align-items:center;gap:5px;cursor:pointer;color:#cbd5e1}
.fs-rcf-foot button{margin-left:auto;padding:4px 10px;border-radius:7px;border:1px solid rgba(255,255,255,.2);background:transparent;color:inherit;cursor:pointer;font:600 11.5px system-ui,sans-serif}
.fs-rcf-foot button:hover{background:rgba(255,255,255,.1);color:#fff}
.fs-rcf-note{margin-top:6px;font-size:11px;color:#94a3b8}
@media (max-width:760px){.fs-rcf-pop{left:50% !important;transform:translateX(-50%);bottom:auto;top:64px}}
`;
export function ensureRcFeelCss() {
  if (typeof document === 'undefined' || document.getElementById('fs-rcfeel-css')) return;
  document.head.append(el('style', { id: 'fs-rcfeel-css' }, CSS));
}
const ICO = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M4 7h10M18 7h2M4 17h4M12 17h8"/><circle cx="16" cy="7" r="2"/><circle cx="10" cy="17" r="2"/></svg>';

/**
 * Uçuş içi hassasiyet paneli. stage: açılır kutunun ekleneceği sahne (.fs-stage; alt çubuğun üstünde, düğmenin hizasında);
 * opts { tr, keyed, plane, storage, btnClass, onChange(feel) }. Düğme (el) çağıran tarafından alt çubuğa (🎮 Sanal kumanda yanına) eklenir.
 * Dönüş { el (düğme), pop, feel (güncel), shaper() → makeShaper, open(v), dispose() }.
 */
export function createRcFeelPanel(stage, { tr = null, keyed = false, plane = false, storage = null, btnClass = 'btn sm', onChange = () => {} } = {}) {
  ensureRcFeelCss();
  const T = makeRcFeelT(tr, keyed);
  let feel = loadFeel(storage), axis = 'roll', link = true, disposed = false;
  const btn = el('button', { class: `${btnClass} fs-rcf-btn`, type: 'button', title: T('rcfeel.btn_title'), 'aria-label': T('rcfeel.title'), 'aria-expanded': 'false', onclick: e => { e.stopPropagation(); open(); } }, el('span', { html: ICO }), el('b', { class: 'fs-rcf-lbl' }, T('rcfeel.btn')));   // açık etiket (yalnız ⚙ fark edilmiyordu); dar ekranda yalnız simge + title
  const presetBtns = ['soft', 'normal', 'sport'].map(k => el('button', { type: 'button', 'data-p': k, onclick: () => { feel = normFeel(RCFEEL_PRESETS[k]); commit(); } }, T(`rcfeel.p_${k}`)));
  const customTag = el('button', { type: 'button', 'data-p': 'custom', disabled: true, tabindex: '-1' }, T('rcfeel.p_custom'));
  const axisBtns = RC_AXES.map(a => el('button', { type: 'button', 'data-a': a, onclick: () => { axis = a; draw(); } }, T(`rcfeel.${a}`)));
  const rows = {};
  const mkRow = key => {
    const [lo, hi] = RCFEEL_LIMITS[key];
    const inp = el('input', { type: 'range', min: lo, max: hi, step: 1, 'aria-label': T(`rcfeel.${key}`) });
    const out = el('output', null, '');
    inp.addEventListener('input', () => {
      const v = Number(inp.value), axes = link && (axis === 'roll' || axis === 'pitch') ? ['roll', 'pitch'] : [axis];
      for (const a of axes) feel[a] = { ...feel[a], [key]: v };
      commit();
    });
    const row = el('label', { class: 'fs-rcf-row', title: T(`rcfeel.${key}_hint`) }, el('span', null, T(`rcfeel.${key}`)), inp, out);
    rows[key] = { row, inp, out };
    return row;
  };
  const svgBox = el('div', { html: '' });
  const linkInp = el('input', { type: 'checkbox', checked: true, onchange: () => { link = linkInp.checked; if (link) { feel.pitch = { ...feel.roll }; commit(); } } });
  const planeNote = el('div', { class: 'fs-rcf-note', hidden: true }, T('rcfeel.plane_thr'));
  const pop = el('div', { class: 'fs-rcf-pop', hidden: true, role: 'dialog', 'aria-label': T('rcfeel.title') },
    el('div', { class: 'fs-rcf-h' }, el('b', null, T('rcfeel.title')), el('button', { class: 'fs-rcf-x', type: 'button', title: T('rcfeel.close'), onclick: () => open(false) }, '×')),
    el('div', { class: 'fs-rcf-seg' }, presetBtns, customTag),
    el('div', { class: 'fs-rcf-seg ax' }, axisBtns),
    el('div', { class: 'fs-rcf-body' }, el('div', { class: 'fs-rcf-sl' }, mkRow('rate'), mkRow('expo'), mkRow('dead')), svgBox),
    planeNote,
    el('div', { class: 'fs-rcf-foot' }, el('label', null, linkInp, T('rcfeel.all')), el('button', { type: 'button', onclick: () => { feel = normFeel(RCFEEL_DEFAULTS); commit(); } }, T('rcfeel.reset'))),
    el('div', { class: 'fs-rcf-note' }, T('rcfeel.note')));
  for (const e of [pop]) for (const t of ['pointerdown', 'keydown', 'wheel']) e.addEventListener(t, ev => ev.stopPropagation());   // panel içi: 3B / kumanda dinleyicilerine gitmesin
  stage.append(pop);
  function curveSvg(c, off) {
    const P = ([x, y]) => `${(52 + x * 46).toFixed(1)},${(52 - y * 46).toFixed(1)}`;
    const pts = curvePoints(c, 48).map(P).join(' ');
    const dz = c.dead / 100 * 46;
    return `<svg class="fs-rcf-cv" viewBox="0 0 104 104" aria-hidden="true"><path class="g" d="M6 52H98M52 6V98"/><path class="lin" d="M6 98L98 6"/>${dz > 0.3 && !off ? `<rect class="dz" x="${(52 - dz).toFixed(1)}" y="6" width="${(2 * dz).toFixed(1)}" height="92"/>` : ''}<polyline class="cur" points="${off ? '6,98 98,6' : pts}"/><circle class="dot" cx="98" cy="${(52 - (off ? 1 : shapeAxis(1, c)) * 46).toFixed(1)}" r="2.6"/></svg>`;
  }
  function draw() {
    const off = plane && axis === 'thr', c = feel[axis];
    const p = presetOf(feel);
    presetBtns.forEach(b => b.classList.toggle('on', b.dataset.p === p)); customTag.classList.toggle('on', p === 'custom'); customTag.hidden = p !== 'custom';
    axisBtns.forEach(b => b.classList.toggle('on', b.dataset.a === axis));
    for (const k of Object.keys(rows)) { rows[k].inp.value = String(c[k]); rows[k].out.textContent = `${c[k]}%`; if (off) rows[k].row.setAttribute('data-off', ''); else rows[k].row.removeAttribute('data-off'); }
    planeNote.hidden = !off;
    svgBox.innerHTML = curveSvg(c, off);
  }
  function commit() { feel = saveFeel(feel, storage); draw(); onChange(feel); }
  const onDoc = e => { if (!pop.hidden && !pop.contains(e.target) && !btn.contains(e.target)) open(false); };
  document.addEventListener('pointerdown', onDoc, true);
  function open(v) {
    const on = v == null ? pop.hidden : !!v;
    pop.hidden = !on; btn.classList.toggle('primary', on); btn.setAttribute('aria-expanded', String(on));
    if (!on) return;
    draw();
    const m = stage.getBoundingClientRect(), b = btn.getBoundingClientRect(), w = pop.offsetWidth || 340;   // düğmenin hizasında, sahne içinde
    pop.style.left = `${Math.round(Math.max(12, Math.min(m.width - w - 12, b.left + b.width / 2 - m.left - w / 2)))}px`;
  }
  draw();
  return {
    el: btn, pop, open,
    get feel() { return normFeel(feel); },
    shaper: () => makeShaper(feel, { plane }),
    dispose() { if (disposed) return; disposed = true; document.removeEventListener('pointerdown', onDoc, true); btn.remove(); pop.remove(); },
  };
}
