// SIMUMAV §28 — KARAKTER YARATMA: prosedürel düşük poli TAM BOY pilot (three.js ile üretilir; harici model/doku YOK → lisans: proje kodu, CC0 eşdeğeri).
// THREE dışarıdan verilir (import yok): oyun kabuğu (/app/core/three.js), tanıtım sitesi (/site/js/stage.js) ve uçuş sahnesi (HEPGO flightsim3d.js'in
// kendi çizicisi; opts.pilot.build) aynı modülü kullanır. Saf geometri: WebGL bağlamı açmaz.
//
// Karakter uzayı: y yukarı, yüz +z yönünde; baş merkezi y = 0,6 (büst ile aynı → önbellek portreleri aynı kadraj), tam boyda ayak tabanı y ≈ FEET_Y.
// Kemikler (Group): root → torso (bel ekseni) → head (boyun ekseni) · torso → rc (kumanda; arkaya eğik) → stickL / stickR (gimbal ekseni).
//   torso.rotation.y / head.rotation.y: sapma (+ = karakterin soluna), head.rotation.x: yunuslama (− = yukarı bakış),
//   stick.rotation.x: çubuk ileri (+), stick.rotation.z: çubuk sağa (+). Mod 2: sol çubuk gaz (ileri/geri) + sapma, sağ çubuk yunuslama + yatış.
// Kipler: merged=false → parça başına mesh + tür malzemesi (düzenleyici / portre; vizör aynalı/saydam, yama + isim dokusu);
//         merged=true  → kemik başına TEK mesh (köşe renkleri, tek malzeme; dokulu parçalar yok) — uçuşta ≤ 5 çizim çağrısı, ≤ 5k üçgen (lod 'mid').
// lod: 'high' (düzenleyici) | 'mid' (uçuş) | 'low' (uçuş, §43 Düşük).
import { SKINS, normAvatar, shade } from './avatar_core.js';

export const FEET_Y = -2.96;
export const HEAD_Y = 0.6;
export const TOP_Y = 0.93;
const SEG = { high: { head: [32, 22], limb: 14, s: [14, 10], lathe: 28, ico: 1, curls: 30 }, mid: { head: [14, 10], limb: 7, s: [7, 5], lathe: 12, ico: 0, curls: 11 }, low: { head: [10, 7], limb: 5, s: [5, 4], lathe: 9, ico: 0, curls: 7 } };

/** Renk karışımı (#rrggbb). */
export function mix(a, b, t) {
  const pa = parseInt(String(a).slice(1), 16) || 0, pb = parseInt(String(b).slice(1), 16) || 0;
  const ch = s => Math.round(((pa >> s) & 255) * (1 - t) + ((pb >> s) & 255) * t);
  return `#${[16, 8, 0].map(s => ch(s).toString(16).padStart(2, '0')).join('')}`;
}

// Yüz şekilleri: genişlik/yükseklik/çene daralması (1 = daralma yok) + kare çene düzlüğü
const FACE_SHAPE = { oval: { sx: 0.95, sy: 1.08, jaw: 0.82 }, round: { sx: 1.02, sy: 1.0, jaw: 0.95 }, square: { sx: 1.0, sy: 1.05, jaw: 1.0, flat: true },
  long: { sx: 0.9, sy: 1.16, jaw: 0.84 }, heart: { sx: 1.0, sy: 1.06, jaw: 0.66 } };
const EYE_SHAPE = { almond: [1.25, 0.72], round: [1.0, 1.0], narrow: [1.38, 0.52], wide: [1.32, 1.1] };
const BUILD_K = { slim: 0.9, avg: 1.0, broad: 1.12 };
const R_HEAD = 0.29;

/** Gövde ölçüleri (beden + yapı). */
export function bodyDims(a) {
  const f = a.body === 'f', k = BUILD_K[a.build] || 1;
  return {
    f, k,
    shoulder: (f ? 0.47 : 0.56) * k, chest: (f ? 0.46 : 0.52) * k, waist: (f ? 0.34 : 0.4) * k, hip: (f ? 0.44 : 0.4) * Math.sqrt(k),
    depth: f ? 0.6 : 0.62, armR: (f ? 0.095 : 0.12) * k, legR: (f ? 0.17 : 0.19) * Math.sqrt(k), heightM: f ? 1.66 : 1.78,
  };
}

/** Ayar → yüz/saç/kıyafet renkleri. */
export function palette(a) {
  const skin = SKINS[a.skin] || SKINS.s4;
  const out = a.outfit || 'suit';
  return {
    skin, skinD: shade(skin, -0.12), lip: a.body === 'f' ? mix(skin, '#b24a5e', 0.42) : shade(skin, -0.32), hair: a.hair_color, brow: shade(a.hair_color, a.hair_color > '#c' ? -0.18 : -0.3),
    top: a.suit, topD: shade(a.suit, -0.35), pants: out === 'suit' ? a.suit : out === 'jacket' ? '#3f3f46' : '#3b5b8c', boots: out === 'casual' ? '#e5e7eb' : out === 'jacket' ? '#5b3a1e' : '#1f2329',
    sole: '#15171c', hands: out === 'suit' ? '#2a2d33' : skin, collar: out === 'jacket' ? '#d6c7a1' : shade(a.suit, -0.35),
    helmet: a.helmet, helmD: shade(a.helmet, -0.55), visor: a.visor, acc: a.patch_color, dark: '#15171c', white: '#f4f4f5', eye: a.eye_color,
  };
}

/**
 * Karakter kur. cfg: avatar ayarı; opts: {pose: 'full'|'bust', lod, merged, rc (kumanda tutuşu), name (göğüs bandı; yalnız merged=false)}.
 * Dönüş: THREE.Group (userData: {bones: {root, torso, head, rc, stickL, stickR}, head, dims, tris, dispose()}).
 */
export function buildCharacter(THREE, cfg, { pose = 'full', lod = 'high', merged = false, rc = false, name = '' } = {}) {
  const a = normAvatar(cfg);
  const S = SEG[lod] || SEG.high, full = pose !== 'bust';
  const D = bodyDims(a), P = palette(a);
  const disp = [];
  const parts = [];   // {bone, geo, kind, color, opacity, map, heat}
  const v3 = (x, y, z) => new THREE.Vector3(x, y, z);
  const mtx = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler();
  /** Parça ekle (dönüşüm geometriye işlenir). */
  const add = (bone, geo, kind, color, pos = [0, 0, 0], rot = null, scl = null, extra = {}) => {
    e.set(...(rot || [0, 0, 0])); q.setFromEuler(e);
    mtx.compose(v3(...pos), q, v3(...(scl || [1, 1, 1])));
    geo.applyMatrix4(mtx);
    parts.push({ bone, geo, kind, color, ...extra });
    return geo;
  };
  const sph = (r, ws = S.s[0], hs = S.s[1], ...rest) => new THREE.SphereGeometry(r, ws, hs, ...rest);
  /** p0 → p1 arası konik silindir (+ isteğe bağlı eklem küreleri). */
  const seg = (bone, p0, p1, r0, r1, kind, color, joints = false) => {
    const d = new THREE.Vector3().subVectors(p1, p0), len = d.length();
    const g = new THREE.CylinderGeometry(r1, r0, len, S.limb, 1, false);
    const qq = new THREE.Quaternion().setFromUnitVectors(v3(0, 1, 0), d.clone().normalize());
    mtx.compose(p0.clone().addScaledVector(d, 0.5), qq, v3(1, 1, 1)); g.applyMatrix4(mtx);
    parts.push({ bone, geo: g, kind, color });
    if (joints) { add(bone, sph(r0 * 1.02), kind, color, p0.toArray()); add(bone, sph(r1 * 1.02), kind, color, p1.toArray()); }
  };

  // ---------------------------------------------------------------- kemikler
  const waistY = full ? -0.95 : 0;
  const bones = {};
  const mkBone = (nm, parent, pos, rot = null) => { const g = new THREE.Group(); g.name = `av-${nm}`; g.position.set(...pos); if (rot) g.rotation.set(...rot); (parent ? bones[parent] : null)?.add(g); bones[nm] = g; return g; };
  mkBone('root', null, [0, 0, 0]);
  mkBone('torso', 'root', [0, waistY, 0]);
  mkBone('head', 'torso', [0, HEAD_Y - waistY, 0]);
  const T = (x, y, z) => v3(x, y - waistY, z);           // karakter uzayı → torso yerel
  const RCPOS = [0, -0.74 - waistY, 0.6], RCROT = [-0.62, 0, 0];
  if (full && rc) {
    mkBone('rc', 'torso', RCPOS, RCROT);
    mkBone('stickL', 'rc', [0.15, 0.062, 0.03]);
    mkBone('stickR', 'rc', [-0.15, 0.062, 0.03]);
  }

  // ---------------------------------------------------------------- gövde
  const torsoColor = P.top;
  if (full) {
    const k = D;
    // pelvis (kök kemik; bacaklarla aynı) + üst gövde (torso kemiği) — profil x = yarıçap, z ölçeği derinlik
    const pelvis = [[0, -1.42], [k.hip * 0.42, -1.43], [k.hip * 0.8, -1.38], [k.hip * 0.97, -1.25], [k.hip, -1.12], [k.waist * 1.02, -0.93], [0, -0.93]];
    const pelvisColor = a.outfit === 'suit' ? P.top : P.pants;
    add('root', new THREE.LatheGeometry(pelvis.map(([x, y]) => new THREE.Vector2(x, y)), S.lathe), 'std', pelvisColor, [0, 0, 0], null, [1, 1, k.depth]);
    const upper = [[0, -1.0], [k.waist, -1.0], [k.waist * 1.04, -0.78], [k.chest * 0.96, -0.5], [k.chest, -0.28], [k.shoulder * 0.98, -0.06], [k.shoulder * 0.86, 0.06], [0.34, 0.15], [0.16, 0.19], [0, 0.2]];
    const ug = new THREE.LatheGeometry(upper.map(([x, y]) => new THREE.Vector2(x, y - waistY)), S.lathe);
    add('torso', ug, 'std', torsoColor, [0, 0, 0], null, [1, 1, k.depth]);
    // bel kemeri / yaka / fermuar
    add('root', new THREE.TorusGeometry(k.waist * 1.02, 0.035, 6, S.lathe), 'std', a.outfit === 'casual' ? '#5b3a1e' : P.dark, [0, -0.96, 0], [Math.PI / 2, 0, 0], [1, k.depth, 1]);
    add('torso', new THREE.TorusGeometry(0.19, a.outfit === 'jacket' ? 0.07 : 0.045, 6, S.lathe), 'std', P.collar, T(0, 0.17, 0).toArray(), [Math.PI / 2, 0, 0]);
    if (a.outfit !== 'casual') add('torso', new THREE.BoxGeometry(0.03, 0.95, 0.02), 'std', P.topD, T(0, -0.45, k.chest * k.depth + 0.004).toArray());
    // bacaklar + botlar
    for (const sx of [-1, 1]) {
      const hip = v3(sx * 0.2 * Math.sqrt(k.k), -1.22, 0), knee = v3(sx * 0.215, -2.06, 0.03), ankle = v3(sx * 0.22, -2.8, -0.01);
      seg('root', hip, knee, k.legR, k.legR * 0.76, 'std', P.pants, false);
      add('root', sph(k.legR * 0.78), 'std', P.pants, knee.toArray());
      seg('root', knee, ankle, k.legR * 0.74, k.legR * 0.56, 'std', P.pants, false);
      add('root', new THREE.BoxGeometry(0.22, 0.15, 0.4, 1, 1, 1), 'std', P.boots, [sx * 0.22, -2.86, 0.07]);
      add('root', sph(0.11, S.s[0], S.s[1], 0, Math.PI * 2, 0, Math.PI / 2), 'std', P.boots, [sx * 0.22, -2.9, 0.24], null, [1, 0.8, 0.9]);
      add('root', new THREE.BoxGeometry(0.24, 0.04, 0.46), 'std', P.sole, [sx * 0.22, -2.94, 0.08]);
    }
    // kollar: kumanda tutuşu (iki kemikli IK) ya da serbest duruş
    for (const sx of [-1, 1]) {
      const sh = T(sx * (k.shoulder - 0.07), -0.08, 0);
      let hand, pole;
      if (rc) {   // tutamak noktası: kumanda yerelinden torso yereline
        const rcM = new THREE.Matrix4().compose(v3(...RCPOS), new THREE.Quaternion().setFromEuler(new THREE.Euler(...RCROT)), v3(1, 1, 1));
        hand = v3(sx * 0.3, -0.07, -0.03).applyMatrix4(rcM);
        pole = v3(sx * 1, -0.8, -0.6);
      } else { hand = T(sx * (k.shoulder + 0.02), -1.08, 0.1); pole = v3(sx * 0.3, 0, -1); }
      const la = 0.6, lb = 0.56;
      const d = hand.clone().sub(sh), dist = Math.min(d.length(), la + lb - 1e-3), dir = d.clone().normalize();
      const cosA = (la * la + dist * dist - lb * lb) / (2 * la * dist), sinA = Math.sqrt(Math.max(0, 1 - cosA * cosA));
      const perp = pole.clone().sub(dir.clone().multiplyScalar(pole.dot(dir))).normalize();
      const elbow = sh.clone().addScaledVector(dir, la * cosA).addScaledVector(perp, la * sinA);
      const wrist = sh.clone().addScaledVector(dir, dist);
      const sleeve = a.outfit === 'casual' ? P.skin : P.top;
      add('torso', sph(k.armR * 1.25), 'std', P.top, sh.toArray());
      if (a.outfit === 'casual') {   // tişört kolu dirseğe kadar
        const mid = sh.clone().lerp(elbow, 0.55);
        seg('torso', sh, mid, k.armR * 1.12, k.armR * 1.02, 'std', P.top);
        seg('torso', mid, elbow, k.armR * 0.82, k.armR * 0.78, 'std', P.skin);
      } else seg('torso', sh, elbow, k.armR, k.armR * 0.86, 'std', P.top);
      add('torso', sph(k.armR * 0.86), 'std', sleeve, elbow.toArray());
      seg('torso', elbow, wrist, k.armR * 0.84, k.armR * 0.68, 'std', sleeve);
      if (a.outfit === 'jacket' || a.outfit === 'suit') add('torso', new THREE.CylinderGeometry(k.armR * 0.74, k.armR * 0.74, 0.05, S.limb), 'std', P.topD, wrist.toArray(), null, null);
      // el: avuç (kutu) + parmak bloğu; kumandada avuç tutamağı sarar
      const hq = new THREE.Quaternion().setFromUnitVectors(v3(0, -1, 0), dir);
      const he = new THREE.Euler().setFromQuaternion(hq);
      const palm = wrist.clone().addScaledVector(dir, 0.07);
      add('torso', new THREE.BoxGeometry(0.11, 0.13, 0.07), 'std', P.hands, palm.toArray(), [he.x, he.y, he.z]);
      if (!rc) add('torso', sph(0.035), 'std', P.hands, palm.clone().add(v3(-sx * 0.05, -0.02, 0.05)).toArray());   // başparmak
    }
    // göğüs yaması + isim bandı (dokulu; yalnız merged=false)
    if (!merged) {
      const chestZ = (x, y) => { const A = k.chest, B = A * k.depth; return { z: B * Math.sqrt(Math.max(0, 1 - (x / A) ** 2)) + 0.012, ry: Math.atan2(x / (A * A), Math.sqrt(Math.max(0, 1 - (x / A) ** 2)) * B / (B * B)) }; };
      if (a.patch && a.patch !== 'none') { const c = chestZ(-0.24, -0.3); parts.push({ bone: 'torso', tex: 'patch', size: [0.2, 0.2], pos: T(-0.24, -0.3, c.z).toArray(), rot: [0, c.ry, 0] }); }
      if (name) { const c = chestZ(0.24, -0.27); parts.push({ bone: 'torso', tex: 'name', size: [0.28, 0.07], pos: T(0.24, -0.27, c.z).toArray(), rot: [0, c.ry, 0] }); }
    }
  } else {
    // ---- büst (portre önbelleği / TOP 10): §25 lathe gövdesi
    const prof = [[0, -0.78], [0.72, -0.78], [0.75, -0.5], [0.71, -0.2], [0.6, 0.0], [0.42, 0.12], [0.2, 0.18], [0, 0.19]];
    add('torso', new THREE.LatheGeometry(prof.map(([x, y]) => new THREE.Vector2(x * (D.f ? 0.9 : 1), y)), S.lathe), 'std', torsoColor, [0, 0, 0], null, [1, 1, 0.7]);
    add('torso', new THREE.TorusGeometry(0.2, a.outfit === 'jacket' ? 0.07 : 0.05, 8, 24), 'std', P.collar, [0, 0.17, 0], [Math.PI / 2, 0, 0]);
    if (a.outfit !== 'casual') add('torso', new THREE.BoxGeometry(0.03, 0.62, 0.02), 'std', P.topD, [0, -0.32, 0.5]);
    if (!merged) {
      const radAt = y => { for (let i = 1; i < prof.length; i++) { const [x0, y0] = prof[i - 1], [x1, y1] = prof[i]; if (y >= y0 && y <= y1) return x0 + (x1 - x0) * ((y - y0) / (y1 - y0 || 1)); } return 0.7; };
      const chest = (x, y) => { const A = radAt(y) * (D.f ? 0.9 : 1), B = A * 0.7, z = B * Math.sqrt(Math.max(0, 1 - (x / A) ** 2)); return { z: z + 0.012, ry: Math.atan2(x / (A * A), z / (B * B)) }; };
      if (a.patch && a.patch !== 'none') { const c = chest(0.3, -0.2); parts.push({ bone: 'torso', tex: 'patch', size: [0.24, 0.24], pos: [0.3, -0.2, c.z], rot: [0, c.ry, 0] }); }
      if (name) { const c = chest(-0.3, -0.16); parts.push({ bone: 'torso', tex: 'name', size: [0.32, 0.08], pos: [-0.3, -0.16, c.z], rot: [0, c.ry, 0] }); }
    }
  }
  // boyun
  add('torso', new THREE.CylinderGeometry(D.f ? 0.11 : 0.13, D.f ? 0.13 : 0.15, 0.3, S.limb), 'std', P.skin, (full ? T(0, 0.27, 0) : v3(0, 0.28, 0)).toArray());

  // ---------------------------------------------------------------- baş (head kemiği yerel; baş merkezi (0, −0,02, 0))
  const FS = { ...(FACE_SHAPE[a.face] || FACE_SHAPE.oval) };
  if (D.f) { FS.sx *= 0.95; FS.jaw *= 0.95; }
  const RX = R_HEAD * FS.sx, RY = R_HEAD * FS.sy, RZ = R_HEAD;
  const deform = (g, grow = 1) => {   // küre → yüz şekli (alt yarı çeneye doğru daralır; kare çene düz)
    const p = g.attributes.position;
    for (let i = 0; i < p.count; i++) {
      let x = p.getX(i), y = p.getY(i), z = p.getZ(i);
      const t = Math.min(1, Math.max(0, -y / (R_HEAD * grow)));
      const w = 1 - (1 - FS.jaw) * t ** 1.4;
      x *= FS.sx * w; z *= (1 - 0.08 * t); y *= FS.sy;
      if (FS.flat && y < -0.82 * RY * grow) y = -0.82 * RY * grow + (y + 0.82 * RY * grow) * 0.45;
      p.setXYZ(i, x, y, z);
    }
    g.computeVertexNormals();
    return g;
  };
  const HC = [0, -0.02, 0];
  add('head', deform(sph(R_HEAD, S.head[0], S.head[1])), 'skin', P.skin, HC);
  /** Yüz yüzeyinde (x, y) noktası: z + normal yönelimi (baş yerel). */
  const surf = (x, y, off = 0) => {
    const yy = y - HC[1], t = Math.min(1, Math.max(0, -yy / RY)), rx = RX * (1 - (1 - FS.jaw) * t ** 1.4), rz = RZ * (1 - 0.08 * t);
    const s = Math.max(0.02, 1 - (x / rx) ** 2 - (yy / RY) ** 2), z = rz * Math.sqrt(s);
    return { z: z + off, ry: Math.atan2(x / (rx * rx), z / (rz * rz)), rx: -Math.atan2(yy / (RY * RY), z / (rz * rz)) * 0.6 };
  };
  const onFace = (geo, kind, color, x, y, off = 0.004, scl = null, rotZ = 0) => { const s = surf(x, y, off); return add('head', geo, kind, color, [x, y, s.z], [s.rx, s.ry, rotZ], scl); };
  // kulaklar
  for (const sx of [-1, 1]) add('head', sph(0.055, S.s[0], S.s[1]), 'skin', P.skinD, [sx * RX * 0.98, -0.03, -0.01], null, [0.45, 1, 0.75]);
  // gözler
  const [esx, esy] = EYE_SHAPE[a.eyes] || EYE_SHAPE.almond, eyeX = 0.1 * FS.sx, eyeY = 0.01;
  for (const sx of [-1, 1]) {
    if (lod !== 'low') onFace(sph(0.042), 'gloss', P.white, sx * eyeX, eyeY, -0.012, [esx, esy, 0.5]);
    onFace(sph(lod === 'low' ? 0.026 : 0.024), 'gloss', lod === 'low' ? shade(P.eye, -0.3) : P.eye, sx * eyeX, eyeY, lod === 'low' ? 0.0 : 0.006, [1, Math.min(1, esy * 1.15), 0.5]);
    if (lod === 'high') onFace(sph(0.012), 'gloss', '#0a0a0a', sx * eyeX, eyeY, 0.014, [1, 1, 0.4]);
    if (D.f && lod !== 'low') onFace(new THREE.BoxGeometry(0.085 * esx * 0.9, 0.009, 0.012), 'std', '#1a1a1a', sx * eyeX, eyeY + 0.038 * esy, 0.006, null, sx * -0.12);   // kirpik çizgisi
  }
  // kaşlar
  const bw = { thin: 0.011, medium: 0.019, thick: 0.03 }[a.brow_w] || 0.019;
  for (const sx of [-1, 1]) {
    const bx = sx * eyeX, by = eyeY + 0.075 + (a.brows === 'arched' ? 0.008 : 0);
    if (a.brows === 'arched' && lod !== 'low') {
      const tg = new THREE.TorusGeometry(0.07, bw / 2, 4, 10, Math.PI * 0.62); tg.rotateZ(Math.PI * 0.19);
      const s = surf(bx, by, 0.006); add('head', tg, 'std', P.brow, [bx, by - 0.055, s.z], [s.rx, s.ry, 0], [1, 1, 0.5]);
    } else {
      const rz = a.brows === 'angled' ? sx * 0.26 : a.brows === 'soft' ? sx * -0.1 : 0;
      onFace(new THREE.BoxGeometry(0.105, bw, 0.02), 'std', P.brow, bx, by, 0.006, null, rz);
    }
  }
  // burun
  const ny = -0.06, nz = surf(0, ny).z;
  if (a.nose === 'small') add('head', sph(0.03), 'skin', P.skin, [0, ny, nz + 0.004], null, [1, 0.8, 0.9]);
  else if (a.nose === 'wide') add('head', sph(0.044), 'skin', P.skin, [0, ny - 0.005, nz], null, [1.45, 0.8, 0.85]);
  else if (a.nose === 'pointed') add('head', new THREE.ConeGeometry(0.03, 0.085, Math.max(5, S.limb)), 'skin', P.skin, [0, ny + 0.0, nz + 0.022], [Math.PI / 2 + 0.45, 0, 0], [1, 1, 0.8]);
  else { add('head', new THREE.ConeGeometry(0.03, 0.11, 4), 'skin', P.skin, [0, ny + 0.02, nz + 0.012], [0.35, Math.PI / 4, 0], [1, 1, 0.7]); add('head', sph(0.028), 'skin', P.skin, [0, ny - 0.02, nz + 0.02]); }
  // ağız
  const my = -0.14;
  if (a.mouth === 'smile' || a.mouth === 'grin') {
    const tg = new THREE.TorusGeometry(0.055, a.mouth === 'grin' ? 0.012 : 0.009, 4, lod === 'low' ? 6 : 12, Math.PI * 0.62); tg.rotateZ(Math.PI + Math.PI * 0.19);
    const s = surf(0, my, 0.002); add('head', tg, 'std', P.lip, [0, my + 0.05, s.z], [s.rx, 0, 0], [1, 0.8, 0.5]);
    if (a.mouth === 'grin') onFace(new THREE.BoxGeometry(0.07, 0.018, 0.01), 'gloss', P.white, 0, my - 0.003, 0.004);
  } else onFace(new THREE.BoxGeometry(a.mouth === 'serious' ? 0.08 : 0.1, a.mouth === 'serious' ? 0.012 : 0.017, 0.02), 'std', a.mouth === 'serious' ? shade(P.lip, -0.2) : P.lip, 0, my, 0.002);
  // çil / ben
  if (a.freckles && lod !== 'low') for (const [x, y] of [[0.07, -0.05], [0.11, -0.04], [0.09, -0.075], [0.135, -0.065], [-0.07, -0.05], [-0.11, -0.04], [-0.09, -0.075], [-0.135, -0.065], [0.03, -0.03], [-0.03, -0.03]]) onFace(sph(0.0065, 3, 2), 'std', shade(P.skin, -0.32), x, y, 0.001);
  if (a.mole) onFace(sph(0.009, 5, 4), 'std', '#3b2418', 0.11, -0.12, 0.002);
  // sakal / bıyık (erkek)
  const beard = D.f ? 'none' : a.beard;
  const shell = (grow, t0, tl, p0, pl, color, kind = 'std') => {   // başla aynı şekilde deforme edilmiş kabuk (alt yüz)
    const g = sph(R_HEAD * grow, S.head[0], Math.max(4, Math.round(S.head[1] * tl / Math.PI) + 2), p0, pl, t0, tl);
    const p = g.attributes.position;
    for (let i = 0; i < p.count; i++) { let x = p.getX(i), y = p.getY(i), z = p.getZ(i); const t = Math.min(1, Math.max(0, -y / R_HEAD)); const w = 1 - (1 - FS.jaw) * t ** 1.4; x *= FS.sx * w; z *= (1 - 0.08 * t); y *= FS.sy; if (FS.flat && y < -0.82 * RY) y = -0.82 * RY + (y + 0.82 * RY) * 0.45; p.setXYZ(i, x, y, z); }
    g.computeVertexNormals();
    return add('head', g, kind, color, HC);
  };
  const mustache = () => { for (const sx of [-1, 1]) onFace(new THREE.CapsuleGeometry(0.014, 0.05, 2, Math.max(4, S.limb >> 1)), 'std', P.hair, sx * 0.032, my + 0.036, 0.008, null, Math.PI / 2 + sx * 0.32); };
  if (beard === 'stubble') shell(1.012, Math.PI * 0.56, Math.PI * 0.44, Math.PI * 0.02, Math.PI * 0.96, mix(P.skin, P.hair, 0.42));
  else if (beard === 'full') { shell(1.045, Math.PI * 0.55, Math.PI * 0.45, -Math.PI * 0.08, Math.PI * 1.16, P.hair); mustache(); }
  else if (beard === 'mustache') mustache();
  else if (beard === 'goatee') { mustache(); onFace(sph(0.05), 'std', P.hair, 0, -0.245, 0.0, [0.9, 1.2, 0.6]); }
  // gözlük
  if (a.glasses !== 'none') {
    const gz = surf(eyeX, eyeY).z + 0.035, metal = a.glasses === 'aviator' ? '#c9a227' : '#18181b';
    for (const sx of [-1, 1]) {
      if (a.glasses === 'aviator') {
        add('head', sph(0.056, S.s[0], S.s[1]), 'lens', '#3f4a2a', [sx * eyeX, eyeY - 0.012, gz], null, [1.08, 0.95, 0.22]);
        add('head', new THREE.TorusGeometry(0.058, 0.0055, 4, S.limb * 2), 'metal', metal, [sx * eyeX, eyeY - 0.012, gz + 0.002], null, [1.08, 0.95, 1]);
      } else {
        add('head', new THREE.BoxGeometry(0.11, 0.065, 0.012), 'lens', '#0b0b0d', [sx * eyeX, eyeY - 0.004, gz]);
        add('head', new THREE.BoxGeometry(0.12, 0.012, 0.016), 'metal', metal, [sx * eyeX, eyeY + 0.03, gz + 0.002]);
      }
      add('head', new THREE.BoxGeometry(0.008, 0.008, 0.26), 'metal', metal, [sx * RX * 0.97, eyeY + 0.01, gz - 0.13]);
    }
    add('head', new THREE.BoxGeometry(0.05, 0.008, 0.008), 'metal', metal, [0, eyeY + 0.018, gz + 0.004]);
  }

  // ---------------------------------------------------------------- saç
  const hg = a.headgear || 'helmet';
  const helmetOn = hg === 'helmet' || a.bot;
  const hairCol = P.hair;
  const capHair = (R, tilt, color = hairCol, sy = FS.sy) => { const g = sph(R, S.head[0], Math.max(4, S.head[1] >> 1), 0, Math.PI * 2, 0, Math.PI / 2); g.rotateX(-tilt); return add('head', g, 'hair', color, [0, HC[1] + 0.005, -0.005], null, [FS.sx * 1.01, sy, 1.03]); };
  const curtain = (top, bot, r0, r1, arc, color = hairCol) => { const g = new THREE.CylinderGeometry(r0, r1, top - bot, S.head[0], 1, true, Math.PI - arc / 2, arc); return add('head', g, 'hair', color, [0, (top + bot) / 2, -0.01], null, [FS.sx, 1, 0.98]); };
  const hair = a.hair;
  const under = !helmetOn;   // kasksız / şapka / kulaklık → saç görünür
  const capOn = hg === 'cap';
  if (hair !== 'bald') {
    if (under) {
      if (hair === 'buzz') capHair(R_HEAD * 1.012, 0.42, mix(hairCol, P.skin, 0.3));
      else if (hair === 'mohawk') { capHair(R_HEAD * 1.008, 0.42, mix(hairCol, P.skin, 0.55)); if (!capOn) add('head', sph(1, S.s[0], S.s[1]), 'hair', hairCol, [0, 0.29, -0.03], null, [0.045, 0.15, 0.3]); }
      else capHair(R_HEAD * (hair === 'curly' ? 1.05 : 1.045), hair === 'sidepart' ? 0.46 : 0.5);
      if (hair === 'spiky' && !capOn) {
        const n = lod === 'low' ? 5 : 9;
        for (let i = 0; i < n; i++) {
          const th = 0.25 + (i % 3) * 0.32, ph = (i / n) * Math.PI * 2;
          const dir = v3(Math.sin(th) * Math.sin(ph), Math.cos(th), Math.sin(th) * Math.cos(ph) * 0.9 - 0.1).normalize();
          const g = new THREE.ConeGeometry(0.045, 0.12, 5); g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(v3(0, 1, 0), dir));
          add('head', g, 'hair', hairCol, dir.clone().multiplyScalar(R_HEAD * 1.06).add(v3(0, HC[1], 0)).toArray(), null, [FS.sx, FS.sy, 1]);
        }
      }
      if (hair === 'sidepart' && !capOn) add('head', sph(0.13), 'hair', hairCol, [0.09, 0.24, 0.1], [0, 0, -0.35], [1.6, 0.48, 1.25]);
      if (hair === 'curly') {
        const n = S.curls;
        for (let i = 0; i < n; i++) {
          const t = (i + 0.5) / n, th = Math.acos(1 - t * 1.25), ph = i * 2.39996;
          const dir = v3(Math.sin(th) * Math.sin(ph), Math.cos(th), Math.sin(th) * Math.cos(ph));
          if (dir.z > 0.55 && dir.y < 0.75) continue;   // alın açık
          if (capOn && dir.y > 0.35) continue;
          add('head', new THREE.IcosahedronGeometry(0.062, S.ico), 'hair', hairCol, dir.clone().multiplyScalar(R_HEAD * 1.06).add(v3(0, HC[1] + 0.01, -0.01)).toArray(), null, [FS.sx, 1, 1]);
        }
      }
      if (hair === 'bun' && !capOn) add('head', sph(0.11), 'hair', hairCol, [0, 0.25, -0.2]);
    }
    // ensedeki uzun saç / at kuyruğu / küt kesim kask altından da görünür
    if (hair === 'long') { curtain(0.06, -0.6, R_HEAD * 1.04, R_HEAD * 1.14, Math.PI * 1.25); if (under) for (const sx of [-1, 1]) add('head', new THREE.BoxGeometry(0.06, 0.46, 0.12), 'hair', hairCol, [sx * RX * 1.02, -0.2, 0.05], [0, 0, sx * -0.05]); }
    else if (hair === 'bob') curtain(0.06, -0.25, R_HEAD * 1.05, R_HEAD * 1.12, Math.PI * 1.45);
    else if (hair === 'ponytail') {
      const root = v3(0, helmetOn ? -0.12 : 0.06, -0.31);
      add('head', new THREE.TorusGeometry(0.04, 0.014, 4, 8), 'std', P.dark, root.toArray(), [0.3, 0, 0]);
      seg('head', root, v3(0, root.y - 0.42, -0.4), 0.06, 0.028, 'hair', hairCol);
      add('head', sph(0.06), 'hair', hairCol, root.toArray());
    }
  }

  // ---------------------------------------------------------------- başlık
  const R = 0.37;
  if (helmetOn) {
    const helm = { pos: [0, 0.03, -0.01] };
    const H = (geo, kind, color, pos = [0, 0, 0], rot = null, scl = null, extra = {}) => add('head', geo, kind, color, [pos[0] + helm.pos[0], pos[1] + helm.pos[1], pos[2] + helm.pos[2]], rot, scl, extra);
    const hs = S.head[0] + 4;
    H(sph(R, hs, Math.max(4, Math.round(S.head[1] * 0.45)), 0, Math.PI * 2, 0, Math.PI * 0.34), 'gloss', P.helmet);
    H(sph(R, hs, Math.max(3, Math.round(S.head[1] * 0.4)), Math.PI / 2 + 0.78, Math.PI * 2 - 1.56, Math.PI * 0.34, Math.PI * 0.27), 'gloss', P.helmet);
    const open = !!a.visor_open && !a.bot;
    const vg = sph(R * 1.018, Math.max(8, hs - 8), Math.max(3, Math.round(S.head[1] * 0.4)), Math.PI / 2 - 0.84, 1.68, Math.PI * 0.32, Math.PI * 0.27);
    if (open) vg.rotateX(-0.95);   // vizör açık: kaskın üstüne kalkar (aynı küre yüzeyinde kayar) → yüz görünür
    H(vg, a.mirror || open ? 'visorM' : 'visorT', open ? shade(a.visor, -0.15) : a.visor);
    H(new THREE.TorusGeometry(R * 0.955, 0.028, 6, hs + 4), 'std', P.helmD, [0, -R * Math.cos(Math.PI * 0.39), 0], [Math.PI / 2, 0, 0]);
    for (const sx of [-1, 1]) H(new THREE.CylinderGeometry(0.09, 0.09, 0.06, S.limb + 4), 'std', P.helmD, [sx * (R - 0.005), -0.07, -0.02], [0, 0, Math.PI / 2]);
    const arc = (rad, r0, from, to, n = 16) => { const pts = []; for (let i = 0; i <= n; i++) { const t = from + (to - from) * (i / n); pts.push(v3(0, Math.cos(t) * r0, Math.sin(t) * r0)); } return new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), n * 2, rad, 6, false); };
    if (a.accessory === 'mic' && !a.bot) {
      const pts = [[R * 0.98, -0.08, 0.02], [R * 0.9, -0.2, 0.2], [0.18, -0.25, 0.33], [0.06, -0.24, 0.36]].map(p => v3(...p));
      H(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 16, 0.013, 5, false), 'std', P.dark);
      H(sph(0.035), 'std', P.dark, [0.06, -0.24, 0.36], null, [1.3, 1, 1]);
    } else if (a.accessory === 'crest') H(arc(0.04, R + 0.025, -0.25 * Math.PI, 0.62 * Math.PI), 'gloss', P.acc, [0, 0, 0], null, [0.6, 1, 1]);
    else if (a.accessory === 'stripe' || a.bot) H(arc(0.03, R + 0.004, -0.33 * Math.PI, 0.3 * Math.PI), 'gloss', P.acc, [0, 0, 0], null, [1.6, 1, 1]);
    else if (a.accessory === 'antenna') {
      H(new THREE.CylinderGeometry(0.01, 0.012, 0.3, 6), 'std', P.dark, [0.17, R + 0.06, -0.08], [0, 0, -0.35]);
      H(sph(0.032), 'gloss', P.acc, [0.22, R + 0.2, -0.08]);
    }
    if (a.bot) {   // HEPGO §44 yapay zekâ pilot: "AI" yazıları (alın + iki yan; dokulu → yalnız merged=false) + anten
      if (!merged) {
        const t = Math.PI * 0.2;
        parts.push({ bone: 'head', tex: 'ai', size: [0.2, 0.1], pos: [0, Math.cos(t) * (R + 0.006) + helm.pos[1], Math.sin(t) * (R + 0.006) + helm.pos[2]], rot: [-(Math.PI / 2 - t), 0, 0] });
        for (const sx of [-1, 1]) parts.push({ bone: 'head', tex: 'ai', size: [0.2, 0.1], pos: [sx * (R + 0.012), 0.08 + helm.pos[1], -0.08 + helm.pos[2]], rot: [0, sx * Math.PI / 2, 0] });
      }
      H(new THREE.CylinderGeometry(0.01, 0.012, 0.26, 6), 'std', P.dark, [-0.17, R + 0.05, -0.08], [0, 0, 0.35]);
      H(sph(0.03), 'gloss', P.acc, [-0.21, R + 0.17, -0.08]);
    }
  } else if (hg === 'cap') {
    const g = sph(R_HEAD * 1.1, S.head[0], Math.max(4, S.head[1] >> 1), 0, Math.PI * 2, 0, Math.PI / 2); g.rotateX(-0.3);
    add('head', g, 'std', P.helmet, [0, HC[1] + 0.03, -0.01], null, [FS.sx * 1.02, 0.95, 1.04]);
    add('head', new THREE.CylinderGeometry(0.2, 0.2, 0.018, S.head[0], 1, false, -Math.PI / 2, Math.PI), 'std', shade(P.helmet, -0.15), [0, HC[1] + 0.14, RZ * 0.88], [0.18, 0, 0], [FS.sx, 1, 0.9]);
    add('head', sph(0.022), 'std', shade(P.helmet, -0.2), [0, HC[1] + R_HEAD * 1.07, -0.08]);
    if (a.patch !== 'none') add('head', new THREE.CircleGeometry(0.05, 10), 'std', P.acc, [0, HC[1] + 0.2, RZ * 0.98], [-0.6, 0, 0]);
  } else if (hg === 'headset') {
    const bandR = RX * 1.13;
    add('head', new THREE.TorusGeometry(bandR, 0.022, 5, S.head[0], Math.PI), 'gloss', P.dark, [0, HC[1] + 0.02, -0.02], null, [1, FS.sy * 1.02, 1]);
    for (const sx of [-1, 1]) {
      add('head', new THREE.CylinderGeometry(0.095, 0.1, 0.075, S.limb + 4), 'gloss', P.helmet, [sx * (RX + 0.035), HC[1] - 0.02, -0.01], [0, 0, Math.PI / 2]);
      add('head', new THREE.CylinderGeometry(0.06, 0.06, 0.08, S.limb), 'std', P.dark, [sx * (RX + 0.012), HC[1] - 0.02, -0.01], [0, 0, Math.PI / 2]);
    }
    const pts = [[RX + 0.05, -0.06, 0.02], [RX * 0.95, -0.16, 0.18], [0.16, -0.17, 0.3], [0.05, -0.155, 0.32]].map(p => v3(...p));
    add('head', new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 12, 0.011, 5, false), 'std', P.dark);
    add('head', sph(0.028), 'std', P.dark, [0.05, -0.155, 0.32], null, [1.3, 1, 1]);
  }

  // ---------------------------------------------------------------- RC kumanda (iki çubuklu verici + anten; başparmaklar çubuk kemiğinde)
  if (full && rc) {
    const body = '#26292f', face = '#33373e';
    add('rc', new THREE.BoxGeometry(0.62, 0.1, 0.34), 'std', body, [0, 0, 0]);
    add('rc', new THREE.BoxGeometry(0.56, 0.012, 0.28), 'std', face, [0, 0.055, 0]);
    for (const sx of [-1, 1]) {
      add('rc', new THREE.BoxGeometry(0.12, 0.15, 0.24), 'std', body, [sx * 0.27, -0.08, -0.04], [0, 0, sx * 0.12]);
      add('rc', new THREE.CylinderGeometry(0.07, 0.075, 0.016, S.limb + 4), 'gloss', '#4b5563', [sx * 0.15, 0.062, 0.03]);
      add('rc', new THREE.CylinderGeometry(0.008, 0.008, 0.06, 5), 'metal', '#9ca3af', [sx * 0.24, 0.085, 0.14], [0.3, 0, 0]);   // anahtarlar
    }
    add('rc', new THREE.BoxGeometry(0.14, 0.006, 0.08), 'gloss', '#0f766e', [0, 0.064, -0.07]);   // ekran
    add('rc', new THREE.CylinderGeometry(0.012, 0.016, 0.3, 6), 'std', P.dark, [0, 0.12, 0.2], [0.45, 0, 0]);   // anten
    add('rc', sph(0.02), 'std', P.dark, [0, 0.255, 0.27]);
    for (const bn of ['stickL', 'stickR']) {
      add(bn, new THREE.CylinderGeometry(0.011, 0.013, 0.1, 6), 'metal', '#9ca3af', [0, 0.05, 0]);
      add(bn, new THREE.CylinderGeometry(0.022, 0.022, 0.022, 8), 'std', P.dark, [0, 0.1, 0]);
      add(bn, new THREE.CapsuleGeometry(0.03, 0.05, 2, 6), 'std', P.hands, [0, 0.125, -0.035], [Math.PI / 2 - 0.3, 0, 0]);   // başparmak
    }
  }

  // ---------------------------------------------------------------- birleştirme
  const root = bones.root;
  let tris = 0;
  const mats = new Map();
  const matFor = (kind, color, opacity) => {
    const key = `${kind}|${color}|${opacity ?? ''}`;
    if (mats.has(key)) return mats.get(key);
    const o = { color };
    if (kind === 'skin') Object.assign(o, { roughness: 0.62 });
    else if (kind === 'hair') Object.assign(o, { roughness: 0.82, side: THREE.DoubleSide });
    else if (kind === 'gloss') Object.assign(o, { roughness: 0.3, metalness: 0.15 });
    else if (kind === 'metal') Object.assign(o, { roughness: 0.25, metalness: 0.85 });
    else if (kind === 'visorM') Object.assign(o, { metalness: 1, roughness: 0.06, envMapIntensity: 1.4, side: THREE.DoubleSide });
    else if (kind === 'visorT') Object.assign(o, { metalness: 0.1, roughness: 0.05, transparent: true, opacity: 0.42, depthWrite: false, side: THREE.DoubleSide });
    else if (kind === 'lens') Object.assign(o, { metalness: 0.4, roughness: 0.08, transparent: true, opacity: 0.82 });
    else Object.assign(o, { roughness: 0.78, metalness: 0.02 });
    const m = new THREE.MeshStandardMaterial(o); disp.push(m); mats.set(key, m);
    return m;
  };
  const texFor = (p) => {
    const c = document.createElement('canvas');
    if (p.tex === 'patch') { c.width = 128; c.height = 128; drawPatchFn?.(c.getContext('2d'), a.patch, a.patch_color, 64, 64, 58); }
    else { c.width = p.tex === 'ai' ? 128 : 256; c.height = 64; const x = c.getContext('2d'); if (p.tex === 'name') { x.fillStyle = '#0b1220'; x.fillRect(0, 0, c.width, c.height); } x.fillStyle = p.tex === 'name' ? '#e5e7eb' : '#ffffff'; x.font = p.tex === 'ai' ? '900 50px system-ui, sans-serif' : 'bold 34px system-ui, sans-serif'; x.textAlign = 'center'; x.textBaseline = 'middle'; x.fillText(p.tex === 'ai' ? 'AI' : String(name).slice(0, 14), c.width / 2, c.height / 2 + 2, c.width - 12); }
    const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 4; disp.push(tex);
    return tex;
  };
  const triOf = g => (g.index ? g.index.count : g.attributes.position.count) / 3;
  if (!merged) {
    for (const p of parts) {
      let mesh;
      if (p.tex) {
        const g = new THREE.PlaneGeometry(...p.size); disp.push(g);
        const m = new THREE.MeshStandardMaterial({ map: texFor(p), transparent: p.tex !== 'name', alphaTest: p.tex === 'name' ? 0 : 0.08, roughness: 0.6 }); disp.push(m);
        mesh = new THREE.Mesh(g, m); mesh.position.set(...p.pos); mesh.rotation.set(...p.rot);
      } else { disp.push(p.geo); mesh = new THREE.Mesh(p.geo, matFor(p.kind, p.color, p.opacity)); }
      mesh.userData.heat = p.kind === 'skin' ? 0.82 : p.kind === 'hair' ? 0.66 : 0.62;
      bones[p.bone].add(mesh);
      tris += p.tex ? 2 : triOf(p.geo);
    }
  } else {
    const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.68, metalness: 0.06, side: THREE.DoubleSide }); disp.push(mat);
    const col = new THREE.Color();
    for (const bn of Object.keys(bones)) {
      const list = parts.filter(p => p.bone === bn && !p.tex);
      if (!list.length) continue;
      let n = 0;
      const geos = list.map(p => { const g = p.geo.index ? p.geo.toNonIndexed() : p.geo; if (g !== p.geo) p.geo.dispose(); n += g.attributes.position.count; return [g, p]; });
      const pos = new Float32Array(n * 3), nor = new Float32Array(n * 3), cl = new Float32Array(n * 3);
      let o = 0;
      for (const [g, p] of geos) {
        const c = p.kind === 'visorT' ? mix(p.color, '#1b2230', 0.55) : p.kind === 'lens' ? p.color : p.color;
        col.set(c);
        if (p.kind === 'metal' || p.kind === 'visorM') col.multiplyScalar(1.15);
        pos.set(g.attributes.position.array, o * 3); nor.set(g.attributes.normal.array, o * 3);
        for (let i = 0; i < g.attributes.position.count; i++) { cl[(o + i) * 3] = col.r; cl[(o + i) * 3 + 1] = col.g; cl[(o + i) * 3 + 2] = col.b; }
        o += g.attributes.position.count;
        g.dispose();
      }
      const mg = new THREE.BufferGeometry();
      mg.setAttribute('position', new THREE.BufferAttribute(pos, 3)); mg.setAttribute('normal', new THREE.BufferAttribute(nor, 3)); mg.setAttribute('color', new THREE.BufferAttribute(cl, 3));
      mg.computeBoundingSphere(); disp.push(mg);
      const mesh = new THREE.Mesh(mg, mat); mesh.name = `pilot-${bn}`; mesh.userData.heat = bn === 'head' ? 0.82 : 0.68;
      bones[bn].add(mesh);
      tris += n / 3;
    }
  }
  root.userData.bones = bones;
  root.userData.head = bones.head;
  root.userData.dims = D;
  root.userData.tris = Math.round(tris);
  root.userData.drawCalls = merged ? Object.keys(bones).filter(bn => bones[bn].children.some(c => c.isMesh)).length : null;
  root.userData.dispose = () => { for (const d of disp) { try { d.dispose(); } catch { /* */ } } };
  root.name = full ? 'sm-avatar-full' : 'sm-avatar';
  return root;
}

let drawPatchFn = null;
/** avatar_mesh.js yama çizimini kaydeder (döngüsel içe aktarma yok). */
export function setPatchDrawer(fn) { drawPatchFn = fn; }

/**
 * Uçuş sahnesi pilotu (HEPGO flightsim3d.js opts.pilot.build sözleşmesi; flightsim_pilot.js):
 * Z yukarı dünya, metre, ayak tabanı z = 0, yüz −Y yönünde (katman yaw ile döndürür). Kemikler y-yukarı karakter uzayında (yukarıdaki işaretler).
 * Dönüş: {group, bones:{body, torso, head, stickL, stickR}, eye (göz yüksekliği m), height (m), tris, drawCalls, dispose()}
 */
export function buildPilotRig(THREE, cfg, { lod = 'mid' } = {}) {
  const a = normAvatar(cfg);
  const ch = buildCharacter(THREE, a, { pose: 'full', lod, merged: true, rc: true });
  const D = ch.userData.dims, k = D.heightM / (TOP_Y - FEET_Y);
  const g = new THREE.Group(); g.name = 'sm-pilot';
  ch.rotation.x = Math.PI / 2; ch.position.z = -FEET_Y * k; ch.scale.setScalar(k);
  g.add(ch);
  const b = ch.userData.bones;
  return { group: g, bones: { body: ch, torso: b.torso, head: b.head, stickL: b.stickL, stickR: b.stickR }, eye: (HEAD_Y + 0.01 - FEET_Y) * k, height: D.heightM,
    tris: ch.userData.tris, drawCalls: ch.userData.drawCalls, dispose: ch.userData.dispose };
}
