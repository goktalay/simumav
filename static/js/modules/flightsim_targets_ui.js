// Uçuş Simülatörü — sihirbaz "Hedefler" bölümü (docs/ucus-simulatoru.md §24; HEPGO arayüzü). İsteğe bağlı: hedef eklenmezse oturum hedefsiz açılır.
// Her hedef: model (hedef modelleri + sistemdeki dron türleri; meta.targets.models), irtifa (m), yörünge çapı (m), hız (km/h; varsayılan modelin seyir
// hızı, azami = modelin azami hızı), yön (saat yönü / tersi), yörünge merkezi (uçuş merkezinden doğu/kuzey ofset, m). Ortak: önleme yarıçapı (m).
// `values()` → start gövdesi `targets` ({items, radius_m}) ya da undefined. ui.js içe aktarılmaz: `h`, `tr` parametre.
// §24.4 3B önizleme: `previews` (flightsim_tgtview.createTargetPreviews; sihirbazın dünya önizlemesiyle AYNI WebGL bağlamı) verilirse her kartta seçili
// modelin dönen 3B görüntüsü (sürükle/tekerlek), ölçek çubuğu, ad · seyir/azami hız · boyut. Önizleme öğesi hedef nesnesine bağlıdır (WeakMap): kartlar
// yeniden çizilince (yön/model değişimi) tuval taşınır, görüntü sıfırlanmaz.
import { DIAMETER, ALT, RADIUS, RADIUS_DEFAULT, TARGET_MAX, newTarget, validateTargets } from './flightsim_targets.js';
import { numSlider } from './fs_inputs.js';   // §6.1 görsel giriş: kaydırıcı + değer kutusu + birim

const num = (v, d = null) => (v == null || v === '' || Number.isNaN(Number(v)) ? d : Number(v));
const kmh = ms => Math.round(Number(ms) * 3.6);

export function createTargetsSection({ h, tr, catalog = [], limits = {}, onChange = () => {}, previews = null }) {
  const S = { items: [], radius: num(limits.radius_default, RADIUS_DEFAULT) };
  const modelOf = key => catalog.find(m => m.key === key) || null;
  const prevEl = new WeakMap();
  const previewOf = it => {
    if (!previews) return null;
    if (!prevEl.has(it)) prevEl.set(it, previews.attach(() => { const m = modelOf(it.model); return m ? { item: { model: m.key, glb_url: m.glb_url, orient: m.orient, has_prop: m.has_prop }, name: m.name, cruise_ms: m.cruise_ms, max_ms: m.max_ms } : null; }));
    return prevEl.get(it);
  };
  const list = h('div', { class: 'fs-tg-list' });
  const err = h('div', { class: 'small fs-tg-err', hidden: true });
  const addBtn = h('button', { type: 'button', class: 'btn sm fs-tg-add', onclick: () => {
    if (S.items.length >= TARGET_MAX) return;
    const m = catalog.find(c => c.source === 'target') || catalog[0];
    S.items.push(newTarget(m, S.items.length)); draw(); changed();
  } }, '+ ', tr('Hedef ekle'));
  const radSl = numSlider({ h, label: tr('Önleme yarıçapı'), value: S.radius, min: RADIUS[0], max: RADIUS[1], step: 1, unit: 'm', integer: true, cls: 'fs-tg-radius',
    onInput: v => { S.radius = v; changed(); } });
  const modelSelect = (it, onPick) => {
    const groups = [['target', tr('Hedef modelleri')], ['builtin', tr('Sistemdeki dron türleri')]];
    const sel = h('select', { class: 'input fs-tg-model', onchange: () => onPick(sel.value) },
      groups.map(([src, label]) => h('optgroup', { label }, catalog.filter(m => m.source === src).map(m => h('option', { value: m.key, selected: m.key === it.model ? true : undefined },
        `${m.name} · ${kmh(m.cruise_ms)}/${kmh(m.max_ms)} km/h`)))));
    return sel;
  };
  const row = (label, ctl, unit, hint) => h('label', { class: 'fs-tg-field' }, h('span', { class: 'fs-tg-lbl' }, tr(label)), h('span', { class: 'fs-tg-ctl' }, ctl, unit ? h('i', null, unit) : null), hint ? h('span', { class: 'small muted' }, hint) : null);
  // Sayısal alan → kaydırıcı (geniş aralıklar logaritmik); toUi/fromUi birim dönüşümü (hız: m/s ↔ km/h)
  const numSl = (it, key, label, min, max, step, unit, { scale = 'lin', hint = null, toUi = v => v, fromUi = v => v } = {}) => numSlider({ h, label: tr(label), value: toUi(it[key]), min, max, step, unit, scale, hint,
    onInput: v => { it[key] = fromUi(v); changed(); } }).el;
  function draw() {
    list.replaceChildren(...S.items.map((it, k) => {
      const m = modelOf(it.model);
      const spd = numSl(it, 'speed_ms', 'Hız', 1, m ? kmh(m.max_ms) : 1000, 1, 'km/h', { hint: m ? tr('seyir {c} · azami {x} km/h', { c: kmh(m.cruise_ms), x: kmh(m.max_ms) }) : null, toUi: v => kmh(v), fromUi: v => Math.round(v / 3.6 * 100) / 100 });
      const dirSeg = h('div', { class: 'seg fs-tg-dir' }, [['cw', '↻ ' + tr('Saat yönü')], ['ccw', '↺ ' + tr('Saat yönü tersi')]].map(([v, l]) =>
        h('button', { type: 'button', class: it.dir === v ? 'on' : '', onclick: () => { it.dir = v; draw(); changed(); } }, l)));
      const card = h('div', { class: 'fs-tg-card', 'data-target': k },
        h('div', { class: 'fs-tg-head' },
          h('span', { class: 'fs-tg-no' }, String(k + 1)),
          modelSelect(it, key => { it.model = key; const nm = modelOf(key); if (nm) it.speed_ms = nm.cruise_ms; draw(); changed(); }),
          h('button', { type: 'button', class: 'btn sm ghost fs-tg-del', title: tr('Hedefi kaldır'), onclick: () => { S.items.splice(k, 1); draw(); changed(); } }, '✕')),
        previewOf(it),
        m?.desc ? h('div', { class: 'small muted fs-tg-desc' }, m.desc) : null,
        h('div', { class: 'fs-tg-grid' },
          numSl(it, 'alt_m', 'İrtifa', ALT[0], ALT[1], 5, 'm', { scale: 'log' }),
          numSl(it, 'diameter_m', 'Yörünge çapı', DIAMETER[0], DIAMETER[1], 50, 'm', { scale: 'log' }),
          spd,
          row('Yön', dirSeg, null),
          numSl(it, 'east_m', 'Merkez doğu', -20000, 20000, 50, 'm'),
          numSl(it, 'north_m', 'Merkez kuzey', -20000, 20000, 50, 'm')),
        h('div', { class: 'small muted fs-tg-sum' }, summary(it, m)));
      return card;
    }));
    addBtn.disabled = S.items.length >= TARGET_MAX;
    empty.hidden = S.items.length > 0;
  }
  const summary = (it, m) => {
    const R = Number(it.diameter_m) / 2, v = Number(it.speed_ms), tur = R > 0 && v > 0 ? 2 * Math.PI * R / v : null, bank = R > 0 ? Math.atan(v * v / (R * 9.80665)) * 180 / Math.PI : 0;
    return tr('Tur süresi ≈ {t} sn · yatış {b}° · {m}', { t: tur ? Math.round(tur) : '—', b: Math.round(bank), m: m?.name || it.model });
  };
  const changed = () => {
    const e = S.items.length ? validateTargets(S.items, catalog, tr) : null;
    err.hidden = !e; err.textContent = e || '';
    list.querySelectorAll('.fs-tg-card').forEach((c, k) => { const it = S.items[k]; const s = c.querySelector('.fs-tg-sum'); if (s && it) s.textContent = summary(it, modelOf(it.model)); });
    onChange(values());
  };
  const empty = h('div', { class: 'small muted fs-tg-empty' }, tr('Hedef eklenmedi — uçuş hedefsiz açılır.'));
  const el = h('div', { class: 'card card-pad fs-step fs-targets no-collapse' },
    h('h3', null, h('span', { class: 'fs-no' }, '◎'), tr('Hedefler'), h('span', { class: 'badge gray' }, tr('isteğe bağlı'))),
    h('p', { class: 'small muted' }, tr('Simülasyonda havada sürekli uçan hedefler: her biri seçtiğiniz irtifada, verdiğiniz çapta dairesel yörüngede uçar (SITL\'siz, sunucuda kinematik; Mission Planner haritasında ADSB trafiği olarak görünür). Dronunuz bir hedefe önleme yarıçapı içinde yaklaşınca "önleme" sayılır; raporda sayı ve süre yer alır.')),
    empty, list,
    h('div', { class: 'fs-tg-foot' }, addBtn, radSl.el,
      h('span', { class: 'small muted' }, tr('En çok {n} hedef · çap {a}–{b} m · irtifa {c}–{d} m', { n: TARGET_MAX, a: DIAMETER[0], b: DIAMETER[1], c: ALT[0], d: ALT[1] }))),
    err);
  draw();
  function values() {
    if (!S.items.length) return undefined;
    return { items: S.items.map(it => ({ ...it })), radius_m: Math.min(RADIUS[1], Math.max(RADIUS[0], num(S.radius, RADIUS_DEFAULT))) };
  }
  // Önizleme/oturum için görsel bilgi (glb_url, orient, has_prop, model_name, i, name)
  const enriched = () => {
    const v = values();
    if (!v) return null;
    return { radius_m: v.radius_m, items: v.items.map((it, i) => { const m = modelOf(it.model) || {}; return { ...it, i, name: `${m.name || it.model} #${i + 1}`, model_name: m.name, glb_url: m.glb_url, orient: m.orient, has_prop: m.has_prop, kind: m.kind, type: m.type }; }) };
  };
  return { el, values, enriched, error: () => (S.items.length ? validateTargets(S.items, catalog, tr) : null), set: v => { const arr = Array.isArray(v) ? v : (v?.items || []); S.items = arr.map(x => ({ ...x })); if (v && !Array.isArray(v) && v.radius_m != null) { S.radius = num(v.radius_m, S.radius); radSl.set(S.radius); } draw(); changed(); } };   // §27: dizi ya da {items, radius_m}
}
