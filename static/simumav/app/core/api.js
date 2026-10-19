// Oyun arayüzünün tek API kapısı. simapi.js çekirdek ajanından gelir (HEPGO static/js/api.js ile aynı dışa aktarımlar).
// Hem `api.get` nesnesi hem de düz `get/post/...` adlandırılmış dışa aktarımlar desteklenir; eksik olanlar fetch ile tamamlanır.
import * as S from '../simapi.js';

const A = S.api || S.default || S;

async function fallback(method, url, body) {
  const opts = { method, headers: {}, credentials: 'same-origin' };
  if (body !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
  const res = await fetch(url, opts);
  const text = await res.text();
  let data = null;
  if (text) { try { data = JSON.parse(text); } catch { data = text; } }
  if (!res.ok) {
    const d = data && data.detail;
    const msg = (d && typeof d === 'object' ? d.message : d) || `HTTP ${res.status}`;
    const err = new Error(msg); err.status = res.status; throw err;
  }
  return data;
}

export const get = url => (A.get ? A.get(url) : fallback('GET', url));
export const post = (url, body) => (A.post ? A.post(url, body ?? {}) : fallback('POST', url, body ?? {}));
export const put = (url, body) => (A.put ? A.put(url, body) : fallback('PUT', url, body));
export const del = (url, body) => (A.del ? A.del(url, body) : fallback('DELETE', url, body));
export const ws = S.ws || (path => new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}${path}`));
export const upload = S.upload;

// Hata mesajı: {detail:{error,message}} ya da düz metin
export const errMsg = e => (e && (e.message || (e.detail && (e.detail.message || e.detail)))) || String(e);
