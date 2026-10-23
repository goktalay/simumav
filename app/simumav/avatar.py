"""SIMUMAV 3B pilot avatarı + TOP 10 PİLOT (docs/simumav.md §25).

• Avatar ayarı `pilots.avatar` (JSON, v6 göçü). Biçim (sunucu doğrular; bilinmeyen alanlar atılır):
    {v:2, helmet:'#rrggbb', visor:'#rrggbb', mirror:bool, suit:'#rrggbb', skin:'s1'…'s8', patch:<PATCHES>, patch_color:'#rrggbb', accessory:<ACCESSORIES>,
     §28 KARAKTER YARATMA: body:m|f, build, face, eyes, eye_color, brows, brow_w, nose, mouth, beard, freckles:bool, mole:bool, glasses, hair, hair_color,
     headgear:helmet|none|cap|headset, visor_open:bool, outfit}
  v1 kayıtlar (yalnız kask/tulum alanları) geriye uyumlu: eksik §28 alanları `DEFAULT`tan (erkek, kısa saç, kasklı, vizör kapalı → eski görünüm).
  Eski 2B karakterler (p01…p10) `LEGACY` ile varsayılan 3B karşılığa eşlenir (göç NULL satırları doldurur; okumada da yedek).
  İstemci eşi: static/simumav/app/crew/avatar_core.js (aynı sabitler; node testi tests/test_simumav_avatar.mjs).
• Liderlik tablosu: `siralama(conn, period)` — formül §25.3 (aşağıda `PUAN`). Gizlilik: ad/e-posta maskesi YALNIZ burada (ham veri istemciye gitmez);
  `users.settings.lb_hidden` true olan kullanıcı listelenmez; botlar (match_players.is_bot / negatif kimlik) hiç sayılmaz.
"""
import json
import re
import time
from datetime import datetime, timedelta

HEX = re.compile(r'^#[0-9a-fA-F]{6}$')
SKINS = {'s1': '#ffdbac', 's2': '#f7e0c3', 's3': '#f1c9a5', 's4': '#e8b58a', 's5': '#e0ac69', 's6': '#c68642', 's7': '#8d5524', 's8': '#6b4226'}
PATCHES = ('none', 'star', 'wing', 'bolt', 'chevron', 'target', 'shield', 'cross')
ACCESSORIES = ('none', 'mic', 'crest', 'antenna', 'stripe')
# §28 KARAKTER YARATMA (beden · yüz · saç · kıyafet · başlık); istemci eşi avatar_core.js (aynı listeler — node testi birebir karşılaştırır)
BODIES = ('m', 'f')
BUILDS = ('slim', 'avg', 'broad')
FACES = ('oval', 'round', 'square', 'long', 'heart')
EYES = ('almond', 'round', 'narrow', 'wide')
BROWS = ('straight', 'arched', 'angled', 'soft')
BROW_W = ('thin', 'medium', 'thick')
NOSES = ('small', 'straight', 'wide', 'pointed')
MOUTHS = ('neutral', 'smile', 'grin', 'serious')
BEARDS = ('none', 'stubble', 'mustache', 'goatee', 'full')
GLASSES = ('none', 'aviator', 'sun')
HAIRS = ('short', 'buzz', 'spiky', 'sidepart', 'curly', 'mohawk', 'bald', 'long', 'ponytail', 'bun', 'bob')
HEADGEAR = ('helmet', 'none', 'cap', 'headset')
OUTFITS = ('suit', 'jacket', 'casual')
ENUMS = {'body': BODIES, 'build': BUILDS, 'face': FACES, 'eyes': EYES, 'brows': BROWS, 'brow_w': BROW_W, 'nose': NOSES, 'mouth': MOUTHS, 'beard': BEARDS,
         'glasses': GLASSES, 'hair': HAIRS, 'headgear': HEADGEAR, 'outfit': OUTFITS}
COLORS = ('helmet', 'visor', 'suit', 'patch_color', 'eye_color', 'hair_color')
BOOLS = ('mirror', 'freckles', 'mole', 'visor_open')
DEFAULT = {'v': 2, 'helmet': '#1e3a5f', 'visor': '#f5c542', 'mirror': True, 'suit': '#1e3a5f', 'skin': 's4', 'patch': 'wing', 'patch_color': '#f5c542', 'accessory': 'mic',
           'body': 'm', 'build': 'avg', 'face': 'oval', 'eyes': 'almond', 'eye_color': '#5b3a1e', 'brows': 'straight', 'brow_w': 'medium', 'nose': 'straight',
           'mouth': 'smile', 'beard': 'none', 'freckles': False, 'mole': False, 'glasses': 'none', 'hair': 'short', 'hair_color': '#3b2a1e',
           'headgear': 'helmet', 'visor_open': False, 'outfit': 'suit'}
MAX_JSON = 1500   # API girişi üst sınırı (bayt; §28 ile 600 → 1500)
# 2B karakter SVG'lerinin (static/simumav/app/img/pilots/pNN.svg) renkleri → 3B karşılık
LEGACY = {
    'p01': {'helmet': '#1e3a5f', 'suit': '#1e3a5f', 'skin': 's4', 'visor': '#f5c542', 'mirror': True, 'patch': 'wing', 'patch_color': '#f5c542', 'accessory': 'mic'},
    'p02': {'helmet': '#f8fafc', 'suit': '#7c3aed', 'skin': 's3', 'visor': '#f08080', 'mirror': False, 'patch': 'bolt', 'patch_color': '#f5c542', 'accessory': 'none'},
    'p03': {'helmet': '#111111', 'suit': '#0f766e', 'skin': 's8', 'visor': '#9fd3ff', 'mirror': True, 'patch': 'chevron', 'patch_color': '#9fd3ff', 'accessory': 'stripe'},
    'p04': {'helmet': '#b91c1c', 'suit': '#b91c1c', 'skin': 's6', 'visor': '#1a1a1a', 'mirror': True, 'patch': 'star', 'patch_color': '#f5c542', 'accessory': 'crest'},
    'p05': {'helmet': '#d9a441', 'suit': '#374151', 'skin': 's2', 'visor': '#374151', 'mirror': True, 'patch': 'wing', 'patch_color': '#d9a441', 'accessory': 'mic'},
    'p06': {'helmet': '#0369a1', 'suit': '#0369a1', 'skin': 's7', 'visor': '#f08080', 'mirror': False, 'patch': 'target', 'patch_color': '#f5c542', 'accessory': 'antenna'},
    'p07': {'helmet': '#8c8c8c', 'suit': '#4d7c0f', 'skin': 's1', 'visor': '#9fd3ff', 'mirror': False, 'patch': 'shield', 'patch_color': '#f5c542', 'accessory': 'none'},
    'p08': {'helmet': '#f0f0f0', 'suit': '#be185d', 'skin': 's2', 'visor': '#f08080', 'mirror': True, 'patch': 'star', 'patch_color': '#f0f0f0', 'accessory': 'mic'},
    'p09': {'helmet': '#ea580c', 'suit': '#ea580c', 'skin': 's6', 'visor': '#1a1a1a', 'mirror': True, 'patch': 'cross', 'patch_color': '#ffffff', 'accessory': 'stripe'},
    'p10': {'helmet': '#0e7490', 'suit': '#0e7490', 'skin': 's5', 'visor': '#f5c542', 'mirror': True, 'patch': 'chevron', 'patch_color': '#f5c542', 'accessory': 'mic'},
}


class AvatarHata(ValueError):
    pass


def legacy(character):
    return {**DEFAULT, **LEGACY.get(character or 'p01', LEGACY['p01'])}


def normalize(a, character='p01', strict=False):
    """Avatar JSON'u (dict | str | None) → tam, geçerli ayar. strict=True: geçersiz alan → AvatarHata (API girişi); False: geçersiz alan karakter
    varsayılanına düşer (okuma)."""
    base = legacy(character)
    if isinstance(a, str):
        try:
            a = json.loads(a)
        except ValueError:
            a = None
    if not isinstance(a, dict):
        if strict and a is not None:
            raise AvatarHata('avatar nesne olmalı')
        return base

    def bad(k):
        if strict:
            raise AvatarHata(f'avatar.{k} geçersiz')

    out = dict(base)
    for k in COLORS:
        if k in a:
            v = a[k]
            if isinstance(v, str) and HEX.match(v):
                out[k] = v.lower()
            else:
                bad(k)
    for k in BOOLS:
        if k in a:
            if isinstance(a[k], bool):
                out[k] = a[k]
            else:
                bad(k)
    for k, izin in (('skin', SKINS), ('patch', PATCHES), ('accessory', ACCESSORIES), *ENUMS.items()):
        if k in a:
            if isinstance(a[k], str) and a[k] in izin:
                out[k] = a[k]
            else:
                bad(k)
    out['v'] = 2
    return out


def dump(a):
    return json.dumps(a, separators=(',', ':'), sort_keys=True)


# ---------------------------------------------------------------- gizlilik maskeleri (YALNIZ sunucuda)
YILDIZ = '*****'


def _buyuk(ch):
    return {'i': 'İ', 'ı': 'I'}.get(ch, ch.upper()[:1] or ch)


def maske_ad(ad):
    """'Muhammed Kaderoğlu' → 'M***** K*****'; tek kelime → 'M*****'; orta adlar atılır (yalnız ad + soyad); harf uzunluğu sızmaz (sabit 5 yıldız).
    E-posta biçimli ad (hesap adı yoksa e-posta kullanılır) → yalnız yerel kısmın baş harfi. Boş → '*****'."""
    s = (ad or '').strip()
    if '@' in s:
        s = s.split('@', 1)[0]
    kelimeler = [w for w in re.split(r'[\s._\-]+', s) if w]
    harfler = []
    for w in kelimeler:
        ilk = next((c for c in w if c.isalnum()), None)
        if ilk:
            harfler.append(_buyuk(ilk))
    if not harfler:
        return YILDIZ
    secim = harfler[:1] + (harfler[-1:] if len(harfler) > 1 else [])
    return ' '.join(f'{h}{YILDIZ}' for h in secim)


def maske_eposta(e):
    """'mkaderoglu@gmail.com' → 'mk***@gm***.com'; alt alan adı: 'ab@mail.uni.edu.tr' → 'ab***@ma***.tr' (ilk etiketin 2 harfi + yalnız TLD);
    tek harfli yerel kısım → 'a***@…'; geçersiz → '***'."""
    s = (e or '').strip().lower()
    if s.count('@') != 1:
        return '***'
    yerel, alan = s.split('@')
    etiket = [x for x in alan.split('.') if x]
    if not yerel or not etiket:
        return '***'
    sol = f'{yerel[:2]}***'
    if len(etiket) < 2:
        return f'{sol}@{etiket[0][:2]}***'
    return f'{sol}@{etiket[0][:2]}***.{etiket[-1]}'


# ---------------------------------------------------------------- TOP 10 PİLOT sıralama formülü (§25.3)
PUAN = {
    'bot_only_weight': 0.5,      # rakiplerin hepsi yapay zekâysa karşılaşma puanı yarım sayılır (bota karşı puan çiftliği sınırlanır)
    'win_bonus': 300,            # galibiyet (karşılaşma kazananı)
    'pace_ref_s': 15.0,          # halka yarışı tempo: halka başına sn; ref altı her sn × 20 (en çok 200)
    'pace_k': 20, 'pace_max': 200,
    'disc_k': 1.5, 'disc_cap': 20, 'disc_min_s': 60,   # disiplin: ort. §42 puanı × 1,5 × min(uçuş, 20); yalnız ≥ 60 sn uçuşlar
    'icept_k': 0.5, 'icept_best': 10,                  # önleme: en iyi 10 uçuşun §24 puanı toplamı × 0,5
}
PERIODS = {'30d': 30, 'all': None}


def mac_puani(kind, rings, finished, rank, won, role=None, max_hold_s=0):
    """HEPGO §44 sonuç ekranı puanı (flightsim_match.js matchScore ile aynı)."""
    if kind == 'dogfight':
        return (1000 if won else 0) + (min(500, round(float(max_hold_s or 0) * 100)) if role == 'chaser' else 0)
    rk = int(rank or 99)
    return int(rings or 0) * 100 + ((250 + max(0, 200 - 50 * rk)) if finished else 0)


def tempo_puani(time_s, total):
    if time_s is None or not total:
        return 0
    pace = float(time_s) / float(total)
    return int(max(0, min(PUAN['pace_max'], round(PUAN['pace_k'] * (PUAN['pace_ref_s'] - pace)))))


def _since(period, now=None):
    gun = PERIODS[period]
    if gun is None:
        return None
    return (datetime.fromtimestamp(now or time.time()) - timedelta(days=gun)).isoformat(timespec='seconds')


def siralama(conn, period='30d', limit=10, now=None):
    """Dönüş: [{rank, name, email, avatar, score, wins, matches, flights, parts:{match, pace, discipline, intercept}}] — maskeli; kimlik yok."""
    if period not in PERIODS:
        raise ValueError('period')
    since = _since(period, now)
    P = PUAN
    users = {}
    for u in conn.execute('SELECT id, email, display_name, settings FROM users'):
        try:
            st = json.loads(u['settings'] or '{}')
        except ValueError:
            st = {}
        if st.get('lb_hidden'):
            continue
        users[u['id']] = {'u': u, 'match': 0.0, 'pace': 0.0, 'wins': 0, 'matches': 0, 'disc': [], 'icept': [], 'flights': 0}
    # karşılaşmalar (yalnız BITTI; insan oyuncular — bot satırları ve negatif kimlikler hariç)
    q = ("SELECT mp.user_id, mp.rank, mp.rings, mp.time_s, m.id AS mid, m.kind, m.result, m.winner_id, m.rings AS rj, "
         "(SELECT COUNT(*) FROM match_players x WHERE x.match_id = m.id AND x.is_bot = 0 AND x.user_id > 0) AS humans "
         "FROM match_players mp JOIN matches m ON m.id = mp.match_id WHERE m.state = 'BITTI' AND mp.is_bot = 0 AND mp.user_id > 0")
    args = ()
    if since:
        q += ' AND substr(COALESCE(m.ended_at, m.created_at), 1, 19) >= ?'
        args = (since,)
    for r in conn.execute(q, args):
        s = users.get(r['user_id'])
        if s is None:
            continue
        try:
            res = json.loads(r['result'] or '{}') or {}
        except ValueError:
            res = {}
        kind = r['kind'] or res.get('kind') or 'rings'
        w = 1.0 if (r['humans'] or 0) >= 2 else P['bot_only_weight']
        won = r['winner_id'] is not None and int(r['winner_id']) == int(r['user_id'])
        if kind == 'dogfight':
            d = res.get('dogfight') or {}
            role = (d.get('roles') or {}).get(str(r['user_id']))
            pts = mac_puani('dogfight', 0, False, None, won, role, d.get('max_hold_s'))
            pace = 0
        else:
            try:
                total = len(json.loads(r['rj'] or '[]'))
            except ValueError:
                total = 0
            total = total or int(res.get('total') or 0)
            fin = r['time_s'] is not None
            pts = mac_puani('rings', r['rings'], fin, r['rank'], won)
            pace = tempo_puani(r['time_s'], total) if fin else 0
        s['match'] += w * (pts + (P['win_bonus'] if won else 0))
        s['pace'] += w * pace
        s['matches'] += 1
        s['wins'] += 1 if won else 0
    # uçuşlar: §42 disiplin puanı + §24 önleme puanı (flights.summary JSON)
    q = ("SELECT user_id, duration_s, json_extract(summary, '$.alerts.score') AS a, json_extract(summary, '$.targets.score') AS t FROM flights "
         "WHERE ended_at IS NOT NULL AND summary IS NOT NULL AND json_valid(summary)")
    args = ()
    if since:
        q += ' AND substr(started_at, 1, 19) >= ?'
        args = (since,)
    for r in conn.execute(q, args):
        s = users.get(r['user_id'])
        if s is None:
            continue
        s['flights'] += 1
        if r['a'] is not None and (r['duration_s'] or 0) >= P['disc_min_s']:
            s['disc'].append(float(r['a']))
        if r['t'] is not None and float(r['t']) > 0:
            s['icept'].append(float(r['t']))
    out = []
    for uid, s in users.items():
        disc = round(sum(s['disc']) / len(s['disc']) * P['disc_k'] * min(len(s['disc']), P['disc_cap'])) if s['disc'] else 0
        icept = round(sum(sorted(s['icept'], reverse=True)[:P['icept_best']]) * P['icept_k'])
        parts = {'match': round(s['match']), 'pace': round(s['pace']), 'discipline': int(disc), 'intercept': int(icept)}
        score = sum(parts.values())
        if score <= 0:
            continue
        out.append((score, s['wins'], s['flights'], -uid, uid, s, parts))
    out.sort(reverse=True)
    top = out[:limit]
    ids = [x[4] for x in top]
    avatars = {}
    if ids:
        for p in conn.execute(f"SELECT user_id, character, avatar FROM pilots WHERE user_id IN ({','.join('?' * len(ids))}) ORDER BY is_default, id", ids):
            avatars[p['user_id']] = normalize(p['avatar'], p['character'])   # varsayılan pilot en son yazılır → kazanır
    rows = []
    for i, (score, wins, flights, _, uid, s, parts) in enumerate(top):
        u = s['u']
        rows.append({'rank': i + 1, 'name': maske_ad(u['display_name'] or u['email']), 'email': maske_eposta(u['email']),
                     'avatar': avatars.get(uid) or legacy('p01'), 'score': score, 'wins': wins, 'matches': s['matches'], 'flights': flights, 'parts': parts})
    return rows
