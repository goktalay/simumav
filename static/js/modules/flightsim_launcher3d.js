// Uçuş Simülatörü §27 — INTERCEPTOR fırlatıcılarının PROSEDÜREL 3B modelleri + düzenek (rig) aşama makinesi. three.js `T` argümanla gelir (ağ isteği yok).
//  • buildPod(T, method): 4'lü (2×2) / 8'li (4×2) kutu fırlatıcı — kızaklı kaide + kaldırma halkaları, hücre ızgarası (iç bölmeler), her hücrede arka
//    kenardan menteşeli üst kapak (açılır), kapak önünde durum LED'i (dolu yeşil · sıradaki amber · boş kırmızı), ön yüzde hücre sayacı plakası (CanvasTexture,
//    dil bağımsız: ▮▮▯▯ 2/4), sarı-siyah ikaz şeritleri, yan kablo kutusu.
//  • buildTube(T): yerden tekli tüp — üç ayaklı sehpa + taban halkası, dikey tüp (ön/arka bilezik), menteşeli üst kapak, yan kontrol kutusu + LED.
//  • buildHandheld(T): pilot figürü (bot, bacak, gövde + yelek, kask + vizör, kollar nişana göre yeniden kurulur) + omuzda silah benzeri el fırlatıcısı
//    (sekizgen tüp, bilezikler, omuz yastığı, tabanca kabzası + tetik korkuluğu, ön kabza, nişan birimi) ve nişan biriminin ÜSTÜNDE küçük EKRAN
//    (`screen`: nişangâh kamerasının render hedefi dokusu + sembol katmanı; flightsim3d renderScope). Nişan: pilot az'a döner, tüp el kadar kalkar.
//  • createIceptRig(T, cfg): flightsim_launch createLaunchRig ile AYNI arayüz (anchor / needsAnchor / resurface / update / setPhase / carrying / …) +
//    carryPose (dron burun ekseni hücre/tüp ekseni; kuyruk tabanda), setInventory (hücre durumları), setAim, scopePose, screen.
// Yerel çerçeve: +Y ileri, +X sağ, +Z yukarı; GERÇEK metre (grup MODEL_SCALE ile büyütülür). Termal: her mesh userData.heat (pilot sıcak 0,9; ekran 0,7;
// kutu ılık 0,45; fırlatma anında hücre/tüp ağzı sıcak).
import { CELL, bankLayout, cellCount, cellDims, cellLayout, cellStates, launcherSize, normAim } from './flightsim_launcher.js';
import { isFineSample, surfaceFit, surfaceLock } from './flightsim_launch.js';

const DEG = Math.PI / 180;
const HATCH_OPEN = 1.92;   // rad (~110°, arkaya devrilmiş)

const mats = T => ({
  olive: new T.MeshStandardMaterial({ color: 0x4d5536, roughness: 0.78, metalness: 0.18 }),
  oliveDk: new T.MeshStandardMaterial({ color: 0x353b26, roughness: 0.8, metalness: 0.2 }),
  steel: new T.MeshStandardMaterial({ color: 0x8b939a, roughness: 0.45, metalness: 0.7 }),
  dark: new T.MeshStandardMaterial({ color: 0x1d2024, roughness: 0.7, metalness: 0.3 }),
  soot: new T.MeshStandardMaterial({ color: 0x0d0e0f, roughness: 0.95 }),
  yellow: new T.MeshStandardMaterial({ color: 0xe8b21c, roughness: 0.55, metalness: 0.15 }),
  black: new T.MeshStandardMaterial({ color: 0x141414, roughness: 0.6 }),
  rubber: new T.MeshStandardMaterial({ color: 0x222427, roughness: 0.95 }),
  ledG: new T.MeshBasicMaterial({ color: 0x38f070, toneMapped: false }),
  ledA: new T.MeshBasicMaterial({ color: 0xffb020, toneMapped: false }),
  ledR: new T.MeshBasicMaterial({ color: 0xff3a2a, toneMapped: false }),
  ledOff: new T.MeshStandardMaterial({ color: 0x3a1512, roughness: 0.4 }),
  // pilot
  camo: new T.MeshStandardMaterial({ color: 0x6b6a4c, roughness: 0.9 }),
  camoDk: new T.MeshStandardMaterial({ color: 0x4a4935, roughness: 0.9 }),
  vest: new T.MeshStandardMaterial({ color: 0x55593f, roughness: 0.85 }),
  skin: new T.MeshStandardMaterial({ color: 0xc89a78, roughness: 0.7 }),
  boot: new T.MeshStandardMaterial({ color: 0x2b2620, roughness: 0.85 }),
  glove: new T.MeshStandardMaterial({ color: 0x1e1f1c, roughness: 0.8 }),
  helmet: new T.MeshStandardMaterial({ color: 0x585a40, roughness: 0.75, metalness: 0.1 }),
  visor: new T.MeshStandardMaterial({ color: 0x101820, roughness: 0.1, metalness: 0.8 }),
});

function mk(T, geo, mat, x, y, z, heat) {
  const m = new T.Mesh(geo, mat);
  m.position.set(x, y, z);
  m.castShadow = true; m.receiveShadow = true;
  m.userData.heat = heat;
  return m;
}
const box = (T, w, d, h, mat, x, y, z, heat = 0.45) => mk(T, new T.BoxGeometry(w, d, h), mat, x, y, z, heat);
const cylZ = (T, r, h, mat, x, y, z, heat = 0.45, seg = 16) => mk(T, new T.CylinderGeometry(r, r, h, seg).rotateX(Math.PI / 2), mat, x, y, z, heat);
const cylY = (T, r, h, mat, x, y, z, heat = 0.45, seg = 16) => mk(T, new T.CylinderGeometry(r, r, h, seg), mat, x, y, z, heat);

// Hücre sayacı plakası (dil bağımsız): ▮ dolu/sıradaki, ▯ boş; "n/N"
function counterPlate(T, w, h) {
  const cv = typeof document !== 'undefined' ? document.createElement('canvas') : null;
  if (!cv) return { mesh: null, draw: () => {} };
  cv.width = 256; cv.height = 80;
  const tex = new T.CanvasTexture(cv); tex.colorSpace = T.SRGBColorSpace;
  const mesh = new T.Mesh(new T.PlaneGeometry(w, h), new T.MeshBasicMaterial({ map: tex, toneMapped: false }));
  mesh.userData.heat = 0.55;
  let last = '';
  const draw = (states) => {
    const key = states.join(',');
    if (key === last) return;
    last = key;
    const g = cv.getContext('2d');
    g.fillStyle = '#0b120c'; g.fillRect(0, 0, 256, 80);
    g.strokeStyle = '#3b4a36'; g.lineWidth = 4; g.strokeRect(2, 2, 252, 76);
    const n = states.length, full = states.filter(s => s === 'loaded' || s === 'active').length;
    const cw = Math.min(26, 150 / n), gap = 4;
    for (let i = 0; i < n; i++) {
      const s = states[i], x = 14 + i * (cw + gap);
      g.fillStyle = s === 'active' ? '#ffb020' : s === 'loaded' ? '#38f070' : '#41201c';
      g.fillRect(x, 18, cw, 44);
      if (s === 'spent' || s === 'empty') { g.strokeStyle = '#ff3a2a'; g.lineWidth = 2; g.strokeRect(x + 1, 19, cw - 2, 42); }
    }
    g.fillStyle = full ? '#9cff9c' : '#ff7a6a'; g.font = '700 34px ui-monospace, Menlo, Consolas, monospace'; g.textAlign = 'right'; g.textBaseline = 'middle';
    g.fillText(`${full}/${n}`, 244, 42);
    tex.needsUpdate = true;
  };
  return { mesh, draw };
}

// ---------- kutu fırlatıcı (4'lü / 8'li) ----------
// dims: flightsim_launcher.cellDims(fit) — hücre iç genişliği / derinliği dronun gerçek boyutundan (kanister drona göre)
export function buildPod(T, method, M = mats(T), dims = CELL) {
  const g = new T.Group(); g.name = `launcher_${method}`;
  const cells = cellLayout(method, dims), [W, D] = launcherSize(method, dims);
  const z0 = dims.base, H = dims.depth, top = z0 + H, IN = dims.inner, P = dims.pitch;
  // kızaklı kaide + ayaklar + forklift cepleri
  for (const x of [-W / 2 + 0.08, W / 2 - 0.08]) g.add(box(T, 0.1, D + 0.18, 0.08, M.oliveDk, x, 0, 0.04, 0.3));
  g.add(box(T, W - 0.04, D - 0.04, 0.06, M.oliveDk, 0, 0, z0 - 0.17, 0.35));
  for (const sx of [-1, 1]) for (const sy of [-1, 1]) g.add(box(T, 0.08, 0.08, z0 - 0.08, M.oliveDk, sx * (W / 2 - 0.1), sy * (D / 2 - 0.1), 0.04 + (z0 - 0.08) / 2, 0.3));
  for (const x of [-W / 4, W / 4]) g.add(box(T, 0.16, D + 0.02, 0.07, M.dark, x, 0, z0 - 0.1, 0.3));
  g.add(box(T, W, D, 0.04, M.dark, 0, 0, z0 - 0.02, 0.4));                       // hücre tabanı
  // dış duvarlar (dikey nervürlü)
  const t = dims.wall;
  g.add(box(T, W, t, H, M.olive, 0, D / 2 - t / 2, z0 + H / 2)); g.add(box(T, W, t, H, M.olive, 0, -D / 2 + t / 2, z0 + H / 2));
  g.add(box(T, t, D, H, M.olive, W / 2 - t / 2, 0, z0 + H / 2)); g.add(box(T, t, D, H, M.olive, -W / 2 + t / 2, 0, z0 + H / 2));
  for (let k = 1; k < Math.round(W / 0.22); k++) for (const sy of [-1, 1]) g.add(box(T, 0.025, 0.02, H * 0.92, M.oliveDk, -W / 2 + k * W / Math.round(W / 0.22), sy * (D / 2 + 0.008), z0 + H / 2, 0.42));
  // iç bölmeler (hücreler arası)
  const d = method === 'pod8' ? { cols: 4, rows: 2 } : { cols: 2, rows: 2 };
  for (let c = 1; c < d.cols; c++) g.add(box(T, 0.03, D - 2 * t, H, M.oliveDk, (c - d.cols / 2) * P, 0, z0 + H / 2, 0.4));
  for (let r = 1; r < d.rows; r++) g.add(box(T, W - 2 * t, 0.03, H, M.oliveDk, 0, (d.rows / 2 - r) * P, z0 + H / 2, 0.4));
  // üst çerçeve + köşe kaldırma halkaları + ikaz şeritleri
  g.add(box(T, W + 0.02, 0.05, 0.04, M.oliveDk, 0, D / 2 - 0.02, top + 0.02)); g.add(box(T, W + 0.02, 0.05, 0.04, M.oliveDk, 0, -D / 2 + 0.02, top + 0.02));
  g.add(box(T, 0.05, D + 0.02, 0.04, M.oliveDk, W / 2 - 0.02, 0, top + 0.02)); g.add(box(T, 0.05, D + 0.02, 0.04, M.oliveDk, -W / 2 + 0.02, 0, top + 0.02));
  for (let c = 1; c < d.cols; c++) g.add(box(T, 0.05, D, 0.04, M.oliveDk, (c - d.cols / 2) * P, 0, top + 0.02, 0.42));
  for (let r = 1; r < d.rows; r++) g.add(box(T, W, 0.05, 0.04, M.oliveDk, 0, (d.rows / 2 - r) * P, top + 0.02, 0.42));
  for (const sx of [-1, 1]) for (const sy of [-1, 1]) { const ring = mk(T, new T.TorusGeometry(0.035, 0.01, 6, 14), M.steel, sx * (W / 2 - 0.05), sy * (D / 2 - 0.05), top + 0.07, 0.3); ring.rotation.x = Math.PI / 2; g.add(ring); }
  const nS = Math.round(W / 0.12);
  for (let k = 0; k < nS; k++) g.add(box(T, 0.06, 0.006, 0.04, k % 2 ? M.black : M.yellow, -W / 2 + 0.06 + k * (W - 0.12) / Math.max(1, nS - 1), D / 2 + 0.012, top - 0.05, 0.4));
  // yan kablo kutusu + bağlantı
  g.add(box(T, 0.06, Math.min(0.32, D * 0.4), 0.2, M.dark, W / 2 + 0.03, -D / 4, z0 + 0.15, 0.55));
  g.add(cylY(T, 0.018, 0.25, M.rubber, W / 2 + 0.04, -D / 4, z0 - 0.06, 0.4, 8));
  // hücreler: kapak menteşesi (arka kenar), kapak, LED, iç dip (is)
  const out = [];
  for (const c of cells) {
    const floor = box(T, IN, IN, 0.012, M.dark, c.x, c.y, z0 + 0.008, 0.4); g.add(floor);
    const hinge = new T.Group(); hinge.position.set(c.x, c.y - IN / 2 - 0.02, top + 0.045); g.add(hinge);
    const hatch = box(T, IN + 0.06, IN + 0.06, 0.028, M.olive, 0, IN / 2 + 0.02, 0, 0.42); hinge.add(hatch);
    hatch.add(box(T, IN * 0.7, 0.04, 0.012, M.oliveDk, 0, 0, 0.02, 0.42));   // takviye nervürleri (X)
    hatch.add(box(T, 0.04, IN * 0.7, 0.012, M.oliveDk, 0, 0, 0.02, 0.42));
    hatch.add(box(T, IN * 0.3, 0.05, 0.004, M.yellow, 0, -IN * 0.36, 0.016, 0.42));   // kapak ikaz bandı
    hinge.add(cylY(T, 0.012, IN * 0.8, M.steel, 0, 0, 0, 0.3, 8).rotateZ(Math.PI / 2));
    const led = mk(T, new T.SphereGeometry(0.02, 8, 6), M.ledG, c.x + IN / 2 - 0.02, c.y + P / 2 - 0.025, top + 0.055, 0.6); g.add(led);
    out.push({ x: c.x, y: c.y, floorZ: z0 + 0.015, hinge, led, floor, ang: 0, target: 0 });
  }
  // sayaç plakası (ön yüz)
  const plate = counterPlate(T, Math.min(0.56, W * 0.48), Math.min(0.17, H * 0.32));
  if (plate.mesh) { plate.mesh.rotation.x = Math.PI / 2; plate.mesh.position.set(-W / 4, D / 2 + 0.014, z0 + H * 0.45); g.add(plate.mesh); }
  return { group: g, cells: out, mouthZ: top + 0.06, plate, size: [W, D] };
}

// ---------- yerden tekli tüp ----------
export function buildTube(T, M = mats(T), dims = CELL) {
  const g = new T.Group(); g.name = 'launcher_tube';
  const R = dims.tubeR ?? 0.3, L = dims.tubeL ?? 0.62, z0 = 0.36, top = z0 + L, F = Math.max(0.45, R * 1.7);
  for (let k = 0; k < 3; k++) {   // üç ayak (dışa açılı) + ayak tabanları
    const a = k * 2.0944 + Math.PI / 2, fx = Math.cos(a) * F, fy = Math.sin(a) * F;
    const a0 = new T.Vector3(fx, fy, 0.02), a1 = new T.Vector3(Math.cos(a) * (R + 0.04), Math.sin(a) * (R + 0.04), z0 + 0.12), dv = a1.clone().sub(a0);
    const leg = cylY(T, 0.025, dv.length(), M.oliveDk, 0, 0, 0, 0.3, 8);
    leg.position.copy(a0).addScaledVector(dv, 0.5); leg.quaternion.setFromUnitVectors(new T.Vector3(0, 1, 0), dv.normalize()); g.add(leg);
    g.add(cylZ(T, 0.06, 0.02, M.dark, fx, fy, 0.01, 0.3, 10));
  }
  g.add(cylZ(T, R + 0.05, 0.06, M.oliveDk, 0, 0, z0 - 0.03, 0.4, 24));          // taban bileziği
  const shell = mk(T, new T.CylinderGeometry(R, R, L, 28, 1, true).rotateX(Math.PI / 2), M.olive, 0, 0, z0 + L / 2, 0.45);
  shell.material = M.olive.clone(); shell.material.side = T.DoubleSide; g.add(shell);
  for (const z of [z0 + 0.05, top - 0.05]) g.add(mk(T, new T.TorusGeometry(R + 0.008, 0.02, 8, 28), M.oliveDk, 0, 0, z, 0.4));
  for (const a of [0, 2.0944, 4.1888]) g.add(box(T, 0.03, 0.03, L * 0.8, M.oliveDk, Math.cos(a) * (R + 0.012), Math.sin(a) * (R + 0.012), z0 + L / 2, 0.42));   // boyuna nervür
  g.add(cylZ(T, R - 0.01, 0.012, M.dark, 0, 0, z0 + 0.006, 0.4, 24));             // tüp dibi
  for (let k = 0; k < 8; k++) g.add(box(T, 0.03, 0.006, 0.05, k % 2 ? M.black : M.yellow, -0.105 + k * 0.03, -R - 0.006, top - 0.1, 0.4));
  // kontrol kutusu + LED + kablo makarası
  g.add(box(T, 0.14, 0.1, 0.18, M.dark, R + 0.09, 0, z0 + 0.12, 0.55));
  const led = mk(T, new T.SphereGeometry(0.018, 8, 6), M.ledG, R + 0.165, 0, z0 + 0.18, 0.6); g.add(led);
  g.add(cylY(T, 0.016, 0.3, M.rubber, R + 0.09, 0, z0 - 0.08, 0.4, 8));
  // kapak: arka kenardan menteşeli disk
  const hinge = new T.Group(); hinge.position.set(0, -R - 0.01, top + 0.02); g.add(hinge);
  const lid = cylZ(T, R + 0.02, 0.03, M.olive, 0, R + 0.01, 0, 0.42, 28); hinge.add(lid);
  lid.add(box(T, R * 1.2, 0.04, 0.015, M.oliveDk, 0, 0, 0.02, 0.42));
  return { group: g, cells: [{ x: 0, y: 0, floorZ: z0 + 0.012, hinge, led, floor: null, ang: 0, target: 0 }], mouthZ: top + 0.03, plate: null, size: [F * 2, F * 2] };
}

// ---------- el fırlatıcısı + pilot ----------
// Pilot +Y'ye bakar (grup Z etrafında nişan azimutuna döner). `aim` pivotu sağ omuzda; tüp pivot çerçevesinde +Y boyunca omzun üstünde, pivot X
// etrafında el kadar kalkar. Nişan birimi (ekran) tüpün solunda, pilotun gözünün ÖNÜNDE; ekran arkaya (göze) bakar.
const SHOULDER_PIVOT = [0.17, 0.02, 1.5];
export const HANDHELD = { pivot: SHOULDER_PIVOT };
export function buildHandheld(T, M = mats(T), dims = CELL) {
  const R = dims.handR ?? 0.27, L = dims.handL ?? 0.78;
  const TX = Math.max(0.08, R * 0.7), TZ = R * 0.55, Y0 = -0.42 * L;   // tüp ekseni (pivot çerçevesi) ve arka uç
  const g = new T.Group(); g.name = 'launcher_handheld';
  const pilot = new T.Group(); pilot.name = 'pilot'; g.add(pilot);
  const body = new T.Group(); pilot.add(body);   // gövde (nişan yükselişinde hafif geriye eğilir)
  // bacaklar + botlar (sol ayak önde, sağ ayak geride: atış duruşu)
  for (const [x, y] of [[-0.12, 0.1], [0.13, -0.14]]) {
    pilot.add(box(T, 0.12, 0.29, 0.1, M.boot, x, y + 0.04, 0.05, 0.5));
    const leg = mk(T, new T.CapsuleGeometry(0.075, 0.68, 4, 10).rotateX(Math.PI / 2), M.camo, x, y * 0.5, 0.5, 0.88); pilot.add(leg);
    pilot.add(box(T, 0.13, 0.09, 0.1, M.camoDk, x, y * 0.5 + 0.06, 0.52, 0.7));   // diz koruyucu
  }
  body.add(box(T, 0.36, 0.22, 0.16, M.camoDk, 0, 0, 0.94, 0.85));                  // kalça
  body.add(box(T, 0.38, 0.06, 0.05, M.dark, 0, 0, 0.98, 0.6));                     // kemer
  body.add(mk(T, new T.CapsuleGeometry(0.16, 0.34, 4, 12).rotateX(Math.PI / 2), M.camo, 0, 0, 1.2, 0.9));   // gövde
  body.add(box(T, 0.4, 0.27, 0.36, M.vest, 0, 0, 1.24, 0.72));                     // yelek
  for (const x of [-0.12, 0, 0.12]) body.add(box(T, 0.1, 0.05, 0.12, M.camoDk, x, 0.16, 1.14, 0.6));   // şarjör cepleri
  body.add(box(T, 0.06, 0.04, 0.09, M.dark, -0.15, 0.15, 1.33, 0.6));              // telsiz
  body.add(box(T, 0.3, 0.12, 0.3, M.camoDk, 0, -0.18, 1.24, 0.6));                 // sırt çantası
  body.add(mk(T, new T.CylinderGeometry(0.05, 0.055, 0.1, 10), M.skin, 0, 0, 1.5, 0.95).rotateX(Math.PI / 2));   // boyun
  body.add(mk(T, new T.SphereGeometry(0.1, 16, 12), M.skin, 0, 0.01, 1.63, 0.97));
  const hel = mk(T, new T.SphereGeometry(0.125, 18, 10, 0, Math.PI * 2, 0, Math.PI * 0.55), M.helmet, 0, -0.005, 1.645, 0.6); hel.rotation.x = Math.PI / 2; body.add(hel);
  body.add(box(T, 0.17, 0.04, 0.05, M.visor, 0.0, 0.1, 1.645, 0.5));              // gözlük
  body.add(box(T, 0.05, 0.05, 0.05, M.dark, 0.0, 0.11, 1.74, 0.5));               // kask montaj yuvası
  // nişan pivotu (sağ omuz) + aparat
  const aim = new T.Group(); aim.name = 'aim'; aim.position.set(...SHOULDER_PIVOT); pilot.add(aim);
  const gun = new T.Group(); aim.add(gun);   // geri tepme ötelemesi
  const tube = mk(T, new T.CylinderGeometry(R, R, L, 8, 1, true), M.olive.clone(), TX, Y0 + L / 2, TZ, 0.45);
  tube.rotation.y = Math.PI / 8; tube.material.side = T.DoubleSide; gun.add(tube);
  for (const y of [Y0 + 0.03, Y0 + L - 0.03]) { const r = mk(T, new T.CylinderGeometry(R + 0.025, R + 0.025, 0.06, 8), M.oliveDk, TX, y, TZ, 0.42); r.rotation.y = Math.PI / 8; gun.add(r); }
  const mz = mk(T, new T.CylinderGeometry(R + 0.04, R + 0.025, 0.05, 8), M.dark, TX, Y0 + L + 0.02, TZ, 0.5); mz.rotation.y = Math.PI / 8; gun.add(mz);   // ağız bileziği
  // kırılabilir ağız kapağı (fırlatmada parçalanır → gizlenir): koyu disk + sarı X kesim çizgisi
  const cover = new T.Group(); cover.position.set(TX, Y0 + L + 0.048, TZ); gun.add(cover);
  const cd = mk(T, new T.CylinderGeometry(R * 0.97, R * 0.97, 0.012, 8), M.oliveDk, 0, 0, 0, 0.42); cd.rotation.y = Math.PI / 8; cover.add(cd);
  for (const a of [Math.PI / 4, -Math.PI / 4]) { const x = box(T, R * 1.7, 0.004, 0.018, M.yellow, 0, 0.008, 0, 0.42); x.rotation.y = a; cover.add(x); }
  for (let k = 0; k < 6; k++) gun.add(box(T, 0.006, 0.05, 0.03, k % 2 ? M.black : M.yellow, TX + R * 0.93 + 0.026, Y0 + L - 0.16 + k * 0.025, TZ, 0.4));
  gun.add(box(T, 0.12, 0.22, 0.06, M.rubber, TX * 0.4, -0.02, TZ - R * 0.9, 0.5));   // omuz yastığı
  // tabanca kabzası + tetik korkuluğu + ön kabza (tüpün altında)
  const gz = TZ - R * 0.93;
  const grip = box(T, 0.045, 0.065, 0.15, M.dark, TX, 0.06, gz - 0.09, 0.5); grip.rotation.x = -0.25; gun.add(grip);
  gun.add(box(T, 0.03, 0.11, 0.012, M.dark, TX, 0.12, gz - 0.03, 0.5));
  gun.add(box(T, 0.008, 0.012, 0.03, M.steel, TX, 0.11, gz - 0.035, 0.4));
  gun.add(box(T, 0.045, 0.05, 0.13, M.dark, TX, Y0 + L * 0.82, gz - 0.07, 0.5));
  // nişan birimi (tüpün sol üstü, gözün önünde) + EKRAN (arkaya, göze bakar; hafif yukarı eğik) + güneşlik, düğmeler, lens
  const unit = new T.Group(); unit.position.set(TX - R - 0.07, 0.36, TZ + R * 0.35); gun.add(unit);
  unit.add(box(T, 0.14, 0.2, 0.11, M.dark, 0, 0.06, 0, 0.62));
  unit.add(box(T, 0.03, 0.12, 0.04, M.dark, 0.075, 0.02, -0.03, 0.55));             // tüpe bağlantı kolu
  unit.add(cylY(T, 0.035, 0.06, M.black, 0, 0.18, 0.01, 0.55, 14));                 // ön lens yuvası
  const lens = mk(T, new T.CircleGeometry(0.028, 16), M.visor, 0, 0.212, 0.01, 0.5); lens.rotation.x = -Math.PI / 2; unit.add(lens);
  const bezel = box(T, 0.17, 0.02, 0.13, M.black, 0, -0.045, 0.012, 0.6); bezel.rotation.x = -0.22; unit.add(bezel);
  const scr = new T.Mesh(new T.PlaneGeometry(0.15, 0.108), new T.MeshBasicMaterial({ color: 0x0a1410, toneMapped: false }));
  scr.position.set(0, -0.0565, 0.012); scr.rotation.x = Math.PI / 2 - 0.22; scr.userData.heat = 0.7; scr.name = 'scope_screen'; unit.add(scr);
  const ovl = new T.Mesh(new T.PlaneGeometry(0.15, 0.108), new T.MeshBasicMaterial({ transparent: true, toneMapped: false, depthWrite: false, opacity: 1 }));
  ovl.position.copy(scr.position); ovl.rotation.copy(scr.rotation); ovl.position.y -= 0.0012; ovl.visible = false; ovl.userData.heat = 0.7; unit.add(ovl);
  const hood = box(T, 0.17, 0.05, 0.018, M.black, 0, -0.075, 0.075, 0.55); hood.rotation.x = -0.22; unit.add(hood);   // güneşlik
  for (const x of [-0.05, 0, 0.05]) unit.add(box(T, 0.022, 0.012, 0.014, M.steel, x, 0.0, 0.062, 0.4));            // düğmeler
  const uled = mk(T, new T.SphereGeometry(0.009, 8, 6), M.ledG, 0.065, 0.0, 0.062, 0.6); unit.add(uled);
  // dron yuvası: tüp arka ucu (kuyruk tabanda, burun +Y = tüp ekseni)
  const attach = new T.Object3D(); attach.position.set(TX, Y0 + 0.04, TZ); gun.add(attach);
  // kollar (nişana göre yeniden kurulur): omuz → el noktası
  const arm = () => { const m = mk(T, new T.CylinderGeometry(0.055, 0.047, 1, 10), M.camo, 0, 0, 0, 0.88); body.add(m); return m; };
  const hand = () => { const m = mk(T, new T.SphereGeometry(0.05, 10, 8), M.glove, 0, 0, 0, 0.8); body.add(m); return m; };
  const joint = () => { const m = mk(T, new T.SphereGeometry(0.055, 10, 8), M.camo, 0, 0, 0, 0.88); body.add(m); return m; };
  const arms = { rU: arm(), rF: arm(), lU: arm(), lF: arm(), rE: joint(), lE: joint(), rH: hand(), lH: hand() };   // üst kol + ön kol + dirsek + el
  return { group: g, pilot, body, aim, gun, attach, screen: scr, overlay: ovl, unit, led: uled, arms, cover, size: [0.8, 0.8],
    mouthLocal: new T.Vector3(TX, Y0 + L, TZ), breechLocal: new T.Vector3(TX, Y0, TZ), rHand: new T.Vector3(TX, 0.06, gz - 0.12), lHand: new T.Vector3(TX, Y0 + L * 0.82, gz - 0.1) };
}

// Kolları omuzdan ele kur: kapsül iki nokta arasına (gövde çerçevesinde)
const _a = { a: null, b: null, d: null, q: null, up: null };
function limb(T, m, a, b) {
  _a.d = _a.d || new T.Vector3(); _a.up = _a.up || new T.Vector3(0, 1, 0);
  _a.d.subVectors(b, a); const L = Math.max(0.05, _a.d.length());
  m.position.copy(a).addScaledVector(_a.d, 0.5);
  m.scale.set(1, L, 1);   // silindir boyu 1 → L
  m.quaternion.setFromUnitVectors(_a.up, _a.d.normalize());
}

// ---------- düzenek ----------
// cfg: { method, loaded, aim_az_deg, aim_el_deg, heading (pist yönü, °), scale, night, dusk, inventory? {total, used, launchers} }
export function createIceptRig(T, cfg) {
  const M = mats(T);
  const method = cfg.method;
  const hand = method === 'handheld';
  const scale = Number(cfg.scale) || 1;
  const dims = cellDims(cfg.fit);   // hücre/tüp ölçüleri dronun gerçek boyutundan
  const root = new T.Group(); root.name = 'icept_rig';
  const inner = new T.Group(); inner.scale.setScalar(scale); root.add(inner);
  const yawRw = -(Number(cfg.heading) || 0) * DEG;
  const S = { phase: 'idle', t: 0, launchAt: -1, recoil: 0, aim: normAim(cfg.aim_az_deg, cfg.aim_el_deg), inv: null, alt: 0, blinkT: 0 };
  let units = [];      // kutu/tüp: [{group, cells, plate, mouthZ}]
  let hh = null;       // el fırlatıcısı
  let active = null;   // {u, c}
  const attach = new T.Object3D();   // aktif hücrenin dron yuvası (hücre tabanı; yerel +Y burun = dünya yukarı)
  attach.rotation.x = Math.PI / 2;
  // ---- kurulum ----
  function buildUnits(n) {
    for (const u of units) { inner.remove(u.group); disposeGroup(u.group); }
    units = [];
    if (hand) return;
    const pos = method === 'tube' ? [{ x: 0, y: 0 }] : bankLayout(method, n, dims);
    for (const p of pos) {
      const u = method === 'tube' ? buildTube(T, M, dims) : buildPod(T, method, M, dims);
      u.group.position.set(p.x, p.y, 0); inner.add(u.group); units.push(u);
    }
  }
  if (hand) {
    hh = buildHandheld(T, M, dims); inner.add(hh.group);
    hh.attach.add(attach); attach.rotation.set(0, 0, 0); attach.position.set(0, 0, 0);
  } else buildUnits(1);
  root.traverse(o => { if (o.isMesh) o.castShadow = true; });
  // ---- envanter / hücre durumları ----
  function setInventory(inv) {
    if (hand) { S.inv = inv; return; }
    const n = method === 'tube' ? 1 : Math.max(1, inv?.launchers || 1);
    if (n !== units.length) buildUnits(n);
    S.inv = { total: inv?.total ?? cellCount(method), used: inv?.used ?? 1, launchers: n };
    const st = cellStates(method, S.inv);
    active = null;
    st.cells.forEach((row, l) => row.forEach((s, c) => {
      const cell = units[l]?.cells[c]; if (!cell) return;
      cell.state = s;
      cell.target = s === 'loaded' ? 0 : HATCH_OPEN;
      if (cell.floor) cell.floor.material = s === 'spent' ? M.soot : M.dark;
      if (s === 'active') active = { u: units[l], c: cell };
    }));
    units.forEach((u, l) => u.plate?.draw(st.cells[l] || []));
    if (!active) { const u = units[0], c = u.cells[0]; active = { u, c }; }
    active.u.group.add(attach);
    attach.position.set(active.c.x, active.c.y, active.c.floorZ);
    attach.rotation.set(Math.PI / 2, 0, 0);
  }
  if (!hand) setInventory(cfg.inventory || { total: cfg.loaded ?? cellCount(method), used: 1, launchers: 1 });
  // hücre kapakları ilk kurulumda doğrudan hedef açıda (animasyonsuz)
  for (const u of units) for (const c of u.cells) { c.ang = c.target; c.hinge.rotation.x = c.ang; }
  // ---- nişan (el fırlatıcısı) ----
  const tA = new T.Vector3(), tB = new T.Vector3();
  function applyAim() {   // nişan: pilot az'a döner, pivot el kadar kalkar; kollar ellere yeniden kurulur
    if (!hh) return;
    hh.pilot.rotation.z = -S.aim.az * DEG;
    hh.aim.rotation.x = S.aim.el * DEG;
    hh.body.rotation.x = -Math.max(0, S.aim.el - 35) * DEG * 0.25;   // dik nişanda gövde hafif geriye
    hh.gun.position.y = -S.recoil * 0.06;
    hh.pilot.updateMatrixWorld(true);
    // el noktaları (silah çerçevesi) → gövde çerçevesi
    const toBody = v => hh.body.worldToLocal(hh.gun.localToWorld(v));
    const rS = tA.set(0.19, 0.02, 1.42), lS = new T.Vector3(-0.19, 0.04, 1.42);
    const rHand = toBody(hh.rHand.clone());
    const lHand = toBody(hh.lHand.clone());
    // iki parçalı kol (basit IK): dirsek omuz–el doğrusunun ortasından aşağı/dışa (kol boyu 0,31 + 0,29 m)
    const elbow = (S0, H, side) => {
      const d = tB.subVectors(H, S0), L = d.length(), a = 0.31, b = 0.29;
      const x = Math.min(L, a + b - 1e-3), t = (a * a - b * b + x * x) / (2 * x), hgt = Math.sqrt(Math.max(0, a * a - t * t));
      const dir = d.clone().normalize(), pole = new T.Vector3(side * 0.5, -0.2, -1).normalize();
      pole.addScaledVector(dir, -pole.dot(dir)).normalize();
      return S0.clone().addScaledVector(dir, t).addScaledVector(pole, hgt);
    };
    const rE = elbow(rS, rHand, 1), lE = elbow(lS, lHand, -1);
    limb(T, hh.arms.rU, rS, rE); limb(T, hh.arms.rF, rE, rHand); limb(T, hh.arms.lU, lS, lE); limb(T, hh.arms.lF, lE, lHand);
    hh.arms.rE.position.copy(rE); hh.arms.lE.position.copy(lE);
    hh.arms.rH.position.copy(rHand); hh.arms.lH.position.copy(lHand);
  }
  const setAim = (az, el) => { S.aim = normAim(az, el); applyAim(); return { ...S.aim }; };
  applyAim();
  // ---- duman / parlama (fırlatma anı) ----
  const fx = new T.Group(); root.add(fx);
  let puffs = [], flash = null;
  const smokeTex = (() => { if (typeof document === 'undefined') return null; const cv = document.createElement('canvas'); cv.width = cv.height = 64; const g = cv.getContext('2d'); const gr = g.createRadialGradient(32, 32, 2, 32, 32, 30); gr.addColorStop(0, 'rgba(255,255,255,0.95)'); gr.addColorStop(0.55, 'rgba(255,255,255,0.45)'); gr.addColorStop(1, 'rgba(255,255,255,0)'); g.fillStyle = gr; g.fillRect(0, 0, 64, 64); return new T.CanvasTexture(cv); })();
  if (smokeTex) {
    for (let k = 0; k < 18; k++) { const s = new T.Sprite(new T.SpriteMaterial({ map: smokeTex, color: 0xb9b6ae, transparent: true, opacity: 0, depthWrite: false })); s.visible = false; fx.add(s); puffs.push({ s, born: -1, v: new T.Vector3(), p: new T.Vector3(), life: 2 }); }
    flash = new T.Sprite(new T.SpriteMaterial({ map: smokeTex, color: 0xffc070, transparent: true, opacity: 0, depthWrite: false, blending: T.AdditiveBlending, toneMapped: false })); flash.visible = false; fx.add(flash);
  }
  const fxTmp = new T.Vector3(), fxDir = new T.Vector3();
  function emit(now) {   // ağızdan yukarı/ileri duman; el fırlatıcısında arka uçtan geri tepme dumanı
    if (!puffs.length) return;
    root.updateMatrixWorld(true);
    const mouth = new T.Vector3(), dir = new T.Vector3(), back = new T.Vector3();
    if (hh) {
      hh.gun.localToWorld(mouth.copy(hh.mouthLocal)); hh.gun.localToWorld(back.copy(hh.breechLocal));
      dir.copy(mouth).sub(back).normalize();
    } else if (active) {
      active.u.group.localToWorld(mouth.set(active.c.x, active.c.y, active.u.mouthZ)); dir.set(0, 0, 1);
    } else return;
    puffs.forEach((p, k) => {
      const rear = hh && k % 2 === 1;   // el: yarısı arka (backblast)
      const src = rear ? back : mouth, d = rear ? fxDir.copy(dir).negate() : dir;
      p.born = now + k * 0.045; p.life = 1.6 + (k % 5) * 0.25;
      p.p.copy(src);
      const sp = (rear ? 7 : 3.2) * scale / 2.5;
      p.v.set(d.x * sp + (Math.random() - 0.5) * 1.6, d.y * sp + (Math.random() - 0.5) * 1.6, d.z * sp + (rear ? 0.4 : 0.3) + Math.random() * 0.6);
    });
    if (flash) { flash.position.copy(mouth); flash.userData.born = now; }
  }
  function updateFx(now) {
    for (const p of puffs) {
      if (p.born < 0) continue;
      const age = now - p.born;
      if (age < 0) { p.s.visible = false; continue; }
      if (age > p.life) { p.s.visible = false; p.born = -1; continue; }
      const u = age / p.life;
      fxTmp.copy(p.p).addScaledVector(p.v, (1 - Math.exp(-age * 2.2)) / 2.2);   // sürtünmeyle yavaşlayan
      fxTmp.z += age * 0.35 * scale / 2.5;   // ılık duman yükselir
      p.s.position.copy(fxTmp);
      p.s.scale.setScalar((0.5 + 2.6 * u) * scale / 2.5 * 1.4);
      p.s.material.opacity = 0.62 * (1 - u) * Math.min(1, age * 8);
      p.s.visible = true;
    }
    if (flash && flash.userData.born != null) {
      const a = now - flash.userData.born;
      if (a >= 0 && a < 0.3) { flash.visible = true; flash.scale.setScalar((0.8 + a * 6) * scale / 2.5 * 1.3); flash.material.opacity = 0.9 * (1 - a / 0.3); }
      else flash.visible = false;
    }
  }
  // ---- yüzey oturması (flightsim_launch.surfaceLock/surfaceFit; 4 temas: ayak izi köşeleri) ----
  const SURF = { tz: 0, tp: 0, tr: 0, z: 0, p: 0, r: 0, set: false };
  let lock = null, anchorSet = false;
  const anchorLast = new T.Vector3();
  const diag = { samples: null, event: null, locks: 0, ignored: 0, holds: 0, fits: 0, fineAll: false };
  const baseYaw = () => (hh ? 0 : yawRw);
  const contacts = () => {
    const [w, d] = (hh ? [0.7, 0.7] : [Math.max(...units.map(u => u.group.position.x + u.size[0] / 2)) * 2, units[0]?.size[1] || 1]);
    return [[-w / 2, -d / 2], [w / 2, -d / 2], [-w / 2, d / 2], [w / 2, d / 2]].map(([x, y]) => [x * scale, y * scale]);
  };
  const applySurf = () => { root.position.z = SURF.z; root.rotation.set(SURF.p, SURF.r, baseYaw(), 'ZXY'); };
  const normSample = v => (v == null ? null : typeof v === 'number' ? (Number.isFinite(v) ? { z: v, fine: true, err: 0, dem: v } : null)
    : { z: Number(v.z), fine: v.fine !== false && Number.isFinite(Number(v.z)), err: Number.isFinite(v.err) ? v.err : 0, dem: Number.isFinite(v.dem) ? v.dem : 0 });
  function fit(surf, offset = 0) {
    if (typeof surf !== 'function') return;
    const yw = baseYaw(), c = Math.cos(yw), s = Math.sin(yw), pts = contacts();
    const samples = pts.map(([x, y]) => normSample(surf(c * x - s * y + root.position.x, s * x + c * y + root.position.y)));
    lock = surfaceLock(lock, samples, offset);
    diag.samples = samples; diag.event = lock.event; diag.fits++; diag.fineAll = samples.every(isFineSample);
    if (lock.event === 'lock' || lock.event === 'relock') diag.locks++;
    if (lock.event === 'hold') diag.holds++;
    diag.ignored += lock.ignored || 0;
    const Lx = Math.abs(pts[1][0] - pts[0][0]) || 1, Ly = Math.abs(pts[2][1] - pts[0][1]) || 1;
    const f = surfaceFit(lock.hs, Lx, Ly, 12);
    SURF.tz = f.z; SURF.tp = f.p; SURF.tr = f.r;
    if (!SURF.set) { SURF.set = true; SURF.z = SURF.tz; SURF.p = SURF.tp; SURF.r = SURF.tr; applySurf(); }
  }
  // Demir: grup merkezi (kutu/tüp sırası merkezi; el: pilotun omuz izdüşümü) SITL evine. Aktif hücre en çok yarım sıra uzakta; released ofset sönümü kapatır.
  function anchor(p, surf, offset = 0) {
    root.position.set(p.x, p.y, 0); root.rotation.set(0, 0, baseYaw(), 'ZXY');
    if (surf) { SURF.set = false; lock = null; fit(surf, offset); } else applySurf();
    anchorLast.set(p.x, p.y, 0); anchorSet = true;
  }
  const needsAnchor = p => !anchorSet || Math.hypot(p.x - anchorLast.x, p.y - anchorLast.y) > 2.0;
  const resurface = (surf, offset = 0) => { if (anchorSet) fit(surf, offset); };
  applySurf();
  // ---- aşamalar ----
  function setPhase(p) {
    if (p === S.phase) return;
    const now = performance.now() / 1000;
    if (p === 'idle' || p == null) { S.phase = 'idle'; S.t = 0; S.alt = 0; return; }
    if (p === 'armed') { S.phase = 'armed'; return; }
    if (p === 'launch') { S.phase = 'launch'; S.t = 0; S.launchAt = now; emit(now); S.recoil = 1; return; }
    if (p === 'released' || p === 'free') {
      if (S.phase !== 'released' && S.phase !== 'free') { if (S.phase !== 'launch') { emit(now); S.recoil = 1; } S.phase = 'released'; S.t = 0; }
    }
  }
  const tmpQ = new T.Quaternion(), tmpV = new T.Vector3(), noseV = new T.Vector3();
  // dron pozu düzenekteyken: yuvadan burun ekseni boyunca `ground` (kuyruk → orijin) + `launch` aşamasında SITL tırmanışı kadar çıkış
  function carryPose(pos, q, ground = 0) {
    root.updateMatrixWorld(true);
    attach.getWorldPosition(pos); attach.getWorldQuaternion(q);
    noseV.set(0, 1, 0).applyQuaternion(q);
    pos.addScaledVector(noseV, ground + (S.phase === 'launch' ? Math.min(S.alt, 1.5 * scale) : 0));
    return pos;
  }
  function update(dt, ctx) {
    const now = performance.now() / 1000;
    S.alt = Math.max(0, Number(ctx?.alt) || 0);
    if (SURF.set) { const a = Math.min(1, dt / 0.25); SURF.z += (SURF.tz - SURF.z) * a; SURF.p += (SURF.tp - SURF.p) * a; SURF.r += (SURF.tr - SURF.r) * a; applySurf(); }
    S.t += dt; S.blinkT += dt;
    if (S.phase === 'released' && S.t > 0.6) S.phase = 'free';
    // kapaklar (aktif hücre açık; dolu kapalı; ateşlenen/boş açık) — 0,6 sn
    for (const u of units) for (const c of u.cells) {
      if (Math.abs(c.ang - c.target) > 1e-3) { c.ang += Math.sign(c.target - c.ang) * Math.min(Math.abs(c.target - c.ang), dt * HATCH_OPEN / 0.6); c.hinge.rotation.x = c.ang; }
      const blink = (S.blinkT % 0.8) < 0.4;
      const away = c.state === 'active' && (S.phase === 'released' || S.phase === 'free');   // ateşlendi: hücre boşaldı (sıfırlanınca yeniden sıradaki)
      c.led.material = c.state === 'loaded' ? M.ledG : away ? M.ledR : c.state === 'active' ? ((S.phase === 'armed' || S.phase === 'launch') && !blink ? M.ledOff : M.ledA) : (c.state === 'spent' || c.state === 'empty') ? M.ledR : M.ledG;
      if (c.floor && c.state === 'active') c.floor.material = away ? M.soot : M.dark;
    }
    if (hh) {
      hh.cover.visible = S.phase === 'idle' || S.phase === 'armed';   // ağız kapağı fırlatmada parçalanır
      hh.led.material = S.phase === 'armed' && (S.blinkT % 0.6) < 0.3 ? M.ledA : S.phase === 'idle' ? M.ledG : M.ledA;
      if (S.recoil > 0) { S.recoil = Math.max(0, S.recoil - dt * 3); applyAim(); }
    }
    updateFx(now);
  }
  // nişangâh kamerası: nişan birimi lensinin dünya konumu (+ nişan) — el fırlatıcısı; diğerleri null
  // ekranın dünya merkezi + normali (göze bakan yüz) — görsel betik / teşhis
  function screenPose() {
    if (!hh) return null;
    root.updateMatrixWorld(true);
    const c = hh.screen.getWorldPosition(new T.Vector3()), n = new T.Vector3(0, 0, 1).applyQuaternion(hh.screen.getWorldQuaternion(new T.Quaternion()));
    return { x: c.x, y: c.y, z: c.z, nx: n.x, ny: n.y, nz: n.z };
  }
  function scopePose(out) {
    if (!hh) return null;
    root.updateMatrixWorld(true);
    hh.unit.localToWorld(out.set(0, 0.24, 0.01));
    return { pos: out, az: S.aim.az, el: S.aim.el };
  }
  function disposeGroup(o) { o.traverse(x => { x.geometry?.dispose?.(); }); o.removeFromParent(); }
  return {
    group: root, method, attach, setPhase, update, anchor, needsAnchor, resurface, carryPose, setInventory, setAim, scopePose, screenPose,
    iceptRig: true, hasScope: !!hh, screen: hh ? hh.screen : null, screenOverlay: hh ? hh.overlay : null,
    attachWorld: (pos, q) => { root.updateMatrixWorld(true); attach.getWorldPosition(pos); if (q) attach.getWorldQuaternion(q); return pos; },
    planeQuat: out => { root.updateMatrixWorld(true); return attach.getWorldQuaternion(out || new T.Quaternion()); },
    get aim() { return { ...S.aim }; },
    get inventory() { return S.inv ? { ...S.inv, ...(() => { const st = cellStates(method, S.inv); return { loaded: st.loaded, spent: st.spent, empty: st.empty, active: st.active }; })() } : null; },
    get cells() { return units.map(u => u.cells.map(c => ({ state: c.state || 'loaded', open: c.target > 0, ang: +c.ang.toFixed(2) }))); },
    get surface() { return { z: SURF.z, pitch_deg: SURF.p / DEG, roll_deg: SURF.r / DEG }; },
    get diag() { return { h: SURF.z, target: SURF.tz, pitch: SURF.p / DEG, roll: SURF.r / DEG, fine: diag.fineAll, locked: !!lock?.locked, event: diag.event, locks: diag.locks, ignored: diag.ignored, holds: diag.holds, fits: diag.fits, phase: S.phase, x: root.position.x, y: root.position.y }; },
    // sihirbaz önizlemesi / görsel betik: düzeneğe bakış yarıçapı ve yüksekliği (dünya m)
    get focus() { const w = hh ? 1.3 : Math.max(...units.map(u => Math.abs(u.group.position.x) + u.size[0] / 2)) * 2, d = hh ? 1.3 : (units[0]?.size[1] || 1); return { r: Math.max(w, d, 1.2) * scale * (hh ? 2.4 : 1.7), h: (hh ? 1.6 : dims.base + dims.depth) * scale, look: (hh ? 1.25 : (dims.base + dims.depth) * 0.6) * scale, x: root.position.x, y: root.position.y, z: root.position.z }; },
    get anchored() { return S.phase === 'idle' || S.phase === 'armed'; },
    get tracking() { return false; },
    get phase() { return S.phase; },
    get carrying() { return S.phase === 'idle' || S.phase === 'armed' || S.phase === 'launch'; },
    get blend() { return S.phase === 'released' ? Math.min(1, S.t / 0.6) : S.phase === 'free' ? 1 : 0; },
    get puffs() { return puffs.filter(p => p.s.visible).length; },
    sidePoint: (dx, dy, dz) => tmpV.set(dx * scale, dy * scale, dz * scale).applyQuaternion(tmpQ.setFromEuler(new T.Euler(0, 0, hh ? -S.aim.az * DEG : root.rotation.z))),
    dispose() { root.traverse(o => { o.geometry?.dispose?.(); const ms = Array.isArray(o.material) ? o.material : (o.material ? [o.material] : []); ms.forEach(m => { if (m.map && m.map !== smokeTex && !m.map.isRenderTargetTexture) m.map.dispose?.(); m.dispose?.(); }); }); smokeTex?.dispose?.(); root.removeFromParent(); },
  };
}
