// Uçuş Simülatörü §47 — HAZIR FPV PARKURLARI arayüzü (YALNIZ HEPGO DOM'u; ortak saf/3B/HUD modülleri flightsim_fpvcourse*.js). SIMUMAV kendi arayüzünü
// yazar; bu dosyadaki `courseSvg` / `galleryCard` / `fpvResultRows` gibi saf kısımlar flightsim_fpvcourse.js'tedir.
// • createFpvSection: "Yeni Karşılaşma" sihirbazının "Tür ve kurallar" adımında FPV kartı seçilince: Hazır parkurlar GALERİSİ (kuş bakışı önizleme, mekan,
//   uzunluk, kapı sayısı, zorluk yıldızı, rekor / en iyim) + seçili parkurun büyük önizlemesi ve firma içi skor tablosu + tur sayısı, çarpma kuralı
//   (Cezalı / Başlangıca dön / Devam), ceza süreleri, süre sınırı, hayalet (kişisel rekor | kapalı); FPV olmayan araç tipinde uyarı.
// • openFpvTimeTrial: "Yeni Simülasyon Başlat" penceresindeki "Hazır FPV parkurları" kartı → galeri penceresi → "Zaman denemesi başlat" =
//   tek kişilik FPV karşılaşması (POST /matches kind 'fpv', invite [], bots []) → salon (oturum ekranına kendiliğinden geçer).
// • attachFpvMatch: oturum ekranında kind 'fpv' karşılaşması — 3B parkur katmanı (createFpvCourseLayer) + HUD (createFpvCourseHud) + kişisel rekor hayaleti.
// • fpvResultsBody: sonuç ekranı (tek kişilikte "Zaman denemesi sonucu": toplam, turlar, en iyi tur, sektörler, kaçırma/çarpma/ceza, KİŞİSEL REKOR rozeti
//   + önceki rekorla fark, skor tablosunda yeriniz; çok oyunculuda tablo + FPV sütunları).
import { api } from '../api.js';
import { clear, h, toast, t as tr } from '../ui.js';
import { numSlider } from './fs_inputs.js';
import { FPV_LIMITS, courseSvg, decodeGhost, fmtDelta, fmtLap, fpvBody, fpvDefaults, fpvError, fpvRow, fpvRulesText, galleryCard, ghostPref, isFpvType, leaderboardPlace,
  makeFpvT, matchIsSolo, pbDelta, sectorClass, sectorTimesFromSplits, bestSectors } from './flightsim_fpvcourse.js';
import { createFpvCourseLayer } from './flightsim_fpvcourse3d.js';
import { createFpvCourseHud } from './flightsim_fpvcourse_hud.js';

export const FT = makeFpvT(tr, false);   // HEPGO: Türkçe anahtar → tr()
const API = '/api/drone/sim/fpv';
export const fpvApi = {
  courses: () => api.get(`${API}/courses`),
  course: (cid, laps = null) => api.get(`${API}/courses/${encodeURIComponent(cid)}${laps ? `?laps=${encodeURIComponent(laps)}` : ''}`),
  ghost: (cid, laps = null, uid = null) => api.get(`${API}/courses/${encodeURIComponent(cid)}/ghost?${new URLSearchParams({ ...(laps ? { laps } : {}), ...(uid ? { user_id: uid } : {}) })}`),
};
const detailCache = new Map();   // cid|laps → {course, leaderboard, my_best}
export const courseDetail = async (cid, laps = null, fresh = false) => {
  const k = `${cid}|${laps || ''}`;
  if (fresh || !detailCache.has(k)) detailCache.set(k, fpvApi.course(cid, laps).catch(e => { detailCache.delete(k); throw e; }));
  return detailCache.get(k);
};
const TROPHY = '<svg viewBox="0 0 24 24" width="40" height="40" aria-hidden="true"><path d="M7 3h10v5a5 5 0 0 1-10 0z" fill="#facc15" stroke="#a16207" stroke-width="1.2"/><path d="M7 5H4a3 3 0 0 0 3 4M17 5h3a3 3 0 0 1-3 4" fill="none" stroke="#a16207" stroke-width="1.4"/><path d="M12 13v4M8 21h8l-1-4H9z" fill="#eab308" stroke="#a16207" stroke-width="1.2"/></svg>';
const FLAG = '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M5 21V4" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path d="M5 4h13l-2.5 4L18 12H5z" fill="currentColor" opacity=".25"/><path d="M5 4h4v4H5zM13 4h4l-2 4h-2zM9 8h4v4H9z" fill="currentColor"/></svg>';
export const FLAG_SVG = FLAG;

// ---------------------------------------------------------------- CSS
let cssDone = false;
export function ensureFpvUiCss() {
  if (cssDone || typeof document === 'undefined') return;
  cssDone = true;
  const st = document.createElement('style'); st.dataset.fs = 'fpvcourse';
  st.textContent = `
.fs-fc-box{display:grid;grid-template-columns:minmax(0,1.25fr) minmax(260px,1fr);gap:16px;align-items:start}
.fs-fc-box[hidden]{display:none}
@media (max-width:900px){.fs-fc-box{grid-template-columns:1fr}}
.fs-fc-gal{display:grid;grid-template-columns:repeat(auto-fill,minmax(205px,1fr));gap:10px}
.fs-fc-card{display:flex;flex-direction:column;gap:0;padding:0;border-radius:12px;border:1.5px solid var(--border);background:var(--card,#fff);color:inherit;cursor:pointer;text-align:left;overflow:hidden}
.fs-fc-card.on{border-color:#22c55e;box-shadow:0 0 0 2px rgba(34,197,94,.35)}
.fs-fc-card:hover{border-color:color-mix(in srgb,#22c55e 60%,var(--border))}
.fs-fc-thumb{background:#0f172a;aspect-ratio:16/9;display:grid;place-items:center;overflow:hidden}
.fs-fc-thumb svg{width:100%;height:100%;display:block}
.fs-fc-meta{padding:7px 9px 8px;display:flex;flex-direction:column;gap:2px}
.fs-fc-meta b{font-size:13.5px}.fs-fc-meta small{color:var(--muted);font-size:11.5px}
.fs-fc-stats{display:flex;gap:8px;flex-wrap:wrap;font-size:11.5px;color:var(--muted)}
.fs-fc-stats .stars{color:#f59e0b;letter-spacing:1px}
.fs-fc-rec{font-size:11.5px}.fs-fc-rec .t{font-variant-numeric:tabular-nums;font-weight:700}
.fs-fc-ttmodal{width:min(1280px,96vw)!important;max-width:96vw!important}
.fs-fc-side{position:sticky;top:0;border:1px solid var(--border);border-radius:12px;padding:10px;background:var(--bg-soft,rgba(127,127,127,.05));display:flex;flex-direction:column;gap:8px}
.fs-fc-big{background:#0f172a;border-radius:10px;overflow:hidden}.fs-fc-big svg{width:100%;height:auto;display:block;max-height:300px}
.fs-fc-chips{display:flex;gap:5px;flex-wrap:wrap}.fs-fc-chips span{font-size:11px;padding:1px 7px;border-radius:999px;border:1px solid var(--border)}
.fs-fc-lb{width:100%;border-collapse:collapse;font-size:12.5px}.fs-fc-lb th,.fs-fc-lb td{padding:4px 6px;border-bottom:1px solid rgba(127,127,127,.22);text-align:left;white-space:nowrap}
.fs-fc-lb td.n{font-variant-numeric:tabular-nums}.fs-fc-lb tr.me td{background:color-mix(in srgb,#22c55e 14%,transparent)}
.fs-fc-opts{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:4px 16px;margin-top:10px}
.fs-fc-rules{display:inline-flex;border:1px solid var(--border);border-radius:9px;overflow:hidden}
.fs-fc-rules button{border:0;background:transparent;color:inherit;padding:6px 11px;cursor:pointer;font:600 12.5px system-ui,sans-serif}
.fs-fc-rules button.on{background:#16a34a;color:#fff}
.fs-fc-warn{padding:8px 10px;border-radius:10px;background:color-mix(in srgb,#f59e0b 16%,transparent);border:1px solid #f59e0b;font-size:13px}
.fs-fc-ttbtn{display:flex;gap:10px;align-items:center;text-align:left;padding:9px 12px;border-radius:12px;border:1.5px dashed #22c55e;background:color-mix(in srgb,#22c55e 7%,transparent);color:inherit;cursor:pointer;margin-top:8px;width:100%}
.fs-fc-ttbtn b{display:block;font-size:14px}.fs-fc-ttbtn small{color:var(--muted)}
.fs-fc-ttbtn .ico{color:#16a34a;display:grid;place-items:center}
.fs-fc-tt{display:flex;flex-direction:column;gap:12px}
.fs-fc-tt .row{display:flex;gap:10px;flex-wrap:wrap;align-items:center}
.fs-fc-types{display:inline-flex;border:1px solid var(--border);border-radius:9px;overflow:hidden}.fs-fc-types button{border:0;background:transparent;color:inherit;padding:6px 11px;cursor:pointer;font:600 12.5px system-ui,sans-serif}.fs-fc-types button.on{background:#0f766e;color:#fff}
.fs-fc-res .pb{display:inline-flex;gap:8px;align-items:center;padding:6px 14px;border-radius:999px;font-weight:900;letter-spacing:.06em;color:#422006;background:linear-gradient(120deg,#fde047,#f59e0b);box-shadow:0 0 22px rgba(250,204,21,.55);animation:fsFcPb 1.2s ease-in-out 3}
@keyframes fsFcPb{50%{transform:scale(1.06)}}
.fs-fc-res .tot{font-size:34px;font-weight:900;font-variant-numeric:tabular-nums}
.fs-fc-res .kv{display:flex;gap:16px;flex-wrap:wrap;font-size:13px;margin:6px 0 10px}.fs-fc-res .kv b{font-variant-numeric:tabular-nums}
.fs-fc-res .laps{display:flex;gap:6px;flex-wrap:wrap;margin:4px 0 8px}.fs-fc-res .laps span{padding:3px 9px;border-radius:8px;border:1px solid var(--border);font-variant-numeric:tabular-nums;font-size:13px}
.fs-fc-res .laps span.best{border-color:#a855f7;background:color-mix(in srgb,#a855f7 14%,transparent);font-weight:800}
.fs-fc-res .secs{display:grid;grid-template-columns:auto repeat(var(--n),minmax(64px,1fr));gap:4px;font-size:12.5px;align-items:center;margin-bottom:10px}
.fs-fc-res .secs span{padding:2px 6px;border-radius:6px;text-align:center;font-variant-numeric:tabular-nums}
.fs-fc-res .secs span.green{background:#15803d;color:#fff}.fs-fc-res .secs span.purple{background:#7e22ce;color:#fff}.fs-fc-res .secs span.yellow{background:#a16207;color:#fff}
.fs-dim{opacity:.45}
.fs-fc-solo{display:inline-block;margin-left:6px;padding:1px 7px;border-radius:7px;font-weight:800;font-size:11px;color:#fff;background:#0f766e;vertical-align:middle}
`;
  document.head.append(st);
}

// ---------------------------------------------------------------- galeri kartı
// yıldız dizesi h() ile verilirse baştaki ★ simgeye dönüştürülür (ui.js emoji → FA) — metin doğrudan
const starsEl = d => { const e = h('span', { class: 'stars', title: `${FT('fpv.difficulty')}: ${d.difficultyName}` }); e.textContent = d.stars; return e; };
export function galleryCardEl(c, { selected = false, onPick = null, detail = null } = {}) {
  const d = galleryCard(c, FT);
  const thumb = h('div', { class: 'fs-fc-thumb' }, h('span', { class: 'small muted' }, '…'));
  if (detail?.course) thumb.innerHTML = courseSvg(detail.course, { labels: false, title: d.name });
  return h('button', { type: 'button', class: `fs-fc-card ${selected ? 'on' : ''}`, 'data-course': c.id, onclick: () => onPick?.(c.id) },
    thumb,
    h('div', { class: 'fs-fc-meta' }, h('b', null, d.name), h('small', null, d.venue),
      h('div', { class: 'fs-fc-stats' }, h('span', null, d.length), h('span', null, d.gatesText), h('span', null, d.lapsText), starsEl(d)),
      h('div', { class: 'fs-fc-rec' }, d.record ? [h('span', { class: 'muted' }, `${FT('fpv.record')}: `), h('span', { class: 't' }, d.record.time), ` · ${d.record.name}`] : h('span', { class: 'muted' }, FT('fpv.no_record')),
        d.myBest ? [h('br'), h('span', { class: 'muted' }, `${FT('fpv.my_best')}: `), h('span', { class: 't' }, d.myBest)] : null)));
}
export function leaderboardEl(rows, me = null) {
  if (!rows?.length) return h('p', { class: 'small muted' }, FT('fpv.lb_empty'));
  return h('table', { class: 'fs-fc-lb' },
    h('thead', null, h('tr', null, [FT('fpv.rank'), FT('fpv.pilot'), FT('fpv.time'), FT('fpv.best_lap'), FT('fpv.penalty')].map(x => h('th', null, x)))),
    h('tbody', null, rows.map(r => h('tr', { class: r.user_id === me ? 'me' : '' }, h('td', null, `${r.rank}.`), h('td', null, r.name, r.user_id === me ? ` (${FT('fpv.you')})` : ''),
      h('td', { class: 'n' }, fmtLap(r.time_s)), h('td', { class: 'n' }, fmtLap(r.best_lap_s)), h('td', { class: 'n' }, r.penalty_s ? `+${Number(r.penalty_s).toFixed(1)}` : '—')))));
}

// ---------------------------------------------------------------- ortak: galeri + seçili parkur + ayarlar
// opts: {limits, getType, me, initial, onChange, compact}
export function createFpvSection({ limits = null, getType = () => 'multirotor', me = null, initial = null, onChange = () => {} } = {}) {
  ensureFpvUiCss();
  const L = { ...FPV_LIMITS, ...(limits || {}) };
  let courses = null, C = { ...fpvDefaults(null, L), ...(initial || {}) };
  const gp = ghostPref();
  let ghost = gp.get();
  const gal = h('div', { class: 'fs-fc-gal' }, h('div', { class: 'small muted' }, FT('fpv.loading')));
  const side = h('div', { class: 'fs-fc-side' });
  const warn = h('div', { class: 'fs-fc-warn', hidden: true }, FT('fpv.type_warn'));
  const sl = {};
  const mk = (key, label, [a, b], step, unit, integer = false) => { sl[key] = numSlider({ h, label, value: C[key], min: a, max: b, step, unit, integer, cls: 'fs-slider', onInput: v => { C[key] = v; changed(); } }); return sl[key].el; };
  const ruleBtns = L.crash_rules.map(r => h('button', { type: 'button', 'data-rule': r, onclick: () => { C.crash_rule = r; drawRules(); changed(); } }, FT(`fpv.rule_${r}`)));
  const ruleNote = h('div', { class: 'small muted' });
  const drawRules = () => { ruleBtns.forEach(b => b.classList.toggle('on', b.dataset.rule === C.crash_rule)); ruleNote.textContent = FT(`fpv.rule_${C.crash_rule}_d`); sl.crash_penalty_s?.el.classList.toggle('fs-dim', C.crash_rule !== 'penalty'); };
  const ghostBtns = ['pb', 'off'].map(v => h('button', { type: 'button', 'data-ghost': v, onclick: () => { ghost = gp.set(v); drawGhost(); } }, FT(v === 'pb' ? 'fpv.ghost_pb' : 'fpv.ghost_off')));
  const drawGhost = () => ghostBtns.forEach(b => b.classList.toggle('on', b.dataset.ghost === ghost));
  const opts = h('div', null,
    h('div', { class: 'fs-fc-opts' }, mk('laps', FT('fpv.laps'), L.laps, 1, '', true), mk('crash_penalty_s', FT('fpv.crash_pen'), L.penalty_s, 0.5, 'sn'), mk('miss_penalty_s', FT('fpv.miss_pen'), L.penalty_s, 0.5, 'sn'),
      mk('time_limit_min', FT('fpv.time_limit'), L.time_limit_min, 1, 'dk', true)),
    h('div', { class: 'fs-mt-seed' }, h('span', { class: 'small muted' }, FT('fpv.crash_rule')), h('span', { class: 'fs-fc-rules', role: 'group' }, ruleBtns)), ruleNote,
    h('div', { class: 'fs-mt-seed' }, h('span', { class: 'small muted', title: FT('fpv.ghost_d') }, FT('fpv.ghost')), h('span', { class: 'fs-fc-rules', role: 'group' }, ghostBtns)),
    h('p', { class: 'small muted' }, FT('fpv.world_note')));
  const el = h('div', { class: 'fs-fc-box' }, h('div', null, warn, h('h5', { style: { margin: '0 0 6px' } }, FT('fpv.gallery')), gal, opts), side);
  const changed = () => { warn.hidden = isFpvType(getType(), L); onChange(); };
  const pick = cid => {
    const c = courses?.find(x => x.id === cid); if (!c) return;
    const lapsChanged = C.course_id !== cid;
    C.course_id = cid;
    if (lapsChanged) { C.laps = c.laps; sl.laps?.set(c.laps); }
    drawGal(); drawSide(); changed();
  };
  const drawGal = () => clear(gal, (courses || []).map(c => galleryCardEl(c, { selected: c.id === C.course_id, onPick: pick, detail: detailOf(c.id) })));
  const details = new Map();
  const detailOf = cid => details.get(cid) || null;
  let sideSeq = 0;
  const drawSide = async () => {
    const c = courses?.find(x => x.id === C.course_id);
    if (!c) { clear(side, h('p', { class: 'small muted' }, FT('fpv.pick'))); return; }
    const d = galleryCard(c, FT), my = ++sideSeq;
    const big = h('div', { class: 'fs-fc-big' }); const lb = h('div', null, h('span', { class: 'small muted' }, '…'));
    clear(side, h('div', null, h('b', null, d.name), h('div', { class: 'small muted' }, `${d.venue} · ${d.length} · ${d.gatesText} · ${d.difficultyName} `, starsEl(d))), big,
      h('div', { class: 'fs-fc-chips' }, d.kinds.map(k => h('span', null, k))), h('b', { class: 'small' }, FT('fpv.leaderboard')), lb);
    try {
      const det = await courseDetail(c.id, C.laps);
      if (my !== sideSeq) return;
      details.set(c.id, det);
      big.innerHTML = courseSvg(det.course, { title: d.name });
      clear(lb, leaderboardEl(det.leaderboard, me));
    } catch (e) { if (my === sideSeq) clear(lb, h('span', { class: 'small fs-warn-txt' }, e.message)); }
  };
  const load = async () => {
    try {
      const r = await fpvApi.courses();
      courses = r.courses || [];
      Object.assign(L, r.limits || {});
      if (!courses.some(c => c.id === C.course_id)) C.course_id = courses[0]?.id || null;
      const c0 = courses.find(c => c.id === C.course_id); if (c0 && !initial?.laps) { C.laps = c0.laps; sl.laps?.set(c0.laps); }
      drawGal(); drawSide(); changed();
      await Promise.all(courses.map(c => courseDetail(c.id).then(d => { details.set(c.id, d); }).catch(() => {})));
      drawGal();
    } catch (e) { clear(gal, h('div', { class: 'small fs-warn-txt' }, `${FT('fpv.load_err')}: ${e.message}`)); }
  };
  drawRules(); drawGhost(); load();
  return {
    el,
    values: () => ({ ...C }),
    body: () => fpvBody(C),
    ghost: () => ghost,
    course: () => courses?.find(x => x.id === C.course_id) || null,
    error: () => fpvError(C, getType(), L),
    summary: () => { const c = courses?.find(x => x.id === C.course_id); return [[FT('fpv.course'), c ? galleryCard(c, FT).name : '—'], [FT('fpv.rules'), fpvRulesText(C, FT)], [FT('fpv.ghost'), FT(ghost === 'pb' ? 'fpv.ghost_pb' : 'fpv.ghost_off')]]; },
    refresh: () => { changed(); if (courses) drawSide(); },
  };
}

// ---------------------------------------------------------------- "Yeni Simülasyon" penceresi: Hazır FPV parkurları → zaman denemesi
const TYPE_NAMES = { multirotor: 'Multikopter', hexarotor: 'Hexakopter', helikopter: 'Helikopter' };
export function fpvTimeTrialCard({ onOpen }) {
  ensureFpvUiCss();
  return h('button', { type: 'button', class: 'fs-fc-ttbtn', onclick: () => onOpen?.() }, h('span', { class: 'ico', html: FLAG }),
    h('span', null, h('b', null, FT('fpv.tt_open')), h('small', null, FT('fpv.tt_open_d'))));
}
/** Galeri penceresi: parkur + ayar + araç + merkez → "Zaman denemesi başlat". ctx: {meta, centers, type, centerId, me, modal, matchHref}. */
export function openFpvTimeTrial({ modal, centers = [], type = 'multirotor', centerId = null, me = null, limits = null, model = null, camera = 'day', onStarted = null }) {
  ensureFpvUiCss();
  let T0 = isFpvType(type) ? type : 'multirotor', cid = centerId ?? centers[0]?.id ?? null;
  const sec = createFpvSection({ limits, getType: () => T0, me });
  const typeBtns = Object.keys(TYPE_NAMES).map(k => h('button', { type: 'button', 'data-type': k, onclick: () => { T0 = k; drawTypes(); sec.refresh(); } }, tr(TYPE_NAMES[k])));
  const drawTypes = () => typeBtns.forEach(b => b.classList.toggle('on', b.dataset.type === T0));
  const centerSel = h('select', { class: 'input', style: { width: 'auto' }, onchange: () => { cid = Number(centerSel.value); } }, centers.map(c => h('option', { value: c.id, selected: c.id === cid }, c.name)));
  const body = h('div', { class: 'fs-fc-tt' },
    h('div', { class: 'row' }, h('span', { class: 'small muted' }, FT('fpv.vehicle')), h('span', { class: 'fs-fc-types', role: 'group' }, typeBtns),
      h('span', { class: 'small muted', style: { marginLeft: '12px' } }, FT('fpv.center')), centerSel),
    sec.el);
  drawTypes();
  const m = modal({ title: `${FT('fpv.tt_open')} · ${FT('fpv.time_trial')}`, body, wide: true,
    actions: [{ label: tr('İptal et'), class: 'ghost' }, 'spacer', { label: `▶ ${FT('fpv.start_tt')}`, class: 'primary fs-fc-start', onClick: async () => {
      const e = sec.error();
      if (e) { toast(FT(e), 'err'); return true; }
      if (cid == null) { toast(FT('fpv.no_center'), 'err'); return true; }
      const r = await api.post('/api/drone/sim/matches', { settings: { type: T0, center_id: cid, camera, ...(model ? { model } : {}) }, kind: 'fpv', fpv: sec.body(), invite: [], bots: [] });
      toast(FT('fpv.tt_created'));
      onStarted?.(r);
      return false;
    } }] });
  m.el.classList.add('fs-fc-ttmodal');
  return { modal: m, section: sec };
}

// ---------------------------------------------------------------- sonuç ekranı
export function fpvResultsBody(match, me, { medal = r => h('span', { class: `rk rk${r}` }, String(r)), aiBadge = () => null, statusText = r => r.status } = {}) {
  ensureFpvUiCss();
  const res = match.result || {}, rows = res.standings || match.players || [], solo = matchIsSolo(match);
  const cfg = match.rings_cfg || res.fpv || {}, cid = cfg.course_id || res.fpv?.course_id, laps = Number(cfg.laps || res.fpv?.laps) || null;
  const mine = rows.find(r => r.id === me), F = mine ? fpvRow(mine) : null;
  const cname = cid ? FT(`fpv.c_${cid}`) : '—';
  const place = h('span', { class: 'small muted fs-fc-place' });
  const head = [];
  if (F) {
    const d = pbDelta(F.total, F.pbPrev);
    head.push(h('div', { class: 'fs-mt-win' }, h('span', { class: 'cup', html: F.newPb ? TROPHY : FLAG }),
      h('div', null, h('b', null, solo ? cname : tr('Kazanan: {n}', { n: rows[0]?.name || '—' })),
        h('div', { class: 'small muted' }, [solo ? FT('fpv.time_trial') : cname, FT('fpv.laps_n', { n: laps ?? '—' }), FT(`fpv.r_${res.reason || match.reason}`) !== `fpv.r_${res.reason || match.reason}` ? FT(`fpv.r_${res.reason || match.reason}`) : null].filter(Boolean).join(' · ')))));
    head.push(h('div', { class: 'tot' }, F.total != null ? fmtLap(F.total) : FT('fpv.dnf')));
    if (F.newPb) head.push(h('div', null, h('span', { class: 'pb' }, FT('fpv.new_pb')), ' ', h('span', { class: 'small' }, F.pbPrev != null ? FT('fpv.pb_prev', { t: fmtLap(F.pbPrev), d: fmtDelta(d) }) : FT('fpv.pb_first'))));
    else if (F.pbPrev != null && F.total != null) head.push(h('div', { class: 'small muted' }, FT('fpv.pb_keep', { t: fmtLap(F.pbPrev), d: fmtDelta(d) })));
    head.push(h('div', { class: 'kv' }, [[FT('fpv.best_lap'), fmtLap(F.best)], [FT('fpv.misses'), String(F.misses)], [FT('fpv.hits'), String(F.hits)], [FT('fpv.penalty'), `+${Number(F.pen || 0).toFixed(1)} s`]]
      .map(([k, v]) => h('span', null, h('span', { class: 'muted' }, `${k}: `), h('b', null, v))), place));
    if (F.laps.length) head.push(h('div', null, h('b', { class: 'small' }, FT('fpv.lap_times')), h('div', { class: 'laps' }, F.laps.map((s, i) => h('span', { class: s === F.best ? 'best' : '' }, `${i + 1}. ${fmtLap(s)}`)))));
    if (F.sectors.length && F.sectors.some(r => r.length)) {
      const n = Math.max(...F.sectors.map(r => r.length)), pbs = bestSectors(F.sectors);
      const grid = h('div', { class: 'secs' }, h('span', null, ''), ...Array.from({ length: n }, (_, k) => h('b', { class: 'small' }, FT('fpv.sector_n', { n: k + 1 }))));
      grid.style.setProperty('--n', String(n));
      F.sectors.forEach((row, i) => { grid.append(h('span', { class: 'small muted' }, `${FT('fpv.lap')} ${i + 1}`)); for (let k = 0; k < n; k++) { const s = row[k]; grid.append(h('span', { class: s != null && s === pbs[k + 1] ? 'purple' : s != null ? 'green' : '' }, s != null ? Number(s).toFixed(2) : '—')); } });
      head.push(h('b', { class: 'small' }, FT('fpv.sectors')), grid);
    }
  }
  // skor tablosundaki yer (sunucudan; kayıt bitişte yazılmıştır)
  if (cid && F?.total != null) courseDetail(cid, laps, true).then(d => { const p = leaderboardPlace(d.leaderboard, me); if (p) place.textContent = FT('fpv.lb_place', { r: p.rank, n: p.n }); }).catch(() => {});
  const table = solo ? null : h('div', { class: 'tw' }, h('table', null,
    h('thead', null, h('tr', null, [tr('Sıra'), tr('Oyuncu'), FT('fpv.time'), FT('fpv.best_lap'), FT('fpv.laps'), FT('fpv.misses'), FT('fpv.hits'), FT('fpv.penalty'), tr('Durum')].map(x => h('th', null, x)))),
    h('tbody', null, rows.map(r => { const f = fpvRow(r); return h('tr', { class: r.id === me ? 'me' : '', 'data-id': r.id },
      h('td', null, medal(r.rank ?? 0)), h('td', null, h('b', null, r.name), aiBadge(r), r.id === me ? h('span', { class: 'small muted' }, ` (${tr('siz')})`) : null, f.newPb ? h('span', { class: 'fs-fc-solo', style: { background: '#ca8a04' } }, 'PB') : null),
      h('td', { class: 'n' }, f.total != null ? fmtLap(f.total) : '—'), h('td', { class: 'n' }, fmtLap(f.best)), h('td', { class: 'n' }, `${f.lapsDone} / ${f.lapsTotal ?? laps ?? '—'}`),
      h('td', { class: 'n' }, String(f.misses)), h('td', { class: 'n' }, String(f.hits)), h('td', { class: 'n' }, f.pen ? `+${Number(f.pen).toFixed(1)}` : '—'),
      h('td', null, r.finished ? h('span', { class: 'badge green' }, tr('Bitirdi')) : h('span', { class: 'badge gray' }, tr(statusText(r))))); }))));
  return h('div', { class: 'fs-mt-res fs-fc-res' }, head, table);
}
/** §47 tek kişilik HALKA yarışı sonucu başlığı ("Kazanan" yerine "Tamamlandı · süre"). */
export function soloRingsHead(match, me, fmtClock) {
  const res = match.result || {}, r = (res.standings || []).find(x => x.id === me) || (match.players || []).find(x => x.id === me);
  const done = r?.finished;
  return h('div', { class: 'fs-mt-win' }, h('span', { class: 'cup', html: FLAG }),
    h('div', null, h('b', null, FT('fpv.ring_solo')), h('div', { class: 'small muted' }, done ? FT('fpv.ring_done', { t: fmtClock(r.time_s ?? res.duration_s) }) : FT('fpv.not_done', { i: r?.rings ?? 0, n: r?.total ?? res.total ?? '—' }))));
}

// ---------------------------------------------------------------- oturum ekranı: 3B parkur + HUD + hayalet
// ctx: {stage, getSim, me, sfx, getRc, getTele, fpvMenu (FPV açılır menüsü; çubuk göstergesi satırı eklenir)}
export function attachFpvMatch(ctx) {
  let M = null, layer = null, hud = null, course = null, loading = false, disposed = false, ghostSplits = null, detail = null;
  const gp = ghostPref();
  hud = createFpvCourseHud(ctx.stage, { getSim: ctx.getSim, T: FT, me: ctx.me, sfx: ctx.sfx, getRc: ctx.getRc, getTele: ctx.getTele });
  const sticksRow = hud.sticksRow();
  if (sticksRow && ctx.fpvMenu) ctx.fpvMenu.insertBefore(sticksRow, ctx.fpvMenu.querySelector('.small.muted') || null);
  const cfg = () => M?.rings_cfg || {};
  async function build() {
    const sim = ctx.getSim();
    if (loading || layer || !sim?.three || !M || disposed) return;
    loading = true;
    try {
      const laps = Number(cfg().laps) || null;
      detail = await courseDetail(cfg().course_id, laps);
      if (disposed) return;
      course = detail.course;
      layer = createFpvCourseLayer(sim, course, { checkpoints: M.rings || [], me: ctx.me, T: FT });
      hud.setPb(detail.my_best ? { sectors: detail.my_best.sectors } : null);
      const pn = (M.players || []).find(p => p.id === ctx.me);
      layer.setProgress(pn?.finished ? null : pn?.next ?? 1);
      if (typeof window !== 'undefined') window.__fsFpv = { layer, hud, get course() { return course; }, get detail() { return detail; } };
      // genel en iyi sektörler: rekor sahibinin hayalet ara sürelerinden (kendisi değilse); hayalet: kişisel rekor (tercih)
      const rec = detail.leaderboard?.[0];
      if (rec && rec.user_id !== ctx.me) fpvApi.ghost(cfg().course_id, laps, rec.user_id).then(g => { const st = sectorTimesFromSplits(g.splits, M.rings || []); hud.setRecordSectors(bestSectors(st)); }).catch(() => {});
      else if (detail.my_best?.sectors) hud.setRecordSectors(bestSectors(detail.my_best.sectors));
      if (gp.get() === 'pb') {
        try {
          const g = await fpvApi.ghost(cfg().course_id, laps);
          if (disposed) return;
          ghostSplits = g.splits || null;
          layer.setGhost(decodeGhost(g.ghost), { color: '#22d3ee', name: `${FT('fpv.ghost_hud')} · ${fmtLap(g.time_s)}` });
          hud.setGhost({ splits: ghostSplits, name: g.name, time_s: g.time_s });
        } catch { /* kişisel rekor yok (404) */ }
      }
    } catch (e) { toast(`${FT('fpv.load_err')}: ${e.message}`, 'err'); } finally { loading = false; }
  }
  const raceT = now => (M?.start_at == null ? null : now - Number(M.start_at));
  return {
    setMatch(m, now) { M = m; hud.setMatch(m); hud.setNow(now); build(); if (layer && M.state === 'YARIS') layer.update(raceT(now)); },
    tick(now) { hud.setNow(now); if (layer && M) { layer.update(M.state === 'YARIS' || M.state === 'BITTI' ? raceT(now) : null); } build(); },
    event(m, now) {
      hud.setNow(now); hud.event(m);
      if (!layer) return;
      if (m.t === 'pos') { const p = (m.p || []).find(x => x.id === ctx.me); if (p && p.next !== undefined) layer.setProgress(p.next); return; }
      if (m.id !== ctx.me) return;
      if (m.t === 'ring') { const cp = (M?.rings || []).find(c => c.i === m.i); layer.setProgress(m.i + 1 > (m.total ?? 1e9) ? null : m.i + 1); layer.flash(cp?.gate === 0 && cp.lap > 0 ? 'lap' : 'gate', cp?.gate ?? null); }
      else if (m.t === 'miss') { const cp = (M?.rings || []).find(c => c.i === m.i); layer.flash('miss', cp?.gate ?? null); }
      else if (m.t === 'hit') layer.flash('hit');
      else if (m.t === 'finish') layer.setProgress(null);
    },
    get layer() { return layer; }, get hud() { return hud; }, get course() { return course; },
    sectorClass,
    dispose() { disposed = true; layer?.dispose(); hud?.dispose(); sticksRow?.remove(); if (typeof window !== 'undefined' && window.__fsFpv?.layer === layer) delete window.__fsFpv; },
  };
}
