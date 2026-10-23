// Replay adaptörü (ops/): /api/ops/{id}/replay (flightsim_replay çıktısı: {fields, frames, hz, duration_s, home, events})
// → HEPGO replay3d.js'in Cesium yükleyici/görüntüleyicisi ile 3B oynatma; Cesium açılamazsa 2B canvas oynatma.
// §28: kalkış noktasının gerisinde pilot (oyuncunun karakteri; avatar_body → GLB → Cesium modeli, dronu izler).
// §10 güç ve yakıt: uçuşun ayarları (summary.power.settings ya da snapshot.power) varsa HEPGO kadranları (/sim/flightsim_power.js createPowerGauges)
// oynatma çubuğunun üstünde; değerler HEPGO kayıttan oynatmasındaki gibi karelerden createPowerSim ile oynatıcı zamanında (atlama/başa dönüşte rebuild).
import * as api from '../core/api.js';
import { h, clear, svg, fmtDur } from '../core/dom.js';
import { t } from '../i18n/i18n.js';
import { btn, toastErr, PLAY_SVG, PAUSE_SVG } from '../ui/components.js';
import { trPower, localizeUnits, powerReportCard } from '../fly/power.js';
import { h as hSim } from '../fly/simui.js';   // HEPGO kadran modülü `html` özniteliğiyle SVG yazar (core/dom h desteklemez)

const POWER_CSS = new URL('../fly/power.css', import.meta.url).href;
const ensurePowerCss = () => { if (!document.querySelector(`link[href="${POWER_CSS}"]`)) document.head.append(h('link', { rel: 'stylesheet', href: POWER_CSS })); };
/** Kaydın güç ayarı (çekirdek ALANLAR): özet → anlık görüntü; yoksa null (gösterge yok). */
export function replayPowerSettings(flight) {
  const s = flight?.summary?.power?.settings || flight?.snapshot?.power || null;
  if (!s) return null;
  const out = {};
  for (const k of ['max_speed_ms', 'fuel_l', 'fuel_km_per_l', 'elec_cells', 'elec_mah', 'elec_w']) out[k] = s[k] ?? null;
  if (s.engine === 'electric') out.fuel_l = 0;
  return out;
}

export async function openReplay(root, ctx, id) {
  const sc = h('div', { class: 'screen' });
  const stage = h('div', { class: 'replay-stage' }, h('div', { class: 'loading' }, t('ops.preparing')));
  sc.append(stage);
  clear(root, sc);
  ctx.setBack(t('ops.title'), 'ops');
  let flight = null, data;
  try { [flight, data] = await Promise.all([api.get(`/api/ops/${id}`), api.get(`/api/ops/${id}/replay`)]); }
  catch (e) {
    clear(stage, h('div', { class: 'center-stack' }, h('div', { class: 'err-box' }, e.message), btn(t('common.back'), () => ctx.go('ops'), 'ghost')));
    try { flight = flight || await api.get(`/api/ops/${id}`); const dc = await defendCard(flight); if (dc) sc.append(dc); } catch { /* rapor yok */ }   // HEPGO §26: .bin yoksa da görev raporu
    return () => {};
  }
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
  // §10 güç: istemci modeli (HEPGO createPowerSim) + kadranlar
  const pset = replayPowerSettings(flight);
  let MP = null, psim = null, gauges = null, pLastT = null;
  if (pset) {
    try {
      MP = await import('/sim/flightsim_power.js'); ensurePowerCss();
      psim = MP.createPowerSim(pset);
      sc.classList.add('sm-replay-power');
      const trP = trPower(t);
      gauges = MP.createPowerGauges(sc, { h: hSim, tr: trP, getSettings: () => pset, getSummary: () => psim.summary(), plane: ['plane', 'vtol', 'interceptor'].includes(flight.drone?.type), rover: flight.drone?.type === 'rover' });   // §15 kara aracı
      gauges.el.classList.add('sm-game');
    } catch (e) { console.warn('güç kadranları yok:', e.message); psim = null; gauges = null; }
  }
  const units = { min: t('power.u_min'), h: t('power.u_h') };
  const pwKv = () => {
    if (!psim) return [];
    const st = psim.state(), out = [];
    if (st.fuel) out.push(h('div', { class: `kv pw ${st.fuel.empty ? 'bad' : ''}` }, h('span', {}, t('power.g_fuel')), h('b', {}, `${st.fuel.l.toFixed(2)} L · ${Math.round(st.fuel.pct)}%`)));
    if (st.elec) out.push(h('div', { class: `kv pw elec ${st.elec.empty ? 'bad' : ''}` }, h('span', {}, t('power.g_batt')), h('b', {}, `${Math.round(st.elec.pct)}% · ${st.elec.v.toFixed(1)} V`)));
    return out;
  };
  const powerStep = (fr, tt) => {
    if (!psim) return;
    if (pLastT == null || tt < pLastT || tt - pLastT > 2) { psim.rebuild(data, tt); gauges?.reset(); }   // atlama / başa dönüş: baştan o ana
    else psim.step({ groundspeed: get(fr, 'gs'), throttle: get(fr, 'thr'), armed: !!get(fr, 'armed'), servo: ix.servo != null ? get(fr, 'servo') : null }, get(fr, 't'));
    pLastT = tt;
    const st = psim.state();
    gauges?.update({ t: tt, groundspeed: get(fr, 'gs'), airspeed: get(fr, 'as'), throttle: get(fr, 'thr'), armed: !!get(fr, 'armed'), alt_rel: get(fr, 'alt_rel'), fuel: st.fuel, elec: st.elec, speedup: 1 });
    if (gauges && units.min !== 'dk') for (const sub of gauges.el.querySelectorAll('.fs-gauge-sub')) { const v = localizeUnits(sub.textContent, units); if (v !== sub.textContent) sub.textContent = v; }
  };
  const updateTele = fr => clear(tele, head, kv(t('tele.alt'), `${f1(get(fr, 'alt_rel'))} m`), kv(t('tele.gs'), `${f1((get(fr, 'gs') || 0) * 3.6)} km/h`), kv(t('tele.hdg'), `${Math.round(get(fr, 'hdg') ?? get(fr, 'yaw') ?? 0)}°`), kv(t('tele.mode'), (data.modes || [])[get(fr, 'mode')] ?? get(fr, 'mode') ?? '—'), psim ? null : kv(t('tele.batt'), get(fr, 'batt_pct') != null ? `${Math.round(get(fr, 'batt_pct'))}%` : '—'), pwKv());

  // ---------- 3B (Cesium) ----------
  let view = null;
  try { view = await cesiumView(stage, data, frames, ix, flight); }
  catch (e) { console.warn('Cesium replay yok, 2B yedek:', e.message); view = canvasView(stage, data, frames, ix); }
  sc.append(hud, tele);
  if (gauges) sc.append(gauges.el);
  // uçuş sonu güç özeti (ölçülen km/L, ortalama W, bitme anları) — sağ üstte katlanır kart
  const pcard = flight.summary?.power ? powerReportCard({ h, t, pw: flight.summary.power }) : null;
  if (pcard) {
    const box = h('div', { class: 'replay-power-card' }, pcard);
    pcard.querySelector('h3')?.addEventListener('click', () => box.classList.toggle('min'));
    sc.append(box);
  }

  // HEPGO §42 uçuş uyarıları: kayıt karelerinden YENİDEN hesaplanır (aynı değerlendirici; AGL = alt_rel, ses yok, sunucuya gönderilmez)
  let gpws = null, gpLast = null;
  try {
    const MG = await import('/sim/flightsim_gpws_ui.js');
    if (getComputedStyle(sc).position === 'static') sc.style.position = 'relative';
    gpws = MG.createGpwsCtl(sc, { tr: t, keyed: true, vehicle: flight.drone?.type, replay: true, canWrite: false, storage: { get: () => { try { return JSON.parse(localStorage.getItem('sm.gpws')); } catch { return null; } }, set: v => { try { localStorage.setItem('sm.gpws', JSON.stringify(v)); } catch { /* */ } } } });
  } catch (e) { console.warn('uçuş uyarıları yok:', e.message); }
  const gpwsStep = (fr, tt) => {
    if (!gpws) return;
    if (gpLast != null && (tt < gpLast - 0.5 || tt - gpLast > 2)) gpws.seek();   // atlama / başa dönüş
    if (gpLast === tt) return;
    gpLast = tt;
    const md = get(fr, 'mode');
    gpws.update({ t: tt, armed: !!get(fr, 'armed'), mode: (data.modes || [])[md] ?? md ?? null, roll: get(fr, 'roll'), pitch: get(fr, 'pitch'), vd: get(fr, 'vd'), vn: get(fr, 'vn'), ve: get(fr, 've'),
      groundspeed: get(fr, 'gs'), airspeed: get(fr, 'as'), alt_rel: get(fr, 'alt_rel'), batt_pct: get(fr, 'batt_pct'), gps_fix: get(fr, 'fix'), sats: get(fr, 'sats'), ...(psim ? psim.state() : {}) });
  };

  // HEPGO §26 "Yer kontrolünü koru": görev sonu raporu — katlanır kart
  try { const dc = await defendCard(flight); if (dc) sc.append(dc); } catch (e) { console.warn('görev raporu yok:', e.message); }

  const loop = now => {
    const dt = (now - last) / 1000; last = now;
    if (playing) { tcur += dt * speed; if (tcur > T1) tcur = T0; }
    const fr = frameAt(tcur);
    slider.value = Math.round(((tcur - T0) / dur) * 1000); timeEl.textContent = fmtDur(tcur - T0);
    view.update(fr, tcur); powerStep(fr, tcur); updateTele(fr); gpwsStep(fr, tcur);
    raf = requestAnimationFrame(loop);
  };
  raf = requestAnimationFrame(loop);
  window.__smReplay = { get t() { return tcur; }, seek: v => { tcur = v; }, get power() { return psim?.summary() || null; }, gauges, get gpws() { return gpws?.state() || null; }, get pilot() { return view?.pilot ?? null; } };   // teşhis (Playwright)
  return () => { cancelAnimationFrame(raf); view.dispose(); gauges?.dispose(); gpws?.dispose(); delete window.__smReplay; };
}

async function cesiumView(stage, data, frames, ix, flight) {
  const mod = await Promise.race([import('/sim/replay3d.js'), new Promise((_, rej) => setTimeout(() => rej(new Error('replay3d yüklenemedi')), 4000))]);
  const Cesium = await Promise.race([mod.loadCesium(), new Promise((_, rej) => setTimeout(() => rej(new Error('Cesium zaman aşımı')), 12000))]);
  clear(stage);
  const holder = h('div', { class: 'cesium-viewer' }); stage.append(holder);
  const viewer = mod.createViewer(Cesium, holder, { fullscreen: false });
  window.__smCesium = { viewer, Cesium };   // teşhis (Playwright: kamera yakın plan)
  const home = data.home || { lat: frames[0][ix.lat], lon: frames[0][ix.lon], alt: 0 };
  const pos = (fr) => Cesium.Cartesian3.fromDegrees(fr[ix.lon], fr[ix.lat], (fr[ix.alt_rel] || 0) + (home.alt || 0));
  const pts = frames.filter(f => Number.isFinite(f[ix.lat])).map(pos);
  viewer.entities.add({ polyline: { positions: pts, width: 3, material: Cesium.Color.fromCssColorString('#38bdf8').withAlpha(0.9) } });
  viewer.entities.add({ position: Cesium.Cartesian3.fromDegrees(home.lon, home.lat, home.alt || 0), point: { pixelSize: 10, color: Cesium.Color.fromCssColorString('#34d399') } });
  const isPlane = ['plane', 'vtol', 'interceptor'].includes(flight.drone?.type);
  const ent = viewer.entities.add({ position: pts[0], ...(isPlane ? { model: mod.PLANE_MODEL } : { point: { pixelSize: 14, color: Cesium.Color.fromCssColorString('#fbbf24'), outlineColor: Cesium.Color.BLACK, outlineWidth: 2 } }) });
  // §28 pilot (uçuş anındaki karakter; RC kumandalı) kalkış noktasının gerisinde — her karede dronu izler (sapma)
  let pilot = null;
  replayPilot(Cesium, viewer, flight, home, frames, ix).then(p => { pilot = p; }).catch(e => console.warn('kayıtta pilot yok:', e.message));
  const bs = Cesium.BoundingSphere.fromPoints(pts);
  viewer.camera.flyToBoundingSphere(bs, { duration: 1.2, offset: new Cesium.HeadingPitchRange(0, -Math.PI / 4, Math.max(bs.radius * 3, 600)) });
  return {
    update: fr => { if (!Number.isFinite(fr[ix.lat])) return; const p = pos(fr); ent.position = p; if (isPlane) ent.orientation = mod.planeOrientation(Cesium, p, fr[ix.yaw], fr[ix.pitch], fr[ix.roll]); pilot?.look(fr); },
    dispose: () => { pilot?.dispose(); delete window.__smCesium; try { viewer.destroy(); } catch { /* yok */ } },
    get pilot() { return pilot?.info() || null; },
  };
}

/** §28: kayıtta pilot — avatar_body (aynı prosedürel karakter, uçuş LOD'u, köşe renkleri) → GLB (GLTFExporter; WebGL gerekmez) → Cesium modeli.
 *  Yer: HEPGO §46 placePilot (evden 8 m geride + 3 m solda, ilk karedeki yönle); yön her karede drona (yalnız sapma). Avatar: uçuş anlık görüntüsü → pilot kaydı. */
export async function replayPilot(Cesium, viewer, flight, home, frames, ix) {
  let av = flight?.snapshot?.pilot?.avatar || flight?.pilot?.avatar || null;
  if (!av) { const pid = flight?.snapshot?.pilot?.id ?? flight?.pilot_id; try { const ps = (await api.get('/api/crew')).pilots || []; av = (ps.find(p => p.id === pid) || ps.find(p => p.is_default) || ps[0])?.avatar || null; } catch { av = null; } }
  const [T, { GLTFExporter }, { buildPilotRig }, P] = await Promise.all([import('/static/vendor/three/three.module.min.js'), import('/static/vendor/three/GLTFExporter.js'),
    import('../crew/avatar_body.js'), import('/sim/flightsim_pilot.js')]);
  const rig = buildPilotRig(T, av, { lod: 'mid' });
  const ch = rig.bones.body;   // karakter uzayı (y yukarı, yüz +z) — Cesium glTF ile aynı eksenler
  ch.rotation.x = 0; ch.position.set(0, ch.position.z, 0);
  const root = new T.Group(); root.add(ch);
  const glb = await new GLTFExporter().parseAsync(root, { binary: true });
  rig.dispose();
  const url = URL.createObjectURL(new Blob([glb], { type: 'model/gltf-binary' }));
  const f0 = frames.find(f => Number.isFinite(f[ix.lat])) || frames[0];
  const mLat = 110574, mLon = 111320 * Math.cos(home.lat * Math.PI / 180);
  const yaw0 = ((f0?.[ix.yaw] ?? f0?.[ix.hdg] ?? 0) * Math.PI) / 180;
  const hx = f0 ? (f0[ix.lon] - home.lon) * mLon : 0, hy = f0 ? (f0[ix.lat] - home.lat) * mLat : 0;   // ev = ilk kare (yerde)
  const pp = P.placePilot({ x: hx, y: hy }, yaw0);
  const plat = home.lat + pp.y / mLat, plon = home.lon + pp.x / mLon;
  const position = Cesium.Cartesian3.fromDegrees(plon, plat, home.alt || 0);
  let heading = pp.yaw;
  // ev noktasıyla aynı yükseklik (iz çizgisi/ev noktası da arazıye kenetlenmez → tutarlı); glTF y-yukarı/+z ileri → Cesium yönü −90°
  const mm = () => Cesium.Transforms.headingPitchRollToFixedFrame(position, new Cesium.HeadingPitchRoll(heading - Math.PI / 2, 0, 0));
  const model = await Cesium.Model.fromGltfAsync({ url, modelMatrix: mm(), minimumPixelSize: 56, maximumScale: 40 });
  viewer.scene.primitives.add(model);
  return {
    look(fr) {
      if (!Number.isFinite(fr[ix.lat])) return;
      const dx = (fr[ix.lon] - plon) * mLon, dy = (fr[ix.lat] - plat) * mLat;
      if (Math.hypot(dx, dy) > 0.5) { const tgt = Math.atan2(dx, dy); heading += P.wrapPi(tgt - heading) * 0.15; model.modelMatrix = mm(); }
    },
    info: () => ({ lat: plat, lon: plon, alt: home.alt || 0, heading, avatar: !!av, ready: !!model.ready }),
    dispose() { try { viewer.scene.primitives.remove(model); } catch { /* */ } URL.revokeObjectURL(url); },
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

// HEPGO §26 "Yer kontrolünü koru": görev sonu raporu kartı (puan, rütbe, önlenen/kaçan, sağlık, önleme süreleri, zaman çizelgesi); başlığa tıklama katlar
async function defendCard(flight) {
  if (!flight?.summary?.defend) return null;
  const MS = await import('/sim/flightsim_gcs_ui.js');
  const bodyEl = MS.defendReportBody(flight.summary.defend, { tr: t, keyed: true });
  const card = h('div', { class: 'replay-defend-card', style: 'position:absolute;top:80px;inset-inline-start:20px;width:min(460px,calc(100vw - 40px));max-height:calc(100% - 210px);overflow:auto;z-index:3;padding:10px 12px;border-radius:14px;background:linear-gradient(150deg,rgba(10,18,34,.9),rgba(30,14,20,.86));backdrop-filter:blur(10px);color:#e8eefb' },
    h('h3', { style: 'cursor:pointer;user-select:none;margin:0 0 8px' }, '◈ ', t('site.report')), bodyEl);
  card.querySelector('h3')?.addEventListener('click', () => { bodyEl.hidden = !bodyEl.hidden; });
  return card;
}
