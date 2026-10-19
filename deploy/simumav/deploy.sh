#!/usr/bin/env bash
# SIMUMAV sunucu yayını (root). hepgo-simumav-deploy.service tarafından çağrılır; elle de çalıştırılabilir.
# Kullanım: deploy.sh <simumav-<v>.tar.gz>        (ya da argümansız: $RELEASES/latest işaretçisindeki sürüm)
#
# Akış: sha256 doğrula → /opt/hepgo/simumav.new'e aç (yol gezinme reddi) → .venv yoksa oluştur / requirements değiştiyse pip
#       → mevcut kurulumu simumav.prev'e yedekle → rsync -a --delete --exclude .venv → chown root:root → .env korunur
#       → systemctl restart hepgo-simumav → sağlık (unix soket /api/meta 200) → başarısızsa simumav.prev'e geri dön.
# Günlük: /var/log/hepgo-simumav-deploy.log. Aynı sürüm zaten kuruluysa (VERSION eşit) çıkar.
set -euo pipefail

RELEASES="${SIMUMAV_RELEASES:-/opt/hepgo/sshmaster/data/releases/sv}"
APP="${SIMUMAV_APP:-/opt/hepgo/simumav}"
NEW="$APP.new"; PREV="$APP.prev"
ENV_FILE="${SIMUMAV_ENV:-/opt/hepgo/simumav/.env}"
SOCK="${SIMUMAV_UDS:-/run/hepgo/simumav.sock}"
SERVICE="${SIMUMAV_SERVICE:-hepgo-simumav}"
LOG="${SIMUMAV_DEPLOY_LOG:-/var/log/hepgo-simumav-deploy.log}"
PY="${SIMUMAV_PYTHON:-python3}"
MAX_BYTES=$((95 * 1024 * 1024))

log() { printf '%s [%s] %s\n' "$(date -Is)" "$$" "$*" | tee -a "$LOG" >&2; }
die() { log "HATA: $*"; exit 1; }
[ "$(id -u)" = 0 ] || die "root olarak çalıştırılmalı"
touch "$LOG"

# ---- paket seçimi -------------------------------------------------------------
TAR="${1:-}"
if [ -z "$TAR" ]; then
  [ -f "$RELEASES/latest" ] || die "$RELEASES/latest yok"
  V=$(tr -d '[:space:]' < "$RELEASES/latest")
  [[ "$V" =~ ^[0-9]{1,4}\.[0-9]{1,4}\.[0-9]{1,4}([.-][0-9A-Za-z.-]{1,20})?$ ]] || die "latest içeriği geçersiz sürüm: '$V'"
  TAR="$RELEASES/$V/simumav-$V.tar.gz"
fi
[ -f "$TAR" ] || die "paket yok: $TAR"
case "$(realpath "$TAR")" in "$RELEASES"/*) ;; *) [ -n "${1:-}" ] || die "paket $RELEASES dışında";; esac
V=$(basename "$TAR" .tar.gz); V="${V#simumav-}"
[ "$(stat -c %s "$TAR")" -le "$MAX_BYTES" ] || die "paket 95 MB'den büyük"

# ---- sha256 ------------------------------------------------------------------
SHA_FILE="$TAR.sha256"
[ -f "$SHA_FILE" ] || SHA_FILE="$(dirname "$TAR")/sha256"
[ -f "$SHA_FILE" ] || die "sha256 dosyası yok ($TAR.sha256)"
BEKLENEN=$(awk '{print $1}' "$SHA_FILE" | head -1 | tr 'A-F' 'a-f')
GERCEK=$(sha256sum "$TAR" | awk '{print $1}')
[ "$BEKLENEN" = "$GERCEK" ] || die "sha256 uyuşmuyor: beklenen $BEKLENEN, paket $GERCEK"

if [ -f "$APP/VERSION" ] && [ "$(tr -d '[:space:]' < "$APP/VERSION")" = "$V" ]; then
  log "$V zaten kurulu; işlem yok"; exit 0
fi
log "yayın başlıyor: $V ($TAR)"

# ---- aç (güvenli) --------------------------------------------------------------
rm -rf "$NEW"; mkdir -p "$NEW"
# gzip imzası + tehlikeli yollar (mutlak, .., sembolik/sert bağ) reddi; tar'ın kendi korumaları da açık
[ "$(head -c 2 "$TAR" | od -An -tx1 | tr -d ' ')" = "1f8b" ] || die "gzip imzası yok"
if tar -tzf "$TAR" | grep -Eq '(^/|(^|/)\.\.(/|$))'; then die "pakette mutlak ya da .. içeren yol var"; fi
if tar -tvzf "$TAR" | grep -Eq '^[lh]'; then die "pakette sembolik/sert bağ var"; fi
tar -xzf "$TAR" -C "$NEW" --no-same-owner --no-same-permissions --no-overwrite-dir
# tek kök klasör (simumav-<v>/) ise içeri in
if [ "$(find "$NEW" -mindepth 1 -maxdepth 1 | wc -l)" = 1 ] && [ -d "$NEW"/* ]; then
  mv "$NEW"/*/ "$NEW.inner" && rm -rf "$NEW" && mv "$NEW.inner" "$NEW"
fi
[ -f "$NEW/VERSION" ] || die "pakette VERSION yok"
[ "$(tr -d '[:space:]' < "$NEW/VERSION")" = "$V" ] || die "VERSION ($(cat "$NEW/VERSION")) dosya adıyla ($V) uyuşmuyor"
[ -f "$NEW/requirements.txt" ] && [ -f "$NEW/run-simumav.sh" ] || die "pakette requirements.txt / run-simumav.sh yok"

# ---- sanal ortam ---------------------------------------------------------------
mkdir -p "$APP"
if [ ! -x "$APP/.venv/bin/python" ]; then
  log ".venv oluşturuluyor"
  "$PY" -m venv "$APP/.venv"
  "$APP/.venv/bin/pip" install -q --upgrade pip >>"$LOG" 2>&1
fi
REQ_HASH=$(sha256sum "$NEW/requirements.txt" | awk '{print $1}')
if [ ! -f "$APP/.venv/.requirements.sha256" ] || [ "$(cat "$APP/.venv/.requirements.sha256")" != "$REQ_HASH" ]; then
  log "pip install -r requirements.txt"
  "$APP/.venv/bin/pip" install -q -r "$NEW/requirements.txt" >>"$LOG" 2>&1 || die "pip install başarısız (bkz. $LOG)"
  echo "$REQ_HASH" > "$APP/.venv/.requirements.sha256"
fi

# ---- yedek + senkron -------------------------------------------------------------
ONCEKI_V=$(cat "$APP/VERSION" 2>/dev/null | tr -d '[:space:]' || true)
if [ -f "$APP/VERSION" ]; then
  rm -rf "$PREV"; mkdir -p "$PREV"
  rsync -ac --delete --exclude .venv --exclude .env "$APP/" "$PREV/"
fi
rsync -ac --delete --exclude .venv --exclude .env "$NEW/" "$APP/"   # -c: paket mtime sabit (2020), boyut aynıysa rsync atlardı
chown -R root:root "$APP"
chmod -R u+rwX,go+rX,go-w "$APP"; chmod 755 "$APP/run-simumav.sh" "$APP/deploy/simumav/deploy.sh" 2>/dev/null || true
[ -f "$ENV_FILE" ] && chown root:hepgo "$ENV_FILE" && chmod 640 "$ENV_FILE"
rm -rf "$NEW"

# ---- yeniden başlat + sağlık --------------------------------------------------------
saglik() {
  local i
  for i in $(seq 1 30); do
    sleep 1
    if curl -fsS --max-time 3 --unix-socket "$SOCK" http://x/api/meta >/dev/null 2>&1; then return 0; fi
  done
  return 1
}
systemctl restart "$SERVICE" || true
if saglik; then
  log "TAMAM: $V yayında (önceki: ${ONCEKI_V:-yok})"
  exit 0
fi

# ---- geri dönüş ----------------------------------------------------------------------
log "sağlık denetimi başarısız; journal:"; journalctl -u "$SERVICE" -n 30 --no-pager >>"$LOG" 2>&1 || true
if [ -d "$PREV" ] && [ -f "$PREV/VERSION" ]; then
  rsync -ac --delete --exclude .venv --exclude .env "$PREV/" "$APP/"
  chown -R root:root "$APP"
  systemctl restart "$SERVICE" || true
  if saglik; then log "GERİ DÖNÜLDÜ: $ONCEKI_V tekrar yayında ($V başarısız)"; else log "GERİ DÖNÜŞ DE BAŞARISIZ: servis ayakta değil, elle müdahale gerekir"; fi
else
  log "önceki sürüm yok; $V başarısız durumda bırakıldı"
fi
exit 1
