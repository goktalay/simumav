// SIMUMAV §25 — 3B pilot avatarı: saf çekirdek (DOM/three yok; node testi tests/test_simumav_avatar.mjs).
// Sunucu eşi app/simumav/avatar.py (aynı sabitler; doğrulama sunucuda bağlayıcı, burada yalnız arayüz için normalize).
export const SKINS = { s1: '#ffdbac', s2: '#f7e0c3', s3: '#f1c9a5', s4: '#e8b58a', s5: '#e0ac69', s6: '#c68642', s7: '#8d5524', s8: '#6b4226' };
export const PATCHES = ['none', 'star', 'wing', 'bolt', 'chevron', 'target', 'shield', 'cross'];
export const ACCESSORIES = ['none', 'mic', 'crest', 'antenna', 'stripe'];
// Düzenleyici paletleri (serbest renk seçici de var; sunucu her #rrggbb'yi kabul eder)
export const HELMET_COLORS = ['#1e3a5f', '#f8fafc', '#111111', '#b91c1c', '#d9a441', '#0369a1', '#8c8c8c', '#be185d', '#ea580c', '#0e7490', '#16a34a', '#7c3aed'];
export const VISOR_COLORS = ['#f5c542', '#9fd3ff', '#1a1a1a', '#f08080', '#374151', '#22d3ee', '#a3e635', '#fb923c'];
export const SUIT_COLORS = ['#1e3a5f', '#7c3aed', '#0f766e', '#b91c1c', '#374151', '#0369a1', '#4d7c0f', '#be185d', '#ea580c', '#0e7490', '#57534e', '#1f2937'];
export const PATCH_COLORS = ['#f5c542', '#ffffff', '#9fd3ff', '#d9a441', '#f08080', '#22c55e', '#e11d48', '#111111'];
// §28 KARAKTER YARATMA — seçenek listeleri (avatar.py ile birebir; node testi karşılaştırır)
export const BODIES = ['m', 'f'];
export const BUILDS = ['slim', 'avg', 'broad'];
export const FACES = ['oval', 'round', 'square', 'long', 'heart'];
export const EYES = ['almond', 'round', 'narrow', 'wide'];
export const BROWS = ['straight', 'arched', 'angled', 'soft'];
export const BROW_W = ['thin', 'medium', 'thick'];
export const NOSES = ['small', 'straight', 'wide', 'pointed'];
export const MOUTHS = ['neutral', 'smile', 'grin', 'serious'];
export const BEARDS = ['none', 'stubble', 'mustache', 'goatee', 'full'];
export const GLASSES = ['none', 'aviator', 'sun'];
export const HAIRS = ['short', 'buzz', 'spiky', 'sidepart', 'curly', 'mohawk', 'bald', 'long', 'ponytail', 'bun', 'bob'];
export const HEADGEAR = ['helmet', 'none', 'cap', 'headset'];
export const OUTFITS = ['suit', 'jacket', 'casual'];
export const ENUMS = { body: BODIES, build: BUILDS, face: FACES, eyes: EYES, brows: BROWS, brow_w: BROW_W, nose: NOSES, mouth: MOUTHS, beard: BEARDS, glasses: GLASSES, hair: HAIRS, headgear: HEADGEAR, outfit: OUTFITS };
export const COLOR_KEYS = ['helmet', 'visor', 'suit', 'patch_color', 'eye_color', 'hair_color'];
export const BOOL_KEYS = ['mirror', 'freckles', 'mole', 'visor_open'];
// Düzenleyicide cinsiyete göre önce gösterilen saç modelleri (her iki beden de HER stili seçebilir; liste yalnız sıralama + rastgele olasılığı)
export const HAIR_BY_BODY = { m: ['short', 'buzz', 'spiky', 'sidepart', 'curly', 'mohawk', 'bald'], f: ['long', 'ponytail', 'bun', 'bob', 'curly', 'short', 'sidepart'] };
export const HAIR_NATURAL = ['#1b1b1b', '#3b2a1e', '#6b4423', '#8b5a2b', '#9a3b1b', '#d6b370', '#e8dcb5', '#9ca3af', '#f1f1f1'];
export const HAIR_FANCY = ['#e11d48', '#ec4899', '#7c3aed', '#2563eb', '#10b981', '#f97316'];
export const HAIR_COLORS = [...HAIR_NATURAL, ...HAIR_FANCY];
export const EYE_COLORS = ['#5b3a1e', '#2a1a10', '#8e6b2f', '#3f7d4e', '#3b82c4', '#7d8a96', '#b7791f'];
export const DEFAULT = { v: 2, helmet: '#1e3a5f', visor: '#f5c542', mirror: true, suit: '#1e3a5f', skin: 's4', patch: 'wing', patch_color: '#f5c542', accessory: 'mic',
  body: 'm', build: 'avg', face: 'oval', eyes: 'almond', eye_color: '#5b3a1e', brows: 'straight', brow_w: 'medium', nose: 'straight',
  mouth: 'smile', beard: 'none', freckles: false, mole: false, glasses: 'none', hair: 'short', hair_color: '#3b2a1e',
  headgear: 'helmet', visor_open: false, outfit: 'suit' };
// Eski 2B karakterler (img/pilots/pNN.svg) → 3B karşılık (avatar.py LEGACY ile aynı)
export const LEGACY = {
  p01: { helmet: '#1e3a5f', suit: '#1e3a5f', skin: 's4', visor: '#f5c542', mirror: true, patch: 'wing', patch_color: '#f5c542', accessory: 'mic' },
  p02: { helmet: '#f8fafc', suit: '#7c3aed', skin: 's3', visor: '#f08080', mirror: false, patch: 'bolt', patch_color: '#f5c542', accessory: 'none' },
  p03: { helmet: '#111111', suit: '#0f766e', skin: 's8', visor: '#9fd3ff', mirror: true, patch: 'chevron', patch_color: '#9fd3ff', accessory: 'stripe' },
  p04: { helmet: '#b91c1c', suit: '#b91c1c', skin: 's6', visor: '#1a1a1a', mirror: true, patch: 'star', patch_color: '#f5c542', accessory: 'crest' },
  p05: { helmet: '#d9a441', suit: '#374151', skin: 's2', visor: '#374151', mirror: true, patch: 'wing', patch_color: '#d9a441', accessory: 'mic' },
  p06: { helmet: '#0369a1', suit: '#0369a1', skin: 's7', visor: '#f08080', mirror: false, patch: 'target', patch_color: '#f5c542', accessory: 'antenna' },
  p07: { helmet: '#8c8c8c', suit: '#4d7c0f', skin: 's1', visor: '#9fd3ff', mirror: false, patch: 'shield', patch_color: '#f5c542', accessory: 'none' },
  p08: { helmet: '#f0f0f0', suit: '#be185d', skin: 's2', visor: '#f08080', mirror: true, patch: 'star', patch_color: '#f0f0f0', accessory: 'mic' },
  p09: { helmet: '#ea580c', suit: '#ea580c', skin: 's6', visor: '#1a1a1a', mirror: true, patch: 'cross', patch_color: '#ffffff', accessory: 'stripe' },
  p10: { helmet: '#0e7490', suit: '#0e7490', skin: 's5', visor: '#f5c542', mirror: true, patch: 'chevron', patch_color: '#f5c542', accessory: 'mic' },
};
// HEPGO §44 yapay zekâ pilot: "AI" kasklı özel avatar (seviye → şerit rengi)
export const BOT_LEVEL_COLOR = { easy: '#22c55e', normal: '#f59e0b', hard: '#ef4444' };
export function botAvatar(level = 'normal') {
  return { ...DEFAULT, helmet: '#2b2f36', visor: '#ff3b3b', mirror: true, suit: '#3a3f47', skin: 's4', patch: 'target', patch_color: BOT_LEVEL_COLOR[level] || BOT_LEVEL_COLOR.normal, accessory: 'stripe', headgear: 'helmet', visor_open: false, bot: true, level };
}

const HEX = /^#[0-9a-f]{6}$/i;
export const legacy = ch => ({ ...DEFAULT, ...(LEGACY[ch] || LEGACY.p01) });

/** Herhangi bir girdi (nesne | JSON | null) → tam ayar; geçersiz alan karakter varsayılanına düşer (v1 kayıtlar §28 alanlarını DEFAULT'tan alır). */
export function normAvatar(a, character = 'p01') {
  const base = legacy(character);
  if (typeof a === 'string') { try { a = JSON.parse(a); } catch { a = null; } }
  if (!a || typeof a !== 'object' || Array.isArray(a)) return base;
  const out = { ...base };
  for (const k of COLOR_KEYS) if (typeof a[k] === 'string' && HEX.test(a[k])) out[k] = a[k].toLowerCase();
  for (const k of BOOL_KEYS) if (typeof a[k] === 'boolean') out[k] = a[k];
  if (a.skin in SKINS) out.skin = a.skin;
  if (PATCHES.includes(a.patch)) out.patch = a.patch;
  if (ACCESSORIES.includes(a.accessory)) out.accessory = a.accessory;
  for (const [k, list] of Object.entries(ENUMS)) if (list.includes(a[k])) out[k] = a[k];
  if (a.bot) { out.bot = true; out.level = a.level || 'normal'; }
  out.v = 2;
  return out;
}

/** Şema alanları (sunucuya giden gövde + önbellek anahtarı sırası). */
export const AVATAR_FIELDS = ['helmet', 'visor', 'mirror', 'suit', 'skin', 'patch', 'patch_color', 'accessory', 'body', 'build', 'face', 'eyes', 'eye_color', 'brows', 'brow_w',
  'nose', 'mouth', 'beard', 'freckles', 'mole', 'glasses', 'hair', 'hair_color', 'headgear', 'visor_open', 'outfit'];
/** Sunucuya gönderilecek gövde (yalnız şema alanları). */
export const avatarBody = a => { const n = normAvatar(a); return Object.fromEntries(AVATAR_FIELDS.map(k => [k, n[k]])); };

/** Kararlı önbellek anahtarı (alan sırası sabit). */
export function avatarKey(a, size = 128) {
  const n = normAvatar(a);
  return ['v2', ...AVATAR_FIELDS.map(k => (typeof n[k] === 'boolean' ? (n[k] ? 1 : 0) : n[k])), n.bot ? `ai-${n.level}` : '', size].join('|');
}

/** Oyuncu (salon/skor satırı) → avatar ayarı: bot → AI kasklı; avatarı yoksa varsayılan. */
export const playerAvatar = p => (p && (p.is_bot || (p.id != null && Number(p.id) < 0)) ? botAvatar(p.level || 'normal') : normAvatar(p?.avatar));

/** Ağırlıklı seçim: [[değer, ağırlık], …] */
function wpick(rnd, pairs) {
  const tot = pairs.reduce((s, [, w]) => s + w, 0);
  let r = rnd() * tot;
  for (const [v, w] of pairs) { r -= w; if (r < 0) return v; }
  return pairs[pairs.length - 1][0];
}
// §28 rastgele karakter olasılıkları (cinsiyete uygun: kadında sakal yok, saç modelleri bedene göre ağırlıklı ama her stil mümkün)
export const RANDOM_W = {
  hair: { m: { short: 24, buzz: 14, spiky: 14, sidepart: 14, curly: 9, mohawk: 5, bald: 8, long: 4, ponytail: 3, bun: 3, bob: 2 },
    f: { long: 24, ponytail: 18, bun: 14, bob: 14, curly: 10, short: 7, sidepart: 6, spiky: 2, buzz: 2, mohawk: 2, bald: 1 } },
  beard: { none: 45, stubble: 20, mustache: 10, goatee: 10, full: 15 },
  brow_w: { m: { thin: 10, medium: 50, thick: 40 }, f: { thin: 45, medium: 45, thick: 10 } },
  face: { m: { oval: 25, round: 15, square: 35, long: 15, heart: 10 }, f: { oval: 35, round: 20, square: 8, long: 12, heart: 25 } },
  headgear: { helmet: 40, none: 30, cap: 15, headset: 15 },
  glasses: { none: 70, aviator: 15, sun: 15 },
};
/** Rastgele avatar (düzenleyicide "Rastgele"); rnd: 0..1 üreteci (test için enjekte edilir). opts.body: beden sabit ("Cinsiyeti koru"). */
export function randomAvatar(rnd = Math.random, { body = null } = {}) {
  const pick = arr => arr[Math.floor(rnd() * arr.length) % arr.length];
  const W = RANDOM_W;
  const b = BODIES.includes(body) ? body : (rnd() < 0.5 ? 'm' : 'f');
  const hg = wpick(rnd, Object.entries(W.headgear));
  return normAvatar({ helmet: pick(HELMET_COLORS), visor: pick(VISOR_COLORS), mirror: rnd() < 0.6, suit: pick(SUIT_COLORS), skin: pick(Object.keys(SKINS)),
    patch: pick(PATCHES), patch_color: pick(PATCH_COLORS), accessory: pick(ACCESSORIES),
    body: b, build: wpick(rnd, [['slim', 30], ['avg', 50], ['broad', 20]]), face: wpick(rnd, Object.entries(W.face[b])), eyes: pick(EYES),
    eye_color: pick(EYE_COLORS), brows: pick(BROWS), brow_w: wpick(rnd, Object.entries(W.brow_w[b])), nose: pick(NOSES), mouth: pick(MOUTHS),
    beard: b === 'm' ? wpick(rnd, Object.entries(W.beard)) : 'none', freckles: rnd() < 0.15, mole: rnd() < 0.1, glasses: wpick(rnd, Object.entries(W.glasses)),
    hair: wpick(rnd, Object.entries(W.hair[b])), hair_color: rnd() < 0.1 ? pick(HAIR_FANCY) : pick(HAIR_NATURAL),
    headgear: hg, visor_open: hg === 'helmet' && rnd() < 0.5, outfit: wpick(rnd, [['suit', 55], ['jacket', 25], ['casual', 20]]) });
}

/** Cinsiyet değişince saç/sakal uyumu (düzenleyici): kadına geçişte sakal kalkar; saç o bedenin listesinde değilse varsayılan saça döner. */
export function switchBody(a, body) {
  const n = normAvatar(a);
  if (!BODIES.includes(body) || n.body === body) return n;
  const out = { ...n, body };
  if (body === 'f') out.beard = 'none';
  if (!HAIR_BY_BODY[body].includes(out.hair)) out.hair = body === 'f' ? 'long' : 'short';
  return out;
}

/** Renk yardımcıları (2B yedek çizim + gölgeleme). */
export function shade(hex, f) {
  const n = parseInt(String(hex).slice(1), 16) || 0;
  const ch = s => Math.max(0, Math.min(255, Math.round(f < 0 ? ((n >> s) & 255) * (1 + f) : ((n >> s) & 255) + (255 - ((n >> s) & 255)) * f)));
  return `#${[16, 8, 0].map(s => ch(s).toString(16).padStart(2, '0')).join('')}`;
}
