// Uçuş Simülatörü — hava durumu, rüzgâr ve rampa yön/açı SAF kuralları (three.js'siz; node testleri tests/test_flightsim_worldfx.mjs).
// docs/ucus-simulatoru.md §31. HEPGO + SIMUMAV ortak.
// • Hava: world.weather ∈ WEATHER (açık / bulutlu / yağmur / kar / sis / fırtına) → görsel ön ayar (bulut örtüsü, yağış, ıslaklık, kar örtüsü, ışık,
//   görüş çarpanı). SIMUMAV parkuru (bridge WEATHER: clear/cloudy/rain/fog/snow) birebir eşlenir.
// • Rüzgâr: SIM_WIND_DIR uzlaşımı — rüzgârın GELDİĞİ yön (meteorolojik, kuzeyden saat yönü). Baş/yan/kuyruk rüzgârı bileşenleri, rüzgâra karşı
//   kalkış önerisi, esinti (gust) çarpanı (sunucu app/flightsim.py esinti_carpani ile AYNI formül), rüzgâr tulumu şişkinliği, akış çizgisi ayarları.
// • Rampa (§13): yön (azimut 0–359°) + açı (10–30°, sunucu launch_dogrula ile aynı) normalizasyonu, yeniden konuşlandırma gerekir mi.
const DEG = Math.PI / 180;
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const num = (v, d) => (v == null || v === '' || Number.isNaN(Number(v)) ? d : Number(v));

// ---------- hava durumu ----------
export const WEATHER = ['clear', 'cloudy', 'rain', 'snow', 'fog', 'storm'];
export const WEATHER_LABELS = { clear: 'Açık hava', cloudy: 'Bulutlu', rain: 'Yağmurlu', snow: 'Karlı', fog: 'Sisli', storm: 'Fırtınalı' };   // sıfat biçimi: 'Açık' / 'Sis' sözlükte başka anlamda
export const WEATHER_ICONS = { clear: '☀️', cloudy: '☁️', rain: '🌧️', snow: '❄️', fog: '🌫️', storm: '⛈️' };
// cloud: bulut örtüsü 0–1 · rain/snow: yağış yoğunluğu 0–1 · wet: zemin ıslaklığı · snowCover: zemin beyazlaması · light: güneş/gök ışığı çarpanı ·
// vis: görüş çarpanı (sis uzaklığı × vis) · haze: atmosferik pus (gök/sis rengini griye çeker) · lightning: şimşek çakması
export const WEATHER_PRESETS = {
  clear: { cloud: 0.12, rain: 0, snow: 0, wet: 0, snowCover: 0, light: 1, vis: 1, haze: 0, lightning: false },
  cloudy: { cloud: 0.78, rain: 0, snow: 0, wet: 0, snowCover: 0, light: 0.7, vis: 0.8, haze: 0.35, lightning: false },
  rain: { cloud: 0.95, rain: 0.75, snow: 0, wet: 1, snowCover: 0, light: 0.5, vis: 0.42, haze: 0.6, lightning: false },
  snow: { cloud: 0.9, rain: 0, snow: 0.8, wet: 0, snowCover: 1, light: 0.78, vis: 0.38, haze: 0.55, lightning: false },
  fog: { cloud: 0.55, rain: 0, snow: 0, wet: 0.35, snowCover: 0, light: 0.72, vis: 0.1, haze: 0.9, lightning: false },
  storm: { cloud: 1, rain: 1, snow: 0, wet: 1, snowCover: 0, light: 0.34, vis: 0.3, haze: 0.75, lightning: true },
};
export const normWeather = w => (WEATHER.includes(w) ? w : 'clear');
export const weatherPreset = w => ({ key: normWeather(w), ...WEATHER_PRESETS[normWeather(w)] });
// SIMUMAV parkuru (bridge.WEATHER) → çekirdek world.weather (bilinmeyen → açık)
export const SIMUMAV_WEATHER = ['clear', 'cloudy', 'rain', 'fog', 'snow'];
export const weatherFromTrack = w => (SIMUMAV_WEATHER.includes(w) ? w : 'clear');

// Görüş uzaklığı (sis sonu, m): world.fog kaydırıcısı + hava ön ayarı. horizon > 0 → gerçek arazi / Google 3B ufku (§5), yoksa prosedürel dünya
// boyutu. Hava "açık" ise eski formülle BİREBİR aynı (geri uyum).
export function fogRange(fog, weather, { size = 4000, horizon = 0 } = {}) {
  const f = clamp(num(fog, 0), 0, 1), P = weatherPreset(weather);
  let far = horizon > 0 ? horizon * (1.25 - f) : size * (1.6 - 1.25 * f);
  const on = f > 0 || P.vis < 1;
  far *= P.vis;
  if (P.key === 'fog') far = Math.min(far, 900);   // sis: ≤ 900 m (alçak görüş)
  far = Math.max(180, far);
  return { on, near: far * (P.key === 'fog' ? 0.02 : 0.12), far };
}

// Yağış parçacıkları (kameraya bağlı hacim; GPU'da düşer): sayı kaliteye göre, kutu boyu, düşüş hızı (m/s), boy
export function precipParams(weather, { quality = 1, windMs = 0 } = {}) {
  const P = weatherPreset(weather), q = clamp(num(quality, 1), 0.25, 1);
  if (P.rain > 0) return { kind: 'rain', count: Math.round(14000 * P.rain * q), box: 70, fall: 9 + 3 * P.rain, len: 0.9 + 0.5 * P.rain, size: 1, drift: windMs };
  if (P.snow > 0) return { kind: 'snow', count: Math.round(9000 * P.snow * q), box: 60, fall: 1.1, len: 0, size: 0.09, drift: windMs };
  return null;
}

// Güneş yönü (ENU birim vektör, z yukarı): saat önayarı → yükseklik/azimut (gündüz 52°, akşam 4° batıya yakın, gece ay ışığı 28°)
export function sunPosition(time) {
  const t = time === 'night' ? 'night' : time === 'dusk' ? 'dusk' : 'day';
  const elev = { day: 52, dusk: 4, night: 28 }[t], az = { day: 150, dusk: 252, night: 210 }[t];   // azimut kuzeyden saat yönü
  const e = elev * DEG, a = az * DEG;
  return { elev, az, x: Math.sin(a) * Math.cos(e), y: Math.cos(a) * Math.cos(e), z: Math.sin(e), moon: t === 'night' };
}

// ---------- rüzgâr ----------
export const WIND_LIMITS = { ms: [0, 30], dir: [0, 359.99], gust: [0, 20], turb: [0, 10] };   // sunucu _WORLD_SINIR ile aynı
// Havanın hareket vektörü (ENU, m/s): rüzgâr `fromDeg`den GELİR → akış yönü from + 180°
export function windVector(ms, fromDeg) {
  const v = Math.max(0, num(ms, 0)), a = num(fromDeg, 0) * DEG;
  return { x: -v * Math.sin(a), y: -v * Math.cos(a), z: 0 };
}
// Uçağa göre bileşenler: head > 0 baş rüzgârı (< 0 kuyruk), cross > 0 sağdan (< 0 soldan). rel: rüzgârın burna göre geliş açısı (−180…180)
export function windComponents(ms, fromDeg, hdgDeg) {
  const v = Math.max(0, num(ms, 0));
  let rel = (num(fromDeg, 0) - num(hdgDeg, 0)) % 360;
  if (rel > 180) rel -= 360; if (rel <= -180) rel += 360;
  const head = v * Math.cos(rel * DEG), cross = v * Math.sin(rel * DEG);
  const kind = v < 0.3 ? 'calm' : Math.abs(cross) > Math.abs(head) ? 'cross' : head >= 0 ? 'head' : 'tail';
  return { head: +head.toFixed(2), cross: +cross.toFixed(2), rel: +rel.toFixed(1), kind, side: cross >= 0 ? 'R' : 'L' };
}
// Rüzgâra karşı kalkış önerisi: kalkış yönü = rüzgârın geldiği yön (5°'ye yuvarlanır). ok: baş rüzgârı ≥ −1 m/s ve yan rüzgâr ≤ 6 m/s
export const TAILWIND_MAX = 1, CROSSWIND_MAX = 6;
export const intoWindHeading = fromDeg => ((Math.round(num(fromDeg, 0) / 5) * 5) % 360 + 360) % 360;
export function takeoffAdvice(ms, fromDeg, hdgDeg) {
  const c = windComponents(ms, fromDeg, hdgDeg), suggest = intoWindHeading(fromDeg);
  const ok = c.kind === 'calm' || (c.head >= -TAILWIND_MAX && Math.abs(c.cross) <= CROSSWIND_MAX);
  const off = Math.abs(((suggest - num(hdgDeg, 0)) % 360 + 540) % 360 - 180);
  return { ...c, ok, suggest, off: Math.round(off), worth: c.kind !== 'calm' && off >= 15 };
}
// Esinti çarpanı g(t) ∈ [0, 1] (yumuşak, tohumlu; iki uyumsuz frekans + seyrek sert esinti). Anlık hız = taban + gust · g(t).
// Python eşleniği app/flightsim.py esinti_carpani — iki dilde aynı değerler (testler karşılaştırır).
export function gustFactor(t, seed = 0) {
  const s = num(seed, 0) * 0.7311;
  const a = 0.55 * Math.sin(2 * Math.PI * t / 11.3 + s) + 0.3 * Math.sin(2 * Math.PI * t / 4.7 + 2.1 * s) + 0.15 * Math.sin(2 * Math.PI * t / 1.9 + 3.3 * s);
  const g = clamp(0.5 + 0.5 * a, 0, 1);
  return +(g * g).toFixed(4);
}
export const gustSpeed = (base, gust, t, seed = 0) => +(Math.max(0, num(base, 0)) + Math.max(0, num(gust, 0)) * gustFactor(t, seed)).toFixed(2);
// Rüzgâr tulumu: ICAO'ya yakın — 15 kt (≈ 7,7 m/s) tam açılır; şişkinlik 0,12…1, sarkma açısı (° aşağı) ve dalgalanma genliği
export function sockState(ms) {
  const v = Math.max(0, num(ms, 0)), inf = clamp(v / 7.7, 0.12, 1);
  return { inflation: +inf.toFixed(3), droop: +((1 - inf) * 78).toFixed(1), flutter: +clamp(0.04 + v * 0.012, 0, 0.25).toFixed(3) };
}
// Akış çizgileri (uçak çevresi): sayı, uzunluk (m), saydamlık, hız — rüzgâr 0,3 m/s altında kapalı
export function streakParams(ms) {
  const v = Math.max(0, num(ms, 0));
  if (v < 0.3) return { on: false, count: 0, len: 0, alpha: 0, speed: 0 };
  return { on: true, count: Math.round(clamp(60 + v * 26, 60, 420)), len: +clamp(1.5 + v * 0.55, 1.5, 14).toFixed(2), alpha: +clamp(0.12 + v / 22, 0.12, 0.55).toFixed(3), speed: v };
}
// Rüzgâr yönü metni (16 yön; geldiği yön)
const COMPASS = ['K', 'KKD', 'KD', 'DKD', 'D', 'DGD', 'GD', 'GGD', 'G', 'GGB', 'GB', 'BGB', 'B', 'BKB', 'KB', 'KKB'];
export const compassName = deg => COMPASS[Math.round(((num(deg, 0) % 360) + 360) % 360 / 22.5) % 16];

// ---------- rampa yön / açı (§13, §31.6) ----------
export const RAMP_LIMITS = { angle: [10, 30], azimuth: [0, 359] };
export function normRampAim(aim, fallbackHeading = 0) {
  const a = aim || {};
  const az = ((Math.round(num(a.azimuth_deg, num(fallbackHeading, 0))) % 360) + 360) % 360;
  const ang = clamp(Math.round(num(a.angle_deg, 15) * 2) / 2, RAMP_LIMITS.angle[0], RAMP_LIMITS.angle[1]);
  return { azimuth_deg: az, angle_deg: ang };
}
// Rampa yönü (§13): launch.azimuth_deg varsa o, yoksa pist yönü
export const rampHeading = (launch, runwayHeading = 0) => (launch && launch.azimuth_deg != null ? num(launch.azimuth_deg, 0) : num(runwayHeading, 0));
// SITL'de yön = ev yönü (SITL --home …,yön): değişirse oturum aynı ayarlarla yeniden konuşlandırılır; yalnız açı → TKOFF_LVL_PITCH (yeniden başlatma yok)
export function rampChange(prev, next, runwayHeading = 0) {
  const p = normRampAim({ azimuth_deg: rampHeading(prev, runwayHeading), angle_deg: prev?.angle_deg }), n = normRampAim(next, p.azimuth_deg);
  const dAz = Math.abs(((n.azimuth_deg - p.azimuth_deg) % 360 + 540) % 360 - 180);
  return { ...n, azimuthChanged: dAz >= 0.5, angleChanged: Math.abs(n.angle_deg - p.angle_deg) >= 0.25, redeploy: dAz >= 0.5 };
}
// Rampa ayarı yalnız kalkıştan ÖNCE: disarm, yerde, düzenek boşta
export const rampEditable = ({ armed, altRel, phase } = {}) => !armed && num(altRel, 0) < 1 && (!phase || phase === 'idle');
