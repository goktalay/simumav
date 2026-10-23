// SIMUMAV › Uç › ÇOK OYUNCULU KARŞILAŞMA (docs/simumav.md §18) — tarayıcısız birim testleri. Çalıştırma: node tests/test_simumav_match.mjs
//   • fly/match_core.js: rota ayrıştırma (#/fly/…), davet bağlantısı, halka/şifre/oyuncu doğrulaması (i18n anahtarı), şifre önerisi, salon görünüm
//     modeli, yarışa geçiş kararı, sonuç satırları, biçimler, kuş bakışı ölçek
//   • fly/wizard.js createWizard(…, {match:true}): adımlar (dron → parkur → [kalkış] → halkalar → davet), İleri/hazır kuralları, POST /api/match gövdesi
//   • i18n: kullanılan match.* anahtarları 7 dilde (yer tutucular eşit)
//   • §29 HAZIR FPV PARKURLARI + TEK KİŞİLİK: rotalar (#/fly/fpv[/<parkur>], #/tracks/fpv[/<parkur>]), en az oyuncu, salonda tek kişilik BAŞLAT,
//     FPV ayar doğrulaması/gövdesi, sihirbaz (Tek oyunculu › FPV parkuru: dron → parkur → kurallar → POST /api/match/solo; çok oyunculuda FPV türü parkur/
//     kalkış adımını gizler, 1 oyuncu), sonuç özeti (kişisel rekor), geçmiş satırı, ortak FPV_TEXTS (fpv.*) + fpvsm.* + TOP 10 bileşen anahtarları 7 dilde
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { genPassword, inviteLink, isMatchType, LIMITS, lobbyHref, lobbyView, joinErrorKey, parseFlyParam, passwordErrorKey, phaseOf, playersErrorKey, raceHref, resultRows,
  ringsBody, ringsDefaults, ringsErrorKey, shouldEnterRace, typeClass, viewBox, fmtClock, fmtDist, STATUS_KEY, STATE_KEY, REASON_KEY, JOIN_ERR_KEY,
  minPlayers, soloAllowedKind, fpvErrorKey, fpvBodySm, fpvDefaultsSm, isFpvType, parseTracksParam, fpvHref, fpvTracksHref, matchKind, kindKey, kindShortKey, isSoloMatch, historyRow,
  fpvSummary, lbPlace, FPV_COURSE_IDS } from '../static/simumav/app/fly/match_core.js';
import { createWizard, STEP_TITLES, STEPS_FPV, FPV_SM_DEFAULTS } from '../static/simumav/app/fly/wizard.js';
import { FPV_TEXTS, COURSE_IDS, FPV_LIMITS } from '../static/js/modules/flightsim_fpvcourse.js';   // ortak saf modül (§47)

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
let n = 0;
const test = (name, fn) => { fn(); n++; console.log('  ✓', name); };

console.log('match_core.js');
test('rota: #/fly → seçim; solo/multi; join/<kod>; match/<id>[/race]; sayısal → süren uçuş (netsim dahil); bozuk kod → seçim', () => {
  assert.deepEqual(parseFlyParam(''), { kind: 'choice' });
  assert.deepEqual(parseFlyParam('solo'), { kind: 'solo' });
  assert.deepEqual(parseFlyParam('multi'), { kind: 'multi' });
  assert.deepEqual(parseFlyParam('join/Ab_cd-1234567890xyz'), { kind: 'join', code: 'Ab_cd-1234567890xyz' });
  assert.deepEqual(parseFlyParam('join/<script>'), { kind: 'choice' });
  assert.deepEqual(parseFlyParam('match/12'), { kind: 'lobby', id: 12 });
  assert.deepEqual(parseFlyParam('match/12/race'), { kind: 'race', id: 12 });
  assert.deepEqual(parseFlyParam('42'), { kind: 'flight', id: '42' });
  assert.deepEqual(parseFlyParam('42?netsim=jitter30'), { kind: 'flight', id: '42?netsim=jitter30' });
  assert.equal(lobbyHref(5), '#/fly/match/5'); assert.equal(raceHref(5), '#/fly/match/5/race');
  assert.equal(inviteLink('https://simumav.com/', 'abc_DEF-123'), 'https://simumav.com/app/#/fly/join/abc_DEF-123');
});
test('tipler: kara aracı yok; sabit kanat ucak sınıfı (varsayılan halkalar çekirdekle aynı)', () => {
  assert.ok(!isMatchType('rover') && isMatchType('fpv') && isMatchType('plane') && isMatchType('interceptor'));
  assert.equal(typeClass('plane'), 'ucak'); assert.equal(typeClass('heli'), 'dikey');
  assert.deepEqual(ringsDefaults('plane'), { count: 8, min_alt_m: 40, max_alt_m: 140, diameter_m: 36, radius_m: 700, time_limit_min: 15, seed: null });
  assert.equal(ringsDefaults('fpv').diameter_m, 12);
});
test('halka doğrulaması: sayı/yükseklik/min>max/çap/yarıçap/süre → i18n anahtarı; gövde sayılara çevrilir, boşlar atılır', () => {
  const ok = { count: 5, min_alt_m: 20, max_alt_m: 50, diameter_m: 10, radius_m: 200, time_limit_min: 10 };
  assert.equal(ringsErrorKey(ok), null);
  assert.equal(ringsErrorKey({ ...ok, count: 0 }), 'match.err_count');
  assert.equal(ringsErrorKey({ ...ok, count: 2.5 }), 'match.err_count');
  assert.equal(ringsErrorKey({ ...ok, max_alt_m: 500 }), 'match.err_alt');
  assert.equal(ringsErrorKey({ ...ok, min_alt_m: 60 }), 'match.err_minmax');
  assert.equal(ringsErrorKey({ ...ok, diameter_m: 2 }), 'match.err_diameter');
  assert.equal(ringsErrorKey({ ...ok, radius_m: 5000 }), 'match.err_radius');
  assert.equal(ringsErrorKey({ ...ok, time_limit_min: 1 }), 'match.err_time');
  assert.deepEqual(ringsBody({ count: '6', min_alt_m: '15.5', max_alt_m: 40, diameter_m: '', radius_m: null, seed: '77', _type: 'fpv' }), { count: 6, min_alt_m: 15.5, max_alt_m: 40, seed: 77 });
});
test('şifre: 4–32 karakter, kontrol karakteri yok; öneri 6 karakter karışmayan alfabe (0/O/1/I yok); oyuncu sayısı sınırı', () => {
  assert.equal(passwordErrorKey('abc'), 'match.err_pw_len'); assert.equal(passwordErrorKey('abcd'), null); assert.equal(passwordErrorKey('x'.repeat(33)), 'match.err_pw_len');
  assert.equal(passwordErrorKey('ab\ncd'), 'match.err_pw_len');
  let i = 0; const seq = genPassword(6, k => (i++ * 7) % k);
  assert.equal(seq.length, 6); assert.ok(/^[A-HJ-NP-Z2-9]+$/.test(seq), seq);
  for (let j = 0; j < 50; j++) assert.ok(/^[A-HJ-NP-Z2-9]{6}$/.test(genPassword()));
  // §29: 1 oyuncu = tek kişilik zaman denemesi (halka / FPV); it dalaşı en az 2
  assert.equal(playersErrorKey(1), null); assert.equal(playersErrorKey(0), 'match.err_players'); assert.equal(playersErrorKey(1, LIMITS, 'dogfight'), 'match.err_players');
  assert.equal(playersErrorKey(2, LIMITS, 'dogfight'), null); assert.equal(playersErrorKey(3, { players: [2, 3] }), null); assert.equal(playersErrorKey(4, { players: [2, 3] }), 'match.err_players');
});
const M0 = { id: 3, state: 'LOBI', max_players: 3, can_start: false, players: [{ id: 1, name: 'ali', host: true, ready: true, status: 'geldi' }, { id: 2, name: 'veli', host: false, ready: false, status: 'geldi' }] };
test('salon görünüm modeli: kurucu/me, bekleyenler, başlatma yalnız kurucuda ve sunucu izin verince, dolu', () => {
  const v = lobbyView(M0, 1);
  assert.equal(v.isHost, true); assert.deepEqual(v.waiting, ['veli']); assert.equal(v.canStart, false); assert.equal(v.full, false); assert.equal(v.count, 2);
  assert.equal(lobbyView({ ...M0, can_start: true }, 1).canStart, true);
  assert.equal(lobbyView({ ...M0, can_start: true }, 2).canStart, false);
  assert.equal(lobbyView({ ...M0, max_players: 2 }, 2).full, true);
  assert.equal(phaseOf('LOBI'), 'lobby'); assert.equal(phaseOf('HAZIRLIK'), 'race'); assert.equal(phaseOf('GERI_SAYIM'), 'race'); assert.equal(phaseOf('YARIS'), 'race'); assert.equal(phaseOf('BITTI'), 'done'); assert.equal(phaseOf('IPTAL'), 'cancel');
});
test('yarışa geçiş: HAZIRLIK+ ve kendi uçuşu açılmış; düşen/ayrılan geçmez; lobide geçmez', () => {
  const R = { ...M0, state: 'HAZIRLIK', players: [{ id: 1, status: 'hazirlaniyor', flight_id: 9 }, { id: 2, status: 'hazirlaniyor', flight_id: null }] };
  assert.equal(shouldEnterRace(R, 1), true); assert.equal(shouldEnterRace(R, 2), false);
  assert.equal(shouldEnterRace({ ...R, players: [{ id: 1, status: 'dustu', flight_id: 9 }] }, 1), false);
  assert.equal(shouldEnterRace({ ...R, state: 'LOBI' }, 1), false);
  assert.equal(shouldEnterRace({ ...R, state: 'BITTI' }, 1), false);
});
test('sonuç satırları: sunucu sıralaması (kazanan işaretli) ya da DB oyuncu listesi (rank); biçimler', () => {
  const res = { state: 'BITTI', rings: [{}, {}, {}], result: { winner: 1, total: 3, standings: [{ id: 1, name: 'ali', rank: 1, rings: 3, time_s: 42.5, status: 'hazir', finished: true, max_speed_ms: 20 }, { id: 2, name: 'veli', rank: 2, rings: 1, dist_next_m: 80, status: 'hazir' }] } };
  const rows = resultRows(res);
  assert.equal(rows[0].winner, true); assert.equal(rows[0].finished, true); assert.equal(rows[1].winner, false); assert.equal(rows[1].total, 3);
  const db = resultRows({ winner: 2, rings: [{}], players: [{ id: 1, name: 'a', rank: 2, rings: 0 }, { id: 2, name: 'b', rank: 1, rings: 1, time_s: 9 }] });
  assert.deepEqual(db.map(r => [r.id, r.rank, r.winner]), [[2, 1, true], [1, 2, false]]);
  assert.equal(fmtClock(65.25), '1:05.3'); assert.equal(fmtClock(null), '—'); assert.equal(fmtDist(1500), '1.50 km'); assert.equal(fmtDist(12.4), '12 m');
});
test('katılım hata kodları → anahtar; kuş bakışı ölçek (merkez ve halkalar kutuda)', () => {
  assert.equal(joinErrorKey({ error: 'bad_password' }), 'match.err_bad_password');
  assert.equal(joinErrorKey({ error: 'too_many_attempts' }), 'match.err_too_many');
  assert.equal(joinErrorKey({ error: 'kicked' }), 'match.err_kicked');
  assert.equal(joinErrorKey({ error: 'xyz' }), null);
  const vb = viewBox([{ x: 100, y: 50 }, { x: -80, y: -20 }], [{ x: 10, y: -40 }]);
  for (const [x, y] of [[0, 0], [100, 50], [-80, -20], [10, -40]]) { const [u, v] = vb.toSvg(x, y); assert.ok(u > 0 && u < 1 && v > 0 && v < 1, `${x},${y} → ${u},${v}`); }
  const [, vTop] = vb.toSvg(0, 50), [, vBot] = vb.toSvg(0, -20); assert.ok(vTop < vBot, 'kuzey yukarıda');
});

console.log('wizard.js (match)');
const DATA = { drones: [{ id: 1, name: 'FPV-1', type: 'fpv', model_key: 'glb:iris_fpv', is_default: 1 }, { id: 2, name: 'Cessna', type: 'plane', model_key: 'glb:rc_cessna' }],
  tracks: [{ id: 10, name: 'TRTEST', lat: 40, lon: 33, is_default: 1 }], pilots: [], missions: [] };
test('adımlar: dron → parkur → halkalar → davet (sabit kanatta kalkış); pilot gerekmez; İleri doğrulamalı; gövde', () => {
  const W = createWizard(DATA, {}, { match: true });
  assert.equal(W.match, true);
  assert.deepEqual(W.steps(), ['drone', 'track', 'rings', 'invite']);
  W.set('drone_id', 2); assert.deepEqual(W.steps(), ['drone', 'track', 'launch', 'rings', 'invite']);
  W.set('drone_id', 1);
  assert.ok(W.next() && W.next()); assert.equal(W.step(), 'rings');
  assert.equal(W.canNext(), false, 'halka ayarı yokken İleri kapalı');
  W.set('rings', { ...ringsDefaults('fpv'), seed: 5, _type: 'fpv', diameter_m: '' }); assert.equal(W.canNext(), true);
  W.set('rings_err', 'match.err_count'); assert.equal(W.canNext(), false); W.set('rings_err', null);
  assert.ok(W.next()); assert.equal(W.step(), 'invite'); assert.equal(W.isLast(), true);
  assert.equal(W.ready(), false, 'şifresiz hazır değil');
  W.set('password', 'K7P4QX'); W.set('max_players', 3);
  assert.equal(W.ready(), true);
  assert.deepEqual(W.payload(), { drone_id: 1, track_id: 10, launch: { method: 'wheels' }, rings: { count: 8, min_alt_m: 15, max_alt_m: 60, radius_m: 220, time_limit_min: 15, seed: 5 }, password: 'K7P4QX', max_players: 3, kind: 'rings', dogfight: null });
  // HEPGO §41 it dalaşı: kind + ayar (iç alanlar yok), oyuncu 2'ye sabit
  W.set('kind', 'dogfight'); W.set('dogfight', { distance_m: 500, alt_m: 40, time_limit_min: 4, range_m: 150, cone_deg: 25, hold_s: 3, area_radius_m: 900, roles: 'host_chaser', _type: 'multirotor' });
  const pd = W.payload();
  assert.equal(pd.kind, 'dogfight'); assert.equal(pd.max_players, 2); assert.deepEqual(pd.dogfight, { distance_m: 500, alt_m: 40, time_limit_min: 4, range_m: 150, cone_deg: 25, hold_s: 3, area_radius_m: 900, roles: 'host_chaser' });
  W.set('kind', 'rings');
  W.set('invite_err', 'match.err_pw_len'); assert.equal(W.ready(), false);
  assert.ok(STEP_TITLES.rings === 'match.step_rings' && STEP_TITLES.invite === 'match.step_invite');
  // tek oyunculu sihirbaz değişmedi
  assert.deepEqual(createWizard(DATA).steps(), ['drone', 'track', 'power', 'mission', 'site', 'targets', 'pilot']);
});

console.log('§29 FPV parkuru + tek kişilik');
test('rotalar: #/fly/fpv[/<parkur>] (bilinmeyen parkur → seçim yok), #/tracks/fpv[/<parkur>]; parkur kimlikleri ortak modülle aynı', () => {
  assert.deepEqual(parseFlyParam('fpv'), { kind: 'fpv', course: null });
  assert.deepEqual(parseFlyParam('fpv/woodframe'), { kind: 'fpv', course: 'woodframe' });
  assert.deepEqual(parseFlyParam('fpv/xyz'), { kind: 'fpv', course: null });
  assert.deepEqual(parseFlyParam('fpv/<b>'), { kind: 'choice' });
  assert.equal(fpvHref('city'), '#/fly/fpv/city'); assert.equal(fpvHref(), '#/fly/fpv'); assert.equal(fpvTracksHref('canyon'), '#/tracks/fpv/canyon');
  assert.deepEqual(parseTracksParam(''), { tab: 'mine', course: null, new: false });
  assert.deepEqual(parseTracksParam('new'), { tab: 'mine', course: null, new: true });
  assert.deepEqual(parseTracksParam('fpv'), { tab: 'fpv', course: null });
  assert.deepEqual(parseTracksParam('fpv/stadium'), { tab: 'fpv', course: 'stadium' });
  assert.deepEqual(parseTracksParam('fpv/abc'), { tab: 'mine', course: null, new: false });
  assert.deepEqual(FPV_COURSE_IDS, COURSE_IDS);
});
test('en az oyuncu: it dalaşı 2, halka/FPV 1; salonda yalnız kurucu → tek kişilik ipucu (it dalaşında "en az 2")', () => {
  assert.equal(minPlayers('rings'), 1); assert.equal(minPlayers('fpv'), 1); assert.equal(minPlayers('dogfight'), 2); assert.equal(minPlayers(null), 1);
  assert.equal(soloAllowedKind('fpv'), true); assert.equal(soloAllowedKind('dogfight'), false); assert.equal(LIMITS.players[0], 1);
  const L1 = { id: 4, state: 'LOBI', kind: 'fpv', max_players: 1, can_start: true, players: [{ id: 1, name: 'ali', host: true, ready: true, status: 'geldi' }] };
  const v = lobbyView(L1, 1);
  assert.equal(v.solo, true); assert.equal(v.needMore, false); assert.equal(v.canStart, true); assert.equal(v.kind, 'fpv'); assert.equal(v.minPlayers, 1);
  const vd = lobbyView({ ...L1, kind: 'dogfight', max_players: 2, can_start: false }, 1);
  assert.equal(vd.solo, false); assert.equal(vd.needMore, true);
  assert.equal(lobbyView({ ...L1, kind: undefined, max_players: 4 }, 1).solo, true, 'halka yarışında da tek başına başlat');
  assert.equal(lobbyView(M0, 1).solo, false);
});
test('FPV ayarı: tip (multirotor/fpv/heli), parkur, tur 1–10, kural, ceza 0–30, süre 2–30 → anahtar; gövde sayılar; varsayılan parkurun turu', () => {
  const ok = { course_id: 'hangar', laps: 3, crash_rule: 'penalty', crash_penalty_s: 2, miss_penalty_s: 3, time_limit_min: 10 };
  assert.equal(fpvErrorKey(ok, 'fpv'), null); assert.equal(fpvErrorKey(ok, 'heli'), null); assert.equal(fpvErrorKey(ok), null);
  assert.equal(fpvErrorKey(ok, 'plane'), 'fpvsm.type_warn'); assert.equal(fpvErrorKey(ok, 'rover'), 'fpvsm.type_warn');
  assert.equal(fpvErrorKey({ ...ok, course_id: null }), 'fpv.pick');
  assert.equal(fpvErrorKey({ ...ok, laps: 0 }), 'fpvsm.err_laps'); assert.equal(fpvErrorKey({ ...ok, laps: 11 }), 'fpvsm.err_laps'); assert.equal(fpvErrorKey({ ...ok, laps: 2.5 }), 'fpvsm.err_laps');
  assert.equal(fpvErrorKey({ ...ok, crash_rule: 'boom' }), 'fpvsm.err_rule');
  assert.equal(fpvErrorKey({ ...ok, crash_penalty_s: 31 }), 'fpvsm.err_penalty'); assert.equal(fpvErrorKey({ ...ok, miss_penalty_s: '' }), 'fpvsm.err_penalty');
  assert.equal(fpvErrorKey({ ...ok, time_limit_min: 1 }), 'fpvsm.err_time'); assert.equal(fpvErrorKey({ ...ok, time_limit_min: 31 }), 'fpvsm.err_time');
  assert.deepEqual(fpvBodySm({ ...ok, laps: '2', crash_penalty_s: '1.5', _x: 1 }), { course_id: 'hangar', laps: 2, crash_rule: 'penalty', crash_penalty_s: 1.5, miss_penalty_s: 3, time_limit_min: 10 });
  assert.deepEqual(fpvDefaultsSm({ id: 'canyon', laps: 1 }), { ...LIMITS.fpv.defaults, course_id: 'canyon', laps: 1 });
  assert.ok(isFpvType('fpv') && isFpvType('multirotor') && isFpvType('heli') && !isFpvType('plane') && !isFpvType('interceptor'));
  // ortak modülün sınırlarıyla aynı (tipler hariç: SIMUMAV dron tipleri)
  for (const k of ['laps', 'crash_rules', 'penalty_s', 'time_limit_min']) assert.deepEqual(LIMITS.fpv[k], FPV_LIMITS[k], k);
  for (const k of Object.keys(FPV_SM_DEFAULTS)) assert.equal(FPV_SM_DEFAULTS[k], FPV_LIMITS.defaults[k], k);
});
const FDATA = { drones: [{ id: 1, name: 'Cessna', type: 'plane', model_key: 'glb:rc_cessna', is_default: 1 }, { id: 2, name: 'FPV-1', type: 'fpv', model_key: 'glb:iris_fpv' }],
  tracks: [{ id: 10, name: 'TRTEST', lat: 40, lon: 33, is_default: 1 }], pilots: [], missions: [] };
test('sihirbaz: Tek oyunculu › FPV parkuru — dron → parkur → kurallar; FPV dışı tip ilerleyemez; POST /api/match/solo gövdesi (track_id yok)', () => {
  const W = createWizard(FDATA, { course_id: 'woodframe' }, { fpv: true });
  assert.deepEqual(W.steps(), STEPS_FPV); assert.deepEqual(STEPS_FPV, ['drone', 'course', 'rules']);
  assert.equal(W.state.kind, 'fpv'); assert.equal(W.state.fpv.course_id, 'woodframe'); assert.equal(W.state.ghost, 'pb');
  assert.ok(W.next()); assert.equal(W.step(), 'course');
  assert.equal(W.canNext(), false, 'sabit kanat FPV parkurunda olamaz'); assert.equal(W.ready(), false);
  W.set('drone_id', 2); assert.equal(W.canNext(), true);
  W.set('fpv', { course_id: 'concrete', laps: 2 }); assert.equal(W.state.fpv.crash_rule, 'penalty', 'kısmi güncelleme');
  assert.ok(W.next()); assert.equal(W.step(), 'rules'); assert.equal(W.isLast(), true);
  W.set('fpv_err', 'fpvsm.err_laps'); assert.equal(W.canNext(), false); assert.equal(W.ready(), false); W.set('fpv_err', null);
  W.set('fpv', { crash_rule: 'reset', time_limit_min: '6' });
  assert.equal(W.ready(), true);
  assert.deepEqual(W.payload(), { drone_id: 2, kind: 'fpv', fpv: { course_id: 'concrete', laps: 2, crash_rule: 'reset', crash_penalty_s: 2, miss_penalty_s: 3, time_limit_min: 6 }, launch: { method: 'wheels' } });
  assert.ok(STEP_TITLES.course === 'fpvsm.step_course' && STEP_TITLES.rules === 'fpvsm.step_rules');
});
test('çok oyunculu: tür FPV → parkur/kalkış adımı gizli (bulunulan adım korunur), 1 oyuncu tek kişilik; yapay zekâya karşı FPV gövdesi', () => {
  const W = createWizard(FDATA, {}, { match: true });
  assert.deepEqual(W.steps(), ['drone', 'track', 'launch', 'rings', 'invite']);
  W.next(); W.next(); W.next(); assert.equal(W.step(), 'rings');
  W.set('kind', 'fpv'); assert.deepEqual(W.steps(), ['drone', 'rings', 'invite']); assert.equal(W.step(), 'rings', 'adım korunur');
  W.set('kind', 'rings'); assert.equal(W.step(), 'rings'); assert.equal(W.steps().length, 5);
  W.set('kind', 'fpv'); W.set('drone_id', 2); W.set('rings', { count: 3 }); W.set('rings_err', null);
  assert.ok(W.next()); assert.equal(W.step(), 'invite');
  W.set('password', 'SOLO42'); W.set('max_players', 1);
  assert.equal(W.ready(), true);
  assert.deepEqual(W.payload(), { drone_id: 2, launch: { method: 'wheels' }, kind: 'fpv', fpv: { course_id: 'hangar', laps: 3, crash_rule: 'penalty', crash_penalty_s: 2, miss_penalty_s: 3, time_limit_min: 10 }, password: 'SOLO42', max_players: 1 });
  W.set('rings_err', 'fpvsm.type_warn'); assert.equal(W.ready(), false); W.set('rings_err', null);
  const A = createWizard(FDATA, { kind: 'fpv', drone_id: 2, ai_level: 'hard', ai_bots: 2, rings: { count: 3 } }, { match: true, ai: true });
  assert.deepEqual(A.steps(), ['drone', 'rings', 'ai']);
  assert.deepEqual(A.payload(), { drone_id: 2, launch: { method: 'wheels' }, kind: 'fpv', fpv: { course_id: 'hangar', laps: 3, crash_rule: 'penalty', crash_penalty_s: 2, miss_penalty_s: 3, time_limit_min: 10 }, level: 'hard', bots: 2 });
  // halka yarışı tek kişilik (1 oyuncu) da geçerli gövde
  const R = createWizard(FDATA, { drone_id: 2, rings: { ...ringsDefaults('fpv'), seed: 3 }, password: 'ABCD', max_players: 1 }, { match: true });
  assert.equal(R.ready(), true); assert.equal(R.payload().max_players, 1); assert.equal(R.payload().kind, 'rings');
});
test('sonuç: FPV özeti (ceza dahil süre, turlar, en iyi tur, kişisel rekor farkı); tek kişilik; geçmiş satırı; skor tablosundaki yer', () => {
  const row = { id: 1, name: 'ali', time_s: 95.25, finished: true, new_pb: true, pb_prev: 98.5, fpv: { laps_done: 2, lap_times: [48.1, 44.15], best_lap_s: 44.15, sectors: [[20, 28.1], [19.5, 24.65]], misses: 1, hits: 2, pen_s: 3, total_s: 92.25 } };
  const S = fpvSummary(row);
  assert.equal(S.total, 95.25); assert.equal(S.raw, 92.25); assert.equal(S.best, 44.15); assert.deepEqual(S.laps, [48.1, 44.15]); assert.equal(S.lapsDone, 2);
  assert.equal(S.misses, 1); assert.equal(S.hits, 2); assert.equal(S.pen, 3); assert.equal(S.newPb, true); assert.equal(S.pbDelta, -3.25); assert.equal(S.finished, true);
  const S0 = fpvSummary({ id: 2, status: 'hazir', fpv: { lap_times: [] } });
  assert.equal(S0.finished, false); assert.equal(S0.best, null); assert.equal(S0.pbDelta, null);
  assert.equal(isSoloMatch({ result: { solo: true }, players: [{}, {}] }), true);
  assert.equal(isSoloMatch({ result: { solo: false } }), false);
  assert.equal(isSoloMatch({ state: 'YARIS', max_players: 4, players: [{ id: 1, status: 'hazir' }, { id: 2, status: 'cikarildi' }] }), true);
  assert.equal(isSoloMatch({ state: 'LOBI', max_players: 4, players: [{ id: 1, status: 'geldi' }] }), false, 'salonda başkası gelebilir');
  assert.equal(isSoloMatch({ n: 1 }), true); assert.equal(isSoloMatch({ n: 3 }), false);
  const hr = historyRow({ id: 7, kind: 'fpv', n: 1, state: 'BITTI', track: 'Rafineri', rank: 1, created_at: '2026-10-20T10:00:00', ended_at: '2026-10-20T10:05:00', live: false, host: true });
  assert.deepEqual([hr.kind, hr.kindKey, hr.solo, hr.stateKey, hr.href, hr.date], ['fpv', 'fpv.kind_short', true, 'match.state_done', '#/fly/match/7', '2026-10-20T10:05:00']);
  assert.equal(historyRow({ id: 8, kind: null, n: 2, state: 'IPTAL' }).kindKey, 'df.kind_rings');
  assert.equal(matchKind({ kind: 'dogfight' }), 'dogfight'); assert.equal(matchKind({}), 'rings'); assert.equal(kindKey('fpv'), 'fpv.kind'); assert.equal(kindShortKey('dogfight'), 'df.kind_dogfight');
  assert.deepEqual(lbPlace([{ rank: 1 }, { rank: 2, me: true }, { rank: 3 }]), { rank: 2, n: 3 }); assert.equal(lbPlace([{ rank: 1 }]), null);
  // yeni bitiş nedenleri sözlükte (REASON_KEY → fpv.r_*)
  assert.equal(REASON_KEY.tamamlandi, 'fpv.r_tamamlandi'); assert.equal(REASON_KEY.son_cagri, 'fpv.r_son_cagri'); assert.equal(REASON_KEY.hepsi_bitirdi, 'fpv.r_hepsi_bitirdi');
});
test('i18n §29: ortak FPV_TEXTS (fpv.*) + kodda geçen fpvsm.* / fpv.* / top10.part_* anahtarları 7 dilde, yer tutucular eşit', () => {
  const I = join(ROOT, 'static/simumav/app/i18n');
  const dicts = Object.fromEntries(['tr', 'en', 'de', 'fr', 'es', 'ru', 'ar'].map(l => [l, JSON.parse(readFileSync(join(I, `${l}.json`), 'utf8'))]));
  const keys = new Set(FPV_TEXTS.map(([k]) => k));
  for (const [k, tx] of FPV_TEXTS) assert.equal(dicts.tr[k], tx, `tr.json ${k} ortak Türkçe metinle aynı olmalı`);
  const src = ['fly/fpv.js', 'fly/fpv_race.js', 'fly/match.js', 'fly/match_hud.js', 'fly/index.js', 'fly/match_core.js', 'tracks/index.js', 'menu/top10.js', 'fly/session.js'].map(f => readFileSync(join(ROOT, 'static/simumav/app', f), 'utf8')).join('\n');
  for (const m of src.matchAll(/'((?:fpvsm|fpv)\.[a-z_0-9]+)'/g)) if (!/\.(js|css)$/.test(m[1]) && !m[1].endsWith('_')) keys.add(m[1]);   // önek ('fpv.c_') değil
  for (const k of ['match', 'pace', 'discipline', 'intercept', 'fpv']) keys.add(`top10.part_${k}`);
  for (const id of COURSE_IDS) { keys.add(`fpv.c_${id}`); keys.add(`fpv.v_${id}`); }
  for (const k of ['penalty', 'reset', 'continue']) { keys.add(`fpv.rule_${k}`); keys.add(`fpv.rule_${k}_d`); }
  for (let d = 1; d <= 5; d++) keys.add(`fpv.d${d}`);
  assert.ok(keys.size > 160, `anahtar sayısı ${keys.size}`);
  for (const k of keys) for (const [l, d] of Object.entries(dicts)) {
    assert.ok(typeof d[k] === 'string' && d[k].trim(), `${l}.json ${k} yok`);
    assert.deepEqual((d[k].match(/\{\w+\}/g) || []).sort(), (dicts.tr[k].match(/\{\w+\}/g) || []).sort(), `${l}.json ${k} yer tutucu`);
  }
  for (const l of ['en', 'de', 'fr', 'es', 'ru', 'ar']) assert.notEqual(dicts[l]['fpv.c_woodframe'], dicts.tr['fpv.c_woodframe'], `${l}: parkur adı çevrilmiş`);
  assert.ok(/FPV/.test(dicts.tr['top10.formula']) && /FPV/.test(dicts.en['top10.formula']), 'TOP 10 formülünde FPV parkur bileşeni');
});

console.log('i18n');
test('kullanılan match.* anahtarları 7 dilde, yer tutucular eşit; durum/neden/hata eşlemeleri sözlükte', () => {
  const I = join(ROOT, 'static/simumav/app/i18n');
  const dicts = Object.fromEntries(['tr', 'en', 'de', 'fr', 'es', 'ru', 'ar'].map(l => [l, JSON.parse(readFileSync(join(I, `${l}.json`), 'utf8'))]));
  const FLY = join(ROOT, 'static/simumav/app/fly');
  const used = new Set();
  for (const f of readdirSync(FLY).filter(f => f.endsWith('.js'))) for (const m of readFileSync(join(FLY, f), 'utf8').matchAll(/'(match\.[a-z_0-9]+)'/g)) if (m[1] !== 'match.css') used.add(m[1]);
  for (const k of [...Object.values(STATUS_KEY), ...Object.values(STATE_KEY), ...Object.values(REASON_KEY), ...Object.values(JOIN_ERR_KEY)]) used.add(k);
  assert.ok(used.size > 120, `anahtar sayısı ${used.size}`);
  for (const k of used) for (const [l, d] of Object.entries(dicts)) {
    assert.ok(typeof d[k] === 'string' && d[k].trim(), `${l}.json ${k} yok`);
    assert.deepEqual((d[k].match(/\{\w+\}/g) || []).sort(), (dicts.tr[k].match(/\{\w+\}/g) || []).sort(), `${l}.json ${k} yer tutucu`);
  }
  void LIMITS;
});

console.log(`\n${n} test geçti`);
