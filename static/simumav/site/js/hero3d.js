// SIMUMAV açılış sahnesi — prosedürel 3B: alacakaranlık arazi, yıldızlar, uçan dron, ışık izleri, parçacık akışı.
// three.js vendor'dan (CDN yok). Dışa aktarım: startHero(canvas, {reduced}) → {stop}
import * as THREE from '/vendor/three/three.module.min.js';

const PERIOD = 400;            // arazi periyodu (kamera -PERIOD ilerleyince sahne aynı → sonsuz uçuş)
const CYAN = 0x19e6d2, AMBER = 0xffb347;

function noiseH(x, z) {        // periyodik yükseklik (PERIOD'a tam bölünen frekanslar)
  const k = Math.PI * 2 / PERIOD;
  return 6 * Math.sin(x * k * 2 + 1.3) * Math.cos(z * k * 3)
       + 3.5 * Math.sin(x * k * 5 + z * k * 2) + 2 * Math.cos(x * k * 9 - z * k * 7 + .7)
       + 1.2 * Math.sin(x * k * 17 + z * k * 13) + 14 * Math.max(0, Math.sin(x * k) * Math.cos(z * k * 2));
}

function makeTerrain() {
  const seg = 140, size = PERIOD * 2;
  const geo = new THREE.PlaneGeometry(size, size, seg, seg);
  geo.rotateX(-Math.PI / 2);
  const pos = geo.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), z = pos.getZ(i);
    const valley = Math.min(1, Math.abs(x) / 70);      // ortada uçuş koridoru: vadi
    pos.setY(i, noiseH(x, z) * (0.35 + 0.65 * valley) - 6);
  }
  geo.computeVertexNormals();
  const g = new THREE.Group();
  g.add(new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: 0x0a1626, roughness: .95, metalness: .05, flatShading: true })));
  const wire = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: CYAN, wireframe: true, transparent: true, opacity: .11 }));
  wire.position.y = .15;
  g.add(wire);
  return g;
}

function makeStars() {
  const n = 1400, a = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const r = 500 + Math.random() * 300, th = Math.random() * Math.PI * 2, ph = Math.random() * Math.PI * .5;
    a[i * 3] = r * Math.cos(th) * Math.cos(ph); a[i * 3 + 1] = 20 + r * Math.sin(ph); a[i * 3 + 2] = r * Math.sin(th) * Math.cos(ph) - 200;
  }
  const geo = new THREE.BufferGeometry(); geo.setAttribute('position', new THREE.BufferAttribute(a, 3));
  return new THREE.Points(geo, new THREE.PointsMaterial({ color: 0xcfe3ff, size: 1.6, sizeAttenuation: true, transparent: true, opacity: .85 }));
}

function makeDrone() {
  const g = new THREE.Group();
  const dark = new THREE.MeshStandardMaterial({ color: 0x0f1d33, roughness: .5, metalness: .6, emissive: 0x071423 });
  const neon = new THREE.MeshBasicMaterial({ color: CYAN });
  const body = new THREE.Mesh(new THREE.BoxGeometry(2.4, .5, 1.2), dark); g.add(body);
  const nose = new THREE.Mesh(new THREE.ConeGeometry(.5, 1.2, 4), dark); nose.rotation.z = -Math.PI / 2; nose.position.x = 1.6; g.add(nose);
  const rotors = [];
  for (const [x, z] of [[-1.9, -1.9], [1.9, -1.9], [-1.9, 1.9], [1.9, 1.9]]) {
    const arm = new THREE.Mesh(new THREE.CylinderGeometry(.09, .09, Math.hypot(x, z), 6), dark);
    arm.position.set(x / 2, 0, z / 2); arm.rotation.z = Math.PI / 2; arm.rotation.y = -Math.atan2(z, x); g.add(arm);
    const ring = new THREE.Mesh(new THREE.TorusGeometry(.9, .06, 6, 28), neon); ring.rotation.x = Math.PI / 2; ring.position.set(x, .15, z); g.add(ring);
    const disc = new THREE.Mesh(new THREE.CircleGeometry(.85, 24), new THREE.MeshBasicMaterial({ color: CYAN, transparent: true, opacity: .12, side: THREE.DoubleSide }));
    disc.rotation.x = -Math.PI / 2; disc.position.set(x, .15, z); g.add(disc);
    const blade = new THREE.Mesh(new THREE.BoxGeometry(1.6, .03, .12), new THREE.MeshBasicMaterial({ color: 0xbfffff, transparent: true, opacity: .7 }));
    blade.position.set(x, .18, z); g.add(blade); rotors.push(blade);
  }
  const nav = [];
  for (const [x, z, c] of [[-1.9, -1.9, AMBER], [1.9, -1.9, AMBER], [-1.9, 1.9, 0x44ff88], [1.9, 1.9, 0x44ff88]]) {
    const l = new THREE.Mesh(new THREE.SphereGeometry(.12, 8, 8), new THREE.MeshBasicMaterial({ color: c })); l.position.set(x, .35, z); g.add(l); nav.push(l);
  }
  g.add(new THREE.PointLight(CYAN, 6, 30));
  g.scale.setScalar(1.35);
  return { group: g, rotors, nav };
}

class Trail {   // dron arkasında sönen ışık izi
  constructor(scene, color, n = 70) {
    this.n = n; this.pos = new Float32Array(n * 3); this.col = new Float32Array(n * 3);
    const c = new THREE.Color(color);
    for (let i = 0; i < n; i++) { const f = 1 - i / n; this.col.set([c.r * f, c.g * f, c.b * f], i * 3); }
    this.geo = new THREE.BufferGeometry();
    this.geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    this.geo.setAttribute('color', new THREE.BufferAttribute(this.col, 3));
    this.line = new THREE.Line(this.geo, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: .9, blending: THREE.AdditiveBlending }));
    this.line.frustumCulled = false; scene.add(this.line); this.first = true;
  }
  push(v) {
    if (this.first) { for (let i = 0; i < this.n; i++) this.pos.set([v.x, v.y, v.z], i * 3); this.first = false; }
    this.pos.copyWithin(3, 0, (this.n - 1) * 3); this.pos.set([v.x, v.y, v.z], 0);
    this.geo.attributes.position.needsUpdate = true;
  }
}

function makeParticles() {   // rüzgâr / hız çizgileri: kameraya doğru akan noktalar
  const n = 600, a = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) a.set([(Math.random() - .5) * 120, Math.random() * 40 - 5, -Math.random() * 300], i * 3);
  const geo = new THREE.BufferGeometry(); geo.setAttribute('position', new THREE.BufferAttribute(a, 3));
  return new THREE.Points(geo, new THREE.PointsMaterial({ color: CYAN, size: .5, transparent: true, opacity: .35, blending: THREE.AdditiveBlending }));
}

export function startHero(canvas, { reduced = false } = {}) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
  renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 1.1;
  const scene = new THREE.Scene();
  scene.fog = new THREE.FogExp2(0x0a0f24, 0.0075);
  const camera = new THREE.PerspectiveCamera(55, 1, .1, 1200);

  scene.add(new THREE.HemisphereLight(0x2a3f7a, 0x05080f, 1.1));
  const sun = new THREE.DirectionalLight(0xff9a3c, 1.6); sun.position.set(120, 18, -260); scene.add(sun);
  const rim = new THREE.DirectionalLight(0x19e6d2, .5); rim.position.set(-60, 40, 80); scene.add(rim);

  const terrain = makeTerrain(); scene.add(terrain);
  scene.add(makeStars());
  const particles = makeParticles(); scene.add(particles);
  const drone = makeDrone(); scene.add(drone.group);
  const trailL = new Trail(scene, AMBER, 110), trailR = new Trail(scene, AMBER, 110);
  const tmp = new THREE.Vector3(), look = new THREE.Vector3(), mouse = { x: 0, y: 0 }, target = { x: 0, y: 0 };

  function resize() {
    const w = canvas.clientWidth || 1, h = canvas.clientHeight || 1;
    renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix();
  }
  resize();
  const onMove = e => { target.x = (e.clientX / innerWidth - .5) * 2; target.y = (e.clientY / innerHeight - .5) * 2; };
  addEventListener('pointermove', onMove, { passive: true });
  addEventListener('resize', resize);

  const t0 = performance.now() - (reduced ? 9000 : 0);   // hareket azaltma: tek kare, uçuşun ortasından
  let raf = 0, running = true, visible = true;
  const SPEED = 14;   // m/s ileri uçuş

  function frame(now) {
    const t = (now - t0) / 1000;
    const dist = t * SPEED;                      // kat edilen yol
    const zc = -(dist % PERIOD);                 // kamera z (periyodik sarma)
    const bank = Math.sin(t * .55) * .35, sway = Math.sin(t * .4) * 9;
    // dron
    const dx = sway, dz = zc - 11, dy = 10 + Math.sin(t * 1.3) * .8 + noiseH(dx, dz) * .08;
    drone.group.position.set(dx, dy, dz);
    drone.group.rotation.set(0, Math.PI / 2 - Math.cos(t * .4) * .25, bank);
    drone.group.rotation.x = -.15;               // burun aşağı: hız hissi
    for (const b of drone.rotors) b.rotation.y = t * 70;
    drone.nav.forEach((l, i) => { l.visible = (Math.floor(t * 4 + i) % 5) !== 0; });
    tmp.set(-1.9, .1, -1.9).applyMatrix4(drone.group.matrixWorld);
    drone.group.updateMatrixWorld();
    trailL.push(tmp.set(-1.9, .1, -1.9).applyMatrix4(drone.group.matrixWorld));
    trailR.push(tmp.set(-1.9, .1, 1.9).applyMatrix4(drone.group.matrixWorld));
    // kamera: yavaş dolly (geriden yaklaş), hafif yörünge + fare parallax
    mouse.x += (target.x - mouse.x) * .04; mouse.y += (target.y - mouse.y) * .04;
    const narrow = camera.aspect < 1;           // dikey ekran: dron küçük ve başlığın üstünde
    const dolly = 26 - Math.min(8, t * .4) + (narrow ? 12 : 0);
    camera.position.set(dx + Math.sin(t * .18) * 4 + mouse.x * 3, dy + 3.5 + mouse.y * 1.2, dz + dolly);
    // Kadraj kilidi: dron ekranda sabit NDC hedefinde (yatay: sağ üçte bir, başlık satırının üstü; dikey: üst orta).
    // Metin bloğu sol ~%60'ı kaplar; salınım/parallax kamerayı oynatır, hedef izdüşüm ise sabit kalır.
    const NX = narrow ? 0.05 : 0.58, NY = narrow ? 0.55 : 0.5;
    look.set(dx, dy, dz); camera.lookAt(look);
    for (let i = 0; i < 2; i++) {               // iki düzeltme adımı: dronun izdüşümünü hedefe getir
      camera.updateMatrixWorld();
      const p = tmp.set(dx, dy, dz).project(camera);
      const d = camera.position.distanceTo(drone.group.position), tanv = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
      const ex = (p.x - NX) * d * tanv * camera.aspect, ey = (p.y - NY) * d * tanv;
      const right = tmp.setFromMatrixColumn(camera.matrixWorld, 0).clone(), up = tmp.setFromMatrixColumn(camera.matrixWorld, 1).clone();
      look.addScaledVector(right, ex).addScaledVector(up, ey);
      camera.lookAt(look);
    }
    // arazi periyodik: kamera sarınca arazi sabit kalır (periyot = PERIOD); parçacıklar akar
    const pp = particles.geometry.attributes.position;
    for (let i = 0; i < pp.count; i++) {
      let z = pp.getZ(i) + SPEED * 2.2 * (1 / 60);
      if (z > camera.position.z + 5) z -= 300;
      pp.setZ(i, z);
    }
    particles.position.z = 0; pp.needsUpdate = true;
    sun.position.set(camera.position.x + 120, 18, camera.position.z - 260);
    terrain.position.z = Math.round(camera.position.z / PERIOD) * PERIOD;   // kameranın önünde kalsın
    renderer.render(scene, camera);
    if (running && visible && (!reduced || t < 9.6)) raf = requestAnimationFrame(frame);   // hareket azaltma: ~0.5 sn sonra durur
  }
  frame(performance.now());
  canvas.classList.add('on');

  const onVis = () => { visible = !document.hidden; if (visible && running && !reduced) raf = requestAnimationFrame(frame); };
  document.addEventListener('visibilitychange', onVis);
  const io = new IntersectionObserver(([e]) => {
    const was = visible; visible = e.isIntersecting && !document.hidden;
    if (visible && !was && running && !reduced) raf = requestAnimationFrame(frame);
  }, { threshold: 0 });
  io.observe(canvas);

  return {
    stop() { running = false; cancelAnimationFrame(raf); io.disconnect(); removeEventListener('pointermove', onMove); removeEventListener('resize', resize); document.removeEventListener('visibilitychange', onVis); renderer.dispose(); },
  };
}
