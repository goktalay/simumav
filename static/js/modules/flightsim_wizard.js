// Uçuş Simülatörü — "Yeni Simülasyon Başlat" adım adım sihirbazının SAF mantığı (docs/ucus-simulatoru.md §6). DOM yok, içe aktarma yalnız saf modüller
// (Node testi: tests/test_flightsim_wizard.mjs). DOM ve bölümler flightsim.js wizardModal'da.
// Sıra (canlı): 1 Araç (tip + dron kaydı + model + kontrol düzeni) → 2 Dünya ve konum (merkez + dünya + 3B önizleme) → 3 Kalkış (yalnız kalkış
// seçeneği olan tiplerde) → 4 Güç ve yakıt → 5 Kamera → 6 Hedefler (isteğe bağlı) → 7 Yer kontrol (isteğe bağlı) → 8 Kayıt ve özet.
// Kayıttan oynatma: 1 Uçuş logu (+ model) → Dünya → Kalkış (log aracı sabit kanatsa) → Kamera → Kayıt ve özet.
// Kalkış seçenekleri VERİDEN: LAUNCH_OPTIONS (anahtar, uygun tipler, ayar alanları, simge anahtarı) + LAUNCH_PARAM_DEFS (kaydırıcı tanımı). Yeni bir
// fırlatıcı (ör. INTERCEPTOR için 4'lü/8'li fırlatıcı, yerden tekli, el aparatı) eklemek = LAUNCH_OPTIONS'a bir satır (+ gerekiyorsa param tanımı ve
// flightsim.js LAUNCH_ICON'a simge); adım, tip için en az bir seçenek varsa kendiliğinden görünür.
import { LAUNCH_METHODS } from './flightsim_launch.js';

export const STEP_DEFS = [
  { key: 'vehicle', title: 'Araç', modes: ['sitl'], preview: true, desc: 'Dron tipi, envanter kaydı, görsel model ve kontrol düzeni.' },
  { key: 'log', title: 'Uçuş logu', modes: ['replay'], preview: true, desc: 'Oynatılacak uçuş kaydı ve görsel model.' },
  { key: 'world', title: 'Dünya ve konum', modes: ['sitl', 'replay'], preview: true, desc: 'Kalkış merkezi, dünya kipi, arazi ve hava.' },
  { key: 'launch', title: 'Kalkış', modes: ['sitl', 'replay'], preview: true, desc: 'Aracın nasıl havalanacağı.' },
  { key: 'power', title: 'Güç ve yakıt', modes: ['sitl'], preview: false, desc: 'Azami hız, yakıt ve batarya bütçesi.' },
  { key: 'camera', title: 'Kamera', modes: ['sitl', 'replay'], preview: false, desc: 'Gündüz, termal ya da gece görüşü.' },
  { key: 'targets', title: 'Hedefler', modes: ['sitl'], preview: false, optional: true, desc: 'Havada dairesel yörüngede uçan hedefler.' },
  { key: 'site', title: 'Yer kontrol', modes: ['sitl'], preview: false, optional: true, desc: 'Radar, istasyon, EO kulesi ve görev.' },
  { key: 'summary', title: 'Kayıt ve özet', modes: ['sitl', 'replay'], preview: false, desc: 'Kayıt seçenekleri ve tüm seçimlerin özeti.' },
];
export const stepDef = key => STEP_DEFS.find(s => s.key === key) || null;

// Kaydırıcı tanımları (ölçek, birim); değerler world.launch'a aynı adla yazılır (sunucu sınırları: angle 10–30°, release 40–110 km/h)
export const LAUNCH_PARAM_DEFS = {
  angle_deg: { label: 'Fırlatma açısı', min: 10, max: 30, step: 1, unit: '°' },
  release_kmh: { label: 'Bırakma hızı', min: 40, max: 110, step: 5, unit: 'km/h' },
};
// [anahtar, ad, açıklama] LAUNCH_METHODS'tan; types: seçeneğin sunulduğu dron tipleri; params: LAUNCH_PARAM_DEFS anahtarları; note: ek açıklama satırı
const LM = Object.fromEntries(LAUNCH_METHODS.map(([k, name, desc]) => [k, { name, desc }]));
export const LAUNCH_OPTIONS = [
  { key: 'wheels', types: ['sabit_kanat'], ...LM.wheels, params: [], icon: 'wheels' },
  { key: 'ramp', types: ['sabit_kanat'], ...LM.ramp, params: ['angle_deg'], icon: 'ramp' },
  { key: 'vehicle', types: ['sabit_kanat'], ...LM.vehicle, params: ['release_kmh'], icon: 'vehicle', note: 'Araç tipi: pickup (kasa kızağı). Araç pist boyunca hızlanır; bırakma hızına ulaşınca uçak serbest kalır ve tırmanır.' },
];
export const launchOptionsFor = (type, options = LAUNCH_OPTIONS) => options.filter(o => o.types.includes(type));
// Seçili yöntem tipte yoksa ilk seçenek (tip değişince geçersiz kalmasın); seçenek yoksa olduğu gibi
export const normLaunchMethod = (method, type, options = LAUNCH_OPTIONS) => { const list = launchOptionsFor(type, options); return !list.length || list.some(o => o.key === method) ? method : list[0].key; };

// Görünür adımlar: kip + etkin tip (kayıtta logun tipi). ctx: { mode, type, options? }
export function wizardSteps({ mode = 'sitl', type = 'multirotor', options = LAUNCH_OPTIONS } = {}) {
  return STEP_DEFS.filter(s => s.modes.includes(mode) && (s.key !== 'launch' || launchOptionsFor(type, options).length > 0)).map(s => s.key);
}

// Adım geçişleri. valid: key → null (geçerli) | hata metni. Geri her zaman serbest; ileriye ancak aradaki (hedef hariç) tüm adımlar geçerliyse.
export function canGoto(steps, valid, from, to) {
  const a = steps.indexOf(from), b = steps.indexOf(to);
  if (b < 0) return false;
  if (a < 0 || b <= a) return true;
  for (let i = a; i < b; i++) if (valid(steps[i])) return false;
  return true;
}
// İlk geçersiz adım (Başlat öncesi denetim; yoksa null)
export const firstInvalid = (steps, valid) => steps.find(k => valid(k)) || null;
// Adım listesi değişince (tip/kip) geçerli adım: hâlâ varsa o, yoksa eski sıradaki konumuna en yakın önceki görünür adım
export function reconcileStep(prevSteps, nextSteps, cur) {
  if (nextSteps.includes(cur)) return cur;
  const order = STEP_DEFS.map(s => s.key);
  const ci = order.indexOf(cur);
  let best = nextSteps[0] || null;
  for (const k of nextSteps) if (order.indexOf(k) <= ci) best = k;
  return best;
}

// Adım makinesi (saf): getSteps() her çağrıda güncel listeyi verir (tip değişimi), valid(key) doğrulama
export function createStepper({ getSteps, valid, start = null }) {
  let steps = getSteps();
  let cur = start && steps.includes(start) ? start : steps[0];
  let maxSeen = steps.indexOf(cur);
  const sync = () => { const n = getSteps(); cur = reconcileStep(steps, n, cur); steps = n; maxSeen = Math.min(maxSeen, steps.length - 1); return steps; };
  const api = {
    get step() { return cur; },
    get steps() { return sync(); },
    get index() { sync(); return steps.indexOf(cur); },
    isFirst: () => api.index === 0,
    isLast: () => { sync(); return steps.indexOf(cur) === steps.length - 1; },
    error: () => valid(cur),
    canNext: () => !valid(cur) && !api.isLast(),
    next() { if (!api.canNext()) return false; cur = steps[steps.indexOf(cur) + 1]; maxSeen = Math.max(maxSeen, steps.indexOf(cur)); return true; },
    back() { sync(); const i = steps.indexOf(cur); if (i <= 0) return false; cur = steps[i - 1]; return true; },
    goto(key, { force = false } = {}) { sync(); if (!force && !canGoto(steps, valid, cur, key)) return false; if (!steps.includes(key)) return false; cur = key; maxSeen = Math.max(maxSeen, steps.indexOf(cur)); return true; },
    // Şerit durumu: done (geçilmiş ve geçerli) · on (geçerli adım) · err (geçilmiş ama artık geçersiz) · reach (tıklanabilir) · lock
    states() {
      sync();
      const ci = steps.indexOf(cur);
      return steps.map((k, i) => { const seen = i !== ci && i <= maxSeen, e = !!valid(k); return { key: k, n: i + 1, on: i === ci, done: seen && !e, err: seen && e, reach: canGoto(steps, valid, cur, k) }; });
    },
  };
  return api;
}
