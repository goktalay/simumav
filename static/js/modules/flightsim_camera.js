// Uçuş Simülatörü — kamera türü (gündüz / termal / gece görüşü) ve sürüklenebilir kamera PiP'i (docs/ucus-simulatoru.md §22.3–§22.5).
// HEPGO (flightsim.js) ve SIMUMAV (static/simumav/app/fly/session.js, /sim mount'u) aynı dosyayı kullanır: dış içe aktarım YOK (DOM yardımcıları burada).
// • Katman 1 (saf; tarayıcısız test: tests/test_flightsim_camera.mjs): tür/palet doğrulama ve döngü, kip → PiP kaynağı ve yer değiştirme (çift tık),
//   PiP boyutu/yerleşimi/köşeye yapışma, PiP yenileme aralığı (yavaş karede yarı hız), gimbal yakınlaştırma → FOV, tercihler (localStorage).
// • Katman 2 (gölgelendirici): CAM_FRAG — tam ekran son işleme; FPV balıkgözü/vinyet/analog (eski post) + tür: termal (beyaz-sıcak / siyah-sıcak /
//   ironbow, AGC, hafif gürültü, düşük çözünürlük), gece görüşü (yeşil fosfor, kazanç, tanecik, tüp vinyeti, parlak noktada halo). camFxPixel aynı
//   formüllerin JS karşılığıdır (sihirbaz önizlemeleri 2B tuvalde — ikinci WebGL bağlamı açılmaz).
// • Katman 3 (DOM): createCameraPip (sürükle/yapış/boyut/gizle, çift tık → gimbal, küçük OSD tuvali — ekran kaydına girer), createCameraCtl (alt çubuk
//   "📷 Tür ▾" menüsü; T / Shift+T / V kısayolları), createCameraCards (sihirbaz kartları; önizlemeli), drawCamPreview.
// Kamera türü YALNIZ araç üstü kameralara (gimbal 'fpv', FPV 'pilot') ve PiP'teki araç kamerasına uygulanır; dış gözlemci kipleri (takip/serbest/yer)
// her zaman gündüz renklidir (camFxApplies). Sunucu türü enum olarak doğrular (day|thermal|night) ve oturum/kayıt satırında saklar.

// ---------------------------------------------------------------- Katman 1: saf model ----------------------------------------------------------------
export const CAMERA_TYPES = [
  ['day', 'Gündüz kamerası', 'Renkli EO kamera; mevcut görüntü.'],
  ['thermal', 'Termal kamera', 'Isı görüntüsü: motorlar, araçlar ve insanlar sıcak; beyaz-sıcak, siyah-sıcak, ironbow paletleri.'],
  ['night', 'Gece görüşü', 'Görüntü yoğunlaştırıcı: yeşil fosfor, kazanç, tanecik ve parlak ışıklarda halo.'],
];
export const CAM_TYPE_KEYS = CAMERA_TYPES.map(([k]) => k);
export const isCamType = v => CAM_TYPE_KEYS.includes(v);
export const normCamType = v => (isCamType(v) ? v : 'day');
export const nextCamType = cur => CAM_TYPE_KEYS[(CAM_TYPE_KEYS.indexOf(normCamType(cur)) + 1) % CAM_TYPE_KEYS.length];
export const camTypeLabel = (t, tr = s => s) => tr((CAMERA_TYPES.find(([k]) => k === t) || CAMERA_TYPES[0])[1]);
export const CAM_TYPE_SHORT = { day: 'GÜNDÜZ', thermal: 'TERMAL', night: 'GECE' };   // PiP OSD etiketi
export const CAM_TYPE_NAME_SHORT = { day: 'Gündüz', thermal: 'Termal', night: 'Gece' };   // alt çubuk düğmesi
export const THERMAL_PALETTES = [['white', 'Beyaz-sıcak', 'WH'], ['black', 'Siyah-sıcak', 'BH'], ['iron', 'Ironbow', 'IRON']];
export const PALETTE_KEYS = THERMAL_PALETTES.map(([k]) => k);
export const normPalette = v => (PALETTE_KEYS.includes(v) ? v : 'white');
export const nextPalette = cur => PALETTE_KEYS[(PALETTE_KEYS.indexOf(normPalette(cur)) + 1) % PALETTE_KEYS.length];
export const camTypeIndex = t => Math.max(0, CAM_TYPE_KEYS.indexOf(normCamType(t)));   // gölgelendirici: 0 gündüz · 1 termal · 2 gece
export const paletteIndex = p => Math.max(0, PALETTE_KEYS.indexOf(normPalette(p)));   // 0 WH · 1 BH · 2 ironbow
// Tür hangi kamera kiplerinde uygulanır: araç üstü kameralar (gimbal 'fpv', FPV 'pilot'); dış gözlemci kipleri gündüz kalır
export const camFxApplies = mode => mode === 'fpv' || mode === 'pilot';
// Gece görüşü kazancı (sahne saati): gece sahnesi koyu → yüksek kazanç; gündüz yoğunlaştırıcı doyar (düşük kazanç)
export const nightGain = time => (time === 'night' ? 7 : time === 'dusk' ? 3.4 : 2);
// Termal kazanç: termal görüntü aydınlatmadan bağımsızdır → koyu (gece/alacakaranlık) sahne parlaklığı normalize edilir (sıcak nesneler zaten 1'e kırpılır)
export const thermalGain = time => (time === 'night' ? 3.6 : time === 'dusk' ? 1.7 : 1);

// Gimbal yakınlaştırma (gimbal kamerası 'fpv'): 1×–8×; FOV = 2·atan(tan(FOV₀/2) / z)
export const GIMBAL_ZOOM = { min: 1, max: 8, step: 1.25 };
export const clampZoom = z => Math.min(GIMBAL_ZOOM.max, Math.max(GIMBAL_ZOOM.min, Number.isFinite(Number(z)) ? Number(z) : 1));
export const gimbalZoomFov = (baseDeg, zoom) => 2 * Math.atan(Math.tan(baseDeg * Math.PI / 360) / clampZoom(zoom)) * 180 / Math.PI;

// PiP kaynağı: ana kip gimbal değilse PiP gimbal kamerasını gösterir; ana kip gimbal ise önceki ana kipi (takip ya da FPV; serbest/yer → takip)
const PIP_ALT = ['follow', 'pilot'];
export const pipSourceFor = (main, prev) => (main === 'fpv' ? (PIP_ALT.includes(prev) ? prev : 'follow') : 'fpv');
// Çift tık (yer değiştirme): ana kip gimbal değilse → gimbal; gimbal ise → PiP'in gösterdiği kip (önceki ana kip)
export const pipSwapTarget = (main, prev) => (main === 'fpv' ? pipSourceFor('fpv', prev) : 'fpv');
export const PIP_SOURCE_SHORT = { fpv: 'GİMBAL', follow: 'TAKİP', pilot: 'FPV' };
// PiP yenileme aralığı (ms): normalde 30 fps; ana kare yavaşsa (ortalama > 22 ms) yarı hız 15 fps
export const pipInterval = avgFrameMs => (avgFrameMs > 22 ? 1000 / 15 : 1000 / 30);
export const PIP_RES_SCALE = 0.75;   // PiP render hedefi: CSS px × min(dpr, 1.5) × 0.75 (daha düşük çözünürlük)

// PiP boyutları (CSS px, 16:9) ve yerleşim
export const PIP_SIZES = { s: { w: 208, h: 117 }, m: { w: 288, h: 162 }, l: { w: 400, h: 225 } };
export const PIP_SIZE_KEYS = ['s', 'm', 'l'];
export const PIP_CORNERS = ['tl', 'tr', 'bl', 'br'];
export const PIP_DEFAULT = { on: true, size: 'm', corner: 'br', fx: 1, fy: 1 };   // sağ alt (kullanıcı isteği); sağdaki veri paneli / harekât kartı pipObstacleInsets ile atlanır
export const PIP_SNAP_PX = 56;   // bırakmada köşe yuvasına bu kadar yakınsa yapışır
export const nextPipSize = s => PIP_SIZE_KEYS[(PIP_SIZE_KEYS.indexOf(s) + 1) % PIP_SIZE_KEYS.length] || 'm';
export function normPipPref(p) {
  const o = { ...PIP_DEFAULT, ...(p && typeof p === 'object' ? p : {}) };
  o.on = o.on !== false;
  if (!PIP_SIZE_KEYS.includes(o.size)) o.size = 'm';
  if (o.corner != null && !PIP_CORNERS.includes(o.corner)) o.corner = PIP_DEFAULT.corner;
  for (const k of ['fx', 'fy']) { const n = Number(o[k]); o[k] = Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : PIP_DEFAULT[k]; }
  return o;
}
// Görünüm boyutuna göre PiP ölçüsü: dar ekranda genişliğin en çok %46'sı (mobil), geniş ekranda %34'ü; 16:9 korunur, en az 140 px
export function pipSize(size, W, H) {
  const base = PIP_SIZES[size] || PIP_SIZES.m;
  const maxW = Math.max(140, W * (W < 700 ? 0.46 : 0.34)), maxH = Math.max(80, H * 0.4);
  const w = Math.round(Math.min(base.w, maxW, maxH * 16 / 9));
  return { w, h: Math.round(w * 9 / 16) };
}
// Kenar boşlukları: üstte gezinti kapsülü, altta araç çubuğu + atıf satırı; yanlarda 12 px
export const pipInsets = (o = {}) => ({ top: o.top ?? 56, bottom: o.bottom ?? 80, left: o.left ?? 12, right: o.right ?? 12 });
// Tercih → dikdörtgen {x, y, w, h, corner} (CSS px, bağlama göre); köşe yoksa serbest konum (fx, fy: kullanılabilir aralıktaki oran)
export function pipPlace(pref, W, H, ins = pipInsets()) {
  const p = normPipPref(pref), { w, h } = pipSize(p.size, W, H);
  const x0 = ins.left, x1 = Math.max(x0, W - ins.right - w), y0 = ins.top, y1 = Math.max(y0, H - ins.bottom - h);
  let x, y;
  if (p.corner) { x = p.corner[1] === 'l' ? x0 : x1; y = p.corner[0] === 't' ? y0 : y1; }
  else { x = x0 + (x1 - x0) * p.fx; y = y0 + (y1 - y0) * p.fy; }
  return { x: Math.round(x), y: Math.round(y), w, h, corner: p.corner || null };
}
// Bırakma: sol üst (x, y) → köşe yuvasına PIP_SNAP_PX içindeyse o köşe, değilse serbest oran; dönen tercih kaydedilir
export function pipSnap(x, y, w, h, W, H, ins = pipInsets(), snap = PIP_SNAP_PX) {
  const x0 = ins.left, x1 = Math.max(x0, W - ins.right - w), y0 = ins.top, y1 = Math.max(y0, H - ins.bottom - h);
  const cx = Math.min(x1, Math.max(x0, x)), cy = Math.min(y1, Math.max(y0, y));
  const nx = Math.abs(cx - x0) <= snap ? 'l' : Math.abs(cx - x1) <= snap ? 'r' : null;
  const ny = Math.abs(cy - y0) <= snap ? 't' : Math.abs(cy - y1) <= snap ? 'b' : null;
  if (nx && ny) return { corner: ny + nx, fx: nx === 'l' ? 0 : 1, fy: ny === 't' ? 0 : 1 };
  return { corner: null, fx: x1 > x0 ? (cx - x0) / (x1 - x0) : 0, fy: y1 > y0 ? (cy - y0) / (y1 - y0) : 0 };
}
// Köşe tutamacıyla boyut: sürüklenen genişliğe en yakın S/M/L
export const pipSizeForWidth = w => PIP_SIZE_KEYS.reduce((best, k) => (Math.abs(PIP_SIZES[k].w - w) < Math.abs(PIP_SIZES[best].w - w) ? k : best), 'm');
// Çift dokunma/tıklama: iki bırakma ≤ 320 ms ve ≤ 24 px
export const isDoubleTap = (a, b) => !!a && !!b && b.t - a.t <= 320 && Math.hypot(b.x - a.x, b.y - a.y) <= 24;

// Tercihler (localStorage): fs.cam.type (son tür), fs.cam.palette, fs.cam.pip (JSON), fs.cam.byDrone (JSON {dron kimliği: tür})
export const LS_CAM = { type: 'fs.cam.type', palette: 'fs.cam.palette', pip: 'fs.cam.pip', byDrone: 'fs.cam.byDrone', legacyPip: 'fs.fpv.pip' };
export function createCamPrefs(storage = (typeof localStorage !== 'undefined' ? localStorage : null)) {
  const get = k => { try { return storage?.getItem(k) ?? null; } catch { return null; } };
  const set = (k, v) => { try { storage?.setItem(k, v); } catch { /* özel kip / kota */ } };
  const json = (k, d) => { try { const v = JSON.parse(get(k) || 'null'); return v && typeof v === 'object' ? v : d; } catch { return d; } };
  let pip = json(LS_CAM.pip, null);
  if (!pip) pip = { on: get(LS_CAM.legacyPip) !== '0' };   // eski FPV PiP anahtarı (fs.fpv.pip) → genel PiP
  const S = { type: normCamType(get(LS_CAM.type)), palette: normPalette(get(LS_CAM.palette)), pip: normPipPref(pip), byDrone: json(LS_CAM.byDrone, {}) };
  return {
    get type() { return S.type; }, get palette() { return S.palette; }, get pip() { return { ...S.pip }; },
    setType(t) { S.type = normCamType(t); set(LS_CAM.type, S.type); return S.type; },
    setPalette(p) { S.palette = normPalette(p); set(LS_CAM.palette, S.palette); return S.palette; },
    setPip(patch) { S.pip = normPipPref({ ...S.pip, ...(patch || {}) }); set(LS_CAM.pip, JSON.stringify(S.pip)); return { ...S.pip }; },
    // Dron kaydına kalıcı son tür (sunucu `camera` önerisi yoksa): kimlik → tür
    typeForDrone(id) { return id != null && isCamType(S.byDrone[String(id)]) ? S.byDrone[String(id)] : null; },
    rememberDrone(id, t) { if (id == null || !isCamType(t)) return; S.byDrone[String(id)] = t; set(LS_CAM.byDrone, JSON.stringify(S.byDrone)); },
  };
}

// ---------------------------------------------------------------- Katman 2: gölgelendirici ----------------------------------------------------------------
export const CAM_VERT = 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }';
// Tekdüzeler: tDiffuse · k/scale (balıkgözü; 0 = yok) · vignette · analog · camType (0/1/2) · palette (0/1/2) · time · gain (gece / termal) · lowres (yatay piksel;
// 0 = kapalı) · aspect · texel (1/çözünürlük)
export const CAM_FRAG = `uniform sampler2D tDiffuse; uniform float k, scale, vignette, analog, camType, palette, time, gain, lowres, aspect; uniform vec2 texel; varying vec2 vUv;
  float hash(vec2 p){ p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
  float lum(vec3 c){ return dot(c, vec3(0.299, 0.587, 0.114)); }
  vec3 iron(float t){
    t = clamp(t, 0.0, 1.0); float s = t * 6.0;
    vec3 c0 = vec3(0.0), c1 = vec3(0.13, 0.0, 0.36), c2 = vec3(0.58, 0.0, 0.55), c3 = vec3(0.90, 0.20, 0.10), c4 = vec3(1.0, 0.62, 0.0), c5 = vec3(1.0, 0.93, 0.45), c6 = vec3(1.0);
    if (s < 1.0) return mix(c0, c1, s); if (s < 2.0) return mix(c1, c2, s - 1.0); if (s < 3.0) return mix(c2, c3, s - 2.0);
    if (s < 4.0) return mix(c3, c4, s - 3.0); if (s < 5.0) return mix(c4, c5, s - 4.0); return mix(c5, c6, s - 5.0);
  }
  void main(){
    vec2 d = vUv - 0.5; float r2 = dot(d, d);
    vec2 uv = 0.5 + d * (1.0 + k * r2) * scale;
    if (lowres > 0.5) { vec2 g = vec2(lowres, lowres / aspect); uv = (floor(uv * g) + 0.5) / g; }
    vec3 c = texture2D(tDiffuse, uv).rgb;
    float n = hash(floor(vUv / texel) + fract(time * 7.13) * vec2(37.0, 91.0)) - 0.5;
    vec2 pq = d * vec2(aspect, 1.0);
    if (camType > 1.5) {
      // gece görüşü: kazanç · 16 örnekli halo (eşik üstü parlaklık) · tanecik · yeşil fosfor (parlakta beyaza kayar) · dairesel tüp vinyeti
      float l = lum(c) * gain, hs = 0.0;
      for (int i = 0; i < 8; i++) {
        float a = float(i) * 0.785398; vec2 o = vec2(cos(a), sin(a)) * texel * 6.0;
        hs += max(lum(texture2D(tDiffuse, uv + o).rgb) * gain - 0.8, 0.0) + 0.5 * max(lum(texture2D(tDiffuse, uv + o * 2.6).rgb) * gain - 0.8, 0.0);
      }
      l = clamp(l + hs * 0.2 + n * 0.17, 0.0, 1.3);
      c = vec3(0.12, 1.0, 0.34) * l + vec3(0.30, 0.25, 0.30) * l * l * 0.6;
      c *= 1.0 - smoothstep(0.40, 0.80, length(pq));
    } else if (camType > 0.5) {
      // termal: yumuşatılmış parlaklık (sıcak malzemeler beyaz, gökyüzü/su soğuk) → AGC → palet; hafif gürültü
      float l = gain * (2.0 * lum(c) + lum(texture2D(tDiffuse, uv + vec2(texel.x * 1.5, 0.0)).rgb) + lum(texture2D(tDiffuse, uv + vec2(0.0, texel.y * 1.5)).rgb)) * 0.25;
      float t = clamp(pow(clamp((l - 0.03) * 1.5, 0.0, 1.0), 0.85) + n * 0.05, 0.0, 1.0);
      c = palette < 0.5 ? vec3(t) : palette < 1.5 ? vec3(1.0 - t) : iron(t);
      c *= 1.0 - 0.18 * smoothstep(0.55, 1.0, length(pq));
    } else if (analog > 0.5) {
      // analog FPV alıcısı: doygunluk ↑, hafif sıcak/soğuk kanal kayması, biraz kontrast
      float l = lum(c);
      c = mix(vec3(l), c, 1.35); c = (c - 0.5) * 1.08 + 0.5; c.r *= 1.04; c.b *= 0.97;
    }
    float v = 1.0 - vignette * smoothstep(0.25, 0.9, r2 * 2.0);
    gl_FragColor = vec4(c * v, 1.0);
  }`;
// Gölgelendirici tekdüzeleri (three.js biçimi; T.Vector2 dışarıdan verilir)
export const camUniforms = vec2 => ({ tDiffuse: { value: null }, k: { value: 0 }, scale: { value: 1 }, vignette: { value: 0 }, analog: { value: 0 }, camType: { value: 0 }, palette: { value: 0 },
  time: { value: 0 }, gain: { value: 1 }, lowres: { value: 0 }, aspect: { value: 16 / 9 }, texel: { value: vec2 } });

// JS karşılığı (sihirbaz önizlemesi, testler): l = sahne parlaklığı 0…1 (termalde ısı), n = gürültü −0,5…0,5, rr = merkezden uzaklık (yükseklik birimi)
const iron = t => {
  const C = [[0, 0, 0], [0.13, 0, 0.36], [0.58, 0, 0.55], [0.9, 0.2, 0.1], [1, 0.62, 0], [1, 0.93, 0.45], [1, 1, 1]];
  const s = Math.min(1, Math.max(0, t)) * 6, i = Math.min(5, Math.floor(s)), f = s - i;
  return C[i].map((a, j) => a + (C[i + 1][j] - a) * f);
};
const smoothstep = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
export function camFxPixel(l, type, { palette = 'white', gain = 1, n = 0, rr = 0, halo = 0 } = {}) {
  if (type === 'thermal') {
    const t = Math.min(1, Math.max(0, Math.pow(Math.min(1, Math.max(0, (l - 0.03) * 1.5)), 0.85) + n * 0.05));
    const c = palette === 'black' ? [1 - t, 1 - t, 1 - t] : palette === 'iron' ? iron(t) : [t, t, t];
    const v = 1 - 0.18 * smoothstep(0.55, 1, rr);
    return c.map(x => x * v);
  }
  if (type === 'night') {
    const L = Math.min(1.3, Math.max(0, l * gain + halo * 0.2 + n * 0.17));
    const v = 1 - smoothstep(0.4, 0.8, rr);
    return [0.12 * L + 0.18 * L * L, L + 0.15 * L * L, 0.34 * L + 0.18 * L * L].map(x => Math.min(1, x * v));
  }
  return null;   // gündüz: değişmez
}

// ---------------------------------------------------------------- Katman 3: DOM ----------------------------------------------------------------
const el = (tag, attrs, ...kids) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') e.className = v; else if (k.startsWith('on')) e.addEventListener(k.slice(2), v); else if (k === 'text') e.textContent = v; else e.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat()) if (c != null && c !== false) e.append(c.nodeType ? c : document.createTextNode(String(c)));
  return e;
};
const CAM_ICON_SVG = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 8h3l2-3h8l2 3h3v11H3z"/><circle cx="12" cy="13" r="3.5"/></svg>';
// Engeller (PiP altında kalmasın): sağda harekât kartı (.fs-pn-kart) → sağ kenar boşluğu kartın solundan; sol altta yüzen Mission Planner kutusu
// (.fs-pn-yuzen), kayıt bilgisi kutusu (.fs-mp), SIMUMAV hız kadranı (.fs-speed-gauge) ve net etiketi → sol taraf için alt boşluk en üstteki engelin üstünden. side: 'l' | 'r' (PiP'in bulunduğu taraf).
export function pipObstacleInsets(stage, mount, side) {
  const out = {}, m = mount.getBoundingClientRect();
  const vis = e => e && e.offsetParent && e.getBoundingClientRect().width > 0;
  const k = stage?.querySelector?.('.fs-pn-kart');
  if (vis(k)) { const r = k.getBoundingClientRect(); if (r.left - m.left > m.width / 2) out.right = Math.max(12, Math.round(m.right - r.left + 12)); }
  // Alt ortadaki kadran kümesi (.fs-gauges): sağ panel açıkken küme sağa kayar; PiP sütunu (kenardan ~PIP_L_W px) kümeyle yatayda çakışıyorsa
  // PiP kümenin üstüne çıkar (sağ alt varsayılan konumda pencerenin kadranların arkasında kalmasını önler)
  const g = stage?.querySelector?.('.fs-gauges');
  if (vis(g)) {
    const r = g.getBoundingClientRect(), col = 300;
    const hit = side === 'l' ? r.left - m.left < (out.left ?? 12) + col : m.right - r.right < (out.right ?? 12) + col;
    if (hit) out.bottom = Math.max(out.bottom || 0, Math.round(m.bottom - r.top + 8));
  }
  if (side === 'l') for (const e of stage?.querySelectorAll?.('.fs-pn-yuzen, .fs-mp, .fs-speed-gauge, .sm-fly-stage .fs-net, .fs-site-dock, .fs-site-scr.fs-float') || []) {   // §26 radar/EO doku + §27.4 yüzen pencereler
    if (!vis(e)) continue;
    const r = e.getBoundingClientRect();
    if (r.left - m.left < m.width / 3 && r.bottom > m.top + m.height * 0.55) out.bottom = Math.max(out.bottom || 0, Math.round(m.bottom - r.top + 10));
  }
  return out;
}
const reducedMotion = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
const editable = t => !!t && (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.isContentEditable);

// Sürüklenebilir PiP penceresi. Görüntü 3B tuvalin içinde (aynı WebGL bağlamı: render hedefi + viewport/scissor kopyası); bu öğe yalnız çerçeve,
// araç düğmeleri, köşe tutamacı ve OSD tuvalidir (saydam). opts: { getSim, tr, prefs (createCamPrefs), insets?: side => {top,bottom,left,right},
// onSwap?(mode), onChange?() }. Dönüş: { el, layout, setOn, toggle, overlay() → {canvas,x,y,w,h} (ekran kaydı birleşimi), dispose }
export function createCameraPip(mount, opts = {}) {
  const tr = opts.tr || (s => s), prefs = opts.prefs || createCamPrefs();
  const getSim = () => opts.getSim?.() || null;
  const osd = el('canvas', { class: 'fs-pip-osd', 'aria-hidden': 'true' });
  const btn = (cls, title, txt, fn) => el('button', { class: `fs-pip-b ${cls}`, type: 'button', title, 'aria-label': title, onclick: e => { e.stopPropagation(); fn(); }, onpointerdown: e => e.stopPropagation() }, txt);
  const sizeBtn = btn('fs-pip-size', tr('Boyut: küçük / orta / büyük'), 'M', () => { prefs.setPip({ size: nextPipSize(prefs.pip.size) }); layout(); opts.onChange?.(); });
  const tools = el('div', { class: 'fs-pip-tools' },
    btn('fs-pip-swap', tr('Ana görünümle yer değiştir (çift tık)'), '⇄', () => swap()),
    sizeBtn,
    btn('fs-pip-hide', tr('PiP\'i gizle (V)'), '×', () => setOn(false)));
  const grip = el('i', { class: 'fs-pip-grip', title: tr('Boyutlandır'), 'aria-hidden': 'true' });
  const box = el('div', { class: 'fs-pip', role: 'group', tabindex: '0', 'aria-label': tr('Kamera PiP: sürükleyin, çift tıklayınca gimbal kamerası ana görünüme geçer'),
    title: tr('Sürükle: taşı · çift tık: gimbal kamerası ana görünüme · tekerlek: yakınlaştırma') }, osd, tools, grip);
  if (reducedMotion()) box.classList.add('no-anim');
  (mount.parentElement || mount).append(box);
  let rect = null, drag = null, lastTap = null, disposed = false;
  const W = () => Math.max(1, mount.clientWidth), H = () => Math.max(1, mount.clientHeight);
  const ins = side => pipInsets(opts.insets?.(side) || {});   // side: 'l' | 'r' (taraf engelleri)
  const sideOf = p => (p.corner ? p.corner[1] : p.fx < 0.5 ? 'l' : 'r');
  const place = r => { box.style.left = `${r.x}px`; box.style.top = `${r.y}px`; box.style.width = `${r.w}px`; box.style.height = `${r.h}px`; };
  function layout() {
    if (disposed) return;
    const p = prefs.pip;
    box.hidden = !p.on;
    sizeBtn.textContent = p.size.toUpperCase();
    getSim()?.setPip?.(p.on);
    if (!p.on) { rect = null; return; }
    rect = pipPlace(p, W(), H(), ins(sideOf(p)));
    place(rect);
    box.dataset.corner = rect.corner || '';
    getSim()?.setPipRect?.(rect);
    drawOsd(true);
  }
  function setOn(v) { prefs.setPip({ on: !!v }); layout(); opts.onChange?.(); }
  const toggle = () => setOn(!prefs.pip.on);
  let lastSwapAt = -Infinity;
  function swap(evT) {
    const sim = getSim(); if (!sim) return;
    lastSwapAt = evT ?? performance.now();   // olay zaman damgası: yavaş karede dblclick yedeği ikinci kez tetiklemesin
    const target = sim.swapPip ? sim.swapPip() : null;
    if (target) opts.onSwap?.(target);
    drawOsd(true);
  }
  // sürükle (fare/dokunmatik/kalem; pointer olayları) · köşe tutamacı → boyut · çift tık/dokunma → yer değiştir
  box.addEventListener('pointerdown', e => {
    if (e.button !== 0 || !rect) return;
    e.preventDefault(); e.stopPropagation();
    box.setPointerCapture?.(e.pointerId);
    drag = { id: e.pointerId, sx: e.clientX, sy: e.clientY, x: rect.x, y: rect.y, w: rect.w, resize: e.target === grip, moved: false };
    box.classList.add('dragging');
  });
  box.addEventListener('pointermove', e => {
    if (!drag || e.pointerId !== drag.id) return;
    if (e.pointerType === 'mouse' && e.buttons === 0) { endDrag(e); return; }   // pencere dışında bırakıldı (pointerup gelmedi)
    const dx = e.clientX - drag.sx, dy = e.clientY - drag.sy;
    if (!drag.moved && Math.hypot(dx, dy) < 4) return;
    drag.moved = true;
    if (drag.resize) {   // tutamaç sol alt/sağ alt köşede; köşeye göre genişlik yönü
      const left = (rect.corner || '').endsWith('r') || (!rect.corner && rect.x > W() / 2);
      const w = Math.max(140, Math.min(W() * 0.6, drag.w + (left ? -dx : dx)));
      box.style.width = `${w}px`; box.style.height = `${Math.round(w * 9 / 16)}px`;
      return;
    }
    const nx = Math.min(W() - drag.w * 0.3, Math.max(-drag.w * 0.7, drag.x + dx)), ny = Math.min(H() - 30, Math.max(0, drag.y + dy));
    rect = { ...rect, x: Math.round(nx), y: Math.round(ny) };
    place(rect);
    getSim()?.setPipRect?.(rect);
  });
  const endDrag = e => {
    if (!drag || (e && e.pointerId !== drag.id)) return;
    const d = drag; drag = null;
    box.classList.remove('dragging');
    if (d.resize && d.moved) { prefs.setPip({ size: pipSizeForWidth(parseFloat(box.style.width) || d.w) }); layout(); opts.onChange?.(); return; }
    if (d.moved) { const side = rect.x + rect.w / 2 < W() / 2 ? 'l' : 'r'; prefs.setPip(pipSnap(rect.x, rect.y, rect.w, rect.h, W(), H(), ins(side))); layout(); opts.onChange?.(); return; }
    const tap = { t: e?.timeStamp || performance.now(), x: e?.clientX ?? 0, y: e?.clientY ?? 0 };   // olay zaman damgası (yavaş karede işleyici gecikmesi çift tıkı bozmasın)
    if (isDoubleTap(lastTap, tap)) { lastTap = null; swap(tap.t); } else lastTap = tap;
  };
  box.addEventListener('pointerup', endDrag);
  box.addEventListener('lostpointercapture', e => endDrag(e));   // yakalama kaybı (pencere dışı bırakma, sekme değişimi): sürükleme kapanır
  box.addEventListener('pointercancel', () => { drag = null; box.classList.remove('dragging'); layout(); });
  // tarayıcının çift tıkı: seçim/yakınlaştırma bastırılır; kendi algılamamız (çift dokunma) az önce tetiklemediyse yedek olarak yer değiştirir
  box.addEventListener('dblclick', e => { e.preventDefault(); e.stopPropagation(); if (e.timeStamp - lastSwapAt > 600 && e.target !== grip && !e.target.closest?.('.fs-pip-tools')) swap(); });
  box.addEventListener('wheel', e => {   // PiP gimbal gösteriyorsa tekerlek = yakınlaştırma
    const sim = getSim(); if (!sim?.getPipSource || sim.getPipSource() !== 'fpv') return;
    e.preventDefault(); e.stopPropagation();
    const dy = e.deltaY || e.deltaX; sim.setGimbalZoom?.(sim.getGimbalZoom() * (dy > 0 ? 1 / GIMBAL_ZOOM.step : GIMBAL_ZOOM.step)); drawOsd(true);
  }, { passive: false });
  box.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); swap(); } });

  // OSD (küçük tuval; kayda da girer): köşe parantezleri, tür · palet, kaynak, gimbal açısı, yakınlaştırma, merkez artı (gimbal)
  let osdKey = '';
  function drawOsd(force = false) {
    if (!rect || box.hidden) return;
    const sim = getSim(); if (!sim) return;
    const src = sim.getPipSource?.() || 'fpv', type = sim.getCamType?.() || 'day', pal = sim.getThermalPalette?.() || 'white';
    const onboard = camFxApplies(src), g = Math.round(sim.getGimbal?.() ?? 0), z = sim.getGimbalZoom?.() ?? 1;
    const dpr = Math.min(2, (typeof devicePixelRatio !== 'undefined' && devicePixelRatio) || 1);
    const w = Math.round(rect.w * dpr), hh = Math.round(rect.h * dpr);
    const key = [w, hh, src, type, pal, g, z.toFixed(2)].join('|');
    if (!force && key === osdKey) return;
    osdKey = key;
    if (osd.width !== w || osd.height !== hh) { osd.width = w; osd.height = hh; }
    const c = osd.getContext('2d'); if (!c) return;
    c.setTransform(dpr, 0, 0, dpr, 0, 0); c.clearRect(0, 0, rect.w, rect.h);
    const col = onboard && type === 'night' ? 'rgba(190,255,200,.95)' : 'rgba(255,255,255,.95)';
    c.strokeStyle = col; c.fillStyle = col; c.lineWidth = 1.6; c.shadowColor = 'rgba(0,0,0,.65)'; c.shadowBlur = 3;
    const L = Math.min(18, rect.w * 0.07), m = 5;
    for (const [x, y, sx, sy] of [[m, m, 1, 1], [rect.w - m, m, -1, 1], [m, rect.h - m, 1, -1], [rect.w - m, rect.h - m, -1, -1]]) { c.beginPath(); c.moveTo(x, y + sy * L); c.lineTo(x, y); c.lineTo(x + sx * L, y); c.stroke(); }
    const fs = Math.max(9, Math.min(12, rect.w / 26));
    c.font = `700 ${fs}px ui-monospace, SFMono-Regular, Menlo, monospace`; c.textBaseline = 'top';
    const typeTxt = onboard ? `${tr(CAM_TYPE_SHORT[type])}${type === 'thermal' ? ` · ${(THERMAL_PALETTES.find(([k]) => k === pal) || THERMAL_PALETTES[0])[2]}` : ''}` : tr('GÜNDÜZ');
    c.fillText(`● ${typeTxt}`, m + 6, m + 4);
    c.textAlign = 'right';
    if (src === 'fpv') c.fillText(`×${z < 9.95 ? z.toFixed(1) : Math.round(z)}`, rect.w - m - 6, m + 4);
    c.textBaseline = 'bottom';
    c.fillText(tr(PIP_SOURCE_SHORT[src] || src), rect.w - m - 6, rect.h - m - 3);
    c.textAlign = 'left';
    if (src === 'fpv') c.fillText(`${tr('GMB')} ${g > 0 ? '+' : ''}${g}°`, m + 6, rect.h - m - 3);
    if (src === 'fpv') {   // merkez artı
      const cx = rect.w / 2, cy = rect.h / 2, a = Math.min(10, rect.w * 0.035);
      c.beginPath(); c.moveTo(cx - a, cy); c.lineTo(cx - a * 0.35, cy); c.moveTo(cx + a * 0.35, cy); c.lineTo(cx + a, cy); c.moveTo(cx, cy - a); c.lineTo(cx, cy - a * 0.35); c.moveTo(cx, cy + a * 0.35); c.lineTo(cx, cy + a); c.stroke();
    }
    box.dataset.src = src;
  }
  const osdT = setInterval(() => { if (!document.hidden) drawOsd(); }, 160);
  const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => layout()) : null;
  ro?.observe(mount);
  layout();
  return {
    el: box, layout, setOn, toggle, swap, redraw: () => drawOsd(true), get on() { return prefs.pip.on; }, get rect() { return rect ? { ...rect } : null; },
    overlay: () => (rect && !box.hidden && osd.width ? { canvas: osd, x: rect.x, y: rect.y, w: rect.w, h: rect.h } : null),
    dispose() { disposed = true; clearInterval(osdT); ro?.disconnect(); box.remove(); },
  };
}

// Alt çubuk denetimi "📷 Tür ▾": menüde tür (3), termal paleti (3), PiP aç/kapa + boyut, ipucu. Kısayollar (pencere): T tür döngüsü · Shift+T palet ·
// V PiP. opts: { getSim, tr, prefs, pip (createCameraPip) | getPip(), onType?(type), onPalette?(p) }. Dönüş: { el, sync, setType, dispose }
export function createCameraCtl(opts = {}) {
  const tr = opts.tr || (s => s), prefs = opts.prefs || createCamPrefs();
  const getSim = () => opts.getSim?.() || null;
  const P = () => opts.getPip?.() || opts.pip || null;   // PiP sonradan kurulabilir (getPip)
  const lbl = el('span', { class: 'fs-cam-lbl' });
  const ico = el('span', { class: 'fs-cam-ico', 'aria-hidden': 'true' }); ico.innerHTML = CAM_ICON_SVG;
  const mainBtn = el('button', { class: 'btn sm fs-cam-btn', type: 'button', title: tr('Kamera türü (T) · termal paleti (Shift+T) · PiP (V)'), onclick: () => { menu.hidden = !menu.hidden; sync(); } }, ico, lbl, ' ▾');
  const typeBtns = CAMERA_TYPES.map(([k, name]) => el('button', { class: 'btn sm', type: 'button', 'data-camtype': k, onclick: () => setType(k) }, tr(name)));
  const palBtns = THERMAL_PALETTES.map(([k, name]) => el('button', { class: 'btn sm', type: 'button', 'data-pal': k, onclick: () => setPalette(k) }, tr(name)));
  const palRow = el('div', { class: 'fs-cam-row' }, el('span', { class: 'small' }, tr('Palet')), el('div', { class: 'pill-group' }, palBtns));
  const pipInp = el('input', { type: 'checkbox', onchange: () => { P()?.setOn(pipInp.checked); sync(); } });
  const sizeBtns = PIP_SIZE_KEYS.map(k => el('button', { class: 'btn sm', type: 'button', 'data-size': k, onclick: () => { prefs.setPip({ size: k, on: true }); P()?.layout(); sync(); } }, k.toUpperCase()));
  const menu = el('div', { class: 'fs-audio-menu fs-cam-menu', hidden: true },
    el('div', { class: 'fs-cam-h' }, tr('Kamera türü')), el('div', { class: 'pill-group fs-cam-types' }, typeBtns), palRow,
    el('div', { class: 'fs-cam-row' }, el('label', { class: 'fs-audio-row fs-fpv-row' }, pipInp, el('span', null, tr('Kamera PiP'))), el('div', { class: 'pill-group' }, sizeBtns)),
    el('div', { class: 'small muted fs-cam-note' }, tr('Tür gimbal ve FPV kameralarına ve PiP\'e uygulanır; takip, serbest ve yer kameraları gündüz kalır.')),
    el('div', { class: 'small muted' }, tr('T: tür · Shift+T: palet · V: PiP · PiP\'e çift tık: gimbal')));
  const wrap = el('span', { class: 'fs-audio pill-group fs-cam-ctl' }, mainBtn, menu);
  const onDoc = e => { if (!menu.hidden && !wrap.contains(e.target)) menu.hidden = true; };
  document.addEventListener('click', onDoc, true);
  function sync() {
    const sim = getSim(), t = sim?.getCamType?.() || prefs.type, p = sim?.getThermalPalette?.() || prefs.palette;
    lbl.textContent = tr(CAM_TYPE_NAME_SHORT[t] || 'Gündüz');
    wrap.dataset.camtype = t;
    typeBtns.forEach(b => b.classList.toggle('primary', b.dataset.camtype === t));
    palBtns.forEach(b => b.classList.toggle('primary', b.dataset.pal === p));
    palRow.hidden = t !== 'thermal';
    pipInp.checked = prefs.pip.on;
    sizeBtns.forEach(b => b.classList.toggle('primary', b.dataset.size === prefs.pip.size));
    mainBtn.classList.toggle('primary', t !== 'day');
  }
  function setType(t) { t = normCamType(t); getSim()?.setCamType?.(t); prefs.setType(t); opts.onType?.(t); P()?.redraw(); sync(); }
  function setPalette(p) { p = normPalette(p); getSim()?.setThermalPalette?.(p); prefs.setPalette(p); opts.onPalette?.(p); P()?.redraw(); sync(); }
  const onKey = e => {
    if (e.ctrlKey || e.metaKey || e.altKey || editable(document.activeElement) || editable(e.target)) return;
    const k = e.key.toLowerCase();
    if (k === 't') { if (e.shiftKey) { if ((getSim()?.getCamType?.() || prefs.type) !== 'thermal') setType('thermal'); else setPalette(nextPalette(getSim()?.getThermalPalette?.() || prefs.palette)); } else setType(nextCamType(getSim()?.getCamType?.() || prefs.type)); e.preventDefault(); }
    else if (k === 'v' && !e.shiftKey) { P()?.toggle(); sync(); e.preventDefault(); }
  };
  const onEsc = e => { if (e.key === 'Escape' && !menu.hidden) { menu.hidden = true; e.preventDefault(); } };   // açık menü: Esc yalnız menüyü kapatır (oturumdan çıkmaz; yakalama evresi)
  window.addEventListener('keydown', onKey);
  window.addEventListener('keydown', onEsc, true);
  sync();
  return { el: wrap, sync, setType, setPalette, dispose() { window.removeEventListener('keydown', onKey); window.removeEventListener('keydown', onEsc, true); document.removeEventListener('click', onDoc, true); wrap.remove(); } };
}

// ---------------------------------------------------------------- önizleme (2B tuval, CPU) ----------------------------------------------------------------
// Prosedürel küçük sahne: gökyüzü, uzak tepeler, tarla, yol, göl, ağaçlar, ev (yanan pencere), araç (sıcak motor), insan, dron. Renk katmanı + ısı
// katmanı ayrı çizilir; tür piksel piksel camFxPixel ile (gölgelendiriciyle aynı formül) işlenir. Tohumlu gürültü → kararlı görüntü.
function sceneLayers(w, h, night) {
  const mk = () => { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; };
  const col = mk(), heat = mk(), C = col.getContext('2d', { willReadFrequently: true }), Hc = heat.getContext('2d', { willReadFrequently: true });   // CPU tamponu (getImageData GPU geri okuması olmasın)
  const dim = night ? 0.12 : 1;
  const rgb = (r, g, b) => `rgb(${Math.round(r * dim)},${Math.round(g * dim)},${Math.round(b * dim)})`;
  const hv = v => { const x = Math.round(Math.min(1, Math.max(0, v)) * 255); return `rgb(${x},${x},${x})`; };
  const both = (fillCol, heatV, draw) => { C.fillStyle = fillCol; Hc.fillStyle = hv(heatV); draw(C); draw(Hc); };
  const sky = C.createLinearGradient(0, 0, 0, h * 0.5); sky.addColorStop(0, rgb(110, 165, 225)); sky.addColorStop(1, rgb(200, 222, 240));
  C.fillStyle = sky; C.fillRect(0, 0, w, h); Hc.fillStyle = hv(0.05); Hc.fillRect(0, 0, w, h);
  const hill = g => { g.beginPath(); g.moveTo(0, h * 0.46); for (let i = 0; i <= 12; i++) g.lineTo(w * i / 12, h * (0.40 + 0.06 * Math.sin(i * 1.7) + 0.03 * Math.cos(i * 3.1))); g.lineTo(w, h); g.lineTo(0, h); g.fill(); };
  both(rgb(96, 128, 110), 0.3, hill);
  both(rgb(118, 152, 82), 0.36, g => g.fillRect(0, h * 0.52, w, h));
  both(rgb(70, 72, 76), 0.52, g => { g.beginPath(); g.moveTo(w * 0.40, h * 0.52); g.lineTo(w * 0.52, h * 0.52); g.lineTo(w * 0.86, h); g.lineTo(w * 0.18, h); g.fill(); });   // yol (asfalt güneşte ılık)
  both(rgb(60, 110, 160), 0.06, g => { g.beginPath(); g.ellipse(w * 0.14, h * 0.66, w * 0.12, h * 0.06, 0, 0, Math.PI * 2); g.fill(); });   // göl (soğuk)
  for (const [x, y, r] of [[0.66, 0.5, 0.05], [0.72, 0.52, 0.06], [0.93, 0.56, 0.07], [0.30, 0.5, 0.04], [0.04, 0.53, 0.05]]) both(rgb(46, 92, 50), 0.2, g => { g.beginPath(); g.arc(w * x, h * y, h * r * 1.6, 0, Math.PI * 2); g.fill(); });
  both(rgb(196, 176, 150), 0.5, g => g.fillRect(w * 0.76, h * 0.42, w * 0.13, h * 0.12));   // ev
  both(rgb(150, 70, 52), 0.42, g => { g.beginPath(); g.moveTo(w * 0.745, h * 0.425); g.lineTo(w * 0.825, h * 0.35); g.lineTo(w * 0.905, h * 0.425); g.fill(); });
  C.fillStyle = night ? 'rgb(255,226,150)' : rgb(80, 110, 140); Hc.fillStyle = hv(0.7); for (const g of [C, Hc]) { g.fillRect(w * 0.785, h * 0.455, w * 0.025, h * 0.035); g.fillRect(w * 0.84, h * 0.455, w * 0.025, h * 0.035); }
  // araç: gövde ılık, motor kaputu ve tekerlekler sıcak; farlar (gece parlak)
  both(rgb(205, 40, 36), 0.62, g => g.fillRect(w * 0.47, h * 0.70, w * 0.13, h * 0.07));
  both(rgb(185, 34, 30), 0.98, g => g.fillRect(w * 0.47, h * 0.715, w * 0.035, h * 0.05));
  both(rgb(30, 30, 30), 0.78, g => { for (const x of [0.49, 0.575]) { g.beginPath(); g.arc(w * x, h * 0.775, h * 0.022, 0, Math.PI * 2); g.fill(); } });
  C.fillStyle = night ? 'rgb(255,250,225)' : rgb(240, 236, 200); C.fillRect(w * 0.465, h * 0.718, w * 0.008, h * 0.014);
  // insan
  both(rgb(40, 60, 120), 0.86, g => { g.fillRect(w * 0.33, h * 0.64, w * 0.016, h * 0.075); g.beginPath(); g.arc(w * 0.338, h * 0.628, h * 0.014, 0, Math.PI * 2); g.fill(); });
  // dron (gökyüzünde): gövde ılık, motorlar sıcak
  both(rgb(40, 44, 50), 0.6, g => g.fillRect(w * 0.6, h * 0.2, w * 0.05, h * 0.016));
  both(rgb(30, 30, 30), 0.95, g => { for (const x of [0.598, 0.652]) { g.beginPath(); g.arc(w * x, h * 0.2, h * 0.013, 0, Math.PI * 2); g.fill(); } });
  if (night) { C.fillStyle = 'rgb(255,60,60)'; C.fillRect(w * 0.597, h * 0.205, 2, 2); }
  return { col, heat };
}
export function drawCamPreview(canvas, type, o = {}) {
  const w = canvas.width, h = canvas.height;
  const night = type === 'night';
  const { col, heat } = sceneLayers(w, h, night);
  const g = canvas.getContext('2d'); if (!g) return;
  if (type === 'day' || !type) { g.drawImage(col, 0, 0); return; }
  const cd = col.getContext('2d').getImageData(0, 0, w, h).data, hd = heat.getContext('2d').getImageData(0, 0, w, h).data;
  const out = g.createImageData(w, h), od = out.data;
  let seed = 1234567;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
  const gain = nightGain('night');
  // gece halosu (CPU): parlak piksellerin kaba çevresi — 4 px adımda örnekleyip 6 px yarıçapta yay
  let halo = null;
  if (night) {
    halo = new Float32Array(w * h);
    for (let y = 0; y < h; y += 2) for (let x = 0; x < w; x += 2) {
      const i = (y * w + x) * 4, L = (0.299 * cd[i] + 0.587 * cd[i + 1] + 0.114 * cd[i + 2]) / 255 * gain - 0.8;
      if (L <= 0) continue;
      const R = Math.max(4, Math.round(h * 0.05));
      for (let dy = -R; dy <= R; dy += 1) for (let dx = -R; dx <= R; dx += 1) {
        const X = x + dx, Y = y + dy; if (X < 0 || Y < 0 || X >= w || Y >= h) continue;
        const f = 1 - Math.hypot(dx, dy) / R; if (f > 0) halo[Y * w + X] += L * f * 0.35;
      }
    }
  }
  // Hızlı yol: 1024 girişli renk tablosu (camFxPixel ile aynı eğri) + piksel başına vinyet; gürültü girişe eklenir (önizleme için yeterli)
  const aspect = w / h, N = 1024, MAXV = type === 'night' ? 1.3 : 1, lut = new Float32Array(N * 3);
  for (let k = 0; k < N; k++) { const c = camFxPixel(k / (N - 1) * MAXV, type, { palette: o.palette || 'white', gain: 1 }); lut[k * 3] = c[0]; lut[k * 3 + 1] = c[1]; lut[k * 3 + 2] = c[2]; }
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const p = y * w + x, i = p * 4, n = rnd() - 0.5;
    const rr = Math.hypot((x / w - 0.5) * aspect, y / h - 0.5);
    let v, vig;
    if (type === 'thermal') { v = hd[i] / 255 + n * 0.045; vig = 1 - 0.18 * smoothstep(0.55, 1, rr); }
    else { v = (0.299 * cd[i] + 0.587 * cd[i + 1] + 0.114 * cd[i + 2]) / 255 * gain + (halo ? halo[p] * 0.2 : 0) + n * 0.17; vig = 1 - smoothstep(0.4, 0.8, rr); }
    const k = Math.max(0, Math.min(N - 1, Math.round(v / MAXV * (N - 1)))) * 3;
    od[i] = lut[k] * vig * 255; od[i + 1] = lut[k + 1] * vig * 255; od[i + 2] = lut[k + 2] * vig * 255; od[i + 3] = 255;
  }
  g.putImageData(out, 0, 0);
}

// Sihirbaz kartları (HEPGO: kart ızgarası; SIMUMAV camera_pick.js kendi oyun kartlarını aynı önizlemeyle çizer). opts: { tr, value, palette, onChange(type),
// onPalette(p), cls } → { el, value, palette, set(type), redraw() }
export function createCameraCards(opts = {}) {
  const tr = opts.tr || (s => s);
  let value = normCamType(opts.value), palette = normPalette(opts.palette);
  const dpr = Math.min(2, (typeof devicePixelRatio !== 'undefined' && devicePixelRatio) || 1);
  const cards = CAMERA_TYPES.map(([k, name, desc]) => {
    const cv = el('canvas', { class: 'fs-cam-prev', width: String(Math.round(240 * dpr)), height: String(Math.round(135 * dpr)), 'aria-hidden': 'true' });
    const b = el('button', { type: 'button', class: `fs-type fs-cam-card ${opts.cls || ''}`, 'data-camtype': k, 'aria-pressed': 'false', onclick: () => set(k, true) },
      cv, el('b', null, tr(name)), el('span', { class: 'small muted' }, tr(desc)));
    b.__cv = cv;
    return b;
  });
  const palBtns = THERMAL_PALETTES.map(([k, name]) => el('button', { type: 'button', class: 'btn sm', 'data-pal': k, onclick: () => { palette = k; opts.onPalette?.(k); drawPal(); drawPrev('thermal'); } }, tr(name)));
  const palRow = el('div', { class: 'fs-cam-pal' }, el('span', { class: 'small muted' }, tr('Termal paleti')), el('div', { class: 'pill-group' }, palBtns));
  const root = el('div', { class: 'fs-cam-cards' }, el('div', { class: 'fs-cam-grid' }, cards), palRow);
  const drawPrev = only => cards.forEach(b => { if (!only || b.dataset.camtype === only) drawCamPreview(b.__cv, b.dataset.camtype, { palette }); });
  const drawPal = () => { palBtns.forEach(b => b.classList.toggle('primary', b.dataset.pal === palette)); palRow.hidden = value !== 'thermal'; };
  function set(k, user = false) {
    value = normCamType(k);
    cards.forEach(b => { const on = b.dataset.camtype === value; b.classList.toggle('on', on); b.setAttribute('aria-pressed', on ? 'true' : 'false'); });
    drawPal();
    if (user) opts.onChange?.(value);
  }
  set(value); drawPrev();
  return { el: root, get value() { return value; }, get palette() { return palette; }, set, redraw: () => drawPrev() };
}
