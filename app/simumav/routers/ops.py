"""`/api/ops` — operasyon (geçmiş uçuşlar): liste, ayrıntı, replay (.bin → flightsim_replay önbelleği), .bin indirme, silme.
Dosya yolları yalnız DB'den; `bridge.dosya_yolu` çekirdek veri kökü dışına çıkışı reddeder; sahiplik 404."""
from fastapi import APIRouter, Request
from fastapi.responses import FileResponse

from .. import auth, bridge, db
from .common import User, flight_api, hata_cevir, sahip

router = APIRouter(prefix='/api/ops')


@router.get('')
def list_ops(limit: int = 50, offset: int = 0, user=User):
    limit, offset = max(1, min(100, limit)), max(0, offset)
    with db.connect() as conn:
        rows = db.rows(conn.execute('SELECT * FROM flights WHERE user_id = ? ORDER BY started_at DESC LIMIT ? OFFSET ?', (user['id'], limit, offset)))
        total = conn.execute('SELECT COUNT(*) FROM flights WHERE user_id = ?', (user['id'],)).fetchone()[0]
        stats = conn.execute('SELECT COUNT(*), COALESCE(SUM(duration_s), 0), SUM(CASE WHEN result = "crash" THEN 1 ELSE 0 END) FROM flights WHERE user_id = ? AND ended_at IS NOT NULL',
                             (user['id'],)).fetchone()
    return {'flights': [flight_api(f, kisa=True) for f in rows], 'total': total,
            'stats': {'flights': stats[0], 'flight_s': int(stats[1] or 0), 'crashes': int(stats[2] or 0)}}


@router.get('/{fid}')
def get_op(fid: int, user=User):
    with db.connect() as conn:
        f = sahip(conn, 'flights', fid, user)
    out = flight_api(f)
    out['replay_ready'] = bool(f.get('replay_cache') and bridge.dosya_yolu(f['replay_cache']))
    out['replay_possible'] = bool(f.get('bin_path') and bridge.dosya_yolu(f['bin_path']))
    return out


@router.get('/{fid}/replay')
async def op_replay(fid: int, user=User):
    """Kayıt kareleri (flightsim_replay önbelleği, gzip JSON). İlk çağrıda .bin alt süreçte ayrıştırılır (büyük dosyada birkaç sn)."""
    with db.connect() as conn:
        f = sahip(conn, 'flights', fid, user)
    gz = bridge.dosya_yolu(f.get('replay_cache')) if f.get('replay_cache') else None
    if gz is None:
        try:
            gz, _meta = await bridge.replay_hazirla(f)
        except bridge.BridgeHata as e:
            hata_cevir(e)
    return FileResponse(gz, media_type='application/json', headers={'Content-Encoding': 'gzip', 'Cache-Control': 'private, max-age=3600', 'Vary': 'Accept-Encoding'})


@router.get('/{fid}/bin')
def op_bin(fid: int, user=User):
    with db.connect() as conn:
        f = sahip(conn, 'flights', fid, user)
    p = bridge.dosya_yolu(f.get('bin_path'))
    if not p:
        raise auth.hata(404, 'no_bin', 'Bu uçuşun .bin kaydı yok')
    ts = (f.get('started_at') or '')[:16].replace('-', '').replace(':', '').replace('T', '-')
    return FileResponse(p, media_type='application/octet-stream', filename=f'simumav-{fid}-{ts}.bin', headers={'Cache-Control': 'private, no-store'})


@router.get('/{fid}/params')
def op_params(fid: int, user=User):
    with db.connect() as conn:
        f = sahip(conn, 'flights', fid, user)
    p = bridge.dosya_yolu(f.get('params_path'))
    if not p:
        raise auth.hata(404, 'no_params', 'Bu uçuşun parametre dökümü yok')
    return FileResponse(p, media_type='text/plain; charset=utf-8', filename=f'simumav-{fid}.param', headers={'Cache-Control': 'private, no-store'})


@router.delete('/{fid}')
def delete_op(fid: int, request: Request, user=User):
    if fid in bridge._AKTIF:
        raise auth.hata(409, 'in_flight', 'Süren uçuş silinemez; önce durdurun')
    with db.connect() as conn:
        f = sahip(conn, 'flights', fid, user)
        bridge.ucus_dosyalarini_sil(f)
        conn.execute('DELETE FROM flights WHERE id = ?', (fid,))
        db.audit(conn, 'ops_delete', user['id'], auth.client_ip(request), f'flight {fid}')
        conn.commit()
    return {'ok': True, 'deleted': fid}
