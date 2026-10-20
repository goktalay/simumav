"""Uçuş Simülatörü — SITL DataFlash (.BIN) uçuş logunun oturum kapanışında Uçuş Logları'na kaydı (docs/ucus-simulatoru.md §19).

Oturum `rec.bin` ile açıldıysa SITL parametreleri `LOG_BACKEND_TYPE 1 / LOG_DISARMED 0 / LOG_FILE_DSRMROT 1` (drone_sitl.parm_metni):
yalnız armed süre yazılır, disarm'da dosya kapanır. Kapanışta (flightsim.SimSession._temizle): disarm + kısa bekleme → SITL durur →
çalışma dizinindeki en büyük `logs/*.BIN` dosyası `UPLOAD_DIR/flightlogs/<rastgele>.bin`'e taşınır (files.save_upload_stream kalıbı),
`flight_logs` satırı açılır (origin 'SIM', aircraft "Simülatör · <tip>", pilot oturum sahibi, location merkez adı, görev yok) ve analiz kuyruğuna
girer (flight_analysis.start) → analizi bitince Uçuş Logu Analizi ve sihirbazın "Kayıttan oynat" listesinde görünür.
Boyut sınırı `SIM_BIN_MAX_MB` (varsayılan 500): aşan dosya kaydedilmez (uyarı), diskten silinir.
"""
import os
import secrets
import shutil

from . import config, db

MAX_MB = max(1, int(os.environ.get('SIM_BIN_MAX_MB', '500') or 500))
MAX_BYTES = MAX_MB * 1024 * 1024
TIP_ADLARI = {'multirotor': 'Multikopter', 'hexarotor': 'Hexakopter', 'helikopter': 'Helikopter', 'sabit_kanat': 'Sabit Kanat', 'vtol': 'VTOL'}


def dosya_adi(sid, created_at):
    """Görünen ad: SIM-<oturum>-<YYYYMMDD-HHMM>.bin"""
    ts = (created_at or db.now())[:16].replace('-', '').replace(':', '').replace('T', '-')
    return f'SIM-{int(sid)}-{ts}.bin'


def kaydet(session_dict, bin_yollari, analiz=True):
    """`bin_yollari`: aday .BIN dosyaları (büyükten küçüğe; ilk kaydedilir, kalanlar silinir). Dönüş:
    {log_id, file_name, size} | {error} | None (dosya yok / boş). Bloklar (dosya taşıma + DB): iş parçacığında çağrılır."""
    yollar = [p for p in (bin_yollari or []) if p is not None and os.path.isfile(p)]
    if not yollar:
        return None
    kaynak = yollar[0]
    try:
        boyut = os.path.getsize(kaynak)
    except OSError:
        boyut = 0
    sonuc = None
    try:
        if boyut < 1024:
            return None   # yalnız başlık: uçuş olmamış (armed süre yok)
        if boyut > MAX_BYTES:
            return {'error': f'Uçuş logu {boyut // 1048576} MB; sınır {MAX_MB} MB (SIM_BIN_MAX_MB) — kaydedilmedi'}
        klasor = config.UPLOAD_DIR / 'flightlogs'
        klasor.mkdir(parents=True, exist_ok=True)
        ad = secrets.token_hex(12) + '.bin'
        hedef = klasor / ad
        shutil.move(str(kaynak), str(hedef))
        owner = session_dict.get('owner') or {}
        center = session_dict.get('center') or {}
        gorunen = dosya_adi(session_dict.get('id'), session_dict.get('created_at'))
        tip = TIP_ADLARI.get(session_dict.get('type'), session_dict.get('type') or '—')
        drone = session_dict.get('drone') or {}
        aircraft = f'Simülatör · {tip}' + (f' · {drone.get("code")}' if drone.get('code') else '')
        with db.connect() as conn:
            cur = conn.execute('''INSERT INTO flight_logs (task_id, flight_id, file, file_name, size, aircraft, pilot, location, note, uploaded_by, uploaded_at, origin)
                                  VALUES (NULL, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'SIM')''',
                               (f'flightlogs/{ad}', gorunen, boyut, aircraft, owner.get('name'), center.get('name'),
                                f'Uçuş Simülatörü oturumu #{session_dict.get("id")} (SITL DataFlash)', owner.get('id'), db.now()))
            log_id = cur.lastrowid
            db.audit(conn, owner.get('id') or 0, 'Uçuş simülatörü uçuş logunu kaydetti', 'flight_log', log_id, f'{gorunen} · {boyut // 1024} KB')
            conn.commit()
        if analiz:
            from . import flight_analysis
            flight_analysis.start(log_id)
        sonuc = {'log_id': log_id, 'file_name': gorunen, 'size': boyut}
        return sonuc
    except Exception as e:   # noqa: BLE001 — kapanış yolu; hata oturumu düşürmesin
        return {'error': f'Uçuş logu kaydedilemedi: {e}'[:300]}
    finally:
        for p in yollar:   # kalan artıklar (ve kaydedilmeyen aday) silinir
            try:
                if os.path.isfile(p):
                    os.unlink(p)
            except OSError:
                pass
