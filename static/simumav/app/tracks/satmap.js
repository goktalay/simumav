// Google Haritalar yedeği: uydu karolu (Esri World Imagery; anahtarsız) hafif 2B konum seçici — pickerMap ile AYNI arabirim.
// Google anahtarı reddedildiğinde (gm_authFailure: HTTP yönlendiren kısıtı / API kapalı) ya da hiç yokken harita kutusu boş hata ekranında kalmasın diye.
// Tek 2B tuval (WebGL yok); Web Mercator karoları (256 px, tam sayı yakınlaştırma), sürükle = kaydır, tekerlek / +− = yakınlaştır, tıkla = onPick,
// merkez işaretçisi ve halka işaretçileri sürüklenebilir. CSP: img-src https: (karolar <img> olarak yüklenir; connect-src gerekmez).
const TILE = 256;
const TILE_URL = (z, x, y) => `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${y}/${x}`;
export const SAT_ATTRIBUTION = 'Esri, Maxar, Earthstar Geographics';
const DEG = Math.PI / 180;

// Web Mercator (saf; test edilir): enlem/boylam ↔ dünya pikseli (z yakınlaştırmada dünya genişliği 256·2^z)
export function project(lat, lon, z) {
  const W = TILE * 2 ** z, s = Math.sin(Math.max(-85.0511, Math.min(85.0511, lat)) * DEG);
  return { x: (lon + 180) / 360 * W, y: (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * W };
}
export function unproject(x, y, z) {
  const W = TILE * 2 ** z, n = Math.PI - 2 * Math.PI * y / W;
  return { lat: Math.atan(Math.sinh(n)) / DEG, lon: x / W * 360 - 180 };
}
/** "40.1, 33.4" biçimli koordinat metni → {lat, lon} | null (yedek haritada adres araması yok; koordinat girilebilir). */
export function parseLatLon(q) {
  const m = String(q || '').trim().match(/^(-?\d+(?:\.\d+)?)\s*[,; ]\s*(-?\d+(?:\.\d+)?)$/);
  if (!m) return null;
  const lat = Number(m[1]), lon = Number(m[2]);
  return Math.abs(lat) <= 90 && Math.abs(lon) <= 180 ? { lat, lon } : null;
}

export function satPickerMap(host, { lat, lon, radius_m = 1000, onPick, onGateMove, note = '' }) {
  const wrap = document.createElement('div'); wrap.className = 'sat-map';
  const canvas = document.createElement('canvas'); canvas.className = 'sat-map-canvas'; canvas.tabIndex = 0;
  const zin = document.createElement('button'), zout = document.createElement('button');
  zin.type = zout.type = 'button'; zin.className = zout.className = 'sat-zoom'; zin.textContent = '+'; zout.textContent = '−';
  const zbox = document.createElement('div'); zbox.className = 'sat-zoom-box'; zbox.append(zin, zout);
  const attr = document.createElement('div'); attr.className = 'sat-attr'; attr.textContent = `© ${SAT_ATTRIBUTION}`;
  wrap.append(canvas, zbox, attr);
  if (note) { const n = document.createElement('div'); n.className = 'sat-note'; n.setAttribute('role', 'status'); n.textContent = note; wrap.append(n); }
  host.append(wrap);
  const ctx = canvas.getContext('2d');
  const st = { c: { lat, lon }, z: 14, r: radius_m, center: { lat, lon }, gates: [] };
  const cache = new Map();
  let W = 1, H = 1, dpr = 1, raf = 0, dead = false;

  const mpp = () => 156543.03392 * Math.cos(st.c.lat * DEG) / 2 ** st.z;   // metre / piksel
  const toScreen = (la, lo) => { const p = project(la, lo, st.z), c = project(st.c.lat, st.c.lon, st.z); return { x: W / 2 + p.x - c.x, y: H / 2 + p.y - c.y }; };
  const fromScreen = (x, y) => { const c = project(st.c.lat, st.c.lon, st.z); return unproject(c.x + x - W / 2, c.y + y - H / 2, st.z); };
  const tile = (z, x, y) => {
    const n = 2 ** z; if (y < 0 || y >= n) return null;
    const xx = ((x % n) + n) % n, k = `${z}/${xx}/${y}`;
    let e = cache.get(k);
    if (!e) {
      const img = new Image(); e = { img, ok: false };   // yalnız çizilir (piksel okunmaz) → CORS gerekmez
      img.onload = () => { e.ok = true; schedule(); }; img.onerror = () => { e.err = true; };
      img.src = TILE_URL(z, xx, y); cache.set(k, e);
      if (cache.size > 400) cache.delete(cache.keys().next().value);
    }
    return e;
  };
  function draw() {
    raf = 0; if (dead) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#0b1220'; ctx.fillRect(0, 0, W, H);
    const c = project(st.c.lat, st.c.lon, st.z), x0 = c.x - W / 2, y0 = c.y - H / 2;
    for (let ty = Math.floor(y0 / TILE); ty <= Math.floor((y0 + H) / TILE); ty++) {
      for (let tx = Math.floor(x0 / TILE); tx <= Math.floor((x0 + W) / TILE); tx++) {
        const e = tile(st.z, tx, ty);
        if (e?.ok) ctx.drawImage(e.img, Math.round(tx * TILE - x0), Math.round(ty * TILE - y0), TILE, TILE);
      }
    }
    // yarıçap dairesi + merkez işaretçisi + halkalar
    const m = toScreen(st.center.lat, st.center.lon), rpx = st.r / mpp();
    ctx.beginPath(); ctx.arc(m.x, m.y, rpx, 0, Math.PI * 2); ctx.fillStyle = 'rgba(56,189,248,.08)'; ctx.fill(); ctx.strokeStyle = 'rgba(56,189,248,.9)'; ctx.lineWidth = 2; ctx.stroke();
    ctx.beginPath(); ctx.arc(m.x, m.y - 14, 9, Math.PI * 0.85, Math.PI * 2.15); ctx.lineTo(m.x, m.y); ctx.closePath(); ctx.fillStyle = '#ef4444'; ctx.fill(); ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5; ctx.stroke();
    ctx.beginPath(); ctx.arc(m.x, m.y - 14, 3.2, 0, Math.PI * 2); ctx.fillStyle = '#7f1d1d'; ctx.fill();
    ctx.font = '700 12px system-ui, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    for (const g of st.gates) {
      const p = toScreen(g.lat, g.lon);
      ctx.beginPath(); ctx.arc(p.x, p.y, 14, 0, Math.PI * 2); ctx.fillStyle = g.kind === 'gate' ? 'rgba(167,139,250,.85)' : 'rgba(56,189,248,.85)'; ctx.fill(); ctx.strokeStyle = '#fff'; ctx.lineWidth = 2; ctx.stroke();
      ctx.fillStyle = '#fff'; ctx.fillText(String(g.i + 1), p.x, p.y + 0.5);
    }
  }
  function schedule() { if (!raf && !dead) raf = requestAnimationFrame(draw); }
  const size = () => {
    const r = wrap.getBoundingClientRect(); dpr = Math.min(2, window.devicePixelRatio || 1);
    W = Math.max(1, Math.round(r.width)); H = Math.max(1, Math.round(r.height));
    canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr); canvas.style.width = `${W}px`; canvas.style.height = `${H}px`;
    schedule();
  };
  const ro = new ResizeObserver(size); ro.observe(wrap);
  const zoomAt = (dz, sx = W / 2, sy = H / 2) => {
    const nz = Math.max(3, Math.min(19, st.z + dz)); if (nz === st.z) return;
    const before = fromScreen(sx, sy); st.z = nz;
    const p = project(before.lat, before.lon, st.z);   // imleç altındaki nokta sabit kalsın
    st.c = unproject(p.x - (sx - W / 2), p.y - (sy - H / 2), st.z); schedule();
  };
  zin.onclick = () => zoomAt(1); zout.onclick = () => zoomAt(-1);
  canvas.addEventListener('wheel', e => { e.preventDefault(); const r = canvas.getBoundingClientRect(); zoomAt(e.deltaY < 0 ? 1 : -1, e.clientX - r.left, e.clientY - r.top); }, { passive: false });
  let drag = null;
  const hit = (x, y) => {
    for (const g of st.gates) { const p = toScreen(g.lat, g.lon); if (Math.hypot(p.x - x, p.y - y) <= 16) return { kind: 'gate', g }; }
    const m = toScreen(st.center.lat, st.center.lon); if (Math.hypot(m.x - x, m.y - 12 - y) <= 14) return { kind: 'center' };
    return null;
  };
  canvas.addEventListener('pointerdown', e => {
    const r = canvas.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
    drag = { x, y, sx: x, sy: y, moved: false, target: hit(x, y), id: e.pointerId };
    canvas.setPointerCapture?.(e.pointerId);
  });
  canvas.addEventListener('pointermove', e => {
    if (!drag) { const r = canvas.getBoundingClientRect(); canvas.style.cursor = hit(e.clientX - r.left, e.clientY - r.top) ? 'grab' : 'crosshair'; return; }
    const r = canvas.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
    if (Math.hypot(x - drag.sx, y - drag.sy) > 4) drag.moved = true;
    if (!drag.moved) return;
    if (drag.target?.kind === 'gate') { const p = fromScreen(x, y); drag.target.g.lat = p.lat; drag.target.g.lon = p.lon; }
    else if (drag.target?.kind === 'center') st.center = fromScreen(x, y + 12);
    else { const c = project(st.c.lat, st.c.lon, st.z); st.c = unproject(c.x - (x - drag.x), c.y - (y - drag.y), st.z); }
    drag.x = x; drag.y = y; schedule();
  });
  const end = e => {
    if (!drag) return;
    const d = drag; drag = null; canvas.releasePointerCapture?.(d.id);
    if (!d.moved) { const p = fromScreen(d.sx, d.sy); onPick?.({ lat: p.lat, lon: p.lon }); return; }
    if (d.target?.kind === 'gate') onGateMove?.(d.target.g.src, { lat: d.target.g.lat, lon: d.target.g.lon });   // özgün halka nesnesi (editör onu günceller)
    else if (d.target?.kind === 'center') onPick?.({ lat: st.center.lat, lon: st.center.lon }, true);
    void e;
  };
  canvas.addEventListener('pointerup', end); canvas.addEventListener('pointercancel', end);
  size();
  return {
    map: null, kind: 'sat',
    setCenter: (la, lo, r) => { st.center = { lat: la, lon: lo }; st.c = { lat: la, lon: lo }; if (r) st.r = r; schedule(); },
    setRadius: r => { st.r = r; schedule(); },
    setGates: gates => { st.gates = (gates || []).map(g => ({ ...g, src: g })); schedule(); },
    geocode: async q => parseLatLon(q),
    dispose: () => { dead = true; ro.disconnect(); cancelAnimationFrame(raf); cache.clear(); wrap.remove(); },
  };
}
