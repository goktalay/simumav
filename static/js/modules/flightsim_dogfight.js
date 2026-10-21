// Uçuş Simülatörü §41 — Çok oyunculu karşılaşmada "İT DALAŞI" türü (HEPGO + SIMUMAV ortak). Saf katman (node testi tests/test_flightsim_dogfight.mjs)
// + yarış ekranı HUD'u (createDogfightHud). Sunucu otoriterdir: app/flightsim_match_core.py (it_ayar_dogrula, it_baslangiclari, ItDalasi) —
// angajman (menzil + burun konisi içinde kesintisiz tutma), süre, alan dışı, çarpma, kazanan sunucuda hesaplanır; burada yalnız gösterim.
// Kapsam: yalnız oyun mekaniği. Araca güdüm / takip komutu YOK — iki pilot da aracını kendisi uçurur.
//
// HUD: rakip işaretçisi (TD kutusu benzeri; ekran dışında kenar oku + mesafe), KOVALAYAN'da kutunun çevresinde dolan angajman halkası (tutma süresi /
// gereken) + koni/menzil durumu, KAÇAN'da "KİLİTLENİYOR!" uyarısı + uyarı sesi; üst şeritte rol, kalan süre, mesafe, rakibin bağıl irtifası, kalkış
// koruması ve alan sınırı uyarısı. 3B'de rakip uçak flightsim_match3d.js oyuncu katmanıyla çizilir.

import { edgePoint, projectView, screenDir, dirAngle } from './flightsim_tgthud.js';

// Sınırlar sunucu meta'sından gelir (`limits.dogfight`); bunlar yedek — çekirdekle aynı.
export const DF_LIMITS = {
  distance_m: [300, 1500], alt_m: [20, 400], time_limit_min: [2, 10], range_m: [50, 400], cone_deg: [15, 45], hold_s: [2, 5], area_radius_m: [300, 5000],
  roles: ['random', 'host_chaser', 'host_evader'], guard_s: 60,
  defaults: {
    dikey: { type: 'dogfight', distance_m: 400, alt_m: 40, time_limit_min: 5, range_m: 120, cone_deg: 30, hold_s: 3, area_radius_m: 800, roles: 'random', seed: null },
    ucak: { type: 'dogfight', distance_m: 1000, alt_m: 120, time_limit_min: 6, range_m: 300, cone_deg: 25, hold_s: 3, area_radius_m: 3000, roles: 'random', seed: null },
  },
};
export const KINDS = ['rings', 'dogfight'];
export const dfClass = type => (type === 'sabit_kanat' ? 'ucak' : 'dikey');
export const dfDefaults = (type, limits = DF_LIMITS) => ({ ...((limits?.defaults || DF_LIMITS.defaults)[dfClass(type)] || DF_LIMITS.defaults[dfClass(type)]) });

// Metinler: HEPGO Türkçe anahtar (tr), SIMUMAV `df.*` anahtarı (keyed)
export const DF_TEXTS = [
  ['df.kind', 'Karşılaşma türü'], ['df.kind_rings', 'Halka yarışı'], ['df.kind_dogfight', 'İt dalaşı'],
  ['df.kind_rings_d', 'Numaralı halkalardan sırayla geçen ilk oyuncu kazanır (2–8 oyuncu).'],
  ['df.kind_dogfight_d', 'İki oyuncu: KOVALAYAN rakibi menzil ve burun konisi içinde gerekli süre tutarsa kazanır; süre biterse KAÇAN kazanır.'],
  ['df.distance', 'Başlangıç mesafesi'], ['df.alt', 'Başlangıç irtifası'], ['df.time', 'Süre'], ['df.range', 'Angajman menzili'], ['df.cone', 'Angajman konisi (±)'],
  ['df.hold', 'Gereken kesintisiz süre'], ['df.area', 'Alan sınırı yarıçapı'], ['df.roles', 'Roller'], ['df.roles_random', 'Rastgele'],
  ['df.roles_host_chaser', 'Ben kovalarım'], ['df.roles_host_evader', 'Ben kaçarım'],
  ['df.chaser', 'KOVALAYAN'], ['df.evader', 'KAÇAN'], ['df.chaser_s', 'K'], ['df.evader_s', 'Ç'], ['df.role', 'Rol'],
  ['df.rules', 'Kurallar: kovalayan, kaçanı {r} m menzil ve burnunun ±{c}° konisi içinde {h} sn kesintisiz tutarsa ANGAJE olur ve kazanır. {t} dk dolarsa kaçan kazanır. {a} m alan sınırını aşan ya da yere çarpan kaybeder. İki araç da başlangıç irtifasına yaklaşana dek (en geç {g} sn) angajman sayılmaz.'],
  ['df.locking', 'KİLİTLENİYOR!'], ['df.in_cone', 'KONİ İÇİNDE'], ['df.out_cone', 'KONİ DIŞI {o}° / {c}°'], ['df.out_range', 'MENZİL DIŞI {d} / {r} m'],
  ['df.guard', 'KALKIŞ KORUMASI — {a} m’ye çıkın'], ['df.area_warn', 'ALAN SINIRI! {d} / {r} m'], ['df.left', 'Kalan'], ['df.dist', 'Mesafe'], ['df.rel_alt', 'Rakip'],
  ['df.engaged', 'ANGAJE!'], ['df.you_win', 'KAZANDINIZ'], ['df.you_lose', 'KAYBETTİNİZ'],
  ['df.r_angaje', 'Kovalayan angaje etti'], ['df.r_sure', 'Süre doldu — kaçan kazandı'], ['df.r_alan_disi', 'Alan sınırı aşıldı'], ['df.r_carpti', 'Araç çarptı'],
  ['df.r_rakip_ayrildi', 'Rakip ayrıldı'], ['df.engage_time', 'Angajman süresi'], ['df.max_hold', 'En uzun tutma'], ['df.min_dist', 'En yakın mesafe'],
  ['df.result', 'Sonuç'], ['df.won', 'Kazandı'], ['df.lost', 'Kaybetti'], ['df.rematch', 'Rövanş (roller değişir)'], ['df.rematch_open', 'Rövanş karşılaşması açıldı'],
  ['df.need_two', 'İt dalaşı tam 2 oyuncuyla oynanır: bir kullanıcı davet edin'], ['df.err', 'İt dalaşı ayarı sınır dışında'], ['df.go_chaser', 'BAŞLA! Rakibi kovalayın'], ['df.go_evader', 'BAŞLA! Kaçın'], ['df.guard_off', 'Angajman serbest'],
  ['df.role_pending', 'Herkes gelince atanır'], ['df.wait_go', 'Kalkış serbest olunca kalkın: kovalayan kaçanı angajman konisinde tutmaya çalışır.'], ['df.preview', 'Başlangıç: kovalayan (K) arkada, kaçan (Ç) önde; daire alan sınırı'],
];
const TXT = Object.fromEntries(DF_TEXTS);
const fill = (s, p) => (p ? String(s).replace(/\{(\w+)\}/g, (m, k) => (p[k] != null ? String(p[k]) : m)) : String(s));
export const makeDfT = (tr, keyed = false) => (k, p) => {
  const tx = TXT[k] ?? k;
  if (!tr) return fill(tx, p);
  if (!keyed) return tr(tx, p);
  const r = tr(k, p);
  return r && r !== k ? r : fill(tx, p);
};

/** İstemci doğrulaması (sunucuyla aynı sınırlar). Dönüş: hata metni anahtarı (df.* ya da Türkçe) ya da null. */
export function dfError(c, limits = DF_LIMITS) {
  if (!c) return 'İt dalaşı ayarı eksik';
  const L = { ...DF_LIMITS, ...(limits || {}) };
  const inR = (v, [a, b]) => Number.isFinite(Number(v)) && Number(v) >= a && Number(v) <= b;
  for (const k of ['distance_m', 'alt_m', 'time_limit_min', 'range_m', 'cone_deg', 'hold_s', 'area_radius_m']) if (c[k] != null && !inR(c[k], L[k])) return `${k} geçersiz`;
  if (c.time_limit_min != null && !Number.isInteger(Number(c.time_limit_min))) return 'time_limit_min geçersiz';
  if (c.area_radius_m != null && c.distance_m != null && Number(c.area_radius_m) < Number(c.distance_m) / 2 + 150) return 'Alan sınırı yarıçapı başlangıç mesafesinin yarısından en az 150 m büyük olmalı';
  if (c.roles != null && !L.roles.includes(c.roles)) return 'roles geçersiz';
  return null;
}
export const dfSummary = (c, T = makeDfT(null)) => (c ? `${Math.round(c.distance_m)} m · ${Math.round(c.alt_m)} m · ${c.time_limit_min} dk · ${Math.round(c.range_m)} m / ±${Math.round(c.cone_deg)}° / ${Number(c.hold_s).toFixed(1)} s · R ${Math.round(c.area_radius_m)} m · ${T(`df.roles_${c.roles || 'random'}`)}` : '—');
export const roleOf = (match, uid) => (match?.players || []).find(p => p.id === uid)?.role || match?.dogfight?.roles?.[String(uid)] || match?.result?.dogfight?.roles?.[String(uid)] || null;
export const opponentOf = (match, uid) => (match?.players || []).find(p => p.id !== uid && p.status !== 'davetli' && p.status !== 'cikarildi') || null;
/** Kalan süre (sn): time_limit_min·60 − (now − start_at). */
export const remainS = (match, now) => (match?.start_at == null ? null : Math.max(0, Number(match.rings_cfg?.time_limit_min || 0) * 60 - (Number(now) - Number(match.start_at))));
export const fmtMMSS = s => { if (s == null || !Number.isFinite(Number(s))) return '—'; const v = Math.max(0, Math.ceil(Number(s))); return `${Math.floor(v / 60)}:${String(v % 60).padStart(2, '0')}`; };
/** Koni/menzil durumu (kovalayan için): 'in' | 'cone' | 'range' | 'guard' | null. */
export function coneState(df, cfg) {
  if (!df || df.dist == null) return null;
  if (df.guard) return 'guard';
  if (df.in_cone) return 'in';
  if (df.dist > Number(cfg?.range_m ?? Infinity)) return 'range';
  return 'cone';
}
/** Sonuç satırları: [{id, name, role, won, max_speed_ms, crashes, status}] — kazanan önce. */
export function dfResultRows(match) {
  const res = match?.result || {};
  const rows = res.standings || match?.players || [];
  return rows.map(p => ({ id: p.id, name: p.name, role: p.role || res.dogfight?.roles?.[String(p.id)] || null, won: (res.winner ?? match?.winner) === p.id,
    max_speed_ms: p.max_speed_ms, crashes: p.crashes, status: p.status }));
}
/** Rakip işaretçisi: kamera pozu (sim.cameraView) + rakibin yerel konumu → {on, x, y, arrow: {x, y, ang, d}|null} (piksel). */
export function opponentMarker(view, p, W, H, inset = 70) {
  if (!view || !p) return null;
  const pr = projectView(view, [p.x, p.y, p.z]);
  const x = pr.sx * W, y = pr.sy * H, m = 8;
  if (pr.front && x >= m && x <= W - m && y >= m && y <= H - m) return { on: true, x, y, arrow: null };
  const d = screenDir(view, [p.x, p.y, p.z]);
  const rx = Math.max(40, W / 2 - inset), ry = Math.max(40, H / 2 - inset);
  const [ax, ay] = edgePoint(d, W / 2, H / 2, rx, ry);
  return { on: false, x, y, arrow: { x: ax, y: ay, ang: dirAngle(d), d } };
}

/** Kurallar şeması (SVG metni; sihirbaz önizlemesi + salon): alan sınırı dairesi, kovalayan (K) arkada, kaçan (Ç) önde, kovalayanın burnundan
 *  ±koni ve menzil kaması, aradaki mesafe. starts verilirse ({role, x, y, yaw_deg}) gerçek başlangıçlar (yerel m) kullanılır, yoksa yukarı doğru hat. */
export function dfSvg(c, { starts = null, T = makeDfT(null) } = {}) {
  if (!c) return '<svg viewBox="0 0 100 100"></svg>';
  const R = Number(c.area_radius_m) || 1000, sc = 44 / R, cx = 50, cy = 50;
  const P = (x, y) => [cx + x * sc, cy - y * sc];
  let ch, ev, yaw;
  if (starts && starts.length === 2) {
    const a = starts.find(s => s.role === 'chaser') || starts[0], b = starts.find(s => s.role === 'evader') || starts[1];
    ch = [a.x, a.y]; ev = [b.x, b.y]; yaw = Number(a.yaw_deg) || 0;
  } else { const d = Number(c.distance_m) / 2; ch = [0, -d]; ev = [0, d]; yaw = 0; }
  const h = yaw * Math.PI / 180, cone = Number(c.cone_deg) * Math.PI / 180, rng = Number(c.range_m);
  const [x0, y0] = P(...ch), [x1, y1] = P(...ev);
  const wedge = [-1, 1].map(sg => P(ch[0] + Math.sin(h + sg * cone) * rng, ch[1] + Math.cos(h + sg * cone) * rng));
  const f = v => v.toFixed(2);
  let s = `<svg viewBox="0 0 100 108" role="img" aria-label="${T('df.preview')}">`;
  s += `<circle cx="${cx}" cy="${cy}" r="44" fill="rgba(127,127,127,.06)" stroke="#94a3b8" stroke-width=".6" stroke-dasharray="2 1.5"/>`;
  s += `<text x="${cx}" y="4.6" font-size="3.2" text-anchor="middle" fill="#64748b">R ${Math.round(R)} m</text>`;
  s += `<path d="M${f(x0)} ${f(y0)} L${f(wedge[0][0])} ${f(wedge[0][1])} A${f(rng * sc)} ${f(rng * sc)} 0 0 1 ${f(wedge[1][0])} ${f(wedge[1][1])} Z" fill="rgba(239,68,68,.22)" stroke="#ef4444" stroke-width=".5"/>`;
  s += `<line x1="${f(x0)}" y1="${f(y0)}" x2="${f(x1)}" y2="${f(y1)}" stroke="#64748b" stroke-width=".5" stroke-dasharray="1.4 1.2"/>`;
  s += `<text x="${f((x0 + x1) / 2 + 2.5)}" y="${f((y0 + y1) / 2)}" font-size="3.2" fill="#64748b">${Math.round(Number(c.distance_m))} m</text>`;
  for (const [x, y, col, lb] of [[x0, y0, '#dc2626', T('df.chaser_s')], [x1, y1, '#2563eb', T('df.evader_s')]]) {
    s += `<circle cx="${f(x)}" cy="${f(y)}" r="3" fill="${col}" stroke="#fff" stroke-width=".6"/><text x="${f(x)}" y="${f(y + 1.2)}" font-size="3.4" font-weight="800" text-anchor="middle" fill="#fff">${lb}</text>`;
    s += `<line x1="${f(x)}" y1="${f(y)}" x2="${f(x + Math.sin(h) * 6)}" y2="${f(y - Math.cos(h) * 6)}" stroke="${col}" stroke-width="1" marker-end=""/>`;
  }
  s += `<text x="2" y="104" font-size="3.1" fill="#64748b">${T('df.chaser_s')} = ${T('df.chaser')} · ${T('df.evader_s')} = ${T('df.evader')} · ${Math.round(rng)} m / ±${Math.round(Number(c.cone_deg))}° · ${Number(c.hold_s).toFixed(1)} s</text>`;
  return `${s}</svg>`;
}

// ---------------------------------------------------------------- DOM: yarış ekranı HUD'u
const CSS = `
.fs-df-cv{position:absolute;inset:0;z-index:5;pointer-events:none}
.fs-df-bar{position:absolute;top:132px;left:50%;transform:translateX(-50%);z-index:7;pointer-events:none;display:flex;gap:12px;align-items:center;padding:6px 12px;border-radius:12px;
  background:rgba(10,14,22,.78);color:#e6edf3;border:1px solid rgba(255,255,255,.16);font:600 12.5px/1.2 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;white-space:nowrap;box-shadow:0 8px 24px rgba(0,0,0,.35)}
.fs-df-bar[hidden]{display:none}
.fs-df-bar .role{font-weight:800;letter-spacing:.1em;padding:3px 8px;border-radius:7px}
.fs-df-bar .role.chaser{background:#b91c1c;color:#fff}.fs-df-bar .role.evader{background:#1d4ed8;color:#fff}
.fs-df-bar i{font-style:normal;opacity:.6;margin-right:4px}
.fs-df-bar .warn{color:#facc15;font-weight:800}.fs-df-bar .bad{color:#f87171;font-weight:800}
.fs-df-alert{position:absolute;top:184px;left:50%;transform:translateX(-50%);z-index:8;pointer-events:none;padding:10px 22px;border-radius:12px;background:rgba(185,28,28,.88);
  color:#fff;font:900 26px/1.1 system-ui,sans-serif;letter-spacing:.08em;border:2px solid #fecaca;box-shadow:0 0 30px rgba(248,113,113,.65);text-align:center}
.fs-df-alert[hidden]{display:none}
.fs-df-alert.blink{animation:fsDfBlink .5s steps(2) infinite}
.fs-df-alert .pb{height:6px;border-radius:3px;background:rgba(255,255,255,.25);margin-top:8px;overflow:hidden}.fs-df-alert .pb b{display:block;height:100%;background:#fff}
@keyframes fsDfBlink{50%{opacity:.35}}
.fs-mob .fs-df-bar{top:62px;font-size:11px;gap:8px}.fs-mob .fs-df-alert{top:110px;font-size:20px}
`;
function ensureCss() {
  if (typeof document === 'undefined' || document.getElementById('fs-df-css')) return;
  const s = document.createElement('style'); s.id = 'fs-df-css'; s.textContent = CSS; document.head.appendChild(s);
}
let actx = null;
function beep(f = 1400, d = 0.07, n = 2) {
  try {
    actx ??= new (window.AudioContext || window.webkitAudioContext)();
    let t = actx.currentTime + 0.01;
    for (let k = 0; k < n; k++) {
      const o = actx.createOscillator(), g = actx.createGain();
      o.type = 'square'; o.frequency.value = f; g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.07, t + 0.01); g.gain.exponentialRampToValueAtTime(0.0001, t + d);
      o.connect(g).connect(actx.destination); o.start(t); o.stop(t + d + 0.02); t += d + 0.05;
    }
  } catch { /* ses yok */ }
}
const el = (tag, cls, txt) => { const e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; };

/**
 * createDogfightHud(stage, { getSim, tr, keyed, me, sound }) → { update(match, pos, now), setPos(pFrame), dispose(), state() }
 * match: anlık görüntü (kind 'dogfight'); pos: son `pos` çerçevesi ({p[], df}); now: sunucu saati (sn).
 */
export function createDogfightHud(stage, o = {}) {
  ensureCss();
  const T = makeDfT(o.tr, o.keyed), getSim = o.getSim || (() => null), me = o.me;
  const cv = el('canvas', 'fs-df-cv'); const g = cv.getContext('2d');
  const bar = el('div', 'fs-df-bar'); bar.hidden = true;
  const alert = el('div', 'fs-df-alert'); alert.hidden = true;
  stage.append(cv, bar, alert);
  let W = 0, H = 0, dpr = 1, raf = 0, disposed = false, lastBeep = 0;
  const S = { match: null, frame: null, now: 0, nowAt: 0, sim: null };
  const resize = () => { W = Math.max(1, stage.clientWidth); H = Math.max(1, stage.clientHeight); dpr = Math.min(globalThis.devicePixelRatio || 1, 2); cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr); cv.style.width = `${W}px`; cv.style.height = `${H}px`; };
  const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(resize) : null; ro?.observe(stage); resize();
  const myRole = () => roleOf(S.match, me);
  const oppId = () => opponentOf(S.match, me)?.id;
  const cfg = () => S.match?.rings_cfg || {};
  const local = (sim, p) => { const L = sim.toLocal(Number(p.lat), Number(p.lon)); return { x: L.x, y: L.y, z: Number(p.alt_msl) - Number(sim.homeAlt ?? 0) }; };

  function drawBar(now) {
    const M = S.match;
    if (!M || !['GERI_SAYIM', 'YARIS'].includes(M.state)) { bar.hidden = true; return; }
    const role = myRole(), df = S.frame?.df || M.dogfight || {}, C = cfg();
    const mine = S.frame?.p?.find(p => p.id === me), opp = S.frame?.p?.find(p => p.id === oppId());
    const parts = [];
    const sp = (k, v, cls) => { const s = el('span', cls); if (k) s.append(el('i', null, k)); s.append(v); return s; };
    parts.push(el('span', `role ${role || ''}`, role ? T(`df.${role}`) : '—'));
    parts.push(sp(T('df.left'), fmtMMSS(remainS(M, now))));
    if (df.dist != null) parts.push(sp(T('df.dist'), `${Math.round(df.dist)} m`));
    if (mine && opp && mine.alt_msl != null && opp.alt_msl != null) { const dz = Number(opp.alt_msl) - Number(mine.alt_msl); parts.push(sp(T('df.rel_alt'), `${dz >= 0 ? '↑' : '↓'}${Math.abs(dz).toFixed(0)} m`)); }
    if (M.state === 'YARIS' && df.guard) parts.push(el('span', 'warn', T('df.guard', { a: Math.round(Number(C.alt_m || 0) * 0.8) })));
    else if (M.state === 'YARIS' && role === 'chaser') {
      const cs = coneState(df, C);
      if (cs === 'in') parts.push(el('span', 'bad', `${T('df.in_cone')} ${Number(df.hold_s || 0).toFixed(1)}/${Number(df.need_s || C.hold_s || 0).toFixed(1)} s`));
      else if (cs === 'range') parts.push(el('span', null, T('df.out_range', { d: Math.round(df.dist), r: Math.round(C.range_m) })));
      else if (cs === 'cone') parts.push(el('span', null, T('df.out_cone', { o: Math.round(df.off_deg ?? 0), c: Math.round(C.cone_deg) })));
    }
    if (mine && getSim()) {   // alan sınırı (merkezden yatay)
      const L = getSim().toLocal(Number(mine.lat), Number(mine.lon)), r = Math.hypot(L.x, L.y), R = Number(C.area_radius_m || 0);
      if (R && r > 0.85 * R) parts.push(el('span', 'bad', T('df.area_warn', { d: Math.round(r), r: Math.round(R) })));
    }
    bar.replaceChildren(...parts); bar.hidden = false;
  }
  function drawAlert(now) {
    const M = S.match, df = S.frame?.df;
    const role = myRole();
    if (M?.state === 'YARIS' && role === 'evader' && df?.in_cone && !df.guard) {
      const f = Math.min(1, Number(df.hold_s || 0) / Number(df.need_s || 1));
      alert.className = 'fs-df-alert blink';
      const pb = el('div', 'pb'); const b = el('b'); b.style.width = `${Math.round(f * 100)}%`; pb.append(b);
      alert.replaceChildren(el('div', null, `⚠ ${T('df.locking')}`), pb);
      alert.hidden = false;
      if (o.sound !== false && now - lastBeep > 0.45) { lastBeep = now; beep(1500, 0.06, 2); }
    } else alert.hidden = true;
  }
  function drawMarker() {
    g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, W, H);
    const M = S.match, sim = getSim();
    if (!M || !sim || !['GERI_SAYIM', 'YARIS'].includes(M.state) || !sim.cameraView || !sim.toLocal) return;
    const opp = S.frame?.p?.find(p => p.id === oppId());
    if (!opp || opp.lat == null) return;
    const view = sim.cameraView();
    const mk = opponentMarker(view, local(sim, opp), W, H);
    if (!mk) return;
    const df = S.frame?.df || {}, role = myRole(), C = cfg();
    const hot = role === 'chaser' ? !!df.in_cone : role === 'evader' ? !!df.in_cone : false;
    const col = role === 'chaser' ? (hot ? '#ff4d3d' : '#ffd23f') : '#7dd3fc';
    const OUT = 'rgba(0,0,0,.8)';
    const stroke = (w, c = col) => { g.lineWidth = w + 2; g.strokeStyle = OUT; g.stroke(); g.lineWidth = w; g.strokeStyle = c; g.stroke(); };
    const text = (s, x, y, al = 'center', px = 12, c = col) => { g.font = `700 ${px}px ui-monospace,SFMono-Regular,Menlo,monospace`; g.textAlign = al; g.textBaseline = 'middle'; g.lineWidth = 3; g.strokeStyle = OUT; g.strokeText(s, x, y); g.fillStyle = c; g.fillText(s, x, y); };
    const name = (M.players || []).find(p => p.id === opp.id)?.name || '';
    const dist = df.dist != null ? `${Math.round(df.dist)} m` : '';
    if (mk.on) {
      const h = 22;
      g.beginPath(); g.rect(mk.x - h, mk.y - h, 2 * h, 2 * h); stroke(1.6);
      g.beginPath(); g.moveTo(mk.x, mk.y - 5); g.lineTo(mk.x + 5, mk.y); g.lineTo(mk.x, mk.y + 5); g.lineTo(mk.x - 5, mk.y); g.closePath(); stroke(1.4);
      if (role === 'chaser' && M.state === 'YARIS') {   // angajman halkası: tutma / gereken
        const f = Math.min(1, Number(df.hold_s || 0) / Number(df.need_s || C.hold_s || 1));
        g.beginPath(); g.arc(mk.x, mk.y, h + 9, 0, 2 * Math.PI); g.lineWidth = 5; g.strokeStyle = 'rgba(0,0,0,.45)'; g.stroke();
        if (f > 0) { g.beginPath(); g.arc(mk.x, mk.y, h + 9, -Math.PI / 2, -Math.PI / 2 + 2 * Math.PI * f); g.lineWidth = 4; g.strokeStyle = f >= 1 ? '#22c55e' : '#ff4d3d'; g.stroke(); }
      }
      text(name.slice(0, 18), mk.x, mk.y - h - 20, 'center', 12);
      const mine = S.frame?.p?.find(p => p.id === me);
      const dz = mine && opp.alt_msl != null && mine.alt_msl != null ? Number(opp.alt_msl) - Number(mine.alt_msl) : null;
      text([dist, dz != null ? `${dz >= 0 ? '+' : '−'}${Math.abs(dz).toFixed(0)}m` : ''].filter(Boolean).join('  '), mk.x, mk.y + h + 20, 'center', 12);
    } else if (mk.arrow) {
      const { x, y, d } = mk.arrow, s = 15, nx = -d[1], ny = d[0];
      g.beginPath(); g.moveTo(x + d[0] * s, y + d[1] * s); g.lineTo(x - d[0] * s * 0.4 + nx * s * 0.75, y - d[1] * s * 0.4 + ny * s * 0.75); g.lineTo(x - d[0] * s * 0.4 - nx * s * 0.75, y - d[1] * s * 0.4 - ny * s * 0.75); g.closePath();
      g.fillStyle = col; g.lineWidth = 2.4; g.strokeStyle = OUT; g.stroke(); g.fill();
      text(dist, x - d[0] * 34, y - d[1] * 34, 'center', 12);
    }
  }
  function frame(fromTimer = false) {
    if (disposed) return;
    if (fromTimer !== true) raf = requestAnimationFrame(frame);
    const now = S.now + (performance.now() - S.nowAt) / 1000;
    try { drawMarker(); drawBar(now); drawAlert(now); } catch { /* yarım kurulum */ }
  }
  raf = requestAnimationFrame(frame);
  const iv = setInterval(() => frame(true), 100);   // yavaş WebGL karelerinde de güncel
  return {
    update(match, now) { S.match = match; if (now != null) { S.now = Number(now); S.nowAt = performance.now(); } },
    setPos(fr) { S.frame = fr; },
    state: () => ({ role: myRole(), opponent: oppId() ?? null, df: S.frame?.df || null, alert: !alert.hidden, bar: bar.textContent }),
    dispose() { disposed = true; cancelAnimationFrame(raf); clearInterval(iv); ro?.disconnect(); cv.remove(); bar.remove(); alert.remove(); },
  };
}
