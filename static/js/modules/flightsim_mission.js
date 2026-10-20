// Uçuş Simülatörü — 3B görev katmanı (docs/ucus-simulatoru.md §18): SITL'deki görevin (HEPGO paneli ya da Mission Planner) şık çizimi + iniş dairesi.
// • Bacaklar: yarı saydam tüp (TubeGeometry, düz LineCurve3) — gelecek bacaklar AMBER, geçilenler soluk YEŞİL, aktif bacak (MISSION_CURRENT hedefi) PARLAK
//   beyaz-sarı ve daha kalın; her bacağın yere projeksiyonu kesikli koyu gölge çizgisi (arazi profilini izler: 24 alt parça, terrainHeight), her WP'den
//   zemine ince dikey bağlantı çubuğu.
// • Waypoint işaretleri: küre (durum rengi) + billboard etiket (CanvasTexture Sprite: "seq · alt m"); özel ikonlar: TAKEOFF koni ↑ (yeşil), LAND ters koni
//   (mor), RTL ev işareti (mor; son WP'den eve mor kesikli çizgi), LOITER/LOITER_TO_ALT halka (amber). Ev: yeşil disk + "H".
// • İniş dairesi: görevin bitiş noktasında (LAND konumu / RTL evi / son WP; sunucu `end`) yere oturan daire (çap `landing_circle_m`): beyaz-sarı kesikli
//   halka + ortada "H" (CanvasTexture düzlem), 4 örnek noktadan eğime oturur (terrainHeight), gece hafif ışıklı (PointLight + daha parlak doku).
// • Yükseklik: alt_rel (frame 6) ev zeminine (home yerel z) göre; frame 0/3 (MSL) öğeler ev MSL irtifasıyla göreliye çevrilir.
// Dışa: createMissionLayer(T, { scene, toLocal, terrainHeight, getWorld, getHomeAlt }) → { set(data), setCurrent(seq), redraw(), dispose(), get data, get points }

const NAV = { WP: 16, LOITER_UNLIM: 17, LOITER_TURNS: 18, LOITER_TIME: 19, RTL: 20, LAND: 21, TAKEOFF: 22, LOITER_ALT: 31, SPLINE: 82 };
const COL = { future: 0xffb300, past: 0x22c55e, active: 0xfff3b0, land: 0xa78bfa, home: 0x34d399, shadow: 0x0b1220, stick: 0xffd166 };
const SEG = 24;   // gölge çizgisi alt parça sayısı (arazi profili)

export function createMissionLayer(T, ctx) {
  const g = new T.Group();
  g.name = 'mission';
  ctx.scene.add(g);
  let data = null;      // { points, current, end, home, landing_circle_m, source }
  let light = null;
  const texCache = new Map();

  const num = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);
  const z0 = () => {   // ev zemini (yerel): home varsa onun yeri, yoksa merkez
    const h = data?.home;
    const l = h && Number.isFinite(Number(h.lat)) ? ctx.toLocal(Number(h.lat), Number(h.lon)) : { x: 0, y: 0 };
    return { x: l.x, y: l.y, z: ctx.terrainHeight(l.x, l.y) };
  };
  const relAlt = p => {   // MAV_FRAME 0 (GLOBAL) / 5 (GLOBAL_INT) MSL → ev irtifasıyla göreliye; 3/6 göreli, 10/11 arazi (göreli gibi)
    const a = num(p.alt_rel, num(p.alt, 0));
    const f = Number(p.frame);
    if ((f === 0 || f === 5) && Number.isFinite(Number(ctx.getHomeAlt?.()))) return a - Number(ctx.getHomeAlt());
    return a;
  };

  function label(text, { bg = 'rgba(11,18,32,.78)', fg = '#fff', border = null, w = 256, hgt = 88, font = 'bold 40px system-ui, sans-serif' } = {}) {
    const key = `${text}|${bg}|${fg}|${border}|${w}|${hgt}|${font}`;
    if (texCache.has(key)) return texCache.get(key);
    const cv = document.createElement('canvas'); cv.width = w; cv.height = hgt;
    const c = cv.getContext('2d');
    const r = 18;
    c.fillStyle = bg;
    c.beginPath(); c.roundRect(4, 4, w - 8, hgt - 8, r); c.fill();
    if (border) { c.lineWidth = 6; c.strokeStyle = border; c.stroke(); }
    c.fillStyle = fg; c.font = font; c.textAlign = 'center'; c.textBaseline = 'middle';
    c.fillText(text, w / 2, hgt / 2 + 2);
    const tex = new T.CanvasTexture(cv); tex.colorSpace = T.SRGBColorSpace; tex.anisotropy = 4;
    texCache.set(key, tex);
    return tex;
  }
  function sprite(tex, sx, sy) {   // sizeAttenuation false: etiket uzaktan da okunur (ekran oranı ölçeği; 1 = görünüm yüksekliği)
    const s = new T.Sprite(new T.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, depthTest: false, toneMapped: false, sizeAttenuation: false }));
    s.scale.set(sx, sy, 1); s.renderOrder = 20;
    return s;
  }
  function landingTexture(night) {
    const key = `landing|${night ? 'n' : 'd'}`;
    if (texCache.has(key)) return texCache.get(key);
    const S = 512, cv = document.createElement('canvas'); cv.width = cv.height = S;
    const c = cv.getContext('2d'), cx = S / 2, R = S / 2 - 14;
    c.clearRect(0, 0, S, S);
    // hafif zemin dolgusu (gece daha belirgin)
    c.fillStyle = night ? 'rgba(255, 220, 120, .22)' : 'rgba(255, 255, 255, .10)';
    c.beginPath(); c.arc(cx, cx, R, 0, Math.PI * 2); c.fill();
    // kesikli halka: beyaz + sarı iki kat
    c.lineCap = 'butt';
    c.setLineDash([Math.PI * R / 24, Math.PI * R / 24]);
    c.lineWidth = 22; c.strokeStyle = night ? '#ffe08a' : '#ffd166';
    c.beginPath(); c.arc(cx, cx, R - 11, 0, Math.PI * 2); c.stroke();
    c.lineDashOffset = Math.PI * R / 24;
    c.strokeStyle = '#ffffff';
    c.beginPath(); c.arc(cx, cx, R - 11, 0, Math.PI * 2); c.stroke();
    c.setLineDash([]);
    // iç ince çember
    c.lineWidth = 6; c.strokeStyle = 'rgba(255,255,255,.75)';
    c.beginPath(); c.arc(cx, cx, R * 0.62, 0, Math.PI * 2); c.stroke();
    // H
    c.fillStyle = '#ffffff';
    const hw = R * 0.62, hh = R * 0.78, bar = R * 0.16;
    c.fillRect(cx - hw / 2, cx - hh / 2, bar, hh);
    c.fillRect(cx + hw / 2 - bar, cx - hh / 2, bar, hh);
    c.fillRect(cx - hw / 2, cx - bar / 2, hw, bar);
    const tex = new T.CanvasTexture(cv); tex.colorSpace = T.SRGBColorSpace; tex.anisotropy = 8;
    texCache.set(key, tex);
    return tex;
  }

  function clear() {
    g.traverse(o => { if (o.geometry) o.geometry.dispose(); if (o.material && !o.isSprite) { (Array.isArray(o.material) ? o.material : [o.material]).forEach(m => m.dispose()); } });
    g.clear();
    if (light) { light.dispose?.(); light = null; }
  }

  function tube(a, b, r, color, opacity) {
    const geo = new T.TubeGeometry(new T.LineCurve3(a, b), 1, r, 10, false);
    const m = new T.Mesh(geo, new T.MeshBasicMaterial({ color, transparent: true, opacity, depthWrite: false, toneMapped: false }));
    m.renderOrder = 10;
    return m;
  }
  function shadowLine(a, b) {
    const pts = [];
    for (let i = 0; i <= SEG; i++) { const t = i / SEG, x = a.x + (b.x - a.x) * t, y = a.y + (b.y - a.y) * t; pts.push(new T.Vector3(x, y, ctx.terrainHeight(x, y) + 0.35)); }
    const l = new T.Line(new T.BufferGeometry().setFromPoints(pts), new T.LineDashedMaterial({ color: COL.shadow, dashSize: 5, gapSize: 3.5, transparent: true, opacity: 0.55, depthWrite: false }));
    l.computeLineDistances();
    return l;
  }
  function dashed(a, b, color, opacity = 0.8) {
    const l = new T.Line(new T.BufferGeometry().setFromPoints([a, b]), new T.LineDashedMaterial({ color, dashSize: 6, gapSize: 4, transparent: true, opacity, depthWrite: false }));
    l.computeLineDistances();
    return l;
  }
  function stick(p) {
    return new T.Line(new T.BufferGeometry().setFromPoints([p, new T.Vector3(p.x, p.y, ctx.terrainHeight(p.x, p.y))]),
      new T.LineBasicMaterial({ color: COL.stick, transparent: true, opacity: 0.4, depthWrite: false }));
  }
  function marker(cmd, p, state) {
    const color = state === 'past' ? COL.past : state === 'active' ? COL.active : COL.future;
    const mat = new T.MeshBasicMaterial({ color, transparent: true, opacity: state === 'past' ? 0.6 : 0.95, toneMapped: false });
    let m;
    if (cmd === NAV.TAKEOFF) { m = new T.Mesh(new T.ConeGeometry(3, 6, 14), new T.MeshBasicMaterial({ color: 0x22c55e, toneMapped: false })); m.rotation.x = Math.PI / 2; }
    else if (cmd === NAV.LAND) { m = new T.Mesh(new T.ConeGeometry(3, 6, 14), new T.MeshBasicMaterial({ color: COL.land, toneMapped: false })); m.rotation.x = -Math.PI / 2; }
    else if (cmd === NAV.RTL) { m = new T.Mesh(new T.OctahedronGeometry(3), new T.MeshBasicMaterial({ color: COL.land, toneMapped: false })); }
    else if (cmd === NAV.LOITER_TIME || cmd === NAV.LOITER_ALT || cmd === NAV.LOITER_UNLIM || cmd === NAV.LOITER_TURNS) { m = new T.Mesh(new T.TorusGeometry(3.2, 0.45, 10, 40), mat); }
    else m = new T.Mesh(new T.SphereGeometry(state === 'active' ? 3.2 : 2.6, 18, 14), mat);
    m.position.copy(p);
    m.renderOrder = 11;
    return m;
  }
  const cmdTag = cmd => (cmd === NAV.TAKEOFF ? 'TKOFF' : cmd === NAV.LAND ? 'LAND' : cmd === NAV.RTL ? 'RTL' : (cmd === NAV.LOITER_TIME || cmd === NAV.LOITER_ALT || cmd === NAV.LOITER_UNLIM || cmd === NAV.LOITER_TURNS) ? 'LOITER' : null);

  function drawLanding(home) {
    const e = data?.end;
    if (!e || !Number.isFinite(Number(e.lat))) return;
    const D = Math.max(10, Math.min(200, num(data.landing_circle_m, 30)));
    const l = ctx.toLocal(Number(e.lat), Number(e.lon));
    const r = D / 2, h = (x, y) => ctx.terrainHeight(x, y);
    const zc = h(l.x, l.y), zE = h(l.x + r, l.y), zW = h(l.x - r, l.y), zN = h(l.x, l.y + r), zS = h(l.x, l.y - r);
    const zmax = Math.max(zc, zE, zW, zN, zS, ctx.waterZ?.() ?? -Infinity);
    const night = ctx.getWorld?.()?.time === 'night';
    const plane = new T.Mesh(new T.PlaneGeometry(D, D), new T.MeshBasicMaterial({ map: landingTexture(night), transparent: true, opacity: night ? 1 : 0.92, depthWrite: false, side: T.DoubleSide, toneMapped: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }));
    // eğime oturma: normal = (dz/dx, dz/dy) → quaternion
    const n = new T.Vector3(-(zE - zW) / D, -(zN - zS) / D, 1).normalize();
    plane.quaternion.setFromUnitVectors(new T.Vector3(0, 0, 1), n);
    plane.position.set(l.x, l.y, (zc + zmax) / 2 + 0.25 + Math.abs(zmax - zc) * 0.5);
    plane.renderOrder = 9;
    g.add(plane);
    // kenar tüpü (uzaktan okunur ince çember)
    const ring = new T.Mesh(new T.TorusGeometry(r, 0.25, 8, 72), new T.MeshBasicMaterial({ color: night ? 0xffe08a : 0xffffff, transparent: true, opacity: 0.75, depthWrite: false, toneMapped: false }));
    ring.position.copy(plane.position); ring.quaternion.copy(plane.quaternion); ring.position.z += 0.05;
    g.add(ring);
    if (night) {
      light = new T.PointLight(0xffe9b0, 14, D * 1.3, 1.6);
      light.position.set(l.x, l.y, plane.position.z + Math.max(3, D * 0.15));
      g.add(light);
    }
    // RTL: son WP'den eve mor kesikli hat
    if (Number(e.cmd) === NAV.RTL && home) {
      const pts = points();
      if (pts.length) g.add(dashed(pts[pts.length - 1].v, new T.Vector3(l.x, l.y, zc + 0.6), COL.land, 0.8));
    }
  }

  function points() {
    const o = z0();
    return (data?.points || []).filter(p => Number.isFinite(Number(p.lat)) && Number.isFinite(Number(p.lon))).map(p => {
      const l = ctx.toLocal(Number(p.lat), Number(p.lon));
      const z = o.z + Math.max(0.5, relAlt(p));
      return { p, v: new T.Vector3(l.x, l.y, z), seq: num(p.seq, 0), cmd: num(p.cmd, 16) };
    });
  }

  function draw() {
    clear();
    if (!data) return;
    const pts = points();
    const cur = Number.isFinite(Number(data.current)) ? Number(data.current) : null;
    const state = seq => (cur == null ? 'future' : seq < cur ? 'past' : seq === cur ? 'active' : 'future');
    const o = z0();
    const homeV = new T.Vector3(o.x, o.y, o.z);
    // Ev: disk + H
    if (pts.length) {
      const disk = new T.Mesh(new T.CircleGeometry(3, 32), new T.MeshBasicMaterial({ color: COL.home, transparent: true, opacity: 0.55, depthWrite: false, toneMapped: false, polygonOffset: true, polygonOffsetFactor: -1 }));
      disk.position.set(o.x, o.y, o.z + 0.2); disk.renderOrder = 9;
      g.add(disk);
      const hs = sprite(label('H', { bg: 'rgba(52,211,153,.9)', fg: '#06281c', w: 96, hgt: 96, font: 'bold 64px system-ui, sans-serif' }), 0.05, 0.05);
      hs.position.set(o.x, o.y, o.z + 4);
      g.add(hs);
    }
    // İlk bacak: ev → ilk nokta (TAKEOFF konumsuz olabilir: ev)
    const chain = pts.length && (pts[0].cmd !== NAV.TAKEOFF || pts[0].v.distanceTo(homeV) > 2) ? [{ v: new T.Vector3(o.x, o.y, o.z + 0.6), seq: -1, cmd: 0, home: true }, ...pts] : pts;
    for (let i = 0; i + 1 < chain.length; i++) {
      const a = chain[i], b = chain[i + 1];
      const st = state(b.seq);
      const r = st === 'active' ? 1.8 : 1.2;
      const col = st === 'past' ? COL.past : st === 'active' ? COL.active : COL.future;
      g.add(tube(a.v, b.v, r, col, st === 'past' ? 0.35 : st === 'active' ? 0.95 : 0.6));
      if (st === 'active') g.add(tube(a.v, b.v, r * 1.9, 0xffd166, 0.18));   // parlama halesi
      g.add(new T.Line(new T.BufferGeometry().setFromPoints([a.v, b.v]), new T.LineBasicMaterial({ color: st === 'past' ? COL.past : 0xffe39a, transparent: true, opacity: st === 'past' ? 0.5 : 0.95, depthWrite: false })));
      g.add(shadowLine(a.v, b.v));
    }
    for (const q of pts) {
      const st = state(q.seq);
      g.add(marker(q.cmd, q.v, st));
      g.add(stick(q.v));
      const tag = cmdTag(q.cmd);
      const txt = `${q.seq} · ${Math.round(relAlt(q.p))} m${tag ? ` ${tag}` : ''}`;
      const lb = sprite(label(txt, { border: st === 'active' ? '#ffd166' : st === 'past' ? 'rgba(34,197,94,.9)' : null, fg: st === 'past' ? '#bbf7d0' : '#fff', w: tag ? 320 : 256 }), tag ? 0.17 : 0.135, 0.046);
      lb.position.set(q.v.x, q.v.y, q.v.z + 6);
      g.add(lb);
    }
    drawLanding(data.home || true);
  }

  return {
    set(d) {
      if (!d) { data = null; clear(); return; }
      data = { points: Array.isArray(d.points) ? d.points.slice() : [], current: d.current ?? data?.current ?? null, end: d.end ?? null, home: d.home ?? data?.home ?? null,
        landing_circle_m: d.landing_circle_m ?? data?.landing_circle_m ?? ctx.getWorld?.()?.landing_circle_m ?? 30, source: d.source ?? null };
      if (!data.end && data.points.length) {   // sunucu `end` vermediyse (eski yayın): son nokta
        const last = data.points[data.points.length - 1];
        data.end = { lat: last.lat, lon: last.lon, alt_rel: relAlt(last), cmd: last.cmd };
      }
      draw();
    },
    setCurrent(seq) { if (!data) return; const s = Number(seq); if (data.current === s) return; data.current = Number.isFinite(s) ? s : null; draw(); },
    redraw() { if (data) draw(); },
    dispose() { clear(); ctx.scene.remove(g); texCache.forEach(t => t.dispose()); texCache.clear(); },
    get data() { return data ? { ...data, points: data.points.slice() } : null; },
    get points() { return data ? data.points.slice() : []; },
    get objectCount() { return g.children.length; },   // teşhis (e2e)
    get group() { return g; },   // §26 radar/EO geçişlerinde geçici gizleme
  };
}
