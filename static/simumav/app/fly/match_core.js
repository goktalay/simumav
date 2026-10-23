// SIMUMAV › Uç › ÇOK OYUNCULU KARŞILAŞMA (docs/simumav.md §18) — SAF yardımcılar (DOM / ağ YOK; node testi tests/test_simumav_match.mjs).
// Sunucu sözleşmesi: app/simumav/routers/match.py (+ ortak çekirdek app/flightsim_match_core.py). Halka doğrulaması, geçiş denetimi ve sıralama
// SUNUCUDADIR; burada yalnız rota ayrıştırma, form doğrulaması (i18n anahtarı döner), şifre önerisi, davet bağlantısı ve görünüm modelleri.

// Karşılaşmada seçilebilen SIMUMAV dron tipleri (kara aracı yok: halkalar havada)
export const MATCH_TYPES = ['multirotor', 'fpv', 'plane', 'heli', 'vtol', 'interceptor'];
export const isMatchType = t => MATCH_TYPES.includes(t);
export const typeClass = t => (t === 'plane' ? 'ucak' : 'dikey');   // çekirdek: sabit kanat 'ucak', diğerleri 'dikey'

// Sınırlar sunucudan (GET /api/match/meta → limits); yedek değerler çekirdekle aynı (testte / meta yoksa)
export const LIMITS = {
  // §29 (HEPGO §47): players alt sınırı 1 = tek kişilik zaman denemesi (it dalaşı hariç: min_players.dogfight 2)
  players: [1, 8], min_players: { rings: 1, dogfight: 2, fpv: 1 }, count: [1, 30], alt_m: [5, 400], diameter_m: [4, 80], radius_m: [80, 3000], time_limit_min: [2, 60], password: [4, 32], attempts: 5,
  defaults: {
    dikey: { count: 8, min_alt_m: 15, max_alt_m: 60, diameter_m: 12, radius_m: 220, time_limit_min: 15, seed: null },
    ucak: { count: 8, min_alt_m: 40, max_alt_m: 140, diameter_m: 36, radius_m: 700, time_limit_min: 15, seed: null },
  },
  countdown_s: 6,
  // §29 FPV parkuru (sunucu limits.fpv; yedek değerler app/flightsim_fpv.py ile aynı; SIMUMAV dron tipleri)
  fpv: { types: ['multirotor', 'fpv', 'heli'], laps: [1, 10], crash_rules: ['penalty', 'reset', 'continue'], penalty_s: [0, 30], time_limit_min: [2, 30],
    defaults: { course_id: 'hangar', laps: 3, crash_rule: 'penalty', crash_penalty_s: 2, miss_penalty_s: 3, time_limit_min: 10, seed: null } },
};
export const ringsDefaults = (type, limits = LIMITS) => ({ ...((limits.defaults || LIMITS.defaults)[typeClass(type)] || LIMITS.defaults[typeClass(type)]) });

// Form değerleri → sunucu gövdesi (sayılar; boş alanlar varsayılana bırakılır)
export function ringsBody(r) {
  const out = {};
  for (const k of ['count', 'min_alt_m', 'max_alt_m', 'diameter_m', 'radius_m', 'time_limit_min', 'seed']) {
    const v = r?.[k];
    if (v === '' || v == null || !Number.isFinite(Number(v))) continue;
    out[k] = ['count', 'time_limit_min', 'seed'].includes(k) ? Math.round(Number(v)) : Number(v);
  }
  return out;
}
// Doğrulama: null = geçerli, aksi hâlde i18n anahtarı (sunucu aynı kuralları uygular)
export function ringsErrorKey(r, limits = LIMITS) {
  const L = { ...LIMITS, ...limits };
  const inR = (v, [a, b]) => Number.isFinite(Number(v)) && Number(v) >= a && Number(v) <= b;
  if (!r) return 'match.err_count';
  if (!inR(r.count, L.count) || !Number.isInteger(Number(r.count))) return 'match.err_count';
  if (!inR(r.min_alt_m, L.alt_m) || !inR(r.max_alt_m, L.alt_m)) return 'match.err_alt';
  if (Number(r.min_alt_m) > Number(r.max_alt_m)) return 'match.err_minmax';
  if (r.diameter_m != null && !inR(r.diameter_m, L.diameter_m)) return 'match.err_diameter';
  if (r.radius_m != null && !inR(r.radius_m, L.radius_m)) return 'match.err_radius';
  if (r.time_limit_min != null && !inR(r.time_limit_min, L.time_limit_min)) return 'match.err_time';
  return null;
}
export function passwordErrorKey(pw, limits = LIMITS) {
  const [a, b] = limits.password || LIMITS.password;
  const s = String(pw ?? '');
  if (s.length < a || s.length > b || /[\u0000-\u001f]/.test(s)) return 'match.err_pw_len';
  return null;
}
export function playersErrorKey(n, limits = LIMITS, kind = 'rings') {
  const [a0, b] = limits.players || LIMITS.players, a = Math.max(a0, minPlayers(kind, limits));
  return Number.isInteger(Number(n)) && Number(n) >= a && Number(n) <= b ? null : 'match.err_players';
}
// §29 (HEPGO §47) en az oyuncu: it dalaşı 2, halka yarışı ve FPV parkuru 1 (tek kişilik zaman denemesi)
export const minPlayers = (kind = 'rings', limits = LIMITS) => Number((limits?.min_players || LIMITS.min_players)[kind || 'rings'] ?? (kind === 'dogfight' ? 2 : 1));
export const soloAllowedKind = kind => (kind || 'rings') !== 'dogfight';

// ---------------------------------------------------------------- §29 HAZIR FPV PARKURLARI (saf; DOM'u fpv.js)
export const FPV_TYPES = LIMITS.fpv.types;   // SIMUMAV dron tipleri (sunucu limits.fpv.types)
export const isFpvType = (t, limits = LIMITS) => (limits?.fpv?.types || FPV_TYPES).includes(t);
export const FPV_COURSE_IDS = ['hangar', 'forest', 'city', 'stadium', 'refinery', 'canyon', 'woodframe', 'concrete'];
/** Varsayılan FPV ayarı (parkur seçiliyse onun tur sayısı). */
export const fpvDefaultsSm = (course = null, limits = LIMITS) => ({ ...(limits?.fpv?.defaults || LIMITS.fpv.defaults), ...(course ? { course_id: course.id, laps: Number(course.laps) || (limits?.fpv?.defaults || LIMITS.fpv.defaults).laps } : {}) });
/** FPV ayarı doğrulaması (sunucu fpv_ayar_dogrula kuralları): null = geçerli, aksi hâlde i18n anahtarı. */
export function fpvErrorKey(c, type = null, limits = LIMITS) {
  const L = { ...LIMITS.fpv, ...(limits?.fpv || {}) };
  if (type != null && !L.types.includes(type)) return 'fpvsm.type_warn';
  if (!c || !c.course_id) return 'fpv.pick';
  const inR = (v, [a, b]) => v !== '' && v != null && Number.isFinite(Number(v)) && Number(v) >= a && Number(v) <= b;
  if (!inR(c.laps, L.laps) || !Number.isInteger(Number(c.laps))) return 'fpvsm.err_laps';
  if (!L.crash_rules.includes(c.crash_rule)) return 'fpvsm.err_rule';
  if (!inR(c.crash_penalty_s, L.penalty_s) || !inR(c.miss_penalty_s, L.penalty_s)) return 'fpvsm.err_penalty';
  if (!inR(c.time_limit_min, L.time_limit_min) || !Number.isInteger(Number(c.time_limit_min))) return 'fpvsm.err_time';
  return null;
}
/** Sunucu gövdesi `fpv` (POST /api/match | /ai | /solo | /rings-preview). */
export const fpvBodySm = c => ({ course_id: c.course_id, laps: Math.round(Number(c.laps)), crash_rule: c.crash_rule, crash_penalty_s: Number(c.crash_penalty_s),
  miss_penalty_s: Number(c.miss_penalty_s), time_limit_min: Math.round(Number(c.time_limit_min)) });
export const fpvHref = (cid = null) => (cid ? `#/fly/fpv/${encodeURIComponent(cid)}` : '#/fly/fpv');
export const fpvTracksHref = (cid = null) => (cid ? `#/tracks/fpv/${encodeURIComponent(cid)}` : '#/tracks/fpv');
/** `#/tracks/<param>` → {tab 'mine' | 'fpv', course?} */
export function parseTracksParam(param) {
  const p = String(param ?? '').replace(/^\/+|\/+$/g, '');
  if (p === 'fpv') return { tab: 'fpv', course: null };
  const m = p.match(/^fpv\/([a-z]{2,20})$/);
  if (m && FPV_COURSE_IDS.includes(m[1])) return { tab: 'fpv', course: m[1] };
  return { tab: 'mine', course: null, new: p === 'new' };
}
// Karşılaşma türü + tek kişilik
export const matchKind = m => (['rings', 'dogfight', 'fpv'].includes(m?.kind) ? m.kind : 'rings');
export const kindKey = kind => (kind === 'fpv' ? 'fpv.kind' : kind === 'dogfight' ? 'df.kind_dogfight' : 'df.kind_rings');
export const kindShortKey = kind => (kind === 'fpv' ? 'fpv.kind_short' : kind === 'dogfight' ? 'df.kind_dogfight' : 'df.kind_rings');
/** Karşılaşma (anlık görüntü / sonuç / geçmiş satırı) tek kişilik mi: sonuçtaki `solo`; yoksa (çıkarılan hariç) tek oyuncu; geçmiş satırında n === 1. */
export function isSoloMatch(m) {
  if (m?.result && typeof m.result.solo === 'boolean') return m.result.solo;
  if (typeof m?.solo === 'boolean') return m.solo;
  if (Array.isArray(m?.players)) return m.players.filter(p => p.status !== 'cikarildi').length === 1 && (m.max_players == null || m.max_players === 1 || m.state !== 'LOBI');
  if (m?.n != null) return Number(m.n) === 1;
  return false;
}
/** Geçmiş listesi satırı (GET /api/match): {id, kind, kindKey, solo, state, track, rank, n, date, href, live}. */
export function historyRow(r) {
  const kind = matchKind(r);
  return { id: r.id, kind, kindKey: kindShortKey(kind), solo: isSoloMatch({ n: r.n }), state: r.state, stateKey: STATE_KEY[r.state] || r.state, track: r.track || '—', rank: r.rank ?? null, n: r.n ?? null,
    date: r.ended_at || r.created_at || null, href: lobbyHref(r.id), live: !!r.live, host: !!r.host };
}
/** FPV sonuç satırı özeti (standings[].fpv): toplam (ceza dahil), turlar, en iyi tur, sektörler, kaçırma/çarpma/ceza, kişisel rekor. */
export function fpvSummary(r) {
  const f = r?.fpv || {};
  const laps = Array.isArray(f.lap_times) ? f.lap_times : [];
  return { total: r?.time_s ?? f.total_s ?? null, raw: f.total_s ?? null, laps, best: f.best_lap_s ?? (laps.length ? Math.min(...laps.map(Number)) : null), sectors: Array.isArray(f.sectors) ? f.sectors : [],
    bestSectors: f.best_sectors || null, misses: Number(f.misses ?? 0), hits: Number(f.hits ?? r?.crashes ?? 0), pen: Number(r?.pen_s ?? f.pen_s ?? 0), lapsDone: Number(f.laps_done ?? laps.length),
    newPb: !!r?.new_pb, pbPrev: r?.pb_prev ?? null, pbDelta: r?.new_pb != null && r?.pb_prev != null && (r?.time_s ?? f.total_s) != null ? Math.round(((r.time_s ?? f.total_s) - r.pb_prev) * 1000) / 1000 : null,
    finished: !!r?.finished || (r?.time_s != null) };
}
/** Skor tablosundaki yerim: GET /api/fpv/courses/{cid} leaderboard (me işaretli) → {rank, n} | null. */
export const lbPlace = rows => { const i = (rows || []).findIndex(r => r.me); return i < 0 ? null : { rank: rows[i].rank ?? i + 1, n: rows.length }; };
// Şifre önerisi (kurucu değiştirebilir): karışmayan harf/rakam (0/O, 1/I yok). rand(n) → [0, n) tam sayı; tarayıcıda crypto.getRandomValues
const ALFABE = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const cryptoRand = n => { const a = new Uint32Array(1); globalThis.crypto.getRandomValues(a); return a[0] % n; };
export function genPassword(len = 6, rand = cryptoRand) {
  let s = '';
  for (let i = 0; i < len; i++) s += ALFABE[rand(ALFABE.length)];
  return s;
}

// ---------------------------------------------------------------- rotalar (#/fly/…)
export const inviteLink = (origin, code) => `${String(origin || '').replace(/\/$/, '')}/app/#/fly/join/${encodeURIComponent(code)}`;
export const lobbyHref = id => `#/fly/match/${encodeURIComponent(id)}`;
export const raceHref = id => `#/fly/match/${encodeURIComponent(id)}/race`;
// `#/fly/<param>` → görünüm: choice (seçim) · solo · multi · ai (yapay zekâya karşı) · join{code} · lobby{id} · race{id} · flight{id} (süren uçuşa dönüş)
export function parseFlyParam(param) {
  const p = String(param ?? '').replace(/^\/+|\/+$/g, '');
  if (!p) return { kind: 'choice' };
  if (p === 'solo') return { kind: 'solo' };
  if (p === 'multi') return { kind: 'multi' };
  if (p === 'ai') return { kind: 'ai' };   // HEPGO §44 "Yapay zekâya karşı" hızlı başlat
  if (p === 'fpv') return { kind: 'fpv', course: null };   // §29 Tek oyunculu › FPV parkuru (zaman denemesi)
  const fm = p.match(/^fpv\/([a-z]{2,20})$/);
  if (fm) return { kind: 'fpv', course: FPV_COURSE_IDS.includes(fm[1]) ? fm[1] : null };
  let m = p.match(/^join\/([A-Za-z0-9_-]{8,64})$/);
  if (m) return { kind: 'join', code: m[1] };
  m = p.match(/^match\/(\d+)(\/race)?$/);
  if (m) return { kind: m[2] ? 'race' : 'lobby', id: Number(m[1]) };
  if (/^\d+$/.test(p.split('?')[0])) return { kind: 'flight', id: p };   // süren uçuş (`#/fly/12?netsim=…` teşhis kipi dahil; param aynen)
  return { kind: 'choice' };
}

// ---------------------------------------------------------------- durumlar
export const OUT = new Set(['ayrildi', 'cikarildi', 'dustu']);
export const STATUS_KEY = { davetli: 'match.st_waiting', geldi: 'match.st_joined', hazirlaniyor: 'match.st_preparing', hazir: 'match.st_ready', ayrildi: 'match.st_left', cikarildi: 'match.st_kicked', dustu: 'match.st_dropped' };
export const STATE_KEY = { LOBI: 'match.state_lobby', HAZIRLIK: 'match.state_prep', GERI_SAYIM: 'match.state_countdown', YARIS: 'match.state_race', BITTI: 'match.state_done', IPTAL: 'match.state_cancel' };
export const REASON_KEY = { tamamlandi: 'fpv.r_tamamlandi', hepsi_bitirdi: 'fpv.r_hepsi_bitirdi', son_cagri: 'fpv.r_son_cagri', birinci_bitirdi: 'match.reason_first', sure: 'match.reason_time', kurucu_iptal: 'match.reason_host_cancel', kurucu_ayrildi: 'match.reason_host_left',
  oyuncu_kalmadi: 'match.reason_no_players', zaman_asimi: 'match.reason_timeout', terk_edildi: 'match.reason_abandoned', sunucu_kapaniyor: 'match.reason_server', sunucu_yeniden_basladi: 'match.reason_server' };
export const JOIN_ERR_KEY = { bad_password: 'match.err_bad_password', too_many_attempts: 'match.err_too_many', full: 'match.err_full', started: 'match.err_started', kicked: 'match.err_kicked',
  match_open: 'match.err_match_open', not_found: 'match.err_not_found', ended: 'match.err_ended', rate_limited: 'match.err_too_many' };
export const joinErrorKey = err => JOIN_ERR_KEY[err?.error || err?.code] || null;
export function phaseOf(state) {
  if (state === 'LOBI') return 'lobby';
  if (state === 'HAZIRLIK' || state === 'GERI_SAYIM' || state === 'YARIS') return 'race';
  if (state === 'BITTI') return 'done';
  if (state === 'IPTAL') return 'cancel';
  return 'lobby';
}
export const myPlayer = (match, me) => (match?.players || []).find(p => p.id === me) || null;
// Lobi görünüm modeli
export function lobbyView(match, me) {
  const players = match?.players || [];
  const host = players.find(p => p.host) || null;
  const isHost = !!host && host.id === me;
  const waiting = players.filter(p => !p.host && !p.ready).map(p => p.name);
  const kind = matchKind(match), act = players.filter(p => !OUT.has(p.status)).length, min = minPlayers(kind);
  // §29: salonda yalnız kurucu varken (it dalaşı hariç) BAŞLAT tek kişilik zaman denemesi başlatır
  return { isHost, host, players, count: players.length, max: match?.max_players ?? null, waiting, canStart: !!match?.can_start && isHost, kind, minPlayers: min,
    needMore: act < min, solo: act === 1 && soloAllowedKind(kind), me: myPlayer(match, me), full: match?.max_players != null && players.length >= match.max_players };
}
// Yarış ekranına geçilmeli mi (HAZIRLIK+ ve benim uçuşum açıldı; ben düşmedim/ayrılmadım)
export function shouldEnterRace(match, me) {
  const p = myPlayer(match, me);
  return phaseOf(match?.state) === 'race' && !!p && p.flight_id != null && !OUT.has(p.status);
}
// Sonuç satırları: sunucu sıralaması (result.standings) — yoksa oyuncu listesinden (DB'den gelen bitmiş karşılaşma)
export function resultRows(match) {
  const st = match?.result?.standings;
  const total = match?.result?.total ?? (match?.rings || []).length;
  const src = Array.isArray(st) && st.length ? st : [...(match?.players || [])].sort((a, b) => (a.rank ?? 99) - (b.rank ?? 99));
  return src.map((p, i) => ({ rank: p.rank ?? i + 1, id: p.id, name: p.name, time_s: p.time_s ?? null, rings: p.rings ?? 0, total, dist_next_m: p.dist_next_m ?? null,
    max_speed_ms: p.max_speed_ms ?? null, crashes: p.crashes ?? 0, status: p.status, finished: !!p.finished || p.time_s != null, winner: match?.result?.winner === p.id || match?.winner === p.id,
    is_bot: !!p.is_bot || Number(p.id) < 0, level: p.level ?? null,   // HEPGO §44 yapay zekâ pilot
    fpv: p.fpv || null, pen_s: p.pen_s ?? p.fpv?.pen_s ?? null, new_pb: p.new_pb ?? null, pb_prev: p.pb_prev ?? null, avatar: p.avatar ?? null }));   // §29 FPV parkuru
}
export const fmtClock = s => { if (s == null || !Number.isFinite(Number(s))) return '—'; const v = Math.max(0, Number(s)), m = Math.floor(v / 60), r = v - m * 60; return `${m}:${r < 10 ? '0' : ''}${r.toFixed(1)}`; };
export const fmtDist = m => (m == null || !Number.isFinite(Number(m)) ? '—' : Number(m) >= 1000 ? `${(Number(m) / 1000).toFixed(2)} km` : `${Math.round(Number(m))} m`);
export const ringsLine = r => (r ? `${r.count} · ${r.min_alt_m}–${r.max_alt_m} m · Ø ${r.diameter_m} m · R ${r.radius_m} m · ${r.time_limit_min} dk` : '—');

// Kuş bakışı parkur çizimi için ölçek (SVG 0…1): halkalar + başlangıçlar + merkez, kare kutu
export function viewBox(rings = [], starts = [], pad = 0.14) {
  const xs = [0, ...rings.map(r => Number(r.x)), ...starts.map(s => Number(s.x))], ys = [0, ...rings.map(r => Number(r.y)), ...starts.map(s => Number(s.y))];
  const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
  const span = Math.max(x1 - x0, y1 - y0, 50) * (1 + 2 * pad), cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  return { span, toSvg: (x, y) => [(x - (cx - span / 2)) / span, ((cy + span / 2) - y) / span] };
}

// ---------------------------------------------------------------- HEPGO §44 yapay zekâ pilot
export const AI_LEVELS = ['easy', 'normal', 'hard'];
/** "Yapay zekâya karşı" gövdesi: POST /api/match/ai (halka yarışında 1…max-1 bot; it dalaşında tek bot, rol dogfight.roles'ta). */
export function aiBody(base, level = 'normal', bots = 1, limits = LIMITS) {
  const max = Math.max(1, ((limits.players || LIMITS.players)[1] || 2) - 1);
  const lv = AI_LEVELS.includes(level) ? level : 'normal';
  const { password, max_players, ...rest } = base || {};
  return { ...rest, level: lv, bots: (rest.kind === 'dogfight') ? 1 : Math.max(1, Math.min(max, Math.round(Number(bots) || 1))) };
}

