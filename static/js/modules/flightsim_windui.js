// Uçuş Simülatörü — rüzgâr göstergesi + rampa yön/açı paneli (HEPGO + SIMUMAV ortak DOM; docs/ucus-simulatoru.md §31.4–§31.6).
// Çeviri: HEPGO (keyed=false) Türkçe metni anahtar verir; SIMUMAV (keyed=true) `wfx.*` anahtarını, yoksa Türkçe (flightsim_fltbar kalıbı).
// • createWindGauge({ tr, keyed, canEdit, onChange(w) → Promise, streaks: { get, set } }) → { el, update({ms, dir, gust, turb, hdg}), dispose }
//   Pusula: kuzey işareti uçağa göre döner (burun yukarı), ok rüzgârın AKIŞ yönü; m/s + geldiği yön (°, 16 yön); baş/yan/kuyruk bileşenleri
//   (kuyruk > 1 m/s ve yan > 6 m/s uyarı rengi); akış çizgileri aç/kapa; canEdit → uçuşta rüzgâr (hız/yön/esinti/türbülans) `wind` komutu.
// • createRampPanel({ tr, keyed, onPreview(aim), onApply(aim) → Promise, getWind() → {ms, dir}, getState() → {armed, altRel, phase} })
//   → { el, open(aim), close(), isOpen, refresh(), dispose } — yön (pusula sürükle / kaydırıcı 0–359°) + açı (10–30°), "Rüzgâra karşı çevir",
//   Uygula (sunucu `launch_aim`; yön değişirse SITL yeniden konuşlandırılır), kalkıştan sonra kilitli.
import { RAMP_LIMITS, WIND_LIMITS, compassName, intoWindHeading, normRampAim, rampEditable, takeoffAdvice, windComponents } from './flightsim_weather.js';

export const WFX_TEXTS = [
  ['wfx.wind', 'Rüzgâr'], ['wfx.head', 'Baş'], ['wfx.tail', 'Kuyruk'], ['wfx.cross', 'Yan'], ['wfx.from_r', 'sağdan'], ['wfx.from_l', 'soldan'], ['wfx.calm', 'Sakin'],
  ['wfx.gust', 'Esinti'], ['wfx.turb', 'Türbülans'], ['wfx.speed', 'Hız'], ['wfx.dir', 'Yön (geldiği)'],
  ['wfx.title', 'Rüzgâr — baş / yan / kuyruk bileşenleri uçağın burnuna göre'], ['wfx.streaks', 'Rüzgâr akış çizgileri (aç/kapa)'],
  ['wfx.edit', 'Rüzgârı değiştir (uçuş sırasında)'], ['wfx.apply', 'Uygula'], ['wfx.cancel', 'Vazgeç'], ['wfx.close', 'Kapat'],
  ['wfx.warn_tail', 'Kuyruk rüzgârı — kalkış/iniş için uygun değil'], ['wfx.warn_cross', 'Güçlü yan rüzgâr'],
  ['wfx.ramp', 'Fırlatma rampası'], ['wfx.az', 'Yön (azimut)'], ['wfx.angle', 'Açı (eğim)'], ['wfx.into_wind', 'Rüzgâra karşı çevir'],
  ['wfx.ramp_note', 'Yön değişikliği SITL\'i aynı ayarlarla yeniden konuşlandırır (~5 sn); açı anında uygulanır.'],
  ['wfx.ramp_locked', 'Rampa yalnız kalkıştan önce (DISARM, yerde) ayarlanır'],
  ['wfx.ramp_wind', 'Rüzgâr {ms} m/s · {dir}° → {comp}'], ['wfx.ramp_hint', 'Rampaya tıklayın: yön ve açı'],
  ['wfx.redeploy', 'Rampa yönü değişti: SITL aynı ayarlarla yeniden konuşlandırılıyor…'],
];
const TXT = Object.fromEntries(WFX_TEXTS);
const fill = (s, p) => (p ? String(s).replace(/\{(\w+)\}/g, (m, k) => (p[k] != null ? String(p[k]) : m)) : String(s));
export const makeWfxT = (tr, keyed = false) => (k, p) => {
  const tx = TXT[k] ?? k;
  if (!tr) return fill(tx, p);
  if (!keyed) return tr(tx, p);
  const r = tr(k, p);
  return r && r !== k ? r : fill(tx, p);
};
// Bileşen metni (saf; testlerde): "Baş 5.2 · Yan 2.9 sağdan" / "Kuyruk 3.0 · …" / "Sakin"
export function componentText(c, T = makeWfxT(null)) {
  if (!c || c.kind === 'calm') return T('wfx.calm');
  const hd = `${T(c.head >= 0 ? 'wfx.head' : 'wfx.tail')} ${Math.abs(c.head).toFixed(1)}`;
  return `${hd} · ${T('wfx.cross')} ${Math.abs(c.cross).toFixed(1)}${Math.abs(c.cross) >= 0.05 ? ` ${T(c.cross >= 0 ? 'wfx.from_r' : 'wfx.from_l')}` : ''}`;
}
// Uyarı düzeyi: kuyruk > 1 m/s → 'tail', yan > 6 m/s → 'cross', yoksa ''
export const windWarn = c => (!c || c.kind === 'calm' ? '' : c.head < -1 ? 'tail' : Math.abs(c.cross) > 6 ? 'cross' : '');

const CSS = `
.fs-windg{position:absolute;left:14px;top:76px;z-index:39;display:flex;gap:8px;align-items:center;padding:6px 8px 6px 6px;border-radius:10px;
  background:rgba(14,20,28,.72);color:#e6edf5;font:12px/1.3 ui-monospace,SFMono-Regular,Menlo,monospace;backdrop-filter:blur(4px);box-shadow:0 4px 16px rgba(0,0,0,.25);user-select:none}
.fs-windg svg{width:58px;height:58px;flex:none}
.fs-windg b{font-size:15px;color:#fff}
.fs-windg .fs-windg-sub{color:#9fb1c4;font-size:11px}
.fs-windg .fs-windg-comp{margin-top:2px;font-size:11px}
.fs-windg .fs-windg-comp.tail{color:#ff8a7a}.fs-windg .fs-windg-comp.cross{color:#ffc35a}
.fs-windg-btns{display:flex;flex-direction:column;gap:4px;margin-left:2px}
.fs-windg-btns button{all:unset;cursor:pointer;width:24px;height:22px;border-radius:6px;text-align:center;background:rgba(255,255,255,.08);color:#cfe0f1;font-size:13px}
.fs-windg-btns button[aria-pressed=true]{background:#2f6fd0;color:#fff}
.fs-windg-btns button:hover{background:rgba(255,255,255,.18)}
.fs-windg-pop{position:absolute;left:0;top:calc(100% + 6px);min-width:250px;padding:10px;border-radius:10px;background:rgba(14,20,28,.94);display:grid;gap:8px}
.fs-windg-pop label{display:grid;grid-template-columns:86px 1fr 46px;gap:6px;align-items:center;font-size:11px;color:#b8c7d6}
.fs-windg-pop input[type=range]{width:100%}
.fs-wfx-row{display:flex;gap:6px;justify-content:flex-end}
.fs-wfx-btn{all:unset;cursor:pointer;padding:5px 10px;border-radius:7px;background:rgba(255,255,255,.1);color:#e6edf5;font:600 12px system-ui,sans-serif}
.fs-wfx-btn.primary{background:#2f6fd0;color:#fff}.fs-wfx-btn[disabled]{opacity:.45;pointer-events:none}
.fs-ramp-ui{position:absolute;left:14px;top:150px;z-index:40;width:290px;padding:12px;border-radius:12px;background:rgba(14,20,28,.92);color:#e6edf5;
  font:12px/1.35 system-ui,sans-serif;box-shadow:0 8px 28px rgba(0,0,0,.35);display:grid;gap:10px}
.fs-ramp-ui[hidden]{display:none}
.fs-ramp-head{display:flex;justify-content:space-between;align-items:center;font-weight:700;font-size:13px}
.fs-ramp-head button{all:unset;cursor:pointer;font-size:16px;color:#9fb1c4;padding:0 4px}
.fs-ramp-grid{display:grid;grid-template-columns:110px 1fr;gap:10px;align-items:center}
.fs-ramp-grid svg{width:110px;height:110px;touch-action:none;cursor:grab}
.fs-ramp-ctl{display:grid;gap:6px}
.fs-ramp-ctl label{display:grid;gap:2px;font-size:11px;color:#b8c7d6}
.fs-ramp-ctl b{font:700 16px ui-monospace,monospace;color:#fff}
.fs-ramp-ctl input[type=range]{width:100%}
.fs-ramp-wind-txt{font-size:11px;color:#9fb1c4}.fs-ramp-wind-txt.tail{color:#ff8a7a}.fs-ramp-wind-txt.cross{color:#ffc35a}
.fs-ramp-note{font-size:11px;color:#8193a6}.fs-ramp-lock{font-size:11px;color:#ffc35a}
@media (max-width:760px){.fs-windg{top:64px;left:8px}.fs-ramp-ui{left:8px;right:8px;width:auto;top:130px}}
`;
let styled = false;
const ensureStyle = () => {
  if (styled || typeof document === 'undefined') return;
  styled = true;
  const st = document.createElement('style'); st.dataset.fs = 'windui'; st.textContent = CSS; document.head.appendChild(st);
};
function el(tag, attrs, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') e.className = v; else if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2), v); else e.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat()) if (c != null && c !== false) e.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return e;
}
const svgEl = (tag, attrs) => { const e = document.createElementNS('http://www.w3.org/2000/svg', tag); for (const [k, v] of Object.entries(attrs || {})) e.setAttribute(k, v); return e; };
const f1 = v => (Number.isFinite(Number(v)) ? Number(v).toFixed(1) : '—');

// ---------- rüzgâr göstergesi ----------
export function createWindGauge({ tr, keyed = false, canEdit = false, onChange = null, streaks = null } = {}) {
  ensureStyle();
  const T = makeWfxT(tr, keyed);
  const svg = svgEl('svg', { viewBox: '-30 -30 60 60' });
  svg.append(svgEl('circle', { r: 27, fill: 'rgba(255,255,255,.04)', stroke: 'rgba(255,255,255,.35)', 'stroke-width': 1.2 }));
  const rose = svgEl('g', {});
  for (let a = 0; a < 360; a += 30) rose.append(svgEl('line', { x1: 0, y1: -27, x2: 0, y2: a % 90 ? -24 : -21, stroke: 'rgba(255,255,255,.5)', 'stroke-width': a % 90 ? 1 : 1.6, transform: `rotate(${a})` }));
  const nTxt = svgEl('text', { x: 0, y: -14, 'text-anchor': 'middle', 'font-size': 8, fill: '#ff7a6b', 'font-weight': 700 }); nTxt.textContent = 'N';
  rose.append(nTxt); svg.append(rose);
  svg.append(svgEl('path', { d: 'M0,-7 L4,5 L0,3 L-4,5 Z', fill: '#cfe0f1', opacity: 0.55 }));   // uçak (burun yukarı)
  const arrow = svgEl('g', {});
  arrow.append(svgEl('line', { x1: 0, y1: -18, x2: 0, y2: 14, stroke: '#4fc3ff', 'stroke-width': 2.6, 'stroke-linecap': 'round' }));
  arrow.append(svgEl('path', { d: 'M0,21 L-6,11 L6,11 Z', fill: '#4fc3ff' }));   // ok ucu: akış yönü (aşağı = ileri yerel +y)
  svg.append(arrow);
  const spd = el('b', null, '—'), sub = el('span', { class: 'fs-windg-sub' }, ''), comp = el('div', { class: 'fs-windg-comp' }, '');
  const btns = el('div', { class: 'fs-windg-btns' });
  let stBtn = null, edBtn = null, pop = null;
  if (streaks) {
    stBtn = el('button', { type: 'button', title: T('wfx.streaks'), 'aria-pressed': String(!!streaks.get?.()) }, '≈');
    stBtn.addEventListener('click', e => { e.stopPropagation(); const v = !streaks.get?.(); streaks.set?.(v); stBtn.setAttribute('aria-pressed', String(v)); });
    btns.append(stBtn);
  }
  const root = el('div', { class: 'fs-windg', title: T('wfx.title') }, svg, el('div', null, el('div', null, spd, ' m/s ', sub), comp), btns);
  let cur = { ms: 0, dir: 0, gust: 0, turb: 0, hdg: 0 };
  if (canEdit && onChange) {
    edBtn = el('button', { type: 'button', title: T('wfx.edit') }, '✎');
    btns.append(edBtn);
    const rows = {};
    const mk = (k, lab, [mn, mx], step, unit) => {
      const out = el('span', null, ''), inp = el('input', { type: 'range', min: mn, max: mx, step });
      inp.addEventListener('input', () => { out.textContent = `${inp.value}${unit}`; });
      rows[k] = { inp, out, unit };
      return el('label', null, el('span', null, lab), inp, out);
    };
    const apply = el('button', { type: 'button', class: 'fs-wfx-btn primary' }, T('wfx.apply'));
    const cancel = el('button', { type: 'button', class: 'fs-wfx-btn' }, T('wfx.cancel'));
    pop = el('div', { class: 'fs-windg-pop', hidden: true },
      mk('ms', T('wfx.speed'), [0, 20], 0.5, ' m/s'), mk('dir', T('wfx.dir'), [0, 359], 1, '°'), mk('gust', T('wfx.gust'), [0, 15], 0.5, ' m/s'), mk('turb', T('wfx.turb'), [0, 6], 0.5, ' m/s'),
      el('div', { class: 'fs-wfx-row' }, cancel, apply));
    pop.addEventListener('click', e => e.stopPropagation());
    root.append(pop);
    const openPop = () => { for (const [k, r] of Object.entries(rows)) { r.inp.value = String(Math.round((cur[k] || 0) * 2) / 2); r.out.textContent = `${r.inp.value}${r.unit}`; } pop.hidden = false; };
    edBtn.addEventListener('click', e => { e.stopPropagation(); if (pop.hidden) openPop(); else pop.hidden = true; });
    cancel.addEventListener('click', () => { pop.hidden = true; });
    apply.addEventListener('click', async () => {
      const w = Object.fromEntries(Object.entries(rows).map(([k, r]) => [k, Number(r.inp.value)]));
      apply.setAttribute('disabled', '');
      try { await onChange(w); pop.hidden = true; } catch { /* çağıran bildirir */ } finally { apply.removeAttribute('disabled'); }
    });
  }
  let drawnAt = 0;
  function update(w = {}) {
    cur = { ...cur, ...Object.fromEntries(Object.entries(w).filter(([, v]) => v != null && Number.isFinite(Number(v))).map(([k, v]) => [k, Number(v)])) };
    const now = typeof performance !== 'undefined' ? performance.now() : 0;
    if (now - drawnAt < 120) return;
    drawnAt = now;
    rose.setAttribute('transform', `rotate(${-cur.hdg})`);
    arrow.setAttribute('transform', `rotate(${cur.dir - cur.hdg})`);   // ok akış yönüne: geliş + 180; yerel ok ucu aşağı (+y) → geliş açısıyla döner
    spd.textContent = f1(cur.ms);
    sub.textContent = `${String(Math.round(((cur.dir % 360) + 360) % 360)).padStart(3, '0')}° ${compassName(cur.dir)}${cur.gust > 0 ? ` · ${T('wfx.gust')} +${f1(cur.gust)}` : ''}`;
    const c = windComponents(cur.ms, cur.dir, cur.hdg);
    comp.textContent = componentText(c, T);
    comp.className = `fs-windg-comp ${windWarn(c)}`;
    comp.title = windWarn(c) === 'tail' ? T('wfx.warn_tail') : windWarn(c) === 'cross' ? T('wfx.warn_cross') : '';
    if (stBtn) stBtn.setAttribute('aria-pressed', String(!!streaks.get?.()));
  }
  return { el: root, update, get state() { return { ...cur }; }, dispose() { root.remove(); } };
}

// ---------- rampa yön/açı paneli ----------
export function createRampPanel({ tr, keyed = false, onPreview = () => {}, onApply = async () => {}, getWind = () => ({ ms: 0, dir: 0 }), getState = () => ({}) } = {}) {
  ensureStyle();
  const T = makeWfxT(tr, keyed);
  let aim = { azimuth_deg: 0, angle_deg: 15 }, base = { ...aim };
  const svg = svgEl('svg', { viewBox: '-55 -55 110 110' });
  svg.append(svgEl('circle', { r: 50, fill: 'rgba(255,255,255,.05)', stroke: 'rgba(255,255,255,.4)', 'stroke-width': 1.5 }));
  for (let a = 0; a < 360; a += 15) svg.append(svgEl('line', { x1: 0, y1: -50, x2: 0, y2: a % 90 ? -46 : -40, stroke: 'rgba(255,255,255,.5)', 'stroke-width': a % 90 ? 1 : 2, transform: `rotate(${a})` }));
  for (const [t, a] of [['N', 0], ['E', 90], ['S', 180], ['W', 270]]) { const x = svgEl('text', { x: Math.sin(a * Math.PI / 180) * 32, y: -Math.cos(a * Math.PI / 180) * 32 + 4, 'text-anchor': 'middle', 'font-size': 10, fill: t === 'N' ? '#ff7a6b' : '#9fb1c4', 'font-weight': 700 }); x.textContent = t; svg.append(x); }
  const windArr = svgEl('g', {});
  windArr.append(svgEl('line', { x1: 0, y1: -50, x2: 0, y2: -30, stroke: '#4fc3ff', 'stroke-width': 3, 'stroke-linecap': 'round' }), svgEl('path', { d: 'M0,-24 L-5,-33 L5,-33 Z', fill: '#4fc3ff' }));
  svg.append(windArr);
  const needle = svgEl('g', {});
  needle.append(svgEl('rect', { x: -4, y: -36, width: 8, height: 40, rx: 2, fill: '#ffb020' }), svgEl('path', { d: 'M0,-46 L-8,-34 L8,-34 Z', fill: '#ffb020' }), svgEl('circle', { r: 5, fill: '#30363d', stroke: '#ffb020', 'stroke-width': 2 }));
  svg.append(needle);
  const azB = el('b', null, ''), anB = el('b', null, '');
  const azIn = el('input', { type: 'range', min: RAMP_LIMITS.azimuth[0], max: RAMP_LIMITS.azimuth[1], step: 1 });
  const anIn = el('input', { type: 'range', min: RAMP_LIMITS.angle[0], max: RAMP_LIMITS.angle[1], step: 0.5 });
  const side = svgEl('svg', { viewBox: '0 0 60 24', width: 60, height: 24 });
  const sideLine = svgEl('line', { x1: 6, y1: 21, x2: 54, y2: 21, stroke: '#ffb020', 'stroke-width': 3, 'stroke-linecap': 'round' });
  side.append(svgEl('line', { x1: 2, y1: 22, x2: 58, y2: 22, stroke: 'rgba(255,255,255,.35)', 'stroke-width': 1 }), sideLine);
  const windTxt = el('div', { class: 'fs-ramp-wind-txt' }, ''), lock = el('div', { class: 'fs-ramp-lock', hidden: true }, T('wfx.ramp_locked'));
  const btnWind = el('button', { type: 'button', class: 'fs-wfx-btn fs-ramp-wind' }, T('wfx.into_wind'));
  const btnApply = el('button', { type: 'button', class: 'fs-wfx-btn primary fs-ramp-apply' }, T('wfx.apply'));
  const btnCancel = el('button', { type: 'button', class: 'fs-wfx-btn' }, T('wfx.cancel'));
  const xBtn = el('button', { type: 'button', title: T('wfx.close') }, '×');
  const root = el('div', { class: 'fs-ramp-ui', hidden: true },
    el('div', { class: 'fs-ramp-head' }, el('span', null, T('wfx.ramp')), xBtn),
    el('div', { class: 'fs-ramp-grid' }, svg, el('div', { class: 'fs-ramp-ctl' },
      el('label', null, el('span', null, T('wfx.az')), azB, azIn), el('label', null, el('span', null, T('wfx.angle')), el('span', null, anB, ' ', side), anIn))),
    windTxt, lock, el('div', { class: 'fs-wfx-row' }, btnWind, btnCancel, btnApply), el('div', { class: 'fs-ramp-note' }, T('wfx.ramp_note')));
  root.addEventListener('pointerdown', e => e.stopPropagation());
  const draw = () => {
    needle.setAttribute('transform', `rotate(${aim.azimuth_deg})`);
    azB.textContent = `${String(aim.azimuth_deg).padStart(3, '0')}° ${compassName(aim.azimuth_deg)}`; anB.textContent = `${aim.angle_deg}°`;
    azIn.value = String(aim.azimuth_deg); anIn.value = String(aim.angle_deg);
    const r = aim.angle_deg * Math.PI / 180; sideLine.setAttribute('x2', String(6 + Math.cos(r) * 48)); sideLine.setAttribute('y2', String(21 - Math.sin(r) * 48));
    const w = getWind() || { ms: 0, dir: 0 }, adv = takeoffAdvice(w.ms, w.dir, aim.azimuth_deg);
    windArr.setAttribute('transform', `rotate(${w.dir})`);
    windTxt.textContent = T('wfx.ramp_wind', { ms: f1(w.ms), dir: Math.round(w.dir), comp: componentText(adv, T) });
    windTxt.className = `fs-ramp-wind-txt ${windWarn(adv)}`;
    const editable = rampEditable(getState() || {});
    lock.hidden = editable;
    for (const b of [azIn, anIn, btnWind, btnApply]) { if (editable) b.removeAttribute('disabled'); else b.setAttribute('disabled', ''); }
    if (aim.azimuth_deg === base.azimuth_deg && aim.angle_deg === base.angle_deg) btnApply.setAttribute('disabled', '');
  };
  const set = (a, preview = true) => { aim = normRampAim({ ...aim, ...a }, aim.azimuth_deg); draw(); if (preview) onPreview({ ...aim }); };
  azIn.addEventListener('input', () => set({ azimuth_deg: Number(azIn.value) }));
  anIn.addEventListener('input', () => set({ angle_deg: Number(anIn.value) }));
  let drag = false;
  const fromPointer = e => { const r = svg.getBoundingClientRect(); const x = e.clientX - (r.left + r.width / 2), y = e.clientY - (r.top + r.height / 2); set({ azimuth_deg: (Math.round(Math.atan2(x, -y) * 180 / Math.PI) + 360) % 360 }); };
  svg.addEventListener('pointerdown', e => { if (!rampEditable(getState() || {})) return; drag = true; svg.setPointerCapture?.(e.pointerId); fromPointer(e); });
  svg.addEventListener('pointermove', e => { if (drag) fromPointer(e); });
  svg.addEventListener('pointerup', () => { drag = false; });
  btnWind.addEventListener('click', () => { const w = getWind() || { dir: 0 }; set({ azimuth_deg: intoWindHeading(w.dir) }); });
  const close = (revert = true) => { if (revert && (aim.azimuth_deg !== base.azimuth_deg || aim.angle_deg !== base.angle_deg)) onPreview({ ...base }); root.hidden = true; };
  xBtn.addEventListener('click', () => close(true)); btnCancel.addEventListener('click', () => close(true));
  btnApply.addEventListener('click', async () => {
    btnApply.setAttribute('disabled', '');
    try { await onApply({ ...aim }); base = { ...aim }; close(false); } catch { draw(); }
  });
  return {
    el: root,
    open(a) { aim = normRampAim(a || aim); base = { ...aim }; root.hidden = false; draw(); },
    close: () => close(true),
    get isOpen() { return !root.hidden; },
    get aim() { return { ...aim }; },
    refresh() { if (!root.hidden) draw(); },
    dispose() { root.remove(); },
  };
}
void WIND_LIMITS;
