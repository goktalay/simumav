# SIMUMAV oyun arayüzü — ses ve görsel varlıklar: kaynaklar ve lisanslar

Dron GLB modelleri için ayrıntılı tablo: [`models/LICENSES.md`](models/LICENSES.md).

| Varlık | Ne | Kaynak | Lisans |
|---|---|---|---|
| `app/ui/music.js` | Arka plan müziği (yumuşak ambient/synthwave döngü, La minör, 76 BPM) | **Prosedürel — dış kaynak yok.** Çalışma anında Web Audio API ile sentezlenir (osilatör + süzgeç + üretilmiş yankı dürtüsü); ses dosyası, örnek (sample) ya da CDN kullanılmaz | HEPGO/SIMUMAV'ın kendi kodu; üçüncü taraf hakkı yok |
| `app/ui/sfx.js` | Arayüz efektleri (hover, seçim, geçiş, alarm) ve menü motor sesi | **Prosedürel** (Web Audio sentezi) | HEPGO/SIMUMAV'ın kendi kodu |
| `app/ui/backdrop/scenes.js` | Bölüm arka planları (hangar, brifing sınıfı, tel kafes küre, ilaçlama tarlası, bulutlar) | **Prosedürel** Canvas2D çizimi; doku/görsel dosyası yok | HEPGO/SIMUMAV'ın kendi kodu |
| `app/ui/backdrop/caymaz_atlas.webp` | CAYMAZ 32 açılık hareket karesi atlası (Uç girişi ve hangar arka planı) | `static/models/caymaz-sim.glb` (HEPGO'nun kendi CAYMAZ V3 modeli) → `tools/simumav_caymaz_sprites.py` (headless Chromium + three.js ile önceden çizilir) | HEPGO'nun kendi modeli; paketle birlikte dağıtılır |
| `static/vendor/three/` | three.js (atlas üretiminde ve 3B sahnelerde) | https://github.com/mrdoob/three.js | MIT |

Yeni üçüncü taraf ses/müzik/doku eklenirse yalnız CC0 ya da açık lisanslı olmalı ve bu tabloya kaynak + yazar + lisans ile yazılmalıdır.
