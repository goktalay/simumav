// Operasyon: uçuş kartları (parkur preview.png + dronun dönen 3B'si + tarih + pilot + sonuç rozeti) → replay görünümü.
import * as api from '../core/api.js';
import { h, clear, svg, fmtDate, fmtDur } from '../core/dom.js';
import { t, lang } from '../i18n/i18n.js';
import { screen, miniBtn, toast, toastErr, confirmDlg, TRASH_SVG } from '../ui/components.js';
import { stagger } from '../ui/transition.js';
import { modelViewer } from '../hangar/index.js';

const MAX_VIEWERS = 6;

export async function mount(root, ctx) {
  const viewers = [];
  let replayCleanup = null, dead = false, gen = 0;
  if (ctx.param) { const { openReplay } = await import('./replay.js'); replayCleanup = await openReplay(root, ctx, ctx.param); return () => replayCleanup?.(); }

  const sc = screen({ title: t('ops.title'), sub: t('ops.sub'), cls: 'scroll' });
  const grid = h('div', { class: 'grid wide' });
  sc.append(grid);
  clear(root, sc);
  ctx.setBack(t('common.menu'));
  let flights = [];
  const load = async () => { try { flights = (await api.get('/api/ops')).flights || []; } catch (e) { toastErr(e); flights = []; } render(); };
  const remove = async f => { if (!await confirmDlg(t('ops.delete_q'), { danger: true })) return; try { await api.del(`/api/ops/${f.id}`); toast(t('common.deleted'), 'ok'); await load(); } catch (e) { toastErr(e); } };

  const card = (f, idx) => {
    const scene = h('div', { class: 'scene' }, h('img', { src: f.track?.preview_png || `/api/tracks/${f.track_id}/preview.png`, alt: '' }), h('span', { class: `badge ${f.result || ''}` }, t(`result.${f.result || 'ok'}`)));
    const d3 = h('div', { class: 'd3' }); scene.append(d3);
    const c = h('div', { class: 'card lift op-card', tabindex: '0', onclick: () => ctx.go('ops', String(f.id)), onkeydown: e => { if (e.key === 'Enter') ctx.go('ops', String(f.id)); } },
      scene,
      h('div', { class: 'info' },
        h('div', { class: 'row-actions' }, miniBtn(svg('0 0 24 24', TRASH_SVG), () => remove(f), 'danger', t('common.delete'))),
        h('b', {}, `${f.drone?.name || t('ops.drone')} · ${f.track?.name || t('ops.track')}`),
        h('small', { class: 'stamp' }, fmtDate(f.started_at, lang())),   // tarih "damga" animasyonu (fx.css .stamp)
        h('div', { class: 'meta' }, h('span', {}, `${t('crew.pilot')}: ${f.pilot?.name || '—'}`), h('span', {}, fmtDur(f.duration_s)), f.mission?.name ? h('span', {}, `${t('ops.mission')}: ${f.mission.name}`) : null, f.summary?.flight?.max_speed != null ? h('span', {}, `${Math.round(f.summary.flight.max_speed * 3.6)} km/h`) : null,
          f.summary?.defend ? h('span', { class: `badge ${f.summary.defend.success ? 'ok' : 'crash'}` }, `◈ ${f.summary.defend.score} · ${t(`site.rk_${f.summary.defend.rank || 'private'}`)}`) : null)));   // HEPGO §26 görev sonucu
    const g = gen;
    if (idx < MAX_VIEWERS) modelViewer(d3, { speed: 0.8, env: false }).then(v => { if (dead || g !== gen) { v.dispose(); return; } viewers.push(v); v.setModel({ ...f.drone, preview: f.drone?.preview }); }).catch(() => {});
    return c;
  };
  const render = () => {
    gen++; viewers.splice(0).forEach(v => v.dispose());
    if (!flights.length) { clear(grid, h('div', { class: 'empty' }, h('p', {}, t('ops.empty')), h('button', { class: 'btn primary lg', type: 'button', onclick: () => ctx.go('fly') }, t('menu.fly')))); return; }
    clear(grid, flights.map(card)); stagger([...grid.children], 50);
  };
  await load();
  return () => { dead = true; gen++; viewers.splice(0).forEach(v => v.dispose()); replayCleanup?.(); };
}
