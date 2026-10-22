// Menü canlı uçuş sahnesinin SAF çekirdeği (DOM/three.js yok; node ile test edilir: tests/test_simumav_ui.mjs).
// Uçuş yolu, sinematik kamera (takip → yan pan → FPV → yerden izleme döngüsü), prosedürel arazi gürültüsü (ağ yoksa),
// kare süresine göre kalite yöneticisi, dron model yolu sabitleri.

export const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
export const lerp = (a, b, k) => a + (b - a) * k;
export const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };

// ---------- Dron modeli: TEK sabit — yalnız GERÇEKTE VAR OLAN dosyalar (static/simumav/models/*.glb kataloğu; eski `plane.glb` / `vtol.glb` /
// `fpv.glb` … yer tutucuları hiç eklenmedi → her menü açılışında konsolda 404 veriyordu). Sabit kanat: HEPGO caymaz-sim.glb (Y yukarı, burun +Z,
// pervane düğümü 'prop'); hiçbiri yüklenemezse procmodels şablonu.
export const MENU_DRONE_TYPE = 'plane';
export const MODEL_URLS = {
  plane: ['/static/models/caymaz-sim.glb'],
  vtol: ['/static/simumav/models/standard_vtol.glb', '/static/models/caymaz-sim.glb'],
  fpv: ['/static/simumav/models/iris_fpv.glb'],
  multirotor: ['/static/simumav/models/x500.glb'],
  heli: ['/static/simumav/models/heli.glb'],
  interceptor: ['/static/simumav/models/icept_x4.glb'],
};
export const modelCandidates = type => MODEL_URLS[type] || MODEL_URLS.plane;

// ---------- Arazi: TRTEST Kalecik çevresi (parkur hazır konumu); kenar 3 km; ağ yoksa prosedürel
export const TERRAIN = { lat: 40.0990, lon: 33.4101, size_m: 3000, grid: 160, api: '/api/drone/sim' };

// Değer gürültüsü (tohumlu; kıvrımlı tepeler) — prosedürel yedek arazi, metre
export function makeNoise(seed = 7) {
  let s = (seed >>> 0) || 1;
  const rnd = () => { s = (s * 16807) % 2147483647; return s / 2147483647; };
  const G = 64, grid = new Float32Array(G * G);
  for (let i = 0; i < grid.length; i++) grid[i] = rnd();
  const at = (x, y) => grid[((y % G + G) % G) * G + ((x % G + G) % G)];
  const sm = k => k * k * (3 - 2 * k);
  return (x, y) => {
    const x0 = Math.floor(x), y0 = Math.floor(y), fx = sm(x - x0), fy = sm(y - y0);
    const a = at(x0, y0), b = at(x0 + 1, y0), c = at(x0, y0 + 1), d = at(x0 + 1, y0 + 1);
    return lerp(lerp(a, b, fx), lerp(c, d, fx), fy);
  };
}
/** Prosedürel yükseklik (m): x, y metre (merkez 0); merkez çevresi düz (kalkış alanı). */
export function procHeight(noise, x, y, size = TERRAIN.size_m) {
  const u = x / size * 6, v = y / size * 6;
  const n = noise(u, v) * 0.6 + noise(u * 2.1 + 7, v * 2.1 + 3) * 0.28 + noise(u * 4.3 + 19, v * 4.3 + 11) * 0.12;
  const h = Math.pow(n, 1.6) * 260 - 40;
  return h * smooth(150, 500, Math.hypot(x, y));
}

// ---------- Uçuş yolu: alçak irtifa, geniş sekizli tur; dönüşlerde yatış (bank) ----------
const PATH = { rx: 900, ry: 520, period: 84, agl: 46, bob: 7 };   // ~70 m/s: süzülme hissi
/** t saniye → { x, y, z, heading (rad; +Z ileri, Y yukarı dünya), bank (rad), speed } — y hariç (araziye göre dışarıda eklenir). */
export function flightPath(t) {
  const w = (2 * Math.PI) / PATH.period, a = t * w;
  // Gerono lemniskatı: x = rx·cos a, z = ry·sin a·cos a
  const x = PATH.rx * Math.cos(a), z = PATH.ry * Math.sin(a) * Math.cos(a);
  const dx = -PATH.rx * Math.sin(a) * w, dz = PATH.ry * Math.cos(2 * a) * w;
  const ddx = -PATH.rx * Math.cos(a) * w * w, ddz = -2 * PATH.ry * Math.sin(2 * a) * w * w;
  const speed = Math.hypot(dx, dz) || 1e-6;
  const heading = Math.atan2(dx, dz);                        // +Z ileri referanslı
  const curv = (dx * ddz - dz * ddx) / (speed * speed * speed);   // işaretli eğrilik
  const bank = clamp(-Math.atan(curv * speed * speed / 9.81), -0.75, 0.75);   // koordineli dönüş yatışı
  const alt = PATH.agl + Math.sin(t * 0.37) * PATH.bob + Math.sin(t * 0.11) * 4;
  return { x, z, alt, heading, bank, speed, dx, dz };
}

// ---------- Sinematik kamera: kipler döngüsü (saniye) ----------
export const CAM_CYCLE = [
  { mode: 'chase', dur: 18 },    // arkadan yavaş takip + hafif yükseliş
  { mode: 'side', dur: 12 },     // yandan pan (dron ekranı geçer)
  { mode: 'fpv', dur: 8 },       // burun kamerası
  { mode: 'ground', dur: 10 },   // yerden izleme (sabit nokta, dron geçer)
  { mode: 'orbit', dur: 14 },    // etrafında yörünge
];
export const CAM_PERIOD = CAM_CYCLE.reduce((s, c) => s + c.dur, 0);
export function camPhase(t) {
  let u = ((t % CAM_PERIOD) + CAM_PERIOD) % CAM_PERIOD;
  for (let i = 0; i < CAM_CYCLE.length; i++) {
    const c = CAM_CYCLE[i];
    if (u < c.dur) return { mode: c.mode, k: u / c.dur, index: i, into: u, remaining: c.dur - u };
    u -= c.dur;
  }
  return { mode: 'chase', k: 0, index: 0, into: 0, remaining: 1 };
}
/** Kamera hedefi: p = flightPath + y (dünya), ground(x,z) arazi yüksekliği. Dönüş {pos, look, fov, mode, blend} — blend: kip geçişinde 0→1 yumuşatma payı. */
export function cameraPose(t, p, ground, parallax = { x: 0, y: 0 }) {
  const ph = camPhase(t);
  const fwd = { x: Math.sin(p.heading), z: Math.cos(p.heading) };
  const right = { x: fwd.z, z: -fwd.x };
  let pos, look, fov = 50;
  const minY = (x, z, m) => Math.max(ground(x, z) + m, -1e9);
  switch (ph.mode) {
    case 'chase': {
      // yakın takip; dron ekranın ÜST yarısında kalsın (alt şeritte menü kartları var): kamera hafif aşağıdan, bakış dronun altına
      const back = 15 + ph.k * 5, up = 2 + ph.k * 2;
      pos = { x: p.x - fwd.x * back + right.x * 4 * Math.sin(t * 0.3), y: p.y + up, z: p.z - fwd.z * back + right.z * 4 * Math.sin(t * 0.3) };
      look = { x: p.x + fwd.x * 24, y: p.y - 7, z: p.z + fwd.z * 24 }; fov = 52; break;
    }
    case 'side': {
      const side = 16 - ph.k * 4;
      pos = { x: p.x + right.x * side + fwd.x * (ph.k - 0.5) * 20, y: p.y - 1 + ph.k * 2, z: p.z + right.z * side + fwd.z * (ph.k - 0.5) * 20 };
      look = { x: p.x, y: p.y - 3.5, z: p.z }; fov = 42; break;
    }
    case 'fpv': {
      pos = { x: p.x + fwd.x * 1.6, y: p.y + 0.5, z: p.z + fwd.z * 1.6 };
      look = { x: p.x + fwd.x * 120, y: p.y - 6, z: p.z + fwd.z * 120 }; fov = 95; break;
    }
    case 'ground': {
      // sabit nokta: faz başındaki konumun 70 m ilerisinde, yerde
      const t0 = t - ph.into, q = flightPath(t0 + 4), f0 = { x: Math.sin(q.heading), z: Math.cos(q.heading) };
      const gx = q.x + f0.x * 70 + f0.z * 30, gz = q.z + f0.z * 70 - f0.x * 30;
      pos = { x: gx, y: minY(gx, gz, 2.2), z: gz };
      look = { x: p.x, y: p.y, z: p.z }; fov = 38 + ph.k * 10; break;
    }
    default: {   // orbit
      const a = ph.k * Math.PI * 1.4 + 0.6, r = 18;
      pos = { x: p.x + Math.cos(a) * r, y: p.y + 1 + Math.sin(ph.k * Math.PI) * 6, z: p.z + Math.sin(a) * r };
      look = { x: p.x, y: p.y - 4, z: p.z }; fov = 46;
    }
  }
  // fare parallax: hafif yana/yukarı kaydırma (FPV'de daha az)
  const pk = ph.mode === 'fpv' ? 0.3 : 1;
  pos.x += right.x * parallax.x * 4 * pk; pos.z += right.z * parallax.x * 4 * pk; pos.y += -parallax.y * 2.5 * pk;
  // arazinin altına girme
  pos.y = Math.max(pos.y, minY(pos.x, pos.z, 1.8));
  // kip geçişlerinde yumuşatma payı (ilk 1.2 sn)
  const blend = smooth(0, 1.2, ph.into);
  return { pos, look, fov, mode: ph.mode, blend, phase: ph };
}

// ---------- Kalite yöneticisi: kare süresi penceresine göre seviye düşür/yükselt (histerezis) ----------
export const QUALITY_LEVELS = [
  { name: 'ultra', pixelRatio: 1.5, particles: 1, fog: true, shadows: false, terrainSeg: 1 },
  { name: 'high', pixelRatio: 1.25, particles: 1, fog: true, shadows: false, terrainSeg: 1 },
  { name: 'medium', pixelRatio: 1, particles: 0.6, fog: true, shadows: false, terrainSeg: 1 },
  { name: 'low', pixelRatio: 0.75, particles: 0.3, fog: true, shadows: false, terrainSeg: 1 },
  { name: 'potato', pixelRatio: 0.55, particles: 0, fog: false, shadows: false, terrainSeg: 1 },
];
/** push(frameMs) → değişti mi (true/false). level(), stats(). Hedef 16.7 ms; 1 sn'lik pencere ortalaması > downMs → düşür; < upMs 3 pencere → yükselt. */
export function createQualityGovernor({ start = 1, downMs = 26, upMs = 13, windowFrames = 45 } = {}) {
  let level = clamp(start, 0, QUALITY_LEVELS.length - 1), acc = 0, n = 0, goodWindows = 0, worst = 0, lastAvg = 0, frames = 0;
  return {
    push(ms) {
      if (!(ms > 0) || ms > 500) return false;   // sekme gizliyken/odak dönüşünde dev dt yoksay
      acc += ms; n++; frames++; worst = Math.max(worst, ms);
      if (n < windowFrames) return false;
      const avg = acc / n; lastAvg = avg; acc = 0; n = 0;
      if (avg > downMs && level < QUALITY_LEVELS.length - 1) { level++; goodWindows = 0; return true; }
      if (avg < upMs) { if (++goodWindows >= 3 && level > 0) { level--; goodWindows = 0; return true; } }
      else goodWindows = 0;
      return false;
    },
    level: () => QUALITY_LEVELS[level],
    index: () => level,
    stats: () => ({ level: QUALITY_LEVELS[level].name, avgMs: Math.round(lastAvg * 10) / 10, worstMs: Math.round(worst * 10) / 10, frames }),
  };
}

// ---------- Gün batımı paleti (saf) ----------
export const DUSK = {
  sky: 0x1b2446, horizon: 0xff9a5c, sun: 0xffb27a, fog: 0x8a6e8c, ambient: 0x5a6fa0,
  light: { sky: 0xeaf0ff, horizon: 0xffc9a0, sun: 0xfff1dc, fog: 0xdfe7f5, ambient: 0xb9c7e6 },
};
export const pick = (light, k) => (light ? DUSK.light[k] : DUSK[k]);
