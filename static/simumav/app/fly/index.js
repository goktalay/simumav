// SIMUMAV › Uç — oyun arayüzü kabuğunun `#/fly` için çağırdığı modül: export render(view, params, ctx).
//   ctx: { i18n: t(s,p)?, toast(msg,type)?, go(hash)?, user?, settings?, meta? } — eksikler simui.js karşılıklarıyla doldurulur.
//   params: {} → sihirbaz; { id | flight } → süren uçuşa geri dön (GET /api/fly/{id} → start biçimi).
// Sihirbaz (oyun tadında, 5 adım; wizard.js saf adım makinesi): 1 dron (kütüphane kartları + dönen 3B önizleme, /api/hangar) · 2 parkur (/api/tracks;
// dünya kipi + halka sayısı) · 3 kalkış yöntemi (yalnız plane/interceptor/vtol: Rampa / Araç Üstü / Tekerlekli / ELDEN ATIŞ; açı/hız) · 4 görev
// (isteğe bağlı, /api/missions?track_id=) · 5 pilot (/api/crew; varsayılan seçili) + kamera türü (./camera_pick.js) + kayıt seçenekleri (video / .bin) → BAŞLA (geri sayım) →
// (3b: "Güç ve yakıt" — power.js createPowerStep: hangar değerleri ön dolu, son uçuş ölçümü "Önerilen", simülasyon hızı ≤ meta.power.max_speedup; §10)
// session.js openSession. Stiller: ./fly.css (sihirbaz + sahne ekleri) ve ./fly-sim.css (HEPGO fs-* kopyası) bir kez eklenir.
import { clear, h, toast, toastError, confirmDialog, fmtDuration, t as tr, onLeave, runLeave } from './simui.js';
import { net } from './net.js';
import { COUNTDOWN_S, ICEPT_CELLS, ICEPT_LAUNCH_SM, ICEPT_LIMITS, LAUNCH_LIMITS, LAUNCH_METHODS_SM, STEP_TITLES, iceptLaunchBody, iceptLaunchLabel, TYPE_LABEL, WORLD_MODE_LABEL, airframeLabel, airframeOf, countdownAt, createWizard, launchLabelSm, modelFor, needsAirframe, needsLaunch, simType, speedScale, worldFromTrack } from './wizard.js';
import { openSession, startFlight, fetchMeta } from './session.js';
import { canFuel, createPowerStep, powerOf } from './power.js';
import { createCameraPick } from './camera_pick.js';   // kamera türü kartları (pilot adımı; HEPGO §22.3)
import { createTargetsStep } from './targets.js';   // HEDEFLER adımı (HEPGO §24)

const here = new URL('.', import.meta.url);
function ensureCss() {
  for (const f of ['fly-sim.css', 'fly.css', 'power.css']) {
    const href = new URL(f, here).href;
    if (!document.querySelector(`link[href="${href}"]`)) document.head.append(h('link', { rel: 'stylesheet', href }));
  }
}
const TYPE_ICON = {
  multirotor: '<svg viewBox="0 0 48 48"><circle cx="12" cy="12" r="7"/><circle cx="36" cy="12" r="7"/><circle cx="12" cy="36" r="7"/><circle cx="36" cy="36" r="7"/><path d="M12 12 36 36M36 12 12 36"/><rect x="19" y="19" width="10" height="10" rx="2"/></svg>',
  fpv: '<svg viewBox="0 0 48 48"><circle cx="11" cy="14" r="6"/><circle cx="37" cy="14" r="6"/><circle cx="11" cy="34" r="6"/><circle cx="37" cy="34" r="6"/><path d="M11 14 37 34M37 14 11 34"/><rect x="17" y="18" width="14" height="12" rx="3"/><circle cx="24" cy="24" r="3"/></svg>',
  heli: '<svg viewBox="0 0 48 48"><path d="M4 10h40M24 10v6"/><ellipse cx="22" cy="24" rx="12" ry="8"/><path d="M34 24h10l-4-6M8 36h16"/></svg>',
  plane: '<svg viewBox="0 0 48 48"><path d="M24 6v36M8 26l16-8 16 8M16 40l8-4 8 4"/></svg>',
  interceptor: '<svg viewBox="0 0 48 48"><path d="M24 3c2.6 2.6 3.6 6 3.6 10v25h-7.2V13c0-4 1-7.4 3.6-10Z"/><path d="M20.4 26 10 35M27.6 26 38 35M20.4 32 15 43M27.6 32 33 43"/><path d="M5 31h6M37 31h6M4 12h7M4 18h5"/></svg>',
  vtol: '<svg viewBox="0 0 48 48"><path d="M24 8v32M6 26l18-8 18 8"/><circle cx="10" cy="20" r="5"/><circle cx="38" cy="20" r="5"/><circle cx="10" cy="34" r="5"/><circle cx="38" cy="34" r="5"/></svg>',
};
const svgIco = s => h('i', { class: 'sm-ico', html: s || TYPE_ICON.multirotor });
// Önizlemede park duruşu: INTERCEPTOR (tailsitter) kuyruğu üstünde burun yukarı durur (HEPGO §25 att_body); diğerleri düz
const parkPose = (sim, type) => { if (type === 'interceptor') sim?.setTelemetry({ lat: 0, lon: 0, alt_rel: 0, roll: 0, pitch: 0, yaw: 0, att_body: [0, Math.PI / 2, 0.6], tbm: 0, armed: false }); };

/** Kabuk başka rotaya geçerken: sihirbaz/sahne temizliği (onLeave kayıtları: 3B önizleme, WS, ses, kayıt). */
export function unmount() { runLeave(); }

export async function render(view, params = {}, ctx = {}) {
  ensureCss();
  runLeave();   // önceki sahne/sihirbaz temizliği
  if (ctx.i18n && typeof ctx.i18n === 'function') globalThis.__smT = ctx.i18n;
  const go = ctx.go || (hash => { location.hash = hash; });
  const fid = params.id ?? params.flight ?? null;
  if (fid != null) return resumeFlight(view, fid, ctx);
  return renderWizard(view, { ...ctx, go });
}

async function resumeFlight(view, fid, ctx) {
  clear(view, h('div', { class: 'sm-fly sm-loading' }, tr('Uçuş açılıyor…')));
  try {
    const f = await net.get(`/api/fly/${encodeURIComponent(fid)}`);
    if (!f || f.ended_at || f.state === 'KAPANDI') { toast(tr('Uçuş bitmiş; Operasyon\'da raporu görebilirsiniz')); return (ctx.go || (h => { location.hash = h; }))('#/ops'); }
    const start = { flight_id: f.flight_id ?? f.id ?? fid, sim_id: f.sim_id, mp: f.mp, ws: f.ws, session: f.session, drone: f.drone, track: f.track, pilot: f.pilot, mission: f.mission, launch: f.launch, record: f.record, power: f.snapshot?.power, speedup: f.snapshot?.speedup, site: f.session?.site || null };
    return openSession(view, start, { drone: f.drone, track: f.track, pilot: f.pilot, mission: f.mission, launch: f.launch, record: f.record, power: f.snapshot?.power, speedup: f.snapshot?.speedup }, ctx);
  } catch (err) { toastError(err); clear(view, h('div', { class: 'sm-fly sm-loading' }, h('p', null, tr('Uçuş açılamadı: {e}', { e: err.message })), h('button', { class: 'btn primary', type: 'button', onclick: () => (ctx.go || (h => { location.hash = h; }))('#/fly') }, 'Sihirbaza dön'))); }
}

// ======================================================================
// Sihirbaz
// ======================================================================
async function renderWizard(view, ctx) {
  const root = h('div', { class: 'sm-fly sm-wizard' });
  clear(view, h('div', { class: 'sm-fly sm-loading' }, tr('Hangar, parkurlar ve mürettebat yükleniyor…')));
  let data, openFlight = null;
  try {
    const [hangar, tracks, crew, missions, meta, cur] = await Promise.all([net.get('/api/hangar'), net.get('/api/tracks'), net.get('/api/crew'), net.get('/api/missions').catch(() => ({ missions: [] })), ctx.meta ? Promise.resolve(ctx.meta) : fetchMeta(), fetchCurrent()]);
    data = { drones: hangar?.drones || hangar || [], tracks: tracks?.tracks || tracks || [], pilots: crew?.pilots || crew || [], missions: missions?.missions || missions || [], meta: meta || {} };
    openFlight = cur;
  } catch (err) { toastError(err); clear(view, h('div', { class: 'sm-fly sm-loading' }, h('p', null, tr('Veriler alınamadı: {e}', { e: err.message })), h('button', { class: 'btn primary', type: 'button', onclick: () => renderWizard(view, ctx) }, 'Yeniden dene'))); return; }
  if (!data.drones.length) { clear(view, h('div', { class: 'sm-fly sm-loading' }, h('p', null, tr('Hangarınız boş. Önce bir dron ekleyin.')), h('button', { class: 'btn primary', type: 'button', onclick: () => ctx.go('#/hangar') }, 'Hangar\'a git'))); return; }
  const W = createWizard(data, ctx.preset || {});
  const camPick = createCameraPick({ h, tr, getDrone: () => W.drone() });
  const PREVIEW_URL = '/sim/flightsim3d.js';
  let preview = null, previewBox = null, previewType = null, previewModelId = null, destroyed = false;

  // ---------- iskelet: başlık + adım şeridi + gövde + alt gezinti ----------
  const stepsBar = h('div', { class: 'sm-steps' });
  const body = h('div', { class: 'sm-step-body' });
  const prevBtn = h('button', { class: 'btn sm-nav-btn', type: 'button', onclick: () => { if (W.prev()) draw(); } }, '‹ ', 'Geri');
  const nextBtn = h('button', { class: 'btn primary sm-nav-btn', type: 'button', onclick: () => { if (W.next()) draw(); } }, 'İleri', ' ›');
  const startBtn = h('button', { class: 'sm-start-btn', type: 'button', hidden: true, onclick: () => start() }, h('span', { class: 'sm-start-ring' }), h('b', null, 'BAŞLA'));
  const foot = h('div', { class: 'sm-wizard-foot' }, prevBtn, h('div', { class: 'sm-summary' }), nextBtn, startBtn);
  const countdown = h('div', { class: 'sm-countdown', hidden: true }, h('b', null, '3'), h('small', null, ''));
  const openBox = h('div', { class: 'sm-open-flight-holder' });
  root.append(h('div', { class: 'sm-wizard-head' }, h('h1', null, 'UÇ'), h('p', { class: 'muted' }, 'Dronunu seç, parkuru belirle, kalk.')), openBox, stepsBar, body, foot, countdown);
  clear(view, root);

  // ---------- "Süren uçuşunuz var" kartı: GET /api/fly/current ya da BAŞLA → 409 flight_open ----------
  const drawOpen = () => {
    clear(openBox);
    if (!openFlight) return;
    const f = openFlight, id = f.flight_id ?? f.id;
    const sub = [f.drone?.name, f.track?.name, f.pilot?.name, f.elapsed_s != null ? tr('{d} sürüyor', { d: fmtDuration(f.elapsed_s) }) : null, f.state ? (f.state === 'HAZIR' ? tr('SITL hazır') : f.state) : null].filter(Boolean).join(' · ');
    const endBtn = h('button', { class: 'btn danger', type: 'button', onclick: async () => {
      if (!await confirmDialog(tr('Uçuşu bitir'), tr('Süren uçuş sunucuda kapatılsın mı? Özet Operasyon\'da saklanır.'), { okLabel: tr('Bitir'), danger: true })) return;
      endBtn.disabled = true;
      try { await net.post(`/api/fly/${encodeURIComponent(id)}/stop`, { reason: 'wizard' }); toast(tr('Uçuş kapatıldı')); openFlight = null; drawOpen(); drawFoot(); }
      catch (err) { if (err?.status === 404) { openFlight = null; drawOpen(); drawFoot(); } else { toastError(err); endBtn.disabled = false; } }
    } }, '■ ', tr('Uçuşu bitir'));
    openBox.append(h('div', { class: 'sm-open-flight', role: 'status' }, h('span', { class: 'sm-of-ico', 'aria-hidden': 'true' }, '✈'),
      h('div', { class: 'sm-of-text' }, h('b', null, tr('Süren uçuşunuz var')), h('span', null, sub || tr('Uçuş #{id}', { id }))),
      h('div', { class: 'btn-row' }, h('button', { class: 'btn primary', type: 'button', onclick: () => ctx.go(`#/fly/${encodeURIComponent(id)}`) }, tr('Uçuşa dön')), endBtn)));
  };
  const showOpenFromError = async err => {   // 409 gövdesi {error:'flight_open', flight_id, sim_id}
    const d = err?.detail || {};
    openFlight = (await fetchCurrent()) || { flight_id: d.flight_id, sim_id: d.sim_id };
    if (openFlight.flight_id == null) openFlight = null;
    drawOpen(); drawFoot();
    openBox.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' });
  };

  const drawSteps = () => {
    const steps = W.steps(), cur = W.step();
    clear(stepsBar, steps.map((k, i) => h('button', { type: 'button', class: `sm-step ${k === cur ? 'on' : ''} ${i < W.index() ? 'done' : ''}`, onclick: () => { if (W.goto(k)) draw(); } }, h('b', null, String(i + 1)), h('span', null, STEP_TITLES[k]))));
  };
  const drawFoot = () => {
    const last = W.isLast();
    prevBtn.disabled = W.index() === 0; nextBtn.hidden = last; nextBtn.disabled = !W.canNext(); startBtn.hidden = !last; startBtn.disabled = !W.ready() || !!openFlight;
    startBtn.title = openFlight ? tr('Önce süren uçuşunuza dönün ya da bitirin') : '';
    const d = W.drone(), t = W.track(), p = W.pilot(), m = W.mission();
    const pw = W.state.power || (d ? powerOf(d) : null);
    const pwTxt = pw ? `⚡ ${pw.engine === 'fuel' ? `${pw.fuel_l} L` : tr('power.engine_electric')} · ${Math.round(pw.elec_cells)}S${W.state.speedup > 1 ? ` · ${W.state.speedup}×` : ''}` : null;
    const tg = W.state.targets?.items?.length ? `◎ ${W.state.targets.items.length}` : null;   // HEPGO §24 hedef sayısı
    const st = W.state.site, sv = [st?.radar ? `R${st.radar_km}` : null, st?.station ? 'GKS' : null, st?.eo ? `EO${st.eo_km}` : null].filter(Boolean).join('·');
    const siteTxt = sv ? `◈ ${sv}${W.state.defend || m?.kind === 'defend' ? ` · ${tr('site.defend')}` : ''}` : null;   // HEPGO §26
    clear(foot.querySelector('.sm-summary'), [d ? `${d.name}` : null, t ? t.name : null, d && needsLaunch(d.type) ? launchLabelSm(W.state.launch) : d?.type === 'interceptor' ? iceptLaunchLabel(W.state.ilaunch, tr) : null, pwTxt, m ? m.name : null, siteTxt, tg, p ? p.name : null].filter(Boolean).join(' · '));
  };
  // ---------- §10 güç ve yakıt adımı (dron değişince ön ayar sıfırlanır) ----------
  let powerPreset = null;
  const stepPower = () => {
    const d = W.drone(), mp = data.meta.power || {};
    if (powerPreset && powerPreset.drone_id !== d?.id) powerPreset = null;
    const ui = createPowerStep({ h, t: tr, drone: d, limits: mp.limits || undefined, speedups: mp.speedups || [1, 2, 4], preset: powerPreset || { speedup: W.state.speedup },
      onChange: ps => { W.set('power', ps.body()); W.set('speedup', ps.speedup); powerPreset = { drone_id: d?.id, values: { ...ps.values }, applied: [...ps.state.applied], speedup: ps.speedup }; drawFoot(); } });
    W.set('power', ui.ps.body()); W.set('speedup', ui.ps.speedup);
    powerPreset = { drone_id: d?.id, values: { ...ui.ps.values }, applied: [...ui.ps.state.applied], speedup: ui.ps.speedup };
    body.append(h('div', { class: 'sm-pw-head' }, h('h2', null, '⚡ ', tr('power.title')), h('p', { class: 'muted' }, tr(canFuel(d?.type) ? 'power.step_sub' : 'power.step_sub_copter', { name: d?.name || '' }))), ui.el);
  };
  const card = (sel, { icon, title, sub, badge, onClick, cls = '' }) => h('button', { type: 'button', class: `sm-card ${sel ? 'sel' : ''} ${cls}`, onclick: onClick }, icon || null, h('b', null, title), sub ? h('span', { class: 'sm-card-sub' }, sub) : null, badge ? h('span', { class: 'sm-card-badge' }, badge) : null);

  // ---------- 3B önizleme (dönen; preview:true) ----------
  const ensurePreview = async () => {
    const d = W.drone(); if (!d || destroyed) return;
    const type = simType(d.type), model = modelFor(d);
    if (!preview) {
      try {
        const M3D = await import(PREVIEW_URL);
        if (destroyed || !previewBox?.isConnected) return;
        // Dönen dron önizlemesi: preview:true dünya turu yapar (uzak); burada normal kip + serbest kamera dronun çevresinde döndürülür (klavye kilitli)
        const world = { ...M3D.WORLD_DEFAULTS, mode: 'procedural', size_m: 1500, building_count: 0, tree_density: 0.08, fog: 0.05, seed: 4242 };
        preview = await M3D.createFlightSim3D(previewBox, world, { preview: false, type, model, launch: needsLaunch(d.type) ? { method: 'wheels' } : d.type === 'interceptor' && W.step() === 'launch' ? iceptLaunchBody(W.state.ilaunch) : null, camera: 'free', homeMark: false });
        window.__smPreview = preview;   // teşhis (Playwright): modelInfo, kamera
        parkPose(preview, type);
        if (destroyed) { preview.dispose(); preview = null; return; }
        preview.setKeyboardLock?.(true);
        let ang = 0.8;
        preview.addFrameHook?.(() => {
          const rf = preview.rigFocus;   // HEPGO §27: fırlatıcı adımında düzeneğin çevresinde
          if (rf) { ang += 0.005; const x = rf.x + Math.cos(ang) * rf.r, y = rf.y + Math.sin(ang) * rf.r, z = rf.z + rf.h + rf.r * 0.32, tz = rf.z + rf.h * 0.55; const dx = rf.x - x, dy = rf.y - y, dz = tz - z, L = Math.hypot(dx, dy, dz) || 1; preview.setFreeView(x, y, z, Math.atan2(-dx, dy) * 180 / Math.PI, Math.asin(dz / L) * 180 / Math.PI); return; }
          const mi = preview.modelInfo, bb = mi?.bbox?.size || [1, 1, 0.4], dik = mi?.type === 'interceptor';
          // INTERCEPTOR park duruşu dikey (kuyruk yerde): bakış noktası gövde ortası (−min.y × 2,5), küçük gövdeye yakın kamera
          const r = Math.max(dik ? 0.45 : 1.2, Math.max(bb[0], bb[1]) / 2 * 2.5) * (dik ? 2.1 : 3.2), zc = dik ? Math.max(0.3, -(mi.bbox.min?.[1] ?? -0.2) * 2.5) : Math.max(bb[2], 0.3) * 2.5 * 0.5 + 0.2;
          ang += 0.006;
          const x = Math.cos(ang) * r, y = Math.sin(ang) * r, z = zc + r * 0.42;
          const dx = -x, dy = -y, dz = zc - z, L = Math.hypot(dx, dy, dz) || 1;
          preview.setFreeView(x, y, z, Math.atan2(-dx, dy) * 180 / Math.PI, Math.asin(dz / L) * 180 / Math.PI);
        });
        previewBox.querySelector('.sm-preview-msg')?.remove();
        previewType = type; previewModelId = model.id;
      } catch (err) { if (previewBox) clear(previewBox, h('div', { class: 'sm-preview-msg' }, tr('3B önizleme açılamadı: {e}', { e: err.message }))); }
      return;
    }
    if (!previewBox.contains(preview.canvas)) previewBox.append(preview.canvas);
    if (previewType !== type || previewModelId !== model.id) { previewType = type; previewModelId = model.id; preview.setType(type, model).then(() => parkPose(preview, type)).catch(() => {}); }
  };

  // ---------- adımlar ----------
  const stepDrone = () => {
    previewBox = previewBox || h('div', { class: 'sm-preview' }, h('div', { class: 'sm-preview-msg' }, tr('3B önizleme hazırlanıyor…')));
    const list = h('div', { class: 'sm-cards sm-cards-drones' });
    const drawList = () => clear(list, data.drones.map(d => card(d.id === W.state.drone_id, { icon: svgIco(TYPE_ICON[d.type]), title: d.name, sub: `${TYPE_LABEL[d.type] || d.type} · ${speedScale(d.type, d.model_key)} km/h`, badge: d.is_default ? 'Varsayılan' : null, cls: `type-${d.type}`,
      onClick: () => { W.set('drone_id', d.id); drawList(); drawInfo(); drawSteps(); drawFoot(); ensurePreview(); } })));
    const info = h('div', { class: 'sm-drone-info' });
    const drawInfo = () => { const d = W.drone(); clear(info, d ? [h('h2', null, d.name), h('p', { class: 'muted' }, `${TYPE_LABEL[d.type] || d.type} · ${d.model_label || d.model_key || ''}${d.type === 'interceptor' ? ` · ${tr('targets.icept_info')}` : ''}${d.type === 'fpv' ? ' · FPV kamera + OSD' : ''}${needsAirframe(d.type) ? ` · ${tr('Kontrol düzeni')}: ${airframeLabel(airframeOf(d), tr)}` : ''}`)] : null); };   // §13.1 düzen (hangar kaydı)
    drawList(); drawInfo();
    body.append(h('div', { class: 'sm-two' }, h('div', null, list), h('div', { class: 'sm-preview-col' }, previewBox, info)));
    ensurePreview();
  };
  const stepTrack = () => {
    const list = h('div', { class: 'sm-cards sm-cards-tracks' });
    const drawList = () => clear(list, data.tracks.map(t => {
      const w = worldFromTrack(t, data.meta.maps_key), ng = Array.isArray(t.gates) ? t.gates.length : 0;
      return card(t.id === W.state.track_id, { icon: t.preview_png ? h('img', { class: 'sm-card-img', src: t.preview_png, alt: '' }) : h('i', { class: 'sm-ico sm-ico-track', html: '<svg viewBox="0 0 48 48"><path d="M4 36l12-16 8 10 8-14 12 20z"/><circle cx="36" cy="12" r="4"/></svg>' }),
        title: t.name, sub: `${WORLD_MODE_LABEL[w.mode] || w.mode} · ${Number(t.lat).toFixed(4)}, ${Number(t.lon).toFixed(4)} · ${t.radius_m || '—'} m · rüzgâr ${t.wind?.speed_ms ?? 0} m/s${ng ? ` · ${ng} halka` : ''}`, badge: t.is_default ? 'Varsayılan' : null,
        onClick: () => { W.set('track_id', t.id); drawList(); drawFoot(); } });
    }));
    drawList();
    body.append(data.tracks.length ? list : h('p', { class: 'muted' }, tr('Parkur yok; Parkur modülünden ekleyin.')));
  };
  // HEPGO §27 INTERCEPTOR fırlatıcısı: 4 kart (4'lü / 8'li / yerden tekli / el fırlatıcısı) + dolu hücre ya da nişan kaydırıcıları + düzenek önizlemesi
  const LT = (k, tx, p) => { const r = tr(k, p); return r && r !== k ? r : tx.replace(/\{(\w+)\}/g, (m, q) => (p?.[q] != null ? String(p[q]) : m)); };
  const ICEPT_ICON = {
    pod4: '<svg viewBox="0 0 48 48"><rect x="10" y="18" width="28" height="22" rx="2"/><path d="M24 18v22M10 29h28M11 18 7 10h10l3 8"/><path d="M15 40v4M33 40v4"/></svg>',
    pod8: '<svg viewBox="0 0 48 48"><rect x="4" y="20" width="40" height="18" rx="2"/><path d="M14 20v18M24 20v18M34 20v18M4 29h40M5 20 3 12h8l3 8"/></svg>',
    tube: '<svg viewBox="0 0 48 48"><rect x="18" y="8" width="12" height="24" rx="2"/><path d="M18 8l-4-5h10M24 32l-10 12M24 32l10 12M24 32v12"/></svg>',
    handheld: '<svg viewBox="0 0 48 48"><circle cx="12" cy="9" r="4"/><path d="M12 13v13l-4 16M12 26l4 16M12 18l8 2"/><path d="m18 22 22-13 3 5-22 13z"/><rect x="27" y="10" width="6" height="4" rx="1" transform="rotate(-30 30 12)"/></svg>',
  };
  const stepIceptLaunch = () => {
    previewBox = previewBox || h('div', { class: 'sm-preview' }, h('div', { class: 'sm-preview-msg' }, tr('3B önizleme hazırlanıyor…')));
    const list = h('div', { class: 'sm-cards sm-cards-launch' });
    const opts = h('div', { class: 'sm-launch-opts' });
    const apply = () => { preview?.setLaunch?.(iceptLaunchBody(W.state.ilaunch)); };
    const slider = (key, label, unit) => {
      const [a, b0] = ICEPT_LIMITS[key], b = key === 'loaded' ? ICEPT_CELLS[W.state.ilaunch.method] : b0;
      const inp = h('input', { type: 'range', min: a, max: b, step: 1, value: W.state.ilaunch[key] });
      const out = h('b', { class: 'mono' }, `${Math.round(W.state.ilaunch[key])}${unit}`);
      inp.addEventListener('input', () => { W.set('ilaunch', { [key]: Number(inp.value) }); out.textContent = `${Math.round(W.state.ilaunch[key])}${unit}`; drawFoot(); apply(); });
      return h('label', { class: 'sm-slider' }, h('span', null, label), inp, out);
    };
    const drawOpts = () => {
      const m = W.state.ilaunch.method;
      clear(opts, m === 'pod4' || m === 'pod8' ? [slider('loaded', LT('launcher.loaded', 'Dolu hücre'), ` / ${ICEPT_CELLS[m]}`), h('p', { class: 'small muted' }, LT('launcher.defend_note', '"Yer kontrolünü koru" görevinde dolu hücre görevin interceptor sayısıdır: kutular yan yana kurulur (10\'lu raf yerine).'))]
        : m === 'handheld' ? [slider('aim_az_deg', LT('launcher.aim_az', 'Nişan yönü'), '°'), slider('aim_el_deg', LT('launcher.aim_el', 'Nişan açısı'), '°'), h('p', { class: 'small muted' }, LT('launcher.hand_note', 'Uçuşta "Nişangâh" penceresi: aparatın baktığı yöne kamera ve hedefler; fare, I/J/K/L ya da ok düğmeleriyle nişan alın, "Fırlat" ile interceptor nişan yönünde çıkar.'))]
        : h('p', { class: 'small muted' }, LT('launcher.tube_note', 'Görevde 10\'lu raf yedek deposudur; her "sıradaki interceptor" tüpe yeniden yüklenir.')));
    };
    const drawList = () => clear(list, ICEPT_LAUNCH_SM.map(([k, nk, name, dk, desc]) => card(k === W.state.ilaunch.method, { icon: h('i', { class: `sm-ico sm-ico-icept sm-icept-${k}`, html: ICEPT_ICON[k] }), title: LT(nk, name), sub: LT(dk, desc), badge: k === 'handheld' ? LT('launcher.scope_badge', 'Nişangâh') : null, cls: k === 'handheld' ? 'hand' : '', onClick: () => { W.set('ilaunch', { method: k }); drawList(); drawOpts(); drawFoot(); apply(); } })));
    drawList(); drawOpts();
    body.append(h('p', { class: 'muted sm-launch-desc' }, LT('launcher.step_desc', 'INTERCEPTOR\'ın hangi fırlatıcıdan çıkacağı. Tailsitter kuyruk üstünden dikey çıkar; el fırlatıcısında nişan yönüne yönelir.')),
      h('div', { class: 'sm-two' }, h('div', null, list, opts), h('div', { class: 'sm-preview-col' }, previewBox)));
    ensurePreview().then(apply);
  };
  const stepLaunch = () => {
    if (W.drone()?.type === 'interceptor') return stepIceptLaunch();
    const L = W.state.launch;
    const list = h('div', { class: 'sm-cards sm-cards-launch' });
    const opts = h('div', { class: 'sm-launch-opts' });
    const slider = (key, label, unit) => {
      const [a, b] = LAUNCH_LIMITS[key];
      const inp = h('input', { type: 'range', min: a, max: b, step: key === 'hand_speed_ms' ? 0.5 : 1, value: W.state.launch[key] });
      const out = h('b', { class: 'mono' }, `${W.state.launch[key]}${unit}`);
      inp.addEventListener('input', () => { W.set('launch', { [key]: Number(inp.value) }); out.textContent = `${W.state.launch[key]}${unit}`; drawFoot(); });
      return h('label', { class: 'sm-slider' }, h('span', null, label), inp, out);
    };
    const drawOpts = () => {
      const m = W.state.launch.method;
      clear(opts, m === 'ramp' ? slider('angle_deg', 'Rampa açısı', '°') : m === 'vehicle' ? slider('release_kmh', 'Bırakma hızı', ' km/h') : m === 'hand' ? [slider('hand_speed_ms', 'Atış hızı', ' m/s'), slider('hand_pitch_deg', 'Burun yukarı', '°'), h('p', { class: 'small muted' }, tr('Pilot uçağı omuz hizasında (1,6 m) tutar; geri sayımla kol ileri, bırakmada hafif yalpa. SITL: başlangıç irtifası 1,8 m, düşük hızlı mancınık itişi.'))] : h('p', { class: 'small muted' }, tr('İniş takımı eklenir; ArduPlane TAKEOFF: pist koşusu, 12 m/s döndürme.')));
    };
    const drawList = () => clear(list, LAUNCH_METHODS_SM.map(([k, name, desc]) => card(k === W.state.launch.method, { icon: h('i', { class: `sm-ico sm-ico-launch sm-launch-${k}` }), title: name, sub: desc, badge: k === 'hand' ? 'YENİ' : null, cls: k === 'hand' ? 'hand' : '', onClick: () => { W.set('launch', { method: k }); drawList(); drawOpts(); drawFoot(); } })));
    drawList(); drawOpts();
    body.append(list, opts);
    void L;
  };
  const stepMission = () => {
    const ms = W.missionsFor();
    const list = h('div', { class: 'sm-cards sm-cards-missions' });
    const drawList = () => clear(list, [card(W.state.mission_id == null, { icon: h('i', { class: 'sm-ico', html: '<svg viewBox="0 0 48 48"><circle cx="24" cy="24" r="16"/><path d="M14 24h20M24 14v20"/></svg>' }), title: 'Serbest uçuş', sub: 'Görev yok; Mission Planner ile de rota yükleyebilirsiniz.', onClick: () => { W.set('mission_id', null); drawList(); drawFoot(); } }),
      ...ms.map(m => card(m.id === W.state.mission_id, { icon: m.preview_png ? h('img', { class: 'sm-card-img', src: m.preview_png, alt: '' }) : h('i', { class: 'sm-ico', html: '<svg viewBox="0 0 48 48"><path d="M6 38 18 14l10 14 8-8 6 18z"/></svg>' }), title: m.name, sub: `${m.kind}${m.kind === 'fpv_gates' ? ` · ${m.plan?.laps || 1} tur` : ''}${Array.isArray(m.plan?.route?.points) ? ` · ${m.plan.route.points.length} nokta` : Array.isArray(m.plan?.items) ? ` · ${m.plan.items.length} nokta` : ''}`, onClick: () => { W.set('mission_id', m.id); drawList(); drawFoot(); } }))]);
    drawList();
    body.append(list, ms.length ? null : h('p', { class: 'small muted' }, tr('Bu parkur için kayıtlı görev yok (Görevler modülünden ekleyin).')));
  };
  // ---------- HEDEFLER (HEPGO §24; isteğe bağlı): katalog bir kez (GET /api/fly/targets); geçersiz girişte İleri kapalı ----------
  let tgCat = null, tgErr = null, tgUi = null;
  const dropTargetsUi = () => { tgUi?.dispose?.(); tgUi = null; };   // §24.4 önizleme stüdyo bağlamı adımdan çıkınca kapanır
  const stepTargets = async () => {
    const holder = h('div', { class: 'sm-tg-holder' }, h('p', { class: 'muted' }, tr('targets.loading')));
    body.append(holder);
    try { tgCat = tgCat || await net.get('/api/fly/targets'); } catch (err) { clear(holder, h('p', { class: 'muted' }, tr('targets.load_err', { e: err.message }))); return; }
    if (W.step() !== 'targets') return;
    const ui = await createTargetsStep({ h, t: tr, catalog: tgCat.models || [], limits: tgCat, state: W.state.targets,
      onChange: (v, e) => { W.set('targets', v); tgErr = e; nextBtn.disabled = !W.canNext() || !!tgErr; startBtn.disabled = !W.ready() || !!openFlight || !!tgErr; drawFoot2(); } });
    if (W.step() !== 'targets' || destroyed) { ui.dispose?.(); return; }
    dropTargetsUi(); tgUi = ui;
    clear(holder, ui.el);
  };
  // ---------- YER KONTROL (HEPGO §26; isteğe bağlı): radar / istasyon / EO + "Yer kontrolünü koru" (yalnız INTERCEPTOR; defend görev kaydı seçiliyse
  // senaryo kayıttan) — çekirdek modül /sim/flightsim_gcs_ui.js (keyed: site.* i18n anahtarları, 7 dil) ----------
  let siteErr = null, siteVisited = false;
  const stepSite = async () => {
    const holder = h('div', { class: 'sm-site-holder' }, h('p', { class: 'muted' }, tr('common.loading')));
    body.append(holder);
    let M;
    try { M = await import('/sim/flightsim_gcs_ui.js'); } catch (err) { clear(holder, h('p', { class: 'muted' }, String(err?.message || err))); return; }
    if (W.step() !== 'site' || destroyed) return;
    const m = W.mission();
    const ui = M.createSiteSection({ tr, keyed: true, card: false, getType: () => W.drone()?.type, initial: siteVisited ? { site: W.state.site, defend: W.state.defend } : null,
      missionDefend: m?.kind === 'defend' ? m.name : null,
      onChange: (v, e) => { W.set('site', v.site); W.set('defend', v.defend); siteErr = e; drawFoot2(); } });
    siteVisited = true;
    const v0 = ui.values(); W.set('site', v0.site); W.set('defend', v0.defend); siteErr = ui.error();
    clear(holder, h('div', { class: 'sm-site-head' }, h('h2', null, '◈ ', tr('site.title'))), ui.el);
    drawFoot2();
  };
  const drawFoot2 = () => { const last = W.isLast(); const err = tgErr || (W.step() === 'site' ? siteErr : null); if (!last) nextBtn.disabled = !W.canNext() || !!err; drawFoot(); if (err) { nextBtn.disabled = true; startBtn.disabled = true; } };
  const stepPilot = () => {
    const list = h('div', { class: 'sm-cards sm-cards-pilots' });
    const drawList = () => clear(list, data.pilots.map(p => card(p.id === W.state.pilot_id, { icon: p.svg ? h('i', { class: 'sm-ico sm-ico-pilot', html: p.svg }) : h('i', { class: 'sm-ico sm-ico-pilot', html: '<svg viewBox="0 0 48 48"><circle cx="24" cy="16" r="9"/><path d="M8 42c2-10 8-14 16-14s14 4 16 14z"/></svg>' }), title: p.name, sub: `${p.flights || 0} uçuş · ${(Number(p.hours) || 0).toFixed(1)} sa`, badge: p.is_default ? 'Varsayılan' : null, onClick: () => { W.set('pilot_id', p.id); drawList(); drawFoot(); } })));
    drawList();
    const cb = (key, label, hint) => { const inp = h('input', { type: 'checkbox', checked: !!W.state.record[key], onchange: () => W.set('record', { [key]: inp.checked }) }); return h('label', { class: 'check sm-rec-opt' }, inp, h('span', null, h('b', null, label), h('small', { class: 'muted' }, hint))); };
    camPick.refresh();
    // HEPGO §27.3 gösterge tasarımı (önizlemeli kartlar; kalıcı tercih fs.gauge.theme — uçuşta kadran kutusu / G): çekirdek modül /sim/flightsim_gtheme.js
    const gtHolder = h('div', { class: 'sm-gt-holder fs-gt-wiz' });
    import('/sim/flightsim_gtheme.js').then(M => { if (destroyed || W.step() !== 'pilot' || !gtHolder.isConnected) return; gtHolder.append(M.createGaugeThemePicker({ tr, keyed: true, game: true, dark: () => true }).el); }).catch(() => {});
    body.append(list, camPick.el, gtHolder, h('div', { class: 'sm-rec-opts' }, h('h3', null, 'Kayıt seçenekleri'), cb('video', 'Video kaydı', '3B sahne + HUD/OSD + motor sesi (WebM); uçuş bitince Operasyon\'da'), cb('bin', 'Uçuş logu (.bin)', 'DataFlash log → kayıttan oynatma ve analiz')));
  };
  const draw = () => {
    clear(body);
    const k = W.step();
    const keep = k === 'drone' || (k === 'launch' && W.drone()?.type === 'interceptor');   // §27 fırlatıcı adımında düzenek önizlemesi
    if (!keep && preview) { preview.dispose(); preview = null; previewBox = null; }   // 3B döngüsü yalnız dron / fırlatıcı adımında (diğer adımlarda CPU/GPU boşa dönmesin)
    if (k === 'drone' && preview) preview.setLaunch?.(null);
    dropTargetsUi();   // hedef adımına dönülürse yeniden kurulur
    body.dataset.step = k;
    ({ drone: stepDrone, track: stepTrack, launch: stepLaunch, power: stepPower, mission: stepMission, site: stepSite, targets: stepTargets, pilot: stepPilot })[k]?.();
    drawSteps(); drawFoot();
    root.classList.remove('sm-anim'); void root.offsetWidth; root.classList.add('sm-anim');
  };

  // ---------- BAŞLA: tam ekran → POST /api/fly/start → sahne. 3-2-1 geri sayımı artık sahnede (HEPGO §27.2 giriş sekansı: 100 m bakış + bip;
  // eski sihirbaz geri sayımı COUNTDOWN_S onunla birleştirildi) — burada yalnız "Hazır ol…" perdesi ----------
  let starting = false;
  const start = async () => {
    if (starting || !W.ready()) return;
    starting = true; startBtn.disabled = true;
    document.documentElement.requestFullscreen?.().catch(() => {});   // kullanıcı tıklaması içinde (reddedilirse sessiz)
    const payload = { ...W.payload(), camera: camPick.value };   // §22.3 kamera türü
    countdown.hidden = false; countdown.firstChild.textContent = ''; countdown.lastChild.textContent = tr('Hazır ol…');
    let s;
    try { s = await startFlight(payload); } catch (err) {
      const m = { 429: 'Sunucu dolu; bekleme odası — biraz sonra yeniden deneyin', 409: 'Zaten süren bir uçuşunuz var: uçuşa dönün ya da bitirin', 400: 'Geçersiz ayar; dron/parkur/kalkış değerlerini kontrol edin', 503: 'SITL hazır değil' }[err?.status]
        || (err?.status === 422 ? `${tr('power.start_invalid')}: ${err.message}` : null);
      toast(m || err.message, 'err'); countdown.hidden = true; starting = false; startBtn.disabled = false;
      if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
      if (err?.status === 409) await showOpenFromError(err);
      return;
    }
    s.camera = payload.camera;
    toast(tr('Uçuş başladı · MP tcp:{h}:{p}', { h: s.mp?.host || location.hostname, p: s.mp?.port ?? '—' }));
    preview?.dispose(); preview = null; destroyed = true; dropTargetsUi();
    runLeave();
    ctx.track?.('flight_start', { drone_type: W.drone()?.type || 'unknown', launch: payload.launch?.method || payload.launch || 'wheels', world_mode: W.track()?.world_mode || 'unknown', mission: W.mission() ? 1 : 0 });
    await openSession(view, s, { drone: W.drone(), track: W.track(), pilot: W.pilot(), mission: W.mission(), launch: W.drone()?.type === 'interceptor' ? W.state.ilaunch : W.state.launch, record: W.state.record, power: s.power || W.state.power, speedup: s.speedup || W.state.speedup, targets: W.state.targets, site: s.site || null }, { ...ctx, meta: data.meta });
  };
  onLeave(() => { destroyed = true; preview?.dispose(); preview = null; dropTargetsUi(); });
  drawOpen();
  draw();
  return { wizard: W, draw, start, get openFlight() { return openFlight; } };
}

/** Kullanıcının açık uçuşu (GET /api/fly/current) ya da null; ağ hatası null sayılır. */
export async function fetchCurrent() { try { const c = await net.get('/api/fly/current'); return c && c.flight_id != null ? c : null; } catch { return null; } }
