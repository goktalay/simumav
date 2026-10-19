"""Sanal dron = gerçek ArduPilot SITL süreci (GÖKTUNGU sitl.py v2.4.39+ birebir, Linux yolu).

Kullanıcı kararı (GÖKTUNGU'dan): "sanal dron oluşturduğumuzda aslında her dronda SITL oluşturacağız". Sanal dron bir taklit
değildir; her sanal dron gerçek bir arducopter / arduplane sürecidir. Parametreler, ARM denetimleri, uçuş modları, iniş ve
dönüş kinematiği, görev davranışı gerçek uçuş yazılımından gelir.

Bu modül yalnız süreç yaşam döngüsünü yönetir (ikiliyi bulmak/indirmek, boş port bloğu seçmek, başlatmak/durdurmak, çıkış
nedenini raporlamak). MAVLink tarafında özel dal yoktur: hub (drone_hub.SitlDrone) SITL'in SERIAL0 TCP portuna Hepgo Dron
Köprüsü'nün çekirdeğiyle (kopru_core.MavLink) bağlanır; yani sanal dron gerçek köprüyle AYNI kod yolundan uçar.

GÖKTUNGU'da ölçülmüş tuzaklar (sitl.py başlığı):
  A. `--defaults /dev/null` SITL'i "PANIC: Failed to load defaults" ile çökertir → her örnek için gerçek .parm yazılır.
  B. SITL taban porttan itibaren bir PORT BLOĞU bağlar (SERIAL0=base, SERIAL1=base+2, SERIAL2=base+3 …); bloğun herhangi bir
     üyesi doluysa "bind failed" + çıkış 1 → tek port değil blok boşluğu denetlenir.
  C. `--base-port`, `-I/--instance`'tan ÖNCE gelmeli (burada -I hiç kullanılmaz).
  D. SITL ~10–14 sn'de ayağa kalkar ve SERIAL0'a istemci bağlanana dek bekler → bağlanma yeniden denemeli.
  E. Her örnek kendi çalışma dizinine ihtiyaç duyar (eeprom.bin, loglar).
  F. (HEPGO ölçümü) SERIAL0'daki istemci bağlantıyı kapatınca SITL "Exitting" ile kendini kapatır → hub bağlantıyı açık tutar.
"""
import hashlib
import os
import socket
import subprocess
import threading
import time
import urllib.request
from pathlib import Path

from . import config

# Ortak ikili klasörü (tüm kiracılar paylaşır; ilk kullanımda indirilir). HEPGO_SITL_DIR ile değiştirilebilir.
SITL_KLASORU = Path(os.environ.get('HEPGO_SITL_DIR') or (config.BASE_DIR / 'data' / 'sitl'))
# Her sanal dronun kendi çalışma dizini (eeprom.bin, sitl.log) — kiracının veri dizininde
CALISMA_KOKU = config.DATA_DIR / 'sitl_calisma'

# Dron tipi → (ikili adı, --model değeri) (GÖKTUNGU TIP_ESLEME). Heli/hexa ayrı ikili istemez, yalnız --model değişir.
TIP_ESLEME = {
    'multirotor': ('arducopter', '+'),
    'hexarotor': ('arducopter', 'hexa'),
    'helikopter': ('arducopter', 'heli'),
    'sabit_kanat': ('arduplane', 'plane'),
    'vtol': ('arduplane', 'quadplane'),
}
# Sürüm SABİTLENİR (GÖKTUNGU 'stable/' kullanıyordu; eş oturum önerisi: sürüm klasörü + sha kaydı)
SURUM = {'arducopter': ('Copter', 'stable-4.7.2'), 'arduplane': ('Plane', 'stable-4.7.2')}
INDIRME = 'https://firmware.ardupilot.org/{arac}/{surum}/SITL_x86_64_linux_gnu/{ikili}'

SANAL_PORT_BASI = 15670      # GÖKTUNGU baglantilar.SANAL_PORT_BASI
PORT_ADIM = 10               # her örnek kendi 10'luk bloğu
EV_IRTIFA = 100.0            # --home irtifası (GÖKTUNGU varsayılanı)


def model_tipi(model):
    """Dron kaydının model metninden SITL tipi (tanımsızsa çok rotorlu)."""
    m = str(model or '').lower()
    if 'vtol' in m or 'quadplane' in m:
        return 'vtol'
    if 'kanat' in m or 'plane' in m or 'uçak' in m:
        return 'sabit_kanat'
    if 'heli' in m:
        return 'helikopter'
    if 'hexa' in m or 'hekza' in m:
        return 'hexarotor'
    return 'multirotor'


def ikili_yolu(tip):
    ikili = TIP_ESLEME.get(tip, TIP_ESLEME['multirotor'])[0]
    return SITL_KLASORU / ikili


def _elf_mi(yol):
    try:
        with open(yol, 'rb') as f:
            bas = f.read(20)
        return bas[:4] == b'\x7fELF' and bas[4] == 2 and int.from_bytes(bas[18:20], 'little') == 62   # 64-bit, x86-64
    except OSError:
        return False


_indir_kilit = threading.Lock()
# HEPGO yaması (tools/sitl/0001-sim-srv-rev.patch): SITL parametresi SIM_SRV_REV — "sanal montaj" bit maskesi (bit n-1 = SERVOn ters monteli);
# fizik ilgili kanalın PWM'ini 1500 ekseninde yansıtır → gerçek uçağın SERVOn_REVERSED=1 kaydı SITL'e aynen yazılır ve uçak düzgün uçar.
# Resmi firmware.ardupilot.org ikilisi bu parametreyi tanımaz → `sanal_montaj_destegi` False → drone_params nötr (0) yoluna düşer.
SANAL_MONTAJ_IMZA = b'\x00SRV_REV\x00'   # AP_Param tablo adı (null sonlu); resmi 4.7.2 ikilisinde geçmez (ölçüldü)
# HEPGO yaması 0002 (tools/sitl/0002-sim-pln-thr-mul.patch): SIM_PLN_THR_MUL — plane modeli itki çarpanı (azami hız; flightsim_power)
HIZ_OLCEGI_IMZA = b'\x00PLN_THR_MUL\x00'
_yetenek_cache = {}


def _imza_destegi(tip, imza):
    """İkili verilen AP_Param adını tanıyor mu? İkili dosyasında null sonlu ad aranır (ELF .rodata; 7 MB, ~10 ms; yol+mtime+boyut ile
    önbellek). İkili yoksa (ilk kullanımda indirilecek resmi sürüm) False."""
    yol = ikili_yolu(tip)
    try:
        st = yol.stat()
    except OSError:
        return False
    anahtar = (str(yol), st.st_mtime_ns, st.st_size, imza)
    with _indir_kilit:
        if anahtar in _yetenek_cache:
            return _yetenek_cache[anahtar]
    try:
        with open(yol, 'rb') as f:
            destek = imza in f.read()
    except OSError:
        destek = False
    with _indir_kilit:
        for k in [k for k in _yetenek_cache if k[0] == str(yol) and (k[1], k[2]) != (st.st_mtime_ns, st.st_size)]:
            _yetenek_cache.pop(k, None)   # aynı yolun eski sürüm girdileri
        _yetenek_cache[anahtar] = destek
    return destek


def sanal_montaj_destegi(tip):
    """İkili SIM_SRV_REV (sanal servo montajı) parametresini tanıyor mu?"""
    return _imza_destegi(tip, SANAL_MONTAJ_IMZA)


def hiz_olcegi_destegi(tip):
    """İkili SIM_PLN_THR_MUL (plane itki çarpanı; azami hız §23) parametresini tanıyor mu? Yalnız uçak tiplerinde anlamlı."""
    if tip not in ('sabit_kanat', 'vtol'):
        return False
    return _imza_destegi(tip, HIZ_OLCEGI_IMZA)


def indir(tip, konsol=None):
    """İkiliyi ArduPilot firmware sunucusundan indirir (sabit sürüm). Dönüş: (yol | None, hata)."""
    ikili = TIP_ESLEME.get(tip, TIP_ESLEME['multirotor'])[0]
    hedef = SITL_KLASORU / ikili
    with _indir_kilit:
        if hedef.is_file() and _elf_mi(hedef):
            return hedef, None
        arac, surum = SURUM[ikili]
        url = INDIRME.format(arac=arac, surum=surum, ikili=ikili)
        try:
            SITL_KLASORU.mkdir(parents=True, exist_ok=True)
            gecici = hedef.with_suffix('.indiriliyor')
            if konsol:
                konsol(f'SITL ikilisi indiriliyor: {ikili} ({surum})', 'uyari')
            h = hashlib.sha256()
            with urllib.request.urlopen(url, timeout=120) as r, open(gecici, 'wb') as f:   # noqa: S310 — sabit https adresi
                while True:
                    blok = r.read(262144)
                    if not blok:
                        break
                    f.write(blok)
                    h.update(blok)
            if not _elf_mi(gecici):
                gecici.unlink(missing_ok=True)
                return None, f'İndirilen dosya Linux x86-64 SITL ikilisi değil ({url})'
            os.chmod(gecici, 0o755)
            os.replace(gecici, hedef)
            (SITL_KLASORU / f'{ikili}.sha256').write_text(f'{h.hexdigest()}  {ikili}  {surum}\n')
            if konsol:
                konsol(f'SITL ikilisi indirildi: {ikili} {surum} sha256 {h.hexdigest()[:16]}…', 'basari')
            return hedef, None
        except Exception as e:   # noqa: BLE001
            return None, f'SITL ikilisi indirilemedi: {e}'


def _port_bos_mu(port):
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        s.bind(('127.0.0.1', port))
        return True
    except OSError:
        return False
    finally:
        s.close()


def blok_bos_mu(taban, genislik=10):
    return all(_port_bos_mu(taban + i) for i in range(genislik))


def bos_taban_port(baslangic, adim=PORT_ADIM, deneme=200, kullanilan=()):
    for i in range(deneme):
        p = baslangic + i * adim
        if p in kullanilan:
            continue
        if blok_bos_mu(p):
            return p
    return None


def parm_metni(sysid, log_bin=False, ekstra=None):
    """SITL `--defaults` dosyası içeriği (Tuzak A). `log_bin`: DataFlash .BIN kaydı (LOG_BACKEND_TYPE 1 = dosya) yalnız armed süre
    (LOG_DISARMED 0) ve disarm'da dosya kapanır/döner (LOG_FILE_DSRMROT 1) → oturum kapanışında son .BIN uçuş loglarına kaydedilir
    (flightsim_bin). Kapalıyken kayıt tamamen kapalı: GÖKTUNGU'da tek sanal dron 43 GB .BIN üretmişti.
    `ekstra`: dronun KAYITLI parametreleri (`AD DEĞER` satırları; drone_params.parm_satirlari) — HEPGO varsayılanlarından SONRA yazılır
    (aynı ad varsa son satır geçerli); simülatör oturum parametreleri kalp atışında PARAM_SET ile sonra gelir."""
    satirlar = [
        'FRAME_CLASS 1',            # çok rotorlu için anlamlı; plane'de yok sayılır
        'FS_GCS_ENABLE 0',          # GCS kalp atışı kaybı failsafe'i test akışını bozmasın
        f'MAV_SYSID {int(sysid)}',  # eeprom'daki eski değere karşı komut satırıyla birlikte
        'ARMING_SKIPCHK 16',        # yalnız INS biti ("PreArm: 3D Accel calibration needed"; ARMING_CHECK bu sürümde yok)
    ]
    if log_bin:
        satirlar += ['LOG_BACKEND_TYPE 1', 'LOG_DISARMED 0', 'LOG_FILE_DSRMROT 1']
    else:
        satirlar += ['LOG_BACKEND_TYPE 0', 'LOG_DISARMED 0']
    if ekstra:
        satirlar += ['# HEPGO kayitli parametreler (drone_sitl_params)'] + [str(s).strip() for s in ekstra if str(s).strip()]
    return '\n'.join(satirlar) + '\n'


def calisma_dizini(kimlik):
    return CALISMA_KOKU / str(int(kimlik))


def bin_dosyalari(kimlik):
    """Örneğin çalışma dizinindeki DataFlash dosyaları (`logs/*.BIN`), boyuta göre büyükten küçüğe."""
    logs = calisma_dizini(kimlik) / 'logs'
    if not logs.is_dir():
        return []
    out = [f for f in logs.iterdir() if f.is_file() and f.suffix.upper() == '.BIN']
    out.sort(key=lambda f: (f.stat().st_size, f.stat().st_mtime), reverse=True)
    return out


def bin_temizle(kimlik):
    for f in bin_dosyalari(kimlik):
        f.unlink(missing_ok=True)


TERRAIN_DAT_LIMIT = int(os.environ.get('SITL_TERRAIN_DAT_MB', '64')) * 1024 * 1024   # çalışma dizini `terrain/*.DAT` toplam üst sınırı


def terrain_temizle(kimlik, limit=None):
    """ArduPilot arazi önbelleği (`terrain/N39E033.DAT`, 1°×1° başına bir dosya; GCS/HEPGO TERRAIN_DATA ile dolar) oturumlar arası KALIR — aynı
    bölgede yeni oturum arazi bloklarını yeniden istemez. Toplam `limit` (varsayılan 64 MB) aşılırsa en eski erişilenler silinir. Dönüş: silinen sayısı."""
    limit = TERRAIN_DAT_LIMIT if limit is None else int(limit)
    dizin = calisma_dizini(kimlik) / 'terrain'
    if not dizin.is_dir():
        return 0
    dosyalar = []
    for f in dizin.iterdir():
        if f.is_file() and f.suffix.upper() == '.DAT':
            try:
                st = f.stat()
                dosyalar.append((st.st_mtime, st.st_blocks * 512, f))   # seyrek dosya: gerçek disk kullanımı
            except OSError:
                pass
    dosyalar.sort()
    toplam, silinen = sum(d[1] for d in dosyalar), 0
    for _, boyut, f in dosyalar:
        if toplam <= limit:
            break
        try:
            f.unlink()
            toplam -= boyut
            silinen += 1
        except OSError:
            pass
    return silinen


class SitlYoneticisi:
    """Kiracı başına SITL süreçleri: kimlik (drone_id) → Popen."""

    def __init__(self, konsol=None):
        self.konsol = konsol or (lambda metin, sev='bilgi': None)
        self._kilit = threading.Lock()
        self._surecler = {}
        self._bilgi = {}

    def calisiyor_mu(self, kimlik):
        with self._kilit:
            p = self._surecler.get(int(kimlik))
        return bool(p and p.poll() is None)

    def bilgi(self, kimlik):
        with self._kilit:
            return dict(self._bilgi.get(int(kimlik)) or {})

    def baslat(self, kimlik, tip, lat, lon, sysid, irtifa=None, konsol=None, model=None, log_bin=False, ekstra_parm=None):
        """SITL sürecini başlatır. Dönüş: (port, hata) — başarısızsa port None. Bloklar (~2 sn): iş parçacığında çağrılır.
        `model`: `--model` değerini geçersiz kılar (ör. uçuş simülatörü rampa kalkışı için 'plane-catapult'; TIP_ESLEME değişmez).
        `log_bin`: DataFlash .BIN kaydı açık (uçuş simülatörü "Uçuş logunu kaydet"; docs/ucus-simulatoru.md §19) — yalnız armed süre.
        `ekstra_parm`: dronun kayıtlı parametreleri (`AD DEĞER` satırları) → varsayilan.parm sonuna (drone_params)."""
        kimlik = int(kimlik)
        konsol = konsol or self.konsol
        if self.calisiyor_mu(kimlik):
            return self.bilgi(kimlik).get('port'), None
        yol, hata = indir(tip, konsol)
        if not yol:
            return None, hata
        model = model or TIP_ESLEME.get(tip, TIP_ESLEME['multirotor'])[1]
        with self._kilit:
            mesgul = {(v or {}).get('port') for v in self._bilgi.values()}
        port = bos_taban_port(SANAL_PORT_BASI, kullanilan=mesgul)   # Tuzak B
        if port is None:
            return None, 'Boş SITL port bloğu bulunamadı. Çalışan sanal dronları durdurup yeniden deneyin.'
        dizin = CALISMA_KOKU / str(kimlik)   # Tuzak E
        try:
            dizin.mkdir(parents=True, exist_ok=True)
        except OSError as e:
            return None, f'SITL çalışma dizini oluşturulamadı: {e}'
        parm = dizin / 'varsayilan.parm'     # Tuzak A: gerçek defaults dosyası
        try:
            parm.write_text(parm_metni(sysid, log_bin, ekstra_parm), encoding='utf-8')
        except OSError as e:
            return None, f'SITL varsayılan parametre dosyası yazılamadı: {e}'
        bin_temizle(kimlik)   # önceki oturumun .BIN artıkları (kaydedilmişse zaten taşındı)
        terrain_temizle(kimlik)   # arazi .DAT önbelleği kalır; yalnız disk sınırı aşılırsa en eskiler silinir (§18)
        yuk = float(irtifa if irtifa is not None else EV_IRTIFA)
        komut = [str(yol), '--model', model, '--home', f'{float(lat):.7f},{float(lon):.7f},{yuk:.1f},0',
                 '--base-port', str(port), '--defaults', str(parm), '--sysid', str(int(sysid))]
        try:
            log = open(dizin / 'sitl.log', 'w', encoding='utf-8')   # noqa: SIM115 — süreç ömrü boyunca açık
        except OSError:
            log = subprocess.DEVNULL
        try:
            p = subprocess.Popen(komut, cwd=str(dizin), stdout=log, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL,
                                 start_new_session=True)
        except OSError as e:
            return None, f'SITL başlatılamadı: {e}'
        time.sleep(2.0)   # erken çökme (defaults hatası / port çakışması) saniyeler içinde olur
        if p.poll() is not None:
            son = ''
            try:
                satirlar = [s.strip() for s in (dizin / 'sitl.log').read_text(errors='replace').splitlines() if s.strip()]
                son = ' | '.join(satirlar[-3:])
            except OSError:
                pass
            return None, f'SITL hemen sonlandı (çıkış kodu {p.returncode}).' + (f' Log: {son}' if son else '')
        with self._kilit:
            self._surecler[kimlik] = p
            self._bilgi[kimlik] = {'port': port, 'tip': tip, 'model': model, 'dizin': str(dizin), 'pid': p.pid, 'sysid': int(sysid),
                                   'lat': float(lat), 'lon': float(lon), 'ikili': str(yol)}
        konsol(f'Sanal dron başladı: {tip} ({model}) tcp:127.0.0.1:{port} (pid {p.pid})', 'basari')
        return port, None

    def durdur(self, kimlik):
        kimlik = int(kimlik)
        with self._kilit:
            p = self._surecler.pop(kimlik, None)
            self._bilgi.pop(kimlik, None)
        if not p:
            return False
        if p.poll() is None:
            try:
                p.terminate()
                try:
                    p.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    p.kill()
                    p.wait(timeout=5)
            except Exception:   # noqa: BLE001
                pass
        self.konsol(f'Sanal dron durduruldu: id={kimlik}', 'bilgi')
        return True

    def tumunu_durdur(self):
        with self._kilit:
            idler = list(self._surecler)
        for k in idler:
            self.durdur(k)

    def artiklari_temizle(self):
        """Önceki oturumdan kalmış SITL süreçlerini öldürür (yalnız BU kiracının çalışma kökündekiler)."""
        kok = str(CALISMA_KOKU)
        sayi = 0
        try:
            for pid in os.listdir('/proc'):
                if not pid.isdigit():
                    continue
                try:
                    cmd = Path(f'/proc/{pid}/cmdline').read_bytes().decode('utf-8', 'ignore')
                except OSError:
                    continue
                if kok in cmd and ('arducopter' in cmd or 'arduplane' in cmd):
                    try:
                        os.kill(int(pid), 15)
                        sayi += 1
                    except OSError:
                        pass
        except OSError:
            return sayi
        if sayi:
            self.konsol(f'Önceki oturumdan {sayi} artık SITL süreci temizlendi', 'uyari')
        return sayi


YONETICI = SitlYoneticisi()


def kopru_cekirdegi():
    """Hepgo Dron Köprüsü çekirdeği (MAVLink komut yürütücü). Sanal dron gerçek köprüyle aynı kodu kullanır."""
    import importlib.util
    yol = config.BASE_DIR / 'bridge' / 'dron_koprusu' / 'kopru_core.py'
    spec = importlib.util.spec_from_file_location('hepgo_kopru_core', yol)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod
