// Ana menü arka planı: CANLI UÇUŞ SAHNESİ — gerçek dron modeli (GLB; yoksa prosedürel) alçak irtifada gerçek uydu dokulu arazi
// (TRTEST çevresi, /api/drone/sim terrain + karolar; ağ yoksa prosedürel) üstünde süzülür. Gün batımı ışığı, atmosferik sis, pervane,
// kanat ucu izleri + hava parçacıkları, sinematik kamera (takip → yan pan → FPV → yer → yörünge), fare parallax, motor sesi (ayar),
// kare süresine göre otomatik kalite, prefers-reduced-motion'da tek statik kare. Paylaşılan çizici (core/three.js makeStage) — bağlam açmaz.
import { loadThree, makeStage } from '../core/three.js';
import { buildDrone, animateDrone } from '../hangar/procmodels.js';
import { TERRAIN, MENU_DRONE_TYPE, modelCandidates, makeNoise, procHeight, flightPath, cameraPose, createQualityGovernor, pick, lerp, clamp } from './flightcore.js';
import * as sfx from '../ui/sfx.js';

const reduced = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const TILE = 256;

// ---------- Arazi verisi ----------
async function fetchJSON(url) { const r = await fetch(url, { credentials: 'same-origin' }); if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); }
async function bitmap(url) { const r = await fetch(url, { credentials: 'same-origin' }); if (!r.ok) throw new Error(`karo ${r.status}`); return createImageBitmap(await r.blob()); }
function lonlatToTile(lon, lat, z) { const n = 2 ** z, lr = Math.max(-85.05, Math.min(85.05, lat)) * Math.PI / 180; return [(lon + 180) / 360 * n, (1 - Math.log(Math.tan(lr) + 1 / Math.cos(lr)) / Math.PI) / 2 * n]; }
async function pool(items, n, fn) { let i = 0; await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) await fn(items[i++]); })); }

/** Gerçek arazi: { sample(x, y) m (merkez 0), uv(x, y), atlas } — hata → throw (çağıran prosedürele düşer). */
async function loadReal(signal) {
  const { lat, lon, size_m } = TERRAIN;
  const meta = await fetchJSON(`${TERRAIN.api}/terrain?lat=${lat}&lon=${lon}&size_m=${size_m}`);
  if (signal.dead) throw new Error('iptal');
  const cosLat = Math.cos(lat * Math.PI / 180);
  const toLL = (x, y) => [lat + y / 110574, lon + x / (111320 * cosLat)];
  const ext = ts => { const xs = ts.map(t => t.x), ys = ts.map(t => t.y); return { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) }; };
  const z = meta.z, tiles = meta.tiles || [], E = ext(tiles), nx = E.x1 - E.x0 + 1, ny = E.y1 - E.y0 + 1, mw = nx * TILE, mh = ny * TILE;
  const mosaic = new Float32Array(mw * mh);
  const cv = document.createElement('canvas'); cv.width = cv.height = TILE; const c2 = cv.getContext('2d', { willReadFrequently: true });
  let okN = 0;
  await pool(tiles, 6, async t => {
    try {
      const b = await bitmap(meta.elev_url_template.replace('{z}', z).replace('{x}', t.x).replace('{y}', t.y));
      c2.clearRect(0, 0, TILE, TILE); c2.drawImage(b, 0, 0); b.close?.();
      const d = c2.getImageData(0, 0, TILE, TILE).data, ox = (t.x - E.x0) * TILE, oy = (t.y - E.y0) * TILE;
      for (let py = 0; py < TILE; py++) { let s = py * TILE * 4; const o = (oy + py) * mw + ox; for (let px = 0; px < TILE; px++, s += 4) mosaic[o + px] = d[s] * 256 + d[s + 1] + d[s + 2] / 256 - 32768; }
      okN++;
    } catch { /* eksik karo */ }
  });
  if (!okN) throw new Error('yükseklik yok');
  const raw = (x, y) => {
    const [la, lo] = toLL(x, y), [fx, fy] = lonlatToTile(lo, la, z);
    const px = clamp((fx - E.x0) * TILE - 0.5, 0, mw - 1.001), py = clamp((fy - E.y0) * TILE - 0.5, 0, mh - 1.001);
    const ix = Math.floor(px), iy = Math.floor(py), ax = px - ix, ay = py - iy, i0 = iy * mw + ix, i1 = i0 + mw;
    return (mosaic[i0] * (1 - ax) + mosaic[i0 + 1] * ax) * (1 - ay) + (mosaic[i1] * (1 - ax) + mosaic[i1 + 1] * ax) * ay;
  };
  const h0 = meta.home_elev != null ? Number(meta.home_elev) : raw(0, 0);
  // uydu atlası
  const iz = meta.img_z, it = meta.img_tiles || [], I = ext(it), inx = I.x1 - I.x0 + 1, iny = I.y1 - I.y0 + 1;
  const scale = Math.min(1, 4096 / Math.max(inx, iny) / TILE), ts = TILE * scale;
  const atlas = document.createElement('canvas'); atlas.width = Math.round(inx * ts); atlas.height = Math.round(iny * ts);
  const ac = atlas.getContext('2d'); ac.fillStyle = '#3b4a3a'; ac.fillRect(0, 0, atlas.width, atlas.height);
  await pool(it, 6, async t => { try { const b = await bitmap(meta.img_url_template.replace('{z}', iz).replace('{x}', t.x).replace('{y}', t.y)); ac.drawImage(b, (t.x - I.x0) * ts, (t.y - I.y0) * ts, ts, ts); b.close?.(); } catch { /* */ } });
  if (signal.dead) throw new Error('iptal');
  const uv = (x, y) => { const [la, lo] = toLL(x, y), [fx, fy] = lonlatToTile(lo, la, iz); return [(fx - I.x0) / inx, 1 - (fy - I.y0) / iny]; };
  return { sample: (x, y) => raw(x, y) - h0, uv, atlas, real: true };
}

/** Prosedürel arazi + boyalı doku (ağ/yetki yoksa). */
function loadProc() {
  const noise = makeNoise(7), size = TERRAIN.size_m;
  const sample = (x, y) => procHeight(noise, x, y, size);
  const W = 1024, c = document.createElement('canvas'); c.width = c.height = W; const g = c.getContext('2d');
  const img = g.createImageData(W, W), d = img.data;
  for (let j = 0; j < W; j++) for (let i = 0; i < W; i++) {
    const x = (i / W - 0.5) * size, y = (0.5 - j / W) * size, h = sample(x, y), n = noise(i / 23, j / 23);
    const k = clamp((h + 40) / 300, 0, 1), rock = k > 0.75, field = n > 0.62 && k < 0.3;
    let r = 70 + k * 90 + n * 20, gg = 96 + (1 - k) * 60 + n * 25, b = 52 + k * 40;
    if (rock) { r = 120 + k * 60; gg = 112 + k * 50; b = 100 + k * 40; }
    if (field) { r = 150 + n * 40; gg = 130 + n * 30; b = 60; }
    if (Math.hypot(x, y) < 25) { r = gg = b = 90; }
    const o = (j * W + i) * 4; d[o] = r; d[o + 1] = gg; d[o + 2] = b; d[o + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  // pist: merkezden kuzeye 600 m
  g.fillStyle = '#4a4d55'; g.fillRect(W / 2 - 4, W / 2 - 110, 8, 220);
  g.fillStyle = '#d9d9d9'; for (let k = -100; k < 100; k += 16) g.fillRect(W / 2 - 0.6, W / 2 + k, 1.2, 8);
  return { sample, uv: (x, y) => [x / size + 0.5, y / size + 0.5], atlas: c, real: false };
}

// ---------- Dron ----------
async function loadDrone(lib, type) {
  const { THREE, GLTFLoader } = lib;
  for (const url of modelCandidates(type)) {
    try {
      const gltf = await new GLTFLoader().loadAsync(url);
      const sc = gltf.scene;
      sc.traverse(o => { if (o.isMesh) { o.frustumCulled = false; if (o.material) { o.material.envMapIntensity = 0.6; } } });
      const box = new THREE.Box3().setFromObject(sc), sz = box.getSize(new THREE.Vector3()), span = Math.max(sz.x, sz.y, sz.z);
      const SPAN = 8;   // görünürlük için kanat açıklığı ~8 m (menü kahramanı)
      const s = SPAN / span;
      sc.scale.setScalar(s); sc.position.sub(box.getCenter(new THREE.Vector3()).multiplyScalar(s));
      const wrap = new THREE.Group(); wrap.add(sc);
      const prop = sc.getObjectByName('prop');
      wrap.userData.props = prop ? [prop] : [];
      wrap.userData.spin = []; wrap.userData.glb = url; wrap.userData.span = SPAN;
      return wrap;
    } catch { /* sıradaki aday */ }
  }
  const g = buildDrone(THREE, null, '#38bdf8', type);   // burun +X → +Z
  g.rotation.y = -Math.PI / 2;
  const wrap = new THREE.Group(); wrap.add(g); wrap.scale.setScalar(4);
  wrap.userData.props = []; wrap.userData.spin = g.userData.spin; wrap.userData.proc = g; wrap.userData.span = 7.2;
  return wrap;
}

// Yumuşak daire dokusu (sprite/parçacık; kare görünmesin)
function softDot(THREE, size = 64, inner = 'rgba(255,255,255,1)', outer = 'rgba(255,255,255,0)') {
  const c = document.createElement('canvas'); c.width = c.height = size; const g = c.getContext('2d');
  const gr = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2); gr.addColorStop(0, inner); gr.addColorStop(0.35, inner.replace(',1)', ',.6)')); gr.addColorStop(1, outer);
  g.fillStyle = gr; g.fillRect(0, 0, size, size);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
}

// ---------- Gökyüzü (gradient küre; CDN/HDR yok) ----------
function makeSky(THREE, light) {
  const uniforms = { top: { value: new THREE.Color(pick(light, 'sky')) }, bottom: { value: new THREE.Color(pick(light, 'horizon')) }, sunDir: { value: new THREE.Vector3(-0.55, 0.12, -0.82).normalize() }, sunColor: { value: new THREE.Color(pick(light, 'sun')) }, light: { value: light ? 1 : 0 } };
  const mat = new THREE.ShaderMaterial({
    uniforms, side: THREE.BackSide, depthWrite: false, fog: false,
    vertexShader: 'varying vec3 vDir; void main(){ vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: `uniform vec3 top, bottom, sunDir, sunColor; uniform float light; varying vec3 vDir;
      void main(){ float h = clamp(vDir.y, -0.05, 1.0); float k = pow(1.0 - h, light > 0.5 ? 2.2 : 3.2);
        vec3 c = mix(top, bottom, k);
        float s = max(dot(normalize(vDir), sunDir), 0.0);
        c += sunColor * (pow(s, 600.0) * 2.2 + pow(s, 24.0) * 0.45 + pow(s, 4.0) * 0.12);
        if (vDir.y < 0.0) c = mix(c, bottom * 0.6, clamp(-vDir.y * 8.0, 0.0, 1.0));
        gl_FragColor = vec4(c, 1.0); }`,
  });
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(5200, 32, 16), mat);
  mesh.frustumCulled = false;
  return { mesh, uniforms, setLight: l => { uniforms.top.value.set(pick(l, 'sky')); uniforms.bottom.value.set(pick(l, 'horizon')); uniforms.sunColor.value.set(pick(l, 'sun')); uniforms.light.value = l ? 1 : 0; } };
}

/** Sahneyi kur. host: #stage tuvali. Dönüş { dispose, stats, ready (Promise) }. */
export function mountFlightScene(canvas, { onStatus } = {}) {
  const signal = { dead: false };
  let stage = null, dispose = () => { signal.dead = true; };
  const gov = createQualityGovernor({ start: 1 });
  const stats = { frames: 0, lastDt: 0, quality: gov.level().name, mode: '', real: null, model: '', avgMs: 0 };
  const pointer = { x: 0, y: 0, tx: 0, ty: 0 };
  const onMove = e => { pointer.tx = (e.clientX / window.innerWidth - 0.5) * 2; pointer.ty = (e.clientY / window.innerHeight - 0.5) * 2; };
  window.addEventListener('pointermove', onMove, { passive: true });

  const ready = (async () => {
    const lib = await loadThree(); const { THREE } = lib;
    if (signal.dead) return null;
    const isLight = () => document.documentElement.dataset.theme === 'light';
    // Arazi (gerçek → prosedürel) ve dron paralel
    onStatus?.('terrain');
    const [terr, drone] = await Promise.all([loadReal(signal).catch(() => loadProc()), loadDrone(lib, MENU_DRONE_TYPE)]);
    if (signal.dead) return null;
    stats.real = terr.real; stats.model = drone.userData.glb ? 'glb' : 'proc';
    const ground = (x, z) => terr.sample(x, -z);

    let flyT = 12;   // ilk kare: yolun ilginç bir noktası
    const camState = { pos: new THREE.Vector3(), look: new THREE.Vector3(), fov: 50, mode: '' };
    const tmpV = new THREE.Vector3(), lookV = new THREE.Vector3();
    stage = makeStage(lib, canvas, {
      fov: 50, near: 0.5, far: 12000, env: false, pixelRatioMax: gov.level().pixelRatio,
      onFrame: (dt, tm) => {
        stats.frames++; stats.lastDt = dt * 1000;
        if (gov.push(dt * 1000)) { stage.setPixelRatioMax(gov.level().pixelRatio); applyQuality(); }
        stats.quality = gov.level().name; stats.avgMs = gov.stats().avgMs;
        flyT += dt;
        pointer.x += (pointer.tx - pointer.x) * Math.min(1, dt * 3); pointer.y += (pointer.ty - pointer.y) * Math.min(1, dt * 3);
        step(dt, tm);
      },
    });
    const { scene, camera } = stage;
    scene.fog = new THREE.FogExp2(pick(isLight(), 'fog'), 0.00055);
    // Işık: alçak güneş (gün batımı) + gök/zemin yarımküre
    const hemi = new THREE.HemisphereLight(0xb8c4ff, 0x3a2a22, 0.55); scene.add(hemi);
    const sun = new THREE.DirectionalLight(pick(isLight(), 'sun'), 2.4); sun.position.set(-1400, 300, -2100); scene.add(sun);
    const fill = new THREE.DirectionalLight(0x6f86ff, 0.35); fill.position.set(900, 500, 1200); scene.add(fill);
    const sky = makeSky(THREE, isLight()); scene.add(sky.mesh);

    // Arazi ağı
    const { size_m: S, grid: G } = TERRAIN;
    const geo = new THREE.PlaneGeometry(S, S, G, G); geo.rotateX(-Math.PI / 2);
    const pos = geo.attributes.position, uvA = geo.attributes.uv;
    for (let i = 0; i < pos.count; i++) { const x = pos.getX(i), z = pos.getZ(i); pos.setY(i, ground(x, z)); const [u, v] = terr.uv(x, -z); uvA.setXY(i, u, v); }
    geo.computeVertexNormals();
    const tex = new THREE.CanvasTexture(terr.atlas); tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 4;
    const tmat = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.95, metalness: 0, color: isLight() ? 0xffffff : 0xcdb9b4 });
    const terrain = new THREE.Mesh(geo, tmat); scene.add(terrain);
    // Uzak halka (ufuk): düz, koyu, aynı doku kenarından devam etmek yerine sis içinde kaybolur
    const far = new THREE.Mesh(new THREE.RingGeometry(S * 0.49, S * 2.2, 48, 1), new THREE.MeshStandardMaterial({ color: 0x3a3d3a, roughness: 1 })); far.rotation.x = -Math.PI / 2; far.position.y = -6; scene.add(far);

    // Dron + ışıklar
    scene.add(drone);
    const navL = new THREE.Mesh(new THREE.SphereGeometry(0.14, 8, 8), new THREE.MeshBasicMaterial({ color: 0xff2a2a })), navR = navL.clone(); navR.material = new THREE.MeshBasicMaterial({ color: 0x2aff5a });
    const half = (drone.userData.span || 5) / 2; navL.position.set(-half, 0, -0.4); navR.position.set(half, 0, -0.4); drone.add(navL, navR);
    const dot = softDot(THREE);
    const strobe = new THREE.Sprite(new THREE.SpriteMaterial({ map: dot, color: 0xffffff, transparent: true, opacity: 0.9, depthWrite: false })); strobe.scale.setScalar(1.6); strobe.position.set(0, 0.5, -1.6); drone.add(strobe);
    // Kanat ucu izleri: zaman tabanlı (son ~1 sn), 30 Hz örnek; yatışta belirginleşir
    const TRAIL = 32, TRAIL_HZ = 30;
    const mkTrail = col => { const g = new THREE.BufferGeometry(); const a = new Float32Array(TRAIL * 3); g.setAttribute('position', new THREE.BufferAttribute(a, 3)); const l = new THREE.Line(g, new THREE.LineBasicMaterial({ color: col, transparent: true, opacity: 0.55 })); l.frustumCulled = false; l.visible = false; return { line: l, arr: a, pts: [] }; };
    const trails = [mkTrail(0x9ad8ff), mkTrail(0xc8b8ff)]; trails.forEach(t => scene.add(t.line));
    let trailAcc = 0;
    // Hava parçacıkları (toz/polen) — kamera etrafında kutu, yumuşak daire dokusu
    const PN = 600, pArr = new Float32Array(PN * 3);
    for (let i = 0; i < PN; i++) pArr.set([(Math.random() - 0.5) * 160, Math.random() * 60 - 10, (Math.random() - 0.5) * 160], i * 3);
    const pGeo = new THREE.BufferGeometry(); pGeo.setAttribute('position', new THREE.BufferAttribute(pArr, 3));
    const pMat = new THREE.PointsMaterial({ map: dot, color: 0xffd9b0, size: 0.22, transparent: true, opacity: 0.5, sizeAttenuation: true, depthWrite: false, alphaTest: 0.02 });
    const particles = new THREE.Points(pGeo, pMat); particles.frustumCulled = false; scene.add(particles);
    // Güneş parıltısı (yumuşak sprite)
    const flare = new THREE.Sprite(new THREE.SpriteMaterial({ map: softDot(THREE, 128, 'rgba(255,214,160,1)', 'rgba(255,170,90,0)'), color: 0xffffff, transparent: true, opacity: 0.55, depthWrite: false, depthTest: false })); flare.scale.setScalar(520); scene.add(flare);

    const applyQuality = () => { const q = gov.level(); pMat.opacity = 0.55 * q.particles; particles.visible = q.particles > 0; scene.fog.density = q.fog ? 0.00055 : 0.00025; };
    applyQuality();
    const applyTheme = () => { const l = isLight(); sky.setLight(l); scene.fog.color.set(pick(l, 'fog')); sun.color.set(pick(l, 'sun')); sun.intensity = l ? 3.0 : 2.4; tmat.color.set(l ? 0xffffff : 0xcdb9b4); hemi.intensity = l ? 0.9 : 0.55; pMat.color.set(l ? 0xffffff : 0xffd9b0); };
    window.addEventListener('sm:theme', applyTheme);

    const dronePos = new THREE.Vector3(), q = new THREE.Quaternion(), e = new THREE.Euler();
    let strobeT = 0;
    const engine = sfx.engine();
    function step(dt, tm) {
      // --- dron
      const p = flightPath(flyT);
      const gy = ground(p.x, p.z);
      const y = gy + p.alt;
      dronePos.set(p.x, y, p.z);
      drone.position.copy(dronePos);
      e.set(-0.04 - p.bank * 0.08, p.heading, 0, 'YXZ');   // burun hafif yukarı; sapma = heading
      drone.quaternion.setFromEuler(e);
      q.setFromAxisAngle(tmpV.set(0, 0, 1), -p.bank); drone.quaternion.multiply(q);   // yatış (yerel Z = ileri)
      // pervane
      for (const pr of drone.userData.props) pr.rotation.z += dt * 95;
      if (drone.userData.proc) animateDrone(drone.userData.proc, dt, tm);
      strobeT += dt; strobe.material.opacity = (strobeT % 1.2) < 0.08 || ((strobeT % 1.2) > 0.16 && (strobeT % 1.2) < 0.24) ? 1 : 0.05;
      // --- izler
      drone.updateMatrixWorld();
      trailAcc += dt;
      const sample = trailAcc >= 1 / TRAIL_HZ; if (sample) trailAcc = 0;
      trails.forEach((t, i) => {
        if (sample) { const s = i ? 1 : -1, wp = drone.localToWorld(new THREE.Vector3(s * half, 0, -0.6)); wp.t = flyT; t.pts.push(wp); }
        while (t.pts.length > TRAIL || (t.pts.length && flyT - t.pts[0].t > 1.1)) t.pts.shift();   // en çok ~1,1 sn iz (kare süresinden bağımsız)
        if (t.pts.length < 2) return;
        for (let k = 0; k < TRAIL; k++) { const pt = t.pts[Math.min(t.pts.length - 1, Math.max(0, k - (TRAIL - t.pts.length)))]; t.arr.set([pt.x, pt.y, pt.z], k * 3); }
        t.line.geometry.attributes.position.needsUpdate = true;
        t.line.visible = true; t.line.material.opacity = 0.12 + Math.abs(p.bank) * 0.6;
      });
      // --- kamera
      const cp = cameraPose(flyT, { x: p.x, y, z: p.z, heading: p.heading }, ground, pointer);
      const k = cp.mode !== camState.mode ? 1 : 1 - Math.exp(-dt * (cp.mode === 'fpv' ? 14 : 2.6));
      if (cp.mode !== camState.mode) { camState.mode = cp.mode; stats.mode = cp.mode; }
      camState.pos.lerp(tmpV.set(cp.pos.x, cp.pos.y, cp.pos.z), k);
      camState.look.lerp(lookV.set(cp.look.x, cp.look.y, cp.look.z), Math.min(1, k * 1.5));
      camState.fov = lerp(camState.fov, cp.fov, Math.min(1, dt * 2));
      camera.position.copy(camState.pos); camera.lookAt(camState.look);
      if (cp.mode === 'fpv') camera.rotateZ(-p.bank * 0.9);   // FPV'de ufuk yatar
      if (Math.abs(camera.fov - camState.fov) > 0.05) { camera.fov = camState.fov; camera.updateProjectionMatrix(); }
      // --- parçacıklar kamerayı izler (rüzgâr -x)
      particles.position.set(Math.round(camera.position.x / 160) * 160, 0, Math.round(camera.position.z / 160) * 160);
      particles.rotation.y += dt * 0.01;
      flare.position.copy(camera.position).addScaledVector(sky.uniforms.sunDir.value, 4000);
      // --- motor sesi (ayarlar: kapalı varsayılan) — uzaklık/kip ile düzey
      const dist = camera.position.distanceTo(dronePos);
      engine.update(dt, { rpm: 0.72 + Math.abs(p.bank) * 0.25, gain: clamp(1 - dist / 140, 0.08, 1) * (cp.mode === 'fpv' ? 1.3 : 1) });
    }

    // Reduced motion: tek kare (ilginç açı), sonra dur
    if (reduced()) { step(0.016, 0); stage.renderOnce(); } else stage.start();
    onStatus?.('ready');
    window.__smFlight = () => ({ ...stats, gov: gov.stats(), running: !!stage?.running });

    dispose = () => {
      signal.dead = true;
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('sm:theme', applyTheme);
      engine.stop();
      tex.dispose(); stage?.dispose(); stage = null;
      if (window.__smFlight) delete window.__smFlight;
    };
    return stage;
  })().catch(e => { console.warn('menü uçuş sahnesi açılamadı', e); onStatus?.('error'); return null; });

  return { ready, stats: () => ({ ...stats, gov: gov.stats() }), dispose: () => dispose() };
}
