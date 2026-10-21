// Uçuş Simülatörü — SERVO TETİK (docs/ucus-simulatoru.md §34; HEPGO + SIMUMAV ortak). Alt bantta (tüm kamera kiplerinden, sanal kumanda ve
// harekât paneli açıkken de) TEK servo simgeli "Dinle" düğmesi; basınca düğmenin üstünde yukarı açılan panel: kanal seçici (S1–S16; dronun
// SERVOn_FUNCTION adıyla "9 · RCIN9 / Yük"), koşul (≥ / ≤ / = ±tolerans) + PWM eşiği (µs), gecikme (ms), kanalın anlık PWM'i (tele.servo16; MAVLink2
// 9–16 dahil) ve "Dinlemeye başla" / "Dinlemeyi durdur". Dinleme başlayınca panel kapanır, düğme kırmızı yanıp söner ("Dinleniyor"). Tetik mantığı
// SUNUCUDADIR (app/flightsim_servotrig.py: kenar tetik, simülasyon zamanı gecikme, çarpma) — ön yüz yalnız `servo_trigger` komutunu yollar ve
// `{t:'servo_trigger', phase}` çerçevelerini gösterir; `fired` gelince oturumun Bitir akışı onaysız çalışır (kayıt → özet raporu → kapat).
// Tercih kalıcı (localStorage fs.srvtrig; dron başına fs.srvtrig.byDrone) + sunucunun dron kaydı önerisi (session.servo_trigger.suggest).
// Saf katman (node testi tests/test_flightsim_servotrig.mjs): SERVO_FN, fnName, isPayloadFn, chanLabel, condText, normalizeCfg, pickInitial,
//   pwmFor, servoReportLines, servoMapPoints, servoRunBadge, srvBtnKey, srvActKey.
// createServoTrigger({ tr, keyed, cmd(name, params) → Promise, onEvent(text, sev), session, droneId, storage }) →
//   { el, update(tele), onFrame(m), open(), close(), isOpen, dispose(), get phase }  ·  servoSection(sum, tr, h) → rapor bölümü (flightsim_report.js)

export const SERVO_FN = (() => {
  const m = { '-1': 'GPIO', 0: 'Disabled', 1: 'RCPassThru', 2: 'Flap', 3: 'FlapAuto', 4: 'Aileron', 6: 'MountPan', 7: 'MountTilt', 8: 'MountRoll', 9: 'MountOpen',
    10: 'CameraTrigger', 12: 'Mount2Pan', 13: 'Mount2Tilt', 14: 'Mount2Roll', 15: 'Mount2Open', 19: 'Elevator', 21: 'Rudder', 22: 'SprayerPump', 23: 'SprayerSpinner',
    24: 'FlaperonLeft', 25: 'FlaperonRight', 26: 'GroundSteering', 27: 'Parachute', 28: 'Gripper', 29: 'LandingGear', 30: 'EngineRunEnable', 31: 'HeliRSC', 32: 'HeliTailRSC',
    67: 'Ignition', 69: 'Starter', 70: 'Throttle', 73: 'ThrottleLeft', 74: 'ThrottleRight', 77: 'ElevonLeft', 78: 'ElevonRight', 79: 'VTailLeft', 80: 'VTailRight', 88: 'Winch' };
  for (let i = 1; i <= 8; i++) m[32 + i] = `Motor${i}`;
  for (let i = 1; i <= 4; i++) m[81 + i] = `Motor${8 + i}`;
  for (let i = 1; i <= 16; i++) { m[50 + i] = `RCIN${i}`; m[93 + i] = `Script${i}`; }
  return m;
})();
const PAYLOAD = new Set([1, 9, 10, 15, 22, 23, 27, 28, 88, ...Array.from({ length: 16 }, (_, i) => 51 + i), ...Array.from({ length: 16 }, (_, i) => 94 + i)]);
export const fnName = code => (code == null ? null : SERVO_FN[code] ?? `F${code}`);
export const isPayloadFn = code => code != null && PAYLOAD.has(Number(code));
export const CMP_SIGN = { ge: '≥', le: '≤', eq: '=' };
export const LIMITS = { pwm: [800, 2200], delay_ms: [0, 60000], tol: [1, 500] };
export const DEFAULT_CFG = { ch: 9, pwm: 1900, cmp: 'ge', tol: 50, delay_ms: 1500 };

export const SRV_TEXTS = [
  ['srv.title', 'Servo tetik'], ['srv.title_t', 'Servo tetik: seçili servo kanalına komut (PWM koşulu) gelince gecikme sonunda araç çarpmış sayılır, simülasyon biter ve özet açılır'],
  ['srv.ch_t', 'Servo kanalı (SERVOn_FUNCTION işleviyle)'], ['srv.cmp_t', 'Koşul: ≥ eşik / ≤ eşik / = eşik ± tolerans'],
  ['srv.pwm_t', 'PWM eşiği (µs, 800–2200)'], ['srv.tol_t', 'Tolerans (± µs)'], ['srv.delay_t', 'Gecikme (ms, simülasyon zamanı; 0–60000)'],
  ['srv.listen', 'Dinle'], ['srv.stop', 'Durdur'], ['srv.listen_t', 'Kanalı dinle: koşul YENİ sağlandığında (kenar) tetiklenir'],
  ['srv.payload', 'Yük'], ['srv.pending', 'TETİK · {s} sn'], ['srv.fired', 'ÇARPMA'],
  ['srv.ev_on', 'Servo tetik dinleniyor: {c}'], ['srv.ev_off', 'Servo tetik dinlemesi kapatıldı'],
  ['srv.ev_fired', 'Servo tetik çalıştı — simülasyon bitiriliyor, özet raporu açılıyor'],
  ['srv.banner', 'SERVO TETİK · S{ch} {pwm} µs'], ['srv.banner_sub', '{d} ms sonra çarpma · AGL {agl} m · evden {dist} m'],
  ['srv.banner_hit', 'çarpma AGL {agl} m · evden {dist} m (tetik AGL {tagl} m)'],
  ['srv.err', 'Servo tetik: {e}'],
  // alt bant düğmesi + açılır panel (popover)
  ['srv.listening', 'Dinleniyor'], ['srv.trig', 'Tetiklendi'], ['srv.start', 'Dinlemeye başla'], ['srv.stop_l', 'Dinlemeyi durdur'],
  ['srv.live', 'Canlı PWM'], ['srv.ch', 'Kanal'], ['srv.cmp', 'Koşul'], ['srv.tol', 'Tolerans'], ['srv.delay', 'Gecikme'], ['srv.close', 'Kapat'],
  ['srv.btn_t', 'Servo tetik: kanal, koşul, PWM eşiği ve gecikme ayarı; dinlemeyi başlat / durdur'],
];
const TXT = Object.fromEntries(SRV_TEXTS);
const fill = (s, p) => (p ? String(s).replace(/\{(\w+)\}/g, (m, k) => (p[k] != null ? String(p[k]) : m)) : String(s));
/** HEPGO (keyed=false) Türkçe metni anahtar verir; SIMUMAV (keyed=true) `srv.*` anahtarını, yoksa Türkçe. */
export const makeSrvT = (tr, keyed = false) => (k, p) => {
  const tx = TXT[k] ?? k;
  if (!tr) return fill(tx, p);
  if (!keyed) return tr(tx, p);
  const r = tr(k, p);
  return r && r !== k ? r : fill(tx, p);
};

/** Kanal etiketi: "9 · RCIN9 / Yük" (işlev bilinmiyorsa "9"). */
export function chanLabel(n, code, T = k => TXT[k] ?? k) {
  const nm = fnName(code);
  if (!nm) return String(n);
  return `${n} · ${nm}${isPayloadFn(code) && !/^(Disabled|RCPassThru)$/.test(nm) ? ` / ${T('srv.payload')}` : ''}`;
}
export function condText(cfg) {
  if (!cfg) return '';
  return cfg.cmp === 'eq' ? `= ${cfg.pwm} ±${cfg.tol} µs` : `${CMP_SIGN[cfg.cmp] || '≥'} ${cfg.pwm} µs`;
}
const clampInt = (v, [a, b], d) => { const n = Math.round(Number(v)); return Number.isFinite(n) ? Math.min(b, Math.max(a, n)) : d; };
/** Ayar sözlüğü → sunucu sınırlarına kırpılmış {ch, pwm, cmp, tol, delay_ms}. */
export function normalizeCfg(c = {}) {
  return { ch: clampInt(c.ch, [1, 16], DEFAULT_CFG.ch), pwm: clampInt(c.pwm, LIMITS.pwm, DEFAULT_CFG.pwm), cmp: CMP_SIGN[c.cmp] ? c.cmp : 'ge',
    tol: clampInt(c.tol, LIMITS.tol, DEFAULT_CFG.tol), delay_ms: clampInt(c.delay_ms, LIMITS.delay_ms, DEFAULT_CFG.delay_ms) };
}
/** Başlangıç ayarı: dron başına kayıt > sunucu önerisi (dron kaydı) > son genel tercih > varsayılan. */
export function pickInitial({ stored = null, byDrone = null, droneId = null, suggest = null } = {}) {
  const d = droneId != null && byDrone ? byDrone[String(droneId)] : null;
  return normalizeCfg(d || suggest || stored || DEFAULT_CFG);
}
/** Telemetriden kanalın anlık PWM'i (servo16 → servo 1–8 yedeği); yoksa null. */
export function pwmFor(tele, ch) {
  const a = tele?.servo16 || (ch <= 8 ? tele?.servo : null);
  const v = a ? Number(a[ch - 1]) : NaN;
  return Number.isFinite(v) && v > 0 && v < 65535 ? v : null;
}

const f1 = v => (v == null || !Number.isFinite(Number(v)) ? '—' : Number(v).toFixed(1));
const f0 = v => (v == null || !Number.isFinite(Number(v)) ? '—' : String(Math.round(Number(v))));
const ll = p => (p && p.lat != null ? `${Number(p.lat).toFixed(6)}, ${Number(p.lon).toFixed(6)}` : '—');
/** Rapor metni satırları (paylaşım metni). */
export function servoReportLines(sum, tr = fill) {
  const S = sum?.servo_trigger; if (!S) return [];
  const t = S.trigger, c = S.hit;
  const out = [`${tr('Servo tetik')}: S${S.ch}${S.fn_name ? ` (${S.fn_name})` : ''} ${condText(S)} · ${tr('gecikme')} ${S.delay_ms} ms`];
  if (t) out.push(`${tr('Tetik anı')}: AGL ${f1(t.agl)} m · MSL ${f1(t.alt_msl)} m · ${tr('evden')} ${f0(t.dist_home_m)} m · ${ll(t)}`);
  if (c) out.push(`${tr('Çarpma anı')}: AGL ${f1(c.agl)} m · MSL ${f1(c.alt_msl)} m · ${tr('evden')} ${f0(c.dist_home_m)} m · ${ll(c)}`);
  if (!t) out.push(tr('Tetik gelmedi (dinleme sürdü)'));
  return out;
}
/** Mini harita işaretleri: [{lat, lon, kind:'trigger'|'hit'}]. */
export function servoMapPoints(sum) {
  const S = sum?.servo_trigger; if (!S) return [];
  return [S.trigger && { ...S.trigger, kind: 'trigger' }, S.hit && { ...S.hit, kind: 'hit' }].filter(p => p && p.lat != null).map(p => ({ lat: p.lat, lon: p.lon, kind: p.kind }));
}
/** Kayıt listesi / uçuş kartı rozeti: drone_sim_runs.servo_trig → "⚡ S9 · 80 m" (tetik AGL) ya da null. */
export function servoRunBadge(r, tr = fill) {
  const k = r?.servo_trig; if (!k) return null;
  return { text: `⚡ S${k.ch} · ${k.trig_agl != null ? `${f0(k.trig_agl)} m` : '—'}`,
    title: tr('Servo tetik S{ch} · tetik AGL {a} m · evden {d} m · gecikme {ms} ms', { ch: k.ch, a: f1(k.trig_agl), d: f0(k.trig_dist_m), ms: k.delay_ms ?? 0 }) };
}

/** Rapor bölümü (flightsim_report.js reportBody içinden; h = ui.js h). */
export function servoSection(sum, tr, h) {
  const S = sum?.servo_trigger; if (!S) return null;
  const kv = (k, v, cls = '') => h('div', { class: `fs-rp-kv ${cls}` }, h('span', null, k), h('b', null, v));
  const tile = (label, value, unit, cls = '') => h('div', { class: `fs-rp-tile ${cls}` }, h('b', null, value, unit ? h('i', null, unit) : null), h('span', null, label));
  const t = S.trigger, c = S.hit;
  const an = (p, label, cls) => (p ? [
    h('h5', { class: `fs-rp-srv-h ${cls}` }, label),
    kv(tr('İrtifa (AGL)'), `${f1(p.agl)} m${p.agl_src === 'terrain' ? ` · ${tr('arazi üstü')}` : ` · ${tr('ev seviyesine göre')}`}`),
    kv(tr('İrtifa (MSL)'), `${f1(p.alt_msl)} m`),
    kv(tr('Evden yatay mesafe'), `${f1(p.dist_home_m)} m`),
    kv(tr('Konum'), ll(p)),
    kv(tr('Hava / yer hızı'), `${f1(p.airspeed)} / ${f1(p.groundspeed)} m/s · ${tr('yön')} ${f0(p.heading)}°`),
    kv(tr('Uçuş süresi'), p.flight_s != null ? `${f1(p.flight_s)} sn` : '—'),
    kv(tr('Mod'), p.mode || '—'),
  ] : null);
  return h('div', { class: 'fs-rp-sec fs-rp-servo' }, h('h4', null, '⚡ ', tr('Servo tetik')),
    h('div', { class: 'fs-rp-tiles fs-rp-srv-tiles' },
      tile(tr('Tetik irtifası (AGL)'), f1(t?.agl), 'm', t ? 'orange' : ''),
      tile(tr('Tetik — evden'), f0(t?.dist_home_m), 'm'),
      tile(tr('Çarpma irtifası (AGL)'), f1(c?.agl), 'm', c ? 'red' : ''),
      tile(tr('Çarpma — evden'), f0(c?.dist_home_m), 'm')),
    kv(tr('Kanal'), `S${S.ch}${S.fn_name ? ` · ${S.fn_name}` : ''}${S.payload ? ` / ${tr('Yük')}` : ''}`),
    kv(tr('Koşul / görülen PWM'), `${condText(S)} · ${S.seen_pwm != null ? `${S.seen_pwm} µs` : '—'}`),
    kv(tr('Gecikme'), `${S.delay_ms} ms ${tr('(simülasyon zamanı)')}${c?.delay_sim_ms != null ? ` · ${tr('ölçülen')} ${c.delay_sim_ms} ms` : ''}${c?.delay_wall_ms != null ? ` · ${tr('gerçek')} ${c.delay_wall_ms} ms` : ''}`),
    t ? null : h('div', { class: 'small muted' }, tr('Tetik gelmedi (dinleme sürdü)')),
    h('div', { class: 'fs-rp-srv-cols' }, h('div', null, an(t, tr('Tetik anı (komutun geldiği an)'), 'orange')), h('div', null, an(c, tr('Çarpma anı'), 'red'))));
}

// ---------------- alt bant bileşeni ----------------
function el(tag, attrs, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') e.className = v; else if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2), v); else e.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat(Infinity)) if (c != null && c !== false) e.append(c.nodeType ? c : document.createTextNode(String(c)));
  return e;
}
const CSS = `
.fs-srv{display:inline-flex;align-items:center;position:relative}
.fs-srv-btn{display:inline-flex;align-items:center;gap:6px;font-weight:700}
.fs-srv-btn svg{flex:none;opacity:.9}
.fs-bar .fs-srv[data-phase=listening] .fs-srv-btn,.fs-bar .fs-srv[data-phase=pending] .fs-srv-btn{background:#dc2626;border-color:#dc2626;color:#fff;animation:fs-srv-pulse 1s ease-in-out infinite}
.fs-bar .fs-srv[data-phase=pending] .fs-srv-btn{animation-duration:.35s}
.fs-bar .fs-srv[data-phase=fired] .fs-srv-btn{background:#7f1d1d;border-color:#7f1d1d;color:#fecaca}
@keyframes fs-srv-pulse{0%,100%{background:#dc2626;box-shadow:0 0 0 0 rgba(239,68,68,.65)}50%{background:#7f1d1d;box-shadow:0 0 0 6px rgba(239,68,68,0)}}
@media (prefers-reduced-motion:reduce){.fs-bar .fs-srv .fs-srv-btn{animation:none!important}}
.fs-srv-pop{position:absolute;bottom:calc(100% + 10px);left:0;z-index:40;width:max-content;min-width:260px;max-width:min(92vw,360px);padding:10px 12px 12px;border-radius:12px;
  background:rgba(14,20,30,.97);color:#e6edf3;border:1px solid rgba(255,255,255,.14);box-shadow:0 18px 44px rgba(0,0,0,.55);backdrop-filter:blur(6px);display:grid;gap:8px;font-size:12px}
.fs-srv-pop[hidden]{display:none}
.fs-srv-pop::after{content:'';position:absolute;left:var(--fs-srv-arrow,28px);bottom:-6px;width:10px;height:10px;background:inherit;border-right:1px solid rgba(255,255,255,.14);border-bottom:1px solid rgba(255,255,255,.14);transform:rotate(45deg)}
.fs-srv-pop h6{margin:0;display:flex;align-items:center;gap:8px;font:800 10.5px/1 ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.1em;text-transform:uppercase;opacity:.8}
.fs-srv-pop h6 span{flex:1}
.fs-srv-pop .fs-srv-x{border:0;background:transparent;color:inherit;opacity:.7;cursor:pointer;font-size:16px;line-height:1;padding:0 2px}
.fs-srv-pop .fs-srv-x:hover{opacity:1}
.fs-srv-row{display:grid;grid-template-columns:78px 1fr;align-items:center;gap:8px}
.fs-srv-row>span{opacity:.75}
.fs-srv-row>div{display:flex;align-items:center;gap:6px;min-width:0}
.fs-srv-pop select,.fs-srv-pop input{height:30px;border-radius:8px;border:1px solid rgba(255,255,255,.14);background:rgba(255,255,255,.07);color:#e6edf3;font:600 12.5px/1 system-ui,sans-serif;padding:0 8px;min-width:0}
.fs-srv-pop select{flex:1}
.fs-srv-pop select option{color:#111}
.fs-srv-pop .fs-srv-cmp{flex:0 0 56px}
.fs-srv-pop input{width:84px;text-align:right;font-variant-numeric:tabular-nums}
.fs-srv-pop select:disabled,.fs-srv-pop input:disabled{opacity:.6}
.fs-srv-pop i{font-style:normal;opacity:.6;font-size:11px}
.fs-srv-live{display:inline-flex;align-items:center;gap:6px;font:700 13px/1 ui-monospace,SFMono-Regular,Menlo,monospace}
.fs-srv-dot{width:9px;height:9px;border-radius:50%;background:#64748b;flex:none}
.fs-srv[data-phase=listening] .fs-srv-dot{background:#ef4444;animation:fs-srv-blink 1s steps(2,start) infinite;box-shadow:0 0 8px #ef4444}
.fs-srv[data-phase=pending] .fs-srv-dot{background:#f59e0b;animation:fs-srv-blink .3s steps(2,start) infinite}
.fs-srv[data-phase=fired] .fs-srv-dot{background:#dc2626}
.fs-srv[data-phase=listening] .fs-srv-live{color:#fca5a5}
.fs-srv .fs-srv-live.hit{color:#fde047}
.fs-srv-act{height:34px;border-radius:9px;border:1px solid #1f6feb;background:#1f6feb;color:#fff;font:700 13px/1 system-ui,sans-serif;cursor:pointer}
.fs-srv-act:hover{filter:brightness(1.1)}
.fs-srv-act.stop{background:#dc2626;border-color:#dc2626}
.fs-srv-act:disabled{opacity:.55;cursor:default}
.fs-bar:has(.fs-srv-pop:not([hidden])){z-index:9}
@keyframes fs-srv-blink{to{visibility:hidden}}
.fs-srv-banner{position:absolute;left:50%;top:104px;transform:translateX(-50%);z-index:8;pointer-events:none;display:flex;flex-direction:column;align-items:center;gap:2px;
  padding:7px 16px;border-radius:10px;background:rgba(60,8,8,.86);border:1px solid rgba(248,113,113,.8);color:#fecaca;font:800 14px/1.1 ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.06em;box-shadow:0 8px 24px rgba(0,0,0,.45)}
.fs-srv-banner small{font:600 11px/1.2 system-ui,sans-serif;letter-spacing:0;color:#fee2e2}
.fs-srv-banner[hidden]{display:none}
.fs-rp-srv-cols{display:grid;grid-template-columns:1fr 1fr;gap:10px}
.fs-rp-srv-h{margin:8px 0 4px;font-size:12px}.fs-rp-srv-h.orange{color:#d97706}.fs-rp-srv-h.red{color:#dc2626}
@media (max-width:700px){.fs-rp-srv-cols{grid-template-columns:1fr}}
.fs-rp-legend .st::before{background:#f59e0b;border-radius:0;clip-path:polygon(50% 0,100% 100%,0 100%)}.fs-rp-legend .sh::before{background:#ef4444;clip-path:polygon(50% 0,61% 35%,98% 35%,68% 57%,79% 91%,50% 70%,21% 91%,32% 57%,2% 35%,39% 35%)}
.fs-rp-tile.orange b{color:#d97706}
`;
function ensureCss() {
  if (typeof document === 'undefined' || document.getElementById('fs-srv-css')) return;
  const s = document.createElement('style'); s.id = 'fs-srv-css'; s.textContent = CSS; document.head.appendChild(s);
}
export function ensureServoCss() { ensureCss(); }

const PREF = 'fs.srvtrig', PREF_DRONE = 'fs.srvtrig.byDrone';
const readJson = (st, k) => { try { return JSON.parse(st?.getItem(k) || 'null'); } catch { return null; } };
// Servo simgesi (gövde + çıkış mili + kol); düğmede metnin solunda
const SERVO_ICON_SVG = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="9" width="14" height="10" rx="1.5"/><path d="M1.5 12h1.5M17 12h1.5"/><circle cx="8" cy="9" r="2.4"/><path d="M8 9 19.5 4.5"/><circle cx="19.5" cy="4.5" r="1"/></svg>';
/** Alt bant düğmesinin metin anahtarı (aşama → srv.*): boşta "Dinle", dinlerken "Dinleniyor", gecikme sürerken "Tetiklendi", çarpınca "ÇARPMA". */
export const srvBtnKey = phase => (phase === 'listening' ? 'srv.listening' : phase === 'pending' ? 'srv.trig' : phase === 'fired' ? 'srv.fired' : 'srv.listen');
/** Popover eylem düğmesi anahtarı: dinlemiyorken "Dinlemeye başla", dinlerken "Dinlemeyi durdur". */
export const srvActKey = phase => (phase === 'listening' || phase === 'pending' ? 'srv.stop_l' : 'srv.start');

// Alt bantta TEK "Dinle" düğmesi (servo simgeli); basınca düğmenin ÜSTÜNDE yukarı açılan panel (kanal · koşul · PWM eşiği [± tolerans] · gecikme ·
// canlı PWM · Dinlemeye başla / Dinlemeyi durdur). Dinleme başlayınca panel kapanır, düğme kırmızı yanıp söner ("Dinleniyor"). Dışarı tıklama / Esc kapatır.
export function createServoTrigger({ tr, keyed = false, cmd, onEvent = () => {}, session = null, droneId = null, stage = null, storage = (typeof localStorage !== 'undefined' ? localStorage : null), btnClass = 'btn sm', inputClass = 'input sm' } = {}) {
  ensureCss();
  const T = makeSrvT(tr, keyed);
  const st0 = session?.servo_trigger || {};
  let fn = Array.isArray(st0.fn) ? [...st0.fn] : Array(16).fill(null);
  let cfg = pickInitial({ stored: readJson(storage, PREF), byDrone: readJson(storage, PREF_DRONE), droneId, suggest: st0.suggest });
  let phase = st0.phase || 'idle', tele = null, trig = st0.trigger || null, hit = st0.hit || null, busy = false;
  if (st0.on && st0.ch) cfg = normalizeCfg(st0);   // sayfa yenilendi / ikinci izleyici: sunucudaki etkin ayar
  void inputClass;
  const chSel = el('select', { class: 'fs-srv-ch', title: T('srv.ch_t'), 'aria-label': T('srv.ch_t'), onchange: () => { cfg.ch = Number(chSel.value); save(); paint(); } });
  const cmpSel = el('select', { class: 'fs-srv-cmp', title: T('srv.cmp_t'), 'aria-label': T('srv.cmp_t'), onchange: () => { cfg.cmp = cmpSel.value; save(); paint(); } },
    Object.entries(CMP_SIGN).map(([k, s]) => el('option', { value: k }, s)));
  const num = (key, lim, title) => {
    const inp = el('input', { class: `fs-srv-${key.replace('_ms', '')}`, type: 'number', min: lim[0], max: lim[1], step: 1, title, 'aria-label': title,
      onchange: () => { cfg[key] = clampInt(inp.value, lim, cfg[key]); inp.value = String(cfg[key]); save(); paint(); } });
    inp.addEventListener('keydown', e => { e.stopPropagation(); if (e.key === 'Enter') { e.preventDefault(); inp.blur(); } });   // rakamlar kamera kısayollarına (1–5) gitmesin
    return inp;
  };
  const pwmInp = num('pwm', LIMITS.pwm, T('srv.pwm_t'));
  const tolInp = num('tol', LIMITS.tol, T('srv.tol_t'));
  const delayInp = num('delay_ms', LIMITS.delay_ms, T('srv.delay_t'));
  const row = (label, title, ...kids) => el('label', { class: 'fs-srv-row', title }, el('span', null, label), el('div', null, kids));
  const tolRow = row(T('srv.tol'), T('srv.tol_t'), tolInp, el('i', null, '± µs'));
  const dot = el('i', { class: 'fs-srv-dot' });
  const liveTxt = el('b', null, '—');
  const live = el('span', { class: 'fs-srv-live', title: T('srv.title_t') }, dot, liveTxt);
  const btnTxt = el('span', { class: 'fs-srv-btn-txt' }, T('srv.listen'));
  const btnIco = el('span', { class: 'fs-srv-ico', 'aria-hidden': 'true' }); btnIco.innerHTML = SERVO_ICON_SVG;
  const btn = el('button', { class: `${btnClass} fs-srv-btn`, type: 'button', title: T('srv.btn_t'), 'aria-haspopup': 'dialog', 'aria-expanded': 'false',
    onclick: e => { e.stopPropagation(); setOpen(pop.hidden); } }, btnIco, btnTxt);
  const actBtn = el('button', { class: 'fs-srv-act', type: 'button', title: T('srv.listen_t'), onclick: e => { e.stopPropagation(); toggle(); } }, T('srv.start'));
  const pop = el('div', { class: 'fs-srv-pop', role: 'dialog', 'aria-label': T('srv.title'), hidden: true },
    el('h6', null, btnIco.cloneNode(true), el('span', null, T('srv.title')), el('button', { class: 'fs-srv-x', type: 'button', title: T('srv.close'), 'aria-label': T('srv.close'), onclick: e => { e.stopPropagation(); setOpen(false); } }, '×')),
    row(T('srv.ch'), T('srv.ch_t'), chSel),
    row(T('srv.cmp'), T('srv.cmp_t'), cmpSel, pwmInp, el('i', null, 'µs')),
    tolRow,
    row(T('srv.delay'), T('srv.delay_t'), delayInp, el('i', null, 'ms')),
    el('div', { class: 'fs-srv-row' }, el('span', null, T('srv.live')), el('div', null, live)),
    actBtn);
  const root = el('div', { class: 'pill-group fs-srv', title: T('srv.title_t'), 'data-phase': phase }, btn, pop);
  pop.addEventListener('click', e => e.stopPropagation());
  // Panel taşmasın (dar ekran): açılınca görüntü alanına sığacak biçimde yatay kaydır; ok düğmenin ortasını gösterir
  function place() {
    pop.style.left = '0px';
    if (typeof window === 'undefined' || !pop.getBoundingClientRect) return;
    const r = pop.getBoundingClientRect(), W = window.innerWidth || document.documentElement.clientWidth || 0, b = btn.getBoundingClientRect();
    let dx = 0;
    if (r.right > W - 8) dx = W - 8 - r.right;
    if (r.left + dx < 8) dx = 8 - r.left;
    pop.style.left = `${Math.round(dx)}px`;
    pop.style.setProperty('--fs-srv-arrow', `${Math.round(Math.min(Math.max(b.left + b.width / 2 - (r.left + dx) - 5, 12), r.width - 22))}px`);
  }
  function setOpen(v) {
    pop.hidden = !v; btn.setAttribute('aria-expanded', v ? 'true' : 'false');
    if (v) { paint(); place(); }
  }
  const banner = el('div', { class: 'fs-srv-banner', hidden: true }, el('span'), el('small'));
  stage?.append(banner);
  const fillChannels = () => {
    const cur = cfg.ch;
    chSel.replaceChildren(...Array.from({ length: 16 }, (_, i) => el('option', { value: i + 1 }, `S${chanLabel(i + 1, fn[i], T)}`)));
    chSel.value = String(cur);
  };
  function save() {
    try {
      storage?.setItem(PREF, JSON.stringify(cfg));
      if (droneId != null) { const m = readJson(storage, PREF_DRONE) || {}; m[String(droneId)] = cfg; storage?.setItem(PREF_DRONE, JSON.stringify(m)); }
    } catch { /* depolama kapalı */ }
  }
  async function toggle() {
    if (busy || phase === 'fired') return;
    busy = true; paint();
    const on = !(phase === 'listening' || phase === 'pending');
    try {
      cfg = normalizeCfg({ ...cfg, pwm: pwmInp.value, tol: tolInp.value, delay_ms: delayInp.value });
      save();
      const r = await cmd('servo_trigger', on ? { on: true, ...cfg } : { on: false });
      const st = r?.servo_trigger || r?.result?.servo_trigger;
      phase = st?.phase || (on ? 'listening' : 'idle');
      onEvent(on ? T('srv.ev_on', { c: `S${cfg.ch} ${condText(cfg)} · ${cfg.delay_ms} ms` }) : T('srv.ev_off'), on ? 'warning' : 'info');
      if (on) setOpen(false);   // dinleme başladı: panel kapanır, alt banttaki düğme kırmızı yanıp söner
    } catch (e) { onEvent(T('srv.err', { e: e?.message || String(e) }), 'error'); }
    busy = false; paint();
  }
  function paint() {
    root.dataset.phase = phase;
    const lock = phase !== 'idle' || busy;
    for (const x of [chSel, cmpSel, pwmInp, tolInp, delayInp]) x.disabled = lock;
    tolRow.hidden = cfg.cmp !== 'eq';
    const act = typeof document !== 'undefined' ? document.activeElement : null;   // yazılan değer telemetri boyamasıyla ezilmesin
    if (act !== cmpSel) cmpSel.value = cfg.cmp;
    if (act !== pwmInp) pwmInp.value = String(cfg.pwm);
    if (act !== tolInp) tolInp.value = String(cfg.tol);
    if (act !== delayInp) delayInp.value = String(cfg.delay_ms);
    if (act !== chSel && chSel.value !== String(cfg.ch)) chSel.value = String(cfg.ch);
    const on = phase === 'listening' || phase === 'pending';
    btnTxt.textContent = T(srvBtnKey(phase));
    btn.classList.toggle('on', on);
    btn.title = on ? `${T('srv.listening')}: S${cfg.ch} ${condText(cfg)} · ${cfg.delay_ms} ms` : T('srv.btn_t');
    actBtn.textContent = T(srvActKey(phase));
    actBtn.classList.toggle('stop', on);
    actBtn.disabled = busy || phase === 'fired';
    const v = pwmFor(tele, cfg.ch);
    liveTxt.textContent = phase === 'fired' ? T('srv.fired') : v != null ? `${v} µs` : '— µs';
    const met = v != null && (cfg.cmp === 'ge' ? v >= cfg.pwm : cfg.cmp === 'le' ? v <= cfg.pwm : Math.abs(v - cfg.pwm) <= cfg.tol);
    live.classList.toggle('hit', met);
    banner.hidden = !(phase === 'pending' || phase === 'fired') || !trig;
    if (!banner.hidden) {
      banner.firstChild.textContent = phase === 'fired' ? `${T('srv.fired')} · S${cfg.ch}` : T('srv.banner', { ch: cfg.ch, pwm: trig.pwm ?? '—' });
      banner.lastChild.textContent = phase === 'fired' && hit ? T('srv.banner_hit', { agl: f1(hit.agl), dist: f0(hit.dist_home_m), tagl: f1(trig.agl) })
        : T('srv.banner_sub', { d: cfg.delay_ms, agl: f1(trig.agl), dist: f0(trig.dist_home_m) });
    }
  }
  // Panel dışına tıklama / Esc kapatır (Esc yakalama evresinde: oturumdan çıkış kısayoluna gitmez)
  const onDoc = e => { if (!pop.hidden && !root.contains(e.target)) setOpen(false); };
  const onEsc = e => { if (e.key === 'Escape' && !pop.hidden) { setOpen(false); e.preventDefault(); e.stopPropagation(); } };
  if (typeof document !== 'undefined') document.addEventListener('pointerdown', onDoc, true);
  if (typeof window !== 'undefined') window.addEventListener('keydown', onEsc, true);
  fillChannels(); paint();
  return {
    el: root, banner,
    get phase() { return phase; }, get cfg() { return { ...cfg }; },
    update(t) { tele = t || tele; paint(); },
    /** WS `{t:'servo_trigger', phase, …}` çerçevesi. Döner: phase. */
    onFrame(m) {
      if (Array.isArray(m.fn)) { fn = [...m.fn]; fillChannels(); }
      if (m.phase === 'fn') return phase;
      if (m.phase) phase = m.phase;
      if (m.ch && (m.on || m.phase === 'fired')) cfg = normalizeCfg({ ...cfg, ...Object.fromEntries(['ch', 'pwm', 'cmp', 'tol', 'delay_ms'].filter(k => m[k] != null).map(k => [k, m[k]])) });
      if (m.trigger) trig = m.trigger;
      if (m.hit) hit = m.hit;
      if (m.phase === 'fired') onEvent(T('srv.ev_fired'), 'error');
      paint();
      return phase;
    },
    open: () => setOpen(true), close: () => setOpen(false), get isOpen() { return !pop.hidden; },
    dispose() { document.removeEventListener('pointerdown', onDoc, true); window.removeEventListener('keydown', onEsc, true); root.remove(); banner.remove(); },
  };
}
