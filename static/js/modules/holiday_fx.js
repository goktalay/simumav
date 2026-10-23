// Bayram / tatil temaları — ORTAK istemci modülü (HEPGO static/js, SIMUMAV oyun /sim/holiday_fx.js ve tanıtım sitesi; dışa aktarma manifestinde).
//  · Saf mantık (DOM'suz; node testleri): ülke tespiti (kullanıcı ayarı → sunucunun bildiği konum → saat dilimi → tarayıcı dili bölgesi; IP sorgusu YOK),
//    aynı gün birden çok bayram → birleşik tema (öncelik sırası sunucu app/holiday_themes.py THEMES ile aynı), arife (13.00'ten önce kapalı), kare bütçesi,
//    7 dilde kutlama metni.
//  · Efekt motoru: TEK tam ekran Canvas2D katmanı (pointer-events: none), tema çizimleri ./holiday_fx_themes.js (prosedürel/vektör; tembel yüklenir).
//    prefers-reduced-motion → yalnız durağan köşe süsü (tek kare); sekme gizli → döngü durur; düşük güç → 24 fps + az parçacık;
//    uçuş sahnesi (HEPGO .fs-stage / SIMUMAV #view.sm-fly-session) → katman KAPALI (inFlight() geri çağrısı).
//  · Önizleme: URL ?bayram=<tema>[,<tema2>][&bayram_ulke=TR] ya da mountHolidayFx({ preview }) — 20 temayı tarih beklemeden görmek için.
import { TZ_COUNTRY } from './holiday_tz.js';

export const THEMES = ['kurban', 'ramazan', 'hicri', 'noel', 'paskalya', 'hristiyan', 'yilbasi', 'cin_yeni', 'diwali', 'holi', 'hindu', 'yahudi',
  'cocuk_genclik', 'kadin_anne', 'sevgi', 'cadilar', 'bagimsizlik', 'emek', 'bahar', 'genel'];
export const LANGS = ['tr', 'en', 'de', 'fr', 'es', 'ru', 'ar'];
const PRI = Object.fromEntries(THEMES.map((t, i) => [t, i]));

// Kutlama şeridi metni (7 dil). Bayram adı sunucudan yerel dilde gelir; bu, temaya göre genel kutlama cümlesidir.
export const GREET = {
  kurban: { tr: 'Kurban Bayramınız mübarek olsun!', en: 'Eid al-Adha Mubarak!', de: 'Gesegnetes Opferfest!', fr: 'Aïd al-Adha moubarak !', es: '¡Feliz Eid al-Adha!', ru: 'С праздником Курбан-байрам!', ar: 'عيد أضحى مبارك!' },
  ramazan: { tr: 'Ramazan Bayramınız mübarek olsun!', en: 'Eid Mubarak!', de: 'Gesegnetes Zuckerfest!', fr: 'Aïd al-Fitr moubarak !', es: '¡Feliz Eid al-Fitr!', ru: 'С праздником Ураза-байрам!', ar: 'عيد فطر مبارك!' },
  hicri: { tr: 'Mübarek gününüz kutlu olsun!', en: 'Blessed day!', de: 'Gesegneten Feiertag!', fr: 'Bonne fête bénie !', es: '¡Bendito día!', ru: 'Благословенного праздника!', ar: 'يوم مبارك!' },
  noel: { tr: 'Mutlu Noeller!', en: 'Merry Christmas!', de: 'Frohe Weihnachten!', fr: 'Joyeux Noël !', es: '¡Feliz Navidad!', ru: 'Счастливого Рождества!', ar: 'عيد ميلاد مجيد!' },
  paskalya: { tr: 'Mutlu Paskalyalar!', en: 'Happy Easter!', de: 'Frohe Ostern!', fr: 'Joyeuses Pâques !', es: '¡Felices Pascuas!', ru: 'Светлой Пасхи!', ar: 'فصح مجيد!' },
  hristiyan: { tr: 'Kutlu bayramlar!', en: 'Happy holiday!', de: 'Schönen Feiertag!', fr: 'Bonne fête !', es: '¡Feliz festividad!', ru: 'С праздником!', ar: 'عيد سعيد!' },
  yilbasi: { tr: 'Mutlu yıllar!', en: 'Happy New Year!', de: 'Frohes neues Jahr!', fr: 'Bonne année !', es: '¡Feliz Año Nuevo!', ru: 'С Новым годом!', ar: 'سنة جديدة سعيدة!' },
  cin_yeni: { tr: 'Mutlu Ay Yeni Yılı!', en: 'Happy Lunar New Year!', de: 'Frohes Mondneujahr!', fr: 'Bonne année lunaire !', es: '¡Feliz Año Nuevo Lunar!', ru: 'С Новым годом по лунному календарю!', ar: 'سنة قمرية جديدة سعيدة!' },
  diwali: { tr: 'Mutlu Diwali!', en: 'Happy Diwali!', de: 'Frohes Diwali!', fr: 'Joyeux Diwali !', es: '¡Feliz Diwali!', ru: 'Счастливого Дивали!', ar: 'ديوالي سعيد!' },
  holi: { tr: 'Mutlu Holi!', en: 'Happy Holi!', de: 'Frohes Holi!', fr: 'Joyeux Holi !', es: '¡Feliz Holi!', ru: 'Счастливого Холи!', ar: 'هولي سعيد!' },
  hindu: { tr: 'Kutlu bayramlar!', en: 'Happy festival!', de: 'Schönes Fest!', fr: 'Bonne fête !', es: '¡Feliz festividad!', ru: 'С праздником!', ar: 'عيد سعيد!' },
  yahudi: { tr: 'Mutlu bayramlar!', en: 'Happy holidays!', de: 'Schöne Feiertage!', fr: 'Joyeuses fêtes !', es: '¡Felices fiestas!', ru: 'С праздником!', ar: 'أعياد سعيدة!' },
  cocuk_genclik: { tr: 'Bayramınız kutlu olsun!', en: 'Happy holiday!', de: 'Schönen Feiertag!', fr: 'Bonne fête !', es: '¡Feliz día!', ru: 'С праздником!', ar: 'عيد سعيد!' },
  kadin_anne: { tr: 'Gününüz kutlu olsun!', en: 'Happy day!', de: 'Alles Gute zum Ehrentag!', fr: 'Bonne fête !', es: '¡Feliz día!', ru: 'С праздником!', ar: 'يوم سعيد!' },
  sevgi: { tr: 'Sevgiler günü kutlu olsun!', en: "Happy Valentine's Day!", de: 'Alles Liebe zum Valentinstag!', fr: 'Joyeuse Saint-Valentin !', es: '¡Feliz San Valentín!', ru: 'С Днём святого Валентина!', ar: 'عيد حب سعيد!' },
  cadilar: { tr: 'Mutlu Cadılar Bayramı!', en: 'Happy Halloween!', de: 'Fröhliches Halloween!', fr: 'Joyeux Halloween !', es: '¡Feliz Halloween!', ru: 'Весёлого Хэллоуина!', ar: 'هالوين سعيد!' },
  bagimsizlik: { tr: 'Bayramınız kutlu olsun!', en: 'Happy national day!', de: 'Schönen Nationalfeiertag!', fr: 'Bonne fête nationale !', es: '¡Feliz día nacional!', ru: 'С национальным праздником!', ar: 'عيد وطني سعيد!' },
  emek: { tr: 'Emek ve Dayanışma Günü kutlu olsun!', en: 'Happy Labour Day!', de: 'Schönen Tag der Arbeit!', fr: 'Bonne fête du Travail !', es: '¡Feliz Día del Trabajo!', ru: 'С Днём труда!', ar: 'عيد عمال سعيد!' },
  bahar: { tr: 'Bahar bayramınız kutlu olsun!', en: 'Happy spring festival!', de: 'Schönes Frühlingsfest!', fr: 'Bonne fête du printemps !', es: '¡Feliz fiesta de primavera!', ru: 'С весенним праздником!', ar: 'عيد ربيع سعيد!' },
  genel: { tr: 'İyi tatiller!', en: 'Happy holiday!', de: 'Schönen Feiertag!', fr: 'Bonne fête !', es: '¡Feliz feriado!', ru: 'С праздником!', ar: 'عطلة سعيدة!' },
};
// Tema adları (7 dil) — ayarlardaki önizleme seçicisi ve teşhis için
const TN = {
  kurban: ['Kurban Bayramı', 'Eid al-Adha', 'Opferfest', 'Aïd al-Adha', 'Eid al-Adha', 'Курбан-байрам', 'عيد الأضحى'],
  ramazan: ['Ramazan Bayramı', 'Eid al-Fitr', 'Zuckerfest', 'Aïd al-Fitr', 'Eid al-Fitr', 'Ураза-байрам', 'عيد الفطر'],
  hicri: ['Hicri yılbaşı · Mevlid · Kandiller', 'Islamic New Year · Mawlid', 'Islamisches Neujahr · Maulid', 'Nouvel An islamique · Mawlid', 'Año Nuevo islámico · Mawlid', 'Исламский Новый год · Мавлид', 'رأس السنة الهجرية · المولد'],
  noel: ['Noel', 'Christmas', 'Weihnachten', 'Noël', 'Navidad', 'Рождество', 'عيد الميلاد'],
  paskalya: ['Paskalya', 'Easter', 'Ostern', 'Pâques', 'Pascua', 'Пасха', 'عيد الفصح'],
  hristiyan: ['Diğer Hristiyan günleri', 'Other Christian days', 'Weitere christliche Feiertage', 'Autres fêtes chrétiennes', 'Otras fiestas cristianas', 'Другие христианские праздники', 'أعياد مسيحية أخرى'],
  yilbasi: ['Yılbaşı', 'New Year', 'Neujahr', 'Nouvel An', 'Año Nuevo', 'Новый год', 'رأس السنة'],
  cin_yeni: ['Ay Yeni Yılı', 'Lunar New Year', 'Mondneujahr', 'Nouvel An lunaire', 'Año Nuevo Lunar', 'Лунный Новый год', 'رأس السنة القمرية'],
  diwali: ['Diwali', 'Diwali', 'Diwali', 'Diwali', 'Diwali', 'Дивали', 'ديوالي'],
  holi: ['Holi', 'Holi', 'Holi', 'Holi', 'Holi', 'Холи', 'هولي'],
  hindu: ['Hindu · Budist · Sih günleri', 'Hindu, Buddhist & Sikh days', 'Hinduistische, buddhistische & Sikh-Feste', 'Fêtes hindoues, bouddhistes et sikhes', 'Fiestas hindúes, budistas y sijs', 'Индуистские, буддийские и сикхские праздники', 'أعياد هندوسية وبوذية وسيخية'],
  yahudi: ['Yahudi bayramları', 'Jewish holidays', 'Jüdische Feiertage', 'Fêtes juives', 'Fiestas judías', 'Еврейские праздники', 'الأعياد اليهودية'],
  cocuk_genclik: ['Çocuk · Gençlik · Öğretmen', 'Children, Youth & Teachers', 'Kinder, Jugend & Lehrer', 'Enfants, jeunesse et enseignants', 'Niños, juventud y docentes', 'Дети, молодёжь, учителя', 'الأطفال والشباب والمعلمون'],
  kadin_anne: ['Kadınlar · Anneler · Aile', 'Women, Mothers & Family', 'Frauen, Mütter & Familie', 'Femmes, mères et famille', 'Mujeres, madres y familia', 'Женщины, матери, семья', 'المرأة والأم والأسرة'],
  sevgi: ['Sevgililer Günü', "Valentine's Day", 'Valentinstag', 'Saint-Valentin', 'San Valentín', 'День святого Валентина', 'عيد الحب'],
  cadilar: ['Cadılar Bayramı', 'Halloween', 'Halloween', 'Halloween', 'Halloween', 'Хэллоуин', 'الهالوين'],
  bagimsizlik: ['Ulusal gün · Cumhuriyet · Bağımsızlık', 'National · Independence day', 'Nationalfeiertag', 'Fête nationale', 'Fiesta nacional', 'Национальный праздник', 'العيد الوطني'],
  emek: ['Emek ve Dayanışma Günü', 'Labour Day', 'Tag der Arbeit', 'Fête du Travail', 'Día del Trabajo', 'День труда', 'عيد العمال'],
  bahar: ['Bahar · Nevruz · Hasat', 'Spring · Nowruz · Harvest', 'Frühling · Nouruz · Ernte', 'Printemps · Norouz · Moisson', 'Primavera · Nouruz · Cosecha', 'Весна · Навруз · Урожай', 'الربيع · النوروز · الحصاد'],
  genel: ['Diğer resmî tatiller', 'Other public holidays', 'Andere Feiertage', 'Autres jours fériés', 'Otros feriados', 'Другие праздники', 'عطل رسمية أخرى'],
};
export const themeName = (code, lang = 'tr') => (TN[code] || TN.genel)[Math.max(0, LANGS.indexOf(lang))] || code;
/** Ülke adı (tarayıcının Intl.DisplayNames'i; yoksa kod). */
export function countryName(code, lang = 'tr') {
  try { return new Intl.DisplayNames([lang], { type: 'region' }).of(code) || code; } catch { return code; }
}
const DAY_FMT = { tr: '{i}. gün / {n}', en: 'day {i} of {n}', de: 'Tag {i} von {n}', fr: 'jour {i} sur {n}', es: 'día {i} de {n}', ru: 'день {i} из {n}', ar: 'اليوم {i} من {n}' };
const PREVIEW_LBL = { tr: 'Önizleme', en: 'Preview', de: 'Vorschau', fr: 'Aperçu', es: 'Vista previa', ru: 'Предпросмотр', ar: 'معاينة' };

/** Kutlama şeridi metni: { title, sub } (saf). */
export function greeting(item, lang = 'tr') {
  const l = LANGS.includes(lang) ? lang : 'en';
  const g = GREET[item?.theme] || GREET.genel;
  const title = g[l] || g.en;
  const parts = [];
  if (item?.name) parts.push(item.name);
  if (item?.days_total > 1) parts.push((DAY_FMT[l] || DAY_FMT.en).replace('{i}', item.day_index).replace('{n}', item.days_total));
  if (item?.preview) parts.push(PREVIEW_LBL[l] || PREVIEW_LBL.en);
  return { title, sub: parts.join(' · ') };
}

// ---------------------------------------------------------------- ülke tespiti (saf)
export const normCountry = c => { const s = String(c || '').trim().toUpperCase(); return /^[A-Z]{2}$/.test(s) ? s : null; };
/** IANA saat dilimi → ülke (zone.tab + eski adlar). */
export const countryFromTz = tz => (tz && TZ_COUNTRY[tz]) || null;
/** navigator.languages → bölge kodu ('tr-TR' → TR; 'en' → null). */
export function countryFromLangs(langs = []) {
  for (const l of langs || []) {
    const m = String(l || '').match(/^[a-z]{2,3}[-_](?:[A-Za-z]{4}[-_])?([A-Za-z]{2})\b/);
    if (m) return m[1].toUpperCase();
  }
  return null;
}
export function browserTz() { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || null; } catch { return null; } }
/** Öncelik: kullanıcının seçtiği ülke → kullanıcının girdiği konumdan (sunucu: parkur / adres) → saat dilimi → tarayıcı dili bölgesi. */
export function detectCountry({ setting = null, located = null, tz = undefined, langs = undefined } = {}) {
  const s = normCountry(setting);
  if (s) return { country: s, source: 'setting' };
  const loc = normCountry(located);
  if (loc) return { country: loc, source: 'location' };
  const tzc = countryFromTz(tz === undefined ? browserTz() : tz);
  if (tzc) return { country: tzc, source: 'timezone' };
  const lc = countryFromLangs(langs === undefined ? (globalThis.navigator?.languages || [globalThis.navigator?.language]) : langs);
  if (lc) return { country: lc, source: 'language' };
  return { country: null, source: null };
}

// ---------------------------------------------------------------- tema seçimi (saf)
/** Yerel tarih (YYYY-MM-DD) — kullanıcının günü (sunucu saati değil). */
export function localDate(d = new Date()) {
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
/** Arife (yarım gün) 13.00'ten önce etkin değil. */
export const isActiveNow = (item, now = new Date()) => !!item && (!item.half_day || now.getHours() >= 13);
/** Sunucu yanıtı → { primary, secondary, items }: öncelik sırası (dini bayram önce), en çok iki tema birleşir (TR 19 Mayıs 2027 = Kurban + Gençlik). */
export function pickThemes(active = [], now = new Date()) {
  const items = (active || []).filter(it => it && THEMES.includes(it.theme) && isActiveNow(it, now))
    .sort((a, b) => (PRI[a.theme] ?? 99) - (PRI[b.theme] ?? 99));
  const uniq = [];
  for (const it of items) if (!uniq.some(u => u.theme === it.theme)) uniq.push(it);
  // "genel" yalnız başka tema yoksa (resmî tatil rozeti); asıl bayramın yanında gürültü yapmasın
  const main = uniq.filter(u => u.theme !== 'genel');
  const list = main.length ? main : uniq;
  return { primary: list[0] || null, secondary: list[1] || null, items: list };
}
/** URL önizleme parametresi: ?bayram=kurban,cocuk_genclik&bayram_ulke=TR → { themes, country } | null (saf; search enjekte edilir). */
export function previewFromSearch(search = globalThis.location?.search || '') {
  let q;
  try { q = new URLSearchParams(search); } catch { return null; }
  const raw = q.get('bayram') || q.get('holiday');
  if (!raw) return null;
  const themes = raw.split(',').map(s => s.trim()).filter(t => THEMES.includes(t)).slice(0, 2);
  if (!themes.length) return null;
  return { themes, country: normCountry(q.get('bayram_ulke') || q.get('holiday_country')) };
}
/** Önizleme öğeleri (sunucu yanıtı biçiminde). */
export const previewItems = (themes, country = null) => themes.map(t => ({ theme: t, name: '', country, day_index: 1, days_total: 1, preview: true }));

/** Kare bütçesi (saf): reduced → durağan; düşük güç → 24 fps, yoğunluk 0,5; 'ambient' kip (HEPGO pano sakin hâli) → yoğunluk ×0,35. */
export function fxBudget({ reduced = false, lowPower = false, mode = 'full', dpr = 1 } = {}) {
  const amb = mode === 'ambient' ? 0.35 : 1;
  return { animate: !reduced, fps: lowPower ? 24 : 40, density: (lowPower ? 0.5 : 1) * amb, scale: Math.min(lowPower ? 1 : 1.5, Math.max(1, dpr)) };
}
export function isLowPower(nav = globalThis.navigator, coarse = false) {
  const cores = Number(nav?.hardwareConcurrency) || 8, mem = Number(nav?.deviceMemory) || 8;
  return !!(coarse || cores <= 4 || mem <= 4 || nav?.connection?.saveData);
}
export const flagUrl = c => (normCountry(c) ? `/static/vendor/flag-icons/4x3/${normCountry(c).toLowerCase()}.svg` : null);

// ---------------------------------------------------------------- sunucu
/** GET /api/holiday-theme (oturumsuz). fetchFn enjekte edilebilir (test). */
export async function fetchHoliday(country, { date = localDate(), lang = 'tr', base = '', fetchFn = globalThis.fetch } = {}) {
  const c = normCountry(country);
  if (!c || !fetchFn) return null;
  const r = await fetchFn(`${base}/api/holiday-theme?country=${c}&date=${encodeURIComponent(date)}&lang=${encodeURIComponent(lang)}`, { credentials: 'same-origin' });
  if (!r.ok) return null;
  return r.json();
}

// ---------------------------------------------------------------- efekt motoru (DOM)
/**
 * createHolidayFx({ zIndex, themes: [primary, secondary?], country, mode: 'full'|'ambient', inFlight: () => bool, parent })
 * → { setMode, setThemes, destroy, state, canvas }
 */
export function createHolidayFx(opts = {}) {
  const doc = globalThis.document;
  if (!doc) return null;
  const S = { themes: (opts.themes || []).filter(Boolean), country: normCountry(opts.country), mode: opts.mode || 'full', raf: 0, last: 0, t0: 0, frames: 0, avg: 0,
    W: 0, H: 0, k: 1, scene: null, mod: null, token: 0, destroyed: false, reduced: false, lowPower: false, B: null, hiddenByFlight: false };
  const cv = doc.createElement('canvas');
  cv.className = 'holiday-fx';
  cv.setAttribute('aria-hidden', 'true');
  const top = Math.max(0, Number(opts.top) || 0), bottom = Math.max(0, Number(opts.bottom) || 0);   // HEPGO: üst çubuk ile alt bilgi arası
  Object.assign(cv.style, { position: 'fixed', left: '0', right: '0', top: `${top}px`, width: '100%', height: `calc(100% - ${top + bottom}px)`, pointerEvents: 'none', zIndex: String(opts.zIndex ?? 2),
    opacity: '0', transition: 'opacity .8s ease' });
  if (opts.before?.parentNode) opts.before.parentNode.insertBefore(cv, opts.before);   // içeriğin ARKASINDA (aynı z-index'te DOM sırası)
  else (opts.parent || doc.body).append(cv);
  const g = cv.getContext('2d');
  const mqR = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)');
  const forceReduced = () => { try { return typeof opts.reduced === 'function' ? !!opts.reduced() : !!opts.reduced; } catch { return false; } };
  const inFlight = () => { try { return !!opts.inFlight?.(); } catch { return false; } };

  function resize() {
    const dpr = globalThis.devicePixelRatio || 1;
    S.B = fxBudget({ reduced: S.reduced, lowPower: S.lowPower, mode: S.mode, dpr });
    S.k = S.B.scale;
    S.W = Math.max(64, innerWidth); S.H = Math.max(64, innerHeight - top - bottom);
    cv.width = Math.round(S.W * S.k); cv.height = Math.round(S.H * S.k);
    S.scene?.resize?.(S.W, S.H);
  }
  function frame(t, dt) {
    g.setTransform(S.k, 0, 0, S.k, 0, 0);
    g.clearRect(0, 0, S.W, S.H);
    if (!S.scene) return;
    const a = performance.now();
    S.scene.frame(g, t, dt);
    const ms = performance.now() - a;
    S.frames++; if (S.frames > 5) S.avg = S.avg ? S.avg * 0.93 + ms * 0.07 : ms;
  }
  function loop(now) {
    S.raf = requestAnimationFrame(loop);
    if (now - S.last < 1000 / S.B.fps - 2) return;
    const dt = Math.min(0.1, (now - (S.last || now)) / 1000); S.last = now;
    if (inFlight()) { if (!S.hiddenByFlight) { S.hiddenByFlight = true; cv.style.opacity = '0'; g.clearRect(0, 0, cv.width, cv.height); } return; }
    if (S.hiddenByFlight) { S.hiddenByFlight = false; cv.style.opacity = '1'; }
    try { frame((now - S.t0) / 1000, dt); } catch (e) { console.error('bayram efekti', e); stop(); }
  }
  function start() { if (S.raf || !S.scene || doc.hidden || !S.B?.animate || S.destroyed) return; S.last = 0; S.raf = requestAnimationFrame(loop); }
  function stop() { if (S.raf) cancelAnimationFrame(S.raf); S.raf = 0; }
  // Durağan kip (reduced motion / uçuş): tek kare, yalnız köşe süsü
  let stillTimer = 0;
  function drawStill() {
    if (inFlight()) { cv.style.opacity = '0'; return; }
    g.setTransform(S.k, 0, 0, S.k, 0, 0); g.clearRect(0, 0, S.W, S.H);
    try { S.scene?.still?.(g); } catch (e) { console.error('bayram efekti', e); }
    cv.style.opacity = '1';
  }
  async function build() {
    const token = ++S.token;
    stop();
    try { S.scene?.dispose?.(); } catch { /* */ }
    S.scene = null;
    if (!S.themes.length || S.destroyed) { cv.style.opacity = '0'; return; }
    S.reduced = !!mqR?.matches || forceReduced();
    S.lowPower = isLowPower(globalThis.navigator, !!globalThis.matchMedia?.('(pointer: coarse)').matches && innerWidth < 900);
    S.mod ??= await import('./holiday_fx_themes.js');
    if (token !== S.token || S.destroyed) return;
    resize();
    S.scene = S.mod.createScene(S.themes.map(t => t.theme || t), { W: S.W, H: S.H, density: S.B.density, country: S.country, lowPower: S.lowPower,
      dark: doc.documentElement.dataset.theme === 'dark', figAlpha: opts.figAlpha, ground: opts.ground });
    S.frames = 0; S.avg = 0; S.t0 = performance.now() - (opts.warm ?? 4000);   // birkaç saniye ileriden: açılışta sahne dolu görünsün
    if (!S.B.animate) { drawStill(); return; }
    frame((performance.now() - S.t0) / 1000, 0);
    requestAnimationFrame(() => { if (token === S.token && !inFlight()) cv.style.opacity = '1'; });
    start();
  }
  const onResize = () => { if (!S.scene) return; resize(); if (!S.raf) drawStill(); };
  const onVis = () => { if (doc.hidden) stop(); else start(); };
  const onMq = () => build();
  addEventListener('resize', onResize);
  doc.addEventListener('visibilitychange', onVis);
  mqR?.addEventListener?.('change', onMq);
  if (!S.B) S.B = fxBudget({});
  build();
  // reduced kipte uçuş açılıp kapanırsa durağan kare de gizlenip geri gelsin (döngü yok → seyrek yoklama)
  stillTimer = setInterval(() => { if (S.scene && !S.raf && !S.destroyed) { if (inFlight()) cv.style.opacity = '0'; else if (cv.style.opacity === '0' && !S.B.animate) drawStill(); } }, 1500);
  return {
    canvas: cv,
    setMode(m) { if (m === S.mode) return; S.mode = m; if (S.scene) { const dens = fxBudget({ reduced: S.reduced, lowPower: S.lowPower, mode: m }).density; S.B.density = dens; S.scene.setDensity?.(dens); } },
    setThemes(themes, country) { S.themes = (themes || []).filter(Boolean); if (country !== undefined) S.country = normCountry(country); build(); },
    pause: stop, resume: start,
    destroy() { S.destroyed = true; stop(); clearInterval(stillTimer); try { S.scene?.dispose?.(); } catch { /* */ } removeEventListener('resize', onResize); doc.removeEventListener('visibilitychange', onVis); mqR?.removeEventListener?.('change', onMq); cv.remove(); },
    state: () => ({ themes: S.themes.map(t => t.theme || t), country: S.country, mode: S.mode, running: !!S.raf, frames: S.frames, avgMs: +S.avg.toFixed(3),
      fps: S.B?.fps, density: S.B?.density, reduced: S.reduced, lowPower: S.lowPower, inFlight: S.hiddenByFlight }),
  };
}

// ---------------------------------------------------------------- kutlama şeridi (DOM)
const BANNER_CSS = `.hfx-banner{position:fixed;left:50%;top:var(--hfx-top,14px);transform:translate(-50%,-140%);z-index:var(--hfx-z,30);display:flex;align-items:center;gap:12px;
max-width:min(620px,calc(100vw - 24px));padding:10px 14px 10px 12px;border-radius:16px;background:linear-gradient(135deg,rgba(15,23,42,.88),rgba(30,41,59,.84));
color:#f8fafc;border:1px solid rgba(255,255,255,.18);box-shadow:0 12px 40px rgba(0,0,0,.35);backdrop-filter:blur(12px);font:500 14px/1.35 system-ui,sans-serif;
transition:transform .7s cubic-bezier(.2,.9,.25,1.15),opacity .5s;opacity:0;pointer-events:auto}
.hfx-banner.on{transform:translate(-50%,0);opacity:1}
.hfx-banner .hfx-ic{width:34px;height:34px;flex:none;border-radius:50%;display:grid;place-items:center;background:radial-gradient(circle at 35% 30%,#fde68a,#f59e0b);color:#78350f;font-size:18px}
.hfx-banner .hfx-flag{width:30px;height:22px;flex:none;border-radius:4px;box-shadow:0 0 0 1px rgba(255,255,255,.35);object-fit:cover}
.hfx-banner b{display:block;font-size:15px;letter-spacing:.01em}.hfx-banner small{display:block;opacity:.78;font-size:12px}
.hfx-banner button{margin-inline-start:6px;flex:none;width:28px;height:28px;border-radius:50%;border:0;background:rgba(255,255,255,.12);color:inherit;cursor:pointer;font-size:16px;line-height:1}
.hfx-banner button:hover{background:rgba(255,255,255,.25)}
@media (prefers-reduced-motion: reduce){.hfx-banner{transition:opacity .3s}}`;
const ICON = { kurban: '☾', ramazan: '☾', hicri: '☾', noel: '❄', paskalya: '✿', hristiyan: '✝', yilbasi: '✦', cin_yeni: '福', diwali: '✺', holi: '✺', hindu: '❀',
  yahudi: '✡', cocuk_genclik: '✈', kadin_anne: '❀', sevgi: '♥', cadilar: '☽', bagimsizlik: '★', emek: '✿', bahar: '❀', genel: '✦' };

/** Kutlama şeridi: günde bir kez (anahtar: tema+tarih+ülke), ~9 sn sonra kendiliğinden kapanır. force → her zaman. */
export function showBanner(item, { lang = 'tr', top = null, zIndex = null, force = false, storage = globalThis.localStorage, ms = 9000 } = {}) {
  const doc = globalThis.document;
  if (!doc || !item) return null;
  const key = `hfx:seen:${item.theme}:${item.date || localDate()}:${item.country || ''}`;
  try { if (!force && !item.preview && storage?.getItem(key)) return null; storage?.setItem(key, '1'); } catch { /* özel mod */ }
  if (!doc.getElementById('hfx-css')) { const st = doc.createElement('style'); st.id = 'hfx-css'; st.textContent = BANNER_CSS; doc.head.append(st); }
  doc.querySelector('.hfx-banner')?.remove();
  const { title, sub } = greeting(item, lang);
  const el = doc.createElement('div');
  el.className = 'hfx-banner'; el.setAttribute('role', 'status');
  if (top != null) el.style.setProperty('--hfx-top', typeof top === 'number' ? `${top}px` : top);
  if (zIndex != null) el.style.setProperty('--hfx-z', String(zIndex));
  const fu = item.theme === 'bagimsizlik' || item.theme === 'genel' ? flagUrl(item.country) : null;
  const ic = fu ? Object.assign(doc.createElement('img'), { className: 'hfx-flag', src: fu, alt: '' }) : Object.assign(doc.createElement('span'), { className: 'hfx-ic', textContent: ICON[item.theme] || '✦' });
  const txt = doc.createElement('span');
  const b = doc.createElement('b'); b.textContent = title;
  const s = doc.createElement('small'); s.textContent = sub;
  txt.append(b, s);
  const x = doc.createElement('button'); x.type = 'button'; x.textContent = '×'; x.setAttribute('aria-label', lang === 'tr' ? 'Kapat' : 'Close');
  el.append(ic, txt, x);
  doc.body.append(el);
  const close = () => { el.classList.remove('on'); setTimeout(() => el.remove(), 700); };
  x.addEventListener('click', close);
  requestAnimationFrame(() => requestAnimationFrame(() => el.classList.add('on')));
  if (ms) setTimeout(close, ms);
  return { el, close };
}

// ---------------------------------------------------------------- tek çağrıda bağlama (HEPGO / SIMUMAV oyun / tanıtım sitesi)
/**
 * mountHolidayFx({ enabled, country (ayar; ''=otomatik), located (sunucunun konumdan bulduğu), lang, zIndex, before (bu öğenin arkasına), top, bottom, mode,
 *   inFlight, reduced, figAlpha (büyük figür saydamlığı; ör. sitede kaydırınca söner), ground (uzun yer figürlerinin zemini, H oranı), banner, bannerTop, bannerZ, preview, fetchFn })
 * → Promise<{ fx, info, detected, picked, destroy, setMode }> | null (tema yoksa / kapalıysa)
 */
export async function mountHolidayFx(o = {}) {
  const pv = o.preview || previewFromSearch();
  if (o.enabled === false && !pv) return null;
  const detected = detectCountry({ setting: pv?.country || o.country, located: o.located });
  let items, info = null;
  if (pv) items = previewItems(pv.themes, detected.country);
  else {
    if (!detected.country) return null;
    try { info = await fetchHoliday(detected.country, { lang: o.lang, fetchFn: o.fetchFn, base: o.base || '' }); } catch { info = null; }
    items = info?.active || [];
  }
  const picked = pickThemes(items);
  if (!picked.primary) return { fx: null, info, detected, picked, destroy() {}, setMode() {} };
  const fx = createHolidayFx({ zIndex: o.zIndex, themes: [picked.primary, picked.secondary].filter(Boolean), country: picked.primary.country || detected.country,
    mode: o.mode || 'full', inFlight: o.inFlight, parent: o.parent, before: o.before, top: o.top, bottom: o.bottom, reduced: o.reduced, figAlpha: o.figAlpha, ground: o.ground });
  let ban = null;
  if (o.banner !== false && !o.inFlight?.()) ban = showBanner({ ...picked.primary, country: picked.primary.country || detected.country }, { lang: o.lang, top: o.bannerTop, zIndex: o.bannerZ, force: !!pv, ms: pv ? 25000 : 9000 });
  globalThis.__holidayFx = () => ({ ...fx?.state(), detected, items: picked.items });
  return { fx, info, detected, picked, banner: ban, setMode: m => fx?.setMode(m), destroy: () => { fx?.destroy(); ban?.close(); } };
}
