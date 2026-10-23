// Ayarlar: tema (koyu/açık/otomatik — anında), dil (7), ses (ana ses + düzey; kanal başına Müzik / Oyun efektleri / Uyarı sesleri /
// Motor ve uçuş sesi — ui/audiomix.js, cihazda saklanır), hareketli arka planlar, FPV analog efekt, hesap bilgisi, çıkış.
import * as api from '../core/api.js';
import { h, clear } from '../core/dom.js';
import { t, LANGS, lang } from '../i18n/i18n.js';
import { screen, segment, switchEl, btn, range, toast, toastErr, confirmDlg } from '../ui/components.js';
import { stagger } from '../ui/transition.js';
import * as sfx from '../ui/sfx.js';
import { readMix, writeMix } from '../ui/audiomix.js';
import { THEMES, themeName, countryName, previewFromSearch } from '/sim/holiday_fx.js';

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
  // Kanal satırı: aç/kapa + düzey (0–100); önizleme sesi (efekt → seçim, uyarı → caution)
  const mixRow = (ch, title, preview) => {
    const m = readMix()[ch];
    const r = range({ min: 0, max: 100, step: 5, value: m.vol, format: v => `${v}%`, onInput: v => writeMix(ch, { vol: v }) });
    r.inp.setAttribute('aria-label', title); r.out.classList.add('mix-out'); r.inp.addEventListener('change', () => preview?.());
    const wrap = h('div', { class: `mix-row ${m.on ? '' : 'off'}`, dataset: { mix: ch } });
    const sw = switchEl(m.on, v => { writeMix(ch, { on: v }); wrap.classList.toggle('off', !v); if (v) preview?.(); }, `${title} · ${t('settings.mute')}`);
    wrap.append(sw, r.inp, r.out);
    return wrap;
  };

  const langs = h('div', { class: 'langs' });
  for (const l of LANGS) langs.append(h('button', { type: 'button', class: l.code === lang() ? 'on' : '', onclick: async () => { save({ lang: l.code }); await ctx.setLang(l.code); } }, l.native, h('small', {}, l.code.toUpperCase())));

  const mtUrl = ctx.state.meta?.mt_url || 'https://mastertool.download';
  panel.append(
    row(t('settings.theme'), t('settings.theme_sub'), segment([{ value: 'dark', label: t('settings.dark') }, { value: 'light', label: t('settings.light') }, { value: 'auto', label: t('settings.auto') }], localStorage.getItem('sm:theme') || S.theme || 'auto', v => { ctx.applyTheme(v); save({ theme: v }); })),
    row(t('settings.lang'), t('settings.lang_sub'), langs),
    row(t('settings.sound'), t('settings.sound_sub'), switchEl(S.sound !== false, v => { save({ sound: v }); if (v) sfx.select(); }, t('settings.sound'))),
    row(t('settings.volume'), t('settings.volume_sub'), (() => { const r = range({ min: 0, max: 100, value: Math.round((S.volume ?? 0.8) * 100), format: v => `${v}%`, onInput: v => save({ volume: v / 100 }) }); r.inp.addEventListener('change', () => sfx.select()); return h('div', { class: 'vol-row' }, r.inp, r.out); })()),
    (() => { const r = row(t('settings.mix'), t('settings.mix_sub'), null); r.classList.add('mix-head'); return r; })(),
    row(t('settings.music'), t('settings.music_sub'), mixRow('music', t('settings.music'))),
    row(t('settings.fx'), t('settings.fx_sub'), mixRow('sfx', t('settings.fx'), () => sfx.select())),
    row(t('settings.alerts'), t('settings.alerts_sub'), mixRow('alert', t('settings.alerts'), () => sfx.caution())),
    row(t('settings.flight_engine'), t('settings.flight_engine_sub'), mixRow('engine', t('settings.flight_engine'))),
    row(t('settings.engine'), t('settings.engine_sub'), switchEl(engineOn(), v => { localStorage.setItem('sm:engine', v ? '1' : '0'); sfx.configure({ engine: v }); }, t('settings.engine'))),
    row(t('settings.bgfx'), t('settings.bgfx_sub'), switchEl(bgOn(), v => { localStorage.setItem('sm:bgfx', v ? '1' : '0'); dispatchEvent(new CustomEvent('sm:bgfx')); }, t('settings.bgfx'))),
    ...holidayRows(),
    row(t('settings.analog'), t('settings.analog_sub'), switchEl(S.analog_fpv !== false, v => save({ analog_fpv: v }), t('settings.analog'))),
    // §25 gizlilik: TOP 10 PİLOT listesinde görünme (varsayılan görünür; sunucu users.settings.lb_hidden)
    (() => { const r = row(t('settings.lb_hidden'), t('settings.lb_hidden_sub'), switchEl(!!S.leaderboard_hidden, async v => {
      S.leaderboard_hidden = v;
      try { await api.put('/api/settings', { leaderboard_hidden: v }); toast(t('common.saved'), 'ok'); } catch (e) { toastErr(e); }
    }, t('settings.lb_hidden'))); r.dataset.set = 'lb_hidden'; return r; })(),
    row(t('settings.account'), `${user.display_name || ''}${user.email ? ` · ${user.email}` : ''}`, h('a', { class: 'btn', href: mtUrl, target: '_blank', rel: 'noopener' }, t('settings.account_link'))),
    // Destek (§9): belirgin kart — Sorun bildir modalı + Taleplerim
    (() => { const r = row(t('support.report'), t('support.report_sub'), h('div', { class: 'btn-row' },
      btn(t('support.report'), async () => { (await import('../support/index.js')).openReportModal(ctx, { source: 'settings' }); }, 'primary', { dataset: { act: 'report' } }),
      btn(t('support.my_tickets'), () => ctx.go('support'), '', { dataset: { act: 'tickets' } }))); r.classList.add('sup-card'); return r; })(),
    row(t('settings.version'), `SIMUMAV ${ctx.state.meta?.version || ''}`, btn(t('settings.logout'), logout, 'danger')),
  );
  stagger([...panel.children], 60);

  // Bayram temaları (docs/bayram-temalari.md): aç/kapa (varsayılan açık) + ülke (Otomatik / liste) + geliştirici önizlemesi (dev oturumu ya da ?bayram=)
  function holidayRows() {
    const L = lang();
    const hs = globalThis.__smHoliday?.() || {};
    const putH = async patch => { Object.assign(S, patch); try { await api.put('/api/settings', patch); toast(t('common.saved'), 'ok'); } catch (e) { toastErr(e); } dispatchEvent(new CustomEvent('sm:holiday')); };
    const cur = hs.picked?.primary, nx = hs.info?.next;
    const status = [cur && !cur.preview ? t('settings.holiday_today', { name: cur.name || themeName(cur.theme, L) }) : null,
      nx ? t('settings.holiday_next', { name: nx.name || themeName(nx.theme, L), d: nx.in_days }) : null].filter(Boolean).join(' · ');
    const auto = hs.detected?.source && hs.detected.source !== 'setting' ? hs.detected.country : (hs.me?.located || null);
    const codes = (hs.me?.countries || []).map(c => [c, countryName(c, L)]).sort((a, b) => a[1].localeCompare(b[1], L));
    const sel = h('select', { class: 'input', 'aria-label': t('settings.holiday_country'), dataset: { set: 'holiday_country' } },
      h('option', { value: '' }, auto ? t('settings.holiday_auto', { c: countryName(auto, L) }) : t('settings.holiday_auto', { c: '—' })),
      codes.map(([c, n]) => h('option', { value: c, selected: c === (S.holiday_country || '') }, n)));
    sel.addEventListener('change', () => putH({ holiday_country: sel.value }));
    const on = row(t('settings.holiday'), [t('settings.holiday_sub'), status].filter(Boolean).join(' — '), switchEl(S.holiday_fx !== false, v => putH({ holiday_fx: v }), t('settings.holiday')));
    on.dataset.set = 'holiday_fx';
    const rows = [on, row(t('settings.holiday_country'), t('settings.holiday_country_sub'), sel)];
    if (ctx.state.meta?.dev_login || previewFromSearch()) {
      const pv = h('select', { class: 'input', 'aria-label': t('settings.holiday_preview'), dataset: { set: 'holiday_preview' } },
        h('option', { value: '' }, t('settings.holiday_preview_none')), THEMES.map(code => h('option', { value: code }, themeName(code, L))));
      pv.addEventListener('change', () => dispatchEvent(new CustomEvent('sm:holiday', { detail: { preview: pv.value ? { themes: [pv.value], country: S.holiday_country || auto || null } : null } })));
      rows.push(row(t('settings.holiday_preview'), t('settings.holiday_preview_sub'), pv));
    }
    return rows;
  }

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
