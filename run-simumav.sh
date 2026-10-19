#!/usr/bin/env bash
# SIMUMAV sunucusu (app.simumav.main:app) — run.sh kalıbı.
# SIMUMAV_UDS tanımlıysa Unix domain socket (yalnız cloudflared tüneli erişir); yoksa http://0.0.0.0:${SIMUMAV_PORT:-8600}.
# Ortam (.env ya da systemd): SIMUMAV_DATA_DIR, SIMUMAV_SECRET, SIMUMAV_MT_URL, SIMUMAV_MT_INTERNAL, SIMUMAV_MT_APP (sv), SIMUMAV_MT_SHARED_SECRET,
#   SIMUMAV_MAX_FLIGHTS, SIMUMAV_MP_PORT_BASE, SIMUMAV_PUBLIC_HOST, GOOGLE_MAPS_API_KEY, HEPGO_SITL_DIR (SITL ikilileri), HEPGO_SITL (0 = sahte kip).
set -euo pipefail
cd "$(dirname "$0")"
[ -x .venv/bin/uvicorn ] || { python3 -m venv .venv && .venv/bin/pip install -q -r requirements.txt; }   # PROD: deploy.sh kurar
export SIMUMAV_DATA_DIR="${SIMUMAV_DATA_DIR:-/opt/hepgo/simumav-data}"
if [ -n "${SIMUMAV_UDS:-}" ]; then
  mkdir -p "$(dirname "$SIMUMAV_UDS")"
  rm -f "$SIMUMAV_UDS"
  exec .venv/bin/uvicorn app.simumav.main:app --uds "$SIMUMAV_UDS" --proxy-headers --forwarded-allow-ips '*' --no-server-header --timeout-graceful-shutdown 5
fi
exec .venv/bin/uvicorn app.simumav.main:app --host "${SIMUMAV_HOST:-0.0.0.0}" --port "${SIMUMAV_PORT:-8600}" --no-server-header --timeout-graceful-shutdown 5
