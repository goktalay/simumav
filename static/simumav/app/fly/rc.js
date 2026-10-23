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
// shape(eksen, v): HEPGO §27.1 hassasiyet eğrisi (/sim/flightsim_rcfeel.js makeShaper) — çubuk ve klavye aynı eğriden; yoksa doğrusal
export const channelsOf = (ax, ch5, shape = null) => { const S = (k, v) => (shape ? shape(k, v) : v); return [pwm(S('roll', ax.roll)), pwm(-S('pitch', ax.pitch)), pwm(S('thr', ax.thr)), pwm(S('yaw', ax.yaw)), ch5, 0, 0, 0]; };
// KARA ARACI (HEPGO §31; docs/simumav.md §15): ArduRover RC1 direksiyon, RC3 gaz (1500 = dur; ileri / geri-fren çift yönlü), RC2/RC4 dokunulmaz (0).
// Asıl eşleme /sim/flightsim_rover.js roverRcChannels (session.js `rover.channels` olarak verir); burada aynı biçimin yedeği (tarayıcısız test).
export const roverChannelsOf = ({ steer = 0, thr = 0, ch5 = 1500 } = {}) => [pwm(steer), 0, pwm(thr), 0, Math.round(clamp(Number(ch5) || 1500, 1000, 2000)), 0, 0, 0];
export const ROVER_RC_KEYS = { thrUp: ['w', 'arrowup'], thrDown: ['s', 'arrowdown'], left: ['a', 'arrowleft'], right: ['d', 'arrowright'] };

// ======================================================================
// Sanal kumanda: iki sanal çubuk (Mode 2: sol gaz/yaw, sağ pitch/roll; dokunmatik + fare, pointer events) + klavye.
// ArduPilot RC: ch1 roll, ch2 pitch (ileri = burun aşağı = düşük PWM), ch3 gaz, ch4 yaw, ch5 mod anahtarı; 1000–2000, merkez 1500.
// Eksenler −1…1: tuş basılıyken KEY_RATE ile uca gider, bırakılınca yaylı (üstel) merkeze döner. Kopterde gaz çubuğu merkeze yaylıdır
// (1500 ≈ askı); uçakta gaz tutmalıdır (W/S kaydırır, çubuk bırakıldığı yerde kalır). Boşluk = gaz 1500. Q/E = ch5 1000/1500/2000.
// 20 Hz: tick (klavye entegrasyonu + çizim) → send(channels()). dispose(): zamanlayıcı/dinleyiciler kalkar, 8×0 (override serbest) gönderilir.
// Kara aracı (`rover`: true ya da {channels}): sol çubuk DİKEY = gaz (yaylı; bırakınca 1500 = dur, aşağı geri/fren), sağ çubuk YATAY = direksiyon (yaylı);
// klavye W/S ya da ↑/↓ gaz, A/D ya da ←/→ direksiyon, Boşluk dur (gaz + direksiyon orta); kanallar rover.channels({steer, thr, ch5}) (roverRcChannels).
// ======================================================================
// HEPGO §37 pad(): fiziksel kumanda durumu {active, axes, thrAbs} (/sim/flightsim_gamepad.js; axes kumanda girdi eğrisinden geçmiş, thrAbs uçak mutlak gazı) — aktifken çubuk eksenlerini yazar; lazyThr: varsayılan açık gelişte
// kopterde ch3 ilk gaz girdisine dek 0 (dokunma).
// HEPGO §27.1.1 kumanda modu (Mode 1–4): [sol X, sol Y, sağ X, sağ Y] — /sim/flightsim_stickmode.js STICK_MAP ile aynı; WASD sol çubuk, oklar sağ çubuk.
export const STICK_MAP = { 1: ['yaw', 'pitch', 'roll', 'thr'], 2: ['yaw', 'thr', 'roll', 'pitch'], 3: ['roll', 'pitch', 'yaw', 'thr'], 4: ['roll', 'thr', 'yaw', 'pitch'] };
export function virtualRC({ plane, stickL, stickR, send, onChange, throttle0 = null, env = null, shape = null, rover = null, pad = null, lazyThr = false, stickMode = () => 2 }) {
  const win = env?.window || globalThis.window, doc = env?.document || globalThis.document;
  const nowMs = env?.now || (() => performance.now());
  const setIv = env?.setInterval || ((fn, ms) => setInterval(fn, ms)), clearIv = env?.clearInterval || (id => clearInterval(id));
  // thr: −1 = 1000 (uçak boşta), 0 = 1500 (kopter askı). Uçakta kumanda uçuş sırasında açılırsa (throttle0: telemetri gazı %) çubuk o gazda başlar:
  // ArduPlane TAKEOFF/AUTO'da gazı RC'den bağımsız verir; çubuk altta (1000) iken HUD %100 "ters" görünmesin, FBWA'ya geçişte gaz aniden kesilmesin.
  const thr0 = plane && throttle0 != null && Number.isFinite(Number(throttle0)) ? clamp(Number(throttle0) / 50 - 1, -1, 1) : null;
  const isRv = !!rover, rvCh = typeof rover?.channels === 'function' ? rover.channels : roverChannelsOf;
  const ax = { roll: 0, pitch: 0, thr: plane && !isRv ? (thr0 ?? -1) : 0, yaw: 0, steer: 0 };
  let ch5 = 1500, lastT = nowMs(), disposed = false;
  const keys = new Set();
  const drag = { l: null, r: null };          // sürüklenen çubuk: {id, x0, y0, r}
  const KEY_RATE = 3.5, SPRING = 9, THR_RATE = 0.7;
  const editable = el => el && (/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || el.isContentEditable);
  const S = (k, v) => (shape ? shape(k, v) : v);
  let thrUsed = !(lazyThr && !plane && !isRv);
  const channels = () => { if (isRv) return rvCh({ steer: S('roll', ax.steer), thr: S('thr', ax.thr), ch5 }); const c = channelsOf(ax, ch5, shape); if (!thrUsed) c[2] = 0; return c; };

  const SM = () => { const [lx, ly, rx, ry] = STICK_MAP[stickMode?.()] || STICK_MAP[2]; return { lx, ly, rx, ry }; };
  const sideOf = (M, k) => (k === M.lx || k === M.ly ? 'l' : 'r');
  const thrKey = k => { const M = SM(); return (M.ly === 'thr' && (k === 'w' || k === 's')) || (M.ry === 'thr' && (k === 'arrowup' || k === 'arrowdown')); };

  // --- klavye ---
  const onKeyDown = e => {
    if (disposed || editable(doc?.activeElement) || e.ctrlKey || e.metaKey || e.altKey) return;
    const k = e.key.toLowerCase();
    if (!RC_KEYS.has(k)) return;
    e.preventDefault?.();
    if (e.repeat) return;
    if (k === ' ') { ax.thr = 0; thrUsed = true; if (isRv) ax.steer = 0; return; }
    if (isRv ? (k === 'w' || k === 's') : thrKey(k)) thrUsed = true;
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
      if (isRv) { if (side === 'l') ax.thr = y; else ax.steer = x; return; }   // kara aracı: sol dikey gaz, sağ yatay direksiyon
      const M = SM();
      if (side === 'l') { ax[M.lx] = x; ax[M.ly] = y; } else { ax[M.rx] = x; ax[M.ry] = y; }
      if (sideOf(M, 'thr') === side) thrUsed = true;
    };
    const up = e => { if (drag[side] && e.pointerId === drag[side].id) { drag[side] = null; el.classList.remove('on'); } };
    el.addEventListener('pointerdown', down); el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up); el.addEventListener('pointercancel', up);
    return { knob, off: () => { el.removeEventListener('pointerdown', down); el.removeEventListener('pointermove', move); el.removeEventListener('pointerup', up); el.removeEventListener('pointercancel', up); el.classList.remove('on'); } };
  };
  const L = bind(stickL, 'l'), R = bind(stickR, 'r');
  const draw = () => {
    const place = (knob, x, y) => { if (knob) knob.style.transform = `translate(${(x * 40).toFixed(1)}px, ${(-y * 40).toFixed(1)}px)`; };
    if (isRv) { place(L.knob, 0, ax.thr); place(R.knob, ax.steer, 0); return; }
    const M = SM();
    place(L.knob, ax[M.lx], ax[M.ly]); place(R.knob, ax[M.rx], ax[M.ry]);
  };

  // --- 20 Hz: klavye entegrasyonu + yay, çizim, gönderim ---
  const tick = () => {
    const now = nowMs(), dt = Math.min(0.2, (now - lastT) / 1000); lastT = now;
    const kax = (neg, pos) => (keys.has(pos) ? 1 : 0) - (keys.has(neg) ? 1 : 0);
    const decay = Math.exp(-SPRING * dt);
    const spring = (key, dir) => { if (dir) ax[key] = clamp(ax[key] + dir * KEY_RATE * dt, -1, 1); else { ax[key] *= decay; if (Math.abs(ax[key]) < 0.004) ax[key] = 0; } };
    const M = SM();
    if (isRv) {   // kara aracı: iki eksen de yaylı (bırakınca dur / düz)
      const any = list => list.some(k => keys.has(k));
      if (!drag.r) spring('steer', (any(ROVER_RC_KEYS.right) ? 1 : 0) - (any(ROVER_RC_KEYS.left) ? 1 : 0));
      if (!drag.l) spring('thr', (any(ROVER_RC_KEYS.thrUp) ? 1 : 0) - (any(ROVER_RC_KEYS.thrDown) ? 1 : 0));
    } else {   // HEPGO §27.1.1: WASD sol çubuğun, oklar sağ çubuğun eksenleri (mod belirler)
      const kv = { [M.lx]: kax('a', 'd'), [M.ly]: kax('s', 'w'), [M.rx]: kax('arrowleft', 'arrowright'), [M.ry]: kax('arrowdown', 'arrowup') };
      for (const k of ['roll', 'pitch', 'yaw']) if (!drag[sideOf(M, k)]) spring(k, kv[k]);
      if (!drag[sideOf(M, 'thr')]) {
        const t = kv.thr;
        if (plane) { if (t) ax.thr = clamp(ax.thr + t * THR_RATE * dt, -1, 1); }   // tutmalı gaz
        else spring('thr', t);                                                     // askıya yaylı
      }
    }
    const ps = pad?.();   // HEPGO §37 fiziksel kumanda (dokunulan sanal çubuk o tarafta öncelikli)
    if (ps?.active) {
      const a = ps.axes, set = (k, v) => { if (v != null) ax[k] = clamp(v, -1, 1); };
      if (!drag[isRv ? 'l' : sideOf(M, 'thr')]) {
        if (plane && !isRv && ps.profile === 'standard') { if (a.thr) ax.thr = clamp(ax.thr + a.thr * THR_RATE * dt, -1, 1); }   // yaylı gamepad kolu: uçakta tutmalı gaz hızla
        else set('thr', plane && !isRv && ps.thrAbs != null ? ps.thrAbs : a.thr);   // uçakta RC verici: mutlak tek yönlü eğri (rölanti hep −1)
        if (a.thr) thrUsed = true;
      }
      if (isRv) { if (!drag.r) set('steer', a.roll); }
      else for (const k of ['yaw', 'roll', 'pitch']) if (!drag[sideOf(M, k)]) set(k, a[k]);
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
    bumpCh5(d) { ch5 = clamp(ch5 + (d > 0 ? 500 : -500), 1000, 2000); },   // HEPGO §37 kumanda düğmesi
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
