// SIMUMAV › HAZIR FPV PARKURLARI arayüzü (docs/simumav.md §29; HEPGO docs/ucus-simulatoru.md §47). DOM; saf yardımcılar ortak
// /sim/flightsim_fpvcourse.js (kuş bakışı SVG, biçimler, metinler FPV_TEXTS → `fpv.*` anahtarları) + ./match_core.js (doğrulama, gövde, özet).
//   • Galeri kartı (courseCard): kuş bakışı önizleme (engeller + yarış hattı + kapılar), mekan, uzunluk, kapı sayısı, zorluk yıldızları, tur, rekor
//     (maskeli ad + süre), en iyim, FPV puanım. Kuş bakışı tam tanım ister → GET /api/fpv/courses/{cid} (önbellek).
//   • Ayrıntı (courseDetailEl): büyük önizleme + kapı türleri + hedef tur + TOP 10 skor tablosu ("siz" vurgusu) + en iyi tur / sektörlerim + "Uç" düğmesi.
//   • Sihirbaz adımları: createCourseStep (galeri + ayrıntı), createRulesStep (tur sayısı, çarpma kuralı, ceza süreleri, süre sınırı, hayalet),
//     createFpvMatchBox (çok oyunculu kurucunun "Tür ve kurallar" adımında FPV türü: galeri + kurallar).
//   • Sonuç (fpvResultEl): tek kişilikte "Zaman denemesi sonucu" (toplam, turlar, en iyi tur, sektörler, kaçırma/çarpma/ceza, KİŞİSEL REKOR rozeti +
//     önceki rekorla fark, skor tablosundaki yer); çok oyunculuda FPV sütunlu tablo. Tek kişilik halka yarışı başlığı (soloRingsHead).
//   • Parkur bölümü sekmesi (mountFpvTracks): galeri + ayrıntı sayfası (#/tracks/fpv[/<cid>]); "Uç (zaman denemesi)" → #/fly/fpv/<cid>.
import { h, clear } from './simui.js';
import { net } from './net.js';
import { t as tI } from '../i18n/i18n.js';
import { FPV_TEXTS, courseSvg, fmtDelta, fmtLap, fmtLen, ghostPref, makeFpvT, stars } from '/sim/flightsim_fpvcourse.js';
import { FPV_COURSE_IDS, LIMITS, fpvDefaultsSm, fpvErrorKey, fpvHref, fpvSummary, fpvTracksHref, isFpvType, isSoloMatch, lbPlace, fmtClock } from './match_core.js';

const tr = (k, p) => tI(k, p);
export const FT = makeFpvT(tr, true);   // fpv.* anahtarı (7 dil), yoksa ortak Türkçe metin
export const TT = (k, p, tx = null) => { const r = tr(k, p); return r && r !== k ? r : (tx ?? k); };
export const courseName = cid => FT(`fpv.c_${cid}`);
export const venueName = cid => FT(`fpv.v_${cid}`);
// Sunucunun Türkçe parkur adı (geçmiş listesi `track`) → seçili dildeki ad
const TR_NAME = Object.fromEntries(FPV_TEXTS.filter(([k]) => k.startsWith('fpv.c_')).map(([k, tx]) => [tx, k]));
export const localCourseName = name => (TR_NAME[name] ? FT(TR_NAME[name]) : name);

// ---------------------------------------------------------------- CSS (bir kez)
const CSS_URL = new URL('./fpv.css', import.meta.url).href;
export function ensureFpvCss() { if (!document.querySelector(`link[href="${CSS_URL}"]`)) document.head.append(h('link', { rel: 'stylesheet', href: CSS_URL })); }

// ---------------------------------------------------------------- simgeler (emoji fontu yok → SVG)
export const ICON = {
  flag: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 21V4" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path d="M5 4h11l-2 4 2 4H5z" fill="currentColor"/></svg>',
  cup: '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M7 3h10v2h3v3a4 4 0 0 1-4 4h-.3A5 5 0 0 1 13 14.9V17h3v3H8v-3h3v-2.1A5 5 0 0 1 8.3 12H8a4 4 0 0 1-4-4V5h3zm0 4H6v1a2 2 0 0 0 1 1.7zm10 0v2.7A2 2 0 0 0 18 8V7z"/></svg>',
  watch: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="13" r="8" fill="none" stroke="currentColor" stroke-width="2"/><path d="M12 13V9M9 2h6M19 6l1.5-1.5" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
  star: '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12 2l2.9 6.6 7.1.7-5.4 4.8 1.6 7L12 17.4 5.8 21l1.6-7L2 9.3l7.1-.7z"/></svg>',
  gate: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="5" width="16" height="14" rx="2" fill="none" stroke="currentColor" stroke-width="2.4"/></svg>',
  len: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 17c4-8 7 4 11-4s5-6 7-6" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>',
  laps: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 12a8 8 0 1 1-2.3-5.6M20 4v5h-5" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  ghost: '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12 2a8 8 0 0 0-8 8v12l3-2 2.5 2L12 20l2.5 2L17 20l3 2V10a8 8 0 0 0-8-8zm-3 7a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3zm6 0a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3z"/></svg>',
  solo: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="7" r="4" fill="currentColor"/><path d="M4 21c1-5 4-7 8-7s7 2 8 7z" fill="currentColor"/></svg>',
};
const ico = (k, cls = '') => h('i', { class: `sm-fc-ico ${cls}`, html: ICON[k] || '' });

// ---------------------------------------------------------------- API (önbellekli)
let coursesP = null;
const detailC = new Map();
export const fpvApi = {
  courses(fresh = false) { if (fresh) coursesP = null; return (coursesP ??= net.get('/api/fpv/courses').catch(e => { coursesP = null; throw e; })); },
  detail(cid, laps = null, fresh = false) {
    const k = `${cid}|${laps ?? ''}`;
    if (fresh) detailC.delete(k);
    if (!detailC.has(k)) detailC.set(k, net.get(`/api/fpv/courses/${encodeURIComponent(cid)}${laps ? `?laps=${encodeURIComponent(laps)}` : ''}`).catch(e => { detailC.delete(k); throw e; }));
    return detailC.get(k);
  },
  ghost: (cid, laps = null) => net.get(`/api/fpv/courses/${encodeURIComponent(cid)}/ghost${laps ? `?laps=${encodeURIComponent(laps)}` : ''}`),
  invalidate() { coursesP = null; detailC.clear(); },
};

// ---------------------------------------------------------------- galeri kartı
/** Kuş bakışı önizleme kutusu: tanım hazırsa hemen, değilse GET /api/fpv/courses/{cid} gelince doldurulur. */
export function previewBox(cid, { labels = false, cls = '', course = null } = {}) {
  const box = h('div', { class: `sm-fc-svg ${cls}`, 'data-course': cid }, h('span', { class: 'sm-fc-svg-wait' }));
  const fill = c => { box.innerHTML = courseSvg(c, { labels, decor: true, title: courseName(cid) }); };
  if (course?.gates) fill(course);
  else fpvApi.detail(cid).then(d => fill(d.course)).catch(() => box.classList.add('err'));
  return box;
}
const diffCls = d => `fcd${Math.max(1, Math.min(5, Number(d) || 1))}`;   // (.d3 kabukta 3B tuval sınıfı — çakışmasın)
/** c: GET /api/fpv/courses satırı. */
export function courseCard(c, { selected = false, onPick = null, compact = false } = {}) {
  const rec = c.record;
  const el = h('button', { type: 'button', class: `sm-fc-card ${selected ? 'sel' : ''} ${compact ? 'compact' : ''} ${diffCls(c.difficulty)}`, 'data-course': c.id, 'aria-pressed': selected ? 'true' : 'false',
    onclick: () => onPick?.(c) },
  previewBox(c.id),
  h('div', { class: 'sm-fc-card-b' },
    h('div', { class: 'sm-fc-card-t' }, h('b', null, courseName(c.id)), h('span', { class: `sm-fc-stars ${diffCls(c.difficulty)}`, title: `${FT('fpv.difficulty')}: ${FT(`fpv.d${c.difficulty}`)}` }, stars(c.difficulty))),
    h('small', { class: 'sm-fc-venue' }, venueName(c.id), ' · ', FT(`fpv.d${c.difficulty}`)),
    h('div', { class: 'sm-fc-chips' },
      h('span', null, ico('len'), fmtLen(c.length_m)), h('span', null, ico('gate'), FT('fpv.gates_n', { n: c.gate_count })), h('span', null, ico('laps'), FT('fpv.laps_n', { n: c.laps }))),
    compact ? null : h('div', { class: 'sm-fc-recs' },
      h('span', { class: 'rec', title: FT('fpv.record') }, ico('cup'), rec ? h('span', null, h('b', null, fmtLap(rec.time_s)), ' ', h('small', null, rec.name)) : h('small', { class: 'muted' }, FT('fpv.no_record'))),
      h('span', { class: 'mine', title: FT('fpv.my_best') }, ico('watch'), h('small', null, FT('fpv.my_best'), ': '), h('b', null, c.my_best != null ? fmtLap(c.my_best) : '—')),
      h('span', { class: 'pts', title: TT('fpvsm.points') }, ico('star'), h('b', null, TT('fpvsm.points_n', { n: Math.round(Number(c.points) || 0) }))))));
  return el;
}
export function galleryEl(courses, { selected = null, onPick = null, compact = false } = {}) {
  return h('div', { class: `sm-fc-gallery ${compact ? 'compact' : ''}`, role: 'list' }, (courses || []).map(c => courseCard(c, { selected: c.id === selected, onPick, compact })));
}

// ---------------------------------------------------------------- skor tablosu + en iyilerim
export function leaderboardEl(rows) {
  if (!rows?.length) return h('p', { class: 'muted small sm-fc-lb-empty' }, TT('fpvsm.lb_empty'));
  return h('table', { class: 'sm-fc-lb' },
    h('thead', null, h('tr', null, [FT('fpv.rank'), FT('fpv.pilot'), FT('fpv.time'), FT('fpv.best_lap'), FT('fpv.misses'), FT('fpv.hits'), FT('fpv.penalty')].map(x => h('th', null, x)))),
    h('tbody', null, rows.map(r => h('tr', { class: `${r.me ? 'me' : ''} r${r.rank}` },
      h('td', { class: 'rk' }, String(r.rank)), h('td', { class: 'nm' }, r.name, r.me ? h('span', { class: 'sm-fc-you' }, FT('fpv.you')) : null),
      h('td', { class: 'mono t' }, fmtLap(r.time_s)), h('td', { class: 'mono' }, fmtLap(r.best_lap_s)), h('td', { class: 'mono' }, String(r.misses ?? 0)), h('td', { class: 'mono' }, String(r.hits ?? 0)),
      h('td', { class: 'mono' }, r.penalty_s ? `+${Number(r.penalty_s).toFixed(1)}` : '0')))));
}
/** Sektör tablosu: satır = tur, sütun = sektör; her sütunun en iyisi mor (genel), kişisel en iyiye eşitse yeşil. */
export function sectorsEl(sectors, { pb = null } = {}) {
  const rows = (sectors || []).filter(r => Array.isArray(r) && r.length);
  if (!rows.length) return null;
  const n = Math.max(...rows.map(r => r.length));
  const best = Array.from({ length: n }, (_, j) => Math.min(...rows.map(r => Number(r[j])).filter(Number.isFinite)));
  return h('table', { class: 'sm-fc-sec' },
    h('thead', null, h('tr', null, h('th', null, ''), Array.from({ length: n }, (_, j) => h('th', null, FT('fpv.sector_n', { n: j + 1 }))))),
    h('tbody', null, rows.map((r, i) => h('tr', null, h('th', null, TT('fpvsm.lap_n', { n: i + 1 })),
      Array.from({ length: n }, (_, j) => { const v = Number(r[j]); const cls = !Number.isFinite(v) ? '' : (pb?.[j + 1] != null && v <= pb[j + 1] + 1e-9) ? 'purple' : v <= best[j] + 1e-9 ? 'green' : ''; return h('td', { class: `mono ${cls}` }, Number.isFinite(v) ? v.toFixed(3) : '—'); })))));
}
export function lapsEl(laps, best = null) {
  if (!laps?.length) return null;
  return h('div', { class: 'sm-fc-laps' }, laps.map((s, i) => h('span', { class: `lap ${best != null && Math.abs(Number(s) - Number(best)) < 1e-6 ? 'best' : ''}` }, h('small', null, TT('fpvsm.lap_n', { n: i + 1 })), h('b', { class: 'mono' }, fmtLap(s)))));
}
export function myBestEl(mb) {
  if (!mb) return h('p', { class: 'muted small' }, TT('fpvsm.no_my_best'));
  return h('div', { class: 'sm-fc-mybest' },
    h('div', { class: 'sm-fc-tiles' }, tile(FT('fpv.total_time'), fmtLap(mb.time_s), 'big'), tile(FT('fpv.best_lap'), fmtLap(mb.best_lap_s)), tile(FT('fpv.misses'), mb.misses ?? 0), tile(FT('fpv.hits'), mb.hits ?? 0),
      tile(FT('fpv.penalty'), `+${Number(mb.penalty_s || 0).toFixed(1)}`)),
    lapsEl(mb.lap_times, mb.best_lap_s), sectorsEl(mb.sectors));
}
const tile = (label, value, cls = '') => h('div', { class: `sm-fc-tile ${cls}` }, h('small', null, label), h('b', { class: 'mono' }, String(value)));

/** Ayrıntı: büyük kuş bakışı + bilgiler + TOP 10 + en iyilerim (+ "Uç (zaman denemesi)" düğmesi onFly verilirse). */
export function courseDetailEl(cid, { laps = null, onFly = null, summary = null, lapsPick = true } = {}) {
  const box = h('div', { class: 'sm-fc-detail', 'data-course': cid }, h('p', { class: 'muted' }, FT('fpv.loading')));
  // skor tablosu tur sayısına göre (sunucu: aynı tur sayısındaki kayıtlar) — başlıkta tur seçici; "Uç" o tur sayısıyla açılır
  const load = l => fpvApi.detail(cid, l).then(d => {
    const c = d.course, s = summary || {};
    const kinds = [...new Set((c.gates || []).map(g => g.kind))].filter(k => k !== 'start');
    clear(box,
      h('div', { class: 'sm-fc-detail-head' },
        h('div', null, h('h2', null, courseName(cid)), h('p', { class: 'muted' }, venueName(cid), ' · ', h('span', { class: `sm-fc-stars ${diffCls(c.difficulty)}` }, stars(c.difficulty)), ' ', FT(`fpv.d${c.difficulty}`))),
        h('div', { class: 'sm-fc-headacts' },
          lapsPick ? h('label', { class: 'sm-fc-lapsel' }, h('span', null, FT('fpv.laps')), h('select', { 'aria-label': FT('fpv.laps'), onchange: e => load(Number(e.target.value)) },
            Array.from({ length: 10 }, (_, i) => i + 1).map(n => h('option', { value: String(n), selected: n === Number(d.laps) }, String(n))))) : null,
          onFly ? h('button', { class: 'btn primary sm-fc-fly', type: 'button', onclick: () => onFly(cid, d.laps) }, ico('flag'), TT('fpvsm.fly_tt')) : null)),
      h('div', { class: 'sm-fc-detail-grid' },
        h('div', { class: 'sm-fc-detail-map' }, previewBox(cid, { labels: true, course: c, cls: 'big' }),
          h('div', { class: 'sm-fc-chips' }, h('span', null, ico('len'), fmtLen(c.length_m)), h('span', null, ico('gate'), FT('fpv.gates_n', { n: c.gate_count ?? c.gates?.length })),
            h('span', null, ico('laps'), FT('fpv.laps_n', { n: d.laps })), c.par_lap_s ? h('span', null, ico('watch'), TT('fpvsm.par'), ' ', fmtLap(c.par_lap_s)) : null,
            s.points != null ? h('span', { class: 'pts' }, ico('star'), TT('fpvsm.points_n', { n: Math.round(Number(s.points) || 0) })) : null),
          kinds.length ? h('div', { class: 'sm-fc-kinds' }, h('small', { class: 'muted' }, FT('fpv.kinds'), ': '), kinds.map(k => h('span', { class: `k k-${k}` }, FT(`fpv.k_${k}`)))) : null),
        h('div', { class: 'sm-fc-detail-side' },
          h('h3', null, ico('cup'), TT('fpvsm.lb_title')), leaderboardEl(d.leaderboard),
          h('h3', null, ico('watch'), TT('fpvsm.my_bests')), myBestEl(d.my_best))));
  }).catch(e => clear(box, h('p', { class: 'sm-mt-err' }, `${FT('fpv.load_err')}: ${e.message}`)));
  load(laps);
  return box;
}

// ---------------------------------------------------------------- sihirbaz: PARKUR adımı (galeri + ayrıntı)
export function createCourseStep({ W, courses, onChange = () => {} }) {
  const gal = h('div', { class: 'sm-fc-galhold' });
  const side = h('div', { class: 'sm-fc-side' });
  const draw = () => {
    clear(gal, galleryEl(courses, { selected: W.state.fpv.course_id, onPick: c => { if (c.id !== W.state.fpv.course_id) W.set('fpv', { course_id: c.id, laps: Number(c.laps) || W.state.fpv.laps }); draw(); onChange(); } }));
    const sel = courses.find(c => c.id === W.state.fpv.course_id);
    clear(side, sel ? courseDetailEl(sel.id, { summary: sel, laps: W.state.fpv.laps, lapsPick: false }) : h('p', { class: 'muted' }, FT('fpv.pick')));
  };
  draw();
  return { el: h('div', { class: 'sm-fc-step' }, h('p', { class: 'muted sm-fc-note' }, FT('fpv.world_note')), h('div', { class: 'sm-fc-two' }, gal, side)) };
}

// ---------------------------------------------------------------- sihirbaz: KURALLAR adımı
export function createRulesStep({ W, limits = null, onChange = () => {}, compact = false, ghost = true }) {
  const L = { ...LIMITS.fpv, ...(limits?.fpv || {}) };
  const F = () => W.state.fpv;   // W.set('fpv', …) yeni nesne kurar: her okumada güncel
  const errEl = h('p', { class: 'sm-mt-err', role: 'alert', hidden: true });
  const sumEl = h('p', { class: 'sm-fc-sum mono' });
  const gp = ghostPref();
  if (ghost) W.set('ghost', gp.get());
  const validate = () => {
    const e = fpvErrorKey(F(), W.drone()?.type ?? null, { fpv: L });
    W.set('fpv_err', e);
    errEl.hidden = !e; errEl.textContent = e ? TT(e, null, FT(e)) : '';
    sumEl.textContent = `${courseName(F().course_id)} · ${FT('fpv.summary_rules', { laps: F().laps, rule: FT(`fpv.rule_${F().crash_rule}`), cp: F().crash_penalty_s, mp: F().miss_penalty_s, tl: F().time_limit_min })}`;
    onChange(e);
  };
  const laps = h('div', { class: 'sm-mt-seg sm-fc-lapseg' });
  const drawLaps = () => clear(laps, Array.from({ length: L.laps[1] - L.laps[0] + 1 }, (_, i) => L.laps[0] + i).map(n => h('button', { type: 'button', class: Number(F().laps) === n ? 'on' : '', 'data-laps': String(n),
    onclick: () => { W.set('fpv', { laps: n }); drawLaps(); validate(); } }, String(n))));
  drawLaps();
  const rules = h('div', { class: 'sm-fc-rules', role: 'radiogroup', 'aria-label': FT('fpv.crash_rule') });
  const drawRules = () => clear(rules, L.crash_rules.map(r => h('button', { type: 'button', class: `sm-fc-rule ${F().crash_rule === r ? 'on' : ''}`, 'data-rule': r, role: 'radio', 'aria-checked': F().crash_rule === r ? 'true' : 'false',
    onclick: () => { W.set('fpv', { crash_rule: r }); drawRules(); validate(); } }, h('b', null, FT(`fpv.rule_${r}`)), compact ? null : h('small', null, FT(`fpv.rule_${r}_d`)))));
  drawRules();
  const num = (key, label, unit, [a, b], step = 1) => {
    const inp = h('input', { type: 'number', min: a, max: b, step, value: F()[key], 'data-k': key, inputmode: 'decimal' });
    const rng = h('input', { type: 'range', min: a, max: b, step, value: F()[key], 'aria-label': label });
    const set = v => { W.set('fpv', { [key]: v === '' ? '' : Number(v) }); inp.value = String(W.state.fpv[key]); rng.value = String(W.state.fpv[key]); validate(); };
    inp.addEventListener('input', () => set(inp.value)); rng.addEventListener('input', () => set(rng.value));
    return h('label', { class: 'sm-mt-field' }, h('span', null, label), rng, h('span', { class: 'sm-mt-num' }, inp, unit ? h('small', null, unit) : null));
  };
  const ghostSeg = ghost ? h('div', { class: 'sm-mt-seg sm-fc-ghostseg' }) : null;
  const drawGhost = () => ghostSeg && clear(ghostSeg, ['pb', 'off'].map(v => h('button', { type: 'button', class: W.state.ghost === v ? 'on' : '', 'data-ghost': v,
    onclick: () => { W.set('ghost', gp.set(v)); drawGhost(); } }, v === 'pb' ? [ico('ghost'), FT('fpv.ghost_pb')] : FT('fpv.ghost_off'))));
  drawGhost();
  const form = h('div', { class: `sm-fc-rulesbox ${compact ? 'compact' : ''}` },
    compact ? null : h('h2', null, ico('flag'), FT('fpv.rules')),
    h('div', { class: 'sm-mt-form' },
      h('div', { class: 'sm-mt-field col' }, h('span', null, FT('fpv.laps')), laps),
      h('div', { class: 'sm-mt-field col' }, h('span', null, FT('fpv.crash_rule')), rules),
      num('crash_penalty_s', FT('fpv.crash_pen'), 's', L.penalty_s, 0.5),
      num('miss_penalty_s', FT('fpv.miss_pen'), 's', L.penalty_s, 0.5),
      num('time_limit_min', FT('fpv.time_limit'), tr('match.unit_min'), L.time_limit_min),
      ghost ? h('div', { class: 'sm-mt-field col' }, h('span', null, FT('fpv.ghost')), ghostSeg, h('small', { class: 'muted' }, FT('fpv.ghost_d'))) : null),
    sumEl, errEl);
  // tam adımda sağda seçili parkurun büyük kuş bakışı önizlemesi
  const el = compact ? form : h('div', { class: 'sm-fc-two sm-fc-rulesstep' }, form,
    h('div', { class: 'sm-fc-mbig' }, previewBox(F().course_id, { labels: true, cls: 'big' }), h('b', null, courseName(F().course_id)), h('small', { class: 'muted' }, venueName(F().course_id))));
  validate();
  return { el, validate };
}

// ---------------------------------------------------------------- çok oyunculu kurucu: "Tür ve kurallar" adımında FPV türü
export function createFpvMatchBox({ W, limits = null, onChange = () => {} }) {
  const box = h('div', { class: 'sm-fc-mbox' }, h('p', { class: 'muted' }, FT('fpv.loading')));
  const warn = h('p', { class: 'sm-mt-err sm-fc-typewarn', role: 'alert', hidden: true });
  let rulesUi = null;
  const refresh = () => {
    const bad = !isFpvType(W.drone()?.type, limits || LIMITS);
    warn.hidden = !bad; warn.textContent = bad ? TT('fpvsm.type_warn') : '';
    rulesUi?.validate();
  };
  fpvApi.courses().then(r => {
    const courses = r.courses || [];
    if (!courses.some(c => c.id === W.state.fpv.course_id) && courses[0]) W.set('fpv', fpvDefaultsSm(courses[0], limits || LIMITS));
    const gal = h('div', { class: 'sm-fc-galhold' });
    const big = h('div', { class: 'sm-fc-mbig' });
    const drawGal = () => {
      clear(gal, galleryEl(courses, { compact: true, selected: W.state.fpv.course_id, onPick: c => { if (c.id !== W.state.fpv.course_id) W.set('fpv', { course_id: c.id, laps: Number(c.laps) || W.state.fpv.laps }); drawGal(); rulesUi = createRulesStep({ W, limits, onChange, compact: true }); clear(rulesHold, rulesUi.el); refresh(); } }));
      clear(big, previewBox(W.state.fpv.course_id, { labels: true, cls: 'big' }), h('b', null, courseName(W.state.fpv.course_id)), h('small', { class: 'muted' }, venueName(W.state.fpv.course_id)));
    };
    const rulesHold = h('div');
    rulesUi = createRulesStep({ W, limits, onChange, compact: true });
    rulesHold.append(rulesUi.el);
    drawGal();
    clear(box, warn, h('div', { class: 'sm-fc-two' }, h('div', null, h('h2', null, ico('flag'), FT('fpv.gallery')), gal), h('div', null, big, rulesHold)));
    refresh();
  }).catch(e => clear(box, h('p', { class: 'sm-mt-err' }, `${FT('fpv.load_err')}: ${e.message}`)));
  return { el: box, refresh };
}

// ---------------------------------------------------------------- sonuç
/** Tek kişilik halka yarışı başlığı. */
export function soloRingsHead(M, me) {
  const res = M.result || {}, r = (res.standings || []).find(x => x.id === me) || (M.players || []).find(x => x.id === me);
  const done = !!r?.finished || r?.time_s != null;
  return h('div', { class: 'sm-fc-reshead' }, ico('flag', 'big'), h('div', null, h('b', null, FT('fpv.ring_solo')),
    h('div', { class: 'muted small' }, done ? FT('fpv.ring_done', { t: fmtClock(r.time_s ?? res.duration_s) }) : FT('fpv.not_done', { i: r?.rings ?? 0, n: r?.total ?? res.total ?? (M.rings || []).length }))));
}
/** FPV sonucu (yarış ekranı penceresi + salon). img(players, row) → avatar öğesi (isteğe bağlı). */
export function fpvResultEl(M, me, { img = null, aiTag = () => null } = {}) {
  const res = M.result || {}, cfg = res.fpv || M.rings_cfg || {}, cid = cfg.course_id, laps = Number(cfg.laps) || null;
  const rows = (res.standings || []).length ? res.standings : [...(M.players || [])].sort((a, b) => (a.rank ?? 99) - (b.rank ?? 99));
  const solo = isSoloMatch(M);
  const course = h('p', { class: 'sm-fc-rescourse' }, ico('flag'), h('b', null, cid ? courseName(cid) : '—'), ' · ', FT('fpv.laps_n', { n: laps ?? '—' }), ' · ', FT(`fpv.rule_${cfg.crash_rule || 'penalty'}`));
  if (solo) {
    const r = rows.find(x => x.id === me) || rows[0] || {};
    const S = fpvSummary(r);
    const place = h('p', { class: 'sm-fc-place muted' });
    if (cid && S.finished) fpvApi.detail(cid, laps, true).then(d => { const p = lbPlace(d.leaderboard); place.textContent = p ? FT('fpv.lb_place', { r: p.rank, n: p.n }) : ''; }).catch(() => {});
    const pbLine = S.newPb ? (S.pbPrev != null ? FT('fpv.pb_prev', { t: fmtLap(S.pbPrev), d: fmtDelta(S.pbDelta) }) : FT('fpv.pb_first'))
      : S.pbPrev != null && S.finished ? FT('fpv.pb_keep', { t: fmtLap(S.pbPrev), d: fmtDelta(S.pbDelta) }) : null;
    return h('div', { class: `sm-fc-res solo ${S.newPb ? 'pb' : ''}`, 'data-new-pb': S.newPb ? '1' : '0' },
      h('div', { class: 'sm-fc-reshead' }, ico('watch', 'big'), h('div', null, h('b', null, FT('fpv.result_tt')), course)),
      S.newPb ? h('div', { class: 'sm-fc-pb', role: 'status' }, ico('cup'), h('b', null, FT('fpv.new_pb'))) : null,
      h('div', { class: 'sm-fc-tiles' },
        tile(FT('fpv.total_time'), S.finished ? fmtLap(S.total) : FT('fpv.dnf'), 'big'), tile(FT('fpv.best_lap'), fmtLap(S.best)),
        tile(FT('fpv.misses'), S.misses), tile(FT('fpv.hits'), S.hits), tile(FT('fpv.penalty'), `+${S.pen.toFixed(1)}`)),
      pbLine ? h('p', { class: `sm-fc-pbline ${S.newPb ? 'up' : ''}` }, pbLine) : null, place,
      S.laps.length ? h('h4', null, FT('fpv.lap_times')) : null, lapsEl(S.laps, S.best),
      S.sectors.length ? h('h4', null, FT('fpv.sectors')) : null, sectorsEl(S.sectors));
  }
  return h('div', { class: 'sm-fc-res multi' },
    h('div', { class: 'sm-fc-reshead' }, ico('flag', 'big'), h('div', null, h('b', null, TT('fpvsm.result_mp')), course)),
    h('table', { class: 'sm-mt-table sm-fc-restable' },
      h('thead', null, h('tr', null, ['#', tr('match.col_player'), FT('fpv.time'), FT('fpv.best_lap'), TT('fpvsm.col_laps'), FT('fpv.misses'), FT('fpv.hits'), FT('fpv.penalty'), tr('match.col_status')].map(x => h('th', null, x)))),
      h('tbody', null, rows.map((r, i) => {
        const S = fpvSummary(r);
        return h('tr', { class: `${r.id === me ? 'me' : ''} ${res.winner === r.id ? 'win' : ''}`.trim() },
          h('td', null, res.winner === r.id ? '★' : String(r.rank ?? i + 1)), h('td', null, img ? img(M.players, r) : null, h('b', null, r.name), aiTag(r), S.newPb ? h('span', { class: 'sm-fc-pbmini' }, FT('fpv.ghost_pb')) : null),
          h('td', { class: 'mono' }, S.finished ? fmtLap(S.total) : '—'), h('td', { class: 'mono' }, fmtLap(S.best)), h('td', { class: 'mono' }, `${S.lapsDone}/${laps ?? '—'}`),
          h('td', { class: 'mono' }, String(S.misses)), h('td', { class: 'mono' }, String(S.hits)), h('td', { class: 'mono' }, `+${S.pen.toFixed(1)}`),
          h('td', null, h('span', { class: `sm-mt-badge ${S.finished ? 'st-hazir' : 'st-dustu'}` }, S.finished ? FT('fpv.completed') : FT('fpv.dnf'))));
      }))));
}
/** Tek kişilik rozeti (salon / geçmiş / sonuç). */
export const soloBadge = () => h('span', { class: 'sm-fc-solo' }, ico('solo'), FT('fpv.solo_badge'));

// ---------------------------------------------------------------- Parkur bölümü: "Hazır FPV parkurları" sekmesi
export async function mountFpvTracks(holder, { go = hh => { location.hash = hh; }, course = null } = {}) {
  ensureFpvCss();
  clear(holder, h('p', { class: 'muted' }, FT('fpv.loading')));
  let r;
  try { r = await fpvApi.courses(true); } catch (e) { clear(holder, h('p', { class: 'sm-mt-err' }, `${FT('fpv.load_err')}: ${e.message}`)); return; }
  const courses = r.courses || [];
  const onFly = (cid, laps) => { try { sessionStorage.setItem('sm.fpv.laps', JSON.stringify({ cid, laps })); } catch { /* */ } go(fpvHref(cid)); };
  if (course && FPV_COURSE_IDS.includes(course)) {
    const sel = courses.find(c => c.id === course) || null;
    clear(holder, h('div', { class: 'sm-fc-page' }, courseDetailEl(course, { onFly, summary: sel })));   // geri: kabuğun "‹ Parkurlar" düğmesi
    return;
  }
  clear(holder, h('div', { class: 'sm-fc-page' }, galleryEl(courses, { onPick: c => go(fpvTracksHref(c.id)) })));   // açıklama ekran alt başlığında
}
