// Google Maps JS yükleyici (anahtar /api/meta.maps_key). Anahtar yoksa null döner → modüller yedek arayüzü kullanır.
// Anahtar reddi: Maps JS betiği 200 ile yüklenir ama kimlik doğrulama başarısız olursa (RefererNotAllowedMapError / ApiNotActivatedMapError /
// InvalidKeyMapError) haritanın yerine gri "Bu sayfa Google Haritalar'ı düzgün şekilde yükleyemedi" kutusu çizer ve küresel `gm_authFailure()`
// çağırır. Onu yakalarız: `gmapsAuthFailed()` true olur, 'sm:gmaps-auth' olayı yayılır → parkur editörü uydu yedeğine (satmap.js) geçer;
// sonraki yüklemeler hemen reddedilir (aynı sayfada yeniden denemek aynı hatayı verir). Aynı anahtar ve kısıt Google 3B karolarını da (403) etkiler.
let loadingP = null, authFailed = false;
export const gmapsAuthFailed = () => authFailed;
export const GMAPS_AUTH_EVENT = 'sm:gmaps-auth';
function hookAuthFailure() {
  if (typeof window === 'undefined' || window.__smGmAuthHooked) return;
  window.__smGmAuthHooked = true;
  const prev = window.gm_authFailure;
  window.gm_authFailure = () => {
    authFailed = true;
    try { prev?.(); } catch { /* */ }
    console.warn('Google Haritalar anahtarı reddedildi (gm_authFailure) → uydu yedeği');
    window.dispatchEvent(new CustomEvent(GMAPS_AUTH_EVENT));
  };
}
export function loadGoogleMaps(key, lang = 'tr') {
  if (!key) return Promise.resolve(null);
  if (authFailed) return Promise.reject(Object.assign(new Error('Google Haritalar anahtarı reddedildi'), { code: 'gmaps_auth' }));
  hookAuthFailure();
  if (window.google?.maps?.importLibrary) return window.google.maps.importLibrary('maps').then(() => window.google);
  loadingP ??= new Promise((resolve, reject) => {
    // `loading=async` ile API, betik onload'unda henüz hazır değildir (importLibrary yok) → `callback` ile hazır sinyali (inline script yok; CSP uyumlu)
    const cb = '__smGmapsReady';
    window[cb] = async () => { try { await window.google.maps.importLibrary('maps'); await window.google.maps.importLibrary('marker'); resolve(window.google); } catch (e) { loadingP = null; reject(e); } finally { delete window[cb]; } };
    const s = document.createElement('script');
    s.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(key)}&v=weekly&loading=async&language=${encodeURIComponent(lang)}&callback=${cb}`;
    s.async = true;
    s.onerror = () => { loadingP = null; delete window[cb]; reject(new Error('Google Maps yüklenemedi')); };
    document.head.append(s);
  });
  return loadingP;
}

/** Konum seçici harita: tıkla → onPick({lat,lon}); setCenter; marker + yarıçap dairesi + halkalar (sürüklenebilir). */
export async function pickerMap(google, host, { lat, lon, radius_m = 1000, onPick, onGateMove, dark = true }) {
  const map = new google.maps.Map(host, {
    center: { lat, lng: lon }, zoom: 14, mapTypeId: 'hybrid', disableDefaultUI: true, zoomControl: true, gestureHandling: 'greedy',
    colorScheme: dark ? 'DARK' : 'LIGHT', clickableIcons: false,
  });
  const marker = new google.maps.Marker({ position: { lat, lng: lon }, map, draggable: true });
  const circle = new google.maps.Circle({ map, center: { lat, lng: lon }, radius: radius_m, strokeColor: '#38bdf8', strokeOpacity: 0.9, strokeWeight: 2, fillColor: '#38bdf8', fillOpacity: 0.08, clickable: false });
  map.addListener('click', e => onPick?.({ lat: e.latLng.lat(), lon: e.latLng.lng() }));
  marker.addListener('dragend', () => onPick?.({ lat: marker.getPosition().lat(), lon: marker.getPosition().lng() }, true));
  let gateMarkers = [];
  const api = {
    map,
    setCenter: (la, lo, r) => { marker.setPosition({ lat: la, lng: lo }); circle.setCenter({ lat: la, lng: lo }); if (r) circle.setRadius(r); map.panTo({ lat: la, lng: lo }); },
    setRadius: r => circle.setRadius(r),
    setGates: gates => {
      gateMarkers.forEach(m => m.setMap(null)); gateMarkers = [];
      for (const g of gates) {
        const m = new google.maps.Marker({ position: { lat: g.lat, lng: g.lon }, map, draggable: true, label: { text: String(g.i + 1), color: '#fff', fontWeight: '700' },
          icon: { path: google.maps.SymbolPath.CIRCLE, scale: 14, fillColor: g.kind === 'gate' ? '#a78bfa' : '#38bdf8', fillOpacity: 0.85, strokeColor: '#fff', strokeWeight: 2 } });
        m.addListener('dragend', () => onGateMove?.(g, { lat: m.getPosition().lat(), lon: m.getPosition().lng() }));
        gateMarkers.push(m);
      }
    },
    geocode: async q => { const gc = new google.maps.Geocoder(); const r = await gc.geocode({ address: q }); const loc = r.results?.[0]?.geometry?.location; return loc ? { lat: loc.lat(), lon: loc.lng() } : null; },
    dispose: () => { gateMarkers.forEach(m => m.setMap(null)); },
  };
  return api;
}
