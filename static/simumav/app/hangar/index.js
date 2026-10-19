// Hangar: ortada seçili dronun sürekli dönen 3B modeli; altta dron şeridi; devasa "+" → tür seçimi (yarış oyunu araç seçimi),
// model, renk, isim → kaydet → hangara iniş animasyonu.
import * as api from '../core/api.js';
import { h, clear, svg } from '../core/dom.js';
import { t } from '../i18n/i18n.js';
import { screen, plusButton, btn, miniBtn, hSelector, statsBars, toast, toastErr, confirmDlg, promptDlg, loading, EDIT_SVG, TRASH_SVG, STAR_SVG } from '../ui/components.js';
import { stagger } from '../ui/transition.js';
import { loadThree, makeStage, lights } from '../core/three.js';
import { buildDrone, animateDrone, loadGlb, TYPE_TEMPLATE } from './procmodels.js';
import * as sfx from '../ui/sfx.js';

export const TYPES = ['multirotor', 'plane', 'heli', 'vtol', 'fpv', 'interceptor'];
// hız / menzil / dayanıklılık / çeviklik (0–100)
const SPECS = { multirotor: [45, 40, 70, 65], plane: [70, 90, 60, 35], heli: [55, 50, 55, 60], vtol: [75, 85, 65, 45], fpv: [85, 25, 35, 100], interceptor: [100, 60, 40, 80] };
const COLORS = ['#38bdf8', '#a78bfa', '#34d399', '#fbbf24', '#f87171', '#f472b6', '#f8fafc', '#64748b', '#0ea5e9', '#f97316'];

/** Dönen tek model sahnesi; setModel(drone) ile değişir. */
export async function modelViewer(host, { speed = 0.6, env = true } = {}) {
  const lib = await loadThree();
  const { THREE } = lib;
  let model = null, hover = 0;
  const stage = makeStage(lib, host, { alpha: true, fov: 32, env, onFrame: (dt, tm) => { if (model) { model.rotation.y += dt * speed; model.position.y = Math.sin(tm * 1.3) * 0.04; animateDrone(model, dt, tm); } hover = tm; } });
  stage.camera.position.set(0, 0.9, 3.4); stage.camera.lookAt(0, 0, 0);
  lights(THREE, stage.scene);
  // zemin halkası (platform)
  const ring = new THREE.Mesh(new THREE.RingGeometry(1.1, 1.16, 64), new THREE.MeshBasicMaterial({ color: 0x38bdf8, transparent: true, opacity: 0.5, side: THREE.DoubleSide }));
  ring.rotation.x = -Math.PI / 2; ring.position.y = -0.95; stage.scene.add(ring);
  const ring2 = new THREE.Mesh(new THREE.RingGeometry(1.3, 1.31, 64), new THREE.MeshBasicMaterial({ color: 0xa78bfa, transparent: true, opacity: 0.3, side: THREE.DoubleSide }));
  ring2.rotation.x = -Math.PI / 2; ring2.position.y = -0.95; stage.scene.add(ring2);
  let setSeq = 0;
  const setModel = async d => {
    const seq = ++setSeq;
    let m = null;
    if (d?.glb || d?.preview) m = await loadGlb(lib, d.glb || d.preview, d?.color || null);   // gerçekçi GLB (accent materyali kullanıcı rengi)
    if (seq !== setSeq) return;   // bu arada başka model seçildi
    if (!m) m = buildDrone(THREE, d?.model_key, d?.color || '#38bdf8', d?.type);
    if (model) { stage.scene.remove(model); model = null; }
    model = m; stage.scene.add(model);
  };
  stage.start();
  return { setModel, dispose: () => stage.dispose(), stage };
}

// Modül düzeyinde etkin temizleyici: mount() içten yeniden çağrılabilir ("Hangara dön"); router hangi mount etkinse onu kapatır
let active = null;
export async function mount(root, ctx) {
  await active?.(); active = null;
  const sc = screen({ title: t('hangar.title'), sub: t('hangar.sub') });
  const stageBox = h('div', { class: 'model-stage' });
  const caption = h('div', { class: 'model-caption' });
  stageBox.append(caption);
  const strip = h('div', { class: 'strip' });
  sc.append(stageBox, strip);
  clear(root, sc);
  ctx.setBack(t('common.menu'));

  let drones = [], selected = null, viewer = null, catalog = null, wizDispose = null, dead = false, viewerWanted = true;
  const viewerP = modelViewer(stageBox).then(v => { if (dead || !viewerWanted) { v.dispose(); return; } viewer = v; if (selected) v.setModel(selected); }).catch(e => console.warn(e));

  // Model alt yazısı: sunucunun model_label'ı (GLB kataloğu / yükseltilmiş eski anahtar); yoksa prosedürel etiketi ya da anahtar
  const modelLabel = d => d?.model_label || (d?.model_key?.startsWith('proc:') ? t('hangar.proc_model') : d?.model_key || '');
  const select = d => {
    selected = d;
    clear(caption, h('h2', { class: 'title xl' }, d ? d.name : t('hangar.empty_title')), h('p', { class: 'sub' }, d ? `${t(`types.${d.type}`)} · ${modelLabel(d)}${d.airframe ? ` · ${t(`airframe.${d.airframe}`)}` : ''}` : t('hangar.empty_sub')));   // §13.1 düzen
    for (const c of strip.children) c.classList.toggle('sel', c.dataset.id === String(d?.id));
    viewer?.setModel(d);
  };

  const card = d => {
    const c = h('div', { class: 'card lift strip-card', tabindex: '0', role: 'button', dataset: { id: String(d.id) }, onclick: () => select(d), onkeydown: e => { if (e.key === 'Enter') select(d); } },
      h('div', { class: 'row-actions' },
        miniBtn(svg('0 0 24 24', STAR_SVG), () => setDefault(d), d.is_default ? 'on' : '', t('common.default')),
        miniBtn(svg('0 0 24 24', EDIT_SVG), () => rename(d), '', t('common.rename')),
        miniBtn(svg('0 0 24 24', TRASH_SVG), () => remove(d), 'danger', t('common.delete'))),
      h('div', { class: 'thumb' }, h('span', { class: 'badge', style: null }, t(`types.${d.type}`))),
      h('b', {}, d.name), h('small', {}, d.is_default ? `★ ${t('common.default')}` : modelLabel(d)), d.airframe ? h('small', { class: 'airframe-tag' }, t(`airframe.${d.airframe}`)) : null);   // §13.1
    const sw = h('i', { class: 'swatch on' }); sw.style.background = d.color || '#38bdf8'; sw.style.width = '22px'; sw.style.height = '22px';
    c.querySelector('.thumb').append(sw);
    c.addEventListener('pointerenter', () => sfx.takeoff());   // kart hover: kalkış sesi
    return c;
  };

  const renderStrip = () => {
    clear(strip, drones.map(card), plusButton(t('hangar.add'), openWizard, { small: true }));
    stagger([...strip.children], 50);
    if (!drones.find(d => d.id === selected?.id)) select(drones.find(d => d.is_default) || drones[0] || null);
    else select(drones.find(d => d.id === selected.id));
  };

  const load = async () => {
    try { drones = (await api.get('/api/hangar')).drones || []; } catch (e) { toastErr(e); drones = []; }
    renderStrip();
  };
  const rename = async d => { const name = await promptDlg(t('common.rename'), { value: d.name }); if (!name) return; try { await api.put(`/api/hangar/${d.id}`, { name }); toast(t('common.saved'), 'ok'); await load(); } catch (e) { toastErr(e); } };
  const remove = async d => { if (!await confirmDlg(t('hangar.delete_q', { name: d.name }), { danger: true })) return; try { await api.del(`/api/hangar/${d.id}`); toast(t('common.deleted'), 'ok'); await load(); } catch (e) { toastErr(e); } };
  const setDefault = async d => { try { await api.put(`/api/hangar/${d.id}`, { is_default: 1 }); await load(); } catch (e) { toastErr(e); } };

  // ---------- "+" sihirbazı ----------
  async function openWizard() {
    if (!catalog) { try { catalog = await api.get('/api/hangar/catalog'); } catch (e) { toastErr(e); catalog = { types: [] }; } }
    const wiz = h('div', { class: 'screen' });
    const head = h('header', { class: 'screen-head' }, h('h1', { class: 'title lg' }, t('hangar.new')), h('div', { class: 'steps' }, [0, 1, 2, 3].map(() => h('i'))));
    const body = h('div', { class: 'center-stack' });
    wiz.append(head, body);
    clear(root, wiz);
    ctx.setBack(t('hangar.title'), 'hangar');
    viewer?.dispose(); viewer = null; viewerWanted = false;   // sihirbazda ana dönen model yok (tek paylaşılan önizleme)
    const setStep = n => [...head.querySelectorAll('.steps i')].forEach((i, k) => { i.classList.toggle('on', k === n); i.classList.toggle('done', k < n); });
    // Türün varsayılan modeli: katalogdaki ilk model (gerçekçi GLB); katalog yoksa prosedürel şablon
    const firstModel = ty => (catalog.types || []).find(x => x.key === ty)?.models?.[0] || { key: `proc:${TYPE_TEMPLATE[ty]}`, glb: null };
    const draft = { type: 'fpv', model_key: firstModel('fpv').key, color: COLORS[0], name: '' };
    // Kontrol düzeni (HEPGO §13.1; drones.airframe): yalnız sabit kanat ailesinde; model değişince modelin düzeni (katalog `airframe`), kullanıcı değiştirebilir
    const AIRFRAMES = ['classic', 'elevon', 'vtail'];
    const needsAirframe = ty => ty === 'plane' || ty === 'interceptor';
    const modelAirframe = (ty, key) => (catalog.types || []).find(x => x.key === ty)?.models?.find(m => m.key === key)?.airframe || null;
    draft.airframe = null;   // null → sunucu modelin düzenini yazar

    // Adım 1: tür seçimi (yatay seçici + tek paylaşılan 3B önizleme)
    setStep(0);
    const prevHost = h('div', { class: 'model-stage' });
    let pv = null;
    const sel = hSelector(TYPES, {
      index: TYPES.indexOf(draft.type),
      render: ty => h('div', { class: 'card' }, h('div', { class: 'thumb-3d', dataset: { ty } }), h('h3', { class: 'title md' }, t(`types.${ty}`)), h('p', { class: 'sub' }, t(`types.${ty}_desc`)),
        statsBars([[t('spec.speed'), SPECS[ty][0]], [t('spec.range'), SPECS[ty][1]], [t('spec.endurance'), SPECS[ty][2]], [t('spec.agility'), SPECS[ty][3]]])),
      onChange: (ty, i, confirm) => { draft.type = ty; draft.model_key = firstModel(ty).key; place(ty); if (confirm) stepModel(); },
    });
    const place = ty => { const host = sel.querySelector(`.thumb-3d[data-ty="${ty}"]`); if (host && pv) { const fm = firstModel(ty); host.append(prevHost); pv.stage.resize(); pv.setModel({ type: ty, model_key: fm.key, glb: fm.glb, color: draft.color }); } };
    const selWrap = h('div', { class: 'hsel-wrap' }, sel);
    body.classList.add('wiz-select');
    clear(body, selWrap, h('div', { class: 'btn-row' }, btn(t('common.next'), () => stepModel(), 'primary lg')));
    let wizDead = false;
    modelViewer(prevHost, { speed: 0.9 }).then(v => { if (wizDead) { v.dispose(); return; } pv = v; place(draft.type); }).catch(() => {});
    sel.focus();

    function stepModel() {
      setStep(1);
      const typeCat = (catalog.types || []).find(x => x.key === draft.type);
      const models = typeCat?.models?.length ? typeCat.models : [{ key: `proc:${TYPE_TEMPLATE[draft.type]}`, label: t('hangar.proc_model') }];
      draft.model_key = models.find(m => m.key === draft.model_key) ? draft.model_key : models[0].key;
      const grid = h('div', { class: 'strip' });
      const stage3 = h('div', { class: 'model-stage' });
      const afBox = h('div', { class: 'airframe-box', hidden: !needsAirframe(draft.type) }, h('h3', { class: 'title md' }, t('airframe.title')), h('div', { class: 'strip airframe-strip' }));
      const paintAf = () => {
        const strip = afBox.querySelector('.airframe-strip'); const sug = modelAirframe(draft.type, draft.model_key); const cur = draft.airframe || sug || 'classic';
        clear(strip, AIRFRAMES.map(a => h('div', { class: `card lift strip-card airframe-card ${cur === a ? 'sel' : ''}`, tabindex: '0', dataset: { airframe: a }, onclick: () => { draft.airframe = a; paintAf(); } },
          h('b', {}, t(`airframe.${a}`)), h('small', {}, t(`airframe.${a}_desc`)), sug === a ? h('span', { class: 'badge accent' }, t('airframe.suggested')) : null)));
      };
      const paint = () => { for (const c of grid.children) c.classList.toggle('sel', c.dataset.key === draft.model_key); pv?.setModel({ type: draft.type, model_key: draft.model_key, color: draft.color, glb: models.find(m => m.key === draft.model_key)?.glb }); if (needsAirframe(draft.type)) paintAf(); };
      for (const m of models) grid.append(h('div', { class: 'card lift strip-card', tabindex: '0', dataset: { key: m.key }, onclick: () => { if (m.key !== draft.model_key) draft.airframe = null; draft.model_key = m.key; paint(); } },
        h('div', { class: 'thumb' }, m.thumb ? h('img', { src: m.thumb, alt: '' }) : h('span', { class: 'badge accent' }, m.key.startsWith('proc:') ? 'PROC' : 'GLB')), h('b', {}, m.label || m.key),
        m.airframe ? h('small', { class: 'airframe-tag' }, t(`airframe.${m.airframe}`)) : null));
      clear(body, stage3, grid, afBox, h('div', { class: 'btn-row' }, btn(t('common.back'), () => openWizard(), 'ghost'), btn(t('common.next'), () => stepColor(), 'primary lg')));
      if (pv) { stage3.append(prevHost); pv.stage.resize(); }
      paint();
    }
    function stepColor() {
      setStep(2);
      const stage3 = h('div', { class: 'model-stage' });
      const sw = h('div', { class: 'swatches' });
      const glb = (catalog.types || []).find(x => x.key === draft.type)?.models?.find(m => m.key === draft.model_key)?.glb || null;
      const paint = () => { for (const s of sw.children) s.classList.toggle('on', s.dataset.c === draft.color); pv?.setModel({ type: draft.type, model_key: draft.model_key, glb, color: draft.color }); };
      for (const c of COLORS) { const s = h('button', { class: 'swatch', type: 'button', dataset: { c }, 'aria-label': c, onclick: () => { draft.color = c; paint(); } }); s.style.background = c; sw.append(s); }
      const nameInp = h('input', { class: 'input big', placeholder: t('hangar.name_ph'), maxlength: '40', value: draft.name });
      nameInp.addEventListener('input', () => { draft.name = nameInp.value; });
      nameInp.addEventListener('keydown', e => { if (e.key === 'Enter') save(); });
      clear(body, stage3, h('h3', { class: 'title md' }, t('hangar.pick_color')), sw, h('div', { class: 'field' }, nameInp),
        h('div', { class: 'btn-row' }, btn(t('common.back'), () => stepModel(), 'ghost'), btn(t('common.save'), () => save(), 'primary lg')));
      if (pv) { stage3.append(prevHost); pv.stage.resize(); }
      paint(); nameInp.focus();
    }
    async function save() {
      const name = (draft.name || '').trim() || `${t(`types.${draft.type}`)}-${drones.length + 1}`;
      try {
        const d = await api.post('/api/hangar', { name, type: draft.type, model_key: draft.model_key, color: draft.color, airframe: needsAirframe(draft.type) ? (draft.airframe || modelAirframe(draft.type, draft.model_key) || 'classic') : undefined });   // §13.1 düzen
        setStep(3);
        // Hangara iniş animasyonu: model yukarıdan iner, yere değince toz halkası + ışık patlaması + iniş sesi
        const stage3 = h('div', { class: 'model-stage land-anim' }, h('span', { class: 'land-dust' }), h('span', { class: 'land-dust d2' }), h('span', { class: 'land-flash' }));
        sfx.takeoff(); setTimeout(() => sfx.land(), 650);
        clear(body, stage3, h('h2', { class: 'title xl appear' }, name), h('p', { class: 'sub appear' }, t('hangar.landed')),
          h('div', { class: 'btn-row appear' }, btn(t('hangar.to_hangar'), () => { wizDispose?.(); wizDispose = null; mount(root, ctx); }, 'primary lg'), btn(t('common.menu'), () => ctx.go('menu'), 'ghost')));
        if (pv) { stage3.append(prevHost); pv.stage.resize(); pv.setModel({ ...d, type: draft.type, model_key: draft.model_key, color: draft.color }); }
        toast(t('common.saved'), 'ok');
      } catch (e) { toastErr(e); }
    }
    wizDispose = () => { wizDead = true; pv?.dispose(); pv = null; };
  }

  await load();
  if (ctx.param === 'new') openWizard();
  // unmount: 3B görünümler (dönen model + sihirbaz önizlemesi) kesin bırakılır; router Promise'i bekler
  active = async () => { dead = true; viewer?.dispose(); viewer = null; wizDispose?.(); wizDispose = null; await viewerP; };
  return () => { const f = active; active = null; return f?.(); };
}
