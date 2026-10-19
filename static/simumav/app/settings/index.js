// Ayarlar: tema (koyu/açık/otomatik — anında), dil (7), ses, FPV analog efekt, hesap bilgisi, çıkış.
import * as api from '../core/api.js';
import { h, clear } from '../core/dom.js';
import { t, LANGS, lang } from '../i18n/i18n.js';
import { screen, segment, switchEl, btn, range, toast, toastErr, confirmDlg } from '../ui/components.js';
import { stagger } from '../ui/transition.js';
import * as sfx from '../ui/sfx.js';

export async function mount(root, ctx) {
  const sc = screen({ title: t('settings.title'), sub: t('settings.sub'), cls: 'scroll' });
  const panel = h('div', { class: 'settings-panel' });
  sc.append(panel);
  clear(root, sc);
  ctx.setBack(t('common.menu'));
  const S = ctx.state.settings, user = ctx.state.user || {};
  let saveT = 0;
  const save = patch => { Object.assign(S, patch); sfx.configure({ sound: S.sound !== false, volume: S.volume ?? 0.8 }); clearTimeout(saveT); saveT = setTimeout(async () => { try { await api.put('/api/settings', { ...(S.lang ? { lang: S.lang } : {}), theme: S.theme, sound: !!S.sound, analog_fpv: !!S.analog_fpv, volume: Number(S.volume ?? 0.8) }); } catch (e) { toastErr(e); } }, 300); };
  // Cihaza bağlı tercihler (sunucuya gitmez): motor sesi (varsayılan KAPALI), arka plan uçuş sahnesi (varsayılan AÇIK)
  const engineOn = () => localStorage.getItem('sm:engine') === '1';
  const bgOn = () => localStorage.getItem('sm:bgfx') !== '0';
  const row = (title, sub, control) => h('div', { class: 'card setting' }, h('div', { class: 'lbl' }, h('b', {}, title), sub ? h('small', {}, sub) : null), control);

  const langs = h('div', { class: 'langs' });
  for (const l of LANGS) langs.append(h('button', { type: 'button', class: l.code === lang() ? 'on' : '', onclick: async () => { save({ lang: l.code }); await ctx.setLang(l.code); } }, l.native, h('small', {}, l.code.toUpperCase())));

  const mtUrl = ctx.state.meta?.mt_url || 'https://mastertool.download';
  panel.append(
    row(t('settings.theme'), t('settings.theme_sub'), segment([{ value: 'dark', label: t('settings.dark') }, { value: 'light', label: t('settings.light') }, { value: 'auto', label: t('settings.auto') }], localStorage.getItem('sm:theme') || S.theme || 'auto', v => { ctx.applyTheme(v); save({ theme: v }); })),
    row(t('settings.lang'), t('settings.lang_sub'), langs),
    row(t('settings.sound'), t('settings.sound_sub'), switchEl(S.sound !== false, v => { save({ sound: v }); if (v) sfx.select(); }, t('settings.sound'))),
    row(t('settings.volume'), t('settings.volume_sub'), (() => { const r = range({ min: 0, max: 100, value: Math.round((S.volume ?? 0.8) * 100), format: v => `${v}%`, onInput: v => save({ volume: v / 100 }) }); r.inp.addEventListener('change', () => sfx.select()); return h('div', { class: 'vol-row' }, r.inp, r.out); })()),
    row(t('settings.engine'), t('settings.engine_sub'), switchEl(engineOn(), v => { localStorage.setItem('sm:engine', v ? '1' : '0'); sfx.configure({ engine: v }); }, t('settings.engine'))),
    row(t('settings.bgfx'), t('settings.bgfx_sub'), switchEl(bgOn(), v => { localStorage.setItem('sm:bgfx', v ? '1' : '0'); }, t('settings.bgfx'))),
    row(t('settings.analog'), t('settings.analog_sub'), switchEl(S.analog_fpv !== false, v => save({ analog_fpv: v }), t('settings.analog'))),
    row(t('settings.account'), `${user.display_name || ''}${user.email ? ` · ${user.email}` : ''}`, h('a', { class: 'btn', href: mtUrl, target: '_blank', rel: 'noopener' }, t('settings.account_link'))),
    row(t('settings.version'), `SIMUMAV ${ctx.state.meta?.version || ''}`, btn(t('settings.logout'), logout, 'danger')),
  );
  stagger([...panel.children], 60);

  async function logout() {
    if (!await confirmDlg(t('settings.logout_q'), { danger: true })) return;
    try { await api.del('/api/session'); } catch (e) { toastErr(e); }
    // Hesap servisi oturumunu da kapat (uygulama kodu `sv`); başarısız olsa da yerel çıkış tamamlanır
    if (!ctx.state.meta?.dev_login) { try { await fetch(`${mtUrl}/api/sv/auth/logout`, { method: 'POST', credentials: 'include', mode: 'cors' }); } catch { /* ağ */ } }   // dev oturumunda hesap servisi belirteci yok
    localStorage.removeItem('sm:lang');
    toast(t('settings.bye'), 'ok');
    setTimeout(() => { location.href = '/'; }, 400);
  }
}
