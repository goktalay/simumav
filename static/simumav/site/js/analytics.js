// SIMUMAV — Google Analytics 4 + çerez rızası (Consent Mode v2). Harici dosya: CSP inline script yok.
// Tasarım (docs/simumav.md §5.2): rıza localStorage 'simumav.consent' ∈ {granted, denied}; rıza yoksa alt bant (Kabul / Reddet / Ayarlar).
//   gtag.js YALNIZ rıza 'granted' iken yüklenir (reddedilirse hiç yüklenmez); yüklenirken consent default analytics_storage=denied → update granted;
//   config {anonymize_ip:true}. Ölçüm kimliği /api/meta.ga_id (env SIMUMAV_GA_ID; boş → yüklenmez). Olaylarda kişisel veri yok.
// Hem tanıtım sitesi (site.js) hem oyun kabuğu (/app/app.js → '/js/analytics.js') aynı modülü ve aynı rıza anahtarını kullanır.
export const CONSENT_KEY = 'simumav.consent';
export const GTAG_SRC = 'https://www.googletagmanager.com/gtag/js';
const CSS_HREF = '/css/consent.css';
const KEYS = ['cookie.title', 'cookie.text', 'cookie.more', 'cookie.necessary', 'cookie.analytics', 'cookie.settings', 'cookie.reject', 'cookie.accept', 'cookie.save'];

/** Kayıtlı rıza: 'granted' | 'denied' | null (henüz seçilmedi). */
export function getConsent(storage = globalThis.localStorage) {
  try { const v = storage?.getItem(CONSENT_KEY); return v === 'granted' || v === 'denied' ? v : null; } catch { return null; }
}
export function storeConsent(value, storage = globalThis.localStorage) {
  try { if (value) storage?.setItem(CONSENT_KEY, value); else storage?.removeItem(CONSENT_KEY); } catch { /* özel mod */ }
}
/** Saf karar: gtag yüklensin mi, bant gösterilsin mi. */
export function decide({ consent, gaId }) {
  return { load: consent === 'granted' && !!gaId, banner: consent == null };
}
/** /api/meta.ga_id (oturumsuz da döner). */
export async function fetchGaId() {
  try { const r = await fetch('/api/meta', { credentials: 'same-origin' }); if (r.ok) return String((await r.json()).ga_id || '').trim(); } catch { /* statik önizleme */ }
  return '';
}

function ensureCss() {
  if (!document.querySelector(`link[href="${CSS_HREF}"]`)) {
    const l = document.createElement('link'); l.rel = 'stylesheet'; l.href = CSS_HREF; document.head.append(l);
  }
}
function el(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) { if (v == null || v === false) continue; if (k === 'class') e.className = v; else if (k.startsWith('on')) e.addEventListener(k.slice(2), v); else e.setAttribute(k, v === true ? '' : v); }
  for (const k of kids) if (k != null) e.append(k);
  return e;
}
function clearGaCookies() {
  const host = location.hostname.replace(/^www\./, '');
  for (const c of document.cookie.split(';')) {
    const name = c.split('=')[0].trim();
    if (!/^_ga(_|$)|^_gid$|^_gat/.test(name)) continue;
    for (const dom of ['', `; domain=${host}`, `; domain=.${host}`]) document.cookie = `${name}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/${dom}`;
  }
}

/**
 * createAnalytics({ gaId, t, privacyHref, spa, i18nAttr }) → { track, pageView, setConsent, openBanner, loaded }
 *   t         : anahtar → metin (cookie.* anahtarları); i18nAttr=true ise bant öğelerine data-i18n yazılır (site.js setLang yeniden çevirir)
 *   spa       : true → config send_page_view:false; pageView(path) ile hash rotaları gönderilir
 */
export function createAnalytics({ gaId = '', t = k => k, privacyHref = '/legal/gizlilik.html', spa = false, i18nAttr = false, storage = globalThis.localStorage } = {}) {
  let loaded = false, bar = null;
  const w = globalThis;
  w.dataLayer = w.dataLayer || [];
  const gtag = function () { w.dataLayer.push(arguments); };
  if (typeof w.gtag !== 'function') w.gtag = gtag;

  function load() {
    if (loaded || !gaId) return;
    loaded = true;
    w.gtag('consent', 'default', { analytics_storage: 'denied', ad_storage: 'denied', ad_user_data: 'denied', ad_personalization: 'denied', wait_for_update: 500 });
    w.gtag('consent', 'update', { analytics_storage: 'granted' });
    w.gtag('js', new Date());
    w.gtag('config', gaId, { anonymize_ip: true, send_page_view: !spa, allow_google_signals: false, allow_ad_personalization_signals: false });
    const s = document.createElement('script'); s.async = true; s.src = `${GTAG_SRC}?id=${encodeURIComponent(gaId)}`; s.dataset.ga = '1';
    document.head.append(s);
    if (spa) pageView();
  }
  function setConsent(value) {
    storeConsent(value, storage);
    hideBanner();
    if (value === 'granted') load();
    else if (loaded) { w.gtag('consent', 'update', { analytics_storage: 'denied' }); clearGaCookies(); }
    document.dispatchEvent(new CustomEvent('simumav:consent', { detail: value }));
  }
  const L = (key, tag = 'span', attrs = {}) => el(tag, { ...attrs, 'data-i18n': i18nAttr ? key : null }, t(key));

  function hideBanner() { if (bar) { bar.classList.remove('in'); const b = bar; bar = null; setTimeout(() => b.remove(), 350); } }
  function openBanner({ settings = false } = {}) {
    hideBanner(); ensureCss();
    const an = el('input', { type: 'checkbox', id: 'ck-an', checked: getConsent(storage) === 'granted' ? true : null });
    const opts = el('div', { class: 'ck-opts', hidden: !settings },
      el('label', {}, el('input', { type: 'checkbox', checked: true, disabled: true }), L('cookie.necessary')),
      el('label', {}, an, L('cookie.analytics')));
    const accept = el('button', { type: 'button', class: 'ck-btn primary', 'data-consent': 'accept', onclick: () => setConsent(opts.hidden ? 'granted' : (an.checked ? 'granted' : 'denied')) }, L(settings ? 'cookie.save' : 'cookie.accept'));
    const reject = el('button', { type: 'button', class: 'ck-btn', 'data-consent': 'reject', onclick: () => setConsent('denied') }, L('cookie.reject'));
    const cfg = el('button', { type: 'button', class: 'ck-btn ghost', 'data-consent': 'settings', hidden: settings, onclick: () => {
      opts.hidden = false; cfg.hidden = true; accept.replaceChildren(L('cookie.save')); an.focus();
    } }, L('cookie.settings'));
    bar = el('aside', { class: 'ck-bar', id: 'cookie-bar', role: 'dialog', 'aria-labelledby': 'ck-title', 'aria-describedby': 'ck-text' },
      el('div', { class: 'ck-body' },
        L('cookie.title', 'b', { id: 'ck-title' }),
        el('p', { id: 'ck-text' }, L('cookie.text'), ' ', L('cookie.more', 'a', { href: privacyHref })),
        opts),
      el('div', { class: 'ck-actions' }, cfg, reject, accept));
    document.body.append(bar);
    requestAnimationFrame(() => bar?.classList.add('in'));
    return bar;
  }
  function track(name, params = {}) { if (loaded) w.gtag('event', name, params); }
  function pageView(path = location.pathname + location.search + location.hash) {
    if (loaded) w.gtag('event', 'page_view', { page_path: path, page_location: location.origin + path, page_title: document.title });
  }

  const d = decide({ consent: getConsent(storage), gaId });
  if (d.load) load();
  if (d.banner && gaId) openBanner();
  // "Çerez tercihlerini değiştir" bağlantıları (yasal sayfalar, ayarlar)
  document.addEventListener('click', e => { const a = e.target.closest('[data-consent="manage"]'); if (a) { e.preventDefault(); openBanner({ settings: true }); } });
  return { track, pageView, setConsent, openBanner, get loaded() { return loaded; }, keys: KEYS };
}

/** Kısa yol: ölçüm kimliğini /api/meta'dan alıp başlatır. */
export async function initAnalytics(opts = {}) {
  const gaId = opts.gaId ?? await fetchGaId();
  return createAnalytics({ ...opts, gaId });
}
