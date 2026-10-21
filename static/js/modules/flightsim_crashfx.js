// Uçuş Simülatörü — ÇARPIŞMA EFEKTİ (docs/ucus-simulatoru.md §18.6): patlama ateş topu, toz bulutu, kıvılcım/enkaz parçacıkları, yanan enkaz
// (termal kamerada sıcak nokta), kamera sarsıntısı ve kısa beyaz flaş. Şiddet çarpma hızıyla ölçeklenir (crashFxParams).
// • Saf katman (three.js'siz; node testi tests/test_flightsim_crashfx.mjs): crashFxParams(speed), shakeAt(t, p), flashAt(t, p), particleAt(…).
// • createCrashFx(T, { scene, mountEl, heatRoots }) → { trigger({x, y, z, ground, speed}), update(now), shake(now) → {x, y, z, roll} | null,
//   active, clear(), dispose() }. Tek paylaşılan renderer; parçacıklar sahnede (ek render geçişi yok). Termal: ateş topu/kıvılcım toplamalı
//   (parlak = sıcak), yanan enkaz çekirdeği userData.heat = 1 (heatRoots), toz soğuk.

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

/** Hız (m/s) + araç boyu (m, model yarıçapı) → efekt parametreleri. i: şiddet 0,2 (yavaş temas) … 1 (≥ 40 m/s); k: boyut çarpanı (küçük FPV/interceptor
 *  0,4 … büyük sabit kanat 2) — ateş topu, toz ve enkaz yarıçapları buna göre (1 m'lik dronda 12 m ateş topu olmasın). */
export function crashFxParams(speed, size = 2) {
  const v = Math.max(0, Number(speed) || 0), i = clamp(0.2 + 0.8 * Math.min(1, v / 40), 0.2, 1), k = clamp((Number(size) || 2) / 2, 0.4, 2);
  return {
    i, k,
    fire: Math.round(6 + 10 * i),          // ateş topu sprite sayısı
    fireR: (2 + 6 * i) * k,                // ateş topu yarıçapı (m)
    fireS: 0.9 + 0.8 * i,                  // ateş topu süresi (sn)
    dust: Math.round(8 + 14 * i),          // toz bulutu sprite sayısı
    dustR: (4 + 12 * i) * k,               // toz bulutu yayılımı (m)
    dustS: 3.5 + 3 * i,                    // toz süresi (sn)
    sparks: Math.round(40 + 140 * i),      // kıvılcım/enkaz parçası
    sparkV: (8 + 22 * i) * Math.sqrt(k),   // kıvılcım ilk hızı (m/s)
    sparkS: 1.2 + 1.3 * i,                 // kıvılcım ömrü (sn)
    burnS: 6 + 8 * i,                      // yanan enkaz (sn; termalde sıcak)
    shake: (0.25 + 1.6 * i) * Math.sqrt(k), // kamera sarsıntısı genliği (m, takip mesafesine göre ölçeklenir)
    shakeS: 0.5 + 0.9 * i,                 // sarsıntı süresi (sn)
    flash: 0.35 + 0.55 * i,                // beyaz flaş tepe opaklığı
    flashS: 0.18 + 0.22 * i,               // flaş süresi (sn)
  };
}
/** Sarsıntı (t sn, efekt başından): üstel sönen, deterministik çok frekanslı titreşim → {x, y, z, roll (rad)} ya da null (bitti). */
export function shakeAt(t, p) {
  if (!p || t < 0 || t > p.shakeS) return null;
  const a = p.shake * Math.exp(-4 * t / p.shakeS) * (1 - t / p.shakeS);
  return { x: a * Math.sin(t * 71 + 1.3) * 0.8, y: a * Math.sin(t * 59 + 0.4) * 0.8, z: a * Math.sin(t * 83 + 2.1), roll: a * 0.035 * Math.sin(t * 47) };
}
/** Beyaz flaş opaklığı (t sn): ilk 30 ms'de tepe, sonra hızlı sönüm. */
export function flashAt(t, p) {
  if (!p || t < 0 || t > p.flashS) return 0;
  return t < 0.03 ? p.flash * (t / 0.03) : p.flash * (1 - (t - 0.03) / (p.flashS - 0.03)) ** 1.6;
}
/** Kıvılcım konumu (balistik + sürüklenme): p0, v0 [3], t sn, g 9,81 → [x, y, z] (zemin z ≥ gz). */
export function particleAt(p0, v0, t, gz = -Infinity, drag = 0.6) {
  const k = Math.exp(-drag * t), f = (1 - k) / drag;
  const z = p0[2] + v0[2] * f - 9.81 * (t / drag - f / drag);
  return [p0[0] + v0[0] * f, p0[1] + v0[1] * f, Math.max(gz, z)];
}

// ---------------------------------------------------------------- three.js katmanı ----------------------------------------------------------------
function radialTexture(T, stops) {
  const cv = document.createElement('canvas'); cv.width = cv.height = 64;
  const g = cv.getContext('2d'), gr = g.createRadialGradient(32, 32, 1, 32, 32, 31);
  for (const [o, c] of stops) gr.addColorStop(o, c);
  g.fillStyle = gr; g.fillRect(0, 0, 64, 64);
  const t = new T.CanvasTexture(cv); t.colorSpace = T.SRGBColorSpace;
  return t;
}

export function createCrashFx(T, { scene, mountEl = null, heatRoots = null } = {}) {
  const group = new T.Group(); group.name = 'carpisma-efekti'; group.visible = false;
  scene.add(group);
  const hot = new T.Group(); hot.name = 'yanan-enkaz';   // termal: heatRoots (meshler userData.heat ile)
  scene.add(hot); heatRoots?.push(hot);
  const texFire = radialTexture(T, [[0, 'rgba(255,255,240,1)'], [0.25, 'rgba(255,214,120,0.95)'], [0.55, 'rgba(255,110,30,0.6)'], [1, 'rgba(120,20,0,0)']]);
  const texDust = radialTexture(T, [[0, 'rgba(255,255,255,0.85)'], [0.6, 'rgba(255,255,255,0.35)'], [1, 'rgba(255,255,255,0)']]);
  const sparkGeo = new T.BufferGeometry(), MAXS = 200, sparkPos = new Float32Array(MAXS * 3);
  sparkGeo.setAttribute('position', new T.BufferAttribute(sparkPos, 3)); sparkGeo.setDrawRange(0, 0);
  const sparkMat = new T.PointsMaterial({ color: 0xffc46a, size: 0.55, sizeAttenuation: true, transparent: true, opacity: 1, depthWrite: false, blending: T.AdditiveBlending, fog: false });
  const sparks = new T.Points(sparkGeo, sparkMat); sparks.frustumCulled = false; group.add(sparks);
  const pool = { fire: [], dust: [] };
  const sprite = (kind) => {
    const m = new T.SpriteMaterial({ map: kind === 'fire' ? texFire : texDust, color: kind === 'fire' ? 0xffffff : 0x6b5a45, transparent: true, opacity: 0, depthWrite: false,
      blending: kind === 'fire' ? T.AdditiveBlending : T.NormalBlending, fog: kind !== 'fire' });
    const s = new T.Sprite(m); s.visible = false; group.add(s); pool[kind].push(s); return s;
  };
  const core = new T.Mesh(new T.IcosahedronGeometry(1, 1), new T.MeshBasicMaterial({ color: 0xff5a10, transparent: true, opacity: 0.6, depthWrite: false, blending: T.AdditiveBlending }));   // küçük kor (gündüz hafif parıltı, termalde sıcak nokta)
  core.userData.heat = 1; core.visible = false; hot.add(core);
  let flashEl = null;
  if (mountEl && typeof document !== 'undefined') {
    flashEl = document.createElement('div');
    flashEl.className = 'fs-crash-flash';
    flashEl.style.cssText = 'position:absolute;inset:0;background:#fff;opacity:0;pointer-events:none;z-index:3;mix-blend-mode:screen';
    mountEl.appendChild(flashEl);
  }
  let fx = null;   // etkin efekt: { t0, p, at:[x,y,z], gz, fire:[], dust:[], sp:[{v}], rnd }
  const rand = seed => { let a = seed >>> 0 || 1; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; };

  function trigger({ x = 0, y = 0, z = 0, ground = null, speed = 15, size = 2, now = performance.now() } = {}) {
    const p = crashFxParams(speed, size), r = rand(Math.round(now) ^ 0x9e37);
    const gz = Number.isFinite(ground) ? ground : z;
    const at = [x, y, Math.max(gz, z)];
    const fire = [], dust = [], sp = [];
    while (pool.fire.length < p.fire) sprite('fire');
    while (pool.dust.length < p.dust) sprite('dust');
    for (let k = 0; k < pool.fire.length; k++) { const s = pool.fire[k]; s.visible = k < p.fire; if (k < p.fire) fire.push({ s, d: [(r() - 0.5) * 2, (r() - 0.5) * 2, r() * 1.2], ph: r() * 0.25, sz: 0.6 + r() * 0.8 }); }
    for (let k = 0; k < pool.dust.length; k++) { const s = pool.dust[k]; s.visible = k < p.dust; if (k < p.dust) dust.push({ s, d: [(r() - 0.5) * 2, (r() - 0.5) * 2, 0.15 + r() * 0.6], ph: r() * 0.5, sz: 0.7 + r() * 0.7 }); }
    const n = Math.min(MAXS, p.sparks);
    for (let k = 0; k < n; k++) { const a = r() * Math.PI * 2, e = 0.25 + r() * 1.1, v = p.sparkV * (0.35 + r() * 0.75); sp.push([Math.cos(a) * Math.cos(e) * v, Math.sin(a) * Math.cos(e) * v, Math.sin(e) * v]); }
    sparkGeo.setDrawRange(0, n);
    core.position.set(at[0], at[1], gz + 0.25 * p.k); core.scale.setScalar((0.25 + 0.45 * p.i) * p.k); core.visible = true;
    group.visible = true;
    fx = { t0: now, p, at, gz, fire, dust, sp };
    return p;
  }
  function update(now) {
    if (!fx) return false;
    const hold = globalThis.__fsCrashHold;   // teşhis (görsel betikler, yavaş yazılım WebGL): efekt bu saniyede sabit
    const t = hold != null ? Number(hold) : (now - fx.t0) / 1000, p = fx.p, [x, y, z] = fx.at;
    // ateş topu: hızla büyür, yükselir, söner
    for (const f of fx.fire) {
      const u = (t - f.ph) / p.fireS;
      if (u < 0 || u > 1) { f.s.visible = u < 0; f.s.material.opacity = 0; continue; }
      f.s.visible = true;
      const R = p.fireR * (0.35 + 0.65 * Math.sqrt(u)) * f.sz;
      f.s.position.set(x + f.d[0] * p.fireR * 0.5 * u, y + f.d[1] * p.fireR * 0.5 * u, z + 0.5 + f.d[2] * p.fireR * 0.6 * u + 2.5 * u * u);
      f.s.scale.setScalar(R * 2);
      f.s.material.opacity = 0.95 * (1 - u) ** 1.4;
      f.s.material.color.setRGB(1, 0.75 + 0.25 * (1 - u), 0.5 + 0.5 * (1 - u));
    }
    // toz: yavaş yayılır, kalkar, söner
    for (const d of fx.dust) {
      const u = (t - d.ph) / p.dustS;
      if (u < 0 || u > 1) { d.s.material.opacity = 0; d.s.visible = u < 0; continue; }
      d.s.visible = true;
      const e = 1 - (1 - u) ** 3;
      d.s.position.set(x + d.d[0] * p.dustR * e, y + d.d[1] * p.dustR * e, fx.gz + 1 + d.d[2] * p.dustR * 0.7 * e);
      d.s.scale.setScalar((2 + p.dustR * 0.9 * e) * d.sz);
      d.s.material.opacity = 0.62 * Math.min(1, u * 8) * (1 - u) ** 1.2;
    }
    // kıvılcımlar: balistik
    const ts = Math.min(t, p.sparkS);
    for (let k = 0; k < fx.sp.length; k++) { const q = particleAt([x, y, z + 0.3], fx.sp[k], ts, fx.gz + 0.05); sparkPos[k * 3] = q[0]; sparkPos[k * 3 + 1] = q[1]; sparkPos[k * 3 + 2] = q[2]; }
    sparkGeo.attributes.position.needsUpdate = true;
    sparkMat.opacity = t < p.sparkS ? 1 - (t / p.sparkS) ** 2 : 0;
    sparks.visible = t < p.sparkS;
    // yanan enkaz: titrer, söner
    const ub = t / p.burnS;
    core.visible = ub < 1; core.material.opacity = 0.6 * (1 - ub) * (0.75 + 0.25 * Math.sin(now / 70));
    if (flashEl) flashEl.style.opacity = String(flashAt(t, p));
    const done = t > Math.max(p.fireS + 0.3, p.dustS + 0.5, p.sparkS, p.burnS, p.shakeS);
    if (done) clear();
    return !done;
  }
  function shake(now) { const hold = globalThis.__fsCrashHold; return fx ? shakeAt(hold != null ? Number(hold) : (now - fx.t0) / 1000, fx.p) : null; }
  function clear() {
    fx = null; group.visible = false; core.visible = false;
    for (const s of [...pool.fire, ...pool.dust]) { s.visible = false; s.material.opacity = 0; }
    if (flashEl) flashEl.style.opacity = '0';
  }
  function dispose() {
    clear(); scene.remove(group); scene.remove(hot);
    if (heatRoots) { const i = heatRoots.indexOf(hot); if (i >= 0) heatRoots.splice(i, 1); }
    for (const s of [...pool.fire, ...pool.dust]) s.material.dispose();
    texFire.dispose(); texDust.dispose(); sparkGeo.dispose(); sparkMat.dispose(); core.geometry.dispose(); core.material.dispose();
    flashEl?.remove();
  }
  return { trigger, update, shake, clear, dispose, get active() { return !!fx; }, get params() { return fx ? { ...fx.p } : null }, group };
}
