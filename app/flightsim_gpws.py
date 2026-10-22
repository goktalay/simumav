"""Uçuş Simülatörü §42 — UÇUŞ UYARI SİSTEMİ sunucu kaydı (docs/ucus-simulatoru.md §42; HEPGO + SIMUMAV ortak çekirdek).

Uyarılar (GPWS / stall / bank angle / IMU arızası …) İSTEMCİDE telemetriden hesaplanır (static/js/modules/flightsim_gpws.js — kayıttan oynatmada
da aynı değerlendirici); istemci her BİTEN uyarı bölümünü `cmd gpws {events: [{code, level, t0, start_s, dur_s}], cfg?: {mode, off}}` ile bildirir.
Bu modül (saf; DB yok):
  • komut doğrulaması (bilinmeyen kod / seviye uyuşmazlığı / sayı dışı → GpwsHata → 400),
  • tekilleştirme: aynı (kod, t0) bir kez (birden çok yazma izinli sekme aynı olayları yollasa da çift sayılmaz),
  • özet + "uçuş disiplini" puanı — istemci `summarizeAlerts` ile AYNI formül (tests/test_flightsim_gpws.py eşitliği denetler).
Özet oturum özetine (`summary.alerts`), drone_sim_runs.alerts (JSON) + alert_score sütunlarına, SIMUMAV flights.summary'ye yazılır.
"""
import math

# kod → seviye (JS GPWS_CODES ile aynı; test_flightsim_gpws.mjs sunucu listesini denetler)
KODLAR = {
    'PULL_UP': 'warning', 'TERRAIN': 'warning', 'STALL': 'warning', 'IMU_FAULT': 'warning', 'ENGINE': 'warning', 'OVERSPEED': 'warning',
    'BANK_ANGLE': 'warning', 'PITCH': 'warning', 'SINK_RATE': 'warning', 'BATT_CRIT': 'warning', 'FUEL': 'warning', 'GPS_LOST': 'warning',
    'GEOFENCE': 'warning',
    'TOO_LOW': 'caution', 'DONT_SINK': 'caution', 'EKF': 'caution', 'VIBRATION': 'caution', 'BATT_LOW': 'caution', 'FUEL_LOW': 'caution',
    'WIND': 'caution', 'LINK': 'caution',
}
MODLAR = ('off', 'visual', 'full')
PUAN_KURALI = {'warning': (6.0, 1.5, 20.0), 'caution': (2.0, 0.5, 8.0)}   # (taban, saniye başına, tavan) — JS SCORE_RULES
OLAY_TAVANI = 500        # oturum başına saklanan bölüm sayısı
OZET_OLAY_TAVANI = 200   # özette listelenen
KOMUT_OLAY_TAVANI = 50   # tek komutta en çok


class GpwsHata(ValueError):
    pass


def _sayi(v, ad, alt=0.0, ust=1e9):
    if isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(float(v)):
        raise GpwsHata(f'gpws.{ad} sayı olmalı')
    v = float(v)
    if not (alt <= v <= ust):
        raise GpwsHata(f'gpws.{ad} {alt:g}…{ust:g} aralığında olmalı')
    return v


def olay_dogrula(o):
    """Tek bölüm → {code, level, t0, start_s, dur_s}."""
    if not isinstance(o, dict):
        raise GpwsHata('gpws.events öğesi nesne olmalı')
    kod = o.get('code')
    if kod not in KODLAR:
        raise GpwsHata(f'Bilinmeyen uyarı kodu: {kod}')
    seviye = o.get('level', KODLAR[kod])
    if seviye != KODLAR[kod]:
        raise GpwsHata(f'{kod} seviyesi {KODLAR[kod]} olmalı')
    t0 = _sayi(o.get('t0'), 't0', 0, 1e10)
    st = o.get('start_s')
    return {'code': kod, 'level': seviye, 't0': round(t0, 2), 'start_s': round(_sayi(st, 'start_s', 0, 1e7), 2) if st is not None else None,
            'dur_s': round(_sayi(o.get('dur_s'), 'dur_s', 0, 86400), 2)}


def cfg_dogrula(c):
    if c is None:
        return None
    if not isinstance(c, dict):
        raise GpwsHata('gpws.cfg nesne olmalı')
    mod = c.get('mode', 'full')
    if mod not in MODLAR:
        raise GpwsHata(f"gpws.cfg.mode {' | '.join(MODLAR)} olmalı")
    off = c.get('off') or []
    if not isinstance(off, list):
        raise GpwsHata('gpws.cfg.off liste olmalı')
    return {'mode': mod, 'off': sorted({k for k in off if k in KODLAR})}


def ceza(seviye, sure):
    taban, saniye, tavan = PUAN_KURALI.get(seviye, PUAN_KURALI['caution'])
    return min(tavan, taban + saniye * max(0.0, float(sure or 0)))


def not_harfi(p):
    if p is None:
        return None
    return 'A' if p >= 90 else 'B' if p >= 75 else 'C' if p >= 60 else 'D' if p >= 40 else 'F'


def _yuvarla(v):
    """JS Math.round(x * 100) / 100 (yarımlar yukarı) ile aynı."""
    return math.floor(float(v) * 100 + 0.5) / 100


def ozetle(olaylar, mode='full', off=()):
    """Bölümler → {v, mode, off, events, by_code, warnings, cautions, total_s, score, grade} (JS summarizeAlerts ile aynı)."""
    ev = sorted([o for o in (olaylar or []) if o.get('code') in KODLAR], key=lambda o: o.get('t0') or 0)
    by, uyari, dikkat, toplam, cz = {}, 0, 0, 0.0, 0.0
    for o in ev:
        sev = KODLAR[o['code']]
        d = max(0.0, float(o.get('dur_s') or 0))
        b = by.setdefault(o['code'], {'level': sev, 'n': 0, 'total_s': 0.0, 'first_s': None})
        b['n'] += 1
        b['total_s'] = _yuvarla(b['total_s'] + d)
        fs = float(o['start_s'] if o.get('start_s') is not None else (o.get('t0') or 0))
        if b['first_s'] is None or fs < b['first_s']:
            b['first_s'] = _yuvarla(fs)
        if sev == 'warning':
            uyari += 1
        else:
            dikkat += 1
        toplam += d
        cz += ceza(sev, d)
    puan = None if mode == 'off' else max(0, int(math.floor(100 - cz + 0.5)))
    return {'v': 1, 'mode': mode, 'off': list(off or []),
            'events': [{'code': o['code'], 'level': KODLAR[o['code']], 't0': o.get('t0'), 'start_s': o.get('start_s'), 'dur_s': o.get('dur_s')} for o in ev[:OZET_OLAY_TAVANI]],
            'by_code': by, 'warnings': uyari, 'cautions': dikkat, 'total_s': _yuvarla(toplam), 'score': puan, 'grade': not_harfi(puan)}


class UyariKaydi:
    """Oturumun uyarı bölümleri (istemci bildirir). `ekle(params)` → {ok, added, total}; `ozet()` → özet ya da hiç bildirim yoksa None."""

    def __init__(self):
        self.olaylar = []
        self._anahtar = set()
        self.cfg = None   # {mode, off} — son bildirilen ayar

    def ekle(self, p):
        p = p if isinstance(p, dict) else {}
        cfg = cfg_dogrula(p.get('cfg'))
        liste = p.get('events', [])
        if not isinstance(liste, list):
            raise GpwsHata('gpws.events liste olmalı')
        if len(liste) > KOMUT_OLAY_TAVANI:
            raise GpwsHata(f'gpws.events en çok {KOMUT_OLAY_TAVANI} öğe')
        yeni = [olay_dogrula(o) for o in liste]   # önce hepsi doğrulanır (yarım ekleme yok)
        if cfg is not None:
            self.cfg = cfg
        eklenen = 0
        for o in yeni:
            k = (o['code'], round(o['t0'], 1))
            if k in self._anahtar or len(self.olaylar) >= OLAY_TAVANI:
                continue
            self._anahtar.add(k)
            self.olaylar.append(o)
            eklenen += 1
        return {'ok': True, 'added': eklenen, 'total': len(self.olaylar)}

    def ozet(self):
        if self.cfg is None and not self.olaylar:
            return None   # istemci hiç bildirmedi (eski istemci / izleyici yok) → özet alanı yok
        c = self.cfg or {'mode': 'full', 'off': []}
        return ozetle(self.olaylar, c['mode'], c['off'])
