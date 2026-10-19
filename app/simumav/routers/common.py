"""Router ortak yardımcıları: sahiplik, kota, hata çevirimi, yanıt biçimleri."""
from fastapi import Depends, HTTPException

from .. import auth, bridge, config, db

User = Depends(auth.require_user)


def hata_cevir(e):
    if isinstance(e, bridge.BridgeHata):
        detail = {'error': e.error, 'message': e.message, **e.extra}
        hdr = {'Retry-After': str(e.extra['retry_after'])} if 'retry_after' in e.extra else None
        raise HTTPException(e.status, detail, headers=hdr)
    raise e


def sahip(conn, table, iid, user, request=None):
    """Kullanıcının kaydı; yoksa 404 (başkasının kaydı da 404 — varlık sızmaz)."""
    r = db.row(conn.execute(f'SELECT * FROM {table} WHERE id = ? AND user_id = ?', (int(iid), user['id'])))
    if not r:
        raise auth.hata(404, 'not_found', 'Kayıt bulunamadı')
    return r


def kota(conn, table, user, request=None):
    n = conn.execute(f'SELECT COUNT(*) FROM {table} WHERE user_id = ?', (user['id'],)).fetchone()[0]
    lim = config.QUOTA[table]
    if n >= lim:
        db.audit(conn, 'quota', user['id'], auth.client_ip(request) if request else None, f'{table} ≥ {lim}')
        raise auth.hata(409, 'quota', f'En fazla {lim} kayıt ({table}); önce birini silin')


def drone_api(d):
    return {**d, 'params': db.j(d.get('params')), 'is_default': bool(d.get('is_default')),
            'proc': str(d.get('model_key', '')).startswith('proc:') or d.get('model_key') in ('builtin:quad', 'builtin:hexa', 'builtin:heli', 'builtin:delta'),
            'preview': d.get('preview') or _glb(d.get('model_key'))}


def _glb(model_key):
    for t in bridge.katalog()['types']:
        for m in t['models']:
            if m['key'] == model_key:
                return m.get('glb')
    return None


# Pilot karakter SVG'leri: static/simumav/app/img/pilots/p01..p10.svg (/app mount'u) — crew/characters ve pilot kayıtları aynı yolu verir
PILOT_SVG = '/app/img/pilots/{key}.svg'


def pilot_api(p):
    return {**p, 'is_default': bool(p.get('is_default')), 'svg': PILOT_SVG.format(key=p.get('character') or 'p01')}


def track_api(t):
    return {**t, 'wind': db.j(t.get('wind')), 'world': db.j(t.get('world')), 'gates': db.j(t.get('gates'), []), 'is_default': bool(t.get('is_default')),
            'preview_png': f"/api/tracks/{t['id']}/preview.png"}


def mission_api(m):
    return {**m, 'plan': db.j(m.get('plan'))}


def flight_api(f, kisa=False):
    out = {**f, 'snapshot': db.j(f.get('snapshot')), 'active': f.get('ended_at') is None}
    out['has_bin'] = bool(f.get('bin_path'))
    out['has_replay'] = bool(f.get('replay_cache'))
    out['summary'] = None if kisa else db.j(f.get('summary'), None)
    if not kisa and f.get('summary'):
        out['summary'] = db.j(f['summary'], None)
    snap = out['snapshot']
    out['track'] = {**(snap.get('track') or {}), 'preview_png': f"/api/tracks/{(snap.get('track') or {}).get('id')}/preview.png" if snap.get('track') else None}
    out['drone'] = {**(snap.get('drone') or {}), 'preview': _glb((snap.get('drone') or {}).get('model_key'))}
    out['pilot'] = snap.get('pilot')
    out['mission'] = snap.get('mission')
    for k in ('bin_path', 'params_path', 'replay_cache', 'video_path', 'core_log_id', 'core_run_id'):   # iç yollar dışa verilmez
        out.pop(k, None)
    return out
