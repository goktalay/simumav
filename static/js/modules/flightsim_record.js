// Uçuş Simülatörü — ekran kaydı (§17): Başlat'tan Bitir'e ekran + ses MediaRecorder ile kaydedilir, parçalar oturum boyunca sunucuya akıtılır,
// Bitir'de kayıt Şirketten Haberler'e OTURUM SAHİBİ adına paylaşım olur. Sözleşme: docs/ucus-simulatoru.md §17.
// • Görüntü: (a) `getDisplayMedia` — gerçek ekran (panel/HUD DOM'u dahil; sekme seçimi kutusu Başlat tıklamasında, tam ekranda bir kez);
//   (b) yedek: 3B tuval + askeri HUD tuvali birleşik tuvale (render-sonrası kanca `sim.addFrameHook`) → `captureStream(30)` — izinsiz, DOM paneli kayda girmez.
//   Kullanıcı ekran paylaşımını reddederse (b)'ye düşülür ve bilgi verilir.
// • Ses: motor sesi Web Audio'dan (`audio.captureStream()`: master → MediaStreamAudioDestinationNode) + varsa ekran paylaşımı sistem sesi (o zaman motor
//   kaynağı eklenmez: aynı ses iki kez girmesin) + isteğe bağlı mikrofon (`fs.rec.mic`, varsayılan kapalı) — tek karışım bağlamında birleşir.
// • Biçim: webm vp9/opus → vp8/opus → webm → mp4 (Safari); 1280×720 hedef, 2,5 Mb/s; `timeslice` 10 sn. Parçalar sıralı (`seq`), ≤ 8 MB dilimler; ağ hatasında
//   üstel bekleme ile 5 deneme; 413 (sınır) → kayıt durur, uyarı. Blob'lar indirme yedeği için bellekte tutulur (≤ 600 MB).
// • Tercih: `fs.rec.on` (varsayılan AÇIK; kapalıysa Başlat'ta izin istenmez). Rozet `.fs-rec-badge` üst şeritte ("● KAYIT 03:21"), alt çubukta `.fs-rec-btn`.
// Dışa: REC_PREF_ON, REC_PREF_MIC, recPrefs, pickMime, acquireDisplayStream, stashStream/takeStashedStream, enterFullscreen/exitFullscreen,
//       createRecorder(stage, opts) → { start(), stop(), finishWithDialog(), abandon(), toggleBtn, get active, get seconds, get hasData, dispose() }, pendingCard(be, tr)

import { api } from '../api.js';
import { clear, h, modal, toast } from '../ui.js';

const API = '/api/drone/sim';
export const REC_PREF_ON = 'fs.rec.on', REC_PREF_MIC = 'fs.rec.mic', REC_PREF_SHARE = 'fs.rec.share', REC_PREF_BIN = 'fs.rec.bin';
export const CHUNK_MAX = 8 * 1024 * 1024;
export const TIMESLICE_MS = 10000;
export const TARGET = { width: 1280, height: 720, fps: 30, videoBps: 2500000, audioBps: 128000 };
export const KEEP_MAX = 600 * 1024 * 1024;   // indirme yedeği için bellekte tutulan en çok bayt
export const MIMES = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm;codecs=h264,opus', 'video/webm', 'video/mp4;codecs=avc1,mp4a.40.2', 'video/mp4'];

const ls = { get: k => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* */ } } };
export const recPrefs = {
  get on() { return ls.get(REC_PREF_ON) !== '0'; }, set on(v) { ls.set(REC_PREF_ON, v ? '1' : '0'); },
  get mic() { return ls.get(REC_PREF_MIC) === '1'; }, set mic(v) { ls.set(REC_PREF_MIC, v ? '1' : '0'); },
  // Kayıt seçenekleri (sihirbaz "Kayıt" kutusu): paylaş (varsayılan AÇIK; kapalıysa video sunucuda saklanır → "Kayıtlarım"), .bin uçuş logu (yalnız canlı SITL; varsayılan AÇIK)
  get share() { return ls.get(REC_PREF_SHARE) !== '0'; }, set share(v) { ls.set(REC_PREF_SHARE, v ? '1' : '0'); },
  get bin() { return ls.get(REC_PREF_BIN) !== '0'; }, set bin(v) { ls.set(REC_PREF_BIN, v ? '1' : '0'); },
};
export const clock = sec => { sec = Math.max(0, Math.floor(Number(sec) || 0)); const hh = Math.floor(sec / 3600), mm = Math.floor(sec % 3600 / 60), ss = sec % 60; return `${hh ? `${hh}:` : ''}${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`; };
export const fmtBytes = n => (n >= 1024 ** 3 ? `${(n / 1024 ** 3).toFixed(2)} GB` : n >= 1024 ** 2 ? `${(n / 1024 ** 2).toFixed(1)} MB` : `${Math.round(n / 1024)} KB`);

export function pickMime(MR = typeof MediaRecorder !== 'undefined' ? MediaRecorder : null) {
  if (!MR) return null;
  return MIMES.find(m => { try { return MR.isTypeSupported(m); } catch { return false; } }) || '';
}
export const recSupported = () => typeof MediaRecorder !== 'undefined' && typeof HTMLCanvasElement !== 'undefined' && !!HTMLCanvasElement.prototype.captureStream;

// ---------- tam ekran (belgeye; flightsim.js onFullChange body.fs-full'ü uygular) ----------
export function enterFullscreen() {
  try { if (!document.fullscreenElement) return Promise.resolve(document.documentElement.requestFullscreen?.()).catch(() => {}); } catch { /* reddedildi */ }
  return Promise.resolve();
}
export function exitFullscreen() {
  try { if (document.fullscreenElement) return Promise.resolve(document.exitFullscreen?.()).catch(() => {}); } catch { /* */ }
  return Promise.resolve();
}

// ---------- ekran paylaşımı: Başlat tıklaması İÇİNDE (kullanıcı etkinleştirmesi) ----------
let stashed = null;   // Başlat → oturum ekranı arası taşınan akış
export function stashStream(s) { stashed = s || null; }
export function takeStashedStream() { const s = stashed; stashed = null; if (s && s.getVideoTracks().every(t => t.readyState === 'ended')) return null; return s; }
export async function acquireDisplayStream() {
  if (!navigator.mediaDevices?.getDisplayMedia) return { stream: null, reason: 'unsupported' };
  try {
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: { ideal: TARGET.fps, max: 60 }, width: { ideal: TARGET.width }, height: { ideal: TARGET.height }, displaySurface: 'browser' },
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      preferCurrentTab: true, selfBrowserSurface: 'include', surfaceSwitching: 'exclude', systemAudio: 'include', monitorTypeSurfaces: 'include',
    });
    return { stream, reason: null };
  } catch (err) {
    return { stream: null, reason: err?.name === 'NotAllowedError' ? 'denied' : (err?.name || 'error') };
  }
}

// ---------- REST ----------
function restRec() {
  const raw = async (method, url, body, type) => {
    const res = await fetch(url, { method, body, credentials: 'same-origin', headers: { 'Content-Type': type } });
    let data = null; const txt = await res.text(); try { data = txt ? JSON.parse(txt) : null; } catch { data = txt; }
    if (!res.ok) { const e = new Error(data?.detail || `İstek başarısız (${res.status})`); e.status = res.status; throw e; }
    return data;
  };
  return {
    start: (sid, mime) => api.post(`${API}/sessions/${encodeURIComponent(sid)}/rec/start`, { mime }),
    chunk: (rid, seq, blob) => raw('PUT', `${API}/rec/${rid}/chunk?seq=${seq}`, blob, 'application/octet-stream'),
    thumb: (rid, blob) => raw('PUT', `${API}/rec/${rid}/thumb`, blob, 'image/png'),
    finish: (rid, body) => api.post(`${API}/rec/${rid}/finish`, body),
    share: rid => api.post(`${API}/rec/${rid}/share`, {}),
    del: rid => api.del(`${API}/rec/${rid}`),
    pending: () => api.get(`${API}/rec/pending`),
    mine: () => api.get(`${API}/rec/mine`),
    fileUrl: rid => `${API}/rec/${rid}/file`,
  };
}

// ======================================================================
// Kayıtçı
// opts: { sid, tr, getSim (3B: canvas, addFrameHook), getHudCanvas (askeri HUD tuvali ya da null), getOsdCanvas (FPV OSD tuvali §22 ya da null), getOverlays (§22.4: [{canvas, x, y, w, h}] CSS px — PiP OSD), audio (createEngineAudio nesnesi), displayStream (Başlat'ta
//         alınan akış ya da null), text: () => paylaşım metni (kullanıcının dilinde), onEvent(text, sev), rest (test: sahte), MR (test), now (test) }
// ======================================================================
export function createRecorder(stage, opts = {}) {
  const tr = opts.tr || (s => s);
  const rest = opts.rest || restRec();
  const MR = opts.MR || (typeof MediaRecorder !== 'undefined' ? MediaRecorder : null);
  const nowMs = opts.now || (() => performance.now());
  const sid = opts.sid;
  let recorder = null, stream = null, mixCtx = null, composite = null, unhook = null, raf = 0;
  let recId = null, recIdP = null, mime = '', startedAt = 0, stoppedAt = 0, state = 'idle';   // idle | starting | recording | stopped | full | error
  let seq = 0, uploaded = 0, total = 0, keepBytes = 0, lastErr = null, source = null, micOn = false, sysAudio = false;
  const blobs = [];            // indirme yedeği (≤ KEEP_MAX)
  const queue = [];            // yüklenecek parçalar (sıralı)
  let worker = null, stopP = null, stopResolve = null, thumbSent = false, thumbT = 0, tick = 0, disposed = false, aborted = false;   // aborted: kuyruk bırakılır (Sil); disposed kuyruğu KESMEZ (sayfadan çıkışta parçalar akmaya devam eder)
  const listeners = new Set();
  const emit = () => listeners.forEach(fn => { try { fn(status()); } catch { /* */ } });
  const status = () => ({ state, seconds, recId, mime, source, uploaded, total, pending: total - uploaded, sysAudio, micOn, error: lastErr?.message || null });
  const sec = () => (startedAt ? ((state === 'recording' ? nowMs() : stoppedAt) - startedAt) / 1000 : 0);
  let seconds = 0;

  // ---------- arayüz: rozet (üst şerit) + anahtar (alt çubuk) ----------
  const dot = h('i', { class: 'fs-rec-dot' });
  const badgeTxt = h('span', null, `${tr('KAYIT')} 00:00`);
  const badge = h('span', { class: 'fs-rec-badge', hidden: true, title: tr('Ekran kaydı sürüyor; Bitir ile Şirketten Haberler\'e paylaşılır') }, dot, badgeTxt);
  const toggleBtn = h('button', { class: 'btn sm fs-rec-btn', type: 'button', title: tr('Ekran kaydı aç/kapa (R): Başlat\'tan Bitir\'e ekran + ses kaydedilir, Bitir\'de Şirketten Haberler\'e paylaşılır'), onclick: () => onToggle() }, '⏺ ', tr('Kayıt'));
  // §43 grafik kalitesi: kayıt sürerken 3B tuvalin piksel oranına taban (tampon ≥ kayıt hedefi; düşük çözünürlük ölçeği kaydı bulanıklaştırmasın)
  let floorOn = false;
  const syncFloor = () => { const on = !disposed && (state === 'starting' || state === 'recording'); if (on !== floorOn) { floorOn = on; try { opts.getSim?.()?.setRecordFloor?.(on); } catch { /* sim yok */ } } };
  const drawBtn = () => {
    syncFloor();
    const on = state === 'recording' || state === 'starting';
    toggleBtn.classList.toggle('primary', on);
    toggleBtn.classList.toggle('danger', on);
    toggleBtn.classList.toggle('off', !on && !recPrefs.on);
    badge.hidden = !(on || state === 'stopped' || state === 'full');
    badge.classList.toggle('paused', state !== 'recording');
    const pend = total - uploaded;
    badgeTxt.textContent = `${tr(state === 'recording' ? 'KAYIT' : state === 'full' ? 'KAYIT DOLU' : 'KAYIT DURDU')} ${clock(seconds)}${pend > 0 ? ' ↑' : ''}`;
    badge.title = `${tr('Ekran kaydı')} · ${source === 'display' ? tr('ekran paylaşımı') : tr('3B + HUD tuvali')} · ${mime || '—'} · ${fmtBytes(total)}${pend > 0 ? ` (${tr('yükleniyor')} ${fmtBytes(pend)})` : ''}`;
  };
  (stage.querySelector('.fs-nav') || stage).append(badge);
  const anchor = stage.querySelector('.fs-ops-snd') || stage.querySelector('.fs-audio-btn')?.parentElement || stage.querySelector('.fs-ops-btn') || stage.querySelector('.fs-mhud-btn');   // Panel + ses kapsülünün ardına (kapsülün içine değil)
  if (anchor) anchor.after(toggleBtn); else (stage.querySelector('.fs-bar') || stage).append(toggleBtn);
  drawBtn();

  // ---------- görüntü kaynağı ----------
  const compositeStream = () => {
    const sim = opts.getSim?.();
    const src = sim?.canvas;
    if (!src || !src.captureStream) return null;
    // birleşik tuval: 3B tuval + (görünürse) askeri HUD tuvali; 720p hedef, sahne oranı korunur
    const ar = Math.max(0.5, Math.min(3, (stage.clientWidth || 16) / (stage.clientHeight || 9)));
    const W = ar >= 16 / 9 ? TARGET.width : Math.round(TARGET.height * ar), H = ar >= 16 / 9 ? Math.round(TARGET.width / ar) : TARGET.height;
    composite = document.createElement('canvas'); composite.width = W; composite.height = H;
    const g = composite.getContext('2d');
    const draw = () => {
      if (disposed || state !== 'recording' && state !== 'starting') return;
      try {
        g.drawImage(src, 0, 0, W, H);
        const hud = opts.getHudCanvas?.();
        if (hud && !hud.hidden && hud.width) g.drawImage(hud, 0, 0, W, H);
        const osd = opts.getOsdCanvas?.();   // §22 FPV OSD (pilot kamerası); kayıt başlarken seçili kamera korunur
        if (osd && !osd.hidden && osd.width) g.drawImage(osd, 0, 0, W, H);
        // §22.4 kamera PiP'i: görüntü zaten 3B tuvalde; PiP OSD tuvali (çerçeve, tür, gimbal, yakınlaştırma) dikdörtgenine ölçekli eklenir
        const sx = W / Math.max(1, src.clientWidth || W), sy = H / Math.max(1, src.clientHeight || H);
        for (const o of opts.getOverlays?.() || []) if (o?.canvas?.width) g.drawImage(o.canvas, o.x * sx, o.y * sy, o.w * sx, o.h * sy);
      } catch { /* tuval henüz boyutsuz */ }
    };
    if (sim.addFrameHook) unhook = sim.addFrameHook(draw);   // render SONRASI aynı turda (buffer henüz temizlenmemiş)
    else { const loop = () => { draw(); raf = requestAnimationFrame(loop); }; raf = requestAnimationFrame(loop); }
    return composite.captureStream(TARGET.fps);
  };

  // ---------- ses karışımı: motor (Web Audio) + sistem sesi (ekran paylaşımı) + mikrofon → tek parça ----------
  const mixAudio = async (display) => {
    const AC = typeof AudioContext !== 'undefined' ? AudioContext : null;
    if (!AC) return null;
    const dispAudio = display?.getAudioTracks?.() || [];
    sysAudio = dispAudio.length > 0;
    let mic = null;
    if (recPrefs.mic && navigator.mediaDevices?.getUserMedia) { try { mic = await navigator.mediaDevices.getUserMedia({ audio: true }); micOn = true; } catch { micOn = false; } }
    const engine = sysAudio ? null : opts.audio?.captureStream?.();   // sistem sesi varsa motor sesi zaten içinde
    if (!sysAudio && !engine && !mic) return null;
    try { mixCtx = new AC(); } catch { return null; }
    const dest = mixCtx.createMediaStreamDestination();
    const add = s => { if (s && s.getAudioTracks().length) { try { mixCtx.createMediaStreamSource(s).connect(dest); } catch { /* */ } } };
    if (sysAudio) add(new MediaStream(dispAudio));
    add(engine); add(mic);
    if (mixCtx.state !== 'running') mixCtx.resume?.().catch(() => {});
    return dest.stream.getAudioTracks()[0] || null;
  };

  // ---------- yükleme kuyruğu ----------
  const pump = () => { if (!worker) worker = run().finally(() => { worker = null; }); return worker; };
  const run = async () => {
    while (queue.length && !aborted) {
      const rid = await recIdP;
      if (!rid) { queue.length = 0; return; }
      const item = queue[0];
      let tries = 0;
      for (;;) {
        try {
          await rest.chunk(rid, item.seq, item.blob);
          uploaded += item.blob.size; queue.shift(); lastErr = null; drawBtn(); emit();
          break;
        } catch (err) {
          if (err.status === 413) { lastErr = err; state = state === 'recording' ? 'full' : state; stopRecorder(); queue.length = 0; toast(tr('Kayıt boyut sınırına ulaştı; kayıt durdu (şimdiye kadarki kısım paylaşılabilir)'), 'err'); drawBtn(); emit(); return; }
          if (err.status === 409 && /beklenen (\d+)/.test(err.message)) { const want = Number(/beklenen (\d+)/.exec(err.message)[1]); if (want > item.seq) { uploaded += item.blob.size; queue.shift(); break; } }
          if (err.status === 403 || err.status === 404) { lastErr = err; queue.length = 0; state = 'error'; stopRecorder(); drawBtn(); emit(); return; }
          if (++tries >= 5) { lastErr = err; drawBtn(); emit(); await new Promise(r => setTimeout(r, 8000)); tries = 0; if (aborted) return; continue; }
          await new Promise(r => setTimeout(r, 1000 * 2 ** (tries - 1)));
        }
      }
    }
  };
  const enqueue = blob => {
    if (!blob || !blob.size) return;
    for (let off = 0; off < blob.size; off += CHUNK_MAX) {   // ≤ 8 MB dilimler
      const part = blob.slice(off, Math.min(blob.size, off + CHUNK_MAX), blob.type);
      queue.push({ seq: seq++, blob: part }); total += part.size;
      if (keepBytes + part.size <= KEEP_MAX) { blobs.push(part); keepBytes += part.size; }
    }
    drawBtn(); pump();
  };

  // ---------- küçük resim: ilk 2 sn'den bir kare (320×180 PNG) ----------
  const sendThumb = async () => {
    if (thumbSent || disposed) return;
    thumbSent = true;
    const src = composite || opts.getSim?.()?.canvas;
    if (!src || !src.width) return;
    try {
      const c = document.createElement('canvas'); c.width = 320; c.height = Math.max(1, Math.round(320 * (src.height / src.width)));
      c.getContext('2d').drawImage(src, 0, 0, c.width, c.height);
      const blob = await new Promise(r => c.toBlob(r, 'image/png'));
      const rid = await recIdP;
      if (blob && rid) await rest.thumb(rid, blob);
    } catch { /* küçük resim isteğe bağlı */ }
  };

  // ---------- başlat / durdur ----------
  const start = async (display = null) => {
    if (state === 'recording' || state === 'starting' || disposed) return false;
    if (!MR) { toast(tr('Bu tarayıcı ekran kaydını desteklemiyor (MediaRecorder yok)'), 'err'); return false; }
    state = 'starting'; drawBtn();
    let video = null;
    if (display && display.getVideoTracks().some(t => t.readyState === 'live')) { video = display; source = 'display'; }
    else { const cs = compositeStream(); if (cs) { video = cs; source = 'canvas'; } }
    if (!video) { state = 'idle'; drawBtn(); toast(tr('Kayıt için görüntü kaynağı yok (3B tuval hazır değil)'), 'err'); return false; }
    const audioTrack = await mixAudio(source === 'display' ? display : null);
    stream = new MediaStream([...video.getVideoTracks(), ...(audioTrack ? [audioTrack] : [])]);
    mime = pickMime(MR) || '';
    try {
      recorder = new MR(stream, { ...(mime ? { mimeType: mime } : {}), videoBitsPerSecond: TARGET.videoBps, audioBitsPerSecond: TARGET.audioBps });
    } catch (err) { state = 'error'; lastErr = err; drawBtn(); toast(tr('Kayıt başlatılamadı: {e}', { e: err.message }), 'err'); return false; }
    mime = recorder.mimeType || mime;
    recIdP = rest.start(sid, mime).then(r => { recId = r.rec_id; emit(); return recId; }).catch(err => { lastErr = err; state = 'error'; stopRecorder(); drawBtn(); emit(); toast(tr('Kayıt sunucuda açılamadı: {e}', { e: err.message }), 'err'); return null; });
    recorder.ondataavailable = e => enqueue(e.data);
    recorder.onstop = () => { stoppedAt = nowMs(); seconds = sec(); if (state === 'recording') state = 'stopped'; drawBtn(); emit(); stopResolve?.(); stopResolve = null; };
    recorder.onerror = e => { lastErr = e.error || new Error('MediaRecorder'); state = 'error'; drawBtn(); emit(); };
    video.getVideoTracks()[0].addEventListener('ended', () => { if (state === 'recording') { opts.onEvent?.(tr('Ekran paylaşımı durduruldu; kayıt burada kesildi'), 'warning'); stop(); } });   // kullanıcı "Paylaşımı durdur"a bastı
    recorder.start(TIMESLICE_MS);
    startedAt = nowMs(); state = 'recording'; seconds = 0;
    thumbT = setTimeout(sendThumb, 2000);
    tick = setInterval(() => { seconds = sec(); drawBtn(); }, 1000);
    drawBtn(); emit();
    opts.onEvent?.(source === 'display' ? tr('Ekran kaydı başladı (ekran paylaşımı{a})', { a: sysAudio ? ` + ${tr('sistem sesi')}` : '' }) : tr('Ekran kaydı başladı (3B sahne + HUD; ekran paylaşımı yok — panel kayda girmez)'));
    return true;
  };
  const stopRecorder = () => {
    clearTimeout(thumbT); clearInterval(tick); tick = 0;
    try { if (recorder && recorder.state !== 'inactive') recorder.stop(); else stopResolve?.(); } catch { stopResolve?.(); }
    stream?.getTracks().forEach(t => { try { t.stop(); } catch { /* */ } });
    if (unhook) { unhook(); unhook = null; }
    if (raf) { cancelAnimationFrame(raf); raf = 0; }
    if (mixCtx) { try { mixCtx.close(); } catch { /* */ } mixCtx = null; }
  };
  const stop = () => {   // kaydı durdurur; son parça kuyruğa düşer. Promise: son parça alınınca
    if (!recorder || recorder.state === 'inactive') return Promise.resolve();
    if (!stopP) stopP = new Promise(r => { stopResolve = r; });
    stopRecorder();
    return stopP;
  };
  const drain = async onProgress => {   // kuyruk boşalana dek bekler (ilerleme: yüklenen/toplam)
    for (;;) {
      onProgress?.(total ? uploaded / total : 1, uploaded, total);
      if (!queue.length || aborted || state === 'error') break;
      await Promise.race([pump(), new Promise(r => setTimeout(r, 500))]);
    }
    if (lastErr && queue.length) throw lastErr;
  };
  const downloadBlob = () => {
    const b = new Blob(blobs, { type: mime || 'video/webm' });
    const a = h('a', { href: URL.createObjectURL(b), download: `ucus-simulatoru-${sid}-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.${/mp4/.test(mime) ? 'mp4' : 'webm'}` });
    document.body.append(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
  };

  // ---------- Bitir: ilerleme penceresi → paylaşıldı / hata (indir) ----------
  const finishWithDialog = async () => {
    if (!hasData()) { await stop(); return null; }
    await stop();
    const share = opts.share ? opts.share() : recPrefs.share;   // §17 kayıt seçeneği: paylaş / yalnız sunucuda sakla
    const bar = h('div', { class: 'fs-rec-bar' }, h('i'));
    const txt = h('div', { class: 'small muted' }, tr('Kayıt yükleniyor… %{p}', { p: 0 }));
    const body = h('div', { class: 'fs-rec-up' }, h('p', null, share ? tr('Ekran kaydı Şirketten Haberler\'e paylaşılıyor ({s}, {b}).', { s: clock(seconds), b: fmtBytes(total) }) : tr('Ekran kaydı sunucuya kaydediliyor ({s}, {b}); paylaşılmaz, "Kayıtlarım" listesinden indirilebilir.', { s: clock(seconds), b: fmtBytes(total) })), bar, txt);
    let close = null, result = null;
    const done = new Promise(resolve => {
      const m = modal({ title: tr('Kayıt yükleniyor'), body, actions: [], onClose: () => resolve(result) });
      close = m?.close || (() => document.querySelector('.modal-back')?.remove());
    });
    const setPct = p => { bar.firstChild.style.width = `${Math.round(p * 100)}%`; txt.textContent = tr('Kayıt yükleniyor… %{p}', { p: Math.round(p * 100) }); };
    try {
      await drain(setPct);
      const rid = await recIdP;
      if (!rid) throw lastErr || new Error(tr('Kayıt sunucuda açılamadı'));
      result = await rest.finish(rid, { duration_s: Math.round(seconds * 10) / 10, mime, text: opts.text?.() || undefined, share });
      setPct(1);
      if (result.kept) {
        clear(body, h('p', { class: 'fs-rec-ok' }, '✓ ', tr('Video sunucuda saklandı (paylaşılmadı)')), h('p', { class: 'small muted' }, result.text || ''),
          h('div', { class: 'pill-group' }, h('a', { class: 'btn sm primary', href: result.file || rest.fileUrl?.(rid), download: '' }, tr('Videoyu indir')),
            h('button', { class: 'btn sm', type: 'button', onclick: async ({ target }) => { target.disabled = true; try { await rest.share(rid); toast(tr('Şirketten Haberler\'e paylaşıldı')); close?.(); } catch (err) { toast(err.message, 'err'); target.disabled = false; } } }, tr('Şirketten Haberler\'de paylaş')),
            h('button', { class: 'btn sm', type: 'button', onclick: () => close?.() }, tr('Kapat'))));
        toast(tr('Video sunucuda saklandı; sihirbazdaki "Kayıtlarım" kutusundan indirebilir ya da paylaşabilirsiniz'));
      } else {
        clear(body, h('p', { class: 'fs-rec-ok' }, '✓ ', tr('Şirketten Haberler\'e paylaşıldı')), h('p', { class: 'small muted' }, result.text || ''),
          h('div', { class: 'pill-group' }, h('a', { class: 'btn sm primary', href: result.link || '#/home' }, tr('Paylaşımı aç')), h('button', { class: 'btn sm', type: 'button', onclick: () => close?.() }, tr('Kapat'))));
        toast(tr('Şirketten Haberler\'e paylaşıldı'));
        setTimeout(() => close?.(), 10000);
      }
    } catch (err) {
      lastErr = err;
      clear(body, h('p', { class: 'fs-rec-err' }, tr('Kayıt yüklenemedi: {e}', { e: err.message })),
        h('p', { class: 'small muted' }, blobs.length ? tr('Kaydı bilgisayarınıza indirebilirsiniz; sunucudaki yarım kayıt 24 saat saklanır (ana sayfada "Yarım kayıt" kutusu).') : tr('Sunucudaki yarım kayıt 24 saat saklanır (ana sayfada "Yarım kayıt" kutusu).')),
        h('div', { class: 'pill-group' }, blobs.length ? h('button', { class: 'btn sm primary', type: 'button', onclick: () => downloadBlob() }, tr('Dosyayı indir')) : null, h('button', { class: 'btn sm', type: 'button', onclick: () => close?.() }, tr('Kapat'))));
    }
    await done;
    return result;
  };

  // ---------- alt çubuk anahtarı ----------
  const onToggle = async () => {
    if (state === 'recording' || state === 'starting') {
      const choice = await new Promise(resolve => modal({ title: tr('Kaydı durdur'), body: h('p', null, tr('Şimdiye kadarki kayıt ({s}) ne olsun?', { s: clock(seconds) })),
        actions: [{ label: tr('Vazgeç') }, { label: tr('Sil'), class: 'danger', onClick: () => resolve('delete') }, { label: tr('Durdur ve paylaş'), class: 'primary', onClick: () => resolve('share') }], onClose: () => resolve(null) }));
      if (!choice) return;
      recPrefs.on = false;
      if (choice === 'share') { await finishWithDialog(); }   // paylaşım tercihi kapalıysa yalnız saklar
      else { aborted = true; await stop(); queue.length = 0; const rid = await recIdP; if (rid) rest.del(rid).catch(() => {}); state = 'idle'; blobs.length = 0; keepBytes = 0; total = uploaded = 0; seq = 0; recIdP = null; recId = null; }
      drawBtn(); emit();
      return;
    }
    recPrefs.on = true;
    const { stream: disp } = await acquireDisplayStream();   // tıklama içinde: izin kutusu
    reset();
    await start(disp);
  };
  const reset = () => { aborted = false; state = 'idle'; blobs.length = 0; keepBytes = 0; total = uploaded = 0; seq = 0; recIdP = null; recId = null; seconds = 0; startedAt = 0; thumbSent = false; composite = null; stopP = null; lastErr = null; };
  const onKey = e => { if (e.key?.toLowerCase() === 'r' && !e.ctrlKey && !e.metaKey && !e.altKey && !/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || '')) onToggle(); };
  window.addEventListener('keydown', onKey);
  const hasData = () => total > 0 || (recorder && recorder.state !== 'inactive');

  return {
    start, stop, finishWithDialog, toggleBtn, badge, status, onChange: fn => { listeners.add(fn); return () => listeners.delete(fn); },
    abandon() {   // sayfadan ayrılış (Bitir'siz): kayıt durur, kuyruk arka planda akıtılmaya devam eder (aynı belge; fetch sürer) → sunucuda yarım kayıt
      stop(); window.removeEventListener('keydown', onKey);
      if (hasData()) toast(tr('Kayıt yarım kaldı; ana sayfadaki "Yarım kayıt" kutusundan paylaşabilir ya da silebilirsiniz'));
    },
    get active() { return state === 'recording'; }, get state() { return state; }, get seconds() { return seconds; }, get hasData() { return hasData(); }, get source() { return source; }, get mime() { return mime; },
    dispose() { if (disposed) return; disposed = true; syncFloor(); window.removeEventListener('keydown', onKey); stopRecorder(); badge.remove(); toggleBtn.remove(); },
  };
}

// ======================================================================
// Sihirbaz: yarım kayıtlar kutusu (oturumu kapanmış, bitirilmemiş) → Paylaş / Sil
// ======================================================================
export function pendingCard(tr, rest = restRec()) {
  const box = h('div', { class: 'fs-rec-pending' });
  const draw = async () => {
    let items = [];
    try { items = (await rest.pending()).items || []; } catch { items = []; }
    if (!items.length) { clear(box); return; }
    clear(box, h('div', { class: 'card card-pad fs-open no-collapse' }, h('h3', null, tr('Yarım kayıt ({n})', { n: items.length })),
      h('p', { class: 'small muted' }, tr('Bitir denmeden kapanan oturumların ekran kayıtları 24 saat saklanır: Şirketten Haberler\'e paylaşın ya da silin.')),
      h('div', { class: 'fs-open-list' }, items.map(it => h('div', { class: 'fs-open-row' },
        h('div', { class: 'fs-open-main' }, h('b', null, it.text), h('div', { class: 'small muted' }, [clock(it.seconds), fmtBytes(it.size), it.started_at ? it.started_at.replace('T', ' ').slice(0, 16) : null].filter(Boolean).join(' · '))),
        h('div', { class: 'pill-group' },
          h('button', { class: 'btn sm primary', type: 'button', onclick: async ({ target }) => { target.disabled = true; try { await rest.finish(it.id, { duration_s: it.seconds }); toast(tr('Şirketten Haberler\'e paylaşıldı')); } catch (err) { toast(err.message, 'err'); } draw(); } }, tr('Paylaş')),
          h('button', { class: 'btn sm danger', type: 'button', onclick: async ({ target }) => { target.disabled = true; try { await rest.del(it.id); } catch (err) { toast(err.message, 'err'); } draw(); } }, tr('Sil'))))))));
  };
  draw();
  return { el: box, refresh: draw };
}

// ======================================================================
// Sihirbaz: "Kayıtlarım" — paylaşılmadan saklanan videolar (finish share:false) → İndir / Şirketten Haberler'de paylaş / Sil
// ======================================================================
export function myRecsCard(tr, rest = restRec()) {
  const box = h('div', { class: 'fs-rec-mine' });
  const draw = async () => {
    let items = [], days = 30;
    try { const r = await rest.mine(); items = r.items || []; days = r.keep_days || days; } catch { items = []; }
    if (!items.length) { clear(box); return; }
    clear(box, h('div', { class: 'card card-pad fs-open no-collapse' }, h('h3', null, tr('Kayıtlarım ({n})', { n: items.length })),
      h('p', { class: 'small muted' }, tr('Paylaşılmadan saklanan ekran kayıtları {d} gün tutulur: indirin, Şirketten Haberler\'e paylaşın ya da silin.', { d: days })),
      h('div', { class: 'fs-open-list' }, items.map(it => h('div', { class: 'fs-open-row' },
        h('div', { class: 'fs-open-main' }, h('b', null, it.text), h('div', { class: 'small muted' }, [clock(it.seconds), fmtBytes(it.size), it.kept_at ? it.kept_at.replace('T', ' ').slice(0, 16) : null].filter(Boolean).join(' · '))),
        h('div', { class: 'pill-group' },
          h('a', { class: 'btn sm', href: rest.fileUrl(it.id), download: it.file_name || '' }, tr('İndir')),
          h('button', { class: 'btn sm primary', type: 'button', onclick: async ({ target }) => { target.disabled = true; try { await rest.share(it.id); toast(tr('Şirketten Haberler\'e paylaşıldı')); } catch (err) { toast(err.message, 'err'); } draw(); } }, tr('Paylaş')),
          h('button', { class: 'btn sm danger', type: 'button', onclick: async ({ target }) => { target.disabled = true; try { await rest.del(it.id); } catch (err) { toast(err.message, 'err'); } draw(); } }, tr('Sil'))))))));
  };
  draw();
  return { el: box, refresh: draw };
}

// ======================================================================
// Sihirbaz: "Kayıt" seçenekleri kutusu (Başlat düğmesinin üstünde): ☐ ekran kaydı (video) › ☐ Şirketten Haberler'de paylaş · ☐ uçuş logu (.bin; yalnız canlı)
// Tercihler localStorage (recPrefs); alt çubuktaki kayıt anahtarı aynı tercihi okur.
// ======================================================================
export function recOptionsBox(tr, { getMode = () => 'sitl' } = {}) {
  const videoCb = h('input', { type: 'checkbox', checked: recPrefs.on, onchange: () => { recPrefs.on = videoCb.checked; sync(); } });
  const shareCb = h('input', { type: 'checkbox', checked: recPrefs.share, onchange: () => { recPrefs.share = shareCb.checked; sync(); } });
  const binCb = h('input', { type: 'checkbox', checked: recPrefs.bin, onchange: () => { recPrefs.bin = binCb.checked; sync(); } });
  const shareRow = h('label', { class: 'check fs-rec-opt fs-rec-opt-sub' }, shareCb, tr('Şirketten Haberler\'de paylaş'), h('span', { class: 'small muted' }, tr('kapalıysa video sunucuda saklanır: Bitir\'de "Videoyu indir", sihirbazda "Kayıtlarım"')));
  const binRow = h('label', { class: 'check fs-rec-opt' }, binCb, tr('Uçuş logunu (.bin) kaydet'), h('span', { class: 'small muted' }, tr('SITL DataFlash kaydı (yalnız armed süre); Bitir\'de Uçuş Logları\'na eklenir ve Kayıttan oynat listesinde görünür')));
  const el = h('div', { class: 'card card-pad fs-step fs-rec-opts no-collapse' }, h('h3', null, h('span', { class: 'fs-no' }, '●'), tr('Kayıt')),
    h('label', { class: 'check fs-rec-opt' }, videoCb, tr('Ekran kaydı al (video)'), h('span', { class: 'small muted' }, tr('Başlat\'tan Bitir\'e ekran + ses; kapalıysa ekran paylaşımı izni istenmez'))),
    shareRow, binRow);
  const sync = () => { shareCb.disabled = !videoCb.checked; shareRow.classList.toggle('off', !videoCb.checked); binRow.hidden = getMode() === 'replay'; };
  sync();
  return { el, sync, setBin: v => { binCb.checked = !!v; recPrefs.bin = !!v; sync(); }, get video() { return recPrefs.on; }, get share() { return recPrefs.share; }, get bin() { return recPrefs.bin && getMode() !== 'replay'; } };   // setBin: §27 kayıtlı ayar
}
