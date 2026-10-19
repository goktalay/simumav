// SIMUMAV › Uç — sanal kumanda ve ağ teşhisi (HEPGO static/js/modules/flightsim.js renderSession ile BİREBİR; HEPGO dosyasına dokunulmaz,
// kod kopyalanmıştır — docs/ucus-simulatoru.md §5 "Sanal kumanda", §5 "Akıcılık" netsim).
// • virtualRC: iki sanal çubuk (Mode 2: sol gaz/yaw, sağ pitch/roll; dokunmatik + fare, pointer events) + klavye → 20 Hz send(ch[8])
//   ({t:'rc', ch} → sunucu RC_CHANNELS_OVERRIDE); dispose() → 8×0 (override serbest). Tarayıcısız test (tests/test_simumav_fly.mjs) için
//   DOM/zamanlayıcı bağımlılıkları `env` ile verilebilir (varsayılan: window/document/performance/setInterval).
// • parseNetsim('jitter30,loss5,delay40') → {jitter, loss, delay} | null; netsimDeliver(netsim, fn, rnd, timer): gelen kareyi
//   delay + U(0, 2·jitter) ms gecikmeyle (sıra bozulabilir) iletir, %loss düşürür — titreme ölçümü (#/fly/<id>?netsim=…).
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
export const RC_KEYS = new Set(['w', 'a', 's', 'd', 'q', 'e', ' ', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright']);
export const RC_HZ = 20;
export const pwm = v => Math.round(clamp(1500 + v * 500, 1000, 2000));
// ArduPilot RC: ch1 roll, ch2 pitch (ileri = burun aşağı = düşük PWM), ch3 gaz, ch4 yaw, ch5 mod anahtarı; 6–8: 0 = o kanala dokunma
export const channelsOf = (ax, ch5) => [pwm(ax.roll), pwm(-ax.pitch), pwm(ax.thr), pwm(ax.yaw), ch5, 0, 0, 0];

// ======================================================================
// Sanal kumanda: iki sanal çubuk (Mode 2: sol gaz/yaw, sağ pitch/roll; dokunmatik + fare, pointer events) + klavye.
// ArduPilot RC: ch1 roll, ch2 pitch (ileri = burun aşağı = düşük PWM), ch3 gaz, ch4 yaw, ch5 mod anahtarı; 1000–2000, merkez 1500.
// Eksenler −1…1: tuş basılıyken KEY_RATE ile uca gider, bırakılınca yaylı (üstel) merkeze döner. Kopterde gaz çubuğu merkeze yaylıdır
// (1500 ≈ askı); uçakta gaz tutmalıdır (W/S kaydırır, çubuk bırakıldığı yerde kalır). Boşluk = gaz 1500. Q/E = ch5 1000/1500/2000.
// 20 Hz: tick (klavye entegrasyonu + çizim) → send(channels()). dispose(): zamanlayıcı/dinleyiciler kalkar, 8×0 (override serbest) gönderilir.
// ======================================================================
export function virtualRC({ plane, stickL, stickR, send, onChange, throttle0 = null, env = null }) {
  const win = env?.window || globalThis.window, doc = env?.document || globalThis.document;
  const nowMs = env?.now || (() => performance.now());
  const setIv = env?.setInterval || ((fn, ms) => setInterval(fn, ms)), clearIv = env?.clearInterval || (id => clearInterval(id));
  // thr: −1 = 1000 (uçak boşta), 0 = 1500 (kopter askı). Uçakta kumanda uçuş sırasında açılırsa (throttle0: telemetri gazı %) çubuk o gazda başlar:
  // ArduPlane TAKEOFF/AUTO'da gazı RC'den bağımsız verir; çubuk altta (1000) iken HUD %100 "ters" görünmesin, FBWA'ya geçişte gaz aniden kesilmesin.
  const thr0 = plane && throttle0 != null && Number.isFinite(Number(throttle0)) ? clamp(Number(throttle0) / 50 - 1, -1, 1) : null;
  const ax = { roll: 0, pitch: 0, thr: plane ? (thr0 ?? -1) : 0, yaw: 0 };
  let ch5 = 1500, lastT = nowMs(), disposed = false;
  const keys = new Set();
  const drag = { l: null, r: null };          // sürüklenen çubuk: {id, x0, y0, r}
  const KEY_RATE = 3.5, SPRING = 9, THR_RATE = 0.7;
  const editable = el => el && (/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || el.isContentEditable);
  const channels = () => channelsOf(ax, ch5);

  // --- klavye ---
  const onKeyDown = e => {
    if (disposed || editable(doc?.activeElement) || e.ctrlKey || e.metaKey || e.altKey) return;
    const k = e.key.toLowerCase();
    if (!RC_KEYS.has(k)) return;
    e.preventDefault?.();
    if (e.repeat) return;
    if (k === ' ') { ax.thr = 0; return; }
    if (k === 'q' || k === 'e') { ch5 = clamp(ch5 + (k === 'e' ? 500 : -500), 1000, 2000); return; }
    keys.add(k);
  };
  const onKeyUp = e => keys.delete(e.key.toLowerCase());
  const onBlur = () => keys.clear();

  // --- çubuklar (pointer events; touch-action: none) ---
  const bind = (el, side) => {
    const knob = el.querySelector('.fs-stick-knob');
    const down = e => {
      if (disposed) return;
      const b = el.getBoundingClientRect();
      drag[side] = { id: e.pointerId, cx: b.left + b.width / 2, cy: b.top + b.height / 2, r: b.width / 2 - 16 };
      el.setPointerCapture?.(e.pointerId); el.classList.add('on');
      move(e); e.preventDefault?.();
    };
    const move = e => {
      const d = drag[side];
      if (!d || e.pointerId !== d.id) return;
      const x = clamp((e.clientX - d.cx) / d.r, -1, 1), y = clamp(-(e.clientY - d.cy) / d.r, -1, 1);
      if (side === 'l') { ax.yaw = x; ax.thr = y; } else { ax.roll = x; ax.pitch = y; }
    };
    const up = e => { if (drag[side] && e.pointerId === drag[side].id) { drag[side] = null; el.classList.remove('on'); } };
    el.addEventListener('pointerdown', down); el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up); el.addEventListener('pointercancel', up);
    return { knob, off: () => { el.removeEventListener('pointerdown', down); el.removeEventListener('pointermove', move); el.removeEventListener('pointerup', up); el.removeEventListener('pointercancel', up); el.classList.remove('on'); } };
  };
  const L = bind(stickL, 'l'), R = bind(stickR, 'r');
  const draw = () => {
    const place = (knob, x, y) => { if (knob) knob.style.transform = `translate(${(x * 40).toFixed(1)}px, ${(-y * 40).toFixed(1)}px)`; };
    place(L.knob, ax.yaw, ax.thr); place(R.knob, ax.roll, ax.pitch);
  };

  // --- 20 Hz: klavye entegrasyonu + yay, çizim, gönderim ---
  const tick = () => {
    const now = nowMs(), dt = Math.min(0.2, (now - lastT) / 1000); lastT = now;
    const kax = (neg, pos) => (keys.has(pos) ? 1 : 0) - (keys.has(neg) ? 1 : 0);
    const decay = Math.exp(-SPRING * dt);
    const spring = (key, dir) => { if (dir) ax[key] = clamp(ax[key] + dir * KEY_RATE * dt, -1, 1); else { ax[key] *= decay; if (Math.abs(ax[key]) < 0.004) ax[key] = 0; } };
    if (!drag.r) { spring('roll', kax('arrowleft', 'arrowright')); spring('pitch', kax('arrowdown', 'arrowup')); }
    if (!drag.l) {
      spring('yaw', kax('a', 'd'));
      const t = kax('s', 'w');
      if (plane) { if (t) ax.thr = clamp(ax.thr + t * THR_RATE * dt, -1, 1); }   // tutmalı gaz
      else spring('thr', t);                                                     // askıya yaylı
    }
    draw();
    const ch = channels();
    send(ch);
    onChange?.(ch);
  };
  win.addEventListener('keydown', onKeyDown); win.addEventListener('keyup', onKeyUp); win.addEventListener('blur', onBlur);
  const timer = setIv(tick, 1000 / RC_HZ);
  draw();
  return {
    channels, tick, axes: ax,
    dispose() {
      if (disposed) return;
      disposed = true;
      clearIv(timer);
      win.removeEventListener('keydown', onKeyDown); win.removeEventListener('keyup', onKeyUp); win.removeEventListener('blur', onBlur);
      L.off(); R.off();
      if (L.knob) L.knob.style.transform = ''; if (R.knob) R.knob.style.transform = '';
      send([0, 0, 0, 0, 0, 0, 0, 0]);   // override serbest
    },
  };
}

// Ağ bozulması test kipi (§5 titreme teşhisi): #/fly/<id>?netsim=jitter30,loss5,delay40 — gelen her `tele` karesi delay + U(0, 2·jitter) ms
// gecikmeyle (sıra bozulabilir) iletilir, %loss'u düşürülür. Yalnız bu parametreyle açılır; ayrıca window.__fsSim (3B nesnesi: netStats/motionStats) verilir.
export function parseNetsim(s) {
  if (!s) return null;
  const o = { jitter: 0, loss: 0, delay: 0 };
  let any = false;
  for (const part of String(s).split(',')) { const m = /^(jitter|loss|delay)(\d+(?:\.\d+)?)$/.exec(part.trim()); if (m) { o[m[1]] = Number(m[2]); any = true; } }
  return any ? o : null;
}
/** Konum çubuğundan netsim: `#/fly/12?netsim=jitter30` ya da `?netsim=` (kabuk `param`ı ham bırakır). */
export function netsimFromLocation(loc = globalThis.location) {
  if (!loc) return null;
  const m = /[?&]netsim=([^&#]+)/.exec(`${loc.hash || ''}&${loc.search || ''}`);
  return m ? parseNetsim(decodeURIComponent(m[1])) : null;
}
/** Bozulmuş teslim: netsim yoksa anında. rnd/timer test için (varsayılan Math.random/setTimeout). Dönüş: iletildi mi (kayıp → false). */
export function netsimDeliver(netsim, fn, rnd = Math.random, timer = (f, ms) => setTimeout(f, ms)) {
  if (!netsim) { fn(); return true; }
  if (rnd() * 100 < netsim.loss) return false;
  timer(fn, netsim.delay + rnd() * 2 * netsim.jitter);
  return true;
}
