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
export const DEFAULT = { v: 1, helmet: '#1e3a5f', visor: '#f5c542', mirror: true, suit: '#1e3a5f', skin: 's4', patch: 'wing', patch_color: '#f5c542', accessory: 'mic' };
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
  return { v: 1, helmet: '#2b2f36', visor: '#ff3b3b', mirror: true, suit: '#3a3f47', skin: 's4', patch: 'target', patch_color: BOT_LEVEL_COLOR[level] || BOT_LEVEL_COLOR.normal, accessory: 'stripe', bot: true, level };
}

const HEX = /^#[0-9a-f]{6}$/i;
export const legacy = ch => ({ ...DEFAULT, ...(LEGACY[ch] || LEGACY.p01) });

/** Herhangi bir girdi (nesne | JSON | null) → tam ayar; geçersiz alan karakter varsayılanına düşer. */
export function normAvatar(a, character = 'p01') {
  const base = legacy(character);
  if (typeof a === 'string') { try { a = JSON.parse(a); } catch { a = null; } }
  if (!a || typeof a !== 'object' || Array.isArray(a)) return base;
  const out = { ...base };
  for (const k of ['helmet', 'visor', 'suit', 'patch_color']) if (typeof a[k] === 'string' && HEX.test(a[k])) out[k] = a[k].toLowerCase();
  if (typeof a.mirror === 'boolean') out.mirror = a.mirror;
  if (a.skin in SKINS) out.skin = a.skin;
  if (PATCHES.includes(a.patch)) out.patch = a.patch;
  if (ACCESSORIES.includes(a.accessory)) out.accessory = a.accessory;
  if (a.bot) { out.bot = true; out.level = a.level || 'normal'; }
  out.v = 1;
  return out;
}

/** Sunucuya gönderilecek gövde (yalnız şema alanları). */
export const avatarBody = a => { const n = normAvatar(a); return { helmet: n.helmet, visor: n.visor, mirror: n.mirror, suit: n.suit, skin: n.skin, patch: n.patch, patch_color: n.patch_color, accessory: n.accessory }; };

/** Kararlı önbellek anahtarı (alan sırası sabit). */
export function avatarKey(a, size = 128) {
  const n = normAvatar(a);
  return ['v1', n.helmet, n.visor, n.mirror ? 'm' : 'g', n.suit, n.skin, n.patch, n.patch_color, n.accessory, n.bot ? `ai-${n.level}` : '', size].join('|');
}

/** Oyuncu (salon/skor satırı) → avatar ayarı: bot → AI kasklı; avatarı yoksa varsayılan. */
export const playerAvatar = p => (p && (p.is_bot || (p.id != null && Number(p.id) < 0)) ? botAvatar(p.level || 'normal') : normAvatar(p?.avatar));

/** Rastgele avatar (düzenleyicide "Zar"); rnd: 0..1 üreteci (test için enjekte edilir). */
export function randomAvatar(rnd = Math.random) {
  const pick = arr => arr[Math.floor(rnd() * arr.length) % arr.length];
  return normAvatar({ helmet: pick(HELMET_COLORS), visor: pick(VISOR_COLORS), mirror: rnd() < 0.6, suit: pick(SUIT_COLORS), skin: pick(Object.keys(SKINS)),
    patch: pick(PATCHES), patch_color: pick(PATCH_COLORS), accessory: pick(ACCESSORIES) });
}

/** Renk yardımcıları (2B yedek çizim + gölgeleme). */
export function shade(hex, f) {
  const n = parseInt(String(hex).slice(1), 16) || 0;
  const ch = s => Math.max(0, Math.min(255, Math.round(f < 0 ? ((n >> s) & 255) * (1 + f) : ((n >> s) & 255) + (255 - ((n >> s) & 255)) * f)));
  return `#${[16, 8, 0].map(s => ch(s).toString(16).padStart(2, '0')).join('')}`;
}
