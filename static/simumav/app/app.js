// SIMUMAV oyun kabuğu: hash router (#/menu #/hangar #/crew #/tracks #/missions #/fly #/ops #/settings), tema, dil, kullanıcı çipi.
import { installGlCounter } from './core/gl.js';
import * as api from './core/api.js';
import { h, clear } from './core/dom.js';

installGlCounter();   // teşhis: window.__smGl() → canlı WebGL bağlam sayısı (three.js/Cesium yüklenmeden önce kurulmalı)
import { setLang, detectLang, hasDeviceLang, t } from './i18n/i18n.js';
import { initAnalytics } from '/js/analytics.js';   // GA4 + çerez rızası (tanıtım sitesiyle aynı modül ve aynı rıza anahtarı)
import { sweep } from './ui/transition.js';
import { toast, toastErr } from './ui/components.js';
import * as sfx from './ui/sfx.js';
import * as backdrop from './ui/backdrop.js';   // bölüm başına hareketli Canvas2D arka plan (#backdrop; içerik kodu değişmez)
import * as music from './ui/music.js';         // prosedürel arka plan müziği (ilk etkileşimde; uçuş oturumunda susar)
import { mountHolidayFx } from '/sim/holiday_fx.js';   // bayram temaları (HEPGO ile ortak; arka planın ÜSTÜNDE hafif katman, uçuş oturumunda kapalı)

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
  support: () => import('./support/index.js'),
};
const ORDER = ['menu', 'hangar', 'crew', 'tracks', 'missions', 'fly', 'ops', 'settings', 'support'];

const state = { user: null, pilotsCount: 0, settings: { lang: null, theme: 'auto', sound: true, analog_fpv: true }, meta: null, current: null, unmount: null };
let analytics = null;
const track = (name, params) => { try { analytics?.track(name, params); } catch { /* analitik yok */ } };
const view = document.getElementById('view');
const chip = document.getElementById('chip'), gear = document.getElementById('gear'), back = document.getElementById('back'), help = document.getElementById('help');

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
    // tanıtım/giriş sayfası; derin bağlantı (ör. §18 davet #/fly/join/<kod>) girişten sonra geri açılır
    if (e.status === 401 || e.status === 403) { const h = location.hash && location.hash !== '#/menu' ? location.hash : ''; location.href = h ? `/?giris=1&sonra=${encodeURIComponent(`/app/${h}`)}` : '/'; return false; }
    toastErr(e); state.user = { display_name: '—' };
  }
  try { Object.assign(state.settings, await api.get('/api/settings')); } catch { /* varsayılanlar */ }
  try { state.meta = await api.get('/api/meta'); } catch { state.meta = {}; }
  // Ses: sunucu ayarı (sound, volume) + cihaz tercihi (motor sesi; varsayılan kapalı)
  sfx.configure({ sound: state.settings.sound !== false, volume: state.settings.volume ?? 0.8, engine: localStorage.getItem('sm:engine') === '1' });
  return true;
}
function renderChip() {
  if (!state.user) return;
  chip.hidden = false; gear.hidden = false; help.hidden = false;
  help.setAttribute('aria-label', t('support.help')); help.title = t('support.help');
  document.getElementById('chip-name').textContent = state.user.display_name || state.user.email || '—';
  document.getElementById('chip-sub').textContent = t('shell.pilots', { n: state.pilotsCount });
  const av = document.getElementById('chip-avatar');
  clear(av, h('img', { src: `/app/img/pilots/${state.user.avatar || 'p01'}.svg`, alt: '' }));
  gear.setAttribute('aria-label', t('menu.settings'));
}

// ---------- Ortam: arka plan sahnesi + müzik (bölüm → sahne; uçuş oturumu (#view.sm-fly-session) → ikisi de durur) ----------
function syncAmbience() {
  const name = (state.current || 'menu').split('/')[0], inFlight = view.classList.contains('sm-fly-session');
  backdrop.setScene(backdrop.sceneFor(name, { inFlight, enabled: backdrop.bgEnabled() }));
  music.setScene(name, { inFlight });
}
new MutationObserver(syncAmbience).observe(view, { attributes: true, attributeFilter: ['class'] });
addEventListener('sm:bgfx', syncAmbience);
// Arayüz düğmelerine hafif üzerine gelme / tıklama sesleri (efekt düzeyine bağlı; kendi sesi olan menü kartları ve uçuş oturumu hariç)
const UI_BTN = 'button, .btn, [role="button"], .sm-mode-card, .sm-card';
const uiBtn = e => { const b = e.target?.closest?.(UI_BTN); return b && !b.disabled && view.contains(b) && !b.closest('.mcard, .sm-fly-session, [data-nosfx]') ? b : null; };
view.addEventListener('pointerover', e => { const b = uiBtn(e); if (b && !b.contains(e.relatedTarget)) sfx.hover(); });
view.addEventListener('click', e => { if (uiBtn(e)) sfx.tick(); });

// ---------- Bayram temaları (docs/bayram-temalari.md): ayar holiday_fx (varsayılan açık) + holiday_country ('' = otomatik) ----------
// Ülke: ayar → kendi parkurunun merkezi (sunucu /api/holiday-theme/me) → saat dilimi → tarayıcı dili. Katman arka plan sahnelerinin (#stage, #backdrop) ve
// #view'in ÜSTÜNDE (z 2), kabuk düğmelerinin altında; tıklamaları geçirir. Uzun figürler (ağaç, menora …) ground=0,62 ile menü kartlarının üstünde durur;
// uçuş oturumunda (#view.sm-fly-session) gizlenir. Önizleme: /app/?bayram=<tema>.
let holiday = null, holidayMe = null;
let holidayTok = 0;
async function syncHoliday(preview = null) {
  const my = ++holidayTok;   // üst üste çağrılırsa yalnız sonuncusu kalır
  holiday?.destroy(); holiday = null;
  if (!holidayMe) { try { holidayMe = await api.get('/api/holiday-theme/me'); } catch { holidayMe = {}; } }
  if (my !== holidayTok) return;
  try {
    const hx = await mountHolidayFx({ enabled: state.settings.holiday_fx !== false, country: state.settings.holiday_country || '', located: holidayMe?.located,
      lang: document.documentElement.lang || 'tr', zIndex: 2, ground: 0.62, bannerTop: 84,   // ground: ağaç/menora gibi uzun figürler menü kartlarının üstünde durur
      bannerZ: 6, preview, reduced: () => !!state.settings.reduced_motion,
      inFlight: () => view.classList.contains('sm-fly-session') });
    if (my !== holidayTok) { hx?.destroy(); return; }
    holiday = hx;
  } catch (e) { console.warn('bayram teması', e); }
}
addEventListener('sm:holiday', e => syncHoliday(e.detail?.preview || null));   // Ayarlar: aç/kapa, ülke, önizleme
window.__smHoliday = () => ({ me: holidayMe, detected: holiday?.detected || null, picked: holiday?.picked || null, info: holiday?.info || null });

// ---------- Router ----------
const ctx = {
  state, api, t,
  // go('ops', '12') ya da go('#/ops/12') — Uç modülü hash biçimini kullanır
  go: (name, params = '') => { location.hash = String(name).startsWith('#') ? name : `#/${name}${params ? `/${params}` : ''}`; },
  toast: (msg, kind) => toast(msg, kind === 'err' || kind === 'error' ? 'err' : kind === 'ok' || kind === 'success' ? 'ok' : ''),
  // Hedef rota şu anki adresle aynıysa (ör. #/missions içinde görev düzenleyicisi → "Görevler"; #/tracks, #/hangar sihirbazı) hash değişmez,
  // hashchange gelmez ve düğme hiçbir şey yapmazdı → aynı rotada modül yeniden kurulur (alt ekran kapanır, liste açılır).
  // target işlev olabilir: modül kendi içinde geri gider (Uç: sihirbaz adımı → önceki adım, ilk adımda #/fly seçimine).
  setBack: (label, target = 'menu') => {
    back.hidden = !label; document.getElementById('back-label').textContent = label || '';
    back.onclick = () => {
      if (typeof target === 'function') { target(); return; }   // modül içi geri (ör. Uç sihirbazında bir önceki adım)
      const hash = String(target).startsWith('#') ? target : `#/${target}`;
      if (location.hash === hash || (target === 'menu' && !location.hash)) route(true); else ctx.go(target);
    };
  },
  refreshSession: async () => { await loadSession(); renderChip(); },
  applyTheme,
  setLang: async code => { await setLang(code); renderChip(); await route(true); },
  track,   // GA4 özel olayları (flight_start/flight_end …); rıza yoksa sessizce yok sayılır
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
  try { analytics?.pageView(`/app/#/${name}${param ? '/' + param : ''}`); } catch { /* analitik yok */ }   // hash rotası → GA4 page_view (page_path)
  let mod;
  try { mod = await ROUTES[name](); } catch (e) {
    console.error(e);
    await sweep(async () => { try { await state.unmount?.(); } catch (e2) { console.error(e2); } state.unmount = null; view.className = ''; clear(view, h('div', { class: 'screen center-stack' }, h('div', { class: 'err-box' }, t('shell.module_missing', { name }), h('div', { class: 'err-detail', style: 'margin-top:8px;font-size:12px;opacity:.75;font-family:monospace;white-space:pre-wrap' }, String(e?.message || e || '').slice(0, 300)), h('button', { class: 'btn', style: 'margin-top:10px', onclick: () => location.reload() }, t('common.reload'))))); ctx.setBack(t('common.back')); });
    routing = false; return;
  }
  await sweep(async () => {
    // Önce eski modülün unmount'u (Promise dönebilir: 3B görünümler/çizici bırakılır) BEKLENİR; yeni modül ancak sonra kurulur
    try { await state.unmount?.(); } catch (e) { console.error(e); }
    state.unmount = null; view.className = ''; view.scrollTop = 0;
    clear(view);
    back.hidden = true; chip.hidden = name === 'fly'; gear.hidden = name === 'fly' || name === 'settings'; help.hidden = name === 'fly';
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
    } catch (e) { console.error(e); toastErr(e); sfx.error(); }
    syncAmbience();
  }, { dir, duration: prev ? (dir === 'back' ? 480 : 620) : 400 });
  routing = false;
}

// ---------- Başlat ----------
async function boot() {
  applyTheme(localStorage.getItem('sm:theme') || null);
  await setLang(detectLang(), { silent: true, remember: false });
  const ok = await loadSession();
  if (!ok) return;
  // Öncelik: bu cihazda seçilmiş tema/dil (localStorage) → sunucudaki ayar (settings.lang) → tarayıcı dili (navigator.languages) → en
  if (!localStorage.getItem('sm:theme') && state.settings.theme) applyTheme(state.settings.theme);
  if (state.settings.lang && !hasDeviceLang()) await setLang(detectLang({ stored: state.settings.lang }), { silent: true, remember: false });
  renderChip();
  try {
    analytics = await initAnalytics({ gaId: state.meta?.ga_id || '', adsId: state.meta?.ads_id || '', t, spa: true, privacyHref: '/legal/gizlilik.html' });
    window.__smAnalytics = analytics;
  } catch (e) { console.warn('analitik başlatılamadı', e); }
  gear.addEventListener('click', () => { sfx.select(); ctx.go('settings'); });
  help.addEventListener('click', async () => { try { (await ROUTES.support()).openReportModal(ctx); } catch (e) { toastErr(e); } });   // yaşam simidi: Sorun bildir (§9)
  help.addEventListener('pointerenter', () => sfx.hover());
  chip.addEventListener('click', () => { sfx.select(); ctx.go('crew'); });
  back.addEventListener('pointerenter', () => sfx.hover()); gear.addEventListener('pointerenter', () => sfx.hover()); chip.addEventListener('pointerenter', () => sfx.hover());
  music.initMusic();
  syncHoliday();
  window.__smBackdrop = backdrop.state; window.__smMusic = music.state;   // teşhis (kare süresi / müzik düzeyi)
  window.addEventListener('hashchange', () => route());
  window.addEventListener('sm:session', () => ctx.refreshSession());
  if (!location.hash) location.hash = '#/menu'; else route();
}
boot();
