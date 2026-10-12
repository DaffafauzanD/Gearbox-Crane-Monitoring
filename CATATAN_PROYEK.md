# Catatan proyek (untuk sesi/asisten berikutnya)

Monitoring suhu gearbox overhead crane (25 crane, ESP32 + 5 PT100 per crane) -> MQTT -> dashboard web. Node.js 24, Windows, tanpa framework.
Baca dulu `README.md`. Catatan ini merangkum keputusan & keadaan terakhir.

## Cara pakai
- Jalankan: pintasan Desktop **Monitoring Gearbox** (=`Monitoring Gearbox.bat` -> `scripts/app.js`). Menyalakan broker+logger+web tanpa CMD, membuka dashboard sebagai jendela aplikasi Chrome; **menutup jendela = semuanya mati**. Kalau sudah jalan di latar belakang (`npm run service`/autostart), hanya membuka jendela.
- Tes regresi: `npm test` (salinan sementara + database baru, data asli tidak tersentuh, ~2 detik, harus 48/48). Jalankan setiap selesai mengubah kode server.
- Setelah mengubah `server.js`/`mqtt_logger.js`/`auth.js`: aplikasi harus di-**restart** (tutup jendela, klik pintasan). File tampilan (html/js/css) langsung berlaku dengan F5.

## Peran akun
- `maintenance`: semua fitur dasar; boleh menyetujui/menolak pengajuan akun dan menghapus akun hasil pengajuan.
- Hapus riwayat perubahan: maintenance (dicek di server, `isStaff()` di `server.js`).
- `viewer` (hasil pengajuan dari halaman login): HANYA melihat dashboard + indikator. Dibatasi di SERVER (`VIEWER_GET` di `server.js`), bukan cuma disembunyikan (`.no-viewer`).

## Keputusan penting
- Excel log crane dibuat SAAT DIKLIK (`GET /api/excel/<crane>`) di worker thread (`excel_worker.js`), dari SQLite `stats_minute`; cache 5 menit, antrian 1 per satu. Logger tidak lagi membuat Excel.
- CSV harian > 8 hari dikompres `.csv.gz` (`csv_archive.js`); `npm run db-import` membaca keduanya.
- Riwayat chart (`state.json` -> history) = 1 titik/menit, disusun ulang dari ekor CSV saat logger mulai (`history_seed.js`, urut menurut WAKTU kejadian karena ada backlog ESP32).
- Fungsi bersama di `common.js` (`isProcessAlive`, konstanta WIB). Berkas usang dipindah ke `config/legacy/`.

## Preferensi pemilik (jangan dibalikkan)
- Teks pesan di login (`SIGNUP_OK_TEXT` di `login.js`), placeholder username, dan judul halaman sengaja gaya santai/diubah sendiri.
- Penghapusan riwayat perubahan (maintenance): SENGAJA tanpa baris log. Jangan menambah jejak baru untuk tindakan ini.
- Dashboard rata tengah (judul + strip plant/jam/pill); kartu menu sejajar per kolom.

## Terminologi: Gearbox -> Motor (1 Okt 2026)
Sensor sekarang dipasang langsung di motor (bukan gearbox). Key diganti `gb01..gb05` -> `m1..m5` di
SEMUA tempat: `config/settings.json` (95 entri, 19 crane; nama default "GB 0N - ..." -> "Motor N - ...";
dicadangkan ke scratchpad sebelum migrasi), validasi (`settings.js`, `server.js` - regex digeneralisasi
`/^[a-z]{1,8}\d{1,3}$/` supaya key format LAMA "gb01" tetap diterima untuk kompatibilitas data arsip),
regex nama arsip CSV (`history_seed.js`, `csv_archive.js`, `scripts/import-to-db.js`), simulator
(`simulate_esp32.js`, kirim `m1..m5`), firmware (`firmware/GBXMQTT/GBXMQTT.ino`, BELUM ada ESP32
lapangan terpasang jadi aman - firmware fisik yang sudah di-flash harus di-reflash sebelum dipasang),
teks UI (index/laporan/status/pengaturan .html+.js). Sudah diuji ujung-ke-ujung lewat simulator asli
(crane-30) sampai CSV & state.json. CSV/DB lama bertanda "gb0N" (crane-01..04, data simulasi/uji, bukan
data lapangan nyata) tetap aman di arsip, cuma tidak lagi cocok dengan settings - itu memang konsekuensi
yang disengaja dari penggantian key, bukan bug.
Bug yang ikut diperbaiki: `addGearbox()` di `pengaturan.js` dulu pakai `key.slice(2)` (asumsi prefix 2
huruf "gb") untuk menghitung nomor motor berikutnya - salah untuk prefix 1 huruf "m". Sekarang pakai
`key.replace(/\D/g, '')`.
PENTING: ada proses `npm run simulate` yang jalan lama (independen dari run-all.js, TIDAK ikut mati
kalau cuma stop-service) - kalau ketemu lagi nanti dan datanya aneh (key lama muncul lagi), itu proses
lama yang masih memuat kode SEBELUM perubahan di memorinya; matikan & jalankan ulang.

## Beberapa ESP32 per crane (11 Okt 2026)
Satu crane boleh dipasangi >1 ESP32. Desain: tiap ESP32 punya **ID perangkat** sendiri yang dipakai
di segmen ke-3 topik MQTT, Client ID, login MQTT, folder OTA: ESP utama = ID crane apa adanya
(`crane-30`), ESP tambahan = `<crane>_<node>` (`crane-30_2`, node 2..99). ID crane tidak boleh
mengandung `_`, jadi tidak ambigu. Helper bersama: `AlarmRules.parseDeviceId` / `deviceIdOf`
(`alarm_rules.js`, dipakai server, logger, browser). Payload tetap `"crane_id":"crane-30"` -> data
digabung per crane+motor (CSV/state/DB/Excel tidak berubah).
- `devices.js`: SATU BARIS PER ESP32 (kolom DB `crane_id` = ID perangkat). `d.id`, `d.craneId`,
  `d.node`, `d.gbKeys` = motor milik ESP itu (dipelajari dari data; sensor pindah -> ikut pindah;
  key sama dari 2 ESP dalam 2 menit -> `d.conflicts`, tampil "Key motor bentrok").
- Last Will satu ESP -> `engine.deviceOffline(crane, now, gbKeysOfDevice(d))` hanya motor ESP itu.
- API perangkat/OTA/Serial Monitor: field `craneId` di body = ID PERANGKAT (nama dipertahankan).
  OTA per ESP (`firmware-ota/crane-30_2/`), Pengaturan punya slot OTA per ESP (state di-key ID perangkat).
- Firmware: `config.h` -> `NODE_ID`, `JUMLAH_SENSOR` (1..5), `MOTOR_AWAL`. Simulator: `--node`, `--motor-awal`.
- Tes: `tests/multinode.js` (tanpa broker) dijalankan dulu oleh `npm test`.
- Uji nyata 11 Okt: ESP32 fisik di COM6 (CH340, MAC B0:3F:D3:5B:B8:E0) di-flash sebagai `crane-30`
  NODE 1, 3 sensor (m1..m3, BELUM ada PT100 -> fault 0xFE, wajar), WiFi MARET, broker 192.168.1.6
  (laptop di SSID JUNI, satu router). ESP ke-2 = simulator `crane-30_2` (m4..m5). Terbukti:
  data tergabung, m4/m5 otomatis pindah kepemilikan, Last Will ESP 2 hanya membuat m4/m5 offline.
  Lalu simulator dimatikan dan diganti ESP32 FISIK ke-2 (MAC 20:50:0D:D4:E3:C0, IP .218, sebelumnya
  berfirmware crane-33/WiFi Barcode): di-flash crane-30 NODE 2, 2 sensor m4..m5. Kedua ESP fisik
  tersambung bersamaan. config.h di repo SEKARANG berisi konfigurasi ESP 2 (NODE_ID 2) - kembalikan
  ke NODE_ID 1 / JUMLAH_SENSOR 3 / MOTOR_AWAL 1 sebelum flash ulang ESP utama.
  Backlog lama crane-33 di flash ESP 2 ditolak server/logger (crane_id tidak cocok topik) - benar.
- Ditemukan & dibetulkan saat itu: `service-config.json` mosquittoDir salah (harus
  `C:\Program Files\mosquitto\mosquitto`); `logger.lock` basi menunjuk PID yang dipakai ulang proses
  lain (logger menolak jalan) - hapus `logger.lock` kalau tidak ada mqtt_logger.js yang jalan.
- Compile/flash dari CLI: arduino-cli bawaan Arduino IDE 2 (lihat firmware/README.md).

## Belum dikerjakan (urutan saran)
0. Project SUDAH dipindah ke `D:\Gearbox-Crane-Monitoring-main` (keluar dari OneDrive) - pintasan Desktop juga sudah diperbarui ("Monitoring Overhead Crane"). Teknik "Edit gagal .tmp ENOENT" di bagian paling bawah catatan ini sudah TIDAK relevan lagi sejak pindah dari OneDrive (sempat dicoba lagi di sesi ini dan Edit normal berhasil) - coba Edit biasa dulu, baru pakai skrip PowerShell kalau memang gagal.
1. Ganti password `maintenance`, siapkan backup berkala `data/*.db`.
2. Aktifkan login MQTT (`npm run setup-mqtt`, `mqttAuth: true`) sebelum dipakai di WiFi bersama; isi `secrets.h`; samakan `MQTT_SERVER`/`AREA`/`CRANE_ID` di `firmware/GBXMQTT/config.h`; NTP lokal.
3. Bench test 1 ESP32 + 5 sensor, pilot 1-2 minggu. SEBELUM itu: hentikan simulator (`npm run simulate`) dan bersihkan data simulasi (logs/, data/monitoring.db, alarms/, state.json) dengan cadangan dulu.
4. Alarm baru berbunyi di browser (belum ada andon/WhatsApp/email). Watchdog firmware belum ada.
5. Opsional: pecah `server.js` (1000+ baris) dan `JS_Monitoring.js` (1500+ baris) per fitur; `npm test` jadi jaring pengamannya.

## Catatan teknis untuk mengedit
- Folder ada di OneDrive: alat Edit kadang gagal menulis (`.tmp` ENOENT). Cadangan: skrip PowerShell dengan pencocokan teks persis (semua-atau-tidak-sama-sekali).
- PowerShell 5.1: skrip berisi karakter non-ASCII harus disimpan dengan BOM; jangan kirim kode JS berisi tanda kutip ganda lewat `node -e` (kutipnya hilang).
- Setiap tes yang menyalakan server memakai salinan di folder sementara; lepas junction `node_modules`/`vendor` sebelum menghapus salinan.
