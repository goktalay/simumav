// SIMUMAV › Uç — sihirbaz adım makinesi ve tip eşlemeleri (saf; DOM yok; node ile test edilir: tests/test_simumav_fly.mjs).
// Adımlar: drone → track → launch (sabit kanat / VTOL: kalkış yöntemi; INTERCEPTOR: fırlatıcı — HEPGO §27) → power (güç ve yakıt + simülasyon hızı, §10) → mission (isteğe bağlı)
// → site (YER KONTROL: radar / istasyon / EO + "Yer kontrolünü koru"; HEPGO §26, isteğe bağlı) → targets (HEDEFLER, isteğe bağlı; HEPGO §24)
// → pilot (+ kayıt seçenekleri) → BAŞLA.
// Çıktı: `payload()` → POST /api/fly/start gövdesi (docs/simumav.md §4): {drone_id, pilot_id, track_id, mission_id?, launch, record:{video,bin},
// power? (power.js createPowerState.body()), speedup? (> 1 ise)}.
// Tip eşlemesi: SIMUMAV dron türleri (§3 drones.type) → HEPGO simülatör tipleri (flightsim*.js): plane → sabit_kanat, interceptor → interceptor
// (4 pervaneli tailsitter, HEPGO §25: dikey kalkış, ~400 km/h; §27 fırlatıcı adımı), heli → helikopter, fpv/multirotor → multirotor, vtol → vtol.
// Eski sabit kanat jetleri (glb:jet / glb:zephyr / proc:interceptor) artık 'plane' tipindedir (sunucu göçü v2): hız ölçeği 600 km/h ve jet sesi model
// anahtarına göre (speedScale / audioTypeFor ikinci argümanı). FPV: başlangıç kamerası FPV.
// KARA ARACI (rover → çekirdek `rover`, ArduRover; HEPGO §31 / docs/simumav.md §15): kalkış adımı yok, sürüş biçimi (Ackermann | paletli-diferansiyel)
// dron adımında seçilir → start gövdesi `drive` (seçilmezse modelin); güç adımı elektrik varsayılan + isteğe bağlı yakıt; hız ölçeği 80 / 20 km/h.

export const STEPS = ['drone', 'track', 'launch', 'power', 'mission', 'site', 'targets', 'pilot'];
// §18 ÇOK OYUNCULU (kurucu): dron + parkur (+ kalkış) → halkalar (sayı, min/max yükseklik …) → davet (oyuncu sayısı + şifre). Güç/görev/yer kontrol/
// hedef/pilot yok: herkes kurucunun dronuyla, kendi varsayılan pilotuyla uçar.
export const STEPS_MATCH = ['drone', 'track', 'launch', 'rings', 'invite'];
export const STEP_TITLES = { drone: 'Dron seç', track: 'Parkur seç', launch: 'Kalkış yöntemi', power: 'power.step', mission: 'Görev (isteğe bağlı)', site: 'site.step', targets: 'targets.step', pilot: 'Pilot ve kayıt',
  rings: 'match.step_rings', invite: 'match.step_invite' };

// SIMUMAV türü → HEPGO simülatör tipi
export const TYPE_MAP = { multirotor: 'multirotor', fpv: 'multirotor', heli: 'helikopter', plane: 'sabit_kanat', interceptor: 'interceptor', vtol: 'vtol', rover: 'rover' };
export const TYPE_LABEL = { multirotor: 'Multikopter', fpv: 'FPV dron', heli: 'Helikopter', plane: 'Sabit kanat', interceptor: 'INTERCEPTOR', vtol: 'VTOL', rover: 'Kara aracı' };
export const simType = t => TYPE_MAP[t] || 'multirotor';
// ---------- KARA ARACI (§15) ----------
export const isRover = t => t === 'rover';
export const DRIVES = ['ackermann', 'skid'];
// [anahtar, i18n anahtarı, Türkçe ad, i18n açıklama, Türkçe açıklama]
export const DRIVE_SM = [
  ['ackermann', 'drive.ackermann', 'Ackermann (ön teker direksiyonu)', 'drive.ackermann_desc', 'Otomobil gibi ön tekerden döner; azami ~72 km/h (SIM_Rover). Yerinde dönemez.'],
  ['skid', 'drive.skid', 'Paletli / diferansiyel', 'drive.skid_desc', 'Sol-sağ teker ya da palet hız farkıyla döner; yerinde döner, azami ~14 km/h (SIM_Rover skid).'],
];
// Modelin sürüş biçimi: sunucunun `drive`'ı (hangar kaydı), yoksa model anahtarından (paletli UGV / teslimat robotu → skid), yoksa ackermann
export const SKID_MODELS = ['glb:rover_ugv', 'glb:rover_bot', 'builtin:rover_ugv', 'builtin:rover_bot'];
export const driveForModel = (key, drive = null) => (DRIVES.includes(drive) ? drive : SKID_MODELS.includes(String(key || '')) ? 'skid' : 'ackermann');
export const driveOf = (drone, chosen = null) => (!drone || !isRover(drone.type) ? null : DRIVES.includes(chosen) ? chosen : driveForModel(drone.model_key, drone.drive));
// Kalkış yöntemi (sabit kanat düzeneği) yalnız sabit kanat / VTOL'de: rampa, araç, tekerlek, ELDEN ATIŞ. INTERCEPTOR'da aynı adımda FIRLATICI seçilir
// (HEPGO §27: 4'lü / 8'li kutu, yerden tekli tüp, el fırlatıcısı) — durum ayrı (`ilaunch`), kalkış yine kuyruk üstünden dikey.
export const needsLaunch = t => t === 'plane' || t === 'vtol';
export const hasLaunchStep = t => needsLaunch(t) || t === 'interceptor';
// HEPGO §27 INTERCEPTOR fırlatıcıları: [anahtar, i18n anahtarı (ad), Türkçe ad, i18n açıklama, Türkçe açıklama, ayar alanları]
export const ICEPT_LAUNCH_SM = [
  ['pod4', 'launcher.pod4', "4'lü fırlatıcı", 'launcher.pod4_desc', 'Kutu fırlatıcı, 2×2 dikey hücre. Kapak açılır, interceptor kuyruk üstünden dikey çıkar.', ['loaded']],
  ['pod8', 'launcher.pod8', "8'li fırlatıcı", 'launcher.pod8_desc', 'Kutu fırlatıcı, 4×2 dikey hücre. Görevde envanter kutulara dağılır (raf yerine).', ['loaded']],
  ['tube', 'launcher.tube', 'Yerden tekli', 'launcher.tube_desc', 'Üç ayaklı sehpada tek dikey fırlatma tüpü; kapak açılır, interceptor tüpten çıkar.', []],
  ['handheld', 'launcher.handheld', 'El fırlatıcısı', 'launcher.handheld_desc', 'Pilotun omzundaki silah benzeri aparat; üstündeki küçük ekranda göğe bakan kamera ve havadaki hedefler.', ['aim_az_deg', 'aim_el_deg']],
];
export const ICEPT_CELLS = { pod4: 4, pod8: 8, tube: 1, handheld: 1 };
export const ICEPT_LAUNCH_DEFAULTS = { method: 'pod4', loaded: 4, aim_az_deg: 0, aim_el_deg: 55 };
export const ICEPT_LIMITS = { loaded: [1, 8], aim_az_deg: [0, 359], aim_el_deg: [10, 85] };
export const isIceptLaunch = m => Object.prototype.hasOwnProperty.call(ICEPT_CELLS, m);
export const normIceptLaunch = (l = {}) => {
  const out = { ...ICEPT_LAUNCH_DEFAULTS, ...(l || {}) };
  if (!isIceptLaunch(out.method)) out.method = ICEPT_LAUNCH_DEFAULTS.method;
  for (const [k, [a, b]] of Object.entries(ICEPT_LIMITS)) { const n = Number(out[k]); out[k] = Number.isFinite(n) ? Math.min(b, Math.max(a, n)) : ICEPT_LAUNCH_DEFAULTS[k]; }
  out.loaded = Math.round(Math.min(out.loaded, ICEPT_CELLS[out.method]));
  return out;
};
// Sunucuya giden fırlatıcı (bridge.launch_dogrula; çekirdek world.launch): kutularda loaded, el fırlatıcısında nişan
export const iceptLaunchBody = l => {
  const n = normIceptLaunch(l);
  const out = { method: n.method };
  if (ICEPT_CELLS[n.method] > 1) out.loaded = n.loaded;
  if (n.method === 'handheld') { out.aim_az_deg = n.aim_az_deg; out.aim_el_deg = n.aim_el_deg; }
  return out;
};
export const iceptLaunchLabel = (l, tr = null) => {
  const n = normIceptLaunch(l), row = ICEPT_LAUNCH_SM.find(r => r[0] === n.method), T = (k, tx) => { const r = tr ? tr(k) : k; return r && r !== k ? r : tx; };
  const name = T(row[1], row[2]);
  return n.method === 'pod4' || n.method === 'pod8' ? `${name} · ${n.loaded}/${ICEPT_CELLS[n.method]}` : n.method === 'handheld' ? `${name} ${Math.round(n.aim_el_deg)}°/${Math.round(n.aim_az_deg)}°` : name;
};
// Yüksek hız sabit kanat jet modelleri (eski "interceptor" kaydı; göç v2 ile 'plane'): 600 km/h ölçek + jet sesi
export const JET_MODELS = ['glb:jet', 'glb:zephyr', 'proc:interceptor'];
export const isJetModel = k => JET_MODELS.includes(String(k || ''));

// Kalkış yöntemleri (HEPGO flightsim_launch.js LAUNCH_METHODS + yeni `hand`): [anahtar, ad, açıklama, ayar alanları]
export const LAUNCH_METHODS_SM = [
  ['ramp', 'Fırlatma Rampası', 'Pnömatik rampa; kızak uçağı 6 m rayda fırlatır. Açı 10–30°.', ['angle_deg']],
  ['vehicle', 'Araç Üstü', 'Uçak pickup kasasında; araç seçilen hıza ulaşınca bırakır. 40–110 km/h.', ['release_kmh']],
  ['wheels', 'Tekerlekli', 'İniş takımı eklenir; pist koşusu ve döndürme (ArduPlane TAKEOFF).', []],
  ['hand', 'Elden Atış', 'Pilot uçağı omuz hizasında tutar; geri sayımla kol ileri, bırakma ~7 m/s, 12° burun yukarı.', ['hand_speed_ms', 'hand_pitch_deg']],
];
export const LAUNCH_DEFAULTS_SM = { method: 'hand', angle_deg: 15, release_kmh: 70, hand_speed_ms: 7, hand_pitch_deg: 12 };
export const LAUNCH_LIMITS = { angle_deg: [10, 30], release_kmh: [40, 110], hand_speed_ms: [6, 8], hand_pitch_deg: [10, 15] };
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
export const normLaunch = (l = {}) => {
  const out = { ...LAUNCH_DEFAULTS_SM, ...(l || {}) };
  if (!LAUNCH_METHODS_SM.some(([k]) => k === out.method)) out.method = LAUNCH_DEFAULTS_SM.method;
  for (const [k, [a, b]] of Object.entries(LAUNCH_LIMITS)) { const n = Number(out[k]); out[k] = Number.isFinite(n) ? clamp(n, a, b) : LAUNCH_DEFAULTS_SM[k]; }
  return out;
};
export const launchLabelSm = l => {
  const m = l?.method || 'hand';
  return m === 'ramp' ? `Rampa ${Math.round(l.angle_deg ?? 15)}°` : m === 'vehicle' ? `Araç ${Math.round(l.release_kmh ?? 70)} km/h` : m === 'wheels' ? 'Tekerlekli' : `Elden atış ${Number(l.hand_speed_ms ?? 7).toFixed(0)} m/s`;
};
// Sunucuya giden `launch` (§3 flights.launch: 'wheels'|'ramp'|'vehicle'|'hand'); HEPGO çekirdeği angle_deg/release_kmh bekler, hand alanları ek
export const launchBody = l => {
  const n = normLaunch(l);
  const out = { method: n.method, angle_deg: n.angle_deg, release_kmh: n.release_kmh };
  if (n.method === 'hand') { out.hand_speed_ms = n.hand_speed_ms; out.hand_pitch_deg = n.hand_pitch_deg; }
  return out;
};

// Kontrol düzeni (HEPGO §13.1; drones.airframe): classic | elevon | vtail — yalnız sabit kanat ailesinde (plane / interceptor). Dron kaydında
// yoksa model anahtarından (talon → vtail; delta/interceptor/caymaz/zephyr → elevon; cessna/believer → classic), o da yoksa classic.
export const AIRFRAMES = ['classic', 'elevon', 'vtail'];
export const AIRFRAME_LABEL = { classic: 'Aileron + Elevatör (T-kuyruk)', elevon: 'Elevon (delta kanat)', vtail: 'V-kuyruk (ruddervator)' };
export const AIRFRAME_SHORT = { classic: 'Klasik', elevon: 'Elevon', vtail: 'V-kuyruk' };
export const needsAirframe = t => t === 'plane';
export const airframeForModel = key => { const k = String(key || '').toLowerCase(); if (!k) return null; if (/talon|vtail|v-tail/.test(k)) return 'vtail'; if (/delta|interceptor|caymaz|zephyr|elevon/.test(k)) return 'elevon'; if (/cessna|believer|plane/.test(k)) return 'classic'; return null; };
export const airframeOf = (drone, catalogModel = null) => (!drone || !needsAirframe(drone.type) ? null : (AIRFRAMES.includes(drone.airframe) ? drone.airframe : (catalogModel?.airframe && AIRFRAMES.includes(catalogModel.airframe) ? catalogModel.airframe : airframeForModel(drone.model_key) || 'classic')));
export const airframeLabel = (a, tr = s => s) => (a && AIRFRAME_LABEL[a] ? tr(AIRFRAME_LABEL[a]) : '—');

// Hız göstergesi ölçeği (km/h): INTERCEPTOR 450 (azami 400 km/h), sabit kanat / VTOL 200 (jet modeli 600: AIRSPEED_MAX 170 m/s ≈ 612 km/h),
// helikopter 120, kopter / FPV 150
// Kara aracı: Ackermann 80 (SIM_Rover 20 m/s = 72 km/h), paletli/diferansiyel 20 (4 m/s ≈ 14 km/h); üçüncü argüman seçilen sürüş biçimi
export const SPEED_SCALE = { interceptor: 450, plane: 200, vtol: 200, heli: 120, fpv: 150, multirotor: 100, rover: 80 };
export const speedScale = (t, modelKey = null, drive = null) => (t === 'plane' && isJetModel(modelKey) ? 600 : isRover(t) ? (driveForModel(modelKey, drive) === 'skid' ? 20 : 80) : SPEED_SCALE[t] || 100);
export const speedTicks = max => { const step = max >= 400 ? 100 : max >= 150 ? 50 : max >= 60 ? 20 : 5; const out = []; for (let v = 0; v <= max; v += step) out.push(v); return out; };
// Gösterge iğnesi açısı: 0 → −120°, max → +120° (240° yay)
export const speedAngle = (kmh, max) => -120 + 240 * clamp((Number(kmh) || 0) / max, 0, 1);
// Başlangıç kamerası: FPV dron → 'fpv' (gimbal), diğerleri takip
export const startCameraFor = t => (t === 'fpv' ? 'fpv' : 'follow');
// Ses modeli tipi: jet modelleri için yüksek devirli ayrı model 'jet' (flightsim_audio AUDIO_MODELS'e çalışma zamanında eklenir; session.js);
// INTERCEPTOR çekirdeğin 4 elektrik motorlu modelini kullanır (AUDIO_MODELS.interceptor)
export const audioTypeFor = (t, modelKey = null) => (t === 'plane' && isJetModel(modelKey) ? 'jet' : simType(t));
export const JET_AUDIO = { kind: 'plane', cylinders: 2, blades: 3, idleRpm: 4200, maxRpm: 19000 };
export const INTERCEPTOR_AUDIO = JET_AUDIO;   // geriye uyum (eski ad)

// Dron → HEPGO 3B model tanımı: 'builtin:*' dahili; sunucu `preview` (GLB) + `orient` vermişse gerçekçi GLB (flightsim3d buildLibrary: 'glb:*' anahtarları ve
// MODEL_YUKSELT ile yükseltilmiş eski 'proc:*' kayıtları; pervane `rotor_*`/`propeller` düğümleri, kontrol yüzeyleri adıyla); 'proc:<şablon>' → dahili
// ('builtin:quad|hexa|heli|caymaz|delta'); kütüphane anahtarı + preview (orient'siz) → {id, glb_url}
const PROC_MAP = { quad250: 'builtin:quad', quad: 'builtin:quad', hexa: 'builtin:hexa', heli: 'builtin:heli', caymaz: 'builtin:caymaz', plane: 'builtin:caymaz', delta: 'builtin:delta', interceptor: 'builtin:delta', vtol: 'builtin:caymaz' };
export function modelFor(drone) {
  const key = String(drone?.model_key || '');
  if (key.startsWith('builtin:')) return { id: key };
  if (drone?.preview && drone?.orient) return { id: key || 'glb', glb_url: drone.preview, orient: drone.orient, has_prop: drone.has_prop !== false };
  if (key.startsWith('proc:')) return { id: PROC_MAP[key.slice(5)] || (needsLaunch(drone?.type) ? 'builtin:caymaz' : drone?.type === 'heli' ? 'builtin:heli' : 'builtin:quad') };
  if (key && drone?.preview) return { id: key, glb_url: drone.preview, orient: drone?.orient || undefined };
  return { id: drone?.type === 'heli' ? 'builtin:heli' : drone?.type === 'interceptor' ? 'builtin:icept_x4' : isRover(drone?.type) ? 'builtin:rover_4x4' : needsLaunch(drone?.type) ? 'builtin:caymaz' : 'builtin:quad' };
}
// Parkur `world` JSON (§3: size_m, trees_pct, extra_buildings, fog_pct, runway_deg, runway, time_of_day) → HEPGO WORLD_DEFAULTS anahtarları
// (size_m, tree_density 0…1, building_count, fog 0…1, runway_heading, runway, time 'day'|'dusk'|'night'); HEPGO adları da olduğu gibi kabul edilir.
export const WORLD_MODES = ['real', 'google3d', 'procedural'];
export const WORLD_MODE_LABEL = { real: 'Gerçek arazi', google3d: 'Google 3B', procedural: 'Prosedürel' };
export function worldFromTrack(track, mapsKey) {
  const w = track?.world || {};
  const pick = (...ks) => { for (const k of ks) if (w[k] != null) return w[k]; return undefined; };
  let mode = WORLD_MODES.includes(track?.world_mode) ? track.world_mode : 'google3d';
  if (mode === 'google3d' && !mapsKey) mode = 'procedural';   // anahtar yok (geliştirme/mock) → prosedürel
  const pct = v => (v == null ? undefined : clamp(Number(v) > 1 ? Number(v) / 100 : Number(v), 0, 1));
  const r = clamp(Number(track?.radius_m) || 1500, 200, 5000);
  return {
    mode, seed: ((Number(track?.id) || 1) * 7919 + 17) % 2147483646 || 12345,
    size_m: clamp(Number(pick('size_m')) || Math.round(r * 2.5), 1000, 20000),
    tree_density: pct(pick('tree_density', 'trees_pct')) ?? 0.3, building_count: Number(pick('building_count', 'extra_buildings')) || (mode === 'real' ? 0 : 40),
    fog: pct(pick('fog', 'fog_pct')) ?? 0.15, runway: pick('runway') !== false, runway_heading: Number(pick('runway_heading', 'runway_deg', 'heading')) || 0,
    time: timeOfDay(pick('time', 'time_of_day') ?? track?.time_of_day), wind_ms: Number(track?.wind?.speed_ms ?? pick('wind_ms')) || 0, wind_dir: Number(track?.wind?.dir_deg ?? pick('wind_dir')) || 0,
    mountain_height: 300, mountain_count: 4, water: 0.1, landing_circle_m: 30,
    // HEPGO §31: parkur hava durumu (bridge WEATHER: clear/cloudy/rain/fog/snow) → çekirdek world.weather (bulut, yağış, ıslak zemin/kar, görüş);
    // esinti (wind.gust) → world.wind_gust (sunucu SITL'e 1 Hz SIM_WIND_SPD; 3B tulum/akış çizgileri aynı formülle)
    weather: ['clear', 'cloudy', 'rain', 'fog', 'snow'].includes(track?.weather) ? track.weather : 'clear', wind_gust: Math.max(0, Number(track?.wind?.gust) || 0),
  };
}
const TIME_MAP = { day: 'day', dusk: 'dusk', night: 'night', gunduz: 'day', aksam: 'dusk', gece: 'night', 'Gündüz': 'day', 'Akşam': 'dusk', 'Gece': 'night' };
export const timeOfDay = v => { if (v == null) return 'day'; if (TIME_MAP[v]) return TIME_MAP[v]; const hh = Number(v); if (!Number.isFinite(hh)) return 'day'; return hh >= 21 || hh < 5 ? 'night' : hh >= 18 || hh < 7 ? 'dusk' : 'day'; };

// ---------- adım makinesi ----------
// createWizard({ drones, tracks, pilots, missions? }) → { state, steps(), index(), step(), canNext(), next(), prev(), goto(k), set(k, v), payload(), summary() }
export function createWizard(data = {}, init = {}, { match = false } = {}) {
  const S = {
    drone_id: init.drone_id ?? (data.drones || []).find(d => d.is_default)?.id ?? (data.drones || [])[0]?.id ?? null,
    track_id: init.track_id ?? (data.tracks || []).find(t => t.is_default)?.id ?? (data.tracks || [])[0]?.id ?? null,
    mission_id: init.mission_id ?? null,
    pilot_id: init.pilot_id ?? (data.pilots || []).find(p => p.is_default)?.id ?? (data.pilots || [])[0]?.id ?? null,
    launch: normLaunch(init.launch),
    ilaunch: normIceptLaunch(init.ilaunch || (isIceptLaunch(init.launch?.method) ? init.launch : null)),   // HEPGO §27 INTERCEPTOR fırlatıcısı
    record: { video: !!init.record?.video, bin: init.record?.bin !== false },
    power: init.power ?? null,          // §10: güç gövdesi (power.js body()); dron değişince sıfırlanır (adım yeniden kurar)
    speedup: init.speedup ?? 1,         // §10: başlangıç simülasyon hızı
    targets: init.targets ?? null,      // HEPGO §24 hedefler: {items, radius_m} | null (targets.js)
    site: init.site ?? null,            // HEPGO §26 yer kontrol sahası: {station, radar, radar_km, eo, eo_km} | null (flightsim_gcs_ui createSiteSection)
    defend: init.defend ?? null,        // HEPGO §26 "Yer kontrolünü koru" (sihirbazdan; yalnız INTERCEPTOR) | null — görev kaydı kind='defend' ise sunucu plandan alır
    drive: DRIVES.includes(init.drive) ? init.drive : null,   // §15 kara aracı sürüş biçimi (null → modelin); dron değişince sıfırlanır
    // §18 karşılaşma (match: true): halka ayarı (match_core.js ringsBody) + davet (oyuncu sayısı, şifre); *_err adım doğrulaması (null = geçerli)
    rings: init.rings ?? null, rings_err: null, max_players: init.max_players ?? 2, password: init.password ?? '', invite_err: null,
  };
  let i = 0;
  const drone = () => (data.drones || []).find(d => d.id === S.drone_id) || null;
  const type = () => drone()?.type || 'multirotor';
  const steps = () => (match ? STEPS_MATCH : STEPS).filter(k => k !== 'launch' || hasLaunchStep(type()));
  const step = () => steps()[Math.min(i, steps().length - 1)];
  const canNext = () => {
    const k = step();
    if (k === 'drone') return S.drone_id != null;
    if (k === 'track') return S.track_id != null;
    if (k === 'pilot') return S.pilot_id != null;
    if (k === 'rings') return !!S.rings && !S.rings_err;
    if (k === 'invite') return !S.invite_err && !!S.password;
    return true;   // launch (varsayılanlı), mission (isteğe bağlı)
  };
  const isLast = () => i >= steps().length - 1;
  const next = () => { if (!canNext() || isLast()) return false; i++; return true; };
  const prev = () => { if (i <= 0) return false; i--; return true; };
  const goto = k => { const j = steps().indexOf(k); if (j < 0 || j > i) return false; i = j; return true; };   // yalnız geriye ya da bulunulan adıma
  const set = (k, v) => {
    if (k === 'launch') S.launch = normLaunch({ ...S.launch, ...(v || {}) });
    else if (k === 'ilaunch') S.ilaunch = normIceptLaunch({ ...S.ilaunch, ...(v || {}), ...(v?.method && v.method !== S.ilaunch.method && v.loaded == null ? { loaded: ICEPT_CELLS[v.method] } : {}) });
    else if (k === 'record') S.record = { ...S.record, ...(v || {}) };
    else if (k === 'drive') S.drive = DRIVES.includes(v) ? v : null;
    else if (k === 'drone_id') { if (v !== S.drone_id) { S.power = null; S.drive = null; } S.drone_id = v; if (type() !== 'interceptor') S.defend = null; i = Math.min(i, steps().length - 1); if (S.mission_id != null) { /* görev parkura bağlı; dron değişince korunur */ } }
    else if (k === 'speedup') S.speedup = [0.25, 0.5, 1, 2, 4, 8].includes(Number(v)) ? Number(v) : 1;   // §35 ağır çekim
    else if (k === 'track_id') { if (v !== S.track_id) S.mission_id = null; S.track_id = v; }   // parkur değişti → görev sıfırlanır (§3 missions.track_id)
    else if (k in S) S[k] = v;
  };
  const ready = () => (match ? S.drone_id != null && S.track_id != null && !!S.rings && !S.rings_err && !S.invite_err && !!S.password
    : S.drone_id != null && S.track_id != null && S.pilot_id != null);
  const launchOf = () => (needsLaunch(type()) ? launchBody(S.launch) : type() === 'interceptor' ? iceptLaunchBody(S.ilaunch) : { method: 'wheels' });
  const payload = () => {
    if (!ready()) return null;
    if (match) return { drone_id: S.drone_id, track_id: S.track_id, launch: launchOf(), rings: Object.fromEntries(Object.entries(S.rings).filter(([k, v]) => !k.startsWith('_') && v !== '' && v != null && Number.isFinite(Number(v))).map(([k, v]) => [k, Number(v)])), password: S.password, max_players: S.max_players };   // POST /api/match
    const body = { drone_id: S.drone_id, pilot_id: S.pilot_id, track_id: S.track_id, record: { video: !!S.record.video, bin: !!S.record.bin } };
    if (S.mission_id != null) body.mission_id = S.mission_id;
    body.launch = launchOf();   // kopter/heli/kara aracı: alan zorunlu; `wheels` nötr değer; INTERCEPTOR: §27 fırlatıcı
    if (isRover(type())) body.drive = driveOf(drone(), S.drive);   // §15 kara aracı sürüş biçimi (sunucu: çekirdek SITL rover | rover-skid)
    if (S.power) body.power = { ...S.power };
    if (S.speedup !== 1) body.speedup = S.speedup;
    if (S.targets?.items?.length) body.targets = { items: S.targets.items.map(x => ({ ...x })), radius_m: S.targets.radius_m };
    if (S.site && (S.site.station || S.site.radar || S.site.eo)) body.site = { ...S.site };   // HEPGO §26
    const mk = (data.missions || []).find(m => m.id === S.mission_id)?.kind;
    if (S.defend && type() === 'interceptor' && mk !== 'defend') body.defend = { ...S.defend };   // görev kaydı defend ise sunucu planı kullanır
    return body;
  };
  const missionsFor = () => (data.missions || []).filter(m => S.track_id == null || m.track_id === S.track_id);
  return {
    state: S, match, steps, index: () => i, step, canNext, isLast, next, prev, goto, set, ready, payload, type, drone, missionsFor, drive: () => driveOf(drone(), S.drive),
    track: () => (data.tracks || []).find(t => t.id === S.track_id) || null,
    pilot: () => (data.pilots || []).find(p => p.id === S.pilot_id) || null,
    mission: () => (data.missions || []).find(m => m.id === S.mission_id) || null,
  };
}

// Geri sayım kareleri: 3 · 2 · 1 · BAŞLA — toplam süre `total` sn; t anında gösterilecek metin ve kalan oran (animasyon ölçeği)
export const COUNTDOWN_S = 3;
export function countdownAt(t, total = COUNTDOWN_S) {
  if (t >= total) return { text: 'BAŞLA', n: 0, frac: 1, done: true };
  const left = total - t, n = Math.ceil(left);
  return { text: String(n), n, frac: 1 - (left - Math.floor(left)), done: false };   // frac: sayı içinde geçen oran (0 → 1 büyüme/solma)
}
