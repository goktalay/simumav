// Uçuş Simülatörü §27 KAYITLI SİMÜLASYONLAR — SAF yardımcılar (DOM yok; Node testi tests/test_flightsim_saved.mjs). Sunucu eşleniği app/flightsim_presets.py.
// • nameKey / normName / nameConflict: kayıt adı benzersizliği (baş/son/ardışık boşluk, Türkçe İ/I dahil büyük/küçük harf duyarsız) — sunucu 409 ile aynı kural.
// • budgetView: flightsim_power.flightBudget sonucu → özet kutusu modeli (yakıt ve batarya ayrı satır, sınırlayan vurgulu, azami hızda ikinci satır).
// • runFacts: drone_sim_runs satırı → sağ paneldeki özet karoları (süre, mesafe, yakıt, batarya, çarpışma, önleme, sonuç, hız…).
// • presetBodyFromSession: sihirbaz gövdesinden kayda girecek alanlar (mode/log_id/airframe atılır; sunucu ALANLAR ile aynı).

export const NAME_MAX = 80, DESC_MAX = 500;
export const PRESET_FIELDS = ['type', 'center_id', 'world', 'model', 'drone_id', 'rec', 'power', 'camera', 'layout', 'targets', 'site', 'defend', 'drive'];

export const normName = s => String(s ?? '').normalize('NFC').trim().replace(/\s+/g, ' ');
export const nameKey = s => normName(s).replace(/I/g, 'ı').replace(/İ/g, 'i').toLowerCase();
/** Aynı anahtarlı başka kayıt (silinmemiş liste) → o kayıt | null. excludeId: düzenlenen kaydın kendisi. */
export function nameConflict(list, name, excludeId = null) {
  const k = nameKey(name);
  if (!k) return null;
  return (list || []).find(p => p && p.id !== excludeId && !p.deleted_at && nameKey(p.name) === k) || null;
}
/** Ad doğrulama: null (geçerli) | hata metni (TR anahtar; çağıran tr() ile çevirir). */
export function nameError(list, name, excludeId = null) {
  const n = normName(name);
  if (!n) return 'Kayıt adı gerekir';
  if (n.length > NAME_MAX) return 'Kayıt adı en çok {n} karakter olmalı';
  if (nameConflict(list, n, excludeId)) return 'Bu adla bir kayıtlı simülasyon zaten var; başka bir ad seçin';
  return null;
}

export function presetBodyFromSession(body) {
  const o = {};
  for (const k of PRESET_FIELDS) if (body?.[k] !== undefined && body[k] !== null) o[k] = body[k];
  return o;
}

// ---------- süre / menzil biçimleri ----------
export const fmtMin = m => {
  if (m == null || !Number.isFinite(Number(m))) return '—';
  const v = Math.round(Number(m));
  if (v < 60) return `${v} dk`;
  const hh = Math.floor(v / 60), mm = v % 60;
  return mm ? `${hh} sa ${mm} dk` : `${hh} sa`;
};
export const fmtKm = km => (km == null || !Number.isFinite(Number(km)) ? '—' : Number(km) >= 100 ? `${Math.round(Number(km))} km` : `${Number(km).toFixed(1)} km`);

/** flightBudget(b) → { empty, limit, headline:{time, range}, rows:[{key, label, time, range, timeMax, rangeMax, limit, note}], speed } */
export function budgetView(b) {
  if (!b) return { empty: true, rows: [] };
  const rows = [];
  if (b.fuel) rows.push({ key: 'fuel', label: 'Yakıt', time: fmtMin(b.fuel.time_min), range: fmtKm(b.fuel.range_km), timeMax: fmtMin(b.fuel.time_min_max), rangeMax: fmtKm(b.fuel.range_km_max), limit: b.limit === 'fuel' });
  if (b.elec) rows.push({ key: 'elec', label: 'Batarya', time: fmtMin(b.elec.time_min), range: fmtKm(b.elec.range_km), timeMax: fmtMin(b.elec.time_min_max), rangeMax: fmtKm(b.elec.range_km_max), limit: b.limit === 'elec', wh: b.elec.wh });
  return {
    empty: !rows.length, limit: b.limit,
    headline: { time: fmtMin(b.time_min), range: fmtKm(b.range_km), timeMax: fmtMin(b.time_min_max), rangeMax: fmtKm(b.range_km_max) },
    speed: { cruiseKmh: b.speed ? Math.round(b.speed.cruise_ms * 3.6) : null, maxKmh: b.speed ? Math.round(b.speed.max_ms * 3.6) : null, thrPct: b.speed ? Math.round(b.speed.cruise_thr * 100) : null },
    rows,
  };
}

// ---------- uçuş kaydı özeti (sağ panel) ----------
const RESULT = { tamam: ['green', 'Tamam'], carpisma: ['red', 'ÇARPIŞMA'], hata: ['orange', 'Hata'] };
const END_REASON = { kapatildi: 'Bitir ile kapandı', bosta: 'Boşta kapandı', sure: 'Süre doldu', sunucu_kapaniyor: 'Sunucu kapandı', hata: 'Hata' };
export const resultBadge = r => RESULT[r?.result] || ['gray', r?.result || '—'];
const fmtDist = m => (m == null ? '—' : m >= 1000 ? `${(m / 1000).toFixed(m >= 10000 ? 0 : 1)} km` : `${Math.round(m)} m`);
export const fmtSec = s => {
  if (s == null || !Number.isFinite(Number(s))) return '—';
  const v = Math.max(0, Math.round(Number(s))), hh = Math.floor(v / 3600), mm = Math.floor(v % 3600 / 60), ss = v % 60;
  return hh ? `${hh} sa ${mm} dk` : mm ? `${mm} dk ${ss} sn` : `${ss} sn`;
};
/** drone_sim_runs satırı → [{key, label, value, tone?}] (tone: ok | alert | warn | null). */
export function runFacts(r) {
  if (!r) return [];
  const pw = r.power || {}, f = pw.fuel || null, e = pw.elec || null, set = pw.settings || {};
  const [cls, txt] = resultBadge(r);
  let tg = null;
  try { tg = typeof r.targets === 'string' ? JSON.parse(r.targets) : r.targets; } catch { tg = null; }
  const out = [
    { key: 'duration', label: 'Süre', value: fmtSec(r.duration_s) },
    { key: 'dist', label: 'Mesafe', value: pw.dist_m != null ? fmtDist(pw.dist_m) : '—' },
    { key: 'result', label: 'Sonuç', value: txt, tone: cls === 'red' ? 'alert' : cls === 'green' ? 'ok' : 'warn' },
    { key: 'crash', label: 'Çarpışma', value: String(r.crash_count ?? 0), tone: r.crash_count ? 'alert' : 'ok' },
  ];
  if (r.intercept_count != null || tg?.config) out.push({ key: 'intercept', label: 'Önleme', value: `${r.intercept_count ?? 0}${tg?.config?.items?.length ? ` / ${tg.config.items.length}` : ''}`, tone: r.intercept_count ? 'ok' : null });
  if (f) out.push({ key: 'fuel', label: 'Yakıt', value: `${Number(f.used_l ?? r.fuel_used_l ?? 0).toFixed(2)} L${f.km_per_l != null ? ` · ${Number(f.km_per_l).toFixed(1)} km/L` : ''}`, tone: f.empty_t != null ? 'alert' : null, sub: f.start_l != null ? `${Number(f.start_l).toFixed(1)} L → ${Number(f.left_l ?? 0).toFixed(2)} L` : null });
  else if (r.fuel_used_l != null) out.push({ key: 'fuel', label: 'Yakıt', value: `${Number(r.fuel_used_l).toFixed(2)} L` });
  if (e) out.push({ key: 'elec', label: 'Batarya', value: `${Number(e.wh_used ?? r.elec_wh ?? 0).toFixed(1)} Wh${e.w_avg != null ? ` · ${Math.round(e.w_avg)} W` : ''}`, tone: e.empty_t != null ? 'alert' : null, sub: e.pct != null ? `%${Math.round(e.pct)} kaldı` : null });
  else if (r.elec_wh != null) out.push({ key: 'elec', label: 'Batarya', value: `${Number(r.elec_wh).toFixed(1)} Wh` });
  if (pw.max_speed_seen != null) out.push({ key: 'vmax', label: 'En yüksek hız', value: `${Math.round(pw.max_speed_seen * 3.6)} km/h`, sub: set.max_speed_ms ? `azami ${Math.round(set.max_speed_ms * 3.6)} km/h` : null });
  if (r.speedup_max > 1) out.push({ key: 'speedup', label: 'Simülasyon hızı', value: `${r.speedup_max}×` });
  out.push({ key: 'end', label: 'Kapanış', value: END_REASON[r.end_reason] || r.end_reason || '—' });
  return out;
}
