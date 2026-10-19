// Destek (docs/simumav.md §9): "Sorun bildir" modalı (kategori, başlık ≤120, açıklama ≤4000, ekran görüntüsü: sahne canvas'ından otomatik
// yakalama ya da PNG/JPG ≤ 3 MB dosya, tarayıcı/cihaz + son uçuş bağlamı önizlemeli onay kutusu) → POST /api/support → talep numarası;
// "Taleplerim" listesi (#/support) ve ayrıntı (#/support/<id>): yanıt zinciri + kullanıcı yanıtı. Talepler HEPGO Merkez'de tutulur, her açılışta çekilir.
import * as api from '../core/api.js';
import { h, clear, fmtDate } from '../core/dom.js';
import { t, lang } from '../i18n/i18n.js';
import { screen, btn, modal, toast, toastErr, loading, switchEl } from '../ui/components.js';
import { stagger } from '../ui/transition.js';
import * as sfx from '../ui/sfx.js';
import { CATEGORIES, MAX_SUBJECT, MAX_BODY, STATUS_CLS, fileProblem, collectContext } from './rules.js';

export { CATEGORIES, MAX_SUBJECT, MAX_BODY, fileProblem } from './rules.js';

function glInfo() {
  // GPU adı (yalnız bildirim için); geçici bağlam hemen bırakılır (bağlam bütçesi: tek paylaşılan çizici)
  try {
    const c = document.createElement('canvas'); const gl = c.getContext('webgl'); if (!gl) return null;
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    const s = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return String(s || '').slice(0, 200) || null;
  } catch { return null; }
}

/** Görünür en büyük canvas (uçuş sahnesi ya da menü arka planı) → JPEG data URL; yoksa null. */
export function captureScene() {
  const cands = [...document.querySelectorAll('canvas')].filter(c => !c.hidden && c.width > 32 && c.height > 32 && c.getClientRects().length);
  cands.sort((a, b) => b.width * b.height - a.width * a.height);
  for (const src of cands) {
    try {
      const out = document.createElement('canvas');
      const scale = Math.min(1, 1600 / src.width);
      out.width = Math.round(src.width * scale); out.height = Math.round(src.height * scale);
      const g = out.getContext('2d'); g.fillStyle = '#060a14'; g.fillRect(0, 0, out.width, out.height); g.drawImage(src, 0, 0, out.width, out.height);
      const url = out.toDataURL('image/jpeg', 0.82);
      if (url.length > 2000) return url;
    } catch { /* tainted / bağlam kaybı */ }
  }
  return null;
}

const readFile = file => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result)); r.onerror = () => rej(new Error('read')); r.readAsDataURL(file); });

/** Sorun bildir modalı. opts: { flightId, source } — Uç bitiş raporu uçuş kimliğini verir; aksi hâlde son uçuş alınır. */
export async function openReportModal(ctx, { flightId = null, source = 'menu' } = {}) {
  sfx.select();
  let fid = flightId;
  if (!fid) { try { fid = (await api.get('/api/ops?limit=1')).flights?.[0]?.id || null; } catch { fid = null; } }
  let cat = source === 'flight' ? 'flight' : 'other', shot = null, shotName = null, includeCtx = true, busy = false;
  const context = collectContext({ ua: navigator.userAgent, lang: lang(), width: innerWidth, height: innerHeight, dpr: devicePixelRatio, flightId: fid, route: location.hash, gl: glInfo() });

  const cats = h('div', { class: 'sup-cats', role: 'radiogroup' });
  const drawCats = () => clear(cats, CATEGORIES.map(k => h('button', { type: 'button', role: 'radio', 'aria-checked': String(k === cat), class: k === cat ? 'on' : '', dataset: { cat: k }, onclick: () => { cat = k; sfx.tick(); drawCats(); } }, t(`support.cat_${k}`))));
  drawCats();
  const subj = h('input', { class: 'input', maxlength: String(MAX_SUBJECT), placeholder: t('support.subject_ph'), name: 'subject' });
  const body = h('textarea', { class: 'input', maxlength: String(MAX_BODY), placeholder: t('support.body_ph'), name: 'body' });
  const cnt = h('small', { class: 'sup-count' }, `0 / ${MAX_BODY}`);
  body.addEventListener('input', () => { cnt.textContent = `${body.value.length} / ${MAX_BODY}`; });

  const prev = h('img', { alt: '', hidden: true });
  const shotLbl = h('small', {}, t('support.shot_none'));
  const file = h('input', { type: 'file', accept: 'image/png,image/jpeg', hidden: true });
  const rmBtn = btn(t('support.shot_remove'), () => setShot(null), 'ghost', { hidden: true });
  const setShot = (url, name) => { shot = url; shotName = name || null; prev.hidden = !url; rmBtn.hidden = !url; if (url) prev.src = url; shotLbl.textContent = url ? (name || t('support.shot')) + ` · ${Math.round(url.length * 0.75 / 1024)} KB` : t('support.shot_none'); };
  file.addEventListener('change', async () => {
    const f = file.files?.[0]; const bad = fileProblem(f);
    if (bad) { if (f) toast(t(bad), 'err'); file.value = ''; return; }
    try { setShot(await readFile(f), f.name); } catch { toast(t('support.shot_fail'), 'err'); }
  });
  const shotRow = h('div', { class: 'sup-shot' }, prev,
    h('div', { class: 'btn-row' }, btn(t('support.shot_auto'), () => { const u = captureScene(); if (u) setShot(u, 'sahne.jpg'); else toast(t('support.shot_fail'), 'err'); }, '', { dataset: { act: 'capture' } }),
      btn(t('support.shot_file'), () => file.click(), '', { dataset: { act: 'file' } }), rmBtn, file), shotLbl);

  const ctxPre = h('pre', {}, ctxText(context, fid));
  const ctxRow = h('div', { class: 'sup-ctx' }, switchEl(true, v => { includeCtx = v; ctxPre.hidden = !v; }, t('support.ctx')), h('div', {}, h('span', {}, t('support.ctx')), ctxPre));

  const form = h('div', { class: 'sup-form' },
    h('label', {}, t('support.category'), cats), h('label', {}, t('support.subject'), subj), h('label', {}, t('support.body'), body, cnt),
    h('label', {}, t('support.shot'), shotRow), ctxRow);
  const sendLbl = t('support.send');
  const m = modal({ title: t('support.report'), body: form, wide: true, actions: [
    { label: t('common.cancel'), cls: 'ghost' },
    { label: sendLbl, cls: 'primary', onClick: async () => {
      if (busy) return false;
      const s = subj.value.trim(), b = body.value.trim();
      if (!s) { subj.focus(); sfx.error(); return false; }
      if (!b) { body.focus(); sfx.error(); return false; }
      busy = true;
      try {
        const r = await api.post('/api/support', { category: cat, subject: s, body: b, screenshot: shot, attach_name: shotName, include_context: includeCtx, context });
        ctx.track?.('support_ticket', { category: cat, attach: shot ? 1 : 0 });
        showDone(ctx, r);
        return true;
      } catch (e) { toastErr(e.status === 429 ? t('support.rate') : e.status === 503 ? t('support.unavailable') : e); sfx.error(); return false; } finally { busy = false; }
    } }] });
  m.box.classList.add('sup-modal');
  return m;
}

function ctxText(c, fid) {
  return [`${t('support.flight_ref', { id: fid || '—' })}`, c.ua, `${c.lang} · ${c.screen}`, c.gl ? `GPU: ${c.gl}` : null, c.route].filter(Boolean).join('\n');
}

function showDone(ctx, r) {
  sfx.takeoff?.();
  const body = h('div', { class: 'sup-done' }, h('div', { class: 'code' }, r.code || `#${r.id}`), h('p', {}, t('support.done_text')));
  modal({ title: t('support.done_title'), body, actions: [{ label: t('common.ok'), cls: 'ghost' }, { label: t('support.goto_list'), cls: 'primary', onClick: () => ctx.go('support') }] });
}

const statusBadge = s => h('span', { class: `badge ${STATUS_CLS[s] || ''}` }, t(`support.st_${s}`) === `support.st_${s}` ? s : t(`support.st_${s}`));

// ---------------- Taleplerim ----------------
export async function mount(root, ctx) {
  if (ctx.param) return mountDetail(root, ctx, ctx.param);
  const sc = screen({ title: t('support.my_tickets'), sub: t('support.my_sub'), cls: 'scroll' });
  const list = h('div', { class: 'sup-list' });
  sc.append(list); clear(root, sc); ctx.setBack(t('common.menu'));
  clear(list, loading());
  let data;
  try { data = await api.get('/api/support'); } catch (e) {
    clear(list, h('div', { class: 'err-box' }, e.status === 503 ? t('support.unavailable') : (e.message || String(e))), h('div', { class: 'btn-row' }, btn(t('support.report'), () => openReportModal(ctx), 'primary'))); return;
  }
  const rows = data.tickets || [];
  const head = h('div', { class: 'btn-row' }, btn(t('support.report'), () => openReportModal(ctx), 'primary lg', { dataset: { act: 'new' } }));
  if (!rows.length) { clear(list, h('div', { class: 'empty' }, h('p', {}, t('support.empty')), head)); return; }
  clear(list, head, rows.map(x => h('div', { class: `card lift sup-row ${x.unread ? 'unread' : ''}`, tabindex: '0', dataset: { id: String(x.id) }, onclick: () => ctx.go('support', String(x.id)), onkeydown: e => { if (e.key === 'Enter') ctx.go('support', String(x.id)); } },
    h('span', { class: 'code' }, x.code || `#${x.id}`),
    h('div', { class: 'grow' }, h('b', {}, x.subject), h('small', {}, `${t('support.updated')}: ${fmtDate(x.updated_at, lang())}${x.unread ? ` · ${t('support.unread')}` : ''}`)),
    statusBadge(x.status))));
  stagger([...list.children], 50);
}

async function mountDetail(root, ctx, id) {
  const sc = screen({ title: t('support.title'), cls: 'scroll' });
  const box = h('div', { class: 'sup-list' }); sc.append(box); clear(root, sc);
  ctx.setBack(t('support.my_tickets'), 'support');
  clear(box, loading());
  let tk;
  const load = async () => { tk = await api.get(`/api/support/${encodeURIComponent(id)}`); draw(); };
  const draw = () => {
    const closed = tk.status === 'kapali' || tk.status === 'cozuldu';
    const thread = h('div', { class: 'sup-thread' }, (tk.messages || []).map(m => h('div', { class: `sup-msg ${m.author_kind === 'company' ? 'me' : m.author_kind === 'system' ? 'system' : ''}` }, m.body,
      h('small', {}, `${m.author_kind === 'company' ? t('support.you') : m.author_kind === 'system' ? t('support.system') : (m.author_name || t('support.team'))} · ${fmtDate(m.created_at, lang())}`))));
    const files = tk.files?.length ? h('div', { class: 'card sup-filecard' }, h('b', {}, t('support.files')), h('div', { class: 'sup-files' }, tk.files.map(f => h('a', { href: f.url, target: '_blank', rel: 'noopener', title: f.name }, h('img', { src: f.url, alt: f.name }))))) : null;
    const ta = h('textarea', { class: 'input', maxlength: String(MAX_BODY), placeholder: t('support.reply_ph'), name: 'reply' });
    const send = btn(t('support.reply_send'), async () => {
      const v = ta.value.trim(); if (!v) { ta.focus(); return; }
      send.disabled = true;
      try { tk = await api.post(`/api/support/${encodeURIComponent(id)}/reply`, { body: v }); toast(t('support.sent'), 'ok'); sfx.select(); draw(); } catch (e) { toastErr(e.status === 429 ? t('support.rate') : e); send.disabled = false; }
    }, 'primary', { dataset: { act: 'reply' } });
    clear(box,
      h('div', { class: 'card sup-row' }, h('span', { class: 'code' }, tk.code || `#${tk.id}`), h('div', { class: 'grow' }, h('b', {}, tk.subject), h('small', {}, fmtDate(tk.created_at, lang()))), statusBadge(tk.status)),
      thread, files,
      closed ? h('p', { class: 'muted sup-closed' }, t('support.closed_note')) : h('div', { class: 'sup-reply' }, ta, send));
  };
  try { await load(); } catch (e) { clear(box, h('div', { class: 'err-box' }, e.status === 503 ? t('support.unavailable') : (e.message || String(e)))); }
}
