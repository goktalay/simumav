// Seçici (segmented / sekme) ikonları: seçenek etiketine göre otomatik eklenir. 24×24 çizgi ikon, currentColor.
const svg = body => `<svg class="seg-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;

const I = {
  card: svg('<rect x="3.5" y="3.5" width="7" height="7" rx="1.5"/><rect x="13.5" y="3.5" width="7" height="7" rx="1.5"/><rect x="3.5" y="13.5" width="7" height="7" rx="1.5"/><rect x="13.5" y="13.5" width="7" height="7" rx="1.5"/>'),
  list: svg('<path d="M9 6h11M9 12h11M9 18h11"/><circle cx="4.5" cy="6" r="1"/><circle cx="4.5" cy="12" r="1"/><circle cx="4.5" cy="18" r="1"/>'),
  kanban: svg('<rect x="3.5" y="4" width="5" height="16" rx="1.5"/><rect x="10.5" y="4" width="5" height="10" rx="1.5"/><rect x="17.5" y="4" width="3" height="13" rx="1.2"/>'),
  chart: svg('<path d="M4 20h16"/><rect x="6" y="11" width="3" height="6" rx=".8"/><rect x="11" y="6" width="3" height="11" rx=".8"/><rect x="16" y="9" width="3" height="8" rx=".8"/>'),
  print: svg('<path d="M7 9V4h10v5"/><rect x="4" y="9" width="16" height="7" rx="2"/><path d="M7 14h10v6H7z"/>'),
  calendar: svg('<rect x="3.5" y="5" width="17" height="15" rx="2"/><path d="M3.5 10h17M8 3v4M16 3v4"/>'),
  bell: svg('<path d="M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15z"/><path d="M10 20a2 2 0 0 0 4 0"/>'),
  camera: svg('<rect x="3" y="7" width="13" height="10" rx="2"/><path d="M16 11l5-3v8l-5-3"/>'),
  building: svg('<path d="M4 20V5l8-2v17M12 8h8v12M7 8h2M7 12h2M7 16h2M15 12h2M15 16h2M3 20h18"/>'),
  book: svg('<path d="M5 4h11a2 2 0 0 1 2 2v14H7a2 2 0 0 1-2-2z"/><path d="M5 18a2 2 0 0 1 2-2h11"/><circle cx="11.5" cy="9" r="2"/>'),
  server: svg('<rect x="4" y="4" width="16" height="7" rx="1.5"/><rect x="4" y="13" width="16" height="7" rx="1.5"/><path d="M8 7.5h.01M8 16.5h.01M12 7.5h5M12 16.5h5"/>'),
  pulse: svg('<path d="M3 12h4l2-5 4 10 2-5h6"/>'),
  digits: svg('<rect x="3" y="6" width="18" height="12" rx="2"/><path d="M8 9v6M11 9h2v3h-2v3h2M16 9v6"/>'),
  clock: svg('<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>'),
  printer3d: svg('<rect x="4" y="3.5" width="16" height="17" rx="2"/><path d="M4 8h16M9 8v3h6V8M8 17h8"/>'),
  empty: svg('<rect x="4" y="4" width="16" height="16" rx="2" stroke-dasharray="3 3"/>'),
  plane: svg('<path d="M12 3c1 0 1.5 1 1.5 2.5V9l7 5v2l-7-2v4l2 1.5V21L12 20l-3.5 1v-1.5l2-1.5v-4l-7 2v-2l7-5V5.5C10.5 4 11 3 12 3z"/>'),
  bolt: svg('<path d="M13 3L5 13.5h6L10 21l8-10.5h-6z"/>'),
  zoomOut: svg('<circle cx="11" cy="11" r="6.5"/><path d="M16 16l4 4M8 11h6"/>'),
  zoom: svg('<circle cx="11" cy="11" r="6.5"/><path d="M16 16l4 4"/>'),
  zoomIn: svg('<circle cx="11" cy="11" r="6.5"/><path d="M16 16l4 4M8 11h6M11 8v6"/>'),
  users: svg('<circle cx="9" cy="9" r="3"/><path d="M3.5 19a5.5 5.5 0 0 1 11 0"/><circle cx="17" cy="9.5" r="2.3"/><path d="M16 14.2a4.5 4.5 0 0 1 5 4.8"/>'),
  badgePerson: svg('<rect x="4" y="3.5" width="16" height="17" rx="2"/><circle cx="12" cy="10" r="2.5"/><path d="M8 17a4 4 0 0 1 8 0"/>'),
  cube: svg('<path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z"/><path d="M12 12l8-4.5M12 12v9M12 12L4 7.5"/>'),
  door: svg('<path d="M6 21V4h10v17M4 21h16"/><path d="M13 12h.01"/>'),
  left: svg('<path d="M15 6l-6 6 6 6"/>'),
  right: svg('<path d="M9 6l6 6-6 6"/>'),
  eye: svg('<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="3"/>'),
  layers: svg('<path d="M12 4l9 4.5-9 4.5-9-4.5z"/><path d="M3 13l9 4.5 9-4.5"/>'),
  gear: svg('<circle cx="12" cy="12" r="3"/><path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.3 5.3l2.1 2.1M16.6 16.6l2.1 2.1M5.3 18.7l2.1-2.1M16.6 7.4l2.1-2.1"/>'),
  inbox: svg('<path d="M4 13l2.5-8h11L20 13v6H4z"/><path d="M4 13h5l1 2h4l1-2h5"/>'),
  send: svg('<path d="M21 3L10 14M21 3l-7 18-4-7-7-4z"/>'),
  hourglass: svg('<path d="M7 3h10M7 21h10M8 3c0 5 8 5 8 9s-8 4-8 9M16 3c0 5-8 5-8 9s8 4 8 9"/>'),
  history: svg('<path d="M3.5 12a8.5 8.5 0 1 0 2.5-6"/><path d="M3 4v4h4M12 8v4l3 2"/>'),
  checkBox: svg('<rect x="3.5" y="3.5" width="17" height="17" rx="3"/><path d="M8 12l3 3 5-6"/>'),
  flag: svg('<path d="M5 21V4M5 4h11l-2 4 2 4H5"/>'),
  money: svg('<rect x="3" y="6" width="18" height="12" rx="2"/><circle cx="12" cy="12" r="2.5"/><path d="M6.5 9.5v.01M17.5 14.5v.01"/>'),
  road: svg('<path d="M8 3L4 21M16 3l4 18M12 4v3M12 10.5v3M12 17v3"/>'),
  box: svg('<path d="M3.5 7.5L12 3l8.5 4.5v9L12 21l-8.5-4.5z"/><path d="M3.5 7.5L12 12l8.5-4.5M12 12v9"/>'),
  mailDot: svg('<rect x="3" y="6" width="15" height="12" rx="2"/><path d="M3 8l7.5 5L18 8"/><circle cx="19.5" cy="5.5" r="2.5" fill="currentColor" stroke="none"/>'),
  stack: svg('<rect x="4" y="9" width="16" height="11" rx="2"/><path d="M6.5 6h11M9 3h6"/>'),
  car: svg('<path d="M5 16V11.5l1.8-4.5h10.4L19 11.5V16"/><path d="M3.5 16h17v2.5h-17zM5 11.5h14"/><circle cx="7.5" cy="14" r=".6"/><circle cx="16.5" cy="14" r=".6"/>'),
  log: svg('<path d="M6 3.5h9l3 3V20.5H6z"/><path d="M9 10h6M9 13.5h6M9 17h4"/>'),
  faceQ: svg('<circle cx="12" cy="12" r="8.5"/><path d="M10 9.5a2 2 0 1 1 2.8 1.8c-.5.3-.8.7-.8 1.2v.5M12 16v.01"/>'),
  guest: svg('<circle cx="12" cy="8" r="3.5"/><path d="M5 20a7 7 0 0 1 14 0"/>'),
  phone: svg('<path d="M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2z"/>'),
  phoneOk: svg('<path d="M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2z"/><path d="M15 5l2 2 4-4"/>'),
  phoneX: svg('<path d="M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2z"/><path d="M16 3l5 5M21 3l-5 5"/>'),
  message: svg('<path d="M4 5h16v11H9l-5 4z"/><path d="M8 9.5h8M8 12.5h5"/>'),
  globe: svg('<circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17M12 3.5c2.5 2.5 2.5 14.5 0 17M12 3.5c-2.5 2.5-2.5 14.5 0 17"/>'),
  lockUsers: svg('<circle cx="9" cy="8.5" r="3"/><path d="M3.5 19a5.5 5.5 0 0 1 9-4.2"/><rect x="14" y="14" width="7" height="6" rx="1.2"/><path d="M15.5 14v-1.5a2 2 0 0 1 4 0V14"/>'),
  lock: svg('<rect x="5" y="11" width="14" height="9.5" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>'),
  body: svg('<path d="M12 3l3 6v12H9V9z"/>'),
  cover: svg('<rect x="5" y="5" width="14" height="14" rx="2"/><path d="M8.5 8.5h.01M15.5 8.5h.01M8.5 15.5h.01M15.5 15.5h.01"/>'),
  chip: svg('<rect x="6.5" y="6.5" width="11" height="11" rx="1.5"/><path d="M9.5 3v3.5M14.5 3v3.5M9.5 17.5V21M14.5 17.5V21M3 9.5h3.5M3 14.5h3.5M17.5 9.5H21M17.5 14.5H21"/>'),
  edit: svg('<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="M13.5 6.5l4 4"/>'),
  login: svg('<path d="M14 4h5v16h-5M4 12h11M11 8l4 4-4 4"/>'),
  person: svg('<circle cx="12" cy="8" r="3.5"/><path d="M5 20a7 7 0 0 1 14 0"/>'),
  pin: svg('<path d="M12 21s-6.5-6-6.5-11a6.5 6.5 0 0 1 13 0c0 5-6.5 11-6.5 11z"/><circle cx="12" cy="10" r="2.3"/>'),
  note: svg('<path d="M5 3.5h10l4 4V20.5H5z"/><path d="M8.5 11h7M8.5 14.5h7M8.5 18h4"/>'),
  meeting: svg('<circle cx="7" cy="8" r="2.3"/><circle cx="17" cy="8" r="2.3"/><path d="M3 20v-2.5a4 4 0 0 1 8 0V20M13 20v-2.5a4 4 0 0 1 8 0V20"/>'),
  folder: svg('<path d="M3.5 7a2 2 0 0 1 2-2h4l2 2.5h7a2 2 0 0 1 2 2V18a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z"/>'),
  report: svg('<path d="M6 3.5h9l3 3V20.5H6z"/><path d="M9 17v-3M12 17v-5M15 17v-2"/>'),
  media: svg('<rect x="3.5" y="5" width="17" height="14" rx="2"/><path d="M3.5 16l5-5 4 4 3-3 5 5"/><circle cx="15.5" cy="9" r="1.5"/>'),
  route3d: svg('<path d="M4 18c3-8 6 2 9-6s5-6 7-6"/><circle cx="4" cy="18" r="1.5"/><circle cx="20" cy="6" r="1.5"/>'),
  tree: svg('<rect x="3.5" y="3.5" width="6" height="5" rx="1"/><rect x="14.5" y="10" width="6" height="4.5" rx="1"/><rect x="14.5" y="16.5" width="6" height="4.5" rx="1"/><path d="M6.5 8.5v10h8M6.5 12.25h8"/>'),
  recipe: svg('<path d="M7 3.5h10a1.5 1.5 0 0 1 1.5 1.5v15l-2.5-1.5-2 1.5-2-1.5-2 1.5-2-1.5L5.5 20V5A1.5 1.5 0 0 1 7 3.5z"/><path d="M9 8.5h6M9 12h6M9 15.5h3"/>'),
  image: svg('<rect x="3.5" y="4.5" width="17" height="15" rx="2"/><circle cx="9" cy="10" r="1.8"/><path d="M4 18l5-5 4 4 3-3 4 4"/>'),
  sort: svg('<path d="M7 4v16M4 17l3 3 3-3M14 6h7M14 12h5M14 18h3"/>'),
  grid: svg('<rect x="3.5" y="3.5" width="17" height="17" rx="2"/><path d="M3.5 12h17M12 3.5v17"/>'),
};

// Etiket → ikon (seçeneğin görünen adı)
const BY_LABEL = {
  'Kart': I.card, 'Liste': I.list, 'Todo': I.kanban, 'Grafik': I.chart, 'Baskı': I.print,
  'Randevu': I.calendar, 'Hatırlatma': I.bell, 'İzleme': I.camera, 'Kamera Listesi': I.list,
  'Firmalar': I.building, 'Rehber': I.book, 'Sistem Durumu': I.server, 'Canlı Üretim': I.pulse,
  'Dijital': I.digits, 'Analog': I.clock, 'Mevcut durum': I.printer3d, 'Hepsi boş': I.empty,
  'Uçak uçak': I.plane, 'En kısa toplam süre': I.bolt, 'Uzak': I.zoomOut, 'Orta': I.zoom, 'Yakın': I.zoomIn,
  'Kullanıcılar (personel)': I.users, 'Firma personeli': I.badgePerson, '3B Görünüm': I.cube, 'Sıralama': I.sort, 'Ürün Ağacı': I.tree, 'Personel': I.users, 'İş Başvuruları': I.inbox, 'Bekleyenler': I.hourglass, 'Reddedilenler': I.lock, 'İzinler': I.calendar, 'Özlük Dosyaları': I.book, 'Adresler': I.door, 'Tedarikçiler': I.building, 'Fiziksel Özellikler': I.cube, 'Stok Hareketi': I.history, 'Depo': I.box, 'Resimler': I.image, 'Fatura İrsaliye': I.recipe, 'Hurda ve Kullanım': I.flag, 'Kullanıldığı Ürünler': I.tree, 'İmzalı Form Bekleyen': I.hourglass, 'Genel': I.eye, 'Sözleşmeler': I.recipe, 'Geçmiş': I.history, 'Yaklaşan ve Süren': I.calendar, 'Tüm Geçmiş': I.history, 'Reçete': I.recipe, 'Resim': I.image, '3B': I.cube, 'Parçalar': I.gear,
  'Giriş': I.door, 'Sol raf': I.left, 'Sağ raf': I.right, 'Genel': I.eye,
  'Mamul': I.plane, 'Yarı mamul': I.layers, 'Yedek parça': I.gear,
  'Bana gelenler': I.inbox, 'Gönderdiklerim': I.send,
  'Onay Bekleyenler': I.hourglass, 'Depo Geçmişi': I.history, 'Saha Deposu Onayı': I.checkBox,
  'Saha Görevi': I.flag, 'Uçuş Yönetimi': I.plane, 'Masraf Yönetimi': I.money, 'Yol Yönetimi': I.road,
  'Bekleyen Kargolar': I.box, 'Kargo Geçmişi': I.history, 'Okunmamış': I.mailDot, 'Tümü': I.stack,
  'Araçlar': I.car, 'Giriş / Çıkış Kayıtları': I.log, 'Kameralar': I.camera, 'Tanımlanamayan Kişiler': I.faceQ,
  'Misafirler': I.guest, 'Kargolar': I.box, 'Aramalar': I.phone,
  'Bağlandı': I.phoneOk, 'Ulaşılamadı': I.phoneX, 'Mesaj bırakıldı': I.message,
  'Herkes': I.globe, 'Seçili roller': I.lockUsers, 'Yalnızca ben': I.lock,
  'GÖVDE': I.body, 'KAPAK': I.cover, 'ELEKTRONİK': I.chip,
  'Bilgileri Düzenle': I.edit, 'Kullanıcı Logları': I.log, 'Giriş Logları': I.login,
  'Gelen Kişiler': I.users, 'Gelen Araçlar': I.car, 'Görüşülecek Kişiler': I.person,
  'Uçuş Raporu': I.report, '3B Uçuş İzleme': I.route3d, 'Uçuş Notları': I.note, 'Video ve Resimler': I.media,
  'Gün': svg('<rect x="3.5" y="5" width="17" height="15" rx="2"/><path d="M3.5 10h17M8 3v4M16 3v4"/><rect x="10" y="13" width="4" height="4" rx="1"/>'),
  'Hafta': svg('<rect x="3.5" y="5" width="17" height="15" rx="2"/><path d="M3.5 10h17M8 3v4M16 3v4M3.5 15h17"/>'),
  'Ay': I.calendar, 'Yıl': I.grid, 'Ajanda': I.list,
  'Kişiler': I.users, 'Adresler': I.pin, 'Evrak Yönetimi': I.folder, 'Notlar': I.note, 'Toplantı Yönetimi': I.meeting, 'Takvim': I.calendar,
};

// Anahtara göre ikon (ör. Ayarlar grupları)
const EXTRA = { screen: svg('<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/><path d="M7 12c1.5-3 3-3 5 0s3.5 3 5 0"/>'), bell2: svg('<path d="M11 5L6 9H3v6h3l5 4z"/><path d="M15.5 8.5a5 5 0 0 1 0 7M18.5 5.5a9 9 0 0 1 0 13"/>') };
export function segIconByKey(key) {
  const markup = EXTRA[key] || I[key];
  if (!markup) return null;
  const t = document.createElement('template');
  t.innerHTML = markup;
  return t.content.firstElementChild;
}

export function segIcon(label) {
  if (typeof label !== 'string') return null;
  const base = label.replace(/ \([^)]*\)$/, '');   // "Bekleyenler (3)" → "Bekleyenler"
  const markup = BY_LABEL[label] || BY_LABEL[base] || (/^\d+'l[ıi]$/.test(label) ? I.grid : null);   // kamera duvarı: 4'lı, 6'lı…
  if (!markup) return null;
  const t = document.createElement('template');
  t.innerHTML = markup;
  return t.content.firstElementChild;
}
