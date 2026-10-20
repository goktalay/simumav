// Ses tasarımı: Web Audio SENTEZ (dosya/CDN yok). Arayüz efektleri: hover tık, seçim, geçiş süpürme, hata, kalkış, iniş;
// motor sesi (menü uçuş sahnesi; ayarlardan, varsayılan KAPALI). Ayarlar: configure({ sound, volume, engine }); kabuk ayarlarından okunur.
// AudioContext ilk kullanıcı etkileşiminde açılır (autoplay politikası); kapalıysa hiç kurulmaz. Saf kısımlar (SFX_DEFS, env) node ile test edilir.

export const SFX_DEFS = {
  hover: { type: 'sine', f0: 1900, f1: 1500, dur: 0.045, gain: 0.18 },
  select: { type: 'triangle', f0: 620, f1: 990, dur: 0.16, gain: 0.3 },
  back: { type: 'triangle', f0: 880, f1: 520, dur: 0.14, gain: 0.26 },
  error: { type: 'square', f0: 220, f1: 130, dur: 0.28, gain: 0.22 },
  sweep: { type: 'noise', f0: 500, f1: 3200, dur: 0.46, gain: 0.26 },
  takeoff: { type: 'noise', f0: 240, f1: 2400, dur: 0.5, gain: 0.3, tone: { f0: 180, f1: 520 } },
  land: { type: 'noise', f0: 900, f1: 180, dur: 0.42, gain: 0.34, tone: { f0: 140, f1: 70 } },
  tick: { type: 'sine', f0: 1200, f1: 1200, dur: 0.03, gain: 0.12 },
  alarm: { type: 'square', f0: 980, f1: 760, dur: 0.2, gain: 0.18 },      // §10 yakıt/batarya bitti: üç darbe (alarm())
  caution: { type: 'triangle', f0: 740, f1: 740, dur: 0.16, gain: 0.2 },  // §10 düşük yakıt/batarya: tek darbe
};
/** Saf zarf: t∈[0,dur] → kazanç (hızlı atak, üstel sönüm). */
export const env = (t, dur, g = 1) => (t < 0 || t > dur ? 0 : g * Math.min(1, t / (dur * 0.08)) * Math.exp(-4.5 * t / dur));
/** Üstel frekans süpürmesi (saf). */
export const sweepFreq = (t, dur, f0, f1) => f0 * Math.pow(f1 / f0, Math.min(1, Math.max(0, t / dur)));

const cfg = { sound: true, volume: 0.8, engine: false };
export function configure(o = {}) { if (o.sound != null) cfg.sound = !!o.sound; if (o.volume != null) cfg.volume = Math.max(0, Math.min(1, Number(o.volume))); if (o.engine != null) cfg.engine = !!o.engine; master && (master.gain.value = cfg.volume); if (!cfg.sound || !cfg.engine) for (const e of engines) e.mute(); }
export const config = () => ({ ...cfg });

let ctx = null, master = null, noiseBuf = null, unlocked = false;
const AC = () => globalThis.AudioContext || globalThis.webkitAudioContext;
function ensure() {
  if (!cfg.sound || !AC()) return null;
  if (!ctx) {
    try { ctx = new (AC())(); } catch { return null; }
    master = ctx.createGain(); master.gain.value = cfg.volume; master.connect(ctx.destination);
    const n = ctx.sampleRate * 1.5; noiseBuf = ctx.createBuffer(1, n, ctx.sampleRate); const d = noiseBuf.getChannelData(0); for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
  }
  if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  return ctx.state === 'running' || unlocked ? ctx : null;
}
// Kullanıcı etkileşiminde kilidi aç (sessizce)
if (typeof window !== 'undefined') {
  const unlock = () => { unlocked = true; if (cfg.sound) { const c = ensure(); c?.resume?.().catch(() => {}); } };
  for (const ev of ['pointerdown', 'keydown', 'touchstart']) window.addEventListener(ev, unlock, { passive: true, capture: true });
}

function play(name, { detune = 0 } = {}) {
  const def = SFX_DEFS[name]; if (!def) return;
  const c = ensure(); if (!c) return;
  const t0 = c.currentTime, g = c.createGain(); g.connect(master);
  g.gain.setValueAtTime(0.0001, t0); g.gain.exponentialRampToValueAtTime(def.gain, t0 + def.dur * 0.08); g.gain.exponentialRampToValueAtTime(0.0001, t0 + def.dur);
  if (def.type === 'noise') {
    const src = c.createBufferSource(); src.buffer = noiseBuf; src.loop = true;
    const bp = c.createBiquadFilter(); bp.type = 'bandpass'; bp.Q.value = 1.1;
    bp.frequency.setValueAtTime(def.f0, t0); bp.frequency.exponentialRampToValueAtTime(def.f1, t0 + def.dur);
    src.connect(bp); bp.connect(g); src.start(t0); src.stop(t0 + def.dur + 0.02);
  } else {
    const o = c.createOscillator(); o.type = def.type; o.detune.value = detune;
    o.frequency.setValueAtTime(def.f0, t0); o.frequency.exponentialRampToValueAtTime(Math.max(20, def.f1), t0 + def.dur);
    o.connect(g); o.start(t0); o.stop(t0 + def.dur + 0.02);
  }
  if (def.tone) {
    const o = c.createOscillator(), g2 = c.createGain(); o.type = 'sine'; g2.connect(master);
    g2.gain.setValueAtTime(0.0001, t0); g2.gain.exponentialRampToValueAtTime(def.gain * 0.7, t0 + def.dur * 0.15); g2.gain.exponentialRampToValueAtTime(0.0001, t0 + def.dur);
    o.frequency.setValueAtTime(def.tone.f0, t0); o.frequency.exponentialRampToValueAtTime(def.tone.f1, t0 + def.dur);
    o.connect(g2); o.start(t0); o.stop(t0 + def.dur + 0.02);
  }
}
let lastHover = 0;
export const hover = () => { const n = performance.now(); if (n - lastHover < 45) return; lastHover = n; play('hover', { detune: (Math.random() - 0.5) * 120 }); };
export const select = () => play('select');
export const back = () => play('back');
export const error = () => play('error');
export const sweep = () => play('sweep');
export const takeoff = () => play('takeoff');
export const land = () => play('land');
export const tick = () => play('tick');
export const alarm = () => { play('alarm'); setTimeout(() => play('alarm'), 240); setTimeout(() => play('alarm'), 480); };
export const caution = () => play('caution');

// ---------- Motor sesi (döngü): testere + alt harmonik, alçak geçiren, hafif LFO titreşimi ----------
const engines = new Set();
export function engine() {
  let nodes = null, target = 0;
  const build = () => {
    const c = ensure(); if (!c) return null;
    const g = c.createGain(); g.gain.value = 0; g.connect(master);
    const lp = c.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 520; lp.Q.value = 0.8; lp.connect(g);
    const o1 = c.createOscillator(); o1.type = 'sawtooth'; o1.frequency.value = 92; o1.connect(lp);
    const o2 = c.createOscillator(); o2.type = 'square'; o2.frequency.value = 46; const g2 = c.createGain(); g2.gain.value = 0.35; o2.connect(g2); g2.connect(lp);
    const lfo = c.createOscillator(); lfo.frequency.value = 7; const lg = c.createGain(); lg.gain.value = 3.5; lfo.connect(lg); lg.connect(o1.frequency);
    o1.start(); o2.start(); lfo.start();
    return { c, g, lp, o1, o2 };
  };
  const me = {
    update(dt, { rpm = 0.7, gain = 1 } = {}) {
      if (!cfg.sound || !cfg.engine) { if (nodes) me.mute(); return; }
      if (!nodes) { nodes = build(); if (!nodes) return; }
      target = 0.16 * gain;
      const k = Math.min(1, dt * 4);
      nodes.g.gain.value += (target - nodes.g.gain.value) * k;
      nodes.o1.frequency.value += (70 + rpm * 60 - nodes.o1.frequency.value) * k;
      nodes.o2.frequency.value = nodes.o1.frequency.value / 2;
      nodes.lp.frequency.value += (380 + rpm * 420 - nodes.lp.frequency.value) * k;
    },
    mute() { if (nodes) nodes.g.gain.value = 0; },
    stop() { if (nodes) { try { nodes.o1.stop(); nodes.o2.stop(); nodes.g.disconnect(); } catch { /* */ } nodes = null; } engines.delete(me); },
  };
  engines.add(me);
  return me;
}
