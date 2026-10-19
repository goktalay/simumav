"""HEPGO'ya özgü modüllerin SIMUMAV karşılıkları (tools/simumav_export.py: app/main.py, app/db.py, app/config.py, app/drone_hub.py, app/feed.py,
app/flightlog.py, app/flight_analysis.py SIMUMAV deposuna KOPYALANMAZ). Çekirdek (`app/flightsim*.py`, `drone_sitl.py`, `drone_params.py`,
`sim_terrain.py`) bu adları `from . import config, db, drone_hub …` ile ister; `kur()` çekirdek içe aktarılmadan ÖNCE `sys.modules`'a bu paketteki
karşılıkları kaydeder. HEPGO deposunda da aynı şekilde çalışır (SIMUMAV ayrı süreçtir; HEPGO `app.main` bu süreçte hiç yüklenmez).

Her shim, çekirdeğin o modülden GERÇEKTEN kullandığı adları sağlar (grep ile çıkarıldı):
  config → BASE_DIR, STATIC_DIR, DATA_DIR, DB_PATH, UPLOAD_DIR            db → now, connect, rows, row, audit, init (çekirdek tabloları)
  drone_hub → SIMS, VIEWERS, _pending, _mav, _feed_mavlink, _feed_msgs, _emit, _broadcast, console_line, global_line, Viewer, hello_msg,
              send_command, _dispatch, CMD_NAMES, SEQ_CMDS, _safe_send, _viewer_sender, _bridge_or_sim (+ Bridge/SitlDrone yer tutucuları)
  feed → add_post (no-op)        flightlog → _mode_names, WARN_RE        flight_analysis → start (no-op)
Eksik ad → ImportError/AttributeError; tests/test_simumav.py "çekirdek importları shim ile yüklenir" sınaması yakalar.
"""
import importlib
import sys

ADLAR = ('config', 'db', 'drone_hub', 'feed', 'flightlog', 'flight_analysis')
_kuruldu = False


def kur():
    """Çekirdek modüller yüklenmeden önce çağrılır (idempotent). Gerçek HEPGO modülü zaten yüklüyse (aynı süreçte HEPGO çalışıyorsa) DEĞİŞTİRİLMEZ —
    SIMUMAV ayrı süreçtir; bu durum yalnız yanlış kullanımda olur ve uyarı verir."""
    global _kuruldu
    if _kuruldu:
        return
    for ad in ADLAR:
        hedef = f'app.{ad}'
        mevcut = sys.modules.get(hedef)
        if mevcut is not None and not getattr(mevcut, 'SIMUMAV_SHIM', False):
            import warnings
            warnings.warn(f'{hedef} zaten yüklü (HEPGO); SIMUMAV shim uygulanmadı — SIMUMAV ayrı süreçte çalışmalı', RuntimeWarning, stacklevel=2)
            continue
        mod = importlib.import_module(f'app.simumav.shim.{ad}')
        sys.modules[hedef] = mod
    _kuruldu = True
