// Uçuş Simülatörü — "Yeni Simülasyon Başlat" adım adım sihirbazının SAF mantığı (docs/ucus-simulatoru.md §6). DOM yok, içe aktarma yalnız saf modüller
// (Node testi: tests/test_flightsim_wizard.mjs). DOM ve bölümler flightsim.js wizardModal'da.
// Sıra (canlı): 1 Araç (tip + dron kaydı + model + kontrol düzeni) → 2 Dünya ve konum (merkez + dünya + 3B önizleme) → 3 Kalkış (yalnız kalkış
// seçeneği olan tiplerde) → 4 Güç ve yakıt → 5 Kamera → 6 Hedefler (isteğe bağlı) → 7 Yer kontrol (isteğe bağlı) → 8 Kayıt ve özet.
// §33 Yeni Karşılaşma: Araç → Dünya → Kalkış → Güç → Kamera → Halkalar → Davet et → Özet ve başlat (Hedefler / Yer kontrol yok).
// Kayıttan oynatma: 1 Uçuş logu (+ model) → Dünya → Kalkış (log aracı sabit kanatsa) → Kamera → Kayıt ve özet.
// Kalkış seçenekleri VERİDEN: LAUNCH_OPTIONS (anahtar, uygun tipler, ayar alanları, simge anahtarı) + LAUNCH_PARAM_DEFS (kaydırıcı tanımı). Yeni bir
// fırlatıcı eklemek = LAUNCH_OPTIONS'a bir satır (+ gerekiyorsa param tanımı ve flightsim.js LAUNCH_ICON'a simge); adım, tip için en az bir seçenek
// varsa kendiliğinden görünür. §27: INTERCEPTOR için 4'lü / 8'li kutu, yerden tekli tüp, el fırlatıcısı (açıklama metni tipe göre: launchStepDesc).
import { LAUNCH_METHODS } from './flightsim_launch.js';

export const STEP_DEFS = [
  { key: 'vehicle', title: 'Araç', modes: ['sitl'], preview: true, desc: 'Dron tipi, envanter kaydı, görsel model ve kontrol düzeni.' },
  { key: 'log', title: 'Uçuş logu', modes: ['replay'], preview: true, desc: 'Oynatılacak uçuş kaydı ve görsel model.' },
  { key: 'world', title: 'Dünya ve konum', modes: ['sitl', 'replay'], preview: true, desc: 'Kalkış merkezi, dünya kipi, arazi ve hava.' },
  { key: 'launch', title: 'Kalkış', modes: ['sitl', 'replay'], preview: true, desc: 'Aracın nasıl havalanacağı.' },
  { key: 'power', title: 'Güç ve yakıt', modes: ['sitl'], preview: false, desc: 'Azami hız, yakıt ve batarya bütçesi.' },
  { key: 'camera', title: 'Kamera', modes: ['sitl', 'replay'], preview: false, desc: 'Gündüz, termal ya da gece görüşü.' },
  { key: 'targets', title: 'Hedefler', modes: ['sitl'], preview: false, optional: true, noMatch: true, desc: 'Havada dairesel yörüngede uçan hedefler.' },
  { key: 'site', title: 'Yer kontrol', modes: ['sitl'], preview: false, optional: true, noMatch: true, desc: 'Radar, istasyon, EO kulesi ve görev.' },
  // §33 çok oyunculu karşılaşma ("Yeni Karşılaşma"): radar / EO / yer kontrol (ve hedefler) yok; Halkalar + Davet et; son adımda yalnız Başlat
  { key: 'rings', title: 'Halkalar', modes: ['sitl'], preview: false, matchOnly: true, desc: 'Havadaki halkaların sayısı, yükseklik aralığı ve parkur.' },
  { key: 'invite', title: 'Davet et', modes: ['sitl'], preview: false, matchOnly: true, desc: 'Karşılaşmaya davet edilecek kullanıcılar.' },
  { key: 'summary', title: 'Kayıt ve özet', matchTitle: 'Özet ve başlat', modes: ['sitl', 'replay'], preview: false, desc: 'Kayıt seçenekleri ve tüm seçimlerin özeti.',
    matchDesc: 'Seçimlerin özeti; Başlat ile bekleme salonu açılır ve davetlilere bildirim gider.' },
];
export const stepDef = key => STEP_DEFS.find(s => s.key === key) || null;
// §33: karşılaşma sihirbazında başlık/açıklama (özet adımı "Özet ve başlat")
export const stepDefFor = (key, match = false) => { const d = stepDef(key); return d && match ? { ...d, title: d.matchTitle || d.title, desc: d.matchDesc || d.desc } : d; };

// Kaydırıcı tanımları (ölçek, birim); değerler world.launch'a `field` (yoksa anahtar) adıyla yazılır (sunucu sınırları: angle 10–30°, release 40–110 km/h;
// §27 loaded 1…hücre, aim_az_deg 0…360, aim_el_deg 10…85). Aynı alanın yönteme göre farklı sınırı ayrı anahtarla (loaded4 / loaded8 → loaded).
export const LAUNCH_PARAM_DEFS = {
  angle_deg: { label: 'Fırlatma açısı', min: 10, max: 30, step: 1, unit: '°' },
  release_kmh: { label: 'Bırakma hızı', min: 40, max: 110, step: 5, unit: 'km/h' },
  loaded4: { field: 'loaded', label: 'Dolu hücre', min: 1, max: 4, step: 1, unit: '/ 4', integer: true },
  loaded8: { field: 'loaded', label: 'Dolu hücre', min: 1, max: 8, step: 1, unit: '/ 8', integer: true },
  aim_az_deg: { label: 'Nişan yönü', min: 0, max: 359, step: 1, unit: '°' },
  aim_el_deg: { label: 'Nişan açısı', min: 10, max: 85, step: 1, unit: '°' },
  azimuth_deg: { label: 'Rampa yönü (azimut)', min: 0, max: 359, step: 1, unit: '°' },   // §31: rampa yönü (yoksa pist yönü); SITL ev yönü
};
export const paramField = key => LAUNCH_PARAM_DEFS[key]?.field || key;
// [anahtar, ad, açıklama] LAUNCH_METHODS'tan; types: seçeneğin sunulduğu dron tipleri; params: LAUNCH_PARAM_DEFS anahtarları; note: ek açıklama satırı;
// badge: kart rozeti (isteğe bağlı)
const LM = Object.fromEntries(LAUNCH_METHODS.map(([k, name, desc]) => [k, { name, desc }]));
export const LAUNCH_OPTIONS = [
  { key: 'wheels', types: ['sabit_kanat'], ...LM.wheels, params: [], icon: 'wheels' },
  { key: 'ramp', types: ['sabit_kanat'], ...LM.ramp, params: ['angle_deg', 'azimuth_deg'], icon: 'ramp' },
  { key: 'vehicle', types: ['sabit_kanat'], ...LM.vehicle, params: ['release_kmh'], icon: 'vehicle', note: 'Araç tipi: pickup (kasa kızağı). Araç pist boyunca hızlanır; bırakma hızına ulaşınca uçak serbest kalır ve tırmanır.' },
  // §27 INTERCEPTOR fırlatıcıları (flightsim_launcher.js): kutu/tüp dikey; el fırlatıcısında nişan yönü/açısı (uçuşta da fare/klavye/sanal kumanda ile)
  { key: 'pod4', types: ['interceptor'], ...LM.pod4, params: ['loaded4'], icon: 'pod4', note: '"Yer kontrolünü koru" görevinde dolu hücre görevin interceptor sayısıdır: ⌈sayı / 4⌉ kutu yan yana kurulur (10\'lu raf yerine).' },
  { key: 'pod8', types: ['interceptor'], ...LM.pod8, params: ['loaded8'], icon: 'pod8', note: '"Yer kontrolünü koru" görevinde dolu hücre görevin interceptor sayısıdır: ⌈sayı / 8⌉ kutu yan yana kurulur (10\'lu raf yerine).' },
  { key: 'tube', types: ['interceptor'], ...LM.tube, params: [], icon: 'tube', note: 'Görevde 10\'lu raf yedek deposudur; her "sıradaki interceptor" tüpe yeniden yüklenir.' },
  { key: 'handheld', types: ['interceptor'], ...LM.handheld, params: ['aim_az_deg', 'aim_el_deg'], icon: 'handheld', badge: 'Nişangâh', note: 'Uçuşta "Nişangâh" penceresi: aparatın baktığı yöne (göğe) kamera ve hedefler; fare sürükleme, I/J/K/L ya da ok düğmeleriyle nişan alın, "Fırlat" ile interceptor nişan yönünde çıkar.' },
];
// Kalkış adımının açıklaması tipe göre (§6; eski metin sabit kanada özgüydü)
export const LAUNCH_STEP_DESC = {
  sabit_kanat: { sitl: 'Sabit kanat uçağın nasıl havalanacağı: tekerlekli pist koşusu, pnömatik fırlatma rampası ya da pickup üstünden bırakma. Seçim 3B sahnede ve SITL kalkış parametrelerinde uygulanır.',
    replay: 'Kayıttaki sabit kanat uçağın kalkış düzeneği: rampa ya da araç 3B sahnede kurulur; ARM, fırlatma ve bırakma aşamaları logdan (ARM anı, ilk hareket, yer hızı/irtifa) türetilir. SITL parametresi yazılmaz.' },
  interceptor: { sitl: 'INTERCEPTOR\'ın hangi fırlatıcıdan çıkacağı: 4\'lü ya da 8\'li kutu fırlatıcı, yerden tekli tüp veya pilotun elindeki el fırlatıcısı. Tailsitter kuyruk üstünden dikey çıkar (SITL: GUIDED + NAV_TAKEOFF); el fırlatıcısında nişan yönüne yönelir.',
    replay: 'Kayıttaki INTERCEPTOR\'ın fırlatıcısı 3B sahnede kurulur (kayıt bu simülatörden ise kayıttaki fırlatıcı önerilir); ARM, fırlatma ve çıkış aşamaları logdan türetilir.' },
};
export const launchStepDesc = (type, mode = 'sitl') => (LAUNCH_STEP_DESC[type] || LAUNCH_STEP_DESC.sabit_kanat)[mode === 'replay' ? 'replay' : 'sitl'];
export const launchOptionsFor = (type, options = LAUNCH_OPTIONS) => options.filter(o => o.types.includes(type));
// Seçili yöntem tipte yoksa ilk seçenek (tip değişince geçersiz kalmasın); seçenek yoksa olduğu gibi
export const normLaunchMethod = (method, type, options = LAUNCH_OPTIONS) => { const list = launchOptionsFor(type, options); return !list.length || list.some(o => o.key === method) ? method : list[0].key; };

// Görünür adımlar: kip + etkin tip (kayıtta logun tipi). ctx: { mode, type, options?, match? } — match (§33): Hedefler / Yer kontrol yok, Halkalar + Davet et var
export function wizardSteps({ mode = 'sitl', type = 'multirotor', options = LAUNCH_OPTIONS, match = false } = {}) {
  return STEP_DEFS.filter(s => s.modes.includes(mode) && (s.key !== 'launch' || launchOptionsFor(type, options).length > 0)
    && (match ? !s.noMatch : !s.matchOnly)).map(s => s.key);
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

// ---------------------------------------------------------------------------------------------------------------------------------------------
// §8.5 Kayıttan oynatma girişleri (kullanıcı isteği: "Kaydı tekrar izlemek için Başlat dediğimde tekrar tekrar rampasını soruyor; direkt izlemeye
// geçmeli, o oturumda hangi ayarlarla uçtuysak o ayarlarla. Saha görevlerinin logları burada görünmemeli, yeni simülasyonda bile. Saha yönetiminde
// uçuşun yanında 'Simüle et' dediğimde o zaman sorsun — atmosferi, rampayı falan."):
//   · simülasyon kaydını izle  → sihirbaz YOK (POST /runs/{id}/replay; flightsim.js playRun)
//   · yeni simülasyon › Kayıttan oynat → log listesi YALNIZ simülatör kayıtları (isSimLog; sunucu da süzer)
//   · Saha yönetimi / Uçuş Logu Analizi "Simüle et" → #/drone/sim?simulate=<log> : sihirbaz o log sabit (pinned), Dünya adımından başlar
// ---------------------------------------------------------------------------------------------------------------------------------------------
const SIM_AIRCRAFT = /^Simülatör\b/;
const SIM_FILE = /^SIM-\d+-\d{8}-\d{4}\.bin$/i;
// Simülatörün kendi kaydı mı: saha görevine/uçuşuna bağlı değil ve kaynağı simülasyon (sunucunun `sim` bayrağı varsa o; yoksa origin / ad çıkarımı —
// flightlog_origin.logOrigin ile aynı kural)
export function isSimLog(l) {
  if (!l || l.task_id || l.flight_id || l.task_code) return false;
  if (l.sim != null) return !!l.sim;
  if (l.origin === 'SIM') return true;
  if (l.origin === 'REAL') return false;
  return SIM_AIRCRAFT.test(l.aircraft || '') || SIM_FILE.test(l.file_name || '');
}
export const simLogsOnly = logs => (logs || []).filter(isSimLog);
// `?simulate=<log kimliği>` → pozitif tam sayı | null
export function simulateParam(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
}
// Sihirbazın başlangıç adımı: "Simüle et" (log sabit) → Dünya (atmosfer); aksi hâlde listenin ilk adımı
export const wizardStartStep = ({ mode = 'sitl', pinned = false } = {}) => (mode === 'replay' && pinned ? 'world' : null);
// "Simüle et" bağlantısı (Saha yönetimi / Uçuş Logu Analizi)
export const simulateHref = logId => `#/drone/sim?simulate=${encodeURIComponent(logId)}`;
