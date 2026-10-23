// Uçuş Simülatörü §47 — HAZIR FPV PARKURLARI: SAF yardımcılar (DOM / three.js YOK; node testi tests/test_flightsim_fpvcourse.mjs). HEPGO + SIMUMAV ortak.
// Sunucu sözleşmesi app/flightsim_fpv.py (parkur tanımı, kapı geometrisi, kontrol noktaları, hayalet kodlaması) ve app/flightsim_match_core.py (TUR_FPV).
// Geçiş doğrulaması / süre / ceza SUNUCUDADIR; burada yalnız gösterim: hayalet çözücü + ara değer, fark, biçimleme, sektör rengi, kapı eksenleri,
// sıradaki kapı / kapı durumları, galeri kartı verisi ve kuş bakışı SVG, çubuk konumu (mod-2), istemci doğrulaması, ortam (atmosfer) parametreleri.
// Metinler FPV_TEXTS ([anahtar, Türkçe]) — HEPGO Türkçe anahtarla tr(), SIMUMAV `fpv.*` anahtarıyla (makeFpvT(tr, keyed)).
// Koordinat: parkur merkezine göre yerel ENU m (x doğu, y kuzey, z ZEMİNDEN); yaw pusula ° (0 kuzey, saat yönü); ileri = (sin, cos), sağ = (cos, −sin).

const DEG = Math.PI / 180;
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const num = (v, d = null) => (v == null || v === '' || !Number.isFinite(Number(v)) ? d : Number(v));

// ---------------------------------------------------------------- metinler
export const FPV_TEXTS = [
  ['fpv.kind', 'FPV parkur yarışı'], ['fpv.kind_short', 'FPV parkur'],
  ['fpv.kind_d', 'Hazır parkurlarda neon kapılardan, bayraklardan ve tünellerden geçen tur yarışı; tek başına zaman denemesi ya da 2–8 oyuncu.'],
  ['fpv.gallery', 'Hazır parkurlar'], ['fpv.loading', 'Parkurlar yükleniyor…'], ['fpv.load_err', 'Parkurlar alınamadı'],
  ['fpv.length', 'Uzunluk'], ['fpv.gates', 'Kapı'], ['fpv.gates_n', '{n} kapı'], ['fpv.difficulty', 'Zorluk'], ['fpv.record', 'Rekor'], ['fpv.my_best', 'En iyim'],
  ['fpv.no_record', 'Henüz rekor yok'], ['fpv.runs', '{n} deneme'], ['fpv.kinds', 'Kapı türleri'], ['fpv.laps', 'Tur sayısı'], ['fpv.laps_n', '{n} tur'],
  ['fpv.crash_rule', 'Çarpma kuralı'], ['fpv.rule_penalty', 'Cezalı'], ['fpv.rule_reset', 'Başlangıca dön'], ['fpv.rule_continue', 'Devam'],
  ['fpv.rule_penalty_d', 'Çarpan araç yoluna devam eder; her çarpma süreye ceza ekler.'], ['fpv.rule_reset_d', 'Çarpan araç başlangıç pedine döner; ilerlemesi korunur.'],
  ['fpv.rule_continue_d', 'Çarpmalar yalnız sayılır; ceza yok.'], ['fpv.crash_pen', 'Çarpma cezası'], ['fpv.miss_pen', 'Kaçırılan kapı cezası'], ['fpv.time_limit', 'Süre sınırı'],
  ['fpv.type_warn', 'FPV parkurları yalnız çok rotorlu araçlarla (multikopter / hexakopter / helikopter) uçulur. Araç adımında birini seçin.'],
  ['fpv.pick', 'Bir parkur seçin'], ['fpv.world_note', 'Dünya parkurdan gelir: mekan, saat, sis ve zemin parkurla birlikte kurulur.'],
  ['fpv.ghost', 'Hayalet'], ['fpv.ghost_pb', 'Kişisel rekor'], ['fpv.ghost_off', 'Kapalı'], ['fpv.ghost_d', 'Kişisel rekorunuzun hayaleti yarış saatine göre sizinle aynı anda uçar.'],
  ['fpv.leaderboard', 'Firma içi skor tablosu'], ['fpv.lb_empty', 'Bu parkurda henüz kayıt yok — ilk rekoru siz kırın.'],
  ['fpv.rank', 'Sıra'], ['fpv.pilot', 'Pilot'], ['fpv.time', 'Süre'], ['fpv.best_lap', 'En iyi tur'], ['fpv.misses', 'Kaçırma'], ['fpv.hits', 'Çarpma'], ['fpv.penalty', 'Ceza'],
  ['fpv.date', 'Tarih'], ['fpv.course', 'Parkur'], ['fpv.rules', 'Kurallar'], ['fpv.you', 'siz'],
  ['fpv.k_start', 'Başlangıç / bitiş'], ['fpv.k_gate', 'Kapı'], ['fpv.k_circle', 'Halka'], ['fpv.k_window', 'Pencere'], ['fpv.k_dive', 'Dalış kapısı'],
  ['fpv.k_ladder', 'Merdiven kapı'], ['fpv.k_tunnel', 'Tünel'], ['fpv.k_flag', 'Bayrak'], ['fpv.k_slalom', 'Slalom'],
  ['fpv.d1', 'Kolay'], ['fpv.d2', 'Orta'], ['fpv.d3', 'Zor'], ['fpv.d4', 'Çok zor'], ['fpv.d5', 'Uzman'],
  ['fpv.c_hangar', 'Kapalı Hangar'], ['fpv.c_forest', 'Çam Ormanı'], ['fpv.c_city', 'Yarı Yıkık Şehir'], ['fpv.c_stadium', 'Gece Stadyumu'], ['fpv.c_refinery', 'Rafineri'],
  ['fpv.c_canyon', 'Kanyon Geçidi'], ['fpv.c_woodframe', 'Tepedeki Ahşap Ev İskeleti'], ['fpv.c_concrete', 'Yarım Beton Bina'],
  ['fpv.v_hangar', 'Kapalı depo / hangar'], ['fpv.v_forest', 'Orman'], ['fpv.v_city', 'Şehir / yarı yıkık yapılar'], ['fpv.v_stadium', 'Stadyum'],
  ['fpv.v_refinery', 'Endüstriyel tesis'], ['fpv.v_canyon', 'Kanyon / dağ geçidi'], ['fpv.v_woodframe', 'Çayır tepesi'], ['fpv.v_concrete', 'İnşaat alanı'],
  ['fpv.solo', 'Tek kişilik — zaman denemesi'], ['fpv.solo_badge', 'Tek kişilik'], ['fpv.solo_hint', 'Kimseyi davet etmeden de başlatabilirsiniz: tek kişilik zaman denemesi (it dalaşı hariç).'],
  ['fpv.time_trial', 'Zaman denemesi'], ['fpv.start_tt', 'Zaman denemesi başlat'], ['fpv.tt_open', 'Hazır FPV parkurları'],
  ['fpv.tt_open_d', 'Neon kapılı hazır parkurlarda tek başına zaman denemesi; kişisel rekor hayaletinize karşı uçun.'], ['fpv.vehicle', 'Araç'], ['fpv.center', 'Merkez'],
  ['fpv.tt_created', 'Zaman denemesi hazırlanıyor; simülatör açılıyor'], ['fpv.no_center', 'Önce bir merkez seçin (Dünya ve konum).'],
  ['fpv.lap', 'TUR'], ['fpv.best', 'EN İYİ'], ['fpv.total', 'TOPLAM'], ['fpv.pen', 'CEZA'], ['fpv.ghost_hud', 'HAYALET'], ['fpv.next_gate', 'KAPI {i}/{n}'],
  ['fpv.to_start', 'BAŞLANGIÇ KAPISINA'], ['fpv.missed', 'KAPI KAÇIRILDI +{s} sn'], ['fpv.hit', 'ÇARPMA +{s} sn'], ['fpv.hit0', 'ÇARPMA'], ['fpv.reset', 'BAŞLANGICA DÖNÜLDÜ'],
  ['fpv.wrong', 'TERS YÖN — kapıyı ok yönünde geçin'], ['fpv.lap_done', 'TUR {n} · {t}'], ['fpv.best_lap_new', 'EN İYİ TUR!'], ['fpv.sector_best', 'SEKTÖR REKORU'],
  ['fpv.finished', 'BİTİRDİNİZ · {t}'], ['fpv.go', 'BAŞLA! Kapıları sırayla ve ok yönünde geçin'], ['fpv.sticks', 'Çubuk göstergesi'],
  ['fpv.sticks_d', 'FPV görünümünde altta iki küçük çubuk-konumu göstergesi (sol: gaz / sapma, sağ: yunuslama / yatış)'],
  ['fpv.result_tt', 'Zaman denemesi sonucu'], ['fpv.total_time', 'Toplam süre'], ['fpv.lap_times', 'Tur süreleri'], ['fpv.sectors', 'Sektörler'], ['fpv.sector_n', 'S{n}'],
  ['fpv.new_pb', 'KİŞİSEL REKOR!'], ['fpv.pb_prev', 'Önceki rekor {t} ({d})'], ['fpv.pb_first', 'Bu parkurdaki ilk kaydınız'], ['fpv.pb_keep', 'Kişisel rekorunuz {t} ({d})'],
  ['fpv.lb_place', 'Skor tablosunda yeriniz: {r}. / {n}'], ['fpv.dnf', 'Bitirilmedi'], ['fpv.completed', 'Tamamlandı'], ['fpv.r_tamamlandi', 'Parkur tamamlandı'],
  ['fpv.r_hepsi_bitirdi', 'Herkes bitirdi'], ['fpv.r_son_cagri', 'Son çağrı süresi doldu'], ['fpv.wait_go', 'Kalkış serbest olunca kapıları sırayla ve ok yönünde geçin.'],
  ['fpv.ring_solo', 'Tek kişilik halka yarışı'], ['fpv.ring_done', 'Tamamlandı · {t}'], ['fpv.not_done', 'Tamamlanmadı · {i} / {n} halka'],
  ['fpv.summary_rules', '{laps} tur · çarpma: {rule} · ceza {cp} sn / kaçırma {mp} sn · {tl} dk'],
];
const TXT = Object.fromEntries(FPV_TEXTS);
const fill = (s, p) => (p ? String(s).replace(/\{(\w+)\}/g, (m, k) => (p[k] != null ? String(p[k]) : m)) : String(s));
/** HEPGO: makeFpvT(tr) → tr(Türkçe, p); SIMUMAV: makeFpvT(tr, true) → tr('fpv.x', p) (yoksa Türkçe). */
export const makeFpvT = (tr, keyed = false) => (k, p) => {
  const tx = TXT[k] ?? k;
  if (!tr) return fill(tx, p);
  if (!keyed) return tr(tx, p);
  const r = tr(k, p);
  return r && r !== k ? r : fill(tx, p);
};

// ---------------------------------------------------------------- sınırlar (sunucu meta'sı limits.fpv gelir; bunlar yedek — app/flightsim_fpv.py ile aynı)
export const FPV_LIMITS = {
  types: ['multirotor', 'hexarotor', 'helikopter'], laps: [1, 10], crash_rules: ['penalty', 'reset', 'continue'], penalty_s: [0, 30], time_limit_min: [2, 30],
  defaults: { course_id: 'hangar', laps: 3, crash_rule: 'penalty', crash_penalty_s: 2, miss_penalty_s: 3, time_limit_min: 10, seed: null },
};
export const COURSE_IDS = ['hangar', 'forest', 'city', 'stadium', 'refinery', 'canyon', 'woodframe', 'concrete'];
export const GATE_KINDS = ['start', 'gate', 'circle', 'window', 'dive', 'ladder', 'tunnel', 'flag', 'slalom'];
export const isFpvType = (type, limits = FPV_LIMITS) => (limits?.types || FPV_LIMITS.types).includes(type);
/** Varsayılan ayar (parkurun tur sayısı). */
export const fpvDefaults = (course = null, limits = FPV_LIMITS) => ({ ...(limits?.defaults || FPV_LIMITS.defaults), ...(course ? { course_id: course.id, laps: course.laps ?? (limits?.defaults || FPV_LIMITS.defaults).laps } : {}) });
/** İstemci doğrulaması (sunucu fpv_ayar_dogrula ile aynı kurallar). Dönüş: fpv.* anahtarı / Türkçe metin ya da null. */
export function fpvError(c, type = null, limits = FPV_LIMITS) {
  const L = { ...FPV_LIMITS, ...(limits || {}) };
  if (type != null && !L.types.includes(type)) return 'fpv.type_warn';
  if (!c || !c.course_id) return 'fpv.pick';
  const inR = (v, [a, b]) => Number.isFinite(Number(v)) && Number(v) >= a && Number(v) <= b;
  if (c.laps != null && (!inR(c.laps, L.laps) || !Number.isInteger(Number(c.laps)))) return 'Tur sayısı geçersiz';
  if (c.crash_rule != null && !L.crash_rules.includes(c.crash_rule)) return 'Çarpma kuralı geçersiz';
  for (const k of ['crash_penalty_s', 'miss_penalty_s']) if (c[k] != null && !inR(c[k], L.penalty_s)) return 'Ceza süresi geçersiz';
  if (c.time_limit_min != null && (!inR(c.time_limit_min, L.time_limit_min) || !Number.isInteger(Number(c.time_limit_min)))) return 'Süre sınırı geçersiz';
  return null;
}
/** POST /matches gövdesindeki `fpv` alanı. */
export const fpvBody = c => ({ course_id: c.course_id, laps: Number(c.laps), crash_rule: c.crash_rule, crash_penalty_s: Number(c.crash_penalty_s), miss_penalty_s: Number(c.miss_penalty_s), time_limit_min: Number(c.time_limit_min) });
/** Özet satırı: "3 tur · çarpma: Cezalı · ceza 2 sn / kaçırma 3 sn · 10 dk". */
export const fpvRulesText = (c, T = makeFpvT(null)) => (c ? T('fpv.summary_rules', { laps: c.laps, rule: T(`fpv.rule_${c.crash_rule || 'penalty'}`), cp: num(c.crash_penalty_s, 0), mp: num(c.miss_penalty_s, 0), tl: c.time_limit_min }) : '—');

// ---------------------------------------------------------------- tek kişilik (zaman denemesi) — §47: halka yarışı ve FPV'de davet + bot 0 olabilir; it dalaşı tam 2
export const soloAllowed = kind => (kind || 'rings') !== 'dogfight';
/** Rakip sayısı doğrulaması (flightsim_match.opponentsError'ın tek kişilik genişlemesi). null = geçerli. */
export function opponentsErrorSolo(nInvited, nBots, kind = 'rings', max = 7, limits = { players_max: 8 }) {
  const n = (Number(nInvited) || 0) + (Number(nBots) || 0);
  if (kind === 'dogfight') return n === 1 ? null : 'İt dalaşı tam 2 oyuncuyla oynanır: bir kullanıcı davet edin ya da bir yapay zekâ pilot ekleyin';
  if (n > Math.min(max ?? 99, (limits?.players_max ?? 8) - 1)) return 'Davet sınırı aşıldı';
  return null;
}
export const isSolo = (nInvited, nBots) => (Number(nInvited) || 0) + (Number(nBots) || 0) === 0;
/** Karşılaşma (liste satırı ya da anlık görüntü) tek kişilik mi. */
export const matchIsSolo = m => !!(m?.result?.solo ?? ((m?.players || []).filter(p => p.status !== 'cikarildi').length === 1));

// ---------------------------------------------------------------- biçimleme
/** Tur / süre: m:ss.000 (negatif değer 0). */
export function fmtLap(s) {
  if (s == null || !Number.isFinite(Number(s))) return '—';
  const ms = Math.max(0, Math.round(Number(s) * 1000)), m = Math.floor(ms / 60000), r = ms - m * 60000;
  return `${m}:${String(Math.floor(r / 1000)).padStart(2, '0')}.${String(r % 1000).padStart(3, '0')}`;
}
/** Fark: +1.234 / −0.512 (eksi işareti U+2212); null → '—'. */
export const fmtDelta = (d, digits = 3) => (d == null || !Number.isFinite(Number(d)) ? '—' : `${Number(d) >= 0 ? '+' : '−'}${Math.abs(Number(d)).toFixed(digits)}`);
export const fmtLen = m => (m == null ? '—' : Number(m) >= 1000 ? `${(Number(m) / 1000).toFixed(2)} km` : `${Math.round(Number(m))} m`);
export const stars = (n, max = 5) => { const k = clamp(Math.round(Number(n) || 0), 0, max); return '★'.repeat(k) + '☆'.repeat(max - k); };

// ---------------------------------------------------------------- hayalet (app/flightsim_fpv.hayalet_kodla / hayalet_coz ile birebir)
const GHOST_SCALE = [100, 50, 50, 50, 500, 500, 500];
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const B64I = (() => { const o = new Int16Array(128).fill(-1); for (let i = 0; i < 64; i++) o[B64.charCodeAt(i)] = i; o['+'.charCodeAt(0)] = 62; o['/'.charCodeAt(0)] = 63; return o; })();
function b64urlBytes(s) {
  const out = [];
  let acc = 0, bits = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 61) break;   // '='
    const v = c < 128 ? B64I[c] : -1;
    if (v < 0) throw new Error('Hayalet verisi tanınmadı');
    acc = (acc << 6) | v; bits += 6;
    if (bits >= 8) { bits -= 8; out.push((acc >> bits) & 0xff); }
    acc &= (1 << bits) - 1;
  }
  return out;
}
/** 'g1.' + base64url(zigzag varint farkları) → [{t, x, y, z, yaw, roll, pitch}] (t sn yarış başından, z zeminden m, açılar rad; yaw tam sayı uzayında mod ile [−π, π) — sunucu hayalet_coz). */
export function decodeGhost(s) {
  if (typeof s !== 'string' || !s.startsWith('g1.')) throw new Error('Hayalet verisi tanınmadı');
  const b = b64urlBytes(s.slice(3));
  let pos = 0;
  const read = () => {
    let n = 0, mul = 1;
    for (;;) {
      if (pos >= b.length) throw new Error('Hayalet verisi eksik');
      const c = b[pos++];
      n += (c & 0x7f) * mul; mul *= 128;
      if (!(c & 0x80)) break;
    }
    return n % 2 ? -(n + 1) / 2 : n / 2;   // zigzag (büyük sayılarda bit işlemi yok)
  };
  const cnt = read();
  const cur = [0, 0, 0, 0, 0, 0, 0], out = new Array(cnt);
  for (let i = 0; i < cnt; i++) {
    for (let k = 0; k < 7; k++) cur[k] += read();
    const yq = (((cur[4] + 1571) % 3142) + 3142) % 3142 - 1571;   // yaw: tam sayı uzayında pozitif mod (tam = round(2π·500) = 3142) → [−π, π)
    out[i] = { t: cur[0] / 100, x: cur[1] / 50, y: cur[2] / 50, z: cur[3] / 50, yaw: yq / 500, roll: cur[5] / 500, pitch: cur[6] / 500 };
  }
  return out;
}
const lerpA = (a, b, f) => { const d = ((b - a + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI; return a + d * f; };
/** Hayaletin t anındaki pozu (ikili arama + doğrusal ara değer; yaw en kısa yay). Başlangıçtan önce ilk örnek, sonra son örnek (done). */
export function ghostPoseAt(samples, t) {
  if (!samples?.length || t == null || !Number.isFinite(Number(t))) return null;
  const T = Number(t), n = samples.length;
  if (T <= samples[0].t) return { ...samples[0], idx: 0, before: T < samples[0].t, done: false };
  if (T >= samples[n - 1].t) return { ...samples[n - 1], idx: n - 1, before: false, done: true };
  let lo = 0, hi = n - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (samples[m].t <= T) lo = m; else hi = m; }
  const a = samples[lo], b = samples[hi], f = b.t > a.t ? (T - a.t) / (b.t - a.t) : 0, L = (u, v) => u + (v - u) * f;
  return { t: T, x: L(a.x, b.x), y: L(a.y, b.y), z: L(a.z, b.z), yaw: lerpA(a.yaw, b.yaw, f), roll: L(a.roll, b.roll), pitch: L(a.pitch, b.pitch), idx: lo, before: false, done: false };
}
/** Hayalete göre fark (sn): benim ara sürem − hayaletinki (kontrol noktası sırası idx, 0 tabanlı; verilmezse benim son ara sürem). + = gerideyim. */
export function ghostDelta(mySplits, ghostSplits, idx = null) {
  if (!Array.isArray(mySplits) || !Array.isArray(ghostSplits) || !mySplits.length) return null;
  const k = idx == null ? mySplits.length - 1 : Number(idx);
  if (!(k >= 0) || k >= mySplits.length || k >= ghostSplits.length) return null;
  const a = num(mySplits[k]), b = num(ghostSplits[k]);
  return a == null || b == null ? null : Math.round((a - b) * 1000) / 1000;
}
/** Sektör rengi: genel en iyi (rekor) ve altı → 'purple' · kişisel en iyi ve altı (ya da ilk) → 'green' · yavaş → 'yellow'. */
export function sectorClass(s, { pb = null, best = null } = {}) {
  const v = num(s);
  if (v == null) return 'none';
  if (best != null && v <= Number(best) + 1e-9) return 'purple';
  if (pb == null || v <= Number(pb) + 1e-9) return 'green';
  return 'yellow';
}
/** Ara sürelerden (kontrol noktası başına t − t0) sektör süreleri [[tur1: s1, s2…], …] — sunucu ParkurIzleyici kuralıyla (sayaç S/F ilk geçişinde başlar). */
export function sectorTimesFromSplits(splits, cps) {
  const out = [];
  if (!Array.isArray(splits) || !Array.isArray(cps)) return out;
  let t0 = null;
  for (let k = 0; k < Math.min(splits.length, cps.length); k++) {
    const c = cps[k], t = num(splits[k]);
    if (t == null) continue;
    if (c.lap === 0) { t0 = t; out.push([]); continue; }
    if (c.sector_end && t0 != null) { if (!out.length) out.push([]); out[out.length - 1].push(Math.round((t - t0) * 1000) / 1000); t0 = t; }
    if (c.gate === 0 && c.lap < Math.max(...cps.map(x => x.lap))) out.push([]);
  }
  return out.filter((r, i) => r.length || i === 0);
}
/** Sektör numarası → en iyi süre (sektör listesi [[…], …] üstünden). */
export const bestSectors = sectors => { const o = {}; (sectors || []).forEach(row => (row || []).forEach((s, j) => { const v = num(s); if (v != null && (o[j + 1] == null || v < o[j + 1])) o[j + 1] = v; })); return o; };

// ---------------------------------------------------------------- kapı geometrisi (app/flightsim_fpv.kapi_eksenleri ile aynı eksenler)
export const fwdOf = yawDeg => { const a = Number(yawDeg) * DEG; return [Math.sin(a), Math.cos(a), 0]; };
export const rightOf = yawDeg => { const a = Number(yawDeg) * DEG; return [Math.cos(a), -Math.sin(a), 0]; };
/** {n (geçiş normali), u (sağ), v (yukarı)} — dikey kapıda n = ileri(yaw), v = (0,0,1); dalış kapısında n = (0,0,−1), u = sağ(yaw), v = ileri(yaw). */
export function gateAxes(g) {
  if (g?.kind === 'dive') return { n: [0, 0, -1], u: rightOf(g.yaw), v: fwdOf(g.yaw) };
  return { n: fwdOf(g.yaw), u: rightOf(g.yaw), v: [0, 0, 1] };
}
/** {shape 'rect'|'circle', w, h} (çemberde w = h = yarıçap — sunucu kapi_acikligi). */
export const gateOpening = g => (g?.kind === 'circle' ? { shape: 'circle', w: Number(g.r ?? g.w / 2), h: Number(g.r ?? g.h / 2) } : { shape: 'rect', w: Number(g.w), h: Number(g.h) });
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
/** p0 → p1 kapı düzlemini kesiyor mu (sunucu kapi_kesisim): {dir 'ileri'|'ters'|null, inside, dist}. */
export function gateCrossing(p0, p1, g) {
  const c = [Number(g.x), Number(g.y), Number(g.z)], { n, u, v } = gateAxes(g);
  const d0 = dot(sub(p0, c), n), d1 = dot(sub(p1, c), n);
  let dir;
  if (d0 < 0 && d1 >= 0) dir = 'ileri'; else if (d0 >= 0 && d1 < 0) dir = 'ters'; else return { dir: null, inside: false, dist: null };
  const t = d0 / (d0 - d1), q = [p0[0] + (p1[0] - p0[0]) * t, p0[1] + (p1[1] - p0[1]) * t, p0[2] + (p1[2] - p0[2]) * t], r = sub(q, c);
  const a = dot(r, u), b = dot(r, v), o = gateOpening(g);
  const inside = o.shape === 'circle' ? Math.hypot(a, b) <= o.w : Math.abs(a) <= o.w / 2 && Math.abs(b) <= o.h / 2;
  return { dir, inside, dist: Math.sqrt(dot(r, r)) };
}
/** Kapı açıklığının dünya köşeleri (dikdörtgen: 4; çember: `seg` nokta) — HUD çerçevesi / 3B. */
export function gateCorners(g, seg = 16, pad = 0) {
  const c = [Number(g.x), Number(g.y), Number(g.z)], { u, v } = gateAxes(g), o = gateOpening(g);
  const P = (a, b) => [c[0] + u[0] * a + v[0] * b, c[1] + u[1] * a + v[1] * b, c[2] + u[2] * a + v[2] * b];
  if (o.shape === 'circle') { const R = o.w + pad; return Array.from({ length: seg }, (_, i) => { const t = i / seg * 2 * Math.PI; return P(Math.cos(t) * R, Math.sin(t) * R); }); }
  const hw = o.w / 2 + pad, hh = o.h / 2 + pad;
  return [P(-hw, -hh), P(hw, -hh), P(hw, hh), P(-hw, hh)];
}
/** Kontrol noktası → kapı (sunucu kontrol_kapisi). */
export const checkpointGate = h => ({ kind: h.kind, x: h.x, y: h.y, z: h.z, yaw: h.yaw_deg ?? h.yaw, w: h.w, h: h.h, ...(h.shape === 'circle' ? { r: h.w / 2 } : {}) });
/** Bayrak / slalom direği tarafı: direk konumu + sanal kapının dönüş yönü (sağ/sol) → ok işareti (+1 saat yönü, −1 tersi). */
export const flagTurn = g => (g?.side === 'right' ? -1 : 1);
/** Başlangıç pedi ızgarası (sunucu parkur_baslangiclari): [{x, y, yaw}]. */
export function startSlots(course, n) {
  const st = course?.start || { x: 0, y: 0, yaw: 0 };
  const yaw = Number(st.yaw) || 0, f = fwdOf(yaw), r = rightOf(yaw), cols = Math.max(1, Number(st.cols) || 4), gap = Number(st.gap) || 2.2;
  const out = [];
  for (let k = 0; k < Math.max(1, Number(n) || 1); k++) {
    const row = Math.floor(k / cols), col = k % cols, m = Math.min(cols, n - row * cols), o = (col - (m - 1) / 2) * gap;
    out.push({ x: Math.round((st.x + r[0] * o - f[0] * 2.5 * row) * 100) / 100, y: Math.round((st.y + r[1] * o - f[1] * 2.5 * row) * 100) / 100, yaw });
  }
  return out;
}

// ---------------------------------------------------------------- ilerleme: sıradaki kontrol noktası + kapı durumları
/** next: sunucunun `next` alanı (sıradaki kontrol noktası i, 1 tabanlı; null = bitti). */
export const nextCheckpoint = (cps, next) => (next == null ? null : (cps || []).find(c => c.i === Number(next)) || null);
/** Sıradaki + sonraki `ahead` kontrol noktası. */
export function upcoming(cps, next, ahead = 2) {
  if (next == null || !cps?.length) return [];
  const k = cps.findIndex(c => c.i === Number(next));
  return k < 0 ? [] : cps.slice(k, k + 1 + ahead);
}
/** Parkur kapıları için durum dizisi: 'next' (sıradaki — yeşil nabız) · 'soon' (sonraki 1–2 — pembe/mor) · 'done' (geçildi / beklemede — sönük).
 *  Bitti (next null) → hepsi 'done'. Kapı sonraki turda tekrar gelir; aynı kapı hem sıradaki hem sonraki olamaz (önce 'next'). */
export function gateStates(nGates, cps, next, ahead = 2) {
  const st = new Array(Math.max(0, nGates)).fill('done');
  const up = upcoming(cps, next, ahead);
  up.forEach((c, k) => { if (c.gate >= 0 && c.gate < st.length && st[c.gate] === 'done') st[c.gate] = k === 0 ? 'next' : k === 1 ? 'soon' : 'soon2'; });
  return st;
}
/** HUD ilerleme metni: {lap (1…; S/F holeshot öncesi 0), laps, gateNo (tur içi 1…), gatesPerLap, checkpoint}. */
export function progressInfo(cps, next, laps = null) {
  const c = nextCheckpoint(cps, next), L = laps ?? Math.max(1, ...(cps || []).map(x => x.lap));
  const per = new Set((cps || []).filter(x => x.lap === 1).map(x => x.gate)).size || 1;
  if (!c) return { lap: L, laps: L, gateNo: per, gatesPerLap: per, checkpoint: null, done: true };
  return { lap: c.lap, laps: L, gateNo: c.lap === 0 ? 0 : (c.gate === 0 ? per : c.gate), gatesPerLap: per, checkpoint: c, done: false };
}

// ---------------------------------------------------------------- galeri kartı + kuş bakışı
/** Kart verisi (GET /fpv/courses satırı ya da tam tanım). */
export function galleryCard(c, T = makeFpvT(null)) {
  if (!c) return null;
  const rec = c.record || null;
  return { id: c.id, name: TXT[`fpv.c_${c.id}`] ? T(`fpv.c_${c.id}`) : c.name, venue: TXT[`fpv.v_${c.id}`] ? T(`fpv.v_${c.id}`) : c.venue_name, length: fmtLen(c.length_m), lengthM: num(c.length_m, 0),
    gates: num(c.gate_count, c.gates?.length ?? 0), gatesText: T('fpv.gates_n', { n: num(c.gate_count, c.gates?.length ?? 0) }), difficulty: num(c.difficulty, 1), stars: stars(c.difficulty),
    difficultyName: T(`fpv.d${clamp(num(c.difficulty, 1), 1, 5)}`), laps: num(c.laps, 1), lapsText: T('fpv.laps_n', { n: num(c.laps, 1) }), sectors: num(c.sectors, 1),
    kinds: (c.kinds || []).filter(k => GATE_KINDS.includes(k)).map(k => T(`fpv.k_${k}`)),
    record: rec ? { name: rec.name, time: fmtLap(rec.time_s), time_s: rec.time_s } : null, myBest: c.my_best != null ? fmtLap(c.my_best) : null, runs: num(c.runs, 0),
    env: c.env || {}, par: num(c.par_lap_s) };
}
// Malzeme belirteci → temel renk (3B + SVG ortak). Bilinmeyen → 'frame' varsayılanı.
export const MAT_COLORS = {
  concrete: 0x9b9a95, hangar_wall: 0x8d9298, hangar_roof: 0x6e7379, steel_beam: 0x5b636c, rack: 0x2f6fb0, crate: 0xb88a4e, block: 0xa9a59c, duct: 0xb8bec4,
  forklift: 0xe8b21c, pallet: 0xa77c49, truss: 0xd8d8d0, log: 0x6b4a2e, bark: 0x5a3f2a, needle: 0x2d5a34, leaf: 0x4f7d34, bush: 0x46703a, rock: 0x7d776f,
  brick: 0x9a4f3a, plaster: 0xcfc4ae, slab: 0x8f8c86, bridge: 0x868a8f, rubble: 0x8a8378, pole: 0x6f7378, stand: 0x4b5563, steel: 0x8a929b, inflatable: 0xef4444,
  scaffold: 0xb9c0c7, steel_frame: 0x52606d, pipe: 0x9aa4ad, pipe_insulated: 0xd7dadc, grating: 0x707a83, railing_yellow: 0xf2c41b, tank: 0xd9dcde,
  container_0: 0xc2410c, container_1: 0x1d4ed8, container_2: 0x15803d, container_3: 0x9f1239, chimney: 0xb4aca2, rock_wall: 0x8a6e55, rock_arch: 0x7c624c,
  waterfall: 0xcfe8ff, water: 0x3b82c4, timber: 0xc49a63, planks: 0xb88a57, hay: 0xd9b45a, concrete_raw: 0xa3a19b, slab_raw: 0x96948e, scaffold_deck: 0x8b6b45,
  crane: 0xf2b705, rebar: 0x8b5a3c, frame: 0x6b7280,
};
export const matColor = m => MAT_COLORS[m] ?? MAT_COLORS.frame;
export const GROUND_COLORS = { concrete: 0x77767a, forest: 0x3d4a2c, asphalt: 0x3b3d42, turf: 0x2f6b2f, industrial: 0x5d5f61, rock: 0x8a7458, meadow: 0x6f8c3c, dirt: 0x8a7253 };
export const GATE_COLORS = { next: 0x39ff6e, soon: 0xff2bd6, soon2: 0xa855f7, done: 0x5b6676, start: 0x39ff6e };
const hex = c => `#${(c >>> 0).toString(16).padStart(6, '0')}`;
/** Kuş bakışı SVG metni (galeri / salon / sonuç): engeller (dekor soluk), yarış hattı, kapılar (numaralı; S/F yeşil), başlangıç pedi.
 *  opts: {w (viewBox genişliği, varsayılan 100), labels (numara), decor, highlight (kapı sırası)} */
export function courseSvg(c, { labels = true, decor = true, highlight = null, title = '' } = {}) {
  if (!c?.gates) return '<svg viewBox="0 0 100 60"></svg>';
  const env = c.env || {}, [sw, sd] = env.size || [100, 100];
  const xs = [-sw / 2, sw / 2, c.start?.x ?? 0], ys = [-sd / 2, sd / 2, c.start?.y ?? 0];
  for (const g of c.gates) { xs.push(g.x); ys.push(g.y); }
  const x0 = Math.min(...xs) - 4, x1 = Math.max(...xs) + 4, y0 = Math.min(...ys) - 4, y1 = Math.max(...ys) + 4;
  const W = 100, sc = W / (x1 - x0), H = +((y1 - y0) * sc).toFixed(2);
  const P = (x, y) => [((x - x0) * sc).toFixed(2), ((y1 - y) * sc).toFixed(2)];
  const f2 = v => Number(v).toFixed(2);
  let s = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${String(title || c.name || '').replace(/"/g, '')}" preserveAspectRatio="xMidYMid meet">`;
  s += `<rect x="0" y="0" width="${W}" height="${H}" rx="2.5" fill="${hex(GROUND_COLORS[env.ground] ?? 0x555555)}"/>`;
  const prim = (e, op) => {
    const col = hex(matColor(e.mat));
    if (e.t === 'box') {
      const f = fwdOf(e.yaw || 0), r = rightOf(e.yaw || 0), hw = e.w / 2, hd = e.d / 2;
      const pts = [[-hw, -hd], [hw, -hd], [hw, hd], [-hw, hd]].map(([a, b]) => P(e.x + r[0] * a + f[0] * b, e.y + r[1] * a + f[1] * b).join(',')).join(' ');
      return `<polygon points="${pts}" fill="${col}" fill-opacity="${op}"/>`;
    }
    if (e.t === 'cyl' || e.t === 'sph') { const [x, y] = P(e.x, e.y); return `<circle cx="${x}" cy="${y}" r="${f2(Math.max(0.35, e.r * sc))}" fill="${col}" fill-opacity="${op}"/>`; }
    if (e.t === 'pipe') { const [ax, ay] = P(e.a[0], e.a[1]), [bx, by] = P(e.b[0], e.b[1]); return `<line x1="${ax}" y1="${ay}" x2="${bx}" y2="${by}" stroke="${col}" stroke-opacity="${op}" stroke-width="${f2(Math.max(0.35, e.r * 2 * sc))}" stroke-linecap="round"/>`; }
    return '';
  };
  // gölge sırası: dekor (soluk) → engeller (yükseklik sırasıyla: alçak önce)
  if (decor) for (const e of c.decor || []) if (e.vis !== false && e.mat !== 'water') s += prim(e, 0.35);
  const obs = (c.obstacles || []).filter(e => e.vis !== false).sort((a, b) => (a.z + (a.h || a.r || 0)) - (b.z + (b.h || b.r || 0)));
  for (const e of obs) s += prim(e, e.part === 'crown' ? 0.85 : 0.95);
  // yarış hattı
  for (const seg of c.line || []) s += `<polyline points="${seg.map(p => P(p[0], p[1]).join(',')).join(' ')}" fill="none" stroke="#fde047" stroke-width=".55" stroke-dasharray="1.6 1" stroke-opacity=".9"/>`;
  // başlangıç pedi
  if (c.start) for (const sl of startSlots(c, Math.max(1, c.start.cols || 4))) { const [x, y] = P(sl.x, sl.y); s += `<circle cx="${x}" cy="${y}" r="${f2(Math.max(0.9, 0.9 * sc))}" fill="none" stroke="#39ff6e" stroke-width=".55"/>`; }
  // kapılar
  c.gates.forEach((g, i) => {
    const col = i === 0 ? '#39ff6e' : highlight === i ? '#ff2bd6' : g.kind === 'flag' || g.kind === 'slalom' ? '#f97316' : g.kind === 'dive' ? '#22d3ee' : '#f472b6';
    if (g.kind === 'flag' || g.kind === 'slalom') {
      const pp = g.pole || [g.x, g.y], [x, y] = P(pp[0], pp[1]);
      s += `<circle cx="${x}" cy="${y}" r="${f2(Math.max(0.9, 1.1 * sc))}" fill="${col}" stroke="#111" stroke-width=".25"/>`;
    } else {
      const o = gateOpening(g), half = (o.shape === 'circle' ? o.w : o.w / 2), r = rightOf(g.yaw);
      const [ax, ay] = P(g.x - r[0] * half, g.y - r[1] * half), [bx, by] = P(g.x + r[0] * half, g.y + r[1] * half);
      s += `<line x1="${ax}" y1="${ay}" x2="${bx}" y2="${by}" stroke="#111" stroke-width="1.9" stroke-linecap="round"/><line x1="${ax}" y1="${ay}" x2="${bx}" y2="${by}" stroke="${col}" stroke-width="1.2" stroke-linecap="round"/>`;
      const f = fwdOf(g.yaw), [tx, ty] = P(g.x + f[0] * 2.2 / Math.max(0.6, sc), g.y + f[1] * 2.2 / Math.max(0.6, sc)), [cx, cy] = P(g.x, g.y);
      s += `<line x1="${cx}" y1="${cy}" x2="${tx}" y2="${ty}" stroke="${col}" stroke-width=".45"/>`;
    }
    if (labels) { const [x, y] = P(g.x, g.y); s += `<text x="${x}" y="${f2(Number(y) - 1.6)}" font-size="2.6" font-weight="800" text-anchor="middle" fill="#fff" stroke="#000" stroke-width=".35" paint-order="stroke">${i === 0 ? 'S/F' : i}</text>`; }
  });
  return `${s}</svg>`;
}

// ---------------------------------------------------------------- çubuk konumu (mod-2: sol gaz/sapma, sağ yunuslama/yatış)
const ax = v => { const x = clamp((Number(v) - 1500) / 500, -1, 1); return Math.abs(x) < 0.02 ? 0 : x; };
/** Kaynak: RC kanal dizisi (PWM; ch1 yatış, ch2 yunuslama (düşük = ileri), ch3 gaz, ch4 sapma) ya da {thr 0…1, yaw, pitch (+ ileri/yukarı), roll} −1…1.
 *  Dönüş {left:{x: sapma, y: gaz −1…1}, right:{x: yatış, y: yunuslama}, src} (y + = çubuk yukarı) ya da null. */
export function stickPositions(src) {
  if (Array.isArray(src) && src.length >= 4 && src.slice(0, 4).every(v => Number(v) >= 800 && Number(v) <= 2200)) {
    const thr = clamp((Number(src[2]) - 1000) / 1000, 0, 1);
    return { left: { x: ax(src[3]), y: thr * 2 - 1 }, right: { x: ax(src[0]), y: -ax(src[1]) || 0 }, src: 'rc' };
  }
  if (src && typeof src === 'object' && !Array.isArray(src) && ['thr', 'yaw', 'pitch', 'roll'].some(k => src[k] != null)) {
    const thr = clamp(num(src.thr, 0), 0, 1);
    return { left: { x: clamp(num(src.yaw, 0), -1, 1), y: thr * 2 - 1 }, right: { x: clamp(num(src.roll, 0), -1, 1), y: clamp(num(src.pitch, 0), -1, 1) }, src: 'axes' };
  }
  return null;
}
export const STICKS_KEY = 'fs.fpv.sticks';
/** Çubuk göstergesi tercihi (varsayılan açık). */
export function sticksPref(storage = null, key = STICKS_KEY) {
  const st = storage || (typeof localStorage !== 'undefined' ? localStorage : null);
  return { get: () => { try { return st?.getItem(key) !== '0'; } catch { return true; } }, set: v => { try { st?.setItem(key, v ? '1' : '0'); } catch { /* */ } return !!v; } };
}
export const GHOST_KEY = 'fs.fpv.ghost';
/** Hayalet tercihi 'pb' (kişisel rekor; varsayılan) | 'off'. */
export function ghostPref(storage = null, key = GHOST_KEY) {
  const st = storage || (typeof localStorage !== 'undefined' ? localStorage : null);
  return { get: () => { try { return st?.getItem(key) === 'off' ? 'off' : 'pb'; } catch { return 'pb'; } }, set: v => { const x = v === 'off' ? 'off' : 'pb'; try { st?.setItem(key, x); } catch { /* */ } return x; } };
}

// ---------------------------------------------------------------- ortam / atmosfer (3B katmanı uygular; kalite kademesine göre)
const LV = { low: 0, medium: 1, high: 2, ultra: 3 };
export const levelIndex = l => LV[l] ?? 2;
/** env (parkur.env) + kalite → {fog: {color, near, far} | null, hemi: {sky, ground, k}, sun: {color, k, el, az} | null, lamps: n, lampColor, flood: n, floodShadow,
 *  shadows (bool), decorK (dekor oranı 0…1), indoor, mist (parçacık sayısı), groundTex (doku çözünürlüğü)}. */
export function envAtmosphere(env = {}, level = 'high') {
  const q = levelIndex(level), sky = env.sky || 'clear', size = Math.max(...(env.size || [100, 100]));
  const fogK = [0.75, 0.9, 1, 1.15][q];
  const out = { indoor: sky === 'indoor', fog: null, hemi: null, sun: null, lamps: 0, lampColor: 0xffc98a, flood: 0, floodShadow: false, shadows: q >= 1,
    decorK: [0.45, 0.75, 1, 1][q], mist: [0, 40, 90, 160][q], groundTex: [256, 512, 1024, 1024][q], waterfall: !!env.canyon, glow: q >= 1 };
  const fog = (color, near, far) => ({ color, near: Math.round(near), far: Math.round(far * fogK) });
  switch (sky) {
    case 'indoor':   // kapalı hangar: sıcak tavan lambaları, yakın sıcak sis (toz), güneş yok sayılmaz (açık kapı) ama hemi düşük
      out.fog = fog(0x6a563f, 26, 170); out.hemi = { sky: 0xffe2b8, ground: 0x6b5643, k: 1.1 }; out.amb = { color: 0xffd8a8, k: 0.55 }; out.lamps = [4, 6, 8, 10][q]; out.mist = [0, 60, 120, 200][q]; break;
    case 'misty':    // tepedeki ahşap ev: altın saat + sis + sıcak gün batımı
      out.fog = fog(0xd8b089, 12, 150); out.hemi = { sky: 0xffd6a0, ground: 0x8a7a48, k: 1.0 }; out.amb = { color: 0xffd2a0, k: 0.35 }; out.sun = { color: 0xffb46a, k: 1.6, el: 9, az: 250 }; break;
    case 'night_stadium':   // gece stadyumu: projektörler
      out.fog = fog(0x0b1220, 70, 320); out.hemi = { sky: 0x2a3a5c, ground: 0x18301a, k: 0.7 }; out.flood = [2, 4, 4, 4][q]; out.floodShadow = q >= 3; break;
    case 'hazy':     // yarı yıkık şehir: pus, akşam
      out.fog = fog(0xb59c84, 30, 260); out.hemi = { sky: 0xffd9b0, ground: 0x7a6a58, k: 0.95 }; out.amb = { color: 0xffe0c0, k: 0.25 }; out.sun = { color: 0xffa860, k: 0.9, el: 12, az: 245 }; break;
    case 'overcast': // çam ormanı: kapalı hava, yeşilimsi sis
      out.fog = fog(0x9aa69a, 24, 200); out.hemi = { sky: 0xe6eee8, ground: 0x5a6a44, k: 1.0 }; out.amb = { color: 0xdfe8df, k: 0.3 }; break;
    default:         // açık: rafineri / kanyon / inşaat
      out.fog = fog(env.canyon ? 0xa9bccd : 0xc9d3dc, Math.max(60, size * 0.6), Math.max(380, size * 3.2));
      out.hemi = { sky: 0xdfe9f5, ground: 0x7a6a55, k: 0.6 };
      if (env.light === 'sun_low') out.sun = { color: 0xffcf96, k: 0.8, el: 22, az: 120 };
  }
  if (q === 0) { out.fog.near *= 1.2; out.fog.far *= 1.15; }
  return out;
}

// ---------------------------------------------------------------- sonuç / puan
/** Kişisel rekora göre fark (sn; − = daha hızlı). */
export const pbDelta = (time, prev) => (time == null || prev == null ? null : Math.round((Number(time) - Number(prev)) * 1000) / 1000);
/** Parkur puanı (sunucu fpv_puani): 250 × par / tur ortalaması, en çok 375; bitirilmemiş 0. */
export function fpvPoints(course, totalS, laps) {
  if (totalS == null || !laps || !course?.par_lap_s) return 0;
  const ort = Number(totalS) / Number(laps);
  return Math.trunc(Math.max(0, Math.min(375, Math.round(250 * Number(course.par_lap_s) / Math.max(1, ort)))));
}
/** Skor tablosundaki yer: (time_s'e göre sıralı satırlar, benim kimliğim) → {rank, n} | null. */
export function leaderboardPlace(rows, uid) {
  const i = (rows || []).findIndex(r => r.user_id === uid);
  return i < 0 ? null : { rank: rows[i].rank ?? i + 1, n: rows.length };
}
/** Sonuç satırının FPV özeti (players[].fpv / standings[].fpv). */
export function fpvRow(r) {
  const f = r?.fpv || {};
  return { total: r?.time_s ?? f.total_s ?? null, laps: f.lap_times || [], best: f.best_lap_s ?? null, sectors: f.sectors || [], misses: f.misses ?? 0, hits: f.hits ?? r?.crashes ?? 0,
    pen: r?.pen_s ?? f.pen_s ?? 0, lapsDone: f.laps_done ?? (f.lap_times || []).length, lapsTotal: f.laps ?? null, newPb: !!r?.new_pb, pbPrev: r?.pb_prev ?? null };
}
