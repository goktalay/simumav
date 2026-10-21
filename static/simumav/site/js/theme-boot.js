// SIMUMAV tanıtım sitesi — tema ön yükleyici (klasik, eşzamanlı; <head> içinde src'li: CSP inline script yok).
// İlk boyamadan ÖNCE <html data-theme> ayarlar (yanlış tema parlaması olmasın). Kural fleet.js resolveTheme ile aynı:
// kayıtlı 'simumav.theme' (dark|light) > sistem teması (prefers-color-scheme). Sonraki değişiklikleri site.js yönetir.
(function () {
  var s = null;
  try { s = localStorage.getItem('simumav.theme'); } catch (e) { /* özel mod */ }
  var light = false;
  try { light = matchMedia('(prefers-color-scheme: light)').matches; } catch (e) { /* eski tarayıcı */ }
  document.documentElement.setAttribute('data-theme', s === 'dark' || s === 'light' ? s : (light ? 'light' : 'dark'));
})();
