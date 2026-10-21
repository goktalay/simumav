"""SIMUMAV veritabanı (sqlite, WAL) — şema docs/simumav.md §3 + oturum/denetim tabloları (§7). HEPGO `app.db` ile ilişkisi yoktur.
Yeni kullanıcı: varsayılan pilot (p01, hesap adı), hazır FPV dron (FPV-1, glb:iris_fpv) ve TRTEST parkuru (Kalecik) otomatik oluşur.
Migrasyon: `schema_version` tablosu; her sürüm `_MIGRATIONS` listesinde idempotent SQL."""
import json
import sqlite3
import time
from datetime import datetime

from fastapi import Depends

from . import config

SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY,
    mt_user_id INTEGER NOT NULL UNIQUE,         -- hesap servisi kullanıcı kimliği (dev login: negatif)
    email TEXT NOT NULL,
    display_name TEXT NOT NULL,
    avatar TEXT,
    lang TEXT NOT NULL DEFAULT 'tr',
    theme TEXT NOT NULL DEFAULT 'dark',
    settings TEXT NOT NULL DEFAULT '{}',        -- JSON: sound, analog_fpv, …
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    last_login TEXT
);
CREATE TABLE IF NOT EXISTS sessions (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash TEXT NOT NULL UNIQUE,            -- sha256(smsid); düz değer yalnız çerezde
    created_at REAL NOT NULL,
    last_seen REAL NOT NULL,
    ip TEXT,
    ua TEXT
);
CREATE INDEX IF NOT EXISTS ix_sessions_user ON sessions(user_id);
CREATE TABLE IF NOT EXISTS pilots (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    character TEXT NOT NULL DEFAULT 'p01',
    is_default INTEGER NOT NULL DEFAULT 0,
    flights INTEGER NOT NULL DEFAULT 0,
    hours REAL NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_pilots_user ON pilots(user_id);
CREATE TABLE IF NOT EXISTS drones (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    type TEXT NOT NULL,                         -- multirotor | plane | heli | fpv | interceptor | vtol | rover (CHECK yok → göç gerekmez)
    model_key TEXT NOT NULL,                    -- flightsim_models anahtarı (builtin:…) ya da proc:<şablon>
    params TEXT NOT NULL DEFAULT '{}',          -- JSON {AD: değer} — yalnız beyaz liste (bridge.params_dogrula)
    color TEXT NOT NULL DEFAULT '#ff6a00',
    preview TEXT,                               -- dönen 3B için GLB yolu (statik; kullanıcıdan alınmaz)
    airframe TEXT,                              -- kontrol düzeni (sabit kanat ailesi): classic | elevon | vtail; NULL → katalog modelinin düzeni (bridge.model_airframe)
    power TEXT,                                 -- JSON güç ve yakıt (§10, power.py): {engine, max_speed_ms, fuel_l, fuel_km_per_l, elec_cells, elec_mah, elec_w,
                                                --   fuel_km_per_l_last?, elec_w_last?, measured_at?}; NULL → katalog modelinin varsayılanı
    is_default INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_drones_user ON drones(user_id);
CREATE TABLE IF NOT EXISTS tracks (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    lat REAL NOT NULL, lon REAL NOT NULL,
    alt_mode TEXT NOT NULL DEFAULT 'terrain',
    radius_m INTEGER NOT NULL DEFAULT 2000,
    wind TEXT NOT NULL DEFAULT '{"speed_ms":3,"dir_deg":270,"gust":0}',
    time_of_day TEXT NOT NULL DEFAULT 'day',
    weather TEXT NOT NULL DEFAULT 'clear',
    world_mode TEXT NOT NULL DEFAULT 'google3d',   -- real | google3d | procedural
    world TEXT NOT NULL DEFAULT '{}',              -- JSON: HEPGO WORLD_DEFAULTS alt kümesi (seed, size_m, tree_density, mountain_height, mountain_count,
                                                   --       building_count, runway, runway_heading, water, fog, landing_circle_m)
    gates TEXT NOT NULL DEFAULT '[]',              -- JSON: FPV halkaları [{i, lat, lon, agl_m, yaw_deg, radius_m, kind:'ring'|'gate'}]
    preview_png TEXT,
    is_default INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_tracks_user ON tracks(user_id);
CREATE TABLE IF NOT EXISTS missions (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    track_id INTEGER NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    kind TEXT NOT NULL,                         -- corridor | free | spray | fpv_flags | survey
    plan TEXT NOT NULL DEFAULT '{}',            -- JSON (route + tür parametreleri; HEPGO flightsim_mission biçimi)
    preview_png TEXT,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_missions_user ON missions(user_id);
CREATE TABLE IF NOT EXISTS flights (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    pilot_id INTEGER REFERENCES pilots(id) ON DELETE SET NULL,
    drone_id INTEGER REFERENCES drones(id) ON DELETE SET NULL,
    track_id INTEGER REFERENCES tracks(id) ON DELETE SET NULL,
    mission_id INTEGER REFERENCES missions(id) ON DELETE SET NULL,
    launch TEXT NOT NULL DEFAULT 'wheels',      -- wheels | ramp | vehicle | hand | pod4 | pod8 | tube | handheld (HEPGO §27; CHECK yok → göç gerekmez)
    started_at TEXT NOT NULL,
    ended_at TEXT,
    duration_s INTEGER,
    result TEXT,                                -- ok | crash | abort | NULL (sürüyor)
    summary TEXT,                               -- JSON (flightsim_mission özeti)
    bin_path TEXT,                              -- core/ altı göreli yol (uploads/flightlogs/<x>.bin)
    video_path TEXT,
    params_path TEXT,                           -- core/ altı göreli yol (sim_runs/<id>/params.param)
    mp_port INTEGER,
    replay_cache TEXT,                          -- core/ altı göreli yol (sim_replay/<log_id>.json.gz)
    core_log_id INTEGER,                        -- çekirdek flight_logs kimliği (.bin)
    core_run_id INTEGER,                        -- çekirdek drone_sim_runs kimliği
    snapshot TEXT NOT NULL DEFAULT '{}',        -- JSON: dron/pilot/parkur adları (silinirlerse kart yine dolu kalsın)
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_flights_user ON flights(user_id, started_at);
CREATE TABLE IF NOT EXISTS sim_runs_link (
    flight_id INTEGER PRIMARY KEY REFERENCES flights(id) ON DELETE CASCADE,
    sim_id INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS audit (
    id INTEGER PRIMARY KEY,
    ts TEXT NOT NULL,
    ip TEXT,
    user_id INTEGER,
    event TEXT NOT NULL,                        -- login | logout | fly_start | fly_stop | quota | rate | param_reject | plan_reject | csrf | …
    detail TEXT
);
CREATE INDEX IF NOT EXISTS ix_audit_ts ON audit(ts);
-- Destek ekleri (docs/simumav.md §9): talep Merkez'de tutulur, ekran görüntüsü/dosya burada; Merkez gövdesine rastgele token'lı bağlantı yazılır
CREATE TABLE IF NOT EXISTS support_files (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    ticket_id INTEGER,                          -- Merkez talep kimliği (hesap servisi yanıtı)
    token TEXT NOT NULL UNIQUE,                 -- 32 bayt urlsafe rastgele; /api/support/att/<token> (oturumsuz — Merkez personeli açar)
    name TEXT NOT NULL,
    mime TEXT NOT NULL,
    size INTEGER NOT NULL,
    path TEXT NOT NULL,                         -- DATA_DIR göreli: files/support/<uid>/<token>.<ext>
    created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_support_files_t ON support_files(user_id, ticket_id);
-- ÇOK OYUNCULU KARŞILAŞMA (docs/simumav.md §18; halka yarışı, çekirdek app/flightsim_match_core.py). Durum makinesi bellekte (match.py);
-- satır her durum değişiminde güncellenir. Davet kodu tahmin edilemez (secrets.token_urlsafe(16)); şifre yalnız scrypt özeti (düz değer saklanmaz).
CREATE TABLE IF NOT EXISTS matches (
    id INTEGER PRIMARY KEY,
    code TEXT NOT NULL UNIQUE,                  -- davet kodu (bağlantı /app/#/match/join/<code>)
    host_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    pass_hash TEXT NOT NULL,                    -- scrypt$<tuz hex>$<özet hex>
    state TEXT NOT NULL,                        -- LOBI | HAZIRLIK | GERI_SAYIM | YARIS | BITTI | IPTAL
    reason TEXT,                                -- bitiş / iptal nedeni (core REASON + terk_edildi)
    max_players INTEGER NOT NULL,
    settings TEXT NOT NULL DEFAULT '{}',        -- JSON: dron + parkur anlık görüntüsü, kalkış, kamera
    rings_cfg TEXT NOT NULL DEFAULT '{}',       -- JSON: core.halka_ayar_dogrula çıktısı (+ seed)
    rings TEXT NOT NULL DEFAULT '[]',           -- JSON: core.halkalar_uret
    result TEXT,                                -- JSON: core.Karsilasma.sonuc() (BITTI)
    winner_id INTEGER,
    created_at TEXT NOT NULL, started_at TEXT, ended_at TEXT
);
CREATE INDEX IF NOT EXISTS ix_matches_host ON matches(host_id, created_at);
CREATE TABLE IF NOT EXISTS match_players (
    match_id INTEGER NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    is_host INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL,                       -- geldi | hazirlaniyor | hazir | ayrildi | cikarildi | dustu (core oyuncu durumları)
    flight_id INTEGER,                          -- oyuncunun flights kaydı (yarış oturumu)
    rank INTEGER, rings INTEGER, time_s REAL,
    joined_at TEXT NOT NULL,
    PRIMARY KEY (match_id, user_id)
);
CREATE INDEX IF NOT EXISTS ix_match_players_user ON match_players(user_id);
CREATE TABLE IF NOT EXISTS match_attempts (     -- şifre denemeleri (kaba kuvvet sınırı; 1 günden eskiler silinir)
    id INTEGER PRIMARY KEY,
    match_id INTEGER,
    user_id INTEGER,
    ip TEXT,
    ok INTEGER NOT NULL DEFAULT 0,
    ts REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_match_attempts ON match_attempts(ts);
CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL);
"""
# [(sürüm, [sql, …])] — idempotent. v2 (HEPGO §25): "interceptor" artık 4 pervaneli tailsitter; eski sabit kanat jet/delta interceptor dronları
# (glb:jet, glb:zephyr, proc:interceptor) ve uçuş anlık görüntüleri 'plane' tipine taşınır — model, parametre, güç ayarları aynen kalır.
_ESKI_ICEPT = "('glb:jet', 'glb:zephyr', 'proc:interceptor')"
_MIGRATIONS = [
    (2, [f"UPDATE drones SET type = 'plane' WHERE type = 'interceptor' AND model_key IN {_ESKI_ICEPT}",
         "UPDATE flights SET snapshot = json_set(snapshot, '$.drone.type', 'plane') WHERE json_valid(snapshot) "
         f"AND json_extract(snapshot, '$.drone.type') = 'interceptor' AND json_extract(snapshot, '$.drone.model_key') IN {_ESKI_ICEPT}"]),
    # v3 (§18 çok oyunculu karşılaşma): matches / match_players / match_attempts tabloları SCHEMA'da (CREATE IF NOT EXISTS); flights.match_id sütunu
    # init() içinde PRAGMA denetimiyle eklenir (ALTER yalnız yoksa → idempotent). Veri dönüşümü yok.
    (3, []),
]
SCHEMA_VERSION = 3

# TR TEST Kalecik (Ankara) UAV test sahası — tesisin resmî koordinatı kamuya açık kaynaklarda yok; Kalecik ilçe merkezi (40.0972N 33.4083E,
# 725 m) yakınındaki sözleşme değeri kullanılır. Kullanıcı parkuru düzenleyip kaydırabilir.
TRTEST = {'name': 'TRTEST', 'lat': 40.0990, 'lon': 33.4101, 'radius_m': 2000, 'wind': {'speed_ms': 3, 'dir_deg': 270, 'gust': 0},
          'time_of_day': 'day', 'weather': 'clear'}
DEFAULT_DRONE = {'name': 'FPV-1', 'type': 'fpv', 'model_key': 'glb:iris_fpv', 'color': '#ff6a00'}


def now():
    return datetime.now().isoformat(timespec='seconds')


def connect():
    conn = sqlite3.connect(config.DB_PATH, timeout=15, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute('PRAGMA foreign_keys = ON')
    conn.execute('PRAGMA journal_mode = WAL')
    return conn


def init():
    with connect() as conn:
        conn.executescript(SCHEMA)
        kolonlar = {r[1] for r in conn.execute('PRAGMA table_info(drones)')}
        if 'airframe' not in kolonlar:   # eski taban: kontrol düzeni sütunu (HEPGO §13.1)
            conn.execute('ALTER TABLE drones ADD COLUMN airframe TEXT')
        if 'power' not in kolonlar:      # eski taban: güç ve yakıt (§10); NULL = model varsayılanı → mevcut dronlar bozulmaz
            conn.execute('ALTER TABLE drones ADD COLUMN power TEXT')
        if 'match_id' not in {r[1] for r in conn.execute('PRAGMA table_info(flights)')}:   # §18: karşılaşma uçuşu (NULL = tek oyunculu)
            conn.execute('ALTER TABLE flights ADD COLUMN match_id INTEGER')
        conn.execute('CREATE INDEX IF NOT EXISTS ix_flights_match ON flights(match_id)')
        cur = conn.execute('SELECT version FROM schema_version').fetchone()
        ver = cur[0] if cur else 0
        for v, sqls in _MIGRATIONS:
            if v > ver:
                for s in sqls:
                    conn.execute(s)
        if cur:
            conn.execute('UPDATE schema_version SET version = ?', (SCHEMA_VERSION,))
        else:
            conn.execute('INSERT INTO schema_version (version) VALUES (?)', (SCHEMA_VERSION,))
        conn.commit()
    try:
        config.DB_PATH.chmod(0o600)
    except OSError:
        pass


def get_db():
    conn = connect()
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


DB = Depends(get_db)


def rows(cur):
    return [dict(r) for r in cur.fetchall()]


def row(cur):
    r = cur.fetchone()
    return dict(r) if r else None


def j(v, default=None):
    """JSON sütunu → Python; bozuksa default."""
    if v is None or v == '':
        return default if default is not None else {}
    try:
        return json.loads(v)
    except (TypeError, ValueError):
        return default if default is not None else {}


def audit(conn, event, user_id=None, ip=None, detail=None):
    conn.execute('INSERT INTO audit (ts, ip, user_id, event, detail) VALUES (?,?,?,?,?)',
                 (now(), (ip or '')[:64] or None, user_id, event, (detail if isinstance(detail, str) else json.dumps(detail, ensure_ascii=False))[:1000] if detail is not None else None))


def audit_bagimsiz(event, user_id=None, ip=None, detail=None):
    """Bağlantısız denetim kaydı (orta katman / arka plan görevleri). Hata yutulur."""
    try:
        with connect() as conn:
            audit(conn, event, user_id, ip, detail)
            conn.commit()
    except sqlite3.Error:
        pass


def kullanici_esle(conn, mt_user_id, email, display_name):
    """Hesap servisi kullanıcısı → yerel users satırı (yoksa oluştur + varsayılan pilot/dron/parkur). Dönüş: users satırı."""
    t = now()
    u = row(conn.execute('SELECT * FROM users WHERE mt_user_id = ?', (int(mt_user_id),)))
    name = (display_name or email or 'Pilot').strip()[:40] or 'Pilot'
    if u:
        conn.execute('UPDATE users SET email = ?, display_name = ?, last_login = ?, updated_at = ? WHERE id = ?', (email, name, t, t, u['id']))
        return row(conn.execute('SELECT * FROM users WHERE id = ?', (u['id'],)))
    uid = conn.execute('INSERT INTO users (mt_user_id, email, display_name, created_at, updated_at, last_login) VALUES (?,?,?,?,?,?)',
                       (int(mt_user_id), email, name, t, t, t)).lastrowid
    conn.execute('INSERT INTO pilots (user_id, name, character, is_default, created_at, updated_at) VALUES (?,?,?,1,?,?)', (uid, name, 'p01', t, t))
    conn.execute('INSERT INTO drones (user_id, name, type, model_key, params, color, is_default, created_at, updated_at) VALUES (?,?,?,?,?,?,1,?,?)',
                 (uid, DEFAULT_DRONE['name'], DEFAULT_DRONE['type'], DEFAULT_DRONE['model_key'], '{}', DEFAULT_DRONE['color'], t, t))
    conn.execute('INSERT INTO tracks (user_id, name, lat, lon, radius_m, wind, time_of_day, weather, is_default, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,1,?,?)',
                 (uid, TRTEST['name'], TRTEST['lat'], TRTEST['lon'], TRTEST['radius_m'], json.dumps(TRTEST['wind']), TRTEST['time_of_day'], TRTEST['weather'], t, t))
    return row(conn.execute('SELECT * FROM users WHERE id = ?', (uid,)))


def user_public(u):
    return {'id': u['id'], 'email': u['email'], 'display_name': u['display_name'], 'avatar': u.get('avatar'), 'lang': u['lang'], 'theme': u['theme'],
            'created_at': u['created_at'], 'last_login': u.get('last_login')}


def oturum_temizle(conn):
    """Süresi dolan oturumlar (30 gün ya da 7 gün boşta)."""
    t = time.time()
    conn.execute('DELETE FROM sessions WHERE created_at < ? OR last_seen < ?', (t - config.SESSION_DAYS * 86400, t - config.SESSION_IDLE_DAYS * 86400))
