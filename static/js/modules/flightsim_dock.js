// Uçuş Simülatörü §27.4 — yüzen ekran pencereleri (radar / EO) için SAF yerleşim kuralları (DOM yok; tests/test_flightsim_flyui.mjs).
// Pencere varsayılan olarak sol alt dokta durur; başlık çubuğundan sürüklenince "yüzen" olur, köşe tutamacıyla en/boy oranı KORUNARAK
// boyutlandırılır (radar ölçekli harita, EO kamera görüntüsü — oran bozulursa görüntü gerilir). Bırakınca: kenarlara/köşelere yapışma (≤ SNAP px),
// engellerden kaçınma (kamera PiP'i, alt ortadaki kadranlar, Mission Planner kutusu, harekât kartı, diğer pencere) ve sahne sınırına kırpma.
// Kalıcı biçim (localStorage fs.site.win): ekran boyutuna ORANLI {fx, fy, fw, sx, sy} — sx/sy yapışılan kenar ('l'|'r' / 't'|'b'|null):
// yapışık kenar ekran boyutu değişince de yapışık kalır (sağ alttaki pencere sağ altta), yapışmayan eksende sol/üst oranı korunur.
export const WIN_MARGIN = 12, WIN_SNAP = 28, WIN_MIN_W = 190;
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const num = (v, d) => (v == null || !Number.isFinite(Number(v)) ? d : Number(v));
const r4 = v => Math.round(v * 10000) / 10000;

/** Sınırlar: {left, top, right, bottom} (sahne koordinatı, px). Varsayılan: kenar boşluklu tam sahne. */
export const boundsOf = (W, H, b = {}) => ({ left: num(b.left, WIN_MARGIN), top: num(b.top, WIN_MARGIN), right: W - num(b.right, WIN_MARGIN), bottom: H - num(b.bottom, WIN_MARGIN) });

/** Azami genişlik: sahne genişliğinin %60'ı ve yükseklik sınırı (oran korunarak); en az WIN_MIN_W. */
export function winMaxW(W, H, aspect, bounds = null) {
  const B = bounds || boundsOf(W, H);
  return Math.max(WIN_MIN_W, Math.min((B.right - B.left), W * 0.6, (B.bottom - B.top) * aspect));
}
/** Oran korunarak boyut: w → {w, h}; h = w / aspect (+ başlık yüksekliği hdr). */
export function sizeFor(w, aspect, { W = 1e9, H = 1e9, hdr = 0, bounds = null } = {}) {
  const ww = Math.round(clamp(num(w, WIN_MIN_W), WIN_MIN_W, winMaxW(W, H - hdr, aspect, bounds && { ...bounds, bottom: bounds.bottom - hdr })));
  return { w: ww, h: Math.round(ww / aspect) + hdr };
}
/** Köşe tutamacıyla boyutlandırma: başlangıç genişliği w0, imleç kayması dx/dy → yeni genişlik (iki eksenin büyüğü, oran korunur). corner: 'br' | 'bl'. */
export function resizeW(w0, dx, dy, aspect, corner = 'br') {
  const sx = corner === 'bl' ? -dx : dx;
  const byY = dy * aspect;
  return w0 + (Math.abs(sx) >= Math.abs(byY) ? sx : byY);
}

/** Dikdörtgeni sınırların içine kırp (sığmıyorsa sol/üst öncelikli). */
export function clampRect(r, B) {
  const x = clamp(r.x, B.left, Math.max(B.left, B.right - r.w)), y = clamp(r.y, B.top, Math.max(B.top, B.bottom - r.h));
  return { ...r, x: Math.round(x), y: Math.round(y) };
}
/** Kenarlara yapışma: sınıra SNAP px'ten yakın kenar tam sınıra oturur; dönüş {…r, sx, sy}. */
export function snapRect(r, B, snap = WIN_SNAP) {
  let { x, y } = r, sx = null, sy = null;
  if (Math.abs(x - B.left) <= snap) { x = B.left; sx = 'l'; } else if (Math.abs(B.right - (x + r.w)) <= snap) { x = B.right - r.w; sx = 'r'; }
  if (Math.abs(y - B.top) <= snap) { y = B.top; sy = 't'; } else if (Math.abs(B.bottom - (y + r.h)) <= snap) { y = B.bottom - r.h; sy = 'b'; }
  return { ...r, x: Math.round(x), y: Math.round(y), sx, sy };
}
export const overlaps = (a, b, pad = 0) => a.x < b.x + b.w + pad && b.x < a.x + a.w + pad && a.y < b.y + b.h + pad && b.y < a.y + a.h + pad;

/**
 * Engellerden kaçınma: r hiçbir engelle (pad boşlukla) çakışmıyorsa olduğu gibi; çakışıyorsa çakıştığı engellerin dört yanına itilmiş adaylar
 * genişlik öncelikli olarak (en çok `depth` tur: adayın adayı …) üretilir; sınırlar içinde kalan, hiçbir engelle çakışmayan ve r'ye EN YAKIN
 * aday seçilir. Uygun aday yoksa en az çakışan alana sahip aday (tamamen çözülemeyen sıkışık ekranda pencere yine görünür kalır).
 * maxMove: kullanıcının bıraktığı yerden en çok bu kadar (px) uzaklaşılır — daha uzaktaki boş yer yerine bırakılan yerde (az çakışmayla) kalır
 * (kalabalık ekranda sağa sürüklenen pencerenin ekranın öbür ucuna "ışınlanması" engellenir).
 */
export function avoidRects(r, obstacles, B, pad = 8, depth = 4, maxMove = Infinity) {
  const obs = (obstacles || []).filter(o => o && o.w > 0 && o.h > 0);
  const hits = c => obs.filter(o => overlaps(c, o, pad));
  if (!hits(r).length) return { ...r };
  const pushes = (c, o) => [
    { ...c, x: o.x - pad - c.w }, { ...c, x: o.x + o.w + pad },
    { ...c, y: o.y - pad - c.h }, { ...c, y: o.y + o.h + pad }].map(q => clampRect(q, B));
  const d = c => Math.hypot(c.x - r.x, c.y - r.y);
  const seen = new Set([`${Math.round(r.x)},${Math.round(r.y)}`]), all = [];
  let level = [r], best = null;
  for (let k = 0; k < depth && level.length; k++) {
    const next = [];
    for (const c of level) for (const o of hits(c)) for (const q of pushes(c, o)) {
      const key = `${q.x},${q.y}`; if (seen.has(key)) continue; seen.add(key);
      all.push(q);
      if (!hits(q).length) { if (d(q) <= maxMove && (!best || d(q) < d(best))) best = q; } else next.push(q);
    }
    if (best && level.every(c => d(c) >= d(best))) break;   // daha derin adaylar yalnız uzaklaşır
    level = next.sort((a, b) => d(a) - d(b)).slice(0, 48);
  }
  if (best) return { ...best, sx: null, sy: null };
  const area = c => hits(c).reduce((sum, o) => sum + Math.max(0, Math.min(c.x + c.w, o.x + o.w) - Math.max(c.x, o.x)) * Math.max(0, Math.min(c.y + c.h, o.y + o.h) - Math.max(c.y, o.y)), 0);
  return { ...[r, ...all.filter(c => d(c) <= maxMove)].sort((a, b) => area(a) - area(b) || d(a) - d(b))[0] };
}

/** Piksel dikdörtgeni → oranlı kayıt {fx, fy, fw, sx, sy}. */
export function toFrac(r, W, H) {
  return { fx: r4(r.x / Math.max(1, W)), fy: r4(r.y / Math.max(1, H)), fw: r4(r.w / Math.max(1, W)), sx: r.sx || null, sy: r.sy || null };
}
/** Oranlı kayıt → piksel dikdörtgeni (oran korunarak h; yapışık kenar korunur; sınıra kırpılır). Geçersiz kayıt → null. */
export function fromFrac(f, W, H, aspect, { hdr = 0, bounds = null } = {}) {
  if (!f || !Number.isFinite(Number(f.fx)) || !Number.isFinite(Number(f.fy)) || !(Number(f.fw) > 0)) return null;
  const B = bounds || boundsOf(W, H);
  const s = sizeFor(Number(f.fw) * W, aspect, { W, H, hdr, bounds: B });
  let x = Number(f.fx) * W, y = Number(f.fy) * H;
  const sx = f.sx === 'l' || f.sx === 'r' ? f.sx : null, sy = f.sy === 't' || f.sy === 'b' ? f.sy : null;
  if (sx === 'l') x = B.left; else if (sx === 'r') x = B.right - s.w;
  if (sy === 't') y = B.top; else if (sy === 'b') y = B.bottom - s.h;
  return { ...clampRect({ x, y, w: s.w, h: s.h }, B), sx, sy };
}
/** Kayıt doğrulaması (localStorage'dan gelen bozuk değerler): geçerli {fx,fy,fw,sx,sy} ya da null. */
export function normWin(f) {
  if (!f || typeof f !== 'object') return null;
  const fx = Number(f.fx), fy = Number(f.fy), fw = Number(f.fw);
  if (![fx, fy, fw].every(Number.isFinite) || fw <= 0 || fw > 1 || fx < -0.5 || fx > 1.5 || fy < -0.5 || fy > 1.5) return null;
  return { fx: r4(fx), fy: r4(fy), fw: r4(fw), sx: f.sx === 'l' || f.sx === 'r' ? f.sx : null, sy: f.sy === 't' || f.sy === 'b' ? f.sy : null };
}
