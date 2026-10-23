// Uçuş Simülatörü — KUMANDA MODU (Mode 1–4; HEPGO + SIMUMAV ortak; docs/ucus-simulatoru.md §27.1.1). RC vericilerdeki gibi hangi çubuğun hangi
// ekseni sürdüğünü seçer; sanal çubuklar, klavye (WASD = sol çubuk, ok tuşları = sağ çubuk) ve standart eşlemeli fiziksel gamepad aynı ayarı izler.
//   Mode 1: sol yaw / pitch · sağ roll / gaz      Mode 2 (varsayılan): sol yaw / gaz · sağ roll / pitch
//   Mode 3: sol roll / pitch · sağ yaw / gaz      Mode 4: sol roll / gaz · sağ yaw / pitch
// Kara aracında (§31) mod uygulanmaz (sol dikey gaz, sağ yatay direksiyon). RC verici (USB joystick) kendi modunu donanımda taşır → eksen ataması
// kumanda panelinden (Algıla); mod değişince yalnız 'standard' profilin eksenleri modun varsayılanına çekilir.
// Tercih: localStorage `fs.rc.mode` (1–4); değişimde window 'fs-stickmode' olayı ({detail: mode}).
// Saf kısım (tests/test_flightsim_stickmode.mjs): STICK_MODES, STICK_MAP, stickMap, sideOf, normStickMode, stickLabels, keyHint, modePadAxes.
export const STICK_MODES = [1, 2, 3, 4];
export const STICK_MODE_KEY = 'fs.rc.mode';
export const STICK_MODE_EVENT = 'fs-stickmode';
// [sol X, sol Y, sağ X, sağ Y]
export const STICK_MAP = { 1: ['yaw', 'pitch', 'roll', 'thr'], 2: ['yaw', 'thr', 'roll', 'pitch'], 3: ['roll', 'pitch', 'yaw', 'thr'], 4: ['roll', 'thr', 'yaw', 'pitch'] };
export const normStickMode = m => (STICK_MODES.includes(Number(m)) ? Number(m) : 2);
/** Mod → { lx, ly, rx, ry } eksen adları. */
export function stickMap(mode) { const [lx, ly, rx, ry] = STICK_MAP[normStickMode(mode)]; return { lx, ly, rx, ry }; }
/** Eksenin hangi çubukta olduğu: 'l' | 'r'. */
export function sideOf(mode, axis) { const m = STICK_MAP[normStickMode(mode)]; return m.indexOf(axis) < 2 ? 'l' : 'r'; }
const NAME = { thr: 'Gaz', yaw: 'Yaw', pitch: 'Pitch', roll: 'Roll' };
/** Çubuk etiketleri (dikey eksen önce, Mode 2'de eski metinle aynı: 'Gaz / Yaw', 'Pitch / Roll'). */
export function stickLabels(mode) { const m = stickMap(mode); return { left: `${NAME[m.ly]} / ${NAME[m.lx]}`, right: `${NAME[m.ry]} / ${NAME[m.rx]}` }; }
/** Klavye ipucu: WASD sol çubuk, oklar sağ çubuk (Mode 2: 'W/S gaz · A/D yaw · ↑↓ pitch · ←→ roll'). */
export function keyHint(mode) {
  const m = stickMap(mode), lo = k => (k === 'thr' ? 'gaz' : NAME[k].toLowerCase());
  return `W/S ${lo(m.ly)} · A/D ${lo(m.lx)} · ↑↓ ${lo(m.ry)} · ←→ ${lo(m.rx)}`;
}
/** Standart eşlemeli gamepad için modun eksen ataması (0 sol X, 1 sol Y, 2 sağ X, 3 sağ Y; Y ekseni aşağı + → ters). */
export function modePadAxes(mode) {
  const [lx, ly, rx, ry] = STICK_MAP[normStickMode(mode)];
  return { [lx]: { i: 0, inv: false }, [ly]: { i: 1, inv: true }, [rx]: { i: 2, inv: false }, [ry]: { i: 3, inv: true } };
}
const lsOf = s => s || (typeof localStorage !== 'undefined' ? localStorage : null);
export function loadStickMode(storage = null) { try { return normStickMode(lsOf(storage)?.getItem(STICK_MODE_KEY) ?? 2); } catch { return 2; } }
export function saveStickMode(mode, storage = null, win = (typeof window !== 'undefined' ? window : null)) {
  const m = normStickMode(mode);
  try { lsOf(storage)?.setItem(STICK_MODE_KEY, String(m)); } catch { /* özel kip */ }
  try { win?.dispatchEvent(new CustomEvent(STICK_MODE_EVENT, { detail: m })); } catch { /* olay yok */ }
  return m;
}
/** Değişimi dinle → çıkış fonksiyonu. */
export function onStickMode(fn, win = (typeof window !== 'undefined' ? window : null)) {
  const h = e => fn(normStickMode(e?.detail));
  win?.addEventListener(STICK_MODE_EVENT, h);
  return () => win?.removeEventListener(STICK_MODE_EVENT, h);
}

export const STICKMODE_TEXTS = [
  ['stickmode.title', 'Kumanda modu'],
  ['stickmode.hint', 'Sanal çubuklar, klavye (WASD sol, oklar sağ) ve gamepad bu modu izler. RC vericide mod donanımdadır; eksenleri kumanda panelinden atayın.'],
  ['stickmode.m1', 'Sol: yaw / pitch · Sağ: roll / gaz'], ['stickmode.m2', 'Sol: yaw / gaz · Sağ: roll / pitch'],
  ['stickmode.m3', 'Sol: roll / pitch · Sağ: yaw / gaz'], ['stickmode.m4', 'Sol: roll / gaz · Sağ: yaw / pitch'],
  ['stickmode.changed', 'Kumanda modu: Mode {m}'],
];
const TXT = Object.fromEntries(STICKMODE_TEXTS);
const fill = (s, p) => (p ? String(s).replace(/\{(\w+)\}/g, (m, k) => (p[k] != null ? String(p[k]) : m)) : String(s));
/** HEPGO (keyed=false): Türkçe metin anahtar; SIMUMAV (keyed=true): `stickmode.*` anahtarı, yoksa Türkçe. */
export const makeStickT = (tr, keyed = false) => (k, p) => {
  const tx = TXT[k] ?? k;
  if (!tr) return fill(tx, p);
  if (!keyed) return tr(tx, p);
  const r = tr(k, p);
  return r && r !== k ? r : fill(tx, p);
};

/** Paneller için seçici (M1–M4 düğme dizisi + açıklama satırı). Dönüş { el, set(mode), dispose() }; tıklama saveStickMode → olay. */
export function createStickModePicker({ tr = null, keyed = false, storage = null, onPick = null } = {}) {
  const T = makeStickT(tr, keyed);
  const mk = (tag, cls, txt) => { const e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; };
  const wrap = mk('div', 'fs-smode');
  const head = mk('div', 'fs-smode-h'); head.append(mk('b', null, T('stickmode.title')));
  const seg = mk('div', 'fs-rcf-seg fs-smode-seg');
  const desc = mk('div', 'fs-smode-d');
  const btns = STICK_MODES.map(m => { const b = mk('button', null, `Mode ${m}`); b.type = 'button'; b.dataset.m = String(m); b.title = T(`stickmode.m${m}`); b.addEventListener('click', () => { saveStickMode(m, storage); onPick?.(m); }); return b; });
  seg.append(...btns); wrap.append(head, seg, desc);
  const set = m => { m = normStickMode(m); btns.forEach(b => b.classList.toggle('on', b.dataset.m === String(m))); desc.textContent = T(`stickmode.m${m}`); };
  set(loadStickMode(storage));
  const off = onStickMode(set);
  if (typeof document !== 'undefined' && !document.getElementById('fs-smode-css')) {
    const st = document.createElement('style'); st.id = 'fs-smode-css';
    st.textContent = '.fs-smode{margin:2px 0 8px}.fs-smode-h{font-size:12px;margin-bottom:4px;color:#cbd5e1}.fs-smode-seg{display:flex;gap:4px;margin-bottom:4px}.fs-smode-seg button{flex:1;padding:5px 4px;border-radius:8px;border:1px solid rgba(255,255,255,.16);background:rgba(255,255,255,.04);color:inherit;font:600 12px system-ui,sans-serif;cursor:pointer}.fs-smode-seg button.on{background:#0ea5e9;border-color:#0ea5e9;color:#fff}.fs-smode-d{font-size:11.5px;color:#94a3b8}';
    document.head.append(st);
  }
  return { el: wrap, set, dispose: off };
}
