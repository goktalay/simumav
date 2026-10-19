// Uçuş Simülatörü — özet rapor (docs/ucus-simulatoru.md §18): Bitir'de (kayıt yüklemesinden sonra, tam ekrandan çıkmadan önce) sunucu özetini
// (GET /sessions/{id}/summary) modal kartta gösterir; sihirbazdaki "Son simülasyon raporları" listesi (GET /reports) aynı modalı açar.
// Bölümler: özet karoları · temel uçuş bilgileri · görev bilgisi · ÇARPIŞMA (kırmızı) · SAPMA (çarpışma ↔ görev bitiş noktası; büyük kırmızı yazı —
// çarpışma yoksa son konum ↔ bitiş noktası: iniş dairesi içinde yeşil / dışında turuncu) · güvenlik notu · 2B mini harita (canvas: rota, bitiş H,
// çarpışma kırmızı X, dron izi, ev). Düğmeler: "Raporu Şirketten Haberler'e ekle" (metin paylaşımı; yazma izni), "PDF / Yazdır" (window.print), Devam.
// Dışa: showReport(sum, { tr, be, canWrite }) → Promise (modal kapanınca) · reportsCard({ be, tr, canWrite }) → { el, refresh } · buildReportText(sum, tr)

import { clear, fmtDateTime, fmtDuration, h, modal, toast, toastError } from '../ui.js';

const REASON = { terrain: 'arazi', water: 'su', building: 'bina', sitl_hit: 'SITL yer teması (fizik)', sitl: 'SITL (otopilot çarpışma algısı)', manual: 'el ile' };
const SOURCE = { mp: 'Mission Planner', hepgo: 'HEPGO paneli' };
const f1 = v => (v == null || !Number.isFinite(Number(v)) ? '—' : Number(v).toFixed(1));
const f0 = v => (v == null || !Number.isFinite(Number(v)) ? '—' : String(Math.round(Number(v))));
const ll = (p, d = 6) => (p && p.lat != null ? `${Number(p.lat).toFixed(d)}, ${Number(p.lon).toFixed(d)}` : '—');
const clock = ts => { if (!ts) return '—'; const d = new Date(ts * 1000); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`; };
const km = m => (m == null ? '—' : m >= 1000 ? `${(m / 1000).toFixed(2)} km` : `${Math.round(m)} m`);

export function safetyText(sum, tr) {
  const s = sum.safety || {};
  const d = Math.round(Number(s.dist_m) || 0), r = tr(REASON[s.reason] || s.reason || '—');
  switch (s.code) {
    case 'crash_deviation': return tr('Görev bitiş noktası ile çarpışma arasında {d} m sapma ({r}) — rota irtifası arazi profiline göre gözden geçirilmeli; engel/arazi payı artırılmalı.', { d, r });
    case 'crash_no_mission': return tr('Görev yüklü değilken çarpışma ({r}) — el ile uçuşta irtifa ve hız sınırları gözden geçirilmeli.', { r });
    case 'in_circle': return tr('Dron görev bitiş noktasına {d} m mesafede, iniş dairesi içinde — güvenlik açısından uygun.', { d });
    case 'out_of_circle': return tr('Dron görev bitiş noktasından {d} m uzakta, iniş dairesi dışında — iniş yaklaşması ve rüzgâr payı gözden geçirilmeli.', { d });
    case 'no_mission': return tr('Görev yüklenmedi; sapma hesaplanamadı. Güvenlik değerlendirmesi için görev yükleyip uçuşu yineleyin.');
    default: return sum.safety_note || '';
  }
}

export function buildReportText(sum, tr) {
  const S = sum.session || {}, F = sum.flight || {}, M = sum.mission, C = sum.crash, D = sum.deviation;
  const out = [`${tr('Uçuş Simülatörü raporu')} · ${tr(S.type_name || S.type || '—')} · ${S.center?.name || '—'} · ${fmtDuration(F.duration_s || 0)}`,
    `${tr('En yüksek AGL')} ${f1(F.max_agl)} m · ${tr('En yüksek hız')} ${f1(F.max_speed)} m/s · ${tr('Kat edilen mesafe')} ${km(F.dist_m)} · ARM ${F.arm_count ?? 0}`];
  if (M) out.push(`${tr('Görev')}: ${M.count} WP (${tr(SOURCE[M.source] || M.source || '—')}) · ${tr('bitiş noktası')} ${ll(M.end)}`);
  if (C) out.push(`${tr('ÇARPIŞMA')}: ${ll(C)} · ${f1(C.speed)} m/s · ${tr(REASON[C.reason] || C.reason || '—')}`);
  if (D) out.push(`${tr('Sapma')}: ${f1(D.dist_m)} m ${tr('yatay')}, ${f1(D.dz_m)} m ${tr('dikey')}${D.in_circle ? ` · ${tr('İniş dairesi içinde')}` : ''}`);
  const sn = safetyText(sum, tr);
  if (sn) out.push(`${tr('Güvenlik notu')}: ${sn}`);
  return out.join('\n');
}

// ---------- 2B mini harita ----------
export function drawMiniMap(canvas, sum, tr) {
  const c = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  c.clearRect(0, 0, W, H);
  c.fillStyle = '#0b1220'; c.fillRect(0, 0, W, H);
  const pts = [];
  const home = sum.flight?.home || sum.session?.center;
  const route = (sum.mission?.points || []).filter(p => p.lat != null);
  const track = (sum.track || []).filter(o => o[1] != null);
  if (home?.lat != null) pts.push([home.lat, home.lon]);
  route.forEach(p => pts.push([p.lat, p.lon]));
  track.forEach(o => pts.push([o[1], o[2]]));
  if (sum.mission?.end) pts.push([sum.mission.end.lat, sum.mission.end.lon]);
  if (sum.crash?.lat != null) pts.push([sum.crash.lat, sum.crash.lon]);
  if (!pts.length) { c.fillStyle = '#94a3b8'; c.font = '13px system-ui'; c.textAlign = 'center'; c.fillText(tr('Konum verisi yok'), W / 2, H / 2); return; }
  const lat0 = pts.reduce((a, p) => a + p[0], 0) / pts.length, cos = Math.cos(lat0 * Math.PI / 180);
  const xy = ([lat, lon]) => [lon * 111320 * cos, lat * 110574];
  const m = pts.map(xy);
  let x1 = Math.min(...m.map(p => p[0])), x2 = Math.max(...m.map(p => p[0])), y1 = Math.min(...m.map(p => p[1])), y2 = Math.max(...m.map(p => p[1]));
  const span = Math.max(x2 - x1, y2 - y1, 60), pad = span * 0.12;
  x1 -= pad; x2 = x1 + span + 2 * pad; y1 -= pad; y2 = y1 + span + 2 * pad;
  const sc = Math.min(W / (x2 - x1), H / (y2 - y1));
  const ox = (W - (x2 - x1) * sc) / 2, oy = (H - (y2 - y1) * sc) / 2;
  const P = ([lat, lon]) => { const [x, y] = xy([lat, lon]); return [ox + (x - x1) * sc, H - (oy + (y - y1) * sc)]; };
  // ızgara
  c.strokeStyle = 'rgba(148,163,184,.12)'; c.lineWidth = 1;
  for (let i = 1; i < 6; i++) { c.beginPath(); c.moveTo(W * i / 6, 0); c.lineTo(W * i / 6, H); c.stroke(); c.beginPath(); c.moveTo(0, H * i / 6); c.lineTo(W, H * i / 6); c.stroke(); }
  // iniş dairesi
  const end = sum.mission?.end, R = (Number(sum.session?.landing_circle_m) || 30) / 2;
  if (end) { const [ex, ey] = P([end.lat, end.lon]); c.setLineDash([5, 4]); c.strokeStyle = sum.deviation?.in_circle ? '#4ade80' : '#fbbf24'; c.lineWidth = 2; c.beginPath(); c.arc(ex, ey, Math.max(6, R * sc), 0, Math.PI * 2); c.stroke(); c.setLineDash([]); }
  // rota
  if (route.length) {
    c.strokeStyle = '#ffb300'; c.lineWidth = 2.5; c.lineJoin = 'round';
    c.beginPath();
    const start = home?.lat != null ? P([home.lat, home.lon]) : P([route[0].lat, route[0].lon]);
    c.moveTo(start[0], start[1]);
    route.forEach(p => { const [x, y] = P([p.lat, p.lon]); c.lineTo(x, y); });
    c.stroke();
    route.forEach(p => { const [x, y] = P([p.lat, p.lon]); c.fillStyle = p.cmd === 21 || p.cmd === 20 ? '#a78bfa' : '#ffd166'; c.beginPath(); c.arc(x, y, 4, 0, Math.PI * 2); c.fill(); c.fillStyle = '#fff'; c.font = 'bold 10px system-ui'; c.textAlign = 'left'; c.fillText(String(p.seq ?? ''), x + 6, y - 5); });
  }
  // iz
  if (track.length > 1) {
    c.strokeStyle = 'rgba(96,165,250,.95)'; c.lineWidth = 1.8;
    c.beginPath();
    track.forEach((o, i) => { const [x, y] = P([o[1], o[2]]); if (i) c.lineTo(x, y); else c.moveTo(x, y); });
    c.stroke();
  }
  // ev
  if (home?.lat != null) { const [x, y] = P([home.lat, home.lon]); c.fillStyle = '#34d399'; c.beginPath(); c.arc(x, y, 7, 0, Math.PI * 2); c.fill(); c.fillStyle = '#06281c'; c.font = 'bold 10px system-ui'; c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillText('H', x, y + 0.5); }
  // bitiş noktası H
  if (end) { const [x, y] = P([end.lat, end.lon]); c.fillStyle = '#fff'; c.beginPath(); c.arc(x, y, 8, 0, Math.PI * 2); c.fill(); c.fillStyle = '#0b1220'; c.font = 'bold 11px system-ui'; c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillText('H', x, y + 0.5); }
  // çarpışma X
  if (sum.crash?.lat != null) {
    const [x, y] = P([sum.crash.lat, sum.crash.lon]);
    c.strokeStyle = '#ef4444'; c.lineWidth = 3.5; c.beginPath(); c.moveTo(x - 8, y - 8); c.lineTo(x + 8, y + 8); c.moveTo(x + 8, y - 8); c.lineTo(x - 8, y + 8); c.stroke();
    if (end) { const [ex, ey] = P([end.lat, end.lon]); c.setLineDash([3, 3]); c.strokeStyle = 'rgba(239,68,68,.8)'; c.lineWidth = 1.5; c.beginPath(); c.moveTo(x, y); c.lineTo(ex, ey); c.stroke(); c.setLineDash([]); }
  }
  // son konum (çarpışma yoksa)
  if (!sum.crash && sum.flight?.last_pos?.lat != null) { const [x, y] = P([sum.flight.last_pos.lat, sum.flight.last_pos.lon]); c.fillStyle = '#60a5fa'; c.beginPath(); c.arc(x, y, 5, 0, Math.PI * 2); c.fill(); }
  // ölçek çubuğu
  const nice = [10, 20, 50, 100, 200, 500, 1000, 2000, 5000].find(v => v * sc >= 50) || 5000;
  c.strokeStyle = '#e2e8f0'; c.lineWidth = 2; c.beginPath(); c.moveTo(10, H - 10); c.lineTo(10 + nice * sc, H - 10); c.stroke();
  c.fillStyle = '#e2e8f0'; c.font = '10px system-ui'; c.textAlign = 'left'; c.textBaseline = 'alphabetic'; c.fillText(nice >= 1000 ? `${nice / 1000} km` : `${nice} m`, 12, H - 14);
  // kuzey oku
  c.fillStyle = '#e2e8f0'; c.textAlign = 'center'; c.font = 'bold 11px system-ui'; c.fillText('N', W - 14, 14); c.beginPath(); c.moveTo(W - 14, 18); c.lineTo(W - 18, 28); c.lineTo(W - 10, 28); c.closePath(); c.fill();
}

// ---------- rapor gövdesi ----------
export function reportBody(sum, tr, { canWrite = false, be = null } = {}) {
  const S = sum.session || {}, F = sum.flight || {}, M = sum.mission, C = sum.crash, D = sum.deviation;
  const kv = (k, v, cls = '') => h('div', { class: `fs-rp-kv ${cls}` }, h('span', null, k), h('b', null, v));
  const tile = (label, value, unit, cls = '') => h('div', { class: `fs-rp-tile ${cls}` }, h('b', null, value, unit ? h('i', null, unit) : null), h('span', null, label));
  const tiles = h('div', { class: 'fs-rp-tiles' },
    tile(tr('Toplam süre'), fmtDuration(F.duration_s || 0)),
    tile(tr('Havada'), fmtDuration(F.air_s || 0)),
    tile(tr('En yüksek AGL'), f1(F.max_agl), 'm'),
    tile(tr('En yüksek hız'), f1(F.max_speed), 'm/s'),
    tile(tr('Mesafe'), km(F.dist_m)),
    tile(tr('ARM sayısı'), String(F.arm_count ?? 0)));
  const drone = S.drone ? `${S.drone.code || ''} ${S.drone.name || ''}`.trim() + (S.drone.model ? ` (${S.drone.model})` : '') : tr('Simülatör sanal dronu');
  const launch = S.launch?.method ? tr({ wheels: 'Tekerlekli', ramp: 'Fırlatma rampası', vehicle: 'Araç üstü' }[S.launch.method] || S.launch.method) : '—';
  const basic = h('div', { class: 'fs-rp-sec' }, h('h4', null, tr('Temel uçuş bilgileri')),
    kv(tr('Dron tipi / model'), `${tr(S.type_name || S.type || '—')} · ${S.model || '—'}`),
    kv(tr('Dron kaydı'), drone),
    kv(tr('Merkez'), `${S.center?.name || '—'} (${ll(S.center, 5)}${S.center?.alt != null ? ` · ${f0(S.center.alt)} m MSL` : ''})`),
    kv(tr('Dünya kipi'), `${tr({ procedural: 'Prosedürel', real: 'Gerçek arazi', google3d: 'Google 3B' }[S.world_mode] || S.world_mode || '—')} · ${tr({ day: 'Gündüz', dusk: 'Akşam', night: 'Gece' }[S.world_time] || S.world_time || '—')} · ${tr('rüzgâr')} ${f1(S.wind_ms)} m/s @ ${f0(S.wind_dir)}°`),
    S.type === 'sabit_kanat' ? kv(tr('Kalkış yöntemi'), launch) : null,
    kv(tr('Başlangıç / bitiş'), `${clock(F.start_ts)} → ${clock(F.end_ts)}${sum.created_at ? ` · ${fmtDateTime(sum.created_at)}` : ''}`),
    kv(tr('En yüksek MSL'), `${f1(F.max_msl)} m`),
    kv(tr('Modlar'), (F.modes || []).join(' → ') || '—'),
    kv(tr('Son mod'), F.last_mode || '—'),
    kv(tr('Batarya'), F.batt?.first_v ? `${f1(F.batt.first_v)} V → ${f1(F.batt.last_v)} V · %${f0(F.batt.first_pct)} → %${f0(F.batt.last_pct)}` : '—'),
    kv(tr('Son konum'), `${ll(F.last_pos)} · AGL ${f1(F.last_pos?.alt_rel)} m`));
  const mission = h('div', { class: 'fs-rp-sec' }, h('h4', null, tr('Görev bilgisi')),
    M ? [kv(tr('Kaynak'), tr(SOURCE[M.source] || M.source || '—')), kv(tr('WP sayısı'), String(M.count)), kv(tr('Tamamlanan WP'), `${M.completed} / ${M.count}`),
      kv(tr('Bitiş noktası'), `${ll(M.end)} · AGL ${f1(M.end?.alt_rel)} m${M.end?.cmd === 21 ? ` · LAND` : M.end?.cmd === 20 ? ` · RTL` : ''}`), kv(tr('İniş dairesi çapı'), `${f0(S.landing_circle_m)} m`)]
      : h('div', { class: 'small muted' }, tr('Görev yüklenmedi.')));
  const crash = C ? h('div', { class: 'fs-rp-sec fs-rp-crash' }, h('h4', null, '⚠ ', tr('ÇARPIŞMA')),
    kv(tr('Koordinat'), ll(C)), kv(tr('İrtifa'), `${f1(C.alt_msl)} m MSL · AGL ${f1(C.alt_rel)} m`), kv(tr('Zaman'), clock(C.t)), kv(tr('Hız'), `${f1(C.speed)} m/s (${f0(C.speed * 3.6)} km/h)`),
    kv(tr('Mod'), C.mode || '—'), kv(tr('Neden'), tr(REASON[C.reason] || C.reason || '—') + (C.sitl_text ? ` · ${C.sitl_text}` : '')),
    C.target_seq != null ? kv(tr('Hedef WP'), String(C.target_seq)) : null,
    sum.crash_count > 1 ? h('div', { class: 'small' }, tr('{n} çarpışma kaydedildi; sonuncusu gösteriliyor.', { n: sum.crash_count })) : null) : null;
  let dev = null;
  if (D) {
    const red = D.from === 'crash', cls = red ? 'red' : D.in_circle ? 'green' : 'orange';
    dev = h('div', { class: `fs-rp-dev ${cls}` },
      h('div', { class: 'fs-rp-dev-h' }, red ? tr('SAPMA: çarpışma noktası ↔ görev bitiş noktası') : tr('Son konum ↔ görev bitiş noktası')),
      h('div', { class: 'fs-rp-dev-big' }, `${f1(D.dist_m)} m`),
      h('div', { class: 'fs-rp-dev-sub' }, `${tr('yükseklik farkı')} ${D.dz_m > 0 ? '+' : ''}${f1(D.dz_m)} m · ${D.in_circle ? tr('İniş dairesi içinde') : tr('İniş dairesi dışında')} (${tr('yarıçap')} ${f1((S.landing_circle_m || 30) / 2)} m)`));
  }
  const safety = h('div', { class: `fs-rp-safety ${C ? 'red' : D?.in_circle ? 'green' : 'orange'}` }, h('b', null, tr('Güvenlik notu'), ': '), safetyText(sum, tr));
  const canvas = h('canvas', { class: 'fs-rp-map', width: 420, height: 320 });
  const legend = h('div', { class: 'fs-rp-legend small' }, h('span', { class: 'r' }, tr('rota')), h('span', { class: 't' }, tr('dron izi')), h('span', { class: 'e' }, tr('bitiş H')), C ? h('span', { class: 'x' }, tr('çarpışma')) : null);
  const body = h('div', { class: 'fs-rp' },
    h('div', { class: 'fs-rp-head' }, h('div', null, h('b', null, tr('Simülasyon özet raporu')), h('div', { class: 'small muted' }, [sum.session_id != null ? tr('Oturum #{n}', { n: sum.session_id }) : null, sum.owner?.name, sum.created_at ? fmtDateTime(sum.created_at) : null].filter(Boolean).join(' · '))),
      C ? h('span', { class: 'badge red' }, tr('ÇARPIŞMA')) : h('span', { class: 'badge green' }, tr('Çarpışma yok'))),
    tiles,
    h('div', { class: 'fs-rp-cols' }, h('div', null, basic, mission), h('div', { class: 'fs-rp-mapwrap' }, canvas, legend, dev)),
    crash, safety);
  requestAnimationFrame(() => { try { drawMiniMap(canvas, sum, tr); } catch { /* harita hatası raporu bozmasın */ } });
  return body;
}

export function showReport(sum, { tr, be, canWrite = false } = {}) {
  return new Promise(resolve => {
    const body = reportBody(sum, tr, { canWrite, be });
    const actions = [];
    if (canWrite && be?.shareReport && sum.id) {
      actions.push({ label: tr('Raporu Şirketten Haberler\'e ekle'), onClick: async ({ button }) => {   // true → pencere açık kalır (ui.js modal)
        try { await be.shareReport(sum.id, buildReportText(sum, tr)); toast(tr('Rapor Şirketten Haberler\'e paylaşıldı')); button.textContent = `✓ ${tr('Paylaşıldı')}`; } catch (err) { toastError(err); }
        return true;
      } });
    }
    actions.push({ label: tr('PDF / Yazdır'), onClick: () => { printReport(); return true; } });
    actions.push('spacer', { label: tr('Devam'), class: 'primary' });
    modal({ title: tr('Simülasyon özet raporu'), body, wide: true, actions, onClose: () => resolve(sum) });
  });
}

export function printReport() {
  document.body.classList.add('fs-rp-printing');
  const done = () => { document.body.classList.remove('fs-rp-printing'); window.removeEventListener('afterprint', done); };
  window.addEventListener('afterprint', done);
  setTimeout(() => { try { window.print(); } catch { done(); } setTimeout(done, 1500); }, 50);
}

// ---------- sihirbaz: son raporlar ----------
export function reportsCard({ be, tr, canWrite = false, limit = 20 } = {}) {
  const list = h('div', { class: 'fs-rp-rows' });
  const el = h('div', { class: 'card card-pad fs-rp-list no-collapse' }, h('h3', null, tr('Son simülasyon raporları')), h('p', { class: 'small muted' }, tr('Her oturumun Bitir\'de (ya da kapanışta) üretilen özet raporu: uçuş bilgileri, görev, çarpışma ve sapma. Satıra tıklayınca rapor açılır.')), list);
  const refresh = async () => {
    let rows = [];
    try { rows = (await be.reports(limit))?.items || []; } catch { rows = []; }
    if (!rows.length) { el.hidden = true; return; }
    el.hidden = false;
    clear(list, rows.map(r => h('button', { type: 'button', class: 'fs-rp-row', onclick: async () => { try { const sum = await be.report(r.id); await showReport(sum, { tr, be, canWrite }); } catch (err) { toastError(err); } } },
      h('span', { class: 'fs-rp-row-main' }, h('b', null, tr(r.type_name || r.type || '—')), h('span', { class: 'small muted' }, [r.center, r.owner_name, r.created_at ? fmtDateTime(r.created_at) : null, r.duration_s != null ? fmtDuration(r.duration_s) : null, r.max_agl != null ? `AGL ${f1(r.max_agl)} m` : null].filter(Boolean).join(' · '))),
      h('span', { class: 'fs-rp-row-badges' },
        r.mission ? h('span', { class: 'badge blue' }, tr('Görev')) : null,
        r.crash ? h('span', { class: 'badge red' }, `${tr('ÇARPIŞMA')}${r.deviation_m != null ? ` · ${f0(r.deviation_m)} m` : ''}`) : r.deviation_m != null ? h('span', { class: `badge ${r.in_circle ? 'green' : 'orange'}` }, `${f0(r.deviation_m)} m`) : null))));
  };
  refresh();
  return { el, refresh };
}
