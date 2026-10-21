// Uçuş Simülatörü — FİZİKSEL KUMANDA (Gamepad API; docs/ucus-simulatoru.md §37; HEPGO + SIMUMAV ortak). Tarayıcıya takılan oyun kumandası ya da
// USB joystick kipindeki RC verici (EdgeTX / OpenTX / Radiomaster …) navigator.getGamepads() ile okunur ve SANAL KUMANDANIN RC yoluna beslenir
// (virtualRC `pad` girdisi: aynı 20 Hz {t:'rc', ch} gönderimi, aynı §27.1 hassasiyet eğrisi, aynı Mode 2 eşlemesi — sol çubuk gaz / sapma, sağ çubuk
// yunuslama / yatış; kara aracında sol dikey gaz + sağ yatay direksiyon → roverRcChannels). Eksen/düğme ataması, ölü bölge ve ters çevirme küçük bir
// panelden (alt bantta kumanda simgesi; tercih localStorage fs.pad.cfg, profil başına: 'standard' = W3C standart eşleme, 'rc' = diğer / RC verici).
// Öncelik: kumanda kolları nötr dışındaysa (ya da son 1,5 sn'de oynatıldıysa) fiziksel kumanda yazar; dokunulan sanal çubuk o tarafta önceliklidir;
// kumanda nötr ve hareketsizken klavye / sanal çubuk çalışır ("son kullanılan kazanır").
// Saf katman (node testi tests/test_flightsim_gamepad.mjs): PAD_AXES, PAD_ACTIONS, DEFAULT_PAD, padProfile, deadzone, normPadCfg, loadPadCfg,
//   savePadCfg, readPadAxes, padButtonEdges, padActionsFor, padIsNeutral, PAD_TEXTS, makePadT.
// createGamepadCtl({ tr, keyed, storage, win, nav, onConnect(info), onDisconnect(info), onAction(name), onChange() }) →
//   { el, state(), connected, info, openPanel(), closePanel(), dispose() }   (state(): {active, axes:{thr,yaw,pitch,roll}} ya da null)

export const PAD_AXES = ['thr', 'yaw', 'pitch', 'roll'];
export const PAD_ACTIONS = ['arm', 'disarm', 'mode_next', 'mode_prev', 'ch5_up', 'ch5_down'];
export const PAD_PREF = 'fs.pad.cfg';
export const PAD_ACTIVE_MS = 1500;
// Standart eşleme (Xbox / PlayStation / çoğu USB gamepad; Chrome/Firefox/Safari 'standard'): eksen 0 sol X, 1 sol Y (aşağı +), 2 sağ X, 3 sağ Y (aşağı +);
// düğme 9 Start/Menü = ARM, 8 Back/Select = DISARM, 5 RB / 4 LB = sonraki / önceki mod, 12 / 13 yön yukarı / aşağı = ch5 (mod anahtarı).
// RC verici (USB joystick kipi; eşleme ''): yaygın EdgeTX/OpenTX sırası X = kanatçık, Y = irtifa dümeni, Z = gaz, Rx = istikamet dümeni; düğme ataması yok.
export const DEFAULT_PAD = {
  standard: { dead: 0.08, axes: { yaw: { i: 0, inv: false }, thr: { i: 1, inv: true }, roll: { i: 2, inv: false }, pitch: { i: 3, inv: true } },
    buttons: { arm: 9, disarm: 8, mode_next: 5, mode_prev: 4, ch5_up: 12, ch5_down: 13 } },
  rc: { dead: 0.03, axes: { roll: { i: 0, inv: false }, pitch: { i: 1, inv: true }, thr: { i: 2, inv: false }, yaw: { i: 3, inv: false } },
    buttons: { arm: -1, disarm: -1, mode_next: -1, mode_prev: -1, ch5_up: -1, ch5_down: -1 } },
};
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const clone = o => JSON.parse(JSON.stringify(o));
export const padProfile = gp => (gp && gp.mapping === 'standard' ? 'standard' : 'rc');
/** Ölü bölge: |v| < dz → 0; dışında 0…1'e yeniden ölçeklenir (uçta ±1 kalır). */
export function deadzone(v, dz = 0.08) {
  const x = Number(v); if (!Number.isFinite(x)) return 0;
  const d = clamp(Number(dz) || 0, 0, 0.5), a = Math.abs(x);
  if (a <= d) return 0;
  return Math.sign(x) * Math.min(1, (a - d) / (1 - d));
}
/** Profil ayarını doğrula / tamamla (bozuk → varsayılan; eksen -1 = atanmamış). */
export function normPadCfg(c, profile = 'standard') {
  const D = DEFAULT_PAD[profile] || DEFAULT_PAD.standard, out = clone(D);
  if (!c || typeof c !== 'object') return out;
  if (Number.isFinite(Number(c.dead))) out.dead = clamp(Number(c.dead), 0, 0.5);
  for (const k of PAD_AXES) {
    const a = c.axes?.[k]; if (!a || typeof a !== 'object') continue;
    const i = Math.round(Number(a.i));
    out.axes[k] = { i: Number.isFinite(i) ? clamp(i, -1, 31) : D.axes[k].i, inv: !!a.inv };
  }
  for (const k of PAD_ACTIONS) { const i = Math.round(Number(c.buttons?.[k])); if (Number.isFinite(i)) out.buttons[k] = clamp(i, -1, 63); }
  return out;
}
export function loadPadCfg(storage = null) {
  let raw = null; try { raw = JSON.parse(storage?.getItem(PAD_PREF) || 'null'); } catch { raw = null; }
  return { standard: normPadCfg(raw?.standard, 'standard'), rc: normPadCfg(raw?.rc, 'rc') };
}
export function savePadCfg(storage, all) { try { storage?.setItem(PAD_PREF, JSON.stringify(all)); } catch { /* depolama kapalı */ } }
/** Kumanda → eksenler (−1…1; ölü bölge + ters çevirme). Atanmamış / olmayan eksen → null. thr: +1 = tam gaz (kol yukarı). */
export function readPadAxes(gp, cfg) {
  const out = {};
  for (const k of PAD_AXES) {
    const a = cfg.axes[k], raw = a && a.i >= 0 ? gp?.axes?.[a.i] : undefined;
    out[k] = raw == null || !Number.isFinite(Number(raw)) ? null : deadzone(a.inv ? -raw : raw, cfg.dead);
  }
  return out;
}
const pressed = b => !!b && (typeof b === 'object' ? (b.pressed || (b.value ?? 0) > 0.5) : Number(b) > 0.5);
/** Düğme kenarları: önceki basılı kümesi → {set, down: yeni basılan dizinler}. */
export function padButtonEdges(prev, gp) {
  const set = new Set(), down = [];
  (gp?.buttons || []).forEach((b, i) => { if (pressed(b)) { set.add(i); if (!prev?.has(i)) down.push(i); } });
  return { set, down };
}
export const padActionsFor = (cfg, down) => PAD_ACTIONS.filter(k => cfg.buttons[k] >= 0 && down.includes(cfg.buttons[k]));
/** Eksenlerin hepsi nötr mü (gaz uçakta / RC vericide tutmalı olabilir → aktiflik ayrıca son hareket zamanıyla). */
export const padIsNeutral = axes => PAD_AXES.every(k => !axes[k]);

export const PAD_TEXTS = [
  ['pad.btn', 'Kumanda'], ['pad.btn_t', 'Fiziksel kumanda (gamepad / USB RC verici): eksen ve düğme ataması, ölü bölge, ters çevirme'],
  ['pad.connected', 'Kumanda bağlandı: {n}'], ['pad.disconnected', 'Kumanda ayrıldı: {n}'], ['pad.title', 'Fiziksel kumanda'],
  ['pad.profile_std', 'Standart eşleme'], ['pad.profile_rc', 'RC verici / diğer'], ['pad.dead', 'Ölü bölge'], ['pad.inv', 'Ters'],
  ['pad.axis_thr', 'Gaz'], ['pad.axis_yaw', 'Sapma (yaw)'], ['pad.axis_pitch', 'Yunuslama (pitch)'], ['pad.axis_roll', 'Yatış (roll)'],
  ['pad.act_arm', 'ARM'], ['pad.act_disarm', 'DISARM'], ['pad.act_mode_next', 'Sonraki mod'], ['pad.act_mode_prev', 'Önceki mod'],
  ['pad.act_ch5_up', 'Mod kanalı (ch5) +'], ['pad.act_ch5_down', 'Mod kanalı (ch5) −'], ['pad.none', '—'], ['pad.axis_n', 'Eksen {n}'], ['pad.button_n', 'Düğme {n}'],
  ['pad.axes', 'Eksenler'], ['pad.buttons', 'Düğmeler'], ['pad.reset', 'Varsayılana dön'], ['pad.close', 'Kapat'],
  ['pad.hint', 'Mode 2: sol çubuk gaz / sapma, sağ çubuk yunuslama / yatış. Kollar nötr dışındayken kumanda önceliklidir; dokunulan sanal çubuk o tarafta kazanır.'],
];
const TXT = Object.fromEntries(PAD_TEXTS);
const fill = (s, p) => (p ? String(s).replace(/\{(\w+)\}/g, (m, k) => (p[k] != null ? String(p[k]) : m)) : String(s));
/** HEPGO (keyed=false): Türkçe metin anahtar; SIMUMAV (keyed=true): `pad.*` anahtarı, yoksa Türkçe. */
export const makePadT = (tr, keyed = false) => (k, p) => {
  const tx = TXT[k] ?? k;
  if (!tr) return fill(tx, p);
  if (!keyed) return tr(tx, p);
  const r = tr(k, p);
  return r && r !== k ? r : fill(tx, p);
};

// ---------------------------------------------------------------- DOM ----------------------------------------------------------------
function el(tag, attrs, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') e.className = v; else if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2), v); else e.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat(Infinity)) if (c != null && c !== false) e.append(c.nodeType ? c : document.createTextNode(String(c)));
  return e;
}
const PAD_ICON_SVG = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 8h12a4 4 0 0 1 4 4v1.5a3.5 3.5 0 0 1-6.3 2.1L14.5 14h-5l-1.2 1.6A3.5 3.5 0 0 1 2 13.5V12a4 4 0 0 1 4-4z"/><path d="M7 11v3M5.5 12.5h3"/><circle cx="16" cy="11.5" r=".6"/><circle cx="18" cy="13.5" r=".6"/></svg>';
const CSS = `
.fs-pad{position:relative;display:inline-flex}
.fs-pad[hidden]{display:none}
.fs-pad-btn{display:inline-flex;align-items:center;gap:6px;font-weight:700}
.fs-pad-btn.act svg{color:#4ade80;filter:drop-shadow(0 0 4px rgba(74,222,128,.7))}
.fs-pad-pop{position:absolute;bottom:calc(100% + 10px);right:0;z-index:40;width:min(360px,calc(100vw - 16px));max-height:min(70vh,560px);overflow:auto;padding:10px 12px 12px;border-radius:12px;
  background:rgba(14,20,30,.97);color:#e6edf3;border:1px solid rgba(255,255,255,.14);box-shadow:0 18px 44px rgba(0,0,0,.55);font-size:12px;display:grid;gap:8px}
.fs-pad-pop[hidden]{display:none}
.fs-pad-pop h6{margin:0;display:flex;align-items:center;gap:8px;font:800 10.5px/1 ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.1em;text-transform:uppercase;opacity:.85}
.fs-pad-pop h6 span{flex:1}
.fs-pad-pop .fs-pad-x{border:0;background:transparent;color:inherit;opacity:.7;cursor:pointer;font-size:16px;line-height:1}
.fs-pad-name{font-size:11px;opacity:.75;word-break:break-word}
.fs-pad-sec{font:700 10px/1 system-ui,sans-serif;letter-spacing:.1em;text-transform:uppercase;opacity:.6;margin-top:2px}
.fs-pad-row{display:grid;grid-template-columns:110px 1fr auto;align-items:center;gap:8px}
.fs-pad-row>span{opacity:.8}
.fs-pad-pop select{height:28px;border-radius:7px;border:1px solid rgba(255,255,255,.14);background:rgba(255,255,255,.07);color:#e6edf3;font:600 12px system-ui,sans-serif;padding:0 6px;min-width:0}
.fs-pad-pop select option{color:#111}
.fs-pad-pop label.inv{display:inline-flex;align-items:center;gap:4px;font-size:11px;opacity:.85}
.fs-pad-live{grid-column:1/-1;height:4px;border-radius:2px;background:rgba(255,255,255,.1);position:relative;overflow:hidden;margin-top:-4px}
.fs-pad-live i{position:absolute;top:0;bottom:0;left:50%;width:0;background:#38bdf8}
.fs-pad-row.hit>span{color:#4ade80}
.fs-pad-dead{display:flex;align-items:center;gap:8px}.fs-pad-dead input{flex:1;accent-color:#38bdf8}
.fs-pad-pop .fs-pad-reset{justify-self:start;border:1px solid rgba(255,255,255,.2);background:transparent;color:inherit;border-radius:8px;padding:5px 10px;cursor:pointer;font:600 12px system-ui,sans-serif}
.fs-pad-pop small{opacity:.65;line-height:1.35}
.fs-bar:has(.fs-pad-pop:not([hidden])){z-index:9}
`;
function ensureCss() {
  if (typeof document === 'undefined' || document.getElementById('fs-pad-css')) return;
  const s = document.createElement('style'); s.id = 'fs-pad-css'; s.textContent = CSS; document.head.appendChild(s);
}

export function createGamepadCtl({ tr = null, keyed = false, storage = (typeof localStorage !== 'undefined' ? localStorage : null), win = (typeof window !== 'undefined' ? window : null),
  nav = (typeof navigator !== 'undefined' ? navigator : null), btnClass = 'btn sm', onConnect = () => {}, onDisconnect = () => {}, onAction = () => {}, onChange = () => {} } = {}) {
  ensureCss();
  const T = makePadT(tr, keyed);
  let all = loadPadCfg(storage), idx = null, info = null, prevBtns = new Set(), lastAxes = null, lastMoveAt = 0, cur = null, timer = null, disposed = false;
  const list = () => { try { return [...(nav?.getGamepads?.() || [])]; } catch { return []; } };
  const gpNow = () => (idx == null ? null : list()[idx] || null);
  const cfg = () => all[info?.profile || 'standard'];
  // ---------------- arayüz ----------------
  const ico = el('span', { 'aria-hidden': 'true' }); ico.innerHTML = PAD_ICON_SVG;
  const btn = el('button', { class: `${btnClass} fs-pad-btn`, type: 'button', title: T('pad.btn_t'), 'aria-haspopup': 'dialog', onclick: e => { e.stopPropagation(); setOpen(pop.hidden); } }, ico, el('span', null, T('pad.btn')));
  const nameEl = el('div', { class: 'fs-pad-name' });
  const deadIn = el('input', { type: 'range', min: 0, max: 0.3, step: 0.01, 'aria-label': T('pad.dead'), oninput: () => { cfg().dead = Number(deadIn.value); deadOut.textContent = `${Math.round(cfg().dead * 100)}%`; persist(); } });
  const deadOut = el('b', { class: 'mono' });
  const axRows = PAD_AXES.map(k => {
    const sel = el('select', { 'aria-label': T(`pad.axis_${k}`), onchange: () => { cfg().axes[k].i = Number(sel.value); persist(); } });
    const inv = el('input', { type: 'checkbox', onchange: () => { cfg().axes[k].inv = inv.checked; persist(); } });
    const bar = el('i');
    const row = el('div', { class: 'fs-pad-row', 'data-axis': k }, el('span', null, T(`pad.axis_${k}`)), sel, el('label', { class: 'inv' }, inv, T('pad.inv')), el('div', { class: 'fs-pad-live' }, bar));
    return { k, sel, inv, bar, row };
  });
  const btRows = PAD_ACTIONS.map(k => {
    const sel = el('select', { 'aria-label': T(`pad.act_${k}`), onchange: () => { cfg().buttons[k] = Number(sel.value); persist(); } });
    const row = el('div', { class: 'fs-pad-row', 'data-act': k }, el('span', null, T(`pad.act_${k}`)), sel, el('span'));
    return { k, sel, row };
  });
  const pop = el('div', { class: 'fs-pad-pop', role: 'dialog', 'aria-label': T('pad.title'), hidden: true },
    el('h6', null, ico.cloneNode(true), el('span', null, T('pad.title')), el('button', { class: 'fs-pad-x', type: 'button', title: T('pad.close'), 'aria-label': T('pad.close'), onclick: e => { e.stopPropagation(); setOpen(false); } }, '×')),
    nameEl,
    el('div', { class: 'fs-pad-dead' }, el('span', null, T('pad.dead')), deadIn, deadOut),
    el('div', { class: 'fs-pad-sec' }, T('pad.axes')), axRows.map(r => r.row),
    el('div', { class: 'fs-pad-sec' }, T('pad.buttons')), btRows.map(r => r.row),
    el('small', null, T('pad.hint')),
    el('button', { class: 'fs-pad-reset', type: 'button', onclick: e => { e.stopPropagation(); all[info?.profile || 'standard'] = clone(DEFAULT_PAD[info?.profile || 'standard']); persist(); fillForm(); } }, T('pad.reset')));
  const root = el('div', { class: 'fs-pad', hidden: true }, btn, pop);
  pop.addEventListener('click', e => e.stopPropagation());
  function persist() { savePadCfg(storage, all); onChange(); }
  function fillForm() {
    const gp = gpNow(), na = Math.max(gp?.axes?.length || 0, 4), nb = Math.max(gp?.buttons?.length || 0, 1), c = cfg();
    nameEl.textContent = info ? `${info.id} · ${T(info.profile === 'standard' ? 'pad.profile_std' : 'pad.profile_rc')} · ${na} / ${nb}` : '';
    deadIn.value = String(c.dead); deadOut.textContent = `${Math.round(c.dead * 100)}%`;
    for (const r of axRows) {
      r.sel.replaceChildren(el('option', { value: -1 }, T('pad.none')), ...Array.from({ length: na }, (_, i) => el('option', { value: i }, T('pad.axis_n', { n: i }))));
      r.sel.value = String(c.axes[r.k].i); r.inv.checked = !!c.axes[r.k].inv;
    }
    for (const r of btRows) {
      r.sel.replaceChildren(el('option', { value: -1 }, T('pad.none')), ...Array.from({ length: nb }, (_, i) => el('option', { value: i }, T('pad.button_n', { n: i }))));
      r.sel.value = String(c.buttons[r.k]);
    }
  }
  function setOpen(v) { pop.hidden = !v; if (v) fillForm(); }
  const onDoc = e => { if (!pop.hidden && !root.contains(e.target)) setOpen(false); };
  const onEsc = e => { if (e.key === 'Escape' && !pop.hidden) { setOpen(false); e.preventDefault(); e.stopPropagation(); } };
  // ---------------- yoklama (20 Hz, bağlıyken) ----------------
  function poll() {
    if (disposed) return;
    const gp = gpNow();
    if (!gp) { cur = null; return; }
    const c = cfg(), axes = readPadAxes(gp, c), now = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    if (lastAxes && PAD_AXES.some(k => Math.abs((axes[k] ?? 0) - (lastAxes[k] ?? 0)) > 0.02)) lastMoveAt = now;
    lastAxes = axes;
    const active = !padIsNeutral(axes) || now - lastMoveAt < PAD_ACTIVE_MS;
    cur = { active, axes, profile: info?.profile || 'standard' };   // standart gamepad: uçakta gaz kolu yaylı → hız olarak (virtualRC)
    btn.classList.toggle('act', active);
    const { set, down } = padButtonEdges(prevBtns, gp); prevBtns = set;
    for (const a of padActionsFor(c, down)) onAction(a);
    if (!pop.hidden) {
      for (const r of axRows) {
        const v = axes[r.k] ?? 0;
        r.bar.style.left = `${50 + Math.min(0, v) * 50}%`; r.bar.style.width = `${Math.abs(v) * 50}%`;
        r.row.classList.toggle('hit', Math.abs(v) > 0.05);
      }
      for (const r of btRows) r.row.classList.toggle('hit', c.buttons[r.k] >= 0 && set.has(c.buttons[r.k]));
    }
  }
  function attach(gp, announce = true) {
    if (!gp || idx != null) return;
    idx = gp.index; info = { id: String(gp.id || 'Gamepad').replace(/\s*\(.*?Vendor.*?\)\s*/i, ' ').trim(), profile: padProfile(gp), axes: gp.axes?.length || 0, buttons: gp.buttons?.length || 0 };
    prevBtns = new Set((gp.buttons || []).map((b, i) => (pressed(b) ? i : -1)).filter(i => i >= 0));   // bağlanırken basılı düğme eylem saymaz
    lastAxes = null; lastMoveAt = 0;
    root.hidden = false;
    if (!timer) timer = setInterval(poll, 50);
    poll();
    if (announce) onConnect(info);
  }
  function detach() {
    const was = info; idx = null; info = null; cur = null; root.hidden = true; setOpen(false);
    if (timer) { clearInterval(timer); timer = null; }
    if (was) onDisconnect(was);
  }
  const onConn = e => attach(e.gamepad);
  const onDisc = e => { if (e.gamepad?.index === idx) { detach(); const g = list().find(Boolean); if (g) attach(g); } };
  win?.addEventListener?.('gamepadconnected', onConn);
  win?.addEventListener?.('gamepaddisconnected', onDisc);
  if (typeof document !== 'undefined') document.addEventListener('pointerdown', onDoc, true);
  win?.addEventListener?.('keydown', onEsc, true);
  // Sayfa açılmadan takılı kumanda: tarayıcı ilk düğme basımına kadar listede göstermeyebilir (gizlilik) → bağlantı olayı o an gelir
  setTimeout(() => { if (disposed) return; const g0 = list().find(Boolean); if (g0) attach(g0); }, 0);   // çağıran kurulumu bitirsin (onConnect geri çağrısı)
  return {
    el: root,
    state: () => (idx == null ? null : cur),
    get connected() { return idx != null; }, get info() { return info; }, get cfg() { return cfg(); },
    openPanel: () => setOpen(true), closePanel: () => setOpen(false), poll,
    dispose() {
      disposed = true; if (timer) clearInterval(timer);
      win?.removeEventListener?.('gamepadconnected', onConn); win?.removeEventListener?.('gamepaddisconnected', onDisc);
      if (typeof document !== 'undefined') document.removeEventListener('pointerdown', onDoc, true);
      win?.removeEventListener?.('keydown', onEsc, true); root.remove();
    },
  };
}
