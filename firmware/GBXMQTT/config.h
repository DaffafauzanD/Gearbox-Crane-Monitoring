// ============================================================
// KONFIGURASI PER ALAT - cuma file ini yang diubah untuk tiap crane
// ============================================================
#pragma once

// ---- Identitas crane ----
// CRANE_ID harus sama dengan ID crane di halaman Pengaturan dashboard. Beda untuk tiap crane;
// ESP32 kedua dst. di crane yang SAMA memakai CRANE_ID yang sama + NODE_ID lain (lihat bawah).
// Topik MQTT otomatis jadi: pabrik/<AREA>/<ID perangkat>/temp dan .../status
#define CRANE_ID    "crane-30"
#define AREA        "ccc"      // huruf kecil: twb, cbk, cck, tkg, ...
#define PLANT_NAME  "CCC"

// ---- Lebih dari 1 ESP32 di crane yang sama (OPSIONAL) ----
// Crane yang motornya berjauhan (mis. motor hoist di trolley, motor long travel di girder)
// boleh dipasangi beberapa ESP32. Semuanya memakai CRANE_ID yang SAMA, dibedakan NODE_ID:
//   NODE_ID 1  -> ESP utama.     ID perangkat = "crane-01"   (topik pabrik/<AREA>/crane-01/...)
//   NODE_ID 2  -> ESP tambahan.  ID perangkat = "crane-01_2" (topik pabrik/<AREA>/crane-01_2/...)
//   NODE_ID 3.. -> dst (maks 99)
// ID perangkat itu juga jadi Client ID MQTT, username login MQTT, dan folder OTA-nya, jadi
// tiap ESP32 di-update firmware-nya sendiri-sendiri dari halaman Pengaturan.
// Crane dengan 1 ESP32 cukup biarkan NODE_ID 1 (sama persis seperti sebelumnya).
#define NODE_ID       1

// Sensor yang benar-benar terpasang di ESP32 INI (1..5, memakai pin CS sensor 1..N).
// MOTOR_AWAL = nomor motor sensor pertama. Nomor motor antar ESP32 dalam satu crane
// TIDAK BOLEH sama, contoh crane dengan 5 motor dibagi 2 ESP32:
//   ESP utama   : NODE_ID 1, JUMLAH_SENSOR 3, MOTOR_AWAL 1  -> kirim m1, m2, m3
//   ESP tambahan: NODE_ID 2, JUMLAH_SENSOR 2, MOTOR_AWAL 4  -> kirim m4, m5
// Dashboard menggabungkan semuanya jadi satu crane (m1..m5) secara otomatis.
#define JUMLAH_SENSOR 2
#define MOTOR_AWAL    1

// Jumlah kabel PT100 yang terpasang: 2, 3, atau 4 (berlaku untuk semua sensor di ESP32 ini).
// Harus cocok dengan jumper solder di modul MAX31865 (lihat README). Tidak diisi = 3.
#define MODE_KABEL_PT100 3

// ---- Broker MQTT (PC server tempat Mosquitto + dashboard) ----
#define MQTT_SERVER "192.168.1.13"
#define MQTT_PORT   1883

// ---- Update firmware (OTA) ----
// Dashboard jalan di PC yang SAMA dengan broker (lihat MQTT_SERVER di atas).
// Firmware baru diunduh dari http://MQTT_SERVER:HTTP_PORT/firmware-ota/<ID perangkat>/GBXMQTT.bin
// (dipicu dari halaman Pengaturan -> tombol "Update"). Samakan HTTP_PORT dengan
// "PORT" di server.js kalau pernah diubah dari bawaan 8080.
#define HTTP_PORT 8080

// Login MQTT. Biarkan kosong selama "mqttAuth": false di service-config.json.
// Kalau login diaktifkan: MQTT_USER = ID perangkat ("crane-01", atau "crane-01_2" untuk
// NODE_ID 2), MQTT_PASS dari mqtt/credentials.json dengan nama yang sama.
#define MQTT_USER   ""
#define MQTT_PASS   ""

// ---- Sinkronisasi jam (NTP) ----
// Jaringan pabrik sering TIDAK bisa ke internet. Kalau begitu, isi NTP_SERVER_1
// dengan IP PC server dan aktifkan Windows Time sebagai NTP server (lihat README).
// Tanpa jam yang tersinkron, data tetap terkirim (server pakai jam terima), tapi
// data yang tertahan saat offline tidak bisa disimpan dengan jam yang benar.
#define NTP_SERVER_1 "pool.ntp.org"
#define NTP_SERVER_2 "time.google.com"

// ---- Daftar awal access point (OPSIONAL, dari tim IT) ----
// MAC (BSSID) + channel tiap access point ber-SSID sama. ESP32 juga mempelajarinya sendiri dan menyimpannya di
// flash, jadi ini hanya mempercepat saat pertama kali dipasang. Contoh (hapus tanda // untuk memakai):
// #define AP_SEED "0A:8D:DB:D9:25:07,11;32:56:FE:C8:19:05,1"
