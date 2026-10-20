// Uçuş Simülatörü — görsel giriş bileşenleri (docs/ucus-simulatoru.md §6.1). İçe aktarma YOK (Node testinde çalışır: tests/test_fs_inputs.mjs).
// • numSlider: sayısal alan = kaydırıcı (dolu iz) + yanında düzenlenebilir değer kutusu + birim. Doğrusal ya da logaritmik ölçek (geniş aralıklar:
//   yakıt L, km/L, mAh). Değer her zaman [min, max] içine kırpılır ve `step`e oturtulur (eski <input type=number> doğrulamasıyla aynı sınırlar);
//   kutuya "1,5" (virgül) yazılabilir; Enter/odak kaybı uygular, Escape geri alır. Enter sihirbaz "İleri"sine taşınmaz (stopPropagation).
// • Saf yardımcılar: parseNum, clampNum, decimalsOf, snapStep, niceRound, makeScale, fmtNum.
// DOM üretimi `h` (ui.js h — metinleri çevirir) parametresiyle; `h` verilmezse document.createElement.

export const parseNum = s => {
  if (typeof s === 'number') return Number.isFinite(s) ? s : null;
  const t = String(s ?? '').trim().replace(/\s/g, '').replace(',', '.');
  if (!t || !/^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(t)) return null;
  const v = Number(t);
  return Number.isFinite(v) ? v : null;
};
export const clampNum = (v, min, max) => Math.min(max, Math.max(min, v));
// Adımın ondalık basamak sayısı (0.05 → 2, 0.5 → 1, 100 → 0)
export const decimalsOf = step => { const s = String(step); if (/e-/i.test(s)) return Number(s.split(/e-/i)[1]) || 0; const i = s.indexOf('.'); return i < 0 ? 0 : s.length - i - 1; };
const roundTo = (v, d) => { const p = 10 ** d; return Math.round(v * p) / p; };
// min'den başlayarak step katına oturt (kayan nokta artığı temizlenir)
export const snapStep = (v, step, min = 0) => (!(step > 0) ? v : roundTo(min + Math.round((v - min) / step) * step, Math.max(decimalsOf(step), decimalsOf(min))));
// Logaritmik kaydırıcı için "güzel" sayı: 2 anlamlı basamak (10347 → 10000, 4472 → 4500, 7.83 → 7.8)
export const niceRound = (v, sig = 2) => { if (!v) return 0; const e = Math.floor(Math.log10(Math.abs(v))) - (sig - 1); const p = 10 ** e; return roundTo(Math.round(v / p) * p, Math.max(0, -e)); };
// Ölçek: konum p ∈ [0, 1] ↔ değer. 'log': log(v + o) doğrusal (o: min ≤ 0 ise kaydırma; 0 dahil aralıklar için)
export function makeScale({ min, max, scale = 'lin' }) {
  if (scale !== 'log' || !(max > min)) {
    const span = max - min || 1;
    return { log: false, toPos: v => clampNum((v - min) / span, 0, 1), fromPos: p => min + clampNum(p, 0, 1) * span };
  }
  const o = min > 0 ? 0 : (max - min) / 1000 + (min < 0 ? -min : 0);
  const a = Math.log(min + o), b = Math.log(max + o);
  return { log: true, toPos: v => clampNum((Math.log(clampNum(v, min, max) + o) - a) / (b - a), 0, 1), fromPos: p => clampNum(Math.exp(a + clampNum(p, 0, 1) * (b - a)) - o, min, max) };
}
// Kutu metni: adımın basamağıyla, gereksiz sıfırsız (12.50 → 12.5); Türkçe ondalık virgül YOK (input değeri; kopyala-yapıştır uyumu)
export const fmtNum = (v, step = 1) => (v == null || !Number.isFinite(Number(v)) ? '' : String(roundTo(Number(v), Math.max(decimalsOf(step), 0))));
// Kaydırıcı konumu → değer (log ölçekte güzel yuvarlama, ardından step + sınırlar)
export function valueFromPos(p, { min, max, step = 1, scale = 'lin' }) {
  const sc = makeScale({ min, max, scale });
  let v = sc.fromPos(p);
  if (sc.log) v = niceRound(v);
  return clampNum(snapStep(v, step, sc.log ? 0 : min), min, max);
}
// Kutudan gelen metin → geçerli değer (null: geçersiz → eski değer kalır)
export function commitValue(text, { min, max, step = 1, integer = false }) {
  const v = parseNum(text);
  if (v == null) return null;
  let x = clampNum(v, min, max);
  if (integer) x = Math.round(x);
  else if (step > 0) x = clampNum(roundTo(x, Math.max(decimalsOf(step), 2)), min, max);
  return x;
}

const POS_N = 1000;   // log ölçekte kaydırıcı çözünürlüğü
export function numSlider({ h = null, label = '', value, min, max, step = 1, unit = '', scale = 'lin', integer = false, hint = null, fmt = null, cls = '', onInput = () => {}, onChange = () => {} }) {
  const mk = h || ((tag, attrs, ...kids) => { const el = document.createElement(tag); for (const [k, v] of Object.entries(attrs || {})) { if (v == null || v === false) continue; if (k === 'class') el.className = v; else if (k.startsWith('on')) el.addEventListener(k.slice(2), v); else el.setAttribute(k, v === true ? '' : v); } el.append(...kids.flat().filter(c => c != null)); return el; });
  const log = scale === 'log';
  const sc = makeScale({ min, max, scale });
  let val = clampNum(Number.isFinite(Number(value)) ? Number(value) : min, min, max);
  const range = mk('input', { type: 'range', class: 'fs-ns-range', min: log ? 0 : min, max: log ? POS_N : max, step: log ? 1 : step, 'aria-label': typeof label === 'string' ? label : null });
  const box = mk('input', { type: 'text', class: 'fs-ns-in', inputmode: 'decimal', autocomplete: 'off', spellcheck: 'false' });
  const unitEl = unit ? mk('span', { class: 'fs-ns-unit' }, unit) : null;
  const lbl = mk('span', { class: 'fs-ns-lbl' }, label);
  const hintEl = hint ? mk('span', { class: 'fs-ns-hint small muted' }, hint) : null;
  const el = mk('div', { class: `fs-ns ${cls}`.trim() },
    mk('div', { class: 'fs-ns-top' }, lbl, mk('label', { class: 'fs-ns-val' }, box, unitEl)),
    range, hintEl);
  const paint = () => {
    const p = sc.toPos(val);
    range.value = String(log ? Math.round(p * POS_N) : val);
    el.style.setProperty('--p', `${(p * 100).toFixed(2)}%`);
    if (document.activeElement !== box) box.value = fmt ? fmt(val) : fmtNum(val, step);
  };
  range.addEventListener('input', () => {
    val = log ? valueFromPos(Number(range.value) / POS_N, { min, max, step, scale }) : clampNum(snapStep(Number(range.value), step, min), min, max);
    if (integer) val = Math.round(val);
    paint(); onInput(val);
  });
  range.addEventListener('change', () => onChange(val));
  const commit = () => { const v = commitValue(box.value, { min, max, step, integer }); if (v != null) { val = v; onInput(val); onChange(val); } box.value = fmt ? fmt(val) : fmtNum(val, step); paint(); };
  box.addEventListener('change', commit);
  box.addEventListener('blur', commit);
  box.addEventListener('focus', () => box.select());
  box.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); commit(); }
    else if (e.key === 'Escape') { e.stopPropagation(); box.value = fmtNum(val, step); box.blur(); }
    else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      const d = (e.key === 'ArrowUp' ? 1 : -1) * (e.shiftKey ? 10 : 1) * (step || 1);
      val = clampNum(snapStep(val + d, step, log ? 0 : min), min, max); if (integer) val = Math.round(val);
      box.value = fmtNum(val, step); paint(); onInput(val); onChange(val);
    }
  });
  paint();
  return {
    el, range, input: box, label: lbl, hint: hintEl,
    get value() { return val; },
    set(v, { silent = true } = {}) { const n = Number(v); if (!Number.isFinite(n)) return; val = clampNum(n, min, max); if (document.activeElement === box) box.value = fmtNum(val, step); paint(); if (!silent) onInput(val); },
    setLabel(t) { lbl.textContent = t; },
  };
}
