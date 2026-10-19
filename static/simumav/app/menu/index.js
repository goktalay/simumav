// Ana menü (AAA oyun menüsü): arka planda CANLI UÇUŞ SAHNESİ (menu/flight.js; ayardan kapatılabilir → eski yıldızlı dünya yok, sade vinyet),
// 6 modül kartı: kademeli yükselme + ışıma, fareye göre 3B eğilme (perspective tilt), gezen parlak kenar, animasyonlu SVG ikonlar,
// tıklamada basılma + ses + FLIP sahne geçişi (kart tam ekrana açılır), klavye/gamepad gezinme vurgusu.
import { h, clear } from '../core/dom.js';
import { t } from '../i18n/i18n.js';
import { stagger, rememberOrigin, reduced } from '../ui/transition.js';
import { icon } from './icons.js';
import * as sfx from '../ui/sfx.js';

const CARDS = [
  { key: 'hangar', accent: '#38bdf8' },
  { key: 'crew', accent: '#f472b6' },
  { key: 'tracks', accent: '#34d399' },
  { key: 'missions', accent: '#a78bfa' },
  { key: 'fly', accent: '#fbbf24' },
  { key: 'ops', accent: '#fb923c' },
];
export const bgEnabled = () => localStorage.getItem('sm:bgfx') !== '0';

/** Kart eğilme hesabı (saf): fare konumu (0..1) → rotateX/rotateY derece. */
export const tiltFor = (px, py, max = 9) => ({ rx: (0.5 - py) * 2 * max, ry: (px - 0.5) * 2 * max });

function menuCard(c, onPick) {
  const card = h('button', { class: 'card big-card mcard', type: 'button', dataset: { key: c.key } },
    h('span', { class: 'mcard-glow' }), h('span', { class: 'mcard-border' }),
    h('span', { class: 'ico' }, icon(c.key)),
    h('span', { class: 'name' }, t(`menu.${c.key}`)), h('span', { class: 'desc' }, t(`menu.${c.key}_desc`)),
    h('span', { class: 'mcard-cta' }, '▶'));
  card.style.setProperty('--ac', c.accent);
  // 3B eğilme + ışık noktası
  card.addEventListener('pointermove', e => {
    if (reduced()) return;
    const r = card.getBoundingClientRect(), px = (e.clientX - r.left) / r.width, py = (e.clientY - r.top) / r.height;
    const { rx, ry } = tiltFor(px, py);
    card.style.setProperty('--rx', `${rx.toFixed(2)}deg`); card.style.setProperty('--ry', `${ry.toFixed(2)}deg`);
    card.style.setProperty('--mx', `${(px * 100).toFixed(1)}%`); card.style.setProperty('--my', `${(py * 100).toFixed(1)}%`);
  });
  card.addEventListener('pointerenter', () => { card.classList.add('hot'); sfx.hover(); });
  card.addEventListener('pointerleave', () => { card.classList.remove('hot'); card.style.setProperty('--rx', '0deg'); card.style.setProperty('--ry', '0deg'); });
  card.addEventListener('focus', () => sfx.tick());
  card.addEventListener('click', () => {
    card.classList.add('pressed'); sfx.select();
    rememberOrigin(card);
    setTimeout(() => onPick(c.key), reduced() ? 0 : 110);
  });
  return card;
}

export async function mount(root, ctx) {
  const sc = h('div', { class: 'screen menu-screen' });
  const logo = h('img', { src: '/brand/simumav.svg', alt: 'SIMUMAV' });
  logo.addEventListener('error', () => { logo.src = '/app/img/icons/logo.svg'; }, { once: true });
  sc.append(h('div', { class: 'menu-logo' }, logo, h('h1', { class: 'title' }, 'SIMU', h('span', {}, 'MAV'))));
  const grid = h('div', { class: 'menu-grid', role: 'menu' });
  const cards = CARDS.map(c => menuCard(c, key => ctx.go(key)));
  grid.append(...cards); stagger(cards, 70, { rise: true });
  const live = h('div', { class: 'menu-live', hidden: true }, h('i', { class: 'dot' }), h('b', {}, t('menu.live')), h('small', {}, t('menu.live_loading')));
  const hint = h('p', { class: 'menu-hint' }, t('menu.hint'));
  sc.append(grid, live, hint);
  clear(root, sc);

  // Klavye: ok tuşları + Enter; Gamepad: d-pad / sol çubuk + A
  let focus = -1;
  // masaüstü: tek sıra 6 kart (fx.css); mobil 2 sütun
  const moveFocus = d => { const cols = window.innerWidth < 900 ? 2 : 6; const map = { r: 1, l: -1, d: cols, u: -cols }; focus = focus < 0 ? 0 : (focus + map[d] + cards.length) % cards.length; cards[focus].focus(); cards[focus].classList.add('hot'); cards.forEach((c, i) => i !== focus && c.classList.remove('hot')); };
  const onKey = e => {
    const map = { ArrowRight: 'r', ArrowLeft: 'l', ArrowDown: 'd', ArrowUp: 'u' };
    if (e.key in map) { moveFocus(map[e.key]); e.preventDefault(); }
    else if (e.key === 'Enter' && focus >= 0 && document.activeElement === cards[focus]) cards[focus].click();
  };
  document.addEventListener('keydown', onKey);
  cards.forEach((c, i) => c.addEventListener('focus', () => { focus = i; }));
  let padRaf = 0, padLast = 0, padHeld = false;
  const pollPad = () => {
    padRaf = requestAnimationFrame(pollPad);
    const gp = navigator.getGamepads?.()?.find(Boolean); if (!gp) return;
    const now = performance.now(), ax = gp.axes[0] || 0, ay = gp.axes[1] || 0;
    const dir = gp.buttons[15]?.pressed || ax > 0.6 ? 'r' : gp.buttons[14]?.pressed || ax < -0.6 ? 'l' : gp.buttons[13]?.pressed || ay > 0.6 ? 'd' : gp.buttons[12]?.pressed || ay < -0.6 ? 'u' : null;
    if (dir && now - padLast > 220) { padLast = now; moveFocus(dir); document.body.classList.add('gamepad'); }
    const a = gp.buttons[0]?.pressed;
    if (a && !padHeld && focus >= 0) cards[focus].click();
    padHeld = !!a;
  };
  if (navigator.getGamepads) padRaf = requestAnimationFrame(pollPad);

  // Arka plan: canlı uçuş sahnesi
  const canvas = document.getElementById('stage');
  let flight = null;
  if (bgEnabled()) {
    canvas.hidden = false; document.body.classList.add('bg-flight');
    const { mountFlightScene } = await import('./flight.js');
    flight = mountFlightScene(canvas, { onStatus: s => {
      if (s === 'ready') { live.hidden = false; const st = flight.stats(); live.querySelector('small').textContent = st.real ? t('menu.live_real') : t('menu.live_proc'); live.classList.add('on'); }
      if (s === 'error') { live.hidden = true; }
    } });
  } else { canvas.hidden = true; document.body.classList.remove('bg-flight'); }

  return () => {
    document.removeEventListener('keydown', onKey);
    cancelAnimationFrame(padRaf);
    flight?.dispose(); flight = null;
    (document.getElementById('stage') || canvas).hidden = true;
    document.body.classList.remove('bg-flight');
  };
}
