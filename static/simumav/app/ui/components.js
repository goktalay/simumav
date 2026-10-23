// Oyun bileşenleri: büyük kart, devasa "+", yatay seçici, kadran, modal, toast, segment, anahtar, özellik çubukları.
import { h, clear, svg, PLUS_SVG, glow } from '../core/dom.js';
import { t } from '../i18n/i18n.js';
import { splitTitle } from './transition.js';
import * as sfx from './sfx.js';

// ---------- Ekran iskeleti (başlık harf harf sinematik giriş) ----------
export function screen({ title, sub, cls = '' } = {}) {
  const sc = h('div', { class: `screen ${cls}` });
  if (title) sc.append(h('header', { class: 'screen-head' }, splitTitle(h('h1', { class: 'title lg' }, title)), sub ? h('p', { class: 'sub sub-in' }, sub) : null));
  return sc;
}
// Oyun tarzı yükleme: radar süpürmesi + ilerleyen çubuk
export const loading = text => h('div', { class: 'loading radar' }, h('span', { class: 'radar-dish' }, h('i')), h('span', { class: 'ldr-bar' }, h('i')), h('span', { class: 'ldr-text' }, text || t('common.loading')));
// Kart hover sesleri (liste kartları): bir kez bağla
export function hoverSfx(card, kind = 'hover') { card.addEventListener('pointerenter', () => sfx[kind]?.()); return card; }
export const errBox = msg => h('div', { class: 'err-box' }, msg);

// ---------- Büyük kart ----------
export function bigCard({ name, desc, icon, iconFallback, badge, onClick }) {
  const img = h('img', { src: icon, alt: '' });
  if (iconFallback) img.addEventListener('error', () => { if (img.src !== new URL(iconFallback, location.href).href) img.src = iconFallback; }, { once: true });
  const card = h('button', { class: 'card lift big-card', type: 'button', onclick: onClick },
    h('span', { class: 'ico' }, img),
    badge ? h('span', { class: 'badge accent' }, badge) : null,
    h('span', { class: 'name' }, name), desc ? h('span', { class: 'desc' }, desc) : null);
  return glow(card);
}

// ---------- Devasa + ----------
export function plusButton(label, onClick, { small = false } = {}) {
  return h('button', { class: `plus-btn ${small ? 'sm' : ''}`, type: 'button', 'aria-label': label, onclick: onClick }, svg('0 0 24 24', PLUS_SVG), label ? h('span', { class: 'lbl' }, label) : null);
}

// ---------- Düğme ----------
export const btn = (label, onClick, cls = '', attrs = {}) => h('button', { class: `btn ${cls}`, type: 'button', onclick: onClick, ...attrs }, label);
export const miniBtn = (inner, onClick, cls = '', label = '') => h('button', { class: `mini-btn ${cls}`, type: 'button', 'aria-label': label, title: label, onclick: e => { e.stopPropagation(); onClick(e); } }, inner);
export const EDIT_SVG = '<path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="M4 20h4l10-10-4-4L4 16v4zM13 7l4 4"/>';
export const TRASH_SVG = '<path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v6M14 11v6"/>';
export const CHEV_L = '<path fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" d="M15 5l-7 7 7 7"/>';
export const CHEV_R = '<path fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" d="M9 5l7 7-7 7"/>';
export const PLAY_SVG = '<path fill="currentColor" d="M7 5v14l12-7z"/>';
export const PAUSE_SVG = '<path fill="currentColor" d="M6 5h4v14H6zM14 5h4v14h-4z"/>';
export const STAR_SVG = '<path fill="currentColor" d="M12 2l2.9 6.6 7.1.7-5.4 4.8 1.6 7L12 17.4 5.8 21l1.6-7L2 9.3l7.1-.7z"/>';

// ---------- Segment ----------
export function segment(options, value, onChange) {
  const wrap = h('div', { class: 'seg', role: 'radiogroup' });
  const set = v => { value = v; for (const b of wrap.children) b.classList.toggle('on', b.dataset.v === String(v)); };
  for (const o of options) wrap.append(h('button', { type: 'button', role: 'radio', dataset: { v: String(o.value) }, onclick: () => { set(o.value); onChange?.(o.value); } }, o.label));
  set(value);
  wrap.set = set;
  return wrap;
}

// ---------- Anahtar ----------
export function switchEl(on, onChange, label = '') {
  const s = h('button', { class: `switch ${on ? 'on' : ''}`, type: 'button', role: 'switch', 'aria-checked': String(!!on), 'aria-label': label });
  s.addEventListener('click', () => { on = !on; s.classList.toggle('on', on); s.setAttribute('aria-checked', String(on)); onChange?.(on); });
  return s;
}

// ---------- Kaydırıcı ----------
export function range({ min, max, step = 1, value, onInput, format }) {
  const inp = h('input', { class: 'range', type: 'range', min, max, step, value });
  const out = h('b', {}, format ? format(value) : value);
  const upd = () => { const v = Number(inp.value); inp.style.setProperty('--p', `${((v - min) / (max - min)) * 100}%`); out.textContent = format ? format(v) : v; };
  inp.addEventListener('input', () => { upd(); onInput?.(Number(inp.value)); });
  upd();
  return { inp, out, set: v => { inp.value = v; upd(); } };
}

// ---------- Özellik çubukları ----------
export function statsBars(stats) {
  const box = h('div', { class: 'stats' });
  for (const [label, val] of stats) {
    const bar = h('i');
    box.append(h('div', { class: 'stat' }, h('span', {}, label), h('span', { class: 'bar' }, bar), h('b', {}, Math.round(val))));
    requestAnimationFrame(() => requestAnimationFrame(() => { bar.style.width = `${Math.max(0, Math.min(100, val))}%`; }));
  }
  return box;
}

// ---------- Yatay seçici (yarış oyunu araç seçimi) ----------
export function hSelector(items, { render, onChange, index = 0 }) {
  const root = h('div', { class: 'hsel', tabindex: '0', role: 'listbox' });
  const track = h('div', { class: 'hsel-track' });
  const dots = h('div', { class: 'hsel-dots' });
  const els = items.map((it, i) => { const e = h('div', { class: 'hsel-item', role: 'option', onclick: () => (i === cur ? onChange?.(items[cur], cur, true) : go(i)) }, render(it, i)); return e; });
  let cur = Math.min(index, items.length - 1);
  const layout = () => {
    els.forEach((e, i) => {
      const o = i - cur, ao = Math.abs(o);
      e.style.setProperty('--o', o); e.style.setProperty('--ao', ao);
      e.classList.toggle('far', ao > 2); e.classList.toggle('cur', o === 0);
      e.setAttribute('aria-selected', String(o === 0));
    });
    for (let i = 0; i < dots.children.length; i++) dots.children[i].classList.toggle('on', i === cur);
  };
  const go = i => { cur = (i + items.length) % items.length; layout(); onChange?.(items[cur], cur, false); };
  track.append(...els);
  items.forEach((_, i) => dots.append(h('i', { onclick: () => go(i) })));
  root.append(track,
    h('button', { class: 'hsel-arrow l', type: 'button', 'aria-label': t('common.prev'), onclick: () => go(cur - 1) }, svg('0 0 24 24', CHEV_L)),
    h('button', { class: 'hsel-arrow r', type: 'button', 'aria-label': t('common.next'), onclick: () => go(cur + 1) }, svg('0 0 24 24', CHEV_R)),
    dots);
  root.addEventListener('keydown', e => {
    const rtl = document.documentElement.dir === 'rtl';
    if (e.key === 'ArrowRight') { go(rtl ? cur - 1 : cur + 1); e.preventDefault(); }
    else if (e.key === 'ArrowLeft') { go(rtl ? cur + 1 : cur - 1); e.preventDefault(); }
    else if (e.key === 'Enter') { onChange?.(items[cur], cur, true); e.preventDefault(); }
  });
  // sürükleme / tekerlek
  let sx = null;
  root.addEventListener('pointerdown', e => { sx = e.clientX; });
  root.addEventListener('pointerup', e => { if (sx === null) return; const dx = e.clientX - sx; sx = null; if (Math.abs(dx) > 40) go(dx < 0 ? cur + 1 : cur - 1); });
  let wheelT = 0;
  root.addEventListener('wheel', e => { const now = Date.now(); if (now - wheelT < 350) return; wheelT = now; go((e.deltaY || e.deltaX) > 0 ? cur + 1 : cur - 1); }, { passive: true });
  layout();
  root.go = go; root.current = () => cur;
  return root;
}

// ---------- Kadran (rüzgâr yönü / değer) ----------
export function dial({ value = 0, min = 0, max = 360, label = '', unit = '', onChange, angular = true }) {
  const R = 80, C = 90;
  const bg = `<circle cx="${C}" cy="${C}" r="${R}" fill="none" stroke="var(--bg-3)" stroke-width="10"/>`;
  const root = h('div', { class: 'dial', tabindex: '0', role: 'slider', 'aria-valuemin': min, 'aria-valuemax': max, 'aria-label': label });
  const s = svg('0 0 180 180', `${bg}<circle class="arc" cx="${C}" cy="${C}" r="${R}" fill="none" stroke="var(--accent)" stroke-width="10" stroke-linecap="round" stroke-dasharray="${2 * Math.PI * R}" stroke-dashoffset="${2 * Math.PI * R}" transform="rotate(-90 ${C} ${C})"/>
    <g class="needle"><line x1="${C}" y1="${C}" x2="${C}" y2="${C - R + 18}" stroke="var(--fg)" stroke-width="4" stroke-linecap="round"/><circle cx="${C}" cy="${C - R + 14}" r="6" fill="var(--accent)"/></g>
    ${angular ? `<text x="${C}" y="18" text-anchor="middle" font-size="11" fill="var(--fg-dim)">N</text><text x="${2 * C - 10}" y="${C + 4}" text-anchor="middle" font-size="11" fill="var(--fg-dim)">E</text><text x="${C}" y="${2 * C - 8}" text-anchor="middle" font-size="11" fill="var(--fg-dim)">S</text><text x="10" y="${C + 4}" text-anchor="middle" font-size="11" fill="var(--fg-dim)">W</text>` : ''}`);
  const out = h('div', { class: 'val' }, h('div', {}, h('b', {}, ''), h('br'), h('small', {}, label)));
  root.append(s, out);
  const arc = s.querySelector('.arc'), needle = s.querySelector('.needle'), b = out.querySelector('b');
  const set = (v, fire = true) => {
    value = Math.max(min, Math.min(max, v));
    const f = (value - min) / (max - min);
    if (angular) { needle.setAttribute('transform', `rotate(${f * 360} ${C} ${C})`); arc.setAttribute('stroke-dashoffset', 2 * Math.PI * R); }
    else { needle.setAttribute('transform', `rotate(${-135 + f * 270} ${C} ${C})`); arc.setAttribute('stroke-dashoffset', 2 * Math.PI * R * (1 - f * 0.75)); arc.setAttribute('transform', `rotate(135 ${C} ${C})`); }
    b.textContent = `${Math.round(value)}${unit}`;
    root.setAttribute('aria-valuenow', Math.round(value));
    if (fire) onChange?.(value);
  };
  const fromPointer = e => {
    const r = root.getBoundingClientRect();
    const dx = e.clientX - (r.left + r.width / 2), dy = e.clientY - (r.top + r.height / 2);
    let ang = Math.atan2(dx, -dy) * 180 / Math.PI; if (ang < 0) ang += 360;
    if (angular) set(min + (ang / 360) * (max - min));
    else { let a = ang - 225; if (a < 0) a += 360; if (a > 270) a = a > 315 ? 0 : 270; set(min + (a / 270) * (max - min)); }
  };
  let drag = false;
  root.addEventListener('pointerdown', e => { drag = true; root.setPointerCapture(e.pointerId); fromPointer(e); });
  root.addEventListener('pointermove', e => { if (drag) fromPointer(e); });
  root.addEventListener('pointerup', () => { drag = false; });
  root.addEventListener('keydown', e => { const st = (max - min) / 72; if (e.key === 'ArrowRight' || e.key === 'ArrowUp') { set(value + st); e.preventDefault(); } if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') { set(value - st); e.preventDefault(); } });
  set(value, false);
  root.set = v => set(v, false); root.value = () => value;
  return root;
}

// ---------- Modal ----------
export function modal({ title, body, actions = [], wide = false, onClose }) {
  const rootEl = document.getElementById('modal-root');
  const box = h('div', { class: `modal ${wide ? 'wide' : ''}`, role: 'dialog', 'aria-modal': 'true' });
  if (title) box.append(h('h2', { class: 'title md' }, title));
  box.append(body);
  const close = () => { back.remove(); document.removeEventListener('keydown', esc); onClose?.(); };
  const esc = e => { if (e.key === 'Escape') close(); };
  if (actions.length) box.append(h('div', { class: 'btn-row' }, actions.map(a => btn(a.label, async () => { if ((await a.onClick?.(close)) !== false) close(); }, a.cls || ''))));
  const back = h('div', { class: 'modal-back', onclick: e => { if (e.target === back) close(); } }, box);
  rootEl.append(back);
  document.addEventListener('keydown', esc);
  requestAnimationFrame(() => box.querySelector('input,button,select')?.focus());
  return { close, box };
}
export function confirmDlg(message, { danger = false } = {}) {
  return new Promise(resolve => {
    modal({ title: t('common.confirm'), body: h('p', {}, message), onClose: () => resolve(false),
      actions: [{ label: t('common.cancel'), cls: 'ghost', onClick: () => resolve(false) }, { label: t('common.ok'), cls: danger ? 'danger' : 'primary', onClick: () => resolve(true) }] });
  });
}
export function promptDlg(title, { value = '', placeholder = '', maxlength = 40 } = {}) {
  return new Promise(resolve => {
    const inp = h('input', { class: 'input big', value, placeholder, maxlength });
    let done = false;
    const m = modal({ title, body: inp, onClose: () => { if (!done) resolve(null); },
      actions: [{ label: t('common.cancel'), cls: 'ghost', onClick: () => { done = true; resolve(null); } }, { label: t('common.save'), cls: 'primary', onClick: () => { const v = inp.value.trim(); if (!v) { inp.focus(); return false; } done = true; resolve(v); } }] });
    inp.addEventListener('keydown', e => { if (e.key === 'Enter') { const v = inp.value.trim(); if (v) { done = true; resolve(v); m.close(); } } });
  });
}

// ---------- Toast ----------
export function toast(msg, kind = '') {
  if (msg == null || !String(msg).trim() || String(msg) === '[object Object]' || /^\s*\w+:\s*(undefined|null)?\s*$/.test(String(msg))) {   // boş bildirim gösterilmez
    console.warn('SIMUMAV: boş bildirim bastırıldı', kind, msg);
    if (kind !== 'err') return;
    msg = t('common.error_generic');
  }
  const box = document.getElementById('toasts');
  const el = h('div', { class: `toast ${kind}` }, msg);
  box.append(el);
  setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 350); }, 2800);
}
// Boş metinli hata bildirimi olmasın: ileti yoksa sunucu ayrıntısı / HTTP durumu / genel metin; asıl nesne konsola yazılır (teşhis).
export const toastErr = e => {
  let msg = typeof e === 'string' ? e : (e?.message || e?.detail?.message || (typeof e?.detail === 'string' ? e.detail : '') || (e?.status ? `HTTP ${e.status}` : ''));
  if (!msg || !String(msg).trim() || String(msg) === '[object Object]') { console.error('SIMUMAV hata (iletisiz):', e); msg = t('common.error_generic'); }
  return toast(String(msg), 'err');
};

// Boş durum
export function emptyState(text, plusLabel, onPlus) {
  return h('div', { class: 'empty' }, plusButton(plusLabel, onPlus), h('p', {}, text));
}
export { clear };
