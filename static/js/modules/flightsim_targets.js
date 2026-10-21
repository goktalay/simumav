// Uçuş Simülatörü — HEDEFLER (docs/ucus-simulatoru.md §24): dairesel yörüngede sürekli uçan kinematik hedefler. Saf fonksiyonlar (three.js'siz;
// tarayıcısız Node testi tests/test_flightsim_targets.mjs) + radar çizimi (2B canvas) + sihirbaz yardımcıları. Sunucu eşleniği app/flightsim_targets.py
// (`durum`) — formüller birebir aynıdır: hedefin konumu yalnız t = tbm / 1000 (SITL time_boot_ms; kayıtta t0 + kare t) ile belirlenir.
//
// Yerel ENU (merkez referanslı; flightsim3d toLocal ile aynı): x doğu, y kuzey, z irtifa (ev noktasına göre). Yörünge merkezi (east_m, north_m),
// yarıçap R = diameter_m / 2, ω = v / R; cw: θ = θ0 − ω·t, ccw: θ = θ0 + ω·t (θ doğudan saat yönü tersi). Yatış φ = atan(v²/(R·g)), cw sağa (+).

export const G = 9.80665;
export const TARGET_MAX = 8;
export const DIAMETER = [50, 5000];
export const ALT = [10, 3000];
export const RADIUS = [5, 200];
export const RADIUS_DEFAULT = 25;
export const EXIT_HYST = 1.5;

/** Hedefin t (sn) anındaki durumu: {x, y, z, vx, vy, heading (°, kuzeyden saat yönü), yaw (rad), roll (rad, + sağa), speed}. */
export function targetState(h, t) {
  const R = Number(h.diameter_m) / 2, v = Number(h.speed_ms), w = v / R;
  const s = (h.dir || 'cw') === 'cw' ? -1 : 1;
  const th = (Number(h.phase_deg) || 0) * Math.PI / 180 + s * w * Number(t);
  const cx = Number(h.east_m) || 0, cy = Number(h.north_m) || 0;
  const x = cx + R * Math.cos(th), y = cy + R * Math.sin(th);
  const vx = -R * Math.sin(th) * s * w, vy = R * Math.cos(th) * s * w;
  const heading = ((Math.atan2(vx, vy) * 180 / Math.PI) % 360 + 360) % 360;
  const roll = Math.atan(v * v / (R * G)) * (s < 0 ? 1 : -1);
  return { x, y, z: Number(h.alt_m), vx, vy, heading, yaw: heading * Math.PI / 180, roll, speed: v };
}

/** Oyuncu (x, y, z) ile hedefler arası durum: [{i, name, dist, horiz, dz, bearing (°), rel (gövdeye göre °, + sağ), inside}] — HUD/radar. */
export function targetsRelative(items, t, px, py, pz, heading = 0, radius = RADIUS_DEFAULT) {
  return (items || []).map(h => {
    const s = targetState(h, t), dx = s.x - px, dy = s.y - py, dz = s.z - pz;
    const horiz = Math.hypot(dx, dy), dist = Math.hypot(horiz, dz);
    const bearing = ((Math.atan2(dx, dy) * 180 / Math.PI) + 360) % 360;
    let rel = bearing - heading; while (rel > 180) rel -= 360; while (rel < -180) rel += 360;
    return { i: h.i, name: h.name, model: h.model, dist, horiz, dz, bearing, rel, inside: dist <= radius, state: s };
  });
}

/** Önleme izleyicisi (sunucu HedefIzleyici eşleniği; kayıttan oynatmada rapor/olay için istemcide yeniden hesap). */
export function createInterceptTracker(cfg) {
  const R = Number(cfg?.radius_m) || RADIUS_DEFAULT;
  const iz = (cfg?.items || []).map(h => ({ i: h.i, name: h.name, model: h.model, intercepts: 0, first_s: null, in_s: 0, min_dist_m: null, inside: false }));
  let tArm = null, tLast = null;
  return {
    step(t, x, y, z, armed) {
      const out = [];
      const dt = tLast == null || !(t - tLast > 0 && t - tLast < 5) ? 0 : t - tLast;
      if (tLast != null && t < tLast - 1) { tArm = null; iz.forEach(d => { d.inside = false; }); }
      tLast = t;
      if (armed && tArm == null) tArm = t;
      (cfg?.items || []).forEach((h, k) => {
        const d = iz[k], s = targetState(h, t);
        const dist = Math.hypot(s.x - x, s.y - y, s.z - z);
        if (d.min_dist_m == null || dist < d.min_dist_m) d.min_dist_m = Math.round(dist * 10) / 10;
        if (d.inside) { d.in_s += dt; if (dist > R * EXIT_HYST) d.inside = false; }
        else if (dist <= R && armed) {
          d.inside = true; d.intercepts++;
          const first = d.first_s == null;
          if (first) d.first_s = Math.round((t - (tArm ?? t)) * 10) / 10;
          out.push({ i: h.i, name: h.name, model: h.model, dist_m: Math.round(dist * 10) / 10, n: d.intercepts, first, after_s: first ? d.first_s : Math.round((t - (tArm ?? t)) * 10) / 10 });
        }
      });
      return out;
    },
    summary() {
      const items = iz.map(({ inside, ...d }) => ({ ...d, in_s: Math.round(d.in_s * 10) / 10 }));
      const total = items.reduce((a, d) => a + d.intercepts, 0), hit = items.filter(d => d.intercepts).length;
      const o = { radius_m: R, count: items.length, items, total, hit_targets: hit, all_hit: items.length > 0 && hit === items.length };
      return { ...o, ...scoreOf(o) };
    },
  };
}

/** Puan + rozetler (sunucu `puan` eşleniği). */
export const ENGAGE_BONUS = 250;   // §40 (app/flightsim_targets.ANGAJMAN_BONUS)
export function scoreOf(o) {
  let p = 0; const badges = [];
  const firsts = o.items.filter(d => d.first_s != null).map(d => d.first_s);
  for (const d of o.items) {
    if (!d.intercepts) continue;
    p += Math.max(200, Math.trunc(1000 - 5 * (Number(d.first_s) || 0)));
    p += 100 * (d.intercepts - 1);
    if (d.min_dist_m != null && d.min_dist_m <= 5) p += 150;
    if (d.locked_hits) p += ENGAGE_BONUS;   // §40 kilitli angajmanla önleme (hedef başına bir kez)
  }
  if (firsts.length) { badges.push('first'); if (Math.min(...firsts) <= 60) badges.push('quick'); }
  if (o.all_hit && o.count > 1) badges.push('ace');
  if (o.items.some(d => d.min_dist_m != null && d.min_dist_m <= 5 && d.intercepts)) badges.push('close');
  if ((o.total || 0) >= 5) badges.push('hunter');
  return { score: p, badges };
}

/** Sihirbaz: yeni hedef varsayılanı (katalog modelinin seyir hızı; çap 800 m, irtifa 120 m; başlangıç açısı dağıtılır). */
export function newTarget(model, i = 0) {
  return { model: model?.key || 'tgt:lancet', alt_m: 120, diameter_m: 800, speed_ms: model?.cruise_ms ?? 30, dir: i % 2 ? 'ccw' : 'cw', east_m: 0, north_m: 0, phase_deg: Math.round((i * 137.5) % 360) };
}

/** Sihirbaz (istemci) doğrulaması — sunucu sınırlarıyla aynı; hata metni ya da null. */
export function validateTargets(list, catalog, tr = s => s) {
  if (!Array.isArray(list)) return tr('Hedef listesi geçersiz');
  if (list.length > TARGET_MAX) return tr('En çok 8 hedef');
  for (const [k, h] of list.entries()) {
    const m = (catalog || []).find(c => c.key === h.model);
    if (!m) return `${k + 1}: ${tr('bilinmeyen model')}`;
    if (!(h.alt_m >= ALT[0] && h.alt_m <= ALT[1])) return `${k + 1}: ${tr('irtifa 10–3000 m olmalı')}`;
    if (!(h.diameter_m >= DIAMETER[0] && h.diameter_m <= DIAMETER[1])) return `${k + 1}: ${tr('yörünge çapı 50–5000 m olmalı')}`;
    if (!(h.speed_ms >= 1 && h.speed_ms <= m.max_ms + 1e-6)) return `${k + 1}: ${tr('hız modelin azami hızını aşamaz')} (${Math.round(m.max_ms * 3.6)} km/h)`;
    if (Math.abs(Number(h.east_m) || 0) > 20000 || Math.abs(Number(h.north_m) || 0) > 20000) return `${k + 1}: ${tr('merkez ofseti ±20 km olmalı')}`;
  }
  return null;
}

const fmtDist = d => (d >= 1000 ? `${(d / 1000).toFixed(d >= 10000 ? 0 : 1)} km` : `${Math.round(d)} m`);
export { fmtDist };

/** Radar (2B canvas): oyuncu merkezde, burun yukarı; hedefler göreli kerteriz/uzaklıkla; menzil halkaları otomatik (en uzak hedefe göre). */
export function drawRadar(ctx, w, h, rel, { range = null, radius = RADIUS_DEFAULT, title = 'HEDEF', theme = 'dark' } = {}) {
  const cx = w / 2, cy = h / 2, R = Math.min(w, h) / 2 - 6;
  const far = Math.max(200, ...rel.map(r => r.horiz));
  const steps = [250, 500, 1000, 2000, 5000, 10000, 20000, 50000];
  const rng = range || steps.find(s => s >= far * 1.05) || steps[steps.length - 1];
  ctx.clearRect(0, 0, w, h);
  ctx.save();
  ctx.fillStyle = theme === 'dark' ? 'rgba(6,14,10,0.72)' : 'rgba(255,255,255,0.85)';
  ctx.beginPath(); ctx.arc(cx, cy, R + 4, 0, 2 * Math.PI); ctx.fill();
  ctx.strokeStyle = 'rgba(80,255,160,0.35)'; ctx.lineWidth = 1;
  for (const f of [1 / 3, 2 / 3, 1]) { ctx.beginPath(); ctx.arc(cx, cy, R * f, 0, 2 * Math.PI); ctx.stroke(); }
  ctx.beginPath(); ctx.moveTo(cx, cy - R); ctx.lineTo(cx, cy + R); ctx.moveTo(cx - R, cy); ctx.lineTo(cx + R, cy); ctx.stroke();
  ctx.fillStyle = 'rgba(160,255,200,0.9)'; ctx.font = '600 9px ui-monospace,monospace'; ctx.textAlign = 'left';
  ctx.fillText(`${title} · ${fmtDist(rng)}`, 6, 11);
  // oyuncu (burun yukarı üçgen)
  ctx.fillStyle = '#5dffa8';
  ctx.beginPath(); ctx.moveTo(cx, cy - 6); ctx.lineTo(cx + 4, cy + 4); ctx.lineTo(cx - 4, cy + 4); ctx.closePath(); ctx.fill();
  for (const r of rel) {
    const a = r.rel * Math.PI / 180, d = Math.min(1, r.horiz / rng) * R;
    const x = cx + Math.sin(a) * d, y = cy - Math.cos(a) * d, out = r.horiz > rng;
    ctx.fillStyle = r.inside ? '#ffd23f' : out ? 'rgba(255,90,70,0.6)' : '#ff5a46';
    ctx.beginPath(); ctx.arc(x, y, r.inside ? 5 : 3.5, 0, 2 * Math.PI); ctx.fill();
    ctx.fillStyle = 'rgba(255,220,210,0.95)'; ctx.font = '600 9px ui-monospace,monospace'; ctx.textAlign = x > cx ? 'right' : 'left';
    ctx.fillText(`${r.i + 1}`, x + (x > cx ? -6 : 6), y + 3);
  }
  ctx.restore();
  return rng;
}

/** Hedef etiketi canvas'ı (sprite dokusu): ad + uzaklık + bağıl irtifa; önleme yarıçapı içinde sarı. */
export function drawLabel(ctx, w, h, { name, dist, dz, inside }) {
  ctx.clearRect(0, 0, w, h);
  ctx.font = '700 22px system-ui,sans-serif';
  const line1 = name || '', line2 = `${fmtDist(dist)} · ${dz >= 0 ? '+' : '−'}${Math.round(Math.abs(dz))} m`;
  const tw = Math.min(w - 8, Math.max(ctx.measureText(line1).width, ctx.measureText(line2).width) + 20);
  const x0 = (w - tw) / 2;
  ctx.fillStyle = inside ? 'rgba(80,60,0,0.82)' : 'rgba(40,6,6,0.72)';
  ctx.strokeStyle = inside ? '#ffd23f' : '#ff5a46'; ctx.lineWidth = 3;
  ctx.beginPath(); ctx.roundRect?.(x0, 4, tw, h - 26, 8); if (!ctx.roundRect) ctx.rect(x0, 4, tw, h - 26); ctx.fill(); ctx.stroke();
  ctx.fillStyle = '#fff'; ctx.textAlign = 'center';
  ctx.fillText(line1, w / 2, 28);
  ctx.font = '600 20px ui-monospace,monospace'; ctx.fillStyle = inside ? '#ffe680' : '#ffd0c8';
  ctx.fillText(line2, w / 2, 52);
  ctx.beginPath(); ctx.moveTo(w / 2 - 8, h - 22); ctx.lineTo(w / 2 + 8, h - 22); ctx.lineTo(w / 2, h - 8); ctx.closePath();
  ctx.fillStyle = inside ? '#ffd23f' : '#ff5a46'; ctx.fill();
}
