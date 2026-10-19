"""SIMUMAV gerçekçi dron GLB'leri (static/simumav/models): dosyalar var ve ≤ 3 MB, pygltflib ile yüklenir, üçgen ≤ 60 k, dokular ≤ 1024²,
pervane düğümü (flightsim3d PROP_RE) — jet hariç, glTF Y-yukarı/burun +X kutusu makul (m); bridge kataloğu: her GLB anahtarı dosyaya işaret eder,
tiplerin ilk modeli GLB, MODEL_ESLEME/MODEL_YUKSELT çekirdek ve katalogla tutarlı, varsayılan dron GLB; LICENSES.md her dosya için satır içerir;
export manifesti static/simumav/** ile modelleri kapsar.

Çalıştırma: .venv/bin/python -m tests.test_simumav_models
"""
import os
import re
import struct
import sys
import tempfile
import unittest
from pathlib import Path

KOK = Path(__file__).resolve().parents[1]
MODELS = KOK / 'static' / 'simumav' / 'models'
PROP_RE = re.compile(r'prop|propeller|rotor|pervane', re.I)
MAX_BYTES, MAX_TRI, MAX_TEX = 3 * 1024 * 1024, 60_000, 1024


def glb_json(path):
    import json
    b = path.read_bytes()
    assert b[:4] == b'glTF', 'GLB başlığı'
    ln = struct.unpack_from('<I', b, 12)[0]
    return json.loads(b[20:20 + ln].decode('utf-8'))


class GlbTest(unittest.TestCase):
    def setUp(self):
        os.environ.setdefault('SIMUMAV_DATA_DIR', tempfile.mkdtemp(prefix='simumav-mdl-'))
        for k in [k for k in sys.modules if k == 'app' or k.startswith('app.')]:
            del sys.modules[k]
        from app.simumav import bridge, db  # noqa: F401
        self.bridge, self.db = bridge, db

    def test_dosyalar_ve_sinirlar(self):
        try:
            import pygltflib
        except ImportError:
            pygltflib = None
        lic = (MODELS / 'LICENSES.md').read_text(encoding='utf-8')
        for key, g in self.bridge.GLB_MODELS.items():
            p = MODELS / f"{g['file']}.glb"
            self.assertTrue(p.is_file(), f'{key}: {p} yok')
            self.assertLessEqual(p.stat().st_size, MAX_BYTES, f'{key}: {p.stat().st_size} B > 3 MB')
            self.assertIn(f"`{g['file']}.glb`", lic, f'{key}: LICENSES.md satırı yok')
            j = glb_json(p)
            self.assertEqual(j['asset']['version'], '2.0')
            tri = 0
            for m in j.get('meshes', []):
                for pr in m.get('primitives', []):
                    acc = j['accessors'][pr['indices']] if 'indices' in pr else j['accessors'][pr['attributes']['POSITION']]
                    tri += acc['count'] // 3
            self.assertLessEqual(tri, MAX_TRI, f'{key}: {tri} üçgen')
            for im in j.get('images', []):
                self.assertIn('bufferView', im, f'{key}: doku gömülü olmalı')
            adlar = [n.get('name', '') for n in j.get('nodes', [])]
            props = [a for a in adlar if PROP_RE.search(a) and not re.search(r'_v\d+$', a)]
            if key != 'glb:jet':
                self.assertTrue(props, f'{key}: pervane düğümü yok ({adlar[:8]})')
            if pygltflib is not None:
                gl = pygltflib.GLTF2().load(str(p))
                self.assertTrue(gl.nodes and gl.meshes, key)
                for im in gl.images:
                    bv = gl.bufferViews[im.bufferView]
                    data = gl.binary_blob()[bv.byteOffset:bv.byteOffset + bv.byteLength]
                    if data[:8] == b'\x89PNG\r\n\x1a\n':
                        w, h = struct.unpack('>II', data[16:24])
                        self.assertLessEqual(max(w, h), MAX_TEX, f'{key}: doku {w}×{h}')
            # sınır kutusu (metre; düğüm dönüşümleri dahil): 0,3 … 6 m — trimesh varsa
            try:
                import trimesh
            except ImportError:
                continue
            sc = trimesh.load(str(p), force='scene')
            ext = (sc.bounds[1] - sc.bounds[0]).tolist()
            self.assertTrue(0.3 <= max(ext) <= 6.0, f'{key}: boyut {ext}')

    def test_katalog_eslemesi(self):
        b = self.bridge
        cat = b.katalog()['types']
        keys = {t['key']: [m['key'] for m in t['models']] for t in cat}
        for t, k in b.VARSAYILAN_MODEL.items():
            self.assertEqual(keys[t][0], k, f'{t} ilk model')
        for key, g in b.GLB_MODELS.items():
            self.assertIn(key, keys[g['type']])
            self.assertIn(key, b.MODEL_ESLEME, f'{key}: çekirdek eşlemesi yok')
            self.assertIn(b.MODEL_ESLEME[key], ('builtin:quad', 'builtin:hexa', 'builtin:heli', 'builtin:caymaz', 'builtin:delta'))
            m = b.glb_model_api(key)
            self.assertEqual(m['glb'], f"/static/simumav/models/{g['file']}.glb")
            self.assertEqual((m['orient']['forward'], m['orient']['up']), ('+x', '+y'))
            self.assertTrue(b.model_gecerli(g['type'], key))
        for eski, yeni in b.MODEL_YUKSELT.items():
            self.assertIn(yeni, b.GLB_MODELS, eski)
            gor = b.model_gorsel(eski)
            self.assertEqual(gor['preview'], b.glb_model_api(yeni)['glb']); self.assertFalse(gor['proc']); self.assertIsNotNone(gor['orient'])
        self.assertEqual(b.model_gorsel('builtin:caymaz')['preview'], '/static/models/caymaz-sim.glb')
        self.assertIsNone(b.model_gorsel('builtin:caymaz')['orient'])
        self.assertTrue(b.model_gorsel('bilinmeyen')['proc'])
        self.assertEqual(self.db.DEFAULT_DRONE['model_key'], 'glb:iris_fpv')
        self.assertTrue(b.model_gecerli('fpv', 'proc:quad250') and b.model_gecerli('interceptor', 'proc:interceptor'))   # eski anahtarlar geçerli kalır

    def test_export_manifesti(self):
        import importlib.util
        spec = importlib.util.spec_from_file_location('simumav_export', KOK / 'tools' / 'simumav_export.py')
        sx = importlib.util.module_from_spec(spec); spec.loader.exec_module(sx)
        self.assertTrue(any(Path('static/simumav/models/iris.glb').match(g) or g == 'static/simumav/**' for g in sx.MANIFEST))


if __name__ == '__main__':
    unittest.main()
