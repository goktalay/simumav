// SIMUMAV §25 — prosedürel düşük poli 3B pilot avatarı (three.js ile üretilir; harici varlık/lisans YOK) + aynı ayardan 2B yedek portre.
// THREE dışarıdan verilir (import yok) → oyun kabuğu (/app/core/three.js) ve tanıtım sitesi (/site/js/stage.js) aynı modülü kullanır.
// Geometri §28'den beri avatar_body.js'de (büst + TAM BOY karakter: beden, yüz, saç, başlık, kıyafet, RC kumanda); bu modül yama çizimi, ışıklar,
// kadraj ve 2B yedek portreyi sağlar (geri uyumlu dışa aktarımlar: buildAvatar, drawPatch, addAvatarLights, framePortrait, drawAvatar2D).
import { SKINS, normAvatar, shade } from './avatar_core.js';
import { FEET_Y, HEAD_Y, buildCharacter, mix, setPatchDrawer } from './avatar_body.js';

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

setPatchDrawer(drawPatch);

/** Avatar grubu (§25 büst; §28 pose:'full' tam boy). opts.name: göğüs isim bandı. Dönüş: THREE.Group (userData.dispose() dokular + geometriler,
 *  userData.head baş kemiği). Ayrıntı: avatar_body.js buildCharacter. */
export function buildAvatar(THREE, cfg, { name = '', pose = 'bust', lod = 'high', rc = false } = {}) {
  return buildCharacter(THREE, cfg, { pose, lod, name, rc, merged: false });
}

/** Stüdyo ışıkları (sahneye bir kez). */
export function addAvatarLights(THREE, scene) {
  const hemi = new THREE.HemisphereLight(0xdbeafe, 0x1f2937, 0.75);
  const key = new THREE.DirectionalLight(0xffffff, 1.9); key.position.set(1.6, 2.4, 2.6);
  const rim = new THREE.DirectionalLight(0x93c5fd, 1.4); rim.position.set(-2, 1.6, -2.2);
  scene.add(hemi, key, rim);
  return [hemi, key, rim];
}

/** Kamera kadrajı. Büst: {full:false} göğüs üstü (önbellek portresi) · {full:true} geniş büst. §28 tam boy: view 'body' (baştan ayağa) | 'face' (yüz). */
export const FRAMES = {
  bust: { fov: 28, pos: [0.3, 0.6, 2.55], look: [0, 0.38, 0] },
  bustWide: { fov: 30, pos: [0.6, 0.5, 3.7], look: [0, 0.2, 0] },
  body: { fov: 30, pos: [1.1, -0.2, 8.6], look: [0, (1.0 + FEET_Y) / 2, 0] },
  face: { fov: 26, pos: [0.3, HEAD_Y + 0.06, 2.45], look: [0, HEAD_Y - 0.05, 0] },
};
export function framePortrait(camera, { full = false, view = null } = {}) {
  const f = FRAMES[view] || (full ? FRAMES.bustWide : FRAMES.bust);
  camera.fov = f.fov; camera.position.set(...f.pos); camera.lookAt(...f.look);
  camera.updateProjectionMatrix();
  return f;
}

/** 2B yedek portre (WebGL yokken / uçuş sırasında önbellekte yoksa) — aynı ayardan düz çizim (§28: saç, yüz, gözlük, sakal, başlık). */
export function drawAvatar2D(ctx, cfg, size = 128) {
  const a = normAvatar(cfg), S = size, skin = SKINS[a.skin] || SKINS.s4, f = a.body === 'f';
  const hg = a.bot ? 'helmet' : a.headgear, helmet = hg === 'helmet', open = helmet && a.visor_open && !a.bot, hair = a.hair_color;
  ctx.clearRect(0, 0, S, S);
  ctx.save(); ctx.scale(S / 128, S / 128);
  const ell = (x, y, rx, ry, col) => { ctx.fillStyle = col; ctx.beginPath(); ctx.ellipse(x, y, rx, ry, 0, 0, Math.PI * 2); ctx.fill(); };
  // ense saçı (uzun / küt / at kuyruğu) — başın arkasında
  if (a.hair === 'long') { ctx.fillStyle = hair; ctx.fillRect(f ? 38 : 40, 56, f ? 52 : 48, 46); }
  else if (a.hair === 'bob' && !helmet) { ctx.fillStyle = hair; ctx.fillRect(37, 52, 54, 28); }
  else if (a.hair === 'ponytail') { ctx.fillStyle = hair; ctx.beginPath(); ctx.ellipse(86, 82, 7, 18, -0.3, 0, Math.PI * 2); ctx.fill(); }
  // gövde
  const gb = ctx.createLinearGradient(0, 92, 0, 128); gb.addColorStop(0, shade(a.suit, 0.12)); gb.addColorStop(1, shade(a.suit, -0.3));
  const sw = f ? 4 : 0;
  ctx.fillStyle = gb; ctx.beginPath(); ctx.moveTo(14 + sw, 128); ctx.bezierCurveTo(18 + sw, 104, 36, 96, 64, 96); ctx.bezierCurveTo(92, 96, 110 - sw, 104, 114 - sw, 128); ctx.closePath(); ctx.fill();
  if (a.outfit === 'jacket') { ctx.fillStyle = '#d6c7a1'; ctx.beginPath(); ctx.ellipse(64, 98, 16, 6, 0, 0, Math.PI * 2); ctx.fill(); }
  if (a.outfit !== 'casual') { ctx.fillStyle = shade(a.suit, -0.35); ctx.fillRect(62.5, 100, 3, 28); }
  drawPatch(ctx, a.patch, a.patch_color, 86, 112, 8);
  // boyun + yüz
  ctx.fillStyle = skin; ctx.fillRect(55, 80, 18, 18);
  const fw = { oval: 24, round: 26, square: 26, long: 22, heart: 25 }[a.face] || 24, fh = { long: 31, round: 27 }[a.face] || 29;
  ell(64, 64, f ? fw - 1.5 : fw, fh, skin);
  const showFace = !helmet || open || !a.mirror;
  if (showFace) {
    const ey = 63, er = { narrow: [3.4, 1.8], wide: [3.4, 3.4], round: [2.8, 2.8] }[a.eyes] || [3.2, 2.4];
    for (const x of [55, 73]) { ell(x, ey, er[0] + 1, er[1] + 0.8, '#f4f4f5'); ell(x, ey, er[1] * 0.9, er[1] * 0.9, a.eye_color); }
    if (!helmet || open) {
      ctx.fillStyle = shade(hair, -0.3); const bw = { thin: 1.2, medium: 2, thick: 3 }[a.brow_w] || 2;
      ctx.fillRect(49, ey - 8 - bw / 2, 12, bw); ctx.fillRect(67, ey - 8 - bw / 2, 12, bw);
      ctx.strokeStyle = f ? '#b24a5e' : shade(skin, -0.35); ctx.lineWidth = 2; ctx.beginPath();
      if (a.mouth === 'smile' || a.mouth === 'grin') ctx.arc(64, 74, 6, 0.2 * Math.PI, 0.8 * Math.PI); else { ctx.moveTo(58, 79); ctx.lineTo(70, 79); }
      ctx.stroke();
      if (!f && a.beard !== 'none') {
        ctx.fillStyle = a.beard === 'stubble' ? `${shade(hair, 0.1)}55` : hair;
        if (a.beard === 'stubble' || a.beard === 'full') { ctx.beginPath(); ctx.ellipse(64, 80, 22, 13, 0, 0, Math.PI); ctx.fill(); }
        if (a.beard !== 'stubble') { ctx.fillRect(56, 73, 16, 3); }
        if (a.beard === 'goatee') { ctx.beginPath(); ctx.ellipse(64, 89, 5, 6, 0, 0, Math.PI * 2); ctx.fill(); }
      }
      if (a.freckles) { ctx.fillStyle = shade(skin, -0.3); for (const [x, y] of [[50, 70], [54, 72], [74, 72], [78, 70]]) ctx.fillRect(x, y, 1.5, 1.5); }
    }
    if (a.glasses !== 'none') {
      ctx.fillStyle = a.glasses === 'sun' ? '#0b0b0d' : 'rgba(63,74,42,.75)'; ctx.strokeStyle = a.glasses === 'sun' ? '#18181b' : '#c9a227'; ctx.lineWidth = 1.4;
      for (const x of [55, 73]) { ctx.beginPath(); if (a.glasses === 'sun') ctx.rect(x - 7, ey - 4, 14, 9); else ctx.ellipse(x, ey + 1, 7, 6, 0, 0, Math.PI * 2); ctx.fill(); ctx.stroke(); }
    }
  }
  // saç (kasksız)
  if (!helmet && a.hair !== 'bald') {
    ctx.fillStyle = a.hair === 'buzz' ? shade(hair, 0.15) : hair;
    ctx.beginPath(); ctx.arc(64, 60, 27, Math.PI * 1.02, Math.PI * 1.98); ctx.lineTo(90, 50); ctx.quadraticCurveTo(64, 40, 38, 50); ctx.closePath(); ctx.fill();
    if (a.hair === 'bun' && hg !== 'cap') ell(64, 30, 9, 8, hair);
    if (a.hair === 'mohawk' && hg !== 'cap') { ctx.fillRect(60, 22, 8, 16); }
    if (a.hair === 'spiky' && hg !== 'cap') for (let i = 0; i < 5; i++) { ctx.beginPath(); ctx.moveTo(44 + i * 10, 38); ctx.lineTo(49 + i * 10, 26); ctx.lineTo(54 + i * 10, 38); ctx.fill(); }
    if (a.hair === 'curly') for (let i = 0; i < 7; i++) ell(40 + i * 8, 38 + Math.abs(3 - i) * 2.5, 6, 6, hair);
    if (a.hair === 'long' || a.hair === 'bob') { ctx.fillRect(36, 50, 6, a.hair === 'long' ? 40 : 26); ctx.fillRect(86, 50, 6, a.hair === 'long' ? 40 : 26); }
  }
  if (hg === 'cap') {
    ctx.fillStyle = a.helmet; ctx.beginPath(); ctx.arc(64, 52, 28, Math.PI, Math.PI * 2); ctx.closePath(); ctx.fill();
    ctx.fillStyle = shade(a.helmet, -0.2); ctx.beginPath(); ctx.ellipse(64, 52, 30, 5, 0, 0, Math.PI); ctx.fill();
  } else if (hg === 'headset') {
    ctx.strokeStyle = '#15171c'; ctx.lineWidth = 4; ctx.beginPath(); ctx.arc(64, 62, 31, Math.PI * 1.05, Math.PI * 1.95); ctx.stroke();
    ctx.fillStyle = a.helmet; ctx.fillRect(30, 58, 8, 16); ctx.fillRect(90, 58, 8, 16);
  } else if (helmet) {
    const gh = ctx.createLinearGradient(30, 20, 98, 90); gh.addColorStop(0, shade(a.helmet, 0.25)); gh.addColorStop(1, shade(a.helmet, -0.25));
    ctx.fillStyle = gh; ctx.beginPath(); ctx.arc(64, 60, 33, Math.PI * 0.93, Math.PI * 2.07); ctx.lineTo(97, 74); ctx.lineTo(88, 74); ctx.lineTo(88, 58); ctx.lineTo(40, 58); ctx.lineTo(40, 74); ctx.lineTo(31, 74); ctx.closePath(); ctx.fill();
    ctx.fillStyle = shade(a.helmet, -0.5); ctx.fillRect(28, 66, 6, 12); ctx.fillRect(94, 66, 6, 12);
    // vizör (açıkken kaskın üstünde ince bant)
    if (open) { ctx.fillStyle = mix(a.visor, '#000000', 0.2); ctx.beginPath(); ctx.ellipse(64, 34, 24, 6, 0, 0, Math.PI * 2); ctx.fill(); }
    else {
      ctx.save(); ctx.beginPath(); ctx.ellipse(64, 66, 26, 12, 0, 0, Math.PI * 2); ctx.clip();
      if (a.mirror) { const gv = ctx.createLinearGradient(40, 54, 88, 78); gv.addColorStop(0, shade(a.visor, 0.55)); gv.addColorStop(0.45, a.visor); gv.addColorStop(1, shade(a.visor, -0.45)); ctx.fillStyle = gv; ctx.fillRect(36, 52, 56, 28); }
      else { ctx.fillStyle = '#1a1a1a'; ctx.beginPath(); ctx.ellipse(55, 67, 3, 4, 0, 0, Math.PI * 2); ctx.ellipse(73, 67, 3, 4, 0, 0, Math.PI * 2); ctx.fill(); ctx.globalAlpha = 0.45; ctx.fillStyle = a.visor; ctx.fillRect(36, 52, 56, 28); }
      ctx.restore();
    }
    // aksesuar
    ctx.fillStyle = a.patch_color; ctx.strokeStyle = a.patch_color;
    if (a.accessory === 'crest') ctx.fillRect(61, 24, 6, 26);
    else if (a.accessory === 'stripe' || a.bot) ctx.fillRect(58, 27, 12, 30);
    else if (a.accessory === 'antenna') { ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(80, 32); ctx.lineTo(90, 12); ctx.stroke(); ctx.beginPath(); ctx.arc(90, 12, 3.5, 0, Math.PI * 2); ctx.fill(); }
    else if (a.accessory === 'mic') { ctx.strokeStyle = '#15171c'; ctx.lineWidth = 2.5; ctx.beginPath(); ctx.moveTo(95, 74); ctx.quadraticCurveTo(92, 86, 72, 86); ctx.stroke(); }
    if (a.bot) { ctx.fillStyle = '#fff'; ctx.font = '900 13px system-ui, sans-serif'; ctx.textAlign = 'center'; ctx.fillText('AI', 64, 46); }
  }
  if (hg === 'headset') { ctx.strokeStyle = '#15171c'; ctx.lineWidth = 2.5; ctx.beginPath(); ctx.moveTo(94, 72); ctx.quadraticCurveTo(92, 84, 72, 84); ctx.stroke(); }
  ctx.restore();
}
