// Parçaların 3B görünümü: G-code'dan çıkarılmış dış duvar takım yolu (sunucu: app/gcode.py → .3d.bin) Three.js ile çizilir.
// Dosya biçimi: 6 float32 (min xyz, max xyz) + segment uçları (x1 y1 z1 x2 y2 z2 …). Renk yüksekliğe göre geçişlidir.
// Tarayıcılar aynı anda sınırlı WebGL bağlamı açtığı için kartlarda tek ortak çiziciyle resim çekilir (snapshot);
// detayda ve ipucunda canlı, döndürülebilir görünüm (viewer) kullanılır. cut (0–1): o yüksekliğe kadar dolu, üstü şeffaf.
import { fileUrl } from './api.js';

const LIB = '/static/vendor/three/';
let libs;
export const loadLibs = () => (libs ??= Promise.all(['three.module.min.js', 'OrbitControls.js'].map(f => import(LIB + f))).catch(e => { libs = null; throw e; }));
const cache = new Map();   // yol → Promise<{ pos, min, max }>
const watchers = new Map();   // yol → Set<fn(oran | null)> — indirme ilerlemesi (boyut bilinmiyorsa null)

async function readWithProgress(r, report) {
  const total = +r.headers.get('content-length') || 0;
  if (!r.body || !r.body.getReader) return r.arrayBuffer();
  const reader = r.body.getReader(), parts = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value); got += value.length;
    report(total ? Math.min(1, got / total) : null);
  }
  const out = new Uint8Array(got);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out.buffer;
}

export function loadPath(path, onProgress) {
  if (onProgress) { if (!watchers.has(path)) watchers.set(path, new Set()); watchers.get(path).add(onProgress); }
  if (!cache.has(path)) {
    const report = f => watchers.get(path)?.forEach(fn => fn(f));
    cache.set(path, fetch(fileUrl(path)).then(r => { if (!r.ok) throw new Error('3B dosyası alınamadı'); return readWithProgress(r, report); }).then(buf => {
      const all = new Float32Array(buf);
      return { min: all.slice(0, 3), max: all.slice(3, 6), pos: all.subarray(6) };
    }).catch(e => { cache.delete(path); throw e; }).finally(() => watchers.delete(path)));
  }
  return cache.get(path);
}

// Yükleme göstergesi: görünüm hazır olana kadar kutunun ortasında halka; dosya boyutu biliniyorsa yüzde, yoksa sonsuz dönen halka
function showLoader(el, path) {
  if (!el || el.querySelector(':scope > .g3d-load')) return;
  const box = document.createElement('div');
  box.className = 'g3d-load';
  box.innerHTML = '<svg viewBox="0 0 44 44" aria-hidden="true"><circle class="trk" cx="22" cy="22" r="18"/><circle class="bar" cx="22" cy="22" r="18"/></svg><span></span>';
  if (getComputedStyle(el).position === 'static') el.style.position = 'relative';
  el.append(box);
  const bar = box.querySelector('.bar'), txt = box.querySelector('span'), C = 2 * Math.PI * 18;
  loadPath(path, f => {
    if (f == null) return;
    box.classList.add('det');
    bar.style.strokeDasharray = `${C}`; bar.style.strokeDashoffset = `${C * (1 - f)}`;
    txt.textContent = `%${Math.round(f * 100)}`;
  }).then(() => { txt.textContent = ''; box.classList.remove('det'); }, () => box.remove());   // indirme bitti → çizim hazırlanırken sonsuz halka
}

// Yükseklik renk geçişi: koyu mavi (alt) → turkuaz → açık (üst)
const LOW = [0.11, 0.31, 0.57], MID = [0.13, 0.62, 0.78], HIGH = [0.62, 0.9, 0.98];
function colorsFor(THREE, data) {
  // Renk yüksekliğe göre; ışık: duvar segmentinin yatay yüzey normali ile sabit ışık yönü (öne bakan yüzler aydınlık)
  const n = data.pos.length / 3, col = new Float32Array(n * 3), h = Math.max(1e-3, data.max[2] - data.min[2]);
  const lx = Math.cos(1.2), ly = Math.sin(1.2);
  for (let i = 0; i < n; i += 2) {
    const dx = data.pos[(i + 1) * 3] - data.pos[i * 3], dy = data.pos[(i + 1) * 3 + 1] - data.pos[i * 3 + 1];
    const len = Math.hypot(dx, dy) || 1;
    const shade = 0.4 + 0.7 * Math.abs((dy / len) * lx - (dx / len) * ly);
    for (const j of [i, i + 1]) {
      const t = (data.pos[j * 3 + 2] - data.min[2]) / h;
      const [a, b, k] = t < 0.5 ? [LOW, MID, t * 2] : [MID, HIGH, (t - 0.5) * 2];
      col[j * 3] = Math.min(1, (a[0] + (b[0] - a[0]) * k) * shade);
      col[j * 3 + 1] = Math.min(1, (a[1] + (b[1] - a[1]) * k) * shade);
      col[j * 3 + 2] = Math.min(1, (a[2] + (b[2] - a[2]) * k) * shade);
    }
  }
  return col;
}

// Parça nesnesi: merkezlenmiş, Z yukarı → Three'de Y yukarı; cut uniform'u ile dolu / şeffaf ayrımı
export function partObject(THREE, data, { cut = 1, faint = 0.1 } = {}) {
  const g = new THREE.BufferGeometry();
  const cx = (data.min[0] + data.max[0]) / 2, cy = (data.min[1] + data.max[1]) / 2;
  const n = data.pos.length / 3, p = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {   // (x, y, z) → (x, z, -y), tabanı 0'a oturt
    p[i * 3] = data.pos[i * 3] - cx; p[i * 3 + 1] = data.pos[i * 3 + 2] - data.min[2]; p[i * 3 + 2] = -(data.pos[i * 3 + 1] - cy);
  }
  g.setAttribute('position', new THREE.BufferAttribute(p, 3));
  g.setAttribute('color', new THREE.BufferAttribute(colorsFor(THREE, data), 3));
  const height = data.max[2] - data.min[2];
  const mat = new THREE.ShaderMaterial({
    transparent: true, depthWrite: true, vertexColors: true,
    uniforms: { cut: { value: cut * height }, faint: { value: faint }, done: { value: new THREE.Color(0x22c55e) }, useDone: { value: 0 } },
    vertexShader: 'varying float vy; varying vec3 vc; void main(){ vy = position.y; vc = color; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
    fragmentShader: `uniform float cut; uniform float faint; uniform vec3 done; uniform float useDone; varying float vy; varying vec3 vc;
      void main(){ bool solid = vy <= cut; vec3 c = solid && useDone > 0.5 ? mix(vc, done, 0.35) : vc; gl_FragColor = vec4(c, solid ? 1.0 : faint); }`,
  });
  const obj = new THREE.LineSegments(g, mat);
  obj.userData = { height, size: [data.max[0] - data.min[0], height, data.max[1] - data.min[1]] };
  obj.setCut = f => { mat.uniforms.cut.value = Math.max(0, Math.min(1, f)) * height + 0.001; mat.uniforms.useDone.value = f < 1 ? 1 : 0; };
  obj.setCut(cut);
  return obj;
}

function frame(THREE, camera, obj, margin = 0.78) {
  // Parçanın tamamı görünsün: sınırlayıcı kürenin yarıçapı ve kamera açısından uzaklık
  const [sx, sy, sz] = obj.userData.size;
  const r = 0.5 * Math.hypot(sx, sy, sz);
  const fov = (camera.fov * Math.PI) / 180;
  const dist = (r / Math.sin(fov / 2)) * margin / Math.min(1, camera.aspect);
  const dir = new THREE.Vector3(0.62, 0.42, 0.66).normalize();
  const target = [0, sy / 2, 0];
  camera.position.set(dir.x * dist, target[1] + dir.y * dist, dir.z * dist);
  camera.lookAt(...target);
  camera.near = dist / 100; camera.far = dist * 10; camera.updateProjectionMatrix();
  return target;
}

// ---------- Kart resmi (tek ortak çizici; sırayla)
let shared = null, queue = Promise.resolve();
const shots = new Map();
export function snapshot(path, w = 320, h = 240, bg = null) {
  const key = `${path}|${w}|${h}|${bg}`;
  if (shots.has(key)) return shots.get(key);
  const job = queue = queue.then(async () => {
    const [THREE] = await loadLibs();
    const data = await loadPath(path);
    shared ??= new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
    shared.setPixelRatio(Math.min(2, devicePixelRatio || 1));
    shared.setSize(w, h, false);
    shared.setClearColor(bg ?? 0x000000, bg == null ? 0 : 1);
    const scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera(35, w / h, 1, 5000);
    const obj = partObject(THREE, data);
    scene.add(obj);
    frame(THREE, camera, obj);
    shared.render(scene, camera);
    const url = shared.domElement.toDataURL('image/png');
    obj.geometry.dispose(); obj.material.dispose();
    return url;
  }).catch(() => null);
  shots.set(key, job);
  return job;
}

// Kart / liste için: resim yüklenene kadar yer tutucu; hazır olunca <img>
export function snapshotImg(path, { w = 320, h = 240, cls = 'g3d-img', alt = '' } = {}) {
  const img = document.createElement('img');
  img.className = `${cls} loading`;
  img.alt = alt;
  img.width = w; img.height = h;
  snapshot(path, w, h).then(url => { if (url) { img.src = url; img.classList.remove('loading'); } else img.classList.add('fail'); });
  return img;
}

// ---------- Canlı görünüm (detay, ipucu): fareyle döndürülür, istenirse kendiliğinden döner
export async function viewer(el, path, { autoRotate = true, interactive = true, cut = 1, bg = null } = {}) {
  showLoader(el, path);
  const [THREE, { OrbitControls }] = await loadLibs();
  const data = await loadPath(path);
  if (!el.isConnected) return { destroy() {}, setCut() {} };
  const w = el.clientWidth || 320, h = el.clientHeight || 240;
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: bg == null });
  renderer.setPixelRatio(Math.min(2, devicePixelRatio || 1));
  renderer.setSize(w, h);
  if (bg != null) renderer.setClearColor(bg, 1);
  el.replaceChildren(renderer.domElement);
  const scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera(35, w / h, 1, 5000);
  const obj = partObject(THREE, data, { cut });
  scene.add(obj);
  const target = frame(THREE, camera, obj);
  const controls = interactive ? new OrbitControls(camera, renderer.domElement) : null;
  if (controls) { controls.target.set(...target); controls.enableDamping = true; controls.autoRotate = autoRotate; controls.autoRotateSpeed = 1.6; controls.update(); }
  let raf, alive = true;
  const loop = () => {
    if (!alive) return;
    if (controls) controls.update(); else if (autoRotate) obj.rotation.y += 0.01;
    renderer.render(scene, camera);
    raf = requestAnimationFrame(loop);
  };
  loop();
  const ro = new ResizeObserver(() => {
    const W = el.clientWidth, H = el.clientHeight;
    if (W && H) { renderer.setSize(W, H); camera.aspect = W / H; camera.updateProjectionMatrix(); }
  });
  ro.observe(el);
  return {
    setCut: f => obj.setCut(f),
    destroy() { alive = false; cancelAnimationFrame(raf); ro.disconnect(); controls?.dispose(); obj.geometry.dispose(); obj.material.dispose(); renderer.dispose(); renderer.domElement.remove(); },
  };
}

// Parça bir yazıcı haznesi içinde: ilerledikçe (0..1) parça alttan yukarı dolar, tabla ve gantry çizilir (Yazıcıya Gönder ekranı).
export async function partInPrinter(el, path, { progress = 0, autoRotate = true } = {}) {
  showLoader(el, path);
  const [THREE, { OrbitControls }] = await loadLibs();
  const data = await loadPath(path);
  if (!el.isConnected) return { setProgress() {}, destroy() {} };
  const w = el.clientWidth || 360, h = el.clientHeight || 320;
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(2, devicePixelRatio || 1));
  renderer.setSize(w, h);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  el.replaceChildren(renderer.domElement);
  const scene = new THREE.Scene();
  scene.add(new THREE.HemisphereLight(0xffffff, 0x8a8f99, 1.2));
  const key = new THREE.DirectionalLight(0xffffff, 1.4); key.position.set(1.2, 2, 1.5); scene.add(key);
  const camera = new THREE.PerspectiveCamera(38, w / h, 0.01, 100);

  const part = partObject(THREE, data, { cut: progress, faint: 0.12 });
  const [sx, sy, sz] = part.userData.size;
  const C = Math.max(sx, sz, sy * 0.9) * 1.5 + 1e-3;   // hazne kenarı (parçayı rahat sarsın)
  const chamber = new THREE.Group();
  // Hazne çerçevesi (kenarlar)
  const edges = new THREE.LineSegments(
    new THREE.EdgesGeometry(new THREE.BoxGeometry(C, C, C)),
    new THREE.LineBasicMaterial({ color: 0x9aa4b2, transparent: true, opacity: 0.55 }));
  edges.position.set(0, C / 2, 0);
  chamber.add(edges);
  // Isıtmalı tabla
  const bed = new THREE.Mesh(new THREE.BoxGeometry(C * 0.92, C * 0.02, C * 0.92),
    new THREE.MeshStandardMaterial({ color: 0x2a2e35, roughness: 0.7, metalness: 0.4 }));
  bed.position.set(0, C * 0.01, 0);
  chamber.add(bed);
  // Üst çerçeve kirişi (Creality turuncu)
  const beam = new THREE.Mesh(new THREE.BoxGeometry(C, C * 0.03, C * 0.05),
    new THREE.MeshStandardMaterial({ color: 0xf26722, roughness: 0.5 }));
  beam.position.set(0, C - C * 0.02, -C * 0.45);
  chamber.add(beam);
  // Gantry (X ekseni) + nozül: baskı yüksekliğiyle yükselir
  const gantry = new THREE.Group();
  const barX = new THREE.Mesh(new THREE.BoxGeometry(C, C * 0.02, C * 0.03),
    new THREE.MeshStandardMaterial({ color: 0xf26722, roughness: 0.5 }));
  const nozzle = new THREE.Mesh(new THREE.ConeGeometry(C * 0.02, C * 0.05, 16),
    new THREE.MeshStandardMaterial({ color: 0xcfd6df, metalness: 0.8, roughness: 0.3 }));
  nozzle.rotation.x = Math.PI; nozzle.position.set(0, -C * 0.035, 0);
  gantry.add(barX, nozzle);
  chamber.add(gantry);
  part.position.set(0, C * 0.02, 0);   // tablanın üstüne otur
  chamber.add(part);
  scene.add(chamber);

  const setGantry = p => { gantry.position.set(0, C * 0.02 + Math.max(sy * Math.min(1, p), 0) + C * 0.04, 0); };
  setGantry(progress);

  // Kamera: hazneyi çerçevele
  const r = 0.5 * Math.hypot(C, C, C);
  const dist = (r / Math.sin((38 * Math.PI / 180) / 2)) * 0.82 / Math.min(1, camera.aspect);
  const dir = new THREE.Vector3(0.7, 0.5, 0.9).normalize();
  camera.position.set(dir.x * dist, C / 2 + dir.y * dist, dir.z * dist);
  camera.near = dist / 100; camera.far = dist * 10; camera.updateProjectionMatrix();
  const ctl = new OrbitControls(camera, renderer.domElement);
  ctl.target.set(0, C * 0.45, 0); ctl.enableDamping = true;
  ctl.autoRotate = autoRotate; ctl.autoRotateSpeed = 0.9;
  renderer.domElement.addEventListener('pointerdown', () => { ctl.autoRotate = false; });
  ctl.update();
  let raf, alive = true;
  const loop = () => { if (!alive) return; ctl.update(); renderer.render(scene, camera); raf = requestAnimationFrame(loop); };
  loop();
  const ro = new ResizeObserver(() => { const W = el.clientWidth, H = el.clientHeight; if (W && H) { renderer.setSize(W, H); camera.aspect = W / H; camera.updateProjectionMatrix(); } });
  ro.observe(el);
  return {
    setProgress(p) { part.setCut(Math.max(0, Math.min(1, p))); setGantry(p); },
    done() { part.setCut(1); setGantry(1); },
    destroy() { alive = false; cancelAnimationFrame(raf); ro.disconnect(); ctl.dispose(); part.geometry.dispose(); part.material.dispose(); renderer.dispose(); renderer.domElement.remove(); },
  };
}

// ---------- İpucu içindeki küçük canlı görünüm (tek örnek; yeni parçada eskisi kapanır)
let tipView = null, tipToken = 0;
export function tipPreview(host, path) {
  tipView?.destroy(); tipView = null;
  const token = ++tipToken;
  const box = document.createElement('div');
  box.className = 'g3d-tip';
  host.append(box);
  viewer(box, path, { interactive: false, autoRotate: true }).then(v => { if (token === tipToken) tipView = v; else v.destroy(); }).catch(() => box.remove());
}
export function closeTipPreview() { tipToken++; tipView?.destroy(); tipView = null; }
