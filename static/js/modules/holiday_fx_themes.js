// Bayram temaları — prosedürel Canvas2D çizimleri (holiday_fx.js tembel yükler). Dış görsel YOK; yalnız ülke bayrağı flag-icons (MIT) SVG'sinden
// (static/vendor/flag-icons) çizilir ve renkleri ondan örneklenir. Koordinatlar CSS pikseli; her tema { draw(g,t,dt), still(g), resize(W,H), setDensity(d) }.
// createScene([ana, ikincil?], { W, H, density, country, lowPower }) → ana tema tam, ikincil tema yarı yoğunlukta ve büyük figürsüz (birleşik tema).

const TAU = Math.PI * 2;
const rnd = (a, b) => a + Math.random() * (b - a);
const pick = a => a[(Math.random() * a.length) | 0];
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const doc = globalThis.document;

function sprite(w, h, fn) {
  const c = doc.createElement('canvas');
  const k = 2;   // keskinlik (yüksek DPI)
  c.width = Math.ceil(w * k); c.height = Math.ceil(h * k);
  const g = c.getContext('2d');
  g.scale(k, k);
  fn(g, w, h);
  c.w = w; c.h = h;
  return c;
}
const blit = (g, s, x, y, rot = 0, sc = 1, a = 1) => {
  g.save(); g.globalAlpha *= a; g.translate(x, y); if (rot) g.rotate(rot); if (sc !== 1) g.scale(sc, sc);
  g.drawImage(s, -s.w / 2, -s.h / 2, s.w, s.h); g.restore();
};
function glow(g, x, y, r, color, a = 1) {
  const gr = g.createRadialGradient(x, y, 0, x, y, r);
  gr.addColorStop(0, color); gr.addColorStop(1, 'rgba(0,0,0,0)');
  g.save(); g.globalAlpha *= a; g.fillStyle = gr; g.beginPath(); g.arc(x, y, r, 0, TAU); g.fill(); g.restore();
}
function star(g, x, y, r, n = 5, inner = 0.45, rot = -Math.PI / 2) {
  g.beginPath();
  for (let i = 0; i < n * 2; i++) {
    const rr = i % 2 ? r * inner : r, a = rot + (i * Math.PI) / n;
    g.lineTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr);
  }
  g.closePath();
}
function heartPath(g, x, y, s) {
  g.beginPath();
  g.moveTo(x, y + s * 0.35);
  g.bezierCurveTo(x - s * 0.1, y + s * 0.2, x - s * 0.55, y + s * 0.05, x - s * 0.5, y - s * 0.22);
  g.bezierCurveTo(x - s * 0.45, y - s * 0.5, x - s * 0.08, y - s * 0.52, x, y - s * 0.25);
  g.bezierCurveTo(x + s * 0.08, y - s * 0.52, x + s * 0.45, y - s * 0.5, x + s * 0.5, y - s * 0.22);
  g.bezierCurveTo(x + s * 0.55, y + s * 0.05, x + s * 0.1, y + s * 0.2, x, y + s * 0.35);
  g.closePath();
}
const hexA = (hex, a) => { const n = parseInt(hex.slice(1), 16); return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`; };

// ------------------------------------------------------------------ parçacık havuzu
function pool(n, spawn, step, draw) {
  const ps = [];
  const P = {
    n, ps,
    fill(W, H) { while (ps.length < P.n) { const p = {}; spawn(p, W, H, true); ps.push(p); } if (ps.length > P.n) ps.length = P.n; },
    tick(g, t, dt, W, H) {
      P.fill(W, H);
      for (const p of ps) { if (step(p, dt, t, W, H) === false) spawn(p, W, H, false); draw(g, p, t); }
    },
    drawOnly(g, t) { for (const p of ps) draw(g, p, t); },
  };
  return P;
}

// ------------------------------------------------------------------ ortak sahne parçaları
function crescentSprite(r, color = '#fcd34d', withStar = true) {
  return sprite(r * 3.2, r * 2.6, (g, w, h) => {
    const cx = w * 0.42, cy = h / 2;
    const tmp = doc.createElement('canvas'); tmp.width = w * 2; tmp.height = h * 2;
    const q = tmp.getContext('2d'); q.scale(2, 2);
    const gr = q.createLinearGradient(cx - r, cy - r, cx + r, cy + r);
    gr.addColorStop(0, '#fff7cc'); gr.addColorStop(0.5, color); gr.addColorStop(1, '#d97706');
    q.fillStyle = gr; q.beginPath(); q.arc(cx, cy, r, 0, TAU); q.fill();
    q.globalCompositeOperation = 'destination-out';
    q.beginPath(); q.arc(cx + r * 0.42, cy - r * 0.12, r * 0.86, 0, TAU); q.fill();
    q.globalCompositeOperation = 'source-over';
    if (withStar) { q.fillStyle = color; star(q, cx + r * 0.95, cy - r * 0.05, r * 0.32, 5, 0.42); q.fill(); }
    g.shadowColor = 'rgba(253,224,71,.85)'; g.shadowBlur = r * 0.6;
    g.drawImage(tmp, 0, 0, w, h);
  });
}

/** Asma fener dizisi (üst kenar; zincir eğrisi): kind 'osmanli' (renkli camlı Osmanlı feneri) | 'cin' (kırmızı yuvarlak fener) */
function lanternGarland({ kind = 'osmanli', colors = ['#ef4444', '#f59e0b', '#10b981', '#3b82f6', '#a855f7'], n = 0, sag = 46, top = -4 } = {}) {
  const S = { W: 0, H: 0, items: [], sprites: new Map() };
  const sp = c => {
    if (S.sprites.has(c)) return S.sprites.get(c);
    const s = kind === 'cin'
      ? sprite(40, 60, (g, w) => {
        g.strokeStyle = '#b45309'; g.lineWidth = 1.2; g.beginPath(); g.moveTo(w / 2, 0); g.lineTo(w / 2, 8); g.stroke();
        g.fillStyle = '#b45309'; g.fillRect(w / 2 - 7, 7, 14, 5);
        const gr = g.createRadialGradient(w / 2 - 4, 26, 2, w / 2, 29, 18); gr.addColorStop(0, '#fecaca'); gr.addColorStop(0.35, c); gr.addColorStop(1, '#7f1d1d');
        g.fillStyle = gr; g.beginPath(); g.ellipse(w / 2, 29, 16, 17, 0, 0, TAU); g.fill();
        g.strokeStyle = 'rgba(253,224,71,.6)'; g.lineWidth = 0.9;
        for (const dx of [-9, 0, 9]) { g.beginPath(); g.ellipse(w / 2, 29, Math.abs(dx) * 1.2 + 1, 17, 0, 0, TAU); g.stroke(); }
        g.fillStyle = '#b45309'; g.fillRect(w / 2 - 7, 45, 14, 4);
        g.strokeStyle = '#facc15'; g.lineWidth = 1.4; for (let i = -3; i <= 3; i++) { g.beginPath(); g.moveTo(w / 2 + i * 1.6, 49); g.lineTo(w / 2 + i * 2, 59); g.stroke(); }
      })
      : sprite(30, 62, (g, w) => {
        g.strokeStyle = '#a16207'; g.lineWidth = 1.2; g.beginPath(); g.moveTo(w / 2, 0); g.lineTo(w / 2, 6); g.stroke();
        g.fillStyle = '#ca8a04'; g.beginPath(); g.arc(w / 2, 9, 4, Math.PI, 0); g.fill();   // tepe kubbesi
        g.beginPath(); g.moveTo(w / 2 - 9, 13); g.lineTo(w / 2 + 9, 13); g.lineTo(w / 2 + 6, 9); g.lineTo(w / 2 - 6, 9); g.fill();
        // gövde: altıgen camlı Osmanlı feneri
        const gr = g.createLinearGradient(w / 2 - 11, 0, w / 2 + 11, 0); gr.addColorStop(0, c); gr.addColorStop(0.45, '#fff7ed'); gr.addColorStop(1, c);
        g.fillStyle = gr; g.beginPath();
        g.moveTo(w / 2 - 8, 13); g.lineTo(w / 2 + 8, 13); g.lineTo(w / 2 + 12, 26); g.lineTo(w / 2 + 10, 42); g.lineTo(w / 2 - 10, 42); g.lineTo(w / 2 - 12, 26); g.closePath(); g.fill();
        g.strokeStyle = '#a16207'; g.lineWidth = 1.3; g.stroke();
        g.beginPath(); g.moveTo(w / 2, 13); g.lineTo(w / 2, 42); g.moveTo(w / 2 - 12, 26); g.lineTo(w / 2 + 12, 26); g.stroke();
        g.fillStyle = 'rgba(255,255,255,.55)'; star(g, w / 2, 33, 3.2, 8, 0.5); g.fill();
        g.fillStyle = '#ca8a04'; g.beginPath(); g.moveTo(w / 2 - 10, 42); g.lineTo(w / 2 + 10, 42); g.lineTo(w / 2 + 4, 49); g.lineTo(w / 2 - 4, 49); g.fill();
        g.fillStyle = '#eab308'; g.beginPath(); g.moveTo(w / 2 - 2, 49); g.lineTo(w / 2 + 2, 49); g.lineTo(w / 2, 60); g.fill();
      });
    S.sprites.set(c, s);
    return s;
  };
  const layout = (W, H) => {
    S.W = W; S.H = H;
    const cnt = n || clamp(Math.round(W / 150), 4, 11);
    S.items = Array.from({ length: cnt }, (_, i) => ({ u: (i + 0.5) / cnt, c: colors[i % colors.length], ph: rnd(0, TAU), len: rnd(8, 26) }))
      .filter(it => !(it.u > 0.4 && it.u < 0.6));   // ortada logo / başlık var: fener asılmaz (ip ve ışıklar sürer)
  };
  const yAt = u => top + sag * 4 * u * (1 - u);
  return {
    resize: layout,
    draw(g, t) {
      if (!S.items.length) return;
      const W = S.W;
      g.save();
      g.strokeStyle = 'rgba(120,80,30,.55)'; g.lineWidth = 1.4; g.beginPath();
      for (let i = 0; i <= 40; i++) { const u = i / 40; g.lineTo(u * W, yAt(u) + Math.sin(t * 0.8 + u * 6) * 1.5); } g.stroke();
      // ipteki küçük ışıklar
      for (let i = 1; i < 40; i += 2) {
        const u = i / 40, x = u * W, y = yAt(u) + 2, tw = 0.5 + 0.5 * Math.sin(t * 3 + i * 1.7);
        g.fillStyle = `rgba(255,236,170,${0.35 + tw * 0.55})`; g.beginPath(); g.arc(x, y, 1.8, 0, TAU); g.fill();
      }
      for (const it of S.items) {
        const x = it.u * W, y = yAt(it.u) + Math.sin(t * 0.8 + it.u * 6) * 1.5;
        const rot = Math.sin(t * 1.3 + it.ph) * 0.08;
        g.save(); g.translate(x, y); g.rotate(rot);
        g.strokeStyle = 'rgba(120,80,30,.7)'; g.lineWidth = 1; g.beginPath(); g.moveTo(0, 0); g.lineTo(0, it.len); g.stroke();
        const s = sp(it.c);
        const flick = 0.75 + 0.25 * Math.sin(t * 7 + it.ph * 3) * Math.sin(t * 3.1 + it.ph);
        glow(g, 0, it.len + s.h * 0.48, s.w * 1.25, kind === 'cin' ? 'rgba(255,90,60,.55)' : 'rgba(255,214,120,.6)', flick);
        g.drawImage(s, -s.w / 2, it.len, s.w, s.h);
        g.restore();
      }
      g.restore();
    },
  };
}

/** Pırıltı (yıldız/altın ışıltı) — yerinde göz kırpar */
let LIGHT = false;   // açık zemin: soluk altın pırıltılar koyu altına döner (createScene ayarlar)
function twinkles(count, colors = ['#fde68a', '#fff7cc', '#fcd34d'], area = 0.55) {
  const cols = () => (LIGHT ? ['#d97706', '#b45309', '#ca8a04'] : colors);
  return pool(count, (p, W, H) => { p.x = rnd(0, W); p.y = rnd(0, H * area); p.r = rnd(0.8, 2.4); p.ph = rnd(0, TAU); p.sp = rnd(1, 3); p.c = pick(cols()); p.vy = rnd(-4, -1); p.life = rnd(4, 9); },
    (p, dt) => { p.y += p.vy * dt; p.life -= dt; return p.life > 0; },
    (g, p, t) => {
      const a = clamp(0.5 + 0.5 * Math.sin(t * p.sp + p.ph), 0, 1) * clamp(p.life, 0, 1);
      g.globalAlpha = a; g.fillStyle = p.c;
      g.beginPath(); g.moveTo(p.x, p.y - p.r * 2.4); g.lineTo(p.x + p.r * 0.5, p.y - p.r * 0.5); g.lineTo(p.x + p.r * 2.4, p.y); g.lineTo(p.x + p.r * 0.5, p.y + p.r * 0.5);
      g.lineTo(p.x, p.y + p.r * 2.4); g.lineTo(p.x - p.r * 0.5, p.y + p.r * 0.5); g.lineTo(p.x - p.r * 2.4, p.y); g.lineTo(p.x - p.r * 0.5, p.y - p.r * 0.5); g.fill();
      g.globalAlpha = 1;
    });
}

/** Konfeti (yalpalayan dikdörtgen + şerit) */
function confetti(count, colors) {
  return pool(count, (p, W, H, init) => {
    p.x = rnd(0, W); p.y = init ? rnd(-H, H) : rnd(-60, -10); p.vy = rnd(40, 90); p.vx = rnd(-15, 15); p.w = rnd(5, 9); p.h = rnd(8, 14);
    p.rot = rnd(0, TAU); p.vr = rnd(-4, 4); p.fl = rnd(3, 8); p.ph = rnd(0, TAU); p.c = pick(colors()); p.sh = Math.random() < 0.25 ? 'c' : 'r';
  }, (p, dt, t, W, H) => { p.y += p.vy * dt; p.x += (p.vx + Math.sin(t * 1.4 + p.ph) * 22) * dt; p.rot += p.vr * dt; return p.y < H + 20; },
  (g, p, t) => {
    g.save(); g.translate(p.x, p.y); g.rotate(p.rot); g.scale(Math.cos(t * p.fl + p.ph), 1); g.fillStyle = p.c;
    if (p.sh === 'c') { g.beginPath(); g.arc(0, 0, p.w * 0.45, 0, TAU); g.fill(); } else g.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
    g.restore();
  });
}

/** Havai fişek (roket + patlama + kuyruk) */
function fireworks(rate, colors, { area = 0.55 } = {}) {
  const S = { rockets: [], sparks: [], acc: 0 };
  return {
    rate,
    draw(g, t, dt, W, H) {
      S.acc += dt * this.rate;
      while (S.acc > 1) {
        S.acc -= 1;
        const tx = rnd(W * 0.12, W * 0.88), ty = rnd(H * 0.1, H * area);
        S.rockets.push({ x: tx + rnd(-40, 40), y: H + 10, tx, ty, c: pick(colors()), c2: pick(colors()), v: rnd(520, 700) });
      }
      g.save(); g.globalCompositeOperation = 'lighter';
      for (let i = S.rockets.length - 1; i >= 0; i--) {
        const r = S.rockets[i];
        const dx = r.tx - r.x, dy = r.ty - r.y, d = Math.hypot(dx, dy);
        const st = Math.min(d, r.v * dt);
        r.x += (dx / (d || 1)) * st; r.y += (dy / (d || 1)) * st;
        g.strokeStyle = hexA('#fff1c2', 0.75); g.lineWidth = 2; g.beginPath(); g.moveTo(r.x, r.y); g.lineTo(r.x - (dx / (d || 1)) * 18, r.y - (dy / (d || 1)) * 18); g.stroke();
        if (d < 6) {
          const n = 46 + ((Math.random() * 30) | 0), sp = rnd(140, 230), ring = Math.random() < 0.35;
          for (let k = 0; k < n; k++) {
            const a = (k / n) * TAU + rnd(-0.05, 0.05), v = ring ? sp : sp * Math.sqrt(Math.random());
            S.sparks.push({ x: r.x, y: r.y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, life: rnd(1.1, 1.8), max: 1.8, c: k % 3 ? r.c : r.c2, px: r.x, py: r.y });
          }
          S.sparks.push({ flash: 1, x: r.x, y: r.y, life: 0.25, max: 0.25, c: r.c });
          S.rockets.splice(i, 1);
        }
      }
      for (let i = S.sparks.length - 1; i >= 0; i--) {
        const s = S.sparks[i];
        s.life -= dt;
        if (s.life <= 0) { S.sparks.splice(i, 1); continue; }
        if (s.flash) { glow(g, s.x, s.y, 70 * (s.life / s.max), hexA(s.c, 0.55)); continue; }
        s.px = s.x; s.py = s.y;
        s.vx *= 0.985; s.vy = s.vy * 0.985 + 90 * dt;
        s.x += s.vx * dt; s.y += s.vy * dt;
        const a = clamp(s.life / s.max, 0, 1);
        g.strokeStyle = hexA(s.c, a); g.lineWidth = 2.2; g.beginPath(); g.moveTo(s.px, s.py); g.lineTo(s.x, s.y); g.stroke();
        if (Math.random() < 0.08) { g.fillStyle = hexA('#ffffff', a); g.fillRect(s.x, s.y, 1.5, 1.5); }
      }
      g.restore();
    },
  };
}

/** Kar */
function snow(count, light = false) {   // açık zeminde (HEPGO açık tema) beyaz kar görünmez → buz mavisi + ince gölge
  return pool(count, (p, W, H, init) => { p.z = rnd(0.3, 1); p.x = rnd(0, W); p.y = init ? rnd(0, H) : -8; p.r = 1 + p.z * 2.6; p.vy = 14 + p.z * 38; p.ph = rnd(0, TAU); },
    (p, dt, t, W, H) => { p.y += p.vy * dt; p.x += Math.sin(t * 0.7 + p.ph) * 14 * dt * p.z; return p.y < H + 8; },
    (g, p) => { g.fillStyle = light ? `rgba(125,160,200,${0.35 + p.z * 0.45})` : `rgba(255,255,255,${0.45 + p.z * 0.45})`; g.beginPath(); g.arc(p.x, p.y, p.r, 0, TAU); g.fill(); });
}

/** Düşen sprite'lar (şeker, yumurta, yaprak, karanfil…) — bounce: yere değince seker ve söner */
function fallers(count, sprites, { vy = [40, 80], spin = 2, sway = 18, bounce = false, scale = [0.7, 1.15], up = false } = {}) {
  return pool(count, (p, W, H, init) => {
    p.s = pick(sprites()); p.sc = rnd(scale[0], scale[1]); p.x = rnd(0, W);
    p.y = up ? (init ? rnd(0, H) : H + 30) : (init ? rnd(-H, H * 0.9) : rnd(-80, -20));
    p.vy = rnd(vy[0], vy[1]) * (up ? -1 : 1); p.rot = rnd(0, TAU); p.vr = rnd(-spin, spin); p.ph = rnd(0, TAU); p.land = 0; p.a = 1;
  }, (p, dt, t, W, H) => {
    if (p.land) { p.land += dt; p.a = clamp(1 - (p.land - 1.2) / 0.8, 0, 1); p.vy += 600 * dt; p.y = Math.min(p.y + p.vy * dt, p.floor); p.rot += p.vr * dt * 0.3; return p.land < 2; }
    p.y += p.vy * dt; p.x += Math.sin(t * 1.1 + p.ph) * sway * dt; p.rot += p.vr * dt;
    if (bounce && p.y > H - 10 - (p.s.h * p.sc) / 2) { p.floor = H - 8 - (p.s.h * p.sc) / 2; p.y = p.floor; p.vy = -p.vy * 0.32; p.land = 0.001; p.vr *= 0.5; }
    return up ? p.y > -40 : p.y < H + 40;
  }, (g, p) => blit(g, p.s, p.x, p.y, p.rot, p.sc, p.a));
}

/** Ülke bayrağı (flag-icons SVG) + renk örnekleme */
const FLAG_CACHE = new Map();
function loadFlag(country) {
  const c = String(country || '').toLowerCase();
  if (!/^[a-z]{2}$/.test(c)) return null;
  if (FLAG_CACHE.has(c)) return FLAG_CACHE.get(c);
  const F = { img: null, colors: null, ready: false };
  const im = new Image();
  im.decoding = 'async';
  im.onload = () => {
    // SVG'nin doğal boyutu tarayıcıya göre değişir (viewBox'lı, width/height'sız) → sabit 320×240 tuvale bir kez çizilir; dilimleme bu tuvalden yapılır
    const rc = doc.createElement('canvas'); rc.width = 320; rc.height = 240;
    try { rc.getContext('2d').drawImage(im, 0, 0, 320, 240); F.img = rc; } catch { F.img = im; }
    F.ready = true;
    try {
      const cv = doc.createElement('canvas'); cv.width = 48; cv.height = 36;
      const q = cv.getContext('2d'); q.drawImage(im, 0, 0, 48, 36);
      const d = q.getImageData(0, 0, 48, 36).data, cnt = new Map();
      for (let i = 0; i < d.length; i += 4) {
        const key = ((d[i] >> 4) << 8) | ((d[i + 1] >> 4) << 4) | (d[i + 2] >> 4);
        cnt.set(key, (cnt.get(key) || 0) + 1);
      }
      const top = [...cnt.entries()].sort((a, b) => b[1] - a[1]).filter(e => e[1] > 30).slice(0, 4)
        .map(([k]) => '#' + [k >> 8, (k >> 4) & 15, k & 15].map(v => (v * 17).toString(16).padStart(2, '0')).join(''));
      F.colors = top.length ? top : null;
    } catch { /* */ }
  };
  im.src = `/static/vendor/flag-icons/4x3/${c}.svg`;
  FLAG_CACHE.set(c, F);
  return F;
}
const FLAG_FALLBACK = ['#e11d48', '#ffffff', '#2563eb', '#facc15'];

/** Dalgalanan bayrak (dikey şeritler sinüsle kaydırılır + gölgelenir) */
function drawWavingFlag(g, F, x, y, w, t, { pole = true, amp = 0.06 } = {}) {
  const h = w * 0.75;
  if (pole) {
    const gr = g.createLinearGradient(x - 5, 0, x + 1, 0); gr.addColorStop(0, '#9ca3af'); gr.addColorStop(0.5, '#f3f4f6'); gr.addColorStop(1, '#6b7280');
    g.fillStyle = gr; g.fillRect(x - 5, y - 6, 5, h * 2.6);
    g.fillStyle = '#facc15'; g.beginPath(); g.arc(x - 2.5, y - 8, 4.5, 0, TAU); g.fill();
  }
  if (!F?.ready) return;
  const N = 28, sw = w / N, iw = F.img.width || 320, ih = F.img.height || 240;
  for (let i = 0; i < N; i++) {
    const u = i / N, k = u, off = Math.sin(t * 3.2 - u * 7) * w * amp * k, sh = Math.cos(t * 3.2 - u * 7) * k;
    g.drawImage(F.img, u * iw, 0, iw / N + 1, ih, x + i * sw, y + off, sw + 0.8, h);
    g.fillStyle = sh > 0 ? `rgba(255,255,255,${sh * 0.16})` : `rgba(0,0,0,${-sh * 0.22})`;
    g.fillRect(x + i * sw, y + off, sw + 0.8, h);
  }
}

/** Yürüyen figürler (alt kenar boyunca): koyun, tavşan … */
function walkers(n, make) {
  const S = { W: 0, H: 0, ws: [] };
  return {
    resize(W, H) { S.W = W; S.H = H; if (S.ws.length !== n) S.ws = Array.from({ length: n }, (_, i) => make.init({}, W, H, i, n)); },
    draw(g, t, dt) { for (const w of S.ws) { make.step(w, dt, t, S.W, S.H); make.draw(g, w, t); } },
    get list() { return S.ws; },
  };
}

// ------------------------------------------------------------------ KOYUN (Kurban)
function sheepKit() {
  const body = sprite(64, 44, (g) => {
    const blobs = [[20, 24, 12], [32, 18, 13], [44, 22, 12], [26, 30, 12], [40, 30, 12], [50, 27, 9], [14, 28, 9], [33, 26, 14]];
    g.fillStyle = 'rgba(0,0,0,.08)';
    for (const [x, y, r] of blobs) { g.beginPath(); g.arc(x + 1, y + 2, r, 0, TAU); g.fill(); }
    for (const [x, y, r] of blobs) {
      const gr = g.createRadialGradient(x - r * 0.35, y - r * 0.4, 1, x, y, r);
      gr.addColorStop(0, '#ffffff'); gr.addColorStop(0.7, '#f4efe4'); gr.addColorStop(1, '#ddd3c2');
      g.fillStyle = gr; g.beginPath(); g.arc(x, y, r, 0, TAU); g.fill();
    }
    g.strokeStyle = 'rgba(160,140,110,.35)'; g.lineWidth = 0.8;   // yün kıvırcıkları
    for (let i = 0; i < 16; i++) { const x = 14 + Math.random() * 38, y = 14 + Math.random() * 22; g.beginPath(); g.arc(x, y, 2.4, 0.3, 2.6); g.stroke(); }
  });
  return { body };
}
function sheepWalkers(count) {
  const K = sheepKit();
  const RIB = ['#dc2626', '#e11d48', '#f59e0b', '#16a34a', '#7c3aed'];
  return walkers(count, {
    init(w, W, H, i, n) {
      const big = clamp(W / 1100, 0.85, 1.45);
      Object.assign(w, { x: ((i + 0.5) / n) * W + rnd(-40, 40), dir: Math.random() < 0.5 ? -1 : 1, sp: rnd(18, 32), sc: rnd(0.9, 1.15) * big, ph: rnd(0, TAU),
        state: 'walk', st: rnd(2, 7), hop: 0, rib: i % 2 === 0 ? RIB[i % RIB.length] : null, bell: i % 3 === 1, head: 0, baa: 0 });
      return w;
    },
    step(w, dt, t, W) {
      w.st -= dt;
      if (w.st <= 0) {
        const r = Math.random();
        w.state = w.state === 'walk' ? (r < 0.55 ? 'graze' : r < 0.8 ? 'hop' : 'walk') : 'walk';
        w.st = w.state === 'graze' ? rnd(2.5, 5) : w.state === 'hop' ? 0.55 : rnd(3, 8);
        if (w.state === 'walk' && Math.random() < 0.25) w.dir *= -1;
        if (w.state === 'hop') w.hop = 0.001;
        if (Math.random() < 0.15) w.baa = 1.6;
      }
      if (w.baa > 0) w.baa -= dt;
      const moving = w.state !== 'graze';
      if (moving) w.x += w.dir * w.sp * (w.state === 'hop' ? 2.2 : 1) * dt;
      if (w.hop) { w.hop += dt; if (w.hop > 0.55) w.hop = 0; }
      w.head += ((w.state === 'graze' ? 1 : 0) - w.head) * Math.min(1, dt * 4);
      if (w.x < -40) { w.x = -40; w.dir = 1; } if (w.x > W + 40) { w.x = W + 40; w.dir = -1; }
    },
    draw(g, w, t) {
      const H = g.canvas.height / (g.getTransform().d || 1);
      const ground = H - 6;
      const walk = w.state !== 'graze';
      const lift = w.hop ? Math.sin((w.hop / 0.55) * Math.PI) * 26 : Math.abs(Math.sin(t * 7 + w.ph)) * (walk ? 1.6 : 0);
      g.save(); g.translate(w.x, ground); g.scale(w.sc * w.dir, w.sc);
      g.fillStyle = 'rgba(0,0,0,.18)'; g.beginPath(); g.ellipse(0, 0, 26 - lift * 0.3, 4, 0, 0, TAU); g.fill();
      g.translate(0, -lift);
      // bacaklar
      g.strokeStyle = '#3f3a36'; g.lineWidth = 3.4; g.lineCap = 'round';
      const sw = walk ? Math.sin(t * 7 + w.ph) * 0.45 : 0;
      for (const [lx, s] of [[-14, 1], [-8, -1], [10, -1], [16, 1]]) {
        const a = w.hop ? s * 0.5 : sw * s;
        g.beginPath(); g.moveTo(lx, -14); g.lineTo(lx + Math.sin(a) * 9, -14 + Math.cos(a) * 13); g.stroke();
      }
      // gövde
      g.drawImage(K.body, -32, -44, 64, 44);
      // kuyruk (gövdeye bitişik, sallanır)
      g.fillStyle = '#efe8da'; g.beginPath(); g.arc(-27, -27 + Math.sin(t * 9 + w.ph) * 1.2, 5.5, 0, TAU); g.fill();
      // baş (otlarken aşağı eğilir): kara yüzlü koyun — kulak, yün perçem, iri göz, pembe yanak
      g.save(); g.translate(25, -31); g.rotate(0.12 + w.head * 0.95);
      g.fillStyle = '#2b221e'; g.beginPath(); g.ellipse(1, 3, 7.5, 3.2, -0.7 + Math.sin(t * 2 + w.ph) * 0.25, 0, TAU); g.fill();   // kulak
      const hg = g.createLinearGradient(0, -8, 0, 12); hg.addColorStop(0, '#4a3b34'); hg.addColorStop(1, '#2f2521');
      g.fillStyle = hg; g.beginPath(); g.ellipse(9, 3, 11.5, 8.6, 0.4, 0, TAU); g.fill();
      g.fillStyle = '#f7f2e8'; for (const [x, y, r] of [[2, -6, 5.2], [7, -8, 4.6], [-2, -2, 4.4]]) { g.beginPath(); g.arc(x, y, r, 0, TAU); g.fill(); }   // perçem
      g.fillStyle = '#fff'; g.beginPath(); g.ellipse(12.5, 0, 2.7, 3, 0, 0, TAU); g.fill();
      g.fillStyle = '#111'; g.beginPath(); g.arc(13.3, 0.6, 1.5, 0, TAU); g.fill();
      g.fillStyle = '#fff'; g.beginPath(); g.arc(13.8, -0.2, 0.55, 0, TAU); g.fill();
      g.fillStyle = 'rgba(244,114,182,.55)'; g.beginPath(); g.ellipse(15.5, 6, 2.4, 1.5, 0.3, 0, TAU); g.fill();
      g.fillStyle = '#1c1512'; g.beginPath(); g.arc(19.3, 6.5, 0.9, 0, TAU); g.fill();
      g.restore();
      // kurdele + çan
      if (w.rib) {
        g.fillStyle = w.rib; g.beginPath(); g.moveTo(20, -36); g.lineTo(26, -20); g.lineTo(22, -19); g.lineTo(16, -34); g.fill();
        g.beginPath(); g.ellipse(23, -21, 5, 3, 0.6, 0, TAU); g.ellipse(18, -18, 5, 3, -0.6, 0, TAU); g.fill();
      }
      if (w.bell) { g.fillStyle = '#eab308'; g.beginPath(); g.arc(24, -16 + Math.sin(t * 7 + w.ph) * 0.8, 3.2, 0, TAU); g.fill(); g.fillStyle = '#854d0e'; g.fillRect(23.3, -13.6, 1.4, 1.6); }
      g.restore();
      // "mee" balonu
      if (w.baa > 0) {
        const a = clamp(w.baa, 0, 1);
        g.save(); g.globalAlpha = a; g.font = '600 12px system-ui,sans-serif'; g.fillStyle = 'rgba(255,255,255,.92)';
        const bx = w.x + w.dir * 30 * w.sc, by = ground - 66 * w.sc - lift;
        g.beginPath(); g.roundRect?.(bx - 20, by - 13, 40, 20, 9); g.fill();
        g.fillStyle = '#44403c'; g.textAlign = 'center'; g.fillText('mee', bx, by + 1); g.restore();
      }
    },
  });
}

// ------------------------------------------------------------------ ŞEKER / LOKUM (Ramazan)
function candySprites() {
  const wrapCols = [['#ef4444', '#fecaca'], ['#f59e0b', '#fef3c7'], ['#10b981', '#d1fae5'], ['#3b82f6', '#dbeafe'], ['#a855f7', '#f3e8ff'], ['#ec4899', '#fce7f3']];
  const out = [];
  for (const [c1, c2] of wrapCols) {
    out.push(sprite(46, 22, (g, w, h) => {   // sargılı şeker: iki uç büklümü + çizgili gövde
      const cx = w / 2, cy = h / 2;
      g.fillStyle = c1;
      for (const s of [-1, 1]) {
        g.beginPath(); g.moveTo(cx + s * 9, cy); g.lineTo(cx + s * 21, cy - 9); g.quadraticCurveTo(cx + s * 17, cy, cx + s * 21, cy + 9); g.closePath(); g.fill();
        g.strokeStyle = 'rgba(255,255,255,.5)'; g.lineWidth = 0.8; g.beginPath(); g.moveTo(cx + s * 11, cy); g.lineTo(cx + s * 19, cy - 6); g.moveTo(cx + s * 11, cy); g.lineTo(cx + s * 19, cy + 6); g.stroke();
      }
      const gr = g.createLinearGradient(0, cy - 8, 0, cy + 8); gr.addColorStop(0, c2); gr.addColorStop(0.5, c1); gr.addColorStop(1, c1);
      g.fillStyle = gr; g.beginPath(); g.ellipse(cx, cy, 11, 8, 0, 0, TAU); g.fill();
      g.save(); g.beginPath(); g.ellipse(cx, cy, 11, 8, 0, 0, TAU); g.clip();
      g.strokeStyle = 'rgba(255,255,255,.75)'; g.lineWidth = 2.2;
      for (let i = -3; i <= 3; i++) { g.beginPath(); g.moveTo(cx + i * 6 - 6, cy - 9); g.lineTo(cx + i * 6 + 6, cy + 9); g.stroke(); }
      g.restore();
      g.fillStyle = 'rgba(255,255,255,.7)'; g.beginPath(); g.ellipse(cx - 3, cy - 4, 4, 1.6, -0.3, 0, TAU); g.fill();
    }));
  }
  for (const [c, c2] of [['#f9a8d4', '#fdf2f8'], ['#fde68a', '#fffbeb'], ['#86efac', '#f0fdf4'], ['#fca5a5', '#fff1f2']]) {
    out.push(sprite(20, 20, (g, w, h) => {   // lokum: yumuşak köşeli küp + pudra şekeri
      g.fillStyle = 'rgba(0,0,0,.12)'; g.beginPath(); g.roundRect?.(3, 4, 15, 15, 4); g.fill();
      const gr = g.createLinearGradient(2, 2, 18, 18); gr.addColorStop(0, c2); gr.addColorStop(0.4, c); gr.addColorStop(1, c);
      g.fillStyle = gr; g.beginPath(); g.roundRect?.(2, 2, 15, 15, 4); g.fill();
      g.fillStyle = 'rgba(255,255,255,.95)';
      for (let i = 0; i < 26; i++) g.fillRect(2 + Math.random() * 15, 2 + Math.random() * 15, 0.9, 0.9);
      if (c === '#fde68a') { g.fillStyle = '#65a30d'; for (const [x, y] of [[7, 8], [12, 12], [10, 6]]) { g.beginPath(); g.arc(x, y, 1.2, 0, TAU); g.fill(); } }   // fıstıklı
    }));
  }
  out.push(sprite(18, 18, (g) => {   // altın yaldızlı çikolata
    const gr = g.createRadialGradient(7, 6, 1, 9, 9, 9); gr.addColorStop(0, '#fff7cc'); gr.addColorStop(0.5, '#facc15'); gr.addColorStop(1, '#a16207');
    g.fillStyle = gr; g.beginPath(); g.arc(9, 9, 8, 0, TAU); g.fill();
    g.strokeStyle = 'rgba(120,80,0,.5)'; g.lineWidth = 0.7; for (let a = 0; a < TAU; a += TAU / 10) { g.beginPath(); g.moveTo(9, 9); g.lineTo(9 + Math.cos(a) * 8, 9 + Math.sin(a) * 8); g.stroke(); }
  }));
  return out;
}

// ------------------------------------------------------------------ çeşitli sprite üreticileri
function eggSprites() {
  const cols = [['#f472b6', '#fde68a'], ['#60a5fa', '#fef9c3'], ['#34d399', '#fbcfe8'], ['#fbbf24', '#c4b5fd'], ['#a78bfa', '#a7f3d0']];
  return cols.map(([a, b], i) => sprite(22, 28, (g, w, h) => {
    g.save(); g.beginPath(); g.moveTo(11, 1); g.bezierCurveTo(21, 1, 22, 20, 11, 27); g.bezierCurveTo(0, 20, 1, 1, 11, 1); g.closePath(); g.clip();
    g.fillStyle = a; g.fillRect(0, 0, w, h);
    g.fillStyle = b;
    if (i % 3 === 0) for (let y = 6; y < 28; y += 7) { g.beginPath(); for (let x = 0; x <= 22; x += 3) g.lineTo(x, y + (x / 3 % 2 ? -2 : 2)); g.lineTo(22, y + 3); g.lineTo(0, y + 3); g.fill(); }
    else if (i % 3 === 1) for (let k = 0; k < 9; k++) { g.beginPath(); g.arc(3 + (k % 3) * 8, 6 + ((k / 3) | 0) * 8, 2, 0, TAU); g.fill(); }
    else { g.fillRect(0, 11, 22, 4); g.fillStyle = '#fff'; g.fillRect(0, 17, 22, 2); }
    g.fillStyle = 'rgba(255,255,255,.4)'; g.beginPath(); g.ellipse(7, 8, 2.5, 5, -0.3, 0, TAU); g.fill();
    g.restore();
  }));
}
function flowerSprites(cols = ['#f9a8d4', '#fde047', '#c4b5fd', '#fdba74', '#ffffff']) {
  return cols.map(c => sprite(18, 18, (g) => {
    g.fillStyle = c; for (let k = 0; k < 5; k++) { const a = (k / 5) * TAU; g.beginPath(); g.ellipse(9 + Math.cos(a) * 4.6, 9 + Math.sin(a) * 4.6, 4.2, 3, a, 0, TAU); g.fill(); }
    g.fillStyle = '#facc15'; g.beginPath(); g.arc(9, 9, 2.6, 0, TAU); g.fill();
  }));
}
function petalSprites(cols = ['#fda4af', '#f9a8d4', '#fecdd3', '#fbcfe8']) {
  return cols.map(c => sprite(14, 10, (g) => {
    const gr = g.createLinearGradient(0, 0, 14, 10); gr.addColorStop(0, '#fff'); gr.addColorStop(0.4, c); gr.addColorStop(1, c);
    g.fillStyle = gr; g.beginPath(); g.moveTo(1, 5); g.quadraticCurveTo(7, -2, 13, 5); g.quadraticCurveTo(7, 12, 1, 5); g.fill();
  }));
}
function heartSprites(cols = ['#f43f5e', '#ec4899', '#fb7185', '#e11d48', '#f472b6']) {
  return cols.map(c => sprite(26, 24, (g) => {
    const gr = g.createRadialGradient(9, 8, 1, 13, 12, 14); gr.addColorStop(0, '#ffe4e6'); gr.addColorStop(0.35, c); gr.addColorStop(1, c);
    g.fillStyle = gr; heartPath(g, 13, 12, 22); g.fill();
  }));
}
function carnationSprite() {
  return sprite(28, 40, (g) => {
    g.strokeStyle = '#15803d'; g.lineWidth = 2; g.beginPath(); g.moveTo(14, 16); g.quadraticCurveTo(12, 28, 15, 40); g.stroke();
    g.fillStyle = '#16a34a'; g.beginPath(); g.ellipse(18, 30, 5, 1.8, -0.6, 0, TAU); g.fill();
    g.fillStyle = '#166534'; g.beginPath(); g.moveTo(9, 15); g.lineTo(19, 15); g.lineTo(14, 22); g.fill();
    for (let k = 0; k < 14; k++) {
      const a = Math.PI + (k / 13) * Math.PI, r = 7 + (k % 3) * 2;
      g.fillStyle = k % 2 ? '#dc2626' : '#ef4444';
      g.beginPath(); g.arc(14 + Math.cos(a) * r * 0.75, 12 + Math.sin(a) * r * 0.6, 4.2, 0, TAU); g.fill();
    }
    g.fillStyle = '#b91c1c'; g.beginPath(); g.arc(14, 11, 4, 0, TAU); g.fill();
    g.strokeStyle = 'rgba(255,255,255,.35)'; g.lineWidth = 0.7; for (let k = 0; k < 8; k++) { g.beginPath(); g.arc(14 + rnd(-7, 7), 9 + rnd(-4, 3), 2.5, 0, 2); g.stroke(); }
  });
}
function lotusSprite() {
  return sprite(54, 30, (g) => {
    g.fillStyle = 'rgba(16,185,129,.55)'; g.beginPath(); g.ellipse(27, 25, 25, 5, 0, 0, TAU); g.fill();
    const pet = (a, len, c) => { g.save(); g.translate(27, 24); g.rotate(a); const gr = g.createLinearGradient(0, 0, 0, -len); gr.addColorStop(0, '#fff'); gr.addColorStop(1, c);
      g.fillStyle = gr; g.beginPath(); g.moveTo(0, 0); g.quadraticCurveTo(-7, -len * 0.6, 0, -len); g.quadraticCurveTo(7, -len * 0.6, 0, 0); g.fill(); g.restore(); };
    for (const a of [-1.2, 1.2]) pet(a, 16, '#f9a8d4');
    for (const a of [-0.7, 0.7]) pet(a, 19, '#f472b6');
    for (const a of [-0.25, 0.25]) pet(a, 21, '#ec4899');
    pet(0, 22, '#f472b6');
  });
}
function pumpkinSprite() {
  return sprite(44, 38, (g) => {
    for (const [dx, r] of [[-11, 11], [11, 11], [-5, 13], [5, 13], [0, 14]]) {
      const gr = g.createRadialGradient(22 + dx - 3, 18, 2, 22 + dx, 22, r); gr.addColorStop(0, '#fdba74'); gr.addColorStop(1, '#c2410c');
      g.fillStyle = gr; g.beginPath(); g.ellipse(22 + dx, 23, r * 0.8, r, 0, 0, TAU); g.fill();
    }
    g.fillStyle = '#3f6212'; g.fillRect(20, 4, 4, 7);
    g.fillStyle = '#1c1917';
    g.beginPath(); g.moveTo(13, 20); g.lineTo(18, 15); g.lineTo(19, 21); g.fill();
    g.beginPath(); g.moveTo(31, 20); g.lineTo(26, 15); g.lineTo(25, 21); g.fill();
    g.beginPath(); g.moveTo(12, 26); g.lineTo(16, 30); g.lineTo(19, 27); g.lineTo(22, 31); g.lineTo(25, 27); g.lineTo(28, 30); g.lineTo(32, 26); g.quadraticCurveTo(22, 36, 12, 26); g.fill();
  });
}
function diyaSprite() {
  return sprite(36, 18, (g) => {
    const gr = g.createLinearGradient(0, 4, 0, 18); gr.addColorStop(0, '#ea580c'); gr.addColorStop(1, '#7c2d12');
    g.fillStyle = gr; g.beginPath(); g.moveTo(2, 5); g.quadraticCurveTo(18, 24, 34, 5); g.quadraticCurveTo(28, 2, 30, 5); g.lineTo(6, 5); g.quadraticCurveTo(8, 2, 2, 5); g.fill();
    g.strokeStyle = '#fde047'; g.lineWidth = 1; g.beginPath(); g.moveTo(5, 7); g.quadraticCurveTo(18, 18, 31, 7); g.stroke();
    g.fillStyle = '#fde047'; for (const x of [10, 18, 26]) { g.beginPath(); g.arc(x, 11 - (x === 18 ? 0 : 1), 1.4, 0, TAU); g.fill(); }
  });
}
function flame(g, x, y, s, t, ph) {
  const f = 1 + Math.sin(t * 13 + ph) * 0.12 + Math.sin(t * 7.3 + ph * 2) * 0.08;
  glow(g, x, y - s * 0.6, s * 3.2, 'rgba(255,170,60,.45)');
  const gr = g.createRadialGradient(x, y - s * 0.3, 0, x, y - s * 0.4, s * 1.2 * f);
  gr.addColorStop(0, '#fffbe6'); gr.addColorStop(0.45, '#fde047'); gr.addColorStop(1, 'rgba(249,115,22,0)');
  g.fillStyle = gr; g.beginPath(); g.moveTo(x - s * 0.5, y); g.quadraticCurveTo(x - s * 0.55, y - s * 0.8, x + Math.sin(t * 5 + ph) * s * 0.2, y - s * 1.9 * f);
  g.quadraticCurveTo(x + s * 0.55, y - s * 0.8, x + s * 0.5, y); g.closePath(); g.fill();
}

// ------------------------------------------------------------------ TEMALAR
// Her fabrika: (ctx) → { draw(g,t,dt), still(g), resize(W,H), setDensity(d) }; ctx = { W,H, density, country, sec (ikincil tema mı), lowPower }
function make(ctx, parts) {
  const L = { W: ctx.W, H: ctx.H, d: ctx.density, ...parts };
  const pools = parts.pools || [];
  const base = pools.map(p => p.n);
  L.setDensity = d => { L.d = d; pools.forEach((p, i) => { p.n = Math.max(1, Math.round(base[i] * d)); }); };
  L.setDensity(ctx.density);
  L.resize = (W, H) => { L.W = W; L.H = H; parts.resize?.(W, H); };
  L.resize(ctx.W, ctx.H);
  const fa = () => { try { return clamp(ctx.figAlpha ? Number(ctx.figAlpha()) : 1, 0, 1); } catch { return 1; } };
  const fig = (fn, g, t, dt) => { if (!fn) return; const a = fa(); if (a <= 0.01) return; g.save(); g.globalAlpha = a; fn(g, t, dt, L.W, L.H); g.restore(); };   // görünmezken figürler durur
  L.draw = (g, t, dt) => { fig(parts.back, g, t, dt); for (const p of pools) p.tick(g, t, dt, L.W, L.H); fig(parts.front, g, t, dt); };
  L.still = g => { parts.back?.(g, 6, 0, L.W, L.H); parts.front?.(g, 6, 0, L.W, L.H); parts.stillExtra?.(g, L.W, L.H); };
  return L;
}
/** Uzun yer figürlerinin (ağaç, menora, mum, balkabağı, rangoli, ateş) zemin çizgisi: ctx.ground × H (SIMUMAV menüsünde kartların üstü). */
const gy = (ctx, H) => H * clamp(ctx.ground ?? 1, 0.3, 1);
const scaleN = (ctx, n) => Math.max(1, Math.round(n * Math.min(1.4, Math.max(0.5, ctx.W / 1400))));

const THEME_FACTORY = {
  kurban(ctx) {
    const moon = crescentSprite(30);
    const gar = ctx.sec ? null : lanternGarland({ colors: ['#dc2626', '#f59e0b', '#059669', '#2563eb', '#db2777'] });
    const sheep = ctx.sec ? null : sheepWalkers(clamp(Math.round(ctx.W / 260), 3, 7));
    const tw = twinkles(scaleN(ctx, 40));
    return make(ctx, {
      pools: [tw],
      resize: (W, H) => { gar?.resize(W, H); sheep?.resize(W, H); },
      back: (g, t, dt, W, H) => {
        if (ctx.sec) return;
        const gr = g.createLinearGradient(0, H - 46, 0, H);   // çayır şeridi
        gr.addColorStop(0, 'rgba(74,222,128,0)'); gr.addColorStop(1, 'rgba(34,197,94,.28)');
        g.fillStyle = gr; g.fillRect(0, H - 46, W, 46);
        g.strokeStyle = 'rgba(22,163,74,.45)'; g.lineWidth = 1.2;
        for (let x = 4; x < W; x += 9) { const hh = 5 + ((x * 7) % 9); const sw = Math.sin(t * 1.4 + x * 0.05) * 2; g.beginPath(); g.moveTo(x, H); g.quadraticCurveTo(x + sw * 0.5, H - hh * 0.6, x + sw, H - hh); g.stroke(); }
        glow(g, 96, 150, 90, 'rgba(253,224,71,.22)');
        blit(g, moon, 96, 150, -0.25 + Math.sin(t * 0.4) * 0.04, 1.1);
      },
      front: (g, t, dt) => { gar?.draw(g, t); sheep?.draw(g, t, dt); },
    });
  },
  ramazan(ctx) {
    const moon = crescentSprite(26, '#fde68a');
    const gar = ctx.sec ? null : lanternGarland({ colors: ['#0d9488', '#f59e0b', '#7c3aed', '#e11d48', '#0284c7'], sag: 40 });
    const C = candySprites();
    const rain = fallers(scaleN(ctx, ctx.sec ? 22 : 54), () => C, { vy: [55, 120], spin: 3, sway: 26, bounce: true, scale: [0.85, 1.35] });
    const tw = twinkles(scaleN(ctx, 26), ['#fde68a', '#fff7cc']);
    return make(ctx, {
      pools: [tw, rain],
      resize: (W, H) => gar?.resize(W, H),
      back: (g, t, dt, W) => { if (ctx.sec) return; glow(g, 92, 150, 84, 'rgba(253,230,138,.25)'); blit(g, moon, 92, 150, -0.2 + Math.sin(t * 0.5) * 0.05, 1.1); },
      front: (g, t) => gar?.draw(g, t),
      stillExtra: (g, W, H) => { for (let i = 0; i < 9; i++) blit(g, C[i % C.length], 40 + i * 26, H - 14 - (i % 2) * 8, i * 0.7, 1); },
    });
  },
  hicri(ctx) {
    const moon = crescentSprite(34, '#fde68a');
    const tw = twinkles(scaleN(ctx, 70), ['#fde68a', '#fff7cc', '#fef3c7', '#facc15'], 0.75);
    const dust = fallers(scaleN(ctx, 24), () => [sprite(6, 6, g => { glow(g, 3, 3, 3, 'rgba(253,224,71,.9)'); })], { vy: [10, 26], spin: 0, sway: 12, up: true, scale: [0.6, 1.6] });
    return make(ctx, {
      pools: [tw, dust],
      back: (g, t, dt, W) => { if (ctx.sec) return; glow(g, W / 2, 0, Math.min(W, 900) * 0.6, 'rgba(253,224,71,.08)'); glow(g, 120, 130, 110, 'rgba(253,230,138,.28)'); blit(g, moon, 120, 130, -0.3, 1.1); },
    });
  },
  noel(ctx) {
    const sn = snow(scaleN(ctx, ctx.sec ? 50 : 130), ctx.light);
    const tree = sprite(150, 210, (g) => {
      g.fillStyle = '#78350f'; g.fillRect(68, 180, 14, 26);
      for (let i = 0; i < 4; i++) {
        const y = 30 + i * 38, w = 38 + i * 20;
        const gr = g.createLinearGradient(75 - w, 0, 75 + w, 0); gr.addColorStop(0, '#14532d'); gr.addColorStop(0.5, '#16a34a'); gr.addColorStop(1, '#14532d');
        g.fillStyle = gr; g.beginPath(); g.moveTo(75, y - 26); g.lineTo(75 + w, y + 30); g.quadraticCurveTo(75, y + 40, 75 - w, y + 30); g.closePath(); g.fill();
        g.fillStyle = 'rgba(255,255,255,.75)'; for (let k = 0; k < 4; k++) { g.beginPath(); g.ellipse(75 - w * 0.7 + k * w * 0.46, y + 30, 6, 2, 0, 0, TAU); g.fill(); }
      }
      const gifts = [[34, 192, '#dc2626', '#facc15'], [100, 194, '#2563eb', '#f8fafc'], [62, 198, '#a855f7', '#fde047']];
      for (const [x, y, c, r] of gifts) { g.fillStyle = c; g.fillRect(x - 13, y - 12, 26, 18); g.fillStyle = r; g.fillRect(x - 2, y - 12, 4, 18); g.fillRect(x - 13, y - 5, 26, 3);
        g.beginPath(); g.ellipse(x - 5, y - 14, 5, 3, 0.5, 0, TAU); g.ellipse(x + 5, y - 14, 5, 3, -0.5, 0, TAU); g.fill(); }
    });
    const lights = Array.from({ length: 26 }, (_, i) => ({ u: Math.random(), v: Math.random(), c: pick(['#f87171', '#facc15', '#60a5fa', '#f0abfc', '#4ade80']), ph: i }));
    const sleigh = { t: 3 };
    return make(ctx, {
      pools: [sn],
      front: (g, t, dt, W, H) => {
        if (ctx.sec) return;
        const tx = 14, ty = gy(ctx, H) - 214;
        g.drawImage(tree, tx, ty, 150, 210);
        for (const L of lights) {
          const row = (L.v * 4) | 0, y = ty + 34 + row * 38 + L.u * 26, w = (38 + row * 20) * (0.3 + L.u * 0.6);
          const x = tx + 75 + (L.v * 2 - 1 - row * 0) * w * 0.9 * (L.u > 0.5 ? 1 : -1) * 0.8;
          const a = 0.45 + 0.55 * Math.abs(Math.sin(t * 2 + L.ph));
          glow(g, x, y, 7, hexA(L.c, a * 0.7)); g.fillStyle = hexA(L.c, a); g.beginPath(); g.arc(x, y, 2.3, 0, TAU); g.fill();
        }
        const sa = 0.7 + 0.3 * Math.sin(t * 3);
        glow(g, tx + 75, ty + 6, 26, `rgba(253,224,71,${0.5 * sa})`); g.fillStyle = '#facc15'; star(g, tx + 75, ty + 6, 11); g.fill();
        // kızak geçişi (her ~18 sn)
        sleigh.t += dt;
        const cyc = sleigh.t % 18;
        if (cyc < 8 && dt > 0) {
          const u = cyc / 8, x = -220 + u * (W + 440), y = H * 0.16 + Math.sin(u * 5) * 18;
          g.save(); g.translate(x, y);
          g.fillStyle = 'rgba(30,41,59,.85)';
          for (let k = 0; k < 3; k++) { const rx = 70 + k * 34, b = Math.sin(t * 10 + k) * 2; g.beginPath(); g.ellipse(rx, b, 11, 5, 0, 0, TAU); g.fill(); g.fillRect(rx + 6, b - 9, 3, 8);
            g.beginPath(); g.moveTo(rx + 8, b - 9); g.lineTo(rx + 14, b - 15); g.moveTo(rx + 8, b - 9); g.lineTo(rx + 4, b - 15); g.strokeStyle = 'rgba(30,41,59,.85)'; g.lineWidth = 1.2; g.stroke();
            g.fillRect(rx - 8, b + 3, 2, 7); g.fillRect(rx + 6, b + 3, 2, 7); }
          g.fillStyle = '#b91c1c'; g.beginPath(); g.moveTo(-10, -12); g.lineTo(40, -12); g.quadraticCurveTo(52, -10, 46, 2); g.lineTo(-6, 2); g.closePath(); g.fill();
          g.strokeStyle = '#facc15'; g.lineWidth = 2; g.beginPath(); g.moveTo(-14, 6); g.lineTo(50, 6); g.quadraticCurveTo(58, 6, 56, -2); g.stroke();
          g.strokeStyle = 'rgba(148,163,184,.8)'; g.lineWidth = 1; g.beginPath(); g.moveTo(44, -6); g.lineTo(66, 0); g.stroke();
          g.restore();
          for (let k = 0; k < 6; k++) { g.fillStyle = `rgba(253,224,71,${0.6 - k * 0.09})`; g.beginPath(); g.arc(x - 18 - k * 14 + rnd(-3, 3), y + 4 + rnd(-4, 4), 1.8, 0, TAU); g.fill(); }
        }
      },
    });
  },
  paskalya(ctx) {
    const E = eggSprites(), F = flowerSprites();
    const eggs = fallers(scaleN(ctx, ctx.sec ? 10 : 22), () => E, { vy: [35, 70], spin: 1.2, sway: 16, bounce: true });
    const fl = fallers(scaleN(ctx, 26), () => F, { vy: [25, 50], spin: 2, sway: 30 });
    const bunnies = ctx.sec ? null : walkers(2, {
      init: (w, W, H, i) => Object.assign(w, { x: rnd(0, W), dir: i ? -1 : 1, ph: rnd(0, 3), sc: i ? 0.9 : 1.05 }),
      step: (w, dt, t, W) => { w.x += w.dir * 46 * dt; if (w.x > W + 40) w.dir = -1; if (w.x < -40) w.dir = 1; },
      draw: (g, w, t) => {
        const H = g.canvas.height / (g.getTransform().d || 1);
        const hop = Math.abs(Math.sin(t * 4.2 + w.ph)) * 22;
        g.save(); g.translate(w.x, H - 6); g.scale(w.dir * w.sc, w.sc);
        g.fillStyle = 'rgba(0,0,0,.15)'; g.beginPath(); g.ellipse(0, 0, 18 - hop * 0.3, 3.5, 0, 0, TAU); g.fill();
        g.translate(0, -hop);
        g.fillStyle = '#f5f5f4'; g.beginPath(); g.ellipse(0, -16, 17, 13, -0.15, 0, TAU); g.fill();
        g.beginPath(); g.arc(14, -28, 9, 0, TAU); g.fill();
        g.beginPath(); g.ellipse(10, -46, 3.6, 12, -0.25, 0, TAU); g.fill(); g.beginPath(); g.ellipse(17, -45, 3.6, 12, 0.25, 0, TAU); g.fill();
        g.fillStyle = '#fbcfe8'; g.beginPath(); g.ellipse(10, -46, 1.6, 8, -0.25, 0, TAU); g.fill(); g.beginPath(); g.ellipse(17, -45, 1.6, 8, 0.25, 0, TAU); g.fill();
        g.fillStyle = '#fff'; g.beginPath(); g.arc(-16, -18, 6, 0, TAU); g.fill();
        g.fillStyle = '#1c1917'; g.beginPath(); g.arc(18, -30, 1.6, 0, TAU); g.fill(); g.fillStyle = '#f472b6'; g.beginPath(); g.arc(22.5, -27, 1.6, 0, TAU); g.fill();
        g.restore();
      },
    });
    return make(ctx, { pools: [fl, eggs], resize: (W, H) => bunnies?.resize(W, H), front: (g, t, dt) => bunnies?.draw(g, t, dt) });
  },
  hristiyan(ctx) {
    const bell = sprite(46, 52, (g) => {
      const gr = g.createLinearGradient(4, 0, 42, 0); gr.addColorStop(0, '#a16207'); gr.addColorStop(0.45, '#fde68a'); gr.addColorStop(1, '#854d0e');
      g.fillStyle = gr; g.beginPath(); g.moveTo(23, 6); g.bezierCurveTo(8, 6, 10, 30, 3, 42); g.lineTo(43, 42); g.bezierCurveTo(36, 30, 38, 6, 23, 6); g.fill();
      g.fillStyle = '#854d0e'; g.beginPath(); g.arc(23, 46, 5, 0, TAU); g.fill(); g.fillRect(20, 0, 6, 7);
      g.fillStyle = '#dc2626'; g.beginPath(); g.ellipse(14, 5, 9, 4, -0.4, 0, TAU); g.ellipse(32, 5, 9, 4, 0.4, 0, TAU); g.fill();
    });
    const motes = twinkles(scaleN(ctx, 30), ['#fef3c7', '#ffffff', '#fde68a'], 0.9);
    const GLASS = ['rgba(239,68,68,.10)', 'rgba(59,130,246,.10)', 'rgba(250,204,21,.10)', 'rgba(16,185,129,.09)', 'rgba(168,85,247,.10)'];
    return make(ctx, {
      pools: [motes],
      back: (g, t, dt, W, H) => {
        if (ctx.sec) return;
        for (let i = 0; i < 5; i++) {   // vitray ışık hüzmeleri
          const x = W * (0.15 + i * 0.17) + Math.sin(t * 0.2 + i) * 30;
          g.fillStyle = GLASS[i]; g.beginPath(); g.moveTo(x - 30, 0); g.lineTo(x + 30, 0); g.lineTo(x + 140, H); g.lineTo(x + 20, H); g.closePath(); g.fill();
        }
      },
      front: (g, t, dt, W, H) => {
        if (ctx.sec) return;
        blit(g, bell, 70, 120, Math.sin(t * 2.2) * 0.35, 1.2); blit(g, bell, W - 70, 120, Math.sin(t * 2.2 + 1.3) * 0.35, 1.2);
        for (let i = 0; i < 5; i++) {
          for (const side of [0, 1]) {
            const x = side ? W - 40 - i * 22 : 40 + i * 22, hgt = 34 - (i % 3) * 7;
            const G = gy(ctx, H); g.fillStyle = '#fef3c7'; g.fillRect(x - 5, G - hgt, 10, hgt);
            g.fillStyle = 'rgba(0,0,0,.08)'; g.fillRect(x + 2, G - hgt, 3, hgt);
            flame(g, x, G - hgt - 1, 5, t, i * 1.7 + side);
          }
        }
      },
    });
  },
  yilbasi(ctx) {
    const cols = () => ['#f43f5e', '#facc15', '#22d3ee', '#a78bfa', '#4ade80', '#fb923c', '#ffffff'];
    const fw = fireworks(ctx.sec ? 0.25 : 0.9, cols);
    const cf = confetti(scaleN(ctx, ctx.sec ? 30 : 70), cols);
    return make(ctx, { pools: [cf], front: (g, t, dt, W, H) => fw.draw(g, t, dt, W, H),
      stillExtra: (g, W) => { for (let k = 0; k < 24; k++) { const a = (k / 24) * TAU; g.strokeStyle = hexA(cols()[k % 7], 0.8); g.lineWidth = 2; g.beginPath(); g.moveTo(W - 120 + Math.cos(a) * 12, 110 + Math.sin(a) * 12); g.lineTo(W - 120 + Math.cos(a) * 60, 110 + Math.sin(a) * 60); g.stroke(); } } });
  },
  cin_yeni(ctx) {
    const gar = ctx.sec ? null : lanternGarland({ kind: 'cin', colors: ['#dc2626', '#ef4444', '#b91c1c'], sag: 30, n: 0 });
    const fw = fireworks(ctx.sec ? 0.2 : 0.55, () => ['#ef4444', '#facc15', '#fbbf24', '#fde68a']);
    const coin = sprite(16, 16, (g) => { g.fillStyle = '#facc15'; g.beginPath(); g.arc(8, 8, 7, 0, TAU); g.fill(); g.fillStyle = '#a16207'; g.fillRect(6, 6, 4, 4); g.strokeStyle = '#ca8a04'; g.lineWidth = 1; g.stroke(); });
    const env = sprite(14, 20, (g) => { g.fillStyle = '#dc2626'; g.fillRect(0, 0, 14, 20); g.fillStyle = '#facc15'; g.beginPath(); g.arc(7, 9, 3.4, 0, TAU); g.fill(); g.fillRect(0, 0, 14, 2); });
    const fall = fallers(scaleN(ctx, ctx.sec ? 12 : 26), () => [coin, env, coin], { vy: [50, 90], spin: 3, sway: 20 });
    const dragon = { t: 2 };
    return make(ctx, {
      pools: [fall],
      resize: (W, H) => gar?.resize(W, H),
      front: (g, t, dt, W, H) => {
        fw.draw(g, t, dt, W, H); gar?.draw(g, t);
        if (ctx.sec || !dt) return;
        dragon.t += dt;
        const cyc = dragon.t % 22;
        if (cyc > 12) return;
        const u = cyc / 12, hx = -260 + u * (W + 520), baseY = H * 0.58;
        const seg = 22;
        for (let k = seg; k >= 0; k--) {   // ejderha gövdesi: dalgalı halka dizisi (kuyruktan başa)
          const x = hx - k * 15, y = baseY + Math.sin(t * 3 - k * 0.45) * 26, r = 13 - k * 0.32;
          g.fillStyle = k % 2 ? '#dc2626' : '#ef4444'; g.beginPath(); g.arc(x, y, r, 0, TAU); g.fill();
          g.fillStyle = '#facc15'; g.beginPath(); g.moveTo(x - 3, y - r); g.lineTo(x, y - r - 7); g.lineTo(x + 3, y - r); g.fill();
          if (k % 4 === 0 && k) { g.strokeStyle = '#facc15'; g.lineWidth = 2; g.beginPath(); g.moveTo(x, y + r - 2); g.lineTo(x - 4, y + r + 8); g.stroke(); }
        }
        const y0 = baseY + Math.sin(t * 3) * 26;
        g.save(); g.translate(hx + 14, y0);
        g.fillStyle = '#dc2626'; g.beginPath(); g.ellipse(4, 0, 20, 13, 0, 0, TAU); g.fill();
        g.fillStyle = '#facc15'; g.beginPath(); g.moveTo(-6, -10); g.lineTo(-14, -26); g.lineTo(2, -12); g.fill(); g.beginPath(); g.moveTo(4, -12); g.lineTo(0, -28); g.lineTo(12, -12); g.fill();
        g.fillStyle = '#fff'; g.beginPath(); g.arc(10, -4, 4, 0, TAU); g.fill(); g.fillStyle = '#111'; g.beginPath(); g.arc(11, -4, 2, 0, TAU); g.fill();
        g.strokeStyle = '#facc15'; g.lineWidth = 1.6; g.beginPath(); g.moveTo(22, 2); g.quadraticCurveTo(34, -6 + Math.sin(t * 5) * 4, 40, 6); g.moveTo(22, 5); g.quadraticCurveTo(34, 14 + Math.sin(t * 5) * 4, 42, 8); g.stroke();
        g.fillStyle = '#fef3c7'; g.fillRect(14, 4, 10, 3);
        g.restore();
      },
    });
  },
  diwali(ctx) {
    const diya = diyaSprite();
    const sparks = pool(scaleN(ctx, 40), (p, W, H, init) => { p.x = rnd(0, W); p.y = init ? rnd(H * 0.3, H) : H + 4; p.vy = rnd(-60, -25); p.life = rnd(1.5, 4); p.c = pick(['#fde047', '#fb923c', '#fef3c7']); },
      (p, dt, t) => { p.y += p.vy * dt; p.x += Math.sin(t * 3 + p.y * 0.05) * 10 * dt; p.life -= dt; return p.life > 0; },
      (g, p) => { g.fillStyle = hexA(p.c, clamp(p.life / 2, 0, 1)); g.beginPath(); g.arc(p.x, p.y, 1.6, 0, TAU); g.fill(); });
    const fw = fireworks(ctx.sec ? 0.15 : 0.35, () => ['#fde047', '#fb923c', '#f472b6', '#facc15']);
    const rangoli = sprite(170, 170, (g) => {
      const cols = ['#db2777', '#f59e0b', '#16a34a', '#2563eb', '#9333ea', '#ea580c'];
      for (let ring = 6; ring >= 1; ring--) {
        const n = ring * 4 + 4;
        for (let k = 0; k < n; k++) {
          const a = (k / n) * TAU;
          g.save(); g.translate(85, 85); g.rotate(a); g.fillStyle = cols[(ring + k) % cols.length];
          g.beginPath(); g.ellipse(ring * 12, 0, 8, 4.4, 0, 0, TAU); g.fill(); g.restore();
        }
      }
      g.fillStyle = '#fde047'; star(g, 85, 85, 12, 8, 0.5); g.fill();
    });
    return make(ctx, {
      pools: [sparks],
      front: (g, t, dt, W, H) => {
        fw.draw(g, t, dt, W, H);
        if (ctx.sec) return;
        blit(g, rangoli, W - 10, gy(ctx, H) - 10, t * 0.05, 1, 0.85);
        const n = clamp(Math.round(W / 120), 5, 14);
        for (let i = 0; i < n; i++) { const x = ((i + 0.5) / n) * (W - 180); blit(g, diya, x, H - 10); flame(g, x, H - 18, 5.5, t, i * 2.1); }
      },
    });
  },
  holi(ctx) {
    const COL = ['#ec4899', '#f59e0b', '#22c55e', '#3b82f6', '#a855f7', '#ef4444', '#facc15', '#06b6d4'];
    const puffs = pool(scaleN(ctx, ctx.sec ? 5 : 12), (p, W, H, init) => { p.x = rnd(0, W); p.y = rnd(H * 0.1, H * 0.95); p.c = pick(COL); p.age = init ? rnd(0, 4) : 0; p.max = rnd(3, 5); p.r = rnd(60, 150); p.vx = rnd(-20, 20); p.vy = rnd(-14, 4); },
      (p, dt) => { p.age += dt; p.x += p.vx * dt; p.y += p.vy * dt; return p.age < p.max; },
      (g, p) => {
        const u = p.age / p.max, r = p.r * (0.3 + Math.sqrt(u) * 0.9), a = (u < 0.15 ? u / 0.15 : 1 - (u - 0.15) / 0.85) * 0.72;
        glow(g, p.x, p.y, r, hexA(p.c, a)); glow(g, p.x + r * 0.3, p.y - r * 0.2, r * 0.6, hexA(p.c, a * 0.8));
      });
    const dust = pool(scaleN(ctx, 90), (p, W, H) => { p.x = rnd(0, W); p.y = rnd(0, H); p.vx = rnd(-30, 30); p.vy = rnd(-30, 10); p.c = pick(COL); p.life = rnd(1, 3); p.r = rnd(1, 2.6); },
      (p, dt) => { p.x += p.vx * dt; p.y += p.vy * dt; p.vy += 10 * dt; p.life -= dt; return p.life > 0; },
      (g, p) => { g.fillStyle = hexA(p.c, clamp(p.life, 0, 1) * 0.8); g.beginPath(); g.arc(p.x, p.y, p.r, 0, TAU); g.fill(); });
    return make(ctx, { pools: [puffs, dust] });
  },
  hindu(ctx) {
    const lotus = lotusSprite();
    const lantern = sprite(24, 32, (g) => {
      const gr = g.createLinearGradient(0, 0, 0, 32); gr.addColorStop(0, '#fff7ed'); gr.addColorStop(0.6, '#fdba74'); gr.addColorStop(1, '#ea580c');
      g.fillStyle = gr; g.beginPath(); g.moveTo(3, 2); g.lineTo(21, 2); g.lineTo(18, 28); g.lineTo(6, 28); g.closePath(); g.fill();
      g.fillStyle = '#fef08a'; g.beginPath(); g.arc(12, 27, 3, 0, TAU); g.fill();
    });
    const lan = pool(scaleN(ctx, ctx.sec ? 6 : 14), (p, W, H, init) => { p.x = rnd(0, W); p.y = init ? rnd(0, H) : H + 40; p.vy = rnd(-26, -12); p.ph = rnd(0, TAU); p.sc = rnd(0.6, 1.2); },
      (p, dt, t) => { p.y += p.vy * dt; p.x += Math.sin(t * 0.6 + p.ph) * 8 * dt; return p.y > -50; },
      (g, p, t) => { glow(g, p.x, p.y + 6 * p.sc, 34 * p.sc, `rgba(253,186,116,${0.35 + 0.15 * Math.sin(t * 5 + p.ph)})`); blit(g, lantern, p.x, p.y, Math.sin(t + p.ph) * 0.06, p.sc); });
    const lotuses = Array.from({ length: 6 }, (_, i) => ({ u: (i + 0.5) / 6, ph: rnd(0, 6), s: rnd(0.75, 1.15) }));
    return make(ctx, {
      pools: [lan],
      front: (g, t, dt, W, H) => {
        if (ctx.sec) return;
        const gr = g.createLinearGradient(0, H - 30, 0, H); gr.addColorStop(0, 'rgba(56,189,248,0)'); gr.addColorStop(1, 'rgba(14,165,233,.25)'); g.fillStyle = gr; g.fillRect(0, H - 30, W, 30);
        for (const L of lotuses) { const x = ((L.u * W + t * 8) % (W + 80)) - 40; blit(g, lotus, x, H - 18 + Math.sin(t * 1.5 + L.ph) * 2, Math.sin(t + L.ph) * 0.05, L.s); }
      },
    });
  },
  yahudi(ctx) {
    const bokeh = pool(scaleN(ctx, ctx.sec ? 14 : 32), (p, W, H, init) => { p.x = rnd(0, W); p.y = init ? rnd(0, H) : H + 40; p.vy = rnd(-16, -6); p.r = rnd(8, 26); p.c = pick(['#60a5fa', '#bfdbfe', '#ffffff', '#3b82f6']); p.ph = rnd(0, TAU); },
      (p, dt) => { p.y += p.vy * dt; return p.y > -40; },
      (g, p, t) => glow(g, p.x, p.y, p.r, hexA(p.c, 0.18 + 0.1 * Math.sin(t + p.ph))));
    const stars = pool(scaleN(ctx, 16), (p, W, H) => { p.x = rnd(0, W); p.y = rnd(0, H * 0.6); p.r = rnd(4, 8); p.ph = rnd(0, TAU); p.life = rnd(3, 6); },
      (p, dt) => { p.life -= dt; return p.life > 0; },
      (g, p, t) => {
        const a = clamp(Math.min(p.life, 1), 0, 1) * (0.5 + 0.4 * Math.sin(t * 2 + p.ph));
        g.strokeStyle = `rgba(191,219,254,${a})`; g.lineWidth = 1.3;
        for (const rot of [-Math.PI / 2, Math.PI / 2]) { g.beginPath(); for (let k = 0; k < 3; k++) { const an = rot + (k / 3) * TAU; g.lineTo(p.x + Math.cos(an) * p.r, p.y + Math.sin(an) * p.r); } g.closePath(); g.stroke(); }
      });
    return make(ctx, {
      pools: [bokeh, stars],
      front: (g, t, dt, W, H) => {
        if (ctx.sec) return;
        const cx = 130, by = gy(ctx, H) - 12;   // menora
        g.save(); g.translate(cx, by); g.scale(1.35, 1.35); g.translate(-cx, -by);
        const gr = g.createLinearGradient(cx - 90, 0, cx + 90, 0); gr.addColorStop(0, '#a16207'); gr.addColorStop(0.5, '#fde68a'); gr.addColorStop(1, '#a16207');
        g.strokeStyle = gr; g.lineWidth = 4; g.lineCap = 'round';
        g.beginPath(); g.moveTo(cx, by); g.lineTo(cx, by - 70); g.stroke();
        g.fillStyle = gr; g.fillRect(cx - 24, by - 4, 48, 6);
        for (let k = 1; k <= 4; k++) { g.beginPath(); g.arc(cx, by - 70, k * 20, 0, Math.PI); g.stroke(); }
        for (let k = -4; k <= 4; k++) {
          const x = cx + k * 20, top = by - 70 - (k === 0 ? 14 : 0);
          g.fillStyle = '#e0f2fe'; g.fillRect(x - 3, top - 18, 6, 18);
          flame(g, x, top - 19, 4.5, t, k * 1.3);
        }
        g.restore();
      },
    });
  },
  cocuk_genclik(ctx) {
    const BAL = ['#ef4444', '#f59e0b', '#22c55e', '#3b82f6', '#a855f7', '#ec4899'];
    const balloons = pool(scaleN(ctx, ctx.sec ? 8 : 16), (p, W, H, init) => { p.x = rnd(0, W); p.y = init ? rnd(H * 0.2, H) : H + 60; p.vy = rnd(-50, -28); p.c = pick(BAL); p.ph = rnd(0, TAU); p.s = rnd(0.8, 1.2); },
      (p, dt, t) => { p.y += p.vy * dt; p.x += Math.sin(t * 0.9 + p.ph) * 14 * dt; return p.y > -80; },
      (g, p, t) => {
        const s = p.s;
        g.strokeStyle = 'rgba(100,116,139,.7)'; g.lineWidth = 1; g.beginPath(); g.moveTo(p.x, p.y + 20 * s);
        for (let k = 1; k <= 6; k++) g.lineTo(p.x + Math.sin(t * 3 + k + p.ph) * 3, p.y + 20 * s + k * 7); g.stroke();
        const gr = g.createRadialGradient(p.x - 5 * s, p.y - 6 * s, 1, p.x, p.y, 20 * s); gr.addColorStop(0, '#fff'); gr.addColorStop(0.25, p.c); gr.addColorStop(1, p.c);
        g.fillStyle = gr; g.beginPath(); g.ellipse(p.x, p.y, 14 * s, 18 * s, 0, 0, TAU); g.fill();
        g.fillStyle = p.c; g.beginPath(); g.moveTo(p.x - 3, p.y + 19 * s); g.lineTo(p.x + 3, p.y + 19 * s); g.lineTo(p.x, p.y + 15 * s); g.fill();
      });
    const planes = pool(scaleN(ctx, ctx.sec ? 2 : 4), (p, W, H, init) => { p.dir = Math.random() < 0.5 ? 1 : -1; p.x = p.dir > 0 ? (init ? rnd(0, W) : -40) : (init ? rnd(0, W) : W + 40); p.y = rnd(H * 0.15, H * 0.6); p.v = rnd(70, 120); p.ph = rnd(0, TAU); p.loop = -1; },
      (p, dt, t, W) => { p.x += p.dir * p.v * dt; p.y += Math.sin(t * 1.2 + p.ph) * 20 * dt; return p.x > -60 && p.x < W + 60; },
      (g, p, t) => {
        g.save(); g.translate(p.x, p.y); g.scale(p.dir, 1); g.rotate(Math.cos(t * 1.2 + p.ph) * 0.2);
        g.fillStyle = '#f8fafc'; g.strokeStyle = 'rgba(100,116,139,.8)'; g.lineWidth = 0.8;
        g.beginPath(); g.moveTo(18, 0); g.lineTo(-14, -9); g.lineTo(-8, 0); g.closePath(); g.fill(); g.stroke();
        g.fillStyle = '#e2e8f0'; g.beginPath(); g.moveTo(18, 0); g.lineTo(-14, 7); g.lineTo(-8, 0); g.closePath(); g.fill(); g.stroke();
        g.restore();
      });
    const kites = ctx.sec ? [] : [{ u: 0.18, c: '#ef4444', c2: '#facc15' }, { u: 0.78, c: '#3b82f6', c2: '#22c55e' }, { u: 0.5, c: '#a855f7', c2: '#f472b6' }];
    return make(ctx, {
      pools: [balloons, planes],
      front: (g, t, dt, W, H) => {
        for (const [i, k] of kites.entries()) {
          const x = k.u * W + Math.sin(t * 0.7 + i) * 30, y = H * 0.18 + Math.sin(t * 1.1 + i * 2) * 16, rot = Math.sin(t * 1.3 + i) * 0.25;
          g.strokeStyle = 'rgba(100,116,139,.45)'; g.lineWidth = 1; g.beginPath(); g.moveTo(x, y + 26); g.quadraticCurveTo(x + 40, H * 0.6, x + 120 * (i % 2 ? -1 : 1), H + 10); g.stroke();
          g.save(); g.translate(x, y); g.rotate(rot);
          g.fillStyle = k.c; g.beginPath(); g.moveTo(0, -30); g.lineTo(20, 0); g.lineTo(0, 26); g.lineTo(-20, 0); g.closePath(); g.fill();
          g.fillStyle = k.c2; g.beginPath(); g.moveTo(0, -30); g.lineTo(20, 0); g.lineTo(0, 0); g.closePath(); g.fill(); g.beginPath(); g.moveTo(0, 26); g.lineTo(-20, 0); g.lineTo(0, 0); g.closePath(); g.fill();
          g.strokeStyle = 'rgba(0,0,0,.25)'; g.beginPath(); g.moveTo(0, -30); g.lineTo(0, 26); g.moveTo(-20, 0); g.lineTo(20, 0); g.stroke();
          for (let s = 1; s <= 7; s++) { const tx = Math.sin(t * 4 + s * 0.8 + i) * 6, ty = 26 + s * 9; g.fillStyle = s % 2 ? k.c2 : k.c; g.save(); g.translate(tx, ty); g.rotate(0.6); g.fillRect(-3, -1.5, 6, 3); g.restore(); }
          g.restore();
        }
      },
    });
  },
  kadin_anne(ctx) {
    const P = petalSprites(), Hh = heartSprites(['#f472b6', '#fb7185', '#f43f5e']);
    return make(ctx, { pools: [fallers(scaleN(ctx, ctx.sec ? 20 : 46), () => P, { vy: [30, 60], spin: 3, sway: 34 }), fallers(scaleN(ctx, ctx.sec ? 6 : 14), () => Hh, { vy: [35, 60], spin: 0.8, sway: 20, scale: [0.8, 1.3] })],
      stillExtra: (g, W, H) => { for (let i = 0; i < 10; i++) blit(g, P[i % P.length], W - 30 - i * 18, H - 12 - (i % 3) * 6, i); } });
  },
  sevgi(ctx) {
    const Hh = heartSprites();
    const up = pool(scaleN(ctx, ctx.sec ? 12 : 30), (p, W, H, init) => { p.s = pick(Hh); p.x = rnd(0, W); p.y = init ? rnd(0, H) : H + 30; p.vy = rnd(-60, -30); p.ph = rnd(0, TAU); p.sc = rnd(0.6, 1.4); },
      (p, dt, t) => { p.y += p.vy * dt; p.x += Math.sin(t * 1.6 + p.ph) * 22 * dt; return p.y > -40; },
      (g, p, t) => blit(g, p.s, p.x, p.y, Math.sin(t * 2 + p.ph) * 0.2, p.sc * (1 + Math.sin(t * 5 + p.ph) * 0.06), 0.9));
    return make(ctx, { pools: [up], stillExtra: (g, W, H) => { blit(g, Hh[0], W - 60, H - 50, 0.1, 2.4); blit(g, Hh[1], W - 100, H - 34, -0.2, 1.4); } });
  },
  cadilar(ctx) {
    const pk = pumpkinSprite();
    const bats = pool(scaleN(ctx, ctx.sec ? 4 : 9), (p, W, H, init) => { p.dir = Math.random() < 0.5 ? 1 : -1; p.x = init ? rnd(0, W) : (p.dir > 0 ? -30 : W + 30); p.y = rnd(H * 0.08, H * 0.5); p.v = rnd(60, 120); p.ph = rnd(0, TAU); p.s = rnd(0.7, 1.3); },
      (p, dt, t, W) => { p.x += p.dir * p.v * dt; p.y += Math.sin(t * 2 + p.ph) * 30 * dt; return p.x > -50 && p.x < W + 50; },
      (g, p, t) => {
        const f = Math.sin(t * 14 + p.ph);
        g.save(); g.translate(p.x, p.y); g.scale(p.s * p.dir, p.s); g.fillStyle = 'rgba(17,24,39,.9)';
        g.beginPath(); g.ellipse(0, 0, 5, 4, 0, 0, TAU); g.fill();
        g.beginPath(); g.moveTo(-3, -4); g.lineTo(-2, -8); g.lineTo(0, -4); g.lineTo(2, -8); g.lineTo(3, -4); g.fill();
        for (const s of [-1, 1]) { g.beginPath(); g.moveTo(s * 3, -1); g.quadraticCurveTo(s * 12, -10 * f - 4, s * 22, -6 * f); g.quadraticCurveTo(s * 17, 0, s * 14, 2); g.quadraticCurveTo(s * 9, 0, s * 3, 3); g.fill(); }
        g.restore();
      });
    return make(ctx, {
      pools: [bats],
      back: (g, t, dt, W, H) => {
        if (ctx.sec) return;
        const mx = W - 140, my = 130;
        glow(g, mx, my, 180, 'rgba(254,243,199,.22)');
        const gr = g.createRadialGradient(mx - 15, my - 15, 5, mx, my, 62); gr.addColorStop(0, '#fffbeb'); gr.addColorStop(1, '#fde68a');
        g.fillStyle = gr; g.beginPath(); g.arc(mx, my, 60, 0, TAU); g.fill();
        g.fillStyle = 'rgba(180,150,90,.25)'; for (const [dx, dy, r] of [[-18, -10, 10], [14, 12, 8], [8, -22, 6], [-6, 22, 7]]) { g.beginPath(); g.arc(mx + dx, my + dy, r, 0, TAU); g.fill(); }
        for (let i = 0; i < 4; i++) {   // sis bantları
          const y = my + 20 + i * 26, x = ((t * (10 + i * 4) + i * 300) % (W + 600)) - 300;
          g.fillStyle = 'rgba(203,213,225,.12)'; g.beginPath(); g.ellipse(x + 150, y, 260, 14, 0, 0, TAU); g.fill();
        }
        const fg = g.createLinearGradient(0, H - 60, 0, H); fg.addColorStop(0, 'rgba(148,163,184,0)'); fg.addColorStop(1, 'rgba(148,163,184,.3)'); g.fillStyle = fg; g.fillRect(0, H - 60, W, 60);
      },
      front: (g, t, dt, W, H) => {
        if (ctx.sec) return;
        const n = clamp(Math.round(W / 300), 3, 6);
        for (let i = 0; i < n; i++) {
          const x = 40 + (i / n) * (W * 0.55), fl = 0.6 + 0.4 * Math.sin(t * 9 + i * 2) * Math.sin(t * 4.3 + i);
          glow(g, x, gy(ctx, H) - 26, 40, `rgba(251,146,60,${0.25 * fl + 0.1})`);
          blit(g, pk, x, gy(ctx, H) - 22, 0, 1.3 - (i % 2) * 0.25);
        }
      },
    });
  },
  bagimsizlik(ctx) {
    const F = loadFlag(ctx.country);
    const colors = () => (F?.colors?.length ? F.colors : FLAG_FALLBACK);
    const fw = fireworks(ctx.sec ? 0.3 : 0.7, colors);
    const cf = confetti(scaleN(ctx, ctx.sec ? 30 : 60), colors);
    const jets = { t: 1.5 };
    return make(ctx, {
      pools: [cf],
      front: (g, t, dt, W, H) => {
        fw.draw(g, t, dt, W, H);
        if (ctx.sec) return;
        // bayrak dizisi (üstte küçük bayraklar)
        if (F?.ready) {
          const n = clamp(Math.round(W / 110), 5, 14);
          g.strokeStyle = 'rgba(100,116,139,.6)'; g.lineWidth = 1.2; g.beginPath();
          for (let i = 0; i <= 30; i++) { const u = i / 30; g.lineTo(u * W, 6 + 26 * 4 * u * (1 - u)); } g.stroke();
          for (let i = 0; i < n; i++) {
            const u = (i + 0.5) / n, x = u * W, y = 6 + 26 * 4 * u * (1 - u);
            g.save(); g.translate(x, y); g.rotate(Math.sin(t * 2 + i) * 0.08);
            g.drawImage(F.img, -16, 2, 32, 24); g.strokeStyle = 'rgba(0,0,0,.15)'; g.strokeRect(-16, 2, 32, 24); g.restore();
          }
          drawWavingFlag(g, F, 70, 110, 190, t);
        }
        // jet geçişi: bayrak renklerinde dumanla (her ~14 sn)
        if (!dt) return;
        jets.t += dt;
        const cyc = jets.t % 14;
        if (cyc < 6) {
          const u = cyc / 6, cols = colors(), n = Math.min(5, Math.max(3, cols.length + 1));
          for (let k = 0; k < n; k++) {
            const off = (k - (n - 1) / 2), x = -200 + u * (W + 400) - Math.abs(off) * 26, y = H * 0.32 + off * 22;
            const c = cols[k % cols.length];
            for (let s = 1; s < 40; s++) {   // duman izi
              const sx = x - s * 13, a = (1 - s / 40) * 0.5;
              if (sx < -20) break;
              glow(g, sx, y + Math.sin(s * 0.4 + t) * 1.5, 7 + s * 0.35, hexA(c.length === 7 ? c : '#ffffff', a));
            }
            g.save(); g.translate(x, y); g.fillStyle = '#e2e8f0'; g.strokeStyle = '#475569'; g.lineWidth = 0.8;
            g.beginPath(); g.moveTo(22, 0); g.lineTo(8, -3); g.lineTo(-2, -14); g.lineTo(-6, -14); g.lineTo(-2, -3); g.lineTo(-14, -3); g.lineTo(-19, -9); g.lineTo(-21, -9); g.lineTo(-18, 0);
            g.lineTo(-21, 9); g.lineTo(-19, 9); g.lineTo(-14, 3); g.lineTo(-2, 3); g.lineTo(-6, 14); g.lineTo(-2, 14); g.lineTo(8, 3); g.closePath(); g.fill(); g.stroke();
            g.fillStyle = '#38bdf8'; g.beginPath(); g.ellipse(10, 0, 4, 1.6, 0, 0, TAU); g.fill();
            g.restore();
          }
        }
      },
      stillExtra: (g, W) => { if (F?.ready) drawWavingFlag(g, F, 70, 110, 190, 0.5); },
    });
  },
  emek(ctx) {
    const car = carnationSprite();
    const fall = fallers(scaleN(ctx, ctx.sec ? 8 : 18), () => [car], { vy: [35, 65], spin: 1.5, sway: 22, scale: [0.6, 0.95] });
    return make(ctx, {
      pools: [fall],
      front: (g, t, dt, W, H) => {
        if (ctx.sec) return;
        const n = clamp(Math.round(W / 46), 10, 40), yer = H - 4;   // el ele siluetler
        g.fillStyle = 'rgba(127,29,29,.55)'; g.strokeStyle = 'rgba(127,29,29,.55)'; g.lineWidth = 3; g.lineCap = 'round';
        for (let i = 0; i < n; i++) {
          const x = (i + 0.5) * (W / n), sw = Math.sin(t * 1.6 + i * 0.5) * 2, hh = 30 + (i % 3) * 3;
          g.beginPath(); g.arc(x + sw * 0.3, yer - hh - 7, 5.5, 0, TAU); g.fill();
          g.beginPath(); g.moveTo(x, yer - hh); g.lineTo(x, yer - 12); g.moveTo(x, yer - 12); g.lineTo(x - 5, yer); g.moveTo(x, yer - 12); g.lineTo(x + 5, yer); g.stroke();
          if (i < n - 1) { const nx = (i + 1.5) * (W / n); g.beginPath(); g.moveTo(x, yer - hh + 4); g.quadraticCurveTo((x + nx) / 2, yer - hh - 8 + sw, nx, yer - hh + 4); g.stroke(); }
        }
        const G = gy(ctx, H); blit(g, car, W - 50, G - 34, -0.2, 1.6); blit(g, car, W - 78, G - 28, 0.2, 1.4); blit(g, car, W - 26, G - 26, 0.35, 1.3);
      },
    });
  },
  bahar(ctx) {
    const P = petalSprites(['#fbcfe8', '#f9a8d4', '#fce7f3']);
    const fall = fallers(scaleN(ctx, ctx.sec ? 14 : 30), () => P, { vy: [20, 45], spin: 3, sway: 36 });
    const sparks = pool(scaleN(ctx, ctx.sec ? 8 : 24), (p, W, H) => { p.x = W - 90 + rnd(-16, 16); p.y = gy(ctx, H) - 26; p.vx = rnd(-30, 30); p.vy = rnd(-140, -70); p.life = rnd(0.8, 1.8); },
      (p, dt) => { p.x += p.vx * dt; p.y += p.vy * dt; p.vy += 40 * dt; p.life -= dt; return p.life > 0; },
      (g, p) => { g.fillStyle = `rgba(253,186,116,${clamp(p.life, 0, 1)})`; g.beginPath(); g.arc(p.x, p.y, 1.6, 0, TAU); g.fill(); });
    const flies = Array.from({ length: ctx.sec ? 2 : 5 }, (_, i) => ({ ph: rnd(0, TAU), c: pick(['#f59e0b', '#a855f7', '#38bdf8', '#f472b6']), r: rnd(80, 220), cx: rnd(0.2, 0.8), cy: rnd(0.25, 0.65), sp: rnd(0.2, 0.4) }));
    const blossoms = Array.from({ length: 22 }, (_, i) => ({ u: i / 22, side: i % 2 ? 1 : -1, d: rnd(6, 20), ph: rnd(0, 4) }));
    return make(ctx, {
      pools: [fall, sparks],
      front: (g, t, dt, W, H) => {
        if (!ctx.sec) {
          // çiçek açan dal (sol üst köşe)
          g.strokeStyle = '#57534e'; g.lineWidth = 6; g.lineCap = 'round'; g.beginPath(); g.moveTo(-10, 40); g.quadraticCurveTo(140, 30, 300, 110); g.stroke();
          g.lineWidth = 3; g.beginPath(); g.moveTo(120, 38); g.quadraticCurveTo(170, 0, 220, -5); g.moveTo(200, 72); g.quadraticCurveTo(230, 120, 270, 150); g.stroke();
          for (const b of blossoms) {
            const x = -10 + b.u * 310, y = 40 + (b.u * b.u) * 70 - 8 + b.side * b.d * 0.6;
            const open = clamp(((t * 0.25 + b.ph) % 6) / 1.5, 0.25, 1);
            g.fillStyle = '#fbcfe8'; for (let k = 0; k < 5; k++) { const a = (k / 5) * TAU + b.ph; g.beginPath(); g.ellipse(x + Math.cos(a) * 4 * open, y + Math.sin(a) * 4 * open, 3.6 * open, 2.6 * open, a, 0, TAU); g.fill(); }
            g.fillStyle = '#db2777'; g.beginPath(); g.arc(x, y, 1.4, 0, TAU); g.fill();
          }
          // nevruz ateşi (sağ alt)
          const fx = W - 90, fy = gy(ctx, H) - 10;
          g.fillStyle = '#78350f'; g.save(); g.translate(fx, fy); g.rotate(0.3); g.fillRect(-26, -4, 52, 7); g.rotate(-0.6); g.fillRect(-26, -4, 52, 7); g.restore();
          for (let k = 0; k < 3; k++) flame(g, fx - 10 + k * 10, fy - 4, 9 - Math.abs(k - 1) * 2, t, k * 2.3);
        }
        for (const b of flies) {   // kelebekler
          const x = b.cx * W + Math.cos(t * b.sp + b.ph) * b.r, y = b.cy * H + Math.sin(t * b.sp * 1.7 + b.ph) * b.r * 0.4, f = Math.abs(Math.sin(t * 12 + b.ph));
          g.save(); g.translate(x, y); g.rotate(Math.sin(t + b.ph) * 0.3); g.fillStyle = b.c;
          for (const s of [-1, 1]) { g.beginPath(); g.ellipse(s * 6 * f, -3, 6 * f + 1, 5, s * 0.4, 0, TAU); g.fill(); g.beginPath(); g.ellipse(s * 5 * f, 4, 4 * f + 1, 3.5, -s * 0.4, 0, TAU); g.fill(); }
          g.fillStyle = '#1c1917'; g.fillRect(-1, -6, 2, 12); g.restore();
        }
      },
    });
  },
  genel(ctx) {
    const F = loadFlag(ctx.country);
    const colors = () => (F?.colors?.length ? F.colors : ['#f43f5e', '#facc15', '#22d3ee', '#a78bfa', '#4ade80']);
    const cf = confetti(scaleN(ctx, ctx.sec ? 14 : 30), colors);
    return make(ctx, {
      pools: [cf],
      front: (g, t, dt, W) => {
        if (ctx.sec || !F?.ready) return;
        const x = 96, y = 120;   // bayrak rozeti (sol üst: sağ üstte kabuk düğmeleri olur)
        g.save(); g.shadowColor = 'rgba(0,0,0,.3)'; g.shadowBlur = 12;
        g.fillStyle = '#fff'; g.beginPath(); g.arc(x, y, 34, 0, TAU); g.fill(); g.restore();
        g.save(); g.beginPath(); g.arc(x, y, 30, 0, TAU); g.clip(); g.drawImage(F.img, x - 40, y - 30, 80, 60); g.restore();
        g.strokeStyle = 'rgba(250,204,21,.9)'; g.lineWidth = 3; g.beginPath(); g.arc(x, y, 32, 0, TAU); g.stroke();
      },
    });
  },
};

export const THEME_LIST = Object.keys(THEME_FACTORY);

/** Birleşik sahne: [ana, ikincil?] */
export function createScene(themes, o = {}) {
  const ctx = { W: o.W || 1280, H: o.H || 720, density: o.density ?? 1, country: o.country || null, lowPower: !!o.lowPower, figAlpha: o.figAlpha || null, ground: o.ground ?? 1, light: o.dark === false };
  LIGHT = ctx.light;
  const layers = [];
  themes.slice(0, 2).forEach((th, i) => {
    const f = THEME_FACTORY[th];
    if (f) layers.push(f({ ...ctx, sec: i > 0, density: ctx.density * (i ? 0.5 : 1) }));
  });
  return {
    layers,
    frame(g, t, dt) { for (const L of layers) L.draw(g, t, dt); },
    still(g) { for (const L of layers) L.still(g); },
    resize(W, H) { for (const L of layers) L.resize(W, H); },
    setDensity(d) { layers.forEach((L, i) => L.setDensity(d * (i ? 0.5 : 1))); },
    dispose() { layers.length = 0; },
  };
}
