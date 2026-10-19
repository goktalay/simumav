"""Uçuş Simülatörü ↔ Canlı Uçuş hub'ı köprüsü (docs/ucus-simulatoru.md §14).

Simülatör oturumu (flightsim.SimSession) açılınca drone_hub'a bir SANAL KÖPRÜ kaynağı olarak kaydedilir (SimBridge): SITL'den gelen
MAVLink mesajları gerçek köprü kalıbıyla `drone_hub._feed_msgs`'e akar (DroneState, STATUSTEXT olayları, COMMAND_ACK konsol satırları),
harekât ekranı (static/ops) `/ws/drone/live` üzerinden `{t:'watch', sim_id}` ile oturuma bağlanır ve `{t:'cmd', bridge_id: -(9000+N)}`
komutları hub'ın komut işleyicisinden (GÖKTUNGU kalkış/görev akışları dâhil) `SimSession.hub_komut` → SITL'e gider.

Kimlikler: bridge_id = -SimSession.kimlik = -(9000 + oturum no) (saha görevlerinin sanal dronları -drone_id; 9000 tabanı çakışmayı önler).
Harekât ekranı için sahte görev bağlamı: task {id: null, sim_id, code: 'SİM #N', …}, flights [{id: kimlik, protocol: 'sanal', sim_bridge_id}].
Yetki: izleme `drone.sim`; komut `drone.sim` YAZMA izni (field.live / Pilot rolü gerekmez — SimBridge.can_command).

MavKomut: Hepgo Dron Köprüsü çekirdeğinin (bridge/dron_koprusu/kopru_core.MavLink.execute) ASENKRON karşılığı; SITL'in SERIAL0 bağlantısı
SimSession'da tek olduğu için (ikinci istemci kabul edilmez) komutlar oturumun kendi TCP yazıcısıyla gönderilir, yanıtlar `_isle` içindeki
bekleyici kuyruklarından okunur. Sözleşme kopru_core ile aynı: ACK 0/5 kabul; red → RuntimeError('… MAV_RESULT n'); mission_upload başa ev (+ hız)
öğesi ekler ve {'count', 'uploaded', 'offset'} döndürür (DO_JUMP hedefleri kaydırılır).
"""
import asyncio
import time

from . import db, drone_hub

MODUL = 'drone.sim'
CAPS = ['set_home', 'param', 'mission_set_current', 'altitude_change', 'arm_force', 'mission_start', 'mission_clear']
NAV_CMDS = (16, 19, 20, 21, 22, 31, 82)   # 3B rota çizimi: WAYPOINT, LOITER_TIME, RTL, LAND, TAKEOFF, LOITER_TO_ALT, SPLINE_WAYPOINT


class SimBridge:
    """Simülatör oturumunun hub'daki köprü yüzeyi (drone_hub.Bridge / SitlDrone ile aynı alanlar: _emit, console_line, arm_check_report,
    send_command, hello_msg değişmeden çalışır)."""

    def __init__(self, s):
        self.s = s
        self.id = -int(s.kimlik)
        self.sim_id = int(s.id)
        self.drone = dict(s.drone) if getattr(s, 'drone', None) else None
        self.drone_id = self.drone.get('id') if self.drone else None
        self.task_id = None                     # saha görevi yok (hub _refresh_task / SIM_IDLE denetimleri bu kaynağı etkilemez)
        self.flight_id = int(s.kimlik)
        self.sysid = 1
        self.name = (f"{self.drone.get('code') or ''} {self.drone.get('name') or ''}".strip() if self.drone else '') or f'Simülatör #{self.sim_id}'
        self.host, self.platform, self.ver = 'sunucu', 'simulator', 'ArduPilot SITL' if s.sahte is None else 'sahte kinematik'
        self.caps = list(CAPS)
        self.session_id, self.packets, self.connected_at, self.last_seen = None, 0, db.now(), time.time()
        self.closing, self.log, self.tlog, self.tlog_path = None, None, None, None
        self.parser = drone_hub._mav()
        self.drones = {}
        self.task = None

    # --- Bridge yüzeyi ---
    def info(self):
        return {'bridge_id': self.id, 'name': self.name, 'host': self.host, 'platform': self.platform, 'bridge_ver': self.ver, 'caps': self.caps,
                'connected_at': self.connected_at, 'packets': self.packets, 'session_id': None, 'sim': True, 'simulator': True, 'sim_id': self.sim_id,
                'drone_id': self.drone_id, 'task_id': None, 'flight_id': self.flight_id, 'drones': {str(k): st.d for k, st in self.drones.items()}}

    def can_command(self, user):
        return MODUL in (user.get('write_modules') or [])

    def feed(self, data):
        """Ham MAVLink baytları (sahte kip: kodlanmış çerçeveler)."""
        self.packets += 1
        self.last_seen = time.time()
        drone_hub._feed_mavlink(self, data)

    def feed_msgs(self, msgs):
        """Oturumun zaten ayrıştırdığı mesajlar (gerçek SITL; ikinci ayrıştırma yok)."""
        self.packets += len(msgs)
        self.last_seen = time.time()
        drone_hub._feed_msgs(self, msgs)

    def _publish(self):
        for st in list(self.drones.values()):
            drone_hub._emit(self, st, force=True)

    def _event(self, text, severity=6):
        drone_hub._broadcast({'t': 'event', 'bridge_id': self.id, 'sysid': self.sysid, 'text': text, 'severity': severity, 'ts': time.time()}, self.id)
        drone_hub.console_line(self, self.sysid, 'SİM', text, 'hata' if severity <= 3 else 'uyari' if severity == 4 else 'bilgi')

    async def acommand(self, name, params):
        return await self.s.hub_komut(name, params)

    def command(self, name, params):
        return {'ok': False, 'error': 'Simülatör komutu eşzamansız yürütülür'}

    # --- harekât ekranı bağlamı (hello.task / hello.flights ve GET /sessions/{id}/live) ---
    def task_info(self):
        c = self.s.center or {}
        return {'id': None, 'sim_id': self.sim_id, 'code': f'SİM #{self.sim_id}', 'status': 'GOREVDE' if self.s.state != 'KAPANDI' else 'TAMAMLANDI',
                'location_name': c.get('name'), 'lat': c.get('lat'), 'lon': c.get('lon'), 'simulator': True, 'sim_state': self.s.state}

    def flight_info(self):
        d = self.drone or {}
        return {'id': self.flight_id, 'order_id': None, 'drone_id': self.drone_id, 'label': d.get('code') or f'SİM-{self.sim_id}',
                'name': d.get('name') or f'Simülatör #{self.sim_id}', 'protocol': 'sanal', 'sysid': self.sysid, 'bridge_id': None, 'bridge_name': None,
                'bridge_online': True, 'drone_model': d.get('model'), 'link': None, 'sim_bridge_id': self.id, 'simulator': True, 'sim_id': self.sim_id}


# ---------------- oturum yaşam döngüsü ----------------
def attach(s):
    """Oturum hub'a kaydolur (SITL/UDP açıldıktan sonra, HAZIR'dan bağımsız): izleyiciler köprüyü çevrimiçi görür."""
    if getattr(s, 'hub', None) is not None:
        return s.hub
    b = SimBridge(s)
    s.hub = b
    drone_hub.SIMS[b.id] = b
    drone_hub._broadcast({'t': 'bridge', 'bridge_id': b.id, 'online': True, 'info': b.info()}, b.id)
    b._event(f'Simülatör oturumu #{s.id} harekât paneline bağlandı · {b.name}', 6)
    return b


def detach(s, status='KAPANDI'):
    b = getattr(s, 'hub', None)
    if b is None:
        return
    s.hub = None
    if drone_hub.SIMS.get(b.id) is b:
        drone_hub.SIMS.pop(b.id, None)
    for rid, (fut, _vw, bid) in list(drone_hub._pending.items()):
        if not fut.done() and bid == b.id:
            fut.set_exception(RuntimeError('Simülatör oturumu kapandı'))
    drone_hub._broadcast({'t': 'bridge', 'bridge_id': b.id, 'online': False, 'status': status}, b.id)


def bridge_of(sim_id):
    """Oturum no → SimBridge (yoksa None)."""
    from . import flightsim
    s = flightsim.MANAGER.get(sim_id)
    return getattr(s, 'hub', None) if s is not None else None


def apply_viewer(v, sim_id):
    """/ws/drone/live {t:'watch', sim_id}: izleyici yalnız bu oturumun köprüsünü görür (saha görevi bağlamı kalıbı)."""
    b = bridge_of(sim_id)
    if b is None:
        return None
    v.task_id, v.watch = None, None
    v.sim_id = b.sim_id
    v.allowed = {b.id}
    v.task = b.task_info()
    v.flights = [b.flight_info()]
    return b


def live_payload(s, user):
    """GET /api/drone/sim/sessions/{id}/live — harekât ekranının (hepgo_ws.js) /api/field/tasks/{id}/live ile aynı biçimi."""
    b = getattr(s, 'hub', None)
    if b is None:
        return None
    return {'task': b.task_info(), 'flights': [b.flight_info()], 'can_command': b.can_command(user), 'session': s.to_dict()}


# ---------------- MAVLink komut yürütücü (asenkron; kopru_core.MavLink.execute karşılığı) ----------------
class MavKomut:
    """SimSession üzerinde çalışır: s._gonder (TCP yazıcı), s.bekleyici (mesaj kuyruğu), s.sysid/comp/vtype/tele/param_types."""

    def __init__(self, s):
        self.s = s
        self.mis_off = 1

    # --- yardımcılar ---
    def _d(self):
        from pymavlink.dialects.v20 import ardupilotmega as d
        return d

    def _modes(self):
        from pymavlink import mavutil
        s = self.s
        vt = s.vtype if s.vtype is not None else (1 if s.type in ('sabit_kanat', 'vtol') else 2)
        return mavutil.mode_mapping_byname(vt) or {}

    def _plane(self):
        s = self.s
        return (s.vtype in (1, 19, 20, 21, 22, 23, 24, 25)) if s.vtype is not None else s.type in ('sabit_kanat', 'vtol')

    async def _cmd_long(self, cmd, p=(0, 0, 0, 0, 0, 0, 0), timeout=4.0):
        s = self.s
        tgt = s.sysid
        with s.bekleyici(('COMMAND_ACK',), lambda m: m.command == cmd) as q:
            for _ in range(2):
                s._gonder(s.mav.command_long_encode(tgt, s.comp, cmd, 0, *[float(x) for x in p]))
                ack = await _al(q, timeout / 2)
                if ack is not None:
                    if ack.result in (0, 5):
                        return {'ack': int(ack.result)}
                    raise RuntimeError(f'Dron komutu reddetti (MAV_RESULT {ack.result})')
        raise RuntimeError('Dron komuta yanıt vermedi')

    async def _set_mode(self, mode):
        mode = str(mode or '').upper()
        modes = self._modes()
        if mode not in modes:
            raise RuntimeError(f'Bilinmeyen uçuş modu: {mode}')
        await self._cmd_long(176, (1, modes[mode], 0, 0, 0, 0, 0))
        return {'mode': mode}

    async def _goto(self, lat, lon, alt, speed):
        s = self.s
        if speed:
            try:
                await self._cmd_long(178, (1, float(speed), -1, 0, 0, 0, 0), 2)
            except Exception:   # noqa: BLE001
                pass
        if self._plane():
            s._gonder(s.mav.mission_item_int_encode(s.sysid, s.comp, 0, 6, 16, 2, 1, 0, 0, 0, 0, int(lat * 1e7), int(lon * 1e7), alt))
        else:
            if 'GUIDED' in self._modes() and str(s.tele.get('mode') or '').upper() != 'GUIDED':
                await self._set_mode('GUIDED')
            s._gonder(s.mav.set_position_target_global_int_encode(0, s.sysid, s.comp, 6, 0b110111111000, int(lat * 1e7), int(lon * 1e7), alt,
                                                                   0, 0, 0, 0, 0, 0, 0, 0))
        return {'lat': lat, 'lon': lon, 'alt_rel_m': alt}

    async def _param_set(self, name, value, ptype):
        s = self.s
        ptype = int(ptype) if ptype else s.param_types.get(name)
        if not ptype:   # tip bilinmiyor: önce oku (kopru_core 'type_unknown' verirdi; SITL'de okunabilir)
            r = await self._param_get(name)
            ptype = int(r['type'])
        with s.bekleyici(('PARAM_VALUE',), lambda m: str(m.param_id).rstrip('\x00') == name) as q:
            for _ in range(3):
                s._gonder(s.mav.param_set_encode(s.sysid, s.comp, name.encode(), float(value), ptype))
                v = await _al(q, 2)
                if v is not None:
                    return {'name': name, 'value': v.param_value, 'type': v.param_type}
        raise RuntimeError('Parametre yazılamadı')

    async def _param_get(self, name):
        s = self.s
        with s.bekleyici(('PARAM_VALUE',), lambda m: str(m.param_id).rstrip('\x00') == name) as q:
            for _ in range(3):
                s._gonder(s.mav.param_request_read_encode(s.sysid, s.comp, name.encode(), -1))
                v = await _al(q, 2)
                if v is not None:
                    return {'name': name, 'value': v.param_value, 'type': v.param_type}
        raise RuntimeError('Parametre okunamadı')

    async def _mission_upload(self, items, cruise_speed):
        s = self.s
        te = s.tele
        first = items[0] if items else {}
        home = {'frame': 0, 'command': 16, 'current': 0, 'autocontinue': 1, 'param1': 0, 'param2': 0, 'param3': 0, 'param4': 0,
                'x': int(te['lat'] * 1e7) if te.get('lat') else int(first.get('x') or 0), 'y': int(te['lon'] * 1e7) if te.get('lon') else int(first.get('y') or 0), 'z': 0.0}
        seq_items = [home] + [dict(i) for i in items]
        if cruise_speed:
            seq_items.insert(1, {'frame': 2, 'command': 178, 'current': 0, 'autocontinue': 1, 'param1': 1, 'param2': float(cruise_speed), 'param3': -1, 'param4': 0, 'x': 0, 'y': 0, 'z': 0.0})
        off = len(seq_items) - len(items)
        self.mis_off = off
        for it in seq_items[off:]:
            if int(it.get('command') or 0) == 177:
                it['param1'] = float(it.get('param1') or 0) + off
        n = len(seq_items)
        with s.bekleyici(('MISSION_REQUEST_INT', 'MISSION_REQUEST', 'MISSION_ACK')) as q:
            s._gonder(s.mav.mission_count_encode(s.sysid, s.comp, n, 0))
            sent = set()
            while True:
                msg = await _al(q, 5)
                if msg is None:
                    if not sent:
                        s._gonder(s.mav.mission_count_encode(s.sysid, s.comp, n, 0))
                        msg = await _al(q, 5)
                    if msg is None:
                        raise RuntimeError(f'Görev yükleme zaman aşımı ({len(sent)}/{n})')
                if msg.get_type() == 'MISSION_ACK':
                    if msg.type == 0:
                        return {'count': len(items), 'uploaded': n, 'offset': off}
                    raise RuntimeError(f'Dron görevi reddetti (MAV_MISSION_RESULT {msg.type})')
                sq = msg.seq
                if sq >= n:
                    continue
                it = seq_items[sq]
                s._gonder(s.mav.mission_item_int_encode(s.sysid, s.comp, sq, int(it.get('frame', 6)), int(it.get('command', 16)), 1 if sq == 1 else 0,
                                                        int(it.get('autocontinue', 1)), float(it.get('param1', 0)), float(it.get('param2', 0)),
                                                        float(it.get('param3', 0)), float(it.get('param4', 0)), int(it.get('x', 0)), int(it.get('y', 0)),
                                                        float(it.get('z', 0)), 0))
                sent.add(sq)

    async def _mission_download(self):
        s = self.s
        with s.bekleyici(('MISSION_COUNT', 'MISSION_ITEM_INT')) as q:
            s._gonder(s.mav.mission_request_list_encode(s.sysid, s.comp, 0))
            cnt = await _al(q, 5)
            while cnt is not None and cnt.get_type() != 'MISSION_COUNT':
                cnt = await _al(q, 5)
            if cnt is None:
                raise RuntimeError('Görev listesi alınamadı')
            out = []
            for sq in range(cnt.count):
                it = None
                for _ in range(3):
                    s._gonder(s.mav.mission_request_int_encode(s.sysid, s.comp, sq, 0))
                    it = await _al(q, 2)
                    while it is not None and (it.get_type() != 'MISSION_ITEM_INT' or it.seq != sq):
                        it = await _al(q, 2)
                    if it is not None:
                        break
                if it is None:
                    raise RuntimeError(f'Görev öğesi {sq} alınamadı')
                if sq == 0:
                    continue
                out.append({'seq': len(out), 'frame': it.frame, 'command': it.command, 'current': it.current, 'autocontinue': it.autocontinue,
                            'param1': it.param1, 'param2': it.param2, 'param3': it.param3, 'param4': it.param4, 'x': it.x, 'y': it.y, 'z': it.z, 'mission_type': 0})
            s._gonder(s.mav.mission_ack_encode(s.sysid, s.comp, 0, 0))
            return {'items': out, 'count': int(cnt.count)}   # count: SITL'deki toplam öğe (ev dâhil; §18 MISSION_CURRENT.total karşılaştırması)

    async def _mission_clear(self):
        s = self.s
        with s.bekleyici(('MISSION_ACK',)) as q:
            s._gonder(s.mav.mission_clear_all_encode(s.sysid, s.comp, 0))
            ack = await _al(q, 5)
        if ack is None:
            raise RuntimeError('Görev listesi temizleme onayı gelmedi')
        if ack.type != 0:
            raise RuntimeError(f'Görev listesi temizlenemedi (MAV_MISSION_RESULT {ack.type})')
        return {'cleared': True}

    # --- giriş ---
    async def execute(self, name, p):
        s = self.s
        p = p or {}
        if name == 'arm':
            return await self._cmd_long(400, (1, 21196 if p.get('force') else 0, 0, 0, 0, 0, 0), 6)
        if name == 'disarm':
            return await self._cmd_long(400, (0, 21196 if p.get('force') else 0, 0, 0, 0, 0, 0), 6)
        if name == 'set_mode':
            return await self._set_mode(p.get('mode'))
        if name == 'takeoff':
            alt = float(p.get('alt_rel_m') or 30)
            if not self._plane() and 'GUIDED' in self._modes() and str(s.tele.get('mode') or '').upper() != 'GUIDED':
                await self._set_mode('GUIDED')
            return await self._cmd_long(22, (0, 0, 0, 0, 0, 0, alt), 6)
        if name == 'land':
            modes = self._modes()
            if 'LAND' in modes or 'QLAND' in modes:
                return await self._set_mode('QLAND' if self._plane() and 'QLAND' in modes else 'LAND')
            return await self._cmd_long(21)
        if name == 'rtl':
            return await self._set_mode('RTL')
        if name == 'goto':
            return await self._goto(float(p['lat']), float(p['lon']), float(p.get('alt_rel_m') or 30), p.get('speed_mps'))
        if name == 'altitude_change':
            alt = float(p['alt_rel_m'])
            if self._plane():
                return await self._cmd_long(186, (alt, 3, 0, 0, 0, 0, 0))
            if not s.tele.get('lat'):
                raise RuntimeError('Konum bilinmiyor')
            return await self._goto(float(s.tele['lat']), float(s.tele['lon']), alt, None)
        if name == 'set_home':
            if p.get('lat') is None:
                return await self._cmd_long(179, (1, 0, 0, 0, 0, 0, 0))
            return await self._cmd_long(179, (0, 0, 0, 0, float(p['lat']), float(p['lon']), float(p.get('alt') or 0)))
        if name == 'mission_upload':
            return await self._mission_upload(p.get('items') or [], p.get('cruise_speed'))
        if name == 'mission_download':
            return await self._mission_download()
        if name == 'mission_start':
            return await self._cmd_long(300, (0, 0, 0, 0, 0, 0, 0), 6)
        if name == 'mission_clear':
            return await self._mission_clear()
        if name == 'mission_set_current':
            s._gonder(s.mav.mission_set_current_encode(s.sysid, s.comp, int(p['seq']) + self.mis_off))
            return {'seq': int(p['seq'])}
        if name == 'param_list':
            s._gonder(s.mav.param_request_list_encode(s.sysid, s.comp))
            return {'requested': True}
        if name == 'param_get':
            return await self._param_get(str(p['name']))
        if name == 'param_set':
            return await self._param_set(str(p['name']), float(p['value']), p.get('type'))
        if name == 'reboot':
            raise RuntimeError('Simülatörde yeniden başlatma için "Sıfırla" kullanın')
        raise RuntimeError(f'Desteklenmeyen komut: {name}')


async def _al(q, timeout):
    try:
        return await asyncio.wait_for(q.get(), timeout)
    except asyncio.TimeoutError:
        return None


def rota_noktalari(items, offset=0):
    """Görev öğeleri → 3B rota çizimi için [{seq, cmd, lat, lon, alt, alt_rel, frame}] (yalnız konumlu seyrüsefer öğeleri). `seq` SITL seq'idir:
    öğenin kendi seq'i + `offset` (HEPGO yüklemesinde ev/hız öğeleri; SITL'den indirilen listede ev atlandığı için 1) → MISSION_CURRENT ile eşleşir.
    alt/alt_rel: frame 3/6 (göreli) m; frame 0/5 (MSL) öğeler de olduğu gibi aktarılır (ön yüz ev irtifasıyla düzeltir)."""
    out = []
    for it in items or []:
        try:
            cmd = int(it.get('command') or 0)
            x, y = int(it.get('x') or 0), int(it.get('y') or 0)
        except (TypeError, ValueError):
            continue
        if cmd not in NAV_CMDS or (not x and not y):
            continue
        z = float(it.get('z') or 0)
        out.append({'seq': int(it.get('seq', len(out))) + int(offset or 0), 'cmd': cmd, 'lat': x / 1e7, 'lon': y / 1e7, 'alt': z, 'alt_rel': z, 'frame': int(it.get('frame', 6) or 0)})
    return out
