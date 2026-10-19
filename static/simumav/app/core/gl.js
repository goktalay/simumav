// Canlı WebGL bağlam sayacı (teşhis): HTMLCanvasElement.prototype.getContext sarmalanır; webgl/webgl2 bağlamı alınan her canvas izlenir.
// `window.__smGl()` → kaybedilmemiş (isContextLost() === false) bağlam sayısı; `window.__smGl.list()` → [{w, h, cls, attached}].
// Tarayıcı sınırı (~16 bağlam) aşılınca en eski bağlam zorla kaybedilir ("context loss and was blocked"); hedef: modüller arası gezintide ≤ 3.
// Saf çekirdek (createGlCounter) node ile test edilir: tests/test_simumav_ui.mjs.
const GL_TYPES = new Set(['webgl', 'webgl2', 'experimental-webgl']);

export function createGlCounter() {
  const tracked = new Map();   // canvas → gl
  const live = () => [...tracked].filter(([, gl]) => { try { return !gl.isContextLost?.(); } catch { return false; } });
  return {
    track(canvas, gl) { if (canvas && gl && !tracked.has(canvas)) tracked.set(canvas, gl); },
    count() { const l = live(); for (const c of [...tracked.keys()]) if (!l.some(([k]) => k === c)) tracked.delete(c); return l.length; },
    list() { return live().map(([c]) => ({ w: c.width, h: c.height, cls: c.className || '', attached: !!c.isConnected })); },
    isGl: type => GL_TYPES.has(String(type || '').toLowerCase()),
  };
}

/** getContext sarmalaması; iki kez kurulmaz. Dönüş: sayaç. */
export function installGlCounter(win = globalThis) {
  const proto = win.HTMLCanvasElement?.prototype;
  if (!proto || typeof proto.getContext !== 'function') return null;
  if (proto.getContext.__smGl) return proto.getContext.__smGl;
  const counter = createGlCounter(), orig = proto.getContext;
  const wrapped = function getContext(type, ...rest) {
    const gl = orig.call(this, type, ...rest);
    if (gl && counter.isGl(type)) counter.track(this, gl);
    return gl;
  };
  wrapped.__smGl = counter;
  proto.getContext = wrapped;
  const fn = () => counter.count();
  fn.list = () => counter.list();
  win.__smGl = fn;
  return counter;
}
