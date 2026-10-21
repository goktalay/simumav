// SIMUMAV › Uç › ÇOK OYUNCULU KARŞILAŞMA (docs/simumav.md §18) — tarayıcısız birim testleri. Çalıştırma: node tests/test_simumav_match.mjs
//   • fly/match_core.js: rota ayrıştırma (#/fly/…), davet bağlantısı, halka/şifre/oyuncu doğrulaması (i18n anahtarı), şifre önerisi, salon görünüm
//     modeli, yarışa geçiş kararı, sonuç satırları, biçimler, kuş bakışı ölçek
//   • fly/wizard.js createWizard(…, {match:true}): adımlar (dron → parkur → [kalkış] → halkalar → davet), İleri/hazır kuralları, POST /api/match gövdesi
//   • i18n: kullanılan match.* anahtarları 7 dilde (yer tutucular eşit)
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { genPassword, inviteLink, isMatchType, LIMITS, lobbyHref, lobbyView, joinErrorKey, parseFlyParam, passwordErrorKey, phaseOf, playersErrorKey, raceHref, resultRows,
  ringsBody, ringsDefaults, ringsErrorKey, shouldEnterRace, typeClass, viewBox, fmtClock, fmtDist, STATUS_KEY, STATE_KEY, REASON_KEY, JOIN_ERR_KEY } from '../static/simumav/app/fly/match_core.js';
import { createWizard, STEP_TITLES } from '../static/simumav/app/fly/wizard.js';

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
  assert.equal(playersErrorKey(1), 'match.err_players'); assert.equal(playersErrorKey(3, { players: [2, 3] }), null); assert.equal(playersErrorKey(4, { players: [2, 3] }), 'match.err_players');
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
  assert.deepEqual(W.payload(), { drone_id: 1, track_id: 10, launch: { method: 'wheels' }, rings: { count: 8, min_alt_m: 15, max_alt_m: 60, radius_m: 220, time_limit_min: 15, seed: 5 }, password: 'K7P4QX', max_players: 3 });
  W.set('invite_err', 'match.err_pw_len'); assert.equal(W.ready(), false);
  assert.ok(STEP_TITLES.rings === 'match.step_rings' && STEP_TITLES.invite === 'match.step_invite');
  // tek oyunculu sihirbaz değişmedi
  assert.deepEqual(createWizard(DATA).steps(), ['drone', 'track', 'power', 'mission', 'site', 'targets', 'pilot']);
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
