// Uçuş Simülatörü — KARA ARACI GÖSTERGESİ (docs/ucus-simulatoru.md §31; HEPGO + SIMUMAV ortak). Uçak HUD'ı (flightsim_hud.js, gimbal kamerası 'fpv') ve
// FPV OSD (flightsim_fpv_osd.js, 'pilot' = kara aracında KOKPİT) rover oturumunda bu katmanı döndürür (aynı arayüz; kayıt birleşimi için tuval sınıfı
// .fs-mhud / .fs-osd ve sahne sınıfı fs-mhud-on / fs-osd-on korunur).
// Öğeler (irtifa / dikey hız / ufuk merdiveni YOK — kara aracında anlamsız):
//   • alt orta: büyük dijital hız (km/h) + vites (P/N/D/R) + direksiyon yayı (teker açısı) · solda GAZ / FREN dikey çubukları
//   • üst orta: pusula şeridi (10° çentik, ana yönler, EV yönü işareti) · sağda EĞİM (yandan araç silueti, ° ve %) + YATIŞ (arkadan silüet);
//     |eğim| > 25° ya da |yatış| > 20° → kırmızı "DEVRİLME RİSKİ" · sol üst: kip + HAZIR/EMNİYETTE, batarya / yakıt · sağ üst: EV mesafesi, GPS, saat
//   • gimbal kamerası ('fpv'): ortada nişangâh + "CAM · EO" ve gimbal açısı; kokpitte ('pilot') nişangâh yok.
// Veri: update(tele) — canlı `tele` ya da kayıt karesi; ctx: { session, pose (3B'nin zemine oturttuğu pitch/roll), gimbalDeg, collision, replay, t0, pipRect }.
// Dışa: createRoverHud(stage, ctx, { tr, keyed, cam: 'fpv' | 'pilot', key: 'h' | 'o', lsKey }) → { update, setCamMode, toggle, setEnabled, setAnalog, cycleColor,
//   enabled, analog, stats(), dispose() }.
import { compass8, makeRoverT, roverDash, roverKinematics } from './flightsim_rover.js';

const DEG = Math.PI / 180;
const num = (v, d = null) => (v == null || Number.isNaN(Number(v)) ? d : Number(v));
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const pad2 = v => String(v).padStart(2, '0');
const RED = '#ff4d4d', ACC = '#38d4ff', WHITE = '#f4f7fa', GREEN = '#46e08a', AMBER = '#ffc04d';
const TILT_PITCH = 25, TILT_ROLL = 20;   // ° — devrilme riski uyarısı

/** Ev mesafesi (m) ve kerterizi (°) — saf. */
export function homeVector(t) {
  const h = t?.home;
  if (!h || h.lat == null || t?.lat == null) return null;
  const dN = (num(h.lat) - num(t.lat)) * 110574, dE = (num(h.lon) - num(t.lon)) * 111320 * Math.cos(num(t.lat) * DEG);
  return { dist: Math.hypot(dN, dE), bearing: ((Math.atan2(dE, dN) / DEG) + 360) % 360 };
}
/** Devrilme riski — saf: eğim/yatış eşikleri. */
export const tiltRisk = (pitchDeg, rollDeg) => Math.abs(num(pitchDeg, 0)) > TILT_PITCH || Math.abs(num(rollDeg, 0)) > TILT_ROLL;

export function createRoverHud(stage, ctx = {}, { tr = s => s, keyed = 'auto', cam = 'pilot', key = 'o', lsKey = null } = {}) {
  const T = makeRoverT(tr, keyed);
  const canvas = document.createElement('canvas');
  canvas.className = cam === 'fpv' ? 'fs-mhud fs-rover-hud' : 'fs-osd fs-rover-hud';
  canvas.hidden = true;
  stage.appendChild(canvas);
  const g = canvas.getContext('2d');
  const LS = lsKey || (cam === 'fpv' ? 'fs.mhud.on' : 'fs.fpv.osd');
  const onCls = cam === 'fpv' ? 'fs-mhud-on' : 'fs-osd-on';
  let enabled = (() => { try { return localStorage.getItem(LS) !== '0'; } catch { return true; } })();
  let camMode = 'follow', tele = null, raf = 0, disposed = false, W = 0, H = 0, dpr = 1, firstTeleAt = 0, analog = false;
  const stats = { n: 0, ms: 0 };
  // Yerleşim (30 karede bir): üst gezinti kapsülünün altı, alt araç çubuğunun üstü, sol alttaki MP/kayıt kutusu (çakışmasın)
  const lay = { top: 0, bar: 64, mpRight: 0, n: 0 };
  const measure = () => {
    const sr = stage.getBoundingClientRect();
    const nav = stage.querySelector('.fs-nav, .sm-fly-top'), bar = stage.querySelector('.fs-bar');
    lay.top = nav && nav.offsetParent ? Math.max(0, Math.round(nav.getBoundingClientRect().bottom - sr.top)) : 0;
    lay.bar = bar && bar.offsetParent ? Math.max(0, Math.round(sr.bottom - bar.getBoundingClientRect().top)) : 64;
    lay.mpRight = 0;
    for (const e of stage.querySelectorAll('.fs-mp, .fs-pn-mp-float, .fs-site-dock')) {
      if (e.hidden || !e.offsetParent || getComputedStyle(e).display === 'none') continue;
      const r = e.getBoundingClientRect();
      if (r.width >= 1 && r.left - sr.left < sr.width / 3 && r.bottom > sr.bottom - lay.bar - 180) lay.mpRight = Math.max(lay.mpRight, Math.round(r.right - sr.left));
    }
  };
  const visible = () => enabled && camMode === cam;
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
    stage.classList.toggle(onCls, on);
    if (on && !raf) raf = requestAnimationFrame(frame);
    if (!on && raf) { cancelAnimationFrame(raf); raf = 0; }
  };
  const setCamMode = m => { camMode = m; apply(); };
  const setEnabled = v => { enabled = !!v; try { localStorage.setItem(LS, enabled ? '1' : '0'); } catch { /* yok */ } apply(); };
  const toggle = () => setEnabled(!enabled);
  const update = t => { if (t) { tele = t; if (!firstTeleAt) firstTeleAt = Date.now(); } };
  const editable = el => el && (/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || el.isContentEditable);
  const onKey = e => {
    if (disposed || camMode !== cam || editable(document.activeElement) || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
    if (e.key.toLowerCase() === key) { toggle(); e.preventDefault(); }
  };
  window.addEventListener('keydown', onKey);

  // ---------- çizim yardımcıları ----------
  let F = 13, S = 1;
  const font = (px, bold) => { g.font = `${bold ? '700 ' : '500 '}${Math.round(px)}px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace`; };
  const text = (s, x, y, { px = F, align = 'left', base = 'middle', color = WHITE, bold = false } = {}) => {
    font(px, bold); g.textAlign = align; g.textBaseline = base;
    g.lineWidth = Math.max(2.5, px * 0.2); g.strokeStyle = 'rgba(0,0,0,.85)'; g.lineJoin = 'round'; g.strokeText(s, x, y);
    g.fillStyle = color; g.fillText(s, x, y);
  };
  const panel = (x, y, w, h, r = 10) => {
    g.beginPath(); g.roundRect ? g.roundRect(x, y, w, h, r) : g.rect(x, y, w, h);
    g.fillStyle = 'rgba(8,14,22,.55)'; g.fill(); g.lineWidth = 1; g.strokeStyle = 'rgba(255,255,255,.14)'; g.stroke();
  };
  const blink = ms => Math.floor(performance.now() / ms) % 2 === 0;

  // Araç silüeti (yandan / arkadan) — eğim/yatış göstergesi
  const sideCar = (cx, cy, s, ang, col) => {
    g.save(); g.translate(cx, cy); g.rotate(-ang);
    g.fillStyle = col; g.strokeStyle = 'rgba(0,0,0,.8)'; g.lineWidth = 1.5;
    g.beginPath(); g.moveTo(-s, 0); g.lineTo(-s, -s * 0.38); g.lineTo(-s * 0.45, -s * 0.42); g.lineTo(-s * 0.2, -s * 0.75); g.lineTo(s * 0.45, -s * 0.75);
    g.lineTo(s * 0.75, -s * 0.42); g.lineTo(s, -s * 0.36); g.lineTo(s, 0); g.closePath(); g.fill(); g.stroke();
    for (const wx of [-s * 0.6, s * 0.6]) { g.beginPath(); g.arc(wx, 0, s * 0.24, 0, Math.PI * 2); g.fillStyle = '#111'; g.fill(); g.strokeStyle = col; g.stroke(); }
    g.restore();
  };
  const rearCar = (cx, cy, s, ang, col) => {
    g.save(); g.translate(cx, cy); g.rotate(ang);
    g.fillStyle = col; g.strokeStyle = 'rgba(0,0,0,.8)'; g.lineWidth = 1.5;
    g.beginPath(); g.moveTo(-s * 0.8, 0); g.lineTo(-s * 0.8, -s * 0.45); g.lineTo(-s * 0.5, -s * 0.9); g.lineTo(s * 0.5, -s * 0.9); g.lineTo(s * 0.8, -s * 0.45); g.lineTo(s * 0.8, 0); g.closePath(); g.fill(); g.stroke();
    for (const wx of [-s * 0.68, s * 0.68]) { g.fillStyle = '#111'; g.fillRect(wx - s * 0.14, -s * 0.12, s * 0.28, s * 0.36); }
    g.restore();
  };

  function frame(now) {
    raf = 0;
    if (disposed || !visible()) return;
    raf = requestAnimationFrame(frame);
    if (lay.n++ % 30 === 0) measure();
    const t0 = performance.now();
    draw();
    stats.n++; stats.ms += performance.now() - t0;
  }
  function draw() {
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, W, H);
    const t = tele;
    if (!t) return;
    S = clamp(Math.min(W / 1280, H / 760), 0.7, 1.6); F = 13 * S;
    const drive = ctx.session?.drive || 'ackermann';
    const pose = ctx.pose || null;
    const kin = roverKinematics(t, { drive });
    const d = roverDash(t, { pose, drive, kin });
    const barBottom = H - lay.bar - 12 * S;   // alt araç çubuğunun üstü
    const cx = W / 2;

    // --- üst orta: pusula şeridi ---
    const tw = Math.min(560 * S, W * 0.6), th = 34 * S, tx = cx - tw / 2, ty = lay.top + 10 * S;   // gezinti kapsülünün altında
    panel(tx, ty, tw, th, 8 * S);
    const pxPerDeg = tw / 120;
    g.save(); g.beginPath(); g.rect(tx, ty, tw, th); g.clip();
    for (let a = Math.floor((d.hdg - 60) / 5) * 5; a <= d.hdg + 60; a += 5) {
      const x = cx + (a - d.hdg) * pxPerDeg, aa = ((a % 360) + 360) % 360, major = aa % 10 === 0;
      g.strokeStyle = 'rgba(255,255,255,.75)'; g.lineWidth = 1; g.beginPath(); g.moveTo(x, ty + th); g.lineTo(x, ty + th - (major ? 9 : 5) * S); g.stroke();
      if (aa % 30 === 0) { const L = { 0: 'N', 90: 'E', 180: 'S', 270: 'W', 45: 'NE', 135: 'SE', 225: 'SW', 315: 'NW' }[aa]; text(L || String(aa), x, ty + 12 * S, { px: F * (L && L.length === 1 ? 1.05 : 0.85), align: 'center', bold: !!L, color: L ? ACC : WHITE }); }
    }
    const hv = homeVector(t);
    if (hv) {
      let dd = ((hv.bearing - d.hdg + 540) % 360) - 180; dd = clamp(dd, -58, 58);
      const x = cx + dd * pxPerDeg; g.fillStyle = AMBER; g.beginPath(); g.moveTo(x, ty + th - 2); g.lineTo(x - 5 * S, ty + th - 11 * S); g.lineTo(x + 5 * S, ty + th - 11 * S); g.closePath(); g.fill();
    }
    g.restore();
    g.fillStyle = WHITE; g.beginPath(); g.moveTo(cx, ty + th + 1); g.lineTo(cx - 7 * S, ty + th + 10 * S); g.lineTo(cx + 7 * S, ty + th + 10 * S); g.closePath(); g.fill();
    text(`${String(Math.round(d.hdg) % 360).padStart(3, '0')}° ${compass8(d.hdg)}`, cx, ty + th + 22 * S, { px: F * 1.05, align: 'center', bold: true });

    // --- sol üst: kip + durum + enerji ---
    panel(14 * S, 14 * S, 210 * S, 92 * S, 8 * S);
    text(d.mode, 26 * S, 32 * S, { px: F * 1.35, bold: true, color: ACC });
    text(d.armed ? T('rover.armed') : T('rover.safe'), 26 * S, 54 * S, { px: F, bold: true, color: d.armed ? GREEN : '#cfd6cc' });
    const e = t.elec || null, bp = e ? num(e.pct, null) : num(t.batt_pct, null);
    const bar = (y, label, pct, col, txt) => {
      text(label, 26 * S, y, { px: F * 0.8, color: '#b9c3cc' });
      const bx = 96 * S, bw = 116 * S; g.fillStyle = 'rgba(255,255,255,.12)'; g.fillRect(bx, y - 5 * S, bw, 10 * S);
      g.fillStyle = col; g.fillRect(bx, y - 5 * S, bw * clamp(pct ?? 0, 0, 100) / 100, 10 * S);
      if (txt) text(txt, bx + bw - 2 * S, y, { px: F * 0.72, align: 'right', bold: true });
    };
    if (bp != null) bar(74 * S, T('rover.batt'), bp, bp < 25 ? RED : GREEN, `${Math.round(bp)}%`);
    if (t.fuel) bar(92 * S, T('rover.fuel'), num(t.fuel.pct, 0), num(t.fuel.pct, 100) < 20 ? RED : AMBER, `${num(t.fuel.l, 0).toFixed(1)}L`);

    // --- sağ üst: EV, GPS, saat ---
    const rx = W - 14 * S, rw = 200 * S;
    panel(rx - rw, 14 * S, rw, 74 * S, 8 * S);
    const nowUtc = new Date();
    text(`${pad2(nowUtc.getUTCHours())}:${pad2(nowUtc.getUTCMinutes())}:${pad2(nowUtc.getUTCSeconds())} Z`, rx - 12 * S, 30 * S, { px: F * 1.05, align: 'right', bold: true });
    if (hv) text(`${T('rover.home')} ${hv.dist >= 1000 ? (hv.dist / 1000).toFixed(2) + ' km' : Math.round(hv.dist) + ' m'} · ${String(Math.round(hv.bearing)).padStart(3, '0')}°`, rx - 12 * S, 50 * S, { px: F * 0.9, align: 'right' });
    const fix = t.gps_fix >= 6 ? 'RTK' : t.gps_fix === 5 ? 'RTK FLT' : t.gps_fix >= 3 ? '3D' : t.gps_fix === 2 ? '2D' : '--';
    text(`GPS ${fix}${t.sats != null ? ' · ' + t.sats + ' SAT' : ''}`, rx - 12 * S, 68 * S, { px: F * 0.85, align: 'right', color: '#b9c3cc' });

    // --- sağ: eğim + yatış (inklinometre) ---
    const risk = tiltRisk(d.pitchDeg, d.rollDeg);
    const iw = 170 * S, ih = 196 * S, ix = W - 14 * S - iw, iy = Math.max(100 * S, lay.top + 10 * S);
    panel(ix, iy, iw, ih, 10 * S);
    const pc = Math.abs(d.pitchDeg) > TILT_PITCH ? RED : Math.abs(d.pitchDeg) > TILT_PITCH * 0.6 ? AMBER : WHITE;
    const rc = Math.abs(d.rollDeg) > TILT_ROLL ? RED : Math.abs(d.rollDeg) > TILT_ROLL * 0.6 ? AMBER : WHITE;
    text(T('rover.grade'), ix + 12 * S, iy + 16 * S, { px: F * 0.8, color: '#b9c3cc', bold: true });
    g.strokeStyle = 'rgba(255,255,255,.25)'; g.beginPath(); g.moveTo(ix + 14 * S, iy + 62 * S); g.lineTo(ix + iw - 14 * S, iy + 62 * S); g.stroke();
    sideCar(ix + iw * 0.36, iy + 60 * S, 30 * S, d.pitchDeg * DEG, pc);
    text(`${d.pitchDeg >= 0 ? '+' : ''}${d.pitchDeg.toFixed(1)}°`, ix + iw - 12 * S, iy + 40 * S, { px: F * 1.2, align: 'right', bold: true, color: pc });
    text(`${d.gradePct >= 0 ? '+' : ''}${Math.round(d.gradePct)}%`, ix + iw - 12 * S, iy + 60 * S, { px: F * 0.85, align: 'right', color: pc });
    text(T('rover.roll'), ix + 12 * S, iy + 106 * S, { px: F * 0.8, color: '#b9c3cc', bold: true });
    g.strokeStyle = 'rgba(255,255,255,.25)'; g.beginPath(); g.moveTo(ix + 14 * S, iy + 160 * S); g.lineTo(ix + iw - 14 * S, iy + 160 * S); g.stroke();
    rearCar(ix + iw * 0.36, iy + 158 * S, 30 * S, d.rollDeg * DEG, rc);
    text(`${d.rollDeg >= 0 ? '+' : ''}${d.rollDeg.toFixed(1)}°`, ix + iw - 12 * S, iy + 136 * S, { px: F * 1.2, align: 'right', bold: true, color: rc });
    if (risk) {
      const on = blink(420), ww = 170 * S, wy = ty + th + 34 * S;
      g.fillStyle = on ? 'rgba(200,20,20,.9)' : 'rgba(60,0,0,.65)'; g.fillRect(cx - ww / 2, wy, ww, 26 * S);
      text(T('rover.tilt'), cx, wy + 13 * S, { px: F * 1.05, align: 'center', bold: true, color: on ? '#fff' : RED });
    }

    // --- alt orta: hız + vites + direksiyon ---
    const sw = 300 * S, sh = 116 * S, sx = cx - sw / 2, sy = barBottom - sh;
    panel(sx, sy, sw, sh, 14 * S);
    text(String(Math.round(d.kmh)), cx - 18 * S, sy + 52 * S, { px: 52 * S, align: 'right', bold: true });
    text('km/h', cx - 12 * S, sy + 64 * S, { px: F * 0.95, color: '#b9c3cc' });
    const gearCol = d.gear === 'R' ? AMBER : d.gear === 'D' ? GREEN : '#cfd6cc';
    g.lineWidth = 2; g.strokeStyle = gearCol; g.strokeRect(cx + 54 * S, sy + 22 * S, 40 * S, 40 * S);
    text(d.gear, cx + 74 * S, sy + 43 * S, { px: 28 * S, align: 'center', bold: true, color: gearCol });
    text(T('rover.gear'), cx + 74 * S, sy + 72 * S, { px: F * 0.7, align: 'center', color: '#b9c3cc' });
    // hız ölçeği çubuğu (azami 72 / 14 km/h)
    const vb = clamp(d.kmh / d.maxKmh, 0, 1);
    g.fillStyle = 'rgba(255,255,255,.12)'; g.fillRect(sx + 18 * S, sy + 84 * S, sw - 36 * S, 5 * S);
    g.fillStyle = vb > 0.9 ? RED : ACC; g.fillRect(sx + 18 * S, sy + 84 * S, (sw - 36 * S) * vb, 5 * S);
    // direksiyon yayı (−35°…+35°)
    const steer = clamp(d.steerDeg / 35, -1, 1), ay = sy + sh - 10 * S;
    g.strokeStyle = 'rgba(255,255,255,.3)'; g.lineWidth = 3 * S; g.beginPath(); g.arc(cx, ay + 70 * S, 78 * S, -Math.PI / 2 - 0.35, -Math.PI / 2 + 0.35); g.stroke();
    g.strokeStyle = ACC; g.beginPath();
    if (Math.abs(steer) > 0.01) g.arc(cx, ay + 70 * S, 78 * S, -Math.PI / 2 + Math.min(0, steer * 0.35), -Math.PI / 2 + Math.max(0, steer * 0.35)); g.stroke();
    const sa = -Math.PI / 2 + steer * 0.35; g.fillStyle = WHITE; g.beginPath(); g.arc(cx + Math.cos(sa) * 78 * S, ay + 70 * S + Math.sin(sa) * 78 * S, 4 * S, 0, Math.PI * 2); g.fill();
    text(`${T('rover.steer')} ${d.steerDeg >= 0 ? '+' : ''}${Math.round(d.steerDeg)}°`, sx + sw - 12 * S, sy + 14 * S, { px: F * 0.72, align: 'right', color: '#b9c3cc' });

    // --- sol alt: GAZ / FREN çubukları ---
    const gx = sx - 74 * S, gh = sh;
    panel(gx, sy, 62 * S, gh, 10 * S);
    const vbar = (x, pct, col, label) => {
      const bh = gh - 40 * S, by = sy + 12 * S;
      g.fillStyle = 'rgba(255,255,255,.12)'; g.fillRect(x, by, 14 * S, bh);
      g.fillStyle = col; g.fillRect(x, by + bh * (1 - pct / 100), 14 * S, bh * pct / 100);
      text(label, x + 7 * S, sy + gh - 14 * S, { px: F * 0.62, align: 'center', bold: true, color: col });
    };
    vbar(gx + 10 * S, d.thrPct, GREEN, T('rover.thr'));
    vbar(gx + 38 * S, d.brakePct, RED, T('rover.brake'));

    // --- gimbal (sensör) kamerası: nişangâh + kamera satırı ---
    if (cam === 'fpv') {
      const r = 18 * S, cy = H / 2;
      g.strokeStyle = 'rgba(255,255,255,.85)'; g.lineWidth = 1.5;
      g.beginPath(); g.moveTo(cx - r * 2, cy); g.lineTo(cx - r * 0.6, cy); g.moveTo(cx + r * 0.6, cy); g.lineTo(cx + r * 2, cy);
      g.moveTo(cx, cy - r * 2); g.lineTo(cx, cy - r * 0.6); g.moveTo(cx, cy + r * 0.6); g.lineTo(cx, cy + r * 2); g.stroke();
      const gd = num(ctx.gimbalDeg, 0);
      text(`CAM · EO · GMB ${gd > 0 ? '+' : ''}${Math.round(gd)}°`, W - 26 * S, iy + ih + 18 * S, { px: F * 0.85, align: 'right' });
    }
    // uyarılar
    const warns = [];
    if (ctx.collision) warns.push(tr('ÇARPIŞMA'));
    if (e?.empty) warns.push(tr('BATARYA BİTTİ'));
    if (t.fuel?.empty) warns.push(tr('YAKIT BİTTİ'));
    if (warns.length) {
      const on = blink(450), wy = ty + th + (risk ? 66 : 34) * S, bw = 130 * S, gap = 8 * S, tot = warns.length * bw + (warns.length - 1) * gap;
      let wx = cx - tot / 2;
      for (const w of warns) { g.fillStyle = on ? 'rgba(190,20,20,.9)' : 'rgba(60,0,0,.6)'; g.fillRect(wx, wy, bw, 24 * S); text(w, wx + bw / 2, wy + 12 * S, { px: F, align: 'center', bold: true, color: on ? '#fff' : RED }); wx += bw + gap; }
    }
    text(T('rover.hint').replace('H', key.toUpperCase()), W - 26 * S, barBottom - 8 * S, { px: F * 0.72, align: 'right', color: 'rgba(230,235,240,.6)' });
    const pipR = typeof ctx.pipRect === 'function' ? ctx.pipRect() : ctx.pipRect;
    if (pipR && pipR.w > 0) g.clearRect(pipR.x - 2, pipR.y - 2, pipR.w + 4, pipR.h + 4);
  }
  apply();
  const api = {
    update, setCamMode, toggle, setEnabled, setAnalog: v => { analog = !!v; }, cycleColor: () => {}, rover: true,
    get enabled() { return enabled; }, get analog() { return analog; }, get color() { return 'white'; },
    stats: () => ({ drawMs: stats.n ? stats.ms / stats.n : 0, frames: stats.n }),
    targets: () => null,
    dispose() {
      disposed = true;
      if (raf) cancelAnimationFrame(raf);
      ro.disconnect();
      window.removeEventListener('keydown', onKey);
      stage.classList.remove(onCls);
      canvas.remove();
    },
  };
  canvas[cam === 'fpv' ? '__hud' : '__osd'] = api;
  return api;
}
