// SIMUMAV › Uç › ÇOK OYUNCULU KARŞILAŞMA (halka yarışı; docs/simumav.md §18) — kurucu sihirbaz adımları, davet sayfası, bekleme salonu, yarış ekranı.
//   • Sihirbaz (fly/index.js, createWizard(..., {match:true})): Dron → Parkur → (Kalkış) → HALKALAR (createRingsStep: sayı, min/max yükseklik, çap,
//     parkur yarıçapı, süre, tohum; sağda sunucu önizlemesi POST /api/match/rings-preview: kuş bakışı + başlangıç noktaları + yükseklik profili) →
//     DAVET (createInviteStep: oyuncu sayısı, kurucunun şifresi; 🎲 öneri) → "KARŞILAŞMA OLUŞTUR" → POST /api/match → salon (#/fly/match/<id>).
//   • Davet sayfası (#/fly/join/<kod>; renderJoin): oturumsuzsa kabuk girişe yönlendirir (?giris=1&sonra=…), girişten sonra buraya döner;
//     "Giriş yapılan hesap: e-posta" + kurucunun verdiği şifre → POST /api/match/join → salon. Yanlış şifre: kalan hak; çok deneme: bekleme süresi.
//   • Bekleme salonu (#/fly/match/<id>; renderLobby): katılanlar (kurucu dahil; çevrimiçi noktası, Hazır rozeti, kurucu ✕ çıkarır), ayarlar ve parkur
//     çizimi, davet bağlantısı + şifre (kurucu; şifre yalnız bu tarayıcıda oluşturulurken görünür — sunucuda özet), Hazırım (davetli), BAŞLAT
//     (kurucu; herkes hazır + ≥ 2), Ayrıl / İptal. WS /ws/match/<id> canlı; HAZIRLIK'ta oyuncu yarış ekranına geçer; BITTI'de sonuç tablosu.
//   • Yarış ekranı (#/fly/match/<id>/race; renderRace): oyuncunun uçuşu (GET /api/fly/<flight_id>) → session.js openSession + ctx.match
//     (match_hud.js katmanı). Yarış başlayana kadar ARM/kalkış sunucuda kilitli (komut kapısı); simülasyon hızı 1×; MP köprüsü yok.
import { clear, h, toast, toastError, confirmDialog, t as tr, onLeave } from './simui.js';
import { net, wsUrl } from './net.js';
import { genPassword, inviteLink, LIMITS, lobbyHref, lobbyView, joinErrorKey, OUT, passwordErrorKey, phaseOf, playersErrorKey, raceHref, REASON_KEY, resultRows,
  ringsBody, ringsDefaults, ringsErrorKey, ringsLine, shouldEnterRace, STATE_KEY, STATUS_KEY, viewBox } from './match_core.js';
import { dfResultTable, resultTable } from './match_hud.js';
import { DF_LIMITS, dfDefaults, dfError, dfSummary, dfSvg, makeDfT } from '/sim/flightsim_dogfight.js';   // HEPGO §41 it dalaşı (ortak)
import { TYPE_LABEL, WORLD_MODE_LABEL } from './wizard.js';

const PW_KEY = id => `sm.match.pw.${id}`;   // kurucunun şifresi (yalnız bu tarayıcı oturumu; sunucu düz şifreyi saklamaz)
const NOAUTO_KEY = id => `sm.match.noauto.${id}`;   // yarış ekranından salona elle dönüldü: salon yeniden yarışa atmasın
const COLORS = ['#22c55e', '#3b82f6', '#f97316', '#e11d48', '#a855f7', '#eab308', '#06b6d4', '#f472b6'];
const typeLbl = ty => { const k = `types.${ty}`, r = tr(k); return r && r !== k ? r : TYPE_LABEL[ty] || ty; };
let metaP = null;
export const matchMeta = (fresh = false) => { if (fresh) metaP = null; return (metaP ??= net.get('/api/match/meta').catch(e => { metaP = null; throw e; })); };
const DT = makeDfT(tr, true);   // §41 metinleri: df.* (7 dil)
const isDf = m => (m?.kind || 'rings') === 'dogfight';
const dfType = ty => (ty === 'plane' ? 'sabit_kanat' : 'multirotor');   // SIMUMAV tipi → çekirdek sınıfı (dikey / uçak)
const copy = async (txt, okKey) => { try { await navigator.clipboard.writeText(txt); toast(tr(okKey)); } catch { toast(tr('match.copy_fail'), 'err'); } };

// ---------------------------------------------------------------- parkur çizimi (SVG): kuş bakışı + yükseklik profili
const NS = 'http://www.w3.org/2000/svg';
const sv = (tag, attrs = {}, ...kids) => { const e = document.createElementNS(NS, tag); for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v)); kids.forEach(k => k && e.append(k)); return e; };
export function ringsSvg(rings = [], starts = [], { size = 320 } = {}) {
  const vb = viewBox(rings, starts), S = size;
  const svg = sv('svg', { viewBox: `0 0 ${S} ${S}`, class: 'sm-mt-map', role: 'img', 'aria-label': tr('match.map_aria') });
  svg.append(sv('rect', { x: 0, y: 0, width: S, height: S, rx: 14, class: 'bg' }));
  const P = (x, y) => vb.toSvg(x, y).map(v => v * S);
  const [cx, cy] = P(0, 0);
  svg.append(sv('circle', { cx, cy, r: 4, class: 'center' }));
  if (rings.length) svg.append(sv('polyline', { points: [[0, 0], ...rings.map(r => [r.x, r.y])].map(([x, y]) => P(x, y).join(',')).join(' '), class: 'path' }));
  starts.forEach((s, i) => { const [x, y] = P(s.x, s.y); svg.append(sv('circle', { cx: x, cy: y, r: 5.5, fill: COLORS[i % COLORS.length], class: 'start' })); });
  rings.forEach(r => {
    const [x, y] = P(r.x, r.y), a = Math.atan2(r.nx, r.ny), w = Math.max(6, Math.min(16, (r.radius_m * 2) / vb.span * S));
    const dx = Math.cos(a) * w, dy = Math.sin(a) * w;   // halka düzlemi normale dik (kuş bakışında çizgi)
    svg.append(sv('line', { x1: x - dx, y1: y - dy, x2: x + dx, y2: y + dy, class: 'ring' }));
    const t = sv('text', { x: x + 7, y: y - 7, class: 'lbl' }); t.textContent = String(r.i); svg.append(t);
  });
  return svg;
}
export function profileSvg(rings = [], cfg = null, { w = 320, hgt = 90 } = {}) {
  const svg = sv('svg', { viewBox: `0 0 ${w} ${hgt}`, class: 'sm-mt-prof', role: 'img', 'aria-label': tr('match.profile_aria') });
  svg.append(sv('rect', { x: 0, y: 0, width: w, height: hgt, rx: 10, class: 'bg' }));
  if (!rings.length) return svg;
  const hi = Math.max(cfg?.max_alt_m || 0, ...rings.map(r => r.agl_m)) * 1.15 || 1, n = rings.length;
  const X = i => 18 + (w - 36) * (n === 1 ? 0.5 : i / (n - 1)), Y = a => hgt - 12 - (hgt - 24) * (a / hi);
  svg.append(sv('polyline', { points: rings.map((r, i) => `${X(i)},${Y(r.agl_m)}`).join(' '), class: 'line' }));
  rings.forEach((r, i) => { svg.append(sv('circle', { cx: X(i), cy: Y(r.agl_m), r: 4.5, class: 'pt' })); const t = sv('text', { x: X(i), y: Y(r.agl_m) - 8, class: 'lbl' }); t.textContent = `${Math.round(r.agl_m)}`; svg.append(t); });
  return svg;
}

// ---------------------------------------------------------------- sihirbaz: HALKALAR adımı
export function createRingsStep({ W, limits = LIMITS, onChange = () => {} }) {
  const d = W.drone(), t = W.track();
  const ty = d?.type || 'multirotor';
  if (!W.state.rings || W.state.rings._type !== ty) W.set('rings', { ...ringsDefaults(ty, limits), seed: 1 + Math.floor(Math.random() * 2e9), _type: ty });
  const R = W.state.rings;
  // HEPGO §41 tür: halka yarışı | it dalaşı (2 kişilik)
  const DL = { ...DF_LIMITS, ...(limits?.dogfight || {}) };
  if (!W.state.dogfight || W.state.dogfight._type !== ty) W.set('dogfight', { ...dfDefaults(dfType(ty), DL), _type: ty });
  const D = W.state.dogfight;
  if (!W.state.kind) W.set('kind', 'rings');
  const errEl = h('p', { class: 'sm-mt-err', role: 'alert', hidden: true });
  const map = h('div', { class: 'sm-mt-preview' }, h('div', { class: 'muted small' }, tr('common.loading')));
  let pvT = 0, pvSeq = 0;
  const preview = () => {
    clearTimeout(pvT);
    pvT = setTimeout(async () => {
      if (W.state.rings_err || !d || !t) return;
      const seq = ++pvSeq;
      try {
        const pv = await net.post('/api/match/rings-preview', { drone_id: d.id, track_id: t.id, rings: ringsBody(R), players: W.state.max_players || 2 });
        if (seq !== pvSeq || !map.isConnected) return;
        clear(map, ringsSvg(pv.rings, pv.starts), profileSvg(pv.rings, pv.cfg), h('p', { class: 'small muted' }, tr('match.preview_note')));
      } catch (err) { if (seq === pvSeq) clear(map, h('p', { class: 'sm-mt-err' }, err.message)); }
    }, 250);
  };
  const dfMap = h('div', { class: 'sm-mt-preview sm-df-preview' });
  const dfRules = h('p', { class: 'muted small sm-df-rules' });
  let dfT = 0, dfSeq = 0;
  const dfPreview = () => {
    clearTimeout(dfT);
    dfT = setTimeout(async () => {
      if (W.state.rings_err || !d || !t) return;
      const seq = ++dfSeq;
      try {
        const pv = await net.post('/api/match/rings-preview', { drone_id: d.id, track_id: t.id, kind: 'dogfight', dogfight: dfBodyOf(D) });
        if (seq !== dfSeq || !dfMap.isConnected) return;
        dfMap.innerHTML = dfSvg(pv.cfg, { starts: pv.starts, T: DT });
        dfMap.append(h('p', { class: 'small muted' }, DT('df.preview')));
      } catch (err) { if (seq === dfSeq) clear(dfMap, h('p', { class: 'sm-mt-err' }, err.message)); }
    }, 250);
  };
  const validate = () => {
    const df = W.state.kind === 'dogfight';
    const e = df ? (dfError(dfBodyOf(D), DL) ? 'df.err' : null) : ringsErrorKey(ringsBody(R), limits);
    W.set('rings_err', e);
    errEl.hidden = !e; errEl.textContent = e ? (df ? DT('df.err') : tr(e)) : '';
    dfRules.textContent = DT('df.rules', { r: Math.round(D.range_m), c: Math.round(D.cone_deg), h: Number(D.hold_s).toFixed(1), t: D.time_limit_min, a: Math.round(D.area_radius_m), g: Math.round(DL.guard_s || 60) });
    onChange(e);
    if (!e) (df ? dfPreview : preview)();
  };
  const num = (key, label, unit, [a, b], step = 1) => {
    const inp = h('input', { type: 'number', min: a, max: b, step, value: R[key], 'data-k': key, inputmode: 'decimal' });
    const rng = h('input', { type: 'range', min: a, max: b, step, value: R[key], 'aria-label': label });
    const set = v => { R[key] = v === '' ? '' : Number(v); inp.value = String(R[key]); rng.value = String(R[key]); validate(); };
    inp.addEventListener('input', () => set(inp.value)); rng.addEventListener('input', () => set(rng.value));
    return h('label', { class: 'sm-mt-field' }, h('span', null, label), rng, h('span', { class: 'sm-mt-num' }, inp, unit ? h('small', null, unit) : null));
  };
  const L = { ...LIMITS, ...limits };
  const dnum = (key, label, unit, [a, b], step = 1) => {
    const inp = h('input', { type: 'number', min: a, max: b, step, value: D[key], 'data-k': key, inputmode: 'decimal' });
    const rng = h('input', { type: 'range', min: a, max: b, step, value: D[key], 'aria-label': label });
    const set = v => { D[key] = v === '' ? '' : Number(v); inp.value = String(D[key]); rng.value = String(D[key]); validate(); };
    inp.addEventListener('input', () => set(inp.value)); rng.addEventListener('input', () => set(rng.value));
    return h('label', { class: 'sm-mt-field' }, h('span', null, label), rng, h('span', { class: 'sm-mt-num' }, inp, unit ? h('small', null, unit) : null));
  };
  const roles = h('div', { class: 'sm-mt-seg sm-df-roles' });
  const drawRoles = () => clear(roles, DL.roles.map(r => h('button', { type: 'button', class: D.roles === r ? 'on' : '', 'data-role': r, onclick: () => { D.roles = r; drawRoles(); validate(); } }, DT(`df.roles_${r}`))));
  drawRoles();
  const dfBox = h('div', { class: 'sm-two sm-df-box', hidden: W.state.kind !== 'dogfight' },
    h('div', null, h('h2', null, '✈ ', DT('df.kind_dogfight')), dfRules,
      h('div', { class: 'sm-mt-form' },
        dnum('distance_m', DT('df.distance'), 'm', DL.distance_m, 50), dnum('alt_m', DT('df.alt'), 'm', DL.alt_m, 5), dnum('time_limit_min', DT('df.time'), tr('match.unit_min'), DL.time_limit_min),
        dnum('range_m', DT('df.range'), 'm', DL.range_m, 10), dnum('cone_deg', DT('df.cone'), '°', DL.cone_deg), dnum('hold_s', DT('df.hold'), 's', DL.hold_s, 0.5),
        dnum('area_radius_m', DT('df.area'), 'm', DL.area_radius_m, 50),
        h('div', { class: 'sm-mt-field col' }, h('span', null, DT('df.roles')), roles))),
    h('div', { class: 'sm-preview-col' }, dfMap));
  const kinds = h('div', { class: 'sm-df-kinds', role: 'radiogroup', 'aria-label': DT('df.kind') });
  let ringsBox = null;
  const drawKinds = () => clear(kinds, ['rings', 'dogfight'].map(k => h('button', { type: 'button', class: `sm-df-kind ${W.state.kind === k ? 'on' : ''}`, 'data-kind': k,
    onclick: () => { W.set('kind', k); drawKinds(); if (ringsBox) ringsBox.hidden = k !== 'rings'; dfBox.hidden = k !== 'dogfight'; if (k === 'dogfight') W.set('max_players', 2); validate(); } },
    h('b', null, k === 'rings' ? '◎ ' : '✈ ', DT(`df.kind_${k}`)), h('small', null, DT(`df.kind_${k}_d`)))));
  drawKinds();
  const seedOut = h('b', { class: 'mono' }, String(R.seed));
  ringsBox = h('div', { class: 'sm-two', hidden: W.state.kind === 'dogfight' },
      h('div', null,
        h('h2', null, '◎ ', tr('match.rings_title')), h('p', { class: 'muted' }, tr('match.rings_sub')),
        h('div', { class: 'sm-mt-form' },
          num('count', tr('match.f_count'), '', L.count),
          num('min_alt_m', tr('match.f_min_alt'), 'm', L.alt_m),
          num('max_alt_m', tr('match.f_max_alt'), 'm', L.alt_m),
          num('diameter_m', tr('match.f_diameter'), 'm', L.diameter_m),
          num('radius_m', tr('match.f_radius'), 'm', L.radius_m, 10),
          num('time_limit_min', tr('match.f_time'), tr('match.unit_min'), L.time_limit_min),
          h('div', { class: 'sm-mt-field' }, h('span', null, tr('match.f_seed')), seedOut,
            h('button', { class: 'btn sm', type: 'button', title: tr('match.f_seed_new'), onclick: () => { R.seed = 1 + Math.floor(Math.random() * 2e9); seedOut.textContent = String(R.seed); validate(); } }, '↻ ', tr('match.f_seed_new'))))),
      h('div', { class: 'sm-preview-col' }, map));
  const el = h('div', { class: 'sm-mt-step' }, h('div', { class: 'sm-df-kindhead' }, h('h2', null, DT('df.kind'))), kinds, ringsBox, dfBox, errEl);
  validate();
  return { el };
}
// HEPGO §41: form değerleri → sunucu it dalaşı gövdesi (sayılar; _type gibi iç alanlar yok)
export function dfBodyOf(D) {
  const out = {};
  for (const k of ['distance_m', 'alt_m', 'time_limit_min', 'range_m', 'cone_deg', 'hold_s', 'area_radius_m']) if (D?.[k] !== '' && D?.[k] != null && Number.isFinite(Number(D[k]))) out[k] = k === 'time_limit_min' ? Math.round(Number(D[k])) : Number(D[k]);
  if (D?.roles) out.roles = D.roles;
  return out;
}

// ---------------------------------------------------------------- sihirbaz: DAVET adımı (oyuncu sayısı + şifre)
export function createInviteStep({ W, limits = LIMITS, onChange = () => {} }) {
  const L = { ...LIMITS, ...limits };
  if (!W.state.password) W.set('password', genPassword());
  if (W.state.max_players > L.players[1]) W.set('max_players', L.players[1]);
  const errEl = h('p', { class: 'sm-mt-err', role: 'alert', hidden: true });
  const pw = h('input', { type: 'text', class: 'mono sm-mt-pw', value: W.state.password, maxlength: L.password[1], autocomplete: 'off', spellcheck: 'false', 'aria-label': tr('match.f_password') });
  const validate = () => {
    const e = passwordErrorKey(W.state.password, L) || playersErrorKey(W.state.max_players, L);
    W.set('invite_err', e); errEl.hidden = !e; errEl.textContent = e ? tr(e, { a: L.password[0], b: L.password[1] }) : ''; onChange(e);
  };
  pw.addEventListener('input', () => { W.set('password', pw.value); validate(); });
  const players = h('div', { class: 'sm-mt-seg' });
  if (W.state.kind === 'dogfight') W.set('max_players', 2);   // HEPGO §41: it dalaşı tam 2 oyuncu
  const drawPlayers = () => clear(players, (W.state.kind === 'dogfight' ? [2] : Array.from({ length: L.players[1] - L.players[0] + 1 }, (_, i) => L.players[0] + i)).map(n =>
    h('button', { type: 'button', class: n === W.state.max_players ? 'on' : '', onclick: () => { W.set('max_players', n); drawPlayers(); validate(); } }, String(n))));
  drawPlayers();
  const el = h('div', { class: 'sm-mt-step' },
    h('h2', null, '✉ ', tr('match.invite_title')), h('p', { class: 'muted' }, tr('match.invite_sub')),
    h('div', { class: 'sm-mt-form narrow' },
      h('div', { class: 'sm-mt-field col' }, h('span', null, tr('match.f_players')), players, h('small', { class: 'muted' }, tr('match.f_players_hint', { n: L.players[1] }))),
      h('div', { class: 'sm-mt-field col' }, h('span', null, tr('match.f_password')),
        h('div', { class: 'sm-mt-pwrow' }, pw, h('button', { class: 'btn sm', type: 'button', onclick: () => { W.set('password', genPassword()); pw.value = W.state.password; validate(); } }, '↻ ', tr('match.pw_new'))),
        h('small', { class: 'muted' }, tr('match.pw_hint')))),
    errEl,
    h('ol', { class: 'sm-mt-howto' }, h('li', null, tr('match.how1')), h('li', null, tr('match.how2')), h('li', null, tr('match.how3')), h('li', null, tr('match.how4'))));
  validate();
  return { el };
}

// Sihirbaz sonu: POST /api/match → salon
export async function createMatch(payload) {
  const m = await net.post('/api/match', payload);
  try { sessionStorage.setItem(PW_KEY(m.id), payload.password); } catch { /* özel mod */ }
  return m;
}

// ---------------------------------------------------------------- ortak sayfa iskeleti
function page(view, ctx, { title, sub, body, back = '#/fly' }) {
  const go = ctx.go || (hh => { location.hash = hh; });
  const root = h('div', { class: 'sm-fly sm-mt-page' },
    h('div', { class: 'sm-mt-head' }, h('button', { class: 'btn sm-mt-backbtn', type: 'button', onclick: () => go(back) }, '← ', tr('common.back')),
      h('div', null, h('h1', null, title), sub ? h('p', { class: 'muted' }, sub) : null)), body);
  clear(view, root);
  return root;
}
const settingsList = m => {
  const s = m.settings || {}, rc = m.rings_cfg || {};
  return h('dl', { class: 'sm-mt-dl' },
    h('dt', null, tr('match.s_vehicle')), h('dd', null, `${s.drone?.name || '—'} · ${typeLbl(s.drone?.type)}`),
    h('dt', null, tr('match.s_track')), h('dd', null, `${s.track?.name || '—'} · ${WORLD_MODE_LABEL[s.track?.world_mode] || s.track?.world_mode || ''}`),
    h('dt', null, DT('df.kind')), h('dd', null, DT(isDf(m) ? 'df.kind_dogfight' : 'df.kind_rings')),
    ...(isDf(m) ? [h('dt', null, DT('df.rules').split(':')[0]), h('dd', null, dfSummary(rc, DT))] : [h('dt', null, tr('match.s_rings')), h('dd', null, ringsLine(rc))]),
    h('dt', null, tr('match.s_players')), h('dd', null, `${(m.players || []).filter(p => !OUT.has(p.status)).length} / ${m.max_players ?? '—'}`));
};

// HEPGO §41: salon şeması (başlangıçlar bilinince gerçek konumlar; roller atanınca K/Ç)
const dfSvgEl = M => {
  const st = (M.players || []).filter(p => p.start && p.role).map(p => ({ role: p.role, x: p.start.x, y: p.start.y, yaw_deg: p.start.yaw_deg }));
  const d = h('div', { class: 'sm-mt-preview sm-df-preview' }); d.innerHTML = dfSvg(M.rings_cfg || {}, { starts: st.length === 2 ? st : null, T: DT }); return d;
};

// ---------------------------------------------------------------- DAVET SAYFASI (#/fly/join/<kod>)
export async function renderJoin(view, code, ctx = {}) {
  const go = ctx.go || (hh => { location.hash = hh; });
  clear(view, h('div', { class: 'sm-fly sm-loading' }, tr('common.loading')));
  let inv;
  try { inv = await net.get(`/api/match/invite/${encodeURIComponent(code)}`); } catch (err) {
    page(view, ctx, { title: tr('match.join_title'), body: h('div', { class: 'sm-mt-card sm-mt-joinbox' }, h('p', { class: 'sm-mt-err' }, tr(joinErrorKey(err) || 'match.err_not_found')),
      h('button', { class: 'btn primary', type: 'button', onclick: () => go('#/fly') }, tr('match.to_fly'))) });
    return;
  }
  if (inv.joined && inv.id) { go(lobbyHref(inv.id)); return; }
  const pw = h('input', { type: 'password', class: 'mono sm-mt-pw', autocomplete: 'off', maxlength: 64, 'aria-label': tr('match.f_password'), placeholder: tr('match.join_pw_ph') });
  const msg = h('p', { class: 'sm-mt-err', role: 'alert', hidden: true });
  const btn = h('button', { class: 'btn primary sm-mt-joinbtn', type: 'submit' }, tr('match.join_btn'));
  const say = txt => { msg.hidden = !txt; msg.textContent = txt || ''; };
  const form = h('form', { class: 'sm-mt-joinform', onsubmit: async e => {
    e.preventDefault(); say(''); btn.disabled = true;
    try { const m = await net.post('/api/match/join', { code, password: pw.value }); toast(tr('match.joined_toast')); go(lobbyHref(m.id)); }
    catch (err) {
      const k = joinErrorKey(err);
      const det = err.detail || {};
      say(k === 'match.err_bad_password' ? tr('match.err_bad_password_n', { n: det.remaining ?? 0 }) : k === 'match.err_too_many' ? tr('match.err_too_many', { m: Math.max(1, Math.ceil((det.retry_after || 60) / 60)) }) : k ? tr(k) : err.message);
      btn.disabled = false; pw.select();
    }
  } }, h('label', { class: 'sm-mt-field col' }, h('span', null, tr('match.f_password')), pw), btn, msg);
  const logout = async () => { try { await net.del('/api/session'); } catch { /* */ } location.href = `/?giris=1&sonra=${encodeURIComponent(`/app/#/fly/join/${code}`)}`; };
  page(view, ctx, { title: tr('match.join_title'), sub: tr('match.join_sub', { n: inv.host_name || '—' }),
    body: h('div', { class: 'sm-mt-joingrid' },
      h('div', { class: 'sm-mt-card sm-mt-joinbox' },
        h('div', { class: 'sm-mt-acct' }, h('span', { class: 'muted small' }, tr('match.join_account')), h('b', { class: 'mono' }, inv.me?.email || inv.me?.name || '—'),
          h('button', { class: 'btn sm', type: 'button', onclick: logout }, tr('match.join_other'))),
        inv.kicked ? h('p', { class: 'sm-mt-err' }, tr('match.err_kicked')) : inv.state !== 'LOBI' ? h('p', { class: 'sm-mt-err' }, tr('match.err_started')) : form),
      h('div', { class: 'sm-mt-card' }, h('h3', null, tr('match.join_details')),
        h('dl', { class: 'sm-mt-dl' }, h('dt', null, tr('match.s_host')), h('dd', null, inv.host_name || '—'), h('dt', null, tr('match.s_vehicle')), h('dd', null, `${inv.drone?.name || ''} · ${typeLbl(inv.drone?.type)}`),
          h('dt', null, tr('match.s_track')), h('dd', null, `${inv.track || '—'} · ${WORLD_MODE_LABEL[inv.world_mode] || inv.world_mode || ''}`),
          h('dt', null, DT('df.kind')), h('dd', null, DT(inv.kind === 'dogfight' ? 'df.kind_dogfight' : 'df.kind_rings')),
          inv.kind === 'dogfight' ? null : h('dt', null, tr('match.s_rings')), inv.kind === 'dogfight' ? null : h('dd', null, String(inv.rings)),
          h('dt', null, tr('match.s_players')), h('dd', null, `${inv.players} / ${inv.max_players}`)))) });
  setTimeout(() => pw.focus(), 50);
}

// ---------------------------------------------------------------- BEKLEME SALONU (#/fly/match/<id>)
export async function renderLobby(view, id, ctx = {}) {
  const go = ctx.go || (hh => { location.hash = hh; });
  clear(view, h('div', { class: 'sm-fly sm-loading' }, tr('common.loading')));
  let M;
  try { M = await net.get(`/api/match/${encodeURIComponent(id)}`); } catch (err) {
    page(view, ctx, { title: tr('match.lobby_title'), body: h('div', { class: 'sm-mt-card' }, h('p', { class: 'sm-mt-err' }, tr(joinErrorKey(err) || 'match.err_not_found')), h('button', { class: 'btn primary', type: 'button', onclick: () => go('#/fly') }, tr('match.to_fly'))) });
    return;
  }
  const me = M.me;
  let left = false, ws = null, wsT = 0, pollT = 0, closed = false, entering = false;
  const players = h('ul', { class: 'sm-mt-players' });
  const side = h('div', { class: 'sm-mt-side' });
  const actions = h('div', { class: 'sm-mt-actions' });
  const banner = h('div', { class: 'sm-mt-banner', hidden: true });
  const resBox = h('div', { class: 'sm-mt-card sm-mt-results', hidden: true });
  const stateBadge = h('span', { class: 'sm-mt-state' });
  const root = page(view, ctx, { title: tr('match.lobby_title'), sub: tr('match.lobby_sub'), body: h('div', null, banner, resBox,
    h('div', { class: 'sm-mt-lobby' }, h('div', { class: 'sm-mt-card' }, h('div', { class: 'sm-mt-cardhead' }, h('h3', null, tr('match.players')), stateBadge), players, actions), side)) });
  root.dataset.matchId = String(M.id);
  const act = async (url, body, okKey) => { try { const r = await net.post(url, body); if (r?.id) apply(r); if (okKey) toast(tr(okKey)); return r; } catch (err) { toastError(err); return null; } };
  const draw = () => {
    const V = lobbyView(M, me), ph = phaseOf(M.state);
    root.dataset.state = M.state;
    clear(stateBadge, tr(STATE_KEY[M.state] || M.state)); stateBadge.className = `sm-mt-state s-${M.state}`;
    clear(players, (M.players || []).map((p, i) => h('li', { class: `${p.id === me ? 'me' : ''} ${OUT.has(p.status) ? 'out' : ''}`.trim(), 'data-uid': String(p.id) },
      h('span', { class: 'dot', style: { background: COLORS[i % COLORS.length] } }),
      h('span', { class: `online ${p.online ? 'on' : ''}`, title: tr(p.online ? 'match.online' : 'match.offline') }),
      h('span', { class: 'nm' }, p.name, p.id === me ? ` (${tr('match.you')})` : ''),
      p.host ? h('span', { class: 'sm-mt-badge host' }, tr('match.host')) : null,
      p.role ? h('span', { class: `sm-df-badge ${p.role}` }, DT(`df.${p.role}`)) : null,
      ph === 'lobby' ? h('span', { class: `sm-mt-badge ${p.ready ? 'st-hazir' : 'st-davetli'}` }, tr(p.host ? 'match.host_ready' : p.ready ? 'match.ready' : 'match.not_ready'))
        : h('span', { class: `sm-mt-badge st-${p.status}` }, tr(STATUS_KEY[p.status] || p.status)),
      V.isHost && !p.host && ph === 'lobby' ? h('button', { class: 'x-btn', type: 'button', title: tr('match.kick'), 'aria-label': tr('match.kick'), onclick: async () => {
        if (await confirmDialog(tr('match.kick'), tr('match.kick_q', { n: p.name }), { okLabel: tr('match.kick'), danger: true })) act(`/api/match/${M.id}/kick`, { user_id: p.id });
      } }, '✕') : null)),
    Array.from({ length: Math.max(0, (M.max_players || 0) - (M.players || []).length) }, () => h('li', { class: 'empty' }, h('span', { class: 'dot' }), h('span', { class: 'nm muted' }, tr('match.slot_empty')))));
    // yan sütun: davet + ayarlar + parkur
    const link = M.code ? inviteLink(location.origin, M.code) : null;
    let pwTxt = null; try { pwTxt = sessionStorage.getItem(PW_KEY(M.id)); } catch { /* */ }
    clear(side,
      ph === 'lobby' && link ? h('div', { class: 'sm-mt-card sm-mt-invite' }, h('h3', null, '✉ ', tr('match.invite_box')),
        h('p', { class: 'small muted' }, tr(V.isHost ? 'match.invite_box_host' : 'match.invite_box_guest')),
        h('div', { class: 'sm-mt-copyrow' }, h('input', { class: 'mono', readonly: true, value: link, 'aria-label': tr('match.link'), onfocus: e => e.target.select() }),
          h('button', { class: 'btn sm primary', type: 'button', onclick: () => copy(link, 'match.link_copied') }, tr('match.copy'))),
        V.isHost ? h('div', { class: 'sm-mt-copyrow' }, h('input', { class: 'mono sm-mt-pwshow', readonly: true, value: pwTxt || '••••••', 'aria-label': tr('match.f_password') }),
          pwTxt ? h('button', { class: 'btn sm', type: 'button', onclick: () => copy(pwTxt, 'match.pw_copied') }, tr('match.copy')) : null,
          h('button', { class: 'btn sm', type: 'button', onclick: async () => {
            const np = genPassword();
            if (await act(`/api/match/${M.id}/password`, { password: np }, 'match.pw_changed')) { try { sessionStorage.setItem(PW_KEY(M.id), np); } catch { /* */ } draw(); }
          } }, '↻ ', tr('match.pw_new'))) : null,
        V.isHost && pwTxt ? h('button', { class: 'btn sm sm-mt-copyall', type: 'button', onclick: () => copy(tr('match.share_text', { l: link, p: pwTxt }), 'match.both_copied') }, tr('match.copy_both')) : null,
        V.isHost && !pwTxt ? h('p', { class: 'small muted' }, tr('match.pw_hidden')) : null) : null,
      h('div', { class: 'sm-mt-card' }, h('h3', null, tr('match.settings')), settingsList(M),
        ...(isDf(M) ? [dfSvgEl(M), h('p', { class: 'small muted' }, DT('df.rules', { r: Math.round(M.rings_cfg?.range_m), c: Math.round(M.rings_cfg?.cone_deg), h: Number(M.rings_cfg?.hold_s).toFixed(1), t: M.rings_cfg?.time_limit_min, a: Math.round(M.rings_cfg?.area_radius_m), g: 60 }))]
          : [ringsSvg(M.rings || [], (M.players || []).filter(p => p.start).map(p => p.start)), profileSvg(M.rings || [], M.rings_cfg)])));
    // eylemler
    const mine = V.me;
    clear(actions,
      ph === 'lobby' && !V.isHost && mine ? h('button', { class: `btn ${mine.ready ? '' : 'primary'} sm-mt-ready`, type: 'button', onclick: () => act(`/api/match/${M.id}/ready`, { ready: !mine.ready }) }, mine.ready ? tr('match.unready_btn') : tr('match.ready_btn')) : null,
      ph === 'lobby' && V.isHost ? h('button', { class: 'sm-start-btn sm-mt-start', type: 'button', disabled: !V.canStart, title: V.canStart ? '' : tr(V.count < 2 ? 'match.need_two' : 'match.wait_ready_names', { n: V.waiting.join(', ') }),
        onclick: async e => { e.currentTarget.disabled = true; const r = await act(`/api/match/${M.id}/start`, {}); if (!r) draw(); } }, h('span', { class: 'sm-start-ring' }), h('b', null, tr('match.start_btn'))) : null,
      ph === 'lobby' && V.isHost ? h('p', { class: 'small muted sm-mt-hint' }, V.canStart ? tr('match.can_start') : V.count < 2 ? tr('match.need_two') : tr('match.wait_ready_names', { n: V.waiting.join(', ') })) : null,
      ph === 'lobby' ? h('button', { class: 'btn danger', type: 'button', onclick: async () => {
        if (!await confirmDialog(tr(V.isHost ? 'match.cancel' : 'match.leave'), tr(V.isHost ? 'match.cancel_q' : 'match.leave_q'), { okLabel: tr(V.isHost ? 'match.cancel' : 'match.leave'), danger: true })) return;
        left = true; await act(`/api/match/${M.id}/${V.isHost ? 'cancel' : 'leave'}`, {}); go('#/fly');
      } }, tr(V.isHost ? 'match.cancel' : 'match.leave')) : null,
      ph === 'race' && shouldEnterRace(M, me) ? h('button', { class: 'btn primary', type: 'button', onclick: () => go(raceHref(M.id)) }, tr('match.to_race')) : null,
      ph === 'done' || ph === 'cancel' ? h('button', { class: 'btn primary', type: 'button', onclick: () => go('#/fly') }, tr('match.to_fly')) : null);
    // durum bandı + sonuç
    banner.hidden = ph === 'lobby';
    banner.className = `sm-mt-banner b-${ph}`;
    clear(banner, ph === 'race' ? tr(M.state === 'HAZIRLIK' ? 'match.banner_prep' : 'match.banner_race') : ph === 'cancel' ? tr('match.banner_cancel', { r: tr(REASON_KEY[M.reason] || 'match.reason_server') })
      : ph === 'done' ? tr('match.banner_done') : '');
    resBox.hidden = ph !== 'done';
    if (ph === 'done') clear(resBox, h('h3', null, '⚑ ', tr('match.result_title')), isDf(M) ? h('p', { class: 'muted' }, DT(`df.r_${M.result?.reason || M.reason}`)) : null, isDf(M) ? dfResultTable(M, me) : resultTable(resultRows(M), me));
    // HAZIRLIK: kendi uçuşum açıldıysa yarış ekranına (yarış ekranından "Geri" ile dönüldüyse kendiliğinden geçilmez → "Yarışa dön" düğmesi)
    let noAuto = false; try { noAuto = sessionStorage.getItem(NOAUTO_KEY(M.id)) === '1'; } catch { /* */ }
    if (!entering && !left && !noAuto && shouldEnterRace(M, me)) { entering = true; setTimeout(() => go(raceHref(M.id)), 400); }
  };
  const apply = m => { if (!m || m.id !== M.id) return; M = { ...m, me }; draw(); };
  const openWs = () => {
    if (closed) return;
    try { ws = new WebSocket(wsUrl(`/ws/match/${encodeURIComponent(M.id)}`)); } catch { return; }
    ws.onmessage = e => { let m; try { m = JSON.parse(e.data); } catch { return; } if (m.t === 'hello' || m.t === 'match') apply(m.match); else if (m.t === 'result') apply({ ...M, result: m.result, state: 'BITTI' }); };
    ws.onclose = ev => { if (!closed && ev.code !== 4403) wsT = setTimeout(openWs, 2000); };
  };
  if (M.live !== false) { openWs(); pollT = setInterval(async () => { try { apply(await net.get(`/api/match/${M.id}`)); } catch { /* */ } }, 15000); }
  onLeave(() => { closed = true; clearTimeout(wsT); clearInterval(pollT); try { ws?.close(); } catch { /* */ } });
  draw();
  window.__smLobby = { get match() { return M; } };   // teşhis (Playwright)
}

// ---------------------------------------------------------------- YARIŞ EKRANI (#/fly/match/<id>/race)
export async function renderRace(view, id, ctx = {}, { openSession }) {
  const go = ctx.go || (hh => { location.hash = hh; });
  clear(view, h('div', { class: 'sm-fly sm-loading' }, tr('match.race_opening')));
  let M, f;
  try {
    M = await net.get(`/api/match/${encodeURIComponent(id)}`);
    const mine = (M.players || []).find(p => p.id === M.me);
    if (!mine?.flight_id || !shouldEnterRace(M, M.me)) { go(lobbyHref(id)); return; }
    f = await net.get(`/api/fly/${encodeURIComponent(mine.flight_id)}`);
    if (!f || f.ended_at || f.state === 'KAPANDI') { go(lobbyHref(id)); return; }
  } catch (err) { toastError(err); go(lobbyHref(id)); return; }
  const { createMatchHud } = await import('./match_hud.js');
  const start = { flight_id: f.flight_id ?? f.id, sim_id: f.sim_id, mp: null, ws: f.ws, session: f.session, drone: f.drone, track: f.track, pilot: f.pilot, mission: null, launch: f.launch, record: f.record, power: f.snapshot?.power, speedup: 1, site: null };
  try { sessionStorage.removeItem(NOAUTO_KEY(M.id)); } catch { /* */ }
  const match = { id: M.id, backHref: lobbyHref(M.id), onBack: () => { try { sessionStorage.setItem(NOAUTO_KEY(M.id), '1'); } catch { /* */ } },
    attach: o => createMatchHud({ ...o, mid: M.id, me: M.me, go: hh => { if (hh === lobbyHref(M.id)) match.onBack(); go(hh); } }) };
  return openSession(view, start, { drone: f.drone, track: f.track, pilot: f.pilot, mission: null, launch: f.launch, record: f.record, power: f.snapshot?.power, speedup: 1, camera: f.camera }, { ...ctx, match });
}
