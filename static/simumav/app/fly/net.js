// SIMUMAV › Uç — küçük REST yardımcısı (yalnız simumav /api/*; hesap servisine doğrudan çağrı YOK). Çerez (smsid) same-origin ile gider;
// yazma isteklerinde Origin denetimi sunucuda (§7). Hata: {detail:{error,message}} → Error(message) + .status.
export class NetError extends Error { constructor(status, message, error) { super(message); this.status = status; this.error = error; } }
async function req(method, url, body) {
  const res = await fetch(url, { method, credentials: 'same-origin', headers: body !== undefined ? { 'Content-Type': 'application/json' } : {}, body: body !== undefined ? JSON.stringify(body) : undefined });
  const txt = await res.text();
  let data = null; try { data = txt ? JSON.parse(txt) : null; } catch { data = txt; }
  if (!res.ok) {
    const d = data?.detail;
    throw new NetError(res.status, (d && (d.message || d.error)) || (typeof d === 'string' ? d : null) || `İstek başarısız (${res.status})`, d?.error);
  }
  return data;
}
export const net = {
  get: url => req('GET', url),
  post: (url, body = {}) => req('POST', url, body),
  put: (url, body = {}) => req('PUT', url, body),
  del: url => req('DELETE', url),
  raw: async (method, url, body, type) => {   // ikili yükleme (kayıt parçaları)
    const res = await fetch(url, { method, body, credentials: 'same-origin', headers: { 'Content-Type': type } });
    const txt = await res.text(); let data = null; try { data = txt ? JSON.parse(txt) : null; } catch { data = txt; }
    if (!res.ok) throw new NetError(res.status, data?.detail?.message || `İstek başarısız (${res.status})`);
    return data;
  },
};
export const wsUrl = path => (/^wss?:/.test(path) ? path : `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}${path.startsWith('/') ? '' : '/'}${path}`);
