// Görevler: boşsa devasa "+"; akış: parkur seç (kartlar) → isim → tam ekran tasarım ekranı; kartlarda mini ön izleme (canvas).
import * as api from '../core/api.js';
import { h, clear, svg } from '../core/dom.js';
import { t } from '../i18n/i18n.js';
import { screen, plusButton, btn, miniBtn, toast, toastErr, confirmDlg, promptDlg, emptyState, EDIT_SVG, TRASH_SVG } from '../ui/components.js';
import { stagger } from '../ui/transition.js';
import { drawPreview } from './geo.js';

export async function mount(root, ctx) {
  let missions = [], tracks = [], edCleanup = null;
  const trackOf = m => tracks.find(x => x.id === m.track_id);

  async function list() {
    edCleanup?.(); edCleanup = null;
    const sc = screen({ title: t('missions.title'), sub: t('missions.sub'), cls: 'scroll' });
    clear(root, sc);
    ctx.setBack(t('common.menu'));
    try { [missions, tracks] = await Promise.all([api.get('/api/missions').then(r => r.missions || []), api.get('/api/tracks').then(r => r.tracks || [])]); } catch (e) { toastErr(e); }
    if (!missions.length) { sc.append(emptyState(t('missions.empty'), t('missions.new'), pickTrack)); return; }
    const grid = h('div', { class: 'grid' });
    const cards = missions.map(m => {
      const cv = h('canvas', { width: 320, height: 200 });
      const tr = trackOf(m);
      const c = h('div', { class: 'card lift strip-card mission-card', tabindex: '0' },
        h('div', { class: 'row-actions' }, miniBtn(svg('0 0 24 24', EDIT_SVG), () => rename(m), '', t('common.rename')), miniBtn(svg('0 0 24 24', TRASH_SVG), () => remove(m), 'danger', t('common.delete'))),
        h('div', { class: 'thumb' }, cv), h('b', {}, m.name),
        h('div', { class: 'meta-row' }, h('span', { class: 'badge accent' }, t(`kinds.${m.kind}`)), h('span', { class: 'badge' }, tr?.name || '—')),
        h('small', {}, m.kind === 'defend' ? `${t(`site.d_${m.plan?.defend?.difficulty || 'normal'}`)} · ${m.plan?.defend?.waves ?? 5} × ${t('site.waves').toLowerCase()} · ${m.plan?.defend?.interceptors ?? 10} interceptor` : `${m.plan?.route?.points?.length || 0} ${t('missions.points').toLowerCase()}`));   // HEPGO §26 savunma görevi
      c.addEventListener('click', e => { if (!e.target.closest('.row-actions')) edit(m); });
      requestAnimationFrame(() => drawPreview(cv, m.plan, tr));
      return c;
    });
    grid.append(...cards, h('div', { class: 'strip-card plus-holder' }, plusButton(t('missions.new'), pickTrack, { small: true })));
    stagger([...grid.children], 50);
    sc.append(grid);
  }
  const rename = async m => { const name = await promptDlg(t('common.rename'), { value: m.name }); if (!name) return; try { await api.put(`/api/missions/${m.id}`, { name }); toast(t('common.saved'), 'ok'); list(); } catch (e) { toastErr(e); } };
  const remove = async m => { if (!await confirmDlg(t('missions.delete_q', { name: m.name }), { danger: true })) return; try { await api.del(`/api/missions/${m.id}`); toast(t('common.deleted'), 'ok'); list(); } catch (e) { toastErr(e); } };

  // Adım 1: parkur seç
  async function pickTrack() {
    const sc = screen({ title: t('missions.pick_track'), sub: t('missions.pick_track_sub') });
    sc.append(h('div', { class: 'steps' }, h('i', { class: 'on' }), h('i'), h('i')));
    const grid = h('div', { class: 'grid' });
    if (!tracks.length) { try { tracks = (await api.get('/api/tracks')).tracks || []; } catch (e) { toastErr(e); } }
    const cards = tracks.map(tr => { const c = h('div', { class: 'card lift strip-card', tabindex: '0', onclick: () => askName(tr), onkeydown: e => { if (e.key === 'Enter') askName(tr); } },
      h('div', { class: 'thumb' }, h('img', { src: `/api/tracks/${tr.id}/preview.png`, alt: '' })), h('b', {}, tr.name),
      h('div', { class: 'meta-row' }, h('span', { class: 'badge accent' }, t(`world.${tr.world_mode || 'google3d'}`)), tr.gates?.length ? h('span', { class: 'badge' }, `${tr.gates.length} ${t('tracks.gates_short')}`) : null),
      h('small', {}, `${tr.radius_m} m`)); return c; });
    grid.append(...cards);
    if (!tracks.length) grid.append(h('p', { class: 'sub' }, t('missions.no_tracks')), btn(t('tracks.new'), () => ctx.go('tracks', 'new'), 'primary'));
    sc.append(grid, h('div', { class: 'btn-row' }, btn(t('common.cancel'), list, 'ghost')));
    sc.classList.add('scroll');
    clear(root, sc); ctx.setBack(t('missions.title'), 'missions');
    stagger(cards, 50); cards[0]?.focus();
  }
  // Adım 2: isim
  async function askName(tr) {
    const name = await promptDlg(t('missions.name'), { placeholder: t('missions.name_ph') });
    if (!name) return;
    openEd(tr, null, name);
  }
  // Adım 3: editör
  async function openEd(tr, m, name) {
    const { openEditor } = await import('./editor.js');
    edCleanup = await openEditor(root, ctx, { track: tr, mission: m, name, onCancel: list, onSave: async out => {
      if (m) await api.put(`/api/missions/${m.id}`, { kind: out.kind, plan: out.plan }); else await api.post('/api/missions', { track_id: tr.id, name, kind: out.kind, plan: out.plan });
      toast(t('common.saved'), 'ok'); list();
    } });
  }
  const edit = m => { const tr = trackOf(m); if (!tr) { toast(t('missions.track_missing'), 'err'); return; } openEd(tr, m, m.name); };

  await list();
  if (ctx.param === 'new') pickTrack();
  return () => edCleanup?.();
}
