# Bayram / tatil temaları (HEPGO + SIMUMAV)

Ülkenin o günkü bayramına göre hafif kutlama efektleri: SIMUMAV oyun menüleri, simumav.com tanıtım sitesi ve HEPGO panosu.
Karar (2026-10-23): 20 temanın tümü; ülke tespiti önce kullanıcının girdiği konum, yoksa tarayıcı saat dilimi + dili; **IP'den konum sorgusu yok**.

## Parçalar

| Dosya | Görev |
|---|---|
| `app/holiday_themes.py` | SAF modül (yalnız stdlib; HEPGO + SIMUMAV ortak). Tema kataloğu (20), eşleme kuralı, derlenmiş veriyi okuma, `day_info()`, konum → ülke (`country_at`). |
| `tools/holiday_themes_build.py` | Veri DERLEYİCİ (python-holidays yalnız burada, ayrı venv). Çıktılar aşağıda. |
| `static/data/holidays/<yıl>.json` | 2026–2030, ~246 ülke, yıl başına ~3 900 kayıt (~390 KB, gzip ~63 KB). |
| `static/data/holidays/borders.json` | Natural Earth 1:50m ülke sınırları (kamu malı), 0,05° nicemlenmiş + RDP sadeleştirme (~380 KB). Yalnız sunucu okur. |
| `static/js/modules/holiday_tz.js` | Üretilmiş saat dilimi → ülke tablosu (IANA zone.tab + tzdata.zi eski adlar; 542 dilim). |
| `static/js/modules/holiday_fx.js` | Ortak istemci: ülke tespiti, birleşik tema seçimi, arife kuralı, kare bütçesi, kutlama şeridi (7 dil), Canvas2D motoru, `mountHolidayFx()`. |
| `static/js/modules/holiday_fx_themes.js` | 20 temanın prosedürel/vektör çizimleri (tembel yüklenir). Dış görsel yok. |
| `static/vendor/flag-icons/` | Ülke bayrakları (flag-icons 7.6.0, **MIT**, `LICENSE` dizinde); bağımsızlık/genel temada dalgalanan bayrak + bayrak renkleri örneklenir. |
| `app/routers/holiday.py` | HEPGO uç noktaları. |
| `app/simumav/routers/holiday.py` | SIMUMAV uç noktaları. |
| `static/js/holiday.js` | HEPGO kabuk bağlantısı (yalnız pano). |
| `static/js/modules/flightsim_holiday3d.js` | Uçuş sahnesi 3B süsleri (aşağıda). |

## Uç noktalar

- `GET /api/holiday-theme?country=TR&date=YYYY-MM-DD&lang=tr` — oturumsuz; `Cache-Control: public, max-age=3600`.
  Yanıt: `{country, date, active:[{theme, theme_tr, name, name_en, name_local, country, date, day_index, days_total, category, half_day?, estimated?, observed?}], next:{…, in_days}|null}`.
  `active` öncelik sırasında (aynı gün birden çok bayram: ör. TR 2027-05-19 → Kurban 5/5 + Gençlik ve Spor). Bugünkü bayramın ardışık günleri "sonraki" sayılmaz.
- `GET /api/holiday-theme/me` — oturumlu; `{enabled, country (ayar), located (girilen konumdan ülke), located_source, countries, themes}`.
  - HEPGO konum: kullanıcının kendi çalışan adresindeki koordinat → firmadaki adreslerin çoğunluk ülkesi (10 dk önbellek).
  - SIMUMAV konum: kullanıcının en son güncellenen kendi parkurunun merkezi (varsayılan TRTEST parkuru sayılmaz).

## Ülke tespiti (istemci, `detectCountry`)

1. Kullanıcının seçtiği ülke (HEPGO `prefs.settings.holiday.country`, SIMUMAV `settings.holiday_country`)
2. Sunucunun girilmiş konumdan bulduğu ülke (`/me` → `located`)
3. `Intl.DateTimeFormat().resolvedOptions().timeZone` → `TZ_COUNTRY`
4. `navigator.languages` bölge eki (`tr-TR` → TR)

Tanıtım sitesinde oturum olmadığından 3 → 4.

## Tema seçimi ve kurallar

- Eşleme: İngilizce bayram adı küçük harfe çevrilir, anahtarlar kelime sınırlı aranır, ilk eşleşen tema (rapor betiği `~/mt-work/raporlar/ulke-bayramlari-uret.py` ile birebir).
  **Tek sapma:** `cin_yeni` `yilbasi`den önce denenir (aksi hâlde "Lunar/Chinese New Year" Yılbaşı'na düşüyordu).
- Birleşik tema: en çok iki tema; ana tema tam, ikincil yarı yoğunlukta ve büyük figürsüz. `genel` yalnız başka tema yoksa.
- Arife (`half_day`, ör. TR Ramazan 8 Mart, Kurban 15 Mayıs, Cumhuriyet 28 Ekim): 13.00'ten önce efekt yok.
- **Hicri / ay takvimi tarihleri tahminidir** (`estimated`); ülkeye göre ±1 gün kayabilir.
- Yerel tarih istemcinin günüdür (sunucu saati değil).

## Görsel kurallar

- Tek tam ekran Canvas2D (`canvas.holiday-fx`, `pointer-events: none`). SIMUMAV oyun: z 2 (#view üstünde, kabuk düğmeleri altında);
  site: z 40 (nav altında); HEPGO: z 19, üst çubuğun altından başlar.
- `prefers-reduced-motion` (ve SIMUMAV ayarı / HEPGO "Hareketleri azalt") → tek durağan kare (köşe süsü). Sekme gizli → döngü durur.
  Düşük güç (≤4 çekirdek / ≤4 GB / saveData / dar dokunmatik) → 24 fps + yarı yoğunluk.
- Uçuş: SIMUMAV `#view.sm-fly-session`, HEPGO `.fs-stage` → katman gizli (uçuş sahnesinde efekt yok).
- HEPGO: yalnız panoda; ilk 14 sn tam, sonra sakin kip (yoğunluk ×0,35). Kutlama şeridi günde bir kez (tema+tarih+ülke).

## Uçuş sahnesi: 3B bayram süsleri

Kural (kullanıcı, 2026-10-23): **uçuşta hiçbir 2B ekran katmanı yok** — parçacık, kutlama şeridi, toast gösterilmez (`holiday_fx.js` `inFlight` → HEPGO `.fs-stage` / `simActive()`, SIMUMAV `#view.sm-fly-session`).
Onun yerine tema etkinse **3B dünyaya uçuşu engellemeyen süsler** konur: `static/js/modules/flightsim_holiday3d.js` (HEPGO + SIMUMAV ortak; `flightsim*.js` deseniyle dışa aktarma manifestine kendiliğinden girer).

| Tema | Süs |
|---|---|
| kurban | Pistten uzak çayırda 6–12 otlayan / yavaşça gezen düşük poli koyun (instancing; otlama + yürüme; arazi yüksekliğine oturur) |
| ramazan, hicri | Direklerde fener dizileri (ışıklı) + hilal-yıldız tabelası |
| noel | Süslü çam (≤ 4 m) + yer karı (yalnız görsel zemin dokusu) + hediye kutuları |
| cadilar | Oyulmuş, ışıklı balkabakları + korkuluk |
| paskalya | Çimde boyalı yumurtalar + tavşan |
| yilbasi | Işık dizileri; **gece/akşam** ufukta (evden ≥ 1,5 km, uçuş alanının çok dışında) seyrek havai fişek |
| bagimsizlik, genel | Dalgalanan ülke bayrakları (direk 8 m; rüzgâr yönüne uçar) + yakın binaların çatısında bayrak |
| cin_yeni · diwali · holi · hindu · yahudi | Kırmızı fenerler · kandiller · renkli toz lekeleri · nilüfer göleti · menora tabelası |
| cocuk_genclik · emek · bahar | Uçurtma standı + alçak balon demetleri · karanfil tarhları · çiçekli ağaçlar + yer seviyesinde kelebekler |
| kadin_anne · sevgi · hristiyan | Çiçek tarhları · kalp biçimli tarh · çan kulesi süsü |

İkincil tema (aynı gün iki bayram) yarı sayıda ve büyük figürsüz (tabela/ağaç/kule yok).

**Uçuşu engellememe kuralları** (saf `planDecor` / `keepoutZones`; `tests/test_flightsim_holiday3d.mjs`):

- Süsler çarpışma/engel listesine (`buildingsAABB`, §18 çarpışma kutuları) **eklenmez**; arazi yüksekliği değişmez; ışık kaynağı eklenmez (parlama MeshBasic + toplamsal nokta haleleri).
- Yükseklik ≤ 4 m; bayrak direkleri ≤ 8 m ve evden/düzenekten ≥ 30 m; çatı bayrağı binanın üstünde ≤ 3 m. Süsler evden ≤ 170 m (fişek ve çatılar hariç).
- Boşluk tamponları: pist (kenardan 25 m) + uçlarından 200 m kalkış/yaklaşma koridoru; ev (kalkış noktası) 30 m; rampa/fırlatıcı/araç 30 m; §26 saha 30 m; yer kamerası noktası; rüzgâr tulumu;
  alçak (≤ 40 m) §24 hedef yörüngeleri ± 15 m; sahnedeki pilotlar; **dış engel bölgeleri** `sim.setDecorKeepouts(anahtar, [{x, y, r, r0?}])` — SIMUMAV FPV halkaları (`'gates'`) bağlı;
  HEPGO FPV parkurları / karşılaşma başlangıçları aynı listeyi doldurabilir (+ 8 m pay). Su, bina üstü ve engelli zemin atlanır; yer yoksa süs konmaz.
- §43 kalite: Düşük ×0,5 (hale ve fişek yok, kelebek yok), Orta ×0,75, Yüksek ×1, Ultra ×1,2. Bütçe ≤ 20 000 üçgen, ≤ 2 ms/kare (`sim.holidayInfo()` → `tris`, `avgMs`).
- Dünya / pist yönü / saat / kalite / engeller değişince 1 Hz anahtar karşılaştırmasıyla yeniden yerleşir; Google 3B'de karolar geldikçe zemine yeniden oturur. Yerleşim deterministiktir (dünya tohumu + tema).
- Termal kamerada koyunlar ılık görünür.

**Ayar:** HEPGO Kişisel Ayarlar › Bayram temaları › "Uçuş sahnesinde bayram süsleri" (`prefs.settings.holiday.scene3d`, varsayılan açık);
SIMUMAV Ayarlar › "Uçuş sahnesinde bayram süsleri" (`settings.holiday_3d`, varsayılan açık). **Genel bayram teması kapalıysa bu da kapalıdır.**
Önizleme: uçuş adresine `?bayram=<tema>` (ayar kapalı olsa da gösterir). Ülke/tema çözümü pano katmanıyla aynı (`holiday_fx.resolveHoliday`).
**Kayıttan oynatma:** kaydın tarihine göre değil, **o anki** temaya göre (canlıyla aynı yol; sade).

API (flightsim3d): `setHoliday({themes, country}) | null`, `holidayInfo()`, `holidaySheep()`, `setDecorKeepouts(key, zones)`; uygulama bağlantısı `applyHolidayDecor(sim, {enabled, enabled3d, country, located})`.

## Ayarlar

- HEPGO: Kişisel Ayarlar › **Bayram temaları** — aç/kapa (varsayılan açık), ülke (Otomatik / liste), Sistem Yöneticisi / MASTER için "Temayı önizle".
- SIMUMAV: Ayarlar › Bayram temaları + Bayram ülkesi; geliştirici oturumunda (ya da `?bayram=` ile açıldığında) "Temayı önizle".
- Önizleme her yerde: `?bayram=<tema>[,<tema2>][&bayram_ulke=TR]` (yalnız görsel; kaydedilmez).

## Yıllık yenileme

```bash
python3 -m venv /tmp/bayram/venv && /tmp/bayram/venv/bin/pip install holidays
/tmp/bayram/venv/bin/python -I tools/holiday_themes_build.py --root . --years 2027-2031
# sınırlar değişmez; gerekirse: --borders ne_50m_admin_0_countries.geojson (Natural Earth, ayrı dizine indirilir)
./.venv/bin/python -m tests.test_simumav_holiday && node tests/test_simumav_holiday.mjs
```

`app/holiday_themes.py` `YEARS` aralığını yeni yıllarla güncelleyin. Sunucu tarafında yeni pip bağımlılığı yoktur.

## Testler

- `python -m tests.test_simumav_holiday` — katalog/eşleme, derlenmiş veri (TR 2027 listesi), gün bilgisi, konum → ülke, SIMUMAV uç noktaları + ayarlar.
- `node tests/test_simumav_holiday.mjs` — saf istemci mantığı + sahte tuvalle 20 temanın çizim duman testi.
- `node tests/test_flightsim_holiday3d.mjs` — uçuş sahnesi süsleri: tampon/yükseklik kuralları, sayı sınırları, kalite kademesi, three.js kurulumu (üçgen/kare bütçesi), bağlantılar.
- Görsel: `tests/simumav_holiday_shots.py` (oyun + site), `python -m tests.holiday_hepgo_shots` (HEPGO pano + uç noktalar) → `/tmp/bayram-shots/`; uçuş sahnesi süsleri `tests/holiday3d_shots.py` → `/tmp/bayram3d-shots/`.
