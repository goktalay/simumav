// SIMUMAV §25 — prosedürel düşük poli 3B pilot avatarı (three.js ile üretilir; harici varlık/lisans YOK) + aynı ayardan 2B yedek portre.
// THREE dışarıdan verilir (import yok) → oyun kabuğu (/app/core/three.js) ve tanıtım sitesi (/site/js/stage.js) aynı modülü kullanır.
// Parçalar: tulum (lathe gövde, yaka, fermuar), göğüste yama (CanvasTexture) + isim bandı, boyun, yüz (ten tonu, gözler), kask (kapak + vizör açıklı
// bant + kenar + kulaklık), vizör (aynalı: metal; değilse yarı saydam), aksesuar (mikrofon | tepe sırtı | anten | şerit); bot: "AI" yazılı kask.
import { SKINS, normAvatar, shade } from './avatar_core.js';

// ---------------------------------------------------------------- 2B yama çizimi (doku + yedek portre ortak)
export function drawPatch(ctx, kind, color, cx, cy, r, { bg = '#0b1220' } = {}) {
  if (!kind || kind === 'none') return;
  ctx.save();
  ctx.translate(cx, cy);
  ctx.beginPath(); ctx.arc(0, 0, r, 0, Math.PI * 2); ctx.fillStyle = bg; ctx.fill();
  ctx.lineWidth = Math.max(1, r * 0.12); ctx.strokeStyle = color; ctx.stroke();
  ctx.fillStyle = color; ctx.strokeStyle = color;
  const s = r * 0.62;
  ctx.beginPath();
  if (kind === 'star') {
    for (let i = 0; i < 10; i++) { const a = -Math.PI / 2 + i * Math.PI / 5, rr = i % 2 ? s * 0.45 : s; ctx.lineTo(Math.cos(a) * rr, Math.sin(a) * rr); }
    ctx.closePath(); ctx.fill();
  } else if (kind === 'wing') {
    for (const sx of [-1, 1]) { ctx.moveTo(sx * s * 0.18, -s * 0.1); ctx.lineTo(sx * s * 1.05, -s * 0.38); ctx.lineTo(sx * s * 0.85, -s * 0.08); ctx.lineTo(sx * s * 0.95, s * 0.02); ctx.lineTo(sx * s * 0.62, s * 0.12); ctx.lineTo(sx * s * 0.7, s * 0.22); ctx.lineTo(sx * s * 0.18, s * 0.2); ctx.closePath(); }
    ctx.fill(); ctx.beginPath(); ctx.arc(0, 0, s * 0.24, 0, Math.PI * 2); ctx.fill();
  } else if (kind === 'bolt') {
    [[0.15, -1], [-0.45, 0.1], [-0.02, 0.1], [-0.2, 1], [0.48, -0.15], [0.05, -0.15], [0.3, -1]].forEach(([x, y], i) => (i ? ctx.lineTo(x * s, y * s) : ctx.moveTo(x * s, y * s)));
    ctx.closePath(); ctx.fill();
  } else if (kind === 'chevron') {
    ctx.lineWidth = s * 0.28; ctx.lineJoin = 'miter';
    for (const dy of [-0.32, 0.28]) { ctx.moveTo(-s * 0.75, (dy - 0.25) * s); ctx.lineTo(0, (dy + 0.35) * s); ctx.lineTo(s * 0.75, (dy - 0.25) * s); }
    ctx.stroke();
  } else if (kind === 'target') {
    ctx.lineWidth = s * 0.16;
    for (const rr of [0.9, 0.5]) { ctx.moveTo(rr * s, 0); ctx.arc(0, 0, rr * s, 0, Math.PI * 2); }
    ctx.stroke(); ctx.beginPath(); ctx.arc(0, 0, s * 0.16, 0, Math.PI * 2); ctx.fill();
  } else if (kind === 'shield') {
    ctx.moveTo(0, -s); ctx.lineTo(s * 0.85, -s * 0.62); ctx.quadraticCurveTo(s * 0.8, s * 0.55, 0, s); ctx.quadraticCurveTo(-s * 0.8, s * 0.55, -s * 0.85, -s * 0.62); ctx.closePath(); ctx.fill();
  } else if (kind === 'cross') {
    const w = s * 0.34; ctx.rect(-w, -s * 0.85, w * 2, s * 1.7); ctx.rect(-s * 0.85, -w, s * 1.7, w * 2); ctx.fill();
  }
  ctx.restore();
}

const mkCanvas = (w, h) => { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; };

function patchTexture(THREE, a) {
  const c = mkCanvas(128, 128), ctx = c.getContext('2d');
  drawPatch(ctx, a.patch, a.patch_color, 64, 64, 58);
  const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 4;
  return tex;
}
function textTexture(THREE, text, { w = 256, h = 64, fg = '#ffffff', bg = null, font = 'bold 40px system-ui, sans-serif' } = {}) {
  const c = mkCanvas(w, h), ctx = c.getContext('2d');
  if (bg) { ctx.fillStyle = bg; ctx.fillRect(0, 0, w, h); }
  ctx.fillStyle = fg; ctx.font = font; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(String(text).slice(0, 14), w / 2, h / 2 + 2, w - 12);
  const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** Avatar grubu. opts.name: göğüs isim bandı (yoksa çizilmez). Dönüş: THREE.Group (userData.dispose() dokular + geometriler). */
export function buildAvatar(THREE, cfg, { name = '' } = {}) {
  const a = normAvatar(cfg);
  const g = new THREE.Group(); g.name = 'sm-avatar';
  const disp = [];
  const M = (o) => { const m = new THREE.MeshStandardMaterial(o); disp.push(m); return m; };
  const add = (geo, mat, pos = [0, 0, 0], rot = null, scl = null, parent = g) => {
    disp.push(geo);
    const m = new THREE.Mesh(geo, mat); m.position.set(...pos); if (rot) m.rotation.set(...rot); if (scl) m.scale.set(...scl); parent.add(m); return m;
  };
  const skin = SKINS[a.skin] || SKINS.s4;
  const suitM = M({ color: a.suit, roughness: 0.78, metalness: 0.02 });
  const suitDark = M({ color: shade(a.suit, -0.35), roughness: 0.7 });
  const skinM = M({ color: skin, roughness: 0.62 });
  const helmM = M({ color: a.helmet, roughness: 0.3, metalness: 0.15 });
  const helmDark = M({ color: shade(a.helmet, -0.55), roughness: 0.5 });
  const accM = M({ color: a.patch_color, roughness: 0.4, metalness: 0.2 });
  const dark = M({ color: '#15171c', roughness: 0.5 });
  // ---- gövde (tulum)
  const prof = [[0, -0.78], [0.72, -0.78], [0.75, -0.5], [0.71, -0.2], [0.6, 0.0], [0.42, 0.12], [0.2, 0.18], [0, 0.19]].map(([x, y]) => new THREE.Vector2(x, y));
  add(new THREE.LatheGeometry(prof, 28), suitM, [0, 0, 0], null, [1, 1, 0.7]);
  add(new THREE.TorusGeometry(0.2, 0.05, 8, 24), suitDark, [0, 0.17, 0], [Math.PI / 2, 0, 0]);
  add(new THREE.BoxGeometry(0.03, 0.62, 0.02), suitDark, [0, -0.32, 0.5]);
  // yama + isim bandı (göğüs yüzeyine teğet)
  const radAt = y => { for (let i = 1; i < prof.length; i++) { const p0 = prof[i - 1], p1 = prof[i]; if (y >= p0.y && y <= p1.y) return p0.x + (p1.x - p0.x) * ((y - p0.y) / (p1.y - p0.y || 1)); } return 0.7; };
  const chest = (x, y) => { const A = radAt(y), B = A * 0.7, z = B * Math.sqrt(Math.max(0, 1 - (x / A) ** 2)); return { z: z + 0.012, ry: Math.atan2(x / (A * A), z / (B * B)) }; };
  if (a.patch && a.patch !== 'none') {
    const tex = patchTexture(THREE, a); disp.push(tex);
    const c = chest(0.3, -0.2);
    add(new THREE.PlaneGeometry(0.24, 0.24), M({ map: tex, transparent: true, roughness: 0.8, alphaTest: 0.05 }), [0.3, -0.2, c.z], [0, c.ry, 0]);
  }
  if (name) {
    const tex = textTexture(THREE, name, { bg: '#0b1220', fg: '#e5e7eb', font: 'bold 34px system-ui, sans-serif' }); disp.push(tex);
    const c = chest(-0.3, -0.16);
    add(new THREE.PlaneGeometry(0.32, 0.08), M({ map: tex, roughness: 0.85 }), [-0.3, -0.16, c.z], [0, c.ry, 0]);
  }
  // ---- boyun + baş
  add(new THREE.CylinderGeometry(0.13, 0.15, 0.26, 16), skinM, [0, 0.28, 0]);
  const head = new THREE.Group(); head.position.set(0, 0.6, 0); g.add(head);
  add(new THREE.SphereGeometry(0.29, 28, 20), skinM, [0, -0.02, 0.0], null, [0.95, 1.08, 1], head);
  for (const sx of [-1, 1]) add(new THREE.SphereGeometry(0.034, 10, 8), dark, [sx * 0.1, 0.01, 0.262], null, null, head);
  add(new THREE.BoxGeometry(0.1, 0.018, 0.02), M({ color: shade(skin, -0.35), roughness: 0.7 }), [0, -0.15, 0.262], null, null, head);   // ağız
  // ---- kask: kapak + vizör açıklı bant + vizör + kenar + kulaklık
  const R = 0.37;
  const helm = new THREE.Group(); helm.position.set(0, 0.03, -0.01); head.add(helm);
  add(new THREE.SphereGeometry(R, 36, 12, 0, Math.PI * 2, 0, Math.PI * 0.34), helmM, [0, 0, 0], null, null, helm);
  add(new THREE.SphereGeometry(R, 36, 10, Math.PI / 2 + 0.78, Math.PI * 2 - 1.56, Math.PI * 0.34, Math.PI * 0.27), helmM, [0, 0, 0], null, null, helm);
  const visM = a.mirror ? M({ color: a.visor, metalness: 1, roughness: 0.06, envMapIntensity: 1.4 })
    : M({ color: a.visor, metalness: 0.1, roughness: 0.05, transparent: true, opacity: 0.42, depthWrite: false });
  add(new THREE.SphereGeometry(R * 1.018, 28, 10, Math.PI / 2 - 0.84, 1.68, Math.PI * 0.32, Math.PI * 0.27), visM, [0, 0, 0], null, null, helm);
  add(new THREE.TorusGeometry(R * 0.955, 0.028, 8, 40), helmDark, [0, -R * Math.cos(Math.PI * 0.39), 0], [Math.PI / 2, 0, 0], null, helm);
  for (const sx of [-1, 1]) add(new THREE.CylinderGeometry(0.09, 0.09, 0.06, 18), helmDark, [sx * (R - 0.005), -0.07, -0.02], [0, 0, Math.PI / 2], null, helm);
  const arc = (rad, r0, from, to, n = 24) => {
    const pts = []; for (let i = 0; i <= n; i++) { const t = from + (to - from) * (i / n); pts.push(new THREE.Vector3(0, Math.cos(t) * r0, Math.sin(t) * r0)); }
    return new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), n * 2, rad, 8, false);
  };
  if (a.accessory === 'mic' && !a.bot) {
    const pts = [[R * 0.98, -0.08, 0.02], [R * 0.9, -0.2, 0.2], [0.18, -0.25, 0.33], [0.06, -0.24, 0.36]].map(p => new THREE.Vector3(...p));
    add(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 24, 0.013, 6, false), dark, [0, 0, 0], null, null, helm);
    add(new THREE.SphereGeometry(0.035, 12, 10), dark, [0.06, -0.24, 0.36], null, [1.3, 1, 1], helm);
  } else if (a.accessory === 'crest') {
    add(arc(0.04, R + 0.025, -0.25 * Math.PI, 0.62 * Math.PI), accM, [0, 0, 0], null, [0.6, 1, 1], helm);
  } else if (a.accessory === 'stripe' || a.bot) {
    add(arc(0.03, R + 0.004, -0.33 * Math.PI, 0.3 * Math.PI), accM, [0, 0, 0], null, [1.6, 1, 1], helm);
  } else if (a.accessory === 'antenna') {
    add(new THREE.CylinderGeometry(0.01, 0.012, 0.3, 8), dark, [0.17, R + 0.06, -0.08], [0, 0, -0.35], null, helm);
    add(new THREE.SphereGeometry(0.032, 12, 10), accM, [0.22, R + 0.2, -0.08], null, null, helm);
  }
  if (a.bot) {   // HEPGO §44 yapay zekâ pilot: "AI" kask yazıları (alın + iki yan) + anten
    const tex = textTexture(THREE, 'AI', { w: 128, h: 64, fg: '#ffffff', font: '900 50px system-ui, sans-serif' }); disp.push(tex);
    const mat = M({ map: tex, transparent: true, roughness: 0.4, alphaTest: 0.1 });
    const t = Math.PI * 0.2;
    add(new THREE.PlaneGeometry(0.2, 0.1), mat, [0, Math.cos(t) * (R + 0.006), Math.sin(t) * (R + 0.006)], [-(Math.PI / 2 - t), 0, 0], null, helm);
    for (const sx of [-1, 1]) add(new THREE.PlaneGeometry(0.2, 0.1), mat, [sx * (R + 0.012), 0.08, -0.08], [0, sx * Math.PI / 2, 0], null, helm);
    add(new THREE.CylinderGeometry(0.01, 0.012, 0.26, 8), dark, [-0.17, R + 0.05, -0.08], [0, 0, 0.35], null, helm);
    add(new THREE.SphereGeometry(0.03, 12, 10), accM, [-0.21, R + 0.17, -0.08], null, null, helm);
  }
  g.userData.head = head;
  g.userData.dispose = () => { for (const d of disp) { try { d.dispose(); } catch { /* */ } } };
  return g;
}

/** Stüdyo ışıkları (sahneye bir kez). */
export function addAvatarLights(THREE, scene) {
  const hemi = new THREE.HemisphereLight(0xdbeafe, 0x1f2937, 0.75);
  const key = new THREE.DirectionalLight(0xffffff, 1.9); key.position.set(1.6, 2.4, 2.6);
  const rim = new THREE.DirectionalLight(0x93c5fd, 1.4); rim.position.set(-2, 1.6, -2.2);
  scene.add(hemi, key, rim);
  return [hemi, key, rim];
}

/** Portre kamerası (göğüs üstü). */
export function framePortrait(camera, { full = false } = {}) {
  if (full) { camera.fov = 30; camera.position.set(0.6, 0.5, 3.7); camera.lookAt(0, 0.2, 0); }
  else { camera.fov = 28; camera.position.set(0.3, 0.6, 2.55); camera.lookAt(0, 0.38, 0); }
  camera.updateProjectionMatrix();
}

/** 2B yedek portre (WebGL yokken / uçuş sırasında önbellekte yoksa) — aynı ayardan düz çizim. */
export function drawAvatar2D(ctx, cfg, size = 128) {
  const a = normAvatar(cfg), S = size, skin = SKINS[a.skin] || SKINS.s4;
  ctx.clearRect(0, 0, S, S);
  ctx.save(); ctx.scale(S / 128, S / 128);
  // gövde
  const gb = ctx.createLinearGradient(0, 92, 0, 128); gb.addColorStop(0, shade(a.suit, 0.12)); gb.addColorStop(1, shade(a.suit, -0.3));
  ctx.fillStyle = gb; ctx.beginPath(); ctx.moveTo(14, 128); ctx.bezierCurveTo(18, 104, 36, 96, 64, 96); ctx.bezierCurveTo(92, 96, 110, 104, 114, 128); ctx.closePath(); ctx.fill();
  ctx.fillStyle = shade(a.suit, -0.35); ctx.fillRect(62.5, 100, 3, 28);
  drawPatch(ctx, a.patch, a.patch_color, 86, 112, 8);
  // boyun + yüz
  ctx.fillStyle = skin; ctx.fillRect(55, 80, 18, 18);
  ctx.beginPath(); ctx.ellipse(64, 64, 25, 29, 0, 0, Math.PI * 2); ctx.fill();
  // kask
  const gh = ctx.createLinearGradient(30, 20, 98, 90); gh.addColorStop(0, shade(a.helmet, 0.25)); gh.addColorStop(1, shade(a.helmet, -0.25));
  ctx.fillStyle = gh; ctx.beginPath(); ctx.arc(64, 60, 33, Math.PI * 0.93, Math.PI * 2.07); ctx.lineTo(97, 74); ctx.lineTo(88, 74); ctx.lineTo(88, 58); ctx.lineTo(40, 58); ctx.lineTo(40, 74); ctx.lineTo(31, 74); ctx.closePath(); ctx.fill();
  ctx.fillStyle = shade(a.helmet, -0.5); ctx.fillRect(28, 66, 6, 12); ctx.fillRect(94, 66, 6, 12);
  // vizör
  ctx.save(); ctx.beginPath(); ctx.ellipse(64, 66, 26, 12, 0, 0, Math.PI * 2); ctx.clip();
  if (a.mirror) { const gv = ctx.createLinearGradient(40, 54, 88, 78); gv.addColorStop(0, shade(a.visor, 0.55)); gv.addColorStop(0.45, a.visor); gv.addColorStop(1, shade(a.visor, -0.45)); ctx.fillStyle = gv; ctx.fillRect(36, 52, 56, 28); }
  else { ctx.fillStyle = '#1a1a1a'; ctx.beginPath(); ctx.ellipse(55, 67, 3, 4, 0, 0, Math.PI * 2); ctx.ellipse(73, 67, 3, 4, 0, 0, Math.PI * 2); ctx.fill(); ctx.globalAlpha = 0.45; ctx.fillStyle = a.visor; ctx.fillRect(36, 52, 56, 28); }
  ctx.restore();
  // aksesuar
  ctx.fillStyle = a.patch_color; ctx.strokeStyle = a.patch_color;
  if (a.accessory === 'crest') ctx.fillRect(61, 24, 6, 26);
  else if (a.accessory === 'stripe' || a.bot) ctx.fillRect(58, 27, 12, 30);
  else if (a.accessory === 'antenna') { ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(80, 32); ctx.lineTo(90, 12); ctx.stroke(); ctx.beginPath(); ctx.arc(90, 12, 3.5, 0, Math.PI * 2); ctx.fill(); }
  else if (a.accessory === 'mic') { ctx.strokeStyle = '#15171c'; ctx.lineWidth = 2.5; ctx.beginPath(); ctx.moveTo(95, 74); ctx.quadraticCurveTo(92, 86, 72, 86); ctx.stroke(); }
  if (a.bot) { ctx.fillStyle = '#fff'; ctx.font = '900 13px system-ui, sans-serif'; ctx.textAlign = 'center'; ctx.fillText('AI', 64, 46); }
  ctx.restore();
}
