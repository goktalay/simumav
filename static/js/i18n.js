// Basit, genişletilebilir çeviri çerçevesi. Kaynak dil Türkçe; metinler t('Türkçe metin') ile sarılır.
// Dil değişince katalogdan (ör. İngilizce) karşılığı döner; karşılığı yoksa Türkçe kalır (hiç metin kaybolmaz).
// Yeni dil eklemek için registerCatalog('xx', {...}) yeterli. Değişken için: t('{n} kişi', { n: 5 }).
let LANG = 'tr';
const CAT = {};   // { 'en': { 'Türkçe': 'English', ... }, ... }
const listeners = new Set();
const RTL = new Set(['ar', 'fa', 'he', 'ur']);   // sağdan-sola diller
export function isRTL(lang) { return RTL.has(lang || LANG); }
function applyDir() { try { document.documentElement.dir = RTL.has(LANG) ? 'rtl' : 'ltr'; } catch { /* */ } }

export function registerCatalog(lang, obj) { CAT[lang] = Object.assign(CAT[lang] || {}, obj); }
export function availableLangs() { return ['tr', ...Object.keys(CAT)]; }
export function getLang() { return LANG; }

function readStored() {
  try { return localStorage.getItem('caymaz.lang') || 'tr'; } catch { return 'tr'; }
}
export function initLang(lang) {
  LANG = (lang && (lang === 'tr' || CAT[lang])) ? lang : readStored();
  if (LANG !== 'tr' && !CAT[LANG]) LANG = 'tr';
  try { document.documentElement.lang = LANG; } catch { /* */ }
  applyDir();
}
export function setLang(lang) {
  LANG = (lang === 'tr' || CAT[lang]) ? lang : 'tr';
  try { localStorage.setItem('caymaz.lang', LANG); } catch { /* */ }
  try { document.documentElement.lang = LANG; } catch { /* */ }
  applyDir();
  listeners.forEach(fn => { try { fn(LANG); } catch { /* */ } });
}
export function onLangChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }

// Çeviri: kaynak Türkçe metin → geçerli dildeki karşılığı (yoksa Türkçe). p ile {anahtar} değişkenleri doldurulur.
export function t(s, p) {
  let o = s;
  if (LANG !== 'tr') { const c = CAT[LANG]; if (c && c[s] != null) o = c[s]; }
  if (p) for (const k in p) o = o.split('{' + k + '}').join(p[k]);
  return o;
}
