// Uçuş Simülatörü §44 — KARŞILAŞMA OYUN EFEKTLERİ (HEPGO + SIMUMAV ortak). Web Audio ile TAMAMEN SENTEZLENMİŞ kısa sesler; dosya yok (lisans gerekmez).
// • Katman 1 (saf; tests/test_flightsim_sfx.mjs): olay → nota planı (`sfxPlan`), halka sırasına göre yükselen perde (`ringFreq`), sıralama değişimi
//   (`rankChange`), puan sayacı adımları (`countSteps`), tercih (`createSfxPrefs`: HEPGO localStorage `fs.sfx`, SIMUMAV `sm.sfx` → {on, vol 0–100}),
//   etkin kazanç (`sfxGain`: genel ses düzeyi × efekt düzeyi; uçuş uyarısı (§42) çalarken efektler kısılır, önemsizleri hiç çalmaz).
// • Katman 2 (`createSfx({ audio, prefs, isAlert })`): motor sesinin (flightsim_audio) master kazancına bağlı ayrı efekt yolu → ses kapsülü
//   (🔊/🔇, M tuşu, ses düzeyi), sekme gizli / hızlı oynatma susturmaları ve ekran kaydı efektleri de kapsar. `audio` yoksa (salon sayfası) kendi
//   AudioContext'i (HEPGO genel ses tercihi `hepgoSound` ile). Simülasyon odak kipi (simfocus) yalnız SİSTEM seslerini bastırır; oyun efektleri sahnenin
//   parçasıdır. `settingsRow(T)` ses kapsülü menüsüne "Oyun efektleri [Açık|Kapalı] + düzey" satırı.
// Olaylar: ring (yükselen "ding"), finish (son halka / bitiş fanfarı), overtake (öne geçme: whoosh + ding), overtaken (geride kalma: alçak ton),
//   count / go (3‑2‑1‑BAŞLA; giriş sekansı kendi biplerini çalıyorsa çağrılmaz), lock (angajman halkası dolarken yükselen ton; ilerleme 0…1),
//   win (KİLİT tamam / kazandınız jingle), lose (kaybettiniz: alçalan ton), coin (puan/bonus), tick (sonuç sayacı tıklaması), wrong (ters yön).
// §47 FPV parkuru: lap (tur sonu; en iyi turda üçlü), sector_best (sektör rekoru: parlak arpej), pb (KİŞİSEL REKOR fanfarı), miss (kaçırılan kapı:
//   kısa alçak vızıltı), hit (çarpma: kısa gürültü darbesi), ghost_ahead / ghost_behind (hayaletin önüne geçme / gerisine düşme: kısa iki nota).
//   Kapı geçişi mevcut `ring`, bitiş `finish`.

// Metinler: HEPGO Türkçe anahtar (tr), SIMUMAV `sfx.*` anahtarı (keyed)
export const SFX_TEXTS = [['sfx.title', 'Oyun efektleri'], ['sfx.off', 'Efekt kapalı'], ['sfx.on', 'Efekt açık'], ['sfx.vol', 'Efekt düzeyi']];
const STXT = Object.fromEntries(SFX_TEXTS);
export const makeSfxT = (tr, keyed = false) => (k) => {
  const tx = STXT[k] ?? k;
  if (!tr) return tx;
  if (!keyed) return tr(tx);
  const r = tr(k);
  return r && r !== k ? r : tx;
};
export const SFX_EVENTS = ['ring', 'finish', 'overtake', 'overtaken', 'count', 'go', 'lock', 'win', 'lose', 'coin', 'tick', 'wrong', 'lap', 'sector_best', 'pb', 'miss', 'hit', 'ghost_ahead', 'ghost_behind'];
export const SFX_MINOR = new Set(['lock', 'tick', 'overtake', 'overtaken', 'count', 'ghost_ahead', 'ghost_behind']);   // uyarı çalarken hiç çalmayanlar
export const ALERT_DUCK = 0.3;                                                          // uyarı çalarken diğer efektlerin çarpanı
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const N = (n) => 440 * 2 ** ((n - 69) / 12);   // MIDI nota → Hz

/** i. halka (1…n) için "ding" perdesi: C5'ten başlayıp sıra arttıkça tam ton yükselir (en çok 2 oktav). */
export function ringFreq(i, n = 8) {
  const k = clamp(Math.round(Number(i) || 1) - 1, 0, 30);
  const span = Math.max(1, Math.round(Number(n) || 8) - 1);
  return N(72 + Math.min(24, Math.round(k * Math.min(2, 24 / span))));
}

/** Olay → nota planı [{t (sn), d (sn), f (Hz), f2? (bitiş Hz, kayma), type, g (0–1), noise?}]. */
export function sfxPlan(ev, p = {}) {
  switch (ev) {
    case 'ring': {
      const f = ringFreq(p.i, p.n);
      return [{ t: 0, d: 0.16, f, type: 'triangle', g: 0.55 }, { t: 0.07, d: 0.32, f: f * 1.5, type: 'sine', g: 0.45 }];
    }
    case 'finish':   // fanfar: C5 E5 G5 C6 (son nota uzun) + oktav desteği
      return [[72, 0, 0.13], [76, 0.13, 0.13], [79, 0.26, 0.13], [84, 0.39, 0.6]].flatMap(([n, t, d]) => [{ t, d, f: N(n), type: 'square', g: 0.28 }, { t, d, f: N(n - 12), type: 'triangle', g: 0.35 }]);
    case 'overtake':
      return [{ t: 0, d: 0.28, f: 300, f2: 2400, type: 'noise', g: 0.35, noise: true }, { t: 0.2, d: 0.3, f: N(84), type: 'sine', g: 0.5 }, { t: 0.2, d: 0.3, f: N(91), type: 'triangle', g: 0.25 }];
    case 'overtaken':
      return [{ t: 0, d: 0.22, f: N(55), f2: N(52), type: 'sawtooth', g: 0.22 }, { t: 0.2, d: 0.35, f: N(52), f2: N(48), type: 'triangle', g: 0.4 }];
    case 'count':
      return [{ t: 0, d: 0.11, f: 880, type: 'square', g: 0.35 }];
    case 'go':
      return [{ t: 0, d: 0.5, f: 1320, type: 'square', g: 0.38 }, { t: 0, d: 0.5, f: 660, type: 'triangle', g: 0.3 }];
    case 'lock': {   // ilerleme 0…1 → 440 → 1320 Hz; dolarken aralık kısalır (çağıran hızlandırır)
      const q = clamp(Number(p.p) || 0, 0, 1);
      return [{ t: 0, d: 0.07, f: 440 + 880 * q, type: 'square', g: 0.22 + 0.15 * q }];
    }
    case 'win':   // zafer jingle: G4 C5 E5 G5 · E5 G5–C6
      return [[67, 0, 0.11], [72, 0.11, 0.11], [76, 0.22, 0.11], [79, 0.33, 0.2], [76, 0.55, 0.11], [79, 0.66, 0.11], [84, 0.77, 0.7]]
        .flatMap(([n, t, d]) => [{ t, d, f: N(n), type: 'square', g: 0.25 }, { t, d, f: N(n + 12), type: 'sine', g: 0.18 }]);
    case 'lose':
      return [[67, 0, 0.25], [64, 0.25, 0.25], [60, 0.5, 0.25], [55, 0.75, 0.8]].map(([n, t, d]) => ({ t, d, f: N(n), f2: N(n) * 0.97, type: 'triangle', g: 0.45 }));
    case 'coin':
      return [{ t: 0, d: 0.08, f: N(83), type: 'square', g: 0.3 }, { t: 0.08, d: 0.32, f: N(88), type: 'square', g: 0.3 }];
    case 'tick':
      return [{ t: 0, d: 0.025, f: 1900, type: 'square', g: 0.16 }];
    case 'wrong':
      return [{ t: 0, d: 0.28, f: 330, f2: 260, type: 'sawtooth', g: 0.3 }];
    // §47 FPV parkuru
    case 'lap':   // tur sonu: iki nota (en iyi turda üçüncü yüksek nota)
      return [[79, 0, 0.12], [84, 0.12, 0.22], ...(p.best ? [[88, 0.3, 0.3]] : [])].map(([n, t, d]) => ({ t, d, f: N(n), type: 'triangle', g: 0.42 }));
    case 'sector_best':   // sektör rekoru: hızlı parlak arpej (mor)
      return [[84, 0, 0.07], [88, 0.06, 0.07], [91, 0.12, 0.07], [96, 0.18, 0.22]].map(([n, t, d]) => ({ t, d, f: N(n), type: 'sine', g: 0.38 }));
    case 'pb':   // KİŞİSEL REKOR fanfarı: C5 G5 C6 · E6–G6 + bas desteği
      return [[72, 0, 0.12], [79, 0.12, 0.12], [84, 0.24, 0.16], [88, 0.42, 0.14], [91, 0.56, 0.75]]
        .flatMap(([n, t, d]) => [{ t, d, f: N(n), type: 'square', g: 0.26 }, { t, d, f: N(n - 12), type: 'triangle', g: 0.32 }, { t, d, f: N(n + 12), type: 'sine', g: 0.12 }]);
    case 'miss':   // kaçırılan kapı: kısa alçak vızıltı
      return [{ t: 0, d: 0.16, f: 196, f2: 174, type: 'square', g: 0.26 }, { t: 0.17, d: 0.16, f: 174, f2: 147, type: 'square', g: 0.24 }];
    case 'hit':   // çarpma: kısa gürültü darbesi + alçak gümleme
      return [{ t: 0, d: 0.18, f: 900, f2: 200, type: 'noise', g: 0.5, noise: true }, { t: 0, d: 0.22, f: 110, f2: 60, type: 'sine', g: 0.55 }];
    case 'ghost_ahead':
      return [{ t: 0, d: 0.08, f: N(86), type: 'sine', g: 0.3 }, { t: 0.08, d: 0.12, f: N(91), type: 'sine', g: 0.3 }];
    case 'ghost_behind':
      return [{ t: 0, d: 0.08, f: N(79), type: 'sine', g: 0.26 }, { t: 0.08, d: 0.12, f: N(74), type: 'sine', g: 0.26 }];
    default:
      return [];
  }
}
export const planLength = plan => plan.reduce((m, n) => Math.max(m, n.t + n.d), 0);

/** Sıralamadaki yerim değişti mi: 'overtake' (öne geçtim) | 'overtaken' (geride kaldım) | null. Sıra 1 tabanlı; bilinmeyen → null. */
export function rankChange(prev, next) {
  const a = Number(prev), b = Number(next);
  if (!Number.isFinite(a) || !Number.isFinite(b) || a < 1 || b < 1 || a === b) return null;
  return b < a ? 'overtake' : 'overtaken';
}

/** Sonuç ekranı puan sayacı: 0 → hedef arasında en çok `max` adım (her adımda tick); [{v, t (sn)}]. */
export function countSteps(target, { max = 24, dur = 1.2 } = {}) {
  const T = Math.max(0, Math.round(Number(target) || 0));
  if (!T) return [{ v: 0, t: 0 }];
  const n = Math.min(max, T), out = [];
  for (let k = 1; k <= n; k++) out.push({ v: Math.round((T * k) / n), t: +(dur * (1 - (1 - k / n) ** 2)).toFixed(3) });
  return out;
}

/** Tercih: {on (varsayılan açık), vol 0–100 (varsayılan 80)}. */
export function createSfxPrefs(storage = null, key = 'fs.sfx') {
  const st = storage || (typeof localStorage !== 'undefined' ? localStorage : null);
  const subs = new Set();
  let v = { on: true, vol: 80 };
  try { const j = JSON.parse(st?.getItem(key) || 'null'); if (j && typeof j === 'object') v = { on: j.on !== false, vol: clamp(Math.round(Number(j.vol ?? 80)), 0, 100) }; } catch { /* bozuk */ }
  return {
    get: () => ({ ...v }),
    set(p) {
      v = { on: p.on != null ? !!p.on : v.on, vol: p.vol != null ? clamp(Math.round(Number(p.vol) || 0), 0, 100) : v.vol };
      try { st?.setItem(key, JSON.stringify(v)); } catch { /* özel kip */ }
      for (const f of subs) { try { f({ ...v }); } catch { /* */ } }
      return { ...v };
    },
    onChange: f => { subs.add(f); return () => subs.delete(f); },
  };
}

/** Efekt kazancı: kapalı/0 → 0; uyarı çalarken önemsiz efekt 0, diğerleri × ALERT_DUCK. (Genel ses düzeyi master kazancındadır.) */
export function sfxGain(pref, ev, alert = false) {
  if (!pref?.on) return 0;
  const g = clamp(Number(pref.vol ?? 80), 0, 100) / 100;
  if (!(g > 0)) return 0;
  if (alert) return SFX_MINOR.has(ev) ? 0 : g * ALERT_DUCK;
  return g;
}

// ---------------------------------------------------------------- Katman 2: tarayıcı
function noiseBuffer(ctx) {
  const b = ctx.createBuffer(1, Math.round(ctx.sampleRate * 0.4), ctx.sampleRate), d = b.getChannelData(0);
  let s = 7;
  for (let i = 0; i < d.length; i++) { s = (s * 16807) % 2147483647; d[i] = (s / 2147483647) * 2 - 1; }
  return b;
}
function schedule(ctx, out, plan, gain) {
  const t0 = ctx.currentTime + 0.02;
  let nb = null;
  for (const n of plan) {
    const a = t0 + n.t, e = a + n.d, g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, a);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, n.g * gain), a + Math.min(0.012, n.d / 3));
    g.gain.exponentialRampToValueAtTime(0.0001, e);
    g.connect(out);
    if (n.noise) {
      nb ??= noiseBuffer(ctx);
      const s = ctx.createBufferSource(), bp = ctx.createBiquadFilter();
      s.buffer = nb; bp.type = 'bandpass'; bp.Q.value = 1.4;
      bp.frequency.setValueAtTime(n.f, a); bp.frequency.exponentialRampToValueAtTime(n.f2 || n.f, e);
      s.connect(bp).connect(g); s.start(a); s.stop(e + 0.02);
    } else {
      const o = ctx.createOscillator();
      o.type = n.type || 'sine'; o.frequency.setValueAtTime(n.f, a);
      if (n.f2) o.frequency.exponentialRampToValueAtTime(n.f2, e);
      o.connect(g); o.start(a); o.stop(e + 0.02);
    }
  }
}

/**
 * createSfx({ audio?, prefs?, storage?, key?, isAlert?, fallbackVol?, menuHost?, T?, keyed? }) → { play(ev, p) → bool, prefs, settingsRow(T), last, dispose() }
 * audio: createEngineAudio nesnesi (master yolu); yoksa kendi bağlamı (fallbackVol() → 0…1 genel düzey, varsayılan HEPGO hepgoSound).
 */
export function createSfx(o = {}) {
  const prefs = o.prefs || createSfxPrefs(o.storage || null, o.key || 'fs.sfx');
  const isAlert = () => { try { return !!o.isAlert?.(); } catch { return false; } };
  let own = null, bus = null, disposed = false;
  const S = { last: null, count: 0, skipped: 0 };
  const sink = () => {
    const A = o.audio;
    if (A) {   // motor sesi master yolu: kapalı / etkileşim yok / gizli → null
      const ab = A.alertBus?.();
      if (!ab) return null;
      if (!bus || bus.ctx !== ab.ctx) { const g = ab.ctx.createGain(); g.gain.value = 1; g.connect(A.graph?.master || ab.bus); bus = { ctx: ab.ctx, node: g }; }
      return { ctx: bus.ctx, out: bus.node, base: 1 };
    }
    const base = clamp(Number(o.fallbackVol?.() ?? 0.7), 0, 1);
    if (!(base > 0) || (typeof document !== 'undefined' && document.hidden)) return null;
    const AC = globalThis.AudioContext || globalThis.webkitAudioContext;
    if (!AC) return null;
    try { own ??= new AC(); own.resume?.().catch(() => {}); } catch { return null; }
    return { ctx: own, out: own.destination, base };
  };
  function play(ev, p = {}) {
    if (disposed) return false;
    const g = sfxGain(prefs.get(), ev, isAlert());
    if (!(g > 0)) { S.skipped++; return false; }
    const k = sink();
    if (!k) { S.skipped++; return false; }
    try { schedule(k.ctx, k.out, sfxPlan(ev, p), g * k.base); } catch { return false; }
    S.last = { ev, at: Date.now(), gain: +(g * k.base).toFixed(3) }; S.count++;
    return true;
  }
  const rows = new Set();
  function settingsRow(tr = null, keyed = o.keyed) {
    const T = makeSfxT(tr, keyed);
    const d = typeof document !== 'undefined' ? document : null;
    if (!d) return null;
    const r = d.createElement('div'); r.className = 'fs-gpws-row fs-sfx-row';
    const b = d.createElement('b'); b.textContent = T('sfx.title');
    const sg = d.createElement('span'); sg.className = 'fs-gpws-seg';
    const mk = (on, lbl) => { const x = d.createElement('button'); x.type = 'button'; x.textContent = T(lbl); x.onclick = e => { e.stopPropagation(); prefs.set({ on }); if (on) play('coin'); }; sg.append(x); return [on, x]; };
    const bs = [mk(false, 'sfx.off'), mk(true, 'sfx.on')];
    const sl = d.createElement('input'); sl.type = 'range'; sl.min = '0'; sl.max = '100'; sl.step = '5'; sl.setAttribute('aria-label', T('sfx.vol')); sl.title = T('sfx.vol'); sl.style.width = '90px';
    sl.oninput = () => prefs.set({ vol: sl.value }); sl.onchange = () => play('ring', { i: 3, n: 8 });
    r.append(b, sg, sl);
    r.__sync = () => { const v = prefs.get(); bs.forEach(([on, x]) => x.classList.toggle('on', v.on === on)); sl.value = String(v.vol); sl.disabled = !v.on; };
    r.__sync(); rows.add(r);
    return r;
  }
  const unsub = prefs.onChange(() => { for (const r of rows) r.__sync?.(); });
  if (o.menuHost) { const r = settingsRow(o.T, o.keyed); if (r) o.menuHost.append(r); }
  return {
    play, prefs, settingsRow,
    get last() { return S.last; }, state: () => ({ ...S, prefs: prefs.get() }),
    dispose() { disposed = true; unsub(); for (const r of rows) r.remove?.(); rows.clear(); try { bus?.node.disconnect(); } catch { /* */ } if (own && own.state !== 'closed') own.close?.().catch?.(() => {}); own = null; },
  };
}

/** Puan gösterimi (ör. §42 uçuş disiplini puanı, rapor kartı): `el` metni 0 → hedef tıklama sesleriyle artar, sonunda "coin" (hedef > 0).
 * `sfx` verilmezse genel ses tercihine bağlı yedek bağlam (HEPGO `fs.audio.*`, efekt tercihi `key`). Dönüş: iptal işlevi. */
let _yedek = null;
export function countUp(el, target, { sfx = null, key = 'fs.sfx', suffix = '', delay = 0.4, dur = 1.2 } = {}) {
  if (!el) return () => {};
  const fx = sfx || (_yedek ??= createSfx({ key, fallbackVol: () => {
    try { const on = localStorage.getItem('fs.audio.on'), v = localStorage.getItem('fs.audio.vol'); return on === '0' || on === 'false' ? 0 : v != null ? clamp(Number(v) / 100, 0, 1) : 0.7; } catch { return 0.7; }
  } }));
  const steps = countSteps(target, { dur });
  const ids = steps.map((st, k) => setTimeout(() => { el.textContent = `${st.v}${suffix}`; if (k === steps.length - 1) { if (st.v > 0) fx.play('coin'); } else fx.play('tick'); }, (delay + st.t) * 1000));
  el.textContent = `0${suffix}`;
  return () => ids.forEach(clearTimeout);
}

