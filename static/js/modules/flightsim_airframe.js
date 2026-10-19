// Uçuş Simülatörü — sabit kanat KONTROL DÜZENİ (docs/ucus-simulatoru.md §13.1): saf katman (DOM/three yok; node ile test edilir:
// tests/test_flightsim_airframe.mjs). Üç düzen: classic (aileron + elevatör, T-kuyruk/klasik; + rudder) · elevon (delta / uçan kanat: iki yüzey hem
// yunuslama hem yatış) · vtail (V-kuyruk: iki ruddervator hem yunuslama hem sapma). Sihirbaz kartları, model → düzen önerisi, kontrol yüzeyi
// animasyonu için SERVO_OUTPUT_RAW → mantıksal eksen komutları → yüzey hedef açıları (flightsim3d updateCtrl buradan beslenir).
//
// ArduPlane SERVOn_FUNCTION kodları: 4 aileron · 19 elevator · 21 rudder · 2 flap · 3 flap_auto · 77 elevon L · 78 elevon R · 79 V-kuyruk L · 80 V-kuyruk R.
// Karışım ArduPlane içindedir (MIXING_GAIN g): elevon L = g(e − a), R = g(e + a); V-kuyruk L = g(e + r), R = g(e − r); + = arka kenar YUKARI.
// SERVOn_REVERSED PWM'i 1500 ekseninde yansıtır; gerçek uçakta ters monteli servo bunu geri çevirir → yüzey MANTIKSAL yöne gider. 3B de
// mantıksal değeri gösterir: out = ±(pwm − 1500)/400 (REVERSED → işaret ters). V-kuyruk/elevon başlangıç setleri (sunucu LAYOUT_PARAMLARI,
// ArduPilot autotest plane-vtail.parm / plane-elevons.parm ile aynı) REVERSED taşır; servo_rev bilinmiyorsa ham PWM alınır.
// Yüzey düğümü adına göre hedef (° arka kenar aşağı +; rudder/ruddervator'da teDown işareti yüzey normaline göredir): aileron L/R = ±a,
// elevator = −e, rudder = +r, elevon L = −(e − a), R = −(e + a), ruddervator L = −(e + r), R = −(e − r), flap = +f. Doğrudan yüzey çıkışı
// varsa (77/78 ya da 79/80 kanalları) karışım ArduPlane'in ürettiğidir ve aynen kullanılır; eksen komutları da ondan geri çözülür
// (e = (L+R)/2, a = (R−L)/2 ya da r = (L−R)/2) — böylece düğüm adı düzenden farklı bir modelde de (Caymaz + V-kuyruk düzeni gibi) yüzeyler tutarlı oynar.

export const LAYOUTS = [
  ['classic', 'Aileron + Elevatör (T-kuyruk)', 'Klasik kuyruk: kanat uçlarında aileron (yatış), yatay kuyrukta elevatör (yunuslama), dikey kuyrukta rudder (sapma). SERVO1 4 · SERVO2 19 · SERVO4 21.'],
  ['elevon', 'Elevon (delta kanat)', 'Delta / uçan kanat: iki elevon hem yunuslama hem yatış (ArduPlane karışımı, MIXING_GAIN). SERVO1 78 · SERVO2 77 (REVERSED 1/1); SITL plane-elevon.'],
  ['vtail', 'V-kuyruk (ruddervator)', 'V-kuyruk: iki ruddervator hem yunuslama hem sapma; kanatta aileron. SERVO1 4 · SERVO2 80 · SERVO4 79 (SERVO2 REVERSED 1); SITL plane-vtail.'],
];
export const LAYOUT_KEYS = LAYOUTS.map(l => l[0]);
export const LAYOUT_LABEL = Object.fromEntries(LAYOUTS.map(([k, n]) => [k, n]));
export const LAYOUT_SHORT = { classic: 'Klasik', elevon: 'Elevon', vtail: 'V-kuyruk' };
export const layoutLabel = (l, tr = s => s) => (l && LAYOUT_LABEL[l] ? tr(LAYOUT_LABEL[l]) : '—');
export const layoutShort = (l, tr = s => s) => (l && LAYOUT_SHORT[l] ? tr(LAYOUT_SHORT[l]) : '—');
// Sunucu LAYOUT_PARAMLARI ile aynı (bilgi satırı / testler)
export const LAYOUT_PARAMS = {
  classic: { SERVO1_FUNCTION: 4, SERVO2_FUNCTION: 19, SERVO4_FUNCTION: 21, SERVO1_REVERSED: 0, SERVO2_REVERSED: 0, SERVO4_REVERSED: 0 },
  elevon: { SERVO1_FUNCTION: 78, SERVO2_FUNCTION: 77, SERVO4_FUNCTION: 0, SERVO1_REVERSED: 1, SERVO2_REVERSED: 1, SERVO4_REVERSED: 0, MIXING_GAIN: 0.5 },
  vtail: { SERVO1_FUNCTION: 4, SERVO2_FUNCTION: 80, SERVO4_FUNCTION: 79, SERVO1_REVERSED: 0, SERVO2_REVERSED: 1, SERVO4_REVERSED: 0, MIXING_GAIN: 0.5 },
};
export const LAYOUT_SITL_MODEL = { classic: 'plane', elevon: 'plane-elevon', vtail: 'plane-vtail' };
export const FN = { AIL: 4, ELE: 19, RUD: 21, FLAP: 2, FLAP_AUTO: 3, ELEVON_L: 77, ELEVON_R: 78, VTAIL_L: 79, VTAIL_R: 80 };
// Yüzey düğümü adları (flightsim3d CTRL_RE): ruddervator V-kuyruk yüzeyi
export const CTRL_RE = /^(elevon|flap|aileron|elevator|rudder|ruddervator)(?:_?(l|r|left|right))?$/i;
export const CTRL_MAX = { elevon: 25, aileron: 25, elevator: 25, rudder: 25, ruddervator: 25, flap: 35 };

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
// ArduPilot SERVOn_MIN/TRIM/MAX varsayılanı 1100/1500/1900: ±400 µs = tam sapma; 900…2100 dışı geçersiz (işlev atanmamış kanal 0 µs)
export const nrm = v => (v >= 900 && v <= 2100 ? clamp((v - 1500) / 400, -1, 1) : 0);
export const flapPct = v => (v >= 900 && v <= 2100 ? clamp((v - 1100) / 800, 0, 1) : null);
const idx = (fn, code) => (Array.isArray(fn) ? fn.findIndex(f => Number(f) === code) : -1);

// Model → önerilen düzen: model.layout (dahili: caymaz/delta elevon, talon vtail) → yüzey düğüm adlarından (ruddervator → vtail, elevon → elevon,
// aileron/elevator → classic) → null (bilinmiyor; sihirbaz mevcut seçimi korur)
export function layoutForModel(model, surfaces = null) {
  if (model && LAYOUT_LABEL[model.layout]) return model.layout;
  const names = Array.isArray(surfaces) ? surfaces.map(s => String(s.surface || s || '').toLowerCase()) : [];
  if (names.includes('ruddervator')) return 'vtail';
  if (names.includes('elevon')) return 'elevon';
  if (names.includes('aileron') || names.includes('elevator') || names.includes('rudder')) return 'classic';
  return null;
}
// Düzenin yüzey adları (önizleme/bilgi): sihirbazda "bu düzende hangi yüzeyler oynar"
export const LAYOUT_SURFACES = { classic: ['aileron', 'elevator', 'rudder'], elevon: ['elevon'], vtail: ['aileron', 'ruddervator'] };

// SERVO_OUTPUT_RAW (µs) → mantıksal ±1 çıkışlar: REVERSED kanalda işaret geri çevrilir (gerçek uçakta montaj yönü; 3B mantıksal yönü gösterir)
export function logicalOutputs(servo, rev = null) {
  if (!Array.isArray(servo)) return null;
  return servo.map((v, i) => { const o = nrm(v); const r = Array.isArray(rev) ? Number(rev[i]) : 0; return r ? -o : o; });
}
export const flapFromMode = mode => { const md = String(mode || '').toUpperCase(); return md === 'TAKEOFF' ? 0.5 : (md === 'LAND' || md === 'QLAND') ? 1 : 0; };

// Girişler: { servo (µs[]), fn (SERVOn_FUNCTION[]), rev (SERVOn_REVERSED[]), rc (µs[]), mode, armed } →
// { ail, ele, rud, flap, elevonL, elevonR, vtailL, vtailR (null = doğrudan çıkış yok), source: 'servo'|'rc'|'none' }. + = arka kenar YUKARI / sağa / burun yukarı.
export function controlInputs(t) {
  const o = { ail: 0, ele: 0, rud: 0, flap: 0, elevonL: null, elevonR: null, vtailL: null, vtailR: null, source: 'none' };
  if (!t || !t.armed) return o;
  const sv = t.servo, fn = Array.isArray(t.fn) ? t.fn : null;
  if (Array.isArray(sv) && sv.length >= 4 && (sv[0] >= 900 || sv[1] >= 900)) {
    o.source = 'servo';
    const out = logicalOutputs(sv, t.rev);
    const iA = idx(fn, FN.AIL), iE = idx(fn, FN.ELE), iR = idx(fn, FN.RUD);
    const iEL = idx(fn, FN.ELEVON_L), iER = idx(fn, FN.ELEVON_R), iVL = idx(fn, FN.VTAIL_L), iVR = idx(fn, FN.VTAIL_R);
    o.ail = iA >= 0 ? out[iA] : 0; o.ele = iE >= 0 ? out[iE] : 0; o.rud = iR >= 0 ? out[iR] : 0;
    if (iEL >= 0 || iER >= 0) {   // elevon düzeni: doğrudan yüzey çıkışları; eksen komutları geri çözülür (L = e − a, R = e + a)
      o.elevonL = iEL >= 0 ? out[iEL] : 0; o.elevonR = iER >= 0 ? out[iER] : 0;
      o.ele = (o.elevonL + o.elevonR) / 2; o.ail = (o.elevonR - o.elevonL) / 2;
    }
    if (iVL >= 0 || iVR >= 0) {   // V-kuyruk: L = e + r, R = e − r
      o.vtailL = iVL >= 0 ? out[iVL] : 0; o.vtailR = iVR >= 0 ? out[iVR] : 0;
      o.ele = (o.vtailL + o.vtailR) / 2; o.rud = (o.vtailL - o.vtailR) / 2;
    }
    if (!fn) { o.ail = out[0]; o.ele = out[1]; o.rud = out.length > 3 ? out[3] : 0; }   // işlev bilinmiyor: ArduPlane varsayılan kanalları 1/2/4
    let fl = fn ? fn.map((f, i) => (Number(f) === FN.FLAP || Number(f) === FN.FLAP_AUTO ? i : -1)).filter(i => i >= 0) : [];
    if (!fl.length) fl = [4, 5];
    let acc = 0, n = 0;
    for (const i of fl) { const f = flapPct(sv[i]); if (f !== null) { acc += f; n++; } }
    o.flap = n ? acc / n : flapFromMode(t.mode);
    if (n && !fn && o.flap === 0) o.flap = flapFromMode(t.mode);
    return o;
  }
  const rc = t.rc;
  if (Array.isArray(rc) && rc.length >= 2) {   // sahte kip / kayıt: kumanda kanalları 1 roll, 2 pitch, 4 yaw
    o.source = 'rc';
    o.ail = nrm(rc[0]); o.ele = nrm(rc[1]); o.rud = rc.length > 3 ? nrm(rc[3]) : 0;
    o.flap = flapFromMode(t.mode);
  }
  return o;
}

// Yüzey hedef açısı (° arka kenar AŞAĞI +; rudder/ruddervator'da + = yüzey normali tersine, teDown işareti bunu üstlenir)
export function surfaceTarget(surface, side, o, max = CTRL_MAX) {
  const L = side === 'l', mx = max[surface] || 25;
  switch (surface) {
    case 'elevon': {
      const up = o.elevonL !== null && o.elevonL !== undefined ? (L ? o.elevonL : o.elevonR) : (L ? o.ele - o.ail : o.ele + o.ail);
      return -clamp(up, -1, 1) * mx;
    }
    case 'ruddervator': {
      const up = o.vtailL !== null && o.vtailL !== undefined ? (L ? o.vtailL : o.vtailR) : (L ? o.ele + o.rud : o.ele - o.rud);
      return -clamp(up, -1, 1) * mx;
    }
    case 'aileron': return (L ? 1 : -1) * clamp(o.ail, -1, 1) * mx;   // sağa yatış: sol arka kenar aşağı, sağ yukarı
    case 'elevator': return -clamp(o.ele, -1, 1) * mx;
    case 'rudder': return clamp(o.rud, -1, 1) * mx;                    // + = arka kenar sağa
    case 'flap': return clamp(o.flap, 0, 1) * mx;
    default: return 0;
  }
}
// Servo dinamiği: 1. derece gecikme (τ) + hız sınırı (°/s); dt gerçek süre
export const CTRL_RATE = 400, CTRL_TAU = 0.04;
export function easeSurface(cur, tgt, dt, rate = CTRL_RATE, tau = CTRL_TAU) {
  const want = cur + (tgt - cur) * Math.min(1, dt / tau);
  const step = rate * dt;
  return clamp(want, cur - step, cur + step);
}
