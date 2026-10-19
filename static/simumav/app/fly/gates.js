// SIMUMAV › Uç — FPV HALKALARI (docs/simumav.md §3 tracks.gates, §5 Uç). HEPGO dosyalarına dokunulmaz; çizim ./overlay3d.js kaplamasında.
// 1) Saf katman (node testi): gateNormal, crossing (dron merkezi halka düzlemini kesti mi, yarıçap içinde mi, yön), createGateTracker
//    (sıra/tur/süre; geçilen · kaçırılan · ters yön), replayGatesAt (kayıttan oynatma için t anındaki istatistik), gateStats → stop gövdesi.
// 2) 3B katman: createGateLayer(overlay, sim, T, gates, plan) — neon torus (ring) / kapı çerçevesi (gate); sıradaki vurgulu (nabız), geçilen yeşil,
//    kaçırılan kırmızı, gelecek amber-soluk; OSD (kaplamanın 2B tuvali): sıradaki halkaya ok (ekran dışıysa kenarda) + mesafe, tur sayacı, süre, geçilen/toplam.
// Geometri: yerel ENU (x doğu, y kuzey, z yukarı; flightsim3d toLocal). Halka merkezi C = (toLocal(lat,lon), terrainHeight + agl_m); yaw_deg geçiş yönü
// (0 = kuzeye doğru); düzlem normali n = (sin yaw, cos yaw, 0); yanal eksen r = (cos yaw, −sin yaw, 0). Kesişim: d0 = (P0−C)·n, d1 = (P1−C)·n işaret
// değiştirirse düzlem geçildi; kesişim noktasının düzlemdeki uzaklığı ≤ radius_m → İÇİNDE (kind 'gate': kare |yanal| ≤ r ve |dikey| ≤ r). Yön tutarlı: d0<0→d1≥0 ileri.
const DEG = Math.PI / 180;
const num = (v, d = 0) => (v == null || Number.isNaN(Number(v)) ? d : Number(v));
export const MISS_FACTOR = 3;   // halka dışında ama ≤ 3×yarıçap içinde düzlemi geçmek = KAÇIRMA (daha uzak geçişler sayılmaz)

export const gateNormal = yawDeg => { const a = num(yawDeg) * DEG; return { x: Math.sin(a), y: Math.cos(a) }; };
export const gateRight = yawDeg => { const a = num(yawDeg) * DEG; return { x: Math.cos(a), y: -Math.sin(a) }; };
// Enlem/boylam → yerel (flightsim3d.js toLocal ile aynı düz dünya yaklaşımı)
export const localFrom = origin => (lat, lon) => ({ x: (num(lon) - num(origin.lon)) * 111320 * Math.cos(num(origin.lat) * DEG), y: (num(lat) - num(origin.lat)) * 110574 });
// Halka → yerel çerçeve: { i, x, y, z, yaw_deg, radius_m, kind }
export const gateLocal = (g, toLocal, terrainHeight = () => 0) => { const p = toLocal(g.lat, g.lon); return { i: g.i, x: p.x, y: p.y, z: num(terrainHeight(p.x, p.y)) + num(g.agl_m, 5), yaw_deg: num(g.yaw_deg), radius_m: Math.max(0.5, num(g.radius_m, 3)), kind: g.kind === 'gate' ? 'gate' : 'ring' }; };

// crossing(p0, p1, G) → null | { dir: +1 ileri / −1 ters, s (0…1 kesişim oranı), lateral, vertical, dist, inside, near }
export function crossing(p0, p1, G) {
  if (!p0 || !p1 || !G) return null;
  const n = gateNormal(G.yaw_deg), r = gateRight(G.yaw_deg);
  const d0 = (p0.x - G.x) * n.x + (p0.y - G.y) * n.y, d1 = (p1.x - G.x) * n.x + (p1.y - G.y) * n.y;
  let dir = 0;
  if (d0 < 0 && d1 >= 0) dir = 1; else if (d0 > 0 && d1 <= 0) dir = -1; else return null;
  const s = d0 === d1 ? 0 : d0 / (d0 - d1);
  const qx = p0.x + (p1.x - p0.x) * s, qy = p0.y + (p1.y - p0.y) * s, qz = num(p0.z) + (num(p1.z) - num(p0.z)) * s;
  const lateral = (qx - G.x) * r.x + (qy - G.y) * r.y, vertical = qz - G.z;
  const dist = Math.hypot(lateral, vertical), R = G.radius_m;
  const inside = G.kind === 'gate' ? Math.abs(lateral) <= R && Math.abs(vertical) <= R : dist <= R;
  return { dir, s, lateral, vertical, dist, inside, near: dist <= R * MISS_FACTOR, q: { x: qx, y: qy, z: qz } };
}

// createGateTracker(gatesLocal, plan) → { update(pos, t) → olaylar[], stats(), reset(), next(), statusOf(i), order, laps }
//   plan: { order: [gate i…] (yoksa i sırası), laps (1) }. Olaylar: {type:'pass'|'miss'|'wrong_way'|'lap'|'finish', i, t, lap, lap_s?}
//   Kaçırma: sıradaki halkanın düzlemi yarıçap dışında (≤ 3×r) geçildi → miss, sıra ilerler; ileride bir halka içinden geçilirse aradakiler miss.
export function createGateTracker(gates, plan = {}) {
  const byI = new Map((gates || []).map(g => [g.i, g]));
  const order = (Array.isArray(plan?.order) && plan.order.length ? plan.order : (gates || []).map(g => g.i).sort((a, b) => a - b)).filter(i => byI.has(i));
  const laps = Math.max(1, Math.round(num(plan?.laps, 1)) || 1);
  const S = { idx: 0, lap: 0, passed: 0, missed: 0, wrong: 0, lapTimes: [], lapStart: null, startT: null, finished: false, prev: null, lastEvent: null, status: new Map() };
  const reset = () => { S.idx = 0; S.lap = 0; S.passed = 0; S.missed = 0; S.wrong = 0; S.lapTimes = []; S.lapStart = null; S.startT = null; S.finished = false; S.prev = null; S.lastEvent = null; S.status = new Map(); };
  const nextI = () => (S.finished || !order.length ? null : order[S.idx]);
  const statusOf = i => (S.finished ? (S.status.get(i) || 'passed') : i === nextI() ? 'next' : S.status.get(i) || 'idle');
  const advance = (t, ev) => {
    S.idx++;
    if (S.idx >= order.length) {
      S.lap++;
      const lapS = S.lapStart != null ? t - S.lapStart : null;
      if (lapS != null) S.lapTimes.push(lapS);
      ev.push({ type: 'lap', lap: S.lap, lap_s: lapS, t });
      if (S.lap >= laps) { S.finished = true; ev.push({ type: 'finish', t, laps: S.lap }); }
      else { S.idx = 0; S.lapStart = t; S.status = new Map(); }   // yeni tur: durumlar sıfırlanır (geçilen/kaçırılan sayaçları kalır)
    }
  };
  const update = (pos, t = 0) => {
    const ev = [];
    if (!pos || !order.length) return ev;
    const p1 = { x: num(pos.x), y: num(pos.y), z: num(pos.z) };
    let p0 = S.prev; S.prev = p1;
    if (S.startT == null) { S.startT = t; S.lapStart = t; }   // süre ilk konum karesinde başlar
    if (!p0 || S.finished) return ev;
    // Aynı adımda birden çok halka geçilebilir (seyrek kare / hızlı dron): kesişimler s'ye göre sırayla işlenir; işlenen kesişim noktası yeni p0 olur
    let guard = 0;
    while (!S.finished && guard++ <= order.length) {
      const ni = nextI();
      const xs = [];
      for (let k = S.idx; k < order.length; k++) { const gi = order[k], c = crossing(p0, p1, byI.get(gi)); if (c) xs.push({ k, gi, c }); }
      xs.sort((u, v) => u.c.s - v.c.s);
      let acted = false;
      for (const { k, gi, c } of xs) {
        if (gi === ni) {
          if (c.dir < 0) { if (c.near) { S.wrong++; ev.push({ type: 'wrong_way', i: gi, t, lap: S.lap }); } continue; }
          if (c.inside) { S.passed++; S.status.set(gi, 'passed'); ev.push({ type: 'pass', i: gi, t, lap: S.lap, dist: c.dist }); advance(t, ev); }
          else if (c.near) { S.missed++; S.status.set(gi, 'missed'); ev.push({ type: 'miss', i: gi, t, lap: S.lap, dist: c.dist }); advance(t, ev); }
          else continue;
        } else if (c.dir > 0 && c.inside) {   // ileriki halka içinden geçildi: aradakiler kaçırıldı
          for (let j = S.idx; j < k; j++) { S.missed++; S.status.set(order[j], 'missed'); ev.push({ type: 'miss', i: order[j], t, lap: S.lap, skipped: true }); }
          S.idx = k; S.passed++; S.status.set(gi, 'passed'); ev.push({ type: 'pass', i: gi, t, lap: S.lap, dist: c.dist }); advance(t, ev);
        } else continue;   // sıradaki olmayan halkadan ters/dış geçiş: sayılmaz
        p0 = { x: c.q.x + (p1.x - c.q.x) * 1e-6, y: c.q.y + (p1.y - c.q.y) * 1e-6, z: c.q.z + (p1.z - c.q.z) * 1e-6 };   // kesişimin hemen ötesinden sürdür
        acted = true; break;
      }
      if (!acted) break;
    }
    if (ev.length) S.lastEvent = ev[ev.length - 1];
    return ev;
  };
  const stats = (tNow = null) => ({
    passed: S.passed, missed: S.missed, wrong_way: S.wrong, laps: S.lap, laps_total: laps, gates_total: order.length * laps,
    best_lap_s: S.lapTimes.length ? Math.min(...S.lapTimes) : null, last_lap_s: S.lapTimes.length ? S.lapTimes[S.lapTimes.length - 1] : null,
    lap_times: S.lapTimes.slice(), next: nextI(), finished: S.finished, elapsed_s: S.startT != null && tNow != null ? tNow - S.startT : null,
    current_lap_s: S.lapStart != null && tNow != null && !S.finished ? tNow - S.lapStart : null, idx: S.idx,
  });
  return { update, stats, reset, next: nextI, statusOf, order, laps, get finished() { return S.finished; }, gate: i => byI.get(i) || null };
}
// POST /api/fly/{id}/stop gövdesine giden özet: { passed, missed, best_lap_s, laps }
export const gateStats = tracker => { const s = tracker.stats(); return { passed: s.passed, missed: s.missed, best_lap_s: s.best_lap_s != null ? Math.round(s.best_lap_s * 100) / 100 : null, laps: s.laps }; };

// Kayıttan oynatma: frames (önbellek kareleri), FI alan→dizin ('t','lat','lon','alt_rel'), gates (ham), plan, origin {lat,lon}, t → stats(t)
// (ops ajanı replay zaman çizelgesinde kullanır; her çağrı baştan koşar — ≤ 50 Hz × 45 dk için `step` ile seyrekleştirilebilir)
export function replayGatesAt(frames, FI, gates, plan, origin, t, { terrainHeight = () => 0, step = 1 } = {}) {
  const toLocal = localFrom(origin);
  const GL = (gates || []).map(g => gateLocal(g, toLocal, terrainHeight));
  const tr = createGateTracker(GL, plan);
  const col = (f, k) => (FI?.[k] == null ? null : f[FI[k]]);
  let n = 0;
  for (const f of frames || []) {
    const ft = col(f, 't') ?? f[0];
    if (ft > t) break;
    if (step > 1 && (n++ % step)) continue;
    const lat = col(f, 'lat'), lon = col(f, 'lon');
    if (lat == null || lon == null) continue;
    const p = toLocal(lat, lon);
    tr.update({ x: p.x, y: p.y, z: num(col(f, 'alt_rel')) }, ft);
  }
  return { ...tr.stats(t), statusOf: tr.statusOf };
}

// ---------- 3B + OSD ----------
const COLORS = { idle: 0xf59e0b, next: 0x38bdf8, passed: 0x22c55e, missed: 0xef4444 };
export function createGateLayer(overlay, sim, T, gates, plan = {}, opts = {}) {
  const toLocal = sim.toLocal, th = (x, y) => num(sim.terrainHeight?.(x, y), 0);
  const GL = (gates || []).map(g => gateLocal(g, toLocal, th));
  const tracker = createGateTracker(GL, plan);
  const scale = num(opts.scale, 1);
  const meshes = new Map();
  for (const G of GL) {
    const mat = new T.MeshStandardMaterial({ color: COLORS.idle, emissive: COLORS.idle, emissiveIntensity: 0.9, roughness: 0.4, metalness: 0.2 });
    const R = G.radius_m * scale, tube = Math.max(0.12, R * 0.07);
    let mesh;
    if (G.kind === 'gate') {
      const grp = new T.Group();
      const bar = (w, h, x, z) => { const m = new T.Mesh(new T.BoxGeometry(w, tube * 2, h), mat); m.position.set(x, 0, z); grp.add(m); };
      bar(2 * R + tube * 2, tube * 2, 0, R); bar(2 * R + tube * 2, tube * 2, 0, -R); bar(tube * 2, 2 * R, -R, 0); bar(tube * 2, 2 * R, R, 0);
      mesh = grp;
    } else mesh = new T.Mesh(new T.TorusGeometry(R, tube, 12, 48), mat);   // torus XY düzleminde → yaw ile döndürülür (normal +Y → n)
    if (G.kind !== 'gate') mesh.rotation.x = Math.PI / 2;   // torus XY düzleminden dikey XZ'ye (normal +Y); kapı çubukları zaten XZ'de
    const holder = new T.Group(); holder.add(mesh);
    const lbl = makeLabel(T, String(G.i + 1));   // halka i 0..n-1 → görünümde 1..n lbl.position.set(0, 0, R + tube * 3 + 0.6 * scale); holder.add(lbl);
    holder.position.set(G.x, G.y, G.z); holder.rotation.z = -G.yaw_deg * DEG;
    overlay.add(holder);
    meshes.set(G.i, { holder, mat, lbl, G });
  }
  let pulse = 0, dronePos = null, teleT = 0, lastEvents = [];
  const onEvent = opts.onEvent || null;
  const applyStatus = () => { for (const [i, m] of meshes) { const st = tracker.statusOf(i); const c = COLORS[st] || COLORS.idle; m.mat.color.setHex(c); m.mat.emissive.setHex(c); m.mat.emissiveIntensity = st === 'next' ? 0.8 + 0.6 * (0.5 + 0.5 * Math.sin(pulse)) : st === 'idle' ? 0.45 : 0.9; m.mat.opacity = 1; } };
  const refreshZ = () => { for (const [, m] of meshes) { const z = th(m.G.x, m.G.y) + num((gates.find(g => g.i === m.G.i) || {}).agl_m, 5); if (Math.abs(z - m.G.z) > 0.05) { m.G.z = z; m.holder.position.z = z; } } };
  let zT = 0;
  const offTick = overlay.onTick((dt, now) => { pulse += dt * 5; if (now - zT > 1000) { zT = now; refreshZ(); } applyStatus(); });
  // telemetri: dron konumu (yerel) → izleyici
  const update = (t, tSec) => {
    if (t?.lat == null || t?.lon == null) return [];
    const p = toLocal(t.lat, t.lon); dronePos = { x: p.x, y: p.y, z: num(t.alt_rel) };
    teleT = tSec ?? (num(t.tbm, NaN) ? num(t.tbm) / 1000 : performance.now() / 1000);
    const ev = tracker.update(dronePos, teleT);
    if (ev.length) { lastEvents = ev; onEvent?.(ev, tracker.stats(teleT)); }
    return ev;
  };
  // OSD: sıradaki halka oku + mesafe · tur · süre · geçilen/toplam
  const offDraw = overlay.onDraw2d((g, W, H, { projectAny }) => {
    const st = tracker.stats(teleT);
    const ni = st.next, G = ni != null ? meshes.get(ni)?.G : null;
    const S = Math.max(0.8, Math.min(1.4, W / 1400));
    g.font = `${Math.round(13 * S)}px Consolas, "Cascadia Mono", Menlo, monospace`; g.textBaseline = 'middle';
    const box = (x, y, w, h) => { g.fillStyle = 'rgba(11,18,32,.55)'; g.beginPath(); g.roundRect(x, y, w, h, 8); g.fill(); };
    // üst orta: tur / geçilen / süre
    const clock = s => (s == null ? '--:--.-' : `${String(Math.floor(s / 60)).padStart(2, '0')}:${(s % 60).toFixed(1).padStart(4, '0')}`);
    const line1 = st.finished ? 'BİTTİ' : `TUR ${Math.min(st.laps + 1, st.laps_total)}/${st.laps_total}`;
    const line2 = `${st.passed}/${st.gates_total} ✓ ${st.missed} ✗ · ${clock(st.finished ? st.best_lap_s : st.current_lap_s)}${st.best_lap_s != null && !st.finished ? ` · EN İYİ ${clock(st.best_lap_s)}` : ''}`;
    const cam = sim?.getCamera?.();
    const w = Math.max(g.measureText(line2).width, 160) + 24, x0 = W / 2 - w / 2, y0 = (cam === 'fpv' || cam === 'pilot' ? 128 : 54) * S;   // HUD yön şeridi / OSD FLY sayacı üstte
    box(x0, y0, w, 44 * S);
    g.textAlign = 'center'; g.fillStyle = '#38bdf8'; g.fillText(line1, W / 2, y0 + 13 * S); g.fillStyle = '#f1f5f9'; g.fillText(line2, W / 2, y0 + 31 * S);
    if (!G || !dronePos) return;
    const pr = projectAny(G.x, G.y, G.z);
    const dist = Math.hypot(G.x - dronePos.x, G.y - dronePos.y, G.z - dronePos.z);
    const cx = W / 2, cy = H / 2;
    let tx = pr.x, ty = pr.y, off = pr.behind || tx < 0 || tx > W || ty < 0 || ty > H;
    if (pr.behind) { tx = cx - (pr.x - cx); ty = cy - (pr.y - cy); }
    if (off) {   // kenara kenetle
      const dx = tx - cx, dy = ty - cy, m = 40 * S;
      const kx = dx === 0 ? Infinity : (W / 2 - m) / Math.abs(dx), ky = dy === 0 ? Infinity : (H / 2 - m) / Math.abs(dy), k = Math.min(kx, ky);
      tx = cx + dx * k; ty = cy + dy * k;
    }
    const ang = Math.atan2(ty - cy, tx - cx);
    g.save(); g.translate(tx, ty); g.strokeStyle = '#38bdf8'; g.fillStyle = 'rgba(56,189,248,.85)'; g.lineWidth = 2;
    if (off) { g.rotate(ang); g.beginPath(); g.moveTo(16 * S, 0); g.lineTo(-10 * S, -10 * S); g.lineTo(-4 * S, 0); g.lineTo(-10 * S, 10 * S); g.closePath(); g.fill(); }
    else { const r = Math.max(14 * S, Math.min(120 * S, 60 * S * G.radius_m / Math.max(1, dist) * 8)); g.beginPath(); g.arc(0, 0, r, 0, Math.PI * 2); g.stroke(); g.beginPath(); g.moveTo(-r - 6, 0); g.lineTo(-r + 6, 0); g.moveTo(r - 6, 0); g.lineTo(r + 6, 0); g.moveTo(0, -r - 6); g.lineTo(0, -r + 6); g.moveTo(0, r - 6); g.lineTo(0, r + 6); g.stroke(); }
    g.restore();
    g.textAlign = 'center'; g.fillStyle = '#f1f5f9';
    const label = `#${G.i + 1} · ${dist >= 1000 ? `${(dist / 1000).toFixed(2)} km` : `${Math.round(dist)} m`}`;
    const lx = Math.min(W - 60, Math.max(60, tx)), ly = Math.min(H - 24, Math.max(24, ty + (off ? 26 : 0) + 22 * S));
    g.lineWidth = 3; g.strokeStyle = 'rgba(0,0,0,.6)'; g.strokeText(label, lx, ly); g.fillText(label, lx, ly);
  });
  return {
    tracker, update, gates: GL, stats: () => tracker.stats(teleT), body: () => gateStats(tracker), get lastEvents() { return lastEvents; },
    dispose() { offTick(); offDraw(); for (const [, m] of meshes) { overlay.remove(m.holder); m.holder.traverse(o => { o.geometry?.dispose?.(); o.material?.dispose?.(); }); } meshes.clear(); },
  };
}
function makeLabel(T, text) {
  const cv = document.createElement('canvas'); cv.width = 128; cv.height = 64;
  const c = cv.getContext('2d'); c.fillStyle = 'rgba(11,18,32,.7)'; c.beginPath(); c.roundRect(8, 6, 112, 52, 12); c.fill();
  c.fillStyle = '#f1f5f9'; c.font = '700 40px Consolas, Menlo, monospace'; c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillText(text, 64, 34);
  const tex = new T.CanvasTexture(cv); tex.colorSpace = T.SRGBColorSpace;
  const sp = new T.Sprite(new T.SpriteMaterial({ map: tex, depthTest: false, transparent: true }));
  sp.scale.set(2.4, 1.2, 1);
  return sp;
}
