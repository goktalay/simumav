// Mürettebat: pilot kartları (3B avatar görüntüsü, isim, uçuş/saat), yeni pilot / düzenle → 3B AVATAR DÜZENLEYİCİ (§25: dönen canlı önizleme,
// kask rengi, vizör rengi + aynalı, tulum rengi, ten tonu, yama + yama rengi, aksesuar, ad; "Zar" rastgele; eski 2B karakterler hazır başlangıç),
// varsayılan seç, sil. Avatar pilotla birlikte saklanır (POST/PUT /api/crew {avatar}).
import * as api from '../core/api.js';
import { h, clear, svg } from '../core/dom.js';
import { t } from '../i18n/i18n.js';
import { screen, plusButton, miniBtn, toast, toastErr, confirmDlg, modal, EDIT_SVG, TRASH_SVG, STAR_SVG } from '../ui/components.js';
import { stagger } from '../ui/transition.js';
import { ACCESSORIES, HELMET_COLORS, LEGACY, PATCHES, PATCH_COLORS, SKINS, SUIT_COLORS, VISOR_COLORS, avatarBody, legacy, normAvatar, randomAvatar } from './avatar_core.js';
import { drawPatch } from './avatar_mesh.js';
import { avatarImg, ensureAvatarCss, mountAvatarStage } from './avatar3d.js';

const CHARS = Object.keys(LEGACY);

export async function mount(root, ctx) {
  ensureAvatarCss();
  const sc = screen({ title: t('crew.title'), sub: t('crew.sub') });
  const grid = h('div', { class: 'grid crew-grid' });
  sc.classList.add('scroll'); sc.append(grid);
  clear(root, sc);
  ctx.setBack(t('common.menu'));
  let pilots = [];

  const fmtH = v => `${(Number(v) || 0).toFixed(1)} ${t('common.h')}`;
  const card = p => {
    const c = h('div', { class: `card lift pilot-card ${p.is_default ? 'sel' : ''}`, tabindex: '0', dataset: { pid: String(p.id) } },
      h('div', { class: 'row-actions' },
        miniBtn(svg('0 0 24 24', STAR_SVG), () => setDefault(p), '', t('common.default')),
        miniBtn(svg('0 0 24 24', EDIT_SVG), () => openEditor(p), '', t('avatar.edit')),
        miniBtn(svg('0 0 24 24', TRASH_SVG), () => remove(p), 'danger', t('common.delete'))),
      h('div', { class: 'face av3d' }, avatarImg(p.avatar, { size: 256, alt: '' })),
      h('b', {}, p.name),
      p.is_default ? h('span', { class: 'badge accent' }, t('crew.default_pilot')) : h('span', { class: 'badge' }, t('crew.pilot')),
      h('div', { class: 'meta' }, h('span', {}, h('b', {}, p.flights ?? 0), ` ${t('crew.flights')}`), h('span', {}, h('b', {}, fmtH(p.hours)))));
    c.addEventListener('dblclick', () => openEditor(p));
    c.addEventListener('keydown', e => { if (e.key === 'Enter' && e.target === c) openEditor(p); });
    return c;
  };

  const render = () => {
    const cards = pilots.map(card);
    clear(grid, cards, h('div', { class: 'pilot-card plus-holder' }, plusButton(t('crew.new'), () => openEditor(null), { small: true })));
    stagger([...grid.children], 50);
  };
  const load = async () => { try { pilots = (await api.get('/api/crew')).pilots || []; } catch (e) { toastErr(e); pilots = []; } render(); };
  const remove = async p => { if (!await confirmDlg(t('crew.delete_q', { name: p.name }), { danger: true })) return; try { await api.del(`/api/crew/${p.id}`); toast(t('common.deleted'), 'ok'); await load(); window.dispatchEvent(new Event('sm:session')); } catch (e) { toastErr(e); } };
  const setDefault = async p => { try { await api.put(`/api/crew/${p.id}`, { is_default: 1 }); await load(); } catch (e) { toastErr(e); } };

  async function openEditor(p) {
    const isNew = !p;
    let character = p?.character || CHARS[1];
    let A = normAvatar(p?.avatar, character);
    const name = h('input', { class: 'input big', placeholder: t('crew.name_ph'), maxlength: '40', value: p?.name || '', 'aria-label': t('avatar.name') });
    const view = h('div', { class: 'av-stage', 'aria-label': t('avatar.preview'), role: 'img' }, h('span', { class: 'av-hint' }, t('avatar.drag')));
    let live = null;
    const upd = () => { live?.set(A, name.value.trim()); paint(); };
    const sw = (key, colors) => {
      const row = h('div', { class: 'av-sw', role: 'radiogroup', 'aria-label': t(`avatar.${key}`) });
      const pick = h('input', { type: 'color', class: 'av-pick', value: A[key], title: t('avatar.custom'), 'aria-label': t('avatar.custom'),
        oninput: e => { A = { ...A, [key]: e.target.value.toLowerCase() }; upd(); } });
      for (const c of colors) row.append(h('button', { type: 'button', class: 'av-dot', cssVars: { c }, dataset: { k: key, v: c }, title: c, 'aria-label': c, onclick: () => { A = { ...A, [key]: c }; pick.value = c; upd(); } }));
      row.append(pick);
      return row;
    };
    const skins = h('div', { class: 'av-sw', role: 'radiogroup', 'aria-label': t('avatar.skin') },
      Object.entries(SKINS).map(([k, c]) => h('button', { type: 'button', class: 'av-dot skin', cssVars: { c }, dataset: { k: 'skin', v: k }, 'aria-label': `${t('avatar.skin')} ${k.slice(1)}`, onclick: () => { A = { ...A, skin: k }; upd(); } })));
    const patchIcon = kind => { const c = h('canvas', { width: 44, height: 44 }); drawPatch(c.getContext('2d'), kind, A.patch_color, 22, 22, 19); return c; };
    const patches = h('div', { class: 'av-opts', role: 'radiogroup', 'aria-label': t('avatar.patch') });
    const drawPatches = () => clear(patches, PATCHES.map(k => h('button', { type: 'button', class: `av-opt ${A.patch === k ? 'on' : ''}`, dataset: { k: 'patch', v: k }, title: t(`avatar.patch_${k}`), 'aria-label': t(`avatar.patch_${k}`),
      onclick: () => { A = { ...A, patch: k }; upd(); } }, k === 'none' ? h('span', { class: 'av-none' }, '∅') : patchIcon(k))));
    const accs = h('div', { class: 'av-opts txt', role: 'radiogroup', 'aria-label': t('avatar.accessory') },
      ACCESSORIES.map(k => h('button', { type: 'button', class: 'av-opt', dataset: { k: 'accessory', v: k }, onclick: () => { A = { ...A, accessory: k }; upd(); } }, t(`avatar.acc_${k}`))));
    const mirrorIn = h('input', { type: 'checkbox', onchange: e => { A = { ...A, mirror: e.target.checked }; upd(); } });
    mirrorIn.checked = !!A.mirror;
    const mirror = h('label', { class: 'av-toggle' }, mirrorIn, h('span', null, t('avatar.mirror')));
    const presets = h('div', { class: 'av-presets', role: 'radiogroup', 'aria-label': t('avatar.presets') },
      CHARS.map(c => h('button', { type: 'button', class: 'av-preset', dataset: { c }, title: c, 'aria-label': `${t('avatar.presets')} ${c}`,
        onclick: () => { character = c; A = legacy(c); syncInputs(); upd(); } }, h('img', { src: `/app/img/pilots/${c}.svg`, alt: '' }))));
    const field = (f, label, ...kids) => h('div', { class: 'av-field', dataset: { f } }, h('span', { class: 'av-lbl' }, label), ...kids);
    const form = h('div', { class: 'av-form' },
      field('name', t('avatar.name'), name),
      field('presets', t('avatar.presets'), presets),
      field('helmet', t('avatar.helmet'), sw('helmet', HELMET_COLORS)),
      field('visor', t('avatar.visor'), sw('visor', VISOR_COLORS), mirror),
      field('suit', t('avatar.suit'), sw('suit', SUIT_COLORS)),
      field('skin', t('avatar.skin'), skins),
      field('patch', t('avatar.patch'), patches),
      field('patch_color', t('avatar.patch_color'), sw('patch_color', PATCH_COLORS)),
      field('accessory', t('avatar.accessory'), accs));
    const dice = h('button', { type: 'button', class: 'btn ghost av-dice', onclick: () => { A = randomAvatar(); syncInputs(); upd(); } }, '🎲 ', t('avatar.random'));
    const box = h('div', { class: 'av-editor' }, h('div', { class: 'av-left' }, view, dice), form);
    function syncInputs() { for (const i of box.querySelectorAll('.av-pick')) { const k = i.closest('.av-field')?.dataset.f; if (k && A[k]) i.value = A[k]; } mirrorIn.checked = !!A.mirror; }
    function paint() {
      drawPatches();
      for (const b of box.querySelectorAll('[data-k]')) b.classList.toggle('on', String(A[b.dataset.k]) === b.dataset.v);
      const same = JSON.stringify(normAvatar(A)) === JSON.stringify(legacy(character));
      for (const b of presets.children) b.classList.toggle('on', same && b.dataset.c === character);
    }
    name.addEventListener('input', () => live?.set(A, name.value.trim()));
    const m = modal({ title: isNew ? t('crew.new') : t('avatar.edit_title', { name: p.name }), wide: true, body: box, onClose: () => { live?.dispose(); live = null; },
      actions: [{ label: t('common.cancel'), cls: 'ghost' }, { label: t('common.save'), cls: 'primary', onClick: async () => {
        const n = name.value.trim(); if (!n) { name.focus(); return false; }
        try {
          if (isNew) { await api.post('/api/crew', { name: n, character, avatar: avatarBody(A) }); toast(t('crew.welcome', { name: n }), 'ok'); }
          else { await api.put(`/api/crew/${p.id}`, { name: n, character, avatar: avatarBody(A) }); toast(t('common.saved'), 'ok'); }
          await load(); window.dispatchEvent(new Event('sm:session'));
        } catch (e) { toastErr(e); return false; }
      } }] });
    m.box.classList.add('av-modal');
    paint();
    try { live = await mountAvatarStage(view, A, { name: name.value.trim() }); } catch { view.append(avatarImg(A, { size: 256 })); }
    window.__smAvatarEditor = { get avatar() { return A; }, set: v => { A = normAvatar(v); syncInputs(); upd(); } };   // teşhis (Playwright)
  }
  await load();
  if (ctx.param === 'new') openEditor(null);
}
