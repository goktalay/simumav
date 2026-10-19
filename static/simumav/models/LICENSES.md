# SIMUMAV gerçekçi dron modelleri — kaynaklar ve lisanslar

Bu dizindeki GLB'ler `tools/simumav_models_build.py` ile açık kaynak Gazebo/SDF modellerinden ve hazır GLB'lerden üretildi
(SDF → pycollada/trimesh → üçgen bütçesi ≤ 55 k, dokular ≤ 1024², glTF Y yukarı / burun +X / sağ +Z, metre; pervaneler `rotor_*`/`propeller`
düğümleri, kontrol yüzeyleri `aileron_l/r`, `elevon_l/r`, `flap_l/r`, `elevator`, `rudder`). Her dosya için kaynak, yazar, lisans ve yapılan
değişiklikler aşağıdadır. Lisans metinleri: BSD-3-Clause (PX4), CC-BY 4.0 <https://creativecommons.org/licenses/by/4.0/>,
CC-BY 3.0 <https://creativecommons.org/licenses/by/3.0/>, CC0 1.0 <https://creativecommons.org/publicdomain/zero/1.0/>.

| Dosya | Model | Kaynak | Yazar | Lisans | Değişiklikler |
|---|---|---|---|---|---|
| `iris.glb` | 3DR Iris quadrotor | PX4-SITL_gazebo-classic `models/iris` (https://github.com/PX4/PX4-SITL_gazebo-classic, 807b67b) | Lorenz Meier, Thomas Gubler (PX4) | BSD-3-Clause | SDF'den birleştirme; STL 80 k → 40 k üçgen (decimate); Gazebo malzeme renkleri, ön pervaneler mavi (`accent`) |
| `iris_fpv.glb` | Iris FPV | aynı kaynak (`models/iris`) | Lorenz Meier, Thomas Gubler (PX4) | BSD-3-Clause | iris.glb + prosedürel FPV kamera kutusu/lens ve iki anten (`fpv_cam` düğümü, SIMUMAV ekledi) |
| `x500.glb` | NXP HoverGames X500 | Gazebo Fuel `PX4/x500` v3 (https://app.gazebosim.org/PX4/fuel/models/x500) | Benjamin Perseghetti (PX4/NXP) | CC-BY 4.0 | SDF'den birleştirme; 260 k → 49 k üçgen (karbon dokusu düz renge indirildi, köşe kümeleme); etiket düzlemleri atıldı |
| `typhoon_h480.glb` | Yuneec Typhoon H480 (hexa + gimbal) | PX4-SITL_gazebo-classic `models/typhoon_h480` | Lorenz Meier (PX4) | BSD-3-Clause | SDF'den birleştirme; STL'ler 1,2 M → 50 k üçgen; iniş ayakları (kopuk STL) atıldı; pervaneler mavi (`accent`) |
| `rc_cessna.glb` | RC Cessna 172 | Gazebo Fuel `PX4/rc_cessna` v1 (https://app.gazebosim.org/PX4/fuel/models/rc_cessna) | Benjamin Perseghetti (PX4) | CC0 1.0 | SDF'den birleştirme (ölçek 0,1; inç birimi); kontrol yüzeyi düğümleri `elevon_l/r`, `flap_l/r`, `elevator`, `rudder`; pervane `rotor_puller` |
| `believer.glb` | MakeFlyEasy Believer | PX4-SITL_gazebo-classic `models/believer` | PX4 geliştiricileri | BSD-3-Clause | SDF'den birleştirme; 32 k üçgen; `rotor_left/right`, `elevon_l/r`, `elevator_l/r` |
| `standard_vtol.glb` | PX4 Standard VTOL (X8 kanat) | PX4-SITL_gazebo-classic `models/standard_vtol` | Roman Bapst (PX4) | BSD-3-Clause | SDF'den birleştirme; 49 k üçgen; `rotor_0..3`, `rotor_puller`, `elevon_l/r`, `elevator`, `rudder` |
| `zephyr.glb` | Zephyr delta kanat | Gazebo Fuel `OpenRobotics/Zephyr Delta Wing` v3 (https://app.gazebosim.org/OpenRobotics/fuel/models/Zephyr%20Delta%20Wing) | Cole Biesemeyer, Nate Koenig | CC0 1.0 | SDF alt mesh'leri (center) birleştirildi; 90° yaw (burun +X); doku 512²; LiftDrag hata ayıklama kutuları atıldı |
| `heli.glb` | Helikopter | Poly Pizza https://poly.pizza/m/EQJ2MECUbx | kazuma | CC0 1.0 | ölçek 0,36 (1,75 m), 90° yaw, ana rotor düğümü `rotor_main`; prosedürel kuyruk rotoru (`rotor_extra_0`) eklendi |
| `jet.glb` | Jet (interceptor) | Poly Pizza https://poly.pizza/m/6fyLMORhgGK | jeremy | CC-BY 3.0 | ölçek 0,36 (4 m), 90° yaw (burun +X); pervane düğümü yok |
| `talon_vtail.glb` | Talon tarzı V-kuyruk uçağı | **Prosedürel — dış kaynak yok** (`tools/simumav_models_build.py --talon`: trimesh ile gövde loft'u, kambur profilli kanat, V-kuyruk 37°, itici pervane) | HEPGO (Veilox) | HEPGO'nun kendi üretimi; paketle birlikte serbestçe dağıtılır | 1,72 m açıklık, 1,10 m uzunluk; düğümler `aileron_l/r`, `ruddervator_l/r`, `propeller`; aynı dosya `static/models/talon-vtail.glb` (dahili `builtin:talon`). Arama notu: Gazebo Fuel API 503, Poly Pizza API anahtar istiyor; PX4/ArduPilot Gazebo depolarında V-kuyruklu model yok |

Yeniden dağıtım: BSD-3 ve CC-BY modellerde bu dosya atıf olarak paketle birlikte dağıtılır (tools/simumav_export.py `static/simumav/**` kapsar).
HEPGO'nun kendi Caymaz V3 modeli (`static/models/caymaz-sim.glb`) bu listeye dahil değildir (şirket STEP modelinden).
