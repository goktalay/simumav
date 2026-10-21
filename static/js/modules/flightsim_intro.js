// Uçuş Simülatörü §27.2 — GİRİŞ SEKANSI (HEPGO + SIMUMAV, tüm başlatmalar): 3B dünya hazır olunca kamera 100 m yüksekten dronu / kalkış noktasını
// görür ve sinematik bir inişle (spiral, yumuşak hızlanma/yavaşlama) aşağı süzülür; bu sırada ekranın ortasında büyük 3‑2‑1 geri sayımı ve
// "dıt dıt dıt" bipleri (Web Audio; son adımda farklı, uzun "diiit"), ardından kamera son seçilen kipe (takip / FPV / gimbal / serbest / yer)
// yumuşak geçişle döner. Ses tercihine uyulur (HEPGO fs.audio.on/vol, SIMUMAV ayarlar sfx.config().sound/volume): kapalıysa bip yok.
// 3B tarafı flightsim3d.js `playIntro()`: kamera kipini DEĞİŞTİRMEZ; her karede normal kip hesaplandıktan sonra pozu introPose ile ezer, render
// sonrası geri yükler (takip kamerasının yörünge ofseti bozulmaz), geçişte konum lerp + yönelim slerp.
// Teşhis: window.__fsIntroHold = t (sn) → overlay ve 3B kamera o anda sabit kalır (görsel betikler); silinince gerçek zamana döner.
// Saf kısım (tests/test_flightsim_flyui.mjs): INTRO, introEase, introPose, countdownState, beepPlan. DOM: createIntro (kendi CSS'i).

export const INTRO = { height: 100, radius0: 80, turnDeg: 110, count: 3, goS: 0.7, blendS: 1.4 };
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const num = (v, d) => (v == null || !Number.isFinite(Number(v)) ? d : Number(v));
const r3 = v => Math.round(v * 1000) / 1000;

/** Yumuşak giriş-çıkış (quintic smootherstep): 0→0, 1→1, uçlarda türev 0. */
export const introEase = u => { const x = clamp(num(u, 0), 0, 1); return x * x * x * (x * (x * 6 - 15) + 10); };

/**
 * Kamera ofseti (hedefe göre, ENU m) — u ∈ [0, 1] sekans ilerlemesi. Başlangıç: hedefin h0 m üstünde, yatayda r0 m uzakta; bitiş: end (normal
 * kipin kamera ofseti; takipte yörünge ofseti). Yatay açı bitişin açısından turnDeg kadar geriden başlar (spiral), yükseklik ve yarıçap
 * yumuşak eğriyle iner. Dönüş {x, y, z}.
 */
export function introPose(u, { h0 = INTRO.height, r0 = INTRO.radius0, turnDeg = INTRO.turnDeg, end = { x: -8, y: -11, z: 4 } } = {}) {
  const e = introEase(u);
  const ex = num(end?.x, -8), ey = num(end?.y, -11), ez = num(end?.z, 4);
  const aEnd = Math.atan2(ey, ex), rEnd = Math.hypot(ex, ey);
  const a = aEnd - (turnDeg * Math.PI / 180) * (1 - e);
  const r = r0 + (rEnd - r0) * e;
  // yükseklik yarıçaptan biraz önde iner (erken "dalış" hissi): e^0.8
  const z = h0 + (ez - h0) * Math.pow(e, 0.8);
  return { x: r3(Math.cos(a) * r), y: r3(Math.sin(a) * r), z: r3(z) };
}

/**
 * Geri sayım durumu (t sn, sayı n): 0…n sn arası büyük sayı (n, n−1, …, 1), n…n+goS arası "go" adımı, sonra done.
 * Dönüş { n (gösterilen sayı; 0 = go), step (0 tabanlı adım; go = n), frac (adım içi 0…1), go, done }.
 */
export function countdownState(t, n = INTRO.count, goS = INTRO.goS) {
  const tt = Math.max(0, num(t, 0)), N = Math.max(1, Math.round(n));
  if (tt >= N + goS) return { n: 0, step: N, frac: 1, go: true, done: true };
  if (tt >= N) return { n: 0, step: N, frac: r3((tt - N) / goS), go: true, done: false };
  const step = Math.floor(tt);
  return { n: N - step, step, frac: r3(tt - step), go: false, done: false };
}

/** Bip planı: her sayıda kısa "dıt" (880 Hz, 0,11 sn), sonda uzun ve yüksek "diiit" (1320 Hz, 0,55 sn). {t (sn), f (Hz), dur (sn), gain}. */
export function beepPlan(n = INTRO.count) {
  const N = Math.max(1, Math.round(n)), out = [];
  for (let i = 0; i < N; i++) out.push({ t: i, f: 880, dur: 0.11, gain: 0.5 });
  out.push({ t: N, f: 1320, dur: 0.55, gain: 0.55 });
  return out;
}

// ---------------------------------------------------------------- metinler ----------------------------------------------------------------
export const INTRO_TEXTS = [
  ['intro.ready', 'Hazır ol'], ['intro.go', 'BAŞLA'], ['intro.skip', 'Atla (Boşluk / tıkla)'], ['intro.sub', 'Kalkış noktası'],
];
const TXT = Object.fromEntries(INTRO_TEXTS);
const fill = (s, p) => (p ? String(s).replace(/\{(\w+)\}/g, (m, k) => (p[k] != null ? String(p[k]) : m)) : String(s));
export const makeIntroT = (tr, keyed = false) => (k, p) => {
  const tx = TXT[k] ?? k;
  if (!tr) return fill(tx, p);
  if (!keyed) return tr(tx, p);
  const r = tr(k, p);
  return r && r !== k ? r : fill(tx, p);
};

// ---------------------------------------------------------------- DOM + ses ----------------------------------------------------------------
const CSS = `
.fs-cd{position:absolute;inset:0;z-index:30;display:grid;place-items:start center;align-content:start;padding-top:max(118px,15vh);pointer-events:auto;cursor:pointer;background:radial-gradient(ellipse at center,rgba(0,0,0,0) 35%,rgba(0,0,0,.35) 100%);opacity:1;transition:opacity .45s ease}
.fs-cd.out{opacity:0;pointer-events:none}
.fs-cd[hidden]{display:none}
.fs-cd-in{position:relative;display:grid;place-items:center;width:min(34vmin,230px);aspect-ratio:1;border-radius:50%;background:radial-gradient(circle,rgba(4,10,20,.42) 0,rgba(4,10,20,.26) 62%,rgba(4,10,20,0) 72%)}
.fs-cd-ring{position:absolute;inset:0;width:100%;height:100%;transform:rotate(-90deg)}
.fs-cd-ring circle{fill:none;stroke-width:3.5}
.fs-cd-ring .bg{stroke:rgba(255,255,255,.18)}
.fs-cd-ring .fg{stroke:#38e8ff;stroke-linecap:round}
.fs-cd-ring .gl{stroke:rgba(56,232,255,.25);stroke-width:9;stroke-linecap:round}
.fs-cd b{position:relative;font:900 min(21vmin,140px)/1 system-ui,-apple-system,"Segoe UI",sans-serif;color:#fff;letter-spacing:-.04em;text-shadow:0 4px 0 rgba(0,0,0,.35),0 0 40px rgba(56,232,255,.55),0 0 2px rgba(0,0,0,.8);font-variant-numeric:tabular-nums}
.fs-cd b.pop{animation:fs-cd-pop .9s cubic-bezier(.2,.9,.25,1) both}
.fs-cd b.go{font-size:min(11vmin,72px);letter-spacing:.06em;color:#7cffb2;text-shadow:0 4px 0 rgba(0,0,0,.35),0 0 46px rgba(34,197,94,.75)}
.fs-cd-sub{margin-top:14px;text-align:center;white-space:nowrap;font:700 13px/1.3 ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.22em;color:rgba(255,255,255,.9);text-transform:uppercase;text-shadow:0 1px 3px rgba(0,0,0,.8)}
.fs-cd-skip{justify-self:center;margin-top:10px;font:600 11.5px/1 system-ui,sans-serif;color:rgba(255,255,255,.8);background:rgba(0,0,0,.38);padding:6px 11px;border-radius:999px}
@keyframes fs-cd-pop{0%{transform:scale(1.9);opacity:0}24%{transform:scale(.94);opacity:1}42%{transform:scale(1.03)}60%,100%{transform:scale(1);opacity:1}}
.fs-stage.fs-intro-on .fs-osd,.fs-stage.fs-intro-on .fs-mhud,.fs-stage.fs-intro-on .fs-pip{opacity:0;transition:opacity .3s}
@media (prefers-reduced-motion:reduce){.fs-cd b.pop{animation:none}}
`;
function ensureCss() {
  if (typeof document === 'undefined' || document.getElementById('fs-intro-css')) return;
  const st = document.createElement('style'); st.id = 'fs-intro-css'; st.textContent = CSS; document.head.append(st);
}
/** HEPGO ses tercihi (flightsim_audio.js createAudioPrefs ile aynı anahtarlar): {on, vol 0…1}. */
export function hepgoSound(storage = null) {
  const st = storage || (typeof localStorage !== 'undefined' ? localStorage : null);
  try { const on = st?.getItem('fs.audio.on'), vol = Number(st?.getItem('fs.audio.vol')); return { on: on == null ? true : on !== '0' && on !== 'false', vol: Number.isFinite(vol) && st?.getItem('fs.audio.vol') != null ? clamp(vol / 100, 0, 1) : 0.7 }; } catch { return { on: true, vol: 0.7 }; }
}
function playBeeps(plan, vol) {
  const AC = globalThis.AudioContext || globalThis.webkitAudioContext;
  if (!AC || !(vol > 0)) return null;
  let ctx;
  try { ctx = new AC(); } catch { return null; }
  ctx.resume?.().catch(() => {});
  const t0 = ctx.currentTime + 0.05;
  const master = ctx.createGain(); master.gain.value = vol; master.connect(ctx.destination);
  for (const b of plan) {
    const o = ctx.createOscillator(), g = ctx.createGain(), o2 = ctx.createOscillator();
    o.type = 'square'; o.frequency.value = b.f; o2.type = 'sine'; o2.frequency.value = b.f * 2;
    const a = t0 + b.t, e = a + b.dur;
    g.gain.setValueAtTime(0.0001, a); g.gain.exponentialRampToValueAtTime(b.gain * 0.35, a + 0.008);
    g.gain.setValueAtTime(b.gain * 0.35, Math.max(a + 0.01, e - 0.04)); g.gain.exponentialRampToValueAtTime(0.0001, e);
    const g2 = ctx.createGain(); g2.gain.value = 0.25;
    o.connect(g); o2.connect(g2); g2.connect(g); g.connect(master);
    o.start(a); o2.start(a); o.stop(e + 0.02); o2.stop(e + 0.02);
  }
  const end = (plan.at(-1)?.t || 0) + (plan.at(-1)?.dur || 0) + 0.3;
  const timer = setTimeout(() => ctx.close?.().catch(() => {}), end * 1000 + 200);
  return { stop() { clearTimeout(timer); try { ctx.close?.(); } catch { /* */ } } };
}

/**
 * Giriş sekansı. stage: .fs-stage; opts { getSim, tr, keyed, sound: () => ({on, vol}), count, onDone() }.
 * start(): kamera + geri sayım + ses (bir kez); skip(): hemen bitir (kamera geçişi kısa); dispose(). Dönüş { start, skip, dispose, get active }.
 */
export function createIntro(stage, { getSim = () => null, tr = null, keyed = false, sound = () => hepgoSound(), count = INTRO.count, onDone = () => {}, sub = null } = {}) {
  ensureCss();
  const T = makeIntroT(tr, keyed);
  const C = 2 * Math.PI * 46;
  const num_ = document.createElement('b');
  const box = document.createElement('div'); box.className = 'fs-cd'; box.hidden = true; box.setAttribute('role', 'timer'); box.setAttribute('aria-live', 'assertive');
  box.innerHTML = `<div class="fs-cd-in"><svg class="fs-cd-ring" viewBox="0 0 100 100" aria-hidden="true"><circle class="bg" cx="50" cy="50" r="46"/><circle class="gl" cx="50" cy="50" r="46" stroke-dasharray="${C.toFixed(2)}" stroke-dashoffset="${C.toFixed(2)}"/><circle class="fg" cx="50" cy="50" r="46" stroke-dasharray="${C.toFixed(2)}" stroke-dashoffset="${C.toFixed(2)}"/></svg></div><div class="fs-cd-sub"></div><div class="fs-cd-skip"></div>`;
  box.firstChild.append(num_);
  const fg = box.querySelector('.fg'), gl = box.querySelector('.gl'), subEl = box.querySelector('.fs-cd-sub');
  box.querySelector('.fs-cd-skip').textContent = T('intro.skip');
  stage.append(box);
  let raf = 0, t0 = 0, active = false, done = false, lastStep = -1, beeps = null, disposed = false;
  const finish = (skipped = false) => {
    if (done) return;
    done = true; active = false;
    if (raf) cancelAnimationFrame(raf); raf = 0;
    if (skipped) { beeps?.stop(); getSim()?.endIntro?.(0.6); }
    box.classList.add('out'); stage.classList.remove('fs-intro-on');
    setTimeout(() => { box.hidden = true; }, 480);
    window.removeEventListener('keydown', onKey, true);
    onDone(skipped);
  };
  const onKey = e => { if (e.key === ' ' || e.key === 'Escape' || e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); finish(true); } };
  box.addEventListener('click', () => finish(true));
  const frame = now => {
    raf = 0;
    if (disposed || done) return;
    const hold = globalThis.__fsIntroHold;   // teşhis (görsel betikler): sabit sekans zamanı (sn) — yavaş yazılım WebGL'de kare almak için
    const t = hold != null ? Number(hold) : (now - t0) / 1000, st = countdownState(t, count);
    if (st.step !== lastStep) {
      lastStep = st.step;
      num_.textContent = st.go ? T('intro.go') : String(st.n);
      num_.classList.toggle('go', st.go);
      num_.classList.remove('pop'); void num_.offsetWidth; num_.classList.add('pop');
    }
    const prog = Math.min(1, t / count);
    fg.setAttribute('stroke-dashoffset', (C * (1 - prog)).toFixed(2)); gl.setAttribute('stroke-dashoffset', (C * (1 - prog)).toFixed(2));
    if (st.done) { finish(false); return; }
    raf = requestAnimationFrame(frame);
  };
  return {
    start() {
      if (active || done || disposed) return false;
      active = true; lastStep = -1;
      subEl.textContent = sub || T('intro.sub');
      box.hidden = false; box.classList.remove('out'); stage.classList.add('fs-intro-on');
      const total = count + INTRO.goS;
      getSim()?.playIntro?.({ dur: total, blend: INTRO.blendS, height: INTRO.height, radius: INTRO.radius0, turnDeg: INTRO.turnDeg });
      const s = sound() || {};
      if (s.on !== false) beeps = playBeeps(beepPlan(count), clamp(num(s.vol, 0.7), 0, 1));
      window.addEventListener('keydown', onKey, true);
      t0 = performance.now(); raf = requestAnimationFrame(frame);
      return true;
    },
    skip: () => finish(true),
    get active() { return active; }, get done() { return done; },
    dispose() { disposed = true; if (raf) cancelAnimationFrame(raf); beeps?.stop(); window.removeEventListener('keydown', onKey, true); stage.classList.remove('fs-intro-on'); box.remove(); },
  };
}
