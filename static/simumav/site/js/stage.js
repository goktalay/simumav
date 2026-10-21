// SIMUMAV tanıtım sitesi — TEK WebGL bağlamı + GLB model hazırlayıcı.
// Sayfadaki tüm 3B görünümler (açılış sinematiği, Hangar galerisi karoları, büyütülmüş model) tek paylaşılan WebGLRenderer ile
// SIRAYLA render edilir ve her görünümün kendi 2B tuvaline kopyalanır (drawImage) — görünüm başına bağlam AÇILMAZ (oyun kabuğu
// /app/core/three.js ile aynı ilke). window.__smSiteGl() → açılan bağlam sayısı (Playwright doğrulaması: ≤ 1).
// three.js vendor'dan (CDN yok).
import * as THREE from '/vendor/three/three.module.min.js';
import { GLTFLoader } from '/vendor/three/GLTFLoader.js';
import { RoomEnvironment } from '/vendor/three/RoomEnvironment.js';

export { THREE };
const MAX_DIM = 4096;
let shared = null, created = 0;
globalThis.__smSiteGl = () => created - (shared?.lost ? 1 : 0);

function ensure() {
  if (shared && !shared.lost) return shared;
  const canvas = document.createElement('canvas');
  const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true, powerPreference: 'high-performance' });
  created++;
  renderer.setPixelRatio(1);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  const me = { renderer, canvas, w: 0, h: 0, env: null, lost: false };
  canvas.addEventListener('webglcontextlost', e => { e.preventDefault(); me.lost = true; created--; });
  shared = me;
  return me;
}

/** Stüdyo yansıma ortamı (PMREM RoomEnvironment) — bir kez üretilir. */
export function studioEnv() {
  const s = ensure();
  if (!s.env) {
    const pm = new THREE.PMREMGenerator(s.renderer);
    s.env = pm.fromScene(new RoomEnvironment(), 0.04).texture;
    pm.dispose();
  }
  return s.env;
}

/**
 * scene/camera'yı 2B tuvale (ctx) render et. cssW/cssH: görünüm CSS boyutu; pr: piksel oranı üst sınırı.
 * { shadows, exposure } çizici ayarları her çağrıda uygulanır (görünümler farklı ayar isteyebilir).
 */
export function renderTo(ctx, cssW, cssH, scene, camera, { pr = 1.5, shadows = false, exposure = 1.05 } = {}) {
  const s = ensure(), r = s.renderer;
  if (s.lost) return false;
  const p = Math.min(window.devicePixelRatio || 1, pr);
  const w = Math.max(1, Math.min(MAX_DIM, Math.round(cssW * p))), h = Math.max(1, Math.min(MAX_DIM, Math.round(cssH * p)));
  const cv = ctx.canvas;
  if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
  if (w > s.w || h > s.h) { s.w = Math.max(s.w, w); s.h = Math.max(s.h, h); r.setSize(s.w, s.h, false); }
  camera.aspect = w / h; camera.updateProjectionMatrix();
  r.shadowMap.enabled = shadows; r.toneMappingExposure = exposure;
  r.setScissorTest(true); r.setViewport(0, 0, w, h); r.setScissor(0, 0, w, h);
  r.setClearColor(0x000000, 0); r.clear();
  r.render(scene, camera);
  r.setScissorTest(false);
  ctx.clearRect(0, 0, w, h);
  try { ctx.drawImage(s.canvas, 0, s.h - h, w, h, 0, 0, w, h); } catch { return false; }
  return true;
}

// ---------- GLB modelleri ----------
const cache = new Map();
const loader = new GLTFLoader();
const PROP_RE = /prop|propeller|rotor|pervane/i;

/** GLB'yi bir kez indirir (önbellek); her çağrı bağımsız bir klon + pervane listesi döndürür. */
export function loadGlb(url) {
  if (!cache.has(url)) cache.set(url, new Promise((res, rej) => loader.load(url, g => res(g.scene), undefined, rej)).catch(e => { cache.delete(url); throw e; }));
  return cache.get(url);
}

/**
 * Filo kaydı (fleet.js) → { root, props, length } hazır model: burun +X, yukarı +Y, merkezde, en uzun boyutu `fit` birim.
 * Pervaneler: PROP_RE adlı en üst düğümler; düğüm kendi göbeğinde dönmüyorsa (GLB'lerde geometri model uzayında) sınır kutusu
 * merkezine pivot eklenir; dönüş ekseni = pervanenin en ince boyutu (disk normali). Hafif saydam bulanıklık diski eklenir.
 */
export async function prepareModel(entry, { fit = 3, shadows = false } = {}) {
  const src = await loadGlb(entry.url);
  const model = src.clone(true);
  model.traverse(o => {
    if (o.isMesh) {
      o.castShadow = shadows; o.receiveShadow = false;
      o.material = Array.isArray(o.material) ? o.material.map(m => m.clone()) : o.material.clone();
    }
  });
  const orient = new THREE.Group();
  if (entry.nose === 'z') orient.rotation.y = Math.PI / 2;   // CAYMAZ: burun +Z → +X (Ry(+90°): +Z → +X, sol +X → -Z)
  orient.add(model);
  const root = new THREE.Group(); root.add(orient);
  root.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(root), size = box.getSize(new THREE.Vector3()), c = box.getCenter(new THREE.Vector3());
  const k = fit / Math.max(size.x, size.y, size.z, 1e-6);
  orient.position.set(-c.x, -c.y, -c.z);
  const outer = new THREE.Group(); outer.add(root); root.scale.setScalar(k);
  outer.updateMatrixWorld(true);
  return { root: outer, props: findProps(model), length: size.x * k, height: size.y * k };
}

function findProps(model) {
  const tops = [];
  model.traverse(n => {
    if (!PROP_RE.test(n.name || '')) return;
    for (let a = n.parent; a && a !== model; a = a.parent) if (PROP_RE.test(a.name || '')) return;
    tops.push(n);
  });
  const out = [];
  const inv = new THREE.Matrix4(), m = new THREE.Matrix4(), b = new THREE.Box3(), tmp = new THREE.Box3();
  for (const n of tops) {
    if (!n.parent) continue;
    n.updateMatrixWorld(true);
    inv.copy(n.matrixWorld).invert();
    b.makeEmpty();
    n.traverse(o => {
      if (!o.isMesh || !o.geometry) return;
      o.geometry.computeBoundingBox?.();
      tmp.copy(o.geometry.boundingBox).applyMatrix4(m.multiplyMatrices(inv, o.matrixWorld));
      b.union(tmp);
    });
    if (b.isEmpty()) continue;
    const sz = b.getSize(new THREE.Vector3()), ctr = b.getCenter(new THREE.Vector3());
    const axis = new THREE.Vector3(sz.x <= sz.y && sz.x <= sz.z ? 1 : 0, sz.y < sz.x && sz.y <= sz.z ? 1 : 0, sz.z < sz.x && sz.z < sz.y ? 1 : 0);
    const thin = Math.min(sz.x, sz.y, sz.z), wide = Math.max(sz.x, sz.y, sz.z);
    if (wide <= 0 || thin / wide > 0.6) continue;   // disk değil (gövde parçası adı eşleşmiş) → döndürme
    // pivot: düğümün ebeveyn uzayında, sınır kutusu merkezinde
    const pivot = new THREE.Group();
    pivot.position.copy(ctr).multiply(n.scale).applyQuaternion(n.quaternion).add(n.position);
    pivot.quaternion.copy(n.quaternion); pivot.scale.copy(n.scale);
    n.parent.add(pivot);
    n.position.set(-ctr.x, -ctr.y, -ctr.z); n.quaternion.identity(); n.scale.set(1, 1, 1);
    pivot.add(n);
    const r = wide / 2;
    const disc = new THREE.Mesh(new THREE.CircleGeometry(r, 28), new THREE.MeshBasicMaterial({ color: 0x8a94a4, transparent: true, opacity: 0.035, side: THREE.DoubleSide, depthWrite: false }));
    disc.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), axis);
    pivot.add(disc);
    out.push({ pivot, axis, q0: pivot.quaternion.clone(), dir: out.length % 2 ? -1 : 1 });
  }
  return out;
}

const qSpin = new THREE.Quaternion();
/** Pervaneleri döndür (açı rad). */
export function spinProps(props, angle) {
  for (const p of props) { qSpin.setFromAxisAngle(p.axis, angle * p.dir); p.pivot.quaternion.copy(p.q0).multiply(qSpin); }
}

export const prefersReduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
export const isSmall = () => matchMedia('(max-width: 760px), (pointer: coarse)').matches;
