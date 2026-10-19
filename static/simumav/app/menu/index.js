// Ana menü: tam ekran, three.js hafif 3B arka plan (dönen dünya + yıldız parçacıkları + fare parallax), 6 büyük kart.
import { h, clear } from '../core/dom.js';
import { t } from '../i18n/i18n.js';
import { bigCard } from '../ui/components.js';
import { stagger } from '../ui/transition.js';
import { loadThree, makeStage, cssColor } from '../core/three.js';

const CARDS = [
  { key: 'hangar', icon: 'hangar' },
  { key: 'crew', icon: 'crew' },
  { key: 'tracks', icon: 'tracks' },
  { key: 'missions', icon: 'missions' },
  { key: 'fly', icon: 'fly' },
  { key: 'ops', icon: 'ops' },
];

export async function mount(root, ctx) {
  const sc = h('div', { class: 'screen' });
  const logo = h('img', { src: '/brand/simumav.svg', alt: 'SIMUMAV' });
  logo.addEventListener('error', () => { logo.src = '/app/img/icons/logo.svg'; }, { once: true });
  sc.append(h('div', { class: 'menu-logo' }, logo, h('h1', { class: 'title' }, 'SIMU', h('span', {}, 'MAV'))));
  const grid = h('div', { class: 'menu-grid', role: 'menu' });
  const cards = CARDS.map(c => bigCard({ name: t(`menu.${c.key}`), desc: t(`menu.${c.key}_desc`), icon: `/brand/icons/${c.icon}.svg`, iconFallback: `/app/img/icons/${c.icon}.svg`, onClick: () => ctx.go(c.key) }));
  grid.append(...cards); stagger(cards, 60);
  sc.append(grid);
  clear(root, sc);

  // Klavye: ok tuşları + Enter
  let focus = -1;
  const onKey = e => {
    const cols = window.innerWidth < 900 ? 2 : 3;
    const map = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: cols, ArrowUp: -cols };
    if (e.key in map) { focus = (focus < 0 ? 0 : (focus + map[e.key] + cards.length) % cards.length); cards[focus].focus(); e.preventDefault(); }
    else if (e.key === 'Enter' && focus >= 0 && document.activeElement === cards[focus]) ctx.go(CARDS[focus].key);
  };
  document.addEventListener('keydown', onKey);
  cards.forEach((c, i) => c.addEventListener('focus', () => { focus = i; }));

  // 3B arka plan
  const canvas = document.getElementById('stage');
  canvas.hidden = false;
  let stage = null, mouse = { x: 0, y: 0 }, target = { x: 0, y: 0 };
  const onMove = e => { target.x = (e.clientX / window.innerWidth - 0.5) * 2; target.y = (e.clientY / window.innerHeight - 0.5) * 2; };
  window.addEventListener('pointermove', onMove);
  let themeHandler = null;
  try {
    const lib = await loadThree();
    const { THREE } = lib;
    let earth, stars, ring, glowMesh;
    stage = makeStage(lib, canvas, {
      fov: 45, env: false, pixelRatioMax: 1.25,
      onFrame: (dt, tm) => {
        mouse.x += (target.x - mouse.x) * 0.05; mouse.y += (target.y - mouse.y) * 0.05;
        earth.rotation.y += dt * 0.08; ring.rotation.z += dt * 0.03;
        stars.rotation.y += dt * 0.006;
        stage.camera.position.x = mouse.x * 0.9; stage.camera.position.y = -mouse.y * 0.6 + 0.3;
        stage.camera.lookAt(0, 0.2, 0);
        earth.position.y = Math.sin(tm * 0.4) * 0.05;
      },
    });
    const { scene, camera } = stage;
    camera.position.set(0, 0.3, 7);
    scene.add(new THREE.HemisphereLight(0xaaccff, 0x080a12, 0.5));
    const sun = new THREE.DirectionalLight(0xfff2dd, 2.2); sun.position.set(-6, 3, 4); scene.add(sun);
    const rim = new THREE.DirectionalLight(0x38bdf8, 1.2); rim.position.set(6, -2, -3); scene.add(rim);

    // Dünya: prosedürel doku (kıta benzeri gürültü) — dosya/CDN yok
    const tex = earthTexture(THREE);
    earth = new THREE.Mesh(new THREE.SphereGeometry(2.6, 64, 48), new THREE.MeshStandardMaterial({ map: tex, roughness: 0.75, metalness: 0.05 }));
    earth.position.set(3.4, -3.0, -1.5); earth.rotation.z = 0.35; scene.add(earth);
    glowMesh = new THREE.Mesh(new THREE.SphereGeometry(2.72, 48, 32), new THREE.MeshBasicMaterial({ color: 0x38bdf8, transparent: true, opacity: 0.12, side: THREE.BackSide }));
    earth.add(glowMesh);
    // Yörünge halkası (uçuş yolu hissi)
    ring = new THREE.Mesh(new THREE.TorusGeometry(3.4, 0.012, 8, 160), new THREE.MeshBasicMaterial({ color: 0xa78bfa, transparent: true, opacity: 0.45 }));
    ring.position.copy(earth.position); ring.rotation.x = Math.PI / 2.4; scene.add(ring);
    // Yıldızlar
    const n = 1400, pos = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) { const r = 18 + Math.random() * 30, th = Math.random() * Math.PI * 2, ph = Math.acos(2 * Math.random() - 1); pos.set([r * Math.sin(ph) * Math.cos(th), r * Math.sin(ph) * Math.sin(th), r * Math.cos(ph) - 10], i * 3); }
    const sg = new THREE.BufferGeometry(); sg.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    stars = new THREE.Points(sg, new THREE.PointsMaterial({ color: 0xffffff, size: 0.09, transparent: true, opacity: 0.85, sizeAttenuation: true })); scene.add(stars);
    const applyTheme = () => { const light = document.documentElement.dataset.theme === 'light'; stars.material.opacity = light ? 0.25 : 0.85; glowMesh.material.opacity = light ? 0.06 : 0.12; sun.intensity = light ? 3 : 2.2; scene.fog = null; };
    applyTheme(); themeHandler = applyTheme; window.addEventListener('sm:theme', themeHandler);
    stage.start();
  } catch (e) { console.warn('3B arka plan açılamadı', e); }

  return () => {
    // Menü arka planı görünmezken durur ve kapanır: görünüm silinir (paylaşılan çizici boşta kalınca bağlamı bırakır)
    document.removeEventListener('keydown', onKey);
    window.removeEventListener('pointermove', onMove);
    if (themeHandler) window.removeEventListener('sm:theme', themeHandler);
    stage?.dispose(); stage = null;
    (document.getElementById('stage') || canvas).hidden = true;
  };
}

// Değer gürültüsü ile kıta/okyanus dokusu
function earthTexture(THREE) {
  const W = 512, H = 256, c = document.createElement('canvas'); c.width = W; c.height = H;
  const g = c.getContext('2d'), img = g.createImageData(W, H), d = img.data;
  const rnd = seed => { let s = seed; return () => { s = (s * 16807) % 2147483647; return s / 2147483647; }; };
  const r = rnd(1337), grid = [];
  const G = 24; for (let i = 0; i <= G; i++) { grid[i] = []; for (let j = 0; j <= G * 2; j++) grid[i][j] = r(); }
  const lerp = (a, b, k) => a + (b - a) * (k * k * (3 - 2 * k));
  const noise = (x, y, f) => { const gx = x * f, gy = y * f, x0 = Math.floor(gx) % (G * 2), y0 = Math.floor(gy) % G, fx = gx - Math.floor(gx), fy = gy - Math.floor(gy); const a = grid[y0][x0], b = grid[y0][(x0 + 1) % (G * 2)], cc = grid[(y0 + 1) % G][x0], dd = grid[(y0 + 1) % G][(x0 + 1) % (G * 2)]; return lerp(lerp(a, b, fx), lerp(cc, dd, fx), fy); };
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const u = x / W, v = y / H;
    const n = noise(u, v, 6) * 0.55 + noise(u, v, 14) * 0.3 + noise(u, v, 30) * 0.15;
    const land = n > 0.52, polar = Math.abs(v - 0.5) > 0.42;
    let cr, cg, cb;
    if (polar) { cr = 225; cg = 235; cb = 245; }
    else if (land) { const k = (n - 0.52) * 5; cr = 60 + k * 80; cg = 110 + k * 40; cb = 50; }
    else { const k = n * 1.5; cr = 10 + k * 20; cg = 50 + k * 60; cb = 120 + k * 80; }
    const i = (y * W + x) * 4; d[i] = cr; d[i + 1] = cg; d[i + 2] = cb; d[i + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace; return tex;
}
