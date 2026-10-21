// SIMUMAV tanıtım sitesi — dron filosu (statik katalog; /api/hangar/catalog oturum ister, site oturumsuz açılır) + saf yardımcılar.
// DOM'suz: hero3d.js, hangar3d.js ve node testi (tests/test_simumav_site.mjs) aynı dosyayı kullanır.
// Kaynak: app/simumav/bridge.py GLB_MODELS (ad/tip/boyut) + HEDEF_HIZ / ROVER_HIZ (seyir, azami km/h); CAYMAZ: app/flightsim_models.py BUILTIN + flightsim_targets.BUILTIN_HIZ.
// Test, anahtarların bridge.GLB_MODELS'te olduğunu ve hızların HEDEF_HIZ ile aynı olduğunu doğrular.
// GLB çerçevesi: SIMUMAV modelleri Y yukarı, burun +X (nose:'x'); CAYMAZ (HEPGO STEP→GLB) Y yukarı, burun +Z (nose:'z').

const SM = '/static/simumav/models/';
/** @type {{id:string, key:string, name:string, type:string, url:string, nose:'x'|'z', size:number|null, cruise:number, max:number}[]} */
export const FLEET = [
  { id: 'caymaz', key: 'builtin:caymaz', name: 'CAYMAZ V3', type: 'plane', url: '/static/models/caymaz-sim.glb', nose: 'z', size: 3.03, cruise: 90, max: 162 },
  { id: 'icept_x4', key: 'glb:icept_x4', name: 'INTERCEPTOR X4', type: 'interceptor', url: SM + 'icept_x4.glb', nose: 'x', size: null, cruise: 216, max: 400 },
  { id: 'sting', key: 'glb:sting', name: 'Sting', type: 'interceptor', url: SM + 'sting.glb', nose: 'x', size: 0.45, cruise: 150, max: 315 },
  { id: 'p1sun', key: 'glb:p1sun', name: 'P1-SUN', type: 'interceptor', url: SM + 'p1sun.glb', nose: 'x', size: 0.44, cruise: 150, max: 300 },
  { id: 'typhoon_h480', key: 'glb:typhoon_h480', name: 'Typhoon H480', type: 'multirotor', url: SM + 'typhoon_h480.glb', nose: 'x', size: 0.7, cruise: 36, max: 60 },
  { id: 'standard_vtol', key: 'glb:standard_vtol', name: 'Standard VTOL', type: 'vtol', url: SM + 'standard_vtol.glb', nose: 'x', size: 2.2, cruise: 70, max: 110 },
  { id: 'believer', key: 'glb:believer', name: 'Believer', type: 'plane', url: SM + 'believer.glb', nose: 'x', size: 1.9, cruise: 60, max: 110 },
  { id: 'zephyr', key: 'glb:zephyr', name: 'Zephyr', type: 'plane', url: SM + 'zephyr.glb', nose: 'x', size: 1.5, cruise: 72, max: 130 },
  { id: 'x500', key: 'glb:x500', name: 'X500', type: 'multirotor', url: SM + 'x500.glb', nose: 'x', size: 0.6, cruise: 36, max: 65 },
  { id: 'heli', key: 'glb:heli', name: 'Heli', type: 'heli', url: SM + 'heli.glb', nose: 'x', size: 1.75, cruise: 60, max: 110 },
  { id: 'iris_fpv', key: 'glb:iris_fpv', name: 'Iris FPV', type: 'fpv', url: SM + 'iris_fpv.glb', nose: 'x', size: 0.5, cruise: 60, max: 120 },
  { id: 'rc_cessna', key: 'glb:rc_cessna', name: 'RC Cessna', type: 'plane', url: SM + 'rc_cessna.glb', nose: 'x', size: 1.1, cruise: 60, max: 100 },
  { id: 'iris', key: 'glb:iris', name: '3DR Iris', type: 'multirotor', url: SM + 'iris.glb', nose: 'x', size: 0.5, cruise: 36, max: 60 },
  { id: 'talon_vtail', key: 'glb:talon_vtail', name: 'Talon V-tail', type: 'plane', url: SM + 'talon_vtail.glb', nose: 'x', size: 1.72, cruise: 65, max: 110 },
  { id: 'jet', key: 'glb:jet', name: 'Jet', type: 'plane', url: SM + 'jet.glb', nose: 'x', size: null, cruise: 300, max: 610 },
  // Kara araçları (§15; HEPGO §31 ArduRover): hızlar bridge.ROVER_HIZ (SIM_Rover: Ackermann 72 km/h, paletli/diferansiyel 14 km/h)
  { id: 'rover_4x4', key: 'glb:rover_4x4', name: 'Scout 4×4', type: 'rover', url: SM + 'rover_4x4.glb', nose: 'x', size: 2.2, cruise: 18, max: 72 },
  { id: 'rover_ugv', key: 'glb:rover_ugv', name: 'UGV', type: 'rover', url: SM + 'rover_ugv.glb', nose: 'x', size: 2.5, cruise: 11, max: 14 },
  { id: 'rover_bot', key: 'glb:rover_bot', name: 'Delivery Bot', type: 'rover', url: SM + 'rover_bot.glb', nose: 'x', size: 0.78, cruise: 11, max: 14 },
];
/** Açılış sahnesi (sinematik gösterim) sırası: CAYMAZ → INTERCEPTOR'lar → diğer gerçekçi modeller. */
export const REEL = ['caymaz', 'icept_x4', 'sting', 'p1sun', 'typhoon_h480', 'standard_vtol', 'believer', 'zephyr', 'x500', 'heli', 'iris_fpv'];
export const SHOT_SEC = 7;        // her model ekranda (sn)
export const FADE_SEC = 0.55;     // kararma/açılma (sn)

export const byId = id => FLEET.find(m => m.id === id) || null;
export const reelModels = () => REEL.map(byId).filter(Boolean);
/** Döner kanatlı mı (havada asılı durur; sabit kanat ileri uçar). */
export const isRotor = m => ['multirotor', 'fpv', 'heli'].includes(m?.type);

/**
 * Gösterim zamanlaması: t (sn) → { index, local (0…SHOT_SEC), fade (0 açık … 1 tam karanlık), progress (0…1) }.
 * Çekim sonunda FADE_SEC kararır, yeni çekimin başında FADE_SEC açılır (film kesmesi: "dip to black").
 */
export function reelAt(t, n, shot = SHOT_SEC, fade = FADE_SEC) {
  if (!(n > 0)) return { index: 0, local: 0, fade: 0, progress: 0 };
  const tt = Math.max(0, Number(t) || 0);
  const index = Math.floor(tt / shot) % n, local = tt % shot;
  return { index, local, fade: shotFade(local, shot, fade), progress: local / shot };
}
/** Çekim içi kararma: başta FADE'de açılır, sonda FADE'de kararır (0 açık … 1 karanlık). */
export function shotFade(local, shot = SHOT_SEC, fade = FADE_SEC) {
  let f = 0;
  if (local < fade) f = 1 - local / fade;
  else if (local > shot - fade) f = (local - (shot - fade)) / fade;
  return Math.min(1, Math.max(0, Math.round(f * 1e6) / 1e6));
}

/** Hız/boyut etiketi: "3,03 m · 90–162 km/h" (dil ayırıcısı: Intl). */
export function specLine(m, lang = 'tr') {
  const nf = new Intl.NumberFormat(lang, { maximumFractionDigits: 2 });
  const parts = [];
  if (m?.size) parts.push(`${nf.format(m.size)} m`);
  if (m?.max) parts.push(`${nf.format(m.cruise)}–${nf.format(m.max)} km/h`);
  return parts.join(' · ');
}

// ---------- tema (gece/gündüz) ----------
export const THEME_KEY = 'simumav.theme';
/** Kayıtlı tercih ('dark'|'light'|null) + sistem açık mı → etkin tema. Kayıt yoksa sistem izlenir. */
export function resolveTheme(stored, systemLight) {
  return stored === 'dark' || stored === 'light' ? stored : (systemLight ? 'light' : 'dark');
}
/** Düğme: etkin temanın tersi kaydedilir; tersi sistemle aynıysa kayıt silinir (yeniden sistemi izle). */
export function nextTheme(current, systemLight) {
  const next = current === 'light' ? 'dark' : 'light';
  return { theme: next, store: next === (systemLight ? 'light' : 'dark') ? null : next };
}

// ---------- bölüm gezinmesi ----------
export const SECTIONS = ['hero', 'modules', 'hangar', 'crew', 'tracks', 'missions', 'fly', 'ops', 'systems', 'physics', 'fpv', 'cta'];
/** "#hangar" → 'hangar'; bilinmeyen/boş → null (hash ile keyfi seçici çalıştırılmaz). */
export function sectionFromHash(hash) {
  const id = String(hash || '').replace(/^#/, '').trim().toLowerCase();
  return SECTIONS.includes(id) ? id : null;
}
