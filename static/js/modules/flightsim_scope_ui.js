// Uçuş Simülatörü §27 — INTERCEPTOR fırlatıcısı uçuş ARAYÜZÜ (HEPGO flightsim.js + SIMUMAV fly/session.js ortak; DOM, kendi CSS'ini bir kez ekler).
//  • createLauncherUi(stage, {tr, keyed, getSim, launch, session, mount, onFire, onToggle}):
//    – hücre envanteri: launcherInventory(launch, session.defend) → sim.setLauncherInventory (görevde "sıradaki interceptor" ile güncellenir: sync()).
//    – EL FIRLATICISI: "NİŞANGÂH" penceresi (sürüklenebilir; konum fs.scope.pos). Görüntü 3B tuvalinde (sim.setScopeRect — aynı WebGL bağlamı, viewport
//      kopyası; aparatın üstündeki 3B ekranla aynı render hedefi); burada yalnız 2B katman: F-16 tarzı hedef sembolojisi (flightsim_tgthud: prizma, TD kutusu,
//      menzil, ekran dışı ok + sapma açısı), mil-dot artı, azimut şeridi, yükseliş ölçeği, AZ/EL/×zoom okuması.
//      Nişan: pencerede sürükle (fare/dokunmatik), I/K yükseliş · J/L yön (Shift ince), basılı tutulan ◀▲▼▶ düğmeleri (sanal kumanda), tekerlek/Z zoom
//      (×1/2/4/8), ⌖ / H hedefe yönel (kilitli ya da en yakın), G pencere aç/kapa, Tab hedef kilidi (mevcut). "Fırlat" → onFire (konağın kalkış akışı;
//      takeoffExtra() nişanı `cmd takeoff {aim}` gövdesine ekler → interceptor nişan yönünde çıkar).
// Metinler: LAUNCHER_TEXTS [anahtar, Türkçe] — HEPGO Türkçe metni sözlük anahtarı olarak çevirir; SIMUMAV `launcher.*` anahtarları (keyed=true; 7 dil).
import { SCOPE_ZOOMS, aimDrag, aimStep, azTicks, isIceptLauncher, launcherInventory } from './flightsim_launcher.js';
import { drawSymbology, symbology } from './flightsim_tgthud.js';

export const LAUNCHER_TEXTS = [
  ['launcher.scope', 'NİŞANGÂH'], ['launcher.hand', 'El fırlatıcısı'], ['launcher.btn', 'Nişangâh'], ['launcher.btn_title', 'Nişangâh ekranını aç/kapa (G)'],
  ['launcher.fire', 'Fırlat'], ['launcher.fire_title', 'Interceptor\'ı nişan yönünde fırlat'], ['launcher.aim_tgt', 'Hedefe yönel (H)'],
  ['launcher.zoom_in', 'Yakınlaştır (Z / tekerlek)'], ['launcher.zoom_out', 'Uzaklaştır'], ['launcher.close', 'Kapat'],
  ['launcher.hint', 'Sürükle · I/J/K/L · Tab hedef'], ['launcher.no_tgt', 'HEDEF YOK'], ['launcher.tgts', '{n} HEDEF'],
  ['launcher.ready', 'HAZIR'], ['launcher.armed', 'ARM'], ['launcher.away', 'ATEŞLENDİ'],
];
const TXT = Object.fromEntries(LAUNCHER_TEXTS);
const fill = (s, p) => (p ? String(s).replace(/\{(\w+)\}/g, (m, k) => (p[k] != null ? String(p[k]) : m)) : String(s));
export const makeLauncherT = (tr, keyed = false) => (k, p) => {
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
    if (k === 'class') e.className = v; else if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2), v); else if (k === 'html') e.innerHTML = v; else e.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat(Infinity)) if (c != null && c !== false) e.append(c.nodeType ? c : document.createTextNode(String(c)));
  return e;
}
const lsGet = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* yok */ } };
const editable = a => !!a && (a.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName));
const POS_KEY = 'fs.scope.pos', ON_KEY = 'fs.scope.on';
export const SCOPE_ICON = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><circle cx="12" cy="12" r="7.5"/><circle cx="12" cy="12" r="1.3" fill="currentColor"/><path d="M12 1.8v4.5M12 17.7v4.5M1.8 12h4.5M17.7 12h4.5"/></svg>';

const CSS = `
.fs-scope{position:absolute;z-index:9;pointer-events:auto;border-radius:10px;overflow:hidden;border:1px solid rgba(120,255,150,.38);box-shadow:0 12px 34px rgba(0,0,0,.55),inset 0 0 0 1px rgba(0,0,0,.4);background:transparent;user-select:none;touch-action:none}
.fs-scope-hd{display:flex;align-items:center;gap:6px;padding:3px 6px 3px 8px;font:700 11px/1.6 ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.06em;color:#b9ffc4;background:linear-gradient(180deg,rgba(14,34,20,.96),rgba(8,20,12,.96));border-bottom:1px solid rgba(120,255,150,.22);cursor:move}
.fs-scope-hd .t{flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.fs-scope-hd button,.fs-scope-pad button{font:700 11px/1 ui-monospace,Menlo,monospace;color:#d6ffdc;background:rgba(40,80,50,.55);border:1px solid rgba(120,255,150,.3);border-radius:6px;min-width:22px;height:20px;padding:0 5px;cursor:pointer}
.fs-scope-hd button:hover,.fs-scope-pad button:hover{background:rgba(70,140,90,.6)}
.fs-scope-bd{position:relative;cursor:crosshair}
.fs-scope-bd canvas{position:absolute;inset:0;width:100%;height:100%;pointer-events:none}
.fs-scope-ft{display:flex;align-items:center;gap:6px;padding:4px 6px;background:linear-gradient(180deg,rgba(8,20,12,.95),rgba(6,14,9,.97));border-top:1px solid rgba(120,255,150,.18);color:#9fdcaa;font:600 10.5px/1.3 ui-monospace,Menlo,monospace}
.fs-scope-ft .h{flex:1;opacity:.75;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.fs-scope-pad{display:grid;grid-template-columns:repeat(3,24px);grid-template-rows:repeat(2,20px);gap:2px}
.fs-scope-pad button{min-width:24px;padding:0}
.fs-scope-fire{font:800 11.5px/1 system-ui,sans-serif!important;letter-spacing:.04em;color:#fff!important;background:linear-gradient(180deg,#d9432f,#a42718)!important;border:1px solid #ff8a70!important;border-radius:7px!important;height:30px!important;padding:0 12px!important}
.fs-scope-fire:disabled{opacity:.45;cursor:default}
.fs-scope-btn .ico{display:inline-flex;vertical-align:-3px;margin-right:4px}
`;
function ensureCss() { if (typeof document === 'undefined' || document.getElementById('fs-scope-css')) return; document.head.append(el('style', { id: 'fs-scope-css' }, CSS)); }
const scopeSize = W => (W < 900 ? { w: 250, h: 170 } : W < 1280 ? { w: 320, h: 214 } : { w: 380, h: 250 });

export function createLauncherUi(stage, { tr, keyed = false, getSim, launch, session = {}, mount = null, onFire = null, onToggle = () => {}, btnClass = 'btn sm', canWrite = true } = {}) {
  const T = makeLauncherT(tr, keyed);
  const method = launch?.method;
  const ui = { buttons: [], hasScope: false };
  if (!isIceptLauncher(method)) return { ...ui, sync() {}, takeoffExtra: () => ({}), onLaunch() {}, dispose() {}, toggle() {} };
  const sync = () => { const s = getSim(); const inv = launcherInventory(launch, session.defend ? { config: session.defend.config, state: session.defend.state } : null); if (s && inv) s.setLauncherInventory?.(inv); };
  if (method !== 'handheld') return { ...ui, sync, takeoffExtra: () => ({}), onLaunch() {}, dispose() {}, toggle() {} };
  // ---------- el fırlatıcısı: nişangâh penceresi ----------
  ensureCss();
  ui.hasScope = true;
  let phase = launch.phase || null;
  const title = el('span', { class: 't' }, `${T('launcher.scope')} · ${T('launcher.hand')}`);
  const zOut = el('button', { type: 'button', title: T('launcher.zoom_out'), onclick: e => { e.stopPropagation(); zoomStep(-1); } }, '−');
  const zLbl = el('span', null, '×1');
  const zIn = el('button', { type: 'button', title: T('launcher.zoom_in'), onclick: e => { e.stopPropagation(); zoomStep(1); } }, '+');
  const tgtB = el('button', { type: 'button', title: T('launcher.aim_tgt'), onclick: e => { e.stopPropagation(); aimTarget(); } }, '⌖');
  const close = el('button', { type: 'button', title: T('launcher.close'), onclick: e => { e.stopPropagation(); toggle(false); } }, '×');
  const head = el('div', { class: 'fs-scope-hd' }, el('span', { html: SCOPE_ICON, style: 'display:inline-flex' }), title, zOut, zLbl, zIn, tgtB, close);
  const cv = el('canvas');
  const body = el('div', { class: 'fs-scope-bd' }, cv);
  const held = { az: 0, el: 0 };
  const padBtn = (lbl, k, v, ttl) => {
    const b = el('button', { type: 'button', title: ttl }, lbl);
    const on = e => { e.preventDefault(); e.stopPropagation(); held[k] = v; b.setPointerCapture?.(e.pointerId); };
    const off = () => { if (held[k] === v) held[k] = 0; };
    b.addEventListener('pointerdown', on); b.addEventListener('pointerup', off); b.addEventListener('pointercancel', off); b.addEventListener('lostpointercapture', off);
    return b;
  };
  const pad = el('div', { class: 'fs-scope-pad' }, el('span'), padBtn('▲', 'el', 1, 'I'), el('span'), padBtn('◀', 'az', -1, 'J'), padBtn('▼', 'el', -1, 'K'), padBtn('▶', 'az', 1, 'L'));
  const fire = canWrite && onFire ? el('button', { type: 'button', class: 'fs-scope-fire', title: T('launcher.fire_title'), onclick: e => { e.stopPropagation(); onFire(); } }, '▲ ', T('launcher.fire')) : null;
  const hint = el('span', { class: 'h' }, T('launcher.hint'));
  const foot = el('div', { class: 'fs-scope-ft' }, pad, hint, fire);
  const box = el('div', { class: 'fs-scope' }, head, body, foot);
  stage.append(box);
  const btn = el('button', { class: `${btnClass} fs-scope-btn`, type: 'button', title: T('launcher.btn_title'), onclick: () => toggle() }, el('span', { class: 'ico', html: SCOPE_ICON }), T('launcher.btn'));
  ui.buttons = [btn];
  let on = lsGet(ON_KEY, true) !== false;
  let pos = lsGet(POS_KEY, null);
  let zoom = 1;
  const aimNow = () => getSim()?.getAim?.() || { az: Number(launch.aim_az_deg) || 0, el: Number(launch.aim_el_deg) || 55 };
  const setAim = a => { const r = getSim()?.setAim?.(a.az, a.el); if (r) { launch.aim_az_deg = r.az; launch.aim_el_deg = r.el; } };
  const zoomStep = d => { zoom = getSim()?.getScopeZoom?.() ?? zoom; const i = Math.max(0, Math.min(SCOPE_ZOOMS.length - 1, SCOPE_ZOOMS.indexOf(zoom) + d)); zoom = SCOPE_ZOOMS[i]; getSim()?.setScopeZoom?.(zoom); zLbl.textContent = `×${zoom}`; };
  const aimTarget = () => { const r = getSim()?.aimAtTarget?.(); if (r) { launch.aim_az_deg = r.az; launch.aim_el_deg = r.el; } };
  function toggle(v) { on = v == null ? !on : !!v; lsSet(ON_KEY, on); layout(); onToggle(on); }
  // sürükleme: başlık → pencere taşı; gövde → nişan
  let drag = null;
  head.addEventListener('pointerdown', e => {
    if (e.target.closest('button')) return;
    const r = box.getBoundingClientRect(), m = stage.getBoundingClientRect();
    drag = { kind: 'move', dx: e.clientX - r.left, dy: e.clientY - r.top, m }; head.setPointerCapture(e.pointerId); e.preventDefault();
  });
  head.addEventListener('pointermove', e => {
    if (drag?.kind !== 'move') return;
    const W = stage.clientWidth, H = stage.clientHeight;
    pos = { x: Math.max(4, Math.min(W - box.offsetWidth - 4, e.clientX - drag.m.left - drag.dx)), y: Math.max(48, Math.min(H - box.offsetHeight - 4, e.clientY - drag.m.top - drag.dy)) };
    place();
  });
  head.addEventListener('pointerup', () => { if (drag?.kind === 'move') { lsSet(POS_KEY, pos); drag = null; syncRect(true); } });
  body.addEventListener('pointerdown', e => { drag = { kind: 'aim', x: e.clientX, y: e.clientY }; body.setPointerCapture(e.pointerId); e.preventDefault(); });
  body.addEventListener('pointermove', e => {
    if (drag?.kind !== 'aim') return;
    const s = getSim(), fov = s?.scopeHud?.()?.fov || 40;
    setAim(aimDrag(aimNow(), e.clientX - drag.x, e.clientY - drag.y, body.clientHeight, fov));   // fare-bakış: sağa sürükle → sağa, yukarı → yukarı
    drag.x = e.clientX; drag.y = e.clientY;
  });
  const endAim = () => { if (drag?.kind === 'aim') drag = null; };
  body.addEventListener('pointerup', endAim); body.addEventListener('pointercancel', endAim);
  body.addEventListener('wheel', e => { e.preventDefault(); zoomStep(e.deltaY < 0 ? 1 : -1); }, { passive: false });
  body.addEventListener('dblclick', e => { e.preventDefault(); aimTarget(); });
  // klavye
  const keys = new Set();
  const onKey = e => {
    if (e.ctrlKey || e.metaKey || e.altKey || editable(document.activeElement)) return;
    const k = (e.key || '').toLowerCase();
    if (k === 'g') { toggle(); e.preventDefault(); return; }
    if (k === 'shift') { keys.add('shift'); return; }
    if (!on) return;
    if ('ijkl'.includes(k) && k.length === 1) { keys.add(k); e.preventDefault(); }
    else if (k === 'z') { zoomStep(e.shiftKey ? -1 : (zoom === SCOPE_ZOOMS[SCOPE_ZOOMS.length - 1] ? -9 : 1)); e.preventDefault(); }
    else if (k === 'h') { aimTarget(); e.preventDefault(); }
  };
  const onKeyUp = e => { keys.delete((e.key || '').toLowerCase()); };
  window.addEventListener('keydown', onKey); window.addEventListener('keyup', onKeyUp);
  const onBlur = () => { keys.clear(); held.az = held.el = 0; };
  window.addEventListener('blur', onBlur);
  // yerleşim
  function place() {
    const W = stage.clientWidth || 1200, H = stage.clientHeight || 800, sz = scopeSize(W);
    box.style.width = `${sz.w}px`; body.style.height = `${sz.h}px`;
    const bw = sz.w, bh = sz.h + 62;
    const p = pos || { x: 12, y: Math.max(64, Math.min(286, H - bh - 96)) };   // varsayılan: sol, küçük hedef radarının altı (alt kadranlar/PiP ile çakışmasın)
    box.style.left = `${Math.max(4, Math.min(W - bw - 4, p.x))}px`; box.style.top = `${Math.max(48, Math.min(H - bh - 4, p.y))}px`;
  }
  let lastKey = '';
  const rectOf = () => { const m = (mount || stage).getBoundingClientRect(), r = body.getBoundingClientRect(); return { x: r.left - m.left, y: r.top - m.top, w: r.width, h: r.height }; };
  function syncRect(force = false) {
    const s = getSim(); if (!s) return;
    const r = on ? rectOf() : null, key = JSON.stringify(r);
    if (force || key !== lastKey) { lastKey = key; s.setScopeRect?.(r); }
  }
  function layout() { box.hidden = !on; btn.classList.toggle('primary', on); place(); syncRect(true); }
  // 2B katman
  const C = '#8dff9a';
  function draw() {
    if (!on) return;
    const s = getSim(), d = s?.scopeHud?.() || null, dpr = Math.min(devicePixelRatio || 1, 2);
    const W = body.clientWidth, H = body.clientHeight;
    if (cv.width !== Math.round(W * dpr) || cv.height !== Math.round(H * dpr)) { cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr); }
    const g = cv.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, W, H);
    const a = aimNow(), cx = W / 2, cy = H / 2, fov = d?.fov || 40;
    zoom = d?.zoom ?? zoom; if (zLbl.textContent !== `×${zoom}`) zLbl.textContent = `×${zoom}`;   // 3B tarafındaki zoom (dışarıdan da değişebilir)
    const txt = (t, x, y, { al = 'left', px = 11, c = C, bold = true } = {}) => { g.font = `${bold ? 700 : 500} ${px}px ui-monospace,SFMono-Regular,Menlo,monospace`; g.textAlign = al; g.textBaseline = 'middle'; g.lineWidth = 3; g.strokeStyle = 'rgba(0,0,0,.8)'; g.strokeText(t, x, y); g.fillStyle = c; g.fillText(t, x, y); };
    // vinyet çerçeve köşeleri
    g.strokeStyle = C; g.globalAlpha = 0.85; g.lineWidth = 1.5;
    for (const [x, y, dx, dy] of [[7, 7, 1, 1], [W - 7, 7, -1, 1], [7, H - 7, 1, -1], [W - 7, H - 7, -1, -1]]) { g.beginPath(); g.moveTo(x, y + dy * 14); g.lineTo(x, y); g.lineTo(x + dx * 14, y); g.stroke(); }
    g.globalAlpha = 1;
    // azimut şeridi (üst)
    const ticks = azTicks(a.az, fov, W / Math.max(1, H), 10);
    g.lineWidth = 1.2; g.strokeStyle = C;
    for (const t of ticks) { const x = t.x * W; if (x < 30 || x > W - 30) continue; g.beginPath(); g.moveTo(x, 14); g.lineTo(x, t.deg % 30 === 0 ? 22 : 18); g.stroke(); if (t.deg % 30 === 0) txt(t.deg === 0 ? 'N' : t.deg === 90 ? 'E' : t.deg === 180 ? 'S' : t.deg === 270 ? 'W' : String(t.deg).padStart(3, '0'), x, 30, { al: 'center', px: 9.5 }); }
    g.beginPath(); g.moveTo(cx - 5, 8); g.lineTo(cx + 5, 8); g.lineTo(cx, 14); g.closePath(); g.fillStyle = C; g.fill();
    // yükseliş ölçeği (sol): her 10°
    const pxDeg = H / fov;
    for (let e = Math.ceil((a.el - fov / 2) / 5) * 5; e <= a.el + fov / 2; e += 5) {
      const y = cy - (e - a.el) * pxDeg; if (y < 40 || y > H - 22) continue;
      g.beginPath(); g.moveTo(10, y); g.lineTo(e % 10 === 0 ? 22 : 16, y); g.stroke();
      if (e % 10 === 0) txt(`${e}`, 26, y, { px: 9 });
    }
    // hedef sembolojisi
    if (d?.items?.length) drawSymbology(g, symbology(d, W, H, { S: 0.9, inset: { l: 34, r: 30, t: 44, b: 30 } }), { color: C, S: 0.9, F: 11, W, H, tr: x => x });
    // mil-dot artı
    g.strokeStyle = C; g.lineWidth = 1.4;
    g.beginPath(); g.moveTo(cx - 34, cy); g.lineTo(cx - 6, cy); g.moveTo(cx + 6, cy); g.lineTo(cx + 34, cy); g.moveTo(cx, cy + 6); g.lineTo(cx, cy + 30); g.stroke();
    for (const k of [-24, -14, 14, 24]) { g.beginPath(); g.arc(cx + k, cy, 1.4, 0, Math.PI * 2); g.fillStyle = C; g.fill(); }
    g.beginPath(); g.arc(cx, cy, 2, 0, Math.PI * 2); g.stroke();
    // okumalar
    txt(`AZ ${String(Math.round(a.az) % 360).padStart(3, '0')}°  EL ${Math.round(a.el)}°  ×${zoom}`, W - 10, H - 12, { al: 'right', px: 11 });
    const n = d?.items?.length || 0;
    txt(n ? T('launcher.tgts', { n }) : T('launcher.no_tgt'), 34, H - 12, { px: 10.5, c: n ? '#ffd27a' : 'rgba(170,255,190,.7)' });
    const st = phase === 'launch' || phase === 'released' || phase === 'free' ? T('launcher.away') : phase === 'armed' ? T('launcher.armed') : T('launcher.ready');
    txt(st, W - 10, 46, { al: 'right', px: 10.5, c: phase && phase !== 'idle' ? '#ffb37a' : '#9dffad' });
  }
  let lastT = performance.now();
  const tick = setInterval(() => {
    const now = performance.now(), dt = Math.min(0.2, (now - lastT) / 1000); lastT = now;
    const inp = { az: held.az + (keys.has('l') ? 1 : 0) - (keys.has('j') ? 1 : 0), el: held.el + (keys.has('i') ? 1 : 0) - (keys.has('k') ? 1 : 0) };
    if (on && (inp.az || inp.el)) setAim(aimStep(aimNow(), inp, dt, keys.has('shift')));
    syncRect(); draw();
    if (fire) fire.disabled = !!(phase && phase !== 'idle');
  }, 50);
  const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(() => layout()) : null;
  ro?.observe(stage);
  layout();
  return {
    ...ui, el: box, sync: () => { sync(); syncRect(true); }, toggle, get on() { return on; },
    overlay: () => { if (!on || box.hidden) return null; const r = rectOf(); return { canvas: cv, ...r }; },   // §17 ekran kaydı birleşimi (2B semboloji katmanı)
    takeoffExtra: () => { const a = aimNow(); return { aim: { az_deg: Math.round(a.az * 10) / 10, el_deg: Math.round(a.el * 10) / 10 } }; },
    onLaunch: m => { phase = m?.phase || null; if (m?.aim_az_deg != null && m?.aim_el_deg != null) setAim({ az: m.aim_az_deg, el: m.aim_el_deg }); },
    reset: () => { phase = null; },
    dispose() { clearInterval(tick); ro?.disconnect(); window.removeEventListener('keydown', onKey); window.removeEventListener('keyup', onKeyUp); window.removeEventListener('blur', onBlur); box.remove(); getSim()?.setScopeRect?.(null); },
  };
}
