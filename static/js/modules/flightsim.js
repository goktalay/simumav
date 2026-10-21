// Uçuş Simülatörü — Dron Yönetimi › Uçuş Simülatörü sekmesi (#/drone/sim[/<oturum>]). Sözleşme: docs/ucus-simulatoru.md.
// drone.js `sim` sayfasında dinamik yükler: import('./flightsim.js').then(mod => mod.render(view, params, ctx, { m, head, mock }))
// • Sihirbaz (§6): dron tipi kartları → merkez seçimi (/api/drone/sim/meta centers) → dünya kaydırıcıları + "Rastgele tohum" + küçük 3B
//   önizleme → Başlat (POST /api/drone/sim/sessions). Açık oturum varsa üstte liste: devam et / bitir.
// • Oturum ekranı: tam alan 3B tuval (flightsim3d.js) + YERLİ harekât paneli (§14, flightsim_panel.js: GÖKTUNGU dron kartı görünümünde TEK kart
//   sağ üstte — başlık şeridi / PFD / telemetri karoları / İŞLEMLER / Haberleşme konsolu; hub soketi ve komutlar panelde; Panel düğmesi / P
//   gizleyince sade görünüm: eski HUD (sağ) + alt çubuk ARM/mod/Kalkış/RTL + olay şeridi), Mission Planner bağlantı kutusu (sol alt), alt araç
//   çubuğu, ÇARPIŞMA bandı. Tam ekran (⛶) BELGEYE uygulanır (document.documentElement): body'ye eklenen pencereler/bildirimler tam ekranda görünür.
// • WS istemcisi /ws/drone/sim/{id}: hello/tele/event/state/end; ping 10 sn; üstel geri çekilmeli yeniden bağlanma; 4403/4404 kalıcı.
// • Sanal kumanda (yazma izni; alt çubuk 🎮): iki sanal çubuk + klavye → 20 Hz {t:'rc', ch[8]} (RC_CHANNELS_OVERRIDE); kapatınca 8×0.
//   Açıkken 3B klavye kilidi (WASD/ok tuşları kumandaya gider). HUD altında ağ göstergesi: 'net: 48 Hz · jitter 3 ms' (sim.netStats()).
// • `?mock=1`: arka uç yokken yerel kinematik üretici (WS yerine) — sihirbaz, 3B dünya ve HUD arka uçsuz denenir. Mock oturumlar yalnız
//   bu sekmede (bellekte) yaşar; komutlar (arm/disarm/mode/takeoff/rtl/reset/crash) üreticiye uygulanır.
// • §31 KARA ARACI (`rover`, ArduRover): sihirbazda Kalkış ve kontrol düzeni adımı yok, sürüş biçimi (Ackermann / paletli-diferansiyel) seçilir;
//   oturumda Kalkış düğmesi yok (RTL + Dur/HOLD), HUD'da eğim / yatış / km/h, sanal kumandada sol çubuk dikey gaz (yaylı, 1500 = dur), sağ çubuk
//   yatay direksiyon (roverRcChannels). Sahte kipte araç yerde sürer (alt_rel 0; servo çıkışı ArduRover SERVO_OUTPUT_RAW taklidi).
import { api } from '../api.js';
import { clear, confirmDialog, field, fmtDateTime, fmtDuration, goBack, h, modal, onLeave, pref, segmented, setPref, statStrip, toast, toastError, t as tr } from '../ui.js';
import { logOrigin, originBadge } from './flightlog_origin.js';   // uçuş logu kaynağı: gerçek / simülasyon
import { ATTRIBUTION, CAMERA_MODES, WORLD_DEFAULTS, createFlightSim3D } from './flightsim3d.js';
import { createMilHud } from './flightsim_hud.js';   // askeri tarz HUD (Gimbal kamerası 'fpv' kipi; H aç/kapa)
import { createFpvOsd, createFpvPrefs } from './flightsim_fpv_osd.js';   // §22: GERÇEK FPV ('pilot') OSD + tercihler (fs.fpv.*, fs.cam)
import { G3D_LOGO } from './flightsim_g3d.js';   // Google 3B kipi (§11): logo yolu; kütüphane yalnız kip seçilince dinamik yüklenir
import { modelPicker } from './flightsim_models.js';   // görsel model kütüphanesi (§12): kart ızgarası, yükleme, tarayıcıda STEP→GLB, yönelim paneli
import { clientsCard } from './flightsim_clients.js';   // CAYSIM masaüstü istemcileri kartı (docs/caysim-api.md §9): kod bir kez gösterilir, rekey, sil
import { LAUNCH_DEFAULTS, LAUNCH_METHODS, launchLabel, rampExitSpeed, replayLaunchTimeline, replayLaunchPhaseAt } from './flightsim_launch.js';   // sabit kanat kalkış yöntemi (§13; kayıtta aşamalar logdan §8)
import { LAYOUTS, LAYOUT_PARAMS, LAYOUT_SITL_MODEL, layoutForModel, layoutLabel, layoutShort } from './flightsim_airframe.js';   // §13.1 kontrol düzeni: klasik / elevon / V-kuyruk kartları, model → düzen önerisi
import { createEngineAudio } from './flightsim_audio.js';   // §16: tipe göre sentezlenmiş motor sesi (Web Audio); 🔊 düğmesi + M tuşu alt çubukta
import { createOpsPanel } from './flightsim_panel.js';
import { acquireDisplayStream, createRecorder, enterFullscreen, exitFullscreen, pendingCard, recOptionsBox, recPrefs, stashStream, takeStashedStream } from './flightsim_record.js';   // §17: ekran kaydı (Başlat→Bitir) → Şirketten Haberler / sakla; kayıt seçenekleri kutusu; otomatik tam ekran   // §14: YERLİ harekât paneli (iframe yok) — kartlar 3B'nin üstünde yüzer; hub soketi + komutlar panelde
import { showReport } from './flightsim_report.js';   // §18: Bitir'de özet rapor modalı (çarpışma/sapma kırmızı, mini harita); kayıt tablosundan "Rapor"
import { runsTable, runsQuery } from './flightsim_runs.js';   // §21: Simülasyon Kayıtları tablosu (filtre/sıralama/sayfalama; Oynat/Rapor/Video/.bin; MASTER: parametre/script)
import { camTypeLabel, pipObstacleInsets, createCamPrefs, createCameraCards, createCameraCtl, createCameraPip, isCamType, normCamType } from './flightsim_camera.js';   // §22.3–22.5: kamera türü (gündüz/termal/gece), sürüklenebilir kamera PiP'i, sihirbaz kartı
import { createTargetsSection } from './flightsim_targets_ui.js';   // §24 sihirbaz "Hedefler" bölümü
import { createTargetPreviews } from './flightsim_tgtview.js';   // §24.4 hedef kartlarında 3B önizleme (aynı WebGL bağlamı)
import { createInterceptTracker } from './flightsim_targets.js';   // §24 kayıtta önleme olayları (sunucu HedefIzleyici eşleniği)
import { createDefendHud, createSiteScreens, createSiteSection, defendReportBody, showDefendReport } from './flightsim_gcs_ui.js';
import { aimWaypoint, isIceptLauncher, rackCountFor } from './flightsim_launcher.js';   // §27 INTERCEPTOR fırlatıcıları (saf)
import { createLauncherUi } from './flightsim_scope_ui.js';   // §27 hücre envanteri + el fırlatıcısı nişangâh penceresi   // §26 yer kontrol sahası: sihirbaz, radar/EO ekranları, görev şeridi, rapor
import { defendStateAt } from './flightsim_gcs.js';   // §26 kayıtta görev şeridi durumu
import { createFlightBar, flightModesFor, modeKind } from './flightsim_fltbar.js';
import { createServoTrigger } from './flightsim_servotrig.js';   // §34 servo tetik: kanal + PWM eşiği + gecikme + Dinle (mantık sunucuda); çarpınca otomatik Bitir → özet   // §29.6 alt bant: uçuş modu seçici (F) + DISARM/motor kes (X), tüm kamera kiplerinde
import { createRcFeelPanel } from './flightsim_rcfeel.js';   // §27.1 sanal kumanda hassasiyeti (oran / expo / ölü bölge)
import { createGaugeThemePicker, gaugeThemeLabel } from './flightsim_gtheme.js';   // §27.3 gösterge tasarımı (sihirbaz kartları; uçuşta createPowerGauges)
import { createIntro, hepgoSound } from './flightsim_intro.js';   // §27.2 giriş sekansı: 100 m bakış + 3-2-1 geri sayım + bip
import { createPowerGauges, createPowerSection, createPowerSim, createSpeedPill, elecText, fuelText, rangeText } from './flightsim_power.js';   // §23: güç ve yakıt (sihirbaz bölümü, göstergeler, güç paneli kadranları §23.6, kayıtta istemci modeli, hız kapsülü)
import { LAUNCH_OPTIONS, LAUNCH_PARAM_DEFS, createStepper, firstInvalid, launchOptionsFor, launchStepDesc, normLaunchMethod, paramField, simLogsOnly, simulateParam, stepDefFor, wizardStartStep, wizardSteps } from './flightsim_wizard.js';
import { attachMatch, createInviteSection, createRingsSection, matchApi, matchesCard, renderLobby } from './flightsim_match_ui.js';   // §33 çok oyunculu karşılaşma: sihirbaz Halkalar / Davet et, bekleme salonu, oturum katmanı, sekme
import { matchHref, ringsSummary } from './flightsim_match.js';   // §6 adım adım sihirbaz (saf: adım listesi, doğrulama geçişleri, veriden kalkış seçenekleri)
import { numSlider } from './fs_inputs.js';   // §6.1 görsel giriş: kaydırıcı + düzenlenebilir değer kutusu + birim
import { askPresetName, budgetBox, countdown, ensureSavedCss, pilotPicker, savedScreen } from './flightsim_saved.js';   // §27 Kayıtlı Simülasyonlar: üç sütunlu ekran, Uç/Kaydet, pilot, ad sorma, geri sayım
import { presetBodyFromSession } from './flightsim_presets.js';
import { flightBudget } from './flightsim_power.js';   // §27 sihirbaz özeti: azami süre / menzil
import { ROVER_LIMITS, ROVER_MODES, ROVER_RC_TEXT, normDrive, roverRcChannels } from './flightsim_rover.js';   // §31 KARA ARACI (ArduRover): kipler, sanal kumanda eşlemesi (RC1 direksiyon / RC3 gaz)   // §27 sihirbaz özeti: azami süre / menzil (sunucu flightsim_power.menzil_sure ile aynı)
import { WEATHER, WEATHER_ICONS, WEATHER_LABELS, normWeather, takeoffAdvice } from './flightsim_weather.js';   // §31 hava durumu + rüzgâra karşı kalkış önerisi (saf)
import { createRampPanel, createWindGauge } from './flightsim_windui.js';   // §31 rüzgâr göstergesi (baş/yan/kuyruk) + rampa yön/açı paneli

const API = '/api/drone/sim';
// §8 ön hazırlık: sihirbazın hazırlık kartında indirilen kayıt kareleri oturum ekranına devredilir (aynı belge; be.replay yeniden çekilmez)
const REPLAY_STASH = new Map();
const sleep = ms => new Promise(r => setTimeout(r, ms));
const LOG_SORTS = [['new', 'Yeni → eski'], ['old', 'Eski → yeni'], ['long', 'Uçuş süresi (uzun önce)'], ['big', 'Boyut (büyük önce)'], ['origin', 'Kaynak (gerçek önce)'], ['name', 'Ada göre']];
function sortLogs(rows, key) {
  const when = l => Date.parse(l.takeoff_utc || l.start_utc || l.uploaded_at || '') || 0;
  const by = { new: (a, b) => when(b) - when(a) || b.id - a.id, old: (a, b) => when(a) - when(b) || a.id - b.id,
    long: (a, b) => (Number(b.flight_s ?? b.duration_s) || 0) - (Number(a.flight_s ?? a.duration_s) || 0), big: (a, b) => (b.size || 0) - (a.size || 0),
    origin: (a, b) => (logOrigin(a) === logOrigin(b) ? when(b) - when(a) : logOrigin(a) === 'REAL' ? -1 : 1),
    name: (a, b) => String(a.file_name || '').localeCompare(String(b.file_name || ''), 'tr') }[key] || null;
  return by ? rows.slice().sort(by) : rows;
}
// Kayıt dünyası uçuşu kapsasın: evden en uzak kare mesafesinin 2,4 katı (500 m'ye yuvarlı, en çok 20 km) — uçak arazi dışına çıkmasın
function fitWorldSize(data, home) {
  if (!data?.home || !Array.isArray(data.frames) || !data.frames.length) return 0;
  const FI = Object.fromEntries((data.fields || []).map((k, i) => [k, i]));
  const lat0 = Number(home?.lat ?? data.home.lat), lon0 = Number(home?.lon ?? data.home.lon), cos = Math.cos(lat0 * Math.PI / 180);
  let maxD = 0;
  const step = Math.max(1, Math.floor(data.frames.length / 4000));
  for (let i = 0; i < data.frames.length; i += step) { const f = data.frames[i]; if (f[FI.lat] == null) continue; maxD = Math.max(maxD, Math.hypot((f[FI.lon] - lon0) * 111320 * cos, (f[FI.lat] - lat0) * 110574)); }
  return Math.min(20000, Math.ceil(maxD * 2.4 / 500) * 500);
}
// Dron tipleri (SITL TIP_ESLEME anahtarları); meta.types gelirse adlar oradan, açıklama/simge buradan
const TYPES = [
  ['multirotor', 'Multikopter', 'Dört rotor; dikey kalkış, hassas konum tutma. ArduCopter.', 'quad'],
  ['hexarotor', 'Hexakopter', 'Altı rotor; daha yüksek taşıma ve yedeklilik. ArduCopter hexa.', 'hexa'],
  ['helikopter', 'Helikopter', 'Ana rotor + kuyruk rotoru. ArduCopter heli.', 'heli'],
  ['sabit_kanat', 'Sabit Kanat', 'Caymaz uçak; pistten kalkış, uzun menzil. ArduPlane.', 'plane'],
  ['vtol', 'VTOL', 'Uçak + dört dikey rotor (quadplane). ArduPlane.', 'vtol'],
  ['interceptor', 'INTERCEPTOR', '4 pervaneli tailsitter: kuyruk üstünde dikey kalkar, havada yatay uçar; ~400 km/h. ArduPlane quadplane tailsitter.', 'icept'],
  ['rover', 'Kara Aracı', 'Tekerlekli/paletli insansız kara aracı: zeminde sürüş, kalkış yok. ArduRover (Ackermann / diferansiyel).', 'rover'],   // §31
];
// §31 kara aracı sürüş biçimleri (sunucu DRIVES; oturum gövdesi `drive`)
const DRIVE_NAME = { ackermann: 'Ackermann', skid: 'Paletli / diferansiyel' };
const DRIVE_DESC = { ackermann: 'Ön tekerlekler döner (otomobil gibi); SITL rover modeli, azami 72 km/h.', skid: 'Sol / sağ taraf ayrı hızda döner, yerinde dönüş; SITL rover-skid, azami 14 km/h.' };
const isRoverType = type => type === 'rover';
const TYPE_NAME = Object.fromEntries(TYPES.map(([k, n]) => [k, n]));
const STATE_BADGE = { BASLIYOR: 'yellow', HAZIR: 'green', HATA: 'red', KAPANDI: 'gray' };
const STATE_TEXT = { BASLIYOR: 'Başlıyor', HAZIR: 'Hazır', HATA: 'Hata', KAPANDI: 'Kapandı' };
const COPTER_MODES = ['STABILIZE', 'ALT_HOLD', 'LOITER', 'POSHOLD', 'GUIDED', 'AUTO', 'RTL', 'LAND'];
const PLANE_MODES = ['MANUAL', 'FBWA', 'FBWB', 'CRUISE', 'TAKEOFF', 'AUTO', 'LOITER', 'RTL'];
const VTOL_MODES = [...PLANE_MODES, 'QSTABILIZE', 'QHOVER', 'QLOITER', 'QLAND'];
const ICEPT_MODES = ['QHOVER', 'QLOITER', 'GUIDED', 'FBWA', 'FBWB', 'CRUISE', 'AUTO', 'LOITER', 'RTL', 'QRTL', 'QLAND'];   // §25 tailsitter: dikey (Q) + yatay kipler
const isPlane = type => type === 'sabit_kanat' || type === 'vtol' || type === 'interceptor';
// Görsel model (§12): oturuma {id, orient} gönderilir (dahili için yalnız id); sahte kipte tam nesne (blob GLB adresi aynı sekmede geçerli)
const modelBody = (m, mock) => (m ? (mock ? { ...m } : { id: m.id, orient: String(m.id).startsWith('builtin:') ? undefined : m.orient }) : undefined);
const modesFor = type => (type === 'rover' ? ROVER_MODES : type === 'interceptor' ? ICEPT_MODES : type === 'vtol' ? VTOL_MODES : isPlane(type) ? PLANE_MODES : COPTER_MODES);
const f1 = v => (v == null || Number.isNaN(Number(v)) ? '—' : Number(v).toFixed(1));
const f0 = v => (v == null || Number.isNaN(Number(v)) ? '—' : String(Math.round(Number(v))));
const clock = sec => { sec = Math.max(0, Math.floor(Number(sec) || 0)); const hh = Math.floor(sec / 3600), mm = Math.floor(sec % 3600 / 60), ss = sec % 60; return `${hh ? `${hh}:` : ''}${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`; };
const copy = async (txt, what = 'Kopyalandı') => { try { await navigator.clipboard.writeText(txt); toast(what); } catch { toast('Kopyalanamadı; metni elle seçin', 'err'); } };
const svgIco = body => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
const TYPE_ICON = {
  quad: svgIco('<rect x="9.5" y="9.5" width="5" height="5" rx="1.2"/><path d="M9.5 9.5 6.6 6.6M14.5 9.5l2.9-2.9M9.5 14.5l-2.9 2.9M14.5 14.5l2.9 2.9"/><circle cx="5.2" cy="5.2" r="2.6"/><circle cx="18.8" cy="5.2" r="2.6"/><circle cx="5.2" cy="18.8" r="2.6"/><circle cx="18.8" cy="18.8" r="2.6"/>'),
  hexa: svgIco('<circle cx="12" cy="12" r="2.4"/><path d="M12 9.6V5.5M12 14.4v4.1M9.9 10.8 6.3 8.7M14.1 10.8l3.6-2.1M9.9 13.2l-3.6 2.1M14.1 13.2l3.6 2.1"/><circle cx="12" cy="4" r="1.6"/><circle cx="12" cy="20" r="1.6"/><circle cx="5" cy="8" r="1.6"/><circle cx="19" cy="8" r="1.6"/><circle cx="5" cy="16" r="1.6"/><circle cx="19" cy="16" r="1.6"/>'),
  heli: svgIco('<path d="M3 7h18M12 7v3"/><ellipse cx="11" cy="13" rx="4.5" ry="3"/><path d="M15.5 13h5l-2 2.5M20.5 13v-3M7 18h8"/>'),
  plane: svgIco('<path d="M12 3v18M4 13l8-3 8 3M8 20l4-2 4 2M12 3c1.5 0 2 2 2 4v3M12 3c-1.5 0-2 2-2 4v3"/>'),
  vtol: svgIco('<path d="M12 4v16M5 12l7-2 7 2M9 20l3-1.5 3 1.5"/><circle cx="6" cy="7" r="2"/><circle cx="18" cy="7" r="2"/><circle cx="6" cy="17" r="2"/><circle cx="18" cy="17" r="2"/>'),
  // §25 INTERCEPTOR: puro gövde (dikey), X kanat, 4 çekici pervane + hız çizgileri
  icept: svgIco('<path d="M12 2.5c1.3 1.4 1.8 3 1.8 5v11.5h-3.6V7.5c0-2 .5-3.6 1.8-5Z"/><path d="M10.2 13 5 17.5M13.8 13l5.2 4.5M10.2 16 7.5 21M13.8 16l2.7 5"/><path d="M3.5 15.8h3M17.5 15.8h3"/><path d="M2 7h3M2 10h2"/>'),
  // §31 kara aracı: yandan 4×4 gövde (kabin + kaput), iki büyük teker, sensör direği + kafa
  rover: svgIco('<path d="M2.5 15.5v-3.2l2.3-.8 2-3.5h7.4l2.3 3.5h3.6c.9 0 1.4.6 1.4 1.4v2.6"/><path d="M8 11.5h7.4M11.3 8v3.5"/><circle cx="6.5" cy="16.5" r="2.4"/><circle cx="17.5" cy="16.5" r="2.4"/><path d="M8.9 16.5h6.2"/><path d="M13.3 8V4.5"/><rect x="11.8" y="2.6" width="3" height="1.9" rx=".5"/>'),
};
// Kontrol düzeni simgeleri (§13.1): klasik (düz kanat + T-kuyruk), elevon (delta kanat, arka kenar iki yüzey), V-kuyruk (düz kanat + V)
const LAYOUT_ICON = {
  classic: svgIco('<path d="M12 3v17M3 11l9-2 9 2M8 20l4-1.5 4 1.5M12 15v5"/><path d="M9 11.5v1.5M15 11.5v1.5" stroke-dasharray="1 1"/>'),
  elevon: svgIco('<path d="M12 3 3 19h18L12 3z"/><path d="M5.5 19l3-2M18.5 19l-3-2"/><path d="M12 9v10"/>'),
  vtail: svgIco('<path d="M12 3v14M3 11l9-2 9 2"/><path d="M12 17l-5 4M12 17l5 4"/><path d="M8.5 19.6l1-1.3M15.5 19.6l-1-1.3"/>'),
};
// Kalkış yöntemi simgeleri (§13): tekerlekli (uçak + tekerlekler), rampa (eğik ray + kızak), araç üstü (pickup + uçak)
const LAUNCH_ICON = {
  wheels: svgIco('<path d="M3 11h18l-3-3H8l-5 3Z"/><path d="M12 8V5h4"/><path d="M7 11v4M16 11v4"/><circle cx="7" cy="17" r="2"/><circle cx="16" cy="17" r="2"/><path d="M3 21h18"/>'),
  ramp: svgIco('<path d="M3 19 19 7"/><path d="M5 19h14"/><path d="M8 19v-3.5M13 19v-7"/><rect x="12" y="7" width="5" height="3" rx=".6" transform="rotate(-37 14.5 8.5)"/><circle cx="6" cy="21" r="1.4"/><circle cx="17" cy="21" r="1.4"/>'),
  vehicle: svgIco('<path d="M2 16h20v-4h-6l-2-3H9v3H2Z"/><circle cx="6.5" cy="18.5" r="2"/><circle cx="17.5" cy="18.5" r="2"/><path d="M8 9h11l-3-2.2H11L8 9Z"/><path d="M13.5 6.8V5"/>'),
  // §27 INTERCEPTOR fırlatıcıları: 4'lü (2×2 hücre, açık kapak), 8'li (4×2), yerden tekli (sehpa + tüp), el fırlatıcısı (omuz tüpü + ekran)
  pod4: svgIco('<rect x="5" y="8" width="14" height="11" rx="1"/><path d="M12 8v11M5 13.5h14"/><path d="M5.5 8 3.5 4.5h5L10 8"/><path d="M8 19v2M16 19v2"/><path d="M15.5 4.2v2.3M14.3 5.4h2.4"/>'),
  pod8: svgIco('<rect x="2.5" y="9" width="19" height="10" rx="1"/><path d="M7.25 9v10M12 9v10M16.75 9v10M2.5 14h19"/><path d="M3 9 1.8 5.5h4L7 9"/><path d="M5 19v2M19 19v2"/>'),
  tube: svgIco('<rect x="9" y="5" width="6" height="11" rx="1"/><path d="M9 5 7 2.5h5"/><path d="M12 16l-5 5M12 16l5 5M12 16v5"/><path d="M15 9h2v3h-2"/>'),
  handheld: svgIco('<circle cx="6" cy="5" r="2"/><path d="M6 7v6l-2 8M6 13l2 8M6 9l4 1"/><path d="m9 11 11-6.5 1.5 2.6-11 6.5z"/><path d="M12 12.5l.8 2.6"/><rect x="13.5" y="5.5" width="3" height="2.2" rx=".4" transform="rotate(-30 15 6.6)"/>'),
};

// ======================================================================
// Giriş: #/drone/sim[?mock=1] → sihirbaz + açık oturumlar · #/drone/sim/<id>[?mock=1] → oturum ekranı
// ======================================================================
export async function render(view, params, ctx, extra = {}) {
  const joined = (params || []).join('/');
  const [path, qs] = joined.split('?');
  const sp = new URLSearchParams(qs || '');
  const mock = extra.mock || sp.get('mock') === '1';
  if (mock && sp.get('bank')) MOCK.bankDeg = Number(sp.get('bank')) || null;   // teşhis (§22 FPV görüntüleri): sahte seyir dönüşünde yatış açısı (°); yarıçap V²/(g·tan)
  const parts = path.split('/').filter(Boolean);   // ['sim', '<id>'] · ['sim', 'match', '<id>'] (§33 bekleme salonu)
  const sid = parts[1] || null;
  const canWrite = !!(ctx.user?.master || extra.m?.can?.command || (ctx.user?.write_modules || []).includes('drone'));
  const backend = mock ? mockBackend(ctx) : restBackend();
  const head = extra.head || (sub => h('div', { class: 'page-head' }, h('div', { class: 'page-head-t' }, h('h1', null, 'Uçuş Simülatörü'), sub ? h('div', { class: 'sub' }, sub) : null)));
  if (sid === 'match' && parts[2]) return renderLobby(view, ctx, parts[2], { head });   // §33 karşılaşma bekleme salonu (davet bildirimi buraya getirir)
  if (sid) return renderSession(view, ctx, backend, sid, { mock, canWrite, netsim: parseNetsim(sp.get('netsim')), rigdiag: sp.get('rigdiag') === '1', matchId: sp.get('match') || null });   // ?match=<id>: §33 karşılaşma oyuncu oturumu   // ?rigdiag=1: düzenek yüzey teşhis kutusu (§13; konsolda her zaman window.__fsRig())
  return renderWizard(view, ctx, backend, head, { mock, canWrite, openNew: sp.get('new') === '1', tab: sp.get('tab'), preset: sp.get('preset'), simulate: simulateParam(sp.get('simulate')) });   // ?simulate=<log>: §8.5 "Simüle et" (Saha yönetimi / Uçuş Logu Analizi) — sihirbaz o log sabit, Dünya adımından · ?new=1: "Yeni Simülasyon Başlat" penceresi açık gelir · ?tab=saved|runs|open|clients · ?preset=free|<id> (§27)
}

// Ağ bozulması test kipi (§5 titreme teşhisi): #/drone/sim/<id>?netsim=jitter30,loss5,delay40 — gelen her `tele` karesi delay + U(0, 2·jitter) ms
// gecikmeyle (sıra bozulabilir) iletilir, %loss'u düşürülür. Yalnız bu parametreyle açılır; ayrıca window.__fsSim (3B nesnesi: netStats/motionStats) verilir.
function parseNetsim(s) {
  if (!s) return null;
  const o = { jitter: 0, loss: 0, delay: 0 };
  for (const part of String(s).split(',')) { const m = /^(jitter|loss|delay)(\d+(?:\.\d+)?)$/.exec(part.trim()); if (m) o[m[1]] = Number(m[2]); }
  return o;
}

// ======================================================================
// Arka uç erişimi: REST ya da mock. Ortak yüz: meta(), sessions(), session(id), create(body), end(id), cmd(id, name, params), socket(id, handlers)
// ======================================================================
function restBackend() {
  return {
    mock: false,
    meta: () => api.get(`${API}/meta`),
    sessions: () => api.get(`${API}/sessions`),
    session: id => api.get(`${API}/sessions/${encodeURIComponent(id)}`),
    create: body => api.post(`${API}/sessions`, body),
    // §8.5: varsayılan YALNIZ simülatör kayıtları; { id } "Simüle et" girişi (o log, kaynağı ne olursa olsun; yetkiyle kesişim)
    logs: ({ q, id } = {}) => { const p = new URLSearchParams(); if (q) p.set('q', q); if (id != null) p.set('id', id); const qs = p.toString(); return api.get(`${API}/logs${qs ? `?${qs}` : ''}`); },
    runReplay: id => api.post(`${API}/runs/${encodeURIComponent(id)}/replay`, {}),   // §8.5 kaydı doğrudan izle: kaydedilen ayarlarla kayıttan oynatma oturumu
    replay: id => api.get(`${API}/sessions/${encodeURIComponent(id)}/replay`),
    replayChunk: (id, k) => api.get(`${API}/sessions/${encodeURIComponent(id)}/replay/${k}`),   // uzun kayıt parçası (§8.3)
    end: id => api.del(`${API}/sessions/${encodeURIComponent(id)}`),
    cmd: (id, name, params = {}) => api.post(`${API}/sessions/${encodeURIComponent(id)}/cmd`, { name, params }),
    g3dKey: () => api.get(`${API}/g3d-key`).then(r => r.key),   // Google Map Tiles anahtarı (no-store; yalnız dünya kurulurken)
    drones: () => api.get(`${API}/drones`),   // §14: sihirbaz "Dron kaydı (isteğe bağlı)" — Dron Envanteri
    // §18: özet rapor (Bitir'de kapatmadan önce), rapor geçmişi, tek rapor, metin paylaşımı
    summary: id => api.get(`${API}/sessions/${encodeURIComponent(id)}/summary`),
    reports: (limit = 20) => api.get(`${API}/reports?limit=${limit}`),
    report: id => api.get(`${API}/reports/${encodeURIComponent(id)}`),
    shareReport: (id, text) => api.post(`${API}/reports/${encodeURIComponent(id)}/share`, { text }),
    // §21: simülasyon kayıtları tablosu (filtre/sıralama/sayfa sorgu dizesi) + silme
    runs: F => api.get(`${API}/runs${runsQuery(F) ? `?${runsQuery(F)}` : ''}`),
    runStats: (days = 30) => api.get(`${API}/runs/stats?days=${days}`),   // sayfa üstü 4 bilgi kutusu
    runDelete: id => api.del(`${API}/runs/${encodeURIComponent(id)}`),
    // §27 kayıtlı simülasyonlar: liste, pilotlar, oluştur/güncelle/sil, kayıtlı ayarla başlat (sihirbazsız)
    presets: () => api.get(`${API}/presets`),
    presetPilots: () => api.get(`${API}/presets/pilots`),
    presetCreate: body => api.post(`${API}/presets`, body),
    presetUpdate: (id, body) => api.put(`${API}/presets/${encodeURIComponent(id)}`, body),
    presetDelete: id => api.del(`${API}/presets/${encodeURIComponent(id)}`),
    presetStart: (id, body = {}) => api.post(`${API}/presets/${encodeURIComponent(id)}/start`, body),
    socket: (id, handlers) => wsClient(id, handlers),
    href: id => `#/drone/sim${id ? `/${id}` : ''}`,
  };
}

// WS istemcisi: hello/tele/event/state/end; 10 sn ping; kopunca üstel geri çekilme (0.5 → 10 sn); 4403/4404 kalıcı hata.
function wsClient(id, handlers) {
  let ws = null, closed = false, retry = 0, pingIv = 0, timer = 0;
  const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws/drone/sim/${encodeURIComponent(id)}`;
  const open = () => {
    if (closed) return;
    handlers.status?.(retry ? 'reconnect' : 'connecting');
    try { ws = new WebSocket(url); } catch (err) { handlers.fatal?.(err.message); return; }
    ws.onopen = () => { retry = 0; handlers.status?.('open'); pingIv = setInterval(() => send({ t: 'ping' }), 10000); };
    ws.onmessage = e => { let msg; try { msg = JSON.parse(e.data); } catch { return; } handlers.message?.(msg); };
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
  const send = obj => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj)); };
  open();
  return { send, close: () => { closed = true; clearTimeout(timer); clearInterval(pingIv); try { ws?.close(); } catch { /* */ } } };
}

// ======================================================================
// Simülasyon sayfası (§21): üstte 4 bilgi kutusu (HEPGO pano kalıbı: son 30 gün simülasyon · uçuş süresi · çarpışma oranı · açık oturum;
// tıklanınca ilgili sekme/filtre) · sekme çubuğu satırının SAĞINDA kapsül [Excel · + Yeni Simülasyon] (Excel'i listexport.js `.module-toolbar .module-pills`
// kalıbıyla aynı kapsüle koyar) · üç sekme (HEPGO .seg-tabs kalıbı, sayaç rozetli):
// **Simülasyon Kayıtları** (varsayılan; tablo) · **Açık Oturumlar** (devam et / bitir listesi + §17 yarım kayıt şeridi) · **CAYSIM İstemcileri**.
// Sekme seçimi `#/drone/sim?tab=runs|open|clients` ile gelir ya da localStorage (caymaz.fs.tab) ile hatırlanır (hash'e yazılmaz: yeniden çizim yok).
// Sihirbaz (Kip, tip, kalkış, model, merkez, dron kaydı, dünya, kayıt seçenekleri) ayrı pencerede: wizardModal.
// ======================================================================
// §27: ilk sekme "Kayıtlı Simülasyonlar" (üç sütunlu ekran: Serbest Uçuş + kayıtlılar · uçuş kartları · özet + dönen 3B model); tablo ikinci sekmede
const SIM_TABS = [['saved', 'Kayıtlı Simülasyonlar'], ['runs', 'Simülasyon Kayıtları'], ['matches', 'Karşılaşmalar'], ['open', 'Açık Oturumlar'], ['clients', 'CAYSIM İstemcileri']];   // §33 Karşılaşmalar
// Sayaç rozetli sekme çubuğu (ui.js segmented({tabs:true}) ile aynı sınıflar; rozet için el yapımı). → { el, set(key), count(key, n) }
function simTabBar(options, active, onChange) {
  const badges = {};
  const btns = options.map(([key, label]) => {
    badges[key] = h('span', { class: 'fs-tab-n', 'data-n': '0' }, '0');
    return h('button', { type: 'button', role: 'tab', 'data-tab': key, class: key === active ? 'on' : '', 'aria-selected': key === active ? 'true' : 'false',
      onclick: () => { set(key); onChange(key); } }, label, badges[key]);
  });
  const set = key => btns.forEach(b => { const on = b.dataset.tab === key; b.classList.toggle('on', on); b.setAttribute('aria-selected', on ? 'true' : 'false'); });
  const count = (key, n) => { const bd = badges[key]; if (!bd) return; bd.textContent = String(n); bd.dataset.n = String(n); };
  return { el: h('div', { class: 'module-tabs fs-tabs' }, h('div', { class: 'seg seg-tabs', role: 'tablist' }, btns)), set, count };
}

async function renderWizard(view, ctx, be, head, { mock, canWrite, openNew = false, tab = null, preset = null, simulate = null }) {
  let meta;
  try { meta = await be.meta(); } catch (err) {
    clear(view, head('Uçuş Simülatörü'), h('div', { class: 'card empty' }, h('p', null, h('b', null, 'Simülatör servisi yanıt vermedi.')), h('p', { class: 'small muted' }, err.message),
      h('p', { class: 'small muted' }, 'Arka uç hazır değilse arayüzü sahte veriyle denemek için adrese ?mock=1 ekleyin: ', h('a', { href: '#/drone/sim?mock=1' }, '#/drone/sim?mock=1'))));
    return;
  }
  const centers = meta.centers || [];
  const limits = meta.limits || {};

  // ---------- sekmeler ----------
  const tabKeys = SIM_TABS.map(([k]) => k);
  // Sekme tercihi §27 ile yeni anahtarda (fs.tab2): yeni ekran herkese bir kez varsayılan gelir
  let active = tabKeys.includes(tab) ? tab : (tabKeys.includes(pref('fs.tab2', 'saved')) ? pref('fs.tab2', 'saved') : 'saved');
  const panes = Object.fromEntries(tabKeys.map(k => [k, h('div', { class: 'fs-pane', 'data-pane': k, role: 'tabpanel' })]));
  const showPane = key => { active = key; Object.entries(panes).forEach(([k, p]) => { p.hidden = k !== key; }); setPref('fs.tab2', key); };
  const tabs = simTabBar(SIM_TABS, active, showPane);

  // ---------- açık oturumlar (sekme: Açık Oturumlar; rozet = açık oturum sayısı) ----------
  const openBox = h('div', { class: 'fs-open-box' });
  const drawOpen = async () => {
    let rows = [];
    try { rows = await be.sessions(); } catch { rows = []; }
    tabs.count('open', rows.length);
    if (!rows.length) { clear(openBox, h('div', { class: 'card empty fs-open-empty' }, h('p', null, 'Açık oturum yok.'), h('p', { class: 'small muted' }, canWrite ? '"+ Yeni Simülasyon" ile oturum açın; açık oturumlar burada "Devam et / Bitir" ile listelenir.' : 'Açık oturumlar burada listelenir.'))); return; }
    clear(openBox, h('div', { class: 'card card-pad fs-open no-collapse' }, h('h3', null, tr('Açık oturumlar ({n})', { n: rows.length })),
      h('div', { class: 'fs-open-list' }, rows.map(s => h('div', { class: 'fs-open-row' },
        h('div', { class: 'fs-open-main' }, h('b', null, TYPE_NAME[s.type] || s.type), s.mode === 'replay' ? h('span', { class: 'badge purple' }, 'Kayıt') : null,
          s.client ? h('span', { class: 'badge blue', title: tr('CAYSIM istemcisi açtı: {name}', { name: s.client.name }) }, 'CAYSIM') : null,
          h('span', { class: `badge ${STATE_BADGE[s.state] || 'gray'}` }, STATE_TEXT[s.state] || s.state),
          h('div', { class: 'small muted' }, [s.mode === 'replay' ? s.replay?.file_name : s.center?.name, s.owner?.name, s.created_at ? fmtDateTime(s.created_at) : null, s.udp_port ? `UDP ${s.udp_port}` : null].filter(Boolean).join(' · '))),
        h('div', { class: 'pill-group' },
          h('a', { class: 'btn sm primary', href: be.href(s.id) }, 'Devam et'),
          canWrite ? h('button', { class: 'btn sm danger', onclick: async () => {
            if (!await confirmDialog('Oturumu bitir', s.mode === 'replay' ? 'Kayıttan oynatma oturumu kapatılsın mı?' : 'Simülatör oturumu kapatılsın mı? SITL süreci ve UDP portu kapanır.', { okLabel: 'Bitir', danger: true })) return;
            await be.end(s.id); toast('Oturum kapatıldı'); drawOpen(); drawStats();
          } }, 'Bitir') : null))))));
  };

  // ---------- sayfa: Yeni Simülasyon + sekmeler ----------
  let wizardOpen = false, savedSel = null;
  // preset: {} yeni · { mode:'replay', log } Oynat · { edit: kayıtlı } Düzenle · { quick: kayıtlı } Başlat (§27; yalnız özet + geri sayım)
  const openWizard = async (preset = {}) => {
    if (wizardOpen) return;
    wizardOpen = true;
    saved?.suspend3d();   // §27 tek WebGL bağlamı: sihirbaz önizlemesi açılırken dönen modelin stüdyo bağlamı bırakılır
    try {
      await wizardModal({ be, meta, mock, canWrite, preset, user: ctx.user, onClosed: () => { wizardOpen = false; wizardOnClosed(); },
        onSaved: p => { if (p?.id != null) { savedSel = p.id; tabs.set('saved'); showPane('saved'); } } });   // kapanışta (wizardOnClosed) yeni/güncellenen kayıt seçili gelir
    } catch (err) { wizardOpen = false; saved?.resume3d(); toastError(err); }
  };
  // §8.5 simülasyon kaydını İZLE: sihirbaz açılmaz — sunucu kaydın ayarlarıyla oturum açar, hazırlık kartı → oturum ekranı
  let playing = false;
  const playRun = async r => {
    if (playing || wizardOpen) return;
    playing = true;
    saved?.suspend3d();
    let ok = false;
    try { ok = await directReplay({ be, mock, run: r }); } catch (err) { toastError(err); } finally { playing = false; if (!ok) saved?.resume3d(); }
  };
  const pending = mock || !canWrite ? null : pendingCard(tr);   // §17: yarım ekran kayıtları → Paylaş / Sil ("Açık Oturumlar" sekmesinde, listenin altında)
  const runs = mock ? null : runsTable({ be, tr, canWrite, user: ctx.user,
    onPlay: r => playRun(r),   // §8.5 sihirbazsız: kaydedilen ayarlarla doğrudan izleme
    onReport: async r => { const sum = await be.report(r.summary_event_id); await showReport(sum, { tr, be, canWrite }); } });
  const clients = mock ? null : clientsCard({ canWrite, onCount: n => tabs.count('clients', n) });   // CAYSIM istemcileri (docs/caysim-api.md)
  const matches = mock ? null : matchesCard({ onCount: n => tabs.count('matches', n) });   // §33 karşılaşmalar (rozet: süren)
  // §27 Kayıtlı Simülasyonlar: [Serbest Uçuş + kayıtlılar] · [uçuş kartları] · [özet + dönen 3B model]
  const saved = mock ? null : savedScreen({ be, tr, user: ctx.user, canWrite, initial: preset,
    onStart: p => openWizard({ quick: p }), onEdit: p => openWizard({ edit: p }), onNew: () => openWizard(),
    onPlay: r => playRun(r),   // §8.5 uçuş kartı Oynat: doğrudan izleme
    onReport: async r => { const sum = await be.report(r.summary_event_id); await showReport(sum, { tr, be, canWrite }); },
    onTable: () => { tabs.set('runs'); showPane('runs'); } });
  const mockNote = what => h('div', { class: 'card empty' }, h('p', { class: 'small muted' }, tr('Sahte veri kipinde {what} yok.', { what })));
  clear(panes.saved, saved ? saved.el : mockNote('kayıtlı simülasyonlar'));
  clear(panes.runs, runs ? runs.el : mockNote('simülasyon kayıtları tablosu'));
  clear(panes.open, openBox, pending ? pending.el : null);
  clear(panes.clients, clients ? clients.el : mockNote('CAYSIM istemci listesi'));
  clear(panes.matches, matches ? matches.el : mockNote('karşılaşmalar'));
  // "+ Yeni Simülasyon" sekme hizasında, sağda, kapsül içinde; sınır notu ("En çok N eşzamanlı oturum…") sayfada görünmez, düğme ipucunda kalır
  const newBtn = h('button', { class: 'btn primary fs-new-sim', type: 'button', disabled: !canWrite, onclick: () => openWizard(),
    title: canWrite
      ? tr('En çok {n} eşzamanlı oturum · oturum süresi {m} dk', { n: limits.max_sessions ?? '—', m: limits.max_minutes ?? '—' })
      : tr('Oturum açmak için Dron Yönetimi yazma izni gerekir; açık oturumları ve kayıtları izleyebilirsiniz.') }, '+ Yeni Simülasyon');
  // §33 "Yeni Karşılaşma": Yeni Simülasyon ile aynı sihirbaz; radar / EO / yer kontrol yok, Halkalar + Davet et, sonunda yalnız Başlat → bekleme salonu
  const matchBtn = h('button', { class: 'btn fs-new-match', type: 'button', disabled: !canWrite || mock, onclick: () => openWizard({ match: true }),
    title: mock ? tr('Sahte veri kipinde karşılaşma yok.') : canWrite ? tr('Çok oyunculu halka yarışı: kullanıcıları davet edin, herkes gelince başlar') : tr('Oturum açmak için Dron Yönetimi yazma izni gerekir; açık oturumları ve kayıtları izleyebilirsiniz.') }, '+ Yeni Karşılaşma');
  // .module-toolbar > .module-pills: listexport.js Excel düğmesini bu kapsüle ekler (CSS order ile Yeni Simülasyon'un soluna)
  const actions = h('div', { class: 'module-toolbar fs-tabs-actions' }, h('div', { class: 'pill-group module-pills' }, matchBtn, newBtn));
  // ---------- üst bilgi kutuları (GET /runs/stats; sahte kipte sahte sayılar) ----------
  const stats = statStrip();
  stats.classList.add('fs-stats');
  const statsTab = (key, fn) => { tabs.set(key); showPane(key); fn?.(); panes[key].scrollIntoView?.({ block: 'nearest' }); };
  const drawStats = async () => {
    let st;
    try { st = await be.runStats(30); } catch { st = null; }
    if (!st) { stats.hidden = true; return; }
    stats.hidden = false;
    const lastRun = st.last_run?.started_at ? fmtDateTime(st.last_run.started_at) : null;
    stats.set([
      { icon: 'documents', label: tr('Simülasyon · son {d} gün', { d: st.days }), value: st.total, sub: tr('toplam {n} kayıt', { n: st.total_all }), key: 'runs',
        onClick: () => statsTab('runs', () => runs?.setPeriod('30d')) },
      { icon: 'flightlog', label: tr('Uçuş süresi · son {d} gün', { d: st.days }), value: st.flight_s ? fmtDuration(st.flight_s) : '0 dk', sub: st.total ? tr('ortalama {t}', { t: fmtDuration(st.avg_s) }) : tr('Henüz simülasyon yok'), key: 'time',
        onClick: () => statsTab('runs', () => runs?.setPeriod('30d')) },
      { icon: 'warning', label: tr('Çarpışma oranı · son {d} gün', { d: st.days }), value: `${st.crash_rate}%`, tone: st.crash ? 'alert' : 'ok',
        sub: st.last_crash_at ? tr('Son çarpışma: {t}', { t: fmtDateTime(st.last_crash_at) }) : tr('Henüz çarpışma yok'), key: 'crash',
        onClick: () => statsTab('runs', () => { runs?.setPeriod('30d'); runs?.setFilter({ result: 'carpisma' }); }) },
      { icon: 'drone', label: tr('Açık oturum'), value: st.open_sessions, tone: st.open_sessions ? 'ok' : 'muted', sub: lastRun ? tr('Son simülasyon: {t}', { t: lastRun }) : tr('Henüz simülasyon yok'), key: 'open',
        onClick: () => statsTab('open') },
    ]);
  };
  clear(view, head(mock ? 'Uçuş Simülatörü · sahte veri kipi (arka uç yok)' : 'Uçuş Simülatörü · SITL + Mission Planner köprüsü, 3B dünya'),
    mock ? h('div', { class: 'alert warn fs-mock-note' }, 'Sahte veri kipi: oturum sunucuda açılmaz; telemetri tarayıcıda üretilir. Gerçek kullanım için adresten ?mock=1 kaldırın.') : null,
    stats,
    h('div', { class: 'fs-tabs-row' }, tabs.el, actions),
    Object.values(panes));
  showPane(active);
  drawOpen();
  drawStats();
  const wizardOnClosed = () => { drawOpen(); runs?.refresh(); pending?.refresh(); drawStats(); saved?.resume3d(); saved?.refresh(savedSel); savedSel = null; matches?.refresh(); };
  if (simulate != null && canWrite) {   // §8.5 "Simüle et": adres sadeleşir (yeniden yüklemede pencere tekrar açılmasın), sihirbaz o log sabit
    try { history.replaceState(null, '', location.hash.replace(/([?&])simulate=[^&]*&?/, '$1').replace(/[?&]$/, '')); } catch { /* */ }
    openWizard({ mode: 'replay', log: simulate, pinned: true });
  } else if (openNew && canWrite) openWizard();
  if (mock && !centers.length) toast('Sahte kipte merkez yok', 'err');
}

// ======================================================================
// §8 ön hazırlık kartı: oturum ekranına geçmeden ÖNCE sunucu HAZIR (log ayrıştırma % / SITL) → kareler indirilir → dünya verisi (arazi/Google
// karoları) önizleme örneğiyle ön yüklenir (aynı /terrain + /osm + karolar; Google kök tileset havuzda) → true. İptal/hata oturumu kapatır → false.
// Sihirbazın Başlat'ı (önizleme örneğiyle) ve §8.5 kaydı doğrudan izleme (önizlemesiz; dünya oturum ekranında kurulur) ortak.
// ======================================================================
async function prepareSessionCard(s, { be, mock, world, preview = null, setTap = () => {}, title: titleOverride = null }) {
  const rp = s.mode === 'replay';
  const steps = [['server', rp ? tr('Log ayrıştırılıyor') : tr('SITL başlatılıyor')], ...(rp ? [['frames', tr('Kareler indiriliyor')]] : []), ['world', tr('Dünya hazırlanıyor')]];
  const R = {};
  const list = h('div', { class: 'fs-prep-steps' }, steps.map(([key, label]) => {
    const ico = h('i', { class: 'fs-prep-ico wait' }), pct = h('span', { class: 'fs-prep-pct mono' }, ''), sub = h('div', { class: 'small muted fs-prep-sub' }, ''), bar = h('div', { class: 'fs-prep-bar' }, h('i'));
    const row = h('div', { class: 'fs-prep-step', 'data-step': key }, h('div', { class: 'fs-prep-row' }, ico, h('span', { class: 'fs-prep-lbl' }, label), pct), bar, sub);
    R[key] = { row, ico, pct, sub, bar };
    return row;
  }));
  const setStep = (key, state, pct = null, text = null) => {
    const r = R[key]; if (!r) return;
    r.ico.className = `fs-prep-ico ${state}`; r.row.dataset.state = state;
    if (pct != null) { r.pct.textContent = `%${Math.round(pct)}`; r.bar.hidden = false; r.bar.firstChild.style.width = `${Math.max(0, Math.min(100, pct))}%`; }
    else if (state === 'ok') { r.pct.textContent = '✓'; r.bar.hidden = true; }
    else if (state === 'err') { r.pct.textContent = '✗'; r.bar.hidden = true; }
    else r.bar.hidden = true;
    if (text != null) r.sub.textContent = text;
  };
  Object.keys(R).forEach(k => { R[k].bar.hidden = true; });
  const title = titleOverride || (rp ? `${s.replay?.file_name || ''}` : `${TYPE_NAME[s.type] || s.type} · ${s.center?.name || ''} · ${tr({ real: 'Gerçek arazi', google3d: 'Google 3B (fotogerçekçi)', procedural: 'Prosedürel' }[world.mode] || world.mode)}`);
  let cancelled = false, finished = false, closeFn = null, cancelBtn = null;
  const closed = new Promise(resolve => {
    const m = modal({ title: tr(rp ? 'Kayıt hazırlanıyor' : 'Simülatör hazırlanıyor'), body: h('div', { class: 'fs-prep' }, h('div', { class: 'small muted fs-prep-title' }, title), list, h('p', { class: 'small muted fs-prep-note' }, tr('Her şey hazır olunca oturum ekranı açılır.'))),
      actions: [{ label: tr('İptal'), class: 'danger', onClick: () => { cancelled = true; } }], onClose: () => { if (!finished) cancelled = true; resolve(); } });
    closeFn = m.close; cancelBtn = m.el.querySelector('.modal-foot .btn');
  });
  const progPct = p => (p.stage === 'g3d' ? p.pct : p.stage === 'elev' ? 10 + 30 * (p.done / Math.max(1, p.total)) : p.stage === 'img' ? 40 + 45 * (p.done / Math.max(1, p.total)) : p.stage === 'osm' ? 90 : p.stage === 'plan' ? 5 : null);
  const progText = p => (p.stage === 'g3d' ? tr('Google 3B karoları yükleniyor… %{p}', { p: p.pct ?? 0 }) : p.stage === 'elev' ? tr('Yükseklik karoları {d}/{n}', { d: p.done, n: p.total }) : p.stage === 'img' ? tr('Uydu karoları {d}/{n}', { d: p.done, n: p.total }) : p.stage === 'osm' ? tr('Harita verileri (OSM) alınıyor…') : tr('Arazi planı alınıyor…'));
  let cur = 'server';
  const run = async () => {
    // 1) sunucu HAZIR: kayıtta ayrıştırma yüzdesi (ReplaySession progress), canlıda SITL açılışı — GET /sessions/{id} yoklaması
    setStep('server', 'run', rp ? (s.replay?.progress ?? 0) : null, rp ? (s.replay?.frames ? tr('Önbellekten') : '') : tr('SITL süreci başlıyor; ilk kalp atışı bekleniyor…'));
    let g = s;
    const t0 = Date.now();
    while (!cancelled && g.state === 'BASLIYOR') {
      await sleep(mock ? 50 : 600);
      g = await be.session(s.id);
      setStep('server', 'run', rp ? (g.replay?.progress ?? 0) : null, rp ? '' : tr('SITL başlıyor… {s} sn', { s: Math.round((Date.now() - t0) / 1000) }));
    }
    if (cancelled) return false;
    if (g.state !== 'HAZIR') { setStep('server', 'err', null, g.sitl?.error || tr('Hata')); return false; }
    Object.assign(s, g);
    setStep('server', 'ok', null, rp ? tr('{n} kare · {d}', { n: g.replay?.frames, d: fmtDuration(g.replay?.duration_s) }) : tr('SITL hazır (tcp {p})', { p: g.sitl?.port ?? '—' }));
    // 2) kareler (gzip JSON) → oturum ekranına devredilir
    let data = null;
    if (rp) {
      cur = 'frames'; setStep('frames', 'run');
      data = await be.replay(s.id);
      if (cancelled) return false;
      REPLAY_STASH.set(String(s.id), data);
      setStep('frames', 'ok', null, tr('{n} kare · {d}', { n: data.n, d: fmtDuration(data.duration_s) }));
    }
    // 3) dünya verisi: önizleme örneği kaydın kalkış noktasına (ya da merkeze) taşınır → /terrain + /osm + karolar indirilir (sunucu ve tarayıcı
    //    önbelleği ısınır; Google kök tileset havuzda kalır) — oturum ekranı aynı veriyi anında kurar
    cur = 'world'; setStep('world', 'run', world.mode === 'procedural' ? null : 0);
    const home = rp ? (g.replay?.home || g.center) : g.center;
    if (preview && home && home.lat != null) {
      const w = { ...world };
      if (rp && data) { const need = fitWorldSize(data, home); if (need > (Number(w.size_m) || 0)) w.size_m = need; }
      setTap(p => { if (p.stage !== 'done') setStep('world', 'run', progPct(p), progText(p)); });
      try { await preview.setOrigin(home.lat, home.lon, w, home.alt); } finally { setTap(null); }
      if (cancelled) return false;
      const info = preview.terrainInfo;
      setStep('world', 'ok', null, info?.real ? tr('Gerçek arazi · yükseklik {a}…{b} m · ev {h} m MSL', { a: f0(info.hmin), b: f0(info.hmax), h: f0(info.homeElev) }) : info?.google ? tr('Google 3B (fotogerçekçi) · ev {h} m MSL', { h: f0(info.homeElev) }) : tr('Prosedürel dünya: tohumlu rastgele arazi, binalar ve ağaçlar.'));
    } else setStep('world', 'ok');
    return !cancelled;
  };
  let ok = false;
  try { ok = await run(); } catch (err) { setStep(cur, 'err', null, err?.message || String(err)); ok = false; }
  setTap(null);
  if (ok && !cancelled) { finished = true; closeFn?.(); return true; }
  if (!cancelled) { if (cancelBtn) cancelBtn.textContent = tr('Kapat'); await closed; }   // hata: kart açık kalır, kullanıcı kapatır
  REPLAY_STASH.delete(String(s.id));
  be.end(s.id).catch(() => {});
  closeFn?.();
  return false;
}

// ======================================================================
// §8.5 Simülasyon kaydını İZLE (sihirbazsız): POST /runs/{id}/replay — sunucu kaydın oynatılabilir logunu oturumun KAYDEDİLMİŞ ayarlarıyla
// (dünya kipi, saat, hava, rüzgâr, sis, pist; kalkış/rampa yön-açı-fırlatıcı; görsel model; kamera türü; hedefler, yer kontrol sahası ve güç
// kaydın canlı oturumundan) açar → hazırlık kartı (ayrıştırma % + kareler) → oturum ekranı. Gösterge tasarımı kullanıcının kalıcı tercihidir.
// Çağrı kullanıcı tıklaması içinde başlar: tam ekran + (kayıt açıksa) ekran paylaşımı izni sihirbazın Başlat'ı ile aynı.
// ======================================================================
async function directReplay({ be, mock, run }) {
  enterFullscreen();
  if (!mock && recPrefs.on) { const { stream, reason } = await acquireDisplayStream(); stashStream(stream); if (!stream && reason === 'denied') toast(tr('Ekran paylaşımı reddedildi; 3B sahne + HUD kaydedilecek (panel kayda girmez)')); }
  const geriAl = () => { takeStashedStream()?.getTracks().forEach(t => t.stop()); exitFullscreen(); };
  let s;
  try { s = await be.runReplay(run.id); } catch (err) {
    const msg = { 403: tr('Bu kaydı oynatma yetkiniz yok'), 404: tr('Simülasyon kaydı bulunamadı'), 409: err?.message || tr('Oturum sınırı doldu; açık bir oturumu bitirin') }[err?.status];
    toast(msg || err.message, 'err');
    geriAl();
    return false;
  }
  const w = s.world || {};
  const title = [run.started_at ? fmtDateTime(run.started_at) : null, s.replay?.file_name,
    tr({ real: 'Gerçek arazi', google3d: 'Google 3B (fotogerçekçi)', procedural: 'Prosedürel' }[w.mode] || w.mode || ''), w.weather ? tr(WEATHER_LABELS[normWeather(w.weather)]) : null].filter(Boolean).join(' · ');
  if (!await prepareSessionCard(s, { be, mock, world: w, title })) { geriAl(); return false; }
  toast(tr('Kayıt kaydedilen ayarlarla açıldı'));
  location.hash = be.href(s.id);
  return true;
}

// ======================================================================
// "Yeni Simülasyon Başlat" penceresi (§6/§21): sihirbaz içeriği modalda — başlık, kaydırılabilir gövde, altbilgi "İptal et" + "Başlat".
// Başlat → mevcut prepareSession akışı (hazırlık kartı; pencere bu sırada gizlenir) → oturum ekranı (hash değişimi pencereyi kapatır).
// preset: { mode: 'replay', log } (kayıt tablosundan Oynat).
// ======================================================================
async function wizardModal({ be, meta, mock, canWrite, preset = {}, onClosed, user = null, onSaved = null }) {
  ensureSavedCss();
  // §27 kayıtlı simülasyon: edit → sihirbaz kayıtlı ayarlarla açılır, Kaydet aynı kaydı günceller · quick → yalnız özet adımı + Uç (geri sayım; sihirbaz atlanır)
  const edit = preset.edit || null, quick = preset.quick || null, P0 = (edit || quick)?.settings || null;
  // §33 "Yeni Karşılaşma": aynı sihirbaz; Hedefler / Yer kontrol (radar, EO) ve dron kaydı yok, Halkalar + Davet et adımları, sonunda yalnız Başlat
  const isMatch = !!preset.match;
  const stepDef = k => stepDefFor(k, isMatch);
  const mmeta = isMatch ? await matchApi.meta() : null;
  const types = (meta.types?.length ? meta.types : TYPES.map(([key, name]) => ({ key, name }))).map(t => {
    const d = TYPES.find(x => x[0] === t.key) || [t.key, t.name, '', 'quad'];
    return { key: t.key, name: t.name || d[1], desc: d[2], icon: d[3], binary: t.binary };
  }).filter(t => !isMatch || (mmeta?.limits?.types || []).includes(t.key));   // karşılaşmada kara aracı yok (halkalar havada)
  const centers = meta.centers || [];
  const defaults = { ...WORLD_DEFAULTS, ...(meta.world_defaults || {}) };
  const logsAllowed = meta.replay ? meta.replay.logs_allowed !== false : true;
  // Son seçimler (§6): tip, merkez ve kalkış yöntemi/ayarları Başlat'ta `caymaz.fs.wz.last`a yazılır, sonraki açılışta önerilir (yoksa ilk tip / ilk merkez)
  let last = {}; try { last = JSON.parse(pref('fs.wz.last', '{}')) || {}; } catch { last = {}; }
  if (P0) last = { type: P0.type, center: P0.center_id, launch: P0.world?.launch };   // §27: kayıtlı ayarlar önerinin yerine
  const S = { mode: preset.mode === 'replay' ? 'replay' : 'sitl', type: types.some(t => t.key === last.type) ? last.type : (types[0]?.key || 'multirotor'), center: centers.some(c => c.id === last.center) ? last.center : (P0 ? null : (centers[0]?.id ?? null)), log: preset.log ?? null, logs: null, q: '', drone: P0?.drone_id ?? null, pinned: preset.mode === 'replay' && !!preset.pinned && preset.log != null,   // §8.5 "Simüle et": log sabit (liste yok), Dünya adımından
    sort: LOG_SORTS.some(x => x[0] === pref('fs.logSort', '')) ? pref('fs.logSort', '') : 'new',
    world: { ...defaults, ...(P0?.world || {}), seed: P0?.world?.seed ?? randomSeed(), launch: { ...LAUNCH_DEFAULTS, ...(defaults.launch || {}), ...(last.launch && typeof last.launch === 'object' ? pickLaunch(last.launch) : {}) } }, layout: P0?.layout || 'elevon',
    drive: P0?.drive ? normDrive(P0.drive) : null };   // §31 kara aracı sürüş biçimi: null = seçili modelin `drive`'ı (kullanıcı seçince sabitlenir)   // §13.1 kontrol düzeni; varsayılan model Caymaz → elevon (model seçilince modelin düzeni)
  // Etkin dron tipi: canlı kipte seçilen kart, kayıt kipinde seçili logun araç tipi (model kütüphanesi bu tipe göre listelenir)
  const activeType = () => (S.mode === 'replay' ? ((S.logs || []).find(x => x.id === S.log)?.type || 'multirotor') : S.type);

  // ---------- 1. dron tipi ----------
  const typeCards = h('div', { class: 'fs-types' });
  // Görsel model kütüphanesi (§12): tip kartının altında kart ızgarası (dahili + tasarım + yüklenen), seçim önizlemeye uygulanır
  const picker = modelPicker({ getType: activeType, canWrite, mock, getSim: () => preview, getLayout: () => (activeType() === 'sabit_kanat' ? S.layout : null),
    onSelect: m => { if (activeType() === 'rover' && !S.drive) drawDrive?.(); const l = layoutForModel(m); if (l) { S.layout = l; drawLayout?.(); } preview?.setType(activeType(), m).then(() => { if (!l) { const d = preview?.ctrlLayout?.(); if (d) { S.layout = d; drawLayout?.(); } } }); } });   // §13.1: model seçilince düzen modelin düzeni (Caymaz → elevon, Talon → V-kuyruk, Cessna → klasik); kullanıcı sonra değiştirebilir
  const modelBox = h('div', { class: 'fs-model-step' }, h('h4', { class: 'fs-wz-sec-h' }, 'Görsel model'), h('p', { class: 'small muted' }, 'Dron tipi için görsel gövde: dahili modeller her zaman vardır; sistemdeki STEP/GLB/OBJ dosyaları ya da yüklediğiniz model seçilince tarayıcıda GLB\'ye dönüştürülür.'), picker.el);
  if (P0?.model) picker.prefer(P0.type, typeof P0.model === 'object' ? P0.model : { id: P0.model });   // §27 kayıtlı model
  const refreshModels = () => picker.refresh(activeType()).then(m => { if (m) preview?.setType(activeType(), m); drawDrive(); if (W?.step === 'summary') drawSummary(); });   // §31: model gelince varsayılan sürüş biçimi   // özet açıksa model adı güncellensin (§27 hızlı başlat)
  const drawTypes = () => clear(typeCards, types.map(t => h('button', { type: 'button', class: `fs-type ${S.type === t.key ? 'on' : ''}`, onclick: () => { S.type = t.key; drawTypes(); drawLaunch(); drawLayout(); drawDrive(); refreshModels(); powerSec?.refresh(); siteSec?.refresh(); ringsSec?.refresh(); } },
    h('span', { class: 'fs-type-ico', html: TYPE_ICON[t.icon] || TYPE_ICON.quad }),
    h('b', null, t.name), h('span', { class: 'small muted' }, t.desc || ''))));
  drawTypes();

  // ---------- 1L. kalkış yöntemi (§13; yalnız Sabit Kanat): tekerlekli · fırlatma rampası (açı) · araç üstü (bırakma hızı) ----------
  const L = S.world.launch;
  const launchCards = h('div', { class: 'fs-launches' });
  const launchInfo = h('div', { class: 'small muted fs-launch-info' });
  const applyLaunch = () => { preview?.setLaunch({ ...L }); };
  // Ayar kaydırıcıları veriden (flightsim_wizard LAUNCH_PARAM_DEFS); hangisinin görüneceğini seçili seçeneğin `params` listesi belirler
  const launchParams = Object.fromEntries(Object.entries(LAUNCH_PARAM_DEFS).map(([key, d]) => [key, numSlider({ h, label: tr(d.label), value: L[paramField(key)] ?? d.max, min: d.min, max: d.max, step: d.step, unit: d.unit, integer: !!d.integer, cls: 'fs-launch-param',
    onInput: v => { L[paramField(key)] = v; drawLaunchInfo(); applyLaunch(); } })]));
  const launchNote = h('div', { class: 'small muted fs-launch-param fs-launch-note' });
  const drawLaunchInfo = () => {
    const v = rampExitSpeed();
    launchInfo.textContent = L.method === 'ramp' ? tr('Pnömatik rampa: 6 m ray, 0,5 sn kızak → çıkış hızı ≈ {v} m/s ({k} km/h); açı {a}°. SITL: plane-catapult modeli, servo 7 tetiği; TKOFF_THR_MINACC 8 m/s².', { v: v.toFixed(0), k: Math.round(v * 3.6), a: Math.round(L.angle_deg) })
      : L.method === 'vehicle' ? tr('Araç üstü: uçak {k} km/h ({v} m/s) yer hızında bırakılır (TKOFF_ROTATE_SPD = bırakma hızı); araç frenleyip durur.', { k: Math.round(L.release_kmh), v: (L.release_kmh / 3.6).toFixed(1) })
      : L.method === 'pod4' || L.method === 'pod8' ? tr('{c} hücreli kutu: {n} dolu · {e} boş. Kapak açılır, interceptor kuyruk üstünden dikey çıkar (SITL: GUIDED + ARM + NAV_TAKEOFF); hücre sırası soldan sağa, arka sıradan öne.', { c: L.method === 'pod4' ? 4 : 8, n: Math.round(L.loaded ?? (L.method === 'pod4' ? 4 : 8)), e: (L.method === 'pod4' ? 4 : 8) - Math.round(L.loaded ?? (L.method === 'pod4' ? 4 : 8)) })
      : L.method === 'tube' ? tr('Yerden tekli tüp: kapak açılır, interceptor tüpten dikey çıkar (SITL: GUIDED + ARM + NAV_TAKEOFF).')
      : L.method === 'handheld' ? (() => { const w = aimWaypoint(L.aim_az_deg ?? 0, L.aim_el_deg ?? 55); return tr('El fırlatıcısı: nişan yönü {az}° · açısı {el}°. Fırlatınca interceptor 8 m dikey çıkar ve nişan doğrultusundaki noktaya ({h} m ileride, {a} m irtifa) yönelir. Uçuşta "Nişangâh" ile yeniden nişan alınabilir.', { az: Math.round(L.aim_az_deg ?? 0), el: Math.round(L.aim_el_deg ?? 55), h: Math.round(w.horiz_m), a: Math.round(w.alt_m) }); })()
      : tr('Tekerlekli: iniş takımı eklenir; uçak pist boyunca hızlanır, 12 m/s döndürme hızında burun kalkar (ArduPlane TAKEOFF).');
    drawWindAdvice();
  };
  // §31 rüzgâra karşı kalkış önerisi (Kalkış adımı): kalkış yönü = rampa azimutu / pist yönü; baş/yan/kuyruk bileşeni + "Rüzgâra karşı çevir"
  const windAdv = h('div', { class: 'small fs-wind-advice' });
  const drawWindAdvice = () => {
    const at = activeType(), fixed = at === 'sabit_kanat' && ['wheels', 'ramp', 'vehicle'].includes(L.method);
    windAdv.hidden = !fixed || !(Number(S.world.wind_ms) > 0.3);
    if (windAdv.hidden) return;
    const hdg = L.method === 'ramp' ? Number(L.azimuth_deg ?? S.world.runway_heading) || 0 : Number(S.world.runway_heading) || 0;
    const a = takeoffAdvice(S.world.wind_ms, S.world.wind_dir, hdg);
    const comp = a.head >= 0 ? tr('baş rüzgârı {h} m/s', { h: a.head.toFixed(1) }) : tr('KUYRUK rüzgârı {h} m/s', { h: Math.abs(a.head).toFixed(1) });
    clear(windAdv, h('span', { class: a.ok ? 'muted' : 'fs-warn-txt' }, `🧭 ${tr('Rüzgâr {ms} m/s · {dir}° → kalkış yönü {hdg}°: {c}, yan {x} m/s', { ms: Number(S.world.wind_ms).toFixed(1), dir: Math.round(S.world.wind_dir), hdg: Math.round(hdg), c: comp, x: Math.abs(a.cross).toFixed(1) })}`),
      a.worth ? h('button', { class: 'btn sm', type: 'button', style: { marginLeft: '8px' }, onclick: () => {
        if (L.method === 'ramp') { L.azimuth_deg = a.suggest; launchParams.azimuth_deg.set(a.suggest); applyLaunch(); }
        else { S.world.runway_heading = a.suggest; sliders.runway_heading?.set(a.suggest); schedule(); applyLaunch(); }
        drawLaunchInfo();
      } }, tr('Rüzgâra karşı çevir ({s}°)', { s: a.suggest })) : null);
  };
  const launchDesc = h('p', { class: 'small muted' }, tr(launchStepDesc('sabit_kanat', 'sitl')));
  const lastMethod = {};   // tip → son seçilen kalkış yöntemi (tip değişip geri gelince seçim korunur)
  // Kayıt kipinde de sorulur (kullanıcı isteği): seçili logun aracı sabit kanat (ArduPlane) ise kartlar görünür; düzenek 3B'de kurulur, aşamalar logdan türetilir (§8)
  const drawLaunch = () => {
    const at = activeType(), opts = launchOptionsFor(at);   // veriden: tipe uygun kalkış seçenekleri (yoksa adım atlanır)
    launchBox.hidden = !opts.length;
    if (opts.some(o => o.key === L.method)) lastMethod[at] = L.method; else if (lastMethod[at]) L.method = lastMethod[at];
    const nm = normLaunchMethod(L.method, at); if (nm !== L.method) { L.method = nm; applyLaunch(); }
    launchDesc.textContent = tr(launchStepDesc(at, S.mode));
    launchCards.classList.toggle('fs-launches-4', opts.length >= 4);
    clear(launchCards, opts.map(o => h('button', { type: 'button', class: `fs-type fs-launch ${L.method === o.key ? 'on' : ''}`, 'data-launch': o.key, onclick: () => { if (o.key !== L.method && (o.key === 'pod4' || o.key === 'pod8')) L.loaded = o.key === 'pod4' ? 4 : 8; L.method = o.key; drawLaunch(); applyLaunch(); } },   // kutu değişince hücreler dolu başlar
      h('span', { class: 'fs-type-ico', html: LAUNCH_ICON[o.icon] || LAUNCH_ICON.wheels }), h('b', null, tr(o.name), o.badge ? h('span', { class: 'badge blue fs-launch-badge2' }, tr(o.badge)) : null), h('span', { class: 'small muted' }, tr(o.desc)))));
    const cur = opts.find(o => o.key === L.method);
    for (const [key, sl] of Object.entries(launchParams)) { const f = paramField(key), d = LAUNCH_PARAM_DEFS[key]; if (cur?.params.includes(key) && (L[f] == null || L[f] > d.max || L[f] < d.min)) L[f] = key === 'azimuth_deg' ? Math.round(Number(S.world.runway_heading) || 0) % 360 : d.max === 359 ? 0 : key === 'aim_el_deg' ? 55 : d.max; sl.set(L[f]); sl.el.hidden = !cur?.params.includes(key); }
    if (cur?.key !== 'ramp') delete L.azimuth_deg;   // §31: azimut yalnız rampada (diğer yöntemler pist yönünde)
    launchNote.hidden = !cur?.note; launchNote.textContent = cur?.note ? tr(cur.note) : '';
    drawLaunchInfo();
  };
  const launchBox = h('div', { class: 'fs-launch-step' }, launchDesc,
    launchCards, h('div', { class: 'fs-launch-params' }, Object.values(launchParams).map(sl => sl.el), launchNote), launchInfo, windAdv);
  drawLaunch();

  // ---------- 1K. kontrol düzeni (§13.1; yalnız Sabit Kanat, canlı kip): Aileron + Elevatör (T-kuyruk) · Elevon (delta kanat) · V-kuyruk (ruddervator) ----------
  const layoutCards = h('div', { class: 'fs-launches fs-layouts' });
  const layoutInfo = h('div', { class: 'small muted fs-launch-info fs-layout-info' });
  const layoutDesc = h('p', { class: 'small muted' }, 'Kontrol yüzeylerinin düzeni: ArduPlane SERVO işlevleri ve SITL uçak modeli buna göre kurulur, 3B\'de yüzeyler buna göre oynar. Model seçilince modelin düzeni önerilir; değiştirebilirsiniz.');
  const drawLayoutInfo = () => {
    const prm = LAYOUT_PARAMS[S.layout] || {};
    const liste = Object.entries(prm).map(([k, v]) => `${k} ${v}`).join(' · ');
    const not_ = S.layout === 'elevon' ? tr('CAYMAZ delta kanat: iki elevon hem yunuslama hem yatış; ArduPlane karışımı MIXING_GAIN 0,5 (doymaz). Dronun kalıcı kaydında SERVO1/2_FUNCTION varsa (ör. CAYMAZ 4/19) kalıcı değer öncelikli; SITL modeli etkin işlevlerden seçilir ve konsola yazılır.')
      : S.layout === 'vtail' ? tr('V-kuyruk: sağa sapma komutunda sol ruddervator arka kenarı yukarı, sağ aşağı; burun yukarı komutunda ikisi de yukarı. ArduPilot\'un kendi SITL kurulumu (plane-vtail.parm) ile aynı.')
      : tr('Klasik: aileron yatış, elevatör yunuslama, rudder sapma. ArduPlane varsayılan işlevleri.');
    layoutInfo.textContent = `${tr('SITL modeli')}: ${LAYOUT_SITL_MODEL[S.layout] || 'plane'} · ${liste}. ${not_}`;
  };
  const drawLayout = () => {
    layoutBox.hidden = activeType() !== 'sabit_kanat' || S.mode === 'replay';
    clear(layoutCards, LAYOUTS.map(([key, name, desc]) => h('button', { type: 'button', class: `fs-type fs-launch fs-layout ${S.layout === key ? 'on' : ''}`, 'data-layout': key, onclick: () => { S.layout = key; drawLayout(); picker.redraw(); } },
      h('span', { class: 'fs-type-ico', html: LAYOUT_ICON[key] }), h('b', null, name), h('span', { class: 'small muted' }, desc))));
    drawLayoutInfo();
  };
  const layoutBox = h('div', { class: 'fs-launch-step fs-layout-step' }, h('h4', null, 'Kontrol düzeni'), layoutDesc, layoutCards, layoutInfo);
  drawLayout();

  // ---------- 1D. sürüş biçimi (§31; yalnız Kara Aracı, canlı kip): Ackermann (ön teker direksiyonu) · paletli / diferansiyel (skid) ----------
  // Varsayılan seçili modelin `drive`'ı (Keşif 4×4 → Ackermann; Paletli UGV / Teslimat robotu → skid); kullanıcı seçince model değişse de korunur.
  const DRIVE_ICON = { ackermann: svgIco('<rect x="7" y="4" width="10" height="16" rx="2.5"/><path d="M4.5 6.5l2 1M4.5 9.5l2-1M19.5 6.5l-2 1M19.5 9.5l-2-1"/><path d="M5 15.5h2M17 15.5h2M5 18.5h2M17 18.5h2"/>'),
    skid: svgIco('<rect x="8" y="4.5" width="8" height="15" rx="2"/><rect x="3.5" y="4" width="3.5" height="16" rx="1.6"/><rect x="17" y="4" width="3.5" height="16" rx="1.6"/><path d="M3.5 8h3.5M3.5 12h3.5M3.5 16h3.5M17 8h3.5M17 12h3.5M17 16h3.5"/>') };
  const driveCards = h('div', { class: 'fs-launches fs-drives' });
  const driveInfo = h('div', { class: 'small muted fs-launch-info fs-drive-info' });
  const driveOf = () => normDrive(S.drive || picker.selectionFor('rover')?.drive || 'ackermann');
  let driveBox = null;
  function drawDrive() {
    if (!driveBox) return;
    driveBox.hidden = activeType() !== 'rover' || S.mode === 'replay';
    const cur = driveOf(), md = picker.selectionFor('rover')?.drive || null;
    clear(driveCards, Object.keys(DRIVE_NAME).map(k => h('button', { type: 'button', class: `fs-type fs-launch fs-drive ${cur === k ? 'on' : ''}`, 'data-drive': k, onclick: () => { S.drive = k; drawDrive(); } },
      h('span', { class: 'fs-type-ico', html: DRIVE_ICON[k] }), h('b', null, DRIVE_NAME[k], md === k ? h('span', { class: 'badge gray fs-launch-badge2' }, tr('modelin')) : null), h('span', { class: 'small muted' }, DRIVE_DESC[k]))));
    const L_ = ROVER_LIMITS[cur];
    driveInfo.textContent = cur === 'skid' ? tr('ArduRover diferansiyel sürüş: SERVO1 sol / SERVO3 sağ gaz; azami {v} km/h, yerinde dönüş {r}°/sn.', { v: Math.round(L_.vmax * 3.6), r: L_.turnRateDeg })
      : tr('ArduRover Ackermann: SERVO1 direksiyon / SERVO3 gaz; azami {v} km/h, teker açısı ±{a}°.', { v: Math.round(L_.vmax * 3.6), a: L_.steerDeg });
  }
  driveBox = h('div', { class: 'fs-launch-step fs-drive-step' }, h('h4', null, 'Sürüş biçimi'),
    h('p', { class: 'small muted' }, 'Kara aracının yönlendirme biçimi: SITL araç modeli ve 3B tekerlek hareketi buna göre kurulur. Varsayılan seçili modelin biçimidir; değiştirebilirsiniz.'), driveCards, driveInfo);
  drawDrive();

  // ---------- 2. merkez ----------
  const centerList = h('div', { class: 'fs-centers' });
  const centerOf = () => centers.find(c => c.id === S.center) || null;
  // §9 EV İRTİFASI KURALI: gerçek arazi / Google 3B kiplerinde SITL ev irtifası HER ZAMAN yükseklik verisinden (terrarium) kurulur; merkez kaydındaki
  // `alt` yalnız prosedürel kipte kullanılır. Kayıtlı değer araziden 15 m'den fazla sapıyorsa (Ankara 0 m / Bedesten 1500 m kayıtları → gerçek 1000 / 742 m)
  // seçili merkez kartında uyarı: "Kayıtlı irtifa 1500 m, arazi 742 m — arazi kullanılacak". Arazi yüksekliği /api/drone/sim/terrain `home_elev` (önbellekli).
  const EV_FARK_UYARI = 15, elevCache = new Map();   // center.id → number | null (alınamadı) | Promise
  const terrainMode = () => S.world.mode === 'real' || S.world.mode === 'google3d';
  const homeElev = c => {
    if (!elevCache.has(c.id)) {
      elevCache.set(c.id, api.get(`/api/drone/sim/terrain?lat=${Number(c.lat)}&lon=${Number(c.lon)}&size_m=1000`).then(r => (r && r.home_elev != null ? Number(r.home_elev) : null)).catch(() => null)
        .then(v => { elevCache.set(c.id, v); if (S.center === c.id) drawCenters(); return v; }));
    }
    const v = elevCache.get(c.id);
    return typeof v === 'number' ? v : null;
  };
  const altNote = c => {   // seçili merkez; yalnız arazi kiplerinde
    if (!terrainMode() || S.center !== c.id) return null;
    const e = homeElev(c);
    if (e == null) return h('span', { class: 'small muted fs-center-alt' }, tr('Ev irtifası arazi verisinden alınacak'));
    if (c.alt != null && Math.abs(Number(c.alt) - e) > EV_FARK_UYARI) return h('span', { class: 'small fs-center-alt warn' }, '⚠ ', tr('Kayıtlı irtifa {a} m, arazi {t} m — arazi kullanılacak', { a: f0(c.alt), t: f0(e) }));
    return h('span', { class: 'small muted fs-center-alt' }, tr('Arazi {t} m — ev irtifası arazi verisinden', { t: f0(e) }));
  };
  const drawCenters = () => clear(centerList, centers.length ? centers.map(c => h('button', { type: 'button', class: `fs-center ${S.center === c.id ? 'on' : ''}`, onclick: () => { S.center = c.id; drawCenters(); ringsSec?.refresh(); if (preview) { progInfo(null); preview.setOrigin(c.lat, c.lon, S.world, c.alt); } } },
    h('b', null, c.name), h('span', { class: 'small muted' }, [c.location_name, `${Number(c.lat).toFixed(5)}, ${Number(c.lon).toFixed(5)}`, c.alt != null ? `${f0(c.alt)} m` : null].filter(Boolean).join(' · ')), altNote(c)))
    : h('div', { class: 'small muted fs-nocenter' }, 'Kayıtlı merkez yok. Önce ', h('a', { href: '#/drone/routes' }, 'Rotalar › Merkezler'), ' bölümünden bir merkez ekleyin.'));
  drawCenters();
  // ---------- 2b. dron kaydı (isteğe bağlı; §14): harekât panelinde telemetri bu dronun koduyla/adıyla akar; yoksa "Simülatör #N" ----------
  const droneCam = new Map();   // §22.3: dron kaydının son kamera türü (sunucu: son simülasyon kaydı) → kamera kartı varsayılanı
  const droneSel = h('select', { class: 'input fs-drone-sel', onchange: () => { S.drone = droneSel.value ? Number(droneSel.value) : null; powerSec?.refresh(); camForDrone(); } }, h('option', { value: '' }, 'Yok — "Simülatör #N" sanal dronu'));
  const droneBox = h('div', { class: 'fs-drone-step' },
    h('p', { class: 'small muted' }, 'Dron Envanteri\'nden bir kayıt seçilirse harekât panelinde dron o adla görünür; seçilmezse oturuma özel "Simülatör #N" sanal dronu kullanılır. Simülatör her durumda SITL\'dir; kayıt yalnız kimliktir.'),
    h('label', { class: 'fs-drone-row' }, h('span', { class: 'small muted' }, 'Dron kaydı'), droneSel));
  (be.drones ? be.drones() : Promise.resolve([])).then(rows => { (rows || []).forEach(d => { if (isCamType(d.camera)) droneCam.set(d.id, d.camera); }); (rows || []).forEach(d => droneSel.append(h('option', { value: d.id }, `${d.code || ''} · ${d.name || ''}${d.model ? ` (${d.model})` : ''}`))); if (S.drone != null) droneSel.value = String(S.drone); }).catch(() => {});   // §27: kayıtlı dron kaydı seçili

  // ---------- 1R. kayıttan oynat: uçuş logu listesi (ad, tarih, dron, süre, boyut; arama) ----------
  const logList = h('div', { class: 'fs-logs' });
  const logInfo = h('div', { class: 'small muted fs-log-info' });
  const fmtSize = b => (b == null ? '—' : b >= 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`);
  const drawLogs = () => {
    if (S.logs === null) { clear(logList, h('div', { class: 'small muted' }, 'Uçuş logları yükleniyor…')); return; }
    const q = S.q.trim().toLocaleLowerCase('tr');
    // §8.5: liste YALNIZ simülatör kayıtları (sunucu da süzer); "Simüle et" girişinde yalnız sabit log (kaynağı ne olursa olsun)
    const pool = S.pinned ? S.logs.filter(l => l.id === S.log) : simLogsOnly(S.logs);
    const rows = sortLogs(pool.filter(l => !q || [l.file_name, l.aircraft, l.pilot, l.location, l.task_code, l.note, l.vehicle].some(v => String(v || '').toLocaleLowerCase('tr').includes(q))), S.sort);
    clear(logCounts, S.pinned ? '' : tr('{n} simülasyon kaydı', { n: pool.length }));
    if (!rows.length) {
      clear(logList, h('div', { class: 'small muted fs-nocenter' }, S.pinned ? tr('Uçuş logu bulunamadı ya da erişim yetkiniz yok (analizi tamamlanmış .bin / .log / .tlog gerekir).')
        : pool.length ? tr('Filtreye uyan log yok.')
          : [tr('Henüz oynatılabilir simülasyon kaydı yok. Canlı simülasyonda "Uçuş logu (.bin)" seçeneği açıkken uçun; kayıt kapanışta burada listelenir. Gerçek uçuşları '), h('a', { href: '#/field' }, tr('Saha Yönetimi')), tr(' ya da '), h('a', { href: '#/tools/flight-log' }, tr('Uçuş Logu Analizi')), tr(' ekranındaki "Simüle et" ile açın.')]));
      return;
    }
    clear(logList, rows.map(l => h('button', { type: 'button', class: `fs-log ${S.log === l.id ? 'on' : ''}`, onclick: () => { S.log = l.id; if (l.sim_launch && typeof l.sim_launch === 'object') Object.assign(L, pickLaunch(l.sim_launch)); drawLogs(); drawLaunch(); applyLaunch(); refreshModels(); } },
      h('span', { class: 'fs-log-ico', html: TYPE_ICON[(TYPES.find(x => x[0] === l.type) || [])[3] || 'quad'] }),
      h('span', { class: 'fs-log-main' },
        h('b', null, originBadge(l), l.file_name, l.ext ? h('span', { class: 'badge gray fs-log-ext' }, l.ext.toUpperCase()) : null, l.cached ? h('span', { class: 'badge green', title: tr('Kareler önbellekte; hemen açılır') }, '⚡') : null),
        h('span', { class: 'small muted' }, [l.takeoff_utc || l.start_utc ? fmtDateTime(l.takeoff_utc || l.start_utc) : fmtDateTime(l.uploaded_at), l.aircraft, l.pilot, l.location, l.task_code ? tr('Görev {c}', { c: l.task_code }) : null, l.vehicle].filter(Boolean).join(' · '))),
      h('span', { class: 'fs-log-meta small' }, h('b', null, l.flight_s != null ? fmtDuration(l.flight_s) : (l.duration_s != null ? fmtDuration(l.duration_s) : '—')), h('span', { class: 'muted' }, fmtSize(l.size))))));
  };
  const searchInp = h('input', { class: 'input', placeholder: 'Ara: dosya adı, dron, pilot, konum, görev kodu…', value: S.q, oninput: () => { S.q = searchInp.value; drawLogs(); } });
  // Sıralama (tercihte saklanır). §8.5: liste yalnız simülasyon kayıtları — Kaynak (Gerçek/Simülasyon) süzgeci kaldırıldı
  const sortSel = h('select', { class: 'input fs-log-sort', title: tr('Sıralama'), onchange: () => { S.sort = sortSel.value; setPref('fs.logSort', S.sort); drawLogs(); } },
    LOG_SORTS.filter(([k]) => k !== 'origin').map(([k, label]) => h('option', { value: k, selected: k === S.sort }, tr(label))));
  const logCounts = h('span', { class: 'small muted fs-log-counts' });
  const loadLogs = async () => {
    if (!logsAllowed) { S.logs = []; drawLogs(); return; }
    try { S.logs = await be.logs(S.pinned ? { id: S.log } : {}); } catch (err) { S.logs = []; toastError(err); }
    if (!S.pinned && (S.log == null || !S.logs.some(l => l.id === S.log)) && simLogsOnly(S.logs).length) S.log = simLogsOnly(S.logs)[0].id;
    if (S.pinned && !S.logs.some(l => l.id === S.log)) S.log = null;   // bulunamadı / yetki yok → log adımı hata gösterir
    drawLogs();
    drawLaunch();   // seçili logun tipi sabit kanat ise Kalkış yöntemi kartları (§8)
  };
  drawLogs();
  const stepLog = h('div', { class: 'fs-wz-logbox' },
    h('p', { class: 'small muted' }, S.pinned
      ? tr('Seçilen uçuş kaydı 3B dünyada aynen oynatılır; kontrol sizde değildir. Atmosfer (dünya, saat, hava, rüzgâr), kalkış/rampa ve kamera sonraki adımlarda seçilir.')
      : tr('Simülatörde kaydedilmiş uçuşlardan biri 3B dünyada aynen oynatılır; kontrol sizde değildir. Dünyanın merkezi kaydın kalkış (ilk ARM) noktasıdır. Saha görevlerinin gerçek uçuş logları burada listelenmez — Saha Yönetimi\'nde uçuşun yanındaki "Simüle et" ile açılır.')),
    S.pinned ? null : h('div', { class: 'fs-log-search' }, searchInp, h('button', { class: 'btn sm', type: 'button', onclick: loadLogs }, '↻ Yenile')),
    S.pinned ? null : h('div', { class: 'fs-log-filter' }, sortSel, logCounts), logList, logInfo);

  // ---------- 3. dünya ----------
  let preview = null, rebuildT = 0;
  const progBar = h('div', { class: 'fs-preview-prog', hidden: true });
  const g3dLogo = h('img', { class: 'fs-g3d-logo', src: G3D_LOGO, alt: 'Google', hidden: true });   // Google 3B önizlemesinde ToS logosu (sol alt)
  const previewBox = h('div', { class: 'fs-preview' }, h('div', { class: 'fs-preview-msg' }, '3B önizleme hazırlanıyor…'), progBar, g3dLogo);
  const previewInfo = h('div', { class: 'small muted fs-preview-info' });
  // Gerçek kip yükleme ilerlemesi / özet (önizleme kutusu üstünde şerit + altında bilgi satırı). prepTap: hazırlık kartı (Başlat sonrası) aynı ilerlemeyi dinler
  let prepTap = null;
  const progInfo = p => {
    if (p) prepTap?.(p);
    if (!p) { progBar.hidden = false; progBar.textContent = tr('Arazi planı alınıyor…'); return; }
    if (p.stage === 'done') {
      progBar.hidden = true;
      g3dLogo.hidden = !p.google;
      if (p.real) {
        const c = p.counts || {};
        previewInfo.textContent = `${tr('Gerçek arazi · yükseklik {a}…{b} m · ev {h} m MSL', { a: f0(p.hmin), b: f0(p.hmax), h: f0(p.homeElev) })} · ${tr('{b} bina · {f} orman · {w} su · {r} pist', { b: c.buildings ?? 0, f: c.forests ?? 0, w: c.water ?? 0, r: c.runways ?? 0 })}`;
        const info = preview?.terrainInfo;
        if (info?.osmError) previewInfo.textContent += ` · ${tr('OSM verisi alınamadı: binalar/orman/su gösterilmiyor ({e})', { e: info.osmError })}`;
      } else if (p.google) previewInfo.textContent = `${tr('Google 3B (fotogerçekçi) · ev {h} m MSL', { h: f0(p.homeElev) })} · ${preview?.g3dAttribution?.()?.text || 'Google'}`;
      else if (S.world.mode === 'procedural') previewInfo.textContent = tr('Prosedürel dünya: tohumlu rastgele arazi, binalar ve ağaçlar.');
      // real/google3d seçiliyken prosedürele düşüldüyse onFallback'in yazdığı uyarı kalır
      return;
    }
    if (p.stage === 'g3d') {   // Google karoları: kök tileset + görünür karolar (%); dolunca şerit gizlenir
      progBar.hidden = p.pct >= 100; progBar.textContent = tr('Google 3B karoları yükleniyor… %{p}', { p: p.pct ?? 0 });
      return;
    }
    progBar.hidden = false;
    progBar.textContent = p.stage === 'elev' ? tr('Yükseklik karoları {d}/{n}', { d: p.done, n: p.total }) : p.stage === 'img' ? tr('Uydu karoları {d}/{n}', { d: p.done, n: p.total })
      : p.stage === 'osm' ? tr('Harita verileri (OSM) alınıyor…') : tr('Arazi planı alınıyor…');
  };
  const fallbackText = (mode, e) => (mode === 'google3d' ? tr('Google 3B verisi alınamadı: {e} → prosedürele düşüldü', { e }) : tr('Gerçek veri alınamadı, prosedürele düşüldü: {e}', { e }));
  const onFallback = e => { previewInfo.textContent = fallbackText(S.world.mode, e); toast(previewInfo.textContent, 'err'); };
  const schedule = () => { clearTimeout(rebuildT); rebuildT = setTimeout(() => { if (S.world.mode === 'real') progInfo(null); preview?.setWorld(S.world); }, 300); };
  // §6.1 görsel giriş: kaydırıcı + düzenlenebilir değer kutusu + birim (fs_inputs.numSlider). pct: 0–1 değer yüzde olarak gösterilir/girilir.
  const sliders = {};
  const slider = (key, label, min, max, step, unit = '', { pct = false, scale = 'lin' } = {}) => {
    const k = pct ? 100 : 1;
    const sl = numSlider({ h, label, value: S.world[key] * k, min: min * k, max: max * k, step: Math.round(step * k * 1000) / 1000, unit: pct ? '%' : unit, scale, cls: 'fs-slider',
      onInput: v => { S.world[key] = pct ? Math.round(v) / 100 : v; schedule(); if (/^wind_(ms|dir)$|^runway_heading$/.test(key)) drawWindAdvice(); } });
    sliders[key] = { el: sl.el, sl, label, set: v => sl.set(v * k) };
    return sl.el;
  };
  const seedInp = h('input', { class: 'input mono', value: S.world.seed, inputmode: 'numeric', style: { width: '120px' }, onchange: () => { S.world.seed = Number(seedInp.value) || 1; seedInp.value = S.world.seed; schedule(); } });
  const runwayCb = h('input', { type: 'checkbox', checked: S.world.runway !== false, onchange: () => { S.world.runway = runwayCb.checked; schedule(); } });
  const timeSeg = segmented([['day', 'Gündüz'], ['dusk', 'Akşam'], ['night', 'Gece']], S.world.time, v => { S.world.time = v; schedule(); });
  const seedBox = h('div', { class: 'fs-seed' }, h('span', { class: 'small muted' }, 'Tohum'), seedInp,
    h('button', { class: 'btn sm', type: 'button', onclick: () => { S.world.seed = randomSeed(); seedInp.value = S.world.seed; schedule(); } }, '🎲 Rastgele tohum'));
  // Dünya kipi: gerçek arazi (yükseklik + uydu + OSM; prosedürel ayarlar özelleştirme) / prosedürel
  const modeHint = h('p', { class: 'small muted fs-mode-hint' });
  const applyMode = () => {
    const real = S.world.mode === 'real', g3 = S.world.mode === 'google3d';
    for (const k of ['mountain_height', 'mountain_count', 'water']) sliders[k].el.hidden = real || g3;
    for (const k of ['tree_density', 'building_count']) sliders[k].el.hidden = g3;   // Google 3B: nesneler karoların içinde; yalnız saat/sis/rüzgâr/pist
    seedBox.hidden = real || g3;
    sliders.tree_density.sl.setLabel(tr(real ? 'Ağaç sıklığı (orman alanlarına ölçek)' : 'Ağaç sıklığı'));
    sliders.building_count.sl.setLabel(tr(real ? 'Ek bina sayısı (0 = yalnız gerçek binalar)' : 'Bina sayısı'));
    modeHint.textContent = real
      ? `${tr('Gerçek kipte seçili merkezin çevresi gerçek yükseklik, uydu görüntüsü ve OpenStreetMap binalarıyla kurulur; veriler ilk kullanımda indirilip sunucuda önbelleklenir.')} ${ATTRIBUTION}`
      : g3 ? tr('Google 3B kipinde çevre Google Photorealistic 3D Tiles ile fotogerçekçi kurulur (binalar ve ağaçlar karoların içinde); karolar tarayıcıya doğrudan Google’dan gelir, sunucuda önbelleklenmez; atıf zorunludur. Ev irtifası açık yükseklik verisinden alınır.')
      : tr('Prosedürel dünya: tohumlu rastgele arazi, binalar ve ağaçlar.');
    drawCenters();   // §9: arazi kiplerinde merkez kartında ev irtifası notu/uyarısı
  };
  let bcTouched = false, rwTouched = false;
  const g3dOn = !!meta.google3d?.enabled;   // yalnız sunucuda GOOGLE_MAPS_API_KEY tanımlıysa üçüncü seçenek
  if (!g3dOn && S.world.mode === 'google3d') S.world.mode = 'procedural';
  const worldModeSeg = segmented([['real', 'Gerçek arazi'], ...(g3dOn ? [['google3d', 'Google 3B (fotogerçekçi)']] : []), ['procedural', 'Prosedürel']], S.world.mode, v => {
    S.world.mode = v;
    if (!bcTouched) { S.world.building_count = v === 'real' ? 0 : defaults.building_count; sliders.building_count.set(S.world.building_count); }
    if (!rwTouched) { S.world.runway = v !== 'google3d'; runwayCb.checked = S.world.runway; }   // Google 3B: pist varsayılan kapalı (gerçek yüzeyle çakışmasın)
    applyMode(); schedule();
  });
  runwayCb.addEventListener('change', () => { rwTouched = true; });
  // §31 hava durumu: görsel (bulut, yağış parçacıkları, ıslak zemin / kar örtüsü, görüş) — rüzgâr fiziği ayrı (hız/yön/esinti/türbülans)
  if (!WEATHER.includes(S.world.weather)) S.world.weather = 'clear';
  const weatherSeg = segmented(WEATHER.map(k => [k, `${WEATHER_ICONS[k]} ${tr(WEATHER_LABELS[k])}`]), S.world.weather, v => { S.world.weather = v; schedule(); });
  weatherSeg.classList.add('fs-weather-seg');
  const worldForm = h('div', { class: 'fs-world' },
    h('div', { class: 'fs-mode-row' }, h('span', { class: 'small muted' }, 'Dünya kipi'), worldModeSeg),
    h('div', { class: 'fs-mode-row fs-weather-row' }, h('span', { class: 'small muted' }, 'Hava durumu'), weatherSeg),
    modeHint,
    h('div', { class: 'fs-world-grid' },
      slider('size_m', 'Dünya boyutu', 1000, 10000, 500, 'm'),
      slider('tree_density', 'Ağaç sıklığı', 0, 1, 0.05, '', { pct: true }),
      slider('mountain_height', 'Dağ yüksekliği', 0, 1500, 25, 'm'),
      slider('mountain_count', 'Dağ sayısı', 1, 10, 1),
      slider('building_count', 'Bina sayısı', 0, 200, 5),
      slider('water', 'Su oranı', 0, 0.6, 0.05, '', { pct: true }),
      slider('fog', 'Sis', 0, 1, 0.05, '', { pct: true }),
      slider('wind_ms', 'Rüzgâr hızı', 0, 20, 0.5, 'm/s'),
      slider('wind_dir', 'Rüzgâr yönü', 0, 359, 1, '°'),
      slider('wind_gust', 'Esinti (gust)', 0, 15, 0.5, 'm/s'),   // §31: SIM_WIND_SPD üzerine sunucu esintisi
      slider('wind_turb', 'Türbülans', 0, 6, 0.5, 'm/s'),        // §31: SITL SIM_WIND_TURB
      slider('runway_heading', 'Pist yönü', 0, 359, 1, '°'),
      slider('landing_circle_m', 'İniş dairesi çapı', 10, 200, 5, 'm')),   // §18: görev bitiş noktasındaki H dairesi
    h('div', { class: 'fs-world-row' },
      h('label', { class: 'check' }, runwayCb, 'Pist'),
      h('div', { class: 'fs-time' }, h('span', { class: 'small muted' }, 'Saat'), timeSeg),
      seedBox));
  sliders.building_count.sl.range.addEventListener('input', () => { bcTouched = true; }); sliders.building_count.sl.input.addEventListener('change', () => { bcTouched = true; });
  applyMode();

  // ---------- 3a. güç ve yakıt (§23): azami hız · yakıt L + km/L · batarya S/mAh/W — varsayılanlar dron kaydından (son ölçümler), yoksa tip varsayılanı ----------
  const powerSec = createPowerSection({ h, tr, api, getType: activeType, getDroneId: () => S.drone, mock });
  powerSec.refresh().then(() => { if (P0?.power) { powerSec.set(P0.power); if (W.step === 'summary') drawSummary(); } });   // §27: kayıtlı güç ayarları önerinin üstüne
  // ---------- 3a''. hedefler (§24; isteğe bağlı, yalnız canlı kip): dairesel yörüngede sürekli uçan hedefler → önizlemede de çizilir ----------
  const tgMeta = meta.targets || { models: [] };
  let tgPrevT = 0;
  // §24.4 hedef kartlarında 3B önizleme: sihirbazın dünya önizlemesinin (preview) renderer'ı paylaşılır — ikinci WebGL bağlamı yok
  let tgViewer = null, tgViewerOf = null;
  const tgPreviews = createTargetPreviews({ tr, getViewer: () => { if (!preview?.createModelViewer) return null; if (tgViewerOf !== preview) { tgViewer = preview.createModelViewer(); tgViewerOf = preview; } return tgViewer; } });
  // ---------- 3a'''. yer kontrol sahası (§26; isteğe bağlı, yalnız canlı kip): radar / istasyon / EO + "Yer kontrolünü koru" (yalnız INTERCEPTOR) ----------
  // eslint-disable-next-line prefer-const
  let siteSec = null;
  siteSec = createSiteSection({ tr, getType: activeType, limits: meta.site || {}, initial: P0 ? { site: P0.site || { station: false, radar: false, eo: false }, defend: P0.defend || null } : null });   // §27: kayıtlı saha (yoksa kapalı)
  const targetsSec = createTargetsSection({ h, tr, catalog: tgMeta.models || [], limits: tgMeta, previews: tgPreviews, onChange: () => { clearTimeout(tgPrevT); tgPrevT = setTimeout(() => preview?.setTargets?.(targetsSec.enriched()), 250); } });
  if (P0?.targets) targetsSec.set(P0.targets);   // §27 kayıtlı hedefler
  // ---------- 3a''''. §33 karşılaşma: halkalar (sayı, min/max yükseklik, çap, parkur, süre; sunucu önizlemesi) + davet (iki liste) ----------
  // eslint-disable-next-line prefer-const
  let ringsSec = null;
  ringsSec = isMatch ? createRingsSection({ getType: activeType, getCenter: () => centerOf(), limits: mmeta?.limits }) : null;
  const inviteSec = isMatch ? createInviteSection({ users: mmeta?.users || [], limits: mmeta?.limits }) : null;
  // ---------- 3a'. kamera (§22.3): gündüz / termal / gece görüşü — önizlemeli kartlar (aynı formüllerle 2B tuvalde; ek WebGL bağlamı yok). Varsayılan:
  // dron kaydının son türü (sunucu) → bu dron için yerel son seçim → son tercih → gündüz. Seçim oturuma (`camera`), tercihe ve dron kaydına kalıcı.
  const camPrefs = createCamPrefs();
  let camTouched = !!P0?.camera;   // §27: kayıtlı kamera türü dron önerisine ezilmesin
  const camCards = createCameraCards({ tr, value: P0?.camera || camPrefs.type, palette: camPrefs.palette, onChange: t => { camTouched = true; camPrefs.setType(t); if (S.drone != null) camPrefs.rememberDrone(S.drone, t); }, onPalette: p => camPrefs.setPalette(p) });
  function camForDrone() { if (camTouched) return; const t = (S.drone != null && (droneCam.get(S.drone) || camPrefs.typeForDrone(S.drone))) || camPrefs.type; camCards.set(t); }
  const camNote = h('p', { class: 'small muted' }, '');
  const gtPick = createGaugeThemePicker({ tr });   // §27.3 gösterge tasarımı (önizlemeli kartlar; kalıcı tercih fs.gauge.theme — uçuşta G / kadran kutusu)
  const stepCam = h('div', { class: 'fs-cam-step' }, camNote, camCards.el, h('div', { class: 'fs-gt-wiz' }, gtPick.el));
  // ---------- 3b. kayıt seçenekleri (§17/§19): ☐ ekran kaydı (video) › ☐ Şirketten Haberler'de paylaş · ☐ uçuş logu (.bin; yalnız canlı) ----------
  const recOpts = recOptionsBox(tr, { getMode: () => S.mode });
  if (P0?.rec && typeof P0.rec.bin === 'boolean') recOpts.setBin(P0.rec.bin);   // §27 kayıtlı .bin seçimi

  // ---------- 3c. ön hazırlık kartı (§8): modül düzeyindeki prepareSessionCard; önizleme örneği ve ilerleme dinleyicisi (prepTap) buradan ----------
  const prepareSession = s => prepareSessionCard(s, { be, mock, world: S.world, preview, setTap: fn => { prepTap = fn; } });

  // ---------- 4. başlat (pencere altbilgisindeki "Başlat"; startBtn modal kurulduktan sonra atanır) ----------
  const goStep = k => { W.goto(k, { force: true }); draw(true); };   // doğrulama hatasında ilgili adıma dön
  // Canlı oturum gövdesi (Başlat ve §27 Kaydet ortak; kayıtlı simülasyonun `settings`i bunun aynısıdır)
  const sitlBody = () => ({ mode: 'sitl', type: S.type, center_id: S.center, world: { ...S.world }, model: modelBody(picker.selectionFor(activeType()), mock), drone_id: S.drone ?? undefined, rec: { bin: recOpts.bin }, power: powerSec.values(), layout: S.type === 'sabit_kanat' ? S.layout : undefined, drive: S.type === 'rover' ? driveOf() : undefined, camera: camCards.value,
    targets: targetsSec.values(), site: siteSec.values().site || undefined, defend: siteSec.values().defend || undefined });   // §23 güç ve yakıt · §13.1 kontrol düzeni · §22.3 kamera türü · §24 hedefler · §26 yer kontrol sahası + görev
  const preCheck = () => {   // Başlat / Kaydet öncesi: ilgili adıma dön
    if (S.mode === 'replay' && S.log == null) { toast('Önce bir uçuş logu seçin', 'err'); goStep('log'); return false; }
    if (S.mode === 'sitl' && S.center == null) { toast('Önce bir merkez seçin', 'err'); goStep('world'); return false; }
    if (isMatch) {   // §33
      if (ringsSec.error()) { toast(`${tr('Halkalar')}: ${tr(ringsSec.error())}`, 'err'); goStep('rings'); return false; }
      if (inviteSec.error()) { toast(tr(inviteSec.error()), 'err'); goStep('invite'); return false; }
      return true;
    }
    if (S.mode === 'sitl' && targetsSec.error()) { toast(`${tr('Hedefler')}: ${targetsSec.error()}`, 'err'); goStep('targets'); return false; }
    if (S.mode === 'sitl' && siteSec.error()) { toast(`${tr('Yer Kontrol Merkezi')}: ${siteSec.error()}`, 'err'); goStep('site'); return false; }
    return true;
  };
  // §27 Kaydet: ad sorulur (benzersiz; açıklama isteğe bağlı) → POST /presets (düzenlemede PUT) → pencere kapanır, kayıt listede seçili gelir
  const savePreset = async () => {
    if (mock) { toast(tr('Sahte veri kipinde kayıtlı simülasyon yok.'), 'err'); return; }
    if (!preCheck()) return;
    const settings = presetBodyFromSession(sitlBody());
    let list = [];
    try { list = await be.presets(); } catch { list = []; }
    let savedRow = null;
    const v = await askPresetName({ tr, list, initial: edit ? { name: edit.name, description: edit.description } : {}, excludeId: edit?.id ?? null, pilotName: pilotSel?.name || null,
      title: edit ? 'Kayıtlı simülasyonu güncelle' : 'Simülasyonu kaydet',
      save: async val => { const body = { ...val, pilot_id: pilotSel?.value ?? null, settings }; savedRow = edit ? await be.presetUpdate(edit.id, body) : await be.presetCreate(body); } });
    if (!v || !savedRow) return;
    toast(edit ? tr('Kayıtlı simülasyon güncellendi: {n}', { n: savedRow.name }) : tr('Simülasyon kaydedildi: {n}', { n: savedRow.name }));
    onSaved?.(savedRow);
    m.close();
  };
  // §33 Başlat (karşılaşma): POST /matches → bekleme salonu (davetlilere bildirim gider); SITL'ler herkes gelince açılır
  const startMatch = async () => {
    const body = sitlBody();
    for (const k of ['drone_id', 'targets', 'site', 'defend', 'rec']) delete body[k];
    let mt;
    try { mt = await matchApi.create({ settings: body, rings: ringsSec.values(), invite: inviteSec.values() }); } catch (err) {
      toast(err?.status === 409 ? (err.message || tr('Simülatör kapasitesi dolu')) : err.message, 'err');
      return true;
    }
    toast(tr('Karşılaşma oluşturuldu; davet bildirimleri gönderildi'));
    location.hash = matchHref(mt.id);   // hashchange → pencere kapanır
    return true;
  };
  const start = async () => {
    if (!preCheck()) return true;
    if (isMatch) return startMatch();
    if (S.mode === 'sitl' && !P0) setPref('fs.wz.last', JSON.stringify({ type: S.type, center: S.center, launch: { method: L.method, angle_deg: L.angle_deg, release_kmh: L.release_kmh, loaded: L.loaded, aim_az_deg: L.aim_az_deg, aim_el_deg: L.aim_el_deg } }));   // §6 son seçimler (§27 fırlatıcı alanları dahil)
    // §17: otomatik tam ekran (kullanıcı etkinleştirmesi içinde; reddedilirse sessiz) + kayıt açıksa ekran paylaşımı izni BİR KEZ, oturum açılmadan önce
    enterFullscreen();
    if (!mock && recPrefs.on) { const { stream, reason } = await acquireDisplayStream(); stashStream(stream); if (!stream && reason === 'denied') toast(tr('Ekran paylaşımı reddedildi; 3B sahne + HUD kaydedilecek (panel kayda girmez)')); }
    const geriAl = () => { takeStashedStream()?.getTracks().forEach(t => t.stop()); exitFullscreen(); if (back) back.hidden = false; };   // §17: oturum açılamadı/iptal → paylaşım akışı ve tam ekran bırakılır, pencere geri gelir
    // §28 kayıtlı simülasyon: ayrı başlatma geri sayımı yok — §29 oturum girişi (100 m bakış + 3-2-1 + sesli bip) her başlatmada çalışır (çift sayım olmasın)
    let s;
    try {
      const model = modelBody(picker.selectionFor(activeType()), mock);
      s = S.mode === 'replay'
        ? await be.create({ mode: 'replay', log_id: S.log, world: { ...S.world }, model, camera: camCards.value })   // §22.3: kayıt bu simülatörden ise kaydın türü önceliklidir
        : quick && !mock ? await be.presetStart(quick.id, { rec: { bin: recOpts.bin } })   // §27: sunucu kayıtlı gövdeyi kullanır (uçuş kaydı preset_id ile bağlanır)
          : await be.create(sitlBody());
    } catch (err) {
      const msg = quick ? null : { 400: S.mode === 'replay' ? 'Log açılamadı; analizi tamamlanmış bir .bin/.tlog seçin' : 'Geçersiz ayar; dünya değerlerini ve merkezi kontrol edin', 409: 'Oturum sınırı doldu; açık bir oturumu bitirin', 503: 'SITL hazır değil (ikili ya da boş port yok)' }[err?.status];
      toast(msg || err.message, 'err');
      geriAl();
      return true;
    }
    // §8 ön hazırlık: pencere gizlenir, hazırlık kartı görünür; her şey (sunucu HAZIR + kareler + dünya verisi) hazır olunca içeri gir
    if (back) back.hidden = true;
    if (!await prepareSession(s)) { geriAl(); return true; }
    toast(S.mode === 'replay' ? 'Kayıttan oynatma oturumu açıldı' : 'Simülatör oturumu açıldı');
    location.hash = be.href(s.id);   // hashchange → pencere kapanır (önizleme serbest kalır)
    return true;
  };
  const limits = meta.limits || {};
  // ======================================================================
  // Adım adım sihirbaz (§6): üstte ilerleme şeridi (numaralı; tamamlananlar ✓, tıklanıp dönülebilir), her adımda yalnız o konunun alanları,
  // altbilgide Geri / İleri (son adımda ▶ Başlat). Adım listesi kip + etkin tipe göre (flightsim_wizard.wizardSteps): kopterde Kalkış yok;
  // kayıtta Güç / Hedefler / Yer kontrol yok. Doğrulama: geçersiz adımda İleri pasif + açıklama. Enter = İleri, Esc = kapat.
  // 3B önizleme sağ sütunda (Araç / Dünya / Kalkış / Hedefler adımlarında görünür; diğerlerinde gizli ama yaşar — model küçük resimleri ve hedef önizlemeleri onu kullanır).
  // ======================================================================
  const valid = k => {
    if (k === 'log') return !logsAllowed ? tr('Uçuş loglarına erişim için Araçlar ya da Saha Yönetimi yetkisi gerekir.') : S.logs === null ? tr('Uçuş logları yükleniyor…') : S.log == null ? (S.pinned ? tr('Uçuş logu bulunamadı ya da erişim yetkiniz yok.') : tr('Bir uçuş logu seçin.')) : null;
    if (k === 'world' && S.mode === 'sitl' && S.center == null) return centers.length ? tr('Bir merkez seçin.') : tr('Kayıtlı merkez yok — önce Rotalar › Merkezler bölümünden bir merkez ekleyin.');
    if (k === 'targets' && S.mode === 'sitl') return targetsSec.error() || null;
    if (k === 'site' && S.mode === 'sitl') return siteSec.error() || null;
    if (k === 'rings') return ringsSec ? (ringsSec.error() ? tr(ringsSec.error()) : S.center == null ? tr('Önce bir merkez seçin.') : null) : null;   // §33
    if (k === 'invite') return inviteSec ? (inviteSec.error() ? tr(inviteSec.error()) : null) : null;
    if (k === 'summary' && !canWrite) return tr('Oturum açmak için Dron Yönetimi yazma izni gerekir; açık oturumları izleyebilirsiniz.');
    return null;
  };
  const W = createStepper({ getSteps: () => wizardSteps({ mode: S.mode, type: activeType(), match: isMatch }), valid });
  const sec = (title, ...kids) => h('div', { class: 'fs-wz-sec' }, title ? h('h4', { class: 'fs-wz-sec-h' }, title) : null, ...kids);
  const centerSec = sec('Merkez', h('p', { class: 'small muted' }, 'Sanal dünyanın merkezi ve kalkış noktası. Mission Planner haritası bu koordinatı gösterir.'), centerList);
  const worldHint = h('p', { class: 'small muted', hidden: true }, 'Dünya kaydın kalkış noktası etrafında kurulur (pist seviyesi = kalkış irtifası); çarpışma denetimi kapalıdır. Prosedürel kipte arazi gerçek araziyle örtüşmez; gerçek kipte kalkış noktasının çevresi gerçek yükseklik ve uydu görüntüsüyle kurulur.');
  const summaryBox = h('div', { class: 'fs-wz-sum' });
  // §27 özet adımı üstü: (kayıtlı başlatmada) kayıt başlığı · azami süre/menzil kutusu · pilot ataması (Kaydet ile)
  const sumExtra = h('div', { class: 'fs-wz-sumx' });
  const pilotSel = canWrite && !quick && !mock && !isMatch ? pilotPicker({ tr, be, me: user?.id ?? null, value: edit ? edit.pilot_id : null }) : null;
  const startNote = h('div', { class: 'small muted fs-wz-note' });
  const panel = (key, ...kids) => h('section', { class: 'fs-wz-panel', 'data-step': key, hidden: true }, ...kids);
  const panels = {
    vehicle: panel('vehicle', sec('Dron tipi', typeCards), isMatch ? null : sec('Dron kaydı (isteğe bağlı)', droneBox), modelBox, layoutBox, driveBox),   // §33 karşılaşmada dron kaydı yok
    log: panel('log', stepLog),
    world: panel('world', centerSec, worldHint, sec('Dünya', worldForm)),
    launch: panel('launch', launchBox),
    power: panel('power', powerSec.el),
    camera: panel('camera', stepCam),
    targets: panel('targets', targetsSec.el),
    site: panel('site', siteSec.el),
    summary: panel('summary', sumExtra, summaryBox, canWrite && !isMatch ? recOpts.el : null, startNote),
    ...(isMatch ? { rings: panel('rings', ringsSec.el), invite: panel('invite', inviteSec.el) } : {}),   // §33
  };
  const strip = h('ol', { class: 'fs-wz-strip', role: 'list' });
  const phNo = h('span', { class: 'fs-wz-ph-n' }), phTitle = h('h3', { class: 'fs-wz-ph-t' }), phDesc = h('p', { class: 'small muted fs-wz-ph-d' });
  const aside = h('aside', { class: 'fs-wz-aside' }, previewBox, previewInfo);
  const main = h('div', { class: 'fs-wz-main' }, h('div', { class: 'fs-wz-content' }, h('div', { class: 'fs-wz-ph' }, phNo, phTitle, phDesc), Object.values(panels)), aside);
  const why = h('span', { class: 'small fs-wz-why', role: 'status' });
  const backBtn = h('button', { type: 'button', class: 'btn fs-wz-back', onclick: () => { if (W.back()) draw(true); } }, '‹ Geri');
  const nextBtn = h('button', { type: 'button', class: 'btn primary fs-wz-next', onclick: () => goNext() }, 'İleri ›');
  let startBtn = null, back = null;
  startBtn = h('button', { type: 'button', class: 'btn primary fs-start', onclick: async () => { startBtn.disabled = true; try { await start(); } catch (err) { toastError(err); } finally { if (startBtn.isConnected) drawFoot(); } } }, '▶ Başlat');
  // §27: son adımda "Uç" (nabız animasyonu; prefers-reduced-motion'da sakin halka) + yanında "Kaydet" (ad sorar; düzenlemede aynı kaydı günceller)
  const FLY_ICO = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2.5 13.5 21 6l-4.5 14-4-6.5z"/><path d="m12.5 13.5 8.5-7.5"/></svg>';
  const saveBtn = h('button', { type: 'button', class: 'btn fs-wz-save', 'data-act': 'save', onclick: async () => { saveBtn.disabled = true; try { await savePreset(); } catch (err) { toastError(err); } finally { if (saveBtn.isConnected) drawFoot(); } } }, 'Kaydet');
  const goNext = () => { if (W.next()) draw(true); else drawFoot(); };
  const ICON_OK = '✓', ICON_ERR = '!';
  const drawStrip = () => clear(strip, W.states().map(st => {
    const d = stepDef(st.key);
    return h('li', { class: `fs-wz-chip ${st.on ? 'on' : ''} ${st.done ? 'done' : ''} ${st.err ? 'err' : ''} ${st.reach ? '' : 'lock'}`.replace(/\s+/g, ' ').trim(), 'data-step': st.key },
      h('button', { type: 'button', disabled: !st.reach && !st.on, 'aria-current': st.on ? 'step' : undefined, title: tr(d.title),
        onclick: () => { if (W.goto(st.key)) draw(true); } },
        h('span', { class: 'fs-wz-dot' }, st.err ? ICON_ERR : st.done ? ICON_OK : String(st.n)),
        h('span', { class: 'fs-wz-lbl' }, h('b', null, d.title), d.optional ? h('small', null, 'isteğe bağlı') : null)));
  }));
  const drawFoot = () => {
    const steps = W.steps, err = W.error(), lastStep = W.isLast();
    backBtn.hidden = W.isFirst() || !!quick;
    phNo.textContent = tr('Adım {i} / {n}', { i: steps.indexOf(W.step) + 1, n: steps.length });
    nextBtn.hidden = lastStep; nextBtn.disabled = !!err;
    const bad = firstInvalid(steps, valid);
    startBtn.hidden = !lastStep || !!edit;   // düzenlemede yalnız Kaydet
    startBtn.disabled = !canWrite || !!bad;
    const fly = S.mode === 'sitl' && !isMatch;   // §33 karşılaşma: "▶ Başlat" (Uç / Kaydet yok)
    startBtn.classList.toggle('fs-wz-fly', fly);
    if (isMatch) { if (startBtn.dataset.lbl !== 'match') { startBtn.textContent = tr('▶ Başlat'); startBtn.dataset.lbl = 'match'; startBtn.title = tr('Karşılaşmayı oluştur: bekleme salonu açılır, davetlilere bildirim gider'); } }
    else if (fly) { if (startBtn.dataset.lbl !== 'fly') { startBtn.innerHTML = `${FLY_ICO}<span>${tr('Uç')}</span>`; startBtn.dataset.lbl = 'fly'; startBtn.title = quick ? tr('Kayıtlı ayarlarla başlat (3 sn geri sayım)') : tr('Bu ayarlarla şimdi uç (kaydetmeden)'); } }
    else { startBtn.textContent = tr('▶ Oynat'); startBtn.dataset.lbl = 'play'; startBtn.title = ''; }
    saveBtn.hidden = !lastStep || !fly || !!quick;
    saveBtn.disabled = !canWrite || !!bad || mock;
    saveBtn.classList.toggle('primary', !!edit);
    saveBtn.textContent = tr(edit ? 'Kaydet (güncelle)' : 'Kaydet');
    saveBtn.title = mock ? tr('Sahte veri kipinde kayıtlı simülasyon yok.') : tr(edit ? 'Değişiklikleri bu kayıtlı simülasyona yaz' : 'Ayarları adla kaydet: atanan pilot Kayıtlı Simülasyonlar\'dan defalarca başlatır');
    why.textContent = err || (lastStep && bad ? `${tr(stepDef(bad).title)}: ${valid(bad)}` : '');
    why.classList.toggle('err', !!(err || (lastStep && bad)));
    body.style.setProperty('--wz-prog', `${steps.length > 1 ? Math.round(steps.indexOf(W.step) / (steps.length - 1) * 100) : 100}%`);
    drawStrip();
    const on = strip.querySelector('.fs-wz-chip.on');   // dar ekranda geçerli adım şeritte görünür kalsın (yalnız yatay kaydırma)
    if (on && strip.scrollWidth > strip.clientWidth) strip.scrollLeft = Math.max(0, on.offsetLeft - strip.offsetLeft - (strip.clientWidth - on.offsetWidth) / 2);
  };
  const fmtKm = m => (Number(m) >= 1000 ? `${(Number(m) / 1000).toFixed(Number(m) % 1000 ? 1 : 0)} km` : `${f0(m)} m`);
  const drawSummary = () => {
    const t = activeType(), lg = (S.logs || []).find(x => x.id === S.log), sel = picker.selectionFor(t);
    const W0 = S.world, pv = powerSec.values(), sv = siteSec.values(), tg = targetsSec.enriched();
    const worldName = tr({ real: 'Gerçek arazi', google3d: 'Google 3B (fotogerçekçi)', procedural: 'Prosedürel' }[W0.mode] || W0.mode);
    const timeName = tr({ day: 'Gündüz', dusk: 'Akşam', night: 'Gece' }[W0.time] || W0.time);
    const rows = {
      vehicle: [['Dron tipi', types.find(x => x.key === S.type)?.name || TYPE_NAME[S.type] || S.type], ['Görsel model', sel?.name || '—'],
        S.type === 'sabit_kanat' ? ['Kontrol düzeni', layoutLabel(S.layout, tr)] : null, S.type === 'rover' ? ['Sürüş biçimi', tr(DRIVE_NAME[driveOf()])] : null, ['Dron kaydı', S.drone != null ? droneSel.selectedOptions[0]?.textContent || `#${S.drone}` : tr('Yok — "Simülatör #N" sanal dronu')]],
      log: [['Uçuş logu', lg?.file_name || '—'], lg ? ['Araç', [TYPE_NAME[lg.type] || lg.type, lg.aircraft].filter(Boolean).join(' · ')] : null, lg && (lg.flight_s ?? lg.duration_s) != null ? ['Süre', fmtDuration(lg.flight_s ?? lg.duration_s)] : null, ['Görsel model', sel?.name || '—']],
      world: [S.mode === 'sitl' ? ['Merkez', centerOf() ? `${centerOf().name} · ${Number(centerOf().lat).toFixed(4)}, ${Number(centerOf().lon).toFixed(4)}` : '—'] : null,
        ['Dünya kipi', `${worldName} · ${fmtKm(W0.size_m)}`], ['Saat', timeName], ['Hava durumu', tr(WEATHER_LABELS[normWeather(W0.weather)])], ['Rüzgâr', `${W0.wind_ms} m/s · ${W0.wind_dir}°${Number(W0.wind_gust) > 0 ? ` · ${tr('esinti')} +${W0.wind_gust}` : ''}${Number(W0.wind_turb) > 0 ? ` · ${tr('türbülans')} ${W0.wind_turb}` : ''}`], ['Sis', `%${Math.round(W0.fog * 100)}`],
        S.type === 'rover' && W0.runway === false ? null : ['Pist', W0.runway === false ? tr('Kapalı') : `${tr('Açık')} · ${W0.runway_heading}°`]],
      launch: [['Kalkış yöntemi', launchLabel(L, tr)]],
      power: [isPlane(t) && pv.max_speed_ms ? ['Azami hız', `${pv.max_speed_ms} m/s (${Math.round(pv.max_speed_ms * 3.6)} km/h)`] : null,
        ['Yakıt', pv.fuel_l > 0 ? `${pv.fuel_l} L · ${pv.fuel_km_per_l} km/L` : tr('Yok')],
        ['Batarya', pv.elec_mah ? `${pv.elec_cells}S · ${pv.elec_mah} mAh · ${pv.elec_w} W` : '—']],
      camera: [['Kamera türü', camTypeLabel(camCards.value, tr)], ['Gösterge tasarımı', tr(gaugeThemeLabel(gtPick.value))]],
      targets: [['Hedefler', tg?.items?.length ? tr('{n} hedef', { n: tg.items.length }) : tr('Hedef yok')], tg?.items?.length ? ['Modeller', tg.items.map(x => x.model_name || x.model).join(', ')] : null,
        tg?.items?.length ? ['Önleme yarıçapı', `${tg.radius_m} m`] : null],
      rings: isMatch ? [['Halkalar', ringsSummary(ringsSec.values())], ['Süre sınırı', tr('{n} dk', { n: ringsSec.values().time_limit_min })], ['Parkur tohumu', String(ringsSec.values().seed)]] : [],   // §33
      invite: isMatch ? [['Davet edilenler', inviteSec.names().join(', ') || '—'], ['Oyuncu sayısı', tr('{n} (siz dahil)', { n: inviteSec.values().length + 1 })]] : [],
      site: [['Saha', sv.site ? [sv.site.radar ? `${tr('Radar')} ${sv.site.radar_km} km` : null, sv.site.station ? tr('İstasyon') : null, sv.site.eo ? `EO ${sv.site.eo_km} km` : null].filter(Boolean).join(' · ') : tr('Yok')],
        ['Görev', sv.defend ? tr('Yer kontrolünü koru · {w} dalga · {i} önleyici', { w: sv.defend.waves, i: sv.defend.interceptors }) : tr('Serbest uçuş')]],
    };
    // §27: azami süre / menzil (yalnız canlı) + kayıtlı başlatmada başlık + pilot ataması
    clear(sumExtra,
      quick ? h('div', { class: 'fs-wz-quick-h' }, h('span', { html: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 3h12v18l-6-4-6 4z"/></svg>' }),
        h('div', null, h('b', null, quick.name), h('small', null, [quick.description, quick.pilot_name ? tr('Pilot: {p}', { p: quick.pilot_name }) : null, quick.created_by_name ? tr('Tasarlayan: {p}', { p: quick.created_by_name }) : null].filter(Boolean).join(' · ')))) : null,
      S.mode === 'sitl' ? budgetBox({ tr, budget: flightBudget(pv, t) }) : null,
      S.mode === 'sitl' && pilotSel ? pilotSel.el : null,
      isMatch ? h('div', { class: 'alert info fs-mt-note' }, tr('Başlat’a basınca bekleme salonu açılır ve davet edilenlere bildirim gider. Herkes salona gelince her oyuncuya aynı dünyada farklı bir başlangıç noktasında simülatör açılır; geri sayımdan sonra kalkış serbesttir. Tüm halkaları ilk geçen kazanır.')) : null);
    const steps = W.steps.filter(k => k !== 'summary');
    clear(summaryBox, h('div', { class: 'fs-wz-sum-grid' }, steps.map(k => {
      const e = valid(k), d = stepDef(k);
      return h('div', { class: `fs-wz-sum-card ${e ? 'err' : ''}`, 'data-step': k },
        h('div', { class: 'fs-wz-sum-h' }, h('span', { class: 'fs-wz-dot' }, String(W.steps.indexOf(k) + 1)), h('b', null, d.title),
          quick ? null : h('button', { type: 'button', class: 'btn sm ghost fs-wz-edit', onclick: () => { W.goto(k, { force: true }); draw(true); } }, 'Düzenle')),
        h('dl', null, (rows[k] || []).filter(Boolean).map(([a, b]) => [h('dt', null, a), h('dd', null, b)])),
        e ? h('div', { class: 'small fs-wz-sum-err' }, e) : null);
    })));
  };
  let lastDrawn = null;
  const draw = (scroll = false) => {
    void W.steps; const cur = W.step, d = stepDef(cur);   // liste okunurken adım uzlaşır (tip değişimi)
    Object.entries(panels).forEach(([k, p]) => { p.hidden = k !== cur; });
    body.dataset.step = cur;
    aside.hidden = !d.preview;
    main.classList.toggle('no-aside', !d.preview);
    clear(phTitle, d.title, d.optional ? h('span', { class: 'badge gray' }, 'isteğe bağlı') : null);
    phDesc.textContent = tr(d.desc);
    if (cur === 'summary') drawSummary();
    if (cur === 'camera') { camCards.redraw?.(); gtPick.redraw(); }
    if (cur === 'site') siteSec.refresh();
    if (cur === 'rings') ringsSec?.refresh();   // §33 önizleme (merkez/tip değişmiş olabilir)
    preview?.setPreviewFocus?.(cur === 'launch' ? 'rig' : null);   // Kalkış adımı: önizleme kamerası düzeneğe yakın tur atar
    drawFoot();
    if (scroll || lastDrawn !== cur) { const mb = body.closest('.modal-body'); if (mb) mb.scrollTop = 0; }
    lastDrawn = cur;
  };
  const drawMode = () => {
    const rp = S.mode === 'replay';
    centerSec.hidden = rp; worldHint.hidden = !rp;
    camNote.textContent = tr(rp ? 'Gimbal ve FPV kameralarının görüntü türü. Kayıt bu simülatörde yapıldıysa kaydın kamera türü kullanılır; uçuş içinde T ile değiştirilebilir.' : 'Gimbal ve FPV kameralarının görüntü türü; PiP penceresi de bu türle gösterir. Uçuş içinde T ile değiştirilebilir (Shift+T: termal paleti).');
    clear(startNote, isMatch ? tr('Karşılaşma oyuncu simülatörleri ayrı sınırla açılır (eşzamanlı en çok {n}; şu an {u} kullanımda).', { n: mmeta?.capacity?.max ?? '—', u: mmeta?.capacity?.used ?? 0 }) : canWrite
      ? (rp ? tr('Kayıt sunucuda bir kez ayrıştırılır ve önbelleğe alınır; SITL ve Mission Planner köprüsü açılmaz.') : tr('En çok {n} eşzamanlı oturum · oturum süresi {m} dk', { n: limits.max_sessions ?? '—', m: limits.max_minutes ?? '—' }))
      : 'Oturum açmak için Dron Yönetimi yazma izni gerekir; açık oturumları izleyebilirsiniz.');
    if (rp) panels.log.append(modelBox); else panels.vehicle.insertBefore(modelBox, layoutBox);   // model bölümü: canlı kipte Araç adımında (düzenin üstünde), kayıtta log listesinin altında
    recOpts.sync();   // .bin seçeneği yalnız canlı SITL'de
    drawLaunch(); drawLayout(); drawDrive();
    if (rp && S.logs === null) loadLogs().then(() => { refreshModels(); const st = wizardStartStep({ mode: S.mode, pinned: S.pinned }); if (st && S.log != null && W.step === W.steps[0]) { W.goto(st, { force: true }); draw(true); } else draw(); }); else refreshModels();   // §8.5 "Simüle et": log hazırsa Dünya (atmosfer) adımına
  };
  const modeSeg = segmented([['sitl', 'Canlı simülasyon (SITL + Mission Planner)'], ['replay', 'Kayıttan oynat']], S.mode, v => { S.mode = v; drawMode(); W.goto(W.steps[0], { force: true }); draw(true); });
  // §8.5 "Simüle et": kip seçimi yok (kayıttan oynat sabit) — yerine bilgi bandı
  const pinNote = S.pinned ? h('div', { class: 'fs-mode-row fs-pin-note' }, h('span', { class: 'badge purple' }, tr('Simüle et')),
    h('span', { class: 'small muted' }, tr('Seçilen uçuş kaydı oynatılacak: atmosferi (dünya, saat, hava, rüzgâr), kalkışı/rampayı ve kamerayı seçin.'))) : null;
  const body = h('div', { class: 'fs-wizard fs-wz' },
    h('div', { class: 'fs-wz-top' }, pinNote || (isMatch ? h('div', { class: 'fs-mode-row fs-pin-note' }, h('span', { class: 'badge green' }, tr('Karşılaşma')),
      h('span', { class: 'small muted' }, tr('Çok oyunculu halka yarışı: Yeni Simülasyon ile aynı ayarlar; radar, elektro-optik ve yer kontrol yok. Sonunda kullanıcıları davet edip başlatın.'))) : null) || h('div', { class: 'fs-mode-row' }, h('span', { class: 'small muted' }, 'Kip'), modeSeg), strip),
    main);
  // Alan değişiklikleri doğrulamayı etkileyebilir (merkez, log, hedef, saha, tip → adım listesi): şerit + altbilgi kare başına bir kez yenilenir
  let footRaf = 0;
  const softRefresh = () => { if (footRaf) return; footRaf = requestAnimationFrame(() => { footRaf = 0; if (!disposed) { if (!panels[W.step] || panels[W.step].hidden) draw(); else drawFoot(); } }); };
  for (const ev of ['click', 'input', 'change']) body.addEventListener(ev, softRefresh);
  // Pencere: başlık "Yeni Simülasyon Başlat", kaydırılabilir gövde, altbilgi "İptal et" · gerekçe · "‹ Geri" · "İleri ›" / "▶ Başlat". Kapanış: önizleme serbest, sayfa yenilenir.
  let disposed = false;
  const onKey = e => {   // Enter = İleri (son adımda Başlat); metin alanı / seçim / bağlantı / altbilgi / şerit / başka pencere hariç
    if (e.key !== 'Enter' || e.defaultPrevented || e.isComposing || e.shiftKey || e.ctrlKey || e.altKey || e.metaKey || disposed || !back || back.hidden) return;
    if ([...document.querySelectorAll('.modal-back')].pop() !== back) return;
    const tg = e.target instanceof Element ? e.target : null;
    if (tg && (tg.closest('textarea, select, a[href], [contenteditable="true"], .modal-foot, .fs-wz-strip, .x-btn') || (tg.closest('.modal-back') && tg.closest('.modal-back') !== back))) return;
    e.preventDefault();
    if (W.isLast()) { if (!startBtn.disabled && !startBtn.hidden) startBtn.click(); else if (!saveBtn.disabled && !saveBtn.hidden) saveBtn.click(); } else if (!nextBtn.disabled) goNext(); else drawFoot();
  };
  document.addEventListener('keydown', onKey);
  const m = modal({ title: isMatch ? tr('Yeni Karşılaşma') : quick ? tr('Kayıtlı simülasyon: {n}', { n: quick.name }) : edit ? tr('Kayıtlı simülasyonu düzenle: {n}', { n: edit.name }) : S.pinned ? tr('Uçuşu simüle et') : tr('Yeni Simülasyon Başlat'), body, wide: true,
    actions: [{ label: tr('İptal et'), class: 'ghost fs-wizard-cancel' }],
    onClose: () => { disposed = true; document.removeEventListener('keydown', onKey); cancelAnimationFrame(footRaf); clearTimeout(rebuildT); tgPreviews.dispose(); preview?.dispose(); preview = null; if (typeof window !== 'undefined' && window.__fsWz?.W === W) delete window.__fsWz; onClosed?.(); } });
  m.el.classList.add('fs-wizard-modal');
  back = m.el.parentElement;
  m.el.querySelector('.modal-foot')?.append(h('span', { class: 'spacer' }), why, backBtn, nextBtn, saveBtn, startBtn);
  // Testler / görsel betikler: window.__fsWz.goto('targets') (doğrulamasız atlama), .steps, .step
  window.__fsWz = { W, goto: k => { const ok = W.goto(k, { force: true }); draw(true); return ok; }, get steps() { return W.steps; }, get step() { return W.step; } };
  drawMode();
  if (quick) { body.classList.add('fs-wz-quick'); body.querySelector('.fs-wz-top').hidden = true; W.goto('summary', { force: true }); }   // §27: yalnız özet + Uç
  draw();

  // 3B önizleme (küçük, kendi etrafında dönen kamera); pencere kapanınca serbest bırakılır (sayfa değişiminde de)
  try {
    if (S.world.mode === 'real') progInfo(null);
    const c0 = centerOf();
    const p = await createFlightSim3D(previewBox, S.world, { preview: true, type: activeType(), model: picker.selectionFor(activeType()) || undefined, origin: c0 ? { lat: c0.lat, lon: c0.lon, alt: c0.alt } : undefined, onProgress: progInfo, onFallback, g3dKey: be.g3dKey, launch: { ...L } });
    if (disposed) { p.dispose(); return m; }
    preview = p;
    previewBox.querySelector('.fs-preview-msg')?.remove();
    const sel = picker.selectionFor(activeType()); if (sel) { preview.setType(activeType(), sel).then(() => picker.drawInfo()); picker.redraw(); }
    preview.setTargets?.(targetsSec.enriched());   // §24: önizlemede hedef yörüngeleri
    preview.setPreviewFocus?.(W.step === 'launch' ? 'rig' : null);
    picker.ensureThumbs();   // 3B sahne hazır: eksik küçük resimler artık üretilebilir (snapshotModel)
    if (preview.terrainInfo) progInfo({ stage: 'done', real: preview.real, ...preview.terrainInfo });
  } catch (err) {
    clear(previewBox, h('div', { class: 'fs-preview-msg' }, tr('3B önizleme açılamadı: {e}', { e: err.message })));
  }
  onLeave(() => { clearTimeout(rebuildT); tgPreviews.dispose(); preview?.dispose(); preview = null; });
  return m;
}

const randomSeed = () => Math.floor(Math.random() * 2147483646) + 1;
// Hatırlanan kalkış ayarı: yalnız bilinen yöntem ve sınır içindeki sayılar (bozuk yerel kayıt gövdeyi bozmasın)
function pickLaunch(l) {
  const o = {};
  if (LAUNCH_OPTIONS.some(x => x.key === l.method)) o.method = l.method;
  for (const [k, d] of Object.entries(LAUNCH_PARAM_DEFS)) { const f = paramField(k), v = Number(l[f]); if (l[f] != null && Number.isFinite(v) && v >= d.min && v <= d.max && o[f] == null) o[f] = v; }
  return o;
}

// ======================================================================
// Oturum ekranı: tam alan 3B + HUD + Mission Planner kutusu + araç çubuğu + olaylar + çarpışma bandı
// ======================================================================
async function renderSession(view, ctx, be, sid, { mock, canWrite, netsim = null, rigdiag = false, matchId = null }) {
  let session;
  try { session = await be.session(sid); } catch (err) {
    clear(view, h('div', { class: 'card empty' }, h('p', null, h('b', null, 'Oturum bulunamadı.')), h('p', { class: 'small muted' }, err.message),
      h('a', { class: 'btn', href: be.href() }, 'Simülatör ana sayfası')));
    return;
  }
  const replay = session.mode === 'replay';   // kayıttan oynatma: SITL/UDP/komut yok; kareler sunucudan bir kez çekilir, tarayıcıda oynatılır
  const type = session.type, modes = modesFor(type);
  const rover = isRoverType(type), drive = rover ? normDrive(session.drive || session.model?.drive) : null;   // §31 kara aracı + sürüş biçimi
  const world = { ...WORLD_DEFAULTS, ...(session.world || {}) };
  // Sabit kanat kalkış yöntemi (§13): session.launch {method, angle_deg, release_kmh, phase}. Canlıda aşamalar sunucudan (WS `launch`); kayıtta
  // (§8) sunucu olay yaymaz, aşamalar log karelerinden türetilir (replayLaunchTimeline) ve oynatıcı zamanına göre uygulanır (atlamada `snap`).
  // §27 INTERCEPTOR fırlatıcısı (pod4 | pod8 | tube | handheld): aynı `launch` nesnesi; aşamalar sunucudan (canlı) / logdan (kayıt, AGL 1,5 m)
  const lsrc = session.launch || world.launch || {};
  const launch = type === 'sabit_kanat' || (type === 'interceptor' && isIceptLauncher(lsrc.method)) ? { ...LAUNCH_DEFAULTS, ...lsrc } : null;
  const LAUNCH_BTN = { ramp: 'Fırlat', vehicle: 'Aracı sür', wheels: 'Kalkış', pod4: 'Fırlat', pod8: 'Fırlat', tube: 'Fırlat', handheld: 'Fırlat' };
  const ICEPT_TXT = { armed: 'Interceptor fırlatıcıda, motor hazır', launch: 'FIRLATMA', released: 'Interceptor fırlatıcıdan çıktı' };
  const LAUNCH_PHASE_TEXT = { armed: { ramp: 'Uçak rampada, motor hazır', vehicle: 'Uçak araçta, motor hazır', wheels: 'Pist koşusu başlıyor' },
    launch: { ramp: 'FIRLATMA', vehicle: 'Araç hızlanıyor', wheels: 'Pist koşusu' }, released: { ramp: 'Uçak rampadan ayrıldı', vehicle: 'BIRAKILDI', wheels: 'Uçak havalandı' } };
  for (const ph of Object.keys(ICEPT_TXT)) for (const m of ['pod4', 'pod8', 'tube', 'handheld']) LAUNCH_PHASE_TEXT[ph][m] = ICEPT_TXT[ph];
  let launcherUi = null;   // §27 (oturum ekranı kurulunca)

  // ---------- iskelet ----------
  const stage = h('div', { class: `fs-stage ${replay ? 'fs-replay' : ''}`, 'data-immersive': '1' });
  const mount = h('div', { class: 'fs-canvas' });
  const msg = h('div', { class: 'fs-msg' }, '3B dünya hazırlanıyor…');
  const crash = h('div', { class: 'fs-crash', hidden: true }, h('b', null, 'ÇARPIŞMA'), h('span', { class: 'fs-crash-sub' }));
  const events = h('div', { class: 'fs-events' });
  const stateBadge = h('span', { class: `badge ${STATE_BADGE[session.state] || 'gray'}` }, STATE_TEXT[session.state] || session.state);
  const wsBadge = h('span', { class: 'badge gray', title: 'Telemetri bağlantısı (WebSocket)' }, 'Bağlanıyor…');
  // "← Geri" (§21 geri bildirim): yuvarlak, yarı saydam, hover'da genişleyip "Geri" yazar; tam ekrandan çıkar + önceki sayfaya döner
  // (ui.js goBack; klavye Escape ile aynı: tam ekranda Escape'i tarayıcı yakalar ve çıkar, tam ekran dışında Escape → geri; aşağıda onKeyBack)
  const backBtn = h('a', { class: 'fs-back', href: be.href(), title: tr('Geri (Esc)'), 'aria-label': tr('Geri'),
    onclick: e => { e.preventDefault(); goBack(be.href()); } }, h('span', { class: 'fs-back-ico', 'aria-hidden': 'true' }, '←'), h('span', { class: 'fs-back-txt' }, 'Geri'));
  // §23 simülasyon hızı kapsülü (üst çubuk; panelde aynı seçici): cmd speed {factor} → SITL SIM_SPEEDUP; seçili düğme tele.speedup ile eşitlenir
  const speedPill = createSpeedPill({ h, tr, onPick: f => { if (!canWrite) { toast(tr('Simülasyon hızı için yazma izni gerekir'), 'err'); return; } cmd('speed', { factor: f }); } });
  if (!canWrite) speedPill.setEnabled(false);
  const nav = h('div', { class: 'fs-nav' },
    backBtn,
    h('b', null, 'Uçuş Simülatörü'), h('span', { class: 'fs-nav-sub' }, `${TYPE_NAME[type] || type} · ${(replay ? session.replay?.file_name : session.center?.name) || '—'}`), stateBadge, wsBadge,
    replay ? h('span', { class: 'badge purple', title: 'Kayıttan oynatma: yüklü uçuş logu aynen oynatılır; kontrol yok' }, 'Kayıt') : null,
    launch ? h('span', { class: 'badge blue fs-launch-badge', title: tr('Kalkış yöntemi') }, launchLabel(launch, tr)) : null,
    session.layout ? h('span', { class: `badge ${session.layout_effective && session.layout_effective !== session.layout ? 'yellow' : 'gray'} fs-layout-badge`, title: `${tr('Kontrol düzeni')}: ${layoutLabel(session.layout, tr)}${session.layout_sitl_model ? ` · SITL ${session.layout_sitl_model}` : ''}${session.layout_effective && session.layout_effective !== session.layout ? ` · ${tr('kalıcı kayıt öncelikli')}: ${layoutShort(session.layout_effective, tr)}` : ''}` }, layoutShort(session.layout, tr)) : null,   // §13.1
    rover ? h('span', { class: 'badge gray fs-drive-badge', title: `${tr('Sürüş biçimi')}: ${tr(DRIVE_NAME[drive])}` }, DRIVE_NAME[drive]) : null,   // §31
    mock ? h('span', { class: 'badge purple' }, 'Sahte veri') : null,
    replay ? null : speedPill.el,   // §23 simülasyon hızı 1×/2×/4×/8× (SIM_SPEEDUP); yazma izni yoksa yalnız gösterir
    h('button', { class: 'fs-nav-btn fs-full-btn', type: 'button', title: 'Tam ekran', onclick: () => { (document.fullscreenElement ? document.exitFullscreen?.() : document.documentElement.requestFullscreen?.())?.then(() => onFullChange()).catch(() => {}); } }, '⛶'));
  // Tam ekran BELGEYE (document.documentElement) uygulanır, sahneye değil: ui.js modal()/toast() ve açılır menüler body'ye eklenir; sahne
  // (.fs-stage) tam ekran öğesi olsaydı bunlar tam ekran öğesinin dışında kalır ve GÖRÜNMEZDİ (kullanıcı: "tam ekrandayken mesaj pencereleri
  // arkada kalıyor, takeoff yüksekliği görünmüyor"). Belge tam ekranda: app.js `immersive` (data-immersive) üst başlığı/alt barı gizler,
  // body.fs-full + .fs-stage.fs-full sahneyi tüm ekrana yayar; çıkınca (Escape / ⛶) düzen eski hâline döner.
  const onFullChange = () => { const full = !!document.fullscreenElement; stage.classList.toggle('fs-full', full); document.body.classList.toggle('fs-full', full); const b = nav.querySelector('.fs-full-btn'); if (b) b.title = tr(full ? 'Tam ekrandan çık' : 'Tam ekran'); };
  document.addEventListener('fullscreenchange', onFullChange);
  onFullChange();
  // Escape (tam ekran dışında; pencere/açılır kutu yokken, odak bir girişte değilken) → Geri düğmesiyle aynı
  const onKeyBack = e => {
    if (e.key !== 'Escape' || e.defaultPrevented || document.fullscreenElement) return;
    if (document.querySelector('.modal-back, .fs-pop') || /^(INPUT|SELECT|TEXTAREA)$/.test(e.target?.tagName || '')) return;
    e.preventDefault(); goBack(be.href());
  };
  window.addEventListener('keydown', onKeyBack);

  // HUD (sağ): sabit satırlar, değerler textContent ile güncellenir (DOM yeniden kurulmaz)
  const val = cls => h('b', { class: `fs-v ${cls || ''}` }, '—');
  const V = { mode: h('span', { class: 'badge blue fs-mode' }, '—'), arm: h('span', { class: 'badge gray fs-arm' }, 'DISARMED'),
    agl: val(), msl: val(), air: val(), gnd: val(), climb: val(), hdg: val(), gps: val(), batt: val(), fuel: val(), thr: val(), wind: val(), pitch: val(), roll: val(), kmh: val() };
  // §23: güç ve yakıt — canlıda sunucunun tele.fuel/tele.elec'i; kayıt ve sahte kipte istemci modeli (session.power ayarlarıyla karelerden)
  const powerSet = session.power || null;
  const clientPower = (replay || mock) && powerSet ? createPowerSim(powerSet) : null;
  let powerWarned = { fuel: false, elec: false };
  const row = (label, el, unit) => h('div', { class: 'fs-row' }, h('span', null, label), h('span', { class: 'fs-rv' }, el, unit ? h('i', null, unit) : null));
  const rcBars = Array.from({ length: 8 }, (_, i) => h('div', { class: 'fs-rc', title: tr('Kanal {n}', { n: i + 1 }) }, h('i'), h('small', null, String(i + 1))));
  const thrBar = h('div', { class: 'fs-thr' }, h('i'));
  const windArrow = h('span', { class: 'fs-wind-arrow' }, '➤');
  const netLbl = h('div', { class: 'fs-net', title: 'Telemetri alım hızı, jitter (alım aralığı − kaynak aralığı) ve uyarlanır gecikme tamponu; DR = ölü hesap' }, '');
  const hud = h('div', { class: 'fs-hud mono' },
    h('div', { class: 'fs-hud-head' }, V.mode, V.arm),
    ...(rover   // §31 kara aracı: irtifa / hava hızı / dikey hız yerine eğim, yatış, hız (km/h)
      ? [row('Eğim', V.pitch, '°'), row('Yatış', V.roll, '°'), row('Hız', V.kmh, 'km/h')]
      : [row('AGL', V.agl, 'm'), row('MSL', V.msl, 'm'), row('Hava hızı', V.air, 'm/s'), row('Yer hızı', V.gnd, 'm/s'), row('Dikey hız', V.climb, 'm/s')]),
    row('Yön', V.hdg, '°'), row('GPS', V.gps), row('Batarya', V.batt),
    h('div', { class: 'fs-row fs-row-fuel', hidden: true }, h('span', null, 'Yakıt'), h('span', { class: 'fs-rv' }, V.fuel)),   // §23: tele.fuel varsa görünür
    h('div', { class: 'fs-row' }, h('span', null, 'Gaz'), h('span', { class: 'fs-rv' }, V.thr, h('i', null, '%'))), thrBar,
    h('div', { class: 'fs-row fs-row-rc' }, h('span', null, 'RC'), h('div', { class: 'fs-rcs' }, rcBars)),
    h('div', { class: 'fs-row' }, h('span', null, 'Rüzgâr'), h('span', { class: 'fs-rv' }, windArrow, V.wind, h('i', null, 'm/s'))),
    launch ? h('div', { class: 'fs-row' }, h('span', null, 'Kalkış'), h('span', { class: 'fs-rv' }, h('b', { class: 'fs-v fs-launch-v' }, launchLabel(launch, tr)))) : null,
    session.layout ? h('div', { class: 'fs-row' }, h('span', null, 'Düzen'), h('span', { class: 'fs-rv' }, h('b', { class: 'fs-v fs-layout-v' }, layoutLabel(session.layout, tr)))) : null,   // §13.1 kontrol düzeni
    netLbl);
  V.wind.textContent = `${f1(world.wind_ms)} @ ${f0(world.wind_dir)}°`;
  windArrow.style.transform = `rotate(${(Number(world.wind_dir) || 0) + 90}deg)`;   // ➤ sağa bakar; rüzgâr "nereden" → ok akış yönünü gösterir

  // Mission Planner bağlantısı (§14): harekât panelinde MISSION PLANNER bölümü; panel kapalı/FPV'de panelin yüzen koyu kutusu (flightsim_panel.js placeMp) —
  // eski sol alt .fs-mp kutusu (beyaz .btn/.badge) KALKTI. Kayıt kipinde yerine kayıt bilgisi kutusu
  const addr = `${session.host || location.hostname}:${session.udp_port || '—'}`;
  const mpOpts = replay ? null : { addr, port: session.udp_port, copy: a => copy(a, 'Adres kopyalandı') };
  const mp = replay ? h('div', { class: 'fs-mp fs-rec' },
    h('div', { class: 'fs-mp-head' }, h('b', null, 'Kayıttan oynatma'), h('span', { class: 'badge purple' }, (session.replay?.vehicle || '').split(' ')[0] || 'Log')),
    h('div', { class: 'small fs-mp-hint fs-rec-info' }, '—')) : null;

  // Alt araç çubuğu: kamera 1–4 · Sıfırla · Bitir · ARM/DISARM · mod · Kalkış · RTL (yazma izni)
  const camBtns = CAMERA_MODES.map(([k, label], i) => h('button', { class: 'btn sm', type: 'button', 'data-cam': k, title: tr('{label} (tuş {n})', { label, n: i + 1 }), onclick: () => sim?.setCamera(k) }, `${i + 1} `, label));   // etiket ayrı çocuk: çeviri kataloğundan karşılığı bulunur
  const gimbalLbl = h('span', { class: 'small fs-gimbal', hidden: true }, '');
  const mhudBtn = h('button', { class: 'btn sm fs-mhud-btn', type: 'button', hidden: true, title: tr('Askeri HUD aç/kapa (H) · Shift+H renk'), onclick: () => { milHud?.toggle(); mhudBtn.classList.toggle('primary', !!milHud?.enabled); } }, 'HUD');
  // §22 FPV (pilot) kipi ayarları — yalnız FPV'de görünür, TEK kapsül "FPV 120° ▾" (alt çubuk sığsın; kayıt kipinde oynatma çubuğu da var) → ses menüsü
  // kalıbında açılır menü: OSD (O), Analog efekt (fs.fpv.analog), Pervane/burun görünür (fs.fpv.nose), FOV kaydırıcısı (tekerlek). PiP artık genel kamera PiP'i (§22.4; V)
  const fpvPrefs = createFpvPrefs();
  const fpvRow = (label, title, get, set) => {
    const inp = h('input', { type: 'checkbox', onchange: () => set(inp.checked) });
    const row = h('label', { class: 'fs-audio-row fs-fpv-row', title }, inp, h('span', null, label));
    row.__sync = () => { inp.checked = !!get(); };
    return row;
  };
  const fpvRows = [
    fpvRow('OSD', tr('FPV OSD aç/kapa (O)'), () => osd?.enabled, v => { osd?.setEnabled(v); drawFpvBtns(); }),
    fpvRow(tr('Analog efekt'), tr('Analog FPV efekti: doygunluk, tarama çizgisi, mesafe/RSSI ile artan parazit'), () => fpvPrefs.analog, v => { fpvPrefs.setAnalog(v); osd?.setAnalog(v); sim?.setFpvAnalog(v); drawFpvBtns(); }),
    fpvRow(tr('Pervane/burun görünür'), tr('Pervane/burun görünür: kamera biraz geride, gövde ucu kadrajda'), () => fpvPrefs.nose, v => { fpvPrefs.setNose(v); sim?.setFpvNose(v); drawFpvBtns(); }),
  ];
  const fovInp = h('input', { type: 'range', min: 90, max: 150, step: 5, 'aria-label': 'FOV', oninput: () => { sim?.setPilotFov(Number(fovInp.value)); drawFpvBtns(); } });
  const fovOut = h('b', { class: 'mono' }, '');
  const fpvMenu = h('div', { class: 'fs-audio-menu fs-fpv-menu', hidden: true }, ...fpvRows, h('div', { class: 'fs-audio-row' }, h('span', null, 'FOV'), fovInp, fovOut),
    h('div', { class: 'small muted' }, tr('O: OSD · tekerlek: FOV · C: kamera')));
  const fpvFovTxt = h('span', { class: 'fs-fpv-fov' }, '');
  const fpvBtn = h('button', { class: 'btn sm fs-fpv-btn', type: 'button', title: tr('FPV ayarları: OSD, analog efekt, burun, görüş açısı'), onclick: () => { fpvMenu.hidden = !fpvMenu.hidden; } }, 'FPV ', fpvFovTxt, ' ▾');
  const fpvCtl = h('span', { class: 'fs-audio pill-group fs-fpv-ctl', hidden: true }, fpvBtn, fpvMenu);
  const onDocClickFpv = e => { if (!fpvMenu.hidden && !fpvCtl.contains(e.target)) fpvMenu.hidden = true; };
  document.addEventListener('click', onDocClickFpv, true);
  // §22.3–22.5 kamera türü + kamera PiP'i: tür oturumdan (sihirbazda seçilen; kayıtta kaydın türü) yoksa son tercih; PiP sürüklenebilir pencere
  // (flightsim_camera.js; görüntü 3B tuvalinde, aynı WebGL bağlamı); alt çubukta "📷 Tür ▾" (T / Shift+T / V). Tür değişimi canlı oturumda sunucuya
  // (`camera` komutu → kayıt satırı), tercih localStorage'a ve dron kaydına (fs.cam.byDrone) yazılır.
  let siteUi = null, defHud = null, defReplay = null;   // §26 radar/EO ekranları, görev şeridi, kayıtta görev olayları
  let sim = null, last = null, socket = null, destroyed = false, rc = null, worldReady = false, milHud = null, osd = null, targetsTracker = null;   // targetsTracker: §24 kayıtta önleme izleyicisi   // rc: sanal kumanda (virtualRC) ya da null   // (kamera denetimleri getSim ile erken okur → burada tanımlı)
  const camPrefs = createCamPrefs();
  const camType0 = isCamType(session.camera) ? session.camera : camPrefs.type;
  let camPip = null;   // sahne iskeleti kurulunca (stage.append sonrası)
  const camCtl = createCameraCtl({ getSim: () => sim, tr, prefs: camPrefs, getPip: () => camPip,
    onType: t => {
      addEvent(tr('Kamera türü: {t}', { t: camTypeLabel(t, tr) }));
      if (session.drone?.id != null) camPrefs.rememberDrone(session.drone.id, t);
      if (!replay && canWrite) be.cmd(sid, 'camera', { type: t }).catch(() => {});   // §22.3: oturum/kayıt satırı son türü saklar
    } });
  const drawFpvBtns = () => {
    camCtl?.sync(); camPip?.layout();   // harekât kartı kipe göre gizlenir/görünür → PiP kenar boşluğu
    fpvRows.forEach(r => r.__sync());
    const fov = sim?.getPilotFov?.() ?? fpvPrefs.fov;
    fovInp.value = String(fov); fovOut.textContent = `${fov}°`; fpvFovTxt.textContent = `${fov}°`;
    fpvBtn.classList.toggle('primary', !!osd?.enabled);
  };
  // §14 harekât paneli (flightsim_panel.js; iframe YOK): GÖKTUNGU dron kartı görünümünde TEK kart (başlık şeridi + PFD + telemetri karoları + İŞLEMLER +
  // Haberleşme konsolu) 3B'nin ÜSTÜNDE; "Panel" düğmesi / P tuşu gösterip gizler; gizliyken sade görünüm (eski HUD + alt çubuk komutları). Kayıt/sahte kipte hub yok: PFD/telemetri çalışır, İŞLEMLER yok
  let ops = null;
  const opsBtn = h('button', { class: 'btn sm fs-ops-btn', type: 'button', title: tr('Harekât panelini göster/gizle (P): dron kartı (başlık, uçuş göstergesi, telemetri karoları, işlemler ve haberleşme konsolu) 3B dünyanın üstünde; gizliyken sade görünüm (eski HUD ve alt çubuk komutları)'), onclick: () => { if (!ops) return; ops.toggle(); } }, 'Panel');
  const armBtn = h('button', { class: 'btn sm', type: 'button', onclick: () => cmd(last?.armed ? 'disarm' : 'arm') }, 'ARM');
  const rcBtn = h('button', { class: 'btn sm', type: 'button', title: rover ? `${tr('Sanal kumanda (kara aracı)')}: ${tr(ROVER_RC_TEXT.hint)}. RC_CHANNELS_OVERRIDE 20 Hz.` : 'Sanal kumanda: iki sanal çubuk + klavye (W/S gaz, A/D yaw, ok tuşları pitch/roll, Q/E mod kanalı, Boşluk gaz orta). RC_CHANNELS_OVERRIDE 20 Hz.', onclick: () => rcToggle() }, '🎮 ', 'Sanal kumanda');
  const modeSel = h('select', { class: 'input sm fs-modesel', onchange: () => { if (modeSel.value) cmd('mode', { mode: modeSel.value }); } },
    h('option', { value: '' }, 'Mod…'), modes.map(mm => h('option', { value: mm }, mm)));
  // Kayıt kipi: oynatma çubuğu (Oynat/Duraklat · hız 0.5×–8× · zaman kaydırıcısı · süre · Baştan); komut düğmeleri yok
  const SPEEDS = [0.5, 1, 2, 4, 8];
  const playBtn = h('button', { class: 'btn sm primary fs-play-btn', type: 'button', title: tr('Oynat / Duraklat (boşluk)'), onclick: () => player?.toggle() }, '▶');
  const speedBtns = SPEEDS.map(x => h('button', { class: `btn sm ${x === 1 ? 'primary' : ''}`, type: 'button', 'data-speed': x, onclick: () => player?.setSpeed(x) }, `${x}×`));
  const seek = h('input', { class: 'fs-seek', type: 'range', min: 0, max: 1000, step: 1, value: 0, 'aria-label': 'Zaman', oninput: () => player?.seekFrac(Number(seek.value) / 1000) });
  const timeLbl = h('span', { class: 'fs-time-lbl mono' }, '00:00 / 00:00');
  const clockLbl = h('span', { class: 'fs-clock-lbl small' }, '');
  // §8.3 uzun kayıt: tam hızdaki parça yüklenirken küçük gösterge (o arada 1 Hz genel bakış oynar)
  const lodLbl = replay ? h('span', { class: 'badge fs-lod', hidden: true, title: tr('Bu bölümün tam çözünürlüklü kareleri yükleniyor; şimdilik seyreltilmiş iz oynatılıyor') }, tr('Ayrıntı yükleniyor…')) : null;
  const playBar = replay ? h('div', { class: 'fs-playbar' },
    playBtn,
    h('button', { class: 'btn sm', type: 'button', title: 'Baştan', onclick: () => player?.restart() }, '↺ ', 'Baştan'),
    h('div', { class: 'pill-group fs-speeds' }, speedBtns),
    h('div', { class: 'fs-seek-wrap' }, seek, h('i', { class: 'fs-seek-marks' })),
    timeLbl, clockLbl, lodLbl) : null;
  // §27.1 kumanda hassasiyeti: ⚙ düğmesi alt çubukta (🎮 yanında), küçük açılır panel (oran / expo / ölü bölge, eksen başına; localStorage fs.rc.feel)
  const rcFeel = createRcFeelPanel(stage, { tr, plane: isPlane(type), rover, onChange: () => { rcShape = rcFeel.shaper(); } });   // §31 kara aracı: direksiyon + gaz
  let rcShape = rcFeel.shaper();
  // §29.6 uçuş denetimi (harekât paneli açıkken de görünür): mod seçici + DISARM (sabit kanatta havada motor kesme → süzülme; kopterde onaylı)
  const fltBar = canWrite && !replay ? createFlightBar({ tr, kind: modeKind(type), modes: flightModesFor(modeKind(type)), stage,
    cmd: (name, params = {}) => be.cmd(sid, name, params), onEvent: (t, sev) => addEvent(t, sev),
    confirm: msg => confirmDialog(tr('DISARM'), msg, { okLabel: tr('DISARM'), danger: true }) }) : null;
  // §34 servo tetik (alt bant; tüm kamera kipleri): seçili kanala PWM komutu gelince sunucu gecikme sonunda aracı çarptırır → otomatik Bitir + özet
  const srvTrig = canWrite && !replay ? createServoTrigger({ tr, stage, session, droneId: session.drone?.id ?? null,
    cmd: (name, params = {}) => be.cmd(sid, name, params), onEvent: (t, sev) => addEvent(t, sev) }) : null;
  const bar = h('div', { class: 'fs-bar' },
    h('div', { class: 'pill-group' }, camBtns),
    gimbalLbl, mhudBtn, fpvCtl, camCtl.el, opsBtn,
    replay ? playBar : h('span', { class: 'spacer' }),
    srvTrig ? srvTrig.el : null,   // §34 servo tetik
    fltBar ? fltBar.el : null,   // §29.6 mod + DISARM: her zaman (ARM/mod seçici eski .fs-cmds'ten buraya taşındı)
    canWrite && !replay ? h('div', { class: 'pill-group fs-cmds' },   // .fs-cmds: harekât paneli açıkken gizli (komutlar panelden)
      rover ? h('button', { class: 'btn sm fs-hold-btn', type: 'button', title: tr('Aracı durdur (HOLD kipi)'), onclick: () => cmd('mode', { mode: 'HOLD' }) }, 'Dur')   // §31 kara aracında kalkış yok
        : h('button', { class: 'btn sm fs-takeoff-btn', type: 'button', onclick: () => takeoffDialog() }, LAUNCH_BTN[launch?.method] || 'Kalkış'),
      h('button', { class: 'btn sm', type: 'button', onclick: () => cmd('rtl') }, 'RTL')) : null,
    canWrite && !replay ? h('div', { class: 'pill-group' }, rcBtn, rcFeel.el) : null,   // §27.1 ⚙ hassasiyet
    h('div', { class: 'pill-group' },
      replay ? null : h('button', { class: 'btn sm', type: 'button', title: 'SITL aynı ayarlarla yeniden başlar; çarpışma kaldırılır', onclick: () => reset() }, '↺ Sıfırla'),
      h('button', { class: 'btn sm danger', type: 'button', onclick: () => endSession() }, 'Bitir')));
  const ended = h('div', { class: 'fs-ended', hidden: true });
  // Sanal kumanda katmanı: sol çubuk gaz/yaw, sağ çubuk pitch/roll (Mode 2); klavye ipucu; Mission Planner joystick uyarısı
  // §31 kara aracı: sol çubuk dikey gaz / fren (yaylı, merkez = dur), sağ çubuk yatay direksiyon (yaylı); etiketler flightsim_rover ROVER_RC_TEXT
  const stickL = h('div', { class: 'fs-stick', 'data-side': 'l', 'data-rover': rover ? '1' : null }, h('i', { class: 'fs-stick-knob' }), h('small', null, rover ? ROVER_RC_TEXT.left : 'Gaz / Yaw'));
  const stickR = h('div', { class: 'fs-stick', 'data-side': 'r', 'data-rover': rover ? '1' : null }, h('i', { class: 'fs-stick-knob' }), h('small', null, rover ? ROVER_RC_TEXT.right : 'Pitch / Roll'));
  const rcWarn = h('div', { class: 'fs-rc-warn', hidden: true }, 'Mission Planner joystick de açıksa son gelen RC komutu geçerli olur');
  const rcHint = h('div', { class: 'fs-rc-hint' }, h('span', null, rover ? ROVER_RC_TEXT.hint : 'W/S gaz · A/D yaw · ↑↓ pitch · ←→ roll · Q/E mod kanalı · Boşluk gaz orta'), rcWarn);
  const sticks = h('div', { class: 'fs-sticks', hidden: true }, stickL, stickR, rcHint);
  // Kaynak atfı: gerçek arazi sağ altta metin; Google 3B'de ToS gereği Google logosu + canlı veri sağlayıcı metni (sol alt, MP kutusu üstü)
  const g3dMode = world.mode === 'google3d';
  const attribTxt = h('span', null, g3dMode ? 'Google' : ATTRIBUTION);
  const attrib = world.mode === 'real' || g3dMode ? h('div', { class: `fs-attrib ${g3dMode ? 'fs-attrib-g3d' : ''}` }, g3dMode ? h('img', { class: 'fs-g3d-logo', src: G3D_LOGO, alt: 'Google' }) : null, attribTxt) : null;
  // §23.6 güç paneli: alt çubuğun üstünde ortada dört otomobil tarzı kadran (YAKIT · HIZ · MOTOR · BATARYA), takip/serbest/yer kiplerinde ve panelden bağımsız;
  // FPV OSD / gimbal HUD açıkken onlar çizer (CSS gizler). Hız kadranı azami hızı session.power'dan; uyarı üçgeni çarpışma bandından (getCollision).
  // Ayrıntı kutusu kayıt/sahte kipte istemci modelinin özetinden (mesafe, harcanan, ölçülen), canlıda kendi mesafe toplayıcısından.
  const gauges = createPowerGauges(stage, { h, tr, getSettings: () => session.power || null, getSummary: () => clientPower?.summary() || null, plane: isPlane(type), rover, getCollision: () => !crash.hidden,
    onTheme: t => addEvent(tr('Gösterge tasarımı: {t}', { t: tr(gaugeThemeLabel(t)) })) });   // §27.3 tasarım (sihirbaz seçimi; uçuşta G / kadran kutusu)
  stage.append(mount, msg, crash, hud, ...(mp ? [mp] : []), events, sticks, gauges.el, bar, nav, ended);
  if (attrib) stage.append(attrib);
  // §31 rüzgâr göstergesi (sol üst; baş/yan/kuyruk bileşenleri uçağın burnuna göre, akış çizgileri aç/kapa, yazma izniyle uçuşta rüzgâr) +
  // rampa yön/açı paneli (rampaya tıklayınca; ARM öncesi; sunucu `launch_aim` — yön değişirse SITL yeniden konuşlandırılır)
  const streakPref = { get: () => pref('fs.windStreaks', '1') !== '0', set: v => { setPref('fs.windStreaks', v ? '1' : '0'); sim?.setWindStreaks(!!v); } };
  const windG = createWindGauge({ tr, canEdit: canWrite && !replay, streaks: streakPref,
    onChange: async w => { try { const r = await be.cmd(sid, 'wind', w); applyWind(r?.wind || {}); } catch (err) { toastError(err); throw err; } } });
  stage.append(windG.el);
  const applyWind = w => {
    for (const [k, wk] of [['wind_ms', 'wind_ms'], ['wind_dir', 'wind_dir'], ['wind_gust', 'wind_gust'], ['wind_turb', 'wind_turb']]) if (w[k] != null) world[wk] = Number(w[k]);
    sim?.setWind(w); windG.update({ ms: world.wind_ms, dir: world.wind_dir, gust: world.wind_gust, turb: world.wind_turb });
  };
  windG.update({ ms: world.wind_ms, dir: world.wind_dir, gust: world.wind_gust, turb: world.wind_turb, hdg: world.runway_heading });
  const rampUi = launch?.method === 'ramp' && canWrite && !replay ? createRampPanel({ tr,
    onPreview: a => sim?.setRampAim(a),
    getWind: () => (sim?.windInfo ? sim.windInfo() : { ms: world.wind_ms, dir: world.wind_dir }),
    getState: () => ({ armed: !!last?.armed, altRel: last?.alt_rel ?? 0, phase: sim?.launchPhase ?? null }),
    onApply: async a => {
      try {
        const r = await be.cmd(sid, 'launch_aim', a);
        Object.assign(launch, r?.launch || a);
        addEvent(tr('Rampa: yön {az}° · açı {an}°', { az: Math.round(a.azimuth_deg), an: a.angle_deg }) + (r?.redeploy ? ` — ${tr('SITL yeniden konuşlandırılıyor')}` : ''), 'info');
      } catch (err) { toastError(err); sim?.setRampAim({ azimuth_deg: launch.azimuth_deg ?? world.runway_heading, angle_deg: launch.angle_deg }); throw err; }
    } }) : null;
  if (rampUi) stage.append(rampUi.el);
  if (typeof window !== 'undefined') window.__fsRampUi = rampUi ? { open: () => rampUi.open(sim?.rampAim || { azimuth_deg: launch.azimuth_deg ?? world.runway_heading, angle_deg: launch.angle_deg }), get isOpen() { return rampUi.isOpen; } } : null;
  // §13 düzenek yüzey teşhisi: ?rigdiag=1 → sol üstte canlı kutu (h, eğim, kilit, karo inceliği/geometricError, örnekler); window.__fsRig() her oturumda
  const rigDiagEl = rigdiag ? h('pre', { class: 'fs-rigdiag' }) : null;
  if (rigDiagEl) stage.append(rigDiagEl);
  window.__fsRig = () => (sim?.rigDiag ? sim.rigDiag() : null);
  window.__fsCtrl = () => (sim?.ctrlState ? sim.ctrlState() : null);
  window.__fsTele = () => last;   // teşhis: son telemetri karesi (roll/pitch/alt_rel/mode/armed/servo)   // §13.1 kontrol yüzeyi teşhisi: servo/servo_fn/servo_rev → eksen girişleri → yüzey açıları (° arka kenar aşağı +)
  ops = createOpsPanel(stage, { sid, session, type, modes, launch, canWrite, hub: !replay && !mock, mp: mpOpts, getSim: () => sim, cmdSim: (name, params) => cmd(name, name === 'takeoff' ? { ...params, ...(launcherUi?.takeoffExtra() || {}) } : params), onReset: () => reset(), onToggle: on => { opsBtn.classList.toggle('primary', on); camPip?.layout(); },
    speed: replay ? null : { onPick: f => cmd('speed', { factor: f }) } });   // §23: panel "Sim" grubunda hız seçici
  opsBtn.classList.toggle('primary', ops.enabled);
  const audio = createEngineAudio(stage, { type, launch, replay, tr, getSim: () => sim, getCrashed: () => !crash.hidden, getCrashSpeed: () => crashSpeed, getSpeed: () => player?.speed() ?? 1 });   // §16: düğmeyi alt çubuğa kendisi ekler; kamera/kalkış aşaması/çarpışma getter'lardan
  // §17 ekran kaydı: rozet üst şeride, anahtar alt çubuğa; 3B hazır olunca başlar (Başlat'ta alınan ekran paylaşımı akışı varsa o, yoksa 3B+HUD tuvali)
  const recText = () => [tr('Uçuş Simülatörü kaydı'), replay ? `${tr('kayıttan oynatma')}${session.replay?.file_name ? ` · ${session.replay.file_name}` : ''}` : [tr(TYPE_NAME[type] || type), session.center?.name, launch ? tr(launchLabel(launch, tr)) : null].filter(Boolean).join(' · '),
    clock(rec?.seconds ?? 0), fmtDateTime(session.created_at)].filter(Boolean).join(' · ');
  const rec = mock || !canWrite ? null : createRecorder(stage, { sid, tr, getSim: () => sim, getHudCanvas: () => stage.querySelector('.fs-mhud'), getOsdCanvas: () => stage.querySelector('.fs-osd'), getOverlays: () => [camPip?.overlay(), launcherUi?.overlay?.()].filter(Boolean), audio, text: recText, onEvent: (t, sev) => addEvent(t, sev) });   // §22: FPV OSD da yedek yolda kayda girer; kayıt kamerayı değiştirmez

  // Tam alan yerleşimi (Canlı Uçuş iframe kalıbı): main#view mutlak konumlu, scroller kaydırmaz
  view.classList.add('ops-view');
  const scroller = view.closest('.scroller');
  scroller?.classList.add('ops-scroll');
  clear(view, stage);
  // §26 yer kontrol sahası: SOL ALTTA radar ekranı + yanında EO ekranı (görüntü 3B tuvalinde, aynı bağlam) + alt çubukta 📡 Radar / 🔭 EO (Y / U);
  // görevde ekranların üstünde "Yer kontrolünü koru" şeridi (dalga, sağlık, interceptor rafı, Sıradaki interceptor — N)
  if (session.site) {
    siteUi = createSiteScreens(stage, { tr, getSim: () => sim, site: session.site, mount, onToggle: () => camPip?.layout() });
    if (siteUi.buttons.length) bar.insertBefore(h('div', { class: 'pill-group fs-site-btns' }, siteUi.buttons), opsBtn.nextSibling);
  }
  // §27 fırlatıcı: hücre envanteri (3B kutu/tüp) + el fırlatıcısında NİŞANGÂH penceresi (alt çubukta ⌖ Nişangâh — G)
  if (launch && isIceptLauncher(launch.method)) {
    launcherUi = createLauncherUi(stage, { tr, getSim: () => sim, launch, session, mount, canWrite: canWrite && !replay, onFire: () => takeoffDialog(), onToggle: () => camPip?.layout() });
    if (launcherUi.buttons.length) bar.insertBefore(h('div', { class: 'pill-group fs-scope-btns' }, launcherUi.buttons), opsBtn.nextSibling);
  }

  // Olay şeridi (3B kurulumundan önce tanımlı: gerçek arazi yükleme özeti de buraya yazılır).
  // Canlıda saat (şimdi); kayıtta log zamanı (mm:ss) ve MAVLink/DataFlash önem düzeyi (sayı: 0–3 hata, 4 uyarı)
  const sevClass = severity => {
    if (typeof severity === 'number') return severity <= 3 ? 'err' : severity === 4 ? 'warn' : 'info';
    const sev = String(severity || 'info').toLowerCase();
    return /err|crit|alert|emerg/.test(sev) ? 'err' : /warn/.test(sev) ? 'warn' : 'info';
  };
  // tag: panel konsolu etiketi ('SİM' yerel olaylar, 'STATUS' dronun STATUSTEXT'i — hub'ın aynı satırı panelde atlanır, tekrar olmaz)
  const addEvent = (text, severity = 'info', at = null, tag = 'SİM') => {
    const now = new Date();
    const stamp = at != null ? clock(at) : `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}`;
    events.prepend(h('div', { class: `fs-ev ${sevClass(severity)}` }, h('span', { class: 'fs-ev-t' }, stamp), h('span', null, text)));
    while (events.children.length > 8) events.lastChild.remove();
    ops?.log(text, { err: 'hata', warn: 'uyari', info: 'bilgi' }[sevClass(severity)], tag);
  };

  // ---------- 3B ----------
  camPip = createCameraPip(mount, { getSim: () => sim, tr, prefs: camPrefs,   // §22.4 (iskelet DOM'da, `sim` tanımlandıktan sonra: kenar boşlukları gezinti kapsülü ve alt çubuktan)
    insets: side => { const o = pipObstacleInsets(stage, mount, side); return { top: Math.max(56, Math.round(nav.getBoundingClientRect().bottom - mount.getBoundingClientRect().top) + 10), bottom: Math.max((bar.offsetHeight || 54) + 28, o.bottom || 0), right: o.right ?? 12 }; },
    onSwap: () => drawFpvBtns() });
  let lastRouteToast = '', lastRouteToastAt = 0;   // §18: aynı MP görev bildirimi 3 sn içinde tekrar toast olmaz
  // Askeri HUD bağlamı (gimbal kamerası): getter'lar her karede okunur (3B'nin render ettiği yönelim, gimbal, çarpışma)
  const hudCtx = { world, session, replay, launch, fov: 78, t0: Date.parse(session.created_at) || Date.now(),
    get pose() { return sim?.getPose?.() || null; }, get gimbalDeg() { return sim?.getGimbal() ?? 0; }, get camMode() { return sim?.getCamera(); }, get collision() { return !crash.hidden; }, get pipRect() { return sim?.getPip?.() ? sim.pipRect : null; },
    targets: () => sim?.targetsHud?.() ?? null };   // §24.5 hedef sembolojisi (prizma/TLL/kenar okları)
  milHud = createMilHud(stage, hudCtx, { tr });
  mhudBtn.classList.toggle('primary', milHud.enabled);
  // §22 FPV OSD bağlamı (pilot kamerası): yönelim 3B'den, FOV/PiP dikdörtgeni 3B'den, sanal kumanda açıkken alt satırlar yukarı
  const osdCtx = { session, replay, t0: hudCtx.t0,
    get pose() { return sim?.getPose?.() || null; }, get camMode() { return sim?.getCamera(); }, get collision() { return !crash.hidden; },
    get fov() { return sim?.getPilotFov?.() ?? fpvPrefs.fov; }, get pip() { return !!sim?.getPip?.(); }, get pipRect() { return sim?.getPip?.() ? sim.pipRect : null; }, get rcOn() { return !!rc; },
    targets: () => sim?.targetsHud?.() ?? null };   // §24.5
  osd = createFpvOsd(stage, osdCtx, { tr });
  drawFpvBtns();
  const progMsg = p => {   // gerçek arazi yükleme ilerlemesi (3B tuval üstünde)
    if (destroyed) return;
    if (p.stage === 'done') {
      worldReady = true;
      if (session.state === 'HAZIR' || mock) msg.hidden = true;
      if (p.real) addEvent(`${tr('Gerçek arazi · yükseklik {a}…{b} m · ev {h} m MSL', { a: f0(p.hmin), b: f0(p.hmax), h: f0(p.homeElev) })} · ${tr('{b} bina · {f} orman · {w} su · {r} pist', { b: p.counts?.buildings ?? 0, f: p.counts?.forests ?? 0, w: p.counts?.water ?? 0, r: p.counts?.runways ?? 0 })}`);
      if (p.google) addEvent(tr('Google 3B (fotogerçekçi) · ev {h} m MSL', { h: f0(p.homeElev) }));
      const info = sim?.terrainInfo;
      if (p.real && info?.osmError) addEvent(tr('OSM verisi alınamadı: binalar/orman/su gösterilmiyor ({e})', { e: info.osmError }), 'warning');
      return;
    }
    if (p.stage === 'g3d-ground') { addEvent(tr('Google 3B yer ofseti {o} m (karo yüzeyi ↔ ev irtifası)', { o: f1(p.offset) })); return; }
    if (p.stage === 'g3d') {   // Google karoları: yalnız ilk dolum perdede; sonrası atıf satırında "yükleniyor %"
      if (worldReady) return;
      if (p.pct >= 100) { if (session.state === 'HAZIR' || mock) msg.hidden = true; return; }
      msg.hidden = false; msg.textContent = tr('Google 3B karoları yükleniyor… %{p}', { p: p.pct ?? 0 });
      return;
    }
    msg.hidden = false;
    msg.textContent = p.stage === 'elev' ? tr('Yükseklik karoları {d}/{n}', { d: p.done, n: p.total }) : p.stage === 'img' ? tr('Uydu karoları {d}/{n}', { d: p.done, n: p.total })
      : p.stage === 'osm' ? tr('Harita verileri (OSM) alınıyor…') : tr('Arazi planı alınıyor…');
  };
  // Dünya merkezi: canlıda merkez; kayıtta kaydın kalkış noktası (session.center = ev; ayrıştırma bitmeden analiz özetinden ön değer). §8 KÖK NEDEN
  // (eski): oturum BASLIYOR'ken center/replay.home null → origin (0,0) ile kuruluyor, HAZIR'da yeniden konumlanmıyordu → gerçek arazi/Google (0,0)'da
  // (okyanus) yükleniyor ya da düşüyordu. Şimdi: merkez bilinmiyorsa 3B kurulumu HAZIR'a ertelenir; HAZIR'da merkez değişmişse `setOrigin` ile taşınır.
  const originOf = () => ({ lat: session.center?.lat ?? session.replay?.home?.lat ?? null, lon: session.center?.lon ?? session.replay?.home?.lon ?? null, alt: session.center?.alt ?? session.replay?.home?.alt ?? null });
  let simOrigin = null, simBuilding = null;
  // §26 saha + görev: 3B modeller (istasyon, kule, raf + interceptor'lar), tehditler, şerit
  const setupSite = () => {
    const D = session.defend;
    const I = D?.state?.icept;
    // §27: kutu fırlatıcılarında 10'lu raf yok (envanter kutularda); tüp / el fırlatıcısında raf yedek deposu
    const lm = launch && isIceptLauncher(launch.method) ? launch.method : null;
    sim.setSite(session.site, { rack: D ? (lm ? rackCountFor(lm, D.config?.interceptors || 10) : (D.config?.interceptors || 10)) : 0, show: I ? Math.max(0, I.total - I.used) : (D?.config?.interceptors || 10) - 1 });
    if (D) sim.setDefend(D);
    launcherUi?.sync();
    siteUi?.applyPrefs();
    if (D && !defHud) {
      defHud = createDefendHud({ stage, tr, defend: D, getSim: () => sim, holder: siteUi?.stripHolder, canWrite, replay,
        onNext: async () => {
          if (!await confirmDialog(tr('Sıradaki interceptor'), tr("Aktif interceptor bırakılıp sıradaki konuşlandırılsın mı? Uçmuş interceptor harcanmış sayılır (SITL aracı pad'de yeniden başlar)."), { okLabel: tr('Sıradaki interceptor') })) return;
          crash.hidden = true; sim?.clearCollision(); sim?.resetCamera();
          try { await be.cmd(sid, 'defend', { action: 'next' }); } catch (err) { toastError(err); }
        },
        onEnd: result => { if (!replay) showDefendReport(result, { tr, modal, plan: D.plan, onFinish: () => endSession(), finishLabel: tr('Bitir') }); },
        onEvent: (text, sev) => addEvent(text, sev || 'info', replay ? (player?.time() ?? null) : null, 'GÖREV'),
        onReport: () => { const r = replay ? D.result : null; if (r) { showDefendReport(r, { tr, modal, plan: D.plan }); return; } be.summary(sid).then(sm => sm?.defend && showDefendReport(sm.defend, { tr, modal, plan: D.plan })).catch(toastError); } });
      siteUi?.layout();
      if (replay && D.result) defReplay = { i: 0, events: [...(D.result.kills || []).map(k => ({ kind: 'kill', ...k, name: D.plan?.[k.k]?.name })), ...(D.result.leaks || []).map(l => ({ kind: 'leak', ...l, name: D.plan?.[l.k]?.name }))].sort((a, b) => a.t - b.t) };
    }
  };
  const buildSim = () => {
    if (sim || simBuilding || destroyed) return simBuilding || Promise.resolve(sim);
    const o = originOf();
    if (o.lat == null || o.lon == null) {   // merkez henüz yok (kayıt ayrıştırılıyor): HAZIR'da kurulur
      msg.hidden = false; msg.textContent = replay ? tr('Kayıt hazırlanıyor… %{p}', { p: session.replay?.progress ?? 0 }) : tr('SITL başlıyor…');
      return Promise.resolve(null);
    }
    simBuilding = (async () => {
      try {
        if (world.mode === 'real') { msg.hidden = false; msg.textContent = tr('Arazi planı alınıyor…'); }
        if (g3dMode) { msg.hidden = false; msg.textContent = tr('Google 3B karoları yükleniyor… %{p}', { p: 0 }); }
        simOrigin = { ...o };
        const s3 = await createFlightSim3D(mount, world, {
          type, model: session.model || session.airframe, launch, origin: { ...o }, drive,   // §31 kara aracı sürüş biçimi (3B tekerlek kinematiği)
          camera: fpvPrefs.cam, pilotFov: fpvPrefs.fov, fpvAnalog: fpvPrefs.analog, fpvNose: fpvPrefs.nose,   // §22: oturumlar arası kalıcı kamera/FPV tercihleri (localStorage)
          camType: camType0, thermalPalette: camPrefs.palette, onGimbalZoom: () => camPip?.redraw(),   // §22.3 kamera türü (oturumun seçimi) + termal paleti
          site: session.site || null,   // §26 saha çevresi açık alan (dünya kurulurken)
          onPilotFov: v => { fpvPrefs.setFov(v); drawFpvBtns(); },
          // Kamera değişimi: gimbal kamerası ('fpv') → gimbal etiketi + askeri HUD; FPV ('pilot') → OSD + FPV düğmeleri; ikisinde de harekât kartları gizli
          // (kullanıcı: "kamera görünümünde kontrol panelim gizlensin"), sanal kumanda çubukları görünür kalır (§14/§22)
          onCameraChange: mode => { camBtns.forEach(b => b.classList.toggle('primary', b.dataset.cam === mode)); gimbalLbl.hidden = mode !== 'fpv'; mhudBtn.hidden = mode !== 'fpv'; fpvCtl.hidden = mode !== 'pilot'; milHud?.setCamMode(mode); osd?.setCamMode(mode); ops?.setFpv(mode === 'fpv' || mode === 'pilot'); gimbalLbl.textContent = tr('Gimbal {d}° (↑↓ / tekerlek)', { d: sim?.getGimbal() ?? 0 }); fpvPrefs.setCam(mode); drawFpvBtns(); },
          onCollision: replay ? null : info => onCrash(info),   // kayıt: gerçek uçuş → çarpışma denetimi yok
          windStreaks: streakPref.get(),   // §31 rüzgâr akış çizgileri (kalıcı tercih fs.windStreaks)
          onRigClick: rampUi ? ev => { if (ev.aim) rampUi.open(ev.aim); } : null,   // §31 rampaya tıklama → yön/açı paneli
          onProgress: progMsg,
          g3dKey: be.g3dKey,
          onFallback: e => { const t = g3dMode ? tr('Google 3B verisi alınamadı: {e} → prosedürele düşüldü', { e }) : tr('Gerçek veri alınamadı, prosedürele düşüldü: {e}', { e }); addEvent(t, 'warning'); toast(t, 'err'); if (attrib) attrib.hidden = true; },
        });
        if (destroyed) { s3.dispose(); return null; }
        sim = s3;
        if (netsim) window.__fsSim = sim;   // teşhis: Playwright/konsol sim.netStats() · sim.motionStats(true)
        if (sim.terrainInfo && !worldReady) progMsg({ stage: 'done', real: sim.real, ...sim.terrainInfo });
        if (launch && session.launch?.phase) sim.setLaunchPhase(session.launch.phase);   // oturuma geç katılan izleyici: aşama sunucudan
        launcherUi?.sync();   // §27 hücre envanteri + nişangâh dikdörtgeni
        if (session.targets) { sim.setTargets(session.targets); targetsTracker = replay ? createInterceptTracker(session.targets) : null; }   // §24 hedefler (kayıtta önlemeler istemcide yeniden hesaplanır)
        if (session.site) setupSite();   // §26
        msg.hidden = true;
        camPip?.layout();   // §22.4: PiP dikdörtgeni + aç/kapa 3B'ye (sim.setPipRect / setPip)
        camBtns.forEach(b => b.classList.toggle('primary', b.dataset.cam === sim.getCamera()));   // kalıcı seçim (fs.cam) uygulanmış olabilir
        drawFpvBtns();
        const disp = takeStashedStream();   // §17: Başlat'ta alınan ekran paylaşımı (varsa); kayıt tercihi açıksa hemen başla (HAZIR beklenmez)
        if (rec && (disp || recPrefs.on)) rec.start(disp).catch(() => {}); else disp?.getTracks().forEach(t => t.stop());
        return sim;
      } catch (err) {
        msg.hidden = false; msg.textContent = tr('3B dünya açılamadı: {e}', { e: err.message });
        msg.classList.add('err');
        return null;
      } finally { simBuilding = null; }
    })();
    return simBuilding;
  };
  // HAZIR'da merkez değişmişse (kayıt: ayrıştırma sonucu ilk ARM konumu ≠ analiz özeti) dünya yeni merkeze taşınır (gerçek kipte veriler yeniden yüklenir)
  const syncOrigin = async () => {
    const o = originOf();
    if (!sim || !simOrigin || o.lat == null || (Math.abs(o.lat - simOrigin.lat) < 1e-6 && Math.abs(o.lon - simOrigin.lon) < 1e-6 && Math.abs((o.alt ?? 0) - (simOrigin.alt ?? 0)) < 0.5)) return false;
    simOrigin = { ...o };
    addEvent(tr('Dünya merkezi kaydın kalkış noktasına taşındı: {lat}, {lon}', { lat: Number(o.lat).toFixed(5), lon: Number(o.lon).toFixed(5) }));
    await sim.setOrigin(o.lat, o.lon, world, o.alt);
    return true;
  };
  // §8.3 ön çekim: HAZIR olur olmaz (3B dünya kurulurken paralel) kareler + uzun kayıtta kalkış anının parçası istenir
  let replayDataP = null;
  const chunkPre = new Map();   // k → Promise (ön çekilmiş parça; oynatıcı ilk isteğinde bunu kullanır)
  const prefetchReplay = () => {
    if (!replay || replayDataP) return replayDataP;
    const st = REPLAY_STASH.get(String(sid));   // §8 ön hazırlık: sihirbazın hazırlık kartı indirdiyse yeniden çekilmez
    REPLAY_STASH.delete(String(sid));
    replayDataP = (st ? Promise.resolve(st) : be.replay(sid)).then(d => {
      const L = d?.lod, F0 = d?.frames;
      if (L && L.chunks > 0 && F0?.length && be.replayChunk) {
        const k = Math.max(0, Math.min(L.chunks - 1, Math.floor((Math.max(0, (d.takeoff_t ?? 0) - 5) - F0[0][0]) * (Number(d.hz) || 25) / L.chunk_n)));
        chunkPre.set(k, be.replayChunk(sid, k).catch(() => { chunkPre.delete(k); return null; }));
      }
      return d;
    });
    replayDataP.catch(() => { replayDataP = null; });
    return replayDataP;
  };
  if (replay && session.state === 'HAZIR') prefetchReplay()?.catch(() => {});   // önbellekli / sihirbazdan gelen kayıt: kareler 3B ile paralel
  await buildSim();
  // §27.2 giriş sekansı (tüm başlatmalar: canlı, sahte, kayıt): 3B hazır + perde kalkınca bir kez — 100 m'den sinematik iniş, 3-2-1 + bip, sonra son kamera kipi
  const intro = createIntro(stage, { getSim: () => sim, tr, sound: () => hepgoSound(), sub: session.center?.name || null });
  let introStarted = false;
  // §33 karşılaşma oturumu: halkalar + diğer oyuncular (3B), durum şeridi, canlı sıralama, sonuç ekranı. Giriş sekansı burada değil SUNUCU saatine
  // göre geri sayımın son 3 sn'sinde oynar (herkes aynı anda "BAŞLA"); 3B hazır olunca sunucuya `ready`.
  const matchUi = matchId && !replay && !mock && String(session.match_id ?? '') === String(matchId)
    ? attachMatch({ stage, getSim: () => sim, mid: matchId, me: ctx.user?.id ?? null, sid, startIntro: () => { introStarted = true; intro.start(); }, getTele: () => last }) : null;
  const maybeIntro = () => {
    if (introStarted || destroyed || !sim || !msg.hidden || !(session.state === 'HAZIR' || mock)) return;
    if (matchUi) { matchUi.onWorldReady(); return; }
    introStarted = true; intro.start();
  };
  const gimbalTick = setInterval(() => {
    maybeIntro();
    if (!gimbalLbl.hidden && sim) gimbalLbl.textContent = tr('Gimbal {d}° (↑↓ / tekerlek)', { d: sim.getGimbal() });
    if (g3dMode && sim?.google) {   // Google atfı canlı (görünür karoların veri sağlayıcıları) + yükleme yüzdesi
      const a = sim.g3dAttribution();
      if (a) { const t = a.loading < 100 ? `${a.text} · ${tr('yükleniyor %{p}', { p: a.loading })}` : a.text; if (attribTxt.textContent !== t) attribTxt.textContent = t; }
    }
  }, 300);

  // ---------- olaylar / durum ----------
  const setState = st => {
    session.state = st;
    stateBadge.className = `badge ${STATE_BADGE[st] || 'gray'}`;
    stateBadge.textContent = tr(STATE_TEXT[st] || st);
    if (st === 'BASLIYOR') { msg.hidden = false; msg.textContent = replay ? tr('Kayıt hazırlanıyor… %{p}', { p: session.replay?.progress ?? 0 }) : tr('SITL başlıyor…'); }
    else if (st === 'HATA') { msg.hidden = false; msg.classList.add('err'); msg.textContent = replay ? tr('Kayıt açılamadı: {e}', { e: session.sitl?.error || '—' }) : tr('SITL hatası: {e}', { e: session.sitl?.error || '—' }); }
    else if (st === 'HAZIR') {
      msg.classList.remove('err');
      if (replay) prefetchReplay()?.catch(() => {});   // §8.3: kareler 3B kurulumuyla paralel insin
      if (!sim) buildSim().then(() => { if (sim && replay) loadReplay(); });   // merkez şimdi biliniyor: 3B burada kurulur (§8)
      else { msg.hidden = true; if (replay) loadReplay(); }
    }
    ops?.setState(st);
  };
  const setWs = st => {
    const map = { connecting: ['yellow', 'Bağlanıyor…'], reconnect: ['yellow', 'Yeniden bağlanıyor…'], open: ['green', 'Canlı'], closed: ['red', 'Bağlantı koptu'] };
    const [tone, text] = map[st] || ['gray', st];
    wsBadge.className = `badge ${tone}`; wsBadge.textContent = tr(text);
  };
  const setGcs = (connected, a) => { ops?.setGcs(connected, a); };   // tek yer: panel rozeti (bölüm başlığı / yüzen kutu) + GPS karosu
  setGcs(!!session.gcs?.connected, session.gcs?.addr);
  if (session.state !== 'HAZIR') setState(session.state);

  // ---------- HUD güncelle (en çok ~12 Hz) ----------
  let hudAt = 0;
  // RC çubukları: sanal kumanda açıkken 1–5 yerel kanal değerleri (anlık), diğerleri telemetriden
  const drawRcBars = teleRc => {
    const loc = rc?.channels();
    for (let i = 0; i < 8; i++) {
      const v = loc && i < 5 ? loc[i] : Number((teleRc || [])[i]);
      const pct = Math.max(0, Math.min(100, ((v || 1500) - 1000) / 10));
      rcBars[i].firstChild.style.height = `${pct}%`;
      rcBars[i].classList.toggle('vr', !!loc && i < 5);
    }
  };
  // §23: kayıt/sahte kipte yakıt-batarya istemci modelinden (kare zamanı: kayıt t, sahte ts); canlıda sunucudan gelir. Bitince kırmızı olay (bir kez)
  const applyClientPower = t => {
    if (!clientPower) return;
    const tsec = replay ? t.t : (t.ts != null ? Number(t.ts) / (Number(t.ts) > 1e10 ? 1000 : 1) : performance.now() / 1000);   // sahte kip ts = Date.now() (ms) → sn (dt > 5 sn sanılıp atlanmasın)
    const done = clientPower.step(t, tsec);
    Object.assign(t, clientPower.state());
    for (const k of done) { if (powerWarned[k]) continue; powerWarned[k] = true; addEvent(tr(k === 'fuel' ? 'YAKIT BİTTİ — simülasyon sürüyor' : 'ELEKTRONİK BATARYA BİTTİ — simülasyon sürüyor'), 'error', replay ? tsec : null); }
  };
  const updateHud = t => {
    applyClientPower(t);
    last = t;
    sim?.setTelemetry(t);
    milHud?.update(t); osd?.update(t); audio.update(t); ops?.update(t); gauges.update(t);   // §23.6 kadranlar (≤ 10 Hz kendi içinde)
    windG.update({ ms: t.wind_spd ?? world.wind_ms, dir: t.wind_dir ?? world.wind_dir, hdg: t.heading ?? (t.yaw != null ? ((t.yaw * 180 / Math.PI) + 360) % 360 : null) });   // §31
    rampUi?.refresh();
    if (t.speedup != null) speedPill.set(t.speedup);
    const now = performance.now();
    if (now - hudAt < 80) return;
    hudAt = now;
    V.mode.textContent = t.mode || '—';
    V.arm.textContent = t.armed ? 'ARMED' : 'DISARMED';
    V.arm.className = `badge ${t.armed ? 'red' : 'gray'} fs-arm`;
    V.agl.textContent = f1(t.alt_rel); V.msl.textContent = f1(t.alt_msl);
    if (rover) { const ps = sim?.getPose?.() || t; V.pitch.textContent = f1(Number(ps.pitch || 0) * 180 / Math.PI); V.roll.textContent = f1(Number(ps.roll || 0) * 180 / Math.PI);   // zemine oturmuş gövde (3B), yoksa telemetri
      V.kmh.textContent = f1(t.groundspeed != null ? Number(t.groundspeed) * 3.6 : null); }   // §31
    V.air.textContent = f1(t.airspeed); V.gnd.textContent = f1(t.groundspeed);
    const climb = t.climb != null ? t.climb : (t.vd != null ? -t.vd : null);
    V.climb.textContent = (climb != null && climb > 0.05 ? '+' : '') + f1(climb);
    V.hdg.textContent = f0(t.heading != null ? t.heading : (t.yaw != null ? ((t.yaw * 180 / Math.PI) + 360) % 360 : null)).padStart(3, '0');
    V.gps.textContent = `${t.gps_fix >= 6 ? 'RTK' : t.gps_fix === 5 ? 'RTK FLT' : t.gps_fix === 4 ? 'DGPS' : t.gps_fix === 3 ? '3D' : t.gps_fix === 2 ? '2D' : tr('Yok')} · ${f0(t.sats)} ${tr('uydu')}`;
    if (t.elec) {   // §23 elektronik batarya (SITL SIM_BATT değil): %, kestirilen gerilim, kalan süre
      V.batt.textContent = elecText(t.elec);
      V.batt.classList.toggle('warn', t.elec.pct < 25 && !t.elec.empty); V.batt.classList.toggle('err', !!t.elec.empty);
    } else {
      V.batt.textContent = `${t.batt_v != null && Number(t.batt_v) > 0 ? Number(t.batt_v).toFixed(2) : '—'} V · %${f0(t.batt_pct)}`;   // SITL'de batarya izleme kapalıysa 0 V gelir
      V.batt.classList.toggle('warn', t.batt_pct != null && t.batt_pct < 25);
    }
    const fuelRow = hud.querySelector('.fs-row-fuel');
    if (fuelRow) fuelRow.hidden = !t.fuel;
    if (t.fuel) { V.fuel.textContent = `${fuelText(t.fuel)} · ${rangeText(t.fuel.range_km)}`; V.fuel.classList.toggle('warn', t.fuel.pct < 20 && !t.fuel.empty); V.fuel.classList.toggle('err', !!t.fuel.empty); }
    V.thr.textContent = f0(t.throttle);
    thrBar.firstChild.style.width = `${Math.max(0, Math.min(100, Number(t.throttle) || 0))}%`;
    drawRcBars(t.rc);
    if (rc) rcWarn.hidden = !t.gcs_connected;
    fltBar?.update(t);
    srvTrig?.update(t);   // §34 anlık PWM
    if (canWrite && !replay) { armBtn.textContent = t.armed ? 'DISARM' : 'ARM'; armBtn.classList.toggle('danger', !!t.armed); if (t.mode && modeSel.value !== t.mode && document.activeElement !== modeSel) modeSel.value = modes.includes(t.mode) ? t.mode : ''; }
    if (t.gcs_connected != null) setGcs(!!t.gcs_connected, t.gcs_addr);
  };

  // ---------- kayıttan oynatma: kareleri çek, enterpolasyonla oynat ----------
  let player = null, replayLoaded = false, replaySegs = null, replayPhase = null;
  // Kayıtta kalkış aşaması (§8): t anındaki aşama; değişimde düzenek + panel + olay şeridi. snap (atlama/baştan): ofset sönümü yok, olay yazılmaz.
  const applyReplayLaunch = (t, snap = false) => {
    if (!launch || !replaySegs) return;
    const ph = replayLaunchPhaseAt(replaySegs, t);
    if (ph === replayPhase && !snap) return;
    const changed = ph !== replayPhase;
    replayPhase = ph;
    sim?.setLaunchPhase(ph === 'idle' ? null : ph, snap); ops?.setLaunchPhase(ph === 'idle' ? null : ph);
    if (changed && !snap && ph !== 'idle') { const txt = (LAUNCH_PHASE_TEXT[ph] || {})[launch.method] || ph; addEvent(tr(txt), ph === 'released' || ph === 'launch' ? 'warning' : 'info', t); }
  };
  const loadReplay = async () => {
    if (!replay || replayLoaded) return;
    replayLoaded = true;
    let data = null;
    if (!replayDataP) { msg.hidden = false; msg.classList.remove('err'); msg.textContent = tr('Kareler indiriliyor…'); }
    try { data = await prefetchReplay(); } catch (err) { replayLoaded = false; msg.hidden = false; msg.classList.add('err'); msg.textContent = tr('Kayıt açılamadı: {e}', { e: err.message }); return; }
    if (destroyed) return;
    msg.hidden = true;
    // Merkez = kaydın kalkış noktası (ayrıştırma sonucu); dünya uçuşu kapsasın: evden en uzak kare mesafesinin 2,4 katı (en az seçilen boyut, en çok 20 km)
    if (sim) {
      const o = originOf();
      const need = fitWorldSize(data, o.lat != null ? o : data.home);
      const grow = need > (Number(world.size_m) || 0);
      if (grow) { world.size_m = need; addEvent(tr('Dünya boyutu uçuşa göre {n} m yapıldı', { n: need }), 6); }
      if (!await syncOrigin() && grow) await sim.setWorld(world);   // merkez değiştiyse setOrigin zaten yeni boyutla kurar
    }
    if (launch) { const FIr = Object.fromEntries((data.fields || []).map((k, i) => [k, i])); replaySegs = replayLaunchTimeline(data.frames, FIr, launch); }
    player = createReplayPlayer(data, {
      onFrame: t => {
        updateHud(t); applyReplayLaunch(t.t);
        if (defHud && session.defend?.result && t.tt != null) {   // §26: kayıtta görev durumu kaydedilen sonuçtan (görev saati = kayıt saati, ilk SITL bölümü)
          defHud.update(defendStateAt(session.defend.result, session.defend.plan, t.tt, session.defend.config));
          const ev = defReplay?.events || [];
          while (defReplay && defReplay.i < ev.length && ev[defReplay.i].t <= t.tt) { const e = ev[defReplay.i++]; defHud.event({ ...e, health: e.kind === 'leak' ? defendStateAt(session.defend.result, session.defend.plan, e.t).health : undefined }); }
        }
        if (targetsTracker && t.tt != null && t.lat != null && sim) {   // §24: kayıtta önlemeler (sunucu izleyicisiyle aynı kural)
          const p = sim.toLocal(t.lat, t.lon);
          for (const o of targetsTracker.step(t.tt, p.x, p.y, Number(t.alt_rel) || 0, !!t.armed)) onTarget(o, t.t);
        }
      },
      onEvent: (e, t) => addEvent(e.text, e.sev, t),
      onClear: () => clear(events),
      onSeek: t => { sim?.snapCamera(); applyReplayLaunch(t, true); if (session.targets) targetsTracker = createInterceptTracker(session.targets); if (defReplay) { const tt = (last?.tt ?? 0) - (last?.t ?? 0) + t; defReplay.i = defReplay.events.findIndex(e => e.t > tt); if (defReplay.i < 0) defReplay.i = defReplay.events.length; } gauges.reset(); if (clientPower) { clientPower.rebuild(data, t); powerWarned = { fuel: false, elec: false }; } },   // atlama: takip kamerası dronun yanına ışınlanır (yayla yüzlerce metre kovalamaz); düzenek aşaması anında; §23 yakıt/batarya baştan o ana entegre
      onTime: (t, dur, playing) => {
        seek.value = String(Math.round(1000 * (dur ? t / dur : 0)));
        timeLbl.textContent = `${clock(t)} / ${clock(dur)}`;
        if (data.start_utc) { const d = new Date(new Date(data.start_utc).getTime() + t * 1000); clockLbl.textContent = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`; }
        playBtn.textContent = playing ? '❚❚' : '▶';
      },
      onSpeed: sp => speedBtns.forEach(b => b.classList.toggle('primary', Number(b.dataset.speed) === sp)),
      loadChunk: be.replayChunk ? k => { const pre = chunkPre.get(k); chunkPre.delete(k); return pre ? pre.then(r => r || be.replayChunk(sid, k)) : be.replayChunk(sid, k); } : null,   // §8.3 uzun kayıt: tam hızdaki parça
      onLod: busy => { if (lodLbl) lodLbl.hidden = !busy; },
    });
    if (netsim) window.__fsPlayer = player;   // teşhis (Playwright): player.lod() · time() · frameAt()
    // Kayıt bilgisi kutusu + kaydırıcıda olay/kalkış işaretleri
    const info = mp?.querySelector('.fs-rec-info');
    if (info) clear(info, h('div', null, h('b', null, session.replay?.file_name || '—')),
      h('div', null, [data.vehicle, data.n != null ? tr('{n} kare', { n: data.n }) : null, data.hz ? `${data.hz} Hz` : null, fmtDuration(data.duration_s)].filter(Boolean).join(' · ')),
      data.start_utc ? h('div', null, tr('Kayıt başı: {t}', { t: fmtDateTime(data.start_utc) })) : null,
      data.home ? h('div', null, tr('Kalkış: {lat}, {lon} · {alt} m MSL', { lat: Number(data.home.lat).toFixed(5), lon: Number(data.home.lon).toFixed(5), alt: f0(data.home.alt) })) : null);
    const marks = playBar?.querySelector('.fs-seek-marks');
    if (marks && data.duration_s) {
      const dur = data.duration_s;
      clear(marks, (data.events || []).filter(e => e.sev <= 4).slice(0, 60).map(e => h('b', { class: e.sev <= 3 ? 'err' : 'warn', style: { left: `${(e.t / dur * 100).toFixed(2)}%` }, title: `${clock(e.t)} ${e.text}` })),
        data.takeoff_t != null ? h('b', { class: 'to', style: { left: `${(data.takeoff_t / dur * 100).toFixed(2)}%` }, title: tr('İlk ARM {t}', { t: clock(data.takeoff_t) }) }) : null);
    }
    // İlk ARM'den 5 sn önce başla; otomatik oynat
    player.seek(Math.max(0, (data.takeoff_t ?? 0) - 5));
    sim?.resetCamera();
    player.play();
    addEvent(tr('Kayıt yüklendi: {n} kare · {d}', { n: data.n, d: fmtDuration(data.duration_s) }), 6, player.time());
  };
  const onKeyReplay = e => {
    if (!player || /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || '')) return;
    if (e.key === ' ') { player.toggle(); e.preventDefault(); }
    else if (e.key === 'ArrowLeft') { player.seek(player.time() - (e.shiftKey ? 30 : 5)); e.preventDefault(); }
    else if (e.key === 'ArrowRight') { player.seek(player.time() + (e.shiftKey ? 30 : 5)); e.preventDefault(); }
  };
  if (replay) window.addEventListener('keydown', onKeyReplay);

  // ---------- komutlar ----------
  const cmd = async (name, params = {}) => {
    try { await be.cmd(sid, name, params); addEvent(tr('Komut: {c}', { c: name + (params.mode ? ` ${params.mode}` : params.alt != null ? ` ${params.alt} m` : '') })); } catch (err) { toastError(err); }
  };
  const takeoffDialog = () => {
    if (rover) { toast(tr('Kara aracında kalkış yok; ARM edip sürün (MANUAL) ya da AUTO / GUIDED kipine geçin.'), 'err'); return; }   // §31
    const alt = h('input', { class: 'input', type: 'number', min: 1, max: 500, value: type === 'interceptor' ? 60 : isPlane(type) ? 80 : 30 });
    const m = launch?.method;
    const hint = m === 'ramp' ? tr('Uçak TAKEOFF moduna alınır ve ARM edilir; 1 sn sonra pnömatik rampa kızağı {a}° açıyla fırlatır (SITL mancınık tetiği). Fırlatma ivmesi algılanınca gaz açılır.', { a: Math.round(launch.angle_deg) })
      : m === 'vehicle' ? tr('Uçak TAKEOFF moduna alınır ve ARM edilir; pickup pist boyunca hızlanır, {k} km/h yer hızında uçak bırakılır ve tırmanır.', { k: Math.round(launch.release_kmh) })
      : m === 'handheld' ? (() => { const a = sim?.getAim?.() || { az: launch.aim_az_deg ?? 0, el: launch.aim_el_deg ?? 55 }, w = aimWaypoint(a.az, a.el); return tr('El fırlatıcısı: GUIDED + ARM; interceptor tüpten çıkar, 8 m dikey tırmanır ve nişan doğrultusuna (az {az}° · el {el}° → {h} m ileride {a} m) yönelir (DO_REPOSITION). Hedef irtifa yok sayılır.', { az: Math.round(a.az), el: Math.round(a.el), h: Math.round(w.horiz_m), a: Math.round(w.alt_m) }); })()
      : m === 'pod4' || m === 'pod8' || m === 'tube' ? tr('Fırlatıcı: GUIDED + ARM; kapak açılır, interceptor kuyruk üstünden dikey çıkar (NAV_TAKEOFF) ve hedef irtifada askıda bekler. Yatay uçuş için FBWA / CRUISE / AUTO.')
      : type === 'interceptor' ? tr('Dikey kalkış: GUIDED + ARM + VTOL kalkışı — kuyruk üstünden dikey tırmanır, hedef irtifada askıda bekler. Yatay uçuşa geçmek için FBWA / CRUISE / AUTO; dönüş RTL (dikey iniş).')
      : isPlane(type) ? 'Uçak TAKEOFF moduna alınır; pist boyunca hızlanır.' : 'Dron GUIDED modda belirtilen irtifaya yükselir.';
    const label = LAUNCH_BTN[m] || 'Kalkış';
    modal({ title: label, body: field('Hedef irtifa (m, AGL)', alt, hint),
      actions: [{ label: 'Vazgeç' }, { label, class: 'primary', onClick: () => cmd('takeoff', { alt: Number(alt.value) || 30, ...(launcherUi?.takeoffExtra() || {}) }) }] });   // §27 el fırlatıcısı: canlı nişan
  };
  // §24 önleme (WS `target`; kayıtta istemci izleyicisi): olay şeridi (sarı), 3B'de hedefte genişleyen halka, kısa bildirim
  const onTarget = (m, at = null) => {
    if (m.kind && m.kind !== 'intercept') return;
    sim?.flashTarget(m.i);
    const ek = m.first ? tr('ilk önleme {s} sn', { s: f1(m.after_s) }) : tr('{n}. geçiş', { n: m.n });
    addEvent(`${tr('ÖNLEME')} · ${m.name} · ${f0(m.dist_m)} m · ${ek}`, 'warning', at, 'HEDEF');
    if (!replay) toast(`◎ ${tr('ÖNLEME')} · ${m.name}`);
  };
  // Kalkış aşaması (WS `launch`): 3B düzenek + olay şeridi
  const onLaunch = m => {
    if (!launch) return;
    sim?.setLaunchPhase(m.phase); ops?.setLaunchPhase(m.phase); launcherUi?.onLaunch(m);
    const txt = (LAUNCH_PHASE_TEXT[m.phase] || {})[launch.method] || m.phase;
    addEvent(m.phase === 'released' && m.speed_kmh != null ? `${tr(txt)} · ${f0(m.speed_kmh)} km/h` : tr(txt), m.phase === 'released' || m.phase === 'launch' ? 'warning' : 'info');
  };
  const CRASH_KIND = { terrain: 'Arazi ile temas', water: 'Suya düşüş', building: 'Binaya çarpma', sitl_hit: 'SITL yer teması', sitl: 'Otopilot çarpışma algısı', servo_trigger: 'Servo tetik' };
  // ÇARPIŞMA bandı yalnız sunucunun KESİN `crash` çerçevesiyle açılır (§18): 3B arazi teması sunucuda adaydır (SITL fizik teyidi), bina/su kesindir.
  let crashSpeed = null;   // §18.6: darbe sesi ve görsel efekt şiddeti
  const showCrash = (reason, speed) => {
    if (!crash.hidden) return;
    const k = tr(CRASH_KIND[reason] || 'Çarpışma');
    crash.hidden = false;
    crashSpeed = Number(speed) || null;
    sim?.crashFx?.({ speed: crashSpeed ?? undefined });   // patlama/toz/kıvılcım + sarsıntı + flaş
    crash.querySelector('.fs-crash-sub').textContent = reason === 'servo_trigger' ? tr('{k} · {v} m/s · simülasyon bitiriliyor, özet raporu açılacak', { k, v: f1(speed) })
      : tr('{k} · {v} m/s · "Sıfırla" ile yeniden başlayın', { k, v: f1(speed) });
    addEvent(tr('ÇARPIŞMA: {k} ({v} m/s)', { k, v: f1(speed) }), 'error');
  };
  // §34 servo tetik çarpması: çarpma efekti görünsün diye kısa bekleme, sonra Bitir akışı ONAYSIZ (kayıt → özet raporu → kapat)
  let autoEndTimer = null;
  const onServoFrame = m => {
    srvTrig?.onFrame(m);
    if (m.phase === 'fired' && canWrite && !autoEndTimer) autoEndTimer = setTimeout(() => endSession({ auto: true }), 2500);
  };
  const onCrash = info => {
    if (mock) { showCrash(info.kind, info.speed); be.cmd(sid, 'crash', { kind: info.kind, speed: info.speed }).catch(() => {}); return; }
    if (!canWrite) return;   // salt okuyan izleyicinin 3B algısı sunucuya gitmez; bant sunucu çerçevesiyle gelir
    be.cmd(sid, 'crash', { kind: info.kind, speed: info.speed, dz: info.dz }).catch(() => {});
  };
  const reset = async () => {
    crash.hidden = true;
    sim?.clearCollision();
    sim?.setLaunchPhase(null);   // uçak yeniden rampaya / araca oturur
    launcherUi?.reset?.();
    sim?.resetCamera();
    if (canWrite) await cmd('reset'); else toast('Sıfırlamak için yazma izni gerekir', 'err');
  };
  let ending = false;
  const endSession = async ({ auto = false } = {}) => {
    if (!canWrite) { location.hash = be.href(); return; }
    if (ending) return;
    if (!auto && !await confirmDialog('Oturumu bitir', replay ? 'Kayıttan oynatma oturumu kapatılsın mı?' : 'Simülatör oturumu kapatılsın mı? SITL süreci ve UDP portu kapanır; Mission Planner bağlantısı düşer.', { okLabel: 'Bitir', danger: true })) return;
    ending = true;   // §34 otomatik bitiş (servo tetik) ile elle Bitir üst üste binmesin
    try {
      if (rec?.hasData) await rec.finishWithDialog();   // §17: son parça + finish → Şirketten Haberler paylaşımı ya da sunucuda sakla (ilerleme penceresi; hata → indir)
      if (!replay) { try { const sum = await be.summary(sid); await showReport(sum, { tr, be, canWrite }); } catch (err) { toastError(err); } }   // §18: özet rapor (kapatmadan önce, tam ekranda — modal görünür)
      exitFullscreen();
      const r = await be.end(sid).catch(err => { if (auto && err?.status === 404) return null; throw err; });   // §34 otomatik bitişte sunucu çoktan kapatmış olabilir   // §19: rec.bin açıksa sunucu kapanışta DataFlash .bin'i Uçuş Logları'na kaydeder → r.bin
      toast('Oturum kapatıldı');
      if (r?.bin?.log_id) toast(tr('Uçuş logu kaydedildi: {f} ({kb} KB) — analiz bitince Uçuş Logları ve Kayıttan oynat listesinde', { f: r.bin.file_name, kb: Math.round((r.bin.size || 0) / 1024) }));
      else if (r?.bin?.error) toast(r.bin.error, 'err');
      location.hash = be.href();
    } catch (err) { ending = false; toastError(err); }
  };
  const END_REASON = { karsilasma_bitti: 'Karşılaşma bitti', servo_trigger: 'Servo tetik çarpması — simülasyon bitti', kapatildi: 'Oturum kapatıldı', bosta: 'İzleyici ve GCS olmadığından kapatıldı', sure: 'Oturum süresi doldu', sunucu_kapaniyor: 'Sunucu kapanıyor' };
  const showEnded = reason => {
    clear(ended, h('div', { class: 'fs-ended-box' }, h('b', null, 'Oturum sona erdi'), h('div', { class: 'small muted' }, tr(END_REASON[reason] || reason || '')),
      h('a', { class: 'btn primary', href: be.href() }, 'Simülatör ana sayfası')));
    ended.hidden = false;
  };

  // ---------- telemetri bağlantısı (WS ya da mock) ----------
  socket = be.socket(sid, {
    status: setWs,
    fatal: why => { setWs('closed'); showEnded(why === 'auth' ? tr('Bu oturumu izleme yetkiniz yok.') : why === 'notfound' ? tr('Oturum sunucuda yok (kapanmış olabilir).') : why); },
    message: m => {
      if (destroyed) return;
      if (m.t === 'tele') { if (replay) return; if (!netsim) return updateHud(m); if (Math.random() * 100 < netsim.loss) return; return void setTimeout(() => { if (!destroyed) updateHud(m); }, netsim.delay + Math.random() * 2 * netsim.jitter); }
      if (m.t === 'hello') { if (m.session) { Object.assign(session, m.session); if (session.defend?.state) defHud?.update(session.defend.state); setState(session.state); setGcs(!!session.gcs?.connected, session.gcs?.addr); if (Array.isArray(session.route)) { sim?.setMission({ ...(session.mission || {}), points: session.route }); ops?.setRoute(session.route); } } return; }
      if (m.t === 'route') {   // §14/§18: SITL'deki görev (HEPGO paneli ya da Mission Planner) → 3B tüp rota + iniş dairesi H + panel rota durumu; MP yüklemesinde anlık toast
        sim?.setMission(m); ops?.setRoute(m.points || []);
        const n = m.points?.length || 0;
        if (m.source === 'mp') { const t = n ? tr("Mission Planner'dan görev yüklendi: {n} nokta", { n }) : tr("Mission Planner'dan görev temizlendi"); if (t !== lastRouteToast || performance.now() - lastRouteToastAt > 3000) { toast(t); lastRouteToast = t; lastRouteToastAt = performance.now(); } }   // olay şeridi satırı sunucu `event`inden gelir (tekrar yok)
        return;
      }
      if (m.t === 'mission_cur') { sim?.setMissionCurrent(m.seq); return; }   // §18: aktif bacak (MISSION_CURRENT)
      if (m.t === 'servo_trigger') return onServoFrame(m);   // §34 dinleme / tetik / çarpma
      if (m.t === 'crash') return showCrash(m.reason, m.speed);   // §18: sunucunun kesin çarpışma kaydı (SITL fizik teması / 3B bina-su / teyitli arazi)
      if (m.t === 'warn') {
        if (m.kind === 'fuel_empty' || m.kind === 'elec_empty') { toast(m.text || tr('Güç kaynağı bitti'), 'err'); return; }   // §23: kırmızı olay satırı sunucu `event`inden gelir; ek olarak toast
        return addEvent(tr('Otopilot çarpışma tespiti (ArduPlane yazılımsal) — çarpışma kaydı değil: {t}', { t: m.text || '' }), 'warning');   // §18: sarı uyarı, bant yok
      }
      if (m.t === 'event') return addEvent(m.text, m.severity, replay ? (player?.time() ?? null) : null, 'STATUS');
      if (m.t === 'launch') return onLaunch(m);
      if (m.t === 'wind') { applyWind(m); return addEvent(tr('Rüzgâr: {ms} m/s · {dir}°', { ms: f1(m.wind_ms), dir: f0(m.wind_dir) })); }   // §31 uçuşta rüzgâr
      if (m.t === 'launch_cfg') { if (launch && m.launch) { Object.assign(launch, m.launch); sim?.setRampAim(m.launch); } return; }   // §31 rampa yön/açı (başka izleyici de görür)
      if (m.t === 'target') return onTarget(m);   // §24 önleme
      if (m.t === 'defend') { if (m.state && session.defend) session.defend.state = m.state; launcherUi?.sync(); return defHud?.event(m); }   // §27: sıradaki interceptor → sonraki hücre   // §26 görev olayları (dalga/önleme/sızma/kayıp/bitiş)
      if (m.t === 'state') {
        if (m.replay) session.replay = { ...(session.replay || {}), ...m.replay };
        if (m.center) session.center = { ...(session.center || {}), ...m.center };   // kayıt: ayrıştırma bitti → merkez = ilk ARM konumu (§8)
        else if (replay && m.replay?.home) session.center = { ...(session.center || {}), lat: m.replay.home.lat, lon: m.replay.home.lon, alt: m.replay.home.alt };
        return setState(m.state);
      }
      if (m.t === 'replay' && m.action === 'reset') return player?.restart();
      if (m.t === 'end') { setState('KAPANDI'); if (!matchUi || m.reason !== 'karsilasma_bitti') showEnded(m.reason); socket?.close(); }   // §33: karşılaşma sonunda sonuç ekranı kalır
    },
  });

  // ---------- sanal kumanda (yazma izni): 20 Hz {t:'rc', ch} yalnız açıkken; kapatınca tek sefer 8×0 (override serbest) ----------
  const rcToggle = () => {
    if (!canWrite) { toast('Sanal kumanda için yazma izni gerekir', 'err'); return; }
    if (rc) {
      rc.dispose();                      // zamanlayıcı durur, dinleyiciler kalkar, 8×0 gönderilir
      rc = null;
      sticks.hidden = true; stage.classList.remove('rc-on'); rcBtn.classList.remove('primary');
      sim?.setKeyboardLock(false);
      drawRcBars(last?.rc);
      addEvent(tr('Sanal kumanda kapatıldı (RC override serbest)'));
      return;
    }
    rc = virtualRC({ plane: isPlane(type), rover, stickL, stickR, send: ch => socket?.send({ t: 'rc', ch }), onChange: () => drawRcBars(last?.rc),
      throttle0: last?.armed ? last.throttle : null, shape: (k, v) => rcShape(k, v) });   // §27.1 hassasiyet (⚙ panel; değişiklik anında)   // uçuştayken açılırsa gaz çubuğu mevcut gazdan başlar (yerde/disarm: 1000)
    sticks.hidden = false; stage.classList.add('rc-on'); rcBtn.classList.add('primary');
    rcWarn.hidden = !last?.gcs_connected;
    sim?.setKeyboardLock(true);
    addEvent(tr('Sanal kumanda açık (RC override)'));
  };
  const netTick = setInterval(() => {
    if (rigDiagEl) {
      const d = sim?.rigDiag?.();
      const f = (v, n = 2) => (v == null || !Number.isFinite(v) ? '—' : Number(v).toFixed(n));
      rigDiagEl.textContent = d ? `RIG ${d.phase} · h ${f(d.h)} m (hedef ${f(d.target)}) · pitch ${f(d.pitch, 1)}° roll ${f(d.roll, 1)}°\nkilit ${d.locked ? 'EVET' : 'hayır'} (err ${f(d.lockErr, 1)}) · ince ${d.fine ? 'evet' : 'HAYIR'} · geomErr ${f(d.geomErr, 2)} · olay ${d.event}\nkilit ${d.locks} · yoksayılan ${d.ignored} · bekletme ${d.holds} · örnekleme ${d.fits} · ofset ${f(d.g3dOffset ?? d.offset, 2)} · karo %${d.g3dLoading ?? '—'}\nörnek ${d.samples ? d.samples.map(q => (q ? `${f(q.z)}${q.fine ? '' : '?'}` : '∅')).join(' ') : '—'} · kabul ${d.accepted ? d.accepted.map(v => f(v)).join(' ') : '—'} · uçak z ${f(d.shownZ)}` : 'RIG: düzenek yok';
    }
    if (!sim || replay) { netLbl.hidden = true; return; }   // kayıt kipinde ağ akışı yok
    const n = sim.netStats();
    netLbl.textContent = tr('net: {hz} Hz · jitter {j} ms · tampon {d} ms', { hz: n.hz, j: n.jitter, d: n.delay }) + (n.deadReckoning ? ' · DR' : '');
    netLbl.classList.toggle('warn', n.hz > 0 && (n.hz < 15 || n.jitter > 40));
  }, 500);

  onLeave(() => {
    destroyed = true;
    clearInterval(gimbalTick); clearInterval(netTick);
    if (rc) { rc.dispose(); rc = null; }   // override serbest bırakılır (soket kapanmadan önce)
    if (replay) window.removeEventListener('keydown', onKeyReplay);
    player?.dispose();
    socket?.close();
    milHud?.dispose(); osd?.dispose(); camPip?.dispose(); camCtl.dispose(); siteUi?.dispose(); defHud?.dispose(); launcherUi?.dispose();   // §26 + §27
    if (rec) { rec.abandon(); rec.dispose(); }   // §17: Bitir'siz çıkış → kayıt durur, parçalar akıtılır, sunucuda yarım kayıt (24 sa)
    audio.dispose(); ops?.dispose(); gauges.dispose(); rcFeel.dispose(); intro.dispose(); fltBar?.dispose(); srvTrig?.dispose(); matchUi?.dispose(); clearTimeout(autoEndTimer);
    sim?.dispose();
    if (window.__fsSim === sim) delete window.__fsSim;
    if (player && window.__fsPlayer === player) delete window.__fsPlayer;
    delete window.__fsRig;
    view.classList.remove('ops-view');
    scroller?.classList.remove('ops-scroll');
    document.removeEventListener('fullscreenchange', onFullChange);
    document.removeEventListener('click', onDocClickFpv, true);
    window.removeEventListener('keydown', onKeyBack);
    document.body.classList.remove('immersive', 'fs-full');
  });
}

// ======================================================================
// Sanal kumanda: iki sanal çubuk (Mode 2: sol gaz/yaw, sağ pitch/roll; dokunmatik + fare, pointer events) + klavye.
// ArduPilot RC: ch1 roll, ch2 pitch (ileri = burun aşağı = düşük PWM), ch3 gaz, ch4 yaw, ch5 mod anahtarı; 1000–2000, merkez 1500.
// Eksenler −1…1: tuş basılıyken KEY_RATE ile uca gider, bırakılınca yaylı (üstel) merkeze döner. Kopterde gaz çubuğu merkeze yaylıdır
// (1500 ≈ askı); uçakta gaz tutmalıdır (W/S kaydırır, çubuk bırakıldığı yerde kalır). Boşluk = gaz 1500. Q/E = ch5 1000/1500/2000.
// 20 Hz: tick (klavye entegrasyonu + çizim) → send(channels()). dispose(): zamanlayıcı/dinleyiciler kalkar, 8×0 (override serbest) gönderilir.
// §31 KARA ARACI (rover): sol çubuk DİKEY = gaz / fren (yaylı; bırakınca 1500 = dur), sağ çubuk YATAY = direksiyon (yaylı); diğer eksenler yok.
// Klavye W/S ve ↑↓ gaz, A/D ve ←→ direksiyon, Boşluk dur (gaz + direksiyon 0), Q/E ch5. Kanallar flightsim_rover.roverRcChannels (RC1 direksiyon, RC3 gaz;
// RC2/RC4 0 = dokunma). Hassasiyet: direksiyon 'roll' eğrisi, gaz 'thr' eğrisi (çift yönlü).
// ======================================================================
const RC_KEYS = new Set(['w', 'a', 's', 'd', 'q', 'e', ' ', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright']);
function virtualRC({ plane, rover = false, stickL, stickR, send, onChange, throttle0 = null, shape = null }) {
  if (rover) plane = false;   // shape(eksen, v): §27.1 hassasiyet eğrisi (flightsim_rcfeel.js) — çıkışa uygulanır
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  // thr: −1 = 1000 (uçak boşta), 0 = 1500 (kopter askı). Uçakta kumanda uçuş sırasında açılırsa (throttle0: telemetri gazı %) çubuk o gazda başlar:
  // ArduPlane TAKEOFF/AUTO'da gazı RC'den bağımsız verir; çubuk altta (1000) iken HUD %100 "ters" görünmesin, FBWA'ya geçişte gaz aniden kesilmesin.
  const thr0 = plane && throttle0 != null && Number.isFinite(Number(throttle0)) ? clamp(Number(throttle0) / 50 - 1, -1, 1) : null;
  const ax = { roll: 0, pitch: 0, thr: plane ? (thr0 ?? -1) : 0, yaw: 0 };
  let ch5 = 1500, lastT = performance.now(), disposed = false;
  const keys = new Set();
  const drag = { l: null, r: null };          // sürüklenen çubuk: {id, x0, y0, r}
  const KEY_RATE = 3.5, SPRING = 9, THR_RATE = 0.7;
  const editable = el => el && (/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || el.isContentEditable);
  const pwm = v => Math.round(clamp(1500 + v * 500, 1000, 2000));
  const S = (k, v) => (shape ? shape(k, v) : v);
  const channels = () => (rover ? roverRcChannels({ steer: S('roll', ax.roll), thr: S('thr', ax.thr), ch5 })   // §31: [RC1 direksiyon, 0, RC3 gaz, 0, ch5, 0, 0, 0]
    : [pwm(S('roll', ax.roll)), pwm(-S('pitch', ax.pitch)), pwm(S('thr', ax.thr)), pwm(S('yaw', ax.yaw)), ch5, 0, 0, 0]);   // 6–8: 0 = o kanala dokunma

  // --- klavye ---
  const onKeyDown = e => {
    if (disposed || editable(document.activeElement) || e.ctrlKey || e.metaKey || e.altKey) return;
    const k = e.key.toLowerCase();
    if (!RC_KEYS.has(k)) return;
    e.preventDefault();
    if (e.repeat) return;
    if (k === ' ') { ax.thr = 0; if (rover) ax.roll = 0; return; }   // §31 kara aracı: Boşluk = dur (gaz + direksiyon orta)
    if (k === 'q' || k === 'e') { ch5 = clamp(ch5 + (k === 'e' ? 500 : -500), 1000, 2000); return; }
    keys.add(k);
  };
  const onKeyUp = e => keys.delete(e.key.toLowerCase());
  const onBlur = () => keys.clear();

  // --- çubuklar (pointer events; touch-action: none) ---
  const bind = (el, side) => {
    const knob = el.querySelector('.fs-stick-knob');
    const down = e => {
      if (disposed) return;
      const b = el.getBoundingClientRect();
      drag[side] = { id: e.pointerId, cx: b.left + b.width / 2, cy: b.top + b.height / 2, r: b.width / 2 - 16 };
      el.setPointerCapture(e.pointerId); el.classList.add('on');
      move(e); e.preventDefault();
    };
    const move = e => {
      const d = drag[side];
      if (!d || e.pointerId !== d.id) return;
      const x = clamp((e.clientX - d.cx) / d.r, -1, 1), y = clamp(-(e.clientY - d.cy) / d.r, -1, 1);
      if (rover) { if (side === 'l') ax.thr = y; else ax.roll = x; return; }   // §31: sol dikey gaz, sağ yatay direksiyon
      if (side === 'l') { ax.yaw = x; ax.thr = y; } else { ax.roll = x; ax.pitch = y; }
    };
    const up = e => { if (drag[side] && e.pointerId === drag[side].id) { drag[side] = null; el.classList.remove('on'); } };
    el.addEventListener('pointerdown', down); el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up); el.addEventListener('pointercancel', up);
    return { knob, off: () => { el.removeEventListener('pointerdown', down); el.removeEventListener('pointermove', move); el.removeEventListener('pointerup', up); el.removeEventListener('pointercancel', up); el.classList.remove('on'); } };
  };
  const L = bind(stickL, 'l'), R = bind(stickR, 'r');
  const draw = () => {
    const place = (knob, x, y) => { knob.style.transform = `translate(${(x * 40).toFixed(1)}px, ${(-y * 40).toFixed(1)}px)`; };
    if (rover) { place(L.knob, 0, ax.thr); place(R.knob, ax.roll, 0); return; }
    place(L.knob, ax.yaw, ax.thr); place(R.knob, ax.roll, ax.pitch);
  };

  // --- 20 Hz: klavye entegrasyonu + yay, çizim, gönderim ---
  const tick = () => {
    const now = performance.now(), dt = Math.min(0.2, (now - lastT) / 1000); lastT = now;
    const kax = (neg, pos) => (keys.has(pos) ? 1 : 0) - (keys.has(neg) ? 1 : 0);
    const decay = Math.exp(-SPRING * dt);
    const spring = (key, dir) => { if (dir) ax[key] = clamp(ax[key] + dir * KEY_RATE * dt, -1, 1); else { ax[key] *= decay; if (Math.abs(ax[key]) < 0.004) ax[key] = 0; } };
    if (rover) {   // §31: iki eksen de yaylı; harf ve ok tuşları aynı ekseni sürer
      if (!drag.r) spring('roll', Math.max(-1, Math.min(1, kax('a', 'd') + kax('arrowleft', 'arrowright'))));
      if (!drag.l) spring('thr', Math.max(-1, Math.min(1, kax('s', 'w') + kax('arrowdown', 'arrowup'))));
    } else {
    if (!drag.r) { spring('roll', kax('arrowleft', 'arrowright')); spring('pitch', kax('arrowdown', 'arrowup')); }
    if (!drag.l) {
      spring('yaw', kax('a', 'd'));
      const t = kax('s', 'w');
      if (plane) { if (t) ax.thr = clamp(ax.thr + t * THR_RATE * dt, -1, 1); }   // tutmalı gaz
      else spring('thr', t);                                                     // askıya yaylı
    }
    }
    draw();
    const ch = channels();
    send(ch);
    onChange?.(ch);
  };
  window.addEventListener('keydown', onKeyDown); window.addEventListener('keyup', onKeyUp); window.addEventListener('blur', onBlur);
  const timer = setInterval(tick, 50);
  draw();
  return {
    channels,
    dispose() {
      if (disposed) return;
      disposed = true;
      clearInterval(timer);
      window.removeEventListener('keydown', onKeyDown); window.removeEventListener('keyup', onKeyUp); window.removeEventListener('blur', onBlur);
      L.off(); R.off();
      L.knob.style.transform = R.knob.style.transform = '';
      send([0, 0, 0, 0, 0, 0, 0, 0]);   // override serbest
    },
  };
}

// ======================================================================
// Kayıt oynatıcı: sunucudan gelen kare dizisi (fields sırası: flightsim_replay.FIELDS) → zaman t için enterpolasyonlu `tele` nesnesi
// (`servo`/`rc` sample-and-hold; `servo` yoksa 3B yüzeyler `rc`den türetir — eski önbellekler sunucuda v3 ile yeniden üretilir).
// requestAnimationFrame ile ilerler (hız 0.5×–8×); kaydırıcı/klavye ile atlama; olaylar zaman geldikçe şeride düşer (atlamada şerit
// yeniden kurulur: t'den önceki son 8 olay). Sonda durur.
// ======================================================================
// Uzun kayıt (önbellek `lod`, docs §8.3): `frames` 1 Hz GENEL BAKIŞ; tam hızdaki kareler PARCA_S saniyelik parçalar hâlinde istenir
// (cb.loadChunk(k) → frames). Parça gelene kadar genel bakış enterpolasyonla oynatılır (donma yok); oynatma yönünde bir sonraki parça önceden
// çekilir, bellekte en çok LOD_KEEP parça tutulur. Kısa kayıtta `lod` yoktur → tüm kareler tek dizide (eski davranış).
const LOD_KEEP = 8;
function createReplayPlayer(data, cb) {
  const F = data.frames || [], FI = Object.fromEntries((data.fields || []).map((k, i) => [k, i]));
  const lod = data.lod && data.lod.chunks > 0 && typeof cb.loadChunk === 'function' ? data.lod : null;
  const chunks = new Map(), pending = new Set(), failed = new Map();   // k → frames · istekte · k → son hata zamanı
  const t00 = F.length ? F[0][0] : 0, hz = Number(data.hz) || 25;
  const chunkOf = x => (lod ? Math.max(0, Math.min(lod.chunks - 1, Math.floor((x - t00) * hz / lod.chunk_n))) : -1);
  const want = k => {
    if (!lod || k < 0 || k >= lod.chunks || chunks.has(k) || pending.has(k) || (failed.get(k) || 0) > Date.now() - 5000) return;
    pending.add(k);
    cb.onLod?.(true);
    Promise.resolve(cb.loadChunk(k)).then(r => {
      const fr = Array.isArray(r) ? r : r?.frames;
      if (!disposed && Array.isArray(fr) && fr.length) {
        chunks.set(k, fr);
        while (chunks.size > LOD_KEEP) { const cur = chunkOf(t); const far = [...chunks.keys()].sort((a, b) => Math.abs(b - cur) - Math.abs(a - cur))[0]; chunks.delete(far); }
      }
    }).catch(() => failed.set(k, Date.now())).finally(() => { pending.delete(k); cb.onLod?.(pending.size > 0); if (!playing && !disposed) emitFrame(); });
  };
  const modes = data.modes || [];
  const EV = (data.events || []).slice().sort((a, b) => a.t - b.t);
  const dur = Math.max(0.001, Number(data.duration_s) || (F.length ? F[F.length - 1][0] : 0));
  const col = (fr, k) => (FI[k] == null ? null : fr[FI[k]]);
  let t = 0, speed = 1, playing = false, raf = 0, last = 0, evIdx = 0, disposed = false;
  const findIn = (A, x) => { let lo = 0, hi = A.length - 1; while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (A[mid][0] <= x) lo = mid; else hi = mid - 1; } return lo; };
  const lerp = (a, b, u) => (a == null ? b : b == null ? a : a + (b - a) * u);
  const lerpAng = (a, b, u) => { if (a == null || b == null) return a ?? b; let d = b - a; while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI; return a + d * u; };
  // t anını çevreleyen iki kare: parça yüklüyse tam hızdan (parça sonunda bir sonrakinin ilk karesi), değilse genel bakıştan
  const pairAt = x => {
    if (lod) {
      const k = chunkOf(x), C = chunks.get(k);
      want(k);
      if (C) {
        const pos = (x - C[0][0]) / Math.max(1e-6, C[C.length - 1][0] - C[0][0] || 1);
        if (pos > 0.6) want(k + 1);   // oynatma yönünde önceden çek
        if (x >= C[0][0]) {
          const i = findIn(C, x);
          if (i < C.length - 1) return [C[i], C[i + 1]];
          const N = chunks.get(k + 1);
          if (N && N.length) return [C[i], N[0]];
          if (k + 1 >= lod.chunks) return [C[i], C[i]];
        }
      }
    }
    const i = findIn(F, x);
    return [F[i], F[Math.min(i + 1, F.length - 1)]];
  };
  const frameAt = x => {
    if (!F.length) return null;
    const [a, b] = pairAt(x);
    const span = b[0] - a[0], u = span > 0 && span < 5 ? Math.max(0, Math.min(1, (x - a[0]) / span)) : 0;   // 5 sn'den uzun boşlukta tutma (log kesintisi)
    const g = k => lerp(col(a, k), col(b, k), u);
    const yaw = lerpAng(col(a, 'yaw'), col(b, 'yaw'), u);
    const vn = g('vn'), ve = g('ve'), vd = g('vd');
    const gs = g('gs'), hdg = col(a, 'hdg') != null ? ((lerpAng(col(a, 'hdg') * Math.PI / 180, col(b, 'hdg') * Math.PI / 180, u) * 180 / Math.PI) + 360) % 360 : null;
    const mi = col(a, 'mode');
    return { ts: Date.now(), t: x, lat: g('lat'), lon: g('lon'), alt_msl: g('alt_msl'), alt_rel: g('alt_rel'), roll: lerpAng(col(a, 'roll'), col(b, 'roll'), u), pitch: lerpAng(col(a, 'pitch'), col(b, 'pitch'), u), yaw,
      vn, ve, vd, airspeed: g('as'), groundspeed: gs != null ? gs : (vn != null ? Math.hypot(vn, ve || 0) : null), heading: hdg, climb: vd != null ? -vd : null,
      mode: mi != null ? modes[mi] : null, armed: !!col(a, 'armed'), gps_fix: col(a, 'fix'), sats: col(a, 'sats'), batt_v: g('batt_v'), batt_pct: col(a, 'batt_pct'),
      throttle: g('thr'), rc: col(a, 'rc') || [], servo: col(a, 'servo') || null, servo_fn: data.servo_fn || null, home: data.home || null, gcs_connected: null,
      att_body: (u < 0.5 ? col(a, 'body') : col(b, 'body')) || undefined,   // §25 tailsitter gövde yönelimi (SITL SIM; kayıt v4)
      tt: data.t0 != null ? Number(data.t0) + x : null };   // §24 hedef zamanı (kaynak saat): t0 + t   // servo: RCOU/SERVO_OUTPUT_RAW µs → 3B kontrol yüzeyleri (§8; önbellek v3)
  };
  const emitFrame = () => { const fr = frameAt(t); if (fr) cb.onFrame?.(fr); cb.onTime?.(t, dur, playing); };
  const syncEvents = () => {   // atlama: t'den önceki son 8 olayı şeride koy
    cb.onClear?.();
    evIdx = 0;
    while (evIdx < EV.length && EV[evIdx].t <= t) evIdx++;
    for (const e of EV.slice(Math.max(0, evIdx - 8), evIdx)) cb.onEvent?.(e, e.t);
  };
  const pumpEvents = () => { while (evIdx < EV.length && EV[evIdx].t <= t) { cb.onEvent?.(EV[evIdx], EV[evIdx].t); evIdx++; } };
  const tick = now => {
    if (disposed) return;
    raf = requestAnimationFrame(tick);
    const dt = Math.min(0.25, (now - last) / 1000); last = now;
    if (!playing) return;
    t += dt * speed;
    if (t >= dur) { t = dur; playing = false; }
    pumpEvents();
    emitFrame();
  };
  const seek = x => { t = Math.max(0, Math.min(dur, Number(x) || 0)); syncEvents(); emitFrame(); cb.onSeek?.(t); };
  const play = () => { if (t >= dur) t = 0; playing = true; last = performance.now(); cb.onTime?.(t, dur, playing); };
  const pause = () => { playing = false; cb.onTime?.(t, dur, playing); };
  raf = requestAnimationFrame(now => { last = now; tick(now); });
  seek(0);
  cb.onSpeed?.(speed);
  return {
    play, pause, toggle: () => (playing ? pause() : play()), seek, seekFrac: f => seek(f * dur), restart: () => { seek(0); play(); },
    setSpeed: s => { speed = Number(s) || 1; cb.onSpeed?.(speed); }, time: () => t, duration: () => dur, frameAt, playing: () => playing, speed: () => speed,
    lod: () => (lod ? { chunks: lod.chunks, loaded: chunks.size, pending: pending.size } : null),
    dispose: () => { disposed = true; cancelAnimationFrame(raf); chunks.clear(); },
  };
}

// ======================================================================
// MOCK: arka uç yokken yerel kinematik üretici (WS yerine). Oturumlar bellekte (sekme ömrü). Komutlar üreticiye uygulanır.
// Kayıt kipi (mode 'replay'): sahte log listesi + 2 dakikalık sahte kare dizisi (kalkış, daire, iniş; MSG olayları).
// ======================================================================
const MOCK = { sessions: new Map(), seq: 0, bankDeg: null };
const SAMPLE_CENTERS = [
  { id: 1, name: 'Örnek Merkez · Akyurt', lat: 40.1305, lon: 33.0876, alt: 1050, location_name: 'Ankara' },
  { id: 2, name: 'Örnek Merkez · Kıyı', lat: 36.8841, lon: 30.7056, alt: 30, location_name: 'Antalya' },
];
function mockBackend(ctx) {
  let centersP = null;
  const centers = () => (centersP ??= api.get('/api/drone/centers').then(r => (Array.isArray(r) && r.length ? r.map(c => ({ id: c.id, name: c.name, lat: c.lat, lon: c.lon, alt: c.alt ?? 0, location_name: c.location_name })) : SAMPLE_CENTERS)).catch(() => SAMPLE_CENTERS));
  const mockModel = (type, model) => (model && typeof model === 'object' ? model : { id: model || ({ multirotor: 'builtin:quad', hexarotor: 'builtin:hexa', helikopter: 'builtin:heli', interceptor: 'builtin:icept_x4', rover: 'builtin:rover_4x4' }[type] || 'builtin:caymaz'), source: 'builtin', type, ready: true,
    ...(type === 'rover' && (!model || String(model).startsWith('builtin:rover')) ? { drive: String(model || '').includes('4x4') || !model ? 'ackermann' : 'skid', glb_url: `/static/simumav/models/${String(model || 'builtin:rover_4x4').replace('builtin:', '')}.glb`, orient: { forward: '+x', up: '+y', scale: 1, offset: [0, 0, 0], prop: { mode: 'none', pos: [0, 0, 0], r: 0.3 } }, has_prop: false } : {}) });   // §31 kara aracı
  // §23 sahte kip güç varsayılanı (sunucu varsayilanlar ile aynı aile): uçak CAYMAZ · kara aracı elektrikli 4S 16000 mAh 60 W · kopter yakıtsız
  const mockPower = type => (isPlane(type) ? { max_speed_ms: 45, fuel_l: 5, fuel_km_per_l: 25, elec_cells: 4, elec_mah: 10000, elec_w: 30 } : type === 'rover' ? { max_speed_ms: null, fuel_l: 0, fuel_km_per_l: 12, elec_cells: 4, elec_mah: 16000, elec_w: 60 }
    : { max_speed_ms: null, fuel_l: 0, fuel_km_per_l: 25, elec_cells: 4, elec_mah: 10000, elec_w: 30 });
  const mk = async (type, centerId, world, model, power = null, layout = null, camera = null, drive = null) => {
    const cs = await centers();
    const center = cs.find(c => String(c.id) === String(centerId)) || cs[0];
    const id = `mock-${++MOCK.seq}`;
    const mdl = mockModel(type, model);
    const s = { id, type, model: mdl, airframe: isPlane(type) ? ({ 'builtin:caymaz': 'caymaz', 'builtin:delta': 'delta' }[mdl.id] || null) : null, layout: type === 'sabit_kanat' ? (layout || layoutForModel(mdl) || 'classic') : null, center, world: { ...WORLD_DEFAULTS, ...(world || {}) }, state: 'HAZIR', udp_port: 14550 + MOCK.seq - 1, host: location.hostname,
      power: { ...mockPower(type), ...(power || {}) },   // §23 (sahte kip: göstergeler istemci modelinden)
      ground: type === 'rover', drive: type === 'rover' ? normDrive(drive || mdl.drive) : null,   // §31 kara aracı (sunucu to_dict ile aynı alanlar)
      launch: { ...LAUNCH_DEFAULTS, ...((world || {}).launch || {}), method: type === 'sabit_kanat' || (type === 'interceptor' && isIceptLauncher((world || {}).launch?.method)) ? ((world || {}).launch?.method || 'wheels') : 'wheels', phase: null }, camera: normCamType(camera),
      created_at: new Date().toISOString(), owner: { id: ctx.user?.id, name: ctx.user?.full_name || ctx.user?.username || '—' }, gcs: { connected: false, addr: null, since: null }, sitl: { pid: 0, port: 0, error: null } };
    s.flight = new MockFlight(s);
    MOCK.sessions.set(id, s);
    return s;
  };
  // Kayıt kipi sahte oturumu: SITL/UDP yok; `replay` metası + kareler (mockReplayData) hazır → HAZIR
  const mkReplay = async (logId, world, model, camera = null) => {
    const log = MOCK_LOGS.find(l => l.id === Number(logId)) || MOCK_LOGS[0];
    const cs = await centers();
    const c = cs[0];
    const data = mockReplayData(log, c);
    const id = `mock-${++MOCK.seq}`;
    const s = { id, mode: 'replay', type: log.type, model: mockModel(log.type, model), center: { id: null, name: log.file_name, lat: data.home.lat, lon: data.home.lon, alt: data.home.alt }, world: { ...WORLD_DEFAULTS, ...(world || {}) },
      launch: { ...LAUNCH_DEFAULTS, ...((world || {}).launch || {}), method: log.type === 'sabit_kanat' ? ((world || {}).launch?.method || 'wheels') : 'wheels', phase: null },
      state: 'HAZIR', udp_port: null, host: location.hostname, camera: normCamType(camera), created_at: new Date().toISOString(), owner: { id: ctx.user?.id, name: ctx.user?.full_name || ctx.user?.username || '—' },
      gcs: { connected: false, addr: null, since: null }, sitl: { pid: null, port: null, error: null },
      power: mockPower(log.type), ground: log.type === 'rover', drive: log.type === 'rover' ? 'ackermann' : null,   // §23.6: sahte kayıtta da kadranlar (gerçekte kaydın canlı oturum ayarları) · §31
      replay: { log_id: log.id, file_name: log.file_name, size: log.size, progress: 100, frames: data.n, duration_s: data.duration_s, home: data.home, hz: data.hz, takeoff_t: data.takeoff_t, start_utc: data.start_utc, vehicle: data.vehicle, modes: data.modes } };
    s.data = data;
    MOCK.sessions.set(id, s);
    return s;
  };
  const pub = s => { const { flight, data, ...rest } = s; return rest; };
  return {
    mock: true,
    meta: async () => ({ types: TYPES.map(([key, name]) => ({ key, name, binary: isPlane(key) ? 'arduplane' : key === 'rover' ? 'ardurover' : 'arducopter' })), centers: await centers(), world_defaults: WORLD_DEFAULTS, limits: { max_sessions: 2, max_minutes: 120 }, host: location.hostname,
      replay: { logs_allowed: true, hz: 25, formats: ['.bin', '.log', '.tlog'] }, google3d: { enabled: true } }),
    g3dKey: async () => 'MOCK-GECERSIZ-ANAHTAR',   // sahte kip: Google 400/403 döner → hata yolu ("… prosedürele düşüldü") denenir
    logs: async ({ id } = {}) => (id != null ? MOCK_LOGS.filter(l => l.id === Number(id)) : simLogsOnly(MOCK_LOGS)).map(l => ({ ...l })),   // §8.5 sunucuyla aynı süzgeç
    replay: async id => { const s = MOCK.sessions.get(id); if (!s?.data) throw Object.assign(new Error('Kayıt oturumu değil'), { status: 400 }); return s.data; },
    sessions: async () => [...MOCK.sessions.values()].filter(s => s.state !== 'KAPANDI').map(pub),
    // sayfa üstü 4 bilgi kutusu (sahte sayılar; açık oturum sayısı gerçek sahte oturumlardan)
    runStats: async () => ({ days: 30, total: 12, total_all: 47, flight_s: 12 * 14 * 60 + 35, avg_s: 14 * 60, crash: 2, crash_events: 2, crash_rate: 16.7,
      last_crash_at: new Date(Date.now() - 2 * 86400e3).toISOString(), open_sessions: [...MOCK.sessions.values()].filter(s => s.state !== 'KAPANDI').length,
      last_run: { started_at: new Date(Date.now() - 3600e3).toISOString(), result: 'tamam', type: 'multirotor', mode: 'sitl' } }),
    session: async id => {
      if (!MOCK.sessions.has(id)) {   // sayfa yenilendi: aynı kimlikle varsayılan bir sahte oturum kur (…r → kayıt kipi)
        const n = Number(String(id).replace('mock-', '').replace(/r$/, '')) || 1; MOCK.seq = Math.max(MOCK.seq, n);
        const s = /r$/.test(String(id)) ? await mkReplay(1, {}) : await mk('multirotor', null, {}); MOCK.sessions.delete(s.id); s.id = id; MOCK.sessions.set(id, s);
      }
      return pub(MOCK.sessions.get(id));
    },
    create: async body => {
      if ([...MOCK.sessions.values()].filter(s => s.state !== 'KAPANDI').length >= 2) throw Object.assign(new Error('Oturum sınırı'), { status: 409 });
      if (body.mode === 'replay') { const s = await mkReplay(body.log_id, body.world, body.model, body.camera); MOCK.sessions.delete(s.id); s.id = `${s.id}r`; MOCK.sessions.set(s.id, s); return pub(s); }
      if (body.drive != null && body.drive !== '' && !['ackermann', 'skid'].includes(body.drive)) throw Object.assign(new Error('drive ackermann | skid olmalı'), { status: 400 });
      return pub(await mk(body.type, body.center_id, body.world, body.model || body.airframe, body.power, body.layout, body.camera, body.drive));
    },
    end: async id => { const s = MOCK.sessions.get(id); if (s) { s.state = 'KAPANDI'; s.flight?.end('Kullanıcı bitirdi'); MOCK.sessions.delete(id); } return { ok: true }; },
    cmd: async (id, name, params) => { const s = MOCK.sessions.get(id); if (!s) throw Object.assign(new Error('Oturum yok'), { status: 404 }); if (name === 'camera') { s.camera = normCamType(params?.type); return { ok: true, camera: s.camera }; } if (s.mode === 'replay') { if (name !== 'reset') throw Object.assign(new Error('Kayıtta komut yok'), { status: 400 }); return { ok: true }; }
      if (s.type === 'rover' && (name === 'takeoff' || name === 'motor_cut')) throw Object.assign(new Error(name === 'takeoff' ? 'Kara aracında kalkış yok; ARM edip sürün ya da AUTO/GUIDED kipine geçin' : 'Kara aracında motor kesme yok; DISARM kullanın'), { status: 400 });   // §31 sunucuyla aynı
      s.flight.cmd(name, params || {}); return { ok: true }; },
    socket: (id, handlers) => {
      const s = MOCK.sessions.get(id);
      if (!s) { handlers.fatal?.('notfound'); return { send() {}, close() {} }; }
      if (s.mode === 'replay') { handlers.status?.('open'); setTimeout(() => { handlers.message?.({ t: 'hello', session: pub(s) }); handlers.message?.({ t: 'event', text: `Kayıt hazır: ${s.replay.frames} kare · ${s.replay.duration_s} sn`, severity: 6 }); }, 0); return { send() {}, close() {} }; }
      return s.flight.attach(handlers, pub(s));
    },
    // §18 sahte kip: özet rapor tarayıcıda üretilir (kinematikten); rapor geçmişi yok
    summary: async id => { const s = MOCK.sessions.get(id); if (!s) throw Object.assign(new Error('Oturum yok'), { status: 404 }); return s.flight?.summary?.() || { v: 1, session_id: id, session: { type: s.type, type_name: TYPE_NAME[s.type], center: s.center, world_mode: s.world.mode, landing_circle_m: s.world.landing_circle_m || 30 }, flight: {}, mission: null, crash: null, deviation: null, safety: { code: 'no_mission' }, track: [] }; },
    reports: async () => ({ items: [] }),
    report: async () => { throw Object.assign(new Error('Sahte kipte rapor geçmişi yok'), { status: 404 }); },
    shareReport: async () => ({ ok: true }),
    href: id => `#/drone/sim${id ? `/${id}` : ''}?mock=1`,
  };
}

// Sahte uçuş logu listesi (kayıt kipi) ve 2 dakikalık sahte kare üretici: uçak pistten kalkar, 400 m yarıçapta daire çizer, iner.
const MOCK_LOGS = [
  { id: 1, file_name: '00000012.BIN', ext: 'bin', size: 253034496, uploaded_at: '2026-09-26T09:40:00', takeoff_utc: '2026-09-21T13:24:00Z', start_utc: '2026-09-21T13:01:41Z', aircraft: 'CZ-07', pilot: 'A. Yılmaz', location: 'Akyurt', task_code: 'SG-2026-014', vehicle: 'ArduPlane V4.7.1', type: 'sabit_kanat', flight_s: 120, duration_s: 150, cached: true, status: 'TAMAM', origin: 'REAL' },
  { id: 2, file_name: '20261016T093821-1-4e2a6023.tlog', ext: 'tlog', size: 233827, uploaded_at: '2026-10-16T09:40:00', start_utc: '2026-10-16T06:38:21Z', aircraft: 'Sanal dron', pilot: null, location: null, task_code: null, vehicle: 'ArduCopter', type: 'multirotor', flight_s: 95, duration_s: 120, cached: false, status: 'TAMAM', origin: 'SIM' },
  { id: 3, file_name: '00000009.BIN', ext: 'bin', size: 491417600, uploaded_at: '2026-09-26T10:19:00', takeoff_utc: '2026-09-20T08:12:00Z', aircraft: 'CZ-05', pilot: 'M. Kaya', location: 'Akyurt', task_code: null, vehicle: 'ArduPlane V4.6.0', type: 'sabit_kanat', flight_s: 1860, duration_s: 2400, cached: false, status: 'TAMAM' },
  { id: 4, file_name: '00000021.BIN', ext: 'bin', size: 18874368, uploaded_at: '2026-10-20T15:02:00', takeoff_utc: '2026-10-20T14:40:00Z', start_utc: '2026-10-20T14:39:10Z', aircraft: 'UGV-02', pilot: 'A. Yılmaz', location: 'Akyurt', task_code: null, vehicle: 'ArduRover V4.7.0', type: 'rover', flight_s: 100, duration_s: 120, cached: true, status: 'TAMAM', origin: 'REAL' },   // §31 kara aracı
];
function mockReplayData(log, c) {
  const plane = isPlane(log.type), rover = log.type === 'rover', hz = 25, dur = 120, home = { lat: c.lat, lon: c.lon, alt: Number(c.alt) || 0 };   // §31 kara aracı: yerde sürüş (z 0)
  const fields = ['t', 'lat', 'lon', 'alt_msl', 'alt_rel', 'roll', 'pitch', 'yaw', 'vn', 've', 'vd', 'gs', 'as', 'hdg', 'thr', 'mode', 'armed', 'batt_v', 'batt_pct', 'sats', 'fix', 'rc'];
  const modes = rover ? ['HOLD', 'MANUAL', 'AUTO', 'RTL'] : plane ? ['MANUAL', 'TAKEOFF', 'AUTO', 'RTL'] : ['STABILIZE', 'GUIDED', 'LOITER', 'LAND'];
  const frames = [], events = [{ t: 0, text: `${log.vehicle || 'ArduPlane'} (sahte kayıt)`, sev: 6 }, { t: 3, text: 'GPS 1: detected as u-blox at 115200 baud', sev: 6 }, { t: 8, text: 'EKF3 IMU0 is using GPS', sev: 6 }];
  const V = rover ? 5 : plane ? 22 : 8, R = rover ? 60 : plane ? 400 : 120, cosLat = Math.cos(home.lat * Math.PI / 180), cruiseZ = rover ? 0 : plane ? 120 : 30;
  let x = 0, y = 0, z = 0, yaw = 0, roll = 0, pitch = 0, vx = 0, vy = 0, vz = 0, mode = 0, armed = 0, thr = 0, ang = 0, batt = 100;
  let phase = 'ground';
  for (let i = 0; i <= dur * hz; i++) {
    const t = i / hz, dt = 1 / hz;
    if (phase === 'ground' && t >= 10) { phase = 'takeoff'; armed = 1; mode = 1; events.push({ t, text: 'Throttle armed', sev: 6 }, { t, text: `Mode ${modes[1]}`, sev: 6 }); }
    if (phase === 'takeoff' && rover) { phase = 'cruise'; mode = 2; ang = Math.atan2(y, x); events.push({ t, text: `Mode ${modes[2]}`, sev: 6 }); }
    if (phase === 'takeoff') {
      if (plane) { const sp = Math.min(V, Math.hypot(vx, vy) + 4 * dt); vx = Math.sin(yaw) * sp; vy = Math.cos(yaw) * sp; vz = sp > 15 ? 6 : 0; pitch = sp > 15 ? 0.25 : 0; thr = 95; }
      else { vz = 2.5; thr = 65; }
      if (z >= (plane ? 120 : 30)) { phase = 'cruise'; mode = 2; vz = 0; ang = Math.atan2(y, x); events.push({ t, text: `Mode ${modes[2]}`, sev: 6 }, { t, text: 'Reached target altitude', sev: 6 }); }
    } else if (phase === 'cruise') {
      const r0 = Math.hypot(x, y), r = r0 + (R - r0) * Math.min(1, dt * 0.4);
      ang += (V / r) * dt;
      const nx = Math.cos(ang) * r, ny = Math.sin(ang) * r;
      vx = (nx - x) / dt; vy = (ny - y) / dt; x = nx - vx * dt; y = ny - vy * dt;
      vz = rover ? 0 : (cruiseZ + (plane ? 8 : 2) * Math.sin(t * 0.3) - z) * 0.5;
      yaw = Math.atan2(vx, vy); roll = rover ? 0 : plane ? Math.atan((V * V) / (r * 9.81)) : 0.06 * Math.sin(t * 0.8); pitch = rover ? 0 : (plane ? 0.04 : 0) + vz * 0.02; thr = rover ? 25 : plane ? 55 : 48;
      if (t >= 85) { phase = 'rtl'; mode = 3; events.push({ t, text: `Mode ${modes[3]}`, sev: 6 }); if (plane) events.push({ t: t + 0.2, text: 'Low battery warning (sahte)', sev: 4 }); }
    } else if (phase === 'rtl') {
      const d = Math.hypot(x, y);
      if (d > 3) { const sp = Math.min(V, d); vx = -x / d * sp; vy = -y / d * sp; vz = rover ? 0 : -Math.min(3, z / Math.max(1, d / V)); yaw = Math.atan2(vx, vy); roll = 0; pitch = rover ? 0 : -0.05; thr = rover ? 25 : 40; }
      else { vx = vy = 0; vz = -Math.min(1.5, Math.max(0.3, z * 0.3)); roll = pitch = 0; thr = 25; }
      if (z <= 0.05 && d <= 3) { z = 0; vz = 0; if (armed) { armed = 0; thr = 0; mode = 0; phase = 'ground'; events.push({ t, text: 'Disarming motors', sev: 6 }); } }
    }
    x += vx * dt; y += vy * dt; z = Math.max(0, z + vz * dt);
    if (armed) batt = Math.max(0, batt - dt * 0.03);
    const lat = home.lat + y / 110574, lon = home.lon + x / (111320 * cosLat), gs = Math.hypot(vx, vy);
    const rc = [1500 + Math.round(400 * Math.sin(roll * 2)), 1500 - Math.round(400 * Math.sin(pitch * 2)), 1000 + Math.round(thr * 10), 1500, 1800, 1000, 1000, 1500];
    frames.push([Number(t.toFixed(3)), Number(lat.toFixed(7)), Number(lon.toFixed(7)), Number((home.alt + z).toFixed(2)), Number(z.toFixed(2)), Number(roll.toFixed(4)), Number(pitch.toFixed(4)), Number(yaw.toFixed(4)),
      Number(vy.toFixed(2)), Number(vx.toFixed(2)), Number((-vz).toFixed(2)), Number(gs.toFixed(2)), Number((gs + 2).toFixed(2)), Number((((yaw * 180 / Math.PI) + 360) % 360).toFixed(1)), thr, mode, armed,
      Number((14.2 + 2.6 * batt / 100).toFixed(2)), Math.round(batt), 14, 3, rc]);
  }
  return { v: 1, hz, fields, frames, modes, events, duration_s: dur, home, takeoff_t: 10, start_utc: log.start_utc || null, vehicle: log.vehicle || 'ArduPlane', type: log.type, n: frames.length, source: log.ext === 'tlog' ? 'tlog' : 'bin' };
}

// Basit kinematik uçuş: yerde bekle → arm → kalkış → merkez etrafında daire (uçak: pistten hızlanıp tırmanır; kopter dikey kalkar).
// 20 Hz `tele` paketi sözleşme §3 alanlarıyla; STATUSTEXT benzeri olaylar; komutlar: arm/disarm/mode/takeoff/rtl/reset/crash/set_home/rc.
class MockFlight {
  constructor(session) {
    this.s = session; this.plane = isPlane(session.type); this.rover = session.type === 'rover'; this.handlers = new Set(); this.timer = 0; this.reset();
  }
  reset() {
    const w = this.s.world;
    this.st = { t: 0, phase: 'ground', x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, yaw: (Number(w.runway_heading) || 0) * Math.PI / 180, roll: 0, pitch: 0,
      mode: this.plane || this.rover ? 'MANUAL' : 'STABILIZE', armed: false, thr: 0, batt_v: 16.8, batt_pct: 100, ang: 0, targetAlt: this.plane ? 150 : 30, auto: true, gcsAt: 10,
      v: 0, steer: 0 };   // §31 kara aracı: işaretli hız (m/s) + direksiyon (−1…1)
  }
  attach(handlers, pubSession) {
    this.handlers.add(handlers);
    handlers.status?.('open');
    handlers.message?.({ t: 'hello', session: pubSession });
    // Gerçek zamana göre adım: yavaş çizimde (yazılım WebGL) zamanlayıcı seyrekleşse de uçuş gerçek hızda ilerler (en çok 0.25 sn/adım)
    if (!this.timer) { this.lastTick = performance.now(); this.timer = setInterval(() => { const now = performance.now(); const dt = Math.min(0.25, (now - this.lastTick) / 1000); this.lastTick = now; this.step(dt * (this.speedup || 1)); }, 50); }
    return { send: obj => { if (obj?.t === 'cmd') this.cmd(obj.name, obj.params || {}); if (obj?.t === 'rc') this.rc = Array.isArray(obj.ch) && obj.ch.some(Boolean) ? obj.ch : null; }, close: () => { this.handlers.delete(handlers); if (!this.handlers.size) { clearInterval(this.timer); this.timer = 0; } } };
  }
  emit(m) { this.handlers.forEach(hh => hh.message?.(m)); }
  event(text, severity = 'info') { this.emit({ t: 'event', text, severity }); }
  launch(phase, extra = {}) { if (this.s.launch) this.s.launch.phase = phase; this.emit({ t: 'launch', method: this.s.launch?.method || 'wheels', phase, ts: Date.now() / 1000, ...extra }); }
  end(reason) { this.emit({ t: 'end', reason }); clearInterval(this.timer); this.timer = 0; }
  cmd(name, p) {
    const S = this.st;
    if (this.rover) { this.cmdRover(name, p); return; }   // §31
    if (name === 'arm') { S.armed = true; S.auto = false; this.event('Arming motors'); }
    else if (name === 'disarm') { S.armed = false; S.auto = false; S.phase = 'ground'; this.event('Disarming motors'); }
    else if (name === 'mode') { S.mode = p.mode || S.mode; S.auto = false; this.event(`Mode ${S.mode}`); if (S.mode === 'RTL') S.phase = 'rtl'; if (S.mode === 'LAND' || S.mode === 'QLAND') S.phase = 'land'; if ((S.mode === 'AUTO' || S.mode === 'LOITER') && S.armed && S.z > 2) S.phase = 'cruise'; }
    else if (name === 'takeoff') {
      S.targetAlt = Number(p.alt) || S.targetAlt; S.auto = false; if (!S.armed) { S.armed = true; this.event('Arming motors'); } S.mode = this.plane ? 'TAKEOFF' : 'GUIDED'; S.phase = 'takeoff'; this.event(`Takeoff to ${S.targetAlt} m`);
      if (this.s.type === 'sabit_kanat' && S.z < 1) {   // kalkış yöntemi dizisi (§13): armed → launch → released
        S.lt = 0; S.lphase = 'armed'; this.launch('armed');
        const m = this.s.launch?.method;
        if (m !== 'ramp') { S.lphase = 'launch'; this.launch('launch'); }
      } else if (this.s.type === 'interceptor' && isIceptLauncher(this.s.launch?.method) && S.z < 1) {   // §27 fırlatıcı: armed → launch → (AGL 1,5 m) released
        if (p.aim && this.s.launch) { this.s.launch.aim_az_deg = p.aim.az_deg; this.s.launch.aim_el_deg = p.aim.el_deg; }
        this.launch('armed'); setTimeout(() => this.launch('launch'), 400); setTimeout(() => this.launch('released', { speed_kmh: 0 }), 900);
      }
    }
    else if (name === 'rtl') { S.mode = 'RTL'; S.phase = 'rtl'; S.auto = false; this.event('Mode RTL'); }
    else if (name === 'reset') { this.reset(); this.emit({ t: 'state', state: 'BASLIYOR' }); this.event('SITL yeniden başlatıldı', 'warning'); setTimeout(() => this.emit({ t: 'state', state: 'HAZIR' }), 800); }
    else if (name === 'crash') { S.armed = false; S.phase = 'crashed'; S.auto = false; S.thr = 0; S.vx = S.vy = S.vz = 0; this.event('Crash: Disarming', 'critical'); }
    else if (name === 'set_home') this.event('Home set');
    else if (name === 'speed') { this.speedup = Number(p.factor) || 1; this.event(`Simülasyon hızı ${this.speedup}× (sahte)`); }   // §23: adım dt × speedup
  }
  // §31 kara aracı komutları (sunucu SahteKinematik ile aynı davranış): kalkış / motor kesme yok; RTL eve sürer → HOLD
  cmdRover(name, p) {
    const S = this.st;
    if (name === 'arm') { S.armed = true; S.auto = false; this.event('Arming motors'); }
    else if (name === 'disarm') { S.armed = false; S.auto = false; S.phase = 'ground'; this.event('Disarming motors'); }
    else if (name === 'mode') { S.mode = p.mode || S.mode; S.auto = false; S.phase = S.mode === 'RTL' || S.mode === 'SMART_RTL' ? 'rtl' : 'ground'; this.event(`Mode ${S.mode}`); }
    else if (name === 'rtl') { S.mode = 'RTL'; S.phase = 'rtl'; S.auto = false; this.event('Mode RTL'); }
    else if (name === 'takeoff' || name === 'motor_cut') this.event(name === 'takeoff' ? 'Kara aracında kalkış yok' : 'Kara aracında motor kesme yok', 'warning');
    else if (name === 'reset') { this.reset(); this.emit({ t: 'state', state: 'BASLIYOR' }); this.event('SITL yeniden başlatıldı', 'warning'); setTimeout(() => this.emit({ t: 'state', state: 'HAZIR' }), 800); }
    else if (name === 'crash') { S.armed = false; S.phase = 'crashed'; S.auto = false; S.thr = 0; S.v = 0; this.event('Crash: Disarming', 'critical'); }
    else if (name === 'set_home') this.event('Home set');
    else if (name === 'speed') { this.speedup = Number(p.factor) || 1; this.event(`Simülasyon hızı ${this.speedup}× (sahte)`); }
  }
  // §31 yerde sürüş (sunucu SahteKinematik._surus eşleniği): MANUAL/ACRO/STEERING → RC1 direksiyon + RC3 gaz (1500 dur); HOLD durur; RTL eve sürer;
  // diğer otomatik kipler merkez çevresinde seyir hızıyla tur. Otomatik senaryo: 4 sn sonra ARM + AUTO (tur). alt_rel her zaman 0.
  stepRover(dt) {
    const S = this.st, c = this.s.center, drv = normDrive(this.s.drive), Lm = ROVER_LIMITS[drv];
    const vmax = Lm.vmax, acc = Lm.accel, cruise = Math.min(5, vmax), R0 = 60;
    if (S.auto && S.t > 4) { S.auto = false; this.cmdRover('arm', {}); this.cmdRover('mode', { mode: 'AUTO' }); }
    let tv = 0, ts = 0;
    const wrap = a => { let d = a; while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI; return d; };
    if (S.armed && S.phase !== 'rtl' && ['MANUAL', 'ACRO', 'STEERING'].includes(S.mode)) {
      const n = i => Math.max(-1, Math.min(1, ((Number(this.rc?.[i]) || 1500) - 1500) / 500));
      tv = n(2) * vmax; ts = n(0);
    } else if (S.armed && S.phase === 'rtl') {
      const d = Math.hypot(S.x, S.y);
      if (d > 2) { tv = Math.min(cruise, d); ts = Math.max(-1, Math.min(1, wrap(Math.atan2(-S.x, -S.y) - S.yaw) * 1.5)); }
      else { S.phase = 'ground'; S.mode = 'HOLD'; this.event('Mode HOLD'); this.event('Reached destination'); }
    } else if (S.armed && S.mode !== 'HOLD') {
      const r = Math.hypot(S.x, S.y), tan = r > 1 ? Math.atan2(S.x, S.y) + Math.PI / 2 : S.yaw;   // saat yönünde tur + yarıçapa çekim
      const want = tan - Math.max(-0.6, Math.min(0.6, (r - R0) / R0));
      tv = cruise; ts = Math.max(-1, Math.min(1, wrap(want - S.yaw) * 1.5));
    }
    S.v += Math.max(-acc * dt, Math.min(acc * dt, tv - S.v));
    S.steer += Math.max(-3 * dt, Math.min(3 * dt, ts - S.steer));
    let yr = 0;
    if (S.armed) {
      if (drv === 'skid') yr = S.steer * Lm.turnRateDeg * Math.PI / 180;
      else if (Math.abs(S.steer) > 1e-3) { const T = Lm.steerDeg * Math.PI / 180, Rt = Lm.turnD * Math.sin(T) / Math.sin(Math.abs(S.steer) * T); yr = Math.sign(S.steer) * S.v / Rt; }
    } else S.v *= Math.exp(-3 * dt);
    S.yaw = wrap(S.yaw + yr * dt);
    S.vx = Math.sin(S.yaw) * S.v; S.vy = Math.cos(S.yaw) * S.v; S.vz = 0;
    S.x += S.vx * dt; S.y += S.vy * dt; S.z = 0; S.roll = 0; S.pitch = 0;
    S.thr = S.armed ? Math.round(Math.abs(S.v) / vmax * 1000) / 10 : 0;
    if (S.armed) { S.batt_pct = Math.max(0, S.batt_pct - dt * 0.01 * (1 + S.thr / 100)); S.batt_v = 14.2 + 2.6 * S.batt_pct / 100; }
    const g = Math.max(-1, Math.min(1, S.v / vmax));
    const [a, b] = drv === 'skid' ? [Math.max(-1, Math.min(1, g + S.steer)), Math.max(-1, Math.min(1, g - S.steer))] : [S.steer, g];   // SERVO_OUTPUT_RAW taklidi (sunucu servo())
    const servo = [Math.round(1500 + 500 * a), 1500, Math.round(1500 + 500 * b), 1500, 0, 0, 0, 0];
    const lat = c.lat + S.y / 110574, lon = c.lon + S.x / (111320 * Math.cos(c.lat * Math.PI / 180)), gs = Math.abs(S.v);
    const rc = this.rc || [Math.round(1500 + 500 * S.steer), 1500, Math.round(1500 + 500 * g), 1500, 1500, 1000, 1000, 1500];
    this.emit({ t: 'tele', ts: Date.now(), lat, lon, alt_msl: Number(c.alt) || 0, alt_rel: 0, roll: 0, pitch: 0, yaw: S.yaw, vn: S.vy, ve: S.vx, vd: 0,
      airspeed: gs, groundspeed: gs, heading: ((S.yaw * 180 / Math.PI) + 360) % 360, climb: 0, ys: yr, mode: S.mode, armed: S.armed, gps_fix: 3, sats: 14,
      batt_v: S.batt_v, batt_pct: S.batt_pct, throttle: S.thr, rc, servo, home: { lat: c.lat, lon: c.lon, alt: c.alt }, gcs_connected: this.s.gcs.connected, gcs_addr: this.s.gcs.addr,
      speedup: this.speedup || 1, tbm: Math.round(S.t * 1000) });
  }
  step(dt) {
    const S = this.st, w = this.s.world, g = 9.81;
    S.t += dt;
    if (S.t > S.gcsAt && !this.s.gcs.connected) { this.s.gcs.connected = true; this.s.gcs.addr = '192.0.2.10:14550'; this.event('GCS bağlandı (192.0.2.10)'); }
    if (this.rover) { this.stepRover(dt); return; }   // §31 kara aracı
    // Otomatik senaryo (komut gelmediyse): 4 sn sonra arm + kalkış
    if (S.auto && S.phase === 'ground' && S.t > 4) { this.cmd('takeoff', { alt: S.targetAlt }); S.auto = false; }
    const V = this.plane ? 22 : 8, R = MOCK.bankDeg ? Math.max(20, V * V / (9.81 * Math.tan(MOCK.bankDeg * Math.PI / 180))) : this.plane ? 450 : 150;   // ?bank=20: yatış açısından yarıçap (teşhis)
    const hdg = S.yaw;   // yaw: kuzeyden saat yönü
    if (S.phase === 'takeoff' && S.armed) {
      if (this.plane) {
        const sp = Math.hypot(S.vx, S.vy);
        const m = this.s.type === 'sabit_kanat' ? this.s.launch?.method : 'wheels';
        let ns, acc = 4, rot = 15;
        if (S.lphase) S.lt = (S.lt || 0) + dt;
        if (m === 'ramp' && S.lphase) {
          if (S.lphase === 'armed') { if (S.lt >= 1.2) { S.lphase = 'launch'; this.launch('launch', { angle_deg: this.s.launch.angle_deg }); } ns = 0; S.thr = 0; }
          else { acc = 44; rot = 20; ns = Math.min(V, sp + acc * dt); S.thr = 100; if (S.lphase === 'launch' && sp >= 8) { S.lphase = 'released'; this.launch('released', { speed_kmh: Math.round(sp * 36) / 10 }); } }
        } else if (m === 'vehicle' && S.lphase) {
          const rel = (Number(this.s.launch.release_kmh) || 70) / 3.6;
          acc = 2.5; rot = rel; ns = Math.min(V, sp + acc * dt); S.thr = S.lphase === 'released' ? 100 : 0;
          if (S.lphase === 'launch' && sp >= rel * 0.95) { S.lphase = 'released'; this.launch('released', { speed_kmh: Math.round(sp * 36) / 10 }); }
        } else {
          ns = Math.min(V, sp + acc * dt); S.thr = 100;
          if (S.lphase === 'launch' && S.z >= 1) { S.lphase = 'released'; this.launch('released', { speed_kmh: Math.round(sp * 36) / 10 }); }
        }
        S.vx = Math.sin(hdg) * ns; S.vy = Math.cos(hdg) * ns;
        const air = sp > rot;
        S.vz = air ? 7 : 0; S.pitch = air ? 16 * Math.PI / 180 : 0; if (air) S.thr = 85;   // dik tırmanış: merkez çevresindeki düzlük (300 m) bitmeden irtifa alsın
      } else { S.vx = S.vy = 0; S.vz = 2.5; S.thr = 65; S.pitch = 0; }
      if (S.z >= S.targetAlt) { S.phase = 'cruise'; S.lphase = null; S.mode = this.plane ? 'AUTO' : 'LOITER'; S.vz = 0; S.ang = Math.atan2(S.y, S.x); this.event(`Mode ${S.mode}`); this.event('Reached target altitude'); }
    } else if (S.phase === 'cruise' && S.armed) {
      // Merkez etrafında daire: konumu açıyla sür, yaw = hız yönü, roll = koordineli dönüş
      const r0 = Math.hypot(S.x, S.y);
      const r = r0 + (R - r0) * Math.min(1, dt * 0.4);
      S.ang += (V / r) * dt;
      const nx = Math.cos(S.ang) * r, ny = Math.sin(S.ang) * r;
      S.vx = (nx - S.x) / dt; S.vy = (ny - S.y) / dt; S.x = nx; S.y = ny;
      const za = S.targetAlt + (this.plane ? 10 : 3) * Math.sin(S.t * 0.25);
      S.vz = (za - S.z) * 0.5;
      S.yaw = Math.atan2(S.vx, S.vy);
      S.roll = this.plane || MOCK.bankDeg ? Math.atan((V * V) / (r * g)) : 0.08 * Math.sin(S.t * 0.7);
      S.pitch = (this.plane ? 2 : 0) * Math.PI / 180 + S.vz * 0.02;
      S.thr = this.plane ? 55 : 48;
      S.x -= S.vx * dt; S.y -= S.vy * dt;   // aşağıda ortak entegrasyon ekler
    } else if ((S.phase === 'rtl' || S.phase === 'land') && S.armed) {
      const d = Math.hypot(S.x, S.y);
      if (S.phase === 'rtl' && d > 3) { const sp = Math.min(V, d); S.vx = -S.x / d * sp; S.vy = -S.y / d * sp; S.vz = 0; S.yaw = Math.atan2(S.vx, S.vy); S.roll = 0; S.pitch = 0; S.thr = 50; }
      else { S.vx = S.vy = 0; S.vz = -Math.min(1.5, Math.max(0.3, S.z * 0.3)); S.roll = S.pitch = 0; S.thr = 30; if (S.phase === 'rtl') { S.phase = 'land'; S.mode = this.plane ? 'QLAND' : 'LAND'; this.event('Landing'); } }
      if (S.z <= 0.05 && S.phase === 'land') { S.z = 0; S.vz = 0; S.armed = false; S.phase = 'ground'; S.thr = 0; S.mode = this.plane ? 'MANUAL' : 'STABILIZE'; this.event('Disarming motors'); }
    } else if (S.armed && this.rc && S.phase === 'ground') {
      // Sanal kumanda (mock): gaz → dikey hız (kopter: 1500 askı), yaw → dönüş, pitch/roll → eğim ve yatay hız
      const n = i => ((Number(this.rc[i]) || 1500) - 1500) / 500;
      S.thr = Math.max(0, Math.min(100, ((Number(this.rc[2]) || 1000) - 1000) / 10));
      S.vz = this.plane ? (S.thr - 50) / 50 * 4 : n(2) * 4;
      S.yaw += n(3) * 1.6 * dt;
      S.roll = n(0) * 0.6; S.pitch = -n(1) * 0.5;
      const sp = this.plane ? 18 : 9, fwd = -S.pitch / 0.5 * sp, side = S.roll / 0.6 * sp;
      S.vx = Math.sin(S.yaw) * fwd + Math.cos(S.yaw) * side; S.vy = Math.cos(S.yaw) * fwd - Math.sin(S.yaw) * side;
      if (S.z <= 0 && S.vz < 0) S.vz = 0;
    } else if (!S.armed) { S.vx = S.vy = S.vz = 0; S.thr = 0; S.roll = 0; if (S.phase !== 'crashed') S.pitch = 0; }
    S.x += S.vx * dt; S.y += S.vy * dt; S.z = Math.max(0, S.z + S.vz * dt);
    if (S.armed) { S.batt_pct = Math.max(0, S.batt_pct - dt * 0.02 * (1 + S.thr / 100)); S.batt_v = 14.2 + 2.6 * S.batt_pct / 100; }
    const c = this.s.center, lat = c.lat + S.y / 110574, lon = c.lon + S.x / (111320 * Math.cos(c.lat * Math.PI / 180));
    const gs = Math.hypot(S.vx, S.vy), windDir = (Number(w.wind_dir) || 0) * Math.PI / 180, wind = Number(w.wind_ms) || 0;
    const air = Math.max(0, gs + wind * Math.cos(S.yaw - windDir));   // rüzgâr "nereden": burun rüzgâra dönükse hava hızı artar
    const rc = this.rc || [1500 + 500 * Math.sin(S.roll * 2), 1500 - 500 * Math.sin(S.pitch * 2), 1000 + S.thr * 10, 1500, 1800, 1000, 1000, 1500].map(v => Math.round(Math.max(1000, Math.min(2000, v))));
    this.emit({ t: 'tele', ts: Date.now(), lat, lon, alt_msl: (Number(c.alt) || 0) + S.z, alt_rel: S.z, roll: S.roll, pitch: S.pitch, yaw: S.yaw, vn: S.vy, ve: S.vx, vd: -S.vz,
      airspeed: air, groundspeed: gs, heading: ((S.yaw * 180 / Math.PI) + 360) % 360, climb: S.vz, mode: S.mode, armed: S.armed, gps_fix: 3, sats: 14,
      batt_v: S.batt_v, batt_pct: S.batt_pct, throttle: S.thr, rc, home: { lat: c.lat, lon: c.lon, alt: c.alt }, gcs_connected: this.s.gcs.connected, gcs_addr: this.s.gcs.addr,
      speedup: this.speedup || 1, tbm: Math.round(S.t * 1000) });   // §23: sahte kipte yakıt/batarya istemci modelinden (ts gerçek zaman; speedup adımı hızlandırır)
  }
}
