// Uçuş Simülatörü §47 — HAZIR FPV PARKURU 3B katmanı (HEPGO + SIMUMAV ortak). TEK WebGL renderer: flightsim3d.js nesnesinin `three`, `scene`,
// `homeAlt`, `addFrameHook`, `position()`, `getGraphics()`, `terrainHeight` alanlarını kullanır; yeni renderer / bağlam AÇMAZ.
// • Parkur merkezi = karşılaşma merkezi = sim'in yerel orijini (x doğu, y kuzey, z yukarı; sahne z'si alt_rel ölçeğinde). Parkur z'si ZEMİNDEN; kontrol
//   noktalarının alt_msl'i MSL → taban ofseti zOff = alt_msl − z − homeAlt (flightsim_match.ringLocal mantığı; prosedürel düz merkezde ≈ 0).
// • Engeller/dekor: ilkeller (box — delikli kutu deliğin çevresindeki parçalara bölünür —, cyl, sph, pipe, torus) aynı geometri + malzeme başına
//   InstancedMesh (ağaç gövdesi/tacı, raf, boru, direk, konteyner…); malzeme dokuları kodla (CanvasTexture) ve dünya koordinatlı üç düzlemli (triplanar)
//   örnekleme — büyük duvarda tuğla/oluklu sac ölçeği doğru. `vis:false` ilkeller (kapı çerçevesi çarpışma kutuları) ÇİZİLMEZ.
// • Kapılar: NEON çerçeveler (dikdörtgen / çember / yatay dalış kapısı / merdiven / tünel girişi-çıkışı / pencere boşluğu astarı), bayrak ve slalom
//   direkleri (kumaş + dönüş yönü oku). SIRADAKİ kapı YEŞİL (nabız), sonraki iki kapı PEMBE / MOR, diğerleri sönük; sıradakinde yön okları (kayan
//   şeritler), dronun önünden kapı merkezine İNCE KILAVUZ ÇİZGİSİ + sıradaki yarış hattı parçası noktalı; başlangıç pedinde YERDE PARLAYAN YEŞİL HALKALAR.
//   Neon malzemeler ton eşlemesiz HDR renk (Yüksek/Ultra son işleminde bloom) + ucuz katkısal hale (Düşük'te de parlak görünür).
// • Ortam (`envAtmosphere`): kapalı hangar sıcak tavan lambaları + toz sisi, sisli altın saat (ahşap ev), gece stadyumu projektörleri + ışık konileri,
//   pus (şehir), kapalı hava (orman), kanyon şelalesi (akan su perdesi + sis parçacıkları); zemin örtüsü mekana göre (beton derzleri, orman tabanı,
//   asfalt, çim saha çizgileri, sanayi, kaya, çayır, toprak). §43 kalite kademesi: Düşük → gölge yok, dekor/ışık/parçacık azalır; Orta+ gölge.
// • Hayalet: kişisel rekor örnekleri (decodeGhost) yarış saatine göre (update(raceT)) yarı saydam dron + ad etiketi.
// API: createFpvCourseLayer(sim, course, {checkpoints, quality, me, T, ghostColor}) → { setProgress(next), setGhost(samples|null, {color, name}),
//   update(raceTimeS), flash(kind, gateIdx?), setQuality(level), setGuide(bool), info(), stats(), dispose() }.
import { GATE_COLORS, GROUND_COLORS, envAtmosphere, fwdOf, gateAxes, gateOpening, gateStates, ghostPoseAt, levelIndex, matColor, nextCheckpoint, rightOf, startSlots } from './flightsim_fpvcourse.js';

const TAU = Math.PI * 2;
const hash = (a, b = 0, c = 0) => { let h = Math.imul((a * 73856093) ^ (b * 19349663) ^ (c * 83492791), 2654435761) >>> 0; h ^= h >>> 15; return (h % 10000) / 10000; };

// ---------------------------------------------------------------- saf: delikli kutuyu parçalara böl (test edilir)
/** Kutu e {w, d, h, holes:[{u, v, w, h}], axis 'y'|'z'} → yerel parçalar [{u0, u1, v0, v1, z0, z1}] (u sağ −w/2…w/2, v ileri −d/2…d/2, z tabandan 0…h).
 *  axis 'y': delikler u–z düzleminde, kutunun ileri ekseni boyunca açık (pencere / kapı / tünel); 'z': u–v düzleminde (döşeme boşluğu). */
export function splitBoxHoles(e) {
  const W = Number(e.w), D = Number(e.d), H = Number(e.h), ax = e.axis === 'z' ? 'z' : 'y';
  const holes = (e.holes || []).map(hl => {
    const a0 = Math.max(-W / 2, hl.u - hl.w / 2), a1 = Math.min(W / 2, hl.u + hl.w / 2);
    const [lo, hi] = ax === 'y' ? [0, H] : [-D / 2, D / 2];
    const b0 = Math.max(lo, hl.v - hl.h / 2), b1 = Math.min(hi, hl.v + hl.h / 2);
    return a1 - a0 > 1e-4 && b1 - b0 > 1e-4 ? { a0, a1, b0, b1 } : null;
  }).filter(Boolean);
  const full = { u0: -W / 2, u1: W / 2, v0: -D / 2, v1: D / 2, z0: 0, z1: H };
  if (!holes.length) return [full];
  const [B0, B1] = ax === 'y' ? [0, H] : [-D / 2, D / 2];
  const br = [...new Set([B0, B1, ...holes.flatMap(x => [x.b0, x.b1])])].sort((a, b) => a - b);
  const bands = [];
  for (let k = 0; k < br.length - 1; k++) {
    const b0 = br[k], b1 = br[k + 1];
    if (b1 - b0 < 1e-4) continue;
    const cov = holes.filter(x => x.b0 <= b0 + 1e-6 && x.b1 >= b1 - 1e-6).map(x => [x.a0, x.a1]).sort((p, q) => p[0] - q[0]);
    const free = [];
    let cur = -W / 2;
    for (const [a0, a1] of cov) { if (a0 > cur + 1e-4) free.push([cur, a0]); cur = Math.max(cur, a1); }
    if (W / 2 > cur + 1e-4) free.push([cur, W / 2]);
    bands.push({ b0, b1, free });
  }
  // dikey birleştirme: ardışık bantlarda aynı aralık → tek parça
  const out = [], open = new Map();
  for (const bd of bands) {
    const keys = new Set(bd.free.map(([a, b]) => `${a.toFixed(4)}|${b.toFixed(4)}`));
    for (const [k, p] of open) if (!keys.has(k) || Math.abs(p.b1 - bd.b0) > 1e-6) { out.push(p); open.delete(k); }
    for (const [a, b] of bd.free) { const k = `${a.toFixed(4)}|${b.toFixed(4)}`; const p = open.get(k); if (p) p.b1 = bd.b1; else open.set(k, { a0: a, a1: b, b0: bd.b0, b1: bd.b1 }); }
  }
  for (const p of open.values()) out.push(p);
  return out.map(p => (ax === 'y' ? { u0: p.a0, u1: p.a1, v0: -D / 2, v1: D / 2, z0: p.b0, z1: p.b1 } : { u0: p.a0, u1: p.a1, v0: p.b0, v1: p.b1, z0: 0, z1: H }));
}

// ---------------------------------------------------------------- prosedürel dokular (CanvasTexture; dış dosya yok)
function canvas(n) { const cv = document.createElement('canvas'); cv.width = cv.height = n; return cv; }
function rng(seed) { let s = seed >>> 0 || 1; return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; }; }
function noiseFill(g, n, base, amp, r, blobs = 900, sz = [2, 10]) {
  g.fillStyle = base; g.fillRect(0, 0, n, n);
  for (let i = 0; i < blobs; i++) { const v = Math.round(128 + (r() - 0.5) * 2 * amp); g.fillStyle = `rgba(${v},${v},${v},${0.08 + r() * 0.12})`; const s = sz[0] + r() * (sz[1] - sz[0]); g.fillRect(r() * n, r() * n, s, s); }
}
const TEXDEF = {
  noise: (g, n, r) => noiseFill(g, n, '#e6e6e6', 90, r, 1400, [1, 9]),
  rock: (g, n, r) => { noiseFill(g, n, '#d6d6d6', 120, r, 1800, [2, 18]); g.strokeStyle = 'rgba(40,40,40,.35)'; g.lineWidth = 1.5; for (let i = 0; i < 26; i++) { g.beginPath(); let x = r() * n, y = r() * n; g.moveTo(x, y); for (let k = 0; k < 6; k++) { x += (r() - 0.5) * 40; y += r() * 28; g.lineTo(x, y); } g.stroke(); } },
  brick: (g, n, r) => { g.fillStyle = '#bdbdbd'; g.fillRect(0, 0, n, n); const bh = n / 8, bw = n / 4; for (let row = 0; row < 8; row++) for (let c = -1; c < 5; c++) { const x = c * bw + (row % 2 ? bw / 2 : 0); const v = Math.round(200 + (r() - 0.5) * 70); g.fillStyle = `rgb(${v},${v},${v})`; g.fillRect(x + 2, row * bh + 2, bw - 4, bh - 4); } },
  wood: (g, n, r) => { g.fillStyle = '#d8d8d8'; g.fillRect(0, 0, n, n); const pw = n / 6; for (let k = 0; k < 6; k++) { const v = Math.round(205 + (r() - 0.5) * 50); g.fillStyle = `rgb(${v},${v},${v})`; g.fillRect(k * pw + 1, 0, pw - 2, n); g.strokeStyle = 'rgba(80,80,80,.18)'; for (let j = 0; j < 7; j++) { g.beginPath(); const x0 = k * pw + r() * pw; g.moveTo(x0, 0); g.bezierCurveTo(x0 + 6, n / 3, x0 - 6, 2 * n / 3, x0 + (r() - 0.5) * 8, n); g.stroke(); } } },
  corrug: (g, n, r) => { const k = 16; for (let i = 0; i < k; i++) { const gr = g.createLinearGradient(i * n / k, 0, (i + 1) * n / k, 0); gr.addColorStop(0, '#9c9c9c'); gr.addColorStop(0.5, '#f0f0f0'); gr.addColorStop(1, '#a8a8a8'); g.fillStyle = gr; g.fillRect(i * n / k, 0, n / k + 1, n); } noiseFill(g, n, 'rgba(0,0,0,0)', 60, r, 300, [1, 6]); },
  stripe: (g, n) => { for (let i = 0; i < 8; i++) { g.fillStyle = i % 2 ? '#ffffff' : '#8a8a8a'; g.fillRect(0, i * n / 8, n, n / 8); } },
  grid: (g, n) => { g.fillStyle = '#d0d0d0'; g.fillRect(0, 0, n, n); g.fillStyle = '#2a2a2a'; const s = n / 16; for (let i = 0; i < 16; i++) for (let j = 0; j < 16; j++) g.fillRect(i * s + 2, j * s + 2, s - 4, s - 4); },
  seats: (g, n, r) => { g.fillStyle = '#9a9a9a'; g.fillRect(0, 0, n, n); const s = n / 8; for (let i = 0; i < 8; i++) for (let j = 0; j < 8; j++) { const v = Math.round(215 + (r() - 0.5) * 40); g.fillStyle = `rgb(${v},${v},${v})`; g.fillRect(i * s + 3, j * s + 4, s - 6, s * 0.55); } },
  straw: (g, n, r) => { g.fillStyle = '#d9d9d9'; g.fillRect(0, 0, n, n); g.strokeStyle = 'rgba(90,90,90,.35)'; for (let i = 0; i < 500; i++) { const x = r() * n, y = r() * n; g.beginPath(); g.moveTo(x, y); g.lineTo(x + (r() - 0.5) * 18, y + (r() - 0.5) * 6); g.stroke(); } },
};
// 3B malzeme ayrıntıları: doku (TEXDEF), dünya ölçeği (1/m), pürüzlülük, metal
const M3 = {
  concrete: ['noise', 0.22, 0.92, 0], hangar_wall: ['corrug', 0.6, 0.65, 0.35], hangar_roof: ['corrug', 0.6, 0.8, 0.3], steel_beam: [null, 0, 0.5, 0.6], rack: [null, 0, 0.55, 0.45],
  crate: ['wood', 0.7, 0.9, 0], block: ['brick', 0.55, 0.92, 0], duct: [null, 0, 0.35, 0.8], forklift: [null, 0, 0.5, 0.3], pallet: ['wood', 1.2, 0.9, 0], truss: [null, 0, 0.45, 0.65],
  log: ['wood', 0.5, 0.95, 0], bark: ['rock', 0.9, 0.95, 0], needle: [null, 0, 1, 0], leaf: [null, 0, 1, 0], bush: [null, 0, 1, 0], rock: ['rock', 0.45, 0.95, 0], brick: ['brick', 0.42, 0.92, 0],
  plaster: ['noise', 0.3, 0.95, 0], slab: ['noise', 0.25, 0.9, 0], bridge: ['noise', 0.25, 0.85, 0.05], rubble: ['rock', 0.8, 0.95, 0], pole: [null, 0, 0.5, 0.5], stand: ['seats', 0.9, 0.8, 0.05],
  steel: [null, 0, 0.42, 0.7], inflatable: ['stripe', 0.5, 0.55, 0], scaffold: [null, 0, 0.45, 0.75], steel_frame: [null, 0, 0.5, 0.6], pipe: [null, 0, 0.35, 0.75], pipe_insulated: ['corrug', 1.5, 0.55, 0.3],
  grating: ['grid', 2.0, 0.6, 0.6], railing_yellow: [null, 0, 0.5, 0.2], tank: ['corrug', 0.35, 0.5, 0.45], container_0: ['corrug', 0.9, 0.6, 0.35], container_1: ['corrug', 0.9, 0.6, 0.35],
  container_2: ['corrug', 0.9, 0.6, 0.35], container_3: ['corrug', 0.9, 0.6, 0.35], chimney: ['brick', 0.5, 0.9, 0], rock_wall: ['rock', 0.12, 0.97, 0], rock_arch: ['rock', 0.14, 0.97, 0],
  timber: ['wood', 0.9, 0.85, 0], planks: ['wood', 0.8, 0.85, 0], hay: ['straw', 0.8, 1, 0], concrete_raw: ['noise', 0.3, 0.95, 0], slab_raw: ['noise', 0.25, 0.95, 0], scaffold_deck: ['wood', 1, 0.9, 0],
  crane: [null, 0, 0.5, 0.4], rebar: ['rock', 1.5, 0.7, 0.5], frame: [null, 0, 0.6, 0.3],
};

// ---------------------------------------------------------------- zemin örtüsü dokusu (mekana göre; tek tuval, parkur alanını kaplar)
function groundCanvas(type, n, wM, dM, r) {
  const cv = canvas(n), g = cv.getContext('2d');
  const base = `#${(GROUND_COLORS[type] ?? 0x666666).toString(16).padStart(6, '0')}`;
  const pxm = n / Math.max(wM, dM);   // piksel / m (kare tuval; uzun kenara göre)
  const M = (x, y) => [n / 2 + x * pxm, n / 2 - y * pxm];
  const speck = (cols, k, s0, s1, a0 = 0.15, a1 = 0.4) => { for (let i = 0; i < k; i++) { g.fillStyle = cols[Math.floor(r() * cols.length)]; g.globalAlpha = a0 + r() * (a1 - a0); const s = s0 + r() * (s1 - s0); g.beginPath(); g.ellipse(r() * n, r() * n, s, s * (0.5 + r() * 0.5), r() * 3, 0, TAU); g.fill(); } g.globalAlpha = 1; };
  g.fillStyle = base; g.fillRect(0, 0, n, n);
  switch (type) {
    case 'concrete': case 'industrial': {
      speck(['#5f5f62', '#8a898c', '#6d6c70'], 900, 2, 14, 0.08, 0.25);
      g.strokeStyle = 'rgba(30,30,30,.45)'; g.lineWidth = Math.max(1, pxm * 0.04);
      const step = 6 * pxm; for (let x = n / 2 % step; x < n; x += step) { g.beginPath(); g.moveTo(x, 0); g.lineTo(x, n); g.stroke(); } for (let y = n / 2 % step; y < n; y += step) { g.beginPath(); g.moveTo(0, y); g.lineTo(n, y); g.stroke(); }
      if (type === 'industrial') { speck(['#2a2622', '#3a342c'], 60, 6, 30, 0.2, 0.45); }   // yağ lekeleri
      g.strokeStyle = '#e8b417'; g.lineWidth = Math.max(2, pxm * 0.15); g.globalAlpha = 0.85;   // sarı güvenlik şeritleri
      const lane = (x0, y0, x1, y1) => { const a = M(x0, y0), b = M(x1, y1); g.beginPath(); g.moveTo(a[0], a[1]); g.lineTo(b[0], b[1]); g.stroke(); };
      lane(-wM / 2 + 2, -dM / 2 + 3, wM / 2 - 2, -dM / 2 + 3); lane(-wM / 2 + 2, dM / 2 - 3, wM / 2 - 2, dM / 2 - 3); lane(-wM / 2 + 2, 0.0 - 1.4, wM / 2 - 2, -1.4); g.globalAlpha = 1;
      break;
    }
    case 'forest': speck(['#2b331d', '#4a3a24', '#55603a', '#6b5a3a', '#26301a'], 2600, 2, 16, 0.2, 0.55); speck(['#8a6a3c'], 500, 1, 3, 0.3, 0.6); break;
    case 'asphalt': {
      speck(['#2c2e33', '#55575c', '#46484c'], 1400, 1, 9, 0.1, 0.35);
      g.strokeStyle = 'rgba(15,15,15,.6)'; g.lineWidth = 1.2; for (let i = 0; i < 40; i++) { g.beginPath(); let x = r() * n, y = r() * n; g.moveTo(x, y); for (let k = 0; k < 5; k++) { x += (r() - 0.5) * 50; y += (r() - 0.5) * 50; g.lineTo(x, y); } g.stroke(); }
      g.strokeStyle = 'rgba(235,235,220,.6)'; g.setLineDash([3 * pxm, 3 * pxm]); g.lineWidth = Math.max(2, 0.15 * pxm); for (const yy of [-12, 8]) { const a = M(-wM / 2, yy), b = M(wM / 2, yy); g.beginPath(); g.moveTo(a[0], a[1]); g.lineTo(b[0], b[1]); g.stroke(); } g.setLineDash([]);
      speck(['#7a7468', '#5d5850'], 80, 4, 18, 0.25, 0.5);   // moloz tozu
      break;
    }
    case 'turf': {
      const sw = 8 * pxm; for (let i = 0; i * sw < n + sw; i++) { g.fillStyle = i % 2 ? '#2c6a2c' : '#357a33'; g.fillRect(i * sw - (n / 2 % sw), 0, sw, n); }
      speck(['#24581f', '#3c8a38'], 1200, 1, 4, 0.15, 0.35);
      g.strokeStyle = 'rgba(245,245,245,.85)'; g.lineWidth = Math.max(2, 0.12 * pxm);
      const fw = Math.min(105, wM - 8), fd = Math.min(68, dM - 8), [ax, ay] = M(-fw / 2, fd / 2);
      g.strokeRect(ax, ay, fw * pxm, fd * pxm); const [mx] = M(0, 0); g.beginPath(); g.moveTo(mx, ay); g.lineTo(mx, ay + fd * pxm); g.stroke();
      g.beginPath(); g.arc(n / 2, n / 2, 9.15 * pxm, 0, TAU); g.stroke();
      for (const s of [-1, 1]) { const [bx, by] = M(s * fw / 2 - (s > 0 ? 16.5 : 0), 20.15); g.strokeRect(bx, by, 16.5 * pxm, 40.3 * pxm); }
      break;
    }
    case 'rock': speck(['#7a6650', '#9a8366', '#6b5844', '#a89074'], 2200, 2, 22, 0.15, 0.45); speck(['#5a6a7a'], 30, 10, 40, 0.1, 0.2); break;
    case 'meadow': speck(['#5f7d33', '#7f9a44', '#4f6b2a', '#8aa04a'], 2800, 2, 14, 0.2, 0.5); speck(['#e8e2a0', '#f2f2f2', '#d8b04a', '#c070c0'], 500, 0.8, 2, 0.6, 0.9); break;
    case 'dirt': {
      speck(['#7a6046', '#9a7d5c', '#6a523c', '#5a4632'], 2400, 2, 18, 0.15, 0.45);
      g.strokeStyle = 'rgba(60,45,30,.45)'; g.lineWidth = Math.max(2, 0.3 * pxm); for (let k = 0; k < 4; k++) { g.beginPath(); const y = r() * n; g.moveTo(0, y); g.bezierCurveTo(n / 3, y + (r() - 0.5) * n * 0.4, 2 * n / 3, y + (r() - 0.5) * n * 0.4, n, y + (r() - 0.5) * 60); g.stroke(); }
      break;
    }
    default: speck(['#555', '#777'], 800, 2, 10);
  }
  // kenar: tuval kenarına doğru saydamlaşır (arazi ile yumuşak geçiş)
  const gr = g.createRadialGradient(n / 2, n / 2, n * 0.36, n / 2, n / 2, n * 0.5);
  gr.addColorStop(0, 'rgba(0,0,0,1)'); gr.addColorStop(1, 'rgba(0,0,0,0)');
  g.globalCompositeOperation = 'destination-in'; g.fillStyle = gr; g.fillRect(0, 0, n, n); g.globalCompositeOperation = 'source-over';
  return cv;
}

// ---------------------------------------------------------------- katman
// Bayram süsü engel bölgeleri [{x, y, r}] (yerel m): parkur alanı (env.size'ı kapsayan daire), her kapı/direk ve başlangıç pedi (8 oyuncu ızgarası)
export function fpvKeepouts(course) {
  const out = [];
  const sz = course?.env?.size;
  if (Array.isArray(sz) && sz.length >= 2) out.push({ x: 0, y: 0, r: Math.round(Math.hypot(Number(sz[0]) || 0, Number(sz[1]) || 0) / 2 + 12) });
  for (const g of course?.gates || []) out.push({ x: Number(g.x) || 0, y: Number(g.y) || 0, r: Math.max(Number(g.w) || 3, Number(g.h) || 3) + 6 });
  const st = course?.start;
  if (st) out.push({ x: Number(st.x) || 0, y: Number(st.y) || 0, r: 15 });
  return out;
}

export function createFpvCourseLayer(sim, course, o = {}) {
  const T = sim.three, scene = sim.scene;
  const root = new T.Group(); root.name = 'fpv-course';
  scene.add(root);
  const disposables = new Set(), keep = x => { if (x) disposables.add(x); return x; };
  const cps = o.checkpoints || [];
  const homeAlt = Number(sim.homeAlt ?? 0);
  const cp0 = cps.find(c => c.alt_msl != null && c.z != null);
  const zOff = cp0 ? Number(cp0.alt_msl) - Number(cp0.z) - homeAlt : 0;
  root.position.z = Number.isFinite(zOff) ? zOff : 0;
  const env = course.env || {};
  const gfxLevel = () => o.quality || sim.getGraphics?.()?.level || 'high';
  let level = gfxLevel();
  let atm = envAtmosphere(env, level);
  const shadowOn = () => { const g = sim.getGraphics?.(); return !!(g ? g.shadow > 0 && g.objCast !== false : atm.shadows); };
  const R = rng(0x5eed ^ (course.id || 'x').split('').reduce((a, c) => a * 31 + c.charCodeAt(0), 7));

  // ---- dokular + malzemeler
  const texCache = new Map();
  const texture = key => {
    if (!TEXDEF[key]) return null;
    if (!texCache.has(key)) {
      const n = levelIndex(level) === 0 ? 128 : 256, cv = canvas(n);
      TEXDEF[key](cv.getContext('2d'), n, rng(key.length * 977 + 3));
      const tx = keep(new T.CanvasTexture(cv)); tx.wrapS = tx.wrapT = T.RepeatWrapping; tx.colorSpace = T.SRGBColorSpace; tx.anisotropy = 4;
      texCache.set(key, tx);
    }
    return texCache.get(key);
  };
  // dünya koordinatlı üç düzlemli doku örneklemesi (InstancedMesh örnek matrisi dahil)
  const triplanar = (m, scale) => {
    m.onBeforeCompile = sh => {
      sh.uniforms.fpvScale = { value: scale };
      sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nvarying vec3 vFpvW; varying vec3 vFpvN;')
        .replace('#include <project_vertex>', `#include <project_vertex>
          vec4 fpvW = vec4(transformed, 1.0); vec3 fpvN = objectNormal;
          #ifdef USE_INSTANCING
            fpvW = instanceMatrix * fpvW; fpvN = mat3(instanceMatrix) * fpvN;
          #endif
          vFpvW = (modelMatrix * fpvW).xyz; vFpvN = normalize(mat3(modelMatrix) * fpvN);`);
      sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nvarying vec3 vFpvW; varying vec3 vFpvN; uniform float fpvScale;')
        .replace('#include <map_fragment>', `#ifdef USE_MAP
          vec3 fpvB = pow(abs(vFpvN), vec3(4.0)); fpvB /= max(1e-4, fpvB.x + fpvB.y + fpvB.z);
          vec3 fpvP = vFpvW * fpvScale;
          vec4 fpvT = texture2D(map, fpvP.yz) * fpvB.x + texture2D(map, fpvP.xz) * fpvB.y + texture2D(map, fpvP.xy) * fpvB.z;
          diffuseColor *= fpvT;
        #endif`);
    };
    m.customProgramCacheKey = () => `fpvtri${scale}`;
    return m;
  };
  const matCache = new Map();
  const mat = (key) => {
    if (matCache.has(key)) return matCache.get(key);
    const d = M3[key] || M3.frame, col = new T.Color(matColor(key));
    let m;
    if (key === 'waterfall') m = new T.MeshStandardMaterial({ color: 0xdff1ff, emissive: 0x6aa6d8, emissiveIntensity: 0.25, transparent: true, opacity: 0.78, roughness: 0.2, metalness: 0, side: T.DoubleSide, depthWrite: false });
    else if (key === 'water') m = new T.MeshStandardMaterial({ color: 0x2f6f9a, roughness: 0.12, metalness: 0.35, transparent: true, opacity: 0.88 });
    else {
      m = new T.MeshStandardMaterial({ color: col, roughness: d[2], metalness: d[3] });
      const tx = d[0] ? texture(d[0]) : null;
      if (tx) { m.map = tx; triplanar(m, d[1]); }
      if (key === 'inflatable') { m.emissive = new T.Color(0x7f1010); m.emissiveIntensity = 0.35; }
      if (key === 'railing_yellow' || key === 'forklift' || key === 'crane') { m.emissive = col.clone().multiplyScalar(0.12); }
    }
    keep(m); matCache.set(key, m);
    return m;
  };

  // ---- geometriler (paylaşılan birim)
  const geo = {};
  const G = (k, mk) => (geo[k] ??= keep(mk()));
  const unitBox = () => G('box', () => new T.BoxGeometry(1, 1, 1));
  const unitCyl = seg => G(`cyl${seg}`, () => { const g = new T.CylinderGeometry(1, 1, 1, seg, 1); g.rotateX(Math.PI / 2); g.translate(0, 0, 0.5); return g; });
  const unitPipe = seg => G(`pipe${seg}`, () => new T.CylinderGeometry(1, 1, 1, seg, 1));
  const unitCone = () => G('cone', () => { const g = new T.ConeGeometry(1, 1, 9, 1); g.rotateX(Math.PI / 2); return g; });
  const unitIco = () => G('ico', () => new T.IcosahedronGeometry(1, 1));
  const unitRock = () => G('rock', () => new T.DodecahedronGeometry(1, 0));
  const unitSph = () => G('sph', () => new T.SphereGeometry(1, 12, 8));

  // ---- instancing: (geometri, malzeme) → örnek listesi
  const inst = new Map();
  const m4 = new T.Matrix4(), q = new T.Quaternion(), v3 = new T.Vector3(), s3 = new T.Vector3(), up = new T.Vector3(0, 1, 0), ZAX = new T.Vector3(0, 0, 1);
  const add = (gk, g, mk, pos, quat, scale, tint = 0, cast = true, recv = true) => {
    const k = `${gk}|${mk}`;
    let L = inst.get(k);
    if (!L) { L = { g, m: mat(mk), mats: [], cols: [], cast, recv }; inst.set(k, L); }
    L.mats.push(new T.Matrix4().compose(pos, quat, scale));
    L.cols.push(tint);
    L.cast = L.cast || cast;
  };
  const qYaw = yawDeg => new T.Quaternion().setFromAxisAngle(ZAX, -Number(yawDeg || 0) * Math.PI / 180);
  const seg = levelIndex(level) === 0 ? 8 : 12;
  function addPrim(e, isDecor = false) {
    if (e.vis === false) return;
    const mk = e.mat || 'frame';
    if (mk === 'waterfall' || mk === 'water') { waterPlane(e); return; }
    const tint = (hash(Math.round((e.x ?? e.a?.[0] ?? 0) * 10), Math.round((e.y ?? e.a?.[1] ?? 0) * 10), mk.length) - 0.5) * 0.18;
    if (e.t === 'box') {
      const parts = e.holes?.length ? splitBoxHoles(e) : [{ u0: -e.w / 2, u1: e.w / 2, v0: -e.d / 2, v1: e.d / 2, z0: 0, z1: e.h }];
      const r = rightOf(e.yaw || 0), f = fwdOf(e.yaw || 0), qq = qYaw(e.yaw);
      for (const p of parts) {
        const uc = (p.u0 + p.u1) / 2, vc = (p.v0 + p.v1) / 2;
        add('box', unitBox(), mk, new T.Vector3(e.x + r[0] * uc + f[0] * vc, e.y + r[1] * uc + f[1] * vc, e.z + (p.z0 + p.z1) / 2), qq,
          new T.Vector3(Math.max(0.01, p.u1 - p.u0), Math.max(0.01, p.v1 - p.v0), Math.max(0.01, p.z1 - p.z0)), tint, !isDecor || e.h > 1.5);
      }
      return;
    }
    if (e.t === 'cyl') {
      const big = e.r > 1.2;
      add(`cyl${big ? 24 : seg}`, unitCyl(big ? 24 : seg), mk, new T.Vector3(e.x, e.y, e.z), q.identity().clone(), new T.Vector3(e.r, e.r, e.h), tint);
      if (e.part === 'floodlight') floodHead(e);
      return;
    }
    if (e.t === 'sph') {
      if (mk === 'needle') { add('cone', unitCone(), mk, new T.Vector3(e.x, e.y, e.z + e.r * 0.3), new T.Quaternion(), new T.Vector3(e.r * 1.05, e.r * 1.05, e.r * 2.5), tint, true); return; }
      if (mk === 'leaf' || mk === 'bush') { add('ico', unitIco(), mk, new T.Vector3(e.x, e.y, e.z), new T.Quaternion().setFromAxisAngle(ZAX, tint * 20), new T.Vector3(e.r, e.r, e.r * (mk === 'bush' ? 0.7 : 0.9)), tint, mk === 'leaf'); return; }
      if (mk === 'rock' || mk === 'rubble') { add('rock', unitRock(), mk, new T.Vector3(e.x, e.y, e.z), new T.Quaternion().setFromEuler(new T.Euler(tint * 9, tint * 13, tint * 31)), new T.Vector3(e.r * 1.1, e.r, e.r * 0.75), tint, e.r > 0.8); return; }
      add('sph', unitSph(), mk, new T.Vector3(e.x, e.y, e.z), new T.Quaternion(), new T.Vector3(e.r, e.r, e.r), tint);
      return;
    }
    if (e.t === 'pipe') {
      const a = new T.Vector3(...e.a), b = new T.Vector3(...e.b), d = b.clone().sub(a), L = d.length();
      if (L < 1e-3) return;
      const sg = e.r > 0.3 ? 16 : seg;
      add(`pipe${sg}`, unitPipe(sg), mk, a.clone().add(b).multiplyScalar(0.5), new T.Quaternion().setFromUnitVectors(up, d.normalize()), new T.Vector3(e.r, L, e.r), tint);
      return;
    }
    if (e.t === 'torus') {
      const m = new T.Mesh(keep(new T.TorusGeometry(e.R, e.tube, 8, 32)), mat(mk));
      m.position.set(e.x, e.y, e.z); m.quaternion.setFromUnitVectors(ZAX, e.flat ? ZAX : new T.Vector3(...fwdOf(e.yaw || 0))); root.add(m);
    }
  }

  let _dot = null;
  const roundDot = () => (_dot ??= (() => { const cv = canvas(32), g = cv.getContext('2d'); const gr = g.createRadialGradient(16, 16, 0, 16, 16, 15); gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(1, 'rgba(255,255,255,0)'); g.fillStyle = gr; g.fillRect(0, 0, 32, 32); return keep(new T.CanvasTexture(cv)); })());
  // ---- su / şelale (akan doku)
  const flows = [];
  function waterPlane(e) {
    const flowTex = (() => {
      const cv = canvas(128), g = cv.getContext('2d');
      g.fillStyle = '#9fc9ee'; g.fillRect(0, 0, 128, 128);
      for (let i = 0; i < 120; i++) { g.fillStyle = `rgba(255,255,255,${0.15 + R() * 0.5})`; g.fillRect(R() * 128, R() * 128, 1 + R() * 2, 10 + R() * 40); }
      const t = keep(new T.CanvasTexture(cv)); t.wrapS = t.wrapT = T.RepeatWrapping; t.colorSpace = T.SRGBColorSpace; return t;
    })();
    const m = mat(e.mat).clone(); keep(m); m.map = flowTex;
    if (e.mat === 'waterfall') {
      const pl = new T.Mesh(keep(new T.PlaneGeometry(e.w, e.h)), m);
      const f = fwdOf(e.yaw || 0);
      pl.position.set(e.x, e.y, e.z + e.h / 2); pl.quaternion.setFromUnitVectors(new T.Vector3(0, 0, 1), new T.Vector3(f[0], f[1], 0)); pl.renderOrder = 3;
      flowTex.repeat.set(e.w / 4, e.h / 6);
      root.add(pl); flows.push({ tex: flowTex, k: 0.9 });
      if (atm.mist) {   // şelale dibi sis/su zerresi parçacıkları
        const n = atm.mist, pos = new Float32Array(n * 3);
        for (let i = 0; i < n; i++) { pos[i * 3] = e.x + (R() - 0.5) * e.w * 1.2; pos[i * 3 + 1] = e.y + (R() - 0.5) * 4; pos[i * 3 + 2] = e.z + R() * 3.5; }
        const pg = keep(new T.BufferGeometry()); pg.setAttribute('position', new T.BufferAttribute(pos, 3));
        const pts = new T.Points(pg, keep(new T.PointsMaterial({ color: 0xeaf6ff, size: 0.45, map: roundDot(), transparent: true, opacity: 0.5, depthWrite: false, alphaTest: 0.03 })));
        root.add(pts); flows.push({ pts, base: pos.slice(), z0: e.z });
      }
    } else {
      const pl = new T.Mesh(keep(new T.PlaneGeometry(e.w, e.d)), m);
      pl.position.set(e.x, e.y, e.z + (e.h || 0.1)); pl.rotation.z = -(e.yaw || 0) * Math.PI / 180; pl.receiveShadow = true;
      flowTex.repeat.set(e.w / 6, e.d / 6); root.add(pl); flows.push({ tex: flowTex, k: 0.15 });
    }
  }

  // ---- ışıklar (mekana göre; kaliteyle sayı)
  const lightGroup = new T.Group(); lightGroup.name = 'fpv-lights'; root.add(lightGroup);
  const floodSpots = [];
  function floodHead(e) {   // stadyum projektör direği başı: lamba paneli (emissive) + ışık konisi
    const head = new T.Mesh(unitBox(), keep(new T.MeshBasicMaterial({ color: new T.Color(0xfff6e0).multiplyScalar(2.2), toneMapped: false })));
    const dir = new T.Vector3(-e.x, -e.y, -(e.h - 2)).normalize();
    head.position.set(e.x, e.y, e.z + e.h + 0.8); head.scale.set(4.2, 0.5, 2.4); head.quaternion.setFromUnitVectors(new T.Vector3(0, -1, 0), new T.Vector3(dir.x, dir.y, 0).normalize());
    root.add(head);
    floodSpots.push({ x: e.x, y: e.y, z: e.z + e.h + 0.8, dir });
  }
  function buildLights() {
    while (lightGroup.children.length) { const c = lightGroup.children.pop(); c.dispose?.(); c.traverse?.(x => { x.geometry?.dispose?.(); }); }
    const H = Number(env.ceiling) || 0;
    if (atm.hemi) { const h = new T.HemisphereLight(atm.hemi.sky, atm.hemi.ground, atm.hemi.k); lightGroup.add(h); }
    if (atm.amb) lightGroup.add(new T.AmbientLight(atm.amb.color, atm.amb.k));
    if (atm.sun) {
      const el = atm.sun.el * Math.PI / 180, az = atm.sun.az * Math.PI / 180, d = new T.DirectionalLight(atm.sun.color, atm.sun.k);
      d.position.set(Math.sin(az) * Math.cos(el) * 200, Math.cos(az) * Math.cos(el) * 200, Math.sin(el) * 200); d.target.position.set(0, 0, 0);
      lightGroup.add(d, d.target);
    }
    if (atm.lamps && H) {   // tavan lambaları: kiriş altında iki sıra panel + sıcak nokta ışıkları
      const [sw, sd] = env.size || [60, 36], rows = [-sd / 4, sd / 4], cols = Math.max(2, Math.round(atm.lamps / 2));
      const lampMat = keep(new T.MeshBasicMaterial({ color: new T.Color(atm.lampColor).multiplyScalar(2.6), toneMapped: false }));
      const lampGeo = keep(new T.BoxGeometry(2.6, 0.5, 0.12));
      const lampInst = new T.InstancedMesh(lampGeo, lampMat, 12 * 2); let k = 0;
      for (const y of rows) for (let i = 0; i < 6; i++) { const x = -sw / 2 + (i + 0.5) * sw / 6; m4.makeTranslation(x, y, Math.min(7.4, H - 1.6)); lampInst.setMatrixAt(k++, m4); }
      lampInst.count = k; lampInst.instanceMatrix.needsUpdate = true; lampInst.computeBoundingSphere(); lightGroup.add(lampInst);
      for (const y of rows) for (let i = 0; i < cols; i++) {
        const x = -sw / 2 + (i + 0.5) * sw / cols, p = new T.PointLight(atm.lampColor, levelIndex(level) >= 2 ? 90 : 75, 36, 1.25);
        p.position.set(x, y, Math.min(7.0, H - 2)); lightGroup.add(p);
      }
    }
    if (atm.flood && floodSpots.length) {
      const coneMat = keep(new T.MeshBasicMaterial({ color: 0xfff3d6, transparent: true, opacity: 0.07, blending: T.AdditiveBlending, depthWrite: false, side: T.DoubleSide }));
      floodSpots.slice(0, atm.flood).forEach((f, i) => {
        const s = new T.SpotLight(0xfff1d8, 2600, 160, 0.55, 0.45, 1.4);
        s.position.set(f.x, f.y, f.z); s.target.position.set(f.x * 0.15, f.y * 0.15, 0);
        if (atm.floodShadow && i < 2 && shadowOn()) { s.castShadow = true; s.shadow.mapSize.set(1024, 1024); s.shadow.camera.near = 5; s.shadow.camera.far = 160; }
        lightGroup.add(s, s.target);
        const L = Math.hypot(f.x * 0.85, f.y * 0.85, f.z), cone = new T.Mesh(keep(new T.ConeGeometry(Math.tan(0.5) * L, L, 20, 1, true)), coneMat);
        const dir = new T.Vector3(f.x * 0.15 - f.x, f.y * 0.15 - f.y, -f.z).normalize();
        cone.position.set(f.x, f.y, f.z).addScaledVector(dir, L / 2); cone.quaternion.setFromUnitVectors(new T.Vector3(0, -1, 0), dir); cone.renderOrder = 4;
        lightGroup.add(cone);
      });
    }
    if (atm.indoor && atm.mist) {   // hangar içi toz zerresi (ışıkta asılı)
      const [sw, sd] = env.size || [60, 36], n = atm.mist, pos = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) { pos[i * 3] = (R() - 0.5) * sw; pos[i * 3 + 1] = (R() - 0.5) * sd; pos[i * 3 + 2] = 0.5 + R() * ((H || 8) - 1.5); }
      const pg = new T.BufferGeometry(); pg.setAttribute('position', new T.BufferAttribute(pos, 3));
      lightGroup.add(new T.Points(pg, keep(new T.PointsMaterial({ color: 0xffd9a0, size: 0.07, map: roundDot(), transparent: true, opacity: 0.6, depthWrite: false, alphaTest: 0.03 }))));
    }
  }

  // ---- zemin örtüsü
  {
    const [sw, sd] = env.size || [100, 100];
    const W = Math.max(sw, sd) * 1.45 + 30, n = atm.groundTex;
    const tx = keep(new T.CanvasTexture(groundCanvas(env.ground || 'concrete', n, W, W, rng(n + 17)))); tx.colorSpace = T.SRGBColorSpace; tx.anisotropy = 8;
    const gm = keep(new T.MeshStandardMaterial({ map: tx, roughness: env.ground === 'turf' || env.ground === 'meadow' ? 0.95 : 0.88, metalness: 0, transparent: true, depthWrite: true }));
    const gp = new T.Mesh(keep(new T.PlaneGeometry(W, W)), gm);
    gp.position.set(0, 0, 0.03); gp.receiveShadow = true; gp.renderOrder = -1; gp.name = 'fpv-ground';
    root.add(gp);
  }

  // ---- engeller + dekor
  const decorK = atm.decorK;
  for (const e of course.obstacles || []) addPrim(e, false);
  (course.decor || []).forEach((e, i) => { if (decorK >= 1 || hash(i, 7) < decorK || e.mat === 'waterfall' || e.mat === 'water' || e.mat === 'crane') addPrim(e, true); });
  const meshes = [];
  for (const [k, L] of inst) {
    const im = new T.InstancedMesh(L.g, L.m, L.mats.length);
    L.mats.forEach((M, i) => im.setMatrixAt(i, M));
    if (L.cols.some(c => Math.abs(c) > 1e-3)) { const c = new T.Color(); L.cols.forEach((t, i) => { c.setRGB(1 + t, 1 + t * 0.9, 1 + t * 0.8); im.setColorAt(i, c); }); im.instanceColor.needsUpdate = true; }
    im.instanceMatrix.needsUpdate = true; im.computeBoundingSphere();
    im.castShadow = L.cast; im.receiveShadow = L.recv; im.name = `fpv-i:${k}`;
    root.add(im); meshes.push(im);
  }
  const applyShadows = () => { const on = shadowOn(); for (const m of meshes) { m.castShadow = on && inst.get(m.name.slice(6))?.cast; m.receiveShadow = on; } };
  applyShadows();
  buildLights();

  // ---- NEON kapılar
  const neon = {}, halo = {};
  const stateCol = st => new T.Color(GATE_COLORS[st] ?? GATE_COLORS.done);
  for (const st of ['next', 'soon', 'soon2', 'done']) {
    neon[st] = keep(new T.MeshBasicMaterial({ color: stateCol(st).multiplyScalar(st === 'done' ? 0.5 : 2.0), toneMapped: false, transparent: st === 'done', opacity: st === 'done' ? 0.32 : 1, depthWrite: st !== 'done' }));
    halo[st] = keep(new T.MeshBasicMaterial({ color: stateCol(st), transparent: true, opacity: st === 'done' ? 0.0 : 0.16, blending: T.AdditiveBlending, depthWrite: false, toneMapped: false }));
  }
  const frameGeo = (ow, oh, iw, ih, depth) => {   // dikdörtgen çerçeve (merkez 0; X sağ, Y yukarı, Z derinlik)
    const s = new T.Shape(); s.moveTo(-ow / 2, -oh / 2); s.lineTo(ow / 2, -oh / 2); s.lineTo(ow / 2, oh / 2); s.lineTo(-ow / 2, oh / 2); s.closePath();
    const hpath = new T.Path(); hpath.moveTo(-iw / 2, -ih / 2); hpath.lineTo(-iw / 2, ih / 2); hpath.lineTo(iw / 2, ih / 2); hpath.lineTo(iw / 2, -ih / 2); hpath.closePath(); s.holes.push(hpath);
    const g = new T.ExtrudeGeometry(s, { depth, bevelEnabled: false, curveSegments: 1 }); g.translate(0, 0, -depth / 2); return keep(g);
  };
  const basisOf = (gd) => { const { u, v } = gateAxes(gd), U = new T.Vector3(...u), V = new T.Vector3(...v); return new T.Matrix4().makeBasis(U, V, U.clone().cross(V)); };
  const darkMat = mat('steel_beam');
  const gates = (course.gates || []).map((gd, i) => {
    const grp = new T.Group(); grp.name = `fpv-gate-${i}`;
    const parts = { neon: [], halo: [] };
    const c = new T.Vector3(gd.x, gd.y, gd.z), B = basisOf(gd);
    const o = gateOpening(gd);
    const place = (mesh, offN = 0) => { mesh.matrixAutoUpdate = false; const M = B.clone(); const n = new T.Vector3(...gateAxes(gd).n); M.setPosition(c.clone().addScaledVector(n, offN)); mesh.matrix.copy(M); return mesh; };
    const lining = gd.kind === 'window' || gd.kind === 'ladder' || gd.kind === 'tunnel' || gd.frame === false;
    const mkRect = (offN = 0) => {
      const b = lining ? 0.11 : 0.16, ow = lining ? o.w : o.w + 2 * 0.25, oh = lining ? o.h : o.h + 2 * 0.25;
      const n1 = place(new T.Mesh(frameGeo(ow, oh, ow - 2 * b, oh - 2 * b, 0.1), neon.done), offN);
      const h1 = place(new T.Mesh(frameGeo(ow + 0.5, oh + 0.5, Math.max(0.2, ow - 2 * b - 0.4), Math.max(0.2, oh - 2 * b - 0.4), 0.04), halo.done), offN);
      h1.renderOrder = 6; parts.neon.push(n1); parts.halo.push(h1); grp.add(n1, h1);
      if (!lining && gd.kind !== 'dive') {   // serbest kapı: koyu kasa + ayaklar (çarpışma silindirleriyle aynı yerde)
        const kasa = place(new T.Mesh(frameGeo(ow + 0.12, oh + 0.12, ow - 0.06, oh - 0.06, 0.22), darkMat), offN); kasa.castShadow = true; grp.add(kasa);
        const bot = gd.z - o.h / 2 - 0.25;
        if (bot > 0.3 && gd.kind !== 'ladder') { const r = rightOf(gd.yaw); for (const s of [-1, 1]) { const leg = new T.Mesh(unitCyl(8), darkMat); leg.position.set(gd.x + r[0] * s * (ow / 2 - 0.12), gd.y + r[1] * s * (ow / 2 - 0.12), 0); leg.scale.set(0.07, 0.07, bot); leg.castShadow = true; grp.add(leg); } }
      }
      if (gd.kind === 'dive') {   // dalış kapısı: dört köşe ayağı (yatay çerçeve)
        const r = rightOf(gd.yaw), f = fwdOf(gd.yaw);
        for (const su of [-1, 1]) for (const sv of [-1, 1]) { const leg = new T.Mesh(unitCyl(8), darkMat); leg.position.set(gd.x + r[0] * su * (ow / 2) + f[0] * sv * (oh / 2), gd.y + r[1] * su * (ow / 2) + f[1] * sv * (oh / 2), 0); leg.scale.set(0.07, 0.07, Math.max(0.1, gd.z - 0.1)); grp.add(leg); }
      }
    };
    if (gd.kind === 'circle') {
      const tor = new T.Mesh(keep(new T.TorusGeometry(o.w + 0.15, 0.085, 10, 56)), neon.done);
      const th = new T.Mesh(keep(new T.TorusGeometry(o.w + 0.15, 0.3, 8, 40)), halo.done); th.renderOrder = 6;
      place(tor); place(th); parts.neon.push(tor); parts.halo.push(th); grp.add(tor, th);
      const bot = gd.z - o.w - 0.3;
      if (bot > 0.3) { const leg = new T.Mesh(unitCyl(8), darkMat); leg.position.set(gd.x, gd.y, 0); leg.scale.set(0.08, 0.08, bot); leg.castShadow = true; grp.add(leg); }
    } else if (gd.kind === 'flag' || gd.kind === 'slalom') {
      const pp = gd.pole || [gd.x, gd.y], hp = gd.kind === 'flag' ? 5.5 : 3.2, pr = Math.max(0.09, Number(gd.pole_r) || 0.09);
      if (pr <= 0.3) {   // ince direk (büyük direk = baca; zaten engel olarak çizilir)
        const pole = new T.Mesh(unitCyl(10), mat(gd.kind === 'flag' ? 'pole' : 'railing_yellow')); pole.position.set(pp[0], pp[1], 0); pole.scale.set(0.09, 0.09, hp); pole.castShadow = true; grp.add(pole);
        for (const zz of gd.kind === 'flag' ? [1.2, 3.0, 4.8] : [0.8, 2.2]) { const band = new T.Mesh(keep(new T.TorusGeometry(0.13, 0.035, 6, 20)), neon.done); band.position.set(pp[0], pp[1], zz); parts.neon.push(band); grp.add(band); }
        if (gd.kind === 'flag') {   // bayrak kumaşı (dama desenli; hafif dalga frame'de)
          const cv = canvas(128), g = cv.getContext('2d'); g.fillStyle = '#ff5a1f'; g.fillRect(0, 0, 128, 128); g.fillStyle = '#111'; for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) if ((i + j) % 2) g.fillRect(i * 32, j * 32, 32, 32);
          const tx = keep(new T.CanvasTexture(cv)); tx.colorSpace = T.SRGBColorSpace;
          const cl = new T.Mesh(keep(new T.PlaneGeometry(1.6, 1.1, 8, 1)), keep(new T.MeshStandardMaterial({ map: tx, side: T.DoubleSide, roughness: 0.8 })));
          const f = fwdOf(gd.yaw); cl.position.set(pp[0] - f[0] * 0.8, pp[1] - f[1] * 0.8, hp - 0.6); cl.rotation.set(Math.PI / 2, 0, Math.atan2(f[1], f[0])); cl.castShadow = true; grp.add(cl); flows.push({ cloth: cl });
        }
      }
      // dönüş yönü oku (yerde): bayrakta direk çevresinde yarım yay (geçiş tarafından karşı tarafa U dönüşü) + ok başı; slalomda geçiş tarafında ileri ok
      const f = fwdOf(gd.yaw), phi = Math.atan2(f[1], f[0]), sideR = gd.side === 'right';
      if (gd.kind === 'flag') {
        const rr = pr + (Number(gd.w) || 6) / 2 + 0.3;
        const arc = new T.Mesh(keep(new T.TorusGeometry(rr, 0.09, 6, 40, Math.PI)), neon.done);
        arc.position.set(pp[0], pp[1], 0.12); arc.rotation.z = phi - Math.PI / 2;
        const th = phi + (sideR ? 1 : -1) * Math.PI / 2;
        const head = new T.Mesh(keep(new T.ConeGeometry(0.4, 0.9, 10)), neon.done);
        head.position.set(pp[0] + Math.cos(th) * rr, pp[1] + Math.sin(th) * rr, 0.15); head.quaternion.setFromUnitVectors(up, new T.Vector3(-f[0], -f[1], 0));
        grp.add(arc, head); parts.neon.push(arc, head);
      } else {
        const sh = new T.Shape(); sh.moveTo(-0.12, -1.1); sh.lineTo(0.12, -1.1); sh.lineTo(0.12, 0.5); sh.lineTo(0.42, 0.5); sh.lineTo(0, 1.15); sh.lineTo(-0.42, 0.5); sh.lineTo(-0.12, 0.5); sh.closePath();
        const ar = new T.Mesh(keep(new T.ShapeGeometry(sh)), neon.done);
        ar.position.set(gd.x, gd.y, 0.1); ar.quaternion.setFromUnitVectors(up, new T.Vector3(f[0], f[1], 0));
        grp.add(ar); parts.neon.push(ar);
      }
    } else if (gd.kind === 'tunnel') {
      const a = Math.min(4, (Number(gd.a) || 3) * 0.6);
      mkRect(-a); mkRect(a);
    } else mkRect(0);
    if (gd.kind === 'start') {   // S/F başlık bandı
      const cv = canvas(256), g = cv.getContext('2d'); cv.height = 64;
      for (let i = 0; i < 16; i++) for (let j = 0; j < 2; j++) { g.fillStyle = (i + j) % 2 ? '#111' : '#f5f5f5'; g.fillRect(i * 16, j * 16, 16, 16); }
      g.fillStyle = '#0b0f14'; g.fillRect(0, 32, 256, 32); g.fillStyle = '#39ff6e'; g.font = 'bold 26px system-ui, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText('START · FINISH', 128, 49);
      const tx = keep(new T.CanvasTexture(cv)); tx.colorSpace = T.SRGBColorSpace;
      const ban = new T.Mesh(keep(new T.PlaneGeometry(o.w + 0.5, (o.w + 0.5) / 4)), keep(new T.MeshBasicMaterial({ map: tx, toneMapped: false })));
      const { u, v } = gateAxes(gd); ban.matrixAutoUpdate = false; const M = new T.Matrix4().makeBasis(new T.Vector3(...u), new T.Vector3(...v), new T.Vector3(...u).cross(new T.Vector3(...v)));
      M.setPosition(c.clone().add(new T.Vector3(0, 0, o.h / 2 + 0.25 + (o.w + 0.5) / 8 + 0.05))); ban.matrix.copy(M); grp.add(ban);
      const ban2 = new T.Mesh(ban.geometry, ban.material); ban2.matrixAutoUpdate = false; ban2.matrix.copy(M).multiply(new T.Matrix4().makeRotationY(Math.PI)); grp.add(ban2);   // arkadan da okunur (ayna değil)
    }
    root.add(grp);
    return { grp, parts, gd, state: null };
  });
  const paintGate = (G, st) => {
    if (G.state === st) return;
    G.state = st;
    G.parts.neon.forEach(m => { m.material = neon[st] || neon.done; });
    G.parts.halo.forEach(m => { m.material = halo[st] || halo.done; m.visible = st !== 'done'; });
  };

  // ---- başlangıç pedi: yerde parlayan yeşil halkalar
  const startGrp = new T.Group(); startGrp.name = 'fpv-start'; root.add(startGrp);
  const ringMat = keep(new T.MeshBasicMaterial({ color: new T.Color(GATE_COLORS.start).multiplyScalar(1.8), toneMapped: false, side: T.DoubleSide }));
  const ringGlow = keep(new T.MeshBasicMaterial({ color: GATE_COLORS.start, transparent: true, opacity: 0.22, blending: T.AdditiveBlending, depthWrite: false, side: T.DoubleSide }));
  for (const sl of startSlots(course, Math.max(1, Number(course.start?.cols) || 4))) {
    const r1 = new T.Mesh(keep(new T.RingGeometry(0.62, 0.8, 40)), ringMat); r1.position.set(sl.x, sl.y, 0.06); startGrp.add(r1);
    const r2 = new T.Mesh(keep(new T.RingGeometry(0.35, 1.25, 40)), ringGlow); r2.position.set(sl.x, sl.y, 0.05); r2.renderOrder = 6; startGrp.add(r2);
  }

  // ---- yön okları (sıradaki kapının giriş tarafında kayan şeritler)
  const arrowGrp = new T.Group(); arrowGrp.name = 'fpv-arrow'; root.add(arrowGrp);
  const chevMat = keep(new T.MeshBasicMaterial({ color: new T.Color(GATE_COLORS.next).multiplyScalar(1.6), toneMapped: false, transparent: true, opacity: 0.85, side: T.DoubleSide, depthWrite: false }));
  const chevGeo = (() => { const s = new T.Shape(); s.moveTo(-0.55, -0.32); s.lineTo(0, 0.18); s.lineTo(0.55, -0.32); s.lineTo(0.55, -0.08); s.lineTo(0, 0.42); s.lineTo(-0.55, -0.08); s.closePath(); return keep(new T.ShapeGeometry(s)); })();
  const chevs = [0, 1, 2].map(() => { const m = new T.Mesh(chevGeo, chevMat); m.renderOrder = 7; arrowGrp.add(m); return m; });

  // ---- kılavuz: dronun önünden sıradaki kapıya ince çizgi + sıradaki yarış hattı parçası (noktalı)
  const guideGeo = keep(new T.BufferGeometry()); guideGeo.setAttribute('position', new T.BufferAttribute(new Float32Array(6), 3));
  const guideMat = keep(new T.LineDashedMaterial({ color: GATE_COLORS.next, dashSize: 0.6, gapSize: 0.35, transparent: true, opacity: 0.85, depthTest: false, toneMapped: false }));
  const guide = new T.Line(guideGeo, guideMat); guide.frustumCulled = false; guide.renderOrder = 30; root.add(guide);
  const pathGeo = keep(new T.BufferGeometry()); pathGeo.setAttribute('position', new T.BufferAttribute(new Float32Array(3 * 400), 3)); pathGeo.setDrawRange(0, 0);
  const dotTex = (() => { const cv = canvas(32), g = cv.getContext('2d'); const gr = g.createRadialGradient(16, 16, 0, 16, 16, 15); gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(0.55, 'rgba(255,255,255,.9)'); gr.addColorStop(1, 'rgba(255,255,255,0)'); g.fillStyle = gr; g.fillRect(0, 0, 32, 32); return keep(new T.CanvasTexture(cv)); })();
  const path = new T.Points(pathGeo, keep(new T.PointsMaterial({ color: new T.Color(GATE_COLORS.next).multiplyScalar(1.3), size: 0.065, map: dotTex, transparent: true, opacity: 0.65, depthWrite: false, toneMapped: false, alphaTest: 0.05 })));
  let pathN = 0;
  path.frustumCulled = false; path.renderOrder = 8; root.add(path);
  let guideOn = o.guide !== false;

  // ---- hayalet
  const ghost = { grp: null, samples: null, mats: [] };
  function makeGhost(color = '#22d3ee', name = '') {
    const col = new T.Color(color), grp = new T.Group(); grp.name = 'fpv-ghost';
    const m = keep(new T.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.45, depthWrite: false })), body = new T.Group();
    body.add(new T.Mesh(keep(new T.BoxGeometry(0.22, 0.3, 0.08)), m));
    for (const [sx, sy] of [[1, 1], [-1, 1], [1, -1], [-1, -1]]) {
      const arm = new T.Mesh(keep(new T.BoxGeometry(0.035, 0.3, 0.025)), m); arm.position.set(sx * 0.1, sy * 0.1, 0); arm.rotation.z = Math.atan2(-sx, sy); body.add(arm);
      const rot = new T.Mesh(keep(new T.CylinderGeometry(0.11, 0.11, 0.01, 16)), m); rot.rotation.x = Math.PI / 2; rot.position.set(sx * 0.2, sy * 0.2, 0.04); body.add(rot);
    }
    body.scale.setScalar(2.2); grp.add(body);
    const hl = new T.Mesh(keep(new T.SphereGeometry(1.0, 14, 10)), keep(new T.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.22, blending: T.AdditiveBlending, depthWrite: false })));
    grp.add(hl);
    if (name) {
      const cv = canvas(256); cv.height = 64; const g = cv.getContext('2d');
      g.fillStyle = 'rgba(8,14,24,.75)'; g.beginPath(); g.roundRect(2, 2, 252, 60, 16); g.fill(); g.strokeStyle = color; g.lineWidth = 4; g.stroke();
      g.fillStyle = '#e6f8ff'; g.font = 'bold 28px system-ui, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(String(name).slice(0, 18), 128, 34);
      const tx = keep(new T.CanvasTexture(cv)); tx.colorSpace = T.SRGBColorSpace;
      const spr = new T.Sprite(keep(new T.SpriteMaterial({ map: tx, depthTest: false, transparent: true, sizeAttenuation: false }))); spr.center.set(0.5, 0); spr.scale.set(0.11, 0.0275, 1); spr.position.z = 0.6; spr.renderOrder = 22;
      grp.add(spr);
    }
    grp.visible = false; root.add(grp);
    return { grp, body };
  }

  // ---- efektler (kapı geçişi / çarpma / kaçırma / tur)
  const fx = [];
  function flash(kind = 'gate', gateIdx = null) {
    const cols = { gate: 0x39ff6e, lap: 0x39ff6e, pb: 0xffd34d, sector: 0xa855f7, miss: 0xff8a1f, hit: 0xff3030 };
    const col = new T.Color(cols[kind] ?? 0xffffff);
    const m = keep(new T.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.9, blending: T.AdditiveBlending, depthWrite: false, toneMapped: false }));
    let mesh;
    const gi = gateIdx ?? lastGate;
    const G = gi != null ? gates[gi] : null;
    if ((kind === 'hit') || !G) {
      const p = sim.position?.() || { x: 0, y: 0, z: 2 };
      mesh = new T.Mesh(unitSph(), m); mesh.position.set(p.x, p.y, p.z - root.position.z); mesh.scale.setScalar(0.4);
    } else {
      const gd = G.gd, o2 = gateOpening(gd);
      mesh = gd.kind === 'circle' ? new T.Mesh(keep(new T.TorusGeometry(o2.w + 0.2, 0.12, 8, 40)), m)
        : gd.kind === 'flag' || gd.kind === 'slalom' ? new T.Mesh(keep(new T.TorusGeometry(Math.min(3, (gd.w || 6) / 2), 0.15, 8, 40)), m)
          : new T.Mesh(frameGeo(o2.w + 0.6, o2.h + 0.6, o2.w + 0.2, o2.h + 0.2, 0.05), m);
      mesh.matrixAutoUpdate = false; const M = basisOf(gd); M.setPosition(gd.x, gd.y, gd.z); mesh.matrix.copy(M); mesh.userData.M = M;
    }
    mesh.renderOrder = 9; root.add(mesh);
    fx.push({ mesh, m, t0: performance.now(), dur: kind === 'pb' || kind === 'lap' ? 900 : 550, kind });
  }

  // ---- ilerleme
  let next = cps.length ? cps[0].i : null, lastGate = null;
  function setProgress(n) {
    const prevCp = nextCheckpoint(cps, next);
    next = n == null ? null : Number(n);
    if (prevCp && (next == null || next > prevCp.i)) lastGate = prevCp.gate;
    const st = gateStates(gates.length, cps, next);
    gates.forEach((G, i) => paintGate(G, st[i] || 'done'));
    if (!cps.length) gates.forEach((G, i) => paintGate(G, i === 0 ? 'next' : 'soon'));
    // sıradaki yarış hattı parçası (noktalı)
    const cp = nextCheckpoint(cps, next), arr = pathGeo.attributes.position.array;
    let k = 0;
    if (cp?.line?.length > 1) {
      for (let j = 0; j < cp.line.length - 1 && k < 398; j++) {
        const a = cp.line[j], b = cp.line[j + 1], L = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]), nn = Math.max(1, Math.floor(L / 0.9));
        for (let s = 0; s < nn && k < 398; s++, k++) { const f = s / nn; arr[k * 3] = a[0] + (b[0] - a[0]) * f; arr[k * 3 + 1] = a[1] + (b[1] - a[1]) * f; arr[k * 3 + 2] = a[2] + (b[2] - a[2]) * f; }
      }
    }
    pathN = k; pathGeo.setDrawRange(0, k); pathGeo.attributes.position.needsUpdate = true;
    arrowGrp.visible = !!cp; startGrp.children.forEach((m, i) => { if (i % 2 === 1) m.material.opacity = cp?.lap === 0 ? 0.3 : 0.12; });
  }
  setProgress(next);

  // ---- kare döngüsü (render sonrası kanca: değişiklik bir sonraki karede)
  let raceT = null, raceAt = 0, lastQ = 0, fogSaved = null, skyHidden = [];
  const fogObj = atm.fog ? new T.Fog(atm.fog.color, atm.fog.near, atm.fog.far) : null;
  const strongFog = ['indoor', 'misty', 'hazy', 'overcast'].includes(env.sky);
  if (strongFog) scene.traverse(x => { if (x.name === 'wfx-gokyuzu' || x.name === 'wfx-bulut') { skyHidden.push([x, x.visible]); } });
  const fogColor = atm.fog ? new T.Color(atm.fog.color) : null;
  function frame() {
    const now = performance.now(), pulse = 0.5 + 0.5 * Math.sin(now / 190);
    // atmosfer: sis (worldfx kendi sisini her kurulumda yeniden atar → her karede bizimki)
    if (fogObj) {
      if (fogSaved === null) fogSaved = scene.fog || false;
      if (scene.fog !== fogObj) { if (scene.fog && scene.fog !== fogObj) fogSaved = scene.fog; scene.fog = fogObj; }
      if (strongFog) { scene.background = fogColor; for (const [x] of skyHidden) x.visible = false; }
    }
    neon.next.color.setHex(GATE_COLORS.next).multiplyScalar(1.5 + 1.3 * pulse);
    halo.next.opacity = 0.14 + 0.14 * pulse;
    // yön okları
    const cp = nextCheckpoint(cps, next);
    if (cp) {
      const gd = gates[cp.gate]?.gd;
      if (gd) {
        const { n } = gateAxes(gd), N = new T.Vector3(...n), C = new T.Vector3(gd.x, gd.y, gd.z), ph = (now / 900) % 1;
        chevs.forEach((m, k) => {
          const d = -(3.6 - (k + ph) * 1.1);
          m.position.copy(C).addScaledVector(N, d); if (gd.kind !== 'dive') m.position.z = 0.07;
          // ok düzlemi kapıya paralel değil: geçiş yönünü gösterecek şekilde yatay (dikey kapılarda) / dikey (dalışta)
          if (gd.kind === 'dive') { m.quaternion.setFromRotationMatrix(new T.Matrix4().makeBasis(new T.Vector3(...rightOf(gd.yaw)), new T.Vector3(0, 0, -1), new T.Vector3(...fwdOf(gd.yaw)))); }
          else { m.quaternion.setFromUnitVectors(new T.Vector3(0, 1, 0), N); }
          m.material.opacity = 0.25 + 0.6 * Math.sin(Math.PI * Math.min(1, (k + ph) / 3));
        });
      }
    }
    // kılavuz çizgisi
    if (guideOn && cp && sim.position) {
      const p = sim.position(), gd = gates[cp.gate]?.gd;
      if (p && gd) {
        const a = guideGeo.attributes.position.array, zr = root.position.z;
        const pose = sim.getPose?.(), yaw = pose?.yaw ?? 0;
        a[0] = p.x + Math.sin(yaw) * 0.9; a[1] = p.y + Math.cos(yaw) * 0.9; a[2] = p.z - zr - 0.45;
        const tx = gd.kind === 'flag' || gd.kind === 'slalom' ? (gd.pole?.[0] ?? gd.x) * 0.3 + gd.x * 0.7 : gd.x, ty = gd.kind === 'flag' || gd.kind === 'slalom' ? (gd.pole?.[1] ?? gd.y) * 0.3 + gd.y * 0.7 : gd.y;
        a[3] = tx; a[4] = ty; a[5] = gd.z;
        guideGeo.attributes.position.needsUpdate = true; guide.computeLineDistances(); guide.visible = true;
      }
    } else guide.visible = false;
    path.visible = guideOn && !!cp;
    if (path.visible && pathN && sim.position) {   // dronun 3,5 m yakınındaki (ve gerisindeki) noktalar çizilmez — FPV'de kameraya çarpan kareler olmasın
      const p = sim.position(), a = pathGeo.attributes.position.array, zr = root.position.z;
      let best = 0, bd = Infinity;
      for (let k = 0; k < pathN; k++) { const d = (a[k * 3] - p.x) ** 2 + (a[k * 3 + 1] - p.y) ** 2 + (a[k * 3 + 2] + zr - p.z) ** 2; if (d < bd) { bd = d; best = k; } }
      let st = best; while (st < pathN && (a[st * 3] - p.x) ** 2 + (a[st * 3 + 1] - p.y) ** 2 + (a[st * 3 + 2] + zr - p.z) ** 2 < 12.25) st++;
      pathGeo.setDrawRange(st, pathN - st);
    }
    // hayalet
    if (ghost.grp && ghost.samples && raceT != null) {
      const t = raceT + (now - raceAt) / 1000, ps = ghostPoseAt(ghost.samples, t);
      if (ps && !ps.done && t >= 0) {
        ghost.grp.visible = true; ghost.grp.position.set(ps.x, ps.y, ps.z);
        ghost.body.quaternion.setFromEuler(new T.Euler(ps.pitch, ps.roll, -ps.yaw, 'ZXY'));
      } else ghost.grp.visible = false;
    }
    // akan su / kumaş / zerreler
    for (const f of flows) {
      if (f.tex) f.tex.offset.y = (now / 1000 * f.k) % 1;
      if (f.cloth) f.cloth.rotation.y = Math.sin(now / 600) * 0.12;
      if (f.pts) { const a = f.pts.geometry.attributes.position.array; for (let i = 0; i < a.length; i += 3) { a[i + 2] = f.z0 + ((f.base[i + 2] - f.z0 + now / 2600 * (1 + (i % 7) * 0.1)) % 3.5); } f.pts.geometry.attributes.position.needsUpdate = true; }
    }
    // efektler
    for (let i = fx.length - 1; i >= 0; i--) {
      const e = fx[i], f = (now - e.t0) / e.dur;
      if (f >= 1) { root.remove(e.mesh); e.m.dispose(); disposables.delete(e.m); fx.splice(i, 1); continue; }
      e.m.opacity = 0.9 * (1 - f);
      const s = 1 + f * (e.kind === 'hit' ? 6 : 0.6);
      if (e.mesh.userData.M) { const M = e.mesh.userData.M.clone(); M.multiply(new T.Matrix4().makeScale(s, s, 1)); e.mesh.matrix.copy(M); } else e.mesh.scale.setScalar(0.4 * s);
    }
    // kalite kademesi değişti mi (≈1,5 sn'de bir) + dünya yeniden kurulduysa ev diskini yine gizle
    if (now - lastQ > 1500) { lastQ = now; hideHome(); const l = gfxLevel(); if (l !== level) setQuality(l); }
  }
  // flightsim3d'nin turuncu ev diski (merkez = parkur ortası) parkurda gizlenir; dispose'da geri gelir
  const homeHidden = new Set();
  const hideHome = () => scene.traverse(x => { if (x.name === 'fs-home-mark' && x.visible) { x.visible = false; homeHidden.add(x); } });
  hideHome();
  const unhook = sim.addFrameHook ? sim.addFrameHook(() => frame()) : null;
  // bayram 3B süsleri (flightsim_holiday3d) parkur alanına, kapılara ve başlangıç pedine düşmesin: dış engel bölgeleri
  const KEEP_KEY = 'fpvcourse';
  const keepouts = fpvKeepouts(course);
  sim.setDecorKeepouts?.(KEEP_KEY, keepouts);

  function setQuality(l) {
    level = l || 'high';
    atm = envAtmosphere(env, level);
    if (fogObj && atm.fog) { fogObj.near = atm.fog.near; fogObj.far = atm.fog.far; }
    applyShadows(); buildLights();
  }

  function dispose() {
    unhook?.();
    sim.setDecorKeepouts?.(KEEP_KEY, null);
    if (fogObj && scene.fog === fogObj) scene.fog = fogSaved || null;
    for (const [x, v] of skyHidden) x.visible = v;
    for (const x of homeHidden) x.visible = true;
    scene.remove(root);
    root.traverse(x => { if (x.isInstancedMesh) x.dispose?.(); });
    while (lightGroup.children.length) lightGroup.children.pop().dispose?.();
    disposables.forEach(d => d.dispose?.()); disposables.clear();
  }

  const api = {
    setProgress,
    setGhost(samples, { color = '#22d3ee', name = '' } = {}) {
      if (ghost.grp) { root.remove(ghost.grp); ghost.grp = null; }
      ghost.samples = samples?.length ? samples : null;
      if (ghost.samples) Object.assign(ghost, makeGhost(color, name));
    },
    update(t) { raceT = t == null ? null : Number(t); raceAt = performance.now(); },
    flash, setQuality, setGuide: v => { guideOn = !!v; },
    get zOff() { return root.position.z; },
    get next() { return next; },
    info: () => ({ gates: gates.map((G, i) => ({ i, kind: G.gd.kind, state: G.state })), next, ghost: !!ghost.grp?.visible, ghostPos: ghost.grp?.visible ? ghost.grp.position.toArray().map(v => +v.toFixed(2)) : null, zOff: root.position.z, level, fog: atm.fog, lights: lightGroup.children.length }),
    stats() {   // çizim bütçesi kestirimi (katman): örnekli ağlar, örnek sayısı, nesne sayısı, üçgen
      let tris = 0, objs = 0, instances = 0;
      root.traverse(x => {
        if (!x.isMesh && !x.isPoints && !x.isLine) return;
        objs++;
        const g = x.geometry, n = g?.index ? g.index.count / 3 : (g?.attributes?.position?.count || 0) / 3;
        const c = x.isInstancedMesh ? x.count : 1; if (x.isInstancedMesh) instances += c;
        if (x.isMesh) tris += n * c;
      });
      return { objects: objs, instanced: meshes.length, instances, tris: Math.round(tris), gates: gates.length };
    },
    dispose,
  };
  return api;
}
