"""Sahte hesap servisi (mastertool.download) — SIMUMAV destek köprüsü testleri için: `/api/sv/tickets*` uçlarını X-Simumav-Secret + user_id ile
bellek içinde taklit eder (Merkez'in `/api/federation/mastertool/*` görünümü: id, code T-000n, subject, status, category, app, unread, messages).
Denetim uçları: `POST /__fake/reply/<id>` {body} → destek yanıtı ekler (status yanit_bekliyor → acik, unread+1); `POST /__fake/close/<id>`;
`GET /__fake/calls` → alınan istekler. Thread içinde (`serve(port)`) ya da alt süreç olarak: `python -m tests.simumav_fake_mt --port N [--secret S]`."""
import argparse
import json
import os
import threading
from datetime import datetime
from http.server import BaseHTTPRequestHandler, HTTPServer, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

SECRET = os.environ.get('FAKE_MT_SECRET', 'sv-gizli')
USERS = {4242: {'email': 'ali@test.com', 'name': 'Ali Pilot'}}
STATE = {'tickets': {}, 'calls': [], 'next': 1}
_LOCK = threading.Lock()


def _now():
    return datetime.now().isoformat(timespec='seconds')


def _view(t, full=False):
    out = {'id': t['id'], 'code': t['code'], 'subject': t['subject'], 'status': t['status'], 'category': t['category'], 'app': t['app'],
           'unread': t['unread'], 'created_at': t['created_at'], 'updated_at': t['updated_at']}
    if full:
        out['messages'] = list(t['messages'])
    return out


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _send(self, code, obj):
        raw = json.dumps(obj, ensure_ascii=False).encode()
        self.send_response(code); self.send_header('Content-Type', 'application/json'); self.send_header('Content-Length', str(len(raw))); self.end_headers()
        self.wfile.write(raw)

    def _body(self):
        n = int(self.headers.get('Content-Length') or 0)
        return json.loads(self.rfile.read(n) or b'{}') if n else {}

    def _user(self, q, body):
        if self.headers.get('X-Simumav-Secret') != SECRET:
            self._send(403, {'code': 'forbidden', 'message': 'Yetkisiz', 'detail': 'Yetkisiz'}); return None
        uid = body.get('user_id', (q.get('user_id') or [None])[0])
        try:
            uid = int(uid)
        except (TypeError, ValueError):
            self._send(422, {'code': 'invalid', 'message': 'user_id gerekir', 'detail': 'user_id gerekir'}); return None
        u = USERS.get(uid) or ({'email': f'dev{abs(uid)}@dev.simumav.local', 'name': f'dev{abs(uid)}'} if uid < 0 else None)
        if not u:
            self._send(404, {'code': 'not_found', 'message': 'Kullanıcı bulunamadı', 'detail': 'Kullanıcı bulunamadı'}); return None
        return {'id': uid, **u}

    def do_GET(self):
        u = urlparse(self.path); q = parse_qs(u.query); parts = u.path.strip('/').split('/')
        with _LOCK:
            STATE['calls'].append(('GET', u.path, dict(self.headers), None))
            if u.path == '/__fake/calls':
                return self._send(200, [{'method': m, 'path': p, 'secret': h.get('X-Simumav-Secret'), 'body': b} for m, p, h, b in STATE['calls']])
            if parts[:3] == ['api', 'sv', 'tickets']:
                user = self._user(q, {})
                if not user:
                    return
                if len(parts) == 3:
                    rows = [_view(t) for t in sorted(STATE['tickets'].values(), key=lambda t: t['updated_at'], reverse=True) if t['email'] == user['email']]
                    return self._send(200, rows)
                t = STATE['tickets'].get(int(parts[3]))
                if not t or t['email'] != user['email']:
                    return self._send(404, {'code': 'support_error', 'message': 'Talep bulunamadı', 'detail': 'Talep bulunamadı'})
                t['unread'] = 0
                return self._send(200, _view(t, True))
        self._send(404, {'code': 'not_found', 'message': 'Bulunamadı'})

    def do_POST(self):
        u = urlparse(self.path); q = parse_qs(u.query); parts = u.path.strip('/').split('/')
        body = self._body()
        with _LOCK:
            STATE['calls'].append(('POST', u.path, dict(self.headers), body))
            if parts[:2] == ['__fake', 'reply']:
                t = STATE['tickets'][int(parts[2])]
                t['messages'].append({'id': len(t['messages']) + 1, 'author_kind': 'support', 'author_name': body.get('name') or 'Merkez Destek', 'body': body.get('body') or 'Merhaba, inceliyoruz.', 'created_at': _now()})
                t['status'] = 'acik'; t['unread'] += 1; t['updated_at'] = _now()
                return self._send(200, _view(t, True))
            if parts[:2] == ['__fake', 'close']:
                t = STATE['tickets'][int(parts[2])]; t['status'] = 'kapali'; t['updated_at'] = _now()
                return self._send(200, _view(t, True))
            if parts[:3] == ['api', 'sv', 'tickets']:
                user = self._user(q, body)
                if not user:
                    return
                if len(parts) == 3:
                    if not str(body.get('subject') or '').strip() or not str(body.get('body') or '').strip():
                        return self._send(400, {'code': 'support_error', 'message': 'Konu ve açıklama gerekli', 'detail': 'Konu ve açıklama gerekli'})
                    tid = STATE['next']; STATE['next'] += 1
                    t = {'id': tid, 'code': f'T-{tid:04d}', 'subject': str(body['subject'])[:200], 'status': 'acik', 'category': body.get('category') or 'teknik',
                         'app': body.get('app') if body.get('app') in ('sv', 'sm', 'fm', 'mt') else 'mt', 'unread': 0, 'email': user['email'], 'created_at': _now(), 'updated_at': _now(),
                         'messages': [{'id': 1, 'author_kind': 'company', 'author_name': user['name'], 'body': str(body['body'])[:8000], 'created_at': _now()}]}
                    STATE['tickets'][tid] = t
                    return self._send(200, {'id': tid, 'code': t['code']})
                t = STATE['tickets'].get(int(parts[3]))
                if not t or t['email'] != user['email']:
                    return self._send(404, {'code': 'support_error', 'message': 'Talep bulunamadı', 'detail': 'Talep bulunamadı'})
                if parts[4:] == ['messages']:
                    if not str(body.get('body') or '').strip():
                        return self._send(400, {'code': 'support_error', 'message': 'Mesaj boş', 'detail': 'Mesaj boş'})
                    t['messages'].append({'id': len(t['messages']) + 1, 'author_kind': 'company', 'author_name': user['name'], 'body': str(body['body'])[:8000], 'created_at': _now()})
                    t['status'] = 'yanit_bekliyor'; t['unread'] = 0; t['updated_at'] = _now()
                    return self._send(200, _view(t, True))
                if parts[4:] == ['close']:
                    t['status'] = 'cozuldu'; t['updated_at'] = _now()
                    return self._send(200, _view(t, True))
        self._send(404, {'code': 'not_found', 'message': 'Bulunamadı'})


def serve(port=0):
    """Thread içinde başlat → (server, port)."""
    srv = HTTPServer(('127.0.0.1', port), Handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv, srv.server_address[1]


if __name__ == '__main__':
    ap = argparse.ArgumentParser(); ap.add_argument('--port', type=int, default=8613); ap.add_argument('--secret', default=SECRET)
    a = ap.parse_args(); SECRET = a.secret
    ThreadingHTTPServer(('127.0.0.1', a.port), Handler).serve_forever()
