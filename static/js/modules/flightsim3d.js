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
//   geçişi) · Gimbal kamerası ('fpv': burun, gimbal ↑↓, yakınlaştırma +/− 1–8×, FOV 78, askeri HUD) · Serbest (WASD/QE + fare sürükle) · Yer.
//   Kamera türü (§22.3; gündüz/termal/gece görüşü) araç kameralarına CAM_FRAG ile; kamera PiP'i (§22.4) aynı WebGL bağlamında render hedefi + viewport
//   kopyası (setPipRect / swapPip / getPipSource). Gölgelendirici ve saf kurallar ./flightsim_camera.js'te.
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
import { aimAt, aimVector, isIceptLauncher, launcherInventory, SCOPE_FOV, SCOPE_ZOOMS, scopeFov } from './flightsim_launcher.js';   // §27 INTERCEPTOR fırlatıcıları (saf)
import { createIceptRig } from './flightsim_launcher3d.js';   // §27 kutu / tüp / el fırlatıcısı + pilot (prosedürel)
import { CTRL_RE, CTRL_MAX, controlInputs, surfaceTarget, easeSurface, layoutForModel } from './flightsim_airframe.js';   // §13.1 kontrol düzeni: servo → mantıksal eksen → yüzey açıları (ruddervator dahil)
import { createTimeline } from './flightsim_interp.js';   // telemetri zaman çizgisi: uyarlanır gecikme tamponlu enterpolasyon (§5)
import { createMissionLayer } from './flightsim_mission.js';   // §18: görev çizimi (tüp bacaklar, WP etiketleri, ikonlar) + iniş dairesi H
import { targetState, targetsRelative, drawRadar, drawLabel, RADIUS_DEFAULT as TARGET_RADIUS } from './flightsim_targets.js';   // §24 hedefler (kinematik, radar, etiket)
import { boxCorners, selectTarget, lockedIndex, symbology, drawSymbology } from './flightsim_tgthud.js';   // §24.5 HUD hedef sembolojisi (prizma köşeleri, kilit)
import { EO_FOV_MAX, EO_FOV_MIN, STATION_Z, SWEEP_S, TOWER_EO_Z, TOWER_RADAR_Z, autoRadarRange, bearingFrom, eoAimMode, eoDragLook, eoLook, eoPinchFov, eoStatus, eoWheelFov, eoZoom, underlayPlan, underlayUV, fallState, radarCovers, siteLayout, sweepAngle, sweepGlow, threatGeometry, threatPhase, threatState } from './flightsim_gcs.js';   // §26 yer kontrol sahası + görev (saf)
import { EO_POST, buildRackPad, buildRadarPrism, buildRangeRings, buildStation, buildSweep, buildTower } from './flightsim_gcs3d.js';   // §26 prosedürel modeller + radar katmanı
import { attitudeQuat } from './flightsim_interp.js';
import { createCrashFx } from './flightsim_crashfx.js';
import { contactWorld, createSuspension, roverContacts, roverGroundFit, roverKinematics } from './flightsim_rover.js';   // §31 kara aracı (saf): teker kinematiği, zemine oturma
import { buildRoverProc, createDust, roverRig } from './flightsim_rover3d.js';   // §31 teker/direksiyon düğümleri, prosedürel yedek, toz izi   // §18.6 çarpışma efekti: patlama/toz/kıvılcım, sarsıntı, flaş (termalde sıcak enkaz)
import { introEase, introPose } from './flightsim_intro.js';   // §27.2 giriş sekansı: 100 m'den sinematik iniş (saf poz eğrisi)
import { fogRange, gustSpeed, normRampAim, normWeather, precipParams, rampHeading, sockState, sunPosition, weatherPreset, windVector } from './flightsim_weather.js';   // §31 hava/rüzgâr/rampa (saf)
import { createWorldFx } from './flightsim_worldfx.js';   // §31 gerçekçi dünya: gökyüzü, bulut, zemin/su malzemesi, ağaç/bina, yağış, tulum, akış çizgileri
import { GFX_LEGACY, frameGate, pixelRatioFor, recordFloor, resolveGfx } from './flightsim_gfx.js';   // §43 grafik kalitesi (saf: ön ayar → parametre, piksel oranı, kare sınırı)
import { createGfxPipeline } from './flightsim_gfx3d.js';   // §43 son işlem hattı (MSAA hedefi, SSAO, bloom, ACES, FXAA) — aynı renderer
import { CAM_FRAG, CAM_VERT, GIMBAL_ZOOM, PIP_RES_SCALE, camFxApplies, camTypeIndex, camUniforms, clampZoom, gimbalZoomFov, nightGain, thermalGain, normCamType, normPalette, paletteIndex, pipInterval, pipSourceFor, pipSwapTarget, isNoCam } from './flightsim_camera.js';   // §22.3–22.5 kamera türü + PiP

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
async function loadMosaic(meta, toLL, prog, quiet = false, maxAtlas = MAX_ATLAS) {
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
  const scale = Math.min(1, maxAtlas / Math.max(inx, iny) / TILE_PX);   // §43 doku çözünürlüğü: atlas kenarı 2048 / 4096 / 8192
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
export async function loadRealTerrain(T, origin, size, toLocal, onProgress, withFar = false, maxAtlas = MAX_ATLAS) {
  const prog = (stage, done, total) => onProgress?.({ stage, done, total });
  prog('plan', 0, 1);
  const meta = await getJSON(`${TERRAIN_API}/terrain?lat=${origin.lat}&lon=${origin.lon}&size_m=${Math.round(size)}`);
  const cosLat = Math.cos(origin.lat * Math.PI / 180);
  const toLL = (x, y) => [origin.lat + y / 110574, origin.lon + x / (111320 * cosLat)];
  const main = await loadMosaic(meta, toLL, prog, false, maxAtlas);
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
      const f = await loadMosaic(fm, toLL, () => {}, true, Math.min(maxAtlas, MAX_ATLAS));
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
export const PIP_SIZE = { w: 240, h: 135, margin: 12 };               // PiP varsayılan dikdörtgeni (setPipRect çağrılmadıysa sağ üst; CSS px) — §22.4
export const GIMBAL_FOV = 78;                                         // gimbal kamerası temel görüş açısı (yakınlaştırma 1×)
// Kamera döngüsü (C tuşu): mevcut kipten sonraki; bilinmeyen → ilk
export const nextCameraMode = cur => { const i = CAMERA_MODES.findIndex(([k]) => k === cur); return CAMERA_MODES[(i + 1) % CAMERA_MODES.length][0]; };
export const WORLD_DEFAULTS = {
  mode: 'procedural', seed: 12345, size_m: 4000, tree_density: 0.3, mountain_height: 300, mountain_count: 4, building_count: 40,
  runway: true, runway_heading: 0, water: 0.1, time: 'day', wind_ms: 3, wind_dir: 270, fog: 0.2, landing_circle_m: 30,   // landing_circle_m: görev bitiş noktasındaki iniş dairesi çapı (§18)
  weather: 'clear', wind_gust: 0, wind_turb: 0,   // §31 hava durumu (görsel) + esinti/türbülans (SITL fiziği)
};
const FLAT_R = 300, FLAT_R2 = 600;        // merkez çevresi düzleştirme (pist / kalkış alanı)
const RUNWAY_L = 1200, RUNWAY_W = 40;     // pist boyutları (m)
const GRID = 256;                         // arazi ızgarası
const MAX_TREES = 20000;
const MODEL_SCALE = 2.5;                  // dron modelleri (görünürlük için büyütülür; kamera mesafeleri yarıçapa bağlı)
const ROVER_SCALE = 1.0;                  // §31 kara aracı GERÇEK boyutta (yerde bina/ağaç/Google 3B araçlarıyla aynı ölçek; havada görünürlük sorunu yok)
const ROVER_SAMPLE_MS = 60;               // §31 temas noktası yüzey örneklemesi (≈ 16 Hz; arası süspansiyon yayı doldurur)
const ROVER_COCKPIT_FOV = 80;             // §31 kokpit (pilot) kamerası görüş açısı (FPV balıkgözü yok)
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
  // §31: 6 oktav fbm (alan bükmeli: kıvrımlı vadiler) + çok-fraktal sırt gürültüsü (keskin tepe hatları, erozyon benzeri dereler) dağlık bölgede
  const fbm = (x, y) => { let s = 0, a = 1, fr = f, t = 0; for (let o = 0; o < 6; o++) { s += a * noise(x * fr + o * 31.7, y * fr - o * 17.3); t += a; a *= 0.5; fr *= 2.03; } return s / t; };
  const ridge = (x, y) => { let s = 0, a = 0.5, fr = f * 1.6, w = 1; for (let o = 0; o < 5; o++) { let n = 1 - Math.abs(noise(x * fr - 13.1 * o, y * fr + 7.7 * o)); n *= n * w; w = clamp(n * 1.8, 0, 1); s += n * a; a *= 0.5; fr *= 2.1; } return s; };
  const raw = (x, y) => {
    const wx = x + 0.22 / f * noise(x * f * 0.7 + 3.3, y * f * 0.7 - 1.1), wy = y + 0.22 / f * noise(x * f * 0.7 - 7.9, y * f * 0.7 + 5.2);   // alan bükme
    const n = clamp((fbm(wx, wy) + 1) / 2, 0, 1), m = smooth(0.45, 0.72, n);
    return H * (0.78 * Math.pow(n, 1.75) + 0.42 * m * ridge(wx, wy) * n) - H * 0.12;
  };
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
  const preview = !!opts.preview || !!opts.studio;   // §24.4 stüdyo kipi (yalnız model görüntüleyici) önizleme gibi: klavye/gölge yok
  let onCollision = opts.onCollision || null;
  const origin = { lat: num(opts.origin?.lat, 0), lon: num(opts.origin?.lon, 0) };
  const toLocal = (lat, lon) => ({ x: (lon - origin.lon) * 111320 * Math.cos(origin.lat * DEG), y: (lat - origin.lat) * 110574 });

  // ---------- çizici / sahne / kamera ----------
  // §43 grafik kalitesi: opts.gfx (resolveGfx çıktısı; yoksa §43 öncesi sabit davranış GFX_LEGACY). Tuval antialias'ı yalnız açılışta seçilebilir (bağlam
  // özelliği): ön ayar MSAA ≤ 4× ve son işlem/FXAA yoksa yerel MSAA; değilse kenar yumuşatma son işlem hattının çok örnekli hedefinde (flightsim_gfx3d.js).
  let gfx = { ...(opts.gfx || GFX_LEGACY) };
  const nativeAA = !preview && gfx.samples > 0 && gfx.samples <= 4 && !gfx.post && !gfx.fxaa;
  const renderer = new T.WebGLRenderer({ antialias: nativeAA, alpha: false, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(devicePixelRatio || 1, preview ? 1 : 2));
  renderer.outputColorSpace = T.SRGBColorSpace;
  renderer.info.autoReset = false;   // §43: kare başında sıfırlanır → çizim çağrısı/üçgen TÜM karenin (PiP/radar/son işlem dahil) toplamı
  renderer.shadowMap.enabled = !preview && gfx.shadow > 0;   // dron gölge düşürür (castShadow); arazi/pist alır; §43 bina/ağaç/arazi ön ayara göre
  renderer.shadowMap.type = gfx.shadowSoft ? T.PCFSoftShadowMap : T.PCFShadowMap;
  const gpipe = createGfxPipeline(T, renderer, { nativeAA });
  if (!preview) gpipe.set(gfx);
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
  let camDrag = false;   // kullanıcı takip kamerasını sürüklüyor (§31 kovalama dönüşü o sırada uygulanmaz)
  controls.addEventListener('start', () => { camDrag = true; }); controls.addEventListener('end', () => { camDrag = false; });

  // ---------- araç kamerası son işleme (§22, §22.3): FPV balıkgözü (barrel) + vinyet (+ analog) ve kamera türü (termal / gece görüşü) — tek tam ekran geçiş ----------
  // Sahne önce bir render hedefine, sonra CAM_FRAG (flightsim_camera.js) gölgelendiricisiyle ekrana çizilir: 'pilot' kipinde her zaman, gimbal ('fpv')
  // kipinde tür gündüz değilse; dış gözlemci kiplerinde doğrudan render (ek maliyet yok). Örnekleme: uv' = c + d·(1 + k·r²)·s — k > 0 kenarları içe sıkıştırır.
  const post = { rt: null, scene: new T.Scene(), cam: new T.OrthographicCamera(-1, 1, 1, -1, 0, 1), quad: null, mat: null, w: 0, h: 0 };
  const POST_K = 0.12;   // bozulma katsayısı (hafif)
  const camMat = () => new T.ShaderMaterial({ uniforms: camUniforms(new T.Vector2(1 / 1024, 1 / 576)), depthTest: false, depthWrite: false, vertexShader: CAM_VERT, fragmentShader: CAM_FRAG });
  post.mat = camMat();
  post.quad = new T.Mesh(new T.PlaneGeometry(2, 2), post.mat);
  post.quad.frustumCulled = false;
  post.scene.add(post.quad);
  const ensurePostTarget = () => {
    const w = renderer.domElement.width, h = renderer.domElement.height;   // tampon piksel boyutu (pixelRatio dahil)
    if (post.rt && post.w === w && post.h === h && post.rt.samples === (preview ? 0 : gpipe.samples)) return post.rt;
    post.rt?.dispose();
    post.rt = new T.WebGLRenderTarget(w, h, { depthBuffer: true, stencilBuffer: false, samples: preview ? 0 : gpipe.samples });   // MSAA hedef (§43: ön ayarın örnek sayısı)
    post.w = w; post.h = h;
    return post.rt;
  };
  // Kamera türü (§22.3): 'day' | 'thermal' | 'night'; termal paleti; gimbal yakınlaştırması. Türü yalnız araç kameraları (gimbal/FPV) ve PiP'teki araç kamerası kullanır.
  // §35 none: kamera yok — PiP render edilmez, gimbal ('fpv') kipine geçilmez; görüntü türü gündüz
  const camFx = { type: normCamType(opts.camType), none: isNoCam(opts.camType), palette: normPalette(opts.thermalPalette), zoom: clampZoom(opts.gimbalZoom ?? 1) };
  // Kamera PiP'i (§22.4): ayrı küçük kamera; kaynak ana kipe göre (pipSourceFor: ana gimbal değilse gimbal, gimbalse önceki ana kip). Aynı WebGL bağlamı:
  // küçük render hedefine PiP aralığıyla (30 fps; yavaş karede 15) çizilir, her karede CAM_FRAG ile ana görüntünün üstüne viewport/scissor kopyası.
  const pip = { on: false, cam: new T.PerspectiveCamera(50, PIP_SIZE.w / PIP_SIZE.h, 0.5, 60000), rt: null, lastAt: 0, mat: null, quad: null, scene: new T.Scene(), rect: null };
  pip.cam.up.set(0, 0, 1);
  pip.mat = camMat();
  pip.quad = new T.Mesh(new T.PlaneGeometry(2, 2), pip.mat); pip.quad.frustumCulled = false; pip.scene.add(pip.quad);
  const pipRect = () => {   // CSS piksel (bağlama göre); dışarıdan setPipRect ile (sürüklenebilir pencere), yoksa sağ üst varsayılan
    if (pip.rect) return { ...pip.rect };
    const W = Math.max(1, mountEl.clientWidth), m = PIP_SIZE.margin;
    return { x: W - PIP_SIZE.w - m, y: m, w: PIP_SIZE.w, h: PIP_SIZE.h };
  };
  // Termal ısı ipuçları (§22.3): termal geçişte sıcak nesnelerin malzemesi geçici olarak ısı düzeyinde düz renkle (MeshBasic) çizilir — dron gövdesi ılık,
  // motor/pervane bölgesi sıcak, kalkış aracı/rampa ılık, su soğuk; gökyüzü ve sis soğuk (koyu). Işık sprite'ları (seyir halosu) gizlenir. Render sonrası geri alınır.
  const heatMats = new Map();
  // Isı değerleri mutlak; gölgelendirici termal kazancı (thermalGain: gece sahnesi aydınlatmasını normalize eder) uygular → malzeme ısı / kazanç ile çizilir
  const heatMat = v => { const k = Math.round(clamp(v, 0, 1) * 64); if (!heatMats.has(k)) heatMats.set(k, new T.MeshBasicMaterial({ color: new T.Color(k / 64, k / 64, k / 64), fog: true })); return heatMats.get(k); };
  const heatWorld = [];   // dünya içinden etiketli nesneler (su) — buildWorld her kurulumda boşaltır
  const heatRoots = [];   // ek sıcak kökler (§24 hedef grubu): gövde ılık-sıcak, pervane/motor düğümleri (ad /prop|motor|engine/) sıcak
  let heatList = [], heatAt = -Infinity;
  const THERMAL_SKY = new T.Color(0.07, 0.07, 0.075), thermalSky = new T.Color();
  const collectHeat = now => {
    const tg = thermalGain(W.time);
    if (now - heatAt < 1000 && heatList.tg === tg) return heatList;
    heatAt = now;
    const out = [];
    const add = (root, v, propV) => root?.traverse(o => {
      if (o.isSprite) { out.push({ o, sprite: true }); return; }
      if (!o.isMesh) return;
      const pv = drone.props.some(p => p === o || p.children?.includes(o)) ? propV : v;
      out.push({ o, m: heatMat((o.userData.heat ?? pv) / tg) });
    });
    add(drone.group, 0.74, 0.9);
    add(rig?.group, 0.58, 0.58);
    for (const r of heatRoots) r.traverse(o => { if (o.isMesh) out.push({ o, m: heatMat((o.userData.heat ?? (/prop|motor|engine|blade/i.test(o.name + ' ' + (o.parent?.name || '')) ? 0.92 : 0.72)) / tg) }); });
    for (const o of heatWorld) out.push({ o, m: heatMat((o.userData.heat ?? 0.06) / tg) });
    for (const o of wfx.hideInThermal()) out.push({ o, sprite: true });   // §31 gök kubbesi/bulut/yağış/akış çizgileri termalde gizli (gök soğuk)
    out.tg = tg;
    heatList = out;
    return out;
  };
  const withHeat = (on, now, fn) => {
    if (!on) { fn(); return; }
    const list = collectHeat(now), saved = [];
    for (const it of list) { if (it.sprite) { saved.push([it.o, it.o.visible]); it.o.visible = false; } else { saved.push([it.o, it.o.material]); it.o.material = it.m; } }
    const bg = scene.background, fc = scene.fog ? scene.fog.color.clone() : null;
    thermalSky.copy(THERMAL_SKY).multiplyScalar(1 / list.tg);   // gökyüzü soğuk kalsın (kazançla parlamasın)
    scene.background = thermalSky; if (scene.fog) scene.fog.color.copy(thermalSky);
    try { fn(); } finally {
      scene.background = bg; if (fc) scene.fog.color.copy(fc);
      for (const [o, v] of saved) { if (typeof v === 'boolean') o.visible = v; else o.material = v; }
    }
  };
  // Gölgelendirici tekdüzeleri: kaynak kip (balıkgözü yalnız FPV), tür, palet, gece kazancı, düşük çözünürlük (termal), hedef boyutu
  const setCamUniforms = (mat, mode, w, h, small, typeOverride = null) => {   // typeOverride: §26 EO ekranının kendi türü
    const u = mat.uniforms, type = typeOverride || (camFxApplies(mode) ? camFx.type : 'day'), pilot = mode === 'pilot' && drone.type !== 'rover';   // §31 kokpit: balıkgözü/vinyet yok
    u.k.value = pilot ? POST_K : 0; u.scale.value = pilot ? 1 / (1 + POST_K * 0.5) : 1;
    u.vignette.value = pilot ? 0.28 : 0; u.analog.value = pilot && fpv.analog ? 1 : 0;
    u.camType.value = camTypeIndex(type); u.palette.value = paletteIndex(camFx.palette);
    u.time.value = (performance.now() / 1000) % 1000; u.gain.value = type === 'thermal' ? thermalGain(W.time) : nightGain(W.time);
    u.lowres.value = type === 'thermal' ? (small ? 0 : 640) : 0; u.aspect.value = w / Math.max(1, h);
    u.texel.value.set(1 / Math.max(1, w), 1 / Math.max(1, h));
    return type;
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
    // §31: gölge kutusu dronun çevresinde ±90 m (binalar, yakın ağaçlar, tulum, düzenek de düşürür); 2048 doku
    lights.sun.castShadow = gfx.shadow > 0;
    const sc = lights.sun.shadow.camera;
    sc.left = sc.bottom = -gfx.shadowDist; sc.right = sc.top = gfx.shadowDist; sc.near = 20; sc.far = 700;   // §43 gölge mesafesi (Yüksek ±90 m)
    lights.sun.shadow.mapSize.set(gfx.shadow || 2048, gfx.shadow || 2048);
    lights.sun.shadow.bias = -0.0006; lights.sun.shadow.normalBias = 0.6;
  }
  // §31 gerçekçi dünya katmanı (gökyüzü kubbesi, bulut, yağış, akış çizgileri kalıcı; zemin/ağaç/bina dünya grubunda) — aynı renderer
  const wfx = createWorldFx(T, { renderer, scene, preview });
  wfx.setStreaks(opts.windStreaks !== false);
  let treeChunks = [], treeLodAt = 0, sock = null, sockAt = 0;
  // Rüzgâr durumu: taban (dünya) + esinti; telemetrideki anlık değer (tele.wind_spd / wind_dir; sunucu SITL'e yazdığı değer) önceliklidir
  const windSt = { liveMs: null, liveDir: null, liveAt: -Infinity };
  const windNow = now => {
    const live = now - windSt.liveAt < 4000;
    const ms = live && windSt.liveMs != null ? windSt.liveMs : gustSpeed(num(W.wind_ms, 0), num(W.wind_gust, 0), now / 1000);
    const dir = live && windSt.liveDir != null ? windSt.liveDir : num(W.wind_dir, 0);
    const v = windVector(ms, dir);
    return { ms, dir, gust: num(W.wind_gust, 0), turb: num(W.wind_turb, 0), vx: v.x, vy: v.y };
  };

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
  // §31: gökyüzü kubbesi + güneş konumu (saat ön ayarı, flightsim_weather.sunPosition) + hava (bulut/yağış/ışık/görüş). Sis rengi ufuk rengi.
  // Görüş: fogRange(fog, weather) — hava "açık" iken eski formülle aynı; prosedürelde ufuk halkası (`ring` yarıçapı) varsa sis onu aşmaz.
  let skyArgs = null;   // §43: görüş mesafesi canlı değişince son kurulumun argümanlarıyla yeniden
  function skyAndLights(size, horizon = 0, ring = 0) {
    skyArgs = [size, horizon, ring];
    const night = W.time === 'night', dusk = W.time === 'dusk';
    const P = weatherPreset(W.weather);
    const sp = sunPosition(W.time);
    sunDir.set(sp.x, sp.y, Math.max(0.12, sp.z)).normalize();   // gölge yönü (akşam güneşi çok yatık → gölge kutusu dışı; en az ~7°)
    lights.sun.position.copy(sunDir).multiplyScalar(preview ? size : 400);
    const fr = fogRange(W.fog, W.weather, { size, horizon });
    const fk = preview ? 1 : gfx.fog;   // §43 görüş mesafesi çarpanı (Düşük 0,6 … Ultra 1,3); ufuk halkası sınırı aşılmaz
    fr.far *= fk; fr.near *= fk;
    if (ring > 0) { fr.on = true; fr.far = Math.min(fr.far, ring * 0.92); fr.near = Math.min(fr.near, fr.far * 0.3); }
    wfx.setAtmosphere({ time: W.time, weather: normWeather(W.weather), P, sunDir: sp, lights, fogRange: fr });
    wfx.buildPrecip(precipParams(W.weather, { quality: preview ? 1 : gfx.precip, windMs: num(W.wind_ms, 0) }));   // §43 yağış parçacık kalitesi
    return { night, dusk, P };
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

  // §31 Binalar: kasabalar (sokak ızgarası + kaldırım şeritleri araziye serili) — türler: 0 müstakil ev (beşik çatı), 1 apartman (çatı üniteli),
  // 2 kule (cam cephe), 3 sanayi; merkezde yüksek, kenarda alçak. Kalan kota kırsalda ev/ahır. Pistten, sudan, sahadan uzak; AABB'ler çakışmaz.
  // Cephe gölgelendiricisi (flightsim_worldfx patchFacade) pencere ızgarası + gece ışıklı pencereler.
  const PAL = { house: [0xe9dfc8, 0xd9c7a6, 0xf2ece0, 0xcdb48e, 0xe3d2b8, 0xbfb6a8, 0xd6c3b0], apt: [0xc9b79a, 0xd8a98a, 0xb9b3aa, 0xa9b4bd, 0xe0cfae, 0xc4c0b8, 0xb79d84],
    tower: [0x8f9aa6, 0x6f8193, 0xa5adb5, 0x7d8b99], ind: [0x9aa0a6, 0x7e8a96, 0xb2aea4, 0x8c8f84], roof: [0xa4462f, 0x8b3a2a, 0x5b5f66, 0x7a3b2a, 0x4c4f55, 0x9c5a3c] };
  function townBuildings(nb, size, height, waterZ, relH, hdg, rand, night) {
    const blds = [], roads = [];
    const pick = arr => new T.Color(arr[Math.floor(rand() * arr.length)]);
    const free = (x1, x2, y1, y2, m) => !buildingsAABB.some(b => x2 > b.x1 - m && x1 < b.x2 + m && y2 > b.y1 - m && y1 < b.y2 + m);
    const okSpot = (x, y, z) => !(z < waterZ + 2 || (!terrain.real && z > relH * 0.6) || inRunway(x, y, hdg, 120) || inWater(x, y, z) || nearSite(x, y, 40) || Math.hypot(x, y) < 330);
    const place = (x, y, w, d, h, rot, kind) => {
      const c = Math.cos(rot), s = Math.sin(rot);
      let zmin = Infinity, zmax = -Infinity, x1 = Infinity, x2 = -Infinity, y1 = Infinity, y2 = -Infinity;
      for (const [u, v] of [[-w / 2, -d / 2], [w / 2, -d / 2], [w / 2, d / 2], [-w / 2, d / 2]]) {
        const px = x + c * u - s * v, py = y + s * u + c * v, z = height(px, py);
        if (inRunway(px, py, hdg, 100)) return false;
        zmin = Math.min(zmin, z); zmax = Math.max(zmax, z); x1 = Math.min(x1, px); x2 = Math.max(x2, px); y1 = Math.min(y1, py); y2 = Math.max(y2, py);
      }
      if (zmax - zmin > Math.max(3, w * 0.25) || !okSpot(x, y, height(x, y)) || !free(x1, x2, y1, y2, 3)) return false;
      const b = { x, y, z: zmin - 0.4, w, d, h: h + (zmax - zmin) + 0.4, rot, kind, col: pick(kind === 0 ? PAL.house : kind === 1 ? PAL.apt : kind === 2 ? PAL.tower : PAL.ind),
        roof: kind === 0 ? pick(PAL.roof) : null, unit: kind === 1 && rand() < 0.7 };
      blds.push(b);
      buildingsAABB.push({ x1, x2, y1, y2, z2: zmax + h + (kind === 0 ? Math.min(w, d) * 0.42 : b.unit ? 2.4 : 0) });
      return true;
    };
    const nTowns = clamp(Math.ceil(nb / 45), 1, 6), towns = [];
    const rMin = 520, rMax = Math.max(rMin + 60, size * 0.42);
    for (let t = 0; towns.length < nTowns && t < 400; t++) {
      const ang = rand() * Math.PI * 2, r = rMin + rand() * (rMax - rMin), x = Math.cos(ang) * r, y = Math.sin(ang) * r;
      if (!okSpot(x, y, height(x, y)) || towns.some(o => Math.hypot(o.x - x, o.y - y) < 520)) continue;
      let lo = Infinity, hi = -Infinity;
      for (const [dx, dy] of [[-90, -90], [90, -90], [-90, 90], [90, 90], [0, 0]]) { const zz = height(x + dx, y + dy); lo = Math.min(lo, zz); hi = Math.max(hi, zz); }
      if (hi - lo > 25) continue;
      towns.push({ x, y, rot: rand() * Math.PI / 2 });
    }
    const quota = Math.ceil(nb / Math.max(1, towns.length));
    const BLOCK = 66, RW = 8;
    for (const tw of towns) {
      if (blds.length >= nb) break;
      const k = clamp(Math.ceil(Math.sqrt(quota / 5)) + 1, 2, 8), E = k * BLOCK / 2;
      const c = Math.cos(tw.rot), s = Math.sin(tw.rot), W2 = (u, v) => [tw.x + c * u - s * v, tw.y + s * u + c * v];
      const before = blds.length, full = () => blds.length >= nb || blds.length - before >= quota;
      for (let bi = 0; bi < k && !full(); bi++) for (let bj = 0; bj < k && !full(); bj++) {
        const inner = BLOCK - RW - 6, u0 = -E + bi * BLOCK + RW / 2 + 3, v0 = -E + bj * BLOCK + RW / 2 + 3;
        const dc = Math.hypot(-E + (bi + 0.5) * BLOCK, -E + (bj + 0.5) * BLOCK) / E;   // merkezden uzaklık (0…1,4)
        const lots = dc < 0.45 ? 2 : 3, lw = inner / lots;
        for (let li = 0; li < lots && !full(); li++) for (let lj = 0; lj < lots && !full(); lj++) {
          if (rand() < 0.12) continue;   // boş arsa / park
          let kind = dc < 0.4 ? (rand() < 0.3 ? 2 : 1) : dc < 0.8 ? (rand() < 0.55 ? 1 : 0) : (rand() < 0.12 ? 3 : 0);
          let w, d, h;
          if (kind === 0) { w = 8 + rand() * 5; d = 7 + rand() * 4; h = (rand() < 0.6 ? 1 : 2) * 3 + 0.4; }
          else if (kind === 1) { w = 13 + rand() * 8; d = 11 + rand() * 6; h = (3 + Math.floor(rand() * 7)) * 3.1; }
          else if (kind === 2) { w = 17 + rand() * 7; d = 17 + rand() * 7; h = 36 + rand() * 46; }
          else { w = 24 + rand() * 14; d = 18 + rand() * 10; h = 7 + rand() * 5; }
          w = Math.min(w, lw - 3); d = Math.min(d, lw - 3);
          if (w < 6 || d < 6) { kind = 0; w = d = Math.max(6, lw - 3); h = 3.4; }
          const [x, y] = W2(u0 + (li + 0.5) * lw + (rand() - 0.5) * 2, v0 + (lj + 0.5) * lw + (rand() - 0.5) * 2);
          place(x, y, w, d, h, tw.rot + (rand() < 0.5 ? 0 : Math.PI / 2), kind);
        }
      }
      if (blds.length > before) {   // sokaklar: blok ızgarası (suya/piste düşen çizgi atlanır) + kaldırımlar
        for (let i = 0; i <= k; i++) {
          const u = -E + i * BLOCK;
          for (const pts of [[W2(u, -E), W2(u, E)], [W2(-E, u), W2(E, u)]]) {
            const mx = (pts[0][0] + pts[1][0]) / 2, my = (pts[0][1] + pts[1][1]) / 2;
            if (height(mx, my) < waterZ + 1 || inRunway(mx, my, hdg, 40) || inWater(mx, my, height(mx, my))) continue;
            roads.push({ pts, w: RW, walk: true });
          }
        }
      }
    }
    for (let tries = 0; blds.length < nb && tries < nb * 30; tries++) {   // kırsal: müstakil ev / ahır
      const ang = rand() * Math.PI * 2, r = 380 + rand() * Math.max(10, size * 0.45 - 380), kind = rand() < 0.2 ? 3 : 0;
      place(Math.cos(ang) * r, Math.sin(ang) * r, kind ? 18 + rand() * 10 : 8 + rand() * 5, kind ? 12 + rand() * 8 : 7 + rand() * 4, kind ? 6 + rand() * 3 : 3.4 + (rand() < 0.4 ? 3 : 0), rand() * Math.PI, kind);
    }
    wfx.buildBuildings(blds, gWorld, { night });
    if (roads.length) wfx.roadMeshes(roads, gWorld, (x, y) => height(x, y), { night });
    terrain.towns = towns.length; terrain.townsAt = towns.map(t => [Math.round(t.x), Math.round(t.y)]);
    return blds.length;
  }

  // §31 Ağaçlar: `pick()` bir aday (x, y) üretir (ya da null); su/pist/bina/kar üzerinde değil. Tür (iğne/geniş yapraklı) biyom gürültüsü + yükseklikle;
  // parçalı InstancedMesh + LOD (flightsim_worldfx buildTrees); kar havasında taçlar açılır.
  function trees(nt, pick, height, waterZ, relH, hdg, rand, night) {
    const items = [], P = weatherPreset(W.weather), biome = simplex2D(num(W.seed, 12345) ^ 0x51ED);
    const snowTint = new T.Color(2.1, 2.2, 2.35);
    for (let tries = 0; items.length < nt && tries < nt * 4; tries++) {
      const c = pick(); if (!c) continue;
      const [x, y] = c, r = Math.hypot(x, y);
      if (r < (W.runway !== false ? 330 : 60)) continue;
      const z = height(x, y);
      if (z < waterZ + 2 || (!terrain.real && z > relH * 0.72) || (W.runway !== false && inRunway(x, y, hdg, 60)) || inWater(x, y, z)) continue;
      if (buildingsAABB.some(b => x > b.x1 - 3 && x < b.x2 + 3 && y > b.y1 - 3 && y < b.y2 + 3)) continue;
      if (nearSite(x, y, 30)) continue;   // §26 yer kontrol sahası açık alan
      const zr = terrain.real ? 0 : clamp(z / relH, 0, 1);
      const conifer = rand() < clamp(0.35 + biome(x / 900, y / 900) * 0.45 + zr * 0.6, 0.05, 0.95);
      const hh = conifer ? 8 + rand() * 12 : 6 + rand() * 9, rr = conifer ? hh * (0.2 + rand() * 0.06) : hh * (0.32 + rand() * 0.1);
      const cc = conifer ? new T.Color(0.82 + rand() * 0.3, 0.86 + rand() * 0.3, 0.82 + rand() * 0.25) : new T.Color(0.85 + rand() * 0.45, 0.85 + rand() * 0.35, 0.7 + rand() * 0.3);
      if (P.snowCover > 0) cc.lerp(snowTint, 0.42 * P.snowCover);
      items.push({ x, y, z, h: hh, r: rr, sp: conifer ? 0 : 1, c: cc });
    }
    treeChunks = treeChunks.concat(wfx.buildTrees(items, gWorld, { size: terrain.size + 600, night }));
    return items.length;
  }

  // Gerçek kip: su çokgenleri (yerel koordinat, bbox + z); nokta içinde mi
  let waterPolys = [];
  const inWater = (x, y, z) => waterPolys.some(w => x >= w.x1 && x <= w.x2 && y >= w.y1 && y <= w.y2 && z < w.z + 1.5 && pointInPoly(x, y, w.pts));

  // §31 rüzgâr tulumu: pistin yanında (merkezden 60 m ileride, pist kenarından 24 m dışarıda), pist yoksa kalkış noktasının 40 m KD'sunda
  function addWindsock() {
    sock = wfx.createWindsock();
    const hdg = num(W.runway_heading, 0) * DEG, onRw = W.runway !== false && !terrain.google || W.runway === true;
    const lx = onRw ? RUNWAY_W / 2 + 24 : 28, ly = onRw ? 60 : 28;
    sock.pos = { x: Math.cos(-hdg) * lx - Math.sin(-hdg) * ly, y: Math.sin(-hdg) * lx + Math.cos(-hdg) * ly };
    sock.group.position.set(sock.pos.x, sock.pos.y, terrainHeight(sock.pos.x, sock.pos.y) - 0.1);
    gWorld.add(sock.group);
  }

  // ---------- prosedürel dünya ----------
  function buildProcedural(world) {
    terrain = makeTerrain(world);
    W = terrain.W;
    const { size, H, height, waterZ, rand } = terrain;
    const ring = preview ? 0 : size * 4 * Math.min(1, Math.max(0.6, gfx.fog));   // §31 ufuk halkası (§43 görüş mesafesine göre) (yarı genişlik): makeTerrain her (x, y)'de tanımlı → dağlar dünya kenarında bitmez
    const { night, dusk } = skyAndLights(size, preview ? 0 : size * 3, ring);
    const relH = Math.max(H, 1);
    wfx.U.relH.value = relH; wfx.U.waterZ.value = waterZ > -Infinity ? waterZ : -1e6; wfx.U.snowLine.value = H > 150 ? relH * 0.74 : 1e6;
    wfx.setCloudBase(Math.max(1500, H * 1.1 + 700));
    const G = preview ? 160 : gfx.terrainLod.grid;   // §43 arazi ayrıntısı (Yüksek 320)
    const geo = new T.PlaneGeometry(size, size, G - 1, G - 1);
    const pos = geo.attributes.position;
    for (let i = 0; i < pos.count; i++) pos.setZ(i, height(pos.getX(i), pos.getY(i)));
    geo.computeVertexNormals();
    const ground = new T.Mesh(geo, wfx.groundMaterial());
    ground.name = 'arazi';
    ground.receiveShadow = true;
    gWorld.add(ground);
    if (ring) {   // ana karenin içinde 2 m altta saklı (dikişsiz), dışında aynı yükseklik fonksiyonu
      const RG = gfx.terrainLod.ring - 1, rg = new T.PlaneGeometry(ring * 2, ring * 2, RG, RG), rp = rg.attributes.position, half = size / 2;
      for (let i = 0; i < rp.count; i++) { const x = rp.getX(i), y = rp.getY(i); rp.setZ(i, height(x, y) - (Math.abs(x) < half && Math.abs(y) < half ? 2 : 0)); }
      rg.computeVertexNormals();
      const rm = new T.Mesh(rg, wfx.groundMaterial()); rm.name = 'ufuk-arazi';
      gWorld.add(rm);
    }
    if (waterZ > -Infinity) {
      const water = new T.Mesh(new T.PlaneGeometry(ring ? ring * 2 : size * 1.02, ring ? ring * 2 : size * 1.02), wfx.waterMaterial());
      water.position.z = waterZ;
      water.renderOrder = 2;
      water.userData.heat = 0.05; heatWorld.push(water);   // termal: su soğuk (§22.3)
      gWorld.add(water);
    }
    const hdg = num(W.runway_heading, 0);
    if (W.runway !== false) { const rw = runwayMesh(hdg, RUNWAY_L, RUNWAY_W, night, dusk); rw.position.z = 0.05; gWorld.add(rw); }
    const nb = clamp(Math.round(num(W.building_count, 0)), 0, 400);
    if (nb > 0) townBuildings(nb, size, height, waterZ, relH, hdg, rand, night);
    const density = clamp(num(W.tree_density, 0), 0, 1);
    const nt = Math.min(preview ? 3000 : Math.round(MAX_TREES * Math.max(1, gfx.trees)), Math.round(density * MAX_TREES * (preview ? 1 : gfx.trees)));   // §43 bitki yoğunluğu
    if (nt > 0) trees(nt, () => [(rand() - 0.5) * size * 0.98, (rand() - 0.5) * size * 0.98], height, waterZ, relH, hdg, rand, night);
    addWindsock();
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
    wfx.setCloudBase(Math.max(1500, real.hmax - real.hmin + 900));
    const osm = real.osm || { buildings: [], forests: [], water: [], runways: [] };
    const toXY = ll => { const p = toLocal(ll[0], ll[1]); return [p.x, p.y]; };
    const inside = pts => pts.some(([x, y]) => Math.abs(x) <= half && Math.abs(y) <= half);

    // --- arazi: ızgara z = gerçek yükseklik (merkez 0); UV uydu atlasından ---
    const RG = preview ? GRID : gfx.terrainLod.real;   // §43 arazi ayrıntısı (Yüksek 256)
    const geo = new T.PlaneGeometry(size, size, RG - 1, RG - 1);
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
    tex.anisotropy = Math.min(preview ? 8 : gfx.aniso, renderer.capabilities.getMaxAnisotropy?.() || 1);   // §43 doku filtreleme
    tex.generateMipmaps = true; tex.minFilter = T.LinearMipmapLinearFilter;
    // Gece/akşam: doku çarpımsal koyulaştırma (atlas ham kalır, yeniden kullanılır). §31: uydu dokusu üstüne ayrıntı + normal, kar örtüsü, ıslaklık
    const ground = new T.Mesh(geo, wfx.groundMaterial({ satellite: true, map: tex, color: night ? 0x4c5670 : dusk ? 0xe8b898 : 0xffffff }));
    ground.receiveShadow = true;
    ground.name = 'arazi';
    gWorld.add(ground);
    terrain.mesh = ground;   // düzenek yüzeyi için örgüye ışın (ızgara interpolasyonu ile görünen üçgenler arasındaki fark giderilir; §13)

    // --- uzak arazi halkası (§9): ufka dek kaba ızgara (48 km, terrarium z 10 + uydu z 12). Ana kare içinde ana arazinin 2 m altında saklı;
    // kenardan 1,5 km dışarıya dek ana kenar değeriyle karışır (dikişsiz), sonra tamamen uzak veri. Sis ufku far.size/2'ye bağlı (skyAndLights).
    if (far) {
      const FG = gfx.terrainLod.far, BLEND = 1500;   // §43 uzak arazi ızgarası (Yüksek 192)
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
      const fground = new T.Mesh(fgeo, wfx.groundMaterial({ satellite: true, map: ftex, color: night ? 0x4c5670 : dusk ? 0xe8b898 : 0xffffff }));
      fground.name = 'uzak-arazi';
      gWorld.add(fground);
    }

    // --- su çokgenleri (OSM natural=water): düz yüzey, en alçak köşe −0.2 m ---
    waterPolys = [];
    const waterMat = wfx.waterMaterial();   // §31 Fresnel gök yansıması + dalga + güneş parlaması
    for (const poly of osm.water) {
      const pts = poly.map(toXY);
      if (pts.length < 3 || !inside(pts)) continue;
      let zmin = Infinity, x1 = Infinity, x2 = -Infinity, y1 = Infinity, y2 = -Infinity;
      for (const [x, y] of pts) { zmin = Math.min(zmin, height(x, y)); x1 = Math.min(x1, x); x2 = Math.max(x2, x); y1 = Math.min(y1, y); y2 = Math.max(y2, y); }
      const z = zmin - 0.2;
      const shape = new T.Shape(pts.map(([x, y]) => new T.Vector2(x, y)));
      const m = new T.Mesh(new T.ShapeGeometry(shape), waterMat);
      m.position.z = z; m.renderOrder = 2; m.userData.heat = 0.05; heatWorld.push(m);   // termal: su soğuk
      gWorld.add(m);
      waterPolys.push({ pts, z, x1, x2, y1, y2 });
    }

    // --- binalar (OSM): taban çokgen üçgenleme + duvarlar, tek BufferGeometry; AABB çarpışma için ---
    const hdg0 = num(Wn.runway_heading, 0);
    const bpos = [], bnorm = [], bcol = [], bfac = [], bbld = [];   // §31 cephe: aFac (u m, v m, çatı), aBld (tür, tohum)
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
      const zb = zmin - 0.6, bh = clamp(num(b.h, 8), 2, 400), zt = zmax + bh;
      const hue = 0.06 + rand() * 0.07, light = 0.55 + rand() * 0.25;
      roofC.setHSL(hue, 0.06 + rand() * 0.08, light * 0.62); wallC.setHSL(hue, 0.1 + rand() * 0.14, light);
      const kind = bh < 10 ? 0 : bh < 32 ? 1 : 2, seed = rand() * 50;
      // Saat yönü denetimi (shoelace) — duvar normalleri dışa baksın
      let area = 0;
      for (let i = 0; i < pts.length; i++) { const [ax, ay] = pts[i], [bx, by] = pts[(i + 1) % pts.length]; area += ax * by - bx * ay; }
      const ccw = area > 0;
      let tris;
      try { tris = T.ShapeUtils.triangulateShape(pts.map(([x, y]) => new T.Vector2(x, y)), []); } catch { tris = []; }
      for (const [a, b2, c] of tris) {
        const o = ccw ? [a, b2, c] : [a, c, b2];
        for (const k of o) { bpos.push(pts[k][0], pts[k][1], zt); bnorm.push(0, 0, 1); bcol.push(roofC.r, roofC.g, roofC.b); bfac.push(pts[k][0], pts[k][1], 1); bbld.push(kind, seed, bh); }
      }
      let uAcc = 0;
      for (let i = 0; i < pts.length; i++) {
        const [ax, ay] = pts[i], [bx, by] = pts[(i + 1) % pts.length];
        const nx = (by - ay), ny = -(bx - ax), ln = Math.hypot(nx, ny) || 1;
        const s = ccw ? 1 : -1, n = [nx / ln * s, ny / ln * s, 0];
        const ua = uAcc, ub = uAcc + ln; uAcc = ub;
        const quad = ccw ? [[ax, ay, zb, ua], [bx, by, zb, ub], [bx, by, zt, ub], [ax, ay, zb, ua], [bx, by, zt, ub], [ax, ay, zt, ua]]
          : [[ax, ay, zb, ua], [bx, by, zt, ub], [bx, by, zb, ub], [ax, ay, zb, ua], [ax, ay, zt, ua], [bx, by, zt, ub]];
        for (const v of quad) { bpos.push(v[0], v[1], v[2]); bnorm.push(...n); bcol.push(wallC.r, wallC.g, wallC.b); bfac.push(v[3], v[2] - zmax, 0); bbld.push(kind, seed, bh); }
      }
      buildingsAABB.push({ x1, x2, y1, y2, z2: zt });
      nReal++;
    }
    if (bpos.length) {
      const bg = new T.BufferGeometry();
      bg.setAttribute('position', new T.Float32BufferAttribute(bpos, 3));
      bg.setAttribute('normal', new T.Float32BufferAttribute(bnorm, 3));
      bg.setAttribute('color', new T.Float32BufferAttribute(bcol, 3));
      bg.setAttribute('aFac', new T.Float32BufferAttribute(bfac, 3)); bg.setAttribute('aBld', new T.Float32BufferAttribute(bbld, 3));
      const bm = new T.Mesh(bg, wfx.facadeMaterial(false));   // §31 pencere ızgarası + gece ışıklı pencereler (eski çatı noktası ışıkları yerine)
      bm.castShadow = !preview; bm.receiveShadow = true; bm.name = 'osm-binalar';
      gWorld.add(bm);
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
    if (nb > 0) townBuildings(nb, size, height, -Infinity, H, hdg, rand, night);

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
      const want = Math.min(preview ? 3000 : Math.round(MAX_TREES * Math.max(1, gfx.trees)), Math.round(totalArea * 0.004 * (density / 0.3) * (preview ? 1 : gfx.trees)));   // §43 bitki yoğunluğu
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
    addWindsock();
    addHomeMark();
  }

  function addHomeMark() {
    if (opts.homeMark === false) return;   // SIMUMAV hangar/sihirbaz önizlemesi: küçük dron yakın kamerada turuncu ev diski baskın görünmesin
    const rover = (drone?.type || opts.type) === 'rover';   // §31 kara aracı gerçek boyutta: dolu disk yerine ince halka (aracı örtmesin)
    const home = new T.Mesh(rover ? new T.RingGeometry(2.6, 3, 40) : new T.CircleGeometry(3, 24), new T.MeshBasicMaterial({ color: 0xf59e0b }));
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
    g3d.setQuality?.({ errorTarget: gfx.g3dError, cacheMB: gfx.g3dCache });   // §43 karo hata eşiği (havuzdan yeniden kullanılan örnekte de)
    g3d.setTime(Wn.time); g3d.setWeatherLight?.(0.55 + 0.45 * weatherPreset(Wn.weather).light); g3d.setShadows(!preview && !!opts.g3dShadows);   // gölge isteğe bağlı (normal hesaplama + Lambert; varsayılan Basic: doku rengi doğrudan)
    scene.add(g3d.group);
    if (Wn.runway === true) { const rw = runwayMesh(num(Wn.runway_heading, 0), RUNWAY_L, 18, night, dusk); rw.position.z = 0.08; gWorld.add(rw); }
    wfx.setCloudBase(1800);
    addWindsock();
    addHomeMark();
  }

  // Dünya kurucu: prosedürel anında; gerçek kip veri yükler (ilerleme), alınamazsa prosedürele düşer (onFallback). Son çağrı kazanır.
  let buildSeq = 0, realCache = null;
  const onProgress = opts.onProgress || null, onFallback = opts.onFallback || null;
  async function buildWorld(world, quiet = false) {   // quiet: §43 grafik ayarıyla yeniden kurulum (ilerleme/olay iletisi yok)
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
          const g = await G.createGoogleTiles({ T, renderer, camera, origin: { ...origin, alt: opts.origin?.alt }, preview, key: opts.g3dKey, time: Wn.time, errorTarget: gfx.g3dError, cacheMB: gfx.g3dCache, onProgress: p => { if (g3d === g) onProgress?.(p); } });
          if (seq !== buildSeq) { g.dispose(); return; }
          g.key = key; g3d = g;
        }
      } catch (err) {
        if (seq !== buildSeq) return;
        // opts.g3dFallback: 'real' → Gerçek araziye (yükseklik + uydu; o da alınamazsa prosedürel) — SIMUMAV; varsayılan prosedürel (HEPGO)
        const to = opts.g3dFallback === 'real' ? 'real' : 'procedural';
        onFallback?.(err?.message || String(err), { from: 'google3d', to });
        Wn.mode = to;
      }
    }
    if (Wn.mode !== 'google3d' && g3d) { g3d.dispose(); g3d = null; }
    if (Wn.mode === 'real') {
      const size = clamp(num(Wn.size_m, 4000), 1000, 20000);
      const key = `${origin.lat.toFixed(5)},${origin.lon.toFixed(5)},${size},${preview ? MAX_ATLAS : gfx.atlasMax}`;   // §43 doku çözünürlüğü değişince atlas yeniden
      try {
        if (!realCache || realCache.key !== key) {
          const r = await loadRealTerrain(T, origin, size, toLocal, p => { if (seq === buildSeq && !quiet) onProgress?.(p); }, !preview, preview ? MAX_ATLAS : gfx.atlasMax);   // oturumda uzak arazi halkası da (önizleme kamerası ufku görmez)
          if (seq !== buildSeq) return;
          realCache = { key, data: r };
        }
        real = realCache.data;
      } catch (err) {
        if (seq !== buildSeq) return;
        realCache = null;
        onFallback?.(err?.message || String(err), { from: 'real', to: 'procedural' });
        Wn.mode = 'procedural';
      }
    }
    disposeGroup(gWorld);
    buildingsAABB = []; waterPolys = []; heatWorld.length = 0; treeChunks = []; sock = null;
    if (g3d) buildGoogle(Wn); else if (real) buildReal(Wn, real); else buildProcedural(Wn);
    applyCast(); heatAt = -Infinity;   // §43 bina/ağaç/arazi gölge düşürme ön ayara göre; termal ısı listesi yeni nesnelerle
    if (!quiet) onProgress?.({ stage: 'done', real: !!real, google: !!g3d, counts: terrain.counts || null, homeElev: terrain.homeElev ?? null, hmin: terrain.hmin ?? null, hmax: terrain.hmax ?? null });
  }

  // ---------- dron modelleri ----------
  // Gövde çerçevesi: burun +Y, sağ kanat +X, üst +Z; birimler metre (gerçek boyut), görünürlük için ×MODEL_SCALE.
  // Sabit kanat / VTOL gövdesi (airframe): 'caymaz' → static/models/caymaz-sim.glb (CAYMAZ V3 STEP'inden; glTF: Y yukarı, burun +Z,
  // sol kanat +X → Rx+90°, Rz180°), 'delta' → prosedürel delta uçan kanat. Pervane düğümleri `props` (yerel Z etrafında döner,
  // userData.dir ±1; userData.disc/blades: yüksek devirde palalar gizlenir, saydam disk belirir). Kontrol yüzeyleri `ctrl`.
  let drone = { group: new T.Group(), props: [], ctrl: [], lights: [], radius: 3, nose: 2, type: null, airframe: null, scale: MODEL_SCALE, rover: null };
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
  const SM_ORIENT = { forward: '+x', up: '+y', scale: 1, offset: [0, 0, 0] };   // SIMUMAV GLB çerçevesi (burun +X, yukarı +Y)
  const BUILTIN_GLB = { talon: { glb_url: '/static/models/talon-vtail.glb', orient: SM_ORIENT, has_prop: true, layout: 'vtail' },
    // §25 INTERCEPTOR kataloğu (static/simumav/models; HEPGO da aynı yoldan): 4 pervaneli tailsitter gövdeleri
    icept_x4: { glb_url: '/static/simumav/models/icept_x4.glb', orient: SM_ORIENT, has_prop: true },
    p1sun: { glb_url: '/static/simumav/models/p1sun.glb', orient: SM_ORIENT, has_prop: true },
    sting: { glb_url: '/static/simumav/models/sting.glb', orient: SM_ORIENT, has_prop: true },
    // §31 kara aracı kataloğu (tools/rover_models_build.py): teker/direksiyon düğümleri flightsim_rover3d.roverRig ile bulunur
    rover_4x4: { glb_url: '/static/simumav/models/rover_4x4.glb', orient: SM_ORIENT, has_prop: false, drive: 'ackermann' },
    rover_ugv: { glb_url: '/static/simumav/models/rover_ugv.glb', orient: SM_ORIENT, has_prop: false, drive: 'skid' },
    rover_bot: { glb_url: '/static/simumav/models/rover_bot.glb', orient: SM_ORIENT, has_prop: false, drive: 'skid' } };
  // §25 INTERCEPTOR prosedürel yedek (GLB yüklenemezse): puro gövde + burun konisi, X kanat, 4 gondol + turuncu motor + çekici pervane (burun yönünde)
  const buildIcept = M => {
    const grp = new T.Group(), props = [];
    const L = 1.0, r = 0.06;
    grp.add(mesh(new T.CylinderGeometry(r, r * 0.8, L * 0.8, 18), M.carbon, 0, -0.05, 0));
    const nose = mesh(new T.ConeGeometry(r, L * 0.22, 18), M.carbon, 0, L * 0.46, 0); grp.add(nose);
    for (let k = 0; k < 4; k++) {
      const a = Math.PI / 4 + k * Math.PI / 2, c = Math.cos(a), sn = Math.sin(a), span = 0.36;
      const wing = mesh(new T.BoxGeometry(span, 0.16, 0.012), M.carbon, c * (r + span / 2), -0.12, sn * (r + span / 2));
      wing.rotation.y = -a; grp.add(wing);
      const tx = c * (r + span), tz = sn * (r + span);
      grp.add(mesh(new T.CylinderGeometry(0.028, 0.024, 0.24, 12), M.carbon, tx, -0.05, tz));            // gondol (Y boyunca)
      grp.add(mesh(new T.CylinderGeometry(0.03, 0.03, 0.05, 12), M.orange, tx, 0.09, tz));               // motor
      const pr = propeller(0.11, k % 2 ? 1 : -1, M, 2); pr.rotation.x = -Math.PI / 2; pr.position.set(tx, 0.125, tz); grp.add(pr); props.push(pr);
    }
    return { grp, props, ctrl: [], tips: { left: [-0.32, -0.1, 0.2], right: [0.32, -0.1, 0.2], tail: [0, -0.46, 0] } };
  };
  // Model seçimi (§12): dize ('caymaz' | 'delta' eski; 'builtin:<ad>') ya da kütüphane nesnesi {id, glb_url, orient, …}
  const SIZES = { multirotor: 0.6, hexarotor: 0.9 };
  const normModel = (type, model) => {
    if (!model) return { id: { multirotor: 'builtin:quad', hexarotor: 'builtin:hexa', helikopter: 'builtin:heli', interceptor: 'builtin:icept_x4', rover: 'builtin:rover_4x4' }[type] || 'builtin:caymaz' };
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
    if (!built && type === 'interceptor') built = buildIcept(M);   // §25 GLB yüklenemedi → prosedürel tailsitter
    if (type === 'rover') {   // §31: GLB yüklenemedi → prosedürel yedek; teker/direksiyon düğümleri + kokpit/sensör noktaları; seyir ışığı yok
      if (!built) built = buildRoverProc(T, M, mesh, key);
      built.tips = {};
      built.rover = roverRig(T, built);
      return built;
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
    const S = type === 'rover' ? ROVER_SCALE : MODEL_SCALE;   // §31 kara aracı gerçek boyutta
    drone.scale = S;
    drone.radius = Math.max(bb.max.x - bb.min.x, bb.max.y - bb.min.y, 1) / 2 * S;
    drone.nose = (bb.max.y + 0.15) * S;
    // park yüksekliği (iniş takımı / sınır kutusu altı yere değer; §25 tailsitter kuyruk üstünde: gövde −Y ucu; §31 teker altı)
    drone.ground = (type === 'interceptor' ? -bb.min.y : type === 'rover' && built.rover?.bottom != null ? -built.rover.bottom : -bb.min.z) * S;
    built.grp.scale.setScalar(S);   // 4 km'lik dünyada görünürlük: gerçek boyutun 2.5 katı (kara aracı 1×)
    drone.rover = built.rover || null;   // §31 teker/direksiyon düzeneği
    rov.susp = createSuspension(); rov.at = 0; rov.hs = null; rov.fit = null; rov.yawPrev = null;
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
  let launcherInv = null;   // §27 hücre envanteri {total, used, launchers} (oturum/görev; yoksa launch.loaded)
  let previewFocus = null;  // sihirbaz önizlemesi: 'rig' → kamera düzeneğin çevresinde (Kalkış adımı)
  function buildRig() {
    rig?.dispose(); rig = null;
    const m = launchCfg?.method;
    if (launchCfg && drone.type === 'interceptor' && isIceptLauncher(m)) {   // §27 kutu / tüp / el fırlatıcısı
      const sz = drone.bbox?.size || [0.45, 0.45, 0.2];   // dronun gerçek boyutu (gövde çerçevesi: x açıklık, y burun–kuyruk, z yükseklik)
      rig = createIceptRig(T, { ...launchCfg, heading: num(W.runway_heading, 0), scale: MODEL_SCALE, night: W.time === 'night', dusk: W.time === 'dusk', inventory: launcherInv || launcherInventory(launchCfg),
        fit: { span: Math.max(sz[0], sz[2]), length: sz[1] } });
      scene.add(rig.group);
      sc.lastAt = 0;
      return;
    }
    if (!launchCfg || (m !== 'ramp' && m !== 'vehicle') || drone.type !== 'sabit_kanat') return;
    rig = createLaunchRig(T, { ...launchCfg, heading: rampHeading(m === 'ramp' ? launchCfg : null, num(W.runway_heading, 0)), scale: MODEL_SCALE, night: W.time === 'night', dusk: W.time === 'dusk' });   // §31 rampa azimutu (yoksa pist yönü)
    scene.add(rig.group);
  }
  // §31 rampa yön/açı önizlemesi (ARM öncesi; sunucuya `launch_aim` ayrıca gider): düzenek yeniden kurulur (eğim silindiri geometrisi açıya bağlı)
  function setRampAim(aim) {
    if (!launchCfg || launchCfg.method !== 'ramp') return null;
    const a = normRampAim({ ...launchCfg, ...aim }, rampHeading(launchCfg, num(W.runway_heading, 0)));
    if (a.azimuth_deg === Math.round(rampHeading(launchCfg, num(W.runway_heading, 0))) % 360 && a.angle_deg === num(launchCfg.angle_deg, 15) && rig) return a;
    launchCfg = { ...launchCfg, ...a };
    buildRig();
    return a;
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
    tele.terrainAgl = typeof t.terrain_agl === 'number' ? t.terrain_agl : null;
    if (typeof t.wind_spd === 'number') { windSt.liveMs = t.wind_spd; windSt.liveDir = typeof t.wind_dir === 'number' ? t.wind_dir : null; windSt.liveAt = now; }   // §31 anlık rüzgâr (esintili)   // ArduPilot TERRAIN_REPORT AGL (SRTM): 3B arazi örneğiyle tutarlılık süzgeci (§18)
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
  // §27.2 giriş sekansı (flightsim_intro.js createIntro → playIntro): kamera kipi DEĞİŞMEZ; her karede normal kip hesaplanır, sonra poz introPose ile
  // ezilir (hedef = dronun çizilen konumu) ve render SONRASI geri yüklenir (takip yörünge ofseti / serbest konum bozulmaz). dur sonrası blend süresince
  // son giriş pozundan normal poza konum lerp + yönelim slerp + FOV geçişi. endIntro(s): kalan inişi kısaltıp s sn'de normale geçer (atla).
  const intro = { on: false, t0: 0, dur: 0, blend: 0, opt: null, save: { p: null, q: null, fov: 60 }, pos: null, q: null };
  function playIntro(o = {}) {
    intro.on = true; intro.t0 = performance.now(); intro.dur = Math.max(0.2, num(o.dur, 3.7)) * 1000; intro.blend = Math.max(0.1, num(o.blend, 1.4)) * 1000;
    intro.opt = { h0: num(o.height, 100), r0: num(o.radius, 80), turnDeg: num(o.turnDeg, 110) };
    intro.save.p = intro.save.p || new T.Vector3(); intro.save.q = intro.save.q || new T.Quaternion(); intro.pos = intro.pos || new T.Vector3(); intro.q = intro.q || new T.Quaternion();
    intro.hasPose = false;
  }
  function endIntro(blendS = 0.6) {
    if (!intro.on) return;
    const el = performance.now() - intro.t0;
    if (el < intro.dur && intro.hasPose) { intro.dur = el; intro.blend = Math.max(0.1, num(blendS, 0.6)) * 1000; }
    else if (!intro.hasPose) intro.on = false;
  }
  const introV = new T.Vector3(), introT = new T.Vector3();
  function applyIntro(now) {
    if (!intro.on || preview) return null;
    const hold = globalThis.__fsIntroHold;   // teşhis: sabit sekans zamanı (flightsim_intro.js)
    const el = hold != null ? Number(hold) * 1000 : now - intro.t0;
    if (el >= intro.dur + intro.blend) { intro.on = false; return null; }
    intro.save.p.copy(camera.position); intro.save.q.copy(camera.quaternion); intro.save.fov = camera.fov;
    introT.copy(drone.group.position); introT.z += Math.max(0.3, (drone.radius || 1) * 0.3);
    if (el < intro.dur) {
      const end = camMode === 'follow' ? introV.copy(camera.position).sub(introT) : introV.copy(followOff).multiplyScalar(Math.max(2, drone.radius || 1));
      const o = introPose(el / intro.dur, { ...intro.opt, end: { x: end.x, y: end.y, z: end.z } });
      const x = introT.x + o.x, y = introT.y + o.y;
      camera.position.set(x, y, Math.max(introT.z + o.z, terrainHeight(x, y) + 2));
      camera.lookAt(introT);
      if (camera.fov !== 60) { camera.fov = 60; camera.updateProjectionMatrix(); }
      intro.pos.copy(camera.position); intro.q.copy(camera.quaternion); intro.hasPose = true;
      return 'fly';
    }
    if (!intro.hasPose) { intro.on = false; return null; }
    const k = introEase((el - intro.dur) / intro.blend);
    camera.position.lerpVectors(intro.pos, intro.save.p, k);
    camera.quaternion.slerpQuaternions(intro.q, intro.save.q, k);
    const f = 60 + (intro.save.fov - 60) * k;
    if (Math.abs(camera.fov - f) > 1e-3) { camera.fov = f; camera.updateProjectionMatrix(); }
    return 'blend';
  }
  function restoreIntro() {
    camera.position.copy(intro.save.p); camera.quaternion.copy(intro.save.q);
    if (camera.fov !== intro.save.fov) { camera.fov = intro.save.fov; camera.updateProjectionMatrix(); }
  }

  // ---------- §31 kara aracı: zemine oturma + teker/direksiyon + toz ----------
  // SITL'in yatay konumu ve yönü kullanılır; YÜKSEKLİK ve EĞİM 3B zeminden: 4 temas noktası (dingil × iz; gövde çerçevesinde, model teker merkezine göre)
  // ROVER_SAMPLE_MS'de bir örneklenir — Google 3B: g3d.surfaceAt (yalnız karo; ışın aracın 4 m üstünden: ağaç tacı / köprü sayılmaz; kaba karo → önceki
  // değer korunur), gerçek arazi: arazi örgüsüne ışın, prosedürel: analitik yükseklik. Köşe yükseklikleri süspansiyon yayından geçer (createSuspension),
  // düzlem oturması (roverGroundFit) gövdenin z'si + eğim + yatışını verir; köşe sıkışması teker düğümlerine görsel ofset olarak uygulanır.
  const rov = { susp: createSuspension(), at: 0, hs: null, fine: [false, false, false, false], fit: null, kin: null, yaw: 0, yawPrev: null, speed: 0, dust: null, dustOn: opts.roverDust !== false,
    samples: 0, coarse: 0, euler: new T.Euler(0, 0, 0, 'ZXY') };
  const roverRay = new T.Raycaster(); roverRay.firstHitOnly = true; roverRay.far = 50000;
  const roverHits = [];
  const roverSurf = (x, y, top) => {
    if (g3d) {
      const q = g3d.surfaceAt(x, y, RIG_FINE_ERR, top);
      return q ? { z: q.z, fine: !!q.fine } : { z: null, fine: false };
    }
    if (terrain?.mesh) {
      roverHits.length = 0; roverRay.set(tmpV2.set(x, y, 20000), rigDown);
      roverRay.intersectObject(terrain.mesh, false, roverHits);
      if (roverHits.length) return { z: roverHits[0].point.z, fine: true };
    }
    return { z: terrainHeight(x, y), fine: true };
  };
  function updateRover(now, dt) {
    const R = drone.rover;
    if (!R || !tele.has) return;
    const S = drone.scale || 1, px = drone.group.position.x, py = drone.group.position.y;
    tmpV.set(0, 1, 0).applyQuaternion(cur.q);
    const yaw = Math.atan2(tmpV.x, tmpV.y);   // burun azimutu (kuzeyden saat yönü)
    rov.yawPrev = rov.yaw; rov.yaw = yaw;
    const L = R.wheelbase * S, Wd = R.track * S;
    if (!rov.hs || now - rov.at >= ROVER_SAMPLE_MS) {
      rov.at = now;
      const top = rov.fit ? rov.fit.z + 4 + L : null;   // Google: aracın üstündeki yüzeyler (ağaç, köprü) sayılmaz
      const hs = [], fine = [];
      roverContacts(L, Wd).forEach(([bx, by], i) => {
        const [wx, wy] = contactWorld(px, py, bx + R.center[0] * S, by + R.center[1] * S, yaw);
        const q = roverSurf(wx, wy, top);
        rov.samples++;
        if (q.fine && Number.isFinite(q.z)) { hs.push(q.z); fine.push(true); return; }
        rov.coarse++;
        hs.push(rov.hs ? rov.hs[i] : Number.isFinite(q.z) ? q.z : cur.pos.z);   // kaba karo / karo yok: önceki kabul edilen değer (ilk örnekte kaba ya da SITL)
        fine.push(false);
      });
      rov.hs = hs; rov.fine = fine;
    }
    const sm = rov.susp.step(rov.hs, dt);
    const fit = rov.fit = roverGroundFit(sm, L, Wd);
    rov.euler.set(fit.pitch, fit.roll, -yaw, 'ZXY');
    drone.group.quaternion.setFromEuler(rov.euler);
    // gövde orijini temas düzleminin üstünde: teker altı (ground) kadar; model teker merkezi orijinden kaydıysa eğimle düzeltilir
    drone.group.position.set(px, py, fit.z + (drone.ground || 0) / Math.max(0.5, Math.cos(fit.pitch) * Math.cos(fit.roll)) - Math.sin(fit.pitch) * R.center[1] * S + Math.sin(fit.roll) * R.center[0] * S);
    // işaretli hız (burun yönüne izdüşüm) + yön hızı → teker kinematiği
    tmpV.set(0, 1, 0).applyQuaternion(drone.group.quaternion);
    rov.speed = cur.vel.x * tmpV.x + cur.vel.y * tmpV.y;
    const ys = tele.last?.ys;
    const kin = rov.kin = roverKinematics(tele.last || {}, { drive: R.drive, wheelbase: R.wheelbase, track: R.track, speed: rov.speed, yawRate: ys != null ? Number(ys) : 0 });
    R.update(Math.min(0.1, dt), kin, i => rov.susp.comp(i), S);
    // toz izi: arka tekerlerin arkasından, hız > 1,5 m/s (Google 3B'de asfalt varsayımıyla seyrek)
    if (rov.dustOn && !preview && Math.abs(rov.speed) > 1.5) {
      rov.dust ??= createDust(T, scene, { color: W.time === 'night' ? 0x4a4438 : 0xb8a27e });
      const rate = Math.min(70, (Math.abs(rov.speed) - 1.5) * 9) * (g3d ? 0.3 : 1);
      for (const sx of [-1, 1]) {
        const [wx, wy] = contactWorld(px, py, sx * Wd / 2 + R.center[0] * S, -L / 2 + R.center[1] * S - Math.sign(rov.speed || 1) * 0.2, yaw);
        rov.dust.emit(wx, wy, fit.z, -cur.vel.x, -cur.vel.y, rate / 2, dt, Math.max(0.4, Wd / 1.2));
      }
    }
  }
  const roverFocus = () => (drone.type === 'rover' && rov.fit ? drone.group.position : cur.pos);

  // ---------- kameralar ----------
  let camMode = 'follow', gimbal = -10;   // derece; 0 = burun hizası, eksi = aşağı (gimbal kamerası 'fpv')
  let prevMode = 'follow', lastFollowOff = null;   // §22.4: önceki ana kip (PiP kaynağı / çift tık yer değiştirme), takipten çıkarken kullanıcının yörünge ofseti
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
    if (mode === 'fpv' && camFx.none) return;   // §35 kamera yok: gimbal kamerası yok
    const prev = camMode;
    if (prev === 'follow' && mode !== 'follow') lastFollowOff = camera.position.clone().sub(controls.target);   // yer değiştirip dönünce kullanıcının bakış açısı korunur
    if (mode !== prev) prevMode = prev;
    camMode = mode;
    controls.enabled = mode === 'follow';
    camera.fov = mode === 'fpv' ? gimbalZoomFov(GIMBAL_FOV, camFx.zoom) : mode === 'pilot' ? (drone.type === 'rover' ? ROVER_COCKPIT_FOV : fpv.fov) : 60;   // §31 kara aracı: kokpit
    camera.near = mode === 'pilot' ? 0.05 : 0.5;   // FPV: burun/pervane kenarı kesilmesin
    camera.updateProjectionMatrix();
    if (mode === 'follow') {
      resetCamera();
      if (lastFollowOff && prev !== 'follow') { camera.position.copy(cur.pos).add(lastFollowOff); controls.update(); }
    }
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
  // Gimbal yakınlaştırma 1×–8× (§22.4): + / − tuşları, Shift+tekerlek, PiP üstünde tekerlek; FOV = 2·atan(tan(39°)/z)
  const setGimbalZoom = z => {
    camFx.zoom = clampZoom(z);
    if (camMode === 'fpv') { camera.fov = gimbalZoomFov(GIMBAL_FOV, camFx.zoom); camera.updateProjectionMatrix(); }
    opts.onGimbalZoom?.(camFx.zoom);
    return camFx.zoom;
  };
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
    if ((e.key === 'c' || e.key === 'C') && !e.shiftKey) { let m = nextCameraMode(camMode); if (m === 'fpv' && camFx.none) m = nextCameraMode(m); setCamera(m); e.preventDefault(); return; }
    if (e.key === 'Tab' && tg.items.length) { if (tg.eng == null) cycleTarget(e.shiftKey ? -1 : 1); e.preventDefault(); return; }   // §24.5 hedef kilidi (§40 angajmanda sabit)
    if (keyLock && RC_KEYS.has(e.key.toLowerCase())) return;
    if (camMode === 'fpv' && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) { setGimbal(e.key === 'ArrowUp' ? 5 : -5); e.preventDefault(); return; }
    if (camMode === 'fpv' && (e.key === '+' || e.key === '=' || e.key === '-' || e.key === '_')) { setGimbalZoom(camFx.zoom * (e.key === '-' || e.key === '_' ? 1 / GIMBAL_ZOOM.step : GIMBAL_ZOOM.step)); e.preventDefault(); return; }
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
  // §31 rampaya tıklama → yön/açı arayüzü (opts.onRigClick): kısa tık (≤ 6 px, ≤ 450 ms), ışın düzenek grubuna
  const rigTap = { x: 0, y: 0, t: 0 };
  const rayc = new T.Raycaster(), ndc = new T.Vector2();
  const pickRig = (clientX, clientY) => {
    if (!rig || rig.method !== 'ramp') return false;
    const r = canvas.getBoundingClientRect();
    ndc.set((clientX - r.left) / r.width * 2 - 1, -(clientY - r.top) / r.height * 2 + 1);
    rayc.setFromCamera(ndc, camera);
    return rayc.intersectObject(rig.group, true).length > 0 || rayc.intersectObject(drone.group, true).length > 0 && !!rig.carrying;
  };
  const onTapDown = e => { rigTap.x = e.clientX; rigTap.y = e.clientY; rigTap.t = performance.now(); };
  const onTapUp = e => {
    if (!opts.onRigClick || Math.hypot(e.clientX - rigTap.x, e.clientY - rigTap.y) > 6 || performance.now() - rigTap.t > 450) return;
    if (pickRig(e.clientX, e.clientY)) opts.onRigClick({ clientX: e.clientX, clientY: e.clientY, aim: launchCfg ? normRampAim(launchCfg, rampHeading(launchCfg, num(W.runway_heading, 0))) : null });
  };
  const onWheel = e => {
    if (camMode === 'fpv' && e.shiftKey) { setGimbalZoom(camFx.zoom * ((e.deltaY || e.deltaX) > 0 ? 1 / GIMBAL_ZOOM.step : GIMBAL_ZOOM.step)); e.preventDefault(); }   // Shift+tekerlek: yakınlaştırma
    else if (camMode === 'fpv') { setGimbal(e.deltaY > 0 ? -3 : 3); e.preventDefault(); }
    else if (camMode === 'pilot') { setPilotFov(fpv.fov + (e.deltaY > 0 ? PILOT_FOV.step : -PILOT_FOV.step)); e.preventDefault(); }   // FPV: tekerlek = görüş açısı
  };
  if (!preview) {
    window.addEventListener('keydown', onKeyDown); window.addEventListener('keyup', onKeyUp);
    canvas.addEventListener('pointerdown', onPointerDown); canvas.addEventListener('pointermove', onPointerMove);
    canvas.addEventListener('pointerup', onPointerUp); canvas.addEventListener('pointercancel', onPointerUp);
    canvas.addEventListener('wheel', onWheel, { passive: false });
    canvas.addEventListener('pointerdown', onTapDown); canvas.addEventListener('pointerup', onTapUp);
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
    if (drone.type === 'rover') {   // §31 kara aracı zaten yerde: arazi teması çarpışma değil; binaya giriş ya da derin suya (> 0,6 m) dalma çarpışmadır
      const q = drone.group.position, qz = q.z - (drone.ground || 0);
      coll.checks++;
      const b = buildingsAABB.find(b => q.x > b.x1 && q.x < b.x2 && q.y > b.y1 && q.y < b.y2 && qz < b.z2 + 0.3);
      const wz = terrain ? terrain.waterZ : -Infinity;
      const hit = b ? { kind: 'building', z: b.z2 } : (Number.isFinite(wz) && qz < wz - 0.6 ? { kind: 'water', z: wz } : null);
      if (!hit) return reset();
      if (coll.kind !== hit.kind) { coll.kind = hit.kind; coll.below = 0; }
      coll.below += dt;
      if (coll.below < (hit.kind === 'building' ? COLL_HOLD_BUILDING_S : COLL_HOLD_S)) return;
      coll.hitAt = now; reset();
      onCollision?.({ ...hit, x: q.x, y: q.y, alt: qz, dz: hit.z - qz, speed: tele.speed, held: true });
      return;
    }
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
  const clearCollision = () => { coll.hitAt = -Infinity; coll.below = 0; coll.kind = null; coll.lastH = null; crashFx?.clear(); };
  // §18.6 çarpışma efekti (UI çarpışma bandıyla birlikte çağırır): dronun çizilen konumunda, şiddet hızla
  let crashFx = null;
  const shakeSave = { p: new T.Vector3(), q: new T.Quaternion() };
  function playCrashFx(o = {}) {
    if (preview) return null;
    crashFx ??= createCrashFx(T, { scene, mountEl, heatRoots });
    const p = drone.group.position, x = num(o.x, p.x), y = num(o.y, p.y);
    return crashFx.trigger({ x, y, z: num(o.z, p.z), ground: terrainHeight(x, y), speed: num(o.speed, tele.speed || 15), size: Math.max(0.3, num(drone.radius, 1)) * 2 });   // boyut: model çapı
  }

  // ---------- §24 hedefler: dairesel yörüngede sürekli uçan kinematik hedefler (flightsim_targets.js; sunucu eşleniği app/flightsim_targets.py) ----------
  // Zaman: canlıda zaman çizgisinin oynatma başı (kaynak = SITL time_boot_ms → t = play/1000; dron ile aynı gecikme), kayıtta karenin `tt`'si
  // (t0 + kare t). Modeller dron gibi ×MODEL_SCALE; yatış (koordineli dönüş) + yön; pervaneler döner; ad/uzaklık etiketi (ekran boyutlu sprite),
  // yörünge çizgisi (soluk), önlemede genişleyen halka; radar (2B canvas, sol üst; setRadarVisible — §26 radar ekranı açıkken gizli).
  // §24.5 HUD sembolojisi (flightsim_tgthud.js): targetsHud() son render edilen kameranın pozu + hedeflerin yönlendirilmiş sınır kutusu köşeleri (dünya);
  // tg.sel kilit durumu (oto = en yakın; Tab / Shift+Tab döngü). HUD/OSD son 3 sn'de sembolojiyi çizdiyse (tg.hudAt) araç kameralarında sahne etiketleri gizlenir.
  // §26 "Yer kontrolünü koru" tehditleri AYNI listede (`it.dyn`): plan (sunucu, tohumdan) + durum (önleme/sızma zamanları, görev saati tabanı) →
  // stateOf: doğmadı / bitti → null (çizilmez, HUD/radar/kilit listesine girmez); seyir + dalış (flightsim_gcs.threatState); önlenince düşüş (fallState).
  // Modeller yalnız etkinken TEMBEL kurulur (≤ ~10 eşzamanlı; plan 60 tehdide kadar). i = yörünge hedefi sayısı + k (etiket sırası kesintisiz).
  const tg = { cfg: null, items: [], group: new T.Group(), seq: 0, rel: [], lastRel: 0, radar: null, radarOn: !preview, radarHide: false, flash: new Map(), shown: false, sel: { i: null, auto: true }, hudAt: -Infinity, def: null, eng: null };
  scene.add(tg.group);
  heatRoots.push(tg.group);   // termal: hedefler sıcak görünsün (§22.3)
  const targetTime = () => {
    if (preview) return performance.now() / 1000;                     // sihirbaz önizlemesi: yerel saat
    const l = tele.last;
    if (!l) return null;
    if (typeof l.tt === 'number') return l.tt;                       // kayıt (t0 + t) / sahte istemci
    if (l.tbm != null && tl.has) return tl.play / 1000;              // canlı: SITL saati (oynatma başı)
    return null;
  };
  const buildTargetModel = async (it, M) => {
    const key = String(it.model || ''), bk = key.startsWith('builtin:') ? key.slice(8) : null;
    const glb = it.glb_url ? { glb_url: it.glb_url, orient: it.orient || SM_ORIENT, has_prop: it.has_prop !== false } : (bk && BUILTIN_GLB[bk]) || null;
    if (glb && (glb.orient || !bk)) { try { return await buildLibrary({ id: key, ...glb }, M); } catch { /* yedek aşağıda */ } }
    if (bk === 'caymaz') { try { return await buildCaymaz(M); } catch { return buildDelta(M); } }
    if (bk === 'quad') return buildMulti(4, 0.6, M);
    if (bk === 'hexa') return buildMulti(6, 0.9, M);
    if (bk === 'heli') return buildHeli(M);
    if (bk === 'icept_x4' || bk === 'p1sun' || bk === 'sting') return buildIcept(M);
    return buildDelta(M);
  };
  const orbitLine = it => {
    const R = Number(it.diameter_m) / 2, n = 128, pts = [];
    for (let k = 0; k <= n; k++) { const a = k / n * 2 * Math.PI; pts.push(new T.Vector3((Number(it.east_m) || 0) + R * Math.cos(a), (Number(it.north_m) || 0) + R * Math.sin(a), Number(it.alt_m))); }
    const ln = new T.Line(new T.BufferGeometry().setFromPoints(pts), new T.LineDashedMaterial({ color: 0xff5a46, transparent: true, opacity: 0.45, dashSize: 14, gapSize: 10, depthWrite: false }));
    ln.computeLineDistances();
    return ln;
  };
  // Tek hedef girdisinin 3B parçaları: model (×MODEL_SCALE) + ekran boyutlu etiket + önleme halkası + HUD prizma köşeleri
  async function buildEntry(it) {
    const M = MAT();
    let built;
    try { built = await buildTargetModel(it, M); } catch { built = buildDelta(M); }
    built.grp.traverse(o => { if (o.isMesh) o.castShadow = false; });
    const root = new T.Group(), body = new T.Group();
    built.grp.scale.setScalar(MODEL_SCALE); body.add(built.grp); root.add(body);
    const bb = new T.Box3().setFromObject(built.grp);
    const cv = document.createElement('canvas'); cv.width = 256; cv.height = 84;
    const tex = new T.CanvasTexture(cv); tex.colorSpace = T.SRGBColorSpace;
    const spr = new T.Sprite(new T.SpriteMaterial({ map: tex, depthTest: false, depthWrite: false, transparent: true, sizeAttenuation: false, toneMapped: false, fog: false }));
    spr.center.set(0.5, 0); spr.scale.set(0.2, 0.066, 1); spr.renderOrder = 20;   // ekran boyutlu (sizeAttenuation kapalı): uzakta da okunur
    spr.position.set(0, 0, Math.max(bb.max.z, 0.4) + 1.5);
    root.add(spr);
    const flash = new T.Sprite(new T.SpriteMaterial({ map: ringTexture(), color: 0xffd23f, transparent: true, opacity: 0, depthWrite: false, fog: false, toneMapped: false, blending: T.AdditiveBlending }));
    flash.visible = false; flash.renderOrder = 19; root.add(flash);   // önleme: hedefte genişleyen parlak halka (billboard)
    const lc = boxCorners(bb.min.toArray(), bb.max.toArray()).map(c => new T.Vector3(...c));   // gövde çerçevesinde sınır kutusu köşeleri (×MODEL_SCALE; HUD prizması)
    return { root, body, props: built.props || [], spr, cv, tex, flash, lc, size: Math.max(0.5, bb.getSize(new T.Vector3()).length()), key: '' };
  }
  const dropEntry = x => { if (x.root) { disposeGroup(x.root); tg.group.remove(x.root); x.root = null; } if (x.ring) { disposeGroup(x.ring); tg.group.remove(x.ring); x.ring.geometry?.dispose(); x.ring = null; } };
  const orbitCount = () => tg.items.filter(x => !x.it.dyn).length;
  const reindexThreats = () => { const n = orbitCount(); for (const x of tg.items) if (x.it.dyn) x.it.i = n + x.it.k; };
  const ensureCfg = () => { if (!tg.cfg && tg.def) tg.cfg = { items: [], radius_m: tg.def.R }; if (tg.cfg && !tg.cfg.items.length && !tg.def) tg.cfg = null; };
  async function setTargets(cfg) {
    const seq = ++tg.seq;
    tg.items.filter(x => !x.it.dyn).forEach(dropEntry);
    tg.items = tg.items.filter(x => x.it.dyn); tg.rel = []; tg.flash.clear(); tg.sel = { i: null, auto: true };
    tg.cfg = cfg && Array.isArray(cfg.items) && cfg.items.length ? { ...cfg, radius_m: num(cfg.radius_m, TARGET_RADIUS) } : null;
    ensureCfg();
    syncSmallRadar();
    if (!tg.cfg || !cfg?.items?.length) { reindexThreats(); return; }
    const orbit = [];
    for (const it of cfg.items) {
      const e = await buildEntry(it);
      if (seq !== tg.seq || disposed) { disposeGroup(e.root); orbit.forEach(dropEntry); return; }
      const ring = orbitLine(it);
      tg.group.add(e.root, ring);
      orbit.push({ it, ...e, ring, R: tg.cfg.radius_m });
    }
    tg.items = [...orbit, ...tg.items.filter(x => x.it.dyn)];
    reindexThreats();
    ensureSmallRadar();
  }
  // §26 görev tehditleri: def = {config, plan, station, state} (sunucu oturumu ya da kayıt) — mevcut tehdit girdileri bırakılır, yenileri tembel kurulur
  function setDefend(def) {
    tg.items.filter(x => x.it.dyn).forEach(dropEntry);
    tg.items = tg.items.filter(x => !x.it.dyn);
    tg.def = null;
    if (def && Array.isArray(def.plan) && def.plan.length && def.station) {
      const st = { x: num(def.station.x, 0), y: num(def.station.y, 0), z: num(def.station.z, STATION_Z) };
      tg.def = { plan: def.plan, st, G: def.plan.map(th => threatGeometry(th, st)), killed: new Map(), leaked: new Map(), base: 0, R: num(def.config?.radius_m, 30) };
      const n = orbitCount();
      for (const th of def.plan) {
        const mdl = THREAT_MODEL_NAME(th);
        tg.items.push({ it: { dyn: true, k: th.k, i: n + th.k, name: mdl, model: th.model, glb_url: th.glb_url, orient: th.orient, has_prop: th.has_prop !== false, th }, root: null, building: false, R: tg.def.R, key: '' });
      }
      setDefendState(def.state);
    }
    ensureCfg();
    syncSmallRadar();
    if (tg.def) ensureSmallRadar();
  }
  const THREAT_MODEL_NAME = th => th.model_name || String(th.name || '').split(' · ')[0] || th.model;
  function setDefendState(s) {
    if (!tg.def || !s) return;
    tg.def.base = num(s.base, tg.def.base);
    for (const [k, t] of s.killed || []) tg.def.killed.set(Number(k), Number(t));
    for (const [k, t] of s.leaked || []) tg.def.leaked.set(Number(k), Number(t));
  }
  // Girdinin t (hedef saati) anındaki durumu; çizilmeyecekse null. Tehditlerde görev saati = t + taban.
  const stateOf = (x, t) => {
    if (!x.it.dyn) return targetState(x.it, t);
    const d = tg.def; if (!d) return null;
    const k = x.it.k, th = x.it.th, tm = t + d.base, kt = d.killed.get(k), lt = d.leaked.get(k);
    const ph = threatPhase(th, tm, kt, lt, d.G[k]);
    if (ph === 'pending' || ph === 'gone') return null;
    if (ph === 'killed') { const s0 = threatState(th, kt, d.st, d.G[k]); return s0 ? fallState(s0, tm - kt, terrainHeight(s0.x, s0.y)) : null; }
    return threatState(th, tm, d.st, d.G[k]);
  };
  let ringTex = null;
  const ringTexture = () => {
    if (ringTex) return ringTex;
    const cv = document.createElement('canvas'); cv.width = cv.height = 128;
    const g = cv.getContext('2d');
    g.strokeStyle = '#fff'; g.lineWidth = 9; g.beginPath(); g.arc(64, 64, 54, 0, 2 * Math.PI); g.stroke();
    g.globalAlpha = 0.35; g.lineWidth = 3; g.beginPath(); g.arc(64, 64, 40, 0, 2 * Math.PI); g.stroke();
    ringTex = new T.CanvasTexture(cv);
    return ringTex;
  };
  function flashTarget(i) { tg.flash.set(Number(i), performance.now()); }
  const flashThreat = k => { const x = tg.items.find(e => e.it.dyn && e.it.k === Number(k)); if (x) flashTarget(x.it.i); };
  // Küçük hedef radarı (§24; sol üst 150 px): hedef varken ve §26 radar ekranı açık değilken
  const syncSmallRadar = () => { if (tg.radar) tg.radar.style.display = tg.radarOn && !tg.radarHide && tg.cfg ? '' : 'none'; };
  const ensureSmallRadar = () => {
    if (!tg.radar && !preview) {
      tg.radar = document.createElement('canvas');
      tg.radar.className = 'fs-radar';
      tg.radar.width = 280; tg.radar.height = 280;
      tg.radar.style.cssText = 'position:absolute;left:12px;top:118px;width:150px;height:150px;pointer-events:none;z-index:4;border-radius:50%';   // sol üst: sağda harekât paneli / askeri HUD göstergeleri
      mountEl.appendChild(tg.radar);
    }
    syncSmallRadar();
  };
  // Etkin (çizilen) girdiler + durumları: HUD / radar / kilit listesi bunları kullanır
  const activeEntries = t => {
    const out = [];
    for (const x of tg.items) { const st = stateOf(x, t); if (st && x.root) out.push({ x, st }); }
    return out;
  };
  // §24.5 HUD sembolojisi verisi (flightsim_tgthud.symbology girişi). Kamera: SON render edilen ana kamera (matrixWorld); FPV ('pilot') kipinde balıkgözü
  // katsayıları (CAM_FRAG k/scale) da verilir. Hedef yoksa / zaman yoksa null. Her çağrı tg.hudAt'i günceller (sahne etiketleri gizlenir).
  const hudV = new T.Vector3();
  // Etkin hedeflerin sembolojisi için öğeler (uzaklık/ΔH P noktasına göre; §27 nişangâh da kullanır)
  function hudItems(t, P) {
    const now = performance.now();
    return activeEntries(t).filter(({ st }) => st.phase !== 'fall').map(({ x, st }) => {
      const c = [x.root.position.x, x.root.position.y, x.root.position.z];
      x.body.updateWorldMatrix(true, false);
      const corners = x.lc.map(v => hudV.copy(v).applyMatrix4(x.body.matrixWorld).toArray());
      const dist = Math.hypot(c[0] - P.x, c[1] - P.y, c[2] - P.z), f0 = tg.flash.get(x.it.i);
      return { i: x.it.i, name: x.it.name, center: c, corners, vel: [st.vx || 0, st.vy || 0, st.vz || 0], dist, dz: c[2] - P.z, inside: dist <= x.R, flash: f0 != null && now - f0 < 2000 };
    });
  }
  // o.peek (§40 angajman katmanı): sahne etiketlerini gizlemez (tg.hudAt güncellenmez); dönüşte hudFresh = HUD/OSD son 1,5 sn'de sembolojiyi çizdi.
  function targetsHud(o = {}) {
    if (preview || !tg.cfg || !tg.items.length || !tg.group.visible) return null;
    const t = targetTime();
    if (t == null) return null;
    const hudFresh = performance.now() - tg.hudAt < 1500;   // yavaş karede (yazılım WebGL) de kararlı
    if (!o.peek) tg.hudAt = performance.now();
    const view = cameraView();
    const P = cur.pos;
    const items = hudItems(t, P);
    if (!items.length) return null;
    return { view, radius: tg.cfg.radius_m, sel: { ...tg.sel }, eng: tg.eng != null ? { i: tg.eng } : null, hudFresh, camMode,
      player: { pos: [P.x, P.y, P.z], vel: [cur.vel.x, cur.vel.y, cur.vel.z], hdg: num(tele.last?.heading, 0) }, items };
  }
  // Son render edilen ana kameranın izdüşüm pozu (§24.5 tgthud.projectView girişi; §41 it dalaşı HUD'u da kullanır). FPV'de balıkgözü katsayıları.
  function cameraView() {
    camera.updateMatrixWorld();
    const e = camera.matrixWorld.elements, pilot = camMode === 'pilot';
    return { pos: [e[12], e[13], e[14]], right: [e[0], e[1], e[2]], up: [e[4], e[5], e[6]], fwd: [-e[8], -e[9], -e[10]], tanV: Math.tan(camera.fov * DEG / 2), aspect: camera.aspect,
      k: pilot ? POST_K : 0, scale: pilot ? 1 / (1 + POST_K * 0.5) : 1 };
  }
  // §40 angajman: kilitli (angaje) hedef → HUD/OSD TD kutusu çift çerçeve + "KİLİT"; null → yok
  function setEngaged(i) { tg.eng = i == null ? null : Number(i); if (tg.eng != null) tg.sel = { i: tg.eng, auto: false }; return tg.eng; }
  // Tab / Shift+Tab: kilitli hedef döngüsü (oto → en yakının bir sonrakine); 0 → doğrula. Yalnız etkin hedefler.
  const lockList = () => { const t = targetTime(); if (t == null) return []; const P = cur.pos; return activeEntries(t).filter(({ st }) => st.phase !== 'fall').map(({ x }) => ({ i: x.it.i, dist: x.root.position.distanceTo(P) })); };
  function cycleTarget(step = 1) {
    if (!tg.cfg) return null;
    const list = lockList();
    tg.sel = selectTarget(list, tg.sel, step);
    return lockedIndex(list, tg.sel);
  }
  // §26 radar ekranına tıklama: belirli hedefe kilit (null → oto)
  function lockTarget(i) { if (tg.eng != null) return tg.eng; tg.sel = i == null ? { i: null, auto: true } : { i: Number(i), auto: false }; return tg.sel.i; }
  const tgQ = new T.Quaternion();
  function updateTargets(now, rawDt) {
    if (!tg.items.length) return;
    const t = targetTime();
    const has = t != null;
    tg.group.visible = has;
    if (!has) return;
    const rate = 70;   // rad/s pervane (sabit seyir devri)
    const hudLabelsOff = now - tg.hudAt < 3000;   // yavaş karede (yazılım WebGL) de kararlı
    const rel = [];
    const hdg = num(tele.last?.heading, 0);
    for (const x of tg.items) {
      const st = stateOf(x, t);
      if (!st) { if (x.root) x.root.visible = false; continue; }
      if (!x.root) {   // §26 tehdit: ilk görünüşte tembel kurulum
        if (!x.building) {
          x.building = true;
          buildEntry(x.it).then(e => { if (disposed || !tg.items.includes(x)) { disposeGroup(e.root); return; } Object.assign(x, e); tg.group.add(x.root); }).catch(() => { x.building = false; });
        }
        continue;
      }
      x.root.visible = true;
      x.root.position.set(st.x, st.y, st.z);
      x.body.quaternion.copy(attitudeQuat(T, st.roll, st.pitch || 0, st.yaw, tgQ));
      for (const p of x.props) {
        const ax = p.userData.axis || 'z';
        p.rotation[ax] = (p.rotation[ax] + rate * Math.min(0.5, rawDt) * (p.userData.dir || 1)) % (2 * Math.PI);
        if (p.userData.disc) p.userData.disc.material.opacity = 0.4;
        if (p.userData.blades) for (const b of p.userData.blades) b.visible = false;
      }
      x.spr.visible = st.phase !== 'fall' && !(hudLabelsOff && (camMode === 'fpv' || camMode === 'pilot'));   // HUD/OSD prizması çiziliyorsa sahne etiketi tekrar etmesin
      const f0 = tg.flash.get(x.it.i);
      if (f0 != null) {
        const u = (now - f0) / 2000;
        if (u >= 1) { tg.flash.delete(x.it.i); x.flash.visible = false; }
        else { x.flash.visible = true; x.flash.scale.setScalar(Math.max(1, 2 * x.R * (0.15 + 0.85 * u))); x.flash.material.opacity = 0.9 * (1 - u) ** 1.5; }
      }
      if (st.phase !== 'fall') {
        const dx = st.x - cur.pos.x, dy = st.y - cur.pos.y, dz = st.z - cur.pos.z, horiz = Math.hypot(dx, dy), dist = Math.hypot(horiz, dz);
        const bearing = ((Math.atan2(dx, dy) * 180 / Math.PI) + 360) % 360;
        let rr = bearing - hdg; while (rr > 180) rr -= 360; while (rr < -180) rr += 360;
        rel.push({ i: x.it.i, name: x.it.name, model: x.it.model, dist, horiz, dz, bearing, rel: rr, inside: dist <= x.R, state: st, dyn: !!x.it.dyn, x });
      }
    }
    if (now - tg.lastRel > 100) {   // 10 Hz: göreli durum (etiket, radar, targetsInfo)
      tg.lastRel = now;
      tg.rel = rel;
      for (const r of rel) {
        const x = r.x;
        const key = `${x.it.name}|${x.it.i}|${Math.round(r.dist / (r.dist > 1000 ? 100 : 5))}|${Math.round(r.dz / 5)}|${r.inside}`;
        if (key !== x.key) { x.key = key; drawLabel(x.cv.getContext('2d'), x.cv.width, x.cv.height, { name: `${x.it.i + 1} · ${x.it.name}`, dist: r.dist, dz: r.dz, inside: r.inside }); x.tex.needsUpdate = true; }
      }
      if (tg.radar && tg.radarOn && !tg.radarHide) drawRadar(tg.radar.getContext('2d'), tg.radar.width, tg.radar.height, rel, { radius: tg.cfg?.radius_m ?? TARGET_RADIUS });
    }
  }

  // ---------- §24.4 sihirbaz hedef önizlemesi: model görüntüleyici (AYNI WebGL bağlamı; ikinci bağlam açılmaz) ----------
  // Ayrı küçük sahne (ışıklar + 1 m'lik zemin ızgarası) → render hedefi → readRenderTargetPixels → kartın 2B tuvali (putImageData). Kart başına bağlam yok:
  // çağıran (flightsim_tgtview.js) her karede tek kartı çizer. Modeller anahtar başına bir kez kurulur (gerçek boyut, ×1 — uçuşta ×MODEL_SCALE).
  // render(cv, it, {az, el, zoom}) → {size [x, y, z] m, ppm (merkez derinliğinde piksel/metre)} | null (model yükleniyor). Sim dispose'unda temizlenir.
  const viewers = new Set();
  function createModelViewer() {
    const sc = new T.Scene(); sc.background = new T.Color(0x0b1418);
    sc.add(new T.HemisphereLight(0xe4eeff, 0x26302a, 1.5));
    const d1 = new T.DirectionalLight(0xffffff, 2.4); d1.position.set(2, -1.6, 3); sc.add(d1);
    const d2 = new T.DirectionalLight(0x9fc4ff, 0.8); d2.position.set(-2, 2, 1); sc.add(d2);
    const cam = new T.PerspectiveCamera(30, 16 / 9, 0.01, 2000); cam.up.set(0, 0, 1);
    const cache = new Map();
    let rt = null, buf = null, img = null, shown = null, grid = null, gridKey = '', disposedV = false;
    const keyOf = it => `${it.model || ''}|${it.glb_url || ''}`;
    const load = it => {
      const k = keyOf(it);
      if (!cache.has(k)) {
        const ent = { ready: false, err: null, holder: null, size: null, props: [] };
        cache.set(k, ent);
        buildTargetModel(it, MAT()).catch(() => buildDelta(MAT())).then(built => {
          if (disposedV) { disposeGroup(built.grp); return; }
          const holder = new T.Group(); holder.add(built.grp);
          const bb = new T.Box3().setFromObject(built.grp), c = bb.getCenter(new T.Vector3());
          built.grp.position.set(-c.x, -c.y, -bb.min.z);   // tabanı ızgaraya otur, yatayda ortala
          Object.assign(ent, { ready: true, holder, size: bb.getSize(new T.Vector3()).toArray(), props: built.props || [] });
        }).catch(err => { ent.err = err; });
      }
      return cache.get(k);
    };
    const setGrid = size => {
      const L = Math.max(size[0], size[1], 0.3), step = L > 6 ? 1 : L > 2.5 ? 0.5 : L > 1 ? 0.25 : 0.1, n = Math.max(6, Math.ceil(L * 1.3 / step / 2) * 2), key = `${step}|${n}`;
      if (key === gridKey) return step;
      if (grid) { sc.remove(grid); grid.geometry.dispose(); grid.material.dispose(); }
      grid = new T.GridHelper(n * step, n, 0x3cff9a, 0x1f5a3e); grid.rotation.x = Math.PI / 2;
      grid.material.transparent = true; grid.material.opacity = 0.55; grid.material.depthWrite = false;
      sc.add(grid); gridKey = key;
      return step;
    };
    const flipInto = (cv, w, h) => {
      const g2 = cv.getContext('2d');
      if (!img || img.width !== w || img.height !== h) img = g2.createImageData(w, h);
      for (let y = 0; y < h; y++) img.data.set(buf.subarray((h - 1 - y) * w * 4, (h - y) * w * 4), y * w * 4);   // WebGL alt-üst → canvas
      g2.putImageData(img, 0, 0);
    };
    const v = {
      preload: it => { load(it); },
      render(cv, it, { az = 0.8, el = 0.35, zoom = 1, spin = 0 } = {}) {
        if (disposedV || disposed) return null;
        const ent = load(it);
        if (!ent.ready) return ent.err ? { error: String(ent.err?.message || ent.err) } : null;
        const w = cv.width, h = cv.height;
        if (shown !== ent.holder) { if (shown) sc.remove(shown); sc.add(ent.holder); shown = ent.holder; }
        const step = setGrid(ent.size);
        for (const p of ent.props) { const ax = p.userData.axis || 'z'; p.rotation[ax] = (p.rotation[ax] + spin * (p.userData.dir || 1)) % (2 * Math.PI); if (p.userData.disc) p.userData.disc.material.opacity = 0.35; if (p.userData.blades) for (const b of p.userData.blades) b.visible = false; }
        const rad = Math.max(ent.size[0], ent.size[1], ent.size[2], 0.2) * 0.5, tz = ent.size[2] * 0.45;
        const dist = rad / Math.tan(cam.fov * DEG / 2) * 1.2 / clamp(zoom, 0.4, 4);
        cam.aspect = w / Math.max(1, h); cam.near = Math.max(0.005, dist / 200); cam.far = dist * 20; cam.updateProjectionMatrix();
        cam.position.set(Math.cos(el) * Math.sin(az) * dist, -Math.cos(el) * Math.cos(az) * dist, tz + Math.sin(el) * dist); cam.lookAt(0, 0, tz);
        if (!rt || rt.width !== w || rt.height !== h) { rt?.dispose(); rt = new T.WebGLRenderTarget(w, h, { samples: 4 }); rt.texture.colorSpace = T.SRGBColorSpace; buf = new Uint8Array(w * h * 4); }
        const prev = renderer.getRenderTarget(), sh = renderer.shadowMap.autoUpdate; renderer.shadowMap.autoUpdate = false;
        renderer.setRenderTarget(rt); renderer.render(sc, cam); renderer.readRenderTargetPixels(rt, 0, 0, w, h, buf);
        renderer.setRenderTarget(prev); renderer.shadowMap.autoUpdate = sh;
        flipInto(cv, w, h);
        return { size: ent.size.slice(), ppm: h / (2 * dist * Math.tan(cam.fov * DEG / 2)), grid: step };
      },
      dispose() {
        if (disposedV) return;
        disposedV = true; viewers.delete(v);
        for (const ent of cache.values()) if (ent.holder) disposeGroup(ent.holder);
        cache.clear(); rt?.dispose(); rt = null;
        if (grid) { grid.geometry.dispose(); grid.material.dispose(); }
      },
    };
    viewers.add(v);
    return v;
  }

  // ---------- boyut ----------
  function resize() {
    const w = Math.max(1, mountEl.clientWidth), hgt = Math.max(1, mountEl.clientHeight);
    applyPixelRatio();   // §43 çözünürlük ölçeği + piksel bütçesi (boyut değişince yeniden)
    renderer.setSize(w, hgt, false);
    camera.aspect = w / hgt;
    camera.updateProjectionMatrix();
  }
  const ro = new ResizeObserver(resize);
  ro.observe(mountEl);

  // ---------- §43 grafik kalitesi: canlı uygulama (sahne/oturum kaybolmaz) ----------
  // Piksel oranı (ölçek, tavan, bütçe; ekran kaydında taban), gölge haritası (boyut/tür değişince harita + malzemeler yeniden), gölge kapsamı (Ultra:
  // kamera uzaklığına göre yakın↔uzak), bina/ağaç/arazi gölge düşürme, anizotropik filtre, su kalitesi, görüş/sis + yağış (gökyüzü yeniden kurulur),
  // Google karo eşiği; arazi ayrıntısı / bitki yoğunluğu / doku çözünürlüğü dünyayı sessizce yeniden kurar (700 ms sonra; Google 3B'de yok).
  const gfxSt = { floor: false, nextAt: 0, times: [], calls: 0, tris: 0, rebuildT: 0, rebuilds: 0, blurred: false, worldKey: '' };
  const worldKeyOf = g => `${g.terrain}|${g.trees}|${g.atlasMax}`;
  gfxSt.worldKey = worldKeyOf(gfx);
  const onBlur = () => { gfxSt.blurred = true; }, onFocus = () => { gfxSt.blurred = false; };
  window.addEventListener('blur', onBlur); window.addEventListener('focus', onFocus);
  function applyPixelRatio() {
    if (preview) return;
    const w = Math.max(1, mountEl.clientWidth), h = Math.max(1, mountEl.clientHeight), dpr = devicePixelRatio || 1;
    const pr = pixelRatioFor(gfx, { dpr, cssW: w, cssH: h, floor: gfxSt.floor ? recordFloor(w, h, dpr) : 0 });
    if (Math.abs(renderer.getPixelRatio() - pr) > 1e-3) renderer.setPixelRatio(pr);
  }
  let shadowBox = 0;
  function setShadowBox(d) {
    if (shadowBox && Math.abs(d - shadowBox) < d * 0.08) return;
    shadowBox = d;
    const c = lights.sun.shadow.camera;
    c.left = c.bottom = -d; c.right = c.top = d; c.far = Math.max(700, Math.max(400, d * 2.5) + d * 2); c.updateProjectionMatrix();
  }
  const allMaterials = fn => scene.traverse(o => { const ms = Array.isArray(o.material) ? o.material : o.material ? [o.material] : []; ms.forEach(fn); });
  function applyShadows(force = false) {
    if (preview) return;
    const on = gfx.shadow > 0, type = gfx.shadowSoft ? T.PCFSoftShadowMap : T.PCFShadowMap;
    const changed = force || renderer.shadowMap.enabled !== on || renderer.shadowMap.type !== type || (on && lights.sun.shadow.mapSize.x !== gfx.shadow);
    renderer.shadowMap.enabled = on; renderer.shadowMap.type = type; lights.sun.castShadow = on;
    if (on) lights.sun.shadow.mapSize.set(gfx.shadow, gfx.shadow);
    if (changed) { lights.sun.shadow.map?.dispose(); lights.sun.shadow.map = null; allMaterials(m => { m.needsUpdate = true; }); }
    shadowBox = 0; setShadowBox(gfx.shadowDist);
  }
  function applyCast() {
    if (preview) return;
    gWorld.traverse(o => {
      if (!o.isMesh) return;
      if (o.name === 'arazi') { o.castShadow = !!gfx.terrainCast; return; }   // Ultra: dağlar yakın çevreye gölge düşürür
      if (o.name === 'ufuk-arazi' || o.name === 'uzak-arazi') return;
      if (o.userData.gfxCast0 === undefined) o.userData.gfxCast0 = !!o.castShadow;
      o.castShadow = o.userData.gfxCast0 && !!gfx.objCast;
    });
  }
  function applyAniso() {
    if (preview) return;
    const a = Math.max(1, Math.min(gfx.aniso, renderer.capabilities.getMaxAnisotropy?.() || 1)), seen = new Set();
    const fix = t => {
      if (!t || !t.isTexture || t.isRenderTargetTexture || t.isDepthTexture || seen.has(t) || !t.image || t.generateMipmaps === false) return;
      seen.add(t);
      if (t.anisotropy !== a) { t.anisotropy = a; t.needsUpdate = true; }
    };
    allMaterials(m => { fix(m.map); if (m.uniforms) for (const u of Object.values(m.uniforms)) fix(u?.value); });
    fix(wfx.U.detail.value); fix(wfx.U.detailN.value);
  }
  function scheduleRebuild() {
    clearTimeout(gfxSt.rebuildT);
    gfxSt.rebuildT = setTimeout(async () => {
      if (disposed || g3d) return;
      gfxSt.worldKey = worldKeyOf(gfx); gfxSt.rebuilds++;
      try { await buildWorld(W, true); } catch (err) { console.warn('grafik: dünya yeniden kurulamadı', err); return; }
      if (disposed) return;
      applyAniso();
      if (routePts.length) mission.redraw();
      if (site.cfg) { site.placedAt = -Infinity; placeSite(); }
    }, 700);
  }
  function setGraphics(p) {
    if (preview || !p) return getGraphics();
    const prev = gfx;
    gfx = { ...p };
    gpipe.set(gfx);
    resize();
    if (prev.shadow !== gfx.shadow || prev.shadowSoft !== gfx.shadowSoft || prev.shadowDist !== gfx.shadowDist || prev.cascade !== gfx.cascade) applyShadows();
    if (prev.objCast !== gfx.objCast || prev.terrainCast !== gfx.terrainCast) applyCast();
    if (prev.aniso !== gfx.aniso) applyAniso();
    wfx.U.waterQ.value = gfx.water;
    if ((prev.fog !== gfx.fog || prev.precip !== gfx.precip) && skyArgs) skyAndLights(...skyArgs);
    if (g3d && (prev.g3dError !== gfx.g3dError || prev.g3dCache !== gfx.g3dCache)) g3d.setQuality?.({ errorTarget: gfx.g3dError, cacheMB: gfx.g3dCache });
    if (worldKeyOf(gfx) !== gfxSt.worldKey) { if (g3d) gfxSt.worldKey = worldKeyOf(gfx); else scheduleRebuild(); }
    pip.lastAt = 0; rv.lastAt = 0; ev.lastAt = 0; sc.lastAt = 0; gfxSt.nextAt = 0;
    return getGraphics();
  }
  const getGraphics = () => ({ ...gfx, pr: renderer.getPixelRatio(), nativeAA, buffer: [renderer.domElement.width, renderer.domElement.height], pipe: gpipe.info(), floor: gfxSt.floor,
    shadowBox, rebuilds: gfxSt.rebuilds, g3d: g3d?.quality || null });
  const gfxStats = () => {
    // FPS: son 2 sn'deki karelerin aralığından (yazılım WebGL'de saniyede < 1 kare de ölçülür); son kareden beri geçen süre daha uzunsa o
    const tm = gfxSt.times, t = performance.now(), k = tm.length;
    const fps = k >= 2 ? Math.min((k - 1) * 1000 / Math.max(1, tm[k - 1] - tm[0]), 1000 / Math.max(1, t - tm[k - 1])) : k ? 1000 / Math.max(1, t - tm[0]) : 0;
    return { fps: Math.round(fps * 10) / 10, calls: gfxSt.calls, tris: gfxSt.tris, pr: renderer.getPixelRatio(), w: renderer.domElement.width, h: renderer.domElement.height,
      level: gfx.level, preset: gfx.preset, scaleMul: gfx.scaleMul ?? 1, samples: gpipe.samples, post: gpipe.active && !!gfx.post, cap: gfx.fpsCap, blurred: gfxSt.blurred };
  };
  const gpuName = () => { try { const gl = renderer.getContext(), e = gl.getExtension('WEBGL_debug_renderer_info'); return String(e ? gl.getParameter(e.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER)); } catch { return ''; } };
  const auxK = () => Math.min(3, Math.max(1, 30 / (gfx.pipFps || 30)));   // radar/EO güncelleme aralığı çarpanı (PiP hızına göre)

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
    if (!preview) {   // §43 kare hızı sınırı (30 / 60 / sınırsız) + arka planda (pencere odakta değil) 20 fps; ekran kaydında kısma yok
      const g = frameGate(now, gfxSt.nextAt, gfx.fpsCap, { background: gfxSt.blurred && !gfxSt.floor, bgThrottle: gfx.bgThrottle !== false });
      if (!g.draw) return;
      gfxSt.nextAt = g.next;
      gfxSt.times.push(now); while (gfxSt.times.length > 2 && gfxSt.times[0] < now - 2000) gfxSt.times.shift();
    }
    renderer.info.reset();
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
      rig.update(dt, { speed: tele.speed, alt: tele.has ? cur.pos.z : 0 });
      if (rig.carrying) {
        if (rig.carryPose) rig.carryPose(rigPos, rigQ, drone.ground || 0);   // §27 hücre/tüp ekseni boyunca (kuyruk tabanda; `launch`ta tırmanışla çıkar)
        else { rig.attachWorld(rigPos); rigPos.z += drone.ground || 0; rig.planeQuat(rigQ); }
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
    if (drone.type === 'rover' && tele.has) updateRover(now, dt);   // §31: zemine oturma (z + eğim/yatış), teker/direksiyon, toz
    rov.dust?.update(dt);
    if (tele.has) {
      const focus = roverFocus();   // §31: kara aracında 3B'de oturan konum (SITL yüksekliği değil)
      if (camMode === 'follow') {
        // kritik sönümlü yay: a = −2ω·v − ω²·(x − hedef); kullanıcının kamera−hedef vektörü (OrbitControls) korunur.
        // Düşük kare hızında (yazılım WebGL, 4–10 fps) gerçek geçen süre kadar küçük alt adımlarla ilerler: yay kararlı kalır ve kamera
        // dronun gerisinde kalmaz. Atlama (kayıt kaydırıcısı) sonrasında yay doğrudan dronun üstüne oturtulur (snapCamera).
        tmpV2.copy(camera.position).sub(controls.target);
        if (drone.type === 'rover' && rov.yawPrev != null && !camDrag) {   // §31 kovalama kamerası: araç dönünce bakış açısı da döner (aracın arkasında kalır)
          const dy = ((rov.yaw - rov.yawPrev + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI;
          if (Math.abs(dy) < 0.5) tmpV2.applyAxisAngle(tmpV.set(0, 0, 1), -dy);
        }
        if (camSnap) { camSnap = false; camSpring.pos.copy(focus); camSpring.vel.set(0, 0, 0); }
        else {
          const w = camSpring.w;
          let left = Math.min(0.5, rawDt);
          while (left > 0) {
            const h = Math.min(left, 1 / 120); left -= h;
            tmpV.copy(camSpring.pos).sub(focus).multiplyScalar(-w * w).addScaledVector(camSpring.vel, -2 * w);
            camSpring.vel.addScaledVector(tmpV, h);
            camSpring.pos.addScaledVector(camSpring.vel, h);
          }
        }
        controls.target.copy(camSpring.pos);
        camera.position.copy(camSpring.pos).add(tmpV2);
        if (drone.type === 'rover') camera.position.z = Math.max(camera.position.z, terrainHeight(camera.position.x, camera.position.y) + 0.6);   // yerde kamera zemine gömülmesin
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
    if (tg.items.length) updateTargets(now, rawDt);   // §24 hedefler (+ §26 tehditler)
    if (site.cfg) updateSite(now, rawDt);              // §26 radar anteni, EO başlığı, isabet/duman
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
    if (!preview) {
      const fp = roverFocus();
      if (gfx.cascade && gfx.shadow > 0) setShadowBox(gfx.shadowDist * clamp(camera.position.distanceTo(fp) / 80, 1, 2.2));   // §43 Ultra: yakında keskin, uzak bakışta geniş kapsam
      lights.sun.target.position.copy(fp); lights.sun.position.copy(fp).addScaledVector(sunDir, Math.max(400, shadowBox * 2.5));
    }
    // §31 dünya katmanı: gök/bulut/yağış/akış çizgileri/mercek damlaları, ağaç LOD'u (5 Hz), rüzgâr tulumu (+ Google'da yüzeye 1 Hz oturma), şimşek
    {
      const wnd = windNow(now);
      wfx.update(now, rawDt, { camera, focus: tele.has || drone.group ? drone.group.position : null, camMode, wind: wnd, mount: mountEl, vehicleCam: !preview && (camMode === 'pilot' || camMode === 'fpv') });
      if (treeChunks.length && now - treeLodAt > 200) { treeLodAt = now; wfx.updateTreeLod(treeChunks, camera.position, preview ? 520 : gfx.treeLod); }   // §43 ağaç LOD mesafesi
      if (sock) {
        sock.update(now / 1000, wnd.ms, wnd.dir, sockState(wnd.ms));
        if (terrain?.google && now - sockAt > 1000) { sockAt = now; sock.group.position.z = terrainHeight(sock.pos.x, sock.pos.y) - 0.1; }
      }
      lights.hemi.intensity = (wfx.fx.hemiI ?? lights.hemi.intensity) + wfx.flash * 2.2;
    }
    // Google 3B karoları: kamera çözünürlüğü + LOD + yer ofseti (kalkışa dek); kamera kipi değişse de aynı camera nesnesi
    // İkincil kameralar (radar / EO / PiP / nişangâh) de karo yükleyicisine kayıtlı: kendi bakış bölgeleri için karo + LOD (yoksa "yarım" görüntü)
    if (g3d) { try { g3d.setAuxCameras?.(preview ? [] : auxCameras()); g3d.update(camera, tele.has && tele.armed && tele.speed > 1, now); } catch { /* karo hatası kareyi durdurmasın */ } }
    // Kamera kipleri
    if (preview && previewFocus === 'rig' && rig) {   // §27 / §13 sihirbaz Kalkış adımı: düzeneğin çevresinde yavaş tur
      previewAngle += dt * 0.22;
      const f = rig.focus || { r: 16, h: 2, x: rig.group.position.x, y: rig.group.position.y, z: rig.group.position.z };
      camera.position.set(f.x + Math.cos(previewAngle) * f.r, f.y + Math.sin(previewAngle) * f.r, f.z + f.h + f.r * 0.32);
      camera.lookAt(f.x, f.y, f.z + (f.look ?? f.h * 0.55));
    } else if (preview) {
      previewAngle += dt * 0.12;
      const R = Math.max(900, terrain ? terrain.size * 0.32 : 1200);
      camera.position.set(Math.cos(previewAngle) * R, Math.sin(previewAngle) * R, Math.max(260, terrain ? terrain.H * 0.9 + 160 : 300));
      camera.lookAt(0, 0, 40);
    } else if (camMode === 'follow') {
      controls.update();
    } else if (camMode === 'fpv') {
      poseGimbal(camera);
    } else if (camMode === 'pilot') {
      posePilot(camera);
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
      const fp = roverFocus();
      camera.lookAt(fp);
      const dist = camera.position.distanceTo(fp);
      camera.fov = clamp(60 * 35 / Math.max(dist, 1), 5, 60);   // uzaklaştıkça yakınlaştır (teleobjektif)
      camera.updateProjectionMatrix();
    }
    frameMs += (Math.min(200, rawDt * 1000) - frameMs) * 0.1;   // ortalama kare süresi (PiP yarı hız kararı)
    const introOn = applyIntro(now);   // §27.2: giriş pozu (render sonrası geri yüklenir)
    // §18.6 çarpışma efekti: parçacıklar + kamera sarsıntısı (render sonrası geri yüklenir; takip/serbest kamera pozu bozulmaz)
    let shk = null;
    if (crashFx?.active) {
      crashFx.update(now);
      shk = crashFx.shake(now);
      if (shk) {
        const dk = clamp(camera.position.distanceTo(cur.pos) / 25, 0.15, 2);   // yakın kamerada (FPV/gimbal) daha küçük öteleme, daha belirgin yuvarlanma
        shakeSave.p.copy(camera.position); shakeSave.q.copy(camera.quaternion);
        camera.position.x += shk.x * dk; camera.position.y += shk.y * dk; camera.position.z += shk.z * dk;
        camera.rotateZ(shk.roll * (camMode === 'pilot' || camMode === 'fpv' ? 3 : 1));
      }
    }
    const fxType = camFxApplies(camMode) && introOn !== 'fly' ? camFx.type : 'day';
    if (!preview && introOn !== 'fly' && ((camMode === 'pilot' && drone.type !== 'rover') || fxType !== 'day')) {   // §31 kokpit: FPV son işlemi yok (gündüzde doğrudan)
      // Araç kamerası (§22/§22.3): sahne → render hedefi (termalde ısı malzemeleriyle) → CAM_FRAG (FPV balıkgözü/vinyet/analog · termal · gece görüşü)
      const rt = ensurePostTarget();
      withHeat(fxType === 'thermal', now, () => { renderer.setRenderTarget(rt); renderer.render(scene, camera); renderer.setRenderTarget(null); });
      post.mat.uniforms.tDiffuse.value = rt.texture;
      setCamUniforms(post.mat, camMode, rt.width, rt.height, false);
      renderer.render(post.scene, post.cam);
    } else {
      gpipe.render(scene, camera);   // §43: son işlem / FXAA / tuval dışı MSAA gerekiyorsa hat (sahne hedefi → ekran), yoksa doğrudan
    }
    if (pip.on && !camFx.none && !preview && introOn !== 'fly') renderPip(now);   // §27.2: giriş sırasında PiP çizilmez (çerçevesi de gizli)
    if (!preview && site.cfg) { renderRadarView(now); renderEoView(now); }   // §26 radar + EO ekranları (aynı bağlam; viewport kopyası)
    if (rig?.hasScope) renderScope(now);   // §27 el fırlatıcısı nişangâhı: 3B ekran dokusu + (açıksa) nişangâh penceresi (aynı bağlam)
    gfxSt.calls = renderer.info.render.calls; gfxSt.tris = renderer.info.render.triangles;   // §43 karenin toplamı
    if (frameHooks.size) frameHooks.forEach(fn => { try { fn(canvas); } catch { /* kanca hatası kareyi bozmaz */ } });   // §17: render SONRASI (aynı rAF turu; preserveDrawingBuffer gerekmez)
    if (shk) { camera.position.copy(shakeSave.p); camera.quaternion.copy(shakeSave.q); }
    if (introOn) restoreIntro();
  }
  // Araç kamera pozları (ana kamera ve PiP aynı fonksiyonlar)
  // Gimbal kamerası — burun konumu: gövde +Y yönünde model yarıçapı kadar ileri, biraz yukarı; bakış: gövde yönelimi × (90° + gimbal) X dönüşü
  // §25 tailsitter "VTOL görünümü": gövde burnu yukarı kalktıkça (askı) araç kameraları ve FPV OSD gövde · Rx(−90°·h) çerçevesini kullanır (ArduPlane
  // ahrs_view eşleniği: askıda ufuk düz, kamera karın yönüne bakar); h = burun yükselişi 30°→70° yumuşak geçiş. Diğer tiplerde gövdenin kendisi.
  const viewQ = new T.Quaternion(), viewTmp = new T.Quaternion(), viewAx = new T.Vector3(1, 0, 0), viewNose = new T.Vector3();
  const hoverFactor = q => { if (drone.type !== 'interceptor') return 0; viewNose.set(0, 1, 0).applyQuaternion(q); const e = Math.asin(clamp(viewNose.z, -1, 1)) / DEG; return smooth(30, 70, e); };
  const viewQuat = q => { const hf = hoverFactor(q); return hf <= 0 ? viewQ.copy(q) : viewQ.copy(q).multiply(viewTmp.setFromAxisAngle(viewAx, -Math.PI / 2 * hf)); };
  function poseGimbal(cam) {
    if (drone.type === 'rover' && drone.rover) {   // §31: gimbal = aracın sensör başlığı (EO/IR topu / kule kamerası); gövde zemine oturmuş yönelimle
      const sp = drone.rover.sensor;
      tmpV.set(sp ? sp.x : 0, sp ? sp.y : drone.nose / (drone.scale || 1), sp ? sp.z : 0.5).multiplyScalar(drone.scale || 1).applyQuaternion(drone.group.quaternion);
      cam.position.copy(drone.group.position).add(tmpV);
      tmpQ.setFromAxisAngle(tmpV2.set(1, 0, 0), (90 + gimbal) * DEG);
      cam.quaternion.copy(drone.group.quaternion).multiply(tmpQ);
      return;
    }
    const vq = viewQuat(cur.q);
    tmpV.set(0, drone.nose, 0.12 * (drone.scale || MODEL_SCALE)).applyQuaternion(cur.q);
    cam.position.copy(cur.pos).add(tmpV);
    tmpQ.setFromAxisAngle(tmpV2.set(1, 0, 0), (90 + gimbal) * DEG);
    cam.quaternion.copy(vq).multiply(tmpQ);
  }
  // GERÇEK FPV (§22): kamera burna sabit (burun noktası + küçük ileri ofset; 'burun görünür' açıkken biraz geride ve üstte → gövde ucu/pervane kadrajda),
  // gövdeyle birlikte döner: roll/pitch/yaw TAM uygulanır (ufuk yatar); gimbal yok. Gösterilen (kilit/düzenek dahil) gövde konumu kullanılır.
  // ofsetler model yarıçapına oranlı (kopter 0,75 m → birkaç cm; Caymaz ~3,8 m → ~30 cm geride): burun görünürken gövde ucu kadrajın altında
  function posePilot(cam) {
    if (drone.type === 'rover' && drone.rover) {   // §31 KOKPİT: sürücü gözü (GLB extras cockpit) — gövdeyle birlikte eğilir/yatar; burun ileri
      const cp = drone.rover.cockpit;
      tmpV.set(cp ? cp.x : 0, cp ? cp.y : drone.nose * 0.3, cp ? cp.z : drone.radius * 0.6).multiplyScalar(drone.scale || 1).applyQuaternion(drone.group.quaternion);
      cam.position.copy(drone.group.position).add(tmpV);
      tmpQ.setFromAxisAngle(tmpV2.set(1, 0, 0), 84 * DEG);   // 6° aşağı: kaput, ön cam çerçevesi ve yol kadrajda
      cam.quaternion.copy(drone.group.quaternion).multiply(tmpQ);
      return;
    }
    const back = fpv.nose ? -0.08 * drone.radius : 0.02 * drone.radius, up = fpv.nose ? 0.05 * drone.radius + 0.03 : 0.03 * drone.radius + 0.02;
    tmpV.set(0, drone.nose + back, up).applyQuaternion(drone.group.quaternion);
    cam.position.copy(drone.group.position).add(tmpV);
    tmpQ.setFromAxisAngle(tmpV2.set(1, 0, 0), 90 * DEG);   // gövde +Y (burun) → kamera −Z (bakış)
    cam.quaternion.copy(viewQuat(drone.group.quaternion)).multiply(tmpQ);   // §25 tailsitter askıda: VTOL görünümü
  }
  // Kamera PiP'i (§22.4): kaynak = pipSourceFor(ana kip, önceki ana kip) — ana gimbal değilse gimbal kamerası (tür efekti ve yakınlaştırma ile), gimbalse
  // önceki ana kip (takip: kullanıcının yörünge ofseti; FPV: balıkgözü). Render hedefi PiP'in CSS boyutu × min(dpr,1.5) × 0.75; pipInterval ile
  // (30 fps, ortalama kare > 22 ms ise 15 fps). Gölge haritası PiP geçişinde yenilenmez. Kopya her karede (viewport + scissor; CAM_FRAG).
  // Sekme gizliyken requestAnimationFrame durur → PiP de durur.
  const pipStats = { renders: 0, blits: 0 };
  let frameMs = 16;
  const pipSource = () => pipSourceFor(camMode, prevMode);
  function renderPip(now) {
    const r = pipRect(), src = pipSource();
    const pr = Math.min(renderer.getPixelRatio(), 1.5) * PIP_RES_SCALE * (gfx.pipScale || 1), rw = Math.max(64, Math.round(r.w * pr)), rh = Math.max(36, Math.round(r.h * pr));   // hedef: düşük çözünürlük (§43 PiP ölçeği)
    if (!pip.rt || pip.rt.width !== rw || pip.rt.height !== rh) { pip.rt?.dispose(); pip.rt = new T.WebGLRenderTarget(rw, rh, { depthBuffer: true, stencilBuffer: false }); pip.lastAt = 0; }
    if (now - pip.lastAt >= Math.max(pipInterval(frameMs), 1000 / (gfx.pipFps || 30) - 2) || pip.src !== src) {   // §43 PiP güncelleme hızı
      pip.lastAt = now; pip.src = src;
      if (src === 'fpv') { poseGimbal(pip.cam); pip.cam.fov = gimbalZoomFov(GIMBAL_FOV, camFx.zoom); pip.cam.near = 0.5; }
      else if (src === 'pilot') { posePilot(pip.cam); pip.cam.fov = fpv.fov; pip.cam.near = 0.05; }
      else {
        tmpV.copy(lastFollowOff || tmpV2.copy(followOff).multiplyScalar(Math.max(2, drone.radius)));
        pip.cam.position.copy(cur.pos).add(tmpV);
        pip.cam.position.z = Math.max(pip.cam.position.z, terrainHeight(pip.cam.position.x, pip.cam.position.y) + 1);
        pip.cam.lookAt(cur.pos); pip.cam.fov = 50; pip.cam.near = 0.5;
      }
      pip.cam.aspect = r.w / Math.max(1, r.h); pip.cam.far = camera.far; pip.cam.updateProjectionMatrix();
      const sh = renderer.shadowMap.autoUpdate; renderer.shadowMap.autoUpdate = false;
      const thermal = camFxApplies(src) && camFx.type === 'thermal';
      withHeat(thermal, now, () => { renderer.setRenderTarget(pip.rt); renderer.render(scene, pip.cam); renderer.setRenderTarget(null); });
      renderer.shadowMap.autoUpdate = sh;   // Google 3B: pip.cam karo yükleyicisine ikincil kamera olarak kayıtlı (auxCameras) — kendi bakışı için karo/LOD
      pipStats.renders++;
    }
    // kopya: PiP dikdörtgeni (viewport + scissor; ana görüntünün üstüne), tür efekti CAM_FRAG ile
    pip.mat.uniforms.tDiffuse.value = pip.rt.texture;
    setCamUniforms(pip.mat, src, rw, rh, true);
    const Wc = Math.max(1, mountEl.clientWidth), Hc = Math.max(1, mountEl.clientHeight);   // setViewport/setScissor CSS px alır (pixelRatio içeride)
    renderer.setViewport(r.x, Hc - r.y - r.h, r.w, r.h); renderer.setScissor(r.x, Hc - r.y - r.h, r.w, r.h); renderer.setScissorTest(true);
    renderer.render(pip.scene, post.cam);
    renderer.setScissorTest(false); renderer.setViewport(0, 0, Wc, Hc);
    pipStats.blits++;
  }
  // ---------- §26 yer kontrol sahası: istasyon + EO/radar kulesi + interceptor rafı (flightsim_gcs3d.js; yerleşim flightsim_gcs.siteLayout = sunucu yerlesim) ----------
  // Sahne nesneleri yerde (terrainHeight; Google karoları yüklendikçe saniyede bir yeniden oturur), pist yönüne döner, termalde ılık (userData.heat).
  // Radar anteni SWEEP_S periyotla döner (ekrandaki tarama hüzmesiyle aynı açı); EO başlığı seçili hedefe en çok 90°/sn ile döner/eğilir.
  // RADAR EKRANI ve EO EKRANI aynı renderer'da (İKİNCİ WebGL BAĞLAMI YOK; PiP kalıbı): küçük render hedefi → viewport/scissor kopyası.
  //  • Radar: kule merkezli eğik (52°) bakış; sahne (arazi/bina; sis kapalı, hedef etiketleri gizli) → render hedefi → taktik ton gölgelendiricisi;
  //    üstüne AYRI radar sahnesi (kapsama + ara halkalar, dönen hüzme, prizma ikonlar + yere iniş çubuğu) derinlik temizlenerek çizilir. Kapsama
  //    dışındaki hedefler çizilmez; seçili hedef sarı + büyük. Ekran menzili otomatik (radarSteps) ya da sabit. Teşhis/2B katman: radarInfo().
  //  • EO: kuledeki başlıktan seçili hedefe; oto yakınlaştırma (eoZoom), menzil dışında geniş açı; tür gündüz/termal/gece (CAM_FRAG, kendi türü).
  const site = { cfg: null, L: null, group: new T.Group(), tower: null, station: null, rack: null, rackSlots: [], rackModels: [], rackN: 0, rackShow: 0, placedAt: -Infinity,
    eo: { az: 0, el: 0, ready: false, follow: true, selKey: null }, hitAt: -Infinity, health: 100, smoke: [] };
  scene.add(site.group);
  heatRoots.push(site.group);
  const nearSite = (x, y, m = 22) => !!site.L && [site.L.station, site.L.tower, site.L.rack].some(p => Math.hypot(x - p.x, y - p.y) < m);
  const placeSite = () => {
    if (!site.L) return;
    const put = (obj, p) => { if (!obj) return; obj.position.set(p.x, p.y, terrainHeight(p.x, p.y)); obj.rotation.z = -num(p.yaw_deg, 0) * DEG; };
    put(site.station?.group, site.L.station); put(site.tower?.group, site.L.tower); put(site.rack?.group, site.L.rack);
    site.smoke.forEach(s => { s.userData.base = site.station?.group.position.clone(); });
  };
  async function setSite(cfg, o = {}) {
    disposeGroup(site.group);
    site.tower = site.station = site.rack = null; site.rackModels = []; site.rackSlots = []; site.smoke = [];
    site.cfg = cfg && (cfg.station || cfg.radar || cfg.eo) ? { ...cfg } : null;
    site.L = site.cfg ? (cfg.layout || siteLayout(num(W.runway_heading, 0))) : null;
    if (!site.cfg) return;
    if (site.cfg.station) { site.station = buildStation(T); site.group.add(site.station.group); }
    if (site.cfg.radar || site.cfg.eo) { site.tower = buildTower(T, { radar: !!site.cfg.radar, eo: !!site.cfg.eo, eoZ: num(site.L.eo_z, TOWER_EO_Z), radarZ: num(site.L.radar_z, TOWER_RADAR_Z) }); site.group.add(site.tower.group); }
    // istasyon dumanı (§26 görev: sağlık düştükçe yoğunlaşır)
    if (site.station) {
      const tex = smokeTexture();
      for (let k = 0; k < 7; k++) { const s = new T.Sprite(new T.SpriteMaterial({ map: tex, color: 0x2a2a2a, transparent: true, opacity: 0, depthWrite: false })); s.visible = false; s.userData.ph = k / 7; site.group.add(s); site.smoke.push(s); }
      const hit = new T.Sprite(new T.SpriteMaterial({ map: ringTexture(), color: 0xff7a1a, transparent: true, opacity: 0, depthWrite: false, blending: T.AdditiveBlending, fog: false }));
      hit.visible = false; site.group.add(hit); site.hitSpr = hit;
    }
    const n = Math.max(0, Math.round(num(o.rack, 0)));
    if (n > 0) {
      site.rack = buildRackPad(T, n); site.group.add(site.rack.group); site.rackSlots = site.rack.slots; site.rackN = n;
      const mdl = o.model || (drone.type === 'interceptor' ? drone.model : null) || { id: 'builtin:icept_x4' };
      for (let i = 0; i < n; i++) {
        let b;
        try { b = await buildFor('interceptor', normModel('interceptor', mdl), MAT()); } catch { b = buildIcept(MAT()); }
        if (disposed || !site.rack) { disposeGroup(b.grp); return; }
        const holder = new T.Group();
        b.grp.scale.setScalar(MODEL_SCALE);
        b.grp.rotation.x = Math.PI / 2;   // tailsitter rafta kuyruk üstünde (burun +Y → yukarı)
        const bb = new T.Box3().setFromObject(b.grp); b.grp.position.z = -bb.min.z;
        b.grp.traverse(m => { if (m.isMesh) { m.userData.heat = 0.38; m.castShadow = true; } });   // soğuk (çalışmıyor)
        holder.add(b.grp);
        const sl = site.rackSlots[i]; holder.position.set(sl.x, sl.y, sl.z);
        site.rack.group.add(holder); site.rackModels.push(holder);
      }
      setRackCount(o.show ?? n);
    }
    placeSite();
  }
  function setRackCount(k) { site.rackShow = clamp(Math.round(num(k, 0)), 0, site.rackModels.length); site.rackModels.forEach((m, i) => { m.visible = i < site.rackShow; }); }
  let smokeTex = null;
  const smokeTexture = () => {
    if (smokeTex) return smokeTex;
    const cv = document.createElement('canvas'); cv.width = cv.height = 64;
    const g = cv.getContext('2d'), gr = g.createRadialGradient(32, 32, 2, 32, 32, 30);
    gr.addColorStop(0, 'rgba(255,255,255,0.9)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = gr; g.fillRect(0, 0, 64, 64);
    smokeTex = new T.CanvasTexture(cv);
    return smokeTex;
  };
  function siteHit(health) { site.hitAt = performance.now(); if (health != null) site.health = num(health, site.health); }
  const towerWorld = new T.Vector3();
  const eoHeadPos = out => {   // EO topunun merkezi (dünya): kule yerelinde EO_POST, pist yönüne döndürülmüş
    const L = site.L, z = terrainHeight(L.tower.x, L.tower.y), h = num(L.tower.yaw_deg, 0) * DEG, [ex, ey] = EO_POST, c = Math.cos(h), sn = Math.sin(h);
    return out.set(L.tower.x + ex * c + ey * sn, L.tower.y - ex * sn + ey * c, z + num(L.eo_z, TOWER_EO_Z));
  };
  // Seçili (elle kilitlenmiş) etkin hedef: {x, st} ya da null
  const selectedEntry = t => { if (tg.sel.auto || tg.sel.i == null || t == null) return null; const x = tg.items.find(e => e.it.i === tg.sel.i); if (!x || !x.root) return null; const st = stateOf(x, t); return st && st.phase !== 'fall' ? { x, st } : null; };
  function updateSite(now, rawDt) {
    if (!site.cfg) return;
    if (now - site.placedAt > (now < 30000 ? 1000 : 4000)) { site.placedAt = now; placeSite(); }
    const sw = sweepAngle(now / 1000, num(site.L.sweep_s, SWEEP_S));
    if (site.tower?.radar) site.tower.radar.rotation.z = -sw * DEG;
    if (site.tower?.beacon) site.tower.beacon.visible = (now % 1500) < 160;
    // EO başlığı: seçili hedef + takip açıkken hedefe (90°/sn dönüş hızı sınırı); aksi hâlde SON YÖNDE sabit (kendiliğinden tarama yok — kullanıcı
    // isteği). Yeni hedef seçimi (Tab / radar tıklaması) takibi ve oto zoom'u yeniden açar; elle pan/tilt (eoDrag) takibi bırakır.
    if (site.tower?.eoPan) {
      const t = targetTime(), sel = selectedEntry(t), selKey = sel ? sel.x.it.i : (tg.sel.auto ? null : tg.sel.i);
      if (selKey !== site.eo.selKey) { site.eo.selKey = selKey; if (selKey != null) { site.eo.follow = true; ev.fovT = null; } }
      let az = site.eo.az, el = site.eo.el;
      if (!site.eo.ready) { az = num(site.L.tower.yaw_deg, 0); el = 1.5; }   // ilk yön: pist yönü, ufka
      if (sel && eoAimMode(true, site.eo.follow) === 'track') { const lk = eoLook(site.L.tower, sel.st.x, sel.st.y, sel.st.z - terrainHeight(site.L.tower.x, site.L.tower.y), num(site.L.eo_z, TOWER_EO_Z)); az = lk.az; el = lk.el; }
      const dt = Math.min(0.25, rawDt), mx = 90 * dt;
      let da = az - site.eo.az; while (da > 180) da -= 360; while (da < -180) da += 360;
      site.eo.az = site.eo.ready ? (site.eo.az + clamp(da, -mx, mx) + 360) % 360 : az;
      site.eo.el = site.eo.ready ? site.eo.el + clamp(el - site.eo.el, -mx, mx) : el;
      site.eo.ready = true;
      site.tower.eoPan.rotation.z = -(site.eo.az - num(site.L.tower.yaw_deg, 0)) * DEG;
      site.tower.eoTilt.rotation.x = clamp(site.eo.el, -60, 85) * DEG;
    }
    // istasyon isabeti: turuncu parlama + duman (sağlık < 100)
    if (site.hitSpr) {
      const u = (now - site.hitAt) / 1600, p = site.station.group.position;
      if (u >= 0 && u < 1) { site.hitSpr.visible = true; site.hitSpr.position.set(p.x, p.y, p.z + 3); site.hitSpr.scale.setScalar(6 + 40 * u); site.hitSpr.material.opacity = 0.95 * (1 - u) ** 1.3; }
      else site.hitSpr.visible = false;
      const dmg = clamp((100 - site.health) / 100, 0, 1);
      for (const s of site.smoke) {
        if (dmg <= 0.01) { s.visible = false; continue; }
        const ph = ((now / 1000) * 0.18 + s.userData.ph) % 1;
        s.visible = true;
        s.position.set(p.x + Math.sin(ph * 9 + s.userData.ph * 20) * 1.2 + ph * 6, p.y + ph * 3, p.z + 3 + ph * (14 + 20 * dmg));
        s.scale.setScalar(3 + ph * (8 + 10 * dmg));
        s.material.opacity = (0.15 + 0.55 * dmg) * Math.sin(ph * Math.PI);
      }
    }
  }

  // ---------- §26 radar ekranı ----------
  const TINT_FRAG = `uniform sampler2D tDiffuse; uniform float time; varying vec2 vUv;
    void main() { vec3 c = texture2D(tDiffuse, vUv).rgb; float l = dot(c, vec3(0.299, 0.587, 0.114));
      vec3 tac = vec3(0.03, 0.09, 0.07) + l * vec3(0.5, 0.92, 0.68);
      vec3 col = mix(c * 0.8, tac, 0.55);
      vec2 d = vUv - 0.5; col *= 1.0 - dot(d, d) * 0.9;
      col *= 0.93 + 0.07 * sin(vUv.y * 420.0);
      gl_FragColor = vec4(col, 1.0); }`;
  const rv = { rect: null, rt: null, cam: new T.PerspectiveCamera(36, 1.4, 5, 200000), scene: new T.Scene(), quad: null, mat: null, lastAt: 0, fixedKm: null, rangeM: 2000,
    rings: null, ringsR: 0, sweep: null, sweepR: 0, icons: new Map(), own: null, info: null, renders: 0 };
  rv.cam.up.set(0, 0, 1);
  rv.mat = new T.ShaderMaterial({ uniforms: { tDiffuse: { value: null }, time: { value: 0 } }, depthTest: false, depthWrite: false, vertexShader: CAM_VERT, fragmentShader: TINT_FRAG });
  rv.quad = new T.Mesh(new T.PlaneGeometry(2, 2), rv.mat); rv.quad.frustumCulled = false;
  const rvQuadScene = new T.Scene(); rvQuadScene.add(rv.quad);
  const rvSelRing = (() => { const pts = []; for (let k = 0; k <= 48; k++) { const a = k / 48 * Math.PI * 2; pts.push(new T.Vector3(Math.cos(a), Math.sin(a), 0)); } const l = new T.Line(new T.BufferGeometry().setFromPoints(pts), new T.LineBasicMaterial({ color: 0xffe14a, transparent: true, opacity: 0.95, depthTest: false })); l.renderOrder = 7; l.visible = false; return l; })();
  rv.scene.add(rvSelRing);
  const ICON_COLOR = { own: 0x38e8ff, threat: 0xff4433, target: 0xff9d2e, sel: 0xffe14a };
  const radarIcon = (key, kind) => {
    let e = rv.icons.get(key);
    if (!e) {
      const g = buildRadarPrism(T, ICON_COLOR[kind] || 0xff4433);
      const stalk = new T.Line(new T.BufferGeometry().setFromPoints([new T.Vector3(0, 0, 0), new T.Vector3(0, 0, -1)]), new T.LineBasicMaterial({ color: ICON_COLOR[kind] || 0xff4433, transparent: true, opacity: 0.55, depthTest: false }));
      stalk.renderOrder = 4;
      rv.scene.add(g, stalk);
      e = { g, stalk, kind, seen: 0 };
      rv.icons.set(key, e);
    }
    return e;
  };
  const rvTmp = new T.Vector3();
  const projRadar = (x, y, z, r) => { rvTmp.set(x, y, z).project(rv.cam); return { x: (rvTmp.x + 1) / 2 * r.w, y: (1 - rvTmp.y) / 2 * r.h, vis: rvTmp.z < 1 && rvTmp.z > -1 }; };
  function renderRadarView(now) {
    const r = rv.rect;
    if (!r || !site.cfg?.radar || r.w < 40 || r.h < 30) return;
    const L = site.L, tw = L.tower, R = num(site.cfg.radar_km, 20) * 1000, t = targetTime();
    const zt = terrainHeight(tw.x, tw.y);
    // görünenler: kendi dron + kapsamadaki etkin hedefler
    const seen = [];
    if (tele.has) seen.push({ key: 'own', kind: 'own', x: cur.pos.x, y: cur.pos.y, z: cur.pos.z, hd: num(tele.last?.heading, 0), i: null, name: drone.type === 'interceptor' ? 'INTERCEPTOR' : 'İHA' });
    if (t != null) for (const { x, st } of activeEntries(t)) if (st.phase !== 'fall' && radarCovers(site.cfg, tw, st.x, st.y)) seen.push({ key: `t${x.it.dyn ? 'd' : 'o'}${x.it.k ?? x.it.i}`, kind: x.it.dyn ? 'threat' : 'target', x: st.x, y: st.y, z: st.z, hd: num(st.heading, 0), i: x.it.i, name: x.it.name, alt: st.z, dyn: !!x.it.dyn, phase: st.phase });
    const covered = seen.filter(s => s.kind === 'own' ? radarCovers(site.cfg, tw, s.x, s.y) : true);
    rv.rangeM = rv.fixedKm ? Math.min(rv.fixedKm * 1000, R) : autoRadarRange(covered.map(s => Math.hypot(s.x - tw.x, s.y - tw.y)), R / 1000) * 1000;
    // eğik kamera (kuzey yukarı, güneyden bakış)
    const el = 52 * DEG, aspect = r.w / Math.max(1, r.h), vf = rv.cam.fov * DEG / 2, hf = Math.atan(Math.tan(vf) * aspect);
    const d = Math.max(rv.rangeM * 1.08 / Math.tan(hf), rv.rangeM * Math.sin(el) * 1.28 / Math.tan(vf));
    rv.cam.aspect = aspect; rv.cam.near = d * 0.05; rv.cam.far = d * 4;
    rv.cam.position.set(tw.x, tw.y - d * Math.cos(el) * 0.92, zt + d * Math.sin(el)); rv.cam.lookAt(tw.x, tw.y + rv.rangeM * 0.06, zt); rv.cam.updateProjectionMatrix(); rv.cam.updateMatrixWorld();
    // 1) arazi geçişi (seyrek: 8 fps; yavaş karede 4)
    const pr = Math.min(renderer.getPixelRatio(), 1.5) * 0.8 * (gfx.pipScale || 1), rw = Math.max(64, Math.round(r.w * pr)), rh = Math.max(48, Math.round(r.h * pr));
    if (!rv.rt || rv.rt.width !== rw || rv.rt.height !== rh) { rv.rt?.dispose(); rv.rt = new T.WebGLRenderTarget(rw, rh, { depthBuffer: true, stencilBuffer: false }); rv.lastAt = 0; }
    if (now - rv.lastAt >= (frameMs > 22 ? 250 : 125) * auxK()) {
      rv.lastAt = now;
      const fog = scene.fog, sh = renderer.shadowMap.autoUpdate, tgv = tg.group.visible, mg = mission.group, mv = mg?.visible, bg = scene.background;
      scene.fog = null; renderer.shadowMap.autoUpdate = false; tg.group.visible = false; if (mg) mg.visible = false; scene.background = RADAR_BG;
      const ul = radarUnderlay(R, tw, zt); if (ul) ul.visible = true;   // düz altlık: dünya kenarı / yüklenmemiş karo boşluğu dolu
      try { renderer.setRenderTarget(rv.rt); renderer.render(scene, rv.cam); } finally {
        renderer.setRenderTarget(null); scene.fog = fog; renderer.shadowMap.autoUpdate = sh; tg.group.visible = tgv; if (mg) mg.visible = mv; scene.background = bg; if (ul) ul.visible = false;
      }
      rv.renders++;
    }
    // 2) halkalar / hüzme (menzil değişince yeniden), ikonlar (ekran boyutu sabit)
    if (!rv.rings || rv.ringsR !== R) { if (rv.rings) { disposeGroup(rv.rings); rv.scene.remove(rv.rings); } rv.rings = buildRangeRings(T, R); rv.ringsR = R; rv.scene.add(rv.rings); }
    if (!rv.sweep || rv.sweepR !== R) { if (rv.sweep) { disposeGroup(rv.sweep); rv.scene.remove(rv.sweep); } rv.sweep = buildSweep(T, R); rv.sweepR = R; rv.scene.add(rv.sweep); }
    rv.rings.position.set(tw.x, tw.y, zt + 0.5); rv.sweep.position.set(tw.x, tw.y, zt + 0.6);
    const sw = sweepAngle(now / 1000, num(L.sweep_s, SWEEP_S));
    rv.sweep.rotation.z = -sw * DEG;
    const pxWorld = dist => dist * 2 * Math.tan(vf) / Math.max(1, r.h);   // 1 ekran pikselinin dünya boyu (o uzaklıkta)
    const stamp = now;
    const info = { range_m: rv.rangeM, coverage_m: R, sweep: sw, rect: { ...r }, items: [], own: null, rings: [], north: null, selected: tg.sel.auto ? null : tg.sel.i };
    for (const s of covered) {
      const e = radarIcon(s.key, s.kind), sel = s.i != null && !tg.sel.auto && tg.sel.i === s.i;
      e.seen = stamp;
      const dCam = rv.cam.position.distanceTo(rvTmp.set(s.x, s.y, s.z));
      const sc = pxWorld(dCam) * (sel ? 19 : s.kind === 'own' ? 15 : 13);
      e.g.visible = true; e.g.position.set(s.x, s.y, s.z); e.g.scale.setScalar(sc); e.g.rotation.set(0, 0, -s.hd * DEG);
      const glow = s.kind === 'own' ? 1 : sweepGlow(bearingFrom(tw, s.x, s.y), sw, num(L.sweep_s, SWEEP_S));
      e.g.userData.mat.color.setHex(sel ? ICON_COLOR.sel : ICON_COLOR[s.kind]); e.g.userData.mat.opacity = 0.35 + 0.6 * glow; e.g.userData.edgeMat.opacity = 0.4 + 0.6 * glow;
      const gz = terrainHeight(s.x, s.y);
      e.stalk.visible = s.z - gz > 2; e.stalk.position.set(s.x, s.y, s.z); e.stalk.scale.set(1, 1, Math.max(0.01, s.z - gz)); e.stalk.material.opacity = 0.25 + 0.35 * glow;
      if (sel) { rvSelRing.visible = true; rvSelRing.position.set(s.x, s.y, s.z); rvSelRing.scale.setScalar(pxWorld(dCam) * 17); rvSelRing.material.opacity = 0.6 + 0.4 * Math.sin(now / 160); }
      const p = projRadar(s.x, s.y, s.z, r);
      const it = { i: s.i, kind: s.kind, name: s.name, x: p.x, y: p.y, alt: Math.round(s.z), dist: Math.hypot(s.x - tw.x, s.y - tw.y), sel, glow, dyn: !!s.dyn, phase: s.phase };
      if (s.kind === 'own') info.own = it; else info.items.push(it);
    }
    if (!covered.some(s => s.i != null && !tg.sel.auto && tg.sel.i === s.i)) rvSelRing.visible = false;
    for (const [k, e] of rv.icons) if (e.seen !== stamp) { e.g.visible = false; e.stalk.visible = false; if (stamp - e.seen > 20000) { disposeGroup(e.g); rv.scene.remove(e.g, e.stalk); e.stalk.geometry.dispose(); e.stalk.material.dispose(); rv.icons.delete(k); } }
    for (const f of [0.25, 0.5, 0.75, 1]) { const p = projRadar(tw.x + R * f, tw.y, zt, r); info.rings.push({ x: p.x, y: p.y, m: R * f }); }   // halka etiketleri kulenin doğusunda
    const np = projRadar(tw.x, tw.y + Math.min(R, rv.rangeM) * 0.98, zt, r); info.north = { x: np.x, y: np.y };
    const tp = projRadar(tw.x, tw.y, zt, r); info.tower = { x: tp.x, y: tp.y };
    rv.info = info;
    // 3) kopya: ton gölgelendiricisi + radar sahnesi (derinlik temizlenir; ikonlar her zaman görünür)
    const Wc = Math.max(1, mountEl.clientWidth), Hc = Math.max(1, mountEl.clientHeight);
    rv.mat.uniforms.tDiffuse.value = rv.rt.texture; rv.mat.uniforms.time.value = (now / 1000) % 1000;
    renderer.setViewport(r.x, Hc - r.y - r.h, r.w, r.h); renderer.setScissor(r.x, Hc - r.y - r.h, r.w, r.h); renderer.setScissorTest(true);
    renderer.render(rvQuadScene, post.cam);
    const ac = renderer.autoClear; renderer.autoClear = false; renderer.clearDepth();
    renderer.render(rv.scene, rv.cam);
    renderer.autoClear = ac;
    renderer.setScissorTest(false); renderer.setViewport(0, 0, Wc, Hc);
  }
  const RADAR_BG = new T.Color(0x06120e);
  // Radar altlığı: kule merkezli ±2,5·kapsama karesi (eğik kameranın üst köşeleri dahil), YALNIZ radar geçişinde görünür; derinlik testi/yazımı kapalı + en düşük renderOrder → önce çizilir,
  // arazi / Google karoları üstüne yazar (yalnız boşlukları doldurur). Doku: gerçek/Google dünyada uydu karoları (/tile/img vekili; eksen başına ≤ 8
  // karo, underlayPlan), prosedürel dünyada (ya da karo alınamazsa) arazi paletinde tohumlu gürültü. Kapsama/kule değişince yeniden kurulur.
  const rvUnder = { mesh: null, key: '', state: 'none' };
  function procGroundTexture() {
    const cv = document.createElement('canvas'); cv.width = cv.height = 256;
    const g = cv.getContext('2d'), rnd = rng(num(W.seed, 12345) ^ 0x51ed);
    g.fillStyle = '#4f7a3c'; g.fillRect(0, 0, 256, 256);
    for (let k = 0; k < 900; k++) {   // alacalı tarla/çayır lekeleri
      const x = rnd() * 256, y = rnd() * 256, r = 2 + rnd() * 18, c = rnd();
      g.fillStyle = c < 0.5 ? `rgba(122,154,70,${0.25 + rnd() * 0.3})` : c < 0.8 ? `rgba(60,96,44,${0.25 + rnd() * 0.3})` : `rgba(150,140,100,${0.2 + rnd() * 0.25})`;
      g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill();
    }
    const t = new T.CanvasTexture(cv); t.wrapS = t.wrapT = T.RepeatWrapping; t.colorSpace = T.SRGBColorSpace;
    return t;
  }
  function radarUnderlay(R, tw, zt) {
    if (preview || typeof document === 'undefined') return null;
    const half = R * 2.5, imagery = !!(terrain?.google || terrain?.real) && !!(origin.lat || origin.lon);
    const key = `${Math.round(R)}:${Math.round(tw.x)}:${Math.round(tw.y)}:${imagery ? 'img' : 'proc'}`;
    if (rvUnder.key !== key) {
      rvUnder.key = key;
      crashFx?.dispose(); crashFx = null;
    if (rvUnder.mesh) { scene.remove(rvUnder.mesh); rvUnder.mesh.geometry.dispose(); rvUnder.mesh.material.map?.dispose(); rvUnder.mesh.material.dispose(); }
      const geo = new T.PlaneGeometry(half * 2, half * 2, 24, 24);
      const tex = procGroundTexture(); tex.repeat.set(half / 900, half / 900);
      const m = new T.Mesh(geo, new T.MeshBasicMaterial({ map: tex, depthTest: false, depthWrite: false, fog: false }));
      m.name = 'radar-altlik'; m.renderOrder = -1e6; m.frustumCulled = false; m.visible = false;
      scene.add(m); rvUnder.mesh = m; rvUnder.state = 'proc';
      if (imagery) loadUnderlayImagery(key, half, tw);
    }
    const m = rvUnder.mesh;
    m.position.set(tw.x, tw.y, zt - 0.5);
    m.material.color.setHex(W.time === 'night' ? 0x4c5670 : W.time === 'dusk' ? 0xe8b898 : 0xffffff);
    return m;
  }
  async function loadUnderlayImagery(key, half, tw) {
    const plan = underlayPlan(origin.lat, origin.lon, tw.x, tw.y, half, 8);
    const n = 2 ** plan.z, cv = document.createElement('canvas');
    cv.width = plan.nx * TILE_PX; cv.height = plan.ny * TILE_PX;
    const g = cv.getContext('2d'); g.fillStyle = '#3b4a3a'; g.fillRect(0, 0, cv.width, cv.height);
    const list = []; for (let y = plan.y0; y <= plan.y1; y++) for (let x = plan.x0; x <= plan.x1; x++) list.push({ x, y });
    let ok = 0;
    await pool(list, PARALLEL, async t => {
      if (rvUnder.key !== key || disposed) return;
      try { const bmp = await getBitmap(`${TERRAIN_API}/tile/img/${plan.z}/${((t.x % n) + n) % n}/${t.y}`); g.drawImage(bmp, (t.x - plan.x0) * TILE_PX, (t.y - plan.y0) * TILE_PX); bmp.close?.(); ok++; } catch { /* eksik karo: zemin rengi */ }
    });
    if (rvUnder.key !== key || disposed || !rvUnder.mesh || !ok) return;
    const m = rvUnder.mesh, pos = m.geometry.attributes.position, uv = m.geometry.attributes.uv;
    for (let i = 0; i < pos.count; i++) { const t = underlayUV(plan, origin.lat, origin.lon, tw.x + pos.getX(i), tw.y + pos.getY(i)); uv.setXY(i, t[0], t[1]); }
    uv.needsUpdate = true;
    const tex = new T.CanvasTexture(cv); tex.colorSpace = T.SRGBColorSpace; tex.generateMipmaps = true; tex.minFilter = T.LinearMipmapLinearFilter;
    m.material.map?.dispose(); m.material.map = tex; m.material.needsUpdate = true;
    rvUnder.state = `img z${plan.z} ${ok}/${list.length}`; rv.lastAt = 0;
  }
  // Karo yükleyicisine kaydedilecek ikincil kameralar (Google 3B; flightsim_g3d.setAuxCameras): yalnız o an çizilenler, render hedefi çözünürlüğüyle
  function auxCameras() {
    const out = [];
    if (pip.on && !camFx.none && pip.rt) out.push({ cam: pip.cam, w: pip.rt.width, h: pip.rt.height });
    if (site.cfg?.radar && rv.rect && rv.rt) out.push({ cam: rv.cam, w: rv.rt.width, h: rv.rt.height });
    if (site.cfg?.eo && ev.rect && ev.rt) out.push({ cam: ev.cam, w: ev.rt.width, h: ev.rt.height });
    if (rig?.hasScope && sc.rt && sc.rect) out.push({ cam: sc.cam, w: sc.rt.width, h: sc.rt.height });
    return out;
  }
  // Radar ekranında tıklama (CSS px, dikdörtgene göre) → en yakın ikon (≤ 22 px) → i (kendi dron / boş → null)
  function radarPick(px, py) {
    const it = (rv.info?.items || []).reduce((b, c) => { const d = Math.hypot(c.x - px, c.y - py); return d < 22 && (!b || d < b.d) ? { d, c } : b; }, null);
    return it ? it.c.i : null;
  }

  // ---------- §26 EO ekranı ----------
  const ev = { rect: null, rt: null, cam: new T.PerspectiveCamera(EO_FOV_MAX, 1.4, 0.5, 60000), mat: camMat(), scene: new T.Scene(), lastAt: 0, type: 'day', info: null, renders: 0, fov: EO_FOV_MAX, fovT: null };
  ev.cam.up.set(0, 0, 1);
  { const q = new T.Mesh(new T.PlaneGeometry(2, 2), ev.mat); q.frustumCulled = false; ev.scene.add(q); }
  const evPos = new T.Vector3(), evTgt = new T.Vector3();
  function renderEoView(now) {
    const r = ev.rect;
    if (!r || !site.cfg?.eo || !site.L || r.w < 40 || r.h < 30) return;
    const t = targetTime(), sel = selectedEntry(t);
    eoHeadPos(evPos);
    const L = site.L, zt = terrainHeight(L.tower.x, L.tower.y);
    let status = 'idle', range = null, look = null, size = 3;
    if (sel) {
      look = eoLook(L.tower, sel.st.x, sel.st.y, sel.st.z - zt, num(L.eo_z, TOWER_EO_Z));
      range = look.range_m; size = sel.x.size || 3;
      status = eoStatus(site.cfg, sel.x.it.i, range);
      if (!site.eo.follow) status = 'manual';   // elle pan/tilt: hedef seçili ama başlık takip etmiyor ("Takip" ya da yeniden seçimle döner)
    }
    // bakış: başlığın (dönüş hızı sınırlı) az/el'i — iz sürerken hedefin kendisine (ince ayar)
    const az = site.eo.az * DEG, el = site.eo.el * DEG;
    evTgt.set(evPos.x + Math.sin(az) * Math.cos(el) * 100, evPos.y + Math.cos(az) * Math.cos(el) * 100, evPos.z + Math.sin(el) * 100);
    let slewErr = 180;
    if (sel && look) { let da = look.az - site.eo.az; while (da > 180) da -= 360; while (da < -180) da += 360; slewErr = Math.hypot(da, look.el - site.eo.el); }
    if (status === 'track' && slewErr < 3) evTgt.set(sel.x.root.position.x, sel.x.root.position.y, sel.x.root.position.z);
    // zoom: elle (tekerlek / sıkıştırma — ev.fovT) varsa o; yoksa izlemede oto (eoZoom), diğer durumlarda geniş açı
    const z = status === 'track' ? eoZoom(range, size) : { fov: EO_FOV_MAX, zoom: 1 };
    const fovGoal = ev.fovT != null ? ev.fovT : z.fov;
    ev.fov += (fovGoal - ev.fov) * (ev.fovT != null ? 0.35 : status === 'track' ? 0.5 : 0.25);   // yumuşak zoom (yavaş karede de birkaç karede oturur)
    if (Math.abs(fovGoal - ev.fov) < 1e-3) ev.fov = fovGoal;
    const pr = Math.min(renderer.getPixelRatio(), 1.5) * 0.85 * (gfx.pipScale || 1), rw = Math.max(64, Math.round(r.w * pr)), rh = Math.max(48, Math.round(r.h * pr));
    if (!ev.rt || ev.rt.width !== rw || ev.rt.height !== rh) { ev.rt?.dispose(); ev.rt = new T.WebGLRenderTarget(rw, rh, { depthBuffer: true, stencilBuffer: false }); ev.lastAt = 0; }
    if (now - ev.lastAt >= (frameMs > 22 ? 133 : 66) * auxK()) {
      ev.lastAt = now;
      ev.cam.position.copy(evPos).addScaledVector(evTgt.clone().sub(evPos).normalize(), 0.9);   // pencerenin önü: başlığın kendi gövdesi/kolu kadraja girmesin
      ev.cam.lookAt(evTgt);
      ev.cam.fov = clamp(ev.fov, EO_FOV_MIN, EO_FOV_MAX); ev.cam.aspect = r.w / Math.max(1, r.h); ev.cam.near = 1.0; ev.cam.far = camera.far; ev.cam.updateProjectionMatrix();
      const sh = renderer.shadowMap.autoUpdate; renderer.shadowMap.autoUpdate = false;
      const hidden = tg.items.filter(x => x.spr?.visible); hidden.forEach(x => { x.spr.visible = false; });
      const mg = mission.group, mv = mg?.visible; if (mg) mg.visible = false;
      const tw = site.tower?.group, twv = tw?.visible; if (tw) tw.visible = false;   // kamera kulenin üstünde: kendi kafes/direk gövdesi kadrajı kapatmasın
      // optik yakınlaştırma: hedef menzilde sis/pus örtmesin (oyun okunurluğu) — sis mesafeleri hedef menzilinin ötesine itilir
      const fg = scene.fog, fn = fg?.near, ff = fg?.far;
      if (fg && status === 'track' && range > fg.near * 0.8) { const k = Math.max(1, range * 1.6 / Math.max(1, fg.near)); fg.near *= k; fg.far *= k; }
      else if (fg && ev.fovT != null) { const k = Math.max(1, EO_FOV_MAX / Math.max(EO_FOV_MIN, ev.fov) * 0.6); fg.near *= k; fg.far *= k; }   // elle yakınlaştırma: optik pus azalır
      try { withHeat(ev.type === 'thermal', now, () => { renderer.setRenderTarget(ev.rt); renderer.render(scene, ev.cam); renderer.setRenderTarget(null); }); }
      finally { renderer.shadowMap.autoUpdate = sh; hidden.forEach(x => { x.spr.visible = true; }); if (mg) mg.visible = mv; if (tw) tw.visible = twv; if (fg) { fg.near = fn; fg.far = ff; } }
      ev.renders++;
    }
    ev.mat.uniforms.tDiffuse.value = ev.rt.texture;
    setCamUniforms(ev.mat, 'fpv', rw, rh, true, ev.type);
    const Wc = Math.max(1, mountEl.clientWidth), Hc = Math.max(1, mountEl.clientHeight);
    renderer.setViewport(r.x, Hc - r.y - r.h, r.w, r.h); renderer.setScissor(r.x, Hc - r.y - r.h, r.w, r.h); renderer.setScissorTest(true);
    renderer.render(ev.scene, post.cam);
    renderer.setScissorTest(false); renderer.setViewport(0, 0, Wc, Hc);
    ev.info = { status, sel: sel ? sel.x.it.i : null, name: sel ? sel.x.it.name : null, dyn: !!sel?.x.it.dyn, az: site.eo.az, el: site.eo.el, range_m: range, zoom: EO_FOV_MAX / ev.cam.fov, fov: ev.cam.fov,
      type: ev.type, eo_km: num(site.cfg.eo_km, 5), slewing: status === 'track' && slewErr >= 3, phase: sel?.st.phase || null, speed: sel ? sel.st.speed : null,
      follow: !!site.eo.follow, manualZoom: ev.fovT != null };
  }
  // EO elle kumanda (§26 ek): tekerlek zoom, basılı sürükle pan/tilt (takibi bırakır), "Takip" (takibe + oto zoom'a dön)
  function eoWheel(deltaY) { if (!site.cfg?.eo) return null; ev.fovT = eoWheelFov(ev.fovT ?? ev.fov, deltaY); ev.lastAt = 0; return ev.fovT; }
  function eoPinch(ratio) { if (!site.cfg?.eo) return null; ev.fovT = eoPinchFov(ev.fovT ?? ev.fov, ratio); ev.lastAt = 0; return ev.fovT; }
  function eoDrag(dx, dy, hPx) {
    if (!site.cfg?.eo || !site.eo.ready) return null;
    const v = eoDragLook(site.eo.az, site.eo.el, dx, dy, clamp(ev.fov, EO_FOV_MIN, EO_FOV_MAX), hPx);
    site.eo.az = v.az; site.eo.el = v.el; site.eo.follow = false; ev.lastAt = 0;
    return v;
  }
  function eoFollow() { site.eo.follow = true; ev.fovT = null; ev.lastAt = 0; return true; }
  // ---------- §27 el fırlatıcısı NİŞANGÂHI (aynı renderer; İKİNCİ WebGL BAĞLAMI YOK) ----------
  // Kamera nişan biriminin lensinden nişan yönüne (az, el; yuvarlanma yok) → küçük render hedefi. Bu doku (1) aparatın üstündeki 3B EKRANA (MeshBasic
  // harita) ve (2) nişangâh penceresi açıksa viewport/scissor kopyasıyla ana tuvale çizilir (EO kalıbı). 3B ekranın sembol katmanı (TD kutusu/prizma,
  // ekran dışı oklar, artı işareti, AZ/EL) 2B tuvalde (flightsim_tgthud.symbology/drawSymbology) → CanvasTexture; pencerenin katmanı DOM'da (scopeHud).
  // Hız: pencere açık 20 fps (yavaş karede 10), yalnız 3B ekran 6 fps ve ana kamera aparata < 80 m iken. Render sırasında düzenek (pilot/tüp) ve
  // tüpteki dron gizlenir; hedef etiket sprite'ları ve görev çizimi gizlenir.
  const sc = { rect: null, rt: null, cam: new T.PerspectiveCamera(SCOPE_FOV, 1.4, 0.3, 60000), mat: camMat(), scene: new T.Scene(), lastAt: 0, zoom: 1, renders: 0,
    pos: new T.Vector3(), ovlCv: null, ovlTex: null, hud: null };
  sc.cam.up.set(0, 0, 1);
  { const q = new T.Mesh(new T.PlaneGeometry(2, 2), sc.mat); q.frustumCulled = false; sc.scene.add(q); }
  // Nişangâh sembolojisi verisi (flightsim_tgthud.symbology girişi; SON nişangâh render pozuyla). Hedef yoksa items boş.
  function scopeHud() {
    if (!rig?.hasScope) return null;
    sc.cam.updateMatrixWorld();
    const e = sc.cam.matrixWorld.elements;
    const view = { pos: [e[12], e[13], e[14]], right: [e[0], e[1], e[2]], up: [e[4], e[5], e[6]], fwd: [-e[8], -e[9], -e[10]], tanV: Math.tan(sc.cam.fov * DEG / 2), aspect: sc.cam.aspect, k: 0, scale: 1 };
    const t = tg.cfg && tg.items.length ? targetTime() : null;
    const P = { x: e[12], y: e[13], z: e[14] };
    const items = t != null && tg.group.visible ? hudItems(t, P) : [];
    // kilit: elle kilitli hedef (Tab / radar) yoksa NİŞAN ÇİZGİSİNE en yakın hedef (en küçük sapma açısı) — TD kutusu nişan alınan hedefte
    let sel = { ...tg.sel };
    if (sel.auto && items.length) {
      const f = view.fwd, ang = it => { const d = [it.center[0] - P.x, it.center[1] - P.y, it.center[2] - P.z], n = Math.hypot(...d) || 1; return Math.acos(clamp((d[0] * f[0] + d[1] * f[1] + d[2] * f[2]) / n, -1, 1)); };
      sel = { i: items.reduce((b, it) => (ang(it) < ang(b) ? it : b)).i, auto: false };
    }
    return { view, radius: tg.cfg?.radius_m || 25, sel, player: { pos: [P.x, P.y, P.z], vel: [0, 0, 0] }, items, aim: rig.aim, zoom: sc.zoom, fov: sc.cam.fov };
  }
  function drawScopeOverlay() {   // 3B ekranın sembol katmanı (256×184 saydam tuval)
    if (typeof document === 'undefined' || !rig?.screenOverlay) return;
    if (!sc.ovlCv) { sc.ovlCv = document.createElement('canvas'); sc.ovlCv.width = 256; sc.ovlCv.height = 184; sc.ovlTex = new T.CanvasTexture(sc.ovlCv); sc.ovlTex.colorSpace = T.SRGBColorSpace; }
    const o = rig.screenOverlay;
    if (o.material.map !== sc.ovlTex) { o.material.map = sc.ovlTex; o.material.needsUpdate = true; o.visible = true; }
    const g = sc.ovlCv.getContext('2d'), Wc = sc.ovlCv.width, Hc = sc.ovlCv.height, C = '#7dff8a';
    g.clearRect(0, 0, Wc, Hc);
    const d = sc.hud;
    if (d?.items?.length) drawSymbology(g, symbology(d, Wc, Hc, { S: 0.8, inset: { l: 18, r: 18, t: 18, b: 22 } }), { color: C, S: 0.8, F: 11, W: Wc, H: Hc });
    g.strokeStyle = C; g.lineWidth = 1.5; g.beginPath();   // artı işareti
    g.moveTo(Wc / 2 - 14, Hc / 2); g.lineTo(Wc / 2 - 4, Hc / 2); g.moveTo(Wc / 2 + 4, Hc / 2); g.lineTo(Wc / 2 + 14, Hc / 2);
    g.moveTo(Wc / 2, Hc / 2 - 14); g.lineTo(Wc / 2, Hc / 2 - 4); g.moveTo(Wc / 2, Hc / 2 + 4); g.lineTo(Wc / 2, Hc / 2 + 14); g.stroke();
    g.font = '700 13px ui-monospace, Menlo, Consolas, monospace'; g.fillStyle = C; g.textBaseline = 'bottom';
    const a = rig.aim; g.textAlign = 'left'; g.fillText(`AZ ${String(Math.round(a.az) % 360).padStart(3, '0')}`, 6, Hc - 4); g.textAlign = 'right'; g.fillText(`EL ${Math.round(a.el)}`, Wc - 6, Hc - 4);
    g.textAlign = 'center'; g.textBaseline = 'top'; g.fillText(`×${sc.zoom}${d?.items?.length ? ` · ${d.items.length} TGT` : ''}`, Wc / 2, 4);
    sc.ovlTex.needsUpdate = true;
  }
  function renderScope(now) {
    const r = sc.rect;
    const near = camera.position.distanceTo(rig.group.position) < 80 * (MODEL_SCALE / 2.5);
    if (!r && !near) return;
    const pr = Math.min(renderer.getPixelRatio(), 1.5) * 0.85 * (gfx.pipScale || 1);
    const rw = r ? Math.max(96, Math.round(r.w * pr)) : 256, rh = r ? Math.max(72, Math.round(r.h * pr)) : 184;
    if (!sc.rt || sc.rt.width !== rw || sc.rt.height !== rh) { sc.rt?.dispose(); sc.rt = new T.WebGLRenderTarget(rw, rh, { depthBuffer: true, stencilBuffer: false }); sc.lastAt = 0; }
    const scr = rig.screen;
    if (scr && scr.material.map !== sc.rt.texture) { scr.material.map = sc.rt.texture; scr.material.color.set(0xffffff); scr.material.needsUpdate = true; }
    if (now - sc.lastAt >= (r ? (frameMs > 22 ? 100 : 50) : (preview ? 200 : 160))) {
      sc.lastAt = now;
      const p = rig.scopePose(sc.pos);
      const f = aimVector(p.az, p.el);
      sc.cam.position.copy(p.pos); sc.cam.lookAt(p.pos.x + f[0] * 100, p.pos.y + f[1] * 100, p.pos.z + f[2] * 100);
      sc.cam.fov = scopeFov(sc.zoom); sc.cam.aspect = rw / rh; sc.cam.far = camera.far; sc.cam.updateProjectionMatrix(); sc.cam.updateMatrixWorld();
      const sh = renderer.shadowMap.autoUpdate; renderer.shadowMap.autoUpdate = false;
      const rv0 = rig.group.visible, dv = drone.group.visible, carry = rig.carrying;
      rig.group.visible = false; if (carry) drone.group.visible = false;
      const hidden = tg.items.filter(x => x.spr?.visible); hidden.forEach(x => { x.spr.visible = false; });
      const mg = mission.group, mv = mg?.visible; if (mg) mg.visible = false;
      try { renderer.setRenderTarget(sc.rt); renderer.render(scene, sc.cam); renderer.setRenderTarget(null); }
      finally { renderer.shadowMap.autoUpdate = sh; rig.group.visible = rv0; drone.group.visible = dv; hidden.forEach(x => { x.spr.visible = true; }); if (mg) mg.visible = mv; }
      sc.renders++;
      sc.hud = scopeHud();
      drawScopeOverlay();
    }
    if (r) {
      sc.mat.uniforms.tDiffuse.value = sc.rt.texture;
      setCamUniforms(sc.mat, 'fpv', rw, rh, true, 'day');
      const Wc = Math.max(1, mountEl.clientWidth), Hc = Math.max(1, mountEl.clientHeight);
      renderer.setViewport(r.x, Hc - r.y - r.h, r.w, r.h); renderer.setScissor(r.x, Hc - r.y - r.h, r.w, r.h); renderer.setScissorTest(true);
      renderer.render(sc.scene, post.cam);
      renderer.setScissorTest(false); renderer.setViewport(0, 0, Wc, Hc);
    }
  }
  // "Hedefe yönel": kilitli (yoksa en yakın) hedefe nişan
  function aimAtTarget(i = null) {
    if (!rig?.hasScope) return null;
    const t = targetTime(); if (t == null) return null;
    const lens = rig.scopePose(sc.pos)?.pos; if (!lens) return null;
    const list = activeEntries(t).filter(({ st }) => st.phase !== 'fall');
    if (!list.length) return null;
    const want = i ?? (tg.sel.auto ? null : tg.sel.i);
    const pick = list.find(e => e.x.it.i === want) || list.reduce((b, e) => (!b || e.x.root.position.distanceTo(lens) < b.x.root.position.distanceTo(lens) ? e : b), null);
    const pp = pick.x.root.position, a = aimAt([lens.x, lens.y, lens.z], [pp.x, pp.y, pp.z]);
    const res = rig.setAim(a.az, a.el);
    if (launchCfg) { launchCfg.aim_az_deg = res.az; launchCfg.aim_el_deg = res.el; }
    return { ...res, i: pick.x.it.i, range: a.range };
  }
  const setAim = (az, el) => { if (!rig?.setAim) return null; const a = rig.setAim(az, el); if (launchCfg) { launchCfg.aim_az_deg = a.az; launchCfg.aim_el_deg = a.el; } sc.lastAt = 0; return a; };
  const setLauncherInventory = inv => { launcherInv = inv ? { ...inv } : null; if (rig?.setInventory && launcherInv) rig.setInventory(launcherInv); };
  const launcherInfo = () => (rig?.iceptRig ? { method: rig.method, phase: rig.phase, aim: rig.aim, inventory: rig.inventory, cells: rig.cells, puffs: rig.puffs, scope: !!rig.hasScope,
    scopeRenders: sc.renders, scopeRect: sc.rect, zoom: sc.zoom, screen: rig.screenPose?.() || null, x: rig.group.position.x, y: rig.group.position.y, z: rig.group.position.z } : null);
  const siteInfo = () => (site.cfg ? { cfg: { ...site.cfg }, layout: site.L, rack: site.rackShow, rackN: site.rackModels.length, eo: { ...site.eo },
    station: site.station ? site.station.group.position.toArray() : null, tower: site.tower ? site.tower.group.position.toArray() : null } : null);
  const frameHooks = new Set();   // §17 ekran kaydı: her karede render edilen tuvali okuyan kancalar (drawImage → birleşik kayıt tuvali)

  // ---------- kurulum ----------
  // §24.4 stüdyo kipi (SIMUMAV hedef adımı: o adımda başka 3B sahne yok → tek bağlam): dünya/dron/kare döngüsü kurulmaz; yalnız model görüntüleyici
  if (opts.studio) {
    canvas.style.display = 'none';
    return { createModelViewer, dispose, canvas, get studio() { return true; } };
  }
  if (opts.site?.layout) site.L = opts.site.layout;   // §26: dünya kurulurken saha çevresi açık kalsın (ağaç yok); setSite modelleri kurar
  if (!preview) { wfx.U.waterQ.value = gfx.water; setShadowBox(gfx.shadowDist); }   // §43 su kalitesi + gölge kapsamı
  await buildWorld(world);
  if (!preview && gfx.aniso !== 8) applyAniso();   // §43 (zemin ayrıntı dokuları 8× ile kurulur)
  await setType(opts.type, opts.model ?? opts.airframe);
  buildRig();
  resize();
  if (!preview) { setCamera(CAMERA_MODES.some(([k]) => k === opts.camera) && !(opts.camera === 'fpv' && camFx.none) ? opts.camera : 'follow'); } else { controls.enabled = false; }   // opts.camera: oturumlar arası kalıcı seçim (fs.cam)
  raf = requestAnimationFrame(frame);

  async function setWorld(nw) {
    await buildWorld(nw);
    if (disposed) return;
    buildRig();   // pist yönü / saat değişmiş olabilir
    if (!tele.has) drone.group.position.set(0, 0, (drone.ground || 0.2) + 0.02);
    if (!preview && camMode === 'follow') resetCamera();
    if (routePts.length) mission.redraw();   // yüzey değişti: rota/iniş dairesi yere göre yeniden
    if (site.cfg) { site.placedAt = -Infinity; placeSite(); }   // §26
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
    [...viewers].forEach(v => v.dispose());
    buildSeq++;   // bekleyen gerçek arazi yüklemesi sonuçlarını kullanmaz
    realCache = null;
    g3d?.dispose(); g3d = null;
    rig?.dispose(); rig = null;
    cancelAnimationFrame(raf);
    clearTimeout(gfxSt.rebuildT); window.removeEventListener('blur', onBlur); window.removeEventListener('focus', onFocus); gpipe.dispose();   // §43
    ro.disconnect();
    window.removeEventListener('keydown', onKeyDown); window.removeEventListener('keyup', onKeyUp);
    canvas.removeEventListener('pointerdown', onPointerDown); canvas.removeEventListener('pointermove', onPointerMove);
    canvas.removeEventListener('pointerup', onPointerUp); canvas.removeEventListener('pointercancel', onPointerUp);
    canvas.removeEventListener('wheel', onWheel);
    canvas.removeEventListener('pointerdown', onTapDown); canvas.removeEventListener('pointerup', onTapUp);
    controls.dispose();
    rov.dust?.dispose();
    wfx.dispose();
    disposeGroup(gWorld); disposeGroup(drone.group); mission.dispose(); disposeGroup(tg.group); tg.radar?.remove();
    disposeGroup(site.group); disposeGroup(rv.scene); rv.rt?.dispose(); rv.mat.dispose(); rv.quad.geometry.dispose(); ev.rt?.dispose(); ev.mat.dispose(); smokeTex?.dispose(); sc.rt?.dispose(); sc.mat.dispose(); sc.ovlTex?.dispose();   // §26 + §27 nişangâh
    if (rvUnder.mesh) { scene.remove(rvUnder.mesh); rvUnder.mesh.geometry.dispose(); rvUnder.mesh.material.map?.dispose(); rvUnder.mesh.material.dispose(); rvUnder.mesh = null; }   // radar altlığı
    post.rt?.dispose(); post.mat.dispose(); post.quad.geometry.dispose(); pip.rt?.dispose(); pip.mat.dispose(); pip.quad.geometry.dispose(); heatMats.forEach(m => m.dispose()); heatMats.clear();
    renderer.dispose();
    renderer.forceContextLoss?.();
    canvas.remove();
  }

  return {
    setTelemetry, setCamera, getCamera: () => camMode, setGimbal, getGimbal: () => gimbal, resetCamera, snapCamera, terrainHeight, toLocal,
    playIntro, endIntro, introActive: () => intro.on,   // §27.2 giriş sekansı
    // FPV (pilot) kipi (§22): görüş açısı 90–150 (tekerlek), analog efekt (gölgelendirici doygunluğu), burun görünür, PiP (takip kamerası sağ üst, 20 fps)
    setPilotFov, getPilotFov: () => fpv.fov, setFpvAnalog: v => { fpv.analog = !!v; }, getFpvAnalog: () => fpv.analog, setFpvNose: v => { fpv.nose = !!v; }, getFpvNose: () => fpv.nose,
    setPip: v => { pip.on = !!v; }, getPip: () => pip.on, pipRect, pipStats: () => ({ ...pipStats, interval: pipInterval(frameMs), frameMs, rt: pip.rt ? [pip.rt.width, pip.rt.height] : null }),
    // §22.4 kamera PiP'i (sürüklenebilir pencere: flightsim_camera.js createCameraPip) + §22.3 kamera türü
    setPipRect: r => { pip.rect = r && r.w > 0 && r.h > 0 ? { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.w), h: Math.round(r.h) } : null; },
    getPipSource: pipSource, getPrevCamera: () => prevMode,
    swapPip: () => { if (camFx.none) return null; const t = pipSwapTarget(camMode, prevMode); setCamera(t); return t; },   // çift tık: ana gimbal değilse gimbal; gimbalse PiP'teki kip
    setCamType: t => { camFx.none = isNoCam(t); camFx.type = normCamType(t); pip.lastAt = 0; if (camFx.none) { pip.rt?.dispose(); pip.rt = null; if (camMode === 'fpv') setCamera(prevMode !== 'fpv' ? prevMode : 'follow'); } return camFx.none ? 'none' : camFx.type; },
    getCamType: () => (camFx.none ? 'none' : camFx.type), hasGimbal: () => !camFx.none,
    setThermalPalette: p => { camFx.palette = normPalette(p); return camFx.palette; }, getThermalPalette: () => camFx.palette,
    setGimbalZoom, getGimbalZoom: () => camFx.zoom,
    cameraState: () => ({ x: camera.position.x, y: camera.position.y, z: camera.position.z, az: controls.getAzimuthalAngle(), pol: controls.getPolarAngle(), dist: camera.position.distanceTo(controls.target) }),   // teşhis (§14 testleri: fare ile döndürme çalışıyor mu)
    setWorld, setOrigin, setType, snapshotModel, clearCollision, resize, dispose, netStats, motionStats, setKeyboardLock,
    crashFx: playCrashFx, crashFxInfo: () => (crashFx ? { active: crashFx.active, params: crashFx.params } : null),
    setLaunch, setLaunchPhase, get launchPhase() { return rig ? rig.phase : null; }, get groundLocked() { return gLock.on; },   // kalkış yöntemi + yerde kilit (§13)
    // §31 hava / rüzgâr / rampa: canlı rüzgâr (sunucu `wind` olayı; tele.wind_spd zaten akar), akış çizgileri aç/kapa, rüzgâr bilgisi (HUD), rampa yön/açı önizlemesi
    setWind: w => { if (!w) return; for (const [k, wk] of [['ms', 'wind_ms'], ['dir', 'wind_dir'], ['gust', 'wind_gust'], ['turb', 'wind_turb']]) if (w[k] != null || w[wk] != null) W[wk] = num(w[k] ?? w[wk], W[wk]); windSt.liveAt = -Infinity; },
    windInfo: () => windNow(performance.now()),
    setWindStreaks: v => { wfx.setStreaks(v); }, getWindStreaks: () => wfx.streaksOn,
    setRampAim, pickRig, get rampAim() { return launchCfg?.method === 'ramp' ? normRampAim(launchCfg, rampHeading(launchCfg, num(W.runway_heading, 0))) : null; },
    fxInfo: () => { const i = renderer.info; return { weather: normWeather(W.weather), precip: wfx.precipKind, precipCount: wfx.precipCount, streaks: wfx.streaksOn, treeChunks: treeChunks.length, treeHi: treeChunks.filter(c => c.hi.visible).length, sock: !!sock, calls: i.render.calls, tris: i.render.triangles, geos: i.memory.geometries, texs: i.memory.textures, fog: scene.fog ? [Math.round(scene.fog.near), Math.round(scene.fog.far)] : null, towns: terrain?.towns ?? null, townsAt: terrain?.townsAt || null }; },
    setRoute, setMission, setMissionCurrent, get route() { return routePts.slice(); }, get mission() { return mission.data; }, get missionObjects() { return mission.objectCount; },   // §14/§18: SITL'deki görev (çizim flightsim_mission.js)
    get modelInfo() { return { type: drone.type, model: drone.model, bbox: drone.bbox || null, props: drone.props.length }; },
    // §31 kara aracı teşhisi: zemine oturma (gösterilen z ↔ 4 köşe yüzeyi, eğim/yatış), teker/direksiyon, örnek niteliği (Google kaba karo sayısı)
    roverState: () => { const R = drone.rover; if (!R) return null; const p = drone.group.position; return { shownZ: p.z - (drone.ground || 0), fitZ: rov.fit?.z ?? null, hs: rov.hs, fine: rov.fine,
      pitchDeg: rov.fit ? rov.fit.pitch / DEG : null, rollDeg: rov.fit ? rov.fit.roll / DEG : null, steerDeg: R.steerDeg, speed: rov.speed, kin: rov.kin, wheels: R.wheels.length, steers: R.steers.length, drive: R.drive,
      wheelbase: R.wheelbase, track: R.track, samples: rov.samples, coarse: rov.coarse, dust: !!rov.dust?.active, cockpit: R.cockpit?.toArray() || null, sensor: R.sensor?.toArray() || null, scale: drone.scale }; },
    setRoverDust: v => { rov.dustOn = !!v; if (!v) rov.dust?.clear(); },   // yönelim paneli (§12)
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
    getPose: () => { if (drone.type === 'rover' && rov.fit) return { roll: rov.fit.roll, pitch: rov.fit.pitch, yaw: rov.yaw }; tmpE.setFromQuaternion(viewQuat(cur.q), 'ZXY'); return { roll: tmpE.y, pitch: tmpE.x, yaw: -tmpE.z }; },   // §31 kara aracı: zemine oturmuş gövde   // render edilen (enterpolasyonlu) yönelim, rad (FPV HUD; §25 tailsitter askıda VTOL görünümü)
    getBodyPose: () => { tmpE.setFromQuaternion(cur.q, 'ZXY'); return { roll: tmpE.y, pitch: tmpE.x, yaw: -tmpE.z, hover: hoverFactor(cur.q) }; },   // §25 teşhis: gövde (SITL fiziği) yönelimi + askı oranı
    // §24 hedefler
    createModelViewer,   // §24.4 sihirbaz hedef önizlemesi (aynı bağlam)
    setTargets, flashTarget, targetsHud, cycleTarget, setEngaged, cameraView: () => (preview ? null : cameraView()), get engaged() { return tg.eng; }, get targetLock() { return tg.cfg ? { ...tg.sel } : null; }, targetsInfo: () => tg.rel.map(r => ({ i: r.i, name: r.name, dist: Math.round(r.dist), horiz: Math.round(r.horiz), dz: Math.round(r.dz), bearing: Math.round(r.bearing), rel: Math.round(r.rel), inside: r.inside })),
    get targetTime() { return targetTime(); }, setRadarVisible: v => { tg.radarOn = !!v; syncSmallRadar(); },
    // §26 yer kontrol sahası + radar/EO ekranları + "Yer kontrolünü koru" tehditleri
    setSite, setRackCount, siteHit, siteInfo, setDefend, setDefendState, flashThreat, lockTarget,
    // §27 INTERCEPTOR fırlatıcıları: envanter (hücre durumları), el fırlatıcısı nişanı + nişangâh (3B ekran + pencere)
    setPreviewFocus: f => { previewFocus = f === 'rig' ? 'rig' : null; }, get rigFocus() { return rig?.focus || null; },
    setLauncherInventory, launcherInfo, setAim, getAim: () => (rig?.hasScope ? rig.aim : null), aimAtTarget, scopeHud: () => sc.hud, get hasScope() { return !!rig?.hasScope; },
    setScopeRect: r => { sc.rect = r && r.w > 0 && r.h > 0 ? { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.w), h: Math.round(r.h) } : null; sc.lastAt = 0; },
    setScopeZoom: z => { sc.zoom = SCOPE_ZOOMS.includes(Number(z)) ? Number(z) : 1; sc.lastAt = 0; return sc.zoom; }, getScopeZoom: () => sc.zoom,
    setRadarRect: r => { rv.rect = r && r.w > 0 && r.h > 0 ? { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.w), h: Math.round(r.h) } : null; tg.radarHide = !!rv.rect; syncSmallRadar(); },
    setEoRect: r => { ev.rect = r && r.w > 0 && r.h > 0 ? { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.w), h: Math.round(r.h) } : null; },
    setRadarRange: km => { rv.fixedKm = km ? Number(km) : null; }, radarInfo: () => rv.info, radarPick, eoInfo: () => ev.info,
    setEoType: t => { ev.type = normCamType(t); ev.lastAt = 0; return ev.type; }, getEoType: () => ev.type,
    eoWheel, eoPinch, eoDrag, eoFollow,   // EO elle kumanda: tekerlek/sıkıştırma zoom, sürükle pan/tilt, takibe dön
    siteStats: () => ({ underlay: rvUnder.state, aux: g3d ? g3d.auxCameras : null, radar: rv.renders, eo: ev.renders, icons: rv.icons.size, threats: tg.items.filter(x => x.it.dyn).length, built: tg.items.filter(x => x.it.dyn && x.root).length }),
    canvas,
    three: T, scene, get homeAlt() { return opts.origin?.alt ?? null; },   // §33 karşılaşma katmanı (halkalar + diğer oyuncular; flightsim_match3d.js) aynı sahneye çizer
    addFrameHook: fn => { frameHooks.add(fn); return () => frameHooks.delete(fn); },   // §17: render sonrası kanca (kayıt birleşimi)
    // §43 grafik kalitesi: setGraphics(resolveGfx çıktısı) canlı uygular · getGraphics() uygulanan + tampon/hat bilgisi · gfxStats() son 1 sn FPS, karenin
    // çizim çağrısı/üçgeni, piksel oranı · setRecordFloor(bool) ekran kaydında piksel oranı tabanı (kayıt çözünürlüğü düşmesin; arka plan kısması yok)
    setGraphics, getGraphics, gfxStats, setRecordFloor: v => { gfxSt.floor = !!v; resize(); }, resolveGfx,
    get gfxCaps() { return { maxSamples: gpipe.maxSamples, maxAniso: renderer.capabilities.getMaxAnisotropy?.() || 1, maxTex: renderer.capabilities.maxTextureSize, halfFloat: gpipe.halfFloat, nativeAA, gpu: gpuName() }; },
  };
}
