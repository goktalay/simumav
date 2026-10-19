// Küçük DOM yardımcıları (HEPGO ui.js h() kalıbı; inline stil/script kullanılmaz).
export function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k === 'cssVars') for (const [n, val] of Object.entries(v)) el.style.setProperty(`--${n}`, val);
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, v);
  }
  append(el, children);
  return el;
}
export function append(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}
export function clear(el, ...children) { el.replaceChildren(); append(el, children); return el; }
export const svg = (viewBox, inner, cls) => {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('viewBox', viewBox); if (cls) s.setAttribute('class', cls);
  s.innerHTML = inner; return s;
};
export const PLUS_SVG = '<path fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" d="M12 4v16M4 12h16"/>';
export const fmtDate = (iso, lang) => { try { return new Date(iso).toLocaleString(lang || undefined, { dateStyle: 'medium', timeStyle: 'short' }); } catch { return iso || ''; } };
export const fmtDur = s => { s = Math.max(0, Math.round(s || 0)); const m = Math.floor(s / 60), r = s % 60; return `${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`; };
// Fare parlaması: kartın --mx/--my değişkenlerini güncelle
export function glow(card) {
  card.addEventListener('pointermove', e => { const r = card.getBoundingClientRect(); card.style.setProperty('--mx', `${((e.clientX - r.left) / r.width) * 100}%`); card.style.setProperty('--my', `${((e.clientY - r.top) / r.height) * 100}%`); });
  return card;
}
