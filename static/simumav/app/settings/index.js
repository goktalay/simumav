// Ayarlar: tema (koyu/açık/otomatik — anında), dil (7), ses, FPV analog efekt, hesap bilgisi, çıkış.
import * as api from '../core/api.js';
import { h, clear } from '../core/dom.js';
import { t, LANGS, lang } from '../i18n/i18n.js';
import { screen, segment, switchEl, btn, toast, toastErr, confirmDlg } from '../ui/components.js';
import { stagger } from '../ui/transition.js';

export async function mount(root, ctx) {
  const sc = screen({ title: t('settings.title'), sub: t('settings.sub'), cls: 'scroll' });
  const panel = h('div', { class: 'settings-panel' });
  sc.append(panel);
  clear(root, sc);
  ctx.setBack(t('common.menu'));
  const S = ctx.state.settings, user = ctx.state.user || {};
  let saveT = 0;
  const save = patch => { Object.assign(S, patch); clearTimeout(saveT); saveT = setTimeout(async () => { try { await api.put('/api/settings', { lang: S.lang || lang(), theme: S.theme, sound: !!S.sound, analog_fpv: !!S.analog_fpv }); } catch (e) { toastErr(e); } }, 300); };
  const row = (title, sub, control) => h('div', { class: 'card setting' }, h('div', { class: 'lbl' }, h('b', {}, title), sub ? h('small', {}, sub) : null), control);

  const langs = h('div', { class: 'langs' });
  for (const l of LANGS) langs.append(h('button', { type: 'button', class: l.code === lang() ? 'on' : '', onclick: async () => { save({ lang: l.code }); await ctx.setLang(l.code); } }, l.native, h('small', {}, l.code.toUpperCase())));

  const mtUrl = ctx.state.meta?.mt_url || 'https://mastertool.download';
  panel.append(
    row(t('settings.theme'), t('settings.theme_sub'), segment([{ value: 'dark', label: t('settings.dark') }, { value: 'light', label: t('settings.light') }, { value: 'auto', label: t('settings.auto') }], localStorage.getItem('sm:theme') || S.theme || 'auto', v => { ctx.applyTheme(v); save({ theme: v }); })),
    row(t('settings.lang'), t('settings.lang_sub'), langs),
    row(t('settings.sound'), t('settings.sound_sub'), switchEl(S.sound !== false, v => save({ sound: v }), t('settings.sound'))),
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
