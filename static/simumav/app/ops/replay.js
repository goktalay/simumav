// Replay adaptörü (ops/): /api/ops/{id}/replay (flightsim_replay çıktısı: {fields, frames, hz, duration_s, home, events})
// → HEPGO replay3d.js'in Cesium yükleyici/görüntüleyicisi ile 3B oynatma; Cesium açılamazsa 2B canvas oynatma.
import * as api from '../core/api.js';
import { h, clear, svg, fmtDur } from '../core/dom.js';
import { t } from '../i18n/i18n.js';
import { btn, toastErr, PLAY_SVG, PAUSE_SVG } from '../ui/components.js';

export async function openReplay(root, ctx, id) {
  const sc = h('div', { class: 'screen' });
  const stage = h('div', { class: 'replay-stage' }, h('div', { class: 'loading' }, t('ops.preparing')));
  sc.append(stage);
  clear(root, sc);
  ctx.setBack(t('ops.title'), 'ops');
  let flight, data;
  try { [flight, data] = await Promise.all([api.get(`/api/ops/${id}`), api.get(`/api/ops/${id}/replay`)]); }
  catch (e) { clear(stage, h('div', { class: 'center-stack' }, h('div', { class: 'err-box' }, e.message), btn(t('common.back'), () => ctx.go('ops'), 'ghost'))); return () => {}; }
  const F = data.fields || [], frames = data.frames || [];
  const ix = Object.fromEntries(F.map((f, i) => [f, i]));
  const get = (fr, k) => fr?.[ix[k]];
  if (!frames.length) { clear(stage, h('div', { class: 'center-stack' }, h('div', { class: 'err-box' }, t('ops.no_data')))); return () => {}; }
  const T0 = get(frames[0], 't') || 0, T1 = get(frames[frames.length - 1], 't') || data.duration_s || 0, dur = Math.max(0.1, T1 - T0);
  const frameAt = tt => { let lo = 0, hi = frames.length - 1; while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (get(frames[mid], 't') <= tt) lo = mid; else hi = mid - 1; } return frames[lo]; };

  // HUD
  let playing = true, speed = 1, tcur = T0, raf = 0, last = performance.now();
  const timeEl = h('span', { class: 'time' }, '00:00');
  const slider = h('input', { class: 'range', type: 'range', min: 0, max: 1000, value: 0 });
  const playBtn = h('button', { class: 'mini-btn', type: 'button', 'aria-label': t('ops.play') }, svg('0 0 24 24', PAUSE_SVG));
  const spdBtn = h('button', { class: 'btn', type: 'button', onclick: () => { speed = speed >= 8 ? 1 : speed * 2; spdBtn.textContent = `${speed}×`; } }, '1×');
  playBtn.addEventListener('click', () => { playing = !playing; clear(playBtn, svg('0 0 24 24', playing ? PAUSE_SVG : PLAY_SVG)); });
  slider.addEventListener('input', () => { tcur = T0 + (slider.value / 1000) * dur; });
  const hud = h('div', { class: 'replay-hud' }, playBtn, timeEl, slider, h('span', { class: 'time' }, fmtDur(dur)), spdBtn);
  const tele = h('div', { class: 'replay-tele' });
  const kv = (k, v) => h('div', { class: 'kv' }, h('span', {}, k), h('b', {}, v));
  const head = h('div', { class: 'replay-head' }, h('b', {}, `${flight.drone?.name || ''} · ${flight.track?.name || ''}`), h('span', { class: `badge ${flight.result || ''}` }, t(`result.${flight.result || 'ok'}`)));
  const f1 = v => (v == null ? '—' : Number(v).toFixed(1));
  const updateTele = fr => clear(tele, head, kv(t('tele.alt'), `${f1(get(fr, 'alt_rel'))} m`), kv(t('tele.gs'), `${f1((get(fr, 'gs') || 0) * 3.6)} km/h`), kv(t('tele.hdg'), `${Math.round(get(fr, 'hdg') ?? get(fr, 'yaw') ?? 0)}°`), kv(t('tele.mode'), (data.modes || [])[get(fr, 'mode')] ?? get(fr, 'mode') ?? '—'), kv(t('tele.batt'), get(fr, 'batt_pct') != null ? `${Math.round(get(fr, 'batt_pct'))}%` : '—'));

  // ---------- 3B (Cesium) ----------
  let view = null;
  try { view = await cesiumView(stage, data, frames, ix, flight); }
  catch (e) { console.warn('Cesium replay yok, 2B yedek:', e.message); view = canvasView(stage, data, frames, ix); }
  sc.append(hud, tele);

  const loop = now => {
    const dt = (now - last) / 1000; last = now;
    if (playing) { tcur += dt * speed; if (tcur > T1) tcur = T0; }
    const fr = frameAt(tcur);
    slider.value = Math.round(((tcur - T0) / dur) * 1000); timeEl.textContent = fmtDur(tcur - T0);
    view.update(fr, tcur); updateTele(fr);
    raf = requestAnimationFrame(loop);
  };
  raf = requestAnimationFrame(loop);
  return () => { cancelAnimationFrame(raf); view.dispose(); };
}

async function cesiumView(stage, data, frames, ix, flight) {
  const mod = await Promise.race([import('/sim/replay3d.js'), new Promise((_, rej) => setTimeout(() => rej(new Error('replay3d yüklenemedi')), 4000))]);
  const Cesium = await Promise.race([mod.loadCesium(), new Promise((_, rej) => setTimeout(() => rej(new Error('Cesium zaman aşımı')), 12000))]);
  clear(stage);
  const holder = h('div', { class: 'cesium-viewer' }); stage.append(holder);
  const viewer = mod.createViewer(Cesium, holder, { fullscreen: false });
  const home = data.home || { lat: frames[0][ix.lat], lon: frames[0][ix.lon], alt: 0 };
  const pos = (fr) => Cesium.Cartesian3.fromDegrees(fr[ix.lon], fr[ix.lat], (fr[ix.alt_rel] || 0) + (home.alt || 0));
  const pts = frames.filter(f => Number.isFinite(f[ix.lat])).map(pos);
  viewer.entities.add({ polyline: { positions: pts, width: 3, material: Cesium.Color.fromCssColorString('#38bdf8').withAlpha(0.9) } });
  viewer.entities.add({ position: Cesium.Cartesian3.fromDegrees(home.lon, home.lat, home.alt || 0), point: { pixelSize: 10, color: Cesium.Color.fromCssColorString('#34d399') } });
  const isPlane = ['plane', 'vtol', 'interceptor'].includes(flight.drone?.type);
  const ent = viewer.entities.add({ position: pts[0], ...(isPlane ? { model: mod.PLANE_MODEL } : { point: { pixelSize: 14, color: Cesium.Color.fromCssColorString('#fbbf24'), outlineColor: Cesium.Color.BLACK, outlineWidth: 2 } }) });
  const bs = Cesium.BoundingSphere.fromPoints(pts);
  viewer.camera.flyToBoundingSphere(bs, { duration: 1.2, offset: new Cesium.HeadingPitchRange(0, -Math.PI / 4, Math.max(bs.radius * 3, 600)) });
  return {
    update: fr => { if (!Number.isFinite(fr[ix.lat])) return; const p = pos(fr); ent.position = p; if (isPlane) ent.orientation = mod.planeOrientation(Cesium, p, fr[ix.yaw], fr[ix.pitch], fr[ix.roll]); },
    dispose: () => { try { viewer.destroy(); } catch { /* yok */ } },
  };
}

function canvasView(stage, data, frames, ix) {
  clear(stage);
  const cv = h('canvas', { class: 'r2d' }); stage.append(cv);
  const g = cv.getContext('2d');
  const home = data.home || { lat: frames[0][ix.lat], lon: frames[0][ix.lon] };
  const mLat = 111320, mLon = 111320 * Math.cos(home.lat * Math.PI / 180);
  const L = frames.filter(f => Number.isFinite(f[ix.lat])).map(f => ({ x: (f[ix.lon] - home.lon) * mLon, y: (f[ix.lat] - home.lat) * mLat, z: f[ix.alt_rel] || 0 }));
  const minX = Math.min(...L.map(p => p.x), 0), maxX = Math.max(...L.map(p => p.x), 0), minY = Math.min(...L.map(p => p.y), 0), maxY = Math.max(...L.map(p => p.y), 0);
  const size = () => { const r = stage.getBoundingClientRect(); cv.width = r.width; cv.height = r.height; };
  const ro = new ResizeObserver(size); ro.observe(stage); size();
  let trail = [];
  return {
    update: fr => {
      const W = cv.width, H = cv.height, span = Math.max(maxX - minX, maxY - minY, 100) * 1.25, s = Math.min(W, H) / span;
      const X = p => W / 2 + (p.x - (minX + maxX) / 2) * s, Y = p => H / 2 - (p.y - (minY + maxY) / 2) * s;
      g.fillStyle = '#05080f'; g.fillRect(0, 0, W, H);
      g.strokeStyle = 'rgba(148,163,184,.12)'; g.lineWidth = 1; const st = 100 * s; if (st > 10) { for (let x = (W / 2) % st; x < W; x += st) { g.beginPath(); g.moveTo(x, 0); g.lineTo(x, H); g.stroke(); } for (let y = (H / 2) % st; y < H; y += st) { g.beginPath(); g.moveTo(0, y); g.lineTo(W, y); g.stroke(); } }
      g.beginPath(); L.forEach((p, i) => (i ? g.lineTo(X(p), Y(p)) : g.moveTo(X(p), Y(p)))); g.strokeStyle = 'rgba(56,189,248,.35)'; g.lineWidth = 2; g.stroke();
      const cur = { x: (fr[ix.lon] - home.lon) * mLon, y: (fr[ix.lat] - home.lat) * mLat };
      trail.push(cur); if (trail.length > 400) trail.shift();
      g.beginPath(); trail.forEach((p, i) => (i ? g.lineTo(X(p), Y(p)) : g.moveTo(X(p), Y(p)))); g.strokeStyle = '#38bdf8'; g.lineWidth = 3; g.shadowColor = '#38bdf8'; g.shadowBlur = 10; g.stroke(); g.shadowBlur = 0;
      g.beginPath(); g.arc(X({ x: 0, y: 0 }), Y({ x: 0, y: 0 }), 7, 0, Math.PI * 2); g.fillStyle = '#34d399'; g.fill();
      const yaw = ((fr[ix.yaw] ?? fr[ix.hdg] ?? 0) - 90) * Math.PI / 180;
      g.save(); g.translate(X(cur), Y(cur)); g.rotate(yaw); g.beginPath(); g.moveTo(14, 0); g.lineTo(-10, 8); g.lineTo(-6, 0); g.lineTo(-10, -8); g.closePath(); g.fillStyle = '#fbbf24'; g.fill(); g.restore();
      g.fillStyle = 'rgba(232,238,251,.6)'; g.font = '12px sans-serif'; g.fillText('2D', 12, H - 14);
    },
    dispose: () => ro.disconnect(),
  };
}
