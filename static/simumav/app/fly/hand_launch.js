// SIMUMAV › Uç — ELDEN ATIŞ (launch:'hand'). HEPGO flightsim_launch.js'e DOKUNULMAZ; bu modül onun yanında çalışır.
// 1) Saf katman (node testi): HAND parametreleri, aşama zaman çizelgesi (handPoseAt), telemetri kaydırması (shimTelemetry), kayıttan oynatma
//    (replayHandTimeline → replayHandPhaseAt). 2) 3B katman: pilot figürü (kapsül gövde + baş + kol pivotları) ayrı saydam tuvalde
//    (createHandOverlay) — flightsim3d.js sahnesini dışa vermez; kamera `sim.cameraPose()` + FOV ile her karede eşlenir.
// Fizik karşılığı (sözleşme §3 flights.launch 'hand'): SITL'de ARM+TAKEOFF, başlangıç irtifası 1,8 m, itiş = mancınık düşük hız (çekirdek ajanı);
// burada yalnız GÖRSEL: uçak kalkıştan önce omuz hizasında (shimTelemetry: alt_rel += shoulder_m, burun yukarı pitch_deg), bırakmada ofset
// `settle_s` içinde SITL konumuna erir. Bırakma hızı 6–8 m/s, 10–15° burun yukarı, hafif yalpa (roll_deg) — sihirbazdan hand_speed_ms / hand_pitch_deg.
// Aşamalar: idle (figür uçağı tutar) → armed (motor çalışır, tutuş sürer) → launch (kol geri `back_s`, ileri `swing_s`; sonunda bırakma) →
// released (ofset erir, kol iner) → free. Kayıttan oynatma: ARM → 'armed'; ilk hareket (gs > 2 ya da tırmanış > 0,5 m) → 'launch';
// gs ≥ REPLAY_HAND_RELEASE (5 m/s) ya da tırmanış > 1 m → 'released'; DISARM'da hareketsiz segment → 'idle'. (ops ajanı replay'de `hand` dalında kullanır.)
const DEG = Math.PI / 180;
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const num = (v, d = 0) => (v == null || Number.isNaN(Number(v)) ? d : Number(v));
const ease = x => { x = clamp(x, 0, 1); return x * x * (3 - 2 * x); };

export const HAND = {
  shoulder_m: 1.6,       // uçağın tutulduğu yükseklik (m, yer üstü)
  start_alt_m: 1.8,      // SITL başlangıç irtifası (sunucu; bilgi)
  speed_ms: 7, speed_min: 6, speed_max: 8,       // bırakma hızı
  pitch_deg: 12, pitch_min: 10, pitch_max: 15,   // burun yukarı
  roll_deg: 3,           // hafif yalpa (bırakmada sağa)
  countdown_s: 3,        // geri sayım (sihirbaz BAŞLA'dan bağımsız; kalkış komutunda)
  back_s: 0.25,          // kol geri alma
  swing_s: 0.45,         // kol ileri (bırakma anı = back_s + swing_s)
  settle_s: 1.2,         // bırakma sonrası görsel ofsetin SITL'e erimesi
  hand_fwd_m: 0.55,      // uçağın pilota göre ileri ofseti (el)
  pilot_back_m: 0.6,     // pilotun SITL yer noktasının gerisinde durduğu mesafe
};
export const REPLAY_HAND_RELEASE = 5, REPLAY_HAND_MOVE = 2, REPLAY_HAND_CLIMB = 1.0, REPLAY_HAND_MOVE_CLIMB = 0.5;
export const HAND_PHASES = ['idle', 'armed', 'launch', 'released', 'free'];
export const handCfg = (l = {}) => ({ ...HAND, speed_ms: clamp(num(l.hand_speed_ms, HAND.speed_ms), HAND.speed_min, HAND.speed_max), pitch_deg: clamp(num(l.hand_pitch_deg, HAND.pitch_deg), HAND.pitch_min, HAND.pitch_max) });
export const handHud = cfg => `LAUNCH HAND · ${Number(cfg?.speed_ms ?? HAND.speed_ms).toFixed(0)} m/s · ${Math.round(cfg?.pitch_deg ?? HAND.pitch_deg)}°`;

// ---------- aşama → poz ----------
// handPoseAt(phase, tPhase, cfg) → { hold (1 uçak elde, 0 serbest), blend (0 görsel ofset tam, 1 SITL), arm (kol açısı rad; 0 aşağı, + ileri/yukarı),
//   dx (uçağın ileri ofseti m), dz (yükseklik ofseti m), pitch_deg, roll_deg, released (bool) }
export function handPoseAt(phase, tPhase = 0, cfg = HAND) {
  const t = Math.max(0, num(tPhase));
  const base = { hold: 1, blend: 0, arm: 70 * DEG, dx: cfg.hand_fwd_m, dz: cfg.shoulder_m, pitch_deg: cfg.pitch_deg, roll_deg: 0, released: false, phase };
  if (phase === 'idle' || phase == null) return { ...base, arm: 62 * DEG, pitch_deg: cfg.pitch_deg * 0.6 };
  if (phase === 'armed') return { ...base, arm: 70 * DEG + Math.sin(t * 2.2) * 1.5 * DEG, dz: cfg.shoulder_m + Math.sin(t * 2.2) * 0.02 };   // hafif nefes/titreşim
  if (phase === 'launch') {
    if (t < cfg.back_s) { const u = ease(t / cfg.back_s); return { ...base, arm: (70 - 45 * u) * DEG, dx: cfg.hand_fwd_m - 0.35 * u, dz: cfg.shoulder_m - 0.08 * u, pitch_deg: cfg.pitch_deg * (0.6 + 0.4 * u) }; }
    const u = ease((t - cfg.back_s) / cfg.swing_s);
    if (u < 1) return { ...base, arm: (25 + 115 * u) * DEG, dx: cfg.hand_fwd_m - 0.35 + 0.95 * u, dz: cfg.shoulder_m - 0.08 + 0.22 * u, pitch_deg: cfg.pitch_deg, roll_deg: cfg.roll_deg * u };
    return handPoseAt('released', t - cfg.back_s - cfg.swing_s, cfg);   // kol ileride: bırakıldı
  }
  if (phase === 'released' || phase === 'free') {
    const b = phase === 'free' ? 1 : ease(t / cfg.settle_s);
    return { ...base, hold: 0, blend: b, arm: (140 - 140 * ease(t / (cfg.settle_s * 1.6))) * DEG, dx: (cfg.hand_fwd_m + 0.6) * (1 - b), dz: cfg.shoulder_m * (1 - b), pitch_deg: cfg.pitch_deg * (1 - b), roll_deg: cfg.roll_deg * (1 - b), released: true };
  }
  return base;
}
export const handReleaseTime = (cfg = HAND) => cfg.back_s + cfg.swing_s;   // 'launch' başından bırakmaya (sn)

// ---------- telemetri kaydırması ----------
// shimTelemetry(t, pose, headingDeg) → yeni tele: alt_rel/alt_msl += dz, konum heading boyunca dx ileri, pitch/roll hedefe karışır (blend); gs/vn/ve/vd elde iken 0.
export function shimTelemetry(t, pose, headingDeg = 0) {
  if (!t || !pose || (pose.blend >= 1 && !pose.hold)) return t;
  const k = 1 - clamp(pose.blend, 0, 1);
  const o = { ...t };
  const hd = num(headingDeg, num(t.heading, 0)) * DEG;
  if (t.lat != null && t.lon != null) {
    const dx = num(pose.dx) * k;
    o.lat = num(t.lat) + dx * Math.cos(hd) / 110574;
    o.lon = num(t.lon) + dx * Math.sin(hd) / (111320 * Math.cos(num(t.lat) * DEG) || 1);
  }
  if (t.alt_rel != null) o.alt_rel = num(t.alt_rel) + num(pose.dz) * k;
  if (t.alt_msl != null) o.alt_msl = num(t.alt_msl) + num(pose.dz) * k;
  o.pitch = num(t.pitch) * (1 - k) + pose.pitch_deg * DEG * k;
  o.roll = num(t.roll) * (1 - k) + pose.roll_deg * DEG * k;
  if (pose.hold) { o.groundspeed = 0; o.vn = 0; o.ve = 0; o.vd = 0; o.climb = 0; }
  o._hand = { phase: pose.phase, blend: pose.blend };
  return o;
}

// ---------- kayıttan oynatma ----------
// frames: önbellek kareleri, FI: alan → dizin (HEPGO replayLaunchTimeline ile aynı sözleşme). Dönüş: [{arm, launch, release, disarm}]
export function replayHandTimeline(frames, FI) {
  const segs = [];
  const col = (f, k) => (FI?.[k] == null ? null : f[FI[k]]);
  let cur = null, prevArmed = false, agl0 = null;
  for (const f of frames || []) {
    const t = col(f, 't') ?? f[0], armed = !!col(f, 'armed'), gs = num(col(f, 'gs')), agl = col(f, 'alt_rel');
    if (armed && !prevArmed) { cur = { arm: t, launch: null, release: null, disarm: null }; agl0 = agl; segs.push(cur); }
    else if (!armed && prevArmed && cur) { cur.disarm = t; cur = null; }
    if (cur && armed) {
      if (agl0 == null) agl0 = agl;
      const climb = agl != null && agl0 != null ? agl - agl0 : 0;
      if (cur.launch == null && (gs > REPLAY_HAND_MOVE || climb > REPLAY_HAND_MOVE_CLIMB)) cur.launch = t;
      if (cur.launch != null && cur.release == null && (gs >= REPLAY_HAND_RELEASE || climb > REPLAY_HAND_CLIMB)) cur.release = t;
    }
    prevArmed = armed;
  }
  return segs;
}
// replayHandPhaseAt(segs, t) → 'idle' | 'armed' | 'launch' | 'released' (HEPGO replayLaunchPhaseAt ile aynı kurallar; `segs` replayHandTimeline çıktısı).
// Oynatıcı bunu ops ajanının replay zaman çizelgesinde `hand` dalında çağırır; görsel için handPoseAt(phase, t - aşama başı).
export function replayHandPhaseAt(segs, t) {
  let s = null;
  for (const x of segs || []) { if (x.arm <= t) s = x; else break; }
  if (!s) return 'idle';
  if (s.disarm != null && t >= s.disarm) return s.release != null ? 'released' : 'idle';
  if (s.release != null && t >= s.release) return 'released';
  if (s.launch != null && t >= s.launch) return 'launch';
  return 'armed';
}
// Aşama başlangıç zamanı (poz hesabı için): replayHandPhaseStart(segs, t) → aşamanın başladığı log saniyesi (yoksa t)
export function replayHandPhaseStart(segs, t) {
  let s = null;
  for (const x of segs || []) { if (x.arm <= t) s = x; else break; }
  if (!s) return t;
  if (s.release != null && t >= s.release) return s.release;
  if (s.launch != null && t >= s.launch) return s.launch;
  return s.arm;
}

// ---------- 3B: pilot figürü ----------
// createHandFigure(T, { scale }) → { group, setPose(pose), setHeading(deg), dispose() } — yerel çerçeve: +Y ileri (fırlatma), +Z yukarı.
export function createHandFigure(T, { scale = 1, color = 0x2d6cdf } = {}) {
  const g = new T.Group();
  const skin = new T.MeshStandardMaterial({ color: 0xd9a784, roughness: 0.8 });
  const suit = new T.MeshStandardMaterial({ color, roughness: 0.7 });
  const dark = new T.MeshStandardMaterial({ color: 0x1f2937, roughness: 0.9 });
  const vest = new T.MeshStandardMaterial({ color: 0xf59e0b, roughness: 0.6 });
  const mk = (geo, mat, x, y, z) => { const m = new T.Mesh(geo, mat); m.position.set(x, y, z); m.castShadow = true; g.add(m); return m; };
  // bacaklar (0 → 0.85), gövde kapsülü (0.85 → 1.45), baş (1.55), şapka
  for (const s of [-1, 1]) mk(new T.CapsuleGeometry(0.075, 0.7, 4, 10), dark, s * 0.11, 0, 0.45);
  const torso = mk(new T.CapsuleGeometry(0.17, 0.42, 6, 14), suit, 0, 0, 1.12);
  mk(new T.BoxGeometry(0.34, 0.2, 0.36), vest, 0, 0.02, 1.15);   // yelek
  mk(new T.SphereGeometry(0.12, 16, 12), skin, 0, 0, 1.58);
  const cap = mk(new T.CylinderGeometry(0.13, 0.13, 0.08, 16).rotateX(Math.PI / 2), dark, 0, 0, 1.66); cap.rotation.x = Math.PI / 2;
  mk(new T.BoxGeometry(0.22, 0.14, 0.02), dark, 0, 0.16, 1.63);   // siper
  // kollar: omuz pivotu; sağ kol uçağı tutar (rotation.x: 0 aşağı sarkık, + ileri/yukarı), sol kol destek
  const arm = side => {
    const piv = new T.Group(); piv.position.set(side * 0.24, 0, 1.4); g.add(piv);
    const up = new T.Mesh(new T.CapsuleGeometry(0.055, 0.3, 4, 10), suit); up.position.set(0, 0, -0.17); up.castShadow = true; piv.add(up);
    const hand = new T.Mesh(new T.SphereGeometry(0.06, 10, 8), skin); hand.position.set(0, 0, -0.36); piv.add(hand);
    return piv;
  };
  const armR = arm(1), armL = arm(-1);
  torso.userData.kind = 'torso';
  g.scale.setScalar(scale);
  let heading = 0;
  const setHeading = deg => { heading = num(deg); g.rotation.z = -heading * DEG; };
  const setPose = pose => {
    const a = clamp(num(pose?.arm, 70 * DEG), 0, Math.PI);   // 0: aşağı, π/2: ileri yatay, >: yukarı
    armR.rotation.x = a; armL.rotation.x = pose?.hold ? a * 0.85 : a * 0.5;
    const lean = pose?.phase === 'launch' ? 6 * DEG * clamp(pose.arm / (Math.PI * 0.8), 0, 1) : 0;   // atışta hafif öne eğilme
    g.rotation.x = lean;
  };
  setPose(handPoseAt('idle'));
  return { group: g, setPose, setHeading, get heading() { return heading; }, dispose() { g.traverse(o => { o.geometry?.dispose?.(); const ms = Array.isArray(o.material) ? o.material : (o.material ? [o.material] : []); ms.forEach(m => m.dispose?.()); }); g.removeFromParent(); } };
}

// ---------- 3B: pilot figürü paylaşılan kaplamada (./overlay3d.js) ----------
// createHandOverlay(overlay, sim, T, { cfg, headingDeg, scale }) → { setPhase(p), anchorAt(x, y), pose(), lastPose, phase, order, anchored, dispose() }
// Figür SITL yer noktasının `pilot_back_m` gerisinde, pist yönüne döndürülmüş; her karede (overlay.onTick) poz güncellenir. Ölçek flightsim3d MODEL_SCALE (2,5).
export function createHandOverlay(overlay, sim, T, opts = {}) {
  const cfg = opts.cfg || HAND;
  const scale = num(opts.scale, 2.5);
  const fig = createHandFigure(T, { scale });
  fig.setHeading(num(opts.headingDeg, 0));
  fig.group.visible = false;
  overlay.add(fig.group);
  let phase = 'idle', t0 = performance.now(), anchored = false, disposed = false, lastPose = handPoseAt('idle', 0, cfg);
  const anchorAt = (x, y) => {
    const hd = fig.heading * DEG, bx = x - Math.sin(hd) * cfg.pilot_back_m * scale, by = y - Math.cos(hd) * cfg.pilot_back_m * scale;
    const z = sim?.terrainHeight ? num(sim.terrainHeight(bx, by), 0) : 0;
    fig.group.position.set(bx, by, z); anchored = true; fig.group.visible = true;
  };
  const PH = { idle: 0, armed: 1, launch: 2, released: 3, free: 4 };
  const setPhase = p => { const np = HAND_PHASES.includes(p) ? p : 'idle'; if (np === phase) return; phase = np; t0 = performance.now(); };
  const pose = () => handPoseAt(phase, (performance.now() - t0) / 1000, cfg);
  const offTick = overlay.onTick(() => {
    if (disposed) return;
    lastPose = pose();
    if (phase === 'released' && (performance.now() - t0) / 1000 > cfg.settle_s * 1.7) { phase = 'free'; t0 = performance.now(); }
    fig.setPose(lastPose);
  });
  return {
    setPhase, anchorAt, pose, setHeading: d => fig.setHeading(d), figure: fig,
    get phase() { return phase; }, get lastPose() { return lastPose; }, get anchored() { return anchored; }, get order() { return PH[phase] ?? 0; },
    dispose() { disposed = true; offTick(); fig.dispose(); },
  };
}
