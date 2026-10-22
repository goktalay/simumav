// Uçuş Simülatörü §43 — GRAFİK KALİTE AYARLARI, saf katman (HEPGO flightsim.js + SIMUMAV fly/session.js ortak; docs/ucus-simulatoru.md §43).
// Ön ayarlar: Otomatik (varsayılan) / Düşük / Orta / Yüksek / Ultra + Özel (ince ayar). Her ön ayar tek bir parametre nesnesine çözülür
// (resolveGfx); flightsim3d.js setGraphics(params) bunu TEK paylaşılan WebGL renderer üzerinde canlı uygular (flightsim_gfx3d.js son işlem hattı).
// • Otomatik: ilk açılışta cihazdan (GPU adı WEBGL_debug_renderer_info, dpr, çekirdek, bellek, mobil) kademe seçilir (autoLevel) + uyarlamalı
//   kip (createAdaptive): FPS sürekli hedefin altındaysa önce çözünürlük ölçeği, sonra kademe düşer; sürekli yüksekse geri çıkar (histerezis:
//   bekleme süresi + aynı kademeye dönüş kilidi, her tekrarda iki katı). Kullanıcı elle seçince uyarlamalı kip kapanır.
// • Dinamik çözünürlük (createDynRes): ayrı kutu; yalnız çözünürlük ölçeğini (0,5…1) hedef FPS'e göre küçük adımlarla ayarlar (elle ön ayarda da).
// • Kalıcı tercih: HEPGO localStorage `fs.gfx`, SIMUMAV `sm.gfx` (normGfxPref / loadGfxPref / saveGfxPref).
// Metinler GFX_TEXTS [anahtar, Türkçe] — HEPGO'da Türkçe metin sözlük anahtarı, SIMUMAV'da `gfx.*` (keyed=true; 7 dil; yoksa Türkçe).
// Saf kısım node testi: tests/test_flightsim_gfx.mjs.

export const GFX_LEVELS = ['low', 'medium', 'high', 'ultra'];
export const GFX_CHOICES = ['auto', ...GFX_LEVELS, 'custom'];
export const GFX_KEY = 'fs.gfx';
export const GFX_KEY_SM = 'sm.gfx';
export const AA_MODES = ['off', 'fxaa', 'msaa4', 'msaa8'];
export const SHADOW_SIZES = [0, 1024, 2048, 4096];
export const ANISO_STEPS = [1, 2, 4, 8, 16];
export const FPS_CAPS = [30, 60, 0];          // 0 = sınırsız (ekran yenileme hızı)
export const PIP_FPS_STEPS = [10, 15, 20, 30];
// Arazi ayrıntı düzeyi (0…3) → ızgara yoğunlukları: prosedürel ana kare / ufuk halkası, gerçek arazi ana ızgara / uzak arazi halkası
export const TERRAIN_LOD = [
  { grid: 192, ring: 64, real: 192, far: 128 },
  { grid: 256, ring: 96, real: 256, far: 160 },
  { grid: 320, ring: 128, real: 256, far: 192 },   // = eski sabit değerler (Yüksek)
  { grid: 448, ring: 192, real: 384, far: 256 },
];
// Doku çözünürlüğü (0…2) → gerçek arazi uydu atlası azami kenarı (px); 2 yalnız MAX_TEXTURE_SIZE ≥ 8192 ise
export const ATLAS_MAX = [2048, 4096, 8192];

// Ön ayar tablosu. Yüksek = §43 öncesi sabit davranış (dpr ≤ 2, MSAA 4×, gölge 2048 ±90 m, sis 1×, ızgara 320, ağaç 1×, LOD 520 m, aniso 8×,
// PiP 0,75 / 30 fps, Google karo eşiği 16) + son işlem. Alanlar:
//  scale: dpr çarpanı · prCap: azami piksel oranı · budget: azami piksel bütçesi (MP) · aa · shadow (harita px, 0 kapalı) · shadowDist (gölge kutusu yarı
//  genişliği m) · shadowSoft · objCast (bina/ağaç gölge düşürür) · terrainCast (arazi gölge düşürür) · cascade (Ultra: yakın+uzak kapsam kameraya göre)
//  fog (görüş/sis uzaklığı çarpanı) · terrain (0–3) · trees (ağaç yoğunluğu çarpanı) · treeLod (3B ağaç LOD mesafesi m) · aniso · tex (doku çöz. 0–2)
//  water (0 basit, 1 normal, 2 ayrıntılı) · precip (yağış parçacık kalitesi 0,25–1) · post (son işlem) · bloom · ao (0 yok, 1 yarım, 2 tam çözünürlük)
//  vignette · grade (renk derecelendirme) · pipScale / pipFps (PiP, radar, EO, nişangâh) · fpsCap · g3dError (Google karo hata eşiği px) · g3dCache (MB)
export const GFX_PRESETS = {
  low: { scale: 0.75, prCap: 1, budget: 1.3, aa: 'off', shadow: 0, shadowDist: 60, shadowSoft: false, objCast: false, terrainCast: false, cascade: false,
    fog: 0.6, terrain: 0, trees: 0.35, treeLod: 300, aniso: 2, tex: 0, water: 0, precip: 0.35,
    post: false, bloom: 0, ao: 0, vignette: 0, grade: 0, pipScale: 0.5, pipFps: 15, fpsCap: 30, g3dError: 28, g3dCache: 200 },
  medium: { scale: 1, prCap: 1.5, budget: 2.6, aa: 'msaa4', shadow: 1024, shadowDist: 70, shadowSoft: false, objCast: true, terrainCast: false, cascade: false,
    fog: 0.85, terrain: 1, trees: 0.65, treeLod: 420, aniso: 4, tex: 1, water: 1, precip: 0.6,
    post: false, bloom: 0, ao: 0, vignette: 0, grade: 0, pipScale: 0.75, pipFps: 20, fpsCap: 60, g3dError: 20, g3dCache: 300 },
  high: { scale: 1, prCap: 2, budget: 5, aa: 'msaa4', shadow: 2048, shadowDist: 90, shadowSoft: true, objCast: true, terrainCast: false, cascade: false,
    fog: 1, terrain: 2, trees: 1, treeLod: 520, aniso: 8, tex: 1, water: 1, precip: 1,
    post: true, bloom: 0.35, ao: 1, vignette: 0.16, grade: 0.5, pipScale: 1, pipFps: 30, fpsCap: 60, g3dError: 14, g3dCache: 400 },
  ultra: { scale: 1.5, prCap: 3, budget: 8.3, aa: 'msaa8', shadow: 4096, shadowDist: 140, shadowSoft: true, objCast: true, terrainCast: true, cascade: true,
    fog: 1.3, terrain: 3, trees: 1.25, treeLod: 800, aniso: 16, tex: 2, water: 2, precip: 1,
    post: true, bloom: 0.45, ao: 2, vignette: 0.2, grade: 0.7, pipScale: 1.25, pipFps: 30, fpsCap: 0, g3dError: 8, g3dCache: 600 },
};
// Özel (ince ayar) alanlarının sınırları / izinli değerleri — UI kaydırıcıları ve normCustom aynı tablodan
export const GFX_LIMITS = {
  scale: [0.5, 1.5], budget: [0.5, 12], shadowDist: [30, 250], fog: [0.4, 1.6], trees: [0, 1.25], treeLod: [150, 1200], precip: [0.25, 1],
  bloom: [0, 1], vignette: [0, 0.5], grade: [0, 1], pipScale: [0.4, 1.5], g3dError: [4, 40], g3dCache: [100, 1000],
};
const ENUMS = { aa: AA_MODES, shadow: SHADOW_SIZES, aniso: ANISO_STEPS, fpsCap: FPS_CAPS, pipFps: PIP_FPS_STEPS, terrain: [0, 1, 2, 3], tex: [0, 1, 2], water: [0, 1, 2], ao: [0, 1, 2] };
const BOOLS = ['shadowSoft', 'objCast', 'terrainCast', 'cascade', 'post'];

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const num = (v, d) => (v == null || v === '' || !Number.isFinite(Number(v)) ? d : Number(v));
export const levelIndex = l => Math.max(0, GFX_LEVELS.indexOf(l));
export const isLevel = l => GFX_LEVELS.includes(l);

/** Özel ayar nesnesi: yalnız bilinen alanlar, aralık içinde (bilinmeyen/bozuk alan atılır). */
export function normCustom(o) {
  const out = {};
  if (!o || typeof o !== 'object') return out;
  for (const [k, v] of Object.entries(o)) {
    if (GFX_LIMITS[k]) { const n = num(v, null); if (n != null) out[k] = clamp(n, GFX_LIMITS[k][0], GFX_LIMITS[k][1]); }
    else if (ENUMS[k]) { const e = ENUMS[k]; const val = typeof e[0] === 'number' ? num(v, null) : v; if (e.includes(val)) out[k] = val; }
    else if (BOOLS.includes(k) && typeof v === 'boolean') out[k] = v;
  }
  return out;
}

/** Kalıcı tercih: { preset: 'auto'|low|medium|high|ultra|custom, base (özelin tabanı), custom {}, dynRes, fpsCounter, fpsCap (null = ön ayarın), bgThrottle, autoLevel (son otomatik kademe) } */
export function normGfxPref(o) {
  const p = o && typeof o === 'object' ? o : {};
  return {
    preset: GFX_CHOICES.includes(p.preset) ? p.preset : 'auto',
    base: isLevel(p.base) ? p.base : 'high',
    custom: normCustom(p.custom),
    dynRes: !!p.dynRes,
    fpsCounter: !!p.fpsCounter,
    fpsCap: FPS_CAPS.includes(num(p.fpsCap, NaN)) ? Number(p.fpsCap) : null,
    bgThrottle: p.bgThrottle !== false,
    autoLevel: isLevel(p.autoLevel) ? p.autoLevel : null,
  };
}
export function loadGfxPref(storage = globalThis.localStorage, key = GFX_KEY) {
  try { return normGfxPref(JSON.parse(storage?.getItem(key) || 'null')); } catch { return normGfxPref(null); }
}
export function saveGfxPref(pref, storage = globalThis.localStorage, key = GFX_KEY) {
  const p = normGfxPref(pref);
  try { storage?.setItem(key, JSON.stringify(p)); } catch { /* gizli kip / kota */ }
  return p;
}

// ---------- cihaz → otomatik kademe ----------
const SOFT_RE = /swiftshader|llvmpipe|softpipe|software|basic render|microsoft basic|mesa offscreen/i;
const HIGH_RE = /rtx\s*[2-9]0[6-9]0|rtx\s*[4-9]0[7-9]0|rtx\s*a[4-6]000|rx\s*[67][89]\d\d|rx\s*7[6-9]00|radeon pro w|apple m[1-9]\s*(pro|max|ultra)|arc\s*a7/i;
const DISCRETE_RE = /geforce|rtx|gtx|quadro|radeon\s*(rx|pro|r9|vii)|\brx\s*\d{3,4}|arc\s*a\d|apple m\d|apple gpu/i;
const WEAK_RE = /intel.*hd graphics\s*[2-5]\d{2}\b|intel.*hd graphics\s*$|mali-[gt][0-6]\d\b|adreno\s*[1-5]\d{2}\b|powervr|videocore|gma/i;

/**
 * Cihaz bilgisinden önerilen kademe. dev: { gpu (WEBGL_debug_renderer_info dizesi), dpr, cores (hardwareConcurrency), mem (deviceMemory GB; tarayıcı ≤ 8),
 * mobile, maxTex }. Dönüş { level, tier ('soft'|'weak'|'mid'|'discrete'|'high'), max (uyarlamalı kipin çıkabileceği en üst kademe), reason }.
 */
export function autoLevel(dev = {}) {
  const gpu = String(dev.gpu || ''), dpr = num(dev.dpr, 1), cores = num(dev.cores, 4), mem = num(dev.mem, 4), mobile = !!dev.mobile;
  let tier = 'mid';
  if (SOFT_RE.test(gpu)) tier = 'soft';
  else if (WEAK_RE.test(gpu)) tier = 'weak';
  else if (HIGH_RE.test(gpu)) tier = 'high';
  else if (DISCRETE_RE.test(gpu)) tier = 'discrete';
  let level;
  if (tier === 'soft') level = 'low';
  else if (mobile) level = (tier === 'weak' || mem <= 3 || cores <= 4) ? 'low' : 'medium';
  else if (tier === 'weak') level = 'low';
  else if (tier === 'high') level = cores >= 8 && mem >= 8 ? 'ultra' : 'high';
  else if (tier === 'discrete') level = cores >= 4 && mem >= 4 ? 'high' : 'medium';
  else level = (cores <= 2 || mem <= 2) ? 'low' : 'medium';   // tümleşik / bilinmeyen
  // Yüksek dpr'li tümleşik ekran (ör. 4K dizüstü): bir kademe aşağı (piksel sayısı 4×)
  if (dpr >= 2.5 && (tier === 'mid' || tier === 'weak') && level !== 'low') level = GFX_LEVELS[levelIndex(level) - 1];
  const max = tier === 'soft' ? 'low' : mobile ? (level === 'low' ? 'medium' : 'high') : GFX_LEVELS[Math.min(3, levelIndex(level) + 1)];
  return { level, tier, max, reason: `${tier}${mobile ? ' · mobil' : ''} · ${cores} çekirdek · ${mem} GB · dpr ${dpr}` };
}

/**
 * Tercih + yetenekler → uygulanacak parametreler. caps: { maxSamples, maxAniso, maxTex, mobile, autoLevel } (yoksa makul varsayılan).
 * Otomatik kipte kademe pref.autoLevel (uyarlamalı son durum) || caps.autoLevel || 'medium'; kare sınırı otomatikte 60 (elle ön ayarda ön ayarın).
 * scaleMul: uyarlamalı/dinamik çözünürlüğün ölçek çarpanı (1 = ön ayar ölçeği).
 */
export function resolveGfx(prefIn, caps = {}, { level: levelOverride = null, scaleMul = 1 } = {}) {
  const pref = normGfxPref(prefIn);
  const auto = pref.preset === 'auto', custom = pref.preset === 'custom';
  const level = isLevel(levelOverride) ? levelOverride : auto ? (pref.autoLevel || (isLevel(caps.autoLevel) ? caps.autoLevel : 'medium')) : custom ? pref.base : pref.preset;
  const p = { ...GFX_PRESETS[level], ...(custom ? pref.custom : {}) };
  if (auto) p.fpsCap = 60;
  if (pref.fpsCap != null) p.fpsCap = pref.fpsCap;
  const maxSamples = Math.max(0, num(caps.maxSamples, 4)), maxAniso = Math.max(1, num(caps.maxAniso, 16)), maxTex = num(caps.maxTex, 8192);
  const samples = p.aa === 'msaa8' ? Math.min(8, maxSamples) : p.aa === 'msaa4' ? Math.min(4, maxSamples) : 0;
  return {
    ...p, preset: pref.preset, level, auto, dynRes: pref.dynRes,
    scale: clamp(p.scale * clamp(num(scaleMul, 1), 0.3, 1.5), 0.3, 1.5), scaleMul: clamp(num(scaleMul, 1), 0.3, 1.5),
    samples, fxaa: p.aa === 'fxaa', aniso: Math.min(p.aniso, maxAniso),
    tex: p.tex >= 2 && maxTex < 8192 ? 1 : p.tex, atlasMax: ATLAS_MAX[p.tex >= 2 && maxTex < 8192 ? 1 : p.tex],
    terrainLod: TERRAIN_LOD[p.terrain] || TERRAIN_LOD[2],
    bgThrottle: pref.bgThrottle,
  };
}

/** §43 öncesi sabit davranış (opts.gfx verilmeyen çağıranlar: önizleme, kayıt oynatıcı vb.): Yüksek, son işlem kapalı. */
export const GFX_LEGACY = Object.freeze(resolveGfx({ preset: 'custom', base: 'high', custom: { post: false, bloom: 0, vignette: 0, grade: 0, ao: 0, pipScale: 1 } }));

/**
 * Render piksel oranı: dpr × ölçek, ön ayarın tavanı ve piksel bütçesi (cssW × cssH × pr² ≤ budget MP) ile sınırlı, en az 0,5.
 * floor: ekran kaydı sırasında taban (kayıt çözünürlüğü bozulmasın) — bütçeye rağmen uygulanır.
 */
export function pixelRatioFor(p, { dpr = 1, cssW = 1280, cssH = 720, floor = 0 } = {}) {
  const d = Math.max(0.5, num(dpr, 1));
  let pr = Math.min(d * num(p?.scale, 1), num(p?.prCap, 2), d * 1.5);
  const px = Math.max(1, cssW * cssH), bud = num(p?.budget, 8) * 1e6;
  if (px * pr * pr > bud) pr = Math.sqrt(bud / px);
  pr = Math.max(0.5, pr);
  if (floor > 0) pr = Math.max(pr, Math.min(floor, d * 1.5));
  return Math.floor(pr * 1000 + 1e-6) / 1000;   // aşağı yuvarla: bütçe aşılmasın
}
/** Ekran kaydı tabanı: tuval tamponu en az kayıt hedefi (varsayılan 1280×720) olsun; dpr'yi aşmaz. */
export const recordFloor = (cssW, cssH, dpr = 1, tw = 1280, th = 720) => Math.min(Math.max(1, num(dpr, 1)), Math.max(tw / Math.max(1, cssW), th / Math.max(1, cssH)));

/** Kare sınırı: bu kare çizilmeli mi? cap 0 = sınırsız; arka planda (odak yok) kısma açıksa en çok 20 fps. Dönüş { draw, next } (next: sonraki hedef zaman). */
export function frameGate(now, nextAt, cap, { background = false, bgThrottle = true } = {}) {
  let c = num(cap, 0);
  if (background && bgThrottle) c = c > 0 ? Math.min(c, 20) : 20;
  if (!(c > 0)) return { draw: true, next: 0 };
  const iv = 1000 / c;
  if (now + 1.5 < nextAt) return { draw: false, next: nextAt };   // 1,5 ms tolerans: rAF zamanı titrer
  const next = nextAt > 0 && now - nextAt < iv ? nextAt + iv : now + iv;   // sürüklenmesiz; uzun duraklamadan sonra yeniden hizalan
  return { draw: true, next };
}

/**
 * Uyarlamalı kademe denetleyicisi (Otomatik kip). push(fps, now) her ~0,5 sn çağrılır; değişiklik gerekiyorsa { level, scaleMul, dir, reason } döner.
 * Kurallar: fps < target sürekli `downMs` (5 sn) → önce ölçek (1 → 0,85 → 0,7), sonra bir kademe aşağı (ölçek 1'e döner).
 * fps ≥ up sürekli `upMs` (12 sn) → ölçek varsa geri, yoksa bir kademe yukarı (en çok `max`). Her değişiklikten sonra `cooldownMs` beklenir.
 * Bir kademeden aşağı inilince o kademeye dönüş `lockMs` kilitlenir; aynı kademeden tekrar inilirse kilit iki katına çıkar (≤ 10 dk) → titreme yok.
 * dynRes açıkken ölçek adımları atlanır (ölçeği dinamik çözünürlük yönetir).
 */
export function createAdaptive({ level = 'medium', max = 'ultra', min = 'low', target = 40, up = 57, downMs = 5000, upMs = 12000, cooldownMs = 6000, lockMs = 30000, scaleSteps = [1, 0.85, 0.7], dynRes = false, cap = 60 } = {}) {
  const st = { level: isLevel(level) ? level : 'medium', si: 0, below: null, above: null, lastChange: -Infinity, lock: {}, lockLen: {}, changes: 0 };
  const capped = c => (c > 0 ? Math.min(up, c * 0.93) : up);
  let upThr = capped(cap), lowThr = cap > 0 ? Math.min(target, cap * 0.8) : target;
  const out = (dir, reason) => { st.lastChange = st.now; st.below = st.above = null; st.changes++; return { level: st.level, scaleMul: scaleSteps[st.si], dir, reason }; };
  return {
    get level() { return st.level; }, get scaleMul() { return scaleSteps[st.si]; }, get changes() { return st.changes; },
    lockedUntil: l => st.lock[l] || 0,
    setCap(c) { upThr = capped(num(c, 60)); lowThr = c > 0 ? Math.min(target, c * 0.8) : target; },
    setDynRes(v) { dynRes = !!v; if (dynRes) st.si = 0; },
    reset(l) { if (isLevel(l)) st.level = l; st.si = 0; st.below = st.above = null; },
    push(fps, now) {
      st.now = now;
      const f = num(fps, NaN);
      if (!Number.isFinite(f)) return null;
      if (now - st.lastChange < cooldownMs) return null;
      st.below = f < lowThr ? (st.below ?? now) : null;
      st.above = f >= upThr ? (st.above ?? now) : null;
      if (st.below != null && now - st.below >= downMs) {
        if (!dynRes && st.si < scaleSteps.length - 1) { st.si++; return out(-1, 'scale'); }
        const i = levelIndex(st.level);
        if (i > levelIndex(min)) {
          const from = st.level;
          st.lockLen[from] = Math.min(600000, st.lockLen[from] ? st.lockLen[from] * 2 : lockMs);
          st.lock[from] = now + st.lockLen[from];
          st.level = GFX_LEVELS[i - 1]; st.si = 0;
          return out(-1, 'level');
        }
        st.below = null;
        return null;
      }
      if (st.above != null && now - st.above >= upMs) {
        if (!dynRes && st.si > 0) { st.si--; return out(1, 'scale'); }
        const i = levelIndex(st.level), nx = GFX_LEVELS[i + 1];
        if (nx && i < levelIndex(max) && now >= (st.lock[nx] || 0)) { st.level = nx; st.si = 0; return out(1, 'level'); }
        st.above = null;
      }
      return null;
    },
  };
}

/** Dinamik çözünürlük: her push (~0,5 sn) ölçek çarpanını 0,05 adımla hedef FPS'e yaklaştırır (min…max). Değişince yeni çarpanı, yoksa null döner. */
export function createDynRes({ target = 50, min = 0.5, max = 1, step = 0.05, cap = 60 } = {}) {
  let k = max, upThr = cap > 0 ? Math.min(target * 1.12, cap * 0.95) : target * 1.12, lowThr = cap > 0 ? Math.min(target * 0.9, cap * 0.85) : target * 0.9;
  return {
    get scale() { return k; },
    setCap(c) { upThr = c > 0 ? Math.min(target * 1.12, c * 0.95) : target * 1.12; lowThr = c > 0 ? Math.min(target * 0.9, c * 0.85) : target * 0.9; },
    reset() { k = max; },
    push(fps) {
      const f = num(fps, NaN);
      if (!Number.isFinite(f)) return null;
      const k0 = k;
      if (f < lowThr) k = Math.max(min, k - step * (f < lowThr * 0.7 ? 2 : 1));
      else if (f >= upThr) k = Math.min(max, k + step);
      k = Math.round(k * 100) / 100;
      return k !== k0 ? k : null;
    },
  };
}

/** Mobilde Yüksek/Ultra seçilince pil/ısınma uyarısı gösterilsin mi */
export const mobileWarn = (choice, mobile, base = 'high') => !!mobile && (choice === 'high' || choice === 'ultra' || (choice === 'custom' && (base === 'high' || base === 'ultra')));

// ---------- metinler ----------
export const GFX_TEXTS = [
  ['gfx.btn', 'Grafik'], ['gfx.btn_title', 'Grafik kalitesi: ön ayar, çözünürlük, gölge, görüş mesafesi, son işlem; canlı FPS'],
  ['gfx.title', 'Grafik kalitesi'], ['gfx.auto', 'Otomatik'], ['gfx.low', 'Düşük'], ['gfx.medium', 'Orta'], ['gfx.high', 'Yüksek'], ['gfx.ultra', 'Ultra'], ['gfx.custom', 'Özel'],
  ['gfx.auto_now', 'Otomatik: şu an {l}'], ['gfx.auto_hint', 'Cihaza göre seçilir; kare hızı düşerse önce çözünürlük, sonra kalite düşer'],
  ['gfx.fps', 'FPS'], ['gfx.calls', 'Çizim çağrısı'], ['gfx.tris', 'Üçgen'], ['gfx.res', 'Çözünürlük'],
  ['gfx.scale', 'Çözünürlük ölçeği'], ['gfx.aa', 'Kenar yumuşatma'], ['gfx.aa_off', 'Kapalı'], ['gfx.aa_fxaa', 'FXAA'], ['gfx.aa_msaa4', 'MSAA 4×'], ['gfx.aa_msaa8', 'MSAA 8×'],
  ['gfx.shadow', 'Gölgeler'], ['gfx.off', 'Kapalı'], ['gfx.shadow_dist', 'Gölge mesafesi'], ['gfx.fog', 'Görüş mesafesi'], ['gfx.terrain', 'Arazi ayrıntısı'],
  ['gfx.trees', 'Bitki yoğunluğu'], ['gfx.aniso', 'Doku filtreleme'], ['gfx.water', 'Su kalitesi'], ['gfx.precip', 'Yağış parçacıkları'],
  ['gfx.post', 'Son işlem (ACES, bloom, vinyet)'], ['gfx.bloom', 'Parlama (bloom)'], ['gfx.ao', 'Ortam gölgesi (SSAO)'], ['gfx.ao_half', 'Yarım'], ['gfx.ao_full', 'Tam'],
  ['gfx.pip', 'PiP / radar / EO çözünürlüğü'], ['gfx.pip_fps', 'PiP güncelleme'], ['gfx.fps_cap', 'Kare hızı sınırı'], ['gfx.unlimited', 'Sınırsız'],
  ['gfx.g3d', 'Google 3B karo ayrıntısı'], ['gfx.lvl0', 'Düşük'], ['gfx.lvl1', 'Orta'], ['gfx.lvl2', 'Yüksek'], ['gfx.lvl3', 'Ultra'],
  ['gfx.advanced', 'Ayrıntılı ayarlar (Özel)'], ['gfx.dynres', 'Dinamik çözünürlük'], ['gfx.dynres_hint', 'Kare hızı düşünce çözünürlük kendiliğinden azalır'],
  ['gfx.counter', 'Köşede FPS sayacı'], ['gfx.bg', 'Arka planda kıs (20 fps)'], ['gfx.reset', 'Ön ayara dön'],
  ['gfx.mobile_warn', 'Yüksek/Ultra telefonda pili hızla tüketir ve cihazı ısıtabilir.'],
  ['gfx.rebuild', 'Arazi/bitki ayrıntısı dünya yeniden kurularak uygulanır'],
  ['gfx.note', 'Ayar bu tarayıcıda saklanır; çoğu değişiklik anında uygulanır.'],
  ['gfx.changed', 'Grafik: {l}'], ['gfx.adapt_down', 'Grafik: kare hızı düşük → {l}'], ['gfx.adapt_up', 'Grafik: kare hızı yeterli → {l}'],
  ['gfx.wiz', 'Grafik kalitesi'], ['gfx.wiz_hint', 'Uçuşta alt bantta "Grafik" menüsünden de değiştirilebilir.'],
];
const TXT = Object.fromEntries(GFX_TEXTS);
const fill = (s, p) => (p ? String(s).replace(/\{(\w+)\}/g, (m, k) => (p[k] != null ? String(p[k]) : m)) : String(s));
export const makeGfxT = (tr, keyed = false) => (k, p) => {
  const tx = TXT[k] ?? k;
  if (!tr) return fill(tx, p);
  if (!keyed) return tr(tx, p);
  const r = tr(k, p);
  return r && r !== k ? r : fill(tx, p);
};
export const levelLabel = (T, l) => T(`gfx.${GFX_CHOICES.includes(l) ? l : 'auto'}`);
