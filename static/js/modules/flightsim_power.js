// Uçuş Simülatörü — §23 GÜÇ VE YAKIT (docs/ucus-simulatoru.md §23; sunucu eşleniği app/flightsim_power.py):
// • Sihirbaz "Güç ve yakıt" bölümü (createPowerSection): azami hız (m/s; yalnız uçak), yakıt (L) + tüketim (km/L), batarya hücre (S) + kapasite (mAh)
//   + saatlik tüketim (W). Varsayılanlar dron kaydından (son ölçümler: fuel_km_per_l_last / elec_w_last) → yoksa tip varsayılanı (CAYMAZ 45 m/s, 5 L,
//   25 km/L, 4S 10000 mAh 30 W; kopter yakıtsız). Kullanıcı değiştirir; `values()` start gövdesine `power` olarak gider.
// • Canlı oturumda göstergeler sunucunun tele.fuel / tele.elec / tele.speedup alanlarından; KAYITTAN OYNATMADA aynı model (createPowerSim) karelerden
//   (yer hızı, gaz, armed, servo) oynatıcı zamanıyla hesaplanır (session.power = kaydın canlı oturumundaki ayarlar; atlamada baştan yeniden entegre).
// • Simülasyon hızı kapsülü (createSpeedPill): 1×/2×/4×/8× → cmd speed {factor} (SITL SIM_SPEEDUP); seçili düğme tele.speedup ile eşitlenir.
// • Güç paneli (§23.6, createPowerGauges): takip/serbest/yer kiplerinde alt çubuğun üstünde YATAYDA ORTADA, panelden bağımsız dört otomobil tarzı analog
//   kadran (YAKIT küçük · HIZ büyük · MOTOR büyük · BATARYA küçük; 240° süpürme, siyah ibre, kırmızı/mavi bölge, dijital değer); kritikte kırmızı nabız,
//   bitince rozet; FPV OSD / gimbal HUD açıkken kendi çizimleri (fs-osd-on / fs-mhud-on gizler); tıklanınca ayrıntı kutusu.
// Saf yardımcılar (tests/test_flightsim_power.mjs): fuelLpm, batteryWh, servoJoule, measuredKmPerL, avgW, createPowerSim, powerWarnings, fuelText, elecText, rangeText,
//   gaugeLevel/gaugeArc/fuelGauge/elecGauge/gaugeModels, needleAngle/niceScaleMax/scaleTicks/zoneArc/arcPath/easeNeedle, speedGauge/engineGauge/dashModels, createPowerAcc, powerDetailRows.
// ui.js içe aktarılmaz (Node testinde çalışır): DOM üreten fonksiyonlar `h` ve `tr`'yi parametre alır.

export const HUCRE_V = 3.7, SERVO_J_PER_US = 0.0005, W_PENCERE_S = 30, FUEL_MIN_KM = 0.3, FUEL_MIN_L = 0.02, ELEC_MIN_S = 60;
export const FUEL_LOW_PCT = 20, ELEC_LOW_PCT = 25;
export const SPEEDUPS = [1, 2, 4, 8];
export const POWER_FIELDS = ['max_speed_ms', 'fuel_l', 'fuel_km_per_l', 'elec_cells', 'elec_mah', 'elec_w'];
export const LIMITS = { max_speed_ms: [5, 150], fuel_l: [0, 500], fuel_km_per_l: [0.5, 500], elec_cells: [1, 16], elec_mah: [100, 200000], elec_w: [0, 2000] };
export const CAYMAZ_DEFAULTS = { max_speed_ms: 45, fuel_l: 5, fuel_km_per_l: 25, elec_cells: 4, elec_mah: 10000, elec_w: 30 };
export const COPTER_DEFAULTS = { max_speed_ms: null, fuel_l: 0, fuel_km_per_l: 25, elec_cells: 4, elec_mah: 10000, elec_w: 30 };
// §25 INTERCEPTOR: elektrikli tailsitter — yakıt yok, 400 km/h (111,1 m/s), 6S aviyonik bataryası (sunucu INTERCEPTOR_VARSAYILAN)
export const INTERCEPTOR_DEFAULTS = { max_speed_ms: 111.1, fuel_l: 0, fuel_km_per_l: 25, elec_cells: 6, elec_mah: 8000, elec_w: 40 };
const PLANE_TYPES = ['sabit_kanat', 'vtol', 'interceptor'];
const num = (v, d = null) => (v == null || v === '' || Number.isNaN(Number(v)) ? d : Number(v));
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
export const isPlaneType = t => PLANE_TYPES.includes(t);
export const defaultsFor = t => ({ ...(t === 'interceptor' ? INTERCEPTOR_DEFAULTS : isPlaneType(t) ? CAYMAZ_DEFAULTS : COPTER_DEFAULTS) });

// ---------- saf hesaplar (sunucuyla birebir) ----------
// Anlık tüketim (L/dk): (v km/h ÷ 60) ÷ (km/L) × (0,5 + 0,5·gaz)
export function fuelLpm(vMs, thrPct, kmPerL) {
  if (!kmPerL || kmPerL <= 0) return 0;
  const vKmh = Math.max(0, num(vMs, 0)) * 3.6, thr = clamp(num(thrPct, 0) / 100, 0, 1);
  return (vKmh / 60) / kmPerL * (0.5 + 0.5 * thr);
}
export const batteryWh = (mah, cells) => num(mah, 0) / 1000 * Math.round(num(cells, 0)) * HUCRE_V;
export function servoJoule(servo, prev) {
  if (!Array.isArray(servo) || !Array.isArray(prev)) return 0;
  let j = 0;
  for (let i = 0; i < Math.min(servo.length, prev.length); i++) { const a = num(servo[i]), b = num(prev[i]); if (a != null && b != null && a >= 800 && a <= 2200 && b >= 800 && b <= 2200) j += Math.abs(a - b) * SERVO_J_PER_US; }
  return j;
}
export const measuredKmPerL = (distM, usedL) => (distM == null || usedL == null || distM / 1000 < FUEL_MIN_KM || usedL < FUEL_MIN_L ? null : Math.round(distM / 1000 / usedL * 100) / 100);
export const avgW = (whUsed, s) => (!s || s < ELEC_MIN_S || whUsed == null ? null : Math.round(whUsed / (s / 3600) * 10) / 10);
// Batarya gerilimi kestirimi (gösterge): hücre × (3,5 + 0,7·kalan oran)
export const elecVolts = (cells, frac) => Math.round(Math.round(num(cells, 0)) * (3.5 + 0.7 * clamp(num(frac, 0), 0, 1)) * 100) / 100;

// ---------- kayıttan oynatma / sahte kip modeli: GucDurumu eşleniği ----------
export function createPowerSim(settings) {
  const S = { ...defaultsFor('sabit_kanat'), ...(settings || {}) };
  const fuelOn = num(S.fuel_l, 0) > 0 && num(S.fuel_km_per_l, 0) > 0, whCap = batteryWh(S.elec_mah, S.elec_cells), elecOn = whCap > 0;
  const st = {};
  const reset = () => { Object.assign(st, { fuel: num(S.fuel_l, 0), fuelUsed: 0, lpm: 0, fuelEmptyT: null, whUsed: 0, wNow: num(S.elec_w, 0), elecEmptyT: null, dist: 0, time: 0, armedS: 0, maxSpeed: 0, t: null, servo: null, win: [] }); };
  reset();
  // frame: {groundspeed|gs, throttle|thr, armed, servo}; tSec: kare zamanı (saniye). Dönüş: bu adımda biten kaynaklar ['fuel'|'elec']
  const step = (fr, tSec) => {
    if (tSec == null || Number.isNaN(Number(tSec))) return [];
    tSec = Number(tSec);
    if (st.t == null || tSec < st.t) { st.t = tSec; st.servo = Array.isArray(fr.servo) ? fr.servo.slice() : null; return []; }
    const dt = tSec - st.t; st.t = tSec;
    if (dt <= 0 || dt > 5) { st.servo = Array.isArray(fr.servo) ? fr.servo.slice() : null; return []; }
    const out = [], armed = !!fr.armed, gs = num(fr.groundspeed ?? fr.gs, 0), thr = num(fr.throttle ?? fr.thr, 0);
    st.time += dt;
    if (armed) { st.armedS += dt; st.dist += gs * dt; st.maxSpeed = Math.max(st.maxSpeed, gs); }
    if (fuelOn) {
      st.lpm = armed ? fuelLpm(gs, thr, S.fuel_km_per_l) : 0;
      if (armed && st.fuel > 0) { const use = Math.min(st.fuel, st.lpm * dt / 60); st.fuel -= use; st.fuelUsed += use; if (st.fuel <= 1e-9) { st.fuel = 0; st.fuelEmptyT = st.time; out.push('fuel'); } }
    }
    if (elecOn) {
      const servo = Array.isArray(fr.servo) ? fr.servo.slice() : null;
      const j = num(S.elec_w, 0) * dt + servoJoule(servo, st.servo); st.servo = servo;
      st.win.push([st.time, j]); while (st.win.length && st.time - st.win[0][0] > W_PENCERE_S) st.win.shift();
      const span = st.win.length > 1 ? st.time - st.win[0][0] : 0;
      st.wNow = span > 1 ? st.win.reduce((a, x) => a + x[1], 0) / span : num(S.elec_w, 0);
      if (st.whUsed < whCap) { st.whUsed = Math.min(whCap, st.whUsed + j / 3600); if (whCap - st.whUsed <= 1e-9) { st.whUsed = whCap; st.elecEmptyT = st.time; out.push('elec'); } }
    }
    return out;
  };
  const state = () => {
    const f0 = num(S.fuel_l, 0), left = whCap - st.whUsed;
    return {
      speedup: 1,
      fuel: fuelOn ? { l: st.fuel, pct: f0 ? 100 * st.fuel / f0 : 0, lpm: st.lpm, range_km: st.fuel * num(S.fuel_km_per_l, 0), empty: st.fuel <= 0 } : null,
      elec: elecOn ? { wh: left, pct: 100 * left / whCap, w: st.wNow, min_left: st.wNow > 0.01 ? left / st.wNow * 60 : null, cells: Math.round(num(S.elec_cells, 0)), v: elecVolts(S.elec_cells, left / whCap), empty: left <= 0 } : null,
    };
  };
  const summary = () => ({
    settings: { ...S }, dist_m: st.dist, time_s: st.time, armed_s: st.armedS, max_speed_seen: st.maxSpeed,
    fuel: fuelOn ? { start_l: num(S.fuel_l, 0), used_l: st.fuelUsed, left_l: st.fuel, km_per_l: measuredKmPerL(st.dist, st.fuelUsed), empty_t: st.fuelEmptyT } : null,
    elec: elecOn ? { wh_cap: whCap, wh_used: st.whUsed, wh_left: whCap - st.whUsed, pct: 100 * (whCap - st.whUsed) / whCap, w_avg: avgW(st.whUsed, st.time), empty_t: st.elecEmptyT } : null,
  });
  // Kayıt kareleri (data.frames + data.fields) üzerinden t anına kadar baştan entegre (atlama/baştan): en çok 4 Hz örnekleme ile hızlı
  const rebuild = (data, tTarget) => {
    reset();
    const FI = Object.fromEntries((data?.fields || []).map((k, i) => [k, i]));
    const F = data?.frames || [];
    if (FI.t == null) return;
    let lastT = -1;
    for (const fr of F) {
      const t = fr[FI.t]; if (t > tTarget) break;
      if (t - lastT < 0.25) continue; lastT = t;
      step({ groundspeed: FI.gs != null ? fr[FI.gs] : null, throttle: FI.thr != null ? fr[FI.thr] : null, armed: FI.armed != null ? !!fr[FI.armed] : false, servo: FI.servo != null ? fr[FI.servo] : null }, t);
    }
  };
  return { step, state, summary, reset, rebuild, get fuelOn() { return fuelOn; }, get elecOn() { return elecOn; }, settings: S };
}

// ---------- gösterge metinleri / uyarılar ----------
export function powerWarnings({ fuel = null, elec = null } = {}) {
  const w = [];
  if (fuel) { if (fuel.empty || fuel.l <= 0) w.push('fuelempty'); else if (fuel.pct != null && fuel.pct < FUEL_LOW_PCT) w.push('lowfuel'); }
  if (elec) { if (elec.empty || elec.wh <= 0) w.push('elecempty'); else if (elec.pct != null && elec.pct < ELEC_LOW_PCT) w.push('lowelec'); }
  return w;
}
export const rangeText = km => (km == null ? '—' : km >= 10 ? `${Math.round(km)} km` : km >= 1 ? `${km.toFixed(1)} km` : `${Math.round(km * 1000)} m`);
export const fuelText = f => (!f ? '—' : `${num(f.l, 0).toFixed(2)} L · %${Math.round(num(f.pct, 0))}`);
export const elecText = e => (!e ? '—' : `%${Math.round(num(e.pct, 0))} · ${num(e.v, 0).toFixed(2)} V${e.min_left != null ? ` · ${Math.round(e.min_left)} dk` : ''}`);
export const minText = m => (m == null || !Number.isFinite(m) ? '—' : m >= 90 ? `${Math.floor(m / 60)} sa ${Math.round(m % 60)} dk` : `${Math.round(m)} dk`);

// ---------- §23.6 güç paneli: otomobil tarzı analog kadranlar (YAKIT · HIZ · MOTOR · BATARYA; alt çubuğun üstünde, yatayda ortada) ----------
// Saf kısım (tests/test_flightsim_power.mjs): seviye eşikleri (yeşil ≥ 30 % · sarı < 30 % · kırmızı < 15 % · bitti), 240° süpürme ibre açısı (needleAngle),
// ölçek üst sınırı (niceScaleMax: azami × 1,2 → 20/50/100 katına yuvarlanır), çentikler (scaleTicks), kırmızı/mavi bölge yayı (zoneArc), SVG yay yolu (arcPath),
// ibre yumuşatma (easeNeedle; üstel yaklaşım), dört kadran modeli (fuelGauge / speedGauge / engineGauge / elecGauge → dashModels), SITL pili yedeği,
// mesafe-süre toplayıcısı, ayrıntı satırları. Eski 270° yay değerleri (gaugeArc, GAUGE_ARC) FPV OSD / HUD çubukları için korunur.
export const GAUGE_LOW_PCT = 30, GAUGE_CRIT_PCT = 15, GAUGE_ARC = 75;   // 270° / 360° × pathLength 100 (OSD/HUD çubukları)
export const GAUGE_COLORS = { ok: '#22c55e', low: '#fbbf24', crit: '#ef4444', empty: '#ef4444' };
export const GAUGE_SWEEP = 240, GAUGE_R = 46, GAUGE_CX = 50, GAUGE_CY = 50;   // ibre −120° … +120° (saat 7 → saat 5); viewBox 100 × 100
export const ENGINE_RED_PCT = 90, FUEL_RED_FRAC = 0.125, ELEC_BLUE_PCT = 90, NEEDLE_TAU = 0.22, NEEDLE_SNAP = 0.04;
export function gaugeLevel(pct, empty = false) {
  if (empty || pct == null || !Number.isFinite(Number(pct)) || Number(pct) <= 0) return 'empty';
  const p = Number(pct);
  return p < GAUGE_CRIT_PCT ? 'crit' : p < GAUGE_LOW_PCT ? 'low' : 'ok';
}
export const gaugeColor = (pct, empty = false) => GAUGE_COLORS[gaugeLevel(pct, empty)];
export const gaugeArc = pct => Math.round(clamp(num(pct, 0), 0, 100) * GAUGE_ARC) / 100;   // dolu yay uzunluğu (pathLength 100 birimi)
export const lphText = lpm => `${(num(lpm, 0) * 60).toFixed(2)} L/sa`;
export const wattText = w => (w == null ? '—' : `${Math.round(num(w, 0))} W`);
export const voltText = v => (v == null || !(num(v, 0) > 0) ? '—' : `${num(v, 0).toFixed(1)} V`);
// İbre açısı (derece, dikeyden saat yönü): min → −sweep/2, max → +sweep/2; aralık dışı kırpılır; geçersiz → min
export function needleAngle(v, min = 0, max = 100, sweep = GAUGE_SWEEP) {
  const x = num(v, min);
  if (!(max > min)) return -sweep / 2;
  return Math.round((clamp((x - min) / (max - min), 0, 1) - 0.5) * sweep * 100) / 100;
}
// Ölçek üst sınırı: azami × 1,2 → "güzel" adıma (ana bölme 20 / 25 / 50 / 100 …) yukarı yuvarlanmış; ana bölme sayısı 4–6 arasında
export function niceScaleMax(vmax, factor = 1.2) {
  const want = Math.max(1, Math.round(num(vmax, 0) * factor * 1e6) / 1e6);
  const mag = 10 ** Math.floor(Math.log10(want));
  for (const m of [1, 2, 2.5, 5, 10, 20]) { const step = m * mag / 10; if (step < 1 && mag <= 10) continue; const top = Math.ceil(want / step) * step; if (top / step <= 6 && top / step >= 4) return { max: Math.round(top * 100) / 100, step: Math.round(step * 100) / 100 }; }
  const step = mag; return { max: Math.ceil(want / step) * step, step };
}
// Çentikler: ana (değer etiketli) ve ara (ana aralık minor'a bölünür); her biri {v, a (derece), major}
export function scaleTicks(max, step, minor = 2, min = 0, sweep = GAUGE_SWEEP) {
  const out = [];
  if (!(step > 0) || !(max > min)) return out;
  const n = Math.round((max - min) / step), sub = Math.max(1, Math.round(minor));
  for (let i = 0; i <= n * sub; i++) { const v = Math.round((min + i * step / sub) * 1e6) / 1e6; if (v > max + 1e-9) break; out.push({ v, a: needleAngle(v, min, max, sweep), major: i % sub === 0 }); }
  return out;
}
// Renkli bölge: [from, to] değer aralığının açıları (derece); boşsa null
export function zoneArc(from, to, min, max, sweep = GAUGE_SWEEP) {
  if (from == null || to == null || !(max > min)) return null;
  const a = clamp(num(from, min), min, max), b = clamp(num(to, max), min, max);
  if (b - a <= 1e-9) return null;
  return { a0: needleAngle(a, min, max, sweep), a1: needleAngle(b, min, max, sweep) };
}
// SVG yay yolu: merkez (cx, cy), yarıçap r, a0 → a1 derece (dikeyden saat yönü); > 180° ise büyük yay bayrağı
export function arcPath(a0, a1, r, cx = GAUGE_CX, cy = GAUGE_CY) {
  const P = a => { const t = (a - 90) * Math.PI / 180; return [cx + r * Math.cos(t), cy + r * Math.sin(t)]; };
  const [x0, y0] = P(a0), [x1, y1] = P(a1), big = Math.abs(a1 - a0) > 180 ? 1 : 0;
  return `M ${x0.toFixed(2)} ${y0.toFixed(2)} A ${r} ${r} 0 ${big} ${a1 >= a0 ? 1 : 0} ${x1.toFixed(2)} ${y1.toFixed(2)}`;
}
// İbre yumuşatma: üstel yaklaşım (zaman sabiti tau sn); fark NEEDLE_SNAP altındaysa hedefe oturur (titreme yok)
export function easeNeedle(cur, target, dtSec, tau = NEEDLE_TAU) {
  const c = num(cur, target), d = target - c;
  if (Math.abs(d) <= NEEDLE_SNAP || !(dtSec > 0)) return target;
  return c + d * (1 - Math.exp(-dtSec / tau));
}
// Yakıt kadranı modeli: ibre 0…1 (¼ ½ ¾ 1), boş uç kırmızı (0…⅛); dijital "4.82 L" + "≈ 113 km"; ikincil "%96", anlık "0.41 L/sa"; biterse rozet
export function fuelGauge(f) {
  if (!f) return null;
  const pct = clamp(num(f.pct, 0), 0, 100), empty = !!f.empty || num(f.l, 0) <= 0, level = gaugeLevel(pct, empty);
  return { kind: 'fuel', pct, level, color: GAUGE_COLORS[level], empty, arc: gaugeArc(pct), angle: needleAngle(pct / 100, 0, 1), main: `${num(f.l, 0).toFixed(num(f.l, 0) >= 10 ? 1 : 2)} L`, unit: '', pctText: `%${Math.round(pct)}`,
    sub: empty ? '0 km' : `≈ ${rangeText(num(f.range_km, 0))}`, rate: lphText(f.lpm), badge: empty ? 'YAKIT BİTTİ' : null, warn: level === 'crit' || empty };
}
// Batarya kadranı modeli (tele.elec; yoksa SITL pili batt_v/batt_pct → sitl: true): ibre 0…100 %, düşük uç kırmızı, üst uç mavi; dijital "%99" + "16.8 V · 5 sa 14 dk"
export function elecGauge(e, sitl = null) {
  if (e) {
    const pct = clamp(num(e.pct, 0), 0, 100), empty = !!e.empty || num(e.wh, 0) <= 0, level = gaugeLevel(pct, empty);
    return { kind: 'elec', pct, level, color: GAUGE_COLORS[level], empty, arc: gaugeArc(pct), angle: needleAngle(pct, 0, 100), main: `%${Math.round(pct)}`, unit: '', pctText: voltText(e.v),
      sub: empty ? voltText(e.v) : `${voltText(e.v)} · ≈ ${minText(e.min_left)}`, rate: `${wattText(e.w)}${e.cells ? ` · ${Math.round(e.cells)}S` : ''}`, badge: empty ? 'BATARYA BİTTİ' : null, sitl: false, warn: level === 'crit' || empty };
  }
  if (sitl && (num(sitl.batt_pct, null) != null || num(sitl.batt_v, 0) > 0)) {   // SITL pili (elektronik batarya tanımsız): yüzde telemetriden, yoksa gerilimden kaba kestirim
    const v = num(sitl.batt_v, null), pct = clamp(num(sitl.batt_pct, v != null && v > 0 ? (v / Math.max(1, Math.round(v / 3.8)) - 3.5) / 0.7 * 100 : 0), 0, 100), level = gaugeLevel(pct, false);
    return { kind: 'elec', pct, level, color: GAUGE_COLORS[level], empty: false, arc: gaugeArc(pct), angle: needleAngle(pct, 0, 100), main: `%${Math.round(pct)}`, unit: '', pctText: voltText(v), sub: voltText(v), rate: 'SITL pili', badge: null, sitl: true, warn: level === 'crit' };
  }
  return null;
}
// Hız kadranı: yer hızı km/h; ölçek 0 … niceScaleMax(azami × 1,2); azami hız üstü kırmızı bölge; uçakta hava hızı ikinci okuma (IAS);
// uyarı üçgeni: çarpışma, aşırı hız (> azami) ya da stall (uçak, armed, havada > 10 m AGL, IAS < azami × 0,25). Azami yoksa (kopter) 100 km/h ölçek, kırmızı bölge yok.
export function speedGauge(t, settings = null, { plane = false, collision = false } = {}) {
  if (!t) return null;
  const gs = Math.max(0, num(t.groundspeed ?? t.gs, 0)) * 3.6, air = t.airspeed != null ? Math.max(0, num(t.airspeed, 0)) * 3.6 : null;
  const vmax = num(settings?.max_speed_ms, null), maxKmh = vmax ? vmax * 3.6 : null;
  const sc = niceScaleMax(maxKmh || 100 / 1.2);
  const airborne = !!t.armed && num(t.alt_rel, 0) > 10;
  const over = maxKmh != null && gs > maxKmh * 1.02, stall = plane && airborne && air != null && maxKmh != null && air < maxKmh * 0.25;
  const warn = !!collision || over || stall;
  return { kind: 'speed', min: 0, max: sc.max, step: sc.step, value: gs, angle: needleAngle(gs, 0, sc.max), red: maxKmh != null ? zoneArc(maxKmh, sc.max, 0, sc.max) : null, blue: null,
    main: String(Math.round(gs)), unit: 'KM/H', sub: air != null && plane ? `IAS ${Math.round(air)}` : '', level: warn ? 'crit' : over ? 'low' : 'ok', warn, warnKind: collision ? 'crash' : over ? 'over' : stall ? 'stall' : null };
}
// Motor kadranı: gaz kolu % 0…100 (dijital "72" + "% GAZ"); SITL rpm varsa ×1000 RPM ölçeği (0 … niceScaleMax(azami rpm)); kırmızı bölge % 90+
export function engineGauge(t, { rpmMax = 8000 } = {}) {
  if (!t) return null;
  const rpm = num(t.rpm, null);
  if (rpm != null && rpm > 0) {
    const sc = niceScaleMax(rpmMax / 1000, 1), v = rpm / 1000;
    return { kind: 'engine', min: 0, max: sc.max, step: sc.step, value: v, angle: needleAngle(v, 0, sc.max), red: zoneArc(sc.max * ENGINE_RED_PCT / 100, sc.max, 0, sc.max), blue: null, main: v.toFixed(1), unit: '×1000 RPM', sub: `${Math.round(clamp(num(t.throttle, 0), 0, 100))} %`, level: v >= sc.max * ENGINE_RED_PCT / 100 ? 'low' : 'ok', warn: false };
  }
  const thr = clamp(num(t.throttle, 0), 0, 100);
  return { kind: 'engine', min: 0, max: 100, step: 20, value: thr, angle: needleAngle(thr, 0, 100), red: zoneArc(ENGINE_RED_PCT, 100, 0, 100), blue: null, main: String(Math.round(thr)), unit: '% GAZ', sub: '', level: thr >= ENGINE_RED_PCT ? 'low' : 'ok', warn: false };
}
// Telemetri karesinden yakıt + batarya: yakıt 0 L (elektrikli dron) → yalnız batarya; batarya tanımsızsa yalnız yakıt; ikisi de yoksa {null,null}
export const gaugeModels = t => ({ fuel: fuelGauge(t?.fuel || null), elec: elecGauge(t?.elec || null, t || null) });
// Dört kadran: yakıt (0 L → null, "ELEKTRİK" rozeti), hız, motor, batarya. Güç kaynağı hiç yoksa (fuel + elec null) hız/motor da gizlenir (kapsayıcı kapalı)
export function dashModels(t, settings = null, opts = {}) {
  const { fuel, elec } = gaugeModels(t);
  if (!fuel && !elec) return { fuel: null, speed: null, engine: null, elec: null };
  return { fuel, speed: speedGauge(t, settings, opts), engine: engineGauge(t, opts), elec };
}
// Mesafe / süre toplayıcısı (canlı oturum: sunucu tele'de mesafe yok): kare zamanı t (kayıt sn) → tbm (SITL ms) → ts (ms); > 5 sn boşluk atlanır
export function createPowerAcc() {
  const st = { last: null, dist: 0, time: 0, armedS: 0 };
  const timeOf = t => (t.t != null ? num(t.t) : t.tbm != null ? num(t.tbm) / 1000 : t.ts != null ? num(t.ts) / 1000 : null);
  return {
    step(t) {
      const s = t ? timeOf(t) : null;
      if (s == null) return;
      if (st.last != null && s > st.last && s - st.last <= 5) { const dt = s - st.last; st.time += dt; if (t.armed) { st.armedS += dt; st.dist += Math.max(0, num(t.groundspeed ?? t.gs, 0)) * dt; } }
      st.last = s;
    },
    reset() { Object.assign(st, { last: null, dist: 0, time: 0, armedS: 0 }); },
    get dist_m() { return st.dist; }, get time_s() { return st.time; }, get armed_s() { return st.armedS; },
  };
}
// Ayrıntı satırları (tıklanınca açılır): [etiket, yakıt sütunu, batarya sütunu]; settings = session.power; sum = kayıt/sahte kip özeti (createPowerSim.summary)
// ya da canlı toplayıcı {dist_m, time_s}. Kaynak yoksa sütun '—'.
export function powerDetailRows(t, settings, sum, tr = s => s) {
  const S = settings || {}, f = t?.fuel || null, e = t?.elec || null;
  const whCap = batteryWh(S.elec_mah, S.elec_cells), f0 = num(S.fuel_l, 0);
  const usedL = f ? (sum?.fuel?.used_l ?? Math.max(0, f0 - num(f.l, 0))) : null, whUsed = e ? (sum?.elec?.wh_used ?? Math.max(0, whCap - num(e.wh, 0))) : null;
  const dist = num(sum?.dist_m, 0), time = num(sum?.time_s, 0);
  const kml = f ? (sum?.fuel?.km_per_l ?? measuredKmPerL(dist, usedL)) : null, wavg = e ? (sum?.elec?.w_avg ?? avgW(whUsed, time)) : null;
  const d = (a, b) => [a, b];
  return [
    [tr('Başlangıç'), ...d(f ? `${f0.toFixed(2)} L` : '—', e ? `${whCap.toFixed(0)} Wh · ${Math.round(num(S.elec_cells, 0))}S ${num(S.elec_mah, 0)} mAh` : '—')],
    [tr('Tüketim ayarı'), ...d(f ? `${num(S.fuel_km_per_l, 0)} km/L` : '—', e ? wattText(S.elec_w) : '—')],
    [tr('Harcanan'), ...d(f ? `${usedL.toFixed(2)} L` : '—', e ? `${whUsed.toFixed(1)} Wh` : '—')],
    [tr('Anlık'), ...d(f ? lphText(f.lpm) : '—', e ? wattText(e.w) : '—')],
    [tr('Ölçülen'), ...d(f ? (kml != null ? `${kml} km/L` : tr('henüz yok')) : '—', e ? (wavg != null ? `${tr('ort.')} ${wavg} W` : tr('henüz yok')) : '—')],
    [tr('Mesafe'), `${rangeText(dist / 1000)} · ${minText(time / 60)}`, ''],
  ];
}

// DOM: güç paneli (alt çubuğun üstünde, yatayda ortada; CSS .fs-gauges). deps { h, tr, getSettings, getSummary, plane, getCollision }.
// Dönüş { el, update(t), reset(), dispose() }. Yapı: dört .fs-gauge düğmesi (data-g = fuel | speed | engine | elec; büyük: speed, engine), her biri bir SVG
// otomobil kadranı: açık yüzey, ince dış halka, ana/ara çentikler + rakamlar, kırmızı (ve mavi) bölge yayı, siyah ibre + merkez pimi, kadranın alt
// yarısında dijital değer + birim, ikon (pompa / pil / uyarı üçgeni); bitince rozet kadranın üstünde. İbre rAF ile yumuşatılır (easeNeedle).
// Tıklanınca .fs-power-pop ayrıntı kutusu (powerDetailRows). Görünür kaynak yoksa kapsayıcı hidden; stage'e .fs-power-on sınıfı.
const GAUGE_ICO = {
  fuel: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 21V5a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2v16"/><path d="M4 21h12"/><path d="M7 7h6v4H7z"/><path d="M15 9h2a2 2 0 0 1 2 2v5a1.5 1.5 0 0 0 3 0V9l-2-2"/></svg>',
  elec: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2.5" y="8" width="16" height="8" rx="1.6"/><path d="M21 11v2"/><path d="M11.5 9.5 9 12.5h3l-1.5 2.5"/></svg>',
  warn: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3 2.5 20h19L12 3z"/><path d="M12 9v5"/><path d="M12 17.5v.5"/></svg>',
};
const FRAC_LBL = { 0: 'E', 0.25: '¼', 0.5: '½', 0.75: '¾', 1: 'F' };
const SPEC = {
  fuel: { min: 0, max: 1, step: 0.25, minor: 2, big: false, red: { a0: needleAngle(0, 0, 1), a1: needleAngle(FUEL_RED_FRAC, 0, 1) }, blue: null, lbl: v => FRAC_LBL[v] ?? '' },
  speed: { min: 0, max: 100, step: 20, minor: 2, big: true, red: null, blue: null, lbl: v => String(v) },
  engine: { min: 0, max: 100, step: 20, minor: 2, big: true, red: zoneArc(ENGINE_RED_PCT, 100, 0, 100), blue: null, lbl: v => String(v) },
  elec: { min: 0, max: 100, step: 25, minor: 2, big: false, red: zoneArc(0, GAUGE_CRIT_PCT, 0, 100), blue: zoneArc(ELEC_BLUE_PCT, 100, 0, 100), lbl: v => String(v) },
};
const P = (a, r) => { const t = (a - 90) * Math.PI / 180; return [GAUGE_CX + r * Math.cos(t), GAUGE_CY + r * Math.sin(t)]; };
// Çentik + rakam katmanı (ölçek değişince yeniden üretilir: hız kadranının azami hızı, motor rpm)
function ticksSvg(min, max, step, minor, lbl) {
  let s = '';
  for (const t of scaleTicks(max, step, minor, min)) {
    const [x0, y0] = P(t.a, t.major ? 38.5 : 41), [x1, y1] = P(t.a, 44.5);
    s += `<line class="fs-gauge-tick${t.major ? ' major' : ''}" x1="${x0.toFixed(2)}" y1="${y0.toFixed(2)}" x2="${x1.toFixed(2)}" y2="${y1.toFixed(2)}"/>`;
    if (t.major) { const [tx, ty] = P(t.a, 31.5); s += `<text class="fs-gauge-num" x="${tx.toFixed(2)}" y="${(ty + 2.2).toFixed(2)}">${lbl(t.v)}</text>`; }
  }
  return s;
}
function dialSvg(kind) {
  const sp = SPEEP(kind);
  return `<svg viewBox="0 0 100 100" aria-hidden="true">
<path class="fs-gauge-ring" d="${arcPath(-GAUGE_SWEEP / 2 - 6, GAUGE_SWEEP / 2 + 6, 47.5)}"/>
<circle class="fs-gauge-face" cx="${GAUGE_CX}" cy="${GAUGE_CY}" r="${GAUGE_R}"/>
<path class="fs-gauge-zone red" d="${sp.red ? arcPath(sp.red.a0, sp.red.a1, 42.5) : ''}"${sp.red ? '' : ' hidden'}/>
<path class="fs-gauge-zone blue" d="${sp.blue ? arcPath(sp.blue.a0, sp.blue.a1, 42.5) : ''}"${sp.blue ? '' : ' hidden'}/>
<g class="fs-gauge-ticks">${ticksSvg(sp.min, sp.max, sp.step, sp.minor, sp.lbl)}</g>
<g class="fs-gauge-warn" hidden><path d="M50 27.5 44.2 37.5h11.6z"/><path class="w" d="M50 31v3.4M50 35.6v.3"/></g>
<g class="fs-gauge-needle" transform="rotate(${-GAUGE_SWEEP / 2} ${GAUGE_CX} ${GAUGE_CY})"><path d="M48.2 55 L51.8 55 L50.8 14.5 L49.2 14.5 Z"/></g>
<circle class="fs-gauge-pin" cx="${GAUGE_CX}" cy="${GAUGE_CY}" r="4.2"/><circle class="fs-gauge-pin2" cx="${GAUGE_CX}" cy="${GAUGE_CY}" r="1.5"/>
</svg>`;
}
const SPEEP = kind => SPEC[kind];
export function createPowerGauges(stage, { h, tr, getSettings = () => null, getSummary = () => null, plane = false, getCollision = () => false }) {
  const acc = createPowerAcc();
  let last = null, lastAt = 0, popOpen = false, disposed = false, raf = 0, rafAt = 0;
  const LABEL = { fuel: 'YAKIT', speed: 'HIZ', engine: 'MOTOR', elec: 'BATARYA' };
  const mk = kind => {
    const big = SPEC[kind].big;
    const g = { kind, cur: -GAUGE_SWEEP / 2, target: -GAUGE_SWEEP / 2, scale: null, main: h('b', { class: 'fs-gauge-main' }, '—'), unit: h('span', { class: 'fs-gauge-unit' }, ''), sub: h('span', { class: 'fs-gauge-sub' }, ''),
      badge: h('span', { class: 'fs-gauge-badge', hidden: true }, '') };
    const dial = h('span', { class: 'fs-gauge-dial', html: dialSvg(kind) });
    g.needle = dial.querySelector('.fs-gauge-needle'); g.warn = dial.querySelector('.fs-gauge-warn'); g.ticks = dial.querySelector('.fs-gauge-ticks'); g.red = dial.querySelector('.fs-gauge-zone.red');
    g.ico = h('span', { class: 'fs-gauge-ico', html: GAUGE_ICO[kind] || '' , hidden: !GAUGE_ICO[kind] });
    dial.append(g.ico, h('span', { class: 'fs-gauge-digits' }, g.main, g.unit), g.sub, g.badge);
    g.el = h('button', { class: `fs-gauge ${big ? 'big' : 'small'}`, type: 'button', 'data-g': kind, title: `${tr(LABEL[kind])} · ${tr('Güç paneli: ayrıntı için tıklayın')}`, onclick: () => togglePop() }, dial, h('span', { class: 'fs-gauge-lbl' }, tr(LABEL[kind])));
    return g;
  };
  const G = { fuel: mk('fuel'), speed: mk('speed'), engine: mk('engine'), elec: mk('elec') };
  const popBody = h('div', { class: 'fs-power-rows' });
  const pop = h('div', { class: 'fs-power-pop', hidden: true, role: 'dialog' },
    h('div', { class: 'fs-power-pop-h' }, h('b', null, tr('Güç ve yakıt')), h('button', { class: 'fs-power-x', type: 'button', title: tr('Kapat'), onclick: () => togglePop(false) }, '×')),
    popBody, h('div', { class: 'fs-power-foot small' }, tr('Yakıt: mesafe + gaz kolu · Batarya: saatlik W + servo · Biterse yalnız uyarı, uçuş sürer')));
  const el = h('div', { class: 'fs-gauges', hidden: true, 'data-nofuel': tr('ELEKTRİK') }, G.fuel.el, G.speed.el, G.engine.el, G.elec.el, pop);
  const onDocClick = e => { if (popOpen && !el.contains(e.target)) togglePop(false); };
  document.addEventListener('click', onDocClick, true);
  const togglePop = v => { popOpen = v == null ? !popOpen : !!v; pop.hidden = !popOpen; el.classList.toggle('open', popOpen); if (popOpen) drawPop(); };
  const drawPop = () => {
    if (!last) return;
    const rows = powerDetailRows(last, getSettings(), getSummary() || { dist_m: acc.dist_m, time_s: acc.time_s }, tr);
    const showF = !!last.fuel, showE = !!last.elec;
    const kids = [h('div', { class: 'fs-power-row fs-power-head' }, h('span'), h('span', { hidden: !showF }, tr('YAKIT')), h('span', { hidden: !showE }, tr('BATARYA')))];
    for (const [lbl, a, b] of rows) kids.push(b === '' ? h('div', { class: 'fs-power-row' }, h('span', null, lbl), h('span', { class: 'fs-power-span' }, a))
      : h('div', { class: 'fs-power-row' }, h('span', null, lbl), h('span', { hidden: !showF }, a), h('span', { hidden: !showE }, b)));
    popBody.replaceChildren(...kids);
  };
  // İbre animasyonu: hedef açıya üstel yaklaşım; tüm ibreler hedefteyse döngü durur
  const tick = now => {
    raf = 0;
    const dt = rafAt ? Math.min(0.1, (now - rafAt) / 1000) : 0.016; rafAt = now;
    let busy = false;
    for (const g of Object.values(G)) {
      if (g.cur === g.target) continue;
      g.cur = easeNeedle(g.cur, g.target, dt);
      g.needle.setAttribute('transform', `rotate(${g.cur.toFixed(2)} ${GAUGE_CX} ${GAUGE_CY})`);
      if (g.cur !== g.target) busy = true;
    }
    if (busy && !disposed) raf = requestAnimationFrame(tick); else rafAt = 0;
  };
  const setNeedle = (g, a) => { if (a == null || !Number.isFinite(a)) return; g.target = a; if (!raf && g.cur !== g.target) raf = requestAnimationFrame(tick); };
  const setScale = (g, m) => {   // ölçek (hız azami / rpm) değişince çentikler ve kırmızı bölge yeniden
    const key = `${m.min}|${m.max}|${m.step}|${m.red ? `${m.red.a0}:${m.red.a1}` : ''}|${m.unit}`;
    if (g.scale === key) return;
    g.scale = key;
    g.ticks.innerHTML = ticksSvg(m.min, m.max, m.step, SPEC[g.kind].minor, SPEC[g.kind].lbl);
    g.red.hidden = !m.red; if (m.red) g.red.setAttribute('d', arcPath(m.red.a0, m.red.a1, 42.5));
  };
  const apply = (g, m) => {
    g.el.hidden = !m;
    if (!m) return;
    g.el.dataset.level = m.level;
    if (m.kind === 'speed' || m.kind === 'engine') setScale(g, m);
    g.main.textContent = m.main; g.unit.textContent = m.unit ? tr(m.unit) : ''; g.unit.hidden = !m.unit;
    g.sub.textContent = m.kind === 'fuel' ? `${m.sub} · ${m.pctText}` : m.kind === 'elec' ? (m.sitl ? `${m.sub} · ${tr(m.rate)}` : m.sub) : m.sub; g.sub.hidden = !g.sub.textContent;
    g.badge.hidden = !m.badge; if (m.badge) g.badge.textContent = tr(m.badge);
    g.warn.hidden = !m.warn; g.el.classList.toggle('warn', !!m.warn);
    setNeedle(g, m.angle);
  };
  const update = t => {
    if (disposed || !t) return;
    acc.step(t); last = t;
    const now = performance.now();
    if (now - lastAt < 100) return;   // ≤ 10 Hz DOM yazımı (ibre rAF ile aradaki kareleri doldurur)
    lastAt = now;
    const m = dashModels(t, getSettings(), { plane, collision: !!getCollision() });
    apply(G.fuel, m.fuel); apply(G.speed, m.speed); apply(G.engine, m.engine); apply(G.elec, m.elec);
    const on = !!(m.fuel || m.elec);
    el.hidden = !on; stage.classList.toggle('fs-power-on', on);
    el.classList.toggle('no-fuel', on && !m.fuel);   // elektrikli dron: yakıt kadranı yerine ELEKTRİK rozeti (CSS ::before)
    if (popOpen) drawPop();
  };
  return { el, update, reset: () => acc.reset(), get open() { return popOpen; }, togglePop, dispose() { disposed = true; if (raf) cancelAnimationFrame(raf); document.removeEventListener('click', onDocClick, true); stage.classList.remove('fs-power-on'); el.remove(); } };
}

// ---------- sihirbaz bölümü ----------
// deps: { h, tr, api } · getType(): etkin dron tipi · getDroneId(): seçili dron kaydı (öneri) · mock: sahte kip (sunucu uçları çağrılmaz)
export function createPowerSection({ h, tr, api = null, getType, getDroneId = () => null, mock = false }) {
  const V = { ...defaultsFor(getType()) };
  let src = 'default', info = null;   // 'default' | 'drone'
  const inp = {}, srcBadge = {}, rows = {};
  const fmt = (k, v) => (v == null ? '' : k === 'elec_cells' ? String(Math.round(v)) : String(Number(v)));
  const mk = (k, label, unit, step, hint) => {
    inp[k] = h('input', { class: 'input fs-pw-inp', type: 'number', min: LIMITS[k][0], max: LIMITS[k][1], step, value: fmt(k, V[k]), inputmode: 'decimal',
      oninput: () => { const v = num(inp[k].value); V[k] = v == null ? null : clamp(v, LIMITS[k][0], LIMITS[k][1]); srcBadge[k].textContent = ''; drawInfo(); } });
    srcBadge[k] = h('span', { class: 'badge gray fs-pw-src' }, '');
    rows[k] = h('label', { class: 'fs-pw-row', 'data-pw': k }, h('span', { class: 'fs-pw-lbl' }, h('span', null, label), srcBadge[k]), h('span', { class: 'fs-pw-ctl' }, inp[k], h('i', null, unit)), hint ? h('span', { class: 'small muted fs-pw-hint' }, hint) : null);
    return rows[k];
  };
  const note = h('div', { class: 'small fs-pw-info' });
  const warn = h('div', { class: 'small fs-pw-warn', hidden: true });
  const el = h('div', { class: 'card card-pad fs-step fs-power no-collapse' }, h('h3', null, h('span', { class: 'fs-no' }, '⚡'), 'Güç ve yakıt'),
    h('p', { class: 'small muted' }, 'Motor ve batarya bütçesi: azami hız SITL fiziğine ve ArduPilot hız sınırlarına uygulanır; yakıt mesafe + gaz koluna, elektronik batarya saatlik tüketime göre azalır. Biterse yalnız kırmızı uyarı verilir, uçuş sürer. Uçuş sonunda ölçülen km/L ve ortalama W dron kaydına yazılır ve sonraki simülasyonda önerilir.'),
    h('div', { class: 'fs-pw-grid' },
      h('div', { class: 'fs-pw-col' }, h('h4', { class: 'fs-sub-h' }, 'Motor'),
        mk('max_speed_ms', 'Azami hız', 'm/s', 1, 'Tam gazda seviye uçuş hızı (CAYMAZ 222 cc karbüratörlü motor: 45 m/s). SITL itki çarpanı + AIRSPEED_MAX/CRUISE, THR_MAX 100.'),
        mk('fuel_l', 'Yakıt', 'L', 0.1, '0 = yakıt göstergesi yok (elektrikli).'),
        mk('fuel_km_per_l', 'Tüketim', 'km/L', 0.5, 'Seyirde kat edilen km başına yakıt; gaz kolu %100\'de tüketim 2 katına çıkar.')),
      h('div', { class: 'fs-pw-col' }, h('h4', { class: 'fs-sub-h' }, 'Elektronik batarya'),
        mk('elec_cells', 'Hücre sayısı', 'S', 1, null),
        mk('elec_mah', 'Kapasite', 'mAh', 100, null),
        mk('elec_w', 'Saatlik tüketim', 'W', 1, 'Otopilot, telemetri, servolar (servo hareketi küçük ek yük); SITL\'in kendi pil göstergesi değildir.'))),
    note, warn);
  const drawInfo = () => {
    const wh = batteryWh(V.elec_mah, V.elec_cells), kml = num(V.fuel_km_per_l, 0), fl = num(V.fuel_l, 0);
    const parts = [];
    if (isPlaneType(getType()) && V.max_speed_ms) parts.push(tr('Azami hız {v} m/s ({k} km/h)', { v: V.max_speed_ms, k: Math.round(V.max_speed_ms * 3.6) }) + (info?.stock_max_ms ? ` · ${tr('stok SITL ≈ {s} m/s', { s: info.stock_max_ms })}` : ''));
    parts.push(fl > 0 && kml > 0 ? tr('Yakıt menzili ≈ {r} (seyir)', { r: rangeText(fl * kml) }) : tr('Yakıt göstergesi kapalı'));
    parts.push(wh > 0 ? tr('Batarya {wh} Wh ≈ {m}', { wh: wh.toFixed(0), m: minText(num(V.elec_w, 0) > 0 ? wh / num(V.elec_w, 0) * 60 : null) }) : tr('Batarya göstergesi kapalı'));
    note.textContent = parts.join(' · ');
    const nos = info && info.thr_scale_supported === false && isPlaneType(getType()) && V.max_speed_ms;
    warn.hidden = !nos;
    if (nos) warn.textContent = tr('SITL ikilisi itki ölçeği (SIM_PLN_THR_MUL) desteklemiyor: azami hız yalnız ArduPilot sınırlarına uygulanır; tam gaz hızı stok fizikte ≈ {s} m/s kalır.', { s: info.stock_max_ms });
  };
  const applyType = () => { rows.max_speed_ms.hidden = !isPlaneType(getType()); };
  const setValues = (vals, from) => {
    for (const k of POWER_FIELDS) { if (vals[k] !== undefined) { V[k] = vals[k]; inp[k].value = fmt(k, V[k]); } srcBadge[k].textContent = from && from[k] != null ? tr('dron kaydından') : ''; }
    src = from && Object.keys(from).length ? 'drone' : 'default';
    drawInfo();
  };
  // Sunucudan öneri: tip varsayılanı + dron kaydındaki son ölçümler (GET /power-defaults?type&drone_id)
  const refresh = async () => {
    applyType();
    if (mock || !api) { setValues(defaultsFor(getType()), null); return; }
    try {
      const d = getDroneId();
      info = await api.get(`/api/drone/sim/power-defaults?type=${encodeURIComponent(getType())}${d != null ? `&drone_id=${d}` : ''}`);
      setValues(info.suggested || defaultsFor(getType()), info.from_drone || null);
    } catch { setValues(defaultsFor(getType()), null); }
  };
  applyType(); drawInfo();
  return { el, refresh, setType: () => refresh(), values: () => { const o = {}; for (const k of POWER_FIELDS) { if (k === 'max_speed_ms' && !isPlaneType(getType())) continue; if (V[k] != null) o[k] = k === 'elec_cells' ? Math.round(V[k]) : V[k]; } return o; }, get source() { return src; }, inputs: inp };
}

// ---------- simülasyon hızı kapsülü (panel + üst çubuk) ----------
export function createSpeedPill({ h, tr, onPick, cls = '' }) {
  let cur = 1;
  const btns = SPEEDUPS.map(x => h('button', { class: `btn sm fs-speed-btn ${x === 1 ? 'primary' : ''}`, type: 'button', 'data-speed': x, title: tr('Simülasyon hızı {x}× (SITL SIM_SPEEDUP; video gerçek zamanda)', { x }), onclick: () => onPick?.(x) }, `${x}×`));
  const el = h('div', { class: `pill-group fs-speeds fs-speed-pill ${cls}`, title: tr('Simülasyon hızı') }, btns);
  const set = f => { cur = Number(f) || 1; btns.forEach(b => b.classList.toggle('primary', Number(b.dataset.speed) === cur)); el.classList.toggle('fast', cur > 1); };
  return { el, set, get value() { return cur; }, setEnabled: v => btns.forEach(b => { b.disabled = !v; }) };
}
