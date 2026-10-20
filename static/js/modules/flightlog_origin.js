// Uçuş logu kaynağı rozeti/çıkarımı — Araçlar › Uçuş Logu Analizi ve Uçuş Simülatörü "Kayıttan oynat" listesi ortak.
import { icons } from '../icons.js';
import { h, svgIcon, t as tr } from '../ui.js';

// Uçuş logu kaynağı (flight_logs.origin): SIM = SITL simülasyon kaydı · REAL = gerçek uçuş. Eski/okunamayan satırda (origin yok)
// "Simülatör · …" uçak adı ya da SIM-<n>-<tarih>.bin dosya adı simülasyon sayılır.
export const logOrigin = l => (l?.origin === 'SIM' || l?.origin === 'REAL' ? l.origin
  : (/^Simülatör\b/.test(l?.aircraft || '') || /^SIM-\d+-\d{8}-\d{4}\.bin$/i.test(l?.file_name || '') ? 'SIM' : 'REAL'));
export const originBadge = l => (logOrigin(l) === 'SIM'
  ? h('span', { class: 'badge purple fs-origin sim', title: tr('Simülasyon kaydı (SITL)') }, svgIcon(icons.screen), tr('Simülasyon'))
  : h('span', { class: 'badge green fs-origin real', title: tr('Gerçek uçuş kaydı') }, svgIcon(icons.field), tr('Gerçek')));
