"""SIMUMAV — ÇOK OYUNCULU KARŞILAŞMA (halka yarışı) çalışma zamanı (docs/simumav.md §18; HEPGO docs/ucus-simulatoru.md §33.6).

Saf mantık HEPGO ile ORTAK: `app/flightsim_match_core.py` (halka ayarı/üretimi, başlangıç noktaları, geçiş denetimi, durum makinesi, sıralama).
Burada SIMUMAV'a özgü olanlar:
  · DAVET: kurucu karşılaşmayı kurunca tahmin edilemez bir davet kodu (secrets.token_urlsafe(16) → bağlantı `/app/#/match/join/<kod>`) ve
    kurucunun belirlediği ŞİFRE (yalnız scrypt özeti saklanır). Bağlantı + şifre kurucu tarafından elle paylaşılır (SIMUMAV'da e-posta altyapısı yok;
    "e-posta adımı" = Mastertool hesabıyla giriş). Davetli bağlantıyı açar → giriş yapar → şifreyi girer → LOBİ.
  · LOBİ (çekirdekten önceki evre; çekirdek Karsilasma davetlileri oluşturmada ister, SIMUMAV'da katılanlar sonradan gelir): katılanlar listesi
    (kurucu dahil), "Hazırım" işareti, kurucu çıkarabilir (çıkarılan aynı karşılaşmaya yeniden giremez). Kurucu herkes hazır olunca BAŞLAT →
    çekirdek Karsilasma (kurucu + katılanlar) kurulur ve herkes "geldi" yapılır → HAZIRLIK (çekirdek). Sonrası HEPGO ile aynı: her oyuncuya kendi
    SITL'i (bridge.ucus_baslat; kurucunun dronu ve parkuru, oyuncunun kendi pilotu; FARKLI başlangıç noktası), istemci 3B dünya kurulunca WS `ready`
    → herkes hazır → GERI_SAYIM (sunucu saatiyle start_at) → YARIS (komut kapısı açılır) → ilk bitiren / süre → BITTI (sonuç herkese).
  · Güvenlik: şifre ≥ 4 karakter, scrypt; kaba kuvvet sınırı (match_attempts: kullanıcı × karşılaşma 5, IP 20, karşılaşma 60 yanlış / 15 dk → 429);
    bilinmeyen kod denemesi IP başına oran sınırlı; oyuncu sayısı ≤ min(8, SIMUMAV_MATCH_MAX_PLAYERS, SIMUMAV_MAX_FLIGHTS); kullanıcı aynı anda tek
    bitmemiş karşılaşmada; sunucuda en çok SIMUMAV_MATCH_MAX_OPEN bitmemiş karşılaşma; lobi 30 dk'da başlamazsa iptal (zaman_asimi), kurucu
    MATCH_ABANDON_S görünmezse iptal (terk_edildi), görünmeyen davetli lobiden düşer; SITL tavanı: başlatırken n oyuncu için n boş yuva yoksa 429
    (anlaşılır mesaj), yuvalar oturumlar açılana dek ayrılır (bridge.MAC_REZERV). Yarışta simülasyon hızı 1× ve MP TCP köprüsü yok (ham MAVLink kapıyı
    aşmasın). Sunucu yeniden başlarsa bitmemiş satırlar IPTAL `sunucu_yeniden_basladi`; 1 günden eski şifre denemeleri silinir.
  · HEPGO §41 İT DALAŞI (`kind: 'dogfight'`): oyuncu sınırı tam 2; halka yok; roller BAŞLAT'ta (çekirdek HAZIRLIK) atanır; başlangıç noktaları
    rol başına (`core.it_baslangiclari`); angajman sunucuda (`core.ItDalasi`; tele kancası, yön + yunuslama); çarpışma → `k.carpti`; `pos`
    çerçevesinde `df`; yarışta Sıfırla yok (komut kapısı). DB `matches.kind` + `game_cfg` (v4 göçü).
"""
import asyncio
import hashlib
import hmac
import json
import secrets
import time

from .. import flightsim
from .. import flightsim_match_core as core
from . import bridge, config, db

POS_HZ = 10
KAPANIS_GECIKME_S = 8.0          # BITTI/IPTAL → oyuncu uçuşları kapanır (sonuç ekranı SITL'e ihtiyaç duymaz)
BELLEK_TUT_S = 15 * 60.0         # biten karşılaşma bellekte (WS/GET canlı); sonra yalnız DB
VIEWER_QUEUE = 128
SIFRE = (4, 32)
DENEME_PENCERE_S = 15 * 60.0
DENEME_KULLANICI = 5             # kullanıcı × karşılaşma yanlış şifre (pencerede) → 429
DENEME_IP = 20                   # IP başına tüm karşılaşmalarda yanlış şifre → 429
DENEME_MAC = 60                  # karşılaşma başına toplam yanlış şifre (dağıtık deneme) → karşılaşmaya katılım kilitlenir
GORULDU_S = 20.0                 # WS'siz "çevrimiçi" sayılma süresi (son GET)
TIPLER = tuple(k for k in bridge.TIP_ESLEME if k not in bridge.ROVER_TYPES)   # kara aracı havadaki halkalardan geçemez


def H(status, error, message, **extra):
    return bridge.BridgeHata(status, error, message, **extra)


# ---------------------------------------------------------------- şifre
def sifre_dogrula(pw):
    if not isinstance(pw, str):
        raise H(422, 'invalid', 'Şifre metin olmalı')
    if not (SIFRE[0] <= len(pw) <= SIFRE[1]) or any(ord(c) < 32 for c in pw):
        raise H(422, 'invalid', f'Şifre {SIFRE[0]}–{SIFRE[1]} karakter olmalı')
    return pw


def sifre_ozet(pw):
    tuz = secrets.token_bytes(16)
    oz = hashlib.scrypt(pw.encode('utf-8'), salt=tuz, n=2 ** 14, r=8, p=1, dklen=32)
    return f'scrypt${tuz.hex()}${oz.hex()}'


def sifre_dogru(pw, kayit):
    try:
        tur, tuz, oz = str(kayit).split('$')
        if tur != 'scrypt' or not isinstance(pw, str) or len(pw) > 256:
            return False
        h = hashlib.scrypt(pw.encode('utf-8'), salt=bytes.fromhex(tuz), n=2 ** 14, r=8, p=1, dklen=32)
        return hmac.compare_digest(h.hex(), oz)
    except (ValueError, TypeError):
        return False


def oyuncu_siniri():
    return max(2, min(core.OYUNCU_MAX, config.MATCH_MAX_PLAYERS, config.MAX_FLIGHTS))


def _iso(ts):
    if ts is None:
        return None
    from datetime import datetime
    return datetime.fromtimestamp(ts).astimezone().isoformat(timespec='seconds')


def ctip(drone_type):
    return bridge.TIP_ESLEME.get(drone_type)


def ayar_ozeti(settings):
    """Oyunculara gösterilen ayarlar (iç kimlikler/parametreler yok)."""
    d, t = settings.get('drone') or {}, settings.get('track') or {}
    return {'drone': {'name': d.get('name'), 'type': d.get('type'), 'model_key': d.get('model_key'), 'color': d.get('color')},
            'track': {'name': t.get('name'), 'lat': t.get('lat'), 'lon': t.get('lon'), 'world_mode': t.get('world_mode'), 'radius_m': t.get('radius_m'),
                      'weather': t.get('weather'), 'time_of_day': t.get('time_of_day')},
            'launch': settings.get('launch'), 'camera': settings.get('camera'), 'type': ctip(d.get('type'))}


def baslangic_onizleme(n, drone_type, track, rings, dogfight=None):
    """Önizleme: n oyuncunun başlangıç noktaları [{x, y, yaw_deg}] (yarışta aynı kural). §41 it dalaşında [kovalayan, kaçan] (+ role)."""
    w = db.j(track.get('world')) if isinstance(track.get('world'), str) else (track.get('world') or {})
    if dogfight is not None:
        P = core.it_baslangiclari(dogfight, ctip(drone_type), float(w.get('runway_heading') or 0))
        return [{'x': round(P[r][0], 1), 'y': round(P[r][1], 1), 'yaw_deg': round(P[r][2], 1), 'role': r} for r in (core.KOVALAYAN, core.KACAN)]
    pts = core.baslangic_noktalari(max(1, n), ctip(drone_type), float(w.get('runway_heading') or 0),
                                   hedef=(rings[0]['x'], rings[0]['y']) if rings else None)
    return [{'x': round(x, 1), 'y': round(y, 1), 'yaw_deg': round(yaw, 1)} for x, y, yaw in pts]


# ---------------------------------------------------------------- karşılaşma
class Mac:
    def __init__(self, yon, mid, code, host, pass_hash, max_players, settings, cfg, merkez, halkalar, now, tur=core.TUR_HALKA):
        self.yon = yon
        self.tur = tur                    # HEPGO §41 'rings' | 'dogfight' (cfg = it_ayar_dogrula çıktısı, halkalar [])
        self.id = mid
        self.code = code
        self.host_id = int(host['id'])
        self.pass_hash = pass_hash
        self.max_players = int(max_players)
        self.settings = settings          # {drone: satır, track: satır, launch, camera}
        self.cfg = cfg
        self.merkez = dict(merkez)        # {lat, lon, alt} — alt ilk oyuncu oturumunun ev irtifasıyla düzeltilir (SITL ile aynı kaynak)
        self.halkalar = halkalar
        self.olusturma_t = float(now)
        self._durum = core.LOBI
        self.neden = None
        self.bitis_t = None
        self.lobi = {self.host_id: {'id': self.host_id, 'name': host['display_name'], 'host': True, 'ready': True, 'joined_t': now, 'seen_t': now}}
        self.yasakli = set()              # çıkarılanlar (aynı karşılaşmaya yeniden katılamaz)
        self.k = None                     # core.Karsilasma (BAŞLAT sonrası)
        self.viewers = {}                 # ws → asyncio.Queue
        self.sessions = {}                # uid → SimSession
        self.flights = {}                 # uid → flights.id
        self.ready = set()
        self.task = None
        self._kapanis = None
        self.bitti_t = None
        self.alt_ok = False

    # ---------------------------------------------------------------- sorgular
    @property
    def durum(self):
        return self.k.durum if self.k is not None else self._durum

    def bitti(self):
        return self.durum in core.SON_DURUMLAR

    def oyuncu_mu(self, uid):
        if self.k is not None:
            return self.k.oyuncu(uid) is not None
        return int(uid) in self.lobi

    def aktif_oyuncu_mu(self, uid):
        """Bitmemiş karşılaşmada hâlâ katılımcı (yeni karşılaşmaya giremez)."""
        if self.bitti():
            return False
        if self.k is not None:
            o = self.k.oyuncu(uid)
            return o is not None and o.durum not in core.KATILMAYAN
        return int(uid) in self.lobi

    def gordu(self, uid):
        p = self.lobi.get(int(uid))
        if p is not None:
            p['seen_t'] = time.time()

    def cevrimici(self, now=None):
        now = now or time.time()
        ws_uid = {getattr(w, '_uid', None) for w in self.viewers}
        return {uid for uid, p in self.lobi.items() if now - p.get('seen_t', 0) <= GORULDU_S} | (ws_uid - {None})

    def baslatilabilir(self):
        if self.durum != core.LOBI or self.k is not None or len(self.lobi) < 2:
            return False
        return all(p['ready'] for p in self.lobi.values() if not p['host'])

    def anlik(self):
        now = time.time()
        on = self.cevrimici(now)
        if self.k is not None:
            d = self.k.dict(now)
            players = []
            for p in d['players']:
                lp = self.lobi.get(p['id']) or {}
                players.append({**p, 'ready': bool(lp.get('ready', True)), 'online': p['id'] in on, 'flight_id': self.flights.get(p['id'])})
            out = {k: d[k] for k in ('prepare_at', 'start_at', 'ended_at', 'winner', 'result', 'countdown_s', 'dogfight')}
        else:
            players = [{'id': p['id'], 'name': p['name'], 'host': p['host'], 'status': core.GELDI, 'ready': p['ready'], 'online': p['id'] in on,
                        'joined_at': p['joined_t'], 'rings': 0, 'total': len(self.halkalar), 'finished': False, 'flight_id': None, 'session_id': None, 'role': None}
                       for p in self.lobi.values()]
            out = {'prepare_at': None, 'start_at': None, 'ended_at': self.bitis_t, 'winner': None, 'result': None, 'countdown_s': core.GERI_SAYIM_S, 'dogfight': None}
        return {'id': self.id, 'code': self.code, 'state': self.durum, 'reason': self.k.neden if self.k is not None else self.neden, 'host_id': self.host_id,
                'max_players': self.max_players, 'created_at': self.olusturma_t, 'settings': ayar_ozeti(self.settings), 'rings_cfg': dict(self.cfg),
                'rings': list(self.k.halkalar if self.k is not None else self.halkalar), 'center': dict(self.merkez), 'players': players,
                'can_start': self.baslatilabilir(), 'now': now, 'live': True, 'kind': self.tur, **out}

    # ---------------------------------------------------------------- yayın
    def _yay(self, obj):
        txt = json.dumps(obj, ensure_ascii=False, default=str)
        for q in list(self.viewers.values()):
            flightsim._kuyruga(q, txt, obj.get('t') != 'pos')

    def degisti(self, kaydet=True):
        self._yay({'t': 'match', 'match': self.anlik()})
        if kaydet:
            self.kaydet()

    def izleyici_ekle(self, ws, uid):
        q = asyncio.Queue(maxsize=VIEWER_QUEUE)
        ws._uid = int(uid)
        self.viewers[ws] = q
        self.gordu(uid)
        return q

    def izleyici_sil(self, ws):
        self.viewers.pop(ws, None)
        uid = getattr(ws, '_uid', None)
        if uid is not None:
            self.gordu(uid)

    # ---------------------------------------------------------------- lobi işlemleri
    def katil(self, user, now):
        uid = int(user['id'])
        if uid in self.yasakli:
            raise H(403, 'kicked', 'Kurucu sizi bu karşılaşmadan çıkardı')
        if self.oyuncu_mu(uid):
            self.gordu(uid)
            return False
        if self.durum != core.LOBI or self.k is not None:
            raise H(409, 'started', 'Karşılaşma başladı ya da bitti; artık katılınamaz')
        if len(self.lobi) >= self.max_players:
            raise H(409, 'full', f'Karşılaşma dolu ({self.max_players} oyuncu)')
        self.lobi[uid] = {'id': uid, 'name': user['display_name'], 'host': False, 'ready': False, 'joined_t': now, 'seen_t': now}
        self.degisti()
        return True

    def hazir_ayarla(self, uid, deger):
        p = self.lobi.get(int(uid))
        if p is None or self.k is not None or self.durum != core.LOBI:
            raise H(409, 'conflict', 'Hazır işareti yalnız bekleme salonunda değiştirilebilir')
        if not p['host']:
            p['ready'] = bool(deger)
        p['seen_t'] = time.time()
        self.degisti(kaydet=False)

    def ayril(self, uid, now):
        uid = int(uid)
        if self.bitti():
            return
        if self.k is None:
            if uid == self.host_id:
                return self.iptal('kurucu_ayrildi', now)
            if self.lobi.pop(uid, None) is not None:
                self.ready.discard(uid)
                self.degisti()
            return
        self.isle(self.k.ayril(uid, now))

    def cikar(self, istek_uid, uid, now):
        if int(istek_uid) != self.host_id:
            raise H(403, 'forbidden', 'Yalnız kurucu oyuncu çıkarabilir')
        uid = int(uid)
        if uid == self.host_id or not self.oyuncu_mu(uid):
            raise H(422, 'invalid', 'Oyuncu bulunamadı')
        if self.k is None:
            if self.durum != core.LOBI:
                raise H(409, 'conflict', 'Karşılaşma bitti')
            self.lobi.pop(uid, None)
            self.yasakli.add(uid)
            self.degisti()
            return
        try:
            self.isle(self.k.cikar(istek_uid, uid, now))
        except core.MacHata as e:
            raise H({'forbidden': 403, 'conflict': 409}.get(e.kod, 422), e.kod, str(e))
        self.yasakli.add(uid)

    def iptal(self, neden, now=None):
        now = now or time.time()
        if self.bitti():
            return
        if self.k is None:
            self._durum, self.neden, self.bitis_t = core.IPTAL, neden, now
            self.bitti_t = now
            bridge.MAC_REZERV.pop(self.id, None)
            self.degisti()
            return
        self.isle(self.k.iptal(now, neden))

    def baslat(self, istek_uid, now):
        """Kurucu BAŞLAT: denetimler (≥ 2 oyuncu, herkes hazır, SITL yuvası, açık uçuş yok) → çekirdek Karsilasma → HAZIRLIK."""
        if int(istek_uid) != self.host_id:
            raise H(403, 'forbidden', 'Yalnız kurucu başlatabilir')
        if self.k is not None or self.durum != core.LOBI:
            raise H(409, 'conflict', 'Karşılaşma zaten başladı ya da bitti')
        if len(self.lobi) < 2:
            raise H(409, 'not_enough', 'Başlatmak için en az 2 oyuncu gerekir')
        bekleyen = [p['name'] for p in self.lobi.values() if not p['host'] and not p['ready']]
        if bekleyen:
            raise H(409, 'not_ready', f"Henüz hazır olmayan oyuncular: {', '.join(bekleyen)}")
        acik = [p['name'] for p in self.lobi.values() if bridge.aktif_ucus(p['id'])[0] is not None]
        if acik:
            raise H(409, 'flight_open', f"Süren uçuşu olan oyuncular önce uçuşunu bitirmeli: {', '.join(acik)}")
        n = len(self.lobi)
        bos = config.MAX_FLIGHTS - bridge.aktif_sayisi()
        if n > bos:
            raise H(429, 'server_full', f'Sunucuda yeterli simülatör yuvası yok: {n} oyuncunun her biri kendi simülatörünü alır, şu an {max(0, bos)} boş yuva var '
                    f'(sunucu tavanı {config.MAX_FLIGHTS}). Biraz sonra yeniden deneyin.', retry_after=bridge.bekleme_suresi() or 60, need=n, free=max(0, bos))
        host = self.lobi[self.host_id]
        digerleri = [(p['id'], p['name']) for p in self.lobi.values() if not p['host']]
        try:
            k = core.Karsilasma(self.id, (self.host_id, host['name']), digerleri, {'type': ctip(self.settings['drone']['type'])}, self.cfg, self.merkez, now,
                                self.halkalar, tur=self.tur)
        except core.MacHata as e:
            raise H(409 if e.kod == 'limit' else 422, e.kod, str(e))
        self.k = k
        bridge.MAC_REZERV[self.id] = n
        ev = []
        for uid, _ in digerleri:
            ev += k.katil(uid, now)   # herkes salonda: son katılımla LOBI → HAZIRLIK (çekirdek)
        self.isle(ev)

    # ---------------------------------------------------------------- çekirdek olayları
    def isle(self, olaylar):
        if not olaylar:
            return
        for e in olaylar:
            self._yay(e)
            if e['t'] == 'state':
                self._durum_yan_etkisi(e['state'])
            elif e['t'] == 'player' and e.get('status') in core.KATILMAYAN and e.get('id') in self.flights and not self.bitti():
                # ayrılan / çıkarılan / düşen oyuncunun uçuşu (SITL) hemen kapanır — yuva boşa tutulmaz (bitişte zaten hepsi kapanır)
                s = self.sessions.get(e['id'])
                if s is not None:
                    s.tele_kanca = None
                asyncio.get_running_loop().create_task(bridge.ucus_durdur(self.flights[e['id']], 'karsilasma_ayrildi'))
        self._yay({'t': 'match', 'match': self.anlik()})
        self.kaydet()

    def _durum_yan_etkisi(self, st):
        if st == core.HAZIRLIK:
            for o in self.k.aktifler():
                asyncio.get_running_loop().create_task(self._oturum_ac(o))
        elif st in core.SON_DURUMLAR:
            self.bitti_t = time.time()
            bridge.MAC_REZERV.pop(self.id, None)
            if self._kapanis is None:
                self._kapanis = asyncio.get_running_loop().create_task(self._oturumlari_kapat())

    def _rezerv_dus(self):
        n = bridge.MAC_REZERV.get(self.id)
        if n is None:
            return
        if n <= 1:
            bridge.MAC_REZERV.pop(self.id, None)
        else:
            bridge.MAC_REZERV[self.id] = n - 1

    async def _oturum_ac(self, o):
        """Oyuncunun yarış uçuşu: kurucunun dronu + parkuru, oyuncunun varsayılan pilotu, kendi başlangıç noktası. Hata → oyuncu düşer."""
        k, st = self.k, self.settings
        drone, track = dict(st['drone']), dict(st['track'])
        tip = ctip(drone['type'])
        try:
            n = len(k.aktifler())
            w = db.j(track.get('world')) if isinstance(track.get('world'), str) else (track.get('world') or {})
            if k.tur == core.TUR_IT:   # HEPGO §41: rol başına (kaçan önde)
                x, y, yaw = core.it_baslangiclari(self.cfg, tip, float(w.get('runway_heading') or 0))[o.rol or core.KOVALAYAN]
            else:
                noktalar = core.baslangic_noktalari(n, tip, float(w.get('runway_heading') or 0), hedef=(k.halkalar[0]['x'], k.halkalar[0]['y']) if k.halkalar else None)
                x, y, yaw = noktalar[(o.sira_no or 0) % len(noktalar)]
            lat, lon = core.latlon(self.merkez['lat'], self.merkez['lon'], x, y)
            o.baslangic = {'x': round(x, 1), 'y': round(y, 1), 'lat': round(lat, 7), 'lon': round(lon, 7), 'yaw_deg': round(yaw, 1)}

            def oku():
                with db.connect() as conn:
                    u = db.row(conn.execute('SELECT * FROM users WHERE id = ?', (o.uid,)))
                    p = db.row(conn.execute('SELECT * FROM pilots WHERE user_id = ? ORDER BY is_default DESC, id LIMIT 1', (o.uid,)))
                    return u, p
            u, pilot = await asyncio.get_running_loop().run_in_executor(None, oku)
            if u is None:
                raise H(404, 'not_found', 'Hesap bulunamadı')
            if pilot is None:
                raise H(409, 'no_pilot', 'Pilot kaydı yok (Mürettebat\'tan bir pilot ekleyin)')
            out = await bridge.ucus_baslat(u, pilot, drone, track, None, st.get('launch') or {'method': 'wheels'}, {'bin': True}, None, camera=st.get('camera'),
                                           start={'lat': lat, 'lon': lon, 'yaw_deg': None if tip in core.UCAK_TIPLER else yaw}, match_id=self.id)
        except bridge.BridgeHata as e:
            self._rezerv_dus()
            self.isle(k.dusur(o.uid, time.time(), f'Simülatör açılamadı: {e.message}'))
            return
        except Exception as e:   # noqa: BLE001
            self._rezerv_dus()
            self.isle(k.dusur(o.uid, time.time(), f'Simülatör açılamadı: {e}'))
            return
        self._rezerv_dus()
        s = flightsim.MANAGER.get(out['sim_id'])
        if s is None or k.durum in core.SON_DURUMLAR or o.durum in core.KATILMAYAN:
            await bridge.ucus_durdur(out['flight_id'], 'karsilasma_bitti')
            return
        if not self.alt_ok:
            # Halka yükseklikleri SITL ev irtifasıyla AYNI kaynaktan (gerçek arazi: terrarium; yoksa çekirdeğin varsayılanı): ilk oturumdan düzeltilir
            alt0 = s.center.get('alt')
            alt0 = float(alt0) if alt0 is not None else float(flightsim.EV_IRTIFA)
            self.alt_ok = True
            if abs(alt0 - float(self.merkez.get('alt') or 0)) > 0.01 and k.durum in (core.HAZIRLIK, core.LOBI):
                self.merkez['alt'] = alt0
                k.merkez['alt'] = alt0
                if k.tur == core.TUR_HALKA:
                    k.halkalar = core.halkalar_uret(self.cfg, self.merkez)
                self.halkalar = k.halkalar
        self.sessions[o.uid] = s
        self.flights[o.uid] = out['flight_id']
        k.oturum_bagla(o.uid, s.id)
        s.tele_kanca = lambda tele, uid=o.uid, ss=s: self._tele(uid, ss, tele)
        s.komut_kapisi = self._kapi
        self.isle([{'t': 'player', 'id': o.uid, 'status': o.durum, 'session_id': s.id, 'flight_id': out['flight_id']}])

    def _kapi(self, ad):
        if ad == 'reset':   # HEPGO §41: it dalaşında (geri sayım + yarış) Sıfırla yok (başlangıca ışınlanma); halka yarışında serbest
            k = self.k
            return 'İt dalaşında Sıfırla yok' if k is not None and k.tur == core.TUR_IT and k.durum in (core.GERI_SAYIM, core.YARIS) else None
        if self.k is not None and self.k.durum == core.YARIS:
            return None
        if self.bitti():
            return 'Karşılaşma bitti'
        if ad == 'rc':
            return 'Yarış başlamadı'
        return 'Yarış henüz başlamadı: geri sayımı bekleyin'

    def _tele(self, uid, s, tele):
        k = self.k
        o = k.oyuncu(uid) if k is not None else None
        if o is None:
            return
        # Yükseklik: ortak ev irtifası (merkez; tüm oyuncu SITL'leri aynı) + eve göre yükseklik — halkaların alt_msl'iyle aynı ölçek (sahte kipte
        # tele.alt_msl eve göre gelir; gerçek SITL'de ikisi eşittir)
        rel = tele.get('alt_rel')
        alt = float(self.merkez.get('alt') or 0) + float(rel) if rel is not None else tele.get('alt_msl')
        o.poz = {'lat': tele.get('lat'), 'lon': tele.get('lon'), 'alt_msl': alt, 'alt_rel': rel, 'yaw': tele.get('yaw'),
                 'roll': tele.get('roll'), 'pitch': tele.get('pitch'), 'gs': tele.get('groundspeed'), 'armed': bool(tele.get('armed'))}
        try:
            n = len(getattr(s.gorev, 'crashes', []) or [])
            if n > o.carpisma and k.tur == core.TUR_IT:   # HEPGO §41: kesin çarpışma kaydı → çarpan kaybeder
                o.carpisma = n
                self.isle(k.carpti(uid, time.time()))
            o.carpisma = n
        except Exception:   # noqa: BLE001
            pass
        if k.durum == core.YARIS and tele.get('lat') is not None:
            self.isle(k.konum(uid, tele['lat'], tele['lon'], float(alt or 0), time.time(), tele.get('groundspeed'), heading=tele.get('heading'), pitch=tele.get('pitch')))

    def pos_cercevesi(self, now):
        p = []
        for o in self.k.oyuncular.values():
            if o.poz is None or o.durum in core.KATILMAYAN:
                continue
            iz = o.iz
            p.append({'id': o.uid, **{k: (round(v, 7) if k in ('lat', 'lon') else round(v, 3)) if isinstance(v, float) else v for k, v in o.poz.items()},
                      'rings': len(iz.gecisler) if iz else 0, 'next': (iz.sira + 1) if iz and not iz.bitti else None,
                      'dist': round(iz.mesafe, 1) if iz and iz.mesafe is not None else None})
        out = {'t': 'pos', 'ts': round(now, 3), 'p': p}
        if self.k.tur == core.TUR_IT:   # HEPGO §41 HUD
            out['df'] = self.k.it_durum()
        return out

    # ---------------------------------------------------------------- döngü
    async def run(self):
        aralik = 1.0 / POS_HZ
        son_lobi = 0.0
        try:
            while True:
                await asyncio.sleep(aralik)
                now = time.time()
                k = self.k
                if k is None:
                    if self._durum == core.LOBI and now - son_lobi >= 1.0:
                        son_lobi = now
                        self._lobi_denetle(now)
                else:
                    self.isle(k.tik(now))
                    if k.durum == core.HAZIRLIK:
                        for o in list(k.aktifler()):
                            s = self.sessions.get(o.uid)
                            if s is None:
                                continue
                            if s.state in ('HATA', 'KAPANDI'):
                                self.isle(k.dusur(o.uid, now, (s.sitl or {}).get('error') or 'Simülatör kapandı'))
                            elif s.state == 'HAZIR' and o.uid in self.ready and o.durum == core.HAZIRLANIYOR:
                                self.isle(k.hazir(o.uid, now))
                    elif k.durum in (core.GERI_SAYIM, core.YARIS):
                        for o in list(k.aktifler()):
                            s = self.sessions.get(o.uid)
                            if s is not None and s.state == 'KAPANDI':
                                self.isle(k.ayril(o.uid, now) if k.durum == core.YARIS else k.dusur(o.uid, now, 'Simülatör kapandı'))
                        if self.k.durum in (core.GERI_SAYIM, core.YARIS):
                            self._yay(self.pos_cercevesi(now))
                if self.bitti() and now - (self.bitti_t or now) > BELLEK_TUT_S:
                    break
        except asyncio.CancelledError:
            pass
        finally:
            if not self.bitti():
                self.iptal('sunucu_kapaniyor')
            await self._oturumlari_kapat(0)
            bridge.MAC_REZERV.pop(self.id, None)
            self.yon.cikar(self)

    def _lobi_denetle(self, now):
        """Lobi temizliği: 30 dk'da başlamayan lobi iptal; kurucu MATCH_ABANDON_S görünmezse iptal (terk); görünmeyen davetli düşer."""
        if now - self.olusturma_t > core.LOBI_ZAMAN_ASIMI_S:
            return self.iptal('zaman_asimi', now)
        on = self.cevrimici(now)
        if self.host_id not in on and now - self.lobi[self.host_id].get('seen_t', 0) > config.MATCH_ABANDON_S:
            return self.iptal('terk_edildi', now)
        dusen = [uid for uid, p in self.lobi.items() if not p['host'] and uid not in on and now - p.get('seen_t', 0) > config.MATCH_ABANDON_S]
        for uid in dusen:
            self.lobi.pop(uid, None)
        if dusen:
            self.degisti()

    async def _oturumlari_kapat(self, gecikme=KAPANIS_GECIKME_S):
        if gecikme:
            await asyncio.sleep(gecikme)
        for uid, s in list(self.sessions.items()):
            s.tele_kanca = None
        for uid, fid in list(self.flights.items()):
            try:
                await bridge.ucus_durdur(fid, 'karsilasma_bitti')
            except Exception:   # noqa: BLE001
                pass

    # ---------------------------------------------------------------- kayıt
    def kaydet(self):
        k = self.k
        if k is not None:
            sira = {p['id']: p for p in (k.sonuc()['standings'] if k.durum == core.BITTI else [])}
            oyuncular = [(o.uid, o.ad, int(o.kurucu), o.durum, self.flights.get(o.uid), (sira.get(o.uid) or {}).get('rank'),
                          len(o.iz.gecisler) if o.iz else 0, (sira.get(o.uid) or {}).get('time_s')) for o in k.oyuncular.values()]
            d = {'state': k.durum, 'reason': k.neden, 'rings': json.dumps(k.halkalar or [], ensure_ascii=False),
                 'result': json.dumps(k.sonuc(), ensure_ascii=False) if k.durum == core.BITTI else None, 'winner_id': k.kazanan,
                 'started_at': _iso(k.baslangic_t) if k.durum in (core.YARIS, core.BITTI) else None, 'ended_at': _iso(k.bitis_t) if k.bitis_t else None}
        else:
            oyuncular = [(p['id'], p['name'], int(p['host']), core.GELDI, None, None, 0, None) for p in self.lobi.values()]
            d = {'state': self._durum, 'reason': self.neden, 'rings': json.dumps(self.halkalar, ensure_ascii=False), 'result': None, 'winner_id': None,
                 'started_at': None, 'ended_at': _iso(self.bitis_t) if self.bitis_t else None}
        mid, t = self.id, db.now()

        def yaz():
            with db.connect() as conn:
                conn.execute('UPDATE matches SET state = ?, reason = ?, rings = ?, result = ?, winner_id = ?, started_at = COALESCE(?, started_at), ended_at = ? WHERE id = ?',
                             (d['state'], d['reason'], d['rings'], d['result'], d['winner_id'], d['started_at'], d['ended_at'], mid))
                ids = [o[0] for o in oyuncular]
                conn.execute(f"DELETE FROM match_players WHERE match_id = ? AND user_id NOT IN ({','.join('?' * len(ids))})", (mid, *ids))
                for uid, ad, kur, durum, fid, rank, rings, time_s in oyuncular:
                    conn.execute('INSERT INTO match_players (match_id, user_id, name, is_host, status, flight_id, rank, rings, time_s, joined_at) VALUES (?,?,?,?,?,?,?,?,?,?) '
                                 'ON CONFLICT(match_id, user_id) DO UPDATE SET status = excluded.status, flight_id = COALESCE(excluded.flight_id, match_players.flight_id), '
                                 'rank = excluded.rank, rings = excluded.rings, time_s = excluded.time_s', (mid, uid, ad, kur, durum, fid, rank, rings, time_s, t))
                conn.commit()
        try:
            asyncio.get_running_loop().run_in_executor(None, yaz)
        except RuntimeError:
            yaz()


# ---------------------------------------------------------------- yönetici
class Yonetici:
    def __init__(self):
        self.matches = {}
        self.kodlar = {}
        self._kurtarildi = False

    def kurtar(self):
        """İlk erişimde bir kez: bitmemiş satırlar IPTAL (bellek kayboldu), eski şifre denemeleri silinir."""
        if self._kurtarildi:
            return
        self._kurtarildi = True
        try:
            with db.connect() as conn:
                ids = [r[0] for r in conn.execute("SELECT id FROM matches WHERE state NOT IN ('BITTI', 'IPTAL')") if r[0] not in self.matches]
                if ids:
                    conn.execute(f"UPDATE matches SET state = 'IPTAL', reason = 'sunucu_yeniden_basladi', ended_at = ? WHERE id IN ({','.join('?' * len(ids))})", [db.now(), *ids])
                conn.execute('DELETE FROM match_attempts WHERE ts < ?', (time.time() - 86400,))
                conn.commit()
        except Exception:   # noqa: BLE001
            pass

    def get(self, mid):
        try:
            return self.matches.get(int(mid))
        except (TypeError, ValueError):
            return None

    def kod_ile(self, code):
        mid = self.kodlar.get(str(code or ''))
        return self.matches.get(mid) if mid is not None else None

    def cikar(self, m):
        if self.matches.get(m.id) is m:
            self.matches.pop(m.id, None)
            self.kodlar.pop(m.code, None)

    def kullanici_maci(self, uid):
        """Kullanıcının bitmemiş (katıldığı) karşılaşması ya da None."""
        for m in self.matches.values():
            if m.aktif_oyuncu_mu(uid):
                return m
        return None

    def acik_sayisi(self):
        return sum(1 for m in self.matches.values() if not m.bitti())

    async def olustur(self, user, drone, track, launch, camera, cfg, sifre, max_players, request_ip=None, tur=core.TUR_HALKA):
        self.kurtar()
        uid = int(user['id'])
        m0 = self.kullanici_maci(uid)
        if m0 is not None:
            raise H(409, 'match_open', 'Zaten bitmemiş bir karşılaşmanız var; önce ondan ayrılın', match_id=m0.id)
        if self.acik_sayisi() >= config.MATCH_MAX_OPEN:
            raise H(429, 'server_full', 'Sunucuda çok sayıda açık karşılaşma var; biraz sonra yeniden deneyin', retry_after=60)
        cfg = dict(cfg)
        if not cfg.get('seed'):
            cfg['seed'] = secrets.randbelow(2 ** 31 - 2) + 1
        merkez = {'lat': float(track['lat']), 'lon': float(track['lon']), 'alt': 0.0}   # alt: ilk oyuncu oturumunun ev irtifasıyla düzeltilir
        it = tur == core.TUR_IT
        if it:
            max_players = 2   # HEPGO §41: it dalaşı tam 2 oyuncu
        halkalar = [] if it else core.halkalar_uret(cfg, merkez)
        settings = {'drone': {k: drone.get(k) for k in ('id', 'user_id', 'name', 'type', 'model_key', 'params', 'color', 'airframe', 'power')},
                    'track': {**{k: track.get(k) for k in ('id', 'user_id', 'name', 'lat', 'lon', 'alt_mode', 'radius_m', 'wind', 'time_of_day', 'weather', 'world_mode', 'world')},
                              'gates': '[]'},   # FPV halkaları karşılaşmada yok (yarış halkaları çekirdekten)
                    'launch': launch, 'camera': camera}
        loop = asyncio.get_running_loop()
        ozet = await loop.run_in_executor(None, sifre_ozet, sifre)
        code = secrets.token_urlsafe(16)
        now = time.time()

        def ekle():
            with db.connect() as conn:
                mid = conn.execute('INSERT INTO matches (code, host_id, pass_hash, state, max_players, settings, rings_cfg, rings, created_at, kind, game_cfg) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
                                   (code, uid, ozet, core.LOBI, int(max_players), json.dumps(settings, ensure_ascii=False, default=str), '{}' if it else json.dumps(cfg),
                                    json.dumps(halkalar), db.now(), tur, json.dumps(cfg) if it else None)).lastrowid
                db.audit(conn, 'match_create', uid, request_ip, f"match {mid} {drone.get('type')} · {track.get('name')} · " + ('it dalaşı' if it else f"{cfg['count']} halka") + f" · ≤ {max_players} oyuncu")
                conn.commit()
                return mid
        mid = await loop.run_in_executor(None, ekle)
        m = Mac(self, mid, code, user, ozet, max_players, settings, cfg, merkez, halkalar, now, tur=tur)
        self.matches[mid] = m
        self.kodlar[code] = mid
        m.kaydet()
        m.task = loop.create_task(m.run())
        return m

    async def kapat_hepsi(self):
        for m in list(self.matches.values()):
            if m.task is not None and not m.task.done():
                m.task.cancel()
                try:
                    await asyncio.wait_for(asyncio.shield(m.task), 40)
                except (asyncio.CancelledError, asyncio.TimeoutError, Exception):   # noqa: BLE001
                    pass
        self.matches.clear()
        self.kodlar.clear()


# ---------------------------------------------------------------- şifre denemeleri (kaba kuvvet)
def deneme_denetle(conn, mid, uid, ip, now=None):
    """Sınır aşıldıysa BridgeHata 429 (retry_after). Dönüş: kullanıcının bu karşılaşmadaki kalan hakkı."""
    now = now or time.time()
    w = now - DENEME_PENCERE_S
    q = lambda sql, *a: conn.execute(sql, a).fetchone()   # noqa: E731
    ku = q('SELECT COUNT(*), MIN(ts) FROM match_attempts WHERE match_id = ? AND user_id = ? AND ok = 0 AND ts > ?', mid, uid, w)
    ipn = q('SELECT COUNT(*), MIN(ts) FROM match_attempts WHERE ip = ? AND ok = 0 AND ts > ?', ip or '-', w)
    mn = q('SELECT COUNT(*), MIN(ts) FROM match_attempts WHERE match_id = ? AND ok = 0 AND ts > ?', mid, w)
    for (n, ilk), sinir in ((ku, DENEME_KULLANICI), (ipn, DENEME_IP), (mn, DENEME_MAC)):
        if n >= sinir:
            retry = max(1, int((ilk or now) + DENEME_PENCERE_S - now) + 1)
            raise H(429, 'too_many_attempts', f'Çok fazla hatalı şifre denemesi; {max(1, retry // 60)} dk sonra yeniden deneyin', retry_after=retry)
    return DENEME_KULLANICI - ku[0]


def deneme_yaz(conn, mid, uid, ip, ok):
    conn.execute('INSERT INTO match_attempts (match_id, user_id, ip, ok, ts) VALUES (?,?,?,?,?)', (mid, uid, ip or '-', 1 if ok else 0, time.time()))


def satir_dict(r, uid=None):
    """DB satırı (bellekte olmayan karşılaşma) → GET biçimi."""
    j = lambda v, d=None: json.loads(v) if v else d   # noqa: E731
    st = j(r['settings'], {})
    with db.connect() as conn:
        ps = db.rows(conn.execute('SELECT * FROM match_players WHERE match_id = ? ORDER BY is_host DESC, joined_at', (r['id'],)))
    res = j(r.get('result'))
    kind = r.get('kind') or core.TUR_HALKA
    return {'id': r['id'], 'code': r['code'] if r['state'] not in core.SON_DURUMLAR else None, 'state': r['state'], 'reason': r['reason'], 'host_id': r['host_id'],
            'max_players': r['max_players'], 'settings': ayar_ozeti(st), 'rings_cfg': j(r.get('game_cfg'), {}) if kind == core.TUR_IT else j(r['rings_cfg'], {}), 'rings': j(r['rings'], []), 'kind': kind,
            'players': [{'id': p['user_id'], 'name': p['name'], 'host': bool(p['is_host']), 'status': p['status'], 'flight_id': p['flight_id'] if p['user_id'] == uid else None,
                         'rank': p['rank'], 'rings': p['rings'], 'time_s': p['time_s'],
                         'role': ((res or {}).get('dogfight') or {}).get('roles', {}).get(str(p['user_id']))} for p in ps],
            'result': res, 'winner': r['winner_id'], 'created_at': r['created_at'], 'started_at': r['started_at'], 'ended_at': r['ended_at'], 'live': False,
            'can_start': False, 'now': time.time()}


MANAGER = Yonetici()
