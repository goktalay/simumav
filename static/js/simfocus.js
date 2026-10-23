// Simülasyon odak kipi: HEPGO Uçuş Simülatörü sahnesi (.fs-stage) açıkken arka plan sistemi kullanıcının önüne bir şey çıkarmaz —
// bildirim/uyarı kartları (flash), masaüstü bildirimi, sistem sesleri, alarm penceresi, gelen arama ekranı, bekleme ekranı ve maskot
// bastırılır (dronun / HUD'un üstünü kapatıyorlardı). Bildirimler zil listesine düşmeye devam eder; alarm sahne kapanınca çalar.
export const simActive = () => typeof document !== 'undefined' && !!document.querySelector('.fs-stage');
