// Uçuş Simülatörü — sahnede YER PİLOTU (RC kumandalı tam boy figür; HEPGO + SIMUMAV ortak; docs/ucus-simulatoru.md §46, docs/simumav.md §28).
// flightsim3d.js `opts.pilot = {look, build?}` ile açılır (diğerleri setPilots) (varsayılan KAPALI; SIMUMAV oturumu açar). Figür kurucusu enjekte edilir
// (SIMUMAV: /app/crew/avatar_body.js buildPilotRig — oyuncunun karakteri); verilmezse buradaki basit düşük poli figür (buildSimplePilot).
//
// Kurucu sözleşmesi: build(T, look, {lod}) → {group (Z yukarı, metre, ayak z = 0, yüz −Y), bones: {torso, head, stickL, stickR} (y-yukarı / +z ileri
//   karakter uzayında: rotation.y + = karakterin soluna, head.rotation.x − = yukarı bakış, stick.rotation.x + = çubuk ileri, stick.rotation.z + = sağa),
//   eye (göz yüksekliği m), tris, drawCalls, dispose()}.
// Katman: kişi başına holder (konum + gövde yönü) → sway (ağırlık aktarma) → figür. Her karede: bakış (dron/hayalet hedefi; gövde %35 ±34°, baş kalanı
// ±63°, gövde ±60°'yi aşınca ayaklar yavaşça döner), nefes, çubuklar (RC kanalları / sanal kumanda; Mod 2), yüzey yüksekliği (Google 3B'de 1 Hz).
// Saf yardımcılar (node testi tests/test_flightsim_pilot.mjs): sticksFromRc, placePilot, lookAngles, splitLook, approach, wrapPi, shoulderCam.

export const PILOT_PLACE = { back: 8, side: 3 };          // evden geride (m) + sola kayma (m): dronun 6–10 m gerisi, takip kamerasının görüşünü kapatmaz
export const LOOK_LIMITS = { torsoK: 0.35, torso: 0.6, head: 1.1, turn: 1.05, turnRate: 0.6, pitchMin: -0.35, pitchMax: 1.2, rate: 2.6 };
export const STICK_MAX = 0.42;                              // çubuk sapması (rad)
const TAU = Math.PI * 2;
export const wrapPi = a => { let x = (a + Math.PI) % TAU; if (x < 0) x += TAU; return x - Math.PI; };
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
/** Üstel yaklaşım (kare hızından bağımsız). */
export const approach = (cur, tgt, rate, dt) => cur + (tgt - cur) * (1 - Math.exp(-rate * Math.max(0, dt)));

/**
 * RC kanalları (1000…2000 µs; ArduPilot 1 yatış, 2 yunuslama, 3 gaz, 4 sapma) → çubuklar {thr 0…1, yaw, pitch (+ ileri), roll (+ sağ) −1…1}.
 * rc yoksa gaz telemetri yüzdesinden (0…100), diğerleri 0. Ölü bölge ±2 %.
 */
export function sticksFromRc(rc, throttlePct = 0, armed = true) {
  const ax = v => { const x = clamp((Number(v) - 1500) / 500, -1, 1); return Math.abs(x) < 0.02 ? 0 : x; };
  if (Array.isArray(rc) && rc.length >= 4 && rc.slice(0, 4).every(v => Number(v) >= 800 && Number(v) <= 2200)) {
    return { thr: clamp((Number(rc[2]) - 1000) / 1000, 0, 1), yaw: ax(rc[3]), pitch: 0 - ax(rc[1]) || 0, roll: ax(rc[0]) };
  }
  return { thr: armed ? clamp(Number(throttlePct) / 100 || 0, 0, 1) : 0, yaw: 0, pitch: 0, roll: 0 };
}

/** Ev noktası + kalkış yönü (rad, kuzeyden saat yönü) → pilot konumu (geride + solda) ve yüz yönü (eve dönük). */
export function placePilot(home, yaw, { back = PILOT_PLACE.back, side = PILOT_PLACE.side } = {}) {
  const fx = Math.sin(yaw), fy = Math.cos(yaw), rx = fy, ry = -fx;   // ileri + sağ
  const x = home.x - fx * back - rx * side, y = home.y - fy * back - ry * side;
  return { x, y, yaw: Math.atan2(home.x - x, home.y - y) };
}

/** Pilot (konum + gövde yönü) → hedef: göreli sapma (rad, + sağ), yunuslama (rad, + yukarı), yatay mesafe. */
export function lookAngles(p, target, eye = 1.6) {
  const dx = target.x - p.x, dy = target.y - p.y, dist = Math.hypot(dx, dy);
  if (dist < 1e-3) return { yaw: 0, pitch: 0, dist: 0, heading: p.yaw };
  const heading = Math.atan2(dx, dy);
  return { yaw: wrapPi(heading - p.yaw), pitch: Math.atan2((target.z ?? 0) - ((p.z ?? 0) + eye), dist), dist, heading };
}

/** Göreli bakış → gövde + baş payı (sınırlı). */
export function splitLook(rel, L = LOOK_LIMITS) {
  const torso = clamp(rel * L.torsoK, -L.torso, L.torso);
  return { torso, head: clamp(rel - torso, -L.head, L.head) };
}

/** "Pilot gözü" kamerası: pilotun omzunun üstü (sağ omuz, biraz geride), hedefe bakar. */
export function shoulderCam(p, eye, target, { back = 1.05, right = 0.55, up = 0.18 } = {}) {
  let dx = target.x - p.x, dy = target.y - p.y;
  const n = Math.hypot(dx, dy);
  if (n < 1e-3) { dx = Math.sin(p.yaw); dy = Math.cos(p.yaw); } else { dx /= n; dy /= n; }
  return { x: p.x - dx * back + dy * right, y: p.y - dy * back - dx * right, z: (p.z ?? 0) + eye + up };
}

/** Basit düşük poli pilot (HEPGO; kurucu verilmediğinde): kapsül gövde, küre baş + kask, kollar, RC kumanda — köşe renkli, kemik başına tek mesh. */
export function buildSimplePilot(T, look = {}, { lod = 'mid' } = {}) {
  const seg = lod === 'low' ? 6 : 10;
  const suit = look.suit || '#1e3a5f', skin = look.skinColor || '#e8b58a', helmet = look.helmet || '#f8fafc', dark = '#1f2329';
  const disp = [];
  const mat = new T.MeshStandardMaterial({ vertexColors: true, roughness: 0.7 }); disp.push(mat);
  const col = new T.Color(), m4 = new T.Matrix4(), q = new T.Quaternion(), e = new T.Euler(), v = (x, y, z) => new T.Vector3(x, y, z);
  const bones = {}, parts = {};
  const bone = (nm, parent, pos, rot) => { const g = new T.Group(); g.position.set(...pos); if (rot) g.rotation.set(...rot); (parent ? bones[parent] : null)?.add(g); bones[nm] = g; parts[nm] = []; return g; };
  const add = (bn, geo, c, pos, rot = [0, 0, 0], scl = [1, 1, 1]) => { e.set(...rot); q.setFromEuler(e); m4.compose(v(...pos), q, v(...scl)); const g = geo.toNonIndexed(); geo.dispose(); g.applyMatrix4(m4); col.set(c); const n = g.attributes.position.count, a = new Float32Array(n * 3); for (let i = 0; i < n; i++) a.set([col.r, col.g, col.b], i * 3); g.setAttribute('color', new T.BufferAttribute(a, 3)); g.deleteAttribute('uv'); parts[bn].push(g); };
  bone('root', null, [0, 0, 0]); bone('torso', 'root', [0, 0.95, 0]); bone('head', 'torso', [0, 0.62, 0]); bone('rc', 'torso', [0, 0.18, 0.28], [-0.6, 0, 0]);
  bone('stickL', 'rc', [0.07, 0.03, 0.01]); bone('stickR', 'rc', [-0.07, 0.03, 0.01]);
  for (const sx of [-1, 1]) { add('root', new T.CylinderGeometry(0.075, 0.06, 0.88, seg), suit, [sx * 0.1, 0.5, 0]); add('root', new T.BoxGeometry(0.11, 0.08, 0.24), dark, [sx * 0.1, 0.04, 0.04]); }
  add('torso', new T.CapsuleGeometry(0.19, 0.42, 3, seg), suit, [0, 0.27, 0], [0, 0, 0], [1, 1, 0.7]);
  add('torso', new T.CylinderGeometry(0.055, 0.06, 0.12, seg), skin, [0, 0.58, 0]);
  for (const sx of [-1, 1]) { add('torso', new T.CylinderGeometry(0.05, 0.045, 0.3, seg), suit, [sx * 0.22, 0.36, 0.06], [0.5, 0, sx * 0.25]); add('torso', new T.CylinderGeometry(0.045, 0.04, 0.28, seg), suit, [sx * 0.16, 0.2, 0.2], [1.35, 0, sx * -0.3]); }
  add('head', new T.SphereGeometry(0.12, seg, seg - 2), skin, [0, 0.06, 0]);
  add('head', new T.SphereGeometry(0.14, seg, seg - 2, 0, Math.PI * 2, 0, Math.PI * 0.55), helmet, [0, 0.07, -0.01]);
  add('head', new T.SphereGeometry(0.142, seg, 4, Math.PI / 2 - 0.8, 1.6, Math.PI * 0.42, Math.PI * 0.2), look.visor || '#1a1a1a', [0, 0.07, -0.01]);
  add('rc', new T.BoxGeometry(0.26, 0.045, 0.15), '#26292f', [0, 0, 0]);
  add('rc', new T.CylinderGeometry(0.006, 0.006, 0.12, 4), dark, [0, 0.07, 0.07], [0.4, 0, 0]);
  for (const bn of ['stickL', 'stickR']) { add(bn, new T.CylinderGeometry(0.005, 0.005, 0.045, 4), '#9ca3af', [0, 0.022, 0]); add(bn, new T.SphereGeometry(0.016, 6, 4), skin, [0, 0.05, -0.012]); }
  let tris = 0, dc = 0;
  for (const [bn, list] of Object.entries(parts)) {
    if (!list.length) continue;
    const n = list.reduce((s, g) => s + g.attributes.position.count, 0), P = new Float32Array(n * 3), N = new Float32Array(n * 3), C = new Float32Array(n * 3);
    let o = 0;
    for (const g of list) { P.set(g.attributes.position.array, o * 3); N.set(g.attributes.normal.array, o * 3); C.set(g.attributes.color.array, o * 3); o += g.attributes.position.count; g.dispose(); }
    const geo = new T.BufferGeometry(); geo.setAttribute('position', new T.BufferAttribute(P, 3)); geo.setAttribute('normal', new T.BufferAttribute(N, 3)); geo.setAttribute('color', new T.BufferAttribute(C, 3)); geo.computeBoundingSphere(); disp.push(geo);
    const mesh = new T.Mesh(geo, mat); mesh.userData.heat = bn === 'head' ? 0.82 : 0.68; bones[bn].add(mesh); tris += n / 3; dc++;
  }
  const g = new T.Group(); g.name = 'fs-pilot';
  bones.root.rotation.x = Math.PI / 2; g.add(bones.root);
  return { group: g, bones: { body: bones.root, torso: bones.torso, head: bones.head, stickL: bones.stickL, stickR: bones.stickR }, eye: 1.62, height: 1.75, tris: Math.round(tris), drawCalls: dc,
    dispose: () => disp.forEach(d => d.dispose()) };
}

/**
 * Pilot katmanı. opts: {build?, terrainHeight(x, y), lod 'mid'|'low', shadow bool, defaultYaw (rad; yön verilmeyen kişi için)}.
 * Dönüş: {root, set(id, {look, x, y, yaw?, target?}), remove(id), has(id), update(dt, now, {target, sticks}), pose(id), setQuality({lod, shadow}), info(), dispose()}
 */
export function createPilotLayer(T, scene, opts = {}) {
  const build = opts.build || buildSimplePilot;
  const root = new T.Group(); root.name = 'fs-pilots';
  scene.add(root);
  const q = { lod: opts.lod || 'mid', shadow: opts.shadow !== false };
  const P = new Map();
  const lookKey = l => JSON.stringify(l || {});
  const applyShadow = rig => rig.group.traverse(o => { if (o.isMesh) { o.castShadow = q.shadow; o.receiveShadow = q.shadow; } });
  function mk(id, look) {
    const rig = build(T, look, { lod: q.lod });
    const holder = new T.Group(), sway = new T.Group();
    holder.name = `pilot-${id}`; holder.add(sway); sway.add(rig.group); root.add(holder);
    applyShadow(rig);
    const b = rig.bones || {};
    return { id, rig, holder, sway, look, key: lookKey(look), base: { torsoY: b.torso?.position.y ?? 0 }, x: 0, y: 0, z: 0, yaw: 0, bodyYaw: 0, st: { torso: 0, head: 0, pitch: 0, sl: [0, 0], sr: [0, 0] }, target: null, ph: Math.random() * 10, zAt: -Infinity };
  }
  function set(id, { look = null, x = 0, y = 0, yaw = null, target = null } = {}) {
    let p = P.get(id);
    const k = lookKey(look);
    if (p && p.key !== k) { remove(id); p = null; }
    const yw = yaw ?? opts.defaultYaw ?? 0;
    const fresh = !p;
    if (!p) { p = mk(id, look); P.set(id, p); }
    const moved = fresh || Math.hypot(p.x - x, p.y - y) > 0.5 || Math.abs(wrapPi(p.yaw - yw)) > 0.05;
    p.x = x; p.y = y; p.yaw = yw; p.target = target;
    if (moved) { p.bodyYaw = yw; p.zAt = -Infinity; }   // yeni yer / yeniden demirleme: gövde eve dönük başlar
    return p;
  }
  function remove(id) { const p = P.get(id); if (!p) return; root.remove(p.holder); try { p.rig.dispose?.(); } catch { /* */ } P.delete(id); }
  const tv = { x: 0, y: 0, z: 0 };
  function update(dt, now, { target = null, sticks = null } = {}) {
    const t = now / 1000;
    for (const p of P.values()) {
      if (now - p.zAt > 1000) { p.zAt = now; const h = opts.terrainHeight?.(p.x, p.y); p.z = Number.isFinite(h) ? h : 0; }
      // hedef: kişinin kendi hedefi (karşılaşma hayaleti) → yoksa (me) dron
      let tg = null;
      if (typeof p.target === 'function') tg = p.target(); else if (p.target) tg = p.target;
      if (!tg && p.id === 'me' && target) tg = target;
      const pos = { x: p.x, y: p.y, z: p.z, yaw: p.bodyYaw };
      let la = { yaw: 0, pitch: 0.05 };
      if (tg && Number.isFinite(tg.x)) { tv.x = tg.x; tv.y = tg.y; tv.z = tg.z ?? 0; la = lookAngles(pos, tv, p.rig.eye || 1.6); }
      // gövde yönü: bakış sınırı aşılınca ayaklar yavaşça döner (adım)
      if (Math.abs(la.yaw) > LOOK_LIMITS.turn) { const step = Math.sign(la.yaw) * Math.min(Math.abs(la.yaw) - LOOK_LIMITS.turn * 0.7, LOOK_LIMITS.turnRate * dt); p.bodyYaw = wrapPi(p.bodyYaw + step); la.yaw -= step; }
      const sp = splitLook(la.yaw);
      p.st.torso = approach(p.st.torso, sp.torso, LOOK_LIMITS.rate * 0.7, dt);
      p.st.head = approach(p.st.head, sp.head, LOOK_LIMITS.rate, dt);
      p.st.pitch = approach(p.st.pitch, clamp(la.pitch, LOOK_LIMITS.pitchMin, LOOK_LIMITS.pitchMax), LOOK_LIMITS.rate, dt);
      p.holder.position.set(p.x, p.y, p.z);
      p.holder.rotation.z = Math.PI - p.bodyYaw;
      // boşta: nefes (4 sn) + ağırlık aktarma (7 sn)
      const br = Math.sin((t + p.ph) * TAU / 4), ws = Math.sin((t + p.ph) * TAU / 7);
      p.sway.rotation.y = 0.022 * ws; p.sway.position.x = 0.018 * ws;
      const b = p.rig.bones || {};
      if (b.torso) { b.torso.rotation.y = -p.st.torso; b.torso.rotation.x = -0.12 * Math.max(0, p.st.pitch) + 0.012 * br; b.torso.position.y = p.base.torsoY + 0.006 * br; }
      if (b.head) { b.head.rotation.y = -p.st.head; b.head.rotation.x = -p.st.pitch * 0.85; }
      // çubuklar (Mod 2): sol = gaz (ileri) + sapma, sağ = yunuslama + yatış; yalnız kendi pilotu gerçek girdiyle, diğerleri hafif titrek
      const s = p.id === 'me' && sticks ? sticks : { thr: 0.5 + 0.05 * Math.sin((t + p.ph) * 1.3), yaw: 0.06 * Math.sin((t + p.ph) * 0.9), pitch: 0.08 * Math.sin((t + p.ph) * 0.7), roll: 0.07 * Math.sin((t + p.ph) * 1.1) };
      const tl = [STICK_MAX * (2 * s.thr - 1), STICK_MAX * s.yaw], tr = [STICK_MAX * s.pitch, STICK_MAX * s.roll];
      for (let i = 0; i < 2; i++) { p.st.sl[i] = approach(p.st.sl[i], tl[i], 14, dt); p.st.sr[i] = approach(p.st.sr[i], tr[i], 14, dt); }
      if (b.stickL) { b.stickL.rotation.x = p.st.sl[0]; b.stickL.rotation.z = p.st.sl[1]; }
      if (b.stickR) { b.stickR.rotation.x = p.st.sr[0]; b.stickR.rotation.z = p.st.sr[1]; }
    }
  }
  function setQuality({ lod, shadow } = {}) {
    const relod = lod && lod !== q.lod;
    if (lod) q.lod = lod;
    if (shadow != null) q.shadow = !!shadow;
    for (const [id, p] of [...P]) {
      if (relod) { const keep = { look: p.look, x: p.x, y: p.y, yaw: p.yaw, target: p.target }, by = p.bodyYaw; remove(id); const n = set(id, keep); n.bodyYaw = by; }
      else applyShadow(p.rig);
    }
  }
  const pose = id => { const p = P.get(id); return p ? { x: p.x, y: p.y, z: p.z, yaw: p.bodyYaw, eye: p.rig.eye || 1.6 } : null; };
  const fq = new T.Quaternion(), fv = new T.Vector3();
  const faceHeading = p => { const h = p.rig.bones?.head; if (!h) return null; h.updateWorldMatrix(true, false); h.getWorldQuaternion(fq); fv.set(0, 0, 1).applyQuaternion(fq); return +Math.atan2(fv.x, fv.y).toFixed(3); };   // baş kemiğinin dünya yönü (teşhis)
  const info = () => [...P.values()].map(p => ({ id: p.id, face: faceHeading(p), x: +p.x.toFixed(2), y: +p.y.toFixed(2), z: +p.z.toFixed(2), yaw: +p.bodyYaw.toFixed(3), torso: +p.st.torso.toFixed(3), head: +p.st.head.toFixed(3), pitch: +p.st.pitch.toFixed(3),
    sticks: { l: p.st.sl.map(v => +v.toFixed(3)), r: p.st.sr.map(v => +v.toFixed(3)) }, tris: p.rig.tris ?? null, drawCalls: p.rig.drawCalls ?? null, lod: q.lod, shadow: q.shadow, visible: p.holder.visible }));
  function dispose() { for (const id of [...P.keys()]) remove(id); scene.remove(root); }
  return { root, set, remove, has: id => P.has(id), ids: () => [...P.keys()], update, pose, setQuality, info, dispose };
}
