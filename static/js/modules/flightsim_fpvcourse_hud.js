// Uçuş Simülatörü §47 — FPV PARKUR YARIŞI HUD'u (HEPGO + SIMUMAV ortak; DOM + 2B tuval, three.js yok). FPV OSD'si (§22, `pilot`) açıkken de görünür ve
// OSD tarzındadır (beyaz monospace, ince siyah kontur). HEPGO DOM'una bağlı değildir: metinler `T` (makeFpvT) ile dışarıdan, sahne öğesi `stage`.
// • Üst şerit: TUR x/y · anlık tur süresi · EN İYİ tur · TOPLAM (yarış saati) · HAYALET farkı (+ kırmızı / − yeşil) · CEZA toplamı; altında sektör
//   kutuları (kişisel en iyi yeşil, genel en iyi mor, yavaş sarı) · sıradaki kapı numarası.
// • Bildirimler (orta üst, kısa): kapı kaçırıldı / çarpma (+ceza) / başlangıca dönüldü / ters yön / tur sonu / en iyi tur / sektör rekoru / bitiş.
// • Sıradaki kapı işaretçisi (tuval): kapı açıklığının ekran izdüşümüne köşe parantezli çerçeve + mesafe; ekran dışındaysa kenar oku + mesafe
//   (flightsim_tgthud.projectView; FPV balıkgözü katsayıları sim.cameraView'dan).
// • FPV görünümünde altta İKİ KÜÇÜK ÇUBUK-KONUMU GÖSTERGESİ (sol gaz/sapma, sağ yunuslama/yatış; mod-2) — sanal kumanda / fiziksel kumanda (getRc → PWM
//   kanalları) ya da telemetri RC'si; aç/kapa localStorage `fs.fpv.sticks` (sticksRow(): FPV menüsü satırı).
// API: createFpvCourseHud(stage, { getSim, T, me, sfx, getRc, getTele, storage }) → { setMatch(M), setNow(serverNow), event(m), setGhost({splits, name}|null),
//   setPb({sectors}|null), setRecordSectors({n: s}|null), sticksRow(), state(), dispose() }.
import { bestSectors, fmtDelta, fmtLap, gateCorners, ghostDelta, makeFpvT, nextCheckpoint, progressInfo, sectorClass, stickPositions, sticksPref } from './flightsim_fpvcourse.js';
import { edgePoint, projectView, screenDir } from './flightsim_tgthud.js';

const CSS = `
.fs-fc-cv{position:absolute;inset:0;z-index:7;pointer-events:none}
.fs-fc-bar{position:absolute;top:58px;left:50%;transform:translateX(-50%);z-index:8;pointer-events:none;display:flex;flex-direction:column;align-items:center;gap:4px;
  font:700 15px/1.15 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;color:#f4f6f8;text-shadow:0 0 2px #000,0 0 2px #000,1px 1px 0 #000,-1px -1px 0 #000;white-space:nowrap}
.fs-fc-bar[hidden]{display:none}
.fs-fc-row{display:flex;gap:14px;align-items:baseline;padding:4px 12px;border-radius:10px;background:rgba(6,10,16,.42)}
.fs-fc-row i{font-style:normal;font-weight:500;opacity:.72;margin-right:5px;font-size:12px;letter-spacing:.06em}
.fs-fc-row .big{font-size:20px}
.fs-fc-row .good{color:#4ade80}.fs-fc-row .bad{color:#f87171}.fs-fc-row .pen{color:#fbbf24}
.fs-fc-sec{display:flex;gap:5px}
.fs-fc-sec span{min-width:62px;text-align:center;padding:2px 6px;border-radius:6px;font-size:12px;font-weight:700;background:rgba(6,10,16,.5);border:1px solid rgba(255,255,255,.18);text-shadow:none}
.fs-fc-sec span.green{background:#15803d;border-color:#4ade80}.fs-fc-sec span.purple{background:#7e22ce;border-color:#c084fc}.fs-fc-sec span.yellow{background:#a16207;border-color:#fde047}
.fs-fc-sec span.cur{border-color:#f4f6f8;border-style:dashed}
.fs-stage.fs-osd-on .fs-fc-bar{top:96px}
.fs-fc-note{position:absolute;top:190px;left:50%;transform:translateX(-50%);z-index:9;pointer-events:none;padding:6px 18px;border-radius:10px;
  font:800 22px/1.15 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;letter-spacing:.06em;color:#fff;text-shadow:0 0 3px #000,1px 1px 0 #000;background:rgba(6,10,16,.55);border:2px solid #fff;transition:opacity .35s}
.fs-fc-note.red{border-color:#f87171;color:#fecaca}.fs-fc-note.orange{border-color:#fb923c;color:#ffedd5}.fs-fc-note.green{border-color:#4ade80;color:#dcfce7}
.fs-fc-note.purple{border-color:#c084fc;color:#f3e8ff}.fs-fc-note.gold{border-color:#facc15;color:#fef9c3;box-shadow:0 0 28px rgba(250,204,21,.55)}
.fs-fc-sticks{position:absolute;left:50%;transform:translateX(-50%);bottom:calc(var(--fs-bar-h, 54px) + 70px);z-index:8;pointer-events:none;display:flex;gap:18px}
.fs-fc-sticks[hidden]{display:none}
.fs-fc-stick{width:62px;height:62px;border:2px solid rgba(244,246,248,.85);border-radius:8px;position:relative;background:rgba(6,10,16,.28);box-shadow:0 0 0 1px #000}
.fs-fc-stick::before,.fs-fc-stick::after{content:'';position:absolute;background:rgba(244,246,248,.35)}
.fs-fc-stick::before{left:50%;top:4px;bottom:4px;width:1px}.fs-fc-stick::after{top:50%;left:4px;right:4px;height:1px}
.fs-fc-stick b{position:absolute;width:12px;height:12px;margin:-6px 0 0 -6px;border-radius:50%;background:#f4f6f8;box-shadow:0 0 0 2px #000,0 0 8px rgba(74,222,128,.8);left:50%;top:50%}
.fs-mob .fs-fc-bar{top:54px;font-size:12px}.fs-mob .fs-fc-row .big{font-size:15px}.fs-mob .fs-fc-sec span{min-width:44px;font-size:10px}
`;
function ensureCss() {
  if (typeof document === 'undefined' || document.getElementById('fs-fc-css')) return;
  const s = document.createElement('style'); s.id = 'fs-fc-css'; s.textContent = CSS; document.head.appendChild(s);
}
export const ensureFpvHudCss = ensureCss;
const el = (tag, cls, txt) => { const e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; };

export function createFpvCourseHud(stage, o = {}) {
  ensureCss();
  const T = o.T || makeFpvT(null), getSim = o.getSim || (() => null), me = o.me;
  const cv = el('canvas', 'fs-fc-cv'), g = cv.getContext('2d');
  const bar = el('div', 'fs-fc-bar'); bar.hidden = true;
  const row1 = el('div', 'fs-fc-row'), secs = el('div', 'fs-fc-sec');
  bar.append(row1, secs);
  const note = el('div', 'fs-fc-note'); note.style.opacity = '0';
  const sticks = el('div', 'fs-fc-sticks'); sticks.hidden = true;
  const stL = el('div', 'fs-fc-stick'), stR = el('div', 'fs-fc-stick'); const kL = el('b'), kR = el('b'); stL.append(kL); stR.append(kR); sticks.append(stL, stR);
  stage.append(cv, bar, note, sticks);
  const sp = sticksPref(o.storage || null);
  let sticksOn = sp.get();
  let W = 0, H = 0, dpr = 1, raf = 0, disposed = false, noteT = 0;
  const S = { M: null, now: 0, nowAt: 0, lapStart: null, splits: [], lapTimes: [], best: null, pen: 0, secRows: [], secBest: {}, pbSec: {}, recSec: {}, ghost: null, delta: null, finished: null, lastNext: null, hasNext: false };
  const resize = () => { W = Math.max(1, stage.clientWidth); H = Math.max(1, stage.clientHeight); dpr = Math.min(globalThis.devicePixelRatio || 1, 2); cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr); cv.style.width = `${W}px`; cv.style.height = `${H}px`; };
  const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(resize) : null; ro?.observe(stage); resize();
  const cps = () => S.M?.rings || [];
  const cfg = () => S.M?.rings_cfg || {};
  const raceT = () => (S.M?.start_at == null ? null : S.now + (performance.now() - S.nowAt) / 1000 - Number(S.M.start_at));
  const myRow = () => (S.M?.players || []).find(p => p.id === me) || null;
  const nextI = () => { if (S.hasNext) return S.lastNext; const p = myRow(); return p?.finished ? null : p?.next ?? 1; };

  function flashNote(text, tone = 'green', ms = 1700) {
    note.className = `fs-fc-note ${tone}`; note.textContent = text; note.style.opacity = '1';
    clearTimeout(noteT); noteT = setTimeout(() => { note.style.opacity = '0'; }, ms);
  }
  const span = (k, v, cls = '') => { const s = el('span', cls); if (k) s.append(el('i', null, k)); s.append(String(v)); return s; };

  function drawBar() {
    const M = S.M;
    if (!M || M.state !== 'YARIS') { bar.hidden = true; return; }
    const t = raceT(), info = progressInfo(cps(), nextI(), Number(cfg().laps) || null);
    const lapNo = S.finished != null ? info.laps : Math.max(1, info.lap);
    const lapT = S.finished != null ? null : S.lapStart != null && t != null ? t - S.lapStart : null;
    const parts = [span(T('fpv.lap'), `${lapNo}/${info.laps}`, 'big'), span('', lapT != null ? fmtLap(lapT) : info.lap === 0 ? T('fpv.to_start') : '—', 'big'),
      span(T('fpv.best'), S.best != null ? fmtLap(S.best) : '—'), span(T('fpv.total'), t != null ? fmtLap(S.finished ?? Math.max(0, t)) : '—')];
    if (S.ghost) parts.push(span(T('fpv.ghost_hud'), S.delta != null ? fmtDelta(S.delta, 2) : '—', S.delta == null ? '' : S.delta > 0 ? 'bad' : 'good'));
    if (S.pen > 0) parts.push(span(T('fpv.pen'), `+${S.pen.toFixed(1)}`, 'pen'));
    if (!info.done && info.lap > 0) parts.push(span('', T('fpv.next_gate', { i: info.gateNo, n: info.gatesPerLap })));
    row1.replaceChildren(...parts);
    // sektör kutuları: geçerli turun sektörleri (bitenler renkli, sürmekte olan kesik çizgili)
    const nSec = Math.max(1, ...cps().filter(c => c.lap === 1).map(c => c.sector || 1));
    const rowS = S.secRows[S.secRows.length - 1] || [];
    const curLap = info.lap;
    const boxes = [];
    for (let k = 1; k <= nSec; k++) {
      const s = rowS[k - 1];
      const cls = s != null ? sectorClass(s, { pb: S.pbSec[k] ?? null, best: S.recSec[k] ?? null }) : (info.checkpoint?.sector === k && curLap > 0 ? 'cur' : '');
      boxes.push(span('', s != null ? `${T('fpv.sector_n', { n: k })} ${s.toFixed(2)}` : T('fpv.sector_n', { n: k }), cls === 'none' ? '' : cls));
    }
    secs.replaceChildren(...boxes);
    bar.hidden = false;
  }

  function drawMarker() {
    g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, W, H);
    const sim = getSim(), M = S.M;
    if (!M || !sim?.cameraView || M.state !== 'YARIS' || S.finished != null) return;
    const cp = nextCheckpoint(cps(), nextI());
    if (!cp) return;
    const view = sim.cameraView?.(); if (!view) return;
    const zr = Number(cp.alt_msl) - Number(cp.z) - Number(sim.homeAlt ?? 0);
    const corners = gateCorners({ kind: cp.kind, x: cp.x, y: cp.y, z: cp.z + (Number.isFinite(zr) ? zr : 0), yaw: cp.yaw_deg, w: cp.w, h: cp.h, r: cp.shape === 'circle' ? cp.w / 2 : undefined }, 12);
    const pr = corners.map(p => projectView(view, p));
    const cam = view.pos, dist = Math.hypot(cp.x - cam[0], cp.y - cam[1], cp.z + (zr || 0) - cam[2]);
    const OUT = 'rgba(0,0,0,.85)', col = '#4ade80';
    const text = (s, x, y, al = 'center', px = 13) => { g.font = `700 ${px}px ui-monospace,SFMono-Regular,Menlo,monospace`; g.textAlign = al; g.textBaseline = 'middle'; g.lineWidth = 3; g.strokeStyle = OUT; g.strokeText(s, x, y); g.fillStyle = '#f4f6f8'; g.fillText(s, x, y); };
    const allFront = pr.every(p => p.front);
    const xs = pr.map(p => p.sx * W), ys = pr.map(p => p.sy * H);
    const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
    if (allFront && x1 > 8 && x0 < W - 8 && y1 > 8 && y0 < H - 8) {
      const pad = 6, L = Math.max(8, Math.min(26, (x1 - x0) * 0.28, (y1 - y0) * 0.28));
      const bx0 = x0 - pad, by0 = y0 - pad, bx1 = x1 + pad, by1 = y1 + pad;
      g.beginPath();
      for (const [cx, cy, sx, sy] of [[bx0, by0, 1, 1], [bx1, by0, -1, 1], [bx1, by1, -1, -1], [bx0, by1, 1, -1]]) { g.moveTo(cx + sx * L, cy); g.lineTo(cx, cy); g.lineTo(cx, cy + sy * L); }
      g.lineWidth = 4.5; g.strokeStyle = OUT; g.stroke(); g.lineWidth = 2.5; g.strokeStyle = col; g.stroke();
      text(`${Math.round(dist)} m`, (bx0 + bx1) / 2, by1 + 14);
      return;
    }
    const c = [cp.x, cp.y, cp.z + (zr || 0)], d = screenDir(view, c);
    const [ax, ay] = edgePoint(d, W / 2, H / 2, Math.max(40, W / 2 - 80), Math.max(40, H / 2 - 90));
    const s = 15, nx = -d[1], ny = d[0];
    g.beginPath(); g.moveTo(ax + d[0] * s, ay + d[1] * s); g.lineTo(ax - d[0] * s * 0.4 + nx * s * 0.75, ay - d[1] * s * 0.4 + ny * s * 0.75); g.lineTo(ax - d[0] * s * 0.4 - nx * s * 0.75, ay - d[1] * s * 0.4 - ny * s * 0.75); g.closePath();
    g.fillStyle = col; g.lineWidth = 2.4; g.strokeStyle = OUT; g.stroke(); g.fill();
    text(`${Math.round(dist)} m`, ax - d[0] * 36, ay - d[1] * 36);
  }

  function drawSticks() {
    const sim = getSim(), on = sticksOn && sim?.getCamera?.() === 'pilot' && S.M && ['GERI_SAYIM', 'YARIS', 'BITTI'].includes(S.M.state);
    if (!on) { sticks.hidden = true; return; }
    let src = null;
    try { src = o.getRc?.() ?? null; } catch { src = null; }
    if (!src) src = o.getTele?.()?.rc ?? null;
    const p = stickPositions(src) || { left: { x: 0, y: -1 }, right: { x: 0, y: 0 } };
    const put = (k, a) => { k.style.left = `${50 + a.x * 42}%`; k.style.top = `${50 - a.y * 42}%`; };
    put(kL, p.left); put(kR, p.right);
    sticks.hidden = false;
  }

  function frame(fromTimer = false) {
    if (disposed) return;
    if (fromTimer !== true) raf = requestAnimationFrame(frame);
    try { drawMarker(); drawSticks(); } catch { /* yarım kurulum */ }
  }
  raf = requestAnimationFrame(frame);
  const iv = setInterval(() => { try { drawBar(); } catch { /* */ } frame(true); }, 100);

  // ---- olaylar (WS): yalnız benimkiler HUD'u değiştirir; diğer oyuncuların sektörleri genel en iyiyi besler (çok oyunculu)
  function event(m) {
    if (!m || !S.M) return;
    const mine = m.id === me, fx = o.sfx;
    switch (m.t) {
      case 'ring': {
        if (!mine) return;
        const cp = cps().find(c => c.i === m.i);
        S.splits[m.i - 1] = Number(m.elapsed_s);
        if (cp && cp.gate === 0) S.lapStart = Number(m.elapsed_s);
        if (m.pen_s != null) S.pen = Number(m.pen_s);
        S.lastNext = m.i + 1 > (m.total ?? cps().length) ? null : m.i + 1; S.hasNext = true;
        if (S.ghost?.splits) { const d = ghostDelta(S.splits, S.ghost.splits, m.i - 1); if (d != null) { const prev = S.delta; S.delta = d; if (prev != null && Math.sign(prev) !== Math.sign(d) && fx) fx.play(d < 0 ? 'ghost_ahead' : 'ghost_behind'); } }
        if (cp?.lap === 0 && fx) fx.play('ring', { i: 1, n: 8 });
        break;
      }
      case 'sector': {
        const k = Number(m.sector), s = Number(m.s);
        if (!mine) { if (S.recSec[k] == null || s < S.recSec[k]) S.recSec[k] = s; return; }
        while (S.secRows.length < Math.max(1, Number(m.lap))) S.secRows.push([]);
        S.secRows[Number(m.lap) - 1][k - 1] = s;
        const cls = sectorClass(s, { pb: S.pbSec[k] ?? null, best: S.recSec[k] ?? null });
        if (cls === 'purple') { flashNote(T('fpv.sector_best'), 'purple', 1300); fx?.play('sector_best'); }
        if (S.pbSec[k] == null || s < S.pbSec[k]) S.pbSec[k] = s;
        break;
      }
      case 'lap': {
        if (!mine) return;
        S.lapTimes.push(Number(m.s));
        const isBest = S.best == null || Number(m.s) < S.best;
        if (isBest) S.best = Number(m.s);
        flashNote(`${T('fpv.lap_done', { n: m.lap, t: fmtLap(m.s) })}${isBest && S.lapTimes.length > 1 ? ` · ${T('fpv.best_lap_new')}` : ''}`, isBest && S.lapTimes.length > 1 ? 'purple' : 'green', 1900);
        fx?.play('lap', { best: isBest });
        if (Number(m.lap) < Number(cfg().laps || 0)) S.secRows.push([]);
        break;
      }
      case 'miss': if (mine) { S.pen = Number(m.total_pen_s ?? S.pen); flashNote(T('fpv.missed', { s: Number(m.pen_s || 0).toFixed(0) }), 'orange'); fx?.play('miss'); } break;
      case 'hit': if (mine) { S.pen = Number(m.total_pen_s ?? S.pen); flashNote(Number(m.pen_s) > 0 ? T('fpv.hit', { s: Number(m.pen_s).toFixed(0) }) : T('fpv.hit0'), 'red', 1300); fx?.play('hit'); } break;
      case 'reset': if (mine) flashNote(T('fpv.reset'), 'orange', 2200); break;
      case 'wrong_way': if (mine) { flashNote(T('fpv.wrong'), 'red'); fx?.play('wrong'); } break;
      case 'finish': if (mine) { S.finished = Number(m.total_s ?? m.elapsed_s); S.pen = Number(m.pen_s ?? S.pen); S.lastNext = null; S.hasNext = true; flashNote(T('fpv.finished', { t: fmtLap(S.finished) }), 'gold', 3500); fx?.play('finish'); } break;
      case 'pos': { const p = (m.p || []).find(x => x.id === me); if (p) { if (p.next !== undefined) { S.lastNext = p.next; S.hasNext = true; } if (p.pen != null) S.pen = Number(p.pen); } break; }
      default:
    }
    drawBar();
  }

  return {
    setMatch(M) {
      S.M = M;
      const p = myRow();
      if (p?.fpv) {   // geç katılım / yeniden yükleme: sunucu özetinden
        const f = p.fpv;
        if (Array.isArray(f.splits) && f.splits.length > S.splits.length) S.splits = [...f.splits];
        if (Array.isArray(f.lap_times) && f.lap_times.length > S.lapTimes.length) { S.lapTimes = [...f.lap_times]; S.best = f.best_lap_s ?? S.best; }
        if (Array.isArray(f.sectors) && f.sectors.length >= S.secRows.length) S.secRows = f.sectors.map(r => [...r]);
        if (f.pen_s != null) S.pen = Number(f.pen_s);
        if (S.lapStart == null && S.splits.length) { const lastS = cps().filter(c => c.gate === 0 && c.i <= S.splits.length).pop(); if (lastS) S.lapStart = S.splits[lastS.i - 1]; }
      }
      drawBar();
    },
    setNow(now) { if (now != null) { S.now = Number(now); S.nowAt = performance.now(); } },
    event,
    setGhost(gh) { S.ghost = gh && Array.isArray(gh.splits) ? gh : null; S.delta = null; },
    setPb(pb) { S.pbSec = pb?.sectors ? bestSectors(pb.sectors) : {}; },
    setRecordSectors(r) { S.recSec = { ...(r || {}) }; },
    get raceTime() { return raceT(); },
    get nextIndex() { return nextI(); },
    sticksRow(rowClass = 'fs-audio-row fs-fpv-row') {
      if (typeof document === 'undefined') return null;
      const inp = el('input'); inp.type = 'checkbox'; inp.checked = sticksOn;
      inp.onchange = () => { sticksOn = sp.set(inp.checked); drawSticks(); };
      const row = el('label', rowClass); row.title = T('fpv.sticks_d'); row.append(inp, el('span', null, T('fpv.sticks')));
      row.__sync = () => { inp.checked = sticksOn; };
      return row;
    },
    setSticks(v) { sticksOn = sp.set(v); drawSticks(); },
    state: () => ({ bar: bar.hidden ? '' : bar.textContent, note: note.style.opacity === '1' ? note.textContent : '', sticks: !sticks.hidden, delta: S.delta, pen: S.pen, best: S.best, lapTimes: [...S.lapTimes], sectors: S.secRows.map(r => [...r]), next: nextI() }),
    dispose() { disposed = true; cancelAnimationFrame(raf); clearInterval(iv); clearTimeout(noteT); ro?.disconnect(); cv.remove(); bar.remove(); note.remove(); sticks.remove(); },
  };
}
