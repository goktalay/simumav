"""Uçuş Simülatörü KAYITLARI — tablo `drone_sim_runs` (docs/ucus-simulatoru.md §21).

Kullanıcı isteği: "simülasyon bitince kaydetsin ama sadece simülasyonu değil her şeyi kaydetsin: bin dosyasını, son parametreleri, içine
script yüklediysek onu da. Sonra kayıtları oynatabilelim; ama sadece master kullanıcısı script ve parametreleri download edebilsin."

Her oturum (canlı SITL `flightsim.SimSession` ya da kayıttan oynatma `flightsim_replay.ReplaySession`) KAPANIŞINDA bir satır yazılır:
  - özet rapor (`drone_sim_events` summary satırı), .bin uçuş logu (`flight_logs`, §19), ekran kaydı (flightsim_rec kimliği / Şirketten
    Haberler paylaşımı, §17) ile İLİŞKİ,
  - SON PARAMETRELER: oturumun gördüğü tüm PARAM_VALUE'lar (kapanmadan önce PARAM_REQUEST_LIST ile tamamlanır; `SimSession._param_dokumu`) +
    kalıcı izleyici tabanı + sahte kip param_set'leri → `DATA_DIR/sim_runs/<id>/params.param` (Mission Planner `AD,DEĞER`),
  - SCRIPTLER: SITL çalışma dizinindeki `scripts/` (ArduPilot Lua; SITL kökü = çalışma dizini) ve `APM/scripts/` (Mission Planner MAVFTP'nin
    gösterdiği yol) içeriği varsa `scripts.zip`,
  - dünya / kalkış / model / dron ayarları JSON.
Dosyalar yalnız satır kimliğinden türetilen dizinde (yol gezinmesi yok). Parametre ve script indirme YALNIZ MASTER (router 403).
"""
import glob
import json
import os
import shutil
import zipfile

from . import config, db

RUNS_DIR = config.DATA_DIR / 'sim_runs'
SCRIPT_DIZINLERI = ('scripts', 'APM/scripts')
SCRIPT_MAX_BYTES = 50 * 1024 * 1024
PER_PAGE = 25
SIRALAMA = {'started_at': 'r.started_at', 'owner': 'r.owner_name COLLATE NOCASE', 'type': 'r.type', 'center': 'r.center_name COLLATE NOCASE',
            'duration_s': 'r.duration_s', 'result': 'r.result', 'mode': 'r.mode', 'id': 'r.id'}
SONUCLAR = ('tamam', 'carpisma', 'hata')


def dizin(rid):
    return RUNS_DIR / str(int(rid))


# ---------------- oturumdan satır ----------------
def param_satirlari(s):
    """Oturumun bildiği son parametre değerleri: PARAM_VALUE dökümü (`param_son`) ∪ kalıcı izleyici tabanı ∪ sahte kip param_set'leri.
    Dönüş: [{name, value}] ada göre sıralı."""
    d = {}
    izl = getattr(s, 'param_izleyici', None)
    if izl is not None:
        d.update(getattr(izl, 'taban', {}) or {})
    d.update(getattr(s, 'param_son', {}) or {})
    d.update(getattr(s, '_sahte_params', {}) or {})
    out = []
    for n, v in d.items():
        try:
            out.append({'name': str(n), 'value': float(v)})
        except (TypeError, ValueError):
            continue
    out.sort(key=lambda r: r['name'])
    return out


def params_yaz(hedef, satirlar, baslik):
    from . import drone_params
    hedef.parent.mkdir(parents=True, exist_ok=True)
    hedef.write_text(drone_params.param_metni(satirlar, baslik), encoding='utf-8')
    return len(satirlar)


def script_dosyalari(calisma):
    """SITL çalışma dizinindeki script dosyaları: [(arşiv adı, yol)] — scripts/ ve APM/scripts/ altındaki her şey (alt dizinler dahil)."""
    out = []
    for alt in SCRIPT_DIZINLERI:
        kok = os.path.join(str(calisma), alt)
        if not os.path.isdir(kok):
            continue
        for p in sorted(glob.glob(os.path.join(kok, '**', '*'), recursive=True)):
            if os.path.isfile(p) and not os.path.islink(p):
                out.append((os.path.join(alt, os.path.relpath(p, kok)).replace(os.sep, '/'), p))
    return out


def scripts_zip(calisma, hedef):
    """scripts/ içeriğini zip'ler. Dönüş: dosya sayısı (0 → zip yazılmaz)."""
    dosyalar = script_dosyalari(calisma)
    if not dosyalar:
        return 0
    toplam = 0
    hedef.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(hedef, 'w', zipfile.ZIP_DEFLATED) as z:
        for ad, p in dosyalar:
            try:
                boyut = os.path.getsize(p)
            except OSError:
                continue
            if toplam + boyut > SCRIPT_MAX_BYTES:
                break
            toplam += boyut
            z.write(p, ad)
    return len(dosyalar)


def _sonuc(s, crash_count):
    if (getattr(s, 'sitl', None) or {}).get('error') and not crash_count:
        return 'hata'
    return 'carpisma' if crash_count else 'tamam'


def _oturum_alanlari(s):
    """SimSession / ReplaySession → ortak sütunlar."""
    owner = getattr(s, 'owner', None) or {}
    drone = getattr(s, 'drone', None) or {}
    model = getattr(s, 'model', None) or {}
    center = getattr(s, 'center', None) or {}
    gorev = getattr(s, 'gorev', None)
    crashes = len(getattr(gorev, 'crashes', []) or []) if gorev is not None else 0
    mode = getattr(s, 'mode', 'sitl') or 'sitl'
    bitis = db.now()
    try:
        from datetime import datetime
        sure = int((datetime.fromisoformat(bitis) - datetime.fromisoformat(s.created_at)).total_seconds())
    except Exception:   # noqa: BLE001
        sure = None
    bin_sonuc = getattr(s, 'bin_sonuc', None) or {}
    video = getattr(s, 'video', None) or {}
    # §23 güç ve yakıt özeti (canlı oturum: GucDurumu; kayıttan oynatma: yalnız ayarlar, sonuç yok)
    guc = getattr(s, 'guc', None)
    pw = guc.ozet() if guc is not None else ({'settings': dict(s.power)} if getattr(s, 'power', None) else None)
    f, e = (pw or {}).get('fuel') or {}, (pw or {}).get('elec') or {}
    return {
        'power': json.dumps(pw, ensure_ascii=False, default=str) if pw else None,
        'fuel_used_l': f.get('used_l'), 'fuel_km_per_l': f.get('km_per_l'), 'elec_wh': e.get('wh_used'), 'elec_w_avg': e.get('w_avg'),
        'speedup_max': ((pw or {}).get('speedup') or {}).get('max'),
        'session_id': int(s.id), 'session_kimlik': getattr(s, 'kimlik', None) if mode == 'sitl' else None,
        'owner_id': owner.get('id'), 'owner_name': owner.get('name'),
        'drone_id': drone.get('id'), 'drone_code': drone.get('code') or drone.get('name'),
        'type': getattr(s, 'type', None), 'model_id': str(model.get('id')) if model.get('id') is not None else None, 'model_name': model.get('name'),
        'center_id': center.get('id'), 'center_name': center.get('name'), 'lat': center.get('lat'), 'lon': center.get('lon'),
        'world': json.dumps(dict(getattr(s, 'world', None) or {}), ensure_ascii=False, default=str),
        'launch': json.dumps(dict(getattr(s, 'launch', None) or {}), ensure_ascii=False, default=str) if getattr(s, 'launch', None) else None,
        'camera': getattr(s, 'camera', None),   # §22.3 kamera türü (son seçim)
        # §24 hedefler: yapılandırma + sonuç (kayıttan oynatma aynı yörüngeleri yeniden üretir) ve toplam önleme sayısı
        # §26: yer kontrol sahası + "Yer kontrolünü koru" (yapılandırma + sonuç; plan tohumdan yeniden üretilir) AYNI sütunda (DB göçü gerekmez)
        'targets': json.dumps({'config': s.hedefler, 'result': s.hedef_iz.ozet() if getattr(s, 'hedef_iz', None) is not None else None,
                               **({'site': s.gcs} if getattr(s, 'gcs', None) else {}),
                               **({'defend': {'config': s.savunma.cfg, 'result': s.savunma.ozet()}} if getattr(s, 'savunma', None) is not None else {})},
                              ensure_ascii=False, default=str)
        if getattr(s, 'hedefler', None) or getattr(s, 'gcs', None) or getattr(s, 'savunma', None) is not None else None,
        'intercept_count': s.hedef_iz.ozet()['total'] if getattr(s, 'hedef_iz', None) is not None else None,
        'layout': getattr(s, 'layout_etkin', None) or getattr(s, 'layout', None),   # §13.1 kontrol düzeni (SITL'de fiilen uçan; kayıttan oynatmada None)
        'started_at': s.created_at, 'ended_at': bitis, 'duration_s': sure, 'mode': mode, 'result': _sonuc(s, crashes),
        'end_reason': getattr(s, 'end_reason', None) or 'kapatildi', 'crash_count': crashes,
        'summary_event_id': getattr(gorev, 'summary_id', None) if gorev is not None else None,
        'bin_log_id': bin_sonuc.get('log_id'), 'source_log_id': (getattr(s, 'replay', None) or {}).get('log_id') if mode == 'replay' else None,
        'video_rec_id': video.get('rec_id'), 'video_post_id': video.get('post_id'), 'video_path': video.get('path'),
    }


def kaydet(s):
    """Oturum kapanışında satır + dosyalar (iş parçacığında çağrılır; bloklar). Dönüş: {id, params_count, scripts_count} | None."""
    from . import drone_sitl, flightsim_rec
    a = _oturum_alanlari(s)
    if not a['video_rec_id']:   # Bitir'den önce bitirilmemiş (yarım ya da saklanacak) ekran kaydı: sim_rec meta'sından
        m = flightsim_rec.oturum_kaydi(a['session_id'], a['started_at'])
        if m:
            a['video_rec_id'] = m.get('id')
            a['video_post_id'] = m.get('post_id')
    satirlar = param_satirlari(s) if a['mode'] == 'sitl' else []
    kols = list(a.keys())
    with db.connect() as conn:
        cur = conn.execute(f"INSERT INTO drone_sim_runs ({', '.join(kols)}, created_at) VALUES ({', '.join('?' * len(kols))}, ?)",
                           [a[k] for k in kols] + [db.now()])
        rid = cur.lastrowid
        conn.commit()
    pc, sc, pp, sp = 0, 0, None, None
    d = dizin(rid)
    try:
        if satirlar:
            from . import flightsim
            baslik = (f"HEPGO Uçuş Simülatörü oturum #{a['session_id']} · {flightsim.TIP_ADLARI.get(a['type'], a['type'])} · {a['center_name'] or '-'} · "
                      f"{a['started_at'][:16].replace('T', ' ')} · {len(satirlar)} parametre")
            pc = params_yaz(d / 'params.param', satirlar, baslik)
            pp = f'sim_runs/{rid}/params.param'
    except Exception:   # noqa: BLE001 — dosya hatası kaydı düşürmesin
        pc, pp = 0, None
    try:
        if a['mode'] == 'sitl' and a['session_kimlik']:
            sc = scripts_zip(drone_sitl.calisma_dizini(a['session_kimlik']), d / 'scripts.zip')
            sp = f'sim_runs/{rid}/scripts.zip' if sc else None
    except Exception:   # noqa: BLE001
        sc, sp = 0, None
    with db.connect() as conn:
        conn.execute('UPDATE drone_sim_runs SET params_path = ?, params_count = ?, scripts_path = ?, scripts_count = ? WHERE id = ?', (pp, pc, sp, sc, rid))
        conn.commit()
    out = {'id': rid, 'params_count': pc, 'scripts_count': sc}
    # §23: ölçülen km/L ve ortalama W dron kaydına (drone_sitl_options *_last) → sonraki sihirbazda önerilir
    guc = getattr(s, 'guc', None)
    if guc is not None and a.get('drone_id'):
        from . import drone_params, flightsim_power
        yaz = flightsim_power.drona_yazilacaklar(guc.ozet())
        if yaz:
            try:
                drone_params.secenek_yaz(a['drone_id'], yaz, a.get('owner_id'))
                out['drone_power'] = yaz
            except Exception:   # noqa: BLE001 — öneri yazımı kaydı düşürmesin
                pass
    return out


def video_bagla(sid, rec_id, post_id=None, path=None, conn=None):
    """Ekran kaydı bitirildi/paylaşıldı: açık oturum varsa oturum nesnesine (kapanışta satıra yazılır), yoksa en son `drone_sim_runs` satırına
    (aynı rec_id ya da aynı oturum kimliği) işlenir. Dönüş: güncellenen satır id | None."""
    from . import flightsim
    s = flightsim.MANAGER.sessions.get(int(sid)) if sid is not None else None
    if s is not None and s.state != 'KAPANDI':
        s.video = {'rec_id': rec_id, 'post_id': post_id, 'path': path}
        return None
    own = conn is None
    c = conn or db.connect()
    try:
        r = db.row(c.execute('SELECT id FROM drone_sim_runs WHERE video_rec_id = ? ORDER BY id DESC LIMIT 1', (rec_id,)))
        if not r and sid is not None:
            r = db.row(c.execute('SELECT id FROM drone_sim_runs WHERE session_id = ? AND video_rec_id IS NULL ORDER BY id DESC LIMIT 1', (int(sid),)))
        if not r:
            return None
        c.execute('UPDATE drone_sim_runs SET video_rec_id = ?, video_post_id = COALESCE(?, video_post_id), video_path = COALESCE(?, video_path) WHERE id = ?',
                  (rec_id, post_id, path, r['id']))
        if own:
            c.commit()
        return r['id']
    finally:
        if own:
            c.close()


# ---------------- listeleme ----------------
_SELECT = '''SELECT r.*, l.status AS bin_status, l.file_name AS bin_file_name, sl.file_name AS source_file_name, sl.status AS source_status
             FROM drone_sim_runs r LEFT JOIN flight_logs l ON l.id = r.bin_log_id LEFT JOIN flight_logs sl ON sl.id = r.source_log_id'''


def _satir(r, user):
    r = dict(r)
    for k in ('world', 'launch', 'power'):
        try:
            r[k] = json.loads(r[k]) if r.get(k) else None
        except ValueError:
            r[k] = None
    r['has_params'] = bool(r.get('params_path'))
    r['has_scripts'] = bool(r.get('scripts_path'))
    r['has_video'] = bool(r.get('video_rec_id') or r.get('video_path'))
    r['has_summary'] = bool(r.get('summary_event_id'))
    # Oynat: kapanışta kaydedilen .bin (analizi TAMAM) ya da kayıttan oynatma kaynağı
    play = r['bin_log_id'] if r.get('bin_log_id') and r.get('bin_status') == 'TAMAM' else (r['source_log_id'] if r.get('source_log_id') and r.get('source_status') == 'TAMAM' else None)
    r['play_log_id'] = play
    r['can_delete'] = bool(user and (user.get('master') or user.get('id') == r.get('owner_id') or 'drone.sim' in (user.get('write_modules') or [])))
    return r


def listele(conn, user, *, dfrom=None, dto=None, center_id=None, type=None, owner_id=None, result=None, mode=None, q=None, sort='-started_at', page=1):   # noqa: A002
    where, args = [], []
    if dfrom:
        where.append('substr(r.started_at, 1, 10) >= ?'); args.append(str(dfrom)[:10])
    if dto:
        where.append('substr(r.started_at, 1, 10) <= ?'); args.append(str(dto)[:10])
    if center_id is not None:
        where.append('r.center_id = ?'); args.append(int(center_id))
    if type:
        where.append('r.type = ?'); args.append(str(type))
    if owner_id is not None:
        where.append('r.owner_id = ?'); args.append(int(owner_id))
    if result in SONUCLAR:
        where.append('r.result = ?'); args.append(result)
    if mode in ('sitl', 'replay'):
        where.append('r.mode = ?'); args.append(mode)
    if q and str(q).strip():
        like = f"%{str(q).strip()}%"
        where.append('(r.center_name LIKE ? OR r.owner_name LIKE ? OR r.model_name LIKE ? OR r.drone_code LIKE ? OR l.file_name LIKE ? OR sl.file_name LIKE ? OR CAST(r.session_id AS TEXT) = ?)')
        args += [like, like, like, like, like, like, str(q).strip()]
    sql_where = (' WHERE ' + ' AND '.join(where)) if where else ''
    desc = str(sort or '').startswith('-')
    key = SIRALAMA.get(str(sort or '').lstrip('-+'), 'r.started_at')
    order = f' ORDER BY {key} {"DESC" if desc else "ASC"}, r.id {"DESC" if desc else "ASC"}'
    total = conn.execute(f'SELECT COUNT(*) FROM drone_sim_runs r LEFT JOIN flight_logs l ON l.id = r.bin_log_id LEFT JOIN flight_logs sl ON sl.id = r.source_log_id{sql_where}', args).fetchone()[0]
    pages = max(1, (total + PER_PAGE - 1) // PER_PAGE)
    page = max(1, min(int(page or 1), pages))
    rows = db.rows(conn.execute(_SELECT + sql_where + order + ' LIMIT ? OFFSET ?', args + [PER_PAGE, (page - 1) * PER_PAGE]))
    facets = {
        'centers': db.rows(conn.execute('SELECT center_id AS id, MAX(center_name) AS name, COUNT(*) AS n FROM drone_sim_runs WHERE center_id IS NOT NULL GROUP BY center_id ORDER BY name COLLATE NOCASE')),
        'owners': db.rows(conn.execute('SELECT owner_id AS id, MAX(owner_name) AS name, COUNT(*) AS n FROM drone_sim_runs WHERE owner_id IS NOT NULL GROUP BY owner_id ORDER BY name COLLATE NOCASE')),
        'types': [r[0] for r in conn.execute('SELECT DISTINCT type FROM drone_sim_runs WHERE type IS NOT NULL ORDER BY type')],
    }
    return {'items': [_satir(r, user) for r in rows], 'total': total, 'page': page, 'pages': pages, 'per_page': PER_PAGE, 'facets': facets}


def getir(conn, rid, user=None):
    r = db.row(conn.execute(_SELECT + ' WHERE r.id = ?', (int(rid),)))
    return _satir(r, user) if r else None


def dosya(r, tur):
    """İndirme: (yol, görünen ad, mime) — `tur` params | scripts. Yol yalnız satır kimliğinden (DB'deki göreli yol doğrulanır)."""
    rel = r.get('params_path') if tur == 'params' else r.get('scripts_path')
    if not rel:
        return None
    beklenen = f"sim_runs/{int(r['id'])}/{'params.param' if tur == 'params' else 'scripts.zip'}"
    if rel != beklenen:
        return None
    p = config.DATA_DIR / rel
    if not p.is_file():
        return None
    ts = (r.get('started_at') or '')[:16].replace('-', '').replace(':', '').replace('T', '-')
    ad = f"SIM-{r['session_id']}-{ts}-{'params.param' if tur == 'params' else 'scripts.zip'}"
    return p, ad, ('text/plain; charset=utf-8' if tur == 'params' else 'application/zip')


def sil(conn, rid):
    """Satır + sim_runs/<id>/ dizini silinir. Özet, .bin ve video kendi yerlerinde kalır (bağımsız varlıklar)."""
    n = conn.execute('DELETE FROM drone_sim_runs WHERE id = ?', (int(rid),)).rowcount
    shutil.rmtree(dizin(rid), ignore_errors=True)
    return n


# ---------------- özet istatistik (sayfa üstü 4 bilgi kutusu) ----------------
def istatistik(conn, days=30, acik=0):
    """Uçuş Simülatörü sayfasının üst kutuları: son `days` gündeki simülasyon sayısı / toplam uçuş süresi / çarpışma oranı + son çarpışma,
    açık oturum sayısı + son simülasyon. `days` 1..3650 arasına kırpılır; `acik` çağıran verir (flightsim.MANAGER)."""
    from datetime import datetime, timedelta
    days = max(1, min(int(days if days is not None else 30), 3650))
    since = (datetime.now() - timedelta(days=days)).strftime('%Y-%m-%d')
    r = db.row(conn.execute('''SELECT COUNT(*) AS n, COALESCE(SUM(duration_s), 0) AS flight_s,
                                      SUM(CASE WHEN result = 'carpisma' THEN 1 ELSE 0 END) AS crash, COALESCE(SUM(crash_count), 0) AS crash_events,
                                      MAX(CASE WHEN result = 'carpisma' THEN started_at END) AS last_crash_at
                               FROM drone_sim_runs WHERE substr(started_at, 1, 10) >= ?''', (since,))) or {}
    n = int(r.get('n') or 0)
    toplam = conn.execute('SELECT COUNT(*) FROM drone_sim_runs').fetchone()[0]
    son = db.row(conn.execute('SELECT started_at, ended_at, result, type, mode FROM drone_sim_runs ORDER BY started_at DESC, id DESC LIMIT 1'))
    crash = int(r.get('crash') or 0)
    return {
        'days': days, 'total': n, 'total_all': int(toplam or 0),
        'flight_s': int(r.get('flight_s') or 0), 'avg_s': int(round((r.get('flight_s') or 0) / n)) if n else 0,
        'crash': crash, 'crash_events': int(r.get('crash_events') or 0), 'crash_rate': round(100.0 * crash / n, 1) if n else 0.0,
        'last_crash_at': r.get('last_crash_at'),
        'open_sessions': int(acik or 0),
        'last_run': dict(son) if son else None,
    }
