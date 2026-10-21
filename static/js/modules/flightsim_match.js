// Uçuş Simülatörü §33 — ÇOK OYUNCULU KARŞILAŞMA: SAF yardımcılar (DOM / three.js YOK; Node testi tests/test_flightsim_match.mjs).
// HEPGO (flightsim_match_ui.js, flightsim_match3d.js) ve SIMUMAV aşama 2 ortak kullanır. Sunucu sözleşmesi app/flightsim_match_core.py
// (halka üretimi, geçiş doğrulaması ve sıralama SUNUCUDADIR; burada yalnız gösterim, davet listesi, saat eşitleme ve geri sayım evresi).

// Sınırlar sunucu `GET /api/drone/sim/matches/meta` → limits ile gelir; bu değerler yedek (meta yoksa / testte) — çekirdekle aynı.
export const MATCH_LIMITS = {
  players_max: 8, invite_min: 1, count: [1, 30], alt_m: [5, 400], diameter_m: [4, 80], radius_m: [80, 3000], time_limit_min: [2, 60],
  defaults: {
    dikey: { count: 8, min_alt_m: 15, max_alt_m: 60, diameter_m: 12, radius_m: 220, time_limit_min: 15, seed: null },
    ucak: { count: 8, min_alt_m: 40, max_alt_m: 140, diameter_m: 36, radius_m: 700, time_limit_min: 15, seed: null },
  },
  types: ['multirotor', 'hexarotor', 'helikopter', 'vtol', 'interceptor', 'sabit_kanat'],
  countdown_s: 6, force_after_s: 60,
};
export const typeClass = type => (type === 'sabit_kanat' ? 'ucak' : 'dikey');
export const ringDefaults = (type, limits = MATCH_LIMITS) => ({ ...(limits.defaults?.[typeClass(type)] || MATCH_LIMITS.defaults[typeClass(type)]) });

// Halka ayarı doğrulama (sunucuyla aynı kurallar; metinler Türkçe anahtar — çağıran tr() ile çevirir). null = geçerli.
export function ringsError(r, limits = MATCH_LIMITS) {
  if (!r) return 'Halka ayarı eksik';
  const inR = (v, [a, b]) => Number.isFinite(Number(v)) && Number(v) >= a && Number(v) <= b;
  if (!inR(r.count, limits.count) || !Number.isInteger(Number(r.count))) return 'Halka sayısı geçersiz';
  if (!inR(r.min_alt_m, limits.alt_m) || !inR(r.max_alt_m, limits.alt_m)) return 'Yükseklik sınır dışında';
  if (Number(r.min_alt_m) > Number(r.max_alt_m)) return 'Minimum yükseklik maksimum yükseklikten büyük olamaz';
  if (r.diameter_m != null && !inR(r.diameter_m, limits.diameter_m)) return 'Halka çapı geçersiz';
  if (r.radius_m != null && !inR(r.radius_m, limits.radius_m)) return 'Parkur yarıçapı geçersiz';
  if (r.time_limit_min != null && !inR(r.time_limit_min, limits.time_limit_min)) return 'Süre sınırı geçersiz';
  return null;
}

// ---------------------------------------------------------------- davet listesi (solda davet edilmeyenler, sağda edilenler)
const low = s => String(s ?? '').toLocaleLowerCase('tr');
const byName = (a, b) => String(a.full_name || '').localeCompare(String(b.full_name || ''), 'tr');
// users: [{id, full_name, username}], invited: Set<id> (sıra korunur), q: arama (iki listeye de uygulanır)
export function partitionInvite(users, invited, q = '') {
  const t = low(q).trim();
  const match = u => !t || low(u.full_name).includes(t) || low(u.username).includes(t);
  const ids = invited instanceof Set ? invited : new Set(invited || []);
  const left = users.filter(u => !ids.has(u.id) && match(u)).sort(byName);
  const order = [...ids];
  const right = users.filter(u => ids.has(u.id) && match(u)).sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
  return { left, right, total: ids.size };
}
// Davete ekle / çıkar (en çok max kişi: oyuncu tavanı − kurucu). Dönüş yeni Set; tavan aşılırsa değişmez.
export function inviteAdd(invited, ids, max = MATCH_LIMITS.players_max - 1) {
  const out = new Set(invited);
  for (const id of [].concat(ids)) { if (out.size >= max) break; out.add(id); }
  return out;
}
export const inviteRemove = (invited, ids) => { const out = new Set(invited); for (const id of [].concat(ids)) out.delete(id); return out; };
export const inviteError = (invited, limits = MATCH_LIMITS) => (invited.size < (limits.invite_min ?? 1) ? 'En az bir kullanıcı davet edin'
  : invited.size > (limits.players_max ?? 8) - 1 ? 'Davet sınırı aşıldı' : null);

// ---------------------------------------------------------------- saat eşitleme (sunucu saati; geri sayım herkes için aynı an)
// sample(serverNow (sn), sentAt, recvAt (ms, istemci)) — en küçük gidiş-dönüşlü örnek tutulur; now() sunucu saati (sn)
export function createClock(nowMs = () => Date.now()) {
  let off = null, rtt = Infinity;
  return {
    sample(serverNow, sentAt = null, recvAt = null) {
      const r = recvAt ?? nowMs(), s = sentAt ?? r, d = Math.max(0, r - s);
      if (!Number.isFinite(Number(serverNow))) return;
      if (d <= rtt || off == null) { rtt = d; off = Number(serverNow) * 1000 - (s + d / 2); }
    },
    now: () => (nowMs() + (off ?? 0)) / 1000,
    get offsetMs() { return off ?? 0; }, get rttMs() { return rtt; },
  };
}
// Geri sayım evresi: start_at'e kalan süre. introS: istemci giriş sekansının (3‑2‑1) "BAŞLA"ya kadar süresi.
// wait (giriş öncesi) · intro (giriş oynamalı) · race (başladı)
export function countdownPhase(startAt, now, introS = 3) {
  if (startAt == null) return { phase: 'none', remain: null };
  const r = Number(startAt) - Number(now);
  if (r <= 0) return { phase: 'race', remain: 0 };
  return { phase: r <= introS ? 'intro' : 'wait', remain: r };
}

// ---------------------------------------------------------------- geometri (3B yerel: x doğu, y kuzey, z yukarı; merkez = sahne kökeni)
// Halka: sunucunun x/y'si merkez ENU'sudur; z = alt_msl − sahnenin ev irtifası (merkez zemini)
export const ringLocal = (ring, homeAlt) => ({ x: Number(ring.x), y: Number(ring.y), z: Number(ring.alt_msl) - Number(homeAlt ?? 0), nx: Number(ring.nx), ny: Number(ring.ny), r: Number(ring.radius_m) });
// Oyuncu konumu (pos çerçevesi) → yerel
export const playerLocal = (p, toLocal, homeAlt) => { const l = toLocal(Number(p.lat), Number(p.lon)); return { x: l.x, y: l.y, z: Number(p.alt_msl) - Number(homeAlt ?? 0) }; };
// İki pos çerçevesi arasında doğrusal ara değer (açılar en kısa yoldan); f ∈ [0, 1]
export function lerpPose(a, b, f) {
  if (!a) return b; if (!b) return a;
  const t = Math.max(0, Math.min(1, f)), L = (u, v) => u + (v - u) * t;
  const A = (u, v) => { let d = ((v - u + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI; return u + d * t; };
  return { x: L(a.x, b.x), y: L(a.y, b.y), z: L(a.z, b.z), yaw: A(a.yaw || 0, b.yaw || 0), roll: L(a.roll || 0, b.roll || 0), pitch: L(a.pitch || 0, b.pitch || 0) };
}
// Kuzeyden saat yönünde kerteriz (°) ve buruna göre bağıl açı (−180…180; + sağda)
export const bearingDeg = (fx, fy, tx, ty) => ((Math.atan2(tx - fx, ty - fy) * 180 / Math.PI) + 360) % 360;
export const relAngle = (headingDeg, brgDeg) => ((Number(brgDeg) - Number(headingDeg) + 540) % 360) - 180;
// Bağıl açıya ok karakteri (8 yön)
export const arrowFor = rel => ['⬆', '⬈', '➡', '⬊', '⬇', '⬋', '⬅', '⬉'][Math.round(((Number(rel) + 360) % 360) / 45) % 8];

// ---------------------------------------------------------------- gösterim
export const PLAYER_COLORS = ['#22c55e', '#3b82f6', '#f97316', '#e11d48', '#a855f7', '#eab308', '#06b6d4', '#f472b6'];
export const colorFor = (players, id) => { const i = (players || []).findIndex(p => p.id === id); return PLAYER_COLORS[(i < 0 ? 0 : i) % PLAYER_COLORS.length]; };
export const STATUS_TEXT = { davetli: 'Bekleniyor', geldi: 'Geldi', hazirlaniyor: 'Hazırlanıyor', hazir: 'Hazır', ayrildi: 'Ayrıldı', cikarildi: 'Çıkarıldı', dustu: 'Düştü' };
export const STATUS_TONE = { davetli: 'gray', geldi: 'blue', hazirlaniyor: 'yellow', hazir: 'green', ayrildi: 'red', cikarildi: 'red', dustu: 'red' };
export const STATE_TEXT = { LOBI: 'Bekleme salonu', HAZIRLIK: 'Simülatörler hazırlanıyor', GERI_SAYIM: 'Geri sayım', YARIS: 'Yarış', BITTI: 'Bitti', IPTAL: 'İptal edildi' };
export const REASON_TEXT = { birinci_bitirdi: 'İlk oyuncu tüm halkaları bitirdi', sure: 'Süre doldu', kurucu_iptal: 'Kurucu iptal etti', kurucu_ayrildi: 'Kurucu ayrıldı',
  oyuncu_kalmadi: 'Yeterli oyuncu kalmadı', zaman_asimi: 'Bekleme süresi doldu', sunucu_kapaniyor: 'Sunucu kapandı', sunucu_yeniden_basladi: 'Sunucu yeniden başladı' };
export const ACTIVE = new Set(['davetli', 'geldi', 'hazirlaniyor', 'hazir']);
export const lobbyCounts = players => { const a = (players || []).filter(p => ACTIVE.has(p.status)); return { total: a.length, arrived: a.filter(p => p.status !== 'davetli').length, ready: a.filter(p => p.status === 'hazir').length }; };
// Yarış içi canlı sıralama (sunucu sıralamasının istemci eşleniği: bitiren önce, sonra halka çok → mesafe az)
export function liveStandings(players, pos = {}) {
  const rows = (players || []).filter(p => p.status !== 'cikarildi' && p.status !== 'davetli').map(p => ({ ...p, ...(pos[p.id] ? { rings: pos[p.id].rings ?? p.rings, dist_next_m: pos[p.id].dist ?? p.dist_next_m } : {}) }));
  const out = (p) => (p.status === 'dustu' || p.status === 'ayrildi' ? 1 : 0);
  return rows.sort((a, b) => out(a) - out(b) || (b.finished ? 1 : 0) - (a.finished ? 1 : 0) || (a.finished && b.finished ? (a.finish_t ?? 0) - (b.finish_t ?? 0) : 0)
    || (b.rings ?? 0) - (a.rings ?? 0) || (a.dist_next_m ?? Infinity) - (b.dist_next_m ?? Infinity) || a.id - b.id);
}
export const fmtClock = s => { if (s == null || !Number.isFinite(Number(s))) return '—'; const v = Math.max(0, Number(s)), m = Math.floor(v / 60), r = v - m * 60; return `${m}:${r < 10 ? '0' : ''}${r.toFixed(1)}`; };
export const fmtDist = m => (m == null || !Number.isFinite(Number(m)) ? '—' : Number(m) >= 1000 ? `${(Number(m) / 1000).toFixed(2)} km` : `${Math.round(Number(m))} m`);
export const matchHref = id => `#/drone/sim/match/${encodeURIComponent(id)}`;
export const sessionHref = (sid, mid) => `#/drone/sim/${encodeURIComponent(sid)}?match=${encodeURIComponent(mid)}`;

// Sihirbaz özet satırları için halka ayarı metni
export const ringsSummary = r => (r ? `${r.count} · ${r.min_alt_m}–${r.max_alt_m} m · Ø ${r.diameter_m} m · R ${r.radius_m} m` : '—');

// Halkaların kuş bakışı + profil çizimi için ölçek (SVG; flightsim_match_ui.ringsSvg): sınır kutusu, kare ölçek
export function ringsViewBox(rings, starts = [], pad = 0.12) {
  const xs = [0, ...rings.map(r => Number(r.x)), ...starts.map(s => Number(s.x))], ys = [0, ...rings.map(r => Number(r.y)), ...starts.map(s => Number(s.y))];
  const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
  const span = Math.max(x1 - x0, y1 - y0, 50) * (1 + 2 * pad);
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  return { minX: cx - span / 2, minY: cy - span / 2, size: span, toSvg: (x, y) => [(x - (cx - span / 2)) / span, ((cy + span / 2) - y) / span] };
}
