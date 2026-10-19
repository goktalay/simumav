// Sahne geçişleri (oyun tarzı): İLERİ = seçilen kartın tam ekrana büyümesi (FLIP hayalet, Web Animations API) + ışık süpürme;
// GERİ = ekranın küçülüp solması + ters süpürme. 400–700 ms. prefers-reduced-motion → 150 ms kısa fade. Inline stil yok
// (transform/opacity Web Animations API ile; hayalet öğe sınıfla biçimlenir). Başlık harf harf sinematik giriş (splitTitle).
import * as sfx from './sfx.js';

export const reduced = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
let curtain = null, ghost = null, pendingOrigin = null;
const el = () => (curtain ??= document.getElementById('curtain'));
const ghostEl = () => { if (!ghost) { ghost = document.createElement('div'); ghost.className = 'flip-ghost'; ghost.setAttribute('aria-hidden', 'true'); ghost.hidden = true; document.body.append(ghost); } return ghost; };

/** Bir sonraki ileri geçişin kaynağı (menü kartı). Router sweep'i bunu tüketir. */
export function rememberOrigin(element) {
  try { const r = element?.getBoundingClientRect?.(); pendingOrigin = r ? { x: r.x, y: r.y, w: r.width, h: r.height, t: performance.now() } : null; } catch { pendingOrigin = null; }
}
export const takeOrigin = () => { const o = pendingOrigin; pendingOrigin = null; return o && performance.now() - o.t < 1500 ? o : null; };

/** FLIP keyframe hesabı (saf): kart dikdörtgeni → tam ekran (W×H). */
export function flipKeyframes(from, W, H) {
  const sx = Math.max(0.02, from.w / W), sy = Math.max(0.02, from.h / H);
  return [{ transform: `translate(${from.x}px, ${from.y}px) scale(${sx}, ${sy})`, opacity: 0.85 }, { transform: 'translate(0px, 0px) scale(1, 1)', opacity: 1 }];
}
/** Geçiş süresini sınırla (saf): 400–700 ms; reduced → 150. */
export const clampDuration = (ms, red = false) => (red ? 150 : Math.min(700, Math.max(400, Number(ms) || 500)));

const wait = ms => new Promise(r => setTimeout(r, ms));
const anim = (node, kf, opts) => new Promise(res => { try { const a = node.animate(kf, opts); a.onfinish = () => res(a); a.oncancel = () => res(a); setTimeout(() => res(a), (opts.duration || 0) + 200); } catch { res(null); } });

/** Perdeyi süpür; ortasında `swap` çalışır. dir: 'fwd' | 'back'; duration 400–700 ms; origin: FLIP kaynağı (ileri). */
export async function sweep(swap, { dir = 'fwd', duration = 520, origin = null } = {}) {
  const c = el(), view = document.getElementById('view');
  if (!c || reduced()) {   // kısa fade (150 ms)
    const a = view ? await anim(view, [{ opacity: 1 }, { opacity: 0 }], { duration: 150, fill: 'forwards' }) : null;
    try { await swap(); } catch (e) { console.error(e); }
    a?.cancel?.();
    if (view) anim(view, [{ opacity: 0 }, { opacity: 1 }], { duration: 150 });
    return;
  }
  duration = clampDuration(duration);
  origin = origin || (dir === 'fwd' ? takeOrigin() : null);
  if (origin) return flipForward(swap, origin, duration);
  if (dir === 'back' && view?.firstElementChild) return shrinkBack(swap, duration);
  return curtainSweep(swap, dir, duration);
}

async function curtainSweep(swap, dir, duration) {
  const c = el();
  c.style.setProperty('--dur', `${duration}ms`);
  c.classList.remove('run', 'back', 'hold'); void c.offsetWidth;
  c.classList.toggle('back', dir === 'back'); c.classList.add('run');
  sfx.sweep();
  await wait(duration * 0.5);
  try { await swap(); } catch (e) { console.error(e); }
  await wait(duration * 0.5 + 30);
  c.classList.remove('run', 'back'); c.style.removeProperty('--dur');
}

/** İleri: kart hayaleti tam ekrana büyür (opak), ortada içerik değişir, hayalet erir; yeni ekran başlığı sinematik gelir. */
async function flipForward(swap, origin, duration) {
  const g = ghostEl(), W = window.innerWidth, H = window.innerHeight;
  g.hidden = false; g.classList.add('on');
  sfx.sweep();
  const grow = Math.round(duration * 0.6), fade = Math.round(duration * 0.4);
  const a1 = await anim(g, flipKeyframes(origin, W, H), { duration: grow, easing: 'cubic-bezier(.22, 1, .36, 1)', fill: 'forwards' });
  try { await swap(); } catch (e) { console.error(e); }
  const a2 = await anim(g, [{ opacity: 1 }, { opacity: 0 }], { duration: fade, easing: 'ease-out', fill: 'forwards' });
  a1?.cancel?.(); a2?.cancel?.(); g.classList.remove('on'); g.hidden = true;
}

/** Geri: mevcut ekran küçülür ve solar (menüye dönüş), perde ters süpürür, yeni ekran hafif yaklaşarak gelir. */
async function shrinkBack(swap, duration) {
  const view = document.getElementById('view'), c = el();
  c.style.setProperty('--dur', `${duration}ms`); c.classList.remove('run', 'hold'); void c.offsetWidth; c.classList.add('back', 'run');
  sfx.back();
  const a = await anim(view, [{ transform: 'scale(1)', opacity: 1 }, { transform: 'scale(.9) translateY(18px)', opacity: 0 }], { duration: Math.round(duration * 0.5), easing: 'cubic-bezier(.4, 0, .6, 1)', fill: 'forwards' });
  try { await swap(); } catch (e) { console.error(e); }
  a?.cancel?.();
  await anim(view, [{ transform: 'scale(1.04)', opacity: 0 }, { transform: 'none', opacity: 1 }], { duration: Math.round(duration * 0.5), easing: 'cubic-bezier(.22, 1, .36, 1)' });
  c.classList.remove('run', 'back'); c.style.removeProperty('--dur');
}

/** Perdeyi kapalı tut (yükleme sırasında), sonra aç. */
export function hold(on) { const c = el(); if (c) c.classList.toggle('hold', !!on); }

/** Öğeye giriş animasyonu sınıfı ver; sırayla (stagger) gecikme. rise: AAA menü kademeli yükselme + ışıma. */
export function stagger(items, base = 40, { rise = false } = {}) {
  items.forEach((it, i) => { it.classList.add(rise ? 'rise' : 'appear'); it.style.animationDelay = `${reduced() ? 0 : i * base}ms`; });
}

/** Başlığı harflere böl (sinematik giriş). Boşluklar korunur; aria-label tam metin. */
export function splitTitle(elm, base = 26) {
  if (!elm || elm.dataset.split) return elm;
  const text = elm.textContent; elm.dataset.split = '1'; elm.setAttribute('aria-label', text); elm.classList.add('cine');
  elm.replaceChildren(...[...text].map((ch, i) => { const s = document.createElement('span'); s.className = 'tch'; s.textContent = ch === ' ' ? ' ' : ch; s.setAttribute('aria-hidden', 'true'); s.style.animationDelay = `${reduced() ? 0 : 120 + i * base}ms`; return s; }));
  return elm;
}
