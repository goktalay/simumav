// Uçuş Simülatörü — MOBİL MENÜ (docs/ucus-simulatoru.md §39; HEPGO + SIMUMAV ortak). Telefonda (dokunmatik + dar ekran) simülasyon ekranında üst
// gezinti şeridi (.fs-nav: Geri, başlık, durum, hız, tam ekran) ve alt bant (.fs-bar) VARSAYILAN GİZLİ; sol üst köşede (çentik / güvenli alan payı
// env(safe-area-inset-*)) tek yüzen ☰ düğmesi bunları açılır menü olarak gösterir: üst şerit üstte kapsül, alt bant altta çekmece (dokunmaya uygun
// büyük hedefler). Tekrar basınca, arka plana dokununca ya da Esc ile kapanır. HEPGO uygulama başlığı / alt çubuğu da mobil simülasyonda gizlenir
// (sahne tüm ekranı kaplar). Masaüstü değişmez (sınıflar yalnız ortam sorgusu eşleşince).
// Saf: MOBILE_MQ, isMobileEnv(matchMedia). createMobileMenu(stage, { tr, keyed, win, doc }) → { el, isMobile, isOpen, open(), close(), toggle(), dispose() }

export const MOBILE_MQ = '(max-width: 820px), (pointer: coarse) and (max-width: 1024px), (pointer: coarse) and (max-height: 500px)';
export const isMobileEnv = mm => { try { return !!mm?.(MOBILE_MQ)?.matches; } catch { return false; } };
export const MOB_TEXTS = [['mob.menu', 'Menü'], ['mob.close', 'Menüyü kapat']];
const TXT = Object.fromEntries(MOB_TEXTS);
const makeT = (tr, keyed) => k => { const tx = TXT[k] ?? k; if (!tr) return tx; if (!keyed) return tr(tx); const r = tr(k); return r && r !== k ? r : tx; };

const SA = (side, add = 0) => `calc(env(safe-area-inset-${side}, 0px) + ${add}px)`;
const CSS = `
body.fs-mob .app-header,body.fs-mob .app-footer,body.fs-mob #immBar{display:none!important}
body.fs-mob main#view.ops-view{position:fixed;inset:0;z-index:50}
.fs-stage.fs-mob{--fs-bar-h:0px!important}
.fs-stage.fs-mob .fs-windg{top:${SA('top', 64)}}   /* ☰ düğmesinin altında */
.fs-stage.fs-mob:not(.fs-mob-open) .fs-nav,.fs-stage.fs-mob:not(.fs-mob-open) .fs-bar{display:none!important}
.fs-mob-btn{display:none}
.fs-stage.fs-mob .fs-mob-btn{display:inline-flex;align-items:center;justify-content:center;position:absolute;top:${SA('top', 10)};left:${SA('left', 10)};z-index:43;width:46px;height:46px;
  border-radius:15px;border:1px solid rgba(255,255,255,.22);background:rgba(11,18,32,.72);color:#fff;backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);
  box-shadow:0 8px 22px rgba(0,0,0,.4);cursor:pointer;touch-action:manipulation;-webkit-tap-highlight-color:transparent;transition:background .15s,transform .15s}
.fs-stage.fs-mob .fs-mob-btn:active{transform:scale(.94)}
.fs-stage.fs-mob.fs-mob-open .fs-mob-btn{background:rgba(31,111,235,.92);border-color:rgba(255,255,255,.35)}
.fs-mob-btn svg{width:22px;height:22px}
.fs-mob-back{display:none}
.fs-stage.fs-mob.fs-mob-open .fs-mob-back{display:block;position:absolute;inset:0;z-index:40;background:rgba(3,7,18,.38);-webkit-tap-highlight-color:transparent}
.fs-stage.fs-mob.fs-mob-open .fs-nav{display:flex!important;flex-wrap:wrap;row-gap:6px;position:absolute;z-index:42;top:${SA('top', 10)};left:${SA('left', 64)};right:${SA('right', 10)};
  width:auto;max-width:none;transform:none;min-height:46px;padding:6px 10px;border-radius:16px}
.fs-stage.fs-mob.fs-mob-open .fs-nav .fs-nav-sub{display:inline;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.fs-stage.fs-mob.fs-mob-open .fs-nav .fs-back,.fs-stage.fs-mob.fs-mob-open .fs-nav .fs-nav-btn{min-width:40px;min-height:40px}
.fs-stage.fs-mob.fs-mob-open .fs-bar{display:flex!important;z-index:42;gap:8px;padding:12px ${SA('right', 12)} ${SA('bottom', 12)} ${SA('left', 12)};border-radius:18px 18px 0 0;
  border-top:1px solid rgba(255,255,255,.16);box-shadow:0 -12px 32px rgba(0,0,0,.45);background:rgba(11,18,32,.94)}
.fs-stage.fs-mob.fs-mob-open .fs-bar .btn{min-height:40px;font-size:14px}
.fs-stage.fs-mob.fs-mob-open .fs-bar .pill-group>.btn{height:40px}
.fs-stage.fs-mob.fs-mob-open .fs-bar .spacer{display:none}
@media (orientation:landscape) and (max-height:500px){.fs-stage.fs-mob.fs-mob-open .fs-bar{gap:6px;padding-top:8px}.fs-stage.fs-mob.fs-mob-open .fs-bar .btn{min-height:36px;font-size:13px}.fs-stage.fs-mob.fs-mob-open .fs-bar .pill-group>.btn{height:36px}}
`;
function ensureCss(doc) {
  if (!doc || doc.getElementById('fs-mob-css')) return;
  const s = doc.createElement('style'); s.id = 'fs-mob-css'; s.textContent = CSS; doc.head.appendChild(s);
}
const ICON_MENU = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M4 7h16M4 12h16M4 17h16"/></svg>';
const ICON_X = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>';

export function createMobileMenu(stage, { tr = null, keyed = false, win = (typeof window !== 'undefined' ? window : null), doc = (typeof document !== 'undefined' ? document : null) } = {}) {
  ensureCss(doc);
  const T = makeT(tr, keyed);
  const btn = doc.createElement('button'); btn.type = 'button'; btn.className = 'fs-mob-btn'; btn.setAttribute('aria-expanded', 'false');
  const back = doc.createElement('div'); back.className = 'fs-mob-back';
  stage.append(back, btn);
  let open = false, mobile = false;
  const paint = () => {
    stage.classList.toggle('fs-mob-open', mobile && open);
    btn.innerHTML = open ? ICON_X : ICON_MENU;
    const lbl = T(open ? 'mob.close' : 'mob.menu'); btn.title = lbl; btn.setAttribute('aria-label', lbl); btn.setAttribute('aria-expanded', open ? 'true' : 'false');
    // panel/PiP yerleşimleri alt bant yüksekliğine bakar → değişim bildir
    try { win?.dispatchEvent?.(new Event('resize')); } catch { /* eski tarayıcı */ }
  };
  const set = v => { const n = !!v && mobile; if (n === open) return; open = n; paint(); };
  const mq = win?.matchMedia ? win.matchMedia(MOBILE_MQ) : null;
  const sync = () => {
    mobile = !!mq?.matches;
    stage.classList.toggle('fs-mob', mobile); doc?.body?.classList.toggle('fs-mob', mobile);
    if (!mobile) open = false;
    paint();
  };
  btn.addEventListener('click', e => { e.stopPropagation(); set(!open); });
  back.addEventListener('click', () => set(false));
  back.addEventListener('touchstart', e => { e.preventDefault(); set(false); }, { passive: false });
  const onKey = e => { if (e.key === 'Escape' && open) { set(false); e.preventDefault(); e.stopPropagation(); } };
  win?.addEventListener?.('keydown', onKey, true);
  mq?.addEventListener ? mq.addEventListener('change', sync) : mq?.addListener?.(sync);
  sync();
  return {
    el: btn, get isMobile() { return mobile; }, get isOpen() { return open; },
    open: () => set(true), close: () => set(false), toggle: () => set(!open),
    dispose() {
      win?.removeEventListener?.('keydown', onKey, true);
      mq?.removeEventListener ? mq.removeEventListener('change', sync) : mq?.removeListener?.(sync);
      doc?.body?.classList.remove('fs-mob'); stage.classList.remove('fs-mob', 'fs-mob-open'); btn.remove(); back.remove();
    },
  };
}
