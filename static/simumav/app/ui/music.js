// SIMUMAV arka plan müziği — PROSEDÜREL (Web Audio sentezi; dosya/CDN/üçüncü taraf varlık YOK → lisans sorunu yok).
// Yumuşak ambient/synthwave döngü: La minör (Am7 → Fmaj7 → Cmaj7 → G6), 76 BPM, akor başına 2 ölçü (8 ölçü ≈ 25 sn döngü).
// Katmanlar: pad (akor başına 4 nota × 2 ayarsız testere, yavaş süzgeç LFO'su) · bas (kök, 1. ve 3. vuruş) · arpej (üçgen pluck, tohumlu
// desen — her döngüde hafif değişir, gecikme + yankı) · çan (2 ölçüde bir, uzun sönüm). Yankı: üretilmiş dürtü yanıtı (ConvolverNode).
// Zincir: sesler → müzik yolu (kanal düzeyi sm.music × bastırma) → kompresör → ui/sfx.js ana kazancı (Ana ses / Ana düzey) → çıkış.
// Otomatik oynatma kuralı: ilk kullanıcı etkileşiminde başlar (yumuşak fade-in 2,5 sn). Bölümler arası kesintisiz (kabuk düzeyinde yaşar).
// Uçuş oturumu (3B) → fade-out 1,2 sn ve zamanlayıcı DURUR (CPU 0); sekme gizli → aynı. Saf kısımlar (chordAt, arpNotes, rng) node ile test edilir.
import * as sfx from './sfx.js';
import { readMix, gainOf, musicDuck } from './audiomix.js';

export const BPM = 76, STEPS_PER_BAR = 16, BARS_PER_CHORD = 2;
// MIDI notaları (A3 = 57)
export const PROG = [
  { name: 'Am7', root: 45, notes: [57, 60, 64, 67] },
  { name: 'Fmaj7', root: 41, notes: [53, 57, 60, 64] },
  { name: 'Cmaj7', root: 48, notes: [55, 59, 60, 64] },
  { name: 'G6', root: 43, notes: [55, 59, 62, 64] },
];
export const LOOP_STEPS = PROG.length * BARS_PER_CHORD * STEPS_PER_BAR;   // 128 adım (16'lık)
export const stepDur = (bpm = BPM) => 60 / bpm / 4;
export const midiHz = m => 440 * Math.pow(2, (m - 69) / 12);
/** Adım → akor (saf). */
export const chordAt = step => PROG[Math.floor((((step % LOOP_STEPS) + LOOP_STEPS) % LOOP_STEPS) / (STEPS_PER_BAR * BARS_PER_CHORD))];
/** Tohumlu sözde rastgele (mulberry32; saf). */
export function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
/** Bir ölçünün arpej notaları (saf): 8'lik (adım 0,2,4…14) → MIDI ya da null (sus). Akor tonları + oktav, döngü numarasıyla değişir. */
export function arpNotes(bar, loop = 0) {
  const ch = PROG[Math.floor((bar % (PROG.length * BARS_PER_CHORD)) / BARS_PER_CHORD)];
  const r = rng(1000 + loop * 37 + bar * 7), tones = [...ch.notes.map(n => n + 12), ch.notes[0] + 24];
  const out = [];
  for (let i = 0; i < 8; i++) out.push(r() < (i === 0 ? 0.02 : 0.28) ? null : tones[(i * 2 + Math.floor(r() * 3)) % tones.length]);
  return out;
}

const S = { started: false, playing: false, nodes: null, timer: 0, step: 0, nextT: 0, loop: 0, duckTarget: 1, screen: 'menu', inFlight: false, hidden: false, stopT: 0, wantStart: false };

function impulse(c, sec = 3.2, decay = 2.6) {
  const n = Math.floor(c.sampleRate * sec), b = c.createBuffer(2, n, c.sampleRate);
  for (let ch = 0; ch < 2; ch++) { const d = b.getChannelData(ch); for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / n, decay); }
  return b;
}
function build() {
  const b = sfx.bus(); if (!b) return null;
  const c = b.ctx;
  const out = c.createGain(); out.gain.value = 0;                              // kanal × bastırma (fade burada)
  const comp = c.createDynamicsCompressor(); comp.threshold.value = -20; comp.ratio.value = 3; comp.attack.value = 0.05; comp.release.value = 0.4;
  out.connect(comp); comp.connect(b.master);
  const dry = c.createGain(); dry.gain.value = 0.8; dry.connect(out);
  const verb = c.createConvolver(); verb.buffer = impulse(c); const wet = c.createGain(); wet.gain.value = 0.55; verb.connect(wet); wet.connect(out);
  const delay = c.createDelay(1.5); delay.delayTime.value = stepDur() * 3; const fb = c.createGain(); fb.gain.value = 0.38; const dlp = c.createBiquadFilter(); dlp.type = 'lowpass'; dlp.frequency.value = 2400;
  delay.connect(dlp); dlp.connect(fb); fb.connect(delay); dlp.connect(verb); dlp.connect(dry);
  // pad süzgeci + yavaş LFO (sürekli; uçuşta zamanlayıcıyla birlikte durdurulur)
  const padLp = c.createBiquadFilter(); padLp.type = 'lowpass'; padLp.frequency.value = 900; padLp.Q.value = 0.6; padLp.connect(dry); padLp.connect(verb);
  const lfo = c.createOscillator(); lfo.frequency.value = 0.045; const lg = c.createGain(); lg.gain.value = 420; lfo.connect(lg); lg.connect(padLp.frequency); lfo.start();
  return { c, out, dry, verb, delay, padLp, lfo };
}

function env(g, t0, a, hold, r, peak) {
  g.gain.setValueAtTime(0.0001, t0); g.gain.exponentialRampToValueAtTime(peak, t0 + a);
  g.gain.setValueAtTime(peak, t0 + a + hold); g.gain.exponentialRampToValueAtTime(0.0001, t0 + a + hold + r);
  return t0 + a + hold + r + 0.05;
}
function voice(type, hz, t0, a, hold, r, peak, dest, detune = 0) {
  const n = S.nodes, o = n.c.createOscillator(), g = n.c.createGain();
  o.type = type; o.frequency.value = hz; o.detune.value = detune; o.connect(g);
  for (const d of [].concat(dest)) g.connect(d);
  o.start(t0); o.stop(env(g, t0, a, hold, r, peak));
  o.onended = () => { try { g.disconnect(); } catch { /* */ } };
}
function scheduleStep(step, t) {
  const n = S.nodes, sd = stepDur(), inBar = step % STEPS_PER_BAR, bar = Math.floor(step / STEPS_PER_BAR);
  const ch = chordAt(step), chordLen = STEPS_PER_BAR * BARS_PER_CHORD * sd;
  if (step % (STEPS_PER_BAR * BARS_PER_CHORD) === 0) {   // pad
    for (const m of ch.notes) for (const dt of [-7, 7]) voice('sawtooth', midiHz(m), t, 1.6, chordLen - 1.2, 2.4, 0.022, n.padLp, dt);
    voice('sine', midiHz(ch.notes[0] - 12), t, 2, chordLen - 1.5, 2.5, 0.05, n.dry);
  }
  if (inBar === 0 || inBar === 8) voice('triangle', midiHz(ch.root), t, 0.04, sd * 5, 0.6, 0.09, n.dry);   // bas
  if (inBar % 2 === 0) {   // arpej
    const m = arpNotes(bar, S.loop)[inBar / 2];
    if (m != null) voice('triangle', midiHz(m), t, 0.008, 0.03, 0.55, 0.035, [n.dry, n.delay]);
  }
  if (inBar === 12 && bar % 2 === 1) voice('sine', midiHz(ch.notes[2] + 24), t, 0.01, 0.05, 2.6, 0.018, [n.verb, n.delay]);   // çan
}
function tick() {
  const n = S.nodes; if (!n) return;
  const now = n.c.currentTime, ahead = 0.5, sd = stepDur();
  if (S.nextT < now) S.nextT = now + 0.05;
  while (S.nextT < now + ahead) {
    scheduleStep(S.step, S.nextT);
    S.step++; if (S.step % LOOP_STEPS === 0) { S.step = 0; S.loop++; }
    S.nextT += sd;
  }
}
/** Sustu: zamanlayıcı durur, LFO durdurulur ve müzik düğümleri bırakılır (uçuşta ses iş parçacığında da yük kalmaz; dönüşte yeniden kurulur). */
function teardown() {
  clearInterval(S.timer); S.timer = 0; S.playing = false;
  const n = S.nodes; S.nodes = null;
  if (n) { try { n.lfo.stop(); n.out.disconnect(); n.delay.disconnect(); } catch { /* */ } }
}
/** Hedef düzey (kanal × bastırma); 0 ise belirli süre sonra zamanlayıcı durur. */
export const targetLevel = (mix = readMix(), duck = 1) => gainOf(mix.music) * duck * 0.9;

function apply(fadeIn = 2.5, fadeOut = 1.2) {
  const lvl = sfx.config().sound ? targetLevel(readMix(), musicDuck({ screen: S.screen, inFlight: S.inFlight, hidden: S.hidden })) : 0;
  S.duckTarget = lvl;
  if (lvl <= 0.0005) {
    if (!S.nodes) return;
    const g = S.nodes.out.gain, t = S.nodes.c.currentTime;
    g.cancelScheduledValues(t); g.setValueAtTime(Math.max(0.0001, g.value), t); g.exponentialRampToValueAtTime(0.0001, t + fadeOut);
    clearTimeout(S.stopT); S.stopT = setTimeout(() => { if (S.duckTarget <= 0.0005) teardown(); }, fadeOut * 1000 + 100);
    return;
  }
  if (!S.nodes) { S.nodes = build(); if (!S.nodes) { S.wantStart = true; return; } S.nextT = S.nodes.c.currentTime + 0.1; }
  clearTimeout(S.stopT);
  if (!S.timer) { S.timer = setInterval(tick, 120); tick(); }
  S.playing = true;
  const g = S.nodes.out.gain, t = S.nodes.c.currentTime;
  g.cancelScheduledValues(t); g.setValueAtTime(Math.max(0.0001, g.value), t); g.exponentialRampToValueAtTime(Math.max(0.0002, lvl), t + (g.value < lvl ? fadeIn : 0.6));
}

/** Kabuk başlatır: ilk etkileşimde müzik açılır. */
export function initMusic() {
  if (S.started || typeof window === 'undefined') return;
  S.started = true;
  const kick = () => { if (S.nodes) return; apply(); if (S.nodes) for (const ev of ['pointerdown', 'keydown', 'touchend']) window.removeEventListener(ev, kick, true); };
  for (const ev of ['pointerdown', 'keydown', 'touchend']) window.addEventListener(ev, kick, { passive: true, capture: true });
  document.addEventListener('visibilitychange', () => { S.hidden = document.hidden; apply(); });
  window.addEventListener('sm:mix', () => apply(1.2));
  window.addEventListener('sm:sound', () => apply(1.2));
}
/** Ekran / uçuş durumu (kabuk router'ı ve uçuş gözlemcisi çağırır). */
export function setScene(screen, { inFlight = false } = {}) {
  const changed = screen !== S.screen || inFlight !== S.inFlight;
  S.screen = screen; S.inFlight = !!inFlight;
  if (changed && S.started) apply();
}
/** Teşhis: window.__smMusic(). */
export const state = () => ({ playing: S.playing, level: S.nodes ? +S.nodes.out.gain.value.toFixed(4) : 0, target: +S.duckTarget.toFixed(4), screen: S.screen, inFlight: S.inFlight, hidden: S.hidden, step: S.step, loop: S.loop, built: !!S.nodes, timer: !!S.timer });
