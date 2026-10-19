// Çok dilli metinler: i18n/<lang>.json; t(anahtar, değişkenler); Arapça RTL. Dil değişince 'sm:lang' olayı yayılır.
export const LANGS = [
  { code: 'tr', name: 'Türkçe', native: 'Türkçe' },
  { code: 'en', name: 'English', native: 'English' },
  { code: 'de', name: 'Deutsch', native: 'Deutsch' },
  { code: 'fr', name: 'Français', native: 'Français' },
  { code: 'es', name: 'Español', native: 'Español' },
  { code: 'ru', name: 'Русский', native: 'Русский' },
  { code: 'ar', name: 'العربية', native: 'العربية', rtl: true },
];
const RTL = new Set(LANGS.filter(l => l.rtl).map(l => l.code));
let dict = {}, fallbackDict = {}, current = 'tr';
const cache = new Map();

async function load(code) {
  if (cache.has(code)) return cache.get(code);
  const p = fetch(new URL(`./${code}.json`, import.meta.url)).then(r => { if (!r.ok) throw new Error(`i18n ${code}`); return r.json(); });
  cache.set(code, p);
  return p;
}

export function detectLang() {
  const saved = localStorage.getItem('sm:lang');
  if (saved && LANGS.some(l => l.code === saved)) return saved;
  const nav = (navigator.language || 'tr').slice(0, 2).toLowerCase();
  return LANGS.some(l => l.code === nav) ? nav : 'en';
}

export async function setLang(code, { silent = false } = {}) {
  if (!LANGS.some(l => l.code === code)) code = 'en';
  const [d, fb] = await Promise.all([load(code), code === 'tr' ? load('tr') : load('tr').catch(() => ({}))]);
  dict = d; fallbackDict = fb; current = code;
  localStorage.setItem('sm:lang', code);
  document.documentElement.lang = code;
  document.documentElement.dir = RTL.has(code) ? 'rtl' : 'ltr';
  if (!silent) window.dispatchEvent(new CustomEvent('sm:lang', { detail: code }));
  return code;
}
export const lang = () => current;
export const isRTL = () => RTL.has(current);

export function t(key, vars) {
  let s = dict[key] ?? fallbackDict[key] ?? key;
  if (vars) for (const [k, v] of Object.entries(vars)) s = s.replaceAll(`{${k}}`, String(v));
  return s;
}
export const has = key => key in dict || key in fallbackDict;
