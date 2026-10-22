// SIMUMAV §25 — avatar görüntü önbelleği + canlı dönen 3B önizleme (oyun kabuğu).
// WebGL kuralı: TEK paylaşılan çizici (/app/core/three.js). Uçuş ekranı açıkken (.sm-fly-session) avatar için WebGL'e HİÇ dokunulmaz:
//   önbellekte (bellek + sessionStorage) varsa o PNG, yoksa aynı ayardan 2B yedek portre (drawAvatar2D). Salon (uçuş öncesi) `precacheAvatars`
//   ile oyuncu avatarlarını 128 px PNG'ye render eder → yarış ekranı skor tablosu / sonuç penceresi yalnız <img> kullanır.
import { loadThree, makeStage, snapshot } from '../core/three.js';
import { avatarKey, normAvatar, playerAvatar } from './avatar_core.js';
import { addAvatarLights, buildAvatar, drawAvatar2D, framePortrait } from './avatar_mesh.js';

const mem = new Map();               // anahtar → dataURL
const SS = 'sm.av.';
const SS_MAX = 48;
export const inFlight = () => typeof document !== 'undefined' && !!document.querySelector('.sm-fly-session');

function ssGet(k) { try { return sessionStorage.getItem(SS + k); } catch { return null; } }
function ssSet(k, v) {
  try {
    const keys = JSON.parse(sessionStorage.getItem(`${SS}keys`) || '[]').filter(x => x !== k);
    keys.push(k);
    while (keys.length > SS_MAX) sessionStorage.removeItem(SS + keys.shift());
    sessionStorage.setItem(SS + k, v); sessionStorage.setItem(`${SS}keys`, JSON.stringify(keys));
  } catch { /* kota / özel mod */ }
}
/** Önbellekte varsa dataURL (yoksa null) — WebGL'e dokunmaz. */
export function cachedAvatar(cfg, size = 128) {
  const k = avatarKey(cfg, size);
  if (mem.has(k)) return mem.get(k);
  const v = ssGet(k);
  if (v) { mem.set(k, v); return v; }
  return null;
}
/** 2B yedek portre dataURL (WebGL yok; bellekte tutulur — skor tablosu 4 Hz yeniden çizilir). */
const fbMem = new Map();
export function fallbackAvatar(cfg, size = 128) {
  const k = avatarKey(cfg, size);
  if (fbMem.has(k)) return fbMem.get(k);
  const c = document.createElement('canvas'); c.width = size; c.height = size;
  drawAvatar2D(c.getContext('2d'), cfg, size);
  const u = c.toDataURL('image/png');
  if (fbMem.size > 64) fbMem.clear();
  fbMem.set(k, u);
  return u;
}
/** Avatar stil dosyası (crew/avatar.css) bir kez. */
export function ensureAvatarCss() {
  if (typeof document === 'undefined' || document.getElementById('sm-avatar-css')) return;
  const l = document.createElement('link'); l.id = 'sm-avatar-css'; l.rel = 'stylesheet'; l.href = '/app/crew/avatar.css';
  document.head.append(l);
}

let shot = null;   // {lib, scene, camera}
async function shotRig() {
  if (shot) return shot;
  const lib = await loadThree(), { THREE } = lib;
  const scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera(28, 1, 0.05, 50);
  addAvatarLights(THREE, scene); framePortrait(camera);
  shot = { lib, scene, camera };
  return shot;
}
let queue = Promise.resolve();
/** 3B avatar → PNG dataURL (önbellekli). Uçuş ekranı açıkken WebGL kullanmaz (önbellek ya da 2B yedek). */
export function avatarImage(cfg, size = 128) {
  const hit = cachedAvatar(cfg, size);
  if (hit) return Promise.resolve(hit);
  if (inFlight()) return Promise.resolve(fallbackAvatar(cfg, size));
  const k = avatarKey(cfg, size);
  const job = queue.then(async () => {
    if (mem.has(k)) return mem.get(k);
    if (inFlight()) return fallbackAvatar(cfg, size);
    let url = null;
    try {
      const r = await shotRig(), { THREE } = r.lib;
      const g = buildAvatar(THREE, cfg); g.rotation.y = -0.18;
      r.scene.add(g);
      const cv = snapshot(r.lib, r.scene, r.camera, size, size);
      r.scene.remove(g); g.userData.dispose();
      url = cv ? cv.toDataURL('image/png') : null;
    } catch { url = null; }
    if (!url) return fallbackAvatar(cfg, size);   // WebGL yok → yedek (önbelleğe yazılmaz; sonra 3B denenir)
    mem.set(k, url); ssSet(k, url);
    return url;
  });
  queue = job.catch(() => null);
  return job;
}
/** Oyuncu listesi avatarlarını önceden render et (salon; uçuş öncesi). */
export function precacheAvatars(players = [], size = 128) {
  return Promise.all(players.map(p => avatarImage(playerAvatar(p), size).catch(() => null)));
}
/** <img> öğesi: önbellek → hemen; yoksa 2B yedek gösterilir, (uçuş dışında) 3B hazır olunca değişir. */
export function avatarImg(cfg, { size = 128, cls = 'sm-av', alt = '' } = {}) {
  const img = document.createElement('img');
  img.className = cls; img.alt = alt; img.width = size; img.height = size; img.decoding = 'async'; img.draggable = false;
  const hit = cachedAvatar(cfg, size);
  img.src = hit || fallbackAvatar(cfg, size);
  if (!hit && !inFlight()) avatarImage(cfg, size).then(u => { if (u) img.src = u; }).catch(() => {});
  return img;
}
export const playerImg = (p, o = {}) => avatarImg(playerAvatar(p), { cls: 'sm-av', ...o });
/** Sonuç/sıralama satırı → oyuncu listesindeki kaydıyla (avatar, bot seviyesi) birleşik <img>. */
export const rowImg = (players, r, o = {}) => { const p = (players || []).find(x => x.id === r.id) || {}; return playerImg({ ...p, ...r, avatar: p.avatar ?? r.avatar, level: r.level ?? p.level, is_bot: !!(r.is_bot || p.is_bot) }, o); };

/** Canlı dönen 3B önizleme (mürettebat düzenleyici / kart). host: kapsayıcı. Dönüş: {set(cfg, name), dispose()} */
export async function mountAvatarStage(host, cfg, { name = '', spin = 0.5, full = true, drag = true } = {}) {
  const lib = await loadThree(), { THREE } = lib;
  let model = null, yaw = 0, dragging = false, lastX = 0, vel = spin;
  const stage = makeStage(lib, host, { fov: 30, env: true, pixelRatioMax: 2, onFrame: dt => {
    if (!model) return;
    if (!dragging) { vel += (spin - vel) * Math.min(1, dt * 1.5); yaw += vel * dt; }
    model.rotation.y = yaw;
    if (model.userData.head) model.userData.head.rotation.z = Math.sin(performance.now() / 900) * 0.03;
  } });
  addAvatarLights(THREE, stage.scene); framePortrait(stage.camera, { full });
  const set = (c, nm = name) => { if (model) { stage.scene.remove(model); model.userData.dispose(); } model = buildAvatar(THREE, normAvatar(c), { name: nm }); stage.scene.add(model); };
  set(cfg, name);
  const cv = stage.canvas;
  const down = e => { if (!drag) return; dragging = true; lastX = e.clientX; cv.setPointerCapture?.(e.pointerId); };
  const move = e => { if (!dragging) return; const dx = e.clientX - lastX; lastX = e.clientX; yaw += dx * 0.012; vel = dx * 0.6; };
  const up = () => { dragging = false; };
  cv.addEventListener('pointerdown', down); cv.addEventListener('pointermove', move); cv.addEventListener('pointerup', up); cv.addEventListener('pointercancel', up);
  cv.style.touchAction = 'pan-y'; cv.style.cursor = drag ? 'grab' : '';
  stage.start();
  return {
    set, stage,
    dispose() { try { model?.userData.dispose(); } catch { /* */ } stage.dispose(); },
  };
}
