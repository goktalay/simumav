"""Uçuş Simülatörü — KARŞILAŞMADA YAPAY ZEKÂ PİLOT (bot oyuncu; docs/ucus-simulatoru.md §44; HEPGO + SIMUMAV ortak).

İki katman:
  · `BotPilot` (SAF; zaman, konum ve rakip dışarıdan): her adımda bir hız komutu üretir — {vx, vy, vz (ENU m/s), hedef (x, y, z), hiz, yaw_deg}.
    Halka yarışında sıradaki halkanın merkezine (seviyeye göre kaçıklıkla) önce halkanın önündeki yaklaşma noktasından, sonra düz geçerek gider;
    it dalaşında KOVALAYAN rakibin (gecikmeli + hatalı) tahmini konumuna yönelir, KAÇAN rakipten uzaklaşan yönde zikzak/irtifa manevrası yapar.
    Seviye parametreleri `flightsim_match_core.BOT_SEVIYE` tablosundadır (tek tablo). Bu OYUN İÇİ rakip davranışıdır: "hedefe doğru yönel +
    seviye gecikmesi + dönüş oranı sınırı" — gerçek güdüm/önleme yasası (orantılı seyrüsefer vb.) DEĞİLDİR ve öyle kullanılmamalıdır.
  · `BotSurucu` (asyncio; platformdan bağımsız): karşılaşma YARIS'a geçince botun KENDİ SITL oturumunda ARM + kalkış (yarış kapısına uyar), sonra
    5 Hz'de BotPilot komutunu `SimSession.bot_yonlendir` ile araca verir (kopter: GUIDED hız vektörü; uçak: GUIDED hedef nokta + hız; sahte
    kinematikte hız komutu). Karşılaşma bitince / oturum kapanınca / bot düşünce durur. HEPGO `flightsim_match.MatchRuntime` ve SIMUMAV
    `simumav/match.Mac` aynı sınıfı kullanır.
"""
import asyncio
import math
import random
import time

from . import flightsim_match_core as core

KOMUT_HZ = 5.0
ZEMIN_MIN = {'dikey': 8.0, 'ucak': 35.0}     # it dalaşında en düşük güvenli irtifa (m, merkez zemininden; seviye zemin_pay ile çarpılır)
YAKLASMA_M = {'dikey': 22.0, 'ucak': 110.0}  # halkanın önündeki yaklaşma noktası uzaklığı
TIRMANMA = {'dikey': (3.0, 2.0), 'ucak': (5.0, 4.0)}   # (en çok tırmanma, en çok alçalma) m/s
UCAK_HEDEF_UZAT_M = 250.0                    # uçak hedef noktası en az bu kadar ileriye (GUIDED'da varmadan daireye girmesin)


def _sar(a):
    return (a + math.pi) % (2 * math.pi) - math.pi


def _sinir(v, a, b):
    return a if v < a else b if v > b else v


class BotPilot:
    """Saf bot pilotu. `vclass` 'dikey' | 'ucak'; `tohum` deterministik rastgelelik (aynı tohum = aynı kaçıklıklar/manevralar)."""

    def __init__(self, seviye, vclass='dikey', tohum=1):
        self.seviye = seviye
        self.p = core.bot_seviye(seviye)
        self.vclass = vclass if vclass in core.BOT_VMAX else 'dikey'
        self.rng = random.Random(int(tohum or 1))
        v = core.BOT_VMAX[self.vclass] * self.p['hiz']
        self.vmax = max(core.BOT_UCAK_VMIN, v) if self.vclass == 'ucak' else v
        self.yon = None               # komut yönü (rad, kuzeyden saat yönünde)
        self.son_t = None
        self.son = None               # son komut
        self.sira = None              # halka: son görülen sıra
        self.bekle_t = 0.0            # tepki gecikmesi sonu (bu ana dek eski komut sürer)
        self.kacik = {}               # (sıra, deneme) → (yanal m, dikey m)
        self.deneme = {}              # sıra → deneme sayısı (ıskalayınca artar)
        self.gecti_t = {}             # sıra → halka düzlemini (sayılmadan) geçtiği an
        self.gecmis = []              # it dalaşı: [(t, rakip)] (tepki gecikmesi)
        self.manevra = None           # kaçış: {'t', 'aci', 'dz'}
        self.geri = {}                # §47 FPV: kapının arkasına düşünce dönüş fazı (sıra → 'cikis' | 'giris')
        self._sd = {}                 # §47 FPV: sıra → kapı düzlemine son işaretli uzaklık (sayılmadan geçişi yakalamak için)
        self.ivme = 6.0               # §47 FPV: öngörülü dönüş hızı için yanal ivme (m/s²; gerçek ArduCopter GUIDED'da BotSurucu düşürür)
        self.faz = (self.rng.uniform(0, 6.28), self.rng.uniform(0, 6.28), self.rng.uniform(0, 6.28))

    # ---------------------------------------------------------------- ortak
    def _yonlen(self, t, ben, hedef, hiz, yavasla=True):
        """Hedefe doğru dönüş oranı sınırlı yön + hız + dikey hız → komut sözlüğü."""
        dt = 0.2 if self.son_t is None else _sinir(t - self.son_t, 0.0, 1.0)
        self.son_t = t
        dx, dy = hedef[0] - ben['x'], hedef[1] - ben['y']
        istenen = math.atan2(dx, dy)
        if self.yon is None:
            hd = ben.get('heading')
            self.yon = math.radians(hd) if hd is not None else istenen
        fark = _sar(istenen - self.yon)
        azami = math.radians(self.p['donus_dps']) * dt
        self.yon = _sar(self.yon + _sinir(fark, -azami, azami))
        kalan = abs(_sar(istenen - self.yon))
        v = hiz
        if self.vclass == 'dikey' and yavasla:   # kopter sert dönüşte yavaşlar (uçak hızını korur)
            v = hiz * (0.35 + 0.65 * max(0.0, math.cos(kalan)))
        if self.vclass == 'ucak':
            v = max(core.BOT_UCAK_VMIN, v)
        yukari, asagi = TIRMANMA[self.vclass]
        vz = _sinir((hedef[2] - ben['z']) * 0.6, -asagi, yukari)
        vx, vy = math.sin(self.yon) * v, math.cos(self.yon) * v
        out = {'vx': round(vx, 3), 'vy': round(vy, 3), 'vz': round(vz, 3), 'hedef': (round(hedef[0], 2), round(hedef[1], 2), round(hedef[2], 2)),
               'hiz': round(v, 2), 'yaw_deg': round(math.degrees(self.yon) % 360, 1)}
        self.son = out
        return out

    # ---------------------------------------------------------------- halka yarışı
    def _halka_kacik(self, sira, R):
        """Halka merkezinden (yanal, dikey) kaçıklık: yarıçapa oran `sapma`; `iska` olasılıkla halkanın dışı (ilk denemede)."""
        dn = self.deneme.get(sira, 0)
        key = (sira, dn)
        if key not in self.kacik:
            if dn == 0 and self.rng.random() < self.p['iska']:
                r = R * 1.45
            else:
                r = R * self.p['sapma'] * math.sqrt(self.rng.random())
            a = self.rng.uniform(0, 2 * math.pi)
            self.kacik[key] = (r * math.cos(a), r * math.sin(a) * 0.6)
        return self.kacik[key]

    def _yaklasma(self):
        """(yaklaşma uzaklığı m, düz giriş konisi tan) — uçakta dönüş yarıçapı hızla büyür: uzaklık v²'yle uzar, koni daralır."""
        if self.vclass == 'ucak':
            return YAKLASMA_M['ucak'] * max(1.0, (self.vmax / 22.0) ** 2), math.tan(math.radians(self.p['giris_aci'] * 0.6))
        return YAKLASMA_M['dikey'], math.tan(math.radians(self.p['giris_aci']))

    def halka_hedefi(self, ben, halkalar, sira, v=None):
        """(hedef (x, y, z), mod 'yaklas' | 'gec') — saf geometri. z: merkez zemininden yükseklik (halka agl_m)."""
        h = halkalar[sira]
        nx, ny = h['nx'], h['ny']
        R = float(h['radius_m'])
        yl, zl = self._halka_kacik(sira, R)
        cx, cy, cz = h['x'] + ny * yl, h['y'] - nx * yl, float(h['agl_m']) + zl
        rx, ry = ben['x'] - h['x'], ben['y'] - h['y']
        s = rx * nx + ry * ny                      # halka düzlemine işaretli uzaklık (− önde)
        yan = abs(rx * ny - ry * nx)               # yanal uzaklık
        L, koni = self._yaklasma()
        if s < -2.0 and yan <= max(R * 1.2, -s * koni):
            hedef = (cx + nx * L * 0.6, cy + ny * L * 0.6, cz)
            if self.p['on_donus'] and sira + 1 < len(halkalar) and v is not None and -s < max(4.0, v * 0.35) and yan < R * 0.6:
                # Zor: halkaya çok yaklaşınca bir sonraki halkanın yaklaşma noktasına doğru önceden dön (momentum halkadan geçirir)
                h2 = halkalar[sira + 1]
                hedef = (h2['x'] - h2['nx'] * L, h2['y'] - h2['ny'] * L, float(h2['agl_m']))
            return hedef, 'gec'
        # yaklaşma noktası (halkanın önünde); arkadaysa halkanın yanından dolaş (ters yönde içinden geçmesin)
        ax, ay = cx - nx * L, cy - ny * L
        if s >= -2.0 and yan < R * 2.5:
            taraf = 1.0 if (rx * ny - ry * nx) >= 0 else -1.0
            ax, ay = ax + ny * R * 3.0 * taraf, ay - nx * R * 3.0 * taraf
        if self.vclass == 'ucak':   # uçak yaklaşma noktasının çevresinde dönüp durmasın: dönüş yarıçapı içindeyse noktayı geriye kaydır
            rt = self.vmax ** 2 / 6.0
            if math.hypot(ax - ben['x'], ay - ben['y']) < rt * 1.6:
                ax, ay = ax - nx * rt * 2.0, ay - ny * rt * 2.0
        return (ax, ay, cz), 'yaklas'

    def halka_adim(self, t, ben, halkalar, sira):
        """Halka yarışı komutu. `ben` {x, y, z, heading?, gs?}; `sira` sıradaki halka (0 tabanlı; len → bitti)."""
        if not halkalar or sira >= len(halkalar):
            return self._yonlen(t, ben, (ben['x'] + math.sin(self.yon or 0) * 50, ben['y'] + math.cos(self.yon or 0) * 50, ben['z']), self.vmax * 0.4)
        if self.sira is not None and sira != self.sira:
            self.bekle_t = t + self.p['gecikme_s']   # geçişten sonra tepki gecikmesi: eski yönde sürer
        self.sira = sira
        if t < self.bekle_t and self.son is not None:
            self.son_t = t
            return self.son
        # ıskalandı mı: halka düzleminin arkasına (sayılmadan) geçti → yeni deneme (ikinci denemede ıskalama yok)
        h = halkalar[sira]
        s = (ben['x'] - h['x']) * h['nx'] + (ben['y'] - h['y']) * h['ny']
        if s > 3.0 and sira not in self.gecti_t and self.son is not None:
            self.gecti_t[sira] = t
            self.deneme[sira] = self.deneme.get(sira, 0) + 1
        elif s < -3.0:
            self.gecti_t.pop(sira, None)
        hedef, mod = self.halka_hedefi(ben, halkalar, sira, ben.get('gs'))
        hiz = self.vmax
        if mod == 'yaklas' and self.vclass == 'dikey':
            d = math.hypot(hedef[0] - ben['x'], hedef[1] - ben['y'])
            hiz = min(hiz, max(3.0, d * 0.7))
        return self._yonlen(t, ben, hedef, hiz)

    # ---------------------------------------------------------------- §47 FPV parkuru
    def parkur_adim(self, t, ben, noktalar, sira, vmax=None):
        """FPV parkuru komutu: sıradaki kontrol noktasının yarış hattı parçasını (önceki çıkış → ara noktalar → giriş → merkez → çıkış) 3B
        izleme (ileri bakış noktası; seviye: hız, tepki gecikmesi, dönüş oranı, kapı merkezinden kaçıklık). `vmax` parkurun bot hız tavanı (m/s;
        seviyenin hız oranıyla ölçeklenir). Yükseklik z merkez zemininden."""
        v = float(vmax or 7.0) * min(1.0, self.p['hiz'] / 0.95)
        if not noktalar or sira >= len(noktalar):   # bitti: olduğu yerde dur
            return self._komut3(t, ben, (ben['x'], ben['y'], ben['z']), 0.0)
        if self.sira is not None and sira != self.sira:
            self.bekle_t = t + self.p['gecikme_s'] * 0.4   # FPV: kısa tepki gecikmesi (kapıdan sonra çizgide sürer)
        self.sira = sira
        if t < self.bekle_t and self.son is not None:
            self.son_t = t
            return self.son
        h = noktalar[sira]
        hat = [tuple(map(float, q)) for q in (h.get('line') or [[h['x'], h['y'], h.get('z', h.get('agl_m', 2))]])]
        # kapı merkezinden seviye kaçıklığı (yalnız giriş-merkez-çıkış noktalarına; açıklığın yarısına oranla küçük)
        key = (sira, 0)
        if key not in self.kacik:
            r = min(float(h.get('w') or 3), float(h.get('h') or 3)) / 2 * self.p['sapma'] * 0.45 * math.sqrt(self.rng.random())
            a = self.rng.uniform(0, 2 * math.pi)
            self.kacik[key] = (r * math.cos(a), r * math.sin(a))
        du, dv = self.kacik[key]
        n = (float(h.get('nx') or 0), float(h.get('ny') or 0), float(h.get('nz') or 0))
        u = (n[1], -n[0], 0.0) if abs(n[2]) < 0.9 else (1.0, 0.0, 0.0)
        w = (0.0, 0.0, 1.0) if abs(n[2]) < 0.9 else (0.0, 1.0, 0.0)
        for k in range(max(0, len(hat) - 3), len(hat)):
            q = hat[k]
            hat[k] = (q[0] + u[0] * du + w[0] * dv, q[1] + u[1] * du + w[1] * dv, q[2] + u[2] * du + w[2] * dv)
        p = (ben['x'], ben['y'], ben['z'])
        # kapının ARKASINA (sayılmadan) geçtiyse: önce eksendeki çıkış noktasına, oradan girişe dön (açıklıktan geri geçer; ters yön uyarısı
        # sayılmaz), sonra yeniden ileri — düzlemi açıklığın yakınından (eksene < 8 m) sayılmadan geçtiyse ya da hattın sonunu aştıysa
        if len(hat) >= 3:
            c, ex, en = hat[-2], hat[-1], hat[-3]
            d = (p[0] - c[0], p[1] - c[1], p[2] - c[2])
            sd = d[0] * n[0] + d[1] * n[1] + d[2] * n[2]
            yan = math.sqrt(max(0.0, d[0] ** 2 + d[1] ** 2 + d[2] ** 2 - sd * sd))
            faz = self.geri.get(sira)
            # en yakın parça izdüşümü (geri dönüş kararı için de: hattın sonunu aştı mı)
            j, s_ = self._izdusum(hat, p)
            sona = j == len(hat) - 2 and s_ >= 0.999
            onceki = self._sd.get(sira)
            self._sd[sira] = sd
            kacirdi = onceki is not None and onceki < 0.0 <= sd and yan < 8.0   # düzlemi açıklığın yakınından geçti ama sayılmadı
            if (faz is None and (kacirdi or (sona and 0.3 < sd and yan < 15.0))) or faz is not None:
                if sd < -0.5 and faz == 'giris':   # yeniden önüne geçti: normal izlemeye dön
                    self.geri.pop(sira, None)
                else:
                    if faz is None or (faz == 'cikis' and math.dist(p, ex) < 1.5):
                        faz = self.geri[sira] = 'giris' if faz == 'cikis' else 'cikis'
                    return self._komut3(t, ben, ex if faz == 'cikis' else en, min(v * 0.6, 4.0))
        j, s_ = self._izdusum(hat, p)
        L = 2.5 + 0.35 * v
        hedef = self._hat_ileri(hat, j, s_, L)
        # öngörülü dönüş hızı: hedef → (2L) doğrultu değişimi θ ile gereken yarıçap R ≈ L / (2 sin(θ/2)); v ≤ √(ivme · R)
        h2 = self._hat_ileri(hat, j, s_, 2 * L)
        a1 = (hedef[0] - p[0], hedef[1] - p[1], hedef[2] - p[2])
        a2 = (h2[0] - hedef[0], h2[1] - hedef[1], h2[2] - hedef[2])
        n1, n2 = math.sqrt(sum(c * c for c in a1)), math.sqrt(sum(c * c for c in a2))
        if n1 > 0.3 and n2 > 0.3:
            cth = _sinir(sum(x * y for x, y in zip(a1, a2)) / (n1 * n2), -1.0, 1.0)
            th = math.acos(cth)
            if th > 0.05:
                R = L / (2 * math.sin(th / 2))
                v = min(v, max(2.0, math.sqrt(self.ivme * R)))
        # yaklaşırken (merkeze < 6 m) hız seviyenin %80'ine iner — dar açıklıkta savrulmasın
        c = hat[-2] if len(hat) >= 2 else hat[-1]
        if math.dist(p, c) < 6.0:
            v *= 0.8
        return self._komut3(t, ben, hedef, v)

    @staticmethod
    def _izdusum(hat, p):
        """Çoklu doğruda en yakın nokta: (parça sırası, parça üstünde oran 0…1); eşit uzaklıkta ilerideki parça."""
        best = (1e18, 0, 0.0)
        for j in range(len(hat) - 1):
            a_, b_ = hat[j], hat[j + 1]
            ab = (b_[0] - a_[0], b_[1] - a_[1], b_[2] - a_[2])
            L2 = ab[0] ** 2 + ab[1] ** 2 + ab[2] ** 2 or 1e-9
            s = _sinir(((p[0] - a_[0]) * ab[0] + (p[1] - a_[1]) * ab[1] + (p[2] - a_[2]) * ab[2]) / L2, 0.0, 1.0)
            q = (a_[0] + ab[0] * s, a_[1] + ab[1] * s, a_[2] + ab[2] * s)
            d2 = (p[0] - q[0]) ** 2 + (p[1] - q[1]) ** 2 + (p[2] - q[2]) ** 2
            if d2 < best[0] - 1e-9 or (abs(d2 - best[0]) < 1e-9 and j > best[1]):
                best = (d2, j, s)
        return best[1], best[2]

    @staticmethod
    def _hat_ileri(hat, j, s, kalan):
        """İzdüşümden hat boyunca `kalan` m ilerideki nokta; hattın sonunda son doğrultuda uzatılır (kapı düzlemini geçsin)."""
        if len(hat) < 2:
            return tuple(hat[-1])
        q, nxt = hat[j], hat[j + 1]
        hedef = (q[0] + (nxt[0] - q[0]) * s, q[1] + (nxt[1] - q[1]) * s, q[2] + (nxt[2] - q[2]) * s)
        k = j
        while True:
            b_ = hat[k + 1] if k + 1 < len(hat) else None
            if b_ is None:
                a_ = hat[-2]
                d = math.dist(a_, hat[-1]) or 1.0
                return tuple(hedef[i] + (hat[-1][i] - a_[i]) / d * kalan for i in range(3))
            d = math.dist(hedef, b_)
            if d >= kalan:
                return tuple(hedef[i] + (b_[i] - hedef[i]) * kalan / d for i in range(3))
            kalan -= d
            hedef = b_
            k += 1

    def _komut3(self, t, ben, hedef, v):
        """3B hedefe hız vektörü (FPV): yatay yön dönüş oranı sınırlı (FPV kopteri ×2,5), dikey hız ±(3,5 ↑ / 3 ↓) m/s."""
        dt = 0.2 if self.son_t is None else _sinir(t - self.son_t, 0.0, 1.0)
        self.son_t = t
        dx, dy, dz = hedef[0] - ben['x'], hedef[1] - ben['y'], hedef[2] - ben['z']
        L = math.sqrt(dx * dx + dy * dy + dz * dz)
        if L < 0.05 or v <= 0:
            out = {'vx': 0.0, 'vy': 0.0, 'vz': round(_sinir(dz * 0.8, -3.0, 3.5), 3), 'hedef': tuple(round(c, 2) for c in hedef), 'hiz': 0.0,
                   'yaw_deg': round(math.degrees(self.yon or 0) % 360, 1)}
            self.son = out
            return out
        yatay = math.hypot(dx, dy)
        istenen = math.atan2(dx, dy) if yatay > 0.05 else (self.yon if self.yon is not None else 0.0)
        if self.yon is None:
            hd = ben.get('heading')
            self.yon = math.radians(hd) if hd is not None else istenen
        fark = _sar(istenen - self.yon)
        azami = math.radians(self.p['donus_dps'] * 2.5) * dt
        self.yon = _sar(self.yon + _sinir(fark, -azami, azami))
        kalan = abs(_sar(istenen - self.yon))
        vh = v * yatay / L * (0.3 + 0.7 * max(0.0, math.cos(kalan)))
        vz = _sinir(v * dz / L * 1.2, -3.0, 3.5)
        out = {'vx': round(math.sin(self.yon) * vh, 3), 'vy': round(math.cos(self.yon) * vh, 3), 'vz': round(vz, 3),
               'hedef': tuple(round(c, 2) for c in hedef), 'hiz': round(math.hypot(vh, vz), 2), 'yaw_deg': round(math.degrees(self.yon) % 360, 1)}
        self.son = out
        return out

    # ---------------------------------------------------------------- it dalaşı
    def _rakip_gor(self, t, rakip):
        """Tepki gecikmesi: rakibi `gecikme_s` önceki haliyle görür (+ yavaş değişen tahmin hatası)."""
        if rakip is not None:
            self.gecmis.append((t, dict(rakip)))
        gec = self.p['gecikme_s']
        while len(self.gecmis) > 1 and self.gecmis[1][0] <= t - gec:
            self.gecmis.pop(0)
        if not self.gecmis:
            return None
        r = dict(self.gecmis[0][1])
        e = self.p['tahmin_hata_m']
        f = self.faz
        r['x'] += e * math.sin(t * 0.37 + f[0])
        r['y'] += e * math.cos(t * 0.29 + f[1])
        r['z'] += e * 0.25 * math.sin(t * 0.21 + f[2])
        return r

    def _guvenli(self, ben, hedef, ayar):
        """Alan sınırı + yer: hedefi alanın içine ve güvenli irtifanın üstüne çeker."""
        R = float(ayar['area_radius_m'])
        zmin = ZEMIN_MIN[self.vclass] * self.p['zemin_pay']
        hx, hy, hz = hedef
        r = math.hypot(ben['x'], ben['y'])
        esik = self.p['alan_esik'] * R
        if r > esik:   # içeri harmanla: sınıra yaklaştıkça hedef merkeze doğru kayar
            w = _sinir((r - esik) / max(1.0, 0.12 * R), 0.0, 1.0)
            hx, hy = hx * (1 - w) + 0.0, hy * (1 - w) + 0.0
        rh = math.hypot(hx, hy)
        if rh > esik:
            hx, hy = hx / rh * esik, hy / rh * esik
        zust = max(float(ayar.get('alt_m') or 40) * 2.5, zmin + 30)
        return (hx, hy, _sinir(hz, zmin, zust))

    def kovala_hedefi(self, ben, rakip, ayar, v_ben):
        """KOVALAYAN: rakibin şimdiki konumu ile öngörülen ileri konumu arasında karışım (onculuk) — saf."""
        dx, dy, dz = rakip['x'] - ben['x'], rakip['y'] - ben['y'], rakip['z'] - ben['z']
        d = math.sqrt(dx * dx + dy * dy + dz * dz)
        tau = _sinir(d / max(5.0, v_ben), 0.0, 4.0) * self.p['onculuk']
        return (rakip['x'] + rakip.get('vx', 0.0) * tau, rakip['y'] + rakip.get('vy', 0.0) * tau, rakip['z']), d

    def kacis_yonu(self, t, ben, rakip, ayar):
        """KAÇAN: rakipten uzaklaşan yön + seviye manevrası (aralık, açı, rastgelelik; irtifa oyunu) — (yön rad, dz)."""
        uzak = math.atan2(ben['x'] - rakip['x'], ben['y'] - rakip['y'])
        r = math.hypot(ben['x'], ben['y'])
        R = float(ayar.get('area_radius_m') or 800)
        e = self.p['alan_esik'] * R * 0.85
        if r > e:   # alan sınırına yaklaşırken sınır boyunca (rakipten uzak yöne) kıvrıl, hafif içeri
            ux, uy = math.sin(uzak), math.cos(uzak)
            tx, ty = -ben['y'] / r, ben['x'] / r
            if tx * ux + ty * uy < 0:
                tx, ty = -tx, -ty
            w = _sinir((r - e) / (0.15 * R), 0.0, 1.0)
            dx = (1 - w) * ux + w * (tx * 0.8 - ben['x'] / r * 0.45)
            dy = (1 - w) * uy + w * (ty * 0.8 - ben['y'] / r * 0.45)
            uzak = math.atan2(dx, dy)
        m = self.manevra
        if m is None or t >= m['t']:
            rast = self.p['rastgele']
            if m is None:
                isaret = 1.0
            elif rast <= 0.0:
                isaret = -m['isaret']                         # Kolay: hep aynı düzen (sağ-sol-sağ), öngörülebilir
            else:
                isaret = -m['isaret'] if self.rng.random() > rast * 0.5 else m['isaret']
            buyukluk = self.p['manevra_aci'] * (1.0 - rast * 0.5 * self.rng.random())
            sure = self.p['manevra_s'] * (1.0 + rast * self.rng.uniform(-0.35, 0.35))
            dz = self.rng.uniform(-1.0, 1.0) * float(ayar.get('alt_m') or 40) * 0.35 if self.p['irtifa_oyunu'] else 0.0
            m = self.manevra = {'t': t + sure, 'aci': math.radians(buyukluk), 'isaret': isaret, 'dz': dz}
        # rakip menzile yaklaştıkça usta kaçan zikzakı bırakıp tam hızla uzaklaşır (koni içinde tutulmamak için menzil dışına kaçmak gerekir);
        # Kolay aynı düzende zikzak yapmayı sürdürür (öngörülebilir, yakalanır)
        d = math.hypot(ben['x'] - rakip['x'], ben['y'] - rakip['y'])
        menzil = float(ayar.get('range_m') or 120)
        tehlike = _sinir((menzil * 1.6 - d) / (menzil * 0.8), 0.0, 1.0)
        carpan = 1.0 - tehlike * (0.3 + 0.6 * self.p['rastgele'])
        return uzak + m['isaret'] * m['aci'] * carpan, m['dz']

    def it_adim(self, t, ben, rakip, rol, ayar):
        """İt dalaşı komutu. `rakip` {x, y, z, vx?, vy?} (yoksa düz uçar); `rol` 'chaser' | 'evader'; `ayar` it_ayar_dogrula çıktısı."""
        gor = self._rakip_gor(t, rakip)
        alt = float(ayar.get('alt_m') or 40)
        if gor is None:
            ileri = (ben['x'] + math.sin(self.yon or 0) * 80, ben['y'] + math.cos(self.yon or 0) * 80, alt)
            return self._yonlen(t, ben, self._guvenli(ben, ileri, ayar), self.vmax)
        if rol == core.KOVALAYAN:
            hedef, d = self.kovala_hedefi(ben, gor, ayar, max(5.0, float(ben.get('gs') or self.vmax)))
            hiz = self.vmax
            menzil = float(ayar.get('range_m') or 120)
            if self.vclass == 'dikey' and d < menzil * 0.6:   # yakında: rakibin hızına uy (üstünden geçip öne düşme)
                vr = math.hypot(gor.get('vx', 0.0), gor.get('vy', 0.0))
                hiz = _sinir(vr + 0.25 * d, 3.0, self.vmax)
            return self._yonlen(t, ben, self._guvenli(ben, hedef, ayar), hiz, yavasla=False)
        yon, dz = self.kacis_yonu(t, ben, gor, ayar)
        hedef = (ben['x'] + math.sin(yon) * 120, ben['y'] + math.cos(yon) * 120, alt + dz)
        return self._yonlen(t, ben, self._guvenli(ben, hedef, ayar), self.vmax, yavasla=False)


# ======================================================================
# Çalışma zamanı sürücüsü (HEPGO + SIMUMAV ortak)
# ======================================================================
class BotSurucu:
    """Bir bot oyuncunun SITL oturumunu karşılaşma boyunca uçurur. `k` core.Karsilasma, `uid` botun kimliği, `s` SimSession,
    `tip` çekirdek araç tipi. `calis()` görev olarak başlatılır; karşılaşma bitince/oturum kapanınca kendiliğinden biter."""

    def __init__(self, k, uid, s, tip):
        self.k = k
        self.uid = uid
        self.s = s
        self.tip = tip
        o = k.oyuncu(uid)
        self.pilot = BotPilot(o.bot if o else 'normal', core.sinif(tip), tohum=(int(k.halka_ayar.get('seed') or 1) * 31 + abs(int(uid))))
        if getattr(s, 'sahte', 1) is None:   # gerçek SITL: GUIDED hız denetimi ivmesi sınırlı (WPNAV_ACCEL) → dönüşlerde daha erken yavaşla
            self.pilot.ivme = 3.0
        self.faz = 'bekle'
        self.kalkis_t = None
        self.arm_t = 0.0
        self.rakip_son = None          # (t, x, y, z) rakip hız kestirimi
        self.hata = None

    def _bitti(self):
        o = self.k.oyuncu(self.uid)
        return (self.k.durum in core.SON_DURUMLAR or o is None or o.durum in core.KATILMAYAN or getattr(self.s, 'state', None) == 'KAPANDI')

    def _ben(self):
        te = self.s.tele or {}
        if te.get('lat') is None:
            return None
        m = self.k.merkez
        x, y = core.enu(m['lat'], m['lon'], te['lat'], te['lon'])
        z = float(te.get('alt_rel') or 0.0)   # SITL evi = merkez zemini (tüm oyuncular): halka agl_m ile aynı ölçek
        return {'x': x, 'y': y, 'z': z, 'heading': te.get('heading'), 'gs': te.get('groundspeed'), 'armed': bool(te.get('armed')), 'mode': te.get('mode')}

    def _kalkis_irtifasi(self):
        if self.k.tur == core.TUR_FPV:   # §47 parkur: başlangıç kapısının yüksekliği (kapalı alan — düşük)
            return max(1.5, float((self.k.halkalar or [{}])[0].get('agl_m') or 2.0))
        if self.k.tur == core.TUR_IT:
            return float(self.k.halka_ayar.get('alt_m') or 40)
        h = (self.k.halkalar or [{}])[0]
        return max(10.0 if core.sinif(self.tip) == 'dikey' else 40.0, float(h.get('agl_m') or 20))

    def _rakip(self, now):
        diger = next((o for o in self.k.aktifler() if o.uid != self.uid), None)
        if diger is None or not diger.poz or diger.poz.get('lat') is None:
            return None, None
        m = self.k.merkez
        x, y = core.enu(m['lat'], m['lon'], diger.poz['lat'], diger.poz['lon'])
        z = float(diger.poz.get('alt_msl') or 0) - float(m.get('alt') or 0)
        vx = vy = 0.0
        if self.rakip_son is not None and now - self.rakip_son[0] > 0.05:
            dt = now - self.rakip_son[0]
            vx, vy = (x - self.rakip_son[1]) / dt, (y - self.rakip_son[2]) / dt
            if math.hypot(vx, vy) > 120:   # sıçrama (Sıfırla) → hız yok say
                vx = vy = 0.0
        self.rakip_son = (now, x, y, z)
        return {'x': x, 'y': y, 'z': z, 'vx': vx, 'vy': vy}, diger

    async def _komut(self, ad, p=None):
        try:
            return await self.s.komut(ad, p or {})
        except Exception as e:   # noqa: BLE001 — SITL henüz hazır değil / ön koşul: sonra yeniden dener
            self.hata = str(e)[:200]
            return None

    async def calis(self):
        aralik = 1.0 / KOMUT_HZ
        try:
            while not self._bitti():
                await asyncio.sleep(aralik)
                if self._bitti():
                    break
                if self.k.durum != core.YARIS or getattr(self.s, 'state', None) != 'HAZIR':
                    continue
                now = time.time()
                ben = self._ben()
                if ben is None:
                    continue
                if self.faz == 'bekle':   # yarış başladı: ARM + kalkış (kapı artık açık)
                    alt = self._kalkis_irtifasi()
                    if not ben['armed'] and self.tip not in ('sabit_kanat',) and now - self.arm_t > 2.0:
                        self.arm_t = now
                        if core.sinif(self.tip) == 'dikey' and self.tip not in ('interceptor',) and str(ben.get('mode') or '').upper() != 'GUIDED':
                            await self._komut('mode', {'mode': 'GUIDED'})   # kopter: kalkış GUIDED'da (EKF/GPS hazır olana dek ARM reddedilir → yinelenir)
                        await self._komut('arm')
                        continue
                    if ben['armed'] or self.tip == 'sabit_kanat':
                        if await self._komut('takeoff', {'alt': alt}) is not None:
                            self.faz, self.kalkis_t = 'kalkis', now
                    continue
                if self.faz == 'kalkis':
                    alt = self._kalkis_irtifasi()
                    if self.k.tur == core.TUR_FPV and ben['armed'] and getattr(self.s, 'sahte', None) is not None:
                        # §47 sahte kinematik: yerinde tırman (hız komutu) — sahte aracın "havada daire" davranışı alçak irtifada devreye girmesin.
                        # Gerçek ArduCopter'da GÖNDERİLMEZ (yerdeyken hız hedefi GUIDED kalkışını iptal eder).
                        try:
                            self.s.bot_yonlendir(self.pilot._komut3(now, ben, (ben['x'], ben['y'], alt), 0.0), merkez=self.k.merkez)
                        except Exception:   # noqa: BLE001
                            pass
                    hazir = ben['z'] >= alt * 0.7 if core.sinif(self.tip) == 'dikey' else (ben['z'] >= min(alt, 30.0) * 0.8 and str(ben.get('mode') or '').upper() != 'TAKEOFF')
                    if not ben['armed'] and now - self.kalkis_t > 6.0:   # kalkış tutmadı (ARM düştü): baştan
                        self.faz = 'bekle'
                        continue
                    if hazir or now - self.kalkis_t > 45.0:
                        self.faz = 'ucus'
                        hazirla = getattr(self.s, 'bot_hazirla', None)
                        if hazirla is not None:
                            try:
                                hazirla(self.pilot.vmax)
                            except Exception:   # noqa: BLE001
                                pass
                    continue
                o = self.k.oyuncu(self.uid)
                if self.k.tur == core.TUR_FPV:   # §47
                    from . import flightsim_fpv as fpv
                    sira = o.iz.sira if o.iz is not None else 0
                    cmd = self.pilot.parkur_adim(now, ben, self.k.halkalar or [], sira, fpv.parkur(self.k.halka_ayar['course_id']).get('bot_vmax'))
                elif self.k.tur == core.TUR_IT:
                    rakip, _ = self._rakip(now)
                    cmd = self.pilot.it_adim(now, ben, rakip, o.rol or core.KOVALAYAN, self.k.halka_ayar)
                else:
                    sira = o.iz.sira if o.iz is not None else 0
                    cmd = self.pilot.halka_adim(now, ben, self.k.halkalar or [], sira)
                try:
                    self.s.bot_yonlendir(cmd, merkez=self.k.merkez)
                except Exception as e:   # noqa: BLE001
                    self.hata = str(e)[:200]
        except asyncio.CancelledError:
            pass
