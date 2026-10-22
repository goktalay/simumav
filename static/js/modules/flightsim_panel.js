// Uçuş Simülatörü — YERLİ harekât paneli (docs/ucus-simulatoru.md §14). iframe YOK: panel, simülatör sayfasının kendi HTML/JS'idir (ui.js `h()`).
// Kullanıcı kararları (birebir): "sistem HTML değil mi? … aynı görünümde mevcut altyapı üzerine bir panel yarat" → iframe kaldırıldı;
// "paneller arasına boşluk koymuşsun; TEK bir panel olacak, duruma göre küçülüp büyüyecek; orijinal CSS yapısına birebir uy" → ayrı kartlar
// kaldırıldı: GÖKTUNGU harekât ekranının DRON KARTI (static/ops/css/stil.css `.dron-kart.ayrik`) tek gövde olarak yeniden kurulur.
//
// Görünüm — TEK KART (.fs-pn-kart; stil.css .dron-kart.ayrik: --panel-arka zemin, 1 px --cizgi kenarlık, 6 px köşe, 0 8px 32px gölge; 400 px
//   [hepgo.css], <1100 px 340 px, <760 px tam genişlik), sağ üstte, başlığından sürüklenir, içerik taşarsa kart içinde kaydırılır (max-height = alan):
//   BAŞLIK ŞERİDİ (.dron-kart-baslik: --dugme-arka zemin, 10 px dolgu, 600): durum noktası (.dk-nokta) · dron adı (.dk-ad) · özet (.dk-baslik-ozet:
//     irtifa + kip) · ARM rozeti · MP · HUB (hepgo.css .hk-bagla kapsülleri) · küçült (.dk-kucult-btn: yalnız başlık kalır, .dk-yalniz-baslik)
//   GÖVDE (.dron-kart-icerik: Consolas 12 px): ÜST SATIR (.dk-ust-satir: UÇUŞA HAZIR rozeti [.dk-hazir-rozet; tıkla → ARM/DISARM onayı] + İŞLEMLER
//     düğmesi [.dk-islem-btn; İŞLEMLER bölümünü açar/kapar]) · bölümler — her biri .dk-konsol-bas başlık şeridinden katlanır (ok döner):
//     UÇUŞ GÖSTERGESİ (PFD canvas; .dk-pfd-canvas 8 px köşe) · TELEMETRİ 4×2 karo (.dk-tel-hucre: ikon 20 px, Consolas 12 px kalın değer, 9 px
//     büyük harf etiket; DURUM/MOD/KOMUT tıklanır) · İŞLEMLER (.dk-islem-izgara 3 sütun .dk-islem-hucre + .dk-islem-grup grup başlıkları: Uçuş /
//     Hedef / Rota / Sim) · MISSION PLANNER (UDP adres mono + Kopyala [koyu düğme] + kısa talimat; rozet Bekleniyor/Bağlı ip:port bölüm
//     BAŞLIĞINDA → katlıyken de okunur; GCS bağlı değilken açık, bağlanınca kendiliğinden katlanır, kullanıcı elle katlar/açarsa tercihi kalır
//     [fs.panel.fold.mp]) · HABERLEŞME konsolu (.dk-konsol-govde: #0b0f14 zemin, 10,5 px mono; satır = saat ETİKET metin) — alt ortadaki ayrı
//     KONSOL kutusu KALKTI (madde 3: tek konsol, kart içinde). Panel HER TEMADA koyudur (GÖKTUNGU koyu tema değişkenleri .fs-pn üzerinde --gt-*).
//   Kullanıcı geri bildirimi: "scroll ince ve panele uygun renkte olacak; alttaki Mission Planner bağlantı panelinde beyaz düğmeler var, onlar da
//   uygun renkte olacak ve panel içine collapse şekilde yerleşecek" → sol alttaki ayrı MP kutusu panel açıkken KALKAR; aynı MP bileşeni (TEK DOM,
//   placeMp taşır) panel kapalıyken (sade görünüm) ya da FPV'de sol altta KOYU kutuda (.fs-pn-yuzen; beyaz düğme yok) gösterilir. Kayıt kipinde
//   MP yok (flightsim.js kayıt bilgisi kutusu). Kaydırma çubukları ince 6 px, panel zemini renginde (app.css .fs-pn ::-webkit-scrollbar).
// Veri/komut yolu — telemetri (PFD/karolar) simülatörün /ws/drone/sim tele'sinden (update(t)); hub durumu, konsol satırları ve KOMUTLAR için
//   bu modül kendi /ws/drone/live soketini açar ({t:'watch', sim_id} → hello/status/console/res; flightsim_hub.SimBridge) ve komutları hub
//   {t:'cmd', rid, bridge_id: -(9000+N), sysid: 1, name, params} ile gönderir (GÖKTUNGU kalkış/rota akışları sunucuda yürür). Simülatöre ÖZGÜ iki
//   komut sim WS yolundan gider (cmdSim): Sıfırla (reset) ve sabit kanat kalkış düzeneği (rampa/araç/tekerlek: takeoff{alt}, §13).
// Davranış — Panel düğmesi / P → kart gizli (sade görünüm: eski .fs-hud + alt çubuk komutları); FPV'de kart gizli (askeri HUD kalır);
//   yazma izni / hub komut yetkisi yoksa düğmeler pasif; kayıt (replay) ve sahte (mock) kiplerinde hub yoktur → İŞLEMLER yok, PFD/telemetri
//   çalışır. Kart başlığından sürüklenir (localStorage fs.panel.col), katlama fs.panel.fold, küçült fs.panel.min, açık/kapalı fs.ops.on.
// Pencereler (ARM onayı, kalkış, hedef) ui.js modal() ile body'ye eklenir; tam ekran document.documentElement'e alındığı için (flightsim.js) görünürler.
// Dışa: createOpsPanel(stage, opts) → { el, enabled, toggle(v), setFpv(v), update(tele), setState(st), setRoute(points), setGcs(on, addr), log(text, sev, tag), dispose() }
//   opts.mp = { addr: 'host:port', port, copy(addr) } → MISSION PLANNER bölümü + yüzen kutu; null/yok → MP yok (kayıt kipi)
import { api } from '../api.js';
import { confirmDialog, field, h, modal, toast, toastError, t as tr } from '../ui.js';
import { createSpeedPill, elecText, fuelText, minText, rangeText } from './flightsim_power.js';   // §23: yakıt/batarya karoları + Sim grubunda hız seçici

const KEY_ON = 'fs.ops.on', KEY_COL = 'fs.panel.col', KEY_FOLD = 'fs.panel.fold', KEY_MIN = 'fs.panel.min';
const DEG = Math.PI / 180;
const num = (v, d = null) => (v == null || Number.isNaN(Number(v)) ? d : Number(v));
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const wrap180 = a => ((a + 180) % 360 + 360) % 360 - 180;
const pad3 = v => String(Math.round(((v % 360) + 360) % 360)).padStart(3, '0');
const f0 = v => (v == null || Number.isNaN(Number(v)) ? '—' : String(Math.round(Number(v))));
const f1 = v => (v == null || Number.isNaN(Number(v)) ? '—' : Number(v).toFixed(1));
const CARD = { 0: 'N', 90: 'E', 180: 'S', 270: 'W' };
const TYPE_NAME = { multirotor: 'Multikopter', hexarotor: 'Hexakopter', helikopter: 'Helikopter', sabit_kanat: 'Sabit Kanat', vtol: 'VTOL', interceptor: 'INTERCEPTOR', rover: 'Kara Aracı' };   // §31 rover
const LAUNCH_BTN = { ramp: 'Fırlat', vehicle: 'Aracı sür', wheels: 'Kalkış', pod4: 'Fırlat', pod8: 'Fırlat', tube: 'Fırlat', handheld: 'Fırlat' };   // §27 fırlatıcılar
const SEV_CLASS = { hata: 'err', uyari: 'warn', basari: 'ok', bilgi: '' };
// GÖKTUNGU kalkış kontrol listesi (kalkis_kontrol.js) — simülatörde zorunlu maddeler; sunucu drone_takeoff_checks'e kaydeder (hub takeoff{kontrol})
const CHECKLIST = [
  ['pervane', 'Pervaneler sağlam, güvenlik alanı boş'], ['batarya', 'Batarya dolu ve sabitlenmiş'], ['gps', 'GPS fix ve yeterli uydu'],
  ['ev', 'Ev konumu doğru'], ['hava', 'Hava koşulları uygun'], ['mod', 'Uçuş modu ve failsafe ayarları kontrol edildi'],
];
const gpsText = fix => (fix >= 6 ? 'RTK' : fix === 5 ? 'RTK FLT' : fix === 4 ? 'DGPS' : fix === 3 ? '3D' : fix === 2 ? '2D' : '—');
const lsGet = (k, d = null) => { try { const v = JSON.parse(localStorage.getItem(k) || 'null'); return v == null ? d : v; } catch { return d; } };
const lsSet = (k, v) => { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, JSON.stringify(v)); } catch { /* */ } };
const editable = el => el && (/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || el.isContentEditable);
// İkonlar: GÖKTUNGU dron kartı Font Awesome kullanır (fa-arrows-up-down, fa-gauge-high, fa-battery-*, fa-satellite-dish, fa-lock/-open, fa-microchip,
// fa-fan, fa-plane-departure/-arrival …); burada aynı anlamda satır içi SVG (flightsim.js svgIco kalıbı) — dış yazı tipine bağımlılık yok
const svg = body => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
const ICO = {
  alt: svg('<path d="M8 4v16M8 4 5 7M8 4l3 3M16 20V4M16 20l-3-3M16 20l3-3"/>'),
  spd: svg('<path d="M4 16a8 8 0 0 1 16 0"/><path d="M12 16l4-6"/><circle cx="12" cy="16" r="1.6"/><path d="M4 16h2M18 16h2"/>'),
  bat: svg('<rect x="2.5" y="8" width="16" height="8" rx="1.6"/><path d="M21 11v2"/><rect class="fill" x="4.5" y="10" width="12" height="4" fill="currentColor" stroke="none"/>'),
  fuel: svg('<path d="M5 21V5a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2v16"/><path d="M4 21h12"/><path d="M7 7h6v4H7z"/><path d="M15 9h2a2 2 0 0 1 2 2v5a1.5 1.5 0 0 0 3 0V9l-2-2"/>'),
  gps: svg('<path d="M4 11a9 9 0 0 1 9 9"/><path d="M4 7a13 13 0 0 1 13 13"/><path d="M4 20l5-5"/><circle cx="10" cy="14" r="1.6"/>'),
  lock: svg('<rect x="5" y="11" width="14" height="9" rx="1.6"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>'),
  unlock: svg('<rect x="5" y="11" width="14" height="9" rx="1.6"/><path d="M8 11V8a4 4 0 0 1 7.5-2"/>'),
  mode: svg('<rect x="7" y="7" width="10" height="10" rx="1.6"/><path d="M10 3v4M14 3v4M10 17v4M14 17v4M3 10h4M3 14h4M17 10h4M17 14h4"/>'),
  fan: svg('<circle cx="12" cy="12" r="2"/><path d="M12 10c0-4 2.5-6.5 5-5.5s.5 5.5-5 5.5M14 12c4 0 6.5 2.5 5.5 5s-5.5.5-5.5-5M12 14c0 4-2.5 6.5-5 5.5s-.5-5.5 5-5.5M10 12c-4 0-6.5-2.5-5.5-5s5.5-.5 5.5 5"/>'),
  takeoff: svg('<path d="M3 20h18"/><path d="M3.5 14.5l3.5-.8 3.8 1.9 7.6-4.5c1.2-.7 2.7-.2 2.6 1.2l-.1.5-9.3 5.3-8.1-3.6z"/><path d="M8 9l3 1.5"/>'),
  land: svg('<path d="M3 20h18"/><path d="M3.5 9.5l3.6 1 2.4 3.6 8.6 2.1c1.4.3 2.6-.7 2.1-1.9l-.3-.5-10.4-2.5-6-1.8z"/><path d="M9 6l1 3.5"/>'),
  rtl: svg('<path d="M4 11l8-7 8 7"/><path d="M6 10v10h12V10"/><path d="M12 20v-4"/><path d="M9.5 14.5 12 12l2.5 2.5"/>'),
  home: svg('<path d="M4 11l8-7 8 7"/><path d="M6 10v10h12V10"/><path d="M10 20v-5h4v5"/>'),
  goto: svg('<circle cx="12" cy="12" r="6"/><path d="M12 2v4M12 18v4M2 12h4M18 12h4"/><circle cx="12" cy="12" r="1.5" fill="currentColor"/>'),
  upload: svg('<path d="M12 16V5M12 5 8 9M12 5l4 4"/><path d="M4 15v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3"/>'),
  play: svg('<path d="M7 5v14l11-7z" fill="currentColor"/>'),
  pause: svg('<rect x="6" y="5" width="4" height="14" rx="1" fill="currentColor"/><rect x="14" y="5" width="4" height="14" rx="1" fill="currentColor"/>'),
  resume: svg('<path d="M5 5v14l8-7z" fill="currentColor"/><path d="M15 5v14" stroke-width="2.4"/>'),
  cancel: svg('<path d="M6 6l12 12M18 6 6 18"/>'),
  reset: svg('<path d="M4 12a8 8 0 1 0 2.3-5.7"/><path d="M4 4v5h5"/>'),
  layout: svg('<rect x="3" y="4" width="18" height="16" rx="1.6"/><path d="M3 10h18M9 10v10M15 10v10"/>'),
  up: svg('<path d="M6 15l6-6 6 6"/>'),
  down: svg('<path d="M6 9l6 6 6-6"/>'),
  chat: svg('<path d="M4 5h16v10H9l-5 4z"/>'),
};

export function createOpsPanel(stage, opts = {}) {
  const { sid, session = {}, type = 'multirotor', modes = [], launch = null, canWrite = false, hub = true, cmdSim = null, onToggle = null, onReset = null, mp = null, speed = null } = opts;
  const getSim = opts.getSim || (() => null);
  const bridgeId = session.hub?.bridge_id ?? null;
  let on = (localStorage.getItem(KEY_ON) ?? '1') !== '0';
  let tele = null, hubState = {}, hubOnline = false, hubCan = null, gcs = !!session.gcs?.connected, state = session.state || 'HAZIR', routePts = session.route || [];
  let disposed = false, hubWs = null, hubTimer = 0, hubPing = 0, hubRetry = 0, hubClosed = false, ridSeq = 0;
  const pending = new Map();   // rid → {resolve, timer, name}
  const fold = lsGet(KEY_FOLD, { ops: true });   // İŞLEMLER varsayılan katlı (GÖKTUNGU'da İŞLEMLER düğmesi açar)
  const isPlane = type === 'sabit_kanat' || type === 'vtol' || type === 'interceptor';
  const rover = type === 'rover';   // §31 kara aracı: kalkış / iniş / irtifa yok; KOMUT karosu "Dur" (HOLD), İRTİFA karosu yerine EĞİM
  const launchBtnText = () => (rover ? 'Dur' : tele?.armed && (num(tele.alt_rel, 0) > 2 || (launch && launch.phase && launch.phase !== 'armed')) ? 'İniş' : (LAUNCH_BTN[launch?.method] || 'Kalkış'));
  const canCmd = () => canWrite && hub && hubOnline && hubCan !== false && state === 'HAZIR';
  const ico = (k, cls = '') => h('i', { class: `fs-pn-ico ${cls}`, html: ICO[k] });

  // ---------- bölüm iskeleti (stil.css .dk-konsol-bas başlık şeridi: ok + ad + araçlar; başlıktan katlanır) ----------
  const bolum = (key, title, body, { extra = null, cls = '' } = {}) => {
    const ok = h('span', { class: 'fs-pn-ok', html: ICO.down });
    const head = h('div', { class: 'fs-pn-bas', role: 'button', tabindex: 0, title: tr('Katla / aç'), onclick: () => setFold(key, !el.classList.contains('folded')),
      onkeydown: e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); head.click(); } } }, ok, h('span', { class: 'fs-pn-bas-ad' }, title), extra);
    const el = h('div', { class: `fs-pn-bolum ${cls}`, 'data-card': key }, head, body);
    if (fold[key]) el.classList.add('folded');
    return el;
  };
  const setFold = (key, v) => { const el = root.querySelector(`[data-card="${key}"]`); el?.classList.toggle('folded', v); fold[key] = v; lsSet(KEY_FOLD, fold); if (key === 'pfd' && !v) { pfdDirty = true; if (!raf) raf = requestAnimationFrame(frame); } if (key === 'ops') islemBtn.classList.toggle('acik', !v); };

  // --- BAŞLIK ŞERİDİ (.dron-kart-baslik): nokta · ad · özet (irtifa + kip) · ARM · MP · HUB · küçült ---
  const B = {
    nokta: h('span', { class: 'fs-pn-nokta', title: tr('Oturum durumu') }),
    name: h('span', { class: 'fs-pn-ad' }, session.hub?.name || (session.drone ? `${session.drone.code || ''} ${session.drone.name || ''}`.trim() : null) || tr('Simülatör #{n}', { n: sid })),
    irt: h('span', { class: 'fs-pn-ozet-irt' }, ''), kip: h('span', { class: 'fs-pn-ozet-kip' }, ''),
    arm: h('span', { class: 'fs-pn-rozet yok' }, 'DISARMED'),
    hub: h('span', { class: 'fs-pn-rozet yok', title: tr('Harekât hub bağlantısı (/ws/drone/live)') }, 'HUB'),
  };   // Mission Planner durumu MISSION PLANNER bölümünün başlık rozetinde (kart başlığında yer dar: ad kesilmesin)
  const minBtn = h('button', { class: 'fs-pn-kucult', type: 'button', title: tr('Küçült (yalnız başlık)'), html: ICO.up, onclick: e => { e.stopPropagation(); setMin(!kart.classList.contains('yalniz-baslik')); } });
  // §35 uçuş kartında Sıfırla (onaylı): sim `reset` — parametreler/scriptler/görev korunur, Mission Planner bağlantısı kopmaz
  const resetOnayli = async () => {
    if (!canWrite) { toast(tr('Sıfırlamak için yazma izni gerekir'), 'err'); return; }
    if (!await confirmDialog('Sıfırla', tr('Simülatör sıfırlansın mı? Araç başlangıç noktasına döner; parametreler, scriptler ve görev korunur, Mission Planner bağlantısı kopmaz.'), { okLabel: 'Sıfırla', danger: true })) return;
    onReset ? onReset() : cmdSim?.('reset');
  };
  const resetBtn = canWrite ? h('button', { class: 'fs-pn-reset', type: 'button', title: tr('Sıfırla (onaylı): araç başlangıca döner; parametreler ve scriptler korunur'), 'aria-label': tr('Sıfırla'), html: ICO.reset, onclick: e => { e.stopPropagation(); resetOnayli(); } }) : null;
  const baslik = h('div', { class: 'fs-pn-baslik' }, B.nokta, B.name, h('span', { class: 'fs-pn-ozet' }, B.irt, B.kip), B.arm, hub ? B.hub : null, resetBtn, minBtn);
  const setMin = v => { kart.classList.toggle('yalniz-baslik', v); minBtn.innerHTML = v ? ICO.down : ICO.up; minBtn.title = tr(v ? 'Geri büyüt' : 'Küçült (yalnız başlık)'); lsSet(KEY_MIN, v ? 1 : null); if (!v) { pfdDirty = true; if (!raf) raf = requestAnimationFrame(frame); } };

  // --- ÜST SATIR (.dk-ust-satir): UÇUŞA HAZIR rozeti (tıkla → ARM/DISARM) + İŞLEMLER düğmesi ---
  const hazirMetin = h('span', { class: 'fs-pn-hazir-metin' }, '—');
  const hazirBtn = h('button', { class: 'fs-pn-hazir bilinmiyor', type: 'button', title: tr('ARM / DISARM (onaylı)'), onclick: () => { if (!hazirBtn.classList.contains('off')) armToggle(); } }, hazirMetin);
  const islemBtn = h('button', { class: `fs-pn-islem-btn ${fold.ops ? '' : 'acik'}`, type: 'button', title: tr('İşlemler bölümünü aç/kapat'), onclick: () => setFold('ops', !fold.ops) }, h('span', { class: 'fs-pn-islem-metin' }, 'İŞLEMLER'));
  const ustSatir = h('div', { class: 'fs-pn-ust' }, hazirBtn, hub ? islemBtn : null);

  // --- UÇUŞ GÖSTERGESİ (PFD) ---
  const canvas = h('canvas', { class: 'fs-pn-pfd' });
  const g = canvas.getContext('2d');
  const pfdBolum = bolum('pfd', rover ? 'SÜRÜŞ GÖSTERGESİ' : 'UÇUŞ GÖSTERGESİ', h('div', { class: 'fs-pn-pfd-wrap' }, canvas));

  // --- TELEMETRİ karoları 4×2 (.dk-tel-hucre: ikon · değer · etiket) ---
  const tile = (key, label, icon, { click = null, title = null } = {}) => {
    const v = h('b', { class: 'fs-pn-tile-v' }, '—'), sub = h('small', { class: 'fs-pn-tile-sub' }, '');
    const i = ico(icon);
    const el = h('div', { class: `fs-pn-tile ${click ? 'act' : ''}`, 'data-tile': key, role: click ? 'button' : null, tabindex: click ? 0 : null, title }, i, v, sub, h('span', { class: 'fs-pn-tile-et' }, label));
    if (click) { el.addEventListener('click', e => { e.stopPropagation(); if (el.classList.contains('off')) return; click(el); }); el.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); el.click(); } }); }
    return Object.assign(el, { v, sub, i });
  };
  const T = {
    alt: tile('alt', rover ? 'EĞİM' : 'İRTİFA', 'alt'), spd: tile('spd', 'HIZ', 'spd'), bat: tile('bat', 'BATARYA', 'bat'), gps: tile('gps', 'GPS', 'gps'),
    arm: tile('arm', 'DURUM', 'lock', { click: () => armToggle(), title: tr('ARM / DISARM (onaylı)') }),
    mode: tile('mode', 'MOD', 'mode', { click: el => modeMenu(el), title: tr('Uçuş modu seç') }),
    type: tile('type', 'TİP', 'fan'),
    cmd: tile('cmd', 'KOMUT', 'takeoff', { click: () => (rover ? hubCmd('set_mode', { mode: 'HOLD' }) : launchBtnText() === 'İniş' ? land() : takeoffDialog()), title: tr(rover ? 'Dur (HOLD)' : 'Kalkış / iniş') }),
    fuel: tile('fuel', 'YAKIT', 'fuel', { title: tr('Yakıt: kalan litre, yüzde, kalan menzil (§23)') }),   // §23: yalnız tele.fuel varsa görünür
  };
  T.fuel.hidden = true;
  T.type.v.textContent = tr(TYPE_NAME[type] || type); T.type.sub.textContent = session.sitl || session.mode === 'replay' ? (session.mode === 'replay' ? tr('Kayıt') : 'SITL') : '';
  const tilesBolum = bolum('tiles', 'TELEMETRİ', h('div', { class: 'fs-pn-tiles' }, T.alt, T.spd, T.bat, T.gps, T.arm, T.mode, T.type, T.cmd, T.fuel));
  // §23 simülasyon hızı (Sim grubu): 1×/2×/4×/8× → cmd speed (SIM_SPEEDUP); seçili düğme tele.speedup ile eşitlenir
  const speedPill = speed ? createSpeedPill({ h, tr, onPick: f => speed.onPick?.(f), cls: 'fs-pn-speed-pill' }) : null;

  // --- İŞLEMLER (.dk-islem-izgara 3 sütun; .dk-islem-grup grup başlıkları; .dk-islem-hucre: ikon + metin) ---
  const hucre = (label, icon, fn, cls = '') => h('button', { class: `fs-pn-hucre ${cls}`, type: 'button', onclick: fn }, ico(icon, 'fs-pn-hucre-ico'), h('span', { class: 'fs-pn-hucre-metin' }, label));
  const grup = s => h('div', { class: 'fs-pn-grup' }, s);
  const routeSel = h('select', { class: 'fs-pn-girdi fs-pn-route' }, h('option', { value: '' }, 'Rota seçin…'));
  const routeInfo = h('div', { class: 'fs-pn-not fs-pn-route-info' }, '');
  const altInp = h('input', { class: 'fs-pn-girdi fs-pn-num', type: 'number', min: 1, max: 500, value: isPlane ? 80 : 30, title: tr('Hedef irtifa (m, AGL)') });
  const opsBody = h('div', { class: 'fs-pn-izgara fs-pn-ops-body' },
    grup(rover ? 'Sürüş' : 'Uçuş'),
    rover ? [hucre('Dur (HOLD)', 'pause', () => hubCmd('set_mode', { mode: 'HOLD' }), 'fs-pn-hold'), hucre('RTL', 'rtl', () => hubCmd('rtl'))]   // §31 kara aracı: kalkış / iniş yok
      : [hucre(LAUNCH_BTN[launch?.method] || 'Kalkış', 'takeoff', () => takeoffDialog(), 'fs-pn-takeoff'), hucre('İniş', 'land', () => land()), hucre('RTL', 'rtl', () => hubCmd('rtl'))],   // akıllı Kalkış/İniş KOMUT karosunda; burada sabit
    hucre('Ev konumu', 'home', () => setHome()),
    grup('Hedef'),
    rover ? null : h('label', { class: 'fs-pn-hucre fs-pn-hucre-girdi', title: tr('Hedef irtifa (m, AGL)') }, altInp, h('span', { class: 'fs-pn-hucre-metin' }, 'm AGL')),
    rover ? null : hucre('İrtifa', 'alt', () => hubCmd('altitude_change', { alt_rel_m: Number(altInp.value) || 30 })), hucre('Hedefe git', 'goto', () => gotoDialog()),
    grup('Rota'),
    h('div', { class: 'fs-pn-tam' }, routeSel),
    hucre('Yükle', 'upload', () => routeUpload(), 'fs-pn-route-up'), hucre('Başlat', 'play', () => hubCmd('mission_start', { rota: routeName() }), 'fs-pn-route-start'),
    hucre('Duraklat', 'pause', () => hubCmd('mission_pause', { davranis: 'bekle' })), hucre('Sürdür', 'resume', () => hubCmd('mission_resume', {})),
    hucre('İptal', 'cancel', () => hubCmd('mission_cancel', { rota: routeName() }), 'tehlikeli'),
    h('div', { class: 'fs-pn-tam' }, routeInfo),
    grup('Sim'),
    hucre('↺ Sıfırla', 'reset', () => resetOnayli(), 'fs-pn-free'), hucre('Yerleşimi sıfırla', 'layout', () => resetLayout(), 'fs-pn-free'),
    speedPill ? h('div', { class: 'fs-pn-tam fs-pn-speed' }, h('span', { class: 'fs-pn-not' }, tr('Simülasyon hızı')), speedPill.el) : null,
    h('div', { class: 'fs-pn-tam fs-pn-not fs-pn-perm' }, ''));
  const opsBolum = bolum('ops', 'İŞLEMLER', opsBody);

  // --- MISSION PLANNER (UDP adres · Kopyala · talimat; rozet bölüm başlığında) — TEK bileşen: panel görünürken bölümde, değilse sol alt koyu kutuda ---
  let gcsAddr = session.gcs?.addr || '';
  const mpRozet = mp ? h('span', { class: 'fs-pn-rozet fs-pn-mp-rozet yok', title: tr('Mission Planner (UDP) bağlantısı') }, tr('Bekleniyor')) : null;
  const mpBody = mp ? h('div', { class: 'fs-pn-mp' },
    h('div', { class: 'fs-pn-mp-adres' }, h('code', { class: 'fs-pn-mp-kod' }, `UDP ${mp.addr}`),
      h('button', { class: 'fs-pn-btn', type: 'button', onclick: e => { e.stopPropagation(); mp.copy?.(mp.addr); } }, 'Kopyala')),
    mp.qgc   // §45 PX4 yığını (yalnız HEPGO): QGroundControl önerilir; Mission Planner da aynı porta bağlanır
      ? h('div', { class: 'fs-pn-not fs-pn-mp-not' }, 'PX4 · QGroundControl önerilir: Application Settings › Comm Links › Add › UDP › sunucu ', h('b', null, mp.addr), '. Mission Planner da UDP port ', h('b', null, String(mp.port || '—')), ' ile bağlanır.')
      : h('div', { class: 'fs-pn-not fs-pn-mp-not' }, 'Mission Planner › sağ üst bağlantı türü UDP › CONNECT › port ', h('b', null, String(mp.port || '—')), '. USB kumanda: Mission Planner › Joystick.')) : null;
  const mpYuvaBas = mp ? h('span', { class: 'fs-pn-mp-yuva' }) : null;   // rozet yuvası (bölüm başlığı)
  const mpBolum = mp ? bolum('mp', mp.qgc ? 'QGROUNDCONTROL / MP' : 'MISSION PLANNER', mpBody, { cls: 'fs-pn-mp-bolum', extra: mpYuvaBas }) : null;   // büyük harf elle: CSS uppercase tr'de "MİSSİON" yapar
  const mpYuvaYuzen = mp ? h('span', { class: 'fs-pn-mp-yuva' }) : null;   // rozet yuvası (yüzen kutu başlığı)
  const mpYuzen = mp ? h('div', { class: 'fs-mp fs-pn-yuzen', hidden: true, title: tr('Mission Planner (UDP) bağlantısı') }, h('div', { class: 'fs-pn-yuzen-bas' }, h('b', null, mp.qgc ? 'QGROUNDCONTROL / MP' : 'MISSION PLANNER'), mpYuvaYuzen)) : null;
  // Otomatik katlama: kullanıcı tercihi yoksa (fold.mp tanımsız) GCS bağlıyken katlı, değilken açık
  const applyMpFold = () => { if (mpBolum) mpBolum.classList.toggle('folded', fold.mp == null ? gcs : !!fold.mp); };
  const placeMp = () => {
    if (!mp) return;
    const panelde = on && !stage.classList.contains('fs-fpv');
    (panelde ? mpYuvaBas : mpYuvaYuzen).append(mpRozet);
    (panelde ? mpBolum : mpYuzen).append(mpBody);
    mpYuzen.hidden = panelde;
  };

  // --- HABERLEŞME konsolu (.dk-konsol: kart altında, katlanır; sayaç + temizle) ---
  const conBody = h('div', { class: 'fs-pn-kon-govde' });
  const conCount = h('span', { class: 'fs-pn-kon-sayac' }, '0');
  const conBolum = bolum('con', 'Haberleşme', conBody, { cls: 'fs-pn-kon', extra: h('span', { class: 'fs-pn-kon-araclar' }, conCount,
    h('button', { class: 'fs-pn-kon-btn', type: 'button', title: tr('Konsolu temizle'), onclick: e => { e.stopPropagation(); conBody.replaceChildren(); conCount.textContent = '0'; } }, '⌫')) });
  conBolum.querySelector('.fs-pn-bas-ad').before(ico('chat', 'fs-pn-kon-ikon'));   // GÖKTUNGU sırası: ok · ikon · ad · sayaç · araçlar

  const govde = h('div', { class: 'fs-pn-govde' }, ustSatir, pfdBolum, tilesBolum, hub ? opsBolum : null, mpBolum, conBolum);
  const kart = h('div', { class: 'fs-pn-kart' }, baslik, govde);
  const root = h('div', { class: 'fs-pn' }, kart);
  root.id = 'fs-pn';
  stage.append(root);
  if (mpYuzen) stage.append(mpYuzen);   // .fs-pn panel kapalıyken display:none → yüzen MP kutusu sahnede ayrı durur (koyu, --gt-* değişkenleri kendi kuralında)
  applyMpFold();
  stage.classList.add('fs-ops-host');
  if (!hub) { stage.classList.add('fs-pn-nohub'); for (const k of ['arm', 'mode', 'cmd']) T[k].classList.add('off'); hazirBtn.classList.add('off'); }
  if (lsGet(KEY_MIN)) setMin(true);

  // ---------- konsol satırları (.dk-kons-satir: ts · etiket · metin) ----------
  const log = (text, sev = 'bilgi', tag = 'SİM', ts = null) => {
    if (disposed || !text) return;
    const d = ts ? new Date(ts * 1000) : new Date();
    const stamp = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
    const cls = SEV_CLASS[sev] ?? (/err|crit|alert|emerg/.test(String(sev)) || (typeof sev === 'number' && sev <= 3) ? 'err' : /warn/.test(String(sev)) || sev === 4 ? 'warn' : '');
    const atBottom = conBody.scrollTop + conBody.clientHeight >= conBody.scrollHeight - 6;
    conBody.append(h('div', { class: `fs-pn-line ${cls}` }, h('span', { class: 't' }, stamp), h('span', { class: 'tag' }, tag), h('span', { class: 'x' }, text)));
    while (conBody.children.length > 200) conBody.firstChild.remove();
    conCount.textContent = String(conBody.children.length);
    if (atBottom) conBody.scrollTop = conBody.scrollHeight;
  };

  // ---------- hub soketi (/ws/drone/live, watch sim_id) ----------
  const hubSend = obj => { if (hubWs && hubWs.readyState === 1) hubWs.send(JSON.stringify(obj)); };
  const setHubBadge = (tone, text, title) => { B.hub.className = `fs-pn-rozet ${tone}`; B.hub.textContent = text; if (title) B.hub.title = title; };
  const openHub = () => {
    if (hubClosed || disposed) return;
    const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws/drone/live`;
    try { hubWs = new WebSocket(url); } catch (err) { setHubBadge('kotu', 'HUB', err.message); return; }
    setHubBadge('baglaniyor', 'HUB…', tr('Harekât hub bağlantısı kuruluyor'));
    hubWs.onopen = () => { hubRetry = 0; hubSend({ t: 'watch', sim_id: Number(sid) }); hubPing = setInterval(() => hubSend({ t: 'ping' }), 10000); };
    hubWs.onmessage = e => { let m; try { m = JSON.parse(e.data); } catch { return; } onHub(m); };
    hubWs.onclose = ev => {
      clearInterval(hubPing); hubOnline = false; applyPerm();
      for (const [rid, p] of pending) { clearTimeout(p.timer); p.resolve({ ok: false, error: tr('Hub bağlantısı kapandı') }); pending.delete(rid); }
      if (hubClosed || disposed) return;
      setHubBadge(ev.code === 4403 ? 'kotu' : 'baglaniyor', 'HUB', ev.code === 4403 ? tr('Harekât hub yetkisi yok') : tr('Hub bağlantısı koptu; yeniden deneniyor'));
      if (ev.code === 4403) return;
      hubTimer = setTimeout(openHub, Math.min(10000, 500 * 2 ** Math.min(hubRetry++, 5)));
    };
    hubWs.onerror = () => { /* onclose yeniden bağlanır */ };
  };
  const onHub = m => {
    if (m.t === 'hello') {
      const b = (m.bridges || []).find(x => x.bridge_id === bridgeId || x.sim_id === Number(sid));
      hubOnline = !!b;
      hubCan = m.me ? m.me.can_command !== false : null;
      if (b?.drones) { const d0 = b.drones['1'] || Object.values(b.drones)[0]; if (d0) hubState = { ...hubState, ...d0 }; }
      setHubBadge(hubOnline ? 'bagli' : 'baglaniyor', 'HUB', hubOnline ? tr('Harekât hub bağlı · köprü {id}', { id: b.bridge_id }) : tr('Oturum köprüsü hub\'da yok'));
      applyPerm(); return;
    }
    if (m.t === 'status') { if (m.bridge_id === bridgeId) { hubState = m.state || hubState; drawTiles(); } return; }
    if (m.t === 'console') { if (m.bridge_id !== bridgeId || m.tag === 'STATUS') return; log(m.repeat > 1 ? `${m.text} ×${m.repeat}` : m.text, m.sev, m.tag, m.ts); return; }   // STATUSTEXT satırları sim WS 'event' olarak zaten gelir (tekrar yok)
    if (m.t === 'bridge') { if (m.bridge_id === bridgeId) { hubOnline = !!m.online; setHubBadge(hubOnline ? 'bagli' : 'kotu', 'HUB', hubOnline ? tr('Harekât hub bağlı') : tr('Oturum köprüsü çevrimdışı')); applyPerm(); } return; }
    if (m.t === 'res') { const p = pending.get(m.rid); if (p) { clearTimeout(p.timer); pending.delete(m.rid); p.resolve(m); } return; }
    if (m.t === 'error') { log(m.error || 'hata', 'hata', 'HUB'); }
  };
  // Komut: hub cmd{rid, bridge_id, sysid, name, params} → res; zaman aşımı hepgo_ws.js ile aynı (bileşik komutlar uzun)
  const hubCmd = (name, params = {}, { quiet = false } = {}) => new Promise(resolve => {
    if (!canCmd()) { toast(canWrite ? tr('Komut için hub bağlantısı ve yetki gerekir') : tr('Komut için Uçuş Simülatörü yazma izni gerekir'), 'err'); return resolve({ ok: false, error: 'yetki' }); }
    const rid = `p${++ridSeq}-${Date.now().toString(36)}`;
    const sn = /^(mission_upload|mission_download|mission_start)$/.test(name) ? 65 : /^mission_(pause|resume|cancel|resume_at)$|^altitude_change$/.test(name) ? 35 : 12;
    const timer = setTimeout(() => { pending.delete(rid); resolve({ ok: false, error: tr('yanıt alınamadı ({n} sn zaman aşımı)', { n: sn }) }); }, sn * 1000);
    pending.set(rid, { resolve, timer, name });
    hubSend({ t: 'cmd', rid, bridge_id: bridgeId, sysid: 1, name, params });
  }).then(r => {
    if (!r.ok && r.error !== 'yetki') { log(`${name}: ${r.error}`, 'hata', 'KOMUT'); if (!quiet) toast(`${name}: ${r.error}`, 'err'); }
    return r;
  });

  // ---------- komut diyalogları (ui.js modal → body; tam ekranda görünür: flightsim.js documentElement.requestFullscreen) ----------
  const armToggle = async () => {
    if (!canCmd()) return hubCmd('arm');
    if (tele?.armed) { if (await confirmDialog('DISARM', tr(rover ? 'Motorlar durdurulsun mu? Araç durur.' : 'Motorlar durdurulsun mu? Havadaysa dron düşer.'), { okLabel: 'DISARM', danger: true })) hubCmd('disarm'); return; }
    const force = h('input', { type: 'checkbox' });
    modal({ title: 'ARM', body: h('div', null, h('p', null, tr(rover ? 'Motorlar ARM edilsin mi? Aracın çevresi boş olmalı.' : 'Motorlar ARM edilsin mi? Pervanelerin çevresi boş olmalı.')), h('label', { class: 'check' }, force, ' ', tr('Zorla (pre-arm denetimlerini atla)'))),
      actions: [{ label: 'Vazgeç' }, { label: 'ARM', class: 'danger', onClick: () => { hubCmd('arm', force.checked ? { force: true } : {}); } }] });
  };
  let menuEl = null;
  // Mod menüsü (stil.css .dk-mod-popup: 3 sütun .dk-mod-btn) panel KÖKÜNE eklenir (karonun içine değil): kart overflow:auto olduğundan karo
  // içindeki absolute menü kartın kaydırma yüksekliğini büyütür, kapanınca içerik kayar; tıklama karoya kabarmasın (yeniden açılır)
  const closeMenu = () => { menuEl?.remove(); menuEl = null; document.removeEventListener('pointerdown', onDocDown, true); };
  const onDocDown = e => { if (menuEl && !menuEl.contains(e.target)) closeMenu(); };
  const modeMenu = anchor => {
    if (menuEl) return closeMenu();
    const r = anchor.getBoundingClientRect(), s = stage.getBoundingClientRect(), w = 232;
    menuEl = h('div', { class: 'fs-pn-menu', style: { left: `${Math.round(clamp(r.left - s.left, 4, s.width - w - 4))}px`, top: `${Math.round(r.bottom - s.top + 4)}px` }, onclick: e => e.stopPropagation() },
      h('div', { class: 'fs-pn-menu-bas' }, tr('Uçuş modu seç')),
      h('div', { class: 'fs-pn-mod-izgara' }, modes.map(m => h('button', { type: 'button', class: `fs-pn-mod-btn ${tele?.mode === m ? 'aktif' : ''}`, onclick: e => { e.stopPropagation(); closeMenu(); if (tele?.mode !== m) hubCmd('set_mode', { mode: m }); } }, m))));
    root.append(menuEl);
    document.addEventListener('pointerdown', onDocDown, true);
  };
  const takeoffDialog = () => {
    if (!canCmd()) { hubCmd('takeoff'); return; }
    const alt = h('input', { class: 'input', type: 'number', min: 1, max: 500, value: Number(altInp.value) || (isPlane ? 80 : 30) });
    const boxes = CHECKLIST.map(([k, q]) => ({ k, q, cb: h('input', { type: 'checkbox' }) }));
    const label = LAUNCH_BTN[launch?.method] || 'Kalkış';
    const hint = launch?.method === 'ramp' ? tr('Uçak TAKEOFF moduna alınır ve ARM edilir; 1 sn sonra pnömatik rampa kızağı {a}° açıyla fırlatır (SITL mancınık tetiği).', { a: Math.round(launch.angle_deg) })
      : launch?.method === 'vehicle' ? tr('Uçak TAKEOFF moduna alınır ve ARM edilir; pickup pist boyunca hızlanır, {k} km/h yer hızında uçak bırakılır.', { k: Math.round(launch.release_kmh) })
      : launch?.method === 'handheld' ? tr('El fırlatıcısı: GUIDED + ARM; interceptor tüpten çıkar ve nişan doğrultusuna yönelir (Nişangâh penceresindeki nişan).')
      : ['pod4', 'pod8', 'tube'].includes(launch?.method) ? tr('Fırlatıcı: GUIDED + ARM; kapak açılır, interceptor kuyruk üstünden dikey çıkar (NAV_TAKEOFF).')
      : isPlane ? tr('ArduPlane yöntemi: TKOFF_ALT = hedef, TAKEOFF modu, ARM; uçak pist boyunca hızlanır.') : tr('GÖKTUNGU akışı: GUIDED → ARM → NAV_TAKEOFF; dron hedef irtifaya yükselir.');
    const all = h('button', { class: 'btn sm', type: 'button', onclick: () => boxes.forEach(b => { b.cb.checked = true; }) }, 'Hepsini onayla');
    modal({ title: label, body: h('div', null, field('Hedef irtifa (m, AGL)', alt, hint),
      h('div', { class: 'fs-pn-check' }, h('div', { class: 'small muted' }, tr('Kalkış kontrol listesi (zorunlu maddeler; sunucuda kayıt altına alınır)')), boxes.map(b => h('label', { class: 'check' }, b.cb, ' ', b.q)), all)),
      actions: [{ label: 'Vazgeç' }, { label, class: 'primary', onClick: () => {
        const eksik = boxes.filter(b => !b.cb.checked).length;
        if (eksik) { toast(tr('{n} zorunlu madde onaylanmadı', { n: eksik }), 'err'); return true; }
        const a = clamp(Number(alt.value) || 30, 1, 500); altInp.value = a;
        const kontrol = boxes.map((b, i) => ({ sira: i, anahtar: b.k, soru: b.q, grup: 'sim', cevap: true, zorunlu: true, kaynak: 'flightsim_panel' }));
        if (launch && cmdSim) { log(tr('Kalkış kontrol listesi onaylandı ({n} madde) · {l} {a} m', { n: kontrol.length, l: label, a }), 'bilgi', 'KOMUT'); cmdSim('takeoff', { alt: a }); }   // §13 fırlatma düzeneği sim yolundan
        else hubCmd('takeoff', { alt_rel_m: a, kontrol });
      } }] });
  };
  const land = () => hubCmd('land');
  const setHome = async () => { if (await confirmDialog('Ev konumu', tr('Ev (HOME) konumu dronun şu anki konumuna ayarlansın mı?'), { okLabel: 'Ayarla' })) hubCmd('set_home', {}); };
  const gotoDialog = () => {
    if (!canCmd()) { hubCmd('goto'); return; }
    const lat = h('input', { class: 'input mono', value: tele?.lat != null ? Number(tele.lat).toFixed(6) : '' }), lon = h('input', { class: 'input mono', value: tele?.lon != null ? Number(tele.lon).toFixed(6) : '' });
    const alt = h('input', { class: 'input', type: 'number', min: 1, max: 500, value: Math.max(5, Math.round(num(tele?.alt_rel, 0)) || Number(altInp.value) || 30) });
    modal({ title: 'Hedefe git', body: h('div', null, field('Enlem', lat), field('Boylam', lon), rover ? h('p', { class: 'small muted' }, tr('GUIDED modda araç belirtilen konuma sürer.')) : field('İrtifa (m, AGL)', alt, tr('GUIDED modda belirtilen konuma gider (sabit kanatta GUIDED hedef noktası).'))),
      actions: [{ label: 'Vazgeç' }, { label: 'Git', class: 'primary', onClick: () => { const la = Number(lat.value), lo = Number(lon.value); if (!Number.isFinite(la) || !Number.isFinite(lo)) { toast(tr('Geçersiz koordinat'), 'err'); return true; } hubCmd('goto', { lat: la, lon: lo, alt_rel_m: rover ? 0 : (Number(alt.value) || 30) }); } }] });
  };

  // ---------- rotalar (Dron Yönetimi › Rotalar) ----------
  let routes = [];
  const routeName = () => routes.find(r => String(r.id) === routeSel.value)?.name || '';
  const loadRoutes = async () => {
    if (!hub) return;
    try { routes = await api.get('/api/drone/routes'); } catch { routes = []; }
    const cid = session.center?.id;
    routes = routes.filter(r => r.active !== 0 && r.active !== false).sort((a, b) => (a.center_id === cid ? -1 : 0) - (b.center_id === cid ? -1 : 0));
    routeSel.replaceChildren(h('option', { value: '' }, routes.length ? tr('Rota seçin…') : tr('Kayıtlı rota yok')), ...routes.map(r => h('option', { value: r.id }, `${r.name}${r.wp_count != null ? ` · ${r.wp_count} ${tr('nokta')}` : ''}${r.center_name && r.center_id !== cid ? ` (${r.center_name})` : ''}`)));
    if (!routeSel.value && routes.length && routes[0].center_id === cid) routeSel.value = String(routes[0].id);
  };
  const routeUpload = async () => {
    const rid = routeSel.value;
    if (!rid) { toast(tr('Önce bir rota seçin'), 'err'); return; }
    if (!canCmd()) { hubCmd('mission_upload'); return; }
    let ms;
    try { ms = await api.get(`/api/drone/routes/${encodeURIComponent(rid)}/mission`); } catch (err) { toastError(err); return; }
    log(tr('Rota yükleniyor: {r} ({n} öğe)', { r: ms.name || routeName(), n: (ms.items || []).length }), 'bilgi', 'ROTA');
    const r = await hubCmd('mission_upload', { items: ms.items || [], cruise_speed: ms.cruise_speed });
    if (r.ok) toast(tr('Rota yüklendi: {r}', { r: ms.name || routeName() }));
  };
  const drawRoute = () => { routeInfo.textContent = routePts.length ? tr('SITL\'de {n} rota noktası', { n: routePts.length }) + (hubState.mission_seq != null && tele?.mode === 'AUTO' ? ` · WP ${hubState.mission_seq}` : '') : tr('SITL\'de görev yok'); };

  // ---------- yetki / görünürlük ----------
  const applyPerm = () => {
    const ok = canCmd();
    root.querySelectorAll('.fs-pn-ops-body button:not(.fs-pn-free), .fs-pn-ops-body select, .fs-pn-ops-body input').forEach(b => { b.disabled = !ok; });
    root.querySelectorAll('.fs-pn-ops-body .fs-pn-free').forEach(b => { b.disabled = !canWrite; });
    speedPill?.setEnabled(canWrite && state === 'HAZIR');   // §23: hız seçici sim komutudur (hub gerekmez)
    for (const k of ['arm', 'mode', 'cmd']) T[k].classList.toggle('off', !ok);
    hazirBtn.classList.toggle('off', !ok);
    const perm = root.querySelector('.fs-pn-perm');
    if (perm) perm.textContent = ok ? '' : !canWrite ? tr('Komutlar için yazma izni gerekir') : !hubOnline ? tr('Hub bağlantısı bekleniyor') : hubCan === false ? tr('Hub komut yetkisi yok') : state !== 'HAZIR' ? tr('Oturum hazır değil') : '';
  };

  // ---------- veri güncelleme ----------
  let pfdDirty = false, raf = 0, tilesAt = 0, lastMode = null;
  const update = t => {
    if (disposed || !t) return;
    tele = t; pfdDirty = true;
    if (!raf && on && !stage.classList.contains('fs-fpv')) raf = requestAnimationFrame(frame);
    const now = performance.now();
    if (now - tilesAt > 100) { tilesAt = now; drawTiles(); }
  };
  const STATE_TONE = { BASLIYOR: 'baglaniyor', HAZIR: 'bagli', HATA: 'kotu', KAPANDI: 'yok' };
  const drawHazir = () => {   // UÇUŞA HAZIR rozeti (stil.css .dk-hazir-rozet.hazir / .ucusta / .hazir-degil / .bilinmiyor)
    const armed = !!tele?.armed;
    let cls = 'bilinmiyor', txt = '—';
    if (!hub) { cls = 'bilinmiyor'; txt = tr(session.mode === 'replay' ? 'KAYITTAN OYNATMA' : 'SAHTE VERİ'); }
    else if (state === 'HATA') { cls = 'hazir-degil'; txt = tr('SITL HATASI'); }
    else if (state === 'KAPANDI') { cls = 'bilinmiyor'; txt = tr('OTURUM KAPANDI'); }
    else if (state !== 'HAZIR') { cls = 'bilinmiyor'; txt = tr('SITL BAŞLIYOR…'); }
    else if (armed) { cls = 'ucusta'; txt = `ARMED · ${tr(rover ? 'SÜRÜŞTE' : 'UÇUŞTA')}`; }
    else if (hubState.prearm?.length) { cls = 'hazir-uyari'; txt = `DISARMED · ${tr('PREARM UYARISI')}`; }
    else { cls = 'hazir'; txt = `DISARMED · ${tr(rover ? 'SÜRÜŞE HAZIR' : 'UÇUŞA HAZIR')}`; }
    hazirBtn.className = `fs-pn-hazir ${cls} ${hazirBtn.classList.contains('off') ? 'off' : ''}`; hazirMetin.textContent = txt;
    B.nokta.className = `fs-pn-nokta ${hub ? (STATE_TONE[state] || 'yok') : 'sanal'}`;
  };
  const drawTiles = () => {
    const t = tele || {};
    const armed = !!t.armed, mode = t.mode || hubState.mode || '—';
    B.irt.textContent = rover ? (t.groundspeed != null ? `${f0(Number(t.groundspeed) * 3.6)} km/h` : '') : t.alt_rel != null ? `${f0(t.alt_rel)} m` : ''; B.kip.textContent = mode === '—' ? '' : mode;
    B.arm.textContent = armed ? 'ARMED' : 'DISARMED'; B.arm.className = `fs-pn-rozet ${armed ? 'kotu' : 'yok'}`;
    if (rover) { const ps = getSim()?.getPose?.() || t; T.alt.v.textContent = `${f1(num(ps.pitch, 0) / DEG)}°`; T.alt.sub.textContent = `${tr('Yatış')} ${f1(num(ps.roll, 0) / DEG)}°`; }   // 3B zemine oturmuş gövde (PFD ile aynı)   // §31 eğim (burun yukarı +) / yatış
    else { T.alt.v.textContent = `${f1(t.alt_rel)} m`; T.alt.sub.textContent = `MSL ${f0(t.alt_msl)} m`; }
    T.spd.v.textContent = `${f1(t.groundspeed)} m/s`; T.spd.sub.textContent = t.groundspeed != null ? `${(Number(t.groundspeed) * 3.6).toFixed(1)} km/h` : '';   // GÖKTUNGU: m/s + km/h (hava hızı PFD'de IAS)
    // §23: elektronik batarya (tele.elec) varsa BATARYA karosu ondan (%, kestirilen V, kalan süre); yoksa SITL pili
    const el_ = t.elec || null;
    const bv = el_ ? num(el_.v) : num(t.batt_v), bp = el_ ? num(el_.pct) : num(t.batt_pct);
    T.bat.v.textContent = bp != null ? `${f0(bp)}%` : '—';
    T.bat.sub.textContent = el_ ? `${bv != null ? `${bv.toFixed(1)} V` : ''}${el_.min_left != null ? ` · ${minText(el_.min_left)}` : ''}${el_.cells ? ` · ${el_.cells}S` : ''}` : (bv != null && bv > 0 ? `${bv.toFixed(2)} V` : '');
    T.bat.title = el_ ? `${tr('Elektronik batarya')} · ${elecText(el_)} · ${f1(el_.w)} W` : '';
    T.bat.classList.toggle('kotu', !!el_?.empty); T.bat.classList.toggle('warn', !el_?.empty && bp != null && bp < 25); T.bat.classList.toggle('iyi', !el_?.empty && bp != null && bp >= 25);
    const fill = T.bat.i.querySelector('.fill'); if (fill) fill.setAttribute('width', String(bp != null ? Math.max(0, Math.min(12, 12 * bp / 100)) : 0));
    const fu = t.fuel || null;   // §23 yakıt karosu
    T.fuel.hidden = !fu;
    if (fu) {
      T.fuel.v.textContent = `${num(fu.l, 0).toFixed(2)} L`; T.fuel.sub.textContent = `%${f0(fu.pct)} · ${rangeText(fu.range_km)}`;
      T.fuel.title = `${fuelText(fu)} · ${tr('menzil')} ${rangeText(fu.range_km)} · ${(num(fu.lpm, 0) * 60).toFixed(2)} L/sa`;
      T.fuel.classList.toggle('kotu', !!fu.empty); T.fuel.classList.toggle('warn', !fu.empty && num(fu.pct, 100) < 20); T.fuel.classList.toggle('iyi', !fu.empty && num(fu.pct, 0) >= 20);
    }
    if (speedPill && t.speedup != null) speedPill.set(t.speedup);
    T.gps.v.textContent = `${gpsText(t.gps_fix)} · ${f0(t.sats)}`; T.gps.sub.textContent = tr('{n} uydu', { n: f0(t.sats) }) + (gcs ? ' · MP' : '');   // MP: Mission Planner (UDP) bağlı
    T.gps.className = `fs-pn-tile ${t.gps_fix >= 3 ? 'iyi' : t.gps_fix === 2 ? 'warn' : 'kotu'}`;
    T.arm.v.textContent = armed ? 'ARMED' : 'DISARM'; T.arm.classList.toggle('iyi', armed); T.arm.sub.textContent = hubState.prearm?.length && !armed ? tr('PreArm uyarısı') : armed ? tr(rover ? 'sürüşte' : 'uçuşta') : tr('hazır');
    T.arm.i.innerHTML = armed ? ICO.unlock : ICO.lock;
    T.mode.v.textContent = mode; T.mode.sub.textContent = tr('değiştir');
    const cmdTxt = launchBtnText();
    T.cmd.v.textContent = tr(cmdTxt); T.cmd.sub.textContent = rover ? 'HOLD' : cmdTxt === 'İniş' ? 'LAND' : (launch ? tr('düzenek') : 'TAKEOFF');
    T.cmd.classList.toggle('land', cmdTxt === 'İniş' || rover); T.cmd.classList.toggle('takeoff', cmdTxt !== 'İniş' && !rover); T.cmd.i.innerHTML = rover ? ICO.pause : cmdTxt === 'İniş' ? ICO.land : ICO.takeoff;
    if (t.mode !== lastMode) { lastMode = t.mode; drawRoute(); }
    drawHazir();
  };
  // Mission Planner (UDP) durumu TEK yerden: rozet (bölüm başlığı / yüzen kutu), GPS karosu alt yazısı ("· MP"), otomatik katlama
  const setGcs = (v, addr) => {
    const was = gcs; gcs = !!v; gcsAddr = addr || '';
    if (mpRozet) { mpRozet.className = `fs-pn-rozet fs-pn-mp-rozet ${gcs ? 'bagli' : 'yok'}`; mpRozet.textContent = gcs ? tr('Bağlı ({ip})', { ip: gcsAddr }) : tr('Bekleniyor'); }
    if (was !== gcs) applyMpFold();
    drawTiles();
  };
  const frame = () => {
    raf = 0;
    if (disposed || !on) return;
    if (pfdDirty && !pfdBolum.classList.contains('folded') && !kart.classList.contains('yalniz-baslik')) { pfdDirty = false; drawPfd(); }
  };

  // ---------- PFD çizimi (GÖKTUNGU benzeri: mavi gök / kahverengi yer) ----------
  let W = 0, H = 0, dpr = 1;
  const resizePfd = () => {   // kart gizliyken (P / FPV / katlı / küçük) tuval ölçüsüzdür → çizme (negatif yarıçap hatası)
    const w = canvas.clientWidth || 0, hh = Math.round(w * 0.47);
    if (w < 40 || hh < 20) return false;
    dpr = Math.min(devicePixelRatio || 1, 2);
    if (w === W && hh === H && canvas.width === Math.round(w * dpr)) return true;
    W = w; H = hh; canvas.style.height = `${H}px`; canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr); pfdDirty = true;
    return true;
  };
  const txt = (s, x, y, { px = 11, align = 'left', base = 'middle', color = '#f1f5f9', bold = false } = {}) => {
    g.font = `${bold ? '700 ' : ''}${px}px Consolas, "Cascadia Mono", Menlo, "DejaVu Sans Mono", monospace`; g.textAlign = align; g.textBaseline = base;
    g.lineWidth = 3; g.strokeStyle = 'rgba(0,0,0,.6)'; g.lineJoin = 'round'; g.strokeText(s, x, y); g.fillStyle = color; g.fillText(s, x, y);
  };
  const line = (x1, y1, x2, y2, color = '#f1f5f9', w = 1.2) => { g.beginPath(); g.moveTo(x1, y1); g.lineTo(x2, y2); g.lineWidth = w; g.strokeStyle = color; g.stroke(); };
  function drawPfd() {
    if (!resizePfd()) { pfdDirty = true; return; }
    const t = tele || {};
    const pose = getSim()?.getPose?.() || null;
    const roll = num(pose?.roll, num(t.roll, 0)), pitch = num(pose?.pitch, num(t.pitch, 0)), pitchDeg = pitch / DEG;
    const yawRad = num(pose?.yaw, num(t.yaw, null));
    const hdg = num(t.heading, yawRad != null ? ((yawRad / DEG) + 360) % 360 : 0);
    const gs = num(t.groundspeed, 0) * (rover ? 3.6 : 1), air = num(t.airspeed, gs), agl = rover ? pitchDeg : num(t.alt_rel, 0), msl = num(t.alt_msl, null), climb = num(t.climb, t.vd != null ? -t.vd : 0);   // §31 kara aracı: sol bant km/h, sağ bant eğim (°)
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, W, H);
    const bandW = Math.round(W * 0.14), hsH = 22, cx = W / 2, cy = (H - hsH) / 2, ppd = (H - hsH) / 50;   // ±25° görünür
    const ax = bandW, aw = W - 2 * bandW, ah = H - hsH;   // ufuk alanı
    // --- suni ufuk ---
    g.save(); g.beginPath(); g.rect(ax, 0, aw, ah); g.clip();
    g.translate(cx, cy); g.rotate(roll);   // ArduPilot roll sağa pozitif → ufuk ekranda sola yükselir (flightsim_hud ile aynı yön)
    const hy = pitchDeg * ppd, R = Math.hypot(W, H);
    const sky = g.createLinearGradient(0, hy - R, 0, hy); sky.addColorStop(0, '#1d4ed8'); sky.addColorStop(1, '#60a5fa');
    g.fillStyle = sky; g.fillRect(-R, hy - R, 2 * R, R);
    const gnd = g.createLinearGradient(0, hy, 0, hy + R); gnd.addColorStop(0, '#9a6b3a'); gnd.addColorStop(1, '#4a2f14');
    g.fillStyle = gnd; g.fillRect(-R, hy, 2 * R, R);
    line(-R, hy, R, hy, '#ffffff', 1.6);
    for (let L = -90; L <= 90; L += 5) {
      if (L === 0) continue;
      const y = (pitchDeg - L) * ppd;
      if (Math.abs(y) > ah / 2 + 10) continue;
      const major = L % 10 === 0, half = major ? 34 : 16;
      line(-half, y, half, y, 'rgba(255,255,255,.9)', major ? 1.4 : 1);
      if (major) { txt(String(Math.abs(L)), -half - 6, y, { align: 'right', px: 10 }); txt(String(Math.abs(L)), half + 6, y, { align: 'left', px: 10 }); }
    }
    g.restore();
    // roll yayı + işaretçi
    const rr = ah * 0.42;
    g.save(); g.translate(cx, cy);
    g.beginPath(); g.arc(0, 0, rr, -Math.PI / 2 - 60 * DEG, -Math.PI / 2 + 60 * DEG); g.lineWidth = 1.2; g.strokeStyle = 'rgba(255,255,255,.85)'; g.stroke();
    for (const a of [-60, -45, -30, -20, -10, 0, 10, 20, 30, 45, 60]) { const ang = -Math.PI / 2 + a * DEG, len = a === 0 ? 10 : a % 30 === 0 ? 8 : 5; line(Math.cos(ang) * rr, Math.sin(ang) * rr, Math.cos(ang) * (rr + len), Math.sin(ang) * (rr + len), 'rgba(255,255,255,.85)', a === 0 ? 2 : 1); }
    const ra = -Math.PI / 2 - clamp(roll / DEG, -60, 60) * DEG;
    g.beginPath(); g.moveTo(Math.cos(ra) * (rr - 2), Math.sin(ra) * (rr - 2)); g.lineTo(Math.cos(ra - 4 * DEG) * (rr - 12), Math.sin(ra - 4 * DEG) * (rr - 12)); g.lineTo(Math.cos(ra + 4 * DEG) * (rr - 12), Math.sin(ra + 4 * DEG) * (rr - 12)); g.closePath(); g.fillStyle = '#facc15'; g.fill();
    // uçak sembolü (sabit, sarı)
    g.strokeStyle = '#facc15'; g.lineWidth = 2.5; g.beginPath(); g.moveTo(-46, 0); g.lineTo(-16, 0); g.lineTo(-16, 8); g.moveTo(46, 0); g.lineTo(16, 0); g.lineTo(16, 8); g.stroke();
    g.fillStyle = '#facc15'; g.fillRect(-2, -2, 4, 4);
    g.restore();
    // --- sol: hız bandı (yer hızı) ---
    const bTop = 8, bBot = ah - 8, bh = bBot - bTop, pps = bh / 30;   // ±15 m/s
    g.fillStyle = 'rgba(0,0,0,.35)'; g.fillRect(0, 0, bandW, ah);
    g.save(); g.beginPath(); g.rect(0, bTop, bandW, bh); g.clip();
    for (let v = Math.max(0, Math.floor((gs - 16) / 2) * 2); v <= gs + 16; v += 2) { const y = cy - (v - gs) * pps, maj = v % 10 === 0; line(bandW, y, bandW - (maj ? 10 : 5), y, 'rgba(255,255,255,.8)', 1); if (maj) txt(String(v), bandW - 13, y, { align: 'right', px: 10 }); }
    g.restore();
    g.fillStyle = 'rgba(0,0,0,.8)'; g.fillRect(2, cy - 12, bandW - 6, 24); g.strokeStyle = '#f1f5f9'; g.lineWidth = 1; g.strokeRect(2.5, cy - 11.5, bandW - 6, 23);
    txt(gs.toFixed(gs < 10 ? 1 : 0), bandW - 8, cy, { align: 'right', px: 15, bold: true });
    txt(rover ? 'km/h' : 'GS m/s', 4, 9, { px: 9, color: '#cbd5e1' });
    if (!rover) txt(`IAS ${air.toFixed(air < 10 ? 1 : 0)}`, 4, ah - 9, { px: 9.5, color: '#cbd5e1' });
    // --- sağ: irtifa bandı (AGL) + dikey hız ---
    const rx = W - bandW, ppm = bh / 60;   // ±30 m
    g.fillStyle = 'rgba(0,0,0,.35)'; g.fillRect(rx, 0, bandW, ah);
    g.save(); g.beginPath(); g.rect(rx, bTop, bandW, bh); g.clip();
    for (let v = Math.floor((agl - 32) / 5) * 5; v <= agl + 32; v += 5) { const y = cy - (v - agl) * ppm, maj = v % 10 === 0; line(rx, y, rx + (maj ? 10 : 5), y, 'rgba(255,255,255,.8)', 1); if (maj) txt(String(v), rx + 13, y, { align: 'left', px: 10 }); }
    g.restore();
    g.fillStyle = 'rgba(0,0,0,.8)'; g.fillRect(rx + 4, cy - 12, bandW - 6, 24); g.strokeStyle = '#f1f5f9'; g.strokeRect(rx + 3.5, cy - 11.5, bandW - 6, 23);
    txt(agl.toFixed(agl < 10 ? 1 : 0), rx + 8, cy, { align: 'left', px: 15, bold: true });
    txt(rover ? `${tr('Eğim')} °` : 'AGL m', W - 4, 9, { align: 'right', px: 9, color: '#cbd5e1' });
    txt(msl != null ? `MSL ${msl.toFixed(0)}` : '', W - 4, ah - 9, { align: 'right', px: 9.5, color: '#cbd5e1' });
    if (!rover) txt(`VS ${climb > 0.05 ? '+' : ''}${climb.toFixed(1)}`, rx - 6, ah - 24, { align: 'right', px: 9.5, color: climb < -3 ? '#fbbf24' : '#cbd5e1' });   // dikey hız: ufuk alanı sağ alt, BAT'ın üstü (bant tick etiketleriyle çakışmaz)
    // --- alt: yön şeridi ---
    const hsY = ah, hpd = aw / 90;   // ±45°
    g.fillStyle = 'rgba(0,0,0,.6)'; g.fillRect(0, hsY, W, hsH);
    g.save(); g.beginPath(); g.rect(ax, hsY, aw, hsH); g.clip();
    for (let d = Math.floor((hdg - 50) / 5) * 5; d <= hdg + 50; d += 5) {
      const x = cx + wrap180(d - hdg) * hpd, maj = d % 10 === 0;
      line(x, hsY, x, hsY + (maj ? 7 : 4), 'rgba(255,255,255,.85)', 1);
      if (d % 30 === 0) { const n = ((d % 360) + 360) % 360; txt(CARD[n] || String(n / 10).padStart(2, '0'), x, hsY + 15, { align: 'center', px: 10, bold: !!CARD[n] }); }
    }
    // ev yönü
    if (t.home && t.home.lat != null && t.lat != null) {
      const dLat = (t.home.lat - t.lat) * 110574, dLon = (t.home.lon - t.lon) * 111320 * Math.cos(t.lat * DEG);
      const brg = (Math.atan2(dLon, dLat) / DEG + 360) % 360, rel = wrap180(brg - hdg), hx = cx + clamp(rel, -44, 44) * hpd;
      g.beginPath(); g.moveTo(hx, hsY + 3); g.lineTo(hx - 5, hsY + hsH - 3); g.lineTo(hx + 5, hsY + hsH - 3); g.closePath(); g.fillStyle = Math.abs(rel) > 44 ? 'rgba(74,222,128,.35)' : '#4ade80'; g.fill();
    }
    g.restore();
    g.beginPath(); g.moveTo(cx, hsY); g.lineTo(cx - 5, hsY + 8); g.lineTo(cx + 5, hsY + 8); g.closePath(); g.fillStyle = '#facc15'; g.fill();
    g.fillStyle = 'rgba(0,0,0,.85)'; g.fillRect(cx - 20, hsY + 2, 40, hsH - 4); txt(pad3(hdg), cx, hsY + hsH / 2, { align: 'center', px: 11, bold: true });
    // --- köşe etiketleri: mod / ARM / GPS / batarya ---
    txt(t.mode || '—', ax + 6, 10, { px: 11, bold: true, color: '#e2e8f0' });
    txt(t.armed ? 'ARMED' : 'DISARMED', rx - 6, 10, { align: 'right', px: 11, bold: true, color: t.armed ? '#f87171' : '#cbd5e1' });
    txt(`GPS ${gpsText(t.gps_fix)} ${t.sats != null ? t.sats + ' SAT' : ''}`, ax + 6, ah - 10, { px: 9.5, color: '#e2e8f0' });
    const bp = num(t.batt_pct);
    txt(`BAT ${t.batt_v != null && Number(t.batt_v) > 0 ? Number(t.batt_v).toFixed(1) + 'V ' : ''}${bp != null ? bp.toFixed(0) + '%' : '—'}`, rx - 6, ah - 10, { align: 'right', px: 9.5, color: bp != null && bp < 25 ? '#f87171' : '#e2e8f0' });
    if (t.mode === 'AUTO' && hubState.mission_count) txt(`WP ${hubState.mission_seq ?? '—'}/${hubState.mission_count}${hubState.wp_dist != null ? ` · ${Math.round(hubState.wp_dist)} m` : ''}`, cx, 10, { align: 'center', px: 10, color: '#fde68a' });
  }

  // ---------- sürükleme (kart başlığından; stil.css .dron-kart.ayrik .dron-kart-baslik cursor:grab) + yerleşim ----------
  let d = null;
  baslik.addEventListener('pointerdown', e => {
    if (e.button !== 0 || e.target.closest('button, input, select')) return;
    const r = kart.getBoundingClientRect(), s = stage.getBoundingClientRect();
    d = { id: e.pointerId, dx: e.clientX - r.left, dy: e.clientY - r.top, s, w: r.width };
    baslik.setPointerCapture(e.pointerId); kart.classList.add('dragging'); e.preventDefault();
  });
  baslik.addEventListener('pointermove', e => {
    if (!d || e.pointerId !== d.id) return;
    placeKart(clamp(e.clientX - d.dx - d.s.left, 0, Math.max(0, d.s.width - d.w)), clamp(e.clientY - d.dy - d.s.top, 0, Math.max(0, d.s.height - 40)));
  });
  const dragUp = e => { if (!d || e.pointerId !== d.id) return; d = null; kart.classList.remove('dragging'); const r = kart.getBoundingClientRect(), s = stage.getBoundingClientRect(); lsSet(KEY_COL, { x: Math.round(r.left - s.left), y: Math.round(r.top - s.top), r: Math.round(s.right - r.right), w: Math.round(s.width) }); };
  baslik.addEventListener('pointerup', dragUp); baslik.addEventListener('pointercancel', dragUp);
  const placeKart = (x, y) => { kart.classList.add('free'); kart.style.left = `${x}px`; kart.style.top = `${y}px`; kart.style.right = 'auto'; };
  const applyLayout = () => {
    const s = stage.getBoundingClientRect();
    const c = lsGet(KEY_COL); if (c && typeof c.r === 'number') { const w = kart.offsetWidth || 400; placeKart(clamp(s.width - c.r - w, 0, Math.max(0, s.width - w)), clamp(c.y, 0, Math.max(0, s.height - 60))); }
  };
  const resetLayout = () => {
    lsSet(KEY_COL, null); lsSet(KEY_FOLD, null); lsSet(KEY_MIN, null);
    kart.classList.remove('free'); kart.style.cssText = '';
    for (const k of Object.keys(fold)) delete fold[k];
    fold.ops = true;
    root.querySelectorAll('.fs-pn-bolum.folded').forEach(e => e.classList.remove('folded'));
    opsBolum.classList.add('folded'); islemBtn.classList.remove('acik');
    applyMpFold();   // MP katlama tercihi silindi → otomatik (GCS bağlıysa katlı)
    setMin(false);
    pfdDirty = true; if (!raf) raf = requestAnimationFrame(frame);
    toast(tr('Yerleşim sıfırlandı'));
  };
  // alt çubuk sarınca yükselir: kapsayıcının alt sınırı (--fs-bar-h) çubuğun üstünde kalır
  const bar = stage.querySelector('.fs-bar');
  const onResize = () => { if (bar) stage.style.setProperty('--fs-bar-h', `${bar.offsetHeight || 54}px`); if (kart.classList.contains('free')) applyLayout(); resizePfd(); pfdDirty = true; if (!raf && on) raf = requestAnimationFrame(frame); };
  const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(onResize) : null;
  ro?.observe(stage); if (bar) ro?.observe(bar);

  // ---------- göster/gizle (Panel düğmesi, P) ----------
  const apply = () => { stage.classList.toggle('fs-ops', on); if (on) { pfdDirty = true; if (!raf) raf = requestAnimationFrame(frame); } else closeMenu(); placeMp(); };
  const onKey = e => {
    if (e.ctrlKey || e.metaKey || e.altKey || editable(document.activeElement)) return;
    if (e.key === 'p' || e.key === 'P') { apiObj.toggle(); e.preventDefault(); }
  };
  window.addEventListener('keydown', onKey);
  apply();
  applyLayout();
  applyPerm();
  setGcs(gcs, gcsAddr); drawRoute();
  requestAnimationFrame(() => { resizePfd(); pfdDirty = true; if (on) frame(); });
  if (hub) { openHub(); loadRoutes(); }

  const apiObj = {
    el: root,
    get enabled() { return on; },
    toggle(v) { on = v == null ? !on : !!v; try { localStorage.setItem(KEY_ON, on ? '1' : '0'); } catch { /* */ } apply(); onToggle?.(on); return on; },
    setFpv(v) { stage.classList.toggle('fs-fpv', !!v); if (v) closeMenu(); else { pfdDirty = true; if (on && !raf) raf = requestAnimationFrame(frame); } placeMp(); },
    update,
    setState(st) { state = st; drawHazir(); applyPerm(); },
    setRoute(points) { routePts = points || []; drawRoute(); },
    setGcs,
    setLaunchPhase(ph) { if (launch) { launch.phase = ph; drawTiles(); } },
    log,
    hubCmd,
    dispose() {
      disposed = true; hubClosed = true;
      clearTimeout(hubTimer); clearInterval(hubPing); try { hubWs?.close(); } catch { /* */ }
      for (const p of pending.values()) clearTimeout(p.timer); pending.clear();
      if (raf) cancelAnimationFrame(raf);
      ro?.disconnect(); closeMenu();
      window.removeEventListener('keydown', onKey);
      root.remove(); mpYuzen?.remove(); stage.classList.remove('fs-ops', 'fs-ops-host', 'fs-fpv', 'fs-pn-nohub');
    },
  };
  return apiObj;
}
