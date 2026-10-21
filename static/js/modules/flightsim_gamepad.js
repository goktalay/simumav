// Uçuş Simülatörü — FİZİKSEL KUMANDA (Gamepad API; docs/ucus-simulatoru.md §37; HEPGO + SIMUMAV ortak). Tarayıcıya takılan oyun kumandası ya da
// USB joystick kipindeki RC verici (EdgeTX / OpenTX / Radiomaster …) navigator.getGamepads() ile okunur ve SANAL KUMANDANIN RC yoluna beslenir
// (virtualRC `pad` girdisi: aynı 20 Hz {t:'rc', ch} gönderimi, aynı §27.1 hassasiyet eğrisi, aynı Mode 2 eşlemesi — sol çubuk gaz / sapma, sağ çubuk
// yunuslama / yatış; kara aracında sol dikey gaz + sağ yatay direksiyon → roverRcChannels). Eksen/düğme ataması, ölü bölge, ters çevirme ve
// KUMANDA GİRDİSİ HASSASİYETİ küçük bir panelden (alt bantta kumanda simgesi; tercih localStorage fs.pad.cfg, profil başına: 'standard' = W3C standart
// eşleme, 'rc' = diğer / RC verici).
// Hassasiyet iki katmandır (çakışmaz, açıkça ayrı etiketli): (1) BU PANEL — yalnız fiziksel kumandanın kollarına, eksen değeri sanal kumandaya
// yazılmadan ÖNCE: ölü bölge → expo (y = (1−e)·x + e·x³, %0–80) → eksen ölçeği (%25–150) × genel ölçek (%25–150; gaz hariç) → ±1 kırpma;
// (2) ⚙ Hassasiyet (§27.1, fs.rc.feel) — sanal çubuk, klavye ve kumanda için ORTAK çıkış eğrisi (kanal PWM'ine). Varsayılan %100 / expo 0 = kimlik
// (eski fs.pad.cfg aynen çalışır). Gaz: uçakta RC verici gazı mutlak ve tek yönlüdür (−1 = rölanti) → eğri rölanti…tam aralığında uygulanır (thrAbs;
// rölanti hep ulaşılır); standart gamepadte uçak gazı yaylı koldan HIZ olarak (virtualRC) — eğri hıza uygulanır; kopter / kara aracında merkez = askı / dur.
// Öncelik: kumanda kolları nötr dışındaysa (ya da son 1,5 sn'de oynatıldıysa) fiziksel kumanda yazar; dokunulan sanal çubuk o tarafta önceliklidir;
// kumanda nötr ve hareketsizken klavye / sanal çubuk çalışır ("son kullanılan kazanır").
// Panel açıkken requestAnimationFrame döngüsü (kapalıyken çalışmaz): basılı düğmenin satırı + rozeti parlar, oynatılan eksenin satırı hafifçe parlar ve
// canlı çubuk / eğri noktası gösterilir; "Algıla" ile atama kipinde basılan düğme / uca itilen eksen anında atanır (atama sırasında eylem tetiklenmez).
// Saf katman (node testi tests/test_flightsim_gamepad.mjs): PAD_AXES, PAD_ACTIONS, DEFAULT_PAD, PAD_SENS_LIMITS, padProfile, deadzone, padCurve,
//   shapePadAxes, padThrAbs, normPadCfg, loadPadCfg, savePadCfg, readPadRaw, readPadAxes, padButtonEdges, padActionsFor, padIsNeutral, padLearnAxis,
//   PAD_TEXTS, makePadT.
// createGamepadCtl({ tr, keyed, vehicle ('copter'|'plane'|'rover'), feelShape(axis, v), storage, win, nav, onConnect(info), onDisconnect(info),
//   onAction(name), onChange() }) → { el, state(), connected, info, openPanel(), closePanel(), dispose() }
//   (state(): {active, axes:{thr,yaw,pitch,roll} (eğrili), raw (yalnız ölü bölge + ters), thrAbs, profile} ya da null)

export const PAD_AXES = ['thr', 'yaw', 'pitch', 'roll'];
export const PAD_ACTIONS = ['arm', 'disarm', 'mode_next', 'mode_prev', 'ch5_up', 'ch5_down', 'lock'];   // lock: §40 hedef kilidi / angajman (Boşluk ile aynı)
export const PAD_PREF = 'fs.pad.cfg';
export const PAD_ACTIVE_MS = 1500;
// Standart eşleme (Xbox / PlayStation / çoğu USB gamepad; Chrome/Firefox/Safari 'standard'): eksen 0 sol X, 1 sol Y (aşağı +), 2 sağ X, 3 sağ Y (aşağı +);
// düğme 9 Start/Menü = ARM, 8 Back/Select = DISARM, 5 RB / 4 LB = sonraki / önceki mod, 12 / 13 yön yukarı / aşağı = ch5 (mod anahtarı), 0 A/✕ = §40 hedef kilidi.
// RC verici (USB joystick kipi; eşleme ''): yaygın EdgeTX/OpenTX sırası X = kanatçık, Y = irtifa dümeni, Z = gaz, Rx = istikamet dümeni; düğme ataması yok.
// Hassasiyet sınırları (%): genel ölçek, eksen ölçeği, expo. Varsayılan 100 / 100 / 0 = kimlik (geriye uyumlu).
export const PAD_SENS_LIMITS = { scale: [25, 150], rate: [25, 150], expo: [0, 80] };
const SENS0 = () => ({ thr: { rate: 100, expo: 0 }, yaw: { rate: 100, expo: 0 }, pitch: { rate: 100, expo: 0 }, roll: { rate: 100, expo: 0 } });
export const DEFAULT_PAD = {
  standard: { dead: 0.08, scale: 100, sens: SENS0(), axes: { yaw: { i: 0, inv: false }, thr: { i: 1, inv: true }, roll: { i: 2, inv: false }, pitch: { i: 3, inv: true } },
    buttons: { arm: 9, disarm: 8, mode_next: 5, mode_prev: 4, ch5_up: 12, ch5_down: 13, lock: 0 } },
  rc: { dead: 0.03, scale: 100, sens: SENS0(), axes: { roll: { i: 0, inv: false }, pitch: { i: 1, inv: true }, thr: { i: 2, inv: false }, yaw: { i: 3, inv: false } },
    buttons: { arm: -1, disarm: -1, mode_next: -1, mode_prev: -1, ch5_up: -1, ch5_down: -1, lock: -1 } },
};
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const clone = o => JSON.parse(JSON.stringify(o));
export const padProfile = gp => (gp && gp.mapping === 'standard' ? 'standard' : 'rc');
/** Ölü bölge: |v| < dz → 0; dışında 0…1'e yeniden ölçeklenir (uçta ±1 kalır). */
export function deadzone(v, dz = 0.08) {
  const x = Number(v); if (!Number.isFinite(x)) return 0;
  const d = clamp(Number(dz) || 0, 0, 0.5), a = Math.abs(x);
  if (a <= d) return 0;
  return Math.sign(x) * Math.min(1, (a - d) / (1 - d));
}
const num = (v, d = 0) => (v == null || v === '' || !Number.isFinite(Number(v)) ? d : Number(v));
const lim = (v, [lo, hi], d) => Math.round(clamp(num(v, d), lo, hi));
/** Kumanda girdi eğrisi (ölü bölgeden sonra): v ∈ [−1, 1] → expo (y = (1−e)·x + e·x³) → × eksen ölçeği × genel ölçek → ±1. İşaret korunur; 0 → 0. */
export function padCurve(v, { rate = 100, expo = 0 } = {}, scale = 100) {
  const x = clamp(num(v), -1, 1), m = Math.abs(x);
  if (!m) return 0;
  const e = lim(expo, PAD_SENS_LIMITS.expo, 0) / 100, k = lim(rate, PAD_SENS_LIMITS.rate, 100) / 100 * lim(scale, PAD_SENS_LIMITS.scale, 100) / 100;
  return Math.sign(x) * Math.min(1, ((1 - e) * m + e * m * m * m) * k);
}
/** Eksenlere eğri: gaz yalnız kendi eksen ölçeğiyle (genel ölçek tutum eksenleri içindir — RC "rate" geleneği; askı / rölanti noktası kaymaz). null → null. */
export function shapePadAxes(axes, cfg) {
  const out = {};
  for (const k of PAD_AXES) out[k] = axes[k] == null ? null : padCurve(axes[k], cfg.sens?.[k], k === 'thr' ? 100 : cfg.scale);
  return out;
}
/** Uçakta MUTLAK (tutmalı, tek yönlü) gaz: −1…1 = rölanti…tam → eğri 0…1 aralığında, rölanti (−1) her zaman −1 kalır. null → null. */
export function padThrAbs(raw, cfg) {
  if (raw == null || !Number.isFinite(Number(raw))) return null;
  const u = (clamp(Number(raw), -1, 1) + 1) / 2;
  return 2 * padCurve(u, cfg.sens?.thr, 100) - 1;
}
/** Profil ayarını doğrula / tamamla (bozuk → varsayılan; eksen -1 = atanmamış). */
export function normPadCfg(c, profile = 'standard') {
  const D = DEFAULT_PAD[profile] || DEFAULT_PAD.standard, out = clone(D);
  if (!c || typeof c !== 'object') return out;
  if (Number.isFinite(Number(c.dead))) out.dead = clamp(Number(c.dead), 0, 0.5);
  out.scale = lim(c.scale, PAD_SENS_LIMITS.scale, 100);
  for (const k of PAD_AXES) {
    const q = c.sens?.[k] && typeof c.sens[k] === 'object' ? c.sens[k] : {};
    out.sens[k] = { rate: lim(q.rate, PAD_SENS_LIMITS.rate, 100), expo: lim(q.expo, PAD_SENS_LIMITS.expo, 0) };
  }
  for (const k of PAD_AXES) {
    const a = c.axes?.[k]; if (!a || typeof a !== 'object') continue;
    const i = Math.round(Number(a.i));
    out.axes[k] = { i: Number.isFinite(i) ? clamp(i, -1, 31) : D.axes[k].i, inv: !!a.inv };
  }
  for (const k of PAD_ACTIONS) { const i = Math.round(Number(c.buttons?.[k])); if (Number.isFinite(i)) out.buttons[k] = clamp(i, -1, 63); }
  return out;
}
export function loadPadCfg(storage = null) {
  let raw = null; try { raw = JSON.parse(storage?.getItem(PAD_PREF) || 'null'); } catch { raw = null; }
  return { standard: normPadCfg(raw?.standard, 'standard'), rc: normPadCfg(raw?.rc, 'rc') };
}
export function savePadCfg(storage, all) { try { storage?.setItem(PAD_PREF, JSON.stringify(all)); } catch { /* depolama kapalı */ } }
/** Kumanda → ham eksenler (−1…1; yalnız ölü bölge + ters çevirme). Atanmamış / olmayan eksen → null. thr: +1 = tam gaz (kol yukarı). */
export function readPadRaw(gp, cfg) {
  const out = {};
  for (const k of PAD_AXES) {
    const a = cfg.axes[k], raw = a && a.i >= 0 ? gp?.axes?.[a.i] : undefined;
    out[k] = raw == null || !Number.isFinite(Number(raw)) ? null : deadzone(a.inv ? -raw : raw, cfg.dead);
  }
  return out;
}
/** Kumanda → eksenler: ölü bölge + ters çevirme + hassasiyet eğrisi (padCurve; varsayılanda kimlik). */
export const readPadAxes = (gp, cfg) => shapePadAxes(readPadRaw(gp, cfg), cfg);
/** Atama kipinde eksen algılama: taban konumdan en çok (≥ eşik) oynatılan eksen → {i, inv} (kol yukarı / sağa itilir: ham değer azaldıysa ters). */
export function padLearnAxis(base, axes, thr = 0.5) {
  let best = null;
  (axes || []).forEach((v, i) => {
    const d = num(v) - num(base?.[i]);
    if (Math.abs(d) >= thr && (!best || Math.abs(d) > Math.abs(best.d))) best = { i, d };
  });
  return best ? { i: best.i, inv: best.d < 0 } : null;
}
const pressed = b => !!b && (typeof b === 'object' ? (b.pressed || (b.value ?? 0) > 0.5) : Number(b) > 0.5);
/** Düğme kenarları: önceki basılı kümesi → {set, down: yeni basılan dizinler}. */
export function padButtonEdges(prev, gp) {
  const set = new Set(), down = [];
  (gp?.buttons || []).forEach((b, i) => { if (pressed(b)) { set.add(i); if (!prev?.has(i)) down.push(i); } });
  return { set, down };
}
export const padActionsFor = (cfg, down) => PAD_ACTIONS.filter(k => cfg.buttons[k] >= 0 && down.includes(cfg.buttons[k]));
/** Eksenlerin hepsi nötr mü (gaz uçakta / RC vericide tutmalı olabilir → aktiflik ayrıca son hareket zamanıyla). */
export const padIsNeutral = axes => PAD_AXES.every(k => !axes[k]);

export const PAD_TEXTS = [
  ['pad.btn', 'Kumanda'], ['pad.btn_t', 'Fiziksel kumanda (gamepad / USB RC verici): eksen ve düğme ataması, ölü bölge, ters çevirme'],
  ['pad.connected', 'Kumanda bağlandı: {n}'], ['pad.disconnected', 'Kumanda ayrıldı: {n}'], ['pad.title', 'Fiziksel kumanda'],
  ['pad.profile_std', 'Standart eşleme'], ['pad.profile_rc', 'RC verici / diğer'], ['pad.dead', 'Ölü bölge'], ['pad.inv', 'Ters'],
  ['pad.axis_thr', 'Gaz'], ['pad.axis_yaw', 'Sapma (yaw)'], ['pad.axis_pitch', 'Yunuslama (pitch)'], ['pad.axis_roll', 'Yatış (roll)'],
  ['pad.act_arm', 'ARM'], ['pad.act_disarm', 'DISARM'], ['pad.act_mode_next', 'Sonraki mod'], ['pad.act_mode_prev', 'Önceki mod'],
  ['pad.act_ch5_up', 'Mod kanalı (ch5) +'], ['pad.act_ch5_down', 'Mod kanalı (ch5) −'], ['pad.act_lock', 'Hedef kilidi (angajman)'], ['pad.none', '—'], ['pad.axis_n', 'Eksen {n}'], ['pad.button_n', 'Düğme {n}'],
  ['pad.axes', 'Eksenler'], ['pad.buttons', 'Düğmeler'], ['pad.reset', 'Varsayılana dön'], ['pad.close', 'Kapat'],
  ['pad.hint', 'Mode 2: sol çubuk gaz / sapma, sağ çubuk yunuslama / yatış. Kollar nötr dışındayken kumanda önceliklidir; dokunulan sanal çubuk o tarafta kazanır.'],
  // hassasiyet (yalnız fiziksel kumanda girdisi; ⚙ Hassasiyet = ortak çıkış eğrisi) + canlı gösterge / algılama
  ['pad.sens', 'Kumanda girdisi hassasiyeti'], ['pad.scale', 'Genel ölçek'], ['pad.scale_t', 'Tutum eksenleri (gaz hariç)'],
  ['pad.rate', 'Eksen ölçeği'], ['pad.expo', 'Expo'], ['pad.axis_steer', 'Direksiyon'],
  ['pad.in_out', 'giriş {i} → çıkış {o}'],
  ['pad.sens_note', 'Yalnız bu fiziksel kumandaya uygulanır; ardından ⚙ Hassasiyet (sanal çubuk ve klavyeyle ortak çıkış eğrisi) gelir. Kesikli turuncu: ikisi birlikte.'],
  ['pad.thr_abs', 'Uçakta RC verici gazı: eğri rölantiden tama (rölanti hep ulaşılır)'],
  ['pad.learn', 'Algıla'], ['pad.learn_t', 'Atama: düğmeye basın ya da kolu oynatın'],
  ['pad.press', 'Düğmeye basın…'], ['pad.move', 'Kolu yukarı / sağa itin…'], ['pad.live', 'Canlı'],
];
const TXT = Object.fromEntries(PAD_TEXTS);
const fill = (s, p) => (p ? String(s).replace(/\{(\w+)\}/g, (m, k) => (p[k] != null ? String(p[k]) : m)) : String(s));
/** HEPGO (keyed=false): Türkçe metin anahtar; SIMUMAV (keyed=true): `pad.*` anahtarı, yoksa Türkçe. */
export const makePadT = (tr, keyed = false) => (k, p) => {
  const tx = TXT[k] ?? k;
  if (!tr) return fill(tx, p);
  if (!keyed) return tr(tx, p);
  const r = tr(k, p);
  return r && r !== k ? r : fill(tx, p);
};

// ---------------------------------------------------------------- DOM ----------------------------------------------------------------
function el(tag, attrs, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') e.className = v; else if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2), v); else e.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat(Infinity)) if (c != null && c !== false) e.append(c.nodeType ? c : document.createTextNode(String(c)));
  return e;
}
function sv(tag, attrs) {
  const e = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [k, v] of Object.entries(attrs || {})) e.setAttribute(k, v);
  return e;
}
const PAD_ICON_SVG = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 8h12a4 4 0 0 1 4 4v1.5a3.5 3.5 0 0 1-6.3 2.1L14.5 14h-5l-1.2 1.6A3.5 3.5 0 0 1 2 13.5V12a4 4 0 0 1 4-4z"/><path d="M7 11v3M5.5 12.5h3"/><circle cx="16" cy="11.5" r=".6"/><circle cx="18" cy="13.5" r=".6"/></svg>';
const CSS = `
.fs-pad{position:relative;display:inline-flex}
.fs-pad[hidden]{display:none}
.fs-pad-btn{display:inline-flex;align-items:center;gap:6px;font-weight:700}
.fs-pad-btn.act svg{color:#4ade80;filter:drop-shadow(0 0 4px rgba(74,222,128,.7))}
.fs-pad-pop{position:absolute;bottom:calc(100% + 10px);right:0;z-index:40;width:min(380px,calc(100vw - 16px));max-height:min(74vh,640px);overflow:auto;overscroll-behavior:contain;padding:10px 12px 12px;border-radius:12px;
  background:rgba(14,20,30,.97);color:#e6edf3;border:1px solid rgba(255,255,255,.14);box-shadow:0 18px 44px rgba(0,0,0,.55);font-size:12px;display:grid;gap:7px}
.fs-pad-pop[hidden]{display:none}
.fs-pad-pop h6{margin:0;display:flex;align-items:center;gap:8px;font:800 10.5px/1 ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.1em;text-transform:uppercase;opacity:.85}
.fs-pad-pop h6 span{flex:1}
.fs-pad-pop .fs-pad-x{border:0;background:transparent;color:inherit;opacity:.7;cursor:pointer;font-size:16px;line-height:1}
.fs-pad-name{font-size:11px;opacity:.75;word-break:break-word}
.fs-pad-sec{font:700 10px/1 system-ui,sans-serif;letter-spacing:.1em;text-transform:uppercase;opacity:.6;margin-top:4px}
.fs-pad-row{display:grid;grid-template-columns:96px minmax(0,1fr) auto auto;align-items:center;gap:6px;padding:3px 5px;margin:0 -5px;border-radius:8px;
  transition:background-color .18s ease,box-shadow .18s ease}
.fs-pad-row>span:first-child{opacity:.85;transition:color .18s ease}
.fs-pad-pop select{height:28px;border-radius:7px;border:1px solid rgba(255,255,255,.14);background:rgba(255,255,255,.07);color:#e6edf3;font:600 12px system-ui,sans-serif;padding:0 6px;min-width:0}
.fs-pad-pop select option{color:#111}
.fs-pad-pop label.inv{display:inline-flex;align-items:center;gap:4px;font-size:11px;opacity:.85}
.fs-pad-live{grid-column:1/-1;height:4px;border-radius:2px;background:rgba(255,255,255,.1);position:relative;overflow:hidden;margin-top:-1px}
.fs-pad-live i{position:absolute;top:0;bottom:0;left:50%;width:0;background:#38bdf8;transition:background-color .18s}
.fs-pad-live b{position:absolute;top:-1px;bottom:-1px;width:2px;margin-left:-1px;left:50%;background:rgba(255,255,255,.75);border-radius:1px}
.fs-pad-row.mv{background:rgba(56,189,248,.08);box-shadow:inset 0 0 0 1px rgba(56,189,248,.35),0 0 10px rgba(56,189,248,.18)}
.fs-pad-row.mv>span:first-child{color:#7dd3fc}
.fs-pad-row.hit{background:rgba(74,222,128,.12);box-shadow:inset 0 0 0 1px rgba(74,222,128,.7),0 0 14px rgba(74,222,128,.35)}
.fs-pad-row.hit>span:first-child{color:#4ade80}
.fs-pad-row.ok{animation:fs-pad-ok .9s ease}
@keyframes fs-pad-ok{0%{background:rgba(250,204,21,.32);box-shadow:inset 0 0 0 1px rgba(250,204,21,.9),0 0 16px rgba(250,204,21,.5)}100%{background:transparent;box-shadow:none}}
.fs-pad-chip{min-width:22px;height:22px;padding:0 5px;border-radius:11px;display:inline-grid;place-items:center;box-sizing:border-box;font:700 10.5px/1 ui-monospace,SFMono-Regular,Menlo,monospace;
  border:1px solid rgba(255,255,255,.18);background:rgba(255,255,255,.05);color:#cbd5e1;transition:background-color .15s ease,box-shadow .15s ease,transform .15s ease,color .15s ease}
.fs-pad-chip.none{opacity:.35}
.fs-pad-row .fs-pad-chip{width:28px;padding:0}
.fs-pad-chip.on{background:#4ade80;color:#052e16;border-color:#4ade80;box-shadow:0 0 0 3px rgba(74,222,128,.25),0 0 14px rgba(74,222,128,.85);transform:scale(1.1)}
.fs-pad-strip{display:flex;flex-wrap:wrap;gap:5px;align-items:center}
.fs-pad-strip>span{font:700 10px/1 system-ui,sans-serif;letter-spacing:.08em;text-transform:uppercase;opacity:.55;margin-right:2px}
.fs-pad-learn{height:26px;border-radius:7px;border:1px solid rgba(255,255,255,.2);background:transparent;color:inherit;font:600 11px system-ui,sans-serif;padding:0 8px;cursor:pointer;white-space:nowrap;max-width:132px;overflow:hidden;text-overflow:ellipsis}
.fs-pad-learn:hover{background:rgba(255,255,255,.08)}
.fs-pad-learn.wait{border-color:#facc15;color:#fde68a;background:rgba(250,204,21,.12);animation:fs-pad-pulse 1.1s ease-in-out infinite}
@keyframes fs-pad-pulse{0%,100%{box-shadow:0 0 0 0 rgba(250,204,21,.45)}50%{box-shadow:0 0 0 4px rgba(250,204,21,0)}}
.fs-pad-row.learn{background:rgba(250,204,21,.07);box-shadow:inset 0 0 0 1px rgba(250,204,21,.45)}
.fs-pad-dead,.fs-pad-sl{display:grid;grid-template-columns:96px minmax(0,1fr) 40px;align-items:center;gap:6px}
.fs-pad-dead input,.fs-pad-sl input{width:100%;min-width:0;accent-color:#38bdf8;touch-action:pan-y}
.fs-pad-dead b,.fs-pad-sl b{font:700 12px ui-monospace,SFMono-Regular,Menlo,monospace;text-align:right}
.fs-pad-sl>span small{display:block;opacity:.55;font-size:10px;line-height:1.2}
.fs-pad-seg{display:grid;gap:4px}
.fs-pad-seg button{padding:4px 3px;border-radius:7px;border:1px solid rgba(255,255,255,.16);background:rgba(255,255,255,.04);color:inherit;font:600 11px/1.15 system-ui,sans-serif;cursor:pointer;min-width:0}
.fs-pad-seg button.on{background:rgba(56,189,248,.22);border-color:rgba(56,189,248,.8);color:#e0f2fe}
.fs-pad-seg button.mv{box-shadow:0 0 8px rgba(56,189,248,.55)}
.fs-pad-sens{display:grid;grid-template-columns:minmax(0,1fr) 104px;gap:8px;align-items:center}
.fs-pad-sens .fs-pad-sl{grid-template-columns:84px minmax(0,1fr) 38px}
.fs-pad-cv{width:104px;height:104px;border-radius:10px;background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.1);display:block}
.fs-pad-cv .g{stroke:rgba(255,255,255,.12);stroke-width:.6}
.fs-pad-cv .lin{stroke:rgba(255,255,255,.28);stroke-width:.8;stroke-dasharray:2 2;fill:none}
.fs-pad-cv .feel{stroke:#fb923c;stroke-width:1.1;stroke-dasharray:3 2;fill:none;opacity:.9}
.fs-pad-cv .cur{stroke:#38bdf8;stroke-width:2.2;fill:none;stroke-linejoin:round}
.fs-pad-cv .dot{fill:#facc15;stroke:#0b1220;stroke-width:1;transition:r .15s}
.fs-pad-cv .dot.mv{filter:drop-shadow(0 0 3px rgba(250,204,21,.9))}
.fs-pad-io{font:600 11px/1.2 ui-monospace,SFMono-Regular,Menlo,monospace;color:#fde68a;opacity:.9;min-height:1.2em}
.fs-pad-pop .fs-pad-reset{justify-self:start;border:1px solid rgba(255,255,255,.2);background:transparent;color:inherit;border-radius:8px;padding:5px 10px;cursor:pointer;font:600 12px system-ui,sans-serif}
.fs-pad-pop small{opacity:.65;line-height:1.35}
.fs-pad-pop small[hidden]{display:none}
.fs-bar:has(.fs-pad-pop:not([hidden])){z-index:9}
.fs-pad-pop.mob{position:fixed;left:8px;right:8px;width:auto;bottom:auto;top:max(8px,env(safe-area-inset-top));max-height:calc(100dvh - 16px);z-index:1200;background:#0e141e}
@media (max-width:760px){.fs-pad-row{grid-template-columns:84px minmax(0,1fr) auto auto}.fs-pad-dead,.fs-pad-sl{grid-template-columns:84px minmax(0,1fr) 40px}}
@media (prefers-reduced-motion:reduce){.fs-pad-row,.fs-pad-chip,.fs-pad-live i{transition:none}.fs-pad-learn.wait,.fs-pad-row.ok{animation:none}}
`;
function ensureCss() {
  if (typeof document === 'undefined' || document.getElementById('fs-pad-css')) return;
  const s = document.createElement('style'); s.id = 'fs-pad-css'; s.textContent = CSS; document.head.appendChild(s);
}
const cx = x => (50 + x * 46).toFixed(1), cy = y => (50 - y * 46).toFixed(1);

export function createGamepadCtl({ tr = null, keyed = false, vehicle = 'copter', feelShape = null, storage = (typeof localStorage !== 'undefined' ? localStorage : null),
  win = (typeof window !== 'undefined' ? window : null), nav = (typeof navigator !== 'undefined' ? navigator : null), btnClass = 'btn sm',
  onConnect = () => {}, onDisconnect = () => {}, onAction = () => {}, onChange = () => {} } = {}) {
  ensureCss();
  const T = makePadT(tr, keyed);
  const rover = vehicle === 'rover', plane = vehicle === 'plane';
  let all = loadPadCfg(storage), idx = null, info = null, prevBtns = new Set(), lastAxes = null, lastMoveAt = 0, cur = null, timer = null, disposed = false;
  let raf = 0, learn = null, sensAx = 'thr';
  const muted = new Set();   // atama sırasında / hemen sonrasında basılı tutulan düğmeler: bırakılana dek eylem üretmez
  const rafFn = win?.requestAnimationFrame ? f => win.requestAnimationFrame(f) : f => setTimeout(f, 16);
  const cafFn = win?.cancelAnimationFrame ? id => win.cancelAnimationFrame(id) : id => clearTimeout(id);
  const list = () => { try { return [...(nav?.getGamepads?.() || [])]; } catch { return []; } };
  const gpNow = () => (idx == null ? null : list()[idx] || null);
  const prof = () => info?.profile || 'standard';
  const cfg = () => all[prof()];
  const axLabel = k => T(rover && k === 'roll' ? 'pad.axis_steer' : `pad.axis_${k}`);
  const SENS_KEYS = rover ? ['thr', 'roll'] : PAD_AXES;
  const thrAbsMode = () => plane && prof() !== 'standard';   // uçak + RC verici: mutlak tek yönlü gaz
  // Önizleme eğrisi (seçili eksen): kumanda girdisi → eksen değeri; feelShape varsa ⚙ ortak eğriyle birlikte
  const padFn = k => (k === 'thr' && thrAbsMode() ? x => padThrAbs(x, cfg()) : x => padCurve(x, cfg().sens[k], k === 'thr' ? 100 : cfg().scale));
  // ---------------- arayüz ----------------
  const ico = el('span', { 'aria-hidden': 'true' }); ico.innerHTML = PAD_ICON_SVG;
  const btn = el('button', { class: `${btnClass} fs-pad-btn`, type: 'button', title: T('pad.btn_t'), 'aria-haspopup': 'dialog', onclick: e => { e.stopPropagation(); setOpen(pop.hidden); } }, ico, el('span', null, T('pad.btn')));
  const nameEl = el('div', { class: 'fs-pad-name' });
  const deadIn = el('input', { type: 'range', min: 0, max: 0.3, step: 0.01, 'aria-label': T('pad.dead'), oninput: () => { cfg().dead = Number(deadIn.value); deadOut.textContent = `${Math.round(cfg().dead * 100)}%`; persist(); } });
  const deadOut = el('b');
  // --- hassasiyet (yalnız kumanda girdisi) ---
  const scaleIn = el('input', { type: 'range', min: PAD_SENS_LIMITS.scale[0], max: PAD_SENS_LIMITS.scale[1], step: 5, 'aria-label': T('pad.scale'),
    oninput: () => { cfg().scale = Number(scaleIn.value); scaleOut.textContent = `${cfg().scale}%`; persist(); drawCurve(); } });
  const scaleOut = el('b');
  const rateIn = el('input', { type: 'range', min: PAD_SENS_LIMITS.rate[0], max: PAD_SENS_LIMITS.rate[1], step: 5, 'aria-label': T('pad.rate'),
    oninput: () => { cfg().sens[sensAx].rate = Number(rateIn.value); rateOut.textContent = `${cfg().sens[sensAx].rate}%`; persist(); drawCurve(); } });
  const rateOut = el('b');
  const expoIn = el('input', { type: 'range', min: PAD_SENS_LIMITS.expo[0], max: PAD_SENS_LIMITS.expo[1], step: 5, 'aria-label': T('pad.expo'),
    oninput: () => { cfg().sens[sensAx].expo = Number(expoIn.value); expoOut.textContent = `${cfg().sens[sensAx].expo}%`; persist(); drawCurve(); } });
  const expoOut = el('b');
  const tabs = SENS_KEYS.map(k => el('button', { type: 'button', 'data-axis': k, onclick: e => { e.stopPropagation(); sensAx = k; fillSens(); } }, axLabel(k)));
  const seg = el('div', { class: 'fs-pad-seg', role: 'tablist', style: `grid-template-columns:repeat(${tabs.length},minmax(0,1fr))` }, tabs);
  const pLin = sv('path', { class: 'lin', d: 'M4 96L96 4' }), pFeel = sv('path', { class: 'feel' }), pCur = sv('path', { class: 'cur' }), dot = sv('circle', { class: 'dot', r: 3.2, cx: 50, cy: 50 });
  const cv = sv('svg', { class: 'fs-pad-cv', viewBox: '0 0 100 100', role: 'img', 'aria-label': T('pad.sens') });
  cv.append(sv('path', { class: 'g', d: 'M50 4V96M4 50H96' }), pLin, pFeel, pCur, dot);
  const ioEl = el('div', { class: 'fs-pad-io' });
  const thrNote = el('small', { hidden: true }, T('pad.thr_abs'));
  const sl = (lbl, inp, out, hint) => el('div', { class: 'fs-pad-sl' }, el('span', null, lbl, hint ? el('small', null, hint) : null), inp, out);
  function drawCurve() {
    const f = padFn(sensAx), fs = feelShape ? x => feelShape(sensAx, f(x)) : null;
    const path = g => Array.from({ length: 41 }, (_, i) => { const x = -1 + i / 20; return `${i ? 'L' : 'M'}${cx(x)} ${cy(clamp(g(x), -1, 1))}`; }).join('');
    pCur.setAttribute('d', path(f));
    if (fs) pFeel.setAttribute('d', path(fs)); else pFeel.removeAttribute('d');
    thrNote.hidden = !(sensAx === 'thr' && thrAbsMode());
  }
  function fillSens() {
    const c = cfg(), q = c.sens[sensAx];
    scaleIn.value = String(c.scale); scaleOut.textContent = `${c.scale}%`;
    rateIn.value = String(q.rate); rateOut.textContent = `${q.rate}%`;
    expoIn.value = String(q.expo); expoOut.textContent = `${q.expo}%`;
    for (const b of tabs) { const on = b.dataset.axis === sensAx; b.classList.toggle('on', on); b.setAttribute('aria-selected', on ? 'true' : 'false'); }
    drawCurve();
  }
  // --- eksen / düğme satırları (Algıla: atama kipi) ---
  const learnBtn = (kind, k) => el('button', { class: 'fs-pad-learn', type: 'button', title: T('pad.learn_t'), onclick: e => { e.stopPropagation(); toggleLearn(kind, k); } }, T('pad.learn'));
  const axRows = PAD_AXES.map(k => {
    const sel = el('select', { 'aria-label': axLabel(k), onchange: () => { cfg().axes[k].i = Number(sel.value); persist(); } });
    const inv = el('input', { type: 'checkbox', onchange: () => { cfg().axes[k].inv = inv.checked; persist(); } });
    const bar = el('i'), mark = el('b'), lb = learnBtn('axis', k);
    const row = el('div', { class: 'fs-pad-row', 'data-axis': k }, el('span', null, axLabel(k)), sel, el('label', { class: 'inv' }, inv, T('pad.inv')), lb, el('div', { class: 'fs-pad-live' }, bar, mark));
    return { k, sel, inv, bar, mark, row, lb };
  });
  const btRows = PAD_ACTIONS.map(k => {
    const sel = el('select', { 'aria-label': T(`pad.act_${k}`), onchange: () => { cfg().buttons[k] = Number(sel.value); persist(); fillChips(); } });
    const chip = el('span', { class: 'fs-pad-chip' }), lb = learnBtn('btn', k);
    const row = el('div', { class: 'fs-pad-row', 'data-act': k }, el('span', null, T(`pad.act_${k}`)), sel, lb, chip);
    return { k, sel, row, chip, lb };
  });
  const strip = el('div', { class: 'fs-pad-strip', 'aria-live': 'off' });
  let stripChips = [];
  const pop = el('div', { class: 'fs-pad-pop', role: 'dialog', 'aria-label': T('pad.title'), hidden: true },
    el('h6', null, ico.cloneNode(true), el('span', null, T('pad.title')), el('button', { class: 'fs-pad-x', type: 'button', title: T('pad.close'), 'aria-label': T('pad.close'), onclick: e => { e.stopPropagation(); setOpen(false); } }, '×')),
    nameEl,
    el('div', { class: 'fs-pad-dead' }, el('span', null, T('pad.dead')), deadIn, deadOut),
    el('div', { class: 'fs-pad-sec' }, T('pad.sens')),
    rover ? null : sl(T('pad.scale'), scaleIn, scaleOut, T('pad.scale_t')),
    seg,
    el('div', { class: 'fs-pad-sens' },
      el('div', { style: 'display:grid;gap:6px' }, sl(T('pad.rate'), rateIn, rateOut), sl(T('pad.expo'), expoIn, expoOut), ioEl),
      cv),
    thrNote,
    el('small', null, T('pad.sens_note')),
    el('div', { class: 'fs-pad-sec' }, T('pad.axes')), axRows.map(r => r.row),
    el('div', { class: 'fs-pad-sec' }, T('pad.buttons')), strip, btRows.map(r => r.row),
    el('small', null, T('pad.hint')),
    el('button', { class: 'fs-pad-reset', type: 'button', onclick: e => { e.stopPropagation(); endLearn(); all[prof()] = clone(DEFAULT_PAD[prof()]); persist(); fillForm(); } }, T('pad.reset')));
  const root = el('div', { class: 'fs-pad', hidden: true }, btn, pop);
  pop.addEventListener('click', e => e.stopPropagation());
  function persist() { savePadCfg(storage, all); onChange(); }
  function fillChips() { for (const r of btRows) { const b = cfg().buttons[r.k]; r.chip.textContent = b >= 0 ? String(b) : T('pad.none'); r.chip.classList.toggle('none', b < 0); } }
  function fillForm() {
    const gp = gpNow(), na = Math.max(gp?.axes?.length || 0, 4), nb = Math.max(gp?.buttons?.length || 0, 1), c = cfg();
    nameEl.textContent = info ? `${info.id} · ${T(info.profile === 'standard' ? 'pad.profile_std' : 'pad.profile_rc')} · ${na} / ${nb}` : '';
    deadIn.value = String(c.dead); deadOut.textContent = `${Math.round(c.dead * 100)}%`;
    for (const r of axRows) {
      r.sel.replaceChildren(el('option', { value: -1 }, T('pad.none')), ...Array.from({ length: na }, (_, i) => el('option', { value: i }, T('pad.axis_n', { n: i }))));
      r.sel.value = String(c.axes[r.k].i); r.inv.checked = !!c.axes[r.k].inv;
    }
    for (const r of btRows) {
      r.sel.replaceChildren(el('option', { value: -1 }, T('pad.none')), ...Array.from({ length: nb }, (_, i) => el('option', { value: i }, T('pad.button_n', { n: i }))));
      r.sel.value = String(c.buttons[r.k]);
    }
    stripChips = Array.from({ length: nb }, (_, i) => el('span', { class: 'fs-pad-chip', title: T('pad.button_n', { n: i }) }, String(i)));
    strip.replaceChildren(el('span', null, T('pad.live')), ...stripChips);
    fillChips(); fillSens();
  }
  // ---------------- atama kipi (Algıla) ----------------
  const learnRow = () => (learn ? (learn.kind === 'btn' ? btRows : axRows).find(r => r.k === learn.k) : null);
  function endLearn() {
    const r = learnRow(); learn = null;
    if (r) { r.row.classList.remove('learn'); r.lb.classList.remove('wait'); r.lb.textContent = T('pad.learn'); }
  }
  function toggleLearn(kind, k) {
    const same = learn && learn.kind === kind && learn.k === k;
    endLearn();
    if (same) return;
    const gp = gpNow();
    learn = { kind, k, held: new Set((gp?.buttons || []).map((b, i) => (pressed(b) ? i : -1)).filter(i => i >= 0)), base: gp ? [...(gp.axes || [])] : null };
    const r = learnRow(); r.row.classList.add('learn'); r.lb.classList.add('wait'); r.lb.textContent = T(kind === 'btn' ? 'pad.press' : 'pad.move');
  }
  function flashOk(r) { r.row.classList.remove('ok'); void r.row.offsetWidth; r.row.classList.add('ok'); setTimeout(() => r.row.classList.remove('ok'), 950); }
  function assign(kind, k, v) {
    const c = cfg();
    if (kind === 'btn') { for (const a of PAD_ACTIONS) if (a !== k && c.buttons[a] === v) c.buttons[a] = -1; c.buttons[k] = v; }   // aynı düğme tek eyleme
    else { for (const a of PAD_AXES) if (a !== k && c.axes[a].i === v.i) c.axes[a].i = -1; c.axes[k] = { i: v.i, inv: v.inv }; }
    endLearn(); persist(); fillForm();
    const r = (kind === 'btn' ? btRows : axRows).find(x => x.k === k); if (r) flashOk(r);
  }
  // ---------------- canlı gösterge (requestAnimationFrame; yalnız panel açıkken) ----------------
  let ioTxt = '';
  function padFrame() {
    raf = 0;
    if (disposed || pop.hidden) return;
    const gp = gpNow();
    if (gp) {
      const c = cfg(), raw = readPadRaw(gp, c), out = shapePadAxes(raw, c), set = new Set();
      (gp.buttons || []).forEach((b, i) => { if (pressed(b)) set.add(i); });
      if (learn) {
        if (learn.kind === 'btn') {
          for (const i of [...learn.held]) if (!set.has(i)) learn.held.delete(i);   // atama başlarken basılı olan: bırakılıp yeniden basılınca sayılır
          const i = [...set].find(j => !learn.held.has(j));
          if (i != null) { for (const j of set) muted.add(j); assign('btn', learn.k, i); }
        } else if (!learn.base) learn.base = [...(gp.axes || [])];
        else { const a = padLearnAxis(learn.base, gp.axes, 0.5); if (a) assign('axis', learn.k, a); }
      }
      for (const r of axRows) {
        const v = r.k === 'thr' && thrAbsMode() ? (padThrAbs(raw.thr, c) ?? 0) : (out[r.k] ?? 0), w = raw[r.k] ?? 0;
        r.bar.style.left = `${50 + Math.min(0, v) * 50}%`; r.bar.style.width = `${Math.abs(v) * 50}%`;
        r.mark.style.left = `${50 + w * 50}%`;
        r.row.classList.toggle('mv', Math.abs(w) > 0.05 && !(r.k === 'thr' && thrAbsMode() && w < -0.95));
      }
      for (const b of tabs) b.classList.toggle('mv', Math.abs(raw[b.dataset.axis] ?? 0) > 0.05);
      for (const r of btRows) { const on = c.buttons[r.k] >= 0 && set.has(c.buttons[r.k]); r.row.classList.toggle('hit', on); r.chip.classList.toggle('on', on); }
      stripChips.forEach((ch, i) => ch.classList.toggle('on', set.has(i)));
      const x = raw[sensAx] ?? 0, y = clamp(padFn(sensAx)(x), -1, 1);
      dot.setAttribute('cx', cx(x)); dot.setAttribute('cy', cy(y)); dot.classList.toggle('mv', Math.abs(x) > 0.05);
      const t = T('pad.in_out', { i: x.toFixed(2), o: y.toFixed(2) });
      if (t !== ioTxt) { ioTxt = t; ioEl.textContent = t; }
    }
    raf = rafFn(padFrame);
  }
  // Dar ekranda (mobil ☰ menüsü dönüşümlü/kaydırmalı bir kapta) panel tam ekran katmanına taşınır: tam ekran öğesi ya da body (fixed, ekrana sığar)
  const narrow = () => { try { return !!win?.matchMedia?.('(max-width: 760px)').matches; } catch { return false; } };
  function setOpen(v) {
    pop.hidden = !v;
    if (v) {
      if (narrow() && typeof document !== 'undefined') { (document.fullscreenElement || document.body).append(pop); pop.classList.add('mob'); }
      fillForm(); if (!raf) raf = rafFn(padFrame);
    } else {
      endLearn(); if (raf) { cafFn(raf); raf = 0; }
      if (pop.classList.contains('mob')) { pop.classList.remove('mob'); root.append(pop); }
    }
  }
  const onDoc = e => { if (!pop.hidden && !root.contains(e.target) && !pop.contains(e.target)) setOpen(false); };
  const onEsc = e => {
    if (e.key !== 'Escape' || pop.hidden) return;
    if (learn) endLearn(); else setOpen(false);   // atama kipinde Esc yalnız atamayı bırakır
    e.preventDefault(); e.stopPropagation();
  };
  // ---------------- yoklama (20 Hz, bağlıyken) ----------------
  function poll() {
    if (disposed) return;
    const gp = gpNow();
    if (!gp) { cur = null; return; }
    const c = cfg(), raw = readPadRaw(gp, c), axes = shapePadAxes(raw, c), now = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    if (lastAxes && PAD_AXES.some(k => Math.abs((raw[k] ?? 0) - (lastAxes[k] ?? 0)) > 0.02)) lastMoveAt = now;
    lastAxes = raw;
    const active = !padIsNeutral(raw) || now - lastMoveAt < PAD_ACTIVE_MS;
    cur = { active, axes, raw, thrAbs: padThrAbs(raw.thr, c), profile: prof() };   // standart gamepad: uçakta gaz kolu yaylı → hız olarak (virtualRC)
    btn.classList.toggle('act', active);
    const { set, down } = padButtonEdges(prevBtns, gp); prevBtns = set;
    for (const i of [...muted]) if (!set.has(i)) muted.delete(i);
    if (learn) for (const i of set) muted.add(i);   // atama kipinde basılan düğme eylem tetiklemez
    for (const a of padActionsFor(c, down.filter(i => !muted.has(i)))) onAction(a);
  }
  function attach(gp, announce = true) {
    if (!gp || idx != null) return;
    idx = gp.index; info = { id: String(gp.id || 'Gamepad').replace(/\s*\(.*?Vendor.*?\)\s*/i, ' ').trim(), profile: padProfile(gp), axes: gp.axes?.length || 0, buttons: gp.buttons?.length || 0 };
    prevBtns = new Set((gp.buttons || []).map((b, i) => (pressed(b) ? i : -1)).filter(i => i >= 0));   // bağlanırken basılı düğme eylem saymaz
    lastAxes = null; lastMoveAt = 0;
    root.hidden = false;
    if (!timer) timer = setInterval(poll, 50);
    poll();
    if (announce) onConnect(info);
  }
  function detach() {
    const was = info; setOpen(false); idx = null; info = null; cur = null; root.hidden = true;
    if (timer) { clearInterval(timer); timer = null; }
    if (was) onDisconnect(was);
  }
  const onConn = e => attach(e.gamepad);
  const onDisc = e => { if (e.gamepad?.index === idx) { detach(); const g = list().find(Boolean); if (g) attach(g); } };
  win?.addEventListener?.('gamepadconnected', onConn);
  win?.addEventListener?.('gamepaddisconnected', onDisc);
  if (typeof document !== 'undefined') document.addEventListener('pointerdown', onDoc, true);
  win?.addEventListener?.('keydown', onEsc, true);
  // Sayfa açılmadan takılı kumanda: tarayıcı ilk düğme basımına kadar listede göstermeyebilir (gizlilik) → bağlantı olayı o an gelir
  setTimeout(() => { if (disposed) return; const g0 = list().find(Boolean); if (g0) attach(g0); }, 0);   // çağıran kurulumu bitirsin (onConnect geri çağrısı)
  return {
    el: root,
    state: () => (idx == null ? null : cur),
    get connected() { return idx != null; }, get info() { return info; }, get cfg() { return cfg(); },
    get looping() { return !!raf; },
    openPanel: () => setOpen(true), closePanel: () => setOpen(false), poll,
    refreshCurve: () => { if (!pop.hidden) drawCurve(); },   // ⚙ Hassasiyet değişince kesikli birleşik eğri
    dispose() {
      disposed = true; if (timer) clearInterval(timer); if (raf) { cafFn(raf); raf = 0; }
      win?.removeEventListener?.('gamepadconnected', onConn); win?.removeEventListener?.('gamepaddisconnected', onDisc);
      if (typeof document !== 'undefined') document.removeEventListener('pointerdown', onDoc, true);
      win?.removeEventListener?.('keydown', onEsc, true); pop.remove(); root.remove();
    },
  };
}
