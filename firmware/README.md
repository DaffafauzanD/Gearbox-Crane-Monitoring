# Firmware ESP32 — GBXMQTT v2

Satu firmware untuk semua crane. Yang dibedakan per alat hanya `config.h`.

> ⚠️ Firmware ini **belum pernah di-compile/diuji di hardware**, karena laptop pengembangan tidak punya Arduino IDE / core ESP32. Perilakunya sudah diuji lewat `simulate_esp32.js`, yang meniru format pesannya. Uji dulu di **satu** ESP32 sebelum dipasang ke crane lain. File `GBXMQTT.ino` versi lama tetap ada di folder utama project sebagai cadangan.

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
| `MQTT_SERVER` | IP PC server | tempat Mosquitto + dashboard jalan |
| `MQTT_USER` / `MQTT_PASS` | kosong | isi hanya kalau login MQTT diaktifkan (`"mqttAuth": true`) |
| `NTP_SERVER_1` | `pool.ntp.org` | lihat bagian **Jam** di bawah |

Setelah upload, buka **Serial Monitor (115200)**. Yang harus muncul:
- `=== GBXMQTT v2.0.0 - crane-02 (CBK) ===`
- `[NTP] Waktu tersinkron`
- `[MQTT] ... BERHASIL!`
- `[KIRIM] {...}` setiap 5 detik

Di dashboard akan muncul **"Perangkat baru terdeteksi: crane-02"** → klik **Aktifkan**.

## Checklist commissioning (tiap crane)

Pastikan setiap kabel PT100 terhubung ke gearbox yang benar:

1. Panaskan satu sensor saja (genggam / heat gun jarak aman) selama ±1 menit.
2. Di dashboard, pastikan hanya kartu gearbox yang benar yang suhunya naik.
3. Ulangi untuk semua gearbox.
4. Kalau ada yang tertukar, perbaiki kabel ke pin CS yang benar (GB01=4, GB02=5, GB03=16, GB04=17, GB05=25), atau ubah nama gearbox di **Pengaturan**.
5. Cabut satu kabel PT100. Dashboard harus menampilkan **Sensor error — Fault MAX31865**. Pasang lagi.
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
