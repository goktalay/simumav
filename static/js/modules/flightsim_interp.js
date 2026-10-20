// Uçuş Simülatörü — telemetri zaman çizgisi: uyarlanır gecikme tamponlu enterpolasyon (docs/ucus-simulatoru.md §5). three.js'ten
// bağımsız modül (T = Vector3/Quaternion/Euler sağlayan nesne) → tarayıcısız Node testinde de çalışır (tests/test_flightsim_interp.mjs).
//
// Zaman ekseni KAYNAK zamanıdır (tbm = SITL time_boot_ms; yoksa ts / alım zamanı): oynatma başı `play` (kaynak ms) her render karesinde
// geçen gerçek süre × hız oranı kadar ilerler; hedefi "son alınan kare − hedef gecikme"dir ve ona yalnız hız oranıyla (±%6, hatanın
// EMA'sı; 30 ms hatada %6, en çok %30) yaklaşır → saat ofseti kestirimi yok; ağ jitter'ı ileri-geri sıçrama üretmez (|hata| > 1 s → yeniden senkron). Kaynak saat / gerçek
// zaman ORANI (1 s pencereler, EMA) oynatma hızının tabanıdır: SITL yük altında yavaşlar ya da yetişmek için hızlanır (0,5…2× ölçüldü).
// Hedef gecikme UYARLANIR: 60 ms + 3 × jitter (EMA), en az 2 kaynak kare aralığı ve 1,5 render karesi; 60…300 ms; saniyede ±10 ms.
// Konum (tbm_pos: GLOBAL_POSITION_INT zamanı) ve yönelim (tbm: ATTITUDE zamanı) AYRI zaman çizgilerinde tamponlanır ve bağımsız enterpole
// edilir (sunucu karesi iki mesajı farklı damgalarla birleştirir; tek çizgide konum ±20 ms ileri-geri giderdi). Kareler kaynak zamanına
// göre SIRALI eklenir (sırası bozulan kare yerine oturur, aynı damga yerine yazar). Tampon biterse ölü hesap (hız + gövde açısal hızları,
// en çok DR_MAX); ölü hesaptan gerçek kareye dönüşte (ve her büyük sıçramada) fark BLEND_MS içinde yumuşak kapanır (konum lineer,
// yönelim slerp) — "atlama" yok; teleport (> SNAP_M / SNAP_DEG) doğrudan atlanır. Kare hızından bağımsız (rAF gerçek süresi, kırpılmamış).
// Ağ istatistiği: alım hızı (Hz), jitter (|alım aralığı − kaynak aralığı| ortalaması), hedef gecikme, DR giriş sayısı. Hareket istatistiği
// (motionStats: ardışık render kareleri arası yönelim farkı °, pürüzsüzlük "jerk") titreme teşhisi/ölçümü içindir.
//
// Dışa: createTimeline(T, { toLocal }) → { push(t, nowMs), advance(rawMs), cur {pos, q, vel}, get has, get src, netStats(), motionStats(reset) },
//       attitudeQuat(T, roll, pitch, yaw, out), sabitler.

export const DELAY_BASE = 60, DELAY_MIN = 60, DELAY_MAX = 300, DELAY_RATE = 10, DR_MAX = 300, BUF_MAX = 128, BLEND_MS = 130, SNAP_M = 60, SNAP_DEG = 100;
const DEG = Math.PI / 180;
const num = (v, d) => (v == null || v === '' || Number.isNaN(Number(v)) ? d : Number(v));
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

// ArduPilot roll/pitch/yaw (rad, NED) → ENU gövde quaternionu. Gövde: burun +Y, sağ kanat +X, üst +Z.
// yaw 0 = kuzey (+Y), doğu = +X; saat yönü yaw → +Z etrafında negatif dönüş. Sıra: yaw → pitch (gövde X) → roll (gövde Y).
export function attitudeQuat(T, roll, pitch, yaw, out) {
  const e = new T.Euler(pitch || 0, roll || 0, -(yaw || 0), 'ZXY');
  return (out || new T.Quaternion()).setFromEuler(e);
}

export function createTimeline(T, opts = {}) {
  const toLocal = opts.toLocal || null;
  const posBuf = [], attBuf = [];                   // {src, pos, vel} · {src, q, rx, ry, rz}
  const st = { has: false, src: 0, srcPos: 0 };
  const net = { n: 0, jit: 0, hz: 0, jitter: 0, win: 0, lastArr: 0, lastSrc: 0, dr: false, jitEma: 0, delay: DELAY_BASE, play: 0, rate: 1, err: 0,
    srcInt: 20, frameInt: 16, drEnters: 0, blendT: -1, snaps: 0, t0: 0, clock: 1, winSrc: 0 };   // clock: kaynak saati / gerçek zaman oranı (1 s pencereler, EMA)
  const cur = { pos: new T.Vector3(0, 0, 0.6), q: new T.Quaternion(), vel: new T.Vector3() };
  const interp = { pos: new T.Vector3(), q: new T.Quaternion() };          // tamponun verdiği ham örnek (yumuşatma öncesi)
  const corr = { pos: new T.Vector3(), q: new T.Quaternion() };            // DR → gerçek kare geçiş farkı; BLEND_MS içinde sıfıra iner
  const mot = { n: 0, ang: 0, angMax: 0, jerk: 0, lastAng: -1, pos: 0, posMax: 0, posJerk: 0, lastPos: -1, drEnters: 0, drFrames: 0, t0: 0, qPrev: new T.Quaternion(), pPrev: new T.Vector3(), has: false, hist: [] };
  const tmpQa = new T.Quaternion(), tmpAx = new T.Vector3(), tmpQb = new T.Quaternion(), tmpQi = new T.Quaternion();

  function pushSorted(arr, fr) {   // kaynak zamanına göre sıralı ekleme; aynı damga → yerine
    let i = arr.length;
    while (i > 0 && arr[i - 1].src > fr.src) i--;
    if (i > 0 && arr[i - 1].src === fr.src) { arr[i - 1] = fr; return; }
    arr.splice(i, 0, fr);
    if (arr.length > BUF_MAX) arr.splice(0, arr.length - BUF_MAX);
  }
  function resetTimeline(src) {   // ilk kare ya da kaynak saati geri gitti (SITL yeniden başladı)
    posBuf.length = 0; attBuf.length = 0;
    net.play = src - net.delay; net.rate = 1; net.err = 0; net.blendT = -1; net.dr = false;
    st.src = src; st.srcPos = 0;
  }
  // `tele` karesi → tampon. now: istemci saati (ms, performance.now). Dönüş: { first } (ilk kare: kamera yayı oturtulur)
  function push(t, now) {
    const p = toLocal && t.lat != null && t.lon != null ? toLocal(t.lat, t.lon) : { x: num(t.x, 0), y: num(t.y, 0) };
    // Kaynak saati: tbm (SITL time_boot_ms; TCP parçalanmasından bağımsız, kesin) > ts (sunucu alım zamanı, sn ya da ms) > alım zamanı
    let src = num(t.tbm, NaN);
    if (Number.isNaN(src) || src < 0) { src = num(t.ts, NaN); if (Number.isNaN(src)) src = now; else if (src < 1e11) src *= 1000; }   // tbm 0 geçerlidir (yeni SITL)
    let srcPos = num(t.tbm_pos, NaN);   // konum damgası (sunucu: GLOBAL_POSITION_INT time_boot_ms); eski sunucu → kare damgası
    if (Number.isNaN(srcPos) || srcPos < 0) srcPos = src;
    const first = !st.has;
    if (first || src < st.src - 1000) { resetTimeline(src); if (!first) net.snaps++; }
    // §25 tailsitter (INTERCEPTOR): ATTITUDE Q kiplerinde "VTOL görünümü"dür; gövde SITL'in gerçek yönelimiyle (`att_body` = SIMSTATE) çizilir
    const ab = Array.isArray(t.att_body) && t.att_body.length === 3 ? t.att_body : null;
    const fa = { src, q: ab ? attitudeQuat(T, num(ab[0], 0), num(ab[1], 0), num(ab[2], 0)) : attitudeQuat(T, num(t.roll, 0), num(t.pitch, 0), num(t.yaw, 0)), rx: num(t.ps, 0), ry: num(t.rs, 0), rz: -num(t.ys, 0) };   // gövde: X sağ, Y burun, Z üst
    if (first || src !== st.src) pushSorted(attBuf, fa);
    const fp = { src: srcPos, pos: new T.Vector3(p.x, p.y, num(t.alt_rel, 0)), vel: new T.Vector3(num(t.ve, 0), num(t.vn, 0), -num(t.vd, 0)) };
    if (first || srcPos !== st.srcPos) pushSorted(posBuf, fp);
    // ağ istatistiği: 1 sn pencere (Hz, ortalama jitter) + jitter EMA (hedef gecikme için) + kaynak kare aralığı
    if (!first) net.n++;   // alım hızı: sırası bozuk kareler de sayılır
    if (!first && src > st.src) {
      const j = Math.abs((now - net.lastArr) * net.clock - (src - net.lastSrc));   // gerçek ms → kaynak ms (saat oranı)
      net.jit += j;
      net.jitEma += (Math.min(j, 400) - net.jitEma) * 0.05;
      net.srcInt += (Math.min(src - net.lastSrc, 500) - net.srcInt) * 0.05;
    }
    if (first || src >= st.src) { net.lastArr = now; net.lastSrc = src; }
    if (!net.win) { net.win = now; net.winSrc = src; }
    else if (now - net.win >= 1000) {
      net.hz = Math.round(net.n * 1000 / (now - net.win)); net.jitter = net.n ? Math.round(net.jit / net.n) : 0;
      // Kaynak saat oranı: SITL yük altında yavaşlar / yetişmek için hızlanır (gerçek SITL'de 0,5…2× görüldü); oynatma hızının tabanı bu orandır.
      const o = (Math.max(st.src, src) - net.winSrc) / (now - net.win);
      if (o > 0.05 && o < 5) { net.clock += (o - net.clock) * (net.winN < 3 ? 0.7 : 0.3); net.winN = (net.winN || 0) + 1; }   // ilk pencerelerde hızlı otur
      net.n = 0; net.jit = 0; net.win = now; net.winSrc = Math.max(st.src, src);
    }
    st.src = Math.max(st.src, src); st.srcPos = Math.max(st.srcPos, srcPos);
    if (first) { st.has = true; net.t0 = now; cur.pos.copy(fp.pos); cur.q.copy(fa.q); cur.vel.copy(fp.vel); }
    return { first, speed: fp.vel.length() };
  }
  const netStats = () => ({ hz: net.hz, jitter: Math.round(net.jitter / net.clock), delay: Math.round(net.delay / net.clock), buffered: attBuf.length, deadReckoning: net.dr, rate: net.rate, clock: net.clock,
    drEnters: net.drEnters, drPerMin: net.t0 ? net.drEnters * 60000 / Math.max(1, (net.nowAt || net.t0) - net.t0) : 0, snaps: net.snaps, play: net.play });
  // Hareket istatistiği (titreme teşhisi): ardışık render kareleri arası yönelim farkı (derece) ve konum farkı (m); "jerk" = ardışık
  // farkların farkı (sabit açısal hızda 0 → pürüzsüz). motionStats(reset) → { frames, angMean, angMax, angJerk, posMean, posMax, posJerk, drEnters, drFrames, secs }
  function motionStats(reset) {
    const now = net.nowAt || 0;
    const out = { frames: mot.n, angMean: mot.n ? mot.ang / mot.n : 0, angMax: mot.angMax, angJerk: mot.n > 1 ? mot.jerk / (mot.n - 1) : 0,
      posMean: mot.n ? mot.pos / mot.n : 0, posMax: mot.posMax, posJerk: mot.n > 1 ? mot.posJerk / (mot.n - 1) : 0, drEnters: mot.drEnters, drFrames: mot.drFrames,
      secs: mot.t0 ? (now - mot.t0) / 1000 : 0, delay: Math.round(net.delay / net.clock), jitter: Math.round(net.jitter / net.clock), hz: net.hz, hist: mot.hist.slice() };
    if (reset) { mot.n = 0; mot.ang = 0; mot.angMax = 0; mot.jerk = 0; mot.lastAng = -1; mot.pos = 0; mot.posMax = 0; mot.posJerk = 0; mot.lastPos = -1; mot.drEnters = 0; mot.drFrames = 0; mot.t0 = now; mot.hist.length = 0; }
    return out;
  }
  function motionSample() {
    if (!mot.t0) mot.t0 = net.nowAt;
    if (mot.has) {
      const ang = 2 * Math.acos(clamp(Math.abs(mot.qPrev.dot(cur.q)), 0, 1)) / DEG, d = mot.pPrev.distanceTo(cur.pos);
      mot.n++; mot.ang += ang; mot.angMax = Math.max(mot.angMax, ang); mot.pos += d; mot.posMax = Math.max(mot.posMax, d);
      if (mot.lastAng >= 0) { mot.jerk += Math.abs(ang - mot.lastAng); mot.posJerk += Math.abs(d - mot.lastPos); }
      mot.lastAng = ang; mot.lastPos = d;
      if (mot.hist.length < 4000) mot.hist.push(Math.round(ang * 1000) / 1000);
      if (net.dr) mot.drFrames++;
    }
    mot.qPrev.copy(cur.q); mot.pPrev.copy(cur.pos); mot.has = true;
  }
  // Oynatma başını ilerlet ve kaynak zamanı `net.play` için konum/yönelim örneği → cur (rawMs: kareler arası gerçek süre, ms)
  function advance(rawMs) {
    net.nowAt = (net.nowAt || net.t0) + rawMs;
    if (!attBuf.length && !posBuf.length) return;
    const lastSrc = st.src;
    net.frameInt += (Math.min(rawMs, 500) - net.frameInt) * 0.1;   // render kare aralığı (EMA): düşük kare hızında tampon en az 1,5 kare olsun
    // hedef gecikme (kaynak ms): 60 + 3·jitter (EMA), en az 2 kaynak kare aralığı ve 1,5 render karesi; 60…300 (gerçek) ms; saniyede ±DELAY_RATE ms
    const c = net.clock;
    const want = clamp(Math.max(DELAY_BASE * c + 3 * net.jitEma, 2 * net.srcInt, 1.5 * net.frameInt * c), DELAY_MIN * c, DELAY_MAX * c);
    const step = DELAY_RATE * c * rawMs / 1000;
    net.delay += clamp(want - net.delay, -step, step);
    // oynatma başı: gerçek süre × kaynak saat oranı × düzeltme; hata = (son kare − gecikme) − play, EMA ile yumuşatılır → düzeltme ±%6
    const target = lastSrc - net.delay;
    const err = target - net.play;
    if (Math.abs(err) > 1000) { net.play = target; net.err = 0; net.rate = 1; net.snaps++; net.blendT = -1; }
    else {
      net.err += (err - net.err) * Math.min(1, rawMs / 400);
      net.rate = 1 + clamp(net.err / 500, -0.3, 0.3);   // 30 ms hatada ±%6; büyük hata (saat oranı henüz oturmadı) orantılı daha hızlı, yine sürekli
      net.play += rawMs * net.clock * net.rate;
    }
    const play = net.play;
    let dr = false;
    // yönelim (ATTITUDE zaman çizgisi)
    const na = attBuf.length;
    if (na) {
      const last = attBuf[na - 1];
      if (play >= last.src) {
        const dt = Math.min(DR_MAX, play - last.src) / 1000;
        dr = play - last.src > 2 * net.srcInt;   // bir kare gecikmesi doğal; iki kareden fazlası ölü hesap sayılır
        tmpAx.set(last.rx * dt, last.ry * dt, last.rz * dt);
        const ang = tmpAx.length();
        interp.q.copy(last.q);
        if (ang > 1e-6) { tmpQa.setFromAxisAngle(tmpAx.multiplyScalar(1 / ang), ang); interp.q.multiply(tmpQa); }
        if (na > 1) attBuf.splice(0, na - 1);
      } else {
        let i = na - 1;
        while (i > 0 && attBuf[i - 1].src > play) i--;
        if (i === 0) interp.q.copy(attBuf[0].q);
        else { const a = attBuf[i - 1], b = attBuf[i], span = b.src - a.src; interp.q.slerpQuaternions(a.q, b.q, span > 0 ? clamp((play - a.src) / span, 0, 1) : 1); if (i > 1) attBuf.splice(0, i - 1); }
      }
    }
    // konum (GLOBAL_POSITION_INT zaman çizgisi)
    const np = posBuf.length;
    if (np) {
      const last = posBuf[np - 1];
      if (play >= last.src) {
        const dt = Math.min(DR_MAX, play - last.src) / 1000;
        dr = dr || play - last.src > 2 * net.srcInt;
        interp.pos.copy(last.pos).addScaledVector(last.vel, dt);
        cur.vel.copy(last.vel);
        if (np > 1) posBuf.splice(0, np - 1);
      } else {
        let i = np - 1;
        while (i > 0 && posBuf[i - 1].src > play) i--;
        if (i === 0) { interp.pos.copy(posBuf[0].pos); cur.vel.copy(posBuf[0].vel); }
        else { const a = posBuf[i - 1], b = posBuf[i], span = b.src - a.src, f = span > 0 ? clamp((play - a.src) / span, 0, 1) : 1; interp.pos.lerpVectors(a.pos, b.pos, f); cur.vel.lerpVectors(a.vel, b.vel, f); if (i > 1) posBuf.splice(0, i - 1); }
      }
    }
    if (dr && !net.dr) { net.drEnters++; mot.drEnters++; }
    // Yumuşak yakınsama: ölü hesaptan gerçek kareye dönüşte (ve her sıçramada) önceki render ile yeni örnek arasındaki fark `corr`
    // olarak tutulur ve BLEND_MS içinde sıfıra iner (konum lineer, yönelim slerp). Çok büyük fark (teleport: Sıfırla / saat sıfırlama) → doğrudan atla.
    const jumpPos = cur.pos.distanceTo(interp.pos), jumpAng = 2 * Math.acos(clamp(Math.abs(cur.q.dot(interp.q)), 0, 1)) / DEG;
    const expectPos = cur.vel.length() * rawMs / 1000 + 0.35;   // bir karede beklenen yol + pay (m)
    if (jumpPos > SNAP_M || jumpAng > SNAP_DEG) { net.blendT = -1; net.snaps++; }
    else if ((net.dr && !dr) || jumpPos > 2 * expectPos + 0.5 || jumpAng > 6) {
      corr.pos.copy(cur.pos).sub(interp.pos);
      corr.q.copy(cur.q).multiply(tmpQi.copy(interp.q).invert());   // cur = corr ⊗ interp
      net.blendT = BLEND_MS;
    }
    net.dr = dr;
    if (net.blendT > 0) {
      net.blendT = Math.max(0, net.blendT - rawMs);
      const f = net.blendT / BLEND_MS;
      cur.pos.copy(interp.pos).addScaledVector(corr.pos, f);
      tmpQb.identity().slerp(corr.q, f);
      cur.q.copy(tmpQb).multiply(interp.q);
    } else { cur.pos.copy(interp.pos); cur.q.copy(interp.q); }
    motionSample();
  }
  return { push, advance, cur, netStats, motionStats, get has() { return st.has; }, get src() { return st.src; }, get dr() { return net.dr; }, get play() { return net.play; } };   // play: oynatma başı (kaynak ms) — §24 hedef zamanı
}
