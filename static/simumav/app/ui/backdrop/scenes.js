// SIMUMAV arka plan sahneleri (Canvas2D; WebGL yok). createScene(name, g, W, H, { density, theme, lowPower, onReady }) →
// { frame(t, dt), resize(W, H), dispose() }. Durağan katmanlar (duvar, tarla, gökyüzü, yıldız) yeniden boyutlanınca bir kez önbellek
// tuvaline çizilir; kare başına yalnız hareketli öğeler (ışık, uçak, parçacık, çizgi) çizilir → orta cihazda ≤ 3 ms/kare.
// CAYMAZ görüntüsü: caymaz_atlas.webp (tools/simumav_caymaz_sprites.py — HEPGO'nun kendi caymaz-sim.glb modelinden 32 yörünge açısı).

const TAU = Math.PI * 2;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const lerp = (a, b, k) => a + (b - a) * k;
const fract = x => x - Math.floor(x);
const sstep = (a, b, x) => { const k = clamp((x - a) / (b - a), 0, 1); return k * k * (3 - 2 * k); };
function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const mk = (w, h) => { const c = document.createElement('canvas'); c.width = Math.max(1, Math.round(w)); c.height = Math.max(1, Math.round(h)); return c; };

// Yumuşak ışık lekesi (önbellekli): renk → 64 px radyal sprite
const glowCache = new Map();
function glow(color) {
  let c = glowCache.get(color); if (c) return c;
  c = mk(64, 64); const g = c.getContext('2d'), gr = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  gr.addColorStop(0, color); gr.addColorStop(0.35, color.replace(/[\d.]+\)$/, m => `${parseFloat(m) * 0.35})`)); gr.addColorStop(1, color.replace(/[\d.]+\)$/, '0)'));
  g.fillStyle = gr; g.fillRect(0, 0, 64, 64); glowCache.set(color, c); bitmap(c, b => glowCache.set(color, b)); return c;
}
// Önbellek tuvalini değişmez ImageBitmap'e çevir (tuval kaynağından her drawImage'da anlık görüntü kopyası alınmasın)
function bitmap(c, done) { try { globalThis.createImageBitmap?.(c).then(done, () => {}); } catch { /* yok */ } }
const blob = (g, img, x, y, rx, ry = rx, a = 1) => { if (a <= 0.003 || rx < 0.3) return; g.globalAlpha = a; g.drawImage(img, x - rx, y - ry, rx * 2, ry * 2); g.globalAlpha = 1; };
function vgrad(g, y0, y1, stops) { const gr = g.createLinearGradient(0, y0, 0, y1); stops.forEach(([k, c]) => gr.addColorStop(k, c)); return gr; }
function vignette(g, W, H, a = 0.55) {
  const gr = g.createRadialGradient(W / 2, H * 0.48, Math.min(W, H) * 0.25, W / 2, H * 0.5, Math.hypot(W, H) * 0.62);
  gr.addColorStop(0, 'rgba(4,6,12,0)'); gr.addColorStop(1, `rgba(4,6,12,${a})`); g.fillStyle = gr; g.fillRect(0, 0, W, H);
}

// ---------- CAYMAZ atlası ----------
export const ATLAS = { url: new URL('./caymaz_atlas.webp', import.meta.url).href, frames: 32, cols: 8, fw: 320, fh: 200 };
let atlasImg = null, atlasP = null;
function loadAtlas() {
  atlasP ??= new Promise(res => { const im = new Image(); im.decoding = 'async'; im.onload = () => { atlasImg = im; res(im); }; im.onerror = () => res(null); im.src = ATLAS.url; });
  return atlasP;
}
/** Kamera yörünge açısı (derece, 0 = önden) → atlas karesi + komşu kare karışımı (saf). */
export function atlasFrame(deg) {
  const f = ((deg % 360) + 360) % 360 / (360 / ATLAS.frames), i0 = Math.floor(f) % ATLAS.frames;
  return { i0, i1: (i0 + 1) % ATLAS.frames, k: f - Math.floor(f) };
}
const tintCache = new Map();
function tinted(color, amount) {   // atlasın renklendirilmiş kopyası (sahne ışığına uysun; düşük kontrast)
  if (!atlasImg) return null;
  const key = `${color}|${amount}`; let c = tintCache.get(key); if (c) return c;
  c = mk(atlasImg.width, atlasImg.height); const g = c.getContext('2d');
  g.drawImage(atlasImg, 0, 0); g.globalCompositeOperation = 'source-atop'; g.globalAlpha = amount; g.fillStyle = color; g.fillRect(0, 0, c.width, c.height);
  tintCache.set(key, c); bitmap(c, b => tintCache.set(key, b)); return c;
}
function drawPlane(g, img, deg, x, y, w, { alpha = 1, roll = 0, flipY = false } = {}) {
  if (!img) return;
  const { i0, i1, k } = atlasFrame(deg), h = w * ATLAS.fh / ATLAS.fw;
  g.save(); g.translate(x, y); if (roll) g.rotate(roll); if (flipY) g.scale(1, -1);
  const one = (i, a) => { if (a <= 0.01) return; g.globalAlpha = alpha * a; g.drawImage(img, (i % ATLAS.cols) * ATLAS.fw, Math.floor(i / ATLAS.cols) * ATLAS.fh, ATLAS.fw, ATLAS.fh, -w / 2, -h / 2, w, h); };
  if (k < 0.12) one(i0, 1); else if (k > 0.88) one(i1, 1); else { one(i0, 1 - k * 0.5); one(i1, k); }   // komşu karelerle yumuşak geçiş (uçlarda tek kare)
  g.restore(); g.globalAlpha = 1;
}

// ======================================================================
// HANGAR: kapı açıklığı (gece göğü), tavan makasları + sıralı tavan ışıkları (kayan dalga), parlak zemin yansıması,
// süpürülen projektör, içeri giren / dışarı çıkan CAYMAZ'lar (atlas; zeminde ayna yansıması), toz zerreleri.
// ======================================================================
function hangar(g, W, H, o) {
  const st = { cache: null, f: 0, cx: 0, cy: 0, motes: [] };
  const camY = 2.4, HW = 15, HT = 11, ZB = 48, DW = 8.5, DH = 7;
  const P = (x, y, z) => [st.cx + st.f * x / z, st.cy - st.f * (y - camY) / z];
  const poly = (gg, pts) => { gg.beginPath(); pts.forEach(([x, y, z], i) => { const [a, b] = P(x, y, z); i ? gg.lineTo(a, b) : gg.moveTo(a, b); }); gg.closePath(); };
  const lights = [];
  function build() {
    st.f = H * 0.95; st.cx = W / 2; st.cy = H * 0.44;
    const c = mk(W, H), q = c.getContext('2d');
    q.fillStyle = '#060a12'; q.fillRect(0, 0, W, H);
    // dış gece göğü (kapı açıklığı)
    const [dx0, dy0] = P(-DW, DH, ZB), [dx1, dy1] = P(DW, 0, ZB);
    q.fillStyle = vgrad(q, dy0, dy1, [[0, '#0b1830'], [0.7, '#14304a'], [1, '#2a5a6e']]); q.fillRect(dx0, dy0, dx1 - dx0, dy1 - dy0);
    const r = rng(7); q.fillStyle = 'rgba(220,235,255,.55)';
    for (let i = 0; i < 40; i++) q.fillRect(lerp(dx0, dx1, r()), lerp(dy0, lerp(dy0, dy1, 0.6), r()), 1, 1);
    // pist ışıkları (ufuk)
    for (let i = 0; i < 14; i++) blob(q, glow('rgba(255,190,110,.9)'), lerp(dx0, dx1, (i + 0.5) / 14), dy1 - (dy1 - dy0) * 0.06, 2.4, 1.6, 0.7);
    // arka duvar (kapı açıklığı hariç)
    q.fillStyle = '#0d1422'; q.beginPath();
    const bw = [P(-HW, 0, ZB), P(-HW, HT + 2, ZB), P(HW, HT + 2, ZB), P(HW, 0, ZB)];
    q.moveTo(...bw[0]); bw.slice(1).forEach(p => q.lineTo(...p)); q.lineTo(dx1, dy1); q.lineTo(dx1, dy0); q.lineTo(dx0, dy0); q.lineTo(dx0, dy1); q.closePath(); q.fill('evenodd');
    // kapı panelleri (yana açılmış, kenarlarda)
    q.fillStyle = '#121b2b';
    poly(q, [[-HW + 0.3, 0, ZB - 0.2], [-HW + 0.3, DH + 0.4, ZB - 0.2], [-DW - 0.2, DH + 0.4, ZB - 0.2], [-DW - 0.2, 0, ZB - 0.2]]); q.fill();
    poly(q, [[DW + 0.2, 0, ZB - 0.2], [DW + 0.2, DH + 0.4, ZB - 0.2], [HW - 0.3, DH + 0.4, ZB - 0.2], [HW - 0.3, 0, ZB - 0.2]]); q.fill();
    q.strokeStyle = 'rgba(150,180,220,.12)'; q.lineWidth = 1;
    for (let x = -HW + 1.4; x < -DW; x += 1.6) { q.beginPath(); q.moveTo(...P(x, 0, ZB - 0.2)); q.lineTo(...P(x, DH + 0.4, ZB - 0.2)); q.stroke(); }
    for (let x = DW + 1.4; x < HW; x += 1.6) { q.beginPath(); q.moveTo(...P(x, 0, ZB - 0.2)); q.lineTo(...P(x, DH + 0.4, ZB - 0.2)); q.stroke(); }
    // yan duvarlar
    q.fillStyle = '#0a101c'; poly(q, [[-HW, 0, 2], [-HW, HT, 2], [-HW, HT, ZB], [-HW, 0, ZB]]); q.fill();
    poly(q, [[HW, 0, 2], [HW, HT, 2], [HW, HT, ZB], [HW, 0, ZB]]); q.fill();
    q.strokeStyle = 'rgba(120,150,200,.07)';
    for (let z = 4; z < ZB; z += 3) for (const x of [-HW, HW]) { q.beginPath(); q.moveTo(...P(x, 0, z)); q.lineTo(...P(x, HT, z)); q.stroke(); }
    // tavan + makaslar (kemer)
    q.fillStyle = '#080d18'; poly(q, [[-HW, HT, 2], [HW, HT, 2], [HW, HT, ZB], [-HW, HT, ZB]]); q.fill();
    q.strokeStyle = 'rgba(140,170,215,.13)'; q.lineWidth = 1.2;
    for (let z = 5; z <= ZB; z += 4) {
      q.beginPath();
      for (let i = 0; i <= 20; i++) { const x = -HW + i * HW / 10, y = HT - 1.6 * (x / HW) ** 2; const [a, b] = P(x, y, z); i ? q.lineTo(a, b) : q.moveTo(a, b); }
      q.stroke();
      q.beginPath(); q.moveTo(...P(-HW, HT - 1.6, z)); q.lineTo(...P(HW, HT - 1.6, z)); q.stroke();
    }
    for (const x of [-10, -5, 0, 5, 10]) { q.beginPath(); q.moveTo(...P(x, HT - 1.6 * (x / HW) ** 2, 3)); q.lineTo(...P(x, HT - 1.6 * (x / HW) ** 2, ZB)); q.stroke(); }
    // zemin (parlak epoksi) + işaretler
    const [, fy0] = P(0, 0, ZB), fy1 = H;
    q.fillStyle = vgrad(q, fy0, fy1, [[0, '#121b2a'], [1, '#05080e']]); poly(q, [[-HW, 0, 1.2], [-HW, 0, ZB], [HW, 0, ZB], [HW, 0, 1.2]]); q.fill();
    // kapı göğünün zemin yansıması
    q.globalAlpha = 0.22; q.save(); q.beginPath(); poly(q, [[-HW, 0, 1.2], [-HW, 0, ZB], [HW, 0, ZB], [HW, 0, 1.2]]); q.clip();
    q.translate(0, dy1 * 2); q.scale(1, -1); q.fillStyle = vgrad(q, dy0, dy1, [[0, 'rgba(11,24,48,0)'], [1, '#2a5a6e']]); q.fillRect(dx0, dy0, dx1 - dx0, dy1 - dy0); q.restore(); q.globalAlpha = 1;
    q.fillStyle = 'rgba(250,200,80,.20)';
    for (let z = 3; z < ZB; z += 2.2) { poly(q, [[-0.12, 0, z], [0.12, 0, z], [0.12, 0, z + 1.1], [-0.12, 0, z + 1.1]]); q.fill(); }
    q.strokeStyle = 'rgba(220,230,255,.08)'; q.lineWidth = 1.5;
    for (const x of [-9, 9]) { q.beginPath(); q.moveTo(...P(x, 0, 2)); q.lineTo(...P(x, 0, ZB)); q.stroke(); }
    for (const z of [12, 26]) { q.beginPath(); q.moveTo(...P(-9, 0, z)); q.lineTo(...P(9, 0, z)); q.stroke(); }
    lights.length = 0;
    for (let z = 7; z <= ZB - 2; z += 5) for (const x of [-8, 0, 8]) lights.push({ x, z, y: HT - 1.6 * (x / HW) ** 2 - 0.4 });
    q.globalCompositeOperation = 'lighter';
    for (const l of lights) lamp(q, l, 0.45);   // taban parlaklığı (durağan); dalga artışı karede
    q.globalCompositeOperation = 'source-over';
    vignette(q, W, H, 0.6); st.cache = c;
    const r2 = rng(11); st.motes = Array.from({ length: Math.round(50 * o.density) }, () => ({ x: lerp(-10, 10, r2()), y: lerp(0.5, 8, r2()), z: lerp(5, 30, r2()), s: r2() }));
  }
  const L = glow('rgba(190,220,255,.85)'), LR = glow('rgba(150,190,240,.5)');
  function lamp(q, l, k) {
    const [a, b] = P(l.x, l.y, l.z), s = st.f / l.z;
    blob(q, L, a, b, s * 1.1, s * 0.55, 0.55 * k);
    const [fa, fb] = P(l.x, 0, l.z); blob(q, LR, fa, fb, s * 0.9, s * 2.6, 0.16 * k);   // zemin yansıması (dikey uzamış)
  }
  const planes = [{ off: 0, dir: 1 }, { off: 0.5, dir: -1 }];
  build(); loadAtlas().then(() => o.onReady?.());
  return {
    resize(w, h) { W = w; H = h; build(); },
    frame(t) {
      g.drawImage(st.cache, 0, 0);
      g.globalCompositeOperation = 'lighter';
      for (const l of lights) {   // tavan ışıkları: derinlik boyunca kayan dalga (yalnız artış çizilir)
        const k = 0.55 * sstep(0.55, 1, 0.5 + 0.5 * Math.cos(l.z * 0.18 - t * 0.9));
        if (k > 0.03) lamp(g, l, k);
      }
      // süpürülen projektör (zeminde)
      const sx = 9 * Math.sin(t * 0.13), sz = 16 + 5 * Math.sin(t * 0.07);
      const [pa, pb] = P(sx, 0, sz), ps = st.f / sz;
      blob(g, glow('rgba(120,200,255,.6)'), pa, pb, ps * 5, ps * 1.6, 0.35);
      g.globalCompositeOperation = 'source-over';
      // uçaklar: biri içeri (önden görünüm), biri dışarı (arkadan); dışarıdayken kapı açıklığına kırpılır
      const img = tinted('#33425a', 0.62);
      if (img) {
        const order = planes.map(p => { const ph = fract(t / 46 + p.off); const zz = p.dir > 0 ? lerp(78, 22, sstep(0, 0.62, ph)) : lerp(22, 78, sstep(0.38, 1, ph)); return { ...p, ph, z: zz }; }).sort((a, b) => b.z - a.z);
        for (const p of order) {
          const z = p.z, x = p.dir > 0 ? -5 + Math.sin(p.ph * 6) * 0.5 : 5, sc = 2.2, w = st.f * 3.1 * sc / z * 1.45;
          const deg = p.dir > 0 ? 12 * Math.sin(t * 0.2) : 180 + 10 * Math.sin(t * 0.17);
          const [a, b] = P(x, 0.55 * sc, z), [, fy] = P(x, 0, z);
          const fade = sstep(78, 62, z);
          g.save();
          if (z > ZB) { const [dx0, dy0] = P(-DW, DH, ZB), [dx1, dy1] = P(DW, 0, ZB); g.beginPath(); g.rect(dx0, dy0, dx1 - dx0, dy1 - dy0); g.clip(); }
          drawPlane(g, img, deg, a, b, w, { alpha: 0.72 * fade });
          if (z <= ZB) drawPlane(g, img, deg, a, fy + (fy - b), w, { alpha: 0.12 * fade, flipY: true });   // zemin yansıması
          g.restore();
        }
      }
      // toz zerreleri
      g.fillStyle = 'rgba(200,220,255,.5)';
      for (const m of st.motes) { const y = m.y + Math.sin(t * 0.2 + m.s * 9) * 0.4, x = m.x + Math.sin(t * 0.05 + m.s * 20) * 0.8; const [a, b] = P(x, y, m.z); g.globalAlpha = 0.18 + 0.2 * m.s; g.fillRect(a, b, 1.2, 1.2); }
      g.globalAlpha = 1;
    },
    dispose() { st.cache = null; },
  };
}

// ======================================================================
// MÜRETTEBAT: eğitim/brifing sınıfı — önde büyük projeksiyon perdesi (uçuş rotaları çizilir, rüzgâr okları, radar süpürmesi, lazer
// imleç), yanlarda yazı tahtaları (silik şemalar), arkadan bakılan sıralar ve sandalye sırtları, perde ışıması + projektör tozu.
// ======================================================================
function crew(g, W, H, o) {
  const st = { cache: null, scr: null, motes: [] };
  function build() {
    const c = mk(W, H), q = c.getContext('2d');
    q.fillStyle = vgrad(q, 0, H, [[0, '#0a0f1b'], [0.55, '#0c1322'], [1, '#05070d']]); q.fillRect(0, 0, W, H);
    const sw = Math.min(W * 0.52, H * 0.95), sh = sw * 0.56, sx = (W - sw) / 2, sy = H * 0.1;
    st.scr = { x: sx, y: sy, w: sw, h: sh };
    // ön duvar şeridi + perde çerçevesi
    q.fillStyle = '#0e1525'; q.fillRect(0, H * 0.05, W, sh + H * 0.12);
    q.fillStyle = '#05080f'; q.fillRect(sx - 6, sy - 6, sw + 12, sh + 12);
    // yan tahtalar (silik şemalar)
    const r = rng(5);
    for (const side of [-1, 1]) {
      const bw = Math.min(W * 0.2, sw * 0.42), bh = sh * 0.72, bx = side < 0 ? sx - bw - W * 0.04 : sx + sw + W * 0.04, by = sy + sh * 0.12;
      q.fillStyle = '#121a2a'; q.fillRect(bx, by, bw, bh); q.strokeStyle = 'rgba(160,190,230,.18)'; q.lineWidth = 1; q.strokeRect(bx + 0.5, by + 0.5, bw - 1, bh - 1);
      q.strokeStyle = 'rgba(190,215,250,.16)'; q.lineWidth = 1.2;
      for (let i = 0; i < 5; i++) { const yy = by + bh * (0.15 + i * 0.15); q.beginPath(); q.moveTo(bx + bw * 0.08, yy); for (let k = 1; k <= 8; k++) q.lineTo(bx + bw * (0.08 + k * 0.05), yy + (r() - 0.5) * 3); q.stroke(); }
      q.beginPath(); q.arc(bx + bw * 0.72, by + bh * 0.62, bh * 0.2, 0, TAU); q.stroke();
      q.beginPath(); q.moveTo(bx + bw * 0.55, by + bh * 0.85); q.quadraticCurveTo(bx + bw * 0.7, by + bh * 0.3, bx + bw * 0.92, by + bh * 0.4); q.stroke();
    }
    // perde ışıması (masalara yansır)
    q.globalCompositeOperation = 'lighter';
    blob(q, glow('rgba(70,140,230,.5)'), sx + sw / 2, sy + sh * 0.9, sw * 0.9, sh * 0.9, 0.3);
    q.globalCompositeOperation = 'source-over';
    // zemin + sıralar (arkadan; perspektif)
    const hy = sy + sh + H * 0.08, vx = W / 2, vy = sy + sh * 0.45;
    q.fillStyle = vgrad(q, hy, H, [[0, '#0b111d'], [1, '#04060b']]); q.fillRect(0, hy, W, H - hy);
    const rows = 5;
    for (let i = 0; i < rows; i++) {
      const k = i / (rows - 1), y = lerp(hy + H * 0.05, H * 1.02, k ** 1.25), sc = lerp(0.42, 1.25, k);
      for (const col of [-1, 0, 1]) {
        const cx = vx + (y - vy) * col * 1.15, dw = W * 0.18 * sc, dh = H * 0.028 * sc;
        q.fillStyle = `rgba(22,32,52,${0.9})`; q.beginPath(); q.roundRect(cx - dw / 2, y - dh, dw, dh, dh * 0.4); q.fill();   // masa
        q.fillStyle = 'rgba(70,110,170,.10)'; q.fillRect(cx - dw / 2, y - dh, dw, 1.2);
        for (let s = 0; s < 3; s++) {   // sandalye sırtları
          const ch = H * 0.07 * sc, cw = dw * 0.22, xx = cx - dw / 2 + dw * (0.17 + s * 0.33) - cw / 2;
          q.fillStyle = '#0a0f19'; q.beginPath(); q.roundRect(xx, y + dh * 0.6, cw, ch, cw * 0.25); q.fill();
          q.fillStyle = 'rgba(100,140,200,.07)'; q.fillRect(xx + 1, y + dh * 0.6 + 1, cw - 2, 1.4);
        }
      }
    }
    vignette(q, W, H, 0.55); st.cache = c;
    const r2 = rng(3); st.motes = Array.from({ length: Math.round(60 * o.density) }, () => ({ u: r2(), v: r2(), s: r2() }));
  }
  const routes = [
    [[0.08, 0.78], [0.3, 0.32], [0.62, 0.62], [0.9, 0.22]],
    [[0.12, 0.2], [0.4, 0.5], [0.55, 0.15], [0.86, 0.72]],
    [[0.05, 0.5], [0.35, 0.85], [0.7, 0.4], [0.95, 0.55]],
  ];
  const bez = (p, k) => { const u = 1 - k; return [u ** 3 * p[0][0] + 3 * u * u * k * p[1][0] + 3 * u * k * k * p[2][0] + k ** 3 * p[3][0], u ** 3 * p[0][1] + 3 * u * u * k * p[1][1] + 3 * u * k * k * p[2][1] + k ** 3 * p[3][1]]; };
  build();
  return {
    resize(w, h) { W = w; H = h; build(); },
    frame(t) {
      g.drawImage(st.cache, 0, 0);
      const s = st.scr, X = u => s.x + u * s.w, Y = v => s.y + v * s.h;
      // perde (projeksiyon)
      g.fillStyle = vgrad(g, s.y, s.y + s.h, [[0, 'rgba(13,31,56,.9)'], [1, 'rgba(9,23,43,.9)']]); g.fillRect(s.x, s.y, s.w, s.h);
      g.save(); g.beginPath(); g.rect(s.x, s.y, s.w, s.h); g.clip();
      g.strokeStyle = 'rgba(120,190,255,.10)'; g.lineWidth = 1; g.beginPath();
      for (let i = 1; i < 12; i++) { g.moveTo(X(i / 12), s.y); g.lineTo(X(i / 12), s.y + s.h); }
      for (let i = 1; i < 7; i++) { g.moveTo(s.x, Y(i / 7)); g.lineTo(s.x + s.w, Y(i / 7)); }
      g.stroke();
      // rüzgâr okları (yavaş dönen alan)
      g.strokeStyle = 'rgba(140,220,255,.16)'; g.lineWidth = 1.2;
      for (let i = 0; i < 7; i++) for (let j = 0; j < 4; j++) {
        const u = (i + 0.5) / 7 + 0.02 * Math.sin(t * 0.3 + j), v = (j + 0.5) / 4, a = 0.6 + 0.5 * Math.sin(t * 0.25 + i * 0.6 + j * 0.9), L = s.w * 0.035;
        const x = X(u), y = Y(v), ex = x + Math.cos(a) * L, ey = y + Math.sin(a) * L;
        g.beginPath(); g.moveTo(x - Math.cos(a) * L, y - Math.sin(a) * L); g.lineTo(ex, ey); g.lineTo(ex - Math.cos(a - 0.5) * L * 0.4, ey - Math.sin(a - 0.5) * L * 0.4); g.moveTo(ex, ey); g.lineTo(ex - Math.cos(a + 0.5) * L * 0.4, ey - Math.sin(a + 0.5) * L * 0.4); g.stroke();
      }
      // uçuş rotaları: aşamalı çizim + üzerinde ilerleyen uçak simgesi
      routes.forEach((p, ri) => {
        const ph = fract(t / 14 + ri / 3), k = sstep(0, 0.7, ph), fade = 1 - sstep(0.85, 1, ph);
        g.strokeStyle = ['rgba(251,191,36,', 'rgba(56,189,248,', 'rgba(167,139,250,'][ri] + (0.5 * fade) + ')'; g.lineWidth = 2; g.setLineDash([6, 5]); g.lineDashOffset = -t * 12;
        g.beginPath(); for (let i = 0; i <= 40; i++) { const kk = i / 40 * k, [u, v] = bez(p, kk); i ? g.lineTo(X(u), Y(v)) : g.moveTo(X(u), Y(v)); } g.stroke(); g.setLineDash([]);
        for (const w of [p[0], p[3]]) { g.beginPath(); g.arc(X(w[0]), Y(w[1]), 3 + 1.5 * Math.sin(t * 2 + ri), 0, TAU); g.stroke(); }
        const [u, v] = bez(p, k), [u2, v2] = bez(p, Math.min(1, k + 0.01)), a = Math.atan2(Y(v2) - Y(v), X(u2) - X(u));
        g.save(); g.translate(X(u), Y(v)); g.rotate(a); g.fillStyle = `rgba(255,255,255,${0.6 * fade})`; g.beginPath(); g.moveTo(7, 0); g.lineTo(-5, -4.5); g.lineTo(-2, 0); g.lineTo(-5, 4.5); g.closePath(); g.fill(); g.restore();
      });
      // radar süpürmesi (köşe)
      const rx = X(0.88), ry = Y(0.78), rr = s.h * 0.17, ra = t * 1.2;
      g.strokeStyle = 'rgba(52,211,153,.22)'; g.beginPath(); g.arc(rx, ry, rr, 0, TAU); g.moveTo(rx + rr * 0.5, ry); g.arc(rx, ry, rr * 0.5, 0, TAU); g.stroke();
      g.fillStyle = 'rgba(52,211,153,.12)'; g.beginPath(); g.moveTo(rx, ry); g.arc(rx, ry, rr, ra - 0.6, ra); g.closePath(); g.fill();
      // lazer imleç
      const lx = X(0.5 + 0.3 * Math.sin(t * 0.21) * Math.cos(t * 0.13)), ly = Y(0.5 + 0.28 * Math.sin(t * 0.17 + 1));
      g.globalCompositeOperation = 'lighter'; blob(g, glow('rgba(255,70,70,.9)'), lx, ly, 5, 5, 0.8); g.globalCompositeOperation = 'source-over';
      g.restore();
      // projektör tozu
      g.globalCompositeOperation = 'lighter';
      g.fillStyle = 'rgba(210,230,255,1)';   // projektör ışığında süzülen toz (perdenin önünde, yavaşça yükselir)
      for (const m of st.motes) {
        const v = fract(m.v - t * 0.008 * (0.5 + m.s)), yy = lerp(s.y, s.y + s.h * 1.25, v), xx = s.x + m.u * s.w + Math.sin(t * 0.4 + m.s * 30) * 4;
        g.globalAlpha = (0.1 + 0.25 * m.s) * Math.sin(v * Math.PI); g.fillRect(xx, yy, 1.3, 1.3);
      }
      g.globalAlpha = 1; g.globalCompositeOperation = 'source-over';
    },
    dispose() { st.cache = null; },
  };
}

// ======================================================================
// PARKUR: dönen tel kafes dünya küresi (enlem/boylam; arka yüz silik), yüzeyde şehir ışıkları, büyük daire yörüngelerinde dolaşan
// simgesel uçaklar ve arkalarında solan izler (yörüngeden analitik — durum tutulmaz, sızıntı yok), atmosfer halesi, yıldızlar.
// ======================================================================
function tracks(g, W, H, o) {
  const st = { cache: null, cx: 0, cy: 0, R: 0, dots: [], planes: [] };
  function build() {
    const c = mk(W, H), q = c.getContext('2d');
    q.fillStyle = vgrad(q, 0, H, [[0, '#050a14'], [1, '#081320']]); q.fillRect(0, 0, W, H);
    const r = rng(21); q.fillStyle = 'rgba(220,235,255,.6)';
    for (let i = 0; i < 160 * o.density; i++) { q.globalAlpha = 0.15 + r() * 0.5; q.fillRect(r() * W, r() * H, r() < 0.1 ? 1.6 : 1, r() < 0.1 ? 1.6 : 1); }
    q.globalAlpha = 1;
    st.R = Math.min(W, H) * (W > H ? 0.36 : 0.4); st.cx = W > H ? W * 0.62 : W * 0.5; st.cy = H * 0.56;
    const gr = q.createRadialGradient(st.cx, st.cy, st.R * 0.92, st.cx, st.cy, st.R * 1.32);
    gr.addColorStop(0, 'rgba(52,211,153,.16)'); gr.addColorStop(0.4, 'rgba(56,189,248,.07)'); gr.addColorStop(1, 'rgba(56,189,248,0)');
    q.fillStyle = gr; q.beginPath(); q.arc(st.cx, st.cy, st.R * 1.32, 0, TAU); q.fill();
    const body = q.createRadialGradient(st.cx - st.R * 0.35, st.cy - st.R * 0.4, st.R * 0.1, st.cx, st.cy, st.R);
    body.addColorStop(0, 'rgba(20,48,70,.85)'); body.addColorStop(1, 'rgba(6,16,28,.92)');
    q.fillStyle = body; q.beginPath(); q.arc(st.cx, st.cy, st.R, 0, TAU); q.fill();
    vignette(q, W, H, 0.5); st.cache = c;
    const r2 = rng(4);
    st.dots = Array.from({ length: Math.round(90 * o.density) }, () => { const u = r2() * 2 - 1, a = r2() * TAU, s = Math.sqrt(1 - u * u); return [s * Math.cos(a), u * 0.9, s * Math.sin(a)]; });
    st.planes = Array.from({ length: o.lowPower ? 4 : 6 }, (_, i) => {
      const a = r2() * TAU, b = (r2() - 0.5) * 2.2, n = [Math.sin(b) * Math.cos(a), Math.cos(b), Math.sin(b) * Math.sin(a)];
      const tmp = Math.abs(n[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
      const u = norm(cross(n, tmp)), v = cross(n, u);
      return { u, v, w: (0.16 + r2() * 0.14) * (i % 2 ? 1 : -1), ph: r2() * TAU, col: ['rgba(251,191,36,', 'rgba(56,189,248,', 'rgba(52,211,153,', 'rgba(167,139,250,', 'rgba(244,114,182,', 'rgba(251,146,60,'][i % 6] };
    });
  }
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const norm = a => { const l = Math.hypot(...a) || 1; return a.map(x => x / l); };
  build();
  return {
    resize(w, h) { W = w; H = h; build(); },
    frame(t) {
      g.drawImage(st.cache, 0, 0);
      const yaw = t * 0.07, tilt = 0.38, cy = Math.cos(yaw), sy = Math.sin(yaw), ct = Math.cos(tilt), stl = Math.sin(tilt);
      const R = st.R, CX = st.cx, CY = st.cy;
      // dünya → ekran (dönüş: Y ekseni etrafında yaw, sonra X etrafında eğim); z>0 kameraya bakan yüz
      const rot = (x, y, z) => { const x1 = x * cy + z * sy, z1 = -x * sy + z * cy; return [x1, y * ct - z1 * stl, y * stl + z1 * ct]; };
      const front = new Path2D(), back = new Path2D();
      const line = (pts) => { let prevF = null; for (let i = 0; i < pts.length; i++) { const [x, y, z] = rot(...pts[i]), f = z >= 0, px = CX + x * R, py = CY - y * R; const path = f ? front : back; if (i === 0 || f !== prevF) path.moveTo(px, py); else path.lineTo(px, py); prevF = f; } };
      const segN = o.lowPower ? 28 : 44;
      for (let lat = -60; lat <= 60; lat += 20) { const la = lat * Math.PI / 180, r = Math.cos(la), y = Math.sin(la); line(Array.from({ length: segN + 1 }, (_, i) => [r * Math.cos(i / segN * TAU), y, r * Math.sin(i / segN * TAU)])); }
      for (let lon = 0; lon < 180; lon += 20) { const lo = lon * Math.PI / 180; line(Array.from({ length: segN + 1 }, (_, i) => { const a = i / segN * TAU; return [Math.cos(a) * Math.cos(lo), Math.sin(a), Math.cos(a) * Math.sin(lo)]; })); }
      g.lineWidth = 1; g.strokeStyle = 'rgba(80,170,220,.10)'; g.stroke(back);
      g.strokeStyle = 'rgba(110,220,255,.30)'; g.stroke(front);
      // şehir ışıkları
      g.fillStyle = 'rgba(255,214,140,.9)';
      for (const d of st.dots) { const [x, y, z] = rot(...d); if (z < 0.05) continue; g.globalAlpha = 0.25 + 0.55 * z; g.fillRect(CX + x * R - 0.7, CY - y * R - 0.7, 1.5, 1.5); }
      g.globalAlpha = 1;
      // uçaklar + izler
      g.lineCap = 'round';
      for (const p of st.planes) {
        const th = p.ph + t * p.w, alt = 1.07, pos = k => { const a = th - k * Math.sign(p.w); return rot(...[0, 1, 2].map(i => (p.u[i] * Math.cos(a) + p.v[i] * Math.sin(a)) * alt)); };
        const vis = ([x, y, z]) => z > 0 || x * x + y * y > 1;   // arkadaysa küre diski içinde gizli
        const N = 16, span = 1.2;
        let prev = pos(0);
        for (let i = 1; i <= N; i++) {
          const cur = pos(i / N * span);
          if (vis(prev) && vis(cur)) { g.strokeStyle = p.col + (0.55 * (1 - i / N)) + ')'; g.lineWidth = 2.2 * (1 - i / N) + 0.4; g.beginPath(); g.moveTo(CX + prev[0] * R, CY - prev[1] * R); g.lineTo(CX + cur[0] * R, CY - cur[1] * R); g.stroke(); }
          prev = cur;
        }
        const h0 = pos(0), h1 = pos(-0.03);
        if (!vis(h0)) continue;
        const ax = CX + h0[0] * R, ay = CY - h0[1] * R, a = Math.atan2(-(h1[1] - h0[1]), h1[0] - h0[0]), s = 5 + 2 * Math.max(0, h0[2]);
        g.globalCompositeOperation = 'lighter'; blob(g, glow(p.col + '.8)'), ax, ay, s * 1.8, s * 1.8, 0.5); g.globalCompositeOperation = 'source-over';
        g.save(); g.translate(ax, ay); g.rotate(a); g.fillStyle = 'rgba(240,248,255,.92)';
        g.beginPath(); g.moveTo(s, 0); g.lineTo(-s * 0.2, -s * 0.18); g.lineTo(-s * 0.35, -s * 0.85); g.lineTo(-s * 0.6, -s * 0.85); g.lineTo(-s * 0.5, -s * 0.16); g.lineTo(-s * 0.9, -s * 0.12); g.lineTo(-s, -s * 0.4); g.lineTo(-s * 1.1, 0);
        g.lineTo(-s, s * 0.4); g.lineTo(-s * 0.9, s * 0.12); g.lineTo(-s * 0.5, s * 0.16); g.lineTo(-s * 0.6, s * 0.85); g.lineTo(-s * 0.35, s * 0.85); g.lineTo(-s * 0.2, s * 0.18); g.closePath(); g.fill(); g.restore();
      }
    },
    dispose() { st.cache = null; st.planes = []; st.dots = []; },
  };
}

// ======================================================================
// GÖREVLER: alacakaranlıkta perspektif tarla (ekin şeritleri, kamera yavaşça ilerler), ilaçlama dronu sıra sıra geçiş yapar
// (mekik deseni), iki memeden püskürtme bulutu (parçacıklar sürüklenip çöker, solar), zeminde gölge, seyir ışıkları.
// ======================================================================
function missions(g, W, H, o) {
  const st = { cache: null, f: 0, cx: 0, hy: 0, parts: [], spawnAcc: 0, pool: [] };
  const camY = 7;
  const P = (x, y, z) => [st.cx + st.f * x / z, st.hy - st.f * (y - camY) / z];
  const MAXP = Math.round(110 * o.density);
  function build() {
    st.f = H * 1.05; st.cx = W / 2; st.hy = H * 0.34;
    const c = mk(W, H), q = c.getContext('2d');
    q.fillStyle = vgrad(q, 0, st.hy + 2, [[0, '#0b1224'], [0.6, '#1d2440'], [1, '#4a3a4e']]); q.fillRect(0, 0, W, st.hy + 2);
    q.globalCompositeOperation = 'lighter'; blob(q, glow('rgba(255,170,100,.7)'), W * 0.78, st.hy, W * 0.3, H * 0.12, 0.6); q.globalCompositeOperation = 'source-over';
    // uzak ağaç sırası
    const r = rng(9); q.fillStyle = '#0c1418'; q.beginPath(); q.moveTo(0, st.hy + 1);
    for (let x = 0; x <= W; x += W / 90) q.lineTo(x, st.hy - (2 + r() * 7) * H / 600); q.lineTo(W, st.hy + 1); q.closePath(); q.fill();
    // tarla şeritleri (kaybolma noktasına yakınsayan)
    const zN = 2.2, zF = 260;
    for (let i = -70; i < 70; i++) {
      const x0 = i * 1.6, x1 = x0 + 1.6;
      q.fillStyle = i % 2 ? '#14261a' : '#1b3322';
      q.beginPath(); q.moveTo(...P(x0, 0, zN)); q.lineTo(...P(x0, 0, zF)); q.lineTo(...P(x1, 0, zF)); q.lineTo(...P(x1, 0, zN)); q.closePath(); q.fill();
    }
    q.fillStyle = vgrad(q, st.hy, H, [[0, 'rgba(60,50,70,.75)'], [0.25, 'rgba(30,30,45,.2)'], [1, 'rgba(0,0,0,.35)']]); q.fillRect(0, st.hy, W, H - st.hy);   // pus
    vignette(q, W, H, 0.5); st.cache = c;
  }
  const spray = () => {
    const s = document.createElement('canvas'); s.width = s.height = 48; const q = s.getContext('2d'), gr = q.createRadialGradient(24, 24, 0, 24, 24, 24);
    gr.addColorStop(0, 'rgba(200,240,235,.55)'); gr.addColorStop(1, 'rgba(200,240,235,0)'); q.fillStyle = gr; q.fillRect(0, 0, 48, 48); return s;
  };
  const SP = spray();
  // dron yolu (mekik): geçiş süresi T, her geçişte 3,2 m uzaklaşır; 6 geçişte döngü
  const PASS = 9, LANES = 6, SPAN = 15;
  const droneAt = t => {
    const n = Math.floor(t / PASS), k = fract(t / PASS), lane = n % LANES, dir = n % 2 ? -1 : 1, e = sstep(0, 1, k);
    const x = dir * lerp(-SPAN, SPAN, e), z = 13 + lane * 3.2 + sstep(0.85, 1, k) * 3.2 * (lane === LANES - 1 ? -LANES + 1 : 1);
    return { x, y: 3.2 + 0.25 * Math.sin(t * 1.3), z, dir, spraying: k > 0.06 && k < 0.92, vx: dir * 2 * SPAN / PASS * (6 * k * (1 - k)) };
  };
  function simulate(t, dt) {   // püskürtme parçacıkları (havuzlu; en çok MAXP)
    const d = droneAt(t);
    if (d.spraying && dt > 0) {
      st.spawnAcc += dt * 36 * o.density;
      while (st.spawnAcc >= 1 && st.parts.length < MAXP) {
        st.spawnAcc -= 1;
        const p = st.pool.pop() || {}, side = Math.random() < 0.5 ? -1 : 1;
        Object.assign(p, { x: d.x + side * 0.9 + (Math.random() - 0.5) * 0.3, y: d.y - 0.35, z: d.z + (Math.random() - 0.5) * 0.4, vx: d.vx * 0.3 + (Math.random() - 0.5) * 0.6, vy: -1.2 - Math.random() * 0.8, vz: (Math.random() - 0.5) * 0.6, age: 0, life: 2 + Math.random() * 1.4 });
        st.parts.push(p);
      }
    } else st.spawnAcc = 0;
    const sorted = st.parts;
    for (let i = sorted.length - 1; i >= 0; i--) {
      const p = sorted[i]; p.age += dt;
      if (p.age > p.life) { st.pool.push(sorted[i]); sorted[i] = sorted[sorted.length - 1]; sorted.pop(); continue; }
      p.vy *= 1 - dt * 1.4; p.vx *= 1 - dt * 0.8; p.vz *= 1 - dt * 0.8; p.vx += 0.25 * dt;   // hafif yan rüzgâr
      p.x += p.vx * dt; p.y = Math.max(0.15, p.y + p.vy * dt); p.z += p.vz * dt;
    }
  }
  build();
  return {
    resize(w, h) { W = w; H = h; build(); },
    frame(t, dt) {
      if (!dt && !st.parts.length) for (let k = 40; k > 0; k--) simulate(t - k / 30, 1 / 30);   // durağan kare (reduced-motion): bulut dolu görünsün
      else simulate(t, dt);
      g.drawImage(st.cache, 0, 0);
      // kamera ilerlemesi: sıra çizgilerine dik ekin bantları yaklaşır
      g.strokeStyle = 'rgba(70,120,80,.16)'; g.lineWidth = 1;
      g.beginPath();
      for (let i = 0; i < 18; i++) { const z = 3 + fract(i / 18 - t * 0.012) * 90; const [, y] = P(0, 0, z), hw = W * 0.7 + (st.f * 110 / z); g.moveTo(st.cx - hw, y); g.lineTo(st.cx + hw, y); }
      g.stroke();
      const d = droneAt(t);
      const sorted = st.parts;
      for (const p of sorted) { const [a, b] = P(p.x, p.y, p.z), k = p.age / p.life, s = st.f * (0.3 + k * 0.95) / p.z; blob(g, SP, a, b, s, s * 0.8, 0.34 * (1 - k) * sstep(0, 0.15, k)); }
      // gölge
      const [ga, gb] = P(d.x, 0, d.z), gs = st.f / d.z;
      g.fillStyle = 'rgba(0,0,0,.28)'; g.beginPath(); g.ellipse(ga, gb, gs * 1.4, gs * 0.35, 0, 0, TAU); g.fill();
      // dron (üstten-yandan): gövde, 4 kol, dönen pervane diskleri, depo, seyir ışıkları
      const [a, b] = P(d.x, d.y, d.z), s = st.f / d.z, tiltA = clamp(d.vx * 0.05, -0.18, 0.18);
      g.save(); g.translate(a, b); g.rotate(tiltA);
      g.strokeStyle = '#1a2230'; g.lineWidth = Math.max(1, s * 0.12);
      g.beginPath(); g.moveTo(-s * 1.1, -s * 0.18); g.lineTo(s * 1.1, s * 0.18); g.moveTo(-s * 1.1, s * 0.18); g.lineTo(s * 1.1, -s * 0.18); g.stroke();
      g.fillStyle = '#c9d3df'; g.beginPath(); g.roundRect(-s * 0.42, -s * 0.2, s * 0.84, s * 0.32, s * 0.1); g.fill();
      g.fillStyle = '#7d8a9b'; g.beginPath(); g.roundRect(-s * 0.3, s * 0.1, s * 0.6, s * 0.22, s * 0.06); g.fill();
      for (const [px, py] of [[-1.1, -0.18], [1.1, 0.18], [-1.1, 0.18], [1.1, -0.18]]) {
        g.fillStyle = 'rgba(200,215,235,.22)'; g.beginPath(); g.ellipse(px * s, py * s - s * 0.08, s * 0.62, s * 0.13, 0, 0, TAU); g.fill();
        g.strokeStyle = 'rgba(230,240,255,.45)'; g.lineWidth = 1; const ang = t * 40 + px * 3; g.beginPath(); g.moveTo(px * s - Math.cos(ang) * s * 0.6, py * s - s * 0.08 - Math.sin(ang) * s * 0.12); g.lineTo(px * s + Math.cos(ang) * s * 0.6, py * s - s * 0.08 + Math.sin(ang) * s * 0.12); g.stroke();
      }
      g.restore();
      g.globalCompositeOperation = 'lighter';
      const blink = fract(t * 0.9) < 0.12;
      blob(g, glow('rgba(255,60,60,.9)'), a - s * 1.1, b, s * 0.35, s * 0.35, 0.8);
      blob(g, glow('rgba(60,255,120,.9)'), a + s * 1.1, b, s * 0.35, s * 0.35, 0.8);
      if (blink) blob(g, glow('rgba(255,255,255,.95)'), a, b - s * 0.2, s * 0.6, s * 0.6, 0.9);
      g.globalCompositeOperation = 'source-over';
    },
    dispose() { st.cache = null; st.parts.length = 0; st.pool.length = 0; },
  };
}

// ======================================================================
// UÇ girişi: bulutların arasında süzülen CAYMAZ — yavaş sinematik kamera yörüngesi (atlas kareleri arasında karışım), hafif yatış,
// paralaks bulut katmanları (3 derinlik), uzak dağ siluetleri, güneş ışıması, ince hız çizgileri.
// ======================================================================
function caymaz(g, W, H, o) {
  const st = { cache: null, hills: [], clouds: [], cloudImgs: [] };
  function cloudSprite(seed, w, h) {
    const c = mk(w, h), q = c.getContext('2d'), r = rng(seed), G = glow('rgba(225,235,250,.55)');
    for (let i = 0; i < 16; i++) { const x = w * (0.18 + r() * 0.64), y = h * (0.45 + (r() - 0.5) * 0.35), rr = h * (0.18 + r() * 0.28); blob(q, G, x, y, rr * 1.6, rr, 0.8); }
    return c;
  }
  function hillStrip(seed, h, col, amp) {
    const w = W * 2, c = mk(w, h), q = c.getContext('2d'), r = rng(seed);
    q.fillStyle = col; q.beginPath(); q.moveTo(0, h);
    const n = 24, ys = Array.from({ length: n + 1 }, () => h * (1 - amp * (0.35 + r() * 0.65))); ys[n] = ys[0];
    for (let i = 0; i <= n * 4; i++) { const k = i / 4, i0 = Math.floor(k), f = k - i0, y = lerp(ys[i0], ys[Math.min(n, i0 + 1)], f * f * (3 - 2 * f)); q.lineTo(w * k / n, y); }
    q.lineTo(w, h); q.closePath(); q.fill(); return c;
  }
  function build() {
    const c = mk(W, H), q = c.getContext('2d');
    q.fillStyle = vgrad(q, 0, H, [[0, '#060b18'], [0.45, '#10203a'], [0.75, '#1e3550'], [1, '#2a4560']]); q.fillRect(0, 0, W, H);
    q.globalCompositeOperation = 'lighter'; blob(q, glow('rgba(255,200,140,.75)'), W * 0.18, H * 0.2, W * 0.35, W * 0.28, 0.45); q.globalCompositeOperation = 'source-over';
    const r = rng(2); q.fillStyle = 'rgba(220,235,255,.7)';
    for (let i = 0; i < 70 * o.density; i++) { q.globalAlpha = 0.1 + r() * 0.4; q.fillRect(r() * W, r() * H * 0.35, 1, 1); }
    q.globalAlpha = 1; vignette(q, W, H, 0.35); st.cache = c;
    st.hills = [hillStrip(31, H * 0.26, 'rgba(19,35,58,.8)', 0.7), hillStrip(32, H * 0.2, 'rgba(13,26,44,.95)', 0.8)];
    st.cloudImgs = [1, 2, 3, 4].map(s => cloudSprite(s * 13, Math.round(W * 0.34), Math.round(H * 0.16)));
    const r2 = rng(77);
    st.clouds = Array.from({ length: Math.round((o.lowPower ? 6 : 9) * o.density + 2) }, (_, i) => ({ layer: i % 3, x: r2(), y: 0.25 + r2() * 0.6, img: i % 4, s: 0.6 + r2() * 0.8 }));
  }
  build(); loadAtlas().then(() => o.onReady?.());
  return {
    resize(w, h) { W = w; H = h; build(); },
    frame(t) {
      g.drawImage(st.cache, 0, 0);
      // uzak tepeler (paralaks, sağa akar: uçak sola uçuyor)
      st.hills.forEach((im, i) => {   // görünür dilim kaynaktan kırpılır (sarma noktasında iki parça)
        const sp = [6, 14][i], sw = im.width, off = (t * sp) % sw, y = H - im.height + (i ? 0 : -H * 0.05), sx = (sw - off) % sw, w1 = Math.min(W, sw - sx);
        g.drawImage(im, sx, 0, w1, im.height, 0, y, w1, im.height);
        if (w1 < W) g.drawImage(im, 0, 0, W - w1, im.height, w1, y, W - w1, im.height);
      });
      const layerSp = [0.006, 0.014, 0.03], layerA = [0.18, 0.26, 0.2], layerS = [0.55, 0.85, 1.25];
      const drawClouds = L => { for (const c of st.clouds) { if (c.layer !== L) continue; const im = st.cloudImgs[c.img], w = im.width * c.s * layerS[L], h = im.height * c.s * layerS[L], x = fract(c.x + t * layerSp[L]) * (W + w) - w; g.globalAlpha = layerA[L]; g.drawImage(im, x, H * c.y - h / 2, w, h); } g.globalAlpha = 1; };
      drawClouds(0); drawClouds(1);
      // CAYMAZ (sinematik yörünge: 3/4 önden yandan → yandan → 3/4 arkadan yavaşça)
      const img = tinted('#5d7596', 0.36);
      const wide = W > H, px = (wide ? W * 0.68 : W * 0.5) + W * 0.025 * Math.sin(t * 0.11), py = H * (wide ? 0.4 : 0.3) + H * 0.025 * Math.sin(t * 0.19);
      const pw = (wide ? W * 0.42 : W * 0.95), deg = 90 + 38 * Math.sin(t * 0.045), roll = 0.07 * Math.sin(t * 0.13 + 0.6);
      if (img) {
        // ince hız çizgileri (uçağın arkasında)
        g.strokeStyle = 'rgba(200,225,255,.10)'; g.lineWidth = 1;
        for (let i = 0; i < 7; i++) { const yy = py + (i - 3) * pw * 0.05, xx = px + pw * 0.15 + fract(t * 0.6 + i * 0.37) * pw * 0.6; g.beginPath(); g.moveTo(xx, yy); g.lineTo(xx + pw * 0.18, yy); g.stroke(); }
        g.globalCompositeOperation = 'lighter'; blob(g, glow('rgba(120,170,230,.4)'), px, py, pw * 0.45, pw * 0.2, 0.25); g.globalCompositeOperation = 'source-over';
        drawPlane(g, img, deg, px, py, pw, { alpha: 0.82, roll });
      }
      drawClouds(2);
    },
    dispose() { st.cache = null; st.hills = []; st.cloudImgs = []; st.clouds = []; },
  };
}

export const SCENES = { hangar, crew, tracks, missions, caymaz };
export function createScene(name, g, W, H, o = {}) {
  const f = SCENES[name]; if (!f) throw new Error(`sahne yok: ${name}`);
  return f(g, W, H, { density: 1, theme: 'dark', lowPower: false, ...o });
}
