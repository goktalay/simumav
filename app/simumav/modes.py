"""OYUN TÜRLERİ (yol haritası "Uçuş › Oyun türü") — katalog, yapay zekâ önerisi ve tür puanı.

Her tür bir MOTORA bağlanır:
  · `match` — çok oyunculu karşılaşma çalışma zamanı (match.py; halka yarışı / it dalaşı). Tek oyunculuda gerekli yapay zekâ pilotlar
    otomatik eklenir (`ai.single`), çok oyunculuda kurucu istediği kadar ekler (sunucu tavanı içinde).
  · `fly` — tek oturumlu uçuş (POST /api/fly/start). Savunma türlerinde "yapay zekâ oyuncu" = sunucunun ürettiği gelen hedef dronlar
    (HEPGO §26 savunma çekirdeği, dalga başına tehdit); oyuncu kontrollü INTERCEPTOR ile alan savunulur.
ANGAJMAN KURALI (HEPGO §40, bağlayıcı): savunma / it dalaşı puanı yalnız oyun mekaniğidir — HUD kilidi (oyuncu Boşluk/kumanda ile kilitler) ve
temas/yakın geçiş sayımı. Otonom güdüm, otomatik nişan alma ya da hedefe kendiliğinden yönelme YOKTUR; sunucu yalnız pilotun uçurduğu aracın
konumunu ölçer.
Puan (`puanla`) YALNIZ sunucunun kaydettiği uçuş özetinden (flights.summary) ve karşılaşma satırından hesaplanır; istemcinin bildirdiği değer
(ör. `gates` sayımı) puana girmez — XP (xp.py) bu fonksiyonu kullanır."""

ENGAGEMENT_RULE = 'hud_lock_only'   # §40: kilit yalnız HUD + puan; otonom güdüm yok

MODES = {
    'free': {
        'label': {'tr': 'Serbest uçuş', 'en': 'Free flight'}, 'engine': 'fly', 'multiplayer': False, 'players': [1, 1],
        'types': None, 'requires': {}, 'ai': {'single': 0, 'recommended': 0, 'max': 0, 'kind': None},
        'scoring': [{'key': 'air_time', 'points': '1 / 10 sn havada (≤ 270)'}, {'key': 'distance', 'points': '1 / 100 m (≤ 200)'},
                    {'key': 'discipline', 'points': 'uyarı disiplini puanı × 0,5 (≥ 60 sn uçuş)'}, {'key': 'soft_landing', 'points': '+25 kazasız iniş, +15 iniş dairesinde'}]},
    'rings': {
        'label': {'tr': 'Halka toplama', 'en': 'Ring collection'}, 'engine': 'match', 'match_kind': 'rings', 'multiplayer': True, 'players': [1, 8],
        'types': ['multirotor', 'fpv', 'plane', 'interceptor', 'heli', 'vtol'], 'requires': {},
        'ai': {'single': 0, 'recommended': 2, 'max': 7, 'kind': 'pilot'},
        'scoring': [{'key': 'ring', 'points': 'sunucunun doğruladığı her halka 5'}, {'key': 'rank', 'points': '1.: 100, 2.: 60, 3.: 40, bitiren: 20'},
                    {'key': 'win', 'points': '+50 galibiyet'}, {'key': 'bots_only', 'points': 'rakiplerin hepsi yapay zekâysa × 0,5'}]},
    'cargo_drop': {
        'label': {'tr': 'Yük bırakma', 'en': 'Cargo drop'}, 'engine': 'fly', 'multiplayer': False, 'players': [1, 1],
        'types': ['multirotor', 'fpv', 'heli', 'vtol', 'plane'], 'requires': {'addon': 'gripper'}, 'ai': {'single': 0, 'recommended': 0, 'max': 0, 'kind': None},
        'scoring': [{'key': 'release', 'points': 'sunucuda kaydedilen servo tetik (yük bırakıldı) +40'},
                    {'key': 'accuracy', 'points': 'yükün düştüğü nokta hedefe ≤ 5 m: +120, ≤ 15 m: +70, ≤ 30 m: +30'},
                    {'key': 'mission', 'points': 'görev noktaları tamamlama oranı × 50 (+50 tamamı)'}]},
    'spraying': {
        'label': {'tr': 'Tarla ilaçlama', 'en': 'Crop spraying'}, 'engine': 'fly', 'mission_kind': 'spray', 'multiplayer': False, 'players': [1, 1],
        'types': ['multirotor', 'heli'], 'requires': {'addon': 'sprayer'}, 'ai': {'single': 0, 'recommended': 0, 'max': 0, 'kind': None},
        'scoring': [{'key': 'mission', 'points': 'ilaçlama rotası tamamlama oranı × 100 (+60 tamamı)'},
                    {'key': 'discipline', 'points': 'uyarı disiplini puanı × 0,5'}, {'key': 'soft_landing', 'points': '+25 kazasız iniş'}]},
    'dogfight': {
        'label': {'tr': 'İt dalaşı', 'en': 'Dogfight'}, 'engine': 'match', 'match_kind': 'dogfight', 'multiplayer': True, 'players': [2, 2],
        'types': ['multirotor', 'fpv', 'plane', 'interceptor', 'heli', 'vtol'], 'requires': {},
        'ai': {'single': 1, 'recommended': 1, 'max': 1, 'kind': 'pilot'},
        'scoring': [{'key': 'win', 'points': 'galibiyet 150, mağlubiyet 30 (HUD kilit süresiyle)'}, {'key': 'bots_only', 'points': 'yapay zekâya karşı × 0,5'}]},
    'facility_defense': {
        'label': {'tr': 'Kritik tesis savunma', 'en': 'Critical facility defense'}, 'engine': 'fly', 'defend': True, 'multiplayer': False, 'players': [1, 1],
        'types': ['interceptor'], 'requires': {'site': 'station'}, 'ai': {'single': 'waves', 'recommended': 'waves', 'max': 8 * 10, 'kind': 'target_drone'},
        'scoring': [{'key': 'defense', 'points': 'savunma puanı (önlenen tehdit, tesis sağlığı, harcanan interceptor) × 0,2 (≤ 400)'},
                    {'key': 'lock', 'points': 'HUD kilidiyle temas: puan çekirdekte (§40)'}, {'key': 'success', 'points': '+80 savunma başarılı'}]},
    'ship_defense': {
        'label': {'tr': 'Gemi savunma', 'en': 'Ship defense'}, 'engine': 'fly', 'defend': True, 'multiplayer': False, 'players': [1, 1],
        'types': ['interceptor'], 'requires': {'site': 'station', 'world': 'water'}, 'ai': {'single': 'waves', 'recommended': 'waves', 'max': 8 * 10, 'kind': 'target_drone'},
        'scoring': [{'key': 'defense', 'points': 'savunma puanı × 0,2 (≤ 400)'}, {'key': 'lock', 'points': 'HUD kilidiyle temas (§40)'},
                    {'key': 'success', 'points': '+80 gemi korundu'}]},
}
MODE_IDS = tuple(MODES)
KIND_TO_MODE = {'rings': 'rings', 'dogfight': 'dogfight', 'fpv': 'rings'}


class ModHata(ValueError):
    pass


def dogrula(mode, engine=None, drone_type=None):
    """None → None (eski istemci: türün varsayılanı). Bilinmeyen / yanlış motor / araç tipi uymuyor → ModHata."""
    if mode is None or mode == '':
        return None
    if mode not in MODES:
        raise ModHata(f"mode {' | '.join(MODE_IDS)} olmalı")
    m = MODES[mode]
    if engine is not None and m['engine'] != engine:
        raise ModHata(f"'{mode}' türü {'karşılaşma (/api/match)' if m['engine'] == 'match' else 'uçuş (/api/fly/start)'} ile başlatılır")
    if drone_type is not None and m['types'] is not None and drone_type not in m['types']:
        raise ModHata(f"'{mode}' türü için araç tipi {', '.join(m['types'])} olmalı")
    return mode


def ai_onerisi(mode, players=1, defend_waves=None):
    """Kaç yapay zekâ oyuncu eklenmeli. Tek oyunculu: `single` (savunmada dalga planındaki tehdit sayısı); çok oyunculu: dolmayan yuvalar için öneri."""
    m = MODES[mode]
    a = m['ai']
    if a['kind'] == 'target_drone':
        waves = int(defend_waves or 3)
        # flightsim_gcs ZORLUK 'normal': ilk dalga 2 tehdit, her dalga +1 (≤ 8)
        n = sum(min(8, 2 + i) for i in range(waves))
        return {'mode': mode, 'kind': 'target_drone', 'count': n, 'auto': True, 'note': 'Gelen hedef dronları sunucu üretir (dalga planı)'}
    players = max(1, int(players or 1))
    if players <= 1:
        return {'mode': mode, 'kind': a['kind'], 'count': int(a['single']), 'auto': bool(a['single'])}
    ust = m['players'][1]
    return {'mode': mode, 'kind': a['kind'], 'count': max(0, min(int(a['max']), ust - players)) if a['kind'] else 0, 'auto': False}


def katalog(lang='tr'):
    out = []
    for k, m in MODES.items():
        out.append({'id': k, 'label': m['label'].get(lang) or m['label']['tr'], 'labels': m['label'], 'engine': m['engine'], 'match_kind': m.get('match_kind'),
                    'mission_kind': m.get('mission_kind'), 'defend': bool(m.get('defend')), 'multiplayer': m['multiplayer'], 'players': m['players'],
                    'types': m['types'], 'requires': m['requires'], 'ai': m['ai'], 'scoring': m['scoring'],
                    'engagement': ENGAGEMENT_RULE if m.get('defend') or k == 'dogfight' else None})
    return out


def _kat(v, d=0.0):
    try:
        return float(v)
    except (TypeError, ValueError):
        return d


def ucus_bilesenleri(summary, duration_s=None, result=None):
    """Tür bağımsız uçuş bileşenleri (sunucu özeti). Dönüş {air_time, distance, discipline, soft_landing, mission, defense, targets}."""
    s = summary or {}
    fl = s.get('flight') or {}
    air = _kat(fl.get('air_s'), 0.0) if fl.get('air_s') is not None else 0.0
    dist = _kat(fl.get('dist_m'))
    parts = {'air_time': int(min(270, air // 10)), 'distance': int(min(200, dist // 100))}
    dur = _kat(fl.get('duration_s') or duration_s)
    al = s.get('alerts') or {}
    if al.get('score') is not None and dur >= 60:
        parts['discipline'] = int(max(0, min(50, _kat(al['score']) * 0.5)))
    crash_n = int(s.get('crash_count') or 0)
    son = fl.get('last_pos') or {}
    if result == 'ok' and crash_n == 0 and air >= 20 and not fl.get('armed') and abs(_kat(son.get('alt_rel'), 99)) <= 2.0:
        parts['soft_landing'] = 25 + (15 if (s.get('deviation') or {}).get('in_circle') else 0)
    mi = s.get('mission') or {}
    if mi.get('count'):
        oran = max(0.0, min(1.0, _kat(mi.get('completed')) / max(1.0, _kat(mi.get('count'), 1))))
        parts['mission'] = int(round(oran * 50)) + (50 if oran >= 1.0 else 0)
    df = s.get('defend') or {}
    if df:
        parts['defense'] = int(min(400, max(0, _kat(df.get('score')) * 0.2))) + (80 if df.get('success') else 0)
    tg = s.get('targets') or {}
    if tg.get('score'):
        parts['targets'] = int(min(300, max(0, _kat(tg['score']) * 0.1)))
    return parts


def puanla(mode, summary, duration_s=None, result=None):
    """Tür puanı (uçuş): ucus_bilesenleri + türe özgü (yük bırakma isabeti, ilaçlama oranı)."""
    parts = ucus_bilesenleri(summary, duration_s, result)
    s = summary or {}
    if mode == 'cargo_drop':
        st = s.get('servo_trigger') or {}
        if st.get('trigger'):
            parts['release'] = 40
            hit = st.get('hit') or {}
            end = (s.get('mission') or {}).get('end') or None
            d = None
            if hit.get('lat') is not None and end and end.get('lat') is not None:
                from ..flightsim_mission import mesafe_m
                d = mesafe_m(hit['lat'], hit['lon'], end['lat'], end['lon'])
            elif hit.get('dist_m') is not None:
                d = _kat(hit.get('dist_m'), None)
            if d is not None:
                parts['accuracy'] = 120 if d <= 5 else 70 if d <= 15 else 30 if d <= 30 else 0
    elif mode == 'spraying' and 'mission' in parts:
        mi = s.get('mission') or {}
        oran = max(0.0, min(1.0, _kat(mi.get('completed')) / max(1.0, _kat(mi.get('count'), 1))))
        parts['mission'] = int(round(oran * 100)) + (60 if oran >= 1.0 else 0)
    return parts


def mac_puani(kind, rank, finished, rings, won, humans, n_all):
    """Karşılaşma bileşeni (match_players satırı, sunucu çekirdeği). Tek kişilik zaman denemesi: yalnız bitirme 20."""
    if n_all <= 1:
        return {'match_finish': 20} if finished else {}
    p = {}
    if kind == 'dogfight':
        p['match_rank'] = 150 if won else 30
    else:
        if rings:
            p['rings'] = int(min(250, 5 * int(rings)))
        if finished and rank:
            p['match_rank'] = {1: 100, 2: 60, 3: 40}.get(int(rank), 20)
        if won:
            p['win'] = 50
    if humans < 2:
        p = {k: int(v * 0.5) for k, v in p.items()}
    return p
