// Mini 3B arazi: parkur preview.png dokulu, hafif kabartmalı dönen disk + neon FPV halkaları. Editör kipinde tıklama → halka konumu.
import { loadThree, makeStage, lights } from '../core/three.js';

const DEG = Math.PI / 180;
export function metersPerDeg(lat) { return { lat: 111320, lon: 111320 * Math.cos(lat * DEG) }; }

/** host içine dönen arazi; setTrack(track) ile doku/halkalar güncellenir; onPick(lat, lon) verilirse tıklama konum döndürür. */
export async function terrainViewer(host, { spin = 0.25, onPick = null, tilt = 0.9, env = false } = {}) {
  const lib = await loadThree();
  const { THREE } = lib;
  let track = null, disk = null, gateGroup = null, pulse = 0;
  const stage = makeStage(lib, host, { alpha: true, fov: 38, env, pixelRatioMax: 1.5, onFrame: (dt, tm) => { if (disk && spin) { disk.rotation.z += dt * spin; gateGroup.rotation.z = disk.rotation.z; } pulse = tm; gateGroup?.children.forEach((g, i) => { if (g.userData.glow) g.userData.glow.material.opacity = 0.25 + 0.2 * Math.sin(tm * 3 + i); }); } });
  const root = new THREE.Group(); root.rotation.x = -tilt; stage.scene.add(root);
  stage.camera.position.set(0, 1.3, 3.7); stage.camera.lookAt(0, -0.15, 0);
  lights(THREE, stage.scene, 1.1);
  const R = 1.25;
  gateGroup = new THREE.Group(); root.add(gateGroup);
  const rim = new THREE.Mesh(new THREE.TorusGeometry(R + 0.03, 0.012, 8, 96), new THREE.MeshBasicMaterial({ color: 0x38bdf8, transparent: true, opacity: 0.6 }));
  root.add(rim);
  const loader = new THREE.TextureLoader();

  const toLocal = (lat, lon) => { const m = metersPerDeg(track.lat), r = Number(track.radius_m) || 1000; return { x: ((lon - track.lon) * m.lon) / r * R, y: ((lat - track.lat) * m.lat) / r * R }; };
  const toGeo = (x, y) => { const m = metersPerDeg(track.lat), r = Number(track.radius_m) || 1000; return { lat: track.lat + (y / R) * r / m.lat, lon: track.lon + (x / R) * r / m.lon }; };

  const buildDisk = tex => {
    if (disk) { root.remove(disk); disk.geometry.dispose(); }
    const geo = new THREE.CircleGeometry(R, 96);
    // hafif kabartma: tohumlu gürültü (prosedürel / doku yoksa daha belirgin)
    const pos = geo.attributes.position, seed = (Number(track?.lat) || 0) * 1000;
    for (let i = 0; i < pos.count; i++) { const x = pos.getX(i), y = pos.getY(i), d = Math.hypot(x, y) / R; const n = Math.sin(x * 7 + seed) * Math.cos(y * 6 - seed) * 0.05 + Math.sin(x * 19) * Math.sin(y * 17) * 0.02; pos.setZ(i, d > 0.15 ? n * (0.5 + d) : 0); }
    geo.computeVertexNormals();
    const mat = tex ? new THREE.MeshStandardMaterial({ map: tex, roughness: 0.9, metalness: 0 }) : new THREE.MeshStandardMaterial({ color: track?.world_mode === 'procedural' ? 0x3f7a3a : 0x5b7a99, roughness: 0.95, flatShading: true });
    disk = new THREE.Mesh(geo, mat); root.add(disk);
    // merkez işareti (pist / kalkış)
    const pad = new THREE.Mesh(new THREE.RingGeometry(0.05, 0.08, 32), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.8, side: THREE.DoubleSide })); pad.position.z = 0.03; disk.add(pad);
    if (track?.world?.runway !== false && track?.world_mode === 'procedural') { const rw = new THREE.Mesh(new THREE.PlaneGeometry(0.06, 0.5), new THREE.MeshBasicMaterial({ color: 0x333333 })); rw.rotation.z = -(Number(track.world?.runway_heading) || 0) * DEG; rw.position.z = 0.02; disk.add(rw); }
  };
  const buildGates = () => {
    gateGroup.clear();
    for (const g of track?.gates || []) {
      const l = toLocal(Number(g.lat), Number(g.lon));
      const rr = Math.max(0.05, (Number(g.radius_m) || 5) / (Number(track.radius_m) || 1000) * R * 6);
      const col = g.kind === 'gate' ? 0xa78bfa : 0x38bdf8;
      const ring = new THREE.Mesh(g.kind === 'gate' ? new THREE.TorusGeometry(rr, 0.012, 8, 4) : new THREE.TorusGeometry(rr, 0.012, 8, 40), new THREE.MeshBasicMaterial({ color: col }));
      if (g.kind === 'gate') ring.rotation.z = Math.PI / 4;
      const glow = new THREE.Mesh(new THREE.TorusGeometry(rr, 0.035, 8, 40), new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.3 }));
      const grp = new THREE.Group(); grp.add(ring, glow); grp.userData.glow = glow;
      const z = 0.08 + Math.min(1, (Number(g.agl_m) || 10) / 120) * 0.5;
      grp.position.set(l.x, l.y, z); grp.rotation.x = Math.PI / 2; grp.rotation.y = (Number(g.yaw_deg) || 0) * DEG;
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.004, 0.004, z, 6), new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.5 })); pole.rotation.x = Math.PI / 2; pole.position.set(l.x, l.y, z / 2);
      grp.userData.pole = pole; gateGroup.add(grp); gateGroup.add(pole);
      // sıra etiketi (sprite)
      const c = document.createElement('canvas'); c.width = 64; c.height = 64; const cx = c.getContext('2d'); cx.fillStyle = '#fff'; cx.font = 'bold 40px sans-serif'; cx.textAlign = 'center'; cx.textBaseline = 'middle'; cx.fillText(String(g.i != null ? g.i + 1 : ''), 32, 34);
      const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(c), transparent: true, depthTest: false })); sp.scale.setScalar(0.16); sp.position.set(l.x, l.y, z + rr + 0.1); gateGroup.add(sp);
    }
  };
  const setTrack = tr => {
    track = tr;
    const url = tr?.preview_png || (tr?.id ? `/api/tracks/${tr.id}/preview.png` : null);
    if (url) loader.load(url, tex => { tex.colorSpace = THREE.SRGBColorSpace; buildDisk(tex); buildGates(); }, undefined, () => { buildDisk(null); buildGates(); });
    else { buildDisk(null); buildGates(); }
  };
  if (onPick) {
    const ray = new THREE.Raycaster(), v = new THREE.Vector2();
    stage.canvas.addEventListener('click', e => {
      if (!disk) return;
      const r = stage.canvas.getBoundingClientRect(); v.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
      ray.setFromCamera(v, stage.camera);
      const hit = ray.intersectObject(disk, false)[0]; if (!hit) return;
      const p = disk.worldToLocal(hit.point.clone());
      onPick(toGeo(p.x, p.y));
    });
  }
  stage.start();
  return { setTrack, refreshGates: buildGates, dispose: () => stage.dispose(), stage };
}
