// SIMUMAV › Uç — kamera türü seçimi (oyun tarzı kartlar): gündüz / termal / gece görüşü (HEPGO docs/ucus-simulatoru.md §22.3; docs/simumav.md §5 Uç).
// wizard.js'e DOKUNMAZ (adım makinesi saf kalır): index.js pilot adımına `pick.el`, BAŞLA gövdesine `camera: pick.value` ekler. Önizlemeler HEPGO
// /sim/flightsim_camera.js createCameraCards ile (gölgelendiriciyle aynı formüller, 2B tuval — ek WebGL bağlamı AÇILMAZ; __smGl ≤ 1 kuralı).
// Varsayılan: hangar kaydının son türü (drone.camera) → bu dron için yerel son seçim (fs.cam.byDrone) → son tercih (fs.cam.type) → gündüz.
// Çeviri: paylaşılan modülün Türkçe metinleri `camera.*` anahtarlarına eşlenir (camTr; i18n/<dil>.json 7 dil); oturum sahnesi de aynı eşlemeyi kullanır.
// Saf kısım (node testi tests/test_simumav_fly.mjs): CAMERA_KEYS, normCamera, cameraDefault, CAM_TEXT_KEYS, camTr.

export const CAMERA_KEYS = ['day', 'thermal', 'night'];
export const normCamera = v => (CAMERA_KEYS.includes(v) ? v : 'day');
export const cameraDefault = (drone, storedForDrone, last) => normCamera([drone?.camera, storedForDrone, last].find(v => CAMERA_KEYS.includes(v)));
// Paylaşılan modül (flightsim_camera.js) Türkçe metni → SIMUMAV i18n anahtarı
export const CAM_TEXT_KEYS = {
  'Gündüz kamerası': 'camera.day', 'Termal kamera': 'camera.thermal', 'Gece görüşü': 'camera.night',
  'Renkli EO kamera; mevcut görüntü.': 'camera.day_desc',
  'Isı görüntüsü: motorlar, araçlar ve insanlar sıcak; beyaz-sıcak, siyah-sıcak, ironbow paletleri.': 'camera.thermal_desc',
  'Görüntü yoğunlaştırıcı: yeşil fosfor, kazanç, tanecik ve parlak ışıklarda halo.': 'camera.night_desc',
  'Beyaz-sıcak': 'camera.pal_white', 'Siyah-sıcak': 'camera.pal_black', Ironbow: 'camera.pal_iron', 'Termal paleti': 'camera.palette', Palet: 'camera.palette_short',
  Gündüz: 'camera.day_short', Termal: 'camera.thermal_short', Gece: 'camera.night_short',
  GÜNDÜZ: 'camera.osd_day', TERMAL: 'camera.osd_thermal', GECE: 'camera.osd_night', 'GİMBAL': 'camera.osd_gimbal', 'TAKİP': 'camera.osd_follow', GMB: 'camera.osd_gmb',
  'Kamera türü': 'camera.type', 'Kamera PiP': 'camera.pip', 'Kamera türü: {t}': 'camera.changed',
  'Kamera türü (T) · termal paleti (Shift+T) · PiP (V)': 'camera.btn_title',
  'Tür gimbal ve FPV kameralarına ve PiP\'e uygulanır; takip, serbest ve yer kameraları gündüz kalır.': 'camera.applies',
  'T: tür · Shift+T: palet · V: PiP · PiP\'e çift tık: gimbal': 'camera.keys',
  'Boyut: küçük / orta / büyük': 'camera.pip_size', 'Ana görünümle yer değiştir (çift tık)': 'camera.pip_swap', 'PiP\'i gizle (V)': 'camera.pip_hide', 'Boyutlandır': 'camera.pip_resize',
  'Kamera PiP: sürükleyin, çift tıklayınca gimbal kamerası ana görünüme geçer': 'camera.pip_aria',
  'Sürükle: taşı · çift tık: gimbal kamerası ana görünüme · tekerlek: yakınlaştırma': 'camera.pip_title',
};
// tr sarmalayıcısı: eşlenen metin anahtardan çevrilir; sözlükte yoksa (anahtarın kendisi döner) Türkçe metin
export const camTr = tr => (s, p) => { const k = CAM_TEXT_KEYS[s]; if (!k) return tr(s, p); const r = tr(k, p); return r && r !== k ? r : tr(s, p); };

/** createCameraPick({ h, tr, getDrone }) → { el, value, refresh() } — dron değişince refresh() (kullanıcı seçmediyse varsayılan yeniden hesaplanır). */
export function createCameraPick({ h, tr = s => s, getDrone = () => null } = {}) {
  const t = camTr(tr);
  const holder = h('div', { class: 'sm-cam-holder' }, h('div', { class: 'small muted' }, tr('common.loading')));
  const el = h('div', { class: 'sm-cam-pick' }, h('h3', null, t('Kamera türü')), h('p', { class: 'small muted' }, tr('camera.hint')), holder);
  let value = 'day', cards = null, prefs = null, touched = false;
  const def = () => cameraDefault(getDrone(), prefs?.typeForDrone(getDrone()?.id), prefs?.type);
  import('/sim/flightsim_camera.js').then(M => {
    prefs = M.createCamPrefs();
    value = def();
    cards = M.createCameraCards({ tr: t, value, palette: prefs.palette, cls: 'sm-card sm-cam-card',
      onChange: v => { touched = true; value = v; prefs.setType(v); const d = getDrone(); if (d?.id != null) prefs.rememberDrone(d.id, v); },
      onPalette: p => prefs.setPalette(p) });
    holder.replaceChildren(cards.el);
  }).catch(err => { holder.replaceChildren(h('p', { class: 'small muted' }, String(err?.message || err))); });
  return {
    el, get value() { return value; },
    refresh() { if (touched || !cards) return; value = def(); cards.set(value); },
  };
}
