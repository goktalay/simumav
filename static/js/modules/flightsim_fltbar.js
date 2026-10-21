// Uçuş Simülatörü — ALT BANT UÇUŞ DENETİMİ (docs/ucus-simulatoru.md §29.6; HEPGO + SIMUMAV ortak): tüm kamera kiplerinden (takip / FPV / gimbal /
// serbest / yer) ve harekât paneli açıkken de erişilen
//   • UÇUŞ MODU seçici: etkin mod düğmede (renkli rozet), tıkla ya da F → açılır mod ızgarası (araç tipine göre liste; VTOL/INTERCEPTOR'da "Sabit kanat"
//     ve "Dikey (Q)" grupları); seçim harekât panelinin kullandığı `mode` komutuyla gider. Açılır listede ok tuşları + Enter, Esc kapatır.
//   • DISARM düğmesi (X): GERÇEKTEKİ GİBİ — sabit kanat havadayken motor KESİLİR (`motor_cut {on:true}`), uçak süzülür, kumanda yüzeyleri
//     çalışmaya devam eder (stabilizasyon + kumanda); düğme "MOTOR VER" olur, sahnede sarı "MOTOR KESİK · SÜZÜLÜYOR" uyarısı. Yerde gerçek DISARM.
//     Kopter (ve askıdaki VTOL/tailsitter) havadayken disarm aracı DÜŞÜRÜR → onay penceresi. Disarm'lıyken düğme ARM.
// Saf katman (node testi tests/test_flightsim_flyui.mjs): FLIGHT_MODES, flightModesFor(kind), modeGroups(kind, modes), modeKind(type), isAirborne(t),
//   disarmAction(kind, t), qMode(mode).
// createFlightBar({ tr, keyed, kind, modes, cmd(name, params) → Promise, confirm(msg) → Promise<bool>|bool, onEvent(text, sev), stage }) →
//   { el, update(tele), openModes(), act(), dispose() }

export const FLIGHT_MODES = {
  plane: ['MANUAL', 'STABILIZE', 'ACRO', 'FBWA', 'FBWB', 'CRUISE', 'TAKEOFF', 'AUTO', 'LOITER', 'CIRCLE', 'GUIDED', 'RTL'],
  vtol: ['MANUAL', 'FBWA', 'FBWB', 'CRUISE', 'TAKEOFF', 'AUTO', 'LOITER', 'CIRCLE', 'GUIDED', 'RTL', 'QSTABILIZE', 'QHOVER', 'QLOITER', 'QACRO', 'QLAND', 'QRTL'],
  icept: ['FBWA', 'FBWB', 'CRUISE', 'AUTO', 'LOITER', 'GUIDED', 'RTL', 'QSTABILIZE', 'QHOVER', 'QLOITER', 'QLAND', 'QRTL'],
  copter: ['STABILIZE', 'ALT_HOLD', 'LOITER', 'POSHOLD', 'ACRO', 'GUIDED', 'AUTO', 'BRAKE', 'CIRCLE', 'RTL', 'SMART_RTL', 'LAND'],
  rover: ['MANUAL', 'ACRO', 'STEERING', 'HOLD', 'LOITER', 'FOLLOW', 'SIMPLE', 'AUTO', 'RTL', 'SMART_RTL', 'GUIDED'],   // §31 ArduRover (flightsim_rover ROVER_MODES)
};
/** Oturum tipi → aile: 'plane' | 'vtol' | 'icept' | 'copter' | 'rover'. */
export function modeKind(type) {
  const t = String(type || '');
  if (t === 'rover') return 'rover';
  if (t === 'interceptor') return 'icept';
  if (t === 'vtol') return 'vtol';
  if (/sabit|plane|delta|caymaz|talon|wing/i.test(t)) return 'plane';
  return 'copter';
}
export const flightModesFor = kind => FLIGHT_MODES[kind] || FLIGHT_MODES.copter;
/** VTOL dikey kipi mi (QSTABILIZE, QHOVER…; GUIDED/AUTO hariç). */
export const qMode = m => /^Q[A-Z]/.test(String(m || ''));
/** Açılır liste grupları: VTOL/INTERCEPTOR → [['fw', sabit kanat kipleri], ['q', Q kipleri]]; diğerleri tek grup. */
export function modeGroups(kind, modes = flightModesFor(kind)) {
  if (kind !== 'vtol' && kind !== 'icept') return [['all', [...modes]]];
  return [['fw', modes.filter(m => !qMode(m))], ['q', modes.filter(qMode)]];
}
/** Havada mı: yere göre irtifa > 3 m ya da hız > 6 m/s (rampada/pistte armed ama hareketsiz → yerde). Kara aracı (§31) hiçbir zaman havada değildir. */
export function isAirborne(t, kind = null) {
  if (!t || kind === 'rover') return false;
  const alt = Number(t.alt_rel ?? t.alt ?? 0), v = Math.max(Number(t.airspeed) || 0, Number(t.groundspeed) || 0);
  return alt > 3 || v > 6;
}
/** DISARM düğmesinin işlevi: 'arm' | 'disarm' | 'motor_cut' | 'motor_restore' | 'confirm_disarm'.
 *  • motor kesikken (armed olsun olmasın) → 'motor_restore' • disarm'lı → 'arm' • yerde → 'disarm'
 *  • havada sabit kanat → 'motor_cut' (süzülme); VTOL/tailsitter yatay uçuş kipinde (Q dışı) → 'motor_cut', askıda (Q kipi) → 'confirm_disarm'
 *  • havada kopter → 'confirm_disarm' (düşer). */
export function disarmAction(kind, t) {
  if (t?.motor_cut) return 'motor_restore';
  if (!t?.armed) return 'arm';
  if (kind === 'rover' || !isAirborne(t)) return 'disarm';   // §31 kara aracı: DISARM her zaman yerde (motorlar durur, araç durur)
  if (kind === 'plane') return 'motor_cut';
  if ((kind === 'vtol' || kind === 'icept') && !qMode(t.mode) && !['QSTABILIZE', 'QHOVER'].includes(String(t.mode || ''))) return 'motor_cut';
  return 'confirm_disarm';
}

export const FLT_TEXTS = [
  ['flt.mode', 'Mod'], ['flt.mode_t', 'Uçuş modu (F): tüm kamera görünümlerinden'], ['flt.g_fw', 'Sabit kanat'], ['flt.g_q', 'Dikey (Q)'],
  ['flt.arm', 'ARM'], ['flt.disarm', 'DISARM'], ['flt.restore', 'MOTOR VER'],
  ['flt.arm_t', 'Motorları arm et (X)'], ['flt.disarm_t', 'DISARM (X) — yerde motorlar durur'],
  ['flt.cut_t', 'DISARM (X) — havada: motor kesilir, uçak SÜZÜLÜR; kumanda yüzeyleri çalışır, kontrol sizde'],
  ['flt.restore_t', 'Motoru geri ver (X)'], ['flt.confirm_t', 'DISARM (X) — havada motorlar durur ve araç DÜŞER (onay istenir)'],
  ['flt.confirm', 'Araç havada. DISARM ile motorlar durur ve araç DÜŞER. Devam edilsin mi?'],
  ['flt.cut_banner', 'MOTOR KESİK · SÜZÜLÜYOR'], ['flt.cut_hint', 'Kumanda sizde — X / MOTOR VER ile motor geri gelir'],
  ['flt.ev_cut', 'Motor kesildi — uçak süzülüyor, kumanda yüzeyleri çalışıyor'], ['flt.ev_restore', 'Motor geri verildi'],
  ['flt.ev_mode', 'Mod isteği: {m}'], ['flt.err', 'Komut başarısız: {e}'],
];
const TXT = Object.fromEntries(FLT_TEXTS);
const fill = (s, p) => (p ? String(s).replace(/\{(\w+)\}/g, (m, k) => (p[k] != null ? String(p[k]) : m)) : String(s));
/** HEPGO (keyed=false) Türkçe metni anahtar verir; SIMUMAV (keyed=true) `flt.*` anahtarını, yoksa Türkçe. */
export const makeFltT = (tr, keyed = false) => (k, p) => {
  const tx = TXT[k] ?? k;
  if (!tr) return fill(tx, p);
  if (!keyed) return tr(tx, p);
  const r = tr(k, p);
  return r && r !== k ? r : fill(tx, p);
};

function el(tag, attrs, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') e.className = v; else if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2), v); else e.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat(Infinity)) if (c != null && c !== false) e.append(c.nodeType ? c : document.createTextNode(String(c)));
  return e;
}
const editable = t => !!t && (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.isContentEditable);
const CSS = `
.fs-flt{display:inline-flex;align-items:center;gap:6px;position:relative}
.fs-flt-mode{display:inline-flex;align-items:center;gap:6px;font-weight:700;letter-spacing:.03em}
.fs-flt-mode b{font:800 11.5px/1 ui-monospace,SFMono-Regular,Menlo,monospace;padding:3px 7px;border-radius:6px;background:#1f6feb;color:#fff;min-width:44px;text-align:center}
.fs-flt-mode b[data-q]{background:#8957e5}.fs-flt-mode b[data-auto]{background:#1a7f37}.fs-flt-mode b[data-rtl]{background:#bf8700}
.fs-flt-mode small{opacity:.7;font-weight:600}
.fs-flt-pop{position:absolute;bottom:calc(100% + 8px);left:0;z-index:40;min-width:260px;max-width:min(92vw,420px);padding:8px;border-radius:12px;background:rgba(14,20,30,.96);color:#e6edf3;
  border:1px solid rgba(255,255,255,.14);box-shadow:0 18px 44px rgba(0,0,0,.55);backdrop-filter:blur(6px)}
.fs-flt-pop[hidden]{display:none}
.fs-flt-pop h6{margin:4px 4px 6px;font:700 10.5px/1 ui-monospace,monospace;letter-spacing:.1em;opacity:.65;text-transform:uppercase}
.fs-flt-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(86px,1fr));gap:5px;margin-bottom:6px}
.fs-flt-grid button{height:30px;border-radius:7px;border:1px solid rgba(255,255,255,.14);background:rgba(255,255,255,.05);color:inherit;font:700 11px/1 ui-monospace,SFMono-Regular,Menlo,monospace;cursor:pointer}
.fs-flt-grid button:hover,.fs-flt-grid button:focus-visible{background:rgba(56,139,253,.25);border-color:rgba(56,139,253,.7);outline:none}
.fs-flt-grid button.on{background:#1f6feb;border-color:#58a6ff;color:#fff}
.fs-flt-grid button.pend{animation:fs-flt-pend .6s ease-in-out infinite alternate}
@keyframes fs-flt-pend{to{background:rgba(56,139,253,.45)}}
.fs-bar .fs-flt-x.cut,.fs-flt-x.cut{background:#d29922;border-color:#d29922;color:#111}
.fs-bar:has(.fs-flt-pop:not([hidden])){z-index:9}
.fs-flt-banner{position:absolute;left:50%;top:64px;transform:translateX(-50%);z-index:8;pointer-events:none;display:flex;flex-direction:column;align-items:center;gap:2px;
  padding:7px 16px;border-radius:10px;background:rgba(40,28,0,.82);border:1px solid rgba(255,196,0,.75);color:#ffd34d;font:800 14px/1.1 ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.08em;box-shadow:0 8px 24px rgba(0,0,0,.45)}
.fs-flt-banner small{font:600 11px/1.2 system-ui,sans-serif;letter-spacing:0;color:#ffe7a3}
.fs-flt-banner[hidden]{display:none}
@media (max-width:900px){.fs-flt-mode small{display:none}}
`;
function ensureCss() {
  if (typeof document === 'undefined' || document.getElementById('fs-flt-css')) return;
  const s = document.createElement('style'); s.id = 'fs-flt-css'; s.textContent = CSS; document.head.appendChild(s);
}

export function createFlightBar({ tr, keyed = false, kind = 'copter', modes = null, cmd, confirm = null, onEvent = () => {}, stage = null, btnClass = 'btn sm' } = {}) {
  ensureCss();
  const T = makeFltT(tr, keyed);
  const list = modes && modes.length ? modes : flightModesFor(kind);
  let tele = null, pending = null, pendAt = 0;
  const modeTxt = el('b', null, '—');
  const modeBtn = el('button', { class: `${btnClass} fs-flt-mode`, type: 'button', title: T('flt.mode_t'), 'aria-haspopup': 'true', onclick: e => { e.stopPropagation(); toggle(); } }, el('small', null, T('flt.mode')), modeTxt, '▾');
  const btns = new Map();
  const grids = modeGroups(kind, list).map(([g, ms]) => {
    const grid = el('div', { class: 'fs-flt-grid' }, ms.map(m => { const b = el('button', { type: 'button', 'data-mode': m, onclick: e => { e.stopPropagation(); pick(m); } }, m); btns.set(m, b); return b; }));
    return [g === 'all' ? null : el('h6', null, T(g === 'q' ? 'flt.g_q' : 'flt.g_fw')), grid];
  });
  const pop = el('div', { class: 'fs-flt-pop', hidden: true, role: 'menu' }, grids);
  const xBtn = el('button', { class: `${btnClass} fs-flt-x`, type: 'button', onclick: e => { e.stopPropagation(); act(); } }, T('flt.arm'));
  const root = el('div', { class: 'pill-group fs-flt' }, modeBtn, xBtn, pop);
  const banner = el('div', { class: 'fs-flt-banner', hidden: true }, el('span', null, T('flt.cut_banner')), el('small', null, T('flt.cut_hint')));
  stage?.append(banner);
  const run = async (name, params) => {
    try { return await cmd(name, params); } catch (e) { onEvent(T('flt.err', { e: e?.message || String(e) }), 'error'); return null; }
  };
  function pick(m) {
    close();
    if (tele?.mode === m) return;
    pending = m; pendAt = performance.now(); paint();
    onEvent(T('flt.ev_mode', { m }), 'info');
    run('mode', { mode: m });
  }
  function toggle(v) { pop.hidden = v == null ? !pop.hidden : !v; if (!pop.hidden) (btns.get(tele?.mode) || btns.values().next().value)?.focus(); }
  const close = () => { pop.hidden = true; };
  async function act() {
    const a = disarmAction(kind, tele);
    if (a === 'arm') return run('arm');
    if (a === 'disarm') return run('disarm');
    if (a === 'motor_cut') { const r = await run('motor_cut', { on: true }); if (r !== null) onEvent(T('flt.ev_cut'), 'warning'); return r; }
    if (a === 'motor_restore') { const r = await run('motor_cut', { on: false }); if (r !== null) onEvent(T('flt.ev_restore'), 'info'); return r; }
    const ok = confirm ? await confirm(T('flt.confirm')) : (typeof window !== 'undefined' && window.confirm ? window.confirm(T('flt.confirm')) : false);
    if (ok) return run('disarm');
    return null;
  }
  function paint() {
    const m = tele?.mode || null;
    if (pending && (m === pending || performance.now() - pendAt > 4000)) pending = null;
    modeTxt.textContent = m || '—';
    modeTxt.toggleAttribute('data-q', qMode(m));
    modeTxt.toggleAttribute('data-auto', m === 'AUTO' || m === 'GUIDED');
    modeTxt.toggleAttribute('data-rtl', /RTL|LAND|HOLD/.test(m || ''));
    for (const [k, b] of btns) { b.classList.toggle('on', k === m); b.classList.toggle('pend', k === pending); }
    const a = disarmAction(kind, tele);
    xBtn.textContent = a === 'arm' ? T('flt.arm') : a === 'motor_restore' ? T('flt.restore') : T('flt.disarm');
    xBtn.title = T({ arm: 'flt.arm_t', disarm: 'flt.disarm_t', motor_cut: 'flt.cut_t', motor_restore: 'flt.restore_t', confirm_disarm: 'flt.confirm_t' }[a]);
    xBtn.classList.toggle('danger', a === 'disarm' || a === 'confirm_disarm' || a === 'motor_cut');
    xBtn.classList.toggle('cut', a === 'motor_restore');
    banner.hidden = !tele?.motor_cut;
  }
  const onKey = e => {
    if (e.ctrlKey || e.metaKey || e.altKey || editable(document.activeElement)) return;
    const k = (e.key || '').toLowerCase();
    if (!pop.hidden) {
      if (e.key === 'Escape') { close(); e.preventDefault(); e.stopPropagation(); return; }
      if (/^Arrow/.test(e.key)) {
        const arr = [...btns.values()], i = Math.max(0, arr.indexOf(document.activeElement)), step = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : -1;
        arr[(i + step + arr.length) % arr.length].focus(); e.preventDefault(); e.stopImmediatePropagation(); return;
      }
    }
    if (k === 'f' && !e.shiftKey) { toggle(); e.preventDefault(); }
    else if (k === 'x' && !e.shiftKey) { act(); e.preventDefault(); }
  };
  const onDoc = e => { if (!pop.hidden && !root.contains(e.target)) close(); };
  if (typeof window !== 'undefined') { window.addEventListener('keydown', onKey, true); document.addEventListener('pointerdown', onDoc); }
  paint();
  return {
    el: root, banner, act, openModes: () => toggle(true), close,
    update(t) { tele = t || null; paint(); },
    get action() { return disarmAction(kind, tele); },
    dispose() { if (typeof window !== 'undefined') { window.removeEventListener('keydown', onKey, true); document.removeEventListener('pointerdown', onDoc); } root.remove(); banner.remove(); },
  };
}
