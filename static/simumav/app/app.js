// SIMUMAV oyun kabuğu: hash router (#/menu #/hangar #/crew #/tracks #/missions #/fly #/ops #/settings), tema, dil, kullanıcı çipi.
import * as api from './core/api.js';
import { h, clear } from './core/dom.js';
import { setLang, detectLang, t } from './i18n/i18n.js';
import { sweep } from './ui/transition.js';
import { toast, toastErr } from './ui/components.js';

// Rota tablosu: modül `mount(root, ctx)` (oyun arayüzü modülleri) YA DA `render(view, params, ctx)` (fly/index.js) dışa aktarır; router ikisini de destekler.
export const ROUTES = {
  menu: () => import('./menu/index.js'),
  hangar: () => import('./hangar/index.js'),
  crew: () => import('./crew/index.js'),
  tracks: () => import('./tracks/index.js'),
  missions: () => import('./missions/index.js'),
  fly: () => import('./fly/index.js'),
  ops: () => import('./ops/index.js'),
  settings: () => import('./settings/index.js'),
};
const ORDER = ['menu', 'hangar', 'crew', 'tracks', 'missions', 'fly', 'ops', 'settings'];

const state = { user: null, pilotsCount: 0, settings: { lang: null, theme: 'auto', sound: true, analog_fpv: true }, meta: null, current: null, unmount: null };
const view = document.getElementById('view');
const chip = document.getElementById('chip'), gear = document.getElementById('gear'), back = document.getElementById('back');

// ---------- Tema ----------
const mq = window.matchMedia('(prefers-color-scheme: dark)');
export function applyTheme(theme) {
  state.settings.theme = theme || 'auto';
  const eff = state.settings.theme === 'auto' ? (mq.matches ? 'dark' : 'light') : state.settings.theme;
  document.documentElement.dataset.theme = eff;
  if (theme) localStorage.setItem('sm:theme', state.settings.theme);
  window.dispatchEvent(new CustomEvent('sm:theme', { detail: eff }));
}
mq.addEventListener('change', () => { if (state.settings.theme === 'auto') applyTheme('auto'); });

// ---------- Oturum ----------
async function loadSession() {
  try {
    const s = await api.get('/api/session');
    state.user = s.user; state.pilotsCount = s.pilots_count ?? 0;
  } catch (e) {
    if (e.status === 401 || e.status === 403) { location.href = '/'; return false; }   // tanıtım/giriş sayfası
    toastErr(e); state.user = { display_name: '—' };
  }
  try { Object.assign(state.settings, await api.get('/api/settings')); } catch { /* varsayılanlar */ }
  try { state.meta = await api.get('/api/meta'); } catch { state.meta = {}; }
  return true;
}
function renderChip() {
  if (!state.user) return;
  chip.hidden = false; gear.hidden = false;
  document.getElementById('chip-name').textContent = state.user.display_name || state.user.email || '—';
  document.getElementById('chip-sub').textContent = t('shell.pilots', { n: state.pilotsCount });
  const av = document.getElementById('chip-avatar');
  clear(av, h('img', { src: `/app/img/pilots/${state.user.avatar || 'p01'}.svg`, alt: '' }));
  gear.setAttribute('aria-label', t('menu.settings'));
}

// ---------- Router ----------
const ctx = {
  state, api, t,
  // go('ops', '12') ya da go('#/ops/12') — Uç modülü hash biçimini kullanır
  go: (name, params = '') => { location.hash = String(name).startsWith('#') ? name : `#/${name}${params ? `/${params}` : ''}`; },
  toast: (msg, kind) => toast(msg, kind === 'err' || kind === 'error' ? 'err' : kind === 'ok' || kind === 'success' ? 'ok' : ''),
  setBack: (label, target = 'menu') => { back.hidden = !label; document.getElementById('back-label').textContent = label || ''; back.onclick = () => ctx.go(target); },
  refreshSession: async () => { await loadSession(); renderChip(); },
  applyTheme,
  setLang: async code => { await setLang(code); renderChip(); await route(true); },
};

function parse() {
  const m = location.hash.match(/^#\/([a-z]+)(?:\/(.*))?$/);
  return { name: m && ROUTES[m[1]] ? m[1] : 'menu', param: m?.[2] ? decodeURIComponent(m[2]) : '' };
}
let routing = false;
async function route(force = false) {
  const { name, param } = parse();
  if (!force && state.current === `${name}/${param}`) return;
  if (routing) { setTimeout(() => route(force), 50); return; }
  routing = true;
  const dir = ORDER.indexOf(name) < ORDER.indexOf((state.current || 'menu').split('/')[0]) ? 'back' : 'fwd';
  const prev = state.current; state.current = `${name}/${param}`;
  document.body.dataset.screen = name;
  let mod;
  try { mod = await ROUTES[name](); } catch (e) {
    console.error(e);
    await sweep(() => { state.unmount?.(); state.unmount = null; view.className = ''; clear(view, h('div', { class: 'screen center-stack' }, h('div', { class: 'err-box' }, t('shell.module_missing', { name })))); ctx.setBack(t('common.back')); });
    routing = false; return;
  }
  await sweep(async () => {
    try { state.unmount?.(); } catch (e) { console.error(e); }
    state.unmount = null; view.className = ''; view.scrollTop = 0;
    clear(view);
    back.hidden = true; chip.hidden = name === 'fly'; gear.hidden = name === 'fly' || name === 'settings';
    try {
      let r;
      if (typeof mod.mount === 'function') r = await mod.mount(view, { ...ctx, param });
      else if (typeof mod.render === 'function') {
        // render(view, params, ctx): params `#/fly/12` → {id:'12'}; ctx gerçek kabuk işlevleri (i18n → t, toast, go) + oturum/ayar/meta
        const params = param ? { id: param } : {};
        r = await mod.render(view, params, { ...ctx, i18n: (s, p) => t(s, p), user: state.user, settings: state.settings, meta: state.meta, param });
      } else throw new Error(t('shell.module_missing', { name }));
      state.unmount = typeof r === 'function' ? r : r?.unmount || r?.dispose || (typeof mod.unmount === 'function' ? () => mod.unmount() : null);
      if (name !== 'menu' && back.hidden && name !== 'fly') ctx.setBack(t('common.menu'));
    } catch (e) { console.error(e); toastErr(e); }
  }, { dir, duration: prev ? 450 : 350 });
  routing = false;
}

// ---------- Başlat ----------
async function boot() {
  applyTheme(localStorage.getItem('sm:theme') || null);
  await setLang(detectLang(), { silent: true });
  const ok = await loadSession();
  if (!ok) return;
  // Öncelik: bu cihazda seçilmiş tema/dil (localStorage) → sunucudaki ayar → otomatik
  if (!localStorage.getItem('sm:theme') && state.settings.theme) applyTheme(state.settings.theme);
  if (state.settings.lang && !localStorage.getItem('sm:lang')) await setLang(state.settings.lang, { silent: true });
  renderChip();
  gear.addEventListener('click', () => ctx.go('settings'));
  chip.addEventListener('click', () => ctx.go('crew'));
  window.addEventListener('hashchange', () => route());
  window.addEventListener('sm:session', () => ctx.refreshSession());
  if (!location.hash) location.hash = '#/menu'; else route();
}
boot();
