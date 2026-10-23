// Uçuş Simülatörü §33 — karşılaşma 3B katmanı: numaralı halkalar (sıradaki yeşil ve nabızlı, geçilenler soluk, sonrakiler turuncu) ve diğer
// oyuncular (renkli gövde + isim etiketi; pos çerçeveleri 10 Hz → ~150 ms gecikmeyle ara değer). Çarpışma YOK (yalnız görsel).
// flightsim3d.js nesnesinin `three`, `scene`, `toLocal`, `homeAlt`, `addFrameHook` alanlarını kullanır (HEPGO + SIMUMAV ortak).
import { lerpPose, playerLocal, ringLocal } from './flightsim_match.js';

const DELAY_MS = 150;

export function createMatchLayer(sim, { me = null } = {}) {
  const T = sim.three;
  const g = new T.Group(); g.name = 'match';
  sim.scene.add(g);
  const homeAlt = () => sim.homeAlt ?? 0;
  const disposables = [];
  const keep = o => { disposables.push(o); return o; };

  // ---- etiket dokusu (tuval) ----
  function labelSprite(text, { bg = 'rgba(11,18,32,.82)', fg = '#fff', border = null, w = 320, hgt = 96, font = 'bold 44px system-ui, sans-serif', scale = 0.05 } = {}) {
    const cv = document.createElement('canvas'); cv.width = w; cv.height = hgt;
    const c = cv.getContext('2d');
    c.fillStyle = bg; c.beginPath(); c.roundRect(4, 4, w - 8, hgt - 8, 22); c.fill();
    if (border) { c.lineWidth = 7; c.strokeStyle = border; c.stroke(); }
    c.fillStyle = fg; c.font = font; c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillText(String(text), w / 2, hgt / 2 + 2, w - 24);
    const tex = keep(new T.CanvasTexture(cv)); tex.colorSpace = T.SRGBColorSpace;
    const mat = keep(new T.SpriteMaterial({ map: tex, depthTest: false, transparent: true, sizeAttenuation: false }));
    const spr = new T.Sprite(mat); spr.center.set(0.5, 0); spr.scale.set(scale * w / hgt, scale, 1); spr.renderOrder = 22;
    return spr;
  }

  // ---- halkalar ----
  let rings = [], ringObjs = [], next = 1;
  const COL = { next: 0x22c55e, todo: 0xf59e0b, done: 0x64748b };
  function setRings(list) {
    ringObjs.forEach(o => { g.remove(o.grp); o.grp.traverse(m => { m.geometry?.dispose?.(); if (m.material && !disposables.includes(m.material)) m.material.dispose?.(); }); });
    rings = list || [];
    ringObjs = rings.map(r => {
      const L = ringLocal(r, homeAlt());
      const tube = Math.max(0.25, L.r * 0.07);
      const mat = new T.MeshStandardMaterial({ color: COL.todo, emissive: COL.todo, emissiveIntensity: 0.55, roughness: 0.4, metalness: 0.1, transparent: true, opacity: 0.95 });
      const torus = new T.Mesh(new T.TorusGeometry(L.r, tube, 14, 56), mat);
      torus.quaternion.setFromUnitVectors(new T.Vector3(0, 0, 1), new T.Vector3(L.nx, L.ny, 0).normalize());   // halka ekseni = geçiş yönü
      const grp = new T.Group(); grp.position.set(L.x, L.y, L.z); grp.add(torus);
      const lbl = labelSprite(String(r.i), { w: 140, hgt: 110, font: 'bold 70px system-ui, sans-serif', scale: 0.045, border: '#f59e0b' });
      lbl.position.set(0, 0, L.r + tube + 1.2); grp.add(lbl);
      // yön oku (geçiş yönünü gösteren ince koni; halkanın önünde)
      const arrow = new T.Mesh(new T.ConeGeometry(Math.max(0.4, L.r * 0.12), Math.max(1.2, L.r * 0.35), 12), new T.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.55 }));
      arrow.quaternion.setFromUnitVectors(new T.Vector3(0, 1, 0), new T.Vector3(L.nx, L.ny, 0).normalize());
      arrow.position.set(-L.nx * L.r * 0.6, -L.ny * L.r * 0.6, 0);
      grp.add(arrow);
      g.add(grp);
      return { grp, torus, mat, lbl, arrow, r };
    });
    paintRings();
  }
  function paintRings() {
    ringObjs.forEach(o => {
      const st = o.r.i < next ? 'done' : o.r.i === next ? 'next' : 'todo';
      o.state = st;
      o.mat.color.setHex(COL[st]); o.mat.emissive.setHex(COL[st]);
      o.mat.opacity = st === 'done' ? 0.28 : 0.95;
      o.mat.emissiveIntensity = st === 'next' ? 0.9 : 0.45;
      o.lbl.visible = st !== 'done'; o.arrow.visible = st === 'next';
    });
  }
  const setNext = n => { next = n == null ? rings.length + 1 : Number(n); paintRings(); };

  // ---- diğer oyuncular ----
  const ghosts = new Map();   // id → {grp, frames: [[t, pose]], name, color}
  function makeGhost(p) {
    const col = new T.Color(p.color || '#3b82f6');
    const grp = new T.Group();
    const mat = keep(new T.MeshStandardMaterial({ color: col, emissive: col, emissiveIntensity: 0.35, roughness: 0.5 }));
    const body = new T.Group();
    if (p.plane) {
      body.add(new T.Mesh(keep(new T.BoxGeometry(0.5, 2.6, 0.45)), mat));
      const wing = new T.Mesh(keep(new T.BoxGeometry(4.2, 0.9, 0.08)), mat); wing.position.y = 0.2; body.add(wing);
      const tail = new T.Mesh(keep(new T.BoxGeometry(1.4, 0.45, 0.06)), mat); tail.position.y = -1.2; body.add(tail);
      const fin = new T.Mesh(keep(new T.BoxGeometry(0.06, 0.45, 0.7)), mat); fin.position.set(0, -1.2, 0.35); body.add(fin);
    } else {
      body.add(new T.Mesh(keep(new T.BoxGeometry(0.7, 0.7, 0.28)), mat));
      for (const [sx, sy] of [[1, 1], [-1, 1], [1, -1], [-1, -1]]) {
        const arm = new T.Mesh(keep(new T.BoxGeometry(0.1, 1.1, 0.08)), mat); arm.position.set(sx * 0.38, sy * 0.38, 0); arm.rotation.z = Math.atan2(-sx, sy); body.add(arm);
        const rot = new T.Mesh(keep(new T.CylinderGeometry(0.42, 0.42, 0.03, 18)), keep(new T.MeshBasicMaterial({ color: 0x111827, transparent: true, opacity: 0.55 })));
        rot.rotation.x = Math.PI / 2; rot.position.set(sx * 0.75, sy * 0.75, 0.16); body.add(rot);
      }
    }
    body.scale.setScalar(p.plane ? 1.4 : 1.6);
    grp.add(body);
    const halo = new T.Mesh(keep(new T.SphereGeometry(p.plane ? 4 : 2.2, 16, 12)), keep(new T.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.12, depthWrite: false })));
    grp.add(halo);
    const lbl = labelSprite(p.name || '?', { border: p.color || '#3b82f6', scale: 0.04 }); lbl.position.set(0, 0, p.plane ? 3 : 2.2); grp.add(lbl);
    g.add(grp);
    return { grp, body, frames: [], name: p.name, plane: !!p.plane };
  }
  // players: [{id, name, color, plane}] — kendisi (me) çizilmez
  function setPlayers(players) {
    // bayram 3B süsleri (flightsim_holiday3d) oyuncuların kalkış noktalarına düşmesin (kendisi dahil; start {lat, lon})
    const starts = (players || []).filter(p => p.start && p.start.lat != null && sim.toLocal).map(p => { const l = sim.toLocal(Number(p.start.lat), Number(p.start.lon)); return { x: l.x, y: l.y, r: 12 }; });
    sim.setDecorKeepouts?.('match-starts', starts.length ? starts : null);
    const want = new Set();
    for (const p of players || []) {
      if (p.id === me) continue;
      want.add(p.id);
      if (!ghosts.has(p.id)) ghosts.set(p.id, makeGhost(p));
    }
    for (const [id, gh] of ghosts) if (!want.has(id)) { g.remove(gh.grp); ghosts.delete(id); }
  }
  // pos çerçevesi: {ts, p:[{id, lat, lon, alt_msl, yaw, roll, pitch}]}; recvMs: istemci alım zamanı (performance.now)
  function pushPos(frame, recvMs = performance.now()) {
    for (const p of frame.p || []) {
      const gh = ghosts.get(p.id);
      if (!gh || p.lat == null) continue;
      const l = playerLocal(p, sim.toLocal, homeAlt());
      gh.frames.push([recvMs, { ...l, yaw: Number(p.yaw) || 0, roll: Number(p.roll) || 0, pitch: Number(p.pitch) || 0 }]);
      if (gh.frames.length > 8) gh.frames.shift();
    }
  }
  const e = new T.Euler(0, 0, 0, 'ZXY');
  function tick(nowMs = performance.now()) {
    const t = nowMs - DELAY_MS;
    for (const gh of ghosts.values()) {
      const F = gh.frames;
      if (!F.length) { gh.grp.visible = false; continue; }
      gh.grp.visible = true;
      let pose = F[F.length - 1][1];
      for (let i = F.length - 1; i > 0; i--) {
        if (F[i - 1][0] <= t) { const [ta, a] = F[i - 1], [tb, b] = F[i]; pose = lerpPose(a, b, tb > ta ? (t - ta) / (tb - ta) : 1); break; }
      }
      if (F[0][0] > t) pose = F[0][1];
      gh.grp.position.set(pose.x, pose.y, pose.z);
      e.set(pose.pitch, pose.roll, -pose.yaw, 'ZXY');   // flightsim3d ile aynı: yaw kuzeyden saat yönü → −Z
      gh.body.quaternion.setFromEuler(e);
    }
    const pulse = 0.75 + 0.25 * Math.sin(nowMs / 220);
    for (const o of ringObjs) if (o.state === 'next') { o.mat.emissiveIntensity = 0.6 + 0.5 * pulse; o.torus.scale.setScalar(1 + 0.03 * pulse); }
  }
  const unhook = sim.addFrameHook ? sim.addFrameHook(() => tick()) : null;
  function dispose() {
    unhook?.();
    sim.setDecorKeepouts?.('match-starts', null);
    setRings([]);
    for (const gh of ghosts.values()) g.remove(gh.grp);
    ghosts.clear();
    sim.scene.remove(g);
    disposables.forEach(d => d.dispose?.());
  }
  /** Hayalet aracın sahne konumu (yer pilotunun bakışı, §46) — görünmüyorsa null. */
  const ghostPos = id => { const gh = ghosts.get(id); return gh && gh.grp.visible ? gh.grp.position : null; };
  return { setRings, setNext, setPlayers, pushPos, tick, dispose, ghostPos, get ringCount() { return ringObjs.length; }, get ghostCount() { return ghosts.size; },
    ringInfo: () => ringObjs.map(o => ({ i: o.r.i, state: o.state, x: +o.grp.position.x.toFixed(1), y: +o.grp.position.y.toFixed(1), z: +o.grp.position.z.toFixed(1), inScene: !!o.grp.parent?.parent, opacity: o.mat.opacity })),
    ghostInfo: () => [...ghosts.entries()].map(([id, gh]) => ({ id, visible: gh.grp.visible, x: gh.grp.position.x, y: gh.grp.position.y, z: gh.grp.position.z })) };
}
