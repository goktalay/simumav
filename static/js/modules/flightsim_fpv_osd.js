// Uçuş Simülatörü — FPV OSD (pilot gözü kamerası 'pilot' kipinde 3B'nin üstünde tam ekran şeffaf canvas). Sözleşme: docs/ucus-simulatoru.md §22.
// Askeri HUD'dan (flightsim_hud.js, gimbal kamerası 'fpv') AYRI: Betaflight / analog OSD tarzı — sade beyaz monospace tipografi, ince siyah kontur,
// az öğe, büyük sayılar. Yalnız kamera kipi 'pilot' iken çizilir (her rAF, devicePixelRatio); diğer kiplerde canvas gizli, döngü durur.
// • Öğeler: üstte uçuş kipi + ARM durumu + uçuş süresi (canlı: oturum başı; kayıt: log zamanı), FOV; ortada küçük merkez işareti + YATAN yapay ufuk çizgisi
//   (roll ile döner, pitch ile kayar; ±10/20° kısa çentikler); sol kolon hız (km/h, büyük), sağ kolon irtifa (AGL m; yoksa alt_rel/alt_msl); altta pil gerilimi
//   + yüzde (tele.batt_pct yoksa gerilimden hücre kestirimi), RSSI (tele.rssi yoksa 'RSSI --'), GPS uydu sayısı + fix, lat/lon; eve mesafe + EVE OKU (ok,
//   gövde yönüne göre döner; GPS home'dan); uyarılar (kırmızı yanıp sönen): DÜŞÜK PİL (< %25), ALÇAK (armed, AGL < 10 m, hız > 3 m/s), ÇARPIŞMA, RSSI DÜŞÜK.
// • Analog efekt (`fs.fpv.analog`, varsayılan kapalı): tarama çizgileri + rastgele ince parazit/kayma şeritleri (RSSI düşükse ya da eve uzaklıkla artan);
//   renk doygunluğu 3B gölgelendiricisinde (sim.setFpvAnalog). PiP (`fs.fpv.pip`): 3B sağ üstte takip kamerası (sim.setPip) — OSD çerçeve + etiket çizer.
// • Veri: update(tele) — flightsim.js `last` ya da replay karesi (aynı biçim); ctx getter'lı: pose (3B'nin render ettiği roll/pitch/yaw; yoksa tele), camMode,
//   collision, session, t0, replay, fov (sim.getPilotFov), pipRect (sim.pipRect), pip (açık mı), rcOn (sanal kumanda çubukları görünür → alt satırlar yukarı).
// • Performans: metin ölçümü yok (textAlign), tarama deseni bir kez; 60 fps'te < 1,5 ms hedef (SwiftShader ölçümü §22).
// Dışa: createFpvOsd(stageEl, ctx, { tr, storage }) → { update, setCamMode, toggle, setEnabled, setAnalog, enabled, analog, stats(), dispose() };
//       saf yardımcılar (tests/test_flightsim_fpv.mjs): homeVector, relBearing, horizonLine, battPct, cellCount, osdWarnings, analogNoise, fmtClock,
//       homeArrow, createFpvPrefs (localStorage fs.fpv.analog / fs.fpv.pip / fs.fpv.nose / fs.fpv.fov / fs.osd.on).

export const LS = { analog: 'fs.fpv.analog', pip: 'fs.fpv.pip', nose: 'fs.fpv.nose', fov: 'fs.fpv.fov', osd: 'fs.osd.on', cam: 'fs.cam' };
export const LOW_BATT_PCT = 25, LOW_ALT_M = 10, LOW_RSSI = 30, LOW_FUEL_PCT = 20;
export const CELL = { min: 3.5, max: 4.2, nominal: 3.8 };   // LiPo hücre gerilimleri (yüzde kestirimi)
const DEG = Math.PI / 180;
const WHITE = '#f4f6f8', DIM = 'rgba(244,246,248,.6)', RED = '#ff4a4a';
const num = (v, d = null) => (v == null || Number.isNaN(Number(v)) ? d : Number(v));
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
export const wrap180 = a => ((a + 180) % 360 + 360) % 360 - 180;
const pad2 = v => String(v).padStart(2, '0');

// ---------------------------------------------------------------- saf yardımcılar ----------------------------------------------------------------
// Eve vektör: düz dünya yaklaşımı (ENU; 111320·cos(lat) / 110574 m/°) → { dist (m), bearing (° 0 = kuzey, saat yönü) }; veri yoksa null
export function homeVector(lat, lon, home) {
  if (lat == null || lon == null || !home || home.lat == null || home.lon == null) return null;
  const dLat = (Number(home.lat) - Number(lat)) * 110574, dLon = (Number(home.lon) - Number(lon)) * 111320 * Math.cos(Number(lat) * DEG);
  return { dist: Math.hypot(dLat, dLon), bearing: (Math.atan2(dLon, dLat) / DEG + 360) % 360 };
}
// Eve okunun ekrandaki dönüşü: evin gövde yönüne göre açısı (−180…180; 0 = tam ileri, + sağda)
export const relBearing = (bearing, hdg) => wrap180(num(bearing, 0) - num(hdg, 0));
// Yapay ufuk çizgisi uç noktaları: kamera gövdeye kilitli (roll + pitch tam). Odak f = (H/2)/tan(fov/2); burun yukarı (pitch +) → ufuk aşağı kayar;
// roll + (sağ kanat aşağı) → ufkun SAĞ ucu yukarı çıkar (görüntü saat yönünün tersine döner). Dönüş yalnız bakış ekseni etrafında: kayma ufka dik yönde.
export function horizonLine(W, H, rollRad, pitchRad, fovDeg, halfLen) {
  const f = (H / 2) / Math.tan(clamp(num(fovDeg, 120), 10, 170) * DEG / 2);
  const off = f * Math.tan(clamp(num(pitchRad, 0), -85 * DEG, 85 * DEG));
  const r = num(rollRad, 0), cx = W / 2, cy = H / 2;
  const px = Math.sin(r), py = Math.cos(r);           // ufka dik (ekranda "dünya aşağı") birim vektör
  const dx = Math.cos(r), dy = -Math.sin(r);          // ufuk doğrultusu (sağ uç)
  const mx = cx + px * off, my = cy + py * off;
  const L = num(halfLen, W * 0.22);
  return { x1: mx - dx * L, y1: my - dy * L, x2: mx + dx * L, y2: my + dy * L, mx, my, dx, dy, px, py, f };
}
// Hücre sayısı kestirimi (nominal 3,8 V/hücre); gerilim yoksa null
export const cellCount = v => (num(v, 0) > 0 ? Math.max(1, Math.round(Number(v) / CELL.nominal)) : null);
// Pil yüzdesi: telemetri yüzdesi varsa o (0…100); yoksa gerilimden (hücre başına 3,5 → 0 %, 4,2 → 100 %); ikisi de yoksa null
export function battPct(v, pct) {
  const p = num(pct, null);
  if (p != null && p >= 0) return clamp(p, 0, 100);
  const cells = cellCount(v);
  if (!cells) return null;
  return clamp((Number(v) / cells - CELL.min) / (CELL.max - CELL.min) * 100, 0, 100);
}
// Uyarılar (anahtar listesi; çizimde tr()): crash, lowbatt, lowalt, rssi
export function osdWarnings({ armed = false, agl = null, gs = 0, batt = null, collision = false, rssi = null, fuel = null, elec = null } = {}) {
  const w = [];
  if (collision) w.push('crash');
  // §23: elektronik batarya (tele.elec) varsa pil uyarısı ondan; yakıt (tele.fuel) biterse/azalırsa ayrı uyarılar
  if (elec) { if (elec.empty || elec.wh <= 0) w.push('elecempty'); else if (elec.pct != null && elec.pct < LOW_BATT_PCT) w.push('lowbatt'); }
  else if (batt != null && batt < LOW_BATT_PCT) w.push('lowbatt');
  if (fuel) { if (fuel.empty || fuel.l <= 0) w.push('fuelempty'); else if (fuel.pct != null && fuel.pct < LOW_FUEL_PCT) w.push('lowfuel'); }
  if (armed && agl != null && agl < LOW_ALT_M && num(gs, 0) > 3) w.push('lowalt');
  if (rssi != null && rssi < LOW_RSSI) w.push('rssi');
  return w;
}
// §23 OSD pil alanı: elektronik batarya varsa (V kestirimi, %, hücre, kalan dk) o; yoksa SITL pili (gerilim + yüzde kestirimi)
export function osdBattery(t) {
  if (t?.elec) return { v: num(t.elec.v, null), pct: num(t.elec.pct, null), cells: num(t.elec.cells, null) || null, min: t.elec.min_left != null ? num(t.elec.min_left, null) : null, elec: true, empty: !!t.elec.empty };
  const v = num(t?.batt_v, null);
  return { v, pct: battPct(t?.batt_v, t?.batt_pct), cells: cellCount(v), min: null, elec: false, empty: false };
}
// §23 OSD yakıt satırı metni: "FUEL 4.14L 83% 103km" (yakıt yoksa null)
export function osdFuelText(f) {
  if (!f) return null;
  const km = num(f.range_km, 0);
  return `FUEL ${num(f.l, 0).toFixed(2)}L ${Math.round(num(f.pct, 0))}% ${km >= 10 ? `${Math.round(km)}km` : `${km.toFixed(1)}km`}`;
}
// Analog parazit yoğunluğu 0…1: RSSI varsa (60 %'den aşağı doğrusal artar), yoksa eve uzaklıkla (3 km'de 0,6)
export function analogNoise(rssi, distM) {
  const r = num(rssi, null);
  if (r != null) return clamp((60 - r) / 60, 0, 1);
  return clamp(num(distM, 0) / 3000, 0, 1) * 0.6;
}
export const fmtClock = s => { const x = Math.max(0, Math.floor(num(s, 0))); return `${pad2(Math.floor(x / 60))}:${pad2(x % 60)}`; };
// Eve oku çokgeni (ok yukarı bakar, relDeg ile saat yönünde döner): [[x,y]…] 4 nokta
export function homeArrow(cx, cy, r, relDeg) {
  const a = num(relDeg, 0) * DEG, c = Math.cos(a), s = Math.sin(a);
  const rot = (x, y) => [cx + x * c - y * s, cy + x * s + y * c];
  return [rot(0, -r), rot(r * 0.65, r * 0.8), rot(0, r * 0.4), rot(-r * 0.65, r * 0.8)];
}
// Tercihler (localStorage; özel kipte sessiz)
export function createFpvPrefs(storage = null) {
  const st = storage || (typeof localStorage !== 'undefined' ? localStorage : null);
  const get = (k, d) => { try { const v = st?.getItem(k); return v == null ? d : v; } catch { return d; } };
  const set = (k, v) => { try { st?.setItem(k, String(v)); } catch { /* özel kip */ } };
  const S = { analog: get(LS.analog, '0') === '1', pip: get(LS.pip, '1') !== '0', nose: get(LS.nose, '1') !== '0', fov: clamp(num(get(LS.fov, '120'), 120), 90, 150), osd: get(LS.osd, '1') !== '0', cam: get(LS.cam, 'follow') };
  return {
    get analog() { return S.analog; }, get pip() { return S.pip; }, get nose() { return S.nose; }, get fov() { return S.fov; }, get osd() { return S.osd; }, get cam() { return S.cam; },
    setAnalog(v) { S.analog = !!v; set(LS.analog, S.analog ? '1' : '0'); return S.analog; },
    setPip(v) { S.pip = !!v; set(LS.pip, S.pip ? '1' : '0'); return S.pip; },
    setNose(v) { S.nose = !!v; set(LS.nose, S.nose ? '1' : '0'); return S.nose; },
    setFov(v) { S.fov = clamp(Math.round(num(v, 120)), 90, 150); set(LS.fov, S.fov); return S.fov; },
    setOsd(v) { S.osd = !!v; set(LS.osd, S.osd ? '1' : '0'); return S.osd; },
    setCam(v) { S.cam = String(v || 'follow'); set(LS.cam, S.cam); return S.cam; },
  };
}

// ---------------------------------------------------------------- canvas katmanı ----------------------------------------------------------------
export function createFpvOsd(stage, ctx = {}, { tr = s => s, storage = null } = {}) {
  const prefs = createFpvPrefs(storage);
  const canvas = document.createElement('canvas');
  canvas.className = 'fs-osd';
  canvas.hidden = true;
  stage.appendChild(canvas);
  const g = canvas.getContext('2d');
  let enabled = prefs.osd, analog = prefs.analog;
  let camMode = 'follow', tele = null, raf = 0, disposed = false, W = 0, H = 0, dpr = 1, firstTeleAt = 0;
  const visible = () => enabled && camMode === 'pilot';

  const resize = () => {
    W = Math.max(1, stage.clientWidth); H = Math.max(1, stage.clientHeight);
    dpr = Math.min(devicePixelRatio || 1, 2);
    canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
    canvas.style.width = `${W}px`; canvas.style.height = `${H}px`;
  };
  const ro = new ResizeObserver(() => resize());
  ro.observe(stage);
  resize();

  const apply = () => {
    const on = visible();
    canvas.hidden = !on;
    stage.classList.toggle('fs-osd-on', on);
    if (on && !raf) raf = requestAnimationFrame(frame);
    if (!on && raf) { cancelAnimationFrame(raf); raf = 0; }
  };
  const setCamMode = m => { camMode = m; apply(); };
  const setEnabled = v => { enabled = !!v; prefs.setOsd(enabled); apply(); };
  const toggle = () => setEnabled(!enabled);
  const setAnalog = v => { analog = !!v; prefs.setAnalog(analog); };
  const update = t => { if (t) { tele = t; if (!firstTeleAt) firstTeleAt = Date.now(); } };

  // 'O' OSD aç/kapa — yalnız FPV (pilot) kipinde, form alanlarında değil
  const editable = el => el && (/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || el.isContentEditable);
  const onKey = e => {
    if (disposed || camMode !== 'pilot' || editable(document.activeElement) || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
    if (e.key === 'o' || e.key === 'O') { toggle(); e.preventDefault(); }
  };
  window.addEventListener('keydown', onKey);

  // tarama çizgisi deseni (bir kez): 1×3 px — 2 saydam, 1 koyu
  let scan = null;
  const scanPattern = () => {
    if (scan) return scan;
    const pc = document.createElement('canvas'); pc.width = 1; pc.height = 3;
    const pg = pc.getContext('2d'); pg.fillStyle = 'rgba(0,0,0,.22)'; pg.fillRect(0, 2, 1, 1);
    scan = g.createPattern(pc, 'repeat');
    return scan;
  };

  // ---------- çizim yardımcıları (beyaz + ince siyah kontur) ----------
  let F = 13, S = 1;
  const font = (px, bold) => { g.font = `${bold ? '700 ' : '500 '}${Math.round(px)}px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace`; };
  const text = (s, x, y, { px = F, align = 'left', base = 'middle', color = WHITE, bold = false } = {}) => {
    font(px, bold); g.textAlign = align; g.textBaseline = base;
    g.lineWidth = Math.max(2.5, px * 0.18); g.strokeStyle = 'rgba(0,0,0,.9)'; g.lineJoin = 'round'; g.strokeText(s, x, y);
    g.fillStyle = color; g.fillText(s, x, y);
  };
  const stroke = (color = WHITE, w = 2) => { g.lineWidth = w + 2; g.strokeStyle = 'rgba(0,0,0,.75)'; g.lineCap = 'round'; g.stroke(); g.lineWidth = w; g.strokeStyle = color; g.stroke(); };
  const line = (x1, y1, x2, y2, color, w) => { g.beginPath(); g.moveTo(x1, y1); g.lineTo(x2, y2); stroke(color, w); };
  const blink = (ms = 500) => Math.floor(performance.now() / ms) % 2 === 0;

  // Yerleşim ölçümleri 30 karede bir: alt çubuk, sol alttaki Mission Planner / kayıt bilgisi kutusu (pil satırı onun üstüne), üstteki gezinti kapsülü (süre onun altına)
  const lay = { bar: 54, mp: 0, nav: 0, n: 0 };
  const stats = { ms: 0, n: 0 };
  function frame() {
    raf = 0;
    if (disposed || !visible()) return;
    raf = requestAnimationFrame(frame);
    if (lay.n++ % 30 === 0) {
      const bar = stage.querySelector('.fs-bar'), mp = stage.querySelector('.fs-mp'), nav = stage.querySelector('.fs-nav');
      lay.bar = bar ? bar.offsetHeight : 54;
      lay.mp = mp && !mp.hidden && getComputedStyle(mp).display !== 'none' ? mp.offsetHeight + 10 : 0;
      lay.nav = nav ? nav.offsetTop + nav.offsetHeight : 0;
    }
    const t0 = performance.now();
    draw();
    stats.ms += performance.now() - t0; stats.n++;
  }

  function draw() {
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, W, H);
    S = clamp(Math.min(W, H) / 820, 0.72, 1.3);
    F = 13 * S;
    const t = tele || {};
    const pose = ctx.pose || null;
    const roll = num(pose?.roll, num(t.roll, 0)), pitch = num(pose?.pitch, num(t.pitch, 0));
    const yawRad = num(pose?.yaw, num(t.yaw, null));
    const hdg = num(t.heading, yawRad != null ? ((yawRad / DEG) + 360) % 360 : 0);
    const fov = num(ctx.fov, 120);
    const vn = num(t.vn, 0), ve = num(t.ve, 0);
    const gs = num(t.groundspeed, Math.hypot(vn, ve));
    const agl = num(t.alt_rel, num(t.alt_msl, null));
    const armed = !!t.armed;
    const bat = osdBattery(t), bp = bat.pct, bv = bat.v;   // §23: elektronik batarya varsa o
    const rssi = num(t.rssi, null);
    const hv = homeVector(t.lat, t.lon, t.home);
    const rcOn = !!ctx.rcOn || stage.classList.contains('rc-on');
    const bottom = H - lay.bar - (rcOn ? 176 * S : 10 * S);   // alt çubuk (ve sanal kumanda çubukları) üstü
    const cx = W / 2, cy = H / 2, m = 18 * S;
    const pipOn = !!ctx.pip, pr = pipOn && typeof ctx.pipRect === 'function' ? ctx.pipRect() : null;

    // --- analog katman: tarama çizgileri + parazit (en altta, metinlerin altında) ---
    if (analog) {
      g.fillStyle = scanPattern(); g.fillRect(0, 0, W, H);
      const n = analogNoise(rssi, hv?.dist);
      if (n > 0.02) {
        const bands = Math.round(n * 5 + (Math.random() < n ? 2 : 0));
        for (let i = 0; i < bands; i++) {   // yatay kayma/parazit şeritleri
          const y = Math.random() * H, h = (1 + Math.random() * 6) * S, a = 0.08 + n * 0.25 * Math.random();
          g.fillStyle = Math.random() < 0.5 ? `rgba(255,255,255,${a})` : `rgba(0,0,0,${a})`;
          g.fillRect(Math.random() * 20 * S - 10 * S, y, W, h);
        }
        const specks = Math.round(n * 140);
        g.fillStyle = 'rgba(255,255,255,.35)';
        for (let i = 0; i < specks; i++) g.fillRect(Math.random() * W, Math.random() * H, 2, 2);
      }
    }

    // --- yapay ufuk (yatar) + ±10/20° çentikler + merkez işareti ---
    const hl = horizonLine(W, H, roll, pitch, fov, Math.min(W * 0.22, 260 * S));
    const gap = 46 * S;
    g.save();
    g.beginPath(); g.rect(cx - W * 0.3, cy - H * 0.32, W * 0.6, H * 0.64); g.clip();
    g.beginPath();
    g.moveTo(hl.mx - hl.dx * gap, hl.my - hl.dy * gap); g.lineTo(hl.x1, hl.y1);
    g.moveTo(hl.mx + hl.dx * gap, hl.my + hl.dy * gap); g.lineTo(hl.x2, hl.y2);
    stroke(WHITE, 2.2);
    for (const L of [-20, -10, 10, 20]) {   // kısa pitch çentikleri (ufukla birlikte döner): L° ufkun üstündeki çizgi, ufka dik yönde f·tan(pitch − L) − f·tan(pitch)
      const o = hl.f * Math.tan(clamp(pitch - L * DEG, -85 * DEG, 85 * DEG)) - hl.f * Math.tan(clamp(pitch, -85 * DEG, 85 * DEG));
      const bx = hl.mx + hl.px * o, by = hl.my + hl.py * o, half = (Math.abs(L) === 20 ? 34 : 22) * S;
      g.beginPath(); g.moveTo(bx - hl.dx * half, by - hl.dy * half); g.lineTo(bx - hl.dx * 12 * S, by - hl.dy * 12 * S);
      g.moveTo(bx + hl.dx * 12 * S, by + hl.dy * 12 * S); g.lineTo(bx + hl.dx * half, by + hl.dy * half);
      if (L < 0) g.setLineDash([4 * S, 4 * S]);
      stroke(DIM, 1.4); g.setLineDash([]);
    }
    g.restore();
    // merkez işareti: küçük artı + nokta
    line(cx - 14 * S, cy, cx - 5 * S, cy, WHITE, 2); line(cx + 5 * S, cy, cx + 14 * S, cy, WHITE, 2);
    line(cx, cy - 10 * S, cx, cy - 4 * S, WHITE, 2);
    g.beginPath(); g.arc(cx, cy, 1.6 * S, 0, Math.PI * 2); g.fillStyle = WHITE; g.fill();

    // --- üst: mod · ARM · süre · FOV ---
    const topY = m + 8 * S;
    text(t.mode || '—', m, topY, { px: F * 1.25, bold: true });
    text(armed ? tr('ARM') : tr('DISARM'), m, topY + 22 * S, { px: F * 1.05, bold: armed, color: armed ? WHITE : DIM });
    const el = ctx.replay && t.t != null ? t.t : (ctx.t0 ? (Date.now() - ctx.t0) / 1000 : (firstTeleAt ? (Date.now() - firstTeleAt) / 1000 : 0));
    const timeY = Math.max(topY, lay.nav + 16 * S);   // gezinti kapsülünün altında
    text(`${tr('FLY')} ${fmtClock(el)}`, cx, timeY, { align: 'center', px: F * 1.2, bold: true });
    if (ctx.replay) text('▸ REPLAY', cx, timeY + 20 * S, { align: 'center', px: F * 0.9, color: DIM });
    const rightX = W - m;
    if (pr) {   // PiP çerçevesi + etiket (3B görüntü altta; burada yalnız çerçeve)
      g.beginPath(); g.rect(pr.x - 1, pr.y - 1, pr.w + 2, pr.h + 2); stroke(WHITE, 1.6);
      text(tr('TAKİP'), pr.x + 6 * S, pr.y + pr.h - 9 * S, { px: F * 0.8, color: DIM });
      text(`FOV ${fov.toFixed(0)}°`, rightX, pr.y + pr.h + 14 * S, { align: 'right', px: F * 0.9, color: DIM });
    } else text(`FOV ${fov.toFixed(0)}°`, rightX, topY, { align: 'right', px: F * 0.9, color: DIM });

    // --- sol: hız (km/h) · sağ: irtifa (m) ---
    const kmh = gs * 3.6;
    text(kmh.toFixed(0), m, cy - 4 * S, { px: F * 2.6, bold: true, base: 'bottom' });
    text(tr('KM/H'), m + 2 * S, cy + 8 * S, { px: F * 0.85, color: DIM });
    if (agl != null) {
      text(agl.toFixed(agl < 10 && agl > -10 ? 1 : 0), rightX, cy - 4 * S, { align: 'right', px: F * 2.6, bold: true, base: 'bottom' });
      text(t.alt_rel != null ? tr('M AGL') : tr('M MSL'), rightX - 2 * S, cy + 8 * S, { align: 'right', px: F * 0.85, color: DIM });
    }
    const climb = num(t.climb, t.vd != null ? -num(t.vd, 0) : null);
    if (climb != null) text(`${climb > 0.05 ? '▲' : climb < -0.05 ? '▼' : '—'} ${Math.abs(climb).toFixed(1)}`, rightX, cy + 28 * S, { align: 'right', px: F * 0.95 });

    // --- alt sol: pil (Mission Planner / kayıt bilgisi kutusunun üstünde) ---
    const by = bottom - 10 * S, ly = bottom - 10 * S - (rcOn ? 0 : lay.mp);
    const lowB = bat.empty || (bp != null && bp < LOW_BATT_PCT);
    const fuelTxt = osdFuelText(t.fuel);
    const fy = fuelTxt ? ly - 42 * S : ly;   // yakıt satırı varsa pil bloğu bir satır yukarı (yakıt en altta)
    text(bv != null && bv > 0 ? `${bv.toFixed(1)}V` : '--.-V', m, fy, { px: F * 1.3, bold: true, base: 'bottom', color: lowB && blink() ? RED : WHITE });
    if (bp != null) {
      text(`${bp.toFixed(0)}%`, m + 86 * S, fy, { px: F * 1.1, base: 'bottom', color: lowB ? RED : WHITE });
      g.beginPath(); g.rect(m, fy - 32 * S, 70 * S, 6 * S); stroke(WHITE, 1); g.fillStyle = lowB ? RED : WHITE; g.fillRect(m, fy - 32 * S, 70 * S * bp / 100, 6 * S);
    }
    if (bat.cells) text(`${bat.cells}S`, m + 140 * S, fy, { px: F * 0.9, base: 'bottom', color: DIM });
    if (bat.elec && bat.min != null) text(`${Math.round(bat.min)}min`, m + 176 * S, fy, { px: F * 0.9, base: 'bottom', color: DIM });   // §23 kalan süre (elektronik)
    if (fuelTxt) {   // §23 yakıt: litre · % · kalan menzil + çubuk
      const lowF = t.fuel.empty || num(t.fuel.pct, 100) < LOW_FUEL_PCT;
      text(fuelTxt, m, ly, { px: F * 1.05, bold: true, base: 'bottom', color: lowF && blink() ? RED : WHITE });
      g.beginPath(); g.rect(m, ly - 26 * S, 70 * S, 5 * S); stroke(WHITE, 1); g.fillStyle = lowF ? RED : WHITE; g.fillRect(m, ly - 26 * S, 70 * S * clamp(num(t.fuel.pct, 0), 0, 100) / 100, 5 * S);
    }

    // --- alt orta: RSSI · SAT · konum ---
    const rs = rssi != null ? `RSSI ${rssi.toFixed(0)}%` : 'RSSI --';
    const fix = t.gps_fix >= 6 ? 'RTK' : t.gps_fix === 5 ? 'RTKf' : t.gps_fix === 4 ? 'DGPS' : t.gps_fix === 3 ? '3D' : t.gps_fix === 2 ? '2D' : '--';
    text(`${rs}   SAT ${t.sats != null ? t.sats : '--'} ${fix}`, cx, by, { align: 'center', px: F * 1.0, base: 'bottom', color: rssi != null && rssi < LOW_RSSI ? RED : WHITE });
    if (t.lat != null) text(`${Number(t.lat).toFixed(5)}  ${Number(t.lon).toFixed(5)}`, cx, by - 20 * S, { align: 'center', px: F * 0.85, base: 'bottom', color: DIM });

    // --- alt sağ: eve mesafe + ok ---
    if (hv) {
      const rel = relBearing(hv.bearing, hdg);
      const ar = 12 * S, ax = rightX - ar - 2 * S, ay = by - 12 * S;
      const pts = homeArrow(ax, ay, ar, rel);
      g.beginPath(); pts.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y))); g.closePath();
      g.fillStyle = WHITE; g.fill(); stroke('rgba(0,0,0,.85)', 1);
      text(`${tr('HOME')} ${hv.dist >= 1000 ? `${(hv.dist / 1000).toFixed(2)}km` : `${hv.dist.toFixed(0)}m`}`, ax - ar - 8 * S, by, { align: 'right', px: F * 1.1, bold: true, base: 'bottom' });
    }

    // --- uyarılar (merkezin altında, kırmızı yanıp söner) ---
    const warns = osdWarnings({ armed, agl, gs, batt: bp, collision: !!ctx.collision, rssi, fuel: t.fuel || null, elec: t.elec || null });
    if (warns.length) {
      const on = blink(450);
      const labels = { crash: tr('ÇARPIŞMA'), lowbatt: tr('DÜŞÜK PİL'), lowalt: tr('ALÇAK'), rssi: tr('RSSI DÜŞÜK'), lowfuel: tr('DÜŞÜK YAKIT'), fuelempty: tr('YAKIT BİTTİ'), elecempty: tr('BATARYA BİTTİ') };
      let wy = cy + 60 * S;
      for (const w of warns) { text(labels[w] || w, cx, wy, { align: 'center', px: F * 1.35, bold: true, color: on ? RED : 'rgba(255,74,74,.45)' }); wy += 24 * S; }
    }
    // ipucu (sağ alt, küçük)
    text(tr('O: OSD · tekerlek: FOV · C: kamera'), rightX, by - 26 * S, { align: 'right', px: F * 0.75, base: 'bottom', color: 'rgba(244,246,248,.45)' });
  }

  apply();
  canvas.__osd = {
    update, setCamMode, toggle, setEnabled, setAnalog, prefs,
    get enabled() { return enabled; }, get analog() { return analog; },
    stats: () => ({ drawMs: stats.n ? stats.ms / stats.n : 0, frames: stats.n }),
    dispose() {
      disposed = true;
      if (raf) cancelAnimationFrame(raf);
      ro.disconnect();
      window.removeEventListener('keydown', onKey);
      stage.classList.remove('fs-osd-on');
      canvas.remove();
    },
  };
  return canvas.__osd;   // canvas.__osd: tanı/test erişimi (Playwright stats())
}
