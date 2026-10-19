// Uçuş Simülatörü — 3B dünya (three.js r170, yerel kopya static/vendor/three). Sözleşme: docs/ucus-simulatoru.md §5.
// • Koordinat: ENU, merkez referanslı, Z YUKARI (camera.up = +Z). x = doğu, y = kuzey, z = alt_rel (pist seviyesi 0).
// • Arazi: tohumlu 2B simplex gürültü (kendi uygulamamız, bağımlılık yok), 3 oktav; merkez çevresinde 300 m düzleştirme; su seviyesi
//   `water` oranına göre; renkler yüksekliğe göre (kum → çim → kaya → kar). 256×256 ızgara, LOD yok.
// • Nesneler: ağaçlar (InstancedMesh ≤ 20.000, su/pist/bina üzerinde değil), binalar (kutular, 6–40 m), pist (asfalt + çizgiler,
//   runway_heading), gökyüzü/ışık (day/dusk/night; gece pist ve bina ışıkları), sis.
// • Dron (§12 model kütüphanesi): session.model {id, glb_url, orient, has_prop} — dahili 'builtin:caymaz' → static/models/caymaz-sim.glb
//   (CAYMAZ V3 STEP'inden; yüklenemezse delta), 'builtin:delta' → prosedürel delta uçan kanat, 'builtin:quad' (60 cm) / 'builtin:hexa' (90 cm) /
//   'builtin:heli' (1.5 m) prosedürel; kütüphane modeli → GLB fetch + yönelim (forward/up/scale/offset) + pervane düğümleri ya da prosedürel pervane.
//   Eski 'caymaz' | 'delta' dizeleri dahili kimliğe eşlenir. snapshotModel(type, model) → 320×240 PNG (küçük resim).
//   Pervaneler gaz ile döner (yüksek devirde bulanık disk), elevonlar RC ile, seyir ışıkları (sol kırmızı / sağ yeşil / kuyruk beyaz strobe),
//   yalnız dron gölge düşürür. Yönelim: ArduPilot roll/pitch/yaw (NED) → ENU quaternion (Euler 'ZXY': pitch, roll, −yaw).
// • Kameralar (1–5, C döngü; §22): Takip (OrbitControls, hedef dron) · FPV ('pilot': burna sabit, gövdeyle döner, FOV 90–150 tekerlek, balıkgözü/vinyet
//   geçişi, PiP) · Gimbal kamerası ('fpv': burun, gimbal ↑↓, FOV 78, askeri HUD) · Serbest (WASD/QE + fare sürükle) · Yer.
// • Telemetri (50 Hz'e dek): UYARLANIR gecikme tamponlu enterpolasyon — kareler kaynak zaman damgasıyla (yönelim tele.tbm, konum tele.tbm_pos; yoksa ts)
//   iki ayrı zaman çizgisinde sıralı tamponlanır; oynatma başı kaynak zamanında gerçek süreyle ilerler, hedef gecikme 60 ms + 3×jitter (60…300 ms,
//   ±10 ms/s); konum lineer / yönelim slerp; tampon bitince ölü hesap (hız + gövde açısal hızları rs/ps/ys, en çok 300 ms) ve gerçek kareye dönüşte
//   130 ms yumuşak yakınsama (sıçrama yok). Takip kamerası kritik sönümlü yay. motionStats(): ardışık kare yönelim farkı (titreme ölçümü).
//   Çarpışma: z < h(x,y)+0.3 ya da bina kutusu, hız > 1 m/s.
// • Gerçek arazi (world.mode = 'real'; §9): yükseklik AWS Terrain Tiles terrarium PNG (z 12–13, bilineer örnekleme), uydu doku Esri World
//   Imagery karoları canvas atlasında (z+3), OSM (Overpass) binalar (çokgen üçgenleme + duvarlar, tek geometri), orman çokgenlerinde ağaçlar,
//   su çokgenleri, gerçek pistler — hepsi arka uç vekilinden (/api/drone/sim/terrain, /tile, /osm; tarayıcı dışa çıkmaz). Yükseklik alınamazsa
//   prosedürele düşer (onFallback). Prosedürel ayarlar gerçek kipte özelleştirmedir: tree_density orman yoğunluğu ölçeği, building_count ek bina.
// • Google 3B (world.mode = 'google3d'; §11): ./flightsim_g3d.js — Photorealistic 3D Tiles kendi grubunda (gWorld dışında; aynı merkez için
//   yeniden kullanılır), yükseklik/çarpışma karolara ışınla, prosedürel/OSM nesneler kapalı, pist isteğe bağlı; hata → prosedürele düşer.
// Dışa: createFlightSim3D(mountEl, world, opts) → { setTelemetry, setCamera, getCamera, setGimbal, resetCamera, snapCamera (takip yayı dronun üstüne), terrainHeight,
//        toLocal, setWorld (Promise), setOrigin, setType(type, airframe), clearCollision, resize, dispose, netStats() → {hz, jitter, delay (ms, uyarlanır tampon),
//        buffered, deadReckoning, drEnters, drPerMin, rate}, motionStats(reset) → {frames, angMean, angMax, angJerk, posMean, drEnters, …},
//        setKeyboardLock(bool) (sanal kumanda açıkken WASD/QE/ok/boşluk tuşları 3B'ye gitmez) }. opts: { type, airframe, preview, origin, onProgress, onFallback, … }

import { addLandingGear, createLaunchRig, RIG_FINE_ERR } from './flightsim_launch.js';   // sabit kanat kalkış yöntemi (§13): iniş takımı, rampa, pickup
import { CTRL_RE, CTRL_MAX, controlInputs, surfaceTarget, easeSurface, layoutForModel } from './flightsim_airframe.js';   // §13.1 kontrol düzeni: servo → mantıksal eksen → yüzey açıları (ruddervator dahil)
import { createTimeline } from './flightsim_interp.js';   // telemetri zaman çizgisi: uyarlanır gecikme tamponlu enterpolasyon (§5)
import { createMissionLayer } from './flightsim_mission.js';   // §18: görev çizimi (tüp bacaklar, WP etiketleri, ikonlar) + iniş dairesi H

const LIB = '/static/vendor/three/';
export const ATTRIBUTION = 'Uydu: Esri, Maxar, Earthstar Geographics · Yükseklik: Mapzen / AWS Terrain Tiles · Binalar: © OpenStreetMap';
const TERRAIN_API = '/api/drone/sim';
const TILE_PX = 256;
const MAX_ATLAS = 4096;
const PARALLEL = 6;

// ---------- Web Mercator ----------
function lonlatToTile(lon, lat, z) {
  const n = 2 ** z;
  const x = (lon + 180) / 360 * n;
  const lr = Math.max(-85.05112878, Math.min(85.05112878, lat)) * Math.PI / 180;
  const y = (1 - Math.log(Math.tan(lr) + 1 / Math.cos(lr)) / Math.PI) / 2 * n;
  return [x, y];
}

// Nokta çokgen içinde mi (ışın yöntemi; pts: [[x, y]…])
function pointInPoly(x, y, pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i], [xj, yj] = pts[j];
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

async function pool(items, n, fn) {
  let i = 0;
  const workers = Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) { const k = i++; await fn(items[k], k); } });
  await Promise.all(workers);
}

async function getJSON(url) {
  const r = await fetch(url, { credentials: 'same-origin' });
  if (!r.ok) { let d = ''; try { d = (await r.json()).detail || ''; } catch { /* */ } throw Object.assign(new Error(d || `HTTP ${r.status}`), { status: r.status }); }
  return r.json();
}

async function getBitmap(url) {
  const r = await fetch(url, { credentials: 'same-origin' });
  if (!r.ok) throw Object.assign(new Error(`karo ${r.status}`), { status: r.status });
  const blob = await r.blob();
  if (typeof createImageBitmap === 'function') return createImageBitmap(blob);
  return new Promise((res, rej) => { const im = new Image(); const u = URL.createObjectURL(blob); im.onload = () => { URL.revokeObjectURL(u); res(im); }; im.onerror = () => { URL.revokeObjectURL(u); rej(new Error('karo çözülemedi')); }; im.src = u; });
}

// Karo planından (/terrain yanıtı) yükseklik mozaiği + uydu atlası → { sampleRaw(x, y) (m MSL, bilineer), uv(x, y), atlas, elevOk }.
// prog(stage, done, total); `quiet` → eksik yükseklik karosu hata değil (uzak arazi isteğe bağlı).
async function loadMosaic(meta, toLL, prog, quiet = false) {
  const z = meta.z, tiles = meta.tiles || [], iz = meta.img_z, itiles = meta.img_tiles || [];
  if (!tiles.length) throw new Error('Yükseklik karosu planı boş');
  const ext = ts => { const xs = ts.map(t => t.x), ys = ts.map(t => t.y); return { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) }; };
  const E = ext(tiles), nx = E.x1 - E.x0 + 1, ny = E.y1 - E.y0 + 1, mw = nx * TILE_PX, mh = ny * TILE_PX;
  const mosaic = new Float32Array(mw * mh);
  const cv = document.createElement('canvas'); cv.width = cv.height = TILE_PX;
  const c2 = cv.getContext('2d', { willReadFrequently: true });
  let done = 0, elevOk = 0;
  // --- yükseklik karoları (terrarium: R·256 + G + B/256 − 32768) ---
  await pool(tiles, PARALLEL, async t => {
    try {
      const bmp = await getBitmap(meta.elev_url_template.replace('{z}', z).replace('{x}', t.x).replace('{y}', t.y));
      c2.clearRect(0, 0, TILE_PX, TILE_PX); c2.drawImage(bmp, 0, 0); bmp.close?.();
      const d = c2.getImageData(0, 0, TILE_PX, TILE_PX).data;
      const ox = (t.x - E.x0) * TILE_PX, oy = (t.y - E.y0) * TILE_PX;
      for (let py = 0; py < TILE_PX; py++) {
        let s = py * TILE_PX * 4;
        const o = (oy + py) * mw + ox;
        for (let px = 0; px < TILE_PX; px++, s += 4) mosaic[o + px] = d[s] * 256 + d[s + 1] + d[s + 2] / 256 - 32768;
      }
      elevOk++;
    } catch (err) { if (!quiet && (err?.status === 503 || err?.status === 502)) throw err; }
    prog('elev', ++done, tiles.length);
  });
  if (!elevOk) throw new Error('Yükseklik verisi alınamadı');
  const sampleRaw = (x, y) => {
    const [lat, lon] = toLL(x, y);
    const [fx, fy] = lonlatToTile(lon, lat, z);
    const px = Math.min(mw - 1.001, Math.max(0, (fx - E.x0) * TILE_PX - 0.5)), py = Math.min(mh - 1.001, Math.max(0, (fy - E.y0) * TILE_PX - 0.5));
    const ix = Math.floor(px), iy = Math.floor(py), ax = px - ix, ay = py - iy;
    const i0 = iy * mw + ix, i1 = i0 + mw;
    return (mosaic[i0] * (1 - ax) + mosaic[i0 + 1] * ax) * (1 - ay) + (mosaic[i1] * (1 - ax) + mosaic[i1 + 1] * ax) * ay;
  };
  // --- uydu atlası (karolar canvas'a çizilir; gece/akşam koyulaştırma malzeme renginde — atlas yeniden kullanılabilir) ---
  const I = ext(itiles.length ? itiles : tiles), inx = I.x1 - I.x0 + 1, iny = I.y1 - I.y0 + 1;
  const scale = Math.min(1, MAX_ATLAS / Math.max(inx, iny) / TILE_PX);
  const atlas = document.createElement('canvas');
  atlas.width = Math.round(inx * TILE_PX * scale); atlas.height = Math.round(iny * TILE_PX * scale);
  const ac = atlas.getContext('2d');
  ac.fillStyle = '#3b4a3a'; ac.fillRect(0, 0, atlas.width, atlas.height);
  done = 0;
  const ts = TILE_PX * scale;
  await pool(itiles, PARALLEL, async t => {
    try {
      const bmp = await getBitmap(meta.img_url_template.replace('{z}', iz).replace('{x}', t.x).replace('{y}', t.y));
      ac.drawImage(bmp, (t.x - I.x0) * ts, (t.y - I.y0) * ts, ts, ts); bmp.close?.();
    } catch { /* eksik karo: zemin rengi kalır */ }
    prog('img', ++done, itiles.length);
  });
  const uv = (x, y) => {
    const [lat, lon] = toLL(x, y);
    const [fx, fy] = lonlatToTile(lon, lat, iz);
    return [(fx - I.x0) / inx, 1 - (fy - I.y0) / iny];
  };
  return { sampleRaw, uv, atlas, elevOk };
}

// Gerçek arazi verisini yükler → { sample(x, y) (m, merkez 0), uv(x, y), atlas (canvas), homeElev, hmin, hmax, osm, osmError, meta,
//   far: { sample(x, y) (m, aynı merkez 0 referansı), uv, atlas, size } | null }
// onProgress({stage: 'plan'|'elev'|'img'|'osm', done, total}). `withFar`: ufuk için kaba "uzak arazi" halkası (/terrain?far=1: 48 km, z 10 /
// uydu z 12; §9) OSM ile paralel yüklenir; alınamazsa sessizce yok (ana dünya etkilenmez).
export async function loadRealTerrain(T, origin, size, toLocal, onProgress, withFar = false) {
  const prog = (stage, done, total) => onProgress?.({ stage, done, total });
  prog('plan', 0, 1);
  const meta = await getJSON(`${TERRAIN_API}/terrain?lat=${origin.lat}&lon=${origin.lon}&size_m=${Math.round(size)}`);
  const cosLat = Math.cos(origin.lat * Math.PI / 180);
  const toLL = (x, y) => [origin.lat + y / 110574, origin.lon + x / (111320 * cosLat)];
  const main = await loadMosaic(meta, toLL, prog);
  const { sampleRaw, uv, atlas } = main;
  const h0 = sampleRaw(0, 0);
  const homeElev = meta.home_elev != null ? Number(meta.home_elev) : h0;
  let hmin = Infinity, hmax = -Infinity;
  for (let j = 0; j < 64; j++) for (let i = 0; i < 64; i++) { const v = sampleRaw((i / 63 - 0.5) * size, (j / 63 - 0.5) * size) - h0; hmin = Math.min(hmin, v); hmax = Math.max(hmax, v); }
  const sample = (x, y) => sampleRaw(x, y) - h0;
  // --- uzak arazi (isteğe bağlı) + OSM (binalar/orman/su/pist; alınamazsa uyarı ile boş) — paralel ---
  prog('osm', 0, 1);
  let osm = null, osmError = null, far = null;
  const farP = withFar ? (async () => {
    try {
      const fm = await getJSON(`${TERRAIN_API}/terrain?lat=${origin.lat}&lon=${origin.lon}&far=1`);
      const f = await loadMosaic(fm, toLL, () => {}, true);
      far = { sample: (x, y) => f.sampleRaw(x, y) - h0, uv: f.uv, atlas: f.atlas, size: Number(fm.size_m) || 48000, z: fm.z };   // ana arazi ile aynı h0 referansı (ikisi de MSL)
    } catch (err) { console.warn('Uzak arazi alınamadı:', err?.message || err); }
  })() : Promise.resolve();
  const osmP = getJSON(`${TERRAIN_API}/osm?lat=${origin.lat}&lon=${origin.lon}&size_m=${Math.round(size)}`).then(o => { osm = o; }, err => { osmError = err?.message || String(err); });
  await Promise.all([farP, osmP]);
  prog('osm', 1, 1);
  return { sample, uv, atlas, homeElev, hmin, hmax, osm, osmError, meta, far };
}
let _libs = null;
const loadLibs = () => (_libs ??= Promise.all(
  ['three.module.min.js', 'OrbitControls.js', 'GLTFLoader.js'].map(f => import(LIB + f)),
).then(([T, O, G]) => ({ T, OrbitControls: O.OrbitControls, GLTFLoader: G.GLTFLoader })).catch(e => { _libs = null; throw e; }));

// Kamera kipleri (tuşlar 1–5, C döngü; §22): 'pilot' = GERÇEK FPV (pilot gözü: kamera burna sabit, gövdeyle döner, ufuk yatar, FOV 90–150, OSD),
// 'fpv' = GİMBAL/görev kamerası (eğim ↑↓/tekerlek, ufuk sabit, askeri HUD, FOV 78). Kod adları değişmez (localStorage fs.cam, testler, CSS .fs-fpv).
export const CAMERA_MODES = [['follow', 'Takip'], ['pilot', 'FPV'], ['fpv', 'Gimbal kamerası'], ['free', 'Serbest'], ['ground', 'Yer']];
export const PILOT_FOV = { def: 120, min: 90, max: 150, step: 5 };   // FPV (pilot) görüş açısı (°; tekerlek ±5)
export const PIP_SIZE = { w: 240, h: 135, margin: 12 };               // resim içinde resim (takip kamerası) — CSS px, sağ üst
export const PIP_FPS = 20;                                            // PiP yenileme hızı (performans: ana sahne 60 fps hedef)
// Kamera döngüsü (C tuşu): mevcut kipten sonraki; bilinmeyen → ilk
export const nextCameraMode = cur => { const i = CAMERA_MODES.findIndex(([k]) => k === cur); return CAMERA_MODES[(i + 1) % CAMERA_MODES.length][0]; };
export const WORLD_DEFAULTS = {
  mode: 'procedural', seed: 12345, size_m: 4000, tree_density: 0.3, mountain_height: 300, mountain_count: 4, building_count: 40,
  runway: true, runway_heading: 0, water: 0.1, time: 'day', wind_ms: 3, wind_dir: 270, fog: 0.2, landing_circle_m: 30,   // landing_circle_m: görev bitiş noktasındaki iniş dairesi çapı (§18)
};
const FLAT_R = 300, FLAT_R2 = 600;        // merkez çevresi düzleştirme (pist / kalkış alanı)
const RUNWAY_L = 1200, RUNWAY_W = 40;     // pist boyutları (m)
const GRID = 256;                         // arazi ızgarası
const MAX_TREES = 20000;
const MODEL_SCALE = 2.5;                  // dron modelleri (görünürlük için büyütülür; kamera mesafeleri yarıçapa bağlı)
const DEG = Math.PI / 180;
const G3D_HORIZON = 30000;                // Google 3B: sis ufku tabanı (m); kamera far 60 km
const REL_T = 3.0, REL_AGL = 15, REL_TMAX = 6.0;   // released ofset sönümü (§13): 3 sn ya da AGL 15 m; dikey ofset yalnız tırmanışla erir, en geç 6 sn
const RIG_SURF_MS = 500;                  // düzenek yüzey yeniden örnekleme aralığı (Google karoları yüklendikçe yeniden oturur; §13)

// ---------- Tohumlu rastgele sayı (mulberry32) ----------
function rng(seed) {
  let a = (seed >>> 0) || 1;
  return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

// ---------- 2B simplex gürültü (Gustavson), tohumlu permütasyon; çıktı ≈ [-1, 1] ----------
function simplex2D(seed) {
  const G = [[1, 1], [-1, 1], [1, -1], [-1, -1], [1, 0], [-1, 0], [0, 1], [0, -1]];
  const r = rng(seed), p = new Uint8Array(256);
  for (let i = 0; i < 256; i++) p[i] = i;
  for (let i = 255; i > 0; i--) { const j = Math.floor(r() * (i + 1)); const t = p[i]; p[i] = p[j]; p[j] = t; }
  const perm = new Uint8Array(512);
  for (let i = 0; i < 512; i++) perm[i] = p[i & 255];
  const F2 = 0.5 * (Math.sqrt(3) - 1), G2 = (3 - Math.sqrt(3)) / 6;
  return (xin, yin) => {
    const s = (xin + yin) * F2, i = Math.floor(xin + s), j = Math.floor(yin + s), t = (i + j) * G2;
    const x0 = xin - (i - t), y0 = yin - (j - t);
    const i1 = x0 > y0 ? 1 : 0, j1 = x0 > y0 ? 0 : 1;
    const x1 = x0 - i1 + G2, y1 = y0 - j1 + G2, x2 = x0 - 1 + 2 * G2, y2 = y0 - 1 + 2 * G2;
    const ii = i & 255, jj = j & 255;
    let n = 0;
    let tt = 0.5 - x0 * x0 - y0 * y0;
    if (tt > 0) { const g = G[perm[ii + perm[jj]] & 7]; tt *= tt; n += tt * tt * (g[0] * x0 + g[1] * y0); }
    tt = 0.5 - x1 * x1 - y1 * y1;
    if (tt > 0) { const g = G[perm[ii + i1 + perm[jj + j1]] & 7]; tt *= tt; n += tt * tt * (g[0] * x1 + g[1] * y1); }
    tt = 0.5 - x2 * x2 - y2 * y2;
    if (tt > 0) { const g = G[perm[ii + 1 + perm[jj + 1]] & 7]; tt *= tt; n += tt * tt * (g[0] * x2 + g[1] * y2); }
    return 70 * n;
  };
}

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const num = (v, d) => (v == null || Number.isNaN(Number(v)) ? d : Number(v));

// Dünya tanımından deterministik arazi fonksiyonu: h(x, y) metre (pist seviyesi 0), su seviyesi ve yardımcılar
export function makeTerrain(world) {
  const W = { ...WORLD_DEFAULTS, ...(world || {}) };
  const size = clamp(num(W.size_m, 4000), 1000, 20000);
  const H = clamp(num(W.mountain_height, 300), 0, 3000);
  const cnt = clamp(num(W.mountain_count, 4), 1, 12);
  const noise = simplex2D(num(W.seed, 12345));
  const f = cnt / size;   // yaklaşık `mountain_count` tepe genişlik boyunca
  const fbm = (x, y) => (noise(x * f, y * f) + 0.5 * noise(x * f * 2 + 31.7, y * f * 2 - 17.3) + 0.25 * noise(x * f * 4 - 5.1, y * f * 4 + 9.9)) / 1.75;
  const raw = (x, y) => { const n = clamp((fbm(x, y) + 1) / 2, 0, 1); return H * Math.pow(n, 1.7) - H * 0.12; };
  const h0 = raw(0, 0);
  const height = (x, y) => { const r = Math.hypot(x, y); return (raw(x, y) - h0) * smooth(FLAT_R, FLAT_R2, r); };
  // Su seviyesi: ızgara yüksekliklerinin `water` oranı altta kalacak şekilde (pist seviyesinin en az 1.5 m altında)
  let waterZ = -Infinity;
  const water = clamp(num(W.water, 0), 0, 0.9);
  if (water > 0 && H > 0) {
    const hs = [];
    for (let j = 0; j < 64; j++) for (let i = 0; i < 64; i++) hs.push(height((i / 63 - 0.5) * size, (j / 63 - 0.5) * size));
    hs.sort((a, b) => a - b);
    waterZ = Math.min(hs[Math.floor(water * (hs.length - 1))], -1.5);
  }
  return { W, size, H, height, waterZ, rand: rng(num(W.seed, 12345) ^ 0x9E3779B9) };
}

// Pist dikdörtgeni içinde mi (yerel x, y; heading saat yönü kuzeyden)
function inRunway(x, y, headingDeg, margin = 0) {
  const a = -headingDeg * DEG, c = Math.cos(a), s = Math.sin(a);
  const u = c * x + s * y, v = -s * x + c * y;   // u: pist boyu ekseni (+y döndürülmüş), v: pist genişliği
  return Math.abs(v) <= RUNWAY_L / 2 + margin && Math.abs(u) <= RUNWAY_W / 2 + margin;
}

// attitudeQuat (ArduPilot roll/pitch/yaw → ENU gövde quaternionu) ./flightsim_interp.js'tedir.

export async function createFlightSim3D(mountEl, world, opts = {}) {
  const { T, OrbitControls, GLTFLoader } = await loadLibs();
  const preview = !!opts.preview;
  let onCollision = opts.onCollision || null;
  const origin = { lat: num(opts.origin?.lat, 0), lon: num(opts.origin?.lon, 0) };
  const toLocal = (lat, lon) => ({ x: (lon - origin.lon) * 111320 * Math.cos(origin.lat * DEG), y: (lat - origin.lat) * 110574 });

  // ---------- çizici / sahne / kamera ----------
  const renderer = new T.WebGLRenderer({ antialias: !preview, alpha: false, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(devicePixelRatio || 1, preview ? 1 : 2));
  renderer.outputColorSpace = T.SRGBColorSpace;
  renderer.shadowMap.enabled = !preview;   // yalnız dron gölge düşürür (castShadow); arazi/pist alır
  renderer.shadowMap.type = T.PCFSoftShadowMap;
  const canvas = renderer.domElement;
  canvas.className = 'fs3d-canvas';
  canvas.style.cssText = 'display:block;width:100%;height:100%;outline:none;touch-action:none';
  canvas.tabIndex = -1;
  mountEl.appendChild(canvas);
  const scene = new T.Scene();
  const camera = new T.PerspectiveCamera(60, 1, 0.5, 60000);
  camera.up.set(0, 0, 1);
  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true; controls.dampingFactor = 0.12; controls.maxPolarAngle = Math.PI * 0.49; controls.minDistance = 3; controls.maxDistance = 20000;

  // ---------- FPV (pilot) son işleme: hafif balıkgözü (barrel) + vinyet (+ analog kipte doygunluk/renk kayması) — tam ekran quad, tek geçiş ----------
  // Sahne önce bir render hedefine, sonra bozulma gölgelendiricisiyle ekrana çizilir; yalnız 'pilot' kipinde (diğer kiplerde doğrudan render, ek maliyet yok).
  // Örnekleme: uv' = c + d·(1 + k·r²)·s — k > 0 kenarları içe sıkıştırır (barrel görünüm), s köşeleri kadraj içinde tutar (siyah köşe yok).
  const post = { rt: null, scene: new T.Scene(), cam: new T.OrthographicCamera(-1, 1, 1, -1, 0, 1), quad: null, mat: null, w: 0, h: 0 };
  const POST_K = 0.12;   // bozulma katsayısı (hafif)
  post.mat = new T.ShaderMaterial({
    uniforms: { tDiffuse: { value: null }, k: { value: POST_K }, scale: { value: 1 / (1 + POST_K * 0.5) }, vignette: { value: 0.28 }, analog: { value: 0 } },
    depthTest: false, depthWrite: false,
    vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
    fragmentShader: `uniform sampler2D tDiffuse; uniform float k, scale, vignette, analog; varying vec2 vUv;
      void main(){
        vec2 d = vUv - 0.5; float r2 = dot(d, d);
        vec2 uv = 0.5 + d * (1.0 + k * r2) * scale;
        vec3 c = texture2D(tDiffuse, uv).rgb;
        if (analog > 0.5) {   // analog FPV alıcısı: doygunluk ↑, hafif sıcak/soğuk kanal kayması, biraz kontrast
          float l = dot(c, vec3(0.299, 0.587, 0.114));
          c = mix(vec3(l), c, 1.35);
          c = (c - 0.5) * 1.08 + 0.5;
          c.r *= 1.04; c.b *= 0.97;
        }
        float v = 1.0 - vignette * smoothstep(0.25, 0.9, r2 * 2.0);
        gl_FragColor = vec4(c * v, 1.0);
      }`,
  });
  post.quad = new T.Mesh(new T.PlaneGeometry(2, 2), post.mat);
  post.quad.frustumCulled = false;
  post.scene.add(post.quad);
  const ensurePostTarget = () => {
    const w = renderer.domElement.width, h = renderer.domElement.height;   // tampon piksel boyutu (pixelRatio dahil)
    if (post.rt && post.w === w && post.h === h) return post.rt;
    post.rt?.dispose();
    post.rt = new T.WebGLRenderTarget(w, h, { depthBuffer: true, stencilBuffer: false, samples: preview ? 0 : 4 });   // MSAA hedef (antialias korunur)
    post.w = w; post.h = h;
    return post.rt;
  };
  // PiP (resim içinde resim; §22): ayrı küçük kamera (takip konumu) 20 fps'te küçük bir render hedefine, her karede sağ üste kopyalanır (ucuz blit)
  const pip = { on: false, cam: new T.PerspectiveCamera(50, PIP_SIZE.w / PIP_SIZE.h, 0.5, 60000), rt: null, lastAt: 0, mat: null, quad: null, scene: new T.Scene() };
  pip.cam.up.set(0, 0, 1);
  pip.mat = new T.MeshBasicMaterial({ map: null, depthTest: false, depthWrite: false });
  pip.quad = new T.Mesh(new T.PlaneGeometry(2, 2), pip.mat); pip.quad.frustumCulled = false; pip.scene.add(pip.quad);
  const pipRect = () => {   // CSS piksel; OSD çerçeveyi buradan çizer
    const W = Math.max(1, mountEl.clientWidth), m = PIP_SIZE.margin;
    return { x: W - PIP_SIZE.w - m, y: m, w: PIP_SIZE.w, h: PIP_SIZE.h };
  };

  // ---------- dünya ----------
  let terrain = null, gWorld = new T.Group(), buildingsAABB = [], W = { ...WORLD_DEFAULTS };
  scene.add(gWorld);
  // §14/§18 rota (SITL'e yüklenen görev): görev katmanı (flightsim_mission.js) — dünyadan bağımsız grup (setWorld yeniden kurulumunda yeniden çizilir)
  const mission = createMissionLayer(T, { scene, toLocal, terrainHeight: (x, y) => terrainHeight(x, y), getWorld: () => W, getHomeAlt: () => opts.origin?.alt, waterZ: () => (terrain ? terrain.waterZ : -Infinity) });
  let routePts = [];
  let lights = { sun: new T.DirectionalLight(0xffffff, 2), hemi: new T.HemisphereLight(0xbfd8ff, 0x3a4a2a, 0.9), amb: new T.AmbientLight(0xffffff, 0.15) };
  scene.add(lights.sun, lights.hemi, lights.amb, lights.sun.target);
  // Gölge kamerası dronu izler (küçük, keskin): her karede sun.position = dron + güneş yönü × 120 m, target = dron
  const sunDir = new T.Vector3(0.6, -0.5, 0.9).normalize();
  if (!preview) {
    lights.sun.castShadow = true;
    const sc = lights.sun.shadow.camera;
    sc.left = sc.bottom = -25; sc.right = sc.top = 25; sc.near = 20; sc.far = 400;
    lights.sun.shadow.mapSize.set(1024, 1024);
    lights.sun.shadow.bias = -0.0008;
  }

  const disposeGroup = g => {
    g.traverse(o => {
      if (o.geometry) o.geometry.dispose();
      const ms = Array.isArray(o.material) ? o.material : (o.material ? [o.material] : []);
      ms.forEach(m => { for (const k of ['map', 'emissiveMap']) m[k]?.dispose?.(); m.dispose?.(); });
    });
    while (g.children.length) g.remove(g.children[0]);
  };

  // ---------- ortak dünya parçaları (prosedürel + gerçek) ----------
  // `horizon` (m): gerçek arazi / Google 3B kipinde görüş uzaklığı tabanı (uzak arazi yarıçapı); sis ufku dünya boyutuna değil buna bağlanır —
  // eski formül 4 km dünyada sisi 5,4 km'de kapatıyor, 20 km'deki dağlar hiç görünmüyordu (§9). Prosedürelde (horizon yok) eski davranış.
  function skyAndLights(size, horizon = 0) {
    const night = W.time === 'night', dusk = W.time === 'dusk';
    const sky = night ? 0x0a1328 : dusk ? 0xe0956a : 0x8fbdea;
    renderer.setClearColor(sky, 1);
    scene.background = new T.Color(sky);
    lights.sun.color.set(night ? 0x6f7fb0 : dusk ? 0xffb070 : 0xfff2dc);
    lights.sun.intensity = night ? 0.45 : dusk ? 1.3 : 2.4;
    sunDir.set(night ? -0.3 : dusk ? -0.9 : 0.6, dusk ? -0.2 : -0.5, night ? 0.5 : dusk ? 0.25 : 0.9).normalize();
    lights.sun.position.copy(sunDir).multiplyScalar(preview ? size : 120);
    lights.sun.shadow.intensity = night ? 0.35 : dusk ? 0.7 : 1;
    lights.hemi.color.set(night ? 0x1b2a55 : dusk ? 0xf0b088 : 0xbfd8ff);
    lights.hemi.groundColor.set(night ? 0x060a12 : 0x3a4a2a);
    lights.hemi.intensity = night ? 0.5 : dusk ? 0.8 : 0.9;
    lights.amb.intensity = night ? 0.3 : 0.15;
    const fog = clamp(num(W.fog, 0), 0, 1);
    if (horizon > 0) {   // görüş uzaklığı: fog 0 → sis yok; 0,2 (varsayılan) → ≈ 1,05·ufuk (25 km); 1 → 0,25·ufuk (6 km)
      const farF = horizon * (1.25 - fog);
      scene.fog = fog > 0 ? new T.Fog(sky, farF * 0.12, farF) : null;
    } else scene.fog = fog > 0 ? new T.Fog(sky, size * 0.12, size * (1.6 - 1.25 * fog)) : null;
    return { night, dusk };
  }

  // Pist (asfalt, orta çizgiler, eşik çizgileri; heading; gece kenar ışıkları). Konum/yükseklik çağıran verir.
  function runwayMesh(hdg, L, Wd, night, dusk) {
    const rw = new T.Group();
    rw.rotation.z = -hdg * DEG;
    const asphalt = new T.Mesh(new T.PlaneGeometry(Wd, L), new T.MeshLambertMaterial({ color: night ? 0x1c1f24 : 0x3a3d42 }));
    asphalt.receiveShadow = true;   // dron gölgesi piste düşer
    rw.add(asphalt);
    const white = new T.MeshBasicMaterial({ color: night ? 0x9aa3ad : 0xf5f5f5 });
    for (let y = -L / 2 + 60; y < L / 2 - 60; y += 60) { const d = new T.Mesh(new T.PlaneGeometry(1.2, 30), white); d.position.set(0, y, 0.02); rw.add(d); }
    const kMax = Math.max(1, Math.min(3, Math.floor(Wd / 12)));
    for (const sgn of [-1, 1]) for (let k = -kMax; k <= kMax; k++) { if (!k) continue; const s = new T.Mesh(new T.PlaneGeometry(2.4, 30), white); s.position.set(k * 4.8, sgn * (L / 2 - 22), 0.02); rw.add(s); }
    for (const sgn of [-1, 1]) { const e = new T.Mesh(new T.PlaneGeometry(0.9, L), white); e.position.set(sgn * (Wd / 2 - 0.6), 0, 0.02); rw.add(e); }
    if (night || dusk) {
      const pts = [], cols = [];
      for (let y = -L / 2; y <= L / 2; y += 60) for (const sgn of [-1, 1]) { pts.push(sgn * (Wd / 2 + 1.5), y, 0.6); cols.push(1, 0.95, 0.8); }
      for (let x = -Wd / 2; x <= Wd / 2; x += 5) { pts.push(x, -L / 2 - 2, 0.6, x, L / 2 + 2, 0.6); cols.push(0.2, 1, 0.3, 1, 0.25, 0.2); }
      const pg = new T.BufferGeometry();
      pg.setAttribute('position', new T.Float32BufferAttribute(pts, 3));
      pg.setAttribute('color', new T.Float32BufferAttribute(cols, 3));
      rw.add(new T.Points(pg, new T.PointsMaterial({ size: 0.8, vertexColors: true, sizeAttenuation: true, transparent: true, opacity: 0.95 })));
    }
    return rw;
  }

  // Rastgele kutu binalar (prosedürel; gerçek kipte "ek bina"): pistten uzak, su dışında, mevcut AABB'lerle çakışmaz
  function boxBuildings(nb, size, height, waterZ, relH, hdg, rand, night) {
    const bgeo = new T.BoxGeometry(1, 1, 1); bgeo.translate(0, 0, 0.5);
    const bmat = new T.MeshLambertMaterial({ color: 0xffffff, emissive: night ? 0x3a3418 : 0x000000 });
    const inst = new T.InstancedMesh(bgeo, bmat, nb);
    const m4 = new T.Matrix4(), q = new T.Quaternion(), sc = new T.Vector3(), p = new T.Vector3(), bc = new T.Color();
    let placed = 0;
    for (let tries = 0; placed < nb && tries < nb * 40; tries++) {
      const ang = rand() * Math.PI * 2, r = 380 + rand() * (size * 0.42 - 380);
      const x = Math.cos(ang) * r, y = Math.sin(ang) * r, z = height(x, y);
      if (z < waterZ + 2 || (!terrain.real && z > relH * 0.6) || inRunway(x, y, hdg, 120) || inWater(x, y, z)) continue;
      const w = 8 + rand() * 18, d = 8 + rand() * 18, hgt = 6 + rand() * 34;
      if (buildingsAABB.some(b => x + w / 2 > b.x1 - 6 && x - w / 2 < b.x2 + 6 && y + d / 2 > b.y1 - 6 && y - d / 2 < b.y2 + 6)) continue;
      p.set(x, y, z - 1); sc.set(w, d, hgt + 1);
      inst.setMatrixAt(placed, m4.compose(p, q, sc));
      bc.setHSL(0.08 + rand() * 0.05, 0.08 + rand() * 0.15, night ? 0.25 : 0.55 + rand() * 0.3);
      inst.setColorAt(placed, bc);
      buildingsAABB.push({ x1: x - w / 2, x2: x + w / 2, y1: y - d / 2, y2: y + d / 2, z2: z + hgt });
      placed++;
    }
    inst.count = placed;
    inst.instanceMatrix.needsUpdate = true;
    if (inst.instanceColor) inst.instanceColor.needsUpdate = true;
    gWorld.add(inst);
  }

  // Ağaçlar: `pick()` bir aday (x, y) üretir (ya da null); su/pist/bina/kar üzerinde değil
  function trees(nt, pick, height, waterZ, relH, hdg, rand, night) {
    const crownG = new T.ConeGeometry(1, 1, 6); crownG.rotateX(Math.PI / 2); crownG.translate(0, 0, 0.5);
    const trunkG = new T.CylinderGeometry(0.12, 0.18, 1, 5); trunkG.rotateX(Math.PI / 2); trunkG.translate(0, 0, 0.5);
    const crown = new T.InstancedMesh(crownG, new T.MeshLambertMaterial({ color: 0xffffff }), nt);
    const trunk = new T.InstancedMesh(trunkG, new T.MeshLambertMaterial({ color: night ? 0x2a2017 : 0x5a3f27 }), nt);
    const m4 = new T.Matrix4(), q = new T.Quaternion(), sc = new T.Vector3(), p = new T.Vector3(), cc = new T.Color();
    let placed = 0;
    for (let tries = 0; placed < nt && tries < nt * 4; tries++) {
      const c = pick(); if (!c) continue;
      const [x, y] = c, r = Math.hypot(x, y);
      if (r < (W.runway !== false ? 330 : 60)) continue;
      const z = height(x, y);
      if (z < waterZ + 2 || (!terrain.real && z > relH * 0.72) || (W.runway !== false && inRunway(x, y, hdg, 60)) || inWater(x, y, z)) continue;
      if (buildingsAABB.some(b => x > b.x1 - 3 && x < b.x2 + 3 && y > b.y1 - 3 && y < b.y2 + 3)) continue;
      const hh = 6 + rand() * 9, rr = 1.8 + rand() * 2.2;
      p.set(x, y, z - 0.3); sc.set(1, 1, hh * 0.35 + 0.3);
      trunk.setMatrixAt(placed, m4.compose(p, q, sc));
      p.set(x, y, z + hh * 0.3); sc.set(rr, rr, hh * 0.7);
      crown.setMatrixAt(placed, m4.compose(p, q, sc));
      cc.setHSL(0.27 + rand() * 0.08, 0.45 + rand() * 0.2, (night ? 0.12 : 0.22) + rand() * 0.12);
      crown.setColorAt(placed, cc);
      placed++;
    }
    crown.count = trunk.count = placed;
    crown.instanceMatrix.needsUpdate = trunk.instanceMatrix.needsUpdate = true;
    if (crown.instanceColor) crown.instanceColor.needsUpdate = true;
    gWorld.add(trunk, crown);
    return placed;
  }

  // Gerçek kip: su çokgenleri (yerel koordinat, bbox + z); nokta içinde mi
  let waterPolys = [];
  const inWater = (x, y, z) => waterPolys.some(w => x >= w.x1 && x <= w.x2 && y >= w.y1 && y <= w.y2 && z < w.z + 1.5 && pointInPoly(x, y, w.pts));

  // ---------- prosedürel dünya ----------
  function buildProcedural(world) {
    terrain = makeTerrain(world);
    W = terrain.W;
    const { size, H, height, waterZ, rand } = terrain;
    const { night, dusk } = skyAndLights(size);
    const geo = new T.PlaneGeometry(size, size, GRID - 1, GRID - 1);
    const pos = geo.attributes.position, col = new Float32Array(pos.count * 3);
    const c = new T.Color(), sand = new T.Color(0xc2b280), grass1 = new T.Color(0x4f8a3a), grass2 = new T.Color(0x7a9a46),
      rock = new T.Color(0x7d7569), snow = new T.Color(0xeef2f5);
    const relH = Math.max(H, 1);
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i), y = pos.getY(i), z = height(x, y);
      pos.setZ(i, z);
      if (z < waterZ + 1.5) c.copy(sand);
      else if (z < relH * 0.35) c.lerpColors(grass1, grass2, clamp(z / (relH * 0.35), 0, 1));
      else if (z < relH * 0.7) c.lerpColors(grass2, rock, (z - relH * 0.35) / (relH * 0.35));
      else c.lerpColors(rock, snow, clamp((z - relH * 0.7) / (relH * 0.25), 0, 1));
      if (night) c.multiplyScalar(0.55);
      col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
    }
    geo.setAttribute('color', new T.BufferAttribute(col, 3));
    geo.computeVertexNormals();
    const ground = new T.Mesh(geo, new T.MeshLambertMaterial({ vertexColors: true }));
    ground.name = 'arazi';
    ground.receiveShadow = true;
    gWorld.add(ground);
    if (waterZ > -Infinity) {
      const water = new T.Mesh(new T.PlaneGeometry(size * 1.02, size * 1.02), new T.MeshPhongMaterial({
        color: night ? 0x0b1d3a : dusk ? 0x3b5f8a : 0x2f6fa8, transparent: true, opacity: 0.86, shininess: 90, specular: 0x88aadd }));
      water.position.z = waterZ;
      gWorld.add(water);
    }
    const hdg = num(W.runway_heading, 0);
    if (W.runway !== false) { const rw = runwayMesh(hdg, RUNWAY_L, RUNWAY_W, night, dusk); rw.position.z = 0.05; gWorld.add(rw); }
    const nb = clamp(Math.round(num(W.building_count, 0)), 0, 400);
    if (nb > 0) boxBuildings(nb, size, height, waterZ, relH, hdg, rand, night);
    const density = clamp(num(W.tree_density, 0), 0, 1);
    const nt = Math.min(preview ? 3000 : MAX_TREES, Math.round(density * MAX_TREES));
    if (nt > 0) trees(nt, () => [(rand() - 0.5) * size * 0.98, (rand() - 0.5) * size * 0.98], height, waterZ, relH, hdg, rand, night);
    addHomeMark();
  }

  // ---------- gerçek dünya (terrarium yükseklik + uydu doku + OSM) ----------
  function buildReal(world, real) {
    const Wn = { ...WORLD_DEFAULTS, ...(world || {}) };
    const size = clamp(num(Wn.size_m, 4000), 1000, 20000);
    const rand = rng(num(Wn.seed, 12345) ^ 0x9E3779B9);
    const flatR = Wn.runway !== false ? FLAT_R : 60, flatR2 = Wn.runway !== false ? FLAT_R2 : 160;
    const half = size / 2, far = real.far || null;
    const mainH = (x, y) => real.sample(x, y) * smooth(flatR, flatR2, Math.hypot(x, y));
    // Ana kare dışında yükseklik uzak araziden (kamera zemin kısıtı, çarpışma, rota çubukları); uzak arazi yoksa kenar değeri (sample kırpar)
    const height = far ? (x, y) => (Math.abs(x) > half || Math.abs(y) > half ? far.sample(x, y) : mainH(x, y)) : mainH;
    const H = Math.max(1, real.hmax - real.hmin);
    terrain = { W: Wn, size, H, height, waterZ: -Infinity, rand, real: true, homeElev: real.homeElev, hmin: real.hmin, hmax: real.hmax, osm: real.osm, farSize: far ? far.size : 0 };   // .mesh aşağıda: ana arazi örgüsü (düzenek ışını, §13)
    W = Wn;
    const { night, dusk } = skyAndLights(size, far ? far.size / 2 : 0);
    const osm = real.osm || { buildings: [], forests: [], water: [], runways: [] };
    const toXY = ll => { const p = toLocal(ll[0], ll[1]); return [p.x, p.y]; };
    const inside = pts => pts.some(([x, y]) => Math.abs(x) <= half && Math.abs(y) <= half);

    // --- arazi: ızgara z = gerçek yükseklik (merkez 0); UV uydu atlasından ---
    const geo = new T.PlaneGeometry(size, size, GRID - 1, GRID - 1);
    const pos = geo.attributes.position, uv = geo.attributes.uv;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i), y = pos.getY(i);
      pos.setZ(i, height(x, y));
      const t = real.uv(x, y);
      uv.setXY(i, t[0], t[1]);
    }
    geo.computeVertexNormals();
    const tex = new T.CanvasTexture(real.atlas);
    tex.colorSpace = T.SRGBColorSpace;
    tex.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy?.() || 1);
    tex.generateMipmaps = true; tex.minFilter = T.LinearMipmapLinearFilter;
    // Gece/akşam: doku çarpımsal koyulaştırma (atlas ham kalır, yeniden kullanılır)
    const ground = new T.Mesh(geo, new T.MeshLambertMaterial({ map: tex, color: night ? 0x4c5670 : dusk ? 0xe8b898 : 0xffffff }));
    ground.receiveShadow = true;
    ground.name = 'arazi';
    gWorld.add(ground);
    terrain.mesh = ground;   // düzenek yüzeyi için örgüye ışın (ızgara interpolasyonu ile görünen üçgenler arasındaki fark giderilir; §13)

    // --- uzak arazi halkası (§9): ufka dek kaba ızgara (48 km, terrarium z 10 + uydu z 12). Ana kare içinde ana arazinin 2 m altında saklı;
    // kenardan 1,5 km dışarıya dek ana kenar değeriyle karışır (dikişsiz), sonra tamamen uzak veri. Sis ufku far.size/2'ye bağlı (skyAndLights).
    if (far) {
      const FG = 192, BLEND = 1500;
      const fgeo = new T.PlaneGeometry(far.size, far.size, FG - 1, FG - 1);
      const fpos = fgeo.attributes.position, fuv = fgeo.attributes.uv;
      for (let i = 0; i < fpos.count; i++) {
        const x = fpos.getX(i), y = fpos.getY(i), d = Math.max(Math.abs(x), Math.abs(y)) - half;
        let z;
        if (d <= 0) z = mainH(x, y) - 2;
        else { const w = smooth(0, BLEND, d); z = (1 - w) * mainH(x, y) + w * far.sample(x, y); }
        fpos.setZ(i, z);
        const t = far.uv(x, y);
        fuv.setXY(i, t[0], t[1]);
      }
      fgeo.computeVertexNormals();
      const ftex = new T.CanvasTexture(far.atlas);
      ftex.colorSpace = T.SRGBColorSpace;
      ftex.anisotropy = tex.anisotropy; ftex.generateMipmaps = true; ftex.minFilter = T.LinearMipmapLinearFilter;
      const fground = new T.Mesh(fgeo, new T.MeshLambertMaterial({ map: ftex, color: night ? 0x4c5670 : dusk ? 0xe8b898 : 0xffffff }));
      fground.name = 'uzak-arazi';
      gWorld.add(fground);
    }

    // --- su çokgenleri (OSM natural=water): düz yüzey, en alçak köşe −0.2 m ---
    waterPolys = [];
    const waterMat = new T.MeshPhongMaterial({ color: night ? 0x0b1d3a : dusk ? 0x3b5f8a : 0x2f6fa8, transparent: true, opacity: 0.86, shininess: 90, specular: 0x88aadd, side: T.DoubleSide });
    for (const poly of osm.water) {
      const pts = poly.map(toXY);
      if (pts.length < 3 || !inside(pts)) continue;
      let zmin = Infinity, x1 = Infinity, x2 = -Infinity, y1 = Infinity, y2 = -Infinity;
      for (const [x, y] of pts) { zmin = Math.min(zmin, height(x, y)); x1 = Math.min(x1, x); x2 = Math.max(x2, x); y1 = Math.min(y1, y); y2 = Math.max(y2, y); }
      const z = zmin - 0.2;
      const shape = new T.Shape(pts.map(([x, y]) => new T.Vector2(x, y)));
      const m = new T.Mesh(new T.ShapeGeometry(shape), waterMat);
      m.position.z = z;
      gWorld.add(m);
      waterPolys.push({ pts, z, x1, x2, y1, y2 });
    }

    // --- binalar (OSM): taban çokgen üçgenleme + duvarlar, tek BufferGeometry; AABB çarpışma için ---
    const hdg0 = num(Wn.runway_heading, 0);
    const bpos = [], bnorm = [], bcol = [];
    const roofC = new T.Color(), wallC = new T.Color();
    let nReal = 0;
    for (const b of osm.buildings) {
      const pts = b.poly.map(toXY);
      if (pts.length >= 4 && pts[0][0] === pts[pts.length - 1][0] && pts[0][1] === pts[pts.length - 1][1]) pts.pop();
      if (pts.length < 3 || !inside(pts)) continue;
      let zmin = Infinity, zmax = -Infinity, x1 = Infinity, x2 = -Infinity, y1 = Infinity, y2 = -Infinity;
      for (const [x, y] of pts) { const z = height(x, y); zmin = Math.min(zmin, z); zmax = Math.max(zmax, z); x1 = Math.min(x1, x); x2 = Math.max(x2, x); y1 = Math.min(y1, y); y2 = Math.max(y2, y); }
      if (x2 - x1 > 600 || y2 - y1 > 600) continue;   // bozuk/çok büyük çokgen
      // Kalkış alanı: merkez pisti (açıksa) ve 60 m çevresini kesen binalar atlanır (kent merkezinde pist binaların arasından geçer)
      const cx = (x1 + x2) / 2, cy = (y1 + y2) / 2;
      if (Math.hypot(cx, cy) < 60 || (Wn.runway !== false && (inRunway(cx, cy, hdg0, 50) || pts.some(([x, y]) => inRunway(x, y, hdg0, 50))))) continue;
      const zb = zmin - 0.6, zt = zmax + clamp(num(b.h, 8), 2, 400);
      const hue = 0.07 + rand() * 0.06, light = night ? 0.22 : 0.55 + rand() * 0.25;
      roofC.setHSL(hue, 0.1 + rand() * 0.12, light); wallC.setHSL(hue, 0.08 + rand() * 0.1, light * 0.8);
      // Saat yönü denetimi (shoelace) — duvar normalleri dışa baksın
      let area = 0;
      for (let i = 0; i < pts.length; i++) { const [ax, ay] = pts[i], [bx, by] = pts[(i + 1) % pts.length]; area += ax * by - bx * ay; }
      const ccw = area > 0;
      let tris;
      try { tris = T.ShapeUtils.triangulateShape(pts.map(([x, y]) => new T.Vector2(x, y)), []); } catch { tris = []; }
      for (const [a, b2, c] of tris) {
        const o = ccw ? [a, b2, c] : [a, c, b2];
        for (const k of o) { bpos.push(pts[k][0], pts[k][1], zt); bnorm.push(0, 0, 1); bcol.push(roofC.r, roofC.g, roofC.b); }
      }
      for (let i = 0; i < pts.length; i++) {
        const [ax, ay] = pts[i], [bx, by] = pts[(i + 1) % pts.length];
        const nx = (by - ay), ny = -(bx - ax), ln = Math.hypot(nx, ny) || 1;
        const s = ccw ? 1 : -1, n = [nx / ln * s, ny / ln * s, 0];
        const quad = ccw ? [[ax, ay, zb], [bx, by, zb], [bx, by, zt], [ax, ay, zb], [bx, by, zt], [ax, ay, zt]]
          : [[ax, ay, zb], [bx, by, zt], [bx, by, zb], [ax, ay, zb], [ax, ay, zt], [bx, by, zt]];
        for (const v of quad) { bpos.push(...v); bnorm.push(...n); bcol.push(wallC.r, wallC.g, wallC.b); }
      }
      buildingsAABB.push({ x1, x2, y1, y2, z2: zt });
      nReal++;
    }
    if (bpos.length) {
      const bg = new T.BufferGeometry();
      bg.setAttribute('position', new T.Float32BufferAttribute(bpos, 3));
      bg.setAttribute('normal', new T.Float32BufferAttribute(bnorm, 3));
      bg.setAttribute('color', new T.Float32BufferAttribute(bcol, 3));
      gWorld.add(new T.Mesh(bg, new T.MeshLambertMaterial({ vertexColors: true, emissive: night ? 0x2a2410 : 0x000000 })));
      if (night || dusk) {   // gece/akşam: bina ışıkları (çatı köşelerinde sıcak noktalar)
        const lp = [], lc = [];
        for (const b of buildingsAABB) {
          for (const [x, y] of [[b.x1 + 1, b.y1 + 1], [b.x2 - 1, b.y2 - 1]]) { lp.push(x, y, b.z2 - 1.2); const warm = 0.75 + rand() * 0.25; lc.push(1, 0.85 * warm, 0.5 * warm); }
        }
        const pg = new T.BufferGeometry();
        pg.setAttribute('position', new T.Float32BufferAttribute(lp, 3));
        pg.setAttribute('color', new T.Float32BufferAttribute(lc, 3));
        gWorld.add(new T.Points(pg, new T.PointsMaterial({ size: night ? 1.6 : 1.1, vertexColors: true, sizeAttenuation: true, transparent: true, opacity: night ? 0.95 : 0.6 })));
      }
    }
    terrain.counts = { buildings: nReal, forests: 0, water: waterPolys.length, runways: 0 };

    // --- pistler: merkez pisti (düzleştirilmiş alan; isteğe bağlı) + OSM pistleri ---
    const hdg = num(Wn.runway_heading, 0);
    if (Wn.runway !== false) { const rw = runwayMesh(hdg, RUNWAY_L, RUNWAY_W, night, dusk); rw.position.z = 0.05; gWorld.add(rw); }
    for (const r of osm.runways) {
      const pts = r.poly.map(toXY);
      if (pts.length < 2 || !inside(pts)) continue;
      const [ax, ay] = pts[0], [bx, by] = pts[pts.length - 1];
      const L = Math.hypot(bx - ax, by - ay);
      if (L < 100) continue;
      const mx = (ax + bx) / 2, my = (ay + by) / 2;
      if (Wn.runway !== false && Math.hypot(mx, my) < RUNWAY_L / 2) continue;   // merkez pistiyle çakışır
      const rw = runwayMesh(num(r.heading, Math.atan2(bx - ax, by - ay) / DEG), L, clamp(num(r.width, 45), 15, 80), night, dusk);
      rw.position.set(mx, my, height(mx, my) + 0.4);
      gWorld.add(rw);
      terrain.counts.runways++;
    }

    // --- ek kutu binalar (building_count; 0 = yalnız gerçek binalar) ---
    const nb = clamp(Math.round(num(Wn.building_count, 0)), 0, 400);
    if (nb > 0) boxBuildings(nb, size, height, -Infinity, H, hdg, rand, night);

    // --- ağaçlar: orman çokgenlerinde (alanla orantılı; tree_density ölçek: 0.3 ≈ 4000 ağaç/km²) ---
    const density = clamp(num(Wn.tree_density, 0), 0, 1);
    const forests = [];
    let totalArea = 0;
    for (const poly of osm.forests) {
      const pts = poly.map(toXY);
      if (pts.length < 3 || !inside(pts)) continue;
      let area = 0, x1 = Infinity, x2 = -Infinity, y1 = Infinity, y2 = -Infinity;
      for (let i = 0; i < pts.length; i++) { const [ax, ay] = pts[i], [bx, by] = pts[(i + 1) % pts.length]; area += ax * by - bx * ay; x1 = Math.min(x1, ax); x2 = Math.max(x2, ax); y1 = Math.min(y1, ay); y2 = Math.max(y2, ay); }
      area = Math.abs(area) / 2;
      // Dünya sınırına kırp (bbox): dışarıda kalan alan sayılmaz
      const cx1 = Math.max(x1, -half), cx2 = Math.min(x2, half), cy1 = Math.max(y1, -half), cy2 = Math.min(y2, half);
      if (cx2 <= cx1 || cy2 <= cy1) continue;
      forests.push({ pts, area, x1: cx1, x2: cx2, y1: cy1, y2: cy2 });
      totalArea += area;
    }
    terrain.counts.forests = forests.length;
    if (density > 0 && totalArea > 0) {
      const want = Math.min(preview ? 3000 : MAX_TREES, Math.round(totalArea * 0.004 * (density / 0.3)));
      if (want > 0) {
        // Çokgen başına kota (alan oranı); aday: bbox içinde rastgele, çokgen içi denetimi
        const cum = []; let acc = 0;
        for (const f of forests) { acc += f.area / totalArea; cum.push(acc); }
        const pick = () => {
          const r = rand(); let i = cum.findIndex(c => r <= c); if (i < 0) i = forests.length - 1;
          const f = forests[i];
          const x = f.x1 + rand() * (f.x2 - f.x1), y = f.y1 + rand() * (f.y2 - f.y1);
          return pointInPoly(x, y, f.pts) ? [x, y] : null;
        };
        terrain.counts.trees = trees(want, pick, height, -Infinity, H, hdg, rand, night);
      }
    }
    addHomeMark();
  }

  function addHomeMark() {
    const home = new T.Mesh(new T.CircleGeometry(3, 24), new T.MeshBasicMaterial({ color: 0xf59e0b }));
    home.position.z = 0.12;
    gWorld.add(home);
  }

  // Google 3B: karolar + isteğe bağlı merkez pisti (ince şerit, yüzey z = 0); ağaç/bina/su/uydu arazi yok. Yükseklik g3d.height (ışın).
  let g3d = null;
  function buildGoogle(world) {
    const Wn = { ...WORLD_DEFAULTS, ...(world || {}) };
    const size = clamp(num(Wn.size_m, 4000), 1000, 20000);
    terrain = { W: Wn, size, H: 200, height: g3d.height, waterZ: -Infinity, rand: rng(num(Wn.seed, 12345)), real: false, google: true, homeElev: g3d.homeElev, counts: null };
    W = Wn;
    const { night, dusk } = skyAndLights(size, G3D_HORIZON);   // karolar küresel LOD'lu: ufuk dünya boyutuna değil görüş uzaklığına bağlı (uzak dağlar kaba karolarla gelir)
    g3d.setTime(Wn.time); g3d.setShadows(!preview && !!opts.g3dShadows);   // gölge isteğe bağlı (normal hesaplama + Lambert; varsayılan Basic: doku rengi doğrudan)
    scene.add(g3d.group);
    if (Wn.runway === true) { const rw = runwayMesh(num(Wn.runway_heading, 0), RUNWAY_L, 18, night, dusk); rw.position.z = 0.08; gWorld.add(rw); }
    addHomeMark();
  }

  // Dünya kurucu: prosedürel anında; gerçek kip veri yükler (ilerleme), alınamazsa prosedürele düşer (onFallback). Son çağrı kazanır.
  let buildSeq = 0, realCache = null;
  const onProgress = opts.onProgress || null, onFallback = opts.onFallback || null;
  async function buildWorld(world) {
    const seq = ++buildSeq;
    const Wn = { ...WORLD_DEFAULTS, ...(world || {}) };
    let real = null;
    if (Wn.mode === 'google3d') {
      const key = `${origin.lat.toFixed(5)},${origin.lon.toFixed(5)}`;
      try {
        if (!g3d || g3d.key !== key) {
          g3d?.dispose(); g3d = null;
          onProgress?.({ stage: 'g3d', pct: 0 });
          const G = await import('./flightsim_g3d.js');
          const g = await G.createGoogleTiles({ T, renderer, camera, origin: { ...origin, alt: opts.origin?.alt }, preview, key: opts.g3dKey, time: Wn.time, onProgress: p => { if (g3d === g) onProgress?.(p); } });
          if (seq !== buildSeq) { g.dispose(); return; }
          g.key = key; g3d = g;
        }
      } catch (err) {
        if (seq !== buildSeq) return;
        onFallback?.(err?.message || String(err));
        Wn.mode = 'procedural';
      }
    }
    if (Wn.mode !== 'google3d' && g3d) { g3d.dispose(); g3d = null; }
    if (Wn.mode === 'real') {
      const size = clamp(num(Wn.size_m, 4000), 1000, 20000);
      const key = `${origin.lat.toFixed(5)},${origin.lon.toFixed(5)},${size}`;
      try {
        if (!realCache || realCache.key !== key) {
          const r = await loadRealTerrain(T, origin, size, toLocal, p => { if (seq === buildSeq) onProgress?.(p); }, !preview);   // oturumda uzak arazi halkası da (önizleme kamerası ufku görmez)
          if (seq !== buildSeq) return;
          realCache = { key, data: r };
        }
        real = realCache.data;
      } catch (err) {
        if (seq !== buildSeq) return;
        realCache = null;
        onFallback?.(err?.message || String(err));
        Wn.mode = 'procedural';
      }
    }
    disposeGroup(gWorld);
    buildingsAABB = []; waterPolys = [];
    if (g3d) buildGoogle(Wn); else if (real) buildReal(Wn, real); else buildProcedural(Wn);
    onProgress?.({ stage: 'done', real: !!real, google: !!g3d, counts: terrain.counts || null, homeElev: terrain.homeElev ?? null, hmin: terrain.hmin ?? null, hmax: terrain.hmax ?? null });
  }

  // ---------- dron modelleri ----------
  // Gövde çerçevesi: burun +Y, sağ kanat +X, üst +Z; birimler metre (gerçek boyut), görünürlük için ×MODEL_SCALE.
  // Sabit kanat / VTOL gövdesi (airframe): 'caymaz' → static/models/caymaz-sim.glb (CAYMAZ V3 STEP'inden; glTF: Y yukarı, burun +Z,
  // sol kanat +X → Rx+90°, Rz180°), 'delta' → prosedürel delta uçan kanat. Pervane düğümleri `props` (yerel Z etrafında döner,
  // userData.dir ±1; userData.disc/blades: yüksek devirde palalar gizlenir, saydam disk belirir). Kontrol yüzeyleri `ctrl`.
  let drone = { group: new T.Group(), props: [], ctrl: [], lights: [], radius: 3, nose: 2, type: null, airframe: null };
  scene.add(drone.group);
  const MAT = () => ({
    carbon: new T.MeshStandardMaterial({ color: 0x1f2428, roughness: 0.55, metalness: 0.35 }),
    dark: new T.MeshStandardMaterial({ color: 0x2b3340, roughness: 0.6, metalness: 0.2 }),
    body: new T.MeshStandardMaterial({ color: 0x33496f, roughness: 0.5, metalness: 0.15 }),
    white: new T.MeshStandardMaterial({ color: 0xe9ecf1, roughness: 0.5, metalness: 0.1 }),
    grey: new T.MeshStandardMaterial({ color: 0x8a939e, roughness: 0.5, metalness: 0.5 }),
    red: new T.MeshStandardMaterial({ color: 0xd93a2b, roughness: 0.55 }),
    orange: new T.MeshStandardMaterial({ color: 0xf59e0b, roughness: 0.55 }),
    glass: new T.MeshStandardMaterial({ color: 0x0b1420, roughness: 0.15, metalness: 0.6 }),
    disc: new T.MeshBasicMaterial({ color: 0x8a939e, transparent: true, opacity: 0, side: T.DoubleSide, depthWrite: false }),
    blade: new T.MeshStandardMaterial({ color: 0x15181c, roughness: 0.6, side: T.DoubleSide }),
  });
  const mesh = (geo, mat, x = 0, y = 0, z = 0) => { const m = new T.Mesh(geo, mat); m.position.set(x, y, z); m.castShadow = true; return m; };
  // Pervane: hub + n pala (hafif hatve açısı) + bulanıklık diski; dönüş ekseni yerel Z
  const propeller = (r, dir, M, blades = 2, hub = r * 0.12) => {
    const g = new T.Group();
    g.userData.dir = dir;
    const disc = new T.Mesh(new T.RingGeometry(hub, r, 24, 1), M.disc.clone()); g.add(disc); g.userData.disc = disc;
    g.add(mesh(new T.CylinderGeometry(hub, hub, hub * 1.2, 10).rotateX(Math.PI / 2), M.dark));
    const bl = [];
    for (let k = 0; k < blades; k++) {
      const b = mesh(new T.BoxGeometry(r - hub * 0.8, r * 0.15, Math.max(0.004, r * 0.012)), M.blade, 0, 0, 0);
      b.geometry.translate((r + hub * 0.8) / 2, 0, 0);
      b.rotation.set(0.28 * dir, 0, k * 2 * Math.PI / blades);   // hatve açısı
      b.rotation.order = 'ZXY';
      g.add(b); bl.push(b);
    }
    g.userData.blades = bl;
    return g;
  };
  // Çokrotor (quad/hexa): gövde (üst/alt plaka), kollar, motorlar, iniş takımı, kamera gimbali, CW/CCW pervaneler
  const buildMulti = (n, span, M) => {
    const grp = new T.Group(), props = [];
    const R = span / 2, bodyW = span * 0.3, bodyH = span * 0.08;
    grp.add(mesh(new T.CylinderGeometry(bodyW / 2, bodyW / 2, bodyH, 8).rotateX(Math.PI / 2), M.carbon, 0, 0, 0));
    grp.add(mesh(new T.BoxGeometry(bodyW * 0.7, bodyW * 0.9, bodyH * 1.3), M.body, 0, 0, bodyH * 0.9));   // batarya/üst kapak
    grp.add(mesh(new T.BoxGeometry(bodyW * 0.3, bodyW * 0.3, bodyH * 0.4), M.orange, 0, bodyW * 0.42, bodyH * 1.6));   // burun işareti (ileri +Y)
    grp.add(mesh(new T.CylinderGeometry(bodyW * 0.12, bodyW * 0.12, 0.03, 10).rotateX(Math.PI / 2), M.white, 0, -bodyW * 0.1, bodyH * 1.7));   // GPS
    for (let k = 0; k < n; k++) {
      const a = Math.PI / n + k * (2 * Math.PI / n), c = Math.cos(a), s = Math.sin(a);
      const arm = mesh(new T.CylinderGeometry(span * 0.018, span * 0.022, R - bodyW * 0.3, 8), M.carbon, c * (R + bodyW * 0.3) / 2, s * (R + bodyW * 0.3) / 2, 0);
      arm.rotation.z = a - Math.PI / 2; grp.add(arm);
      grp.add(mesh(new T.CylinderGeometry(span * 0.045, span * 0.05, span * 0.05, 12).rotateX(Math.PI / 2), M.grey, c * R, s * R, span * 0.03));   // motor
      const pr = propeller(span * 0.19, k % 2 ? 1 : -1, M); pr.position.set(c * R, s * R, span * 0.062); grp.add(pr); props.push(pr);
    }
    for (const sx of [-1, 1]) {   // iniş takımı: iki dikey ayak + kızak çubuğu (her yanda)
      for (const y of [-span * 0.18, span * 0.18]) grp.add(mesh(new T.CylinderGeometry(span * 0.01, span * 0.01, span * 0.2, 6).rotateX(Math.PI / 2), M.carbon, sx * span * 0.2, y, -span * 0.1));
      grp.add(mesh(new T.CylinderGeometry(span * 0.01, span * 0.01, span * 0.52, 6), M.carbon, sx * span * 0.2, 0, -span * 0.2));
    }
    // Kamera gimbali (alt ön)
    const gim = new T.Group(); gim.position.set(0, bodyW * 0.35, -bodyH * 1.3);
    gim.add(mesh(new T.CylinderGeometry(span * 0.03, span * 0.03, span * 0.04, 10).rotateX(Math.PI / 2), M.dark));
    gim.add(mesh(new T.SphereGeometry(span * 0.045, 12, 10), M.dark, 0, 0, -span * 0.05));
    gim.add(mesh(new T.CylinderGeometry(span * 0.02, span * 0.025, span * 0.03, 10), M.glass, 0, span * 0.045, -span * 0.05));   // lens ileri (+Y)
    grp.add(gim);
    return { grp, props, ctrl: [], tips: { left: [-R * 0.72, R * 0.72, 0.03], right: [R * 0.72, R * 0.72, 0.03], tail: [0, -R * 0.8, 0.08] } };   // ön kollar kırmızı/yeşil, arka beyaz
  };
  // Helikopter (1.5 m): gövde + kabin camı, kuyruk bomu, dikey/yatay stabilizatör, ana rotor (3 pala) + kuyruk rotoru, kızaklar
  const buildHeli = M => {
    const grp = new T.Group(), props = [];
    const fus = mesh(new T.SphereGeometry(0.22, 16, 12), M.body); fus.scale.set(0.9, 2.0, 0.85); grp.add(fus);
    const cab = mesh(new T.SphereGeometry(0.19, 16, 12), M.glass, 0, 0.22, 0.03); cab.scale.set(0.85, 1.1, 0.8); grp.add(cab);
    grp.add(mesh(new T.BoxGeometry(0.2, 0.3, 0.12), M.dark, 0, -0.05, 0.2));   // motor kaportası
    const boom = mesh(new T.CylinderGeometry(0.03, 0.05, 1.0, 10), M.white, 0, -0.9, 0.08); grp.add(boom);   // kuyruk bomu −Y boyunca (ince uç arkada)
    grp.add(mesh(new T.BoxGeometry(0.02, 0.22, 0.3), M.red, 0, -1.38, 0.2));      // dikey stabilizatör
    grp.add(mesh(new T.BoxGeometry(0.4, 0.12, 0.015), M.white, 0, -1.1, 0.12));   // yatay stabilizatör
    grp.add(mesh(new T.CylinderGeometry(0.02, 0.02, 0.22, 8).rotateX(Math.PI / 2), M.dark, 0, 0, 0.3));   // mast
    const main = propeller(0.85, 1, M, 3, 0.07); main.position.z = 0.42; grp.add(main); props.push(main);
    const tail = propeller(0.17, -1, M, 2, 0.025); tail.rotation.y = Math.PI / 2; tail.position.set(0.06, -1.38, 0.2); grp.add(tail); props.push(tail);
    for (const s of [-1, 1]) {
      grp.add(mesh(new T.CylinderGeometry(0.015, 0.015, 0.9, 8), M.grey, s * 0.22, 0.05, -0.3));   // kızak (Y boyunca)
      for (const y of [-0.2, 0.3]) { const st = mesh(new T.CylinderGeometry(0.012, 0.012, 0.22, 6).rotateX(Math.PI / 2), M.grey, s * 0.16, y, -0.2); st.rotation.y = s * 0.5; grp.add(st); }   // dikey destekler
    }
    return { grp, props, ctrl: [], tips: { left: [-0.2, 0.1, -0.05], right: [0.2, 0.1, -0.05], tail: [0, -1.4, 0.36] } };
  };
  // Delta uçan kanat (açıklık 2.2 m, uzunluk ~3.1 m): yuvarlak burunlu gövde, delta kanat, kanat ucu dikey yüzeyler,
  // arkadan itişli pervane, elevonlar (RC ile hareket). ExtrudeGeometry ile kanat planformu (XY düzlemi, kalınlık Z).
  const buildDelta = M => {
    const grp = new T.Group(), props = [], ctrl = [];
    const span = 2.2, L = 3.1, half = span / 2;
    const shape = new T.Shape();   // planform (sağ yarı + sol yarı simetrik), burun +Y
    shape.moveTo(0, 1.35); shape.lineTo(0.22, 1.0); shape.lineTo(half, -1.25); shape.lineTo(half, -1.45); shape.lineTo(0.3, -1.45);
    shape.lineTo(0, -1.5); shape.lineTo(-0.3, -1.45); shape.lineTo(-half, -1.45); shape.lineTo(-half, -1.25); shape.lineTo(-0.22, 1.0); shape.closePath();
    const wing = mesh(new T.ExtrudeGeometry(shape, { depth: 0.06, bevelEnabled: true, bevelThickness: 0.02, bevelSize: 0.02, bevelSegments: 2 }), M.white, 0, 0, -0.04);
    grp.add(wing);
    // CylinderGeometry Y ekseni boyunca = gövde burun ekseni (+Y); burun geniş, kuyruk dar
    const fus = mesh(new T.CylinderGeometry(0.17, 0.11, L * 0.72, 16), M.white, 0, -0.1, 0.03); grp.add(fus);
    const nose = mesh(new T.SphereGeometry(0.17, 16, 12), M.white, 0, L * 0.72 / 2 - 0.1, 0.03); nose.scale.set(1, 1.6, 1); grp.add(nose);
    grp.add(mesh(new T.CylinderGeometry(0.11, 0.06, 0.25, 12), M.dark, 0, -L * 0.72 / 2 - 0.1 - 0.12, 0.03));   // motor kaportası
    for (const s of [-1, 1]) {   // kanat ucu dikey yüzeyler (yukarı/aşağı)
      const fin = mesh(new T.BoxGeometry(0.03, 0.5, 0.34), M.red, s * (half - 0.015), -1.2, 0.1); fin.geometry.translate(0, 0, 0); grp.add(fin);
      const el = mesh(new T.BoxGeometry(0.72, 0.16, 0.025), M.grey, s * 0.72, -1.52, 0); el.geometry.translate(0, -0.08, 0);   // elevon (menteşe ön kenarda)
      grp.add(el); ctrl.push(ctrlSurface(el, 'elevon', s < 0 ? 'l' : 'r', 1));   // gövde çerçevesi: +rotation.x arka kenarı aşağı indirir
    }
    const pr = propeller(0.33, 1, M, 2); pr.rotation.x = -Math.PI / 2; pr.position.set(0, -L * 0.72 / 2 - 0.1 - 0.28, 0.03); grp.add(pr); props.push(pr);
    return { grp, props, ctrl, tips: { left: [-half, -1.3, 0.28], right: [half, -1.3, 0.28], tail: [0, -1.5, 0.08] } };
  };
  // CAYMAZ V3 (STEP → GLB): kanat açıklığı 3.03 m, uzunluk 3.1 m, arkadan itişli; prop düğümü GLB içinde (glTF Z ekseni = burun ekseni)
  let glbCache = null;
  const loadCaymaz = () => (glbCache ??= fetch('/static/models/caymaz-sim.glb', { credentials: 'same-origin' })
    .then(r => { if (!r.ok) throw new Error(`glb ${r.status}`); return r.arrayBuffer(); })
    .then(ab => new Promise((resolve, reject) => new GLTFLoader().parse(ab, '/static/models/', g => resolve(g.scene), reject)))
    .catch(e => { glbCache = null; throw e; }));
  const buildCaymaz = async M => {
    const sc = (await loadCaymaz()).clone(true);
    sc.traverse(o => { if (o.isMesh) { o.castShadow = true; o.material = o.material.clone(); } });
    const inner = new T.Group();
    inner.rotation.order = 'ZYX';
    inner.rotation.set(Math.PI / 2, 0, Math.PI);   // glTF (Y yukarı, burun +Z, sol +X) → gövde (burun +Y, sağ +X, üst +Z)
    inner.add(sc);
    const grp = new T.Group(); grp.add(inner);
    const props = [];
    const prop = sc.getObjectByName('prop');
    if (prop) {   // GLB pervanesi (Ø 0.81 m) + bulanıklık diski (glTF yerel XY düzlemi = pervane düzlemi)
      const disc = new T.Mesh(new T.RingGeometry(0.05, 0.405, 24, 1), M.disc.clone()); prop.add(disc);
      prop.userData.dir = 1; prop.userData.disc = disc; props.push(prop);
    }
    return { grp, props, ctrl: findCtrlNodes(sc), tips: { left: [-1.5, -0.95, 0.3], right: [1.5, -0.95, 0.3], tail: [0, -1.15, 0.02] } };
  };
  // ---------- kontrol yüzeyleri (Caymaz GLB düğümleri / delta / kütüphane GLB'si; animasyon kare döngüsünde) ----------
  // Kayıt: { obj, surface: elevon|flap|aileron|elevator|rudder, side: l|r|'' , q0 (dinlenme yönelimi), teDown (yerel X etrafında arka kenarı
  // AŞAĞI — rudder'da SAĞA — indiren dönüş işareti), deg (gösterilen açı, ° arka kenar aşağı +), tgt (hedef °) }.
  // GLB düğümleri adıyla bulunur (step2glb.js: elevon_l/elevon_r/flap_l/flap_r, rudder_l/r; talon: aileron_l/r, ruddervator_l/r); extras.te_down
  // işareti (glTF'de −1), yoksa −1. CTRL_RE flightsim_airframe.js'den (ruddervator dahil).
  const ctrlSurface = (obj, surface, side, teDown) => { obj.userData.ctrl = { surface, side }; return { obj, surface, side, q0: obj.quaternion.clone(), teDown: teDown || -1, deg: 0, tgt: 0 }; };
  const findCtrlNodes = sc => {
    const out = [];
    sc.traverse(n => {
      const m = CTRL_RE.exec((n.name || '').trim()); if (!m) return;
      for (let a = n.parent; a && a !== sc; a = a.parent) if (CTRL_RE.test((a.name || '').trim())) return;   // yalnız en üst eşleşen düğüm
      const ex = n.userData || {}, side = (m[2] || '').toLowerCase().slice(0, 1);
      out.push(ctrlSurface(n, m[1].toLowerCase(), side, Number(ex.te_down) || -1));
    });
    return out;
  };
  // VTOL: uçak gövdesi + kanat altı iki bum + 4 dikey motor/pervane (ileri/geri)
  const addVtolMotors = (built, M) => {
    const bb = new T.Box3().setFromObject(built.grp);
    const sx = (bb.max.x - bb.min.x) * 0.27, L = 1.5;
    for (const x of [-sx, sx]) {
      built.grp.add(mesh(new T.CylinderGeometry(0.03, 0.03, L, 8), M.carbon, x, -0.05, -0.02));   // bum Y boyunca (ileri-geri)
      for (const y of [-L / 2 + 0.05, L / 2 - 0.05]) {
        built.grp.add(mesh(new T.CylinderGeometry(0.04, 0.045, 0.06, 10).rotateX(Math.PI / 2), M.grey, x, y, 0.02));
        const pr = propeller(0.28, x * y > 0 ? 1 : -1, M); pr.position.set(x, y, 0.06); built.grp.add(pr); built.props.push(pr);
      }
    }
    return built;
  };
  // Seyir ışıkları: sol kırmızı, sağ yeşil (sabit + senkron flaş), kuyruk beyaz strobe; gece/akşam halo (additif sprite)
  let haloTex = null;
  const haloTexture = () => {
    if (haloTex) return haloTex;
    const cv = document.createElement('canvas'); cv.width = cv.height = 64;
    const g = cv.getContext('2d'), gr = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(0.25, 'rgba(255,255,255,0.55)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = gr; g.fillRect(0, 0, 64, 64);
    haloTex = new T.CanvasTexture(cv);
    return haloTex;
  };
  const addNavLights = (built, tips) => {
    const lights = [];
    for (const [key, color, kind] of [['left', 0xff2a1a, 'nav'], ['right', 0x22ff55, 'nav'], ['tail', 0xffffff, 'strobe']]) {
      const p = tips[key]; if (!p) continue;
      const g = new T.Group(); g.position.set(p[0], p[1], p[2]);
      const bulb = new T.Mesh(new T.SphereGeometry(0.035, 8, 6), new T.MeshBasicMaterial({ color, toneMapped: false }));
      const halo = new T.Sprite(new T.SpriteMaterial({ map: haloTexture(), color, transparent: true, opacity: 0.8, blending: T.AdditiveBlending, depthWrite: false, toneMapped: false }));
      halo.scale.setScalar(0.5);
      g.add(bulb, halo); g.userData = { kind, bulb, halo };
      built.grp.add(g); lights.push(g);
    }
    built.lights = lights;
  };
  // ---------- kütüphane modelleri (§12): GLB (tarayıcıda STEP/OBJ'den dönüştürülmüş ya da yüklenmiş) + yönelim ----------
  // model: { id, glb_url, orient:{forward, up, scale, offset, prop:{mode,pos,r}}, has_prop }. Model ekseni → gövde çerçevesi (burun +Y, sağ +X,
  // üst +Z): R satırları = (forward×up, forward, up). Pervane düğümleri adıyla (prop/propeller/rotor/pervane; en üst eşleşen) bulunur ve en ince
  // sınır kutusu ekseni etrafında döndürülür; yoksa orient.prop ile prosedürel pervane (kuyruk/burun/elle konum) eklenir.
  const glbLib = new Map();   // url → Promise<scene>
  const loadGlbUrl = url => {
    if (!glbLib.has(url)) glbLib.set(url, fetch(url, { credentials: 'same-origin' })
      .then(r => { if (!r.ok) throw new Error(`glb ${r.status}`); return r.arrayBuffer(); })
      .then(ab => new Promise((resolve, reject) => new GLTFLoader().parse(ab, url.slice(0, url.lastIndexOf('/') + 1), g => resolve(g.scene), reject)))
      .catch(e => { glbLib.delete(url); throw e; }));
    return glbLib.get(url);
  };
  const axisVec = a => { const v = new T.Vector3(); v[(a || '+y')[1]] = (a || '+y')[0] === '-' ? -1 : 1; return v; };
  const PROP_RE = /prop|propeller|rotor|pervane/i;
  const buildLibrary = async (model, M) => {
    const sc = (await loadGlbUrl(model.glb_url)).clone(true);
    sc.traverse(o => { if (o.isMesh) { o.castShadow = true; o.material = Array.isArray(o.material) ? o.material.map(m => m.clone()) : o.material.clone(); } });
    const o = model.orient || {};
    const f = axisVec(o.forward || '+y'), u = axisVec(o.up || '+z');
    if (Math.abs(f.dot(u)) > 0.5) u.set(0, 0, 0)[['x', 'y', 'z'].find(k => Math.abs(f[k]) < 0.5)] = 1;
    const r = f.clone().cross(u);
    const inner = new T.Group();
    inner.quaternion.setFromRotationMatrix(new T.Matrix4().makeBasis(r, f, u).transpose());   // model → gövde
    inner.scale.setScalar(Number(o.scale) > 0 ? Number(o.scale) : 1);
    inner.position.set(...(Array.isArray(o.offset) && o.offset.length === 3 ? o.offset.map(Number) : [0, 0, 0]));
    inner.add(sc);
    const grp = new T.Group(); grp.add(inner);
    grp.updateMatrixWorld(true);
    const props = [];
    if (model.has_prop !== false) {
      sc.traverse(n => {
        if (!PROP_RE.test(n.name || '')) return;
        for (let a = n.parent; a && a !== sc; a = a.parent) if (PROP_RE.test(a.name || '')) return;   // yalnız en üst eşleşen düğüm
        // dönüş ekseni: düğümün yerel sınır kutusunda en ince eksen (pervane düzlemine dik)
        const inv = new T.Matrix4().copy(n.matrixWorld).invert(), bb = new T.Box3();
        n.traverse(c => { if (c.isMesh && c.geometry) { c.geometry.computeBoundingBox(); bb.union(c.geometry.boundingBox.clone().applyMatrix4(new T.Matrix4().multiplyMatrices(inv, c.matrixWorld))); } });
        const sz = bb.isEmpty() ? new T.Vector3(1, 1, 0.1) : bb.getSize(new T.Vector3());
        n.userData.axis = sz.x <= sz.y && sz.x <= sz.z ? 'x' : sz.y <= sz.z ? 'y' : 'z';
        n.userData.dir = props.length % 2 ? -1 : 1;
        props.push(n);
      });
    }
    const bb = new T.Box3().setFromObject(grp);
    const p = o.prop || {};
    if (p.mode && p.mode !== 'none' && !props.length) {   // prosedürel pervane: kuyruk (arkadan itiş) / burun (çekiş) / elle konum; dönüş ekseni gövde Y
      const rr = Number(p.r) > 0 ? Number(p.r) : 0.3, cz = (bb.min.z + bb.max.z) / 2;
      const pos = p.mode === 'manual' && Array.isArray(p.pos) ? p.pos.map(Number) : p.mode === 'nose' ? [0, bb.max.y + 0.04, cz] : [0, bb.min.y - 0.04, cz];
      const pr = propeller(rr, 1, M, 2); pr.rotation.x = -Math.PI / 2; pr.position.set(pos[0], pos[1], pos[2]);
      grp.add(mesh(new T.CylinderGeometry(rr * 0.12, rr * 0.14, 0.08, 10), M.dark, pos[0], pos[1] + (p.mode === 'nose' ? -0.05 : 0.05), pos[2]));   // motor kaportası
      grp.add(pr); props.push(pr);
    }
    const w = Math.max(bb.max.x - bb.min.x, 0.3), hz = bb.max.z;
    return { grp, props, ctrl: findCtrlNodes(sc), tips: { left: [bb.min.x, bb.min.y + (bb.max.y - bb.min.y) * 0.3, hz * 0.6], right: [bb.max.x, bb.min.y + (bb.max.y - bb.min.y) * 0.3, hz * 0.6], tail: [0, bb.min.y, hz * 0.4] }, span: w };
  };
  // Dahili GLB modeller (yönelimli; flightsim_models BUILTIN ile aynı): talon → SIMUMAV GLB çerçevesi (burun +X, yukarı +Y)
  const BUILTIN_GLB = { talon: { glb_url: '/static/models/talon-vtail.glb', orient: { forward: '+x', up: '+y', scale: 1, offset: [0, 0, 0] }, has_prop: true, layout: 'vtail' } };
  // Model seçimi (§12): dize ('caymaz' | 'delta' eski; 'builtin:<ad>') ya da kütüphane nesnesi {id, glb_url, orient, …}
  const SIZES = { multirotor: 0.6, hexarotor: 0.9 };
  const normModel = (type, model) => {
    if (!model) return { id: { multirotor: 'builtin:quad', hexarotor: 'builtin:hexa', helikopter: 'builtin:heli' }[type] || 'builtin:caymaz' };
    if (typeof model === 'string') return { id: model.startsWith('builtin:') ? model : `builtin:${model}` };
    return model;
  };
  const buildFor = async (type, model, M) => {
    const plane = type === 'sabit_kanat' || type === 'vtol';
    let built = null;
    const key = String(model.id || '').replace('builtin:', '');
    const isBuiltin = String(model.id || '').startsWith('builtin:');
    if (isBuiltin && BUILTIN_GLB[key] && !model.glb_url) model = { ...model, ...BUILTIN_GLB[key] };   // dize/kısa nesne ile gelen dahili GLB (mock, eski istemci)
    if (model.glb_url && (!isBuiltin || model.orient)) {   // kütüphane modeli ya da yönelimli dahili GLB (talon): GLB + orient
      try { built = await buildLibrary(model, M); } catch (e) { console.warn('Kütüphane modeli yüklenemedi, dahili modele düşüldü:', e?.message || e); built = null; }
    }
    if (!built && plane && key !== 'delta') { try { built = await buildCaymaz(M); } catch { built = null; } }   // GLB yüklenemedi → delta kanat
    if (!built && plane) built = buildDelta(M);
    if (!built) built = type === 'helikopter' ? buildHeli(M) : buildMulti(type === 'hexarotor' ? 6 : 4, SIZES[type] || 0.6, M);
    if (type === 'vtol') addVtolMotors(built, M);
    // Tekerlekli kalkış (§13): burun + ana iniş takımı (modelde yoksa); yalnız sabit kanat
    if (type === 'sabit_kanat' && (launchCfg?.method || 'wheels') === 'wheels') built.gear = addLandingGear(T, built, new T.Box3().setFromObject(built.grp));
    return built;
  };
  async function setType(type, model) {
    type = type || 'multirotor';
    model = normModel(type, model);
    const seq = ++typeSeq;
    const M = MAT();
    const built = await buildFor(type, model, M);
    if (seq !== typeSeq || disposed) { disposeGroup(built.grp); return; }   // bu arada başka model seçildi
    disposeGroup(drone.group);
    addNavLights(built, built.tips || {});
    built.grp.traverse(o => { if (o.isMesh && !o.isSprite) o.castShadow = true; });
    // Yarıçap ve burun konumu modelin sınırlayıcı kutusundan (kamera mesafeleri ve FPV için); sonra görünürlük ölçeği
    const bb = new T.Box3().setFromObject(built.grp);
    drone.radius = Math.max(bb.max.x - bb.min.x, bb.max.y - bb.min.y, 1) / 2 * MODEL_SCALE;
    drone.nose = (bb.max.y + 0.15) * MODEL_SCALE;
    drone.ground = -bb.min.z * MODEL_SCALE;   // park yüksekliği (iniş takımı / sınır kutusu altı yere değer)
    built.grp.scale.setScalar(MODEL_SCALE);   // 4 km'lik dünyada görünürlük: gerçek boyutun 2.5 katı
    drone.group.add(built.grp);
    drone.props = built.props; drone.ctrl = built.ctrl || []; drone.lights = built.lights || []; drone.type = type; drone.model = model; drone.gear = built.gear || null;
    drone.airframe = (type === 'sabit_kanat' || type === 'vtol') ? ({ 'builtin:caymaz': 'caymaz', 'builtin:delta': 'delta' }[model.id] || null) : null;
    drone.bbox = { size: bb.getSize(new T.Vector3()).toArray(), min: bb.min.toArray(), max: bb.max.toArray() };   // gerçek boyut (m): yönelim paneli bilgi satırı
    if (!tele.has) drone.group.position.set(0, 0, drone.ground + 0.02);   // park: pist merkezinde
    if (rig || launchCfg) buildRig();   // tip değişti: düzenek yalnız sabit kanatta
  }
  let typeSeq = 0;
  // ---------- kalkış düzeneği (§13): rampa / pickup; yalnız sabit kanat. setLaunch(cfg) kurar, setLaunchPhase(p) sunucu aşamalarını uygular ----------
  let launchCfg = opts.launch ? { ...opts.launch } : null, rig = null;
  const rigPos = new T.Vector3(), rigQ = new T.Quaternion();
  let rigSurfT = 0;   // düzenek yüzey örneklemesi son zamanı (ms)
  // released geçişi (§13): kızak ucu ↔ SITL farkı (off, dq) → k ile sönümlenir; kz dikey ofsetin ayrı (yalnız tırmanışla eriyen) katsayısı
  const rel = { on: false, armed: false, t: 0, kz: 1, off: new T.Vector3(), dq: new T.Quaternion(), lastPos: new T.Vector3(), lastQ: new T.Quaternion() };
  const gLock = { on: false, pos: new T.Vector3(), t: 1 };   // yerde kilit (frame içinde; §13)
  function buildRig() {
    rig?.dispose(); rig = null;
    const m = launchCfg?.method;
    if (!launchCfg || (m !== 'ramp' && m !== 'vehicle') || drone.type !== 'sabit_kanat') return;
    rig = createLaunchRig(T, { ...launchCfg, heading: num(W.runway_heading, 0), scale: MODEL_SCALE, night: W.time === 'night', dusk: W.time === 'dusk' });
    scene.add(rig.group);
  }
  async function setLaunch(cfg) {
    const prevMethod = launchCfg?.method || 'wheels';
    launchCfg = cfg ? { ...cfg } : null;
    const nowMethod = launchCfg?.method || 'wheels';
    if (drone.type === 'sabit_kanat' && (prevMethod === 'wheels') !== (nowMethod === 'wheels')) await setType(drone.type, drone.model);   // iniş takımı ekle/kaldır (düzeneği de kurar)
    else buildRig();
  }
  // setLaunchPhase(p, snap): canlıda sunucu `launch` olayı; kayıtta oynatıcı zamanından türetilen aşama (§8). Geri sarma (hedef aşama mevcut
  // aşamadan önce: atlama/baştan) önce `idle` → kızak/araç başa döner. `snap` (atlama): released ofset sönümü kurulmaz — uçak doğrudan log konumunda.
  const PHASE_ORDER = { idle: 0, armed: 1, launch: 2, released: 3, free: 3 };
  const setLaunchPhase = (p, snap = false) => {
    if (!rig) return;
    const np = p === 'armed' ? 'armed' : p === 'launch' ? 'launch' : p === 'released' ? 'released' : 'idle';
    if ((PHASE_ORDER[np] ?? 0) < (PHASE_ORDER[rig.phase] ?? 0)) rig.setPhase('idle');
    if (snap) { rel.on = false; rel.armed = false; }
    rig.setPhase(np);
  };
  // Küçük resim (§12): model ayrı bir sahnede 3/4 açıdan render hedefine çizilir → PNG Blob (320×240). Ana sahneye dokunmaz.
  async function snapshotModel(type, model, w = 320, h = 240) {
    const M = MAT();
    const built = await buildFor(type || 'multirotor', normModel(type || 'multirotor', model), M);
    const sc = new T.Scene(); sc.background = new T.Color(0xe9eef6);
    sc.add(new T.AmbientLight(0xffffff, 1.6));
    const d1 = new T.DirectionalLight(0xffffff, 2.2); d1.position.set(1.5, -1, 2); sc.add(d1);
    const d2 = new T.DirectionalLight(0xffffff, 0.8); d2.position.set(-1, 1, 0.5); sc.add(d2);
    const bb = new T.Box3().setFromObject(built.grp), size = bb.getSize(new T.Vector3()), center = bb.getCenter(new T.Vector3());
    built.grp.position.sub(center); sc.add(built.grp);
    const cam = new T.PerspectiveCamera(32, w / h, 0.01, 1000); cam.up.set(0, 0, 1);
    const rad = Math.max(size.x, size.y, size.z, 0.2) * 0.5, dist = rad / Math.tan(cam.fov * DEG / 2) * 1.35;
    cam.position.set(0.75, -1, 0.55).normalize().multiplyScalar(dist); cam.lookAt(0, 0, 0);
    const rt = new T.WebGLRenderTarget(w, h, { samples: 4 }); rt.texture.colorSpace = T.SRGBColorSpace;
    const prev = renderer.getRenderTarget();
    renderer.setRenderTarget(rt); renderer.render(sc, cam);
    const px = new Uint8Array(w * h * 4); renderer.readRenderTargetPixels(rt, 0, 0, w, h, px);
    renderer.setRenderTarget(prev); rt.dispose(); disposeGroup(built.grp);
    const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
    const img = cv.getContext('2d').createImageData(w, h);
    for (let y = 0; y < h; y++) img.data.set(px.subarray((h - 1 - y) * w * 4, (h - y) * w * 4), y * w * 4);   // WebGL alt-üst → canvas
    cv.getContext('2d').putImageData(img, 0, 0);
    return new Promise(resolve => cv.toBlob(resolve, 'image/png'));
  }

  // ---------- telemetri: uyarlanır gecikme tamponlu enterpolasyon (./flightsim_interp.js; §5) ----------
  // Zaman çizgisi (konum/yönelim ayrı tamponlar, sıralı ekleme, uyarlanır hedef gecikme, ölü hesap + yumuşak yakınsama, ağ/hareket istatistiği)
  // tarayıcısız test edilebilir modüldedir; burada yalnız kare başına yan alanlar (gaz, arm, RC, hız) ve ilk karede kamera yayının oturması.
  const tl = createTimeline(T, { toLocal });
  const cur = tl.cur;                                // render edilen konum/yönelim/hız (yumuşatılmış)
  const tele = { has: false, at: 0, throttle: 0, armed: false, speed: 0, rc: null, servo: null, servoFn: null, servoRev: null, mode: null, terrainAgl: null, last: null };
  function setTelemetry(t) {
    if (!t) return;
    const now = performance.now();
    const r = tl.push(t, now);
    tele.at = now;
    tele.throttle = num(t.throttle, 0); tele.armed = !!t.armed;
    tele.rc = Array.isArray(t.rc) ? t.rc : null;   // RC kanalları 1000…2000 (1: roll, 2: pitch, 4: yaw) → kontrol yüzeyleri (servo yoksa)
    tele.servo = Array.isArray(t.servo) ? t.servo : null;   // SERVO_OUTPUT_RAW 1…8 µs (gerçek SITL): kontrol yüzeylerinin birincil kaynağı
    tele.servoFn = Array.isArray(t.servo_fn) ? t.servo_fn : null;   // isteğe bağlı SERVOn_FUNCTION listesi (4 aileron, 19 elevator, 21 rudder, 2/3 flap, 77/78 elevon L/R)
    tele.servoRev = Array.isArray(t.servo_rev) ? t.servo_rev : null;   // SERVOn_REVERSED listesi: yüzeyler mantıksal yönde (§13.1)
    tele.mode = t.mode || null;
    tele.terrainAgl = typeof t.terrain_agl === 'number' ? t.terrain_agl : null;   // ArduPilot TERRAIN_REPORT AGL (SRTM): 3B arazi örneğiyle tutarlılık süzgeci (§18)
    tele.speed = r.speed;   // son karenin hızı (çarpışma denetimi için; render döngüsü enterpolasyonlu hızla günceller)
    tele.last = t;
    if (r.first) { tele.has = true; camSpring.pos.copy(cur.pos); camSpring.vel.set(0, 0, 0); }
  }
  const netStats = tl.netStats, motionStats = tl.motionStats;
  const advance = rawMs => tl.advance(rawMs);
  // Takip kamerası: hedef (dron) kritik sönümlü yayla izlenir; kullanıcının OrbitControls açısı/mesafesi korunur
  const camSpring = { pos: new T.Vector3(0, 0, 0.6), vel: new T.Vector3(), w: 2 * Math.PI * 1.5 };
  let camSnap = false;   // sonraki karede takip yayı dronun üstüne oturur (kayıtta atlama; kullanıcının bakış açısı/mesafesi korunur)
  const snapCamera = () => { camSnap = true; };

  // ---------- kameralar ----------
  let camMode = 'follow', gimbal = -10;   // derece; 0 = burun hizası, eksi = aşağı (gimbal kamerası 'fpv')
  // FPV (pilot) ayarları (§22): görüş açısı (tekerlek), analog efekt (gölgelendiricide doygunluk; tarama/parazit OSD katmanında), burun görünür (kamera biraz
  // geride ve üstte: gövde ucu / pervane kadrajın altında görünür)
  const fpv = { fov: clamp(num(opts.pilotFov, PILOT_FOV.def), PILOT_FOV.min, PILOT_FOV.max), analog: !!opts.fpvAnalog, nose: opts.fpvNose !== false };
  const free = { yaw: 0, pitch: -10, keys: new Set(), drag: null };
  const followOff = new T.Vector3(-2.4, -3.4, 1.4);   // × yarıçap (resetCamera)
  const tmpV = new T.Vector3(), tmpV2 = new T.Vector3(), tmpQ = new T.Quaternion(), tmpE = new T.Euler();
  const onCamChange = opts.onCameraChange || null;
  function setCamera(mode) {
    if (typeof mode === 'number') mode = CAMERA_MODES[mode - 1]?.[0];
    if (!CAMERA_MODES.some(([k]) => k === mode)) return;
    const prev = camMode;
    camMode = mode;
    controls.enabled = mode === 'follow';
    camera.fov = mode === 'fpv' ? 78 : mode === 'pilot' ? fpv.fov : 60;
    camera.near = mode === 'pilot' ? 0.05 : 0.5;   // FPV: burun/pervane kenarı kesilmesin
    camera.updateProjectionMatrix();
    if (mode === 'follow') resetCamera();
    if (mode === 'free' && prev !== 'free') {
      // Serbest kamera: bulunduğu yerden devam; yön açılarını mevcut bakıştan türet
      camera.getWorldDirection(tmpV);
      free.yaw = Math.atan2(-tmpV.x, tmpV.y) / DEG;
      free.pitch = Math.asin(clamp(tmpV.z, -1, 1)) / DEG;
    }
    if (mode === 'ground') {
      if (rig) { const p = rig.sidePoint(9, -5, 0).add(rig.group.position); camera.position.set(p.x, p.y, terrainHeight(p.x, p.y) + 2.2); }   // rampa / araç yanı (§13)
      else camera.position.set(RUNWAY_W / 2 + 25, -70, terrainHeight(RUNWAY_W / 2 + 25, -70) + 3);
    }
    onCamChange?.(mode);
  }
  function resetCamera() {
    camSpring.pos.copy(cur.pos); camSpring.vel.set(0, 0, 0);
    camera.position.copy(cur.pos).add(tmpV.copy(followOff).multiplyScalar(Math.max(2, drone.radius)));
    controls.target.copy(cur.pos);
    controls.update();
  }
  // Sanal kumanda açıkken WASD/QE/ok tuşları/boşluk kumandaya gider (kamera 1–4 ve FPV tekerleği çalışır)
  let keyLock = false;
  const RC_KEYS = new Set(['w', 'a', 's', 'd', 'q', 'e', ' ', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright']);
  const setKeyboardLock = v => { keyLock = !!v; free.keys.clear(); };
  const setGimbal = delta => { gimbal = clamp(gimbal + delta, -90, 30); return gimbal; };
  // FPV (pilot) görüş açısı: 90–150°, tekerlek ±5; kip etkinse projeksiyon hemen güncellenir
  const setPilotFov = v => {
    fpv.fov = clamp(Math.round(num(v, PILOT_FOV.def)), PILOT_FOV.min, PILOT_FOV.max);
    if (camMode === 'pilot') { camera.fov = fpv.fov; camera.updateProjectionMatrix(); }
    opts.onPilotFov?.(fpv.fov);
    return fpv.fov;
  };

  // Klavye: 1–5 kamera, C kamera döngüsü, ↑↓ gimbal (gimbal kamerası), WASD/QE serbest hareket (Shift hızlı). Form alanlarında devre dışı.
  const editable = el => el && (/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || el.isContentEditable);
  const onKeyDown = e => {
    if (preview || editable(document.activeElement) || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key >= '1' && e.key <= String(CAMERA_MODES.length)) { setCamera(Number(e.key)); e.preventDefault(); return; }
    if ((e.key === 'c' || e.key === 'C') && !e.shiftKey) { setCamera(nextCameraMode(camMode)); e.preventDefault(); return; }
    if (keyLock && RC_KEYS.has(e.key.toLowerCase())) return;
    if (camMode === 'fpv' && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) { setGimbal(e.key === 'ArrowUp' ? 5 : -5); e.preventDefault(); return; }
    if (camMode === 'free') { const k = e.key.toLowerCase(); if ('wasdqe'.includes(k) || e.key === 'Shift') { free.keys.add(k === 'shift' ? 'shift' : k); e.preventDefault(); } }
  };
  const onKeyUp = e => { free.keys.delete(e.key.toLowerCase()); if (e.key === 'Shift') free.keys.delete('shift'); };
  const onPointerDown = e => { if (camMode !== 'free' || e.button !== 0) return; free.drag = { x: e.clientX, y: e.clientY }; canvas.setPointerCapture(e.pointerId); };
  const onPointerMove = e => {
    if (!free.drag) return;
    free.yaw -= (e.clientX - free.drag.x) * 0.25; free.pitch = clamp(free.pitch - (e.clientY - free.drag.y) * 0.2, -89, 89);
    free.drag = { x: e.clientX, y: e.clientY };
  };
  const onPointerUp = () => { free.drag = null; };
  const onWheel = e => {
    if (camMode === 'fpv') { setGimbal(e.deltaY > 0 ? -3 : 3); e.preventDefault(); }
    else if (camMode === 'pilot') { setPilotFov(fpv.fov + (e.deltaY > 0 ? PILOT_FOV.step : -PILOT_FOV.step)); e.preventDefault(); }   // FPV: tekerlek = görüş açısı
  };
  if (!preview) {
    window.addEventListener('keydown', onKeyDown); window.addEventListener('keyup', onKeyUp);
    canvas.addEventListener('pointerdown', onPointerDown); canvas.addEventListener('pointermove', onPointerMove);
    canvas.addEventListener('pointerup', onPointerUp); canvas.addEventListener('pointercancel', onPointerUp);
    canvas.addEventListener('wheel', onWheel, { passive: false });
  }

  // ---------- çarpışma (§5/§18) ----------
  // 3B algısı SITL fiziğinin yerine geçmez: arazi teması sunucuda yalnız ADAYDIR (SITL "SIM Hit ground" teyidi), bina/su kesindir. Sahte tetiklemeyi
  // kesmek için: histerezis (COLL_HOLD_S boyunca sürekli z < h + 0,3), hız > COLL_SPEED_MIN, yerde kilit / düzenek (idle·armed·launch) / released
  // sönümü sırasında ve ARM'dan sonraki ilk COLL_ARM_GRACE_MS kapalı; arazi yüksekliği bir karede COLL_JUMP_M'den fazla değişirse (karo yüklenmesi,
  // uzak halka geçişi) o kare atlanır; Google 3B'de dronun altında yüklü karo yoksa (kaba kök karo / komşu hücre / 0) örnek yok sayılır; gerçek
  // arazide ana kare dışı (uzak halka, kaba) arazi teması denetlenmez. Bir tespitten sonra COLL_COOLDOWN_MS yeniden denetim yok (sunucu adayı
  // düşürürse yeniden tespit edilebilir; kesin çarpışmada sunucu disarm eder → armed düşer).
  // SITL'in kendi arazi AGL'si (TERRAIN_REPORT, SRTM) ile 3B'nin z − h'si COLL_AGL_DISAGREE_M'den fazla ayrışıyorsa 3B örneği kaba karodandır (Google LOD) → arazi/su denetimi o karede yapılmaz.
  const COLL_HOLD_S = 0.4, COLL_HOLD_BUILDING_S = 0.1, COLL_SPEED_MIN = 2, COLL_ARM_GRACE_MS = 3000, COLL_JUMP_M = 20, COLL_COOLDOWN_MS = 4000, COLL_AGL_DISAGREE_M = 30;
  const coll = { below: 0, kind: null, lastH: null, armedAt: -Infinity, prevArmed: false, hitAt: -Infinity, skipped: 0, checks: 0 };
  const terrainHeight = (x, y) => (terrain ? terrain.height(x, y) : 0);
  // Düzenek temas noktaları (§13 "Yüzeye oturma"): örnek { z, fine, err, dem } → flightsim_launch surfaceLock karo niteliğiyle kabul eder/kilitler.
  // • Google 3B: g3d.surfaceAt — ışın YALNIZ karo grubuna (tiles.raycast; uçak/düzenek/kamera yardımcıları hariç); fine = çarpılan karonun
  //   geometricError ≤ RIG_FINE_ERR ya da yaprak karo. Kaba/kök karo (ilk saniyelerde −280 m görülmüştü) fine=false → değer kullanılmaz; yedek (dem)
  //   0'dır (merkez yüzeyi groundOffset ile 0'a oturur; eski "|h| > 8 m → 0" eşiği eğimli merkezlerde gerçek yükseklikleri de atıyordu — kaldırıldı).
  // • Gerçek arazi: arazi ÖRGÜSÜNE ışın (yalnız terrain.mesh; görünen üçgenler) → ızgara interpolasyonundan doğru; örgü dışı/ışın yoksa terrain.height.
  // • Prosedürel: analitik terrain.height (her zaman ince).
  const rigRay = new T.Raycaster(); rigRay.firstHitOnly = true; rigRay.far = 50000;
  const rigFrom = new T.Vector3(), rigDown = new T.Vector3(0, 0, -1), rigHits = [];
  const rigSurf = (x, y) => {
    if (g3d) {
      const q = g3d.surfaceAt(x, y, RIG_FINE_ERR);
      return q ? { z: q.z, fine: q.fine, err: q.err ?? 0, dem: 0 } : { z: 0, fine: false, err: Infinity, dem: 0 };
    }
    const hz = terrainHeight(x, y);
    if (terrain?.mesh) {
      rigHits.length = 0; rigFrom.set(x, y, 20000); rigRay.set(rigFrom, rigDown);
      rigRay.intersectObject(terrain.mesh, false, rigHits);
      if (rigHits.length) return { z: rigHits[0].point.z, fine: true, err: 0, dem: hz };
    }
    return { z: hz, fine: true, err: 0, dem: hz };
  };
  const rigOffset = () => (g3d ? g3d.groundOffset : 0);   // Google yer ofseti: karolar toptan kayarsa kilitli değerler de kayar (surfaceLock)
  function checkCollision(now, dt) {
    if (!tele.has) return;
    if (tele.armed && !coll.prevArmed) coll.armedAt = now;
    coll.prevArmed = tele.armed;
    const reset = () => { coll.below = 0; coll.kind = null; };
    if (!tele.armed || tele.speed <= COLL_SPEED_MIN || now - coll.hitAt < COLL_COOLDOWN_MS || now - coll.armedAt < COLL_ARM_GRACE_MS) return reset();
    if ((rig && rig.carrying) || rel.on || gLock.on) return reset();   // düzenek üstünde / bırakma sönümü / yerde kilit
    const p = cur.pos;
    coll.checks++;
    const outsideMain = terrain && !terrain.google && (Math.abs(p.x) > terrain.size / 2 || Math.abs(p.y) > terrain.size / 2);   // uzak halka: kaba
    const noTile = terrain?.google && g3d && !g3d.hasSurface(p.x, p.y);   // Google: altında yüklü karo yok (0 / komşu hücre) → arazi örneği güvenilmez
    const hz = terrainHeight(p.x, p.y);
    const jump = coll.lastH != null && Math.abs(hz - coll.lastH) > COLL_JUMP_M;
    coll.lastH = hz;
    const disagree = tele.terrainAgl != null && Math.abs((p.z - hz) - tele.terrainAgl) > COLL_AGL_DISAGREE_M;
    let hit = null;
    if (jump || noTile || outsideMain || disagree) coll.skipped++;
    else {
      const onRunway = Math.hypot(p.x, p.y) <= 25 || ((W.runway !== false || terrain?.google) && inRunway(p.x, p.y, num(W.runway_heading, 0), 4));   // pist/kalkış alanında yer teması (koşu, iniş) çarpışma değil; Google 3B'de pist çizilmese de runway_heading boyunca sanal şerit
      if (p.z < hz + 0.3 && !onRunway) hit = { kind: 'terrain', z: hz };
    }
    if (!hit && terrain && !noTile && !disagree && p.z < terrain.waterZ + 0.3) hit = { kind: 'water', z: terrain.waterZ };
    else if (!hit && terrain?.real && !outsideMain && waterPolys.some(w => p.x >= w.x1 && p.x <= w.x2 && p.y >= w.y1 && p.y <= w.y2 && p.z < w.z + 0.3 && pointInPoly(p.x, p.y, w.pts))) hit = { kind: 'water', z: hz };
    if (!hit) {
      const b = buildingsAABB.find(b => p.x > b.x1 && p.x < b.x2 && p.y > b.y1 && p.y < b.y2 && p.z < b.z2 + 0.3);
      if (b) hit = { kind: 'building', z: b.z2 };
    }
    if (!hit) return reset();
    if (coll.kind !== hit.kind) { coll.kind = hit.kind; coll.below = 0; }
    coll.below += dt;
    if (coll.below < (hit.kind === 'building' ? COLL_HOLD_BUILDING_S : COLL_HOLD_S)) return;   // histerezis: sürekli temas gerekir
    coll.hitAt = now; reset();
    onCollision?.({ ...hit, x: p.x, y: p.y, alt: p.z, dz: hit.z - p.z, speed: tele.speed, held: true });
  }
  const clearCollision = () => { coll.hitAt = -Infinity; coll.below = 0; coll.kind = null; coll.lastH = null; };

  // ---------- boyut ----------
  function resize() {
    const w = Math.max(1, mountEl.clientWidth), hgt = Math.max(1, mountEl.clientHeight);
    renderer.setSize(w, hgt, false);
    camera.aspect = w / hgt;
    camera.updateProjectionMatrix();
  }
  const ro = new ResizeObserver(resize);
  ro.observe(mountEl);

  // ---------- kare döngüsü ----------
  let raf = 0, lastT = performance.now(), disposed = false, previewAngle = 0.6;
  const propAngle = { v: 0 };
  // ---------- kontrol yüzeyi animasyonu (§13.1; saf katman flightsim_airframe.js) ----------
  // Kaynak önceliği: tele.servo (SERVO_OUTPUT_RAW µs; SITL karışımı/flap otomatiği hazır) → tele.rc (sahte kip / kayıt). SERVOn_FUNCTION (tele.servoFn)
  // ile kanal → işlev (4/19/21/2/3/77/78/79/80), SERVOn_REVERSED (tele.servoRev) ile MANTIKSAL çıkış (gerçek uçakta ters monteli servo PWM'i geri
  // çevirir). Elevon/ruddervator çiftleri doğrudan ArduPlane karışımından; eksen komutları geri çözülür → düğüm adı düzenden farklı modelde de
  // (Caymaz + V-kuyruk düzeni) yüzeyler tutarlı. Açılar ±25°, flap 0…+35°; servo 400°/s + τ 40 ms. Disarm → nötr. Servo yoksa flap moddan
  // (TAKEOFF %50, LAND %100).
  let ctrlIn = controlInputs(null);
  const ctrlQ = new T.Quaternion(), ctrlAxis = new T.Vector3(1, 0, 0);
  function updateCtrl(dt) {
    const o = ctrlIn = controlInputs({ servo: tele.servo, fn: tele.servoFn, rev: tele.servoRev, rc: tele.rc, mode: tele.mode, armed: tele.armed });
    for (const c of drone.ctrl) {
      c.tgt = surfaceTarget(c.surface, c.side, o, CTRL_MAX);
      c.deg = easeSurface(c.deg, c.tgt, dt);
      ctrlQ.setFromAxisAngle(ctrlAxis, c.deg * c.teDown * Math.PI / 180);
      c.obj.quaternion.copy(c.q0).multiply(ctrlQ);
    }
  }
  function frame(now) {
    if (disposed) return;
    raf = requestAnimationFrame(frame);
    const rawDt = Math.max(0, (now - lastT) / 1000), dt = Math.min(0.1, rawDt); lastT = now;
    // Telemetri: uyarlanır gecikme tamponlu enterpolasyon — oynatma başı gerçek geçen süreyle (kırpılmamış) ilerler; tampon bitince ölü hesap
    if (tele.has) {
      advance(Math.min(2000, rawDt * 1000));
      tele.speed = cur.vel.length();
      drone.group.position.copy(cur.pos);
      drone.group.position.z += drone.ground || 0;   // alt_rel gövde orijini değil tekerlek/kızak yüksekliği: yerde model piste gömülmesin
      drone.group.quaternion.copy(cur.q);
    }
    // Kalkış düzeneği (§13): uçak kızakta/kasada iken konumu SITL yerine düzenekten (kızağa kilitli). Düzenek altındaki yüzeye oturur
    // (terrainHeight: gerçek arazi ızgarası / Google karo ışını; 4 temas noktası → yükseklik + eğim; karolar yüklendikçe 500 ms'de bir yeniden).
    if (rig) {
      if (tele.has && rig.carrying && rig.phase !== 'launch' && (cur.pos.z > 3 || (tele.armed && tele.speed > 8))) rig.setPhase('released');   // dizi dışı kalkış (MP ile): serbest bırak
      // Düzenek pist başında SABİT: demir bir kez (ilk telemetri) ya da SITL konumu > 2 m sıçrarsa (reset/set_home); araç yer koşusunda her kare izler (§13)
      if (tele.has && rig.anchored && (rig.tracking || rig.needsAnchor(cur.pos))) { rig.anchor(cur.pos, rigSurf, rigOffset()); rigSurfT = now; }
      else if (now - rigSurfT > RIG_SURF_MS) { rigSurfT = now; rig.resurface(rigSurf, rigOffset()); }
      rig.update(dt, { speed: tele.speed });
      if (rig.carrying) {
        rig.attachWorld(rigPos); rigPos.z += drone.ground || 0;
        rig.planeQuat(rigQ);
        drone.group.position.copy(rigPos); drone.group.quaternion.copy(rigQ);
        rel.lastPos.copy(rigPos); rel.lastQ.copy(rigQ); rel.armed = tele.has;
      } else if (rel.armed) {
        // released anı: kızak ucu (3B) ile SITL konumu/yönelimi arasındaki fark ölçülür ve uçağa uygulanır; aşağıda yumuşakça sıfıra iner.
        // (Eski 0,6 sn'lik düz lerp uçağı SITL'in yerdeki (z≈0) konumuna indiriyordu: "rampanın altına inip oradan yükseliyor".)
        rel.armed = false; rel.on = true; rel.t = 0; rel.kz = 1;
        rel.off.copy(rel.lastPos).sub(tmpV.copy(cur.pos).setZ(cur.pos.z + (drone.ground || 0)));
        rel.dq.copy(rel.lastQ).multiply(tmpQ.copy(cur.q).invert());   // dq · cur.q = kızak yönelimi
      }
    }
    if (rel.on) {
      rel.t += dt;
      const k = Math.min(1 - smooth(0, REL_T, rel.t), 1 - smooth(REL_AGL * 0.3, REL_AGL, cur.pos.z));   // yatay ofset + yönelim: 3 sn ya da AGL 15 m
      // Dikey ofset yalnız uçağın kendi tırmanışıyla erir (gösterilen z asla düşmez → rampa/kasa altına inmez); 6 sn'den sonra her durumda 1 sn'de kapanır
      if (rel.off.z > 0.01) {
        const vz = Math.max(0, cur.vel.z);
        rel.kz = Math.max(k, rel.kz - vz * dt / rel.off.z);
        if (rel.t > REL_TMAX) rel.kz = Math.max(0, rel.kz - dt);
      } else rel.kz = k;
      tmpV.copy(cur.pos).setZ(cur.pos.z + (drone.ground || 0));
      tmpV.x += rel.off.x * k; tmpV.y += rel.off.y * k; tmpV.z += rel.off.z * rel.kz;
      drone.group.position.copy(tmpV);
      tmpQ.copy(rel.dq).multiply(cur.q);
      drone.group.quaternion.slerpQuaternions(cur.q, tmpQ, k);
      if (k <= 0 && rel.kz <= 0) rel.on = false;
    }
    // Yerde kilit (§13): disarm + yerde (AGL < 1 m) + yer hızı < 0,5 m/s iken gösterilen konum dondurulur (EKF'nin cm'lik gezinmesi görünmez);
    // ARM ya da hareketle 0,4 sn'de SITL konumuna döner; > 1,5 m sıçrama (reset / set_home) kilidi yeniden oturtur. Uçak düzenekteyken düzenek kilitler.
    // Kilitli konumun z'si altındaki yüzeyden aşağı olmaz (tekerlekli uçak eğimli/ofsetli gerçek yüzeye gömülmez).
    if (tele.has && !(rig && rig.carrying) && !rel.on) {
      if (!tele.armed && cur.pos.z < 1 && tele.speed < 0.5) {
        if (!gLock.on || gLock.pos.distanceTo(cur.pos) > 1.5) { gLock.on = true; gLock.pos.copy(cur.pos); gLock.pos.z = Math.max(gLock.pos.z, terrainHeight(gLock.pos.x, gLock.pos.y)); }
        gLock.t = 0;
        drone.group.position.copy(gLock.pos).setZ(gLock.pos.z + (drone.ground || 0));
      } else if (gLock.on) {
        gLock.t = Math.min(1, gLock.t + dt / 0.4);
        drone.group.position.lerpVectors(tmpV.copy(gLock.pos).setZ(gLock.pos.z + (drone.ground || 0)), drone.group.position, gLock.t);
        if (gLock.t >= 1) gLock.on = false;
      }
    }
    if (tele.has) {
      if (camMode === 'follow') {
        // kritik sönümlü yay: a = −2ω·v − ω²·(x − hedef); kullanıcının kamera−hedef vektörü (OrbitControls) korunur.
        // Düşük kare hızında (yazılım WebGL, 4–10 fps) gerçek geçen süre kadar küçük alt adımlarla ilerler: yay kararlı kalır ve kamera
        // dronun gerisinde kalmaz. Atlama (kayıt kaydırıcısı) sonrasında yay doğrudan dronun üstüne oturtulur (snapCamera).
        tmpV2.copy(camera.position).sub(controls.target);
        if (camSnap) { camSnap = false; camSpring.pos.copy(cur.pos); camSpring.vel.set(0, 0, 0); }
        else {
          const w = camSpring.w;
          let left = Math.min(0.5, rawDt);
          while (left > 0) {
            const h = Math.min(left, 1 / 120); left -= h;
            tmpV.copy(camSpring.pos).sub(cur.pos).multiplyScalar(-w * w).addScaledVector(camSpring.vel, -2 * w);
            camSpring.vel.addScaledVector(tmpV, h);
            camSpring.pos.addScaledVector(camSpring.vel, h);
          }
        }
        controls.target.copy(camSpring.pos);
        camera.position.copy(camSpring.pos).add(tmpV2);
      }
      checkCollision(now, dt);
    }
    // İniş takımı tekerlekleri (§13): yerde yer hızıyla döner; havalanınca sabit (geri çekme yok)
    if (drone.gear && tele.has && cur.pos.z < 1.5 && tele.speed > 0.05) { const w = tele.speed / (drone.gear.radius * MODEL_SCALE) * dt; for (const wh of drone.gear.wheels) wh.rotation.x -= w; }
    // Pervaneler: arm'lıysa en az rölanti, gaz ile hızlanır; yüksek devirde palalar gizlenir, bulanıklık diski belirir.
    // Düşük kare hızında (Google 3B / yazılım WebGL) kırpılmamış gerçek süre kullanılır (açı 2π'ye sarılır) → devir kare hızına bağlı değişmez
    const rate = tele.armed ? 12 + tele.throttle * 0.9 : 0;   // rad/s
    const pdt = Math.min(0.5, rawDt);
    propAngle.v = (propAngle.v + rate * pdt) % (2 * Math.PI);
    const blur = clamp((rate - 20) / 40, 0, 1);
    for (const p of drone.props) {
      const ax = p.userData.axis || 'z';
      p.rotation[ax] = (p.rotation[ax] + rate * pdt * (p.userData.dir || 1)) % (2 * Math.PI);   // kütüphane modeli pervanesi: en ince sınır kutusu ekseni
      if (p.userData.disc) p.userData.disc.material.opacity = 0.45 * blur;
      if (p.userData.blades) for (const b of p.userData.blades) b.visible = blur < 0.85;
    }
    if (drone.ctrl.length) updateCtrl(pdt);   // kontrol yüzeyleri (servo/rc → hedef açı → servo hızı sınırı)
    // Seyir ışıkları: kırmızı/yeşil 1 Hz çift flaş üzerine sabit; kuyruk beyaz strobe 1 Hz (gece halo büyür)
    const tt = now / 1000, ph = tt % 1, navOn = ph < 0.08 || (ph > 0.16 && ph < 0.24), strobeOn = ph > 0.5 && ph < 0.58;
    const night = W.time === 'night', dusk = W.time === 'dusk', haloBase = night ? 0.55 : dusk ? 0.4 : 0.22;   // sprite ölçeği model ölçeğiyle çarpılır
    for (const l of drone.lights) {
      const on = l.userData.kind === 'strobe' ? strobeOn : navOn;
      l.userData.halo.scale.setScalar(haloBase * (on ? 1.8 : l.userData.kind === 'strobe' ? 0 : 0.7));
      l.userData.halo.visible = l.userData.kind !== 'strobe' || on;
      l.userData.bulb.visible = l.userData.kind !== 'strobe' || on || !night;
    }
    // Gölge: güneş dronu izler
    if (!preview) { lights.sun.target.position.copy(cur.pos); lights.sun.position.copy(cur.pos).addScaledVector(sunDir, 120); }
    // Google 3B karoları: kamera çözünürlüğü + LOD + yer ofseti (kalkışa dek); kamera kipi değişse de aynı camera nesnesi
    if (g3d) { try { g3d.update(camera, tele.has && tele.armed && tele.speed > 1, now); } catch { /* karo hatası kareyi durdurmasın */ } }
    // Kamera kipleri
    if (preview) {
      previewAngle += dt * 0.12;
      const R = Math.max(900, terrain ? terrain.size * 0.32 : 1200);
      camera.position.set(Math.cos(previewAngle) * R, Math.sin(previewAngle) * R, Math.max(260, terrain ? terrain.H * 0.9 + 160 : 300));
      camera.lookAt(0, 0, 40);
    } else if (camMode === 'follow') {
      controls.update();
    } else if (camMode === 'fpv') {
      // Gimbal kamerası — burun konumu: gövde +Y yönünde model yarıçapı kadar ileri, biraz yukarı; bakış: gövde yönelimi × (90° + gimbal) X dönüşü
      tmpV.set(0, drone.nose, 0.12 * MODEL_SCALE).applyQuaternion(cur.q);
      camera.position.copy(cur.pos).add(tmpV);
      tmpQ.setFromAxisAngle(tmpV2.set(1, 0, 0), (90 + gimbal) * DEG);
      camera.quaternion.copy(cur.q).multiply(tmpQ);
    } else if (camMode === 'pilot') {
      // GERÇEK FPV (§22): kamera burna sabit (burun noktası + küçük ileri ofset; 'burun görünür' açıkken biraz geride ve üstte → gövde ucu/pervane kadrajda),
      // gövdeyle birlikte döner: roll/pitch/yaw TAM uygulanır (ufuk yatar); gimbal yok. Gösterilen (kilit/düzenek dahil) gövde konumu kullanılır.
      // ofsetler model yarıçapına oranlı (kopter 0,75 m → birkaç cm; Caymaz ~3,8 m → ~30 cm geride): burun görünürken gövde ucu kadrajın altında
      const back = fpv.nose ? -0.08 * drone.radius : 0.02 * drone.radius, up = fpv.nose ? 0.05 * drone.radius + 0.03 : 0.03 * drone.radius + 0.02;
      tmpV.set(0, drone.nose + back, up).applyQuaternion(drone.group.quaternion);
      camera.position.copy(drone.group.position).add(tmpV);
      tmpQ.setFromAxisAngle(tmpV2.set(1, 0, 0), 90 * DEG);   // gövde +Y (burun) → kamera −Z (bakış)
      camera.quaternion.copy(drone.group.quaternion).multiply(tmpQ);
    } else if (camMode === 'free') {
      const sp = (free.keys.has('shift') ? 120 : 30) * dt;
      tmpE.set((90 + free.pitch) * DEG, 0, free.yaw * DEG, 'ZXY');
      camera.quaternion.setFromEuler(tmpE);
      camera.getWorldDirection(tmpV);
      tmpV2.set(1, 0, 0).applyQuaternion(camera.quaternion);
      if (free.keys.has('w')) camera.position.addScaledVector(tmpV, sp);
      if (free.keys.has('s')) camera.position.addScaledVector(tmpV, -sp);
      if (free.keys.has('d')) camera.position.addScaledVector(tmpV2, sp);
      if (free.keys.has('a')) camera.position.addScaledVector(tmpV2, -sp);
      if (free.keys.has('e')) camera.position.z += sp;
      if (free.keys.has('q')) camera.position.z -= sp;
      camera.position.z = Math.max(camera.position.z, terrainHeight(camera.position.x, camera.position.y) + 1.5);
    } else if (camMode === 'ground') {
      camera.lookAt(cur.pos);
      const dist = camera.position.distanceTo(cur.pos);
      camera.fov = clamp(60 * 35 / Math.max(dist, 1), 5, 60);   // uzaklaştıkça yakınlaştır (teleobjektif)
      camera.updateProjectionMatrix();
    }
    if (camMode === 'pilot' && !preview) {
      // FPV: sahne → render hedefi → balıkgözü/vinyet geçişi (ek maliyet tek tam ekran quad; 60 fps hedef)
      const rt = ensurePostTarget();
      renderer.setRenderTarget(rt);
      renderer.render(scene, camera);
      renderer.setRenderTarget(null);
      post.mat.uniforms.tDiffuse.value = rt.texture;
      post.mat.uniforms.analog.value = fpv.analog ? 1 : 0;
      renderer.render(post.scene, post.cam);
      if (pip.on) renderPip(now);
    } else {
      renderer.render(scene, camera);
    }
    if (frameHooks.size) frameHooks.forEach(fn => { try { fn(canvas); } catch { /* kanca hatası kareyi bozmaz */ } });   // §17: render SONRASI (aynı rAF turu; preserveDrawingBuffer gerekmez)
  }
  // PiP (§22): takip kamerası konumundan (dronun arkası/üstü, followOff × yarıçap) küçük render hedefine PIP_FPS ile; her karede sağ üste kopyalanır.
  // Gölge haritası PiP geçişinde yenilenmez (autoUpdate kapalı), sis/gökyüzü aynı sahne.
  const pipStats = { renders: 0, blits: 0 };
  function renderPip(now) {
    const pr = renderer.getPixelRatio(), rw = Math.round(PIP_SIZE.w * pr), rh = Math.round(PIP_SIZE.h * pr);   // hedef: tampon piksel
    if (!pip.rt || pip.rt.width !== rw || pip.rt.height !== rh) { pip.rt?.dispose(); pip.rt = new T.WebGLRenderTarget(rw, rh, { depthBuffer: true, stencilBuffer: false }); pip.mat.map = pip.rt.texture; pip.mat.needsUpdate = true; pip.lastAt = 0; }
    if (now - pip.lastAt >= 1000 / PIP_FPS) {
      pip.lastAt = now;
      tmpV.copy(followOff).multiplyScalar(Math.max(2, drone.radius));
      pip.cam.position.copy(cur.pos).add(tmpV);
      pip.cam.position.z = Math.max(pip.cam.position.z, terrainHeight(pip.cam.position.x, pip.cam.position.y) + 1);
      pip.cam.lookAt(cur.pos);
      pip.cam.far = camera.far; pip.cam.updateProjectionMatrix();
      const sh = renderer.shadowMap.autoUpdate; renderer.shadowMap.autoUpdate = false;
      renderer.setRenderTarget(pip.rt); renderer.render(scene, pip.cam); renderer.setRenderTarget(null);
      renderer.shadowMap.autoUpdate = sh;
      pipStats.renders++;
    }
    // kopya: sağ üst köşe (viewport + scissor; ana görüntünün üstüne)
    const r = pipRect(), Wc = Math.max(1, mountEl.clientWidth), Hc = Math.max(1, mountEl.clientHeight);   // setViewport/setScissor CSS px alır (pixelRatio içeride)
    renderer.setViewport(r.x, Hc - r.y - r.h, r.w, r.h); renderer.setScissor(r.x, Hc - r.y - r.h, r.w, r.h); renderer.setScissorTest(true);
    renderer.render(pip.scene, post.cam);
    renderer.setScissorTest(false); renderer.setViewport(0, 0, Wc, Hc);
    pipStats.blits++;
  }
  const frameHooks = new Set();   // §17 ekran kaydı: her karede render edilen tuvali okuyan kancalar (drawImage → birleşik kayıt tuvali)

  // ---------- kurulum ----------
  await buildWorld(world);
  await setType(opts.type, opts.model ?? opts.airframe);
  buildRig();
  resize();
  if (!preview) { setCamera(CAMERA_MODES.some(([k]) => k === opts.camera) ? opts.camera : 'follow'); } else { controls.enabled = false; }   // opts.camera: oturumlar arası kalıcı seçim (fs.cam)
  raf = requestAnimationFrame(frame);

  async function setWorld(nw) {
    await buildWorld(nw);
    if (disposed) return;
    buildRig();   // pist yönü / saat değişmiş olabilir
    if (!tele.has) drone.group.position.set(0, 0, (drone.ground || 0.2) + 0.02);
    if (!preview && camMode === 'follow') resetCamera();
    if (routePts.length) mission.redraw();   // yüzey değişti: rota/iniş dairesi yere göre yeniden
  }
  // §14/§18 görev: setMission({points [{seq, cmd, lat, lon, alt_rel, frame}], source, home, current, end, landing_circle_m}) — flightsim_mission.js çizer
  // (tüp bacaklar: geçilen yeşil / aktif parlak / gelecek amber; WP etiketleri; TAKEOFF/LAND/RTL/LOITER ikonları; ev H; bitiş noktasında iniş dairesi H).
  // setRoute(points) geriye uyum: yalnız noktalar. setMissionCurrent(seq): MISSION_CURRENT → aktif bacak. Boş liste görevi siler.
  function setMission(d) {
    const pts = Array.isArray(d?.points) ? d.points.filter(p => p && Number.isFinite(Number(p.lat)) && Number.isFinite(Number(p.lon))) : [];
    routePts = pts;
    if (!pts.length) { mission.set(null); return; }
    mission.set({ ...(d || {}), points: pts });
  }
  function setRoute(points) { setMission({ ...(mission.data || {}), points, end: null }); }
  const setMissionCurrent = seq => mission.setCurrent(seq);
  // Merkez değişti (sihirbaz): gerçek kipte veriler yeni konumdan yüklenir
  async function setOrigin(lat, lon, nw, alt) {
    origin.lat = num(lat, 0); origin.lon = num(lon, 0);
    if (opts.origin) opts.origin.alt = alt; else opts.origin = { lat: origin.lat, lon: origin.lon, alt };
    realCache = null;
    await setWorld(nw || W);   // google3d: merkez anahtarı değişti → karolar yeniden kurulur
  }

  function dispose() {
    disposed = true;
    buildSeq++;   // bekleyen gerçek arazi yüklemesi sonuçlarını kullanmaz
    realCache = null;
    g3d?.dispose(); g3d = null;
    rig?.dispose(); rig = null;
    cancelAnimationFrame(raf);
    ro.disconnect();
    window.removeEventListener('keydown', onKeyDown); window.removeEventListener('keyup', onKeyUp);
    canvas.removeEventListener('pointerdown', onPointerDown); canvas.removeEventListener('pointermove', onPointerMove);
    canvas.removeEventListener('pointerup', onPointerUp); canvas.removeEventListener('pointercancel', onPointerUp);
    canvas.removeEventListener('wheel', onWheel);
    controls.dispose();
    disposeGroup(gWorld); disposeGroup(drone.group); mission.dispose();
    post.rt?.dispose(); post.mat.dispose(); post.quad.geometry.dispose(); pip.rt?.dispose(); pip.mat.dispose(); pip.quad.geometry.dispose();
    renderer.dispose();
    renderer.forceContextLoss?.();
    canvas.remove();
  }

  return {
    setTelemetry, setCamera, getCamera: () => camMode, setGimbal, getGimbal: () => gimbal, resetCamera, snapCamera, terrainHeight, toLocal,
    // FPV (pilot) kipi (§22): görüş açısı 90–150 (tekerlek), analog efekt (gölgelendirici doygunluğu), burun görünür, PiP (takip kamerası sağ üst, 20 fps)
    setPilotFov, getPilotFov: () => fpv.fov, setFpvAnalog: v => { fpv.analog = !!v; }, getFpvAnalog: () => fpv.analog, setFpvNose: v => { fpv.nose = !!v; }, getFpvNose: () => fpv.nose,
    setPip: v => { pip.on = !!v; }, getPip: () => pip.on, pipRect, pipStats: () => ({ ...pipStats }),
    cameraState: () => ({ x: camera.position.x, y: camera.position.y, z: camera.position.z, az: controls.getAzimuthalAngle(), pol: controls.getPolarAngle(), dist: camera.position.distanceTo(controls.target) }),   // teşhis (§14 testleri: fare ile döndürme çalışıyor mu)
    setWorld, setOrigin, setType, snapshotModel, clearCollision, resize, dispose, netStats, motionStats, setKeyboardLock,
    setLaunch, setLaunchPhase, get launchPhase() { return rig ? rig.phase : null; }, get groundLocked() { return gLock.on; },   // kalkış yöntemi + yerde kilit (§13)
    setRoute, setMission, setMissionCurrent, get route() { return routePts.slice(); }, get mission() { return mission.data; }, get missionObjects() { return mission.objectCount; },   // §14/§18: SITL'deki görev (çizim flightsim_mission.js)
    get modelInfo() { return { type: drone.type, model: drone.model, bbox: drone.bbox || null, props: drone.props.length }; },   // yönelim paneli (§12)
    ctrlState: () => { const ctrlIn = controlInputs({ servo: tele.servo, fn: tele.servoFn, rev: tele.servoRev, rc: tele.rc, mode: tele.mode, armed: tele.armed }); return { source: ctrlIn.source, armed: tele.armed, mode: tele.mode, servo: tele.servo, servoFn: tele.servoFn, servoRev: tele.servoRev, rc: tele.rc, layout: layoutForModel(drone.model, drone.ctrl),   // girişler SON kareden taze (düşük fps'te kare gecikmesi servo ile eşleşmezdi)
      inputs: { ail: ctrlIn.ail, ele: ctrlIn.ele, rud: ctrlIn.rud, flap: ctrlIn.flap, elevonL: ctrlIn.elevonL, elevonR: ctrlIn.elevonR, vtailL: ctrlIn.vtailL, vtailR: ctrlIn.vtailR },
      surfaces: drone.ctrl.map(c => ({ name: c.obj.name || `${c.surface}_${c.side}`, surface: c.surface, side: c.side, deg: +c.deg.toFixed(2), tgt: +surfaceTarget(c.surface, c.side, ctrlIn, CTRL_MAX).toFixed(2) })) }; },   // teşhis: kontrol yüzeyi açıları (° arka kenar aşağı +)
    ctrlLayout: () => layoutForModel(drone.model, drone.ctrl),   // §13.1: yüklü modelin düzeni (model.layout ya da yüzey düğüm adlarından)
    get collided() { return collided; }, get world() { return W; }, get waterZ() { return terrain ? terrain.waterZ : -Infinity; },
    get real() { return !!terrain?.real; },
    get google() { return !!g3d; },
    g3dAttribution: () => (g3d ? g3d.attribution() : null),   // {text, logo, loading} — ToS atfı (.fs-attrib)
    get g3dOffset() { return g3d ? g3d.groundOffset : null; },   // teşhis: toplam yer ofseti (karo yüzeyi ↔ ev irtifası)
    collisionState: () => { const p = cur.pos, hz = terrainHeight(p.x, p.y); return { z: p.z, h: hz, dz: p.z - hz, sitlAgl: tele.terrainAgl, below: coll.below, kind: coll.kind, skipped: coll.skipped, checks: coll.checks, armed: tele.armed, speed: tele.speed, noTile: !!(terrain?.google && g3d && !g3d.hasSurface(p.x, p.y)), grounded: gLock.on, rel: rel.on, rig: rig ? rig.phase : null }; },   // teşhis (§18 e2e): her karede z−h
    get terrainInfo() { return terrain ? { real: !!terrain.real, google: !!terrain.google, homeElev: terrain.homeElev ?? null, hmin: terrain.hmin ?? null, hmax: terrain.hmax ?? null, counts: terrain.counts || null, osmError: realCache?.data?.osmError || null, farSize: terrain.farSize || 0 } : null; },
    rigState: () => (rig ? { phase: rig.phase, surface: rig.surface, x: rig.group.position.x, y: rig.group.position.y } : null),   // teşhis (§13 e2e): düzenek yüzey oturması
    rigDiag: () => (rig ? { ...rig.diag, google: !!g3d, real: !!terrain?.real, mesh: !!terrain?.mesh, g3dOffset: g3d ? g3d.groundOffset : null, g3dLoading: g3d ? g3d.loading : null, shownZ: drone.group.position.z - (drone.ground || 0), rel: rel.on ? { t: rel.t, kz: rel.kz, offz: rel.off.z } : null } : null),   // teşhis (§13, window.__fsRig): kilit/incelik/örnekler
    setFreeView: (x, y, z, yawDeg, pitchDeg) => { setCamera('free'); camera.position.set(x, y, z); free.yaw = num(yawDeg, 0); free.pitch = num(pitchDeg, 0); },   // teşhis (§9 e2e): serbest kamerayı ufka yönelt (yaw: 0 kuzey, + batıya)
    get releaseBlend() { return rel.on ? { t: rel.t, kz: rel.kz, off: rel.off.toArray() } : null; },   // teşhis: released ofset sönümü
    shownZ: () => drone.group.position.z - (drone.ground || 0),   // teşhis: gösterilen uçak z'si (kızak/ofset dahil), alt_rel ölçeğinde
    set onCollision(fn) { onCollision = fn; },
    position: () => ({ x: cur.pos.x, y: cur.pos.y, z: cur.pos.z }),
    cameraPose: () => { camera.updateMatrixWorld(); const e = camera.matrixWorld.elements; return { x: e[12], y: e[13], z: e[14], fx: -e[8], fy: -e[9], fz: -e[10], ux: e[4], uy: e[5], uz: e[6] }; },   // §16 uzaysal ses: dinleyici konumu + ileri/üst (ENU)
    getPose: () => { tmpE.setFromQuaternion(cur.q, 'ZXY'); return { roll: tmpE.y, pitch: tmpE.x, yaw: -tmpE.z }; },   // render edilen (enterpolasyonlu) yönelim, rad (FPV HUD)
    canvas,
    addFrameHook: fn => { frameHooks.add(fn); return () => frameHooks.delete(fn); },   // §17: render sonrası kanca (kayıt birleşimi)
  };
}
