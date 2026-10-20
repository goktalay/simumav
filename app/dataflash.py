"""ArduPilot DataFlash ikili (.BIN) logu için AKIŞ halinde hızlı okuyucu (numpy).

Neden: pymavlink `DFReader_binary` dosyayı mmap'ler ve Cython indeksleyiciyle HER mesajın ofsetini Python listelerine yazar (700 MB /
~19 M mesajlık 3 saatlik gerçek uçuşta ~1,6 GB RSS), sonra istenen her mesajı Python nesnesine çözer (~2 dk). Bu okuyucu dosyayı
sabit boyutlu bloklarla (varsayılan 16 MB) sırayla okur, mesaj zincirini başlık + FMT uzunluğuyla yürür (bozuk baytlarda pymavlink gibi
bir sonraki `A3 95` başlığına atlar), yalnız İSTENEN tiplerin ofsetlerini toplar ve bunları numpy yapılı dtype ile toplu çözer; istenen
sütunlar dışında hiçbir şey bellekte tutulmaz. İlerleme okunan bayta göre gerçek yüzdedir.

Değerler pymavlink ile aynı ölçektedir (FORMAT_TO_STRUCT: c/C/e/E ×0,01, L ×1e-7; metinler NUL'a kadar, UTF-8 / ISO-8859-1).
Metin (.log) DataFlash ve .tlog bu okuyucunun dışındadır (`ikili_mi` False → çağıran pymavlink yoluna düşer).
"""
import os

import numpy as np

HEAD1, HEAD2 = 0xA3, 0x95
FMT_TIP = 128
FMT_UZUNLUK = 89
BLOK = 16 * 1024 * 1024

# biçim karakteri → (numpy dtype, çarpan)
_DT = {
    'a': ('<i2', 32), 'b': ('i1', None), 'B': ('u1', None), 'g': ('<f2', None), 'h': ('<i2', None), 'H': ('<u2', None),
    'i': ('<i4', None), 'I': ('<u4', None), 'f': ('<f4', None), 'n': ('S4', None), 'N': ('S16', None), 'Z': ('S64', None),
    'c': ('<i2', 0.01), 'C': ('<u2', 0.01), 'e': ('<i4', 0.01), 'E': ('<u4', 0.01), 'L': ('<i4', 1e-7), 'd': ('<f8', None),
    'M': ('u1', None), 'q': ('<i8', None), 'Q': ('<u8', None),
}


# float32 yeterli biçimler (≤ 7 anlamlı basamak; bellek yarıya iner). Zaman (Q), enlem/boylam (L), çift (d), 32 bit tamsayılar float64 kalır.
_KUCUK = set('fgbBhHMcC')


def ikili_mi(path):
    """Dosya ikili DataFlash mı (ilk baytlar A3 95)?"""
    try:
        with open(path, 'rb') as f:
            b = f.read(2)
    except OSError:
        return False
    return len(b) == 2 and b[0] == HEAD1 and b[1] == HEAD2


def sim_isareti(path, bas=4 * 1024 * 1024):
    """SITL (yazılımda simülasyon) logu mu: ArduPilot yalnız SITL derlemesinde `SIM_*` parametrelerini yazar (PARM kayıtları dosyanın
    başında). Gerçek uçuş kartı loglarında bu ad bulunmaz. Dosyanın yalnız ilk `bas` baytı okunur (hızlı; büyük dosyada da ~ms)."""
    try:
        with open(path, 'rb') as f:
            blok = f.read(bas)
    except OSError:
        return None
    if not blok:
        return None
    return b'SIM_SPEEDUP' in blok or b'SIM_RATE_HZ' in blok or blok.count(b'SIM_') >= 5


class _Bicim:
    __slots__ = ('tip', 'ad', 'uzunluk', 'bicim', 'sutunlar', 'dtype', 'carpan')

    def __init__(self, tip, ad, uzunluk, bicim, sutunlar):
        self.tip, self.ad, self.uzunluk, self.bicim, self.sutunlar = tip, ad, uzunluk, bicim, sutunlar
        self.dtype = None
        self.carpan = {}
        alanlar, boy = [], 0
        for i, ch in enumerate(bicim):
            if ch not in _DT or i >= len(sutunlar):
                return
            dt, mul = _DT[ch]
            ad_ = sutunlar[i] or f'_{i}'
            if any(a[0] == ad_ for a in alanlar):
                ad_ = f'{ad_}_{i}'
            if ch == 'a':
                alanlar.append((ad_, '<i2', (32,)))
            else:
                alanlar.append((ad_, dt))
                if mul is not None:
                    self.carpan[ad_] = mul
            boy += np.dtype(alanlar[-1][1]).itemsize * (32 if ch == 'a' else 1)
        if boy + 3 == uzunluk:
            self.dtype = np.dtype(alanlar)


def _metin(b):
    b = bytes(b).split(b'\x00', 1)[0]
    try:
        return b.decode('utf-8')
    except UnicodeDecodeError:
        return b.decode('ISO-8859-1')


SAKIN = 4000   # tam yolda bu kadar FMT'siz mesajdan sonra hızlı yola geçilir


def _python_yuru(tampon, p, sinir, n, bitti, uz, bicimler, istenen, ist, konumlar):
    """Mesaj mesaj yürüyüş (FMT kayıtlarını işler, bozuk baytta sonraki A3 95'e atlar, tanımsız tipte 1 bayt ilerler).
    Dönüş (p, hızlı_yola_dön)."""
    sakin = 0
    while p < sinir:
        if tampon[p] != HEAD1 or p + 2 >= n or tampon[p + 1] != HEAD2:
            q = tampon.find(b'\xa3\x95', p + 1)   # bozuk bayt: pymavlink gibi sonraki başlığa atla
            if q < 0:
                return (n if bitti else max(p, n - 1)), False
            p = q
            continue
        t = tampon[p + 2]
        L = uz[t]
        if L == 0:               # tanımsız tip: bir bayt ilerle, sonraki başlığı ara
            p += 1
            continue
        if p + L > n:            # kesik son mesaj (yalnız dosya sonunda olabilir)
            return n, False
        if t == FMT_TIP:
            sakin = 0
            ftip, fuz = tampon[p + 3], tampon[p + 4]
            if ftip != FMT_TIP and fuz >= 3:
                ad = _metin(tampon[p + 5:p + 9])
                b = _Bicim(ftip, ad, fuz, _metin(tampon[p + 9:p + 25]), _metin(tampon[p + 25:p + 89]).split(','))
                uz[ftip] = fuz
                bicimler[ftip] = b
                ist[ftip] = ad if (ad in istenen and b.dtype is not None) else None
        else:
            if ist[t] is not None:
                konumlar.setdefault(t, [[]])[0].append(p)
            sakin += 1
            if sakin >= SAKIN:
                return p + L, True
        p += L
    return p, False


def _adaylar(arr, p, n):
    """arr[p:n] içinde A3 95 başlık adaylarının konumları (artan). Çift/tek hizada iki uint16 karşılaştırması (bayt bayt maskeden ~3× hızlı)."""
    seg = arr[p:n]
    m = len(seg)
    cift = np.flatnonzero(seg[:m - (m % 2)].view('<u2') == 0x95A3) * 2
    tek = np.flatnonzero(seg[1:1 + ((m - 1) - (m - 1) % 2)].view('<u2') == 0x95A3) * 2 + 1 if m > 2 else np.empty(0, np.int64)
    c = np.concatenate([cift, tek])
    c.sort()
    return c + p


def _vektor_yuru(arr, p, sinir, n, uz, ist, konumlar):
    """[p, sinir) aralığında aday başlıklar (A3 95) numpy ile bulunur; her adayın ardılı (konum + FMT uzunluğu) aday mı diye eşlenir;
    zincir gelen-derece soyma + ardıl doğrulamasıyla vektörel bulunur. Zincir FMT, tanımsız tip, ardılı aday olmayan (bozuk)
    mesajda ya da blok sınırında durur. Dönüş (yeni p, 'blok' | 'tam'): 'blok' → p ≥ sinir; 'tam' → p'den tam yolla devam."""
    if p + 3 > n:
        return p, 'tam'
    c = _adaylar(arr, p, n)
    if not len(c) or c[0] != p:
        return p, 'tam'
    c = c[c + 2 < n]
    tip = arr[c + 2]
    L = np.asarray(uz, dtype=np.int64)[tip]
    nxt = c + L
    # ardıl çoğunlukla bir sonraki adaydır (sahte aday yoksa): önce o denenir, tutmayanlar ikili aramayla
    N = len(c)
    j = np.arange(1, N + 1)
    jc = np.minimum(j, N - 1)
    tutmaz = np.flatnonzero(c[jc] != nxt)
    if len(tutmaz):
        j[tutmaz] = np.searchsorted(c, nxt[tutmaz])
        jc = np.minimum(j, N - 1)
    succ = np.where((L > 0) & (j < N) & (c[jc] == nxt), j, -1)
    succ[nxt >= sinir] = -2                      # zincir sonraki blokta sürer
    succ[(L == 0) | (tip == FMT_TIP) | (nxt > n)] = -3   # tam yola devret (işaretlenmez)
    # Zincir: düğüm 0'dan ardıllarla ulaşılan düğümler. Python'da tek tek izlemek yerine (19 M mesajda ~4 sn) gelen-derece soyma:
    # zincir düğümlerinin (0 hariç) en az bir zincirden gelen oku vardır; yüklerdeki sahte A3 95 adaylarının çoğunun yoktur. Kalan kümenin
    # ardışık elemanları ardıl ilişkisiyle DOĞRULANIR; ilk uyumsuzlukta zincir kesilir (FMT / bozuk bayt / sahte aday) ve tam yola geçilir.
    ok = succ >= 0
    tut = np.ones(N, dtype=bool)
    for _ in range(3):
        tut = np.bincount(succ[ok & tut], minlength=N) > 0
        tut[0] = True
    S = np.flatnonzero(tut)
    uyum = succ[S[:-1]] == S[1:]
    k = int(np.argmin(uyum)) if len(uyum) and not uyum.all() else len(S) - 1
    son = int(S[k])
    kod = int(succ[son])
    if kod >= 0:                                  # zincir sürüyor ama sıradaki düğüm doğrulanamadı (sahte aday zinciri): tam yol
        zincir, yeni_p, sonuc = S[:k + 1], int(c[kod]), 'tam'
    elif kod == -3:                               # durulan düğüm (FMT / tanımsız tip / kesik) işaretlenmez
        zincir, yeni_p, sonuc = S[:k], int(c[son]), 'tam'
    else:                                         # -1: ardıl başlık değil (bozuk) → tam yol yeniden eşitler · -2: blok sonu
        zincir, yeni_p = S[:k + 1], int(nxt[son])
        sonuc = 'blok' if (kod == -2 and yeni_p >= sinir) else 'tam'
    if not len(zincir):
        return p, 'tam'
    zp, zt = c[zincir], tip[zincir]
    for t in np.flatnonzero(np.bincount(zt, minlength=256)).tolist():
        if ist[t] is not None:
            konumlar.setdefault(t, [[]]).append(zp[zt == t])
    return yeni_p, sonuc


def oku(path, istenen, ilerleme=None, blok=BLOK):
    """`istenen`: {tip adı: [sütun adları]} (yoksa atlanır). Dönüş: {tip adı: {sütun: np.ndarray}} — yalnız logda bulunan tip/sütunlar;
    sayısal sütunlar float32 (f/g/b/B/h/H/M/c/C) ya da float64 (zaman, L enlem/boylam, i/I/e/E/q/Q/d; çarpan uygulanmış), metin sütunları (n/N/Z) Python str listesi, 'a' dizileri (n, 32).
    Mesajlar dosya sırasıyla. `ilerleme(yüzde)` okunan bayta göre çağrılır (0…100). Bellek: blok + istenen sütunlar."""
    toplam = os.path.getsize(path)
    uzunluklar = [0] * 256
    uzunluklar[FMT_TIP] = FMT_UZUNLUK
    bicimler = {}                      # tip no → _Bicim
    istenen_tip = [None] * 256         # tip no → ad (istenen ise)
    ham = {}                           # ad → [(dtype, kayıt dizisi)…] blok parçaları
    son_yuzde = -1
    with open(path, 'rb') as f:
        taban = 0                      # tamponun dosyadaki başlangıcı
        tampon = b''
        p = 0                          # tampon içindeki konum
        bitti = False
        while True:
            yeni = f.read(blok)
            bitti = len(yeni) < blok
            tampon = tampon[p:] + yeni
            taban += p
            p = 0
            n = len(tampon)
            sinir = n if bitti else n - 256   # son blok dışında en uzun mesaj (255 B) tamponda tamamlansın
            konumlar = {}
            arr = np.frombuffer(tampon, dtype=np.uint8)
            vektor_ok = True
            while p < sinir:
                if vektor_ok:            # hızlı yol: numpy aday başlıkları + ardıl zinciri; FMT / bozuk bayt / bilinmeyen tipte durur
                    p, durum = _vektor_yuru(arr, p, sinir, n, uzunluklar, istenen_tip, konumlar)
                    if durum == 'blok':
                        break
                # tam yol (pymavlink ile aynı kurallar): FMT kaydı, yeniden eşitleme; ardışık SAKIN mesajdan sonra hızlı yola döner
                p, vektor_ok = _python_yuru(tampon, p, sinir, n, bitti, uzunluklar, bicimler, istenen, istenen_tip, konumlar)
            if konumlar:                 # bloktaki istenen mesajları toplu çöz (yapılı dtype görünümü)
                for t, ks in konumlar.items():
                    b = bicimler[t]
                    idx = np.sort(np.concatenate([np.asarray(ks[0], dtype=np.int64)] + ks[1:]))   # [0]: tam yol listesi
                    kayit = arr[(idx + 3)[:, None] + np.arange(b.uzunluk - 3)].view(b.dtype).reshape(-1)
                    sut = [c for c in istenen[b.ad] if c in b.dtype.names]
                    if sut:
                        ham.setdefault(b.ad, []).append((b, {c: kayit[c].copy() for c in sut}, len(kayit)))
            del arr
            if ilerleme:
                y = int(100 * min(toplam, taban + p) / max(1, toplam))
                if y != son_yuzde:
                    son_yuzde = y
                    ilerleme(y)
            if bitti:
                break
    sonuc = {}
    for ad, parcalar in ham.items():
        cols = {}
        for c in istenen[ad]:
            ornek = next((b for b, d, _n in parcalar if c in d), None)
            if ornek is None:
                continue
            ch_ = ornek.bicim[ornek.sutunlar.index(c)] if c in ornek.sutunlar else 'f'
            if ch_ in 'nNZ':
                cols[c] = [_metin(x) for _b, d, m in parcalar for x in (d[c] if c in d else [b''] * m)]
            elif ch_ == 'a':
                cols[c] = np.concatenate([d[c] if c in d else np.zeros((m, 32), np.int16) for _b, d, m in parcalar])
            else:
                parca = []
                for b, d, m in parcalar:
                    if c not in d:
                        parca.append(np.full(m, np.nan, dtype=np.float32 if ch_ in _KUCUK else np.float64))
                        continue
                    v = d[c].astype(np.float32 if ch_ in _KUCUK else np.float64)
                    mul = b.carpan.get(c)
                    if mul is not None:
                        v = v / v.dtype.type(round(1 / mul)) if 0 < mul < 1 else v * mul
                    parca.append(v)
                cols[c] = np.concatenate(parca) if len(parca) > 1 else parca[0]
        if cols:
            sonuc[ad] = cols
    if ilerleme and son_yuzde < 100:
        ilerleme(100)
    return sonuc


def zaman(cols):
    """Mesaj sütunlarından saniye cinsinden zaman (TimeUS, yoksa TimeMS); yoksa None."""
    if 'TimeUS' in cols:
        return cols['TimeUS'] / 1e6
    if 'TimeMS' in cols:
        return cols['TimeMS'] / 1e3
    return None
