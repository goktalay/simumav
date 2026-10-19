// Görev tasarımı için harita katmanı soyutlaması: Cesium (HEPGO replay3d.js loadCesium/createViewer ile aynı kaynak) →
// Google Maps 2B → düzlemsel canvas (parkur preview.png dokulu). Hepsi aynı arabirimi verir:
// { kind, toScreen(lat,lon)→{x,y}|null, fromScreen(x,y)→{lat,lon}|null, onChange(cb), flyTo(lat,lon,radius), dispose() }
import { toLocal, toGeo } from './geo.js';
import { loadGoogleMaps } from '../tracks/gmap.js';

async function tryCesium(host, track, timeoutMs = 12000) {
  const mod = await Promise.race([import('/sim/replay3d.js'), new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 4000))]);
  const Cesium = await Promise.race([mod.loadCesium(), new Promise((_, rej) => setTimeout(() => rej(new Error('Cesium timeout')), timeoutMs))]);
  const viewer = mod.createViewer(Cesium, host, { fullscreen: false });
  viewer.scene.screenSpaceCameraController.enableTilt = false;
  const listeners = new Set();
  viewer.scene.postRender.addEventListener(() => listeners.forEach(cb => cb()));
  const api = {
    kind: 'cesium',
    toScreen: (lat, lon) => { const c = Cesium.SceneTransforms.worldToWindowCoordinates(viewer.scene, Cesium.Cartesian3.fromDegrees(lon, lat, 0)); return c ? { x: c.x, y: c.y } : null; },
    fromScreen: (x, y) => { const cart = viewer.camera.pickEllipsoid(new Cesium.Cartesian2(x, y), viewer.scene.globe.ellipsoid); if (!cart) return null; const c = Cesium.Cartographic.fromCartesian(cart); return { lat: Cesium.Math.toDegrees(c.latitude), lon: Cesium.Math.toDegrees(c.longitude) }; },
    onChange: cb => listeners.add(cb),
    flyTo: (lat, lon, radius) => viewer.camera.flyTo({ destination: Cesium.Cartesian3.fromDegrees(lon, lat, Math.max(800, radius * 2.6)), orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 }, duration: 0.8 }),
    dispose: () => { try { viewer.destroy(); } catch { /* yok */ } },
    setInteractive: on => { viewer.scene.screenSpaceCameraController.enableInputs = on; },
  };
  api.flyTo(track.lat, track.lon, track.radius_m || 1000);
  return api;
}

async function tryGoogle(host, track, key, lang) {
  const google = await loadGoogleMaps(key, lang);
  if (!google) throw new Error('no key');
  const map = new google.maps.Map(host, { center: { lat: track.lat, lng: track.lon }, zoom: 15, mapTypeId: 'satellite', disableDefaultUI: true, zoomControl: true, gestureHandling: 'greedy', clickableIcons: false, tilt: 0 });
  const listeners = new Set();
  const ov = new google.maps.OverlayView(); ov.onAdd = () => {}; ov.onRemove = () => {}; ov.draw = () => listeners.forEach(cb => cb()); ov.setMap(map);
  for (const ev of ['bounds_changed', 'idle', 'drag', 'zoom_changed']) map.addListener(ev, () => listeners.forEach(cb => cb()));
  const api = {
    kind: 'google',
    toScreen: (lat, lon) => { const pr = ov.getProjection(); if (!pr) return null; const p = pr.fromLatLngToContainerPixel(new google.maps.LatLng(lat, lon)); return p ? { x: p.x, y: p.y } : null; },
    fromScreen: (x, y) => { const pr = ov.getProjection(); if (!pr) return null; const ll = pr.fromContainerPixelToLatLng(new google.maps.Point(x, y)); return ll ? { lat: ll.lat(), lon: ll.lng() } : null; },
    onChange: cb => listeners.add(cb),
    flyTo: (lat, lon) => map.panTo({ lat, lng: lon }),
    dispose: () => ov.setMap(null),
    setInteractive: on => map.setOptions({ gestureHandling: on ? 'greedy' : 'none' }),
  };
  return api;
}

/** Yedek: parkur merkezli düzlemsel harita; arka plan preview.png (varsa) + ızgara; tekerlek yakınlaştırma, sağ tuş/orta tuş sürükleme. */
function planarMap(host, track) {
  const canvas = document.createElement('canvas'); canvas.className = 'r2d planar';
  host.append(canvas);
  const ctx = canvas.getContext('2d');
  const c = { lat: track.lat, lon: track.lon };
  let scale = 0, ox = 0, oy = 0;    // px/m ve kaydırma (px)
  const img = new Image(); let imgOk = false;
  img.onload = () => { imgOk = true; draw(); }; img.src = track.preview_png || (track.id ? `/api/tracks/${track.id}/preview.png` : '');
  const listeners = new Set();
  const size = () => { const r = host.getBoundingClientRect(); canvas.width = Math.max(1, Math.round(r.width)); canvas.height = Math.max(1, Math.round(r.height)); if (!scale) scale = Math.min(canvas.width, canvas.height) / ((track.radius_m || 1000) * 2.4); draw(); };
  const ro = new ResizeObserver(size); ro.observe(host);
  const toScreen = (lat, lon) => { const l = toLocal(c, { lat, lon }); return { x: canvas.width / 2 + ox + l.x * scale, y: canvas.height / 2 + oy - l.y * scale }; };
  const fromScreen = (x, y) => toGeo(c, { x: (x - canvas.width / 2 - ox) / scale, y: -(y - canvas.height / 2 - oy) / scale });
  function draw() {
    const W = canvas.width, H = canvas.height;
    ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--bg-2') || '#0d1526'; ctx.fillRect(0, 0, W, H);
    const R = (track.radius_m || 1000) * scale, cx = W / 2 + ox, cy = H / 2 + oy;
    if (imgOk) { ctx.save(); ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.clip(); ctx.globalAlpha = 0.9; ctx.drawImage(img, cx - R, cy - R, 2 * R, 2 * R); ctx.restore(); }
    // ızgara (100 m)
    ctx.strokeStyle = 'rgba(148,163,184,.18)'; ctx.lineWidth = 1;
    const step = 100 * scale; if (step > 12) { for (let x = cx % step; x < W; x += step) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke(); } for (let y = cy % step; y < H; y += step) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke(); } }
    ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.strokeStyle = '#38bdf8'; ctx.lineWidth = 2; ctx.setLineDash([8, 6]); ctx.stroke(); ctx.setLineDash([]);
    ctx.beginPath(); ctx.arc(cx, cy, 6, 0, Math.PI * 2); ctx.fillStyle = '#fff'; ctx.fill();
    ctx.fillStyle = 'rgba(232,238,251,.7)'; ctx.font = '12px sans-serif'; ctx.fillText(`${track.radius_m || 1000} m`, cx + R + 6, cy);
    listeners.forEach(cb => cb());
  }
  let drag = null, interactive = true;
  canvas.addEventListener('wheel', e => { e.preventDefault(); const k = e.deltaY > 0 ? 0.88 : 1.14; const r = canvas.getBoundingClientRect(), mx = e.clientX - r.left - canvas.width / 2, my = e.clientY - r.top - canvas.height / 2; ox = mx - (mx - ox) * k; oy = my - (my - oy) * k; scale *= k; draw(); }, { passive: false });
  canvas.addEventListener('pointerdown', e => { if (e.button === 1 || e.button === 2 || e.shiftKey) { drag = { x: e.clientX, y: e.clientY }; canvas.setPointerCapture(e.pointerId); } });
  canvas.addEventListener('pointermove', e => { if (drag) { ox += e.clientX - drag.x; oy += e.clientY - drag.y; drag = { x: e.clientX, y: e.clientY }; draw(); } });
  canvas.addEventListener('pointerup', () => { drag = null; });
  canvas.addEventListener('contextmenu', e => e.preventDefault());
  size();
  return { kind: 'planar', toScreen, fromScreen, onChange: cb => listeners.add(cb), flyTo: () => { ox = oy = 0; draw(); }, dispose: () => { ro.disconnect(); canvas.remove(); }, setInteractive: on => { interactive = on; }, redraw: draw };
}

/** Sırayla dene; `status` geri bildirimi (hangi katman açıldı / neden düşüldü). */
export async function createMapLayer(host, track, { mapsKey, lang = 'tr', prefer = 'cesium', status = () => {} } = {}) {
  const errors = [];
  if (prefer === 'cesium') {
    try { status('cesium'); const m = await tryCesium(host, track); return { layer: m, errors }; } catch (e) { errors.push(`Cesium: ${e.message}`); host.replaceChildren(); }
  }
  if (mapsKey) {
    try { status('google'); const m = await tryGoogle(host, track, mapsKey, lang); return { layer: m, errors }; } catch (e) { errors.push(`Google: ${e.message}`); host.replaceChildren(); }
  }
  status('planar');
  return { layer: planarMap(host, track), errors };
}
