// SIMUMAV › Uç — oturum sahnesi (docs/simumav.md §5 Uç): HEPGO simülatör modülleri /sim mount'undan DEĞİŞTİRİLMEDEN kullanılır:
//   flightsim3d.js (3B dünya: 'real' | 'google3d' | 'procedural' — HEPGO flightsim.js renderSession ile aynı kurulum; dron; düzenek), flightsim_panel.js
//   (dron paneli; hub WS), flightsim_hud.js (askeri HUD — gimbal kamerası 'fpv'), flightsim_fpv_osd.js (FPV OSD — 'pilot' kamerası; analog efekt),
//   flightsim_audio.js (motor sesi), flightsim_record.js (ekran kaydı), flightsim_report.js (özet rapor gövdesi), flightsim_launch.js /
//   flightsim_mission.js / flightsim_g3d.js (3B içinden; Google anahtarı /api/meta maps_key).
// Akış: startFlight(payload) → POST /api/fly/start → {flight_id, sim_id, mp:{host,port,proto:'tcp'}, ws} → openSession(view, start, picked, ctx).
// Uyum adaptörleri (HEPGO dosyalarına dokunulmaz):
//   • WS köprüsü: flightsim_panel.js hub soketini `/ws/drone/live`e açar → sayfa düzeyinde WebSocket sarmalayıcısı YALNIZ bu yolu `start.ws`
//     (/ws/fly/{sim_id}) adresine çevirir (installWsBridge); oturum kapanınca kaldırılır. Aynı soket sim mesajlarını (tele/hello/state/launch/
//     crash/route/event/end) ve hub mesajlarını (hello{bridges,me}/status/console/res) taşır; panel bilmediği tipleri yok sayar.
//   • Komutlar: {t:'cmd', rid, bridge_id, sysid:1, name, params} → {t:'res', rid, ok, error} (hub protokolü; panel ile aynı).
//   • MP kutusu: panel "UDP host:port" yazar → DOM sonrası `tcp:<host>:<port>` + kopyala + "ilk bağlanan IP kilitlenir" notu (patchMpBox).
//   • Kayıt REST: createRecorder(opts.rest) → /api/fly/{flight_id}/rec/start, /api/fly/rec/{rid}/chunk|thumb|finish|file, DELETE /api/fly/rec/{rid}.
//   • Kaplama (./overlay3d.js): pilot figürü (./hand_launch.js) ve FPV halkaları (./gates.js) ayrı saydam tuvalde; kamera sim.cameraPose() ile eşlenir.
//   • Elden atış: telemetri kaydırması (uçak omuzda) + geri sayım + takeoff komutu `launch:'hand'`; SITL'e start gövdesinde `launch.method:'hand'` gider.
//   • Interceptor: hız göstergesi 600 km/h (SVG kadran), ses modeli AUDIO_MODELS.interceptor (yüksek devir); HUD'da mach yok (HEPGO HUD'da zaten yok).
//   • FPV dron: başlangıç kamerası 'pilot' (gerçek FPV + OSD); ayarlar.analog_fpv → sim.setFpvAnalog + osd.setAnalog.
//   • Kamera türü + PiP (HEPGO §22.3–22.5, /sim/flightsim_camera.js): sihirbazın seçimi (picked.camera) → camType; 📷 menüsü (T / Shift+T / V), sürüklenebilir
//     kamera PiP'i (çift tık → gimbal); tür değişimi sessiz WS `camera` komutu. Seçim arayüzü ./camera_pick.js.
//   • Halkalar: tracks.gates → neon halka/kapı; geçiş algılama; OSD ok + mesafe + tur/süre; stop gövdesine gates:{passed, missed, best_lap_s, laps}.
//   • GÜÇ VE YAKIT (§10): HEPGO analog kadranları (/sim/flightsim_power.js createPowerGauges — aynı modül) TÜM kamera kiplerinde alt ortada (power.css
//     .fs-gauges.sm-game: oyun teması, FPV/gimbal'da yarı saydam ve küçük); tele.fuel/elec/speedup; WS warn kind fuel_empty|elec_empty → büyük
//     uyarı bandı + toast + alarm sesi (yalnız uyarı, uçuş sürer); düşük (%20 yakıt / %25 batarya) bir kez sarı uyarı; simülasyon hızı kapsülü (≤ meta.power).
// HEPGO renderSession paritesi (./rc.js; docs/ucus-simulatoru.md §5): titreme → telemetri 3B'nin uyarlanır tamponlu zaman çizgisine (flightsim3d.js
//   içindeki flightsim_interp.js) HEPGO ile aynı sırada verilir (sim.setTelemetry önce, sonra HUD/OSD/ses/panel); `net:` etiketi (Hz · jitter · tampon · DR)
//   ve `#/fly/<id>?netsim=jitter30,loss5,delay40` teşhis kipi (window.__fsSim = 3B). Sanal kumanda 🎮: iki sanal çubuk + klavye → 20 Hz {t:'rc', ch[8]}
//   (/ws/fly → RC_CHANNELS_OVERRIDE); kapatınca 8×0; FPV'de görünür, panel gizli; MP joystick uyarısı; 3B WASD kilidi. Alt çubukta panel kapalıyken
//   ARM/DISARM · mod · Kalkış (hub akışı: GUIDED → ARM → NAV_TAKEOFF; pilot ayrıca ARM etmez) · RTL (.fs-cmds; panel açıkken gizli). Esc → Geri.
//   P/O/H/C tuşları HEPGO modüllerinin kendi dinleyicilerindedir (panel/OSD/HUD/3B) — burada yeniden bağlanmaz (çift tetikleme olurdu).
import { clear, confirmDialog, fmtDateTime, fmtDuration, h, modal, toast, toastError, t as tr, onLeave } from './simui.js';
import { net, wsUrl } from './net.js';
import { INTERCEPTOR_AUDIO, TYPE_LABEL, WORLD_MODE_LABEL, audioTypeFor, launchBody, launchLabelSm, modelFor, needsLaunch, simType, speedAngle, speedScale, speedTicks, startCameraFor, worldFromTrack } from './wizard.js';
import { HAND, HAND_PHASES, createHandOverlay, handCfg, handHud, handReleaseTime, shimTelemetry } from './hand_launch.js';
import { createOverlay3D } from './overlay3d.js';
import { createGateLayer } from './gates.js';
import { netsimDeliver, netsimFromLocation, parseNetsim, virtualRC } from './rc.js';
import { releaseShared } from '../core/three.js';
import * as sfx from '../ui/sfx.js';
import { localizeUnits, powerReportCard, trPower, warnInfo } from './power.js';
import { camTr } from './camera_pick.js';   // kamera türü/PiP metinleri → camera.* i18n anahtarları

const SIM = '/sim/';
const THREE_URL = '/static/vendor/three/three.module.min.js';   // HEPGO modülleriyle aynı yol → aynı modül örneği
const COPTER_MODES = ['STABILIZE', 'ALT_HOLD', 'LOITER', 'GUIDED', 'AUTO', 'RTL', 'LAND', 'POSHOLD', 'BRAKE'];
const PLANE_MODES = ['MANUAL', 'FBWA', 'FBWB', 'CRUISE', 'LOITER', 'GUIDED', 'AUTO', 'RTL', 'TAKEOFF', 'CIRCLE'];
const VTOL_MODES = ['QSTABILIZE', 'QHOVER', 'QLOITER', 'QLAND', 'QRTL', 'FBWA', 'CRUISE', 'GUIDED', 'AUTO', 'RTL', 'TAKEOFF'];
const modesFor = st => (st === 'vtol' ? VTOL_MODES : st === 'sabit_kanat' ? PLANE_MODES : COPTER_MODES);
const STATE_TEXT = { BASLIYOR: 'Başlıyor', HAZIR: 'Hazır', HATA: 'Hata', KAPANDI: 'Kapandı' };
const STATE_BADGE = { BASLIYOR: 'yellow', HAZIR: 'green', HATA: 'red', KAPANDI: 'gray' };
const LAUNCH_PHASE_TEXT = {
  armed: { ramp: 'Uçak rampada, motor hazır', vehicle: 'Uçak araçta, motor hazır', wheels: 'Pist koşusu başlıyor', hand: 'Pilot uçağı omuzda tutuyor, motor hazır' },
  launch: { ramp: 'FIRLATMA', vehicle: 'Araç hızlanıyor', wheels: 'Pist koşusu', hand: 'ELDEN ATIŞ' },
  released: { ramp: 'Uçak rampadan ayrıldı', vehicle: 'BIRAKILDI', wheels: 'Uçak havalandı', hand: 'Uçak elden çıktı' },
};
const CRASH_KIND = { terrain: 'Arazi ile temas', water: 'Suya düşüş', building: 'Binaya çarpma', sitl_hit: 'SITL yer teması', sitl: 'Otopilot çarpışma algısı' };
const END_REASON = { kapatildi: 'Uçuş bitirildi', bosta: 'İzleyici kalmadığından kapatıldı', sure: 'Uçuş süresi doldu (45 dk)', sunucu_kapaniyor: 'Sunucu kapanıyor', yetim: 'Sahne bağlanmadığından uçuş sunucuda kapatıldı', webgl: '3B görünüm açılamadığından uçuş kapatıldı' };
const safe = fn => { try { const r = fn?.(); if (r && typeof r.catch === 'function') r.catch(() => {}); } catch (e) { console.warn('dispose adımı', e); } };   // dispose zinciri: bir adım fırlatsa da kalanlar çalışır
const num = (v, d = null) => (v == null || Number.isNaN(Number(v)) ? d : Number(v));
const f0 = v => (v == null ? '—' : String(Math.round(Number(v))));
const f1 = v => (v == null ? '—' : Number(v).toFixed(1));
const copyText = async (txt, what = 'Kopyalandı') => { try { await navigator.clipboard.writeText(txt); toast(what); } catch { toast('Kopyalanamadı; metni elle seçin', 'err'); } };
let libsP = null;
const loadSim = () => (libsP ??= Promise.all(['flightsim3d.js', 'flightsim_panel.js', 'flightsim_hud.js', 'flightsim_fpv_osd.js', 'flightsim_audio.js', 'flightsim_record.js', 'flightsim_report.js', 'flightsim_power.js', 'flightsim_camera.js'].map(f => import(SIM + f)))
  .then(([M3D, MPanel, MHud, MOsd, MAudio, MRec, MReport, MPower, MCam]) => ({ M3D, MPanel, MHud, MOsd, MAudio, MRec, MReport, MPower, MCam })).catch(e => { libsP = null; throw e; }));

// HEPGO çekirdeğinin anladığı kalkış nesnesi: sabit kanat ailesi dışı → null; hand → {method:'hand', …} (3B: düzenek/iniş takımı yok)
export const hepgoLaunchFor = (droneType, launch) => (needsLaunch(droneType) ? launchBody(launch) : null);

// ---------- WS köprüsü: /ws/drone/live → start.ws (yalnız o yol) ----------
export function installWsBridge(targetUrl, { win = globalThis } = {}) {
  const Native = win.WebSocket;
  if (!Native || Native.__smBridged) return () => {};
  const rewrite = u => { try { const url = new URL(String(u), win.location?.href || 'http://localhost/'); return url.pathname === '/ws/drone/live' ? targetUrl : String(u); } catch { return String(u); } };
  const Bridged = function WebSocket(url, protocols) { return protocols === undefined ? new Native(rewrite(url)) : new Native(rewrite(url), protocols); };
  Bridged.prototype = Native.prototype;
  for (const k of ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED']) Bridged[k] = Native[k];
  Bridged.__smBridged = true; Bridged.__native = Native; Bridged.rewrite = rewrite;
  win.WebSocket = Bridged;
  return () => { if (win.WebSocket === Bridged) win.WebSocket = Native; };
}

// ---------- komut/telemetri soketi ----------
function wsClient(url, handlers) {
  let ws = null, closed = false, retry = 0, pingIv = 0, timer = 0;
  const open = () => {
    if (closed) return;
    handlers.status?.(retry ? 'reconnect' : 'connecting');
    try { ws = new WebSocket(url); } catch (err) { handlers.fatal?.(err.message); return; }
    ws.onopen = () => { retry = 0; handlers.status?.('open'); pingIv = setInterval(() => send({ t: 'ping' }), 10000); handlers.open?.(); };
    ws.onmessage = e => { let m; try { m = JSON.parse(e.data); } catch { return; } handlers.message?.(m); };
    ws.onerror = () => { /* onclose yeniden bağlanır */ };
    ws.onclose = ev => {
      clearInterval(pingIv);
      if (closed) return;
      if (ev.code === 4403) return handlers.fatal?.('auth');
      if (ev.code === 4404) return handlers.fatal?.('notfound');
      handlers.status?.('closed');
      timer = setTimeout(open, Math.min(10000, 500 * 2 ** Math.min(retry++, 5)));
    };
  };
  const send = obj => { if (ws && ws.readyState === 1) { ws.send(JSON.stringify(obj)); return true; } return false; };
  open();
  return { send, close: () => { closed = true; clearTimeout(timer); clearInterval(pingIv); try { ws?.close(); } catch { /* */ } } };
}

// ---------- hız göstergesi (SVG kadran; interceptor 600 km/h) ----------
export function createSpeedGauge(maxKmh, label) {
  const ticks = speedTicks(maxKmh);
  const R = 46, cx = 60, cy = 62;
  const pt = (deg, r) => { const a = (deg - 90) * Math.PI / 180; return [cx + r * Math.cos(a), cy + r * Math.sin(a)]; };
  const arc = (a0, a1, r) => { const [x0, y0] = pt(a0, r), [x1, y1] = pt(a1, r); return `M${x0.toFixed(1)} ${y0.toFixed(1)} A${r} ${r} 0 ${a1 - a0 > 180 ? 1 : 0} 1 ${x1.toFixed(1)} ${y1.toFixed(1)}`; };
  const tickEls = ticks.map(v => { const a = speedAngle(v, maxKmh); const [x0, y0] = pt(a, R - 2), [x1, y1] = pt(a, R - 8), [tx, ty] = pt(a, R - 17); return `<line x1="${x0.toFixed(1)}" y1="${y0.toFixed(1)}" x2="${x1.toFixed(1)}" y2="${y1.toFixed(1)}"/><text x="${tx.toFixed(1)}" y="${(ty + 2.5).toFixed(1)}">${v}</text>`; }).join('');
  const el = h('div', { class: `fs-speed-gauge ${maxKmh >= 400 ? 'interceptor' : ''}`, 'data-max': String(maxKmh), title: tr('Hava hızı (km/h); ölçek {m} km/h', { m: maxKmh }) });
  el.innerHTML = `<svg viewBox="0 0 120 112" aria-hidden="true"><path class="g-arc" d="${arc(-120, 120, R)}"/><path class="g-red" d="${arc(speedAngle(maxKmh * 0.85, maxKmh), 120, R)}"/><g class="g-ticks">${tickEls}</g>
    <g class="g-needle" transform="rotate(-120 ${cx} ${cy})"><path d="M${cx} ${cy + 6} L${cx - 2.6} ${cy} L${cx} ${cy - 40} L${cx + 2.6} ${cy} Z"/></g><circle cx="${cx}" cy="${cy}" r="4.5" class="g-hub"/>
    <text class="g-val" x="${cx}" y="${cy + 26}">0</text><text class="g-unit" x="${cx}" y="${cy + 37}">km/h</text><text class="g-label" x="${cx}" y="12">${label || ''}</text></svg>`;
  const needle = el.querySelector('.g-needle'), val = el.querySelector('.g-val');
  let shown = 0, lastKmh = 0;
  const update = kmh => { lastKmh = Math.max(0, num(kmh, 0)); };
  const frame = dt => { shown += (lastKmh - shown) * Math.min(1, dt / 0.25); needle.setAttribute('transform', `rotate(${speedAngle(shown, maxKmh).toFixed(2)} ${cx} ${cy})`); val.textContent = String(Math.round(shown)); el.classList.toggle('over', shown > maxKmh * 0.85); };
  return { el, update, frame, get max() { return maxKmh; }, get value() { return lastKmh; } };
}

// ---------- kayıt REST adaptörü (§4 ek uçlar; çekirdek ajanı uygular) ----------
export const recRest = fid => ({
  start: (sid, mime) => net.post(`/api/fly/${encodeURIComponent(fid)}/rec/start`, { mime }),
  chunk: (rid, seq, blob) => net.raw('PUT', `/api/fly/rec/${encodeURIComponent(rid)}/chunk?seq=${seq}`, blob, 'application/octet-stream'),
  thumb: (rid, blob) => net.raw('PUT', `/api/fly/rec/${encodeURIComponent(rid)}/thumb`, blob, 'image/png'),
  finish: (rid, body) => net.post(`/api/fly/rec/${encodeURIComponent(rid)}/finish`, body),
  share: () => Promise.resolve({}),   // SIMUMAV'da paylaşım yok: video flights.video_path'e saklanır
  del: rid => net.del(`/api/fly/rec/${encodeURIComponent(rid)}`),
  pending: () => Promise.resolve([]), mine: () => Promise.resolve([]),
  fileUrl: rid => `/api/fly/rec/${encodeURIComponent(rid)}/file`,
});

export async function startFlight(payload) { return net.post('/api/fly/start', payload); }
export async function fetchMeta() { try { return await net.get('/api/meta'); } catch { return { maps_key: null }; } }
export async function fetchSettings() { try { return await net.get('/api/settings'); } catch { return {}; } }

// MISSION PLANNER kutusu: panel HEPGO (UDP) metni yazar → TCP + IP kilidi notu (DOM sonrası; panel kendi metnini yeniden yazmaz)
export function patchMpBox(stage, mp) {
  const addr = `tcp:${mp.host}:${mp.port}`;
  for (const kod of stage.querySelectorAll('.fs-pn-mp-kod')) kod.textContent = addr;
  for (const not of stage.querySelectorAll('.fs-pn-mp-not')) clear(not, 'Mission Planner › sağ üst bağlantı türü ', h('b', null, 'TCP'), ' › CONNECT › sunucu ', h('b', null, mp.host), ' port ', h('b', null, String(mp.port)), '. ',
    h('span', { class: 'fs-mp-lock' }, '⚠ İlk bağlanan IP kilitlenir; başka IP\'ler reddedilir. Uçuş bitince port kapanır.'));
  for (const yz of stage.querySelectorAll('.fs-pn-yuzen, .fs-pn-mp-rozet')) yz.title = tr('Mission Planner (TCP) bağlantısı');
  return addr;
}

// Özet rapor: HEPGO reportBody + SIMUMAV halka istatistiği bloğu → modal (Promise, kapanınca)
export function showFlightReport(MReport, sum, gates, { pilot, drone, track, flightId = null, ctx = null } = {}) {
  return new Promise(resolve => {
    const body = h('div', { class: 'sm-report' });
    body.append(h('div', { class: 'sm-report-head' }, h('b', null, drone?.name || ''), track?.name ? h('span', { class: 'muted' }, ` · ${track.name}`) : null, pilot?.name ? h('span', { class: 'muted' }, ` · ${tr('Pilot')}: ${pilot.name}`) : null));
    const pwCard = sum?.power ? powerReportCard({ h, t: tr, pw: sum.power }) : null;   // §10 oyun tarzı güç kartı (HEPGO .fs-rp-power bölümü CSS'te gizli; çift olmasın)
    if (pwCard) body.append(pwCard);
    try { body.append(MReport.reportBody(sum || {}, tr, { canWrite: false, be: null })); } catch { body.append(h('p', { class: 'muted' }, tr('Özet alınamadı.'))); }
    if (gates) {
      const clock = s => (s == null ? '—' : `${String(Math.floor(s / 60)).padStart(2, '0')}:${(s % 60).toFixed(1).padStart(4, '0')}`);
      const tile = (v, l, cls = '') => h('div', { class: `sm-gate-tile ${cls}` }, h('b', null, String(v)), h('small', null, l));
      body.append(h('div', { class: 'sm-gates-sum' }, h('h3', null, 'FPV halkaları'),
        h('div', { class: 'sm-gate-tiles' }, tile(gates.passed, 'geçilen', 'ok'), tile(gates.missed, 'kaçırılan', gates.missed ? 'bad' : ''), tile(gates.laps, 'tur'), tile(clock(gates.best_lap_s), 'en iyi tur'))));
    }
    // "Bu uçuşla ilgili sorun bildir" (§9): destek modalı uçuş kimliğiyle açılır; rapor modalı açık kalır (true)
    const report = { label: tr('support.report_flight'), onClick: async () => { const m = await import('../support/index.js'); m.openReportModal(ctx || { go: hs => { location.hash = String(hs).startsWith('#') ? hs : `#/${hs}`; } }, { flightId, source: 'flight' }); return true; } };
    modal({ title: tr('Uçuş özeti'), body, wide: true, actions: [{ label: tr('PDF / Yazdır'), onClick: () => { MReport.printReport?.(); return true; } }, report, 'spacer', { label: tr('Operasyon\'a git'), class: 'primary' }], onClose: () => resolve(sum) });
  });
}

// ======================================================================
// openSession(view, start, picked, ctx) → { dispose, … }
//   start: POST /api/fly/start yanıtı {flight_id, sim_id, mp:{host,port}, ws, session?}; picked: {drone, track, mission, pilot, launch, record}
// ======================================================================
export async function openSession(view, start, picked, ctx = {}) {
  const go = ctx.go || (hash => { location.hash = hash; });
  const gaTrack = typeof ctx.track === 'function' ? ctx.track : () => {};   // GA4 olayları (kabuk app.js; kişisel veri yok)
  const tOpen = Date.now();
  releaseShared();   // Uç sahnesi (createFlightSim3D kendi WebGLRenderer'ını açar) öncesi kabuğun paylaşılan WebGL bağlamı bırakılır
  const { M3D, MPanel, MHud, MOsd, MAudio, MRec, MReport, MPower, MCam } = await loadSim();
  const [meta, settings] = await Promise.all([ctx.meta ? Promise.resolve(ctx.meta) : fetchMeta(), ctx.settings ? Promise.resolve(ctx.settings) : fetchSettings()]);
  const drone = picked.drone || start.drone || { name: 'Dron', type: 'multirotor' }, track = picked.track || start.track || {}, pilot = picked.pilot || start.pilot || null, mission = picked.mission || start.mission || null;
  const dType = drone.type || 'multirotor', type = simType(dType), modes = modesFor(type);
  const launch = hepgoLaunchFor(dType, picked.launch || start.launch);
  const isHand = launch?.method === 'hand';
  const hcfg = isHand ? handCfg(launch) : null;
  const mp = { host: start.mp?.host || location.hostname, port: start.mp?.port ?? '—', proto: 'tcp' };
  const sid = start.sim_id, fid = start.flight_id;
  const wsAddr = wsUrl(start.ws || `/ws/fly/${encodeURIComponent(sid)}`);
  const world = worldFromTrack(track, meta?.maps_key);
  if (launch) world.launch = launch;
  const g3dMode = world.mode === 'google3d', realMode = world.mode === 'real';
  const session = { id: sid, mode: 'sitl', state: start.session?.state || 'BASLIYOR', type, model: modelFor(drone), created_at: start.session?.created_at || new Date().toISOString(),
    center: { name: track.name || 'Parkur', lat: num(track.lat, 0), lon: num(track.lon, 0), alt: num(track.alt, null) },
    drone: { code: '', name: drone.name || 'Dron' }, hub: { bridge_id: start.session?.hub?.bridge_id ?? -(9000 + (Number(sid) || 0)), name: drone.name || 'Dron' },
    gcs: { connected: false, addr: '' }, sitl: { port: mp.port }, route: [], launch: launch ? { ...launch, phase: null } : null, world,
    power: (() => { const p = picked.power || start.power || start.session?.power; if (!p) return null; const { engine, ...rest } = p; void engine; return rest; })() };   // §10: kadranların azami hız ölçeği (hello'da çekirdek değeri gelir)
  const maxKmh = speedScale(dType);
  const gates = Array.isArray(track.gates) ? track.gates : [];
  const gatePlan = mission?.kind === 'fpv_gates' ? (mission.plan || {}) : {};
  const fpvPrefs = MOsd.createFpvPrefs();
  if (settings?.analog_fpv != null) fpvPrefs.setAnalog(!!settings.analog_fpv);
  const cam0 = startCameraFor(dType);
  // HEPGO §22.3–22.5 kamera türü + kamera PiP'i (flightsim_camera.js): tür sihirbazın seçimi (picked.camera; uçuşa dönüşte start.camera), yoksa son tercih
  const camPrefs = MCam.createCamPrefs();
  const camType0 = [picked.camera, start.camera, start.session?.camera].find(MCam.isCamType) || camPrefs.type;   // uçuşa dönüş: oturumun türü (session.camera)
  let camPip = null;

  // ---------- iskelet ----------
  const stage = h('div', { class: `fs-stage sm-fly sm-fly-stage ${isHand ? 'fs-hand' : ''}`, 'data-immersive': '1', 'data-drone-type': dType, 'data-world': world.mode });
  const mount = h('div', { class: 'fs-canvas' });
  const msg = h('div', { class: 'fs-msg' }, '3B dünya hazırlanıyor…');
  const crash = h('div', { class: 'fs-crash', hidden: true }, h('b', null, 'ÇARPIŞMA'), h('span', { class: 'fs-crash-sub' }));
  const events = h('div', { class: 'fs-events' });
  const stateBadge = h('span', { class: `badge ${STATE_BADGE[session.state] || 'gray'}` }, STATE_TEXT[session.state] || session.state);
  const wsBadge = h('span', { class: 'badge gray', title: 'Telemetri bağlantısı (WebSocket)' }, 'Bağlanıyor…');
  const fullBtn = h('button', { class: 'fs-nav-btn fs-full-btn', type: 'button', title: 'Tam ekran', onclick: () => { (document.fullscreenElement ? document.exitFullscreen?.() : document.documentElement.requestFullscreen?.())?.then(() => onFullChange()).catch(() => {}); } }, '⛶');
  const backBtn = h('a', { class: 'fs-back', href: '#/fly', title: tr('Geri (Esc)'), 'aria-label': tr('Geri'), onclick: e => { e.preventDefault(); leaveToMenu(); } }, h('span', { class: 'fs-back-ico', 'aria-hidden': 'true' }, '←'), h('span', { class: 'fs-back-txt' }, 'Geri'));
  // §10 simülasyon hızı kapsülü (HEPGO createSpeedPill): yalnız sunucunun izin verdiği çarpanlar; seçili düğme tele.speedup ile eşitlenir
  const trP = trPower(tr);
  const speedAllowed = meta?.power?.speedups || [1, 2, 4];
  const speedPill = MPower.createSpeedPill({ h, tr: trP, cls: 'sm-speed-pill', onPick: f => { if (f !== speedPill.value) cmd('speed', { factor: f }); } });
  for (const b of speedPill.el.querySelectorAll('[data-speed]')) b.hidden = !speedAllowed.includes(Number(b.dataset.speed));
  speedPill.el.hidden = speedAllowed.length < 2;
  speedPill.set(picked.speedup || start.speedup || 1);
  const nav = h('div', { class: 'fs-nav' }, backBtn, h('b', null, 'SIMUMAV'), h('span', { class: 'fs-nav-sub' }, `${TYPE_LABEL[dType] || dType} · ${drone.name || ''} · ${track.name || '—'}${pilot ? ` · ${pilot.name}` : ''} · ${WORLD_MODE_LABEL[world.mode] || world.mode}`), stateBadge, wsBadge,
    launch ? h('span', { class: 'badge blue fs-launch-badge', title: tr('Kalkış yöntemi') }, launchLabelSm(launch)) : null, gates.length ? h('span', { class: 'badge purple', title: tr('FPV halkaları') }, `${gates.length} halka`) : null, speedPill.el, fullBtn);   // §10 hız kapsülü üst çubukta (HEPGO nav kalıbı)
  const onFullChange = () => { const full = !!document.fullscreenElement; stage.classList.toggle('fs-full', full); document.body.classList.toggle('fs-full', full); fullBtn.title = tr(full ? 'Tam ekrandan çık' : 'Tam ekran'); };
  document.addEventListener('fullscreenchange', onFullChange); onFullChange();

  let sim = null, milHud = null, osd = null, ops = null, hand = null, overlay = null, gateLayer = null, last = null, destroyed = false, socket = null, rec = null, sceneError = null;
  const camBtns = M3D.CAMERA_MODES.map(([k, label], i) => h('button', { class: 'btn sm', type: 'button', 'data-cam': k, title: tr('{label} (tuş {n})', { label, n: i + 1 }), onclick: () => sim?.setCamera(k) }, `${i + 1} `, label));
  const gimbalLbl = h('span', { class: 'small fs-gimbal', hidden: true }, '');
  const mhudBtn = h('button', { class: 'btn sm fs-mhud-btn', type: 'button', hidden: true, title: tr('Askeri HUD aç/kapa (H) · Shift+H renk'), onclick: () => { milHud?.toggle(); mhudBtn.classList.toggle('primary', !!milHud?.enabled); } }, 'HUD');
  // FPV ('pilot') ayarları: OSD · analog efekt · burun — HEPGO alt çubuğundaki kapsülün sade karşılığı (PiP artık genel kamera PiP'i: 📷 menüsü / V)
  const fpvRow = (label, get, set) => { const inp = h('input', { type: 'checkbox', onchange: () => set(inp.checked) }); const row = h('label', { class: 'fs-audio-row fs-fpv-row' }, inp, h('span', null, label)); row.__sync = () => { inp.checked = !!get(); }; return row; };
  const fpvRows = [
    fpvRow('OSD', () => osd?.enabled, v => { osd?.setEnabled(v); drawFpv(); }),
    fpvRow('Analog efekt', () => fpvPrefs.analog, v => { fpvPrefs.setAnalog(v); osd?.setAnalog(v); sim?.setFpvAnalog?.(v); drawFpv(); }),
    fpvRow('Pervane/burun görünür', () => fpvPrefs.nose, v => { fpvPrefs.setNose(v); sim?.setFpvNose?.(v); drawFpv(); }),
  ];
  const fovTxt = h('span', { class: 'fs-fpv-fov' }, '');
  const fpvMenu = h('div', { class: 'fs-audio-menu fs-fpv-menu', hidden: true }, ...fpvRows, h('div', { class: 'small muted' }, tr('O: OSD · tekerlek: FOV')));
  const fpvBtn = h('button', { class: 'btn sm fs-fpv-btn', type: 'button', title: tr('FPV ayarları: OSD, analog efekt, burun'), onclick: () => { fpvMenu.hidden = !fpvMenu.hidden; } }, 'FPV ', fovTxt, ' ▾');
  const fpvCtl = h('span', { class: 'fs-audio pill-group fs-fpv-ctl', hidden: true }, fpvBtn, fpvMenu);
  const trc = camTr(tr);
  const camCtl = MCam.createCameraCtl({ getSim: () => sim, tr: trc, prefs: camPrefs, getPip: () => camPip,
    onType: t => {   // sunucuya sessiz `camera` komutu (çekirdek oturum → kayıt satırı); yanıtı beklenmez
      addEvent(trc('Kamera türü: {t}', { t: MCam.camTypeLabel(t, trc) }));
      if (drone.id != null) camPrefs.rememberDrone(drone.id, t);
      socket?.send({ t: 'cmd', rid: `cam-${Date.now().toString(36)}`, bridge_id: session.hub.bridge_id, sysid: 1, name: 'camera', params: { type: t } });
    } });
  const drawFpv = () => { camCtl?.sync(); camPip?.layout(); fpvRows.forEach(r => r.__sync()); const fov = sim?.getPilotFov?.() ?? fpvPrefs.fov; fovTxt.textContent = `${fov}°`; fpvBtn.classList.toggle('primary', !!osd?.enabled); };
  const opsBtn = h('button', { class: 'btn sm fs-ops-btn', type: 'button', title: tr('Dron panelini göster/gizle (P)'), onclick: () => ops?.toggle() }, 'Panel');
  const gauge = createSpeedGauge(maxKmh, dType === 'interceptor' ? 'INTERCEPTOR' : (TYPE_LABEL[dType] || '').toUpperCase());
  const endBtn = h('button', { class: 'btn sm danger fs-end-btn', type: 'button', onclick: () => endFlight() }, '■ ', 'Uçuşu Bitir');
  // HEPGO alt çubuk komutları (.fs-cmds; panel açıkken CSS gizler): ARM/DISARM · mod · Kalkış · RTL
  const armBtn = h('button', { class: 'btn sm', type: 'button', onclick: () => cmd(last?.armed ? 'disarm' : 'arm') }, 'ARM');
  const rcBtn = h('button', { class: 'btn sm fs-rc-btn', type: 'button', title: tr('Sanal kumanda: iki sanal çubuk + klavye (W/S gaz, A/D yaw, ok tuşları pitch/roll, Q/E mod kanalı, Boşluk gaz orta). RC_CHANNELS_OVERRIDE 20 Hz.'), onclick: () => rcToggle() }, '🎮 ', 'Sanal kumanda');
  const modeSel = h('select', { class: 'input sm fs-modesel', onchange: () => { if (modeSel.value) cmd('mode', { mode: modeSel.value }); } },
    h('option', { value: '' }, 'Mod…'), modes.map(mm => h('option', { value: mm }, mm)));
  const LAUNCH_BTN = { ramp: 'Fırlat', vehicle: 'Aracı sür', wheels: 'Kalkış', hand: 'Elden at' };
  const bar = h('div', { class: 'fs-bar' }, h('div', { class: 'pill-group' }, camBtns), gimbalLbl, mhudBtn, fpvCtl, camCtl.el, opsBtn, h('span', { class: 'spacer' }),
    h('div', { class: 'pill-group fs-cmds' }, armBtn, modeSel,
      h('button', { class: 'btn sm fs-takeoff-btn', type: 'button', onclick: () => takeoffDialog() }, LAUNCH_BTN[launch?.method] || 'Kalkış'),
      h('button', { class: 'btn sm', type: 'button', onclick: () => cmd('rtl') }, 'RTL')),
    h('div', { class: 'pill-group' }, rcBtn),
    h('div', { class: 'pill-group' }, h('button', { class: 'btn sm', type: 'button', title: 'SITL aynı ayarlarla yeniden başlar; çarpışma kaldırılır', onclick: () => reset() }, '↺ Sıfırla'), endBtn));
  // Sanal kumanda katmanı (HEPGO birebir): sol çubuk gaz/yaw, sağ çubuk pitch/roll (Mode 2); klavye ipucu; Mission Planner joystick uyarısı
  const stickL = h('div', { class: 'fs-stick', 'data-side': 'l' }, h('i', { class: 'fs-stick-knob' }), h('small', null, 'Gaz / Yaw'));
  const stickR = h('div', { class: 'fs-stick', 'data-side': 'r' }, h('i', { class: 'fs-stick-knob' }), h('small', null, 'Pitch / Roll'));
  const rcWarn = h('div', { class: 'fs-rc-warn', hidden: true }, 'Mission Planner joystick de açıksa son gelen RC komutu geçerli olur');
  const rcHint = h('div', { class: 'fs-rc-hint' }, h('span', null, 'W/S gaz · A/D yaw · ↑↓ pitch · ←→ roll · Q/E mod kanalı · Boşluk gaz orta'), rcWarn);
  const sticks = h('div', { class: 'fs-sticks', hidden: true }, stickL, stickR, rcHint);
  const netLbl = h('div', { class: 'fs-net mono', title: tr('Telemetri alım hızı, jitter (alım aralığı − kaynak aralığı) ve uyarlanır gecikme tamponu; DR = ölü hesap') }, '');
  const netsim = ctx.netsim !== undefined ? parseNetsim(ctx.netsim) : netsimFromLocation();   // §5 teşhis: ?netsim=jitter30,loss5,delay40
  let rc = null;   // sanal kumanda (virtualRC) ya da null
  const ended = h('div', { class: 'fs-ended', hidden: true });
  const countdown = h('div', { class: 'fs-countdown', hidden: true }, h('b', null, '3'), h('span', null, ''));
  const handLbl = isHand ? h('div', { class: 'fs-hand-lbl mono' }, handHud(hcfg)) : null;
  const attribTxt = h('span', null, g3dMode ? 'Google' : M3D.ATTRIBUTION);
  const attrib = h('div', { class: `fs-attrib ${g3dMode ? 'fs-attrib-g3d' : ''}`, hidden: !(g3dMode || realMode) }, g3dMode ? h('img', { class: 'fs-g3d-logo', src: '/static/img/google-logo.png', alt: 'Google' }) : null, attribTxt);
  // §10 güç paneli: dört analog kadran (YAKIT · HIZ · MOTOR · BATARYA); uyarı bandı (bitti / düşük)
  const gauges = MPower.createPowerGauges(stage, { h, tr: trP, getSettings: () => session.power || null, getSummary: () => null, plane: type === 'sabit_kanat' || type === 'vtol', getCollision: () => !crash.hidden });
  gauges.el.classList.add('sm-game');   // oyun teması (power.css)
  const pwAlert = h('div', { class: 'sm-pw-alert', hidden: true, role: 'alert' }, h('b'), h('small'));
  stage.append(mount, msg, crash, events, sticks, bar, nav, ended, countdown, gauge.el, gauges.el, pwAlert, attrib, netLbl);
  camPip = MCam.createCameraPip(mount, { getSim: () => sim, tr: trc, prefs: camPrefs, insets: side => { const o = MCam.pipObstacleInsets(stage, mount, side); return { top: Math.max(56, Math.round(nav.getBoundingClientRect().bottom - mount.getBoundingClientRect().top) + 10), bottom: Math.max((bar.offsetHeight || 54) + 28, o.bottom || 0), right: o.right ?? 12 }; }, onSwap: () => drawFpv() });
  if (handLbl) stage.append(handLbl);
  view.classList.add('sm-fly-session');
  clear(view, stage);

  // ---------- olay şeridi ----------
  const sevClass = s => (typeof s === 'number' ? (s <= 3 ? 'err' : s === 4 ? 'warn' : 'info') : /err|crit|alert|emerg/.test(String(s || '')) ? 'err' : /warn/.test(String(s || '')) ? 'warn' : 'info');
  const addEvent = (text, severity = 'info', tag = 'SİM') => {
    const d = new Date(), stamp = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
    events.prepend(h('div', { class: `fs-ev ${sevClass(severity)}` }, h('span', { class: 'fs-ev-t' }, stamp), h('span', null, text)));
    while (events.children.length > 8) events.lastChild.remove();
    ops?.log(text, { err: 'hata', warn: 'uyari', info: 'bilgi' }[sevClass(severity)], tag);
  };

  // ---------- komutlar (WS cmd/res) ----------
  let ridSeq = 0; const pending = new Map();
  const cmd = (name, params = {}) => new Promise(resolve => {
    const rid = `f${++ridSeq}-${Date.now().toString(36)}`;
    const tmo = name === 'takeoff' ? 100000 : 15000;   // sim yolu kalkış: sunucu kalp atışı/EKF konumunu bekleyebilir (≤ 90 sn)
    const timer = setTimeout(() => { pending.delete(rid); resolve({ ok: false, error: tr('yanıt alınamadı ({s} sn)', { s: tmo / 1000 }) }); }, tmo);
    pending.set(rid, { resolve, timer });
    if (!socket?.send({ t: 'cmd', rid, bridge_id: session.hub.bridge_id, sysid: 1, name, params })) { clearTimeout(timer); pending.delete(rid); resolve({ ok: false, error: tr('bağlantı yok') }); return; }
    addEvent(tr('Komut: {c}', { c: name + (params.mode ? ` ${params.mode}` : params.alt != null ? ` ${params.alt} m` : '') }), 'info', 'KOMUT');
  }).then(r => { if (!r.ok) { addEvent(`${name}: ${r.error}`, 'error', 'KOMUT'); toast(`${name}: ${r.error}`, 'err'); } return r; });

  // ---------- elden atış akışı: geri sayım → takeoff komutu → aşamalar ----------
  let handTimers = [];
  const clearHandTimers = () => { handTimers.forEach(clearTimeout); handTimers = []; };
  const setHandPhase = p => { if (!hand) return; if (p === 'idle' || p == null) { hand.setPhase('idle'); return; } const order = HAND_PHASES.indexOf(p); if (order >= hand.order) hand.setPhase(p); };
  const showCountdown = (sec, sub) => new Promise(resolve => {
    countdown.hidden = false; countdown.lastChild.textContent = sub || '';
    let n = sec;
    const tick = () => { if (destroyed) return resolve(); countdown.firstChild.textContent = n > 0 ? String(n) : 'AT!'; countdown.classList.remove('pop'); void countdown.offsetWidth; countdown.classList.add('pop'); if (n <= 0) { handTimers.push(setTimeout(() => { countdown.hidden = true; resolve(); }, 650)); return; } n--; handTimers.push(setTimeout(tick, 1000)); };
    tick();
  });
  const handTakeoff = async alt => {
    setHandPhase('armed'); addEvent(tr(LAUNCH_PHASE_TEXT.armed.hand));
    await showCountdown(HAND.countdown_s, tr('Elden atış · {v} m/s · {p}°', { v: hcfg.speed_ms.toFixed(0), p: Math.round(hcfg.pitch_deg) }));
    if (destroyed) return { ok: false };
    setHandPhase('launch'); addEvent(tr(LAUNCH_PHASE_TEXT.launch.hand), 'warning');
    const r = cmd('takeoff', { alt, launch: 'hand', hand_speed_ms: hcfg.speed_ms, hand_pitch_deg: hcfg.pitch_deg });
    handTimers.push(setTimeout(() => { if (!destroyed && hand && hand.order < 3) { setHandPhase('released'); addEvent(tr(LAUNCH_PHASE_TEXT.released.hand), 'warning'); } }, Math.round(handReleaseTime(hcfg) * 1000)));
    return r;
  };
  const cmdSim = (name, params = {}) => (name === 'takeoff' && isHand ? handTakeoff(num(params.alt, 60)) : cmd(name, params));
  // Alt çubuk Kalkış (panel kapalıyken; HEPGO takeoffDialog kalıbı): sabit kanat ailesi → sim yolu takeoff{alt} (düzenek dizisi, ARM dâhil);
  // diğerleri → hub akışı takeoff{alt_rel_m} (GUIDED → ARM → NAV_TAKEOFF; kalp atışı/EKF beklenir) — pilot ayrıca ARM etmez
  const takeoffDialog = () => {
    const alt = h('input', { class: 'input', type: 'number', min: 1, max: 500, value: launch ? 80 : 30 });
    const m = launch?.method;
    const hint = m === 'ramp' ? tr('Uçak TAKEOFF moduna alınır ve ARM edilir; 1 sn sonra pnömatik rampa kızağı {a}° açıyla fırlatır (SITL mancınık tetiği).', { a: Math.round(launch.angle_deg) })
      : m === 'vehicle' ? tr('Uçak TAKEOFF moduna alınır ve ARM edilir; pickup pist boyunca hızlanır, {k} km/h yer hızında uçak bırakılır ve tırmanır.', { k: Math.round(launch.release_kmh) })
      : m === 'hand' ? tr('Geri sayım sonunda pilot uçağı elden atar; motor ARM edilir ve uçak tırmanır.')
      : launch ? tr('Uçak TAKEOFF moduna alınır ve ARM edilir; pist boyunca hızlanır.') : tr('GÖKTUNGU akışı: GUIDED → ARM → NAV_TAKEOFF; dron hedef irtifaya yükselir.');
    const label = LAUNCH_BTN[m] || 'Kalkış';
    modal({ title: label, body: h('div', null, h('label', { class: 'field' }, h('span', null, tr('Hedef irtifa (m, AGL)')), alt), h('p', { class: 'small muted' }, hint)),
      actions: [{ label: tr('Vazgeç') }, { label, class: 'primary', onClick: () => { const a = Math.min(500, Math.max(1, Number(alt.value) || 30)); if (launch) cmdSim('takeoff', { alt: a }); else cmd('takeoff', { alt_rel_m: a }); } }] });
  };

  // ---------- panel / ses / HUD / OSD / kayıt ----------
  const restoreWs = installWsBridge(wsAddr);
  ops = MPanel.createOpsPanel(stage, { sid, session, type, modes, launch, canWrite: true, hub: true, mp: { addr: `${mp.host}:${mp.port}`, port: mp.port, copy: () => copyText(`tcp:${mp.host}:${mp.port}`, 'Adres kopyalandı') }, getSim: () => sim, cmdSim, onReset: () => reset(), onToggle: on => { opsBtn.classList.toggle('primary', on); camPip?.layout(); } });
  opsBtn.classList.toggle('primary', ops.enabled);
  patchMpBox(stage, mp);
  if (MAudio.AUDIO_MODELS && !MAudio.AUDIO_MODELS.interceptor) MAudio.AUDIO_MODELS.interceptor = { ...INTERCEPTOR_AUDIO };   // yüksek devirli ayrı ses modeli (dosyaya dokunmadan)
  const audio = MAudio.createEngineAudio(stage, { type: audioTypeFor(dType), launch: launch && !isHand ? launch : null, replay: false, tr, getSim: () => sim, getCrashed: () => !crash.hidden, getSpeed: () => 1 });
  const hudCtx = { world, session, replay: false, launch: launch && !isHand ? launch : null, fov: 78, t0: Date.now(),
    get pose() { return sim?.getPose?.() || null; }, get gimbalDeg() { return sim?.getGimbal() ?? 0; }, get camMode() { return sim?.getCamera(); }, get collision() { return !crash.hidden; }, get pipRect() { return sim?.getPip?.() ? sim.pipRect : null; } };
  milHud = MHud.createMilHud(stage, hudCtx, { tr });
  mhudBtn.classList.toggle('primary', milHud.enabled);
  const osdCtx = { session, replay: false, t0: hudCtx.t0, get pose() { return sim?.getPose?.() || null; }, get camMode() { return sim?.getCamera(); }, get collision() { return !crash.hidden; },
    get fov() { return sim?.getPilotFov?.() ?? fpvPrefs.fov; }, get pip() { return !!sim?.getPip?.(); }, get pipRect() { return sim?.getPip?.() ? sim.pipRect : null; }, get rcOn() { return !!rc; } };
  osd = MOsd.createFpvOsd(stage, osdCtx, { tr });
  osd.setAnalog?.(fpvPrefs.analog);
  const recText = () => ['SIMUMAV', TYPE_LABEL[dType] || dType, drone.name, track.name, pilot?.name, launch ? launchLabelSm(launch) : null, fmtDateTime(session.created_at)].filter(Boolean).join(' · ');
  const wantVideo = !!(picked.record?.video ?? start.record?.video);
  if (wantVideo && MRec.recSupported()) rec = MRec.createRecorder(stage, { sid: fid, tr, getSim: () => sim, getHudCanvas: () => stage.querySelector('.fs-mhud'), getOsdCanvas: () => stage.querySelector('.fs-osd'), getOverlays: () => [camPip?.overlay()].filter(Boolean), audio, text: recText, share: () => false, rest: recRest(fid), onEvent: (t, sev) => addEvent(t, sev) });

  // ---------- 3B (HEPGO renderSession kurulumu: üç kip) ----------
  let worldReady = false;
  const progMsg = p => {
    if (destroyed) return;
    if (p.stage === 'done') {
      worldReady = true; if (session.state === 'HAZIR') msg.hidden = true;
      if (p.real) addEvent(`${tr('Gerçek arazi · yükseklik {a}…{b} m · ev {h} m MSL', { a: f0(p.hmin), b: f0(p.hmax), h: f0(p.homeElev) })} · ${tr('{b} bina · {f} orman · {w} su · {r} pist', { b: p.counts?.buildings ?? 0, f: p.counts?.forests ?? 0, w: p.counts?.water ?? 0, r: p.counts?.runways ?? 0 })}`);
      if (p.google) addEvent(tr('Google 3B (fotogerçekçi) · ev {h} m MSL', { h: f0(p.homeElev) }));
      return;
    }
    if (p.stage === 'g3d-ground') { addEvent(tr('Google 3B yer ofseti {o} m', { o: f1(p.offset) })); return; }
    if (p.stage === 'g3d') { if (worldReady) return; if (p.pct >= 100) { if (session.state === 'HAZIR') msg.hidden = true; return; } msg.hidden = false; msg.textContent = tr('Google 3B karoları yükleniyor… %{p}', { p: p.pct ?? 0 }); return; }
    msg.hidden = false;
    msg.textContent = p.stage === 'elev' ? tr('Yükseklik karoları {d}/{n}', { d: p.done, n: p.total }) : p.stage === 'img' ? tr('Uydu karoları {d}/{n}', { d: p.done, n: p.total }) : p.stage === 'osm' ? tr('Harita verileri (OSM) alınıyor…') : tr('Arazi planı alınıyor…');
  };
  const onCamChange = mode => {
    camBtns.forEach(b => b.classList.toggle('primary', b.dataset.cam === mode)); gimbalLbl.hidden = mode !== 'fpv'; mhudBtn.hidden = mode !== 'fpv'; fpvCtl.hidden = mode !== 'pilot';
    milHud?.setCamMode(mode); osd?.setCamMode(mode); ops?.setFpv(mode === 'fpv' || mode === 'pilot'); gimbalLbl.textContent = tr('Gimbal {d}° (↑↓ / tekerlek)', { d: sim?.getGimbal() ?? 0 }); fpvPrefs.setCam(mode); drawFpv();
  };
  try {
    if (realMode) { msg.hidden = false; msg.textContent = tr('Arazi planı alınıyor…'); }
    if (g3dMode) { msg.hidden = false; msg.textContent = tr('Google 3B karoları yükleniyor… %{p}', { p: 0 }); }
    const s3 = await M3D.createFlightSim3D(mount, world, {
      type, model: session.model, launch, origin: { lat: session.center.lat, lon: session.center.lon, alt: session.center.alt },
      camera: cam0, pilotFov: fpvPrefs.fov, fpvAnalog: fpvPrefs.analog, fpvNose: fpvPrefs.nose, onPilotFov: v => { fpvPrefs.setFov(v); drawFpv(); },
      camType: camType0, thermalPalette: camPrefs.palette, onGimbalZoom: () => camPip?.redraw(),
      onCameraChange: onCamChange, onCollision: info => cmd('crash', { kind: info.kind, speed: info.speed, dz: info.dz }).catch(() => {}),
      onProgress: progMsg, g3dKey: async () => meta?.maps_key || '',
      onFallback: e => { const t = g3dMode ? tr('Google 3B verisi alınamadı: {e} → prosedürele düşüldü', { e }) : tr('Gerçek veri alınamadı, prosedürele düşüldü: {e}', { e }); addEvent(t, 'warning'); toast(t, 'err'); attrib.hidden = true; },
    });
    if (destroyed) { s3.dispose(); return { dispose() {} }; }
    sim = s3; window.__smSim = sim;
    if (netsim) window.__fsSim = sim;   // HEPGO teşhis adı: Playwright/konsol sim.netStats() · sim.motionStats(true)
    if (sim.terrainInfo && !worldReady) progMsg({ stage: 'done', real: sim.real, google: sim.google, ...sim.terrainInfo });
    msg.hidden = session.state === 'HAZIR';
    camPip?.layout();   // §22.4 kamera PiP'i (aç/kapa + dikdörtgen 3B'ye)
    sim.setCamera(cam0); camBtns.forEach(b => b.classList.toggle('primary', b.dataset.cam === sim.getCamera()));
    drawFpv();
    if (isHand || gates.length) {
      const T = await import(THREE_URL);
      overlay = createOverlay3D(stage, sim, T);
      if (isHand) { hand = createHandOverlay(overlay, sim, T, { cfg: hcfg, headingDeg: world.runway_heading, scale: 2.5 }); hand.anchorAt(0, 0); window.__smHand = hand; }
      if (gates.length) {
        gateLayer = createGateLayer(overlay, sim, T, gates, gatePlan, { onEvent: evs => { for (const e of evs) { if (e.type === 'pass') addEvent(tr('Halka #{i} geçildi', { i: e.i + 1 }), 'info', 'HALKA'); else if (e.type === 'miss') addEvent(tr('Halka #{i} kaçırıldı', { i: e.i + 1 }), 'warning', 'HALKA'); else if (e.type === 'wrong_way') addEvent(tr('Halka #{i}: ters yön!', { i: e.i + 1 }), 'error', 'HALKA'); else if (e.type === 'lap') addEvent(tr('Tur {n} tamamlandı{s}', { n: e.lap, s: e.lap_s != null ? ` · ${e.lap_s.toFixed(1)} sn` : '' }), 'info', 'HALKA'); else if (e.type === 'finish') { addEvent(tr('Parkur tamamlandı!'), 'info', 'HALKA'); toast(tr('Parkur tamamlandı!')); } } } });
        window.__smGates = gateLayer;
      }
      sim.addFrameHook(() => overlay?.update());
    }
    sim.addFrameHook(() => gauge.frame(1 / 60));
    if (rec) rec.start(MRec.takeStashedStream()).catch(() => {});
  } catch (err) { sceneError = err; console.error('3B sahne kurulamadı', err); }

  // Sahne kurulamadı (WebGL bağlamı yok vb.): uçuş sunucuda açık BIRAKILMAZ → otomatik stop + anlaşılır mesaj (BAŞLA tekrar denenebilir)
  if (sceneError) {
    const e = sceneError.message || String(sceneError);
    const dispose0 = () => { if (destroyed) return; destroyed = true; safe(() => milHud?.dispose()); safe(() => osd?.dispose()); safe(() => camPip?.dispose()); safe(() => camCtl.dispose()); safe(() => { if (rec) { rec.abandon(); rec.dispose(); } }); safe(() => audio.dispose()); safe(() => ops?.dispose()); safe(() => restoreWs()); document.removeEventListener('fullscreenchange', onFullChange); document.body.classList.remove('fs-full'); view.classList.remove('sm-fly-session'); stage.remove(); };
    dispose0();
    if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
    let stopped = false;
    try { await net.post(`/api/fly/${encodeURIComponent(fid)}/stop`, { reason: 'webgl' }); stopped = true; } catch (err2) { console.warn('uçuş kapatılamadı', err2); }
    const box = h('div', { class: 'sm-fly sm-loading sm-scene-fail' },
      h('h2', null, tr('3B görünüm açılamadı')),
      h('p', null, tr('3B görünüm açılamadı: {e}', { e })),
      h('p', { class: 'muted small' }, stopped ? tr('Uçuş sunucuda kapatıldı; açık uçuş bırakılmadı. Sekmeyi yenileyip (ya da başka sekmeleri kapatıp) yeniden deneyebilirsiniz.') : tr('Uçuş kapatılamadı; Uç sihirbazındaki "Süren uçuşunuz var" kartından bitirebilirsiniz.')),
      h('div', { class: 'btn-row' }, h('button', { class: 'btn primary', type: 'button', onclick: () => go('#/fly') }, tr('Sihirbaza dön'))));
    clear(view, box);
    const api0 = { dispose: dispose0, stage, sim: null, error: sceneError, stopped, session, world };
    window.__smSession = api0;
    return api0;
  }

  // ---------- durum / telemetri ----------
  const setState = st => {
    session.state = st; stateBadge.className = `badge ${STATE_BADGE[st] || 'gray'}`; stateBadge.textContent = tr(STATE_TEXT[st] || st);
    if (st === 'BASLIYOR') { msg.hidden = false; msg.textContent = tr('SITL başlıyor…'); }
    else if (st === 'HATA') { msg.hidden = false; msg.classList.add('err'); msg.textContent = tr('SITL hatası: {e}', { e: session.sitl?.error || '—' }); }
    else if (st === 'HAZIR') { msg.classList.remove('err'); if (sim) msg.hidden = true; }
    ops?.setState(st);
  };
  const setWs = st => { const map = { connecting: ['yellow', 'Bağlanıyor…'], reconnect: ['yellow', 'Yeniden bağlanıyor…'], open: ['green', 'Canlı'], closed: ['red', 'Bağlantı koptu'] }; const [tone, text] = map[st] || ['gray', st]; wsBadge.className = `badge ${tone}`; wsBadge.textContent = tr(text); };
  let handAnchored = false;
  // ---------- §10 güç ve yakıt: kadranlar + düşük seviye uyarısı (bir kez) + bitti bandı ----------
  const units = { min: tr('power.u_min'), h: tr('power.u_h') };
  const localUnits = units.min && units.min !== 'power.u_min' && units.min !== 'dk';
  const lowSaid = { fuel: false, elec: false }, emptySaid = { fuel: false, elec: false };
  let alertTimer = 0;
  const showPwAlert = (title, sub, kind) => {
    pwAlert.firstChild.textContent = title; pwAlert.lastChild.textContent = sub || '';
    pwAlert.className = `sm-pw-alert ${kind}`; pwAlert.hidden = false;
    clearTimeout(alertTimer); alertTimer = setTimeout(() => { pwAlert.hidden = true; }, kind === 'empty' ? 5200 : 3200);
  };
  const powerEmpty = (k, text) => {
    if (emptySaid[k]) return; emptySaid[k] = true;
    const title = tr(k === 'fuel' ? 'power.toast_fuel_empty' : 'power.toast_elec_empty');
    showPwAlert(title, tr('power.empty_sub'), 'empty'); sfx.alarm();   // büyük bant yeterli (toast üst çubuğu örtüyordu)
    if (!text) addEvent(title, 'error', 'GÜÇ');   // sunucu warn'ı geldiyse aynı metin zaten `event` olarak şeritte
  };
  const onPower = raw => {
    gauges.update(raw);
    if (localUnits) for (const sub of gauges.el.querySelectorAll('.fs-gauge-sub')) { const v = localizeUnits(sub.textContent, units); if (v !== sub.textContent) sub.textContent = v; }
    if (raw.speedup != null && Number(raw.speedup) !== speedPill.value) speedPill.set(Number(raw.speedup));
    const f = raw.fuel, e = raw.elec;
    if (f?.empty) powerEmpty('fuel'); else if (f && f.pct < 20 && !lowSaid.fuel) { lowSaid.fuel = true; showPwAlert(tr('power.low_fuel'), tr('power.low_fuel_sub', { r: MPower.rangeText(f.range_km) }), 'low'); sfx.caution(); addEvent(tr('power.low_fuel'), 'warning', 'GÜÇ'); }
    if (e?.empty) powerEmpty('elec'); else if (e && e.pct < 25 && !lowSaid.elec) { lowSaid.elec = true; showPwAlert(tr('power.low_elec'), tr('power.low_elec_sub', { m: Math.round(e.min_left ?? 0) }), 'low'); sfx.caution(); addEvent(tr('power.low_elec'), 'warning', 'GÜÇ'); }
  };
  const onTele = raw => {
    last = raw;
    let t = raw;
    if (hand && sim) {
      if (!handAnchored && raw.lat != null && raw.lon != null) { const p = sim.toLocal(raw.lat, raw.lon); hand.anchorAt(p.x, p.y); handAnchored = true; }
      t = shimTelemetry(raw, hand.lastPose, world.runway_heading);
    }
    // HEPGO updateHud sırası: 3B zaman çizgisi (interp tamponu) ÖNCE, sonra HUD/OSD/ses/panel (aynı kare; kamera güncellemesi 3B'nin rAF'ında)
    sim?.setTelemetry(t); milHud?.update(t); osd?.update(t); audio.update(raw); ops?.update(t);
    gateLayer?.update(raw, num(raw.tbm, null) != null ? num(raw.tbm) / 1000 : (Date.now() - hudCtx.t0) / 1000);
    gauge.update((type === 'sabit_kanat' || type === 'vtol' ? num(raw.airspeed, num(raw.groundspeed, 0)) : num(raw.groundspeed, 0)) * 3.6);
    onPower(raw);
    if (rc) rcWarn.hidden = !raw.gcs_connected;
    armBtn.textContent = raw.armed ? 'DISARM' : 'ARM'; armBtn.classList.toggle('danger', !!raw.armed);
    if (raw.mode && modeSel.value !== raw.mode && document.activeElement !== modeSel) modeSel.value = modes.includes(raw.mode) ? raw.mode : '';
    if (raw.gcs_connected != null) ops?.setGcs(!!raw.gcs_connected, raw.gcs_addr);
    if (sim && session.state === 'HAZIR' && !msg.classList.contains('err')) msg.hidden = true;
  };
  const onLaunch = m => {
    if (!launch) return;
    if (isHand) setHandPhase(m.phase); else { sim?.setLaunchPhase(m.phase); ops?.setLaunchPhase?.(m.phase); }
    const txt = (LAUNCH_PHASE_TEXT[m.phase] || {})[launch.method] || m.phase;
    addEvent(m.phase === 'released' && m.speed_kmh != null ? `${tr(txt)} · ${f0(m.speed_kmh)} km/h` : tr(txt), m.phase === 'released' || m.phase === 'launch' ? 'warning' : 'info');
  };
  const showCrash = (reason, speed) => { if (!crash.hidden) return; const k = tr(CRASH_KIND[reason] || 'Çarpışma'); crash.hidden = false; crash.querySelector('.fs-crash-sub').textContent = tr('{k} · {v} m/s · "Sıfırla" ile yeniden başlayın', { k, v: f1(speed) }); addEvent(tr('ÇARPIŞMA: {k} ({v} m/s)', { k, v: f1(speed) }), 'error'); };
  const reset = async () => { pwAlert.hidden = true; crash.hidden = true; sim?.clearCollision(); sim?.setLaunchPhase(null); clearHandTimers(); hand?.setPhase('idle'); countdown.hidden = true; gateLayer?.tracker.reset(); sim?.resetCamera(); await cmd('reset'); };
  const showEnded = reason => { clear(ended, h('div', { class: 'fs-ended-box' }, h('b', null, 'Uçuş sona erdi'), h('div', { class: 'small muted' }, tr(END_REASON[reason] || reason || '')), h('button', { class: 'btn primary', type: 'button', onclick: () => go('#/ops') }, 'Operasyon\'a git'))); ended.hidden = false; };
  socket = wsClient(wsAddr, {
    status: setWs,
    fatal: why => { setWs('closed'); showEnded(why === 'auth' ? tr('Bu uçuşu izleme yetkiniz yok.') : why === 'notfound' ? tr('Uçuş sunucuda yok (kapanmış olabilir).') : why); },
    message: m => {
      if (destroyed) return;
      switch (m.t) {
        case 'tele': return void netsimDeliver(netsim, () => { if (!destroyed) onTele(m); });   // netsim yoksa anında (HEPGO: gecikme + jitter + kayıp)
        case 'hello': if (m.session) { Object.assign(session, m.session, { hub: { ...session.hub, ...(m.session.hub || {}) } }); setState(session.state); if (Array.isArray(session.route) && session.route.length) { sim?.setMission({ ...(session.mission || {}), points: session.route }); ops?.setRoute(session.route); } } return;
        case 'route': sim?.setMission(m); ops?.setRoute(m.points || []); if (m.source === 'mp') toast(tr("Mission Planner'dan görev yüklendi: {n} nokta", { n: m.points?.length || 0 })); return;
        case 'mission_cur': return sim?.setMissionCurrent(m.seq);
        case 'crash': return showCrash(m.reason, m.speed);
        case 'warn': { const wi = warnInfo(m); if (wi) return powerEmpty(m.kind === 'fuel_empty' ? 'fuel' : 'elec', m.text); return addEvent(tr('Otopilot çarpışma tespiti — kayıt değil: {t}', { t: m.text || '' }), 'warning'); }
        case 'event': return addEvent(m.text, m.severity, 'STATUS');
        case 'launch': return onLaunch(m);
        case 'state': if (m.center) session.center = { ...session.center, ...m.center }; return setState(m.state);
        case 'res': { const p = pending.get(m.rid); if (p) { clearTimeout(p.timer); pending.delete(m.rid); p.resolve(m); } return; }
        case 'end': setState('KAPANDI'); showEnded(m.reason); socket?.close(); return;
        default: return;
      }
    },
  });
  if (session.state !== 'HAZIR') setState(session.state);

  // ---------- bitir / ayrıl ----------
  let ending = false;
  const endFlight = async () => {
    if (ending) return;
    if (!await confirmDialog('Uçuşu bitir', 'Uçuş bitirilsin mi? SITL ve Mission Planner TCP portu kapanır; özet rapor gösterilir.', { okLabel: 'Bitir', danger: true })) return;
    ending = true; endBtn.disabled = true;
    try {
      if (rec?.hasData) await rec.finishWithDialog();
      const body = {};
      if (gateLayer) body.gates = gateLayer.body();
      const r = await net.post(`/api/fly/${encodeURIComponent(fid)}/stop`, body);
      const sum = r?.flight?.summary || r?.summary || null;   // POST stop → {ok, flight:{…, summary:{session, flight, mission, crash, gates}}}
      gaTrack('flight_end', { drone_type: drone?.type || 'unknown', duration_s: Math.round((Date.now() - tOpen) / 1000), world_mode: track?.world_mode || 'unknown', gates: body.gates ? 1 : 0 });
      await showFlightReport(MReport, sum || {}, body.gates || r?.gates || null, { pilot, drone, track, flightId: fid, ctx });
      if (document.fullscreenElement) await document.exitFullscreen?.().catch(() => {});
      toast('Uçuş kaydedildi');
      go('#/ops');
    } catch (err) { toastError(err); ending = false; endBtn.disabled = false; }
  };
  const leaveToMenu = async () => { if (await confirmDialog('Uçuştan çık', 'Uçuş sürüyor. Bitirmeden çıkılsın mı? (Uçuş arka planda kalır; Operasyon\'dan bitirebilirsiniz.)', { okLabel: 'Çık', danger: true })) go('#/fly'); };
  // ---------- sanal kumanda (HEPGO rcToggle birebir): 20 Hz {t:'rc', ch} yalnız açıkken; kapatınca tek sefer 8×0 (override serbest) ----------
  const rcToggle = () => {
    if (rc) {
      rc.dispose();                      // zamanlayıcı durur, dinleyiciler kalkar, 8×0 gönderilir
      rc = null;
      sticks.hidden = true; stage.classList.remove('rc-on'); rcBtn.classList.remove('primary');
      sim?.setKeyboardLock?.(false);
      addEvent(tr('Sanal kumanda kapatıldı (RC override serbest)'));
      return;
    }
    rc = virtualRC({ plane: type === 'sabit_kanat' || type === 'vtol', stickL, stickR, send: ch => socket?.send({ t: 'rc', ch }),
      throttle0: last?.armed ? last.throttle : null });   // uçuştayken açılırsa gaz çubuğu mevcut gazdan başlar (yerde/disarm: 1000)
    sticks.hidden = false; stage.classList.add('rc-on'); rcBtn.classList.add('primary');
    rcWarn.hidden = !last?.gcs_connected;
    sim?.setKeyboardLock?.(true);
    addEvent(tr('Sanal kumanda açık (RC override)'));
  };
  const netTick = setInterval(() => {
    if (!sim?.netStats) { netLbl.hidden = true; return; }
    const n = sim.netStats();
    netLbl.hidden = false;
    netLbl.textContent = tr('net: {hz} Hz · jitter {j} ms · tampon {d} ms', { hz: n.hz, j: n.jitter, d: n.delay }) + (n.deadReckoning ? ' · DR' : '');
    netLbl.classList.toggle('warn', n.hz > 0 && (n.hz < 15 || n.jitter > 40));
  }, 500);
  // Klavye: P (panel), O (OSD), H (askeri HUD), C/1–5 (kamera) HEPGO modüllerinin kendi dinleyicilerinde — burada yalnız Esc → Geri (HEPGO onKeyBack:
  // tam ekran dışında, pencere yokken, odak girişte değilken; tam ekranda Escape'i tarayıcı yakalar ve çıkar)
  const onKey = e => {
    if (e.key !== 'Escape' || e.defaultPrevented || document.fullscreenElement) return;
    if (document.querySelector('.modal-back, .fs-pop') || /^(INPUT|SELECT|TEXTAREA)$/.test(e.target?.tagName || '')) return;
    e.preventDefault(); leaveToMenu();
  };
  window.addEventListener('keydown', onKey);
  const onDocClick = e => { if (!fpvMenu.hidden && !fpvCtl.contains(e.target)) fpvMenu.hidden = true; };
  document.addEventListener('click', onDocClick, true);
  // Çıkış zinciri (her adım ayrı korunur; biri fırlatsa da sim.dispose → forceContextLoss kesin çağrılır): WS, panel, HUD, OSD, kayıt, ses, kaplama, sahne
  const dispose = () => {
    if (destroyed) return; destroyed = true;
    clearInterval(netTick); clearTimeout(alertTimer);
    safe(() => gauges.dispose());
    safe(() => { if (rc) { rc.dispose(); rc = null; } });   // override serbest bırakılır (soket kapanmadan önce)
    safe(clearHandTimers); safe(() => socket?.close());
    for (const [, p] of pending) { clearTimeout(p.timer); p.resolve({ ok: false, error: 'kapandı' }); } pending.clear();
    safe(() => milHud?.dispose()); safe(() => osd?.dispose()); safe(() => camPip?.dispose()); safe(() => camCtl.dispose()); safe(() => { if (rec) { rec.abandon(); rec.dispose(); } }); safe(() => audio.dispose()); safe(() => ops?.dispose());
    safe(() => hand?.dispose()); safe(() => gateLayer?.dispose()); safe(() => overlay?.dispose()); safe(() => sim?.dispose());
    safe(restoreWs);
    if (window.__smSim === sim) delete window.__smSim; if (window.__fsSim === sim) delete window.__fsSim; delete window.__smHand; delete window.__smGates; if (window.__smSession === api) delete window.__smSession;
    document.removeEventListener('fullscreenchange', onFullChange); window.removeEventListener('keydown', onKey); document.removeEventListener('click', onDocClick, true);
    document.body.classList.remove('fs-full'); view.classList.remove('sm-fly-session');
    stage.remove();
  };
  onLeave(dispose);
  const api = { dispose, stage, gauges, speedPill, get sim() { return sim; }, get hand() { return hand; }, get gates() { return gateLayer; }, get rc() { return rc; }, rcToggle, takeoffDialog, netsim, gauge, cmd: cmdSim, endFlight, session, world, addEvent };
  window.__smSession = api;   // teşhis (Playwright): komut gönder, halka/elden atış durumunu oku
  return api;
}
