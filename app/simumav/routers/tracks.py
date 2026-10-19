"""`/api/tracks` — parkurlar (≤ 20) + sunucu tarafı önizleme (uydu karosu + yükseklik gölgesi, 512×512 PNG; Pillow; önbellek files/previews/).
Karolar sim_terrain üzerinden (Esri World Imagery / AWS terrarium; disk önbelleği, sabit URL şablonları — SSRF yok)."""
import hashlib
import io
import json
import math
from typing import Optional

from fastapi import APIRouter, Request, Response
from pydantic import BaseModel, Field

from .. import auth, bridge, config, db
from ... import sim_terrain
from .common import User, hata_cevir, kota, sahip, track_api

router = APIRouter(prefix='/api/tracks')
RADIUS = (200, 5000)
PREVIEW_PX = 512


class WindIn(BaseModel):
    speed_ms: float = Field(0, ge=0, le=30)
    dir_deg: float = Field(0, ge=0, le=359.99)
    gust: float = Field(0, ge=0, le=20)


class TrackIn(BaseModel):
    name: str = Field(..., min_length=1, max_length=40)
    lat: float = Field(..., ge=-85, le=85)
    lon: float = Field(..., ge=-180, le=180)
    radius_m: int = Field(2000, ge=RADIUS[0], le=RADIUS[1])
    wind: Optional[WindIn] = None
    time_of_day: str = Field('day', max_length=8)
    weather: str = Field('clear', max_length=8)
    world_mode: str = Field('google3d', max_length=12)
    world: Optional[dict] = None
    gates: Optional[list] = None


class TrackPatch(BaseModel):
    name: Optional[str] = Field(None, min_length=1, max_length=40)
    lat: Optional[float] = Field(None, ge=-85, le=85)
    lon: Optional[float] = Field(None, ge=-180, le=180)
    radius_m: Optional[int] = Field(None, ge=RADIUS[0], le=RADIUS[1])
    wind: Optional[WindIn] = None
    time_of_day: Optional[str] = Field(None, max_length=8)
    weather: Optional[str] = Field(None, max_length=8)
    world_mode: Optional[str] = Field(None, max_length=12)
    world: Optional[dict] = None
    gates: Optional[list] = None
    is_default: Optional[bool] = None


def _enum(v, secenekler, ad):
    if v is not None and v not in secenekler:
        raise auth.hata(422, 'invalid', f'{ad} {" | ".join(secenekler)} olmalı')


def _dogrula(world, gates, lat, lon, radius, request, user):
    try:
        w = bridge.world_dogrula(world)
        g = bridge.gates_dogrula(gates, lat, lon, radius)
    except bridge.BridgeHata as e:
        db.audit_bagimsiz('plan_reject', user['id'], auth.client_ip(request), e.message)
        hata_cevir(e)
    return w, g


@router.get('')
def list_tracks(user=User):
    with db.connect() as conn:
        return {'tracks': [track_api(t) for t in db.rows(conn.execute('SELECT * FROM tracks WHERE user_id = ? ORDER BY is_default DESC, id', (user['id'],)))],
                'quota': config.QUOTA['tracks'], 'google3d': bool(config.GOOGLE_KEY)}


@router.post('', status_code=201)
def add_track(body: TrackIn, request: Request, user=User):
    _enum(body.time_of_day, bridge.TIME_OF_DAY, 'time_of_day'); _enum(body.weather, bridge.WEATHER, 'weather'); _enum(body.world_mode, bridge.WORLD_MODES, 'world_mode')
    world, gates = _dogrula(body.world, body.gates, body.lat, body.lon, body.radius_m, request, user)
    wind = (body.wind or WindIn()).model_dump()
    t = db.now()
    with db.connect() as conn:
        kota(conn, 'tracks', user, request)
        tid = conn.execute('INSERT INTO tracks (user_id, name, lat, lon, radius_m, wind, time_of_day, weather, world_mode, world, gates, created_at, updated_at) '
                           'VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)', (user['id'], body.name.strip(), body.lat, body.lon, body.radius_m, json.dumps(wind), body.time_of_day,
                                                                 body.weather, body.world_mode, json.dumps(world), json.dumps(gates), t, t)).lastrowid
        conn.commit()
        return track_api(sahip(conn, 'tracks', tid, user))


@router.put('/{tid}')
def update_track(tid: int, body: TrackPatch, request: Request, user=User):
    _enum(body.time_of_day, bridge.TIME_OF_DAY, 'time_of_day'); _enum(body.weather, bridge.WEATHER, 'weather'); _enum(body.world_mode, bridge.WORLD_MODES, 'world_mode')
    with db.connect() as conn:
        tr = sahip(conn, 'tracks', tid, user)
        lat, lon = body.lat if body.lat is not None else tr['lat'], body.lon if body.lon is not None else tr['lon']
        radius = body.radius_m or tr['radius_m']
        world, gates = _dogrula(body.world if body.world is not None else db.j(tr['world']), body.gates if body.gates is not None else db.j(tr['gates'], []),
                                lat, lon, radius, request, user)
        wind = body.wind.model_dump() if body.wind else db.j(tr['wind'])
        if body.is_default:
            conn.execute('UPDATE tracks SET is_default = 0 WHERE user_id = ?', (user['id'],))
        conn.execute('UPDATE tracks SET name = ?, lat = ?, lon = ?, radius_m = ?, wind = ?, time_of_day = ?, weather = ?, world_mode = ?, world = ?, gates = ?, is_default = ?, updated_at = ? WHERE id = ?',
                     ((body.name or tr['name']).strip(), lat, lon, radius, json.dumps(wind), body.time_of_day or tr['time_of_day'], body.weather or tr['weather'],
                      body.world_mode or tr['world_mode'], json.dumps(world), json.dumps(gates),
                      1 if body.is_default else (0 if body.is_default is False else tr['is_default']), db.now(), tid))
        conn.commit()
        return track_api(sahip(conn, 'tracks', tid, user))


@router.delete('/{tid}')
def delete_track(tid: int, user=User):
    fid, _ = bridge.aktif_ucus(user['id'])
    with db.connect() as conn:
        sahip(conn, 'tracks', tid, user)
        if conn.execute('SELECT COUNT(*) FROM tracks WHERE user_id = ?', (user['id'],)).fetchone()[0] <= 1:
            raise auth.hata(409, 'last_track', 'En az bir parkur kalmalı')
        if fid is not None and db.row(conn.execute('SELECT 1 FROM flights WHERE id = ? AND track_id = ?', (fid, tid))):
            raise auth.hata(409, 'in_use', 'Bu parkurda şu an uçuş var')
        conn.execute('DELETE FROM tracks WHERE id = ?', (tid,))
        conn.commit()
    return {'ok': True, 'deleted': tid}


# ---------------- önizleme PNG ----------------
def _z_sec(lat, radius_m):
    mpp = 2.0 * radius_m / PREVIEW_PX
    z = int(math.floor(math.log2(156543.03 * math.cos(math.radians(lat)) / mpp)))
    return max(10, min(17, z))


def preview_uret(lat, lon, radius_m):
    """512×512 PNG baytları: uydu karoları (img) + terrarium yükseklik gölgesi. Kaynak hatası → sim_terrain.KaynakHata."""
    from PIL import Image, ImageFilter
    z = _z_sec(lat, radius_m)
    mpp = 156543.03 * math.cos(math.radians(lat)) / 2 ** z
    half_px = radius_m / mpp
    fx, fy = sim_terrain.lonlat_karo(lon, lat, z)
    cx, cy = fx * 256, fy * 256
    x0, y0, x1, y1 = int(cx - half_px), int(cy - half_px), int(math.ceil(cx + half_px)), int(math.ceil(cy + half_px))
    tx0, ty0, tx1, ty1 = x0 // 256, y0 // 256, x1 // 256, y1 // 256
    if (tx1 - tx0 + 1) * (ty1 - ty0 + 1) > 36:
        raise ValueError('önizleme alanı çok büyük')
    canvas = Image.new('RGB', ((tx1 - tx0 + 1) * 256, (ty1 - ty0 + 1) * 256), (40, 44, 48))
    lim = 2 ** z
    for ty in range(ty0, ty1 + 1):
        for tx in range(tx0, tx1 + 1):
            if not (0 <= ty < lim):
                continue
            try:
                data, _ = sim_terrain.karo('img', z, tx % lim, ty)
                canvas.paste(Image.open(io.BytesIO(data)).convert('RGB'), ((tx - tx0) * 256, (ty - ty0) * 256))
            except (sim_terrain.KaynakHata, ValueError, OSError):
                continue
    img = canvas.crop((x0 - tx0 * 256, y0 - ty0 * 256, x1 - tx0 * 256, y1 - ty0 * 256)).resize((PREVIEW_PX, PREVIEW_PX), Image.LANCZOS)
    # yükseklik gölgesi: terrarium z13 (ya da daha kaba) karosundan eğim → çarpımsal gölge
    try:
        ez = min(13, z)
        efx, efy = sim_terrain.lonlat_karo(lon, lat, ez)
        emp = 156543.03 * math.cos(math.radians(lat)) / 2 ** ez
        eh = radius_m / emp
        ex0, ey0 = int(efx * 256 - eh), int(efy * 256 - eh)
        ex1, ey1 = int(math.ceil(efx * 256 + eh)), int(math.ceil(efy * 256 + eh))
        w, hgt = max(2, ex1 - ex0), max(2, ey1 - ey0)
        if w * hgt <= 600 * 600:
            hmap = [[0.0] * w for _ in range(hgt)]
            for j in range(hgt):
                for i in range(w):
                    hmap[j][i] = sim_terrain._piksel(ez, ex0 + i, ey0 + j)
            shade = Image.new('L', (w, hgt), 128)
            px = shade.load()
            for j in range(1, hgt - 1):
                for i in range(1, w - 1):
                    dx = (hmap[j][i + 1] - hmap[j][i - 1]) / (2 * emp)
                    dy = (hmap[j + 1][i] - hmap[j - 1][i]) / (2 * emp)
                    # güneş kuzeybatıdan, 45°: gölge = cos(açı)
                    nz = 1.0 / math.sqrt(1 + dx * dx + dy * dy)
                    s = 0.55 + 0.45 * max(0.0, min(1.0, nz * 0.707 + (-dx * -0.5 - dy * -0.5) * nz * 0.707))
                    px[i, j] = int(max(60, min(255, s * 200)))
            shade = shade.resize((PREVIEW_PX, PREVIEW_PX), Image.BILINEAR).filter(ImageFilter.GaussianBlur(1.2))
            sh = shade.point(lambda v: v)   # noqa: PLW0108
            img = Image.composite(img, Image.new('RGB', img.size, (0, 0, 0)), sh.point(lambda v: min(255, int(v * 1.3))))
    except (sim_terrain.KaynakHata, ValueError, OSError, ZeroDivisionError):
        pass
    buf = io.BytesIO()
    img.save(buf, 'PNG', optimize=True)
    return buf.getvalue()


def _preview_yolu(t):
    key = hashlib.sha1(f"{t['lat']:.5f},{t['lon']:.5f},{t['radius_m']}".encode()).hexdigest()[:12]
    return config.FILES_DIR / 'previews' / f"track-{int(t['id'])}-{key}.png"


@router.get('/{tid}/preview.png')
def preview(tid: int, response: Response, user=User):
    with db.connect() as conn:
        t = sahip(conn, 'tracks', tid, user)
    p = _preview_yolu(t)
    if not p.is_file():
        try:
            data = preview_uret(float(t['lat']), float(t['lon']), int(t['radius_m']))
        except sim_terrain.KaynakHata as e:
            raise auth.hata(e.kod, 'tile_source', str(e))
        except ValueError as e:
            raise auth.hata(422, 'invalid', str(e))
        for eski in p.parent.glob(f'track-{int(tid)}-*.png'):   # konum değişti: eski önizleme
            try:
                eski.unlink()
            except OSError:
                pass
        p.write_bytes(data)
        with db.connect() as conn:
            conn.execute('UPDATE tracks SET preview_png = ? WHERE id = ?', (f'previews/{p.name}', tid))
            conn.commit()
    return Response(content=p.read_bytes(), media_type='image/png', headers={'Cache-Control': 'private, max-age=86400', 'X-Content-Type-Options': 'nosniff'})
