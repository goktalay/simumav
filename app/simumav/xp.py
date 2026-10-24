"""PİLOT SEVİYESİ — deneyim puanı (XP), seviye 1…100, madalyalar (yol haritası "Mürettebat").

Hile önleme: XP YALNIZ sunucunun kaydettiği veriden hesaplanır — `flights` satırının sunucu özeti (flights.summary: hava süresi, mesafe,
§42 disiplin puanı, iniş, görev tamamlama, savunma/hedef puanı, servo tetik) ve karşılaşma çekirdeğinin yazdığı `match_players` (sıra, halka,
galibiyet; yalnız BITTI). İstemcinin `stop {gates}` sayımı gibi doğrulanmamış değerler XP'ye GİRMEZ (TOP 10 doğrulama mantığıyla aynı:
avatar.siralama). Bota karşı puan çiftliği: rakiplerin hepsi yapay zekâysa karşılaşma bileşeni × 0,5. Günlük üst sınır: pilot başına
DAILY_CAP doğrulanmış XP / gün.
Misafir / yerel uçuş: istemci XP'yi kendi tutar; hesaba bağlanınca `POST /api/crew/{id}/xp/import` ile isteğe bağlı aktarır → `verified = 0`
olarak AYRI işaretlenir, toplamı IMPORT_CAP ile sınırlı (en çok seviye 10'a taşıyabilir); TOP 10 sıralaması bunu hiç kullanmaz.
Defter `xp_events` (UNIQUE source+ref+pilot → aynı uçuş iki kez sayılmaz); `pilots.xp / xp_unverified / level` önbellek sütunlarıdır.
`esitle(conn, user_id)` işlenmemiş biten uçuşları/karşılaşmaları deftere ekler (uçuş kapanışında + seviye uçlarında çağrılır; idempotent)."""
import json
from datetime import datetime

from . import db, modes

MAX_LEVEL = 100
DAILY_CAP = 3000
MIN_AIR_S = 10
IMPORT_MAX_ENTRY = 1000
IMPORT_MAX_ENTRIES = 200


def gereken(level):
    """Seviyeye ulaşmak için gereken TOPLAM XP (seviye 1 = 0; seviye 100 ≈ 390 bin)."""
    L = max(1, min(MAX_LEVEL, int(level)))
    return int(round(100 * (L - 1) ** 1.8))


CURVE = [gereken(L) for L in range(1, MAX_LEVEL + 1)]
IMPORT_CAP = gereken(10)
MEDALS = [
    {'id': 'wings_bronze', 'level': 5, 'label': {'tr': 'Bronz Kanat', 'en': 'Bronze Wings'}},
    {'id': 'wings_silver', 'level': 10, 'label': {'tr': 'Gümüş Kanat', 'en': 'Silver Wings'}},
    {'id': 'wings_gold', 'level': 25, 'label': {'tr': 'Altın Kanat', 'en': 'Gold Wings'}},
    {'id': 'wings_platinum', 'level': 50, 'label': {'tr': 'Platin Kanat', 'en': 'Platinum Wings'}},
    {'id': 'wings_diamond', 'level': 75, 'label': {'tr': 'Elmas Kanat', 'en': 'Diamond Wings'}},
    {'id': 'wings_legend', 'level': 100, 'label': {'tr': 'Efsane Pilot', 'en': 'Legend Pilot'}},
]


def seviye(xp):
    xp = max(0, int(xp or 0))
    L = 1
    for i, g in enumerate(CURVE):
        if xp >= g:
            L = i + 1
    return L


def bilgi(xp_v, xp_u=0):
    """Pilot seviye özeti: doğrulanmış + (sınırlı) doğrulanmamış XP."""
    xp_v, xp_u = max(0, int(xp_v or 0)), max(0, min(IMPORT_CAP, int(xp_u or 0)))
    toplam = xp_v + xp_u
    L = seviye(toplam)
    Lv = seviye(xp_v)
    alt, ust = gereken(L), (gereken(L + 1) if L < MAX_LEVEL else None)
    return {'level': L, 'level_verified': Lv, 'xp': toplam, 'xp_verified': xp_v, 'xp_unverified': xp_u, 'level_xp': alt, 'next_level_xp': ust,
            'progress': round((toplam - alt) / (ust - alt), 4) if ust else 1.0, 'max_level': MAX_LEVEL,
            'medals': [{'id': m['id'], 'level': m['level'], 'label': m['label'], 'earned': L >= m['level'], 'verified': Lv >= m['level']} for m in MEDALS]}


def kurallar():
    return {'max_level': MAX_LEVEL, 'curve': CURVE, 'formula': 'round(100 × (L−1)^1.8)', 'medals': MEDALS, 'daily_cap': DAILY_CAP,
            'import_cap': IMPORT_CAP, 'min_air_s': MIN_AIR_S,
            'sources': {'flight': 'sunucu uçuş özeti (hava süresi, mesafe, disiplin, iniş, görev, savunma/hedef, servo tetik) — modes.puanla',
                        'match': 'karşılaşma çekirdeği (halka, sıra, galibiyet; yalnız biten) — modes.mac_puani',
                        'import': 'istemcinin yerel XP aktarımı (doğrulanmamış; ayrı işaretli; toplam ≤ import_cap)'}}


def _bugun_v(conn, pilot_id):
    gun = datetime.now().date().isoformat()
    return conn.execute("SELECT COALESCE(SUM(xp), 0) FROM xp_events WHERE pilot_id = ? AND verified = 1 AND substr(created_at, 1, 10) = ?",
                        (pilot_id, gun)).fetchone()[0]


def _yaz(conn, user_id, pilot_id, source, ref_id, parts, verified=1, extra=None):
    ham = int(sum(int(v) for v in parts.values()))
    xp = ham
    kesik = False
    if verified and xp > 0:
        kalan = max(0, DAILY_CAP - _bugun_v(conn, pilot_id))
        if xp > kalan:
            xp, kesik = kalan, True
    detail = {'parts': parts, 'raw': ham, 'capped': kesik, **(extra or {})}
    conn.execute('INSERT OR IGNORE INTO xp_events (user_id, pilot_id, source, ref_id, xp, verified, detail, created_at) VALUES (?,?,?,?,?,?,?,?)',
                 (user_id, pilot_id, source, int(ref_id), int(xp), int(verified), json.dumps(detail, ensure_ascii=False), db.now()))
    return xp


def ucus_modu(f):
    m = f.get('mode')
    if m:
        return m
    snap = db.j(f.get('snapshot'))
    if snap.get('mode'):
        return snap['mode']
    if f.get('match_id'):
        return None
    mk = ((snap.get('mission') or {}).get('kind'))
    return 'spraying' if mk == 'spray' else ('facility_defense' if mk == 'defend' or snap.get('defend') else 'free')


def ucus_xp(conn, f):
    """Biten uçuşun XP satırı (yoksa). Dönüş: yazılan XP ya da None (uygun değil)."""
    if f.get('ended_at') is None or not f.get('pilot_id'):
        return None
    s = db.j(f.get('summary'), None) or {}
    air = float(((s.get('flight') or {}).get('air_s')) or 0)
    mode = ucus_modu(f)
    # sqlite satır kimliği yeniden kullanılabilir (en son uçuş silinince): eski kimliğin XP satırı korunur, kimliği kendi satır no'suna (negatif) taşınır
    conn.execute("UPDATE xp_events SET ref_id = -id WHERE source = 'flight' AND ref_id = ? AND created_at < ?", (f['id'], f['started_at']))
    parts = modes.puanla(mode, s, f.get('duration_s'), f.get('result')) if air >= MIN_AIR_S else {}
    return _yaz(conn, f['user_id'], f['pilot_id'], 'flight', f['id'], parts, extra={'mode': mode, 'air_s': air})


def esitle(conn, user_id):
    """İşlenmemiş biten uçuşlar + biten karşılaşmalar → defter; pilot önbellek sütunları yenilenir. Commit çağırana aittir."""
    for f in db.rows(conn.execute("SELECT * FROM flights f WHERE f.user_id = ? AND f.ended_at IS NOT NULL AND f.pilot_id IS NOT NULL AND NOT EXISTS "
                                  "(SELECT 1 FROM xp_events x WHERE x.source = 'flight' AND x.ref_id = f.id AND x.created_at >= f.started_at) ORDER BY f.id LIMIT 500", (user_id,))):
        ucus_xp(conn, f)
    q = ("SELECT mp.match_id, mp.rank, mp.rings, mp.time_s, m.kind, m.winner_id, f.pilot_id, "
         "(SELECT COUNT(*) FROM match_players x WHERE x.match_id = m.id AND x.is_bot = 0 AND x.user_id > 0) AS humans, "
         "(SELECT COUNT(*) FROM match_players x WHERE x.match_id = m.id) AS n_all "
         "FROM match_players mp JOIN matches m ON m.id = mp.match_id JOIN flights f ON f.id = mp.flight_id "
         "WHERE mp.user_id = ? AND mp.is_bot = 0 AND m.state = 'BITTI' AND f.pilot_id IS NOT NULL AND NOT EXISTS "
         "(SELECT 1 FROM xp_events x WHERE x.source = 'match' AND x.ref_id = m.id AND x.user_id = mp.user_id) LIMIT 500")
    for r in db.rows(conn.execute(q, (user_id,))):
        won = r['winner_id'] is not None and int(r['winner_id']) == int(user_id)
        parts = modes.mac_puani(r['kind'] or 'rings', r['rank'], r['time_s'] is not None, r['rings'], won, r['humans'] or 0, r['n_all'] or 0)
        _yaz(conn, user_id, r['pilot_id'], 'match', r['match_id'], parts, extra={'kind': r['kind'], 'rank': r['rank']})
    onbellek(conn, user_id)


def onbellek(conn, user_id, pilot_id=None):
    q = 'SELECT id FROM pilots WHERE user_id = ?' + (' AND id = ?' if pilot_id else '')
    for (pid,) in conn.execute(q, (user_id, pilot_id) if pilot_id else (user_id,)).fetchall():
        v, u = conn.execute('SELECT COALESCE(SUM(CASE WHEN verified = 1 THEN xp END), 0), COALESCE(SUM(CASE WHEN verified = 0 THEN xp END), 0) '
                            'FROM xp_events WHERE pilot_id = ?', (pid,)).fetchone()
        b = bilgi(v, u)
        conn.execute('UPDATE pilots SET xp = ?, xp_unverified = ?, level = ? WHERE id = ?', (int(v), int(min(u, IMPORT_CAP)), b['level'], pid))


def ice_aktar(conn, user_id, pilot_id, entries):
    """Yerel XP aktarımı (doğrulanmamış). Dönüş: {imported, skipped, remaining_cap}."""
    mevcut = conn.execute('SELECT COALESCE(SUM(xp), 0), COALESCE(MAX(ref_id), 0) FROM xp_events WHERE pilot_id = ? AND source = ?', (pilot_id, 'import')).fetchone()
    kalan, ref = max(0, IMPORT_CAP - int(mevcut[0])), int(mevcut[1])
    alinan = atlanan = 0
    for e in entries:
        x = max(0, min(IMPORT_MAX_ENTRY, int(e.get('xp') or 0)))
        if x <= 0 or kalan <= 0:
            atlanan += 1
            continue
        x = min(x, kalan)
        ref += 1
        _yaz(conn, user_id, pilot_id, 'import', ref, {'local': x}, verified=0,
             extra={'at': str(e.get('at') or '')[:25], 'mode': e.get('mode') if e.get('mode') in modes.MODES else None,
                    'duration_s': int(max(0, min(36000, e.get('duration_s') or 0)))})
        kalan -= x
        alinan += x
    onbellek(conn, user_id, pilot_id)
    return {'imported': alinan, 'skipped': atlanan, 'remaining_cap': kalan}


def ucus_xp_haritasi(conn, flight_ids):
    if not flight_ids:
        return {}
    ids = list(flight_ids)
    return {r[0]: r[1] for r in conn.execute(f"SELECT ref_id, xp FROM xp_events WHERE source = 'flight' AND ref_id IN ({','.join('?' * len(ids))})", ids)}
