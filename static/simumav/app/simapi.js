// SIMUMAV API sarmalayıcısı — HEPGO static/js/api.js ile AYNI dışa aktarımlar (ApiError, api{get,post,put,patch,del}, upload, fileUrl, videoUrl,
// logActivity, getUploadCfg, setUploadCfg, throttleBytes, uploadMany, UploadCanceled, uploadChunked, uploadLarge) — HEPGO simülatör modülleri
// (`/sim/*.js`, `../api.js` içe aktarır) ve SIMUMAV oyun arayüzü bunu kullanır. Farklar:
//  • Hata gövdesi `{detail:{error,message}}` → ApiError.status / .code / .message.
//  • 401 → `/` (tanıtım/giriş) yönlendirmesi + `simumav:unauthorized` olayı; 429 → `simumav:ratelimited` (retry_after).
//  • Yükleme yok (v1): upload* işlevleri uyumluluk için var, sunucu 404 döner. Resim küçültme (imgopt) yok.
//  • `ws(path)` yardımcı: aynı kökende WebSocket URL'si (`/ws/fly/<sim_id>`).
export class ApiError extends Error {
  constructor(status, message, code) { super(message); this.status = status; this.code = code || null; }
}

const QUIET = /\/api\/(fly\/\d+$|meta)|[?&](after|since)=/;
let inflight = 0, showT = null, barEl = null;
function bar() {
  if (!barEl) { barEl = document.createElement('div'); barEl.className = 'net-progress'; barEl.setAttribute('role', 'progressbar'); barEl.setAttribute('aria-label', 'Yükleniyor'); document.body.append(barEl); }
  return barEl;
}
function busy(on) {
  inflight += on ? 1 : -1;
  if (inflight > 0 && !showT && !barEl?.classList.contains('on')) showT = setTimeout(() => { showT = null; if (inflight > 0) bar().classList.add('on'); }, 250);
  if (inflight <= 0) { inflight = 0; clearTimeout(showT); showT = null; barEl?.classList.remove('on'); }
}

let redirecting = false;
export function unauthorized(msg) {
  window.dispatchEvent(new CustomEvent('simumav:unauthorized', { detail: msg }));
  if (redirecting || location.pathname === '/' || location.pathname === '/index.html') return;
  redirecting = true;
  const sonra = encodeURIComponent(location.pathname + location.search + location.hash);
  location.assign(`/?giris=1&sonra=${sonra}`);
}

function detailOf(data) {
  const d = data && data.detail;
  if (d && typeof d === 'object' && !Array.isArray(d)) return { message: d.message || d.error || 'İstek başarısız', code: d.error || null, extra: d };
  if (Array.isArray(d)) return { message: 'Eksik veya hatalı bilgi girildi', code: 'invalid', extra: null };
  if (typeof d === 'string') return { message: d, code: null, extra: null };
  return { message: null, code: null, extra: null };
}

async function request(method, url, body) {
  const track = method === 'GET' && !QUIET.test(url);
  if (track) busy(true);
  try { return await send(method, url, body); } finally { if (track) busy(false); }
}

async function send(method, url, body) {
  const opts = { method, headers: {}, credentials: 'same-origin' };
  if (body instanceof FormData) opts.body = body;
  else if (body !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
  const res = await fetch(url, opts);
  let data = null;
  const text = await res.text();
  if (text) { try { data = JSON.parse(text); } catch { data = text; } }
  if (!res.ok) {
    const { message, code, extra } = detailOf(data);
    const err = new ApiError(res.status, message || `İstek başarısız (${res.status})`, code);
    if (extra) err.detail = extra;
    if (res.status === 401 && !/\/api\/session$/.test(url)) unauthorized(message);
    if (res.status === 429) window.dispatchEvent(new CustomEvent('simumav:ratelimited', { detail: { retry_after: extra?.retry_after || Number(res.headers.get('Retry-After')) || 30, message } }));
    throw err;
  }
  return data;
}

export const api = {
  get: url => request('GET', url),
  post: (url, body) => request('POST', url, body ?? {}),
  put: (url, body) => request('PUT', url, body),
  patch: (url, body) => request('PATCH', url, body ?? {}),
  del: (url, body) => request('DELETE', url, body),
};

// WebSocket adresi (aynı köken): ws('/ws/fly/12') → wss://simumav.com/ws/fly/12
export const ws = path => `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}${path.startsWith('/') ? path : `/${path}`}`;

// Oturum yardımcıları: hesap servisi belirteci → SIMUMAV oturumu (çerez); çıkış ikisini de kapatır.
export const session = {
  open: token => api.post('/api/session', { token }),
  dev: dev_user => api.post('/api/session', { dev_user }),
  me: () => api.get('/api/session'),
  close: token => api.del('/api/session', token ? { token } : undefined),
};

// Büyük dosyalar için ilerleme bildiren yükleme (uyumluluk; SIMUMAV v1'de yükleme ucu yok)
export async function upload(url, formData, onProgress, { signal } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new DOMException('İptal', 'AbortError')); return; }
    const xhr = new XMLHttpRequest();
    const onAbort = () => xhr.abort();
    const cleanup = () => signal?.removeEventListener('abort', onAbort);
    xhr.open('POST', url);
    xhr.upload.onprogress = e => { if (e.lengthComputable) onProgress?.(Math.round(e.loaded * 100 / e.total)); };
    xhr.onload = () => {
      cleanup();
      let data = null;
      try { data = JSON.parse(xhr.responseText); } catch { /* boş yanıt */ }
      if (xhr.status >= 200 && xhr.status < 300) return resolve(data);
      if (xhr.status === 401) unauthorized();
      const { message, code } = detailOf(data);
      reject(new ApiError(xhr.status, message || `Yükleme başarısız (${xhr.status})`, code));
    };
    xhr.onerror = () => { cleanup(); reject(new ApiError(0, 'Bağlantı hatası, yükleme tamamlanamadı')); };
    xhr.onabort = () => { cleanup(); reject(new DOMException('İptal', 'AbortError')); };
    signal?.addEventListener('abort', onAbort, { once: true });
    xhr.send(formData);
  });
}

// Dosya adresleri: SIMUMAV'da dosyalar yalnız ops uçlarından (bin/params/replay) ve parkur önizlemelerinden gelir
export const fileUrl = (path, w) => (path ? (path.startsWith('/') ? path : `/api/files/${path}`) + (w ? `?w=${w}` : '') : null);
export const videoUrl = path => (path ? `${fileUrl(path)}#t=0.1` : null);
export const trackPreviewUrl = id => `/api/tracks/${encodeURIComponent(id)}/preview.png`;

// Hareket kaydı: SIMUMAV'da sunucuya gönderilmez (denetim kayıtları sunucu tarafında); uyumluluk için yutulur
export function logActivity() { return Promise.resolve(); }

// ---------- yükleme ayarları + hız sınırı (uyumluluk; davranış api.js ile aynı) ----------
const UPLOAD_CFG_KEY = 'upload.cfg';
const UPLOAD_CFG_DEFAULTS = { concurrency: 3, rateKBps: 0 };
const clampConc = v => Math.min(6, Math.max(1, Math.round(Number(v)) || UPLOAD_CFG_DEFAULTS.concurrency));
const clampRate = v => Math.max(0, Math.round(Number(v)) || 0);
let uploadCfg = { ...UPLOAD_CFG_DEFAULTS };
try {
  const raw = JSON.parse(localStorage.getItem(UPLOAD_CFG_KEY) || '{}');
  if (raw && typeof raw === 'object') uploadCfg = { concurrency: clampConc(raw.concurrency), rateKBps: clampRate(raw.rateKBps) };
} catch { /* gizli pencere */ }
export function getUploadCfg() { return { ...uploadCfg }; }
export function setUploadCfg(partial) {
  if (partial && typeof partial === 'object') {
    if ('concurrency' in partial) uploadCfg.concurrency = clampConc(partial.concurrency);
    if ('rateKBps' in partial) uploadCfg.rateKBps = clampRate(partial.rateKBps);
  }
  try { localStorage.setItem(UPLOAD_CFG_KEY, JSON.stringify(uploadCfg)); } catch { /* */ }
  uploadThrottle.setRate(uploadCfg.rateKBps * 1024);
  window.dispatchEvent(new CustomEvent('caymaz:upload-cfg', { detail: { ...uploadCfg } }));
  return { ...uploadCfg };
}
const _now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
const uploadThrottle = {
  rate: uploadCfg.rateKBps * 1024, tokens: 0, last: _now(),
  _refill() { const now = _now(); const dt = (now - this.last) / 1000; this.last = now; this.tokens = this.rate > 0 ? Math.min(this.rate, this.tokens + dt * this.rate) : 0; },
  setRate(bps) { this._refill(); this.rate = Math.max(0, Math.round(bps) || 0); this.tokens = Math.min(this.tokens, this.rate); },
  async take(bytes, signal) {
    bytes = Math.max(0, bytes || 0);
    while (bytes > 0) {
      if (signal?.aborted) throw new DOMException('İptal', 'AbortError');
      if (!this.rate) return;
      this._refill();
      const avail = Math.min(bytes, this.tokens);
      if (avail > 0) { this.tokens -= avail; bytes -= avail; }
      if (bytes <= 0) return;
      await new Promise(r => setTimeout(r, Math.min(1000, Math.max(20, (bytes / this.rate) * 1000))));
    }
  },
};
export function throttleBytes(bytes, signal) { return uploadThrottle.take(bytes, signal); }
export function uploadMany(items, worker, { concurrency, onItem, signal } = {}) {
  const list = [...items];
  const getN = () => (concurrency != null ? clampConc(concurrency) : clampConc(getUploadCfg().concurrency));
  return new Promise(resolve => {
    const ok = [], failed = [];
    let idx = 0, running = 0, settled = false;
    const finish = () => { if (!settled) { settled = true; resolve({ ok, failed }); } };
    const pump = () => {
      if (settled) return;
      while (running < getN() && idx < list.length && !signal?.aborted) {
        const i = idx++; const item = list[i]; running++;
        Promise.resolve().then(() => worker(item, i)).then(
          res => { ok.push(res); try { onItem?.(item, i, null, res); } catch { /* */ } },
          err => { failed.push({ item, err }); try { onItem?.(item, i, err); } catch { /* */ } },
        ).finally(() => { running--; pump(); });
      }
      if (running === 0 && (idx >= list.length || signal?.aborted)) finish();
    };
    if (!list.length) return finish();
    pump();
  });
}
export class UploadCanceled extends Error {
  constructor() { super('Yükleme iptal edildi'); this.canceled = true; }
}
// SIMUMAV v1: parça parça yükleme uçları yok — çağrılırsa anlaşılır hata
export async function uploadChunked() { throw new ApiError(404, 'SIMUMAV\'da dosya yükleme yok', 'not_supported'); }
export async function uploadLarge() { throw new ApiError(404, 'SIMUMAV\'da dosya yükleme yok', 'not_supported'); }
