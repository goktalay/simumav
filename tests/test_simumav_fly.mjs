// SIMUMAV › Uç — tarayıcısız birim testleri (static/simumav/app/fly/*.js saf katmanlar). Çalıştırma: node tests/test_simumav_fly.mjs
//   • wizard.js: adım makinesi (kalkış adımı yalnız sabit kanat ailesinde; parkur değişince görev sıfırlanır; payload), kalkış normalizasyonu,
//     hız ölçeği (interceptor 600 km/h) + iğne açısı, model eşlemesi, parkur world → HEPGO dünya, geri sayım kareleri
//   • hand_launch.js: elden atış zaman çizelgesi (idle → armed → launch[geri/ileri] → released → free), bırakma zamanı, telemetri kaydırması
//     (omuz yüksekliği, ileri ofset, bırakmada erime), kayıttan oynatma aşamaları (replayHandTimeline / replayHandPhaseAt)
//   • gates.js: düzlem kesişimi (içinde / dışında / ters yön / düzlem geçilmedi), izleyici (pass/miss/atlama/ters yön/tur/bitiş), replayGatesAt, gateStats
//   • session.js: installWsBridge (yalnız /ws/drone/live yolu yönlendirilir) — DOM gerektirmeyen kısım sahte `win` ile
import assert from 'node:assert/strict';
import { createWizard, normLaunch, launchBody, speedScale, speedAngle, speedTicks, modelFor, worldFromTrack, countdownAt, needsLaunch, simType, STEPS, timeOfDay } from '../static/simumav/app/fly/wizard.js';
import { HAND, handPoseAt, handReleaseTime, shimTelemetry, replayHandTimeline, replayHandPhaseAt, replayHandPhaseStart, handCfg, REPLAY_HAND_RELEASE } from '../static/simumav/app/fly/hand_launch.js';
import { crossing, createGateTracker, gateLocal, localFrom, replayGatesAt, gateStats, MISS_FACTOR } from '../static/simumav/app/fly/gates.js';

let n = 0;
const test = (name, fn) => { fn(); n++; console.log('  ✓', name); };
const near = (a, b, eps = 1e-6, msg) => assert.ok(Math.abs(a - b) <= eps, msg || `${a} ≈ ${b}`);

const DATA = {
  drones: [{ id: 1, name: 'FPV-1', type: 'fpv', model_key: 'proc:quad250', is_default: 1 }, { id: 2, name: 'Caymaz', type: 'plane', model_key: 'proc:caymaz' }, { id: 3, name: 'Şahin', type: 'interceptor', model_key: 'proc:interceptor' }, { id: 4, name: 'Heli', type: 'heli', model_key: 'lib-heli', preview: '/files/heli.glb' }],
  tracks: [{ id: 10, name: 'TRTEST', lat: 40.099, lon: 33.4101, radius_m: 1500, is_default: 1, world_mode: 'google3d', world: { trees_pct: 40, fog_pct: 20, runway_deg: 90 }, gates: [] }, { id: 11, name: 'Göl', lat: 40.2, lon: 33.5, radius_m: 800, world_mode: 'real' }],
  pilots: [{ id: 100, name: 'Pilot', is_default: 1 }, { id: 101, name: 'Ayşe' }],
  missions: [{ id: 7, track_id: 10, name: 'Halka turu', kind: 'fpv_gates', plan: { order: [1, 2, 3], laps: 2 } }, { id: 8, track_id: 11, name: 'Koridor', kind: 'corridor', plan: { route: [] } }],
};

console.log('wizard.js');
test('varsayılanlar: varsayılan dron/parkur/pilot seçili; adımlar kopterde 4 (kalkış yok), sabit kanatta 5', () => {
  const W = createWizard(DATA);
  assert.equal(W.state.drone_id, 1); assert.equal(W.state.track_id, 10); assert.equal(W.state.pilot_id, 100);
  assert.deepEqual(W.steps(), ['drone', 'track', 'mission', 'pilot']);
  W.set('drone_id', 2); assert.deepEqual(W.steps(), STEPS);
  W.set('drone_id', 3); assert.ok(needsLaunch('interceptor')); assert.equal(simType('interceptor'), 'sabit_kanat');
  assert.equal(simType('fpv'), 'multirotor'); assert.equal(simType('heli'), 'helikopter'); assert.equal(simType('vtol'), 'vtol');
});
test('ileri/geri: canNext, isLast, goto yalnız geriye; parkur değişince görev sıfırlanır; görevler parkura süzülür', () => {
  const W = createWizard(DATA, { drone_id: 2 });
  assert.equal(W.step(), 'drone'); assert.ok(W.canNext()); assert.ok(W.next()); assert.equal(W.step(), 'track');
  assert.ok(W.next()); assert.equal(W.step(), 'launch'); assert.ok(W.next()); assert.equal(W.step(), 'mission');
  assert.deepEqual(W.missionsFor().map(m => m.id), [7]);
  W.set('mission_id', 7); assert.equal(W.mission().name, 'Halka turu');
  W.set('track_id', 11); assert.equal(W.state.mission_id, null, 'parkur değişti → görev sıfır'); assert.deepEqual(W.missionsFor().map(m => m.id), [8]);
  assert.ok(W.next()); assert.equal(W.step(), 'pilot'); assert.ok(W.isLast()); assert.equal(W.next(), false);
  assert.equal(W.goto('track'), true); assert.equal(W.step(), 'track'); assert.equal(W.goto('pilot'), false, 'ileriye atlanamaz');
  assert.ok(W.prev()); assert.equal(W.step(), 'drone'); assert.equal(W.prev(), false);
});
test('payload: start gövdesi (§4) — kopterde launch wheels nötr; sabit kanatta elden atış alanları; kayıt seçenekleri', () => {
  const W = createWizard(DATA);
  assert.deepEqual(W.payload(), { drone_id: 1, pilot_id: 100, track_id: 10, record: { video: false, bin: true }, launch: { method: 'wheels' } });
  W.set('drone_id', 2); W.set('launch', { method: 'hand', hand_speed_ms: 9.5, hand_pitch_deg: 5 }); W.set('record', { video: true, bin: false }); W.set('mission_id', 7);
  const p = W.payload();
  assert.deepEqual(p.launch, { method: 'hand', angle_deg: 15, release_kmh: 70, hand_speed_ms: 8, hand_pitch_deg: 10 }, 'sınırlara kırpılır');
  assert.equal(p.mission_id, 7); assert.deepEqual(p.record, { video: true, bin: false });
  W.set('launch', { method: 'ramp', angle_deg: 45 }); assert.deepEqual(W.payload().launch, { method: 'ramp', angle_deg: 30, release_kmh: 70 });
  W.set('launch', { method: 'yok' }); assert.equal(W.state.launch.method, 'hand', 'bilinmeyen yöntem → varsayılan');
  assert.equal(normLaunch({ method: 'vehicle', release_kmh: 10 }).release_kmh, 40);
  assert.deepEqual(launchBody({ method: 'wheels' }), { method: 'wheels', angle_deg: 15, release_kmh: 70 });
  const W2 = createWizard({ drones: [], tracks: [], pilots: [] }); assert.equal(W2.payload(), null); assert.equal(W2.ready(), false);
});
test('hız ölçeği: interceptor 600 km/h, çentikler 100\'lük; iğne −120°…+120°; kopter 100', () => {
  assert.equal(speedScale('interceptor'), 600); assert.equal(speedScale('multirotor'), 100); assert.equal(speedScale('plane'), 200);
  assert.deepEqual(speedTicks(600), [0, 100, 200, 300, 400, 500, 600]); assert.deepEqual(speedTicks(100), [0, 20, 40, 60, 80, 100]);
  assert.equal(speedAngle(0, 600), -120); assert.equal(speedAngle(300, 600), 0); assert.equal(speedAngle(600, 600), 120); assert.equal(speedAngle(900, 600), 120, 'kırpılır');
});
test('model eşlemesi: proc şablonları dahili modele; kütüphane + preview → glb_url; bilinmeyen → tipe göre', () => {
  assert.deepEqual(modelFor(DATA.drones[0]), { id: 'builtin:quad' }); assert.deepEqual(modelFor(DATA.drones[1]), { id: 'builtin:caymaz' }); assert.deepEqual(modelFor(DATA.drones[2]), { id: 'builtin:delta' });
  assert.deepEqual(modelFor(DATA.drones[3]), { id: 'lib-heli', glb_url: '/files/heli.glb', orient: undefined });
  assert.deepEqual(modelFor({ type: 'heli' }), { id: 'builtin:heli' }); assert.deepEqual(modelFor({ type: 'vtol', model_key: 'proc:bilinmez' }), { id: 'builtin:caymaz' });
});
test('parkur → dünya: google3d anahtar yoksa prosedürel; real/procedural korunur; yüzdeler 0…1; pist yönü; saat eşlemesi', () => {
  const w = worldFromTrack(DATA.tracks[0], null);
  assert.equal(w.mode, 'procedural'); near(w.tree_density, 0.4); near(w.fog, 0.2); assert.equal(w.runway_heading, 90); assert.equal(w.size_m, 3750);
  assert.equal(worldFromTrack(DATA.tracks[0], 'ANAHTAR').mode, 'google3d');
  const r = worldFromTrack(DATA.tracks[1], null); assert.equal(r.mode, 'real'); assert.equal(r.building_count, 0, 'gerçek kipte ek bina 0');
  assert.equal(worldFromTrack({ world_mode: 'procedural', world: { tree_density: 0.7, building_count: 12, time: 'night' } }, 'K').tree_density, 0.7);
  assert.equal(worldFromTrack({ world_mode: 'olmayan' }, 'K').mode, 'google3d', 'bilinmeyen kip → varsayılan google3d');
  assert.equal(timeOfDay('Akşam'), 'dusk'); assert.equal(timeOfDay(22), 'night'); assert.equal(timeOfDay(12), 'day'); assert.equal(timeOfDay(undefined), 'day');
});
test('geri sayım: 3 → 2 → 1 → BAŞLA; frac sayı içinde 0→1', () => {
  assert.equal(countdownAt(0).text, '3'); assert.equal(countdownAt(0.99).n, 3); near(countdownAt(0.5).frac, 0.5); assert.equal(countdownAt(1).text, '2'); assert.equal(countdownAt(2.2).text, '1');
  assert.deepEqual(countdownAt(3), { text: 'BAŞLA', n: 0, frac: 1, done: true }); assert.equal(countdownAt(1, 2).text, '1');
});

console.log('hand_launch.js');
test('elden atış zaman çizelgesi: idle/armed uçak elde (omuz 1,6 m, ileri 0,55 m); launch kol geri → ileri; bırakma back_s+swing_s = 0,7 sn', () => {
  const idle = handPoseAt('idle'); assert.equal(idle.hold, 1); near(idle.dz, HAND.shoulder_m); near(idle.dx, HAND.hand_fwd_m); assert.equal(idle.released, false);
  const armed = handPoseAt('armed', 1); assert.equal(armed.hold, 1); assert.ok(Math.abs(armed.dz - HAND.shoulder_m) < 0.03);
  const back = handPoseAt('launch', HAND.back_s * 0.999); assert.ok(back.dx < HAND.hand_fwd_m - 0.3, 'kol geri: uçak geriye'); assert.ok(back.arm < 30 * Math.PI / 180);
  const fwd = handPoseAt('launch', HAND.back_s + HAND.swing_s * 0.999); assert.ok(fwd.dx > HAND.hand_fwd_m + 0.5, 'kol ileri: uçak ileride'); assert.ok(fwd.arm > 130 * Math.PI / 180); assert.ok(fwd.roll_deg > 0 && fwd.roll_deg <= HAND.roll_deg, 'hafif yalpa');
  near(handReleaseTime(), 0.7);
  const rel0 = handPoseAt('launch', handReleaseTime() + 0.001); assert.equal(rel0.released, true); assert.equal(rel0.hold, 0);
  const relMid = handPoseAt('released', HAND.settle_s / 2); assert.ok(relMid.blend > 0.3 && relMid.blend < 0.7); assert.ok(relMid.dz < HAND.shoulder_m && relMid.dz > 0);
  const free = handPoseAt('free', 0); assert.equal(free.blend, 1); near(free.dz, 0); near(free.dx, 0); near(free.pitch_deg, 0);
  const cfg = handCfg({ hand_speed_ms: 12, hand_pitch_deg: 3 }); assert.equal(cfg.speed_ms, HAND.speed_max); assert.equal(cfg.pitch_deg, HAND.pitch_min);
});
test('telemetri kaydırması: elde iken alt_rel +1,6 m, pitch 12°, hız 0, konum heading boyunca ileri; bırakmada erir; free → aynen', () => {
  const t = { lat: 40, lon: 33, alt_rel: 0, alt_msl: 800, pitch: 0, roll: 0, groundspeed: 0.3, vn: 0.1, ve: 0, vd: 0, heading: 0 };
  const cfg = handCfg({ hand_pitch_deg: 12 });
  const held = shimTelemetry(t, handPoseAt('armed', 0, cfg), 0);
  near(held.alt_rel, cfg.shoulder_m, 0.03); near(held.alt_msl, 800 + cfg.shoulder_m, 0.03); near(held.pitch, 12 * Math.PI / 180); assert.equal(held.groundspeed, 0);
  assert.ok(held.lat > t.lat, 'kuzeye (heading 0) ileri'); near(held.lon, t.lon, 1e-9); near((held.lat - t.lat) * 110574, cfg.hand_fwd_m, 1e-3);
  const east = shimTelemetry(t, handPoseAt('armed', 0, cfg), 90); assert.ok(east.lon > t.lon); near(east.lat, t.lat, 1e-9);
  const mid = shimTelemetry({ ...t, alt_rel: 2, pitch: 0 }, handPoseAt('released', cfg.settle_s / 2, cfg), 0); assert.ok(mid.alt_rel > 2 && mid.alt_rel < 2 + cfg.shoulder_m); assert.equal(mid.groundspeed, 0.3, 'bırakıldı: hız aynen');
  const free = shimTelemetry(t, handPoseAt('free', 0, cfg), 0); assert.equal(free, t, 'blend 1 → nesne aynen');
  assert.equal(shimTelemetry(null, handPoseAt('idle')), null);
});
test('kayıttan oynatma: ARM → armed; gs > 2 → launch; gs ≥ 5 ya da tırmanış > 1 m → released; hareketsiz segmentin DISARM\'ı → idle', () => {
  const FIELDS = ['t', 'lat', 'lon', 'alt_msl', 'alt_rel', 'gs', 'armed']; const FI = Object.fromEntries(FIELDS.map((k, i) => [k, i]));
  const fr = (t, armed, gs, agl) => { const f = new Array(FIELDS.length).fill(null); f[FI.t] = t; f[FI.armed] = armed; f[FI.gs] = gs; f[FI.alt_rel] = agl; return f; };
  const frames = [];
  for (let t = 0; t <= 40; t++) frames.push(fr(t, (t >= 5 && t < 8) || (t >= 10 && t < 35) ? 1 : 0, t < 14 ? 0 : t < 16 ? 3 : t < 35 ? 12 : 0, t < 15 ? 0 : t < 20 ? (t - 14) * 0.8 : 10));
  const segs = replayHandTimeline(frames, FI);
  assert.equal(segs.length, 2); assert.deepEqual(segs[0], { arm: 5, launch: null, release: null, disarm: 8 });
  assert.equal(segs[1].arm, 10); assert.equal(segs[1].launch, 14); assert.equal(segs[1].release, 16, `gs 12 ≥ ${REPLAY_HAND_RELEASE}`); assert.equal(segs[1].disarm, 35);
  assert.equal(replayHandPhaseAt(segs, 4), 'idle'); assert.equal(replayHandPhaseAt(segs, 6), 'armed'); assert.equal(replayHandPhaseAt(segs, 8), 'idle'); assert.equal(replayHandPhaseAt(segs, 12), 'armed');
  assert.equal(replayHandPhaseAt(segs, 14.5), 'launch'); assert.equal(replayHandPhaseAt(segs, 20), 'released'); assert.equal(replayHandPhaseAt(segs, 39), 'released');
  assert.equal(replayHandPhaseStart(segs, 14.5), 14); assert.equal(replayHandPhaseStart(segs, 20), 16); assert.equal(replayHandPhaseStart(segs, 3), 3);
  assert.equal(replayHandPhaseAt([], 1), 'idle');
});

console.log('gates.js');
const G = { i: 1, x: 0, y: 100, z: 10, yaw_deg: 0, radius_m: 3, kind: 'ring' };   // kuzeye bakan halka, 100 m kuzeyde, 10 m yükseklikte
test('düzlem kesişimi: içinden ileri geçiş; kenar dışı (near) kaçırma; uzak geçiş near değil; ters yön; düzlem geçilmedi → null; kapı karesi', () => {
  const c = crossing({ x: 0.5, y: 98, z: 10.5 }, { x: 0.5, y: 102, z: 10.5 }, G);
  assert.equal(c.dir, 1); near(c.s, 0.5); assert.ok(c.inside); near(c.dist, Math.hypot(0.5, 0.5)); near(c.lateral, 0.5); near(c.vertical, 0.5);
  const miss = crossing({ x: 5, y: 99, z: 10 }, { x: 5, y: 101, z: 10 }, G); assert.equal(miss.inside, false); assert.ok(miss.near); near(miss.dist, 5);
  const far = crossing({ x: 0, y: 99, z: 10 + 3 * MISS_FACTOR + 1 }, { x: 0, y: 101, z: 10 + 3 * MISS_FACTOR + 1 }, G); assert.equal(far.near, false);
  const rev = crossing({ x: 0, y: 101, z: 10 }, { x: 0, y: 99, z: 10 }, G); assert.equal(rev.dir, -1); assert.ok(rev.inside);
  assert.equal(crossing({ x: 0, y: 90, z: 10 }, { x: 0, y: 95, z: 10 }, G), null); assert.equal(crossing({ x: 0, y: 101, z: 10 }, { x: 0, y: 105, z: 10 }, G), null);
  const G90 = { ...G, x: 100, y: 0, yaw_deg: 90 };   // doğuya bakan
  const e = crossing({ x: 99, y: 1, z: 10 }, { x: 101, y: 1, z: 10 }, G90); assert.equal(e.dir, 1); assert.ok(e.inside); near(Math.abs(e.lateral), 1);
  const gate = { ...G, kind: 'gate' }; const gq = crossing({ x: 2.5, y: 99, z: 12.5 }, { x: 2.5, y: 101, z: 12.5 }, gate); assert.ok(gq.inside, 'kare: |2,5| ≤ 3 ve |2,5| ≤ 3'); assert.equal(crossing({ x: 2.5, y: 99, z: 12.5 }, { x: 2.5, y: 101, z: 12.5 }, G).inside, false, 'halka: hypot 3,5 > 3');
});
test('izleyici: sıralı geçiş pass, dışarıdan geçiş miss (sıra ilerler), ileri halka içinden geçiş aradakileri miss yapar, ters yön wrong_way, tur/süre/bitiş', () => {
  const gates = [G, { ...G, i: 2, y: 200 }, { ...G, i: 3, y: 300 }];
  const tr = createGateTracker(gates, { order: [1, 2, 3], laps: 2 });
  assert.equal(tr.next(), 1); assert.equal(tr.statusOf(1), 'next'); assert.equal(tr.statusOf(2), 'idle');
  assert.deepEqual(tr.update({ x: 0, y: 50, z: 10 }, 0), [], 'ilk kare: önceki yok');
  let ev = tr.update({ x: 0, y: 150, z: 10 }, 5); assert.equal(ev.length, 1); assert.equal(ev[0].type, 'pass'); assert.equal(ev[0].i, 1); assert.equal(tr.next(), 2); assert.equal(tr.statusOf(1), 'passed');
  ev = tr.update({ x: 12, y: 250, z: 10 }, 10); assert.equal(ev[0].type, "miss", "kesişim x=6 > 3 (≤ 9 near)"); assert.equal(ev[0].i, 2); assert.equal(tr.next(), 3); assert.equal(tr.statusOf(2), 'missed');
  ev = tr.update({ x: -12, y: 350, z: 10 }, 15); assert.deepEqual(ev.map(e => e.type), ["pass", "lap"], "kesişim x=0"); near(ev[1].lap_s, 15); assert.equal(tr.stats().laps, 1); assert.equal(tr.next(), 1, 'ikinci tur başı'); assert.equal(tr.statusOf(1), 'next');
  // tur 2: geri dön (halka 3'ten ters geçiş → wrong_way değil çünkü sıradaki 1; sayılmaz), sonra 1'i atlayıp 2'den geç → 1 miss
  ev = tr.update({ x: 0, y: 250, z: 10 }, 18); assert.deepEqual(ev, [], 'sıradaki olmayan halkadan ters geçiş sayılmaz');
  ev = tr.update({ x: 0, y: 50, z: 10 }, 20); assert.equal(ev[0]?.type, 'wrong_way', 'sıradaki (1) ters geçildi'); assert.equal(tr.next(), 1);
  ev = tr.update({ x: 0, y: 80, z: 10 }, 21); assert.deepEqual(ev, []);
  ev = tr.update({ x: 0, y: 100.001, z: 10 }, 22); assert.equal(ev[0].type, 'pass', 'd1 = 0 → düzlem geçildi sayılır');
  ev = tr.update({ x: 0, y: 320, z: 10 }, 30); assert.deepEqual(ev.map(e => e.type), ['pass', 'pass', 'lap', 'finish'], 'tek karede 2 ve 3 sırayla geçildi → tur ve bitiş'); assert.deepEqual(ev.slice(0, 2).map(e => e.i), [2, 3]);
  const s = tr.stats(31); assert.equal(s.finished, true); assert.equal(s.passed, 5); assert.equal(s.missed, 1); assert.equal(s.wrong_way, 1); assert.equal(s.laps, 2); near(s.best_lap_s, 15); assert.equal(s.next, null); assert.equal(s.gates_total, 6);
  assert.deepEqual(gateStats(tr), { passed: 5, missed: 1, best_lap_s: 15, laps: 2 });
  assert.deepEqual(tr.update({ x: 0, y: 400, z: 10 }, 40), [], 'bitince olay yok');
  tr.reset(); assert.equal(tr.stats().passed, 0); assert.equal(tr.next(), 1);
  // atlama: 1'i hiç geçmeden 2'nin içinden geç → 1 miss (skipped) + 2 pass; sonra çapraz segment: 3'ü dışarıdan (near) kaçır → miss (skipped değil)
  const tr2 = createGateTracker(gates, { order: [1, 2, 3], laps: 1 });
  tr2.update({ x: 30, y: 50, z: 10 }, 0); tr2.update({ x: 30, y: 150, z: 10 }, 1);   // halka 1 düzlemi 30 m yanda → near değil → olay yok
  assert.equal(tr2.stats().missed, 0);
  ev = tr2.update({ x: -30, y: 250, z: 10 }, 2);   // y=200'de x=0 → 2 içinden assert.deepEqual(ev.map(e => [e.type, e.i, !!e.skipped]), [['miss', 1, true], ['pass', 2, false]]);
  ev = tr2.update({ x: 40, y: 350, z: 10 }, 3); assert.deepEqual(ev.map(e => e.type), ['miss', 'lap', 'finish'], 'y=300\'de x=5: dışarıda ama ≤ 9'); assert.equal(ev[0].skipped, undefined); near(ev[0].dist, 5, 0.01);
  const empty = createGateTracker([], {}); assert.deepEqual(empty.update({ x: 0, y: 0, z: 0 }, 0), []); assert.equal(empty.next(), null);
});
test('replayGatesAt: lat/lon karelerinden t anındaki istatistik; gateLocal yerel çerçeve + arazi yüksekliği', () => {
  const origin = { lat: 40, lon: 33 }; const toLocal = localFrom(origin);
  const g1 = { i: 1, lat: 40 + 100 / 110574, lon: 33, agl_m: 10, yaw_deg: 0, radius_m: 3 };
  const gl = gateLocal(g1, toLocal, () => 2.5); near(gl.x, 0, 1e-6); near(gl.y, 100, 1e-3); near(gl.z, 12.5); assert.equal(gl.kind, 'ring');
  const FI = { t: 0, lat: 1, lon: 2, alt_rel: 3 };
  const frames = [[0, 40, 33, 12.5], [5, 40 + 50 / 110574, 33, 12.5], [10, 40 + 150 / 110574, 33, 12.5], [15, 40 + 250 / 110574, 33, 12.5]];
  const s5 = replayGatesAt(frames, FI, [g1], {}, origin, 5, { terrainHeight: () => 2.5 }); assert.equal(s5.passed, 0); assert.equal(s5.next, 1);
  const s10 = replayGatesAt(frames, FI, [g1], {}, origin, 10, { terrainHeight: () => 2.5 }); assert.equal(s10.passed, 1); assert.equal(s10.finished, true); assert.equal(s10.statusOf(1), 'passed');
  assert.equal(replayGatesAt(frames, FI, [g1], {}, origin, 10, { terrainHeight: () => 50 }).passed, 0, 'halka 50 m yukarıda → düzlem içinden geçilmedi (dışarıdan, uzak)');
});

console.log('session.js');
const { installWsBridge, recRest } = await import('../static/simumav/app/fly/session.js').catch(e => { console.log('  (session.js tarayıcısız yüklenemedi:', e.message, ')'); return {}; });
if (installWsBridge) test('installWsBridge: yalnız /ws/drone/live → hedef; diğer yollar aynen; geri alma', () => {
  const calls = [];
  class FakeWS { constructor(u, p) { calls.push([u, p]); } } FakeWS.OPEN = 1;
  const win = { WebSocket: FakeWS, location: { href: 'https://simumav.com/app' } };
  const restore = installWsBridge('wss://simumav.com/ws/fly/42', { win });
  assert.notEqual(win.WebSocket, FakeWS); assert.equal(win.WebSocket.OPEN, 1);
  new win.WebSocket('wss://simumav.com/ws/drone/live'); new win.WebSocket('wss://simumav.com/ws/fly/42'); new win.WebSocket('/ws/drone/live', ['x']); new win.WebSocket('wss://simumav.com/ws/other');
  assert.deepEqual(calls.map(c => c[0]), ['wss://simumav.com/ws/fly/42', 'wss://simumav.com/ws/fly/42', 'wss://simumav.com/ws/fly/42', 'wss://simumav.com/ws/other']); assert.deepEqual(calls[2][1], ['x']);
  const again = installWsBridge('wss://x/y', { win }); again(); assert.ok(win.WebSocket.__smBridged, 'ikinci kurulum atlanır, geri alma zararsız');
  restore(); assert.equal(win.WebSocket, FakeWS);
  const r = recRest(7); assert.equal(r.fileUrl('ab'), '/api/fly/rec/ab/file');
});
console.log(`\n${n} test geçti`);
