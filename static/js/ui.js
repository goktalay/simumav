// Küçük DOM yardımcıları: öğe oluşturma, modal, bildirim, biçimlendirme.
import { faFromText } from './fa-icons.js';
import { fileUrl } from './api.js';
import { segIcon } from './segicons.js';
import { icons } from './icons.js';
import { t } from './i18n.js';
export { t };   // modüller dinamik metinleri t('{n} ... ', { n }) ile sarabilsin

// Dil desteği: metin çocukları ve bazı öznitelikler (placeholder/title/aria-label)
// merkezi olarak katalogdan çevrilir. Böylece tüm arayüz + yazdırma şablonları
// (hepsi h() kullanır) tek noktadan çevrilir; karşılığı yoksa Türkçe kalır.
const I18N_ATTRS = new Set(['placeholder', 'title', 'aria-label']);
// Adres öznitelikleri: kullanıcı verisinden gelen javascript: / vbscript: (bağlantıda data: de) tıklanınca kod çalıştırır
// (XSS) → zararsız adrese çevrilir. Arayüzün kendi sabit "javascript:void 0" bağlantıları serbest.
const URL_ATTRS = new Set(['href', 'src', 'action', 'formaction', 'xlink:href']);
const BAD_SRC = /^(javascript|vbscript):/i;
const BAD_HREF = /^(javascript|vbscript|data):/i;
export function safeUrl(k, v) {
  const raw = String(v);
  if (/^javascript:void(\s*0|\(0\));?$/i.test(raw.trim())) return raw;
  const s = raw.replace(/[\x00-\x20\x7f]+/g, '');
  return (k === 'src' ? BAD_SRC : BAD_HREF).test(s) ? (k === 'src' ? 'about:blank' : '#') : raw;
}

export function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'html') el.innerHTML = v;
    else if (v === true) el.setAttribute(k, '');
    else if (I18N_ATTRS.has(k) && typeof v === 'string') el.setAttribute(k, t(v));
    else if (URL_ATTRS.has(k)) el.setAttribute(k, safeUrl(k, v));
    else el.setAttribute(k, v);
  }
  append(el, children);
  return el;
}

// Emoji ikon → Font Awesome: yalnız arayüz "krom" öğelerinde (düğme, bağlantı, etiket, başlık…) ve yalnız metnin BAŞINDAKİ emoji.
// Sohbet/akış/not gövdeleri (div/p) dokunulmaz; kullanıcı metni aynen kalır.
const ICON_TAGS = new Set(['BUTTON', 'A', 'SPAN', 'B', 'STRONG', 'LABEL', 'H1', 'H2', 'H3', 'H4', 'SUMMARY', 'TH', 'DT', 'SMALL', 'LEGEND', 'EM', 'I']);
function append(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    if (c instanceof Node) { el.append(c); continue; }
    const s = typeof c === 'string' ? t(String(c)) : String(c);
    if (s.length && s.charCodeAt(0) >= 0x2190 && ICON_TAGS.has(el.tagName)) {
      const r = faFromText(s);
      if (r) { el.append(r[0]); if (r[1]) el.append(document.createTextNode(r[1])); continue; }
    }
    el.append(document.createTextNode(s));
  }
}

// Birden çok e-posta: satır satır; ilki birincil. el.values → adresler, el.value → birincil (eski kodla uyum)
export function emailsInput(values = []) {
  const list = h('div', { class: 'emails-in' });
  const row = (v = '') => {
    const inp = h('input', { class: 'input', type: 'email', value: v, placeholder: 'ad@firma.com', autocomplete: 'off' });
    const r = h('div', { class: 'emails-row' }, inp,
      h('button', { class: 'btn sm ghost', type: 'button', title: t('Kaldır'), onclick: () => { r.remove(); mark(); } }, '×'));
    return r;
  };
  const mark = () => [...list.children].forEach((r, i) => r.classList.toggle('primary', i === 0));
  const add = h('button', { class: 'btn sm', type: 'button', onclick: () => { list.append(row()); mark(); list.lastChild.querySelector('input').focus(); } },
    t('＋ E-posta ekle'));
  (values.length ? values : ['']).forEach(v => list.append(row(v)));
  mark();
  const el = h('div', { class: 'emails-wrap' }, list, add);
  Object.defineProperty(el, 'values', { get: () => [...list.querySelectorAll('input')].map(i => i.value.trim()).filter(Boolean) });
  Object.defineProperty(el, 'value', { get: () => el.values[0] || '' });
  return el;
}

export function svgIcon(markup) {
  const wrap = document.createElement('span');
  wrap.style.display = 'contents';
  wrap.innerHTML = markup;
  return wrap.firstElementChild;
}

export function clear(el, ...children) {
  el.replaceChildren();
  append(el, children);
  return el;
}

// ---------- Bildirim ----------
let toastBox;
export function toast(message, type = '') {
  if (!toastBox) toastBox = document.body.appendChild(h('div', { class: 'toasts' }));
  const t = toastBox.appendChild(h('div', { class: `toast ${type}` }, message));
  setTimeout(() => t.remove(), type === 'err' ? 6000 : 3500);
}
export const toastError = err => toast(err?.message || String(err), 'err');

// Firma kısa adı (Firmalar modülü dışında): ilk kelime; "T. C. …", "4N …", "C TECH …" gibi kısaltmalarda anlamlı
// bir kelimeye (3+ harf) ulaşana kadar devam edilir. Tam ad üzerine gelince (title) gösterilir.
export function shortCompany(name) {
  const words = String(name || '').trim().split(/\s+/).filter(Boolean);
  const out = [];
  for (const w of words) {
    out.push(w);
    if (w.replace(/[^\p{L}]/gu, '').length >= 3) break;
  }
  return out.join(' ');
}
export const companyName = (name, attrs = {}) => h('span', { title: name, ...attrs }, shortCompany(name));

// ---------- Modal ----------
// modal({ title, body, actions: [{label, class, onClick}], wide }) → { close, el }
export function modal({ title, body, actions = [], wide = false, onClose }) {
  const foot = h('div', { class: 'modal-foot' });
  const box = h('div', { class: `modal ${wide ? 'wide' : ''}`, role: 'dialog', 'aria-modal': 'true' },
    h('div', { class: 'modal-head' }, h('h2', null, title),
      h('button', { class: 'x-btn', 'aria-label': 'Kapat', onclick: () => close() }, '×')),
    h('div', { class: 'modal-body' }, body),
    actions.length ? foot : null);
  const back = h('div', { class: 'modal-back' }, box);
  back.addEventListener('mousedown', e => { if (e.target === back) close(); });
  const onKey = e => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  window.addEventListener('hashchange', close, { once: true });   // sayfa değişince açık pencere kapanır

  let closed = false;
  function close() {
    if (closed) return;
    closed = true;
    back.remove();
    document.removeEventListener('keydown', onKey);
    window.removeEventListener('hashchange', close);
    onClose?.();
  }
  for (const a of actions) {
    if (a === 'spacer') { foot.append(h('span', { class: 'spacer' })); continue; }
    const b = h('button', { class: `btn ${a.class || ''}` }, a.label);
    b.addEventListener('click', async () => {
      if (!a.onClick) return close();
      b.disabled = true;
      try {
        const keep = await a.onClick({ close, button: b });
        if (keep !== true) close();
      } catch (err) {
        toastError(err);
      } finally {
        b.disabled = false;
      }
    });
    foot.append(b);
  }
  document.body.append(back);
  box.querySelector('input, select, textarea')?.focus();
  return { close, el: box };
}

export function confirmDialog(title, message, { okLabel = 'Onayla', danger = false } = {}) {
  return new Promise(resolve => {
    let answered = false;
    modal({
      title, body: h('p', { style: { margin: 0 } }, message),
      onClose: () => { if (!answered) resolve(false); },
      actions: [
        { label: 'Vazgeç' },
        { label: okLabel, class: danger ? 'danger' : 'primary', onClick: () => { answered = true; resolve(true); } },
      ],
    });
  });
}

// ---------- Biçimlendirme ----------
const pad = n => String(n).padStart(2, '0');
export function fmtDateTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
export function fmtDate(iso) {
  if (!iso) return '—';
  const [y, m, d] = iso.slice(0, 10).split('-');
  return `${d}.${m}.${y}`;
}
export function fmtDuration(sec) {
  if (sec === null || sec === undefined) return '—';
  sec = Math.max(0, Math.floor(sec));
  const d = Math.floor(sec / 86400), hh = Math.floor(sec % 86400 / 3600), mm = Math.floor(sec % 3600 / 60), ss = sec % 60;
  if (d) return `${d} g ${hh} sa ${mm} dk`;
  if (hh) return `${hh} sa ${mm} dk`;
  return `${mm} dk ${pad(ss)} sn`;
}
export const secondsSince = iso => (Date.now() - new Date(iso).getTime()) / 1000;
export const secondsBetween = (a, b) => (a && b ? (new Date(b).getTime() - new Date(a).getTime()) / 1000 : null);
// Baskı süresi (dakika) → "9 sa 16 dk", "1 g 3 sa 20 dk"
export const fmtMinutes = min => (min || min === 0 ? fmtDuration(min * 60).replace(/ 00 sn$| \d+ sn$/, '') : '—');

export function avatar(user, size = '') {
  const initials = (user.full_name || user.username || '?')
    .split(/\s+/).filter(Boolean).slice(0, 2).map(s => s[0].toLocaleUpperCase('tr')).join('');
  return h('span', { class: `avatar ${size}` },
    user.photo ? h('img', { src: fileUrl(user.photo, size === 'lg' || size === 'xl' ? 512 : 128), alt: '', loading: 'lazy' }) : initials);
}

// Yükleme çubuğu + iptal düğmesi. start() → AbortController sinyali (yükleme fonksiyonuna verilir).
export function uploadPanel() {
  let ctl = null;
  const bar = h('div', { class: 'grow' });
  const cancel = h('button', { class: 'btn sm danger', type: 'button', onclick: () => ctl?.abort() }, 'Yüklemeyi İptal Et');
  const el = h('div', { class: 'upload-progress upload-panel', hidden: true }, bar, cancel);
  el.start = () => { ctl = new AbortController(); el.hidden = false; clear(bar); return ctl.signal; };
  el.set = (label, pct) => clear(bar, h('div', { class: 'small muted' }, label), progressBar(pct));
  el.done = () => { el.hidden = true; ctl = null; };
  el.abort = () => ctl?.abort();
  return el;
}

// İnternetten (caymaz.app) bağlanınca büyük dosya yükleme yerine gösterilen uyarı: yerel adrese bağlantı
export function localUploadNotice(meta, what = 'Video ve uçuş logu') {
  const url = `${meta.local_url}/${location.hash}`;
  return h('div', { class: 'alert warn', style: { marginBottom: 0 } },
    h('b', null, `${what} yalnızca yerel ağdan yüklenebilir. `),
    'İnternet üzerinden yükleme çok yavaş olduğu için bu işlem şirket ağına bağlıyken yapılır: ',
    h('a', { href: url }, meta.local_url), '.');
}

export function progressBar(pct) {
  return h('div', { class: 'progress-line' },
    h('div', { class: 'progress', style: { flex: '1' } }, h('i', { style: { width: `${pct}%` } })),
    h('b', null, `%${pct}`));
}

export function field(label, control, hint) {
  return h('div', { class: 'field' }, h('label', null, label), control, hint ? h('div', { class: 'hint' }, hint) : null);
}

// Katlanabilir panel: tıklanan başlık (düğme) + gövde. Uzun formları (ör. uçuş düzenleme penceresi) bölümlere ayırır.
// open: başlangıçta açık · badge: başlığın sağında kısa durum (metin/sayı → .fold-badge; düğüm → olduğu gibi eklenir).
// Dönen öğede el.toggle(open) ile dışarıdan açılıp kapanır (ör. doğrulama hatasında ilgili paneli açmak için).
export function fold(title, body, { open = false, badge } = {}) {
  const chev = svgIcon('<svg class="fold-chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg>');
  const bodyEl = h('div', { class: 'fold-body' }, body);
  const head = h('button', { class: 'fold-head', type: 'button' }, chev, h('span', { class: 'fold-title' }, title),
    badge === null || badge === undefined || badge === false ? null : badge instanceof Node ? badge : h('span', { class: 'fold-badge' }, String(badge)));
  const el = h('div', { class: 'fold' }, head, bodyEl);
  el.toggle = v => {
    const on = v === undefined ? !el.classList.contains('open') : !!v;
    el.classList.toggle('open', on);
    head.setAttribute('aria-expanded', on ? 'true' : 'false');
    bodyEl.hidden = !on;
  };
  head.addEventListener('click', () => el.toggle());
  el.toggle(open);
  return el;
}

export function segmented(options, value, onChange, opts = {}) {
  const el = h('div', { class: `seg ${opts.tabs ? 'seg-tabs' : ''}`.trim() });
  // Telefonda tek satıra sığmayacak seçimler (çok ya da uzun seçenek: Dil, Metin biçimi…) ızgaraya dönsün (CSS: .seg-long/.seg-many)
  const chars = options.reduce((n, [, l]) => n + (typeof l === 'string' ? l.length : 4), 0);
  if (options.length >= 5) el.classList.add('seg-long', 'seg-many');
  else if ((options.length === 4 && chars > 30) || (options.length === 3 && chars > 36)) el.classList.add('seg-long');
  const render = v => {
    el.replaceChildren(...options.map(([key, label]) =>
      h('button', { class: key === v ? 'on' : '', type: 'button', onclick: () => { render(key); onChange(key); } }, segIcon(label), label)));
  };
  render(value);
  return el;
}

// Alt modül sekme çubuğu (İK'deki gibi): başlığın hemen altında tam genişlikte, alt çizgili sekmeler.
// options: [[key, label], ...] · onChange(key). Modüllerde combobox / pill yerine standart olarak kullanılır.
export function moduleTabs(options, active, onChange) {
  return h('div', { class: 'module-tabs' }, segmented(options, active, onChange, { tabs: true }));
}

// Bu oturumda kaç kez adres (hash) değişti — geri tuşunun güvenle history.back() yapıp yapamayacağını belirler.
let navDepth = 0;
if (typeof window !== 'undefined') window.addEventListener('hashchange', () => { navDepth++; });

// Geri: sabit adrese atlamak yerine geçmişte bir adım geri. Bu oturumda hiç gezinme olmadıysa (doğrudan derin bağlantı / ilk yükleme)
// history.back() siteden çıkarabilir → o durumda `fallback` adresine gidilir. Tam ekrandaysa (Canlı Uçuş / simülatör oturumu) önce
// tam ekrandan çıkar — ekrandaki "← Geri" düğmesi klavye Escape ile aynı sonucu verir. → true: geçmişte geri gidildi.
export function goBack(fallback = '#/') {
  const go = () => { if (navDepth > 0) { history.back(); return true; } location.hash = fallback; return false; };
  if (document.fullscreenElement) { (document.exitFullscreen?.() || Promise.resolve()).catch(() => {}).then(go); return true; }
  return go();
}

// Sayfa başlığı bandı. `tabs`: alt-modül seçicisi (segmented), başlık bandının sağında üstte durur.
// `right`: başlıkta kalması gereken öğeler (ör. sekme seçici). Alt-modüle ait EYLEM düğmeleri bantta değil,
// aşağıdaki ayrı toolbar'da (moduleToolbar) yer almalıdır.
// Yerleşim (app.css sonu, "§16 başlık bandı"): başlık + alt başlık TEK satır, sığmazsa "…" ile kırpılır; sağdaki seçici/düğmeler alt satıra inmez.
export function pageHead(title, { back, sub, right, tabs } = {}) {
  return h('div', { class: 'page-head' },
    back ? h('a', { class: 'back', href: back, 'aria-label': 'Geri', onclick: e => {
      if (navDepth > 0) { e.preventDefault(); goBack(back); }
    } }, '←') : null,
    h('div', { class: 'page-head-t' }, h('h1', null, title), sub ? h('div', { class: 'sub' }, sub) : null),
    h('div', { class: 'spacer' }),
    tabs || null,
    right || null);
}

// Alt-modüle ait eylem düğmeleri için başlığın hemen altında ayrı toolbar. Hiza kullanıcı ayarından (sol/orta/sağ, varsayılan orta).
// İşlem düğmeleri ve görünüm seçicileri (.btn/.seg/.icon-btn) baloncuk (pill-group) içinde toplanır; arama/filtre girişleri (input/select) baloncuk dışında aynı satırda kalır.
// Kullanım: clear(view, pageHead(...), moduleToolbar(btn1, btn2, ...), body). Düğüm yoksa görünmez.
export function moduleToolbar(...items) {
  const kids = items.flat().filter(Boolean);
  if (!kids.length) return null;
  const bar = h('div', { class: 'module-toolbar' });
  // Yalnızca EYLEM düğmeleri (.btn/.icon-btn) baloncukta gruplanır; görünüm seçiciler (.seg) ve arama/filtre girişleri kendi başına kalır.
  const isBtn = el => el.classList && (el.classList.contains('btn') || el.classList.contains('icon-btn')) && !el.classList.contains('back');
  let group = null;
  for (const el of kids) {
    if (isBtn(el)) {
      if (!group) { group = h('div', { class: 'pill-group module-pills' }); bar.append(group); }
      group.append(el);
    } else { bar.append(el); group = null; }
  }
  return bar;
}

// Toolbar hizasını (kişisel ayar) belge köküne uygula; CSS justify-content'i buradan okur.
export function applyToolbarAlign(v) {
  const al = v || pref('toolbarAlign', 'center');
  document.documentElement.dataset.toolbarAlign = ['left', 'center', 'right'].includes(al) ? al : 'center';
}

// Görünüm tercihlerini (kart/liste vb.) tarayıcıda hatırla.
export function pref(key, fallback) {
  try { return localStorage.getItem(`caymaz.${key}`) || fallback; } catch { return fallback; }
}
export function setPref(key, value) {
  try { localStorage.setItem(`caymaz.${key}`, value); } catch { /* yok say */ }
}

// Sayfa değişince durdurulan zamanlayıcılar ve temizlik işleri (ör. animasyonlar)
const timers = new Set();
const cleanups = new Set();
export function every(ms, fn) {
  const id = setInterval(fn, ms);
  timers.add(id);
  return id;
}
export function onLeave(fn) {
  cleanups.add(fn);
}
export function stopTimers() {
  timers.forEach(clearInterval);
  timers.clear();
  cleanups.forEach(fn => fn());
  cleanups.clear();
}

// Modül üstü özet sayılar: [{ label, value, sub?, tone?: 'alert' | 'ok' | 'muted' }]
// ---------- Tarih-saat seçici (flatpickr, Türkçe) ----------
// İşlem zamanını kullanıcı serbestçe seçer; varsayılan şimdi. getValue() → 'YYYY-MM-DDTHH:MM+03:00'
// (cihazın yerel saati ve saat dilimi; sunucu kendi saatine çevirir).
const isoLocal = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
export function dateTimeInput({ value, min, inModal } = {}) {
  const input = h('input', { class: 'input', type: window.flatpickr ? 'text' : 'datetime-local' });
  const now = () => new Date();
  let fp = null;
  const nowBtn = h('button', { class: 'btn sm', type: 'button', onclick: () => {
    if (fp) fp.setDate(now(), true); else input.value = isoLocal(now());
  } }, 'Şimdi');
  const el = h('div', { class: 'dt-field' }, input, nowBtn);   // flatpickr görünür kutuyu input'un yanına ekler
  if (window.flatpickr) {
    fp = window.flatpickr(input, {
      enableTime: true, time_24hr: true, locale: 'tr', minuteIncrement: 1,
      dateFormat: 'Y-m-d\\TH:i', altInput: true, altFormat: 'd.m.Y  H:i', altInputClass: 'input dt-alt',
      defaultDate: value ? new Date(value) : now(), minDate: min ? new Date(min) : null,
      allowInput: true,            // elle de yazılabilsin (takvim açılmasa bile değiştirilebilir)
      static: !!inModal,           // modal içinde: takvim modalın içinde render edilsin (konum/katman sorunu olmaz)
    });
  } else {
    input.value = isoLocal(value ? new Date(value) : now());
  }
  el.getValue = () => {
    if (!input.value) return null;
    const off = -new Date(input.value).getTimezoneOffset();   // seçilen andaki saat dilimi farkı (dakika)
    return `${input.value}${off >= 0 ? '+' : '-'}${pad(Math.floor(Math.abs(off) / 60))}:${pad(Math.abs(off) % 60)}`;
  };
  return el;
}

// Stajer etiketi (yardımcı personel seçimlerinde stajerler de listelenir)
export const internTag = p => (p?.intern || p?.roles?.includes?.('Stajer') ? h('span', { class: 'intern-tag', title: 'Stajer: hiçbir modüle yetkili değil' }, 'Stajer') : null);
export const nameWithIntern = p => (p.intern ? `${p.full_name} (Stajer)` : p.full_name);   // açılır listeler için

// Çoklu kişi seçimi (ör. montaj personeli): kartlara dokunarak seçilir. getIds() → seçilen id'ler.
export function peoplePicker(people, { empty = 'Kişi yok', selected = [], sub = p => p.username || '' } = {}) {
  const chosen = new Set(selected);
  const el = h('div', { class: 'pick-list multi' }, people.length ? people.map(p => {
    const cb = h('input', { type: 'checkbox', checked: chosen.has(p.id) });
    const row = h('div', { class: `pick ${chosen.has(p.id) ? 'on' : ''} ${p.intern ? 'intern' : ''}` }, cb,
      h('div', { class: 'grow' }, h('b', null, p.full_name, internTag(p)), h('span', { class: 'small muted' }, sub(p))));
    row.addEventListener('click', e => {
      if (e.target !== cb) cb.checked = !cb.checked;
      cb.checked ? chosen.add(p.id) : chosen.delete(p.id);
      row.classList.toggle('on', cb.checked);
    });
    return row;
  }) : h('div', { class: 'empty' }, empty));
  el.getIds = () => [...chosen];
  return el;
}

export function statStrip() {
  const el = h('div', { class: 'stat-strip' });
  el.set = stats => {
    // s.onClick: kutu tıklanabilir (ör. Uçuş Simülatörü üst kutuları → ilgili sekme/filtre); s.key → data-stat (test/stil)
    clear(el, stats.filter(Boolean).map(s =>
      h('div', { class: `stat ${s.tone || ''}${s.icon && icons[s.icon] ? ' has-ic' : ''}${s.onClick ? ' click' : ''}`, 'data-stat': s.key || null,
        ...(s.onClick ? { role: 'button', tabindex: '0', onclick: s.onClick, onkeydown: e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); s.onClick(e); } } } : {}) },
        s.icon && icons[s.icon] ? h('span', { class: 'stat-ic' }, svgIcon(icons[s.icon])) : null,
        h('div', { class: 'stat-main' },
          h('span', { class: 'v' }, s.value ?? '—'),
          h('span', { class: 'l' }, s.label),
          s.sub ? h('span', { class: 's' }, s.sub) : null))));
    lastW = -1;
    requestAnimationFrame(fit);
    document.fonts?.ready.then(() => { lastW = -1; fit(); });   // yazı tipi geç yüklenirse genişlik değişir
  };
  // Uzun tutar (ör. ₺85.681.256,12) dar kartta taşmasın: sığana kadar yazı boyutu küçülür; genişlik değişince yeniden hesaplanır
  let lastW = -1;
  const fit = () => {
    if (!el.isConnected || el.clientWidth === lastW) return;
    lastW = el.clientWidth;
    const range = document.createRange();
    // scrollWidth tam sayıya yuvarlanır; yarım piksellik taşma da "…" gösterir — metin genişliği Range ile kesirli ölçülür
    const over = v => { range.selectNodeContents(v); return range.getBoundingClientRect().width > v.clientWidth - 0.5; };
    const vs = [...el.querySelectorAll('.stat .v')];
    let min = Infinity;
    for (const v of vs) {
      v.style.fontSize = '';
      let fs = parseFloat(getComputedStyle(v).fontSize);
      while (over(v) && fs > 12) { fs -= 1; v.style.fontSize = `${fs}px`; }
      min = Math.min(min, fs);
    }
    if (vs.some(v => v.style.fontSize)) vs.forEach(v => { v.style.fontSize = `${min}px`; });   // şeritte tüm tutarlar aynı boyda
  };
  if (window.ResizeObserver) new ResizeObserver(() => requestAnimationFrame(fit)).observe(el);
  return el;
}

export function selectInput(options, { all = 'Tümü', value = '' } = {}) {
  return h('select', { class: 'input' },
    all ? h('option', { value: '' }, all) : null,
    options.map(([v, label]) => h('option', { value: v, selected: String(v) === String(value) }, label)));
}

// Türkçe büyük/küçük harf duyarsız arama
export const matches = (term, ...values) => {
  const t = term.trim().toLocaleLowerCase('tr');
  return !t || values.some(v => v != null && String(v).toLocaleLowerCase('tr').includes(t));
};

// Çoklu seçim açılır listesi (onay kutulu). options: [[değer, etiket, ek?]], selected: değerler; onChange(değerler).
// Düğmede "Etiket: 6/8" yazar; dışarı tıklanınca kapanır. extra: panelin altına eklenecek öğe (ör. "Varsayılan" düğmesi).
export function multiSelect(label, options, selected, onChange, { extra = null, min = 0 } = {}) {
  let chosen = new Set(selected);
  const btn = h('button', { class: 'input ms-btn', type: 'button', 'aria-haspopup': 'listbox' });
  const panel = h('div', { class: 'ms-panel', hidden: true, role: 'listbox' });
  const wrap = h('div', { class: 'ms' }, btn, panel);
  const drawBtn = () => { btn.textContent = `${label}: ${chosen.size}/${options.length}`; };
  const drawPanel = () => clear(panel, options.map(([v, text, note]) => {
    const cb = h('input', { type: 'checkbox', checked: chosen.has(v) });
    cb.addEventListener('change', () => {
      if (!cb.checked && chosen.size <= min) { cb.checked = true; return; }
      cb.checked ? chosen.add(v) : chosen.delete(v);
      drawBtn();
      onChange(options.map(o => o[0]).filter(x => chosen.has(x)));
    });
    return h('label', { class: 'ms-row' }, cb, h('span', { class: 'grow' }, text), note != null ? h('span', { class: 'ms-note' }, note) : null);
  }), extra);
  btn.addEventListener('click', () => { panel.hidden = !panel.hidden; if (!panel.hidden) drawPanel(); });
  const outside = e => { if (!wrap.contains(e.target)) panel.hidden = true; };
  document.addEventListener('click', outside);
  onLeave(() => document.removeEventListener('click', outside));
  wrap.set = (values, opts) => { if (opts) options = opts; chosen = new Set(values); drawBtn(); if (!panel.hidden) drawPanel(); };
  drawBtn();
  return wrap;
}

// ---------- Tarih aralığı filtresi (listeler): varsayılan "Bu hafta" ----------
// periodFilter(key, onChange) → { el, range(): { date_from, date_to } (YYYY-MM-DD; Tümü'nde boş), qs(): 'date_from=..&date_to=..' }
// Seçim oturum boyunca (sessionStorage) liste başına hatırlanır; uygulama yeniden açılınca yine "Bu hafta" ile başlar.
const isoDay = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
export const PERIODS = [['today', 'Bugün'], ['week', 'Bu hafta'], ['month', 'Bu ay'], ['30d', 'Son 30 gün'], ['90d', 'Son 3 ay'], ['year', 'Bu yıl'], ['all', 'Tümü'], ['custom', 'Özel aralık…']];
export function periodRange(p, custom = {}) {
  const now = new Date(), y = now.getFullYear(), m = now.getMonth(), d = now.getDate();
  const day = new Date(y, m, d);
  switch (p) {
    case 'today': return { date_from: isoDay(day), date_to: isoDay(day) };
    case 'week': { const dow = (day.getDay() + 6) % 7; const s = new Date(y, m, d - dow); return { date_from: isoDay(s), date_to: isoDay(new Date(y, m, d - dow + 6)) }; }
    case 'month': return { date_from: isoDay(new Date(y, m, 1)), date_to: isoDay(new Date(y, m + 1, 0)) };
    case '30d': return { date_from: isoDay(new Date(y, m, d - 29)), date_to: isoDay(day) };
    case '90d': return { date_from: isoDay(new Date(y, m, d - 89)), date_to: isoDay(day) };
    case 'year': return { date_from: `${y}-01-01`, date_to: `${y}-12-31` };
    case 'custom': return { date_from: custom.from || '', date_to: custom.to || '' };
    default: return { date_from: '', date_to: '' };
  }
}
export function periodFilter(key, onChange, { initial = 'week', title = 'Tarih aralığı' } = {}) {
  const sk = `caymaz.period.${key}`;
  let saved = null; try { saved = JSON.parse(sessionStorage.getItem(sk) || 'null'); } catch { /* */ }
  let p = saved?.p || initial;
  const from = h('input', { class: 'input period-date', type: 'date', value: saved?.from || '', title: 'Başlangıç' });
  const to = h('input', { class: 'input period-date', type: 'date', value: saved?.to || '', title: 'Bitiş' });
  const sel = h('select', { class: 'input period-sel', title }, PERIODS.map(([v, l]) => h('option', { value: v, selected: v === p }, l)));
  const customBox = h('span', { class: 'period-custom', hidden: p !== 'custom' }, from, h('span', { class: 'muted' }, '–'), to);
  const el = h('span', { class: 'period-filter' }, sel, customBox);
  const save = () => { try { sessionStorage.setItem(sk, JSON.stringify({ p, from: from.value, to: to.value })); } catch { /* */ } };
  const range = () => periodRange(p, { from: from.value, to: to.value });
  sel.addEventListener('change', () => {
    p = sel.value;
    if (p === 'custom' && !from.value) { const w = periodRange('week'); from.value = w.date_from; to.value = w.date_to; }
    customBox.hidden = p !== 'custom'; save(); onChange?.(range());
  });
  for (const i of [from, to]) i.addEventListener('change', () => { save(); onChange?.(range()); });
  const qs = () => { const r = range(); return new URLSearchParams(Object.entries(r).filter(([, v]) => v)).toString(); };
  return { el, range, qs, label: () => PERIODS.find(x => x[0] === p)?.[1] || '' };
}
