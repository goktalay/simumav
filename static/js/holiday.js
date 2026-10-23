// HEPGO bayram temaları (docs/bayram-temalari.md) — ortak modül modules/holiday_fx.js'i kabuğa bağlar.
// Ayar: Kişisel Ayarlar › Bayram temaları (users.prefs.settings.holiday = { on: true (varsayılan), country: '' (otomatik) | 'TR' … }).
// Ülke: ayar → kullanıcının girdiği konum (sunucu /api/holiday-theme/me: kendi adresi → firmadaki adreslerin çoğunluğu) → saat dilimi → tarayıcı dili.
// Yerleşim: YALNIZ pano (ana sayfa) — üst çubuk ile alt bilgi arasında, pano kutucuklarının ARKASINDA (z -1; "Gövde arka planı" desenleri gibi
// kart boşluklarından ve kenarlardan görünür, içeriği örtmez); ilk 14 sn tam, sonra sakin (ambient) kip; başka sayfalarda ve
// Uçuş Simülatörü sahnesi (.fs-stage) açıkken gizli. "Hareketleri azalt" (Arayüz) ya da sistemin reduced-motion'ı → yalnız durağan köşe süsü.
// Önizleme: /?bayram=<tema> (herkes; yalnız görsel) ya da Kişisel Ayarlar › Bayram temaları › Temayı önizle (Sistem Yöneticisi / MASTER).
import { api } from './api.js';
import { getLang } from './i18n.js';
import { simActive } from './simfocus.js';
import { mountHolidayFx } from './modules/holiday_fx.js';

let H = null, me = null, ctxRef = null, calmT = 0, hashBound = false;
const onDashboard = () => !location.hash.replace(/^#\/?/, '').split('/').filter(Boolean).length;
const headerH = () => document.querySelector('.app-header')?.getBoundingClientRect().height || 64;
const footerH = () => document.querySelector('.app-footer')?.getBoundingClientRect().height || 0;

export const holidaySettings = user => ({ on: true, country: '', ...(user?.prefs?.settings?.holiday || {}) });

/** Kabuk kurulunca ve ayar değişince çağrılır. preview: { themes:[…], country } (ayarlardan önizleme). */
let token = 0;
export async function initHoliday(ctx, { preview = null } = {}) {
  ctxRef = ctx;
  const my = ++token;   // üst üste çağrılırsa (kabuk + ayarlar) yalnız sonuncusu kalır; yetim katman olmaz
  H?.destroy(); H = null; clearTimeout(calmT);
  const hs = holidaySettings(ctx.user);
  if (!me) { try { me = await api.get('/api/holiday-theme/me'); } catch { me = {}; } }
  if (my !== token) return H;
  try {
    const h = await mountHolidayFx({
      enabled: hs.on !== false, country: hs.country || '', located: me?.located, lang: getLang?.() || 'tr', preview,
      zIndex: -1, top: headerH(), bottom: footerH(), bannerTop: headerH() + 12, bannerZ: 25, banner: onDashboard() || !!preview,
      reduced: () => document.documentElement.classList.contains('reduce-motion'),
      inFlight: () => simActive() || !onDashboard() || document.body.classList.contains('fv-open'),
    });
    if (my !== token) { h?.destroy(); return H; }
    H = h;
  } catch (e) { console.warn('bayram teması', e); H = null; }
  calmT = setTimeout(() => H?.setMode('ambient'), preview ? 30000 : 14000);   // açılış kutlaması → sakin kip (iş ekranını yormasın)
  if (!hashBound) {
    hashBound = true;
    addEventListener('hashchange', () => { if (onDashboard()) H?.setMode('ambient'); });
  }
  return H;
}
export const holidayState = () => ({ me, detected: H?.detected || null, picked: H?.picked || null, info: H?.info || null });
export const refreshHoliday = opts => (ctxRef ? initHoliday(ctxRef, opts) : null);
export function stopHoliday() { H?.destroy(); H = null; clearTimeout(calmT); }
