# SIMUMAV — bağımsız dron simülasyon oyunu

Sürüm: **0.1.35** · Site: https://simumav.com · Hesap: https://mastertool.download (uygulama kodu `sv`)

HEPGO Uçuş Simülatörü çekirdeğinin (ArduPilot SITL + Google 3B / gerçek arazi + dron paneli + görev / çarpışma / .bin /
replay) HEPGO'dan **bağımsız**, mastertool.download hesap yapısıyla çalışan, oyun görünümünde sürümü.
Sözleşme: `docs/simumav.md` (mimari, veri modeli, REST yüzeyi, güvenlik, yayın).

> Bu depo **üretilmiş** bir ağaçtır. Kaynak geliştirme HEPGO deposunda (`fabrika-yonetim`) yapılır; buradaki dosyalar
> `tools/simumav_export.py` ile dışa aktarılır. Buraya doğrudan commit atılan kod değişiklikleri bir sonraki dışa aktarmada
> silinir — yalnız `.github/`, `scripts/`, `CHANGELOG.md` korunur.

## Mimari özet

- `app/simumav/` — ayrı ASGI uygulaması (`app.simumav.main:app`): oturum (hesap servisi belirteci → kendi HttpOnly çerezi),
  hangar / mürettebat / parkur / görev / uçuş / operasyon REST'i, `bridge.py` ile flightsim çekirdeğine adaptör.
- `app/flightsim*.py`, `sim_terrain.py`, `drone_sitl.py`, `drone_params.py` — HEPGO ile **aynı** simülasyon çekirdeği.
- `static/simumav/site` tanıtım sitesi, `static/simumav/app` oyun arayüzü; `static/js/modules/flightsim*.js`, `replay3d.js`
  simülatör ön yüzü (`/sim` olarak mount edilir); `static/vendor/three`, `static/vendor/xterm` CDN'siz bağımlılıklar.
- Veri: `SIMUMAV_DATA_DIR` altında sqlite (`simumav.db`) + `files/`. HEPGO veritabanına erişim yoktur.

## Çalıştırma (geliştirme)

```bash
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
cp .env.example .env 2>/dev/null || true     # GOOGLE_MAPS_API_KEY, SIMUMAV_SECRET, SIMUMAV_MT_URL, SIMUMAV_DATA_DIR
SIMUMAV_DEV_LOGIN=1 PORT=8600 ./run-simumav.sh    # http://127.0.0.1:8600
python -m tests.test_simumav                      # SITL gerekmez
python -m tests.test_simumav_power                # güç ve yakıt (§10); SITL gerekmez
python -m tests.test_simumav_match                # çok oyunculu karşılaşma (§18); SITL gerekmez
node tests/test_simumav_power.mjs && node tests/test_simumav_fly.mjs && node tests/test_simumav_match.mjs
```

SITL (ArduPilot) kurulu değilse uçuş sahte kinematikle çalışır (`HEPGO_SITL=0`).

## Geliştirme akışı

1. HEPGO deposunda değişikliği yap, testleri çalıştır.
2. `./.venv/bin/python tools/simumav_export.py --dest ~/mt-work/simumav --version X.Y.Z` → bu ağacı yeniler
   (`--dry-run` ile önce ne olacağını gör).
3. Bu depoda `git add -A && git commit` → `git push`.

## Yayın

```bash
git tag vX.Y.Z && git push origin vX.Y.Z
```

`.github/workflows/release.yml`: testler → `simumav-X.Y.Z.tar.gz` + `.sha256` → GitHub Release → `scripts/upload-mastertool.sh`
ile `https://mastertool.download/api/sv/web-releases` (anahtar: depo secret `SIMUMAV_RELEASE_KEY`). Sunucuda
`hepgo-simumav-deploy.path` yeni sürümü görür, `deploy/simumav/deploy.sh` doğrular, kurar, sağlık denetimi başarısızsa önceki
sürüme döner. Ayrıntı: `deploy/simumav/README.md`.

## Sunucu kurulumu

`deploy/simumav/README.md` — `hepgo-simumav.service` (uygulama), `hepgo-simumav-deploy.path/.service` (otomatik yayın),
cloudflared ingress parçası, `.env` alanları.
