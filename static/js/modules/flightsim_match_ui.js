// Uçuş Simülatörü §33 — ÇOK OYUNCULU KARŞILAŞMA arayüzü (HEPGO): sihirbaz "Halkalar" ve "Davet et" bölümleri, bekleme salonu sayfası
// (#/drone/sim/match/<id>), oturum ekranındaki karşılaşma katmanı (durum şeridi, canlı sıralama, 3B halkalar + diğer oyuncular, senkron geri sayım,
// sonuç ekranı) ve "Karşılaşmalar" sekmesi. Saf kısım flightsim_match.js; 3B flightsim_match3d.js; sunucu app/flightsim_match*.py.
import { api } from '../api.js';
import { clear, confirmDialog, fmtDateTime, h, onLeave, toast, toastError, t as tr } from '../ui.js';
import { numSlider } from './fs_inputs.js';
import { hepgoSound } from './flightsim_intro.js';
import { createMatchLayer } from './flightsim_match3d.js';
import { ACTIVE, MATCH_LIMITS, REASON_TEXT, STATE_TEXT, STATUS_TEXT, STATUS_TONE, arrowFor, bearingDeg, colorFor, countdownPhase, createClock, fmtClock, fmtDist,
  inviteAdd, inviteError, inviteRemove, liveStandings, lobbyCounts, matchHref, partitionInvite, relAngle, ringDefaults, ringsError, ringsSummary, ringsViewBox, sessionHref } from './flightsim_match.js';

const API = '/api/drone/sim/matches';
export const matchApi = {
  meta: () => api.get(`${API}/meta`),
  list: () => api.get(API),
  get: id => api.get(`${API}/${encodeURIComponent(id)}`),
  create: body => api.post(API, body),
  preview: body => api.post(`${API}/rings-preview`, body),
  join: id => api.post(`${API}/${encodeURIComponent(id)}/join`, {}),
  leave: id => api.post(`${API}/${encodeURIComponent(id)}/leave`, {}),
  kick: (id, uid) => api.post(`${API}/${encodeURIComponent(id)}/kick`, { user_id: uid }),
  start: id => api.post(`${API}/${encodeURIComponent(id)}/start`, {}),
  cancel: id => api.post(`${API}/${encodeURIComponent(id)}/cancel`, {}),
};
const TYPE_NAME = { multirotor: 'Multikopter', hexarotor: 'Hexakopter', helikopter: 'Helikopter', sabit_kanat: 'Sabit Kanat', vtol: 'VTOL', interceptor: 'INTERCEPTOR' };

// ---------------------------------------------------------------- CSS
let cssDone = false;
export function ensureMatchCss() {
  if (cssDone || typeof document === 'undefined') return;
  cssDone = true;
  const st = document.createElement('style');
  st.dataset.fs = 'match';
  st.textContent = `
.fs-mt-rings{display:grid;grid-template-columns:minmax(0,1fr) minmax(220px,300px);gap:16px;align-items:start}
.fs-mt-rings .fs-mt-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(210px,1fr));gap:4px 16px}
.fs-mt-map{border:1px solid var(--border);border-radius:12px;background:var(--bg-soft,rgba(127,127,127,.06));padding:8px}
.fs-mt-map svg{width:100%;height:auto;display:block}
.fs-mt-map .small{display:block;margin-top:4px}
.fs-mt-seed{display:flex;gap:8px;align-items:center;margin-top:6px}
@media (max-width:760px){.fs-mt-rings{grid-template-columns:1fr}}
.fs-mt-inv{display:grid;grid-template-columns:minmax(0,1fr) auto minmax(0,1fr);gap:10px;align-items:stretch}
.fs-mt-col{border:1px solid var(--border);border-radius:12px;display:flex;flex-direction:column;min-height:280px;max-height:420px;overflow:hidden;background:var(--card,#fff)}
.fs-mt-col h5{margin:0;padding:8px 12px;border-bottom:1px solid var(--border);display:flex;justify-content:space-between;align-items:center;font-size:13px}
.fs-mt-col.on{outline:2px dashed var(--primary);outline-offset:-3px}
.fs-mt-list{list-style:none;margin:0;padding:4px;overflow:auto;flex:1}
.fs-mt-list li{display:flex;gap:8px;align-items:center;padding:7px 9px;border-radius:9px;cursor:pointer;user-select:none}
.fs-mt-list li:hover{background:rgba(127,127,127,.09)}
.fs-mt-list li.sel{background:color-mix(in srgb,var(--primary) 16%,transparent)}
.fs-mt-list li .av{width:28px;height:28px;border-radius:50%;display:grid;place-items:center;font-weight:700;font-size:12px;color:#fff;flex:none}
.fs-mt-list li .nm{display:flex;flex-direction:column;min-width:0}
.fs-mt-list li .nm small{color:var(--muted)}
.fs-mt-list .empty{padding:18px;text-align:center;color:var(--muted);font-size:13px;cursor:default}
.fs-mt-mid{display:flex;flex-direction:column;justify-content:center;gap:8px}
.fs-mt-mid .btn{min-width:44px}
.fs-mt-invq{margin-bottom:8px}
@media (max-width:760px){.fs-mt-inv{grid-template-columns:1fr}.fs-mt-mid{flex-direction:row;justify-content:center}.fs-mt-mid .btn{transform:rotate(90deg)}}
.fs-mt-page{display:grid;grid-template-columns:minmax(0,1.3fr) minmax(0,1fr);gap:16px}
@media (max-width:900px){.fs-mt-page{grid-template-columns:1fr}}
.fs-mt-banner{display:flex;gap:14px;align-items:center;padding:14px 16px;border-radius:14px;margin-bottom:14px;background:linear-gradient(120deg,#0f172a,#1e3a8a);color:#fff}
.fs-mt-banner b{font-size:18px}
.fs-mt-banner .sub{opacity:.85;font-size:13px}
.fs-mt-banner .pulse{width:14px;height:14px;border-radius:50%;background:#22c55e;box-shadow:0 0 0 0 rgba(34,197,94,.7);animation:fsMtPulse 1.6s infinite}
.fs-mt-banner.iptal{background:linear-gradient(120deg,#3f1d1d,#7f1d1d)}.fs-mt-banner.iptal .pulse{background:#f87171;animation:none}
.fs-mt-banner.bitti{background:linear-gradient(120deg,#14532d,#166534)}
@keyframes fsMtPulse{0%{box-shadow:0 0 0 0 rgba(34,197,94,.7)}70%{box-shadow:0 0 0 12px rgba(34,197,94,0)}100%{box-shadow:0 0 0 0 rgba(34,197,94,0)}}
.fs-mt-players{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:6px}
.fs-mt-players li{display:flex;gap:10px;align-items:center;padding:9px 10px;border:1px solid var(--border);border-radius:12px}
.fs-mt-players li .av{width:34px;height:34px;border-radius:50%;display:grid;place-items:center;color:#fff;font-weight:700;position:relative;flex:none}
.fs-mt-players li .av i{position:absolute;right:-2px;bottom:-2px;width:11px;height:11px;border-radius:50%;border:2px solid var(--card,#fff);background:#94a3b8}
.fs-mt-players li .av i.on{background:#22c55e}
.fs-mt-players li .grow{flex:1;min-width:0}
.fs-mt-players li[data-status="davetli"]{border-style:dashed;opacity:.85}
.fs-mt-sum .fs-mt-map{max-width:420px}
.fs-mt-sum dl{display:grid;grid-template-columns:auto 1fr;gap:4px 12px;margin:0;font-size:13px}.fs-mt-sum dt{color:var(--muted)}
.fs-mt-chat{display:flex;flex-direction:column;gap:6px;margin-top:10px}
.fs-mt-chat .log{max-height:180px;overflow:auto;font-size:13px;display:flex;flex-direction:column;gap:3px;border:1px solid var(--border);border-radius:10px;padding:8px;min-height:60px}
.fs-mt-chat form{display:flex;gap:6px}
.fs-mt-res .tw{overflow-x:auto}
.fs-mt-res table{width:100%;border-collapse:collapse;font-size:13.5px}
.fs-mt-res th,.fs-mt-res td{padding:7px 7px;border-bottom:1px solid rgba(127,127,127,.25);text-align:left;white-space:nowrap}
.fs-mt-res .rk{display:inline-grid;place-items:center;width:24px;height:24px;border-radius:50%;font-weight:800;font-size:12px;background:rgba(127,127,127,.18)}
.fs-mt-res .rk1{background:#facc15;color:#422006}.fs-mt-res .rk2{background:#cbd5e1;color:#0f172a}.fs-mt-res .rk3{background:#d97706;color:#fff}
.fs-mt-res td.n{font-variant-numeric:tabular-nums}
.fs-mt-res tr.me td{background:color-mix(in srgb,var(--primary) 12%,transparent)}
.fs-mt-win{display:flex;align-items:center;gap:12px;margin-bottom:12px}
.fs-mt-win .cup{font-size:40px;line-height:1}
.fs-mt-win b{font-size:20px}
.fs-mt-bar{position:absolute;top:58px;left:50%;transform:translateX(-50%);z-index:30;display:flex;gap:10px;align-items:center;padding:8px 16px;border-radius:999px;background:rgba(11,18,32,.82);color:#fff;font:600 15px system-ui,sans-serif;backdrop-filter:blur(6px);box-shadow:0 6px 24px rgba(0,0,0,.35);white-space:nowrap}
.fs-mt-bar .ring{color:#4ade80;font-size:18px}.fs-mt-bar .arr{font-size:20px;color:#4ade80;display:inline-block;transition:transform .2s}
.fs-mt-bar .t{font-variant-numeric:tabular-nums;opacity:.9}
.fs-mt-bar.wait{background:rgba(30,58,138,.88)}
.fs-mt-board{position:absolute;top:224px;left:14px;z-index:29;min-width:210px;max-width:260px;padding:8px 10px;border-radius:12px;background:rgba(11,18,32,.78);color:#fff;font:13px system-ui,sans-serif;backdrop-filter:blur(6px)}
.fs-mt-board h6{margin:0 0 6px;font-size:11px;letter-spacing:.08em;text-transform:uppercase;opacity:.7}
.fs-mt-board ol{margin:0;padding:0;list-style:none;display:flex;flex-direction:column;gap:4px}
.fs-mt-board li{display:flex;gap:7px;align-items:center}
.fs-mt-board li .dot{width:10px;height:10px;border-radius:50%;flex:none}
.fs-mt-board li .nm{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.fs-mt-board li.me .nm{font-weight:700}
.fs-mt-board li .v{font-variant-numeric:tabular-nums;opacity:.9}
.fs-mt-board li.out{opacity:.5}
.fs-mt-wait{position:absolute;inset:0;z-index:31;display:grid;place-items:center;background:rgba(2,6,23,.55);backdrop-filter:blur(2px)}
.fs-mt-wait .box{background:rgba(11,18,32,.92);color:#fff;border-radius:18px;padding:22px 26px;min-width:320px;max-width:92vw;box-shadow:0 20px 60px rgba(0,0,0,.5)}
.fs-mt-wait .box .ttl{margin:0 0 4px;font-size:20px;font-weight:700;color:#fff}
.fs-mt-wait .box .big{font-size:56px;font-weight:800;text-align:center;font-variant-numeric:tabular-nums;margin:6px 0}
.fs-mt-wait ul{list-style:none;margin:10px 0 0;padding:0;display:flex;flex-direction:column;gap:6px}
.fs-mt-wait li{display:flex;gap:8px;align-items:center}
.fs-mt-wait li .dot{width:10px;height:10px;border-radius:50%}
.fs-mt-result{position:absolute;inset:0;z-index:40;display:grid;place-items:center;background:rgba(2,6,23,.62);backdrop-filter:blur(3px)}
.fs-mt-result .box{background:var(--card,#fff);color:var(--text,#111);border-radius:20px;padding:22px 24px;width:min(860px,94vw);max-height:90vh;overflow:auto;box-shadow:0 24px 80px rgba(0,0,0,.55)}
.fs-mt-result .acts{display:flex;gap:8px;justify-content:flex-end;margin-top:14px}
.fs-mt-toast{position:absolute;left:50%;top:104px;transform:translateX(-50%);z-index:32;padding:6px 14px;border-radius:999px;background:rgba(34,197,94,.92);color:#04130a;font:700 15px system-ui,sans-serif;pointer-events:none;transition:opacity .4s}
`;
  document.head.append(st);
}

const DROP_TEXT = { gelmedi: 'Gelmedi', hazirlanamadi: 'Simülatörü zamanında hazır olmadı' };
const initials = n => String(n || '?').trim().split(/\s+/).map(w => w[0]).slice(0, 2).join('').toLocaleUpperCase('tr');
const beep = (f = 1046, dur = 0.12) => {
  const s = hepgoSound();
  if (!s.on || !(s.vol > 0)) return;
  try {
    const AC = window.AudioContext || window.webkitAudioContext; const c = new AC(); const o = c.createOscillator(), g = c.createGain();
    o.frequency.value = f; o.type = 'sine'; g.gain.value = 0.0001; o.connect(g); g.connect(c.destination);
    const t0 = c.currentTime; g.gain.exponentialRampToValueAtTime(0.35 * s.vol, t0 + 0.01); g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    o.start(t0); o.stop(t0 + dur + 0.02); setTimeout(() => c.close().catch(() => {}), (dur + 0.3) * 1000);
  } catch { /* ses yok */ }
};

// ---------------------------------------------------------------- halkaların kuş bakışı + profil (SVG)
export function ringsSvg(rings, { starts = [], me = null } = {}) {
  if (!rings?.length) return '<svg viewBox="0 0 100 100"></svg>';
  const vb = ringsViewBox(rings, starts);
  const alts = rings.map(r => Number(r.agl_m)), lo = Math.min(...alts), hi = Math.max(...alts);
  const col = a => { const t = hi > lo ? (a - lo) / (hi - lo) : 0.5; return `hsl(${Math.round(210 - 200 * t)} 80% 50%)`; };
  const P = (x, y) => vb.toSvg(x, y).map(v => (v * 100).toFixed(2));
  const path = rings.map((r, i) => `${i ? 'L' : 'M'}${P(r.x, r.y).join(' ')}`).join(' ');
  const rr = r => Math.max(2.2, Number(r.radius_m) / vb.size * 100);
  const [cx, cy] = P(0, 0);
  let s = `<svg viewBox="0 0 100 ${100 + 26}" role="img" aria-label="${tr('Parkur')}">`;
  s += `<rect x="0" y="0" width="100" height="100" rx="4" fill="rgba(127,127,127,.06)"/>`;
  s += `<circle cx="${cx}" cy="${cy}" r="1.6" fill="#94a3b8"/><text x="${cx}" y="${Number(cy) - 2.4}" font-size="3.4" text-anchor="middle" fill="#64748b">H</text>`;
  s += `<path d="M${cx} ${cy} L${P(rings[0].x, rings[0].y).join(' ')}" stroke="#94a3b8" stroke-width=".5" stroke-dasharray="1.2 1.2" fill="none"/>`;
  s += `<path d="${path}" stroke="#64748b" stroke-width=".7" stroke-dasharray="2 1.4" fill="none"/>`;
  for (const st of starts) { const [x, y] = P(st.x, st.y); s += `<rect x="${Number(x) - 1.3}" y="${Number(y) - 1.3}" width="2.6" height="2.6" rx=".6" fill="${st.color || '#0ea5e9'}" stroke="${st.id === me ? '#fff' : 'none'}" stroke-width=".5"/>`; }
  for (const r of rings) {
    const [x, y] = P(r.x, r.y), c = col(Number(r.agl_m));
    const nx = Number(r.nx), ny = -Number(r.ny), L = Math.max(4.2, rr(r));   // halka düzlemi (geçiş yönüne dik çizgi)
    s += `<line x1="${(Number(x) - ny * L).toFixed(2)}" y1="${(Number(y) + nx * L).toFixed(2)}" x2="${(Number(x) + ny * L).toFixed(2)}" y2="${(Number(y) - nx * L).toFixed(2)}" stroke="${c}" stroke-width="1.6" stroke-linecap="round"/>`;
    s += `<circle cx="${x}" cy="${y}" r="2.6" fill="${c}"/><text x="${x}" y="${(Number(y) + 1.15).toFixed(2)}" font-size="3.1" font-weight="700" text-anchor="middle" fill="#fff">${r.i}</text>`;
  }
  // profil (yükseklik çubukları)
  const n = rings.length, bw = 96 / n;
  s += `<text x="2" y="104.5" font-size="3" fill="#64748b">${tr('Yükseklik profili')} · ${Math.round(lo)}–${Math.round(hi)} m</text>`;
  rings.forEach((r, i) => { const hgt = 3 + 15 * (hi > lo ? (Number(r.agl_m) - lo) / (hi - lo) : 0.5); s += `<rect x="${(2 + i * bw + bw * 0.12).toFixed(2)}" y="${(124 - hgt).toFixed(2)}" width="${(bw * 0.76).toFixed(2)}" height="${hgt.toFixed(2)}" rx=".6" fill="${col(Number(r.agl_m))}"/>`; });
  return `${s}</svg>`;
}

// ---------------------------------------------------------------- sihirbaz: Halkalar
export function createRingsSection({ getType, getCenter, limits = MATCH_LIMITS, initial = null, onChange = () => {} }) {
  ensureMatchCss();
  let R = { ...ringDefaults(getType(), limits), ...(initial || {}) };
  if (!R.seed) R.seed = Math.floor(Math.random() * 2147483000) + 1;
  let lastType = getType();
  const map = h('div', { class: 'fs-mt-map' }, h('div', { class: 'small muted' }, 'Önizleme hazırlanıyor…'));
  const info = h('span', { class: 'small muted' });
  const sl = {};
  const mk = (key, label, [a, b], step, unit, integer = false) => {
    sl[key] = numSlider({ h, label, value: R[key], min: a, max: b, step, unit, integer, cls: 'fs-slider', onInput: v => { R[key] = v; changed(); } });
    return sl[key].el;
  };
  let tmr = 0, seq = 0, last = null;
  const draw = async () => {
    const c = getCenter();
    const err = ringsError(R, limits);
    if (err) { clear(map, h('div', { class: 'small fs-warn-txt' }, tr(err))); return; }
    if (!c) { clear(map, h('div', { class: 'small muted' }, 'Önce Dünya ve konum adımında bir merkez seçin.')); return; }
    const my = ++seq;
    try {
      const r = await matchApi.preview({ type: getType(), center_id: c.id, rings: R });
      if (my !== seq) return;
      last = r.rings;
      map.innerHTML = ringsSvg(r.rings);
      map.append(h('span', { class: 'small muted' }, tr('{n} halka · merkez: {c} · numaralı sırayla, ok yönünde geçilir', { n: r.rings.length, c: c.name })));
    } catch (err) { if (my === seq) clear(map, h('div', { class: 'small fs-warn-txt' }, err.message)); }
  };
  const changed = () => { clearTimeout(tmr); tmr = setTimeout(draw, 250); onChange(); };
  const seedInp = h('input', { class: 'input mono', value: R.seed, inputmode: 'numeric', style: { width: '130px' }, onchange: () => { R.seed = Math.max(1, Math.floor(Number(seedInp.value)) || 1); seedInp.value = R.seed; changed(); } });
  const L = limits;
  const el = h('div', { class: 'fs-mt-rings' },
    h('div', null,
      h('p', { class: 'small muted' }, 'Havada farklı yüksekliklerde numaralı halkalar kurulur; herkes aynı halkaları 1’den başlayarak sırayla ve ok yönünde geçmeye çalışır. Tüm halkaları ilk bitiren kazanır ve karşılaşma biter.'),
      h('div', { class: 'fs-mt-grid' },
        mk('count', 'Halka sayısı', L.count, 1, '', true),
        mk('min_alt_m', 'Minimum yükseklik', L.alt_m, 1, 'm'),
        mk('max_alt_m', 'Maksimum yükseklik', L.alt_m, 1, 'm'),
        mk('diameter_m', 'Halka çapı', L.diameter_m, 1, 'm'),
        mk('radius_m', 'Parkur yarıçapı', L.radius_m, 10, 'm'),
        mk('time_limit_min', 'Süre sınırı', L.time_limit_min, 1, 'dk', true)),
      h('div', { class: 'fs-mt-seed' }, h('span', { class: 'small muted' }, 'Parkur tohumu'), seedInp,
        h('button', { class: 'btn sm', type: 'button', onclick: () => { R.seed = Math.floor(Math.random() * 2147483000) + 1; seedInp.value = R.seed; changed(); } }, '🎲 Yeni parkur')),
      info),
    map);
  return {
    el,
    values: () => ({ ...R }),
    rings: () => last,
    error: () => ringsError(R, limits),
    refresh: () => {   // tip değişince (dikey ↔ uçak) varsayılanlar
      const t = getType();
      if (typeClass2(t) !== typeClass2(lastType)) { const d = ringDefaults(t, limits); for (const k of ['min_alt_m', 'max_alt_m', 'diameter_m', 'radius_m']) { R[k] = d[k]; sl[k].set(d[k]); } }
      lastType = t; changed();
    },
  };
}
const typeClass2 = t => (t === 'sabit_kanat' ? 'ucak' : 'dikey');

// ---------------------------------------------------------------- sihirbaz: Davet et (solda davet edilmeyenler, sağda edilenler)
export function createInviteSection({ users = [], limits = MATCH_LIMITS, onChange = () => {} }) {
  ensureMatchCss();
  let invited = new Set(), q = '';
  const max = (limits.players_max || 8) - 1;
  const selL = new Set(), selR = new Set();
  const listL = h('ul', { class: 'fs-mt-list', role: 'listbox', 'aria-multiselectable': 'true', 'data-side': 'left' });
  const listR = h('ul', { class: 'fs-mt-list', role: 'listbox', 'aria-multiselectable': 'true', 'data-side': 'right' });
  const cntL = h('span', { class: 'badge gray' }), cntR = h('span', { class: 'badge blue' });
  const colL = h('div', { class: 'fs-mt-col', 'data-side': 'left' }, h('h5', null, h('span', null, 'Davet edilmeyenler'), cntL), listL);
  const colR = h('div', { class: 'fs-mt-col', 'data-side': 'right' }, h('h5', null, h('span', null, 'Davet edilenler'), cntR), listR);
  const note = h('div', { class: 'small muted' });
  const set = s => { invited = s; selL.clear(); selR.clear(); draw(); onChange(); };
  const add = ids => { const before = invited.size; const n = inviteAdd(invited, ids, max); if (n.size - before < [].concat(ids).length) toast(tr('En çok {n} kişi davet edilebilir', { n: max }), 'err'); set(n); };
  const rem = ids => set(inviteRemove(invited, ids));
  const item = (u, side) => {
    const sel = side === 'left' ? selL : selR;
    return h('li', { role: 'option', 'data-id': u.id, class: sel.has(u.id) ? 'sel' : '', draggable: 'true', 'aria-selected': sel.has(u.id) ? 'true' : 'false',
      title: tr(side === 'left' ? 'Çift tık: davet et' : 'Çift tık: davetten çıkar'),
      onclick: e => { if (!e.ctrlKey && !e.metaKey) sel.clear(); sel.has(u.id) ? sel.delete(u.id) : sel.add(u.id); draw(); },
      ondblclick: () => (side === 'left' ? add(u.id) : rem(u.id)),
      ondragstart: e => { e.dataTransfer.setData('text/plain', JSON.stringify({ id: u.id, side })); e.dataTransfer.effectAllowed = 'move'; } },
    h('span', { class: 'av', style: { background: side === 'left' ? '#64748b' : '#2563eb' } }, initials(u.full_name)),
    h('span', { class: 'nm' }, h('b', null, u.full_name), h('small', null, [u.username, u.pilot ? tr('Pilot') : null].filter(Boolean).join(' · '))));
  };
  const draw = () => {
    const { left, right } = partitionInvite(users, invited, q);
    clear(listL, left.length ? left.map(u => item(u, 'left')) : h('li', { class: 'empty' }, q ? 'Aramaya uyan kullanıcı yok' : 'Herkes davet edildi'));
    clear(listR, right.length ? right.map(u => item(u, 'right')) : h('li', { class: 'empty' }, 'Henüz kimse davet edilmedi — soldan seçip › ile ekleyin, çift tıklayın ya da sürükleyin'));
    cntL.textContent = String(users.length - invited.size); cntR.textContent = `${invited.size} / ${max}`;
    note.textContent = tr('Siz de oyuncusunuz: karşılaşma {n} kişi.', { n: invited.size + 1 });
  };
  for (const [col, side] of [[colL, 'left'], [colR, 'right']]) {
    col.addEventListener('dragover', e => { e.preventDefault(); col.classList.add('on'); });
    col.addEventListener('dragleave', () => col.classList.remove('on'));
    col.addEventListener('drop', e => { e.preventDefault(); col.classList.remove('on'); try { const d = JSON.parse(e.dataTransfer.getData('text/plain')); if (d.side !== side) (side === 'right' ? add : rem)(d.id); } catch { /* */ } });
  }
  const btn = (txt, title, fn) => h('button', { class: 'btn sm', type: 'button', title, 'aria-label': title, onclick: fn }, txt);
  const search = h('input', { class: 'input fs-mt-invq', type: 'search', placeholder: 'Kullanıcı ara…', oninput: () => { q = search.value; draw(); } });
  const el = h('div', { class: 'fs-mt-invite' },
    h('p', { class: 'small muted' }, 'Uçuş Simülatörü yetkisi olan kullanıcılar listelenir. Başlat’tan sonra davet edilenlere bildirim gider; bildirime tıklayan bekleme salonuna gelir. Herkes gelince simülasyon başlar.'),
    search,
    h('div', { class: 'fs-mt-inv' }, colL,
      h('div', { class: 'fs-mt-mid' },
        btn('›', tr('Seçilenleri davet et'), () => add([...selL])), btn('»', tr('Tümünü davet et'), () => add(partitionInvite(users, invited, q).left.map(u => u.id))),
        btn('‹', tr('Seçilenleri davetten çıkar'), () => rem([...selR])), btn('«', tr('Tümünü çıkar'), () => rem([...invited]))),
      colR),
    note);
  draw();
  return { el, values: () => [...invited], error: () => inviteError(invited, limits), names: () => users.filter(u => invited.has(u.id)).map(u => u.full_name), set: ids => set(new Set(ids)) };
}

// ---------------------------------------------------------------- WS istemcisi
function matchSocket(mid, handlers) {
  let ws = null, closed = false, retry = 0, pingIv = 0, timer = 0, sentAt = 0;
  const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws/drone/match/${encodeURIComponent(mid)}`;
  const send = o => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(o)); };
  const open = () => {
    if (closed) return;
    try { ws = new WebSocket(url); } catch (err) { handlers.fatal?.(err.message); return; }
    ws.onopen = () => { retry = 0; handlers.open?.(); sentAt = Date.now(); send({ t: 'ping' }); pingIv = setInterval(() => { sentAt = Date.now(); send({ t: 'ping' }); }, 5000); };
    ws.onmessage = e => { let m; try { m = JSON.parse(e.data); } catch { return; } if (m.t === 'pong') handlers.pong?.(m.now, sentAt, Date.now()); else handlers.message?.(m); };
    ws.onclose = ev => {
      clearInterval(pingIv);
      if (closed) return;
      if (ev.code === 4403 || ev.code === 4404) { handlers.fatal?.(ev.code === 4404 ? 'notfound' : 'auth'); return; }
      timer = setTimeout(open, Math.min(8000, 400 * 2 ** Math.min(retry++, 5)));
    };
  };
  open();
  return { send, close: () => { closed = true; clearTimeout(timer); clearInterval(pingIv); try { ws?.close(); } catch { /* */ } } };
}

// ---------------------------------------------------------------- sonuç tablosu
export function resultsBody(match, me) {
  const res = match.result || null;
  const rows = res?.standings || liveStandings(match.players || []);
  const win = (match.players || []).find(p => p.id === (res?.winner ?? match.winner));
  const medal = r => h('span', { class: `rk rk${r}` }, String(r));
  return h('div', { class: 'fs-mt-res' },
    h('div', { class: 'fs-mt-win' }, h('span', { class: 'cup' }, win ? '🏆' : '🏁'),
      h('div', null, h('b', null, win ? tr('Kazanan: {n}', { n: win.name }) : tr('Kazanan yok')),
        h('div', { class: 'small muted' }, [tr(REASON_TEXT[res?.reason || match.reason] || res?.reason || match.reason || ''), res?.duration_s != null ? tr('Yarış süresi {t}', { t: fmtClock(res.duration_s) }) : null].filter(Boolean).join(' · ')))),
    h('div', { class: 'tw' }, h('table', null,
      h('thead', null, h('tr', null, ['Sıra', 'Oyuncu', 'Süre', 'Halka', 'Sıradakine', 'Azami hız', 'Çarpışma', 'Durum'].map(x => h('th', null, x)))),
      h('tbody', null, rows.map(r => h('tr', { class: r.id === me ? 'me' : '', 'data-id': r.id },
        h('td', null, medal(r.rank ?? 0)), h('td', null, h('b', null, r.name), r.id === me ? h('span', { class: 'small muted' }, ` (${tr('siz')})`) : null),
        h('td', { class: 'n' }, r.time_s != null ? fmtClock(r.time_s) : r.finished ? '✓' : '—'),
        h('td', { class: 'n' }, `${r.rings ?? 0} / ${r.total ?? res?.total ?? '—'}`),
        h('td', { class: 'n' }, r.finished ? '—' : fmtDist(r.dist_next_m)),
        h('td', { class: 'n' }, r.max_speed_ms != null ? `${Number(r.max_speed_ms).toFixed(1)} m/s` : '—'),
        h('td', { class: 'n' }, String(r.crashes ?? 0)),
        h('td', null, r.finished ? h('span', { class: 'badge green' }, 'Bitirdi') : h('span', { class: `badge ${STATUS_TONE[r.status] || 'gray'}` }, tr(r.status === 'hazir' ? 'Yarıştı' : STATUS_TEXT[r.status] || r.status)))))))));
}

// ---------------------------------------------------------------- bekleme salonu sayfası
export async function renderLobby(view, ctx, mid, { head }) {
  ensureMatchCss();
  const me = ctx.user?.id;
  let M;
  try { M = await matchApi.get(mid); } catch (err) {
    clear(view, head('Karşılaşma'), h('div', { class: 'card empty' }, h('p', null, h('b', null, err.status === 403 ? tr('Bu karşılaşmanın oyuncusu değilsiniz.') : tr('Karşılaşma bulunamadı.'))),
      h('a', { class: 'btn', href: '#/drone/sim?tab=matches' }, 'Karşılaşmalar')));
    return;
  }
  const mine = () => (M.players || []).find(p => p.id === me);
  if (M.live && mine()?.status === 'davetli' && M.state === 'LOBI') { try { M = await matchApi.join(mid); toast(tr('Bekleme salonuna katıldınız')); } catch (err) { toastError(err); } }
  const clock = createClock();
  const banner = h('div', { class: 'fs-mt-banner' });
  const plist = h('ul', { class: 'fs-mt-players' });
  const acts = h('div', { class: 'pill-group fs-mt-acts' });
  const sum = h('div', { class: 'card card-pad fs-mt-sum no-collapse' });
  const resBox = h('div', { class: 'card card-pad no-collapse', hidden: true });
  const chatLog = h('div', { class: 'log' });
  const chatInp = h('input', { class: 'input', maxlength: 300, placeholder: 'Mesaj yazın…' });
  let sock = null, left = false;
  const chat = h('div', { class: 'fs-mt-chat' }, h('b', { class: 'small' }, 'Sohbet'), chatLog,
    h('form', { onsubmit: e => { e.preventDefault(); const t = chatInp.value.trim(); if (t) { sock?.send({ t: 'chat', text: t }); chatInp.value = ''; } } }, chatInp, h('button', { class: 'btn sm', type: 'submit' }, 'Gönder')));
  const addChat = m => { chatLog.append(h('div', null, h('b', { style: { color: colorFor(M.players, m.id) } }, `${m.name}: `), m.text)); chatLog.scrollTop = chatLog.scrollHeight; };
  const isHost = () => M.host_id === me;
  const drawBanner = () => {
    const c = lobbyCounts(M.players);
    const st = M.state;
    banner.className = `fs-mt-banner ${st === 'IPTAL' ? 'iptal' : st === 'BITTI' ? 'bitti' : ''}`;
    const sub = st === 'LOBI' ? tr('Davetlilerin gelmesi bekleniyor: {a} / {t} oyuncu geldi. Herkes gelince simülasyon kendiliğinden başlar.', { a: c.arrived, t: c.total })
      : st === 'HAZIRLIK' ? tr('Herkes geldi. Simülatörler hazırlanıyor ({r} / {t} hazır)…', { r: c.ready, t: c.total })
        : st === 'GERI_SAYIM' ? tr('Yarış başlıyor!') : st === 'YARIS' ? tr('Yarış sürüyor') : st === 'IPTAL' ? tr(REASON_TEXT[M.reason] || M.reason || '') : tr(REASON_TEXT[M.reason] || '');
    clear(banner, h('span', { class: 'pulse' }), h('div', null, h('b', null, `${tr(STATE_TEXT[st] || st)} · #${M.id}`), h('div', { class: 'sub' }, sub)));
  };
  const drawPlayers = () => {
    const online = new Set(M.viewers || []);
    clear(plist, (M.players || []).map(p => h('li', { 'data-status': p.status, 'data-id': p.id },
      h('span', { class: 'av', style: { background: colorFor(M.players, p.id) } }, initials(p.name), h('i', { class: online.has(p.id) ? 'on' : '', title: tr(online.has(p.id) ? 'Çevrimiçi' : 'Çevrimdışı') })),
      h('div', { class: 'grow' }, h('b', null, p.name), p.host ? h('span', { class: 'badge purple', style: { marginLeft: '6px' } }, 'Kurucu') : null, p.id === me ? h('span', { class: 'small muted' }, ` (${tr('siz')})`) : null,
        p.drop_reason ? h('div', { class: 'small muted' }, tr(DROP_TEXT[p.drop_reason] || p.drop_reason)) : null),
      h('span', { class: `badge ${STATUS_TONE[p.status] || 'gray'}` }, tr(p.status === 'hazir' && ['YARIS', 'BITTI'].includes(M.state) ? (p.finished ? 'Bitirdi' : 'Yarıştı') : STATUS_TEXT[p.status] || p.status)),
      isHost() && !p.host && ACTIVE.has(p.status) && ['LOBI', 'HAZIRLIK'].includes(M.state) && M.live !== false
        ? h('button', { class: 'btn sm ghost', type: 'button', title: tr('Oyuncuyu çıkar'), onclick: async () => { if (await confirmDialog(tr('Oyuncuyu çıkar'), tr('{n} karşılaşmadan çıkarılsın mı?', { n: p.name }), { okLabel: tr('Çıkar'), danger: true })) { try { M = await matchApi.kick(mid, p.id); draw(); } catch (err) { toastError(err); } } } }, '✕') : null)));
  };
  const drawActs = () => {
    const live = M.live !== false && !['BITTI', 'IPTAL'].includes(M.state);
    const my = mine();
    clear(acts,
      live && isHost() && M.state === 'LOBI' ? h('button', { class: 'btn', type: 'button', disabled: !M.can_force, title: M.can_force ? '' : tr('En az bir davetli gelmeli ve {s} sn beklenmeli', { s: Math.round(M.force_after_s || 60) }),
        onclick: async () => { if (await confirmDialog(tr('Gelmeyenler olmadan başlat'), tr('Gelmeyen davetliler karşılaşmadan düşer; gelenlerle başlansın mı?'), { okLabel: tr('Başlat') })) { try { M = await matchApi.start(mid); draw(); } catch (err) { toastError(err); } } } }, '▶ Gelmeyenler olmadan başlat') : null,
      live && isHost() ? h('button', { class: 'btn danger', type: 'button', onclick: async () => { if (await confirmDialog(tr('Karşılaşmayı iptal et'), tr('Karşılaşma herkes için iptal edilsin mi?'), { okLabel: tr('İptal et'), danger: true })) { try { M = await matchApi.cancel(mid); draw(); } catch (err) { toastError(err); } } } }, 'Karşılaşmayı iptal et') : null,
      live && !isHost() && my && ACTIVE.has(my.status) ? h('button', { class: 'btn', type: 'button', onclick: async () => { if (await confirmDialog(tr('Ayrıl'), tr('Karşılaşmadan ayrılmak istiyor musunuz?'), { okLabel: tr('Ayrıl'), danger: true })) { try { left = true; M = await matchApi.leave(mid); draw(); location.hash = '#/drone/sim?tab=matches'; } catch (err) { toastError(err); } } } }, 'Ayrıl') : null,
      my?.session_id && ['HAZIRLIK', 'GERI_SAYIM', 'YARIS'].includes(M.state) ? h('a', { class: 'btn primary', href: sessionHref(my.session_id, mid) }, 'Simülatöre geç') : null,
      h('a', { class: 'btn ghost', href: '#/drone/sim?tab=matches' }, 'Karşılaşmalar'));
  };
  const drawSum = () => {
    const s = M.settings || {}, r = M.rings_cfg || {}, w = s.world || {};
    const host = (M.players || []).find(p => p.host);
    const svg = h('div', { class: 'fs-mt-map', style: { marginTop: '10px' } }); svg.innerHTML = ringsSvg(M.rings || []);
    clear(sum, h('h3', null, 'Karşılaşma ayarları'),
      h('dl', null,
        h('dt', null, 'Kurucu'), h('dd', null, host?.name || '—'),
        h('dt', null, 'Araç'), h('dd', null, tr(TYPE_NAME[s.type] || s.type || '—')),
        h('dt', null, 'Merkez'), h('dd', null, M.center?.name || '—'),
        h('dt', null, 'Dünya'), h('dd', null, [tr({ real: 'Gerçek arazi', google3d: 'Google 3B (fotogerçekçi)', procedural: 'Prosedürel' }[w.mode] || w.mode || '—'), w.time ? tr({ day: 'Gündüz', dusk: 'Akşam', night: 'Gece' }[w.time] || w.time) : null].filter(Boolean).join(' · ')),
        h('dt', null, 'Halkalar'), h('dd', null, ringsSummary(r)),
        h('dt', null, 'Süre sınırı'), h('dd', null, tr('{n} dk', { n: r.time_limit_min ?? '—' })),
        h('dt', null, 'Oluşturuldu'), h('dd', null, typeof M.created_at === 'number' ? new Date(M.created_at * 1000).toLocaleString() : fmtDateTime(M.created_at))),
      svg, M.live !== false ? chat : null);
  };
  const drawRes = () => {
    resBox.hidden = M.state !== 'BITTI';
    if (!resBox.hidden) clear(resBox, h('h3', null, 'Sonuç'), resultsBody(M, me));
  };
  let jumped = false;
  const draw = () => {
    drawBanner(); drawPlayers(); drawActs(); drawSum(); drawRes();
    const my = mine();
    if (!jumped && !left && my?.session_id && ['HAZIRLIK', 'GERI_SAYIM', 'YARIS'].includes(M.state) && ACTIVE.has(my.status) && location.hash.startsWith(matchHref(mid))) {
      jumped = true;
      toast(tr('Simülatörünüz hazırlanıyor; oturum ekranına geçiliyor'));
      location.hash = sessionHref(my.session_id, mid);
    }
  };
  clear(view, head(tr('Karşılaşma #{id} · Bekleme salonu', { id: M.id })), banner,
    h('div', { class: 'fs-mt-page' }, h('div', null, h('div', { class: 'card card-pad no-collapse' }, h('h3', null, 'Oyuncular'), plist, h('div', { style: { marginTop: '12px' } }, acts)), resBox), sum));
  draw();
  if (M.live !== false && !['BITTI', 'IPTAL'].includes(M.state)) {
    sock = matchSocket(mid, {
      pong: (n, s, r) => clock.sample(n, s, r),
      message: m => {
        if (m.t === 'hello') { M = { ...m.match, live: true }; (m.chat || []).forEach(addChat); draw(); return; }
        if (m.t === 'match') { M = { ...m.match, live: true }; draw(); return; }
        if (m.t === 'chat') addChat(m);
        if (m.t === 'result') { M = { ...M, result: m.result }; draw(); }
      },
      fatal: () => {},
    });
  }
  const tick = setInterval(() => { if (M.state === 'LOBI') drawActs(); }, 5000);
  onLeave(() => { sock?.close(); clearInterval(tick); });
}

// ---------------------------------------------------------------- oturum ekranı katmanı
// stage: .fs-stage · getSim(): flightsim3d nesnesi · startIntro(): §29 giriş sekansı (3‑2‑1 + bip) — geri sayımın son 3 sn'sinde çağrılır
export function attachMatch({ stage, getSim, mid, me, sid, homeHref = '#/drone/sim?tab=matches', startIntro = () => {}, getTele = () => null }) {
  ensureMatchCss();
  const clock = createClock();
  let M = null, layer = null, worldReady = false, introDone = false, resultShown = false, disposed = false;
  const pos = {};   // id → son pos girdisi
  const bar = h('div', { class: 'fs-mt-bar wait' }, 'Karşılaşmaya bağlanılıyor…');
  const board = h('div', { class: 'fs-mt-board' }, h('h6', null, 'Sıralama'), h('ol'));
  const wait = h('div', { class: 'fs-mt-wait', hidden: true }, h('div', { class: 'box' }));
  const resEl = h('div', { class: 'fs-mt-result', hidden: true });
  const flash = h('div', { class: 'fs-mt-toast', style: { opacity: '0' } });
  stage.append(bar, board, wait, resEl, flash);
  let flashT = 0;
  const flashMsg = (txt, bg = null) => { flash.textContent = txt; flash.style.background = bg || ''; flash.style.opacity = '1'; clearTimeout(flashT); flashT = setTimeout(() => { flash.style.opacity = '0'; }, 1800); };
  const myP = () => (M?.players || []).find(p => p.id === me);
  const ensureLayer = () => {
    const sim = getSim();
    if (!sim || !M || layer) return;
    if (!sim.three || !sim.scene) return;
    layer = createMatchLayer(sim, { me });
    layer.setRings(M.rings || []);
    syncPlayers();
    if (typeof window !== 'undefined') window.__fsMatch = { layer, get match() { return M; }, clock, get sim() { return getSim(); } };   // teşhis (görsel betikler)
  };
  const syncPlayers = () => layer?.setPlayers((M?.players || []).filter(p => ACTIVE.has(p.status)).map(p => ({ id: p.id, name: p.name, color: colorFor(M.players, p.id), plane: M.settings?.type === 'sabit_kanat' })));
  const drawBoard = () => {
    if (!M) return;
    const rows = liveStandings(M.players, pos);
    const total = (M.rings || []).length;
    clear(board.querySelector('ol'), rows.map((p, i) => h('li', { class: `${p.id === me ? 'me' : ''} ${ACTIVE.has(p.status) ? '' : 'out'}`.trim() },
      h('span', { class: 'v' }, `${i + 1}.`), h('span', { class: 'dot', style: { background: colorFor(M.players, p.id) } }), h('span', { class: 'nm' }, p.name),
      h('span', { class: 'v' }, p.finished ? '🏁' : `${p.rings ?? 0}/${total}`))));
  };
  const drawWait = () => {
    if (!M) return;
    const box = wait.firstChild;
    const st = M.state;
    if (st === 'HAZIRLIK' || (st === 'GERI_SAYIM' && countdownPhase(M.start_at, clock.now()).phase === 'wait')) {
      wait.hidden = false;
      const c = lobbyCounts(M.players);
      const ph = st === 'GERI_SAYIM' ? countdownPhase(M.start_at, clock.now()) : null;
      clear(box, h('div', { class: 'ttl' }, st === 'GERI_SAYIM' ? tr('Herkes hazır — yarış başlıyor') : tr('Diğer oyuncular bekleniyor')),
        h('div', { class: 'small', style: { opacity: '.8' } }, st === 'GERI_SAYIM' ? tr('Kalkış serbest olunca halkaları sırayla geçin.') : tr('{r} / {t} oyuncu hazır', { r: c.ready, t: c.total })),
        ph ? h('div', { class: 'big' }, String(Math.ceil(ph.remain))) : null,
        h('ul', null, (M.players || []).filter(p => ACTIVE.has(p.status) || p.status === 'dustu').map(p => h('li', null, h('span', { class: 'dot', style: { background: colorFor(M.players, p.id) } }),
          h('span', { style: { flex: '1' } }, p.name, p.id === me ? ` (${tr('siz')})` : ''), h('span', { class: `badge ${STATUS_TONE[p.status] || 'gray'}` }, tr(STATUS_TEXT[p.status] || p.status))))));
    } else wait.hidden = true;
  };
  const drawBar = () => {
    if (!M) return;
    const st = M.state;
    if (st === 'YARIS') {
      const my = pos[me] || {}, nxt = my.next ?? myP()?.next, total = (M.rings || []).length;
      const el = Math.max(0, clock.now() - (M.start_at || 0));
      bar.className = 'fs-mt-bar';
      if (nxt == null && (myP()?.finished || my.rings === total)) { clear(bar, h('span', { class: 'ring' }, '🏁'), tr('Tüm halkalar geçildi'), h('span', { class: 't' }, fmtClock(el))); return; }
      const ring = (M.rings || []).find(r => r.i === nxt);
      const tele = getTele();
      let arr = '';
      if (ring && tele && getSim()) {
        const L = getSim().toLocal(Number(tele.lat), Number(tele.lon));
        const rel = relAngle(Number(tele.heading ?? ((tele.yaw || 0) * 180 / Math.PI)), bearingDeg(L.x, L.y, Number(ring.x), Number(ring.y)));
        arr = h('span', { class: 'arr', style: { transform: `rotate(${Math.round(rel)}deg)` }, title: `${Math.round(rel)}°` }, '▲');
      }
      const dz = ring && tele ? Number(ring.alt_msl) - Number(tele.alt_msl) : null;
      clear(bar, h('span', { class: 'ring' }, '◎'), tr('Halka {i} / {n}', { i: nxt ?? '—', n: total }), arr || null, h('span', null, fmtDist(my.dist)),
        dz != null ? h('span', { class: 't' }, `${dz >= 0 ? '↑' : '↓'}${Math.abs(dz).toFixed(0)} m`) : null, h('span', { class: 't' }, fmtClock(el)));
    } else if (st === 'GERI_SAYIM') {
      const ph = countdownPhase(M.start_at, clock.now());
      bar.className = 'fs-mt-bar wait';
      clear(bar, tr('Yarış {s} sn sonra başlıyor', { s: Math.max(0, Math.ceil(ph.remain ?? 0)) }));
    } else if (st === 'HAZIRLIK') { bar.className = 'fs-mt-bar wait'; clear(bar, tr('Simülatörler hazırlanıyor…')); }
    else if (st === 'BITTI') { bar.className = 'fs-mt-bar'; clear(bar, '🏁 ', tr('Karşılaşma bitti')); }
    else if (st === 'IPTAL') { bar.className = 'fs-mt-bar wait'; clear(bar, tr('Karşılaşma iptal edildi: {r}', { r: tr(REASON_TEXT[M.reason] || M.reason || '') })); }
    else { bar.className = 'fs-mt-bar wait'; clear(bar, tr(STATE_TEXT[st] || st)); }
  };
  const showResult = () => {
    if (resultShown || !M) return;
    resultShown = true;
    resEl.hidden = false;
    clear(resEl, h('div', { class: 'box', role: 'dialog', 'aria-modal': 'true' }, h('h2', { style: { marginTop: '0' } }, tr('Karşılaşma sonucu · #{id}', { id: M.id })), resultsBody(M, me),
      h('div', { class: 'acts' }, h('button', { class: 'btn', type: 'button', onclick: () => { resEl.hidden = true; } }, 'Kapat'),
        h('a', { class: 'btn primary', href: homeHref }, 'Karşılaşmalar'))));
    try { if (document.fullscreenElement) document.exitFullscreen?.(); } catch { /* */ }
  };
  const maybeIntro = () => {
    if (introDone || !worldReady || !M) return;
    if (M.state === 'YARIS') { introDone = true; return; }
    if (M.state === 'GERI_SAYIM' && countdownPhase(M.start_at, clock.now(), 3).phase !== 'wait') { introDone = true; wait.hidden = true; startIntro(); }
  };
  const onMsg = m => {
    if (disposed) return;
    if (m.t === 'hello' || m.t === 'match') {
      const prevState = M?.state;
      M = m.match;
      if (m.match?.now) clock.sample(m.match.now);
      ensureLayer(); syncPlayers();
      if (layer && myP()) layer.setNext(myP().finished ? null : myP().next ?? 1);
      if (prevState !== 'YARIS' && M.state === 'YARIS') flashMsg(tr('BAŞLA! Halkaları sırayla geçin'));
      if (M.state === 'BITTI' && M.result) showResult();
      drawBoard(); drawWait(); drawBar(); maybeIntro();
      return;
    }
    if (m.t === 'countdown' && M) { M.start_at = m.start_at; M.state = 'GERI_SAYIM'; drawWait(); maybeIntro(); return; }
    if (m.t === 'pos') {
      for (const p of m.p || []) pos[p.id] = p;
      layer?.pushPos(m);
      if (layer && pos[me]) layer.setNext(pos[me].next ?? null);
      return;
    }
    if (m.t === 'ring') {
      const nm = (M?.players || []).find(p => p.id === m.id)?.name || '';
      if (m.id === me) { beep(1175, 0.14); flashMsg(tr('Halka {i} / {n} ✓', { i: m.i, n: m.total })); layer?.setNext(m.i + 1 > m.total ? null : m.i + 1); }
      else if (m.i === m.total) flashMsg(tr('{n} son halkayı geçti', { n: nm }), 'rgba(250,204,21,.92)');
      return;
    }
    if (m.t === 'wrong_way' && m.id === me) { flashMsg(tr('Ters yön! Halkayı ok yönünde geçin'), 'rgba(248,113,113,.95)'); beep(330, 0.25); return; }
    if (m.t === 'finish') { const nm = (M?.players || []).find(p => p.id === m.id)?.name || ''; flashMsg(m.id === me ? tr('BİTİRDİNİZ! {t}', { t: fmtClock(m.elapsed_s) }) : tr('{n} bitirdi', { n: nm }), 'rgba(250,204,21,.95)'); if (m.id === me) { beep(1568, 0.4); } return; }
    if (m.t === 'result' && M) { M = { ...M, result: m.result, state: 'BITTI' }; showResult(); drawBar(); return; }
  };
  const sock = matchSocket(mid, { message: onMsg, pong: (n, s, r) => clock.sample(n, s, r), fatal: () => { clear(bar, tr('Karşılaşmaya bağlanılamadı')); } });
  const iv = setInterval(() => { ensureLayer(); drawBar(); drawBoard(); if (M?.state === 'GERI_SAYIM') drawWait(); maybeIntro(); }, 250);
  return {
    // 3B dünya kuruldu + oturum HAZIR → sunucuya `ready` (herkes hazır olunca geri sayım başlar)
    onWorldReady() { if (worldReady) return; worldReady = true; ensureLayer(); const send = () => sock.send({ t: 'ready' }); send(); setTimeout(send, 1500); setTimeout(send, 5000); maybeIntro(); },
    get state() { return M?.state || null; },
    dispose() { disposed = true; clearInterval(iv); sock.close(); layer?.dispose(); bar.remove(); board.remove(); wait.remove(); resEl.remove(); flash.remove(); if (window.__fsMatch?.layer === layer) delete window.__fsMatch; },
  };
}

// ---------------------------------------------------------------- "Karşılaşmalar" sekmesi
export function matchesCard({ onCount = () => {} } = {}) {
  ensureMatchCss();
  const el = h('div', { class: 'fs-mt-tab' });
  const refresh = async () => {
    let rows = [];
    try { rows = await matchApi.list(); } catch { rows = []; }
    onCount(rows.filter(r => r.live && !['BITTI', 'IPTAL'].includes(r.state)).length);
    if (!rows.length) { clear(el, h('div', { class: 'card empty' }, h('p', null, 'Henüz karşılaşma yok.'), h('p', { class: 'small muted' }, '"Yeni Karşılaşma" ile halka yarışı kurun ve kullanıcıları davet edin.'))); return; }
    clear(el, h('div', { class: 'card card-pad no-collapse' }, h('table', { class: 'table fs-mt-table' },
      h('thead', null, h('tr', null, ['#', 'Durum', 'Kurucu', 'Araç', 'Oyuncular', 'Kazanan', 'Tarih', ''].map(x => h('th', null, x)))),
      h('tbody', null, rows.map(r => {
        const win = (r.players || []).find(p => p.id === r.winner);
        const act = ['LOBI', 'HAZIRLIK', 'GERI_SAYIM', 'YARIS'].includes(r.state) && r.live;
        return h('tr', null, h('td', null, `#${r.id}`),
          h('td', null, h('span', { class: `badge ${act ? 'green' : r.state === 'IPTAL' ? 'red' : 'gray'}` }, tr(STATE_TEXT[r.state] || r.state))),
          h('td', null, r.host_name || '—'), h('td', null, tr(TYPE_NAME[r.type] || r.type || '—')),
          h('td', null, (r.players || []).map(p => p.name).join(', ')), h('td', null, win ? h('b', null, win.name) : '—'),
          h('td', null, typeof r.created_at === 'number' ? new Date(r.created_at * 1000).toLocaleString() : fmtDateTime(r.created_at)),
          h('td', null, h('a', { class: `btn sm ${act ? 'primary' : ''}`, href: matchHref(r.id) }, act ? 'Salona git' : 'Sonuç')));
      })))));
  };
  refresh();
  return { el, refresh };
}
