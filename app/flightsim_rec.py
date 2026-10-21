"""Uçuş Simülatörü ekran kaydı (§17): tarayıcı MediaRecorder parçalarını oturum boyunca akıtır, Bitir'de kayıt Şirketten Haberler
medya deposuna taşınır ve oturum SAHİBİ adına paylaşım açılır — ya da (paylaşım seçeneği kapalıysa) `sakla` ile sunucuda 'kept'
durumunda tutulur: "Kayıtlarım" (`listem`) → indir (`dosya`) / sonradan paylaş (`bitir`) / sil; `SIM_REC_KEEP_DAYS` (30) sonra temizlenir.

Dosyalar `DATA_DIR/sim_rec/<rec_id>.webm` (+ `.json` meta, isteğe bağlı `.png` küçük resim). Meta JSON diskte tutulur: sayfa kapanır
ya da sunucu yeniden başlarsa yarım kayıt bulunur ("Yarım kayıt" bildirimi → paylaş / sil). 24 saatten eski açık kayıtlar temizlenir.
Kayıt kimliği rastgele (secrets); dosya yolları yalnız kimlikten türetilir (yol gezinmesi yok). Boyut sınırı `SIM_REC_MAX_MB` (varsayılan 1024,
en çok 2048); parça ≤ 8 MB; parçalar sıralı (`seq`), tekrar gönderilen son parça yok sayılır (idempotent), atlama 409.
"""
import json
import os
import re
import secrets
import time

from . import config, db, feed

REC_DIR = config.DATA_DIR / 'sim_rec'
CHUNK_MAX = 8 * 1024 * 1024
MAX_MB = max(1, min(2048, int(os.environ.get('SIM_REC_MAX_MB', '1024') or 1024)))
MAX_BYTES = MAX_MB * 1024 * 1024
THUMB_MAX = 2 * 1024 * 1024
TTL_S = 24 * 3600                      # yarım kayıt saklama süresi
KEEP_DAYS = max(1, int(os.environ.get('SIM_REC_KEEP_DAYS', '30') or 30))   # paylaşılmadan saklanan (state 'kept') kayıtların ömrü
KEEP_S = KEEP_DAYS * 24 * 3600
MIMES = {'video/webm': '.webm', 'video/mp4': '.mp4', 'video/x-matroska': '.mkv'}
_ID = re.compile(r'^[0-9a-f]{16}$')
TIP_ADLARI = {'multirotor': 'Multirotor', 'hexarotor': 'Hexarotor', 'helikopter': 'Helikopter', 'sabit_kanat': 'Sabit kanat', 'vtol': 'VTOL',
             'interceptor': 'INTERCEPTOR', 'rover': 'Kara aracı'}
YONTEM = {'ramp': 'rampa', 'vehicle': 'araç', 'wheels': 'pist'}


class RecHata(Exception):
    def __init__(self, kod, mesaj):
        super().__init__(mesaj)
        self.kod = kod   # HTTP durum kodu


def _yol(rec_id, ext):
    if not _ID.match(rec_id or ''):
        raise RecHata(404, 'Kayıt bulunamadı')
    return REC_DIR / f'{rec_id}{ext}'


def _ext(mime):
    base = (mime or '').split(';')[0].strip().lower()
    return MIMES.get(base, '.webm'), (base or 'video/webm')


def meta_oku(rec_id):
    p = _yol(rec_id, '.json')
    if not p.exists():
        raise RecHata(404, 'Kayıt bulunamadı')
    try:
        return json.loads(p.read_text(encoding='utf-8'))
    except ValueError:
        raise RecHata(404, 'Kayıt bulunamadı')


def _meta_yaz(m):
    p = _yol(m['id'], '.json')
    tmp = p.with_suffix('.json.tmp')
    tmp.write_text(json.dumps(m, ensure_ascii=False), encoding='utf-8')
    tmp.replace(p)


def yetkili(m, user, write):
    """Parça/bitir/sil: kaydı başlatan ya da oturum sahibi ya da drone.sim yazma izni."""
    return user['id'] in (m.get('user_id'), m.get('owner_id')) or bool(write)


def basla(session_dict, user, write, mime=None):
    """Kayıt açar. `session_dict` = Session.to_dict(); `write` = drone.sim yazma izni. Oturum sahibi ya da yazma izni gerekir."""
    owner = (session_dict.get('owner') or {})
    if user['id'] != owner.get('id') and not write:
        raise RecHata(403, 'Kayıt için oturum sahibi olmak ya da yazma izni gerekir')
    temizle()
    REC_DIR.mkdir(parents=True, exist_ok=True)
    ext, base = _ext(mime)
    rid = secrets.token_hex(8)
    launch = session_dict.get('launch') or {}
    m = {'id': rid, 'sid': session_dict.get('id'), 'owner_id': owner.get('id'), 'owner_name': owner.get('name'), 'user_id': user['id'],
         'mode': session_dict.get('mode') or 'sitl', 'type': session_dict.get('type'), 'center': (session_dict.get('center') or {}).get('name'),
         'replay_file': (session_dict.get('replay') or {}).get('file_name'), 'method': launch.get('method') if session_dict.get('type') == 'sabit_kanat' else None,
         'mime': base, 'ext': ext, 'size': 0, 'seq': -1, 'state': 'open', 'started_at': db.now(), 'ts': time.time(), 'max_bytes': MAX_BYTES}
    _yol(rid, ext).write_bytes(b'')
    _meta_yaz(m)
    return m


def parca(rec_id, user, write, seq, data):
    """Sıralı parça ekler. Dönüş: güncel meta. Tekrar (seq == son) → yok sayılır; atlama → 409; sınır aşımı → 413 (kayıt 'full')."""
    m = meta_oku(rec_id)
    if not yetkili(m, user, write):
        raise RecHata(403, 'Bu kayda yazma yetkiniz yok')
    if m['state'] != 'open':
        raise RecHata(409, 'Kayıt kapalı' if m['state'] == 'done' else 'Kayıt boyut sınırına ulaştı')
    if len(data) > CHUNK_MAX:
        raise RecHata(413, 'Parça en çok 8 MB olabilir')
    if seq == m['seq']:
        return m                                  # yinelenen gönderim (ağ tekrarı): idempotent
    if seq != m['seq'] + 1:
        raise RecHata(409, f'Parça sırası bozuk (beklenen {m["seq"] + 1}, gelen {seq})')
    if m['size'] + len(data) > m.get('max_bytes', MAX_BYTES):
        m['state'] = 'full'
        _meta_yaz(m)
        raise RecHata(413, f'Kayıt boyut sınırı aşıldı ({MAX_MB} MB)')
    with open(_yol(rec_id, m['ext']), 'ab') as f:
        f.write(data)
    m['size'] += len(data)
    m['seq'] = seq
    m['ts'] = time.time()
    _meta_yaz(m)
    return m


def kucuk_resim(rec_id, user, write, data):
    m = meta_oku(rec_id)
    if not yetkili(m, user, write):
        raise RecHata(403, 'Bu kayda yazma yetkiniz yok')
    if not data.startswith(b'\x89PNG\r\n\x1a\n') or len(data) > THUMB_MAX:
        raise RecHata(415, 'Küçük resim PNG olmalı (≤ 2 MB)')
    _yol(rec_id, '.png').write_bytes(data)
    m['thumb'] = True
    _meta_yaz(m)
    return m


def metin(m, duration_s=None, lang='tr'):
    """Paylaşım metni: 'Uçuş Simülatörü kaydı · <tip> · <merkez> · <yöntem> · <süre> · <tarih>'. Sunucu Türkçe üretir; istemci kendi dilinde
    `text` gönderebilir (aynı yapı, tr() ile çevrilmiş) — bkz. bitir()."""
    parts = ['Uçuş Simülatörü kaydı']
    if m.get('mode') == 'replay':
        parts.append('kayıttan oynatma' + (f" · {m['replay_file']}" if m.get('replay_file') else ''))
    else:
        parts.append(TIP_ADLARI.get(m.get('type'), m.get('type') or '—'))
        if m.get('center'):
            parts.append(m['center'])
        if m.get('method'):
            parts.append(YONTEM.get(m['method'], m['method']))
    if duration_s:
        d = int(duration_s)
        parts.append(f'{d // 60:02d}:{d % 60:02d}')
    parts.append((m.get('started_at') or '')[:16].replace('T', ' '))
    return ' · '.join(p for p in parts if p)


def sakla(rec_id, user, write, duration_s=None, text=None):
    """Bitir (paylaşım KAPALI; §17 kayıt seçenekleri): dosya `sim_rec` altında kalır, state 'kept' — "Kayıtlarım" listesinden indirilir /
    sonradan paylaşılır / silinir; KEEP_DAYS sonra temizlenir. Dönüş {rec_id, size, text, duration_s}."""
    m = meta_oku(rec_id)
    if not yetkili(m, user, write):
        raise RecHata(403, 'Bu kayda yetkiniz yok')
    if m['state'] == 'done':
        raise RecHata(409, 'Kayıt zaten paylaşıldı')
    if not _yol(rec_id, m['ext']).exists() or m['size'] <= 0:
        raise RecHata(400, 'Kayıt boş')
    txt = ' '.join((text or '').split())[:300] or metin(m, duration_s)
    m.update(state='kept', kept_at=db.now(), ts=time.time(), duration_s=duration_s, text=txt)
    _meta_yaz(m)
    return {'rec_id': rec_id, 'size': m['size'], 'text': txt, 'duration_s': duration_s, 'sid': m.get('sid')}


def listem(user):
    """Kullanıcının saklanan (paylaşılmamış, bitmiş) kayıtları — sahip ya da başlatan."""
    temizle()
    out = []
    if not REC_DIR.exists():
        return out
    for p in REC_DIR.glob('*.json'):
        try:
            m = json.loads(p.read_text(encoding='utf-8'))
        except (ValueError, OSError):
            continue
        if m.get('state') != 'kept' or user['id'] not in (m.get('user_id'), m.get('owner_id')):
            continue
        out.append({'id': m['id'], 'sid': m.get('sid'), 'type': m.get('type'), 'center': m.get('center'), 'mode': m.get('mode'), 'size': m['size'],
                    'started_at': m.get('started_at'), 'kept_at': m.get('kept_at'), 'seconds': round(m.get('duration_s') or (m.get('seq', -1) + 1) * 10),
                    'text': m.get('text') or metin(m, m.get('duration_s')), 'ext': m.get('ext'), 'mime': m.get('mime'), 'thumb': bool(m.get('thumb')),
                    'file_name': f"ucus-simulatoru-{m.get('sid')}-{(m.get('started_at') or '')[:16].replace(':', '-').replace('T', '-')}{m.get('ext', '.webm')}"})
    out.sort(key=lambda x: x['kept_at'] or '', reverse=True)
    return out


def dosya(rec_id, user, write):
    """İndirme: (yol, mime, görünen ad). Yalnız 'kept' (saklanan) ya da açık kayıt; sahip/başlatan/yazma izni."""
    m = meta_oku(rec_id)
    if not yetkili(m, user, write):
        raise RecHata(403, 'Bu kayda yetkiniz yok')
    p = _yol(rec_id, m['ext'])
    if not p.exists() or m['size'] <= 0:
        raise RecHata(404, 'Kayıt dosyası yok')
    ad = f"ucus-simulatoru-{m.get('sid')}-{(m.get('started_at') or '')[:16].replace(':', '-').replace('T', '-')}{m['ext']}"
    return p, m.get('mime') or 'video/webm', ad


def bitir(conn, rec_id, user, write, duration_s=None, text=None):
    """Son parça geldikten sonra: dosya Şirketten Haberler medya deposuna taşınır, oturum SAHİBİ adına paylaşım açılır.
    Dönüş {post_id, path, thumb, text, owner_id}. Oturum kapanmış olsa da çalışır (yarım kayıt → paylaşım; saklanan 'kept' kayıt → paylaşım)."""
    m = meta_oku(rec_id)
    if not yetkili(m, user, write):
        raise RecHata(403, 'Bu kayda yetkiniz yok')
    if m['state'] == 'done':
        raise RecHata(409, 'Kayıt zaten paylaşıldı')
    src = _yol(rec_id, m['ext'])
    if not src.exists() or m['size'] <= 0:
        raise RecHata(400, 'Kayıt boş')
    if m['state'] == 'kept':
        duration_s = duration_s if duration_s is not None else m.get('duration_s')
        text = text or m.get('text')
    feed_dir = config.UPLOAD_DIR / 'feed'
    feed_dir.mkdir(parents=True, exist_ok=True)
    name = f'{secrets.token_hex(8)}{m["ext"]}'
    src.replace(feed_dir / name)
    media = {'type': 'video', 'path': f'feed/{name}'}
    th = _yol(rec_id, '.png')
    if th.exists():
        tname = name.rsplit('.', 1)[0] + '.png'
        th.replace(feed_dir / tname)
        media['thumb'] = f'feed/{tname}'
    txt = ' '.join((text or '').split())[:300] or metin(m, duration_s)
    owner_id = m.get('owner_id') or user['id']
    if not conn.execute('SELECT 1 FROM users WHERE id = ? AND deleted_at IS NULL', (owner_id,)).fetchone():
        owner_id = user['id']   # oturum sahibi silinmişse kaydı bitiren adına
    pid = feed.add_post(conn, owner_id, txt, [media])
    db.audit(conn, user['id'], 'Uçuş simülatörü kaydını paylaştı', 'feed', pid, f'rec {rec_id} · {m["size"] // 1024} KB · oturum {m.get("sid")}')
    m.update(state='done', post_id=pid, finished_at=db.now(), ts=time.time(), duration_s=duration_s)
    _meta_yaz(m)
    try:
        _yol(rec_id, '.json').unlink()
    except OSError:
        pass
    return {'post_id': pid, 'path': media['path'], 'thumb': media.get('thumb'), 'text': txt, 'owner_id': owner_id, 'size': m['size'], 'sid': m.get('sid')}


def oturum_kaydi(sid, started_at=None):
    """§21: oturuma (sid) ait en yeni ekran kaydı meta'sı (open/full/kept; bitirilmiş kayıtların meta'sı silinir → router `video_bagla` bağlar).
    `started_at` verilirse yalnız oturum başlangıcından sonra açılan kayıtlar (sunucu yeniden başlayınca sid tekrar eder)."""
    if sid is None or not REC_DIR.exists():
        return None
    en_yeni = None
    for p in REC_DIR.glob('*.json'):
        try:
            m = json.loads(p.read_text(encoding='utf-8'))
        except (ValueError, OSError):
            continue
        if m.get('sid') != sid or m.get('size', 0) <= 0:
            continue
        if started_at and (m.get('started_at') or '') < started_at[:19]:
            continue
        if en_yeni is None or (m.get('started_at') or '') > (en_yeni.get('started_at') or ''):
            en_yeni = m
    return en_yeni


def video_yolu(rec_id):
    """§21 video izleme: saklanan/yarım kaydın dosya yolu ve mime; yoksa None (meta silinmiş → paylaşım yolu kullanılır)."""
    try:
        m = meta_oku(rec_id)
    except RecHata:
        return None
    p = _yol(rec_id, m.get('ext', '.webm'))
    if not p.exists() or m.get('size', 0) <= 0:
        return None
    return p, m.get('mime') or 'video/webm', m.get('ext', '.webm')


def sil(rec_id, user, write):
    m = meta_oku(rec_id)
    if not yetkili(m, user, write):
        raise RecHata(403, 'Bu kayda yetkiniz yok')
    for ext in (m['ext'], '.png', '.json'):
        try:
            _yol(rec_id, ext).unlink()
        except OSError:
            pass
    return True


def bekleyenler(user, acik_sidler=()):
    """Kullanıcının yarım kayıtları: sahibi ya da başlatanı olduğu, bitmemiş, OTURUMU KAPANMIŞ (acik_sidler dışında) kayıtlar."""
    temizle()
    out = []
    if not REC_DIR.exists():
        return out
    for p in REC_DIR.glob('*.json'):
        try:
            m = json.loads(p.read_text(encoding='utf-8'))
        except (ValueError, OSError):
            continue
        if m.get('state') not in ('open', 'full') or user['id'] not in (m.get('user_id'), m.get('owner_id')) or m.get('sid') in set(acik_sidler):
            continue   # 'kept' (saklanan) kayıtlar "Kayıtlarım" listesindedir (listem), yarım değildir
        if m.get('size', 0) <= 0:
            continue
        out.append({'id': m['id'], 'sid': m.get('sid'), 'type': m.get('type'), 'center': m.get('center'), 'mode': m.get('mode'), 'size': m['size'],
                    'started_at': m.get('started_at'), 'seconds': round((m.get('seq', -1) + 1) * 10), 'text': metin(m), 'state': m.get('state')})
    out.sort(key=lambda x: x['started_at'] or '', reverse=True)
    return out


def temizle(now=None):
    """24 saatten eski bitmemiş kayıtları (ve sahipsiz/boş dosyaları) siler. Dönüş: silinen kayıt sayısı."""
    if not REC_DIR.exists():
        return 0
    now = now or time.time()
    n = 0
    for p in REC_DIR.glob('*.json'):
        try:
            m = json.loads(p.read_text(encoding='utf-8'))
            if now - float(m.get('ts') or 0) < (KEEP_S if m.get('state') == 'kept' else TTL_S):
                continue
            for ext in (m.get('ext', '.webm'), '.png'):
                try:
                    (REC_DIR / f"{m['id']}{ext}").unlink()
                except OSError:
                    pass
            p.unlink()
            n += 1
        except (ValueError, OSError, KeyError):
            try:
                p.unlink()
            except OSError:
                pass
    for p in REC_DIR.iterdir():   # meta'sı olmayan veri dosyaları (yarım yazım) — eski olanlar
        if p.suffix != '.json' and not (REC_DIR / f'{p.stem}.json').exists():
            try:
                if now - p.stat().st_mtime > TTL_S:
                    p.unlink()
            except OSError:
                pass
    return n
