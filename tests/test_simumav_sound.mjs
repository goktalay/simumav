// SIMUMAV ses düzeyleri + arka plan müziği + hareketli arka planlar (saf kısımlar): kanal tercihleri (sm.music / sm.sfx / sm.gpws +
// sm.alertvol / fs.audio.*), mevcut anahtarlarla uyum, müzik bastırma (uçuşta 0), müzik kuramı (akor/arpej tohumlu ve sınırlı),
// bölüm → sahne eşlemesi, reduced-motion / düşük güç bütçesi, CAYMAZ atlas karesi. Çalıştır: node tests/test_simumav_sound.mjs
import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const APP = join(ROOT, 'static/simumav/app');
let n = 0;
const ok = m => { n++; console.log('  ✓', m); };
const mem = (init = {}) => { const m = new Map(Object.entries(init)); return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: k => m.delete(k), _m: m }; };

const mix = await import(join(APP, 'ui/audiomix.js'));
const { readMix, writeMix, gainOf, musicDuck, withAlertGain, DEFAULTS, CHANNELS } = mix;

// 1) varsayılanlar
{
  const st = mem(), m = readMix(st);
  assert.deepEqual(CHANNELS, ['music', 'sfx', 'alert', 'engine']);
  assert.deepEqual(m.music, DEFAULTS.music); assert.deepEqual(m.sfx, DEFAULTS.sfx); assert.deepEqual(m.engine, DEFAULTS.engine);
  assert.equal(m.alert.on, true); assert.equal(m.alert.mode, 'full'); assert.equal(m.alert.vol, 100);
  ok('varsayılan karışım: müzik 55, efekt 80, uyarı tam 100, motor 70');
}
// 2) mevcut anahtarlarla uyum (HEPGO flightsim_sfx sm.sfx {on,vol}; sm.gpws {mode, off, lang}; fs.audio.on/vol dizeleri)
{
  const st = mem({ 'sm.sfx': JSON.stringify({ on: false, vol: 35 }), 'sm.gpws': JSON.stringify({ mode: 'visual', off: ['STALL'], lang: 'ui' }), 'fs.audio.on': '0', 'fs.audio.vol': '42' });
  const m = readMix(st);
  assert.deepEqual(m.sfx, { on: false, vol: 35 }); assert.equal(m.alert.on, false); assert.equal(m.alert.mode, 'visual'); assert.deepEqual(m.engine, { on: false, vol: 42 });
  writeMix('alert', { on: true }, st);
  const gp = JSON.parse(st.getItem('sm.gpws'));
  assert.equal(gp.mode, 'full'); assert.deepEqual(gp.off, ['STALL']); assert.equal(gp.lang, 'ui');   // diğer alanlar korunur
  writeMix('alert', { on: false }, st); assert.equal(JSON.parse(st.getItem('sm.gpws')).mode, 'visual');
  writeMix('alert', { vol: 63 }, st); assert.equal(readMix(st).alert.vol, 63);
  writeMix('engine', { on: true, vol: 88 }, st); assert.equal(st.getItem('fs.audio.on'), '1'); assert.equal(st.getItem('fs.audio.vol'), '88');
  writeMix('sfx', { vol: 150 }, st); assert.deepEqual(JSON.parse(st.getItem('sm.sfx')), { on: false, vol: 100 });   // sınır
  writeMix('music', { on: false }, st); assert.deepEqual(readMix(st).music, { on: false, vol: 55 });
  assert.throws(() => writeMix('yok', {}, st));
  // bozuk JSON → varsayılan
  const bad = mem({ 'sm.music': '{bozuk', 'sm.gpws': '"x"' }); assert.deepEqual(readMix(bad).music, DEFAULTS.music); assert.equal(readMix(bad).alert.mode, 'full');
  ok('tercihler kalıcı + mevcut anahtarlarla uyumlu (sm.sfx, sm.gpws alanları korunur, fs.audio.*), sınır ve bozuk veri');
}
// 3) kazanç eğrisi + müzik bastırma
{
  assert.equal(gainOf({ on: false, vol: 100 }), 0); assert.equal(gainOf({ on: true, vol: 0 }), 0); assert.equal(gainOf({ on: true, vol: 100 }), 1);
  assert.ok(Math.abs(gainOf({ on: true, vol: 50 }) - Math.pow(0.5, 1.5)) < 1e-9);
  assert.equal(musicDuck({ screen: 'menu' }), 1); assert.equal(musicDuck({ screen: 'hangar' }), 1);
  assert.equal(musicDuck({ screen: 'fly' }), 0.7); assert.equal(musicDuck({ screen: 'fly', inFlight: true }), 0); assert.equal(musicDuck({ screen: 'menu', hidden: true }), 0);
  ok('kazanç eğrisi (vol/100)^1.5; müzik: menü 1, Uç sihirbazı 0,7, uçuş oturumu 0, gizli sekme 0');
}
// 4) §42 uyarı yolu vekili: alertBus kazancı + konuşma düzeyi ölçeklenir, diğer üyeler aynen
{
  const st = mem({ 'sm.alertvol': JSON.stringify({ vol: 25 }) });
  const bus = { gain: { value: 1 } };
  const audio = { alertBus: () => ({ ctx: {}, bus }), prefs: { volume: 80, enabled: true }, get menu() { return 'M'; }, other: 7 };
  const p = withAlertGain(audio, st);
  p.alertBus(); assert.ok(Math.abs(bus.gain.value - Math.pow(0.25, 1.5)) < 1e-9);
  assert.ok(Math.abs(p.prefs.volume - 80 * Math.pow(0.25, 1.5)) < 1e-9); assert.equal(p.menu, 'M'); assert.equal(p.other, 7);
  assert.equal(withAlertGain(null), null);
  ok('uyarı düzeyi (sm.alertvol) §42 alertBus + konuşma düzeyine uygulanır');
}
// 5) müzik kuramı (saf): döngü uzunluğu, akor sırası, arpej tohumlu/deterministik ve akor tonlarından
{
  const M = await import(join(APP, 'ui/music.js'));
  assert.equal(M.LOOP_STEPS, 128); assert.equal(M.chordAt(0).name, 'Am7'); assert.equal(M.chordAt(32).name, 'Fmaj7'); assert.equal(M.chordAt(127).name, 'G6'); assert.equal(M.chordAt(128).name, 'Am7');
  assert.equal(M.midiHz(69), 440); assert.ok(Math.abs(M.stepDur() - 60 / 76 / 4) < 1e-12);
  const a = M.arpNotes(3, 1), b = M.arpNotes(3, 1), c = M.arpNotes(3, 2);
  assert.deepEqual(a, b); assert.notDeepEqual(a, c); assert.equal(a.length, 8);
  for (let bar = 0; bar < 8; bar++) {
    const ch = M.PROG[Math.floor(bar / 2)], allowed = new Set([...ch.notes.map(x => x + 12), ch.notes[0] + 24]);
    for (const nn of M.arpNotes(bar, 0)) if (nn != null) assert.ok(allowed.has(nn), `arpej akor dışı ${nn}`);
  }
  assert.equal(M.targetLevel({ music: { on: true, vol: 100 } }, 0), 0); assert.ok(M.targetLevel({ music: { on: true, vol: 100 } }, 1) > 0.8);
  assert.equal(M.state().playing, false);
  ok('müzik: 128 adımlık döngü (Am7–Fmaj7–Cmaj7–G6), tohumlu arpej akor tonlarından, uçuşta hedef 0');
}
// 6) bölüm → sahne, bütçe, düşük güç
{
  const B = await import(join(APP, 'ui/backdrop.js'));
  assert.equal(B.sceneFor('menu'), null);
  assert.equal(B.sceneFor('hangar'), 'hangar'); assert.equal(B.sceneFor('crew'), 'crew'); assert.equal(B.sceneFor('tracks'), 'tracks'); assert.equal(B.sceneFor('missions'), 'missions'); assert.equal(B.sceneFor('fly'), 'caymaz');
  assert.equal(B.sceneFor('fly', { inFlight: true }), null); assert.equal(B.sceneFor('hangar', { enabled: false }), null);
  for (const x of ['ops', 'settings', 'support', 'nope']) assert.equal(B.sceneFor(x), null);
  assert.equal(B.budget({ reduced: true }).animate, false); assert.equal(B.budget({}).animate, true);
  assert.equal(B.budget({}).fps, 30); assert.equal(B.budget({ lowPower: true }).fps, 24);
  assert.ok(B.budget({ lowPower: true }).scale < B.budget({}).scale); assert.ok(B.budget({ lowPower: true }).density < 1);
  assert.ok(B.budget({ dpr: 3 }).scale <= 1);
  assert.equal(B.isLowPower({ hardwareConcurrency: 4 }), true); assert.equal(B.isLowPower({ hardwareConcurrency: 8, deviceMemory: 8 }), false); assert.equal(B.isLowPower({ hardwareConcurrency: 8 }, true), true);
  assert.equal(B.bgEnabled(mem({ 'sm:bgfx': '0' })), false); assert.equal(B.bgEnabled(mem()), true);
  ok('bölüm→sahne (menü yok, hangar/crew/tracks/missions/fly→caymaz, uçuşta yok), reduced → durağan, düşük güç 24 fps');
}
// 7) sahne modülü + CAYMAZ atlası
{
  const S = await import(join(APP, 'ui/backdrop/scenes.js'));
  assert.deepEqual(Object.keys(S.SCENES).sort(), ['caymaz', 'crew', 'hangar', 'missions', 'tracks']);
  assert.deepEqual(S.atlasFrame(0), { i0: 0, i1: 1, k: 0 }); assert.equal(S.atlasFrame(360).i0, 0); assert.equal(S.atlasFrame(-11.25).i0, 31);
  const f = S.atlasFrame(95.625); assert.equal(f.i0, 8); assert.ok(Math.abs(f.k - 0.5) < 1e-9);
  const atlas = join(APP, 'ui/backdrop/caymaz_atlas.webp');
  assert.ok(existsSync(atlas)); const sz = statSync(atlas).size; assert.ok(sz > 20000 && sz < 400000, `atlas boyutu ${sz}`);
  const hdr = readFileSync(atlas).subarray(0, 12).toString('latin1'); assert.ok(hdr.startsWith('RIFF') && hdr.endsWith('WEBP'));
  ok(`sahneler (5) + CAYMAZ atlası (${(sz / 1024).toFixed(0)} KB WebP, 32 kare) + kare karışımı`);
}
// 8) statik denetim: arka plan WebGL kullanmaz; kabuk bağlantıları; lisans kaydı
{
  const src = ['ui/backdrop.js', 'ui/backdrop/scenes.js', 'ui/music.js'].map(f => readFileSync(join(APP, f), 'utf8')).join('\n');
  assert.ok(!/getContext\(\s*['"](webgl|webgl2|experimental-webgl)/.test(src), 'arka plan WebGL bağlamı açmamalı');
  assert.ok(!/new Audio\(|\.mp3|\.ogg|https?:\/\//.test(src.replace(/\/\/.*$/gm, '')), 'müzik dış dosya/CDN kullanmamalı');
  const app = readFileSync(join(APP, 'app.js'), 'utf8');
  assert.match(app, /sm-fly-session/); assert.match(app, /backdrop\.setScene/); assert.match(app, /music\.initMusic\(\)/);
  assert.match(readFileSync(join(APP, 'fly/session.js'), 'utf8'), /withAlertGain\(audio\)/);
  assert.match(readFileSync(join(APP, 'settings/index.js'), 'utf8'), /mixRow\('music'/);
  const lic = readFileSync(join(ROOT, 'static/simumav/LICENSES.md'), 'utf8');
  assert.match(lic, /music\.js/); assert.match(lic, /caymaz_atlas\.webp/);
  ok('arka plan Canvas2D (WebGL yok), müzik prosedürel (dosya yok), kabuk/ayar/uçuş bağlantıları, LICENSES.md kaydı');
}
console.log(`\n${n} test grubu geçti`);
