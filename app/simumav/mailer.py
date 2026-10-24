"""SIMUMAV e-posta gönderici (karşılaşma davetleri). Önce SIMUMAV_* ayarlarını okur; yoksa Mastertool hesap servisinin (mastertool.download
üyelik e-postaları) MT_SMTP_HOST / MT_SMTP_PORT / MT_SMTP_USER / MT_SMTP_PASS / MT_MAIL_FROM ayarlarına düşer (aynı gönderici hesabı).

.env (hepsi isteğe bağlı; USER + PASS yoksa enabled() False → davet e-postası atlanır, bağlantı API yanıtında kurucuya döner):
  SIMUMAV_SMTP_HOST (vars. smtp.zoho.com) · SIMUMAV_SMTP_PORT (vars. 465 SSL; 587 STARTTLS) · SIMUMAV_SMTP_USER · SIMUMAV_SMTP_PASS
  SIMUMAV_MAIL_FROM (vars. SMTP_USER) · SIMUMAV_MAIL_FROM_NAME (vars. SIMUMAV)
  SIMUMAV_MAIL_TEST=1 → iletiler gönderilmez, OUTBOX'ta birikir (testler).
Gönderim arka plan iş parçacığında (istek bekletilmez); sonuç `match_invites.mail` sütununa yazılır (sent | failed)."""
import html as _h
import logging
import os
import smtplib
import ssl
import threading
from email.message import EmailMessage
from email.utils import formataddr

log = logging.getLogger('simumav.mail')
OUTBOX = []


def _ayar():
    e = os.environ
    g = lambda k, mt, d='': (e.get(k) or e.get(mt) or d) if mt else (e.get(k) or d)   # SIMUMAV_* yoksa Mastertool MT_* (aynı hesap)
    return {'host': (g('SIMUMAV_SMTP_HOST', 'MT_SMTP_HOST') or 'smtp.zoho.com').strip(), 'port': int(g('SIMUMAV_SMTP_PORT', 'MT_SMTP_PORT', '465') or 465),
            'user': g('SIMUMAV_SMTP_USER', 'MT_SMTP_USER').strip(), 'pass': g('SIMUMAV_SMTP_PASS', 'MT_SMTP_PASS'),
            'from': g('SIMUMAV_MAIL_FROM', 'MT_MAIL_FROM').strip(), 'name': g('SIMUMAV_MAIL_FROM_NAME', None).strip() or 'SIMUMAV'}


def test_kipi():
    return os.environ.get('SIMUMAV_MAIL_TEST') == '1'


def enabled():
    a = _ayar()
    return test_kipi() or bool(a['user'] and a['pass'])


def send(to, subject, text, html=None):
    if test_kipi():
        OUTBOX.append({'to': to, 'subject': subject, 'text': text, 'html': html})
        return
    a = _ayar()
    if not (a['user'] and a['pass']):
        raise RuntimeError('mail-disabled')
    msg = EmailMessage()
    msg['From'] = formataddr((a['name'], a['from'] or a['user']))
    msg['To'] = to
    msg['Subject'] = subject
    msg.set_content(text)
    if html:
        msg.add_alternative(html, subtype='html')
    ctx = ssl.create_default_context()
    if a['port'] == 465:
        with smtplib.SMTP_SSL(a['host'], a['port'], context=ctx, timeout=25) as s:
            s.login(a['user'], a['pass'])
            s.send_message(msg)
    else:
        with smtplib.SMTP(a['host'], a['port'], timeout=25) as s:
            s.ehlo()
            s.starttls(context=ctx)
            s.login(a['user'], a['pass'])
            s.send_message(msg)


def arka_planda(isler, bitti=None):
    """isler: [(anahtar, to, subject, text, html)] → sırayla gönderilir; bitti(anahtar, ok) her iletiden sonra çağrılır. Test kipinde eşzamanlı."""
    def calis():
        for anahtar, to, subject, text, html in isler:
            ok = True
            try:
                send(to, subject, text, html)
            except Exception as e:   # noqa: BLE001 — SMTP hatası isteği düşürmez
                ok = False
                log.warning('Davet e-postası gönderilemedi (%s): %s', anahtar, type(e).__name__)
            if bitti is not None:
                try:
                    bitti(anahtar, ok)
                except Exception:   # noqa: BLE001
                    pass
    if test_kipi():
        calis()
    else:
        threading.Thread(target=calis, name='simumav-mail', daemon=True).start()


MODE_ADLARI = {'free': 'Serbest uçuş', 'rings': 'Halka toplama', 'cargo_drop': 'Yük bırakma', 'spraying': 'Tarla ilaçlama', 'dogfight': 'İt dalaşı',
               'facility_defense': 'Kritik tesis savunma', 'ship_defense': 'Gemi savunma', 'fpv': 'FPV parkuru'}


def davet_iletisi(kurucu, mod, parkur, url, hesap_var, kayit_url, indir_url, son_saat):
    """(konu, metin, html). Kurucu adı kısaltılır ve kaçışlanır; kullanıcı serbest metni YOK (istenmeyen ileti aracı olmasın)."""
    ad = (kurucu or 'Bir pilot').strip()[:40]
    mod_ad = MODE_ADLARI.get(mod, 'Karşılaşma')
    konu = f'SIMUMAV: {ad} sizi bir karşılaşmaya davet etti'
    ek = '' if hesap_var else (f'\n\nHenüz SIMUMAV hesabınız yok: ücretsiz Mastertool hesabı açın ({kayit_url}) ya da oyunu indirin ({indir_url}); '
                               'ardından bu bağlantıyı yeniden açın.')
    metin = (f'Merhaba,\n\n{ad} sizi SIMUMAV\'da "{mod_ad}" karşılaşmasına davet etti (parkur: {parkur or "-"}).\n'
             f'Daveti kabul etmek ya da reddetmek için bağlantıyı açın ({son_saat} saat geçerli):\n{url}{ek}\n\n'
             'Bu daveti beklemiyorsanız yok sayabilirsiniz; oyunda "Bu kişiden davet alma" seçeneğiyle engelleyebilirsiniz.\n\n— SIMUMAV · simumav.com')
    e = _h.escape
    kayit = ('' if hesap_var else
             f'<p style="color:#c4cede">Henüz hesabınız yoksa: <a href="{e(kayit_url)}" style="color:#ff8a3d">ücretsiz hesap açın</a> · '
             f'<a href="{e(indir_url)}" style="color:#ff8a3d">oyunu indirin</a>, ardından bu daveti yeniden açın.</p>')
    html = f"""<div style="background:#0b0f17;padding:28px 12px;font-family:Segoe UI,Arial,sans-serif">
  <div style="max-width:520px;margin:auto;background:#131b2b;border:1px solid #1f2a40;border-radius:14px;padding:28px;color:#d6deeb">
    <div style="font-size:20px;font-weight:800;color:#fff">SIMUMAV</div>
    <h2 style="color:#fff;margin:20px 0 10px;font-size:19px">Karşılaşma daveti</h2>
    <p style="font-size:15px;line-height:1.6"><b>{e(ad)}</b> sizi <b>{e(mod_ad)}</b> karşılaşmasına davet etti (parkur: {e(parkur or '-')}).
    Bağlantı {int(son_saat)} saat geçerlidir.</p>
    <p style="margin:24px 0"><a href="{e(url)}" style="background:#ff6a00;color:#fff;text-decoration:none;font-weight:700;padding:12px 22px;border-radius:10px;display:inline-block">Daveti aç</a></p>
    {kayit}
    <p style="color:#8b98b0;font-size:12px;word-break:break-all">Düğme çalışmazsa: {e(url)}</p>
    <p style="color:#5b6b85;font-size:12px;margin-top:20px">Bu daveti beklemiyorsanız yok sayabilirsiniz. — SIMUMAV · simumav.com</p>
  </div></div>"""
    return konu, metin, html
