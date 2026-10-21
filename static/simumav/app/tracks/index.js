// Parkur: kartlar (dönen mini 3B arazi + neon halkalar), yeni/düzenle: konum (Google harita / koordinat + hazır konumlar),
// dünya kipi (Gerçek arazi · Google 3B · Prosedürel + HEPGO Dünya adımı alanları), rüzgâr kadranı, saat, hava, yarıçap, FPV halkaları editörü.
import * as api from '../core/api.js';
import { h, clear, svg } from '../core/dom.js';
import { t, lang } from '../i18n/i18n.js';
import { screen, plusButton, btn, miniBtn, segment, switchEl, range, dial, toast, toastErr, confirmDlg, EDIT_SVG, TRASH_SVG, STAR_SVG, CHEV_L, CHEV_R } from '../ui/components.js';
import { stagger } from '../ui/transition.js';
import { terrainViewer } from './terrain3d.js';
import { loadGoogleMaps, pickerMap } from './gmap.js';

export const WORLD_DEFAULTS = { size_m: 4000, tree_density: 0.3, building_count: 40, runway: true, runway_heading: 0, fog: 0.2 };
const WORLD_KEYS = ['seed', 'size_m', 'tree_density', 'mountain_height', 'mountain_count', 'building_count', 'runway', 'runway_heading', 'water', 'fog', 'landing_circle_m'];
export const PRESETS = [
  { name: 'TR TEST Kalecik', lat: 40.0990, lon: 33.4101 },
  { name: 'Ankara', lat: 39.9250, lon: 32.8370 },
  { name: 'İstanbul Hezarfen', lat: 41.2080, lon: 28.5520 },
  { name: 'İzmir Selçuk', lat: 37.9510, lon: 27.3290 },
  { name: 'Kapadokya', lat: 38.6430, lon: 34.8280 },
];
const WEATHER = ['clear', 'cloudy', 'fog', 'rain', 'snow'];   // bridge.WEATHER ile aynı (HEPGO §31: kar → yağış parçacıkları + zemin beyazlaması)
const MAX_VIEWERS = 6;
// Gerçek API (docs/simumav.md §3–§4): time_of_day 'day'|'dusk'|'night'; world yalnız WORLD_DEFAULTS alt kümesi (seed, size_m, tree_density, mountain_*, building_count,
// runway, runway_heading, water, fog, landing_circle_m); gates i 0..n-1 (görünümde i+1), radius 1–20, agl 1–120.
const TIMES = ['day', 'dusk', 'night'];
const normTime = v => (TIMES.includes(v) ? v : (Number.isFinite(Number(v)) ? (Number(v) < 6 || Number(v) >= 20 ? 'night' : Number(v) >= 17 ? 'dusk' : 'day') : 'day'));
const newTrack = () => ({ name: '', lat: PRESETS[0].lat, lon: PRESETS[0].lon, radius_m: 1500, wind: { speed_ms: 3, dir_deg: 270, gust: 1 }, time_of_day: 'day', weather: 'clear', world_mode: 'google3d', world: { ...WORLD_DEFAULTS }, gates: [] });

let active = null;   // etkin temizleyici (mount içten yeniden çağrılır: editör iptal/kaydet)
export async function mount(root, ctx) {
  await active?.(); active = null;
  const viewers = [];
  let dead = false, gen = 0;   // gen: kart listesi yenilenince bekleyen önizleme sözleri atılır
  const sc = screen({ title: t('tracks.title'), sub: t('tracks.sub'), cls: 'scroll' });
  const grid = h('div', { class: 'grid' });
  sc.append(grid);
  clear(root, sc);
  ctx.setBack(t('common.menu'));
  let tracks = [];

  const card = (tr, idx) => {
    const thumb = h('div', { class: 'thumb t3d' });
    const c = h('div', { class: 'card lift strip-card track-card', tabindex: '0' },
      h('div', { class: 'row-actions' },
        miniBtn(svg('0 0 24 24', STAR_SVG), () => setDefault(tr), '', t('common.default')),
        miniBtn(svg('0 0 24 24', EDIT_SVG), () => openEditor(tr), '', t('common.edit')),
        miniBtn(svg('0 0 24 24', TRASH_SVG), () => remove(tr), 'danger', t('common.delete'))),
      thumb, h('span', { class: 'wind-fx', 'aria-hidden': 'true' }, h('i'), h('i'), h('i')), h('b', {}, tr.name),   // rüzgâr çizgileri (fx.css; hız --ws)
      h('div', { class: 'meta-row' }, h('span', { class: 'badge accent' }, t(`world.${tr.world_mode || 'google3d'}`)), tr.gates?.length ? h('span', { class: 'badge' }, `${tr.gates.length} ${t('tracks.gates_short')}`) : null, tr.is_default ? h('span', { class: 'badge ok' }, t('common.default')) : null),
      h('small', {}, `${Number(tr.lat).toFixed(4)}, ${Number(tr.lon).toFixed(4)} · ${tr.radius_m} m · ${t('tracks.wind')} ${tr.wind?.speed_ms ?? 0} m/s · ${t(`weather.${tr.weather || 'clear'}`)}`));
    c.addEventListener('click', e => { if (!e.target.closest('.row-actions')) openEditor(tr); });
    c.style.setProperty('--ws', `${Math.max(1.2, 6 - Math.min(12, Number(tr.wind?.speed_ms) || 0) * 0.4).toFixed(1)}s`);   // rüzgâr hızı → çizgi akış süresi
    const g = gen;
    if (idx < MAX_VIEWERS) terrainViewer(thumb).then(v => { if (dead || g !== gen) { v.dispose(); return; } viewers.push(v); v.setTrack(tr); }).catch(() => thumb.append(h('img', { src: `/api/tracks/${tr.id}/preview.png`, alt: '' })));
    else thumb.append(h('img', { src: `/api/tracks/${tr.id}/preview.png`, alt: '' }));
    return c;
  };
  const render = () => {
    gen++; viewers.splice(0).forEach(v => v.dispose());
    clear(grid, tracks.map(card), h('div', { class: 'strip-card plus-holder' }, plusButton(t('tracks.new'), () => openEditor(null), { small: true })));
    stagger([...grid.children], 50);
  };
  const load = async () => { try { tracks = (await api.get('/api/tracks')).tracks || []; } catch (e) { toastErr(e); tracks = []; } render(); };
  const remove = async tr => { if (!await confirmDlg(t('tracks.delete_q', { name: tr.name }), { danger: true })) return; try { await api.del(`/api/tracks/${tr.id}`); toast(t('common.deleted'), 'ok'); await load(); } catch (e) { toastErr(e); } };
  const setDefault = async tr => { try { await api.put(`/api/tracks/${tr.id}`, { is_default: 1 }); await load(); } catch (e) { toastErr(e); } };

  // ---------- Editör ----------
  let edDispose = null;
  async function openEditor(existing) {
    gen++; viewers.splice(0).forEach(v => v.dispose());
    edDispose?.(); edDispose = null;
    const T = existing ? JSON.parse(JSON.stringify({ ...newTrack(), ...existing, time_of_day: normTime(existing.time_of_day), wind: { ...newTrack().wind, ...(existing.wind || {}) }, world: { ...WORLD_DEFAULTS, ...(existing.world || {}) }, gates: (existing.gates || []).map((g, i) => ({ ...g, i })) })) : newTrack();
    const ed = h('div', { class: 'screen track-editor' });
    const mapBox = h('div', { class: 'card ed-map' });
    const prevBox = h('div', { class: 'card ed-3d' });
    const panel = h('div', { class: 'card side-panel ed-panel' });
    ed.append(h('header', { class: 'screen-head' }, h('h1', { class: 'title lg' }, existing ? t('tracks.edit') : t('tracks.new'))), h('div', { class: 'ed-grid' }, h('div', { class: 'ed-left' }, mapBox, prevBox), panel));
    clear(root, ed);
    ctx.setBack(t('tracks.title'), 'tracks');

    let gmap = null, terrain = null, addMode = false;
    const dirty = () => { terrain?.setTrack(T); gmap?.setCenter(T.lat, T.lon, T.radius_m); gmap?.setGates(T.gates); gateListRender(); coordOut.textContent = `${T.lat.toFixed(5)}, ${T.lon.toFixed(5)}`; };

    // Konum
    const coordOut = h('b', {}, '');
    const latInp = h('input', { class: 'input', type: 'number', step: '0.0001', min: '-90', max: '90', value: T.lat });
    const lonInp = h('input', { class: 'input', type: 'number', step: '0.0001', min: '-180', max: '180', value: T.lon });
    const applyCoord = () => { const la = Number(latInp.value), lo = Number(lonInp.value); if (Number.isFinite(la) && Number.isFinite(lo)) { T.lat = la; T.lon = lo; dirty(); } };
    latInp.addEventListener('change', applyCoord); lonInp.addEventListener('change', applyCoord);
    const presetSel = h('select', { class: 'input' }, h('option', { value: '' }, t('tracks.presets')), PRESETS.map(p => h('option', { value: `${p.lat},${p.lon}` }, p.name)));
    presetSel.addEventListener('change', () => { if (!presetSel.value) return; const [la, lo] = presetSel.value.split(',').map(Number); T.lat = la; T.lon = lo; latInp.value = la; lonInp.value = lo; if (!T.name) { nameInp.value = PRESETS.find(p => p.lat === la)?.name || ''; T.name = nameInp.value; } dirty(); });
    const search = h('input', { class: 'input', placeholder: t('tracks.search_ph') });
    search.addEventListener('keydown', async e => { if (e.key !== 'Enter' || !gmap) return; try { const r = await gmap.geocode(search.value); if (r) { T.lat = r.lat; T.lon = r.lon; latInp.value = r.lat.toFixed(5); lonInp.value = r.lon.toFixed(5); dirty(); } else toast(t('tracks.not_found'), 'err'); } catch (err) { toastErr(err); } });

    // Form alanları
    const nameInp = h('input', { class: 'input big', placeholder: t('tracks.name_ph'), maxlength: '40', value: T.name });
    nameInp.addEventListener('input', () => { T.name = nameInp.value; });
    const procBox = h('div', { class: 'proc-box' });
    const worldSeg = segment([{ value: 'real', label: t('world.real') }, { value: 'google3d', label: t('world.google3d') }, { value: 'procedural', label: t('world.procedural') }], T.world_mode, v => { T.world_mode = v; procBox.hidden = v !== 'procedural'; if (v === 'real' && T.world.building_count === WORLD_DEFAULTS.building_count) T.world.building_count = 0; dirty(); });
    const sl = (key, label, min, max, step, fmt) => { const r = range({ min, max, step, value: T.world[key], format: fmt, onInput: v => { T.world[key] = v; dirty(); } }); return h('div', { class: 'field' }, h('label', {}, label, ' ', r.out), r.inp); };
    procBox.append(
      sl('size_m', t('world.size'), 1000, 10000, 500, v => `${v} m`),
      sl('tree_density', t('world.trees'), 0, 1, 0.05, v => `${Math.round(v * 100)}%`),
      sl('building_count', t('world.buildings'), 0, 200, 5, v => v),
      sl('fog', t('world.fog'), 0, 1, 0.05, v => `${Math.round(v * 100)}%`),
      h('div', { class: 'field row' }, h('label', {}, t('world.runway')), switchEl(T.world.runway !== false, v => { T.world.runway = v; dirty(); }, t('world.runway'))),
      sl('runway_heading', t('world.runway_heading'), 0, 359, 1, v => `${v}°`),
    );
    procBox.hidden = T.world_mode !== 'procedural';
    const windSpd = range({ min: 0, max: 30, step: 0.5, value: T.wind.speed_ms, format: v => `${v} m/s`, onInput: v => { T.wind.speed_ms = v; } });
    const windGust = range({ min: 0, max: 15, step: 0.5, value: T.wind.gust, format: v => `+${v} m/s`, onInput: v => { T.wind.gust = v; } });
    const windDial = dial({ value: T.wind.dir_deg, min: 0, max: 360, label: t('tracks.wind_dir'), unit: '°', onChange: v => { T.wind.dir_deg = Math.round(v) % 360; } });
    const todSeg = segment(TIMES.map(v => ({ value: v, label: t(`world.${v}`) })), T.time_of_day, v => { T.time_of_day = v; });
    const radius = range({ min: 200, max: 5000, step: 100, value: T.radius_m, format: v => `${v} m`, onInput: v => { T.radius_m = v; dirty(); } });
    const weatherSeg = segment(WEATHER.map(w => ({ value: w, label: t(`weather.${w}`) })), T.weather, v => { T.weather = v; });

    // Halkalar
    const gateList = h('div', { class: 'gate-list' });
    const addBtn = btn(t('tracks.add_gate'), () => { addMode = !addMode; addBtn.classList.toggle('primary', addMode); note.hidden = !addMode; }, '');
    const note = h('div', { class: 'map-note', hidden: true }, t('tracks.add_gate_hint'));
    const renumber = () => T.gates.forEach((g, i) => { g.i = i; });   // sunucu: i 0..n-1 (görünümde i+1)
    const addGate = ({ lat: la, lon: lo }) => { if (T.gates.length >= 50) { toast(t('tracks.gates_max'), 'err'); return; } T.gates.push({ i: T.gates.length, lat: la, lon: lo, agl_m: 10, yaw_deg: 0, radius_m: 5, kind: 'ring' }); dirty(); };
    const onPick = (p, isDrag) => { if (addMode) addGate(p); else { T.lat = p.lat; T.lon = p.lon; latInp.value = p.lat.toFixed(5); lonInp.value = p.lon.toFixed(5); dirty(); } };
    function gateListRender() {
      clear(gateList, T.gates.map((g, i) => {
        const num = (key, min, max, step, unit) => { const inp = h('input', { class: 'input sm', type: 'number', min, max, step, value: g[key] }); inp.addEventListener('change', () => { g[key] = Math.max(min, Math.min(max, Number(inp.value) || min)); inp.value = g[key]; terrain?.refreshGates(); }); return h('label', { class: 'gf' }, h('small', {}, unit), inp); };
        return h('div', { class: 'gate-row' },
          h('b', { class: 'gnum' }, String(g.i + 1)),
          num('agl_m', 1, 120, 1, 'AGL m'), num('yaw_deg', 0, 359, 1, '°'), num('radius_m', 1, 20, 0.5, 'R m'),
          h('button', { class: `mini-btn kind ${g.kind}`, type: 'button', title: t('tracks.kind'), onclick: () => { g.kind = g.kind === 'gate' ? 'ring' : 'gate'; dirty(); } }, g.kind === 'gate' ? '▭' : '◯'),
          miniBtn(svg('0 0 24 24', CHEV_L), () => { if (i > 0) { [T.gates[i - 1], T.gates[i]] = [T.gates[i], T.gates[i - 1]]; renumber(); dirty(); } }, '', t('common.up')),
          miniBtn(svg('0 0 24 24', CHEV_R), () => { if (i < T.gates.length - 1) { [T.gates[i + 1], T.gates[i]] = [T.gates[i], T.gates[i + 1]]; renumber(); dirty(); } }, '', t('common.down')),
          miniBtn(svg('0 0 24 24', TRASH_SVG), () => { T.gates.splice(i, 1); renumber(); dirty(); }, 'danger', t('common.delete')));
      }));
    }

    panel.append(
      h('div', { class: 'field' }, nameInp),
      h('h3', {}, t('tracks.location')), search, h('div', { class: 'two' }, latInp, lonInp), presetSel, h('div', { class: 'kv' }, h('span', {}, t('tracks.center')), coordOut),
      h('h3', {}, t('tracks.world_mode')), worldSeg, procBox,
      h('h3', {}, t('tracks.wind')), h('div', { class: 'wind-row' }, windDial, h('div', { class: 'col' }, h('div', { class: 'field' }, h('label', {}, t('tracks.wind_speed'), ' ', windSpd.out), windSpd.inp), h('div', { class: 'field' }, h('label', {}, t('tracks.gust'), ' ', windGust.out), windGust.inp))),
      h('div', { class: 'field' }, h('label', {}, t('tracks.time_of_day')), todSeg),
      h('div', { class: 'field' }, h('label', {}, t('tracks.weather')), weatherSeg),
      h('div', { class: 'field' }, h('label', {}, t('tracks.radius'), ' ', radius.out), radius.inp),
      h('h3', {}, t('tracks.gates')), h('p', { class: 'sub small' }, t('tracks.gates_hint')), addBtn, gateList,
      h('div', { class: 'btn-row' }, btn(t('common.cancel'), () => { edDispose?.(); edDispose = null; mount(root, ctx); }, 'ghost'), btn(t('common.save'), save, 'primary lg')),
    );
    ed.append(note);

    // Harita (Google) ya da yedek
    const key = ctx.state.meta?.maps_key;
    mapBox.append(h('div', { class: 'loading' }, t('common.loading')));
    try {
      const google = await loadGoogleMaps(key, lang());
      if (google) { clear(mapBox); gmap = await pickerMap(google, mapBox, { lat: T.lat, lon: T.lon, radius_m: T.radius_m, onPick, onGateMove: (g, p) => { g.lat = p.lat; g.lon = p.lon; dirty(); }, dark: document.documentElement.dataset.theme !== 'light' }); gmap.setGates(T.gates); }
      else clear(mapBox, h('div', { class: 'map-fallback' }, h('p', {}, t('tracks.no_maps')), h('img', { src: existing ? `/api/tracks/${existing.id}/preview.png` : '/app/img/icons/tracks.svg', alt: '' })));
    } catch (e) { clear(mapBox, h('div', { class: 'map-fallback' }, h('p', {}, e.message))); }
    let edDead = false;
    terrainViewer(prevBox, { spin: 0.15, onPick, tilt: 1.0 }).then(v => { if (edDead) { v.dispose(); return; } terrain = v; v.setTrack(T); }).catch(() => {});
    dirty();
    edDispose = () => { edDead = true; terrain?.dispose(); terrain = null; gmap?.dispose(); gmap = null; };

    async function save() {
      if (!T.name.trim()) { nameInp.focus(); toast(t('tracks.name_req'), 'err'); return; }
      renumber();
      const world = Object.fromEntries(WORLD_KEYS.filter(k => T.world[k] != null).map(k => [k, T.world[k]]));
      const body = { name: T.name.trim(), lat: T.lat, lon: T.lon, radius_m: T.radius_m, wind: T.wind, time_of_day: normTime(T.time_of_day), weather: T.weather, world_mode: T.world_mode, world, gates: T.gates };
      try {
        if (existing) await api.put(`/api/tracks/${existing.id}`, body); else await api.post('/api/tracks', body);
        toast(t('common.saved'), 'ok'); edDispose?.(); edDispose = null; mount(root, ctx);
      } catch (e) { toastErr(e); }
    }
  }

  await load();
  if (ctx.param === 'new') openEditor(null);
  active = () => { dead = true; gen++; viewers.splice(0).forEach(v => v.dispose()); edDispose?.(); edDispose = null; };
  return () => { const f = active; active = null; return f?.(); };
}
