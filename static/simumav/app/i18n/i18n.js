// Çok dilli metinler: i18n/<lang>.json; t(anahtar, değişkenler); Arapça RTL. Dil değişince 'sm:lang' olayı yayılır.
// Dil seçimi tanıtım sitesiyle ortak saf kural (/js/lang.js): ?lang > bu cihazdaki seçim (sm:lang) > [hesap ayarı app.js'de] > navigator.languages > en.
import { detectLang as pick } from '/js/lang.js';

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

/** stored: hesap ayarı (settings.lang) — localStorage'da seçim yoksa onun yerine kullanılır. */
export function detectLang({ stored = null } = {}) {
  let saved = null; try { saved = localStorage.getItem('sm:lang'); } catch { /* özel mod */ }
  return pick(null, { stored: saved || stored });
}
export function hasDeviceLang() { try { return !!localStorage.getItem('sm:lang'); } catch { return false; } }

/** remember=false: açılıştaki otomatik seçim (tarayıcı/hesap dili) bu cihaza YAZILMAZ; yalnız kullanıcının Ayarlar'daki seçimi kalır. */
export async function setLang(code, { silent = false, remember = true } = {}) {
  if (!LANGS.some(l => l.code === code)) code = 'en';
  const [d, fb] = await Promise.all([load(code), code === 'tr' ? load('tr') : load('tr').catch(() => ({}))]);
  dict = d; fallbackDict = fb; current = code;
  if (remember) { try { localStorage.setItem('sm:lang', code); } catch { /* özel mod */ } }
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
