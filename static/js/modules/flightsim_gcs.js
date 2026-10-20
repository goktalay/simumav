// Uçuş Simülatörü — YER KONTROL SAHASI (istasyon + EO/radar kulesi) ve "YER KONTROLÜNÜ KORU" görevi (docs/ucus-simulatoru.md §26).
// Saf fonksiyonlar (three.js'siz, DOM'suz; tarayıcısız Node testi tests/test_flightsim_gcs.mjs). Sunucu eşleniği app/flightsim_gcs.py — formüller birebir:
// yerleşim, radar kapsaması, EO bakışı, mulberry32, görev planı (tohumdan deterministik), tehdit kinematiği (seyir + dalış), puan/rütbe, görev izleyicisi
// (sahte istemci kipi ve kayıttan oynatma için; canlıda sunucu otoritedir).
//
// Yerel ENU (merkez = pad / rampa / araç başlangıcı; flightsim3d toLocal ile aynı): x doğu, y kuzey, z yukarı (ev zeminine göre).

export const RADAR_KM = [1, 50];
export const RADAR_KM_DEFAULT = 20;
export const EO_KM = [0.5, 15];
export const EO_KM_DEFAULT = 5;
export const SWEEP_S = 4;              // radar anten turu (15 dev/dk)
export const TOWER_EO_Z = 18;          // EO başlığı (m)
export const TOWER_RADAR_Z = 21.5;     // radar anteni (m)
export const STATION_Z = 2.6;          // istasyon çatısı (dalış nişan noktası)
export const EO_FOV_MAX = 48;          // EO geniş açı (°; ×1)
export const EO_FOV_MIN = 0.35;        // EO en dar açı (°)
export const SUCCESS_HEALTH = 50;    // tüm tehditler çözüldüğünde başarı için istasyon sağlığı en az (%)
export const FALL_S = 8;               // önlenen tehdidin düşüş görünürlüğü (sn)
const POS = { station: [-40, 55], tower: [-40, 85], rack: [-14, 34] };   // [ileri, sağ] (m; pist/kalkış yönüne göre)
const DEG = Math.PI / 180;
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const r2 = v => Math.round(v * 100) / 100;
const r1 = v => Math.round(v * 10) / 10;

/** Saha seçimi doğrulaması (sunucu gcs_dogrula ile aynı kurallar): hata metni ya da null. */
export function validateSite(s, tr = x => x) {
  if (s == null) return null;
  if (typeof s !== 'object' || Array.isArray(s)) return tr('Saha ayarı geçersiz');
  for (const k of ['station', 'radar', 'eo']) if (s[k] != null && typeof s[k] !== 'boolean') return tr('Saha ayarı geçersiz');
  if (s.radar && !(Number(s.radar_km) >= RADAR_KM[0] && Number(s.radar_km) <= RADAR_KM[1])) return tr('Radar menzili {a}–{b} km olmalı', { a: RADAR_KM[0], b: RADAR_KM[1] });
  if (s.eo && !(Number(s.eo_km) >= EO_KM[0] && Number(s.eo_km) <= EO_KM[1])) return tr('EO menzili {a}–{b} km olmalı', { a: EO_KM[0], b: EO_KM[1] });
  return null;
}
/** Sunucuya gidecek gövde (hepsi kapalıysa null). */
export function siteBody(s) {
  if (!s || !(s.station || s.radar || s.eo)) return null;
  return { station: !!s.station, radar: !!s.radar, radar_km: r2(Number(s.radar_km) || RADAR_KM_DEFAULT), eo: !!s.eo, eo_km: r2(Number(s.eo_km) || EO_KM_DEFAULT) };
}

const place = (headingDeg, [f, r]) => {
  const h = (Number(headingDeg) || 0) * DEG, fx = Math.sin(h), fy = Math.cos(h), rx = Math.cos(h), ry = -Math.sin(h);
  return { x: Math.round((f * fx + r * rx) * 1000) / 1000, y: Math.round((f * fy + r * ry) * 1000) / 1000, yaw_deg: ((Number(headingDeg) || 0) % 360 + 360) % 360 };
};
/** Yerleşim (sunucu `yerlesim`): istasyon, kule, interceptor rafı. */
export function siteLayout(headingDeg = 0) {
  return { station: place(headingDeg, POS.station), tower: place(headingDeg, POS.tower), rack: place(headingDeg, POS.rack),
    station_z: STATION_Z, eo_z: TOWER_EO_Z, radar_z: TOWER_RADAR_Z, sweep_s: SWEEP_S };
}

// ---------- radar ----------
/** Radar hedefi görür mü (yatay uzaklık ≤ kapsama). */
export function radarCovers(site, tower, x, y) {
  if (!site?.radar || !tower) return false;
  return Math.hypot(x - tower.x, y - tower.y) <= Number(site.radar_km) * 1000;
}
/** Tarama hüzmesi kerterizi (°, kuzeyden saat yönü) — t saniye, periyot SWEEP_S. */
export const sweepAngle = (tSec, period = SWEEP_S) => ((tSec / period) * 360 % 360 + 360) % 360;
/** Kuleden kerteriz (°). */
export const bearingFrom = (tower, x, y) => ((Math.atan2(x - tower.x, y - tower.y) / DEG) % 360 + 360) % 360;
/** Hüzme hedefin üstünden geçtikten sonraki parlaklık (1 → periyot boyunca sönümlenir; en az `floor`). */
export function sweepGlow(targetBearing, sweepDeg, period = SWEEP_S, floor = 0.35) {
  const behind = ((sweepDeg - targetBearing) % 360 + 360) % 360;   // hüzme hedefi kaç derece önce geçti
  const age = behind / 360 * period;
  return floor + (1 - floor) * Math.exp(-age / (period * 0.32));
}
/** Radar ekranı menzil basamakları (km; kapsamayı aşmaz, son basamak kapsamanın kendisi). */
export function radarSteps(maxKm) {
  const m = Number(maxKm) || RADAR_KM_DEFAULT;
  const out = [1, 2, 5, 10, 20, 50].filter(s => s < m - 1e-9);
  out.push(m);
  return out;
}
/** Otomatik ekran menzili: kapsamadaki en uzak nesneyi (kendi dron + görünen hedefler) %15 payla sığdıran basamak. */
export function autoRadarRange(dists, maxKm) {
  const steps = radarSteps(maxKm), far = Math.max(600, ...(dists || []).filter(Number.isFinite)) * 1.15 / 1000;
  return steps.find(s => s >= far) ?? steps[steps.length - 1];
}

// ---------- EO ----------
/** Kuledeki EO başlığından bakış (sunucu `eo_bakis`): az (°), el (°), range_m, ground_m. */
export function eoLook(tower, x, y, z, eoZ = TOWER_EO_Z) {
  const dx = x - tower.x, dy = y - tower.y, dz = z - eoZ, g = Math.hypot(dx, dy);
  return { az: ((Math.atan2(dx, dy) / DEG) % 360 + 360) % 360, el: Math.atan2(dz, g) / DEG, range_m: Math.hypot(g, dz), ground_m: g };
}
/** Oto yakınlaştırma: hedef (boyu sizeM, çizimde ×2,5) dikey kadrajın ~%40ını kaplasın. Dönüş {fov (°), zoom (×)}. */
export function eoZoom(rangeM, sizeM = 3, frac = 0.4) {
  const fov = clamp(2 * Math.atan((sizeM / frac) / 2 / Math.max(1, rangeM)) / DEG, EO_FOV_MIN, EO_FOV_MAX);
  return { fov, zoom: EO_FOV_MAX / fov };
}
/** EO izleme durumu: 'off' (EO yok) | 'idle' (hedef seçilmedi) | 'out' (menzil dışı) | 'track'. */
export function eoStatus(site, sel, rangeM) {
  if (!site?.eo) return 'off';
  if (sel == null || rangeM == null) return 'idle';
  return rangeM > Number(site.eo_km) * 1000 ? 'out' : 'track';
}

// ---------- deterministik rastgele (sunucu mulberry32 ile bit düzeyinde aynı) ----------
export function mulberry32(seed) {
  let a = (seed >>> 0) || 1;
  return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

// ---------- "Yer kontrolünü koru" ----------
export const DEFEND_DEFAULTS = { waves: 5, interceptors: 10, difficulty: 'normal', radius_m: 30, prep_s: 45 };
export const DEFEND_LIMITS = { waves: [1, 10], interceptors: [1, 20], radius_m: [10, 100], prep_s: [15, 300] };
export const DIFFICULTIES = ['easy', 'normal', 'hard'];
export const DIFFICULTY = {
  easy: { gap: 90, n0: 1, dist: [2500, 4500], alt: [120, 350], spd: 0.85, spacing: [8, 16] },
  normal: { gap: 70, n0: 2, dist: [3000, 6000], alt: [150, 450], spd: 1.0, spacing: [5, 12] },
  hard: { gap: 55, n0: 3, dist: [3500, 8000], alt: [150, 600], spd: 1.15, spacing: [3, 9] },
};
// Sunucu flightsim_targets.HEDEF_MODELLERI hızları (km/h) + HASAR
export const THREAT_MODELS = {
  'tgt:sw300': { name: 'Switchblade 300', cruise_kmh: 101, max_kmh: 161, damage: 15 },
  'tgt:lancet': { name: 'ZALA Lancet-3', cruise_kmh: 110, max_kmh: 300, damage: 35 },
  'tgt:altius': { name: 'Altius-600M', cruise_kmh: 60, max_kmh: 90, damage: 25 },
  'tgt:octopus': { name: 'Octopus-100', cruise_kmh: 200, max_kmh: 300, damage: 20 },
};
export const THREAT_KEYS = ['tgt:sw300', 'tgt:lancet', 'tgt:altius', 'tgt:octopus'];
export const DIVE_DEG = [25, 50];
export const THREAT_MAX = 60;
export const RANKS = [['colonel', 0.95], ['major', 0.85], ['captain', 0.72], ['lieutenant', 0.58], ['sergeant', 0.42], ['corporal', 0.25], ['private', 0]];
export const RANK_TR = { colonel: 'Albay', major: 'Binbaşı', captain: 'Yüzbaşı', lieutenant: 'Teğmen', sergeant: 'Çavuş', corporal: 'Onbaşı', private: 'Er' };

/** İstemci doğrulaması (sunucu savunma_dogrula sınırları): hata metni ya da null. */
export function validateDefend(d, type, tr = x => x) {
  if (d == null) return null;
  if (type && type !== 'interceptor') return tr('"Yer kontrolünü koru" görevi yalnız INTERCEPTOR ile uçulur');
  for (const [k, [a, b]] of Object.entries(DEFEND_LIMITS)) if (d[k] != null && !(Number(d[k]) >= a && Number(d[k]) <= b)) return tr('{k} {a}–{b} olmalı', { k, a, b });
  if (d.difficulty != null && !DIFFICULTIES.includes(d.difficulty)) return tr('Zorluk geçersiz');
  if (d.seed != null && !(Number.isInteger(d.seed) && d.seed >= 0 && d.seed <= 2147483647)) return tr('Tohum 0–2147483647 olmalı');
  return null;
}
export const randomSeed = () => Math.floor(Math.random() * 2147483646) + 1;

/** Tohumdan deterministik tehdit listesi (sunucu `savunma_plani` eşleniği; görsel bilgi yok). */
export function defendPlan(cfg) {
  const c = { ...DEFEND_DEFAULTS, ...(cfg || {}) }, z = DIFFICULTY[c.difficulty] || DIFFICULTY.normal, r = mulberry32(c.seed ?? 1);
  const u = (a, b) => a + (b - a) * r();
  const out = [];
  for (let w = 0; w < c.waves; w++) {
    let t = Number(c.prep_s) + w * z.gap;
    const n = Math.min(8, z.n0 + w);
    for (let k = 0; k < n; k++) {
      if (out.length >= THREAT_MAX) break;
      if (k) t += u(...z.spacing);
      const key = THREAT_KEYS[Math.min(THREAT_KEYS.length - 1, Math.floor(r() * THREAT_KEYS.length))];
      const brg = u(0, 360), dist = u(...z.dist) * (1 + 0.04 * w), alt = u(...z.alt), dive = u(...DIVE_DEG);
      const m = THREAT_MODELS[key];
      const vc = Math.min(m.max_kmh, m.cruise_kmh * z.spd * (1 + 0.05 * w)) / 3.6;
      const vd = m.max_kmh / 3.6 * Math.min(1, 0.85 + 0.05 * w);
      out.push({ k: out.length, wave: w, model: key, name: `${m.name} · T${out.length + 1}`, spawn_t: r2(t), bearing_deg: r2(brg), dist_m: r1(dist), alt_m: r1(alt), dive_deg: r2(dive),
        cruise_ms: r2(vc), dive_ms: r2(Math.max(vd, vc + 1)), damage: m.damage });
    }
  }
  return out;
}

/** Seyir + dalış geometrisi (sunucu `tehdit_geometri`). */
export function threatGeometry(th, st) {
  const b = Number(th.bearing_deg) * DEG, D = Number(th.dist_m), z0 = Number(th.alt_m), zs = Number(st.z ?? STATION_Z);
  const hgt = Math.max(1, z0 - zs), dd = Math.min(D, hgt / Math.tan(Number(th.dive_deg) * DEG));
  const sx = Math.sin(b), sy = Math.cos(b), vc = Number(th.cruise_ms), vd = Number(th.dive_ms);
  const tc = (D - dd) / vc, L = Math.hypot(dd, hgt), td = L / vd;
  return { x0: st.x + D * sx, y0: st.y + D * sy, z0, ux: -sx, uy: -sy, x1: st.x + dd * sx, y1: st.y + dd * sy, xs: st.x, ys: st.y, zs, tc, td, L, dd, h: hgt, vc, vd,
    t_impact: Number(th.spawn_t) + tc + td, heading: ((b / DEG + 180) % 360 + 360) % 360, pitch: -Math.atan2(hgt, dd) };
}
/** Tehdidin t anındaki durumu ya da null (doğmadı) — sunucu `tehdit_durum`. */
export function threatState(th, t, st, g = null) {
  g = g || threatGeometry(th, st);
  const tau = t - Number(th.spawn_t);
  if (tau < 0) return null;
  const hd = g.heading;
  if (tau <= g.tc) {
    const s = g.vc * tau;
    return { x: g.x0 + g.ux * s, y: g.y0 + g.uy * s, z: g.z0, vx: g.ux * g.vc, vy: g.uy * g.vc, vz: 0, heading: hd, yaw: hd * DEG, pitch: 0, roll: 0, speed: g.vc, phase: 'cruise' };
  }
  const f = Math.min(1, (tau - g.tc) / g.td), cp = g.dd / g.L, sp = g.h / g.L;
  return { x: g.x1 + (g.xs - g.x1) * f, y: g.y1 + (g.ys - g.y1) * f, z: g.z0 + (g.zs - g.z0) * f, vx: g.ux * g.vd * cp, vy: g.uy * g.vd * cp, vz: -g.vd * sp,
    heading: hd, yaw: hd * DEG, pitch: g.pitch, roll: 0, speed: g.vd, phase: f >= 1 ? 'impact' : 'dive' };
}
/** Önlenen tehdidin düşüşü (yalnız görsel): önleme anındaki durumdan balistik + takla; yere değince / FALL_S sonra null. */
export function fallState(k0, tau, ground = 0) {
  if (tau < 0 || tau > FALL_S) return null;
  const z = k0.z + (k0.vz || 0) * 0.4 * tau - 0.5 * 9.81 * tau * tau;
  if (z <= ground + 0.3 && tau > 0.2) return null;
  return { x: k0.x + (k0.vx || 0) * 0.4 * tau, y: k0.y + (k0.vy || 0) * 0.4 * tau, z, heading: k0.heading, yaw: k0.yaw + tau * 2.2, pitch: (k0.pitch || 0) - tau * 1.6, roll: tau * 3.1, speed: 0, phase: 'fall' };
}
/** Durum sözlüklerinden (sunucu `durum`) tehdit k'nin t anındaki yaşam evresi: pending | active | killed (düşüyor) | gone. */
export function threatPhase(th, t, killedAt, leakedAt, g) {
  if (t < Number(th.spawn_t)) return 'pending';
  if (killedAt != null && t >= killedAt) return t - killedAt <= FALL_S ? 'killed' : 'gone';
  if (leakedAt != null && t >= leakedAt) return 'gone';
  if (g && t >= g.t_impact) return 'gone';
  return 'active';
}

/** Puan + rütbe (sunucu `savunma_puan`). */
export function scoreDefend(oz) {
  let p = 0;
  for (const k of oz.kills || []) p += 300 + Math.min(400, Math.round(Number(k.station_m || 0) / 10)) + Math.max(0, 200 - Math.round(Number(k.ttk_s || 0)));
  p -= 250 * (oz.leaks || []).length;
  p += Math.round(Math.max(0, Number(oz.health) || 0)) * 10;
  const ic = oz.icept || {};
  p += 100 * Math.max(0, (Number(ic.total) || 0) - (Number(ic.used) || 0));
  if (oz.success) p += 1000;
  p = Math.max(0, p);
  const sp = Number(oz.spawned) || 0, acc = sp ? (oz.kills || []).length / sp : 0;
  const ratio = 0.65 * acc + 0.35 * Math.max(0, Number(oz.health) || 0) / 100;
  return { score: p, accuracy: Math.round(acc * 1000) / 1000, rank: rankOf(ratio), rank_ratio: Math.round(ratio * 1000) / 1000 };
}
export const rankOf = ratio => (RANKS.find(([, e]) => ratio >= e) || ['private'])[0];

/** Görev izleyicisi (sunucu SavunmaGorevi eşleniği; sahte istemci kipi). step(tSec, x, y, z, armed) → olaylar. */
export function createDefendTracker(cfg, layout, plan = null) {
  const c = { ...DEFEND_DEFAULTS, ...cfg };
  const P = plan || defendPlan(c), st = { x: layout.station.x, y: layout.station.y, z: STATION_Z };
  const G = P.map(th => threatGeometry(th, st)), S = P.map(() => 'pending'), waveN = {};
  P.forEach(th => { waveN[th.wave] = (waveN[th.wave] || 0) + 1; });
  const ic = { total: c.interceptors, used: 1, lost: 0, armed: false, down: null };
  let health = 100, wave = -1, ended = null, t = 0;
  const kills = [], leaks = [];
  const api = {
    plan: P, station: st,
    step(tt, x, y, z, armed) {
      t = tt;
      if (ended) return [];
      if (armed) ic.armed = true;
      const ev = [];
      P.forEach((th, k) => {
        if (S[k] === 'killed' || S[k] === 'leaked' || t < th.spawn_t) return;
        if (S[k] === 'pending') {
          S[k] = 'active';
          if (th.wave > wave) { wave = th.wave; ev.push({ kind: 'wave', wave: th.wave + 1, waves: c.waves, count: waveN[th.wave] || 0 }); }
          ev.push({ kind: 'spawn', k, name: th.name, model: th.model, dist_m: th.dist_m, alt_m: th.alt_m, bearing_deg: th.bearing_deg });
        }
        if (t >= G[k].t_impact) { S[k] = 'leaked'; health = Math.max(0, health - th.damage); leaks.push({ k, t: r2(G[k].t_impact), damage: th.damage, model: th.model }); ev.push({ kind: 'leak', k, name: th.name, damage: th.damage, health: r1(health), tt: r2(G[k].t_impact) }); return; }
        const s = threatState(th, t, st, G[k]), dist = Math.hypot(s.x - x, s.y - y, s.z - z);
        if (armed && dist <= c.radius_m) {
          S[k] = 'killed';
          const rec = { k, t: r2(t), dist_m: r1(dist), station_m: r1(Math.hypot(s.x - st.x, s.y - st.y)), ttk_s: r1(t - th.spawn_t), interceptor: ic.used, model: th.model, phase: s.phase, x: r1(s.x), y: r1(s.y), z: r1(s.z) };
          kills.push(rec); ev.push({ kind: 'kill', name: th.name, ...rec });
        }
      });
      if (health <= 0) ended = { t: r2(t), success: false, reason: 'station_destroyed' };
      else if (S.every(d => d === 'killed' || d === 'leaked')) ended = { t: r2(t), success: health >= SUCCESS_HEALTH, reason: 'all_resolved' };
      if (ended) ev.push({ kind: 'end', ...ended, result: api.summary() });
      return ev;
    },
    down(reason) { if (ic.down || ended) return false; ic.down = reason; return true; },
    redeploy() { if (!ic.armed && !ic.down) return false; if (ic.used >= ic.total) throw new Error('İnterceptor kalmadı'); ic.used++; ic.lost++; ic.armed = false; ic.down = null; return true; },
    state() {
      return { t: r2(t), base: 0, health: r1(health), wave: wave + 1, waves: c.waves, icept: { total: ic.total, used: ic.used, lost: ic.lost, down: ic.down }, remaining: ic.total - ic.used,
        killed: kills.map(k => [k.k, k.t]), leaked: leaks.map(k => [k.k, k.t]), spawned: S.filter(d => d !== 'pending').length, total: P.length, ended: ended ? { ...ended } : null };
    },
    summary() {
      const ttk = kills.map(k => k.ttk_s), spawned = S.filter(d => d !== 'pending').length;
      const oz = { config: { ...c }, health: r1(health), kills: kills.map(k => ({ ...k })), leaks: leaks.map(k => ({ ...k })), spawned, total: P.length, active: S.filter(d => d === 'active').length,
        icept: { total: ic.total, used: ic.used, lost: ic.lost }, waves_reached: wave + 1, ttk_avg_s: ttk.length ? r1(ttk.reduce((a, b) => a + b, 0) / ttk.length) : null,
        ttk_min_s: ttk.length ? Math.min(...ttk) : null, success: !!(ended && ended.success), ended: ended ? { ...ended } : null, t: r2(t) };
      Object.assign(oz, scoreDefend(oz));
      oz.rank_name = RANK_TR[oz.rank];
      return oz;
    },
  };
  return api;
}

/** Kayıttan oynatma: kaydedilen sonuçtan (kills/leaks zamanları) görev saati tm'deki şerit durumu (sunucu `durum` biçimi). */
export function defendStateAt(result, plan, tm, cfg = null) {
  const r = result || {}, c = { ...DEFEND_DEFAULTS, ...(cfg || r.config || {}) };
  const kills = (r.kills || []).filter(k => k.t <= tm), leaks = (r.leaks || []).filter(k => k.t <= tm);
  let wave = 0;
  for (const th of plan || []) if (th.spawn_t <= tm) wave = Math.max(wave, th.wave + 1);
  const used = Math.max(1, ...kills.map(k => Number(k.interceptor) || 1));
  const ended = r.ended && r.ended.t <= tm ? { ...r.ended } : null;
  return { t: tm, base: 0, health: Math.max(0, 100 - leaks.reduce((a, l) => a + Number(l.damage || 0), 0)), wave, waves: c.waves,
    icept: { total: r.icept?.total ?? c.interceptors, used, lost: used - 1, down: null }, remaining: (r.icept?.total ?? c.interceptors) - used,
    killed: kills.map(k => [k.k, k.t]), leaked: leaks.map(k => [k.k, k.t]), spawned: (plan || []).filter(th => th.spawn_t <= tm).length, total: (plan || []).length, ended };
}

// ---------- biçim ----------
export const fmtKm = m => (m == null ? '—' : m >= 1000 ? `${(m / 1000).toFixed(m >= 10000 ? 1 : 2)} km` : `${Math.round(m)} m`);
export const fmtClock = s => { const v = Math.max(0, Math.round(Number(s) || 0)); return `${String(Math.floor(v / 60)).padStart(2, '0')}:${String(v % 60).padStart(2, '0')}`; };
/** Sonraki dalganın başlangıcı (görev saati t'ye göre): {wave (1 tabanlı), in_s} ya da null. */
export function nextWave(plan, t) {
  const starts = [];
  for (const th of plan || []) if (starts[th.wave] == null || th.spawn_t < starts[th.wave]) starts[th.wave] = th.spawn_t;
  for (let w = 0; w < starts.length; w++) if (starts[w] != null && starts[w] > t) return { wave: w + 1, in_s: starts[w] - t };
  return null;
}
