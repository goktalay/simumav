// Uçuş Simülatörü — KARA ARACI (docs/ucus-simulatoru.md §31; HEPGO + SIMUMAV ortak). Saf katman (DOM/three yok; node testi tests/test_flightsim_rover.mjs):
//   • Tip/kip sabitleri: ROVER_TYPE 'rover', ROVER_MODES (ArduRover 4.7 kipleri), ROVER_DRIVES (ackermann | skid), ROVER_LIMITS (SIM_Rover fiziği).
//   • Sanal kumanda eşlemesi: roverRcChannels — RC1 direksiyon, RC3 gaz (1500 = dur; çift yönlü: ileri / geri-fren), RC2/RC4 dokunulmaz (0).
//   • Teker kinematiği: roverKinematics — servo çıkışı (ArduRover SERVO_OUTPUT_RAW: Ackermann SERVO1 direksiyon (26) / SERVO3 gaz (70); skid SERVO1 sol (73) /
//     SERVO3 sağ (74)) varsa ondan, yoksa hız + yön hızından: direksiyon açısı, sol/sağ teker çizgisel hızı, vites (D/R/N), gaz / fren.
//   • Zemine oturma: roverContacts (4 temas noktası, gövde çerçevesi), roverGroundFit (yükseklik + eğim + yatış; flightsim_launch.surfaceFit ile aynı işaretler),
//     createSuspension (köşe başına yay-sönüm: yükseklik sıçramaları ve karo LOD değişimleri yumuşar; teker başına sıkışma).
//   • Gösterge modeli: roverDash (hız km/h, yön, gaz/fren, vites, eğim/yatış °, direksiyon °) — rover HUD/OSD (flightsim_hud.js / flightsim_fpv_osd.js) ve panel.
// three.js çerçevesi (flightsim3d gövdesi): burun +Y, sağ +X, üst +Z. GLB çerçevesi (tools/rover_models_build.py): burun +X, yukarı +Y, sağ +Z.

export const ROVER_TYPE = 'rover';
export const isRover = t => String(t?.type ?? t ?? '') === ROVER_TYPE;
// ArduRover 4.7 kipleri (Rover/mode.h; numaralar pymavlink mode_mapping_rover ile aynı ad listesi). Alt bant mod seçicisinin sırası.
export const ROVER_MODES = ['MANUAL', 'ACRO', 'STEERING', 'HOLD', 'LOITER', 'FOLLOW', 'SIMPLE', 'AUTO', 'RTL', 'SMART_RTL', 'GUIDED'];
export const ROVER_DRIVES = ['ackermann', 'skid'];
// SIM_Rover (libraries/SITL/SIM_Rover.h): Ackermann azami 20 m/s, teker 35°, dönüş çapı 1,8 m; skid azami 4 m/s, 140°/sn
export const ROVER_LIMITS = { ackermann: { vmax: 20, steerDeg: 35, turnD: 1.8, accel: 10 }, skid: { vmax: 4, turnRateDeg: 140, accel: 14 } };
export const ROVER_SERVO_FN = { steering: 26, throttle: 70, thrLeft: 73, thrRight: 74 };
const DEG = Math.PI / 180;
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const num = (v, d = 0) => (v == null || v === '' || Number.isNaN(Number(v)) ? d : Number(v));
const unit = pwm => (pwm == null || !(Number(pwm) > 0) ? null : clamp((Number(pwm) - 1500) / 500, -1, 1));
export const normDrive = d => (d === 'skid' ? 'skid' : 'ackermann');

// ---------- sanal kumanda ----------
/** Eksenler −1…1 → 8 kanal: [RC1 direksiyon, 0, RC3 gaz, 0, ch5, 0, 0, 0] (0 = o kanala dokunma; ArduRover RC2/RC4 kullanmaz). */
export function roverRcChannels({ steer = 0, thr = 0, ch5 = 1500 } = {}) {
  const pwm = v => Math.round(clamp(1500 + num(v) * 500, 1000, 2000));
  return [pwm(steer), 0, pwm(thr), 0, Math.round(clamp(num(ch5, 1500), 1000, 2000)), 0, 0, 0];
}
/** Sanal kumanda yardım satırı / çubuk etiketleri (HEPGO tr anahtarı Türkçe metin; SIMUMAV `rover.*` anahtarları). */
export const ROVER_RC_TEXT = { hint: 'W/S gaz · A/D direksiyon · ↑↓ gaz · ←→ direksiyon · Boşluk dur · Q/E mod kanalı', left: 'Gaz / Fren', right: 'Direksiyon' };

// ---------- teker kinematiği ----------
/** Servo çıkışı + kinematik → { steer (rad; sağ +), vL, vR (m/s teker çizgisel hızı), gear 'D'|'R'|'N', throttle (0…1 ileri), brake (0…1),
 *  src: 'servo' | 'kin' }. t: telemetri karesi (servo, servo_fn, groundspeed, vn/ve, yaw/heading, ys); opts: { drive, wheelbase, track, speed (m/s, işaretli; verilmezse
 *  yer hızı + yön farkından), yawRate (rad/s; verilmezse t.ys) }. */
export function roverKinematics(t, { drive = 'ackermann', wheelbase = 1.3, track = 1.0, speed = null, yawRate = null } = {}) {
  drive = normDrive(drive);
  const L = Math.max(0.2, num(wheelbase, 1.3)), W = Math.max(0.2, num(track, 1.0));
  const servo = Array.isArray(t?.servo) ? t.servo : null, fn = Array.isArray(t?.servo_fn) ? t.servo_fn : null;
  const chFn = code => { if (!fn) return -1; return fn.findIndex(f => Number(f) === code); };
  let v = speed;
  if (v == null) {   // işaretli hız: yer hızı vektörünün burun yönüne izdüşümü (geri vites eksi)
    const vn = num(t?.vn, 0), ve = num(t?.ve, 0), hs = Math.hypot(vn, ve);
    const yaw = t?.yaw != null ? num(t.yaw) : num(t?.heading) * DEG;
    v = hs > 0.05 ? (vn * Math.cos(yaw) + ve * Math.sin(yaw)) : 0;
    if (!(hs > 0.05) && t?.groundspeed != null) v = num(t.groundspeed, 0) < 0.05 ? 0 : num(t.groundspeed);
  }
  v = num(v, 0);
  const w = yawRate != null ? num(yawRate) : num(t?.ys, 0);
  let steer = 0, vL = v + w * W / 2, vR = v - w * W / 2, thr = null, src = 'kin';
  if (drive === 'skid') {
    // ArduRover skid: SERVO1 sol / SERVO3 sağ (fn 73/74; yoksa varsayılan kanal 1/3)
    const iL = chFn(ROVER_SERVO_FN.thrLeft), iR = chFn(ROVER_SERVO_FN.thrRight);
    const uL = unit(servo?.[iL >= 0 ? iL : 0]), uR = unit(servo?.[iR >= 0 ? iR : 2]);
    if (uL != null && uR != null && t?.armed !== false) { thr = (uL + uR) / 2; src = 'servo'; }
  } else {
    const iS = chFn(ROVER_SERVO_FN.steering), iT = chFn(ROVER_SERVO_FN.throttle);
    const uS = unit(servo?.[iS >= 0 ? iS : 0]), uT = unit(servo?.[iT >= 0 ? iT : 2]);
    if (uS != null) { steer = uS * ROVER_LIMITS.ackermann.steerDeg * DEG; src = 'servo'; }
    else if (Math.abs(v) > 0.3) steer = clamp(Math.atan(L * w / v), -1, 1) * 1;   // bisiklet modeli: δ = atan(L·ω / v)
    if (uT != null) thr = uT;
    vL = v; vR = v;   // Ackermann tekerleri aynı hızda (görsel; diferansiyel fark ihmal)
  }
  steer = clamp(steer, -ROVER_LIMITS.ackermann.steerDeg * DEG, ROVER_LIMITS.ackermann.steerDeg * DEG);
  if (thr == null) thr = clamp(num(t?.throttle, 0) / 100, 0, 1) * Math.sign(v || 1);
  // vites ve fren: gaz hız yönünün tersine ise (ya da sıfırken hız varsa) fren; hız < 0,15 m/s → N (gaz yoksa)
  const gear = v < -0.15 ? 'R' : v > 0.15 ? 'D' : (thr > 0.05 ? 'D' : thr < -0.05 ? 'R' : 'N');
  const brake = (v > 0.15 && thr < -0.02) || (v < -0.15 && thr > 0.02) ? clamp(Math.abs(thr), 0, 1) : 0;
  return { steer, vL, vR, v, gear, throttle: brake ? 0 : clamp(Math.abs(thr), 0, 1), brake, src };
}

// ---------- zemine oturma ----------
/** Gövde çerçevesinde (x sağ, y ileri) 4 temas noktası: [sol-arka, sağ-arka, sol-ön, sağ-ön] (flightsim_launch.surfaceFit sırası). */
export function roverContacts(wheelbase, track) {
  const L = num(wheelbase, 1.3) / 2, W = num(track, 1.0) / 2;
  return [[-W, -L], [W, -L], [-W, L], [W, L]];
}
/** Gövde çerçevesi noktası → dünya (x doğu, y kuzey): yaw = burun azimutu (rad, kuzeyden saat yönü). */
export function contactWorld(px, py, x, y, yaw) {
  const s = Math.sin(yaw), c = Math.cos(yaw);   // burun = (sin yaw, cos yaw); sağ = (cos yaw, −sin yaw)
  return [px + x * c + y * s, py - x * s + y * c];
}
/** 4 yükseklik → { z (ortalama), pitch (ileri yükseliyorsa +, rad), roll (sağ yükseliyorsa −, rad) }; ±limDeg kırpma. */
export function roverGroundFit(hs, wheelbase, track, limDeg = 35) {
  const lim = limDeg * DEG, L = Math.max(0.1, num(wheelbase, 1.3)), W = Math.max(0.1, num(track, 1.0));
  const z = (hs[0] + hs[1] + hs[2] + hs[3]) / 4;
  const p = Math.atan2((hs[2] + hs[3] - hs[0] - hs[1]) / 2, L);
  const r = -Math.atan2((hs[1] + hs[3] - hs[0] - hs[2]) / 2, W);
  return { z, pitch: clamp(p, -lim, lim), roll: clamp(r, -lim, lim) };
}
/** Köşe başına yay-sönüm (kritik sönüme yakın): step(hedef[4], dt) → yumuşatılmış [4]. snap(h) anında oturtur. Büyük sıçrama (> jump m; ör. reset,
 *  ışınlanma) doğrudan oturur. comp(i): o köşenin hedefe göre sıkışması (m; + = teker gövdeye göre yukarı itildi) — teker düğümü görsel ofseti. */
export function createSuspension({ freq = 3.2, damping = 0.85, jump = 4 } = {}) {
  const w = 2 * Math.PI * freq;
  const st = { h: null, v: [0, 0, 0, 0], tgt: [0, 0, 0, 0] };
  const snap = hs => { st.h = hs.slice(); st.v = [0, 0, 0, 0]; st.tgt = hs.slice(); return st.h.slice(); };
  return {
    snap,
    step(hs, dt) {
      if (!st.h || hs.some((v, i) => Math.abs(v - st.h[i]) > jump)) return snap(hs);
      st.tgt = hs.slice();
      let left = clamp(num(dt, 0), 0, 0.25);
      while (left > 1e-6) {
        const h = Math.min(left, 1 / 120); left -= h;
        for (let i = 0; i < 4; i++) {
          const a = -w * w * (st.h[i] - hs[i]) - 2 * damping * w * st.v[i];
          st.v[i] += a * h; st.h[i] += st.v[i] * h;
        }
      }
      return st.h.slice();
    },
    comp: i => (st.h ? st.tgt[i] - st.h[i] : 0),
    get heights() { return st.h ? st.h.slice() : null; },
  };
}

// ---------- gösterge modeli ----------
/** Rover göstergesi: { kmh (işaretsiz), signedKmh, hdg (0…360), pitchDeg (eğim; burun yukarı +), rollDeg, gradePct (eğim %), thrPct, brakePct, gear,
 *  steerDeg (sağ +), mode, armed, maxKmh }. pose: 3B'nin çizdiği {pitch, roll} (zemine oturmuş gövde; rad) — yoksa telemetri. */
export function roverDash(t, { pose = null, drive = 'ackermann', kin = null } = {}) {
  if (!t) return null;
  const k = kin || roverKinematics(t, { drive });
  const pitch = pose?.pitch != null ? num(pose.pitch) : num(t.pitch, 0), roll = pose?.roll != null ? num(pose.roll) : num(t.roll, 0);
  const hdg = ((num(t.heading, num(t.yaw, 0) / DEG) % 360) + 360) % 360;
  const kmh = Math.abs(num(t.groundspeed, Math.abs(k.v))) * 3.6;
  return {
    kmh, signedKmh: k.gear === 'R' ? -kmh : kmh, hdg, pitchDeg: pitch / DEG, rollDeg: roll / DEG, gradePct: Math.tan(pitch) * 100,
    thrPct: Math.round(k.throttle * 100), brakePct: Math.round(k.brake * 100), gear: t.armed ? k.gear : 'P', steerDeg: k.steer / DEG,
    mode: t.mode || '—', armed: !!t.armed, maxKmh: ROVER_LIMITS[normDrive(drive)].vmax * 3.6,
  };
}
/** Pusula harfi (8 yön). */
export const compass8 = hdg => ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][Math.round((((num(hdg) % 360) + 360) % 360) / 45) % 8];

// ---------- metinler (HEPGO: Türkçe metin tr() anahtarı · SIMUMAV: keyed `rover.*`) ----------
export const ROVER_TEXTS = [
  ['rover.speed', 'HIZ'], ['rover.hdg', 'YÖN'], ['rover.grade', 'EĞİM'], ['rover.roll', 'YATIŞ'], ['rover.thr', 'GAZ'], ['rover.brake', 'FREN'],
  ['rover.gear', 'VİTES'], ['rover.steer', 'DİREKSİYON'], ['rover.home', 'EV'], ['rover.mode', 'KİP'], ['rover.safe', 'EMNİYETTE'], ['rover.armed', 'HAZIR'],
  ['rover.tilt', 'DEVRİLME RİSKİ'], ['rover.batt', 'BATARYA'], ['rover.fuel', 'YAKIT'], ['rover.hint', 'H: gösterge aç/kapa'],
];
const RTXT = Object.fromEntries(ROVER_TEXTS);
// keyed: true → yalnız `rover.*` anahtarı (yoksa Türkçe) · false → Türkçe metin tr() anahtarı (HEPGO) · 'auto' (varsayılan) → önce anahtar, karşılığı yoksa Türkçe metin
export const makeRoverT = (tr, keyed = 'auto') => (k, p) => {
  const tx = RTXT[k] ?? k;
  if (!tr) return tx;
  if (keyed === false) return tr(tx, p);
  const r = tr(k, p);
  if (r && r !== k) return r;
  return keyed === true ? tx : tr(tx, p);
};
