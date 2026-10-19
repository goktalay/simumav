"""SIMUMAV yapılandırması (docs/simumav.md §1, §7). YALNIZ SIMUMAV_* ortam değişkenleri okunur.

Yalıtım (§7 "tam yalıtım"): HEPGO çekirdek modülleri (`app.flightsim*`, `app.drone_sitl`, `app.sim_terrain` …) `app.config` ve `app.db`
üzerinden veri dizini/veritabanı yolu alır. Bu modül, çekirdek içe aktarılmadan ÖNCE o yolları SIMUMAV_DATA_DIR altına ZORLA yönlendirir
(`CAYMAZ_DATA_DIR`, `CAYMAZ_DB`, `CAYMAZ_ENV_FILE` → boş dosya; ortamdaki HEPGO değerleri ezilir). Böylece çekirdeğin yazdığı her şey
(SITL çalışma dizinleri, .BIN logları, parametre dökümleri, karo önbelleği, drone_sim_* tabloları) `SIMUMAV_DATA_DIR/core/` içinde kalır ve
HEPGO ERP veritabanına/dosyalarına HİÇBİR erişim olmaz. `app.main` hiçbir yerde içe aktarılmaz.
"""
import os
import secrets
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent.parent      # depo kökü (app/simumav/config.py → …/)
STATIC_DIR = BASE_DIR / 'static'
SM_STATIC = STATIC_DIR / 'simumav'


def _load_env(path):
    """ANAHTAR=değer satırları; ortamda zaten varsa ezmez. Yalnız SIMUMAV_* ve GOOGLE_MAPS_API_KEY / HEPGO_SITL* alınır (HEPGO'nun CAYMAZ_* değerleri alınmaz)."""
    try:
        text = Path(path).read_text(encoding='utf-8')
    except OSError:
        return
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith('#') or '=' not in line:
            continue
        k, v = line.split('=', 1)
        k = k.strip()
        if k.startswith('SIMUMAV_') or k in ('GOOGLE_MAPS_API_KEY', 'HEPGO_SITL', 'HEPGO_SITL_DIR'):
            os.environ.setdefault(k, v.strip())


_load_env(os.environ.get('SIMUMAV_ENV_FILE', BASE_DIR / '.env'))

DATA_DIR = Path(os.environ.get('SIMUMAV_DATA_DIR') or (BASE_DIR / 'data' / 'simumav')).resolve()
CORE_DIR = DATA_DIR / 'core'            # HEPGO çekirdeğinin (flightsim, drone_sitl, sim_terrain) veri kökü — yalnız burası
FILES_DIR = DATA_DIR / 'files'          # SIMUMAV dosyaları: previews/
DB_PATH = DATA_DIR / 'simumav.db'
for _d in (DATA_DIR, CORE_DIR, FILES_DIR, FILES_DIR / 'previews'):
    _d.mkdir(parents=True, exist_ok=True)

# ---- çekirdek yönlendirmesi (app.config içe aktarılmadan önce; ZORLA) ----
os.environ['CAYMAZ_DATA_DIR'] = str(CORE_DIR)
os.environ['CAYMAZ_DB'] = str(CORE_DIR / 'core.db')
os.environ['CAYMAZ_ENV_FILE'] = str(CORE_DIR / 'yok.env')           # HEPGO .env dosyası okunmaz
os.environ['CAYMAZ_DRONE_PKG'] = '1'
os.environ.setdefault('CAYMAZ_PRINTER_POLL', '0')
os.environ['CAYMAZ_CONSOLE'] = '0'
# Çekirdek sınırları (flightsim modül sabitleri import anında okunur)
MAX_FLIGHTS = max(1, int(os.environ.get('SIMUMAV_MAX_FLIGHTS', '6') or 6))
FLIGHT_MINUTES = max(1, min(45, int(os.environ.get('SIMUMAV_FLIGHT_MINUTES', '45') or 45)))   # §7: ≤ 45 dk
os.environ['SIM_MAX_SESSIONS'] = str(MAX_FLIGHTS)
os.environ['SIM_MAX_MINUTES'] = str(FLIGHT_MINUTES)
os.environ.setdefault('SIM_UDP_BASE', os.environ.get('SIMUMAV_UDP_BASE', '14550'))    # SITL↔MP köprüsünün iç UDP aralığı (güvenlik duvarında kapalı)
os.environ.setdefault('SIM_BIN_MAX_MB', '50')                                           # §7: .bin ≤ 50 MB
os.environ.setdefault('SIM_REC_MAX_MB', '300')                                          # §7: video ≤ 300 MB (flightsim_rec)
os.environ.setdefault('SIM_REC_KEEP_DAYS', '3650')                                      # videolar flights kaydıyla yaşar (kota silince gider)
os.environ.setdefault('SIM_PUBLIC_HOST', os.environ.get('SIMUMAV_PUBLIC_HOST', ''))

def _surum():
    """Sürüm: dışa aktarılan ağaçtaki VERSION dosyası (yayın etiketi); HEPGO deposunda dosya yoksa geliştirme sürümü."""
    try:
        from pathlib import Path
        for kok in (Path(__file__).resolve().parents[2], Path.cwd()):
            v = (kok / 'VERSION')
            if v.is_file():
                return v.read_text(encoding='utf-8').strip() or '0.0.0-dev'
    except OSError:
        pass
    return '0.0.0-dev'


VERSION = _surum()
SITL_ENABLED = os.environ.get('HEPGO_SITL', '1') != '0'
DEV_LOGIN = os.environ.get('SIMUMAV_DEV_LOGIN', '0') == '1'
SECRET = os.environ.get('SIMUMAV_SECRET', '') or secrets.token_hex(32)   # dev login imzası vb.; PROD'da .env'den
MT_URL = os.environ.get('SIMUMAV_MT_URL', 'https://mastertool.download').rstrip('/')
MT_INTERNAL = os.environ.get('SIMUMAV_MT_INTERNAL', 'http://127.0.0.1:8095').rstrip('/')
MT_APP = os.environ.get('SIMUMAV_MT_APP', 'sv')                           # hesap servisinde oyun kodu (sm = SSH Master; çakışmaz)
MT_SHARED_SECRET = os.environ.get('SIMUMAV_MT_SHARED_SECRET', '')        # sv_profiles yazımı (X-Simumav-Secret)
PUBLIC_HOST = os.environ.get('SIMUMAV_PUBLIC_HOST', '').strip()           # MP bağlantı satırında gösterilen sunucu adı/IP
MP_PORT_BASE = int(os.environ.get('SIMUMAV_MP_PORT_BASE', '15600') or 15600)
MP_PORT_COUNT = max(10, int(os.environ.get('SIMUMAV_MP_PORT_COUNT', '400') or 400))
MP_IDLE_S = float(os.environ.get('SIMUMAV_MP_IDLE_S', '60') or 60)        # bağlanılmazsa dinleyici kapanır
ORPHAN_S = float(os.environ.get('SIMUMAV_ORPHAN_S', '90') or 90)          # bu süre boyunca hiç WS bağlanmayan uçuş otomatik kapanır (audit fly_orphan)
GOOGLE_KEY = os.environ.get('GOOGLE_MAPS_API_KEY', '').strip()
# Çerez: üretimde Secure; yerel http geliştirmede SIMUMAV_SECURE_COOKIE=0 ya da CAYMAZ_FORCE_SECURE_COOKIE=0
SECURE_COOKIE = os.environ.get('SIMUMAV_SECURE_COOKIE', os.environ.get('CAYMAZ_FORCE_SECURE_COOKIE', '1')) != '0'
SESSION_DAYS = 30
SESSION_IDLE_DAYS = 7
SITE_ORIGINS = ('https://simumav.com', 'https://www.simumav.com')
_extra = [o.strip().rstrip('/') for o in os.environ.get('SIMUMAV_ALLOWED_ORIGINS', '').split(',') if o.strip()]
ALLOWED_ORIGINS = frozenset([*SITE_ORIGINS, *_extra] + (['http://127.0.0.1:8600', 'http://localhost:8600'] if DEV_LOGIN else []))
LANGS = ('tr', 'en', 'de', 'fr', 'es', 'ru', 'ar')
# Kotalar (§7)
QUOTA = {'drones': 20, 'pilots': 20, 'tracks': 20, 'missions': 50, 'flights': 100, 'disk_bytes': 1024 ** 3}
RATE = {'session': (10, 60), 'write': (60, 60), 'read': (300, 60), 'ws': (100, 1)}   # (adet, pencere sn)

# ---- HEPGO'ya özgü modüllerin SIMUMAV karşılıkları (app.config/app.db/app.drone_hub/app.feed/app.flightlog/app.flight_analysis → shim) ----
from . import shim  # noqa: E402

shim.kur()
