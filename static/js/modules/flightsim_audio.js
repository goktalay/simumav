// Uçuş Simülatörü — motor sesi (docs/ucus-simulatoru.md §16). Web Audio API ile TAMAMEN SENTEZLENMİŞ sesler; dış ses dosyası yok.
// • Katman 1 (saf, tarayıcısız test edilir — tests/test_flightsim_audio.mjs): tip → ses modeli (`AUDIO_MODELS`), telemetri → hedef
//   parametreler (`engineTargets`), devir yumuşatma (`smoothFollow`: gaz 0,3–0,8 sn gecikmeli takip), mesafe kazancı (`distanceGain`, 1/r,
//   15 m referans), FPV kokpit süzgeci (`fpvParams`), tercih/durum makinesi (`createAudioPrefs`: localStorage `fs.audio.on`, `fs.audio.vol`).
// • Katman 2 (`createEngineAudio(stage, opts)`): tek AudioContext, osilatör/gürültü düğümleri BİR KEZ kurulur, her güncelleme yalnız
//   AudioParam.setTargetAtTime (≤ 25 Hz) → CPU < %2. Uzaysal: PannerNode (equalpower, inverse 1/r) dinleyici = 3B kamera (`sim.cameraPose()`),
//   kaynak = dron (`sim.position()`); gimbal kamerasında ('fpv') kaynak dinleyicide (kokpit), lowpass boğukluk + hızla artan rüzgâr; GERÇEK FPV'de ('pilot', §22)
//   motor daha yakın/yüksek (×1,3, süzgeç açık) + hıza bağlı güçlü filtreli rüzgâr gürültüsü. Doppler: radyal hıza göre
//   küçük frekans çarpanı (±%5 sınır). Çarpışma (crash bandı görünür): kısa çarpma + motor durması; "Sıfırla" ile yeniden.
// Ses modelleri (tip = SITL TIP_ESLEME anahtarı):
//   multirotor/hexarotor  4/6 pervane: her motor ayrı testere dalga (hafif farklı oran → "vızıltı" vuruşu), 2× kare (ESC/elektrik), bant geçiren
//                         pervane uğultusu. Pala geçiş frekansı 150 Hz (gaz 0) → 600 Hz (gaz 100). Armed + gaz 0 = belirgin rölanti vızıltısı
//                         (MOT_SPIN_ARM öykünmesi); disarm = sessiz.
//   helikopter            ana rotor "wop-wop": 20–30 Hz LFO ile genlik modülasyonlu alçak gürültü + rotor harmoniği; türbin ıslığı (900–1500 Hz);
//                         kuyruk rotoru (BPF × 5,5). Armed → rotor %70 devir, gaz ile %100.
//   sabit_kanat (delta/caymaz aynı)  benzinli tek silindirli iki zamanlı: devir 1500 (rölanti) → 7500 (tam gaz); ateşleme f = devir/60 × silindir;
//                         testere (ana) + kare (alt harmonik) + egzoz gürültüsü (lowpass gazla açılır) + pervane (2 pala sinüs). Armed + gaz 0 = rölanti.
//   vtol                  kopter + uçak; karışım hava hızına göre (5 → 20 m/s arasında kopterden uçağa).
//   rover (§31)           elektrikli kara aracı: motor/inverter uğultusu (üçgen + 2,97× dişli ıslığı; frekans yer hızıyla 90 → 850 Hz), armed + duruşta
//                         alçak inverter vızıltısı (100 Hz kare, kısık), lastik / zemin gürültüsü (lowpass, hızla açılır ve yükselir). Pervane yok.
//   Kalkış yöntemi: rampa (launch) → pnömatik "pşşt" (bant geçiren gürültü patlaması) + released → kızak çarpması (80 Hz vuruş);
//                   araç (vehicle) → pickup motoru (V8 4 zamanlı, 800 → 4500 d/dk hızla), released → fren gürültüsü, rölantiye düşer, 3 sn'de susar.
//   ARM/DISARM geçişi (`spinStep`): ARM olunca motor HEMEN çalışır — devir 0 → rölanti rampası: kopter 0,6 sn (ESC başlatma), helikopter 3 sn (rotor
//                   sarmalı), sabit kanat 0,8 sn marş ("cranking": testere 90 Hz + gürültü) sonra rölanti; DISARM'da 1 sn'de sönme. Canlıda ve
//                   kayıtta aynı (replay kareleri `armed` taşır); Bitir/dispose → duruş.
// Kaynak: tele.throttle (%), armed, airspeed/groundspeed, rs/ps/ys (küçük modülasyon), batt_pct (düşük bataryada %4'e kadar devir düşüşü).
// Aç/kapa: alt çubukta 🔊/🔇 (M tuşu), ▾ ile ses düzeyi (0–100). Varsayılan AÇIK; tarayıcı kuralı gereği ilk kullanıcı etkileşiminde resume —
// o ana dek sessiz (düğmede turuncu nokta). Sekme gizlenince susar (visibilitychange), sayfadan çıkınca kapanır (dispose). Kayıt oynatma hızı ≥ 2× → susar.

export const AUDIO_PREF_ON = 'fs.audio.on', AUDIO_PREF_VOL = 'fs.audio.vol';
export const REF_DISTANCE = 15;      // m: bu mesafeye kadar tam ses, sonrası 1/r
export const TAU_UP = 0.35, TAU_DOWN = 0.7;   // sn: devir gazı yukarı/aşağı takip zaman sabitleri (motor ataleti; aşağı daha yavaş)
export const MUTE_SPEED = 2;         // kayıt oynatma hızı ≥ bu → sessiz
// ARM geçişi: motor başlatma süresi (sn; devir 0 → rölanti, doğrusal) ve DISARM sönme süresi (sn). Kopter ESC başlatma 0,6; heli rotor sarmalı 3;
// uçak marş 0,8 (bu sürede marş sesi duyulur); vtol kopter gibi.
export const SPIN_UP = { copter: 0.6, heli: 3.0, plane: 0.8, vtol: 0.6, rover: 0.4 }, SPIN_DOWN = 1.0;
// Çarpışma darbesi (§18 ek): çarpma hızına göre şiddet 0…1 (3 m/s → 0,25 · 40 m/s ≈ 1). Ayrı "darbe" yolu motor/master kazancından bağımsız,
// tercih edilen ses düzeyiyle × IMPACT_BOOST çalar (önceki tek lowpass gürültüden belirgin yüksek); kompresör tepe kırpmayı önler. Ses kapalıysa çalmaz.
export const IMPACT_BOOST = 2.2;
export function impactParams(speed) {
  const v = Math.max(0, Number(speed) || 0), i = Math.min(1, 0.25 + 0.75 * Math.min(1, v / 40));
  return { i, boom: 0.55 + 0.45 * i, boomHz: 58 - 18 * i, debris: 0.45 + 0.55 * i, crackle: 0.15 + 0.5 * i, decay: 0.7 + 1.1 * i, noise: 0.9 + 0.5 * i };
}
export const COPTER_IDLE = 0.3;      // armed + gaz 0 kopter bus kazancı (belirgin rölanti vızıltısı)
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const num = (v, d = 0) => (v == null || Number.isNaN(Number(v)) ? d : Number(v));

// ---------------------------------------------------------------- Katman 1: saf model ----------------------------------------------------------------
// Tip → ses modeli. Bilinmeyen tip → kopter (4). Kütüphane/dahili görsel model ses modelini değiştirmez (fizik tipe bağlı).
export const AUDIO_MODELS = {
  multirotor: { kind: 'copter', motors: 4, blades: 2 },
  hexarotor: { kind: 'copter', motors: 6, blades: 2 },
  helikopter: { kind: 'heli', blades: 3 },
  sabit_kanat: { kind: 'plane', cylinders: 1, blades: 2, idleRpm: 1500, maxRpm: 7500 },
  vtol: { kind: 'vtol', motors: 4, blades: 2, cylinders: 1, idleRpm: 1500, maxRpm: 7500 },
  interceptor: { kind: 'copter', motors: 4, blades: 3 },   // §25 tailsitter: 4 elektrik motoru (askıda ve yatayda aynı motorlar)
  rover: { kind: 'rover', gear: 2.97 },                     // §31 elektrikli kara aracı: motor + redüktör ıslığı, lastik gürültüsü
};
export const audioModel = type => AUDIO_MODELS[type] || AUDIO_MODELS.multirotor;
// Motor oranları: her motor hafif farklı devir (üretim toleransı + kontrolcü düzeltmesi) → doğal "vuruş"; 4 ve 6 için farklı diziler
export const MOTOR_RATIOS = { 4: [1, 1.027, 0.981, 1.052], 6: [1, 1.019, 0.986, 1.041, 0.973, 1.031] };

// Kopter pala geçiş frekansı (Hz): gaz 0 → 150, gaz 100 → 600 (doğrusal); batarya düşükse (< %30) %4'e kadar düşer
export const copterBpf = (thr, battPct = 100) => (150 + 4.5 * clamp(thr, 0, 100)) * (1 - 0.04 * clamp((30 - num(battPct, 100)) / 30, 0, 1));
// Uçak devri (d/dk): rölanti → tam gaz doğrusal
export const planeRpm = (thr, m = AUDIO_MODELS.sabit_kanat) => m.idleRpm + (m.maxRpm - m.idleRpm) * clamp(thr, 0, 100) / 100;
export const firingHz = (rpm, cyl = 1) => rpm / 60 * cyl;          // iki zamanlı: her devirde ateşleme
// Helikopter ana rotor pala geçiş frekansı (Hz): rotor devri 400 (%70) → 450 d/dk (tam) × 3 pala → 20…22,5; gaz ile +%30'a kadar (sim. gerçekçilik için 20–30)
export const heliBpf = thr => 20 + 10 * clamp(thr, 0, 100) / 100;
// VTOL karışımı: 0 = kopter, 1 = uçak (hava hızı 5 → 20 m/s)
export const vtolMix = airspeed => clamp((num(airspeed) - 5) / 15, 0, 1);
// Araç (pickup) devri: hıza göre (800 rölanti, 4500 tavan)
export const vehicleRpm = speedMs => clamp(800 + 120 * Math.max(0, num(speedMs)), 800, 4500);
// §31 kara aracı: elektrik motoru uğultusu (Hz) yer hızıyla: 0 → 90, 20 m/s → 850 (25 m/s'de kırpılır); geri viteste de |hız|
export const roverMotorHz = speedMs => 90 + 38 * clamp(Math.abs(num(speedMs)), 0, 25);

// Telemetri → hedef ses parametreleri (yumuşatma öncesi). ctx: { launchMethod, launchPhase, vehicleSpeed } (yalnız sabit kanat canlı).
export function engineTargets(type, t, ctx = {}) {
  const m = audioModel(type);
  const armed = !!t?.armed, thr = clamp(num(t?.throttle), 0, 100), air = num(t?.airspeed), gnd = num(t?.groundspeed);
  const wob = clamp(Math.hypot(num(t?.rs), num(t?.ps), num(t?.ys)) / 2, 0, 1);   // gövde açısal hızı → küçük modülasyon (rad/s; 2 → tam)
  const out = { kind: m.kind, armed, thr, wobble: wob, wind: clamp(Math.max(air, gnd) / 40, 0, 1), copter: 0, plane: 0, heli: 0, mix: 0,
    bpf: 0, rpm: 0, fire: 0, heliBpf: 0, vehicle: 0, vehicleRpm: 0, rover: 0, roverHz: 0, tire: 0 };
  if (m.kind === 'copter' || m.kind === 'vtol') {
    out.bpf = copterBpf(thr, t?.batt_pct);
    out.copter = armed ? COPTER_IDLE + 0.5 * thr / 100 : 0;    // armed + gaz 0 = rölanti (belirgin); disarm = sessiz
  }
  if (m.kind === 'plane' || m.kind === 'vtol') {
    out.rpm = armed ? planeRpm(thr, m) : 0;
    out.fire = firingHz(out.rpm || m.idleRpm, m.cylinders);
    out.plane = armed ? 0.3 + 0.6 * thr / 100 : 0;        // armed + gaz 0 = rölanti
  }
  if (m.kind === 'vtol') { out.mix = vtolMix(air); out.copter *= (1 - out.mix * 0.85); out.plane *= (0.25 + 0.75 * out.mix); }
  if (m.kind === 'rover') {   // §31: uğultu hızla (motor devri tekerle bağlı), kazanç gaz + hız; lastik gürültüsü yalnız hızla (disarm yuvarlanırken de)
    const v = clamp(gnd / 20, 0, 1);
    out.roverHz = roverMotorHz(gnd);
    out.rover = armed ? 0.18 + 0.32 * Math.max(thr / 100, v) : 0;
    out.tire = 0.45 * v;
    out.wind = clamp(gnd / 40, 0, 1);
  }
  if (m.kind === 'heli') {
    out.heliBpf = heliBpf(thr);
    out.heli = armed ? 0.35 + 0.5 * thr / 100 : 0;
  }
  if (ctx.launchMethod === 'vehicle' && ctx.launchPhase && ctx.launchPhase !== 'idle') {
    const sp = ctx.launchPhase === 'launch' ? num(ctx.vehicleSpeed) : 0;
    out.vehicleRpm = vehicleRpm(sp);
    out.vehicle = ctx.launchPhase === 'armed' || ctx.launchPhase === 'launch' || ctx.launchPhase === 'released' ? 0.35 + 0.4 * clamp(sp / 25, 0, 1) : 0;
  }
  return out;
}

// Motor başlatma/durma durumu 0…1 (`spin`): armed → +dt/SPIN_UP[kind], disarm → −dt/SPIN_DOWN (doğrusal; kırpılır). Ses kazancı ve devir bununla çarpılır.
export const spinStep = (cur, armed, dt, kind = 'copter') => clamp(num(cur) + (armed ? Math.max(0, dt) / (SPIN_UP[kind] || SPIN_UP.copter) : -Math.max(0, dt) / SPIN_DOWN), 0, 1);
// Üstel yumuşatma (motor ataleti): yukarı tauUp, aşağı tauDown; dt sn
export const smoothFollow = (cur, target, dt, tauUp = TAU_UP, tauDown = TAU_DOWN) => {
  const tau = target > cur ? tauUp : tauDown;
  return cur + (target - cur) * (1 - Math.exp(-Math.max(0, dt) / tau));
};
// Mesafe kazancı: ref'e kadar 1, sonra ref/d (inverse, rolloff 1); PannerNode ile aynı eğri (HUD/test için)
export const distanceGain = (d, ref = REF_DISTANCE) => (d <= ref ? 1 : ref / d);
// Kamera kipine göre kokpit süzgeci: 'fpv' (gimbal kamerası) lowpass 900 Hz boğukluk + rüzgâr (40 m/s'de 0,5); 'pilot' (GERÇEK FPV, §22) motor daha
// yakın/yüksek (boost 1,3; süzgeç açık 20 kHz) + hıza bağlı daha güçlü rüzgâr gürültüsü (35 m/s'de 0,8, frekans hızla yükselir); diğer kipler boost 1, rüzgâr 0.
export const PILOT_BOOST = 1.3;
export const fpvParams = (airspeed, mode = 'fpv') => (mode === 'pilot'
  ? { lowpass: 20000, wind: clamp(num(airspeed) / 35, 0, 1) * 0.8, windFreq: 350 + 45 * clamp(num(airspeed), 0, 60), boost: PILOT_BOOST }
  : { lowpass: 900, wind: clamp(num(airspeed) / 40, 0, 1) * 0.5, windFreq: 500 + 35 * clamp(num(airspeed), 0, 60), boost: 1 });
// Doppler çarpanı: vr = radyal hız (m/s; + uzaklaşıyor) → f × (1 − 0,5·vr/343), ±%5 sınır (küçük, isteğe bağlı)
export const dopplerFactor = vr => clamp(1 - 0.5 * num(vr) / 343, 0.95, 1.05);

// Tercih/durum makinesi: enabled (localStorage fs.audio.on, varsayılan açık), volume (0–100, varsayılan 70), unlocked (ilk etkileşim),
// hidden (sekme gizli), speedMuted (oynatma ≥ 2×), crashed. effective() → gerçek çıkış kazancı 0…1.
export function createAudioPrefs(storage = null) {
  const st = storage || (typeof localStorage !== 'undefined' ? localStorage : null);
  const get = (k, d) => { try { const v = st?.getItem(k); return v == null ? d : v; } catch { return d; } };
  const set = (k, v) => { try { st?.setItem(k, String(v)); } catch { /* özel kip */ } };
  const S = { enabled: get(AUDIO_PREF_ON, '1') !== '0', volume: clamp(num(get(AUDIO_PREF_VOL, '70'), 70), 0, 100), unlocked: false, hidden: false, speedMuted: false, crashed: false };
  return {
    get enabled() { return S.enabled; }, get volume() { return S.volume; }, get unlocked() { return S.unlocked; },
    get hidden() { return S.hidden; }, get speedMuted() { return S.speedMuted; }, get crashed() { return S.crashed; },
    setEnabled(on) { S.enabled = !!on; set(AUDIO_PREF_ON, S.enabled ? '1' : '0'); return S.enabled; },
    toggle() { return this.setEnabled(!S.enabled); },
    setVolume(v) { S.volume = clamp(Math.round(num(v, 70)), 0, 100); set(AUDIO_PREF_VOL, S.volume); return S.volume; },
    setUnlocked(v) { S.unlocked = !!v; }, setHidden(v) { S.hidden = !!v; }, setCrashed(v) { S.crashed = !!v; },
    setPlaybackSpeed(sp) { S.speedMuted = num(sp, 1) >= MUTE_SPEED; return S.speedMuted; },
    get waiting() { return S.enabled && !S.unlocked; },   // düğme ipucu: etkileşim bekleniyor
    effective() { return S.enabled && S.unlocked && !S.hidden && !S.speedMuted ? (S.volume / 100) ** 1.6 : 0; },   // algısal eğri
  };
}

// ---------------------------------------------------------------- Katman 2: Web Audio grafiği ----------------------------------------------------------------
// opts: { type, launch ({method}) | null, replay, tr, getSim: () => sim | null, getCrashed: () => bool, getCrashSpeed: () => m/s (darbe şiddeti), getSpeed: () => oynatma hızı,
//         AudioContextClass (test: sahte), storage (test), now: () => ms, doc (test: null → DOM yok) }
export function createEngineAudio(stage, opts = {}) {
  const tr = opts.tr || (s => s);
  const type = opts.type || 'multirotor', model = audioModel(type);
  const launchMethod = opts.launch?.method || null;
  const prefs = createAudioPrefs(opts.storage);
  const AC = opts.AudioContextClass || (typeof AudioContext !== 'undefined' ? AudioContext : null);
  const doc = opts.doc === undefined ? (typeof document !== 'undefined' ? document : null) : opts.doc;
  const nowMs = opts.now || (() => (typeof performance !== 'undefined' ? performance.now() : Date.now()));
  const TC = 0.05;   // setTargetAtTime zaman sabiti (sn)
  let ctx = null, G = null, disposed = false, lastUpd = 0, lastPhase = null, lastCrash = false, prevDist = null;
  const sm = { thr: 0, rpm: 0, bpf: 150, vehRpm: 800, veh: 0, spin: 0 };   // yumuşatılan değerler; spin: motor başlatma/durma 0…1 (ARM rampası)
  const stats = { updates: 0, paramSets: 0, impacts: 0 };

  // --- yardımcılar: AudioParam hedefleme (sahte düğümlerde setTargetAtTime yoksa value) ---
  const P = (param, v, tc = TC) => {
    if (!param || !ctx) return;
    stats.paramSets++;
    if (typeof param.setTargetAtTime === 'function') param.setTargetAtTime(v, ctx.currentTime, tc); else param.value = v;
  };
  const noiseBuffer = () => {   // 2 sn beyaz gürültü, döngü
    const n = Math.floor(ctx.sampleRate * 2), b = ctx.createBuffer(1, n, ctx.sampleRate), d = b.getChannelData(0);
    let s = 12345;
    for (let i = 0; i < n; i++) { s = (s * 1664525 + 1013904223) >>> 0; d[i] = s / 2147483648 - 1; }
    return b;
  };
  const osc = (kind, f, dest, g = 0) => { const o = ctx.createOscillator(); o.type = kind; o.frequency.value = f; const gn = ctx.createGain(); gn.gain.value = g; o.connect(gn); gn.connect(dest); o.start(); return { o, g: gn }; };
  const noise = (filterType, f, q, dest, g = 0) => {
    const src = ctx.createBufferSource(); src.buffer = noiseBuffer(); src.loop = true;
    const fl = ctx.createBiquadFilter(); fl.type = filterType; fl.frequency.value = f; fl.Q.value = q;
    const gn = ctx.createGain(); gn.gain.value = g; src.connect(fl); fl.connect(gn); gn.connect(dest); src.start(); return { src, fl, g: gn };
  };

  // --- grafik: BİR KEZ kurulur ---
  const build = () => {
    if (G || !AC) return;
    try { ctx = new AC(); } catch { ctx = null; return; }
    const master = ctx.createGain(); master.gain.value = 0; master.connect(ctx.destination);
    const fpv = ctx.createBiquadFilter(); fpv.type = 'lowpass'; fpv.frequency.value = 20000; fpv.Q.value = 0.5; fpv.connect(master);
    const pan = ctx.createPanner(); pan.panningModel = 'equalpower'; pan.distanceModel = 'inverse'; pan.refDistance = REF_DISTANCE; pan.rolloffFactor = 1; pan.maxDistance = 5000; pan.connect(fpv);
    const src = ctx.createGain(); src.gain.value = 1; src.connect(pan);   // motor grubu (çarpışmada 0)
    const g = { master, fpv, pan, src, copter: null, plane: null, heli: null, rover: null, vehicle: null, wind: null, crashN: null };
    if (model.kind === 'copter' || model.kind === 'vtol') {
      const bus = ctx.createGain(); bus.gain.value = 0; bus.connect(src);
      const ratios = MOTOR_RATIOS[model.motors] || MOTOR_RATIOS[4];
      const motors = ratios.map(r => osc('sawtooth', 150 * r, bus, 0.09));
      const esc = osc('square', 300, bus, 0.03);
      const whirr = noise('bandpass', 420, 0.8, bus, 0.12);
      g.copter = { bus, motors, ratios, esc, whirr };
    }
    if (model.kind === 'plane' || model.kind === 'vtol') {
      const bus = ctx.createGain(); bus.gain.value = 0; bus.connect(src);
      const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 1800; lp.Q.value = 0.7; lp.connect(bus);
      const fire = osc('sawtooth', 25, lp, 0.22);
      const sub = osc('square', 12.5, lp, 0.1);
      const exhaust = noise('lowpass', 220, 0.7, bus, 0.12);
      const prop = osc('sine', 50, bus, 0.06);
      const starter = osc('sawtooth', 90, src, 0);       // marş motoru (ARM'da 0,8 sn "cranking"; bus dışında — rölanti kazancından bağımsız)
      const starterN = noise('bandpass', 700, 1.5, src, 0);
      g.plane = { bus, lp, fire, sub, exhaust, prop, starter, starterN };
    }
    if (model.kind === 'heli') {
      const bus = ctx.createGain(); bus.gain.value = 0; bus.connect(src);
      const rotorAM = ctx.createGain(); rotorAM.gain.value = 0.5; rotorAM.connect(bus);     // genliği LFO ile modüle edilir (wop-wop)
      const lfo = ctx.createOscillator(); lfo.type = 'sine'; lfo.frequency.value = 20; const lfoG = ctx.createGain(); lfoG.gain.value = 0.5; lfo.connect(lfoG); lfoG.connect(rotorAM.gain); lfo.start();
      const rotorN = noise('lowpass', 320, 0.9, rotorAM, 0.5);
      const rotorH = osc('sawtooth', 60, rotorAM, 0.1);
      const turbine = osc('sawtooth', 900, bus, 0.03);
      const turbineH = noise('bandpass', 2400, 2.5, bus, 0.05);
      const tail = osc('sawtooth', 110, bus, 0.05);
      g.heli = { bus, rotorAM, lfo, lfoG, rotorN, rotorH, turbine, turbineH, tail };
    }
    if (model.kind === 'rover') {   // §31 elektrik motoru: üçgen (ana) + dişli ıslığı (sinüs, × gear) + inverter vızıltısı + lastik gürültüsü
      const bus = ctx.createGain(); bus.gain.value = 0; bus.connect(src);
      const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 2400; lp.Q.value = 0.6; lp.connect(bus);
      const hum = osc('triangle', 90, lp, 0.22);
      const whine = osc('sine', 90 * model.gear, lp, 0.05);
      const inv = osc('square', 100, lp, 0.025);
      const tire = noise('lowpass', 180, 0.6, src, 0);   // lastik: motor kazancından bağımsız (yuvarlanırken de)
      g.rover = { bus, lp, hum, whine, inv, tire };
    }
    if (launchMethod === 'vehicle') {
      const bus = ctx.createGain(); bus.gain.value = 0; bus.connect(src);
      const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 900; lp.connect(bus);
      const eng = osc('sawtooth', 53, lp, 0.25);     // V8 4 zamanlı: ateşleme f = devir/60 × 4 → 800 d/dk'da 53 Hz
      const engH = osc('square', 26.5, lp, 0.08);
      const rumble = noise('lowpass', 160, 0.7, bus, 0.1);
      const brake = noise('bandpass', 1800, 3, bus, 0);   // fren gıcırtısı (released anında kısa)
      g.vehicle = { bus, lp, eng, engH, rumble, brake };
    }
    g.wind = noise('lowpass', 500, 0.6, master, 0);        // FPV rüzgârı (kokpit; panner dışında)
    g.crashN = noise('lowpass', 400, 0.7, master, 0);      // çarpışma + rampa efektleri için ortak gürültü kaynağı (zarf ile)
    g.fx = noise('bandpass', 2500, 1.2, master, 0);        // "pşşt" pnömatik
    g.thump = osc('sine', 80, master, 0);                  // kızak çarpması
    // çarpışma darbesi: ayrı yol (master'dan bağımsız; kazanç = ses düzeyi × IMPACT_BOOST) → kompresör → çıkış
    const impact = ctx.createGain(); impact.gain.value = 0;
    if (typeof ctx.createDynamicsCompressor === 'function') { const comp = ctx.createDynamicsCompressor(); try { comp.threshold.value = -14; comp.ratio.value = 6; comp.attack.value = 0.002; comp.release.value = 0.25; } catch { /* */ } impact.connect(comp); comp.connect(ctx.destination); }
    else impact.connect(ctx.destination);
    g.impact = { bus: impact, boom: osc('sine', 58, impact, 0), sub: osc('triangle', 29, impact, 0), debris: noise('lowpass', 1400, 0.6, impact, 0), crackle: noise('highpass', 2600, 0.8, impact, 0) };
    G = g;
    ctx.onstatechange = () => { if (ctx) { prefs.setUnlocked(ctx.state === 'running'); drawBtn(); } };
    prefs.setUnlocked(ctx.state === 'running');
  };
  const unlock = async () => {   // ilk kullanıcı etkileşimi: AudioContext resume (tarayıcı autoplay kuralı)
    if (disposed) return;
    build();
    if (!ctx) return;
    try { if (ctx.state !== 'running') await ctx.resume(); } catch { /* yine askıda */ }
    if (disposed || !ctx) return;
    prefs.setUnlocked(ctx.state === 'running');
    if (prefs.unlocked) removeUnlockListeners();
    drawBtn();
  };
  const unlockEvents = ['pointerdown', 'keydown', 'touchstart'];
  const addUnlockListeners = () => { if (typeof window !== 'undefined') unlockEvents.forEach(e => window.addEventListener(e, unlock, { passive: true })); };
  const removeUnlockListeners = () => { if (typeof window !== 'undefined') unlockEvents.forEach(e => window.removeEventListener(e, unlock)); };

  // --- tek seferlik efektler (zarf: hızlı yükseliş, üstel düşüş) ---
  const burst = (gainParam, peak, attack, decay) => {
    if (!ctx) return;
    const t0 = ctx.currentTime;
    if (typeof gainParam.cancelScheduledValues === 'function') { gainParam.cancelScheduledValues(t0); gainParam.setValueAtTime(0, t0); gainParam.linearRampToValueAtTime(peak, t0 + attack); gainParam.setTargetAtTime(0, t0 + attack, decay / 4); }
    else gainParam.value = 0;
    stats.paramSets++;
  };
  const fxRampLaunch = () => { if (G) burst(G.fx.g.gain, 0.7, 0.02, 0.45); };                    // pnömatik "pşşt"
  const fxRampRelease = () => { if (G) { burst(G.thump.g.gain, 0.6, 0.005, 0.25); burst(G.crashN.g.gain, 0.3, 0.01, 0.2); } };   // kızak durdurucuya çarpar
  const fxBrake = () => { if (G?.vehicle) burst(G.vehicle.brake.g.gain, 0.25, 0.05, 0.8); };
  // çarpma + motor durması: alçak "bum" (frekansı düşer), gövde/enkaz gürültüsü (lowpass kapanır), kıvılcım/kırılma çıtırtısı; şiddet çarpma hızıyla
  const fxCrash = speed => {
    if (!G) return;
    const k = impactParams(speed), vol = prefs.effective(), t0 = ctx.currentTime;
    burst(G.crashN.g.gain, k.noise, 0.01, 0.6 + 0.4 * k.i);
    P(G.src.gain, 0, 0.08);
    const I = G.impact; if (!I || vol <= 0) return;
    if (typeof I.bus.gain.cancelScheduledValues === 'function') { I.bus.gain.cancelScheduledValues(t0); I.bus.gain.setValueAtTime(vol * IMPACT_BOOST, t0); } else I.bus.gain.value = vol * IMPACT_BOOST;
    burst(I.boom.g.gain, k.boom, 0.004, k.decay); burst(I.sub.g.gain, k.boom * 0.6, 0.006, k.decay * 1.2);
    burst(I.debris.g.gain, k.debris, 0.003, k.decay * 0.8); burst(I.crackle.g.gain, k.crackle, 0.002, 0.35 + 0.3 * k.i);
    const f = I.boom.o.frequency, fl = I.debris.fl.frequency;
    if (typeof f.setValueAtTime === 'function') { f.cancelScheduledValues?.(t0); f.setValueAtTime(k.boomHz * 1.6, t0); f.exponentialRampToValueAtTime?.(k.boomHz * 0.55, t0 + 0.9); }
    if (typeof fl.setValueAtTime === 'function') { fl.cancelScheduledValues?.(t0); fl.setValueAtTime(3200, t0); fl.exponentialRampToValueAtTime?.(260, t0 + 1.2); }
    stats.impacts++;
  };

  // --- her telemetri karesi (≤ 25 Hz işlenir) ---
  const update = t => {
    if (disposed || !t) return;
    const now = nowMs();
    if (now - lastUpd < 40) return;
    const dt = lastUpd ? Math.min(0.5, (now - lastUpd) / 1000) : 0.05;
    lastUpd = now;
    stats.updates++;
    let sim = null; try { sim = opts.getSim?.() || null; } catch { sim = null; }
    // Çarpışma ve kalkış aşaması getter'lardan (flightsim.js'e ek bağlantı gerekmez)
    let crashed = false; try { crashed = !!opts.getCrashed?.(); } catch { crashed = false; }
    const phase = sim?.launchPhase ?? null;
    if (phase !== lastPhase) {
      if (G && prefs.effective() > 0) {
        if (launchMethod === 'ramp' && phase === 'launch') fxRampLaunch();
        if (launchMethod === 'ramp' && phase === 'released' && lastPhase === 'launch') fxRampRelease();
        if (launchMethod === 'vehicle' && phase === 'released') fxBrake();
      }
      lastPhase = phase;
    }
    if (crashed !== lastCrash) { lastCrash = crashed; prefs.setCrashed(crashed); if (crashed) { let v = null; try { v = opts.getCrashSpeed?.(); } catch { v = null; } fxCrash(v ?? t.groundspeed ?? 15); } else if (G) P(G.src.gain, 1, 0.3); }
    let sp = 1; try { sp = num(opts.getSpeed?.(), 1); } catch { sp = 1; }
    prefs.setPlaybackSpeed(sp);
    // hedefler + yumuşatma (devir gazı gecikmeli izler; disarm → hızlı düşüş yine tauDown ile)
    const vehSpeed = phase === 'launch' ? num(t.groundspeed) : 0;
    const tg = engineTargets(type, t, { launchMethod, launchPhase: phase, vehicleSpeed: vehSpeed });
    sm.thr = smoothFollow(sm.thr, tg.thr, dt);
    sm.bpf = smoothFollow(sm.bpf, tg.bpf || 150, dt);
    sm.rpm = smoothFollow(sm.rpm, model.kind === 'rover' ? tg.roverHz : tg.rpm, dt);   // §31 kara aracında motor uğultusu frekansı
    sm.vehRpm = smoothFollow(sm.vehRpm, tg.vehicleRpm || 800, dt, 0.5, 1.2);
    sm.veh = smoothFollow(sm.veh, tg.vehicle, dt, 0.3, 1.5);
    sm.spin = spinStep(sm.spin, tg.armed, dt, model.kind);   // ARM → motor başlatma rampası; DISARM → 1 sn sönme
    const vol = prefs.effective();
    drawBtn();
    if (!G) { if (vol > 0) build(); if (!G) return; }
    // uzaysal: dinleyici = kamera, kaynak = dron; gimbal kamerası/FPV'de kaynak dinleyicide (kokpit); 'fpv' boğuk + rüzgâr, 'pilot' yakın/yüksek + güçlü rüzgâr (§22)
    const cam = sim?.getCamera?.() || 'follow';
    const fpvOn = cam === 'fpv' || cam === 'pilot';
    const fp = fpvParams(t.airspeed ?? t.groundspeed, cam);
    P(G.master.gain, (crashed ? vol * 0.9 : vol) * (fpvOn ? fp.boost : 1), 0.08);
    if (vol <= 0) return;   // sessizken parametre sürmeye gerek yok (CPU)
    let doppler = 1, dist = 0;
    if (sim?.cameraPose && sim?.position) {
      const c = sim.cameraPose(), d = sim.position();
      setListener(c);
      const sx = fpvOn ? c.x : d.x, sy = fpvOn ? c.y : d.y, sz = fpvOn ? c.z : d.z;
      setPanner(sx, sy, sz);
      dist = Math.hypot(d.x - c.x, d.y - c.y, d.z - c.z);
      if (!fpvOn && prevDist != null && dt > 0) doppler = dopplerFactor((dist - prevDist) / dt);
      prevDist = dist;
    }
    P(G.fpv.frequency, fpvOn ? fp.lowpass : 20000, 0.1);
    P(G.wind.g.gain, fpvOn ? fp.wind : 0, 0.15); if (fpvOn) P(G.wind.fl.frequency, fp.windFreq, 0.2);
    const wob = 1 + tg.wobble * 0.015 * Math.sin(now / 90);   // gövde açısal hızı → ±%1,5 küçük titreme
    const armed = tg.armed, spin = sm.spin;
    if (G.copter) {
      // devir ve kazanç spin ile: ARM'da 0,6 sn'de 0 → rölanti (150 Hz × 0,35 → 150 Hz), DISARM'da 1 sn'de sönüm
      const f = sm.bpf * (0.35 + 0.65 * spin) * doppler * wob, gBase = (COPTER_IDLE + 0.5 * sm.thr / 100) * spin * (model.kind === 'vtol' ? 1 - tg.mix * 0.85 : 1);
      P(G.copter.bus.gain, gBase);
      G.copter.motors.forEach((mo, i) => P(mo.o.frequency, f * G.copter.ratios[i], 0.08));
      P(G.copter.esc.o.frequency, f * 2.01, 0.08);
      P(G.copter.whirr.fl.frequency, 300 + 3 * sm.thr, 0.1);
    }
    if (G.plane) {
      // marş (cranking): armed ve spin < 1 iken marş motoru duyulur, ateşleme devri 0 → rölantiye çıkar; sonra gaz izlenir. DISARM: devir ve kazanç spin ile söner.
      const cranking = armed && spin < 1;
      const rpm = Math.max(sm.rpm, model.idleRpm) * (0.12 + 0.88 * spin);
      const f = Math.max(5, firingHz(rpm, model.cylinders)) * doppler * wob;
      const gBase = (0.3 + 0.6 * sm.thr / 100) * (model.kind === 'vtol' ? 0.25 + 0.75 * tg.mix : 1) * spin * (cranking ? 0.6 : 1);
      P(G.plane.bus.gain, gBase);
      P(G.plane.starter.g.gain, cranking ? 0.22 : 0, 0.03); P(G.plane.starterN.g.gain, cranking ? 0.12 : 0, 0.03);
      P(G.plane.starter.o.frequency, (80 + 40 * spin) * wob, 0.05);
      P(G.plane.fire.o.frequency, f, 0.08); P(G.plane.sub.o.frequency, f / 2, 0.08);
      P(G.plane.prop.o.frequency, f * model.blades, 0.08);
      P(G.plane.lp.frequency, 900 + 14 * sm.thr, 0.1);
      P(G.plane.exhaust.fl.frequency, 150 + 6 * sm.thr, 0.1); P(G.plane.exhaust.g.gain, 0.08 + 0.12 * sm.thr / 100, 0.1);
    }
    if (G.heli) {
      const bpf = (tg.heliBpf || 20) * (0.15 + 0.85 * spin);   // rotor sarmalı: ARM'da 3 sn'de devir alır (pala geçişi 3 → 20 Hz), DISARM'da 1 sn'de durur
      P(G.heli.bus.gain, (0.35 + 0.5 * sm.thr / 100) * spin, 0.2);
      P(G.heli.lfo.frequency, bpf * doppler, 0.3);
      P(G.heli.rotorH.o.frequency, bpf * 3 * doppler * wob, 0.2);
      P(G.heli.tail.o.frequency, bpf * 5.5 * doppler, 0.2);
      P(G.heli.turbine.o.frequency, (900 + 600 * sm.thr / 100) * (0.3 + 0.7 * spin) * doppler, 0.3);
      P(G.heli.turbineH.fl.frequency, 2000 + 1200 * sm.thr / 100, 0.3);
      P(G.heli.rotorN.fl.frequency, 250 + 120 * spin, 0.3);
    }
    if (G.rover) {   // §31: frekans yumuşatılmış hızdan (sm.bpf yerine sm.rpm alanı roverHz'i taşır), spin ile açılır
      const f = Math.max(40, sm.rpm || tg.roverHz) * doppler * wob;
      P(G.rover.bus.gain, (tg.rover || 0) * spin, 0.12);
      P(G.rover.hum.o.frequency, f, 0.08); P(G.rover.whine.o.frequency, f * model.gear, 0.08);
      P(G.rover.whine.g.gain, 0.03 + 0.07 * clamp(sm.thr / 100, 0, 1), 0.1);
      P(G.rover.lp.frequency, 1400 + 2 * f, 0.15);
      P(G.rover.tire.g.gain, tg.tire, 0.2); P(G.rover.tire.fl.frequency, 140 + 30 * clamp(Math.abs(num(t.groundspeed)), 0, 25), 0.2);
    }
    if (G.vehicle) {
      const f = sm.vehRpm / 60 * 4;
      P(G.vehicle.bus.gain, sm.veh, 0.2);
      P(G.vehicle.eng.o.frequency, f, 0.1); P(G.vehicle.engH.o.frequency, f / 2, 0.1);
      P(G.vehicle.lp.frequency, 500 + sm.vehRpm * 0.25, 0.2);
    }
  };
  const setListener = c => {
    const L = ctx.listener;
    if (L.positionX) { P(L.positionX, c.x, 0.03); P(L.positionY, c.y, 0.03); P(L.positionZ, c.z, 0.03); P(L.forwardX, c.fx, 0.03); P(L.forwardY, c.fy, 0.03); P(L.forwardZ, c.fz, 0.03); P(L.upX, c.ux, 0.03); P(L.upY, c.uy, 0.03); P(L.upZ, c.uz, 0.03); }
    else { L.setPosition?.(c.x, c.y, c.z); L.setOrientation?.(c.fx, c.fy, c.fz, c.ux, c.uy, c.uz); }
  };
  const setPanner = (x, y, z) => {
    const p = G.pan;
    if (p.positionX) { P(p.positionX, x, 0.03); P(p.positionY, y, 0.03); P(p.positionZ, z, 0.03); } else p.setPosition?.(x, y, z);
  };

  // --- DOM: hoparlör düğmesi + ▾ menü (ses düzeyi) — alt çubukta, Panel düğmesinden sonra ---
  let el = null, btn = null, more = null, menu = null, slider = null, sliderOut = null, hint = null;
  const drawBtn = () => {
    if (!btn) return;
    const on = prefs.enabled;
    btn.textContent = on ? '🔊' : '🔇';
    btn.classList.toggle('primary', on);
    btn.classList.toggle('wait', prefs.waiting);
    btn.title = tr('Motor sesi aç/kapa (M)') + (prefs.waiting ? ` · ${tr('etkileşim bekleniyor')}` : '') + (prefs.speedMuted ? ` · ${tr('hızlı oynatmada sessiz')}` : '');
    btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    if (hint) hint.hidden = !prefs.waiting;
    if (sliderOut) sliderOut.textContent = `${prefs.volume}`;
  };
  const toggle = () => {
    prefs.toggle();
    if (prefs.enabled) unlock(); else if (G) P(G.master.gain, 0, 0.05);
    drawBtn();
    return prefs.enabled;
  };
  const onKey = e => {
    if (e.key !== 'm' && e.key !== 'M') return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const tag = doc?.activeElement?.tagName || '';
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(tag) || doc?.activeElement?.isContentEditable) return;
    toggle();
  };
  const onVisibility = () => { prefs.setHidden(!!doc?.hidden); if (G) P(G.master.gain, prefs.effective(), 0.05); };
  const closeMenu = () => { if (menu) menu.hidden = true; };
  const onDocClick = e => { if (menu && !menu.hidden && el && !el.contains(e.target)) closeMenu(); };
  if (doc && stage) {
    el = doc.createElement('span'); el.className = 'fs-audio pill-group';
    btn = doc.createElement('button'); btn.type = 'button'; btn.className = 'btn sm fs-audio-btn'; btn.onclick = toggle;
    btn.oncontextmenu = e => { e.preventDefault(); menu.hidden = !menu.hidden; };
    more = doc.createElement('button'); more.type = 'button'; more.className = 'btn sm fs-audio-more'; more.textContent = '▾'; more.title = tr('Ses düzeyi'); more.onclick = () => { menu.hidden = !menu.hidden; };
    menu = doc.createElement('div'); menu.className = 'fs-audio-menu'; menu.hidden = true;
    const row = doc.createElement('div'); row.className = 'fs-audio-row';
    const lbl = doc.createElement('span'); lbl.textContent = tr('Ses düzeyi');
    slider = doc.createElement('input'); slider.type = 'range'; slider.min = '0'; slider.max = '100'; slider.step = '1'; slider.value = String(prefs.volume); slider.setAttribute('aria-label', tr('Ses düzeyi'));
    slider.oninput = () => { prefs.setVolume(slider.value); if (G) P(G.master.gain, prefs.effective(), 0.05); drawBtn(); };
    sliderOut = doc.createElement('b'); sliderOut.className = 'mono';
    row.append(lbl, slider, sliderOut);
    hint = doc.createElement('div'); hint.className = 'small fs-audio-hint'; hint.textContent = tr('Ses için sayfaya bir kez tıklayın ya da bir tuşa basın');
    const desc = doc.createElement('div'); desc.className = 'small muted'; desc.textContent = tr('Dron tipine göre sentezlenmiş motor sesi; kameraya uzaklıkla azalır, FPV\'de kokpit sesi.');
    menu.append(row, hint, desc);
    el.append(btn, more, menu);
    const anchor = stage.querySelector('.fs-ops-btn') || stage.querySelector('.fs-mhud-btn');
    if (anchor) anchor.after(el); else (stage.querySelector('.fs-bar') || stage).append(el);
    drawBtn();
    doc.addEventListener('visibilitychange', onVisibility);
    doc.addEventListener('click', onDocClick, true);
    if (typeof window !== 'undefined') window.addEventListener('keydown', onKey);
  }
  if (prefs.enabled) addUnlockListeners();

  return {
    el, prefs, update, toggle,
    setEnabled: on => { if (!!on !== prefs.enabled) toggle(); return prefs.enabled; },
    setVolume: v => { prefs.setVolume(v); if (slider) slider.value = String(prefs.volume); if (G) P(G.master.gain, prefs.effective(), 0.05); drawBtn(); return prefs.volume; },
    unlock,
    // §17 ekran kaydı: master çıkışına bağlı MediaStreamAudioDestinationNode → MediaStream (kullanıcının duyduğu motor sesi; ses kapalıysa sessiz).
    // Bağlam yoksa (Web Audio desteklenmiyor) null. Askıdaysa resume denenir (Başlat tıklaması aktivasyonu sayfa geçişinde korunur).
    captureStream() {
      if (disposed) return null;
      build();
      if (!ctx || !G || typeof ctx.createMediaStreamDestination !== 'function') return null;
      try {
        const dest = ctx.createMediaStreamDestination();
        G.master.connect(dest);
        if (ctx.state !== 'running') ctx.resume?.().then(() => { prefs.setUnlocked(ctx?.state === 'running'); drawBtn(); }).catch(() => {});
        return dest.stream;
      } catch { return null; }
    },
    // §42 uçuş uyarı sesleri: master kazancına (ses düzeyi, sessiz kip, sekme gizli, hızlı oynatma) bağlı ayrı yol → ekran kaydına da girer.
    // Ses kapalı / etkileşim yok / sessizse null (uyarı yalnız görsel kalır).
    alertBus() {
      if (disposed || prefs.effective() <= 0) return null;
      build();
      if (!ctx || !G || ctx.state !== 'running') return null;
      if (!G.alert) { const g = ctx.createGain(); g.gain.value = 1; g.connect(G.master); G.alert = g; }
      return { ctx, bus: G.alert };
    },
    get menu() { return menu; },   // §42 ses kapsülü menüsü (uçuş uyarıları satırı buraya eklenir)
    get enabled() { return prefs.enabled; }, get context() { return ctx; }, get graph() { return G; }, get smooth() { return { ...sm }; }, get stats() { return { ...stats }; },
    dispose() {
      if (disposed) return;
      disposed = true;
      removeUnlockListeners();
      if (doc) { doc.removeEventListener('visibilitychange', onVisibility); doc.removeEventListener('click', onDocClick, true); }
      if (typeof window !== 'undefined') window.removeEventListener('keydown', onKey);
      el?.remove();
      if (G) { try { G.master.gain.value = 0; } catch { /* yok */ } }
      if (ctx && ctx.state !== 'closed') { try { ctx.close?.()?.catch?.(() => {}); } catch { /* kapalı */ } }   // close() reddi (zaten kapalı) yakalanır
      G = null; ctx = null;
    },
  };
}
