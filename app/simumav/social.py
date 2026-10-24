"""Çok oyunculu E-POSTA DAVETİ ve ARKADAŞLARIM (yol haritası "Uçuş › Multiplayer", "Pilot › Arkadaşlarım").

DAVET (`match_invites`): kurucu bekleme salonundaki karşılaşmasına e-posta adresleriyle (ya da arkadaş listesinden) davet gönderir.
  · Belirteç: secrets.token_urlsafe(24); DB'de yalnız sha256. Bağlantı `PUBLIC_URL/app/#/match/invite/<belirteç>`. Davet ALICININ E-POSTASINA
    bağlıdır: yalnız o e-postayla giriş yapan hesap kabul edebilir (bağlantı başkasına iletilse de işe yaramaz). Kabul = şifresiz katılım
    (davet şifrenin yerine geçer; mevcut kod + şifre akışı aynen sürer).
  · Hesabı olan kullanıcı (SIMUMAV users.email eşleşmesi): oyun içi bildirim (`GET /api/invites`) + e-posta; hesabı olmayan: kayıt/indirme
    bağlantılı e-posta. Yanıt kurucuya alıcının hesabı olup olmadığını SÖYLEMEZ (üyelik sızmaz); adresler maskeli döner.
  · Süre: INVITE_TTL_H saat ya da karşılaşma bekleme salonundan çıkınca (başladı/bitti/iptal) → `expired` (tembel güncellenir).
  · Kötüye kullanım: istek başına ≤ INVITE_PER_REQUEST adres, karşılaşma başına ≤ INVITE_MAX_PER_MATCH, kurucu başına 24 saatte ≤ INVITE_DAILY,
    alıcı başına 24 saatte ≤ INVITE_PER_RECIPIENT (tüm gönderenler), oran 10 istek / 10 dk; aynı karşılaşmada aynı adrese bekleyen davet
    tekrarlanmaz; alıcı "bu kişiden davet alma" dediyse e-posta/bildirim gitmez (kurucuya yine "gönderildi" görünür). Kullanıcının serbest
    metni e-postaya girmez.
  · E-posta altyapısı yoksa (`mailer.enabled()` False) davet yine oluşur, `mail: 'disabled'` ve bağlantı yanıtta kurucuya döner.
ARKADAŞLAR: aynı karşılaşmada (başlamış ya da bitmiş) bulunmuş insan oyuncular otomatik listelenir (kaç kez, son tarih) + elle eklenenler
(`user_contacts.kind = 'friend'`); otomatik listeden silinen `hidden` olur. E-posta her zaman maskeli; kullanıcı kimliği yalnız davet/ekle
işlemleri için döner (başka kişisel veri yok)."""
import hashlib
import os
import re
import secrets
import time
from datetime import datetime

from . import avatar, config, db, mailer

INVITE_TTL_H = float(os.environ.get('SIMUMAV_INVITE_TTL_H', '24') or 24)
INVITE_PER_REQUEST = 25
INVITE_MAX_PER_MATCH = int(os.environ.get('SIMUMAV_INVITE_MAX_PER_MATCH', '50') or 50)
INVITE_DAILY = int(os.environ.get('SIMUMAV_INVITE_DAILY', '100') or 100)
INVITE_PER_RECIPIENT = 5
_EPOSTA = re.compile(r'^[^@\s<>"\',;]{1,64}@[a-z0-9.-]{1,190}\.[a-z]{2,24}$')
_TOKEN = re.compile(r'^[A-Za-z0-9_-]{30,40}$')


class SosyalHata(Exception):
    def __init__(self, status, error, message, **extra):
        super().__init__(message)
        self.status, self.error, self.message, self.extra = status, error, message, extra


def _h(tok):
    return hashlib.sha256(tok.encode()).hexdigest()


def eposta_norm(e):
    s = str(e or '').strip().lower()
    return s if len(s) <= 254 and _EPOSTA.match(s) else None


def _iso(ts):
    return datetime.fromtimestamp(ts).isoformat(timespec='seconds')


def baglanti(tok):
    return f'{config.PUBLIC_URL}/app/#/match/invite/{tok}'


# ---------------------------------------------------------------- arkadaşlar
def otomatik(conn, uid):
    """{other_id: {'count', 'last'}} — aynı karşılaşmada bulunmuş insan oyuncular (başlamış ya da bitmiş karşılaşmalar)."""
    q = ("SELECT o.user_id AS oid, COUNT(DISTINCT m.id) AS n, MAX(COALESCE(m.ended_at, m.started_at, m.created_at)) AS last "
         "FROM match_players me JOIN match_players o ON o.match_id = me.match_id AND o.user_id <> me.user_id AND o.is_bot = 0 AND o.user_id > 0 "
         "JOIN matches m ON m.id = me.match_id WHERE me.user_id = ? AND (m.started_at IS NOT NULL OR m.state = 'BITTI') GROUP BY o.user_id")
    return {r['oid']: {'count': r['n'], 'last': r['last']} for r in conn.execute(q, (uid,))}


def liste(conn, uid):
    oto = otomatik(conn, uid)
    kayit = {r['other_id']: r for r in db.rows(conn.execute('SELECT other_id, kind, created_at FROM user_contacts WHERE user_id = ?', (uid,)))}
    ids = {i for i in oto if (kayit.get(i) or {}).get('kind') != 'hidden'} | {i for i, r in kayit.items() if r['kind'] == 'friend'}
    if not ids:
        return []
    us = {u['id']: u for u in db.rows(conn.execute(f"SELECT id, email, display_name FROM users WHERE id IN ({','.join('?' * len(ids))})", list(ids)))}
    out = []
    for i in ids:
        u = us.get(i)
        if not u:
            continue
        a = oto.get(i) or {}
        out.append({'user_id': i, 'name': u['display_name'], 'email': avatar.maske_eposta(u['email']), 'avatar': _avatar(conn, i),
                    'played_count': a.get('count', 0), 'last_played_at': a.get('last'), 'auto': i in oto,
                    'friend': (kayit.get(i) or {}).get('kind') == 'friend', 'added_at': (kayit.get(i) or {}).get('created_at')})
    out.sort(key=lambda r: (r['last_played_at'] or r['added_at'] or ''), reverse=True)
    return out


def _avatar(conn, uid):
    p = db.row(conn.execute('SELECT character, avatar FROM pilots WHERE user_id = ? ORDER BY is_default DESC, id LIMIT 1', (uid,)))
    return avatar.normalize(p['avatar'], p['character']) if p else avatar.legacy('p01')


def arkadas_ekle(conn, uid, other_id=None, email=None):
    if other_id is None and email:
        e = eposta_norm(email)
        u = db.row(conn.execute('SELECT id FROM users WHERE lower(email) = ?', (e,))) if e else None
        if not u:
            raise SosyalHata(404, 'not_found', 'Bu e-postayla bir SIMUMAV pilotu bulunamadı')
        other_id = u['id']
    elif other_id is not None:
        if int(other_id) not in otomatik(conn, uid) and not db.row(conn.execute('SELECT 1 FROM user_contacts WHERE user_id = ? AND other_id = ?', (uid, int(other_id)))):
            raise SosyalHata(404, 'not_found', 'Pilot bulunamadı (yalnız birlikte uçtuğunuz pilotlar kimlikle eklenebilir; diğerleri için e-posta)')
    else:
        raise SosyalHata(422, 'invalid', 'user_id ya da email gerekir')
    other_id = int(other_id)
    if other_id == uid:
        raise SosyalHata(422, 'invalid', 'Kendinizi ekleyemezsiniz')
    if conn.execute('SELECT COUNT(*) FROM user_contacts WHERE user_id = ? AND kind = ?', (uid, 'friend')).fetchone()[0] >= 500:
        raise SosyalHata(409, 'quota', 'En çok 500 arkadaş')
    conn.execute("INSERT INTO user_contacts (user_id, other_id, kind, created_at) VALUES (?,?,'friend',?) "
                 "ON CONFLICT(user_id, other_id) DO UPDATE SET kind = 'friend'", (uid, other_id, db.now()))
    return other_id


def arkadas_sil(conn, uid, other_id):
    other_id = int(other_id)
    if other_id in otomatik(conn, uid):
        conn.execute("INSERT INTO user_contacts (user_id, other_id, kind, created_at) VALUES (?,?,'hidden',?) "
                     "ON CONFLICT(user_id, other_id) DO UPDATE SET kind = 'hidden'", (uid, other_id, db.now()))
    else:
        n = conn.execute('DELETE FROM user_contacts WHERE user_id = ? AND other_id = ?', (uid, other_id)).rowcount
        if not n:
            raise SosyalHata(404, 'not_found', 'Arkadaş bulunamadı')


# ---------------------------------------------------------------- davet
def _durum_tazele(conn, r, mac_canli):
    """Bekleyen davetin süresi / karşılaşma durumu → expired (yerinde günceller)."""
    if r['state'] == 'pending' and (time.time() > r['expires_ts'] or not mac_canli(r['match_id'])):
        conn.execute("UPDATE match_invites SET state = 'expired' WHERE id = ? AND state = 'pending'", (r['id'],))
        r['state'] = 'expired'
    return r


def davet_api(r, link=None):
    out = {'id': r['id'], 'match_id': r['match_id'], 'email': avatar.maske_eposta(r['email']), 'state': r['state'],
           'mail': 'sent' if r['mail'] == 'blocked' else r['mail'], 'created_at': r['created_at'], 'expires_at': _iso(r['expires_ts']),
           'responded_at': r.get('responded_at')}
    if link:
        out['link'] = link
    return out


def davet_olustur(conn, host, mac, emails, friend_ids, ip=None):
    """Dönüş: (yeni_davetler [(satır, belirteç)], atlananlar [{email(maskeli), reason}], posta_isleri)."""
    uid = host['id']
    hedef = []
    for e in emails or []:
        n = eposta_norm(e)
        if not n:
            raise SosyalHata(422, 'invalid', f'Geçersiz e-posta: {str(e)[:60]}')
        hedef.append(n)
    if friend_ids:
        izinli = {r['user_id'] for r in liste(conn, uid)}
        for fid in friend_ids:
            if int(fid) not in izinli:
                raise SosyalHata(404, 'not_found', 'Arkadaş bulunamadı')
            u = db.row(conn.execute('SELECT email FROM users WHERE id = ?', (int(fid),)))
            if u and eposta_norm(u['email']):
                hedef.append(eposta_norm(u['email']))
    hedef = list(dict.fromkeys(hedef))
    if not hedef:
        raise SosyalHata(422, 'invalid', 'En az bir e-posta ya da arkadaş seçin')
    if len(hedef) > INVITE_PER_REQUEST:
        raise SosyalHata(422, 'invalid', f'Bir istekte en çok {INVITE_PER_REQUEST} davet')
    gun = time.time() - 86400
    gun_iso = _iso(gun)
    n_mac = conn.execute("SELECT COUNT(*) FROM match_invites WHERE match_id = ? AND state <> 'revoked'", (mac.id,)).fetchone()[0]
    n_gun = conn.execute('SELECT COUNT(*) FROM match_invites WHERE inviter_id = ? AND created_at >= ?', (uid, gun_iso)).fetchone()[0]
    if n_mac + len(hedef) > INVITE_MAX_PER_MATCH:
        raise SosyalHata(409, 'invite_limit', f'Karşılaşma başına en çok {INVITE_MAX_PER_MATCH} davet (kalan {max(0, INVITE_MAX_PER_MATCH - n_mac)})')
    if n_gun + len(hedef) > INVITE_DAILY:
        raise SosyalHata(429, 'invite_daily', f'24 saatte en çok {INVITE_DAILY} davet gönderebilirsiniz (kalan {max(0, INVITE_DAILY - n_gun)})',
                         retry_after=3600)
    benim = eposta_norm(host.get('email'))
    hesap_var_mi = 'SELECT id FROM users WHERE lower(email) = ? ORDER BY last_login DESC LIMIT 1'
    yeni, atla, isler = [], [], []
    t = time.time()
    st = {'track': ((getattr(mac, 'settings', None) or {}).get('track') or {}).get('name')}
    for e in hedef:
        if e == benim:
            atla.append({'email': avatar.maske_eposta(e), 'reason': 'self'})
            continue
        if db.row(conn.execute("SELECT 1 FROM match_invites WHERE match_id = ? AND email = ? AND state = 'pending'", (mac.id, e))):
            atla.append({'email': avatar.maske_eposta(e), 'reason': 'duplicate'})
            continue
        if conn.execute('SELECT COUNT(*) FROM match_invites WHERE email = ? AND created_at >= ?', (e, gun_iso)).fetchone()[0] >= INVITE_PER_RECIPIENT:
            atla.append({'email': avatar.maske_eposta(e), 'reason': 'recipient_limit'})
            continue
        u = db.row(conn.execute(hesap_var_mi, (e,)))
        engelli = bool(u and db.row(conn.execute('SELECT 1 FROM invite_blocks WHERE user_id = ? AND blocked_id = ?', (u['id'], uid))))
        tok = secrets.token_urlsafe(24)
        posta = 'blocked' if engelli else ('queued' if mailer.enabled() else 'disabled')
        iid = conn.execute('INSERT INTO match_invites (match_id, inviter_id, email, invitee_id, token_hash, state, mail, created_at, expires_ts, ip) '
                           "VALUES (?,?,?,?,?,'pending',?,?,?,?)", (mac.id, uid, e, u['id'] if u else None, _h(tok), posta, db.now(),
                                                                     t + INVITE_TTL_H * 3600, (ip or '')[:64] or None)).lastrowid
        r = db.row(conn.execute('SELECT * FROM match_invites WHERE id = ?', (iid,)))
        yeni.append((r, tok))
        if posta == 'queued':
            konu, metin, html = mailer.davet_iletisi(host.get('display_name'), getattr(mac, 'mode', None) or getattr(mac, 'tur', None),
                                                      st.get('track'), baglanti(tok), bool(u), config.MT_URL, f'{config.PUBLIC_URL}/#download', INVITE_TTL_H)
            isler.append((iid, e, konu, metin, html))
    db.audit(conn, 'match_invite', uid, ip, f'match {mac.id} · {len(yeni)} davet · {len(atla)} atlandı')
    return yeni, atla, isler


def posta_sonucu(iid, ok):
    with db.connect() as conn:
        conn.execute("UPDATE match_invites SET mail = ? WHERE id = ? AND mail = 'queued'", ('sent' if ok else 'failed', iid))
        conn.commit()


def token_ile(conn, tok):
    if not tok or not _TOKEN.match(str(tok)):
        return None
    return db.row(conn.execute('SELECT * FROM match_invites WHERE token_hash = ?', (_h(str(tok)),)))


def alici_mi(r, user):
    return (r.get('invitee_id') is not None and int(r['invitee_id']) == int(user['id'])) or (eposta_norm(user.get('email')) == r['email'])


def gelen_kutusu(conn, user, mac_canli):
    e = eposta_norm(user.get('email'))
    rs = db.rows(conn.execute("SELECT i.*, u.display_name AS inviter_name, u.email AS inviter_email, m.kind, m.mode, m.settings, m.max_players "
                              "FROM match_invites i JOIN users u ON u.id = i.inviter_id JOIN matches m ON m.id = i.match_id "
                              "WHERE (i.invitee_id = ? OR i.email = ?) AND i.state = 'pending' AND i.mail <> 'blocked' ORDER BY i.id DESC LIMIT 50",
                              (user['id'], e or '-')))
    out = []
    for r in rs:
        _durum_tazele(conn, r, mac_canli)
        if r['state'] != 'pending':
            continue
        out.append(davet_ozeti(r))
    return out


def davet_ozeti(r):
    st = db.j(r.get('settings'))
    return {'id': r['id'], 'match_id': r['match_id'], 'state': r['state'], 'inviter': {'name': r.get('inviter_name'), 'email': avatar.maske_eposta(r.get('inviter_email'))},
            'mode': r.get('mode') or r.get('kind'), 'kind': r.get('kind'), 'track': (st.get('track') or {}).get('name'),
            'drone': {'name': (st.get('drone') or {}).get('name'), 'type': (st.get('drone') or {}).get('type')}, 'max_players': r.get('max_players'),
            'created_at': r['created_at'], 'expires_at': _iso(r['expires_ts'])}
