// Uçuş Simülatörü §42 — UÇUŞ UYARI SİSTEMİ arayüzü + sesi (HEPGO + SIMUMAV ortak). Saf değerlendirici: flightsim_gpws.js.
//
// • GÖRSEL: ekranın ortasının üstünde (HUD alanı) büyük uyarı kutusu — kırmızı WARNING / sarı CAUTION, onaylanmamışken yanıp söner; yanında
//   MASTER WARNING / MASTER CAUTION düğmeleri (glareshield lambası gibi; basınca o seviyedeki uyarıları onaylar: ses susar, koşul sürerse görsel kalır,
//   yeni uyarı gelince tekrar çalar; kısayol B); altında diğer etkin uyarılar (küçük çipler); WARNING'de ekran kenarında kırmızı nabız (vinyet).
//   FPV (pilot) ve gimbal (fpv) kiplerinde OSD/HUD açıksa büyük kutu gizlenir, aynı metni OSD/HUD kendi yazısıyla çizer (`osdText()`).
// • SES (Web Audio; dosya yok): WARNING kesik yükselen ton ("whoop whoop") ya da alarm, CAUTION çift çan, STALL çıngırak (stick shaker) +
//   konuşma (speechSynthesis; havacılık geleneği İngilizce, ayarda arayüz dili). Ses motor sesinin master kazancından geçer → genel ses kapalıysa,
//   sekme gizliyse, hızlı oynatmada uyarı sesi de yok (görsel kalır). WARNING onaylanana dek ~3,5 sn'de bir yinelenir; CAUTION bir kez.
// • AÇ/KAPA: ses kapsülü menüsünde "Uçuş uyarıları: Kapalı · Yalnız görsel · Görsel + ses" + ⚙ alt panel (dil, hassasiyet, yatış eşiği, tür tür
//   aç/kapa, Dene); sihirbazda `gpwsWizardField`. Tercih HEPGO localStorage `fs.gpws`, SIMUMAV `sm.gpws` (createGpwsPrefs).
// • KAYIT: açılan uyarı olay şeridine ("WARNING · PULL UP"); biten bölümler sunucuya `cmd gpws` (toplu, ~1,5 sn); Bitir'de flush (açık bölümler
//   kapatılır). Kayıttan oynatmada aynı değerlendirici telemetriden yeniden hesaplar (sunucuya gönderilmez; atlamada sıfırlanır).
// • RAPOR: `gpwsReportSection(alerts, {tr, keyed})` — tür başına adet / toplam süre / ilk görülme + uçuş disiplini puanı.

import {
  BANK_LIMITS, GPWS_BY_CODE, GPWS_CODES, alertEventSev, alertEventText, alertRows, alertSpeech, alertText, codeApplies, createGpws, createGpwsPrefs, makeGpwsT,
  modeKind, gpwsThresholds, teleInput, vehicleClass,
} from './flightsim_gpws.js';

const CSS = `
.fs-gpws{position:absolute;top:27%;left:50%;transform:translateX(-50%);z-index:9;display:flex;align-items:stretch;gap:10px;pointer-events:none;max-width:calc(100% - 24px)}
.fs-gpws[hidden]{display:none}
.fs-gpws-box{pointer-events:auto;cursor:pointer;min-width:220px;padding:8px 22px 9px;border-radius:8px;text-align:center;font:900 34px/1.05 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
  letter-spacing:.08em;color:#fff;border:3px solid #ff3b30;background:rgba(150,10,10,.88);box-shadow:0 0 0 2px rgba(0,0,0,.55),0 0 26px rgba(255,40,30,.55);text-shadow:0 2px 0 rgba(0,0,0,.5)}
.fs-gpws-box small{display:block;font:700 11px/1.3 system-ui,sans-serif;letter-spacing:.14em;opacity:.85;margin-bottom:2px}
.fs-gpws-box.caution{border-color:#ffc53d;background:rgba(120,82,0,.9);color:#fff7dc;box-shadow:0 0 0 2px rgba(0,0,0,.55),0 0 22px rgba(255,197,61,.45)}
.fs-gpws-box.blink{animation:fsGpwsBlink .8s steps(1) infinite}
.fs-gpws-box.caution.blink{animation-duration:1.1s}
@keyframes fsGpwsBlink{50%{background:rgba(20,0,0,.55);color:#ff6a60}}
.fs-gpws-box.caution.blink{animation-name:fsGpwsBlinkC}
@keyframes fsGpwsBlinkC{50%{background:rgba(25,18,0,.55);color:#ffc53d}}
.fs-gpws-mst{pointer-events:auto;cursor:pointer;width:86px;border-radius:7px;border:2px solid #5a1010;background:#2a0707;color:#7a3a3a;font:800 11px/1.15 system-ui,sans-serif;
  letter-spacing:.06em;text-align:center;padding:6px 4px;box-shadow:inset 0 0 0 1px rgba(255,255,255,.06),0 2px 6px rgba(0,0,0,.5)}
.fs-gpws-mst.c{border-color:#5a4210;background:#2a2107;color:#7a6a3a}
.fs-gpws-mst.lit{background:#d4161a;color:#fff;border-color:#ff8a80;box-shadow:0 0 18px rgba(255,40,30,.7),inset 0 0 6px rgba(255,255,255,.35)}
.fs-gpws-mst.c.lit{background:#e3a40c;color:#1d1300;border-color:#ffe08a;box-shadow:0 0 16px rgba(255,197,61,.7),inset 0 0 6px rgba(255,255,255,.35)}
.fs-gpws-mst.lit.blink{animation:fsGpwsMst .6s steps(1) infinite}
@keyframes fsGpwsMst{50%{filter:brightness(.45)}}
.fs-gpws-mst[hidden]{display:none}
.fs-gpws-more{position:absolute;top:100%;left:50%;transform:translateX(-50%);margin-top:6px;display:flex;gap:6px;flex-wrap:wrap;justify-content:center;width:max-content;max-width:90vw}
.fs-gpws-more span{font:800 11px/1 ui-monospace,Menlo,monospace;letter-spacing:.06em;padding:4px 7px;border-radius:5px;background:rgba(120,10,10,.82);color:#fff;border:1px solid #ff6a60}
.fs-gpws-more span.caution{background:rgba(110,76,0,.85);border-color:#ffc53d;color:#fff4d0}
.fs-gpws-vig{position:absolute;inset:0;z-index:4;pointer-events:none;opacity:0;transition:opacity .25s;box-shadow:inset 0 0 90px 28px rgba(255,20,20,.55)}
.fs-gpws-vig.on{opacity:.75}
.fs-gpws-vig.pulse{animation:fsGpwsVig 1s ease-in-out infinite}
@keyframes fsGpwsVig{0%,100%{opacity:.25}50%{opacity:.95}}
.fs-gpws.hud .fs-gpws-box,.fs-gpws.hud .fs-gpws-more{display:none}
.fs-mob .fs-gpws{top:20%}.fs-mob .fs-gpws-box{font-size:22px;min-width:150px;padding:6px 12px}.fs-mob .fs-gpws-mst{width:64px;font-size:9px}
@media (max-width:700px){.fs-gpws{top:20%}.fs-gpws-box{font-size:22px;min-width:150px;padding:6px 12px}.fs-gpws-mst{width:64px;font-size:9px}}
@media (prefers-reduced-motion:reduce){.fs-gpws-box.blink,.fs-gpws-mst.lit.blink{animation-duration:2s}.fs-gpws-vig.pulse{animation:none;opacity:.6}}
.fs-gpws-cfg{position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);z-index:60;width:min(520px,calc(100% - 20px));max-height:calc(100% - 40px);overflow:auto;
  background:rgba(14,19,30,.97);color:#e8eefb;border:1px solid rgba(255,255,255,.16);border-radius:14px;box-shadow:0 18px 50px rgba(0,0,0,.55);padding:14px 16px;font:13px/1.4 system-ui,sans-serif}
.fs-gpws-cfg[hidden]{display:none}
.fs-gpws-cfg h3{margin:0 0 4px;font-size:16px}.fs-gpws-cfg h4{margin:12px 0 6px;font-size:12px;letter-spacing:.06em;text-transform:uppercase;opacity:.75}
.fs-gpws-cfg .desc{font-size:12px;opacity:.75;margin:0 0 8px}
.fs-gpws-cfg .row{display:flex;align-items:center;gap:8px;margin:6px 0;flex-wrap:wrap}.fs-gpws-cfg .row>span:first-child{min-width:140px;opacity:.85}
.fs-gpws-cfg .fs-gpws-sg{display:inline-flex;border:1px solid rgba(255,255,255,.22);border-radius:8px;overflow:hidden;background:rgba(255,255,255,.04)}
.fs-gpws-cfg .fs-gpws-sg button,.fs-gpws-seg button{background:transparent!important;color:#c9d4ea!important;border:0!important;border-radius:0!important;padding:5px 10px;font:600 12px system-ui,sans-serif;cursor:pointer;box-shadow:none!important}
.fs-gpws-cfg .fs-gpws-sg button.on,.fs-gpws-seg button.on{background:#2f6fed!important;color:#fff!important}
.fs-gpws-cfg .codes{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:3px 10px}
.fs-gpws-cfg .codes label{display:flex;gap:6px;align-items:center;font:700 11px ui-monospace,Menlo,monospace;letter-spacing:.03em}
.fs-gpws-cfg .codes label.w{color:#ff9a90}.fs-gpws-cfg .codes label.c{color:#ffd57a}.fs-gpws-cfg .codes label.na{opacity:.4}
.fs-gpws-cfg .foot{display:flex;justify-content:space-between;gap:8px;margin-top:12px}
.fs-gpws-cfg button.b{border:1px solid rgba(255,255,255,.25);background:rgba(255,255,255,.06);color:inherit;border-radius:8px;padding:6px 12px;cursor:pointer;font:600 12px system-ui,sans-serif}
.fs-gpws-cfg button.b.p{background:#2f6fed;border-color:#2f6fed;color:#fff}
.fs-gpws-row{display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-top:6px;padding-top:6px;border-top:1px solid rgba(255,255,255,.12)}
.fs-gpws-row>b{font:600 12px system-ui,sans-serif;margin-right:2px}
.fs-gpws-seg{display:inline-flex;border:1px solid rgba(255,255,255,.22);border-radius:7px;overflow:hidden}
.fs-gpws-seg button{padding:3px 7px;font-size:11px}
.fs-gpws-row .fs-gpws-gear{border:1px solid rgba(255,255,255,.22);background:transparent;color:inherit;border-radius:7px;padding:2px 7px;cursor:pointer}
.fs-rp-gpws .fs-gpws-score{display:inline-block;margin-left:6px;padding:1px 8px;border-radius:999px;font-weight:800}
.fs-rp-gpws .g-A,.fs-rp-gpws .g-B{background:#16a34a;color:#fff}.fs-rp-gpws .g-C{background:#d97706;color:#fff}.fs-rp-gpws .g-D,.fs-rp-gpws .g-F{background:#dc2626;color:#fff}
.fs-rp-gpws table{width:100%}.fs-rp-gpws td.w{color:#dc2626;font-weight:800}.fs-rp-gpws td.c{color:#b45309;font-weight:800}
.fs-gpws-wz{display:flex;flex-direction:column;gap:4px}
.fs-gpws-wz select{max-width:360px}
`;
function ensureCss() {
  if (typeof document === 'undefined' || document.getElementById('fs-gpws-css')) return;
  const s = document.createElement('style'); s.id = 'fs-gpws-css'; s.textContent = CSS; document.head.appendChild(s);
}
const el = (tag, cls, txt) => { const e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; };
const editable = e => e && (/^(INPUT|TEXTAREA|SELECT)$/.test(e.tagName) || e.isContentEditable);
const MODE_KEYS = [['off', 'gpws.mode_off'], ['visual', 'gpws.mode_visual'], ['full', 'gpws.mode_full']];

// ---------------------------------------------------------------- ses ----------------------------------------------------------------
const TERRAIN_FAMILY = new Set(['PULL_UP', 'TERRAIN', 'SINK_RATE']);
/** Ton dizisi süresi (sn) — konuşma bundan sonra başlar. */
export function toneKind(code) {
  const d = GPWS_BY_CODE[code];
  if (!d) return null;
  if (code === 'STALL') return 'shaker';
  if (d.level === 'caution') return 'chime';
  return TERRAIN_FAMILY.has(code) ? 'whoop' : 'alarm';
}
const TONE_LEN = { whoop: 0.9, alarm: 0.75, chime: 0.75, shaker: 1.2 };
function playTone(ctx, bus, kind) {
  const t0 = ctx.currentTime + 0.02;
  const env = (g, a, peak, d) => { g.gain.setValueAtTime(0.0001, a); g.gain.exponentialRampToValueAtTime(peak, a + 0.015); g.gain.setValueAtTime(peak, a + Math.max(0.02, d - 0.06)); g.gain.exponentialRampToValueAtTime(0.0001, a + d); };
  const osc = (type, f, a, d, peak, dest = bus) => { const o = ctx.createOscillator(), g = ctx.createGain(); o.type = type; o.frequency.setValueAtTime(f, a); o.connect(g).connect(dest); env(g, a, peak, d); o.start(a); o.stop(a + d + 0.05); return o; };
  if (kind === 'whoop') {   // "whoop whoop": iki yükselen süpürme (testere, alçak geçiren)
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 2600; lp.connect(bus);
    for (const a of [t0, t0 + 0.44]) { const o = osc('sawtooth', 320, a, 0.36, 0.32, lp); o.frequency.exponentialRampToValueAtTime(1150, a + 0.32); }
  } else if (kind === 'alarm') {   // master warning: hızlı iki tonlu alarm
    [880, 1180, 880, 1180].forEach((f, i) => osc('square', f, t0 + i * 0.18, 0.15, 0.13));
  } else if (kind === 'chime') {   // master caution: tek çift çan (sinüs + üst harmonik, üstel sönüm)
    for (const [a, f] of [[t0, 1319], [t0 + 0.28, 1047]]) {
      const g = ctx.createGain(); g.connect(bus); g.gain.setValueAtTime(0.0001, a); g.gain.exponentialRampToValueAtTime(0.32, a + 0.01); g.gain.exponentialRampToValueAtTime(0.0001, a + 0.7);
      for (const [m, v] of [[1, 1], [2.76, 0.35]]) { const o = ctx.createOscillator(), og = ctx.createGain(); o.type = 'sine'; o.frequency.value = f * m; og.gain.value = v; o.connect(og).connect(g); o.start(a); o.stop(a + 0.75); }
    }
  } else if (kind === 'shaker') {   // stick shaker: 18 Hz genlik modülasyonlu alçak gürültü + 36 Hz vızıltı
    const n = Math.floor(ctx.sampleRate * 1.3), buf = ctx.createBuffer(1, n, ctx.sampleRate), d = buf.getChannelData(0);
    let s = 987; for (let i = 0; i < n; i++) { s = (s * 1664525 + 1013904223) >>> 0; d[i] = s / 2147483648 - 1; }
    const src = ctx.createBufferSource(); src.buffer = buf;
    const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 140; bp.Q.value = 0.9;
    const am = ctx.createGain(); am.gain.value = 0.5;
    const lfo = ctx.createOscillator(), lg = ctx.createGain(); lfo.type = 'square'; lfo.frequency.value = 18; lg.gain.value = 0.5; lfo.connect(lg).connect(am.gain);
    const g = ctx.createGain(); env(g, t0, 0.9, 1.2);
    src.connect(bp).connect(am).connect(g).connect(bus); src.start(t0); src.stop(t0 + 1.25); lfo.start(t0); lfo.stop(t0 + 1.25);
    osc('square', 36, t0, 1.2, 0.08);
  }
  return TONE_LEN[kind] || 0.8;
}
function speak(text, lang, vol) {
  try {
    const ss = globalThis.speechSynthesis;
    if (!ss || typeof SpeechSynthesisUtterance === 'undefined' || !text) return false;
    const u = new SpeechSynthesisUtterance(text);
    u.lang = lang; u.rate = 1.08; u.pitch = 0.95; u.volume = Math.max(0.1, Math.min(1, vol));
    const vs = ss.getVoices?.() || [];
    const v = vs.find(x => x.lang?.toLowerCase().startsWith(lang.toLowerCase().slice(0, 2)) && /male|david|daniel|alex|george/i.test(x.name)) || vs.find(x => x.lang?.toLowerCase().startsWith(lang.toLowerCase().slice(0, 2)));
    if (v) u.voice = v;
    ss.cancel(); ss.speak(u);
    return true;
  } catch { return false; }
}
const stopSpeech = () => { try { globalThis.speechSynthesis?.cancel(); } catch { /* yok */ } };

// ---------------------------------------------------------------- denetleyici ----------------------------------------------------------------
/**
 * createGpwsCtl(stage, { tr, keyed, vehicle, getSim, audio, prefs | storage, replay, canWrite, send(params) → Promise, onEvent(text, sev),
 *   getCtx() → {crashed, phase, maxSpeed, fence, hudDraws}, uiLang() → 'tr'|'en'…, menuHost })
 * → { update(tele), tick(), seek(), ack(level?), flush() → Promise, summary(), osdText(), openSettings(), settingsRow(), state(), prefs, dispose() }
 */
export function createGpwsCtl(stage, o = {}) {
  ensureCss();
  const T = makeGpwsT(o.tr, o.keyed);
  const prefs = o.prefs || createGpwsPrefs(o.storage || null);
  const replay = !!o.replay, live = !replay && o.canWrite !== false && typeof o.send === 'function';
  const vc = vehicleClass(o.vehicle);
  let cfg = prefs.get();
  const g = createGpws({ vehicle: o.vehicle, cfg });
  const getCtx = () => { try { return o.getCtx?.() || {}; } catch { return {}; } };
  const uiLang = () => { try { return o.uiLang?.() || (typeof document !== 'undefined' ? document.documentElement.lang : '') || 'tr'; } catch { return 'tr'; } };
  // ---- DOM ----
  const wrap = el('div', 'fs-gpws'); wrap.hidden = true;
  const mW = el('button', 'fs-gpws-mst w'); mW.type = 'button';
  const mC = el('button', 'fs-gpws-mst c'); mC.type = 'button';
  const box = el('div', 'fs-gpws-box'); box.setAttribute('role', 'alert');
  const boxSub = el('small'), boxTxt = el('span');
  box.append(boxSub, boxTxt);
  const more = el('div', 'fs-gpws-more');
  const mid = el('div'); mid.style.position = 'relative'; mid.append(box, more);
  wrap.append(mW, mid, mC);
  const vig = el('div', 'fs-gpws-vig');
  stage.append(vig, wrap);
  const setMasterText = () => { mW.textContent = ''; mW.append(...T('gpws.master_warning').split(' ').flatMap((w, i) => (i ? [el('br'), w] : [w]))); mC.textContent = ''; mC.append(...T('gpws.master_caution').split(' ').flatMap((w, i) => (i ? [el('br'), w] : [w]))); mW.title = mC.title = box.title = T('gpws.ack_hint'); };
  setMasterText();
  mW.onclick = e => { e.stopPropagation(); ack('warning'); };
  mC.onclick = e => { e.stopPropagation(); ack('caution'); };
  box.onclick = e => { e.stopPropagation(); ack(); };
  // ---- durum ----
  let last = null, lastRes = { active: [], primary: null, fresh: [], ended: [] }, lastWall = 0, evalT = null, off = 0, lastPlay = 0, playCode = null, disposed = false;
  const queue = [];
  let sendTimer = 0, cfgSent = false, sending = Promise.resolve();
  let testUntil = 0, testCode = null;
  const soundOk = () => cfg.mode === 'full' && !!o.audio;   // kayıttan oynatmada da (≥ 2× hızda motor sesiyle birlikte susar)
  function play(code) {
    if (!soundOk() || !code) return;
    const ab = o.audio.alertBus?.();
    if (!ab) return;   // genel ses kapalı / etkileşim yok / sekme gizli / hızlı oynatma → yalnız görsel
    lastPlay = performance.now(); playCode = code;
    let dur = 0.8;
    try { dur = playTone(ab.ctx, ab.bus, toneKind(code)); } catch { /* Web Audio yok */ }
    const lang = cfg.lang === 'ui' ? uiLang() : 'en-US';
    const vol = (o.audio.prefs?.volume ?? 70) / 100;
    setTimeout(() => { if (!disposed && (testCode === code || lastRes.active.some(a => a.code === code && !a.acked))) speak(alertSpeech(code, cfg.lang, T, uiLang()), lang, vol); }, Math.round(dur * 1000));
  }
  function ack(level = null) {
    const n = g.ack(level);
    if (n || testUntil) { stopSpeech(); testUntil = 0; testCode = null; }
    render();
    return n;
  }
  const onKey = e => {
    if ((e.key !== 'b' && e.key !== 'B') || e.ctrlKey || e.metaKey || e.altKey || editable(document.activeElement) || !stage.isConnected) return;
    if (!lastRes.active.length && !testUntil) return;
    e.preventDefault(); ack();
  };
  window.addEventListener('keydown', onKey);

  // AGL + ileri bakış (3B arazisinden; yoksa telemetri): kapanma hızını arazi yükselmesiyle birlikte ölçer
  function terrainCtx(t) {
    const sim = o.getSim?.();
    if (!sim?.position || !sim.terrainHeight) return {};
    try {
      const p = sim.position(), h0 = sim.terrainHeight(p.x, p.y);
      if (!Number.isFinite(p.z) || !Number.isFinite(h0)) return {};
      const agl = p.z - h0;
      const kind = modeKind(vc, t.mode);
      const look = gpwsThresholds(vc, kind, cfg).look || 4;
      const ve = Number(t.ve) || 0, vn = Number(t.vn) || 0, vz = t.climb != null ? Number(t.climb) : -(Number(t.vd) || 0);
      let worst = 0;
      for (const k of [0.5, 1]) {
        const T2 = look * k, x = p.x + ve * T2, y = p.y + vn * T2, z = p.z + vz * T2, h = sim.terrainHeight(x, y);
        if (Number.isFinite(h)) worst = Math.max(worst, (agl - (z - h)) / k);
      }
      return { agl, aglAhead: agl - worst, distHome: Math.hypot(p.x, p.y) };
    } catch { return {}; }
  }
  function evaluate(t, extra = {}) {
    const c = getCtx();
    if (c.maxSpeed !== undefined) g.setMaxSpeed(c.maxSpeed);
    if (c.fence !== undefined) g.setFence(c.fence);
    const raw = teleInput(t, { ...terrainCtx(t), crashed: !!c.crashed, phase: c.phase ?? null, ...extra });
    // izlenen saat: telemetri saati + kayma (bağlantı kesikken yapay ilerleme; geri dönüşte küçük gerilemeyi yut — büyük gerileme = Sıfırla)
    let tt = raw.t + off;
    if (evalT != null && tt < evalT && evalT - tt < 3) { off += evalT - tt + 0.01; tt = raw.t + off; }
    if (extra.t != null) tt = extra.t;
    raw.t = tt; evalT = tt;
    const r = g.step(raw);
    lastRes = r;
    if (r.ended.length) { if (live) { queue.push(...r.ended); scheduleSend(); } }
    if (r.fresh.length) {
      const fr = r.active.filter(a => r.fresh.includes(a.code));
      for (const a of fr) o.onEvent?.(alertEventText(a.code, cfg.lang, T), alertEventSev(a.code));
      const top = fr[0];
      if (top && top.code === r.primary?.code) play(top.code);
      else if (top && r.primary?.acked) play(top.code);
    } else if (r.primary && !r.primary.acked && r.primary.level === 'warning' && performance.now() - lastPlay > 3600) play(r.primary.code);   // WARNING onaylanana dek yinelenir
    render();
    return r;
  }
  function update(t) {
    if (disposed || !t) return;
    last = t; lastWall = performance.now();
    if (cfg.mode === 'off') { if (lastRes.active.length) { lastRes = { active: [], primary: null, fresh: [], ended: [] }; render(); } return; }
    evaluate(t, { linkAge: replay ? null : 0 });
  }
  // Bağlantı izi: canlıda telemetri 1 sn'den uzun gelmezse yapay adım (LINK uyarısı; diğer uyarılar son kareyle sürer)
  const tick = () => {
    if (disposed) return;
    if (testUntil && performance.now() > testUntil) { testUntil = 0; testCode = null; render(); }   // "Dene" gösterimi bitti
    if (replay || !last || cfg.mode === 'off') return;
    const age = performance.now() - lastWall;
    if (age > 1000 && !(typeof document !== 'undefined' && document.hidden)) evaluate(last, { linkAge: age, t: (evalT ?? 0) + 0.25 });   // gizli sekmede zamanlayıcılar kısılır → bağlantı ölçülmez
  };
  const iv = setInterval(tick, 250);
  // ---- çizim ----
  const txt = code => alertText(code, cfg.lang, T);
  function view() {
    if (testUntil && performance.now() < testUntil) return { active: [{ code: testCode, level: GPWS_BY_CODE[testCode].level, acked: false }], primary: { code: testCode, level: GPWS_BY_CODE[testCode].level, acked: false } };
    return lastRes;
  }
  let renderKey = '';
  function render() {
    if (disposed) return;
    const v = view(), A = v.active || [], P = v.primary;
    const hud = !!getCtx().hudDraws;
    const key = `${cfg.mode}|${cfg.lang}|${hud}|${A.map(a => `${a.code}${a.acked ? '+' : ''}`).join(',')}`;
    if (key === renderKey) return;   // 50 Hz telemetride DOM yalnız değişince
    renderKey = key;
    const vis = cfg.mode !== 'off' && !!P;
    wrap.hidden = !vis;
    const hasW = A.some(a => a.level === 'warning'), hasC = A.some(a => a.level === 'caution');
    const unW = A.some(a => a.level === 'warning' && !a.acked), unC = A.some(a => a.level === 'caution' && !a.acked);
    vig.className = `fs-gpws-vig${vis && hasW ? ` on${unW ? ' pulse' : ''}` : ''}`;
    if (!vis) return;
    wrap.classList.toggle('hud', hud);
    box.className = `fs-gpws-box ${P.level === 'caution' ? 'caution' : ''} ${P.acked ? '' : 'blink'}`;
    boxSub.textContent = P.level === 'warning' ? 'WARNING' : 'CAUTION';
    boxTxt.textContent = txt(P.code);
    mW.hidden = !hasW; mC.hidden = !hasC;
    mW.className = `fs-gpws-mst w${hasW ? ' lit' : ''}${unW ? ' blink' : ''}`;
    mC.className = `fs-gpws-mst c${hasC ? ' lit' : ''}${unC ? ' blink' : ''}`;
    more.replaceChildren(...A.slice(1, 4).map(a => el('span', a.level, txt(a.code))));
  }
  // ---- sunucu ----
  function scheduleSend(ms = 1500) { clearTimeout(sendTimer); sendTimer = setTimeout(() => { sendNow(); }, ms); }
  // Kuyruk boşaltma: en çok 50'lik parçalar; ilk gönderimde (ve ayar değişince) {mode, off}; hata → 5 sn sonra yeniden (sunucu (kod, t0) ile tekilleştirir)
  async function drain() {
    while (!disposed && (queue.length || !cfgSent)) {
      const events = queue.splice(0, 50), params = { events };
      if (!cfgSent) params.cfg = { mode: cfg.mode, off: cfg.off };
      try { await o.send(params); cfgSent = true; } catch { queue.unshift(...events); scheduleSend(5000); return; }
    }
  }
  function sendNow() {
    if (!live) return Promise.resolve();
    clearTimeout(sendTimer);
    sending = sending.then(drain, drain);
    return sending;
  }
  const sendCfg = () => { if (!live) return; cfgSent = false; sendNow(); };
  if (live) setTimeout(() => { if (!disposed) sendCfg(); }, 300);   // oturum açılışında ayar → özet (uyarısız uçuş da puan alır)
  /** Bitir: açık bölümler kapatılır ve gönderilir (özet raporundan önce). */
  async function flush() {
    const ended = g.close(evalT);
    if (live) { queue.push(...ended); await sendNow(); }
    lastRes = { active: [], primary: null, fresh: [], ended: [] }; render();
  }
  function seek() { g.reset(); evalT = null; off = 0; lastRes = { active: [], primary: null, fresh: [], ended: [] }; stopSpeech(); render(); }
  // ---- ayarlar ----
  const unsub = prefs.onChange(c => { cfg = { ...c }; g.setCfg(cfg); if (cfg.mode === 'off') { lastRes = { active: [], primary: null, fresh: [], ended: [] }; stopSpeech(); } if (cfg.mode !== 'full') stopSpeech(); syncRows(); render(); sendCfg(); });
  const rows = new Set();
  function syncRows() { for (const r of rows) r.__sync?.(); }
  function seg(keys, get, set, cls = 'fs-gpws-sg') {
    const s = el('span', cls);
    const bs = keys.map(([k, lbl]) => { const b = el('button', null, T(lbl)); b.type = 'button'; b.onclick = e => { e.stopPropagation(); set(k); }; s.append(b); return [k, b]; });
    s.__sync = () => bs.forEach(([k, b]) => b.classList.toggle('on', get() === k));
    s.__sync();
    return s;
  }
  /** Ses kapsülü menüsü satırı: "Uçuş uyarıları  [Kapalı|Görsel|Görsel + ses] ⚙". */
  function settingsRow() {
    const r = el('div', 'fs-gpws-row');
    const s = seg(MODE_KEYS, () => cfg.mode, k => prefs.set({ mode: k }), 'fs-gpws-seg');
    const gear = el('button', 'fs-gpws-gear', '⚙'); gear.type = 'button'; gear.title = T('gpws.settings'); gear.onclick = e => { e.stopPropagation(); openSettings(); };
    r.append(el('b', null, T('gpws.title')), s, gear);
    r.__sync = () => s.__sync();
    rows.add(r);
    return r;
  }
  let panel = null;
  function openSettings() {
    if (panel) { panel.hidden = false; panel.__sync(); return panel; }
    panel = el('div', 'fs-gpws-cfg'); panel.setAttribute('role', 'dialog');
    panel.addEventListener('pointerdown', e => e.stopPropagation());
    panel.addEventListener('click', e => e.stopPropagation());
    const h3 = el('h3', null, `⚠ ${T('gpws.title')}`), desc = el('p', 'desc', T('gpws.desc'));
    const row = (label, ctl) => { const r = el('div', 'row'); r.append(el('span', null, label), ctl); return r; };
    const sMode = seg(MODE_KEYS, () => cfg.mode, k => prefs.set({ mode: k }));
    const sLang = seg([['aviation', 'gpws.lang_aviation'], ['ui', 'gpws.lang_ui']], () => cfg.lang, k => prefs.set({ lang: k }));
    const sSens = seg([['low', 'gpws.sens_low'], ['normal', 'gpws.sens_normal'], ['high', 'gpws.sens_high']], () => cfg.sens, k => prefs.set({ sens: k }));
    const kindNow = vc === 'plane' || vc === 'vtol' || vc === 'icept' ? 'plane' : 'copter';
    const bkey = kindNow === 'plane' ? 'bank_plane' : 'bank_copter';
    const bank = el('input'); bank.type = 'range'; [bank.min, bank.max] = BANK_LIMITS[kindNow].map(String); bank.step = '1';
    const bankOut = el('b', null, '');
    bank.oninput = () => { bankOut.textContent = `${bank.value}°`; };
    bank.onchange = () => prefs.set({ [bkey]: Number(bank.value) });
    const bankWrap = el('span'); bankWrap.style.cssText = 'display:inline-flex;gap:8px;align-items:center'; bankWrap.append(bank, bankOut);
    const codesW = el('div', 'codes'), codesC = el('div', 'codes');
    const boxes = GPWS_CODES.map(c => {
      const lab = el('label', `${c.level === 'warning' ? 'w' : 'c'}${codeApplies(c.code, vc) ? '' : ' na'}`);
      const cb = el('input'); cb.type = 'checkbox'; cb.onchange = () => prefs.toggleCode(c.code, cb.checked);
      lab.append(cb, alertText(c.code, cfg.lang, T));
      lab.title = codeApplies(c.code, vc) ? '' : '—';
      (c.level === 'warning' ? codesW : codesC).append(lab);
      return [c.code, cb, lab];
    });
    const test = el('button', 'b', `▶ ${T('gpws.test')}`); test.type = 'button';
    test.onclick = () => { const order = ['PULL_UP', 'BANK_ANGLE', 'STALL', 'TOO_LOW']; const c = order[(order.indexOf(testCode) + 1) % order.length]; testCode = c; testUntil = performance.now() + 3000; render(); if (cfg.mode === 'full') play(c); };
    const close = el('button', 'b p', T('gpws.close')); close.type = 'button'; close.onclick = () => { panel.hidden = true; };
    const foot = el('div', 'foot'); foot.append(test, close);
    panel.append(h3, desc, row(T('gpws.title'), sMode), row(T('gpws.lang'), sLang), row(T('gpws.sens'), sSens), row(T(kindNow === 'plane' ? 'gpws.bank_plane' : 'gpws.bank_copter'), bankWrap),
      el('h4', null, T('gpws.warnings')), codesW, el('h4', null, T('gpws.cautions')), codesC, foot);
    panel.__sync = () => {
      sMode.__sync(); sLang.__sync(); sSens.__sync(); bank.value = String(cfg[bkey]); bankOut.textContent = `${cfg[bkey]}°`;
      for (const [code, cb, lab] of boxes) { cb.checked = !cfg.off.includes(code); cb.disabled = !codeApplies(code, vc); lab.lastChild.textContent = alertText(code, cfg.lang, T); }
    };
    const r = { __sync: panel.__sync }; rows.add(r);
    panel.__sync();
    stage.append(panel);
    return panel;
  }
  if (o.menuHost) o.menuHost.append(settingsRow());
  // OSD / askeri HUD metni (FPV ve gimbal kiplerinde büyük kutu yerine)
  function osdText() {
    if (cfg.mode === 'off') return null;
    const v = view(), P = v.primary;
    if (!P) return null;
    const rest = (v.active || []).slice(1, 3).map(a => txt(a.code));
    return { text: txt(P.code), level: P.level, blink: !P.acked, more: rest.length ? rest.join(' · ') : '' };
  }
  const api = {
    update, tick, seek, ack, flush, openSettings, settingsRow, osdText, prefs, el: wrap,
    summary: () => g.summary(),
    episodes: () => g.episodes(),
    test: (code = 'PULL_UP', ms = 3000) => { testCode = code; testUntil = performance.now() + ms; render(); if (cfg.mode === 'full') play(code); },
    state: () => ({ mode: cfg.mode, lang: cfg.lang, active: (view().active || []).map(a => ({ code: a.code, level: a.level, acked: a.acked })), primary: view().primary?.code || null,
      shown: !wrap.hidden, hud: wrap.classList.contains('hud'), vignette: vig.className, queue: queue.length, episodes: g.episodes().length, playCode, lastPlayMs: lastPlay ? Math.round(performance.now() - lastPlay) : null, evalT }),
    dispose() {
      disposed = true; clearInterval(iv); clearTimeout(sendTimer); unsub(); stopSpeech();
      window.removeEventListener('keydown', onKey);
      wrap.remove(); vig.remove(); panel?.remove(); for (const r of rows) r.remove?.(); rows.clear();
    },
  };
  wrap.__gpws = api;   // teşhis (Playwright): document.querySelector('.fs-gpws').__gpws.state()
  return api;
}

// ---------------------------------------------------------------- sihirbaz + rapor ----------------------------------------------------------------
/** Sihirbaz satırı: "Uçuş uyarıları" seçici (Kapalı / Yalnız görsel / Görsel + ses) + açıklama. prefs: createGpwsPrefs(…). */
export function gpwsWizardField({ tr, keyed = false, prefs = null, storage = null } = {}) {
  ensureCss();
  const T = makeGpwsT(tr, keyed);
  const P = prefs || createGpwsPrefs(storage);
  const box = el('div', 'fs-gpws-wz fs-wz-sec');
  const h = el('h4', 'fs-wz-sec-h', `⚠ ${T('gpws.title')}`);
  const sel = el('select', 'input sm fs-gpws-wz-sel');
  for (const [k, lbl] of MODE_KEYS) { const op = el('option', null, T(lbl)); op.value = k; sel.append(op); }
  sel.value = P.get().mode;
  sel.onchange = () => P.set({ mode: sel.value });
  const hint = el('p', 'small muted', `${T('gpws.desc')} ${T('gpws.wizard_hint')}`);
  box.append(h, sel, hint);
  box.__sync = () => { sel.value = P.get().mode; };
  return box;
}
/** Rapor metni satırı: "Uçuş uyarıları: 2 kırmızı · 1 sarı · toplam 16 s · uçuş disiplini 72/100 (C)". */
export function gpwsReportLine(A, tr, keyed = false) {
  if (!A) return '';
  const T = makeGpwsT(tr, keyed);
  if (A.mode === 'off') return `${T('gpws.report')}: ${T('gpws.off_note')}`;
  return `${T('gpws.report')}: ${T('gpws.n_warn')} ${A.warnings} · ${T('gpws.n_caution')} ${A.cautions} · ${T('gpws.total')} ${Number(A.total_s || 0).toFixed(1)} s · ${T('gpws.discipline')} ${A.score ?? '—'}/100${A.grade ? ` (${A.grade})` : ''}`;
}
/** Rapor bölümü (HEPGO özet raporu + SIMUMAV uçuş özeti kartı). alerts: özet (summary.alerts) ya da null. */
export function gpwsReportSection(A, { tr, keyed = false, lang = 'aviation', cls = 'fs-rp-sec fs-rp-gpws' } = {}) {
  if (!A || typeof document === 'undefined') return null;
  ensureCss();
  const T = makeGpwsT(tr, keyed);
  const sec = el('div', cls);
  const head = el('h4', null, `⚠ ${T('gpws.report')} · ${T('gpws.discipline')}`);
  if (A.score != null) { const sc = el('span', `fs-gpws-score g-${A.grade}`, `${A.score}/100 · ${A.grade}`); head.append(sc); }
  sec.append(head);
  if (A.mode === 'off') { sec.append(el('div', 'small muted', T('gpws.off_note'))); return sec; }
  const tiles = el('div', 'fs-rp-tiles fs-rp-gpws-tiles');
  const tile = (label, value, extra = '') => { const t = el('div', `fs-rp-tile ${extra}`); t.append(el('b', null, value), el('span', null, label)); return t; };
  tiles.append(tile(T('gpws.n_warn'), String(A.warnings ?? 0), A.warnings ? 'red' : 'green'), tile(T('gpws.n_caution'), String(A.cautions ?? 0), A.cautions ? 'orange' : ''),
    tile(T('gpws.total'), `${Number(A.total_s || 0).toFixed(1)} s`), tile(T('gpws.discipline'), A.score != null ? `${A.score}` : '—', A.score >= 75 ? 'green' : A.score >= 60 ? 'orange' : 'red'));
  sec.append(tiles);
  const rows = alertRows(A, T, lang);
  if (!rows.length) sec.append(el('div', 'small fs-gpws-clean', `✓ ${T('gpws.no_alerts')}`));
  else {
    const tb = el('table', 'table compact fs-rp-gpws-t'), th = el('thead'), tr0 = el('tr');
    for (const k of ['gpws.col_type', 'gpws.col_n', 'gpws.col_total', 'gpws.col_first']) tr0.append(el('th', null, T(k)));
    th.append(tr0); tb.append(th);
    const tbody = el('tbody');
    for (const r of rows) { const trr = el('tr'); trr.append(el('td', r.level === 'warning' ? 'w' : 'c', `${r.level === 'warning' ? '■' : '▲'} ${r.text}`), el('td', null, String(r.n)), el('td', null, r.total), el('td', null, r.first)); tbody.append(trr); }
    tb.append(tbody); sec.append(tb);
  }
  if (A.off?.length) sec.append(el('div', 'small muted', T('gpws.disabled_n', { n: A.off.length })));
  return sec;
}
