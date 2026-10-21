// Uçuş Simülatörü §24.5 — F-16 tarzı HEDEF SEMBOLOJİSİ (gimbal kamerası askeri HUD'u 'fpv' + FPV OSD 'pilot'). three.js'siz saf katman + 2B çizim.
// Kullanıcı isteği: "uçarken gimbal ve FPV modundayken aynı F-16 uçaklarında olduğu gibi hedefler prizma şeklinde görünsün, HUD'un ortasından hedefe
// doğru çizgi çizilsin, hedef ekrandan çıkarsa hedefin yönüne doğru tarif etsin."
//
// • Veri: 3B katman (flightsim3d `targetsHud()`) her çağrıda SON render edilen kameranın pozunu ve hedeflerin dünya uzayındaki yönlendirilmiş sınır kutusu
//   köşelerini verir: { view: {pos, fwd, up, right, tanV, aspect, k, scale}, radius, sel: {i, auto}, player: {vel}, items: [{i, name, center, corners[8],
//   vel, dist, dz, inside, flash}] } — ENU (x doğu, y kuzey, z yukarı). `k/scale`: FPV balıkgözü (CAM_FRAG `uv = 0.5 + d·(1 + k·r²)·scale`) → ekranda
//   görünen nokta için ters çözüm (barrelScreen).
// • İzdüşüm (projectView): kamera uzayı xc = d·right, yc = d·up, zf = d·fwd; ndc = (xc / (zf·tanV·aspect), yc / (zf·tanV)) → ekran (0…1, y aşağı).
// • Ekran dışı yön (screenDir): bölme YAPILMADAN (xc, −yc) — kameranın arkasındaki (zf ≤ 0) hedefte de yön doğru kalır (ndc bölümü arka yarım kürede
//   işareti çevirirdi). Tam arkada (xc≈yc≈0) aşağı ok. Ok, ekran merkezli elipsin (HUD bantlarının içinde) kenarına oturur (edgePoint).
// • Prizma: hedefin 3B sınır kutusunun 8 köşesinin izdüşümü tel kafes (12 kenar); en küçük boyut sınırı (fitMin: merkez etrafında ölçeklenir → uzakta da
//   prizma biçimi okunur). Kilitli hedefte ayrıca TD kutusu (kare, dolgulu köşeler), veri bloğu (ad · menzil · kapanma hızı Vc · irtifa farkı ΔH) ve
//   boresight'tan TD kutusuna Target Locator Line (TLL; boresight kutunun içindeyse çizilmez). Ekran dışında kilitli hedef: TLL kenardaki oka uzanır,
//   yanında sapma açısı (°, boresight'tan) + menzil.
// • Seçim (selectTarget/lockedIndex): varsayılan "oto" = en yakın hedef; Tab / Shift+Tab sıradaki / önceki hedefe kilitlenir (i sırasıyla döngü); kilitli
//   hedef listeden düşerse oto'ya döner.
// • §40 angajman (Boşluk ile kilit; flightsim_engage.js): data.eng = {i} → o hedefin TD kutusu çift çerçeve + üstte "KİLİT" (ekran dışında ok bloğunda).
// • Önleme: hedef önleme yarıçapı içindeyse (ya da önleme olayından sonraki 2 sn) prizma + kutu yanıp söner ve "ÖNLEME" (İng. SHOOT) ibaresi.
// • Renk: HUD rengi (yeşil/beyaz/amber; OSD beyaz) + siyah dış çizgi → termal/gece görüşü görüntüsünde de okunur. DOM yok; 60 fps'te ~0,1 ms.
// Testler: tests/test_flightsim_tgthud.mjs.

export const TD_MIN_PX = 22;          // prizmanın ekrandaki en küçük boyutu (CSS px; S ölçeğiyle çarpılır)
export const TD_BOX_MIN_PX = 34;      // kilitli hedef TD kutusunun en küçük kenarı
export const NEAR_M = 0.5;            // kameranın önünde sayılmak için en az derinlik (m)
export const FLASH_MS = 2000;
export const BOX_EDGES = [[0, 1], [1, 3], [3, 2], [2, 0], [4, 5], [5, 7], [7, 6], [6, 4], [0, 4], [1, 5], [2, 6], [3, 7]];   // köşe bitleri: x=1, y=2, z=4

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const DEG = 180 / Math.PI;

/** Kutu köşeleri (min/max) → 8 köşe, BOX_EDGES bit sırasıyla. */
export function boxCorners(min, max) {
  const out = [];
  for (let k = 0; k < 8; k++) out.push([k & 1 ? max[0] : min[0], k & 2 ? max[1] : min[1], k & 4 ? max[2] : min[2]]);
  return out;
}

/** Kamera uzayı: [xc (sağ), yc (yukarı), zf (ileri)]. */
export function camSpace(v, p) {
  const d = sub(p, v.pos);
  return [dot(d, v.right), dot(d, v.up), dot(d, v.fwd)];
}

/** FPV balıkgözü ters çözümü: sahne ofseti q (= örneklenen uv − 0.5) → ekranda görünen ofset d; q = d·(1 + k·|d|²)·scale (sabit nokta yinelemesi). */
export function barrelScreen(qx, qy, k, scale) {
  if (!k) return [qx / (scale || 1), qy / (scale || 1)];
  let dx = qx / scale, dy = qy / scale;
  for (let n = 0; n < 8; n++) { const f = scale * (1 + k * (dx * dx + dy * dy)); dx = qx / f; dy = qy / f; }
  return [dx, dy];
}

/** Dünya noktası → normalize ekran {sx, sy (0…1, y aşağı), xc, yc, zf, front}. Arkadaysa sx/sy anlamsızdır (front = false). */
export function projectView(v, p) {
  const [xc, yc, zf] = camSpace(v, p);
  const front = zf > NEAR_M;
  const z = Math.max(zf, 1e-6);
  let qx = xc / (z * v.tanV * v.aspect) / 2, qy = -yc / (z * v.tanV) / 2;   // ekran merkezinden ofset (uv birimi, y aşağı)
  if (v.k) [qx, qy] = barrelScreen(qx, qy, v.k, v.scale || 1);
  return { sx: 0.5 + qx, sy: 0.5 + qy, xc, yc, zf, front };
}

/** Boresight'tan (kamera ekseni) hedefe sapma açısı (°, 0…180). */
export function offAngle(v, p) {
  const [xc, yc, zf] = camSpace(v, p);
  return Math.atan2(Math.hypot(xc, yc), zf) * DEG;
}

/** Ekran düzleminde hedefin yönü (birim [dx, dy], y aşağı) — arka yarım kürede de doğru (bölme yok). */
export function screenDir(v, p) {
  const [xc, yc] = camSpace(v, p);
  const L = Math.hypot(xc, yc);
  return L < 1e-9 ? [0, 1] : [xc / L, -yc / L];
}

/** Ekran yönü açısı (° — 0 = yukarı, saat yönünde +; ok döndürme ve test). */
export const dirAngle = d => ((Math.atan2(d[0], -d[1]) * DEG) + 360) % 360;

/** (cx, cy) merkezli rx×ry elipsin d yönündeki kenar noktası. */
export function edgePoint(d, cx, cy, rx, ry) {
  const t = 1 / Math.sqrt((d[0] / rx) ** 2 + (d[1] / ry) ** 2);
  return [cx + d[0] * t, cy + d[1] * t];
}

/** Ekran noktaları (px) en küçük boyuttan küçükse merkez etrafında ölçekle. Dönüş {pts, bb:{x0,y0,x1,y1}, scaled}. */
export function fitMin(pts, minPx) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of pts) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  const size = Math.max(x1 - x0, y1 - y0);
  if (!(size < minPx)) return { pts, bb: { x0, y0, x1, y1 }, scaled: false };
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, f = size > 1e-6 ? minPx / size : 1;
  const out = size > 1e-6 ? pts.map(([x, y]) => [cx + (x - cx) * f, cy + (y - cy) * f]) : pts.map(() => [cx, cy]);
  const h = minPx / 2;
  return { pts: out, bb: size > 1e-6 ? { x0: cx + (x0 - cx) * f, y0: cy + (y0 - cy) * f, x1: cx + (x1 - cx) * f, y1: cy + (y1 - cy) * f } : { x0: cx - h, y0: cy - h, x1: cx + h, y1: cy + h }, scaled: true };
}

/** Kapanma hızı Vc (m/s, + yaklaşıyor): −d·(vt − vp) / |d|; d = hedef − oyuncu. */
export function closureRate(d, vt, vp) {
  const L = Math.hypot(d[0], d[1], d[2]);
  if (L < 1e-6) return 0;
  return -((d[0] * (vt[0] - vp[0])) + (d[1] * (vt[1] - vp[1])) + (d[2] * ((vt[2] || 0) - (vp[2] || 0)))) / L;
}

/** (px, py)'den (tx, ty)'ye doğru ışının kutuya girdiği nokta; başlangıç kutunun içindeyse null. */
export function rectEntry(px, py, tx, ty, bb) {
  const dx = tx - px, dy = ty - py;
  if (px >= bb.x0 && px <= bb.x1 && py >= bb.y0 && py <= bb.y1) return null;
  let tmin = 0;
  if (Math.abs(dx) > 1e-9) tmin = Math.max(tmin, Math.min((bb.x0 - px) / dx, (bb.x1 - px) / dx));
  if (Math.abs(dy) > 1e-9) tmin = Math.max(tmin, Math.min((bb.y0 - py) / dy, (bb.y1 - py) / dy));
  if (!(tmin > 0 && tmin <= 1)) return null;
  return [px + dx * tmin, py + dy * tmin];
}

/** Hedef seçimi: list [{i, dist}], state {i, auto}; step ±1 → bir sonraki/önceki (i sırasıyla döngü). step 0 → durum doğrulaması. */
export function selectTarget(list, state, step = 0) {
  const ids = (list || []).map(r => r.i).sort((a, b) => a - b);
  if (!ids.length) return { i: null, auto: true };
  const cur = lockedIndex(list, state);
  if (!step) return state && !state.auto && ids.includes(state.i) ? { i: state.i, auto: false } : { i: null, auto: true };
  const k = ids.indexOf(cur);
  return { i: ids[((k < 0 ? 0 : k + step) % ids.length + ids.length) % ids.length], auto: false };
}

/** Kilitli hedefin i'si: elle seçilmiş ve listede ise o; değilse en yakın (oto). Liste boşsa null. */
export function lockedIndex(list, state) {
  if (!list || !list.length) return null;
  if (state && !state.auto && list.some(r => r.i === state.i)) return state.i;
  let best = null;
  for (const r of list) if (best == null || r.dist < best.dist) best = r;
  return best.i;
}

export const fmtRange = d => (d >= 1000 ? `${(d / 1000).toFixed(d >= 10000 ? 0 : 2)}km` : `${Math.round(d)}m`);

/**
 * Sembolojiyi ekran pikseline çöz (çizimden ayrı → test edilebilir).
 * opts: { S (ölçek), bx, by (boresight px), inset {l, r, t, b} (ok elipsi + ekran-içi sınırı), now (ms) }.
 * Dönüş: { items: [{i, label, name, dist, dz, vc, off, inside, flash, locked, on, x, y, pts|null, bb, arrow: {x, y, ang}|null}], locked, tll: {x1, y1, x2, y2}|null }.
 */
export function symbology(data, W, H, opts = {}) {
  const S = opts.S || 1, v = data?.view;
  const out = { items: [], locked: null, tll: null };
  if (!v || !data.items?.length) return out;
  const ins = { l: 60 * S, r: 60 * S, t: 70 * S, b: 70 * S, ...(opts.inset || {}) };
  const rx = Math.max(40, (W - ins.l - ins.r) / 2), ry = Math.max(40, (H - ins.t - ins.b) / 2), ex = ins.l + rx, ey = ins.t + ry;
  const bx = opts.bx ?? W / 2, by = opts.by ?? H / 2, m = 6 * S;
  const lockI = lockedIndex(data.items, data.sel);
  const vp = data.player?.vel || [0, 0, 0];
  for (const it of data.items) {
    const p = projectView(v, it.center);
    const x = p.sx * W, y = p.sy * H;
    const on = p.front && x >= m && x <= W - m && y >= m && y <= H - m;
    const r = { i: it.i, label: String(it.i + 1), name: it.name || '', dist: it.dist, dz: it.dz, vc: closureRate(sub(it.center, data.player?.pos || v.pos), it.vel || [0, 0, 0], vp),
      off: offAngle(v, it.center), inside: !!it.inside, flash: !!it.flash, locked: it.i === lockI, engaged: data.eng?.i === it.i, on, x, y, pts: null, bb: null, arrow: null };
    if (on) {
      const cs = (it.corners || []).map(c => projectView(v, c));
      if (cs.length === 8 && cs.every(c => c.front)) {
        const f = fitMin(cs.map(c => [c.sx * W, c.sy * H]), TD_MIN_PX * S);
        r.pts = f.pts; r.bb = f.bb;
      } else { const h = TD_MIN_PX * S / 2; r.bb = { x0: x - h, y0: y - h, x1: x + h, y1: y + h }; }
    } else {
      const d = screenDir(v, it.center);
      const [ax, ay] = edgePoint(d, ex, ey, rx, ry);
      r.arrow = { x: ax, y: ay, ang: dirAngle(d), d };
    }
    out.items.push(r);
    if (r.locked) out.locked = r;
  }
  const L = out.locked;
  if (L) {
    if (L.on) {
      const pad = 6 * S, half = Math.max(TD_BOX_MIN_PX * S / 2, (L.bb.x1 - L.bb.x0) / 2 + pad, (L.bb.y1 - L.bb.y0) / 2 + pad);
      const cx = (L.bb.x0 + L.bb.x1) / 2, cy = (L.bb.y0 + L.bb.y1) / 2;
      L.td = { x0: cx - half, y0: cy - half, x1: cx + half, y1: cy + half };
      const e = rectEntry(bx, by, cx, cy, L.td);
      if (e) out.tll = { x1: bx, y1: by, x2: e[0], y2: e[1] };
    } else {
      const back = 14 * S;   // ok ucunun hemen gerisine
      out.tll = { x1: bx, y1: by, x2: L.arrow.x - L.arrow.d[0] * back, y2: L.arrow.y - L.arrow.d[1] * back };
    }
  }
  return out;
}

/**
 * 2B çizim (HUD/OSD tuvali; çağıran setTransform(dpr) yapmış olmalı). o: { color, S, F (temel yazı px), tr, now (ms), blinkMs }.
 * Sıra: TLL → kilitsiz prizmalar → kilitli prizma + TD kutusu + veri bloğu → kenar okları.
 */
export function drawSymbology(g, sym, o = {}) {
  if (!sym?.items?.length) return;
  const C = o.color || '#9cff6a', S = o.S || 1, F = o.F || 12 * S, tr = o.tr || (s => s);
  const now = o.now ?? (typeof performance !== 'undefined' ? performance.now() : Date.now());
  const blinkOn = Math.floor(now / (o.blinkMs || 220)) % 2 === 0;
  const OUT = 'rgba(0,0,0,.75)';
  const stroke = (w, col = C) => { g.lineWidth = w + 1.8; g.strokeStyle = OUT; g.stroke(); g.lineWidth = w; g.strokeStyle = col; g.stroke(); };
  const text = (s, x, y, { px = F, align = 'left', base = 'middle', bold = false, col = C } = {}) => {
    g.font = `${bold ? '700 ' : ''}${Math.round(px)}px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace`;
    g.textAlign = align; g.textBaseline = base; g.lineJoin = 'round';
    g.lineWidth = 3; g.strokeStyle = 'rgba(0,0,0,.85)'; g.strokeText(s, x, y); g.fillStyle = col; g.fillText(s, x, y);
  };
  const prism = (pts, w) => { g.beginPath(); for (const [a, b] of BOX_EDGES) { g.moveTo(pts[a][0], pts[a][1]); g.lineTo(pts[b][0], pts[b][1]); } stroke(w); };
  const diamond = (x, y, h, w) => { g.beginPath(); g.moveTo(x, y - h); g.lineTo(x + h, y); g.lineTo(x, y + h); g.lineTo(x - h, y); g.closePath(); stroke(w); };
  g.save();
  g.lineJoin = 'round'; g.lineCap = 'round';
  // TLL (boresight → kilitli hedef)
  if (sym.tll) { g.beginPath(); g.moveTo(sym.tll.x1, sym.tll.y1); g.lineTo(sym.tll.x2, sym.tll.y2); stroke(1.3 * S); }
  const hot = r => r.inside || r.flash;
  for (const r of sym.items) {
    if (!r.on) continue;
    const vis = !hot(r) || blinkOn;
    if (vis) { if (r.pts) prism(r.pts, (r.locked ? 1.6 : 1.1) * S); else diamond(r.x, r.y, TD_MIN_PX * S / 2, 1.2 * S); }
    if (!r.locked) {   // kilitsiz: numara üstte, menzil altta (küçük)
      text(r.label, (r.bb.x0 + r.bb.x1) / 2, r.bb.y0 - 7 * S, { align: 'center', px: F * 0.95, bold: true });
      text(fmtRange(r.dist), (r.bb.x0 + r.bb.x1) / 2, r.bb.y1 + 8 * S, { align: 'center', px: F * 0.8 });
    }
  }
  const L = sym.locked;
  if (L?.on && L.td) {
    const { x0, y0, x1, y1 } = L.td, c = Math.max(7 * S, (x1 - x0) * 0.22), vis = !hot(L) || blinkOn;
    if (vis) {
      g.beginPath(); g.rect(x0, y0, x1 - x0, y1 - y0); stroke(1.4 * S);
      if (L.engaged) { const q = 4 * S; g.beginPath(); g.rect(x0 - q, y0 - q, x1 - x0 + 2 * q, y1 - y0 + 2 * q); stroke(1.4 * S); }   // §40 kilit: çift çerçeve
      g.fillStyle = C;   // dolgulu köşeler (kilit)
      for (const [sx, sy] of [[x0, y0], [x1, y0], [x0, y1], [x1, y1]]) {
        const dx = sx === x0 ? 1 : -1, dy = sy === y0 ? 1 : -1;
        g.beginPath(); g.moveTo(sx, sy); g.lineTo(sx + dx * c, sy); g.lineTo(sx, sy + dy * c); g.closePath();
        g.lineWidth = 2.6; g.strokeStyle = OUT; g.stroke(); g.fill();
      }
    }
    // veri bloğu: kutunun DIŞ tarafında (ekran merkezinden uzak — merkezdeki boresight/bantlarla çakışmasın); o yanda yer yoksa iç tarafta
    const Wd = o.W ?? Infinity, room = 150 * S, outR = (x0 + x1) / 2 >= (Number.isFinite(Wd) ? Wd / 2 : 0);
    const right = outR ? Wd - x1 > room || x0 < room : !(x0 > room);
    const tx = right ? x1 + 8 * S : x0 - 8 * S, al = right ? 'left' : 'right', lh = F * 1.18;
    let ty = y0 + F * 0.5;
    text(`T${L.label} ${L.name}`.slice(0, 26), tx, ty, { align: al, px: F * 0.95, bold: true }); ty += lh;
    text(`${fmtRange(L.dist)}  Vc ${L.vc >= 0 ? '+' : '−'}${Math.abs(L.vc).toFixed(0)}`, tx, ty, { align: al, px: F * 0.92 }); ty += lh;
    text(`ΔH ${L.dz >= 0 ? '+' : '−'}${Math.abs(L.dz).toFixed(0)}m`, tx, ty, { align: al, px: F * 0.92 });
    if (L.engaged) text(tr('KİLİT'), (x0 + x1) / 2, y0 - 12 * S, { align: 'center', px: F * 1.05, bold: true });   // §40
    if (hot(L)) text(tr('ÖNLEME'), (x0 + x1) / 2, y1 + 12 * S, { align: 'center', px: F * 1.35, bold: true, col: blinkOn ? C : 'rgba(0,0,0,0)' });
  }
  // kenar okları (ekran dışı hedefler): üçgen dışa bakar; numara içeride; kilitliye sapma açısı + menzil
  for (const r of sym.items) {
    if (r.on || !r.arrow) continue;
    const { x, y, d } = r.arrow, s = (r.locked ? 13 : 9) * S, nx = -d[1], ny = d[0];
    const vis = !hot(r) || blinkOn;
    g.beginPath(); g.moveTo(x + d[0] * s, y + d[1] * s); g.lineTo(x - d[0] * s * 0.4 + nx * s * 0.7, y - d[1] * s * 0.4 + ny * s * 0.7); g.lineTo(x - d[0] * s * 0.4 - nx * s * 0.7, y - d[1] * s * 0.4 - ny * s * 0.7); g.closePath();
    if (vis) { if (r.locked) { g.fillStyle = C; g.lineWidth = 2.4; g.strokeStyle = OUT; g.stroke(); g.fill(); } else stroke(1.3 * S); }
    // numara okun yanında (dik yönde, ekranın içine düşen taraf); kilitliye sapma açısı + menzil bloğu okun gerisinde (içeride; kenara göre hizalı)
    const side = (nx * (o.W ? o.W / 2 - x : 0) + ny * (o.H ? o.H / 2 - y : 0)) >= 0 ? 1 : -1;
    text(r.label, x + nx * side * (s + 7 * S), y + ny * side * (s + 7 * S), { align: 'center', px: F * (r.locked ? 1.05 : 0.9), bold: true });
    if (r.locked) {
      const qx = x - d[0] * (s + 18 * S), qy = y - d[1] * (s + 18 * S), al = d[0] > 0.35 ? 'right' : d[0] < -0.35 ? 'left' : 'center';
      const dy = d[1] > 0.35 ? -F * 1.8 : d[1] < -0.35 ? F * 0.6 : -F * 0.6;   // alt kenarda blok yukarı, üst kenarda aşağı
      text(`${Math.round(r.off)}°`, qx, qy + dy, { align: al, px: F * 1.0, bold: true });
      text(fmtRange(r.dist), qx, qy + dy + F * 1.15, { align: al, px: F * 0.85 });
      if (r.engaged) text(tr('KİLİT'), qx, qy + dy - F * 1.15, { align: al, px: F * 0.95, bold: true });   // §40
      if (hot(r)) text(tr('ÖNLEME'), qx, qy + dy + F * 2.35, { align: al, px: F * 1.1, bold: true, col: blinkOn ? C : 'rgba(0,0,0,0)' });
    }
  }
  g.restore();
}
