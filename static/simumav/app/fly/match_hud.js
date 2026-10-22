// SIMUMAV › Uç › ÇOK OYUNCULU KARŞILAŞMA — yarış ekranı katmanı (docs/simumav.md §18). session.js `ctx.match.attach(...)` ile kurulur:
//   • WS /ws/match/{id}: hello/match (anlık görüntü), countdown, pos (10 Hz diğer oyuncular), ring/finish/wrong_way, result, pong{now} (saat eşitleme).
//   • 3B: ortak /sim/flightsim_match3d.js (numaralı halkalar: sıradaki yeşil nabız, geçilen soluk, sonrakiler turuncu + yön oku; diğer oyuncular
//     renkli gövde + isim) — HEPGO ile AYNI modül, yalnız flightsim3d nesnesinin three/scene/toLocal/homeAlt/addFrameHook alanları.
//   • Üst şerit: sıradaki halka, yön oku, mesafe, yükseklik farkı, süre; sağda canlı sıralama; HAZIRLIK/geri sayımda bekleme kutusu;
//     yarış başlangıcı sunucu saatinde (start_at): son 3 sn'de oturumun giriş sekansı (3‑2‑1 + "dıt dıt") herkeste aynı anda; sonuç penceresi.
//   • 3B dünya kurulup oturum HAZIR olunca `onWorldReady()` → WS `ready` (herkes hazır olunca sunucu geri sayımı başlatır).
import { h, clear, t as tr } from './simui.js';
import { wsUrl } from './net.js';
import { createClock, countdownPhase, liveStandings, colorFor, bearingDeg, relAngle, ACTIVE, isBot, matchScore, myRank } from '/sim/flightsim_match.js';
import { countSteps, createSfx, rankChange } from '/sim/flightsim_sfx.js';   // HEPGO §44 oyun efektleri (ortak)
import { createMatchLayer } from '/sim/flightsim_match3d.js';
import { createDogfightHud, dfResultRows, makeDfT, roleOf } from '/sim/flightsim_dogfight.js';   // HEPGO §41 it dalaşı HUD'u (ortak)
import { fmtClock, fmtDist, lobbyHref, REASON_KEY, resultRows, STATUS_KEY } from './match_core.js';
import { ensureAvatarCss, playerImg, rowImg } from '../crew/avatar3d.js';   // §25: uçuşta YALNIZ önbellekli PNG / 2B yedek (ikinci WebGL bağlamı yok)

// HEPGO §44 yapay zekâ pilot rozeti 'AI · Zor' (seviye 7 dilde ai.level_*)
export const aiTag = p => (isBot(p) ? h('span', { class: 'sm-ai-badge', title: tr('ai.pilot') }, `AI${p.level ? ` · ${tr(`ai.level_${p.level}`)}` : ''}`) : null);

const DT = makeDfT(tr, true);
const isDf = m => (m?.kind || 'rings') === 'dogfight';
export function createMatchHud({ stage, getSim, startIntro = () => {}, getTele = () => null, mid, me, go = hash => { location.hash = hash; }, sfx = null }) {
  const clock = createClock();
  ensureAvatarCss();
  const fx = sfx || createSfx({ key: 'sm.sfx', keyed: true });   // HEPGO §44: oturumun efekt yolu (yoksa yedek bağlam)
  let prevRank = null, lastRankT = 0;
  let M = null, layer = null, worldReady = false, introDone = false, resultShown = false, disposed = false, ringsSig = '', dfHud = null;
  // HEPGO §41: it dalaşı HUD'u (rakip işaretçisi, angajman halkası, KİLİTLENİYOR uyarısı, rol/süre/mesafe şeridi). Yükseklikler sahne ölçeğine çevrilir (localPos).
  const ensureDf = () => { if (!M || !isDf(M) || dfHud) return; dfHud = createDogfightHud(stage, { getSim: () => getSim(), tr, keyed: true, me, sfx: fx }); board.hidden = true; window.__smDogfight = dfHud; };
  const pos = {};
  const bar = h('div', { class: 'sm-mt-bar wait' }, tr('match.hud_connecting'));
  const board = h('div', { class: 'sm-mt-board' }, h('h6', null, tr('match.standings')), h('ol'));
  const wait = h('div', { class: 'sm-mt-wait', hidden: true }, h('div', { class: 'box' }));
  const resEl = h('div', { class: 'sm-mt-result', hidden: true });
  const flash = h('div', { class: 'sm-mt-flash' });
  stage.append(bar, board, wait, resEl, flash);
  let flashT = 0;
  const flashMsg = (txt, tone = '') => { flash.textContent = txt; flash.className = `sm-mt-flash on ${tone}`; clearTimeout(flashT); flashT = setTimeout(() => { flash.className = 'sm-mt-flash'; }, 1800); };
  const myP = () => (M?.players || []).find(p => p.id === me);
  const plane = () => M?.settings?.type === 'sabit_kanat';
  const syncPlayers = () => layer?.setPlayers((M?.players || []).filter(p => ACTIVE.has(p.status)).map(p => ({ id: p.id, name: p.name, color: colorFor(M.players, p.id), plane: plane() })));
  // Yükseklik ölçeği: sunucu halkaları/konumları ortak ev irtifası (SITL) + eve göre yükseklikle verir; 3B sahnenin ev irtifası (homeAlt) prosedürel
  // dünyada null olabilir → sahneye eve göre yükseklik (agl / alt_rel) + sahnenin kendi homeAlt'ı ile verilir (halka ve araç aynı zeminde)
  const H0 = () => Number(getSim()?.homeAlt ?? 0) || 0;
  const syncRings = () => {
    if (!layer || !M) return;
    const sig = `${H0()}|${(M.rings || []).map(r => `${r.i}:${r.agl_m}`).join('|')}`;
    if (sig !== ringsSig) { ringsSig = sig; layer.setRings((M.rings || []).map(r => ({ ...r, alt_msl: H0() + Number(r.agl_m) }))); }
  };
  const localPos = m => ({ ...m, p: (m.p || []).map(p => ({ ...p, alt_msl: H0() + Number(p.alt_rel ?? (Number(p.alt_msl) - Number(M?.center?.alt || 0))) })) });
  const ensureLayer = () => {
    const sim = getSim();
    if (!sim || !M || layer || !sim.three || !sim.scene) return;
    layer = createMatchLayer(sim, { me });
    syncRings(); syncPlayers();
    window.__smMatch = { layer, get match() { return M; }, clock, get sim() { return getSim(); } };   // teşhis (Playwright)
  };
  const drawBoard = () => {
    if (!M || isDf(M)) return;
    const rows = liveStandings(M.players, pos), total = (M.rings || []).length;
    clear(board.querySelector('ol'), rows.map((p, i) => h('li', { class: `${p.id === me ? 'me' : ''} ${ACTIVE.has(p.status) ? '' : 'out'}`.trim() },
      h('span', { class: 'v' }, `${i + 1}.`), h('span', { class: 'dot', style: { background: colorFor(M.players, p.id) } }), playerImg(p), h('span', { class: 'nm' }, isBot(p) ? '🤖 ' : '', p.name),
      h('span', { class: 'v' }, p.finished ? '⚑' : `${p.rings ?? 0}/${total}`))));
  };
  const drawWait = () => {
    if (!M) return;
    const box = wait.firstChild, st = M.state;
    const ph = st === 'GERI_SAYIM' ? countdownPhase(M.start_at, clock.now()) : null;
    if (st === 'HAZIRLIK' || (ph && ph.phase === 'wait')) {
      wait.hidden = false;
      const act = (M.players || []).filter(p => ACTIVE.has(p.status)), ready = act.filter(p => p.status === 'hazir').length;
      clear(box, h('div', { class: 'ttl' }, tr(st === 'GERI_SAYIM' ? 'match.wait_go' : 'match.wait_title')),
        h('div', { class: 'sub' }, st === 'GERI_SAYIM' ? (isDf(M) ? DT('df.wait_go') : tr('match.wait_go_sub')) : tr('match.wait_ready', { r: ready, t: act.length })),
        ph ? h('div', { class: 'big' }, String(Math.ceil(ph.remain))) : null,
        h('ul', null, (M.players || []).filter(p => ACTIVE.has(p.status) || p.status === 'dustu').map(p => h('li', null, h('span', { class: 'dot', style: { background: colorFor(M.players, p.id) } }), playerImg(p),
          h('span', { class: 'nm' }, p.name, p.id === me ? ` (${tr('match.you')})` : ''), h('span', { class: `sm-mt-badge st-${p.status}` }, tr(STATUS_KEY[p.status] || p.status))))));
    } else wait.hidden = true;
  };
  const drawBar = () => {
    if (!M) return;
    const st = M.state;
    if (st === 'YARIS' && isDf(M)) { bar.hidden = true; return; }   // §41: şerit it dalaşı HUD'unda
    bar.hidden = false;
    if (st === 'YARIS') {
      const my = pos[me] || {}, total = (M.rings || []).length, nxt = my.next !== undefined ? my.next : myP()?.next;
      const el = Math.max(0, clock.now() - (M.start_at || 0));
      bar.className = 'sm-mt-bar';
      if (nxt == null && (myP()?.finished || my.rings === total)) { clear(bar, h('span', { class: 'ring' }, '⚑'), tr('match.hud_all_done'), h('span', { class: 't' }, fmtClock(el))); return; }
      const ring = (M.rings || []).find(r => r.i === nxt), tele = getTele(), sim = getSim();
      let arr = null;
      if (ring && tele && sim?.toLocal && tele.lat != null) {
        const L = sim.toLocal(Number(tele.lat), Number(tele.lon));
        const hdg = Number(tele.heading ?? ((tele.yaw || 0) * 180 / Math.PI));
        const rel = relAngle(hdg, bearingDeg(L.x, L.y, Number(ring.x), Number(ring.y)));
        arr = h('span', { class: 'arr', style: { transform: `rotate(${Math.round(rel)}deg)` } }, '▲');
      }
      const alt = tele && tele.alt_rel != null && M.center ? Number(M.center.alt || 0) + Number(tele.alt_rel) : null;
      const dz = ring && alt != null ? Number(ring.alt_msl) - alt : null;
      clear(bar, h('span', { class: 'ring' }, '◎'), tr('match.hud_ring', { i: nxt ?? '—', n: total }), arr, h('span', null, fmtDist(my.dist)),
        dz != null ? h('span', { class: 't' }, `${dz >= 0 ? '↑' : '↓'}${Math.abs(dz).toFixed(0)} m`) : null, h('span', { class: 't' }, fmtClock(el)));
    } else if (st === 'GERI_SAYIM') {
      const ph = countdownPhase(M.start_at, clock.now());
      bar.className = 'sm-mt-bar wait';
      clear(bar, tr('match.hud_starts_in', { s: Math.max(0, Math.ceil(ph.remain ?? 0)) }));
    } else if (st === 'HAZIRLIK') { bar.className = 'sm-mt-bar wait'; clear(bar, tr('match.hud_preparing')); }
    else if (st === 'BITTI') { bar.className = 'sm-mt-bar'; clear(bar, '⚑ ', tr('match.hud_done')); }
    else if (st === 'IPTAL') { bar.className = 'sm-mt-bar wait'; clear(bar, tr('match.hud_cancel', { r: tr(REASON_KEY[M.reason] || 'match.reason_server') })); }
  };
  const showResult = () => {
    if (resultShown || !M) return;
    resultShown = true;
    resEl.hidden = false;
    const rows = resultRows(M), win = rows.find(r => r.winner);
    const df = isDf(M);
    // HEPGO §44 puan: zafer / yenilgi sesi, sayaç tıklamalarla artar, sonunda "coin"
    const res = M.result || {};
    const row = df ? dfResultRows(M).find(r => r.id === me) : (res.standings || []).find(r => r.id === me);
    const score = row ? matchScore(row, df ? 'dogfight' : 'rings', res.dogfight || {}) : null;
    const scoreEl = h('b', { 'data-score': score ?? '' }, '0');
    clear(resEl, h('div', { class: 'box', role: 'dialog', 'aria-modal': 'true' },
      h('div', { class: 'trophy', 'aria-hidden': 'true' }, '★'),
      h('h2', null, win ? (win.id === me ? tr('match.result_you_won') : tr('match.result_winner', { n: win.name })) : tr('match.result_title')),
      podium(df ? dfResultRows(M).filter(r => r.won).map(r => ({ ...r, rank: 1 })) : rows.slice(0, 3), M.players),
      score != null ? h('div', { class: 'sm-mt-score' }, h('span', { class: 'muted' }, tr('ai.your_score')), scoreEl) : null,
      h('p', { class: 'sub' }, df ? DT(`df.r_${M.result?.reason || M.reason}`) : tr(REASON_KEY[M.result?.reason || M.reason] || 'match.reason_first')),
      df ? dfResultTable(M, me) : resultTable(rows, me, M.players),
      h('div', { class: 'acts' }, h('button', { class: 'btn', type: 'button', onclick: () => { resEl.hidden = true; } }, tr('common.ok')),
        h('button', { class: 'btn primary', type: 'button', onclick: () => go(lobbyHref(mid)) }, tr('match.back_lobby')))));
    if (row) {
      const won = (res.winner ?? M.winner) === me;
      fx.play(won ? 'win' : 'lose');
      const steps = countSteps(score), t0 = won ? 1.1 : 1.3;
      steps.forEach((st, k) => setTimeout(() => { if (disposed) return; scoreEl.textContent = String(st.v); if (k === steps.length - 1) { if (st.v > 0) fx.play('coin'); } else fx.play('tick'); }, (t0 + st.t) * 1000));
    }
    try { if (document.fullscreenElement) document.exitFullscreen?.(); } catch { /* */ }
  };
  const rankSound = () => {   // HEPGO §44 sıralama değişimi (halka geçişlerinde)
    if (!M || isDf(M) || M.state !== 'YARIS') return;
    const r = myRank(M.players, pos, me), ch = rankChange(prevRank, r);
    if (r != null) prevRank = r;
    if (ch && performance.now() - lastRankT > 1200) { lastRankT = performance.now(); fx.play(ch); }
  };
  const maybeIntro = () => {
    if (introDone || !worldReady || !M) return;
    if (M.state === 'YARIS') { introDone = true; return; }
    if (M.state === 'GERI_SAYIM' && countdownPhase(M.start_at, clock.now(), 3).phase !== 'wait') { introDone = true; wait.hidden = true; startIntro(); }
  };
  const onMsg = m => {
    if (disposed) return;
    if (m.t === 'hello' || m.t === 'match') {
      const prev = M?.state;
      M = m.match;
      if (M?.now) clock.sample(M.now);
      ensureLayer(); syncRings(); syncPlayers(); ensureDf(); dfHud?.update(M, clock.now());
      if (layer && myP()) layer.setNext(myP().finished ? null : myP().next ?? 1);
      if (prev && prev !== 'YARIS' && M.state === 'YARIS') flashMsg(isDf(M) ? DT(roleOf(M, me) === 'chaser' ? 'df.go_chaser' : 'df.go_evader') : tr('match.go_flash'), 'go');
      if (M.state === 'BITTI' && M.result) showResult();
      drawBoard(); drawWait(); drawBar(); maybeIntro();
      return;
    }
    if (m.t === 'countdown' && M) { M.start_at = m.start_at; M.state = 'GERI_SAYIM'; drawWait(); maybeIntro(); return; }
    if (m.t === 'pos') {
      for (const p of m.p || []) pos[p.id] = p;
      layer?.pushPos(localPos(m));
      if (dfHud) { dfHud.setPos(localPos(m)); dfHud.update(M, clock.now()); }
      if (layer && pos[me]) layer.setNext(pos[me].next ?? null);
      return;
    }
    if (m.t === 'ring') {
      const nm = (M?.players || []).find(p => p.id === m.id)?.name || '';
      pos[m.id] = { ...(pos[m.id] || {}), rings: Math.max(Number(pos[m.id]?.rings) || 0, m.i), next: m.i + 1 > m.total ? null : m.i + 1 };
      if (m.id === me) { fx.play(m.i >= m.total ? 'finish' : 'ring', { i: m.i, n: m.total }); flashMsg(tr('match.ring_ok', { i: m.i, n: m.total }), 'ok'); layer?.setNext(m.i + 1 > m.total ? null : m.i + 1); }
      else if (m.i === m.total) flashMsg(tr('match.last_ring', { n: nm }), 'warn');
      rankSound();
      return;
    }
    if (m.t === 'wrong_way' && m.id === me) { flashMsg(tr('match.wrong_way'), 'bad'); fx.play('wrong'); return; }
    if (m.t === 'finish') { const nm = (M?.players || []).find(p => p.id === m.id)?.name || ''; flashMsg(m.id === me ? tr('match.you_finished', { t: fmtClock(m.elapsed_s) }) : tr('match.finished', { n: nm }), 'warn'); return; }
    if (m.t === 'result' && M) { M = { ...M, result: m.result, state: 'BITTI' }; dfHud?.update(M, clock.now()); showResult(); drawBar(); }
    if (m.t === 'dogfight') {   // §41 olaylar
      if (m.kind === 'engaged') flashMsg(DT('df.engaged'), 'bad');   // §44 zafer/yenilgi sesi sonuçta
      else if (m.kind === 'area') flashMsg(DT('df.r_alan_disi'), 'bad');
      else if (m.kind === 'crash') flashMsg(DT('df.r_carpti'), 'bad');
      else if (m.kind === 'guard_off') flashMsg(DT('df.guard_off'), 'ok');
    }
  };
  // WS (yeniden bağlanır); ping'ler saat eşitlemesi için gönderim zamanıyla
  let ws = null, closed = false, retry = 0, timer = 0, pingIv = 0;
  const sent = new Map();
  const send = o => { if (ws?.readyState === 1) { ws.send(JSON.stringify(o)); return true; } return false; };
  const ping = () => { const t0 = Date.now(); sent.set(t0, true); send({ t: 'ping', at: t0 }); };
  const open = () => {
    if (closed) return;
    try { ws = new WebSocket(wsUrl(`/ws/match/${encodeURIComponent(mid)}`)); } catch { return; }
    ws.onopen = () => { retry = 0; for (let i = 0; i < 4; i++) setTimeout(ping, i * 300); pingIv = setInterval(ping, 5000); if (worldReady) send({ t: 'ready' }); };
    ws.onmessage = e => {
      let m; try { m = JSON.parse(e.data); } catch { return; }
      if (m.t === 'pong') { const keys = [...sent.keys()]; const s0 = keys.length ? keys[keys.length - 1] : null; sent.clear(); clock.sample(m.now, s0, Date.now()); return; }
      if (m.t === 'error') { clear(bar, tr('match.hud_no_access')); return; }
      onMsg(m);
    };
    ws.onclose = ev => { clearInterval(pingIv); if (closed || ev.code === 4403) return; timer = setTimeout(open, Math.min(8000, 500 * 2 ** Math.min(retry++, 4))); };
  };
  open();
  const iv = setInterval(() => { ensureLayer(); syncRings(); drawBar(); drawBoard(); if (M?.state === 'GERI_SAYIM') drawWait(); maybeIntro(); }, 250);
  return {
    onWorldReady() { if (worldReady) return; worldReady = true; ensureLayer(); send({ t: 'ready' }); setTimeout(() => send({ t: 'ready' }), 1500); setTimeout(() => send({ t: 'ready' }), 5000); maybeIntro(); },
    backHref: lobbyHref(mid),
    get state() { return M?.state || null; },
    get match() { return M; },
    get sfx() { return fx; },
    dispose() { disposed = true; closed = true; if (!sfx) fx.dispose(); clearInterval(iv); clearInterval(pingIv); clearTimeout(timer); clearTimeout(flashT); try { ws?.close(); } catch { /* */ } layer?.dispose(); dfHud?.dispose(); bar.remove(); board.remove(); wait.remove(); resEl.remove(); flash.remove(); if (window.__smMatch?.layer === layer) delete window.__smMatch; if (window.__smDogfight === dfHud) delete window.__smDogfight; },
  };
}

// HEPGO §41 it dalaşı sonuç tablosu: rol, oyuncu, sonuç, azami hız, çarpışma + angajman süresi / en yakın mesafe
export function dfResultTable(M, me) {
  const d = M?.result?.dogfight || {}, rows = dfResultRows(M);
  return h('div', { class: 'sm-df-res' },
    h('p', { class: 'small' }, [[DT('df.engage_time'), d.engage_s != null ? `${Number(d.engage_s).toFixed(1)} s` : '—'], [DT('df.max_hold'), d.max_hold_s != null ? `${Number(d.max_hold_s).toFixed(1)} / ${Number(d.need_s || 0).toFixed(1)} s` : '—'],
      [DT('df.min_dist'), fmtDist(d.min_dist_m)]].map(([k, v]) => h('span', { style: { marginRight: '14px' } }, h('span', { class: 'muted' }, `${k}: `), h('b', null, v)))),
    h('table', { class: 'sm-mt-table' },
      h('thead', null, h('tr', null, [DT('df.role'), tr('match.col_player'), DT('df.result'), tr('match.col_speed')].map(x => h('th', null, x)))),
      h('tbody', null, rows.map(r => h('tr', { class: `${r.id === me ? 'me' : ''} ${r.won ? 'win' : ''}`.trim() },
        h('td', null, r.role ? h('span', { class: `sm-df-badge ${r.role}` }, DT(`df.${r.role}`)) : '—'), h('td', null, rowImg(M.players, r), h('b', null, r.name), aiTag((M.players || []).find(p => p.id === r.id) || r)),
        h('td', null, h('span', { class: `sm-mt-badge ${r.won ? 'st-hazir' : 'st-dustu'}` }, DT(r.won ? 'df.won' : 'df.lost'))),
        h('td', { class: 'mono' }, r.max_speed_ms != null ? `${Math.round(r.max_speed_ms * 3.6)} km/h` : '—'))))));
}

// §25 sonuç podyumu: ilk üç (it dalaşında kazanan) 3B avatar görüntüsü (önbellek / 2B yedek)
export function podium(rows, players) {
  const top = (rows || []).filter(r => r && (r.finished || r.winner || r.won || (r.rings ?? 0) > 0)).slice(0, 3);
  if (!top.length) return null;
  const order = top.length === 3 ? [top[1], top[0], top[2]] : top;
  return h('div', { class: 'sm-mt-podium' }, order.map(r => { const k = top.indexOf(r) + 1; return h('div', { class: `pd p${k}` }, rowImg(players, r), h('b', null, r.name), h('span', { class: 'muted' }, `${k}.`)); }));
}

// Sonuç tablosu (yarış ekranı + salon sayfası ortak); players: avatar için oyuncu listesi (§25)
export function resultTable(rows, me, players = null) {
  return h('table', { class: 'sm-mt-table' },
    h('thead', null, h('tr', null, ['#', tr('match.col_player'), tr('match.col_time'), tr('match.col_rings'), tr('match.col_next'), tr('match.col_speed'), tr('match.col_status')].map(x => h('th', null, x)))),
    h('tbody', null, rows.map(r => h('tr', { class: `${r.id === me ? 'me' : ''} ${r.winner ? 'win' : ''}`.trim() },
      h('td', null, r.winner ? '★' : String(r.rank)), h('td', null, rowImg(players, r), h('b', null, r.name), aiTag(r)), h('td', { class: 'mono' }, r.time_s != null ? fmtClock(r.time_s) : '—'),
      h('td', { class: 'mono' }, `${r.rings}/${r.total}`), h('td', { class: 'mono' }, r.time_s != null ? '—' : fmtDist(r.dist_next_m)),
      h('td', { class: 'mono' }, r.max_speed_ms != null ? `${Math.round(r.max_speed_ms * 3.6)} km/h` : '—'),
      h('td', null, h('span', { class: `sm-mt-badge st-${r.status}` }, r.finished ? tr('match.st_finished') : (ACTIVE.has(r.status) ? tr('match.st_dnf') : tr(STATUS_KEY[r.status] || r.status))))))));
}
