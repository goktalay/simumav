// Uçuş Simülatörü §33 — ÇOK OYUNCULU KARŞILAŞMA arayüzü (HEPGO): sihirbaz "Halkalar" ve "Davet et" bölümleri, bekleme salonu sayfası
// (#/drone/sim/match/<id>), oturum ekranındaki karşılaşma katmanı (durum şeridi, canlı sıralama, 3B halkalar + diğer oyuncular, senkron geri sayım,
// sonuç ekranı) ve "Karşılaşmalar" sekmesi. Saf kısım flightsim_match.js; 3B flightsim_match3d.js; sunucu app/flightsim_match*.py.
import { api } from '../api.js';
import { clear, confirmDialog, fmtDateTime, h, onLeave, toast, toastError, t as tr } from '../ui.js';
import { numSlider } from './fs_inputs.js';
import { hepgoSound } from './flightsim_intro.js';
import { createMatchLayer } from './flightsim_match3d.js';
import { DF_LIMITS, createDogfightHud, dfDefaults, dfError, dfResultRows, dfSummary, dfSvg, makeDfT, roleOf } from './flightsim_dogfight.js';   // §41 it dalaşı
import { ACTIVE, BOT_LEVELS, BOT_LEVEL_TEXT, BOT_NAMES, MATCH_LIMITS, REASON_TEXT, STATE_TEXT, STATUS_TEXT, STATUS_TONE, arrowFor, bearingDeg, botBadge, botName, colorFor, countdownPhase, createClock, fmtClock, fmtDist,
  inviteAdd, inviteRemove, isBot, liveStandings, lobbyCounts, matchHref, matchScore, myRank, opponentsError, partitionInvite, relAngle, ringDefaults, ringsError, ringsSummary, ringsViewBox, sessionHref } from './flightsim_match.js';
import { countSteps, createSfx, rankChange } from './flightsim_sfx.js';   // §44 oyun efektleri
import { courseSvg, fpvPoints, fpvRow, fpvRulesText, matchIsSolo, opponentsErrorSolo, soloAllowed } from './flightsim_fpvcourse.js';   // §47 FPV parkuru (saf)
import { FLAG_SVG, FT, attachFpvMatch, courseDetail, createFpvSection, ensureFpvUiCss, fpvResultsBody, soloRingsHead } from './flightsim_fpvcourse_ui.js';   // §47 HEPGO DOM

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
  rematch: id => api.post(`${API}/${encodeURIComponent(id)}/rematch`, {}),   // §41 it dalaşı rövanşı (roller değişir)
  addBot: (id, level) => api.post(`${API}/${encodeURIComponent(id)}/bot`, { level }),   // §44 yapay zekâ pilot (kurucu, salonda)
};
const DT = makeDfT(tr, false);   // §41 metinleri (HEPGO: Türkçe anahtar)
const isDf = m => (m?.kind || 'rings') === 'dogfight';
const isFpv = m => (m?.kind || 'rings') === 'fpv';   // §47
const kindName = m => (isDf(m) ? DT('df.kind_dogfight') : isFpv(m) ? FT('fpv.kind') : DT('df.kind_rings'));
const TYPE_NAME = { multirotor: 'Multikopter', hexarotor: 'Hexakopter', helikopter: 'Helikopter', sabit_kanat: 'Sabit Kanat', vtol: 'VTOL', interceptor: 'INTERCEPTOR' };

// ---------------------------------------------------------------- CSS
let cssDone = false;
export function ensureMatchCss() {
  if (cssDone || typeof document === 'undefined') return;
  cssDone = true;
  ensureFpvUiCss();   // §47 galeri / sonuç / tek kişilik rozeti
  const st = document.createElement('style');
  st.dataset.fs = 'match';
  st.textContent = `
.fs-mt-rings{display:grid;grid-template-columns:minmax(0,1fr) minmax(220px,300px);gap:16px;align-items:start}
.fs-mt-rings[hidden]{display:none}
.fs-df-kinds{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:10px;margin-bottom:14px}
.fs-df-kind{display:flex;flex-direction:column;gap:4px;text-align:left;padding:10px 12px;border-radius:12px;border:1.5px solid var(--border);background:var(--card,#fff);color:inherit;cursor:pointer}
.fs-df-kind b{font-size:14px}.fs-df-kind small{color:var(--muted);line-height:1.35}
.fs-df-kind.on{border-color:var(--primary);background:color-mix(in srgb,var(--primary) 9%,transparent);box-shadow:0 0 0 2px color-mix(in srgb,var(--primary) 25%,transparent)}
.fs-df-rules{line-height:1.45}
.fs-df-badge{display:inline-block;padding:2px 8px;border-radius:7px;font-weight:800;font-size:11px;letter-spacing:.06em;color:#fff}
.fs-df-badge.chaser{background:#b91c1c}.fs-df-badge.evader{background:#1d4ed8}
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
.fs-ai-badge{display:inline-block;margin-left:6px;padding:1px 7px;border-radius:7px;font-weight:800;font-size:11px;letter-spacing:.04em;color:#fff;background:linear-gradient(120deg,#7c3aed,#db2777);vertical-align:middle}
.fs-mt-bots{margin-top:12px;border:1px solid var(--border);border-radius:12px;padding:10px 12px;background:color-mix(in srgb,#7c3aed 5%,transparent)}
.fs-mt-bots h5{margin:0 0 6px;font-size:13px;display:flex;gap:8px;align-items:center}
.fs-mt-bots .row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.fs-mt-bots .row>*{flex:0 0 auto;width:auto}.fs-mt-bots .row>.small{flex:1 1 200px}
.fs-mt-lv{display:inline-flex;border:1px solid var(--border);border-radius:9px;overflow:hidden}
.fs-mt-lv button{border:0;background:transparent;color:inherit;padding:5px 11px;cursor:pointer;font:600 12.5px system-ui,sans-serif}
.fs-mt-lv button.on{background:#7c3aed;color:#fff}
.fs-mt-chips{display:flex;gap:6px;flex-wrap:wrap;margin-top:8px}
.fs-mt-chip{display:inline-flex;gap:6px;align-items:center;padding:4px 6px 4px 10px;border-radius:999px;border:1px solid var(--border);font-size:12.5px;background:var(--card,#fff)}
.fs-mt-chip i{width:10px;height:10px;border-radius:50%;display:inline-block}
.fs-mt-chip button{border:0;background:transparent;cursor:pointer;color:var(--muted);font-size:13px;padding:0 4px}
.fs-mt-players li .av.bot{font-size:17px}
.fs-mt-score{display:flex;align-items:baseline;gap:10px;margin:4px 0 10px}.fs-mt-score b{font-size:30px;font-variant-numeric:tabular-nums;color:#7c3aed}
.fs-mt-toast{position:absolute;left:50%;top:104px;transform:translateX(-50%);z-index:32;padding:6px 14px;border-radius:999px;background:rgba(34,197,94,.92);color:#04130a;font:700 15px system-ui,sans-serif;pointer-events:none;transition:opacity .4s}
`;
  document.head.append(st);
}

const DROP_TEXT = { gelmedi: 'Gelmedi', hazirlanamadi: 'Simülatörü zamanında hazır olmadı' };
const initials = n => String(n || '?').trim().split(/\s+/).map(w => w[0]).slice(0, 2).join('').toLocaleUpperCase('tr');

const aiBadge = p => (isBot(p) ? h('span', { class: 'fs-ai-badge', title: tr('Yapay zekâ pilot') }, botBadge(p, tr)) : null);   // §44 'AI · Zor'

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
export function createRingsSection({ getType, getCenter, limits = MATCH_LIMITS, initial = null, onChange = () => {}, onKind = () => {} }) {
  ensureMatchCss();
  // §41 tür seçimi: halka yarışı | it dalaşı (2 kişilik)
  const DL = { ...DF_LIMITS, ...(limits?.dogfight || {}) };
  let kind = 'rings', D = dfDefaults(getType(), DL);
  const dsl = {};
  const dmk = (key, label, [a, b], step, unit, integer = false) => {
    dsl[key] = numSlider({ h, label: DT(label), value: D[key], min: a, max: b, step, unit, integer, cls: 'fs-slider', onInput: v => { D[key] = v; dchanged(); } });
    return dsl[key].el;
  };
  const dfMap = h('div', { class: 'fs-mt-map fs-df-map' });
  const rules = h('p', { class: 'small muted fs-df-rules' });
  const rolesSel = h('select', { class: 'input', onchange: () => { D.roles = rolesSel.value; dchanged(); } }, DL.roles.map(r => h('option', { value: r }, DT(`df.roles_${r}`))));
  const dchanged = () => {
    const e = dfError(D, DL);
    dfMap.innerHTML = e ? '' : dfSvg(D, { T: DT });
    if (e) dfMap.append(h('div', { class: 'small fs-warn-txt' }, tr(e)));
    rules.textContent = DT('df.rules', { r: Math.round(D.range_m), c: Math.round(D.cone_deg), h: Number(D.hold_s).toFixed(1), t: D.time_limit_min, a: Math.round(D.area_radius_m), g: Math.round(DL.guard_s || 60) });
    onChange();
  };
  const dfBox = h('div', { class: 'fs-mt-rings', hidden: true },
    h('div', null, rules,
      h('div', { class: 'fs-mt-grid' },
        dmk('distance_m', 'df.distance', DL.distance_m, 50, 'm'), dmk('alt_m', 'df.alt', DL.alt_m, 5, 'm'), dmk('time_limit_min', 'df.time', DL.time_limit_min, 1, 'dk', true),
        dmk('range_m', 'df.range', DL.range_m, 10, 'm'), dmk('cone_deg', 'df.cone', DL.cone_deg, 1, '°'), dmk('hold_s', 'df.hold', DL.hold_s, 0.5, 'sn'),
        dmk('area_radius_m', 'df.area', DL.area_radius_m, 50, 'm')),
      h('label', { class: 'fs-mt-seed' }, h('span', { class: 'small muted' }, DT('df.roles')), rolesSel)),
    dfMap);
  // §47 üçüncü kart: FPV parkur yarışı (hazır parkur galerisi + kurallar; yalnız çok rotorlu)
  const fpvSec = createFpvSection({ limits: limits?.fpv || null, getType, onChange: () => onChange() });
  fpvSec.el.hidden = true;
  const kindBtns = ['rings', 'dogfight', 'fpv'].map(k => h('button', { type: 'button', class: `fs-df-kind ${k === kind ? 'on' : ''}`, 'data-kind': k, onclick: () => setKind(k) },
    k === 'fpv' ? h('b', null, h('span', { html: FLAG_SVG, style: { verticalAlign: '-3px', marginRight: '4px', color: '#16a34a' } }), FT('fpv.kind')) : h('b', null, k === 'rings' ? '◎ ' : '✈ ', DT(`df.kind_${k}`)),
    h('small', null, k === 'fpv' ? FT('fpv.kind_d') : DT(`df.kind_${k}_d`))));
  const kindRow = h('div', { class: 'fs-df-kinds', role: 'radiogroup', 'aria-label': DT('df.kind') }, kindBtns);
  let ringsBox = null;
  const setKind = k => {
    kind = k === 'dogfight' || k === 'fpv' ? k : 'rings';
    kindBtns.forEach(b => b.classList.toggle('on', b.dataset.kind === kind));
    if (ringsBox) ringsBox.hidden = kind !== 'rings';
    dfBox.hidden = kind !== 'dogfight';
    fpvSec.el.hidden = kind !== 'fpv';
    if (kind === 'dogfight') dchanged(); else if (kind === 'fpv') fpvSec.refresh(); else changed();
    onKind(kind);
  };
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
  ringsBox = h('div', { class: 'fs-mt-rings' },
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
  const el = h('div', { class: 'fs-mt-kindwrap' }, kindRow, ringsBox, dfBox, fpvSec.el);
  dchanged();
  return {
    el,
    values: () => ({ ...R }),
    rings: () => last,
    kind: () => kind, setKind,
    dogfight: () => ({ ...D }),
    fpv: () => fpvSec.body(), fpvSection: fpvSec,   // §47
    error: () => (kind === 'dogfight' ? dfError(D, DL) : kind === 'fpv' ? (fpvSec.error() ? FT(fpvSec.error()) : null) : ringsError(R, limits)),
    summary: () => (kind === 'dogfight' ? [[DT('df.kind'), DT('df.kind_dogfight')], [DT('df.rules').split(':')[0], dfSummary(D, DT)]]
      : kind === 'fpv' ? [[DT('df.kind'), FT('fpv.kind')], ...fpvSec.summary()]
      : [[DT('df.kind'), DT('df.kind_rings')], ['Halkalar', ringsSummary(R)], ['Süre sınırı', tr('{n} dk', { n: R.time_limit_min })], ['Parkur tohumu', String(R.seed)]]),
    refresh: () => {   // tip değişince (dikey ↔ uçak) varsayılanlar
      const t = getType();
      if (typeClass2(t) !== typeClass2(lastType)) {
        const d = ringDefaults(t, limits); for (const k of ['min_alt_m', 'max_alt_m', 'diameter_m', 'radius_m']) { R[k] = d[k]; sl[k].set(d[k]); }
        const dd = dfDefaults(t, DL); for (const k of Object.keys(dsl)) { D[k] = dd[k]; dsl[k].set(dd[k]); } dchanged();
      }
      lastType = t; changed(); fpvSec.refresh();
    },
  };
}
const typeClass2 = t => (t === 'sabit_kanat' ? 'ucak' : 'dikey');

// ---------------------------------------------------------------- sihirbaz: Davet et (solda davet edilmeyenler, sağda edilenler)
export function createInviteSection({ users = [], limits = MATCH_LIMITS, onChange = () => {} }) {
  ensureMatchCss();
  let invited = new Set(), q = '';
  let max = (limits.players_max || 8) - 1, kind = 'rings';   // §47 kind: tek kişilik (davet + bot 0) halka yarışı ve FPV'de serbest
  // §44 yapay zekâ pilotlar (davetlilerle birlikte rakip sayısına girer; it dalaşında toplam tam 1)
  const BN = limits.bot?.names || BOT_NAMES;
  let bots = [], level = limits.bot?.default || 'normal';
  const lvBtns = BOT_LEVELS.map(l => h('button', { type: 'button', 'data-level': l, onclick: () => { level = l; drawBots(); } }, tr(BOT_LEVEL_TEXT[l])));
  const chips = h('div', { class: 'fs-mt-chips' });
  const botNote = h('span', { class: 'small muted' });
  const addBot = () => {
    if (invited.size + bots.length >= max) { toast(tr(max === 1 ? 'İt dalaşı tam 2 oyuncuyla oynanır: bir kullanıcı davet edin ya da bir yapay zekâ pilot ekleyin' : 'En çok {n} rakip olabilir (davetli + yapay zekâ)', { n: max }), 'err'); return; }
    bots = [...bots, { level }]; drawBots(); draw(); onChange();
  };
  const drawBots = () => {
    lvBtns.forEach(b => b.classList.toggle('on', b.dataset.level === level));
    clear(chips, bots.map((b, i) => h('span', { class: 'fs-mt-chip', 'data-level': b.level }, h('i', { style: { background: (limits.bot?.colors || [])[i] || '#7c3aed' } }), '🤖 ', h('b', null, botName(b.level, i, { names: BN, T: tr })),
      h('button', { type: 'button', title: tr('Kaldır'), 'aria-label': tr('Kaldır'), onclick: () => { bots = bots.filter((_, k) => k !== i); drawBots(); draw(); onChange(); } }, '✕'))));
    botNote.textContent = bots.length ? tr('{n} yapay zekâ pilot · her biri kendi simülatörünü kullanır', { n: bots.length }) : tr('Tek başınıza da oynayabilirsiniz: yalnız yapay zekâ rakiple karşılaşma hemen başlar.');
  };
  const botBox = h('div', { class: 'fs-mt-bots' }, h('h5', null, '🤖 ', tr('Yapay zekâ pilot ekle')),
    h('div', { class: 'row' }, h('span', { class: 'fs-mt-lv', role: 'group', 'aria-label': tr('Seviye') }, lvBtns), h('button', { class: 'btn sm primary', type: 'button', onclick: addBot }, tr('+ Ekle')), botNote),
    chips);
  const selL = new Set(), selR = new Set();
  const listL = h('ul', { class: 'fs-mt-list', role: 'listbox', 'aria-multiselectable': 'true', 'data-side': 'left' });
  const listR = h('ul', { class: 'fs-mt-list', role: 'listbox', 'aria-multiselectable': 'true', 'data-side': 'right' });
  const cntL = h('span', { class: 'badge gray' }), cntR = h('span', { class: 'badge blue' });
  const colL = h('div', { class: 'fs-mt-col', 'data-side': 'left' }, h('h5', null, h('span', null, 'Davet edilmeyenler'), cntL), listL);
  const colR = h('div', { class: 'fs-mt-col', 'data-side': 'right' }, h('h5', null, h('span', null, 'Davet edilenler'), cntR), listR);
  const note = h('div', { class: 'small muted' });
  const soloNote = h('div', { class: 'alert info fs-mt-solo', hidden: true });
  const set = s => { invited = s; selL.clear(); selR.clear(); draw(); onChange(); };
  const add = ids => { const before = invited.size; const n = inviteAdd(invited, ids, Math.max(0, max - bots.length)); if (n.size - before < [].concat(ids).length) toast(tr('En çok {n} kişi davet edilebilir', { n: Math.max(0, max - bots.length) }), 'err'); set(n); };
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
    cntL.textContent = String(users.length - invited.size); cntR.textContent = `${invited.size + bots.length} / ${max}`;
    note.textContent = tr('Siz de oyuncusunuz: karşılaşma {n} kişi.', { n: invited.size + bots.length + 1 });
    const solo = invited.size + bots.length === 0 && soloAllowed(kind);
    soloNote.hidden = !solo; soloNote.textContent = solo ? `${FT('fpv.solo')} · ${FT('fpv.solo_hint')}` : '';
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
    botBox, note, soloNote);
  drawBots(); draw();
  return { el, values: () => [...invited], bots: () => bots.map(b => ({ level: b.level })),
    error: () => opponentsErrorSolo(invited.size, bots.length, kind, max, limits),   // §47 tek kişilik (it dalaşı hariç)
    setKind: k => { kind = k || 'rings'; draw(); },
    solo: () => invited.size + bots.length === 0 && soloAllowed(kind),
    names: () => [...users.filter(u => invited.has(u.id)).map(u => u.full_name), ...bots.map((b, i) => botName(b.level, i, { names: BN, T: tr }))], set: ids => set(new Set(ids)),
    setBots: arr => { bots = (arr || []).map(b => ({ level: b.level || b })); drawBots(); draw(); onChange(); },
    // §41 it dalaşı: tam 1 rakip (davetli ya da yapay zekâ; fazlası düşer)
    setMax: n => { max = Math.max(1, Number(n) || ((limits.players_max || 8) - 1)); if (bots.length > max) { bots = bots.slice(0, max); drawBots(); } if (invited.size + bots.length > max) set(new Set([...invited].slice(0, Math.max(0, max - bots.length)))); else draw(); } };
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
function dfResultsBody(match, me) {   // §41 it dalaşı sonucu: kazanan, sebep, angajman süresi / en yakın mesafe, roller
  const res = match.result || {}, d = res.dogfight || {};
  const rows = dfResultRows(match);
  const win = rows.find(r => r.won);
  const meWon = win && win.id === me, mePlayed = rows.some(r => r.id === me);
  return h('div', { class: 'fs-mt-res fs-df-res' },
    h('div', { class: 'fs-mt-win' }, h('span', { class: 'cup' }, win ? '🏆' : '🏁'),
      h('div', null, h('b', null, mePlayed && win ? DT(meWon ? 'df.you_win' : 'df.you_lose') + ' · ' + tr('Kazanan: {n}', { n: win.name }) : win ? tr('Kazanan: {n}', { n: win.name }) : tr('Kazanan yok')),
        h('div', { class: 'small muted' }, [DT(`df.r_${res.reason || match.reason}`), res.duration_s != null ? tr('Yarış süresi {t}', { t: fmtClock(res.duration_s) }) : null].filter(Boolean).join(' · ')))),
    h('div', { class: 'fs-df-stats small' }, [[DT('df.engage_time'), d.engage_s != null ? `${Number(d.engage_s).toFixed(1)} s` : '—'], [DT('df.max_hold'), d.max_hold_s != null ? `${Number(d.max_hold_s).toFixed(1)} / ${Number(d.need_s || 0).toFixed(1)} s` : '—'],
      [DT('df.min_dist'), fmtDist(d.min_dist_m)]].map(([k, v]) => h('span', { style: { marginRight: '14px' } }, h('span', { class: 'muted' }, `${k}: `), h('b', null, v)))),
    h('div', { class: 'tw' }, h('table', null,
      h('thead', null, h('tr', null, [DT('df.role'), 'Oyuncu', DT('df.result'), 'Azami hız', 'Çarpışma'].map(x => h('th', null, tr(x))))),
      h('tbody', null, rows.map(r => h('tr', { class: r.id === me ? 'me' : '', 'data-id': r.id },
        h('td', null, r.role ? h('span', { class: `fs-df-badge ${r.role}` }, DT(`df.${r.role}`)) : '—'),
        h('td', null, h('b', null, r.name), aiBadge((match.players || []).find(p => p.id === r.id) || r), r.id === me ? h('span', { class: 'small muted' }, ` (${tr('siz')})`) : null),
        h('td', null, h('span', { class: `badge ${r.won ? 'green' : 'red'}` }, DT(r.won ? 'df.won' : 'df.lost'))),
        h('td', { class: 'n' }, r.max_speed_ms != null ? `${Number(r.max_speed_ms).toFixed(1)} m/s` : '—'),
        h('td', { class: 'n' }, String(r.crashes ?? 0))))))));
}
export function resultsBody(match, me) {
  if (isDf(match)) return dfResultsBody(match, me);
  if (isFpv(match)) return fpvResultsBody(match, me, { aiBadge, statusText: r => (r.status === 'hazir' ? 'Yarıştı' : STATUS_TEXT[r.status] || r.status) });   // §47
  const res = match.result || null;
  const solo = matchIsSolo(match);   // §47 tek kişilik halka yarışı: "Kazanan" yerine "Tamamlandı · süre"
  const rows = res?.standings || liveStandings(match.players || []);
  const win = (match.players || []).find(p => p.id === (res?.winner ?? match.winner));
  const medal = r => h('span', { class: `rk rk${r}` }, String(r));
  return h('div', { class: 'fs-mt-res' },
    solo ? soloRingsHead(match, me, fmtClock) : h('div', { class: 'fs-mt-win' }, h('span', { class: 'cup' }, win ? '🏆' : '🏁'),
      h('div', null, h('b', null, win ? tr('Kazanan: {n}', { n: win.name }) : tr('Kazanan yok')),
        h('div', { class: 'small muted' }, [tr(REASON_TEXT[res?.reason || match.reason] || res?.reason || match.reason || ''), res?.duration_s != null ? tr('Yarış süresi {t}', { t: fmtClock(res.duration_s) }) : null].filter(Boolean).join(' · ')))),
    h('div', { class: 'tw' }, h('table', null,
      h('thead', null, h('tr', null, ['Sıra', 'Oyuncu', 'Süre', 'Halka', 'Sıradakine', 'Azami hız', 'Çarpışma', 'Durum'].map(x => h('th', null, x)))),
      h('tbody', null, rows.map(r => h('tr', { class: r.id === me ? 'me' : '', 'data-id': r.id },
        h('td', null, medal(r.rank ?? 0)), h('td', null, h('b', null, r.name), aiBadge(r), r.id === me ? h('span', { class: 'small muted' }, ` (${tr('siz')})`) : null),
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
  let sock = null, left = false, rematchId = null;   // §41 rövanş: rakibe salon bağlantısı
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
    clear(plist, (M.players || []).map(p => h('li', { 'data-status': p.status, 'data-id': p.id, 'data-bot': isBot(p) ? '1' : null },
      h('span', { class: `av ${isBot(p) ? 'bot' : ''}`, style: { background: colorFor(M.players, p.id) } }, isBot(p) ? '🤖' : initials(p.name),
        h('i', { class: online.has(p.id) || isBot(p) ? 'on' : '', title: tr(isBot(p) ? 'Yapay zekâ pilot' : online.has(p.id) ? 'Çevrimiçi' : 'Çevrimdışı') })),
      h('div', { class: 'grow' }, h('b', null, p.name), aiBadge(p), p.host ? h('span', { class: 'badge purple', style: { marginLeft: '6px' } }, 'Kurucu') : null,
        p.role ? h('span', { class: `fs-df-badge ${p.role}`, style: { marginLeft: '6px' } }, DT(`df.${p.role}`)) : null, p.id === me ? h('span', { class: 'small muted' }, ` (${tr('siz')})`) : null,
        p.drop_reason ? h('div', { class: 'small muted' }, tr(DROP_TEXT[p.drop_reason] || p.drop_reason)) : null),
      h('span', { class: `badge ${STATUS_TONE[p.status] || 'gray'}` }, tr(p.status === 'hazir' && ['YARIS', 'BITTI'].includes(M.state) ? (p.finished ? 'Bitirdi' : 'Yarıştı') : STATUS_TEXT[p.status] || p.status)),
      isHost() && !p.host && ACTIVE.has(p.status) && ['LOBI', 'HAZIRLIK'].includes(M.state) && M.live !== false
        ? h('button', { class: 'btn sm ghost', type: 'button', title: tr(isBot(p) ? 'Yapay zekâ pilotu kaldır' : 'Oyuncuyu çıkar'), onclick: async () => { if (isBot(p) || await confirmDialog(tr('Oyuncuyu çıkar'), tr('{n} karşılaşmadan çıkarılsın mı?', { n: p.name }), { okLabel: tr('Çıkar'), danger: true })) { try { M = await matchApi.kick(mid, p.id); draw(); } catch (err) { toastError(err); } } } }, '✕') : null)));
    // §44 kurucu salonda yapay zekâ pilot ekler (LOBI; oyuncu sınırı içinde, it dalaşında tek rakip)
    const nAct = (M.players || []).filter(p => ACTIVE.has(p.status)).length;
    if (isHost() && M.state === 'LOBI' && M.live !== false && nAct < (isDf(M) ? 2 : 8)) {
      const sel = h('select', { class: 'input', style: { width: 'auto' }, 'aria-label': tr('Seviye') }, BOT_LEVELS.map(l => h('option', { value: l, selected: l === 'normal' }, tr(BOT_LEVEL_TEXT[l]))));
      plist.append(h('li', { class: 'fs-mt-addbot', style: { borderStyle: 'dashed' } }, h('span', { class: 'av bot', style: { background: '#7c3aed' } }, '🤖'),
        h('div', { class: 'grow' }, h('b', null, tr('Yapay zekâ pilot ekle')), h('div', { class: 'small muted' }, tr('Bot kendi simülatöründe uçar; hazır sayılır'))), sel,
        h('button', { class: 'btn sm primary', type: 'button', onclick: async () => { try { M = { ...(await matchApi.addBot(mid, sel.value)), live: true }; draw(); } catch (err) { toastError(err); } } }, tr('+ Ekle'))));
    }
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
      isDf(M) && M.state === 'BITTI' && isHost() && M.live !== false ? h('button', { class: 'btn primary', type: 'button', onclick: async () => { try { const n = await matchApi.rematch(mid); toast(DT('df.rematch_open')); location.hash = matchHref(n.id); } catch (err) { toastError(err); } } }, DT('df.rematch')) : null,
      rematchId ? h('a', { class: 'btn primary', href: matchHref(rematchId) }, DT('df.rematch')) : null,
      h('a', { class: 'btn ghost', href: '#/drone/sim?tab=matches' }, 'Karşılaşmalar'));
  };
  const drawSum = () => {
    const s = M.settings || {}, r = M.rings_cfg || {}, w = s.world || {};
    const host = (M.players || []).find(p => p.host);
    const svg = h('div', { class: 'fs-mt-map', style: { marginTop: '10px' } }); svg.innerHTML = isDf(M) ? dfSvg(r, { T: DT }) : isFpv(M) ? '' : ringsSvg(M.rings || []);
    if (isFpv(M) && r.course_id) courseDetail(r.course_id, r.laps).then(d => { svg.innerHTML = courseSvg(d.course, { title: FT(`fpv.c_${r.course_id}`) }); }).catch(() => {});   // §47 parkur kuş bakışı
    const myRole = roleOf(M, me);
    clear(sum, h('h3', null, 'Karşılaşma ayarları'),
      h('dl', null,
        h('dt', null, 'Kurucu'), h('dd', null, host?.name || '—'),
        h('dt', null, 'Araç'), h('dd', null, tr(TYPE_NAME[s.type] || s.type || '—')),
        h('dt', null, 'Merkez'), h('dd', null, M.center?.name || '—'),
        h('dt', null, 'Dünya'), h('dd', null, [tr({ real: 'Gerçek arazi', google3d: 'Google 3B (fotogerçekçi)', procedural: 'Prosedürel' }[w.mode] || w.mode || '—'), w.time ? tr({ day: 'Gündüz', dusk: 'Akşam', night: 'Gece' }[w.time] || w.time) : null].filter(Boolean).join(' · ')),
        h('dt', null, DT('df.kind')), h('dd', null, kindName(M), matchIsSolo(M) ? h('span', { class: 'fs-fc-solo' }, FT('fpv.solo_badge')) : null),
        ...(isDf(M) ? [h('dt', null, DT('df.rules').split(':')[0]), h('dd', null, dfSummary(r, DT)),
          h('dt', null, DT('df.role')), h('dd', null, myRole ? h('span', { class: `fs-df-badge ${myRole}` }, DT(`df.${myRole}`)) : DT('df.role_pending'))]
          : isFpv(M) ? [h('dt', null, FT('fpv.course')), h('dd', null, FT(`fpv.c_${r.course_id}`)), h('dt', null, FT('fpv.rules')), h('dd', null, fpvRulesText(r, FT))]   // §47
            : [h('dt', null, 'Halkalar'), h('dd', null, ringsSummary(r))]),
        h('dt', null, 'Süre sınırı'), h('dd', null, tr('{n} dk', { n: r.time_limit_min ?? '—' })),
        h('dt', null, 'Oluşturuldu'), h('dd', null, typeof M.created_at === 'number' ? new Date(M.created_at * 1000).toLocaleString() : fmtDateTime(M.created_at))),
      svg, isDf(M) ? h('p', { class: 'small muted' }, DT('df.rules', { r: Math.round(r.range_m), c: Math.round(r.cone_deg), h: Number(r.hold_s).toFixed(1), t: r.time_limit_min, a: Math.round(r.area_radius_m), g: 60 })) : null,
      M.live !== false ? chat : null);
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
  if (M.live !== false && (!['BITTI', 'IPTAL'].includes(M.state) || (isDf(M) && M.state === 'BITTI'))) {   // §41: bitmiş it dalaşında rövanş bildirimi için
    sock = matchSocket(mid, {
      pong: (n, s, r) => clock.sample(n, s, r),
      message: m => {
        if (m.t === 'hello') { M = { ...m.match, live: true }; (m.chat || []).forEach(addChat); draw(); return; }
        if (m.t === 'match') { M = { ...m.match, live: true }; draw(); return; }
        if (m.t === 'chat') addChat(m);
        if (m.t === 'result') { M = { ...M, result: m.result }; draw(); }
        if (m.t === 'rematch' && m.host !== me) { rematchId = m.id; toast(DT('df.rematch_open')); drawActs(); }
      },
      fatal: () => {},
    });
  }
  const tick = setInterval(() => { if (M.state === 'LOBI') drawActs(); }, 5000);
  onLeave(() => { sock?.close(); clearInterval(tick); });
}

// ---------------------------------------------------------------- oturum ekranı katmanı
// stage: .fs-stage · getSim(): flightsim3d nesnesi · startIntro(): §29 giriş sekansı (3‑2‑1 + bip) — geri sayımın son 3 sn'sinde çağrılır
export function attachMatch({ stage, getSim, mid, me, sid, homeHref = '#/drone/sim?tab=matches', startIntro = () => {}, getTele = () => null, sfx = null, getRc = () => null, fpvMenu = null }) {
  ensureMatchCss();
  const clock = createClock();
  // §44 oyun efektleri: oturumun efekt yolu (motor sesi master'ı; ses kapsülü + uçuş uyarısı önceliği) ya da yedek bağlam
  const fx = sfx || createSfx({ fallbackVol: () => { const s = hepgoSound(); return s.on ? s.vol : 0; } });
  let prevRank = null, lastRankT = 0;
  let M = null, layer = null, worldReady = false, introDone = false, resultShown = false, disposed = false, dfHud = null;   // dfHud: §41 it dalaşı HUD'u
  let fpv = null;   // §47 FPV parkuru: 3B parkur + HUD + hayalet (flightsim_fpvcourse_ui.attachFpvMatch)
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
    layer.setRings(isFpv(M) ? [] : (M.rings || []));   // §47 FPV: kontrol noktaları match3d halkası DEĞİL — neon kapılar parkur katmanında
    syncPlayers();
    if (typeof window !== 'undefined') window.__fsMatch = { layer, get match() { return M; }, clock, get sim() { return getSim(); } };   // teşhis (görsel betikler)
  };
  const syncPlayers = () => layer?.setPlayers((M?.players || []).filter(p => ACTIVE.has(p.status)).map(p => ({ id: p.id, name: p.name, start: p.start, color: colorFor(M.players, p.id), plane: M.settings?.type === 'sabit_kanat' })));
  const ensureFpv = () => {   // §47
    if (!M || !isFpv(M) || fpv) return;
    fpv = attachFpvMatch({ stage, getSim, me, sfx: fx, getRc, getTele, fpvMenu });
    fpv.setMatch(M, clock.now());
  };
  const ensureDf = () => {   // §41: it dalaşında sıralama tablosu yerine rakip işaretçisi / angajman halkası / uyarı HUD'u
    if (!M || !isDf(M) || dfHud) return;
    dfHud = createDogfightHud(stage, { getSim, tr, me, sfx: fx });
    board.hidden = true;
    if (typeof window !== 'undefined') window.__fsDogfight = dfHud;
  };
  const drawBoard = () => {
    if (!M || isDf(M)) return;
    board.hidden = matchIsSolo(M);   // §47 tek kişilik: sıralama tablosu yok
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
        h('div', { class: 'small', style: { opacity: '.8' } }, st === 'GERI_SAYIM' ? (isDf(M) ? DT('df.wait_go') : isFpv(M) ? FT('fpv.wait_go') : tr('Kalkış serbest olunca halkaları sırayla geçin.')) : tr('{r} / {t} oyuncu hazır', { r: c.ready, t: c.total })),
        ph ? h('div', { class: 'big' }, String(Math.ceil(ph.remain))) : null,
        h('ul', null, (M.players || []).filter(p => ACTIVE.has(p.status) || p.status === 'dustu').map(p => h('li', null, h('span', { class: 'dot', style: { background: colorFor(M.players, p.id) } }),
          h('span', { style: { flex: '1' } }, p.name, p.id === me ? ` (${tr('siz')})` : ''), h('span', { class: `badge ${STATUS_TONE[p.status] || 'gray'}` }, tr(STATUS_TEXT[p.status] || p.status))))));
    } else wait.hidden = true;
  };
  const drawBar = () => {
    if (!M) return;
    const st = M.state;
    if (st === 'YARIS' && (isDf(M) || isFpv(M))) { bar.hidden = true; return; }   // §41 / §47: şerit kendi HUD'unda
    bar.hidden = false;
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
    // §44 puan: zafer / yenilgi sesi, sonra puan sayacı tıklamalarla artar, sonunda "coin"
    const res = M.result || {}, df = isDf(M), fp = isFpv(M), solo = matchIsSolo(M);
    const row = df ? dfResultRows(M).find(r => r.id === me) : (res.standings || []).find(r => r.id === me);
    const score = row ? (fp ? fpvPoints(fpv?.course, fpvRow(row).total, Number(M.rings_cfg?.laps) || null) : matchScore(row, df ? 'dogfight' : 'rings', res.dogfight || {})) : null;   // §47 FPV: par tur süresine göre
    const scoreEl = h('b', { 'data-score': score ?? '' }, '0');
    clear(resEl, h('div', { class: 'box', role: 'dialog', 'aria-modal': 'true' }, h('h2', { style: { marginTop: '0' } }, solo && fp ? `${FT('fpv.result_tt')} · #${M.id}` : tr('Karşılaşma sonucu · #{id}', { id: M.id })),
      score != null ? h('div', { class: 'fs-mt-score' }, h('span', { class: 'muted' }, tr('Puanınız')), scoreEl) : null, resultsBody(M, me),
      h('div', { class: 'acts' }, h('button', { class: 'btn', type: 'button', onclick: () => { resEl.hidden = true; } }, 'Kapat'),
        h('a', { class: 'btn primary', href: homeHref }, 'Karşılaşmalar'))));
    if (row) {
      const won = (res.winner ?? M.winner) === me;
      if (fp && row.new_pb) fx.play('pb');   // §47 kişisel rekor fanfarı
      else if (solo) fx.play(row.finished ? 'finish' : 'lose');   // §47 tek kişilik: kazanma/kaybetme yok
      else fx.play(won ? 'win' : 'lose');
      const steps = countSteps(score), t0 = won ? 1.1 : 1.3;
      steps.forEach((st, k) => setTimeout(() => { if (disposed) return; scoreEl.textContent = String(st.v); if (k === steps.length - 1) { if (st.v > 0) fx.play('coin'); } else fx.play('tick'); }, (t0 + st.t) * 1000));
    }
    try { if (document.fullscreenElement) document.exitFullscreen?.(); } catch { /* */ }
  };
  const rankSound = () => {   // §44 sıralama değişimi (halka geçişlerinde): öne geçince whoosh + ding, geride kalınca alçak ton
    if (!M || isDf(M) || M.state !== 'YARIS') return;
    const r = myRank(M.players, pos, me), ch = rankChange(prevRank, r);
    if (r != null) prevRank = r;
    if (ch && performance.now() - lastRankT > 1200) { lastRankT = performance.now(); fx.play(ch); }
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
      ensureDf(); dfHud?.update(M, clock.now());
      ensureFpv(); fpv?.setMatch(M, clock.now());   // §47
      if (prevState !== 'YARIS' && M.state === 'YARIS') flashMsg(isDf(M) ? (roleOf(M, me) === 'chaser' ? DT('df.go_chaser') : DT('df.go_evader')) : isFpv(M) ? FT('fpv.go') : tr('BAŞLA! Halkaları sırayla geçin'));
      if (M.state === 'BITTI' && M.result) showResult();
      drawBoard(); drawWait(); drawBar(); maybeIntro();
      return;
    }
    if (m.t === 'countdown' && M) { M.start_at = m.start_at; M.state = 'GERI_SAYIM'; drawWait(); maybeIntro(); return; }
    if (m.t === 'pos') {
      for (const p of m.p || []) pos[p.id] = p;
      layer?.pushPos(m);
      if (dfHud) { dfHud.setPos(m); dfHud.update(M, clock.now()); }
      if (layer && pos[me]) layer.setNext(pos[me].next ?? null);
      fpv?.event(m, clock.now());   // §47 sıradaki kapı + ceza
      return;
    }
    if (fpv && ['ring', 'lap', 'sector', 'miss', 'hit', 'reset', 'wrong_way', 'finish'].includes(m.t)) {   // §47 FPV olayları: HUD + 3B efekt + ses (HUD'da)
      if (m.t === 'ring') pos[m.id] = { ...(pos[m.id] || {}), rings: Math.max(Number(pos[m.id]?.rings) || 0, m.i), next: m.i + 1 > m.total ? null : m.i + 1 };
      if (m.t === 'ring' && m.id === me) { const cp = (M?.rings || []).find(c => c.i === m.i); if (cp?.lap > 0 || cp?.gate !== 0) fx.play('ring', { i: Math.min(16, cp?.gate || m.i), n: 16 }); }
      if (m.t === 'finish' && m.id !== me) flashMsg(tr('{n} bitirdi', { n: (M?.players || []).find(p => p.id === m.id)?.name || '' }), 'rgba(250,204,21,.95)');
      fpv.event(m, clock.now());
      if (m.t === 'ring') rankSound();
      return;
    }
    if (m.t === 'ring') {
      const nm = (M?.players || []).find(p => p.id === m.id)?.name || '';
      pos[m.id] = { ...(pos[m.id] || {}), rings: Math.max(Number(pos[m.id]?.rings) || 0, m.i), next: m.i + 1 > m.total ? null : m.i + 1 };
      if (m.id === me) { fx.play(m.i >= m.total ? 'finish' : 'ring', { i: m.i, n: m.total }); flashMsg(tr('Halka {i} / {n} ✓', { i: m.i, n: m.total })); layer?.setNext(m.i + 1 > m.total ? null : m.i + 1); }   // §44 yükselen ding / son halkada fanfar
      else if (m.i === m.total) flashMsg(tr('{n} son halkayı geçti', { n: nm }), 'rgba(250,204,21,.92)');
      rankSound();
      return;
    }
    if (m.t === 'wrong_way' && m.id === me) { flashMsg(tr('Ters yön! Halkayı ok yönünde geçin'), 'rgba(248,113,113,.95)'); fx.play('wrong'); return; }
    if (m.t === 'finish') { const nm = (M?.players || []).find(p => p.id === m.id)?.name || ''; flashMsg(m.id === me ? tr('BİTİRDİNİZ! {t}', { t: fmtClock(m.elapsed_s) }) : tr('{n} bitirdi', { n: nm }), 'rgba(250,204,21,.95)'); return; }
    if (m.t === 'result' && M) { M = { ...M, result: m.result, state: 'BITTI' }; dfHud?.update(M, clock.now()); fpv?.setMatch(M, clock.now()); showResult(); drawBar(); return; }
    if (m.t === 'dogfight' && M) {   // §41 olaylar: koniye giriş (kaçana uyarı), angaje, alan dışı, çarpma
      if (m.kind === 'engaged') flashMsg(DT('df.engaged'), 'rgba(239,68,68,.95)');   // §44 zafer/yenilgi sesi sonuçta
      else if (m.kind === 'area') flashMsg(DT('df.r_alan_disi'), 'rgba(248,113,113,.95)');
      else if (m.kind === 'crash') flashMsg(DT('df.r_carpti'), 'rgba(248,113,113,.95)');
      else if (m.kind === 'guard_off') flashMsg(DT('df.guard_off'));
      return;
    }
  };
  const sock = matchSocket(mid, { message: onMsg, pong: (n, s, r) => clock.sample(n, s, r), fatal: () => { clear(bar, tr('Karşılaşmaya bağlanılamadı')); } });
  const iv = setInterval(() => { ensureLayer(); drawBar(); drawBoard(); if (M?.state === 'GERI_SAYIM') drawWait(); maybeIntro(); fpv?.tick(clock.now()); }, 250);
  return {
    // 3B dünya kuruldu + oturum HAZIR → sunucuya `ready` (herkes hazır olunca geri sayım başlar)
    onWorldReady() { if (worldReady) return; worldReady = true; ensureLayer(); const send = () => sock.send({ t: 'ready' }); send(); setTimeout(send, 1500); setTimeout(send, 5000); maybeIntro(); },
    get state() { return M?.state || null; },
    get sfx() { return fx; },
    get fpv() { return fpv; },   // §47
    dispose() { disposed = true; clearInterval(iv); sock.close(); layer?.dispose(); fpv?.dispose(); if (!sfx) fx.dispose(); dfHud?.dispose(); if (window.__fsDogfight === dfHud) delete window.__fsDogfight; bar.remove(); board.remove(); wait.remove(); resEl.remove(); flash.remove(); if (window.__fsMatch?.layer === layer) delete window.__fsMatch; },
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
      h('thead', null, h('tr', null, ['#', 'Durum', DT('df.kind'), 'Kurucu', 'Araç', 'Oyuncular', 'Kazanan', 'Tarih', ''].map(x => h('th', null, x)))),
      h('tbody', null, rows.map(r => {
        const win = (r.players || []).find(p => p.id === r.winner);
        const act = ['LOBI', 'HAZIRLIK', 'GERI_SAYIM', 'YARIS'].includes(r.state) && r.live;
        return h('tr', null, h('td', null, `#${r.id}`),
          h('td', null, h('span', { class: `badge ${act ? 'green' : r.state === 'IPTAL' ? 'red' : 'gray'}` }, tr(STATE_TEXT[r.state] || r.state))),
          h('td', null, isFpv(r) ? FT('fpv.kind_short') : DT(isDf(r) ? 'df.kind_dogfight' : 'df.kind_rings'), matchIsSolo(r) ? h('span', { class: 'fs-fc-solo' }, FT('fpv.solo_badge')) : null),
          h('td', null, r.host_name || '—'), h('td', null, tr(TYPE_NAME[r.type] || r.type || '—')),
          h('td', null, (r.players || []).map(p => p.name).join(', ')), h('td', null, win ? h('b', null, win.name) : '—'),
          h('td', null, typeof r.created_at === 'number' ? new Date(r.created_at * 1000).toLocaleString() : fmtDateTime(r.created_at)),
          h('td', null, h('a', { class: `btn sm ${act ? 'primary' : ''}`, href: matchHref(r.id) }, act ? 'Salona git' : 'Sonuç')));
      })))));
  };
  refresh();
  return { el, refresh };
}
