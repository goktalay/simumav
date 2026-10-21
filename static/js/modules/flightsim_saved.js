// Uçuş Simülatörü §27 — KAYITLI SİMÜLASYONLAR ekranı ve sihirbaz parçaları (docs/ucus-simulatoru.md §27). Saf yardımcılar flightsim_presets.js'te.
// Kullanıcı isteği (özet): "Uçuş Simülatörü alt modül ekranı: en solda kaydedilmiş sihirbazların kart listesi, en başta 'Serbest Uçuş' kartı; Serbest
// Uçuş seçilince ortada kayıtsız sihirbazla yapılan uçuşlar kart olarak; kayıtlı bir sihirbaz seçilince o ayarlarla yapılan uçuşlar; uçuş kartı seçilince
// sağda o uçuşun özet verileri ve ÜSTTE uçulan model 3B olarak sürekli dönerek." + kart: Başlat / Düzenle / Sil; sihirbaz sonunda azami süre/menzil.
// • TEK WebGL BAĞLAMI: dönen model flightsim3d "stüdyo" kipi (createFlightSim3D(…, {studio: true}) — dünya/kare döngüsü yok, yalnız createModelViewer)
//   ile; sayfada başka 3B sahne yokken açılır, sihirbaz penceresi açılınca (onun önizlemesi kendi bağlamını kurar) BIRAKILIR (`suspend3d`), kapanınca
//   gerektiğinde yeniden kurulur. Görüntü 2B tuvale kopyalanır (flightsim_tgtview.js kalıbı); en çok ~30 fps, görünmezken durur.
// • CSS bu modülde (ensureSavedCss; app.css'e dokunmaz) — açık/koyu tema HEPGO değişkenleriyle (--surface, --border, --primary, --muted…).
// Dışa: savedScreen(opts) → { el, refresh(sel?), select(sel), suspend3d(), dispose() } · budgetBox · pilotPicker · askPresetName · countdown · ensureSavedCss
import { api } from '../api.js';
import { clear, confirmDialog, fmtDateTime, h, modal, onLeave, pref, setPref, toast, toastError } from '../ui.js';
import { createFlightSim3D } from './flightsim3d.js';
import { RUN_ICON, runDownloadMenu, runVideoDialog } from './flightsim_runs.js';
import { launchLabel } from './flightsim_launch.js';
import { budgetView, fmtKm, fmtMin, fmtSec, nameError, normName, resultBadge, runFacts, NAME_MAX, DESC_MAX } from './flightsim_presets.js';
import { flightBudget } from './flightsim_power.js';
import { servoRunBadge } from './flightsim_servotrig.js';   // §34 uçuş kartında servo tetik irtifası

const TYPE_NAME = { multirotor: 'Multikopter', hexarotor: 'Hexakopter', helikopter: 'Helikopter', sabit_kanat: 'Sabit Kanat', vtol: 'VTOL', interceptor: 'INTERCEPTOR', rover: 'Kara Aracı' };   // §31
const DEFAULT_MODEL = { multirotor: 'builtin:quad', hexarotor: 'builtin:hexa', helikopter: 'builtin:heli', sabit_kanat: 'builtin:caymaz', vtol: 'builtin:caymaz', interceptor: 'builtin:icept_x4', rover: 'builtin:rover_4x4' };
const WORLD_MODE = { real: 'Gerçek arazi', google3d: 'Google 3B', procedural: 'Prosedürel' };
const CAMERA = { day: 'Gündüz', thermal: 'Termal', night: 'Gece görüşü' };
const svg = body => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
const ICO = {
  free: svg('<path d="M3 12c3-6 6-6 9 0s6 6 9 0"/><path d="M12 3v3M12 18v3"/>'),
  saved: svg('<path d="M6 3h12v18l-6-4-6 4z"/>'),
  pilot: svg('<circle cx="12" cy="8" r="3.2"/><path d="M5 20c1.2-4 4-5.5 7-5.5s5.8 1.5 7 5.5"/><path d="M8.5 7.2h7"/>'),
  center: svg('<path d="M12 21s-6-5.6-6-10.5a6 6 0 0 1 12 0C18 15.4 12 21 12 21z"/><circle cx="12" cy="10.5" r="2.2"/>'),
  clock: svg('<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>'),
  range: svg('<path d="M4 18 20 6"/><circle cx="4" cy="18" r="1.8"/><circle cx="20" cy="6" r="1.8"/>'),
  edit: svg('<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="M13.5 6.5l4 4"/>'),
  fuel: svg('<path d="M5 20V6a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2v14M4 20h12M7 9h6"/><path d="M15 10h2a1.5 1.5 0 0 1 1.5 1.5V17a1.5 1.5 0 0 0 3 0V9l-3-3"/>'),
  elec: svg('<rect x="3" y="7" width="16" height="10" rx="2"/><path d="M21 10.5v3M10 9l-2 3.2h3.4L9.6 15"/>'),
  plane: svg('<path d="M12 3v18M4 13l8-3 8 3M8 20l4-2 4 2"/>'),
};

// ======================================================================
// CSS (bir kez; HEPGO tema değişkenleri — açık / koyu)
// ======================================================================
const CSS = `
.fs-sv { display: grid; grid-template-columns: minmax(250px, 300px) minmax(0, 1fr) minmax(300px, 380px); gap: 14px; align-items: start; }
.fs-sv-col { min-width: 0; display: flex; flex-direction: column; gap: 10px; }
.fs-sv-colh { display: flex; align-items: center; gap: 8px; min-height: 30px; padding: 0 2px; }
.fs-sv-colt { margin: 0; font-size: 13px; letter-spacing: .04em; text-transform: uppercase; color: var(--muted); font-weight: 700; flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.fs-sv-colh .badge { flex: 0 0 auto; }
.fs-sv-list { display: flex; flex-direction: column; gap: 8px; }
.fs-sv-card { position: relative; display: block; width: 100%; text-align: left; border: 1px solid var(--border); border-radius: 12px; background: var(--surface); padding: 12px 12px 10px 14px; cursor: pointer; color: inherit; font: inherit; transition: border-color .15s, box-shadow .15s, transform .15s; }
.fs-sv-card:hover { border-color: color-mix(in srgb, var(--primary) 45%, var(--border)); box-shadow: 0 2px 10px rgba(15, 23, 42, .06); }
.fs-sv-card:focus-visible { outline: 2px solid var(--primary); outline-offset: 2px; }
.fs-sv-card.on { border-color: var(--primary); box-shadow: 0 0 0 3px color-mix(in srgb, var(--primary) 18%, transparent); }
.fs-sv-card.on::before { content: ''; position: absolute; left: -1px; top: 10px; bottom: 10px; width: 4px; border-radius: 0 4px 4px 0; background: var(--primary); }
.fs-sv-ch { display: flex; align-items: flex-start; gap: 10px; }
.fs-sv-ico { flex: 0 0 34px; width: 34px; height: 34px; border-radius: 10px; display: grid; place-items: center; background: var(--primary-soft); color: var(--primary); }
.fs-sv-ico svg { width: 20px; height: 20px; }
.fs-sv-card.free .fs-sv-ico { background: color-mix(in srgb, #10b981 16%, transparent); color: #059669; }
.fs-sv-tt { flex: 1; min-width: 0; }
.fs-sv-tt b { display: block; font-size: 14px; line-height: 1.3; overflow-wrap: anywhere; }
.fs-sv-tt small { display: block; color: var(--muted); font-size: 12px; margin-top: 2px; }
.fs-sv-n { flex: 0 0 auto; min-width: 26px; height: 22px; padding: 0 7px; border-radius: 11px; background: var(--bg, rgba(127,127,127,.12)); border: 1px solid var(--border); font-size: 12px; font-weight: 700; display: grid; place-items: center; font-variant-numeric: tabular-nums; }
.fs-sv-desc { margin: 8px 0 0; font-size: 12.5px; color: var(--muted); display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.fs-sv-meta { display: flex; flex-wrap: wrap; gap: 4px 12px; margin-top: 8px; font-size: 12px; color: var(--muted); }
.fs-sv-meta span { display: inline-flex; align-items: center; gap: 4px; min-width: 0; }
.fs-sv-meta svg { width: 14px; height: 14px; flex: 0 0 auto; }
.fs-sv-meta .me { color: var(--primary); font-weight: 600; }
.fs-sv-chip { display: inline-flex; align-items: center; gap: 5px; margin-top: 8px; padding: 3px 10px; border-radius: 999px; font-size: 12px; font-weight: 600; white-space: nowrap; background: color-mix(in srgb, var(--primary) 9%, transparent); font-variant-numeric: tabular-nums; }
.fs-sv-chip > span { display: inline-flex; }
.fs-sv-chip svg { width: 14px; height: 14px; color: var(--primary); }
.fs-sv-chip .v { margin-right: 6px; }
.fs-sv-chip .lim { margin-left: 2px; padding-left: 8px; border-left: 1px solid var(--border); }
.fs-sv-chip .lim svg { color: #d97706; }
.fs-sv-acts { display: flex; align-items: center; gap: 6px; margin-top: 10px; }
.fs-sv-acts .spacer { flex: 1; }
.fs-sv-acts .btn { height: 28px; font-size: 12.5px; padding: 0 10px; }
.fs-sv-acts .icon-btn { width: 28px; height: 28px; display: grid; place-items: center; border-radius: 8px; border: 1px solid var(--border); background: var(--surface); color: var(--muted); cursor: pointer; }
.fs-sv-acts .icon-btn:hover { color: var(--text, inherit); border-color: var(--muted); }
.fs-sv-acts .icon-btn.danger:hover { color: #dc2626; border-color: #dc2626; }
.fs-sv-acts .icon-btn svg { width: 15px; height: 15px; }
.fs-sv-assigned { position: absolute; top: -8px; right: 10px; }
.fs-sv-empty { border: 1px dashed var(--border); border-radius: 12px; padding: 18px 14px; text-align: center; color: var(--muted); font-size: 13px; }
.fs-sv-empty b { display: block; color: var(--text, inherit); margin-bottom: 4px; }
/* uçuş kartları (orta) */
.fs-sv-runs { display: grid; grid-template-columns: repeat(auto-fill, minmax(230px, 1fr)); gap: 10px; }
.fs-sv-run { padding: 11px 12px; }
.fs-sv-run.crash { border-left: 3px solid #dc2626; }
.fs-sv-rh { display: flex; align-items: center; gap: 8px; }
.fs-sv-rh b { flex: 1; min-width: 0; font-size: 13.5px; font-variant-numeric: tabular-nums; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.fs-sv-rl { margin-top: 6px; font-size: 12.5px; color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.fs-sv-rl strong { color: var(--text, inherit); font-weight: 600; }
.fs-sv-rf { display: flex; align-items: center; gap: 10px; margin-top: 8px; font-size: 12px; color: var(--muted); font-variant-numeric: tabular-nums; }
.fs-sv-rf .att { margin-left: auto; display: inline-flex; gap: 4px; }
.fs-sv-rf .att span { width: 16px; height: 16px; color: var(--muted); }
.fs-sv-rf .att svg { width: 16px; height: 16px; }
.fs-sv-more { align-self: center; }
.fs-sv-deleted { font-size: 11px; }
/* sağ: dönen model + özet */
.fs-sv-detail { border: 1px solid var(--border); border-radius: 14px; background: var(--surface); overflow: hidden; position: sticky; top: 8px; }
.fs-sv-stage { position: relative; aspect-ratio: 16 / 10; background: radial-gradient(120% 90% at 50% 0%, #17313a 0%, #0b1418 70%); }
.fs-sv-stage canvas { display: block; width: 100%; height: 100%; }
.fs-sv-stage .msg { position: absolute; inset: 0; display: grid; place-items: center; color: #9fb4bd; font-size: 12.5px; pointer-events: none; }
.fs-sv-stage .cap { position: absolute; left: 0; bottom: 0; right: 0; padding: 26px 14px 10px; display: flex; align-items: flex-end; gap: 8px; color: #e7f4f7; text-shadow: 0 1px 2px rgba(0,0,0,.6); pointer-events: none; background: linear-gradient(180deg, transparent, rgba(4, 10, 13, .78)); }
.fs-sv-stage .cap b { font-size: 14px; }
.fs-sv-stage .cap small { opacity: .8; font-size: 11.5px; }
.fs-sv-stage .cap .sp { flex: 1; }
.fs-sv-body { padding: 14px; display: flex; flex-direction: column; gap: 12px; }
.fs-sv-title { display: flex; align-items: flex-start; gap: 8px; }
.fs-sv-title .t { margin: 0; font-size: 15px; font-weight: 700; flex: 1; min-width: 0; overflow-wrap: anywhere; }
.fs-sv-sub { font-size: 12.5px; color: var(--muted); margin-top: -6px; }
.fs-sv-facts { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; }
.fs-sv-fact { border: 1px solid var(--border); border-radius: 10px; padding: 8px 10px; min-width: 0; }
.fs-sv-fact small { display: block; color: var(--muted); font-size: 11px; text-transform: uppercase; letter-spacing: .04em; }
.fs-sv-fact b { display: block; font-size: 15px; margin-top: 2px; font-variant-numeric: tabular-nums; overflow-wrap: anywhere; }
.fs-sv-fact i { display: block; font-style: normal; font-size: 11.5px; color: var(--muted); margin-top: 1px; }
.fs-sv-fact.t-alert { border-color: color-mix(in srgb, #dc2626 45%, var(--border)); background: color-mix(in srgb, #dc2626 6%, transparent); }
.fs-sv-fact.t-alert b { color: #dc2626; }
.fs-sv-fact.t-ok b { color: #059669; }
.fs-sv-fact.t-warn b { color: #d97706; }
.fs-sv-dl { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 5px 12px; margin: 0; font-size: 12.5px; }
.fs-sv-dl dt { color: var(--muted); white-space: nowrap; }
.fs-sv-dl dd { margin: 0; text-align: right; font-weight: 600; overflow-wrap: anywhere; }
.fs-sv-dacts { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
.fs-sv-dacts .spacer { flex: 1; }
.fs-sv-placeholder { padding: 26px 16px; text-align: center; color: var(--muted); font-size: 13px; }
/* azami süre / menzil kutusu (sihirbaz özeti + kayıt paneli) */
.fs-bud { border: 1px solid var(--border); border-radius: 12px; padding: 12px 14px; background: linear-gradient(180deg, color-mix(in srgb, var(--primary) 6%, transparent), transparent 70%); }
.fs-bud-h { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; }
.fs-bud-k small { display: block; font-size: 11px; color: var(--muted); text-transform: uppercase; letter-spacing: .05em; }
.fs-bud-k b { display: block; font-size: 22px; line-height: 1.15; font-variant-numeric: tabular-nums; }
.fs-bud-k i { font-style: normal; font-size: 12px; color: var(--muted); }
.fs-bud table { width: 100%; border-collapse: collapse; margin-top: 10px; font-size: 12.5px; font-variant-numeric: tabular-nums; }
.fs-bud th { text-align: left; font-weight: 600; color: var(--muted); font-size: 11px; text-transform: uppercase; letter-spacing: .04em; padding: 4px 6px; border-bottom: 1px solid var(--border); }
.fs-bud td { padding: 6px; border-bottom: 1px solid color-mix(in srgb, var(--border) 60%, transparent); }
.fs-bud th:not(:first-child), .fs-bud td:not(:first-child) { text-align: right; }
.fs-bud td:first-child { display: flex; align-items: center; gap: 6px; font-weight: 600; }
.fs-bud td:first-child svg { width: 15px; height: 15px; color: var(--muted); }
.fs-bud tr.lim td { background: color-mix(in srgb, #f59e0b 12%, transparent); }
.fs-bud tr.lim td:first-child svg { color: #d97706; }
.fs-bud .lim-b { font-size: 10.5px; padding: 1px 6px; border-radius: 6px; background: #f59e0b; color: #1f1300; font-weight: 700; letter-spacing: .02em; }
.fs-bud-n { margin: 8px 0 0; font-size: 11.5px; color: var(--muted); }
.fs-bud.none { color: var(--muted); font-size: 13px; }
.fs-bud.compact .fs-bud-k b { font-size: 18px; }
.fs-bud.compact td, .fs-bud.compact th { white-space: nowrap; }
.fs-bud.compact .lim-b { display: none; }
/* sihirbaz son adım: Uç (nabız) + Kaydet + pilot */
.fs-wz-fly { position: relative; min-width: 108px; font-weight: 700; letter-spacing: .02em; }
.fs-wz-fly:not(:disabled) { animation: fsFlyPulse 1.4s ease-in-out infinite; }
.fs-wz-fly:not(:disabled)::after { content: ''; position: absolute; inset: -3px; border-radius: inherit; border: 2px solid var(--primary); opacity: 0; animation: fsFlyRing 1.4s ease-out infinite; pointer-events: none; }
@keyframes fsFlyPulse { 0%, 100% { box-shadow: 0 0 0 0 color-mix(in srgb, var(--primary) 55%, transparent); filter: brightness(1); } 50% { box-shadow: 0 0 0 7px color-mix(in srgb, var(--primary) 0%, transparent); filter: brightness(1.18); } }
@keyframes fsFlyRing { 0% { opacity: .75; transform: scale(1); } 100% { opacity: 0; transform: scale(1.18); } }
@media (prefers-reduced-motion: reduce) { .fs-wz-fly:not(:disabled), .fs-wz-fly:not(:disabled)::after { animation: none; } .fs-wz-fly:not(:disabled) { box-shadow: 0 0 0 3px color-mix(in srgb, var(--primary) 30%, transparent); } }
.fs-wz-save { min-width: 96px; }
.fs-wz-assign { border: 1px solid var(--border); border-radius: 12px; padding: 12px 14px; display: grid; grid-template-columns: minmax(0, 1fr) minmax(200px, 300px); gap: 6px 16px; align-items: center; }
.fs-wz-assign h4 { margin: 0; font-size: 13.5px; display: flex; align-items: center; gap: 6px; }
.fs-wz-assign h4 svg { width: 16px; height: 16px; color: var(--primary); }
.fs-wz-assign p { margin: 2px 0 0; font-size: 12px; color: var(--muted); }
.fs-wz-assign select { width: 100%; }
.fs-wz-sumx { display: flex; flex-direction: column; gap: 12px; margin-bottom: 12px; }
.fs-wz-quick-h { display: flex; align-items: center; gap: 10px; padding: 10px 14px; border-radius: 12px; background: var(--primary-soft); }
.fs-wz-quick-h svg { width: 22px; height: 22px; color: var(--primary); flex: 0 0 auto; }
.fs-wz-quick-h b { font-size: 15px; }
.fs-wz-quick-h small { display: block; color: var(--muted); }
/* geri sayım */
.fs-cd { position: fixed; inset: 0; z-index: 2147483000; display: grid; place-items: center; background: rgba(8, 14, 18, .72); backdrop-filter: blur(3px); }
.fs-cd-box { text-align: center; color: #fff; }
.fs-cd-n { font-size: 132px; font-weight: 800; line-height: 1; font-variant-numeric: tabular-nums; text-shadow: 0 6px 30px rgba(0,0,0,.45); animation: fsCdPop 1s ease-out; }
.fs-cd-t { margin: 10px 0 18px; font-size: 16px; opacity: .85; }
.fs-cd-box .btn { background: rgba(255,255,255,.12); color: #fff; border-color: rgba(255,255,255,.45); min-width: 96px; }
.fs-cd-box .btn:hover { background: rgba(255,255,255,.22); }
@keyframes fsCdPop { 0% { transform: scale(1.35); opacity: 0; } 25% { transform: scale(1); opacity: 1; } 100% { transform: scale(.92); opacity: .9; } }
@media (prefers-reduced-motion: reduce) { .fs-cd-n { animation: none; } }
/* ad sorma */
.fs-name-dlg { display: flex; flex-direction: column; gap: 10px; min-width: min(460px, 82vw); }
.fs-name-dlg label { display: flex; flex-direction: column; gap: 4px; font-size: 12.5px; color: var(--muted); }
.fs-name-dlg textarea { min-height: 70px; resize: vertical; }
.fs-name-warn { font-size: 12.5px; color: #dc2626; min-height: 1em; }
.fs-name-warn.ok { color: #059669; }
.fs-name-sum { font-size: 12.5px; color: var(--muted); border-top: 1px solid var(--border); padding-top: 8px; }
/* düzenler */
/* tablet: kayıtlılar solda (iki satır boyu), uçuşlar ve özet sağ sütunda alt alta — seçilen uçuşun özeti listenin hemen altında */
@media (max-width: 1280px) { .fs-sv { grid-template-columns: minmax(240px, 290px) minmax(0, 1fr); grid-template-areas: 'left mid' 'left right'; } .fs-sv-col.left { grid-area: left; } .fs-sv-col.mid { grid-area: mid; } .fs-sv-col.right { grid-area: right; } .fs-sv-detail { position: static; } .fs-sv-stage { aspect-ratio: 16 / 8; } }
@media (max-width: 760px) { .fs-sv { grid-template-columns: minmax(0, 1fr); grid-template-areas: 'left' 'mid' 'right'; } .fs-sv-stage { aspect-ratio: 16 / 10; } .fs-sv-runs { grid-template-columns: minmax(0, 1fr); } .fs-wz-assign { grid-template-columns: minmax(0, 1fr); } .fs-bud-k b { font-size: 19px; } .fs-bud th:nth-child(4), .fs-bud td:nth-child(4) { display: none; } .fs-bud .lim-b { display: none; } .fs-cd-n { font-size: 96px; } }
`;
export function ensureSavedCss() {
  if (typeof document === 'undefined' || document.getElementById('fs-saved-css')) return;
  const st = document.createElement('style'); st.id = 'fs-saved-css'; st.textContent = CSS; document.head.append(st);
}

// ======================================================================
// Azami süre / menzil kutusu (sihirbaz özeti, kayıt paneli)
// ======================================================================
export function budgetBox({ tr, budget, compact = false }) {
  ensureSavedCss();
  const v = budgetView(budget);
  if (v.empty) return h('div', { class: 'fs-bud none' }, tr('Yakıt ve batarya kapalı: azami süre / menzil hesaplanamaz.'));
  const limName = v.limit === 'fuel' ? tr('yakıt') : tr('batarya');
  return h('div', { class: `fs-bud ${compact ? 'compact' : ''}`, 'data-limit': v.limit || '' },
    h('div', { class: 'fs-bud-h' },
      h('div', { class: 'fs-bud-k', 'data-k': 'time' }, h('small', null, tr('Azami uçuş süresi')), h('b', null, `≈ ${v.headline.time}`), h('i', null, tr('seyirde · {x} sınırlar', { x: limName }))),
      h('div', { class: 'fs-bud-k', 'data-k': 'range' }, h('small', null, tr('Azami menzil')), h('b', null, `≈ ${v.headline.range}`), h('i', null, tr('azami hızda {t} · {r}', { t: v.headline.timeMax, r: v.headline.rangeMax })))),
    h('table', null,
      h('thead', null, h('tr', null, h('th', null, tr('Kaynak')), h('th', null, tr('Süre')), h('th', null, tr('Menzil')), compact ? null : h('th', null, tr('Azami hızda')))),
      h('tbody', null, v.rows.map(r => h('tr', { class: r.limit ? 'lim' : '', 'data-src': r.key },
        h('td', null, h('span', { html: r.key === 'fuel' ? ICO.fuel : ICO.elec }), tr(r.label), r.limit ? h('span', { class: 'lim-b' }, tr('Sınırlayan')) : null),
        h('td', null, r.time), h('td', null, r.range), compact ? null : h('td', null, `${r.timeMax} · ${r.rangeMax}`))))),
    h('p', { class: 'fs-bud-n' }, tr('Seyir {c} km/h (azami {m} km/h), gaz %{g}. Yakıt: L × km/L, gaz koluna göre; batarya: Wh ÷ saatlik W (servo ek yükü hariç). Uçuştaki göstergelerle aynı model.', { c: v.speed.cruiseKmh, m: v.speed.maxKmh, g: v.speed.thrPct })));
}

// ======================================================================
// Pilot seçimi (sihirbazın son adımı): Uçuş Simülatörü yazma izni olanlar (GET /presets/pilots); kendisi de seçilebilir
// ======================================================================
export function pilotPicker({ tr, be, me, value = null, onChange = () => {} }) {
  ensureSavedCss();
  let list = [];
  const sel = h('select', { class: 'input', 'data-f': 'pilot', onchange: () => onChange(api_.value) },
    h('option', { value: '' }, tr('Pilot atanmadı — kendim uçacağım')));
  const note = h('p', null, tr('Kaydet ile atanır: pilot "Kayıtlı Simülasyonlar"dan istediği zaman, yeniden ayar yapmadan başlatır; atandığında bildirim alır.'));
  const el = h('div', { class: 'fs-wz-assign' }, h('div', null, h('h4', null, h('span', { html: ICO.pilot }), tr('Pilot ataması')), note), sel);
  const fill = () => {
    const cur = sel.value || (value != null ? String(value) : '');
    while (sel.options.length > 1) sel.remove(1);
    for (const p of list) sel.append(h('option', { value: String(p.id) }, `${p.full_name}${p.id === me ? ` (${tr('ben')})` : ''}${p.pilot ? ` · ${tr('Pilot')}` : ''}`));
    sel.value = list.some(p => String(p.id) === cur) ? cur : '';
  };
  const api_ = {
    el,
    get value() { return sel.value ? Number(sel.value) : null; },
    get name() { const p = list.find(x => String(x.id) === sel.value); return p ? p.full_name : null; },
    set(v) { value = v; sel.value = v != null ? String(v) : ''; },
    load: () => (be.presetPilots ? be.presetPilots() : Promise.resolve([])).then(r => { list = r || []; fill(); }).catch(() => { list = []; fill(); }),
  };
  api_.load();
  return api_;
}

// ======================================================================
// Ad sorma (Kaydet): ad (benzersiz; canlı uyarı) + açıklama (isteğe bağlı). → Promise<{name, description} | null>
// ======================================================================
export function askPresetName({ tr, list = [], initial = {}, excludeId = null, pilotName = null, title = 'Simülasyonu kaydet', save }) {
  ensureSavedCss();
  return new Promise(resolve => {
    let done = false;
    const nameInp = h('input', { class: 'input', 'data-f': 'name', maxlength: String(NAME_MAX + 20), value: initial.name || '', placeholder: tr('ör. Rampa kalkışı — termal keşif') });
    const descInp = h('textarea', { class: 'input', 'data-f': 'desc', maxlength: String(DESC_MAX), placeholder: tr('İsteğe bağlı: görevin amacı, pilot için notlar') });
    descInp.value = initial.description || '';
    const warn = h('div', { class: 'fs-name-warn', role: 'status' });
    const check = () => {
      const e = nameError(list, nameInp.value, excludeId);
      warn.textContent = e ? tr(e, { n: NAME_MAX }) : (normName(nameInp.value) ? tr('Ad kullanılabilir.') : '');
      warn.classList.toggle('ok', !e);
      if (okBtn) okBtn.disabled = !!e;
      return !e;
    };
    nameInp.addEventListener('input', check);
    let okBtn = null;
    const body = h('div', { class: 'fs-name-dlg' },
      h('label', null, tr('Ad'), nameInp), warn,
      h('label', null, tr('Açıklama (isteğe bağlı)'), descInp),
      h('div', { class: 'fs-name-sum' }, pilotName ? tr('Atanacak pilot: {p}', { p: pilotName }) : tr('Pilot atanmadı — kayıt yalnız sizin listenizde başlatılabilir.')));
    const onEsc = e => { if (e.key === 'Escape') { e.stopPropagation(); m.close(); } };   // yalnız bu pencere (altındaki sihirbaz kapanmasın)
    window.addEventListener('keydown', onEsc, true);
    const m = modal({ title: tr(title), body,
      onClose: () => { window.removeEventListener('keydown', onEsc, true); if (!done) resolve(null); },
      actions: [{ label: tr('Vazgeç') }, { label: tr('Kaydet'), class: 'primary fs-name-ok', onClick: async () => {
        if (!check()) return true;
        const v = { name: normName(nameInp.value), description: descInp.value.trim() || null };
        if (save) {
          try { await save(v); } catch (err) {
            if (err?.status === 409) { warn.textContent = err.message; warn.classList.remove('ok'); return true; }
            throw err;
          }
        }
        done = true; resolve(v);
        return false;
      } }] });
    m.el.classList.add('fs-name-modal');
    okBtn = m.el.querySelector('.fs-name-ok');
    nameInp.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); okBtn?.click(); } });
    check();
    setTimeout(() => { nameInp.focus(); nameInp.select(); }, 0);
  });
}

// ======================================================================
// Geri sayım (kayıtlı simülasyonu başlat): tam ekran örtü, 3-2-1; İptal / Esc → false
// ======================================================================
export function countdown({ tr, seconds = 3, title = '' } = {}) {
  ensureSavedCss();
  return new Promise(resolve => {
    let n = seconds, t = 0, done = false;
    const num = h('div', { class: 'fs-cd-n', 'aria-live': 'assertive' }, String(n));
    const fin = ok => { if (done) return; done = true; clearTimeout(t); window.removeEventListener('keydown', onKey, true); el.remove(); resolve(ok); };
    const onKey = e => { if (e.key === 'Escape') { e.stopPropagation(); e.preventDefault(); fin(false); } };
    const el = h('div', { class: 'fs-cd', role: 'dialog', 'aria-label': tr('Geri sayım') }, h('div', { class: 'fs-cd-box' }, num,
      h('div', { class: 'fs-cd-t' }, title || tr('Simülasyon başlıyor…')), h('button', { class: 'btn', type: 'button', onclick: () => fin(false) }, tr('İptal'))));
    window.addEventListener('keydown', onKey, true);
    document.body.append(el);
    const tick = () => {
      n -= 1;
      if (n <= 0) { fin(true); return; }
      num.textContent = String(n); num.style.animation = 'none'; void num.offsetWidth; num.style.animation = '';
      t = setTimeout(tick, 1000);
    };
    t = setTimeout(tick, 1000);
  });
}

// ======================================================================
// Dönen 3B model (sağ panel): stüdyo bağlamı tembel kurulur; suspend() bağlamı bırakır (sihirbaz açılırken)
// ======================================================================
const modelCache = new Map();
async function modelItem(modelId, type) {
  const id = modelId || DEFAULT_MODEL[type] || 'builtin:quad';
  if (String(id).startsWith('builtin:')) return { model: String(id) };
  const key = `${id}|${type || ''}`;
  if (!modelCache.has(key)) modelCache.set(key, api.get(`/api/drone/sim/models/${encodeURIComponent(id)}${type ? `?type=${encodeURIComponent(type)}` : ''}`)
    .then(m => (m?.glb_url ? { model: String(id), glb_url: m.glb_url, orient: m.orient, has_prop: m.has_prop } : { model: DEFAULT_MODEL[type] || 'builtin:quad' }))
    .catch(() => ({ model: DEFAULT_MODEL[type] || 'builtin:quad' })));
  return modelCache.get(key);
}
function modelSpinner({ tr }) {
  const cv = h('canvas', { width: 640, height: 400, 'aria-hidden': 'true' });
  const msg = h('div', { class: 'msg' }, tr('3B model yükleniyor…'));
  const capT = h('b'), capS = h('small');
  const el = h('div', { class: 'fs-sv-stage', title: tr('Sürükle: döndür') }, cv, msg, h('div', { class: 'cap' }, h('div', null, capT, h('br'), capS), h('span', { class: 'sp' })));
  let studio = null, studioP = null, viewer = null, item = null, raf = 0, last = 0, az = 0.6, drag = null, dead = false, suspended = false, want = 0;
  const reduce = typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  const ensure = () => {
    if (studio || dead || suspended) return studioP;
    studioP ??= createFlightSim3D(document.createElement('div'), null, { studio: true }).then(s => {
      if (dead || suspended) { s.dispose(); studioP = null; return null; }
      studio = s; viewer = s.createModelViewer(); return s;
    }).catch(err => { msg.textContent = tr('3B önizleme açılamadı: {e}', { e: err?.message || String(err) }); studioP = null; return null; });
    return studioP;
  };
  const visible = () => el.isConnected && el.offsetParent !== null && !document.hidden;
  const frame = now => {
    raf = 0;
    if (dead || suspended) return;
    if (!visible()) { raf = requestAnimationFrame(frame); return; }   // gizliyken çizim yok (döngü hafif)
    const dt = last ? Math.min(0.1, (now - last) / 1000) : 0;
    if (now - last < 32 && last) { raf = requestAnimationFrame(frame); return; }   // ≤ ~30 fps
    last = now;
    if (!drag) az += dt * (reduce ? 0.12 : 0.45);
    if (viewer && item) {
      const r = el.getBoundingClientRect(), dpr = Math.min(1.5, devicePixelRatio || 1);
      const w = Math.max(160, Math.round(r.width * dpr)), hh = Math.max(100, Math.round(r.height * dpr));
      if (cv.width !== w || cv.height !== hh) { cv.width = w; cv.height = hh; }
      const res = viewer.render(cv, item, { az, el: 0.32, zoom: 1.05, spin: dt * 40 });
      msg.textContent = res?.error ? tr('Model açılamadı') : res ? '' : tr('3B model yükleniyor…');
    }
    raf = requestAnimationFrame(frame);
  };
  const start = () => { if (!raf && !dead && !suspended) raf = requestAnimationFrame(frame); };
  cv.addEventListener('pointerdown', e => { drag = { x: e.clientX, az }; cv.setPointerCapture?.(e.pointerId); });
  cv.addEventListener('pointermove', e => { if (drag) az = drag.az + (e.clientX - drag.x) * 0.012; });
  const endDrag = () => { drag = null; };
  cv.addEventListener('pointerup', endDrag); cv.addEventListener('pointercancel', endDrag);
  return {
    el,
    async show(modelId, type, title, sub) {
      const my = ++want;
      capT.textContent = title || ''; capS.textContent = sub || '';
      msg.textContent = tr('3B model yükleniyor…');
      const it = await modelItem(modelId, type);
      if (my !== want || dead) return;
      item = it; viewer?.preload?.(it);
      await ensure();
      if (my !== want || dead) return;
      viewer?.preload?.(it);
      start();
    },
    suspend() { suspended = true; cancelAnimationFrame(raf); raf = 0; viewer = null; studio?.dispose(); studio = null; studioP = null; },
    resume() { if (!suspended || dead) return; suspended = false; if (item) Promise.resolve(ensure()).then(() => start()); },
    dispose() { dead = true; cancelAnimationFrame(raf); raf = 0; viewer = null; studio?.dispose(); studio = null; },
  };
}

// ======================================================================
// Üç sütunlu ekran: [Serbest Uçuş + kayıtlı simülasyonlar] · [uçuş kartları] · [dönen model + özet]
// opts: { be, tr, user, canWrite, master, initial ('free' | id), onStart(p), onEdit(p), onNew(), onPlay(run), onReport(run), onTable() }
// ======================================================================
export function savedScreen({ be, tr, user = null, canWrite = false, initial = null, onStart, onEdit, onNew, onPlay, onReport, onTable }) {
  ensureSavedCss();
  const master = !!user?.master;
  const me = user?.id ?? null;
  const PER = 30;
  let presets = [], sel = initial != null ? String(initial) : pref('fs.saved.sel', 'free'), runs = [], runsTotal = 0, page = 1, runSel = null, runsBusy = false;
  const leftList = h('div', { class: 'fs-sv-list', role: 'listbox', 'aria-label': tr('Simülasyonlar') });
  const leftCount = h('span', { class: 'badge gray' });
  const newBtn = h('button', { class: 'btn sm primary', type: 'button', disabled: !canWrite, onclick: () => onNew?.(), title: canWrite ? tr('Yeni sihirbaz: Uç ya da Kaydet') : tr('Oturum açmak için Dron Yönetimi yazma izni gerekir; açık oturumları ve kayıtları izleyebilirsiniz.') }, tr('+ Yeni'));
  const left = h('div', { class: 'fs-sv-col left' }, h('div', { class: 'fs-sv-colh' }, h('div', { class: 'fs-sv-colt', role: 'heading', 'aria-level': '3' }, tr('Simülasyonlar')), leftCount, newBtn), leftList);
  const midTitle = h('div', { class: 'fs-sv-colt', role: 'heading', 'aria-level': '3' }), midCount = h('span', { class: 'badge gray' });
  const runsBox = h('div', { class: 'fs-sv-runs' });
  const moreBtn = h('button', { class: 'btn sm fs-sv-more', type: 'button', hidden: true, onclick: () => loadRuns(false) }, tr('Daha fazla göster'));
  const tableLink = h('button', { class: 'btn sm ghost', type: 'button', onclick: () => onTable?.(), title: tr('Filtreli tablo: tarih, merkez, tip, kullanıcı, sonuç') }, tr('Tablo görünümü'));
  const mid = h('div', { class: 'fs-sv-col mid' }, h('div', { class: 'fs-sv-colh' }, midTitle, midCount, tableLink), runsBox, moreBtn);
  const spinner = modelSpinner({ tr });
  const detailBody = h('div', { class: 'fs-sv-body' });
  const detail = h('div', { class: 'fs-sv-detail' }, spinner.el, detailBody);
  const right = h('div', { class: 'fs-sv-col right' }, h('div', { class: 'fs-sv-colh' }, h('div', { class: 'fs-sv-colt', role: 'heading', 'aria-level': '3' }, tr('Özet'))), detail);
  const el = h('div', { class: 'fs-sv' }, left, mid, right);
  const presetOf = id => presets.find(p => String(p.id) === String(id)) || null;

  // ---------- sol: Serbest Uçuş + kayıtlı simülasyon kartları ----------
  const budgetChip = p => {
    const b = p.budget;
    if (!b || b.time_min == null) return null;
    return h('div', { class: 'fs-sv-chip', title: `${tr('Azami uçuş süresi ve menzil (seyirde)')} · ${b.limit === 'fuel' ? tr('yakıt sınırlar') : tr('batarya sınırlar')}` },
      h('span', { html: ICO.clock }), h('span', { class: 'v' }, fmtMin(b.time_min)), h('span', { html: ICO.range }), h('span', { class: 'v' }, fmtKm(b.range_km)),
      h('span', { class: `lim ${b.limit}`, html: b.limit === 'fuel' ? ICO.fuel : ICO.elec }));
  };
  const presetCard = p => {
    const on = sel === String(p.id);
    const assigned = p.pilot_id === me && p.created_by !== me;
    const startBtn = h('button', { class: 'btn sm primary', type: 'button', 'data-act': 'start', disabled: !p.can_start || !canWrite,
      title: p.can_start ? tr('Bu ayarlarla başlat (sihirbaz atlanır)') : tr('Yalnız atanan pilot ya da tasarlayan başlatabilir'),
      onclick: e => { e.stopPropagation(); onStart?.(p); } }, `▶ ${tr('Başlat')}`);
    const editBtn = p.can_edit ? h('button', { class: 'icon-btn', type: 'button', 'data-act': 'edit', title: tr('Düzenle'), 'aria-label': tr('Düzenle'), html: ICO.edit, onclick: e => { e.stopPropagation(); onEdit?.(p); } }) : null;
    const delBtn = p.can_edit ? h('button', { class: 'icon-btn danger', type: 'button', 'data-act': 'del', title: tr('Sil'), 'aria-label': tr('Sil'), html: RUN_ICON.trash, onclick: async e => {
      e.stopPropagation();
      if (!await confirmDialog(tr('Kayıtlı simülasyonu sil'), tr('"{n}" silinsin mi? Bu ayarlarla yapılmış uçuş kayıtları silinmez; Serbest Uçuş altında görünmeye devam eder.', { n: p.name }), { okLabel: tr('Sil'), danger: true })) return;
      try { await be.presetDelete(p.id); toast(tr('Kayıtlı simülasyon silindi')); if (sel === String(p.id)) sel = 'free'; refresh(); } catch (err) { toastError(err); }
    } }) : null;
    return h('div', { class: `fs-sv-card ${on ? 'on' : ''}`, role: 'option', tabindex: '0', 'aria-selected': on ? 'true' : 'false', 'data-preset': p.id,
      onclick: () => select(String(p.id)), onkeydown: e => { if ((e.key === 'Enter' || e.key === ' ') && e.target === e.currentTarget) { e.preventDefault(); select(String(p.id)); } } },
      assigned ? h('span', { class: 'badge blue fs-sv-assigned' }, tr('Size atandı')) : null,
      h('div', { class: 'fs-sv-ch' }, h('span', { class: 'fs-sv-ico', html: ICO.saved }),
        h('div', { class: 'fs-sv-tt' }, h('b', null, p.name), h('small', null, [tr(TYPE_NAME[p.type] || p.type || '—'), p.center_name].filter(Boolean).join(' · '))),
        h('span', { class: 'fs-sv-n', title: tr('Bu ayarlarla yapılan uçuş') }, String(p.run_count || 0))),
      p.description ? h('p', { class: 'fs-sv-desc' }, p.description) : null,
      h('div', { class: 'fs-sv-meta' },
        h('span', { class: p.pilot_id === me ? 'me' : '', title: tr('Atanan pilot') }, h('span', { html: ICO.pilot }), p.pilot_name ? p.pilot_name : tr('Pilot atanmadı')),
        h('span', { title: tr('Tasarlayan') }, h('span', { html: ICO.edit }), p.created_by_name || '—')),
      budgetChip(p),
      h('div', { class: 'fs-sv-acts' }, startBtn, h('span', { class: 'spacer' }), editBtn, delBtn));
  };
  const freeCard = () => {
    const on = sel === 'free';
    return h('div', { class: `fs-sv-card free ${on ? 'on' : ''}`, role: 'option', tabindex: '0', 'aria-selected': on ? 'true' : 'false', 'data-preset': 'free',
      onclick: () => select('free'), onkeydown: e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); select('free'); } } },
      h('div', { class: 'fs-sv-ch' }, h('span', { class: 'fs-sv-ico', html: ICO.free }),
        h('div', { class: 'fs-sv-tt' }, h('b', null, tr('Serbest Uçuş')), h('small', null, tr('Kaydedilmemiş sihirbazla yapılan uçuşlar'))),
        freeN));
  };
  const freeN = h('span', { class: 'fs-sv-n' }, '…');
  const drawLeft = () => {
    leftCount.textContent = String(presets.length);
    clear(leftList, freeCard(), presets.length ? presets.map(presetCard)
      : h('div', { class: 'fs-sv-empty' }, h('b', null, tr('Kayıtlı simülasyon yok')), tr('Sihirbazın son adımında "Kaydet" ile ayarları adla saklayın ve bir pilot atayın.')));
  };

  // ---------- orta: uçuş kartları ----------
  const att = r => h('span', { class: 'att' },
    r.has_video ? h('span', { title: tr('Ekran kaydı (video)'), html: RUN_ICON.video }) : null,
    r.bin_log_id ? h('span', { title: tr('.bin uçuş logu'), html: RUN_ICON.bin }) : null,
    r.has_summary ? h('span', { title: tr('Özet rapor'), html: RUN_ICON.report }) : null);
  const runCard = r => {
    const [cls, txt] = resultBadge(r), on = runSel?.id === r.id;
    return h('div', { class: `fs-sv-card fs-sv-run ${on ? 'on' : ''} ${r.result === 'carpisma' ? 'crash' : ''}`, role: 'option', tabindex: '0', 'aria-selected': on ? 'true' : 'false', 'data-run': r.id,
      onclick: () => selectRun(r), onkeydown: e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); selectRun(r); } } },
      h('div', { class: 'fs-sv-rh' }, h('b', null, fmtDateTime(r.started_at)), r.mode === 'replay' ? h('span', { class: 'badge purple' }, tr('Kayıt')) : null,
        h('span', { class: `badge ${cls}` }, r.result === 'carpisma' && r.crash_count > 1 ? `${tr(txt)} ×${r.crash_count}` : tr(txt))),
      h('div', { class: 'fs-sv-rl' }, h('strong', null, r.owner_name || '—'), ' · ', tr(TYPE_NAME[r.type] || r.type || '—'), r.model_name ? ` · ${r.model_name}` : ''),
      sel === 'free' && r.preset_id ? h('div', { class: 'fs-sv-rl fs-sv-deleted' }, h('span', { class: 'badge gray' }, tr('silinmiş kayıt')), ` ${r.preset_name || ''}`) : null,
      h('div', { class: 'fs-sv-rf' }, h('span', { html: ICO.clock, style: { width: '14px', height: '14px', display: 'inline-flex' } }), fmtSec(r.duration_s),
        r.center_name ? h('span', null, r.center_name) : null, r.speedup_max > 1 ? h('span', { class: 'badge gray' }, `${r.speedup_max}×`) : null,
        ((b) => (b ? h('span', { class: 'badge orange fs-sv-srv', title: b.title, style: { whiteSpace: 'nowrap', flexShrink: '0' } }, b.text) : null))(servoRunBadge(r, tr)), att(r)));   // §34
  };
  const drawMid = () => {
    const p = presetOf(sel);
    midTitle.textContent = sel === 'free' ? tr('Serbest uçuşlar') : p ? tr('{n} · uçuşlar', { n: p.name }) : tr('Uçuşlar');
    midCount.textContent = String(runsTotal);
    clear(runsBox, runs.length ? runs.map(runCard) : h('div', { class: 'fs-sv-empty', style: { gridColumn: '1 / -1' } },
      h('b', null, tr('Henüz uçuş yok')), sel === 'free' ? tr('"+ Yeni" ile sihirbazı açın; "Uç" ile yapılan uçuşlar burada görünür.') : p?.can_start ? tr('"Başlat" ile bu ayarlarla uçun; uçuş bitince kaydı burada görünür.') : tr('Atanan pilot bu ayarlarla uçtuğunda kayıtlar burada görünür.')));
    moreBtn.hidden = runs.length >= runsTotal;
  };
  async function loadRuns(reset = true) {
    if (runsBusy) return;
    runsBusy = true;
    if (reset) { page = 1; runs = []; }
    const my = sel;
    try {
      const r = await be.runs({ preset: sel, per_page: PER, page, sort: '-started_at' });
      if (my !== sel) return;
      runs = reset ? r.items : [...runs, ...r.items.filter(x => !runs.some(y => y.id === x.id))];
      runsTotal = r.total; page = (r.page || page) + 1;
      if (sel === 'free') freeN.textContent = String(r.total);
    } catch (err) { if (reset) { runs = []; runsTotal = 0; } toastError(err); } finally { runsBusy = false; }
    if (runSel && !runs.some(x => x.id === runSel.id)) runSel = null;
    if (!runSel && sel === 'free' && runs.length) runSel = runs[0];   // Serbest Uçuş: ilk (en yeni) uçuş seçili gelir
    drawMid(); drawDetail();
  }

  // ---------- sağ: dönen model + özet ----------
  const fact = f => h('div', { class: `fs-sv-fact ${f.tone ? `t-${f.tone}` : ''}`, 'data-k': f.key }, h('small', null, tr(f.label)), h('b', null, tr(f.value)), f.sub ? h('i', null, tr(f.sub)) : null);
  const dl = rows => h('dl', { class: 'fs-sv-dl' }, rows.filter(Boolean).map(([a, b]) => [h('dt', null, tr(a)), h('dd', null, b)]));
  const drawRunDetail = r => {
    const w = r.world || {};
    spinner.show(r.model_id, r.type, r.model_name || tr(TYPE_NAME[r.type] || r.type || ''), [tr(TYPE_NAME[r.type] || r.type || ''), r.drone_code].filter(Boolean).join(' · '));
    const playOk = !!(r.play_log_id && onPlay && canWrite);
    const btn = (label, icon, attrs, cls = '') => h('button', { class: `btn sm ${cls}`, type: 'button', ...attrs }, h('span', { class: 'fs-runs-bi', html: icon }), label);
    clear(detailBody,
      h('div', { class: 'fs-sv-title' }, h('div', { class: 't', role: 'heading', 'aria-level': '4' }, fmtDateTime(r.started_at)), h('span', { class: `badge ${resultBadge(r)[0]}` }, tr(resultBadge(r)[1]))),
      h('div', { class: 'fs-sv-sub' }, [r.owner_name, `#${r.session_id}`, r.preset_name ? `${tr('Kayıtlı')}: ${r.preset_name}` : tr('Serbest uçuş')].filter(Boolean).join(' · ')),
      h('div', { class: 'fs-sv-facts' }, runFacts(r).map(fact)),
      dl([['Merkez', r.center_name || '—'], ['Dünya', tr(WORLD_MODE[w.mode] || w.mode || '—')], r.launch?.method ? ['Kalkış', launchLabel(r.launch, tr)] : null,
        r.camera ? ['Kamera', tr(CAMERA[r.camera] || r.camera)] : null, r.drone_code ? ['Dron kaydı', r.drone_code] : null, ['Bitiş', r.ended_at ? fmtDateTime(r.ended_at) : '—']]),
      h('div', { class: 'fs-sv-dacts pill-group' },
        btn(tr('Oynat'), RUN_ICON.play, { disabled: !playOk, 'data-act': 'play', title: r.play_log_id ? tr('Kaydedilen ayarlarla doğrudan izle') : tr('Oynatılabilir .bin yok (kayıt kapalıydı ya da analiz sürüyor)'), onclick: () => onPlay?.(r) }, playOk ? 'primary' : ''),
        btn(tr('Rapor'), RUN_ICON.report, { disabled: !r.has_summary, 'data-act': 'report', onclick: async () => { try { await onReport?.(r); } catch (err) { toastError(err); } } }),
        r.has_video ? btn(tr('Video'), RUN_ICON.video, { 'data-act': 'video', onclick: () => runVideoDialog(r, tr) }) : null,
        master ? h('button', { class: 'btn sm danger', type: 'button', 'data-act': 'download', 'aria-haspopup': 'menu', onclick: e => runDownloadMenu(e.currentTarget, r, { tr, onReport }) },
          h('span', { class: 'fs-runs-bi', html: RUN_ICON.download }), 'Download ▾') : null,
        h('span', { class: 'spacer' }),
        r.can_delete ? h('button', { class: 'btn sm ghost', type: 'button', 'data-act': 'del', title: tr('Kaydı sil'), onclick: async () => {
          if (!await confirmDialog(tr('Kaydı sil'), tr('Simülasyon kaydı ve parametre/script dosyaları silinir; özet rapor, .bin uçuş logu ve video kendi yerlerinde kalır.'), { okLabel: tr('Sil'), danger: true })) return;
          try { await be.runDelete(r.id); toast(tr('Kayıt silindi')); runSel = null; loadRuns(); refreshPresets(); } catch (err) { toastError(err); }
        } }, h('span', { class: 'fs-runs-bi', html: RUN_ICON.trash }), tr('Sil')) : null));
  };
  const drawPresetDetail = p => {
    const st = p.settings || {}, w = st.world || {};
    spinner.show(st.model?.id || st.model, p.type, p.name, tr(TYPE_NAME[p.type] || p.type || ''));
    clear(detailBody,
      h('div', { class: 'fs-sv-title' }, h('div', { class: 't', role: 'heading', 'aria-level': '4' }, p.name), p.pilot_id === me && p.created_by !== me ? h('span', { class: 'badge blue' }, tr('Size atandı')) : null),
      p.description ? h('div', { class: 'fs-sv-sub' }, p.description) : null,
      budgetBox({ tr, budget: p.budget || flightBudget(st.power, p.type), compact: true }),
      dl([['Pilot', p.pilot_name || tr('Pilot atanmadı')], ['Tasarlayan', p.created_by_name || '—'], ['Merkez', p.center_name || '—'],
        ['Dünya', tr(WORLD_MODE[w.mode] || w.mode || 'Prosedürel')], w.launch?.method && p.type === 'sabit_kanat' ? ['Kalkış', launchLabel(w.launch, tr)] : null,
        p.type === 'rover' && st.drive ? ['Sürüş biçimi', tr(st.drive === 'skid' ? 'Paletli / diferansiyel' : 'Ackermann')] : null,   // §31
        st.camera ? ['Kamera', tr(CAMERA[st.camera] || st.camera)] : null, st.targets?.items?.length || Array.isArray(st.targets) ? ['Hedefler', String((st.targets.items || st.targets).length)] : null,
        ['Uçuş', tr('{n} kez · son {t}', { n: p.run_count || 0, t: p.last_run_at ? fmtDateTime(p.last_run_at) : '—' })], ['Güncellendi', fmtDateTime(p.updated_at)]]),
      h('div', { class: 'fs-sv-dacts' },
        h('button', { class: 'btn primary', type: 'button', 'data-act': 'start', disabled: !p.can_start || !canWrite, onclick: () => onStart?.(p),
          title: p.can_start ? tr('Bu ayarlarla başlat (sihirbaz atlanır)') : tr('Yalnız atanan pilot ya da tasarlayan başlatabilir') }, `▶ ${tr('Başlat')}`),
        p.can_edit ? h('button', { class: 'btn', type: 'button', 'data-act': 'edit', onclick: () => onEdit?.(p) }, tr('Düzenle')) : null,
        h('span', { class: 'spacer' }),
        runs.length ? h('span', { class: 'small muted' }, tr('Bir uçuş kartı seçin: özet burada açılır.')) : null));
  };
  function drawDetail() {
    const p = presetOf(sel);
    if (runSel) drawRunDetail(runSel);
    else if (p) drawPresetDetail(p);
    else { spinner.show(null, 'sabit_kanat', tr('Serbest Uçuş'), ''); clear(detailBody, h('div', { class: 'fs-sv-placeholder' }, tr('Bir uçuş kartı seçin: süre, mesafe, yakıt/batarya, çarpışma ve önleme özeti burada görünür.'))); }
  }

  // ---------- seçim ----------
  function select(key) {
    key = String(key);
    if (key !== 'free' && !presetOf(key)) key = 'free';
    const changed = key !== sel;
    sel = key; setPref('fs.saved.sel', sel);
    if (changed) runSel = null;
    drawLeft();
    if (changed || !runs.length) loadRuns(); else { drawMid(); drawDetail(); }
  }
  function selectRun(r) {
    runSel = runSel?.id === r.id && sel !== 'free' ? null : r;   // kayıtlıda aynı karta ikinci tık → kayıt özetine dön
    drawMid(); drawDetail();
    if (window.matchMedia?.('(max-width: 1280px)').matches) right.scrollIntoView?.({ behavior: 'smooth', block: 'nearest' });   // tablet/mobil: özet görünür alana
  }
  async function refreshPresets() {
    try { presets = await be.presets(); } catch (err) { presets = []; if (err?.status !== 404) toastError(err); }
    if (sel !== 'free' && !presetOf(sel)) sel = 'free';
    drawLeft();
  }
  async function refresh(next = null) {
    await refreshPresets();
    if (next != null) { runSel = null; sel = presetOf(next) ? String(next) : 'free'; setPref('fs.saved.sel', sel); drawLeft(); }
    if (sel !== 'free') be.runs({ preset: 'free', per_page: 1 }).then(r => { freeN.textContent = String(r.total); }).catch(() => {});
    await loadRuns();
  }
  drawLeft(); drawMid();
  refresh();
  onLeave(() => spinner.dispose());
  return { el, refresh, select, suspend3d: () => spinner.suspend(), resume3d: () => spinner.resume(), dispose: () => spinner.dispose(), get presets() { return presets; } };
}
