"""tools/simumav_export.py — geçici sahte HEPGO ağacıyla: manifest + eksik glob uyarısı, Python import zinciri çözümü,
HEPGO'ya özgü modül uyarısı (kopyalanmaz / --include-hepgo), JS göreli zinciri + HEPGO api.js dışlama (SIMUMAV core/api.js kopyalanır) + vendor ekleme,
requirements çıkarımı, hedef temizleme/koruma kuralları, kuru çalıştırma, yanlış hedef reddi.

Çalıştırma: .venv/bin/python -m tests.test_simumav_export
"""
import importlib.util
import json
import sys
import tempfile
import unittest
from pathlib import Path

KOK = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('simumav_export', KOK / 'tools' / 'simumav_export.py')
sx = importlib.util.module_from_spec(spec)
spec.loader.exec_module(sx)


def yaz(kok: Path, yol: str, icerik: str = ''):
    p = kok / yol
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(icerik, encoding='utf-8')
    return p


def sahte_hepgo(kok: Path):
    yaz(kok, 'app/__init__.py')
    yaz(kok, 'app/flightsim.py', 'import json\nimport httpx\nfrom . import db, flightsim_hub\nfrom .yardimci import f\n')
    yaz(kok, 'app/flightsim_hub.py', 'from . import drone_hub\nimport numpy\n')
    yaz(kok, 'app/yardimci.py', 'from .derin import g\ndef f(): pass\n')
    yaz(kok, 'app/derin.py', 'import os\ndef g(): pass\n')
    yaz(kok, 'app/db.py', 'import sqlite3\n')                      # HEPGO'ya özgü
    yaz(kok, 'app/drone_hub.py', 'from . import feed\n')           # HEPGO'ya özgü
    yaz(kok, 'app/feed.py', '')
    yaz(kok, 'app/simumav/__init__.py')
    yaz(kok, 'app/simumav/main.py', 'from fastapi import FastAPI, Form, UploadFile\nfrom PIL import Image\nimport bilinmeyenpaket\n'
                                    'from .. import flightsim\n')
    for ad in ('flightsim_hub', 'flightsim_bin', 'flightsim_mission', 'flightsim_rec', 'flightsim_replay', 'flightsim_runs',
               'flightsim_models', 'sim_terrain', 'drone_sitl', 'drone_params'):
        if not (kok / 'app' / f'{ad}.py').exists():
            yaz(kok, f'app/{ad}.py', '')
    yaz(kok, 'static/js/modules/flightsim.js', "import { a } from './flightsim_panel.js';\nimport { ui } from '../ui.js';\n"
                                              "// import { x } from './yorumda.js';\n/* import y from './blokta.js' */\n"
                                              "import * as THREE from '/vendor/three/three.module.js';\n")
    yaz(kok, 'static/js/modules/flightsim_panel.js', "import { get } from '../api.js';\nconst m = await import('./flightsim_hud.js');\n")
    yaz(kok, 'static/js/modules/flightsim_hud.js', '')
    yaz(kok, 'static/js/modules/replay3d.js', "export { z } from '../vendor/xterm/xterm.js';\n")
    yaz(kok, 'static/js/modules/flightsim_g3d.js', '')
    yaz(kok, 'static/js/api.js', '')                             # HEPGO api.js: kopyalanmaz (simapi.js route'u)
    yaz(kok, 'static/simumav/app/core/api.js', "import * as S from '../simapi.js';\n")   # SIMUMAV'ın kendi api.js'i: kopyalanır
    yaz(kok, 'static/simumav/app/simapi.js', '')
    yaz(kok, 'static/js/ui.js', "import { t } from './i18n.js';\n")
    yaz(kok, 'static/js/i18n.js', '')
    yaz(kok, 'static/vendor/three/three.module.js', '')
    yaz(kok, 'static/vendor/three/jsm/x.js', '')
    yaz(kok, 'static/vendor/xterm/xterm.js', '')
    yaz(kok, 'static/vendor/chartjs/chart.js', '')                 # SIMUMAV'da yok; kopyalanmamalı
    yaz(kok, 'static/simumav/app/index.html', '<html></html>')
    yaz(kok, 'docs/simumav.md', '# sm')
    yaz(kok, 'requirements.txt', 'fastapi>=0.115\nuvicorn[standard]>=0.30\npython-multipart>=0.0.9\nhttpx>=0.27\n'
                                 'numpy>=1.26\nPillow>=10   # yorum\nanthropic>=1.10\n')
    # run-simumav.sh, deploy/simumav, tests/test_simumav* bilerek YOK → uyarı


class ExportTest(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.src = self.tmp / 'hepgo'
        self.dest = self.tmp / 'simumav'
        sahte_hepgo(self.src)
        (self.dest / '.git').mkdir(parents=True)
        yaz(self.dest, '.github/workflows/release.yml', 'name: x')
        yaz(self.dest, 'scripts/upload-mastertool.sh', '#!/bin/sh')
        yaz(self.dest, 'CHANGELOG.md', '# log')
        yaz(self.dest, 'README.md', 'eski')
        yaz(self.dest, 'eski_dizin/kalinti.py', 'x')
        yaz(self.dest, 'eski.txt', 'x')
        yaz(self.dest, 'VERSION', '0.3.1\n')

    def calistir(self, *ek):
        from io import StringIO
        import contextlib
        out = StringIO()
        with contextlib.redirect_stdout(out):
            rc = sx.main(['--src', str(self.src), '--dest', str(self.dest), '--json', *ek])
        self.assertEqual(rc, 0, out.getvalue())
        return json.loads(out.getvalue())

    def test_zincir_ve_uyarilar(self):
        r = self.calistir('--dry-run')
        d = set(r['dosyalar'])
        # Python zinciri: flightsim → yardimci → derin
        self.assertIn('app/yardimci.py', d); self.assertIn('app/derin.py', d)
        self.assertEqual(r['py_zincir']['app/derin.py'], 'app/yardimci.py')
        # HEPGO'ya özgü: uyarı var, dosya yok; zincir orada durur (feed de gelmez)
        self.assertNotIn('app/db.py', d); self.assertNotIn('app/drone_hub.py', d); self.assertNotIn('app/feed.py', d)
        self.assertTrue(any('app/db ←' in u for u in r['uyarilar']), r['uyarilar'])
        self.assertTrue(any('app/drone_hub ←' in u for u in r['uyarilar']))
        # JS zinciri: flightsim.js → flightsim_panel.js (manifest) → dinamik import hud; ../ui.js → i18n.js; yorumdakiler yok
        self.assertIn('static/js/ui.js', d); self.assertIn('static/js/i18n.js', d)
        self.assertIn('static/js/ui.js', d)                       # kök bağımlılıklar manifestte (main.py /<ad>.js beyaz listesi)
        self.assertFalse(any('yorumda' in u or 'blokta' in u for u in r['uyarilar']), r['uyarilar'])
        # HEPGO api.js dışlanır (not/uyarı üretmez), SIMUMAV core/api.js kopyalanır; vendor three/xterm eklenir, chartjs eklenmez
        self.assertNotIn('static/js/api.js', d)
        self.assertIn('static/simumav/app/core/api.js', d)
        self.assertFalse(any('api.js' in n for n in r['notlar'] + r['uyarilar']), r['notlar'] + r['uyarilar'])
        self.assertIn('static/vendor/three/jsm/x.js', d); self.assertIn('static/vendor/xterm/xterm.js', d)
        self.assertFalse(any(p.startswith('static/vendor/chartjs') for p in d))
        self.assertEqual(sorted(r['vendor']), ['three', 'xterm'])
        # eksik glob'lar uyarı, hata değil
        for g in ('run-simumav.sh', 'deploy/simumav/**', 'tests/test_simumav*'):
            self.assertIn(g, r['eksik_glob'])
        # requirements: httpx, numpy, Pillow (PIL), fastapi, uvicorn (her zaman), python-multipart (Form/UploadFile); anthropic yok
        self.assertEqual(r['requirements'], ['fastapi>=0.115', 'httpx>=0.27', 'numpy>=1.26', 'Pillow>=10', 'python-multipart>=0.0.9',
                                             'uvicorn[standard]>=0.30'])
        self.assertTrue(any('bilinmeyenpaket' in u for u in r['uyarilar']))
        # kuru: hedefe dokunulmadı
        self.assertTrue((self.dest / 'eski.txt').exists())
        self.assertEqual((self.dest / 'README.md').read_text(), 'eski')
        self.assertEqual(r['version'], '0.3.1')                 # hedefteki VERSION
        self.assertIn('eski_dizin', r['silinen']); self.assertNotIn('scripts', r['silinen'])

    def test_yazim_temizleme_koruma(self):
        r = self.calistir('--version', 'v1.2.3')
        self.assertEqual(r['version'], '1.2.3')
        self.assertFalse((self.dest / 'eski.txt').exists()); self.assertFalse((self.dest / 'eski_dizin').exists())
        for korunan in ('.git', '.github/workflows/release.yml', 'scripts/upload-mastertool.sh', 'CHANGELOG.md'):
            self.assertTrue((self.dest / korunan).exists(), korunan)
        self.assertEqual((self.dest / 'VERSION').read_text().strip(), '1.2.3')
        readme = (self.dest / 'README.md').read_text()
        self.assertIn('1.2.3', readme); self.assertIn('simumav_export.py', readme)
        self.assertIn('.venv/', (self.dest / '.gitignore').read_text())
        self.assertEqual((self.dest / 'requirements.txt').read_text().splitlines()[0], 'fastapi>=0.115')
        self.assertTrue((self.dest / 'app/simumav/main.py').exists())
        self.assertTrue((self.dest / 'static/simumav/app/index.html').exists())
        self.assertTrue((self.dest / 'docs/simumav.md').exists())
        self.assertFalse((self.dest / 'app/db.py').exists())
        self.assertFalse((self.dest / 'static/js/api.js').exists())
        self.assertTrue((self.dest / 'static/simumav/app/core/api.js').exists())
        # ikinci çalıştırma deterministik: aynı dosya listesi
        r2 = self.calistir('--version', '1.2.3')
        self.assertEqual(r['dosyalar'], r2['dosyalar'])

    def test_include_hepgo(self):
        r = self.calistir('--dry-run', '--include-hepgo')
        d = set(r['dosyalar'])
        self.assertIn('app/db.py', d); self.assertIn('app/drone_hub.py', d); self.assertIn('app/feed.py', d)
        self.assertFalse(any("HEPGO'ya özgü" in u for u in r['uyarilar']))

    def test_yanlis_hedef_reddi(self):
        baska = self.tmp / 'baska'
        yaz(baska, 'onemli.txt', 'x')                            # .git yok, boş değil
        rc = sx.main(['--src', str(self.src), '--dest', str(baska)])
        self.assertEqual(rc, 2)
        self.assertTrue((baska / 'onemli.txt').exists())
        rc = sx.main(['--src', str(self.tmp), '--dest', str(self.dest), '--dry-run'])   # app/ yok → HEPGO kökü değil
        self.assertEqual(rc, 2)


if __name__ == '__main__':
    unittest.main(argv=sys.argv[:1], verbosity=1)
