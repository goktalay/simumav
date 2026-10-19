// Uçuş Simülatörü — "Simülasyon Kayıtları" tablosu (docs/ucus-simulatoru.md §21): her oturumun kapanışında yazılan drone_sim_runs satırları.
// Kullanıcı isteği: "Yapılan uçuşların kayıtları Simülasyon altında tablo şeklinde olsun; tarihe göre, konuma göre ve benzeri seçim yapabilelim …
// kayıtları oynatabilelim; ama sadece master kullanıcısı script ve parametreleri download edebilsin, bu düğmeler yalnız master kullanıcısına görünsün."
// Geri bildirim (§21 sekmeler): "çok fazla filtre: tarihi 'son 1 gün / 1 hafta / 1 ay' yapalım; Tarih ile 'Detaylı' düğmesi aynı kapsülde; Detaylı'ya
// tıklarsa küçük bir kutu açılsın, diğerlerini orada seçsin. Her satırda Oynat / Rapor / Video bir kapsülde; yalnız master'da kırmızı 'Download' düğmesi,
// tıklayınca açılır liste neyi indirecekse listelesin."
// Sütunlar: tarih/saat · kullanıcı · dron tipi/model · merkez/konum · dünya kipi · kalkış yöntemi · süre · sonuç (ÇARPIŞMA kırmızı / Tamam yeşil / Hata)
// · ekler (video, .bin, parametre, script simgeleri) · işlemler: kapsül [Oynat · Rapor · Video] (pasifler soluk; video yoksa gizli) + MASTER: kırmızı
// **Download ▾** menüsü (.bin / .param / scripts.zip / video / rapor yazdır; olmayanlar pasif; sunucu uçları da 403) + Sil simgesi (can_delete).
// Filtre çubuğu: kapsül [Son 1 gün · 1 hafta · 1 ay · Tümü | Detaylı(•n)] + sağda kayıt sayısı; Detaylı → açılır kutu (tarih aralığı, merkez, tip,
// kullanıcı, sonuç, kaynak, arama; Uygula / Temizle). Sıralama sütun başlığından; 25'li sayfalama.
// Dışa: runsTable({ be, tr, canWrite, user, onPlay, onReport }) → { el, refresh }

import { clear, confirmDialog, fmtDateTime, fmtDuration, h, modal, toast, toastError } from '../ui.js';
import { launchLabel } from './flightsim_launch.js';
import { layoutShort } from './flightsim_airframe.js';   // §13.1 kontrol düzeni sütunu (Detaylı)

const TYPE_NAME = { multirotor: 'Multikopter', hexarotor: 'Hexakopter', helikopter: 'Helikopter', sabit_kanat: 'Sabit Kanat', vtol: 'VTOL' };

const API = '/api/drone/sim/runs';
const WORLD_MODE = { real: 'Gerçek arazi', google3d: 'Google 3B', procedural: 'Prosedürel' };
const RESULT = { tamam: ['green', 'Tamam'], carpisma: ['red', 'ÇARPIŞMA'], hata: ['orange', 'Hata'] };
const END_REASON = { kapatildi: 'Bitir', bosta: 'boşta kapandı', sure: 'süre doldu', sunucu_kapaniyor: 'sunucu kapandı' };
const COLS = [['started_at', 'Tarih / saat'], ['owner', 'Kullanıcı'], ['type', 'Dron tipi / model'], ['center', 'Merkez / konum'], [null, 'Dünya'], [null, 'Kalkış'],
  ['duration_s', 'Süre'], ['result', 'Sonuç'], [null, 'Ekler'], [null, '']];
// §23 "Detaylı" kipte ek sütunlar (Detaylı kutusundaki onay; localStorage fs.runs.power): Yakıt (harcanan L · ölçülen km/L) · Batarya (Wh · ortalama W)
const POWER_COLS = [[null, 'Yakıt'], [null, 'Batarya']];
const KEY_POWER_COLS = 'fs.runs.power';
// §13.1 "Detaylı" kipte Düzen sütunu (kontrol düzeni: Klasik / Elevon / V-kuyruk; localStorage fs.runs.layout) — Kalkış'tan sonra
const LAYOUT_COL = [null, 'Düzen'];
const KEY_LAYOUT_COL = 'fs.runs.layout';
export const fuelCell = r => (r?.fuel_used_l == null ? '—' : `${Number(r.fuel_used_l).toFixed(2)} L${r.fuel_km_per_l != null ? ` · ${Number(r.fuel_km_per_l).toFixed(1)} km/L` : ''}`);
export const elecCell = r => (r?.elec_wh == null ? '—' : `${Number(r.elec_wh).toFixed(1)} Wh${r.elec_w_avg != null ? ` · ${Number(r.elec_w_avg).toFixed(0)} W` : ''}`);
// Hızlı tarih kapsülü: anahtar → gün sayısı (0 = Tümü). Varsayılan 1 hafta.
const PERIODS = [['1d', 'Son 1 gün', 1], ['7d', '1 hafta', 7], ['30d', '1 ay', 30], ['all', 'Tümü', 0]];
const DETAIL_KEYS = ['center_id', 'type', 'owner_id', 'result', 'mode', 'q'];
const isoDay = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const sinceDays = n => { const d = new Date(); d.setDate(d.getDate() - n); return isoDay(d); };
const ico = body => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
export const RUN_ICON = {
  video: ico('<rect x="3" y="6" width="13" height="12" rx="2"/><path d="M16 10l5-3v10l-5-3z"/>'),
  bin: ico('<path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4"/><path d="M9 13h6M9 17h6"/>'),
  params: ico('<path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0"/><circle cx="16" cy="6" r="2"/><circle cx="10" cy="12" r="2"/><circle cx="18" cy="18" r="2"/>'),
  script: ico('<path d="M8 4l-4 8 4 8M16 4l4 8-4 8M13 3l-2 18"/>'),
  report: ico('<path d="M5 3h10l4 4v14H5z"/><path d="M15 3v4h4"/><path d="M8 12h8M8 16h5"/>'),
  play: ico('<path d="M7 4l12 8-12 8z"/>'),
  trash: ico('<path d="M4 7h16M9 7V4h6v3M6 7l1 14h10l1-14"/>'),
  download: ico('<path d="M12 4v11M7 10l5 5 5-5M4 19h16"/>'),
  print: ico('<path d="M7 8V3h10v5M5 8h14a2 2 0 0 1 2 2v6h-4v4H7v-4H3v-6a2 2 0 0 1 2-2z"/>'),
};

// Açılır kutu (popover): çapaya göre belgeye sabit konumda (fixed) — tablo kaydırma kutusu kesmesin. Dışarı tıklama / Escape / kaydırma kapatır.
// Aynı anda tek kutu açık kalır. Dönen nesne: { el, close }.
let OPEN_POP = null;
export function popover(anchor, content, { cls = '', align = 'left', width } = {}) {
  OPEN_POP?.close();
  const el = h('div', { class: `fs-pop ${cls}`.trim(), role: 'dialog' }, content);
  if (width) el.style.width = `${width}px`;
  document.body.append(el);
  const place = () => {
    const r = anchor.getBoundingClientRect(), w = el.offsetWidth, hh = el.offsetHeight;
    let left = align === 'right' ? r.right - w : r.left;
    left = Math.max(8, Math.min(left, window.innerWidth - w - 8));
    let top = r.bottom + 6;
    if (top + hh > window.innerHeight - 8 && r.top - hh - 6 > 8) top = r.top - hh - 6;
    el.style.left = `${Math.round(left)}px`; el.style.top = `${Math.round(top)}px`;
  };
  place();
  const onDoc = e => { if (!el.contains(e.target) && !anchor.contains(e.target)) close(); };
  const onKey = e => { if (e.key === 'Escape') { e.stopPropagation(); close(); anchor.focus?.(); } };
  const onScroll = e => { if (!el.contains(e.target)) place(); };
  const close = () => {
    if (OPEN_POP?.el !== el) return;
    OPEN_POP = null; el.remove(); anchor.classList.remove('open'); anchor.setAttribute('aria-expanded', 'false');
    document.removeEventListener('pointerdown', onDoc, true); document.removeEventListener('keydown', onKey, true);
    window.removeEventListener('scroll', onScroll, true); window.removeEventListener('resize', place);
  };
  setTimeout(() => { document.addEventListener('pointerdown', onDoc, true); }, 0);
  document.addEventListener('keydown', onKey, true);
  window.addEventListener('scroll', onScroll, true); window.addEventListener('resize', place);
  anchor.classList.add('open'); anchor.setAttribute('aria-expanded', 'true');
  OPEN_POP = { el, close };
  return OPEN_POP;
}

export function runsTable({ be, tr, canWrite = false, user = null, onPlay = null, onReport = null } = {}) {
  const master = !!user?.master;
  // Sorgu durumu: period (hızlı kapsül; 'custom' = Detaylı kutusundan elle tarih aralığı) → from/to; diğerleri Detaylı kutusundan.
  const F = { from: sinceDays(7), to: '', center_id: '', type: '', owner_id: '', result: '', mode: '', q: '', sort: '-started_at', page: 1 };
  let period = '7d';
  let powerCols = (() => { try { return localStorage.getItem(KEY_POWER_COLS) === '1'; } catch { return false; } })();   // §23 yakıt/batarya sütunları
  let layoutCol = (() => { try { return localStorage.getItem(KEY_LAYOUT_COL) === '1'; } catch { return false; } })();   // §13.1 düzen sütunu
  let data = { items: [], total: 0, page: 1, pages: 1, facets: { centers: [], owners: [], types: [] } };
  let facets = { centers: [], owners: [], types: [] };
  const tableBox = h('div', { class: 'fs-runs-table' });
  const pager = h('div', { class: 'fs-runs-pager small muted' });
  const count = h('span', { class: 'fs-runs-count small muted' });

  // ---------- filtre kapsülü: Son 1 gün · 1 hafta · 1 ay · Tümü | Detaylı(•n) ----------
  const detailCount = () => DETAIL_KEYS.filter(k => F[k] !== '').length + (period === 'custom' ? 1 : 0);
  const detailBadge = h('span', { class: 'fs-runs-dn', 'aria-hidden': 'true' });
  const detailBtn = h('button', { class: 'btn sm fs-runs-detail', type: 'button', 'data-f': 'detail', 'aria-haspopup': 'dialog', 'aria-expanded': 'false',
    title: tr('Ayrıntılı filtreler: tarih aralığı, merkez, tip, kullanıcı, sonuç, kaynak, arama'), onclick: () => openDetail() }, tr('Detaylı'), detailBadge);
  const periodBtns = PERIODS.map(([k, label]) => h('button', { class: `btn sm ${period === k ? 'on' : ''}`, type: 'button', 'data-period': k, onclick: () => setPeriod(k) }, tr(label)));
  const pill = h('div', { class: 'pill-group fs-runs-pill' }, periodBtns, h('span', { class: 'fs-runs-sep', 'aria-hidden': 'true' }), detailBtn);
  const syncPill = () => {
    periodBtns.forEach(b => b.classList.toggle('on', b.dataset.period === period));
    const n = detailCount();
    detailBadge.textContent = n ? String(n) : '';
    detailBtn.classList.toggle('on', n > 0);
  };
  const setPeriod = k => {
    period = k; const days = PERIODS.find(p => p[0] === k)?.[2] ?? 0;
    F.from = days ? sinceDays(days) : ''; F.to = ''; F.page = 1;
    syncPill(); refresh();
  };
  const filters = h('div', { class: 'fs-runs-filters' }, pill, count);

  // ---------- Detaylı kutusu: değerler Uygula'ya kadar bekler; Temizle hepsini sıfırlar (kapsül 1 haftaya döner) ----------
  const openDetail = () => {
    const D = { ...F };
    const opt = (v, l) => h('option', { value: v }, l);
    const selOf = (key, allText, opts, fmt) => h('select', { class: 'input sm', 'data-f': key }, opt('', tr(allText)), opts.map(o => opt(String(o.id ?? o), fmt(o))));
    const fromInp = h('input', { class: 'input sm', type: 'date', 'data-f': 'from', value: period === 'custom' ? D.from : '' });
    const toInp = h('input', { class: 'input sm', type: 'date', 'data-f': 'to', value: D.to });
    const centerSel = selOf('center_id', 'Tüm merkezler', facets.centers || [], c => `${c.name || '—'} (${c.n})`);
    const typeSel = selOf('type', 'Tüm tipler', facets.types || [], t => tr(TYPE_NAME[t] || t));
    const ownerSel = selOf('owner_id', 'Tüm kullanıcılar', facets.owners || [], o => `${o.name || '—'} (${o.n})`);
    const resultSel = selOf('result', 'Tüm sonuçlar', [['tamam', 'Tamam'], ['carpisma', 'ÇARPIŞMA'], ['hata', 'Hata']].map(([id, l]) => ({ id, l })), o => tr(o.l));
    const modeSel = selOf('mode', 'Canlı + kayıt', [['sitl', 'Canlı simülasyon'], ['replay', 'Kayıttan oynatma']].map(([id, l]) => ({ id, l })), o => tr(o.l));
    const qInp = h('input', { class: 'input sm', type: 'search', 'data-f': 'q', value: D.q, placeholder: tr('Ara: model, log adı, merkez, kullanıcı, oturum no') });
    const powerCb = h('input', { type: 'checkbox', 'data-f': 'power_cols', checked: powerCols, onchange: () => { powerCols = powerCb.checked; try { localStorage.setItem(KEY_POWER_COLS, powerCols ? '1' : '0'); } catch { /* */ } draw(); } });   // §23: anında uygulanır
    const layoutCb = h('input', { type: 'checkbox', 'data-f': 'layout_col', checked: layoutCol, onchange: () => { layoutCol = layoutCb.checked; try { localStorage.setItem(KEY_LAYOUT_COL, layoutCol ? '1' : '0'); } catch { /* */ } draw(); } });   // §13.1: anında uygulanır
    [centerSel, typeSel, ownerSel, resultSel, modeSel].forEach(s => { s.value = D[s.dataset.f] || ''; if (s.value !== (D[s.dataset.f] || '')) s.value = ''; });
    const row = (label, ...ctrls) => h('label', { class: 'fs-pop-row' }, h('span', { class: 'small muted' }, tr(label)), h('span', { class: 'fs-pop-ctl' }, ctrls));
    const apply = () => {
      const from = fromInp.value, to = toInp.value;
      if (from || to) { period = 'custom'; F.from = from; F.to = to; }
      else if (period === 'custom') { period = '7d'; F.from = sinceDays(7); F.to = ''; }
      [centerSel, typeSel, ownerSel, resultSel, modeSel, qInp].forEach(c => { F[c.dataset.f] = c.value.trim(); });
      F.page = 1; pop.close(); syncPill(); refresh();
    };
    const clearAll = () => { DETAIL_KEYS.forEach(k => { F[k] = ''; }); pop.close(); setPeriod('7d'); };
    const pop = popover(detailBtn, h('div', { class: 'fs-runs-detail-box' },
      h('div', { class: 'fs-pop-title' }, tr('Ayrıntılı filtre')),
      row('Tarih aralığı', fromInp, h('span', { class: 'muted' }, '–'), toInp),
      row('Merkez / konum', centerSel), row('Dron tipi', typeSel), row('Kullanıcı', ownerSel), row('Sonuç', resultSel), row('Kaynak', modeSel),
      row('Arama', qInp),
      h('label', { class: 'check fs-pop-check' }, powerCb, tr('Yakıt / batarya sütunları'), h('span', { class: 'small muted' }, tr('harcanan yakıt ve ölçülen km/L · batarya Wh ve ortalama W'))),
      h('label', { class: 'check fs-pop-check' }, layoutCb, tr('Düzen sütunu'), h('span', { class: 'small muted' }, tr('Kontrol düzeni: Klasik / Elevon / V-kuyruk (sabit kanat)'))),   // §13.1
      h('div', { class: 'fs-pop-foot' },
        h('button', { class: 'btn sm', type: 'button', 'data-act': 'clear', onclick: clearAll }, tr('Temizle')),
        h('button', { class: 'btn sm primary', type: 'button', 'data-act': 'apply', onclick: apply }, tr('Uygula')))), { cls: 'fs-runs-pop', width: 340 });
    qInp.addEventListener('keydown', e => { if (e.key === 'Enter') apply(); });
    setTimeout(() => (period === 'custom' ? fromInp : centerSel).focus(), 0);
  };

  const fillFacets = f => { facets = { centers: f.centers || [], owners: f.owners || [], types: f.types || [] }; };

  const attachments = r => h('span', { class: 'fs-runs-att' },
    r.has_video ? h('span', { class: 'fs-runs-ico on', title: tr('Ekran kaydı (video)'), html: RUN_ICON.video }) : null,
    r.bin_log_id ? h('span', { class: `fs-runs-ico on ${r.play_log_id ? '' : 'wait'}`, title: r.play_log_id ? tr('.bin uçuş logu (analiz tamam)') : tr('.bin uçuş logu (analiz sürüyor)'), html: RUN_ICON.bin }) : null,
    r.has_params ? h('span', { class: 'fs-runs-ico on', title: tr('{n} parametre', { n: r.params_count }), html: RUN_ICON.params }) : null,
    r.has_scripts ? h('span', { class: 'fs-runs-ico on', title: tr('{n} script', { n: r.scripts_count }), html: RUN_ICON.script }) : null,
    !(r.has_video || r.bin_log_id || r.has_params || r.has_scripts) ? h('span', { class: 'muted' }, '—') : null);

  const videoDialog = r => {
    const src = `${API}/${r.id}/video`;
    const v = h('video', { class: 'fs-runs-video', src, controls: true, preload: 'metadata', playsinline: true });
    modal({ title: tr('Ekran kaydı'), body: h('div', null, h('div', { class: 'small muted', style: { marginBottom: '8px' } }, [fmtDateTime(r.started_at), r.center_name, r.owner_name].filter(Boolean).join(' · ')), v),
      wide: true, actions: [{ label: tr('İndir'), onClick: () => { const a = h('a', { href: `${src}?dl=1`, download: '' }); document.body.append(a); a.click(); a.remove(); return true; } }, 'spacer', { label: tr('Kapat') }] });
  };

  // ---------- satır işlemleri: kapsül [Oynat · Rapor · Video] + MASTER: Download ▾ (menü) + Sil simgesi ----------
  const dlMenu = (btn, r) => {
    const item = (label, icon, { href, download, onclick, enabled, title }) => enabled
      ? (href ? h('a', { class: 'fs-dl-item', role: 'menuitem', href, download: download || '', title: title || '', onclick: () => pop.close() }, h('span', { class: 'fs-runs-bi', html: icon }), label)
        : h('button', { class: 'fs-dl-item', role: 'menuitem', type: 'button', title: title || '', onclick: () => { pop.close(); onclick(); } }, h('span', { class: 'fs-runs-bi', html: icon }), label))
      : h('button', { class: 'fs-dl-item', role: 'menuitem', type: 'button', disabled: true, 'aria-disabled': 'true', title: tr('Bu kayıtta yok') }, h('span', { class: 'fs-runs-bi', html: icon }), label);
    const pop = popover(btn, h('div', { class: 'fs-dl-menu', role: 'menu', 'aria-label': tr('İndir') },
      item(tr('Uçuş logu (.bin)'), RUN_ICON.bin, { href: `${API}/${r.id}/bin`, download: r.bin_file_name || '', enabled: !!r.bin_log_id, title: r.bin_file_name || '' }),
      item(tr('Parametreler (.param)'), RUN_ICON.params, { href: `${API}/${r.id}/params`, enabled: !!r.has_params, title: tr('Son parametre dökümü (.param) — yalnız MASTER') }),
      item(tr('Script arşivi (.zip)'), RUN_ICON.script, { href: `${API}/${r.id}/scripts`, enabled: !!r.has_scripts, title: tr('SITL scripts/ içeriği (zip) — yalnız MASTER') }),
      item(tr('Video (.webm)'), RUN_ICON.video, { href: `${API}/${r.id}/video?dl=1`, enabled: !!r.has_video }),
      item(tr('Rapor (yazdır)'), RUN_ICON.print, { enabled: !!(r.has_summary && onReport), onclick: async () => { try { await onReport?.(r); setTimeout(() => window.print(), 700); } catch (err) { toastError(err); } } })),
    { cls: 'fs-runs-pop', align: 'right' });
    pop.el.querySelector('.fs-dl-item:not([disabled])')?.focus();
  };
  const actions = r => {
    const btn = (label, icon, attrs, cls = '') => h('button', { class: `btn xs ${cls}`, type: 'button', ...attrs }, h('span', { class: 'fs-runs-bi', html: icon }), label);
    const playOk = !!(r.play_log_id && onPlay && canWrite);
    const dl = master ? h('button', { class: 'btn xs danger fs-runs-dl', type: 'button', 'data-act': 'download', 'aria-haspopup': 'menu', 'aria-expanded': 'false',
      title: tr('İndir: .bin, parametreler, script arşivi, video, rapor — yalnız MASTER'), onclick: e => dlMenu(e.currentTarget, r) },
      h('span', { class: 'fs-runs-bi', html: RUN_ICON.download }), 'Download', h('span', { class: 'fs-runs-caret', 'aria-hidden': 'true' }, '▾')) : null;
    return h('div', { class: 'fs-runs-actions' },
      h('div', { class: 'pill-group fs-runs-rowpill' },
        btn(tr('Oynat'), RUN_ICON.play, { disabled: !playOk, 'data-act': 'play', title: r.play_log_id ? tr('Kayıttan oynat kipinde aç') : tr('Oynatılabilir .bin yok (kayıt kapalıydı ya da analiz sürüyor)'), onclick: () => onPlay?.(r) }, playOk ? 'primary' : ''),
        btn(tr('Rapor'), RUN_ICON.report, { disabled: !r.has_summary, 'data-act': 'report', title: r.has_summary ? tr('Özet raporu aç') : tr('Özet rapor yok'), onclick: async () => { try { await onReport?.(r); } catch (err) { toastError(err); } } }),
        r.has_video ? btn(tr('Video'), RUN_ICON.video, { 'data-act': 'video', title: tr('Ekran kaydını izle'), onclick: () => videoDialog(r) }) : null),
      dl,
      r.can_delete ? h('button', { class: 'icon-btn xs fs-runs-del', type: 'button', 'data-act': 'del', title: tr('Kaydı sil'), 'aria-label': tr('Kaydı sil'), html: RUN_ICON.trash, onclick: async () => {
        if (!await confirmDialog(tr('Kaydı sil'), tr('Simülasyon kaydı ve parametre/script dosyaları silinir; özet rapor, .bin uçuş logu ve video kendi yerlerinde kalır.'), { okLabel: tr('Sil'), danger: true })) return;
        try { await be.runDelete(r.id); toast(tr('Kayıt silindi')); refresh(); } catch (err) { toastError(err); }
      } }) : null);
  };

  const draw = () => {
    let cols = powerCols ? [...COLS.slice(0, 8), ...POWER_COLS, ...COLS.slice(8)] : COLS;   // §23: Sonuç'tan sonra Yakıt · Batarya
    if (layoutCol) cols = [...cols.slice(0, 6), LAYOUT_COL, ...cols.slice(6)];   // §13.1: Kalkış'tan sonra Düzen
    const head = h('tr', null, cols.map(([key, label]) => {
      if (!key) return h('th', null, tr(label));
      const active = F.sort.replace(/^-/, '') === key;
      const desc = F.sort.startsWith('-');
      return h('th', { class: `sortable ${active ? 'on' : ''}`, 'data-sort': key, onclick: () => { F.sort = active && !desc ? `-${key}` : key; F.page = 1; refresh(); } },
        tr(label), h('span', { class: 'fs-runs-sort' }, active ? (desc ? '▼' : '▲') : ''));
    }));
    const rows = data.items.map(r => {
      const [cls, txt] = RESULT[r.result] || ['gray', r.result];
      return h('tr', { 'data-run': r.id, class: r.result === 'carpisma' ? 'row-alert' : '' },
        h('td', null, h('b', null, fmtDateTime(r.started_at)), h('div', { class: 'small muted' }, `#${r.session_id}${r.end_reason && END_REASON[r.end_reason] ? ` · ${tr(END_REASON[r.end_reason])}` : ''}`)),
        h('td', null, r.owner_name || '—'),
        h('td', null, h('b', null, tr(TYPE_NAME[r.type] || r.type || '—')), r.mode === 'replay' ? h('span', { class: 'badge purple fs-runs-mode' }, tr('Kayıt')) : null,
          h('div', { class: 'small muted' }, [r.model_name, r.drone_code].filter(Boolean).join(' · ') || (r.mode === 'replay' ? r.source_file_name : '')) ),
        h('td', null, r.center_name || '—', r.lat != null ? h('div', { class: 'small muted mono' }, `${Number(r.lat).toFixed(4)}, ${Number(r.lon).toFixed(4)}`) : null),
        h('td', null, tr(WORLD_MODE[r.world?.mode] || r.world?.mode || '—')),
        h('td', null, r.type === 'sabit_kanat' && r.launch?.method ? launchLabel(r.launch, tr) : '—'),
        layoutCol ? h('td', { class: 'fs-runs-layout' }, r.type === 'sabit_kanat' && r.layout ? h('span', { class: 'badge gray', title: tr('Kontrol düzeni') }, layoutShort(r.layout, tr)) : '—') : null,   // §13.1
        h('td', { class: 'num' }, r.duration_s != null ? fmtDuration(r.duration_s) : '—'),
        h('td', null, h('span', { class: `badge ${cls}` }, r.result === 'carpisma' && r.crash_count > 1 ? `${tr(txt)} ×${r.crash_count}` : tr(txt)),
          r.speedup_max > 1 ? h('span', { class: 'badge gray fs-runs-speed', title: tr('Simülasyon hızı (en yüksek)') }, `${r.speedup_max}×`) : null),
        powerCols ? h('td', { class: 'fs-runs-fuel small' }, r.power?.fuel?.empty_t != null ? h('span', { class: 'badge red' }, tr('YAKIT BİTTİ')) : null, fuelCell(r)) : null,   // §23
        powerCols ? h('td', { class: 'fs-runs-elec small' }, r.power?.elec?.empty_t != null ? h('span', { class: 'badge red' }, tr('BATARYA BİTTİ')) : null, elecCell(r)) : null,
        h('td', null, attachments(r)),
        h('td', { class: 'actions' }, actions(r)));
    });
    clear(tableBox, data.items.length
      ? h('div', { class: 'table-wrap' }, h('table', { class: 'table fs-runs' }, h('thead', null, head), h('tbody', null, rows)))
      : h('div', { class: 'card empty fs-runs-empty' }, h('p', null, data.total === 0 && !hasFilter() ? tr('Henüz simülasyon kaydı yok. "Yeni Simülasyon" ile başlayın; oturum bitince kayıt burada görünür.') : tr('Filtreye uyan kayıt yok.')),
          hasFilter() ? h('p', null, h('button', { class: 'btn sm', type: 'button', 'data-act': 'show-all', onclick: () => { DETAIL_KEYS.forEach(k => { F[k] = ''; }); setPeriod('all'); } }, tr('Tüm kayıtları göster'))) : null));
    count.textContent = tr('{n} kayıt', { n: data.total });
    syncPill();
    clear(pager, data.pages > 1 ? [
      h('button', { class: 'btn xs', type: 'button', disabled: data.page <= 1, onclick: () => { F.page = data.page - 1; refresh(); } }, '‹'),
      h('span', null, tr('Sayfa {p} / {n}', { p: data.page, n: data.pages })),
      h('button', { class: 'btn xs', type: 'button', disabled: data.page >= data.pages, onclick: () => { F.page = data.page + 1; refresh(); } }, '›')] : null);
  };
  const hasFilter = () => !!(F.from || F.to || DETAIL_KEYS.some(k => F[k]));

  const refresh = async () => {
    try { data = await be.runs({ ...F }); } catch (err) { data = { items: [], total: 0, page: 1, pages: 1, facets: data.facets }; toastError(err); }
    fillFacets(data.facets || {});
    draw();
  };
  const el = h('div', { class: 'card card-pad fs-runs-card no-collapse' },
    h('div', { class: 'fs-runs-head' }, filters, pager),
    h('p', { class: 'small muted fs-runs-note' }, master
      ? tr('Her oturumun kapanışında: özet rapor, .bin uçuş logu, ekran kaydı, son parametre dökümü ve SITL script arşivi. Download menüsü yalnız sistem sahibine (MASTER) açıktır.')
      : tr('Her oturumun kapanışında: özet rapor, .bin uçuş logu ve ekran kaydı. Oynat, kaydı kayıttan oynat kipinde açar.')),
    tableBox);
  refresh();
  // setPeriod(k): kapsül dönemi ('1d' | '7d' | '30d' | 'all') · setFilter({result:'carpisma', …}): Detaylı alanlarını ayarlar (sayfa üstü widget tıklaması)
  const setFilter = (patch = {}) => { Object.entries(patch).forEach(([k, v]) => { if (k in F) F[k] = v ?? ''; }); F.page = 1; syncPill(); refresh(); };
  return { el, refresh, filters: F, setPeriod, setFilter };
}

export const runsQuery = F => Object.entries(F).filter(([, v]) => v !== '' && v != null).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
