// SIMUMAV tanıtım sitesi — Hangar galerisi: sistemdeki tanımlı dronların (fleet.js FLEET) dönen 3B modelleri.
// TEK WebGL bağlamı (stage.js): tek stüdyo sahnesi; her karo sırayla bu sahneye konup paylaşılan çiziciyle render edilir ve kendi 2B
// tuvaline kopyalanır. Yalnız ekranda görünen karolar render edilir (IntersectionObserver), kare başına en çok K karo (sıra ile ~20 fps);
// bölüm görünmezken döngü durur. Modeller tembel: karo ilk göründüğünde indirilir (en çok 3 eşzamanlı).
// Karo tıklanınca büyütülmüş görünüm (diyalog): sürükle/ok tuşlarıyla döndür, önceki/sonraki, Esc kapatır. Tür süzgeci (çipler).
// Dışa aktarım: initHangar(root, { t, lang, reduced, onOpen(id) }) → { start, refresh(lang), setTheme, open(id) }
import { THREE, renderTo, prepareModel, spinProps, studioEnv, isSmall } from './stage.js';
import { FLEET, specLine, isRotor } from './fleet.js';

const FIT = 2.2;
const TYPES = ['all', 'interceptor', 'plane', 'multirotor', 'vtol', 'heli', 'fpv'];

function el(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) { if (v == null || v === false) continue; if (k === 'class') e.className = v; else if (k.startsWith('on')) e.addEventListener(k.slice(2), v); else e.setAttribute(k, v === true ? '' : v); }
  for (const k of kids) if (k != null) e.append(k);
  return e;
}

function contactShadow() {   // yumuşak temas gölgesi (CanvasTexture; data: URL yok)
  const c = document.createElement('canvas'); c.width = c.height = 128;
  const g = c.getContext('2d'), gr = g.createRadialGradient(64, 64, 4, 64, 64, 62);
  gr.addColorStop(0, 'rgba(0,0,0,.55)'); gr.addColorStop(1, 'rgba(0,0,0,0)'); g.fillStyle = gr; g.fillRect(0, 0, 128, 128);
  const m = new THREE.Mesh(new THREE.PlaneGeometry(FIT * 1.3, FIT * 1.3), new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(c), transparent: true, depthWrite: false }));
  m.rotation.x = -Math.PI / 2;
  return m;
}

export function initHangar(root, { t = k => k, lang = 'tr', reduced = false, onOpen } = {}) {
  const grid = root.querySelector('.fleet-grid'), chips = root.querySelector('.fleet-chips');
  const small = isSmall(), K = small ? 3 : 5;
  // ---- stüdyo sahnesi (tek)
  const scene = new THREE.Scene();
  scene.environment = studioEnv(); scene.environmentIntensity = 0.9;
  scene.add(new THREE.HemisphereLight(0xdfeaff, 0x1a2030, 0.7));
  const key = new THREE.DirectionalLight(0xffffff, 2.2); key.position.set(4, 6, 5); scene.add(key);
  const rim = new THREE.DirectionalLight(0x19e6d2, 1.4); rim.position.set(-5, 2.5, -4); scene.add(rim);
  const shadow = contactShadow(); scene.add(shadow);
  const turn = new THREE.Group(); scene.add(turn);
  const camera = new THREE.PerspectiveCamera(30, 1.3, 0.05, 100);
  const aim = (cam, h, dist = 1) => { cam.position.set(FIT * 1.55 * dist, FIT * 0.62 * dist, FIT * 1.55 * dist); cam.lookAt(0, h * 0.1, 0); };

  // ---- karolar
  const tiles = FLEET.map((m, i) => {
    const cv = el('canvas', { 'aria-hidden': 'true' });
    const name = el('b', { class: 'fc-name' }, m.name), type = el('span', { class: 'fc-type', 'data-type': m.type }), spec = el('span', { class: 'fc-spec' });
    const btn = el('button', { type: 'button', class: 'fleet-card', 'data-id': m.id, 'data-type': m.type }, el('span', { class: 'fc-stage' }, cv, el('i', { class: 'fc-load', 'aria-hidden': 'true' })), el('span', { class: 'fc-meta' }, name, type, spec));
    const li = el('li', {}, btn);
    grid.append(li);
    const tile = { m, i, li, btn, cv, ctx: cv.getContext('2d'), type, spec, model: null, loading: false, visible: false, angle: i * 0.7, last: 0 };
    btn.addEventListener('click', () => open(i));
    return tile;
  });
  let queue = 0;
  const ensureModel = tile => {
    if (tile.model || tile.loading || queue >= 3) return;
    tile.loading = true; queue++;
    prepareModel(tile.m, { fit: FIT }).then(md => { tile.model = md; tile.li.classList.add('ready'); })
      .catch(() => { tile.failed = true; tile.li.classList.add('failed'); }).finally(() => { tile.loading = false; queue--; });
  };
  const io = new IntersectionObserver(es => { for (const e of es) { const tl = tiles.find(x => x.li === e.target); if (tl) tl.visible = e.isIntersecting; } schedule(); }, { rootMargin: '120px 0px' });
  tiles.forEach(tl => io.observe(tl.li));
  let sectionOn = false;
  const ioSec = new IntersectionObserver(([e]) => { sectionOn = e.isIntersecting; schedule(); }, { rootMargin: '200px 0px' });
  ioSec.observe(root);

  // ---- süzgeç çipleri
  let filter = 'all';
  const chipBtns = TYPES.map(ty => el('button', { type: 'button', class: 'chip', 'data-type': ty, 'aria-pressed': ty === 'all' ? 'true' : 'false', onclick: () => setFilter(ty) }));
  chips?.append(...chipBtns);
  function setFilter(ty) {
    filter = ty;
    chipBtns.forEach(b => b.setAttribute('aria-pressed', String(b.dataset.type === ty)));
    tiles.forEach(tl => { tl.li.hidden = ty !== 'all' && tl.m.type !== ty; });
    schedule();
  }

  function stageModel(md, angle, T, rotor) {
    while (turn.children.length) turn.remove(turn.children[0]);
    turn.add(md.root);
    md.root.rotation.set(0, angle, 0);
    md.root.position.y = rotor ? 0.08 * Math.sin(T * 1.7) : 0;
    shadow.position.y = -md.height / 2 - 0.05;
    spinProps(md.props, T * (rotor ? 30 : 24));
  }

  function renderTile(tl, T) {
    const r = tl.cv.getBoundingClientRect();
    if (r.width < 4 || !tl.model) return;
    stageModel(tl.model, tl.angle, T, isRotor(tl.m));
    aim(camera, tl.model.height);
    renderTo(tl.ctx, r.width, r.height, scene, camera, { pr: small ? 1 : 1.5, exposure: 1.1 });
  }

  // ---- büyütülmüş görünüm (diyalog)
  const dlg = document.getElementById('fleet-view');
  const vCv = dlg?.querySelector('canvas'), vCtx = vCv?.getContext('2d');
  let openIdx = -1, vAngle = 0, vSpin = true, drag = null, vZoom = 1, lastFocus = null;
  function fillView() {
    const tl = tiles[openIdx], m = tl.m;
    dlg.querySelector('.fv-name').textContent = m.name;
    dlg.querySelector('.fv-type').textContent = t(`type.${m.type}`);
    dlg.querySelector('.fv-spec').textContent = specLine(m, lang);
    dlg.querySelector('.fv-desc').textContent = t(`fleet.${m.id}.d`);
    dlg.querySelector('.fv-idx').textContent = `${String(openIdx + 1).padStart(2, '0')} / ${String(tiles.length).padStart(2, '0')}`;
    dlg.setAttribute('aria-label', m.name);
    if (!tl.model) ensureModel(tl);
  }
  function open(i) {
    if (!dlg) return;
    lastFocus = document.activeElement;
    openIdx = (i + tiles.length) % tiles.length; vAngle = -0.6; vSpin = !reduced; vZoom = 1;
    fillView();
    dlg.hidden = false; document.body.classList.add('modal-open');
    requestAnimationFrame(() => dlg.classList.add('in'));
    dlg.querySelector('.fv-close').focus();
    onOpen?.(tiles[openIdx].m.id);
    schedule(true);
  }
  function close() {
    if (!dlg || dlg.hidden) return;
    dlg.classList.remove('in'); dlg.hidden = true; document.body.classList.remove('modal-open'); openIdx = -1;
    lastFocus?.focus?.();
    schedule();
  }
  if (dlg) {
    dlg.querySelectorAll('[data-fv-close]').forEach(b => b.addEventListener('click', close));
    dlg.querySelector('.fv-prev').addEventListener('click', () => { openIdx = (openIdx - 1 + tiles.length) % tiles.length; fillView(); });
    dlg.querySelector('.fv-next').addEventListener('click', () => { openIdx = (openIdx + 1) % tiles.length; fillView(); });
    dlg.addEventListener('keydown', e => {
      if (e.key === 'Escape') { e.preventDefault(); close(); }
      else if (e.key === 'ArrowLeft') { vAngle -= 0.25; vSpin = false; e.preventDefault(); }
      else if (e.key === 'ArrowRight') { vAngle += 0.25; vSpin = false; e.preventDefault(); }
      else if (e.key === 'Tab') {   // odak tuzağı
        const f = [...dlg.querySelectorAll('button')].filter(b => !b.hidden);
        if (e.shiftKey && document.activeElement === f[0]) { f[f.length - 1].focus(); e.preventDefault(); }
        else if (!e.shiftKey && document.activeElement === f[f.length - 1]) { f[0].focus(); e.preventDefault(); }
      }
    });
    vCv.addEventListener('pointerdown', e => { drag = { x: e.clientX, a: vAngle }; vSpin = false; vCv.setPointerCapture(e.pointerId); });
    vCv.addEventListener('pointermove', e => { if (drag) vAngle = drag.a + (e.clientX - drag.x) * 0.01; });
    vCv.addEventListener('pointerup', () => { drag = null; });
    vCv.addEventListener('wheel', e => { e.preventDefault(); vZoom = Math.min(1.6, Math.max(0.6, vZoom * (e.deltaY > 0 ? 1.08 : 0.93))); }, { passive: false });
  }
  const vCam = new THREE.PerspectiveCamera(28, 1.5, 0.05, 100);

  // ---- döngü
  let raf = 0, last = performance.now(), T = 0, rr = 0;
  function frame(now) {
    raf = 0;
    const dt = Math.min(0.1, (now - last) / 1000); last = now;
    if (!reduced) T += dt;
    if (openIdx >= 0) {
      const tl = tiles[openIdx];
      if (vSpin) vAngle += dt * 0.45;
      if (tl.model) {
        const r = vCv.getBoundingClientRect();
        stageModel(tl.model, vAngle, T, isRotor(tl.m));
        aim(vCam, tl.model.height, 0.92 * vZoom);
        renderTo(vCtx, r.width, r.height, scene, vCam, { pr: 2, exposure: 1.1 });
        dlg.classList.add('ready');
      } else { dlg.classList.remove('ready'); ensureModel(tl); }
    } else if (sectionOn) {
      const vis = tiles.filter(tl => tl.visible && !tl.li.hidden && !tl.failed);
      vis.forEach(ensureModel);
      if (!reduced) for (const tl of vis) tl.angle += dt * 0.55;
      const ready = vis.filter(tl => tl.model && (!reduced || !tl.drawn));
      for (let k = 0; k < Math.min(K, ready.length); k++) { const tl = ready[(rr + k) % ready.length]; renderTile(tl, T); tl.drawn = true; }
      rr = ready.length ? (rr + K) % ready.length : 0;
    }
    schedule();
  }
  function schedule(force = false) {
    const busy = openIdx >= 0 || (sectionOn && tiles.some(tl => tl.visible && !tl.li.hidden && !tl.failed && (!tl.model || !reduced || !tl.drawn)));
    if ((busy || force) && !raf && !document.hidden) { last = performance.now(); raf = requestAnimationFrame(frame); }
  }
  document.addEventListener('visibilitychange', () => schedule());

  function refresh(l) {
    lang = l || lang;
    tiles.forEach(tl => {
      tl.type.textContent = t(`type.${tl.m.type}`); tl.spec.textContent = specLine(tl.m, lang);
      tl.btn.setAttribute('aria-label', `${tl.m.name} — ${t(`type.${tl.m.type}`)} · ${specLine(tl.m, lang)}`);
    });
    chipBtns.forEach(b => { b.textContent = t(b.dataset.type === 'all' ? 'hangar.all' : `type.${b.dataset.type}`); });
    if (openIdx >= 0) fillView();
  }
  function setTheme(th) {
    key.intensity = th === 'light' ? 2.6 : 2.2; rim.color.set(th === 'light' ? 0x9fc6ff : 0x19e6d2);
    tiles.forEach(tl => { tl.drawn = false; }); schedule();
  }
  refresh(lang);
  return { refresh, setTheme, open: id => { const i = tiles.findIndex(tl => tl.m.id === id); if (i >= 0) open(i); }, close, setFilter, info: () => ({ tiles: tiles.length, ready: tiles.filter(tl => tl.model).length, open: openIdx, filter }) };
}
