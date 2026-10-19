// Uçuş Simülatörü — §23 GÜÇ VE YAKIT (docs/ucus-simulatoru.md §23; sunucu eşleniği app/flightsim_power.py):
// • Sihirbaz "Güç ve yakıt" bölümü (createPowerSection): azami hız (m/s; yalnız uçak), yakıt (L) + tüketim (km/L), batarya hücre (S) + kapasite (mAh)
//   + saatlik tüketim (W). Varsayılanlar dron kaydından (son ölçümler: fuel_km_per_l_last / elec_w_last) → yoksa tip varsayılanı (CAYMAZ 45 m/s, 5 L,
//   25 km/L, 4S 10000 mAh 30 W; kopter yakıtsız). Kullanıcı değiştirir; `values()` start gövdesine `power` olarak gider.
// • Canlı oturumda göstergeler sunucunun tele.fuel / tele.elec / tele.speedup alanlarından; KAYITTAN OYNATMADA aynı model (createPowerSim) karelerden
//   (yer hızı, gaz, armed, servo) oynatıcı zamanıyla hesaplanır (session.power = kaydın canlı oturumundaki ayarlar; atlamada baştan yeniden entegre).
// • Simülasyon hızı kapsülü (createSpeedPill): 1×/2×/4×/8× → cmd speed {factor} (SITL SIM_SPEEDUP); seçili düğme tele.speedup ile eşitlenir.
// Saf yardımcılar (tests/test_flightsim_power.mjs): fuelLpm, batteryWh, servoJoule, measuredKmPerL, avgW, createPowerSim, powerWarnings, fuelText, elecText, rangeText.
// ui.js içe aktarılmaz (Node testinde çalışır): DOM üreten fonksiyonlar `h` ve `tr`'yi parametre alır.

export const HUCRE_V = 3.7, SERVO_J_PER_US = 0.0005, W_PENCERE_S = 30, FUEL_MIN_KM = 0.3, FUEL_MIN_L = 0.02, ELEC_MIN_S = 60;
export const FUEL_LOW_PCT = 20, ELEC_LOW_PCT = 25;
export const SPEEDUPS = [1, 2, 4, 8];
export const POWER_FIELDS = ['max_speed_ms', 'fuel_l', 'fuel_km_per_l', 'elec_cells', 'elec_mah', 'elec_w'];
export const LIMITS = { max_speed_ms: [5, 150], fuel_l: [0, 500], fuel_km_per_l: [0.5, 500], elec_cells: [1, 16], elec_mah: [100, 200000], elec_w: [0, 2000] };
export const CAYMAZ_DEFAULTS = { max_speed_ms: 45, fuel_l: 5, fuel_km_per_l: 25, elec_cells: 4, elec_mah: 10000, elec_w: 30 };
export const COPTER_DEFAULTS = { max_speed_ms: null, fuel_l: 0, fuel_km_per_l: 25, elec_cells: 4, elec_mah: 10000, elec_w: 30 };
const PLANE_TYPES = ['sabit_kanat', 'vtol'];
const num = (v, d = null) => (v == null || v === '' || Number.isNaN(Number(v)) ? d : Number(v));
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
export const isPlaneType = t => PLANE_TYPES.includes(t);
export const defaultsFor = t => ({ ...(isPlaneType(t) ? CAYMAZ_DEFAULTS : COPTER_DEFAULTS) });

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
