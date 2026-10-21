// SIMUMAV güç ve yakıt — tarayıcısız birim testleri (static/simumav/app/fly/power.js saf katmanı; docs/simumav.md §10).
// Çalıştırma: node tests/test_simumav_power.mjs
//   • powerOf: kopterde elektrikli/yakıt 0/azami hız yok; uçakta kayıt değerleri; kayıtsız uçak → yakıtlı varsayılan
//   • suggestionsOf / createPowerState: son uçuş ölçümü "Önerilen" olarak ön dolu (autoSuggest), reset → hangar, apply; sınır kırpma; motor türü
//     geçişi (yakıt deposu tip varsayılanı); kopterde yakıt seçilemez; simülasyon hızı yalnız izinli değerler; body() sunucu biçimi
//   • trPower: HEPGO kadran metinleri → i18n anahtarları; localizeUnits; warnInfo; reportModel (karolar, bitme anları, çubuklar)
//   • HEPGO flightsim_power.js ile uyum: aynı Wh formülü, LIMITS sunucu SINIRLAR ile eşit
import assert from 'node:assert/strict';
import { powerOf, suggestionsOf, createPowerState, trPower, localizeUnits, warnInfo, reportModel, batteryWh, enduranceMin, rangeKm, clampField, canFuel, canSpeed, ROVER_DEFAULTS, ROVER_FUEL_L, DEFAULT_LIMITS, FUEL_MIN_L, TR_KEYS } from '../static/simumav/app/fly/power.js';
import { batteryWh as hepgoWh, LIMITS as HEPGO_LIMITS, defaultsFor as hepgoDefaults } from '../static/js/modules/flightsim_power.js';

let n = 0;
const test = (name, fn) => { fn(); n++; console.log('  ✓', name); };

const FPV = { id: 1, type: 'fpv', power: { engine: 'electric', max_speed_ms: null, fuel_l: 0, fuel_km_per_l: 25, elec_cells: 4, elec_mah: 1500, elec_w: 180, defaults: true, measured: null } };
const CAY = { id: 2, type: 'plane', power: { engine: 'fuel', max_speed_ms: 45, fuel_l: 5, fuel_km_per_l: 25, elec_cells: 4, elec_mah: 10000, elec_w: 30, defaults: false, measured: { fuel_km_per_l: 31.4, elec_w: 33.2, at: '2026-10-20T12:00:00' } } };

test('powerOf: kopter elektrikli (yakıt 0, azami hız null); uçak kayıt değerleri; kayıtsız uçak yakıtlı varsayılan', () => {
  assert.deepEqual(powerOf(FPV), { engine: 'electric', max_speed_ms: null, fuel_l: 0, fuel_km_per_l: 25, elec_cells: 4, elec_mah: 1500, elec_w: 180 });
  assert.equal(powerOf({ type: 'fpv', power: { engine: 'fuel', fuel_l: 9, max_speed_ms: 80 } }).engine, 'electric', 'kopterde yakıtlı motor olmaz');
  assert.equal(powerOf({ type: 'heli', power: { engine: 'fuel', fuel_l: 9 } }).fuel_l, 0);
  assert.equal(powerOf(CAY).max_speed_ms, 45); assert.equal(powerOf(CAY).fuel_l, 5);
  assert.equal(powerOf({ type: 'interceptor' }).engine, 'fuel');
  assert.ok(canFuel('vtol') && canFuel('interceptor') && !canFuel('multirotor'));
});
test('öneriler: ölçüm ayardan farklıysa; yakıt ölçümü yalnız yakıtlı motorda; autoSuggest ön dolu → reset → apply', () => {
  assert.deepEqual(suggestionsOf(CAY), { fuel_km_per_l: 31.4, elec_w: 33.2 });
  assert.deepEqual(suggestionsOf({ ...CAY, power: { ...CAY.power, engine: 'electric' } }), { elec_w: 33.2 });
  assert.deepEqual(suggestionsOf(FPV), {});
  const ps = createPowerState(CAY);
  assert.equal(ps.values.fuel_km_per_l, 31.4); assert.ok(ps.state.applied.has('fuel_km_per_l'));
  ps.reset('fuel_km_per_l'); assert.equal(ps.values.fuel_km_per_l, 25); assert.ok(!ps.state.applied.has('fuel_km_per_l'));
  ps.apply('fuel_km_per_l'); assert.equal(ps.values.fuel_km_per_l, 31.4);
  ps.set('elec_w', 40); assert.equal(ps.values.elec_w, 40); assert.ok(!ps.state.applied.has('elec_w'), 'kullanıcı yazınca rozet kalkar');
  const ps2 = createPowerState(CAY, { autoSuggest: false }); assert.equal(ps2.values.fuel_km_per_l, 25);
});
test('sınırlar ve motor geçişi: kırpma, geçersiz giriş, yakıtlıya dönüşte depo, kopterde yakıt/azami hız reddi', () => {
  const ps = createPowerState(CAY);
  ps.set('max_speed_ms', 999); assert.equal(ps.values.max_speed_ms, 150);
  ps.set('elec_cells', 3.6); assert.equal(ps.values.elec_cells, 4);
  assert.equal(ps.set('fuel_l', 'abc'), false); assert.equal(ps.set('hack', 1), false);
  ps.set('engine', 'electric'); assert.equal(ps.values.fuel_l, 0); assert.equal(ps.body().fuel_l, undefined, 'elektrikli: yakıt gövdede yok');
  ps.set('engine', 'fuel'); assert.equal(ps.values.fuel_l, 5, 'hangar deposu'); assert.ok(ps.body().fuel_l >= FUEL_MIN_L);
  const pq = createPowerState(FPV);
  assert.equal(pq.set('engine', 'fuel'), false); assert.equal(pq.set('max_speed_ms', 50), false);
  assert.deepEqual(pq.body(), { engine: 'electric', elec_cells: 4, elec_mah: 1500, elec_w: 180 });
  assert.equal(clampField('elec_mah', 50), 100); assert.equal(clampField('elec_w', null), null);
  assert.ok(pq.valid());
});
test('simülasyon hızı: yalnız izinli değerler (sunucu meta.power.speedups)', () => {
  const ps = createPowerState(FPV, { speedups: [1, 2, 4], speedup: 8 });
  assert.equal(ps.speedup, 1); assert.equal(ps.setSpeedup(8), false); assert.ok(ps.setSpeedup(4)); assert.equal(ps.speedup, 4);
});
test('hesaplar: Wh (HEPGO ile aynı), dayanım dk, menzil km', () => {
  assert.equal(batteryWh(1500, 4), hepgoWh(1500, 4)); assert.equal(Math.round(batteryWh(10000, 4)), 148);
  assert.equal(Math.round(enduranceMin(powerOf(FPV))), 7);
  assert.equal(rangeKm(powerOf(CAY)), 125); assert.equal(rangeKm(powerOf(FPV)), null);
  assert.deepEqual(DEFAULT_LIMITS, HEPGO_LIMITS, 'istemci sınırları HEPGO/sunucu ile aynı');
});
test('çeviri köprüsü: HEPGO kadran metinleri → power.* anahtarları; birim yerelleştirme; WS warn', () => {
  const dict = { 'power.g_fuel': 'FUEL', 'power.fuel_empty': 'FUEL EMPTY' };
  const t = (k, p) => dict[k] ?? k;
  const trp = trPower(t);
  assert.equal(trp('YAKIT'), 'FUEL'); assert.equal(trp('YAKIT BİTTİ'), 'FUEL EMPTY'); assert.equal(trp('MOTOR'), 'MOTOR', 'çeviri yoksa metin aynen');
  assert.ok(Object.values(TR_KEYS).every(k => k.startsWith('power.')));
  assert.equal(localizeUnits('16.2 V · ≈ 7 dk', { min: 'min', h: 'h' }), '16.2 V · ≈ 7 min');
  assert.equal(localizeUnits('≈ 2 sa 5 dk', { min: 'min', h: 'h' }), '≈ 2 h 5 min');
  assert.equal(localizeUnits('0.41 L/sa', { min: 'min', h: 'h' }), '0.41 L/h');
  assert.deepEqual(warnInfo({ t: 'warn', kind: 'fuel_empty' }).key, 'power.toast_fuel_empty');
  assert.equal(warnInfo({ t: 'warn', text: 'çarpışma' }), null);
});
test('rapor modeli: karolar, bitme anları, çubuklar, drona yazılan', () => {
  const pw = { dist_m: 2364, time_s: 120, max_speed_seen: 40, settings: { max_speed_ms: 45 }, speedup: { max: 4 },
    fuel: { start_l: 0.1, used_l: 0.1, left_l: 0, pct: 0, km_per_l: 23.6, empty_t: 34.7 }, elec: { wh_cap: 0.37, wh_used: 0.37, wh_left: 0, pct: 0, w_avg: 20.1, empty_t: 66 },
    drone_written: { fuel_km_per_l_last: 23.6, elec_w_last: 20.1 } };
  const M = reportModel(pw);
  assert.deepEqual(M.tiles.map(x => x.k), ['power.r_dist', 'power.fuel_used', 'power.kml_measured', 'power.wh_used', 'power.w_avg']);
  assert.equal(M.tiles[0].v, '2.4 km'); assert.equal(M.tiles[2].v, '23.6'); assert.equal(M.tiles[1].cls, 'bad');
  assert.deepEqual(M.events, [{ key: 'power.ev_fuel_empty', t: '00:34' }, { key: 'power.ev_elec_empty', t: '01:06' }]);
  assert.equal(M.bars.length, 2); assert.equal(M.speedupMax, 4); assert.deepEqual(M.written, pw.drone_written);
  assert.equal(reportModel({ dist_m: 1 }), null); assert.equal(reportModel(null), null);
});
test('§15 kara aracı: elektrik varsayılan (HEPGO defaultsFor(\'rover\') ile aynı), yakıt isteğe bağlı (20 L), azami hız yok', () => {
  assert.ok(canFuel('rover') && !canSpeed('rover') && canSpeed('plane'));
  const H = hepgoDefaults('rover');
  for (const k of ['fuel_l', 'fuel_km_per_l', 'elec_cells', 'elec_mah', 'elec_w']) assert.equal(ROVER_DEFAULTS[k], H[k], k);
  assert.equal(H.max_speed_ms ?? null, null);
  const p0 = powerOf({ type: 'rover' });
  assert.deepEqual(p0, { engine: 'electric', max_speed_ms: null, fuel_l: 0, fuel_km_per_l: 12, elec_cells: 4, elec_mah: 16000, elec_w: 60 });
  const ps = createPowerState({ type: 'rover' });
  assert.ok(!ps.set('max_speed_ms', 30), 'azami hız yok');
  assert.deepEqual(ps.body(), { engine: 'electric', elec_cells: 4, elec_mah: 16000, elec_w: 60 });
  assert.ok(ps.set('engine', 'fuel')); assert.equal(ps.values.fuel_l, ROVER_FUEL_L);
  assert.deepEqual(ps.body(), { engine: 'fuel', elec_cells: 4, elec_mah: 16000, elec_w: 60, fuel_l: 20, fuel_km_per_l: 12 });
  assert.equal(powerOf({ type: 'rover', power: { engine: 'fuel', fuel_l: 8, fuel_km_per_l: 9, max_speed_ms: 50 } }).max_speed_ms, null);
});
console.log(`\n${n} test geçti`);
