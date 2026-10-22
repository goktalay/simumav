// SIMUMAV ses düzeyleri (cihaz tercihi; sunucuya gitmez): kanal başına {on, vol 0–100}. Mevcut anahtarlarla uyumlu:
//   • music  → sm.music  {on, vol}               (yeni; varsayılan açık, 55)
//   • sfx    → sm.sfx    {on, vol}               (HEPGO §44 oyun efektleri — flightsim_sfx createSfxPrefs ile AYNI biçim; arayüz tık/hover sesleri de buna bağlı)
//   • alert  → sm.gpws   {mode: off|visual|full} (HEPGO §42; sessiz = 'visual', açık = 'full') + sm.alertvol {vol} (uyarı tonu/konuşma düzeyi)
//   • engine → fs.audio.on '1'|'0', fs.audio.vol '0..100' (HEPGO uçuş motor/ana ses tercihi; flightsim_audio createAudioPrefs)
// Ana ses (settings.sound + settings.volume) sunucu ayarıdır; hepsinin üstünde çarpan olarak kalır (ui/sfx.js master).
// Saf kısımlar (readMix, writeMix, gainOf, musicDuck) node ile test edilir; storage enjekte edilebilir (getItem/setItem).

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const num = (v, d) => { const n = Number(v); return Number.isFinite(n) ? n : d; };
export const CHANNELS = ['music', 'sfx', 'alert', 'engine'];
export const DEFAULTS = { music: { on: true, vol: 55 }, sfx: { on: true, vol: 80 }, alert: { on: true, vol: 100 }, engine: { on: true, vol: 70 } };
const ls = () => { try { return globalThis.localStorage || null; } catch { return null; } };
const getJ = (st, k) => { try { const v = st?.getItem(k); return v == null ? null : JSON.parse(v); } catch { return null; } };
const setJ = (st, k, v) => { try { st?.setItem(k, JSON.stringify(v)); } catch { /* özel kip */ } };
const vol = (v, d) => clamp(Math.round(num(v, d)), 0, 100);

/** Tüm kanalları oku → { music:{on,vol}, sfx:{on,vol}, alert:{on,vol,mode}, engine:{on,vol} }. */
export function readMix(storage = ls()) {
  const st = storage;
  const mu = getJ(st, 'sm.music') || {}, fx = getJ(st, 'sm.sfx') || {}, gp = getJ(st, 'sm.gpws') || {}, av = getJ(st, 'sm.alertvol') || {};
  let eOn = null, eVol = null; try { eOn = st?.getItem('fs.audio.on'); eVol = st?.getItem('fs.audio.vol'); } catch { /* */ }
  const mode = ['off', 'visual', 'full'].includes(gp.mode) ? gp.mode : 'full';
  return {
    music: { on: mu.on !== false, vol: vol(mu.vol, DEFAULTS.music.vol) },
    sfx: { on: fx.on !== false, vol: vol(fx.vol, DEFAULTS.sfx.vol) },
    alert: { on: mode === 'full', mode, vol: vol(av.vol, DEFAULTS.alert.vol) },
    engine: { on: !(eOn === '0' || eOn === 'false'), vol: vol(eVol ?? DEFAULTS.engine.vol, DEFAULTS.engine.vol) },
  };
}

/** Bir kanalı yaz (yalnız verilen alanlar); diğer alanlar (ör. sm.gpws.off, lang) korunur. Dönüş: güncel karışım. */
export function writeMix(channel, patch = {}, storage = ls()) {
  const st = storage, cur = readMix(st)[channel];
  if (!cur) throw new Error(`kanal yok: ${channel}`);
  const on = patch.on != null ? !!patch.on : cur.on, v = patch.vol != null ? vol(patch.vol, cur.vol) : cur.vol;
  if (channel === 'music' || channel === 'sfx') setJ(st, `sm.${channel}`, { ...(getJ(st, `sm.${channel}`) || {}), on, vol: v });
  else if (channel === 'alert') {
    if (patch.on != null) { const gp = getJ(st, 'sm.gpws') || {}; setJ(st, 'sm.gpws', { ...gp, mode: on ? 'full' : (gp.mode === 'off' ? 'off' : 'visual') }); }
    if (patch.vol != null) setJ(st, 'sm.alertvol', { vol: v });
  } else if (channel === 'engine') {
    try { if (patch.on != null) st?.setItem('fs.audio.on', on ? '1' : '0'); if (patch.vol != null) st?.setItem('fs.audio.vol', String(v)); } catch { /* */ }
  }
  const mix = readMix(st);
  try { globalThis.dispatchEvent?.(new CustomEvent('sm:mix', { detail: { channel, mix } })); } catch { /* node */ }
  return mix;
}

/** Kanal kazancı 0..1 (algısal eğri: (vol/100)^1.5); kapalıysa 0. Ana ses çarpanı ayrı uygulanır. */
export const gainOf = ch => (!ch || !ch.on ? 0 : Math.pow(clamp(num(ch.vol, 0), 0, 100) / 100, 1.5));

/** Müzik bastırma (saf): ekran → hedef çarpan. Uçuş oturumu (3B sahne) → 0 (motor + uyarılar baskın); Uç sihirbazı → 0,7; sekme gizli → 0. */
export function musicDuck({ screen = 'menu', inFlight = false, hidden = false } = {}) {
  if (hidden || inFlight) return 0;
  if (screen === 'fly') return 0.7;
  return 1;
}

/** §42 uyarı yolu: createEngineAudio nesnesini saran vekil — alertBus kazancı ve konuşma düzeyi sm.alertvol ile ölçeklenir. */
export function withAlertGain(audio, storage = ls()) {
  if (!audio || typeof audio !== 'object') return audio;
  const k = () => gainOf({ on: true, vol: readMix(storage).alert.vol });
  const proxy = Object.create(audio);
  proxy.alertBus = () => { const r = audio.alertBus?.(); if (r?.bus?.gain) { try { r.bus.gain.value = k(); } catch { /* */ } } return r; };
  Object.defineProperty(proxy, 'prefs', { get: () => { const p = audio.prefs; return p ? { ...p, volume: (p.volume ?? 70) * k() } : p; } });
  return proxy;
}
