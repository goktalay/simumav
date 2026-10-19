"""config SHIM — çekirdeğin kullandığı yollar (`config.DATA_DIR`, `UPLOAD_DIR`, `BASE_DIR`, `STATIC_DIR`, `DB_PATH`) SIMUMAV veri köküne bağlanır:
DATA_DIR = SIMUMAV_DATA_DIR/core (drone_sitl.CALISMA_KOKU, sim_terrain.CACHE_DIR, flightsim_runs.RUNS_DIR, flightsim_replay önbelleği, sim_models),
UPLOAD_DIR = core/uploads (flightsim_bin .bin dosyaları). HEPGO ERP yolları/ayarları burada YOKTUR."""
from ..config import BASE_DIR, CORE_DIR, STATIC_DIR

__all__ = ['BASE_DIR', 'STATIC_DIR', 'DATA_DIR', 'DB_PATH', 'UPLOAD_DIR', 'BRAND_DIR', 'COMPANY_NAME', 'SIMUMAV_SHIM']

SIMUMAV_SHIM = True
DATA_DIR = CORE_DIR
DB_PATH = CORE_DIR / 'core.db'
UPLOAD_DIR = DATA_DIR / 'uploads'
BRAND_DIR = None
COMPANY_NAME = 'SIMUMAV'
