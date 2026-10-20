// Görev geometri yardımcıları: yerel metre düzlemi, ilaçlama/tarama hat üretimi, koridor, HEPGO `route` biçimi.
const DEG = Math.PI / 180;
export const mpd = lat => ({ lat: 111320, lon: 111320 * Math.cos(lat * DEG) });
export const toLocal = (c, p) => { const m = mpd(c.lat); return { x: (p.lon - c.lon) * m.lon, y: (p.lat - c.lat) * m.lat }; };
export const toGeo = (c, l) => { const m = mpd(c.lat); return { lat: c.lat + l.y / m.lat, lon: c.lon + l.x / m.lon }; };
export const dist = (c, a, b) => { const A = toLocal(c, a), B = toLocal(c, b); return Math.hypot(A.x - B.x, A.y - B.y); };

/** Poligon içini `spacing` aralıklı paralel hatlarla (açı `angle`) doldur → sırayla gidip gelen (lawnmower) nokta listesi. */
export function sweepLines(center, polygon, spacing, angleDeg = 0) {
  if (polygon.length < 3) return [];
  const pts = polygon.map(p => toLocal(center, p));
  const a = angleDeg * DEG, ca = Math.cos(a), sa = Math.sin(a);
  const rot = p => ({ x: p.x * ca + p.y * sa, y: -p.x * sa + p.y * ca }), unrot = p => ({ x: p.x * ca - p.y * sa, y: p.x * sa + p.y * ca });
  const R = pts.map(rot);
  const minY = Math.min(...R.map(p => p.y)), maxY = Math.max(...R.map(p => p.y));
  const out = [];
  let flip = false;
  for (let y = minY + spacing / 2; y < maxY; y += spacing) {
    const xs = [];
    for (let i = 0; i < R.length; i++) {
      const p = R[i], q = R[(i + 1) % R.length];
      if ((p.y <= y && q.y > y) || (q.y <= y && p.y > y)) xs.push(p.x + ((y - p.y) * (q.x - p.x)) / (q.y - p.y));
    }
    xs.sort((u, v) => u - v);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const seg = [{ x: xs[k], y }, { x: xs[k + 1], y }];
      if (flip) seg.reverse();
      out.push(...seg.map(s => toGeo(center, unrot(s))));
    }
    flip = !flip;
    if (out.length > 480) break;
  }
  return out;
}

/** Çizgi + genişlik → koridor poligonu (çizim için) */
export function corridorPolygon(center, line, width) {
  if (line.length < 2) return [];
  const L = line.map(p => toLocal(center, p)), left = [], right = [];
  for (let i = 0; i < L.length; i++) {
    const p = L[i], q = L[Math.min(i + 1, L.length - 1)], o = L[Math.max(i - 1, 0)];
    const dx = q.x - o.x, dy = q.y - o.y, len = Math.hypot(dx, dy) || 1, nx = -dy / len, ny = dx / len;
    left.push({ x: p.x + nx * width / 2, y: p.y + ny * width / 2 }); right.push({ x: p.x - nx * width / 2, y: p.y - ny * width / 2 });
  }
  return [...left, ...right.reverse()].map(l => toGeo(center, l));
}

/** HEPGO flightsim_mission `route` biçimi: {points:[{seq, cmd, lat, lon, alt_rel}]} — cmd 22 kalkış, 16 waypoint, 21 iniş. */
export function buildRoute(home, pts, { alt = 50, takeoff = true, land = true, altFn = null } = {}) {
  const points = [];
  let seq = 0;
  if (takeoff) points.push({ seq: seq++, cmd: 22, lat: home.lat, lon: home.lon, alt_rel: alt, frame: 3 });
  for (const p of pts) points.push({ seq: seq++, cmd: 16, lat: +Number(p.lat).toFixed(7), lon: +Number(p.lon).toFixed(7), alt_rel: altFn ? altFn(p) : alt, frame: 3 });
  if (land) points.push({ seq: seq++, cmd: 21, lat: home.lat, lon: home.lon, alt_rel: 0, frame: 3 });
  return { points };
}

/** Plan noktalarını küçük canvas'a çiz (kart ön izlemesi). */
export function drawPreview(canvas, plan, track) {
  const ctx = canvas.getContext('2d'), W = canvas.width, H = canvas.height;
  ctx.clearRect(0, 0, W, H);
  if (plan?.kind === 'defend' || plan?.defend) { drawDefendPreview(ctx, W, H, plan.defend || {}); return; }   // HEPGO §26 "Yer kontrolünü koru" (rota yok)
  const pts = (plan?.route?.points || []).filter(p => Number.isFinite(p.lat));
  const poly = plan?.shape || [];
  const all = [...pts, ...poly, ...(plan?.gates || [])];
  if (!all.length) return;
  const c = track ? { lat: track.lat, lon: track.lon } : { lat: all[0].lat, lon: all[0].lon };
  const L = all.map(p => toLocal(c, p));
  const minX = Math.min(...L.map(p => p.x)), maxX = Math.max(...L.map(p => p.x)), minY = Math.min(...L.map(p => p.y)), maxY = Math.max(...L.map(p => p.y));
  const span = Math.max(maxX - minX, maxY - minY, 50) * 1.2, s = Math.min(W, H) / span;
  const X = p => W / 2 + (toLocal(c, p).x - (minX + maxX) / 2) * s, Y = p => H / 2 - (toLocal(c, p).y - (minY + maxY) / 2) * s;
  ctx.lineWidth = 2; ctx.lineJoin = 'round';
  if (poly.length > 2) { ctx.beginPath(); poly.forEach((p, i) => (i ? ctx.lineTo(X(p), Y(p)) : ctx.moveTo(X(p), Y(p)))); ctx.closePath(); ctx.fillStyle = 'rgba(167,139,250,.18)'; ctx.fill(); ctx.strokeStyle = '#a78bfa'; ctx.stroke(); }
  if (pts.length) { ctx.beginPath(); pts.forEach((p, i) => (i ? ctx.lineTo(X(p), Y(p)) : ctx.moveTo(X(p), Y(p)))); ctx.strokeStyle = '#38bdf8'; ctx.shadowColor = '#38bdf8'; ctx.shadowBlur = 8; ctx.stroke(); ctx.shadowBlur = 0; }
  for (const p of pts) { ctx.beginPath(); ctx.arc(X(p), Y(p), p.cmd === 22 ? 5 : p.cmd === 21 ? 5 : 3, 0, Math.PI * 2); ctx.fillStyle = p.cmd === 22 ? '#34d399' : p.cmd === 21 ? '#f87171' : '#fff'; ctx.fill(); }
  for (const g of plan?.gates || []) { ctx.beginPath(); ctx.arc(X(g), Y(g), 6, 0, Math.PI * 2); ctx.strokeStyle = '#38bdf8'; ctx.lineWidth = 2.5; ctx.stroke(); }
}

// HEPGO §26: savunma görevi kartı — istasyon + radar halkaları + dört yönden dalan tehdit okları (tohumdan deterministik açılar), dalga/zorluk etiketi
export function drawDefendPreview(ctx, W, H, d) {
  const cx = W / 2, cy = H / 2 + 6, R = Math.min(W, H) * 0.42;
  ctx.save();
  ctx.strokeStyle = 'rgba(61,255,138,.55)'; ctx.lineWidth = 1.5; ctx.setLineDash([5, 5]);
  for (const f of [0.45, 0.75, 1]) { ctx.beginPath(); ctx.arc(cx, cy, R * f, 0, Math.PI * 2); ctx.stroke(); }
  ctx.setLineDash([]);
  const g = ctx.createConicGradient ? ctx.createConicGradient(-Math.PI / 2, cx, cy) : null;
  if (g) { g.addColorStop(0, 'rgba(61,255,138,.35)'); g.addColorStop(0.08, 'rgba(61,255,138,0)'); g.addColorStop(1, 'rgba(61,255,138,0)'); ctx.fillStyle = g; ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.fill(); }
  let a = (Number(d.seed) || 7) % 360;
  for (let k = 0; k < Math.min(8, 2 + (Number(d.waves) || 5)); k++) {
    a = (a * 137.508 + 61) % 360;
    const r = a * Math.PI / 180, x0 = cx + Math.sin(r) * R * 0.95, y0 = cy - Math.cos(r) * R * 0.95, x1 = cx + Math.sin(r) * R * 0.22, y1 = cy - Math.cos(r) * R * 0.22;
    ctx.strokeStyle = '#ff5a46'; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
    ctx.fillStyle = '#ff5a46'; ctx.beginPath(); ctx.arc(x0, y0, 3.5, 0, Math.PI * 2); ctx.fill();
  }
  ctx.fillStyle = '#94a3b8'; ctx.fillRect(cx - 9, cy - 6, 18, 12);
  ctx.strokeStyle = '#e2e8f0'; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(cx + 14, cy + 6); ctx.lineTo(cx + 14, cy - 16); ctx.stroke();
  ctx.fillStyle = '#e8eefb'; ctx.font = '700 13px system-ui,sans-serif'; ctx.textAlign = 'left';
  ctx.fillText(`#${d.seed ?? '—'}`, 10, 18);
  ctx.restore();
}
