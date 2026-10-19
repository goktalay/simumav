// three.js yükleyici ve küçük sahne yardımcısı (HEPGO vendor: /vendor/three/). CDN yok.
const LIB = '/vendor/three/';
let loading = null;
export function loadThree() {
  loading ??= Promise.all(['three.module.min.js', 'OrbitControls.js', 'GLTFLoader.js', 'RoomEnvironment.js'].map(f => import(LIB + f)))
    .then(([T, O, G, R]) => ({ THREE: T, OrbitControls: O.OrbitControls, GLTFLoader: G.GLTFLoader, RoomEnvironment: R.RoomEnvironment }));
  return loading;
}

/** Bir kapsayıcıya (ya da canvas'a) bağlı render döngüsü. onFrame(dt, t) her karede çağrılır. Görünmezken durur. */
export function makeStage(lib, host, { alpha = true, fov = 40, near = 0.05, far = 2000, env = true, onFrame, pixelRatioMax = 1.75 } = {}) {
  const { THREE, RoomEnvironment } = lib;
  const isCanvas = host instanceof HTMLCanvasElement;
  const canvas = isCanvas ? host : document.createElement('canvas');
  if (!isCanvas) host.append(canvas);
  const renderer = new THREE.WebGLRenderer({ canvas, alpha, antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, pixelRatioMax));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(fov, 1, near, far);
  if (env && RoomEnvironment) {
    const pm = new THREE.PMREMGenerator(renderer);
    scene.environment = pm.fromScene(new RoomEnvironment(), 0.04).texture;
    pm.dispose();
  }
  const size = () => {
    const w = (isCanvas ? canvas.parentElement : host)?.clientWidth || window.innerWidth;
    const hgt = (isCanvas ? canvas.parentElement : host)?.clientHeight || window.innerHeight;
    renderer.setSize(w, hgt, false);
    camera.aspect = w / Math.max(1, hgt); camera.updateProjectionMatrix();
  };
  size();
  const ro = new ResizeObserver(size); ro.observe(isCanvas ? canvas.parentElement || document.body : host);
  let raf = 0, last = performance.now(), running = false, t = 0;
  const loop = now => {
    if (!running) return;
    const dt = Math.min(0.1, (now - last) / 1000); last = now; t += dt;
    onFrame?.(dt, t);
    renderer.render(scene, camera);
    raf = requestAnimationFrame(loop);
  };
  const start = () => { if (running) return; running = true; last = performance.now(); raf = requestAnimationFrame(loop); };
  const stop = () => { running = false; cancelAnimationFrame(raf); };
  const vis = () => (document.hidden ? stop() : start());
  document.addEventListener('visibilitychange', vis);
  const dispose = () => {
    stop(); ro.disconnect(); document.removeEventListener('visibilitychange', vis);
    scene.traverse(o => { o.geometry?.dispose?.(); const m = o.material; if (m) (Array.isArray(m) ? m : [m]).forEach(x => { x.map?.dispose?.(); x.dispose?.(); }); });
    renderer.dispose(); if (!isCanvas) canvas.remove();
  };
  return { THREE, renderer, scene, camera, canvas, start, stop, dispose, resize: size, renderOnce: () => renderer.render(scene, camera) };
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
