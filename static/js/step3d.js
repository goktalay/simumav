// STEP (.step/.stp) 3B önizleme: occt-import-js (OpenCascade WASM) ile STEP → mesh, three.js ile gösterim.
// Ağır kütüphaneler (three + ~7MB CAD çekirdeği) yalnızca bir STEP açılınca tembel yüklenir.
// Montaj görünümü: STEP içindeki parça ağacı (buildStepTree), parça seçimi/vurgusu (select), patlatma (explode 0–1).
import { loadLibs } from './gcode3d.js';   // [THREE, { OrbitControls }]
import { ENGINES, buildEngine, buildProp } from './engine3d.js';

const OCCT = '/static/vendor/occt/';
let occtPromise = null;
function loadOcct() {
  if (!occtPromise) occtPromise = import(OCCT + 'occt-import-js.js').then(m => m.default({ locateFile: n => OCCT + n }));
  return occtPromise;
}

// STEP parça anahtarı: ad (sadeleştirilmiş) — sürümler arasında aynı kalır; adsız parçada yol indeksi
export const meshKey = (name, path) => {
  const n = (name || '').trim().replace(/\s+/g, ' ');
  return n ? `n:${n.toLocaleLowerCase('tr')}` : `p:${path}`;
};

// occt sonucu → montaj ağacı. Düğüm: {key, name, path, depth, kind:'group'|'part', meshes:[idx], allMeshes:[idx…], children, parent}
// STEP içindeki alt montajlar (çocuklu düğüm) ve birden çok gövdeli düğümler (ör. "caymaz - v3 part 2": 30 mesh, her birinin adı var)
// grup olur; her gövde (mesh) kendi adıyla ayrı parça olarak gruba girer. Tek gövdeli düğüm doğrudan parçadır.
// Döner: { root, nodes: kök dışındaki tüm düğümler (ağaç sırasında), flat: yalnız yaprak parçalar }
export function buildStepTree(res) {
  const clean = s => (s || '').replace(/[\r\n]+/g, '').replace(/\s+/g, ' ').trim();   // STEP adlarında kaçan satır sonları ("ELEKTRONİK KATMA\rN")
  const meshName = i => clean(res.meshes?.[i]?.name);
  const walk = (node, path) => {
    const meshes = (node.meshes || []).slice();
    const kids = (node.children || []).map((c, i) => walk(c, path ? `${path}/${i}` : String(i)));
    const item = { name: clean(node.name), path, children: kids, meshes: [], allMeshes: [], kind: 'part' };
    if (meshes.length === 1 && !kids.length) item.meshes = meshes;
    else if (meshes.length) {   // çok gövdeli düğüm = alt montaj; gövdeler ayrı parça
      item.kind = 'group';
      meshes.forEach((mi, j) => item.children.push({ name: meshName(mi) || `${item.name || 'Grup'} · gövde ${j + 1}`, path: `${path}/m${j}`, children: [], meshes: [mi], allMeshes: [mi], kind: 'part' }));
    } else if (kids.length) item.kind = 'group';
    item.allMeshes = [...item.meshes, ...item.children.flatMap(k => k.allMeshes)];
    return item;
  };
  let root = walk(res.root || { children: [] }, '');
  root.children = root.children.filter(c => c.allMeshes.length);
  // Boş sarmalayıcı kökler (adsız kök → tek alt montaj) atlanır; en üstteki gerçek montaj kök olur
  while (!root.meshes.length && root.children.length === 1 && root.children[0].kind === 'group') root = root.children[0];
  root.name = root.name || 'Montaj'; root.depth = 0; root.parent = null; root.key = 'root';
  const nodes = [];
  const collect = n => {
    n.children = n.children.filter(c => c.allMeshes.length);
    for (const c of n.children) {
      c.key = meshKey(c.name, c.path); if (c.kind === 'group') c.key = 'g' + c.key.slice(1);
      nodes.push(c); collect(c);
    }
  };
  collect(root);
  // Aynı adlı parçalar (ör. 4 × "AT"): sıra numarasıyla benzersiz anahtar — sürümler arasında sıra aynı kaldığı sürece eşleşme korunur
  const seen = {};
  for (const p of nodes) {
    const n = (seen[p.key] = (seen[p.key] || 0) + 1);
    if (n > 1) { p.key = `${p.key}#${n}`; p.dupIndex = n; }
  }
  return reindex({ root });
}

// Ağacı yeniden dizinle: depth, parent, allMeshes (alttan üste), nodes (ağaç sırası), flat (yaprak parçalar)
export function reindex(tree) {
  const nodes = [], flat = [];
  const walk = (n, depth) => {
    n.depth = depth;
    n.allMeshes = [...n.meshes];
    for (const c of n.children) { c.parent = n; nodes.push(c); if (c.kind === 'part') flat.push(c); walk(c, depth + 1); n.allMeshes.push(...c.allMeshes); }
  };
  tree.root.parent = null; walk(tree.root, 0);
  tree.nodes = nodes; tree.flat = flat;
  return tree;
}

// Kullanıcı düzeni (design_drawings.step_tree): groups [{key:'c:…', name, parent}], parents {key: parentKey|null(kök)}, names {key: ad}
// Dosya değişmez; düzen her açılışta STEP ağacına uygulanır. Döngü ve kayıp anahtarlar sessizce atlanır.
export function applyOverlay(tree, ov) {
  tree.hidden = []; tree.hiddenMeshes = new Set();
  if (!ov) return tree;
  const byKey = new Map([['root', tree.root], ...tree.nodes.map(n => [n.key, n])]);
  for (const g of (ov.groups || [])) {
    if (!g || !g.key || byKey.has(g.key)) continue;
    const node = { key: g.key, name: g.name || 'Alt kırılım', path: '', kind: 'group', custom: true, meshes: [], allMeshes: [], children: [] };
    byKey.set(g.key, node); tree.root.children.unshift(node); node.parent = tree.root;
  }
  for (const g of (ov.groups || [])) {   // grup ebeveynleri (gruplar birbirinin içine girebilir)
    const node = byKey.get(g && g.key), parent = byKey.get(g && g.parent) || tree.root;
    if (node && node.custom && parent !== node) move(node, parent);
  }
  for (const [k, pk] of Object.entries(ov.parents || {})) {
    const node = byKey.get(k), parent = byKey.get(pk || 'root');
    if (node && parent && node !== tree.root) move(node, parent);
  }
  for (const [k, name] of Object.entries(ov.names || {})) { const n = byKey.get(k); if (n && String(name).trim()) n.name = String(name).trim(); }
  // Gizlenenler (kullanıcı "sildi"): ağaçtan ayrılır, gövdeleri sahnede görünmez; geri getirilebilsin diye liste tutulur
  tree.hidden = []; tree.hiddenMeshes = new Set();
  for (const k of (ov.hidden || [])) {
    const n = byKey.get(k); if (!n || n === tree.root) continue;
    if (n.parent) n.parent.children = n.parent.children.filter(c => c !== n);
    n.parent = null; tree.hidden.push(n);
  }
  reindex(tree);
  const nodeKeys = new Set(tree.nodes.map(n => n.key));
  for (const n of tree.hidden) { reindex({ root: n }); for (const i of n.allMeshes) tree.hiddenMeshes.add(i); }
  tree.hidden = tree.hidden.filter(n => !nodeKeys.has(n.key));
  return tree;
  function move(node, parent) {
    for (let a = parent; a; a = a.parent) if (a === node) return;   // kendi altına taşınamaz
    const old = node.parent; if (old) old.children = old.children.filter(c => c !== node);
    if (node.custom) parent.children.unshift(node); else parent.children.push(node);
    node.parent = parent;
  }
}

// STEP çözümleme: önce module worker (ana iş parçacığı kilitlenmez; ilerleme/iptal mümkün), olmazsa ana iş parçacığında occt.
// Dönen: { root, meshes: [{ name, color:[r,g,b]|null, position: Float32Array, normal: Float32Array|null, index: Uint32Array|null }] }
let worker = null, reqId = 0;
const pending = new Map();
export const stepWorkerBusy = () => pending.size > 0;   // işçi tek ve iptal edilemez: başka bir STEP çözümleniyorsa sıradaki bekler (design_preview.js bunu kullanıcıya söyler)
function getWorker() {
  if (worker) return worker;
  worker = new Worker('/static/js/step-worker.js', { type: 'module' });
  worker.onmessage = e => { const p = pending.get(e.data.id); if (!p) return; pending.delete(e.data.id); e.data.ok ? p.resolve(e.data.result) : p.reject(new Error(e.data.error || 'STEP çözümlenemedi')); };
  worker.onerror = err => { for (const p of pending.values()) p.reject(new Error('STEP işçisi hata verdi: ' + (err.message || ''))); pending.clear(); worker = null; };
  return worker;
}
// opts.params: occt ReadStepFile ayarları (ör. { linearUnit:'millimeter', linearDeflectionType:'absolute_value', linearDeflection: 2, angularDeflection: 0.6 });
// yoksa occt varsayılanı. Simülatör model dönüşümü (flightsim_models.js) üçgen sayısını sınırlamak için kaba sapma verir.
export async function parseStep(arrayBuffer, { onPhase, params = null } = {}) {
  onPhase?.('CAD çekirdeği yükleniyor…');
  try {
    const w = getWorker();
    const id = ++reqId;
    const buf = arrayBuffer.slice(0);   // işçiye aktarılır; çağıranın tamponu bozulmasın
    const res = await new Promise((resolve, reject) => { pending.set(id, { resolve, reject }); w.postMessage({ id, buffer: buf, params }, [buf]); onPhase?.('Model çözümleniyor (büyük dosyalarda 1 dk sürebilir)…'); });
    return res;
  } catch (err) {   // işçi yüklenemedi / çöktü → ana iş parçacığında dene (arayüz kısa süre kilitlenir)
    console.warn('STEP işçisi başarısız, ana iş parçacığında çözümleniyor:', err && err.message);
    onPhase?.('Model çözümleniyor (yedek yol)…');
    const occt = await loadOcct();
    const r = occt.ReadStepFile(new Uint8Array(arrayBuffer), params || null);
    if (!r || !r.success) throw new Error('STEP dosyası okunamadı');
    const strip = n => ({ name: n.name || '', meshes: (n.meshes || []).slice(), children: (n.children || []).map(strip) });
    return { root: strip(r.root || {}), meshes: (r.meshes || []).map(m => ({ name: m.name || '', color: m.color && m.color.length === 3 ? [...m.color] : null,
      position: m.attributes?.position?.array ? Float32Array.from(m.attributes.position.array) : null,
      normal: m.attributes?.normal?.array?.length ? Float32Array.from(m.attributes.normal.array) : null,
      index: m.index?.array?.length ? Uint32Array.from(m.index.array) : null })) };
  }
}

// container: boş DOM düğümü (ölçülü). src: STEP ArrayBuffer ya da parseStep sonucu. opts.onSelect(node|null), opts.overlay, opts.onPhase.
// → { root, nodes, parts, select(node), explode(0–1), fit, rebuild, silhouette, snapshot, dispose }
export async function viewStep(container, src, opts = {}) {
  const [THREE, { OrbitControls }] = await loadLibs();
  const res = src instanceof ArrayBuffer ? await parseStep(src, opts) : src;
  if (!res || !res.meshes || !res.meshes.length) throw new Error('STEP dosyası okunamadı ya da geometri yok.');
  let lastOverlay = opts.overlay || null;
  let tree = applyOverlay(buildStepTree(res), lastOverlay);

  const W = container.clientWidth || 560, H = container.clientHeight || 420;
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0xeef3fb);
  const camera = new THREE.PerspectiveCamera(45, W / H, 0.1, 1e6);
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
  renderer.setSize(W, H);
  container.appendChild(renderer.domElement);
  scene.add(new THREE.AmbientLight(0xffffff, 0.75));
  const d1 = new THREE.DirectionalLight(0xffffff, 0.8); d1.position.set(1, 1, 1); scene.add(d1);
  const d2 = new THREE.DirectionalLight(0xffffff, 0.4); d2.position.set(-1, -0.5, -1); scene.add(d2);

  const group = new THREE.Group();
  const meshObjs = [];   // index = occt mesh index
  res.meshes.forEach((mesh, i) => {
    const pos = mesh.position;
    if (!pos || !pos.length) { meshObjs[i] = null; return; }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    if (mesh.normal?.length) g.setAttribute('normal', new THREE.BufferAttribute(mesh.normal, 3));
    if (mesh.index?.length) g.setIndex(new THREE.BufferAttribute(mesh.index, 1));
    if (!mesh.normal?.length) g.computeVertexNormals();
    g.computeBoundingBox();
    const c = mesh.color && mesh.color.length === 3 ? new THREE.Color(mesh.color[0], mesh.color[1], mesh.color[2]) : new THREE.Color(0x9aa8bd);
    const m = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ color: c, metalness: 0.25, roughness: 0.65, side: THREE.DoubleSide }));
    m.userData = { idx: i, name: mesh.name || '', baseColor: c.clone(), center: g.boundingBox.getCenter(new THREE.Vector3()) };
    group.add(m); meshObjs[i] = m;
  });
  scene.add(group);
  const baseCount = res.meshes.length;   // STEP gövdeleri; motor gövdeleri bu indeksten sonra eklenir

  // Kadraj: geometriyi ortala, uzaklığı ayarla
  const box = new THREE.Box3().setFromObject(group);
  const size = box.getSize(new THREE.Vector3()), center = box.getCenter(new THREE.Vector3());
  group.position.sub(center);
  const radius = Math.max(size.x, size.y, size.z, 1) * 0.5;
  const dist = radius / Math.tan((camera.fov * Math.PI / 180) / 2) * 1.6;
  const fit = () => { camera.position.set(dist * 0.8, dist * 0.6, dist); controls.target.set(0, 0, 0); controls.update(); };
  camera.near = Math.max(dist / 1000, 0.01); camera.far = dist * 100; camera.updateProjectionMatrix();
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true; fit();

  // ---- seçim / vurgu
  let selected = null;
  const HI = new THREE.Color(0xf97316), DIM = 0.35;
  const meshesOf = part => (part ? part.allMeshes : []).map(i => meshObjs[i]).filter(Boolean);
  const paint = () => {
    const sel = new Set(meshesOf(selected).map(m => m.userData.idx));
    meshObjs.forEach(m => {
      if (!m) return;
      const on = sel.has(m.userData.idx);
      m.material.color.copy(on ? HI : m.userData.baseColor);
      m.material.emissive.setHex(on ? 0x7c2d12 : 0x000000);
      m.material.transparent = !!selected && !on; m.material.opacity = selected && !on ? DIM : 1;
      m.material.needsUpdate = true;
    });
  };
  const select = part => { selected = part || null; paint(); opts.onSelect?.(selected); };

  // ---- patlatma (hiyerarşik): alt montaj kendi merkezinden montaj merkezine göre, içindeki parçalar alt montaj merkezine göre açılır.
  // Her parça: Σ (düğüm merkezi − üst düğüm merkezi) · t · 1.5 — uzaklıklar orantılı büyür, montaj yapısı korunur.
  meshObjs.forEach(m => { if (m) m.userData.center.sub(center); });   // grup (0,0,0)'a taşındı → merkezler aynı uzaya
  const nodeCenter = new Map();
  const centerOf = n => {
    if (nodeCenter.has(n)) return nodeCenter.get(n);
    const b = new THREE.Box3();
    n.allMeshes.forEach(i => { if (meshObjs[i]) b.expandByObject(meshObjs[i]); });
    const c = b.isEmpty() ? new THREE.Vector3() : b.getCenter(new THREE.Vector3());
    nodeCenter.set(n, c); return c;
  };
  let lastT = 0, engine = null;   // engine: { spec, node, meshes:[idx] }
  const axisVec = a => { const v = new THREE.Vector3(); v[a[1]] = a[0] === '-' ? -1 : 1; return v; };
  // Burun ve yukarı ekseninden sağ el tabanı: ex = −burun (akış/kuyruk), ez = yukarı, ey = ez × ex. yaw: burnu yukarı ekseni etrafında döndürür (°, +45 = saat yönü tersi, üstten)
  const flowBasis = (noseA, upA, yaw = 0) => {
    const n = axisVec(noseA), u = axisVec(upA);
    if (Math.abs(n.dot(u)) > 0.5) u.set(0, 0, 0)[['x', 'y', 'z'].find(k => Math.abs(n[k]) < 0.5)] = 1;
    if (yaw) n.applyAxisAngle(u, yaw * Math.PI / 180);
    const ex = n.clone().multiplyScalar(-1), ez = u.clone(), ey = ez.clone().cross(ex).normalize();
    return { ex, ey, ez, nose: n, up: u };
  };
  const nodeBox = n => { const b = new THREE.Box3(); (n ? n.allMeshes : tree.root.allMeshes).forEach(i => { const m = meshObjs[i]; if (m && !m.userData.engine) { m.geometry.computeBoundingBox(); const bb = m.geometry.boundingBox.clone(); b.union(bb); } }); return b; };
  // Motor yerleşimi: spec { type, node (anahtar|null=kök), nose:'+x', up:'+z', offset:[mm], prop }. Motor yerel +X pervane → modelde −burun (arkadan itiş)
  const attachEngine = () => {
    if (!engine) return;
    const spec = engine.spec, e = ENGINES[spec.type]; if (!e) return;
    const mount = spec.node ? tree.nodes.find(n => n.key === spec.node) : null;
    const nb = nodeBox(mount || null); const c = nb.isEmpty() ? new THREE.Vector3() : nb.getCenter(new THREE.Vector3()), sz = nb.isEmpty() ? new THREE.Vector3() : nb.getSize(new THREE.Vector3());
    const { ex, ey, ez, nose } = flowBasis(spec.nose || '+x', spec.up || '+z', Number(spec.yaw) || 0);
    const R = new THREE.Matrix4().makeBasis(ex, ey, ez);   // motor yerel → model
    const half = Math.abs(sz.x * nose.x) / 2 + Math.abs(sz.y * nose.y) / 2 + Math.abs(sz.z * nose.z) / 2;   // düğümün burun yönündeki yarı boyu (yaklaşık)
    const pos = c.clone().add(ex.clone().multiplyScalar(half + 27 + e.case[0] / 2)).add(new THREE.Vector3(...(spec.offset || [0, 0, 0])));
    const M = new THREE.Matrix4().compose(pos, new THREE.Quaternion().setFromRotationMatrix(R), new THREE.Vector3(1, 1, 1));
    const node = { key: 'engine', name: `Motor: ${spec.type}`, kind: 'group', engine: true, custom: false, path: '', meshes: [], allMeshes: [], children: [], parent: tree.root };
    engine.meshes.forEach(idx => { const m = meshObjs[idx]; if (m.geometry !== m.userData.baseGeom) m.geometry.dispose(); m.geometry = m.userData.baseGeom.clone().applyMatrix4(M); m.geometry.computeBoundingBox(); m.userData.center = m.geometry.boundingBox.getCenter(new THREE.Vector3()).sub(center);
      node.children.push({ key: `engine:${m.userData.name}`, name: m.userData.name, kind: 'part', engine: true, path: '', meshes: [idx], allMeshes: [idx], children: [] }); });
    tree.root.children.push(node); reindex(tree); engine.node = node;
  };
  const index = () => {   // ağaç (yeniden) kurulunca: mesh → yaprak, düğüm merkezleri (patlatmasız konumlardan)
    attachEngine();
    const leafOf = i => tree.flat.find(p => p.meshes.includes(i)) || null;
    meshObjs.forEach(m => { if (m) { m.userData.part = leafOf(m.userData.idx); m.visible = !(tree.hiddenMeshes && tree.hiddenMeshes.has(m.userData.idx)); } });
    nodeCenter.clear(); meshObjs.forEach(m => { if (m) m.position.set(0, 0, 0); });
    centerOf(tree.root); tree.nodes.forEach(centerOf);
  };
  index();
  const explode = t => {
    lastT = t;
    const k = Math.max(0, Math.min(1, t)) * 1.5;
    meshObjs.forEach(m => {
      if (!m) return;
      const off = new THREE.Vector3();
      for (let n = m.userData.part; n && n.parent; n = n.parent) off.add(centerOf(n).clone().sub(centerOf(n.parent)).multiplyScalar(k));
      m.position.copy(off);
    });
  };

  // ---- tıklayarak parça seçme (raycast)
  const ray = new THREE.Raycaster(), ndc = new THREE.Vector2();
  let downAt = null;
  renderer.domElement.addEventListener('pointerdown', e => { downAt = [e.clientX, e.clientY]; });
  renderer.domElement.addEventListener('pointerup', e => {
    if (!downAt || Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]) > 5) return;
    const r = renderer.domElement.getBoundingClientRect();
    ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    ray.setFromCamera(ndc, camera);
    const hit = ray.intersectObjects(meshObjs.filter(m => m && m.visible), false)[0];
    if (!hit) { select(null); return; }
    select(hit.object.userData.part || null);
  });

  let raf = null, alive = true;
  const tick = () => { if (!alive) return; controls.update(); renderer.render(scene, camera); raf = requestAnimationFrame(tick); };
  tick();
  const onResize = () => { const w = container.clientWidth || W, hh = container.clientHeight || H; camera.aspect = w / hh; camera.updateProjectionMatrix(); renderer.setSize(w, hh); };
  window.addEventListener('resize', onResize);

  // Siluet (CFD kesiti): düğümün (ya da tüm montajın) üçgenleri eksen boyunca düzleme izdüşürülüp cols×rows ızgaraya rasterlenir.
  // axis: 'z' üstten (u=x, v=y) · 'y' önden (u=x, v=z) · 'x' yandan (u=y, v=z). Dönen: { mask: Uint8Array(cols*rows), bbox, fill }
  // Cisim ızgarada yatayda box.x0..x1, düşeyde ortalanır (oran korunur); flip: akış yönü ters (u aynalanır).
  const silhouette = (node, axis = 'z', cols = 240, rows = 120, { x0 = 0.22, x1 = 0.62, flip = false } = {}) => {
    const n = node || tree.root;
    const ax = { x: [1, 2], y: [0, 2], z: [0, 1] }[axis] || [0, 1];
    const tris = [];
    let umin = Infinity, umax = -Infinity, vmin = Infinity, vmax = -Infinity;
    for (const i of n.allMeshes) {
      const m = meshObjs[i]; if (!m) continue;
      const pos = m.geometry.attributes.position.array, idx = m.geometry.index ? m.geometry.index.array : null, cnt = idx ? idx.length : pos.length / 3;
      const pts = new Float32Array(cnt * 2);
      for (let k = 0; k < cnt; k++) {
        const vi = (idx ? idx[k] : k) * 3;
        const u = pos[vi + ax[0]], v = pos[vi + ax[1]];
        pts[k * 2] = u; pts[k * 2 + 1] = v;
        if (u < umin) umin = u; if (u > umax) umax = u; if (v < vmin) vmin = v; if (v > vmax) vmax = v;
      }
      tris.push(pts);
    }
    const mask = new Uint8Array(cols * rows);
    if (!tris.length || umin === Infinity) return { mask, bbox: null, fill: 0 };
    const du = umax - umin || 1, dv = vmax - vmin || 1;
    const sx = (x1 - x0) * cols / du;   // ölçek: cisim genişliği → (x1−x0)·cols hücre; düşeyde aynı ölçek, en çok rows·0.8
    const s = Math.min(sx, rows * 0.8 / dv);
    const w = du * s, hgt = dv * s, ox = x0 * cols + ((x1 - x0) * cols - w) / 2, oy = (rows - hgt) / 2;
    const U = u => { const c = ox + (u - umin) * s; return flip ? ox + w - (c - ox) : c; };
    const V = v => oy + (vmax - v) * s;   // ekran: yukarı = +v
    for (const pts of tris) {
      for (let k = 0; k < pts.length; k += 6) {
        const ax0 = U(pts[k]), ay0 = V(pts[k + 1]), bx = U(pts[k + 2]), by = V(pts[k + 3]), cx = U(pts[k + 4]), cy = V(pts[k + 5]);
        const minx = Math.max(0, Math.floor(Math.min(ax0, bx, cx))), maxx = Math.min(cols - 1, Math.ceil(Math.max(ax0, bx, cx)));
        const miny = Math.max(0, Math.floor(Math.min(ay0, by, cy))), maxy = Math.min(rows - 1, Math.ceil(Math.max(ay0, by, cy)));
        if (maxx - minx <= 1 && maxy - miny <= 1) {   // hücreden küçük üçgen: ağırlık merkezi
          const gx = Math.floor((ax0 + bx + cx) / 3), gy = Math.floor((ay0 + by + cy) / 3);
          if (gx >= 0 && gx < cols && gy >= 0 && gy < rows) mask[gy * cols + gx] = 1;
          continue;
        }
        const det = (bx - ax0) * (cy - ay0) - (cx - ax0) * (by - ay0); if (Math.abs(det) < 1e-9) continue;
        for (let y = miny; y <= maxy; y++) for (let x = minx; x <= maxx; x++) {
          const px = x + 0.5, py = y + 0.5;
          const l1 = ((bx - px) * (cy - py) - (cx - px) * (by - py)) / det, l2 = ((cx - px) * (ay0 - py) - (ax0 - px) * (cy - py)) / det, l3 = 1 - l1 - l2;
          if (l1 >= -1e-6 && l2 >= -1e-6 && l3 >= -1e-6) mask[y * cols + x] = 1;
        }
      }
    }
    let fill = 0; for (let i = 0; i < mask.length; i++) fill += mask[i];
    return { mask, bbox: { umin, umax, vmin, vmax, width: du, height: dv }, fill, cell: 1 / s };   // cell: bir hücrenin model birimi (mm) karşılığı
  };

  // Düzeni yeniden uygula (alt kırılım ekleme/taşıma/ad); seçim anahtara göre korunur, patlatma yeniden hesaplanır
  const rebuild = overlay => {
    const selKey = selected && selected.key;
    lastOverlay = overlay || null;
    tree = applyOverlay(buildStepTree(res), overlay);
    index(); explode(lastT);
    selected = selKey ? (tree.nodes.find(n => n.key === selKey) || null) : null; paint();
    return tree;
  };

  return {
    get tree() { return tree; }, get root() { return tree.root; }, get nodes() { return tree.nodes; }, get parts() { return tree.flat; }, get hidden() { return tree.hidden || []; },
    select, explode, fit, rebuild, silhouette, resize: onResize, parsed: res,
    // Motor ekle/kaldır (spec null → kaldır). Gövdeler sahneye eklenir, ağaçta "Motor: …" grubu olur, STL/kesit/patlatmaya girer.
    setEngine(spec) {
      if (engine) { engine.meshes.forEach(i => { const m = meshObjs[i]; if (m) { group.remove(m); m.geometry.dispose(); m.material.dispose(); } }); meshObjs.length = baseCount; engine = null; }
      if (spec && ENGINES[spec.type]) {
        const parts = [...buildEngine(THREE, spec.type), ...(spec.prop ? buildProp(THREE, spec.type) : [])];
        engine = { spec: { ...spec }, meshes: [], node: null };
        parts.forEach(p => {
          const m = new THREE.Mesh(p.geometry.clone(), new THREE.MeshStandardMaterial({ color: p.color, metalness: 0.5, roughness: 0.5 }));
          m.userData = { idx: meshObjs.length, name: p.name, engine: true, baseColor: new THREE.Color(p.color), baseGeom: p.geometry, center: new THREE.Vector3() };
          engine.meshes.push(meshObjs.length); meshObjs.push(m); group.add(m);
        });
      }
      tree = applyOverlay(buildStepTree(res), lastOverlay); index(); explode(lastT); paint();
      return engine ? engine.node : null;
    },
    get engine() { return engine ? engine.spec : null; },
    engineInfo(type) { return ENGINES[type] || null; },
    get engines() { return Object.entries(ENGINES).map(([k, v]) => ({ key: k, label: v.label, weight_g: v.weight_g, cc: v.cc, power_kw: v.power_kw })); },
    // STL dışa aktarma (CFD): görünür gövdeler (ya da düğümün gövdeleri), model ekseni → akış ekseni dönüşümü, metre.
    // nose: burun yönü (model ekseni '+x'…'-z'; hava burundan kuyruğa akar → burun durum uzayında −x'e bakar), up: yukarı ekseni → +z,
    // aoa: hücum açısı (derece, burun yukarı +), scale: model birimi → metre (STEP mm → 0.001). Döner: { buffer (binary STL), triangles, bbox }
    exportStl(node, { nose = '+x', up = '+z', aoa = 0, yaw = 0, scale = 0.001, includeEngine = true } = {}) {
      const { ex, ey, ez } = flowBasis(nose, up, Number(yaw) || 0);   // durum: x = akış (kuyruk), z = yukarı, y = sağ el; yaw: burun yatayda döndürülmüş
      const m = new THREE.Matrix4().makeBasis(ex, ey, ez).transpose();   // model → durum (satırlar = yeni eksenler)
      const pitch = new THREE.Matrix4().makeRotationY(aoa * Math.PI / 180);   // R_y(+α): burun (−x,0,0) → (−cosα, 0, sinα) = burun yukarı
      const M = new THREE.Matrix4().multiplyMatrices(pitch, m);
      const list = (node ? node.allMeshes : tree.root.allMeshes).map(i => meshObjs[i]).filter(mm => mm && mm.visible && (includeEngine || !mm.userData.engine));
      let count = 0; list.forEach(mm => { count += mm.geometry.index ? mm.geometry.index.count / 3 : mm.geometry.attributes.position.count / 3; });
      const buf = new ArrayBuffer(84 + count * 50), dv = new DataView(buf);
      new Uint8Array(buf, 0, 80).set(new TextEncoder().encode('HEPGO STEP->STL flow+x up+z meters').subarray(0, 80));
      dv.setUint32(80, count, true);
      let off = 84; const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), nn = new THREE.Vector3();
      const mn = new THREE.Vector3(Infinity, Infinity, Infinity), mx = new THREE.Vector3(-Infinity, -Infinity, -Infinity);
      for (const mm of list) {
        const pos = mm.geometry.attributes.position.array, idx = mm.geometry.index ? mm.geometry.index.array : null, tri = idx ? idx.length / 3 : pos.length / 9;
        for (let t = 0; t < tri; t++) {
          const i0 = (idx ? idx[t * 3] : t * 3) * 3, i1 = (idx ? idx[t * 3 + 1] : t * 3 + 1) * 3, i2 = (idx ? idx[t * 3 + 2] : t * 3 + 2) * 3;
          a.set(pos[i0], pos[i0 + 1], pos[i0 + 2]).applyMatrix4(M).multiplyScalar(scale);
          b.set(pos[i1], pos[i1 + 1], pos[i1 + 2]).applyMatrix4(M).multiplyScalar(scale);
          c.set(pos[i2], pos[i2 + 1], pos[i2 + 2]).applyMatrix4(M).multiplyScalar(scale);
          nn.copy(b).sub(a).cross(c.clone().sub(a)).normalize();
          dv.setFloat32(off, nn.x, true); dv.setFloat32(off + 4, nn.y, true); dv.setFloat32(off + 8, nn.z, true); off += 12;
          for (const v of [a, b, c]) { dv.setFloat32(off, v.x, true); dv.setFloat32(off + 4, v.y, true); dv.setFloat32(off + 8, v.z, true); off += 12; mn.min(v); mx.max(v); }
          dv.setUint16(off, 0, true); off += 2;
        }
      }
      return { buffer: buf, triangles: count, bbox: count ? { min: mn.toArray(), max: mx.toArray(), size: mx.clone().sub(mn).toArray() } : null };
    },
    // Küçük döner görünüm (karşılaştırma penceresi): düğümün gövdeleri ayrı bir sahnede, kendi etrafında döner. → { dispose }
    miniView(el, node, { color = 0xf97316 } = {}) {
      const w = el.clientWidth || 200, hh = el.clientHeight || 160;
      const r2 = new THREE.WebGLRenderer({ antialias: true, alpha: true });
      r2.setPixelRatio(Math.min(devicePixelRatio || 1, 2)); r2.setSize(w, hh); el.replaceChildren(r2.domElement);
      const sc = new THREE.Scene(), cam = new THREE.PerspectiveCamera(35, w / hh, 0.01, 1e6);
      sc.add(new THREE.AmbientLight(0xffffff, 0.8)); const l = new THREE.DirectionalLight(0xffffff, 0.9); l.position.set(1, 1.2, 1); sc.add(l);
      const grp = new THREE.Group();
      (node ? node.allMeshes : []).forEach(i => { const m = meshObjs[i]; if (m) grp.add(new THREE.Mesh(m.geometry, new THREE.MeshStandardMaterial({ color, metalness: 0.2, roughness: 0.6, side: THREE.DoubleSide }))); });
      const bb = new THREE.Box3().setFromObject(grp), sz = bb.getSize(new THREE.Vector3()), ce = bb.getCenter(new THREE.Vector3());
      grp.position.sub(ce); sc.add(grp);
      const rad = Math.max(sz.x, sz.y, sz.z, 1) * 0.5, d = rad / Math.tan((cam.fov * Math.PI / 180) / 2) * 1.5;
      cam.position.set(d * 0.7, d * 0.5, d); cam.lookAt(0, 0, 0); cam.near = d / 500; cam.far = d * 50; cam.updateProjectionMatrix();
      let on = true, id = null;
      const loop = () => { if (!on) return; grp.rotation.y += 0.012; r2.render(sc, cam); id = requestAnimationFrame(loop); };
      loop();
      return { dispose() { on = false; if (id) cancelAnimationFrame(id); grp.traverse(o => o.material?.dispose?.()); r2.dispose(); r2.domElement.remove(); } };
    },
    // PNG önizleme (montaj kartı): o anki kadraj; patlatma/seçim olmadan çekmek için önce select(null), explode(0)
    snapshot(w = 480, hgt = 360) {
      const c = document.createElement('canvas'); c.width = w; c.height = hgt;
      renderer.render(scene, camera);
      c.getContext('2d').drawImage(renderer.domElement, 0, 0, w, hgt);
      return c.toDataURL('image/png');
    },
    get selected() { return selected; },
    dispose() {
      alive = false; if (raf) cancelAnimationFrame(raf);
      window.removeEventListener('resize', onResize);
      try { group.traverse(o => { o.geometry?.dispose?.(); o.material?.dispose?.(); }); renderer.dispose(); renderer.domElement.remove(); } catch { /* */ }
    },
  };
}

export const isStep = name => /\.(step|stp)$/i.test(name || '');
