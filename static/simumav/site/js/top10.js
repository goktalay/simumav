// SIMUMAV tanıtım sitesi — TOP 10 PİLOT (docs/simumav.md §25). GET /api/leaderboard?period=30d|all (oturumsuz; sunucu maskeli ad + e-posta döner,
// 5 dk önbellek). Avatarlar oyunla AYNI prosedürel modül (/app/crew/avatar_mesh.js) + sitenin TEK paylaşılan WebGL bağlamı (stage.js renderTo):
// her satır bir kez 2B tuvale render edilir; 1. sıradaki pilot görünürken yavaşça döner (aynı bağlam). WebGL yoksa 2B yedek portre.
const API = '/api/leaderboard';
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const fmtPts = (n, lang = 'tr') => { try { return Math.round(Number(n) || 0).toLocaleString(lang); } catch { return String(Math.round(Number(n) || 0)); } };

let lib = null;
async function three() {
  if (lib) return lib;
  const [stage, mesh] = await Promise.all([import('./stage.js'), import('/app/crew/avatar_mesh.js')]);
  const { THREE } = stage;
  const scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera(28, 1, 0.05, 50);
  mesh.addAvatarLights(THREE, scene); mesh.framePortrait(camera);
  scene.environment = stage.studioEnv();
  lib = { stage, mesh, THREE, scene, camera };
  return lib;
}
const gl = () => { try { const c = document.createElement('canvas'); return !!(c.getContext('webgl2') || c.getContext('webgl')); } catch { return false; } };

/** Tek avatarı tuvale çiz (yaw: dönüş). */
async function paint(canvas, cfg, size, yaw = -0.18) {
  const ctx = canvas.getContext('2d');
  if (!gl()) { const { drawAvatar2D } = await import('/app/crew/avatar_mesh.js'); canvas.width = size; canvas.height = size; drawAvatar2D(ctx, cfg, size); return null; }
  const L = await three();
  const g = L.mesh.buildAvatar(L.THREE, cfg); g.rotation.y = yaw;
  L.scene.add(g);
  L.stage.renderTo(ctx, size, size, L.scene, L.camera, { pr: 2 });
  L.scene.remove(g);
  return g;
}

export function initTop10(root, { t = k => k, lang = () => 'tr', reduced = false, onView = () => {} } = {}) {
  const list = root.querySelector('[data-top10-list]'), podium = root.querySelector('[data-top10-podium]'), tabs = [...root.querySelectorAll('[data-top10-period]')];
  let period = '30d', data = {}, spin = null, raf = 0, visible = false, seq = 0;
  const stopSpin = () => { cancelAnimationFrame(raf); raf = 0; if (spin?.g) spin.g.userData.dispose(); spin = null; };
  const loop = now => {
    raf = 0;
    if (!spin || !visible || document.hidden) return;
    const L = lib, g = spin.g;
    g.rotation.y = -0.18 + Math.sin(now / 1600) * 0.6;
    L.scene.add(g); L.stage.renderTo(spin.ctx, spin.size, spin.size, L.scene, L.camera, { pr: 2 }); L.scene.remove(g);
    raf = requestAnimationFrame(loop);
  };
  const kick = () => { if (spin && visible && !raf && !reduced) raf = requestAnimationFrame(loop); };
  const empty = msg => { podium.innerHTML = ''; list.innerHTML = `<li class="t10-empty">${esc(msg)}</li>`; };
  async function render() {
    const my = ++seq;
    stopSpin();
    const rows = data[period];
    if (!rows) { empty(t('top10.loading')); return; }
    if (!rows.length) { empty(t('top10.empty')); return; }
    const top = rows.slice(0, 3), rest = rows.slice(3);
    const order = top.length === 3 ? [top[1], top[0], top[2]] : top;
    const card = (p, sz) => `<li class="t10-pd p${p.rank}" data-rank="${p.rank}"><canvas class="t10-av" width="${sz}" height="${sz}" aria-hidden="true"></canvas>
      <span class="t10-rk">${p.rank}</span><b class="t10-nm">${esc(p.name)}${p.demo ? `<em class="t10-demo" title="${esc(t('top10.demo_tip'))}">${esc(t('top10.demo'))}</em>` : ''}</b><small class="t10-em">${esc(p.email)}</small>
      <span class="t10-pts">${fmtPts(p.score, lang())} <small>${esc(t('top10.pts'))}</small></span>
      <small class="t10-sub">${esc(t('top10.wins').replace('{n}', p.wins ?? 0))} · ${esc(t('top10.flights').replace('{n}', p.flights ?? 0))}</small></li>`;
    podium.innerHTML = order.map(p => card(p, p.rank === 1 ? 220 : 160)).join('');
    list.innerHTML = rest.map(p => `<li class="t10-row" data-rank="${p.rank}"><span class="t10-rk">${p.rank}</span><canvas class="t10-av" width="64" height="64" aria-hidden="true"></canvas>
      <span class="t10-who"><b class="t10-nm">${esc(p.name)}${p.demo ? `<em class="t10-demo" title="${esc(t('top10.demo_tip'))}">${esc(t('top10.demo'))}</em>` : ''}</b><small class="t10-em">${esc(p.email)}</small></span>
      <span class="t10-pts">${fmtPts(p.score, lang())} <small>${esc(t('top10.pts'))}</small></span></li>`).join('');
    const jobs = [...podium.querySelectorAll('li'), ...list.querySelectorAll('li')].map(li => [li, rows.find(r => String(r.rank) === li.dataset.rank)]);
    for (const [li, p] of jobs) {
      if (my !== seq) return;
      const cv = li.querySelector('canvas'), sz = Number(cv.width);
      try {
        const g = await paint(cv, p.avatar, sz);
        if (p.rank === 1 && g) { spin = { g, ctx: cv.getContext('2d'), size: sz }; } else g?.userData.dispose();
      } catch { /* WebGL kaybı: tuval boş kalır */ }
    }
    kick();
  }
  async function load(p) {
    period = p;
    tabs.forEach(b => b.setAttribute('aria-selected', String(b.dataset.top10Period === p)));
    if (!data[p]) {
      render();
      try { const r = await fetch(`${API}?period=${p}`, { credentials: 'omit' }); if (!r.ok) throw new Error(r.status); data[p] = (await r.json()).pilots || []; }
      catch { empty(t('top10.error')); return; }
    }
    render();
  }
  tabs.forEach(b => b.addEventListener('click', () => { load(b.dataset.top10Period); onView(b.dataset.top10Period); }));
  if ('IntersectionObserver' in window) new IntersectionObserver(es => es.forEach(e => { visible = e.isIntersecting; kick(); })).observe(podium);
  else visible = true;
  document.addEventListener('visibilitychange', kick);
  document.addEventListener('simumav:lang', () => render());
  load(period);
  return { load, get data() { return data; }, get spinning() { return !!spin; } };
}
