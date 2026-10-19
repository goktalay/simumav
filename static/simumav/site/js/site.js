// SIMUMAV tanıtım sitesi: i18n (tarayıcı dili; lang.js), sahne geçişleri (IntersectionObserver), parallax, açılış 3B, kayıt/giriş, GA4 + çerez rızası (analytics.js).
import { initAuth } from './auth.js';
import { LANGS, RTL, detectLang } from './lang.js';
import { initAnalytics } from './analytics.js';

const LANG_KEY = 'simumav.lang';
const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
const base = document.body.dataset.base || '';   // yasal sayfalar: '../'
let dict = {};
const t = k => dict[k] ?? k;
let analytics = null;

async function setLang(lang, { remember = true } = {}) {
  if (!LANGS.includes(lang)) lang = 'en';
  try { dict = await (await fetch(`${base}i18n/${lang}.json`, { cache: 'force-cache' })).json(); } catch (e) { if (lang !== 'en') return setLang('en', { remember }); return; }
  document.documentElement.lang = lang;
  document.documentElement.dir = RTL.has(lang) ? 'rtl' : 'ltr';
  document.querySelectorAll('[data-i18n]').forEach(el => { const v = dict[el.dataset.i18n]; if (v != null) el.textContent = v; });
  document.querySelectorAll('[data-i18n-attr]').forEach(el => {
    el.dataset.i18nAttr.split(';').forEach(pair => { const [attr, key] = pair.split(':'); if (dict[key] != null) el.setAttribute(attr, dict[key]); });
  });
  const sel = document.getElementById('lang'); if (sel) sel.value = lang;
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

async function initHero() {
  const canvas = document.getElementById('hero3d'), hero = document.getElementById('hero');
  if (!canvas || !hero) return;
  if (!hasWebGL()) { hero.classList.add('no-webgl', 'open'); return; }
  try {
    const { startHero } = await import('./hero3d.js');
    startHero(canvas, { reduced });
    setTimeout(() => hero.classList.add('open'), reduced ? 0 : 600);   // sinema bantları açılır
  } catch (e) { hero.classList.add('no-webgl', 'open'); }
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
  initReveal(); initScenes(); initParallax();
  const auth = initAuth({ t, onEvent: (name, params) => analytics?.track(name, params) });
  initHero();
  analytics = await initAnalytics({ t, i18nAttr: true, privacyHref: `${base}legal/gizlilik.html` });
  window.__smAnalytics = analytics;   // Playwright doğrulaması
  return auth;
}
main();
