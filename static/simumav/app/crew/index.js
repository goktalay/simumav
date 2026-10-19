// Mürettebat: pilot kartları (karakter SVG, isim, uçuş/saat), yeni pilot (10 karakter galerisi + isim), varsayılan seç, sil.
import * as api from '../core/api.js';
import { h, clear, svg } from '../core/dom.js';
import { t } from '../i18n/i18n.js';
import { screen, plusButton, btn, miniBtn, toast, toastErr, confirmDlg, promptDlg, modal, EDIT_SVG, TRASH_SVG, STAR_SVG } from '../ui/components.js';
import { stagger } from '../ui/transition.js';

const CHARS = Array.from({ length: 10 }, (_, i) => `p${String(i + 1).padStart(2, '0')}`);
const charSvg = (c, chars) => chars?.find(x => x.key === c)?.svg || `/app/img/pilots/${c}.svg`;

export async function mount(root, ctx) {
  const sc = screen({ title: t('crew.title'), sub: t('crew.sub') });
  const grid = h('div', { class: 'grid crew-grid' });
  sc.classList.add('scroll'); sc.append(grid);
  clear(root, sc);
  ctx.setBack(t('common.menu'));
  let pilots = [], chars = null;
  try { chars = (await api.get('/api/crew/characters')); chars = chars.characters || chars; } catch { chars = null; }

  const fmtH = v => `${(Number(v) || 0).toFixed(1)} ${t('common.h')}`;
  const card = p => h('div', { class: `card lift pilot-card ${p.is_default ? 'sel' : ''}`, tabindex: '0' },
    h('div', { class: 'row-actions' },
      miniBtn(svg('0 0 24 24', STAR_SVG), () => setDefault(p), '', t('common.default')),
      miniBtn(svg('0 0 24 24', EDIT_SVG), () => rename(p), '', t('common.rename')),
      miniBtn(svg('0 0 24 24', TRASH_SVG), () => remove(p), 'danger', t('common.delete'))),
    h('div', { class: 'face' }, h('img', { src: charSvg(p.character, chars), alt: '' })),
    h('b', {}, p.name),
    p.is_default ? h('span', { class: 'badge accent' }, t('crew.default_pilot')) : h('span', { class: 'badge' }, t('crew.pilot')),
    h('div', { class: 'meta' }, h('span', {}, h('b', {}, p.flights ?? 0), ` ${t('crew.flights')}`), h('span', {}, h('b', {}, fmtH(p.hours)))));

  const render = () => {
    const cards = pilots.map(card);
    clear(grid, cards, h('div', { class: 'pilot-card plus-holder' }, plusButton(t('crew.new'), openNew, { small: true })));
    stagger([...grid.children], 50);
  };
  const load = async () => { try { pilots = (await api.get('/api/crew')).pilots || []; } catch (e) { toastErr(e); pilots = []; } render(); };
  const rename = async p => { const name = await promptDlg(t('common.rename'), { value: p.name }); if (!name) return; try { await api.put(`/api/crew/${p.id}`, { name }); toast(t('common.saved'), 'ok'); await load(); } catch (e) { toastErr(e); } };
  const remove = async p => { if (!await confirmDlg(t('crew.delete_q', { name: p.name }), { danger: true })) return; try { await api.del(`/api/crew/${p.id}`); toast(t('common.deleted'), 'ok'); await load(); window.dispatchEvent(new Event('sm:session')); } catch (e) { toastErr(e); } };
  const setDefault = async p => { try { await api.put(`/api/crew/${p.id}`, { is_default: 1 }); await load(); } catch (e) { toastErr(e); } };

  function openNew() {
    let character = CHARS[1];
    const gal = h('div', { class: 'char-gallery' });
    const paint = () => { for (const c of gal.children) c.classList.toggle('sel', c.dataset.c === character); };
    for (const c of CHARS) gal.append(h('button', { class: 'char', type: 'button', dataset: { c }, 'aria-label': c, onclick: () => { character = c; paint(); } }, h('img', { src: charSvg(c, chars), alt: '' })));
    paint();
    const name = h('input', { class: 'input big', placeholder: t('crew.name_ph'), maxlength: '40' });
    modal({ title: t('crew.new'), wide: true, body: h('div', { class: 'center-stack tight' }, gal, name),
      actions: [{ label: t('common.cancel'), cls: 'ghost' }, { label: t('common.save'), cls: 'primary', onClick: async () => {
        const n = name.value.trim(); if (!n) { name.focus(); return false; }
        try { await api.post('/api/crew', { name: n, character }); toast(t('crew.welcome', { name: n }), 'ok'); await load(); window.dispatchEvent(new Event('sm:session')); } catch (e) { toastErr(e); return false; }
      } }] });
  }
  await load();
  if (ctx.param === 'new') openNew();
}
