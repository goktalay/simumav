// Uçuş Simülatörü — Google Photorealistic 3D Tiles dünya kipi (world.mode = 'google3d'; sözleşme docs/ucus-simulatoru.md §10).
// • Kütüphane: NASA-AMMOS 3d-tiles-renderer (MIT), tek ES modülü static/vendor/three/3DTilesRenderer.js (tools/build-3dtiles.sh);
//   Google karoları Draco sıkıştırmalı → DRACOLoader + static/vendor/three/draco/ (blob: worker; CSP worker-src blob: açık).
// • Anahtar: GET /api/drone/sim/g3d-key (require_module drone.sim, no-store) ya da opts.key (?mock=1: sahte anahtar → hata yolu).
//   Tarayıcı karoları doğrudan https://tile.googleapis.com'dan çeker (GoogleCloudAuthPlugin oturum belirteci); sunucu önbelleklemez (ToS).
// • Koordinat: sahne Z-up ENU (x doğu, y kuzey, z yukarı; merkez 0). Kütüphanenin Ellipsoid.getEastNorthUpFrame(lat, lon, h) matrisi
//   (X doğu, Y kuzey, Z yukarı → ECEF) tersi tiles grubuna uygulanır: ECEF → yerel ENU birebir (enuMatrix; node testi tests/test_g3d_enu.mjs).
//   h = ev irtifası (merkez alt, boşsa açık veri home_elev; Google Elevation API KULLANILMAZ). Karolar elipsoid yüksekliği, ev irtifası MSL
//   olduğundan fark vardır → groundOffset: merkezdeki karo yüzeyi aşağı ışınla ölçülür ve grup z'si kaydırılır (yüzey z = 0); dron
//   kalkmadan (airborne=false) ince LOD geldikçe yenilenir, kalkışta dondurulur.
// • Yükseklik/çarpışma: height(x, y) yüklü karolara aşağı Raycaster (firstHitOnly), 25 m hücreli önbellek; karo yüklenince/boşalınca ve
//   ofset değişince geçersiz. Karo yoksa komşu hücre, o da yoksa 0 (çarpışma denetimi kalkış alanında zaten muaf).
// • Gece/akşam: karo malzemeleri MeshLambertMaterial'a çevrilir (ışık + gölge alır), renk çarpanı (buildReal ile aynı); receiveShadow isteğe bağlı.
// • Atıf (ToS zorunlu): attribution() → tiles.getAttributions() metni ("Google · veri sağlayıcıları") + Google logosu (static/img/google-logo.png).
// Dışa: createGoogleTiles(opts) → Promise<g3d>; enuMatrix(ellipsoid, Matrix4, latDeg, lonDeg, h); G3D_LOGO.

const LIB = '/static/vendor/three/';
const API = '/api/drone/sim';
export const G3D_LOGO = '/static/img/google-logo.png';
const DEG = Math.PI / 180;
const CELL = 25;                 // yükseklik önbelleği hücresi (m)
const RAY_TOP = 20000;           // ışın başlangıç yüksekliği (m)
const POOL = new Map();          // merkez → { tiles, draco, camera, timer, … } (sihirbaz önizlemesi ↔ oturum paylaşımı; kök isteği 1)
const POOL_TTL = 10 * 60 * 1000;

// ECEF → yerel ENU (X doğu, Y kuzey, Z yukarı; (lat, lon, h) noktası orijin). ENU→ECEF çerçevesinin tersi. Saf fonksiyon (node testi).
export function enuMatrix(ellipsoid, Matrix4, latDeg, lonDeg, h) {
  const m = new Matrix4();
  ellipsoid.getEastNorthUpFrame(latDeg * DEG, lonDeg * DEG, Number(h) || 0, m);
  return m.invert();
}

// Kök tileset hatasını kullanıcı diline çevir (kütüphane: 'Failed to load tileset "…" with status 403 : Forbidden')
export function describeError(err) {
  const s = String(err?.message || err || '');
  const m = s.match(/(?:status|code)\s+(\d{3})/i);   // 'with status 403 : Forbidden' ya da 'GoogleCloudAuth: … error code 400'
  if (m) {
    const code = Number(m[1]);
    const why = code === 403 || code === 400 ? 'anahtar geçersiz, Map Tiles API kapalı ya da HTTP referrer kısıtı' : code === 429 ? 'kota aşıldı' : code >= 500 ? 'Google hizmeti yanıt vermiyor' : 'istek reddedildi';
    return `HTTP ${code} (${why})`;
  }
  if (/failed to fetch|networkerror|load failed/i.test(s)) return 'ağ hatası (tile.googleapis.com erişilemedi ya da CSP)';
  return s.replace(/^TilesRenderer:\s*/, '').slice(0, 160) || 'bilinmeyen hata';
}

let _libs = null;
const loadLibs = () => (_libs ??= Promise.all([import(LIB + '3DTilesRenderer.js'), import(LIB + 'DRACOLoader.js')])
  .then(([R, D]) => ({ ...R, DRACOLoader: D.DRACOLoader })).catch(e => { _libs = null; throw e; }));

async function fetchKey(key) {
  if (typeof key === 'function') key = await key();
  if (typeof key === 'string' && key) return key;
  const r = await fetch(`${API}/g3d-key`, { credentials: 'same-origin', cache: 'no-store' });
  if (!r.ok) throw new Error(r.status === 404 ? 'Google 3B kipi sunucuda yapılandırılmamış (GOOGLE_MAPS_API_KEY)' : `anahtar alınamadı (HTTP ${r.status})`);
  const k = (await r.json())?.key;
  if (!k) throw new Error('anahtar boş');
  return k;
}

// Ev irtifası: verilmişse o; yoksa açık veri (sim_terrain /terrain home_elev); alınamazsa 0 (groundOffset yüzeyi yine 0'a oturtur)
async function homeElevation(origin) {
  if (origin.alt != null && Number.isFinite(Number(origin.alt))) return Number(origin.alt);
  try {
    const r = await fetch(`${API}/terrain?lat=${origin.lat}&lon=${origin.lon}&size_m=1000`, { credentials: 'same-origin' });
    if (r.ok) { const j = await r.json(); if (j.home_elev != null) return Number(j.home_elev); }
  } catch { /* ağ yok: 0 */ }
  return 0;
}

/**
 * Google 3B karo dünyası kurar. opts: { T (three), renderer, camera, origin:{lat, lon, alt?}, preview, key?, time, shadows, onProgress, timeoutMs }
 * Kök tileset yüklenince çözülür (anahtar/ağ hatası ya da zaman aşımı → reject; çağıran prosedürele düşer).
 */
export async function createGoogleTiles(opts) {
  const { T, renderer, camera, preview = false } = opts;
  const origin = { lat: Number(opts.origin?.lat) || 0, lon: Number(opts.origin?.lon) || 0, alt: opts.origin?.alt };
  const onProgress = opts.onProgress || null;
  const [{ TilesRenderer, WGS84_ELLIPSOID, GoogleCloudAuthPlugin, GLTFExtensionsPlugin, TileCompressionPlugin, DRACOLoader }, key, homeElev] =
    await Promise.all([loadLibs(), fetchKey(opts.key), homeElevation(origin)]);

  const group = new T.Group();
  group.name = 'google3d';
  // Havuz: aynı merkez için TilesRenderer (kök tileset = ücretli birim) sihirbaz önizlemesi ile oturum ekranı arasında paylaşılır;
  // dispose() örneği askıya alır, POOL_TTL sonra gerçekten atar. three nesneleri WebGL bağlamından bağımsızdır (yeni renderer yeniden yükler).
  const poolKey = `${origin.lat.toFixed(5)},${origin.lon.toFixed(5)}`;
  let entry = POOL.get(poolKey);
  if (entry) {
    clearTimeout(entry.timer); entry.timer = 0;
    if (entry.camera && entry.camera !== camera) entry.tiles.deleteCamera?.(entry.camera);
    if (entry.onLoadModel) entry.tiles.removeEventListener('load-model', entry.onLoadModel);
    if (entry.onDispose) entry.tiles.removeEventListener('dispose-model', entry.onDispose);
    entry.tiles.group.removeFromParent();
  } else {
    const t = new TilesRenderer();   // rootURL eklenti tarafından https://tile.googleapis.com/v1/3dtiles/root.json yapılır
    t.registerPlugin(new GoogleCloudAuthPlugin({ apiToken: key, autoRefreshToken: true, logoUrl: G3D_LOGO }));
    const d = new DRACOLoader();
    d.setDecoderPath(LIB + 'draco/');
    t.registerPlugin(new GLTFExtensionsPlugin({ dracoLoader: d, metadata: false }));
    t.registerPlugin(new TileCompressionPlugin());
    t.maxDepth = Infinity;
    entry = { tiles: t, draco: d, camera: null, timer: 0, onLoadModel: null, onDispose: null, rootRequests: 0 };
    POOL.set(poolKey, entry);
  }
  const { tiles, draco } = entry;
  const reused = !!entry.camera;
  entry.camera = camera;
  tiles.errorTarget = preview ? 36 : 16;      // piksel; küçük = daha ince LOD, daha çok istek
  tiles.lruCache.minBytesSize = (preview ? 80 : 250) * 1e6;
  tiles.lruCache.maxBytesSize = (preview ? 120 : 350) * 1e6;
  tiles.setCamera(camera);
  tiles.setResolutionFromRenderer(camera, renderer);
  // ECEF → ENU: (lat, lon, homeElev) orijin; TilesGroup matrisi decompose ile (matrixAutoUpdate açık)
  enuMatrix(WGS84_ELLIPSOID, T.Matrix4, origin.lat, origin.lon, homeElev).decompose(tiles.group.position, tiles.group.quaternion, tiles.group.scale);
  group.add(tiles.group);

  // ---- malzeme: Lambert (ışık/gece/gölge), gece/akşam renk çarpanı ----
  let time = opts.time || 'day', shadows = !!opts.shadows;
  const tint = () => (time === 'night' ? 0x4c5670 : time === 'dusk' ? 0xe8b898 : 0xffffff);
  const retint = () => tiles.group.traverse(o => { if (o.isMesh && o.userData.g3d) { o.material.color.setHex(tint()); o.receiveShadow = shadows; } });
  const onLoadModel = ({ scene }) => {
    scene.traverse(o => {
      if (!o.isMesh) return;
      const old = o.material;
      // Google glb'lerinde normal yok → Lambert siyah çizer: gölge isteniyorsa normal hesaplanır (Lambert, ışık/gölge alır), yoksa Basic
      // (doku rengi doğrudan; Google dokuları zaten gölgeli; gece/akşam color çarpanı yine çalışır)
      if (shadows) {
        if (!o.geometry.attributes.normal) o.geometry.computeVertexNormals();
        o.material = new T.MeshLambertMaterial({ map: old?.map || null, color: tint(), side: T.FrontSide });
      } else o.material = new T.MeshBasicMaterial({ map: old?.map || null, color: tint(), side: T.FrontSide });
      if (old && old !== o.material) old.dispose?.();   // doku paylaşılır (dispose dokuya dokunmaz); karo boşalınca kütüphane yeni malzemeyi atar
      o.receiveShadow = shadows; o.castShadow = false;
      o.userData.g3d = true;
    });
    hCache.clear();
  };
  const onDisposeModel = () => hCache.clear();
  tiles.addEventListener('load-model', onLoadModel);
  tiles.addEventListener('dispose-model', onDisposeModel);
  entry.onLoadModel = onLoadModel; entry.onDispose = onDisposeModel;

  // ---- yükseklik: aşağı ışın + 25 m hücreli önbellek ----
  const ray = new T.Raycaster(); ray.firstHitOnly = true; ray.far = RAY_TOP * 2;
  const down = new T.Vector3(0, 0, -1), from = new T.Vector3();
  const hCache = new Map();
  const hits = [];
  if (reused) retint();   // havuzdan: yüklü karolar yeni saat/gölge ayarıyla
  const sampleRaw = (x, y) => {   // yüklü karo yüzeyi z'si (sahne koordinatı) ya da null
    if (!tiles.root) return null;
    hits.length = 0;
    from.set(x, y, RAY_TOP);
    ray.set(from, down);
    tiles.raycast(ray, hits);
    if (!hits.length) return null;
    let z = -Infinity;
    for (const h of hits) if (h.point.z > z) z = h.point.z;
    return z;
  };
  const height = (x, y) => {
    const i = Math.round(x / CELL), j = Math.round(y / CELL), k = i * 1048576 + j;
    let v = hCache.get(k);
    if (v !== undefined) return v;
    v = sampleRaw(i * CELL, j * CELL);
    if (v == null) {   // karo yok: komşu bilinen hücre, yoksa 0 (önbelleğe yazılmaz; karo gelince ölçülür)
      for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { const n = hCache.get((i + di) * 1048576 + j + dj); if (n !== undefined) return n; }
      return 0;
    }
    hCache.set(k, v);
    return v;
  };
  // İnce örnekleme (önbelleksiz, tam noktaya ışın): kalkış düzeneğinin 4 temas noktası (±3 m) aynı 25 m hücreye düştüğünden eğim için gerekir (§13);
  // karo yoksa hücre önbelleğine düşer
  const heightFine = (x, y) => { const v = sampleRaw(x, y); return v == null ? height(x, y) : v; };
  const hasSurface = (x, y) => sampleRaw(x, y) != null;   // dronun altında yüklü karo var mı (çarpışma denetimi; yoksa height() komşu/0 verir → güvenilmez)

  // ---- kök tileset yüklemesi (anahtar/ağ hatası → reject); havuzdan gelen örnekte kök zaten yüklü ----
  if (!tiles.root) await new Promise((res, rej) => {
    entry.rootRequests++;
    const to = setTimeout(() => { cleanup(); rej(new Error(`zaman aşımı (${Math.round((opts.timeoutMs || 25000) / 1000)} sn)`)); }, opts.timeoutMs || 25000);
    const onRoot = () => { cleanup(); res(); };
    const onErr = e => { if (e.tile == null) { cleanup(); rej(new Error(describeError(e.error))); } };
    const cleanup = () => { clearTimeout(to); tiles.removeEventListener('load-root-tileset', onRoot); tiles.removeEventListener('load-error', onErr); };
    tiles.addEventListener('load-root-tileset', onRoot);
    tiles.addEventListener('load-error', onErr);
    try { tiles.update(); } catch (err) { cleanup(); rej(err); }   // ilk update kök yüklemesini başlatır
  }).catch(err => { disposeNow(); throw err; });

  // ---- kare güncellemesi: kamera çözünürlüğü, LOD, yer ofseti, ilerleme ----
  let groundOffset = 0, offsetFrozen = false, offsetReported = false, firstOffsetT = 0, lastOffsetT = 0, lastPct = -1, disposed = false;
  function update(cam, airborne = false, now = performance.now()) {
    if (disposed) return;
    if (cam && cam !== camera) { tiles.deleteCamera?.(camera); tiles.setCamera(cam); }
    tiles.setResolutionFromRenderer(cam || camera, renderer);
    tiles.update();
    // Yer ofseti: merkezdeki karo yüzeyi z = 0 olsun; kalkışa dek her 400 ms yenilenir (ince LOD), kalkışta dondurulur
    if (airborne) offsetFrozen = true;
    if (!offsetFrozen && now - lastOffsetT > 400 && tiles.visibleTiles.size) {
      lastOffsetT = now;
      group.updateMatrixWorld(true);
      const z = sampleRaw(0, 0);
      if (z != null && Math.abs(z) > 0.02) {
        group.position.z -= z; groundOffset -= z; group.updateMatrixWorld(true); hCache.clear();
        if (!firstOffsetT) firstOffsetT = now;
      }
      // Olay şeridine TOPLAM ofset: ilk ölçüm kaba kök karodadır (Ankara'da −1204 m görüldü) ve yanıltır; karolar dolunca ya da ilk düzeltmeden
      // 3 sn sonra (ince LOD oturmuş) bir kez yazılır
      if (!offsetReported && firstOffsetT && (tiles.loadProgress >= 0.99 || now - firstOffsetT > 3000)) { offsetReported = true; onProgress?.({ stage: 'g3d-ground', offset: groundOffset }); }
    }
    const pct = Math.round(tiles.loadProgress * 100);
    if (pct !== lastPct) { lastPct = pct; onProgress?.({ stage: 'g3d', pct }); }
  }

  const attribution = () => {
    const parts = [];
    for (const a of tiles.getAttributions()) if (a.type === 'string' && a.value) parts.push(...String(a.value).split(/;/g).map(s => s.trim()).filter(Boolean));
    const set = [...new Set(parts)];
    if (!set.length || !/google/i.test(set.join(' '))) set.unshift('Google');
    return { text: set.join(' · '), logo: G3D_LOGO, loading: Math.round(tiles.loadProgress * 100) };
  };

  // Askıya al: karolar havuzda kalır (aynı merkezde oturum ekranı yeni kök isteği yapmaz); POOL_TTL sonra gerçekten atılır
  function disposeNow() {
    tiles.removeEventListener('load-model', onLoadModel); tiles.removeEventListener('dispose-model', onDisposeModel);
    tiles.dispose(); draco.dispose(); POOL.delete(poolKey);
  }
  function dispose() {
    if (disposed) return;
    disposed = true;
    hCache.clear();
    tiles.group.removeFromParent();
    group.removeFromParent();
    entry.timer = setTimeout(disposeNow, POOL_TTL);
  }

  return {
    group, tiles, height, heightFine, hasSurface, update, attribution, dispose,
    get rootRequests() { return entry.rootRequests; },
    setTime(t) { time = t || 'day'; retint(); },
    setShadows(v) { shadows = !!v; retint(); },
    get homeElev() { return homeElev; }, get groundOffset() { return groundOffset; }, get loading() { return Math.round(tiles.loadProgress * 100); },
    get stats() { return { visible: tiles.visibleTiles.size, bytes: tiles.lruCache.cachedBytes }; },
  };
}
