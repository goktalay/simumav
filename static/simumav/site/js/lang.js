// SIMUMAV dil seçimi — saf, DOM'suz (tanıtım sitesi + oyun kabuğu + node testi aynı dosyayı kullanır).
// Kural (docs/simumav.md §5.1): ?lang=xx > kayıtlı tercih (localStorage) > tarayıcı dilleri (navigator.languages sırası) > İngilizce.
export const LANGS = ['tr', 'en', 'de', 'fr', 'es', 'ru', 'ar'];
export const RTL = new Set(['ar']);
export const DEFAULT_LANG = 'en';

/** "de-DE" / "pt_BR" / "zh-Hant-TW" → iki harfli küçük kod; geçersiz girdi → ''. */
export const langCode = tag => String(tag || '').trim().slice(0, 2).toLowerCase().replace(/[^a-z]/g, '');

/** Tarayıcı dil listesinden desteklenen ilk dil; yoksa yedek (en). */
export function fromBrowser(languages, supported = LANGS, fallback = DEFAULT_LANG) {
  for (const tag of Array.isArray(languages) ? languages : [languages]) {
    const c = langCode(tag);
    if (c && supported.includes(c)) return c;
  }
  return fallback;
}

/**
 * pickLang({ query, stored, languages, supported, fallback }) → dil kodu.
 *   query     : URL ?lang değeri (reklam bağlantıları; her şeyi ezer)
 *   stored    : kullanıcının seçtiği/kayıtlı dil (localStorage ya da hesap ayarı)
 *   languages : navigator.languages (ya da [navigator.language])
 */
export function pickLang({ query, stored, languages, supported = LANGS, fallback = DEFAULT_LANG } = {}) {
  const q = langCode(query);
  if (q && supported.includes(q)) return q;
  const s = langCode(stored);
  if (s && supported.includes(s)) return s;
  return fromBrowser(languages || [], supported, fallback);
}

/** Tarayıcı ortamından değerleri toplar (DOM var ise). storageKey: 'simumav.lang' (site) ya da 'sm:lang' (oyun kabuğu). */
export function detectLang(storageKey, { stored } = {}) {
  let query = null, saved = stored ?? null;
  try { query = new URLSearchParams(globalThis.location?.search || '').get('lang'); } catch { /* yok */ }
  if (saved == null && storageKey) { try { saved = globalThis.localStorage?.getItem(storageKey); } catch { /* özel mod */ } }
  const nav = globalThis.navigator;
  const languages = nav?.languages?.length ? nav.languages : [nav?.language].filter(Boolean);
  return pickLang({ query, stored: saved, languages });
}
