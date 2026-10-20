// Uçuş Simülatörü §26 — yer kontrol sahası ARAYÜZÜ (HEPGO flightsim.js + SIMUMAV fly/ ortak; DOM, kendi CSS'ini bir kez ekler):
//  • createSiteSection: uçuş öncesi seçim — RADAR / YER KONTROL İSTASYONU / ELEKTRO-OPTİK var/yok + menziller (radar 1–50 km, vars. 20; EO 0,5–15 km,
//    vars. 5) + görev senaryosu "Yer kontrolünü koru" (yalnız INTERCEPTOR: zorluk, dalga, interceptor sayısı, önleme yarıçapı, hazırlık, tohum) + şematik.
//  • createSiteScreens: uçuşta SOL ALTTA radar ekranı, hemen yanında EO ekranı (görüntü 3B tuvalinde — aynı WebGL bağlamı, sim.setRadarRect/setEoRect;
//    burada yalnız çerçeve + 2B katman: menzil etiketleri, hedef numaraları, EO OSD'si); ayrı ayrı aç/kapa (düğme + Y / U; localStorage fs.site).
//    Radar ekranına tıklama hedef seçer (sim.lockTarget; Tab kilidiyle aynı durum) → EO o hedefi izler.
//  • createDefendHud: görev şeridi (dalga, geri sayım, istasyon sağlığı, interceptor rafı, önlenen/sızan) + orta bant bildirimleri + "Sıradaki interceptor" (N).
//  • defendReportBody / showDefendReport: görev sonu başarı raporu (sonuç, puan, rütbe, isabet, önleme süreleri, zaman çizelgesi, önleme tablosu).
// Metinler: SITE_TEXTS [anahtar, Türkçe] — HEPGO'da Türkçe metin sözlük anahtarıdır (tr(metin)); SIMUMAV'da `site.*` anahtarları (keyed=true; i18n 7 dil).
import { DEFEND_DEFAULTS, DEFEND_LIMITS, DIFFICULTIES, THREAT_MODELS, EO_KM, EO_KM_DEFAULT, RADAR_KM, RADAR_KM_DEFAULT, fmtClock, fmtKm, nextWave, radarSteps, randomSeed, siteBody, siteLayout, validateDefend, validateSite } from './flightsim_gcs.js';

export const SITE_TEXTS = [
  ['site.title', 'Yer Kontrol Merkezi'], ['site.optional', 'isteğe bağlı'],
  ['site.desc', 'Kalkış noktasının yanında yer kontrol istasyonu ve Elektro-Optik + radar taşıyan kule. Radar 360° sürekli döner; EO seçilen hedefi izler.'],
  ['site.radar', 'Radar'], ['site.radar_desc', '360° döner · hedefleri kapsama alanında gösterir'], ['site.station', 'Yer kontrol istasyonu'],
  ['site.station_desc', 'Shelter konteyner, anten direği, jeneratör'], ['site.eo', 'Elektro-Optik'], ['site.eo_desc', 'Yakınlaştırmalı gündüz / termal / gece kamerası'],
  ['site.coverage', 'Kapsama'], ['site.zoom_range', 'Görüş menzili'], ['site.on', 'Var'], ['site.off', 'Yok'],
  ['site.required', 'görev için gerekli'], ['site.scenario', 'Görev senaryosu'], ['site.free', 'Serbest uçuş'], ['site.free_desc', 'Saha yalnız görsel ve sensör olarak bulunur.'],
  ['site.defend', 'Yer kontrolünü koru'],
  ['site.defend_desc', 'Tamamen manuel uçuş. İstasyonun yanında rafta interceptor\'lar hazır; dalgalar hâlinde rastgele mesafe ve yükseklikten gelen hedefler istasyona dalar. Interceptor\'ı fırlat, kumandayla önle; önlenemeyen hedef istasyona çarparsa istasyon hasar alır.'],
  ['site.defend_only', 'Yalnız INTERCEPTOR tipiyle'], ['site.difficulty', 'Zorluk'], ['site.d_easy', 'Kolay'], ['site.d_normal', 'Normal'], ['site.d_hard', 'Zor'],
  ['site.waves', 'Dalga sayısı'], ['site.interceptors', 'Interceptor sayısı'], ['site.radius', 'Önleme yarıçapı'], ['site.prep', 'Hazırlık süresi'], ['site.seed', 'Tohum'],
  ['site.seed_hint', 'Aynı tohum aynı senaryoyu üretir (tekrar / karşılaştırma)'], ['site.new_seed', 'Yeni tohum'],
  ['site.schema', 'Yerleşim (kuzey yukarı)'], ['site.pad', 'Kalkış'], ['site.tower', 'Kule'], ['site.rack', 'Raf'], ['site.station_short', 'İstasyon'],
  ['site.radar_btn', 'Radar'], ['site.eo_btn', 'EO'], ['site.radar_title', 'Radar ekranını aç/kapa (Y)'], ['site.eo_title', 'EO ekranını aç/kapa (U)'],
  ['site.scr_radar', 'RADAR'], ['site.scr_eo', 'EO'], ['site.cov', 'KAPSAMA'], ['site.view', 'EKRAN'], ['site.auto', 'OTO'], ['site.close', 'Kapat'],
  ['site.range_dn', 'Ekran menzilini daralt'], ['site.range_up', 'Ekran menzilini genişlet'], ['site.range_auto', 'Otomatik ekran menzili'],
  ['site.targets_n', '{n} hedef'], ['site.no_contact', 'TEMAS YOK'], ['site.click_pick', 'tıkla: hedef seç'], ['site.own', 'İHA'], ['site.radar_wait', 'RADAR HAZIRLANIYOR'],
  ['site.eo_type', 'EO kamera türü (gündüz / termal / gece)'], ['site.day', 'GÜNDÜZ'], ['site.thermal', 'TERMAL'], ['site.night', 'GECE'],
  ['site.eo_idle', 'HEDEF SEÇİLMEDİ'], ['site.eo_idle_hint', 'Radar ekranında hedefe tıklayın ya da Tab'], ['site.eo_out', 'MENZİL DIŞI'], ['site.eo_slew', 'YÖNLENİYOR'],
  ['site.eo_track', 'İZ'], ['site.az', 'AZ'], ['site.el', 'EL'], ['site.rng', 'MZL'],
  ['site.mission', 'YER KONTROLÜNÜ KORU'], ['site.wave', 'DALGA {w}/{n}'], ['site.prep_left', 'Hazırlık {t}'], ['site.next_wave', 'Sonraki dalga {t}'], ['site.last_wave', 'Son dalga'],
  ['site.health', 'İSTASYON'], ['site.icepts', 'INTERCEPTOR'], ['site.killed', 'Önlenen'], ['site.leaked', 'Sızan'], ['site.active', 'Aktif tehdit'],
  ['site.next_btn', 'Sıradaki interceptor'], ['site.next_title', 'Sıradaki interceptor\'ı pad\'e konuşlandır (N) — uçmuş olan harcanır'],
  ['site.next_confirm', 'Aktif interceptor bırakılıp sıradaki konuşlandırılsın mı? Uçmuş interceptor harcanmış sayılır (SITL aracı pad\'de yeniden başlar).'],
  ['site.none_left', 'Rafta interceptor kalmadı'],
  ['site.b_wave', 'DALGA {w} · {n} TEHDİT'], ['site.b_kill', 'TEHDİT ÖNLENDİ'], ['site.b_leak', 'İSTASYON VURULDU −{d}'], ['site.b_down', 'INTERCEPTOR KAYBEDİLDİ'],
  ['site.b_down_sub', 'N: sıradaki interceptor ({n} rafta)'], ['site.b_success', 'GÖREV BAŞARILI'], ['site.b_fail', 'GÖREV BAŞARISIZ'], ['site.b_next', 'INTERCEPTOR #{n} PAD\'DE'],
  ['site.ev_wave', 'DALGA {w}/{n}: {c} tehdit istasyona yöneldi'], ['site.ev_kill', 'TEHDİT ÖNLENDİ · {name} · istasyona {d} · {s} sn'],
  ['site.ev_leak', 'İSTASYON VURULDU · {name} · −{d} · sağlık %{h}'], ['site.ev_down', 'Interceptor kaybedildi ({r}) — {n} rafta'],
  ['site.ev_next', 'Interceptor #{n} konuşlandırıldı'], ['site.r_crash', 'çarpışma'], ['site.r_battery', 'batarya'],
  ['site.report', 'Görev raporu — Yer kontrolünü koru'], ['site.success', 'BAŞARILI'], ['site.fail', 'BAŞARISIZ'], ['site.ongoing', 'SÜRÜYOR'],
  ['site.score', 'Puan'], ['site.rank', 'Rütbe'], ['site.accuracy', 'İsabet oranı'], ['site.kills_of', 'Önlenen / doğan'], ['site.leaks', 'Kaçan (istasyona ulaşan)'],
  ['site.health_t', 'İstasyon sağlığı'], ['site.used', 'Kullanılan interceptor'], ['site.ttk_avg', 'Ort. önleme süresi'], ['site.ttk_min', 'En hızlı önleme'],
  ['site.waves_reached', 'Ulaşılan dalga'], ['site.timeline', 'Zaman çizelgesi'], ['site.kills_table', 'Önlemeler'], ['site.col_t', 'Zaman'], ['site.col_model', 'Hedef'],
  ['site.col_dist', 'İstasyona'], ['site.col_ttk', 'Önleme süresi'], ['site.col_ic', 'Interceptor'], ['site.no_kills', 'Önleme yok'], ['site.seed_l', 'Tohum {s} · {d}'],
  ['site.continue', 'Devam'], ['site.report_btn', 'Rapor'], ['site.reason_station', 'istasyon yok edildi'], ['site.reason_all', 'tüm tehditler çözüldü'],
  ['site.rk_colonel', 'Albay'], ['site.rk_major', 'Binbaşı'], ['site.rk_captain', 'Yüzbaşı'], ['site.rk_lieutenant', 'Teğmen'], ['site.rk_sergeant', 'Çavuş'], ['site.rk_corporal', 'Onbaşı'], ['site.rk_private', 'Er'],
  ['site.from_mission', 'Görev kaydından: {name} — tohum ve dalgalar kayıtta sabit'], ['site.step', 'Yer kontrol'],
  ['site.err_radar', 'Radar menzili {a}–{b} km olmalı'], ['site.err_eo', 'EO menzili {a}–{b} km olmalı'],
];
const TXT = Object.fromEntries(SITE_TEXTS);
const fill = (s, p) => (p ? String(s).replace(/\{(\w+)\}/g, (m, k) => (p[k] != null ? String(p[k]) : m)) : String(s));
/** Çevirmen: HEPGO (keyed=false) Türkçe metni sözlük anahtarı olarak verir; SIMUMAV (keyed=true) `site.*` anahtarını, yoksa Türkçe metne düşer. */
export const makeSiteT = (tr, keyed = false) => (k, p) => {
  const tx = TXT[k] ?? k;
  if (!tr) return fill(tx, p);
  if (!keyed) return tr(tx, p);
  const r = tr(k, p);
  return r && r !== k ? r : fill(tx, p);
};

function el(tag, attrs, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') e.className = v; else if (k === 'style' && typeof v === 'object') Object.assign(e.style, v);
    else if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2), v); else if (k === 'html') e.innerHTML = v; else e.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat(Infinity)) if (c != null && c !== false) e.append(c.nodeType ? c : document.createTextNode(String(c)));
  return e;
}
const editable = t => !!t && (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.isContentEditable);
const lsGet = (k, d) => { try { const v = JSON.parse(localStorage.getItem(k)); return v ?? d; } catch { return d; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* özel kip */ } };
const ICO = {
  radar: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5" opacity=".5"/><path d="M12 12 18.5 5.5"/><circle cx="16" cy="9" r="1.3" fill="currentColor"/></svg>',
  station: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="11" width="15" height="8" rx="1"/><path d="M7 11V5M5 3l2 2 2-2M18 15h3v4h-3"/></svg>',
  eo: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="11" cy="11" r="6"/><circle cx="11" cy="11" r="2.4"/><path d="M11 17v4M7 21h8"/></svg>',
  dice: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="4" y="4" width="16" height="16" rx="3"/><circle cx="9" cy="9" r="1.3" fill="currentColor"/><circle cx="15" cy="15" r="1.3" fill="currentColor"/><circle cx="15" cy="9" r="1.3" fill="currentColor"/><circle cx="9" cy="15" r="1.3" fill="currentColor"/></svg>',
  shield: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 3 4 6v6c0 4.5 3.4 8 8 9 4.6-1 8-4.5 8-9V6z"/><path d="m9 12 2 2 4-4"/></svg>',
};

// ---------- CSS (bir kez) ----------
const CSS = `
.fs-site-wiz{display:flex;flex-direction:column;gap:12px}
.fs-site-wiz .fs-site-cards{display:grid;grid-template-columns:repeat(3,minmax(0,1fr)) 210px;gap:10px;align-items:stretch}
@media (max-width:980px){.fs-site-wiz .fs-site-cards{grid-template-columns:repeat(2,minmax(0,1fr))}}
.fs-site-card{position:relative;display:flex;flex-direction:column;gap:6px;padding:11px 12px;border-radius:12px;border:1.5px solid rgba(127,140,160,.28);background:rgba(127,140,160,.07);cursor:pointer;transition:border-color .15s,background .15s,transform .15s;text-align:left;color:inherit;font:inherit}
.fs-site-card:hover{transform:translateY(-1px);border-color:rgba(34,197,94,.55)}
.fs-site-card.on{border-color:#22c55e;background:rgba(34,197,94,.10);box-shadow:0 0 0 3px rgba(34,197,94,.13)}
.fs-site-card.locked{cursor:default}
.fs-site-card .fs-site-ch{display:flex;align-items:center;gap:8px}
.fs-site-card .fs-site-ico{width:30px;height:30px;border-radius:9px;display:grid;place-items:center;background:rgba(34,197,94,.14);color:#16a34a;flex:none}
.fs-site-card .fs-site-ico svg{width:20px;height:20px}
.fs-site-card b{font-size:13.5px}
.fs-site-card small{opacity:.72;font-size:11.5px;line-height:1.35}
.fs-site-sw{margin-left:auto;white-space:nowrap;flex:none;font:700 10.5px/1 system-ui,sans-serif;letter-spacing:.05em;padding:4px 8px;border-radius:999px;background:rgba(127,140,160,.22)}
.fs-site-card.on .fs-site-sw{background:#22c55e;color:#04210f}
.fs-site-rng{display:flex;align-items:center;gap:8px;font-size:12px}
.fs-site-rng input[type=range]{flex:1;min-width:0;accent-color:#22c55e}
.fs-site-rng .fs-site-num{width:62px;padding:3px 5px;border-radius:7px;border:1px solid rgba(127,140,160,.35);background:transparent;color:inherit;font:600 12px ui-monospace,monospace;text-align:right}
.fs-site-schem{border-radius:12px;border:1.5px dashed rgba(127,140,160,.3);padding:6px;display:flex;flex-direction:column;align-items:center;gap:2px;font-size:11px;opacity:.95}
.fs-site-schem canvas{width:196px;height:150px}
.fs-site-scn{display:grid;grid-template-columns:1fr 1fr;gap:10px}
.fs-site-scn .fs-site-card.dis{opacity:.5;cursor:not-allowed}
.fs-site-def{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px 14px;padding:10px 12px;border-radius:12px;background:rgba(239,68,68,.06);border:1px solid rgba(239,68,68,.22)}
@media (max-width:860px){.fs-site-def{grid-template-columns:1fr 1fr}}
.fs-site-def label{display:flex;flex-direction:column;gap:4px;font-size:12px}
.fs-site-def .fs-site-seg{display:flex;gap:4px}
.fs-site-def .fs-site-seg button{flex:1;padding:5px 6px;border-radius:8px;border:1px solid rgba(127,140,160,.35);background:transparent;color:inherit;font:600 12px system-ui,sans-serif;cursor:pointer}
.fs-site-def .fs-site-seg button.on{background:#ef4444;border-color:#ef4444;color:#fff}
.fs-site-def .fs-site-seed{display:flex;gap:6px}
.fs-site-def .fs-site-seed input{flex:1;min-width:0;padding:4px 6px;border-radius:7px;border:1px solid rgba(127,140,160,.35);background:transparent;color:inherit;font:600 12px ui-monospace,monospace}
.fs-site-def .fs-site-seed button{padding:3px 9px;border-radius:7px;border:1px solid rgba(127,140,160,.35);background:transparent;color:inherit;cursor:pointer}
.fs-site-err{color:#ef4444;font-size:12px}
.fs-site-note{font-size:11.5px;opacity:.75}
/* uçuş: sol alt dok */
.fs-site-dock{position:absolute;left:12px;bottom:calc(var(--fs-bar-h, 54px) + 10px);z-index:6;display:grid;grid-template-columns:max-content;gap:6px;pointer-events:none;max-width:calc(100% - 24px)}
.fs-site-dock[hidden]{display:none}
.fs-site-striph{min-width:100%;width:0}
.fs-site-striph:empty{display:none}
.fs-stage.rc-on .fs-site-dock{bottom:calc(var(--fs-bar-h, 54px) + 176px)}
.fs-site-row{display:flex;gap:8px;align-items:flex-end}
.fs-site-scr{pointer-events:auto;border-radius:10px;overflow:hidden;border:1px solid rgba(90,255,170,.32);box-shadow:0 10px 30px rgba(0,0,0,.5),inset 0 0 0 1px rgba(0,0,0,.4);background:transparent}
.fs-site-scr.eo{border-color:rgba(140,200,255,.35)}
.fs-site-hd{display:flex;align-items:center;gap:6px;height:24px;padding:0 4px 0 9px;font:700 10.5px/1 ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.08em;color:#a6ffd4;background:linear-gradient(180deg,rgba(16,44,34,.95),rgba(8,24,18,.95));border-bottom:1px solid rgba(90,255,170,.22);white-space:nowrap}
.fs-site-scr.eo .fs-site-hd{color:#cfe6ff;background:linear-gradient(180deg,rgba(18,30,46,.95),rgba(10,18,30,.95));border-bottom-color:rgba(140,200,255,.22)}
.fs-site-hd .fs-site-hdt{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis}
.fs-site-hd .fs-site-hdx{display:flex;gap:3px;flex:none}
.fs-site-hd .fs-site-hico{display:inline-grid;place-items:center;width:14px;height:14px;flex:none}
.fs-site-hd .fs-site-hico svg{width:14px;height:14px}
.fs-site-hd button{height:18px;min-width:20px;padding:0 6px;border-radius:5px;border:1px solid rgba(255,255,255,.16);background:rgba(255,255,255,.06);color:inherit;font:700 10px/16px ui-monospace,monospace;cursor:pointer}
.fs-site-hd button:hover{background:rgba(255,255,255,.16)}
.fs-site-hd button.on{background:rgba(90,255,170,.22);border-color:rgba(90,255,170,.5)}
.fs-site-bd{position:relative;cursor:crosshair}
.fs-site-bd canvas{position:absolute;inset:0;width:100%;height:100%;display:block}
.fs-site-btn{display:inline-flex;align-items:center;gap:5px}
.fs-site-bico{display:inline-grid;place-items:center;width:15px;height:15px}
.fs-site-bico svg{width:15px;height:15px}
.fs-site-strip{pointer-events:auto;display:flex;flex-wrap:wrap;align-items:center;gap:6px 12px;padding:7px 10px;border-radius:10px;background:linear-gradient(180deg,rgba(40,10,10,.88),rgba(20,8,8,.88));border:1px solid rgba(255,90,70,.4);color:#ffe6e1;font:600 11.5px/1.2 ui-monospace,SFMono-Regular,Menlo,monospace;box-shadow:0 10px 28px rgba(0,0,0,.45)}
.fs-site-strip .fs-st-t{font-weight:800;letter-spacing:.1em;color:#ff8a70;display:flex;align-items:center;gap:6px}
.fs-site-strip .fs-st-t svg{width:15px;height:15px}
.fs-site-strip .fs-st-w b{color:#fff}
.fs-site-strip .fs-st-hp{display:flex;align-items:center;gap:6px}
.fs-site-strip .fs-st-bar{width:86px;height:8px;border-radius:5px;background:rgba(255,255,255,.12);overflow:hidden}
.fs-site-strip .fs-st-bar i{display:block;height:100%;background:linear-gradient(90deg,#22c55e,#84cc16);transition:width .4s}
.fs-site-strip .fs-st-bar.mid i{background:linear-gradient(90deg,#f59e0b,#fbbf24)}
.fs-site-strip .fs-st-bar.low i{background:linear-gradient(90deg,#dc2626,#ef4444)}
.fs-site-strip .fs-st-ic{display:flex;align-items:center;gap:3px}
.fs-site-strip .fs-st-ic i{width:6px;height:13px;border-radius:2px;background:#4ade80;box-shadow:0 0 4px rgba(74,222,128,.6)}
.fs-site-strip .fs-st-ic i.used{background:rgba(255,255,255,.18);box-shadow:none}
.fs-site-strip .fs-st-ic i.act{background:#38e8ff;box-shadow:0 0 6px #38e8ff}
.fs-site-strip .fs-st-ic i.down{background:#ef4444;box-shadow:0 0 6px #ef4444}
.fs-site-strip .fs-st-k{color:#86efac}.fs-site-strip .fs-st-l{color:#fca5a5}.fs-site-strip .fs-st-a{color:#fde68a}
.fs-site-strip button.fs-st-next{margin-left:auto;padding:4px 10px;border-radius:7px;border:1px solid rgba(56,232,255,.55);background:rgba(56,232,255,.12);color:#bff6ff;font:700 11px ui-monospace,monospace;cursor:pointer}
.fs-site-strip button.fs-st-next.hot{background:#0891b2;color:#fff;animation:fsStPulse 1s infinite}
@keyframes fsStPulse{50%{box-shadow:0 0 0 4px rgba(56,232,255,.35)}}
.fs-def-banner{position:absolute;left:50%;top:21%;transform:translate(-50%,0);z-index:9;pointer-events:none;text-align:center;font:900 30px/1.1 system-ui,-apple-system,"Segoe UI",sans-serif;letter-spacing:.14em;color:#fff;text-shadow:0 2px 0 rgba(0,0,0,.6),0 0 24px rgba(0,0,0,.7);opacity:0;transition:opacity .25s}
.fs-def-banner small{display:block;font:700 13px/1.4 ui-monospace,monospace;letter-spacing:.08em;margin-top:6px;opacity:.9}
.fs-def-banner.show{opacity:1}
.fs-def-banner.kill{color:#86efac}.fs-def-banner.leak,.fs-def-banner.fail,.fs-def-banner.down{color:#ff6b57}.fs-def-banner.wave{color:#ffd166}.fs-def-banner.success{color:#4ade80}.fs-def-banner.next{color:#7ee8ff}
.sm-fly-stage.fs-site-on:not(.fs-fpv) .fs-net{bottom:calc(var(--fs-site-top, 260px) + 8px)}
.fs-stage.fs-site-on .fs-mp{bottom:calc(var(--fs-site-top, 260px) + 8px)}
.fs-stage.fs-site-on .fs-attrib.fs-attrib-g3d{bottom:calc(var(--fs-site-top, 260px) + 8px);left:auto;right:12px}
.fs-stage.fs-site-on:not(.fs-ops) .fs-gauges{left:calc((100% + var(--fs-site-r, 0px)) / 2);transform:translateX(-50%) scale(.8)}
.fs-stage.fs-site-on.fs-ops:not(.fs-fpv) .fs-gauges{left:calc((100% + var(--fs-site-r, 0px) - 412px) / 2);transform:translateX(-50%) scale(.68)}
.fs-stage.fs-site-on .fs-events{left:calc((100% + var(--fs-site-r, 0px)) / 2);width:min(520px,calc(100% - var(--fs-site-r, 0px) - 24px))}
@media (max-width:760px){.fs-site-dock .fs-site-row{flex-direction:column;align-items:flex-start}}
/* rapor */
.fs-def-rp{display:flex;flex-direction:column;gap:12px}
.fs-def-rp .fs-dr-head{display:flex;align-items:center;gap:14px;padding:12px 14px;border-radius:12px;background:linear-gradient(135deg,rgba(34,197,94,.14),rgba(34,197,94,.04));border:1px solid rgba(34,197,94,.35)}
.fs-def-rp .fs-dr-head.fail{background:linear-gradient(135deg,rgba(239,68,68,.16),rgba(239,68,68,.04));border-color:rgba(239,68,68,.4)}
.fs-def-rp .fs-dr-res{font:900 22px/1 system-ui,sans-serif;letter-spacing:.12em;color:#16a34a}
.fs-def-rp .fs-dr-head.fail .fs-dr-res{color:#dc2626}
.fs-def-rp .fs-dr-sub{font-size:12px;opacity:.75;margin-top:4px}
.fs-def-rp .fs-dr-score{margin-left:auto;text-align:right}
.fs-def-rp .fs-dr-score b{font:900 30px/1 ui-monospace,monospace}
.fs-def-rp .fs-dr-rank{display:flex;align-items:center;gap:8px}
.fs-def-rp .fs-dr-rank svg{width:40px;height:40px}
.fs-def-rp .fs-dr-tiles{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px}
@media (max-width:700px){.fs-def-rp .fs-dr-tiles{grid-template-columns:repeat(2,minmax(0,1fr))}}
.fs-def-rp .fs-dr-tile{padding:8px 10px;border-radius:10px;background:rgba(127,140,160,.09);border:1px solid rgba(127,140,160,.2)}
.fs-def-rp .fs-dr-tile span{display:block;font-size:11px;opacity:.7}
.fs-def-rp .fs-dr-tile b{font:800 17px/1.3 ui-monospace,monospace}
.fs-def-rp .fs-dr-tile.good b{color:#16a34a}.fs-def-rp .fs-dr-tile.bad b{color:#dc2626}
.fs-def-rp canvas.fs-dr-tl{width:100%;height:130px;border-radius:10px;background:rgba(127,140,160,.07)}
.fs-def-rp table{width:100%;border-collapse:collapse;font-size:12px}
.fs-def-rp th,.fs-def-rp td{padding:4px 6px;border-bottom:1px solid rgba(127,140,160,.18);text-align:left}
.fs-def-rp td.m{font-family:ui-monospace,monospace}
.fs-def-rp h4{margin:2px 0 0;font-size:13px}
`;
export function ensureSiteCss() {
  if (typeof document === 'undefined' || document.getElementById('fs-site-css')) return;
  document.head.append(el('style', { id: 'fs-site-css' }, CSS));
}

// ---------- uçuş öncesi seçim ----------
const SITE_PREF = 'fs.site.wiz';
/** createSiteSection({ tr, keyed, getType, onChange, limits }) → { el, values() → {site, defend}, error(), refresh(), set(v) } */
export function createSiteSection({ tr, keyed = false, getType = () => null, onChange = () => {}, limits = {}, card = true, numberLabel = null, initial = null, missionDefend = null } = {}) {
  ensureSiteCss();
  const T = makeSiteT(tr, keyed);
  const rk = limits.radar_km || RADAR_KM, ek = limits.eo_km || EO_KM, dl = limits.defend?.limits || DEFEND_LIMITS;
  const saved = lsGet(SITE_PREF, {});
  const S = { station: !!saved.station, radar: !!saved.radar, radar_km: Number(saved.radar_km) || limits.radar_km_default || RADAR_KM_DEFAULT, eo: !!saved.eo,
    eo_km: Number(saved.eo_km) || limits.eo_km_default || EO_KM_DEFAULT, scenario: saved.scenario === 'defend' ? 'defend' : 'free',
    defend: { ...DEFEND_DEFAULTS, ...(saved.defend || {}), seed: Number.isInteger(saved.defend?.seed) ? saved.defend.seed : randomSeed() } };
  if (initial?.site) Object.assign(S, { station: !!initial.site.station, radar: !!initial.site.radar, radar_km: Number(initial.site.radar_km) || S.radar_km, eo: !!initial.site.eo, eo_km: Number(initial.site.eo_km) || S.eo_km });
  if (initial && 'defend' in initial) { S.scenario = initial.defend ? 'defend' : 'free'; if (initial.defend) S.defend = { ...S.defend, ...initial.defend }; }
  const fixed = !!missionDefend;   // SIMUMAV: kind='defend' görev kaydı seçili → senaryo kayıttan (burada yalnız saha)
  const isIcept = () => getType() === 'interceptor';
  const save = () => lsSet(SITE_PREF, { station: S.station, radar: S.radar, radar_km: S.radar_km, eo: S.eo, eo_km: S.eo_km, scenario: S.scenario, defend: S.defend });
  const defendOn = () => fixed || (S.scenario === 'defend' && isIcept());
  const emit = () => { save(); drawSchem(); onChange(api.values(), api.error()); };
  const rangeRow = (key, [a, b], step, unit) => {
    const inp = el('input', { type: 'range', min: a, max: b, step, value: S[key] });
    const n = el('input', { class: 'fs-site-num', type: 'number', min: a, max: b, step, value: S[key] });
    const set = v => { const x = Math.min(b, Math.max(a, Number(v) || a)); S[key] = Math.round(x * 100) / 100; inp.value = String(S[key]); n.value = String(S[key]); emit(); };
    inp.addEventListener('input', () => set(inp.value)); n.addEventListener('change', () => set(n.value));
    const row = el('div', { class: 'fs-site-rng', onclick: e => e.stopPropagation() }, inp, n, el('span', null, unit));
    return row;
  };
  const toggleCard = (key, ico, title, desc, extra) => {
    const sw = el('span', { class: 'fs-site-sw' });
    const c = el('div', { class: 'fs-site-card', role: 'switch', tabindex: '0', 'data-key': key },
      el('div', { class: 'fs-site-ch' }, el('span', { class: 'fs-site-ico', html: ICO[ico] }), el('b', null, T(title)), sw), el('small', null, T(desc)), extra || null);
    const flip = () => { if (key === 'station' && defendOn()) return; S[key] = !S[key]; draw(); emit(); };
    c.addEventListener('click', flip); c.addEventListener('keydown', e => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); flip(); } });
    c.__sync = () => { const lock = key === 'station' && defendOn(); const on = S[key] || lock; c.classList.toggle('on', on); c.classList.toggle('locked', lock); c.setAttribute('aria-checked', String(on)); sw.textContent = lock ? T('site.required') : T(on ? 'site.on' : 'site.off'); if (extra) extra.hidden = !on; };
    return c;
  };
  const cRadar = toggleCard('radar', 'radar', 'site.radar', 'site.radar_desc', el('div', null, el('small', null, T('site.coverage')), rangeRow('radar_km', rk, 0.5, 'km')));
  const cStation = toggleCard('station', 'station', 'site.station', 'site.station_desc');
  const cEo = toggleCard('eo', 'eo', 'site.eo', 'site.eo_desc', el('div', null, el('small', null, T('site.zoom_range')), rangeRow('eo_km', ek, 0.5, 'km')));
  const schemCv = el('canvas', { width: 392, height: 300 });
  const schem = el('div', { class: 'fs-site-schem' }, schemCv, el('span', null, T('site.schema')));
  function drawSchem() {
    const g = schemCv.getContext('2d'), W = schemCv.width, H = schemCv.height, L = siteLayout(0), sc = 2.55, ox = 74, oy = 112;
    const P = p => [ox + p.x * sc, oy - p.y * sc];
    const col = getComputedStyle(schem).color || '#888';
    g.clearRect(0, 0, W, H);
    g.save();
    // pist (kuzey-güney) + kalkış noktası
    g.fillStyle = col; g.globalAlpha = 0.16; g.fillRect(ox - 13, 0, 26, H); g.globalAlpha = 0.5;
    g.setLineDash([10, 10]); g.strokeStyle = col; g.lineWidth = 2; g.beginPath(); g.moveTo(ox, 4); g.lineTo(ox, H - 4); g.stroke(); g.setLineDash([]); g.globalAlpha = 1;
    const dot = (p, r, c) => { const [x, y] = P(p); g.fillStyle = c; g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill(); return [x, y]; };
    const lbl = (s, x, y, al = 'left') => { g.font = '600 17px system-ui,sans-serif'; g.textAlign = al; g.fillStyle = col; g.fillText(s, x, y); };
    const [px, py] = dot({ x: 0, y: 0 }, 9, '#f59e0b'); lbl(T('site.pad'), px - 16, py + 6, 'right');
    const towerOn = S.radar || S.eo, stOn = S.station || defendOn();
    if (towerOn) {
      const [tx, ty] = P(L.tower);
      if (S.radar) { g.strokeStyle = '#22c55e'; g.lineWidth = 2.5; g.setLineDash([7, 6]); for (const r of [34, 58]) { g.beginPath(); g.arc(tx, ty, r, 0, Math.PI * 2); g.stroke(); } g.setLineDash([]); }
      if (S.eo) { g.strokeStyle = '#38bdf8'; g.lineWidth = 2.5; g.beginPath(); g.moveTo(tx, ty); g.arc(tx, ty, 46, -Math.PI * 0.75, -Math.PI * 0.45); g.closePath(); g.stroke(); }
      g.fillStyle = '#16a34a'; g.fillRect(tx - 8, ty - 8, 16, 16); lbl(T('site.tower'), tx, ty + 30, 'center');
    }
    if (stOn) { const [sx, sy] = P(L.station); g.fillStyle = '#64748b'; g.fillRect(sx - 9, sy - 16, 18, 32); lbl(T('site.station_short'), sx - 14, sy + 6, 'right'); }
    if (defendOn()) { const [rx, ry] = P(L.rack); g.fillStyle = '#38bdf8'; for (let k = 0; k < 5; k++) for (let j = 0; j < 2; j++) g.fillRect(rx - 7 + j * 9, ry - 14 + k * 6, 6, 4); lbl(T('site.rack'), rx + 16, ry + 4); }
    // açıklama
    let ly = 24;
    g.font = '700 16px system-ui,sans-serif'; g.textAlign = 'left';
    if (S.radar) { g.fillStyle = '#22c55e'; g.fillText(`◌ ${T('site.radar')} ${S.radar_km} km`, W - 170, ly); ly += 22; }
    if (S.eo) { g.fillStyle = '#38bdf8'; g.fillText(`◔ EO ${S.eo_km} km`, W - 170, ly); ly += 22; }
    g.fillStyle = col; g.font = '800 18px system-ui'; g.textAlign = 'center'; g.fillText('N', 22, 24); g.lineWidth = 2; g.strokeStyle = col; g.beginPath(); g.moveTo(22, 32); g.lineTo(22, 58); g.moveTo(16, 40); g.lineTo(22, 32); g.lineTo(28, 40); g.stroke();
    g.restore();
  }
  // senaryo
  const scFree = el('div', { class: 'fs-site-card', tabindex: '0' }, el('div', { class: 'fs-site-ch' }, el('span', { class: 'fs-site-ico', html: ICO.radar }), el('b', null, T('site.free'))), el('small', null, T('site.free_desc')));
  const scDef = el('div', { class: 'fs-site-card', tabindex: '0' }, el('div', { class: 'fs-site-ch' }, el('span', { class: 'fs-site-ico', html: ICO.shield, style: { background: 'rgba(239,68,68,.14)', color: '#dc2626' } }), el('b', null, T('site.defend'))),
    el('small', null, T('site.defend_desc')), el('small', { class: 'fs-site-only' }, T('site.defend_only')));
  scFree.addEventListener('click', () => { S.scenario = 'free'; draw(); emit(); });
  scDef.addEventListener('click', () => { if (!isIcept()) return; S.scenario = 'defend'; draw(); emit(); });
  // görev parametreleri
  const num = (key, [a, b], step, unit) => {
    const n = el('input', { class: 'fs-site-num', type: 'number', min: a, max: b, step, value: S.defend[key] });
    const r = el('input', { type: 'range', min: a, max: b, step, value: S.defend[key] });
    const set = v => { let x = Math.min(b, Math.max(a, Number(v) || a)); if (step >= 1) x = Math.round(x); S.defend[key] = x; n.value = String(x); r.value = String(x); emit(); };
    n.addEventListener('change', () => set(n.value)); r.addEventListener('input', () => set(r.value));
    return el('div', { class: 'fs-site-rng' }, r, n, unit ? el('span', null, unit) : null);
  };
  const diffBtns = DIFFICULTIES.map(d => el('button', { type: 'button', 'data-d': d, onclick: () => { S.defend.difficulty = d; draw(); emit(); } }, T(`site.d_${d}`)));
  const seedInp = el('input', { type: 'number', min: 0, max: 2147483647, step: 1, value: S.defend.seed });
  seedInp.addEventListener('change', () => { const v = Math.round(Number(seedInp.value)); S.defend.seed = Number.isInteger(v) && v >= 0 && v <= 2147483647 ? v : randomSeed(); seedInp.value = String(S.defend.seed); emit(); });
  const defBox = el('div', { class: 'fs-site-def' },
    el('label', null, T('site.difficulty'), el('div', { class: 'fs-site-seg' }, diffBtns)),
    el('label', null, T('site.waves'), num('waves', dl.waves, 1)),
    el('label', null, T('site.interceptors'), num('interceptors', dl.interceptors, 1)),
    el('label', null, T('site.radius'), num('radius_m', dl.radius_m, 5, 'm')),
    el('label', null, T('site.prep'), num('prep_s', dl.prep_s, 5, 's')),
    el('label', { title: T('site.seed_hint') }, T('site.seed'), el('div', { class: 'fs-site-seed' }, seedInp, el('button', { type: 'button', title: T('site.new_seed'), html: ICO.dice, onclick: () => { S.defend.seed = randomSeed(); seedInp.value = String(S.defend.seed); emit(); } }))));
  const errEl = el('div', { class: 'fs-site-err', hidden: true });
  const scnBox = el('div', { class: 'fs-site-scn' }, scFree, scDef);
  const fixedNote = fixed ? el('div', { class: 'fs-site-def fs-site-fixed' }, el('label', null, el('b', null, '◈ ', T('site.defend')), el('span', null, T('site.from_mission', { name: missionDefend })))) : null;
  const body = el('div', { class: 'fs-site-wiz' },
    el('p', { class: 'small muted fs-site-note' }, T('site.desc')),
    el('div', { class: 'fs-site-cards' }, cRadar, cStation, cEo, schem),
    el('h4', { class: 'fs-sub-h' }, T('site.scenario')),
    fixed ? fixedNote : scnBox, fixed ? null : defBox, errEl);
  const root = card ? el('div', { class: 'card card-pad fs-step no-collapse fs-site-step' }, el('h3', null, numberLabel ? el('span', { class: 'fs-no' }, numberLabel) : null, '◈ ', T('site.title'), el('small', { class: 'muted', style: { fontWeight: 400, marginLeft: '6px' } }, `(${T('site.optional')})`)), body) : body;
  function draw() {
    [cRadar, cStation, cEo].forEach(c => c.__sync());
    const ic = isIcept();
    if (!ic && S.scenario === 'defend') S.scenario = 'free';
    scFree.classList.toggle('on', S.scenario === 'free'); scDef.classList.toggle('on', S.scenario === 'defend'); scDef.classList.toggle('dis', !ic);
    scDef.querySelector('.fs-site-only').hidden = ic;
    defBox.hidden = fixed || S.scenario !== 'defend';
    diffBtns.forEach(b => b.classList.toggle('on', b.dataset.d === S.defend.difficulty));
    const e = api.error(); errEl.hidden = !e; errEl.textContent = e || '';
    drawSchem();
  }
  const api = {
    el: root,
    values() {
      const dOn = defendOn();
      const site = siteBody({ ...S, station: S.station || dOn });
      return { site, defend: dOn && !fixed ? { seed: S.defend.seed, waves: S.defend.waves, interceptors: S.defend.interceptors, difficulty: S.defend.difficulty, radius_m: S.defend.radius_m, prep_s: S.defend.prep_s } : null };
    },
    error() {
      const v = api.values();
      return validateSite(v.site, (s, p) => T(s.startsWith('Radar') ? 'site.err_radar' : 'site.err_eo', p)) || validateDefend(v.defend, getType(), s => s) || (fixed && !isIcept() ? T('site.defend_only') : null);
    },
    refresh() { draw(); onChange(api.values(), api.error()); },
    get state() { return S; },
  };
  draw();
  return api;
}

// ---------- uçuşta: radar + EO ekranları (sol alt dok) ----------
const SCR_PREF = 'fs.site';
const scrSize = W => (W < 900 ? { w: 230, h: 158 } : W < 1280 ? { w: 268, h: 182 } : { w: 304, h: 204 });
/** createSiteScreens(stage, { tr, keyed, getSim, site, mount, onToggle }) → { el, buttons, strip(holder), layout(), sync(), dispose() } */
export function createSiteScreens(stage, { tr, keyed = false, getSim, site, mount, onToggle = () => {}, btnClass = 'btn sm' } = {}) {
  ensureSiteCss();
  const T = makeSiteT(tr, keyed);
  const pref = { radar: true, eo: true, ...lsGet(SCR_PREF, {}) };
  const has = { radar: !!site?.radar, eo: !!site?.eo };
  const mkScreen = (kind) => {
    const title = el('span', { class: 'fs-site-hdt' }, '');
    const extra = el('span', { class: 'fs-site-hdx' });
    const close = el('button', { type: 'button', title: T('site.close'), onclick: () => toggle(kind, false) }, '×');
    const cv = el('canvas');
    const body = el('div', { class: 'fs-site-bd' }, cv);
    const box = el('div', { class: `fs-site-scr ${kind}` }, el('div', { class: 'fs-site-hd' }, el('span', { class: 'fs-site-hico', html: ICO[kind === 'radar' ? 'radar' : 'eo'] }), title, extra, close), body);
    return { box, body, cv, title, extra };
  };
  const R = mkScreen('radar'), E = mkScreen('eo');
  // radar menzil düğmeleri: − / OTO / +
  let fixedKm = null;
  const steps = () => radarSteps(site?.radar_km || RADAR_KM_DEFAULT);
  const rDn = el('button', { type: 'button', title: T('site.range_dn'), onclick: e => { e.stopPropagation(); stepRange(-1); } }, '−');
  const rAuto = el('button', { type: 'button', class: 'on', title: T('site.range_auto'), onclick: e => { e.stopPropagation(); fixedKm = null; getSim()?.setRadarRange(null); syncBtns(); } }, T('site.auto'));
  const rUp = el('button', { type: 'button', title: T('site.range_up'), onclick: e => { e.stopPropagation(); stepRange(1); } }, '+');
  R.extra.append(rDn, rAuto, rUp);
  const stepRange = d => {
    const st = steps(), cur = fixedKm ?? ((getSim()?.radarInfo()?.range_m || st[0] * 1000) / 1000);
    let k = st.findIndex(s => s >= cur - 1e-6); if (k < 0) k = st.length - 1;
    fixedKm = st[Math.max(0, Math.min(st.length - 1, k + d))];
    getSim()?.setRadarRange(fixedKm); syncBtns();
  };
  const syncBtns = () => { rAuto.classList.toggle('on', fixedKm == null); };
  // EO tür düğmesi
  const EO_TYPES = ['day', 'thermal', 'night'];
  const eoBtn = el('button', { type: 'button', title: T('site.eo_type'), onclick: e => { e.stopPropagation(); const s = getSim(); if (!s) return; const t = EO_TYPES[(EO_TYPES.indexOf(s.getEoType()) + 1) % 3]; s.setEoType(t); lsSet(SCR_PREF, { ...lsGet(SCR_PREF, {}), eoType: t }); } }, '◐');
  E.extra.append(eoBtn);
  const row = el('div', { class: 'fs-site-row' }, has.radar ? R.box : null, has.eo ? E.box : null);
  const stripHolder = el('div', { class: 'fs-site-striph' });
  const dock = el('div', { class: 'fs-site-dock' }, stripHolder, row);
  stage.append(dock);
  // alt çubuk düğmeleri
  const bIco = k => el('span', { class: 'fs-site-bico', html: ICO[k] });
  const bRadar = has.radar ? el('button', { class: `${btnClass} fs-site-btn`, type: 'button', title: T('site.radar_title'), onclick: () => toggle('radar') }, bIco('radar'), T('site.radar_btn')) : null;
  const bEo = has.eo ? el('button', { class: `${btnClass} fs-site-btn`, type: 'button', title: T('site.eo_title'), onclick: () => toggle('eo') }, bIco('eo'), T('site.eo_btn')) : null;
  function toggle(kind, v) {
    if (!has[kind]) return;
    pref[kind] = v == null ? !pref[kind] : !!v;
    lsSet(SCR_PREF, { ...lsGet(SCR_PREF, {}), radar: pref.radar, eo: pref.eo });
    layout(); onToggle(kind, pref[kind]);
  }
  const rectOf = body => { const m = (mount || stage).getBoundingClientRect(), r = body.getBoundingClientRect(); return { x: r.left - m.left, y: r.top - m.top, w: r.width, h: r.height }; };
  let lastKey = '';
  const varKey = { r: '', t: '' };
  function layout() {
    const W = stage.clientWidth || 1200, sz = scrSize(W);
    for (const [k, s] of [['radar', R], ['eo', E]]) {
      s.box.hidden = !(has[k] && pref[k]);
      s.box.style.width = `${sz.w}px`; s.body.style.height = `${sz.h}px`;
    }
    bRadar?.classList.toggle('primary', !!pref.radar); bEo?.classList.toggle('primary', !!pref.eo);
    const anyScr = (has.radar && pref.radar) || (has.eo && pref.eo), anyStrip = !!stripHolder.firstChild;
    dock.hidden = !(anyScr || anyStrip);
    stage.classList.toggle('fs-site-on', !dock.hidden);
    sync();
  }
  // dikdörtgenler 3B'ye (her tikte; çubuk sarınca / pencere boyutu değişince yerinde kalsın)
  function sync() {
    const s = getSim();
    const rv = !dock.hidden && !R.box.hidden && has.radar, evv = !dock.hidden && !E.box.hidden && has.eo;
    const rr = rv ? rectOf(R.body) : null, er = evv ? rectOf(E.body) : null;
    const key = JSON.stringify([rr, er]);
    if (s && key !== lastKey) { lastKey = key; s.setRadarRect?.(rr); s.setEoRect?.(er); }
    if (!dock.hidden) {
      const m = (mount || stage).getBoundingClientRect(), d = dock.getBoundingClientRect();
      const vr = `${Math.round(d.right - m.left + 12)}px`, vt = `${Math.round(m.bottom - d.top)}px`;
      if (vr !== varKey.r || vt !== varKey.t) {   // kadranlar / MP kutusu kaydı → PiP yeniden yerleşsin
        varKey.r = vr; varKey.t = vt;
        stage.style.setProperty('--fs-site-r', vr); stage.style.setProperty('--fs-site-top', vt);
        requestAnimationFrame(() => onToggle('layout', true));
      }
    }
  }
  // radar tıklaması → hedef kilidi (EO izler)
  R.body.addEventListener('click', e => {
    const s = getSim(); if (!s) return;
    const b = R.body.getBoundingClientRect(), i = s.radarPick(e.clientX - b.left, e.clientY - b.top);
    s.lockTarget(i);
    drawRadar();
  });
  const fitCv = (cv, body) => { const dpr = Math.min(devicePixelRatio || 1, 2), w = Math.round(body.clientWidth * dpr), hh = Math.round(body.clientHeight * dpr); if (cv.width !== w || cv.height !== hh) { cv.width = w; cv.height = hh; } return dpr; };
  const txt = (g, s, x, y, { c = '#c8ffe2', px = 10, al = 'left', bold = true, bg = false } = {}) => {
    g.font = `${bold ? 700 : 500} ${px}px ui-monospace,SFMono-Regular,Menlo,monospace`; g.textAlign = al; g.textBaseline = 'middle';
    if (bg) { const w = g.measureText(s).width; g.fillStyle = 'rgba(0,0,0,.55)'; g.fillRect(al === 'left' ? x - 2 : al === 'right' ? x - w - 2 : x - w / 2 - 2, y - px * 0.62, w + 4, px * 1.24); }
    g.lineWidth = 3; g.strokeStyle = 'rgba(0,0,0,.75)'; g.strokeText(s, x, y); g.fillStyle = c; g.fillText(s, x, y);
  };
  function drawRadar() {
    if (R.box.hidden || !has.radar) return;
    const s = getSim(), info = s?.radarInfo?.(), dpr = fitCv(R.cv, R.body), g = R.cv.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, R.cv.width, R.cv.height);
    const W = R.body.clientWidth, H = R.body.clientHeight;
    R.title.textContent = `${T('site.scr_radar')} · ${T('site.cov')} ${site.radar_km} km${info ? ` · ${T('site.view')} ${fmtKm(info.range_m)}` : ''}`;
    if (!info) { g.fillStyle = 'rgba(6,18,14,.85)'; g.fillRect(0, 0, W, H); txt(g, T('site.radar_wait'), W / 2, H / 2, { al: 'center', px: 11 }); return; }
    for (const r of info.rings) if (r.m <= info.range_m * 1.02 && r.y > 6 && r.y < H - 4) txt(g, fmtKm(r.m), r.x + 3, r.y - 7, { px: 9, c: 'rgba(170,255,210,.85)', bold: false });
    if (info.north && info.north.y > 8) txt(g, 'N', info.north.x, info.north.y - 8, { px: 11, c: '#eafff3', al: 'center' });
    if (info.tower) { g.fillStyle = '#eafff3'; g.fillRect(info.tower.x - 3, info.tower.y - 3, 6, 6); }
    for (const it of info.items) {
      if (it.x < -10 || it.x > W + 10 || it.y < -10 || it.y > H + 10) continue;
      const c = it.sel ? '#ffe14a' : it.kind === 'threat' ? '#ffb4a8' : '#ffd2a0';
      txt(g, `${it.i + 1}`, it.x + 10, it.y - 7, { c, px: it.sel ? 11 : 10 });
      txt(g, `${it.alt}m`, it.x + 10, it.y + 5, { c: 'rgba(230,255,240,.75)', px: 8.5, bold: false });
      if (it.sel) txt(g, it.name || '', it.x + 10, it.y + 16, { c, px: 9 });
    }
    if (info.own) txt(g, T('site.own'), info.own.x + 10, info.own.y - 6, { c: '#9ff3ff', px: 9 });
    const n = info.items.length, sel = info.items.find(i => i.sel);
    txt(g, n ? T('site.targets_n', { n }) : T('site.no_contact'), 6, H - 9, { px: 9.5, c: n ? '#ffd0c6' : 'rgba(170,255,210,.8)', bg: true });
    txt(g, sel ? `◎ ${sel.i + 1} · ${fmtKm(sel.dist)}` : T('site.click_pick'), W - 6, H - 9, { px: 9.5, al: 'right', c: sel ? '#ffe14a' : 'rgba(170,255,210,.7)', bg: true });
    txt(g, `${String(Math.round(info.sweep)).padStart(3, '0')}°`, W - 6, 9, { px: 9, al: 'right', c: 'rgba(170,255,210,.8)' });
  }
  let noiseAt = 0;
  function drawEo() {
    if (E.box.hidden || !has.eo) return;
    const s = getSim(), info = s?.eoInfo?.(), dpr = fitCv(E.cv, E.body), g = E.cv.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, E.cv.width, E.cv.height);
    const W = E.body.clientWidth, H = E.body.clientHeight, cx = W / 2, cy = H / 2;
    const typ = info?.type || 'day';
    E.title.textContent = `${T('site.scr_eo')} · ${T(`site.${typ}`)}${info && info.status === 'track' ? ` · ×${info.zoom.toFixed(info.zoom >= 10 ? 0 : 1)}` : ''}`;
    const C = typ === 'night' ? '#b6ffb0' : '#eaf6ff';
    // köşe parantezleri
    g.strokeStyle = C; g.globalAlpha = 0.85; g.lineWidth = 1.5;
    for (const [x, y, dx, dy] of [[8, 8, 1, 1], [W - 8, 8, -1, 1], [8, H - 8, 1, -1], [W - 8, H - 8, -1, -1]]) { g.beginPath(); g.moveTo(x, y + dy * 12); g.lineTo(x, y); g.lineTo(x + dx * 12, y); g.stroke(); }
    // nişangâh
    g.beginPath(); g.moveTo(cx - 22, cy); g.lineTo(cx - 7, cy); g.moveTo(cx + 7, cy); g.lineTo(cx + 22, cy); g.moveTo(cx, cy - 16); g.lineTo(cx, cy - 6); g.moveTo(cx, cy + 6); g.lineTo(cx, cy + 16); g.stroke();
    g.globalAlpha = 1;
    if (!info) return;
    if (info.status === 'track' && !info.slewing) {
      const b = Math.min(W, H) * 0.2;
      g.strokeStyle = '#ffe14a'; g.lineWidth = 1.6;
      for (const [sx, sy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) { g.beginPath(); g.moveTo(cx + sx * b, cy + sy * (b - 7)); g.lineTo(cx + sx * b, cy + sy * b); g.lineTo(cx + sx * (b - 7), cy + sy * b); g.stroke(); }
      txt(g, `${T('site.eo_track')} · ${info.sel + 1} ${info.name || ''}`.slice(0, 34), 8, 20, { c: '#ffe14a', px: 9.5 });
    } else if (info.status === 'track' && info.slewing) {
      if ((performance.now() / 300 | 0) % 2) txt(g, T('site.eo_slew'), cx, cy - 30, { al: 'center', c: '#ffe14a', px: 11 });
    } else if (info.status === 'out') {
      const now = performance.now();
      if (now - noiseAt > 0) { noiseAt = now; g.fillStyle = 'rgba(255,255,255,.18)'; for (let k = 0; k < 260; k++) g.fillRect(Math.random() * W, Math.random() * H, 1.4, 1.4); }
      txt(g, T('site.eo_out'), cx, cy - 26, { al: 'center', c: '#ff8a70', px: 13 });
      txt(g, `${fmtKm(info.range_m)} > ${info.eo_km} km`, cx, cy + 28, { al: 'center', c: '#ffc2b5', px: 10 });
    } else {
      txt(g, T('site.eo_idle'), cx, cy - 28, { al: 'center', c: C, px: 11 });
      txt(g, T('site.eo_idle_hint'), cx, cy + 28, { al: 'center', c: 'rgba(230,240,255,.8)', px: 9, bold: false });
    }
    const lines = `${T('site.az')} ${info.az.toFixed(1).padStart(5, '0')}°  ${T('site.el')} ${info.el >= 0 ? '+' : ''}${info.el.toFixed(1)}°  ${T('site.rng')} ${info.range_m != null ? fmtKm(info.range_m) : '—'}`;
    txt(g, lines, 8, H - 10, { c: C, px: 9.5, bg: true });
    txt(g, `FOV ${info.fov.toFixed(info.fov < 10 ? 1 : 0)}°`, W - 8, 20, { al: 'right', c: C, px: 9 });
  }
  const onKey = e => {
    if (e.ctrlKey || e.metaKey || e.altKey || editable(document.activeElement)) return;
    const k = (e.key || '').toLowerCase();
    if (k === 'y' && has.radar) { toggle('radar'); e.preventDefault(); } else if (k === 'u' && has.eo) { toggle('eo'); e.preventDefault(); }
  };
  window.addEventListener('keydown', onKey);
  const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(() => layout()) : null;
  ro?.observe(stage);
  const tick = setInterval(() => { sync(); drawRadar(); drawEo(); }, 100);
  const savedType = lsGet(SCR_PREF, {}).eoType;
  let typeApplied = false;
  layout();
  return {
    el: dock, buttons: [bRadar, bEo].filter(Boolean), stripHolder,
    layout, sync, toggle, get prefs() { return { ...pref }; },
    applyPrefs() { if (!typeApplied && savedType && getSim()) { getSim().setEoType(savedType); typeApplied = true; } lastKey = ''; sync(); },
    dispose() { clearInterval(tick); ro?.disconnect(); window.removeEventListener('keydown', onKey); dock.remove(); stage.classList.remove('fs-site-on'); getSim()?.setRadarRect?.(null); getSim()?.setEoRect?.(null); },
  };
}

// ---------- "Yer kontrolünü koru" şeridi + bant ----------
/** createDefendHud({ stage, tr, keyed, defend, getSim, holder, canWrite, onNext, onEnd, onEvent, replay }) → { el, update(state), event(m), dispose() } */
export function createDefendHud({ stage, tr, keyed = false, defend, getSim, holder, canWrite = true, onNext = () => {}, onEnd = () => {}, onEvent = () => {}, onReport = null, replay = false } = {}) {
  ensureSiteCss();
  const T = makeSiteT(tr, keyed);
  const plan = defend?.plan || [];
  let st = { ...(defend?.state || {}) };
  const wave = el('span', { class: 'fs-st-w' }), timer = el('span', { class: 'fs-st-tm' });
  const hpBar = el('span', { class: 'fs-st-bar' }, el('i')), hpTxt = el('b');
  const ic = el('span', { class: 'fs-st-ic' }), icTxt = el('b');
  const kTxt = el('span', { class: 'fs-st-k' }), lTxt = el('span', { class: 'fs-st-l' }), aTxt = el('span', { class: 'fs-st-a' });
  const nextBtn = canWrite && !replay ? el('button', { class: 'fs-st-next', type: 'button', title: T('site.next_title'), onclick: () => doNext() }, '▶ ', T('site.next_btn'), ' (N)') : null;
  const repBtn = onReport ? el('button', { class: 'fs-st-next fs-st-rep', type: 'button', hidden: true, onclick: () => onReport() }, '◈ ', T('site.report_btn')) : null;
  const strip = el('div', { class: 'fs-site-strip' }, el('span', { class: 'fs-st-t', html: `${ICO.shield}` }, T('site.mission')), wave, timer,
    el('span', { class: 'fs-st-hp' }, T('site.health'), hpBar, hpTxt), el('span', { class: 'fs-st-hp' }, T('site.icepts'), ic, icTxt), kTxt, lTxt, aTxt, nextBtn, repBtn);
  holder?.append(strip);
  const banner = el('div', { class: 'fs-def-banner' });
  stage.append(banner);
  let bannerT = 0;
  const show = (cls, text, sub = '', ms = 2600) => { banner.className = `fs-def-banner ${cls} show`; banner.replaceChildren(text, sub ? el('small', null, sub) : ''); clearTimeout(bannerT); bannerT = setTimeout(() => banner.classList.remove('show'), ms); };
  const missionTime = () => { const s = getSim(), t = s?.targetTime; return t == null ? (st.t ?? 0) : t + (Number(st.base) || 0); };
  function render() {
    const W = Number(st.waves) || defend?.config?.waves || 1, wv = Number(st.wave) || 0, t = missionTime();
    wave.replaceChildren(T('site.wave', { w: Math.max(wv, 0), n: W }));
    const nw = nextWave(plan, t);
    timer.textContent = st.ended ? '' : nw ? (wv === 0 ? T('site.prep_left', { t: fmtClock(nw.in_s) }) : T('site.next_wave', { t: fmtClock(nw.in_s) })) : T('site.last_wave');
    const hp = Math.max(0, Number(st.health ?? 100));
    hpBar.firstChild.style.width = `${hp}%`; hpBar.classList.toggle('mid', hp < 60 && hp >= 30); hpBar.classList.toggle('low', hp < 30); hpTxt.textContent = `%${Math.round(hp)}`;
    const I = st.icept || { total: defend?.config?.interceptors || 10, used: 1, lost: 0 };
    ic.replaceChildren(...Array.from({ length: I.total }, (_, k) => el('i', { class: k < I.used - 1 ? 'used' : k === I.used - 1 ? (I.down ? 'down' : 'act') : '' })));
    icTxt.textContent = `${Math.max(0, I.total - I.used)}`;
    const nk = (st.killed || []).length, nl = (st.leaked || []).length, act = Math.max(0, (Number(st.spawned) || 0) - nk - nl);
    kTxt.textContent = `✓ ${T('site.killed')} ${nk}`; lTxt.textContent = `✗ ${T('site.leaked')} ${nl}`; aTxt.textContent = `◎ ${T('site.active')} ${act}`;
    if (repBtn) repBtn.hidden = !st.ended;
    if (nextBtn) { nextBtn.disabled = !!st.ended || I.used >= I.total; nextBtn.classList.toggle('hot', !!I.down && I.used < I.total && !st.ended); }
  }
  async function doNext() {
    if (!canWrite || replay) return;
    const I = st.icept || {};
    if (I.used >= I.total) { show('fail', T('site.none_left'), '', 2200); return; }
    await onNext();
  }
  const onKey = e => {
    if (e.ctrlKey || e.metaKey || e.altKey || editable(document.activeElement)) return;
    if ((e.key || '').toLowerCase() === 'n' && nextBtn) { e.preventDefault(); doNext(); }
  };
  window.addEventListener('keydown', onKey);
  const tick = setInterval(render, 250);
  render();
  const R = k => T(k === 'crash' ? 'site.r_crash' : 'site.r_battery');
  return {
    el: strip,
    update(s) { if (s) { st = { ...st, ...s }; getSim()?.setDefendState?.(s); render(); } },
    // WS `defend` olayı (canlı) / istemci izleyicisi (kayıt)
    event(m) {
      if (m.state) this.update(m.state);
      const s = getSim();
      if (m.kind === 'wave') { show('wave', T('site.b_wave', { w: m.wave, n: m.count })); onEvent(T('site.ev_wave', { w: m.wave, n: m.waves, c: m.count }), 'warning'); }
      else if (m.kind === 'kill') { s?.flashThreat?.(m.k); show('kill', T('site.b_kill'), `${m.name || ''} · ${fmtKm(m.station_m)}`, 1600); onEvent(T('site.ev_kill', { name: m.name, d: fmtKm(m.station_m), s: m.ttk_s }), 'warning'); }
      else if (m.kind === 'leak') { s?.siteHit?.(m.health); show('leak', T('site.b_leak', { d: m.damage }), m.name || ''); onEvent(T('site.ev_leak', { name: m.name, d: m.damage, h: m.health }), 'error'); }
      else if (m.kind === 'down') { show('down', T('site.b_down'), T('site.b_down_sub', { n: m.remaining }), 4000); onEvent(T('site.ev_down', { r: R(m.reason), n: m.remaining }), 'error'); }
      else if (m.kind === 'next') { show('next', T('site.b_next', { n: m.state?.icept?.used ?? '' }), '', 2000); s?.setRackCount?.((m.state?.icept?.total ?? 0) - (m.state?.icept?.used ?? 0)); onEvent(T('site.ev_next', { n: m.state?.icept?.used ?? '' })); }
      else if (m.kind === 'end') { show(m.success ? 'success' : 'fail', T(m.success ? 'site.b_success' : 'site.b_fail'), m.result ? `${m.result.score} · ${T(`site.rk_${m.result.rank}`)}` : '', 5000); onEnd(m.result, m); }
    },
    get state() { return { ...st }; },
    dispose() { clearInterval(tick); clearTimeout(bannerT); window.removeEventListener('keydown', onKey); strip.remove(); banner.remove(); },
  };
}

// ---------- rapor ----------
const RANK_STARS = { private: 0, corporal: 1, sergeant: 2, lieutenant: 3, captain: 4, major: 5, colonel: 6 };
const rankSvg = rank => {
  const n = RANK_STARS[rank] ?? 0, chev = Math.min(3, n), stars = Math.max(0, n - 3);
  let s = '<svg viewBox="0 0 40 40"><rect x="3" y="3" width="34" height="34" rx="8" fill="#1e293b" stroke="#fbbf24" stroke-width="1.5"/>';
  for (let k = 0; k < chev; k++) s += `<path d="M10 ${25 - k * 6}l10-6 10 6" fill="none" stroke="#fbbf24" stroke-width="2.6" stroke-linejoin="round"/>`;
  for (let k = 0; k < stars; k++) { const cx = 20 + (k - (stars - 1) / 2) * 9, cy = n > 3 ? 11 : 20; s += `<path d="M${cx} ${cy - 4}l1.2 2.6 2.8.3-2.1 1.9.6 2.8-2.5-1.4-2.5 1.4.6-2.8-2.1-1.9 2.8-.3z" fill="#fbbf24"/>`; }
  if (!n) s += '<circle cx="20" cy="20" r="4" fill="#fbbf24"/>';
  return `${s}</svg>`;
};
/** Görev sonu başarı raporu gövdesi (DOM). result = sunucu SavunmaGorevi.ozet() (ya da istemci izleyicisi). */
export function defendReportBody(result, { tr, keyed = false, plan = null } = {}) {
  ensureSiteCss();
  const T = makeSiteT(tr, keyed);
  const r = result || {}, cfg = r.config || {};
  const ok = !!r.success, ongoing = !r.ended;
  const pct = v => `%${Math.round((Number(v) || 0) * 100)}`;
  const head = el('div', { class: `fs-dr-head ${ok || ongoing ? '' : 'fail'}` },
    el('div', null, el('div', { class: 'fs-dr-res' }, T(ongoing ? 'site.ongoing' : ok ? 'site.success' : 'site.fail')),
      el('div', { class: 'fs-dr-sub' }, [T('site.seed_l', { s: cfg.seed ?? '—', d: T(`site.d_${cfg.difficulty || 'normal'}`) }), r.ended ? T(r.ended.reason === 'station_destroyed' ? 'site.reason_station' : 'site.reason_all') : null, r.t != null ? fmtClock(r.t) : null].filter(Boolean).join(' · '))),
    el('div', { class: 'fs-dr-rank', title: T('site.rank') }, el('span', { html: rankSvg(r.rank) }), el('b', null, T(`site.rk_${r.rank || 'private'}`))),
    el('div', { class: 'fs-dr-score' }, el('small', null, T('site.score')), el('br'), el('b', null, String(r.score ?? 0))));
  const tile = (label, value, cls = '') => el('div', { class: `fs-dr-tile ${cls}` }, el('span', null, label), el('b', null, value));
  const kills = r.kills || [], leaks = r.leaks || [], ic = r.icept || {};
  const tiles = el('div', { class: 'fs-dr-tiles' },
    tile(T('site.kills_of'), `${kills.length}/${r.spawned ?? 0}`, kills.length ? 'good' : ''),
    tile(T('site.leaks'), String(leaks.length), leaks.length ? 'bad' : 'good'),
    tile(T('site.health_t'), `%${Math.round(r.health ?? 100)}`, (r.health ?? 100) >= 60 ? 'good' : 'bad'),
    tile(T('site.used'), `${ic.used ?? 0}/${ic.total ?? cfg.interceptors ?? 0}`),
    tile(T('site.accuracy'), pct(r.accuracy)),
    tile(T('site.ttk_avg'), r.ttk_avg_s != null ? `${r.ttk_avg_s} s` : '—'),
    tile(T('site.ttk_min'), r.ttk_min_s != null ? `${r.ttk_min_s} s` : '—'),
    tile(T('site.waves_reached'), `${r.waves_reached ?? 0}/${cfg.waves ?? '—'}`));
  // zaman çizelgesi: sağlık basamakları (kırmızı), önlemeler (yeşil ▲), sızmalar (kırmızı ▼), dalga başları (kesikli)
  const cv = el('canvas', { class: 'fs-dr-tl', width: 1120, height: 260 });
  requestAnimationFrame(() => {
    const g = cv.getContext('2d'), W = cv.width, H = cv.height, pad = 34;
    const tEnd = Math.max(60, Number(r.ended?.t ?? r.t) || 0, ...kills.map(k => k.t), ...leaks.map(k => k.t));
    const X = t => pad + (W - 2 * pad) * t / tEnd, Y = hp => H - pad - (H - 2 * pad) * hp / 100;
    g.clearRect(0, 0, W, H);
    g.strokeStyle = 'rgba(127,140,160,.35)'; g.lineWidth = 1; g.font = '600 18px system-ui'; g.fillStyle = 'rgba(127,140,160,.9)';
    for (let k = 0; k <= 4; k++) { const tt = tEnd * k / 4; g.beginPath(); g.moveTo(X(tt), H - pad); g.lineTo(X(tt), pad); g.stroke(); g.fillText(fmtClock(tt), X(tt) - 22, H - 8); }
    if (plan) { const starts = {}; for (const th of plan) if (starts[th.wave] == null || th.spawn_t < starts[th.wave]) starts[th.wave] = th.spawn_t; g.setLineDash([6, 6]); g.strokeStyle = 'rgba(245,158,11,.6)'; for (const [w, t0] of Object.entries(starts)) { if (t0 > tEnd) continue; g.beginPath(); g.moveTo(X(t0), pad - 6); g.lineTo(X(t0), H - pad); g.stroke(); g.fillStyle = '#f59e0b'; g.fillText(`D${Number(w) + 1}`, X(t0) + 4, pad + 4); } g.setLineDash([]); }
    let hp = 100; g.strokeStyle = '#ef4444'; g.lineWidth = 3; g.beginPath(); g.moveTo(X(0), Y(hp));
    for (const l of [...leaks].sort((a, b) => a.t - b.t)) { g.lineTo(X(l.t), Y(hp)); hp = Math.max(0, hp - l.damage); g.lineTo(X(l.t), Y(hp)); }
    g.lineTo(X(tEnd), Y(hp)); g.stroke();
    for (const k of kills) { g.fillStyle = '#22c55e'; g.beginPath(); g.moveTo(X(k.t), pad + 6); g.lineTo(X(k.t) - 8, pad + 20); g.lineTo(X(k.t) + 8, pad + 20); g.closePath(); g.fill(); }
    for (const l of leaks) { g.fillStyle = '#ef4444'; g.beginPath(); g.moveTo(X(l.t), H - pad - 4); g.lineTo(X(l.t) - 8, H - pad - 18); g.lineTo(X(l.t) + 8, H - pad - 18); g.closePath(); g.fill(); }
  });
  const rows = kills.slice(0, 14).map((k, n) => el('tr', null, el('td', { class: 'm' }, String(n + 1)), el('td', { class: 'm' }, fmtClock(k.t)), el('td', null, (plan?.[k.k]?.model_name) || THREAT_MODELS[k.model]?.name || k.model),
    el('td', { class: 'm' }, fmtKm(k.station_m)), el('td', { class: 'm' }, `${k.ttk_s} s`), el('td', { class: 'm' }, `#${k.interceptor}`)));
  const table = kills.length ? el('table', null, el('thead', null, el('tr', null, el('th', null, '#'), el('th', null, T('site.col_t')), el('th', null, T('site.col_model')), el('th', null, T('site.col_dist')), el('th', null, T('site.col_ttk')), el('th', null, T('site.col_ic')))), el('tbody', null, rows))
    : el('p', { class: 'small muted' }, T('site.no_kills'));
  return el('div', { class: 'fs-def-rp' }, head, tiles, el('h4', null, T('site.timeline')), cv, el('h4', null, T('site.kills_table')), table);
}
/** Görev sonu raporu penceresi (modal: HEPGO ui.js / SIMUMAV simui.js aynı imza). */
export function showDefendReport(result, { tr, keyed = false, modal, plan = null, onFinish = null, finishLabel = 'Bitir' } = {}) {
  const T = makeSiteT(tr, keyed);
  if (typeof modal !== 'function') return null;
  const actions = [{ label: T('site.continue'), class: onFinish ? 'ghost' : 'primary' }];
  if (onFinish) actions.push({ label: finishLabel, class: 'primary', onClick: () => { onFinish(); } });
  return modal({ title: T('site.report'), body: defendReportBody(result, { tr, keyed, plan }), wide: true, actions });
}
