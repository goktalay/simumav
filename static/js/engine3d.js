// Motor 3B zarf modelleri (parametrik): üretici ölçü çizimlerinden türetilmiş yaklaşık dış geometri — boxer (karşılıklı) iki silindirli
// iki zamanlı UAV motorları. Gerçek CAD dosyaları üreticiden alınmadığı için kütle/yerleşim/CFD için dış zarf yeterli ayrıntıdadır.
// Eksenler (motor yerel): +X pervane (krank mili) yönü, ±Y silindirler, +Z karbüratör/üst. Birim mm. Döner: [{ name, geometry(THREE), color }]
export const ENGINES = {
  'DLE-222': {   // 222,5 cc, 45×35 mm, 4,86 kg (egzoz 0,47 + ateşleme 0,38), 11,8 kW @ 7523; çizim: genişlik 257, uzunluk 286, yükseklik 116 (karb.), silindir 90
    label: '222CC 2 Pistonlu — Arkadan İtişli (DLE-222 zarfı)', cc: 222, weight_g: 4860, power_kw: 11.8, rpm: 7523,
    width: 257, length: 230, height: 116, cyl_d: 92, cyl_h: 90, case: [120, 90, 96], mount: 80, prop_hub: 56, prop_d: 32 * 25.4, carb: [46, 60, 40], muffler: [160, 38],
  },
  'HE-280': {   // 280 cc, 66×40 mm, 7,8 kg, 16–17 kW @ 6500, EFI; çizim yok → DLE-222 oranlarından ölçeklenmiş (silindir çapı 66 mm bore + soğutma kanatları)
    label: '280CC 2 Pistonlu — EFI (HE-280 zarfı)', cc: 280, weight_g: 7800, power_kw: 16.5, rpm: 6500, efi: true,
    width: 300, length: 250, height: 135, cyl_d: 112, cyl_h: 100, case: [135, 100, 110], mount: 90, prop_hub: 64, prop_d: 34 * 25.4, carb: [52, 70, 46], muffler: [180, 44],
  },
};

export function buildEngine(THREE, key) {
  const e = ENGINES[key]; if (!e) return [];
  const parts = [];
  const add = (name, g, color, pos = [0, 0, 0], rot = null) => { if (rot) g.rotateX(rot[0]), g.rotateY(rot[1]), g.rotateZ(rot[2]); g.translate(...pos); g.computeVertexNormals(); parts.push({ name, geometry: g, color }); };
  const alu = 0x9aa3ad, dark = 0x3b4046, black = 0x1f2326, steel = 0x6b7280;
  const [cw, cd, ch] = e.case;
  // Karter (kasa): yuvarlatılmış kutu yerine kutu + silindirik krank yuvası
  add('Karter', new THREE.BoxGeometry(cw, cd, ch, 1, 1, 1), alu);
  add('Krank yuvası', new THREE.CylinderGeometry(ch * 0.42, ch * 0.42, cw * 0.9, 24), alu, [0, 0, 0], [0, 0, Math.PI / 2]);
  // Silindirler: ±Y, soğutma kanatları (ince diskler), kafa, buji
  for (const s of [1, -1]) {
    const y0 = s * (cd / 2);
    const cyl = new THREE.CylinderGeometry(e.cyl_d * 0.34, e.cyl_d * 0.34, e.cyl_h, 28);
    add(s > 0 ? 'Silindir sağ' : 'Silindir sol', cyl, dark, [0, y0 + s * e.cyl_h / 2, 0]);
    const nf = 9;
    for (let i = 0; i < nf; i++) {
      const fin = new THREE.CylinderGeometry(e.cyl_d / 2 * (0.78 + 0.22 * Math.min(1, i / 3)), e.cyl_d / 2 * (0.78 + 0.22 * Math.min(1, i / 3)), 2.2, 28);
      add(`Kanat ${s > 0 ? 'R' : 'L'}${i + 1}`, fin, alu, [0, y0 + s * (12 + i * (e.cyl_h - 20) / (nf - 1)), 0]);
    }
    add(s > 0 ? 'Silindir kafası sağ' : 'Silindir kafası sol', new THREE.CylinderGeometry(e.cyl_d * 0.46, e.cyl_d * 0.5, 14, 28), alu, [0, y0 + s * (e.cyl_h + 7), 0]);
    add(s > 0 ? 'Buji sağ' : 'Buji sol', new THREE.CylinderGeometry(6, 6, 22, 12), steel, [0, y0 + s * (e.cyl_h + 24), 0]);
    // Egzoz: silindir altından arkaya (−X) susturucu
    const [ml, md] = e.muffler;
    add(s > 0 ? 'Susturucu sağ' : 'Susturucu sol', new THREE.CylinderGeometry(md / 2, md / 2, ml, 20), black, [-cw / 2 - 10 - ml / 2 + 30, y0 + s * (e.cyl_h * 0.55), -ch * 0.45], [0, 0, Math.PI / 2]);
    add(s > 0 ? 'Egzoz borusu sağ' : 'Egzoz borusu sol', new THREE.CylinderGeometry(12, 12, 50, 14), steel, [-5, y0 + s * (e.cyl_h * 0.55), -ch * 0.3], [Math.PI / 2 * 0.55, 0, 0]);
  }
  // Karbüratör / EFI gövdesi + manifold (+Z)
  const [kx, ky, kz] = e.carb;
  add('Emme manifoldu', new THREE.CylinderGeometry(16, 16, 40, 16), alu, [0, 0, ch / 2 + 20]);
  add(e.efi ? 'EFI gövdesi' : 'Karbüratör', new THREE.BoxGeometry(kx, ky, kz), e.efi ? dark : steel, [0, 0, ch / 2 + 40 + kz / 2]);
  if (e.efi) add('Hava filtresi', new THREE.CylinderGeometry(34, 34, 26, 20), black, [0, 0, ch / 2 + 40 + kz + 13]);
  // Pervane göbeği (+X) ve arka montaj flanşı (−X) 4 delikli (delikler modellenmez)
  add('Pervane göbeği', new THREE.CylinderGeometry(e.prop_hub / 2, e.prop_hub / 2 * 0.8, 36, 24), alu, [cw / 2 + 18, 0, 0], [0, 0, Math.PI / 2]);
  add('Mil', new THREE.CylinderGeometry(7, 7, 40, 12), steel, [cw / 2 + 50, 0, 0], [0, 0, Math.PI / 2]);
  add('Montaj flanşı', new THREE.BoxGeometry(10, e.mount + 30, e.mount + 30), alu, [-cw / 2 - 5, 0, 0]);
  for (const [sy, sz] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) add('Montaj bağlantısı', new THREE.CylinderGeometry(7, 7, 25, 10), steel, [-cw / 2 - 22, sy * e.mount / 2, sz * e.mount / 2], [0, 0, Math.PI / 2]);
  // Ateşleme modülü (alt)
  add('Ateşleme modülü', new THREE.BoxGeometry(60, 40, 22), black, [0, 0, -ch / 2 - 12]);
  return parts;
}

// Pervane (isteğe bağlı görsel): 2 pala düz plaka
export function buildProp(THREE, key) {
  const e = ENGINES[key]; if (!e) return [];
  const g = new THREE.BoxGeometry(6, e.prop_d, 28);
  g.translate(e.case[0] / 2 + 60, 0, 0);
  g.computeVertexNormals();
  return [{ name: 'Pervane', geometry: g, color: 0x222222 }];
}
