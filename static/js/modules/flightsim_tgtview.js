// Uçuş Simülatörü §24.4 — sihirbaz HEDEF 3B ÖNİZLEMESİ (HEPGO "Hedefler" kartı + SIMUMAV HEDEFLER adımı ortak). Kullanıcı isteği: "seçilen hedefi
// girmeden önce 3 boyutlu olarak görelim".
// • Tek WebGL bağlamı kuralı: kartlar 2B tuvaldir; görüntü 3B katmanın model görüntüleyicisinden (flightsim3d `createModelViewer`: aynı renderer'da küçük
//   sahne → render hedefi → readPixels → putImageData) kopyalanır. HEPGO'da sihirbazın dünya önizlemesi (preview sim) paylaşılır; SIMUMAV hedef adımında
//   başka 3B sahne olmadığından tek bir "stüdyo" bağlamı açılır (createFlightSim3D(..., {studio: true})) ve adımdan çıkınca kapatılır.
// • Kare başına EN ÇOK BİR kart çizilir (~30 fps): etkileşimdeki kart (sürükleme/tekerlek/üzerinde) her turda, diğer görünür kartlar sırayla
//   (IntersectionObserver; görünmeyen/DOM'dan düşen kart çizilmez). Kartlar kendiliğinden döner; sürükle → döndür, tekerlek → yakınlaştır, çift tık → sıfırla.
// • Tuvalin üstünde ölçek çubuğu (niceScale: 40–110 px'e sığan 0,1/0,2/0,25/0,5/1/2/5/10 m) + ızgara adımı; altında model adı, seyir/azami hız, boyut.
// Dışa: createTargetPreviews({ getViewer, tr }) → { attach(getInfo) → el, redraw(), dispose() } — getInfo() → { item: {model, glb_url, orient, has_prop},
//   name, cruise_ms, max_ms } (her çizimde okunur: kart modeli değişince önizleme de değişir). getViewer() her turda çağrılır → görüntüleyici | null.
// Saf yardımcılar (tests/test_flightsim_tgthud.mjs): niceScale, fmtSize.

const STEPS = [0.05, 0.1, 0.2, 0.25, 0.5, 1, 2, 5, 10, 20, 50];

/** Ölçek çubuğu: piksel/metre → {m, px} (px ∈ [minPx, maxPx] mümkünse; değilse en yakın). */
export function niceScale(ppm, minPx = 40, maxPx = 110) {
  if (!(ppm > 0)) return null;
  let best = null;
  for (const m of STEPS) { const px = m * ppm; if (px >= minPx && px <= maxPx) return { m, px }; if (!best || Math.abs(px - (minPx + maxPx) / 2) < Math.abs(best.px - (minPx + maxPx) / 2)) best = { m, px }; }
  return best;
}
export const fmtLen = m => (m >= 1 ? `${+m.toFixed(m >= 10 ? 0 : 1)} m` : `${Math.round(m * 100)} cm`);
/** Boyut [x, y, z] (m) → "1,65 × 1,20 × 0,30 m" (uzunluk × açıklık × yükseklik; ondalık virgül yok — sayısal). */
export const fmtSize = s => (Array.isArray(s) ? `${s.map(v => Number(v).toFixed(v >= 10 ? 1 : 2)).join(' × ')} m` : '—');
const kmh = ms => Math.round(Number(ms) * 3.6);

export function createTargetPreviews({ getViewer = () => null, tr = s => s } = {}) {
  const entries = new Set();
  let raf = 0, lastTick = 0, rr = 0, disposed = false;
  const io = typeof IntersectionObserver !== 'undefined' ? new IntersectionObserver(list => { for (const e of list) { const en = e.target.__tgv; if (en) en.visible = e.isIntersecting; } }) : null;
  const dprOf = () => Math.min(1.5, (typeof devicePixelRatio !== 'undefined' && devicePixelRatio) || 1);

  function attach(getInfo) {
    const cv = document.createElement('canvas');
    cv.className = 'fs-tgv-cv'; cv.width = 320; cv.height = 180;
    cv.title = tr('Sürükle: döndür · tekerlek: yakınlaştır · çift tık: sıfırla');
    const cap = document.createElement('div'); cap.className = 'fs-tgv-cap';
    const el = document.createElement('div'); el.className = 'fs-tgv';
    el.append(cv, cap);
    const en = { el, cv, cap, getInfo, az: 0.9 + Math.random() * 0.5, el0: 0.32, elv: 0.32, zoom: 1, user: -Infinity, hover: false, drag: null, visible: !io, lastAt: 0, size: null, capKey: '', ppm: 0, grid: 0, err: null };
    el.__tgv = en;
    cv.addEventListener('pointerdown', e => { en.drag = { x: e.clientX, y: e.clientY }; en.user = performance.now(); cv.setPointerCapture?.(e.pointerId); e.preventDefault(); });
    cv.addEventListener('pointermove', e => {
      if (!en.drag) return;
      en.az -= (e.clientX - en.drag.x) * 0.012; en.elv = Math.min(1.35, Math.max(-0.35, en.elv + (e.clientY - en.drag.y) * 0.008));
      en.drag = { x: e.clientX, y: e.clientY }; en.user = performance.now();
    });
    const up = () => { en.drag = null; en.user = performance.now(); };
    cv.addEventListener('pointerup', up); cv.addEventListener('pointercancel', up);
    cv.addEventListener('wheel', e => { en.zoom = Math.min(4, Math.max(0.4, en.zoom * (e.deltaY > 0 ? 1 / 1.15 : 1.15))); en.user = performance.now(); e.preventDefault(); }, { passive: false });
    cv.addEventListener('dblclick', () => { en.zoom = 1; en.elv = en.el0; en.user = performance.now(); });
    cv.addEventListener('pointerenter', () => { en.hover = true; });
    cv.addEventListener('pointerleave', () => { en.hover = false; });
    entries.add(en);
    io?.observe(el);
    caption(en);
    start();
    return el;
  }

  function caption(en) {
    const inf = en.getInfo() || {};
    const key = `${inf.name}|${inf.cruise_ms}|${inf.max_ms}|${en.size}`;
    if (key === en.capKey) return;
    en.capKey = key;
    const b = document.createElement('b'); b.textContent = inf.name || inf.item?.model || '—';
    const sp = document.createElement('span'); sp.className = 'fs-tgv-spd';
    sp.textContent = inf.cruise_ms != null ? tr('seyir {c} · azami {x} km/h', { c: kmh(inf.cruise_ms), x: kmh(inf.max_ms) }) : '';
    const sz = document.createElement('span'); sz.className = 'fs-tgv-size';
    sz.textContent = en.size ? `${tr('Boyut')}: ${fmtSize(en.size)}` : '';
    en.cap.replaceChildren(b, sp, sz);
  }

  function overlay(en, w, h, dpr) {
    const g = en.cv.getContext('2d');
    g.save(); g.scale(dpr, dpr);
    const W = w / dpr, H = h / dpr;
    const sc = niceScale(en.ppm / dpr);
    g.font = '600 11px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace'; g.textBaseline = 'alphabetic';
    if (sc) {
      const x0 = 10, y0 = H - 10, L = sc.px;
      g.lineWidth = 3; g.strokeStyle = 'rgba(0,0,0,.7)';
      g.beginPath(); g.moveTo(x0, y0 - 5); g.lineTo(x0, y0); g.lineTo(x0 + L, y0); g.lineTo(x0 + L, y0 - 5); g.stroke();
      g.lineWidth = 1.5; g.strokeStyle = '#9cff6a'; g.stroke();
      g.lineWidth = 3; g.strokeStyle = 'rgba(0,0,0,.8)'; g.fillStyle = '#d8ffe0';
      const lab = fmtLen(sc.m); g.strokeText(lab, x0 + L + 6, y0); g.fillText(lab, x0 + L + 6, y0);
    }
    if (en.grid) { const lab = `${tr('ızgara')} ${fmtLen(en.grid)}`; g.textAlign = 'right'; g.lineWidth = 3; g.strokeStyle = 'rgba(0,0,0,.8)'; g.fillStyle = 'rgba(200,255,215,.75)'; g.strokeText(lab, W - 8, H - 10); g.fillText(lab, W - 8, H - 10); }
    g.restore();
  }

  function placeholder(en, msg) {
    const g = en.cv.getContext('2d'), w = en.cv.width, h = en.cv.height;
    g.fillStyle = '#0b1418'; g.fillRect(0, 0, w, h);
    g.fillStyle = 'rgba(200,255,215,.7)'; g.font = `${Math.round(12 * dprOf())}px system-ui, sans-serif`; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText(msg, w / 2, h / 2);
  }

  function renderOne(en, viewer, now) {
    const dpr = dprOf(), cw = Math.max(120, en.cv.clientWidth || 280), ch = Math.max(90, en.cv.clientHeight || 158);
    const w = Math.round(cw * dpr), h = Math.round(ch * dpr);
    if (en.cv.width !== w || en.cv.height !== h) { en.cv.width = w; en.cv.height = h; }
    const dt = en.lastAt ? Math.min(0.2, (now - en.lastAt) / 1000) : 0;
    en.lastAt = now;
    if (!en.drag && now - en.user > 2500) en.az += dt * 0.55;   // kendiliğinden dönüş (etkileşimden 2,5 sn sonra sürer)
    const inf = en.getInfo() || {};
    if (!inf.item) { placeholder(en, '—'); return; }
    if (!viewer) { placeholder(en, tr('3B önizleme hazırlanıyor…')); return; }
    let r = null;
    try { r = viewer.render(en.cv, inf.item, { az: en.az, el: en.elv, zoom: en.zoom, spin: dt * 40 }); } catch (err) { r = { error: err.message }; }
    if (!r) { placeholder(en, tr('Model yükleniyor…')); return; }
    if (r.error) { placeholder(en, tr('Model yüklenemedi')); return; }
    en.ppm = r.ppm; en.grid = r.grid;
    const sz = r.size.map(v => +v.toFixed(2)).join(',');
    if (String(en.size) !== sz) { en.size = sz.split(',').map(Number); caption(en); }
    overlay(en, w, h, dpr);
  }

  function tick(now) {
    raf = 0;
    if (disposed) return;
    raf = requestAnimationFrame(tick);
    if (now - lastTick < 30) return;
    lastTick = now;
    for (const en of entries) if (!en.el.isConnected) { entries.delete(en); io?.unobserve(en.el); }
    if (!entries.size) { cancelAnimationFrame(raf); raf = 0; return; }
    const vis = [...entries].filter(en => en.visible);
    if (!vis.length) return;
    let viewer = null;
    try { viewer = getViewer() || null; } catch { viewer = null; }
    for (const en of vis) caption(en);
    const active = vis.find(en => en.drag || en.hover || now - en.user < 1500);
    const en = active && (rr++ % 4 !== 0 || vis.length === 1) ? active : vis[(rr++) % vis.length];   // etkileşimdeki kart çoğu turda, diğerleri sırayla
    renderOne(en, viewer, now);
  }
  function start() { if (!raf && !disposed) raf = requestAnimationFrame(tick); }

  return {
    attach,
    redraw: () => { for (const en of entries) { en.capKey = ''; en.lastAt = 0; } start(); },
    get count() { return entries.size; },
    dispose() { disposed = true; if (raf) cancelAnimationFrame(raf); raf = 0; io?.disconnect(); entries.clear(); },
  };
}
