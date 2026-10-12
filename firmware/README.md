# Firmware ESP32 — GBXMQTT v2

Satu firmware untuk semua crane. Yang dibedakan per alat hanya `config.h`.

> Per 11 Okt 2026 firmware ini sudah di-compile (core esp32 3.3.12, board *ESP32 Dev Module*) dan di-flash ke 1 ESP32 uji (`crane-30`, tanpa sensor): WiFi, NTP, MQTT, status & backlog berjalan. Sensor PT100 asli **belum** diuji. Uji dulu di **satu** ESP32 sebelum dipasang ke crane lain.
>
> Compile + upload tanpa membuka IDE (arduino-cli bawaan Arduino IDE 2, ganti COM6 dengan port ESP32):
> ```
> "%LOCALAPPDATA%\Programs\Arduino IDE\resources\app\lib\backend\resources\arduino-cli.exe" compile --fqbn esp32:esp32:esp32 -u -p COM6 firmware\GBXMQTT
> ```

## Persiapan (sekali)

1. Di Arduino IDE, install board **ESP32** (Espressif).
2. Install library berikut:
   - **PubSubClient** (Nick O'Leary)
   - **ArduinoJson** (Benoit Blanchon), v6 atau v7
   - **Adafruit MAX31865**
3. Buka `firmware/GBXMQTT/GBXMQTT.ino`.
4. Pastikan `secrets.h` ada dan berisi SSID & password WiFi. Kalau belum ada, salin dari `secrets.example.h`.

## Setiap ESP32 / crane

Ubah **`config.h`** saja:

| Nilai | Contoh | Keterangan |
|---|---|---|
| `CRANE_ID` | `crane-02` | harus sama dengan ID di halaman **Pengaturan** dashboard, dan beda untuk tiap alat |
| `AREA` | `cbk` | bagian topik MQTT (huruf kecil) |
| `PLANT_NAME` | `CBK` | hanya informasi |
| `NODE_ID` | `1` | ESP ke berapa di crane ini. `1` = ESP utama (crane dengan 1 ESP32 cukup ini). Lihat **Lebih dari 1 ESP32 per crane** |
| `JUMLAH_SENSOR` | `5` | sensor yang terpasang di ESP32 ini (1..5, kanal CS 1..N) |
| `MOTOR_AWAL` | `1` | nomor motor sensor pertama: `MOTOR_AWAL 4` + 2 sensor = `m4`, `m5` |
| `MODE_KABEL_PT100` | `3` | jumlah kabel PT100 (2/3/4), harus cocok dengan jumper solder MAX31865. Tidak diisi = 3 |
| `MQTT_SERVER` | IP PC server | tempat Mosquitto + dashboard jalan |
| `MQTT_USER` / `MQTT_PASS` | kosong | isi hanya kalau login MQTT diaktifkan (`"mqttAuth": true`) |
| `NTP_SERVER_1` | `pool.ntp.org` | lihat bagian **Jam** di bawah |
| `HTTP_PORT` | `8080` | port dashboard, dipakai untuk unduh firmware OTA. Samakan kalau `PORT` di server.js pernah diubah |

Setelah upload, buka **Serial Monitor (921600**, sesuai `SERIAL_BAUD`). Yang harus muncul:
- `=== GBXMQTT v1.1.0 - crane-02 (CBK) ===`
- `[BOOT] Crane crane-02, ESP ke-1, 5 sensor: m1..m5`
- `[NTP] Waktu tersinkron`
- `[MQTT] ... BERHASIL!`
- `[Watchdog] Aktif, timeout 20 detik`
- `[KIRIM] {...}` setiap 5 detik

Di dashboard akan muncul **"Perangkat baru terdeteksi: crane-02"** → klik **Aktifkan**.

## Lebih dari 1 ESP32 per crane

Dipakai kalau motor-motor satu crane berjauhan (mis. motor hoist di trolley, motor long travel di ujung girder), sehingga kabel PT100 ke satu kotak ESP32 terlalu panjang atau harus lewat festoon.

**Cara kerjanya:** setiap ESP32 tersambung **sendiri** ke WiFi dan broker. Tidak ada kabel atau radio antar ESP32, jadi kalau satu ESP mati, ESP lain tetap mengirim data. Semua ESP memakai `CRANE_ID` yang sama dan dibedakan `NODE_ID`:

| | ESP utama | ESP tambahan |
|---|---|---|
| `config.h` | `NODE_ID 1`, `JUMLAH_SENSOR 3`, `MOTOR_AWAL 1` | `NODE_ID 2`, `JUMLAH_SENSOR 2`, `MOTOR_AWAL 4` |
| ID perangkat | `crane-01` | `crane-01_2` |
| Topik MQTT | `pabrik/ccc/crane-01/temp`, `.../status`, ... | `pabrik/ccc/crane-01_2/temp`, `.../status`, ... |
| Client ID / login MQTT | `ESP32-crane-01` / `crane-01` | `ESP32-crane-01_2` / `crane-01_2` |
| Motor yang dikirim | `m1, m2, m3` | `m4, m5` |
| Folder OTA | `firmware-ota/crane-01/` | `firmware-ota/crane-01_2/` |

Isi pesan suhu tetap `"crane_id":"crane-01"`. Server, logger, dan dashboard menggabungkan semuanya jadi satu crane `m1..m5` (CSV, grafik, laporan, dan Excel tidak berubah).

- **Nomor motor tidak boleh sama** antar ESP dalam satu crane. Kalau terjadi, dashboard dan Pengaturan menampilkan **"Key motor bentrok"**.
- **Pembagian motor dipelajari otomatis** dari data yang masuk. Kalau sebuah sensor dipindah ke ESP lain, cukup flash ulang kedua ESP; catatannya ikut pindah sendiri.
- **Last Will per ESP:** kalau ESP ke-2 mati, hanya motor milik ESP itu yang jadi *offline*. Motor di ESP utama tetap dipantau.
- **Status sistem** dan **Pengaturan** menampilkan satu baris per ESP (`crane-01` dan `crane-01_2`). Di kartu motor dashboard muncul label kecil **ESP 1 / ESP 2**.
- **OTA per ESP:** setiap ESP punya `.bin` sendiri (karena `NODE_ID`-nya beda). Di accordion crane di Pengaturan ada satu slot upload/Update per ESP.
- **Login MQTT** (kalau nanti diaktifkan): `npm run setup-mqtt -- --add crane-01_2`, lalu isi `MQTT_USER "crane-01_2"` dan password-nya di `config.h` ESP itu.
- **Uji tanpa hardware:** `node simulate_esp32.js --crane crane-30 --node 2 --motor-awal 4 --motor 2`

Crane dengan 1 ESP32 tidak perlu mengubah apa pun (`NODE_ID 1` = perilaku lama).

## LED indikator hardware per sensor

Selain LED daya (Input/ESP32) yang sudah ada di panel, tiap PT100 punya LED indikator sendiri yang dikendalikan ESP32 - **menyala = sensor itu terbaca normal, mati = fault** (kabel putus/short, dll - kode fault yang sama seperti yang dikirim ke dashboard). Dicek ulang tiap 5 detik, jadi otomatis nyala lagi begitu kabelnya dibetulkan, tanpa perlu reset ESP32.

| Gearbox | Pin LED | Wiring |
|---|---|---|
| GB01 | GPIO 26 | GPIO → resistor 330Ω → LED → GND |
| GB02 | GPIO 27 | GPIO → resistor 330Ω → LED → GND |
| GB03 | GPIO 32 | GPIO → resistor 330Ω → LED → GND |
| GB04 | GPIO 33 | GPIO → resistor 330Ω → LED → GND |
| GB05 | GPIO 14 | GPIO → resistor 330Ω → LED → GND |

Beda dengan LED "Input"/"ESP32" yang cuma menunjukkan ada listrik (nyambung langsung ke jalur 3.3V) - LED ini dikontrol logika (`digitalWrite`) berdasarkan pembacaan fault MAX31865 yang sebenarnya, jadi bisa menangkap masalah sensor (kabel putus) yang tidak kelihatan dari LED daya biasa.

## Kekuatan sinyal WiFi di Serial Monitor

Tiap 5 detik (`INTERVAL_SINYAL_MS`) firmware mencetak baris seperti:

```
[SINYAL] -62 dBm (76%) [#######---] CUKUP | AP: NamaWiFi ch6 AA:BB:CC:DD:EE:FF
```

RSSI >= -50 sangat bagus, -60 bagus, -70 cukup, -80 lemah, di bawah itu buruk (sering putus).
MAC access point berubah = ESP32 pindah (roaming) ke AP lain - berguna untuk cek cakupan.
Pakai ini saat survei: bawa ESP32 + laptop ke titik pasang crane dan pastikan minimal -70 dBm.

## Checklist commissioning (tiap crane)

Pastikan setiap kabel PT100 terhubung ke gearbox yang benar:

1. Panaskan satu sensor saja (genggam / heat gun jarak aman) selama ±1 menit.
2. Di dashboard, pastikan hanya kartu gearbox yang benar yang suhunya naik.
3. Ulangi untuk semua gearbox.
4. Kalau ada yang tertukar, perbaiki kabel ke pin CS yang benar (GB01=4, GB02=5, GB03=16, GB04=17, GB05=25), atau ubah nama gearbox di **Pengaturan**.
5. Cabut satu kabel PT100. Dashboard harus menampilkan **Sensor error — Fault MAX31865**, DAN LED indikator sensor itu di panel (GB01=26, GB02=27, GB03=32, GB04=33, GB05=14) harus ikut mati. Pasang lagi - LED harus nyala lagi tanpa perlu reset ESP32.
6. Matikan ESP32. Dalam beberapa detik, crane harus tampil **offline** (Last Will).

## Yang berubah dari versi 1

| Masalah di v1 | v2 |
|---|---|
| Identitas crane ditulis di 4 tempat (client_id, 2 topik, crane_id) | cukup `CRANE_ID` + `AREA` di `config.h` |
| Timestamp tanpa zona waktu; kalau NTP gagal jadi `1970-01-01` | `2026-09-20T10:00:05+07:00`; tidak dikirim kalau jam belum sinkron |
| Fault MAX31865 hanya dicetak ke Serial, nilai ngawur (±-242 °C) tetap terkirim | dikirim `null` + kode fault di `"faults"` |
| `setup_wifi()` menunggu selamanya kalau WiFi mati saat boot | batas 20 detik, lalu lanjut membaca sensor & menyimpan ke buffer |
| Buffer offline tanpa batas (flash bisa penuh dalam ±12 jam) | dibatasi ±600 KB; kalau penuh, data paling lama dibuang |
| Pengiriman ulang backlog memblokir pembacaan sensor selama bermenit-menit | dikirim sedikit demi sedikit (10 baris per putaran) |
| Tidak ada status online/offline | pesan `status` (retained) + **Last Will** → dashboard langsung tahu kalau ESP32 putus |
| Buffer MQTT bawaan 256 byte | 512 byte |
| Update firmware harus lewat kabel USB | **OTA lewat WiFi**: tombol "Update" di Pengaturan mengirim perintah `ota` ke ESP32, yang mengunduh & memasang firmware baru dari dashboard sendiri |
| `loop()` macet total (bukan cuma WiFi/MQTT putus) = alat diam selamanya sampai di-reset manual | **Watchdog hardware**: ESP32 reboot sendiri kalau `loop()` tidak merespons dalam 20 detik |

## Update firmware (OTA)

1. Publish firmware baru ke crane tertentu: lewat halaman **Pengaturan** (expand crane → drag-and-drop file `.bin`), atau `npm run publish-ota -- "path/GBXMQTT.ino.bin" crane-01 2.1.0 "Nama PIC"` (lihat [publish-ota.js](../../publish-ota.js)).
2. Klik **Update** di Pengaturan (atau "Update semua" untuk semua crane yang sudah punya firmware ter-upload). Server mengirim perintah `ota` ke topik `pabrik/<area>/<crane>/perintah`.
3. ESP32 mengunduh `GBXMQTT.bin` dari `http://<MQTT_SERVER>:<HTTP_PORT>/firmware-ota/<CRANE_ID>/GBXMQTT.bin`, memasangnya, lalu restart otomatis. Lihat Serial Monitor untuk log `[OTA] ...`.
4. Kalau gagal (WiFi putus, atau belum ada firmware ter-upload untuk crane itu), ESP32 tetap jalan dengan firmware lama - tinggal klik **Update** lagi nanti.

## Jam (NTP) di jaringan pabrik

Kalau jaringan pabrik tidak bisa ke internet, `pool.ntp.org` tidak bisa dihubungi. Jadikan **PC server sebagai NTP server** dengan menjalankan perintah ini di PowerShell **Run as administrator** di PC server:

```bash
w32tm /config /reliable:yes /update
```

```bash
reg add "HKLM\SYSTEM\CurrentControlSet\Services\W32Time\TimeProviders\NtpServer" /v Enabled /t REG_DWORD /d 1 /f
```

```bash
net stop w32time && net start w32time
```

Lalu isi `NTP_SERVER_1` dengan IP PC server, dan buka firewall **UDP 123** di PC server.

Tanpa jam yang sinkron, data live tetap terkirim (server memakai jam terima). Namun data yang tertahan saat offline **tidak disimpan**, karena jam kejadiannya tidak bisa dipastikan.
