// Uçuş Simülatörü — gerçekçi dünya katmanı (three.js r170; flightsim3d.js içinden, TEK WebGL bağlamı). docs/ucus-simulatoru.md §31.
// Saf kurallar ./flightsim_weather.js'te (hava ön ayarları, rüzgâr bileşenleri, esinti, tulum, akış çizgileri). Burada yalnız çizim:
// • Gökyüzü kubbesi (analitik fiziksel yaklaşım: ufuk/zenit gradyanı, güneş diski + Mie parıltısı, saat ön ayarına göre güneş konumu, gece yıldız + ay,
//   bulutlulukta kapalı gök, fırtınada şimşek) — sis rengi ufuk rengine eşlenir (dikişsiz atmosferik saçılım).
// • Bulut katmanı (gürültü gölgelendiricisi; örtü havaya göre, rüzgârla kayar, güneşe göre gölgeli, uzakta söner).
// • Zemin malzemesi (MeshStandard + onBeforeCompile): prosedürelde yükseklik/eğime göre çim (2 ton) / toprak / kaya / kar / kum karışımı,
//   prosedürel ayrıntı dokusu + normal haritası (iki ölçek, uzakta söner); gerçek arazide uydu dokusu üstüne ayrıntı + normal. Hava: kar örtüsü
//   (düz yüzeyler beyazlar), ıslaklık (koyulaşma + parlama).
// • Su (gölgelendirici): Fresnel gökyüzü yansıması, hareketli dalga normali, güneş parlaması, yağmurda halka dalgacıkları.
// • Ağaçlar: iki tür (iğne yapraklı katmanlı koniler / geniş yapraklı topak taç), parçalara bölünmüş InstancedMesh (parça başına frustum culling),
//   mesafeye göre LOD (yakın 3B model, uzak çapraz düzlem "impostor"), rüzgârda tepe salınımı (köşe gölgelendiricisi).
// • Binalar: kasaba ızgarası (sokak + kaldırım şeritleri araziye serilir), türler (müstakil ev + beşik çatı, apartman + çatı üniteleri, kule
//   cam cephe), pencere dokusu gölgelendiricide (kat/bölme), gece rastgele ışıklı pencereler. OSM binalarında da aynı cephe gölgelendiricisi.
// • Yağış: kameraya bağlı hacimde GPU parçacıkları (yağmur çizgileri / kar taneleri; rüzgârla sürüklenir), FPV/gimbal'da mercek damlaları (DOM).
// • Rüzgâr tulumu (yöne döner, hızla şişer, dalgalanır) ve uçak çevresinde rüzgâr akış çizgileri (aç/kapa).
const DEG = Math.PI / 180;
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

// ---------- ortak GLSL ----------
export const GLSL_NOISE = `
float wfxHash(vec2 p){ p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float wfxNoise(vec2 p){ vec2 i = floor(p), f = fract(p); vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(wfxHash(i), wfxHash(i + vec2(1.0, 0.0)), u.x), mix(wfxHash(i + vec2(0.0, 1.0)), wfxHash(i + vec2(1.0, 1.0)), u.x), u.y); }
float wfxFbm(vec2 p){ float a = 0.5, s = 0.0; for (int i = 0; i < 4; i++) { s += a * wfxNoise(p); p = p * 2.03 + 17.1; a *= 0.5; } return s / 0.9375; }
`;

// ---------- prosedürel dokular (bir kez; canvas → CanvasTexture) ----------
function valueNoiseCanvas(size, seed, octaves, fn) {
  // tekrarlanabilir (tileable) değer gürültüsü: periyodik ızgara
  let s = seed >>> 0 || 1;
  const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
  const layers = [];
  for (let o = 0; o < octaves; o++) { const n = 4 << o; const g = new Float32Array(n * n); for (let i = 0; i < g.length; i++) g[i] = rnd(); layers.push({ n, g }); }
  const out = new Float32Array(size * size);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    let v = 0, a = 0.5, tot = 0;
    for (const { n, g } of layers) {
      const fx = x / size * n, fy = y / size * n, ix = Math.floor(fx), iy = Math.floor(fy), ux = fx - ix, uy = fy - iy;
      const sx = ux * ux * (3 - 2 * ux), sy = uy * uy * (3 - 2 * uy);
      const i0 = ix % n, i1 = (ix + 1) % n, j0 = iy % n, j1 = (iy + 1) % n;
      const val = (g[j0 * n + i0] * (1 - sx) + g[j0 * n + i1] * sx) * (1 - sy) + (g[j1 * n + i0] * (1 - sx) + g[j1 * n + i1] * sx) * sy;
      v += val * a; tot += a; a *= 0.55;
    }
    out[y * size + x] = fn ? fn(v / tot, x, y, rnd) : v / tot;
  }
  return out;
}
export function createGroundTextures(T, renderer) {
  const N = 256;
  // R: çim ayrıntısı (ince benekli), G: kaya (çatlaklı), B: toprak, A: yükseklik (normal haritası için)
  const grass = valueNoiseCanvas(N, 11, 6, (v, x, y, r) => clamp(v * 0.7 + r() * 0.3, 0, 1));
  const rock = valueNoiseCanvas(N, 23, 6, v => { const c = Math.abs(v - 0.5) * 2; return clamp(0.35 + v * 0.5 + (c < 0.06 ? -0.3 : 0), 0, 1); });
  const dirt = valueNoiseCanvas(N, 37, 5, (v, x, y, r) => clamp(v * 0.8 + r() * 0.2, 0, 1));
  const cv = document.createElement('canvas'); cv.width = cv.height = N;
  const g = cv.getContext('2d'), im = g.createImageData(N, N);
  const hgt = new Float32Array(N * N);
  for (let i = 0; i < N * N; i++) {
    hgt[i] = grass[i] * 0.35 + rock[i] * 0.45 + dirt[i] * 0.2;
    im.data[i * 4] = grass[i] * 255; im.data[i * 4 + 1] = rock[i] * 255; im.data[i * 4 + 2] = dirt[i] * 255; im.data[i * 4 + 3] = 255;
  }
  g.putImageData(im, 0, 0);
  const cn = document.createElement('canvas'); cn.width = cn.height = N;
  const gn = cn.getContext('2d'), imn = gn.createImageData(N, N);
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const hx = hgt[y * N + (x + 1) % N] - hgt[y * N + (x + N - 1) % N], hy = hgt[((y + 1) % N) * N + x] - hgt[((y + N - 1) % N) * N + x];
    let nx = -hx * 3.2, ny = hy * 3.2, nz = 1; const l = Math.hypot(nx, ny, nz); nx /= l; ny /= l; nz /= l;
    const i = (y * N + x) * 4; imn.data[i] = (nx * 0.5 + 0.5) * 255; imn.data[i + 1] = (ny * 0.5 + 0.5) * 255; imn.data[i + 2] = (nz * 0.5 + 0.5) * 255; imn.data[i + 3] = 255;
  }
  gn.putImageData(imn, 0, 0);
  const mk = (c, color) => { const t = new T.CanvasTexture(c); t.wrapS = t.wrapT = T.RepeatWrapping; t.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy?.() || 1); if (color) t.colorSpace = T.NoColorSpace; t.generateMipmaps = true; t.minFilter = T.LinearMipmapLinearFilter; return t; };
  return { detail: mk(cv), normal: mk(cn) };
}
// Ağaç impostor atlası: sol yarı iğne yapraklı, sağ yarı geniş yapraklı (saydam arka plan)
function treeAtlas(T) {
  const W = 256, H = 256, cv = document.createElement('canvas'); cv.width = W; cv.height = H;
  const g = cv.getContext('2d');
  g.clearRect(0, 0, W, H);
  // iğne yapraklı (x 0..128)
  g.fillStyle = '#4a3523'; g.fillRect(60, 200, 8, 56);
  for (let k = 0; k < 4; k++) {
    const y0 = 215 - k * 52, w = 58 - k * 12;
    const gr = g.createLinearGradient(64 - w, 0, 64 + w, 0); gr.addColorStop(0, '#16351c'); gr.addColorStop(0.55, '#2c5a2c'); gr.addColorStop(1, '#173a1e');
    g.fillStyle = gr; g.beginPath(); g.moveTo(64, y0 - 92); g.lineTo(64 + w, y0); g.lineTo(64 - w, y0); g.closePath(); g.fill();
  }
  // geniş yapraklı (x 128..256)
  g.fillStyle = '#4f3a26'; g.fillRect(186, 170, 12, 86);
  for (const [x, y, r, c] of [[192, 120, 56, '#2f5d27'], [160, 140, 40, '#2a5523'], [222, 138, 42, '#346a2b'], [190, 82, 42, '#3c742f'], [172, 100, 30, '#356a2a'], [214, 96, 32, '#2c5b25']]) {
    const gr = g.createRadialGradient(x - r * 0.3, y - r * 0.35, r * 0.1, x, y, r); gr.addColorStop(0, '#5a8f3e'); gr.addColorStop(0.6, c); gr.addColorStop(1, '#1d3d19');
    g.fillStyle = gr; g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill();
  }
  const t = new T.CanvasTexture(cv); t.colorSpace = T.SRGBColorSpace; t.generateMipmaps = true; t.minFilter = T.LinearMipmapLinearFilter;
  return t;
}

// ---------- geometri yardımcıları ----------
function mergeGeos(T, geos) {
  const parts = geos.map(g => (g.index ? g.toNonIndexed() : g));
  let n = 0; for (const p of parts) n += p.attributes.position.count;
  const pos = new Float32Array(n * 3), nor = new Float32Array(n * 3), col = new Float32Array(n * 3), uv = new Float32Array(n * 2);
  let o = 0;
  for (const p of parts) {
    const c = p.attributes.position.count;
    pos.set(p.attributes.position.array, o * 3);
    if (p.attributes.normal) nor.set(p.attributes.normal.array, o * 3);
    if (p.attributes.color) col.set(p.attributes.color.array, o * 3); else col.fill(1, o * 3, (o + c) * 3);
    if (p.attributes.uv) uv.set(p.attributes.uv.array, o * 2);
    o += c;
  }
  const out = new T.BufferGeometry();
  out.setAttribute('position', new T.BufferAttribute(pos, 3)); out.setAttribute('normal', new T.BufferAttribute(nor, 3));
  out.setAttribute('color', new T.BufferAttribute(col, 3)); out.setAttribute('uv', new T.BufferAttribute(uv, 2));
  return out;
}
const paint = (T, geo, fn) => {   // köşe rengi: fn(x, y, z, nx, ny, nz) → [r, g, b] (sRGB 0..1; doğrusal uzaya çevrilir)
  const g = geo.index ? geo.toNonIndexed() : geo, p = g.attributes.position, nr = g.attributes.normal, c = new Float32Array(p.count * 3), col = new T.Color();
  for (let i = 0; i < p.count; i++) { const [r, gg, b] = fn(p.getX(i), p.getY(i), p.getZ(i), nr.getX(i), nr.getY(i), nr.getZ(i)); col.setRGB(r, gg, b, T.SRGBColorSpace); c[i * 3] = col.r; c[i * 3 + 1] = col.g; c[i * 3 + 2] = col.b; }
  g.setAttribute('color', new T.BufferAttribute(c, 3));
  return g;
};
// İğne yapraklı (birim yükseklik ≈ 1): gövde + 3 katmanlı koni; tabanda koyu (sahte ortam kapatması), uçlarda açık
function coniferGeo(T) {
  const trunk = paint(T, new T.CylinderGeometry(0.035, 0.05, 0.3, 6).rotateX(Math.PI / 2).translate(0, 0, 0.15), () => [0.29, 0.2, 0.13]);
  const layers = [[0.36, 0.42, 0.16], [0.28, 0.38, 0.38], [0.19, 0.34, 0.6]].map(([r, hh, z], k) => paint(T, new T.ConeGeometry(r, hh, 9, 2, true).rotateX(Math.PI / 2).translate(0, 0, z + hh / 2), (x, y, zz) => {
    const t = clamp((zz - z) / hh, 0, 1), rad = Math.hypot(x, y) / r;
    const s = 0.55 + 0.45 * t + 0.12 * rad + k * 0.05;
    return [0.1 * s, 0.24 * s, 0.12 * s];
  }));
  return mergeGeos(T, [trunk, ...layers]);
}
// Geniş yapraklı: gövde + 4 topak (hafif bozulmuş ikosahedron)
function broadleafGeo(T) {
  const trunk = paint(T, new T.CylinderGeometry(0.04, 0.065, 0.5, 6).rotateX(Math.PI / 2).translate(0, 0, 0.25), () => [0.31, 0.23, 0.15]);
  const blobs = [[0, 0, 0.64, 0.31], [0.16, 0.06, 0.55, 0.22], [-0.14, -0.08, 0.6, 0.22]].map(([x, y, z, r], k) => {
    const g = new T.IcosahedronGeometry(r, 1); const p = g.attributes.position;
    for (let i = 0; i < p.count; i++) { const f = 1 + 0.12 * Math.sin(p.getX(i) * 31 + k) * Math.cos(p.getY(i) * 27 + p.getZ(i) * 13); p.setXYZ(i, p.getX(i) * f, p.getY(i) * f, p.getZ(i) * f * 0.9); }
    g.computeVertexNormals(); g.translate(x, y, z);
    return paint(T, g, (vx, vy, vz, nx, ny, nz) => { const s = 0.62 + 0.38 * clamp(nz * 0.5 + 0.5, 0, 1); return [0.16 * s, 0.32 * s, 0.11 * s]; });
  });
  return mergeGeos(T, [trunk, ...blobs]);
}
// Çapraz düzlem impostor (birim yükseklik); uv.x 0..0.5 (tür 0) — tür 1 için mesh ayrı (uv kaydırma)
function crossQuadGeo(T, half) {
  const mk = rot => { const g = new T.PlaneGeometry(0.9, 1.05).rotateX(Math.PI / 2).translate(0, 0, 0.5); g.rotateZ(rot); const uv = g.attributes.uv; for (let i = 0; i < uv.count; i++) uv.setX(i, uv.getX(i) * 0.5 + (half ? 0.5 : 0)); return g; };
  return mergeGeos(T, [mk(0), mk(Math.PI / 2)]);
}
// Beşik çatı prizması (taban [-.5,.5]², z 0..1, mahya y boyunca)
function gableGeo(T) {
  const v = [-0.5, -0.5, 0, 0.5, -0.5, 0, 0, -0.5, 1, -0.5, 0.5, 0, 0, 0.5, 1, 0.5, 0.5, 0];
  const P = i => [v[i * 3], v[i * 3 + 1], v[i * 3 + 2]];
  const tris = [[0, 1, 2], [3, 4, 5], [0, 2, 4], [0, 4, 3], [1, 5, 4], [1, 4, 2]];   // ön/arka üçgen, sol/sağ eğim
  const pos = [];
  for (const t of tris) for (const i of t) pos.push(...P(i));
  const g = new T.BufferGeometry(); g.setAttribute('position', new T.Float32BufferAttribute(pos, 3)); g.computeVertexNormals();
  return g;
}

// ---------- gölgelendirici enjeksiyonları ----------
// Zemin (prosedürel / uydu): MeshStandardMaterial'a ayrıntı + karışım + hava (kar örtüsü, ıslaklık)
export function patchGround(material, U, { satellite = false } = {}) {
  material.onBeforeCompile = sh => {
    Object.assign(sh.uniforms, { uDetail: U.detail, uDetailN: U.detailN, uGrassA: U.grassA, uGrassB: U.grassB, uDirt: U.dirt, uRock: U.rock, uSnow: U.snow, uSand: U.sand,
      uWet: U.wet, uSnowCover: U.snowCover, uSnowLine: U.snowLine, uWaterZ: U.waterZ, uRelH: U.relH });
    sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nvarying vec3 vWfxPos; varying vec3 vWfxN;')
      .replace('#include <project_vertex>', '#include <project_vertex>\nvWfxPos = (modelMatrix * vec4(transformed, 1.0)).xyz; vWfxN = normalize(mat3(modelMatrix) * objectNormal);');
    sh.fragmentShader = sh.fragmentShader.replace('#include <common>', `#include <common>
varying vec3 vWfxPos; varying vec3 vWfxN;
uniform sampler2D uDetail; uniform sampler2D uDetailN;
uniform vec3 uGrassA, uGrassB, uDirt, uRock, uSnow, uSand;
uniform float uWet, uSnowCover, uSnowLine, uWaterZ, uRelH;
float wfxWetK = 0.0;
${GLSL_NOISE}`).replace('#include <map_fragment>', `#include <map_fragment>
{
  vec2 wp = vWfxPos.xy;
  vec3 nW = normalize(vWfxN);
  float slope = 1.0 - nW.z;
  vec4 d1 = texture2D(uDetail, wp / 7.5);
  vec4 d2 = texture2D(uDetail, wp / 31.0 + vec2(0.37, 0.71));
  float macro = wfxFbm(wp / 380.0);
  float camD = length(vWfxPos - cameraPosition);
  float fadeD = 1.0 - smoothstep(250.0, 2200.0, camD);
  ${satellite ? `
  diffuseColor.rgb *= mix(1.0, 0.78 + 0.44 * (d1.r * 0.55 + d2.g * 0.45), fadeD);` : `
  float h = vWfxPos.z;
  float meso = wfxFbm(wp / 64.0 + 11.3);
  vec3 grass = mix(uGrassA, uGrassB, smoothstep(0.3, 0.7, macro * 0.65 + meso * 0.35)) * (0.82 + 0.36 * mix(0.5, d1.r * 0.6 + d2.r * 0.4, 0.35 + 0.65 * fadeD));
  grass *= 0.86 + 0.28 * smoothstep(0.25, 0.75, meso);   // çayır lekeleri (açık/koyu)
  vec3 dirt = uDirt * (0.78 + 0.44 * d2.b);
  float strata = 0.5 + 0.5 * sin(h * 0.33 + wfxNoise(wp / 45.0) * 6.0);   // kaya katmanlanması (yatay şeritler)
  vec3 rock = uRock * (0.55 + 0.6 * mix(d1.g, d2.g, 0.5)) * (0.82 + 0.3 * strata);
  rock = mix(rock, uDirt * 0.85, 0.3 * (1.0 - strata) * (1.0 - smoothstep(0.55, 0.8, slope)));
  float dirtW = smoothstep(0.56, 0.74, wfxFbm(wp / 95.0 + 3.1)) * (1.0 - smoothstep(0.3, 0.55, slope));
  vec3 c = mix(grass, dirt, dirtW * 0.85);
  float rockW = smoothstep(0.24, 0.46, slope + (d2.g - 0.5) * 0.18);
  rockW = max(rockW, smoothstep(uRelH * 0.5, uRelH * 0.78, h + (macro - 0.5) * uRelH * 0.25) * 0.85);
  c = mix(c, rock, clamp(rockW, 0.0, 1.0));
  float snowNat = smoothstep(uSnowLine - 35.0, uSnowLine + 35.0, h + (macro - 0.5) * 140.0) * (1.0 - smoothstep(0.42, 0.7, slope));
  c = mix(c, uSnow * (0.9 + 0.1 * d1.r), snowNat);
  float sandW = 1.0 - smoothstep(uWaterZ + 0.25, uWaterZ + 1.3, h);
  c = mix(c, uSand * (0.85 + 0.3 * d2.b), sandW);
  diffuseColor.rgb = c;`}
  float sc = uSnowCover * smoothstep(0.42, 0.72, nW.z) * smoothstep(0.2, 0.5, wfxFbm(wp / 55.0) * 0.6 + uSnowCover * 0.5);
  diffuseColor.rgb = mix(diffuseColor.rgb, uSnow * (0.9 + 0.1 * d1.r), clamp(sc, 0.0, 1.0));
  wfxWetK = uWet * (1.0 - clamp(sc, 0.0, 1.0));
  diffuseColor.rgb *= mix(1.0, 0.56, wfxWetK);
}`).replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor = mix(roughnessFactor, 0.22, wfxWetK);')
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
{
  vec3 tn = texture2D(uDetailN, vWfxPos.xy / 7.5).xyz * 2.0 - 1.0;
  vec3 tn2 = texture2D(uDetailN, vWfxPos.xy / 31.0 + vec2(0.37, 0.71)).xyz * 2.0 - 1.0;
  float fadeN = 1.0 - smoothstep(120.0, 1400.0, length(vWfxPos - cameraPosition));
  vec3 nw = normalize(normalize(vWfxN) + vec3((tn.xy * 0.55 + tn2.xy * 0.45) * ${satellite ? '0.45' : '0.7'} * fadeN, 0.0));
  normal = normalize((viewMatrix * vec4(nw, 0.0)).xyz);
}`);
  };
  material.customProgramCacheKey = () => `wfx-ground-${satellite ? 'sat' : 'proc'}`;
  return material;
}
// Ağaç salınımı: instanceMatrix sonrası dünya uzayında tepe yer değiştirmesi (yükseklik²), rüzgâr yönünde + küçük daire
export function patchSway(material, U, key = 'tree') {
  material.onBeforeCompile = sh => {
    Object.assign(sh.uniforms, { uTime: U.time, uWindDir: U.windDir, uWindMs: U.windMs });
    sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nuniform float uTime; uniform vec2 uWindDir; uniform float uWindMs;')
      .replace('#include <project_vertex>', `
vec4 mvPosition = vec4(transformed, 1.0);
#ifdef USE_INSTANCING
  mvPosition = instanceMatrix * mvPosition;
  vec3 ip = instanceMatrix[3].xyz; float th = length(instanceMatrix[2].xyz);
#else
  vec3 ip = vec3(0.0); float th = 1.0;
#endif
{
  float hg = clamp(transformed.z, 0.0, 1.2);
  float ph = uTime * (1.2 + 0.5 * fract(ip.x * 0.0131)) + ip.x * 0.05 + ip.y * 0.071;
  float amp = (0.004 + uWindMs * 0.0028) * th * hg * hg;
  mvPosition.xy += uWindDir * amp * (0.65 + 0.35 * sin(ph)) + vec2(sin(ph * 1.7), cos(ph * 1.31)) * amp * 0.22;
}
mvPosition = modelViewMatrix * mvPosition;
gl_Position = projectionMatrix * mvPosition;`);
  };
  material.customProgramCacheKey = () => `wfx-sway-${key}`;
  return material;
}
// Bina cephesi: pencere ızgarası (kat/bölme), cam yansıması, gece ışıklı pencereler. Kaynak: instancing (birim kutu + ölçek) ya da öznitelik
// (OSM: aFac = (u m, v m, çatı 0/1), aBld = (tür, tohum)). Tür: 0 ev, 1 apartman, 2 kule (cam cephe), 3 sanayi
export function patchFacade(material, U, { instanced = true } = {}) {
  material.onBeforeCompile = sh => {
    Object.assign(sh.uniforms, { uNight: U.night, uGlass: U.glass, uLitCol: U.litCol, uWet: U.wet });
    const vHead = instanced ? 'attribute vec4 aBld;' : 'attribute vec3 aFac; attribute vec3 aBld;';
    const vBody = instanced ? `
  vec3 sc = vec3(length(instanceMatrix[0].xyz), length(instanceMatrix[1].xyz), length(instanceMatrix[2].xyz));
  vFacN = normal;
  vFac = vec3(abs(normal.x) > 0.5 ? position.y * sc.y : position.x * sc.x, position.z * sc.z, normal.z > 0.5 ? 1.0 : 0.0);
  vBld = aBld; vFacH = sc.z;` : `
  vFacN = normal; vFac = aFac; vBld = vec4(aBld.x, aBld.y, 3.1, 0.35); vFacH = aBld.z;`;
    sh.vertexShader = sh.vertexShader.replace('#include <common>', `#include <common>\n${vHead}\nvarying vec3 vFac; varying vec4 vBld; varying vec3 vFacN; varying float vFacH;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>\n${vBody}`);
    sh.fragmentShader = sh.fragmentShader.replace('#include <common>', `#include <common>
varying vec3 vFac; varying vec4 vBld; varying vec3 vFacN; varying float vFacH;
uniform float uNight, uWet; uniform vec3 uGlass, uLitCol;
float wfxWin = 0.0; vec3 wfxEmit = vec3(0.0);
float bHash(vec2 p){ p = fract(p * vec2(233.34, 851.73)); p += dot(p, p + 23.45); return fract(p.x * p.y); }`)
      .replace('#include <color_fragment>', `#include <color_fragment>
{
  float kind = vBld.x, seed = vBld.y, flH = max(2.6, vBld.z);
  if (vFac.z > 0.5) {   // çatı: çakıl/membran
    diffuseColor.rgb *= 0.55 + 0.12 * bHash(floor(vFac.xy * 2.0) + seed);
  } else {
    float bay = kind < 0.5 ? 3.4 : kind < 1.5 ? 3.0 : kind < 2.5 ? 1.8 : 6.0;
    float u = vFac.x / bay, v = vFac.y / flH;
    vec2 cell = floor(vec2(u, v)); vec2 f = fract(vec2(u, v));
    float wx = kind < 1.5 ? 0.24 : kind < 2.5 ? 0.06 : 0.12, wy0 = kind < 2.5 ? 0.3 : 0.45, wy1 = kind < 2.5 ? 0.82 : 0.86;
    float w = step(wx, f.x) * step(f.x, 1.0 - wx) * step(wy0, f.y) * step(f.y, wy1);
    w *= step(0.6, v);                                        // zemin kat bandı (kapı/vitrin ayrı değil; sade)
    if (kind > 2.5) w *= step(0.5, bHash(cell * 0.37 + seed)); // sanayi: seyrek
    float top = smoothstep(vFacH - 0.6, vFacH - 0.1, vFac.y);  // korniş
    vec3 wall = diffuseColor.rgb * (0.86 + 0.14 * bHash(cell + seed * 3.1)) * (1.0 - 0.22 * (1.0 - smoothstep(0.0, 2.5, vFac.y)));
    wall = mix(wall, wall * 0.7, top);
    float lit = step(bHash(cell + seed * 7.7), vBld.w) * w;
    vec3 glass = uGlass * (0.7 + 0.5 * bHash(cell * 1.7 + seed));
    diffuseColor.rgb = mix(wall, glass, w);
    wfxWin = w;
    wfxEmit = uLitCol * lit * uNight * (0.6 + 0.6 * bHash(cell * 2.3 + seed));
  }
}`).replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor = mix(mix(roughnessFactor, 0.45, uWet * 0.6), 0.12, wfxWin);')
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += wfxEmit;');
  };
  material.customProgramCacheKey = () => `wfx-facade-${instanced ? 'i' : 'a'}`;
  return material;
}

// ---------- gökyüzü ----------
const SKY_VERT = `varying vec3 vDir; void main(){ vDir = position; vec4 p = modelViewMatrix * vec4(position, 1.0); gl_Position = projectionMatrix * p; gl_Position.z = gl_Position.w * 0.99999; }`;
const SKY_FRAG = `uniform vec3 uSunDir, uZenith, uHorizon, uGround, uSunCol, uOvercast; uniform float uCloud, uNight, uFlash;
varying vec3 vDir;
void main(){
  vec3 d = normalize(vDir);
  float e = d.z;
  float t = pow(clamp(e, 0.0, 1.0), 0.42);
  vec3 c = mix(uHorizon, uZenith, t);
  c = mix(c, uGround, smoothstep(0.0, -0.12, e));
  float sd = max(dot(d, normalize(uSunDir)), 0.0);
  float vis = 1.0 - uCloud * 0.9;
  c += uSunCol * (pow(sd, 5.0) * 0.16 + pow(sd, 48.0) * 0.32) * vis * (1.0 - uNight * 0.7);
  c += uSunCol * smoothstep(${Math.cos(0.55 * DEG).toFixed(6)}, ${Math.cos(0.4 * DEG).toFixed(6)}, sd) * mix(5.0, 1.4, uNight) * vis;
  c = mix(c, uOvercast * (0.82 + 0.25 * t), uCloud * 0.72);
  if (uNight > 0.5 && e > 0.0) { vec3 q = floor(d * 380.0); float s = fract(sin(dot(q, vec3(12.9898, 78.233, 37.719))) * 43758.5453);
    c += vec3(step(0.9982, s)) * 0.8 * (1.0 - uCloud) * smoothstep(0.02, 0.25, e); }
  c += uFlash * vec3(0.55, 0.6, 0.75);
  gl_FragColor = vec4(c, 1.0);
  #include <colorspace_fragment>
}`;
// ---------- bulut katmanı ----------
const CLOUD_VERT = `varying vec3 vW;
void main(){ vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }`;
const CLOUD_FRAG = `uniform float uCover, uTime, uFar, uNight; uniform vec2 uWind; uniform vec3 uSunDir, uLight, uShade, uFogCol;
varying vec3 vW;
${GLSL_NOISE}
void main(){
  vec2 p = (vW.xy + uWind * uTime) / 2400.0;
  float n = wfxFbm(p) * 0.7 + wfxFbm(p * 3.1 + 7.7) * 0.3;
  float th = 1.0 - uCover;
  float dens = smoothstep(th - 0.12, th + 0.22, n);
  if (dens < 0.01) discard;
  float n2 = wfxFbm(p + normalize(uSunDir.xy + 1e-4) * 0.035) * 0.7 + wfxFbm((p + normalize(uSunDir.xy + 1e-4) * 0.035) * 3.1 + 7.7) * 0.3;
  float lit = clamp(0.62 + (n - n2) * 3.2, 0.0, 1.0);
  vec3 col = mix(uShade, uLight, lit * (1.0 - 0.45 * dens * uCover));
  float dist = length(vW.xy - cameraPosition.xy);
  float fade = 1.0 - smoothstep(uFar * 0.45, uFar, dist);
  col = mix(col, uFogCol, smoothstep(uFar * 0.2, uFar, dist) * 0.85);
  float near = smoothstep(4.0, 60.0, abs(cameraPosition.z - vW.z));   // katman içinden geçerken ani perde olmasın
  gl_FragColor = vec4(col, dens * fade * near * 0.95);
  #include <colorspace_fragment>
}`;
// ---------- su ----------
const WATER_VERT = `varying vec3 vW;
#include <fog_pars_vertex>
void main(){ vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz; vec4 mvPosition = viewMatrix * w; gl_Position = projectionMatrix * mvPosition;
#include <fog_vertex>
}`;
const WATER_FRAG = `uniform float uTime, uRain, uNight, uWQ; uniform vec3 uSky, uZenith, uSunDir, uSunCol, uDeep;
varying vec3 vW;
#include <fog_pars_fragment>
${GLSL_NOISE}
// §43 su kalitesi uWQ: 0 basit (iki oktav, yağmur halkası yok), 1 normal (üç oktav), 2 ayrıntılı (dördüncü ince oktav, daha uzağa dek dalga)
float wh(vec2 p){
  float h = wfxNoise(p * 0.045 + uTime * vec2(0.03, 0.018)) + 0.45 * wfxNoise(p * 0.12 - uTime * vec2(0.02, 0.045));
  if (uWQ > 0.5) h += 0.2 * wfxNoise(p * 0.31 + uTime * vec2(0.06, -0.035));
  if (uWQ > 1.5) h += 0.09 * wfxNoise(p * 0.83 - uTime * vec2(0.11, 0.07));
  return h;
}
void main(){
  vec2 p = vW.xy;
  float h0 = wh(p), hx = wh(p + vec2(1.2, 0.0)), hy = wh(p + vec2(0.0, 1.2));
  float dk = 1.0 - smoothstep(60.0, uWQ > 1.5 ? 3000.0 : 1500.0, length(cameraPosition - vW));   // uzakta düzleşir (piksel altı dalga parıltısı yok)
  vec3 n = normalize(vec3((h0 - hx) * 0.9 * dk, (h0 - hy) * 0.9 * dk, 1.0));
  if (uRain > 0.0 && uWQ > 0.5) {   // yağmur: halka dalgacıkları
    vec2 g = floor(p / 1.6); vec2 f = fract(p / 1.6) - 0.5;
    float r = fract(uTime * 0.9 + wfxHash(g) * 7.0);
    float ring = sin(clamp((length(f) - r * 0.5) * 40.0, -3.14, 3.14)) * (1.0 - r) * step(abs(length(f) - r * 0.5), 0.08);
    n = normalize(n + vec3(f * ring * 0.9 * uRain, 0.0));
  }
  vec3 V = normalize(cameraPosition - vW);
  float fres = 0.02 + 0.98 * pow(1.0 - max(dot(n, V), 0.0), 5.0);
  vec3 R = reflect(-V, n);
  vec3 skyc = mix(uSky, uZenith, pow(clamp(R.z, 0.0, 1.0), 0.5));
  vec3 col = mix(uDeep, skyc, clamp(fres, 0.0, 1.0));
  float spec = pow(max(dot(R, normalize(uSunDir)), 0.0), 180.0);
  col += uSunCol * spec * mix(1.6, 0.4, uNight);
  gl_FragColor = vec4(col, 0.9);
  #include <colorspace_fragment>
  #include <fog_fragment>
}`;
// ---------- yağış ----------
const PRECIP_VERT = `uniform vec3 uCam; uniform float uTime, uBox, uFall, uLen, uPx, uSnow; uniform vec2 uWind;
attribute float aEnd; attribute float aSeed; varying float vA;
void main(){
  vec3 vel = vec3(uWind, -uFall * (0.8 + 0.4 * aSeed));
  vec3 p = position * uBox + vel * uTime;
  if (uSnow > 0.5) p.xy += vec2(sin(uTime * 0.9 + aSeed * 6.283), cos(uTime * 0.7 + aSeed * 4.1)) * 0.6;
  vec3 o = uCam - uBox * 0.5;
  p = mod(p - o, uBox) + o;
  p -= normalize(vel) * uLen * aEnd;
  vA = (1.0 - smoothstep(uBox * 0.28, uBox * 0.5, distance(p, uCam))) * (0.35 + 0.65 * aSeed) * (1.0 - aEnd * 0.7);
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_PointSize = min(uPx / max(0.5, -mv.z), 14.0);   // kameraya çok yakın tane (PiP/gimbal) ekranı kaplamasın
}`;
const PRECIP_FRAG = `uniform float uSnow, uOpacity; uniform vec3 uColor; varying float vA;
void main(){
  float a = vA * uOpacity;
  if (uSnow > 0.5) { vec2 c = gl_PointCoord - 0.5; a *= smoothstep(0.5, 0.15, length(c)); }
  if (a < 0.01) discard;
  gl_FragColor = vec4(uColor, a);
  #include <colorspace_fragment>
}`;
// ---------- rüzgâr akış çizgileri ----------
const STREAK_VERT = `uniform vec3 uCenter; uniform float uTime, uBox, uLen; uniform vec3 uWind;
attribute float aEnd; attribute float aSeed; varying float vA;
void main(){
  vec3 w = uWind; float sp = length(w); vec3 dir = sp > 0.01 ? w / sp : vec3(1.0, 0.0, 0.0);
  vec3 p = position * uBox + w * uTime * (0.9 + 0.2 * aSeed);
  vec3 o = uCenter - uBox * 0.5;
  p = mod(p - o, uBox) + o;
  p -= dir * uLen * (0.6 + 0.8 * aSeed) * aEnd;
  float d = distance(p, uCenter) / (uBox * 0.5);
  vA = (1.0 - smoothstep(0.35, 1.0, d)) * (1.0 - aEnd) * (0.4 + 0.6 * aSeed);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
}`;
const STREAK_FRAG = `uniform float uAlpha; varying float vA; void main(){ float a = vA * uAlpha; if (a < 0.01) discard; gl_FragColor = vec4(0.92, 0.96, 1.0, a); }`;

// ---------- saat + hava → renkler ----------
const SKY_SET = {
  day: { zenith: 0x2f6cc0, horizon: 0xb7d2ea, ground: 0x8ea3b2, sun: 0xfff1d6, overcast: 0x9aa3ad, sunI: 2.5, hemiSky: 0xc4dcff, hemiGround: 0x4a5a36, hemiI: 0.95, amb: 0.12 },
  dusk: { zenith: 0x22396a, horizon: 0xf0a46c, ground: 0x6c5a58, sun: 0xffa45c, overcast: 0x7a6e70, sunI: 1.35, hemiSky: 0xf0b088, hemiGround: 0x3a3a30, hemiI: 0.75, amb: 0.14 },
  night: { zenith: 0x040916, horizon: 0x13213d, ground: 0x0a0f18, sun: 0xb8c6ff, overcast: 0x161b24, sunI: 0.42, hemiSky: 0x1b2a55, hemiGround: 0x060a12, hemiI: 0.5, amb: 0.3 },
};
export function skyColors(T, time, P) {
  const S = SKY_SET[time] || SKY_SET.day;
  const c = k => new T.Color(S[k]);
  const grey = new T.Color(time === 'night' ? 0x10141c : time === 'dusk' ? 0x8a8080 : P.key === 'storm' ? 0x59616b : 0xa3abb3);
  const horizon = c('horizon').lerp(grey, P.haze * 0.75), zenith = c('zenith').lerp(grey, P.cloud * 0.55);
  const overcast = c('overcast'); if (P.key === 'storm') overcast.multiplyScalar(0.62);
  return { S, horizon, zenith, ground: c('ground').lerp(grey, P.haze * 0.5), sun: c('sun'), overcast, fog: horizon.clone().lerp(overcast, P.cloud * 0.5) };
}

// ========================================================================
export function createWorldFx(T, { renderer, scene, preview = false } = {}) {
  const tex = createGroundTextures(T, renderer);
  const atlas = treeAtlas(T);
  const U = {
    detail: { value: tex.detail }, detailN: { value: tex.normal },
    grassA: { value: new T.Color(0x4c7a32) }, grassB: { value: new T.Color(0x7c8f45) }, dirt: { value: new T.Color(0x7a6448) }, rock: { value: new T.Color(0x7b766d) },
    snow: { value: new T.Color(0xf1f4f7) }, sand: { value: new T.Color(0xc9b588) },
    wet: { value: 0 }, snowCover: { value: 0 }, snowLine: { value: 1e6 }, waterZ: { value: -1e6 }, relH: { value: 300 },
    waterQ: { value: 1 },   // §43 su kalitesi 0/1/2
    time: { value: 0 }, windDir: { value: new T.Vector2(1, 0) }, windMs: { value: 0 }, night: { value: 0 },
    glass: { value: new T.Color(0x3a4c60) }, litCol: { value: new T.Color(1.0, 0.72, 0.38) },
  };
  const fx = { weather: 'clear', time: 'day', P: null, wind: { ms: 0, dir: 0, vx: 0, vy: 0 }, flash: 0, nextFlash: 0, streaksOn: true, colors: null };
  // --- gökyüzü kubbesi (kameraya bağlı) ---
  const skyU = { uSunDir: { value: new T.Vector3(0.5, -0.4, 0.8) }, uZenith: { value: new T.Color() }, uHorizon: { value: new T.Color() }, uGround: { value: new T.Color() },
    uSunCol: { value: new T.Color() }, uOvercast: { value: new T.Color() }, uCloud: { value: 0 }, uNight: { value: 0 }, uFlash: { value: 0 } };
  const sky = new T.Mesh(new T.SphereGeometry(1, 32, 16), new T.ShaderMaterial({ uniforms: skyU, vertexShader: SKY_VERT, fragmentShader: SKY_FRAG, side: T.BackSide, depthWrite: false, depthTest: true, fog: false }));
  sky.scale.setScalar(40000); sky.frustumCulled = false; sky.renderOrder = -10; sky.name = 'wfx-gokyuzu';
  scene.add(sky);
  // --- bulut katmanı ---
  const cloudU = { uCover: { value: 0.1 }, uTime: U.time, uFar: { value: 30000 }, uNight: U.night, uWind: { value: new T.Vector2() }, uSunDir: skyU.uSunDir,
    uLight: { value: new T.Color(0xffffff) }, uShade: { value: new T.Color(0x9aa4b0) }, uFogCol: { value: new T.Color() } };
  const clouds = new T.Mesh(new T.PlaneGeometry(90000, 90000, 1, 1), new T.ShaderMaterial({ uniforms: cloudU, vertexShader: CLOUD_VERT, fragmentShader: CLOUD_FRAG, transparent: true, depthWrite: false, side: T.DoubleSide, fog: false }));
  clouds.frustumCulled = false; clouds.renderOrder = 5; clouds.name = 'wfx-bulut'; clouds.position.z = 1800;
  scene.add(clouds);
  // --- yağış ---
  const precip = { obj: null, U: null, kind: null };
  const buildPrecip = p => {
    if (precip.obj) { scene.remove(precip.obj); precip.obj.geometry.dispose(); precip.obj.material.dispose(); precip.obj = null; }
    precip.kind = p ? p.kind : null;
    if (!p || preview) return;
    const n = p.count, rain = p.kind === 'rain', per = rain ? 2 : 1;
    const pos = new Float32Array(n * per * 3), end = new Float32Array(n * per), seed = new Float32Array(n * per);
    for (let i = 0; i < n; i++) {
      const x = Math.random(), y = Math.random(), z = Math.random(), s = Math.random();
      for (let k = 0; k < per; k++) { const j = i * per + k; pos[j * 3] = x; pos[j * 3 + 1] = y; pos[j * 3 + 2] = z; end[j] = k; seed[j] = s; }
    }
    const g = new T.BufferGeometry();
    g.setAttribute('position', new T.BufferAttribute(pos, 3)); g.setAttribute('aEnd', new T.BufferAttribute(end, 1)); g.setAttribute('aSeed', new T.BufferAttribute(seed, 1));
    precip.U = { uCam: { value: new T.Vector3() }, uTime: U.time, uBox: { value: p.box }, uFall: { value: p.fall }, uLen: { value: p.len }, uPx: { value: 30 }, uSnow: { value: rain ? 0 : 1 },
      uWind: { value: new T.Vector2() }, uOpacity: { value: rain ? 0.55 : 0.95 }, uColor: { value: new T.Color(rain ? 0xaebccc : 0xffffff) } };
    const m = new T.ShaderMaterial({ uniforms: precip.U, vertexShader: PRECIP_VERT, fragmentShader: PRECIP_FRAG, transparent: true, depthWrite: false, fog: false });
    precip.obj = rain ? new T.LineSegments(g, m) : new T.Points(g, m);
    precip.obj.frustumCulled = false; precip.obj.renderOrder = 8; precip.obj.name = 'wfx-yagis';
    precip.size = p.size;
    scene.add(precip.obj);
  };
  // --- rüzgâr akış çizgileri (uçak çevresi) ---
  const STREAK_N = 420;
  const streakU = { uCenter: { value: new T.Vector3() }, uTime: U.time, uBox: { value: 46 }, uLen: { value: 4 }, uWind: { value: new T.Vector3() }, uAlpha: { value: 0.35 } };
  const streaks = (() => {
    const pos = new Float32Array(STREAK_N * 2 * 3), end = new Float32Array(STREAK_N * 2), seed = new Float32Array(STREAK_N * 2);
    for (let i = 0; i < STREAK_N; i++) { const x = Math.random(), y = Math.random(), z = Math.random(), s = Math.random(); for (let k = 0; k < 2; k++) { const j = i * 2 + k; pos[j * 3] = x; pos[j * 3 + 1] = y; pos[j * 3 + 2] = z; end[j] = k; seed[j] = s; } }
    const g = new T.BufferGeometry();
    g.setAttribute('position', new T.BufferAttribute(pos, 3)); g.setAttribute('aEnd', new T.BufferAttribute(end, 1)); g.setAttribute('aSeed', new T.BufferAttribute(seed, 1));
    const o = new T.LineSegments(g, new T.ShaderMaterial({ uniforms: streakU, vertexShader: STREAK_VERT, fragmentShader: STREAK_FRAG, transparent: true, depthWrite: false, fog: false }));
    o.frustumCulled = false; o.renderOrder = 9; o.name = 'wfx-akis'; o.visible = false;
    scene.add(o);
    return o;
  })();
  // --- mercek damlaları (FPV/gimbal; DOM tuvali — WebGL bağlamı değil) ---
  const lens = { cv: null, drops: [], at: 0 };
  const ensureLens = mount => {
    if (lens.cv || !mount || preview) return;
    lens.cv = document.createElement('canvas'); lens.cv.className = 'fs-lens-drops';
    lens.cv.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;pointer-events:none;z-index:2;display:none';
    mount.appendChild(lens.cv);
  };
  const drawLens = (now, on, intensity) => {
    if (!lens.cv) return;
    if (!on) { if (lens.cv.style.display !== 'none') lens.cv.style.display = 'none'; return; }
    if (now - lens.at < 90) return;
    const dt = Math.min(0.3, (now - lens.at) / 1000); lens.at = now;
    const cv = lens.cv, w = Math.max(1, cv.clientWidth), hh = Math.max(1, cv.clientHeight);
    if (cv.width !== Math.round(w / 2) || cv.height !== Math.round(hh / 2)) { cv.width = Math.round(w / 2); cv.height = Math.round(hh / 2); }
    cv.style.display = '';
    if (lens.drops.length < 26 * intensity && Math.random() < 0.6 * intensity) lens.drops.push({ x: Math.random() * cv.width, y: Math.random() * cv.height * 0.9, r: 3 + Math.random() * 9, v: 0, life: 1 });
    const g = cv.getContext('2d'); g.clearRect(0, 0, cv.width, cv.height);
    lens.drops = lens.drops.filter(d => d.life > 0 && d.y < cv.height + 20);
    for (const d of lens.drops) {
      if (d.r > 8) d.v += 30 * dt; d.y += d.v * dt; d.life -= dt * 0.12;
      const gr = g.createRadialGradient(d.x - d.r * 0.3, d.y - d.r * 0.35, d.r * 0.1, d.x, d.y, d.r);
      gr.addColorStop(0, `rgba(255,255,255,${0.32 * d.life})`); gr.addColorStop(0.7, `rgba(190,205,220,${0.12 * d.life})`); gr.addColorStop(1, `rgba(40,50,60,${0.22 * d.life})`);
      g.fillStyle = gr; g.beginPath(); g.ellipse(d.x, d.y, d.r * 0.85, d.r, 0, 0, Math.PI * 2); g.fill();
    }
  };

  // ---------- malzemeler ----------
  const groundMaterial = ({ satellite = false, map = null, color = 0xffffff } = {}) => patchGround(new T.MeshStandardMaterial({ map, color, roughness: 0.96, metalness: 0 }), U, { satellite });
  const waterMaterial = () => {
    const c = fx.colors || skyColors(T, fx.time, fx.P || { key: 'clear', haze: 0, cloud: 0 });
    const night = fx.time === 'night';
    const wu = T.UniformsUtils.merge([T.UniformsLib.fog, { uRain: { value: 0 }, uNight: { value: 0 }, uSky: { value: new T.Color() }, uZenith: { value: new T.Color() }, uSunDir: { value: new T.Vector3() }, uSunCol: { value: new T.Color() }, uDeep: { value: new T.Color() } }]);
    wu.uTime = U.time; wu.uWQ = U.waterQ;   // §43 su kalitesi (paylaşılan; setGraphics canlı değiştirir)
    wu.uRain.value = fx.P?.rain || 0; wu.uNight.value = night ? 1 : fx.time === 'dusk' ? 0.5 : 0;
    wu.uSky.value.copy(c.fog); wu.uZenith.value.copy(c.zenith); wu.uSunDir.value.copy(skyU.uSunDir.value); wu.uSunCol.value.copy(c.sun).multiplyScalar(fx.P?.light ?? 1);
    wu.uDeep.value.set(night ? 0x02070f : fx.time === 'dusk' ? 0x14283a : 0x0d3346);
    return new T.ShaderMaterial({ uniforms: wu, vertexShader: WATER_VERT, fragmentShader: WATER_FRAG, transparent: true, fog: true, side: T.DoubleSide, depthWrite: false });
  };
  const facadeMaterial = (instanced = true, opts = {}) => patchFacade(new T.MeshStandardMaterial({ color: 0xffffff, roughness: 0.88, metalness: 0, vertexColors: !instanced, ...opts }), U, { instanced });

  // ---------- atmosfer: saat + hava ----------
  function setAtmosphere({ time = 'day', weather = 'clear', P, sunDir, lights, fogRange }) {
    fx.time = time; fx.weather = weather; fx.P = P;
    const c = fx.colors = skyColors(T, time, P);
    skyU.uZenith.value.copy(c.zenith); skyU.uHorizon.value.copy(c.horizon); skyU.uGround.value.copy(c.ground); skyU.uSunCol.value.copy(c.sun);
    skyU.uOvercast.value.copy(c.overcast); skyU.uCloud.value = P.cloud > 0.6 ? P.cloud : 0; skyU.uNight.value = time === 'night' ? 1 : 0;
    skyU.uSunDir.value.set(sunDir.x, sunDir.y, sunDir.z).normalize();
    cloudU.uCover.value = clamp(P.cloud, 0, 1) * 0.92 + 0.04;
    cloudU.uLight.value.copy(c.sun).lerp(new T.Color(0xffffff), 0.5).multiplyScalar(time === 'night' ? 0.18 : time === 'dusk' ? 0.85 : 1).multiplyScalar(0.55 + 0.45 * P.light);
    cloudU.uShade.value.copy(c.overcast).multiplyScalar(time === 'night' ? 0.4 : P.key === 'storm' ? 0.55 : 0.82);
    cloudU.uFogCol.value.copy(c.fog);
    const S = c.S;
    lights.sun.color.copy(c.sun); lights.sun.intensity = S.sunI * (0.25 + 0.75 * P.light) * (P.cloud > 0.85 ? 0.55 : 1);
    lights.sun.shadow.intensity = clamp(1.1 - P.cloud, 0.2, 1) * (time === 'night' ? 0.35 : 1);
    lights.hemi.color.set(S.hemiSky).lerp(c.overcast, P.cloud * 0.6); lights.hemi.groundColor.set(S.hemiGround);
    lights.hemi.intensity = S.hemiI * (0.75 + 0.35 * P.cloud); lights.amb.intensity = S.amb;
    fx.hemiI = lights.hemi.intensity;
    U.wet.value = P.wet; U.snowCover.value = P.snowCover; U.night.value = time === 'night' ? 1 : time === 'dusk' ? 0.55 : 0;
    U.glass.value.copy(c.fog).lerp(new T.Color(0x24384c), 0.55).multiplyScalar(time === 'night' ? 0.35 : 1);
    renderer.setClearColor(c.fog, 1);
    scene.background = c.fog.clone();
    scene.fog = fogRange.on ? new T.Fog(c.fog, fogRange.near, fogRange.far) : null;
    cloudU.uFar.value = clamp((fogRange.on ? fogRange.far : 30000) * 1.6, 3000, 40000);
    sky.visible = true;
    return c;
  }
  const setCloudBase = z => { clouds.position.z = z; };

  // ---------- ağaçlar (parçalı InstancedMesh + LOD) ----------
  // items: [{x, y, z, h (m), r (taç yarıçapı m), sp (0 iğne / 1 geniş), c: T.Color}]; size: dünya genişliği (parça ızgarası)
  const treeGeo = { c: null, b: null, q0: null, q1: null };
  function buildTrees(items, group, { size = 4000, night = false, castShadow = !preview } = {}) {
    treeGeo.c ??= coniferGeo(T); treeGeo.b ??= broadleafGeo(T); treeGeo.q0 ??= crossQuadGeo(T, false); treeGeo.q1 ??= crossQuadGeo(T, true);
    const matHi = patchSway(new T.MeshLambertMaterial({ vertexColors: true }), U, 'hi');
    const matLo = patchSway(new T.MeshLambertMaterial({ map: atlas, alphaTest: 0.45, side: T.DoubleSide, color: night ? 0x6a7280 : 0xffffff }), U, 'lo');
    matHi.userData.wfxShared = matLo.userData.wfxShared = true;
    const NC = clamp(Math.round(size / 450), 4, 16), cell = size / NC;   // ~450 m parçalar: frustum + gölge kutusu ayıklaması ince, çizim çağrısı makul
    const chunks = new Map();
    for (const it of items) {
      const k = `${clamp(Math.floor((it.x + size / 2) / cell), 0, NC - 1)},${clamp(Math.floor((it.y + size / 2) / cell), 0, NC - 1)},${it.sp}`;
      if (!chunks.has(k)) chunks.set(k, []);
      chunks.get(k).push(it);
    }
    const m4 = new T.Matrix4(), q = new T.Quaternion(), s = new T.Vector3(), p = new T.Vector3(), zAx = new T.Vector3(0, 0, 1);
    const out = [];
    for (const [k, list] of chunks) {
      const sp = Number(k.split(',')[2]);
      const hi = new T.InstancedMesh(sp ? treeGeo.b : treeGeo.c, matHi, list.length), lo = new T.InstancedMesh(sp ? treeGeo.q1 : treeGeo.q0, matLo, list.length);
      let cx = 0, cy = 0;
      list.forEach((it, i) => {
        q.setFromAxisAngle(zAx, (it.x * 12.9898 + it.y * 78.233) % (Math.PI * 2));
        p.set(it.x, it.y, it.z - 0.25); s.set(it.r * 2.3, it.r * 2.3, it.h);
        m4.compose(p, q, s); hi.setMatrixAt(i, m4);
        s.set(it.r * 2.6, it.r * 2.6, it.h * 1.02); m4.compose(p, q, s); lo.setMatrixAt(i, m4);
        hi.setColorAt(i, it.c); lo.setColorAt(i, it.c);
        cx += it.x; cy += it.y;
      });
      for (const im of [hi, lo]) { im.instanceMatrix.needsUpdate = true; if (im.instanceColor) im.instanceColor.needsUpdate = true; im.computeBoundingSphere(); }
      hi.castShadow = castShadow; hi.receiveShadow = false;
      const ch = { hi, lo, cx: cx / list.length, cy: cy / list.length, r: hi.boundingSphere ? hi.boundingSphere.radius : cell };
      lo.visible = false;
      group.add(hi, lo); out.push(ch);
    }
    return out;
  }
  // LOD: parça merkezine (kenar payıyla) uzaklık < lodDist → 3B, değilse impostor
  function updateTreeLod(chunks, cam, lodDist = 520) {
    for (const ch of chunks) {
      const d = Math.hypot(cam.x - ch.cx, cam.y - ch.cy) - ch.r * 0.6;
      const near = d < lodDist;
      if (ch.hi.visible !== near) { ch.hi.visible = near; ch.lo.visible = !near; }
    }
  }

  // ---------- binalar (prosedürel kasabalar) ----------
  // blds: [{x, y, z (taban), w, d, h, rot, kind (0 ev / 1 apartman / 2 kule / 3 sanayi), col: T.Color, roof: T.Color|null, unit: bool}]
  function buildBuildings(blds, group, { night = false, castShadow = !preview } = {}) {
    if (!blds.length) return null;
    const boxG = new T.BoxGeometry(1, 1, 1); boxG.translate(0, 0, 0.5);
    const aB = new Float32Array(blds.length * 4);
    const bodyG = boxG.clone(); bodyG.setAttribute('aBld', new T.InstancedBufferAttribute(aB, 4));
    const body = new T.InstancedMesh(bodyG, facadeMaterial(true), blds.length);
    const m4 = new T.Matrix4(), q = new T.Quaternion(), s = new T.Vector3(), p = new T.Vector3(), zAx = new T.Vector3(0, 0, 1);
    const gables = blds.filter(b => b.roof), units = blds.filter(b => b.unit);
    const roofs = gables.length ? new T.InstancedMesh(gableGeo(T), new T.MeshStandardMaterial({ color: 0xffffff, roughness: 0.75 }), gables.length) : null;
    const unitM = units.length ? new T.InstancedMesh(boxG, new T.MeshStandardMaterial({ color: 0x8b9096, roughness: 0.6, metalness: 0.3 }), units.length) : null;
    blds.forEach((b, i) => {
      q.setFromAxisAngle(zAx, b.rot);
      p.set(b.x, b.y, b.z); s.set(b.w, b.d, b.h); m4.compose(p, q, s); body.setMatrixAt(i, m4); body.setColorAt(i, b.col);
      aB.set([b.kind, (i * 0.618) % 1 * 50, b.kind === 0 ? 3.0 : b.kind === 2 ? 3.6 : b.kind === 3 ? 6 : 3.1, night ? 0.38 : 0.3], i * 4);
    });
    gables.forEach((b, i) => { q.setFromAxisAngle(zAx, b.rot + (b.w > b.d ? Math.PI / 2 : 0)); const W = Math.max(b.w, b.d), D = Math.min(b.w, b.d); p.set(b.x, b.y, b.z + b.h); s.set(D * 1.08, W * 1.04, D * 0.42); m4.compose(p, q, s); roofs.setMatrixAt(i, m4); roofs.setColorAt(i, b.roof); });
    units.forEach((b, i) => { q.setFromAxisAngle(zAx, b.rot); p.set(b.x + Math.cos(b.rot) * b.w * 0.18, b.y + Math.sin(b.rot) * b.w * 0.18, b.z + b.h); s.set(b.w * 0.28, b.d * 0.3, 2.4); m4.compose(p, q, s); unitM.setMatrixAt(i, m4); });
    for (const im of [body, roofs, unitM]) { if (!im) continue; im.instanceMatrix.needsUpdate = true; if (im.instanceColor) im.instanceColor.needsUpdate = true; im.computeBoundingSphere(); im.castShadow = castShadow; im.receiveShadow = true; group.add(im); }
    if (!unitM) boxG.dispose();
    return { body, roofs, units: unitM };
  }
  // Yol şeridi (araziye serili): pts [[x,y]…] merkez çizgisi, genişlik, z(x,y) → BufferGeometry (üçgen şerit)
  function ribbon(pts, width, hz, lift = 0.22, step = 8) {
    const P = [];
    for (let i = 0; i < pts.length - 1; i++) {
      const [ax, ay] = pts[i], [bx, by] = pts[i + 1], L = Math.hypot(bx - ax, by - ay), n = Math.max(1, Math.ceil(L / step));
      for (let k = 0; k < n; k++) P.push([ax + (bx - ax) * k / n, ay + (by - ay) * k / n]);
    }
    P.push(pts[pts.length - 1]);
    const pos = [];
    for (let i = 0; i < P.length - 1; i++) {
      const [ax, ay] = P[i], [bx, by] = P[i + 1], L = Math.hypot(bx - ax, by - ay) || 1, nx = -(by - ay) / L * width / 2, ny = (bx - ax) / L * width / 2;
      const a1 = [ax + nx, ay + ny, hz(ax + nx, ay + ny) + lift], a2 = [ax - nx, ay - ny, hz(ax - nx, ay - ny) + lift], b1 = [bx + nx, by + ny, hz(bx + nx, by + ny) + lift], b2 = [bx - nx, by - ny, hz(bx - nx, by - ny) + lift];
      pos.push(...a2, ...b2, ...b1, ...a2, ...b1, ...a1);
    }
    return pos;
  }
  function roadMeshes(lines, group, hz, { night = false } = {}) {
    const asphalt = [], walk = [];
    for (const l of lines) {
      asphalt.push(...ribbon(l.pts, l.w, hz, 0.25));
      if (l.walk) {
        const [a, b] = [l.pts[0], l.pts[l.pts.length - 1]], L = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1, nx = -(b[1] - a[1]) / L, ny = (b[0] - a[0]) / L, off = l.w / 2 + 1;
        for (const sg of [-1, 1]) walk.push(...ribbon(l.pts.map(([x, y]) => [x + nx * off * sg, y + ny * off * sg]), 1.8, hz, 0.32));
      }
    }
    const mk = (pos, color) => {
      if (!pos.length) return;
      const g = new T.BufferGeometry(); g.setAttribute('position', new T.Float32BufferAttribute(pos, 3)); g.computeVertexNormals();
      const m = new T.Mesh(g, new T.MeshStandardMaterial({ color, roughness: 0.9, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }));
      patchWet(m.material); m.receiveShadow = true; group.add(m);
    };
    mk(asphalt, night ? 0x1d1f22 : 0x3a3c40); mk(walk, night ? 0x4a4844 : 0x9a968e);
  }
  const patchWet = m => { m.onBeforeCompile = sh => { sh.uniforms.uWet = U.wet; sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nuniform float uWet;').replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor = mix(roughnessFactor, 0.18, uWet); diffuseColor.rgb *= mix(1.0, 0.7, uWet);'); }; m.customProgramCacheKey = () => 'wfx-wet'; return m; };

  // ---------- rüzgâr tulumu ----------
  function createWindsock() {
    const g = new T.Group(); g.name = 'wfx-tulum';
    const metal = new T.MeshStandardMaterial({ color: 0xd8dde3, roughness: 0.5, metalness: 0.6 });
    const pole = new T.Mesh(new T.CylinderGeometry(0.06, 0.09, 6.5, 8).rotateX(Math.PI / 2).translate(0, 0, 3.25), metal); pole.castShadow = true; g.add(pole);
    g.add(new T.Mesh(new T.CylinderGeometry(0.5, 0.6, 0.25, 12).rotateX(Math.PI / 2).translate(0, 0, 0.12), new T.MeshStandardMaterial({ color: 0x777777, roughness: 0.9 })));
    const head = new T.Group(); head.position.z = 6.3; g.add(head);
    const ring = new T.Mesh(new T.TorusGeometry(0.42, 0.03, 6, 20).rotateY(Math.PI / 2), metal); ring.position.x = 0.15; head.add(ring);
    const segs = [];
    const orange = new T.MeshStandardMaterial({ color: 0xff5a14, roughness: 0.8, side: T.DoubleSide }), white = new T.MeshStandardMaterial({ color: 0xf2f2f2, roughness: 0.8, side: T.DoubleSide });
    let parent = head, r0 = 0.42;
    for (let i = 0; i < 5; i++) {
      const r1 = r0 * 0.86, L = 0.74;
      const seg = new T.Group(); seg.position.x = i === 0 ? 0.15 : L; parent.add(seg);
      const m = new T.Mesh(new T.CylinderGeometry(r1, r0, L, 14, 1, true).rotateZ(-Math.PI / 2).translate(L / 2, 0, 0), i % 2 ? white : orange); m.castShadow = true; seg.add(m);
      segs.push(seg); parent = seg; r0 = r1;
    }
    const lamp = new T.Mesh(new T.SphereGeometry(0.12, 8, 6), new T.MeshBasicMaterial({ color: 0xff2a1a })); lamp.position.z = 6.65; g.add(lamp);
    g.scale.setScalar(1.6);
    return {
      group: g, head, segs, lamp,
      update(t, ms, fromDeg, st) {   // st: sockState(ms)
        head.rotation.z = (90 - (fromDeg + 180)) * DEG;   // tulum rüzgârın ESTİĞİ yöne uzanır (from + 180), yerel +X ileri
        const per = st.droop / 5 * DEG;
        segs.forEach((s, i) => {
          const fl = Math.sin(t * (4 + ms * 0.6) + i * 0.9) * st.flutter;
          s.rotation.set(fl * 0.6, per + fl * 0.3, fl);
          s.scale.set(1, 0.9 + 0.1 * st.inflation, 0.9 + 0.1 * st.inflation);
        });
      },
    };
  }

  // ---------- kare güncellemesi ----------
  const tmpV = new T.Vector3();
  function update(now, dt, { camera, focus, camMode, wind, mount, vehicleCam }) {
    U.time.value = (now / 1000) % 100000;
    sky.position.copy(camera.position);
    fx.wind = wind;
    const sp = Math.hypot(wind.vx, wind.vy);
    if (sp > 0.01) U.windDir.value.set(wind.vx / sp, wind.vy / sp);
    U.windMs.value = sp;
    cloudU.uWind.value.set(wind.vx * 2.5, wind.vy * 2.5);   // irtifada rüzgâr daha güçlü (görsel)
    if (precip.obj) {
      precip.U.uCam.value.copy(camera.position); precip.U.uWind.value.set(wind.vx, wind.vy);
      const hPx = renderer.domElement.height || 600;
      precip.U.uPx.value = precip.kind === 'snow' ? (precip.size || 0.09) * hPx / (2 * Math.tan((camera.fov || 60) * DEG / 2)) : 1;
    }
    // fırtına: şimşek (2–4 kısa çakma); hemi ışığı + gök
    if (fx.P?.lightning) {
      if (now > fx.nextFlash) { fx.flash = 1; fx.nextFlash = now + 5000 + Math.random() * 11000; fx.flashStep = 0; }
      if (fx.flash > 0) { fx.flash = Math.max(0, fx.flash - dt * 6); }
      skyU.uFlash.value = fx.flash > 0.5 || (fx.flash > 0.15 && fx.flash < 0.3) ? fx.flash : 0;
    } else skyU.uFlash.value = 0;
    // akış çizgileri
    if (fx.streaksOn && sp >= 0.3 && focus) {
      streaks.visible = true;
      streakU.uCenter.value.copy(focus); streakU.uWind.value.set(wind.vx, wind.vy, 0);
      streakU.uLen.value = clamp(1.5 + sp * 0.55, 1.5, 14); streakU.uAlpha.value = clamp(0.12 + sp / 22, 0.12, 0.55);
      streaks.geometry.setDrawRange(0, Math.round(clamp(60 + sp * 26, 60, STREAK_N)) * 2);
      const dCam = camera.position.distanceTo(focus);
      streakU.uBox.value = clamp(dCam * 1.1, 30, 120);
    } else streaks.visible = false;
    // mercek damlaları: araç kamerasında yağmur/fırtına
    ensureLens(mount);
    drawLens(now, !!vehicleCam && (fx.P?.rain || 0) > 0, fx.P?.rain || 0);
    void tmpV; void camMode;
  }
  const hideInThermal = () => [sky, clouds, streaks, ...(precip.obj ? [precip.obj] : [])];
  function dispose() {
    for (const o of [sky, clouds, streaks]) { scene.remove(o); o.geometry.dispose(); o.material.dispose(); }
    buildPrecip(null);
    tex.detail.dispose(); tex.normal.dispose(); atlas.dispose();
    for (const k of Object.keys(treeGeo)) treeGeo[k]?.dispose();
    lens.cv?.remove();
  }
  return {
    U, fx, sky, clouds, groundMaterial, waterMaterial, facadeMaterial, patchWet, setAtmosphere, setCloudBase, buildPrecip, buildTrees, updateTreeLod, buildBuildings,
    roadMeshes, createWindsock, update, hideInThermal, dispose,
    setStreaks: on => { fx.streaksOn = !!on; }, get streaksOn() { return fx.streaksOn; },
    get flash() { return skyU.uFlash.value; }, get precipKind() { return precip.kind; }, get precipCount() { return precip.obj ? precip.obj.geometry.attributes.position.count : 0; },
  };
}
