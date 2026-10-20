// SIMUMAV › Uç — "HEDEFLER" adımı (HEPGO §24; docs/simumav.md §11) + uçuş içi skor rozeti + rapor kartı. Oyun tarzı kartlar; metinler `targets.*`
// i18n anahtarları (7 dil). Katalog GET /api/fly/targets (hedef GLB'leri + hangar GLB'leri; sınırlar). Kinematik/doğrulama HEPGO çekirdeğinin saf
// modülünden: /sim/flightsim_targets.js (targetState, validateTargets, newTarget, scoreOf).
// createTargetsStep({ h, t, catalog, limits, state, onChange }) → { el } · state: {items, radius_m} | null (wizard S.targets)
// createScoreBadge({ h, t }) → { el, update(state) } · targetsReportCard({ h, t, sum }) → el | null

const SIM = '/sim/';
let modP = null;
export const loadTargetsLib = () => (modP ??= import(`${SIM}flightsim_targets.js`));
const kmh = ms => Math.round(Number(ms) * 3.6);
// Çekirdek (flightsim_targets.validateTargets) Türkçe metinleri → SIMUMAV i18n anahtarları
const VMSG = { 'Hedef listesi geçersiz': 'targets.v_list', 'En çok 8 hedef': 'targets.v_max', 'bilinmeyen model': 'targets.v_model', 'irtifa 10–3000 m olmalı': 'targets.v_alt',
  'yörünge çapı 50–5000 m olmalı': 'targets.v_diameter', 'hız modelin azami hızını aşamaz': 'targets.v_speed', 'merkez ofseti ±20 km olmalı': 'targets.v_offset' };
const num = (v, d = null) => (v == null || v === '' || Number.isNaN(Number(v)) ? d : Number(v));

export async function createTargetsStep({ h, t, catalog = [], limits = {}, state = null, onChange = () => {} }) {
  const L = await loadTargetsLib();
  const S = { items: (state?.items || []).map(x => ({ ...x })), radius: num(state?.radius_m, num(limits.radius_default, L.RADIUS_DEFAULT)) };
  const modelOf = key => catalog.find(m => m.key === key) || null;
  const list = h('div', { class: 'sm-tg-list' });
  const err = h('div', { class: 'sm-tg-err', hidden: true });
  const empty = h('div', { class: 'sm-tg-empty' }, h('b', null, '◎'), h('span', null, t('targets.empty')));
  const emit = () => {
    const e = S.items.length ? L.validateTargets(S.items, catalog, s => t(VMSG[s] || s)) : null;   // çekirdek doğrulama metinleri → targets.v_* anahtarları
    err.hidden = !e; err.textContent = e || '';
    onChange(S.items.length ? { items: S.items.map(x => ({ ...x })), radius_m: S.radius } : null, e);
  };
  const field = (label, ctl, unit) => h('label', { class: 'sm-tg-field' }, h('span', null, t(label)), h('span', { class: 'sm-tg-ctl' }, ctl, unit ? h('i', null, unit) : null));
  const numInp = (it, key, min, max, step, toUi = v => v, fromUi = v => v) => {
    const el = h('input', { class: 'sm-tg-inp', type: 'number', min, max, step, value: toUi(it[key]), inputmode: 'decimal' });
    el.addEventListener('input', () => { const v = num(el.value); if (v != null) { it[key] = fromUi(v); emit(); draw(false); } });
    return el;
  };
  const sumText = (it, m) => {
    const R = Number(it.diameter_m) / 2, v = Number(it.speed_ms), lap = R > 0 && v > 0 ? Math.round(2 * Math.PI * R / v) : '—';
    return t('targets.lap', { s: lap, b: Math.round(Math.atan(v * v / (R * 9.80665)) * 180 / Math.PI), m: m?.name || it.model });
  };
  function draw(full = true) {
    if (!full) { list.querySelectorAll('.sm-tg-card').forEach((c, k) => { const it = S.items[k], s = c.querySelector('.sm-tg-sum'); if (it && s) s.textContent = sumText(it, modelOf(it.model)); }); return; }
    list.replaceChildren(...S.items.map((it, k) => {
      const m = modelOf(it.model);
      const sel = h('select', { class: 'sm-tg-model' }, [['target', 'targets.group_targets'], ['builtin', 'targets.group_system']].map(([src, label]) =>
        h('optgroup', { label: t(label) }, catalog.filter(c => c.source === src).map(c => h('option', { value: c.key, selected: c.key === it.model ? true : undefined }, `${c.name} · ${kmh(c.cruise_ms)}/${kmh(c.max_ms)} km/h`)))));
      sel.addEventListener('change', () => { it.model = sel.value; const nm = modelOf(sel.value); if (nm) it.speed_ms = nm.cruise_ms; emit(); draw(); });
      const dir = h('div', { class: 'sm-tg-dir' }, [['cw', '↻', 'targets.cw'], ['ccw', '↺', 'targets.ccw']].map(([v, ic, lb]) => {
        const b = h('button', { type: 'button', class: it.dir === v ? 'on' : '' }, ic, ' ', t(lb));
        b.addEventListener('click', () => { it.dir = v; emit(); draw(); });
        return b;
      }));
      const del = h('button', { type: 'button', class: 'sm-tg-del', title: t('targets.remove') }, '✕');
      del.addEventListener('click', () => { S.items.splice(k, 1); emit(); draw(); });
      return h('div', { class: 'sm-tg-card', 'data-target': String(k) },
        h('div', { class: 'sm-tg-head' }, h('span', { class: 'sm-tg-no' }, String(k + 1)), sel, del),
        h('div', { class: 'sm-tg-grid' },
          field('targets.alt', numInp(it, 'alt_m', L.ALT[0], L.ALT[1], 5), 'm'),
          field('targets.diameter', numInp(it, 'diameter_m', L.DIAMETER[0], L.DIAMETER[1], 50), 'm'),
          field('targets.speed', numInp(it, 'speed_ms', 1, m ? kmh(m.max_ms) : 1000, 1, v => kmh(v), v => Math.round(v / 3.6 * 100) / 100), 'km/h'),
          field('targets.dir', dir, null),
          field('targets.east', numInp(it, 'east_m', -20000, 20000, 50), 'm'),
          field('targets.north', numInp(it, 'north_m', -20000, 20000, 50), 'm')),
        h('div', { class: 'sm-tg-sum' }, sumText(it, m)));
    }));
    addBtn.disabled = S.items.length >= L.TARGET_MAX;
    empty.hidden = S.items.length > 0;
  }
  const addBtn = h('button', { type: 'button', class: 'btn primary sm-tg-add' }, '+ ', t('targets.add'));
  addBtn.addEventListener('click', () => { if (S.items.length >= L.TARGET_MAX) return; const m = catalog.find(c => c.source === 'target') || catalog[0]; S.items.push(L.newTarget(m, S.items.length)); emit(); draw(); });
  const rad = h('input', { class: 'sm-tg-inp', type: 'number', min: L.RADIUS[0], max: L.RADIUS[1], step: 1, value: S.radius });
  rad.addEventListener('input', () => { S.radius = Math.min(L.RADIUS[1], Math.max(L.RADIUS[0], num(rad.value, L.RADIUS_DEFAULT))); emit(); });
  const el = h('div', { class: 'sm-targets' },
    h('div', { class: 'sm-tg-intro' }, h('h2', null, '◎ ', t('targets.title')), h('p', { class: 'muted' }, t('targets.sub'))),
    empty, list,
    h('div', { class: 'sm-tg-foot' }, addBtn, field('targets.radius', rad, 'm'), h('span', { class: 'muted small' }, t('targets.limits', { n: L.TARGET_MAX }))),
    err);
  draw();
  emit();
  return { el, get value() { return S.items.length ? { items: S.items, radius_m: S.radius } : null; } };
}

const BADGE_ICON = { first: '◎', quick: '»', ace: '★', close: '✦', hunter: '✪' };   // yazı tipi bağımsız simgeler (emoji her cihazda yok)
/** Uçuş içi skor rozeti (üst çubuk): ◎ önlenen/toplam · puan; önlemede kısa parlama. */
export function createScoreBadge({ h, t }) {
  const el = h('span', { class: 'badge sm-tg-score', title: t('targets.score_title') }, '◎ 0/0 · 0');
  let prev = -1;
  return {
    el,
    update(st) {
      if (!st) { el.hidden = true; return; }
      el.hidden = false;
      el.textContent = `◎ ${st.hit_targets}/${st.count} · ${st.score ?? 0} ${t('targets.pts')}`;
      if (prev >= 0 && (st.score ?? 0) > prev) { el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash'); }
      prev = st.score ?? 0;
    },
  };
}

/** Rapor kartı (oyun tarzı): büyük puan + rozetler + hedef satırları. */
export function targetsReportCard({ h, t, sum }) {
  const T = sum?.targets;
  if (!T || !T.count) return null;
  return h('div', { class: 'sm-tg-report' },
    h('div', { class: 'sm-tg-rep-head' }, h('b', { class: 'sm-tg-rep-score' }, String(T.score ?? 0)), h('span', null, t('targets.pts_long')),
      h('span', { class: 'sm-tg-rep-hit' }, t('targets.hit', { h: T.hit_targets, n: T.count, t: T.total }))),
    T.badges?.length ? h('div', { class: 'sm-tg-badges' }, T.badges.map(b => h('span', { class: `sm-tg-badge b-${b}` }, BADGE_ICON[b] || '★', ' ', t(`targets.badge_${b}`)))) : null,
    h('div', { class: 'sm-tg-rows' }, T.items.map(d => h('div', { class: `sm-tg-row ${d.intercepts ? 'hit' : ''}` }, h('b', null, `${d.i + 1}`), h('span', null, d.name),
      h('span', { class: 'mono' }, d.intercepts ? t('targets.row_hit', { n: d.intercepts, s: d.first_s, m: d.min_dist_m }) : t('targets.row_miss', { m: d.min_dist_m }))))));
}
