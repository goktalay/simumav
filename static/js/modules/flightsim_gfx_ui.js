// Uçuş Simülatörü §43 — GRAFİK KALİTESİ arayüzü (HEPGO flightsim.js + SIMUMAV fly/session.js + iki sihirbazın son adımı; docs/ucus-simulatoru.md §43).
// • createGfxCtl: alt bandın Panel/ses kapsülüne "Grafik ▾" düğmesi + açılır menü — ön ayar seçici (Otomatik/Düşük/Orta/Yüksek/Ultra/Özel), canlı FPS /
//   çizim çağrısı / üçgen / tampon çözünürlüğü, dinamik çözünürlük, köşe FPS sayacı, arka planda kısma, kare hızı sınırı, "Ayrıntılı" bölümünde Özel
//   kaydırıcıları. Değişiklikler sim.setGraphics ile CANLI uygulanır (yeniden başlatma yok). Otomatik kipte uyarlamalı kademe (createAdaptive) 0,5 sn'de bir
//   sim.gfxStats() ile beslenir; kullanıcı elle seçince uyarlamalı kip kapanır. Mobilde Yüksek/Ultra seçilince pil/ısınma uyarısı.
// • createGfxPicker: sihirbazın son adımı için küçük ön ayar seçici (aynı kalıcı tercih).
// Tercih: HEPGO localStorage `fs.gfx`, SIMUMAV `sm.gfx` (storageKey). Metinler flightsim_gfx GFX_TEXTS (keyed: SIMUMAV `gfx.*`).
import { AA_MODES, ANISO_STEPS, FPS_CAPS, GFX_CHOICES, GFX_KEY, GFX_LIMITS, PIP_FPS_STEPS, SHADOW_SIZES, autoLevel, createAdaptive, createDynRes, levelLabel, loadGfxPref, makeGfxT, mobileWarn, resolveGfx, saveGfxPref } from './flightsim_gfx.js';

function el(tag, attrs, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') e.className = v; else if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2), v); else if (k === 'html') e.innerHTML = v; else e.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat(Infinity)) if (c != null && c !== false) e.append(c.nodeType ? c : document.createTextNode(String(c)));
  return e;
}
const CSS = `
.fs-gfx-btn{display:inline-flex;align-items:center;gap:4px}
.fs-gfx-btn .fs-gfx-ico{display:inline-flex}
.fs-gfx-btn .fs-gfx-lvl{font:700 10.5px/1 system-ui,sans-serif;opacity:.85}
.fs-gfx-menu{min-width:300px;max-width:min(360px,92vw);max-height:min(72vh,640px);overflow:auto;gap:7px}
.fs-gfx-menu .fs-gfx-h{display:flex;align-items:center;justify-content:space-between;font-weight:700;font-size:13px}
.fs-gfx-seg{display:flex;flex-wrap:wrap;gap:3px}
.fs-gfx-seg button{flex:1 1 auto;min-width:0;height:26px;padding:0 7px;border-radius:7px;border:1px solid rgba(255,255,255,.14);background:rgba(255,255,255,.06);color:inherit;font:600 11.5px/1 system-ui,sans-serif;cursor:pointer;white-space:nowrap}
.fs-gfx-seg button:hover{background:rgba(255,255,255,.13)}
.fs-gfx-seg button.on{background:var(--primary,#1f6feb);border-color:transparent;color:#fff}
.fs-gfx-now{font-size:11.5px;opacity:.8}
.fs-gfx-stats{display:grid;grid-template-columns:repeat(4,1fr);gap:4px;font:600 11px/1.25 ui-monospace,SFMono-Regular,Menlo,monospace}
.fs-gfx-stats>div{padding:4px 5px;border-radius:6px;background:rgba(255,255,255,.06);text-align:center}
.fs-gfx-stats small{display:block;font:500 9.5px/1.2 system-ui,sans-serif;opacity:.7;margin-bottom:2px}
.fs-gfx-row{display:flex;align-items:center;gap:8px;min-height:24px}
.fs-gfx-row>span{flex:0 0 46%;font-size:11.5px}
.fs-gfx-row>input[type=range]{flex:1;min-width:60px;accent-color:var(--primary,#1f6feb)}
.fs-gfx-row>b{flex:0 0 40px;text-align:right;font:600 11px/1 ui-monospace,monospace}
.fs-gfx-row select{flex:1;height:24px;border-radius:6px;background:#1b2434;color:inherit;border:1px solid rgba(255,255,255,.16);font-size:11.5px}
.fs-gfx-chk{display:flex;align-items:center;gap:7px;font-size:11.5px;cursor:pointer}
.fs-gfx-menu details{border-top:1px solid rgba(255,255,255,.1);padding-top:6px}
.fs-gfx-menu summary{cursor:pointer;font-weight:700;font-size:12px;margin-bottom:5px}
.fs-gfx-warn{color:#f5a524;font-size:11.5px}
.fs-gfx-note{font-size:10.5px;opacity:.65}
.fs-gfx-foot{display:flex;justify-content:space-between;align-items:center;gap:6px}
.fs-gfx-fps{position:absolute;top:68px;left:50%;transform:translateX(-50%);z-index:7;pointer-events:none;padding:3px 8px;border-radius:6px;background:rgba(11,18,32,.72);color:#9fe870;font:700 11px/1.3 ui-monospace,SFMono-Regular,Menlo,monospace;white-space:nowrap}
.fs-gfx-fps.low{color:#f5a524}.fs-gfx-fps.bad{color:#ff6b6b}
.fs-gfx-pick{display:grid;gap:6px;margin:10px 0}
.fs-gfx-pick h3,.fs-gfx-pick .fs-gfx-pick-h{margin:0;font-size:14px;font-weight:700}
.fs-gfx-pick .fs-gfx-seg button{height:30px;font-size:12.5px}
.fs-gfx-pick .fs-gfx-pick-light button{color:var(--text,#1f2937);background:var(--surface-2,#f3f4f6);border-color:var(--border,#d1d5db)}
.fs-gfx-pick .fs-gfx-pick-light button.on{background:var(--primary,#1f6feb);color:#fff;border-color:transparent}
`;
let cssDone = false;
const ensureCss = () => { if (cssDone || typeof document === 'undefined') return; cssDone = true; document.head.append(el('style', { 'data-fs': 'gfx' }, CSS)); };

/** Cihaz bilgisi (GPU adı sim.gfxCaps.gpu'dan; ikinci WebGL bağlamı AÇILMAZ) */
export function deviceInfo(gpu = '') {
  const nav = typeof navigator !== 'undefined' ? navigator : {};
  let coarse = false; try { coarse = !!matchMedia('(pointer: coarse)').matches; } catch { /* */ }
  const mobile = /Android|iPhone|iPad|iPod|Mobile/i.test(nav.userAgent || '') || (coarse && (nav.maxTouchPoints || 0) > 1);
  return { gpu, dpr: (typeof devicePixelRatio !== 'undefined' && devicePixelRatio) || 1, cores: nav.hardwareConcurrency || 4, mem: nav.deviceMemory || 4, mobile };
}

const fmtK = n => (n >= 1e6 ? `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(n >= 1e4 ? 0 : 1)}k` : String(n | 0));

/**
 * opts { tr, keyed, storageKey, getSim, stage, onEvent(text), storage, btnClass }. Dönüş { el (düğme + menü kapsülü), initial() (sim kurulmadan
 * önceki parametre: createFlightSim3D opts.gfx), attach(sim), pref, state(), setPreset(c), dispose() }.
 */
export function createGfxCtl({ tr = null, keyed = false, storageKey = GFX_KEY, getSim = () => null, stage = null, onEvent = null, storage = globalThis.localStorage, btnClass = 'btn sm' } = {}) {
  ensureCss();
  const T = makeGfxT(tr, keyed);
  let pref = loadGfxPref(storage, storageKey);
  const dev0 = deviceInfo('');
  let caps = { autoLevel: pref.autoLevel || autoLevel(dev0).level, mobile: dev0.mobile };
  let det = null, adaptive = null, dyn = null, timer = 0, holdUntil = 0, last = null, applied = null, disposed = false;
  const save = () => { pref = saveGfxPref(pref, storage, storageKey); };
  const current = () => resolveGfx(pref, caps, { level: pref.preset === 'auto' && adaptive ? adaptive.level : null, scaleMul: dyn ? dyn.scale : pref.preset === 'auto' && adaptive ? adaptive.scaleMul : 1 });

  // ---------- düğme + menü ----------
  // Alt bant dar: düğme simge + kademe harfi (D/O/Y/U, Otomatikte "A"); ayrıntı başlıkta (title) ve menüde
  const ICO = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4M7 12l3-3 2 2 4-4"/></svg>';
  const btnTxt = el('small', { class: 'fs-gfx-lvl' }, '');
  const btn = el('button', { class: `${btnClass} fs-gfx-btn`, type: 'button', title: T('gfx.btn_title'), 'aria-label': T('gfx.btn'), onclick: () => { menu.hidden = !menu.hidden; if (!menu.hidden) draw(); } }, el('span', { class: 'fs-gfx-ico', html: ICO }), btnTxt, ' ▾');
  const drawBtn = p => {
    const lv = pref.preset === 'custom' ? 'custom' : p.level;
    btnTxt.textContent = pref.preset === 'auto' ? `A·${levelLabel(T, lv).slice(0, 1)}` : levelLabel(T, lv).slice(0, 1);
    btn.title = `${T('gfx.btn_title')}\n${T('gfx.btn')}: ${pref.preset === 'auto' ? T('gfx.auto_now', { l: levelLabel(T, p.level) }) : levelLabel(T, lv)}`;
  };
  const seg = el('div', { class: 'fs-gfx-seg', role: 'radiogroup' });
  const segBtns = GFX_CHOICES.map(c => { const b = el('button', { type: 'button', 'data-gfx': c, onclick: () => setPreset(c) }, levelLabel(T, c)); seg.append(b); return b; });
  const nowLbl = el('div', { class: 'fs-gfx-now' });
  const warn = el('div', { class: 'fs-gfx-warn', hidden: true }, T('gfx.mobile_warn'));
  const stat = k => { const b = el('b', null, '—'); return [el('div', null, el('small', null, T(k)), b), b]; };
  const [sFps, vFps] = stat('gfx.fps'), [sCalls, vCalls] = stat('gfx.calls'), [sTris, vTris] = stat('gfx.tris'), [sRes, vRes] = stat('gfx.res');
  const stats = el('div', { class: 'fs-gfx-stats' }, sFps, sCalls, sTris, sRes);
  const chk = (key, label, title, onChange) => { const inp = el('input', { type: 'checkbox', onchange: () => onChange(inp.checked) }); const row = el('label', { class: 'fs-gfx-chk', title }, inp, el('span', null, label)); row.__sync = () => { inp.checked = !!pref[key]; }; return row; };
  const chkDyn = chk('dynRes', T('gfx.dynres'), T('gfx.dynres_hint'), v => { pref.dynRes = v; save(); setupDyn(); apply(); });
  const chkCnt = chk('fpsCounter', T('gfx.counter'), '', v => { pref.fpsCounter = v; save(); syncCounter(); });
  const chkBg = chk('bgThrottle', T('gfx.bg'), '', v => { pref.bgThrottle = v; save(); apply(); });
  const capSeg = el('div', { class: 'fs-gfx-seg' }, FPS_CAPS.map(c => el('button', { type: 'button', 'data-cap': c, onclick: () => { pref.fpsCap = c; save(); setupDyn(); apply(); } }, c ? String(c) : T('gfx.unlimited'))));
  // Özel kaydırıcılar: [alan, etiket, tür, seçenekler]
  const opt = (v, l) => ({ v, l });
  const FIELDS = [
    ['scale', 'gfx.scale', 'range', GFX_LIMITS.scale, 0.05, v => `${Math.round(v * 100)}%`],
    ['aa', 'gfx.aa', 'select', AA_MODES.map(m => opt(m, T(`gfx.aa_${m}`)))],
    ['shadow', 'gfx.shadow', 'select', SHADOW_SIZES.map(s => opt(s, s ? String(s) : T('gfx.off')))],
    ['shadowDist', 'gfx.shadow_dist', 'range', GFX_LIMITS.shadowDist, 10, v => `${v} m`],
    ['fog', 'gfx.fog', 'range', GFX_LIMITS.fog, 0.05, v => `${v.toFixed(2)}×`],
    ['terrain', 'gfx.terrain', 'select', [0, 1, 2, 3].map(i => opt(i, T(`gfx.lvl${i}`)))],
    ['trees', 'gfx.trees', 'range', GFX_LIMITS.trees, 0.05, v => `${Math.round(v * 100)}%`],
    ['aniso', 'gfx.aniso', 'select', ANISO_STEPS.map(a => opt(a, `${a}×`))],
    ['water', 'gfx.water', 'select', [0, 1, 2].map(i => opt(i, T(`gfx.lvl${i}`)))],
    ['precip', 'gfx.precip', 'range', GFX_LIMITS.precip, 0.05, v => `${Math.round(v * 100)}%`],
    ['post', 'gfx.post', 'check'],
    ['bloom', 'gfx.bloom', 'range', GFX_LIMITS.bloom, 0.05, v => v.toFixed(2)],
    ['ao', 'gfx.ao', 'select', [opt(0, T('gfx.off')), opt(1, T('gfx.ao_half')), opt(2, T('gfx.ao_full'))]],
    ['pipScale', 'gfx.pip', 'range', GFX_LIMITS.pipScale, 0.05, v => `${Math.round(v * 100)}%`],
    ['pipFps', 'gfx.pip_fps', 'select', PIP_FPS_STEPS.map(f => opt(f, `${f} fps`))],
    ['g3dError', 'gfx.g3d', 'range', GFX_LIMITS.g3dError, 1, v => `${v} px`],
  ];
  const setCustom = (k, v) => {
    if (pref.preset !== 'custom') { pref.base = last?.level || 'high'; pref.custom = {}; pref.preset = 'custom'; adaptive = null; }
    pref.custom[k] = v; save(); apply();
  };
  const rows = FIELDS.map(([k, lk, kind, a, step, fmt]) => {
    let inp, out = null;
    if (kind === 'range') {
      out = el('b');
      inp = el('input', { type: 'range', min: a[0], max: a[1], step, 'data-k': k, oninput: () => { out.textContent = fmt(Number(inp.value)); }, onchange: () => setCustom(k, Number(inp.value)) });
    } else if (kind === 'select') {
      inp = el('select', { 'data-k': k, onchange: () => { const o = a.find(x => String(x.v) === inp.value); setCustom(k, o ? o.v : inp.value); } }, a.map(o => el('option', { value: String(o.v) }, o.l)));
    } else {
      inp = el('input', { type: 'checkbox', 'data-k': k, onchange: () => setCustom(k, inp.checked) });
      const r = el('label', { class: 'fs-gfx-chk' }, inp, el('span', null, T(lk)));
      r.__sync = p => { inp.checked = !!p[k]; };
      return r;
    }
    const r = el('div', { class: 'fs-gfx-row' }, el('span', null, T(lk)), inp, out);
    r.__sync = p => { const v = k === 'scale' ? (pref.preset === 'custom' && pref.custom.scale != null ? pref.custom.scale : p.scale / (p.scaleMul || 1)) : p[k]; inp.value = String(v); if (out && fmt) out.textContent = fmt(Number(v)); };
    return r;
  });
  const det2 = el('details', { class: 'fs-gfx-adv' }, el('summary', null, T('gfx.advanced')), rows, el('div', { class: 'fs-gfx-note' }, T('gfx.rebuild')));
  const resetBtn = el('button', { class: 'btn sm', type: 'button', onclick: () => { pref.custom = {}; setPreset(pref.preset === 'custom' ? pref.base : pref.preset); } }, T('gfx.reset'));
  const closeBtn = el('button', { class: 'btn sm', type: 'button', 'aria-label': 'x', onclick: () => { menu.hidden = true; } }, '✕');
  const menu = el('div', { class: 'fs-audio-menu fs-gfx-menu', hidden: true },
    el('div', { class: 'fs-gfx-h' }, el('span', null, T('gfx.title')), closeBtn), seg, nowLbl, warn, stats,
    el('div', { class: 'fs-gfx-row' }, el('span', null, T('gfx.fps_cap')), capSeg), chkDyn, chkCnt, chkBg, det2,
    el('div', { class: 'fs-gfx-foot' }, el('span', { class: 'fs-gfx-note' }, T('gfx.note')), resetBtn));
  const wrap = el('span', { class: 'fs-audio fs-gfx' }, btn, menu);
  const onDoc = e => { if (!menu.hidden && !wrap.contains(e.target)) menu.hidden = true; };
  document.addEventListener('click', onDoc, true);
  const counter = el('div', { class: 'fs-gfx-fps', hidden: true });
  if (stage) stage.append(counter);
  const syncCounter = () => { counter.hidden = !pref.fpsCounter; };

  function draw() {
    const p = last || current();
    segBtns.forEach(b => { b.classList.toggle('on', b.dataset.gfx === pref.preset); b.setAttribute('aria-checked', String(b.dataset.gfx === pref.preset)); });
    nowLbl.textContent = pref.preset === 'auto' ? `${T('gfx.auto_now', { l: levelLabel(T, p.level) })}${p.scaleMul && p.scaleMul < 1 ? ` · ${Math.round(p.scaleMul * 100)}%` : ''} — ${T('gfx.auto_hint')}`
      : pref.preset === 'custom' ? `${T('gfx.custom')} · ${levelLabel(T, pref.base)}` : levelLabel(T, pref.preset);
    warn.hidden = !mobileWarn(pref.preset, caps.mobile, pref.base);
    [chkDyn, chkCnt, chkBg].forEach(r => r.__sync());
    capSeg.querySelectorAll('button').forEach(b => b.classList.toggle('on', Number(b.dataset.cap) === Number(p.fpsCap)));
    rows.forEach(r => r.__sync(p));
    drawBtn(p);
  }
  function apply() {
    last = current();
    applied = getSim()?.setGraphics?.(last) || null;
    holdUntil = performance.now() + 4000;   // yeni ayarın kare hızı oturana dek uyarlamalı kip beklemede
    if (!menu.hidden) draw(); else drawBtn(last);
    return last;
  }
  function setupAdaptive() {
    adaptive = pref.preset === 'auto' ? createAdaptive({ level: caps.autoLevel, max: det?.max || 'ultra', dynRes: pref.dynRes, cap: resolveGfx(pref, caps).fpsCap }) : null;
  }
  function setupDyn() {
    const cap = resolveGfx(pref, caps).fpsCap;
    dyn = pref.dynRes ? (dyn || createDynRes({ cap })) : null;
    dyn?.setCap(cap); adaptive?.setDynRes(pref.dynRes); adaptive?.setCap(cap);
  }
  function setPreset(c) {
    if (!GFX_CHOICES.includes(c)) return;
    const was = pref.preset;
    pref.preset = c;
    if (c === 'custom' && was !== 'custom') { pref.base = last?.level || 'high'; }
    save();
    setupAdaptive(); setupDyn();
    const p = apply();
    if (was !== c) onEvent?.(T('gfx.changed', { l: c === 'auto' ? `${levelLabel(T, 'auto')} (${levelLabel(T, p.level)})` : levelLabel(T, c) }));
    draw();
  }
  function tick() {
    if (disposed) return;
    const sim = getSim();
    const st = sim?.gfxStats?.();
    if (!st) return;
    const now = performance.now();
    const fpsTxt = `${st.fps < 10 ? st.fps.toFixed(1) : Math.round(st.fps)} fps`;
    counter.textContent = `${fpsTxt} · ${fmtK(st.calls)} ${T('gfx.calls').toLowerCase()} · ${st.w}×${st.h}`;
    counter.classList.toggle('low', st.fps < 40 && st.fps >= 24); counter.classList.toggle('bad', st.fps < 24);
    if (!menu.hidden) { vFps.textContent = st.fps < 10 ? st.fps.toFixed(1) : String(Math.round(st.fps)); vCalls.textContent = fmtK(st.calls); vTris.textContent = fmtK(st.tris); vRes.textContent = `${st.w}×${st.h}`; vRes.parentElement.title = `${st.w}×${st.h} @ ${st.pr}× · MSAA ${st.samples}${st.post ? ' · post' : ''}`; }
    if (typeof document !== 'undefined' && document.hidden) return;
    if (now < holdUntil || st.blurred) return;
    let changed = false;
    if (dyn) { const k = dyn.push(st.fps); if (k != null) changed = true; }
    if (adaptive) {
      const r = adaptive.push(st.fps, now);
      if (r) { changed = true; if (r.reason === 'level') onEvent?.(T(r.dir < 0 ? 'gfx.adapt_down' : 'gfx.adapt_up', { l: levelLabel(T, r.level) })); }
    }
    if (changed) apply();
  }
  function attach(sim) {
    if (!sim) return;
    const c = sim.gfxCaps || {};
    det = autoLevel({ ...deviceInfo(c.gpu || ''), maxTex: c.maxTex });
    caps = { ...caps, ...c, autoLevel: det.level, mobile: deviceInfo().mobile };
    if (pref.autoLevel !== det.level) { pref.autoLevel = det.level; save(); }
    setupAdaptive(); setupDyn(); syncCounter();
    apply();
    clearInterval(timer); timer = setInterval(tick, 500);
  }
  syncCounter();
  return {
    el: wrap, menu, counter, get pref() { return { ...pref }; },
    initial: () => (last = current()),
    attach, setPreset, apply,
    state: () => ({ pref: { ...pref }, applied: last, det, adaptive: adaptive ? { level: adaptive.level, scaleMul: adaptive.scaleMul, changes: adaptive.changes } : null, dyn: dyn ? dyn.scale : null, sim: applied }),
    dispose() { disposed = true; clearInterval(timer); document.removeEventListener('click', onDoc, true); counter.remove(); wrap.remove(); },
  };
}

/** Sihirbazın son adımı: ön ayar seçici (kalıcı tercihe yazar). opts { tr, keyed, storageKey, light (açık tema), storage } → { el, value } */
export function createGfxPicker({ tr = null, keyed = false, storageKey = GFX_KEY, light = false, storage = globalThis.localStorage } = {}) {
  ensureCss();
  const T = makeGfxT(tr, keyed);
  let pref = loadGfxPref(storage, storageKey);
  const mobile = deviceInfo().mobile;
  const warn = el('div', { class: 'fs-gfx-warn', hidden: true }, T('gfx.mobile_warn'));
  const seg = el('div', { class: `fs-gfx-seg${light ? ' fs-gfx-pick-light' : ''}`, role: 'radiogroup' });
  const btns = GFX_CHOICES.filter(c => c !== 'custom' || pref.preset === 'custom').map(c => { const b = el('button', { type: 'button', 'data-gfx': c, onclick: () => pick(c) }, levelLabel(T, c)); seg.append(b); return b; });
  const sync = () => { btns.forEach(b => { b.classList.toggle('on', b.dataset.gfx === pref.preset); b.setAttribute('aria-checked', String(b.dataset.gfx === pref.preset)); }); warn.hidden = !mobileWarn(pref.preset, mobile, pref.base); };
  function pick(c) { pref.preset = c; pref = saveGfxPref(pref, storage, storageKey); sync(); }
  sync();
  const box = el('div', { class: 'fs-gfx-pick' }, el('div', { class: 'fs-gfx-pick-h' }, T('gfx.wiz')), seg, warn, el('small', { class: 'muted' }, T('gfx.wiz_hint')));
  return { el: box, get value() { return pref.preset; } };
}
