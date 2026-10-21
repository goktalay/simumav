// SIMUMAV açılış sahnesi — sinematik filo gösterimi: CAYMAZ → INTERCEPTOR'lar → diğer gerçekçi modeller (fleet.js REEL).
// Her model SHOT_SEC sn ekranda; dört kamera hareketi (yörünge, alçak takip, önden süpürme, vinç) sırayla; çekimler arası "dip to black".
// Gerçek GLB'ler (tembel: yalnız gösterilen + sıradaki indirilir), dönen pervaneler + bulanıklık diski, seyir ışıkları, yumuşak gölge,
// gökyüzü kubbesi + sis + ağaçlı prosedürel arazi; gece/gündüz teması (setTheme). Paylaşılan TEK WebGL bağlamı (stage.js) → 2B tuval.
// Mobil: gölge yok, düşük piksel oranı, az ağaç. Hareket azaltma: döngü yok; tek kare (önceki/sonraki düğmeleriyle model değişir).
// Dışa aktarım: startHero(canvas, { reduced, theme, onShot(entry, i, n), onProgress(p) }) → { stop, next, prev, pause(bool), setTheme, info }
import { THREE, renderTo, prepareModel, spinProps, studioEnv, isSmall } from './stage.js';
import { reelModels, SHOT_SEC, FADE_SEC, shotFade, isRotor } from './fleet.js';

const PERIOD = 400;
const FIT = 2.6;               // model en uzun boyutu (sahne birimi)

function noiseH(x, z) {        // periyodik yükseklik (PERIOD'a tam bölünen frekanslar)
  const k = Math.PI * 2 / PERIOD;
  return 6 * Math.sin(x * k * 2 + 1.3) * Math.cos(z * k * 3)
       + 3.5 * Math.sin(x * k * 5 + z * k * 2) + 2 * Math.cos(x * k * 9 - z * k * 7 + .7)
       + 1.2 * Math.sin(x * k * 17 + z * k * 13) + 16 * Math.max(0, Math.sin(x * k) * Math.cos(z * k * 2));
}
const terrainY = (x, z) => noiseH(x, z) * (0.3 + 0.7 * Math.min(1, Math.abs(x) / 60)) - 6;

const PAL = {
  night: { top: 0x050a18, mid: 0x142046, hor: 0x6a4466, glow: 0xff8a3d, fog: 0x2a2546, fogD: 0.0075, sun: 0xffa86a, sunI: 2.2, hemiS: 0x4a63a8, hemiG: 0x0b0d16, hemiI: 0.85,
    env: 0.35, exp: 1.1, stars: 1, grass: [0x22362c, 0x2c4434], rock: 0x3a3a46, snow: 0x9aa3b8, tree: 0x132519, nav: 1 },
  day: { top: 0x2a64b0, mid: 0x6f9fd6, hor: 0xd9e6f2, glow: 0xfff1d6, fog: 0xc6d7e8, fogD: 0.0058, sun: 0xfff3dc, sunI: 3.0, hemiS: 0xcfe6ff, hemiG: 0x56603f, hemiI: 1.0,
    env: 0.55, exp: 1.0, stars: 0, grass: [0x55703a, 0x6f8a45], rock: 0x7d7468, snow: 0xf2f5f8, tree: 0x2f4a26, nav: 0.35 },
};

function makeSky() {
  const geo = new THREE.SphereGeometry(900, 32, 16);
  const uni = { top: { value: new THREE.Color() }, mid: { value: new THREE.Color() }, hor: { value: new THREE.Color() }, glow: { value: new THREE.Color() }, sunDir: { value: new THREE.Vector3(0.45, 0.07, -1).normalize() } };
  const mat = new THREE.ShaderMaterial({
    uniforms: uni, side: THREE.BackSide, depthWrite: false, fog: false,
    vertexShader: 'varying vec3 vD; void main(){ vD = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: `uniform vec3 top; uniform vec3 mid; uniform vec3 hor; uniform vec3 glow; uniform vec3 sunDir; varying vec3 vD;
      void main(){ float h = clamp(vD.y, -0.2, 1.0);
        vec3 c = mix(hor, mid, smoothstep(0.0, 0.18, h)); c = mix(c, top, smoothstep(0.18, 0.75, h));
        float s = max(dot(normalize(vD), normalize(sunDir)), 0.0);
        c += glow * (pow(s, 6.0) * 0.45 + pow(s, 120.0) * 1.2) * (1.0 - smoothstep(0.0, 0.5, h) * 0.6);
        gl_FragColor = vec4(c, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  });
  const m = new THREE.Mesh(geo, mat); m.frustumCulled = false; m.renderOrder = -10;
  return { mesh: m, uni };
}

function makeStars(n) {
  const a = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const th = Math.random() * Math.PI * 2, ph = 0.08 + Math.random() * Math.PI * 0.45, r = 850;
    a.set([r * Math.cos(th) * Math.cos(ph), r * Math.sin(ph), r * Math.sin(th) * Math.cos(ph)], i * 3);
  }
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(a, 3));
  const p = new THREE.Points(g, new THREE.PointsMaterial({ color: 0xdfeaff, size: 1.7, sizeAttenuation: false, transparent: true, opacity: 0.8, fog: false, depthWrite: false }));
  p.frustumCulled = false;
  return p;
}

function makeTerrain(small) {
  const seg = small ? 90 : 150, size = PERIOD * 2;
  const geo = new THREE.PlaneGeometry(size, size, seg, seg); geo.rotateX(-Math.PI / 2);
  const pos = geo.attributes.position;
  for (let i = 0; i < pos.count; i++) pos.setY(i, terrainY(pos.getX(i), pos.getZ(i)));
  geo.computeVertexNormals();
  geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(pos.count * 3), 3));
  const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.96, metalness: 0 }));
  mesh.receiveShadow = true;
  // ağaçlar: örneklenmiş koniler (vadi kenarı ve yamaçlar; zirvelerde ve uçuş koridorunda yok)
  const nTree = small ? 500 : 1400;
  const cone = new THREE.ConeGeometry(1, 3.2, 6); cone.translate(0, 1.6, 0);
  const trees = new THREE.InstancedMesh(cone, new THREE.MeshStandardMaterial({ roughness: 0.9, flatShading: true }), nTree);
  const M = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), p = new THREE.Vector3(), Y = new THREE.Vector3(0, 1, 0);
  let k = 0, guard = 0;
  while (k < nTree && guard++ < nTree * 8) {
    const x = (Math.random() - 0.5) * size, z = (Math.random() - 0.5) * size, y = terrainY(x, z);
    if (y > 9 || Math.abs(x) < 8) continue;
    const sc = 0.7 + Math.random() * 1.1;
    M.compose(p.set(x, y - 0.2, z), q.setFromAxisAngle(Y, Math.random() * 6.3), s.set(sc, sc * (0.8 + Math.random() * 0.6), sc));
    trees.setMatrixAt(k++, M);
  }
  trees.count = k; trees.castShadow = !small; trees.receiveShadow = true;
  const g = new THREE.Group(); g.add(mesh, trees);
  const paint = pal => {   // yükseklik/eğime göre doğal renkler (tema değişince yeniden boyanır)
    const col = geo.attributes.color, nrm = geo.attributes.normal, c = new THREE.Color();
    const g0 = new THREE.Color(pal.grass[0]), g1 = new THREE.Color(pal.grass[1]), rock = new THREE.Color(pal.rock), snow = new THREE.Color(pal.snow);
    for (let i = 0; i < pos.count; i++) {
      const y = pos.getY(i), slope = 1 - nrm.getY(i), x = pos.getX(i), z = pos.getZ(i);
      c.copy(g0).lerp(g1, 0.5 + 0.5 * Math.sin(x * 0.05 + z * 0.031));
      c.lerp(rock, Math.min(1, Math.max(0, (slope - 0.12) * 3.5)));
      c.lerp(snow, Math.min(1, Math.max(0, (y - 10) / 5)));
      col.setXYZ(i, c.r, c.g, c.b);
    }
    col.needsUpdate = true;
    trees.material.color.set(pal.tree);
  };
  return { group: g, paint };
}

function navLights(model) {   // kanat uçlarında kırmızı (sol, -Z) / yeşil (sağ, +Z) + kuyruk strobu; gece belirgin
  // uç noktalar: gerçek köşe noktaları (sınır kutusu köşesi delta kanatta havada kalır)
  const root = model.root; root.updateMatrixWorld(true);
  const inv = new THREE.Matrix4().copy(root.matrixWorld).invert(), m = new THREE.Matrix4(), v = new THREE.Vector3();
  const L = new THREE.Vector3(0, 0, Infinity), R = new THREE.Vector3(0, 0, -Infinity), T = new THREE.Vector3(Infinity, 0, 0);
  root.traverse(o => {
    const pos = o.isMesh && o.geometry?.attributes?.position; if (!pos) return;
    m.multiplyMatrices(inv, o.matrixWorld);
    const step = Math.max(1, Math.floor(pos.count / 4000));
    for (let i = 0; i < pos.count; i += step) {
      v.fromBufferAttribute(pos, i).applyMatrix4(m);
      if (v.z < L.z) L.copy(v); if (v.z > R.z) R.copy(v); if (v.x < T.x) T.copy(v);
    }
  });
  const g = new THREE.Group();
  const mk = (c, p) => { const s = new THREE.Mesh(new THREE.SphereGeometry(0.028, 8, 8), new THREE.MeshBasicMaterial({ color: c, toneMapped: false })); s.position.copy(p); g.add(s); return s; };
  return { group: g, L: mk(0xff3030, L), R: mk(0x30ff70, R), S: mk(0xffffff, T) };
}

export function startHero(canvas, { reduced = false, theme = 'dark', onShot, onProgress } = {}) {
  const small = isSmall();
  const ctx = canvas.getContext('2d');
  const host = canvas.parentElement || canvas;   // --dip: karartma perdesi (.hero-dip) opaklığı
  const dip = v => host.style.setProperty('--dip', v);
  dip('1');
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 2000);
  const sky = makeSky(); scene.add(sky.mesh);
  const stars = makeStars(small ? 500 : 1200); scene.add(stars);
  scene.fog = new THREE.FogExp2(0x1a1d38, 0.008);
  const hemi = new THREE.HemisphereLight(0xffffff, 0x222222, 1); scene.add(hemi);
  const sun = new THREE.DirectionalLight(0xffffff, 2); scene.add(sun, sun.target);
  sun.castShadow = !small; sun.shadow.mapSize.set(1024, 1024); sun.shadow.bias = -0.0006; sun.shadow.normalBias = 0.02;
  Object.assign(sun.shadow.camera, { left: -7, right: 7, top: 7, bottom: -7, near: 1, far: 120 });
  const rim = new THREE.DirectionalLight(0x7fd8ff, 0.6); scene.add(rim, rim.target);
  scene.environment = studioEnv();
  const terrain = makeTerrain(small); scene.add(terrain.group);

  const reel = reelModels(), n = reel.length;
  const models = new Array(n).fill(null), loading = new Array(n).fill(null);
  const load = i => (loading[i] ??= prepareModel(reel[i], { fit: FIT, shadows: !small })
    .then(m => { m.nav = navLights(m); m.root.add(m.nav.group); models[i] = m; return m; }).catch(() => null));
  const holder = new THREE.Group(); scene.add(holder);       // yaw (burun → -Z) + konum
  const att = new THREE.Group(); att.rotation.order = 'YXZ'; holder.add(att);

  let pal = PAL[theme === 'light' ? 'day' : 'night'];
  let cur = 0, shotT = 0, animT = 0, last = performance.now(), raf = 0, running = true, visible = true, paused = false;
  let pr = small ? 1 : 1.5, shadows = !small, slow = 0;

  function setTheme(t) {
    pal = PAL[t === 'light' ? 'day' : 'night'];
    sky.uni.top.value.set(pal.top); sky.uni.mid.value.set(pal.mid); sky.uni.hor.value.set(pal.hor); sky.uni.glow.value.set(pal.glow);
    scene.fog.color.set(pal.fog); scene.fog.density = pal.fogD;
    sun.color.set(pal.sun); sun.intensity = pal.sunI;
    hemi.color.set(pal.hemiS); hemi.groundColor.set(pal.hemiG); hemi.intensity = pal.hemiI;
    rim.intensity = pal.stars ? 0.7 : 0.25;
    scene.environmentIntensity = pal.env;
    stars.visible = !!pal.stars;
    terrain.paint(pal);
    if (paused || reduced) draw();
  }

  const mouse = { x: 0, y: 0 }, target = { x: 0, y: 0 };
  const onMove = e => { target.x = (e.clientX / innerWidth - .5) * 2; target.y = (e.clientY / innerHeight - .5) * 2; };
  if (!reduced) addEventListener('pointermove', onMove, { passive: true });
  const tmp = new THREE.Vector3(), look = new THREE.Vector3(), right = new THREE.Vector3(), up = new THREE.Vector3();

  function enter(i) {   // çekime gir: modeli tutucuya koy, sıradakini indir
    cur = (i + n) % n; shotT = 0;
    while (att.children.length) att.remove(att.children[0]);
    if (models[cur]) att.add(models[cur].root);
    load((cur + 1) % n);
    onShot?.(reel[cur], cur, n);
  }

  function pose(T, local) {   // dron konumu + yönelimi + kamera; T: toplam animasyon zamanı, local: çekim içi zaman
    const m = reel[cur], rotor = isRotor(m);
    const V = rotor ? 7 : 15 + Math.min(10, (m.max || 100) / 40);   // sahne birimi/sn (görsel)
    const w = 0.33, A = rotor ? 2.5 : 6;
    const dx = A * Math.sin(T * w), dz = -T * V;
    const dy = Math.max(terrainY(dx, dz) + 5.5, 7) + (rotor ? Math.sin(T * 1.6) * 0.25 : Math.sin(T * 0.7) * 0.6);
    holder.position.set(dx, dy, dz);
    const psi = -Math.atan2(A * w * Math.cos(T * w), V);   // rota teğeti
    holder.rotation.y = Math.PI / 2 + psi;
    const ax = -A * w * w * Math.sin(T * w);               // yanal ivme → yatış (sağ kanat aşağı +)
    att.rotation.x = rotor ? THREE.MathUtils.clamp(ax * 0.15, -0.2, 0.2) : THREE.MathUtils.clamp(ax * 0.6, -0.55, 0.55);
    att.rotation.z = rotor ? -0.14 : 0.03 + Math.sin(T * 0.5) * 0.03;   // döner kanat burun aşağı; uçak hafif hücum açısı
    const mm = models[cur];
    if (mm) {
      spinProps(mm.props, T * (rotor ? 38 : 30));
      const blink = Math.floor(T * 1.4) % 2 === 0;
      mm.nav.L.visible = mm.nav.R.visible = pal.nav > 0.5 || blink; mm.nav.S.visible = (T * 1.2) % 1 < 0.06;
    }
    // kamera hareketi (çekime göre)
    const mv = cur % 4, u = Math.min(1, local / SHOT_SEC), e = u * u * (3 - 2 * u);
    const narrow = camera.aspect < 0.9, R = narrow ? 12 : 9.5;
    let a, h, rr, lock = 1;
    if (mv === 0) { a = 215 - 95 * e; h = 1.2 + 1.3 * e; rr = R; }                                  // yörünge: arka sol → yan
    else if (mv === 1) { a = 180 + 12 * Math.sin(u * 3); h = 0.4 + 1.8 * e; rr = R * (1.25 - 0.4 * e); }   // alçak takip, yaklaşma
    else if (mv === 2) { a = -30 + 150 * e; h = 0.8; rr = R; lock = 0.85; }                          // önden yana süpürme
    else { a = 130 + 70 * e; h = 4.5 - 1.5 * e; rr = R * 1.05; }                                     // vinç: yüksekten iniş
    const ca = THREE.MathUtils.degToRad(a) + psi;
    camera.position.set(dx + Math.sin(ca) * rr + mouse.x * 0.8, dy + h + mouse.y * 0.4, dz + Math.cos(ca) * rr);
    const gmin = terrainY(camera.position.x, camera.position.z) + 1.2;
    if (camera.position.y < gmin) camera.position.y = gmin;
    // kadraj kilidi: dron ekranda sabit NDC hedefinde (yatay: sağ yarı — metin solda; dikey ekran: üst orta)
    const rtl = document.documentElement.dir === 'rtl';   // RTL: metin sağda → dron sol yarıda
    const NX = (narrow ? 0.0 : 0.56) * lock * (rtl ? -1 : 1), NY = (narrow ? 0.42 : 0.16) * lock;
    look.set(dx, dy, dz); camera.lookAt(look);
    for (let i = 0; i < 2; i++) {
      camera.updateMatrixWorld();
      const p = tmp.set(dx, dy, dz).project(camera);
      const d = camera.position.distanceTo(holder.position), tv = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
      right.setFromMatrixColumn(camera.matrixWorld, 0); up.setFromMatrixColumn(camera.matrixWorld, 1);
      look.addScaledVector(right, (p.x - NX) * d * tv * camera.aspect).addScaledVector(up, (p.y - NY) * d * tv);
      camera.lookAt(look);
    }
    // güneş + gölge kamerası dronu izler; gök kubbesi kamerada; arazi periyodik
    sun.position.set(dx + 40, dy + 38, dz - 30); sun.target.position.set(dx, dy - 4, dz);
    rim.position.set(dx - 30, dy + 10, dz + 40); rim.target.position.copy(holder.position);
    sky.mesh.position.copy(camera.position); stars.position.copy(camera.position);
    terrain.group.position.z = Math.round(camera.position.z / PERIOD) * PERIOD;
  }

  function draw() {
    const w = canvas.clientWidth || 1, h = canvas.clientHeight || 1;
    camera.aspect = w / h;
    pose(animT, shotT);
    if (renderTo(ctx, w, h, scene, camera, { pr, shadows, exposure: pal.exp })) canvas.classList.add('on');
  }

  function frame(now) {
    raf = 0;
    const dt = Math.min(0.1, (now - last) / 1000); last = now;
    if (!paused) {
      animT += dt;
      // sıradaki model hazır değilse çekim kararmadan önce uzar (siyah ekranda bekleme yok)
      const hold = !models[(cur + 1) % n] && shotT <= SHOT_SEC - FADE_SEC && shotT + dt > SHOT_SEC - FADE_SEC;
      if (!hold) shotT += dt;
      if (shotT >= SHOT_SEC) enter(cur + 1);
    }
    mouse.x += (target.x - mouse.x) * .04; mouse.y += (target.y - mouse.y) * .04;
    const t0 = performance.now();
    draw();
    dip((models[cur] ? shotFade(shotT) : 1).toFixed(3));
    onProgress?.(Math.min(1, shotT / SHOT_SEC));
    // kare süresi yöneticisi: yavaşsa önce gölge kapanır, sonra çözünürlük düşer
    slow = performance.now() - t0 > 26 ? slow + 1 : Math.max(0, slow - 1);
    if (slow > 45) { slow = 0; if (shadows) shadows = false; else pr = Math.max(0.6, pr - 0.25); }
    schedule();
  }
  function schedule() { if (!raf && running && visible && !reduced && !document.hidden) { last = performance.now(); raf = requestAnimationFrame(frame); } }

  setTheme(theme);
  load(0).then(() => {
    if (!running) return;
    enter(0);
    if (reduced) { shotT = SHOT_SEC * 0.45; animT = 9; draw(); dip('0'); }
  });
  schedule();   // model gelene kadar arazi + gök (karartma perdesi kapalı)

  const onVis = () => schedule();
  document.addEventListener('visibilitychange', onVis);
  const io = new IntersectionObserver(([e]) => { visible = e.isIntersecting; schedule(); }, { threshold: 0 });
  io.observe(canvas);
  const jump = async d => {
    const i = (cur + d + n) % n;
    if (!await load(i)) return;
    enter(i);
    if (reduced || paused) { shotT = SHOT_SEC * 0.45; draw(); dip('0'); } else shotT = FADE_SEC * 0.6;
  };
  return {
    next: () => jump(1), prev: () => jump(-1),
    pause(v) { paused = !!v; schedule(); },
    get paused() { return paused; },
    setTheme,
    info: () => ({ index: cur, id: reel[cur]?.id, loaded: models.filter(Boolean).length, pr, shadows, paused, shotT }),
    stop() { running = false; cancelAnimationFrame(raf); io.disconnect(); removeEventListener('pointermove', onMove); document.removeEventListener('visibilitychange', onVis); },
  };
}
