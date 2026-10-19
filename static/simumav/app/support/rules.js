// Destek — saf kurallar (DOM/i18n bağımsız; node testinde doğrudan içe aktarılır): kategoriler, sınırlar, dosya kabulü, bağlam özeti.
export const CATEGORIES = ['flight', 'account', 'hangar', 'track', 'mp', 'perf', 'other'];
export const MAX_SUBJECT = 120, MAX_BODY = 4000, MAX_FILE = 3 * 1024 * 1024;
export const STATUS_CLS = { acik: 'open', yanit_bekliyor: 'wait', cozuldu: 'ok', kapali: 'closed' };

/** Dosya kabul kuralı → null (uygun) | i18n hata anahtarı. */
export function fileProblem(file) {
  if (!file) return 'support.shot_none';
  if (!/^image\/(png|jpe?g)$/.test(file.type || '')) return 'support.shot_badtype';
  if (file.size > MAX_FILE) return 'support.shot_toolarge';
  return null;
}

/** Sunucuya gönderilen ham bağlam alanları (sunucu metni kendisi biçimler; §9). */
export function collectContext({ ua = '', lang = '', width = 0, height = 0, dpr = 1, flightId = null, route = '', gl = null } = {}) {
  return { ua: String(ua).slice(0, 300), lang: String(lang).slice(0, 12), screen: `${width}x${height}@${Number(dpr || 1).toFixed(1)}`, gl: gl ? String(gl).slice(0, 200) : null,
    flight_id: flightId || null, route: String(route || '').slice(0, 80) };
}
