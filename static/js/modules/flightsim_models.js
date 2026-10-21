// Uçuş Simülatörü — görsel model kütüphanesi (docs/ucus-simulatoru.md §12). Sihirbazda tip kartının altındaki "Model" bölümü:
// • Kart ızgarası: GET /api/drone/sim/models?type=… → dahili (Caymaz V3 / Delta / Quad / Hexa / Heli; her tip için her zaman var) + tasarım
//   modülünden eklenen + simülatöre yüklenen modeller; küçük resim, ad, kaynak rozeti (Dahili / Tasarım / Yüklenen), boyut, Hazır / Dönüştürülüyor.
// • Dönüşüm TARAYICIDA (PROD'da node/occt yok): STEP → occt wasm (step-worker.js; kaba lineer sapma, üçgen ≤ ~100k için kademeli) → renge göre
//   birleştirilmiş three mesh'ler (mm → m) → GLTFExporter (binary) → PUT /models/{id}/glb. OBJ → OBJLoader → GLB; GLTF → GLTFLoader → GLB; GLB olduğu gibi.
//   Sonraki kullanıcılar sunucudaki GLB'yi alır (ready=true). İlerleme çubuğu kartta.
// • Küçük resim: model ilk seçilince / listede eksikse flightsim3d.snapshotModel (3/4 açı, 320×240 PNG) → PUT /models/{id}/thumb (dahili için de;
//   id 'builtin:caymaz' + ?type=vtol). Yazma izni yoksa "Önizleme hazırlanıyor…" yer tutucu kalır.
// • Yönelim paneli (yüklenen/tasarım modelleri): burun ekseni, yukarı ekseni, 90° döndürme (yaw/roll), ölçek (doğrudan ya da kanat açıklığı /
//   çapraz uzunluk girilerek otomatik), konum ofseti, pervane (modelde prop/propeller/rotor düğümü varsa döner; yoksa kuyruk/burun/elle prosedürel
//   pervane); canlı önizlemede uygulanır (setType), Kaydet → PUT /models/{id} orient_json.
// Dışa: modelPicker({ getType, canWrite, getSim, onSelect, mock }) → { el, refresh(type), get selected, selectionFor(type) }; convertToGlb; putBinary.
import { api } from '../api.js';
import { clear, confirmDialog, h, modal, segmented, toast, toastError, t as tr } from '../ui.js';
import { parseStep } from '../step3d.js';

const API = '/api/drone/sim/models';
const LIB = '/static/vendor/three/';
export const MAX_TRIS = 100000;
const DEFLECTIONS = [1.5, 3, 6, 12, 25];   // mm: STEP lineer sapma kademeleri (üçgen sayısı MAX_TRIS'i aşarsa bir sonrakine geçilir)
const AXES = ['+x', '-x', '+y', '-y', '+z', '-z'];
const SOURCE_LABEL = { builtin: 'Dahili', design: 'Tasarım', upload: 'Yüklenen' };
const SOURCE_TONE = { builtin: 'gray', design: 'purple', upload: 'blue' };
const TYPE_NAME = { multirotor: 'Multikopter', hexarotor: 'Hexakopter', helikopter: 'Helikopter', sabit_kanat: 'Sabit Kanat', vtol: 'VTOL', interceptor: 'INTERCEPTOR' };
const LAYOUT_SHORT = { classic: 'Klasik', elevon: 'Elevon', vtail: 'V-kuyruk' };   // §13.1 kart rozeti (flightsim_airframe.LAYOUT_SHORT ile aynı)
const fmtSize = b => (b == null ? '—' : b >= 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`);
const isBuiltin = m => !!m && String(m.id).startsWith('builtin:');

let libsP = null;
const loadThree = () => (libsP ??= Promise.all(['three.module.min.js', 'GLTFLoader.js', 'GLTFExporter.js', 'OBJLoader.js', 'BufferGeometryUtils.js'].map(f => import(LIB + f)))
  .then(([T, G, E, O, B]) => ({ T, GLTFLoader: G.GLTFLoader, GLTFExporter: E.GLTFExporter, OBJLoader: O.OBJLoader, mergeGeometries: B.mergeGeometries }))
  .catch(e => { libsP = null; throw e; }));

// Ham gövde PUT (GLB / PNG): XHR ile yükleme ilerlemesi; JSON yanıt
export function putBinary(url, data, contentType, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url);
    xhr.setRequestHeader('Content-Type', contentType);
    xhr.upload.onprogress = e => { if (e.lengthComputable) onProgress?.(Math.round(e.loaded * 100 / e.total)); };
    xhr.onload = () => {
      let d = null; try { d = JSON.parse(xhr.responseText); } catch { /* */ }
      if (xhr.status >= 200 && xhr.status < 300) return resolve(d);
      if (xhr.status === 401) window.dispatchEvent(new Event('caymaz:unauthorized'));
      reject(Object.assign(new Error((d && typeof d.detail === 'string' && d.detail) || `HTTP ${xhr.status}`), { status: xhr.status }));
    };
    xhr.onerror = () => reject(new Error('Bağlantı hatası'));
    xhr.send(data);
  });
}
function postForm(url, fd, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', url);
    xhr.upload.onprogress = e => { if (e.lengthComputable) onProgress?.(Math.round(e.loaded * 100 / e.total)); };
    xhr.onload = () => {
      let d = null; try { d = JSON.parse(xhr.responseText); } catch { /* */ }
      if (xhr.status >= 200 && xhr.status < 300) return resolve(d);
      if (xhr.status === 401) window.dispatchEvent(new Event('caymaz:unauthorized'));
      reject(Object.assign(new Error((d && typeof d.detail === 'string' && d.detail) || `HTTP ${xhr.status}`), { status: xhr.status }));
    };
    xhr.onerror = () => reject(new Error('Bağlantı hatası'));
    xhr.send(fd);
  });
}

// ======================================================================
// Dönüşüm: STEP / OBJ / GLTF / GLB → GLB (ArrayBuffer). onProgress({ stage, pct?, text, tris? })
// ======================================================================
export async function convertToGlb(buffer, ext, onProgress = () => {}) {
  ext = String(ext || '').toLowerCase().replace(/^\./, '');
  const { T, GLTFLoader, GLTFExporter, OBJLoader, mergeGeometries } = await loadThree();
  let root;
  if (ext === 'step' || ext === 'stp') {
    let res = null, tris = 0;
    for (let i = 0; i < DEFLECTIONS.length; i++) {   // kademeli sadeleştirme: üçgen sayısı sınırı aşarsa daha kaba sapma
      const d = DEFLECTIONS[i];
      onProgress({ stage: 'parse', text: tr('STEP çözümleniyor (sapma {d} mm)…', { d }) });
      res = await parseStep(buffer, { params: { linearUnit: 'millimeter', linearDeflectionType: 'absolute_value', linearDeflection: d, angularDeflection: 0.6 }, onPhase: txt => onProgress({ stage: 'parse', text: txt }) });
      tris = (res.meshes || []).reduce((n, m) => n + (m.index ? m.index.length / 3 : (m.position ? m.position.length / 9 : 0)), 0);
      onProgress({ stage: 'parse', text: tr('{n} üçgen (sapma {d} mm)', { n: Math.round(tris).toLocaleString('tr'), d }), tris });
      if (tris <= MAX_TRIS || i === DEFLECTIONS.length - 1) break;
    }
    if (!res || !res.meshes || !res.meshes.length) throw new Error('STEP dosyasında geometri yok');
    onProgress({ stage: 'build', text: 'Mesh birleştiriliyor…' });
    // renge göre birleştir (çizim çağrısı azalır; renkler korunur); mm → m
    const byColor = new Map();
    for (const m of res.meshes) {
      if (!m.position || !m.position.length) continue;
      const g = new T.BufferGeometry();
      g.setAttribute('position', new T.BufferAttribute(m.position, 3));
      if (m.index && m.index.length) g.setIndex(new T.BufferAttribute(m.index, 1));
      else g.setIndex(Array.from({ length: m.position.length / 3 }, (_, k) => k));
      if (m.normal && m.normal.length === m.position.length) g.setAttribute('normal', new T.BufferAttribute(m.normal, 3)); else g.computeVertexNormals();
      const c = m.color && m.color.length === 3 ? m.color.map(v => Math.round(Math.max(0, Math.min(1, v)) * 255) / 255) : [0.6, 0.66, 0.74];
      const key = c.join(',');
      if (!byColor.has(key)) byColor.set(key, { color: c, geos: [] });
      byColor.get(key).geos.push(g);
    }
    root = new T.Group(); root.name = 'model';
    let i = 0;
    for (const { color, geos } of byColor.values()) {
      const merged = geos.length === 1 ? geos[0] : mergeGeometries(geos, false);
      if (!merged) continue;
      merged.scale(0.001, 0.001, 0.001);   // mm → m (STEP birimi milimetre istendi)
      const mat = new T.MeshStandardMaterial({ color: new T.Color(color[0], color[1], color[2]), metalness: 0.15, roughness: 0.55, side: T.DoubleSide });
      const mesh = new T.Mesh(merged, mat); mesh.name = `govde_${++i}`;
      root.add(mesh);
    }
  } else if (ext === 'obj') {
    onProgress({ stage: 'parse', text: 'OBJ çözümleniyor…' });
    root = new OBJLoader().parse(new TextDecoder().decode(buffer));
    root.traverse(o => { if (o.isMesh) { o.material = new T.MeshStandardMaterial({ color: 0x9aa8bd, metalness: 0.15, roughness: 0.55, side: T.DoubleSide }); if (!o.geometry.attributes.normal) o.geometry.computeVertexNormals(); } });
  } else if (ext === 'gltf' || ext === 'glb') {
    if (ext === 'glb') return buffer;   // zaten hedef biçim
    onProgress({ stage: 'parse', text: 'glTF çözümleniyor…' });
    root = await new Promise((resolve, reject) => new GLTFLoader().parse(new TextDecoder().decode(buffer), '', g => resolve(g.scene), reject));
  } else throw new Error(tr('Desteklenmeyen dosya türü: {e}', { e: ext || '?' }));
  onProgress({ stage: 'export', text: 'GLB yazılıyor…' });
  const glb = await new GLTFExporter().parseAsync(root, { binary: true, onlyVisible: true });
  if (!(glb instanceof ArrayBuffer)) throw new Error('GLB üretilemedi');
  root.traverse(o => { o.geometry?.dispose?.(); o.material?.dispose?.(); });
  return glb;
}

// Yönelim yardımcıları: eksen dizesi ↔ vektör; 90° döndürmeler
const vec = a => { const v = [0, 0, 0]; v['xyz'.indexOf(a[1])] = a[0] === '-' ? -1 : 1; return v; };
const str = v => { const i = v.findIndex(x => Math.abs(x) > 0.5); return `${v[i] < 0 ? '-' : '+'}${'xyz'[i]}`; };
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const neg = v => v.map(x => -x);
const fixUp = o => { if (o.forward[1] === o.up[1]) o.up = AXES.find(a => a[1] !== o.forward[1]); return o; };

// ======================================================================
// Kart ızgarası + yönelim paneli
// ======================================================================
export function modelPicker({ getType, canWrite, getSim, onSelect, mock = false, getLayout = null }) {   // getLayout (§13.1): seçili kontrol düzeni → uyan modeller öne + "Önerilen" rozeti
  const S = { type: getType(), list: [], meta: {}, sel: {}, busy: new Set(), want: {} };   // sel: tip → model (seçim tipe göre hatırlanır)
  const grid = h('div', { class: 'fs-models' });
  const info = h('div', { class: 'small muted fs-models-info' });
  const panel = h('div', { class: 'fs-orient', hidden: true });
  const uploadBtn = h('button', { class: 'btn sm', type: 'button', hidden: !canWrite, onclick: () => openUpload() }, '⬆ Model yükle');
  const designBtn = h('button', { class: 'btn sm', type: 'button', hidden: true, onclick: () => openDesign() }, '🗂 Sistemdeki dosyalardan ekle');
  const head = h('div', { class: 'fs-models-head' }, h('span', { class: 'small muted' }, 'Model'), h('span', { class: 'pill-group' }, uploadBtn, designBtn));
  const el = h('div', { class: 'fs-models-wrap' }, head, grid, info, panel);

  const be = mock ? mockModels() : {
    list: type => api.get(`${API}?type=${encodeURIComponent(type)}`),
    designFiles: () => api.get(`${API}/design-files`),
    fromDesign: body => api.post(`${API}/from-design`, body),
    patch: (id, body) => api.put(`${API}/${encodeURIComponent(id)}`, body),
    del: id => api.del(`${API}/${encodeURIComponent(id)}`),
    file: m => fetch(m.file_url, { credentials: 'same-origin' }).then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.arrayBuffer(); }),
    putGlb: (m, glb, onP) => putBinary(`${API}/${encodeURIComponent(m.id)}/glb`, glb, 'application/octet-stream', onP),
    putThumb: (m, blob) => putBinary(`${API}/${encodeURIComponent(m.id)}/thumb${isBuiltin(m) ? `?type=${encodeURIComponent(m.type)}` : ''}`, blob, 'image/png'),
    upload: (fd, onP) => postForm(API, fd, onP),
  };

  const selected = () => S.sel[S.type] || null;
  const card = m => {
    const on = selected()?.id === m.id, lay = getLayout ? getLayout() : null;
    // Önbellek damgası yalnız sunucu adreslerine: blob: (sahte kip / yerel küçük resim) sorgu dizesi kabul etmez (ERR_FILE_NOT_FOUND)
    const thumbSrc = m.thumb_url && !m.thumb_url.startsWith('blob:') ? `${m.thumb_url}${m.thumb_url.includes('?') ? '&' : '?'}v=${m._v || 0}` : m.thumb_url;
    const thumb = m.thumb_url ? h('img', { class: 'fs-model-img', src: thumbSrc, alt: m.name, loading: 'lazy' })
      : h('div', { class: 'fs-model-img fs-model-ph' }, S.busy.has(m.id) ? '…' : tr('Önizleme hazırlanıyor…'));
    const prog = h('div', { class: 'fs-model-prog', hidden: true }, h('i'), h('span'));
    const status = m.ready ? h('span', { class: 'badge green' }, 'Hazır') : h('span', { class: 'badge yellow' }, S.busy.has(m.id) ? 'Dönüştürülüyor' : 'GLB bekliyor');
    const c = h('button', { type: 'button', class: `fs-model ${on ? 'on' : ''}`, 'data-id': m.id, onclick: () => pick(m) },
      thumb, prog,
      h('span', { class: 'fs-model-main' }, h('b', null, m.name), h('span', { class: 'small muted' }, m.desc || m.file_name || '')),
      h('span', { class: 'fs-model-meta small' }, h('span', { class: `badge ${SOURCE_TONE[m.source] || 'gray'}` }, SOURCE_LABEL[m.source] || m.source),
        m.layout ? h('span', { class: `badge ${lay && m.layout === lay ? 'green' : 'gray'} fs-model-layout`, 'data-layout': m.layout, title: tr('Kontrol düzeni') }, `${LAYOUT_SHORT[m.layout] || m.layout}${lay && m.layout === lay ? ` · ${tr('Önerilen')}` : ''}`) : null,   // §13.1
        m.size != null ? h('span', { class: 'muted' }, fmtSize(m.size)) : null, status));
    c._prog = prog;
    return c;
  };
  // §13.1: seçili düzene uyan modeller önce (kararlı sıralama; düzeni bilinmeyenler yerinde kalır)
  const sorted = () => { const lay = getLayout ? getLayout() : null; return lay ? [...S.list].sort((a, b) => (b.layout === lay) - (a.layout === lay)) : S.list; };
  const draw = () => { clear(grid, S.list.length ? sorted().map(card) : h('div', { class: 'small muted' }, 'Model yükleniyor…')); drawPanel(); };
  const setProg = (m, pct, text) => {
    const c = grid.querySelector(`.fs-model[data-id="${CSS.escape(String(m.id))}"]`); if (!c) return;
    c._prog.hidden = pct == null; c._prog.querySelector('i').style.width = `${pct || 0}%`; c._prog.querySelector('span').textContent = text || '';
  };

  // Seçim: hazır değilse (STEP/OBJ/GLTF GLB'si yok) tarayıcıda dönüştür → PUT; sonra önizleme + küçük resim
  const pick = async m => {
    if (!m.ready) {
      if (!canWrite) { toast(tr('Bu modelin GLB\'si henüz üretilmedi; yazma izni olan bir kullanıcı seçince tarayıcıda dönüştürülür.'), 'err'); return; }
      if (S.busy.has(m.id)) return;
      try { await convertModel(m); } catch (err) { toastError(err); return; }
    }
    S.sel[S.type] = m;
    draw();
    onSelect?.(m);
    await ensureThumb(m);
  };
  const convertModel = async m => {
    S.busy.add(m.id); draw();
    try {
      setProg(m, 5, tr('Dosya indiriliyor…'));
      const buf = await be.file(m);
      setProg(m, 20, tr('Dönüştürülüyor…'));
      const glb = await convertToGlb(buf, m.format, p => setProg(m, p.stage === 'parse' ? 35 : p.stage === 'build' ? 60 : 70, p.text));
      const upd = await be.putGlb(m, glb, pct => setProg(m, 70 + pct * 0.3, tr('Sunucuya yükleniyor… %{p}', { p: pct })));
      Object.assign(m, upd, { _v: (m._v || 0) + 1 });
      toast(tr('{n} GLB\'ye dönüştürüldü ({s})', { n: m.name, s: fmtSize(glb.byteLength) }));
    } finally { S.busy.delete(m.id); setProg(m, null); draw(); }
  };
  // Küçük resim: yoksa ve yazma izni varsa önizleme sahnesinden çek → PUT (dahili için de; VTOL varyantı ?type=)
  const ensureThumb = async m => {
    const sim = getSim();
    if (m.thumb_url || !canWrite || !sim?.snapshotModel || S.busy.has(`t:${m.id}`)) return;
    S.busy.add(`t:${m.id}`);
    try {
      const blob = await sim.snapshotModel(m.type, m);
      if (!blob) return;
      const upd = await be.putThumb(m, blob);
      Object.assign(m, { thumb_url: upd.thumb_url, _v: Date.now() });
      draw();
    } catch (err) { console.warn('küçük resim üretilemedi:', err?.message || err); } finally { S.busy.delete(`t:${m.id}`); }
  };
  let thumbQueue = Promise.resolve();
  const ensureThumbs = () => { for (const m of S.list) if (!m.thumb_url && m.ready) thumbQueue = thumbQueue.then(() => ensureThumb(m)); };

  // ---------- yönelim paneli (yüklenen / tasarım modelleri) ----------
  let applyT = 0;
  const live = () => { clearTimeout(applyT); applyT = setTimeout(() => { const m = selected(); if (m) { onSelect?.(m); setTimeout(drawInfo, 400); } }, 150); };
  const drawInfo = () => {
    const m = selected(), mi = getSim()?.modelInfo;
    if (!m || !mi?.bbox) { info.textContent = ''; return; }
    const [w, l, hh] = mi.bbox.size;
    info.textContent = `${tr('Boyut: genişlik {w} m · uzunluk {l} m · yükseklik {h} m', { w: w.toFixed(2), l: l.toFixed(2), h: hh.toFixed(2) })} · ${mi.props ? tr('{n} pervane düğümü', { n: mi.props }) : tr('pervane düğümü yok')}`;
  };
  const drawPanel = () => {
    const m = selected();
    panel.hidden = !m || isBuiltin(m) || !canWrite;
    if (panel.hidden) { clear(panel); drawInfo(); return; }
    const o = m.orient = fixUp({ forward: '+y', up: '+z', scale: 1, offset: [0, 0, 0], prop: { mode: 'none', pos: [0, 0, 0], r: 0.3 }, ...(m.orient || {}), prop: { mode: 'none', pos: [0, 0, 0], r: 0.3, ...(m.orient?.prop || {}) } });
    const axisOpts = AXES.map(a => [a, a.toUpperCase()]);
    const fwdSeg = segmented(axisOpts, o.forward, v => { o.forward = v; fixUp(o); redraw(); live(); });
    const upSeg = segmented(axisOpts, o.up, v => { o.up = v; if (o.up[1] === o.forward[1]) o.forward = AXES.find(a => a[1] !== o.up[1]); redraw(); live(); });
    const rot = (what) => () => {   // 90° döndürme: yaw = burun yukarı ekseni etrafında; roll = yukarı burun etrafında; pitch = burun sağ (f×u) etrafında
      const f = vec(o.forward), u = vec(o.up), r = cross(f, u);
      if (what === 'yaw') o.forward = str(r);                       // f → f×u (sağa 90°)
      else if (what === 'roll') o.up = str(neg(r));                 // u → −(f×u)
      else { o.forward = str(u); o.up = str(neg(f)); }              // pitch: burun yukarıya, yukarı geriye
      redraw(); live();
    };
    const scaleInp = h('input', { class: 'input mono fs-orient-num', type: 'number', step: 'any', min: '0.0001', value: o.scale, onchange: () => { o.scale = Math.max(1e-4, Number(scaleInp.value) || 1); live(); } });
    const spanInp = h('input', { class: 'input mono fs-orient-num', type: 'number', step: 'any', min: '0.01', placeholder: tr('ör. 3.03') });
    const spanBtn = h('button', { class: 'btn sm', type: 'button', onclick: () => {   // kanat açıklığı / çapraz uzunluk → ölçek (mevcut genişlikten oranla)
      const mi = getSim()?.modelInfo, want = Number(spanInp.value);
      if (!mi?.bbox || !(want > 0)) { toast('Önce önizlemenin yüklenmesini bekleyin ve bir uzunluk girin', 'err'); return; }
      const cur = Math.max(mi.bbox.size[0], 1e-6);   // gövde X = kanat açıklığı (kopterde çapraz genişlik)
      o.scale = Number((o.scale * want / cur).toPrecision(6)); scaleInp.value = o.scale; live();
    } }, 'Uygula');
    const off = ['x', 'y', 'z'].map((k, i) => h('label', { class: 'fs-orient-off' }, h('span', { class: 'small muted' }, k.toUpperCase()),
      h('input', { class: 'input mono fs-orient-num', type: 'number', step: '0.01', value: o.offset[i], onchange: e => { o.offset[i] = Number(e.target.value) || 0; live(); } })));
    const propSeg = segmented([['none', 'Yok'], ['tail', 'Kuyruk (arkadan itiş)'], ['nose', 'Burun (çekiş)'], ['manual', 'Elle konum']], o.prop.mode, v => { o.prop.mode = v; redraw(); live(); });
    const propR = h('input', { class: 'input mono fs-orient-num', type: 'number', step: '0.01', min: '0.01', value: o.prop.r, onchange: () => { o.prop.r = Math.max(0.01, Number(propR.value) || 0.3); live(); } });
    const propPos = ['x', 'y', 'z'].map((k, i) => h('label', { class: 'fs-orient-off' }, h('span', { class: 'small muted' }, k.toUpperCase()),
      h('input', { class: 'input mono fs-orient-num', type: 'number', step: '0.01', value: o.prop.pos[i], onchange: e => { o.prop.pos[i] = Number(e.target.value) || 0; live(); } })));
    const hasProp = h('input', { type: 'checkbox', checked: m.has_prop !== false, onchange: () => { m.has_prop = hasProp.checked; live(); } });
    const saveBtn = h('button', { class: 'btn sm primary', type: 'button', onclick: async () => {
      try { const upd = await be.patch(m.id, { orient: o, has_prop: m.has_prop !== false }); Object.assign(m, upd); toast('Yönelim kaydedildi'); if (m.thumb_url) { m.thumb_url = null; draw(); ensureThumb(m); } } catch (err) { toastError(err); }
    } }, '💾 Kaydet');
    const delBtn = h('button', { class: 'btn sm danger', type: 'button', onclick: async () => {
      if (!await confirmDialog('Modeli sil', tr('"{n}" kütüphaneden silinsin mi? (Tasarım dosyasının aslı silinmez.)', { n: m.name }), { okLabel: 'Sil', danger: true })) return;
      try { await be.del(m.id); delete S.sel[S.type]; await refresh(S.type); toast('Model silindi'); } catch (err) { toastError(err); }
    } }, '🗑 Sil');
    const redraw = () => drawPanel();
    clear(panel,
      h('div', { class: 'fs-orient-row' }, h('span', { class: 'small muted' }, 'Burun ekseni'), fwdSeg),
      h('div', { class: 'fs-orient-row' }, h('span', { class: 'small muted' }, 'Yukarı ekseni'), upSeg),
      h('div', { class: 'fs-orient-row' }, h('span', { class: 'small muted' }, '90° döndür'), h('span', { class: 'pill-group' },
        h('button', { class: 'btn sm', type: 'button', onclick: rot('yaw') }, '↻ Yaw'), h('button', { class: 'btn sm', type: 'button', onclick: rot('pitch') }, '⤴ Pitch'), h('button', { class: 'btn sm', type: 'button', onclick: rot('roll') }, '⟳ Roll'))),
      h('div', { class: 'fs-orient-row' }, h('span', { class: 'small muted' }, 'Ölçek (birim → m)'), scaleInp,
        h('span', { class: 'small muted' }, tr(S.type === 'sabit_kanat' || S.type === 'vtol' ? 'ya da kanat açıklığı (m)' : 'ya da çapraz uzunluk (m)')), spanInp, spanBtn),
      h('div', { class: 'fs-orient-row' }, h('span', { class: 'small muted' }, 'Konum ofseti (m)'), ...off),
      h('div', { class: 'fs-orient-row' }, h('label', { class: 'check' }, hasProp, 'Modeldeki pervane düğümlerini döndür (prop / propeller / rotor)')),
      h('div', { class: 'fs-orient-row' }, h('span', { class: 'small muted' }, 'Pervane ekle'), propSeg,
        o.prop.mode !== 'none' ? [h('span', { class: 'small muted' }, 'yarıçap (m)'), propR] : null,
        o.prop.mode === 'manual' ? propPos : null),
      h('div', { class: 'fs-orient-row fs-orient-actions' }, saveBtn, delBtn));
    drawInfo();
  };

  // ---------- yükleme penceresi ----------
  const typeSeg = (val, onChange) => segmented(Object.entries(TYPE_NAME), val, onChange);
  const openUpload = () => {
    let type = S.type, pct = null;
    const fileInp = h('input', { type: 'file', accept: '.glb,.gltf,.step,.stp,.obj' });
    const nameInp = h('input', { class: 'input', placeholder: 'Model adı (boşsa dosya adı)' });
    const prog = h('div', { class: 'fs-model-prog fs-model-prog-inline', hidden: true }, h('i'), h('span'));
    const okBtn = h('button', { class: 'btn primary', onclick: async () => {
      const f = fileInp.files?.[0];
      if (!f) { toast('Bir dosya seçin', 'err'); return; }
      if (f.size > (S.meta.limits?.max_bytes || 50 * 1024 * 1024)) { toast('Dosya 50 MB sınırını aşıyor', 'err'); return; }
      okBtn.disabled = true; prog.hidden = false;
      const fd = new FormData(); fd.append('file', f, f.name); fd.append('type', type); if (nameInp.value.trim()) fd.append('name', nameInp.value.trim());
      try {
        const m = await be.upload(fd, p => { pct = p; prog.querySelector('i').style.width = `${p}%`; prog.querySelector('span').textContent = tr('Yükleniyor… %{p}', { p }); });
        dlg.close(); toast(tr('{n} yüklendi', { n: m.name }));
        if (type !== S.type) { toast(tr('Model {t} tipine eklendi; o tipi seçince görünür', { t: TYPE_NAME[type] })); await refresh(S.type); return; }
        await refresh(S.type);
        const mm = S.list.find(x => x.id === m.id); if (mm) pick(mm);
      } catch (err) { toastError(err); okBtn.disabled = false; prog.hidden = true; }
    } }, '⬆ Yükle');
    const dlg = modal({ title: 'Model yükle', body: h('div', { class: 'form-grid' },
      h('p', { class: 'small muted' }, 'GLB / GLTF / STEP / OBJ (≤ 50 MB). STEP ve OBJ dosyaları tarayıcınızda GLB\'ye dönüştürülür (STEP: mm; üçgen sayısı ~100 bine sadeleştirilir) ve sunucuda önbelleğe alınır.'),
      h('label', null, h('span', null, 'Dosya'), fileInp), h('label', null, h('span', null, 'Ad'), nameInp),
      h('div', null, h('span', { class: 'small muted' }, 'Dron tipi'), typeSeg(type, v => { type = v; })), prog),
    actions: [h('button', { class: 'btn', onclick: () => dlg.close() }, 'Vazgeç'), okBtn] });
  };
  // ---------- tasarım dosyalarından ekle ----------
  const openDesign = async () => {
    let rows = [];
    try { rows = await be.designFiles(); } catch (err) { toastError(err); return; }
    let type = S.type;
    const list = h('div', { class: 'fs-design-list' });
    const draw2 = () => clear(list, rows.length ? rows.map(r => h('button', { type: 'button', class: 'fs-design-row', onclick: async () => {
      try {
        const m = await be.fromDesign({ version_id: r.id, type });
        dlg.close(); toast(tr('{n} kütüphaneye eklendi', { n: m.name }));
        await refresh(S.type);
        const mm = S.list.find(x => x.id === m.id); if (mm) pick(mm);
      } catch (err) { toastError(err); }
    } },
      h('span', { class: 'fs-design-main' }, h('b', null, r.file_name), h('span', { class: 'small muted' }, [r.project_name, r.drawing_name, r.version != null ? `v${r.version}` : null].filter(Boolean).join(' › '))),
      h('span', { class: 'small muted' }, fmtSize(r.size), r.model_id ? h('span', { class: 'badge gray' }, 'kütüphanede') : null)))
      : h('div', { class: 'small muted' }, 'Tasarım modülünde 3B dosya (STEP/GLB/OBJ) bulunamadı.'));
    draw2();
    const dlg = modal({ title: 'Sistemdeki dosyalardan ekle', wide: true, body: h('div', null,
      h('p', { class: 'small muted' }, 'Endüstriyel Tasarım modülündeki çizim sürümlerinin 3B dosyaları. Seçilen dosya kopyalanmaz; GLB ve küçük resim tarayıcıda üretilip sunucuda saklanır.'),
      h('div', { class: 'fs-mode-row' }, h('span', { class: 'small muted' }, 'Dron tipi'), typeSeg(type, v => { type = v; })), list),
    actions: [h('button', { class: 'btn', onclick: () => dlg.close() }, 'Kapat')] });
  };

  async function refresh(type) {
    S.type = type || getType();
    try {
      const r = await be.list(S.type);
      S.meta = r; S.list = r.models || [];
      designBtn.hidden = !(canWrite && r.design_allowed);
      const want = S.want[S.type];   // §27 kayıtlı simülasyon: istenen model (listede varsa) bir kez seçilir
      if (want) { delete S.want[S.type]; const wm = S.list.find(m => String(m.id) === String(want.id)); if (wm) { S.sel[S.type] = want.orient && wm.source !== 'builtin' ? { ...wm, orient: want.orient } : wm; } }
      const cur = S.sel[S.type];
      S.sel[S.type] = (cur && S.list.find(m => m.id === cur.id)) || S.list.find(m => m.id === (r.defaults || {})[S.type]) || S.list[0] || null;
      if (S.sel[S.type] && cur && S.sel[S.type].id === cur.id) Object.assign(S.sel[S.type], { orient: cur.orient, has_prop: cur.has_prop });   // kaydedilmemiş yönelim korunur
    } catch (err) { S.list = []; toastError(err); }
    draw();
    ensureThumbs();
    return selected();
  }
  // prefer(type, {id, orient?}): §27 kayıtlı simülasyonun modeli — sonraki refresh(type) listede bulursa seçer
  return { el, refresh, get selected() { return selected(); }, selectionFor: type => S.sel[type] || null, prefer: (type, m) => { if (m?.id != null) S.want[type] = typeof m === 'object' ? m : { id: m }; }, redraw: draw, drawInfo, ensureThumbs };
}

// ======================================================================
// MOCK (?mock=1): dahili modeller + bellekte sahte yükleme
// ======================================================================
function mockModels() {
  const B = { caymaz: ['Caymaz V3', ['sabit_kanat', 'vtol'], 'glb', 'elevon'], delta: ['Delta kanat', ['sabit_kanat', 'vtol'], 'procedural', 'elevon'], talon: ['Talon V-kuyruk', ['sabit_kanat'], 'glb', 'vtail'], quad: ['Quad', ['multirotor'], 'procedural'], hexa: ['Hexa', ['hexarotor'], 'procedural'], heli: ['Heli', ['helikopter'], 'procedural'],
    icept_x4: ['INTERCEPTOR X4', ['interceptor'], 'glb'], p1sun: ['P1-SUN', ['interceptor'], 'glb'], sting: ['Sting', ['interceptor'], 'glb'] };
  const extra = [];
  let seq = 0;
  const thumbs = new Map();
  return {
    list: async type => ({ models: [...Object.entries(B).filter(([, v]) => v[1].includes(type)).map(([k, v]) => ({ id: `builtin:${k}`, name: type === 'vtol' && (k === 'caymaz' || k === 'delta') ? `VTOL-${v[0]}` : v[0], source: 'builtin', type, types: v[1], format: v[2], ready: true, has_prop: true, layout: v[3] || null, size: k === 'caymaz' ? 1500000 : k === 'talon' ? 44000 : null, thumb_url: thumbs.get(`builtin:${k}:${type}`) || null, glb_url: k === 'caymaz' ? '/static/models/caymaz-sim.glb' : k === 'talon' ? '/static/models/talon-vtail.glb' : null, orient: k === 'talon' ? { forward: '+x', up: '+y', scale: 1, offset: [0, 0, 0], prop: { mode: 'none', pos: [0, 0, 0], r: 0.3 } } : null })),
      ...extra.filter(m => m.type === type)], defaults: { multirotor: 'builtin:quad', hexarotor: 'builtin:hexa', helikopter: 'builtin:heli', sabit_kanat: 'builtin:caymaz', vtol: 'builtin:caymaz', interceptor: 'builtin:icept_x4' }, can_write: true, design_allowed: false, limits: { max_bytes: 50 * 1024 * 1024 } }),
    designFiles: async () => [],
    fromDesign: async () => { throw new Error('Sahte kipte yok'); },
    patch: async (id, body) => { const m = extra.find(x => x.id === id); Object.assign(m, body); return m; },
    del: async id => { const i = extra.findIndex(x => x.id === id); if (i >= 0) extra.splice(i, 1); return { ok: true }; },
    file: async m => m._buf,
    putGlb: async (m, glb) => { m._glb = glb; m.glb_url = URL.createObjectURL(new Blob([glb], { type: 'model/gltf-binary' })); m.ready = true; return { ...m }; },
    putThumb: async (m, blob) => { const u = URL.createObjectURL(blob); if (String(m.id).startsWith('builtin:')) thumbs.set(`${m.id}:${m.type}`, u); else m.thumb_url = u; return { thumb_url: u }; },
    upload: async fd => {
      const f = fd.get('file'); const ext = (f.name.split('.').pop() || '').toLowerCase();
      const m = { id: String(++seq), name: fd.get('name') || f.name.replace(/\.[^.]+$/, ''), source: 'upload', type: fd.get('type'), types: [fd.get('type')], format: ext === 'stp' ? 'step' : ext, size: f.size, ready: ext === 'glb', has_prop: true, thumb_url: null, glb_url: null, file_url: 'mock', file_name: f.name,
        orient: { forward: ext === 'step' || ext === 'stp' ? '+y' : '+z', up: ext === 'step' || ext === 'stp' ? '+z' : '+y', scale: 1, offset: [0, 0, 0], prop: { mode: 'none', pos: [0, 0, 0], r: 0.3 } }, _buf: await f.arrayBuffer() };
      if (ext === 'glb') { m._glb = m._buf; m.glb_url = URL.createObjectURL(new Blob([m._buf], { type: 'model/gltf-binary' })); }
      extra.push(m); return { ...m };
    },
  };
}
