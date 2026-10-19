# SIMUMAV — bağımsız dron simülasyon oyunu (simumav.com)

HEPGO Uçuş Simülatörü çekirdeğinin (SITL + Google 3B/gerçek arazi + dron paneli + görev/çarpışma/.bin/replay)
HEPGO'dan **bağımsız**, **mastertool.download hesap yapısıyla** çalışan, **oyun görünümünde** sürümü.
Bu belge ajanlar arasındaki sözleşmedir: veri modeli, REST yüzeyi, dizin yerleşimi, yayın. Değişiklik yapan
ajan bu dosyayı da günceller.

## 1. Mimari kararlar

- **Aynı depo, ayrı uygulama.** `app/simumav/` paketi ayrı bir ASGI uygulamasıdır (`app.simumav.main:app`).
  HEPGO'nun `app.main` uygulaması İÇE AKTARILMAZ. Simülasyon çekirdeği (`app/flightsim.py`, `flightsim_hub.py`,
  `flightsim_mission.py`, `flightsim_rec.py`, `flightsim_bin.py`, `flightsim_replay.py`, `flightsim_runs.py`,
  `sim_terrain.py`, `drone_sitl.py`, `drone_params.py`, `flightsim_models.py`) **değiştirilmeden** yeniden kullanılır;
  HEPGO'ya özgü bağımlılıkları (kullanıcı/yetki/DB) `app/simumav/bridge.py` adaptörü + **`app/simumav/shim/`** karşılıklarıyla sağlanır:
  çekirdeğin `from . import config | db | drone_hub | feed | flightlog | flight_analysis` istekleri, `app/simumav/config.py` içe aktarılırken
  (`shim.kur()`, çekirdekten ÖNCE) `sys.modules['app.<ad>']`'a kaydedilen shim modülleriyle karşılanır (GERÇEKLEŞTİ). shim/config: DATA_DIR =
  `SIMUMAV_DATA_DIR/core`, UPLOAD_DIR = `core/uploads`; shim/db: yalnız çekirdek tabloları (`core/core.db`); shim/drone_hub: HEPGO drone_hub'ın saf
  bölümleri (DroneState, Viewer, konsol, send_command + kalkış/görev akışları; köprü WS'si ve saha görevi yok); feed/flight_analysis no-op; flightlog
  `_mode_names`/`WARN_RE`. Replay alt süreci `python -m app.simumav.replay_worker` (HEPGO `app.flightsim_replay` girişi `app.config` ister).
- **Kimlik: mastertool.download hesap servisi**, uygulama kodu **`sv`** (`sm` SSH Master'a ait, ÇAKIŞIR) (`central/sshmaster_server/sshm/main.py`
  `GAMES['sv'] = {'name': 'SIMUMAV', 'slug': 'simumav', 'icon': 'simumav', 'site': 'https://simumav.com'}`).
  Kayıt/giriş/şifre sıfırlama uçları zaten genel: `POST /api/sv/auth/prelogin|register|login|logout|forgot|reset/{tok}`
  (VOLFAI `vf` ile aynı akış: istemci PBKDF2 `computeAuthHash`, bkz. `static/mt/volfai/js/account.js` eski sürümü
  `/tmp/volfai/src/js/account.js`). Kullanıcı profili: `sv_profiles(user_id, profile JSON, updated_at)` (vf_profiles kalıbı)
  — yalnız hesap servisinde görünen özet (pilot adı, toplam uçuş, saat) için; asıl oyun verisi simumav DB'de.
- **SIMUMAV oturumu:** tarayıcı önce hesap servisine (`https://mastertool.download/api/sv/auth/login`, CORS: Origin
  `https://simumav.com` izinli) giriş yapar (client verilmez → Bearer belirteç), dönen belirteci `POST /api/session {token}` ile simumav'a verir;
  simumav belirteci hesap servisinde `GET /api/sv/me` (Bearer; `/account` yalnız web çerezi kabul eder) ile doğrular (`user.verified` false → 403
  `unverified`), kullanıcıyı `users` tablosuna eşler (mt_user_id, email, display_name) ve **kendi HttpOnly çerezini** (`smsid`, 30 gün, Secure,
  SameSite=Lax) açar. Çıkış ikisini de kapatır: `DELETE /api/session {token?}` hesap servisi belirtecini de `/api/sv/auth/logout` ile kapatır
  (simumav belirteci saklamaz; istemci gönderir).
  Geliştirmede `SIMUMAV_DEV_LOGIN=1` iken `POST /api/session {dev_user:'ad'}` hesap servisine gitmeden oturum açar.
- **Veri:** `SIMUMAV_DATA_DIR` (PROD `/opt/hepgo/simumav-data`, DEV `/tmp/simumav-data`), DB `simumav.db` (sqlite,
  WAL), dosyalar `files/previews/` (parkur önizlemeleri); çekirdek verisi `core/` (core.db, `uploads/flightlogs/*.bin`, `sim_runs/<id>/params.param`,
  `sim_replay/<log>.json.gz`, `sitl_calisma/`, `sim_terrain/` karo önbelleği). flights satırı `bin_path/params_path/replay_cache` core-göreli yol tutar;
  indirmeler `bridge.dosya_yolu` ile core kökü dışına çıkışı reddeder. Tablolar §3.
- **Yayın:** systemd `hepgo-simumav` (User=hepgo, `SIMUMAV_UDS=/run/hepgo/simumav.sock`, WorkingDirectory
  `/opt/hepgo/caymazbuild`, ExecStart `run-simumav.sh`), cloudflared ingress `simumav.com` + `www.simumav.com` →
  `unix:/run/hepgo/simumav.sock`. DNS: Cloudflare'da CNAME `simumav.com`/`www` → `294f79b9-1cf7-4cbc-b806-a7f70a1e0404.cfargotunnel.com`
  (proxied) — **kullanıcı panelden ekler**. Google Maps anahtarı referrer listesine `simumav.com` **kullanıcı ekler**.
- **Çevre:** `.env` ortak (`/opt/hepgo/caymazbuild/.env`: GOOGLE_MAPS_API_KEY, SIMUMAV_SECRET, SIMUMAV_MT_URL=
  https://mastertool.download, SIMUMAV_MT_INTERNAL=http://127.0.0.1:8095 — sunucu-sunucu doğrulama iç adresten).
- **Mission Planner bağlantısı:** uçuş başına **TCP** dinleyici (`SIMUMAV_MP_PORT_BASE=15600`, 15600–15999), yalnız
  ilk bağlanan istemcinin IP'si kilitlenir (sonraki farklı IP'ler reddedilir), uçuş bitince kapanır; arayüzde
  `tcp:<sunucu>:<port>` gösterilir. UDP açılmaz.

## 2. Dizin yerleşimi

```
app/simumav/            main.py (ASGI, static mount, CSP), config.py, db.py (şema+migrasyon), auth.py (hesap servisi
                        istemcisi + çerez), bridge.py (flightsim çekirdeği adaptörü: SimSession yaşam döngüsü, MP TCP,
                        kayıt → flights), routers/{session,hangar,crew,tracks,missions,fly,ops,settings}.py
run-simumav.sh          run.sh kalıbı (UDS ya da port 8600)
deploy/simumav/         hepgo-simumav.service, cloudflared-ingress.yml (eklenecek parça)
static/simumav/site/    tanıtım sitesi (index.html + css/js/img; çok dilli; register/login)
static/simumav/app/     oyun arayüzü (index.html, app.js, modüller hangar/crew/tracks/missions/fly/ops/settings,
                        ui/transition.js, i18n/*.json, theme.css)
static/simumav/brand/   ikon (SVG kaynak + 32/64/180/512 PNG), og görseli, modül ikonları
static/simumav/vendor → three.js ve xterm vb. için HEPGO `static/vendor` aynen kullanılır (mount: /vendor → static/vendor)
static/simumav/sim/  → HEPGO simülatör ön yüz modülleri (`static/js/modules/flightsim*.js`, `flightsim_g3d.js`, `replay3d.js`)
                        aynen yeniden kullanılır (mount: /sim → static/js/modules). DİKKAT: bu modüller `../api.js` ve `../ui.js` içe aktarır
                        (ÜST dizin) → /sim altında `/api.js` ve `/ui.js` köküne çözülürler. Çekirdek YÖNLENDİRMELERİ (route; Uç ajanı bulgusu):
                          /api.js  (ve /sim/api.js, /app/simapi.js) → static/simumav/app/simapi.js   (aynı dışa aktarımlar: api{get,post,put,del}, upload, fileUrl, videoUrl, logActivity)
                          /ui.js   (ve /sim/ui.js)                  → static/simumav/app/fly/simui.js (İNCE ui.js: h, clear, toast, toastError, modal, confirmDialog, field,
                                                                      fmtDateTime, fmtDuration, t, segmented, goBack, onLeave, pref, setPref — HEPGO ui.js kabuğa/ikon
                                                                      kataloglarına bağlı olduğundan kullanılmaz; pencere/bildirim body'ye eklenir, tam ekranda görünür)
                          /static/vendor/three/*  → static/vendor/three  (flightsim3d/g3d/models LIB sabiti MUTLAK `/static/vendor/three/`; `/vendor` mount'u yetmez)
                          /static/img/google-logo.png, /static/models/caymaz-sim.glb (+ /static/models/*) → HEPGO static (salt okunur dosya yolları)
                          /api/drone/sim/terrain|tile|osm (GET; parkur world_mode 'real' ve Google 3B yer ofseti için flightsim3d/g3d sabit TERRAIN_API)
                            → simumav'da aynı yolda vekil (HEPGO app/sim_terrain.py; oturum zorunlu, hız sınırı)
                          /api/drone/routes (flightsim_panel.js hub:true iken GET) → `[]` (routers/fly.py c_routes; 404 değil); /api/drone/sim/g3d-key çağrılmaz
                            (Uç `g3dKey` getter'ı /api/meta maps_key verir)
                        Uç modülünün HEPGO modüllerine verdiği YAN ETKİLER/UYUM NOTLARI (static/simumav/app/fly/session.js):
                          • flightsim_panel.js hub soketini `${location.host}/ws/drone/live` yoluna açar → sayfa düzeyinde WebSocket sarmalayıcısı YALNIZ bu yolu
                            start.ws (/ws/fly/{sim_id}) adresine çevirir (installWsBridge; uçuş bitince kaldırılır). Panel `{t:'watch', sim_id}` gönderir,
                            `hello{bridges:[{bridge_id, sim_id, drones}], me:{can_command}}` + `status{bridge_id,state}` + `console{bridge_id,text,sev,tag}` + `res{rid,ok,error}`
                            bekler; komut `{t:'cmd', rid, bridge_id, sysid:1, name, params}`. ⇒ /ws/fly/{sim_id} TEK soket: sim mesajları (tele/hello{session}/
                            state/launch/crash/warn/event/route/mission_cur/end) + hub mesajları aynı akışta; `hello` HEM `session` HEM `bridges`/`me` içerir;
                            bridge_id = session.hub.bridge_id (yoksa −(9000+sim_id)); sim_id sayısal. Uç kendi soketinden de aynı `cmd/res` biçimini kullanır
                            (takeoff{alt, launch:'hand', hand_speed_ms, hand_pitch_deg} · arm/disarm/mode/rtl/land/reset/crash{kind,speed,dz}).
                          • Panel MP bölümü "UDP …" yazar → Uç DOM sonrası `tcp:<host>:<port>` + "ilk bağlanan IP kilitlenir" notuna çevirir (patchMpBox).
                          • flightsim_record.js: REST `opts.rest` ile → POST /api/fly/{flight_id}/rec/start {mime} → {rec_id}; PUT /api/fly/rec/{rid}/chunk?seq=N (octet-stream);
                            PUT /api/fly/rec/{rid}/thumb (png); POST /api/fly/rec/{rid}/finish {duration_s, mime, text} → {kept:true, file}; DELETE /api/fly/rec/{rid};
                            GET /api/fly/rec/{rid}/file. Video → flights.video_path. (Paylaşım yok; `share` getter false.)
                          • flightsim_audio.js: `AUDIO_MODELS.interceptor` çalışma zamanında eklenir (yüksek devir: idle 4200 / max 19000 rpm, 2 silindir, 3 pala).
                          • flightsim_hud.js `launchHud` 'hand' bilmez → elden atışta HUD'a `launch` verilmez; Uç kendi "LAUNCH HAND · 7 m/s · 12°" etiketini çizer.
                          • flightsim3d.js sahnesi dışa verilmez → pilot figürü ve FPV halkaları ayrı saydam kaplamada (fly/overlay3d.js; kamera sim.cameraPose()
                            + FOV ile eşlenir; derinlik birleşimi yok: kaplama nesneleri hep üstte çizilir).
                          • flightsim3d.js `launch.method:'hand'` → düzenek ve iniş takımı YOK (yalnız 'wheels' iniş takımı, 'ramp'/'vehicle' düzenek ekler).
                          • localStorage anahtarları HEPGO ile aynı (fs.panel.*, fs.fpv.*, fs.cam, fs.audio.*, fs.mhud.*) — simumav.com ayrı origin, çakışmaz.
static/simumav/app/fly/  Uç modülü: index.js (render(view, params, ctx)), wizard.js (saf adım makinesi, tip/model/dünya eşlemeleri, hız ölçeği), session.js
                        (oturum sahnesi, WS köprüsü, komutlar, kayıt adaptörü, özet rapor), hand_launch.js (elden atış: saf zaman çizelgesi + pilot figürü),
                        gates.js (FPV halkaları: saf geçiş algılama/izleyici/replay + 3B/OSD), overlay3d.js, simui.js, net.js, fly.css, fly-sim.css
                        (HEPGO app.css fs-* bloklarının kopyası; HEPGO dosyasına dokunulmaz).
tests/test_simumav.py   REST + oturum + bridge (SITL yok) · tests/test_simumav_ui.mjs
```

## 3. Veri modeli (sqlite; tüm tablolarda `user_id` → users.id, `created_at/updated_at` ISO)

- `users(id, mt_user_id UNIQUE, email, display_name, avatar, lang 'tr', theme 'dark', settings JSON, last_login)`
- `pilots(id, user_id, name, character TEXT ('p01'…'p10'; 'p01' = pilot şapkalı erkek), is_default 0/1, flights INT, hours REAL)`
  — kayıtta otomatik `p01` + ad = hesap adı, is_default=1.
- `drones(id, user_id, name, type ('multirotor'|'plane'|'heli'|'fpv'|'interceptor'|'vtol'), model_key (flightsim_models
  anahtarı ya da 'proc:<şablon>'), params JSON (SITL parametre farkları; interceptor: ARSPD_FBW_MAX 170 m/s ≈ 600 km/h,
  THR_MAX 100, hızlı rate PID'ler), color, preview (dönen 3B için GLB yolu), is_default)`
  — kayıtta otomatik **1 hazır FPV dron** (`type 'fpv'`, model 'glb:iris_fpv', ad "FPV-1").
- `tracks(id, user_id, name, lat, lon, alt_mode 'terrain', radius_m, wind {speed_ms, dir_deg, gust}, time_of_day, weather,
  world_mode ('real'|'google3d'|'procedural' — HEPGO'daki üç kip: Gerçek arazi / Google 3B / Prosedürel; varsayılan 'google3d'),
  world JSON (HEPGO `flightsim3d.js` WORLD_DEFAULTS alt kümesi — GERÇEK anahtarlar: seed, size_m, tree_density, mountain_height, mountain_count,
  building_count, runway, runway_heading, water, fog, landing_circle_m; `flightsim.world_dogrula` aralıkları; rüzgâr/saat/hava ayrı sütunlardan),
  gates JSON (FPV HALKALARI: [{i, lat, lon, agl_m, yaw_deg, radius_m, kind:'ring'|'gate'}] ≤ 50; `i` 0..n-1 benzersiz (arayüz i+1 gösterir); yarıçap 1–20 m; agl 1–120 m;
  parkur yarıçapı içinde; yalnız 3B kiplerde çizilir — her üç kip de 3B'dir), preview_png, is_default)`
  — kayıtta otomatik **TRTEST** (TR TEST Kalecik: lat 40.0990, lon 33.4101; ajan doğrular), is_default=1.
- `missions(id, user_id, track_id, name, kind ('corridor'|'free'|'spray'|'fpv_flags'|'fpv_gates'|'survey'), — `fpv_gates`: parkurun halkalarını sırayla geçme (plan: {order:[gate i…], laps}), plan JSON (waypoint'ler +
  tür parametreleri; HEPGO flightsim_mission ile uyumlu `route` biçimi), preview_png)`
- `flights(id, user_id, pilot_id, drone_id, track_id, mission_id NULL, launch ('wheels'|'ramp'|'vehicle'|'hand'), started_at,
  ended_at, duration_s, result ('ok'|'crash'|'abort'), summary JSON (flightsim_mission summary + `gates:{passed,missed,laps,best_lap_s}` stop gövdesinden),
  bin_path, video_path, params_path, mp_port, replay_cache, core_log_id, core_run_id, snapshot JSON (dron/pilot/parkur/görev adları — kayıt silinse
  de kart dolu))` — Operasyon modülünün kaynağı. `hand` (elden atış) çekirdekte düşük ivmeli mancınık (`ramp`, angle 12°, 40 km/h) olarak koşar.
- `sim_runs_link(flight_id, sim_id)` — çalışan SimSession eşlemesi (bellekte de tutulur).
- `sessions(id, user_id, token_hash sha256, created_at, last_seen, ip, ua)`, `audit(id, ts, ip, user_id, event, detail)` (§7), `schema_version`.

## 4. REST yüzeyi (`/api/...`; JSON; hata `{detail:{error,message}}`; oturum zorunlu — `session` hariç)

Durum değiştiren (POST/PUT/DELETE) her istekte `Origin` izinli kökenden olmalı (yoksa `Sec-Fetch-Site: same-origin`); aksi 403 `csrf`. Yazma uçları
60/dk/kullanıcı, okuma 300/dk, `POST /api/session` 10/dk/IP → 429 `rate_limited` + `Retry-After`. Kayıt başkasına aitse 404 (varlık sızmaz).

- `POST /api/session {token}` | `{dev_user}` → `{user, pilots_count, drones_count, tracks_count, missions_count, flights_count, active_flight, settings}`
  (`Set-Cookie: smsid`); hatalar 401 `bad_token`, 403 `unverified`, 503 `account_service`. `GET /api/session` aynı gövde; `DELETE /api/session {token?}`.
- `GET/PUT /api/settings` → `{lang, theme ('dark'|'light'|'auto'), sound, analog_fpv, music, volume 0–1, reduced_motion, units, langs[], themes[]}`
- `GET /api/hangar` → `{drones:[{id,name,type,model_key,params,color,preview (GLB|null),proc,is_default}], quota}`; `POST /api/hangar {name ≤40,type,model_key,params?,color '#rrggbb'}`
  (201); `PUT /api/hangar/{id} {name?,model_key?,params?,color?,is_default?}`; `DELETE` (uçuştaki dron 409 `in_use`); kota 20 → 409 `quota`;
  params beyaz liste dışı → 422 `param_rejected` + `name`.
  `GET /api/hangar/catalog` → `{types:[{key,label,models:[{key,label,glb,thumb,defaults,proc,desc,orient?,has_prop?}]}]}` — her tipte önce **gerçekçi GLB
  modeller** (`glb:*`, static/simumav/models/*.glb, kaynak/lisans LICENSES.md, üretim tools/simumav_models_build.py; ilk model tipin varsayılanı): fpv `glb:iris_fpv`
  (3DR Iris + FPV kamera), multirotor `glb:iris` / `glb:x500` / `glb:typhoon_h480` (hexa), plane `glb:rc_cessna` / `glb:believer`, interceptor `glb:jet` / `glb:zephyr`,
  heli `glb:heli`, vtol `glb:standard_vtol`; ardından dahili (builtin:quad/hexa/caymaz/delta/heli) ve prosedürel şablonlar (`proc:quad250`, `proc:interceptor`) yedek.
  GLB'ler glTF Y yukarı, burun +X (orient {forward:'+x', up:'+y'}), pervaneler `rotor_*`/`propeller` düğümleri, kontrol yüzeyleri flightsim3d CTRL_RE adlarıyla.
  Dron kayıtları `preview` (GLB url), `orient`, `has_prop`, `model_label` döndürür; eski prosedürel/dahili anahtarlar `bridge.MODEL_YUKSELT` ile aynı sınıfın GLB'sine
  yükseltilir (model_key değişmez). `proc:true` = GLB yok, ön yüz prosedürel çizer. Yeni kullanıcının hazır dronu FPV-1 `glb:iris_fpv`. Interceptor varsayılanları ArduPlane 4.6+ adlarıyla: AIRSPEED_MAX 170, AIRSPEED_MIN 24, AIRSPEED_CRUISE 95,
  THR_MAX 100, TKOFF_THR_MAX 100, LIM_ROLL_CD 7500, hızlı PTCH_/RLL_ oran döngüleri, TECS_CLMB_MAX 30 (eski `ARSPD_FBW_*` adları beyaz listede ama 4.7.2'de yok).
- `GET /api/crew` → `{pilots:[{…, svg}], quota}`; `POST /api/crew {name, character p01…p10}`; `PUT /api/crew/{id} {name?,character?,is_default?}`; `DELETE`
  (son pilot 409 `last_pilot`); `GET /api/crew/characters` → `{characters:[{key,label,gender,svg:'/app/img/pilots/<key>.svg'}]}` (pilot kayıtlarının `svg` alanı da aynı yol; tek doğruluk kaynağı
  `routers/common.PILOT_SVG` → `static/simumav/app/img/pilots/p01..p10.svg`).
- `GET /api/tracks` → `{tracks:[{…, wind, world, gates, preview_png, is_default}], quota, google3d}`; `POST /api/tracks {name,lat,lon,radius_m 200–5000,
  wind{speed_ms 0–30,dir_deg,gust 0–20}, time_of_day day|dusk|night, weather clear|cloudy|rain|fog|snow, world_mode real|google3d|procedural, world{…}, gates[…]}`;
  `PUT /api/tracks/{id}` (kısmi; `is_default`); `DELETE` (son parkur 409); `GET /api/tracks/{id}/preview.png` (512×512; Esri uydu + terrarium gölgesi;
  `files/previews/` önbelleği; kaynak yoksa 502/503 `tile_source`). Halka/dünya hatası 422 `invalid` (denetim: `plan_reject`).
- `GET /api/missions[?track_id]` → `{missions:[…], quota}`; `POST /api/missions {track_id,name,kind,plan}` — plan `{items:[{seq,command,frame,x(lat·1e7),y,z,param1..4}],…}`
  YA DA oyun arayüzü editörünün biçimi `{kind, route:{points:[{seq,cmd,lat,lon,alt_rel,frame}]}, shape, params, order, laps}` (`bridge.plan_items` SITL yüklemesinde items'a çevirir)
  ≤ 500 öğe, parkur yarıçapı içinde, z 0–1000, kalibrasyon/reboot komutları yasak; `fpv_gates` planı `{order:[halka i…], laps 1–10}`; red 422 `plan_rejected`.
- `POST /api/fly/start {drone_id, pilot_id, track_id, mission_id?, launch: {method wheels|ramp|vehicle|hand, angle_deg 10–30, release_kmh 40–110,
  hand_speed_ms 6–8, hand_pitch_deg 10–15} | 'yöntem', record:{bin (vars. true), video}}` → 201
  `{flight_id, sim_id, mp:{host,port,proto:'tcp'}|null, ws:'/ws/fly/<sim_id>', state}`; 409 `flight_open` (`flight_id`, `sim_id` — ön yüz "Süren uçuşunuz var"
  kartı: Uçuşa dön `#/fly/{id}` / Uçuşu bitir), 429 `server_full` (`retry_after`, `Retry-After`), 422 görev başka parkura ait, 503 `sitl`/`no_port`. Görev planı
  SITL hazır olunca `mission_upload` ile yüklenir. `GET /api/fly/current` → kullanıcının açık uçuşu `{flight_id, sim_id, started_at, state, elapsed_s,
  remaining_s, drone, track, pilot, mission, launch, ws, ws_seen, mp}` ya da `null`. Yetim denetimi: `SIMUMAV_ORPHAN_S` (vars. 90 sn) boyunca hiç WS bağlanmayan
  (ve MP istemcisi olmayan) uçuş sunucuda otomatik kapanır (audit `fly_orphan`, end_reason `yetim`); sahne kurulamazsa (WebGL yok) ön yüz uçuşu
  `stop {reason:'webgl'}` ile hemen kapatır — açık uçuş bırakılmaz.
  `GET /api/fly/{flight_id}` → start biçimi: `{flight_id, sim_id, state, mp, ws, session (to_dict), drone, track (gates/world/wind dâhil), pilot, mission (plan),
  launch (nesne), record, ended_at?, live:{sim_id,state,gates,elapsed_s,remaining_s,mp:{port,locked_ip,connected,rejected,…},sitl,tele}}`.
  **Ekran kaydı (flightsim_rec kalıbı; dosyalar `core/sim_rec/`, ≤ 300 MB, video → flights.video_path):** `POST /api/fly/{flight_id}/rec/start {mime}` → 201
  `{rec_id, max_bytes, chunk_max, ext}`; `PUT /api/fly/rec/{rid}/chunk?seq=N` (octet-stream ≤ 8 MB, sıralı; atlama 409, başkası 403);
  `PUT /api/fly/rec/{rid}/thumb` (PNG ≤ 2 MB); `POST /api/fly/rec/{rid}/finish {duration_s, mime, text}` → `{ok, kept:true, rec_id, size, text, file}`;
  `GET /api/fly/rec/{rid}/file`; `DELETE /api/fly/rec/{rid}` (flights.video_path temizlenir). Paylaşım yok.
  `POST /api/fly/{flight_id}/stop {gates?:{passed,missed,laps,best_lap_s}, reason?}` → `{ok, flight}` (bitmişse `already:true`).
  `WS /ws/fly/{sim_id}` **TEK soket** (§2 uyum notları): sim mesajları (`tele/event/state/route/launch/end`) + hub mesajları (`status/console/konsol/params/
  event/bridge`) aynı akışta. `hello{v, session, can_command:true, gates, flight_id, me:{id,name,can_command:true}, bridges:[hub.info() — bridge_id = −(9000+sim_id),
  sim_id, drones], caps, task, flights}`; `watch{sim_id}` → hello yeniden. İstemci `ping`, `rc{ch}`, `cmd{rid, name, params, bridge_id?, sysid?}` →
  `res{rid, name, ok, error?, result?}`: çekirdek komutları (`arm/disarm/mode/takeoff{alt}/rtl/reset/crash/set_home`; `takeoff{alt, launch:'hand',
  hand_speed_ms, hand_pitch_deg}` → `bridge.elden_atis_ayarla`: oturum `launch` 'ramp' kalıbı + TKOFF_THR_MINACC 4 / TKOFF_LVL_PITCH el açısı, `launch{phase}`
  olayları) SimSession.komut ile; hub komutları (`set_mode, land, goto, mission_*, param_*, altitude_change, arm{force}, arm_check`, takeoff{alt_rel_m}) drone_hub
  shim `send_command` (bileşik akışlar) ile; `bridge_id` kendi köprüsü değilse `ok:false`. `param_cache`, `console_hist` hub kalıbı. Çerez yoksa
  `{t:'error',error:'auth'}`+4403, sahibi değilse `not_found`+4404, > 100 msj/sn → 4429. Aynı döngü `/ws/drone/sim/{sid}` ve `/ws/drone/live` yollarında da
  (HEPGO modülleri değişmeden; `/ws/drone/live` yalnız izleme + kendi köprüsüne komut).
- **Uyumluluk yüzeyi `/api/drone/sim/*`** (HEPGO sim modülleri için, oturum sahipliğiyle): `meta` (centers = parkurlar, `simumav:true`), `g3d-key`,
  `sessions` (kendi), `sessions/{id}` GET/DELETE, `sessions/{id}/cmd`, `sessions/{id}/summary`, `sessions/{id}/live`, `terrain`, `tile/{kind}/{z}/{x}/{y}`,
  `osm`, `models` (yalnız dahili, salt okunur), `models/{mid}`, `runs/stats`, `reports` (boş), `rec/pending` (boş). Yükleme/ekran kaydı uçları yok (v1).
- `GET /api/ops[?limit&offset]` → `{flights:[… + track{…,preview_png}, drone{…,preview}, pilot, mission, has_bin, has_replay], total, stats}`;
  `GET /api/ops/{id}` (+ `summary`, `replay_ready`, `replay_possible`); `GET /api/ops/{id}/replay` (gzip JSON; ilk çağrıda .bin alt süreçte ayrıştırılır;
  404 `no_bin`, 422 `replay_failed`); `GET /api/ops/{id}/bin`; `GET /api/ops/{id}/params` (Mission Planner .param); `DELETE /api/ops/{id}` (süren uçuş 409).
- `GET /api/meta` (oturumsuz 200) → `{version, mt_url, mt_app, lang_list, dev_login, limits{max_flights, flight_minutes, drones, pilots, tracks, missions,
  flights, disk_bytes}, sitl, google3d, types, launches, mission_kinds, weather, time_of_day, world_modes, mp{proto,port_range,host}, active_flights,
  authenticated, maps_key (yalnız oturumlu; aksi null)}`. `GET /healthz`.

## 5. Oyun arayüzü ilkeleri

- Tam ekran "oyun" kabuğu: web sayfası değil; üst bant yok, sol altta küçük kullanıcı çipi, sağ üstte ayarlar dişlisi.
  Ana menü: 6 büyük kart (Hangar · Mürettebat · Parkur · Görevler · Uç · Operasyon) 3B/parallax arka plan üzerinde; kartlar
  hover'da yükselir; geçişler sahne geçişi gibi (perde/ışık süpürme, 350–600 ms, `prefers-reduced-motion` saygılı).
- Hangar: ortada dönen 3B model (three.js, HEPGO vendor), "+" devasa düğme → tür kartları yarış oyunu araç seçimi gibi
  yatay kaydırma + ok tuşları; isim ver → kaydet → hangara iner (animasyon).
- Mürettebat: 10 karakter (SVG, p01 pilot şapkalı erkek, en az 4 kadın) kart; seçim + isim.
- Parkur: TRTEST hazır; yeni parkur: konum (Google harita tıkla / ara), **dünya kipi 3 seçenek** (Gerçek arazi · Google 3B ·
  Prosedürel — HEPGO sihirbazındaki "Dünya" adımının oyun görünümlü karşılığı: dünya boyutu, ağaç sıklığı, ek bina, sis, rüzgâr
  hızı/yönü, pist yönü/pist, saat Gündüz/Akşam/Gece), **FPV halkaları editörü**: harita/3B önizleme üstünde tıklayarak halka ekle
  (sıra numarası, yükseklik AGL, yön, yarıçap, tür halka/kapı; sürükle-taşı, sil), halkalar 3B önizlemede çizilir; kart üstünde
  dönen mini 3B arazi (gerçek arazi karosu + uydu dokusu) + halkalar.
- Uç: parkurun halkaları sahnede çizilir (neon halka/kapı, sıradaki halka vurgulu, geçilen yeşil), geçiş algılama (dron merkezi
  halka düzleminden yarıçap içinde geçti), OSD/HUD'da sıradaki halka oku + mesafe + tur sayacı + süre; uçuş özetine halka
  istatistiği (geçilen/kaçırılan, en iyi tur).
- Görevler: "+" → parkur seç (kartlar) → isim → tam ekran Cesium (HEPGO routes.js'teki Cesium kullanımıyla aynı kaynak)
  üstünde görev araçları: koridor, serbest, ilaçlama dilimleme, FPV bayrak, tarama. `plan` HEPGO görev biçimi.
- Uç: sihirbaz (dron → parkur → kalkış yöntemi [sabit kanatta: rampa/araç/tekerlek/**elden atış**] → görev opsiyonel →
  BAŞLA) → mevcut HEPGO simülasyon sahnesi + dron paneli + HUD/FPV birebir; MP TCP bilgisi panelde.
  Uç ayrıntıları (static/simumav/app/fly; tests/test_simumav_fly.mjs):
  • Sihirbaz adımları `wizard.js` createWizard: drone → track → launch (yalnız plane/interceptor/vtol) → mission → pilot; parkur değişince görev sıfırlanır;
    `payload()` = POST /api/fly/start gövdesi (launch: {method, angle_deg 10–30, release_kmh 40–110, hand_speed_ms 6–8, hand_pitch_deg 10–15}; kopterde
    {method:'wheels'}). Tip eşlemesi: plane/interceptor → sabit_kanat, heli → helikopter, fpv/multirotor → multirotor. Model: sunucu `preview`+`orient` verdiyse gerçekçi GLB {id, glb_url, orient, has_prop} (glb:* ve yükseltilmiş proc:*);
    'proc:quad250' → builtin:quad, 'proc:caymaz' → builtin:caymaz, 'proc:interceptor' → builtin:delta, kütüphane anahtarı + preview GLB → {id, glb_url}. Dron önizlemesi: dronun çevresinde dönen
    serbest kamera (preview:true dünya turu yaptığından kullanılmaz).
  • Dünya: `worldFromTrack(track, maps_key)` — world_mode 'real'|'google3d'|'procedural' (google3d anahtar yoksa prosedürel); track.world alanları
    (size_m, trees_pct|tree_density, extra_buildings|building_count, fog_pct|fog, runway_deg|runway_heading, runway, time_of_day|time) HEPGO WORLD_DEFAULTS'a; rüzgâr
    tracks.wind'den. Kurulum HEPGO flightsim.js renderSession ile aynı (createFlightSim3D opts: camera, pilotFov, fpvAnalog, fpvNose, onPilotFov, g3dKey, onFallback).
  • Kameralar: HEPGO CAMERA_MODES (Takip · FPV 'pilot' + OSD · Gimbal 'fpv' + askeri HUD · Serbest · Yer); FPV dron başlangıçta 'pilot'. Ayarlar.analog_fpv → analog OSD.
  • SİMÜLASYON PARİTESİ (HEPGO renderSession ile birebir; kullanıcı simumav.com'da üç gerilemeyi bildirdi):
    – Titreme: telemetri 3B'nin uyarlanır tamponlu zaman çizgisine (flightsim3d.js içindeki flightsim_interp.js) HEPGO sırasıyla verilir (setTelemetry →
      HUD/OSD/ses/panel); `net: 50 Hz · jitter · tampon · DR` etiketi (.fs-net, alt çubuk üstü sağ); teşhis `/app/?netsim=jitter30,loss5,delay40#/fly/<id>`
      (`rc.js` parseNetsim/netsimDeliver; window.__fsSim). Kabul testi tarayıcısız: tests/test_simumav_rc.mjs (50 Hz jitter'lı/kayıplı tele → ardışık
      karelerde konum TEK YÖNLÜ, DR ≤ 1). Elden atış kaydırması (shimTelemetry) tbm/tbm_pos/rs/ps/ys'yi korur.
    – Kalkış ARM'siz: KÖK NEDEN — oturum SITL TCP bağlanınca HAZIR'a geçer, kalp atışı/EKF birkaç sn sonra gelir; panel HAZIR'da "Kalkış" → hub
      _takeoff_flow `set_mode: SITL henüz kalp atışı göndermedi` ile tek denemede düşüyordu (kullanıcı ARM'a basınca akış çalışıyordu; ArduCopter'da EKF
      oturmadan ARM kabul edilip GUIDED "requires position" ile reddediliyor ve araç DISARM oluyordu — SITL'de ölçüldü). shim/drone_hub.py: kalp atışı
      beklemesi (≤ 45 sn) → EKF/GPS konum beklemesi (`kalkis_konum_hazir`: fix ≥ 3, EKF_STATUS_REPORT POS_HORIZ_ABS|PRED, pre-arm biti; ≤ 60 sn) → GUIDED →
      ARM (red/teyit yoksa pre-arm metni konsola, 2 sn sonra yeniden; ≤ 45 sn) → NAV_TAKEOFF; sabit kanat `_plane_takeoff` aynı bekleme/yeniden deneme.
      Sim yolu (düzenek/elden atış `takeoff{alt}`) için `bridge.kalp_atisi_bekle` (≤ 90 sn; /ws/fly takeoff ayrı görevde, WS döngüsü bloklanmaz).
      Gerçek SITL kabul: tests/test_simumav_sitl.py (HEPGO_SITL_DIR; ArduCopter 47 sn / ArduPlane 27 sn'de ARM düğmesiz armed + havada; rc override).
    – Sanal kumanda (`rc.js` virtualRC, HEPGO kopyası): alt çubuk 🎮 → iki çubuk + klavye → 20 Hz {t:'rc', ch[8]} → /ws/fly `rc` → RC_CHANNELS_OVERRIDE;
      kapatınca/çıkışta 8×0; FPV'de görünür (panel gizli); MP joystick uyarısı (gcs_connected); 3B WASD kilidi; dokunmatik pointer events.
    – Ayrıca taşınan: alt çubuk ARM/DISARM · mod · Kalkış (hub akışı) · RTL (.fs-cmds; panel açıkken gizli), Esc → Geri onayı, cmd takeoff zaman aşımı 100 sn.
      P/O tuşları artık yalnız HEPGO modüllerinde (session.js'deki ikinci dinleyici çift tetikliyordu → kaldırıldı). E2E: tests/simumav_par_shots.py
      (sahte SITL, port 8605, /tmp/simumav-par/*.png; SwiftShader'da kare hızı < 12 ise tarayıcı içi titreme kabulü atlanır).
  • Interceptor: hız kadranı 600 km/h (SVG; kırmızı bölge %85+), ses modeli yüksek devir; HUD'da mach yok. Diğer ölçekler: plane/vtol 200, fpv 150, heli 120, kopter 100.
  • ELDEN ATIŞ (`hand_launch.js`, HAND): omuz 1,6 m; SITL başlangıç irtifası 1,8 m (çekirdek); bırakma 7 m/s (6–8), burun yukarı 12° (10–15), yalpa 3°;
    geri sayım 3 sn → kol geri 0,25 sn → ileri 0,45 sn → BIRAKMA (t=0,7 sn) → ofset 1,2 sn'de SITL'e erir. Görsel: telemetri kaydırması (shimTelemetry:
    alt_rel += 1,6 m, 0,55 m ileri, pitch/roll hedefe karışır; elde iken hız 0) + saydam kaplamada pilot figürü (kapsül gövde, şapka, kol pivotları; pist yönü;
    SITL yer noktasının 0,6 m gerisinde). Akış: panel/KOMUT "Kalkış" → cmdSim('takeoff') → geri sayım (AT!) → WS cmd takeoff{launch:'hand', hand_speed_ms,
    hand_pitch_deg} → sunucu `launch{phase: armed|launch|released}` (yoksa yerel zamanlayıcı ileri taşır; aşamalar geri gitmez).
    REPLAY (ops ajanı): `replayHandTimeline(frames, FI)` → segmentler {arm, launch, release, disarm} (ilk hareket gs > 2 ya da tırmanış > 0,5 m; bırakma gs ≥ 5 ya da
    tırmanış > 1 m); `replayHandPhaseAt(segs, t)` → 'idle'|'armed'|'launch'|'released'; `replayHandPhaseStart(segs, t)` aşama başı; görsel `handPoseAt(phase, t − başı)`;
    figür için `createHandFigure(T)` + `createHandOverlay(overlay, sim, T, {cfg, headingDeg})` (overlay3d.js). Replay zaman çizelgesinde `launch.method==='hand'` dalı
    HEPGO replayLaunchTimeline yerine bunları kullanır (HEPGO fonksiyonu 'hand' için yalnız tırmanış > 3 m'de bırakır).
  • FPV HALKALARI (`gates.js`): yerel ENU'da halka merkezi (toLocal(lat,lon), terrainHeight + agl_m), normal n = (sin yaw, cos yaw); geçiş = dron merkezi düzlemi
    ileri yönde kesti (d0<0→d1≥0) ve kesişim noktası yarıçap içinde ('gate': kare); yarıçap dışında ≤ 3×r → KAÇIRMA (sıra ilerler); ileriki halka içinden geçiş →
    aradakiler kaçırıldı; sıradaki halkadan ters geçiş → ters yön uyarısı. Aynı karede çoklu geçiş s'ye göre sırayla işlenir. Görev `fpv_gates` → plan.order/laps;
    yoksa i sırası, 1 tur. 3B: neon torus / kapı çerçevesi, sıradaki mavi nabız, geçilen yeşil, kaçırılan kırmızı, gelecek amber; OSD (kendi 2B tuvali): sıradaki
    halka halkası/kenar oku + "#i · mesafe", üst orta TUR n/N · geçilen/toplam ✓ ✗ · tur süresi · EN İYİ. Uçuş bitince POST /api/fly/{id}/stop gövdesi
    `{gates:{passed, missed, best_lap_s, laps}}`; özet raporda (HEPGO reportBody + halka karoları) gösterilir; sunucu flights.summary.gates olarak saklar.
    REPLAY: `replayGatesAt(frames, FI, gates, plan, origin, t, {terrainHeight, step})` → t anındaki istatistik + statusOf(i); `createGateTracker` saf.
  • Oturum: tam ekran (BAŞLA tıklamasında), kamera düğmeleri, Panel (P), HUD (H, gimbal), OSD (O, FPV), ses, kayıt (video → /api/fly/.../rec), "Uçuşu Bitir" →
    POST /api/fly/{id}/stop → özet rapor → "Operasyon'a git" (#/ops); ← Geri uçuşu arka planda bırakır (#/fly/{id} ile geri dönülür: GET /api/fly/{id}
    `{flight_id, sim_id, mp, ws, session, drone, track, pilot, mission, launch, record, ended_at?}` döner).
- Operasyon: büyük kartlar (parkur görseli + dronun dönen 3B'si + tarih + pilot); tıkla → replay (HEPGO replay dünyası).
- Ayarlar: tema (koyu/açık/otomatik), dil (tr, en, de, fr, es, ru, ar), ses, FPV analog efekt, hesap bilgisi, çıkış.
- Dil dosyaları `static/simumav/app/i18n/<lang>.json`; tanıtım sitesi de aynı dilleri destekler.

## 7. Güvenlik (BAĞLAYICI — sistem tüm dünyaya açık olacak, kötü niyetli kullanıcı varsayılır)

- **Tam yalıtım:** ayrı süreç, ayrı DATA_DIR, ayrı DB. HEPGO ERP veritabanına/dosyalarına HİÇBİR erişim yok; `app.main`,
  `app.db`, HEPGO `config.DATA_DIR` içe aktarılmaz. flightsim çekirdeğine verilen yollar yalnız SIMUMAV_DATA_DIR altındadır.
  SITL süreçleri `hepgo` kullanıcısıyla, çalışma dizini uçuş başına geçici klasör, bitince silinir.
- **Kimlik:** belirteç yalnız sunucu-sunucu doğrulanır (iç adres 127.0.0.1:8095); e-posta doğrulanmamış hesap oyuna giremez
  (`verified` alanı). Çerez `HttpOnly; Secure; SameSite=Lax`; oturum kimliği 32 bayt rastgele, DB'de hash'li; 30 gün + boşta 7 gün.
  Her durum değiştiren istekte `Origin`/`Sec-Fetch-Site` denetimi (CSRF). WS açılışında çerez doğrulanır, uçuş sahibi değilse kapanır.
- **Girdi:** tüm gövdeler pydantic; dize uzunlukları (ad ≤ 40, açıklama ≤ 500), sayısal aralıklar (lat/lon, radius 200–5000 m,
  rüzgâr 0–30 m/s), enum'lar sıkı. `params` yalnız **beyaz liste** parametre adları (drone_params hariç listesi + izin verilen
  ARSPD_*/THR_*/TKOFF_*/PTCH_*/RLL_*/WP_*/… listesi) ve sayısal aralık; Lua/script, SERIAL*, LOG_*, SYSID*, BRD_*, dosya yolu
  içeren hiçbir parametre kabul edilmez. Görev planı ≤ 500 nokta, parkur yarıçapı içinde. Dosya adları/yolları kullanıcıdan
  alınmaz; indirmeler yalnız DB'deki yollardan, `files_root` dışına çıkış reddedilir. Yükleme yok (v1).
- **Kaynak kotaları:** kullanıcı başına aynı anda 1 uçuş; uçuş süresi ≤ 45 dk (otomatik durdurma); sunucu genel eşzamanlı
  uçuş sınırı `SIMUMAV_MAX_FLIGHTS` (varsayılan 6) — dolu ise "bekleme odası" yanıtı (429 + tahmini süre). Hangar ≤ 20 dron,
  mürettebat ≤ 20 pilot, parkur ≤ 20, görev ≤ 50, saklanan uçuş ≤ 100 (en eskisi silinir; .bin ≤ 50 MB, video ≤ 300 MB).
  Disk kotası kullanıcı başına 1 GB.
- **Oran sınırlama:** IP + kullanıcı bazlı (bellek içi token bucket): `/api/session` 10/dk/IP, yazma uçları 60/dk/kullanıcı,
  okuma 300/dk, WS mesaj 100/sn; aşımda 429. Hesap servisindeki login/register oran sınırı korunur.
- **MP TCP:** rastgele port (aralıktan), ilk bağlanan IP kilidi, aynı anda tek bağlantı, 60 sn bağlanılmazsa kapanır, uçuş
  bitince kapanır; MAVLink akışı yalnız o uçuşun SITL'ine. Portlar güvenlik duvarında yalnız aralık olarak açık.
- **Başlıklar/CSP:** `default-src 'self'; script-src 'self' 'unsafe-eval' 'wasm-unsafe-eval' https://maps.googleapis.com https://cdn.jsdelivr.net https://*.cesium.com
  ('unsafe-eval': Cesium 1.145 CDN paketindeki Knockout `(0,eval)("this")` yüklemede eval ister — HEPGO CSP'si ile aynı; inline script yine yok); connect-src 'self'
  https://mastertool.download https://maps.googleapis.com https://*.googleapis.com https://*.cesium.com https://*.arcgisonline.com
  https://*.amazonaws.com wss://simumav.com; img-src 'self' data: blob: https:; frame-ancestors 'none'; object-src 'none'`,
  `X-Content-Type-Options`, `Referrer-Policy: strict-origin-when-cross-origin`, `Permissions-Policy`. Inline script yok.
- **Günlük/denetim:** oturum açma/kapama, uçuş başlat/durdur, kota/oran aşımı, reddedilen parametre/plan → `audit` tablosu
  (IP, user, olay, ayrıntı); hata yanıtları iç ayrıntı sızdırmaz (traceback yok, genel mesaj). Google anahtarı yalnız
  `/api/meta` ile oturumlu kullanıcıya verilir (referrer kısıtı Cloudflare tarafında ek koruma değildir — kullanıcı anahtar
  kısıtına simumav.com ekler).
- **Hesap servisi tarafı:** `sv` için CORS yalnız `https://simumav.com`; register'da e-posta doğrulama zorunlu; `sv_profiles`
  yazımı yalnız simumav sunucusundan (paylaşılan gizli `SIMUMAV_MT_SHARED_SECRET` başlığı) ya da kullanıcı Bearer'ı ile.
- **Bağımlılıklar:** three.js/xterm vendor'dan (CDN yok); Cesium ve Google yalnız resmi alanlar. `npm`/pip yeni paket gerekirse
  raporda belirtilir, kurulmaz.

## 6. Yayın ve doğrulama

1. `deploy/simumav/hepgo-simumav.service` kopyala → `systemctl enable --now hepgo-simumav`; `.env`'e SIMUMAV_* ekle.
2. cloudflared `config.yml` ingress'e `simumav.com`, `www.simumav.com` → `unix:/run/hepgo/simumav.sock`; `systemctl restart cloudflared`.
3. Kullanıcı: Cloudflare DNS CNAME (tünel) + Google anahtarı referrer `simumav.com`.
4. Hesap servisi: `GAMES['sv']` + `sv_profiles` tablosu + CORS Origin `https://simumav.com` → hepgo-sshmasters restart;
   mastertool.download › Oyunlar listesinde SIMUMAV (ikon `static/brand/simumav.svg|png`, tanıtım bağlantısı simumav.com).
5. Dışarıdan: `https://simumav.com/` tanıtım 200, `/app` oturumsuz → tanıtım/giriş; `/api/meta` 200; MP TCP portu dış IP'den
   yalnız kilitli IP ile.

### 6.1 Yayın akışı (HEPGO → goktalay/simumav → mastertool.download → sunucu)

- **Kaynak HEPGO deposudur.** `tools/simumav_export.py [--dest ~/mt-work/simumav] [--version X.Y.Z] [--dry-run]` SIMUMAV çalışır
  ağacını üretir: manifest (`app/simumav/**`, flightsim çekirdeği, `static/simumav/**`, `static/js/modules/flightsim*.js`
  + `replay3d.js` + `flightsim_g3d.js`, `static/vendor/three|xterm/**`, `run-simumav.sh`, `deploy/simumav/**`, `docs/simumav.md`,
  `tests/test_simumav*`) + AST ile çözülen `from . import` zinciri + JS göreli import zinciri (+ `/vendor/<ad>/` başvuruları).
  `app/main`, `app/db`, `app/config`, `app/feed`, `app/drone_hub`, `app/flightlog`, `app/flight_analysis` gibi HEPGO'ya özgü
  modüller zincirde çıkarsa **UYARI verilir ve kopyalanmaz** — çekirdek bunları `app/simumav/bridge.py` ile (ör. `sys.modules`
  enjeksiyonu ya da çekirdekte `try: from . import db` yedekleri) almalıdır. `./api.js` kopyalanmaz (`simapi.js`, §2).
  Üretilenler: `requirements.txt` (yalnız gerçekten import edilen üçüncü parti paketler, HEPGO sürüm kısıtlarıyla; uvicorn her
  zaman), `VERSION`, `README.md`, `.gitignore`. Hedefte `.git`, `.github`, `scripts`, `CHANGELOG.md` korunur, geri kalanı silinir.
  Test: `tests/test_simumav_export.py`.
- **goktalay/simumav** (main): `git tag vX.Y.Z && git push origin vX.Y.Z` → `.github/workflows/release.yml` (ubuntu, python 3.12):
  pip, pyflakes + `node --check`, `python -m tests.test_simumav` (SITL yok), `simumav-X.Y.Z.tar.gz` (deterministik tar; `.github`,
  `scripts`, `dist`, `.venv`, `.env*` hariç; `VERSION` içinde) + `.sha256`, ≤ 95 MB denetimi, GitHub Release (softprops v2),
  `scripts/upload-mastertool.sh` → hesap servisi. `ci.yml` her push/PR'da pyflakes + node --check + testler.
- **Sunucu (root):** `deploy/simumav/hepgo-simumav-deploy.path` `data/releases/sv/latest` değişimini izler →
  `hepgo-simumav-deploy.service` → `deploy/simumav/deploy.sh`: sha256 → gzip/yol/symlink denetimi → `/opt/hepgo/simumav.new`
  → `.venv` (requirements hash değiştiyse pip) → `simumav.prev` yedeği → `rsync -a --delete --exclude .venv --exclude .env`
  → `chown -R root:root` → `systemctl restart hepgo-simumav` → `curl --unix-socket /run/hepgo/simumav.sock http://x/api/meta`
  200 değilse **önceki sürüme geri döner**. Günlük `/var/log/hepgo-simumav-deploy.log`. `.env` (`/opt/hepgo/simumav/.env`,
  `EnvironmentFile`) hiç dokunulmaz. Ayrıntı `deploy/simumav/README.md`.

### 6.2 Hesap servisi ucu: `POST /api/sv/web-releases` (çekirdek ajanı yazar; sözleşme bağlayıcı) — GERÇEKLEŞTİ

Uygulama: `sshm/main.py` `web_release_upload` / `web_release_latest` / `web_release_list` (`GET /api/sv/web-releases`, Merkez anahtarı ile liste +
`latest`), `_tar_dogrula` (yalnız listeler; `unsafe_archive`, `version_mismatch`, `incomplete`); tablo `web_releases(… created_by 'release-key'|'central')`;
oran 10/dk/IP; hata halinde sürüm klasörü silinir. Parçalı uç (`/part`) v1'de YOK. Testler `tests/test_mastertool.py`.

- Kimlik: `X-Release-Key` başlığı; `settings.RELEASE_KEYS['sv'] = os.environ.get('SIMUMAV_RELEASE_KEY', '')`;
  `hmac.compare_digest`; anahtar tanımsız ya da uyuşmuyorsa 403 (`_release_auth` kalıbı; merkez oturumu da geçerli).
- Form (multipart): `version` (zorunlu; `VERSION_RE`, baştaki `v` atılır → aksi 422 `invalid_version`), `package` (zorunlu;
  dosya ≤ **95 MB** → aksi 422 `too_large`/413; ilk 2 bayt `1f 8b` gzip imzası → aksi 422 `not_gzip`), `sha256` (zorunlu; hex 64;
  sunucuda hesaplananla eşleşmeli → aksi 422 `bad_sha256`).
- İçerik denetimi (`tarfile`, açılmaz, yalnız listelenir): her üye adı normalize edilir; mutlak yol, `..` bileşeni, sembolik/sert
  bağ (`issym()/islnk()`), aygıt/fifo üyesi → 422 `unsafe_archive`. Kökte (`VERSION` ya da `./VERSION` ya da tek kök klasör
  altında) `VERSION` üyesi okunur ve `version` ile eşleşmeli → aksi 422 `version_mismatch`. `requirements.txt` ve `run-simumav.sh`
  yoksa 422 `incomplete`.
- Aynı sürüm varsa **409 `exists`** (dosya ve DB kaydı dokunulmaz). Kayıt: `data/releases/sv/<v>/simumav-<v>.tar.gz` +
  `simumav-<v>.tar.gz.sha256` (`<sha>  simumav-<v>.tar.gz` biçimi) — hepgo kullanıcısı 0644; `web_releases(id, app, version,
  file, size, sha256, created_at, created_by)` tablosu (INSERT; `UNIQUE(app, version)`); son olarak `data/releases/sv/latest`
  dosyasına `<v>\n` **atomik** yazılır (`latest.tmp` + `os.replace`) — path unit bunu izler. Hata halinde sürüm klasörü silinir,
  `latest` değişmez.
- Yanıt 201 `{ok, version, sha256, size}`. `GET /api/sv/web-releases/latest` → `{version, sha256, size, created_at}` (açık; dışarıdan
  doğrulama için). Oran sınırı: anahtarlı uçta 10/dk/IP.
- İsteğe bağlı parçalı uç `POST /api/sv/web-releases/{version}/part` (`file, part, parts, sha256`; `/api/{a}/releases/{version}/{kind}`
  kalıbı; son parçada yukarıdaki denetimlerin tümü). `scripts/upload-mastertool.sh` paket > 90 MB ise bunu kullanır; v1'de paket
  küçük kalmalı (vendor three ~2 MB, xterm ~0.3 MB), uç yoksa büyük paket yüklemesi başarısız olur.

## 8. Gerçekleşme notları (çekirdek ajanı; sshmaster'a birleştirme için)

- **Hesap servisi (sv):** `GAMES['sv']` (`site`/`promo` → simumav.com; `game_url` dış site), `sv_profiles` (+ `vf_profiles`; profil uçları `{kod}_profiles`),
  `PUT /api/sv/profile` ayrıca `X-Simumav-Secret` (settings.SIMUMAV_SHARED_SECRET = `SIMUMAV_MT_SHARED_SECRET`) + `{user_id, profile}` ile sunucudan;
  `user_public` → `verified` alanı (`/me`, `/account`, login yanıtı); CORS orta katmanı yalnız `/api/sv/*` ve yalnız `https://simumav.com`/`www`
  (Authorization, Content-Type, X-SSHM; credentials yok; OPTIONS 204); `RELEASE_KEYS['sv']`; ikonlar `static/mt/img/simumav.svg|png|-512.png`;
  `/api/mt/apps?v≥1.2.0` ve Hesabım `games` listesinde SIMUMAV (url/site simumav.com). SIMUMAV özetini `bridge._profil_ozeti` uçuş bitişinde yazar.
- **Güvenlik (§7) uygulaması:** yalıtım = shim (`core/` kökü, `core.db`; HEPGO DB/dosya yok; `app.main`/`app.auth` hiç yüklenmez — test doğrular);
  SITL çalışma dizini `core/sitl_calisma/<kimlik>` (çekirdek yönetir; `artiklari_temizle` açılışta); kimlik §1; girdi pydantic + enum/aralıklar
  (`bridge.params_dogrula` beyaz liste: ARSPD_/AIRSPEED_/THR_/TKOFF_/PTCH_/RLL_/YAW_/WP_/LIM_/NAVL1_/TECS_/TRIM_/KFF_/RTL_/LAND_/FLAP_/ATC_/PSC_/ACRO_/
  PILOT_/MOT_/LOIT_/WPNAV_/Q_/STAB_/… ≤ 60 ad, |değer| ≤ 1e6; yasak SERIAL/LOG_/SYSID/BRD_/SCR_/NET_/SRn_/MAV/FENCE_/GPS/INS_/COMPASS_/AHRS_/EKx_/FS_/
  ARMING_/RC*/CAN_/BATT/STAT_/FORMAT_/MIS_/RALLY_/TERRAIN_/SIM_WIND/SIM_GPS/SIM_RC/SIM_SPEEDUP), görev planı ≤ 500 + yarıçap, dosya yolları yalnız DB +
  `dosya_yolu`; kotalar (1 uçuş/kullanıcı, `SIMUMAV_MAX_FLIGHTS` → 429 bekleme odası, 45 dk = çekirdek `SIM_MAX_MINUTES`, 20/20/20/50/100 kayıt, disk 1 GB,
  .bin 50 MB = `SIM_BIN_MAX_MB`); oran sınırları `auth.oran`; MP TCP `bridge.MpKopru` (rastgele port, ilk IP kilidi, tek bağlantı, 60 sn boşta kapanır,
  uçuş bitince kapanır; iç UDP 127.0.0.1 ↔ SimSession GCS portu — çekirdeğin UDP soketi 0.0.0.0'a bağlıdır, güvenlik duvarında kapalı tutulur);
  CSP/başlıklar `main.HEADERS` (script-src inline yok; `wss://simumav.com`); denetim `audit` tablosu (login/logout/fly_start/fly_stop/quota/rate/
  param_reject/plan_reject/csrf/mp_reject/ops_delete); 500 → genel mesaj, traceback günlüğe; `maps_key` yalnız oturumlu.
- **Statik yollar (main.py):** `/` site, `/app` oyun kabuğu, `/brand`, `/vendor` ve `/static/vendor` → static/vendor, `/static/models`, `/static/img/google-logo.png`,
  `/sim` → static/js/modules, `/sim/api.js` + `/api.js` + `/static/js/api.js` → `simapi.js`, `/ui.js` + `/sim/ui.js` → `static/simumav/app/fly/simui.js`
  (+ `pageHead` eklendi: replay3d.js Cesium yolu), kök `/<ad>.js` beyaz listesi (i18n, icons, segicons, fa-icons, imgopt, step3d, gcode3d, engine3d; aksi hâlde
  tanıtım sitesinin kök betikleri `/site.js`). CSP: Google Maps JS/gstatic/ggpht/tile.googleapis, cdn.jsdelivr.net (Cesium v1.145), cesium/arcgis/amazonaws. `simapi.js` HEPGO api.js'in tüm dışa aktarımlarını karşılar (+ `ws()`, `session`, `unauthorized()`, `trackPreviewUrl`); 401 → `/?giris=1&sonra=…`.
- **TRTEST:** tesisin resmî koordinatı açık kaynaklarda yok; Kalecik ilçe merkezi (40.0972N 33.4083E, 725 m) yakınındaki 40.0990/33.4101 kullanıldı.
- **Testler:** `tests/test_simumav.py` (SITL yok, sahte kip; shim yüklemesi, oturum/CSRF/oran, CRUD+kota, beyaz liste, önizleme, fly/MP IP kilidi/WS tek soket
  (hub cmd)/hand launch/kayıt REST/stop, ops, meta, yönlendirme yolları, arazi vekili 401), `central/sshmaster_server/tests/test_mastertool.py` (sv, CORS, web-releases). `tools/simumav_export.py` paket-göreli import çözümü ve shim
  farkındalığı eklendi (`--dry-run` uyarısız).
- **Uçtan uca (DEV, gerçek SITL, Playwright headless shell):** `/tmp/simumav-e2e/*.png` (00-tanıtım … 14-ops-replay) + `konsol.txt`. Bulgular (bütünleştirme ajanı
  DÜZELTTİ): `#/fly` için `fly/index.js` `render(view, params, ctx)` dışa aktarır, kabuk `app.js` `mod.mount(view, ctx)` çağırırdı → router artık iki imzayı da
  destekler (`mount(view, ctx)` ya da `render(view, {id}, ctx{i18n,toast,go,user,settings,meta})`; `unmount()` dışa aktarımı ayrılırken çağrılır; `ctx.go('#/ops')` hash
  biçimini de kabul eder). `/brand/crew/p01.svg` 404 → `/app/img/pilots/<key>.svg` (common.PILOT_SVG). Replay (ops) ve .bin/params gerçek SITL ile doğrulandı.
- **WebGL bağlam bütçesi (canlı hata "A WebGL context could not be created … context loss and was blocked"):** kabuğun tüm küçük 3B görünümleri
  (menü arka planı, hangar dönen model + tür seçici, parkur/ops kart mini 3B'leri, parkur editörü) `core/three.js` içindeki TEK paylaşılan WebGLRenderer ile
  sırayla render edilip her görünümün kendi 2B tuvaline kopyalanır (`drawImage`); kart başına WebGL bağlamı açılmaz. `makeStage` API'si aynı (renderer alanı
  paylaşılanı verir). Görünüm kalmayınca çizici 3 sn sonra bağlamı bırakır (`dispose` + `forceContextLoss`); Uç sahnesi (HEPGO createFlightSim3D kendi
  renderer'ı) açılmadan `releaseShared()` çağrılır. Router eski modülün `unmount` Promise'ini bekler; hangar/tracks/ops bekleyen önizleme sözlerini
  (`dead`/`gen`) atar; `fly/session.js` dispose zinciri adım adım korunur (`safe`). Teşhis: `window.__smGl()` → canlı bağlam sayısı (`core/gl.js`,
  getContext sarmalaması; `__smGl.list()`); hedef modüller arası gezintide ≤ 3 (ölçüm: paylaşılan 1, Uç sahnesinde 1–2). E2E: /tmp/simumav-gl/e2e_gl.py.
- **Bütünleştirme (oyun arayüzü ↔ gerçek API; E2E betiği ve kareler /tmp/simumav-e2e2):** `tools/simumav_export.py` yalnız HEPGO `static/js/api.js`'i dışlar
  (SIMUMAV `app/core/api.js` kopyalanır; shim eşlemeleri ayrı "Shim" satırı, `--dry-run` not/uyarı 0). Parkur editörü: `time_of_day` 'day|dusk|night' (saat
  kaydırıcısı yerine segment), `world` yalnız WORLD_KEYS, halka `i` 0..n-1 (görünüm +1; gates.js/OSD/harita etiketleri de +1). Görev editörü `route.points` biçimi
  sunucuda kabul edilir (`missions.plan_ogeleri` doğrular, `bridge.plan_items` MAVLink öğelerine çevirir). `GET /app` → `/app/` 307 (tanıtım sitesi girişten sonra
  `/app`'e yönlendirir). CSP `script-src`'ye `'unsafe-eval'` (Cesium CDN paketi Knockout eval; §7) + `'wasm-unsafe-eval'` (3DTilesRenderer/draco). Uçuş özeti: `POST stop`
  yanıtı `{ok, flight:{summary}}` → rapor `flight.summary`'den. Google Maps yükleyici `callback=` ile (loading=async'te onload erken). Hız göstergesi yüzen MP
  kutusunun üstüne; FPV/gimbal'da gizli; halka OSD kutusu FPV/gimbal'da yön şeridinin altında. Geliştirici oturumunda çıkış hesap servisine gitmez.
  SwiftShader'da 3B sahne karesi ~10–15 sn sürdüğünden "bırakma +0,5/1/2 sn" kareleri zaman damgasıyla değil aşama (elde/kol ileri/bırakma) ile alınır.
