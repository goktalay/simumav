# SIMUMAV sunucu kurulumu ve otomatik yayın

Belge sözleşmesi: `docs/simumav.md` §1 (yayın), §6 (yayın ve doğrulama), §7 (güvenlik). PROD'a uygulama **kullanıcı onayıyla**.

## Dosyalar

| Dosya | Görev |
|---|---|
| `hepgo-simumav.service` | Uygulama servisi (User=hepgo, `SIMUMAV_UDS=/run/hepgo/simumav.sock`, `ExecStart=run-simumav.sh`) — çekirdek ajanı yazar |
| `hepgo-simumav-deploy.path` | root; `/opt/hepgo/sshmaster/data/releases/sv/latest` değişince `hepgo-simumav-deploy.service`'i tetikler |
| `hepgo-simumav-deploy.service` | root oneshot; `deploy.sh`'ı çalıştırır |
| `deploy.sh` | sha256 → güvenli aç → venv/pip → yedek (`simumav.prev`) → rsync → restart → sağlık → gerekirse geri dön |
| `cloudflared-ingress.yml` | `simumav.com`, `www.simumav.com` → `unix:/run/hepgo/simumav.sock` parçası |

## Akış (uçtan uca)

1. Geliştirici goktalay/simumav deposunda `vX.Y.Z` etiketi atar → GitHub Actions `release.yml`: testler, `simumav-X.Y.Z.tar.gz`
   + sha256, GitHub Release, `scripts/upload-mastertool.sh` → `POST https://mastertool.download/api/sv/web-releases`
   (`X-Release-Key: $SIMUMAV_RELEASE_KEY`).
2. Hesap servisi (hepgo-sshmasters, hepgo kullanıcısı) paketi doğrular (anahtar, sürüm, gzip, boyut ≤ 95 MB, iç `VERSION`,
   yol gezinme/symlink reddi, sha256), `data/releases/sv/<v>/simumav-<v>.tar.gz` + `.sha256` yazar, `web_releases` tablosuna
   kaydeder ve `data/releases/sv/latest` dosyasına sürümü **atomik** (tmp + rename) yazar.
3. `hepgo-simumav-deploy.path` (root) `latest` değişimini görür → `deploy.sh`:
   - `latest` → `<v>` → `releases/sv/<v>/simumav-<v>.tar.gz`; sha256 dosyasıyla doğrular; aynı sürüm kuruluysa çıkar.
   - gzip imzası, `tar -t` ile mutlak yol / `..` / sembolik-sert bağ taraması; `/opt/hepgo/simumav.new`'e açar; `VERSION` eşleşmeli.
   - `.venv` yoksa `python3 -m venv` + pip; `requirements.txt` sha256'sı `.venv/.requirements.sha256`'dan farklıysa `pip install -r`.
   - Mevcut kurulum `/opt/hepgo/simumav.prev`'e (venv ve .env hariç) yedeklenir; `rsync -a --delete --exclude .venv --exclude .env`
     ile `/opt/hepgo/simumav`'a geçer; `chown -R root:root` (hepgo yalnız okur); `.env` 640 root:hepgo korunur.
   - `systemctl restart hepgo-simumav`; 30 sn içinde `curl --unix-socket /run/hepgo/simumav.sock http://x/api/meta` 200 → TAMAM.
   - Değilse journal son 30 satır günlüğe, `simumav.prev` geri rsync, restart, tekrar sağlık; sonuç günlüğe.
   - Günlük: `/var/log/hepgo-simumav-deploy.log`.

## İlk kurulum (root; PROD'da onayla)

```bash
# 1) hesap servisi anahtarı: /opt/hepgo/sshmaster/.env → SIMUMAV_RELEASE_KEY=<GitHub secret ile aynı>; systemctl restart hepgo-sshmasters
# 2) uygulama servisi ve env
install -d -o root -g root /opt/hepgo/simumav
install -m 640 -o root -g hepgo /dev/null /opt/hepgo/simumav/.env   # GOOGLE_MAPS_API_KEY, SIMUMAV_SECRET, SIMUMAV_DATA_DIR=/opt/hepgo/simumav-data,
                                                                  # SIMUMAV_MT_URL=https://mastertool.download, SIMUMAV_MT_INTERNAL=http://127.0.0.1:8095
install -d -o hepgo -g hepgo -m 750 /opt/hepgo/simumav-data
cp hepgo-simumav.service hepgo-simumav-deploy.path hepgo-simumav-deploy.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable hepgo-simumav                      # ilk paket gelince deploy.sh başlatır
systemctl enable --now hepgo-simumav-deploy.path
# 3) ilk paketi elle yaymak için (etiket atılmışsa):
bash deploy.sh /opt/hepgo/sshmaster/data/releases/sv/<v>/simumav-<v>.tar.gz
# 4) cloudflared ingress parçası + systemctl restart cloudflared; DNS CNAME ve Google referrer kullanıcı ekler (§6).
```

`hepgo-simumav.service` içinde `EnvironmentFile=/opt/hepgo/simumav/.env` ve `WorkingDirectory=/opt/hepgo/simumav` beklenir;
`.env` yayın sırasında hiç dokunulmaz (rsync `--exclude .env`, yedeğe de alınmaz).

## Ortam değişkenleri (`/opt/hepgo/simumav/.env`; gerçek değer yazılmaz)

| Anahtar | Açıklama |
|---|---|
| `SIMUMAV_DATA_DIR` | `/opt/hepgo/simumav-data` (simumav.db, `core/` çekirdek verisi, `files/`) |
| `SIMUMAV_SECRET` | 32+ bayt rastgele |
| `SIMUMAV_MT_URL` / `SIMUMAV_MT_INTERNAL` | `https://mastertool.download` / `http://127.0.0.1:8095` (sunucu-sunucu belirteç doğrulaması) |
| `SIMUMAV_MT_APP` | `sv` |
| `SIMUMAV_MT_SHARED_SECRET` | hesap servisi `.env`'deki aynı değer (`sv_profiles` yazımı, `X-Simumav-Secret`) |
| `SIMUMAV_PUBLIC_HOST` | MP bağlantı satırında gösterilen sunucu adı/IP |
| `SIMUMAV_MAX_FLIGHTS` · `SIMUMAV_FLIGHT_MINUTES` | eşzamanlı uçuş (6) · uçuş süresi (≤ 45) |
| `SIMUMAV_MP_PORT_BASE` · `SIMUMAV_MP_PORT_COUNT` | MP TCP aralığı (15600 / 400 → 15600–15999); ufw: `allow 15600:15999/tcp` |
| `SIMUMAV_UDP_BASE` | iç SITL↔MP UDP aralığı (14550…); DIŞA KAPALI |
| `GOOGLE_MAPS_API_KEY` | referrer listesine `simumav.com` eklenir |
| `HEPGO_SITL_DIR` | `/opt/hepgo/sitl/bin` (arducopter/arduplane ikilileri) |
| `SIMUMAV_ALLOWED_ORIGINS` | ek CSRF kökenleri (isteğe bağlı) |

`SIMUMAV_DEV_LOGIN` PROD'da ASLA 1 yapılmaz. Hesap servisi tarafı: `SIMUMAV_MT_SHARED_SECRET`, `SIMUMAV_RELEASE_KEY`.

## Doğrulama

- `systemctl status hepgo-simumav-deploy.path hepgo-simumav`; `tail -f /var/log/hepgo-simumav-deploy.log`
- `curl --unix-socket /run/hepgo/simumav.sock http://x/api/meta` → `{"version": "<v>", ...}`
- Dışarıdan `https://simumav.com/api/meta` 200 ve `version` eşit.
- Geri dönüş testi: bozuk `run-simumav.sh` içeren bir paket → günlükte "GERİ DÖNÜLDÜ", `/api/meta` eski sürümü verir.
