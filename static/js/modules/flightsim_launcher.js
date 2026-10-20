// Uçuş Simülatörü §27 — INTERCEPTOR FIRLATICILARI: SAF mantık (three.js yok, DOM yok; Node testi tests/test_flightsim_launcher.mjs).
// Kullanıcı isteği: "INTERCEPTOR içinde fırlatıcı olarak 4'lü, 8'li, yerden tekli, pilot elindeki bir silah benzeri aparattan çıkmalı; eğer böyle bir
// aparatı seçerse aparatın üstünde küçük bir ekran olmalı, ekranda havaya doğru havadaki hedefleri görmeli."
//
// Yöntemler (world.launch.method; sunucu eşleniği app/flightsim_launcher.py — sabitler ve aimWaypoint birebir, vektör testi):
//   pod4     — 4 hücreli kutu fırlatıcı (2×2 dikey hücre, üst kapaklar)       · loaded: dolu hücre 1–4
//   pod8     — 8 hücreli kutu fırlatıcı (4×2)                                 · loaded: dolu hücre 1–8
//   tube     — yerden tekli fırlatma tüpü (üç ayaklı sehpa, dikey)
//   handheld — pilotun elindeki silah benzeri el fırlatıcısı (omuz tüpü + nişangâh ekranı); aim_az_deg / aim_el_deg nişan yönü
// Hücre/tüp dikeydir (tailsitter kuyruk üstünde; SITL'de de yerde pitch 90°). El aparatında tüp nişan açısındadır; SITL dikey kalkar
// (NAV_TAKEOFF HAND_CLIMB_M) ve hemen nişan doğrultusundaki noktaya (aimWaypoint) yönelir → interceptor nişan yönünde çıkar.
// Ölçüler GERÇEK metre (3B'de dron gibi MODEL_SCALE ile büyütülür); yerel çerçeve flightsim3d ile aynı: +Y ileri (pist yönü), +X sağ, +Z yukarı.

export const ICEPT_LAUNCHERS = {
  pod4: { cells: 4, cols: 2, rows: 2 },
  pod8: { cells: 8, cols: 4, rows: 2 },
  tube: { cells: 1, cols: 1, rows: 1 },
  handheld: { cells: 1, cols: 1, rows: 1, aim: true },
};
export const ICEPT_METHODS = Object.keys(ICEPT_LAUNCHERS);
export const isIceptLauncher = m => Object.prototype.hasOwnProperty.call(ICEPT_LAUNCHERS, m);
export const cellCount = m => ICEPT_LAUNCHERS[m]?.cells || 0;
// Nişan sınırları (derece): azimut gerçek kuzeyden saat yönü 0…359; yükseliş 10…85 (omuzdan daha dik nişan anatomik değil; dikey için tüp/kutu)
export const AIM_LIMITS = { az: [0, 359], el: [10, 85] };
export const AIM_DEFAULTS = { az: 0, el: 55 };
export const HAND_CLIMB_M = 8;        // el fırlatıcısı: SITL dikey kalkış irtifası (m), ardından nişan noktasına yönelir
export const AIM_PATH_M = 500;        // nişan noktası: nişan doğrultusunda yol boyu (m)
export const AIM_ALT = [30, 350];     // nişan noktası irtifası sınırı (m, eve göre)
export const AIM_MIN_H = 120;         // nişan noktası en az yatay uzaklık (m; sabit kanat geçişi için yer)
export const CELL = { inner: 0.5, pitch: 0.62, depth: 0.55, wall: 0.05, base: 0.32 };   // hücre iç genişlik, hücre aralığı, derinlik, duvar, kaide yüksekliği (varsayılan)
/**
 * Hücre/tüp ölçüleri dronun GERÇEK boyutuna göre (kanister drona göre yapılır): fit = { span (m; kanat/pervane açıklığı), length (m; burun–kuyruk) }.
 * Hücre iç genişliği açıklığın ~%112'si (0,26–0,62 m), derinlik boyun %92'si (burun ağız hizasında görünür), tüp yarıçapı açıklığın ~%60'ı.
 */
export function cellDims(fit) {
  const span = Number(fit?.span) > 0 ? Number(fit.span) : 0.45, len = Number(fit?.length) > 0 ? Number(fit.length) : 0.45;
  const inner = clamp(span * 1.12 + 0.04, 0.26, 0.62);
  return { inner, pitch: inner + 0.12, depth: clamp(len * 0.92, 0.2, 0.62), wall: 0.05, base: 0.32,
    tubeR: clamp(span * 0.6 + 0.03, 0.15, 0.32), tubeL: clamp(len * 1.05, 0.3, 0.75),
    handR: clamp(span * 0.58 + 0.03, 0.14, 0.3), handL: clamp(len * 1.12, 0.36, 0.8) };
}
export const BANK_GAP = 0.6;          // görevde yan yana fırlatıcılar arası boşluk (gerçek m)
const DEG = Math.PI / 180;
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

/** Nişan normalize: az 0…360'a sarılır (359'a kırpılmaz — 359,5 → 359,5), el [10, 85]'e kırpılır; geçersiz → varsayılan. */
export function normAim(az, el) {
  const num = v => (v == null || v === '' ? NaN : Number(v));
  let a = num(az), e = num(el);
  if (!Number.isFinite(a)) a = AIM_DEFAULTS.az;
  if (!Number.isFinite(e)) e = AIM_DEFAULTS.el;
  a = ((a % 360) + 360) % 360;
  return { az: a, el: clamp(e, AIM_LIMITS.el[0], AIM_LIMITS.el[1]) };
}
/** Nişan birim vektörü ENU [doğu, kuzey, yukarı]. */
export function aimVector(azDeg, elDeg) {
  const a = azDeg * DEG, e = elDeg * DEG;
  return [Math.sin(a) * Math.cos(e), Math.cos(a) * Math.cos(e), Math.sin(e)];
}
/** Nişan noktası (eve göre): yol boyu AIM_PATH_M ışın üzerinde; irtifa [30, 350] m, yatay ≥ 120 m (kırpılınca ışından sapar). Python aim_noktasi ile birebir. */
export function aimWaypoint(azDeg, elDeg) {
  const { az, el } = normAim(azDeg, elDeg);
  const alt = clamp(AIM_PATH_M * Math.sin(el * DEG), AIM_ALT[0], AIM_ALT[1]);
  const hz = Math.max(AIM_MIN_H, alt / Math.tan(el * DEG));
  return { east_m: +(hz * Math.sin(az * DEG)).toFixed(2), north_m: +(hz * Math.cos(az * DEG)).toFixed(2), alt_m: +alt.toFixed(2), horiz_m: +hz.toFixed(2) };
}
/** Bir noktadan hedefe nişan (az, el; derece) — "hedefe yönel" ve test. */
export function aimAt(from, to) {
  const dx = to[0] - from[0], dy = to[1] - from[1], dz = to[2] - from[2];
  const az = ((Math.atan2(dx, dy) / DEG) + 360) % 360, el = Math.atan2(dz, Math.hypot(dx, dy)) / DEG;
  return { az, el, range: Math.hypot(dx, dy, dz) };
}
/** Hız denetimli nişan adımı (klavye / sanal kumanda / basılı düğme): input {az: −1…1, el: −1…1}; hız az 50°/sn, el 35°/sn (fine: ÷4). */
export function aimStep(aim, input, dt, fine = false) {
  const k = fine ? 0.25 : 1;
  return normAim(aim.az + clamp(Number(input?.az) || 0, -1, 1) * 50 * k * dt, aim.el + clamp(Number(input?.el) || 0, -1, 1) * 35 * k * dt);
}
/** Sürükleme ile nişan (ekran pikseli → derece; görüş alanına göre "dokunduğun yer gelsin"): dx sağa → az artar, dy yukarı (negatif) → el artar. */
export function aimDrag(aim, dxPx, dyPx, hPx, fovDeg) {
  const degPerPx = fovDeg / Math.max(1, hPx);
  return normAim(aim.az + dxPx * degPerPx, aim.el - dyPx * degPerPx);
}

// ---------- hücre yerleşimi ve envanter ----------
/** Tek fırlatıcının hücre merkezleri (yerel, fırlatıcı merkezine göre; m). Sıra: arka sıra soldan sağa, sonra ön sıra (ateşleme sırası). */
export function cellLayout(method, dims = CELL) {
  const d = ICEPT_LAUNCHERS[method];
  if (!d) return [];
  const out = [];
  for (let r = 0; r < d.rows; r++) for (let c = 0; c < d.cols; c++) out.push({ x: (c - (d.cols - 1) / 2) * dims.pitch, y: ((d.rows - 1) / 2 - r) * dims.pitch });
  return out;
}
/** Fırlatıcı ayak izi (gerçek m): [genişlik X, derinlik Y]. */
export function launcherSize(method, dims = CELL) {
  const d = ICEPT_LAUNCHERS[method];
  if (!d) return [0, 0];
  if (method === 'tube') return [1.1, 1.1];
  if (method === 'handheld') return [0.8, 0.8];
  return [d.cols * dims.pitch + 0.14, d.rows * dims.pitch + 0.14];
}
/** Görev envanteri için fırlatıcı sayısı: kutu fırlatıcılarda ⌈toplam / hücre⌉ (son kutu kısmen dolu); tüp/el tek fırlatıcı (yeniden doldurulur). */
export function launcherCount(method, total) {
  if (method === 'pod4' || method === 'pod8') return Math.max(1, Math.ceil(Math.max(1, Math.round(Number(total) || 1)) / cellCount(method)));
  return isIceptLauncher(method) ? 1 : 0;
}
/** Yan yana fırlatıcı merkezleri (yerel X ekseninde; grup merkezi = 0 → aktif hücrenin SITL evine en çok yarım sıra uzaklığı). */
export function bankLayout(method, n, dims = CELL) {
  const w = launcherSize(method, dims)[0] + BANK_GAP, out = [];
  for (let i = 0; i < n; i++) out.push({ x: (i - (n - 1) / 2) * w, y: 0 });
  return out;
}
/** Görevde 10'lu raf: kutu fırlatıcılarında raf YOK (envanter kutularda); tüp/el: raf yedek deposu (toplam − 1 yüklü). Görev yoksa 0. */
export const rackCountFor = (method, defendTotal) => (!defendTotal ? 0 : (method === 'pod4' || method === 'pod8') ? 0 : Math.max(0, Math.round(defendTotal)));
export const usesRack = method => !(method === 'pod4' || method === 'pod8');
/**
 * Hücre durumları. inv: { total (dolu hücre/envanter), used (1 tabanlı: etkin interceptor sırası; §26 icept.used), phase? }.
 * Dönüş: { launchers: n, cells: [[durum…] fırlatıcı başına], active: {l, c} | null, loaded, spent, empty }.
 * Durum: 'spent' (ateşlendi, kapak açık, boş) · 'active' (sıradaki/şu anki interceptor; kapak açık, dron hücrede) · 'loaded' (dolu, kapak kapalı) · 'empty' (yüklenmemiş).
 * Ateşleme sırası fırlatıcı 0'ın hücreleri, sonra fırlatıcı 1 … (cellLayout sırası).
 */
export function cellStates(method, inv = {}) {
  const per = cellCount(method);
  if (!per) return { launchers: 0, cells: [], active: null, loaded: 0, spent: 0, empty: 0 };
  const total = Math.max(1, Math.round(Number(inv.total) || 1));
  const n = inv.launchers ?? launcherCount(method, total);
  const used = clamp(Math.round(Number(inv.used) || 1), 1, Math.max(1, total));
  const cells = [];
  let active = null, loaded = 0, spent = 0, empty = 0;
  for (let l = 0; l < n; l++) {
    const row = [];
    for (let c = 0; c < per; c++) {
      const k = l * per + c;   // 0 tabanlı ateşleme sırası
      let st;
      if (k >= total) { st = 'empty'; empty++; } else if (k < used - 1) { st = 'spent'; spent++; } else if (k === used - 1) { st = 'active'; active = { l, c }; } else { st = 'loaded'; loaded++; }
      row.push(st);
    }
    cells.push(row);
  }
  return { launchers: n, cells, active, loaded, spent, empty };
}
/** Envanter: görevde (defend) §26 interceptor sayısı + icept.used; görevsiz: launch.loaded (dolu hücre; tüp/el 1), used 1. */
export function launcherInventory(launch, defend = null) {
  const m = launch?.method;
  if (!isIceptLauncher(m)) return null;
  const per = cellCount(m);
  if (defend) {
    const total = Math.max(1, Math.round(Number(defend.config?.interceptors ?? defend.interceptors) || 10));
    const used = Math.max(1, Math.round(Number(defend.state?.icept?.used) || 1));
    return { total, used, launchers: launcherCount(m, total), defend: true };
  }
  const loaded = per > 1 ? clamp(Math.round(Number(launch.loaded) || per), 1, per) : 1;
  return { total: loaded, used: 1, launchers: 1, defend: false };
}

// ---------- nişangâh (scope) izdüşümü ----------
/** Nişangâh kamera pozu (flightsim_tgthud `view` biçimi): konum + nişan (az, el), dikey görüş alanı, en-boy. Yukarı vektör ufka dik (yuvarlanma yok). */
export function scopeView(pos, azDeg, elDeg, fovDeg, aspect) {
  const f = aimVector(azDeg, elDeg);
  const a = azDeg * DEG;
  const right = [Math.cos(a), -Math.sin(a), 0];   // f × z (yatay, sağa)
  const up = [right[1] * f[2] - right[2] * f[1], right[2] * f[0] - right[0] * f[2], right[0] * f[1] - right[1] * f[0]];   // right × f
  return { pos: [...pos], fwd: f, right, up, tanV: Math.tan(fovDeg * DEG / 2), aspect, k: 0, scale: 1 };
}
export const SCOPE_ZOOMS = [1, 2, 4, 8];
export const SCOPE_FOV = 40;          // ×1 dikey görüş alanı (°)
export const scopeFov = zoom => SCOPE_FOV / (SCOPE_ZOOMS.includes(zoom) ? zoom : 1);
/** Nişangâh ekranı ölçek şeridi: az şeridindeki işaretler (her 10°; ekran x 0…1) — 2B katman. */
export function azTicks(azDeg, fovDeg, aspect, step = 10) {
  const hf = Math.atan(Math.tan(fovDeg * DEG / 2) * aspect) / DEG, out = [];
  for (let d = Math.ceil((azDeg - hf) / step) * step; d <= azDeg + hf; d += step) {
    const x = 0.5 + Math.tan((d - azDeg) * DEG) / (2 * Math.tan(hf * DEG));
    out.push({ deg: ((d % 360) + 360) % 360, x });
  }
  return out;
}
