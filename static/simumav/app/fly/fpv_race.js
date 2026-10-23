// SIMUMAV › Uç › FPV PARKUR YARIŞI — yarış ekranı katmanı (docs/simumav.md §29; HEPGO §47 attachFpvMatch'in SIMUMAV karşılığı).
// match_hud.js kind 'fpv' karşılaşmada kurar. ORTAK modüller değiştirilmeden: /sim/flightsim_fpvcourse3d.js (neon kapılar — sıradaki yeşil nabız, sonraki
// 1–2 pembe/mor, geçilen sönük; başlangıçta yerde parlayan halka; sıradakine ince kılavuz çizgi; mekan sahnesi; hayalet) TEK WebGL çizicide (oturumun
// flightsim3d sahnesi) + /sim/flightsim_fpvcourse_hud.js (tur/sektör, en iyi tur, hayalete göre ±fark, ceza, sıradaki kapı çerçevesi/oku; altta iki
// çubuk-konumu göstergesi — FPV menüsünde aç/kapa). Ses: oturumun oyun efekti yolu (flightsim_sfx; SIMUMAV `sm.sfx` düzey/kanal ayarı).
// Hayalet: GET /api/fpv/courses/{cid}/ghost?laps= (yalnız kendi kişisel rekorum; yoksa 404 → hayaletsiz), tercih fs.fpv.ghost ('pb' | 'off').
import { createFpvCourseLayer } from '/sim/flightsim_fpvcourse3d.js';
import { createFpvCourseHud } from '/sim/flightsim_fpvcourse_hud.js';
import { bestSectors, decodeGhost, fmtLap, ghostPref } from '/sim/flightsim_fpvcourse.js';
import { FT, fpvApi } from './fpv.js';

export function attachFpvRace({ stage, getSim, me, sfx = null, getRc = () => null, getTele = () => null, fpvMenu = null, onError = null }) {
  let M = null, layer = null, course = null, detail = null, loading = false, disposed = false, ghostInfo = null;
  const gp = ghostPref();
  const hud = createFpvCourseHud(stage, { getSim, T: FT, me, sfx, getRc, getTele });
  const sticksRow = hud.sticksRow();
  if (sticksRow && fpvMenu) fpvMenu.insertBefore(sticksRow, fpvMenu.querySelector('.small.muted') || null);
  const cfg = () => M?.rings_cfg || {};
  // Yükseklik ölçeği (match_hud.syncRings ile aynı): sunucu kontrol noktalarını ortak ev irtifası (SITL; center.alt) + zeminden yükseklikle verir;
  // SIMUMAV 3B sahnesinin ev irtifası (homeAlt) prosedürel dünyada null/0 olabilir → alt_msl = homeAlt + (alt_msl − center.alt) (parkur zeminde oturur)
  const H0 = () => Number(getSim()?.homeAlt ?? 0) || 0;
  const local = m => {
    if (!m) return m;
    const c0 = Number(m.center?.alt);
    if (!Number.isFinite(c0)) return m;
    return { ...m, rings: (m.rings || []).map(r => (r.alt_msl == null ? r : { ...r, alt_msl: H0() + Number(r.alt_msl) - c0 })) };
  };
  async function build() {
    const sim = getSim();
    if (loading || layer || !sim?.three || !sim?.scene || !M || disposed || !cfg().course_id) return;
    loading = true;
    try {
      const laps = Number(cfg().laps) || null;
      detail = await fpvApi.detail(cfg().course_id, laps);
      if (disposed) return;
      course = detail.course;
      layer = createFpvCourseLayer(sim, course, { checkpoints: local(M).rings || [], me, T: FT });
      hud.setPb(detail.my_best ? { sectors: detail.my_best.sectors } : null);
      if (detail.my_best?.sectors) hud.setRecordSectors(bestSectors(detail.my_best.sectors));   // SIMUMAV: yalnız kendi rekorum (başkasının ara süreleri gizli)
      const pn = (M.players || []).find(p => p.id === me);
      layer.setProgress(pn?.finished ? null : pn?.next ?? 1);
      window.__smFpv = api;   // teşhis (Playwright)
      if (gp.get() === 'pb') {
        try {
          const g = await fpvApi.ghost(cfg().course_id, laps);
          if (disposed) return;
          ghostInfo = { time_s: g.time_s, splits: g.splits || null };
          layer.setGhost(decodeGhost(g.ghost), { color: '#22d3ee', name: `${FT('fpv.ghost_hud')} · ${fmtLap(g.time_s)}` });
          hud.setGhost({ splits: g.splits || [], name: g.name, time_s: g.time_s });
        } catch { /* kişisel rekor yok (404) */ }
      }
    } catch (e) { onError?.(e); } finally { loading = false; }
  }
  const raceT = now => (M?.start_at == null ? null : now - Number(M.start_at));
  const api = {
    setMatch(m, now) { M = m; hud.setMatch(local(m)); hud.setNow(now); build(); if (layer && (M.state === 'YARIS' || M.state === 'BITTI')) layer.update(raceT(now)); },
    tick(now) { hud.setNow(now); if (layer && M) layer.update(M.state === 'YARIS' || M.state === 'BITTI' ? raceT(now) : null); build(); },
    event(m, now) {
      hud.setNow(now); hud.event(m);   // olaylar yükseklik taşımaz (i, lap, sector …)
      if (!layer) return;
      if (m.t === 'pos') { const p = (m.p || []).find(x => x.id === me); if (p && p.next !== undefined) layer.setProgress(p.next); return; }
      if (m.id !== me) return;
      if (m.t === 'ring') { const cp = (M?.rings || []).find(c => c.i === m.i); layer.setProgress(m.i + 1 > (m.total ?? 1e9) ? null : m.i + 1); layer.flash(cp?.gate === 0 && cp.lap > 0 ? 'lap' : 'gate', cp?.gate ?? null); }
      else if (m.t === 'miss') { const cp = (M?.rings || []).find(c => c.i === m.i); layer.flash('miss', cp?.gate ?? null); }
      else if (m.t === 'hit') layer.flash('hit');
      else if (m.t === 'finish') layer.setProgress(null);
    },
    get layer() { return layer; }, get hud() { return hud; }, get course() { return course; }, get detail() { return detail; }, get ghost() { return ghostInfo; },
    dispose() { disposed = true; layer?.dispose(); hud.dispose(); sticksRow?.remove(); if (window.__smFpv === api) delete window.__smFpv; },
  };
  return api;
}
