"""Uçuş Simülatörü görsel model kütüphanesi (docs/ucus-simulatoru.md §12; tablo `drone_sim_models`, dosyalar DATA_DIR/sim_models/<id>/).

Kaynaklar: (a) dahili — kodda sabit prosedürel/GLB gövdeler (`BUILTIN`, kimlik `builtin:<ad>`; her tip için her zaman var);
(b) tasarım — Endüstriyel Tasarım modülündeki STEP/GLB/OBJ sürüm dosyaları (`design_drawing_versions`), kütüphaneye eklenince tabloya düşer
(`source='design'`, `source_ref` = sürüm kimliği; dosya kopyalanmaz, UPLOAD_DIR'den okunur); (c) yükleme — simülatöre doğrudan yüklenen
dosya (`source='upload'`, DATA_DIR/sim_models/<id>/orijinal.<ext>).

STEP → GLB dönüşümü SUNUCUDA YAPILMAZ (PROD'da node/occt yok): tarayıcı özgün dosyayı `GET /models/{id}/file` ile indirir, occt wasm ile
mesh'ler, GLTFExporter ile GLB üretir ve `PUT /models/{id}/glb` ile yükler (sonraki kullanıcılar için önbellek; `ready=true`). Küçük resim de
tarayıcıda çekilir (`PUT /models/{id}/thumb`, 320×240 PNG); dahili modeller için sabit `static/models/thumbs/<ad>-<tip>.png` varsa o,
yoksa ilk kullanıcının ürettiği DATA_DIR kopyası.

Yönelim (`orient`): modelin burun ekseni `forward`, yukarı ekseni `up` (±x/±y/±z; birbirine dik), `scale` (model birimi → metre),
`offset` [x,y,z] m (gövde çerçevesinde), `prop` {mode: none|tail|nose|manual, pos:[x,y,z], r} (modelde pervane düğümü yoksa prosedürel pervane).
Kimlik doğrulaması: tam sayı (tablo) ya da `builtin:[a-z0-9_]+` — yol gezinmesi yok (dosya yolları yalnız kimlikten türetilir).
"""
import json
import re
import shutil
from pathlib import Path

from . import config, db
from .flightsim import PLANE_TIPLERI, SimHata, TIP_ADLARI

KOK = 'sim_models'                                   # DATA_DIR altı
UZANTILAR = ('.glb', '.gltf', '.step', '.stp', '.obj')
MAX_BYTES = 50 * 1024 * 1024                         # yükleme ve GLB için
THUMB_MAX = 2 * 1024 * 1024
EKSENLER = ('+x', '-x', '+y', '-y', '+z', '-z')
PROP_KIPLERI = ('none', 'tail', 'nose', 'manual')
_ID_RE = re.compile(r'^builtin:([a-z0-9_]+)$')

# Dahili modeller: ön yüz (flightsim3d.js) bu anahtarları tanır; `glb` yalnız bilgi (tarayıcı static yoldan yükler). `layout` (§13.1): modelin
# kontrol düzeni — classic (aileron + elevatör) | elevon (delta / uçan kanat: iki elevon hem yunuslama hem yatış) | vtail (ruddervator); sihirbaz
# model seçilince düzeni buna göre önerir, oturum `layout` verilmezse bu kullanılır. `orient` verilen dahili GLB'ler kütüphane modeli gibi yüklenir
# (flightsim3d buildLibrary: SIMUMAV GLB çerçevesi burun +X, yukarı +Y).
BUILTIN = {
    'caymaz': {'name': 'Caymaz V3', 'types': ('sabit_kanat', 'vtol'), 'format': 'glb', 'glb': 'models/caymaz-sim.glb', 'has_prop': True, 'layout': 'elevon',
               'desc': 'Ürettiğimiz uçağın STEP modelinden (kanat açıklığı 3,03 m, arkadan itişli). Delta kanat: iki elevon hem yunuslama hem yatış'},
    'delta': {'name': 'Delta kanat', 'types': ('sabit_kanat', 'vtol'), 'format': 'procedural', 'has_prop': True, 'layout': 'elevon', 'desc': 'Prosedürel delta uçan kanat (2,2 m, arkadan itişli); elevonlar'},
    'talon': {'name': 'Talon V-kuyruk', 'types': ('sabit_kanat',), 'format': 'glb', 'glb': 'models/talon-vtail.glb', 'has_prop': True, 'layout': 'vtail',
              'orient': {'forward': '+x', 'up': '+y', 'scale': 1.0, 'offset': [0.0, 0.0, 0.0], 'prop': {'mode': 'none', 'pos': [0.0, 0.0, 0.0], 'r': 0.3}},
              'desc': 'X-UAV Talon tarzı prosedürel uçak (1,72 m, tek itici pervane, V-kuyruk ruddervator); HEPGO üretimi'},
    'quad': {'name': 'Quad', 'types': ('multirotor',), 'format': 'procedural', 'has_prop': True, 'desc': 'Prosedürel dört rotor (60 cm)'},
    'hexa': {'name': 'Hexa', 'types': ('hexarotor',), 'format': 'procedural', 'has_prop': True, 'desc': 'Prosedürel altı rotor (90 cm)'},
    'heli': {'name': 'Heli', 'types': ('helikopter',), 'format': 'procedural', 'has_prop': True, 'desc': 'Prosedürel helikopter (1,5 m)'},
}
VARSAYILAN = {'multirotor': 'builtin:quad', 'hexarotor': 'builtin:hexa', 'helikopter': 'builtin:heli', 'sabit_kanat': 'builtin:caymaz', 'vtol': 'builtin:caymaz'}
ORIENT_VARSAYILAN = {'forward': '+y', 'up': '+z', 'scale': 1.0, 'offset': [0.0, 0.0, 0.0], 'prop': {'mode': 'none', 'pos': [0.0, 0.0, 0.0], 'r': 0.3}}


def kimlik_coz(mid):
    """'builtin:<ad>' → ('builtin', ad) · '12'/12 → ('db', 12). Geçersiz → None (yol gezinmesi yok)."""
    s = str(mid or '').strip()
    m = _ID_RE.match(s)
    if m:
        return ('builtin', m.group(1)) if m.group(1) in BUILTIN else None
    if s.isdigit() and 0 < int(s) < 10 ** 9:
        return ('db', int(s))
    return None


def dizin(mid):
    return config.DATA_DIR / KOK / str(int(mid))


def _url(mid, parca, tip=None):
    return f'/api/drone/sim/models/{mid}/{parca}' + (f'?type={tip}' if tip else '')


def builtin_ad(key, tip):
    b = BUILTIN[key]
    return f"VTOL-{b['name']}" if tip == 'vtol' and key in ('caymaz', 'delta') else b['name']


def builtin_thumb_yolu(key, tip):
    """Sabit dizin (static/models/thumbs) varsa o, yoksa DATA_DIR/sim_models/builtin/<ad>-<tip>.png (ilk kullanıcı üretir)."""
    sabit = config.STATIC_DIR / 'models' / 'thumbs' / f'{key}-{tip}.png'
    if sabit.is_file():
        return sabit
    return config.DATA_DIR / KOK / 'builtin' / f'{key}-{tip}.png'


def builtin_api(key, tip):
    b = BUILTIN[key]
    tip = tip if tip in b['types'] else b['types'][0]
    glb = config.STATIC_DIR / b['glb'] if b.get('format') == 'glb' else None
    mid = f'builtin:{key}'
    return {'id': mid, 'name': builtin_ad(key, tip), 'source': 'builtin', 'type': tip, 'types': list(b['types']), 'desc': b.get('desc'),
            'thumb_url': _url(mid, 'thumb', tip) if builtin_thumb_yolu(key, tip).is_file() else None,
            'glb_url': f"/static/{b['glb']}" if glb else None, 'file_url': None, 'format': b['format'],
            'size': glb.stat().st_size if glb and glb.is_file() else None, 'ready': True, 'orient': json.loads(json.dumps(b['orient'])) if b.get('orient') else None,
            'has_prop': bool(b.get('has_prop')), 'layout': b.get('layout'), 'created_by': None, 'created_at': None}


def orient_dogrula(o):
    """Yönelim nesnesi; eksikler varsayılanla dolar, hatalı değer SimHata('invalid')."""
    if o is None:
        return json.loads(json.dumps(ORIENT_VARSAYILAN))
    if not isinstance(o, dict):
        raise SimHata('invalid', 'orient bir nesne olmalı')
    out = json.loads(json.dumps(ORIENT_VARSAYILAN))
    for k in ('forward', 'up'):
        if k in o and o[k] is not None:
            if o[k] not in EKSENLER:
                raise SimHata('invalid', f'orient.{k} +x | -x | +y | -y | +z | -z olmalı')
            out[k] = o[k]
    if out['forward'][1] == out['up'][1]:
        raise SimHata('invalid', 'orient.forward ve orient.up farklı eksenlerde olmalı')
    if 'scale' in o and o['scale'] is not None:
        v = o['scale']
        if isinstance(v, bool) or not isinstance(v, (int, float)) or not (1e-4 <= v <= 1e4):
            raise SimHata('invalid', 'orient.scale 0.0001…10000 arasında sayı olmalı')
        out['scale'] = float(v)
    if 'offset' in o and o['offset'] is not None:
        v = o['offset']
        if not isinstance(v, (list, tuple)) or len(v) != 3 or any(isinstance(x, bool) or not isinstance(x, (int, float)) or abs(x) > 100 for x in v):
            raise SimHata('invalid', 'orient.offset [x, y, z] metre (|v| ≤ 100) olmalı')
        out['offset'] = [float(x) for x in v]
    if 'prop' in o and o['prop'] is not None:
        p = o['prop']
        if not isinstance(p, dict):
            raise SimHata('invalid', 'orient.prop bir nesne olmalı')
        if p.get('mode') is not None:
            if p['mode'] not in PROP_KIPLERI:
                raise SimHata('invalid', 'orient.prop.mode none | tail | nose | manual olmalı')
            out['prop']['mode'] = p['mode']
        if p.get('pos') is not None:
            v = p['pos']
            if not isinstance(v, (list, tuple)) or len(v) != 3 or any(isinstance(x, bool) or not isinstance(x, (int, float)) or abs(x) > 100 for x in v):
                raise SimHata('invalid', 'orient.prop.pos [x, y, z] metre olmalı')
            out['prop']['pos'] = [float(x) for x in v]
        if p.get('r') is not None:
            v = p['r']
            if isinstance(v, bool) or not isinstance(v, (int, float)) or not (0.01 <= v <= 10):
                raise SimHata('invalid', 'orient.prop.r 0.01…10 m olmalı')
            out['prop']['r'] = float(v)
    return out


def _format(path):
    ext = Path(path or '').suffix.lower().lstrip('.')
    return 'step' if ext in ('step', 'stp') else (ext or None)


def row_api(r):
    mid = str(r['id'])
    orient = None
    if r.get('orient_json'):
        try:
            orient = orient_dogrula(json.loads(r['orient_json']))
        except (ValueError, SimHata):
            orient = json.loads(json.dumps(ORIENT_VARSAYILAN))
    else:
        orient = json.loads(json.dumps(ORIENT_VARSAYILAN))
    return {'id': mid, 'name': r['name'], 'source': r['source'], 'source_ref': r.get('source_ref'), 'type': r['type'], 'types': [r['type']],
            'thumb_url': _url(mid, 'thumb') if r.get('thumb_path') else None, 'glb_url': _url(mid, 'glb') if r.get('glb_path') else None,
            'file_url': _url(mid, 'file') if r.get('file_path') else None, 'format': _format(r.get('file_path')), 'file_name': r.get('file_name'),
            'size': r.get('size'), 'ready': bool(r.get('glb_path')), 'orient': orient, 'has_prop': bool(r.get('has_prop')), 'layout': None,   # yüklenen/tasarım: düzen ön yüzde düğüm adlarından (ruddervator/elevon) tahmin edilir
            'created_by': r.get('created_by'), 'created_by_name': r.get('created_by_name'), 'created_at': r['created_at']}


_SQL = '''SELECT m.*, u.full_name AS created_by_name, v.file_name AS design_file_name FROM drone_sim_models m LEFT JOIN users u ON u.id = m.created_by
          LEFT JOIN design_drawing_versions v ON m.source = 'design' AND v.id = m.source_ref'''


def _boyut(r):
    p = dosya_yolu(r)
    return p.stat().st_size if p and p.is_file() else None


def dosya_yolu(r):
    """Özgün dosyanın mutlak yolu: design → UPLOAD_DIR, upload → DATA_DIR (göreli yollar tabloda)."""
    if not r.get('file_path'):
        return None
    kok = config.UPLOAD_DIR if r['source'] == 'design' else config.DATA_DIR
    return kok / r['file_path']


def _row(conn, iid):
    r = db.row(conn.execute(_SQL + ' WHERE m.id = ?', (iid,)))
    if r:
        r['size'] = _boyut(r)
        r['file_name'] = _dosya_adi(r)
    return r


def _dosya_adi(r):
    """Görünen dosya adı: tasarım kaynağında sürümün özgün adı; yüklemede sabit 'orijinal.<ext>' yerine kayıt adı + uzantı."""
    if r['source'] == 'design':
        return r.get('design_file_name')
    return f"{r['name']}{Path(r['file_path']).suffix}" if r.get('file_path') else None


def listele(conn, tip=None):
    """Dahili + tablo kayıtları (tip verilirse yalnız o tip; dahili modeller tipe göre adlandırılır)."""
    out = []
    tipler = [tip] if tip else list(TIP_ADLARI)
    for t in tipler:
        for key, b in BUILTIN.items():
            if t in b['types']:
                out.append(builtin_api(key, t))
    if tip:
        rows = db.rows(conn.execute(_SQL + ' WHERE m.type = ? ORDER BY m.created_at DESC, m.id DESC', (tip,)))
    else:
        rows = db.rows(conn.execute(_SQL + ' ORDER BY m.created_at DESC, m.id DESC'))
    for r in rows:
        r['size'] = _boyut(r)
        r['file_name'] = _dosya_adi(r)
        out.append(row_api(r))
    return out


def getir(conn, mid, tip=None):
    """API biçiminde model ya da None."""
    k = kimlik_coz(mid)
    if not k:
        return None
    if k[0] == 'builtin':
        return builtin_api(k[1], tip)
    r = _row(conn, k[1])
    return row_api(r) if r else None


def coz(conn, tip, model, airframe=None):
    """Oturum için model seçimi: `model` {id, orient?} ya da eski `airframe` ('caymaz'|'delta') → tam model nesnesi (to_dict'e girer).
    Eksikse tipin varsayılanı. Tip uyumsuz ya da bilinmeyen kimlik → SimHata('invalid')."""
    if model is None or model == {}:
        if airframe not in (None, ''):
            if airframe not in ('caymaz', 'delta'):
                raise SimHata('invalid', 'airframe caymaz | delta olmalı')
            if tip not in PLANE_TIPLERI:
                return getir(conn, VARSAYILAN[tip], tip)
            return getir(conn, f'builtin:{airframe}', tip)
        return getir(conn, VARSAYILAN.get(tip, 'builtin:quad'), tip)
    if isinstance(model, str):
        model = {'id': model}
    if not isinstance(model, dict) or kimlik_coz(model.get('id')) is None:
        raise SimHata('invalid', 'model.id geçersiz (builtin:<ad> ya da kütüphane kimliği)')
    m = getir(conn, model['id'], tip)
    if m is None:
        raise SimHata('invalid', 'Model kütüphanede bulunamadı')
    if tip not in m['types']:
        raise SimHata('invalid', f"Model {TIP_ADLARI.get(tip, tip)} tipi için değil")
    if m['source'] != 'builtin' and not m['ready']:
        raise SimHata('invalid', 'Model henüz GLB\'ye dönüştürülmedi (sihirbazda bir kez seçilince tarayıcı dönüştürür)')
    if model.get('orient') is not None and m['source'] != 'builtin':   # oturuma özel geçici yönelim (kaydetmez)
        m['orient'] = orient_dogrula(model['orient'])
    return m


def airframe_adi(model, tip):
    """Geriye uyum: oturumun `airframe` alanı (yalnız uçak tiplerinde dahili caymaz/delta için; aksi None)."""
    if not model or tip not in PLANE_TIPLERI:
        return None
    return {'builtin:caymaz': 'caymaz', 'builtin:delta': 'delta'}.get(model.get('id'))


# ---------------- yazma ----------------
def _ad(name, fallback):
    s = (name or '').strip()[:120]
    return s or fallback


def _tip(tip):
    if tip not in TIP_ADLARI:
        raise SimHata('invalid', 'type geçersiz')
    return tip


def yukle(conn, user, name, tip, file_name, data):
    """Simülatöre doğrudan yükleme: uzantı/boyut denetimi → DATA_DIR/sim_models/<id>/orijinal.<ext>; kayıt döner (API biçimi)."""
    ext = Path(file_name or '').suffix.lower()
    if ext not in UZANTILAR:
        raise SimHata('invalid', f"Desteklenmeyen dosya türü: {ext or '?'} (.glb, .gltf, .step, .stp, .obj)")
    if not data:
        raise SimHata('invalid', 'Dosya boş')
    if len(data) > MAX_BYTES:
        raise SimHata('invalid', 'Dosya 50 MB sınırını aşıyor')
    tip = _tip(tip)
    ad = _ad(name, Path(file_name).stem[:120] or 'Model')
    cur = conn.execute('INSERT INTO drone_sim_models (name, source, type, has_prop, created_by, created_at) VALUES (?,?,?,1,?,?)', (ad, 'upload', tip, user['id'], db.now()))
    iid = cur.lastrowid
    d = dizin(iid)
    d.mkdir(parents=True, exist_ok=True)
    (d / f'orijinal{ext}').write_bytes(data)
    conn.execute('UPDATE drone_sim_models SET file_path = ?, orient_json = ? WHERE id = ?',
                 (f'{KOK}/{iid}/orijinal{ext}', json.dumps(_varsayilan_orient(ext)), iid))
    if ext == '.glb':   # GLB zaten hedef biçim: dönüşümsüz hazır
        shutil.copyfile(d / f'orijinal{ext}', d / 'model.glb')
        conn.execute('UPDATE drone_sim_models SET glb_path = ? WHERE id = ?', (f'{KOK}/{iid}/model.glb', iid))
    return row_api(_row(conn, iid))


def _varsayilan_orient(ext):
    """CAD (STEP) dosyaları genelde Z yukarı, mm; glTF/OBJ Y yukarı (+Z öne bakar). Ölçek STEP için tarayıcı dönüşümünde metreye çevrilir (1)."""
    o = json.loads(json.dumps(ORIENT_VARSAYILAN))
    if ext in ('.glb', '.gltf', '.obj'):
        o['forward'], o['up'] = '+z', '+y'
    return o


def tasarim_dosyalari(conn):
    """Tasarım modülündeki 3B sürüm dosyaları (STEP/GLB/GLTF/OBJ): kütüphaneye eklenebilir adaylar."""
    rows = db.rows(conn.execute('''SELECT v.id, v.version, v.file_path, v.file_name, v.size, v.created_at, d.name AS drawing_name, p.name AS project_name,
                                          (SELECT m.id FROM drone_sim_models m WHERE m.source = 'design' AND m.source_ref = v.id LIMIT 1) AS model_id
                                   FROM design_drawing_versions v JOIN design_drawings d ON d.id = v.drawing_id JOIN design_projects p ON p.id = d.project_id
                                   WHERE v.file_path IS NOT NULL ORDER BY v.created_at DESC'''))
    return [r for r in rows if Path(r['file_path'] or '').suffix.lower() in UZANTILAR]


def tasarimdan_ekle(conn, user, vid, tip, name=None):
    """Tasarım sürüm dosyasını kütüphaneye ekler (dosya kopyalanmaz). Aynı sürüm + tip için kayıt varsa onu döner."""
    tip = _tip(tip)
    v = db.row(conn.execute('''SELECT v.id, v.file_path, v.file_name, d.name AS drawing_name FROM design_drawing_versions v
                               JOIN design_drawings d ON d.id = v.drawing_id WHERE v.id = ?''', (vid,)))
    if not v or not v['file_path']:
        raise SimHata('invalid', 'Tasarım dosyası bulunamadı')
    ext = Path(v['file_path']).suffix.lower()
    if ext not in UZANTILAR:
        raise SimHata('invalid', f'Desteklenmeyen dosya türü: {ext}')
    var = db.row(conn.execute("SELECT id FROM drone_sim_models WHERE source = 'design' AND source_ref = ? AND type = ?", (vid, tip)))
    if var:
        return row_api(_row(conn, var['id']))
    ad = _ad(name, v['drawing_name'] or Path(v['file_name'] or '').stem or 'Tasarım')
    cur = conn.execute('INSERT INTO drone_sim_models (name, source, source_ref, type, file_path, orient_json, has_prop, created_by, created_at) VALUES (?,?,?,?,?,?,1,?,?)',
                       (ad, 'design', vid, tip, v['file_path'], json.dumps(_varsayilan_orient(ext)), user['id'], db.now()))
    iid = cur.lastrowid
    dizin(iid).mkdir(parents=True, exist_ok=True)
    if ext == '.glb':
        src = config.UPLOAD_DIR / v['file_path']
        if src.is_file() and src.stat().st_size <= MAX_BYTES:
            shutil.copyfile(src, dizin(iid) / 'model.glb')
            conn.execute('UPDATE drone_sim_models SET glb_path = ? WHERE id = ?', (f'{KOK}/{iid}/model.glb', iid))
    return row_api(_row(conn, iid))


def guncelle(conn, iid, body):
    """name / type / orient / has_prop."""
    r = _row(conn, iid)
    if not r:
        return None
    if 'name' in body and body['name'] is not None:
        conn.execute('UPDATE drone_sim_models SET name = ? WHERE id = ?', (_ad(body['name'], r['name']), iid))
    if 'type' in body and body['type'] is not None:
        conn.execute('UPDATE drone_sim_models SET type = ? WHERE id = ?', (_tip(body['type']), iid))
    if 'orient' in body and body['orient'] is not None:
        conn.execute('UPDATE drone_sim_models SET orient_json = ? WHERE id = ?', (json.dumps(orient_dogrula(body['orient'])), iid))
    if 'has_prop' in body and body['has_prop'] is not None:
        conn.execute('UPDATE drone_sim_models SET has_prop = ? WHERE id = ?', (1 if body['has_prop'] else 0, iid))
    return row_api(_row(conn, iid))


def glb_kaydet(conn, iid, data):
    """Tarayıcıda üretilen GLB: başlık 'glTF' + sürüm 2, ≤ 50 MB → DATA_DIR/sim_models/<id>/model.glb; ready=true."""
    r = _row(conn, iid)
    if not r:
        return None
    if not data or len(data) < 20 or data[:4] != b'glTF':
        raise SimHata('invalid', 'Geçerli bir GLB (binary glTF) değil')
    if len(data) > MAX_BYTES:
        raise SimHata('invalid', 'GLB 50 MB sınırını aşıyor')
    d = dizin(iid)
    d.mkdir(parents=True, exist_ok=True)
    (d / 'model.glb').write_bytes(data)
    conn.execute('UPDATE drone_sim_models SET glb_path = ? WHERE id = ?', (f'{KOK}/{iid}/model.glb', iid))
    return row_api(_row(conn, iid))


def thumb_kaydet(conn, mid, data, tip=None):
    """320×240 PNG küçük resim (≤ 2 MB). Dahili: DATA_DIR/sim_models/builtin/<ad>-<tip>.png; tablo kaydı: <id>/thumb.png."""
    if not data or data[:8] != b'\x89PNG\r\n\x1a\n':
        raise SimHata('invalid', 'Küçük resim PNG olmalı')
    if len(data) > THUMB_MAX:
        raise SimHata('invalid', 'Küçük resim 2 MB sınırını aşıyor')
    k = kimlik_coz(mid)
    if not k:
        return None
    if k[0] == 'builtin':
        b = BUILTIN[k[1]]
        tip = tip if tip in b['types'] else b['types'][0]
        p = config.DATA_DIR / KOK / 'builtin' / f'{k[1]}-{tip}.png'
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_bytes(data)
        return builtin_api(k[1], tip)
    r = _row(conn, k[1])
    if not r:
        return None
    d = dizin(k[1])
    d.mkdir(parents=True, exist_ok=True)
    (d / 'thumb.png').write_bytes(data)
    conn.execute('UPDATE drone_sim_models SET thumb_path = ? WHERE id = ?', (f'{KOK}/{k[1]}/thumb.png', k[1]))
    return row_api(_row(conn, k[1]))


def thumb_yolu(conn, mid, tip=None):
    k = kimlik_coz(mid)
    if not k:
        return None
    if k[0] == 'builtin':
        b = BUILTIN[k[1]]
        tip = tip if tip in b['types'] else b['types'][0]
        p = builtin_thumb_yolu(k[1], tip)
        return p if p.is_file() else None
    r = _row(conn, k[1])
    if not r or not r.get('thumb_path'):
        return None
    p = config.DATA_DIR / r['thumb_path']
    return p if p.is_file() else None


def glb_yolu(conn, iid):
    r = _row(conn, iid)
    if not r or not r.get('glb_path'):
        return None
    p = config.DATA_DIR / r['glb_path']
    return p if p.is_file() else None


def sil(conn, iid):
    r = _row(conn, iid)
    if not r:
        return None
    conn.execute('DELETE FROM drone_sim_models WHERE id = ?', (iid,))
    shutil.rmtree(dizin(iid), ignore_errors=True)   # design kaynağında özgün dosya UPLOAD_DIR'de kalır (yalnız GLB/thumb silinir)
    return r
