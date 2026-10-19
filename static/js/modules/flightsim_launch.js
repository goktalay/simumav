// Uçuş Simülatörü — sabit kanat kalkış yöntemi geometrileri ve animasyonu (docs/ucus-simulatoru.md §13). flightsim3d.js içinden kullanılır.
// • addLandingGear(T, built, bb): modele burun + 2 ana tekerlek (çatallı); modelde "gear/wheel/teker" düğümü varsa eklenmez. Tekerlekler yer hızıyla döner.
// • createLaunchRig(T, cfg): rampa ('ramp') ya da pickup ('vehicle') düzeneği. Yerel çerçeve: +Y fırlatma/pist yönü, +X sağ, +Z yukarı; grup
//   runway_heading ile döndürülür ve dron modeli gibi `scale` (MODEL_SCALE) ile büyütülür. `attach` düğümü uçağın oturduğu nokta (kızak / kasa kızağı).
//   Aşamalar (setPhase): idle → launch (rampa: kızak 6 m'yi 0,5 sn'de ivmelenir; araç: SITL uçağını taşır) → released (uçak SITL konumuna yumuşak
//   geçiş; rampa kızağı geri döner, araç frenler) → free. update(dt, ctx) her karede: ctx = { planeLocal:{x,y} (SITL uçağının rig yerel konumu, m), speed }.
//   Düzenek pist başında sabittir (anchor bir kez; needsAnchor > 2 m sıçramada yeniden); uçak released'a dek kızağa kilitlidir (SITL konumu yok sayılır).
// • Kayıttan oynatma (§8): sunucu `launch` olayı yaymaz; aşamalar log karelerinden türetilir (`replayLaunchTimeline` → `replayLaunchPhaseAt`),
//   oynatıcı zamanına göre (atlama/baştan ile yeniden hesaplanır).
const DEG = Math.PI / 180;
export const LAUNCH_METHODS = [
  ['wheels', 'Tekerlekli kalkış', 'Burun ve ana iniş takımı eklenir; uçak pist boyunca hızlanır, döndürme hızında havalanır (ArduPlane TAKEOFF).'],
  ['ramp', 'Fırlatma rampası', 'Pnömatik 2 eksenli rampa (azimut tablası + eğim silindiri); kızak uçağı 6 m rayda 0,5 sn\'de fırlatır. SITL: plane-catapult, servo 7 tetiği.'],
  ['vehicle', 'Araç üstü kalkış', 'Uçak pickup kasasındaki kızağa oturur; araç pist boyunca hızlanır, seçilen hıza ulaşınca uçağı bırakır.'],
];
export const LAUNCH_DEFAULTS = { method: 'wheels', angle_deg: 15, release_kmh: 70 };
export const RAMP_RAIL = 6.0, RAMP_TIME = 0.5;   // ray boyu (m) ve kızak süresi (sn) → çıkış hızı 2L/t = 24 m/s
export const rampExitSpeed = () => 2 * RAMP_RAIL / RAMP_TIME;   // m/s (bilgi amaçlı; açıdan bağımsız)
export const launchLabel = (l, tr = s => s) => {
  const m = l?.method || 'wheels';
  return m === 'ramp' ? `${tr('Rampa')} ${Math.round(l.angle_deg ?? 15)}°` : m === 'vehicle' ? `${tr('Araç')} ${Math.round(l.release_kmh ?? 70)} km/h` : tr('Tekerlekli');
};
export const launchHud = l => (l?.method === 'ramp' ? `LAUNCH RAMP ${Math.round(l.angle_deg ?? 15)}° · ${Math.round(rampExitSpeed() * 3.6)} km/h`
  : l?.method === 'vehicle' ? `LAUNCH VEH · ${Math.round(l.release_kmh ?? 70)} km/h` : 'LAUNCH RWY');

const GEAR_RE = /gear|wheel|teker|landing/i;

// ---------- iniş takımı (tekerlekli kalkış) ----------
// built: { grp } gövde çerçevesinde (burun +Y, metre). bb: Box3 (gerçek boyut). Dönüş: { wheels, radius } ya da null (modelde iniş takımı var).
export function addLandingGear(T, built, bb) {
  let has = false;
  built.grp.traverse(o => { if (GEAR_RE.test(o.name || '')) has = true; });
  if (has) return null;
  const span = Math.max(0.5, bb.max.x - bb.min.x), len = Math.max(0.5, bb.max.y - bb.min.y);
  const r = Math.min(0.25, Math.max(0.06, span * 0.045)), leg = r * 1.9;
  const tyre = new T.MeshStandardMaterial({ color: 0x15181c, roughness: 0.9 }), hub = new T.MeshStandardMaterial({ color: 0xb8bec6, roughness: 0.4, metalness: 0.6 }),
    strut = new T.MeshStandardMaterial({ color: 0x5b6470, roughness: 0.5, metalness: 0.5 });
  const g = new T.Group(); g.name = 'landing_gear';
  const wheels = [];
  const zBody = bb.min.z + Math.min(0.08, (bb.max.z - bb.min.z) * 0.2);   // gövde altına yakın bağlantı
  const zAxle = bb.min.z - leg;
  const mk = (geo, mat, x, y, z) => { const m = new T.Mesh(geo, mat); m.position.set(x, y, z); m.castShadow = true; g.add(m); return m; };
  const wheelAt = (x, y, fork) => {
    const h = zBody - zAxle;
    mk(new T.CylinderGeometry(r * 0.12, r * 0.14, h, 8).rotateX(Math.PI / 2), strut, x + (fork ? r * 0.35 : 0), y, zAxle + h / 2);
    if (fork) mk(new T.CylinderGeometry(r * 0.12, r * 0.14, h * 0.6, 8).rotateX(Math.PI / 2), strut, x - r * 0.35, y, zAxle + h * 0.3);
    const w = mk(new T.CylinderGeometry(r, r, r * 0.5, 16).rotateZ(Math.PI / 2), tyre, x, y, zAxle);
    const hb = new T.Mesh(new T.CylinderGeometry(r * 0.55, r * 0.55, r * 0.54, 12).rotateZ(Math.PI / 2), hub); w.add(hb);
    wheels.push(w);
  };
  wheelAt(0, bb.min.y + len * 0.78, true);                                  // burun tekerleği (çatallı)
  for (const s of [-1, 1]) wheelAt(s * Math.max(r * 2.2, span * 0.12), bb.min.y + len * 0.38, false);   // ana tekerlekler
  built.grp.add(g);
  return { wheels, radius: r };
}

// ---------- ortak malzemeler ----------
const mats = T => ({
  steel: new T.MeshStandardMaterial({ color: 0x8e979f, roughness: 0.45, metalness: 0.7 }),
  frame: new T.MeshStandardMaterial({ color: 0x2e3a48, roughness: 0.6, metalness: 0.4 }),
  yellow: new T.MeshStandardMaterial({ color: 0xf2b21a, roughness: 0.55, metalness: 0.2 }),
  red: new T.MeshStandardMaterial({ color: 0xc8322b, roughness: 0.55 }),
  tyre: new T.MeshStandardMaterial({ color: 0x15181c, roughness: 0.9 }),
  hub: new T.MeshStandardMaterial({ color: 0xc9ced4, roughness: 0.4, metalness: 0.6 }),
  chrome: new T.MeshStandardMaterial({ color: 0xdfe4ea, roughness: 0.2, metalness: 0.9 }),
  paint: new T.MeshStandardMaterial({ color: 0x1f4e8c, roughness: 0.35, metalness: 0.3 }),
  glass: new T.MeshStandardMaterial({ color: 0x0e1a26, roughness: 0.1, metalness: 0.7 }),
  rubber: new T.MeshStandardMaterial({ color: 0x23272b, roughness: 0.95 }),
  lampOn: new T.MeshBasicMaterial({ color: 0xfff4c8, toneMapped: false }),
  lampOff: new T.MeshStandardMaterial({ color: 0xd9d2b8, roughness: 0.3 }),
  stopOn: new T.MeshBasicMaterial({ color: 0xff2a1a, toneMapped: false }),
  stopOff: new T.MeshStandardMaterial({ color: 0x7a1a14, roughness: 0.4 }),
  beacon: new T.MeshBasicMaterial({ color: 0xffa020, toneMapped: false }),
});

const cylBetween = (T, a, b, r, mat) => {   // iki nokta arasına silindir (pnömatik silindir / piston)
  const d = new T.Vector3().subVectors(b, a), L = d.length();
  const m = new T.Mesh(new T.CylinderGeometry(r, r, L, 12), mat);
  m.position.copy(a).addScaledVector(d, 0.5);
  m.quaternion.setFromUnitVectors(new T.Vector3(0, 1, 0), d.clone().normalize());
  m.castShadow = true;
  return m;
};
const box = (T, w, d, h, mat, x, y, z) => { const m = new T.Mesh(new T.BoxGeometry(w, d, h), mat); m.position.set(x, y, z); m.castShadow = true; return m; };
const wheel = (T, M, r, w, x, y, z) => {
  const m = new T.Mesh(new T.CylinderGeometry(r, r, w, 20).rotateZ(Math.PI / 2), M.tyre); m.position.set(x, y, z); m.castShadow = true;
  m.add(new T.Mesh(new T.CylinderGeometry(r * 0.58, r * 0.58, w * 1.04, 12).rotateZ(Math.PI / 2), M.hub));
  for (let k = 0; k < 5; k++) { const bolt = new T.Mesh(new T.CylinderGeometry(r * 0.06, r * 0.06, w * 1.1, 6).rotateZ(Math.PI / 2), M.frame); bolt.position.set(0, Math.cos(k * 1.2566) * r * 0.3, Math.sin(k * 1.2566) * r * 0.3); m.add(bolt); }
  return m;
};

// ---------- pnömatik 2 eksenli fırlatma rampası ----------
// Römork şasisi (4 tekerlek, 4 ayak) → azimut tablası (Z ekseni) → eğim pivotu (X ekseni; açı = angle) → 6 m ray, kızak, pnömatik tüp/piston, basınç tüpü.
function buildRamp(T, M, angleDeg, night) {
  const g = new T.Group();
  const ang = angleDeg * DEG;
  // şasi
  g.add(box(T, 1.7, 4.2, 0.22, M.frame, 0, 0, 0.62));
  g.add(box(T, 0.16, 4.2, 0.3, M.frame, -0.7, 0, 0.62)); g.add(box(T, 0.16, 4.2, 0.3, M.frame, 0.7, 0, 0.62));
  g.add(box(T, 0.12, 1.6, 0.12, M.frame, 0, -2.9, 0.62)); g.add(box(T, 0.3, 0.3, 0.3, M.steel, 0, -3.7, 0.55));   // çeki demiri + kaplin
  const wheels = [];
  for (const x of [-0.95, 0.95]) for (const y of [-1.3, 1.3]) { const w = wheel(T, M, 0.36, 0.26, x, y, 0.36); g.add(w); wheels.push(w); }
  for (const x of [-0.9, 0.9]) for (const y of [-2.0, 2.0]) { g.add(box(T, 0.1, 0.1, 0.6, M.yellow, x, y, 0.3)); g.add(box(T, 0.3, 0.3, 0.04, M.steel, x, y, 0.02)); }   // ayaklar
  // azimut tablası
  const az = new T.Group(); az.position.set(0, -0.6, 0.73); g.add(az);
  const table = new T.Mesh(new T.CylinderGeometry(0.75, 0.8, 0.14, 28).rotateX(Math.PI / 2), M.steel); table.position.z = 0.07; table.castShadow = true; az.add(table);
  const ring = new T.Mesh(new T.TorusGeometry(0.78, 0.03, 8, 40), M.yellow); ring.position.z = 0.14; az.add(ring);
  az.add(box(T, 0.5, 0.5, 0.3, M.frame, 0, 0, 0.3));
  for (const x of [-0.32, 0.32]) az.add(box(T, 0.08, 0.5, 0.5, M.frame, x, 0, 0.55));   // pivot kulakları
  // eğim grubu (pivot)
  const tilt = new T.Group(); tilt.position.set(0, 0, 0.72); tilt.rotation.x = ang; az.add(tilt);
  const pin = new T.Mesh(new T.CylinderGeometry(0.07, 0.07, 0.9, 12).rotateZ(Math.PI / 2), M.chrome); tilt.add(pin);
  const railL = RAMP_RAIL, y0 = -0.4;   // ray pivotun 0,4 m gerisinden başlar
  for (const x of [-0.26, 0.26]) tilt.add(box(T, 0.07, railL, 0.14, M.steel, x, y0 + railL / 2, 0.05));
  for (let y = y0 + 0.3; y < y0 + railL; y += 0.75) tilt.add(box(T, 0.6, 0.06, 0.06, M.frame, 0, y, -0.02));   // travers
  tilt.add(box(T, 0.62, 0.12, 0.22, M.red, 0, y0 + railL - 0.06, 0.08));   // ray sonu tamponu
  // pnömatik fırlatma tüpü (rayın altında, kızağı iten piston)
  const tube = new T.Mesh(new T.CylinderGeometry(0.11, 0.11, railL * 0.55, 16), M.yellow); tube.position.set(0, y0 + railL * 0.3, -0.16); tube.castShadow = true; tilt.add(tube);
  const piston = new T.Mesh(new T.CylinderGeometry(0.05, 0.05, 0.6, 10), M.chrome); piston.position.set(0, y0 + railL * 0.575 + 0.3, -0.16); tilt.add(piston);
  // kızak (carriage)
  const car = new T.Group(); car.position.set(0, y0 + 0.5, 0.12); tilt.add(car);
  car.add(box(T, 0.66, 0.7, 0.1, M.frame, 0, 0, 0));
  for (const x of [-0.3, 0.3]) for (const y of [-0.25, 0.25]) car.add(box(T, 0.06, 0.12, 0.16, M.steel, x, y, -0.1));   // ray pabuçları
  for (const y of [-0.22, 0.22]) { car.add(box(T, 0.5, 0.06, 0.26, M.yellow, 0, y, 0.18)); car.add(box(T, 0.56, 0.08, 0.04, M.rubber, 0, y, 0.33)); }   // yastıklı destekler
  const attach = new T.Object3D(); attach.position.set(0, 0, 0.36); car.add(attach);
  // eğim silindiri: şasi ön ↔ ray alt noktası (dünya koordinatları yerel gruba çevrilir)
  g.updateMatrixWorld(true);
  const pA = new T.Vector3(0, 1.1, 0.75), pB = new T.Vector3(0, y0 + railL * 0.45, -0.25).applyMatrix4(tilt.matrixWorld).sub(g.getWorldPosition(new T.Vector3()));
  g.add(cylBetween(T, pA, pB.clone().lerp(pA, 0.45), 0.09, M.yellow));
  g.add(cylBetween(T, pB.clone().lerp(pA, 0.5), pB, 0.045, M.chrome));
  g.add(box(T, 0.3, 0.3, 0.2, M.frame, 0, 1.1, 0.75));
  // basınç tüpü + kompresör + hortum
  const tank = new T.Mesh(new T.CylinderGeometry(0.21, 0.21, 1.3, 16), M.yellow); tank.position.set(0.6, 1.1, 0.98); tank.castShadow = true; g.add(tank);
  for (const y of [0.45, 1.75]) { const cap = new T.Mesh(new T.SphereGeometry(0.21, 14, 10), M.yellow); cap.position.set(0.6, y, 0.98); g.add(cap); }
  g.add(box(T, 0.42, 0.5, 0.4, M.frame, -0.55, 1.4, 0.93));   // kompresör/valf kutusu
  g.add(box(T, 0.08, 0.08, 0.3, M.steel, -0.55, 1.4, 1.25));
  const beacon = new T.Mesh(new T.SphereGeometry(0.07, 10, 8), night ? M.beacon : M.red); beacon.position.set(-0.55, 1.4, 1.45); g.add(beacon);
  return { group: g, attach, car, carY0: y0 + 0.5, carY1: y0 + railL - 0.45, tilt, ang, lamps: [beacon], wheels, wheelR: 0.36 };
}

// ---------- pickup ----------
function buildPickup(T, M, night) {
  const g = new T.Group();
  const body = new T.Group(); g.add(body);
  // şasi + tekerlekler
  body.add(box(T, 1.6, 5.2, 0.2, M.frame, 0, 0.1, 0.5));
  const wheels = [];
  for (const x of [-0.92, 0.92]) for (const y of [-1.6, 1.85]) { const w = wheel(T, M, 0.42, 0.32, x, y, 0.42); body.add(w); wheels.push(w); }
  for (const y of [-1.6, 1.85]) body.add(box(T, 1.9, 0.12, 0.12, M.frame, 0, y, 0.42));   // akslar
  // gövde: kaput, kabin, kasa
  body.add(box(T, 1.9, 5.3, 0.55, M.paint, 0, 0.1, 0.85));             // alt gövde
  body.add(box(T, 1.84, 1.6, 0.5, M.paint, 0, 2.0, 1.35));              // kaput
  const grille = box(T, 1.5, 0.08, 0.45, M.frame, 0, 2.8, 0.95); body.add(grille);
  body.add(box(T, 1.96, 0.3, 0.25, M.chrome, 0, 2.85, 0.62));           // ön tampon
  body.add(box(T, 1.96, 0.25, 0.25, M.chrome, 0, -2.6, 0.62));          // arka tampon
  const cab = new T.Group(); cab.position.set(0, 0.55, 1.1); body.add(cab);
  cab.add(box(T, 1.8, 1.7, 0.95, M.paint, 0, 0, 0.5));                 // kabin
  const roof = box(T, 1.76, 1.5, 0.08, M.paint, 0, -0.05, 1.0); cab.add(roof);
  const ws = box(T, 1.7, 0.06, 0.78, M.glass, 0, 0.95, 0.62); ws.rotation.x = -0.5; cab.add(ws);   // ön cam (eğik)
  cab.add(box(T, 1.7, 0.06, 0.6, M.glass, 0, -0.84, 0.66));            // arka cam
  for (const x of [-0.9, 0.9]) cab.add(box(T, 0.04, 1.3, 0.55, M.glass, x, 0.0, 0.68));   // yan camlar
  for (const x of [-0.98, 0.98]) { const mir = box(T, 0.1, 0.18, 0.12, M.frame, x, 0.75, 0.6); cab.add(mir); }
  // kasa: taban + yanlar + arka kapak
  body.add(box(T, 1.84, 2.3, 0.06, M.frame, 0, -1.45, 1.13));
  for (const x of [-0.9, 0.9]) body.add(box(T, 0.06, 2.3, 0.55, M.paint, x, -1.45, 1.4));
  body.add(box(T, 1.84, 0.06, 0.55, M.paint, 0, -2.58, 1.4));
  body.add(box(T, 1.84, 0.06, 0.55, M.paint, 0, -0.32, 1.4));
  // kasa kızağı (uçak beşiği): iki A-destek + yastıklar
  for (const y of [-0.85, -2.05]) {
    for (const x of [-0.45, 0.45]) { const leg = box(T, 0.06, 0.06, 0.62, M.steel, x * 0.9, y, 1.47); leg.rotation.y = x > 0 ? -0.25 : 0.25; body.add(leg); }
    body.add(box(T, 0.56, 0.08, 0.06, M.yellow, 0, y, 1.78)); body.add(box(T, 0.6, 0.1, 0.05, M.rubber, 0, y, 1.83));
  }
  body.add(box(T, 0.05, 1.2, 0.05, M.steel, 0, -1.45, 1.6));   // orta bağ
  const attach = new T.Object3D(); attach.position.set(0, -1.45, 1.86); body.add(attach);
  // farlar / stoplar
  const lamps = [];
  for (const x of [-0.68, 0.68]) {
    const hl = new T.Mesh(new T.BoxGeometry(0.34, 0.06, 0.18), night ? M.lampOn : M.lampOff); hl.position.set(x, 2.78, 1.05); hl.userData.kind = 'head'; body.add(hl); lamps.push(hl);
    const tl = new T.Mesh(new T.BoxGeometry(0.22, 0.05, 0.3), night ? M.stopOn : M.stopOff); tl.position.set(x * 1.2, -2.66, 1.0); tl.userData.kind = 'stop'; body.add(tl); lamps.push(tl);
  }
  const beacon = new T.Mesh(new T.SphereGeometry(0.08, 10, 8), night ? M.beacon : M.yellow); beacon.position.set(0, 0.5, 2.18); body.add(beacon); lamps.push(beacon);
  // başlangıç: uçak (kızak) pist merkezinde (0,0) → araç kızak ofseti kadar geri
  body.position.y = 1.45;
  return { group: g, body, attach, wheels, lamps, wheelR: 0.42, attachY: -1.45 };
}

// ---------- düzenek (rampa / araç) + aşama makinesi ----------
// cfg: { method, angle_deg, release_kmh, heading (derece), scale, night, dusk }
export function createLaunchRig(T, cfg) {
  const M = mats(T);
  const method = cfg.method === 'ramp' ? 'ramp' : 'vehicle';
  const night = !!cfg.night || !!cfg.dusk;
  const built = method === 'ramp' ? buildRamp(T, M, Math.min(30, Math.max(10, Number(cfg.angle_deg) || 15)), night) : buildPickup(T, M, night);
  const root = new T.Group();
  root.rotation.z = -(Number(cfg.heading) || 0) * DEG;
  const scale = Number(cfg.scale) || 1;
  built.group.scale.setScalar(scale);
  root.add(built.group);
  root.traverse(o => { if (o.isMesh) o.castShadow = true; });
  const S = { phase: 'idle', t: 0, carried: true, vehSpeed: 0, vehY: built.body ? built.body.position.y : 0, spin: 0 };
  const tmp = new T.Vector3(), tmpQ = new T.Quaternion();
  const attachWorld = (pos, q) => { root.updateMatrixWorld(true); built.attach.getWorldPosition(pos); if (q) built.attach.getWorldQuaternion(q); return pos; };
  // Uçak kızağa oturduğunda yönelim: rampa → pist yönü + eğim; araç → pist yönü düz
  const planeQuat = out => {   // kızaktaki uçak: düzeneğin (yüzeye oturmuş) dünya yönelimi × rampa eğimi
    const e = new T.Euler(method === 'ramp' ? built.ang : 0, 0, 0, 'ZXY');
    root.updateMatrixWorld(true);
    return root.getWorldQuaternion(out || new T.Quaternion()).multiply(tmpQ.setFromEuler(e));
  };
  function setPhase(p) {
    if (p === S.phase) return;
    if (p === 'idle' || p == null) { S.phase = 'idle'; S.t = 0; S.carried = true; S.vehSpeed = 0; if (built.car) built.car.position.y = built.carY0; if (built.body) { built.body.position.y = -built.attachY; S.vehY = built.body.position.y; } return; }
    if (p === 'armed') { S.phase = 'armed'; return; }
    if (p === 'launch') { S.phase = 'launch'; S.t = 0; return; }
    if (p === 'released' || p === 'free') { if (S.phase !== 'released' && S.phase !== 'free') { S.phase = 'released'; S.t = 0; } return; }
  }
  // Demirleme: düzenek, kızak noktası (attach) SITL uçağının yer konumuna gelecek biçimde taşınır. Sunucu SERVO3_MIN/TRIM 1000 yazdığından SITL
  // uçağı yerde artık kaymaz (docs §13) → düzenek pist başında SABİT durur: demir bir kez atılır (needsAnchor), yalnız SITL konumu > 2 m sıçrarsa
  // (reset / set_home / eski parametreyle kalan artık) yeniden oturtulur. Araç `launch` aşamasında SITL yer koşusunu taşıdığı için her kare izler.
  // Yüzeye oturma: `surf(x, y)` (sahne terrainHeight) ile 4 temas noktası (tekerlekler) örneklenir → düzenek yüksekliği (ortalama) + eğim
  // (ön/arka → pitch, sağ/sol → roll; Euler 'ZXY': yerel roll, yerel pitch, sonra pist yönü). Hedef değerlere 0,25 sn'de yumuşak yaklaşır
  // (Google 3B'de karolar yüklendikçe `resurface` yeniden örnekler, düzenek zıplamaz). Eğim sonrası attach XY kayması ikinci geçişte düzeltilir.
  const anchorTmp = new T.Vector3(), anchorLast = new T.Vector3(); let anchorSet = false;
  const ANCHOR_RESEAT = 2.0;   // m
  const yaw = -(Number(cfg.heading) || 0) * DEG;
  const SURF = { tz: 0, tp: 0, tr: 0, z: 0, p: 0, r: 0, set: false };   // hedef (t*) ve gösterilen yüzey oturması
  const contacts = () => {   // temas noktaları, root yerel (ölçekli, yaw'sız): [x, y]
    const s = scale, by = built.body ? built.body.position.y : 0;
    return method === 'ramp' ? [[-0.95, -1.3], [0.95, -1.3], [-0.95, 1.3], [0.95, 1.3]].map(([x, y]) => [x * s, y * s])
      : [[-0.92, -1.6], [0.92, -1.6], [-0.92, 1.85], [0.92, 1.85]].map(([x, y]) => [x * s, (y + by) * s]);
  };
  const applySurf = () => { root.position.z = SURF.z; root.rotation.set(SURF.p, SURF.r, yaw, 'ZXY'); };
  function fit(surf) {
    if (typeof surf !== 'function') return;
    const c = Math.cos(yaw), s = Math.sin(yaw), pts = contacts();
    const hs = pts.map(([x, y]) => { const wx = c * x - s * y + root.position.x, wy = s * x + c * y + root.position.y; const h = surf(wx, wy); return Number.isFinite(h) ? h : 0; });
    const Lx = Math.abs(pts[1][0] - pts[0][0]) || 1, Ly = Math.abs(pts[2][1] - pts[0][1]) || 1;
    const tz = (hs[0] + hs[1] + hs[2] + hs[3]) / 4;
    const tp = Math.atan2((hs[2] + hs[3] - hs[0] - hs[1]) / 2, Ly);     // ileri yükseliyorsa burun yukarı (+X dönüşü)
    const tr = -Math.atan2((hs[1] + hs[3] - hs[0] - hs[2]) / 2, Lx);    // sağ yükseliyorsa sağ yukarı (−Y dönüşü)
    const lim = 20 * DEG;
    SURF.tz = tz; SURF.tp = Math.max(-lim, Math.min(lim, tp)); SURF.tr = Math.max(-lim, Math.min(lim, tr));
    if (!SURF.set) { SURF.set = true; SURF.z = SURF.tz; SURF.p = SURF.tp; SURF.r = SURF.tr; applySurf(); }
  }
  function anchor(p, surf) {
    root.position.set(0, 0, 0); root.rotation.set(0, 0, yaw, 'ZXY');
    root.updateMatrixWorld(true);
    built.attach.getWorldPosition(anchorTmp);
    root.position.set(p.x - anchorTmp.x, p.y - anchorTmp.y, 0);
    if (surf) {
      SURF.set = false; fit(surf);   // yeni demirde yüzeye hemen otur
      root.updateMatrixWorld(true); built.attach.getWorldPosition(anchorTmp);   // eğimden doğan attach XY kaymasını düzelt (SITL uçağı kızakta kalsın)
      root.position.x += p.x - anchorTmp.x; root.position.y += p.y - anchorTmp.y;
    } else applySurf();
    anchorLast.set(p.x, p.y, 0); anchorSet = true;
  }
  const needsAnchor = p => !anchorSet || Math.hypot(p.x - anchorLast.x, p.y - anchorLast.y) > ANCHOR_RESEAT;
  const resurface = surf => { if (anchorSet) fit(surf); };
  // Her kare. ctx: { speed (m/s) uçağın yer hızı (kızaktayken düzeneğin hızı) }
  function update(dt, ctx) {
    const sp = ctx?.speed || 0;
    if (SURF.set) {   // yüzey oturmasına yumuşak yaklaşma (τ ≈ 0,25 sn)
      const a = Math.min(1, dt / 0.25);
      SURF.z += (SURF.tz - SURF.z) * a; SURF.p += (SURF.tp - SURF.p) * a; SURF.r += (SURF.tr - SURF.r) * a;
      applySurf();
    }
    if (method === 'ramp') {
      if (S.phase === 'launch') {
        S.t += dt;
        const u = Math.min(1, S.t / RAMP_TIME);
        built.car.position.y = built.carY0 + (built.carY1 - built.carY0) * u * u;   // sabit ivme
        if (u >= 1) { S.phase = 'released'; S.t = 0; }
      } else if (S.phase === 'released' || S.phase === 'free') {
        S.t += dt;
        if (S.t > 1.0) built.car.position.y = Math.max(built.carY0, built.car.position.y - dt * 1.2);   // sönümleyici: kızak yavaş geri döner
        if (S.phase === 'released' && S.t > 0.6) S.phase = 'free';
      }
      S.vehSpeed = S.phase === 'idle' || S.phase === 'armed' ? sp : 0;   // römork sabit (SITL kayması giderildi); yine de sürüklenirse tekerlekleri döner
    } else if (S.phase === 'released' || S.phase === 'free') {   // araç: bırakma sonrası kendi hızıyla frenler
      S.t += dt;
      S.vehSpeed = Math.max(0, S.vehSpeed - 4.0 * dt);
      S.vehY += S.vehSpeed * dt / scale;
      built.body.position.y = S.vehY;
      if (S.phase === 'released' && S.t > 0.3) S.phase = 'free';
      for (const l of built.lamps) if (l.userData.kind === 'stop' && S.vehSpeed > 0) l.material = M.stopOn;
    } else {   // idle / armed / launch: araç SITL uçağını taşır (anchor ile); hız = uçağın yer hızı
      S.vehSpeed = sp;
      S.vehY = built.body.position.y;
    }
    const w = (S.vehSpeed / scale) / (built.wheelR || 0.4) * dt;
    for (const wh of built.wheels) wh.rotation.x -= w;
  }
  return {
    group: root, method, attach: built.attach, attachWorld, planeQuat, setPhase, update, anchor, needsAnchor, resurface,
    get surface() { return { z: SURF.z, pitch_deg: SURF.p / DEG, roll_deg: SURF.r / DEG }; },   // teşhis: düzeneğin yüzey oturması
    // Demir ne zaman atılır: araç `launch`ta her kare (SITL yer koşusunu taşır); idle/armed'da yalnız gerekiyorsa (ilk kez ya da > 2 m sıçrama)
    get anchored() { return S.phase === 'idle' || S.phase === 'armed' || (S.phase === 'launch' && method === 'vehicle'); },
    get tracking() { return S.phase === 'launch' && method === 'vehicle'; },   // her kare izleme
    get phase() { return S.phase; },
    get carrying() { return S.phase === 'idle' || S.phase === 'armed' || S.phase === 'launch'; },   // uçak düzeneğe bağlı gösterilir
    get blend() { return S.phase === 'released' ? Math.min(1, S.t / (method === 'ramp' ? 0.6 : 0.3)) : S.phase === 'free' ? 1 : 0; },   // 0 → kızak, 1 → SITL
    sidePoint: (dx, dy, dz) => tmp.set(dx * scale, dy * scale, dz * scale).applyQuaternion(tmpQ.setFromEuler(new T.Euler(0, 0, root.rotation.z))),   // yer kamerası için yan nokta
    dispose() { root.traverse(o => { o.geometry?.dispose?.(); const ms = Array.isArray(o.material) ? o.material : (o.material ? [o.material] : []); ms.forEach(m => m.dispose?.()); }); root.removeFromParent(); },
  };
}

// ---------- kayıttan oynatma: aşamalar logdan (§8) ----------
// frames: önbellek kareleri (fields sırası), FI: alan → dizin. Her ARM segmenti için { arm, launch, release, disarm }:
//   arm: `armed` 0→1 anı · launch: ilk hareket (yer hızı > 2 m/s ya da ARM anına göre AGL artışı > 0,5 m) · release: yönteme göre bırakma
//   (rampa: yer hızı ≥ 8 m/s ya da AGL artışı > 3 m — SITL dizisiyle aynı eşik; araç: yer hızı ≥ %95 bırakma hızı ya da AGL > 3 m; tekerlekli: AGL > 1 m)
//   · disarm: `armed` 1→0 (yoksa null). Gerçek loglarda kalkış öncesi kalibrasyon ARM'ları hareketsiz segment olur → DISARM'da düzenek `idle`a döner.
export const REPLAY_MOVE_SPEED = 2, REPLAY_RAMP_RELEASE = 8, REPLAY_RELEASE_AGL = 3, REPLAY_MOVE_CLIMB = 0.5, REPLAY_WHEELS_AGL = 1;
export function replayLaunchTimeline(frames, FI, launch) {
  const segs = [];
  const col = (f, k) => (FI?.[k] == null ? null : f[FI[k]]);
  const m = launch?.method || 'wheels', relSpeed = m === 'ramp' ? REPLAY_RAMP_RELEASE : m === 'vehicle' ? 0.95 * (Number(launch?.release_kmh) || 70) / 3.6 : Infinity;
  const relClimb = m === 'wheels' ? REPLAY_WHEELS_AGL : REPLAY_RELEASE_AGL;
  let cur = null, prevArmed = false, agl0 = null;
  for (const f of frames || []) {
    const t = col(f, 't') ?? f[0], armed = !!col(f, 'armed'), gs = Number(col(f, 'gs')) || 0, agl = col(f, 'alt_rel');
    if (armed && !prevArmed) { cur = { arm: t, launch: null, release: null, disarm: null }; agl0 = agl; segs.push(cur); }
    else if (!armed && prevArmed && cur) { cur.disarm = t; cur = null; }
    if (cur && armed) {
      if (agl0 == null) agl0 = agl;
      const climb = agl != null && agl0 != null ? agl - agl0 : 0;
      if (cur.launch == null && (gs > REPLAY_MOVE_SPEED || climb > REPLAY_MOVE_CLIMB)) cur.launch = t;
      if (cur.launch != null && cur.release == null && (gs >= relSpeed || climb > relClimb)) cur.release = t;
    }
    prevArmed = armed;
  }
  return segs;
}
// t anındaki aşama: ARM öncesi 'idle'; ARM → 'armed'; ilk hareket → 'launch'; bırakma → 'released' (uçuş sonu DISARM'da kalır); hareketsiz
// segmentin DISARM'ı → 'idle' (uçak yeniden kızağa oturur).
export function replayLaunchPhaseAt(segs, t) {
  let s = null;
  for (const x of segs || []) { if (x.arm <= t) s = x; else break; }
  if (!s) return 'idle';
  if (s.disarm != null && t >= s.disarm) return s.release != null ? 'released' : 'idle';
  if (s.release != null && t >= s.release) return 'released';
  if (s.launch != null && t >= s.launch) return 'launch';
  return 'armed';
}
