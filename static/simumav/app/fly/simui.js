// SIMUMAV — HEPGO `static/js/ui.js` yerine İNCE yönlendirme (docs/simumav.md §2: route `/ui.js` → bu dosya).
// HEPGO simülatör modülleri (flightsim_panel.js, flightsim_record.js, flightsim_report.js …) `../ui.js` içe aktarır; /sim mount'u altında bu
// `/ui.js`'e çözülür. HEPGO ui.js uygulama kabuğuna (fa-icons, segicons, icons, i18n katalogları, #view) bağlıdır → burada yalnız simülatörün
// kullandığı dışa aktarımlar, aynı imzalarla: h, clear, toast, toastError, modal, confirmDialog, field, fmtDateTime, fmtDuration, t, segmented,
// goBack, onLeave, pref, setPref. Pencereler/bildirimler body'ye eklenir (tam ekran document.documentElement'te → görünür).
// Çeviri: globalThis.__smT (oyun kabuğunun i18n'i) varsa o; yoksa yer tutucu değişimi ({n}) ile Türkçe metin aynen.
const interp = (s, p) => (p ? String(s).replace(/\{(\w+)\}/g, (m, k) => (p[k] != null ? String(p[k]) : m)) : String(s));
export const t = (s, p) => (typeof globalThis.__smT === 'function' ? globalThis.__smT(s, p) : interp(s, p));
const I18N_ATTRS = new Set(['placeholder', 'title', 'aria-label']);
const BAD_URL = /^(javascript|vbscript|data):/i;

export function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'html') el.innerHTML = v;
    else if (v === true) el.setAttribute(k, '');
    else if (I18N_ATTRS.has(k) && typeof v === 'string') el.setAttribute(k, t(v));
    else if ((k === 'href' || k === 'src') && BAD_URL.test(String(v).trim())) el.setAttribute(k, '#');
    else el.setAttribute(k, v);
  }
  append(el, children);
  return el;
}
function append(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    if (c instanceof Node) { el.append(c); continue; }
    el.append(document.createTextNode(typeof c === 'string' ? t(c) : String(c)));
  }
}
export function clear(el, ...children) { el.replaceChildren(); append(el, children); return el; }

let toastBox = null;
export function toast(message, type = '') {
  if (!toastBox || !toastBox.isConnected) toastBox = document.body.appendChild(h('div', { class: 'toasts sm-fly' }));
  const el = toastBox.appendChild(h('div', { class: `toast ${type}` }, message));
  setTimeout(() => el.remove(), type === 'err' ? 6000 : 3500);
}
export const toastError = err => toast(err?.message || String(err), 'err');

export function modal({ title, body, actions = [], wide = false, onClose }) {
  const foot = h('div', { class: 'modal-foot' });
  const box = h('div', { class: `modal ${wide ? 'wide' : ''}`, role: 'dialog', 'aria-modal': 'true' },
    h('div', { class: 'modal-head' }, h('h2', null, title), h('button', { class: 'x-btn', type: 'button', 'aria-label': 'Kapat', onclick: () => close() }, '×')),
    h('div', { class: 'modal-body' }, body), actions.length ? foot : null);
  const back = h('div', { class: 'modal-back sm-fly' }, box);
  back.addEventListener('mousedown', e => { if (e.target === back) close(); });
  const onKey = e => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  window.addEventListener('hashchange', close, { once: true });
  let closed = false;
  function close() { if (closed) return; closed = true; back.remove(); document.removeEventListener('keydown', onKey); window.removeEventListener('hashchange', close); onClose?.(); }
  for (const a of actions) {
    if (a === 'spacer') { foot.append(h('span', { class: 'spacer' })); continue; }
    const b = h('button', { class: `btn ${a.class || ''}`, type: 'button' }, a.label);
    b.addEventListener('click', async () => {
      if (!a.onClick) return close();
      b.disabled = true;
      try { const keep = await a.onClick({ close, button: b }); if (keep !== true) close(); } catch (err) { toastError(err); } finally { b.disabled = false; }
    });
    foot.append(b);
  }
  document.body.append(back);
  box.querySelector('input, select, textarea')?.focus();
  return { close, el: box };
}
export function confirmDialog(title, message, { okLabel = 'Onayla', danger = false } = {}) {
  return new Promise(resolve => {
    let answered = false;
    modal({ title, body: h('p', { style: { margin: 0 } }, message), onClose: () => { if (!answered) resolve(false); },
      actions: [{ label: 'Vazgeç' }, { label: okLabel, class: danger ? 'danger' : 'primary', onClick: () => { answered = true; resolve(true); } }] });
  });
}
export function field(label, control, hint) { return h('div', { class: 'field' }, h('label', null, label), control, hint ? h('div', { class: 'hint' }, hint) : null); }
export function segmented(options, value, onChange, { tabs = false } = {}) {
  const seg = h('div', { class: `seg ${tabs ? 'seg-tabs' : ''}` });
  for (const [k, label] of options) seg.append(h('button', { type: 'button', class: k === value ? 'on' : '', 'data-k': k, onclick: () => { seg.querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.k === k)); onChange?.(k); } }, label));
  return seg;
}
const pad = n => String(n).padStart(2, '0');
export function fmtDateTime(iso) { if (!iso) return '—'; const d = new Date(iso); return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`; }
export function fmtDate(iso) { if (!iso) return '—'; const [y, m, d] = String(iso).slice(0, 10).split('-'); return `${d}.${m}.${y}`; }
export function fmtDuration(sec) {
  if (sec === null || sec === undefined) return '—';
  sec = Math.max(0, Math.floor(sec));
  const d = Math.floor(sec / 86400), hh = Math.floor(sec % 86400 / 3600), mm = Math.floor(sec % 3600 / 60), ss = sec % 60;
  if (d) return `${d} g ${hh} sa ${mm} dk`;
  if (hh) return `${hh} sa ${mm} dk`;
  return `${mm} dk ${pad(ss)} sn`;
}
export function goBack(fallback = '#/') { if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {}); location.hash = fallback; return false; }
const leave = new Set();
export function onLeave(fn) { leave.add(fn); }
export function runLeave() { for (const fn of [...leave]) { leave.delete(fn); try { fn(); } catch { /* */ } } }
if (typeof window !== 'undefined') window.addEventListener('hashchange', runLeave);
export function pref(key, fallback) { try { const v = localStorage.getItem(`sm.${key}`); return v == null ? fallback : JSON.parse(v); } catch { return fallback; } }
export function setPref(key, value) { try { localStorage.setItem(`sm.${key}`, JSON.stringify(value)); } catch { /* */ } }
export const statStrip = () => h('div', { class: 'stat-strip' });
export const avatar = () => h('span', { class: 'avatar' });

// replay3d.js (`pageHead`) içe aktarır: HEPGO sayfa başlığı — SIMUMAV'da kabuk başlığı yok, yalın başlık bloğu (çekirdek ajanı eklemesi; Cesium replay 2B'ye düşmesin)
export function pageHead(title, { back, sub, right } = {}) {
  return h('div', { class: 'page-head sm-page-head' }, back ? h('a', { class: 'back', href: back, 'aria-label': 'Geri' }, '←') : null,
    h('div', { class: 'page-head-t' }, h('h1', null, title), sub ? h('div', { class: 'sub' }, sub) : null), h('div', { class: 'spacer' }), right || null);
}
