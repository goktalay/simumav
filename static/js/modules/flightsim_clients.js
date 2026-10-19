// CAYSIM istemcileri kartı (Uçuş Simülatörü sihirbaz sayfası; sözleşme docs/caysim-api.md §9).
// CAYSIM = Unreal Engine 5 + Cesium masaüstü görselleştirme istemcisi; HEPGO'ya istemci koduyla (<domain>/<key>) bağlanır, fizik/SITL burada kalır.
// Kart: liste (ad, platform, durum, son görülme, sürüm, açık oturum) · "İstemci ekle" → kod BİR KEZ gösterilir (kopyala) · "Kodu yenile" · "Sil".
// flightsim.js bağlar: clientsCard({ canWrite, onCount }).el "CAYSIM İstemcileri" sekmesine konur; onCount(n) sekme rozetini besler. Sahte kipte (mock) kart çizilmez.
import { api } from '../api.js';
import { clear, confirmDialog, field, h, modal, toast, toastError, t as tr } from '../ui.js';

const API = '/api/drone/sim/clients';
const PLATFORM_NAME = { windows: 'Windows', linux: 'Linux', macos: 'macOS', other: 'Diğer' };
const copy = async (txt, what) => { try { await navigator.clipboard.writeText(txt); toast(what); } catch { toast('Kopyalanamadı; metni elle seçin', 'err'); } };

function ago(iso) {
  if (!iso) return null;
  const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return tr('{n} sn önce', { n: s });
  if (s < 3600) return tr('{n} dk önce', { n: Math.round(s / 60) });
  if (s < 86400) return tr('{n} sa önce', { n: Math.round(s / 3600) });
  return tr('{n} gün önce', { n: Math.round(s / 86400) });
}

// Kod yalnız bu pencerede görünür (köprü kodu kalıbı: drone.js codeModal)
function codeModal(name, code, { renewed = false } = {}) {
  modal({
    title: tr(renewed ? '{name} · yeni istemci kodu' : '{name} · istemci kodu', { name }),
    body: h('div', null,
      h('div', { class: 'dr-key dr-code' }, code),
      h('p', { class: 'small', style: { marginTop: '10px' } }, h('b', null, 'CAYSIM uygulamasına bu kodu girin.'),
        ' İstemci, kodla bu şirkete ve size bağlanır; sunucu adresini koddaki alan adından bulur. Kod bir daha gösterilmez; kaybolursa "Kodu yenile" ile yenisi üretilir.'),
      renewed ? h('p', { class: 'small muted' }, 'Eski kod hemen geçersiz oldu; bağlı istemci düştüyse yeni kodla yeniden bağlanmalıdır.') : null),
    actions: [{ label: 'Kapat' }, { label: 'Kopyala', class: 'primary', onClick: async () => { await copy(code, 'İstemci kodu kopyalandı'); return true; } }],
  });
}

function addForm(platforms, onDone) {
  const name = h('input', { type: 'text', maxlength: '80', placeholder: 'ör. Simülatör PC-1' });
  const platform = h('select', null, h('option', { value: '' }, '—'), platforms.map(p => h('option', { value: p }, PLATFORM_NAME[p] || p)));
  const note = h('input', { type: 'text', maxlength: '200', placeholder: 'isteğe bağlı' });
  modal({
    title: 'CAYSIM istemcisi ekle',
    body: h('div', null,
      h('p', { class: 'small muted' }, 'Masaüstündeki CAYSIM (Unreal Engine + Cesium) görselleştirme istemcisi için kayıt. Oluşturulan istemci kodu bir kez gösterilir; istemcinin açtığı oturumların sahibi siz olursunuz.'),
      field('İstemci adı', name), field('Platform', platform), field('Not', note)),
    actions: [{ label: 'Vazgeç' }, { label: 'Oluştur', class: 'primary', onClick: async () => {
      if (!name.value.trim()) { toast('İstemci adı gerekli', 'err'); return false; }
      try {
        const r = await api.post(API, { name: name.value.trim(), platform: platform.value || null, note: note.value.trim() || null });
        codeModal(name.value.trim(), r.code);
        onDone();
        return true;
      } catch (err) { toastError(err); return false; }
    } }],
  });
}

export function clientsCard({ canWrite, onCount = null }) {
  const el = h('div', { class: 'fs-clients' });
  let rows = [], platforms = ['windows', 'linux', 'macos', 'other'];
  const draw = () => {
    onCount?.(rows.length);
    if (!rows.length && !canWrite) { clear(el, h('div', { class: 'card empty' }, h('p', null, 'Kayıtlı CAYSIM istemcisi yok.'))); return; }
    clear(el, h('div', { class: 'card card-pad fs-open no-collapse' },
      h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '10px', flexWrap: 'wrap' } },
        h('h3', { style: { margin: 0 } }, tr('CAYSIM istemcileri ({n})', { n: rows.length })),
        canWrite ? h('button', { class: 'btn sm primary', onclick: () => addForm(platforms, refresh) }, 'İstemci ekle') : null),
      h('p', { class: 'small muted' }, 'CAYSIM, Unreal Engine 5 + Cesium ile çalışan masaüstü görselleştirme istemcisidir; fizik ve SITL HEPGO\'da kalır. İstemci, kodla bağlanır; açtığı oturumlar "Açık Oturumlar" sekmesinde CAYSIM rozetiyle görünür.'),
      rows.length ? h('div', { class: 'fs-open-list' }, rows.map(c => h('div', { class: 'fs-open-row' },
        h('div', { class: 'fs-open-main' }, h('b', null, c.name),
          c.active ? null : h('span', { class: 'badge gray' }, 'Pasif'),
          h('span', { class: `badge ${c.online ? 'green' : c.status === 'CEVRIMICI' ? 'blue' : 'gray'}` }, c.online ? 'Bağlı' : c.status === 'CEVRIMICI' ? 'Çevrimiçi' : 'Çevrimdışı'),
          c.has_key ? null : h('span', { class: 'badge yellow' }, 'Kodu yok'),
          c.sessions ? h('span', { class: 'badge purple' }, tr('{n} oturum', { n: c.sessions })) : null,
          h('div', { class: 'small muted' }, [PLATFORM_NAME[c.platform] || c.platform, c.owner_name, c.host, c.client_ver ? tr('sürüm {v}', { v: c.client_ver }) : null,
            c.last_seen ? tr('son görülme {t}', { t: ago(c.last_seen) }) : 'Hiç bağlanmadı', c.note].filter(Boolean).join(' · '))),
        canWrite ? h('div', { class: 'pill-group' },
          h('button', { class: 'btn sm primary', title: 'CAYSIM uygulamasına girilecek istemci kodunu yeniden üretir; eski kod geçersiz olur', onclick: async () => {
            if (!await confirmDialog('Kodu yenile', tr('{name} için yeni istemci kodu üretilsin mi? Eski kod hemen geçersiz olur; bağlı istemci düşer.', { name: c.name }), { okLabel: 'Yenile', danger: true })) return;
            try { const r = await api.post(`${API}/${c.id}/rekey`); codeModal(c.name, r.code, { renewed: true }); refresh(); } catch (err) { toastError(err); }
          } }, 'Kodu yenile'),
          h('button', { class: 'btn sm danger', onclick: async () => {
            if (!await confirmDialog('İstemciyi sil', tr('{name} silinsin mi? İstemci bir daha bağlanamaz; açık oturumlar kapanmaz.', { name: c.name }), { okLabel: 'Sil', danger: true })) return;
            try { await api.del(`${API}/${c.id}`); toast('İstemci silindi'); refresh(); } catch (err) { toastError(err); }
          } }, 'Sil')) : null))) : null));
  };
  const refresh = async () => {
    try { const r = await api.get(API); rows = r.clients || []; platforms = r.platforms || platforms; } catch { rows = []; }
    draw();
  };
  refresh();
  return { el, refresh };
}
