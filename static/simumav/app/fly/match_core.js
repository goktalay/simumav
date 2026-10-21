// SIMUMAV › Uç › ÇOK OYUNCULU KARŞILAŞMA (docs/simumav.md §18) — SAF yardımcılar (DOM / ağ YOK; node testi tests/test_simumav_match.mjs).
// Sunucu sözleşmesi: app/simumav/routers/match.py (+ ortak çekirdek app/flightsim_match_core.py). Halka doğrulaması, geçiş denetimi ve sıralama
// SUNUCUDADIR; burada yalnız rota ayrıştırma, form doğrulaması (i18n anahtarı döner), şifre önerisi, davet bağlantısı ve görünüm modelleri.

// Karşılaşmada seçilebilen SIMUMAV dron tipleri (kara aracı yok: halkalar havada)
export const MATCH_TYPES = ['multirotor', 'fpv', 'plane', 'heli', 'vtol', 'interceptor'];
export const isMatchType = t => MATCH_TYPES.includes(t);
export const typeClass = t => (t === 'plane' ? 'ucak' : 'dikey');   // çekirdek: sabit kanat 'ucak', diğerleri 'dikey'

// Sınırlar sunucudan (GET /api/match/meta → limits); yedek değerler çekirdekle aynı (testte / meta yoksa)
export const LIMITS = {
  players: [2, 8], count: [1, 30], alt_m: [5, 400], diameter_m: [4, 80], radius_m: [80, 3000], time_limit_min: [2, 60], password: [4, 32], attempts: 5,
  defaults: {
    dikey: { count: 8, min_alt_m: 15, max_alt_m: 60, diameter_m: 12, radius_m: 220, time_limit_min: 15, seed: null },
    ucak: { count: 8, min_alt_m: 40, max_alt_m: 140, diameter_m: 36, radius_m: 700, time_limit_min: 15, seed: null },
  },
  countdown_s: 6,
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
export function playersErrorKey(n, limits = LIMITS) {
  const [a, b] = limits.players || LIMITS.players;
  return Number.isInteger(Number(n)) && Number(n) >= a && Number(n) <= b ? null : 'match.err_players';
}
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
// `#/fly/<param>` → görünüm: choice (seçim) · solo · multi · join{code} · lobby{id} · race{id} · flight{id} (süren uçuşa dönüş)
export function parseFlyParam(param) {
  const p = String(param ?? '').replace(/^\/+|\/+$/g, '');
  if (!p) return { kind: 'choice' };
  if (p === 'solo') return { kind: 'solo' };
  if (p === 'multi') return { kind: 'multi' };
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
export const REASON_KEY = { birinci_bitirdi: 'match.reason_first', sure: 'match.reason_time', kurucu_iptal: 'match.reason_host_cancel', kurucu_ayrildi: 'match.reason_host_left',
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
  return { isHost, host, players, count: players.length, max: match?.max_players ?? null, waiting, canStart: !!match?.can_start && isHost,
    me: myPlayer(match, me), full: match?.max_players != null && players.length >= match.max_players };
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
    max_speed_ms: p.max_speed_ms ?? null, crashes: p.crashes ?? 0, status: p.status, finished: !!p.finished || p.time_s != null, winner: match?.result?.winner === p.id || match?.winner === p.id }));
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
