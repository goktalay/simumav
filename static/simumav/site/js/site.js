// SIMUMAV tanıtım sitesi: i18n (tarayıcı dili; lang.js), sahne geçişleri (IntersectionObserver), parallax, açılış sinematiği (hero3d.js),
// Hangar 3B galerisi (hangar3d.js; tembel), gece/gündüz teması (fleet.js resolveTheme; theme-boot.js ilk boyama), modül kartı → bölüm (hash),
// EO kip seçici, kayıt/giriş, GA4 + çerez rızası (analytics.js; bölüm görüntüleme olayları yalnız rıza varsa gider).
import { initAuth } from './auth.js';
import { LANGS, RTL, detectLang } from './lang.js';
import { initAnalytics } from './analytics.js';
import { THEME_KEY, resolveTheme, nextTheme, sectionFromHash, specLine, FLEET } from './fleet.js';

const LANG_KEY = 'simumav.lang';
const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
const base = document.body.dataset.base || '';   // yasal sayfalar: '../'
let dict = {};
const t = k => dict[k] ?? k;
let analytics = null;
let lang = 'tr';
let hero = null, hangar = null, hangarLoading = null;
const track = (name, params) => { try { analytics?.track(name, params); } catch { /* analitik yok */ } };

async function setLang(lng, { remember = true } = {}) {
  lang = lng;
  if (!LANGS.includes(lang)) lang = 'en';
  try { dict = await (await fetch(`${base}i18n/${lang}.json`, { cache: 'force-cache' })).json(); } catch (e) { if (lang !== 'en') return setLang('en', { remember }); return; }
  document.documentElement.lang = lang;
  document.documentElement.dir = RTL.has(lang) ? 'rtl' : 'ltr';
  document.querySelectorAll('[data-i18n]').forEach(el => { const v = dict[el.dataset.i18n]; if (v != null) el.textContent = v; });
  document.querySelectorAll('[data-i18n-attr]').forEach(el => {
    el.dataset.i18nAttr.split(';').forEach(pair => { const [attr, key] = pair.split(':'); if (dict[key] != null) el.setAttribute(attr, dict[key]); });
  });
  const sel = document.getElementById('lang'); if (sel) sel.value = lang;
  globalThis.__smLangNow = lang;
  if (remember) { try { localStorage.setItem(LANG_KEY, lang); } catch (e) { /* yok say */ } }
  document.dispatchEvent(new CustomEvent('simumav:lang', { detail: lang }));
}

function initReveal() {
  const els = document.querySelectorAll('[data-reveal]');
  if (reduced || !('IntersectionObserver' in window)) { els.forEach(e => e.classList.add('in')); return; }
  const io = new IntersectionObserver(entries => entries.forEach(en => { if (en.isIntersecting) { en.target.classList.add('in'); io.unobserve(en.target); } }), { threshold: .18, rootMargin: '0px 0px -8% 0px' });
  els.forEach(e => io.observe(e));
}

function initScenes() {   // görünür bölüme göre gövde arka planı (sahne geçişi)
  const secs = document.querySelectorAll('section[id]');
  if (!secs.length || !('IntersectionObserver' in window)) return;
  const io = new IntersectionObserver(entries => {
    entries.forEach(en => { if (en.isIntersecting) document.body.dataset.scene = en.target.id; });
  }, { threshold: .45 });
  secs.forEach(s => io.observe(s));
}

function initParallax() {
  if (reduced) return;
  const hero = document.querySelector('.hero-copy'), sky = document.querySelector('.sky');
  const nav = document.getElementById('nav');
  let ticking = false;
  const onScroll = () => {
    if (ticking) return; ticking = true;
    requestAnimationFrame(() => {
      const y = scrollY;
      if (hero) { hero.style.transform = `translateY(${y * .28}px)`; hero.style.opacity = String(Math.max(0, 1 - y / (innerHeight * .9))); }
      if (sky) sky.style.transform = `translateY(${y * .12}px)`;
      nav?.classList.toggle('scrolled', y > 24);
      ticking = false;
    });
  };
  addEventListener('scroll', onScroll, { passive: true }); onScroll();
}

function hasWebGL() {
  try { const c = document.createElement('canvas'); return !!(c.getContext('webgl2') || c.getContext('webgl')); } catch (e) { return false; }
}

// ---------- tema (gece/gündüz) ----------
const sysLight = matchMedia('(prefers-color-scheme: light)');
const storedTheme = () => { try { return localStorage.getItem(THEME_KEY); } catch { return null; } };
const curTheme = () => document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
function applyTheme(th) {
  document.documentElement.dataset.theme = th;
  document.getElementById('theme-color')?.setAttribute('content', th === 'light' ? '#eef3f9' : '#05070f');
  const b = document.getElementById('theme-btn'); b?.setAttribute('aria-pressed', String(th === 'light'));
  hero?.setTheme(th); hangar?.setTheme(th);
  document.dispatchEvent(new CustomEvent('simumav:theme', { detail: th }));
}
function initTheme() {
  applyTheme(resolveTheme(storedTheme(), sysLight.matches));
  sysLight.addEventListener?.('change', () => { if (!storedTheme()) applyTheme(resolveTheme(null, sysLight.matches)); });   // kayıt yoksa sistemi izle
  document.getElementById('theme-btn')?.addEventListener('click', () => {
    const { theme, store } = nextTheme(curTheme(), sysLight.matches);
    try { if (store) localStorage.setItem(THEME_KEY, store); else localStorage.removeItem(THEME_KEY); } catch { /* özel mod */ }
    applyTheme(theme);
    track('theme_toggle', { theme });
  });
}

// ---------- açılış sinematiği ----------
async function initHero() {
  const canvas = document.getElementById('hero3d'), heroEl = document.getElementById('hero');
  if (!canvas || !heroEl) return;
  if (!hasWebGL()) { heroEl.classList.add('no-webgl', 'open'); return; }
  try {
    const { startHero } = await import('./hero3d.js');
    const reel = document.getElementById('reel'), bar = document.getElementById('reel-bar');
    const setLabel = (m, i, n) => {
      document.getElementById('reel-idx').textContent = `${String(i + 1).padStart(2, '0')} / ${String(n).padStart(2, '0')}`;
      document.getElementById('reel-name').textContent = m.name;
      document.getElementById('reel-type').textContent = t(`type.${m.type}`);
      document.getElementById('reel-spec').textContent = specLine(m, lang);
      reel.dataset.id = m.id; reel.classList.remove('swap'); void reel.offsetWidth; reel.classList.add('swap');
    };
    hero = startHero(canvas, { reduced, theme: curTheme(), onShot: (m, i, n) => { reel.hidden = false; reel.__cur = [m, i, n]; setLabel(m, i, n); },
      onProgress: p => { bar.style.transform = `scaleX(${p.toFixed(4)})`; } });
    document.addEventListener('simumav:lang', () => { if (reel.__cur) setLabel(...reel.__cur); });
    document.getElementById('reel-prev').addEventListener('click', () => { hero.prev(); track('reel_control', { action: 'prev' }); });
    document.getElementById('reel-next').addEventListener('click', () => { hero.next(); track('reel_control', { action: 'next' }); });
    const pb = document.getElementById('reel-pause');
    const setPause = v => { hero.pause(v); pb.setAttribute('aria-pressed', String(v)); pb.classList.toggle('paused', v); const k = v ? 'reel.play' : 'reel.pause'; pb.setAttribute('aria-label', t(k)); pb.title = t(k); };
    pb.addEventListener('click', () => { setPause(!hero.paused); track('reel_control', { action: hero.paused ? 'pause' : 'play' }); });
    if (reduced) { pb.hidden = true; reel.classList.add('static'); }
    window.__smHero = hero;   // Playwright doğrulaması
    setTimeout(() => heroEl.classList.add('open'), reduced ? 0 : 600);   // sinema bantları açılır
  } catch (e) { heroEl.classList.add('no-webgl', 'open'); }
}

// ---------- Hangar galerisi (tembel: bölüm yaklaşınca ya da karta tıklanınca) ----------
function loadHangar() {
  const root = document.getElementById('hangar');
  if (!root) return null;
  hangarLoading ??= (async () => {
    if (!hasWebGL()) {   // WebGL yok: ad + tür + hız listesi
      const grid = root.querySelector('.fleet-grid');
      for (const m of FLEET) { const li = document.createElement('li'); li.className = 'fleet-plain'; li.textContent = `${m.name} — ${t(`type.${m.type}`)} · ${specLine(m, lang)}`; grid.append(li); }
      return null;
    }
    const { initHangar } = await import('./hangar3d.js');
    hangar = initHangar(root, { t, lang, reduced, onOpen: id => track('hangar_model_open', { model: id }) });
    hangar.setTheme(curTheme());
    document.addEventListener('simumav:lang', e => hangar.refresh(e.detail));
    window.__smHangar = hangar;   // Playwright doğrulaması
    return hangar;
  })();
  return hangarLoading;
}
function initHangarLazy() {
  const root = document.getElementById('hangar');
  if (!root) return;
  if (!('IntersectionObserver' in window)) { loadHangar(); return; }
  const io = new IntersectionObserver(([e]) => { if (e.isIntersecting) { io.disconnect(); loadHangar(); } }, { rootMargin: '600px 0px' });
  io.observe(root);
}

// ---------- modül kartları → bölüm; hash; bölüm görüntüleme (GA) ----------
function initSections() {
  document.querySelectorAll('.mod-card').forEach(card => {
    const a = card.querySelector('.mod-link');
    card.addEventListener('click', e => { if (e.target.closest('a') !== a) a?.click(); });
    a?.addEventListener('click', () => {
      const id = sectionFromHash(a.getAttribute('href'));
      track('module_card', { module: card.dataset.mod });
      if (id === 'hangar') loadHangar();
    });
  });
  const goHash = () => { if (sectionFromHash(location.hash) === 'hangar') loadHangar(); };
  addEventListener('hashchange', goHash); goHash();
  if (!('IntersectionObserver' in window)) return;
  const seen = new Set();
  const io = new IntersectionObserver(es => es.forEach(e => {
    const id = e.target.id;
    if (e.isIntersecting && !seen.has(id)) { seen.add(id); track('section_view', { section: id }); }
  }), { threshold: 0.4 });
  document.querySelectorAll('main section[id]').forEach(s => io.observe(s));
}

// ---------- TOP 10 PİLOT (§25; tembel: bölüm yaklaşınca) ----------
function initTop10Lazy() {
  const root = document.getElementById('top10');
  if (!root) return;
  let done = false;
  const go = async () => {
    if (done) return; done = true;
    const { initTop10 } = await import('./top10.js');
    window.__smTop10 = initTop10(root, { t, lang: () => lang, reduced, onView: p => track('top10_period', { period: p }) });
  };
  if (!('IntersectionObserver' in window)) { go(); return; }
  const io = new IntersectionObserver(es => { if (es.some(e => e.isIntersecting)) { io.disconnect(); go(); } }, { rootMargin: '400px 0px' });
  io.observe(root);
}

function initEo() {
  const card = document.querySelector('.sys-card.eo');
  if (!card) return;
  card.querySelectorAll('[data-eo-btn]').forEach(b => b.addEventListener('click', () => {
    const k = b.dataset.eoBtn;
    card.querySelectorAll('[data-eo-btn]').forEach(x => x.setAttribute('aria-pressed', String(x === b)));
    card.querySelectorAll('.eo-img').forEach(img => img.classList.toggle('on', img.dataset.eo === k));
    track('eo_mode', { mode: k });
  }));
}

async function main() {
  // İlk açılış: ?lang > kayıtlı seçim > tarayıcı dilleri > en. Yalnız tarayıcıdan gelen dil KAYDEDİLMEZ (kullanıcı tarayıcı dilini değiştirirse site de değişir);
  // ?lang (reklam bağlantısı) ve seçiciden seçim kaydedilir.
  const q = new URLSearchParams(location.search).get('lang');
  let stored = null; try { stored = localStorage.getItem(LANG_KEY); } catch (e) { /* özel mod */ }
  const lang = detectLang(LANG_KEY);
  await setLang(lang, { remember: !!(q || stored) });
  document.getElementById('lang')?.addEventListener('change', e => setLang(e.target.value));
  const y = document.getElementById('year'); if (y) y.textContent = String(new Date().getFullYear());
  initTheme();
  initReveal(); initScenes(); initParallax(); initSections(); initEo(); initHangarLazy(); initTop10Lazy();
  const auth = initAuth({ t, onEvent: (name, params) => analytics?.track(name, params) });
  initHero();
  analytics = await initAnalytics({ t, i18nAttr: true, privacyHref: `${base}legal/gizlilik.html` });
  window.__smAnalytics = analytics;   // Playwright doğrulaması
  return auth;
}
main();
