"""`/api/match` + `WS /ws/match/{id}` — ÇOK OYUNCULU KARŞILAŞMA (halka yarışı; docs/simumav.md §18). Çalışma zamanı `app/simumav/match.py`.

- `GET  /api/match/meta` → sınırlar (oyuncu, halka, şifre), sunucu SITL kapasitesi, benim bitmemiş karşılaşmam.
- `POST /api/match/rings-preview {drone_id, track_id, rings, players?}` → {cfg, rings, starts} (aynı tohum = aynı parkur).
- `POST /api/match {drone_id, track_id, launch?, camera?, rings, password, max_players}` → 201 anlık görüntü (+ code).
- `GET  /api/match` → son karşılaşmalarım · `GET /api/match/{id}` (yalnız oyuncular; bellekte değilse DB satırı).
- `GET  /api/match/invite/{code}` → davet sayfası özeti (şifresiz: kurucu, parkur, araç, halka sayısı, doluluk; şifre/oyuncu adları yok).
- `POST /api/match/join {code, password}` → lobi (403 bad_password + kalan hak · 429 too_many_attempts · 404 · 409 full/started/match_open/kicked).
- `POST /api/match/{id}/ready {ready}` · `/leave` · `/kick {user_id}` (kurucu) · `/start` (kurucu) · `/cancel` (kurucu) · `/password {password}` (kurucu; yenisi).
- WS: hello{match, me} · match{match} · player · state · countdown{start_at} · pos (10 Hz) · ring · finish · wrong_way · result · pong{now};
  istemci → ping, ready. Oyuncu değilse 4403.
- HEPGO §41 İT DALAŞI: oluşturma/önizleme gövdesinde `kind: 'dogfight'` + `dogfight {distance_m, alt_m, time_limit_min, range_m, cone_deg, hold_s,
  area_radius_m, roles}` (oyuncu sayısı 2'ye sabitlenir); WS ek olarak `dogfight {kind}` ve `pos.df` (HUD); anlık görüntüde `kind`, `dogfight`.
"""
import asyncio
import json
import time
from typing import Optional

from fastapi import APIRouter, Request, WebSocket, WebSocketDisconnect
from pydantic import BaseModel, Field

from ... import flightsim
from ... import flightsim_match_core as core
from .. import auth, bridge, config, db
from .. import match as M
from .common import User, hata_cevir, sahip
from .fly import _Oran, _sender, _ws_ac

router = APIRouter(prefix='/api/match')
ws_router = APIRouter()


class RingsIn(BaseModel):
    count: Optional[int] = None
    min_alt_m: Optional[float] = None
    max_alt_m: Optional[float] = None
    diameter_m: Optional[float] = None
    radius_m: Optional[float] = None
    time_limit_min: Optional[int] = None
    seed: Optional[int] = None


class DogfightIn(BaseModel):
    distance_m: Optional[float] = None
    alt_m: Optional[float] = None
    time_limit_min: Optional[int] = None
    range_m: Optional[float] = None
    cone_deg: Optional[float] = None
    hold_s: Optional[float] = None
    area_radius_m: Optional[float] = None
    roles: Optional[str] = Field(None, max_length=16)
    seed: Optional[int] = None


class PreviewIn(BaseModel):
    drone_id: int
    track_id: int
    rings: Optional[RingsIn] = None
    players: Optional[int] = Field(None, ge=1, le=8)
    kind: Optional[str] = Field(None, max_length=16)
    dogfight: Optional[DogfightIn] = None


class CreateIn(BaseModel):
    drone_id: int
    track_id: int
    launch: Optional[dict] = None
    camera: Optional[str] = Field(None, max_length=8)
    rings: Optional[RingsIn] = None
    password: str = Field(..., max_length=64)
    max_players: int = Field(..., ge=2, le=8)
    kind: Optional[str] = Field(None, max_length=16)       # HEPGO §41 'rings' | 'dogfight'
    dogfight: Optional[DogfightIn] = None


class JoinIn(BaseModel):
    code: str = Field(..., max_length=64)
    password: str = Field(..., max_length=64)


class ReadyIn(BaseModel):
    ready: bool = True


class KickIn(BaseModel):
    user_id: int


class PasswordIn(BaseModel):
    password: str = Field(..., max_length=64)


def _h(e):
    hata_cevir(e)


def _cfg(drone_type, rings, kind=None, dogfight=None):
    tip = M.ctip(drone_type)
    if drone_type not in M.TIPLER or tip is None:
        raise auth.hata(422, 'invalid', 'Karşılaşmada bu araç tipi seçilemez (halkalar havada; kara aracı yok)')
    if (kind or core.TUR_HALKA) not in core.TURLER:
        raise auth.hata(422, 'invalid', "kind 'rings' | 'dogfight' olmalı")
    try:
        if kind == core.TUR_IT:
            return core.it_ayar_dogrula(dogfight.model_dump(exclude_none=True) if dogfight else {}, tip)
        return core.halka_ayar_dogrula(rings.model_dump(exclude_none=True) if rings else {}, tip)
    except core.MacHata as e:
        raise auth.hata(422, 'invalid', str(e))


def _limits():
    return {'players': [2, M.oyuncu_siniri()], 'count': list(core.HALKA_SAYI), 'alt_m': list(core.YUKSEKLIK), 'diameter_m': list(core.CAP),
            'radius_m': list(core.PARKUR), 'time_limit_min': list(core.SURE_DK), 'password': list(M.SIFRE), 'types': list(M.TIPLER),
            'defaults': {'dikey': core.halka_ayar_varsayilan('multirotor'), 'ucak': core.halka_ayar_varsayilan('sabit_kanat')},
            'countdown_s': core.GERI_SAYIM_S, 'lobby_timeout_s': core.LOBI_ZAMAN_ASIMI_S, 'attempts': M.DENEME_KULLANICI,
            'kinds': list(core.TURLER), 'dogfight': {'distance_m': list(core.IT_MESAFE), 'alt_m': list(core.IT_IRTIFA), 'time_limit_min': list(core.IT_SURE_DK),
                                                     'range_m': list(core.IT_MENZIL), 'cone_deg': list(core.IT_KONI), 'hold_s': list(core.IT_TUTMA),
                                                     'area_radius_m': list(core.IT_ALAN), 'roles': list(core.IT_ROLLER), 'guard_s': core.KORUMA_S,
                                                     'defaults': {'dikey': core.it_ayar_varsayilan('multirotor'), 'ucak': core.it_ayar_varsayilan('sabit_kanat')}}}


def _mac(mid, user):
    """Bellekteki karşılaşma (oyuncuysa) ya da None; oyuncu değilse 404 (varlık sızmaz)."""
    m = M.MANAGER.get(mid)
    if m is not None:
        if not m.oyuncu_mu(user['id']):
            raise auth.hata(404, 'not_found', 'Karşılaşma bulunamadı')
        m.gordu(user['id'])
    return m


@router.get('/meta')
async def meta(user=User):
    M.MANAGER.kurtar()
    m = M.MANAGER.kullanici_maci(user['id'])
    return {'limits': _limits(), 'capacity': {'max': config.MAX_FLIGHTS, 'used': bridge.aktif_sayisi()},
            'current': {'id': m.id, 'state': m.durum, 'host': m.host_id == user['id']} if m else None}


@router.post('/rings-preview')
async def rings_preview(body: PreviewIn, user=User):
    with db.connect() as conn:
        drone = sahip(conn, 'drones', body.drone_id, user)
        track = sahip(conn, 'tracks', body.track_id, user)
    cfg = _cfg(drone['type'], body.rings, body.kind, body.dogfight)
    if not cfg.get('seed'):
        cfg['seed'] = 1 + int(time.time() * 1000) % (2 ** 31 - 2)
    if body.kind == core.TUR_IT:   # HEPGO §41: halka yok; iki başlangıç noktası (kovalayan, kaçan)
        return {'cfg': cfg, 'rings': [], 'starts': M.baslangic_onizleme(2, drone['type'], track, [], dogfight=cfg), 'kind': core.TUR_IT}
    rings = core.halkalar_uret(cfg, {'lat': float(track['lat']), 'lon': float(track['lon']), 'alt': 0.0})
    return {'cfg': cfg, 'rings': rings, 'starts': M.baslangic_onizleme(body.players or 2, drone['type'], track, rings), 'kind': core.TUR_HALKA}


@router.post('', status_code=201)
async def create(body: CreateIn, request: Request, user=User):
    auth.oran('match_create', 10, 3600, user_id=user['id'])
    with db.connect() as conn:
        drone = sahip(conn, 'drones', body.drone_id, user)
        track = sahip(conn, 'tracks', body.track_id, user)
    cfg = _cfg(drone['type'], body.rings, body.kind, body.dogfight)
    kind = body.kind or core.TUR_HALKA
    try:
        sifre = M.sifre_dogrula(body.password)
        ust = M.oyuncu_siniri()
        if kind == core.TUR_IT and body.max_players != 2:
            raise M.H(422, 'invalid', 'İt dalaşı tam 2 oyunculu')
        if not (2 <= body.max_players <= ust):
            raise M.H(422, 'invalid', f'Bu sunucuda karşılaşma 2–{ust} oyunculu olabilir (her oyuncu kendi simülatörünü alır)')
        launch = bridge.launch_dogrula(body.launch or {'method': 'wheels'})
        try:
            camera = flightsim.kamera_dogrula(body.camera)
        except flightsim.SimHata as e:
            raise M.H(422, 'invalid', str(e))
        m = await M.MANAGER.olustur(user, drone, track, launch, camera, cfg, sifre, body.max_players, auth.client_ip(request), tur=kind)
    except bridge.BridgeHata as e:
        _h(e)
    return {**m.anlik(), 'me': user['id']}


@router.get('')
async def mine(user=User):
    """Son 20 karşılaşmam (oyuncusu olduklarım)."""
    with db.connect() as conn:
        rs = db.rows(conn.execute('SELECT m.id, m.state, m.reason, m.host_id, m.settings, m.winner_id, m.created_at, m.ended_at, m.kind, mp.rank, mp.status, mp.flight_id, '
                                  '(SELECT COUNT(*) FROM match_players x WHERE x.match_id = m.id) AS n, '
                                  '(SELECT name FROM match_players x WHERE x.match_id = m.id AND x.user_id = m.winner_id) AS winner_name '
                                  'FROM matches m JOIN match_players mp ON mp.match_id = m.id AND mp.user_id = ? ORDER BY m.id DESC LIMIT 20', (user['id'],)))
    out = []
    for r in rs:
        st = M.ayar_ozeti(db.j(r.pop('settings')))
        live = M.MANAGER.get(r['id'])
        out.append({**r, 'state': live.durum if live else r['state'], 'live': live is not None, 'track': st['track']['name'], 'drone_type': st['drone']['type'],
                    'host': r['host_id'] == user['id']})
    return out


@router.get('/invite/{code}')
async def invite(code: str, request: Request, user=User):
    M.MANAGER.kurtar()
    m = M.MANAGER.kod_ile(code)
    if m is None:
        auth.oran('match_code_fail', 30, 600, ip=auth.client_ip(request))   # kod tahmini: IP başına başarısız sorgu sınırı
        with db.connect() as conn:
            r = db.row(conn.execute('SELECT state FROM matches WHERE code = ?', (str(code)[:64],)))
        if r:
            raise auth.hata(409, 'ended', 'Bu karşılaşma bitti ya da iptal edildi')
        raise auth.hata(404, 'not_found', 'Davet bağlantısı geçersiz')
    host = m.lobi.get(m.host_id) or {}
    st = M.ayar_ozeti(m.settings)
    return {'code': m.code, 'id': m.id if m.oyuncu_mu(user['id']) else None, 'joined': m.oyuncu_mu(user['id']), 'state': m.durum, 'host_name': host.get('name'),
            'track': st['track']['name'], 'world_mode': st['track']['world_mode'], 'drone': {'name': st['drone']['name'], 'type': st['drone']['type']},
            'rings': len(m.halkalar), 'players': len(m.lobi) if m.k is None else len(m.k.aktifler()), 'max_players': m.max_players, 'kind': m.tur,
            'me': {'id': user['id'], 'email': user['email'], 'name': user['display_name']}, 'kicked': user['id'] in m.yasakli}


@router.post('/join')
async def join(body: JoinIn, request: Request, user=User):
    M.MANAGER.kurtar()
    ip = auth.client_ip(request)
    m = M.MANAGER.kod_ile(body.code)
    if m is None:
        auth.oran('match_code_fail', 30, 600, ip=ip)
        raise auth.hata(404, 'not_found', 'Davet bağlantısı geçersiz ya da karşılaşma bitti')
    if m.oyuncu_mu(user['id']):
        m.gordu(user['id'])
        return {**m.anlik(), 'me': user['id']}
    try:
        with db.connect() as conn:
            kalan = M.deneme_denetle(conn, m.id, user['id'], ip)
        dogru = await asyncio.get_running_loop().run_in_executor(None, M.sifre_dogru, body.password, m.pass_hash)
        with db.connect() as conn:
            M.deneme_yaz(conn, m.id, user['id'], ip, dogru)
            if not dogru:
                db.audit(conn, 'match_bad_password', user['id'], ip, f'match {m.id}')
            conn.commit()
        if not dogru:
            raise M.H(403, 'bad_password', 'Şifre hatalı' + (f' (kalan deneme: {kalan - 1})' if kalan - 1 > 0 else ''), remaining=max(0, kalan - 1))
        diger = M.MANAGER.kullanici_maci(user['id'])
        if diger is not None and diger is not m:
            raise M.H(409, 'match_open', 'Başka bir bitmemiş karşılaşmadasınız; önce ondan ayrılın', match_id=diger.id)
        m.katil(user, time.time())
    except bridge.BridgeHata as e:
        _h(e)
    db.audit_bagimsiz('match_join', user['id'], ip, f'match {m.id}')
    return {**m.anlik(), 'me': user['id']}


@router.get('/{mid}')
async def get_match(mid: int, user=User):
    m = _mac(mid, user)
    if m is not None:
        return {**m.anlik(), 'me': user['id']}
    with db.connect() as conn:
        r = db.row(conn.execute('SELECT m.* FROM matches m JOIN match_players p ON p.match_id = m.id AND p.user_id = ? WHERE m.id = ?', (user['id'], int(mid))))
    if not r:
        raise auth.hata(404, 'not_found', 'Karşılaşma bulunamadı')
    return {**M.satir_dict(r, user['id']), 'me': user['id']}


def _canli(mid, user):
    m = _mac(mid, user)
    if m is None:
        raise auth.hata(409, 'ended', 'Karşılaşma bitti')
    return m


@router.post('/{mid}/ready')
async def ready(mid: int, body: ReadyIn, user=User):
    m = _canli(mid, user)
    try:
        m.hazir_ayarla(user['id'], body.ready)
    except bridge.BridgeHata as e:
        _h(e)
    return {**m.anlik(), 'me': user['id']}


@router.post('/{mid}/leave')
async def leave(mid: int, user=User):
    m = _canli(mid, user)
    m.ayril(user['id'], time.time())
    return {**m.anlik(), 'me': user['id']}


@router.post('/{mid}/kick')
async def kick(mid: int, body: KickIn, user=User):
    m = _canli(mid, user)
    try:
        m.cikar(user['id'], body.user_id, time.time())
    except bridge.BridgeHata as e:
        _h(e)
    return {**m.anlik(), 'me': user['id']}


@router.post('/{mid}/start')
async def start(mid: int, request: Request, user=User):
    m = _canli(mid, user)
    try:
        m.baslat(user['id'], time.time())
    except bridge.BridgeHata as e:
        if e.error == 'server_full':
            db.audit_bagimsiz('quota', user['id'], auth.client_ip(request), f'match {mid}: {e.message}'[:200])
        _h(e)
    db.audit_bagimsiz('match_start', user['id'], auth.client_ip(request), f'match {mid} · {len(m.k.oyuncular)} oyuncu')
    return {**m.anlik(), 'me': user['id']}


@router.post('/{mid}/cancel')
async def cancel(mid: int, user=User):
    m = _canli(mid, user)
    if m.host_id != user['id']:
        raise auth.hata(403, 'forbidden', 'Yalnız kurucu iptal edebilir')
    m.iptal('kurucu_iptal')
    return {**m.anlik(), 'me': user['id']}


@router.post('/{mid}/password')
async def password(mid: int, body: PasswordIn, user=User):
    m = _canli(mid, user)
    if m.host_id != user['id']:
        raise auth.hata(403, 'forbidden', 'Yalnız kurucu şifreyi değiştirebilir')
    try:
        sifre = M.sifre_dogrula(body.password)
    except bridge.BridgeHata as e:
        _h(e)
    m.pass_hash = await asyncio.get_running_loop().run_in_executor(None, M.sifre_ozet, sifre)
    with db.connect() as conn:
        conn.execute('UPDATE matches SET pass_hash = ? WHERE id = ?', (m.pass_hash, m.id))
        conn.commit()
    return {'ok': True}


# ---------------------------------------------------------------- WebSocket
@ws_router.websocket('/ws/match/{mid}')
async def ws_match(ws: WebSocket, mid: int):
    user = await _ws_ac(ws)
    if not user:
        return
    m = M.MANAGER.get(mid)
    if m is None or not m.oyuncu_mu(user['id']):
        try:
            await ws.send_text(json.dumps({'t': 'error', 'error': 'forbidden'}))
            await ws.close(code=4403)
        except Exception:   # noqa: BLE001
            pass
        return
    q = m.izleyici_ekle(ws, user['id'])
    sender = asyncio.create_task(_sender(ws, q))
    flightsim._kuyruga(q, json.dumps({'t': 'hello', 'match': m.anlik(), 'me': user['id']}, ensure_ascii=False, default=str))
    m.degisti(kaydet=False)   # çevrimiçi noktası herkese
    oran = _Oran(20, 1)
    try:
        while True:
            raw = await ws.receive_text()
            if not oran.tik():
                await ws.close(code=4429)
                break
            if len(raw) > 2048:
                continue
            try:
                msg = json.loads(raw)
            except ValueError:
                continue
            if not isinstance(msg, dict):
                continue
            t = msg.get('t')
            m.gordu(user['id'])
            if t == 'ping':
                flightsim._kuyruga(q, json.dumps({'t': 'pong', 'now': time.time()}))
            elif t == 'ready':
                m.ready.add(user['id'])
    except (WebSocketDisconnect, Exception):   # noqa: BLE001
        pass
    finally:
        m.izleyici_sil(ws)
        sender.cancel()
        if not m.bitti():
            m.degisti(kaydet=False)
