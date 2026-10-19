"""Replay alt süreci: `python -m app.simumav.replay_worker <log_id> <bin yolu>` — flightsim_replay._main ile aynı protokol (stdout `P <yüzde>` … `OK <meta>` /
`ERR <mesaj>`). HEPGO'nun `python -m app.flightsim_replay` girişi `app.config`'i ister; SIMUMAV deposunda o dosya olmadığından shim kurulup aynı
işlev çağrılır (pymavlink saf Python: ayrı süreç olay döngüsünü tıkamaz)."""
import sys

from . import config

config.shim.kur()   # çekirdek yolları + HEPGO modül karşılıkları (idempotent)
from .. import flightsim_replay  # noqa: E402

if __name__ == '__main__':
    flightsim_replay._main(sys.argv[1:])
