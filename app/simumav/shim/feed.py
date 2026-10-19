"""feed SHIM — flightsim_rec.bitir → `feed.add_post` (Şirketten Haberler). SIMUMAV'da haber akışı yok: ekran kaydı uçları sunulmaz; çağrılırsa
paylaşım yapılmaz (None)."""
SIMUMAV_SHIM = True


def add_post(conn, owner_id, text, media=None):
    return None
