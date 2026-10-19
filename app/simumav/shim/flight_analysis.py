"""flight_analysis SHIM — flightsim_bin.kaydet → `flight_analysis.start(log_id)` (HEPGO Uçuş Logu Analizi kuyruğu). SIMUMAV'da analiz yok;
.bin yalnız Operasyon replay'i için saklanır (flightsim_replay). Kayıt durumu TAMAM yapılır ki `flight_logs.status` tutarlı kalsın."""
from . import db

SIMUMAV_SHIM = True


def start(log_id):
    try:
        with db.connect() as conn:
            conn.execute("UPDATE flight_logs SET status = 'TAMAM', analyzed_at = ? WHERE id = ?", (db.now(), int(log_id)))
            conn.commit()
    except Exception:   # noqa: BLE001
        pass
    return None
