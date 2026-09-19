# Monitoring Suhu Gearbox Overhead Crane — Karawang Plant

Dashboard real-time suhu gearbox untuk 25 overhead crane.

```
ESP32 (per crane) ──MQTT 1883──► Mosquitto ──┬──► mqtt_logger.js ──► logs/*.csv, state.json, excel/*.xlsx, data/monitoring.db
                                             ├──► server.js (alarm, laporan) ──► alarms/, data/monitoring.db ──SSE/API──┐
                                             └──WebSocket 9001──────────────────────────────────────────────────────────┴──► browser (index.html, laporan.html :8080)
```

## Menjalankan

Sekali saja, di PC server:

```bash
npm install
npm run vendor
```

- `npm install`: pasang library (butuh internet).
- `npm run vendor`: salin library dashboard ke `vendor/` supaya dashboard bisa dibuka tanpa internet.
- `npm run setup-mqtt`: opsional, hanya untuk mode login MQTT (lihat bagian Login MQTT).

Isi `"mosquittoDir"` di `service-config.json` dengan folder tempat `mosquitto.exe`. Saat ini isinya `C:\Program Files\mosquitto\mosquitto`.

Menjalankan semuanya (broker, logger, dan web server) dengan satu perintah:

```bash
npm run service
```

Lalu buka **http://localhost:8080**. Dari PC lain, buka `http://<ip-pc-server>:8080`. Semua output tersimpan di `service-logs/`.

Untuk tes tanpa ESP32, jalankan ini di jendela lain:

```bash
npm run simulate
```

Opsinya: `--error gb04` meniru sensor error, `--mati gb05` meniru sensor mati, `--crane crane-02 --area cbk` memilih crane lain.

### Jalan otomatis saat PC menyala

Jalankan dari PowerShell **Run as administrator**:

```bash
powershell -ExecutionPolicy Bypass -File scripts\install-autostart.ps1
```

Untuk menghapusnya lagi, pakai `scripts\uninstall-autostart.ps1`.

## Tren & laporan

Buka lewat tombol **Laporan** di header dashboard (`laporan.html`). Pilih periode 24 jam, 7 hari, 30 hari, 90 hari, atau rentang tanggal sendiri. Setiap tab bisa di-download sebagai Excel.

| Tab | Isi |
|---|---|
| Tren suhu | grafik tiap gearbox untuk satu crane: rentang min–maks, rata-rata, dan garis batas warning/danger |
| Laporan periode | semua gearbox: min / rata-rata / maks, menit di atas batas, jumlah & durasi alarm, sampel error, % data tersedia. Juga menampilkan gearbox terpasang yang **tidak mengirim data** sama sekali |
| Kejadian alarm | tiap alarm: mulai, selesai, durasi, nilai puncak, siapa yang meng-ack |

**Penyimpanan data** (`data/monitoring.db`, SQLite bawaan Node, tanpa instalasi):
- Ringkasan **per menit** disimpan 90 hari. Ringkasan **per jam** disimpan selamanya.
- Data mentah tiap 5 detik tetap diarsipkan di `logs/*.csv`.
- Semua kejadian alarm juga tersimpan di database.

**Pertama kali (atau kalau database rusak/terhapus)**, bangun database dari CSV & riwayat alarm yang sudah ada. Matikan `npm run service` dulu, lalu jalankan:

```bash
npm run db-import
```

## Pengaturan & crane baru

Buka lewat tombol **Pengaturan** di header dashboard (`pengaturan.html`). Semua pengaturan disimpan di `config/settings.json`, dan versi sebelumnya otomatis disimpan sebagai `settings.json.bak`.

- **Nama crane / lokasi / nama gearbox / kode sparepart**: ubah langsung di form, lalu **Simpan**. Semua dashboard yang terbuka ikut berubah tanpa perlu dimuat ulang.
- **Batas suhu**: bisa default (semua gearbox), per crane, atau per gearbox. Kolom yang dikosongkan mengikuti batas di atasnya.

  | Suhu | Status |
  |---|---|
  | di bawah **Min** | 🔵 Suhu rendah: kemungkinan sensor lepas / terlalu dingin (alarm) |
  | Min – **batas atas normal** | 🟢 Normal: gearbox bekerja dengan baik |
  | di atas batas atas normal | 🟡 Warning: mendekati Max |
  | di atas **Max** | 🔴 Danger |

- **Crane baru**: pasang ESP32 dengan firmware v2 (lihat [firmware/README.md](firmware/README.md)) dan `CRANE_ID` yang sesuai. Begitu ESP32 mengirim data, dashboard menampilkan **"Perangkat baru terdeteksi"**. Klik **Aktifkan** dan crane itu langsung tampil serta dipantau alarm. Kalau ID-nya belum ada di daftar, crane otomatis ditambahkan dengan nama sementara yang bisa diganti di Pengaturan.
- Perangkat yang belum diaktifkan **tidak memicu alarm**, walaupun datanya sudah tercatat di log.
- **Riwayat perubahan**: setiap simpan tercatat (siapa, kapan, apa yang berubah).
- Belum ada login: siapa pun yang bisa membuka dashboard bisa mengubah pengaturan. Kalau dua orang menyimpan bersamaan, yang kedua ditolak dan diminta memuat ulang.

## Alarm

Alarm dinilai oleh **server.js**, jadi tetap tercatat walau tidak ada dashboard yang terbuka. Status ack juga sama di semua layar.

| Alarm | Kapan |
|---|---|
| Suhu tinggi | suhu > batas atas normal (warning) / Max (danger). Kalau naik dari warning ke danger, alarm muncul lagi walau sudah di-ack |
| Suhu rendah | suhu < Min (kemungkinan sensor lepas / terlalu dingin) |
| Kenaikan cepat | suhu naik ≥ `riseDegrees` °C dalam `riseMinutes` menit |
| Sensor error | nilai sensor tidak masuk akal, atau MAX31865 melaporkan fault (kodenya ditampilkan) |
| Sensor offline | tidak ada data selama `offlineMinutes` menit, **atau langsung** saat ESP32 firmware v2 putus (Last Will) |

- **Batas diatur di halaman Pengaturan.** Perubahan langsung berlaku tanpa restart. Pengaturan yang tidak masuk akal (misalnya Max di bawah batas atas normal) ditolak dengan pesan yang jelas.
- **Di dashboard**, alarm yang belum di-ack tampil sebagai banner di atas layar (juga di mode Overview/TV), bunyi berulang tiap 5 detik, dan kartu gearbox-nya berkedip. Ack butuh nama operator, yang tercatat di riwayat.
- **Bunyi**: browser baru mengizinkan suara setelah halaman diklik sekali. Untuk TV yang tidak pernah diklik, jalankan Chrome dengan `--autoplay-policy=no-user-gesture-required`.
- **Notifikasi desktop** (pop-up Windows) hanya bisa kalau dashboard dibuka lewat `http://localhost:8080` di PC server, atau lewat HTTPS. Aktifkan dari panel Alarm. Dari PC lain lewat `http://<ip>:8080`, alarm tetap muncul sebagai banner dan bunyi.
- **Riwayat** tersimpan di `alarms/history.jsonl`, dan alarm aktif di `alarms/active.json`.

## Login MQTT (tersedia, BELUM dipakai)

Saat ini broker **terbuka tanpa login** (`"mqttAuth": false` di `service-config.json`, memakai `mosquitto.conf`), supaya ESP32 dengan firmware lama tetap bisa masuk.

Untuk mengaktifkan login:
1. Jalankan `npm run setup-mqtt`.
2. Update firmware **semua** ESP32 supaya login (lihat contoh di bawah).
3. Ubah `"mqttAuth": true` di `service-config.json`, lalu restart `npm run service`. Broker akan memakai `mosquitto.secure.conf`, dan ESP32 yang belum login akan ditolak.

| User | Dipakai oleh | Hak akses (`mqtt/acl`) |
|---|---|---|
| `logger` | mqtt_logger.js | baca semua suhu |
| `web` | server.js (alarm) | baca semua suhu |
| `dashboard` | browser | **baca saja**, karena password-nya terlihat di browser |
| `crane-01` … `crane-25` | ESP32 masing-masing | hanya kirim ke topik crane itu sendiri |

Password ada di `mqtt/credentials.json`. File ini **rahasia**: jangan dibagikan dan jangan di-commit.

Contoh di firmware ESP32 (PubSubClient):

```cpp
client.connect(clientId, "crane-01", "<password crane-01 dari credentials.json>");
```

- Ganti password satu user (misalnya ESP32 hilang): `npm run setup-mqtt -- --reset crane-01`, lalu restart layanan.
- Crane baru: tambahkan dulu di Pengaturan (atau aktifkan dari "Perangkat terdeteksi"), lalu jalankan `npm run setup-mqtt` supaya akunnya dibuat.

## Status di dashboard

| Status | Arti |
|---|---|
| Suhu rendah / Normal / Warning / Danger | data live, dinilai dengan batas gearbox itu (default Min 15, normal ≤ 70, Max 80 °C). Batasnya tampil di tiap kartu gearbox |
| Sensor error | data masuk, tapi nilainya bukan suhu yang masuk akal (misalnya -127) |
| Offline | sensor terpasang, tapi tidak ada data selama lebih dari 2 menit |
| Belum terpasang | crane belum diaktifkan (centang "Terpasang" di Pengaturan, atau klik Aktifkan saat perangkatnya terdeteksi) |

## Perintah lain

| Perintah | Fungsi |
|---|---|
| `npm start` | logger saja |
| `npm run web` | web server saja |
| `npm run export-excel` | buat ulang semua file Excel sekarang |
| `npm run db-import` | bangun ulang database laporan dari `logs/*.csv` & riwayat alarm (service harus mati) |
