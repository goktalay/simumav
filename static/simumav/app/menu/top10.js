// SIMUMAV §25 — oyun menüsü TOP 10 PİLOT penceresi: GET /api/leaderboard?period=30d|all (sunucu maskeli ad + e-posta; kimlik yok).
// Avatarlar paylaşılan çizici ile PNG'ye render edilir (avatar3d.js önbelleği; ayrı WebGL bağlamı açılmaz).
import * as api from '../core/api.js';
import { h, clear } from '../core/dom.js';
import { t } from '../i18n/i18n.js';
import { modal } from '../ui/components.js';
import { avatarImg, ensureAvatarCss } from '../crew/avatar3d.js';

export const fmtPts = n => Math.round(Number(n) || 0).toLocaleString();

export function top10Rows(list, el) {
  if (!list.length) { clear(el, h('li', { class: 'empty' }, t('top10.empty'))); return; }
  clear(el, list.map(p => h('li', { class: `r${p.rank}`, dataset: { rank: String(p.rank) } },
    h('span', { class: 'rk' }, String(p.rank)),
    avatarImg(p.avatar, { size: 128, alt: '' }),
    h('span', { class: 'who' }, h('b', null, p.name), h('small', null, p.email)),
    h('span', { class: 'pts' }, fmtPts(p.score), h('small', null, t('top10.wins_n', { n: p.wins ?? 0 }))))));
}

export function openTop10() {
  ensureAvatarCss();
  let period = '30d';
  const list = h('ol', { 'aria-live': 'polite' }, h('li', { class: 'empty' }, t('common.loading')));
  const tabs = h('div', { class: 'tabs', role: 'tablist' });
  const load = async () => {
    for (const b of tabs.children) { b.classList.toggle('on', b.dataset.p === period); b.setAttribute('aria-selected', String(b.dataset.p === period)); }
    try { const r = await api.get(`/api/leaderboard?period=${period}`); top10Rows(r.pilots || [], list); } catch { clear(list, h('li', { class: 'empty' }, t('top10.error'))); }
  };
  for (const p of ['30d', 'all']) tabs.append(h('button', { type: 'button', role: 'tab', dataset: { p }, onclick: () => { period = p; load(); } }, t(`top10.p_${p}`)));
  const body = h('div', { class: 'sm-top10' }, tabs, list, h('p', { class: 'note' }, t('top10.formula')), h('p', { class: 'note' }, t('top10.privacy')));
  const m = modal({ title: `🏆 ${t('top10.title')}`, body, wide: true, actions: [{ label: t('common.ok'), cls: 'primary' }] });
  m.box.classList.add('sm-top10-modal');
  load();
  return m;
}
