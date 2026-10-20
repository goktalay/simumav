// Tam ekran görev tasarım ekranı: harita katmanı (Cesium/Google/düzlemsel) + üstünde çizim canvas'ı + araç şeridi.
// Araçlar: koridor (çizgi + genişlik), serbest (waypoint), ilaçlama (poligon + aralık → hatlar), FPV bayrak (bayrak + sıra),
// tarama (survey poligon), FPV halkaları (parkur halkaları: sıra/tur), YER KONTROLÜNÜ KORU (HEPGO §26: rota yok; zorluk, dalga, interceptor, önleme yarıçapı,
// hazırlık, tohum — tohum kayıtta sabit: aynı görev aynı senaryo). Çıktı `plan`: {kind, route:{points}, shape, params, order, laps} | {kind:'defend', defend}.
import { h, clear, svg } from '../core/dom.js';
import { t } from '../i18n/i18n.js';
import { btn, range, toast, toastErr, TRASH_SVG } from '../ui/components.js';
import { createMapLayer } from './maplayer.js';
import { sweepLines, corridorPolygon, buildRoute, dist } from './geo.js';

export const KINDS = ['corridor', 'free', 'spray', 'fpv_flags', 'survey', 'fpv_gates', 'defend'];
const DEFEND0 = { waves: 5, interceptors: 10, difficulty: 'normal', radius_m: 30, prep_s: 45 };
const DEFEND_LIM = { waves: [1, 10, 1], interceptors: [1, 20, 1], radius_m: [10, 100, 5], prep_s: [15, 300, 5] };
const newSeed = () => Math.floor(Math.random() * 2147483646) + 1;
const ICONS = {
  corridor: '<path fill="none" stroke="currentColor" stroke-width="2" d="M4 18L20 6M4 12l10-8M10 20l10-8"/>',
  free: '<path fill="none" stroke="currentColor" stroke-width="2" d="M4 18l5-9 5 6 6-11"/><circle cx="4" cy="18" r="2" fill="currentColor"/><circle cx="20" cy="4" r="2" fill="currentColor"/>',
  spray: '<path fill="none" stroke="currentColor" stroke-width="2" d="M4 6h16M4 10h16M4 14h16M4 18h16"/>',
  fpv_flags: '<path fill="none" stroke="currentColor" stroke-width="2" d="M6 21V4h10l-2 4 2 4H6"/>',
  survey: '<path fill="none" stroke="currentColor" stroke-width="2" d="M4 4h16v16H4zM8 4v16M12 4v16M16 4v16"/>',
  fpv_gates: '<circle cx="12" cy="12" r="7" fill="none" stroke="currentColor" stroke-width="2.4"/><circle cx="12" cy="12" r="2" fill="currentColor"/>',
  defend: '<path fill="none" stroke="currentColor" stroke-width="2" d="M12 3 4 6v6c0 4.5 3.4 8 8 9 4.6-1 8-4.5 8-9V6z"/><path fill="none" stroke="currentColor" stroke-width="2" d="m9 12 2 2 4-4"/>',
};

export async function openEditor(root, ctx, { track, mission, name, onSave, onCancel }) {
  const plan = mission?.plan ? JSON.parse(JSON.stringify(mission.plan)) : { kind: 'free', shape: [], params: { alt: 50, width: 40, spacing: 20, angle: 0, laps: 1 }, order: [] };
  plan.params = { alt: 50, width: 40, spacing: 20, angle: 0, laps: 1, ...(plan.params || {}) };
  plan.shape = plan.shape || []; plan.order = plan.order || [];
  let kind = mission?.kind || plan.kind || 'free';
  plan.defend = { ...DEFEND0, seed: newSeed(), ...(plan.defend || {}) };   // HEPGO §26
  const home = { lat: track.lat, lon: track.lon };
  const gates = track.gates || [];

  const sc = h('div', { class: 'screen mission-editor' });
  const mapHost = h('div', { class: 'mission-map' });
  const draw = h('canvas', { class: 'plan r2d' });
  const note = h('div', { class: 'map-note' }, t('common.loading'));
  const toolbar = h('div', { class: 'toolbar' });
  const panel = h('div', { class: 'card side-panel' });
  sc.append(mapHost, draw, note, toolbar, panel);
  clear(root, sc);
  ctx.setBack(t('missions.title'), 'missions');

  // ---------- Harita katmanı ----------
  const { layer, errors } = await createMapLayer(mapHost, track, { mapsKey: ctx.state.meta?.maps_key, lang: ctx.t ? undefined : 'tr', status: s => { note.textContent = t(`missions.layer_${s}`); } });
  note.textContent = `${t(`missions.layer_${layer.kind}`)}${errors.length ? ` · ${errors.join(' · ')}` : ''} — ${t('missions.hint_' + kind)}`;
  layer.flyTo(track.lat, track.lon, track.radius_m || 1000);

  // ---------- Çizim ----------
  const g2 = draw.getContext('2d');
  const size = () => { const r = mapHost.getBoundingClientRect(); draw.width = Math.round(r.width * devicePixelRatio); draw.height = Math.round(r.height * devicePixelRatio); draw.style.width = `${r.width}px`; draw.style.height = `${r.height}px`; render(); };
  const ro = new ResizeObserver(size); ro.observe(mapHost);
  const S = p => { const s = layer.toScreen(p.lat, p.lon); return s ? { x: s.x * devicePixelRatio, y: s.y * devicePixelRatio } : null; };
  let hoverIdx = -1;
  function route() {
    const P = plan.params;
    if (kind === 'corridor') { if (plan.shape.length < 2) return null; return buildRoute(home, plan.shape, { alt: P.alt }); }
    if (kind === 'free') return plan.shape.length ? buildRoute(home, plan.shape, { alt: P.alt, altFn: p => p.alt_rel ?? P.alt }) : null;
    if (kind === 'spray' || kind === 'survey') { const lines = sweepLines(home, plan.shape, Math.max(2, P.spacing), P.angle); return lines.length ? buildRoute(home, lines, { alt: kind === 'spray' ? Math.min(P.alt, 15) : P.alt }) : null; }
    if (kind === 'fpv_flags') return plan.shape.length ? buildRoute(home, plan.shape, { alt: P.alt, land: true }) : null;
    if (kind === 'defend') return null;   // rota yok (tehditler tohumdan)
    if (kind === 'fpv_gates') { const ord = (plan.order.length ? plan.order : gates.map(g => g.i)).map(i => gates.find(g => g.i === i)).filter(Boolean); if (!ord.length) return null; const laps = Math.max(1, P.laps | 0); const pts = []; for (let l = 0; l < laps; l++) pts.push(...ord); return buildRoute(home, pts, { alt: P.alt, altFn: p => p.agl_m }); }
    return null;
  }
  function render() {
    const W = draw.width, H = draw.height; g2.clearRect(0, 0, W, H);
    const dpr = devicePixelRatio;
    const r = route();
    // alan / koridor poligonu
    let poly = null;
    if (kind === 'corridor') poly = corridorPolygon(home, plan.shape, plan.params.width);
    else if (kind === 'spray' || kind === 'survey') poly = plan.shape.length > 2 ? plan.shape : null;
    if (poly?.length) { g2.beginPath(); poly.map(S).forEach((s, i) => s && (i ? g2.lineTo(s.x, s.y) : g2.moveTo(s.x, s.y))); g2.closePath(); g2.fillStyle = 'rgba(167,139,250,.18)'; g2.fill(); g2.strokeStyle = '#a78bfa'; g2.lineWidth = 2 * dpr; g2.stroke(); }
    // rota
    if (r) { g2.beginPath(); let first = true; for (const p of r.points) { const s = S(p); if (!s) continue; if (first) { g2.moveTo(s.x, s.y); first = false; } else g2.lineTo(s.x, s.y); } g2.strokeStyle = '#38bdf8'; g2.lineWidth = 3 * dpr; g2.shadowColor = '#38bdf8'; g2.shadowBlur = 10 * dpr; g2.stroke(); g2.shadowBlur = 0; }
    // HEPGO §26 savunma: istasyon (ev yakını) + 1 km / 3 km halkaları
    if (kind === 'defend') {
      const hs0 = S(home);
      if (hs0) {
        const ref = S({ lat: home.lat + 1000 / 110574, lon: home.lon }), pxkm = ref ? Math.abs(hs0.y - ref.y) : 40 * dpr;
        for (const km of [1, 3]) { g2.beginPath(); g2.arc(hs0.x, hs0.y, pxkm * km, 0, Math.PI * 2); g2.strokeStyle = 'rgba(61,255,138,.7)'; g2.setLineDash([6 * dpr, 6 * dpr]); g2.lineWidth = 2 * dpr; g2.stroke(); g2.setLineDash([]); g2.fillStyle = '#3dff8a'; g2.font = `bold ${11 * dpr}px sans-serif`; g2.fillText(`${km} km`, hs0.x + pxkm * km + 4 * dpr, hs0.y); }
        g2.fillStyle = 'rgba(239,68,68,.9)'; g2.beginPath(); g2.arc(hs0.x + 14 * dpr, hs0.y + 10 * dpr, 7 * dpr, 0, Math.PI * 2); g2.fill();
      }
    }
    // ev
    const hs = S(home); if (hs) { g2.beginPath(); g2.arc(hs.x, hs.y, 8 * dpr, 0, Math.PI * 2); g2.fillStyle = '#34d399'; g2.fill(); g2.fillStyle = '#062'; g2.font = `bold ${10 * dpr}px sans-serif`; g2.textAlign = 'center'; g2.textBaseline = 'middle'; g2.fillText('H', hs.x, hs.y); }
    // parkur halkaları
    gates.forEach(g => { const s = S(g); if (!s) return; const on = kind === 'fpv_gates' && (plan.order.length ? plan.order.includes(g.i) : true); g2.beginPath(); g2.arc(s.x, s.y, 11 * dpr, 0, Math.PI * 2); g2.strokeStyle = on ? '#38bdf8' : 'rgba(148,163,184,.5)'; g2.lineWidth = 3 * dpr; g2.stroke(); g2.fillStyle = '#fff'; g2.font = `bold ${10 * dpr}px sans-serif`; g2.textAlign = 'center'; g2.textBaseline = 'middle'; g2.fillText(String(kind === 'fpv_gates' && plan.order.length ? (plan.order.indexOf(g.i) + 1 || '·') : g.i + 1), s.x, s.y); });
    // şekil noktaları (sürüklenebilir)
    plan.shape.forEach((p, i) => { const s = S(p); if (!s) return; g2.beginPath(); g2.arc(s.x, s.y, (i === hoverIdx ? 9 : 6) * dpr, 0, Math.PI * 2); g2.fillStyle = kind === 'fpv_flags' ? '#fbbf24' : '#fff'; g2.fill(); g2.strokeStyle = '#0b1220'; g2.lineWidth = 2 * dpr; g2.stroke(); if (kind === 'fpv_flags' || kind === 'free') { g2.fillStyle = '#fff'; g2.font = `bold ${11 * dpr}px sans-serif`; g2.fillText(String(i + 1), s.x, s.y - 14 * dpr); } });
    updateInfo(r);
  }
  layer.onChange(render);

  // ---------- Girdi ----------
  const pick = e => { const r = draw.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
  const nearIdx = (x, y) => { let best = -1, bd = 14; plan.shape.forEach((p, i) => { const s = layer.toScreen(p.lat, p.lon); if (!s) return; const d = Math.hypot(s.x - x, s.y - y); if (d < bd) { bd = d; best = i; } }); return best; };
  let dragIdx = -1, downAt = null;
  draw.addEventListener('pointerdown', e => {
    if (e.button !== 0 || e.shiftKey) { draw.style.pointerEvents = 'none'; setTimeout(() => { draw.style.pointerEvents = ''; }, 0); return; }
    const { x, y } = pick(e); downAt = { x, y };
    if (kind === 'fpv_gates') return;
    dragIdx = nearIdx(x, y);
    if (dragIdx >= 0) { draw.setPointerCapture(e.pointerId); layer.setInteractive?.(false); }
  });
  draw.addEventListener('pointermove', e => { const { x, y } = pick(e); if (dragIdx >= 0) { const g = layer.fromScreen(x, y); if (g) { plan.shape[dragIdx].lat = g.lat; plan.shape[dragIdx].lon = g.lon; render(); } } else { const ni = nearIdx(x, y); if (ni !== hoverIdx) { hoverIdx = ni; render(); } } });
  draw.addEventListener('pointerup', e => {
    const { x, y } = pick(e);
    if (dragIdx >= 0) { dragIdx = -1; layer.setInteractive?.(true); return; }
    if (!downAt || Math.hypot(downAt.x - x, downAt.y - y) > 5) { downAt = null; return; }
    downAt = null;
    if (kind === 'fpv_gates') { const g = gates.find(gg => { const s = layer.toScreen(gg.lat, gg.lon); return s && Math.hypot(s.x - x, s.y - y) < 16; }); if (g) { const k = plan.order.indexOf(g.i); if (k >= 0) plan.order.splice(k, 1); else plan.order.push(g.i); render(); } return; }
    if (kind === 'defend') return;   // rota çizilmez
    const geo = layer.fromScreen(x, y); if (!geo) return;
    if (dist(home, home, geo) > (track.radius_m || 1000) * 1.05) { toast(t('missions.outside'), 'err'); return; }
    if (plan.shape.length >= 200) { toast(t('missions.too_many'), 'err'); return; }
    plan.shape.push({ lat: geo.lat, lon: geo.lon }); render();
  });
  // Harita arka planı için tekerlek/sürükleme: canvas üstünden geçir (planar/google/cesium kendi dinler) — shift ile kaydır
  draw.addEventListener('wheel', e => { draw.style.pointerEvents = 'none'; const el = document.elementFromPoint(e.clientX, e.clientY); draw.style.pointerEvents = ''; el?.dispatchEvent(new WheelEvent('wheel', e)); e.preventDefault(); }, { passive: false });
  draw.addEventListener('contextmenu', e => { e.preventDefault(); const { x, y } = pick(e); const i = nearIdx(x, y); if (i >= 0) { plan.shape.splice(i, 1); render(); } });
  const onKey = e => { if (e.key === 'Backspace' || e.key === 'Delete') { if (kind === 'fpv_gates') plan.order = []; else plan.shape.pop(); render(); } };
  document.addEventListener('keydown', onKey);

  // ---------- Araç şeridi ----------
  const tools = {};
  const setKind = k => { kind = k; plan.kind = k; for (const [kk, b] of Object.entries(tools)) b.classList.toggle('on', kk === k); note.textContent = t('missions.hint_' + k); renderPanel(); render(); };
  for (const k of KINDS) {
    const fam = x => (['spray', 'survey'].includes(x) ? 'poly' : x === 'fpv_gates' ? 'gates' : 'line');
    const b = h('button', { type: 'button', disabled: k === 'fpv_gates' && !gates.length, title: k === 'fpv_gates' && !gates.length ? t('missions.no_gates') : '', onclick: () => { if (k !== kind && fam(k) !== fam(kind)) plan.shape = []; setKind(k); } }, svg('0 0 24 24', ICONS[k]), t(`kinds.${k}`));
    tools[k] = b; toolbar.append(b);
  }
  toolbar.append(h('button', { type: 'button', class: 'danger', onclick: () => { plan.shape = []; plan.order = []; render(); } }, svg('0 0 24 24', TRASH_SVG), t('common.clear')));

  // ---------- Yan panel ----------
  const info = h('div', { class: 'kv-list' });
  function updateInfo(r) {
    const pts = r?.points || [];
    let len = 0; for (let i = 1; i < pts.length; i++) len += dist(home, pts[i - 1], pts[i]);
    clear(info, h('div', { class: 'kv' }, h('span', {}, t('missions.points')), h('b', {}, pts.length)), h('div', { class: 'kv' }, h('span', {}, t('missions.length')), h('b', {}, len > 1000 ? `${(len / 1000).toFixed(2)} km` : `${Math.round(len)} m`)));
  }
  function renderPanel() {
    const P = plan.params;
    const fld = (key, label, min, max, step, fmt) => { const r = range({ min, max, step, value: P[key], format: fmt, onInput: v => { P[key] = v; render(); } }); return h('div', { class: 'field' }, h('label', {}, label, ' ', r.out), r.inp); };
    const rows = [h('h3', {}, t(`kinds.${kind}`)), h('p', { class: 'sub small' }, t(`kinds.${kind}_desc`))];
    if (kind !== 'spray' && kind !== 'defend') rows.push(fld('alt', t('missions.alt'), 5, 300, 5, v => `${v} m`));
    if (kind === 'corridor') rows.push(fld('width', t('missions.width'), 5, 300, 5, v => `${v} m`));
    if (kind === 'spray') rows.push(fld('spacing', t('missions.spacing'), 2, 50, 1, v => `${v} m`), fld('angle', t('missions.angle'), 0, 179, 1, v => `${v}°`), fld('alt', t('missions.alt'), 2, 15, 1, v => `${v} m`));
    if (kind === 'survey') rows.push(fld('spacing', t('missions.spacing'), 10, 200, 5, v => `${v} m`), fld('angle', t('missions.angle'), 0, 179, 1, v => `${v}°`));
    if (kind === 'fpv_gates') rows.push(fld('laps', t('missions.laps'), 1, 10, 1, v => v), h('p', { class: 'sub small' }, t('missions.gates_order_hint')));
    if (kind === 'defend') {   // HEPGO §26 "Yer kontrolünü koru"
      const D = plan.defend;
      const dfld = (key, label, fmt) => { const [mn, mx, st] = DEFEND_LIM[key]; const r = range({ min: mn, max: mx, step: st, value: D[key], format: fmt, onInput: v => { D[key] = v; } }); return h('div', { class: 'field' }, h('label', {}, label, ' ', r.out), r.inp); };
      const segs = ['easy', 'normal', 'hard'].map(d => btn(t(`site.d_${d}`), () => { D.difficulty = d; renderPanel(); }, D.difficulty === d ? 'primary' : 'ghost'));
      const seed = h('input', { class: 'input', type: 'number', min: 0, max: 2147483647, value: D.seed, onchange: () => { const v = Math.round(Number(seed.value)); D.seed = Number.isInteger(v) && v >= 0 && v <= 2147483647 ? v : newSeed(); seed.value = String(D.seed); } });
      rows.push(h('div', { class: 'field' }, h('label', {}, t('site.difficulty')), h('div', { class: 'btn-row' }, segs)),
        dfld('waves', t('site.waves'), v => v), dfld('interceptors', t('site.interceptors'), v => v), dfld('radius_m', t('site.radius'), v => `${v} m`), dfld('prep_s', t('site.prep'), v => `${v} s`),
        h('div', { class: 'field', title: t('site.seed_hint') }, h('label', {}, t('site.seed')), h('div', { class: 'btn-row' }, seed, btn(t('site.new_seed'), () => { D.seed = newSeed(); seed.value = String(D.seed); }, 'ghost'))),
        h('p', { class: 'sub small' }, t('site.defend_only')));
    }
    rows.push(kind === 'defend' ? null : info, h('div', { class: 'btn-row' }, btn(t('common.cancel'), () => { cleanup(); onCancel?.(); }, 'ghost'), btn(t('common.save'), save, 'primary')));
    clear(panel, rows.filter(Boolean));
  }
  async function save() {
    if (kind === 'defend') {   // HEPGO §26: rota yok; parametreler + sabit tohum
      try { await onSave({ kind, plan: { kind, defend: { ...plan.defend } } }); cleanup(); } catch (e) { toastErr(e); }
      return;
    }
    const r = route();
    if (!r) { toast(t('missions.empty_plan'), 'err'); return; }
    if (r.points.length > 500) { toast(t('missions.too_many'), 'err'); return; }
    const out = { kind, plan: { kind, route: r, shape: kind === 'fpv_gates' ? [] : plan.shape, params: plan.params, order: plan.order, laps: plan.params.laps, gates: kind === 'fpv_gates' ? gates : undefined } };
    try { await onSave(out); cleanup(); } catch (e) { toastErr(e); }
  }
  function cleanup() { ro.disconnect(); document.removeEventListener('keydown', onKey); layer.dispose(); }
  setKind(kind);
  size();
  return cleanup;
}
