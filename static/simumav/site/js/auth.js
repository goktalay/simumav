// SIMUMAV kayıt / giriş — mastertool.download hesap servisi (uygulama kodu /api/meta.mt_app, varsayılan 'sv').
// Akış (VOLFAI account.js ile aynı): POST {mt}/api/{app}/auth/prelogin {email} → {kdf:{alg,iter,salt}}
//   master = PBKDF2(şifre, salt, iter); auth_hash = b64(PBKDF2(master, şifre, 1)); şifre sunucuya gitmez.
//   login {email, auth_hash, device, app_version} → {token, user}  (client:'web' GÖNDERİLMEZ: Bearer belirteci gerekir)
//   → POST /api/session {token} → simumav çerezi → /app
//   register {email, name, auth_hash, brand} → doğrulama bekleme ekranı; resend-verify; forgot {email, brand}
const APP_VERSION = 'site-1.0';

const utf8 = s => new TextEncoder().encode(s);
const b64enc = bytes => btoa(String.fromCharCode(...bytes));
function b64dec(s) { const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/')); const out = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i); return out; }
async function pbkdf2(keyBytes, saltBytes, iterations, len = 32) {
  const key = await crypto.subtle.importKey('raw', keyBytes, 'PBKDF2', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: saltBytes, iterations }, key, len * 8));
}
export async function computeAuthHash(password, kdf) {
  const master = await pbkdf2(utf8(password), b64dec(kdf.salt), kdf.iter, 32);
  return b64enc(await pbkdf2(master, utf8(password), 1, 32));
}
function deviceName() {
  const ua = navigator.userAgent || '';
  const os = /Android/i.test(ua) ? 'Android' : /iPhone|iPad/i.test(ua) ? 'iOS' : /Windows/i.test(ua) ? 'Windows' : /Mac/i.test(ua) ? 'macOS' : /Linux/i.test(ua) ? 'Linux' : 'Web';
  return `SIMUMAV Web (${os})`;
}

class ApiError extends Error { constructor(code, status, retry) { super(code); this.code = code; this.status = status; this.retry = retry; } }

async function call(url, body, headers = {}) {
  let res;
  try {
    res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-sshm': '1', ...headers }, body: JSON.stringify(body), credentials: 'include' });
  } catch (e) { throw new ApiError('network', 0); }
  let data = null; try { data = await res.json(); } catch (e) { /* gövdesiz */ }
  if (!res.ok) {
    const code = data?.code || data?.detail?.error || (res.status === 429 ? 'rate_limited' : res.status === 401 ? 'bad_credentials' : 'generic');
    const retry = res.status === 429 ? Math.max(5, parseInt(res.headers.get('Retry-After') || '60', 10) || 60) : 0;
    throw new ApiError(code, res.status, retry);
  }
  return data || {};
}

export function initAuth({ t }) {
  const root = document.getElementById('auth');
  if (!root) return null;
  const msg = root.querySelector('#auth-msg'), title = root.querySelector('#auth-title');
  const views = [...root.querySelectorAll('[data-view]')];
  const forms = { login: root.querySelector('#f-login'), register: root.querySelector('#f-register'), forgot: root.querySelector('#f-forgot') };
  const devBtn = root.querySelector('#dev-login');
  let meta = null, lastFocus = null, waitTimer = 0, lastEmail = '';

  const say = (kind, text) => { msg.hidden = !text; msg.className = 'msg ' + kind; msg.textContent = text || ''; };
  const busy = (form, on) => form.querySelectorAll('button, input').forEach(el => { el.disabled = on; });
  const errText = e => {
    if (e instanceof ApiError) return t('err.' + e.code) !== 'err.' + e.code ? t('err.' + e.code) : t('err.generic');
    return t('err.generic');
  };
  function wait(form, secs) {   // 429: geri sayım
    clearInterval(waitTimer);
    let s = secs;
    const tick = () => { say('wait', t('auth.wait').replace('{s}', s)); if (s-- <= 0) { clearInterval(waitTimer); busy(form, false); say('', ''); } };
    busy(form, true); tick(); waitTimer = setInterval(tick, 1000);
  }
  async function getMeta() {
    if (meta) return meta;
    try { const r = await fetch('/api/meta', { credentials: 'same-origin' }); if (r.ok) meta = await r.json(); } catch (e) { /* statik önizleme */ }
    if (!meta?.mt_url) throw new ApiError('network', 0);
    meta.mt_app = meta.mt_app || 'sv';
    return meta;
  }
  const acct = async path => { const m = await getMeta(); return `${m.mt_url.replace(/\/$/, '')}/api/${m.mt_app}${path}`; };

  function show(view) {
    views.forEach(v => { v.hidden = v.dataset.view !== view; });
    title.textContent = t(view === 'verify' ? 'auth.verify.title' : `auth.${view}.title`);
    say('', '');
    root.hidden = false; document.body.style.overflow = 'hidden';
    if (view !== 'verify') root.querySelector(`[data-view="${view}"] input`)?.focus();
    devBtn.hidden = !(window.SIMUMAV_DEV === 1 || window.SIMUMAV_DEV === '1');
  }
  function close() { root.hidden = true; document.body.style.overflow = ''; clearInterval(waitTimer); lastFocus?.focus?.(); }

  document.addEventListener('click', e => {
    const a = e.target.closest('[data-auth]');
    if (a) { e.preventDefault(); if (root.hidden) lastFocus = a; show(a.dataset.auth); return; }
    if (e.target.closest('[data-auth-close]')) close();
  });
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && !root.hidden) close(); });

  async function openSession(body) {
    const r = await fetch('/api/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), credentials: 'same-origin' });
    if (!r.ok) throw new ApiError('session', r.status);
    location.href = '/app';
  }

  forms.login.addEventListener('submit', async e => {
    e.preventDefault(); const f = e.target; const email = f.email.value.trim().toLowerCase(), password = f.password.value;
    busy(f, true); say('', '');
    try {
      const pre = await call(await acct('/auth/prelogin'), { email });
      if (!pre?.kdf?.salt) throw new ApiError('generic', 500);
      const auth_hash = await computeAuthHash(password, pre.kdf);
      const data = await call(await acct('/auth/login'), { email, auth_hash, device: deviceName(), app_version: APP_VERSION });
      if (!data?.token) throw new ApiError('generic', 500);
      await openSession({ token: data.token });
    } catch (err) {
      if (err.retry) return wait(f, err.retry);
      if (err.code === 'unverified') { lastEmail = email; return verifyView(email); }
      say('err', errText(err));
    } finally { if (!waitTimer) busy(f, false); else f.querySelectorAll('input').forEach(i => { i.disabled = false; }); }
  });

  function verifyView(email) {
    show('verify');
    root.querySelector('#verify-text').textContent = t('auth.verify.text').replace('{email}', email);
  }

  forms.register.addEventListener('submit', async e => {
    e.preventDefault(); const f = e.target;
    const email = f.email.value.trim().toLowerCase(), name = f.name.value.trim(), password = f.password.value;
    say('', '');
    if (password.length < 8) return say('err', t('auth.pwshort'));
    if (password !== f.password2.value) return say('err', t('auth.pwmismatch'));
    busy(f, true);
    try {
      const m = await getMeta();
      const pre = await call(await acct('/auth/prelogin'), { email });
      const auth_hash = await computeAuthHash(password, pre.kdf);
      await call(await acct('/auth/register'), { email, name, auth_hash, brand: m.mt_app });
      lastEmail = email; verifyView(email);
    } catch (err) {
      if (err.retry) return wait(f, err.retry);
      say('err', errText(err));
    } finally { busy(f, false); }
  });

  forms.forgot.addEventListener('submit', async e => {
    e.preventDefault(); const f = e.target; const email = f.email.value.trim().toLowerCase();
    busy(f, true); say('', '');
    try { const m = await getMeta(); await call(await acct('/auth/forgot'), { email, brand: m.mt_app }); say('ok', t('auth.forgot.sent')); }
    catch (err) { if (err.retry) return wait(f, err.retry); say('err', errText(err)); }
    finally { busy(f, false); }
  });

  root.querySelector('#resend').addEventListener('click', async e => {
    e.preventDefault();
    try { const m = await getMeta(); await call(await acct('/auth/resend-verify'), { email: lastEmail, brand: m.mt_app }); say('ok', t('auth.verify.sent')); }
    catch (err) { say('err', errText(err)); }
  });

  devBtn.addEventListener('click', async () => {
    const name = forms.login.email.value.trim() || 'dev';
    try { await openSession({ dev_user: name.split('@')[0] }); } catch (err) { say('err', errText(err)); }
  });

  return { show, close };
}
