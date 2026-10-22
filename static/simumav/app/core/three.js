// three.js yükleyici + TEK paylaşılan WebGLRenderer (HEPGO vendor: /vendor/three/). CDN yok.
// Tüm küçük 3B görünümler (menü arka planı, hangar dönen model, tür seçici, parkur/ops kart mini 3B'leri, parkur editörü) tek paylaşılan
// çizici ile SIRAYLA render edilir ve her görünümün kendi 2B tuvaline kopyalanır (drawImage) — görünüm başına WebGL bağlamı AÇILMAZ.
// Böylece sayfadaki canlı bağlam sayısı: paylaşılan 1 (+ Uç sahnesi 1, + Cesium replay 1) ≤ 3; tarayıcı ~16 sınırı aşılmaz.
// Görünüm yokken (modül geçişi) paylaşılan çizici boşta kalır ve IDLE_RELEASE_MS sonra bağlamı bırakır (dispose + forceContextLoss);
// Uç sahnesi açılmadan önce `releaseShared()` ile hemen bırakılır.
const LIB = '/vendor/three/';
const IDLE_RELEASE_MS = 3000;
const MAX_DIM = 4096;
let loading = null;
export function loadThree() {
  loading ??= Promise.all(['three.module.min.js', 'OrbitControls.js', 'GLTFLoader.js', 'RoomEnvironment.js'].map(f => import(LIB + f)))
    .then(([T, O, G, R]) => ({ THREE: T, OrbitControls: O.OrbitControls, GLTFLoader: G.GLTFLoader, RoomEnvironment: R.RoomEnvironment }));
  return loading;
}

// ---------- paylaşılan çizici ----------
const views = new Set();
let shared = null, raf = 0, lastT = 0, idleTimer = 0;

function ensureShared(lib) {
  if (shared && !shared.lost) return shared;
  if (shared) hardRelease();   // bağlam tarayıcı tarafından kaybedilmiş → yeni tuval
  const { THREE, RoomEnvironment } = lib;
  const canvas = document.createElement('canvas');
  canvas.className = 'sm-gl-shared';
  const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(1);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  const me = { renderer, canvas, lib, env: null, lost: false, w: 0, h: 0 };
  canvas.addEventListener('webglcontextlost', e => { e.preventDefault(); me.lost = true; });
  me.getEnv = () => {
    if (!me.env && RoomEnvironment) {
      renderer.setScissorTest(false);
      const pm = new THREE.PMREMGenerator(renderer);
      me.env = pm.fromScene(new RoomEnvironment(), 0.04).texture;
      pm.dispose();
    }
    return me.env;
  };
  shared = me;
  return me;
}

function hardRelease() {
  if (!shared) return;
  const s = shared; shared = null;
  try { s.env?.dispose(); } catch { /* */ }
  try { s.renderer.dispose(); } catch { /* */ }
  try { s.renderer.forceContextLoss?.(); } catch { /* */ }
  for (const v of views) if (v.env) v.scene.environment = null;   // yeni çizicide yeniden üretilir
}

/** Paylaşılan WebGL bağlamını hemen bırak (Uç sahnesi öncesi). Görünümler kalır; yeniden render gerekirse çizici yeniden kurulur. */
export function releaseShared() {
  clearTimeout(idleTimer); idleTimer = 0;
  for (const v of views) v.running = false;   // kalan görünümler (olmamalı) yeni bağlam açtırmasın
  cancelAnimationFrame(raf); raf = 0;
  hardRelease();
}
/** Teşhis: {views, running, shared, w, h} */
export function sharedInfo() { return { views: views.size, running: [...views].filter(v => v.running).length, shared: !!shared && !shared.lost, w: shared?.w || 0, h: shared?.h || 0 }; }

function renderView(v, now) {
  const dt = Math.min(0.1, (now - v.last) / 1000); v.last = now; v.t += dt;
  v.onFrame?.(dt, v.t);
  if (!v.visible) return;
  const s = ensureShared(v.lib), { renderer } = s;
  if (v.env && !v.scene.environment) v.scene.environment = s.getEnv();
  const pr = Math.min(window.devicePixelRatio || 1, v.pixelRatioMax);
  const w = Math.max(1, Math.min(MAX_DIM, Math.round(v.cssW * pr))), h = Math.max(1, Math.min(MAX_DIM, Math.round(v.cssH * pr)));
  if (v.target.width !== w || v.target.height !== h) { v.target.width = w; v.target.height = h; }
  if (w > s.w || h > s.h) { s.w = Math.max(s.w, w); s.h = Math.max(s.h, h); renderer.setSize(s.w, s.h, false); }
  v.camera.aspect = w / h; v.camera.updateProjectionMatrix();
  renderer.setScissorTest(true);
  renderer.setViewport(0, 0, w, h); renderer.setScissor(0, 0, w, h);
  renderer.setClearColor(0x000000, 0); renderer.clear();
  renderer.render(v.scene, v.camera);
  renderer.setScissorTest(false);
  if (s.lost) return;
  v.ctx.clearRect(0, 0, w, h);
  try { v.ctx.drawImage(s.canvas, 0, s.h - h, w, h, 0, 0, w, h); } catch { /* bağlam kaybı anı */ }
}

function loop(now) {
  raf = 0;
  let any = false;
  for (const v of views) if (v.running) { any = true; renderView(v, now); }
  schedule(any);
}
function schedule(active = [...views].some(v => v.running)) {
  if (active && !document.hidden) {
    clearTimeout(idleTimer); idleTimer = 0;
    if (!raf) raf = requestAnimationFrame(loop);
  } else if (!idleTimer && shared) {
    idleTimer = setTimeout(() => { idleTimer = 0; if (![...views].some(v => v.running)) hardRelease(); }, IDLE_RELEASE_MS);
  }
}
if (typeof document !== 'undefined') document.addEventListener('visibilitychange', () => { if (document.hidden) { cancelAnimationFrame(raf); raf = 0; } schedule(); });

/** §25 avatar görüntü önbelleği: sahneyi paylaşılan çizici ile BİR KEZ w×h render edip yeni 2B tuvale kopyalar (görünüm kaydı yok; bağlam açılmaz —
 *  paylaşılan yoksa kurulur, sonra boşta kuralıyla bırakılır). Uç sahnesi açıkken ÇAĞRILMAMALI (avatar3d.js denetler). Dönüş: HTMLCanvasElement | null. */
export function snapshot(lib, scene, camera, w, h, { env = true } = {}) {
  const s = ensureShared(lib), { renderer } = s;
  if (s.lost) return null;
  if (env) scene.environment = s.getEnv();   // her seferinde: çizici yeniden kurulduysa eski PMREM dokusu geçersiz
  if (w > s.w || h > s.h) { s.w = Math.max(s.w, w); s.h = Math.max(s.h, h); renderer.setSize(s.w, s.h, false); }
  camera.aspect = w / h; camera.updateProjectionMatrix();
  renderer.setScissorTest(true); renderer.setViewport(0, 0, w, h); renderer.setScissor(0, 0, w, h);
  renderer.setClearColor(0x000000, 0); renderer.clear();
  renderer.render(scene, camera);
  renderer.setScissorTest(false);
  const out = document.createElement('canvas'); out.width = w; out.height = h;
  try { out.getContext('2d').drawImage(s.canvas, 0, s.h - h, w, h, 0, 0, w, h); } catch { return null; }
  schedule();
  return out;
}

/** Bir kapsayıcıya (ya da 2B tuvale) bağlı görünüm. onFrame(dt, t) her karede çağrılır. Görünmezken/ekran dışında render edilmez.
 *  Dönüş eski API ile aynı: { THREE, renderer (paylaşılan), scene, camera, canvas (2B hedef), start, stop, dispose, resize, renderOnce }. */
export function makeStage(lib, host, { fov = 40, near = 0.05, far = 2000, env = true, onFrame, pixelRatioMax = 1.75 } = {}) {
  const { THREE } = lib;
  const isCanvas = host instanceof HTMLCanvasElement;
  let target = isCanvas ? host : document.createElement('canvas');
  let ctx = target.getContext('2d');
  if (!ctx) {   // bu tuvalde daha önce WebGL bağlamı alınmış → yerine yeni tuval
    const n = document.createElement('canvas'); n.id = target.id; n.className = target.className; n.hidden = target.hidden; n.setAttribute('aria-hidden', 'true');
    target.replaceWith(n); target = n; ctx = n.getContext('2d');
  }
  if (!isCanvas) host.append(target);
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(fov, 1, near, far);
  const sizeHost = () => (isCanvas ? target.parentElement : host);
  const v = { lib, scene, camera, target, ctx, env, onFrame, pixelRatioMax, cssW: 1, cssH: 1, running: false, visible: true, last: performance.now(), t: 0 };
  const size = () => {
    const el = sizeHost();
    v.cssW = Math.max(1, el?.clientWidth || window.innerWidth); v.cssH = Math.max(1, el?.clientHeight || window.innerHeight);
    camera.aspect = v.cssW / v.cssH; camera.updateProjectionMatrix();
  };
  size();
  const ro = new ResizeObserver(size); ro.observe(sizeHost() || document.body);
  const io = typeof IntersectionObserver === 'function' ? new IntersectionObserver(es => { for (const e of es) v.visible = e.isIntersecting; }) : null;
  io?.observe(target);
  views.add(v);
  const start = () => { if (v.running) return; v.running = true; v.last = performance.now(); schedule(true); };
  const stop = () => { v.running = false; schedule(); };
  const renderOnce = () => { v.visible = true; renderView(v, performance.now()); };
  const dispose = () => {
    stop(); views.delete(v); ro.disconnect(); io?.disconnect();
    scene.traverse(o => { o.geometry?.dispose?.(); const m = o.material; if (m) (Array.isArray(m) ? m : [m]).forEach(x => { x.map?.dispose?.(); x.dispose?.(); }); });
    scene.environment = null; scene.clear();
    if (!isCanvas) target.remove(); else ctx.clearRect(0, 0, target.width, target.height);
    schedule();
  };
  // setPixelRatioMax: kalite yöneticisi (menü uçuş sahnesi) kare süresine göre çözünürlüğü düşürür/yükseltir
  const setPixelRatioMax = n => { v.pixelRatioMax = Math.max(0.4, Math.min(3, Number(n) || 1)); };
  return { THREE, get renderer() { return shared?.renderer || null; }, scene, camera, canvas: target, start, stop, dispose, resize: size, renderOnce, setPixelRatioMax, get running() { return v.running; } };
}

/** Standart üç nokta aydınlatma. */
export function lights(THREE, scene, intensity = 1) {
  scene.add(new THREE.HemisphereLight(0xcfe3ff, 0x1a2030, 0.8 * intensity));
  const key = new THREE.DirectionalLight(0xffffff, 1.6 * intensity); key.position.set(4, 6, 5); scene.add(key);
  const rim = new THREE.DirectionalLight(0x7cc4ff, 0.9 * intensity); rim.position.set(-5, 2, -4); scene.add(rim);
  return { key, rim };
}

/** Şu anki tema arka plan rengi (CSS değişkeninden). */
export const cssColor = name => getComputedStyle(document.documentElement).getPropertyValue(name).trim() || '#000';
