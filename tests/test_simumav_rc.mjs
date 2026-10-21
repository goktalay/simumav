// SIMUMAV › Uç — HEPGO paritesi tarayıcısız testleri (static/simumav/app/fly/rc.js, hand_launch.js; HEPGO flightsim_interp.js):
//  1) Sanal kumanda (virtualRC, HEPGO kopyası): Mode 2 kanal eşlemesi, klavye entegrasyonu (kopter yaylı / uçak tutmalı gaz, throttle0),
//     Q/E mod kanalı, boşluk, pointer sürükleme, dispose → 8×0 ve dinleyicilerin kalkması (DOM/zamanlayıcı stub'larıyla).
//  2) netsim ayrıştırma + bozulmuş teslim (gecikme, jitter, kayıp).
//  3) Titreme: SIMUMAV sunucu `tele` karesi (tbm/tbm_pos, lat/lon, alt_rel, rs/ps/ys …) 50 Hz jitter'lı/kayıplı teslimle 3B'nin uyarlanır
//     tamponuna (createTimeline — flightsim3d.js setTelemetry'nin kullandığı) verilir → ardışık render karelerinde konum TEK YÖNLÜ ilerler
//     (geri sıçrama yok), DR seyrek. Elden atış kaydırması (shimTelemetry) zaman damgalarını ve açısal hızları korur.
// Çalıştırma: node tests/test_simumav_rc.mjs
import * as T from '../static/vendor/three/three.module.min.js';
import { createTimeline } from '../static/js/modules/flightsim_interp.js';
import { channelsOf, netsimDeliver, parseNetsim, pwm, roverChannelsOf, virtualRC } from '../static/simumav/app/fly/rc.js';
import { roverRcChannels } from '../static/js/modules/flightsim_rover.js';
import { shimTelemetry } from '../static/simumav/app/fly/hand_launch.js';

let fail = 0;
const ok = (k, c, extra = '') => { if (!c) { fail++; console.log('  BAŞARISIZ:', k, extra); } else console.log('  ok:', k); };
function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

// ---------- DOM / zamanlayıcı stub'ları ----------
function fakeStick() {
  const knob = { style: {} }, cls = new Set(), ls = {};
  return { knob, listeners: ls, querySelector: () => knob, classList: { add: c => cls.add(c), remove: c => cls.delete(c), contains: c => cls.has(c) },
    addEventListener: (t, f) => { ls[t] = f; }, removeEventListener: t => { delete ls[t]; }, setPointerCapture: () => {},
    getBoundingClientRect: () => ({ left: 100, top: 100, width: 130, height: 130 }) };
}
function fakeEnv() {
  const wl = {}; let now = 0; const ivs = [];
  return { now: () => now, step: ms => { now += ms; }, win: wl, ivs,
    env: { window: { addEventListener: (t, f) => { wl[t] = f; }, removeEventListener: t => { delete wl[t]; } }, document: { activeElement: null }, now: () => now,
      setInterval: (fn, ms) => { ivs.push({ fn, ms }); return ivs.length; }, clearInterval: id => { ivs[id - 1] = null; } } };
}

console.log('1) sanal kumanda');
{
  const E = fakeEnv(), L = fakeStick(), R = fakeStick(), sent = [];
  const rc = virtualRC({ plane: false, stickL: L, stickR: R, send: ch => sent.push(ch), env: E.env });
  const tick = (n, ms = 50) => { for (let i = 0; i < n; i++) { E.step(ms); rc.tick(); } };
  ok('kopter başlangıç: roll/pitch/yaw/gaz merkez 1500, ch5 1500, 6–8 = 0', JSON.stringify(rc.channels()) === JSON.stringify([1500, 1500, 1500, 1500, 1500, 0, 0, 0]), JSON.stringify(rc.channels()));
  ok('zamanlayıcı 20 Hz', E.ivs[0].ms === 50);
  E.win.keydown({ key: 'w', preventDefault() {} }); tick(10);
  const thrW = rc.channels()[2];
  ok('W basılı: gaz (ch3) yükselir', thrW > 1700, String(thrW));
  E.win.keyup({ key: 'w' }); tick(40);
  ok('W bırakıldı: kopter gazı askıya (1500) yaylı döner', rc.channels()[2] === 1500, String(rc.channels()[2]));
  E.win.keydown({ key: 'ArrowUp', preventDefault() {} }); tick(10);
  ok('↑ pitch ileri = ch2 DÜŞÜK PWM (burun aşağı)', rc.channels()[1] < 1200, String(rc.channels()[1]));
  E.win.keydown({ key: 'ArrowRight', preventDefault() {} }); E.win.keydown({ key: 'd', preventDefault() {} }); tick(10);
  ok('→ roll ch1 yüksek, D yaw ch4 yüksek', rc.channels()[0] > 1800 && rc.channels()[3] > 1800, JSON.stringify(rc.channels()));
  E.win.keyup({ key: 'ArrowUp' }); E.win.keyup({ key: 'ArrowRight' }); E.win.keyup({ key: 'd' }); tick(40);
  ok('bırakılınca merkeze döner', JSON.stringify(rc.channels().slice(0, 4)) === JSON.stringify([1500, 1500, 1500, 1500]), JSON.stringify(rc.channels()));
  E.win.keydown({ key: 'e', preventDefault() {} }); E.win.keydown({ key: 'e', preventDefault() {} }); E.win.keydown({ key: 'e', preventDefault() {} });
  ok('E ×3: ch5 mod anahtarı 2000 (sınır)', rc.channels()[4] === 2000);
  E.win.keydown({ key: 'q', preventDefault() {} }); ok('Q: ch5 1500', rc.channels()[4] === 1500);
  E.win.keydown({ key: 'x', preventDefault() {} }); ok('RC_KEYS dışı tuş yok sayılır', JSON.stringify(rc.channels().slice(0, 4)) === JSON.stringify([1500, 1500, 1500, 1500]));
  // pointer: sol çubuk en üst → gaz 2000 (sözleşme: SITL RC_CHANNELS 2000, Gaz %100)
  L.listeners.pointerdown({ pointerId: 7, clientX: 165, clientY: 100, preventDefault() {} }); tick(2);
  ok('sol çubuk EN ÜST → ch3 2000 (dokunmatik/fare pointer)', rc.channels()[2] === 2000 && L.classList.contains('on'), String(rc.channels()[2]));
  L.listeners.pointermove({ pointerId: 7, clientX: 165 - 49, clientY: 165 }); tick(1);
  ok('sol çubuk sola → yaw ch4 1000', rc.channels()[3] === 1000 && rc.channels()[2] === 1500, JSON.stringify(rc.channels()));
  L.listeners.pointermove({ pointerId: 9, clientX: 200, clientY: 100 });
  ok('başka pointerId yok sayılır', rc.channels()[3] === 1000);
  L.listeners.pointerup({ pointerId: 7 }); tick(40);
  ok('bırakıldı: yay merkeze', rc.channels()[3] === 1500 && !L.classList.contains('on'));
  E.win.keydown({ key: 'w', preventDefault() {} }); tick(3); E.win.keydown({ key: ' ', preventDefault() {} });
  ok('Boşluk: gaz 1500', rc.channels()[2] === 1500);
  E.win.keyup({ key: 'w' });
  const n0 = sent.length;
  rc.dispose();
  ok('dispose: tek sefer 8×0 (override serbest), zamanlayıcı ve dinleyiciler kalkar', sent.length === n0 + 1 && sent[n0].every(v => v === 0) && E.ivs[0] === null && !E.win.keydown && !L.listeners.pointerdown && L.knob.style.transform === '');
  rc.dispose(); ok('ikinci dispose etkisiz', sent.length === n0 + 1);
  // uçak: tutmalı gaz, boşta 1000; throttle0 (uçuşta açıldı) → çubuk o gazda başlar
  const E2 = fakeEnv(), p = virtualRC({ plane: true, stickL: fakeStick(), stickR: fakeStick(), send: () => {}, env: E2.env });
  ok('uçak başlangıç gazı 1000', p.channels()[2] === 1000);
  E2.win.keydown({ key: 'w', preventDefault() {} }); for (let i = 0; i < 10; i++) { E2.step(50); p.tick(); } E2.win.keyup({ key: 'w' }); for (let i = 0; i < 20; i++) { E2.step(50); p.tick(); }
  ok('uçakta W tutmalı: bırakınca gaz kalır (1000 < ch3 < 2000)', p.channels()[2] > 1100 && p.channels()[2] < 2000, String(p.channels()[2]));
  p.dispose();
  const p2 = virtualRC({ plane: true, stickL: fakeStick(), stickR: fakeStick(), send: () => {}, throttle0: 60, env: fakeEnv().env });
  ok('throttle0 %60 → ch3 1600', p2.channels()[2] === 1600, String(p2.channels()[2])); p2.dispose();
  ok('pwm sınırları 1000–2000', pwm(-5) === 1000 && pwm(5) === 2000 && pwm(0.25) === 1625);
  ok('channelsOf: pitch ters, 6–8 sıfır', JSON.stringify(channelsOf({ roll: 0.5, pitch: 0.5, thr: -1, yaw: -0.5 }, 1000)) === JSON.stringify([1750, 1250, 1000, 1250, 1000, 0, 0, 0]));
}

console.log('2) netsim');
{
  ok('parseNetsim', JSON.stringify(parseNetsim('jitter30,loss5,delay40')) === JSON.stringify({ jitter: 30, loss: 5, delay: 40 }) && parseNetsim('') === null && parseNetsim('abc') === null && parseNetsim('jitter12.5').jitter === 12.5);
  const calls = [];
  const timer = (f, ms) => calls.push(ms);
  const rnd = (() => { const v = [0.5, 0.0, 0.5, 1.0, 0.02]; let i = 0; return () => v[i++ % v.length]; })();
  ok('netsim yok → anında', netsimDeliver(null, () => calls.push('now')) === true && calls[0] === 'now');
  const ns = { jitter: 30, loss: 5, delay: 40 };
  netsimDeliver(ns, () => {}, rnd, timer);   // rnd 0.5 → kayıp değil; 0.0 → gecikme 40
  netsimDeliver(ns, () => {}, rnd, timer);   // 0.5 → değil; 1.0 → 40 + 60 = 100
  const kayip = netsimDeliver(ns, () => {}, rnd, timer);   // 0.02 → %2 < %5 → kayıp
  ok('gecikme = delay + U(0, 2·jitter); kayıp düşürülür', calls[1] === 40 && calls[2] === 100 && kayip === false && calls.length === 3, JSON.stringify(calls));
}

console.log('3) titreme: SIMUMAV tele akışı → uyarlanır tampon (tek yönlü ilerleme)');
{
  // SIMUMAV sunucu karesi (flightsim.py _tele_yay): tbm/tbm_pos (ms), lat/lon, alt_rel, roll/pitch/yaw (rad), vn/ve/vd, rs/ps/ys
  const lat0 = 40.1, lon0 = 33.4;
  const toLocal = (lat, lon) => ({ x: (lon - lon0) * 111320 * Math.cos(lat0 * Math.PI / 180), y: (lat - lat0) * 110574 });
  const source = ms => {   // kalkış sonrası tırmanış: kuzeye 12 m/s, 3 m/s tırmanış, yaw 0, hafif roll salınımı
    const s = ms / 1000, y = 12 * s, z = 5 + 3 * s;
    return { t: 'tele', tbm: ms, tbm_pos: ms - 7, lat: lat0 + y / 110574, lon: lon0, alt_rel: z, roll: 0.05 * Math.sin(s * 1.3), pitch: 0.12, yaw: 0, vn: 12, ve: 0, vd: -3, rs: 0.05 * 1.3 * Math.cos(s * 1.3), ps: 0, ys: 0, armed: true, mode: 'GUIDED', groundspeed: 12 };
  };
  const run = ({ jitter, loss, delay, fps, secs }) => {
    const r = rng(7);
    const ns = jitter || loss || delay ? { jitter, loss, delay } : null;
    const teslim = [];   // {at, t} → alım zamanına göre sıralanır (netsimDeliver setTimeout: sıra bozulabilir)
    for (let ms = 0; ms < secs * 1000; ms += 20) {
      const t = source(ms);
      netsimDeliver(ns, () => teslim.push({ at: ms + 30, t }), r, (f, d) => { teslim.push({ at: ms + 30 + d, t }); });
    }
    teslim.sort((a, b) => a.at - b.at);
    const tl = createTimeline(T, { toLocal });
    const dtF = 1000 / fps;
    let now = 0, i = 0, frames = 0, back = 0, backZ = 0, maxStep = 0;
    let prev = null, prevD = null;
    tl.motionStats(true);
    for (let k = 0; k < secs * fps; k++) {
      now += dtF;
      while (i < teslim.length && teslim[i].at <= now) { tl.push(teslim[i].t, teslim[i].at); i++; }
      if (!tl.has) continue;
      tl.advance(dtF);
      const p = tl.cur.pos.clone();
      if (prev && now > 1500) {   // ilk 1,5 sn: tampon dolar
        const d = p.clone().sub(prev);
        frames++;
        if (d.z < -1e-6) backZ++;                                   // tırmanışta irtifa geri gitmez
        if (prevD && d.dot(prevD) < 0 && d.length() > 1e-4) back++;   // yön tersine dönmez (geri sıçrama)
        maxStep = Math.max(maxStep, d.length());
        prevD = d;
      }
      prev = p;
    }
    const m = tl.motionStats(false), n = tl.netStats();
    return { frames, back, backZ, maxStep: +maxStep.toFixed(3), ideal: +(Math.hypot(12, 3) * dtF / 1000).toFixed(3), posJerk: +m.posJerk.toFixed(4), angJerk: +m.angJerk.toFixed(4), dr: m.drEnters, delay: n.delay, hz: n.hz, jitter: n.jitter };
  };
  for (const [ad, o] of [['temiz ağ 60 fps', { jitter: 0, loss: 0, delay: 0, fps: 60, secs: 20 }], ['jitter 30 + gecikme 40 + %5 kayıp (Cloudflare tüneli), 60 fps', { jitter: 30, loss: 5, delay: 40, fps: 60, secs: 30 }],
    ['jitter 60 + %10 kayıp, 25 fps (SwiftShader/zayıf GPU)', { jitter: 60, loss: 10, delay: 40, fps: 25, secs: 30 }]]) {
    const m = run(o);
    console.log(`  ${ad}: ${m.frames} kare · yön tersine ${m.back} · irtifa geri ${m.backZ} · maks adım ${m.maxStep} m (ideal ${m.ideal}) · konum jerk ${m.posJerk} · yönelim jerk ${m.angJerk}° · DR ${m.dr} · tampon ${m.delay} ms · ${m.hz} Hz jitter ${m.jitter} ms`);
    ok(`${ad}: konum tek yönlü (geri sıçrama yok)`, m.back === 0 && m.backZ === 0);
    ok(`${ad}: maks adım < 3× ideal, DR ≤ 1`, m.maxStep < 3 * m.ideal + 0.05 && m.dr <= 1, `${m.maxStep} / ${m.ideal} · DR ${m.dr}`);
  }
  // elden atış kaydırması: zaman damgaları ve açısal hızlar korunur (interp aynı kaynak zamanını görür), tutuşta hızlar sıfır
  const raw = source(1234);
  const o = shimTelemetry(raw, { dx: 0.5, dz: 1.6, pitch_deg: 12, roll_deg: 0, blend: 0, hold: true, phase: 'armed' }, 90);
  ok('shimTelemetry: tbm/tbm_pos/rs/ps/ys korunur, konum/irtifa kaydırılır, hızlar 0', o.tbm === 1234 && o.tbm_pos === 1227 && o.rs === raw.rs && o.ps === 0 && o.alt_rel === raw.alt_rel + 1.6 && o.groundspeed === 0 && o.vn === 0 && Math.abs(o.pitch - 12 * Math.PI / 180) < 1e-9 && o.lon > raw.lon);
  ok('shimTelemetry: blend ≥ 1 ve tutuş yok → aynı nesne', shimTelemetry(raw, { blend: 1, hold: false }) === raw);
}

console.log('§15 kara aracı sanal kumandası');
{
  const E = fakeEnv(), L = fakeStick(), R = fakeStick(), sent = [];
  const rc = virtualRC({ plane: true, rover: { channels: roverRcChannels }, stickL: L, stickR: R, send: ch => sent.push(ch), env: E.env, throttle0: 80 });
  const tick = (n, ms = 50) => { for (let i = 0; i < n; i++) { E.step(ms); rc.tick(); } };
  ok('rover başlangıç: RC1/RC3 1500 (dur), RC2/RC4 0 (dokunma); uçak bayrağı/gaz tutuşu etkisiz', JSON.stringify(rc.channels()) === JSON.stringify([1500, 0, 1500, 0, 1500, 0, 0, 0]), JSON.stringify(rc.channels()));
  ok('yedek eşleme roverRcChannels ile aynı', JSON.stringify(roverChannelsOf({ steer: 0.4, thr: -0.7, ch5: 2000 })) === JSON.stringify(roverRcChannels({ steer: 0.4, thr: -0.7, ch5: 2000 })));
  E.win.keydown({ key: 'w', preventDefault() {} }); E.win.keydown({ key: 'd', preventDefault() {} }); tick(10);
  const c1 = rc.channels();
  ok('W ileri gaz (RC3 > 1500), D sağ direksiyon (RC1 > 1500)', c1[2] > 1800 && c1[0] > 1800 && c1[1] === 0 && c1[3] === 0, JSON.stringify(c1));
  E.win.keyup({ key: 'w' }); E.win.keyup({ key: 'd' }); tick(20);
  ok('bırakınca yaylı: gaz ve direksiyon merkeze (1500 = dur)', rc.channels()[2] === 1500 && rc.channels()[0] === 1500, JSON.stringify(rc.channels()));
  E.win.keydown({ key: 'arrowdown', preventDefault() {} }); E.win.keydown({ key: 'arrowleft', preventDefault() {} }); tick(10);
  ok('↓ geri/fren (RC3 < 1500), ← sol (RC1 < 1500)', rc.channels()[2] < 1200 && rc.channels()[0] < 1200, JSON.stringify(rc.channels()));
  E.win.keydown({ key: ' ', preventDefault() {} });
  ok('Boşluk: dur (gaz + direksiyon orta)', rc.axes.thr === 0 && rc.axes.steer === 0);
  E.win.keyup({ key: 'arrowdown' }); E.win.keyup({ key: 'arrowleft' });
  L.listeners.pointerdown({ pointerId: 1, clientX: 165 + 40, clientY: 165 - 57, preventDefault() {} });
  ok('sol çubuk: yatay yok sayılır, dikey gaz', rc.axes.thr > 0.9 && rc.axes.steer === 0 && rc.axes.yaw === 0, JSON.stringify(rc.axes));
  R.listeners.pointerdown({ pointerId: 2, clientX: 165 - 57, clientY: 165 + 40, preventDefault() {} });
  ok('sağ çubuk: yatay direksiyon, dikey yok sayılır', rc.axes.steer < -0.9 && rc.axes.pitch === 0, JSON.stringify(rc.axes));
  L.listeners.pointerup({ pointerId: 1 }); R.listeners.pointerup({ pointerId: 2 }); tick(20);
  ok('çubuklar bırakılınca merkeze döner', rc.channels()[2] === 1500 && rc.channels()[0] === 1500, JSON.stringify(rc.channels()));
  const shaped = virtualRC({ plane: false, rover: true, stickL: fakeStick(), stickR: fakeStick(), send: () => {}, env: fakeEnv().env, shape: (k, v) => (k === 'roll' ? v * 0.5 : v) });
  shaped.axes.steer = 1; shaped.axes.thr = 1;
  ok('hassasiyet eğrisi: direksiyon roll eğrisinden, gaz thr eğrisinden', JSON.stringify(shaped.channels()) === JSON.stringify([1750, 0, 2000, 0, 1500, 0, 0, 0]), JSON.stringify(shaped.channels()));
  rc.dispose(); shaped.dispose();
  ok('dispose → 8×0 (override serbest)', JSON.stringify(sent[sent.length - 1]) === JSON.stringify([0, 0, 0, 0, 0, 0, 0, 0]));
}

if (fail) { console.log(`\n${fail} kontrol BAŞARISIZ`); process.exit(1); }
console.log('\nSIMUMAV Uç parite testleri geçti.');
