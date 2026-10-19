// SIMUMAV › Uç — paylaşılan saydam 3B kaplama (flightsim3d.js sahnesini dışa vermez; HEPGO dosyasına dokunulmaz).
// Kendi WebGLRenderer (alpha) + sahne; kamera her karede `sim.cameraPose()` (konum + ileri + üst, ENU) ve kamera kipine göre FOV
// (flightsim3d.js: 'fpv' 78°, 'pilot' sim.getPilotFov(), diğerleri 60°) ile eşlenir. Üstüne eklenen nesneler (pilot figürü, FPV halkaları) daima
// en üstte çizilir (derinlik birleşimi yok). 2B katman: `ctx2d` (OSD okları) aynı boyutta ikinci tuval; `project(x,y,z)` → ekran px ya da null.
// Kullanım: const ov = createOverlay3D(stage, sim, T); ov.add(obj); sim.addFrameHook(() => ov.update()); ov.onDraw2d(fn(ctx, W, H)); ov.dispose().
export function createOverlay3D(stage, sim, T, opts = {}) {
  const canvas = document.createElement('canvas');
  canvas.className = 'fs-overlay3d';
  canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;pointer-events:none;z-index:1';
  const c2 = document.createElement('canvas');
  c2.className = 'fs-overlay2d';
  c2.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;pointer-events:none;z-index:2';
  stage.append(canvas, c2);
  const renderer = new T.WebGLRenderer({ canvas, alpha: true, antialias: true, premultipliedAlpha: true });
  renderer.setClearColor(0x000000, 0);
  renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
  renderer.outputColorSpace = T.SRGBColorSpace;
  const scene = new T.Scene();
  const camera = new T.PerspectiveCamera(60, 1, 0.5, 60000); camera.up.set(0, 0, 1);
  scene.add(new T.HemisphereLight(0xbfd8ff, 0x3a4a2a, 1.1));
  const sun = new T.DirectionalLight(0xfff2dc, 1.6); sun.position.set(60, -50, 90); scene.add(sun);
  const g2 = c2.getContext('2d');
  let W = 1, H = 1, dpr = 1, disposed = false;
  const resize = () => { W = canvas.clientWidth || 1; H = canvas.clientHeight || 1; dpr = Math.min(devicePixelRatio || 1, 2); renderer.setSize(W, H, false); camera.aspect = W / H; camera.updateProjectionMatrix(); c2.width = Math.round(W * dpr); c2.height = Math.round(H * dpr); };
  const ro = new ResizeObserver(resize); ro.observe(canvas); resize();
  const draws = new Set(), ticks = new Set();
  const v = new T.Vector3();
  const project = (x, y, z) => { v.set(x, y, z).project(camera); if (v.z > 1 || v.z < -1) return null; return { x: (v.x + 1) / 2 * W, y: (1 - v.y) / 2 * H, behind: false }; };
  const projectAny = (x, y, z) => { v.set(x, y, z); const d = v.clone().sub(camera.position); const behind = d.dot(camera.getWorldDirection(new T.Vector3())) < 0; v.project(camera); return { x: (v.x + 1) / 2 * W, y: (1 - v.y) / 2 * H, behind }; };
  const fovFor = () => { const m = sim?.getCamera?.(); return m === 'fpv' ? 78 : m === 'pilot' ? (sim.getPilotFov?.() ?? 120) : 60; };
  let lastT = performance.now();
  const update = () => {
    if (disposed) return;
    const now = performance.now(), dt = Math.min(0.1, (now - lastT) / 1000); lastT = now;
    const cp = sim?.cameraPose?.();
    if (cp) {
      camera.position.set(cp.x, cp.y, cp.z); camera.up.set(cp.ux, cp.uy, cp.uz); camera.lookAt(cp.x + cp.fx, cp.y + cp.fy, cp.z + cp.fz);
      const fov = fovFor(); if (camera.fov !== fov) { camera.fov = fov; camera.updateProjectionMatrix(); }
    }
    for (const fn of ticks) { try { fn(dt, now); } catch { /* kanca hatası kareyi bozmaz */ } }
    renderer.render(scene, camera);
    g2.setTransform(dpr, 0, 0, dpr, 0, 0); g2.clearRect(0, 0, W, H);
    for (const fn of draws) { try { fn(g2, W, H, { project, projectAny, camera, dt }); } catch { /* */ } }
  };
  return {
    scene, camera, renderer, canvas, canvas2d: c2, update, project, projectAny,
    add: o => scene.add(o), remove: o => scene.remove(o),
    onTick: fn => { ticks.add(fn); return () => ticks.delete(fn); },
    onDraw2d: fn => { draws.add(fn); return () => draws.delete(fn); },
    get size() { return { W, H }; },
    dispose() { disposed = true; ro.disconnect(); scene.traverse(o => { o.geometry?.dispose?.(); const ms = Array.isArray(o.material) ? o.material : (o.material ? [o.material] : []); ms.forEach(m => m.dispose?.()); }); renderer.dispose(); renderer.forceContextLoss?.(); canvas.remove(); c2.remove(); },
  };
}
