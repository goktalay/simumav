// SIMUMAV hareketli "soft" arka planlar — bölüm başına sahne, TEK Canvas2D katmanı (#backdrop; #view'in ARKASINDA, z-index 0).
// WebGL YOK: uçuş sahnesinin tek paylaşılan WebGL bağlamına dokunmaz. Bölüm içerik kodu değişmez (kabuk router'ı setScene çağırır).
//   menu → (yok; menünün kendi canlı uçuş sahnesi #stage) · hangar → hangar · crew → brifing sınıfı · tracks → tel kafes küre ·
//   missions → ilaçlama tarlası · fly (Tek/Çok seçimi + sihirbaz) → CAYMAZ sinematik · uçuş oturumu (3B) → YOK (durur + bırakılır).
// Kurallar: prefers-reduced-motion → tek durağan kare; sekme gizli → döngü durur (0 ms); düşük güç (mobil/≤4 çekirdek) → 24 fps,
// düşük çözünürlük, daha az parçacık. Sahne değişince eski sahne dispose (önbellek tuvalleri bırakılır). Hedef ≤ 3 ms/kare (vinyet ve durağan ışımalar önbellekte).
// Teşhis: window.__smBackdrop() → { scene, running, frames, avgMs, worstMs, fps, scale, reduced, lowPower }.

export const SCENE_FOR = { hangar: 'hangar', crew: 'crew', tracks: 'tracks', missions: 'missions', fly: 'caymaz' };
export const bgEnabled = (st = globalThis.localStorage) => { try { return st?.getItem('sm:bgfx') !== '0'; } catch { return true; } };

/** Bölüm → sahne (saf). Uçuş oturumu ya da ayardan kapalıysa null. */
export function sceneFor(name, { inFlight = false, enabled = true } = {}) {
  if (!enabled || inFlight) return null;
  return SCENE_FOR[name] || null;
}
/** Kare bütçesi (saf): reduced → durağan; düşük güç → 24 fps, ölçek 0,5, yoğunluk 0,55. */
export function budget({ reduced = false, lowPower = false, dpr = 1 } = {}) {
  return { animate: !reduced, fps: lowPower ? 24 : 30, scale: Math.min(1, Math.max(0.35, (lowPower ? 0.5 : 0.6) * Math.min(dpr, 1.5))), density: lowPower ? 0.55 : 1 };
}
/** Düşük güç sezgisi (saf; nav/mq enjekte). */
export function isLowPower(nav = globalThis.navigator, coarse = false) {
  const cores = Number(nav?.hardwareConcurrency) || 8, mem = Number(nav?.deviceMemory) || 8;
  return !!(coarse || cores <= 4 || mem <= 4 || nav?.connection?.saveData);
}

const S = { cv: null, g: null, name: null, scene: null, raf: 0, last: 0, t0: 0, frames: 0, avg: 0, worst: 0, B: null, reduced: false, lowPower: false, W: 0, H: 0, mod: null, token: 0 };
const mqReduced = () => globalThis.matchMedia?.('(prefers-reduced-motion: reduce)');

function ensureCanvas() {
  if (S.cv) return S.cv;
  const cv = document.createElement('canvas');
  cv.id = 'backdrop'; cv.setAttribute('aria-hidden', 'true');
  document.body.insertBefore(cv, document.getElementById('view'));
  S.cv = cv; S.g = cv.getContext('2d', { alpha: false });
  addEventListener('resize', () => { if (S.scene) { resize(); if (!S.raf) drawOnce(); } });
  document.addEventListener('visibilitychange', () => { if (document.hidden) stop(); else if (S.scene && S.B?.animate) start(); });
  mqReduced()?.addEventListener?.('change', () => { if (S.name) { const n = S.name; setScene(null); setScene(n); } });
  addEventListener('sm:theme', () => { if (S.name) { const n = S.name; setScene(null); setScene(n); } });
  return cv;
}
function resize() {
  const dpr = globalThis.devicePixelRatio || 1;
  S.B = budget({ reduced: S.reduced, lowPower: S.lowPower, dpr });
  const w = innerWidth, h = innerHeight, k = Math.min(S.B.scale, 1100 / Math.max(w, 1));
  S.W = Math.max(64, Math.round(w * k)); S.H = Math.max(64, Math.round(h * k));
  S.cv.width = S.W; S.cv.height = S.H;
  S.scene?.resize?.(S.W, S.H);
}
function drawOnce(t = 14) {
  if (!S.scene) return;
  const a = performance.now();
  try { S.scene.frame(t, 0); } catch (e) { console.error('arka plan', e); }
  const ms = performance.now() - a;
  S.frames++; if (S.frames > 3) { S.avg = S.avg ? S.avg * 0.92 + ms * 0.08 : ms; if (S.frames > 10) S.worst = Math.max(S.worst, ms); }   // ilk kareler önbellek kurar → ortalamaya girmez
}
function loop(now) {
  S.raf = requestAnimationFrame(loop);
  const minDt = 1000 / S.B.fps - 2;
  if (now - S.last < minDt) return;
  const dt = Math.min(0.1, (now - (S.last || now)) / 1000); S.last = now;
  const a = performance.now();
  try { S.scene.frame((now - S.t0) / 1000, dt); } catch (e) { console.error('arka plan', e); stop(); return; }
  const ms = performance.now() - a;
  S.frames++; if (S.frames > 3) { S.avg = S.avg ? S.avg * 0.92 + ms * 0.08 : ms; if (S.frames > 10) S.worst = Math.max(S.worst, ms); }
}
function start() { if (S.raf || !S.scene || document.hidden) return; S.last = 0; S.raf = requestAnimationFrame(loop); }
function stop() { if (S.raf) cancelAnimationFrame(S.raf); S.raf = 0; }

/** Sahneyi değiştir (null → kapat + bırak). */
export async function setScene(name) {
  if (typeof document === 'undefined') return;
  if (name === S.name) return;
  const token = ++S.token;
  stop();
  try { S.scene?.dispose?.(); } catch { /* */ }
  S.scene = null; S.name = name;
  ensureCanvas();
  S.cv.classList.remove('on');
  if (!name) { S.cv.width = 1; S.cv.height = 1; S.cv.hidden = true; return; }
  S.reduced = !!mqReduced()?.matches;
  S.lowPower = isLowPower(navigator, !!globalThis.matchMedia?.('(pointer: coarse)').matches && innerWidth < 900);
  S.mod ??= await import('./backdrop/scenes.js');
  if (token !== S.token) return;
  S.cv.hidden = false; resize();
  const theme = document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
  S.scene = S.mod.createScene(name, S.g, S.W, S.H, { density: S.B.density, theme, lowPower: S.lowPower, onReady: () => { if (token === S.token && !S.raf) drawOnce(); } });
  S.frames = 0; S.avg = 0; S.worst = 0; S.t0 = performance.now() - 6000;   // 6 sn ileriden başla (sahne dolu görünsün)
  drawOnce();
  requestAnimationFrame(() => { if (token === S.token) S.cv.classList.add('on'); });
  if (S.B.animate) start();
}
export const state = () => ({ scene: S.name, running: !!S.raf, frames: S.frames, avgMs: +S.avg.toFixed(3), worstMs: +S.worst.toFixed(3), fps: S.B?.fps ?? 0, scale: S.B?.scale ?? 0, w: S.W, h: S.H, reduced: S.reduced, lowPower: S.lowPower });
