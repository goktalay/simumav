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
  THR_MAX 100, hızlı rate PID'ler), color, preview (dönen 3B için GLB yolu), airframe, power JSON (güç ve yakıt §10; NULL = model varsayılanı), is_default)`
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
- `flights(id, user_id, pilot_id, drone_id, track_id, mission_id NULL, launch ('wheels'|'ramp'|'vehicle'|'hand'|'pod4'|'pod8'|'tube'|'handheld'), started_at,
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
- `GET /api/hangar` → `{drones:[{id,name,type,model_key,params,color,preview (GLB|null),proc,is_default,airframe}], quota}`; `POST /api/hangar {name ≤40,type,model_key,params?,color '#rrggbb',airframe?}`
  (201); `PUT /api/hangar/{id} {name?,model_key?,params?,color?,is_default?,airframe?}`; `airframe` = kontrol düzeni classic|elevon|vtail (HEPGO docs/ucus-simulatoru.md §13.1;
  yalnız plane/interceptor; eksikse katalog modelinin düzeni — talon_vtail vtail, zephyr/interceptor/caymaz elevon, cessna/believer classic; bilinmeyen 422; kopterde null; uçuş açılışında çekirdeğe `layout` olarak gider); `DELETE` (uçuştaki dron 409 `in_use`); kota 20 → 409 `quota`;
  params beyaz liste dışı → 422 `param_rejected` + `name`. Güç ve yakıt (§10): POST/PUT `power {engine, max_speed_ms, fuel_l, fuel_km_per_l, elec_cells, elec_mah,
  elec_w}` (kısmi; sınır dışı/bilinmeyen/ölçüm alanı → 422 `invalid`, audit `power_reject`), PUT `reset_power: true` → model varsayılanı; her dron kaydında
  `power {…, defaults, measured:{fuel_km_per_l, elec_w, at}|null}`; katalog modellerinde `power` (varsayılan) + kökte `power` (sınırlar, hız seçenekleri).
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
- `POST /api/fly/start {drone_id, pilot_id, track_id, mission_id?, launch: {method wheels|ramp|vehicle|hand|pod4|pod8|tube|handheld, angle_deg 10–30, release_kmh 40–110,
  hand_speed_ms 6–8, hand_pitch_deg 10–15, loaded 1…hücre, aim_az_deg 0–360, aim_el_deg 10–85} | 'yöntem', record:{bin (vars. true), video}, power?, speedup? (§10)}` → 201
  (HEPGO §27 INTERCEPTOR fırlatıcıları: yalnız sınır denetimi, tip zorlaması yok — çekirdek tipe göre ayıklar; `flights.launch` yöntem adı, göç yok)
  `{flight_id, sim_id, mp:{host,port,proto:'tcp'}|null, ws:'/ws/fly/<sim_id>', state, power, speedup}`; 409 `flight_open` (`flight_id`, `sim_id` — ön yüz "Süren uçuşunuz var"
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
- **Destek (§9)** `GET /api/support` → `{tickets:[{id, code, subject, status acik|yanit_bekliyor|cozuldu|kapali, category, unread, created_at, updated_at}], categories}`
  (Merkez'den çekilir; yalnız `app='sv'`); `POST /api/support {category flight|account|hangar|track|mp|perf|other, subject ≤120, body ≤4000, screenshot? (data:image/png|jpeg;base64 ≤ 3 MB → 413 `too_large`,
  PNG/JPEG imzası zorunlu → 422), attach_name?, include_context (vars. true), context?{ua, lang, screen, gl, flight_id, route}}` → 201 `{id, code, attachment{name,size,url}|null}`;
  oran 5/sa/kullanıcı → 429 `rate_limited`; `GET /api/support/{id}` → + `messages[{id, author_kind company|support|system, author_name, body, created_at}]`, `files[{name,mime,size,url}]`;
  `POST /api/support/{id}/reply {body ≤4000}` (30/sa) → ayrıntı; `GET /api/support/att/{token}` oturumsuz ek (32 bayt rastgele token; inline, nosniff, sandbox CSP).
  Hesap servisi/gizli yoksa 503 `support_unavailable`.
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
  • Sihirbaz adımları `wizard.js` createWizard: drone → track → launch (plane/vtol: kalkış yöntemi; INTERCEPTOR: HEPGO §27 fırlatıcı — ayrı durum `ilaunch`,
    `iceptLaunchBody` {method, loaded? | aim_az_deg, aim_el_deg}; adımda düzenek önizlemesi) → mission → pilot; parkur değişince görev sıfırlanır;
    uçuşta el fırlatıcısında HEPGO `flightsim_scope_ui.js` NİŞANGÂH penceresi (keyed `launcher.*` metinleri, 7 dil) ve takeoff{alt, aim};
    `payload()` = POST /api/fly/start gövdesi (launch: {method, angle_deg 10–30, release_kmh 40–110, hand_speed_ms 6–8, hand_pitch_deg 10–15}; kopterde
    {method:'wheels'}). Tip eşlemesi: plane/interceptor → sabit_kanat, heli → helikopter, fpv/multirotor → multirotor. Model: sunucu `preview`+`orient` verdiyse gerçekçi GLB {id, glb_url, orient, has_prop} (glb:* ve yükseltilmiş proc:*);
    'proc:quad250' → builtin:quad, 'proc:caymaz' → builtin:caymaz, 'proc:interceptor' → builtin:delta, kütüphane anahtarı + preview GLB → {id, glb_url}. Dron önizlemesi: dronun çevresinde dönen
    serbest kamera (preview:true dünya turu yaptığından kullanılmaz).
  • Dünya: `worldFromTrack(track, maps_key)` — world_mode 'real'|'google3d'|'procedural' (google3d anahtar yoksa prosedürel); track.world alanları
    (size_m, trees_pct|tree_density, extra_buildings|building_count, fog_pct|fog, runway_deg|runway_heading, runway, time_of_day|time) HEPGO WORLD_DEFAULTS'a; rüzgâr
    tracks.wind'den. Kurulum HEPGO flightsim.js renderSession ile aynı (createFlightSim3D opts: camera, pilotFov, fpvAnalog, fpvNose, onPilotFov, g3dKey, onFallback).
  • Kameralar: HEPGO CAMERA_MODES (Takip · FPV 'pilot' + OSD · Gimbal 'fpv' + askeri HUD · Serbest · Yer); FPV dron başlangıçta 'pilot'. Ayarlar.analog_fpv → analog OSD.
  • Kamera türü + PiP (HEPGO docs/ucus-simulatoru.md §22.3–22.5): pilot adımında oyun kartları `fly/camera_pick.js` (Gündüz · Termal · Gece görüşü; önizleme
    /sim/flightsim_camera.js ile 2B tuvalde — ek WebGL bağlamı yok; termalde palet seçici). wizard.js'e DOKUNULMAZ: index.js pilot adımına kartı ve BAŞLA
    gövdesine `camera` ekler. Sunucu `StartIn.camera` (≤ 8 karakter) → `bridge.ucus_baslat(camera=…)` → `flightsim.kamera_dogrula` (geçersiz → 422) →
    çekirdek oturum `camera` + `flights.snapshot.camera`; GET /api/fly/{id} ve /api/fly/current `camera` döner (uçuşa dönüşte aynı tür). Sahnede
    📷 menüsü (T / Shift+T / V), sürüklenebilir kamera PiP'i (çift tık → gimbal; aynı WebGL bağlamı, `__smGl` 1 kalır), tür değişimi sessiz WS `camera`
    komutu (SIM_KOMUT; çekirdek oturum son türü saklar). Varsayılan: dron için yerel son seçim (`fs.cam.byDrone`) → son tercih → gündüz. Metinler `camera.*`
    (7 dil; `camTr` paylaşılan modülün Türkçe metnini anahtara eşler). Operasyon replay'i Cesium haritasıdır (3B kamera yok) → tür yalnız snapshot'ta.
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

### 5.1 Dil seçimi (tarayıcı dili; Google Ads dünya geneli) — `static/simumav/site/js/lang.js` (saf, site + kabuk + node testi ortak)
- Kural: `?lang=xx` (reklam bağlantıları; her şeyi ezer, kaydedilir) > kayıtlı seçim (site `localStorage simumav.lang`; kabuk `sm:lang` → yoksa hesap ayarı
  `settings.lang`) > `navigator.languages` SIRASIYLA ilk desteklenen (tr en de fr es ru ar; "de-DE"→de) > **İngilizce**. Tarayıcıdan gelen dil
  localStorage'a YAZILMAZ (kullanıcı tarayıcı dilini değiştirirse site de değişir); seçiciden seçim yazılır ve tarayıcıyı ezer.
- `<html lang>`/`dir` (ar → rtl), `<title>`/`meta description`/og dile göre (`data-i18n`); hreflang: 7 × `?lang=xx` + `x-default` → `/`. Yasal sayfalar aynı kural.
- Sunucu: `/api/settings.lang` yalnız kullanıcı Ayarlar'da dil seçtiyse döner (`settings.lang_chosen`), aksi hâlde `null` (users.lang DEFAULT 'tr' tarayıcıyı ezmez);
  kabuk `settings/index.js` dili yalnız dil düğmesinde gönderir. Sunucu tarafı Accept-Language ile HTML üretimi yapılmaz (statik; JS seçer).

### 5.2 Google Analytics 4 + çerez rızası — `static/simumav/site/js/analytics.js` (+ `css/consent.css`; kabuk `/js/analytics.js` ile aynı modül)
- Ölçüm kimliği `/api/meta.ga_id` ← env `SIMUMAV_GA_ID` (akış "Mavlink Simulasyon" → `G-8946D4RPGK`); boş → gtag yüklenmez, bant çıkmaz.
- Rıza `localStorage simumav.consent` ∈ {granted, denied}; yoksa alt bant (Kabul / Reddet / Ayarlar → zorunlu [kilitli] + analitik onay kutusu, Kaydet).
  **gtag.js yalnız `granted` iken** `https://www.googletagmanager.com/gtag/js?id=…` ile dinamik yüklenir; Consent Mode v2: `consent default analytics_storage/ad_* denied`
  → `update analytics_storage granted` → `config {anonymize_ip:true, allow_google_signals:false, allow_ad_personalization_signals:false}`. Reddet → hiç yüklenmez;
  sonradan reddedilirse `consent update denied` + `_ga*` çerezleri silinir. Yasal sayfalarda ve her yerde `[data-consent="manage"]` → ayarlar bandı.
  Gizlilik metni `legal.privacy.p5` (7 dil) + p3 güncel. Bant metinleri `cookie.*` anahtarları (site ve kabuk JSON'larında).
- Kabuk: `config send_page_view:false`; hash rotası değişiminde `page_view {page_path:'/app/#/<rota>'}`; olaylar `flight_start {drone_type, launch, world_mode, mission}`,
  `flight_end {drone_type, duration_s, world_mode, gates}`; site `signup`/`login {method:'mastertool'}` — kişisel veri yok. `window.__smAnalytics` (Playwright).
- Testler: `node tests/test_simumav_site.mjs` (pickLang kuralı, hreflang, analytics harici/consent sırası, 7 dil anahtarları), `tests.test_simumav` (meta ga_id, CSP, settings.lang None),
  `tests/simumav_lang_shots.py` (Playwright; uvicorn subprocess 8611; de-DE→de, ja-JP→en, ?lang=ar RTL, bant, Kabul→gtag isteği, Reddet→istek yok, kabuk page_view; /tmp/simumav-lang/).


### 5.3 Tanıtım sitesi (simumav.com kökü) — sinematik filo, Hangar 3B galerisi, modül bölümleri, EO/radar/hedef, gece/gündüz
Dosyalar `static/simumav/site/`: `index.html`, `css/site.css`, `js/{site,fleet,stage,hero3d,hangar3d,theme-boot,lang,auth,analytics}.js`, `img/*.webp`, `i18n/*.json`.
- **Filo kataloğu** `js/fleet.js` (saf, DOM'suz): `/api/hangar/catalog` oturum istediği için site STATİK katalog kullanır — `bridge.GLB_MODELS` anahtarlarının
  tamamı + CAYMAZ (`/static/models/caymaz-sim.glb`, burun +Z → +X döndürülür); hızlar `bridge.HEDEF_HIZ` / `flightsim_targets.BUILTIN_HIZ` (km/h). Node testi
  anahtar ve hız eşitliğini, GLB dosyalarının varlığını ve 7 dilde `fleet.<id>.d` / `type.<tür>` metinlerini doğrular → katalog büyürse test kırılır, site güncellenir.
- **Tek WebGL bağlamı** `js/stage.js`: tüm 3B görünümler (açılış, galeri karoları, büyütülmüş model) TEK paylaşılan `WebGLRenderer` ile sırayla render edilir
  ve görünümün 2B tuvaline kopyalanır (oyun kabuğu `/app/core/three.js` ilkesi). `window.__smSiteGl()` ≤ 1 (Playwright). GLB hazırlayıcı `prepareModel`:
  burun +X / yukarı +Y, merkez, en uzun boyut `fit`; pervaneler (`prop|propeller|rotor|pervane` adlı en üst düğümler) sınır kutusu merkezine pivotlanır,
  dönüş ekseni = en ince boyut; hafif saydam bulanıklık diski.
- **Açılış sinematiği** `js/hero3d.js`: `REEL` sırası CAYMAZ → INTERCEPTOR X4 → Sting → P1-SUN → Typhoon H480 → Standard VTOL → Believer → Zephyr → X500 → Heli → Iris FPV;
  her model `SHOT_SEC`=7 sn, çekim sonu/başı `FADE_SEC`=0,55 sn karartma (`--dip` → `.hero-dip`), dört kamera hareketi sırayla (yörünge · alçak takip ·
  önden süpürme · vinç), kadraj kilidi (masaüstü sağ yarı; dikey ekran üst orta). Gökyüzü kubbesi (ShaderMaterial), üstel sis, eğim/yüksekliğe göre
  boyanan periyodik arazi + örneklenmiş ağaçlar, güneş gölgesi dronu izler (mobilde kapalı), seyir ışıkları gerçek kanat ucu köşelerinde. Tembel yükleme:
  yalnız gösterilen + sıradaki GLB; sıradaki hazır değilse çekim kararmadan uzar. Kare süresi yöneticisi: yavaşsa önce gölge, sonra piksel oranı düşer.
  Film künyesi (lower third: sıra, ad, tür, boyut · hız; ilerleme çubuğu) + önceki / duraklat / sonraki düğmeleri (WCAG 2.2.2). `prefers-reduced-motion`:
  döngü yok, tek kare; önceki/sonraki ile model değişir. Görünmezken (IntersectionObserver / sekme gizli) döngü durur.
- **Hangar galerisi** `js/hangar3d.js`: bölüm 600 px yaklaşınca ya da Hangar kartına/`#hangar` hash'ine gelince tembel yüklenir. Tek stüdyo sahnesi; görünen
  karolar sırayla (kare başına ≤ 5, mobilde 3) render edilir; GLB'ler karo görününce (≤ 3 eşzamanlı). Tür süzgeci çipleri; karo tıklanınca diyalog
  (`#fleet-view`, `aria-modal`, odak tuzağı, Esc): büyük dönen model, sürükle/ok tuşları döndür, tekerlek yakınlaştır, önceki/sonraki, açıklama.
  WebGL yoksa ad · tür · hız düz listesi.
- **Modül bölümleri** `#crew #tracks #missions #fly #ops` (+ `#hangar`): modül kartının başlığı `<a href="#…">` (kartın tamamı tıklanır; CSS `scroll-behavior:smooth`
  + `scroll-margin-top` → yumuşak kaydırma ve URL hash). Her bölümde gerçek uygulama ekran görüntüsü (`img/mod-*.webp`).
- **EO · Radar · Hedef** `#systems`: "Yer kontrolünü koru" uçuş karesi, radar, EO (Gündüz/Termal/Gece seçici — `aria-pressed`), F-16 tarzı hedef sembolojisi
  (gündüz + termal), INTERCEPTOR fırlatıcı seçimi (Uç sihirbazı, 3B önizleme), görev raporu. Görseller GERÇEK uygulamadan: `tests/simumav_site_media.py`
  (sahte SITL, dev giriş, prosedürel arazi; `MEDIA_ONLY=mod,defend,tgt,launch,ops` ile bölüm seçimi; `--publish-only` yalnız WEBP) → `img/*.webp`
  (Pillow, q74, ≤ 260 KB; test sınırı). Savunma karesi + rapor: tek dalga, istasyon üstünde 60 m askı. Radar/EO kırpımları görevsiz "hedefler" uçuşunda
  (zaman baskısı yok): pencereler taşınıp büyütülür (§29), `sim.lockTarget(i)` ile en yavaş hedef kilitlenir, kırpımın üstüne binen geçici katmanlar
  (bildirim akışı, MP kartı) yalnız çekimde gizlenir. SwiftShader yavaş olduğundan savunma görevinde EO kırpımı alınmaz (tehditler istasyona ulaşır).
- **Gece/gündüz teması**: `<html data-theme>`; `js/theme-boot.js` (head, eşzamanlı, src'li) ilk boyamadan önce kayıtlı `localStorage simumav.theme` ya da
  `prefers-color-scheme` uygular. Düğme tersini kaydeder; sistemle aynıysa kaydı siler (yeniden sistemi izler — `fleet.js nextTheme`). Kayıt yokken sistem
  teması değişimi canlı izlenir. 3B sahnede gündüz: mavi gök, açık sis, güçlü güneş, yeşil arazi; gece: alacakaranlık ufku, yıldızlar, belirgin seyir ışıkları.
- **GA olayları** (yalnız rıza `granted` iken gider; kişisel veri yok): `section_view {section}` (bölüm ilk kez %40 görünür), `module_card {module}`,
  `hangar_model_open {model}`, `reel_control {action}`, `eo_mode {mode}`, `theme_toggle {theme}`.
- **CSP**: yeni dış kaynak YOK (three.js `/vendor/three`, modeller `/static/models` + `/static/simumav/models`, görseller `img/`); inline script/style yok.
- Testler: `node tests/test_simumav_site.mjs` (filo↔katalog, reelAt/shotFade, tema kuralı, hash beyaz listesi, kart→bölüm, görseller WEBP/boyut/alt i18n, tek
  çizici); görsel `./.venv/bin/python -m tests.simumav_site_shots` (gerçek uygulama + CSP başlıkları; CSP ihlali / sayfa hatası / bağlam > 1 → hata;
  /tmp/smsite-shots: 4 sinematik kare + geçiş, galeri, büyütme, modül bölümleri, EO kipleri, gündüz, sistem açık teması, mobil, RTL, reduced-motion).

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
- **Başlıklar/CSP:** `default-src 'self'; script-src 'self' 'unsafe-eval' 'wasm-unsafe-eval' https://www.googletagmanager.com https://maps.googleapis.com https://cdn.jsdelivr.net https://*.cesium.com
  ('unsafe-eval': Cesium 1.145 CDN paketindeki Knockout `(0,eval)("this")` yüklemede eval ister — HEPGO CSP'si ile aynı; inline script yine yok; googletagmanager: GA4 gtag.js,
  yalnız çerez rızasıyla §5.2); connect-src 'self' https://mastertool.download https://www.google-analytics.com https://analytics.google.com https://*.google-analytics.com
  https://www.googletagmanager.com https://maps.googleapis.com https://*.googleapis.com https://*.cesium.com https://*.arcgisonline.com
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

## 9. Destek — "Sorun bildir" ve Taleplerim (merkezi ticket erişimi)

- **İletim yolu (seçim ve gerekçe):** SIMUMAV talep TUTMAZ. `app/simumav/routers/support.py` talebi **hesap servisinin mevcut Master Tool destek
  köprüsüne** iletir: `POST/GET /api/sv/tickets[/{id}[/messages]]` — sunucu-sunucu, `X-Simumav-Secret` (= `SIMUMAV_MT_SHARED_SECRET`) + `user_id`
  (`profil_yaz` / `profile_put` kalıbı; `sshm/main.py _ticket_user`). Hesap servisi e-postayı oturumdaki kullanıcıdan alır ve Merkez'in zaten var olan
  `/api/federation/mastertool/tickets*` ucuna (`X-Central-Secret`) geçirir; Merkez talep ekranına `slug=mastertool`, kanal `mastertool`, **etiket SIMUMAV**,
  firma adı `Mastertool · SIMUMAV` olarak düşer (`sshmaster_admin.TICKET_APPS['sv']`). Merkez'in firma federasyonu (`support_router.fed`, firma slug +
  fedauth) SIMUMAV'ı "firma" olarak kaydetmeyi gerektirdiğinden seçilmedi; yeni paylaşılan gizli / yeni Merkez ucu / webhook yok. Sunucu yolunda hesap
  servisinin IP oranı uygulanmaz (tek iç IP); SIMUMAV kendi sınırını uygular (talep 5/sa/kullanıcı, yanıt 30/sa; reddedilen denemeler de sayılır).
- **Merkez'den yanıt → Taleplerim:** çekme modeli — liste/ayrıntı her açılışta hesap servisi üzerinden Merkez'den okunur (`unread` = Merkez `company_unread`,
  ayrıntı açılınca sıfırlanır). Merkez destek yanıtı yazınca mevcut `notify_reply` → hesap servisi `/api/mt/internal/ticket-reply` → kullanıcıya e-posta;
  `app='sv'` ise bağlantı `https://simumav.com/app/#/support/<id>` (Hesabım › Destek'te de görünür).
- **Gövde:** kullanıcının açıklaması + sunucunun ürettiği bağlam bloğu (`--- SIMUMAV bağlamı ---`: kategori, sürüm, hesap kimliği/e-posta; onay kutusu açıksa
  uçuş satırı `#id · başlangıç · sonuç · süre · dron/parkur/pilot/görev` (yalnız kullanıcının kendi uçuşu), tarayıcı UA, dil/ekran, GPU, ekran rotası; ek varsa
  `Ek: ad (KB) URL`). Başlık öneki `[Kategori]`; Merkez kategorisi teknik (other → diger).
- **Ekler:** Merkez mastertool köprüsü JSON'dur (dosya taşımaz); ekran görüntüsü/dosya SIMUMAV'da `SIMUMAV_DATA_DIR/files/support/<uid>/<token>.<png|jpg>`
  (`support_files` tablosu) saklanır, Merkez gövdesine `SIMUMAV_PUBLIC_URL/api/support/att/<token>` yazılır (32 bayt rastgele token, oturumsuz, inline, nosniff +
  `sandbox` CSP; Merkez personeli tıklar). Gönderim başarısızsa ek silinir. Kabul: yalnız PNG/JPEG (imza denetimi), ≤ 3 MB (`SUPPORT_MAX_BYTES`), base64 data URL.
- **Oyun arayüzü:** kabukta dişlinin yanında yaşam simidi `#help` (Uç ekranında gizli; RTL'de solda) → `support/index.js openReportModal` (konu çipleri, başlık,
  açıklama sayaçlı, "Sahneyi yakala" = görünür en büyük canvas → JPEG ≤ 1600 px, "Dosya seç", bağlam onay kutusu + önizleme); gönderince talep numarası +
  "Merkez ekibi e-posta ile dönecek"; Ayarlar'da Destek kartı (Sorun bildir / Taleplerim); Uç bitiş raporunda "Bu uçuşla ilgili sorun bildir" (uçuş kimliğiyle);
  `#/support` Taleplerim (durum rozeti, yeni yanıt işareti), `#/support/<id>` yanıt zinciri + ekler + kullanıcı yanıtı (kapalı/çözülmüşte yanıt alanı yok).
  Saf kurallar `support/rules.js` (node testi). i18n `support.*` 7 dil. Denetim: `support_create`, `support_reply`, `support_fail`.
- **Env:** SIMUMAV `.env`: `SIMUMAV_MT_SHARED_SECRET` (mevcut; zorunlu — yoksa 503 `support_unavailable`), `SIMUMAV_MT_INTERNAL` (mevcut), yeni
  `SIMUMAV_PUBLIC_URL` (vars. `https://simumav.com`; ek bağlantıları). Hesap servisi: `SIMUMAV_MT_SHARED_SECRET` (mevcut) + Merkez bağlantısı (mevcut).
  Merkez: değişiklik yalnız `TICKET_APPS['sv']` + liste `source=` filtresi (`static/js/modules/tickets.js` Kaynak seçimi: Firmalar / Mastertool / SIMUMAV).
- **Dağıtım sırası:** HEPGO Merkez (sshmaster_admin + support router + tickets.js) → hesap servisi (`sshm/main.py`; restart hepgo-sshmasters) → SIMUMAV yayını.
  Eski hesap servisiyle SIMUMAV: `X-Simumav-Secret` tanınmaz → 401 → kullanıcıya 503 "kullanılamıyor" (talep kaybı yok, 4xx mesajı geçmez).
- **Testler:** `tests/test_simumav.py` (sahte hesap servisi `tests/simumav_fake_mt.py`: oluştur/ek/bağlam/liste/ayrıntı/yanıt/oran 429/413/422/CSRF/503/audit),
  `central/sshmaster_server/tests/test_mastertool.py` (sv gizli yolu, 403/422/404/401, IP oranı yok, e-posta bağlantısı), `tests/test_sshmaster_admin.py`
  (etiket SIMUMAV, `source` filtresi), `node tests/test_simumav_ui.mjs`, Playwright `tests/simumav_support_shots.py` (/tmp/simumav-ticket/).

## 10. Güç ve yakıt — HEPGO §23'ün SIMUMAV'a taşınması (`app/simumav/power.py`, `static/simumav/app/fly/power.js|power.css`)

Kullanıcı isteği: "HEPGO'ya eklediğimiz benzin ve pil detayını ve göstergelerini SIMUMAV sistemine ekleyelim." Çekirdek (`app/flightsim_power.py` GucDurumu,
`SimSession(power=…)`, `tele.fuel/elec/speedup`, WS `warn fuel_empty|elec_empty`, `SIM_PLN_THR_MUL`/`SIM_SPEEDUP`) ve ön yüz kadranları
(`static/js/modules/flightsim_power.js` createPowerGauges / createPowerSim / createSpeedPill) DEĞİŞTİRİLMEDEN kullanılır; SIMUMAV yalnız veri modeli,
doğrulama, sihirbaz, tema ve güvenlik katmanını ekler.

- **Veri:** `drones.power` JSON (göç: `ALTER TABLE drones ADD COLUMN power TEXT`, mevcut kayıtlar NULL → katalog modelinin varsayılanı; veri bozulmaz).
  Alanlar `engine 'fuel'|'electric'`, `max_speed_ms, fuel_l, fuel_km_per_l, elec_cells, elec_mah, elec_w` + YALNIZ sunucunun yazdığı ölçümler
  `fuel_km_per_l_last, elec_w_last, measured_at`. Kurallar HEPGO `dogrula` ile aynı: yakıtlı motor yalnız sabit kanat ailesinde (plane / interceptor /
  vtol → çekirdek sabit_kanat | vtol); kopterde (multirotor / fpv / heli) elektrikli, yakıt 0, azami hız null (gövdede gelirse yok sayılır). Elektrikli uçakta
  yakıt 0 (gösterge yok). Sınırlar çekirdeğin `SINIRLAR` tablosu (azami hız 5–150 m/s, yakıt 0–500 L, 0,5–500 km/L, 1–16 S, 100–200 000 mAh, 0–2000 W);
  yakıtlı motorda depo ≥ 0,1 L. Kötü niyetli giriş: nesne değil / > 12 anahtar / bilinmeyen anahtar / `*_last` / bool / NaN / ∞ / dize → 422 + audit
  `power_reject`. Bozuk (elle değiştirilmiş) kayıt okunurken varsayılana düşer.
- **Hazır modellerin varsayılanları** (`power.MODEL_VARSAYILAN`): FPV-1 (`glb:iris_fpv`) 4S 1500 mAh 180 W (≈ 7 dk) · Iris 3S 5100 / 180 W · X500 4S 5000 /
  220 W · Typhoon H480 4S 5400 / 260 W · heli 6S 5000 / 450 W (kopterde W = motor + elektronik ortalaması → uçuş süresi) · RC Cessna elektrikli 28 m/s
  3S 2200 / 120 W · Believer 30 m/s 6S 10 000 / 200 W · Talon 28 m/s 4S 10 000 / 150 W · CAYMAZ (`builtin:caymaz`) HEPGO değerleri 45 m/s 5 L 25 km/L 4S
  10 000 / 30 W · Standard VTOL yakıtlı 30 m/s 4 L 20 km/L 6S 16 000 / 120 W · jet / proc:interceptor yakıtlı 150 m/s (çekirdek üst sınırı; eski 170 m/s
  AIRSPEED_MAX yerine) 6 L 20 km/L · Zephyr elektrikli 120 m/s.
- **Uçuş açılışı:** `POST /api/fly/start {…, power?, speedup?}` → `power.ucus_power`: hangar ayarı + sihirbaz gövdesi aynı doğrulamayla → çekirdeğe TAM
  `power` sözlüğü (`MANAGER.ac(power=…)`; çekirdeğin `drone_sitl_options` önerisi kullanılmaz — SIMUMAV dron kimlikleri yeniden kullanılabilir, açılışta o
  kimliğin satırları silinir). Yanıt ve `flights.snapshot` `power` (engine dâhil) + `speedup` taşır. `speedup` 1|2|4|8 ve ≤ `SIMUMAV_MAX_SPEEDUP`
  (varsayılan **4**: SITL n× hızda ≈ n kat CPU, .bin n kat hızlı büyür) → aksi 422 `invalid`/`speedup_limit`; SITL hazır olunca bekçi `speed` komutuyla yazar.
- **Sunucu güvencesi (§7):** `speed` komutu WS + REST uyumluluk ucunda `> MAX_SPEEDUP` → red; hub `param_set` `SIM_*` adlarını (SIM_BATT_ hariç; SIM_SPEEDUP,
  SIM_PLN_THR_MUL, SIM_WIND…) reddeder (audit `cmd_reject`); hangar `params` beyaz listesi `SIM_PLN`/`SIM_SRV` öneklerini de yasaklar. Mission Planner
  (ham MAVLink TCP) PARAM_SET ile yazarsa **bekçi** (`bridge._guc_bekci`, 1 sn): SITL'in bildirdiği SIM_SPEEDUP > üst sınır → geri çeker (audit
  `speed_clamp`, sarı olay); yamalı ikilide SIM_PLN_THR_MUL oturumun azami hız çarpanından saparsa yeniden yazar (audit `thr_mul_clamp`).
- **Sihirbaz** (`fly/wizard.js` adım `power`, drone → track → launch → **power** → mission → pilot; `power.js createPowerStep`): üstte durum karoları (azami
  km/h, menzil, Wh + S/V, dayanım), iki sütun **Motor** (Yakıtlı/Elektrikli seçimi — yalnız uçakta; azami hız, depo L, km/L) · **Elektronik batarya** (S, mAh,
  W) kaydırıcı + sayı girişi; değerler hangardan ön dolu ("hangar" rozeti), son uçuşun ölçümü **★ Önerilen** rozetiyle ön dolu (↺ hangar değerine döner;
  HEPGO davranışı); **Simülasyon hızı** 1×…8× (yalnız `meta.power.speedups`). Kopterde tek batarya kartı (üç alan yan yana). Alt özet "⚡ 5 L · 4S · 4×".
- **Uçuşta** (`fly/session.js`): HEPGO `createPowerGauges` dört analog kadran (YAKIT · HIZ · MOTOR · BATARYA) **tüm kamera kiplerinde alt ortada** —
  takip/serbest/yer tam boy; FPV (OSD) ve gimbal (askeri HUD) kiplerinde küçük + yarı saydam (HEPGO'da orada gizliydi; OSD alt satırlarının üstünde).
  Oyun teması (`.fs-gauges.sm-game`: koyu cam yüz, neon çerçeve — yakıt amber, batarya yeşil, turuncu ibre). HIZ kadranı varken eski SVG hız göstergesi gizli.
  Metinler `trPower` ile i18n (`power.*`), "dk/sa" birimleri yerelleştirilir. Hız kapsülü üst çubukta (createSpeedPill; tele.speedup ile eşitlenir).
  `warn kind fuel_empty|elec_empty` → büyük kırmızı bant ("YAKIT BİTTİ — simülasyon sürüyor"), toast, `sfx.alarm()`; %20 yakıt / %25 batarya altında bir kez
  sarı bant + `sfx.caution()`. Uçuş ve SITL etkilenmez (yalnız uyarı).
- **Uçuş sonu:** `flights.summary.power` = GucDurumu özeti (görev özeti boş olsa da) + `drone_written`; geçerli ölçümler (km/L ≥ 0,3 km & 0,02 L, W ≥ 60 sn)
  `power.olcum_yaz` ile dron kaydına (`measured`) → sonraki sihirbazda ★ Önerilen. Rapor penceresinde oyun kartı (mesafe, harcanan yakıt, ölçülen km/L,
  Wh, ortalama W, kalan yakıt/batarya çubukları, bitme anları, "drona yazıldı"); HEPGO `.fs-rp-power` bölümü CSS'te gizli (çift olmasın).
- **Operasyon replay** (`ops/replay.js`): kayıt ayarı (`summary.power.settings` → `snapshot.power`) varsa HEPGO `createPowerSim` karelerden oynatıcı zamanıyla
  (atlama/başa dönüş `rebuild`) + aynı kadranlar oynatma çubuğunun üstünde; sol panelde yakıt/batarya satırı; sağ üstte katlanır güç özeti kartı.
- **Hangar:** seçili dronun güç özeti (motor rozeti, km/h, depo/km/L, S mAh W, dayanım, ★ ölçüm) + "Güç ve yakıt" düzenleyici (aynı createPowerStep;
  hız seçici yok, öneri tıkla-uygula, "Varsayılana dön"); şerit ve katalog kartlarında güç etiketi.
- **Çekirdek şema düzeltmesi:** shim `core.db` `drone_sim_runs` tablosunda HEPGO §23/§13.1 sütunları (power, fuel_used_l, fuel_km_per_l, elec_wh,
  elec_w_avg, speedup_max, layout) yoktu → çekirdeğin `flightsim_runs.kaydet` INSERT'i düşüyordu ("Simülasyon kaydı yazılamadı": run satırı ve .param dökümü
  yok). Şemaya eklendi + eski core.db'ye ALTER; `drone_sitl_options` tablosu (çekirdek yazımı için; SIMUMAV okumaz).
- **i18n:** `power.*` (75 anahtar) 7 dilde. Ses: `ui/sfx.js` `alarm`, `caution`.
- **Testler:** `tests/test_simumav_power.py` (göç, katalog/meta, hangar doğrulama sınırları ve kötü girişler, reset/kısmi PUT, fly/start → çekirdek power,
  speedup sınırı, bekçi, WS/REST speed + SIM_* param_set reddi, sahte uçuşta yakıt/batarya bitişi + warn, stop → summary.power + dron ölçümü, core
  drone_sim_runs satırı, FPV kopter kuralları) · `node tests/test_simumav_power.mjs` (saf katman) · `tests/test_simumav_fly.mjs` (adım/payload) ·
  görsel `tests/simumav_power_shots.py` (/tmp/smpower-shots: hangar, düzenleyici, sihirbaz uçak/FPV-en, takip/FPV/gimbal kadranları, yakıt bitti bandı, rapor;
  `SMP_REAL=1 HEPGO_SITL_DIR=/opt/hepgo/sitl/bin` ile gerçek SITL + Operasyon replay).


## 11. INTERCEPTOR (tailsitter) ve HEDEFLER — HEPGO §24/§25'in SIMUMAV'a taşınması (`bridge.py`, `static/simumav/app/fly/targets.js`)
- **Tip kararı:** `interceptor` artık HEPGO çekirdeğinin `interceptor` tipidir (4 pervaneli tailsitter: dikey kalkış, yatayda ~400 km/h; katalog `glb:icept_x4`,
  `glb:p1sun`, `glb:sting`). Eski "interceptor" sabit kanat jetleri (`glb:jet`, `glb:zephyr`, `proc:interceptor`) **'plane'** altına taşındı. Gerekçe: kullanıcı
  INTERCEPTOR'u tailsitter olarak tanımladı; jet/delta fizik olarak sabit kanattır (pist/rampa/el atışı kalkışı, kontrol düzeni), aynı tip altında iki farklı fizik
  (kalkış adımı, mod listesi, kontrol düzeni, ses) karışırdı. Jetler hız ölçeği 600 km/h ve jet sesini model anahtarından alır (`speedScale/audioTypeFor(t, modelKey)`).
- **Göç v2** (`db._MIGRATIONS`, `SCHEMA_VERSION 2`, idempotent): `drones.type 'interceptor'` + jet/zephyr/proc:interceptor → `'plane'` (model, parametre, güç, renk
  aynen); `flights.snapshot.drone.type` aynı kuralla (json_set) → eski uçuş kayıtları ve replay'ler sabit kanat olarak açılır. Tailsitter kayıtlarına dokunulmaz.
- INTERCEPTOR: kalkış yöntemi adımı yok (dikey), kontrol düzeni yok (`airframe` NULL), güç varsayılanı elektrikli 111,1 m/s (P1-SUN 83,3, Sting 87,5), mod listesi Q+FW.
- **HEDEFLER adımı** (sihirbazda "Görev"den sonra, isteğe bağlı): katalog `GET /api/fly/targets` (hedef GLB'leri `tgt:*` + hangar GLB'leri `glb:*`; HEPGO şirket modelleri
  yok), kartlarla model/irtifa/çap/hız/yön/merkez ofseti, önleme yarıçapı; geçersizse İleri/BAŞLA kapalı. `fly/start` `targets` ({items ≤ 8, radius_m 5–200};
  `bridge.hedefler_dogrula` → 422). Snapshot'a ve çekirdek oturuma gider; WS `target` → skor rozeti (üst çubuk "◎ 1/3 · 712 puan"), büyük "ÖNLEME" bandı, ses;
  uçuş sonu raporunda oyun kartı (puan, rozetler, hedef satırları; HEPGO `.fs-rp-targets` gizli) ve `flights.summary.targets`. 7 dil `targets.*`.
- **Hedef 3B önizlemesi + HUD sembolojisi (HEPGO §24.4/§24.5):** HEDEFLER adımında her kartta dönen 3B model (sürükle/tekerlek; ölçek çubuğu, ad · hız · boyut) —
  bu adımda başka sahne olmadığından tek "stüdyo" WebGL bağlamı (`createFlightSim3D(…, {studio: true})`), adımdan çıkınca kapanır (`index.js dropTargetsUi`).
  Uçuşta gimbal HUD'u ve FPV OSD'si F-16 tarzı prizma + TD kutusu + TLL + ekran dışı yön oku çizer (Tab ile hedef kilidi; önlemede "ÖNLEME" yanıp söner) —
  çekirdek modüller `/sim/flightsim_tgthud.js`, `/sim/flightsim_tgtview.js` (`flightsim*.js` manifest kalıbı). Metinler `targets.pv_*` + "Tab: hedef", "ÖNLEME" (7 dil).

## 12. Yer kontrol sahası + "Yer kontrolünü koru" — HEPGO §26'nın SIMUMAV'a taşınması (`bridge.saha_dogrula`, `fly/index.js` adım `site`, `missions` kind `defend`)
- **Sihirbaz**: drone → track → (launch) → power → mission → **site** ("Yer kontrol") → targets → pilot. Adım çekirdeğin `createSiteSection`'ını `keyed` kipinde
  kullanır (`site.*` anahtarları, 7 dil): Radar / İstasyon / EO kartları + menziller, şematik, senaryo (yalnız INTERCEPTOR). Görev adımında **kind='defend'** görev
  kaydı seçildiyse senaryo kayıttan gelir ("Görev kaydından: ad"), sihirbaz `defend` göndermez. Alt özet "◈ R20·GKS·EO5 · Yer kontrolünü koru".
- **REST**: `POST /api/fly/start` `site` (`SiteIn`, **katı**: `extra='forbid'`, `strict=True` — "true"/1/"20" reddedilir; radar 1–50, EO 0,5–15 km) ve `defend`
  (`DefendIn`, katı; sınırlar çekirdekle aynı) → `bridge.saha_dogrula` (görev kaydı kind='defend' ise plan.defend önceliklidir; dron INTERCEPTOR değilse 422) →
  `MANAGER.ac(site=, defend=)`. Yanıta `site` (yerleşimiyle) eklenir; `flights.snapshot.site/defend`; oturumun tamamı hello'da. WS `cmd defend {action:'next'}`
  (SIM_KOMUT = çekirdek KOMUTLAR) → sıradaki interceptor. Uçuş sonu `flights.summary.site` + `summary.defend` (puan, rütbe, önleme listesi).
- **Görevler modülü**: `KINDS` += `defend` (meta `mission_kinds`). Plan `{kind:'defend', defend:{waves, interceptors, difficulty, radius_m, prep_s, seed}}` —
  `savunma_dogrula` ile; **tohum kayda sabitlenir** (yoksa sunucu üretir) → aynı görev her uçuşta aynı senaryo. Rota/öğe yok (`_gorev_yukle` atlanır); bilinmeyen
  plan alanı / sınır dışı → 422 + audit `plan_reject`. Editör: araç şeridinde kalkan simgeli tür; harita çizimi yok, istasyon + 1/3 km halkaları; yan panelde zorluk,
  dalga, interceptor, yarıçap, hazırlık, tohum (+ yeni tohum). Kart önizlemesi (`drawDefendPreview`): radar halkaları + tohumdan tehdit okları + etiket.
- **Uçuşta** (`fly/session.js applySite`): hello'daki `site`/`defend` → 3B saha (istasyon, kule, raf), sol altta radar + EO ekranları (Y / U), görev şeridi + bant
  (N: sıradaki interceptor), `sfx` uyarıları; görev bitince rapor penceresi ("Uçuşu Bitir"). Tek WebGL bağlamı korunur (radar/EO ana renderer'ın viewport kopyası;
  `__smGl ≤ 1`). Uçuş raporu kartı (`.sm-def-card`), **Operasyon** kartında "◈ puan · rütbe" rozeti ve replay'de katlanır görev raporu kartı.
- **i18n**: `site.*` (134) + `kinds.defend(_desc)`, `missions.hint_defend` 7 dilde; HEPGO sözlüklerine aynı metinler (anahtar = Türkçe metin).
- **Dışa aktarma**: `app/flightsim_gcs.py` `PY_CEKIRDEK`'e eklendi; JS modülleri `flightsim*.js` kalıbıyla gelir (`flightsim_gcs.js`, `flightsim_gcs3d.js`,
  `flightsim_gcs_ui.js`).
- **Testler**: `tests/test_simumav_gcs.py` (katı 422'ler, INTERCEPTOR dışı 422, defend görevi CRUD + tohum sabitliği + kötü plan, görev + saha ile uçuş → çekirdek
  oturum (görev tohumu öncelikli), başlatma yanıtı yerleşimi, snapshot, GET oturumu, WS hello, WS `defend next`, dalga olayı, stop → summary.defend/site; sihirbaz
  görevi), `tests/test_simumav_fly.mjs` (site adımı + gövde). Görsel: `tests/gcs_shots_simumav.py` → /tmp/gcs-shots/sm-*.png.

## 13. Uçuş arayüzü kişiselleştirme — HEPGO docs/ucus-simulatoru.md §27'nin SIMUMAV'daki karşılığı
- **Kumanda hassasiyeti** (§27.1): `fly/rc.js` `virtualRC({ shape })` / `channelsOf(ax, ch5, shape)`; şekillendirici `/sim/flightsim_rcfeel.js` (oturum
  sahnesi `loadSim` listesinde). Alt çubukta 🎮 yanında ⚙ paneli; `rcfeel.*` anahtarları (7 dil). Tercih `fs.rc.feel` (HEPGO ile aynı anahtar, ayrı köken).
- **Giriş sekansı** (§27.2): eski sihirbaz geri sayımı (`wizard.js COUNTDOWN_S` / `countdownAt` — saf fonksiyonlar korunur, testli) KALDIRILDI; BAŞLA'da yalnız
  "Hazır ol…" perdesi, 3‑2‑1 + "dıt dıt dıt … diiit" + 100 m sinematik iniş sahnede (`/sim/flightsim_intro.js`, `session.js maybeIntro`). Ses Ayarlar › Ses
  (`sfx.config().sound/volume`) tercihine uyar. Elden atıştaki kalkış geri sayımı (`hand_launch.js HAND.countdown_s`) ayrıdır, değişmedi. `intro.*` anahtarları.
- **Gösterge tasarımı** (§27.3): "Pilot" adımında kamera kartlarının altında önizlemeli kartlar (`/sim/flightsim_gtheme.js createGaugeThemePicker`, oyun teması
  önizlemesi); uçuşta kadran kutusu / G. `classic` = oyun teması (`.sm-game`). `gtheme.*` anahtarları. Tercih yalnız tarayıcıda (`fs.gauge.theme`).
- **Radar/EO pencereleri** (§27.4): HEPGO `createSiteScreens` aynen (sürükle, oranlı boyut, yapışma, engelden kaçınma, `fs.site.win`, ⟲); `site.win_*` anahtarları.
- Dışa aktarma: yeni modüller (`flightsim_rcfeel.js`, `flightsim_gtheme.js`, `flightsim_intro.js`, `flightsim_dock.js`) `flightsim*.js` kalıbıyla gelir.

## 14. Radar/EO tam görüntü, EO elle kumanda, alt bant uçuş denetimi, çarpışma efekti — HEPGO docs/ucus-simulatoru.md §30'un SIMUMAV karşılığı
- Çekirdek modüller aynen (`/sim/flightsim3d.js`, `flightsim_g3d.js` ikincil kamera kaydı + radar altlığı, `flightsim_gcs_ui.js` EO tekerlek/sürükle/TAKİP,
  `flightsim_crashfx.js`, `flightsim_audio.js` darbe sesi). Yeni modül `flightsim_fltbar.js` `fly/session.js` `loadSim` listesinde (`MFlt`): alt bantta mod seçici
  (F) + ARM/DISARM/motor kes (X) her zaman görünür; `.fs-cmds`'te yalnız Kalkış/RTL kaldı. Komutlar hub `cmd` yolundan (`mode`, `arm`, `disarm`, `motor_cut`);
  havada kopter DISARM'ı `confirmDialog` onayı ister. Çarpışma bandı açılınca `sim.crashFx({speed})`, ses `getCrashSpeed`.
- Metinler `flt.*` ve `site.eo_follow*`, `site.eo_manual`, `site.eo_drag_hint`, `site.eo_body_t` (7 dil). Hassasiyet düğmesi etiketli (`rcfeel.btn`).

## 15. KARA ARACI (rover) — HEPGO docs/ucus-simulatoru.md §31'in SIMUMAV karşılığı (`bridge.py`, `power.py`, `fly/*`, `hangar/*`)
- **Tip eşlemesi:** `drones.type 'rover'` → çekirdek `rover` (ArduRover 4.7.2 SITL; `bridge.TIP_ESLEME['rover']`, `TYPE_LABELS` "Kara aracı"; `drones.type`'ta CHECK yok →
  göç gerekmez). `GET /api/meta.types` ve CAYSIM `GET /types` (çekirdek `tipler()`) rover'ı içerir.
- **Katalog:** `glb:rover_4x4` (Keşif 4×4, `drive` ackermann; varsayılan), `glb:rover_ugv` (Paletli UGV, skid), `glb:rover_bot` (Teslimat robotu, skid) —
  `static/simumav/models/rover_*.glb` (prosedürel, `tools/rover_models_build.py`; LICENSES.md). `MODEL_ESLEME glb:rover_* → builtin:rover_*`; çekirdeğin dahili
  rover modelleri aynı dosya olduğundan katalogda ikinci kez listelenmez (INTERCEPTOR kalıbı). `glb_model_api` rover'da `has_prop: false` ve `drive` döner;
  `drone_api` kayda `drive` (modelin sürüş biçimi; rover dışı `null`) ekler. Kara aracı **hava hedefi değildir**: `hedef_katalogu()` rover modellerini atlar;
  tanıtım sitesi filo hızları ayrı `ROVER_HIZ` tablosunda (Ackermann 18–72 km/h, skid 11–14 km/h; `site/js/fleet.js`, test eşitliği denetler).
- **`POST /api/fly/start`:** isteğe bağlı `drive` (`ackermann` | `skid`; yoksa modelin `drive`'ı; bilinmeyen → 422; rover dışında yok sayılır) →
  `bridge.drive_dogrula` → `MANAGER.ac(drive=)` (SITL modeli `rover` | `rover-skid`). Rover'da kalkış yöntemi **yok sayılır** (`launch` nötr `{method:'wheels'}`;
  `flights.launch = 'wheels'`). Yanıt ve `flights.snapshot.drone.drive` oturumun etkin sürüş biçimini taşır; oturum `to_dict` `ground: true`, `drive`.
  WS `takeoff` rover'da kalp atışı beklenmeden reddedilir (çekirdek 400), `motor_cut` reddedilir, `land` → HOLD.
- **Güç (§10):** `power.YAKIT_TIPLERI` += `rover` (yakıt isteğe bağlı), `HIZ_TIPLERI = plane/interceptor/vtol` (rover'da azami hız yok, `max_speed_ms` NULL);
  varsayılan motor **elektrikli**; elektrikliden yakıta geçişte depo 20 L (`ROVER_YAKIT_L`). Model varsayılanları: 4×4 = çekirdek `ROVER_VARSAYILAN`
  (4S 16000 mAh 60 W, 12 km/L), UGV 6S 20000 mAh 150 W 6 km/L, robot 4S 10000 mAh 40 W. Meta `power.fuel_types` / `speed_types` / `rover_fuel_l`.
  JS `fly/power.js`: `canFuel('rover')`, `canSpeed`, `ROVER_DEFAULTS` (HEPGO `defaultsFor('rover')` ile aynı; node testi eşitliği denetler), "Sürüş bataryası" sütunu.
- **Hangar:** tür seçicide 7. kart (Kara Aracı; çubuklar hız 30 / menzil 45 / dayanıklılık 90 / çeviklik 50), model kartlarında "Ackermann · azami 72 km/h" /
  "Paletli · azami 14 km/h" (`roverStat`), şeritte ve başlıkta aynı etiket. 3B önizleme (`procmodels.js`): `wheel_*` düğümleri yavaşça döner, `steer_fl/fr`
  ±12° salınır (`roverParts` / `animateDrone`); GLB yüklenemezse prosedürel `rover` şablonu.
- **Uç sihirbazı:** rover'da Kalkış adımı yok (drone → track → power → mission → site → targets → pilot; hedef ve yer kontrol isteğe bağlı, "Yer kontrolünü koru"
  görevi yalnız INTERCEPTOR). Dron adımında **Sürüş biçimi** kartları (Ackermann / Paletli-diferansiyel; modelin biçimi "Model" rozetli) → `W.state.drive`
  (dron değişince sıfırlanır) → gövde `drive`. Hız ölçeği 80 km/h (Ackermann) / 20 km/h (skid). Alt özet sürüş biçimini gösterir.
- **Uçuş ekranı** (`fly/session.js`): `loadSim` listesinde `/sim/flightsim_rover.js` (`MRover`); mod seçici ArduRover kipleri (`ROVER_MODES`, başlangıç MANUAL;
  fltbar `modeKind('rover')`); `.fs-cmds`'te Kalkış yerine **Dur** (HOLD) + RTL; `takeoffDialog` rover'da uyarı verir; geri sayım/elden atış/fırlatıcı yok.
  3B'ye `drive` verilir (teker kinematiği), güç kadranları `rover: true`, hız kadranı yer hızı, üst çubukta sürüş biçimi rozeti.
- **Sanal kumanda** (`fly/rc.js virtualRC({ rover: { channels } })`): sol çubuk DİKEY gaz (yaylı, bırakınca 1500 = dur; aşağı geri/fren), sağ çubuk YATAY
  direksiyon (yaylı); klavye W/S ya da ↑/↓ gaz, A/D ya da ←/→ direksiyon, Boşluk dur, Q/E mod kanalı. Kanallar `roverRcChannels` → `[RC1, 0, RC3, 0, ch5, 0, 0, 0]`
  (yedek `roverChannelsOf` aynı biçim); hassasiyet: direksiyon `roll`, gaz `thr` eğrisi (`createRcFeelPanel({ rover: true })`, `rcfeel.steer`).
- **i18n (7 dil):** `types.rover(_desc)`, `drive.*` (title, ackermann/skid + _desc + _short, max, model_badge, note), `rover.*` (çekirdek `ROVER_TEXTS`'in 16
  anahtarı + rc_hint/rc_left/rc_right/rc_title, hold/hold_title, no_takeoff, gauge_title), `power.step_sub_rover`, `power.hourly_w_hint_rover`,
  `power.col_batt_rover`, `rcfeel.steer`; tanıtım sitesi `type.rover`, `fleet.rover_*.d`.
- **Testler:** `tests/test_simumav_rover.py` (eşleme, katalog, hedef dışı, hangar, drive 422/varsayılan/ezme, launch yok sayılır, snapshot, WS hello, takeoff /
  motor_cut reddi, ARM + RC ile sahte sürüş, land → HOLD), `test_simumav_power.py|mjs`, `test_simumav_fly.mjs`, `test_simumav_rc.mjs`, `test_simumav_models.py`
  (rover GLB'lerinde pervane yok, `wheel_*`/`steer_*`), `test_simumav_site.mjs` (filo). Gerçek SITL: `SMP_REAL=1 HEPGO_SITL_DIR=/opt/hepgo/sitl/bin`.
  Görsel: `tests/rover_shots_simumav.py` → `/tmp/rover-shots/simumav-*.png`.

## 16. Servo tetik — HEPGO docs/ucus-simulatoru.md §34'ün SIMUMAV karşılığı (`fly/session.js`, ortak `flightsim_servotrig.js`, çekirdek `app/flightsim_servotrig.py`)
- `loadSim` listesinde `flightsim_servotrig.js` (`MSrv`): alt bantta mod seçicinin solunda TEK servo simgeli **Dinle** düğmesi; basınca yukarı açılan
  panel (kanal S1–S16 · koşul · PWM µs · gecikme ms · canlı PWM · Dinlemeye başla / Dinlemeyi durdur); dinlerken düğme kırmızı yanıp söner
  ("Dinleniyor"), Esc / dışarı tıklama kapatır (HEPGO §34, §36). Metinler `srv.*` anahtarları (7 dil; `makeSrvT(tr, true)`), rapor kartı metinleri Türkçe anahtarla 7 dilde.
- Alt bant kapsülleri (HEPGO §36, `fly/session.js`): görünüm + kamera türü TEK kapsül (`createCameraCtl({views: M3D.CAMERA_MODES})`; görünüm adları
  `camera.view_*` 7 dil, `camTr`), Panel + ses TEK kapsül (`.fs-ops-snd`). Görsel: `tests.fltbar_shots_simumav`.
- Komut çekirdeğe WS `cmd servo_trigger` ile gider (`SIM_KOMUT = KOMUTLAR`; `guvenlik_komut` engel koymaz). Tetik/gecikme/çarpma çekirdekte; WS
  `servo_trigger fired` → 2,5 sn sonra `endFlight({auto: true})` (onaysız) → `/api/fly/{id}/stop` → uçuş özeti (`MReport.reportBody` "⚡ Servo tetik"
  kartı). Oyuncu sekmeyi kapatırsa çekirdek 5 sn sonra kendisi kapatır (`end_reason servo_trigger`; `bridge._sonuc` → `crash`).
- `shim/db.py` `RUN_EK_SUTUNLAR` + `servo_trig` (eski core.db'ye ALTER); dron kaydı önerisi (`drone_sitl_options srvtrig_*`) SIMUMAV çekirdeğinde
  tablo yoksa sessizce atlanır (yerel tercih `fs.srvtrig` yine çalışır).

## 17. Sıfırla korunumu, ağır çekim, kamera yok — HEPGO docs/ucus-simulatoru.md §35'in SIMUMAV karşılığı

Ortak çekirdek (`app/flightsim.py` reset `temiz=False`, MP köprü kalp atışı) SIMUMAV uçuşlarında da geçerli: Sıfırla parametreleri, Lua scriptlerini ve
görevi korur, Mission Planner bağlantısı kopmaz. Simülasyon hızı 0,25× / 0,5× (`/api/meta power.speedups` sunucu sınırıyla; `bridge.speedup_dogrula`,
sihirbaz `S.speedup !== 1` ise gövdeye). Kamera seçiminde "Kamera yok" (`camera_pick.js` 'none'; `camera.none`, `camera.none_desc`, `camera.osd_none`
7 dil): PiP penceresi kurulmaz, gimbal kipi kapalı. Harekât kartı başlığında onaylı ↺ Sıfırla (ortak `flightsim_panel.js`).

## 18. ÇOK OYUNCULU KARŞILAŞMA — halka yarışı (İSTEK 66 aşama 2; HEPGO docs/ucus-simulatoru.md §33 çekirdeği ortak)

Kullanıcı isteği: Uç bölümünde **en başta "Tek oyunculu / Çok oyunculu"** seçimi (tek oyunculu = mevcut akış aynen). Çok oyunculuda kurucu karşılaşmayı
ayarlar (HEPGO'daki radar/EO/yer kontrol yok; halkalar oyundan önce: **min/max irtifa, halka sayısı**; harita/araç mevcut sihirbaz adımlarından); sistem
bir **davet bağlantısı** üretir, **şifreyi kurucu belirler**; davetli bağlantıyı açar → Mastertool hesabıyla girer (giriş yapmışsa e-postası görünür) →
şifreyi girer → **LOBİ**. Kurucu herkes hazır olunca **Başlat**; herkes aynı haritada **farklı başlangıç noktalarında**; yarış başlayana kadar ARM/kalkış
kilitli; **ilk tüm halkaları bitiren kazanır**, herkes sonuç ekranını görür. SIMUMAV'da e-posta gönderim altyapısı yoktur: bağlantı + şifre kurucu
tarafından elle paylaşılır ("e-posta adımı" = hesapla giriş/kimlik).

### 18.1 Dosyalar
| Katman | Dosya | Not |
|---|---|---|
| Ortak saf çekirdek | `app/flightsim_match_core.py` (HEPGO §33) | halka ayarı/üretimi, başlangıç noktaları, geçiş denetimi, durum makinesi, sıralama — **değiştirilmedi** |
| SIMUMAV çalışma zamanı | `app/simumav/match.py` | `Mac` (lobi + çekirdek `Karsilasma` bağlama, oyuncu uçuşları, tele kancası, komut kapısı, WS yayını, DB), `Yonetici`, şifre özeti, deneme sınırı |
| REST + WS | `app/simumav/routers/match.py` | `/api/match…`, `WS /ws/match/{id}` |
| Köprü ekleri | `app/simumav/bridge.py` | `ucus_baslat(start=, match_id=)`, `MAC_REZERV`, `aktif_sayisi` (normal + karşılaşma + ayrılmış), karşılaşmada hız 1× bekçisi |
| Komut sınırı | `app/simumav/routers/fly.py` `guvenlik_komut(…, match)` | karşılaşma oturumunda `speed ≠ 1` ve `set_home` reddi (WS, REST, hub) |
| Ön yüz saf | `static/simumav/app/fly/match_core.js` | rota ayrıştırma, doğrulama (i18n anahtarı), şifre önerisi, davet bağlantısı, salon görünüm modeli, sonuç satırları |
| Ön yüz | `fly/match.js` (halkalar/davet adımları, davet sayfası, salon, yarış ekranı), `fly/match_hud.js` (yarış katmanı), `fly/match.css` | ortak `/sim/flightsim_match.js` (saat, geri sayım, canlı sıralama) + `/sim/flightsim_match3d.js` (3B halkalar + diğer oyuncular) |
| Değişen | `fly/index.js` (seçim ekranı, `#/fly/*` yönlendirme, kurucu sihirbazı), `fly/wizard.js` (`createWizard(…, {match:true})`, `STEPS_MATCH`), `fly/session.js` (`ctx.match` kancası), `app.js` (oturumsuz derin bağlantı → `/?giris=1&sonra=…`), `site/js/auth.js` (`nextTarget`, `?giris` → giriş penceresi) | |

### 18.2 Rotalar (`#/fly/…`; kabuk rota tablosu değişmedi)
`#/fly` seçim ekranı (Tek / Çok oyunculu + "Davetin mi var?" bağlantı/kod kutusu + süren karşılaşma kartı) · `#/fly/solo` mevcut sihirbaz ·
`#/fly/multi` kurucu sihirbazı · `#/fly/join/<kod>` davet sayfası · `#/fly/match/<id>` bekleme salonu / sonuç · `#/fly/match/<id>/race` yarış ekranı ·
`#/fly/<uçuş id>` süren uçuşa dönüş (eskisi gibi). Davet bağlantısı: `https://simumav.com/app/#/fly/join/<kod>`. Oturumsuz açılırsa kabuk
`/?giris=1&sonra=/app/%23/fly/join/<kod>` adresine gider; site giriş penceresini açar, girişten sonra `sonra`'ya döner (yalnız `/app` altı; açık
yönlendirme yok).

### 18.3 Akış
1. **Kurucu sihirbazı** (`createWizard(data, {}, {match:true})`): Dron (kara aracı listelenmez) → Parkur → (Kalkış: sabit kanat/VTOL/INTERCEPTOR) →
   **Halkalar** (sayı 1–30, min/max yükseklik 5–400 m, çap 4–80 m, parkur yarıçapı 80–3000 m, süre 2–60 dk, parkur tohumu 🎲; sağda sunucu önizlemesi
   `POST /api/match/rings-preview` kuş bakışı + başlangıç noktaları + yükseklik profili) → **Davet** (en çok oyuncu 2…sınır, şifre — 🎲 6 karakterlik
   öneri, kurucu değiştirebilir) → **OLUŞTUR** → `POST /api/match` → salon. Güç/görev/yer kontrol/hedef/pilot adımı yoktur: herkes kurucunun dronuyla
   (aynı model, parametre, güç ayarı) ve **kendi varsayılan pilotuyla** uçar.
2. **Davetli**: bağlantı → (giriş) → davet sayfası: "Giriş yapılan hesap: e-posta" (+ başka hesapla gir), kurucu, araç, parkur, halka sayısı, doluluk →
   şifre → `POST /api/match/join` → salon. Yanlış şifre 403 + kalan hak; sınır aşımı 429 (bekleme dakikası).
3. **Salon** (`WS /ws/match/{id}` canlı + 15 sn yoklama): oyuncular (renk, çevrimiçi noktası, Kurucu rozeti, Hazır/Bekleniyor; kurucu ✕ çıkarır —
   çıkarılan aynı karşılaşmaya yeniden giremez), boş yerler, ayarlar + parkur çizimi, davet kutusu (bağlantı + Kopyala; kurucuda şifre + Kopyala +
   "Bağlantı + şifreyi kopyala" + Yeni şifre — şifre yalnız oluşturan tarayıcıda `sessionStorage`'da görünür, sunucu düz şifreyi saklamaz), davetlide
   **Hazırım**, kurucuda **BAŞLAT** (≥ 2 oyuncu ve herkes hazır; sunucu `can_start`), Ayrıl / İptal.
4. **BAŞLAT** (`POST /{id}/start`): denetimler → çekirdek `Karsilasma(kurucu, katılanlar)` kurulur ve herkes "geldi" yapılır → **HAZIRLIK**: her
   oyuncuya `bridge.ucus_baslat(..., start={lat, lon, yaw_deg}, match_id)` ile kendi uçuşu (flights satırı `match_id`, .bin kaydı açık, MP köprüsü YOK).
   Başlangıç noktaları `core.baslangic_noktalari` (dikey kalkanlar ≥ 40 m çember, sabit kanat pist yönüne dik şeritler). Salon sayfası oyuncunun
   uçuşu açılınca yarış ekranına geçer (yarıştan "Geri" ile dönüldüyse kendiliğinden geçmez → "Yarışa dön").
5. **Yarış ekranı**: `GET /api/fly/<flight_id>` → `openSession(..., {match})`. 3B dünya kurulup oturum HAZIR olunca WS `ready`; herkes hazır →
   **GERI_SAYIM** (`start_at` sunucu saati; istemci `pong.now` ile saat farkını kestirir) → son 3 sn'de oturumun giriş sekansı (3‑2‑1) herkeste aynı
   anda → **YARIS**: komut kapısı açılır. Üst şerit: sıradaki halka, yön oku, mesafe, yükseklik farkı, süre; sağda canlı sıralama; halka geçişi /
   ters yön / bitiş bildirimleri. Halka geçişi **sunucuda** doğrulanır (çekirdek `HalkaIzleyici`; tele kancası, her telemetri karesinde).
6. **BITTI** (ilk bitiren `birinci_bitirdi` ya da süre `sure`): WS `result` → herkeste sonuç penceresi (sıra, süre, halka x/n, sıradakine mesafe, azami
   hız, durum) → "Salona dön" → salonda sonuç tablosu. Oyuncu uçuşları `KAPANIS_GECIKME_S` (8 sn) sonra `bridge.ucus_durdur(fid, 'karsilasma_bitti')`
   ile kapanır (flights satırı tamamlanır, Operasyon'da görünür); yarış ekranındaki "Uçuş sona erdi" perdesi bu nedenle gösterilmez.

### 18.4 REST / WS sözleşmesi
- `GET /api/match/meta` → `{limits{players[2, max], count, alt_m, diameter_m, radius_m, time_limit_min, password[4, 32], types, defaults{dikey, ucak},
  countdown_s, lobby_timeout_s, attempts}, capacity{max, used}, current{id, state, host}|null}`.
- `POST /api/match/rings-preview {drone_id, track_id, rings, players?}` → `{cfg, rings, starts}` (kendi dron/parkur kaydı; başkasınınki 404).
- `POST /api/match {drone_id, track_id, launch?, camera?, rings, password, max_players}` → 201 anlık görüntü (+ `code`); 422 geçersiz (kara aracı,
  kısa şifre, oyuncu sınırı), 409 `match_open`, 429 (saatte 10 oluşturma / sunucuda açık karşılaşma tavanı).
- `GET /api/match` son 20 karşılaşmam · `GET /api/match/{id}` (yalnız oyuncular; değilse 404; bellekte yoksa DB satırı `live:false`).
- `GET /api/match/invite/{code}` → `{code, joined, id?, state, host_name, track, world_mode, drone{name,type}, rings, players, max_players, me{id,
  email, name}, kicked}` (şifre ve diğer oyuncuların adları/e-postaları yok); bilinmeyen kod 404 (IP başına başarısız sorgu 30/10 dk), bitmiş 409.
- `POST /api/match/join {code, password}` → anlık görüntü · 403 `bad_password {remaining}` · 429 `too_many_attempts {retry_after}` · 404 · 409
  `full | started | match_open` · 403 `kicked`.
- `POST /api/match/{id}/ready {ready}` · `/leave` (kurucu → IPTAL `kurucu_ayrildi`) · `/kick {user_id}` · `/start` · `/cancel` · `/password {password}`.
  `start` hataları: 403 kurucu değil · 409 `not_enough | not_ready | flight_open` (süren uçuşu olan oyuncu adlarıyla) · 429 `server_full {need, free,
  retry_after}` "Sunucuda yeterli simülatör yuvası yok: N oyuncunun her biri kendi simülatörünü alır, şu an M boş yuva var…".
- Anlık görüntü: `{id, code, state, reason, host_id, max_players, created_at, settings{drone{name,type,model_key,color}, track{name,lat,lon,
  world_mode,radius_m,weather,time_of_day}, launch, camera, type}, rings_cfg, rings[{i, lat, lon, x, y, agl_m, alt_msl, yaw_deg, nx, ny, radius_m}],
  center{lat, lon, alt}, players[{id, name, host, status, ready, online, flight_id, session_id, start, rings, total, next, dist_next_m, finished,
  max_speed_ms, crashes}], can_start, prepare_at, start_at, ended_at, winner, result, countdown_s, now, live, me}`.
- `WS /ws/match/{id}` (çerez; oyuncu değilse `{t:'error', error:'forbidden'}` + 4403; 20 mesaj/sn): sunucu → `hello{match, me}`, `match{match}`,
  `player`, `state`, `countdown{start_at}`, `pos{ts, p[{id, lat, lon, alt_msl, alt_rel, yaw, roll, pitch, gs, armed, rings, next, dist}]}` (10 Hz),
  `ring{id, i, total, elapsed_s}`, `finish`, `wrong_way`, `result{result}`, `pong{now}`; istemci → `ping`, `ready`.

### 18.5 Güvenlik ve kaynak sınırları
- **Şifre**: 4–32 karakter, kontrol karakteri yok; `hashlib.scrypt` (n=2¹⁴, r=8, p=1, 16 bayt tuz) → `matches.pass_hash = scrypt$<tuz>$<özet>`;
  doğrulama `hmac.compare_digest`, iş parçacığında. Düz şifre hiçbir yanıtta/günlükte yok.
- **Kaba kuvvet** (`match_attempts`, 15 dk pencere): kullanıcı × karşılaşma 5 yanlış, IP 20 yanlış, karşılaşma toplam 60 yanlış → 429
  `too_many_attempts` (doğru şifre de reddedilir); yanlış denemeler `audit match_bad_password`. 1 günden eski denemeler açılışta silinir.
- **Davet kodu**: `secrets.token_urlsafe(16)` (128 bit); bilinmeyen kod denemesi IP başına oran sınırlı (`match_code_fail` 30/10 dk).
- **Sınırlar**: oyuncu ≤ `min(8, SIMUMAV_MATCH_MAX_PLAYERS, SIMUMAV_MAX_FLIGHTS)` (kurucu dahil); kullanıcı aynı anda tek bitmemiş karşılaşmada
  (kurucu/oyuncu); sunucuda ≤ `SIMUMAV_MATCH_MAX_OPEN` (30) bitmemiş karşılaşma; oluşturma saatte 10/kullanıcı.
- **Temizlik**: lobi 30 dk'da başlamazsa IPTAL `zaman_asimi`; kurucu `SIMUMAV_MATCH_ABANDON_S` (300 sn) görünmezse (salon WS'i yok, GET yok) IPTAL
  `terk_edildi`; görünmeyen davetli lobiden düşer (yeniden şifreyle girer); hazırlıkta 150 sn'de hazır olmayan düşer (çekirdek); biten karşılaşma 15 dk
  bellekte, sonra yalnız DB; sunucu yeniden başlarsa bitmemiş satırlar IPTAL `sunucu_yeniden_basladi`, kapanışta süren karşılaşmalar `sunucu_kapaniyor`.
- **SITL tavanı** (`SIMUMAV_MAX_FLIGHTS` = çekirdek `SIM_MAX_SESSIONS`; çekirdeğin `SIM_MATCH_MAX_SESSIONS`'ı aynı değere eşitlenir): her oyuncu kendi
  SITL'ini alır; BAŞLAT'ta n oyuncu için n boş yuva yoksa 429 (anlaşılır mesaj). Yuvalar oturumlar açılana dek `bridge.MAC_REZERV` ile ayrılır;
  `aktif_sayisi()` = normal + karşılaşma + ayrılmış → normal uçuşların 429 "bekleme odası" denetimi de karşılaşmaları sayar.
- **Adalet**: yarış başlayana kadar ARM / kalkış / görev başlatma / sanal kumanda RC'si reddedilir (çekirdek komut kapısı: web WS/REST ve hub); MP TCP
  köprüsü açılmaz (ham MAVLink kapıyı aşamasın); simülasyon hızı 1× sabit (istek reddi + bekçi geri yazar; süre duvar saatiyle ölçülür);
  `set_home` reddi; yalnız sıradaki halka, doğru yönde ve halka içinden geçiş sayılır; > 250 m sıçrama (Sıfırla) geçiş sayılmaz.
- Başkasının oturumuna komut 404 (oturum sahipliği); salon/yarış WS'i yalnız oyunculara.

### 18.6 Veritabanı göçü (v3; idempotent)
`SCHEMA` içinde `CREATE TABLE IF NOT EXISTS`: `matches (id, code UNIQUE, host_id, pass_hash, state, reason, max_players, settings, rings_cfg, rings,
result, winner_id, created_at, started_at, ended_at)`, `match_players (match_id, user_id, name, is_host, status, flight_id, rank, rings, time_s,
joined_at; PK match_id+user_id)`, `match_attempts (id, match_id, user_id, ip, ok, ts)` + indeksler; `flights.match_id` sütunu `PRAGMA table_info`
denetimiyle `ALTER TABLE … ADD COLUMN` (yalnız yoksa) + `ix_flights_match`. `schema_version` 3 (veri dönüşümü yok; geri alınması gerekmez).
Karşılaşma uçuşunda `flights.drone_id` / `track_id` yalnız kayıt oyuncunun kendisininse yazılır (kurucunun dronu/parkuru başkasının hesabına bağlanmaz;
anlık görüntüde adları durur); `snapshot.match = {id, start}`.

### 18.7 Testler ve görsel doğrulama
- `.venv/bin/python -m tests.test_simumav_match` (sahte kinematik, 5 hesap): meta sınırları, önizleme deterministik, oluşturma doğrulaması, şifre özeti,
  davet özeti, bilinmeyen kod 404, yanlış şifre 403 + kalan hak, kaba kuvvet 429, katılım, oyuncu olmayan 404 / WS 4403, dolu 409, çıkarılan geri
  giremez, hazır olmadan / açık uçuşla / yuva yetmezken başlatma reddi, BAŞLAT → farklı başlangıçlar + flights.match_id + MP yok, komut kapısı + hız
  1×, WS ready → geri sayım → YARIS → halka 1‑2‑3 → kazanan → iki WS'de sonuç → uçuşlar kapanır, DB BITTI + sıralama, geçmiş, iptal / kurucu ayrılır /
  terk edilen lobi, göç idempotent.
- `node tests/test_simumav_match.mjs` (match_core.js + `createWizard({match:true})` + 7 dil anahtar/yer tutucu denetimi).
- Görsel: `.venv/bin/python -m tests.simumav_match_e2e` → `/tmp/smmatch-shots/` (seçim ekranı, kurucu halkalar / davet-şifre, salon bağlantı+şifre,
  oturumsuz davet → giriş, davetli şifre ekranı + yanlış şifre, salon hazır, hazırlık bekleme, yarış HUD'u (iki taraf), sonuç (iki taraf), salonda sonuç).

## 19. Alt bant kapsülleri, sanal kumanda varsayılan açık, fiziksel kumanda, kumandada çubuk göstergeler, mobil menü — HEPGO docs/ucus-simulatoru.md §36–§39'un SIMUMAV karşılığı
- `fly/session.js` `loadSim` listesinde `flightsim_gamepad.js` (`MPad`): bağlanan gamepad / USB RC verici sanal kumandanın RC yoluna (`rc.js virtualRC`
  `pad`, `lazyThr`, `bumpCh5`) beslenir; alt bantta Kumanda simgesi + eşleme paneli; metinler `pad.*` (7 dil). Sanal kumanda varsayılan açık
  (`sm.rcOn`; kullanıcı kapatırsa hatırlanır). Ayrıntılar HEPGO §37.
- Kumanda paneli: **kumanda girdisi hassasiyeti** (genel ölçek, eksen başına ölçek + expo, SVG eğri önizlemesi; ⚙ Hassasiyet = ortak çıkış eğrisi,
  önizlemede kesikli turuncu — `createGamepadCtl({ vehicle, feelShape: rcShape })`), basılı düğme / oynatılan eksen satırı parlaması
  (requestAnimationFrame, yalnız panel açıkken) ve satır başına **Algıla**; uçak + RC verici gazı `rc.js` içinde `ps.thrAbs` (tek yönlü eğri).
  Metinler `pad.sens`, `pad.scale*`, `pad.rate`, `pad.expo`, `pad.axis_steer`, `pad.in_out`, `pad.sens_note`, `pad.thr_abs`, `pad.learn*`,
  `pad.press`, `pad.move`, `pad.live` (7 dil). Ayrıntılar HEPGO §37.
- Kumanda açıkken kadranlar alt ortada ince ilerleme çubukları (HEPGO §38; `power.css` kadranları üzerine `flightsim_gtheme.js` CSS'i). Mobilde
  (`flightsim_mobile.js`, `MMob`; HEPGO §39) üst şerit + alt bant ☰ menüsünde; `mob.*` 7 dil.

## 20. Hedefli uçuşta Boşluk ile kilit + angajman — HEPGO docs/ucus-simulatoru.md §40'ın SIMUMAV karşılığı
- `fly/session.js` `loadSim` listesinde `flightsim_engage.js` (`MEng`): hedefli uçuşta (`session.targets`, hello'da gelebilir → `ensureEngage`)
  Boşluk / kumanda `lock` düğmesi → `cmd engage` (WS `cmd`; şeride "Komut: engage" yazılmaz), WS `engage` → panel + olay + skor rozeti
  (`m.state`). Kumanda ipucunda `eng.rc_hint`. Çekirdek komutu ve sunucu angajman takibi HEPGO ile aynıdır (`app/flightsim.py`,
  `app/flightsim_targets.py`); kilitli önleme bonusu (+250) skora eklenir.
- Uçuş özeti hedef kartında "◆ Angajmanlar" satırları (`fly/targets.js engagementRowsEl`). Metinler `eng.*` + "KİLİT" / "Boşluk: kilit" (HUD) +
  `pad.act_lock` (7 dil).

## 21. Karşılaşmada "İt dalaşı" türü — HEPGO docs/ucus-simulatoru.md §41'in SIMUMAV karşılığı
- Kurucu sihirbazının "Tür ve kurallar" adımı (`match.step_rings`; `fly/match.js createRingsStep`): "◎ Halka yarışı" | "✈ İt dalaşı" kartları; it
  dalaşında mesafe, irtifa, süre, menzil, koni, tutma süresi, alan sınırı + roller ("Rastgele / Ben kovalarım / Ben kaçarım") ve sunucu önizlemesi
  (`POST /api/match/rings-preview {kind:'dogfight', dogfight}` → iki başlangıç noktası, ortak `dfSvg`). Davet adımında oyuncu sayısı 2'ye sabit.
  Gövde `POST /api/match {…, kind, dogfight, max_players: 2}`; davet linki / şifre / salon akışı aynı.
- `app/simumav/match.py` `Mac.tur`: oyuncu tavanı 2, halka yok, roller BAŞLAT'ta (çekirdek HAZIRLIK), başlangıç rol başına, tele kancası yön +
  yunuslama, çarpışma → kaybeder, `pos.df`, Sıfırla kapısı. Anlık görüntü / davet özeti / liste `kind`; DB satırından (`satir_dict`) rol sonuçtan.
- **DB göçü v4** (`app/simumav/db.py`, idempotent): `matches.kind TEXT NOT NULL DEFAULT 'rings'` + `matches.game_cfg TEXT` (`init()` içinde
  `PRAGMA table_info` denetimiyle ALTER; `schema_version` 4; veri dönüşümü yok).
- Yarış ekranı (`fly/match_hud.js`): it dalaşında sıralama tablosu yerine ortak `createDogfightHud` (rakip işaretçisi, angajman halkası,
  KİLİTLENİYOR! + ses, rol/süre/mesafe/bağıl irtifa şeridi); sonuç penceresi ve salonda `dfResultTable` (rol, oyuncu, sonuç, azami hız + angajman
  süresi / en yakın mesafe). Metinler `df.*` (7 dil). Testler: `tests.test_simumav_match` `it_dalasi`, `node tests/test_flightsim_dogfight.mjs`.


## 22. Uçuş uyarı sistemi (GPWS / master caution) — HEPGO docs/ucus-simulatoru.md §42'nin SIMUMAV karşılığı
- `fly/session.js` `loadSim` listesinde `flightsim_gpws_ui.js` (`MGpws`): uçuş ekranında `createGpwsCtl` (keyed; metinler `gpws.*`, 7 dil) —
  büyük WARNING/CAUTION kutusu, MASTER lambaları, vinyet, FPV OSD / gimbal HUD metni, sentez sesler + konuşma (motor sesinin ses kapsülüne bağlı),
  ses kapsülü menüsünde "Uçuş uyarıları" + ⚙ panel. Tercih `sm.gpws` (`gpwsStorage`); sihirbazın Pilot adımında aynı seçici (`fly/index.js`).
  Sanal çit = parkur yarıçapı (`track.radius_m`); azami hız = güç ayarı.
- Biten uyarılar WS `cmd gpws` ile çekirdeğe (şeride "Komut" yazılmaz, hata toast'ı yok); Bitir'de `flush()` → `POST /api/fly/{id}/stop` yanıtının
  özetinde `alerts`. `app/simumav/bridge.py` uçuş kapanışında `flights.summary.alerts` (tür başına adet/süre + uçuş disiplini puanı); çekirdek
  `drone_sim_runs.alerts` / `alert_score` sütunları `shim/db.py RUN_EK_SUTUNLAR` ile (idempotent ALTER).
- Uçuş özeti modalında "⚠ Uçuş uyarıları · Uçuş disiplini" kartı (`.sm-gpws-card`; HEPGO `.fs-rp-gpws` bölümü CSS'te gizli). Operasyon kayıttan
  oynatmasında (`ops/replay.js`) kareler aynı değerlendiriciden geçer (AGL = alt_rel; ses yok, gönderim yok).

## 23. Grafik kalite ayarları — HEPGO docs/ucus-simulatoru.md §43'ün SIMUMAV karşılığı
- Uçuş ekranı (`fly/session.js`): `loadSim` listesine `flightsim_gfx_ui.js` (MGfx); `MGfx.createGfxCtl({ tr, keyed: true, storageKey: 'sm.gfx', … })`
  düğmesi Panel/ses kapsülüne (`opsSnd.append`), `createFlightSim3D(…, { gfx: gfxCtl.initial() })`, sahne kurulunca `gfxCtl.attach(sim)` (GPU adı →
  otomatik kademe + uyarlamalı kip), iki dispose zincirinde `gfxCtl.dispose()`.
- Sihirbaz son adımı ("Pilot ve kayıt", `fly/index.js stepPilot`): gösterge tasarımının altında `/sim/flightsim_gfx_ui.js createGfxPicker` (sm.gfx).
- Ön ayarlar, uyarlamalı kip, son işlem, kayıt tabanı HEPGO ile birebir (ortak çekirdek). Metinler `gfx.*` (7 dil, `static/simumav/app/i18n/*.json`).
- Görsel: `./.venv/bin/python -m tests.gfx_shots_simumav` (GFX_LANG=en ile İngilizce menü).
