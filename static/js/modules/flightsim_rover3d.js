// Uçuş Simülatörü — KARA ARACI 3B katmanı (docs/ucus-simulatoru.md §31; flightsim3d.js kullanır; HEPGO + SIMUMAV ortak).
//   • roverRig(T, built): yüklü modelde (GLB: tools/rover_models_build.py düğüm kuralı) teker / direksiyon düğümlerini bulur, gövde çerçevesinde
//     (burun +Y, sağ +X, üst +Z; metre, ölçeksiz) dingil mesafesi, iz genişliği, teker yarıçapları, kokpit ve sensör noktalarını çıkarır;
//     update(dt, kin, comp, S) her karede tekerleri yer hızıyla döndürür (sol/sağ ayrı — skid/palet), Ackermann'da ön tekerleri döndürür
//     (iç/dış teker Ackermann geometrisi) ve süspansiyon sıkışmasını teker düğümlerine ofset olarak uygular.
//   • buildRoverProc(T, M, mesh, kind): GLB yüklenemezse prosedürel yedek (kutu gövde + adlandırılmış tekerler; aynı rig çalışır).
//   • createDust(T, parent): tekerlerin arkasından toz izi (sprite havuzu; hız ve zemin türüyle yoğunluk; termalde gizli sayılır).
import { ROVER_LIMITS, normDrive } from './flightsim_rover.js';

const WHEEL_RE = /^wheel_([fmr])([lr])$|^wheel_([lr])(\d+)$/i;
const STEER_RE = /^steer_([fr])([lr])$/i;
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

export function roverRig(T, built) {
  const grp = built.grp;
  grp.updateMatrixWorld(true);
  const inv = new T.Matrix4().copy(grp.matrixWorld).invert();
  const local = o => new T.Vector3().setFromMatrixPosition(new T.Matrix4().multiplyMatrices(inv, o.matrixWorld));
  const wheels = [], steers = [];
  let root = null;
  grp.traverse(o => {
    const n = (o.name || '').trim();
    if (!root && o.userData && (o.userData.drive || o.userData.wheelbase)) root = o;
    const m = WHEEL_RE.exec(n);
    if (m) {
      const p = local(o);
      // yarıçap: düğümün gövde çerçevesindeki sınır kutusu (yükseklik / 2)
      const bb = new T.Box3();
      o.traverse(c => { if (c.isMesh && c.geometry) { c.geometry.computeBoundingBox(); bb.union(c.geometry.boundingBox.clone().applyMatrix4(new T.Matrix4().multiplyMatrices(inv, c.matrixWorld))); } });
      const r = bb.isEmpty() ? 0.3 : Math.max(0.03, (bb.max.z - bb.min.z) / 2);
      const side = (m[2] || m[3] || '').toLowerCase() === 'l' ? 'l' : 'r';
      const holder = STEER_RE.test((o.parent?.name || '').trim()) ? o.parent : o;   // süspansiyon ofseti direksiyon mafsalına (ön teker onun çocuğu)
      wheels.push({ obj: o, side, front: (m[1] || '').toLowerCase() === 'f', r, pos: p, holder, rest: holder.position.clone(), ang: 0 });
      return;
    }
    const s = STEER_RE.exec(n);
    if (s) steers.push({ obj: o, side: s[2].toLowerCase(), pos: local(o), q0: o.quaternion.clone() });
  });
  const ex = root?.userData || {};
  const xs = wheels.map(w => w.pos.x), ys = wheels.map(w => w.pos.y);
  const track = wheels.length ? Math.max(0.2, Math.max(...xs) - Math.min(...xs)) : Number(ex.track) || 1.0;
  const wheelbase = wheels.length ? Math.max(0.2, Math.max(...ys) - Math.min(...ys)) : Number(ex.wheelbase) || 1.3;
  const cy = wheels.length ? (Math.max(...ys) + Math.min(...ys)) / 2 : 0, cx = wheels.length ? (Math.max(...xs) + Math.min(...xs)) / 2 : 0;
  const bottom = wheels.length ? Math.min(...wheels.map(w => w.pos.z - w.r)) : null;
  // extras noktaları [ileri, zeminden yükseklik, sağ]: kök düğümün YEREL çerçevesindedir (geometri merkezlemeden önceki zemin çerçevesinde eklenmiş,
  // kökün kendi dönüşümü −merkez) → kök matrixWorld ile gövde çerçevesine
  const exPoint = a => {
    if (!Array.isArray(a) || a.length !== 3 || !root) return null;
    return new T.Vector3(Number(a[0]), Number(a[1]), Number(a[2])).applyMatrix4(new T.Matrix4().multiplyMatrices(inv, root.matrixWorld));
  };
  const rig = {
    wheels, steers, track, wheelbase, center: [cx, cy], bottom, drive: normDrive(ex.drive || (steers.length ? 'ackermann' : 'skid')), tracked: !!ex.tracked,
    cockpit: exPoint(ex.cockpit), sensor: exPoint(ex.sensor), steerDeg: 0,
    /** dt sn; kin: roverKinematics çıktısı (vL, vR m/s; steer rad); comp(i) köşe sıkışması (m; 0 sol-arka,1 sağ-arka,2 sol-ön,3 sağ-ön); S görsel ölçek */
    update(dt, kin, comp = null, S = 1) {
      if (!kin) return;
      for (const w of wheels) {
        const v = w.side === 'l' ? kin.vL : kin.vR;
        w.ang = (w.ang - v / (w.r * S) * dt) % (2 * Math.PI);   // ileri yuvarlanma: aks (+Z, sağ) etrafında negatif
        w.obj.rotation.z = w.ang;
        if (comp && w.holder) {   // köşe sıkışmasını tekerin konumuna göre çift doğrusal karıştır (gövde y: arka → ön, x: sol → sağ)
          const fy = clamp((w.pos.y - (cy - wheelbase / 2)) / wheelbase, 0, 1), fx = clamp((w.pos.x - (cx - track / 2)) / track, 0, 1);
          const c = (comp(0) * (1 - fx) + comp(1) * fx) * (1 - fy) + (comp(2) * (1 - fx) + comp(3) * fx) * fy;
          const off = clamp(c, -0.09 * Math.max(1, w.r / 0.3), 0.09 * Math.max(1, w.r / 0.3)) / S;
          w.holder.position.set(w.rest.x, w.rest.y + off, w.rest.z);   // GLB yerelinde +Y yukarı
        }
      }
      // Ackermann: iç teker daha çok döner — R = L / tan δ (sağ +); δ_iç/dış = atan(L / (R ∓ W/2))
      const d = clamp(kin.steer || 0, -ROVER_LIMITS.ackermann.steerDeg * Math.PI / 180, ROVER_LIMITS.ackermann.steerDeg * Math.PI / 180);
      this.steerDeg = d * 180 / Math.PI;
      for (const s of steers) {
        let a = d;
        if (Math.abs(d) > 1e-3) {
          const R = wheelbase / Math.tan(Math.abs(d)), inner = (d > 0) === (s.side === 'r');
          a = Math.sign(d) * Math.atan(wheelbase / Math.max(0.05, R + (inner ? -track / 2 : track / 2)));
        }
        s.obj.rotation.y = -a;   // GLB yerel +Y (pim) etrafında: sağa dönüş negatif
      }
    },
  };
  return rig;
}

// GLB yüklenemezse: kutu gövde + adlandırılmış tekerler (gövde çerçevesi; tekerler GLB kuralına uymak için Y-yukarı alt grup içinde)
export function buildRoverProc(T, M, mesh, kind = 'rover_4x4') {
  const grp = new T.Group();
  const inner = new T.Group();   // GLB çerçevesi: burun +X, yukarı +Y, sağ +Z → gövde (burun +Y, sağ +X, üst +Z)
  inner.quaternion.setFromRotationMatrix(new T.Matrix4().makeBasis(new T.Vector3(0, 0, 1), new T.Vector3(1, 0, 0), new T.Vector3(0, 1, 0)).transpose());
  grp.add(inner);
  const small = kind === 'rover_bot', skid = kind !== 'rover_4x4';
  const R = small ? 0.1 : 0.33, L = small ? 0.5 : 1.3, W = small ? 0.5 : 1.06, H = small ? 0.3 : 0.4;
  const root = new T.Group(); root.name = 'rover'; root.userData = { drive: skid ? 'skid' : 'ackermann', wheelbase: L, track: W };
  inner.add(root);
  const body = mesh(new T.BoxGeometry(L + 0.4 * (small ? 0.4 : 1), H, W * 0.9), small ? M.white : M.grey, 0, R + H / 2 + 0.05, 0); root.add(body);
  const tyre = new T.CylinderGeometry(R, R, R * 0.7, 18).rotateX(Math.PI / 2);   // aks +Z
  for (const [f, x] of [['f', L / 2], ['r', -L / 2]]) {
    for (const [s, z] of [['l', -W / 2], ['r', W / 2]]) {
      const w = mesh(tyre, M.carbon, 0, 0, 0); w.name = `wheel_${f}${s}`;
      w.add(mesh(new T.BoxGeometry(R * 1.2, R * 0.2, R * 0.75), M.grey));   // dönüşü belli eden kol
      if (f === 'f' && !skid) { const st = new T.Group(); st.name = `steer_${f}${s}`; st.position.set(x, R, z); st.add(w); root.add(st); }
      else { w.position.set(x, R, z); root.add(w); }
    }
  }
  root.position.y = -(R + H / 2);   // yaklaşık merkezleme
  return { grp, props: [], ctrl: [], tips: {} };
}

// ---------- toz izi ----------
let dustTex = null;
const dustTexture = T => {
  if (dustTex) return dustTex;
  const cv = document.createElement('canvas'); cv.width = cv.height = 64;
  const g = cv.getContext('2d'), gr = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  gr.addColorStop(0, 'rgba(255,255,255,0.9)'); gr.addColorStop(0.45, 'rgba(255,255,255,0.35)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = gr; g.fillRect(0, 0, 64, 64);
  dustTex = new T.CanvasTexture(cv);
  return dustTex;
};
/** Toz parçacıkları (dünya çerçevesi, Z yukarı): emit(x, y, z, vx, vy, n) · update(dt) · setColor(hex) · clear() · dispose(). */
export function createDust(T, parent, { max = 160, color = 0xb8a27e } = {}) {
  const group = new T.Group(); group.name = 'rover_dust'; parent.add(group);
  const pool = [];
  const tex = typeof document !== 'undefined' ? dustTexture(T) : null;
  for (let i = 0; i < max; i++) {
    const sp = new T.Sprite(new T.SpriteMaterial({ map: tex, color, transparent: true, opacity: 0, depthWrite: false, fog: true }));
    sp.visible = false; sp.userData = { life: 0, age: 0, vx: 0, vy: 0, vz: 0, s0: 0.4 };
    group.add(sp); pool.push(sp);
  }
  let next = 0, acc = 0;
  return {
    group,
    get active() { return pool.some(p => p.visible); },
    emit(x, y, z, vx, vy, rate, dt, size = 1) {
      acc += rate * dt;
      while (acc >= 1) {
        acc -= 1;
        const p = pool[next]; next = (next + 1) % pool.length;
        const u = p.userData;
        u.life = 1.6 + Math.random() * 1.2; u.age = 0; u.s0 = (0.35 + Math.random() * 0.35) * size;
        u.vx = vx * 0.15 + (Math.random() - 0.5) * 0.8; u.vy = vy * 0.15 + (Math.random() - 0.5) * 0.8; u.vz = 0.35 + Math.random() * 0.5;
        p.position.set(x + (Math.random() - 0.5) * 0.3 * size, y + (Math.random() - 0.5) * 0.3 * size, z + 0.05);
        p.visible = true;
      }
    },
    update(dt) {
      for (const p of pool) {
        if (!p.visible) continue;
        const u = p.userData;
        u.age += dt;
        if (u.age >= u.life) { p.visible = false; p.material.opacity = 0; continue; }
        const k = u.age / u.life;
        p.position.x += u.vx * dt; p.position.y += u.vy * dt; p.position.z += u.vz * dt;
        u.vz *= Math.exp(-1.2 * dt); u.vx *= Math.exp(-0.8 * dt); u.vy *= Math.exp(-0.8 * dt);
        p.scale.setScalar(u.s0 * (1 + 3.5 * k));
        p.material.opacity = 0.42 * (1 - k) * Math.min(1, u.age * 6);
      }
    },
    setColor(hex) { for (const p of pool) p.material.color.setHex(hex); },
    clear() { for (const p of pool) { p.visible = false; p.material.opacity = 0; } },
    dispose() { for (const p of pool) p.material.dispose(); parent.remove(group); },
  };
}
