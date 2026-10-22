// Uçuş Simülatörü §40 — Hedefli uçuşta BOŞLUK ile KİLİT + ANGAJMAN (HEPGO + SIMUMAV ortak). Saf katman (node testi tests/test_flightsim_engage.mjs) +
// DOM denetleyicisi (createEngageCtl). Kapsam: yalnız simülasyon içi oyun mekaniği (HUD kilidi, süre, sonuç, puan) — araca güdüm/takip komutu YOK.
//
// • Görünürlük: §24.5 sembolojisinin (flightsim_tgthud.symbology) SON render edilen ana kamera için hesapladığı kutu ekranda mı (`on`). Kamera kipi fark
//   etmez: gimbal/FPV'de HUD/OSD TD kutusu çizer; takip/serbest/yer kiplerinde (ya da HUD kapalıyken) bu modülün kaplama tuvali aday/kilitli hedefin
//   TD kutusunu çizer → "kutu ekranda" her kipte gözle görülür.
// • Boşluk: kilit yokken → aday (HUD'un TD kutusundaki hedef ekrandaysa o, değilse boresight'a — ekran merkezine — en yakın görünür hedef) kilitlenir
//   (`cmd engage {action:'lock', i}`); kilitliyken → bırakılır (`release`). Aday yoksa: sanal kumanda kapalıysa kısa ipucu, açıksa Boşluk eski
//   davranışına (gaz orta / dur) geçer. Kayıttan oynatmada Boşluk oynat/duraklat kalır (bu modül dinlemez).
// • Angajman (sunucu otoriter: app/flightsim_targets.HedefIzleyici): kilit = başlangıç; kilitli hedef önlenince (önleme yarıçapı) BAŞARILI; kilit
//   bırakılınca ya da kilitli hedef ENGAGE_LOST_MS'den uzun görüş dışında kalınca (istemci ölçer → `release {reason:'lost'}`) KESİLDİ.
// • HUD: tgthud data.eng → TD kutusu çift çerçeve + "KİLİT"; angajman paneli (her kipte): KİLİT · ad, süre, mesafe, kapanma hızı Vc, hedef açısı
//   (burun yönünden yatay sapma, sağ +), ΔH; görüş dışıyken geri sayım.
// • Kayıttan oynatma: oturumun `engagements` listesi (t0 = SITL saati sn) kare `tt`'siyle eşlenir (setReplay / replayFrame) → kilit + panel + olaylar.

import { symbology, drawSymbology, closureRate, fmtRange } from './flightsim_tgthud.js';

export const ENGAGE_LOST_MS = 3000;
export const ENGAGE_TEXTS = [
  ['eng.lock', 'KİLİT'], ['eng.engagement', 'ANGAJMAN'], ['eng.success', 'ANGAJMAN BAŞARILI'], ['eng.cut', 'ANGAJMAN KESİLDİ'],
  ['eng.no_box', 'Kilit için bir hedefin kutusu ekranda olmalı'], ['eng.hint', 'Boşluk: kilit'], ['eng.release_hint', 'Boşluk: kilidi bırak'],
  ['eng.time', 'Süre'], ['eng.range', 'Mesafe'], ['eng.angle', 'Açı'], ['eng.lost_in', 'GÖRÜŞ DIŞI {s} sn'],
  ['eng.r_released', 'kilit bırakıldı'], ['eng.r_lost', 'hedef görüş dışında'], ['eng.r_reset', 'sıfırlandı'], ['eng.r_switched', 'hedef değişti'], ['eng.r_end', 'oturum bitti'],
  ['eng.r_intercept', 'önlendi'], ['eng.report', 'Angajmanlar'], ['eng.col_target', 'Hedef'], ['eng.col_start', 'Başlangıç'], ['eng.col_dur', 'Süre'],
  ['eng.col_result', 'Sonuç'], ['eng.col_min', 'En yakın'], ['eng.res_success', 'Başarılı'], ['eng.res_cut', 'Kesildi'], ['eng.res_active', 'Sürüyordu'],
  ['eng.bonus', 'Kilitli angajmanla önleme bonusu +{p}'], ['eng.rc_hint', 'Boşluk: hedef kutusu ekrandayken kilit / angajman'],
];
const TXT = Object.fromEntries(ENGAGE_TEXTS);
const fill = (s, p) => (p ? String(s).replace(/\{(\w+)\}/g, (m, k) => (p[k] != null ? String(p[k]) : m)) : String(s));
/** HEPGO (keyed=false): Türkçe metin anahtar; SIMUMAV (keyed=true): `eng.*` anahtarı, yoksa Türkçe. */
export const makeEngT = (tr, keyed = false) => (k, p) => {
  const tx = TXT[k] ?? k;
  if (!tr) return fill(tx, p);
  if (!keyed) return tr(tx, p);
  const r = tr(k, p);
  return r && r !== k ? r : fill(tx, p);
};

const DEG = 180 / Math.PI;
/** Kilit adayı: HUD'un kilitli (TD kutulu) hedefi ekrandaysa o; değilse ekranda görünen hedeflerden boresight'a (bx, by) en yakını; yoksa null. */
export function pickLockCandidate(sym, bx, by) {
  if (!sym?.items?.length) return null;
  if (sym.locked?.on) return sym.locked.i;
  let best = null, bd = Infinity;
  for (const r of sym.items) {
    if (!r.on) continue;
    const d = Math.hypot(r.x - bx, r.y - by);
    if (d < bd || (d === bd && best && r.dist < best.dist)) { bd = d; best = r; }
  }
  return best ? best.i : null;
}
/** Burun yönünden (heading, ° kuzeyden saat yönü) hedefe yatay sapma (°, −180…180, sağ +). d = hedef − oyuncu (ENU). */
export function bearingOff(hdgDeg, d) {
  if (Math.hypot(d[0], d[1]) < 1e-6) return 0;
  const brg = Math.atan2(d[0], d[1]) * DEG;
  return ((brg - Number(hdgDeg || 0)) % 360 + 540) % 360 - 180;
}
/** Kilitli hedefin ölçüleri (targetsHud verisinden): {dist, vc, ang, dz} ya da null. */
export function engageMetrics(data, i) {
  const it = data?.items?.find(r => r.i === i);
  if (!it) return null;
  const P = data.player?.pos || data.view?.pos || [0, 0, 0];
  const d = [it.center[0] - P[0], it.center[1] - P[1], it.center[2] - P[2]];
  return { dist: it.dist, vc: closureRate(d, it.vel || [0, 0, 0], data.player?.vel || [0, 0, 0]), ang: bearingOff(data.player?.hdg, d), dz: it.dz };
}
/** Boşluk kararı: 'release' | 'lock' | 'hint' | null (Boşluk eski davranışına geçer). */
export function spaceAction({ hasTargets, engaged, candidate, rcOn }) {
  if (!hasTargets) return null;
  if (engaged != null) return 'release';
  if (candidate != null) return 'lock';
  return rcOn ? null : 'hint';
}
/** Görüş dışı sayacı: see(now, visible) → true: ENGAGE_LOST_MS aşıldı (bir kez). */
export function createLostTimer(ms = ENGAGE_LOST_MS) {
  let since = null, fired = false;
  return {
    see(now, visible) {
      if (visible) { since = null; fired = false; return false; }
      if (since == null) since = now;
      if (!fired && now - since > ms) { fired = true; return true; }
      return false;
    },
    left(now) { return since == null ? null : Math.max(0, ms - (now - since)); },
    reset() { since = null; fired = false; },
  };
}
export const fmtDur = s => `${(Math.max(0, Number(s) || 0)).toFixed(1)} s`;
/** Kayıttan oynatma: tt anında etkin angajman (t0 ≤ tt < t0 + dur) ya da null. */
export function engagementAt(list, tt) {
  if (!Array.isArray(list) || tt == null) return null;
  for (const a of list) if (a.t0 <= tt && tt < a.t0 + (Number(a.dur_s) || 0) + 1e-6) return a;
  return null;
}
/** Kayıttan oynatma olayları: (prevTt, tt] aralığında başlayan / biten angajmanlar → [{kind:'start'|'success'|'cut', a}] (zaman sırasıyla). */
export function engagementEvents(list, prevTt, tt) {
  const out = [];
  if (!Array.isArray(list) || tt == null || prevTt == null || tt <= prevTt) return out;
  for (const a of list) {
    const end = a.t0 + (Number(a.dur_s) || 0);
    if (a.t0 > prevTt && a.t0 <= tt) out.push({ kind: 'start', at: a.t0, a });
    if (a.result !== 'active' && end > prevTt && end <= tt) out.push({ kind: a.result === 'success' ? 'success' : 'cut', at: end + 1e-6, a });
  }
  return out.sort((x, y) => x.at - y.at);
}

/** Özet rapor satırları (HEPGO raporu + SIMUMAV kartı): [{target, start, dur, result, cls, min}] — T = makeEngT(…). */
export function engagementRows(list, T) {
  const res = { success: ['eng.res_success', 'green'], cut: ['eng.res_cut', ''], active: ['eng.res_active', ''] };
  return (Array.isArray(list) ? list : []).map(a => {
    const [k, cls] = res[a.result] || res.cut;
    const why = a.result === 'cut' && a.reason ? ` · ${T(`eng.r_${a.reason}`)}` : '';
    return { target: `T${(a.i ?? 0) + 1} · ${a.name || ''}`, start: `${(Number(a.start_s) || 0).toFixed(1)} s`, dur: fmtDur(a.dur_s), result: `${T(k)}${why}`, cls,
      min: a.min_dist_m != null ? `${Math.round(a.min_dist_m)} m` : '—' };
  });
}

// ---------------------------------------------------------------- DOM ----------------------------------------------------------------
const CSS = `
.fs-eng-cv{position:absolute;inset:0;z-index:5;pointer-events:none}
.fs-eng{position:absolute;top:132px;left:50%;transform:translateX(-50%);z-index:7;pointer-events:none;min-width:250px;padding:7px 12px 8px;border-radius:10px;
  background:rgba(40,6,6,.72);border:1.5px solid #ff5a46;box-shadow:0 0 0 1px rgba(0,0,0,.4),0 0 18px rgba(255,90,70,.35);color:#ffe9e4;
  font:600 12px/1.25 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;text-align:center}
.fs-eng[hidden]{display:none}
.fs-eng b{display:block;font:800 13px/1.2 ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.12em;color:#ff8a78}
.fs-eng .fs-eng-row{display:flex;gap:12px;justify-content:center;margin-top:3px;white-space:nowrap}
.fs-eng .fs-eng-row span i{font-style:normal;opacity:.65;margin-right:3px}
.fs-eng .fs-eng-lost{color:#ffd23f;font-weight:800;margin-top:3px}
.fs-eng.ok{border-color:#4ade80;background:rgba(6,40,16,.75);box-shadow:0 0 18px rgba(74,222,128,.4)}.fs-eng.ok b{color:#86efac}
.fs-eng-tip{position:absolute;top:132px;left:50%;transform:translateX(-50%);z-index:7;pointer-events:none;padding:5px 10px;border-radius:8px;background:rgba(10,14,22,.85);
  color:#e6edf3;font:600 12px system-ui,sans-serif;border:1px solid rgba(255,255,255,.18)}
.fs-eng-tip[hidden]{display:none}
.fs-mob .fs-eng,.fs-mob .fs-eng-tip{top:62px}
`;
function ensureCss() {
  if (typeof document === 'undefined' || document.getElementById('fs-eng-css')) return;
  const s = document.createElement('style'); s.id = 'fs-eng-css'; s.textContent = CSS; document.head.appendChild(s);
}
const editable = el => el && (/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || el.isContentEditable);
// Kısa uyarı sesleri (Web Audio; ses dosyası yok): kilit (yükselen çift bip), başarı (üçlü), kesildi (alçalan)
let actx = null;
export function engageBeep(kind = 'lock') {
  try {
    actx ??= new (window.AudioContext || window.webkitAudioContext)();
    const seq = { lock: [[880, 0.07], [1320, 0.09]], success: [[988, 0.08], [1319, 0.08], [1760, 0.14]], cut: [[660, 0.1], [440, 0.16]], warn: [[1400, 0.06], [1400, 0.06]] }[kind] || [[880, 0.08]];
    let t = actx.currentTime + 0.01;
    for (const [f, d] of seq) {
      const o = actx.createOscillator(), g = actx.createGain();
      o.type = 'square'; o.frequency.value = f; g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.06, t + 0.01); g.gain.exponentialRampToValueAtTime(0.0001, t + d);
      o.connect(g).connect(actx.destination); o.start(t); o.stop(t + d + 0.02); t += d + 0.03;
    }
  } catch { /* ses yok */ }
}

/**
 * createEngageCtl(stage, { getSim, cmd(name, params) → Promise, tr, keyed, onEvent(text, sev), toast(text), isRcOn() → bool, replay, canWrite, sound })
 * → { onServer(m), onHello(engagement), toggle(), setReplay(list), replayFrame(tt), seek(), state(), dispose() }
 */
export function createEngageCtl(stage, o = {}) {
  ensureCss();
  const T = makeEngT(o.tr, o.keyed);
  const getSim = o.getSim || (() => null), replay = !!o.replay, live = !replay && o.canWrite !== false;
  const cv = document.createElement('canvas'); cv.className = 'fs-eng-cv'; stage.appendChild(cv);
  const g = cv.getContext('2d');
  const panel = document.createElement('div'); panel.className = 'fs-eng'; panel.hidden = true; stage.appendChild(panel);
  const tip = document.createElement('div'); tip.className = 'fs-eng-tip'; tip.hidden = true; stage.appendChild(tip);
  let W = 0, H = 0, dpr = 1, raf = 0, disposed = false, tipTimer = 0, busy = false;
  const S = { eng: null, cand: null, sym: null, data: null, visible: false, okUntil: 0, okText: '' };   // eng: {i, name, t0Wall, dur0}
  const lost = createLostTimer();
  let rep = { list: null, prevTt: null };
  const resize = () => {
    W = Math.max(1, stage.clientWidth); H = Math.max(1, stage.clientHeight); dpr = Math.min(globalThis.devicePixelRatio || 1, 2);
    cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr); cv.style.width = `${W}px`; cv.style.height = `${H}px`;
  };
  const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(resize) : null; ro?.observe(stage); resize();
  const showTip = (text, ms = 1600) => { tip.textContent = text; tip.hidden = false; clearTimeout(tipTimer); tipTimer = setTimeout(() => { tip.hidden = true; }, ms); };
  const ev = (text, sev = 'info') => o.onEvent?.(text, sev);
  const reasonText = r => T(`eng.r_${r || 'released'}`);
  const nameOf = i => S.data?.items?.find(r => r.i === i)?.name || `T${i + 1}`;

  function setEng(e) {
    S.eng = e; lost.reset();
    getSim()?.setEngaged?.(e ? e.i : null);
  }
  // Sunucu WS `engage` (canlı) ya da kayıttan oynatma olayı
  function onServer(m) {
    if (!m || !m.kind) return;
    const name = m.name || nameOf(m.i);
    if (m.kind === 'start') {
      setEng({ i: m.i, name, t0Wall: performance.now() - (Number(m.dur_s) || 0) * 1000, tt0: m.t0 });
      ev(`${T('eng.engagement')} · ${name}`, 'warning');
      if (o.sound !== false && !replay) engageBeep('lock');
    } else if (m.kind === 'success') {
      if (S.eng?.i === m.i) setEng(null);
      const txt = `${T('eng.success')} · ${name} · ${fmtDur(m.dur_s)}`;
      ev(txt, 'warning'); S.okUntil = performance.now() + 2500; S.okText = txt;
      if (!replay) { o.toast?.(`◆ ${txt}`); if (o.sound !== false) engageBeep('success'); o.sfx?.play('coin'); }   // §44 angajman bonusu: "coin"
    } else if (m.kind === 'cut') {
      if (S.eng?.i === m.i) setEng(null);
      ev(`${T('eng.cut')} · ${name} · ${fmtDur(m.dur_s)} · ${reasonText(m.reason)}`, 'info');
      if (o.sound !== false && !replay) engageBeep('cut');
    }
  }
  // Yeniden bağlanma: sunucunun etkin angajmanı (hello / oturum yanıtı `engagement`)
  function onHello(e) { if (e && e.i != null) setEng({ i: e.i, name: e.name, t0Wall: performance.now() - (Number(e.dur_s) || 0) * 1000, tt0: e.t0 }); else if (!e && S.eng) setEng(null); }

  async function send(params) {
    if (busy || !live || !o.cmd) return;
    busy = true;
    try { const r = await o.cmd('engage', params); if (r && r.ok === false) throw new Error(r.error || 'engage'); }
    catch (err) { o.toast?.(String(err?.message || err), 'err'); }
    finally { busy = false; }
  }
  function toggle() {
    if (!live) return false;
    const act = spaceAction({ hasTargets: !!S.data, engaged: S.eng?.i ?? null, candidate: S.cand, rcOn: true });
    if (act === 'release') { send({ action: 'release', reason: 'released' }); return true; }
    if (act === 'lock') { send({ action: 'lock', i: S.cand }); return true; }
    if (S.data) showTip(T('eng.no_box'));
    return false;
  }
  const onKey = e => {
    if (e.key !== ' ' && e.code !== 'Space') return;
    if (!live || e.ctrlKey || e.metaKey || e.altKey || editable(document.activeElement)) return;
    if (!stage.isConnected) return;
    const act = spaceAction({ hasTargets: !!S.data, engaged: S.eng?.i ?? null, candidate: S.cand, rcOn: !!o.isRcOn?.() });
    if (!act) return;   // eski davranış (sanal kumanda: gaz orta / dur)
    e.preventDefault(); e.stopImmediatePropagation();
    if (e.repeat) return;
    if (act === 'release') send({ action: 'release', reason: 'released' });
    else if (act === 'lock') send({ action: 'lock', i: S.cand });
    else showTip(T('eng.no_box'));
  };
  const onKeyUp = e => { if ((e.key === ' ' || e.code === 'Space') && live && S.data && (S.eng || S.cand != null)) e.stopImmediatePropagation(); };
  if (live) { window.addEventListener('keydown', onKey, true); window.addEventListener('keyup', onKeyUp, true); }

  const angTxt = a => `${a >= 0 ? 'R' : 'L'}${Math.abs(Math.round(a))}°`;
  function drawPanel(now) {
    if (S.eng) {
      const m = engageMetrics(S.data, S.eng.i);
      const dur = replay && S.eng.tt0 != null && S.tt != null ? S.tt - S.eng.tt0 : (now - S.eng.t0Wall) / 1000;
      const left = lost.left(now);
      panel.className = 'fs-eng';
      panel.replaceChildren(
        Object.assign(document.createElement('b'), { textContent: `◆ ${T('eng.lock')} · ${T('eng.engagement')} · T${S.eng.i + 1} ${S.eng.name || ''}`.trim() }),
        row([[T('eng.time'), fmtDur(dur)], [T('eng.range'), m ? fmtRange(m.dist) : '—'], ['Vc', m ? `${m.vc >= 0 ? '+' : '−'}${Math.abs(m.vc).toFixed(0)} m/s` : '—'],
          [T('eng.angle'), m ? angTxt(m.ang) : '—'], ['ΔH', m ? `${m.dz >= 0 ? '+' : '−'}${Math.abs(m.dz).toFixed(0)} m` : '—']]),
        ...(left != null && !replay ? [Object.assign(document.createElement('div'), { className: 'fs-eng-lost', textContent: T('eng.lost_in', { s: (left / 1000).toFixed(1) }) })] : []));
      panel.hidden = false;
    } else if (now < S.okUntil) {
      panel.className = 'fs-eng ok';
      panel.replaceChildren(Object.assign(document.createElement('b'), { textContent: `◆ ${S.okText}` }));
      panel.hidden = false;
    } else panel.hidden = true;
  }
  function row(cells) {
    const d = document.createElement('div'); d.className = 'fs-eng-row';
    for (const [k, v] of cells) { const s = document.createElement('span'); const i = document.createElement('i'); i.textContent = k; s.append(i, v); d.append(s); }
    return d;
  }
  function frame(fromTimer = false) {
    if (disposed) return;
    if (fromTimer !== true) raf = requestAnimationFrame(frame);
    const now = performance.now();
    const sim = getSim();
    const data = sim?.targetsHud?.({ peek: true }) || null;
    S.data = data;
    g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, W, H);
    if (!data) { S.cand = null; drawPanel(now); return; }
    const bx = W / 2, by = H / 2;
    const sym = symbology(data, W, H, { S: 1, bx, by });
    S.sym = sym;
    S.cand = S.eng ? null : pickLockCandidate(sym, bx, by);
    if (S.eng && !replay) {
      const it = sym.items.find(r => r.i === S.eng.i);
      if (lost.see(now, !!it?.on)) send({ action: 'release', reason: 'lost' });
    }
    // Kaplama: HUD/OSD sembolojiyi çizmiyorsa (takip/serbest/yer kipi ya da HUD kapalı) aday/kilitli hedefin TD kutusu
    const focus = S.eng ? S.eng.i : S.cand;
    S.drawn = false; S.frames = (S.frames || 0) + 1; S.cam = data.camMode;
    const hudCam = data.camMode === 'fpv' || data.camMode === 'pilot';   // gimbal HUD / FPV OSD kutuyu kendisi çizer (HUD kapalıysa da kaplama çizilmez)
    if (!data.hudFresh && !hudCam && focus != null) {
      S.drawn = true;
      const one = { ...data, sel: { i: focus, auto: false }, items: data.items.filter(r => r.i === focus) };
      const s2 = symbology(one, W, H, { S: 1, bx, by });
      drawSymbology(g, { ...s2, tll: S.eng ? s2.tll : null }, { color: S.eng ? '#ff6a55' : '#9cff6a', S: 1, W, H, tr: s => (s === 'KİLİT' ? T('eng.lock') : o.tr ? o.tr(s) : s), now });
      if (!S.eng && s2.locked?.on && s2.locked.td) {   // ipucu: kutunun altında "Boşluk: kilit"
        g.font = '600 11px system-ui,sans-serif'; g.textAlign = 'center'; g.textBaseline = 'top'; g.lineWidth = 3; g.strokeStyle = 'rgba(0,0,0,.8)';
        const tx = T('eng.hint'), x = (s2.locked.td.x0 + s2.locked.td.x1) / 2, y = s2.locked.td.y1 + 6;
        g.strokeText(tx, x, y); g.fillStyle = '#9cff6a'; g.fillText(tx, x, y);
      }
    }
    drawPanel(now);
  }
  raf = requestAnimationFrame(frame);
  const iv = setInterval(() => frame(true), 100);   // yavaş WebGL karelerinde (yazılım GL) de kaplama/panel güncel kalsın

  // ---- kayıttan oynatma ----
  function setReplay(list) { rep = { list: Array.isArray(list) ? list.slice().sort((a, b) => a.t0 - b.t0) : null, prevTt: null }; }
  function replayFrame(tt) {
    if (!rep.list || tt == null) return;
    S.tt = tt;
    for (const x of engagementEvents(rep.list, rep.prevTt, tt)) onServer({ ...x.a, kind: x.kind });
    const a = engagementAt(rep.list, tt);
    if (a && S.eng?.i !== a.i) setEng({ i: a.i, name: a.name, t0Wall: performance.now() - (tt - a.t0) * 1000, tt0: a.t0 });
    else if (!a && S.eng) setEng(null);
    rep.prevTt = tt;
  }
  function seek() { rep.prevTt = null; S.okUntil = 0; setEng(null); }

  const api = {
    onServer, onHello, toggle, setReplay, replayFrame, seek, el: panel, canvas: cv,
    state: () => ({ engaged: S.eng ? { ...S.eng } : null, candidate: S.cand, ok: performance.now() < S.okUntil, drawn: !!S.drawn, frames: S.frames || 0, cam: S.cam || null, visible: !!S.sym?.items?.find(r => r.i === S.eng?.i)?.on, hasTargets: !!S.data }),
    dispose() {
      disposed = true; cancelAnimationFrame(raf); clearInterval(iv); clearTimeout(tipTimer); ro?.disconnect();
      if (live) { window.removeEventListener('keydown', onKey, true); window.removeEventListener('keyup', onKeyUp, true); }
      cv.remove(); panel.remove(); tip.remove();
    },
  };
  cv.__eng = api;   // teşhis (Playwright): document.querySelector('.fs-eng-cv').__eng.state()
  return api;
}
