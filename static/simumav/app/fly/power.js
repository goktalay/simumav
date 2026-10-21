// SIMUMAV › GÜÇ VE YAKIT (docs/simumav.md §10) — saf katman (node testi: tests/test_simumav_power.mjs) + oyun tarzı DOM parçaları (h parametreyle).
// Sunucu eşleniği app/simumav/power.py; HEPGO çekirdeği app/flightsim_power.py + static/js/modules/flightsim_power.js (§23).
//   • Hangar kaydı `drone.power` = {engine 'fuel'|'electric', max_speed_ms, fuel_l, fuel_km_per_l, elec_cells, elec_mah, elec_w, defaults, measured:{fuel_km_per_l, elec_w, at}|null}
//   • Yakıtlı motor sabit kanat ailesinde (plane / interceptor / vtol) ve kara aracında (rover: varsayılan elektrikli, azami hız yok — SIM_Rover sabit;
//     §15); kopterde (multirotor / fpv / heli) elektrikli, yakıt 0, azami hız yok. Kara aracı varsayılanı çekirdek ROVER_VARSAYILAN ile aynı.
//   • Sihirbaz "Güç ve yakıt" adımı: hangar değerleri ön dolu; son uçuşun ölçümü (measured) "Önerilen" rozetiyle (tıkla → uygula); simülasyon hızı
//     1×/2×/4×/8× (sunucunun izin verdiği kadar: meta.power.speedups). `powerBody()` → POST /api/fly/start `power`, `speedup`.
//   • Uçuşta HEPGO kadranları (createPowerGauges; /sim/flightsim_power.js — kopya değil, aynı modül) SIMUMAV çevirisiyle (trPower).
export const FUEL_TYPES = ['plane', 'interceptor', 'vtol', 'rover'];
export const SPEED_TYPES = ['plane', 'interceptor', 'vtol'];   // azami hız (SITL itki ölçeği) anlamlı
// Kara aracı (app/flightsim_power.py ROVER_VARSAYILAN; HEPGO flightsim_power.js defaultsFor('rover') ile aynı): elektrikli, 4S 16000 mAh 60 W, yakıt seçilirse 12 km/L
export const ROVER_DEFAULTS = { max_speed_ms: null, fuel_l: 0, fuel_km_per_l: 12, elec_cells: 4, elec_mah: 16000, elec_w: 60 };
export const ROVER_FUEL_L = 20;   // elektrikliden yakıtlıya geçişte depo (sunucu power.ROVER_YAKIT_L)
export const ENGINES = ['fuel', 'electric'];
export const FIELDS = ['max_speed_ms', 'fuel_l', 'fuel_km_per_l', 'elec_cells', 'elec_mah', 'elec_w'];
// Sunucu (flightsim_power.SINIRLAR) ile aynı; meta.power.limits gelirse o kullanılır
export const DEFAULT_LIMITS = { max_speed_ms: [5, 150], fuel_l: [0, 500], fuel_km_per_l: [0.5, 500], elec_cells: [1, 16], elec_mah: [100, 200000], elec_w: [0, 2000] };
export const FUEL_MIN_L = 0.1;
export const CELL_V = 3.7;
export const SPEEDUPS = [0.25, 0.5, 1, 2, 4, 8];   // §35 ağır çekim (< 1)
export const STEP = { max_speed_ms: 1, fuel_l: 0.1, fuel_km_per_l: 0.5, elec_cells: 1, elec_mah: 100, elec_w: 1 };
export const canFuel = t => FUEL_TYPES.includes(t);
export const canSpeed = t => SPEED_TYPES.includes(t);
const fuelDefaultOn = t => canFuel(t) && t !== 'rover';   // kara aracı varsayılan elektrikli
const num = (v, d = null) => (v == null || v === '' || Number.isNaN(Number(v)) ? d : Number(v));
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

export const batteryWh = (mah, cells) => num(mah, 0) / 1000 * Math.round(num(cells, 0)) * CELL_V;
export const enduranceMin = p => { const wh = batteryWh(p?.elec_mah, p?.elec_cells), w = num(p?.elec_w, 0); return wh > 0 && w > 0 ? wh / w * 60 : null; };
export const rangeKm = p => (p?.engine === 'fuel' && num(p?.fuel_l, 0) > 0 ? num(p.fuel_l, 0) * num(p.fuel_km_per_l, 0) : null);
export const fmtMin = m => (m == null || !Number.isFinite(m) ? '—' : m >= 90 ? `${Math.floor(m / 60)}:${String(Math.round(m % 60)).padStart(2, '0')} h` : `${Math.round(m)} min`);
export const fmtKm = km => (km == null ? '—' : km >= 10 ? `${Math.round(km)} km` : km >= 1 ? `${km.toFixed(1)} km` : `${Math.round(km * 1000)} m`);

/** Değeri sınırlara kırp (tam sayı alanları yuvarlanır); geçersiz → null. */
export function clampField(k, v, limits = DEFAULT_LIMITS) {
  const n = num(v);
  if (n == null || !Number.isFinite(n)) return null;
  const [a, b] = limits[k] || [-Infinity, Infinity];
  const c = clamp(n, a, b);
  return k === 'elec_cells' ? Math.round(c) : Math.round(c * 100) / 100;
}

/** Dron kaydından (drone.power) tam ayar; yoksa tipe göre güvenli varsayılan. Kural: kopterde elektrikli + yakıt 0 + azami hız null. */
export function powerOf(drone) {
  const t = drone?.type || 'multirotor', p = drone?.power || {};
  const fuelOk = canFuel(t), rv = t === 'rover', D = rv ? ROVER_DEFAULTS : null;
  const out = {
    engine: fuelOk && p.engine === 'fuel' ? 'fuel' : (fuelDefaultOn(t) && p.engine == null && !drone?.power ? 'fuel' : 'electric'),
    max_speed_ms: canSpeed(t) ? num(p.max_speed_ms, 45) : null,
    fuel_l: num(p.fuel_l, rv ? D.fuel_l : fuelOk ? 5 : 0), fuel_km_per_l: num(p.fuel_km_per_l, rv ? D.fuel_km_per_l : 25),
    elec_cells: Math.round(num(p.elec_cells, 4)), elec_mah: num(p.elec_mah, rv ? D.elec_mah : fuelOk ? 10000 : 1500), elec_w: num(p.elec_w, rv ? D.elec_w : fuelOk ? 30 : 180),
  };
  if (out.engine !== 'fuel') out.fuel_l = 0;
  return out;
}

/** Son uçuş ölçümleri → öneriler {fuel_km_per_l?, elec_w?} (yalnız geçerli ve ayardan farklı olanlar). */
export function suggestionsOf(drone) {
  const m = drone?.power?.measured, p = powerOf(drone), out = {};
  if (!m) return out;
  if (p.engine === 'fuel' && num(m.fuel_km_per_l) > 0 && Math.abs(num(m.fuel_km_per_l) - p.fuel_km_per_l) > 0.005) out.fuel_km_per_l = num(m.fuel_km_per_l);
  if (num(m.elec_w) > 0 && Math.abs(num(m.elec_w) - p.elec_w) > 0.05) out.elec_w = num(m.elec_w);
  return out;
}

/** Sihirbaz durumu: {values, base (hangar), sug (öneri), applied:Set, speedup}. set/apply/reset; body() → start gövdesi parçası. */
export function createPowerState(drone, { limits = DEFAULT_LIMITS, speedups = SPEEDUPS, speedup = 1, autoSuggest = true } = {}) {
  const type = drone?.type || 'multirotor';
  const base = powerOf(drone), sug = suggestionsOf(drone);
  const S = { values: { ...base }, base, sug, applied: new Set(), speedup: speedups.includes(speedup) ? speedup : 1, type };
  // HEPGO davranışı: son ölçüm önerisi ön dolu gelir ("Önerilen" rozeti); kullanıcı ↺ ile hangar değerine döner
  if (autoSuggest) for (const [k, v] of Object.entries(sug)) { S.values[k] = clampField(k, v, limits); S.applied.add(k); }
  const set = (k, v) => {
    if (k === 'engine') { if (!canFuel(type) && v === 'fuel') return false; S.values.engine = v; if (v === 'electric') S.values.fuel_l = 0; else if (!(num(S.values.fuel_l, 0) >= FUEL_MIN_L)) S.values.fuel_l = base.engine === 'fuel' && base.fuel_l >= FUEL_MIN_L ? base.fuel_l : type === 'rover' ? ROVER_FUEL_L : 5; return true; }
    if (!FIELDS.includes(k)) return false;
    if (k === 'max_speed_ms' && !canSpeed(type)) return false;
    const c = clampField(k, v, limits); if (c == null) return false;
    S.values[k] = c; S.applied.delete(k); return true;
  };
  const apply = k => { if (sug[k] == null) return false; S.values[k] = clampField(k, sug[k], limits); S.applied.add(k); return true; };
  const reset = k => { S.values[k] = base[k]; S.applied.delete(k); };
  const setSpeedup = f => { if (speedups.includes(Number(f))) { S.speedup = Number(f); return true; } return false; };
  const body = () => {
    const v = S.values, out = { engine: canFuel(type) ? v.engine : 'electric', elec_cells: Math.round(v.elec_cells), elec_mah: v.elec_mah, elec_w: v.elec_w };
    if (canSpeed(type)) out.max_speed_ms = v.max_speed_ms;
    if (canFuel(type) && out.engine === 'fuel') { out.fuel_l = Math.max(FUEL_MIN_L, v.fuel_l); out.fuel_km_per_l = v.fuel_km_per_l; }
    return out;
  };
  const valid = () => FIELDS.every(k => S.values[k] == null || (Number.isFinite(S.values[k]) && S.values[k] >= (limits[k] || [-Infinity])[0] && S.values[k] <= (limits[k] || [0, Infinity])[1])) && (S.values.engine !== 'fuel' || S.values.fuel_l >= FUEL_MIN_L);
  return { state: S, set, apply, reset, setSpeedup, body, valid, get values() { return S.values; }, get speedup() { return S.speedup; }, get suggestions() { return sug; }, get base() { return base; }, type };
}

// ---------- HEPGO kadran modülünün Türkçe metinleri → SIMUMAV i18n anahtarları (power.*) ----------
export const TR_KEYS = {
  'YAKIT': 'power.g_fuel', 'HIZ': 'power.g_speed', 'MOTOR': 'power.g_engine', 'BATARYA': 'power.g_batt', 'ELEKTRİK': 'power.electric_badge',
  'YAKIT BİTTİ': 'power.fuel_empty', 'BATARYA BİTTİ': 'power.elec_empty', '% GAZ': 'power.u_thr', 'Güç ve yakıt': 'power.title', 'Kapat': 'power.close',
  'Güç paneli: ayrıntı için tıklayın': 'power.g_hint', 'Başlangıç': 'power.r_start', 'Tüketim ayarı': 'power.r_setting', 'Harcanan': 'power.r_used',
  'Anlık': 'power.r_now', 'Ölçülen': 'power.r_measured', 'Mesafe': 'power.r_dist', 'henüz yok': 'power.r_none', 'ort.': 'power.r_avg', 'SITL pili': 'power.sitl_batt',
  'Yakıt: mesafe + gaz kolu · Batarya: saatlik W + servo · Biterse yalnız uyarı, uçuş sürer': 'power.g_foot',
};
/** t(key, vars) (SIMUMAV i18n) → HEPGO modüllerine verilecek tr(s, vars): bilinen Türkçe metin anahtara çevrilir, diğerleri t'ye aynen. */
export const trPower = t => (s, p) => { const k = TR_KEYS[s]; if (k) { const v = t(k, p); if (v && v !== k) return v; } return t(s, p); };
/** HEPGO minText/lphText birimleri (dk, sa, L/sa) — yerelleştirme: kadran alt yazısında metin değişimi. */
export function localizeUnits(s, u = {}) {
  if (!s || !u.min) return s;
  return String(s).replace(/(\d+) sa (\d+) dk/g, (m, a, b) => `${a} ${u.h} ${b} ${u.min}`).replace(/(\d+) dk\b/g, (m, a) => `${a} ${u.min}`).replace(/ L\/sa\b/g, ` L/${u.h}`);
}

/** Uçuş sırasında WS `warn` (core GucDurumu): kind fuel_empty | elec_empty → {key, sev} (oyun bildirimi + ses). */
export const warnInfo = m => (m?.kind === 'fuel_empty' ? { key: 'power.toast_fuel_empty', sev: 'error', power: true } : m?.kind === 'elec_empty' ? { key: 'power.toast_elec_empty', sev: 'error', power: true } : null);

/** Uçuş özeti (summary.power) → rapor kartı satırları (saf; DOM'suz): [{k, v, unit, cls}] ve notlar. */
export function reportModel(pw, settings = null) {
  if (!pw || (!pw.fuel && !pw.elec)) return null;
  const F = pw.fuel, E = pw.elec, S = pw.settings || settings || {};
  const clock = s => { s = Math.max(0, Math.floor(Number(s) || 0)); return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`; };
  const tiles = [{ k: 'power.r_dist', v: fmtKm(num(pw.dist_m, 0) / 1000), unit: '' }];
  if (F) tiles.push({ k: 'power.fuel_used', v: num(F.used_l, 0).toFixed(2), unit: 'L', cls: F.empty_t != null ? 'bad' : '' }, { k: 'power.kml_measured', v: F.km_per_l != null ? Number(F.km_per_l).toFixed(1) : '—', unit: 'km/L', cls: F.km_per_l != null ? 'ok' : '' });
  if (E) tiles.push({ k: 'power.wh_used', v: num(E.wh_used, 0).toFixed(1), unit: 'Wh', cls: E.empty_t != null ? 'bad' : '' }, { k: 'power.w_avg', v: E.w_avg != null ? Number(E.w_avg).toFixed(1) : '—', unit: 'W', cls: E.w_avg != null ? 'ok' : '' });
  const events = [];
  if (F?.empty_t != null) events.push({ key: 'power.ev_fuel_empty', t: clock(F.empty_t) });
  if (E?.empty_t != null) events.push({ key: 'power.ev_elec_empty', t: clock(E.empty_t) });
  const bars = [];
  if (F) bars.push({ key: 'power.g_fuel', pct: clamp(num(F.pct, F.start_l ? 100 * num(F.left_l, 0) / num(F.start_l, 1) : 0), 0, 100), text: `${num(F.left_l, 0).toFixed(2)} / ${num(F.start_l, 0).toFixed(2)} L` });
  if (E) bars.push({ key: 'power.g_batt', pct: clamp(num(E.pct, 0), 0, 100), text: `${num(E.wh_left, 0).toFixed(1)} / ${num(E.wh_cap, 0).toFixed(0)} Wh` });
  return { tiles, events, bars, written: pw.drone_written || null, speedupMax: pw.speedup?.max || 1, maxSpeed: S.max_speed_ms || null, maxSeen: pw.max_speed_seen ?? null };
}

// ======================================================================
// DOM (h = static/simumav/app/fly/simui.js ya da core/dom.js h; t = i18n)
// ======================================================================
const ICO = {
  fuel: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 21V5a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2v16"/><path d="M4 21h12"/><path d="M7 7h6v4H7z"/><path d="M15 9h2a2 2 0 0 1 2 2v5a1.5 1.5 0 0 0 3 0V9l-2-2"/></svg>',
  elec: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2.5" y="7" width="16" height="10" rx="2"/><path d="M21 11v2"/><path d="M11.5 8.5 8.5 12.5h3.5l-1.5 3"/></svg>',
  speed: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 16a8 8 0 1 1 16 0"/><path d="M12 16l4-5"/><circle cx="12" cy="16" r="1.4"/></svg>',
  clock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
};
export const POWER_ICONS = ICO;
// İkon: iki h() sürümü de (simui `html` destekler, core/dom desteklemez) çalışsın diye innerHTML doğrudan
const ico = (h, name) => { const i = h('i', { class: 'sm-pw-ico', 'aria-hidden': 'true' }); i.innerHTML = ICO[name] || ''; return i; };
const bar = (h, pct, cls) => { const i = h('i', { class: cls }); i.style.width = `${pct.toFixed(1)}%`; return i; };

/** Sihirbaz "Güç ve yakıt" kartı (oyun tarzı). deps {h, t, drone, limits, speedups, maxSpeedup, onChange, preset:{power, speedup}}. Dönüş {el, ps (createPowerState), redraw}. */
export function createPowerStep({ h, t, drone, limits = DEFAULT_LIMITS, speedups = SPEEDUPS, onChange = () => {}, preset = null, showSpeed = true, autoSuggest = true }) {
  const ps = createPowerState(drone, { limits, speedups, speedup: preset?.speedup ?? 1, autoSuggest });
  if (preset?.values) for (const k of ['engine', ...FIELDS]) if (preset.values[k] != null) { if (k === 'engine') ps.set('engine', preset.values.engine); else { ps.state.values[k] = preset.values[k]; } }
  if (preset?.applied) { ps.state.applied.clear(); for (const k of preset.applied) ps.state.applied.add(k); }
  const fuelOk = canFuel(ps.type), speedOk = canSpeed(ps.type), rover = ps.type === 'rover';
  const el = h('div', { class: 'sm-pw' });
  const field = (k, label, unit, hint) => {
    const inp = h('input', { class: 'sm-pw-inp mono', type: 'number', min: limits[k][0], max: limits[k][1], step: STEP[k], inputmode: 'decimal', value: String(ps.values[k] ?? ''), 'data-pw': k });
    const range = h('input', { class: 'sm-pw-range', type: 'range', min: limits[k][0], max: Math.min(limits[k][1], RANGE_MAX[k] ?? limits[k][1]), step: STEP[k], value: String(ps.values[k] ?? 0), 'aria-label': label });
    const badge = h('span', { class: 'sm-pw-badge' });
    const row = h('div', { class: 'sm-pw-field', 'data-pw': k }, h('div', { class: 'sm-pw-lbl' }, h('span', null, label), badge), h('div', { class: 'sm-pw-ctl' }, range, h('label', { class: 'sm-pw-val' }, inp, h('i', null, unit))), hint ? h('small', { class: 'sm-pw-hint' }, hint) : null);
    const sync = () => {
      inp.value = String(ps.values[k] ?? ''); range.value = String(ps.values[k] ?? 0);
      const s = ps.suggestions[k], on = ps.state.applied.has(k);
      clear(badge);
      if (s != null && on) badge.append(h('button', { class: 'sm-pw-chip sug on', type: 'button', title: t('power.suggest_reset', { v: ps.base[k] }), onclick: () => { ps.reset(k); redraw(); onChange(ps); } }, '★ ', t('power.suggested'), ' ↺'));
      else if (s != null) badge.append(h('button', { class: 'sm-pw-chip sug', type: 'button', title: t('power.suggest_apply'), onclick: () => { ps.apply(k); redraw(); onChange(ps); } }, '★ ', t('power.suggested'), `: ${s}`));
      else if (ps.values[k] === ps.base[k]) badge.append(h('span', { class: 'sm-pw-chip hangar' }, t('power.from_hangar')));
    };
    inp.addEventListener('change', () => { if (ps.set(k, inp.value)) { redraw(); onChange(ps); } else inp.value = String(ps.values[k] ?? ''); });
    range.addEventListener('input', () => { if (ps.set(k, range.value)) { inp.value = String(ps.values[k]); drawStats(); syncAll(); onChange(ps); } });
    row.__sync = sync;
    return row;
  };
  const RANGE_MAX = { max_speed_ms: 150, fuel_l: 30, fuel_km_per_l: 100, elec_cells: 14, elec_mah: 30000, elec_w: 800 };
  const clear = (n, ...c) => { n.replaceChildren(); for (const x of c.flat()) if (x != null) n.append(x); };
  const engineSeg = fuelOk ? h('div', { class: 'sm-pw-seg', role: 'radiogroup', 'aria-label': t('power.engine') },
    ['fuel', 'electric'].map(e => h('button', { class: 'sm-pw-seg-btn', type: 'button', 'data-engine': e, onclick: () => { ps.set('engine', e); redraw(); onChange(ps); } }, ico(h, e === 'fuel' ? 'fuel' : 'elec'), h('b', null, t(`power.engine_${e}`)), h('small', null, t(`power.engine_${e}_desc`))))) : null;
  const rows = {
    max_speed_ms: speedOk ? field('max_speed_ms', t('power.max_speed'), 'm/s', t('power.max_speed_hint')) : null,
    fuel_l: fuelOk ? field('fuel_l', t('power.fuel_tank'), 'L', null) : null,
    fuel_km_per_l: fuelOk ? field('fuel_km_per_l', t('power.consumption'), 'km/L', t('power.consumption_hint')) : null,
    elec_cells: field('elec_cells', t('power.cells'), 'S', null),
    elec_mah: field('elec_mah', t('power.capacity'), 'mAh', null),
    elec_w: field('elec_w', t('power.hourly_w'), 'W', rover ? t('power.hourly_w_hint_rover') : fuelOk ? t('power.hourly_w_hint_plane') : t('power.hourly_w_hint_copter')),
  };
  const syncAll = () => { for (const r of Object.values(rows)) r?.__sync(); };
  const stats = h('div', { class: 'sm-pw-stats' });
  const drawStats = () => {
    const v = ps.values, wh = batteryWh(v.elec_mah, v.elec_cells), end = enduranceMin(v), rng = rangeKm(v);
    const stat = (icon, val, lbl, cls = '') => h('div', { class: `sm-pw-stat ${cls}` }, ico(h, icon), h('b', { class: 'mono' }, val), h('small', null, lbl));
    clear(stats,
      speedOk && v.max_speed_ms ? stat('speed', `${Math.round(v.max_speed_ms * 3.6)} km/h`, t('power.stat_top')) : null,
      v.engine === 'fuel' ? stat('fuel', fmtKm(rng), t('power.stat_range'), 'fuel') : null,
      stat('elec', `${wh.toFixed(0)} Wh`, `${Math.round(v.elec_cells)}S · ${(Math.round(v.elec_cells) * CELL_V).toFixed(1)} V`, 'elec'),
      stat('clock', fmtMin(end), t('power.stat_endurance'), 'elec'));
  };
  const colMotor = fuelOk ? h('section', { class: 'sm-pw-col motor' }, h('h3', null, ico(h, 'fuel'), t('power.col_motor')), engineSeg, rows.max_speed_ms, rows.fuel_l, rows.fuel_km_per_l) : null;
  const colBatt = h('section', { class: 'sm-pw-col batt' }, h('h3', null, ico(h, 'elec'), t(rover ? 'power.col_batt_rover' : fuelOk ? 'power.col_batt_plane' : 'power.col_batt')), rows.elec_cells, rows.elec_mah, rows.elec_w);
  const spdBtns = speedups.map(x => h('button', { class: 'sm-pw-spd', type: 'button', 'data-speed': x, onclick: () => { ps.setSpeedup(x); redraw(); onChange(ps); } }, `${x}×`));
  const spd = h('section', { class: 'sm-pw-speed' }, h('div', null, h('b', null, t('power.sim_speed')), h('small', null, t('power.sim_speed_hint'))), h('div', { class: 'sm-pw-spds' }, spdBtns));
  const measured = drone?.power?.measured;
  const note = h('p', { class: 'sm-pw-note' }, measured ? t('power.note_measured', { at: String(measured.at || '').slice(0, 16).replace('T', ' ') }) : t('power.note_first'));
  el.append(...[stats, h('div', { class: `sm-pw-grid ${fuelOk ? '' : 'one'}` }, colMotor, colBatt), showSpeed ? spd : null, note].filter(Boolean));
  const redraw = () => {
    el.dataset.engine = ps.values.engine;
    if (engineSeg) for (const b of engineSeg.children) b.classList.toggle('on', b.dataset.engine === ps.values.engine);
    for (const k of ['fuel_l', 'fuel_km_per_l']) if (rows[k]) rows[k].hidden = ps.values.engine !== 'fuel';
    for (const b of spdBtns) b.classList.toggle('on', Number(b.dataset.speed) === ps.speedup);
    syncAll(); drawStats();
  };
  redraw();
  return { el, ps, redraw };
}

/** Hangar şeridi / katalog kartı küçük etiketi: ikon + "5 L" ya da "4S 1500". */
export function powerTag({ h, p, extra = '' }) {
  if (!p) return null;
  const el = h('small', { class: `pw-tag ${p.engine}` }, ico(h, p.engine === 'fuel' ? 'fuel' : 'elec'), p.engine === 'fuel' ? `${p.fuel_l} L${extra}` : `${Math.round(p.elec_cells)}S ${p.elec_mah}${extra}`);
  return el;
}

/** Hangar güç özeti (oyun kartı): motor rozeti + 3–4 stat + son ölçüm. */
export function powerSummary({ h, t, drone }) {
  const p = powerOf(drone), m = drone?.power?.measured, speedOk = canSpeed(drone?.type);
  const chip = (icon, v, l, cls = '') => h('div', { class: `pw-chip ${cls}` }, ico(h, icon), h('b', { class: 'mono' }, v), h('small', null, l));
  return h('div', { class: 'pw-summary', 'data-engine': p.engine },
    h('span', { class: `pw-engine ${p.engine}` }, t(`power.engine_${p.engine}`)),
    speedOk && p.max_speed_ms ? chip('speed', `${Math.round(p.max_speed_ms * 3.6)}`, 'km/h') : null,
    p.engine === 'fuel' ? chip('fuel', `${p.fuel_l} L`, `${p.fuel_km_per_l} km/L`, 'fuel') : null,
    chip('elec', `${Math.round(p.elec_cells)}S ${p.elec_mah}`, `mAh · ${p.elec_w} W`, 'elec'),
    chip('clock', fmtMin(enduranceMin(p)), t('power.stat_endurance'), 'elec'),
    m ? h('span', { class: 'pw-measured', title: t('power.measured_title') }, '★ ', [m.fuel_km_per_l != null ? `${m.fuel_km_per_l} km/L` : null, m.elec_w != null ? `${m.elec_w} W` : null].filter(Boolean).join(' · ')) : null);
}

/** Rapor kartı (uçuş sonu / operasyon). */
export function powerReportCard({ h, t, pw }) {
  const M = reportModel(pw);
  if (!M) return null;
  return h('section', { class: 'sm-pw-report' },
    h('h3', null, '⚡ ', t('power.title')),
    h('div', { class: 'sm-pw-tiles' }, M.tiles.map(x => h('div', { class: `sm-pw-tile ${x.cls || ''}` }, h('b', { class: 'mono' }, x.v, x.unit ? h('i', null, ` ${x.unit}`) : null), h('small', null, t(x.k))))),
    h('div', { class: 'sm-pw-bars' }, M.bars.map(b => h('div', { class: 'sm-pw-bar' }, h('span', null, t(b.key)), h('div', { class: 'sm-pw-bar-track' }, bar(h, b.pct, b.pct < 15 ? 'crit' : b.pct < 30 ? 'low' : '')), h('small', { class: 'mono' }, b.text)))),
    M.events.length ? h('ul', { class: 'sm-pw-events' }, M.events.map(e => h('li', null, t(e.key, { t: e.t })))) : null,
    M.written ? h('p', { class: 'sm-pw-written' }, '★ ', t('power.written', { v: [M.written.fuel_km_per_l_last != null ? `${M.written.fuel_km_per_l_last} km/L` : null, M.written.elec_w_last != null ? `${M.written.elec_w_last} W` : null].filter(Boolean).join(' · ') })) : null,
    M.speedupMax > 1 ? h('p', { class: 'sm-pw-sub' }, t('power.speedup_used', { x: M.speedupMax })) : null);
}
