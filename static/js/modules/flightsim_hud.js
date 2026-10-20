// Uçuş Simülatörü — askeri tarz HUD (Gimbal kamerası kipinde — kod adı 'fpv', tuş 3 — 3B'nin üstünde tam ekran şeffaf canvas). Sözleşme: docs/ucus-simulatoru.md §10. GERÇEK FPV ('pilot') için ayrı OSD: flightsim_fpv_osd.js (§22).
// • Yalnız kamera kipi 'fpv' iken çizilir (her rAF, devicePixelRatio); diğer kiplerde canvas gizli, döngü durur. 'H' aç/kapa, Shift+H renk
//   (yeşil → beyaz → amber); tercihler localStorage (fs.mhud.on / fs.mhud.color). Açıkken sahnedeki .fs-stage'e `fs-mhud-on` sınıfı
//   eklenir (CSS sağdaki uçuş veri panelini ve ÇARPIŞMA bandını gizler; HUD bunları kapsar).
// • Öğeler: suni ufuk + pitch merdiveni (±90°, 5°; roll ile döner; zenit/nadir), roll yayı, boresight (W), uçuş yolu vektörü (vn/ve/vd),
//   heading şeridi (ev yönü + rüzgâr), hava hızı / irtifa bantları, dikey hız çubuğu, radar irtifa "R", sol alt (mod, ARM/SAFE, G, gaz,
//   batarya, GPS), sağ alt (UTC, T+, lat/lon, HOME, gimbal), üst sağ (● REC, CAM 1 · EO, FOV), köşe çerçeveleri, hedef kutusu, uyarılar.
// • Veri: update(tele, ctx) — tele: flightsim.js `last` ya da replay karesi (aynı biçim); ctx getter'lı nesne: pose (3B'nin render ettiği
//   roll/pitch/yaw; yoksa tele), world, session, gimbalDeg, camMode, collision, t0 (canlı oturum başlangıcı, ms), replay (bool), fov.
// • Performans: metin ölçümü yok (textAlign ile hizalama), kutu genişlikleri sabit; 60 fps'te < 2 ms hedef.
// Dışa: createMilHud(stageEl, ctx, { tr }) → { update(tele), setCamMode(mode), toggle(), setEnabled(bool), cycleColor(), get enabled, dispose() }.

import { launchHud } from './flightsim_launch.js';   // kalkış yöntemi satırı (§13)

const COLORS = [['green', '#9cff6a'], ['white', '#f2f5f0'], ['amber', '#ffbf47']];
const RED = '#ff4444';
const DEG = Math.PI / 180;
const LS_ON = 'fs.mhud.on', LS_COLOR = 'fs.mhud.color';
const num = (v, d = null) => (v == null || Number.isNaN(Number(v)) ? d : Number(v));
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const wrap180 = a => { a = ((a + 180) % 360 + 360) % 360 - 180; return a; };
const pad3 = v => String(Math.round(((v % 360) + 360) % 360)).padStart(3, '0');
const pad2 = v => String(v).padStart(2, '0');
const CARD = { 0: 'N', 90: 'E', 180: 'S', 270: 'W' };

// §23.6 gimbal HUD güç çubukları (sol alt bloğun sağında iki DİKEY bar, yeşil fosfor): [{ label:'BAT'|'FUEL', pct, low, empty, l1, l2 }] — BAT: elektronik
// batarya (V · kalan dk) ya da SITL pili (V · %); FUEL: tele.fuel varsa (L · menzil). Düşük (< 25 % / < 20 %) ya da bitti → kırmızı, dolgu yanıp söner.
export function hudPowerBars(t) {
  const out = [], e = t?.elec || null;
  const bp = e ? num(e.pct, null) : num(t?.batt_pct, null), bv = e ? num(e.v, null) : num(t?.batt_v, null);
  if (bp != null || (bv != null && bv > 0)) out.push({ label: 'BAT', pct: clamp(bp ?? 0, 0, 100), low: !!e?.empty || (bp != null && bp < 25), empty: !!e?.empty, l1: bv != null && bv > 0 ? `${bv.toFixed(1)}V` : '—', l2: e && e.min_left != null ? `${Math.round(e.min_left)}min` : '' });
  if (t?.fuel) { const f = t.fuel, km = num(f.range_km, 0); out.push({ label: 'FUEL', pct: clamp(num(f.pct, 0), 0, 100), low: !!f.empty || num(f.pct, 100) < 20, empty: !!f.empty, l1: `${num(f.l, 0).toFixed(2)}L`, l2: km >= 10 ? `${Math.round(km)}km` : `${km.toFixed(1)}km` }); }
  return out;
}

export function createMilHud(stage, ctx = {}, { tr = s => s } = {}) {
  const canvas = document.createElement('canvas');
  canvas.className = 'fs-mhud';
  canvas.hidden = true;
  stage.appendChild(canvas);
  const g = canvas.getContext('2d');
  let enabled = localStorage.getItem(LS_ON) !== '0';
  let colorIdx = Math.max(0, COLORS.findIndex(([k]) => k === localStorage.getItem(LS_COLOR)));
  let camMode = 'follow', tele = null, raf = 0, disposed = false, W = 0, H = 0, dpr = 1;
  let gcsSeen = false, firstTeleAt = 0;
  const visible = () => enabled && camMode === 'fpv';

  // ---------- boyut ----------
  const resize = () => {
    W = Math.max(1, stage.clientWidth); H = Math.max(1, stage.clientHeight);
    dpr = Math.min(devicePixelRatio || 1, 2);
    canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
    canvas.style.width = `${W}px`; canvas.style.height = `${H}px`;
  };
  const ro = new ResizeObserver(() => { resize(); });
  ro.observe(stage);
  resize();

  // ---------- görünürlük ----------
  const apply = () => {
    const on = visible();
    canvas.hidden = !on;
    stage.classList.toggle('fs-mhud-on', on);
    if (on && !raf) raf = requestAnimationFrame(frame);
    if (!on && raf) { cancelAnimationFrame(raf); raf = 0; }
  };
  const setCamMode = m => { camMode = m; apply(); };
  const setEnabled = v => { enabled = !!v; localStorage.setItem(LS_ON, enabled ? '1' : '0'); apply(); };
  const toggle = () => setEnabled(!enabled);
  const cycleColor = () => { colorIdx = (colorIdx + 1) % COLORS.length; localStorage.setItem(LS_COLOR, COLORS[colorIdx][0]); };
  const update = t => { if (t) { tele = t; if (!firstTeleAt) firstTeleAt = Date.now(); if (t.gcs_connected) gcsSeen = true; } };

  // 'H' aç/kapa, Shift+H renk — yalnız FPV kipinde, form alanlarında değil
  const editable = el => el && (/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || el.isContentEditable);
  const onKey = e => {
    if (disposed || camMode !== 'fpv' || editable(document.activeElement) || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === 'h' || e.key === 'H') { if (e.shiftKey) { if (enabled) cycleColor(); } else toggle(); e.preventDefault(); }
  };
  window.addEventListener('keydown', onKey);

  // ---------- çizim yardımcıları (yeşil fosfor + ince siyah dış çizgi) ----------
  let C = COLORS[0][1], F = 12, S = 1;   // renk, temel yazı boyutu, ölçek
  const font = (px, bold) => { g.font = `${bold ? '700 ' : ''}${Math.round(px)}px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace`; };
  const text = (s, x, y, { px = F, align = 'left', base = 'middle', color = C, bold = false } = {}) => {
    font(px, bold); g.textAlign = align; g.textBaseline = base;
    g.lineWidth = 3; g.strokeStyle = 'rgba(0,0,0,.85)'; g.lineJoin = 'round'; g.strokeText(s, x, y);
    g.fillStyle = color; g.fillText(s, x, y);
  };
  const stroke = (color = C, w = 1.5) => { g.lineWidth = w + 1.6; g.strokeStyle = 'rgba(0,0,0,.6)'; g.stroke(); g.lineWidth = w; g.strokeStyle = color; g.stroke(); };
  const line = (x1, y1, x2, y2, color, w) => { g.beginPath(); g.moveTo(x1, y1); g.lineTo(x2, y2); stroke(color, w); };
  const box = (x, y, w, h, color = C, fill = 'rgba(0,0,0,.45)') => { g.fillStyle = fill; g.fillRect(x, y, w, h); g.beginPath(); g.rect(x, y, w, h); stroke(color, 1.2); };
  const blink = (ms = 500) => Math.floor(performance.now() / ms) % 2 === 0;

  // ---------- kare ----------
  // Yerleşim ölçümleri (alt araç çubuğu ve sol alttaki Mission Planner / kayıt kutusu yükseklikleri) 30 karede bir okunur
  const lay = { bar: 54, mp: 0, n: 0 };
  const stats = { ms: 0, n: 0 };
  function frame() {
    raf = 0;
    if (disposed || !visible()) return;
    raf = requestAnimationFrame(frame);
    if (lay.n++ % 30 === 0) {
      const bar = stage.querySelector('.fs-bar'), mp = stage.querySelector('.fs-mp');
      lay.bar = bar ? bar.offsetHeight : 54;
      lay.mp = mp && !mp.hidden ? mp.offsetHeight + 10 : 0;
    }
    const t0 = performance.now();
    draw();
    stats.ms += performance.now() - t0; stats.n++;
  }

  function draw() {
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, W, H);
    C = COLORS[colorIdx][1];
    S = clamp(Math.min(W, H) / 820, 0.72, 1.25);
    F = 12 * S;
    const t = tele || {};
    const pose = ctx.pose || null;
    const roll = num(pose?.roll, num(t.roll, 0)), pitch = num(pose?.pitch, num(t.pitch, 0));
    const yawRad = num(pose?.yaw, num(t.yaw, null));
    const hdg = num(t.heading, yawRad != null ? ((yawRad / DEG) + 360) % 360 : 0);
    const gimbal = num(ctx.gimbalDeg, 0);
    const fov = num(ctx.fov, 78);
    const ppd = H / fov;                                        // piksel / derece (dikey)
    const camPitchDeg = pitch / DEG + gimbal;                   // kamera ekseninin ufka göre açısı
    const cx = W / 2, cy = H / 2 - 10 * S;
    const vn = num(t.vn, 0), ve = num(t.ve, 0), vd = num(t.vd, 0);
    const gs = num(t.groundspeed, Math.hypot(vn, ve)), air = num(t.airspeed, gs);
    const climb = num(t.climb, -vd);
    const agl = num(t.alt_rel, 0), msl = num(t.alt_msl, null);
    const armed = !!t.armed;
    const low = armed && agl < 60 && gs > 3;
    const bandH = H * 0.46;
    const ladderHalfW = Math.min(W * 0.2, 170 * S), ladderHalfH = Math.min(H * 0.26, 220 * S);
    const leftX = cx - ladderHalfW - 56 * S, rightX = cx + ladderHalfW + 56 * S;   // bant iç kenarları

    // --- suni ufuk + pitch merdiveni (roll ile döner; klipsli) ---
    g.save();
    g.beginPath(); g.rect(cx - ladderHalfW, cy - ladderHalfH, ladderHalfW * 2, ladderHalfH * 2); g.clip();
    g.translate(cx, cy); g.rotate(roll);   // ArduPilot roll: sağ kanat aşağı pozitif → ufuk ekranda saat yönü tersine döner (rotate(+roll) ufuk sol aşağı? kontrol: sağa yatışta ufuk sola yükselir → canvas y aşağı, rotate(roll) sol ucu yukarı taşır)
    const lo = Math.floor((camPitchDeg - fov / 2 - 5) / 5) * 5, hi = Math.ceil((camPitchDeg + fov / 2 + 5) / 5) * 5;
    for (let L = Math.max(-90, lo); L <= Math.min(90, hi); L += 5) {
      const y = (camPitchDeg - L) * ppd;
      if (L === 0) { line(-ladderHalfW, y, -34 * S, y, C, 2); line(34 * S, y, ladderHalfW, y, C, 2); continue; }
      if (L === 90 || L === -90) {
        g.beginPath(); g.arc(0, y, 7 * S, 0, Math.PI * 2); stroke(C, 1.4);
        if (L === 90) { g.beginPath(); g.arc(0, y, 2 * S, 0, Math.PI * 2); g.fillStyle = C; g.fill(); } else { line(-5 * S, y - 5 * S, 5 * S, y + 5 * S, C, 1.2); line(-5 * S, y + 5 * S, 5 * S, y - 5 * S, C, 1.2); }
        continue;
      }
      const major = L % 10 === 0, half = (major ? 58 : 34) * S, gap = 30 * S, tick = (L > 0 ? 1 : -1) * 7 * S;
      g.setLineDash(L < 0 ? [6 * S, 4 * S] : []);
      g.beginPath();
      g.moveTo(-half, y); g.lineTo(-gap, y); g.lineTo(-gap, y + tick);
      g.moveTo(half, y); g.lineTo(gap, y); g.lineTo(gap, y + tick);
      stroke(C, 1.4);
      g.setLineDash([]);
      if (major) { text(String(Math.abs(L)), -half - 6 * S, y, { align: 'right', px: F * 0.95 }); text(String(Math.abs(L)), half + 6 * S, y, { align: 'left', px: F * 0.95 }); }
    }
    g.restore();

    // --- roll yayı (üstte; sabit ölçek, hareketli üçgen) ---
    const R = ladderHalfH + 26 * S;
    g.save(); g.translate(cx, cy);
    g.beginPath(); g.arc(0, 0, R, -Math.PI / 2 - 60 * DEG, -Math.PI / 2 + 60 * DEG); stroke(C, 1.2);
    for (const a of [-60, -45, -30, -20, -10, 0, 10, 20, 30, 45, 60]) {
      const len = (a === 0 ? 12 : a % 30 === 0 ? 10 : 6) * S, ang = -Math.PI / 2 + a * DEG;
      line(Math.cos(ang) * R, Math.sin(ang) * R, Math.cos(ang) * (R + len), Math.sin(ang) * (R + len), C, a === 0 ? 2 : 1.2);
    }
    const ra = -Math.PI / 2 - clamp(roll / DEG, -60, 60) * DEG;   // sağa yatış → gösterge sola (gökyüzü işaretçisi)
    g.save(); g.translate(Math.cos(ra) * R, Math.sin(ra) * R); g.rotate(ra + Math.PI / 2);
    g.beginPath(); g.moveTo(0, 0); g.lineTo(-6 * S, -11 * S); g.lineTo(6 * S, -11 * S); g.closePath(); g.fillStyle = C; g.fill(); stroke(C, 1);
    g.restore();
    text(`${Math.abs(roll / DEG) < 0.5 ? '' : roll > 0 ? 'R ' : 'L '}${Math.abs(roll / DEG).toFixed(0)}°`, 0, -R + 16 * S, { align: 'center', px: F * 0.95 });   // yayın içinde (üstteki uyarı kutularıyla çakışmaz)
    g.restore();

    // --- boresight (W işareti, merkez sabit) + hedef kutusu ---
    g.beginPath();
    g.moveTo(cx - 26 * S, cy); g.lineTo(cx - 12 * S, cy); g.lineTo(cx - 6 * S, cy + 8 * S); g.lineTo(cx, cy); g.lineTo(cx + 6 * S, cy + 8 * S); g.lineTo(cx + 12 * S, cy); g.lineTo(cx + 26 * S, cy);
    stroke(C, 2);
    const tb = 36 * S, tl = 10 * S;
    g.beginPath();
    for (const [sx, sy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) { g.moveTo(cx + sx * tb, cy + sy * (tb - tl)); g.lineTo(cx + sx * tb, cy + sy * tb); g.lineTo(cx + sx * (tb - tl), cy + sy * tb); }
    stroke(C, 1.2);

    // --- uçuş yolu vektörü (hız vektörünün yönü; ≥ 1 m/s) ---
    const spd = Math.hypot(vn, ve, vd);
    if (spd >= 1 && yawRad != null) {
      const track = Math.atan2(ve, vn) / DEG;
      const dx = wrap180(track - hdg), gamma = Math.atan2(-vd, Math.hypot(vn, ve)) / DEG;
      // yaklaşık: yatay sapma = iz − yön, dikey = kamera ekseni − uçuş yolu açısı (küçük FOV'da roll etkisi ihmal)
      const fx = cx + dx * ppd, fy = cy + (camPitchDeg - gamma) * ppd;
      const px = clamp(fx, cx - ladderHalfW + 20 * S, cx + ladderHalfW - 20 * S), py = clamp(fy, cy - ladderHalfH + 20 * S, cy + ladderHalfH - 20 * S);
      const r = 9 * S;
      g.beginPath(); g.arc(px, py, r, 0, Math.PI * 2); stroke(C, 1.8);
      line(px - r, py, px - r - 14 * S, py, C, 1.8); line(px + r, py, px + r + 14 * S, py, C, 1.8); line(px, py - r, px, py - r - 9 * S, C, 1.8);
      if (px !== fx || py !== fy) { g.setLineDash([3, 3]); g.beginPath(); g.arc(px, py, r + 4 * S, 0, Math.PI * 2); stroke(C, 1); g.setLineDash([]); }
    }

    // --- heading şeridi (üstte, nav kapsülünün altında) ---
    const hsY = 76 * S + 6, hsH = 30 * S, hsW = Math.min(W * 0.44, 520 * S), hpd = hsW / 70;   // ±35° görünür
    g.save(); g.beginPath(); g.rect(cx - hsW / 2, hsY, hsW, hsH + 2); g.clip();
    g.fillStyle = 'rgba(0,0,0,.28)'; g.fillRect(cx - hsW / 2, hsY, hsW, hsH);
    for (let d = Math.floor((hdg - 40) / 5) * 5; d <= hdg + 40; d += 5) {
      const x = cx + wrap180(d - hdg) * hpd, maj = d % 10 === 0;
      line(x, hsY + hsH, x, hsY + hsH - (maj ? 9 : 5) * S, C, 1.2);
      if (maj) { const n = ((d % 360) + 360) % 360, card = !!CARD[n]; text(CARD[n] || pad2(n / 10), x, hsY + 10 * S, { align: 'center', px: F * (card || n % 30 === 0 ? 0.95 : 0.8), bold: card }); }
    }
    // ev yönü (bearing) işareti şeritte
    const home = t.home && t.home.lat != null ? t.home : null;
    let homeDist = null, homeBrg = null;
    if (home && t.lat != null) {
      const dLat = (home.lat - t.lat) * 110574, dLon = (home.lon - t.lon) * 111320 * Math.cos(t.lat * DEG);
      homeDist = Math.hypot(dLat, dLon); homeBrg = (Math.atan2(dLon, dLat) / DEG + 360) % 360;
      const rel = wrap180(homeBrg - hdg);
      const hx = cx + clamp(rel, -34, 34) * hpd;
      g.beginPath(); g.moveTo(hx, hsY + hsH - 12 * S); g.lineTo(hx - 5 * S, hsY + hsH - 2 * S); g.lineTo(hx + 5 * S, hsY + hsH - 2 * S); g.closePath(); g.fillStyle = Math.abs(rel) > 34 ? 'rgba(0,0,0,.5)' : C; g.fill(); stroke(C, 1);
      text('H', hx, hsY + hsH - 18 * S, { align: 'center', px: F * 0.8 });
    }
    g.restore();
    g.beginPath(); g.rect(cx - hsW / 2, hsY, hsW, hsH); stroke(C, 1.2);
    // merkez üçgen + sayısal yön kutusu
    g.beginPath(); g.moveTo(cx, hsY + hsH + 2); g.lineTo(cx - 6 * S, hsY + hsH + 11 * S); g.lineTo(cx + 6 * S, hsY + hsH + 11 * S); g.closePath(); g.fillStyle = C; g.fill();
    box(cx - 26 * S, hsY - 22 * S, 52 * S, 20 * S);
    text(pad3(hdg), cx, hsY - 12 * S, { align: 'center', px: F * 1.15, bold: true });
    // rüzgâr vektörü (şeridin solunda): ok rüzgârın gövdeye göre akış yönünü gösterir
    const wind = num(ctx.world?.wind_ms, 0), wdir = num(ctx.world?.wind_dir, 0);
    if (wind > 0) {
      const wx = cx - hsW / 2 - 46 * S, wy = hsY + hsH / 2;
      // ok varsayılan aşağı (gövdeye göre arka = 180°) bakar; akış yönü = wdir + 180 ("nereden") → gövdeye göre dönüş = wdir − hdg
      g.save(); g.translate(wx, wy); g.rotate((wdir - hdg) * DEG);
      g.beginPath(); g.moveTo(0, -11 * S); g.lineTo(0, 9 * S); g.moveTo(-5 * S, 3 * S); g.lineTo(0, 9 * S); g.lineTo(5 * S, 3 * S); stroke(C, 1.6);
      g.restore();
      text(`${wind.toFixed(0)}`, wx, wy + 22 * S, { align: 'center', px: F * 0.85 });
      text(`${pad3(wdir)}°`, wx, wy - 20 * S, { align: 'center', px: F * 0.8 });
    }

    // --- sol: hava hızı bandı ---
    const bTop = cy - bandH / 2, bBot = cy + bandH / 2, ppms = bandH / 40;   // ±20 m/s görünür
    const asX = leftX;   // bandın iç (sağ) kenarı
    g.save(); g.beginPath(); g.rect(asX - 90 * S, bTop, 90 * S, bandH); g.clip();
    for (let v = Math.max(0, Math.floor((air - 22) / 2) * 2); v <= air + 22; v += 2) {
      const y = cy - (v - air) * ppms, maj = v % 10 === 0;
      line(asX, y, asX - (maj ? 12 : 6) * S, y, C, 1.2);
      if (maj && Math.abs(v - air) < 18.5) text(String(v), asX - 16 * S, y, { align: 'right', px: F * 0.95 });
    }
    g.restore();
    line(asX, bTop, asX, bBot, C, 1.4);
    box(asX - 66 * S, cy - 15 * S, 62 * S, 30 * S, C, 'rgba(0,0,0,.7)');
    g.beginPath(); g.moveTo(asX - 4 * S, cy); g.lineTo(asX + 4 * S, cy - 5 * S); g.lineTo(asX + 4 * S, cy + 5 * S); g.closePath(); g.fillStyle = C; g.fill();
    text(air.toFixed(air < 10 ? 1 : 0), asX - 10 * S, cy, { align: 'right', px: F * 1.45, bold: true });
    text(`${(air * 3.6).toFixed(0)} km/h`, asX - 6 * S, cy + 27 * S, { align: 'right', px: F * 0.85 });
    text('IAS m/s', asX - 6 * S, bTop - 10 * S, { align: 'right', px: F * 0.85 });
    text(`GS ${gs.toFixed(gs < 10 ? 1 : 0)}`, asX - 6 * S, bBot + 12 * S, { align: 'right', px: F * 0.9 });

    // --- sağ: irtifa bandı (AGL) + dikey hız çubuğu + MSL + radar irtifa ---
    const alX = rightX, ppm = bandH / 120;   // ±60 m görünür
    g.save(); g.beginPath(); g.rect(alX, bTop, 90 * S, bandH); g.clip();
    for (let v = Math.floor((agl - 65) / 5) * 5; v <= agl + 65; v += 5) {
      const y = cy - (v - agl) * ppm, maj = v % 20 === 0;
      line(alX, y, alX + (maj ? 12 : 6) * S, y, C, 1.2);
      if (maj && Math.abs(v - agl) < 56) text(String(v), alX + 16 * S, y, { align: 'left', px: F * 0.95 });
    }
    g.restore();
    line(alX, bTop, alX, bBot, C, 1.4);
    box(alX + 4 * S, cy - 15 * S, 66 * S, 30 * S, C, 'rgba(0,0,0,.7)');
    g.beginPath(); g.moveTo(alX + 4 * S, cy); g.lineTo(alX - 4 * S, cy - 5 * S); g.lineTo(alX - 4 * S, cy + 5 * S); g.closePath(); g.fillStyle = C; g.fill();
    text(agl.toFixed(agl < 10 ? 1 : 0), alX + 10 * S, cy, { align: 'left', px: F * 1.45, bold: true });
    text('AGL m', alX + 6 * S, bTop - 10 * S, { align: 'left', px: F * 0.85 });
    if (msl != null) text(`MSL ${msl.toFixed(0)}`, alX + 6 * S, cy + 27 * S, { align: 'left', px: F * 0.85 });
    // radar irtifa (<60 m kırmızı yanıp söner)
    text(`R ${Math.max(0, agl).toFixed(0)}`, alX + 6 * S, bBot + 12 * S, { align: 'left', px: F * 0.95, color: low ? (blink() ? RED : '#ff9a9a') : C, bold: low });
    // dikey hız: ince çubuk (±10 m/s, kare kök ölçek) + sayı
    const vsX = alX + 82 * S, vsH = bandH * 0.7;
    line(vsX, cy - vsH / 2, vsX, cy + vsH / 2, C, 1.2);
    for (const v of [-10, -5, -2, 0, 2, 5, 10]) { const y = cy - Math.sign(v) * Math.sqrt(Math.abs(v) / 10) * vsH / 2; line(vsX, y, vsX + (v === 0 ? 8 : 5) * S, y, C, 1); }
    const vsY = cy - Math.sign(climb) * Math.sqrt(clamp(Math.abs(climb), 0, 10) / 10) * vsH / 2;
    g.fillStyle = C; g.fillRect(vsX - 3 * S, Math.min(cy, vsY), 6 * S, Math.max(1, Math.abs(vsY - cy)));
    text(`${climb > 0.05 ? '+' : ''}${climb.toFixed(1)}`, vsX + 2 * S, cy - vsH / 2 - 10 * S, { align: 'center', px: F * 0.9 });

    // --- köşe çerçeveleri (crosshair bracket) ---
    const m = 14 * S, cl = 34 * S, bottomLimit = H - lay.bar - 6;   // alt araç çubuğu üstü
    g.beginPath();
    g.moveTo(m, m + cl); g.lineTo(m, m); g.lineTo(m + cl, m);
    g.moveTo(W - m - cl, m); g.lineTo(W - m, m); g.lineTo(W - m, m + cl);
    g.moveTo(m, bottomLimit - cl); g.lineTo(m, bottomLimit); g.lineTo(m + cl, bottomLimit);
    g.moveTo(W - m - cl, bottomLimit); g.lineTo(W - m, bottomLimit); g.lineTo(W - m, bottomLimit - cl);
    stroke(C, 1.6);

    // --- üst sağ: ● REC · CAM 1 · EO · FOV ---
    const rx = W - 22 * S, ry0 = 24 * S;
    if (blink(600)) { g.beginPath(); g.arc(rx - 104 * S, ry0, 5 * S, 0, Math.PI * 2); g.fillStyle = RED; g.fill(); }
    text(ctx.replay ? 'REC ▸ PLAY' : 'REC', rx - 94 * S, ry0, { align: 'left', px: F * 1.05, bold: true });
    text('CAM 1 · EO', rx, ry0 + 20 * S, { align: 'right', px: F * 0.95 });
    text(`FOV ${fov.toFixed(0)}°`, rx, ry0 + 36 * S, { align: 'right', px: F * 0.9 });

    // --- sol alt: mod · ARM/SAFE · G · gaz · batarya · GPS (Mission Planner kutusunun üstünde) ---
    const bars = hudPowerBars(t);   // §23.6: BAT/FUEL metin satırları yerine dikey barlar (blok yüksekliği ≥ 108 px)
    const lx = 22 * S, lh = 17 * S, ly0 = bottomLimit - lay.mp - 14 * S - Math.max(lh * (ctx.launch ? 6 : 5), bars.length ? 108 * S : 0);   // sol alttaki kutunun (MP / kayıt bilgisi) üstünde
    let ly = ly0;
    text(t.mode || '—', lx, ly, { px: F * 1.2, bold: true }); ly += lh * 1.25;
    text(armed ? 'ARM' : 'SAFE', lx, ly, { px: F * 1.05, bold: true, color: armed ? C : '#cfd6cc' }); ly += lh;
    const plane = /sabit_kanat|vtol/.test(String(ctx.session?.type || ''));
    if (plane && armed && air > 5) { const gl = 1 / Math.max(0.2, Math.cos(roll)); text(`G ${gl.toFixed(1)}`, lx, ly, { px: F * 0.95 }); ly += lh; }
    const thr = clamp(num(t.throttle, 0), 0, 100);
    text(`THR ${thr.toFixed(0).padStart(3, ' ')}%`, lx, ly, { px: F * 0.95 });
    g.beginPath(); g.rect(lx + 78 * S, ly - 5 * S, 70 * S, 10 * S); stroke(C, 1); g.fillStyle = C; g.fillRect(lx + 78 * S, ly - 5 * S, 70 * S * thr / 100, 10 * S); ly += lh;
    // §23.6: güç çubukları — sol bloğun sağında iki dikey bar (BAT · FUEL): etiket üstte, 56 px bar (çeyrek çentikler, dolgu alttan), altında % · değer · menzil/süre;
    //        düşük/bitti kırmızı ve dolgu yanıp söner (uyarı kutuları ayrıca üstte). Uyarı mantığı için bp/el_ korunur
    const el_ = t.elec || null, bp = el_ ? num(el_.pct, null) : num(t.batt_pct, null);
    bars.forEach((b, i) => {
      const bx = lx + 176 * S + i * 46 * S, bw = 14 * S, bh = 56 * S, by = ly0 + 8 * S, col = b.low ? RED : C, on = !b.low || blink(600);
      text(b.label, bx + bw / 2, ly0 - 3 * S, { align: 'center', px: F * 0.8, bold: true, color: col });
      box(bx, by, bw, bh, col, 'rgba(0,0,0,.45)');
      const ih = (bh - 4 * S) * b.pct / 100;
      if (on && ih > 0) { g.fillStyle = col; g.fillRect(bx + 2 * S, by + bh - 2 * S - ih, bw - 4 * S, ih); }
      for (const q of [0.25, 0.5, 0.75]) line(bx, by + bh * q, bx + 4 * S, by + bh * q, col, 1);
      text(`${Math.round(b.pct)}%`, bx + bw / 2, by + bh + 10 * S, { align: 'center', px: F * 0.95, bold: true, color: col });
      text(b.l1, bx + bw / 2, by + bh + 23 * S, { align: 'center', px: F * 0.78, color: col });
      if (b.l2) text(b.l2, bx + bw / 2, by + bh + 35 * S, { align: 'center', px: F * 0.78, color: col });
    });
    // GPS fix türü (MAVLink GPS_FIX_TYPE): 6 RTK Fixed (SITL u-blox arka ucu zaten RTK bildirir, §13), 5 RTK Float, 4 DGPS, 3 3D, 2 2D
    const fix = t.gps_fix >= 6 ? 'RTK' : t.gps_fix === 5 ? 'RTK FLT' : t.gps_fix === 4 ? 'DGPS' : t.gps_fix === 3 ? '3D' : t.gps_fix === 2 ? '2D' : '--';
    text(`GPS ${fix} ${t.sats != null ? t.sats + ' SAT' : ''}`, lx, ly, { px: F * 0.95 }); ly += lh;
    if (ctx.launch) text(launchHud(ctx.launch), lx, ly, { px: F * 0.85, color: 'rgba(230,235,230,.75)' });   // kalkış yöntemi (§13): LAUNCH RAMP 15° · 86 km/h

    // --- sağ alt: UTC · T+ · lat/lon · HOME · gimbal ---
    const rxx = W - 22 * S;
    let ry = ly0;
    const nowUtc = ctx.replay && ctx.session?.replay?.start_utc && t.t != null ? new Date(new Date(ctx.session.replay.start_utc).getTime() + t.t * 1000) : new Date();
    text(`${pad2(nowUtc.getUTCHours())}:${pad2(nowUtc.getUTCMinutes())}:${pad2(nowUtc.getUTCSeconds())} Z`, rxx, ry, { align: 'right', px: F * 1.1, bold: true }); ry += lh * 1.2;
    const el = ctx.replay && t.t != null ? t.t : (ctx.t0 ? (Date.now() - ctx.t0) / 1000 : (firstTeleAt ? (Date.now() - firstTeleAt) / 1000 : 0));
    const es = Math.max(0, Math.floor(el));
    text(`T+ ${pad2(Math.floor(es / 3600))}:${pad2(Math.floor(es % 3600 / 60))}:${pad2(es % 60)}`, rxx, ry, { align: 'right', px: F * 0.95 }); ry += lh;
    if (t.lat != null) { text(`${Number(t.lat).toFixed(5)}  ${Number(t.lon).toFixed(5)}`, rxx, ry, { align: 'right', px: F * 0.95 }); ry += lh; }
    if (homeDist != null) { text(`HOME ${homeDist >= 1000 ? (homeDist / 1000).toFixed(1) + ' km' : homeDist.toFixed(0) + ' m'} ${pad3(homeBrg)}°`, rxx, ry, { align: 'right', px: F * 0.95 }); ry += lh; }
    text(`GMB ${gimbal > 0 ? '+' : ''}${gimbal.toFixed(0)}°`, rxx, ry, { align: 'right', px: F * 0.95 }); ry += lh * 1.3;
    // HUD ipucu (sağ alt bloğun altında, küçük)
    text(tr('H: HUD aç/kapa · Shift+H: renk'), rxx, ry, { align: 'right', px: F * 0.78, color: 'rgba(230,235,230,.6)' });

    // --- uyarılar (ortada üstte, kırmızı kutular; dolgu yanıp söner, metin hep okunur) ---
    const warns = [];
    if (ctx.collision) warns.push(tr('ÇARPIŞMA'));
    if (!ctx.replay && armed && (!Array.isArray(t.rc) || !t.rc.length || t.rc.every(v => !v))) warns.push(tr('RC YOK'));
    if (el_?.empty) warns.push(tr('BATARYA BİTTİ')); else if (bp != null && bp < 25) warns.push(tr('BATARYA'));
    if (t.fuel?.empty) warns.push(tr('YAKIT BİTTİ')); else if (t.fuel && num(t.fuel.pct, 100) < 20) warns.push(tr('DÜŞÜK YAKIT'));
    if (!ctx.replay && gcsSeen && t.gcs_connected === false) warns.push(tr('GCS KESİLDİ'));
    if (low) warns.push(tr('ALÇAK'));
    if (warns.length) {
      const on = blink(450), wy = hsY + hsH + 14 * S, bw = 118 * S, gap = 8 * S, total = warns.length * bw + (warns.length - 1) * gap;
      let wx = cx - total / 2;
      for (const w of warns) { box(wx, wy, bw, 24 * S, RED, on ? 'rgba(190,20,20,.9)' : 'rgba(60,0,0,.6)'); text(w, wx + bw / 2, wy + 12 * S, { align: 'center', px: F * 1.05, bold: true, color: on ? '#fff' : RED }); wx += bw + gap; }
    }
    // §22.4 kamera PiP'i: görüntüsü 3B tuvalde (bu katmanın altında) → PiP dikdörtgeni temizlenir, HUD/OSD yazıları PiP'in üstüne binmez
    const pipR = typeof ctx.pipRect === 'function' ? ctx.pipRect() : ctx.pipRect;
    if (pipR && pipR.w > 0) g.clearRect(pipR.x - 2, pipR.y - 2, pipR.w + 4, pipR.h + 4);
  }

  apply();
  canvas.__hud = {
    update, setCamMode, toggle, setEnabled, cycleColor,
    get enabled() { return enabled; },
    get color() { return COLORS[colorIdx][0]; },
    stats: () => ({ drawMs: stats.n ? stats.ms / stats.n : 0, frames: stats.n }),   // ortalama çizim süresi (ms/kare)
    dispose() {
      disposed = true;
      if (raf) cancelAnimationFrame(raf);
      ro.disconnect();
      window.removeEventListener('keydown', onKey);
      stage.classList.remove('fs-mhud-on');
      canvas.remove();
    },
  };
  return canvas.__hud;   // canvas.__hud: tanı/test erişimi (Playwright stats())
}
