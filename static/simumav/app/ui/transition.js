// Sahne geçişleri: ışık süpürme perdesi (350–600 ms). prefers-reduced-motion'da anlık.
const reduced = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
let curtain = null;
const el = () => (curtain ??= document.getElementById('curtain'));

/** Perdeyi süpür; ortasında (perde tam kapalıyken) `swap` çalışır. dir: 'fwd' | 'back'. Süre ms (350–600). */
export function sweep(swap, { dir = 'fwd', duration = 450 } = {}) {
  const c = el();
  if (!c || reduced()) { return Promise.resolve(swap()); }
  duration = Math.min(600, Math.max(350, duration));
  c.style.setProperty('--dur', `${duration}ms`);
  return new Promise(resolve => {
    c.classList.remove('run', 'back', 'hold');
    void c.offsetWidth;   // animasyonu sıfırla
    c.classList.toggle('back', dir === 'back');
    c.classList.add('run');
    let swapped = false;
    const mid = setTimeout(async () => { swapped = true; try { await swap(); } catch (e) { console.error(e); } }, duration * 0.5);
    const done = () => {
      c.removeEventListener('animationend', done);
      clearTimeout(mid);
      const finish = () => { c.classList.remove('run', 'back'); c.style.removeProperty('--dur'); resolve(); };
      if (!swapped) Promise.resolve(swap()).finally(finish); else finish();
    };
    c.addEventListener('animationend', done, { once: true });
    setTimeout(done, duration + 120);   // güvenlik: animationend gelmezse
  });
}

/** Perdeyi kapalı tut (yükleme sırasında), sonra aç. */
export function hold(on) { const c = el(); if (c) c.classList.toggle('hold', !!on); }

/** Öğeye giriş animasyonu sınıfı ver; sırayla (stagger) gecikme. */
export function stagger(items, base = 40) {
  items.forEach((it, i) => { it.classList.add('appear'); it.style.animationDelay = `${reduced() ? 0 : i * base}ms`; });
}
