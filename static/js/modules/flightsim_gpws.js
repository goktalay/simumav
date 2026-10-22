// Uçuş Simülatörü §42 — UÇUŞ UYARI SİSTEMİ (GPWS / stall / bank angle / master caution tarzı; HEPGO + SIMUMAV ortak). SAF katman: DOM yok
// (Node testi tests/test_flightsim_gpws.mjs). Arayüz + ses: flightsim_gpws_ui.js. Sunucu eşleniği (özet + puan): app/flightsim_gpws.py.
//
// Kullanıcı isteği: "uçakta IMU ya da gyro saçmalarsa hem sesli hem görsel uyarı görünür, benzerini yapalım, oyuncu hata yapmaya çekinsin;
// açılıp kapanabilir olsun."
//
// • Girdi: telemetri karesi → `teleInput(tele, ctx)` → normalleştirilmiş kare {t (sn), armed, mode, agl, aglAhead, vs, gs, as, roll/pitch (°),
//   rates {p,q,r} (°/s), batarya/yakıt, gps, sens_bad (SYS_STATUS sağlık), ekf (EKF_STATUS_REPORT en büyük varyans), vibe (VIBRATION m/s²), rüzgâr,
//   motor kesik, kalkış aşaması, evden mesafe, bağlantı yaşı, çarpışma}.
// • Değerlendirici `createGpws({vehicle, cfg, maxSpeed, fence})` → step(kare): ham koşullar (araç tipine ve uçuş kipine göre eşikler, açıkken
//   gevşeyen eşik = histerezis) → kod başına durum makinesi (tetik gecikmesi, temizlenme gecikmesi, en kısa gösterim süresi) → öncelik sıralı etkin
//   uyarılar. Evre bastırma: ARM'sız yok; kalkışta (havalanmadan önce + havalanmadan sonra kısa süre, rampa/fırlatıcı aşaması, TAKEOFF kipi) arazi /
//   alçalma / stall / yunuslama uyarıları yok; LAND / QLAND ve RTL son yaklaşmasında TERRAIN / TOO LOW / DON'T SINK yok; çarpışmada hepsi susar.
// • Onay (MASTER düğmesi): o anki etkin uyarılar onaylanır → ses susar, koşul sürerse görsel kalır; yeni uyarı gelince yine çalar.
// • Bölümler (episode): {code, level, t0 (kare saati sn), start_s (ilk ARM'dan), dur_s} → olay şeridi, sunucu (cmd gpws), özet rapor.
// • Puan (`summarizeAlerts`): "uçuş disiplini" 0–100 (uyarısız uçuş 100); sunucu app/flightsim_gpws.py ile AYNI formül.

export const GPWS_LEVELS = ['warning', 'caution'];
// code · level · prio (büyük önce) · av: havacılık metni (İngilizce, varsayılan görsel) · say: sesli uyarı (İngilizce) · tr: Türkçe metin (arayüz dili
// seçilince i18n anahtarı) · rover: kara aracında geçerli mi · plane: yalnız sabit kanat kipinde
export const GPWS_CODES = [
  { code: 'PULL_UP', level: 'warning', prio: 100, av: 'PULL UP', say: 'Pull up', tr: 'YUKARI ÇEK' },
  { code: 'TERRAIN', level: 'warning', prio: 95, av: 'TERRAIN', say: 'Terrain, terrain', tr: 'ARAZİ' },
  { code: 'STALL', level: 'warning', prio: 92, av: 'STALL', say: 'Stall, stall', tr: 'PERDÖVİTES', plane: true },
  { code: 'IMU_FAULT', level: 'warning', prio: 90, av: 'GYRO / IMU FAULT', say: 'Gyro fault', tr: 'JİROSKOP / IMU ARIZASI', rover: true },
  { code: 'ENGINE', level: 'warning', prio: 88, av: 'ENGINE OUT', say: 'Engine out', tr: 'MOTOR DURDU' },
  { code: 'OVERSPEED', level: 'warning', prio: 85, av: 'OVERSPEED', say: 'Overspeed', tr: 'AŞIRI HIZ' },
  { code: 'BANK_ANGLE', level: 'warning', prio: 80, av: 'BANK ANGLE', say: 'Bank angle, bank angle', tr: 'YATIŞ AÇISI' },
  { code: 'PITCH', level: 'warning', prio: 78, av: 'PITCH', say: 'Pitch, pitch', tr: 'YUNUSLAMA AÇISI' },
  { code: 'SINK_RATE', level: 'warning', prio: 75, av: 'SINK RATE', say: 'Sink rate', tr: 'ALÇALMA HIZI' },
  { code: 'BATT_CRIT', level: 'warning', prio: 70, av: 'BATTERY CRITICAL', say: 'Battery critical', tr: 'BATARYA KRİTİK', rover: true },
  { code: 'FUEL', level: 'warning', prio: 69, av: 'FUEL', say: 'Fuel, fuel', tr: 'YAKIT KRİTİK', rover: true },
  { code: 'GPS_LOST', level: 'warning', prio: 65, av: 'GPS LOST', say: 'G P S lost', tr: 'GPS KAYBI', rover: true },
  { code: 'GEOFENCE', level: 'warning', prio: 60, av: 'GEOFENCE', say: 'Geofence', tr: 'SANAL ÇİT', rover: true },
  { code: 'TOO_LOW', level: 'caution', prio: 50, av: 'TOO LOW', say: 'Too low, terrain', tr: 'ÇOK ALÇAK' },
  { code: 'DONT_SINK', level: 'caution', prio: 48, av: "DON'T SINK", say: "Don't sink", tr: 'İRTİFA KAYBI' },
  { code: 'EKF', level: 'caution', prio: 45, av: 'EKF VARIANCE', say: 'E K F variance', tr: 'EKF SAPMASI', rover: true },
  { code: 'VIBRATION', level: 'caution', prio: 42, av: 'VIBRATION', say: 'Vibration', tr: 'TİTREŞİM', rover: true },
  { code: 'BATT_LOW', level: 'caution', prio: 40, av: 'BATTERY LOW', say: 'Battery low', tr: 'BATARYA DÜŞÜK', rover: true },
  { code: 'FUEL_LOW', level: 'caution', prio: 39, av: 'FUEL LOW', say: 'Fuel low', tr: 'YAKIT DÜŞÜK', rover: true },
  { code: 'WIND', level: 'caution', prio: 35, av: 'HIGH WIND', say: 'High wind', tr: 'KUVVETLİ RÜZGÂR' },
  { code: 'LINK', level: 'caution', prio: 30, av: 'LINK LOST', say: 'Link lost', tr: 'BAĞLANTI KAYBI', rover: true },
];
export const GPWS_BY_CODE = Object.fromEntries(GPWS_CODES.map(c => [c.code, c]));
export const codeDef = code => GPWS_BY_CODE[code] || null;

// ---------- ayarlar (tercih: HEPGO localStorage `fs.gpws`, SIMUMAV `sm.gpws`) ----------
export const GPWS_MODES = ['off', 'visual', 'full'];   // Kapalı · Yalnız görsel · Görsel + ses
export const GPWS_LANGS = ['aviation', 'ui'];          // havacılık geleneği (İngilizce) · arayüz dili
export const GPWS_SENS = ['low', 'normal', 'high'];
export const BANK_LIMITS = { copter: [20, 60], plane: [30, 70] };
export const GPWS_DEFAULT = Object.freeze({ mode: 'full', lang: 'aviation', sens: 'normal', bank_copter: 35, bank_plane: 45, off: [] });
const clampN = (v, a, b, d) => { const n = Number(v); return Number.isFinite(n) ? Math.min(b, Math.max(a, n)) : d; };
/** Herhangi bir girdi → geçerli ayar nesnesi (bilinmeyen kodlar atılır). Varsayılan: Görsel + ses AÇIK. */
export function normalizeGpwsCfg(c) {
  const o = c && typeof c === 'object' ? c : {};
  return {
    mode: GPWS_MODES.includes(o.mode) ? o.mode : GPWS_DEFAULT.mode,
    lang: GPWS_LANGS.includes(o.lang) ? o.lang : GPWS_DEFAULT.lang,
    sens: GPWS_SENS.includes(o.sens) ? o.sens : GPWS_DEFAULT.sens,
    bank_copter: Math.round(clampN(o.bank_copter, ...BANK_LIMITS.copter, GPWS_DEFAULT.bank_copter)),
    bank_plane: Math.round(clampN(o.bank_plane, ...BANK_LIMITS.plane, GPWS_DEFAULT.bank_plane)),
    off: Array.isArray(o.off) ? [...new Set(o.off.filter(k => GPWS_BY_CODE[k]))] : [],
  };
}
/** Tercih deposu: storage = {get() → obj|null, set(obj)} (yoksa localStorage `fs.gpws`). */
export function createGpwsPrefs(storage = null) {
  const ls = typeof localStorage !== 'undefined' ? localStorage : null;
  const st = storage || { get: () => { try { const v = ls?.getItem('fs.gpws'); return v ? JSON.parse(v) : null; } catch { return null; } }, set: v => { try { ls?.setItem('fs.gpws', JSON.stringify(v)); } catch { /* özel kip */ } } };
  let cfg = normalizeGpwsCfg(st.get());
  const subs = new Set();
  return {
    get: () => ({ ...cfg, off: [...cfg.off] }),
    set(patch) { cfg = normalizeGpwsCfg({ ...cfg, ...(patch || {}) }); st.set(cfg); subs.forEach(f => { try { f(cfg); } catch { /* */ } }); return cfg; },
    toggleCode(code, on) { const off = new Set(cfg.off); if (on) off.delete(code); else off.add(code); return this.set({ off: [...off] }); },
    onChange(f) { subs.add(f); return () => subs.delete(f); },
  };
}

// ---------- araç tipi → değerlendirme sınıfı ----------
// SITL tipi (multirotor/hexarotor/helikopter/sabit_kanat/vtol/interceptor/rover) ya da SIMUMAV tipi (fpv/plane/…) → copter | heli | plane | vtol | icept | rover
export function vehicleClass(type) {
  const t = String(type || '').toLowerCase();
  if (t === 'rover' || t.startsWith('rover')) return 'rover';
  if (t === 'interceptor') return 'icept';
  if (t === 'vtol') return 'vtol';
  if (t === 'sabit_kanat' || t === 'plane' || t === 'delta' || t === 'caymaz') return 'plane';
  if (t === 'helikopter' || t === 'heli') return 'heli';
  return 'copter';
}
const Q_MODE = m => /^Q/.test(String(m || ''));
/** O anki kip sınıfı: VTOL / INTERCEPTOR Q kiplerinde kopter eşikleri; diğerleri sabit. */
export function modeKind(vc, mode) {
  if (vc === 'rover') return 'rover';
  if (vc === 'plane') return 'plane';
  if (vc === 'vtol' || vc === 'icept') return Q_MODE(mode) ? 'copter' : 'plane';
  return 'copter';   // copter + heli
}
const LAND_MODES = new Set(['LAND', 'QLAND']);
const RTL_MODES = new Set(['RTL', 'QRTL', 'SMART_RTL', 'AUTO_RTL']);
const ACRO_MODES = new Set(['ACRO', 'FLIP', 'TRAINING', 'AUTOTUNE', 'QACRO', 'QAUTOTUNE', 'STABILIZE_ACRO']);

// Temel eşikler (sens 'normal'). Süreler sn, hızlar m/s, açılar °, irtifalar m (AGL).
export const BASE_THRESH = {
  copter: { aglMax: 80, sinkMin: 2.5, sinkHard: 6, tPull: 3.5, tTerrain: 7, look: 4, pitchUp: 35, pitchDn: 35, vne: 22, stall: null, grace: 3, airAgl: 1.5,
    tooLowAgl: 4, tooLowGs: 8, tooLowPeak: 15, dsAgl: 40, dsLoss: 6, wind: 12, finalAgl: 25, finalDist: 60 },
  plane: { aglMax: 300, sinkMin: 4, sinkHard: 12, tPull: 5, tTerrain: 10, look: 8, pitchUp: 30, pitchDn: 25, vne: 38, stall: 9, grace: 8, airAgl: 5,
    tooLowAgl: 30, tooLowGs: 12, tooLowPeak: 60, dsAgl: 200, dsLoss: 15, wind: 15, finalAgl: 60, finalDist: 400 },
  rover: { wind: 99 },
};
const SENS_K = { low: 0.75, normal: 1, high: 1.3 };
/** Eşikler: araç sınıfı + kip sınıfı + ayar (hassasiyet, yatış eşiği) + azami hız (güç ayarı) → düz nesne. */
export function gpwsThresholds(vc, kind, cfg = GPWS_DEFAULT, { maxSpeed = null } = {}) {
  const base = BASE_THRESH[kind] || BASE_THRESH.copter;
  const k = SENS_K[cfg.sens] || 1;
  const P = { ...base };
  if (kind !== 'rover') {
    P.tPull = base.tPull * k; P.tTerrain = base.tTerrain * k; P.sinkHard = base.sinkHard / k; P.tooLowAgl = base.tooLowAgl * k;
    P.bank = kind === 'plane' ? cfg.bank_plane : cfg.bank_copter;
    if (vc === 'icept' && kind === 'plane') P.vne = 70;
    if (vc === 'heli') P.vne = 30;
    const ms = Number(maxSpeed);
    if (Number.isFinite(ms) && ms > 3) P.vne = ms * 1.08;   // §23 güç ayarındaki azami hız (sınırın %8 üstü)
  }
  return P;
}
/** Kod araç sınıfında geçerli mi (kara aracında uçuş uyarıları yok; STALL yalnız kanatlılarda). */
export function codeApplies(code, vc) {
  const d = GPWS_BY_CODE[code];
  if (!d) return false;
  if (vc === 'rover') return !!d.rover;
  if (d.plane) return vc === 'plane' || vc === 'vtol' || vc === 'icept';
  return true;
}

// ---------- telemetri → normalleştirilmiş kare ----------
const RAD = 180 / Math.PI;
const nnum = v => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
// SYS_STATUS sağlık bitleri (MAV_SYS_STATUS_SENSOR): 3D_GYRO 1 · 3D_ACCEL 2. AHRS (0x200000) bilerek DIŞARIDA: gerçek ArduCopter SITL'de düz uçuşta da
// "sağlıksız" bildiriliyor (tests/test_flightsim_gpws_sitl ölçümü: sens_bad = 0x200000) → yanlış alarm olurdu.
export const IMU_MASK = 0x1 | 0x2;
/**
 * tele: canlı WS `tele` karesi ya da kayıttan oynatma karesi (aynı alan adları). ctx (istemci): {agl, aglAhead, distHome, linkAge (ms), crashed, phase}.
 * Zaman: canlı SITL saati (tbm ms), kayıtta kare zamanı t (sn), sahte kipte ts.
 */
export function teleInput(t, ctx = {}) {
  const tbm = nnum(t?.tbm);
  const time = ctx.t != null ? Number(ctx.t) : tbm != null && tbm > 0 ? tbm / 1000 : nnum(t?.t) != null ? Number(t.t) : (nnum(t?.ts) ?? 0) / (Number(t?.ts) > 1e10 ? 1000 : 1);
  const vd = nnum(t?.vd), climb = nnum(t?.climb);
  const rs = nnum(t?.rs), ps = nnum(t?.ps), ys = nnum(t?.ys);
  const elec = t?.elec || null, fuel = t?.fuel || null;
  const agl = nnum(ctx.agl) ?? nnum(t?.terrain_agl) ?? nnum(t?.alt_rel);
  return {
    t: time, armed: !!t?.armed, mode: t?.mode || null,
    agl, aglAhead: nnum(ctx.aglAhead),
    vs: climb != null ? climb : vd != null ? -vd : 0,
    gs: nnum(t?.groundspeed) ?? (nnum(t?.vn) != null ? Math.hypot(Number(t.vn), Number(t.ve) || 0) : null),
    as: nnum(t?.airspeed),
    roll: nnum(t?.roll) != null ? Number(t.roll) * RAD : null, pitch: nnum(t?.pitch) != null ? Number(t.pitch) * RAD : null,
    rates: rs != null || ps != null || ys != null ? { p: (rs ?? 0) * RAD, q: (ps ?? 0) * RAD, r: (ys ?? 0) * RAD } : null,
    battPct: elec ? nnum(elec.pct) : nnum(t?.batt_pct), battEmpty: !!elec?.empty,
    fuelPct: fuel ? nnum(fuel.pct) : null, fuelEmpty: !!fuel?.empty,
    gpsFix: nnum(t?.gps_fix), sats: nnum(t?.sats),
    sensBad: nnum(t?.sens_bad) ?? 0, ekf: nnum(t?.ekf), vibe: nnum(t?.vibe),
    wind: nnum(t?.wind_spd), motorCut: !!t?.motor_cut,
    phase: ctx.phase ?? null, distHome: nnum(ctx.distHome), linkAge: nnum(ctx.linkAge), crashed: !!ctx.crashed,
  };
}
const wrap180 = d => ((d % 360) + 540) % 360 - 180;

// ---------- ham koşullar ----------
/** Bellek (S) güncellenir; on: şu an etkin kodlar (histerezis: açıkken eşik gevşer). Dönüş: {code: bool}. */
export function rawConditions(I, S, P, vc, kind, on = new Set()) {
  const R = {};
  const t = I.t;
  // ARM / havada / GPS belleği
  if (I.armed) {
    if (S.armedAt == null) S.armedAt = t;
    if (S.firstArmT == null) S.firstArmT = t;
    S.wasArmedAt = t;
    if (I.agl != null && I.agl > (P.airAgl ?? 1.5)) { if (S.airAt == null) S.airAt = t; }
    if (S.airAt != null && I.agl != null) S.peakAgl = Math.max(S.peakAgl || 0, I.agl);
  } else { S.armedAt = null; S.airAt = null; S.peakAgl = 0; }
  if (I.gpsFix != null && I.gpsFix >= 3) S.gpsSeen = true;
  const A = I.armed && !I.crashed;
  const inAir = A && S.airAt != null && kind !== 'rover';
  const sinceAir = inAir ? t - S.airAt : 0;
  const takeoff = !inAir || sinceAir < (P.grace ?? 3) || I.phase === 'armed' || I.phase === 'launch' || I.mode === 'TAKEOFF';
  const landing = LAND_MODES.has(I.mode) || ((RTL_MODES.has(I.mode) || I.mode === 'AUTO') && I.agl != null && I.agl < (P.finalAgl ?? 25) && (I.distHome == null || I.distHome < (P.finalDist ?? 60)));
  const acro = ACRO_MODES.has(I.mode);
  const agl = I.agl ?? 0, sink = Math.max(0, -(I.vs || 0));
  // §42 yer yaklaşması (GPWS kip 1/2): kapanma hızı = alçalma ya da ileri bakış noktasındaki AGL kaybı / ileri bakış süresi (arazi yükselmesi dahil)
  const closeAhead = I.aglAhead != null ? Math.max(0, (agl - I.aglAhead) / (P.look || 4)) : 0;
  const closure = Math.max(sink, closeAhead);
  const terrainRise = closeAhead - sink > 1;   // kaynak arazi (dron alçalmasa da arazi yaklaşıyor)
  const ttc = closure > 0.1 ? agl / closure : Infinity;
  if (inAir && !takeoff && kind !== 'rover') {
    R.PULL_UP = agl < P.aglMax && closure > P.sinkMin && ttc < P.tPull * (on.has('PULL_UP') ? 1.3 : 1);
    R.TERRAIN = !landing && terrainRise && agl < P.aglMax * 1.5 && ttc < P.tTerrain * (on.has('TERRAIN') ? 1.2 : 1);
    R.SINK_RATE = (sink > P.sinkHard * (on.has('SINK_RATE') ? 0.8 : 1) && agl < P.aglMax * 3)
      || (!landing && !terrainRise && sink > P.sinkMin && ttc < P.tTerrain * (on.has('SINK_RATE') ? 1.2 : 1));
    if (kind === 'plane' && P.stall && I.as != null) {
      const vs0 = P.stall * (on.has('STALL') ? 1.15 : 1);
      R.STALL = agl > 3 && (I.as < vs0 || ((I.pitch ?? 0) > 15 && I.as < P.stall * 1.3));
    }
    if (I.pitch != null) { const h = on.has('PITCH') ? 5 : 0; R.PITCH = I.pitch > P.pitchUp - h || I.pitch < -(P.pitchDn - h); }
    R.TOO_LOW = !landing && (S.peakAgl || 0) > P.tooLowPeak && agl < P.tooLowAgl * (on.has('TOO_LOW') ? 1.3 : 1) && (I.gs ?? 0) > P.tooLowGs * (on.has('TOO_LOW') ? 0.8 : 1);
    R.DONT_SINK = !landing && sinceAir < 60 && agl < P.dsAgl && (S.peakAgl || 0) - agl > P.dsLoss * (on.has('DONT_SINK') ? 0.6 : 1) && (I.vs ?? 0) < (on.has('DONT_SINK') ? 0.5 : -0.5);
  }
  if (inAir && I.roll != null) R.BANK_ANGLE = Math.abs(I.roll) > P.bank - (on.has('BANK_ANGLE') ? 5 : 0);
  if (inAir) {
    const spd = kind === 'plane' ? (I.as ?? I.gs) : I.gs;
    if (spd != null) R.OVERSPEED = spd > P.vne * (on.has('OVERSPEED') ? 0.95 : 1);
    if (I.wind != null) R.WIND = I.wind > P.wind - (on.has('WIND') ? 2 : 0);
  }
  // Motor/itki kaybı: havada motor kesik, ya da havadayken DISARM (motorlar durdu, düşüyor)
  R.ENGINE = (inAir && I.motorCut) || (kind !== 'rover' && !I.armed && !I.crashed && S.wasArmedAt != null && t - S.wasArmedAt < 8 && agl > 3 && sink > 1.5);
  // IMU / jiroskop: SITL sağlık biti (gyro/ivmeölçer/AHRS), EKF varyansı ≥ 0,8, tutarsız açısal hız / sürekli dönme / tutum sıçraması
  let imu = false;
  if (A) {
    if ((I.sensBad & IMU_MASK) !== 0) imu = true;
    if (I.ekf != null && I.ekf >= 0.8) imu = true;
    if (!acro && I.rates) {
      const fast = Math.abs(I.rates.p) > 400 || Math.abs(I.rates.q) > 400;
      S.rateSince = fast ? (S.rateSince ?? t) : null;
      if (S.rateSince != null && t - S.rateSince >= 0.4) imu = true;
      const spinLim = kind === 'plane' ? 120 : 200, spinDur = kind === 'plane' ? 3 : 2;
      const spin = Math.abs(I.rates.r) > spinLim;
      S.spinSince = spin ? (S.spinSince ?? t) : null;
      if (S.spinSince != null && t - S.spinSince >= spinDur) imu = true;
    } else { S.rateSince = null; S.spinSince = null; }
    const pa = S.prevAtt;
    if (!acro && pa && I.roll != null && I.pitch != null) {
      const dt = t - pa.t;
      if (dt > 0 && dt <= 0.15) {
        const dr = wrap180(I.roll - pa.roll), dp = wrap180(I.pitch - pa.pitch);
        const big = Math.abs(dr) > 45 || Math.abs(dp) > 45;
        const odd = !I.rates || Math.abs(dr / dt - I.rates.p) > 250 || Math.abs(dp / dt - I.rates.q) > 250;
        if (big && odd) S.jumpUntil = t + 3;
      }
    }
    if (S.jumpUntil != null && t < S.jumpUntil) imu = true;
  }
  S.prevAtt = I.roll != null && I.pitch != null ? { t, roll: I.roll, pitch: I.pitch } : null;
  R.IMU_FAULT = imu;
  if (A && I.ekf != null) R.EKF = I.ekf >= 0.5 - (on.has('EKF') ? 0.05 : 0) && I.ekf < 0.8;
  if (A && I.vibe != null) R.VIBRATION = I.vibe > (on.has('VIBRATION') ? 25 : 30);
  // Batarya / yakıt (§23 istemci modeli varsa onun yüzdesi)
  if (A) {
    const bc = I.battEmpty || (I.battPct != null && I.battPct < 10 + (on.has('BATT_CRIT') ? 3 : 0));
    R.BATT_CRIT = !!bc;
    R.BATT_LOW = !bc && I.battPct != null && I.battPct < 25 + (on.has('BATT_LOW') ? 3 : 0);
    const fc = I.fuelEmpty || (I.fuelPct != null && I.fuelPct < 5 + (on.has('FUEL') ? 2 : 0));
    R.FUEL = !!fc;
    R.FUEL_LOW = !fc && I.fuelPct != null && I.fuelPct < 20 + (on.has('FUEL_LOW') ? 3 : 0);
    R.GPS_LOST = !!S.gpsSeen && I.gpsFix != null && I.gpsFix < 3;
    if (P.fence) R.GEOFENCE = I.distHome != null && I.distHome > P.fence * (on.has('GEOFENCE') ? 0.95 : 1);
    if (I.linkAge != null) R.LINK = I.linkAge > (on.has('LINK') ? 800 : 1500);
  }
  if (I.crashed) for (const k of Object.keys(R)) R[k] = false;
  return R;
}

// ---------- kod başına durum makinesi ----------
const ON_DELAY = { GPS_LOST: 1, BATT_CRIT: 1, BATT_LOW: 1, FUEL: 1, FUEL_LOW: 1, WIND: 2, VIBRATION: 1, EKF: 1, TOO_LOW: 0.5, DONT_SINK: 0.5, IMU_FAULT: 0, LINK: 1, ENGINE: 0.5 };   // LINK 1 sn: tarayıcı ana iş parçacığı takılmasında (3B yükleme) yanlış alarm olmasın
export const OFF_DELAY = 1.0, MIN_SHOW = 2.5, ON_DELAY_DEFAULT = 0.3;
const onDelay = c => ON_DELAY[c] ?? ON_DELAY_DEFAULT;

/**
 * createGpws({ vehicle, cfg, maxSpeed, fence }) → { step(I) → {active, primary, fresh, ended}, ack(level?), reset(), close(t), episodes(), summary(),
 *   setCfg(cfg), setMaxSpeed(v), setFence(r), state() }
 * active: [{code, level, prio, since, acked}] öncelik sıralı; fresh: bu adımda AÇILAN kodlar; ended: bu adımda kapanan bölümler.
 */
export function createGpws(o = {}) {
  const vc = vehicleClass(o.vehicle);
  let cfg = normalizeGpwsCfg(o.cfg);
  let maxSpeed = o.maxSpeed ?? null, fence = o.fence ?? null;
  let S = {};
  const st = new Map();   // code → {on, rawSince, offSince, onAt, acked}
  const eps = [];         // kapanan bölümler
  let lastT = null, lastPrimary = null;
  const enabled = code => cfg.mode !== 'off' && codeApplies(code, vc) && !cfg.off.includes(code);
  const openEp = (code, s) => ({ code, level: GPWS_BY_CODE[code].level, t0: round2(s.onAt), start_s: S.firstArmT != null ? round2(Math.max(0, s.onAt - S.firstArmT)) : 0 });
  function closeCode(code, s, tEnd, out) {
    const ep = { ...openEp(code, s), dur_s: round2(Math.max(0, tEnd - s.onAt)) };
    eps.push(ep); out?.push(ep);
    s.on = false; s.acked = false; s.rawSince = null; s.offSince = null; s.onAt = null;
  }
  function close(t = lastT) {
    const out = [];
    for (const [code, s] of st) if (s.on) closeCode(code, s, t ?? s.onAt, out);
    return out;
  }
  function reset() { close(); st.clear(); S = {}; lastT = null; lastPrimary = null; }
  function step(I) {
    const t = Number(I.t) || 0;
    const ended = [], fresh = [];
    if (lastT != null && t < lastT - 0.5) { ended.push(...close(lastT)); st.clear(); S = {}; }   // zaman geri gitti (Sıfırla / atlama) → bölümler kapanır
    lastT = t;
    const kind = modeKind(vc, I.mode);
    const P = gpwsThresholds(vc, kind, cfg, { maxSpeed });
    P.fence = fence;
    const on = new Set([...st].filter(([, s]) => s.on).map(([c]) => c));
    const R = cfg.mode === 'off' ? {} : rawConditions(I, S, P, vc, kind, on);
    for (const def of GPWS_CODES) {
      const code = def.code;
      let s = st.get(code);
      const raw = enabled(code) && !!R[code];
      if (!s) { if (!raw) continue; s = { on: false, rawSince: null, offSince: null, onAt: null, acked: false }; st.set(code, s); }
      if (raw) {
        s.offSince = null;
        if (!s.on) {
          if (s.rawSince == null) s.rawSince = t;
          if (t - s.rawSince >= onDelay(code) - 1e-9) { s.on = true; s.onAt = s.rawSince; s.acked = false; fresh.push(code); }
        }
      } else {
        s.rawSince = null;
        if (s.on) {
          if (!enabled(code)) { closeCode(code, s, t, ended); continue; }   // tür kapatıldı → hemen
          if (s.offSince == null) s.offSince = t;
          if (t - s.offSince >= OFF_DELAY && t - s.onAt >= MIN_SHOW) closeCode(code, s, s.offSince, ended);
        }
      }
    }
    const active = [...st].filter(([, s]) => s.on).map(([code, s]) => ({ code, level: GPWS_BY_CODE[code].level, prio: GPWS_BY_CODE[code].prio, since: s.onAt, acked: s.acked, clearing: s.offSince != null }))
      .sort((a, b) => b.prio - a.prio);
    const primary = active[0] || null;
    lastPrimary = primary?.code || null;
    return { active, primary, fresh, ended };
  }
  /** MASTER onayı: level verilirse yalnız o seviye; ses susar, görsel (koşul sürdükçe) kalır. */
  function ack(level = null) { let n = 0; for (const [code, s] of st) if (s.on && !s.acked && (!level || GPWS_BY_CODE[code].level === level)) { s.acked = true; n++; } return n; }
  return {
    step, ack, reset, close, vehicleClass: vc,
    episodes: () => eps.slice(),
    summary: () => summarizeAlerts(eps, { mode: cfg.mode, off: cfg.off }),
    setCfg(c) { cfg = normalizeGpwsCfg(c); if (cfg.mode === 'off') close(); },
    get cfg() { return { ...cfg }; },
    setMaxSpeed(v) { maxSpeed = v; }, setFence(r) { fence = r; },
    state: () => ({ lastT, primary: lastPrimary, mem: { ...S }, on: [...st].filter(([, s]) => s.on).map(([c, s]) => ({ code: c, acked: s.acked, onAt: s.onAt })) }),
  };
}
const round2 = v => Math.round(Number(v) * 100) / 100;

// ---------- özet + puan (sunucu app/flightsim_gpws.py ile AYNI) ----------
export const SCORE_RULES = { warning: { base: 6, per_s: 1.5, cap: 20 }, caution: { base: 2, per_s: 0.5, cap: 8 } };
export const penaltyOf = ep => { const r = SCORE_RULES[ep.level] || SCORE_RULES.caution; return Math.min(r.cap, r.base + r.per_s * Math.max(0, Number(ep.dur_s) || 0)); };
export const gradeOf = s => (s == null ? null : s >= 90 ? 'A' : s >= 75 ? 'B' : s >= 60 ? 'C' : s >= 40 ? 'D' : 'F');
/** Bölümler → {mode, events (≤ 200, zaman sırası), by_code {code: {level, n, total_s, first_s}}, warnings, cautions, total_s, score, grade}. Kapalıyken puan yok. */
export function summarizeAlerts(list, { mode = 'full', off = [] } = {}) {
  const events = (Array.isArray(list) ? list : []).filter(e => e && GPWS_BY_CODE[e.code]).slice().sort((a, b) => (a.t0 ?? 0) - (b.t0 ?? 0));
  const by = {};
  let warnings = 0, cautions = 0, total = 0, pen = 0;
  for (const e of events) {
    const lvl = GPWS_BY_CODE[e.code].level, d = Math.max(0, Number(e.dur_s) || 0);
    const b = by[e.code] ??= { level: lvl, n: 0, total_s: 0, first_s: null };
    b.n++; b.total_s = round2(b.total_s + d);
    const fs = Number(e.start_s ?? e.t0 ?? 0);
    if (b.first_s == null || fs < b.first_s) b.first_s = round2(fs);
    if (lvl === 'warning') warnings++; else cautions++;
    total += d; pen += penaltyOf({ level: lvl, dur_s: d });
  }
  const score = mode === 'off' ? null : Math.max(0, Math.round(100 - pen));
  return { v: 1, mode, off: [...off], events: events.slice(0, 200).map(e => ({ code: e.code, level: GPWS_BY_CODE[e.code].level, t0: e.t0, start_s: e.start_s ?? null, dur_s: e.dur_s })),
    by_code: by, warnings, cautions, total_s: round2(total), score, grade: gradeOf(score) };
}

// ---------- metinler (HEPGO: Türkçe metin anahtar · SIMUMAV: `gpws.*` anahtarı) ----------
export const GPWS_TEXTS = [
  ['gpws.title', 'Uçuş uyarıları'], ['gpws.mode_off', 'Kapalı'], ['gpws.mode_visual', 'Yalnız görsel'], ['gpws.mode_full', 'Görsel + ses'],
  ['gpws.lang', 'Uyarı dili'], ['gpws.lang_aviation', 'Havacılık (İngilizce)'], ['gpws.lang_ui', 'Arayüz dili'],
  ['gpws.sens', 'Hassasiyet'], ['gpws.sens_low', 'Düşük'], ['gpws.sens_normal', 'Normal'], ['gpws.sens_high', 'Yüksek'],
  ['gpws.bank', 'Yatış açısı eşiği'], ['gpws.bank_copter', 'Kopter yatış eşiği'], ['gpws.bank_plane', 'Uçak yatış eşiği'],
  ['gpws.types', 'Uyarı türleri'], ['gpws.warnings', 'Kırmızı uyarılar (WARNING)'], ['gpws.cautions', 'Sarı uyarılar (CAUTION)'],
  ['gpws.settings', 'Ayrıntılar…'], ['gpws.close', 'Kapat'], ['gpws.test', 'Dene'],
  ['gpws.desc', 'Gerçek uçaklardaki GPWS / master caution gibi: arazi yaklaşması, stall, yatış, aşırı hız, IMU/jiroskop arızası, batarya, GPS… Kırmızı WARNING kesik tonla ve sesli, sarı CAUTION çift çanla uyarır. MASTER düğmesi (B) sesi susturur; koşul sürdükçe görsel kalır.'],
  ['gpws.master_warning', 'MASTER WARNING'], ['gpws.master_caution', 'MASTER CAUTION'], ['gpws.ack_hint', 'Onayla (B): sesi sustur'],
  ['gpws.ev', '{lvl} · {txt}'], ['gpws.ev_end', '{txt} bitti · {d} sn'],
  ['gpws.report', 'Uçuş uyarıları'], ['gpws.discipline', 'Uçuş disiplini'], ['gpws.no_alerts', 'Uyarısız uçuş — kusursuz disiplin.'],
  ['gpws.off_note', 'Uçuş uyarıları bu uçuşta kapalıydı; puan hesaplanmadı.'], ['gpws.col_type', 'Uyarı'], ['gpws.col_n', 'Adet'], ['gpws.col_total', 'Toplam süre'],
  ['gpws.col_first', 'İlk görülme'], ['gpws.n_warn', 'Kırmızı'], ['gpws.n_caution', 'Sarı'], ['gpws.total', 'Toplam uyarı süresi'], ['gpws.disabled_n', '{n} uyarı türü kapalıydı'],
  ['gpws.wizard_hint', 'Uçuş sırasında da ses kapsülünün menüsünden değiştirilebilir.'],
  ...GPWS_CODES.map(c => [`gpws.c_${c.code}`, c.tr]),
];
const TXT = Object.fromEntries(GPWS_TEXTS);
const fill = (s, p) => (p ? String(s).replace(/\{(\w+)\}/g, (m, k) => (p[k] != null ? String(p[k]) : m)) : String(s));
/** HEPGO (keyed=false): Türkçe metin anahtar; SIMUMAV (keyed=true): `gpws.*` anahtarı, yoksa Türkçe. */
export const makeGpwsT = (tr, keyed = false) => (k, p) => {
  const tx = TXT[k] ?? k;
  if (!tr) return fill(tx, p);
  if (!keyed) return tr(tx, p);
  const r = tr(k, p);
  return r && r !== k ? r : fill(tx, p);
};
/** Görsel/sesli metin: havacılık dili → İngilizce kalıp; arayüz dili → çeviri. */
export const alertText = (code, lang, T) => { const d = GPWS_BY_CODE[code]; if (!d) return code; return lang === 'ui' && T ? T(`gpws.c_${code}`) : d.av; };
export const alertSpeech = (code, lang, T, uiLang = 'tr') => {   // arayüz dilinde küçük harf (konuşma motoru büyük harfli kelimeyi harf harf okumasın)
  const d = GPWS_BY_CODE[code]; if (!d) return '';
  if (lang !== 'ui' || !T) return d.say;
  const s = T(`gpws.c_${code}`); try { return s.toLocaleLowerCase(uiLang || undefined); } catch { return s.toLowerCase(); }
};
const fmtS = s => `${(Math.max(0, Number(s) || 0)).toFixed(1)}`;
const clockS = s => { const v = Math.max(0, Math.floor(Number(s) || 0)); return `${String(Math.floor(v / 60)).padStart(2, '0')}:${String(v % 60).padStart(2, '0')}`; };
/** Rapor satırları: [{code, text, level, n, total, first}] (önce kırmızı, sonra süreye göre). */
export function alertRows(sum, T, lang = 'aviation') {
  const by = sum?.by_code || {};
  return Object.entries(by).map(([code, b]) => ({ code, level: b.level, text: alertText(code, lang, T), n: b.n, total: `${fmtS(b.total_s)} s`, first: clockS(b.first_s), _t: b.total_s }))
    .sort((a, b) => (a.level === b.level ? b._t - a._t : a.level === 'warning' ? -1 : 1))
    .map(({ _t, ...r }) => r);
}
/** Olay şeridi metni: "WARNING · PULL UP" (sev 'error' | 'warning'). */
export const alertEventText = (code, lang, T) => { const d = GPWS_BY_CODE[code]; return d ? T('gpws.ev', { lvl: d.level === 'warning' ? 'WARNING' : 'CAUTION', txt: alertText(code, lang, T) }) : code; };
export const alertEventSev = code => (GPWS_BY_CODE[code]?.level === 'warning' ? 'error' : 'warning');
