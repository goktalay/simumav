// Prosedürel dron modelleri (`proc:` şablonları): quad250 (FPV), interceptor, multirotor, plane, heli, vtol.
// buildDrone(THREE, 'quad250', '#38bdf8') → Group; group.userData.spin = [{mesh, axis, speed}] döner parçalar (pervane/rotor).

const mat = (THREE, color, { metal = 0.6, rough = 0.35, emissive = 0, flat = false } = {}) =>
  new THREE.MeshStandardMaterial({ color, metalness: metal, roughness: rough, emissive: emissive ? color : 0x000000, emissiveIntensity: emissive, flatShading: flat });

function prop(THREE, r, color, blades = 2) {
  const g = new THREE.Group();
  const hub = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.12, r * 0.12, r * 0.08, 16), mat(THREE, 0x222222, { metal: 0.8 }));
  g.add(hub);
  for (let i = 0; i < blades; i++) {
    const b = new THREE.Mesh(new THREE.BoxGeometry(r * 2, r * 0.02, r * 0.16), mat(THREE, color, { metal: 0.2, rough: 0.6 }));
    b.rotation.y = (Math.PI * i) / blades; b.rotation.x = 0.25;
    g.add(b);
  }
  // hareket bulanıklığı diski (yarı saydam)
  const disk = new THREE.Mesh(new THREE.CircleGeometry(r, 32), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.14, side: THREE.DoubleSide, depthWrite: false }));
  disk.rotation.x = -Math.PI / 2; g.add(disk);
  return g;
}

function quad(THREE, color, { size = 1, arms = 4, carbon = true, cam = true, legs = false } = {}) {
  const g = new THREE.Group(), spin = [];
  const frameC = carbon ? 0x15171c : 0x3a3f4b;
  // merkez plaka(lar)
  g.add(new THREE.Mesh(new THREE.BoxGeometry(size * 0.46, size * 0.04, size * 0.3), mat(THREE, frameC, { metal: 0.5, rough: 0.45 })));
  const top = new THREE.Mesh(new THREE.BoxGeometry(size * 0.4, size * 0.03, size * 0.24), mat(THREE, frameC, { metal: 0.5, rough: 0.45 })); top.position.y = size * 0.14; g.add(top);
  for (let i = 0; i < 4; i++) {
    const p = new THREE.Mesh(new THREE.CylinderGeometry(size * 0.012, size * 0.012, size * 0.14, 8), mat(THREE, 0x888888)); p.position.set((i < 2 ? 1 : -1) * size * 0.16, size * 0.07, (i % 2 ? 1 : -1) * size * 0.1); g.add(p);
  }
  // batarya + kanopi
  const bat = new THREE.Mesh(new THREE.BoxGeometry(size * 0.3, size * 0.1, size * 0.14), mat(THREE, color, { metal: 0.3, rough: 0.5 })); bat.position.y = size * 0.21; g.add(bat);
  const strap = new THREE.Mesh(new THREE.BoxGeometry(size * 0.06, size * 0.12, size * 0.16), mat(THREE, 0x111111, { metal: 0.1, rough: 0.9 })); strap.position.y = size * 0.21; g.add(strap);
  // kollar + motorlar + pervaneler
  const armLen = size * 0.62;
  for (let i = 0; i < arms; i++) {
    const a = (Math.PI * 2 * i) / arms + Math.PI / arms;
    const arm = new THREE.Mesh(new THREE.BoxGeometry(armLen, size * 0.03, size * 0.07), mat(THREE, frameC, { metal: 0.5, rough: 0.4 }));
    arm.position.set(Math.cos(a) * armLen / 2, 0, Math.sin(a) * armLen / 2); arm.rotation.y = -a; g.add(arm);
    const mx = Math.cos(a) * armLen, mz = Math.sin(a) * armLen;
    const motor = new THREE.Mesh(new THREE.CylinderGeometry(size * 0.07, size * 0.075, size * 0.1, 20), mat(THREE, 0x2b2f3a, { metal: 0.9, rough: 0.3 })); motor.position.set(mx, size * 0.06, mz); g.add(motor);
    const bell = new THREE.Mesh(new THREE.CylinderGeometry(size * 0.055, size * 0.055, size * 0.03, 20), mat(THREE, color, { metal: 0.8, rough: 0.3 })); bell.position.set(mx, size * 0.12, mz); g.add(bell);
    const pr = prop(THREE, size * 0.3, i % 2 ? 0xdddddd : color, 3); pr.position.set(mx, size * 0.14, mz); g.add(pr);
    spin.push({ mesh: pr, axis: 'y', speed: (i % 2 ? -1 : 1) * 40 });
    if (legs) { const leg = new THREE.Mesh(new THREE.CylinderGeometry(size * 0.012, size * 0.012, size * 0.26, 8), mat(THREE, 0x888888)); leg.position.set(mx * 0.8, -size * 0.14, mz * 0.8); g.add(leg); }
  }
  if (cam) {
    const camBox = new THREE.Mesh(new THREE.BoxGeometry(size * 0.1, size * 0.1, size * 0.1), mat(THREE, 0x111111, { metal: 0.3, rough: 0.5 })); camBox.position.set(size * 0.26, size * 0.1, 0); camBox.rotation.z = -0.5; g.add(camBox);
    const lens = new THREE.Mesh(new THREE.CylinderGeometry(size * 0.035, size * 0.035, size * 0.03, 16), mat(THREE, 0x66ccff, { metal: 0.9, rough: 0.1 })); lens.rotation.z = Math.PI / 2 - 0.5; lens.position.set(size * 0.31, size * 0.13, 0); g.add(lens);
    const ant = new THREE.Mesh(new THREE.CylinderGeometry(size * 0.01, size * 0.01, size * 0.3, 8), mat(THREE, color)); ant.position.set(-size * 0.22, size * 0.3, 0); ant.rotation.z = 0.4; g.add(ant);
  }
  g.userData.spin = spin;
  return g;
}

function plane(THREE, color, { span = 2.2, delta = false, jet = false, tail = true, prop: hasProp = true, gear = true } = {}) {
  const g = new THREE.Group(), spin = [];
  const body = jet ? 0x9aa3b5 : 0xf2f2f2;
  // gövde (burun doğu/+X)
  const fus = new THREE.Mesh(new THREE.CapsuleGeometry(0.09, 1.1, 8, 20), mat(THREE, body, { metal: 0.4, rough: 0.35 })); fus.rotation.z = Math.PI / 2; g.add(fus);
  const nose = new THREE.Mesh(new THREE.ConeGeometry(0.09, 0.3, 20), mat(THREE, color, { metal: 0.5, rough: 0.3 })); nose.rotation.z = -Math.PI / 2; nose.position.x = 0.7; g.add(nose);
  if (jet) { const canopy = new THREE.Mesh(new THREE.SphereGeometry(0.1, 20, 12), mat(THREE, 0x1b2a44, { metal: 0.9, rough: 0.05 })); canopy.scale.set(2, 0.8, 1); canopy.position.set(0.25, 0.08, 0); g.add(canopy); }
  // kanat
  const shape = new THREE.Shape();
  if (delta) { shape.moveTo(0.45, 0); shape.lineTo(-0.5, span / 2); shape.lineTo(-0.62, span / 2); shape.lineTo(-0.62, -span / 2); shape.lineTo(-0.5, -span / 2); shape.lineTo(0.45, 0); }
  else { const c = 0.32; shape.moveTo(c / 2, -span / 2); shape.lineTo(c / 2, span / 2); shape.lineTo(-c / 2 - 0.1, span / 2); shape.lineTo(-c / 2, 0); shape.lineTo(-c / 2 - 0.1, -span / 2); shape.lineTo(c / 2, -span / 2); }
  const wing = new THREE.Mesh(new THREE.ExtrudeGeometry(shape, { depth: 0.035, bevelEnabled: false }), mat(THREE, color, { metal: 0.4, rough: 0.35 }));
  wing.rotation.x = Math.PI / 2; wing.position.y = -0.01; g.add(wing);
  // kanat ucu şeritleri
  for (const s of [-1, 1]) { const tip = new THREE.Mesh(new THREE.BoxGeometry(delta ? 0.14 : 0.33, 0.045, 0.08), mat(THREE, 0xffffff, { emissive: 0.6 })); tip.position.set(delta ? -0.56 : 0, 0, s * (span / 2 - 0.04)); g.add(tip); }
  if (tail) {
    if (jet) { for (const s of [-1, 1]) { const fin = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.3, 0.025), mat(THREE, color)); fin.position.set(-0.6, 0.15, s * 0.25); fin.rotation.x = s * 0.5; g.add(fin); } }
    else {
      const hs = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.025, 0.8), mat(THREE, body)); hs.position.set(-0.68, 0.02, 0); g.add(hs);
      const vs = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.32, 0.025), mat(THREE, color)); vs.position.set(-0.7, 0.18, 0); g.add(vs);
    }
  }
  if (jet) { const noz = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.09, 0.2, 20, 1, true), mat(THREE, 0x333333, { metal: 0.9 })); noz.rotation.z = Math.PI / 2; noz.position.x = -0.68; g.add(noz); const flame = new THREE.Mesh(new THREE.ConeGeometry(0.06, 0.4, 16), new THREE.MeshBasicMaterial({ color: 0x66d9ff, transparent: true, opacity: 0.6 })); flame.rotation.z = Math.PI / 2; flame.position.x = -0.95; g.add(flame); g.userData.flame = flame; }
  if (hasProp) { const pr = prop(THREE, 0.32, 0x222222, 2); pr.rotation.z = Math.PI / 2; pr.position.x = 0.86; g.add(pr); spin.push({ mesh: pr, axis: 'y', speed: 45 }); }
  if (gear) for (const [x, z] of [[0.35, -0.25], [0.35, 0.25], [-0.45, 0]]) { const w = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.03, 16), mat(THREE, 0x111111, { rough: 0.9, metal: 0 })); w.rotation.x = Math.PI / 2; w.position.set(x, -0.17, z); g.add(w); const strut = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, 0.12, 8), mat(THREE, 0x888888)); strut.position.set(x, -0.1, z); g.add(strut); }
  g.userData.spin = spin;
  return g;
}

function heli(THREE, color) {
  const g = new THREE.Group(), spin = [];
  const cab = new THREE.Mesh(new THREE.SphereGeometry(0.28, 24, 16), mat(THREE, color, { metal: 0.5, rough: 0.3 })); cab.scale.set(1.5, 0.9, 1); g.add(cab);
  const glass = new THREE.Mesh(new THREE.SphereGeometry(0.2, 24, 16), mat(THREE, 0x1b2a44, { metal: 0.9, rough: 0.05 })); glass.scale.set(1.2, 0.8, 0.9); glass.position.set(0.22, 0.05, 0); g.add(glass);
  const boom = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.08, 1.1, 12), mat(THREE, 0x3a3f4b, { metal: 0.6 })); boom.rotation.z = Math.PI / 2; boom.position.x = -0.85; g.add(boom);
  const fin = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.35, 0.02), mat(THREE, color)); fin.position.set(-1.35, 0.15, 0); g.add(fin);
  const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.25, 12), mat(THREE, 0x888888)); mast.position.y = 0.35; g.add(mast);
  const rotor = prop(THREE, 1.25, 0x222222, 2); rotor.position.y = 0.48; g.add(rotor); spin.push({ mesh: rotor, axis: 'y', speed: 24 });
  const tr = prop(THREE, 0.22, 0x222222, 2); tr.rotation.x = Math.PI / 2; tr.position.set(-1.35, 0.15, 0.05); g.add(tr); spin.push({ mesh: tr, axis: 'y', speed: 70 });
  for (const s of [-1, 1]) { const skid = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 0.9, 8), mat(THREE, 0x888888)); skid.rotation.z = Math.PI / 2; skid.position.set(0, -0.36, s * 0.25); g.add(skid); for (const x of [-0.25, 0.25]) { const st = new THREE.Mesh(new THREE.CylinderGeometry(0.015, 0.015, 0.2, 8), mat(THREE, 0x888888)); st.position.set(x, -0.27, s * 0.25); g.add(st); } }
  g.userData.spin = spin;
  return g;
}

function vtol(THREE, color) {
  const g = plane(THREE, color, { span: 2.3, prop: false, gear: false });
  const spin = g.userData.spin;
  for (const [x, z] of [[0.45, -0.7], [0.45, 0.7], [-0.5, -0.7], [-0.5, 0.7]]) {
    const boomM = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 1.1, 10), mat(THREE, 0x3a3f4b, { metal: 0.6 })); boomM.rotation.z = Math.PI / 2; boomM.position.set(0, 0.02, z); g.add(boomM);
    const motor = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.08, 16), mat(THREE, 0x2b2f3a, { metal: 0.9 })); motor.position.set(x, 0.06, z); g.add(motor);
    const pr = prop(THREE, 0.26, 0xdddddd, 2); pr.position.set(x, 0.12, z); g.add(pr); spin.push({ mesh: pr, axis: 'y', speed: 40 });
  }
  const push = prop(THREE, 0.26, 0x222222, 2); push.rotation.z = Math.PI / 2; push.position.x = -0.9; g.add(push); spin.push({ mesh: push, axis: 'y', speed: 45 });
  return g;
}

export const TEMPLATES = {
  quad250: (T, c) => quad(T, c, { size: 1.1, carbon: true, cam: true }),
  fpv: (T, c) => quad(T, c, { size: 1.1, carbon: true, cam: true }),
  multirotor: (T, c) => quad(T, c, { size: 1.5, carbon: false, cam: false, legs: true }),
  hexa: (T, c) => quad(T, c, { size: 1.5, arms: 6, carbon: false, cam: false, legs: true }),
  plane: (T, c) => plane(T, c, {}),
  interceptor: (T, c) => plane(T, c, { span: 1.6, delta: true, jet: true, prop: false, gear: false }),
  heli: (T, c) => heli(T, c),
  vtol: (T, c) => vtol(T, c),
};
export const TYPE_TEMPLATE = { fpv: 'quad250', multirotor: 'multirotor', plane: 'plane', interceptor: 'interceptor', heli: 'heli', vtol: 'vtol' };

/** model_key 'proc:<şablon>' ya da tür anahtarına göre model üret. */
export function buildDrone(THREE, modelKey, color = '#38bdf8', type = null) {
  let key = String(modelKey || '').startsWith('proc:') ? modelKey.slice(5) : (TYPE_TEMPLATE[type] || TYPE_TEMPLATE[modelKey] || 'quad250');
  if (!TEMPLATES[key]) key = TYPE_TEMPLATE[type] || 'quad250';
  const g = TEMPLATES[key](THREE, new THREE.Color(color));
  g.userData.template = key;
  // modeli birim kutuya sığdır
  const box = new THREE.Box3().setFromObject(g), s = 1.8 / Math.max(...box.getSize(new THREE.Vector3()).toArray());
  g.scale.setScalar(s);
  const c = box.getCenter(new THREE.Vector3()).multiplyScalar(s); g.position.sub(c);
  const wrap = new THREE.Group(); wrap.add(g); wrap.userData.spin = g.userData.spin; wrap.userData.flame = g.userData.flame;
  return wrap;
}

/** Her karede dönen parçaları çevir. */
export function animateDrone(group, dt, t) {
  for (const s of group.userData.spin || []) s.mesh.rotation[s.axis] += s.speed * dt;
  if (group.userData.flame) group.userData.flame.scale.set(1, 0.9 + Math.sin(t * 40) * 0.15, 1);
}

/** GLB yükle (katalogdaki gerçek model); hata → null. */
export async function loadGlb(lib, url) {
  try {
    const gltf = await new lib.GLTFLoader().loadAsync(url);
    const g = gltf.scene;
    const box = new lib.THREE.Box3().setFromObject(g), s = 1.8 / Math.max(...box.getSize(new lib.THREE.Vector3()).toArray());
    g.scale.setScalar(s); g.position.sub(box.getCenter(new lib.THREE.Vector3()).multiplyScalar(s));
    const wrap = new lib.THREE.Group(); wrap.add(g); wrap.userData.spin = [];
    return wrap;
  } catch { return null; }
}
