"""db SHIM — çekirdeğin kullandığı `db.now/connect/rows/row/audit` + yalnız çekirdek tablolarının şeması (HEPGO app/db.py'den sütunlar birebir;
yabancı anahtarlar HEPGO ERP tablolarına işaret ettiği için kaldırıldı). Veritabanı: SIMUMAV_DATA_DIR/core/core.db — HEPGO caymaz.db DEĞİL.
Tablolar: drone_sim_events (flightsim_mission), drone_sim_runs (flightsim_runs), drone_sitl_params (drone_params), flight_logs (flightsim_bin),
drone_sim_models + users + design_drawing_versions (flightsim_models._SQL JOIN'leri; boş), audit_logs (db.audit)."""
import sqlite3
from datetime import datetime

from . import config

SIMUMAV_SHIM = True
SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY, username TEXT, full_name TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS audit_logs (
    id INTEGER PRIMARY KEY, user_id INTEGER, action TEXT NOT NULL, entity TEXT, entity_id TEXT, detail TEXT, at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS design_drawing_versions (
    id INTEGER PRIMARY KEY, drawing_id INTEGER, version INTEGER, file_path TEXT, file_name TEXT, size INTEGER
);
CREATE TABLE IF NOT EXISTS drone_sim_models (
    id INTEGER PRIMARY KEY, name TEXT NOT NULL, source TEXT NOT NULL DEFAULT 'upload', source_ref INTEGER, type TEXT NOT NULL,
    file_path TEXT, glb_path TEXT, thumb_path TEXT, orient_json TEXT, has_prop INTEGER NOT NULL DEFAULT 0, created_by INTEGER, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_drone_sim_models_type ON drone_sim_models(type);
CREATE TABLE IF NOT EXISTS drone_sim_events (
    id INTEGER PRIMARY KEY, session_id INTEGER NOT NULL, owner_id INTEGER, type TEXT NOT NULL,
    lat REAL, lon REAL, alt_msl REAL, alt_rel REAL, t REAL, speed REAL, mode TEXT, detail TEXT, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_drone_sim_events_type ON drone_sim_events(type, id);
CREATE TABLE IF NOT EXISTS drone_sim_runs (
    id INTEGER PRIMARY KEY, session_id INTEGER NOT NULL, session_kimlik INTEGER, owner_id INTEGER, owner_name TEXT,
    drone_id INTEGER, drone_code TEXT, type TEXT, model_id TEXT, model_name TEXT, center_id INTEGER, center_name TEXT, lat REAL, lon REAL,
    world TEXT, launch TEXT, started_at TEXT NOT NULL, ended_at TEXT, duration_s INTEGER, mode TEXT NOT NULL DEFAULT 'sitl',
    result TEXT NOT NULL DEFAULT 'tamam', end_reason TEXT, crash_count INTEGER NOT NULL DEFAULT 0, summary_event_id INTEGER,
    bin_log_id INTEGER, source_log_id INTEGER, video_rec_id TEXT, video_post_id INTEGER, video_path TEXT,
    params_path TEXT, params_count INTEGER NOT NULL DEFAULT 0, scripts_path TEXT, scripts_count INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL,
    power TEXT, fuel_used_l REAL, fuel_km_per_l REAL, elec_wh REAL, elec_w_avg REAL, speedup_max REAL, layout TEXT
);
CREATE INDEX IF NOT EXISTS ix_drone_sim_runs_started ON drone_sim_runs(started_at);
CREATE INDEX IF NOT EXISTS ix_drone_sim_runs_owner ON drone_sim_runs(owner_id);
CREATE TABLE IF NOT EXISTS drone_sitl_params (
    drone_id INTEGER NOT NULL, name TEXT NOT NULL, value REAL NOT NULL, ptype INTEGER, updated_at TEXT NOT NULL, updated_by INTEGER,
    source TEXT NOT NULL DEFAULT 'hepgo', PRIMARY KEY (drone_id, name)
);
-- HEPGO §23 dron simülasyon seçenekleri (çekirdek flightsim_runs.kaydet ölçümleri yazar). SIMUMAV bunları OKUMAZ (güç ayarı simumav.db
-- drones.power; docs/simumav.md §10) — tablo yalnız çekirdek yazımı hata vermesin diye var; uçuş açılışında dronun satırları silinir.
CREATE TABLE IF NOT EXISTS drone_sitl_options (
    drone_id INTEGER NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, updated_at TEXT NOT NULL, updated_by INTEGER, PRIMARY KEY (drone_id, key)
);
CREATE TABLE IF NOT EXISTS flight_logs (
    id INTEGER PRIMARY KEY, task_id INTEGER, file TEXT NOT NULL, file_name TEXT NOT NULL, size INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'ISLENIYOR', error TEXT, analysis TEXT, aircraft TEXT, pilot TEXT, location TEXT, note TEXT,
    uploaded_by INTEGER, uploaded_at TEXT NOT NULL, analyzed_at TEXT, flight_id INTEGER, source TEXT NOT NULL DEFAULT 'UPLOAD'
);
"""


def now():
    return datetime.now().isoformat(timespec='seconds')


def connect():
    config.DATA_DIR.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(config.DB_PATH, timeout=15, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute('PRAGMA journal_mode = WAL')
    return conn


# Sonradan eklenen drone_sim_runs sütunları (HEPGO app/db.py ile aynı): §23 güç ve yakıt + §13.1 kontrol düzeni. Eksikken çekirdeğin
# flightsim_runs.kaydet INSERT'i düşüyordu ("Simülasyon kaydı yazılamadı" → uçuşun .param dökümü / run satırı yok) — eski core.db'ye ALTER.
RUN_EK_SUTUNLAR = (('power', 'TEXT'), ('fuel_used_l', 'REAL'), ('fuel_km_per_l', 'REAL'), ('elec_wh', 'REAL'), ('elec_w_avg', 'REAL'), ('speedup_max', 'REAL'),
                   ('layout', 'TEXT'))


def init():
    with connect() as conn:
        conn.executescript(SCHEMA)
        kol = {r[1] for r in conn.execute('PRAGMA table_info(drone_sim_runs)')}
        for ad, ddl in RUN_EK_SUTUNLAR:
            if ad not in kol:
                conn.execute(f'ALTER TABLE drone_sim_runs ADD COLUMN {ad} {ddl}')
        conn.commit()


def rows(cur):
    return [dict(r) for r in cur.fetchall()]


def row(cur):
    r = cur.fetchone()
    return dict(r) if r else None


def audit(conn, user_id, action, entity=None, entity_id=None, detail=None):
    conn.execute('INSERT INTO audit_logs (user_id, action, entity, entity_id, detail, at) VALUES (?,?,?,?,?,?)',
                 (user_id, action, entity, None if entity_id is None else str(entity_id), detail, now()))
