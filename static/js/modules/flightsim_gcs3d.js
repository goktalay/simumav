// Uçuş Simülatörü §26 — yer kontrol sahasının PROSEDÜREL 3B modelleri (three.js `T` argümanla gelir; GLB yok, ağ isteği yok):
//  • buildStation(T): yer kontrol istasyonu — 20 ft askerî shelter konteyner (nervürlü yan duvarlar, kapı, klima ünitesi), çatıda uydu çanağı,
//    teleskopik anten direği (kırbaç antenler), yanında jeneratör, beton taban.
//  • buildTower(T, {radar, eo}): kafes kule (4 ayak, çapraz bağlar, platform + korkuluk); tepede dönen radar anteni (panel dizisi; `radar` grubu Z
//    etrafında döner), yan kolda EO başlığı (pan `eoPan` Z, tilt `eoTilt` X; top küre + pencere).
//  • buildRackPad(T, n): interceptor rafı (beton pad + n fırlatma yuvası) ve yuva konumları.
//  • Radar ekranı katmanı: buildRadarPrism (yön gösteren üçgen prizma + kenar çizgisi + yere iniş çubuğu), buildSweep (dönen tarama hüzmesi),
//    buildRangeRings (kapsama halkası + ara halkalar + yön çentikleri).
// Gövde çerçevesi flightsim3d ile aynı: +Y ileri, +X sağ, +Z yukarı; metre. Termal (§22.3): her mesh userData.heat (0…1; konteyner ılık, jeneratör/klima
// sıcak, kule soğuk metal).

/** EO başlığının kule gövdesindeki yeri (yerel x, y; m) — flightsim3d EO kamerası aynı noktadan bakar */
export const EO_POST = [1.0, 1.0];

const std = (T, color, rough = 0.7, metal = 0.15) => new T.MeshStandardMaterial({ color, roughness: rough, metalness: metal });

function mk(T, geo, mat, x, y, z, heat) {
  const m = new T.Mesh(geo, mat);
  m.position.set(x, y, z);
  m.castShadow = true; m.receiveShadow = true;
  m.userData.heat = heat;
  return m;
}

/** Yer kontrol istasyonu (uzun eksen +Y). Dönüş {group, mast}. */
export function buildStation(T) {
  const g = new T.Group();
  g.name = 'gcs_station';
  const olive = std(T, 0x5f6647, 0.82, 0.12), dark = std(T, 0x2f3428, 0.8, 0.2), metal = std(T, 0x8f969c, 0.45, 0.6), conc = std(T, 0x9a9890, 0.95, 0);
  const white = std(T, 0xe7e9ea, 0.5, 0.1), glass = std(T, 0x1b2a33, 0.15, 0.6);
  g.add(mk(T, new T.BoxGeometry(5.2, 9.2, 0.25), conc, 0, 0, 0.125, 0.4));                         // beton taban
  const L = 6.06, W = 2.44, H = 2.59, z0 = 0.25 + 0.15;
  g.add(mk(T, new T.BoxGeometry(W, L, H), olive, 0, 0, z0 + H / 2, 0.5));                          // shelter gövdesi
  for (let i = -5; i <= 5; i++) {                                                                  // yan nervürler
    for (const s of [-1, 1]) g.add(mk(T, new T.BoxGeometry(0.06, 0.12, H * 0.9), olive, s * (W / 2 + 0.03), i * 0.52, z0 + H / 2, 0.5));
  }
  for (const s of [-1, 1]) for (const e of [-1, 1]) g.add(mk(T, new T.BoxGeometry(0.22, 0.22, H + 0.04), dark, s * (W / 2 - 0.08), e * (L / 2 - 0.08), z0 + H / 2, 0.45));   // köşe dökümleri
  g.add(mk(T, new T.BoxGeometry(0.05, 0.95, 2.0), dark, W / 2 + 0.06, -1.6, z0 + 1.05, 0.48));     // kapı (sağ yan)
  g.add(mk(T, new T.BoxGeometry(0.06, 0.08, 0.25), metal, W / 2 + 0.11, -1.25, z0 + 1.0, 0.4));    // kapı kolu
  g.add(mk(T, new T.BoxGeometry(0.05, 1.4, 0.32), glass, W / 2 + 0.04, 0.9, z0 + 1.75, 0.35));     // pencere bandı
  g.add(mk(T, new T.BoxGeometry(1.2, 0.55, 0.95), white, 0, -L / 2 - 0.3, z0 + 1.6, 0.72));        // klima ünitesi (arka)
  const fan = mk(T, new T.CylinderGeometry(0.32, 0.32, 0.04, 20), dark, 0, -L / 2 - 0.58, z0 + 1.6, 0.8); fan.rotation.x = Math.PI / 2; g.add(fan);
  g.add(mk(T, new T.BoxGeometry(0.5, 0.5, 0.3), dark, 0, 1.6, z0 + H + 0.15, 0.5));               // çatı ekipman kutusu
  // uydu çanağı
  const dish = new T.Group(); dish.position.set(-0.55, -1.7, z0 + H);
  dish.add(mk(T, new T.CylinderGeometry(0.05, 0.05, 0.6, 8), metal, 0, 0, 0.3, 0.4));
  const bowl = mk(T, new T.SphereGeometry(0.55, 20, 8, 0, Math.PI * 2, 0, Math.PI * 0.32), white, 0, 0.05, 0.75, 0.45);
  bowl.rotation.x = -Math.PI * 0.62; dish.add(bowl);
  g.add(dish);
  // teleskopik anten direği + kırbaç antenler
  const mast = new T.Group(); mast.position.set(-0.85, 2.2, z0 + H);
  mast.add(mk(T, new T.CylinderGeometry(0.07, 0.09, 4.2, 10), metal, 0, 0, 2.1, 0.35));
  mast.add(mk(T, new T.CylinderGeometry(0.045, 0.06, 3.6, 8), metal, 0, 0, 5.9, 0.35));
  for (const [dx, dy, h] of [[0.25, 0, 1.8], [-0.25, 0, 2.4], [0, 0.25, 1.4]]) mast.add(mk(T, new T.CylinderGeometry(0.012, 0.012, h, 5), dark, dx, dy, 7.7 + h / 2, 0.3));
  mast.add(mk(T, new T.BoxGeometry(0.62, 0.05, 0.05), metal, 0, 0, 7.72, 0.3));
  g.add(mast);
  // jeneratör (sol yan)
  g.add(mk(T, new T.BoxGeometry(1.3, 2.1, 1.35), std(T, 0x48503c, 0.75, 0.2), -W / 2 - 1.15, 1.2, 0.25 + 0.675, 0.86));
  g.add(mk(T, new T.CylinderGeometry(0.07, 0.07, 0.6, 8), dark, -W / 2 - 1.5, 1.9, 0.25 + 1.65, 0.95));   // egzoz
  // kablo kanalı
  g.add(mk(T, new T.BoxGeometry(0.9, 0.12, 0.08), dark, -W / 2 - 0.45, 1.2, 0.3, 0.6));
  return { group: g, mast };
}

/** Kafes kule (EO + radar). Dönüş {group, radar (Z döner), eoPan (Z), eoTilt (X; −el), eoAt (EO merkez yüksekliği), radarAt}. */
export function buildTower(T, { radar = true, eo = true, eoZ = 18, radarZ = 21.5 } = {}) {
  const g = new T.Group();
  g.name = 'gcs_tower';
  const steel = std(T, 0xb7bcc2, 0.55, 0.55), dark = std(T, 0x2b2f33, 0.65, 0.4), conc = std(T, 0x9a9890, 0.95, 0), white = std(T, 0xeef0f2, 0.45, 0.1), glass = std(T, 0x102030, 0.1, 0.8);
  const H = eoZ - 1.0, b0 = 1.6, b1 = 0.75;   // platform EO topunun 1 m altında   // ayak tabanı / tepesi yarım genişlik
  g.add(mk(T, new T.BoxGeometry(4.6, 4.6, 0.4), conc, 0, 0, 0.2, 0.35));
  const beam = (a, b, r, mat, heat = 0.3) => {
    const d = new T.Vector3().subVectors(b, a), len = d.length();
    const m = mk(T, new T.CylinderGeometry(r, r, len, 6), mat, 0, 0, 0, heat);
    m.position.copy(a).addScaledVector(d, 0.5);
    m.quaternion.setFromUnitVectors(new T.Vector3(0, 1, 0), d.normalize());
    return m;
  };
  const corners = [[1, 1], [-1, 1], [-1, -1], [1, -1]];
  const P = (k, z) => { const f = (z - 0.4) / (H - 0.4), w = b0 + (b1 - b0) * f, [sx, sy] = corners[k % 4]; return new T.Vector3(sx * w, sy * w, z); };
  for (let k = 0; k < 4; k++) g.add(beam(P(k, 0.4), P(k, H), 0.09, steel));
  const levels = 6;
  for (let i = 0; i < levels; i++) {
    const za = 0.4 + (H - 0.4) * i / levels, zb = 0.4 + (H - 0.4) * (i + 1) / levels;
    for (let k = 0; k < 4; k++) {
      g.add(beam(P(k, zb), P(k + 1, zb), 0.035, steel));                     // yatay kuşak
      g.add(beam(P(k, za), P(k + 1, zb), 0.03, steel));                       // çapraz
      g.add(beam(P(k + 1, za), P(k, zb), 0.03, steel));
    }
  }
  // merdiven (bir yüzde)
  g.add(beam(new T.Vector3(0.18, b0 * 0.98, 0.4), new T.Vector3(0.18, b1 * 0.98, H), 0.025, dark));
  g.add(beam(new T.Vector3(-0.18, b0 * 0.98, 0.4), new T.Vector3(-0.18, b1 * 0.98, H), 0.025, dark));
  // platform + korkuluk
  g.add(mk(T, new T.BoxGeometry(2.6, 2.6, 0.12), dark, 0, 0, H + 0.06, 0.35));
  for (let k = 0; k < 4; k++) {
    const a = new T.Vector3(corners[k][0] * 1.3, corners[k][1] * 1.3, H + 1.05), b = new T.Vector3(corners[(k + 1) % 4][0] * 1.3, corners[(k + 1) % 4][1] * 1.3, H + 1.05);
    g.add(beam(a, b, 0.03, steel));
    g.add(beam(new T.Vector3(a.x, a.y, H + 0.1), a, 0.03, steel));
  }
  // kabin (elektronik kutusu) — ılık
  g.add(mk(T, new T.BoxGeometry(1.0, 0.8, 0.9), white, -0.55, -0.55, H + 0.57, 0.62));
  // ikaz lambası (tepe)
  const out = { group: g, radar: null, eoPan: null, eoTilt: null, eoAt: eoZ, radarAt: radarZ, beacon: null };
  // radar: direk + döner kafa + panel anten
  if (radar) {
    g.add(mk(T, new T.CylinderGeometry(0.16, 0.22, radarZ - H - 0.6, 12), steel, 0, 0, H + (radarZ - H - 0.6) / 2, 0.35));
    g.add(mk(T, new T.CylinderGeometry(0.42, 0.42, 0.5, 18), dark, 0, 0, radarZ - 0.6, 0.6));       // sürücü (ılık)
    const rg = new T.Group(); rg.position.set(0, 0, radarZ - 0.3); rg.name = 'gcs_radar';
    rg.add(mk(T, new T.CylinderGeometry(0.2, 0.3, 0.35, 12), steel, 0, 0, 0.12, 0.45));
    const panel = mk(T, new T.BoxGeometry(3.4, 0.22, 0.95), white, 0, 0.12, 0.85, 0.52);
    panel.rotation.x = -0.22; rg.add(panel);
    for (let i = -6; i <= 6; i++) { const r = mk(T, new T.BoxGeometry(0.035, 0.05, 0.85), std(T, 0xc9cdd1, 0.5, 0.2), i * 0.25, 0.24, 0.86, 0.5); r.rotation.x = -0.22; rg.add(r); }
    rg.add(mk(T, new T.BoxGeometry(0.55, 0.45, 0.4), dark, 0, -0.32, 0.5, 0.65));                  // arka elektronik
    g.add(rg); out.radar = rg;
    const bc = mk(T, new T.SphereGeometry(0.09, 10, 8), new T.MeshBasicMaterial({ color: 0xff3020 }), 0, 0, radarZ + 1.1, 0.4);
    g.add(mk(T, new T.CylinderGeometry(0.02, 0.02, 0.55, 5), steel, 1.25, 1.25, H + 1.4, 0.3));
    bc.position.set(1.25, 1.25, H + 1.72); g.add(bc); out.beacon = bc;
  }
  // EO başlığı: platformun ön-sağ köşesinde kısa direk üstünde pan/tilt top kule (top merkezi = eoZ; görüş platform dışına açık)
  if (eo) {
    const ex = EO_POST[0], ey = EO_POST[1];
    g.add(mk(T, new T.CylinderGeometry(0.09, 0.12, 0.6, 10), steel, ex, ey, H + 0.3, 0.35));
    const pan = new T.Group(); pan.position.set(ex, ey, eoZ - 0.45); pan.name = 'gcs_eo_pan';
    pan.add(mk(T, new T.CylinderGeometry(0.2, 0.24, 0.22, 16), dark, 0, 0, 0.11, 0.6));
    pan.add(mk(T, new T.BoxGeometry(0.62, 0.12, 0.42), dark, 0, 0, 0.32, 0.55));
    const tilt = new T.Group(); tilt.position.set(0, 0, 0.45); tilt.name = 'gcs_eo_tilt';
    tilt.add(mk(T, new T.SphereGeometry(0.27, 22, 16), std(T, 0x9aa1a8, 0.35, 0.5), 0, 0, 0, 0.66));
    const win = mk(T, new T.CylinderGeometry(0.15, 0.15, 0.06, 20), glass, 0, 0.25, 0.03, 0.4); win.rotation.x = Math.PI / 2; tilt.add(win);
    const win2 = mk(T, new T.CylinderGeometry(0.07, 0.07, 0.05, 16), glass, 0.12, 0.24, -0.11, 0.4); win2.rotation.x = Math.PI / 2; tilt.add(win2);
    pan.add(tilt); g.add(pan);
    out.eoPan = pan; out.eoTilt = tilt; out.eoAt = eoZ;
  }
  return out;
}

/** Interceptor rafı: beton pad + n yuva (2 sıra). Dönüş {group, slots: [{x, y}] (yerel; +Y ileri)}. */
export function buildRackPad(T, n = 10) {
  const g = new T.Group();
  g.name = 'gcs_rack';
  const cols = Math.ceil(n / 2), sp = 1.7, rows = n > 1 ? 2 : 1;
  const conc = std(T, 0x8f8d86, 0.95, 0), plate = std(T, 0x3a3f45, 0.6, 0.5), yellow = std(T, 0xf2c230, 0.6, 0.1);
  const Lx = rows * sp + 1.0, Ly = cols * sp + 1.0;
  g.add(mk(T, new T.BoxGeometry(Lx, Ly, 0.2), conc, 0, 0, 0.1, 0.4));
  const slots = [];
  for (let i = 0; i < n; i++) {
    const r = i % rows, c = Math.floor(i / rows);
    const x = (r - (rows - 1) / 2) * sp, y = (c - (cols - 1) / 2) * sp;
    g.add(mk(T, new T.BoxGeometry(1.0, 1.0, 0.06), plate, x, y, 0.23, 0.42));
    g.add(mk(T, new T.BoxGeometry(1.06, 0.06, 0.065), yellow, x, y - 0.5, 0.235, 0.4));
    g.add(mk(T, new T.BoxGeometry(1.06, 0.06, 0.065), yellow, x, y + 0.5, 0.235, 0.4));
    slots.push({ x, y, z: 0.26 });
  }
  return { group: g, slots };
}

// ---------- radar ekranı katmanı (ayrı sahne; ana kamera görmez) ----------
/** Yön gösteren üçgen prizma (ok başı, burun +Y) + parlak kenar çizgisi. Birim boyut ~1; çağıran ekran boyutuna ölçekler. */
export function buildRadarPrism(T, color) {
  const g = new T.Group();
  const sh = new T.Shape();
  sh.moveTo(0, 0.9); sh.lineTo(0.55, -0.55); sh.lineTo(0, -0.25); sh.lineTo(-0.55, -0.55); sh.closePath();
  const geo = new T.ExtrudeGeometry(sh, { depth: 0.38, bevelEnabled: false });
  geo.translate(0, 0, -0.19);
  const mat = new T.MeshBasicMaterial({ color, transparent: true, opacity: 0.88, depthTest: false, depthWrite: false });
  const m = new T.Mesh(geo, mat); m.renderOrder = 5;
  const edges = new T.LineSegments(new T.EdgesGeometry(geo), new T.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.9, depthTest: false }));
  edges.renderOrder = 6;
  const body = new T.Group(); body.add(m, edges);
  g.add(body);
  g.userData = { body, mat, edgeMat: edges.material };
  return g;
}
/** Dönen tarama hüzmesi: merkezden R'ye, `deg` açı genişliğinde, arka kenara doğru sönen 8 dilim (Z ekseni etrafında döndürülür; 0 = kuzey). */
export function buildSweep(T, R, deg = 26, color = 0x3dff8a) {
  const g = new T.Group();
  const n = 8;
  for (let i = 0; i < n; i++) {
    const a0 = (deg * i / n) * Math.PI / 180, a1 = (deg * (i + 1) / n) * Math.PI / 180;
    // CircleGeometry thetaStart doğudan saat yönü TERSİ; hüzmenin önü (i=0) kerteriz 0'da, arkası saat yönü tersine (geride) kalır
    const geo = new T.CircleGeometry(R, 6, Math.PI / 2 + a0, a1 - a0);
    const mat = new T.MeshBasicMaterial({ color, transparent: true, opacity: 0.34 * Math.pow(1 - i / n, 1.6), depthTest: false, depthWrite: false, side: T.DoubleSide });
    const m = new T.Mesh(geo, mat); m.renderOrder = 2; g.add(m);
  }
  const lead = new T.Line(new T.BufferGeometry().setFromPoints([new T.Vector3(0, 0, 0), new T.Vector3(0, R, 0)]), new T.LineBasicMaterial({ color: 0xb6ffd2, transparent: true, opacity: 0.95, depthTest: false }));
  lead.renderOrder = 3; g.add(lead);
  return g;
}
/** Kapsama halkası (parlak) + 3 ara halka (soluk kesikli) + 12 yön çentiği + kuzey işareti. */
export function buildRangeRings(T, R, color = 0x3dff8a) {
  const g = new T.Group();
  const ring = (r, opacity, dashed) => {
    const pts = [];
    for (let k = 0; k <= 160; k++) { const a = k / 160 * Math.PI * 2; pts.push(new T.Vector3(Math.sin(a) * r, Math.cos(a) * r, 0)); }
    const geo = new T.BufferGeometry().setFromPoints(pts);
    const mat = dashed ? new T.LineDashedMaterial({ color, transparent: true, opacity, dashSize: r * 0.03, gapSize: r * 0.025, depthTest: false })
      : new T.LineBasicMaterial({ color, transparent: true, opacity, depthTest: false });
    const l = new T.Line(geo, mat); if (dashed) l.computeLineDistances(); l.renderOrder = 1;
    return l;
  };
  g.add(ring(R, 0.95, false));
  for (const f of [0.25, 0.5, 0.75]) g.add(ring(R * f, 0.38, true));
  const tick = [];
  for (let k = 0; k < 12; k++) { const a = k / 12 * Math.PI * 2, r0 = R * (k % 3 ? 0.96 : 0.92); tick.push(new T.Vector3(Math.sin(a) * r0, Math.cos(a) * r0, 0), new T.Vector3(Math.sin(a) * R, Math.cos(a) * R, 0)); }
  const tl = new T.LineSegments(new T.BufferGeometry().setFromPoints(tick), new T.LineBasicMaterial({ color, transparent: true, opacity: 0.8, depthTest: false })); tl.renderOrder = 1;
  g.add(tl);
  const cross = new T.LineSegments(new T.BufferGeometry().setFromPoints([new T.Vector3(-R, 0, 0), new T.Vector3(R, 0, 0), new T.Vector3(0, -R, 0), new T.Vector3(0, R, 0)]),
    new T.LineBasicMaterial({ color, transparent: true, opacity: 0.16, depthTest: false }));
  cross.renderOrder = 1; g.add(cross);
  return g;
}
