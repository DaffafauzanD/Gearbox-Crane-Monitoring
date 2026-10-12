// ============================================================
// GBXMQTT v2 - ESP32 + 5x PT100 (MAX31865) -> MQTT
// Monitoring Suhu Gearbox Overhead Crane - Karawang Plant
// ============================================================
// Yang diubah untuk tiap alat HANYA config.h (identitas crane & broker) dan
// secrets.h (WiFi). File ini sama untuk semua crane.
//
// Pesan yang dikirim (<ID> = ID perangkat: CRANE_ID untuk NODE_ID 1, "CRANE_ID_<NODE_ID>"
// untuk ESP tambahan di crane yang sama - lihat config.h):
//   pabrik/<AREA>/<ID>/temp    tiap 5 detik
//     {"crane_id":"crane-01","plant":"TWB","timestamp":"2026-09-20T10:00:05+07:00",
//      "temps":{"m1":55.2,...,"m4":null},"faults":{"m4":"0x80"}}
//     - timestamp pakai zona waktu (+07:00); TIDAK dikirim kalau jam belum tersinkron
//       (server lalu memakai jam terima)
//     - suhu null + kode di "faults" kalau MAX31865 melaporkan fault (mis. PT100 putus)
//     - crane_id SELALU CRANE_ID (bukan ID perangkat): server menggabungkan data semua ESP32 crane itu
//   pabrik/<AREA>/<ID>/status  saat tersambung & tiap 60 detik (retained)
//     {"online":true,"fw":"1.1.0","ip":"...","mac":"...","rssi":-60,...}
//     Last Will: broker otomatis mengirim {"online":false} kalau ESP32 putus mendadak,
//     jadi dashboard langsung tahu tanpa menunggu 2 menit.
//
// Library: PubSubClient, ArduinoJson (v6 atau v7), Adafruit MAX31865.
// Board: ESP32 (LittleFS sudah termasuk di core ESP32).
//
// Ketahanan loop() (lihat komentar "LAPISAN" di setup()/loop()):
//   1. WiFi   - reconnect otomatis kalau putus
//   2. MQTT   - reconnect otomatis kalau broker putus
//   3. Watchdog hardware - kalau loop() sendiri MACET TOTAL (bukan cuma WiFi/MQTT
//      putus), ESP32 reboot sendiri setelah WDT_TIMEOUT_SEC detik tanpa respons

#include <WiFi.h>
#include <PubSubClient.h>
#include <ArduinoJson.h>
#include <Adafruit_MAX31865.h>
#include <LittleFS.h>
#include <Preferences.h>   // NVS: daftar access point yang pernah dikenal disimpan di flash
#include <esp_system.h>    // esp_reset_reason(): penyebab restart terakhir
#include <time.h>
#include <HTTPClient.h>
#include <HTTPUpdate.h>
#include <esp_task_wdt.h>

#include "config.h"
#include "secrets.h"   // salin dari secrets.example.h kalau belum ada

// config.h lama memakai nama OTA_HTTP_PORT; yang baru HTTP_PORT. Dua-duanya diterima.
#ifndef HTTP_PORT
  #ifdef OTA_HTTP_PORT
    #define HTTP_PORT OTA_HTTP_PORT
  #else
    #define HTTP_PORT 8080
  #endif
#endif

#define FW_VERSION "1.1.0"

// Kecepatan Serial (RX/TX ke USB). Serial Monitor di Arduino IDE HARUS disetel sama (pojok kanan
// bawah jendela Serial Monitor). Kalau teks jadi acak-acakan, kabel/chip USB tidak kuat -> turunkan
// ke 460800 atau kembali ke 115200. Teks bootloader ESP32 (sebelum "=== GBXMQTT") selalu 115200,
// jadi di baud lain bagian itu tampil acak - itu normal.
#define SERIAL_BAUD 921600

// Penanda versi yang ikut tertanam di file .bin: halaman Pengaturan membaca "GBXFWVER=x.y.z" dari
// .bin yang di-upload, jadi nomor versi di dashboard otomatis sama dengan FW_VERSION ini.
// Jangan diubah/dihapus. Dipakai juga di banner boot (setup) supaya tidak dibuang kompiler.
const char FW_TAG[] = "GBXFWVER=" FW_VERSION;

// ============================================================
// 1. PIN & MAX31865 (SOFTWARE SPI, 5 SENSOR)
// ============================================================
#define RREF      431.0
#define RNOMINAL  100.0

#define PIN_SDI   23  // MOSI (bareng)
#define PIN_SDO   19  // MISO (bareng)
#define PIN_CLK   18  // SCK  (bareng)

#define PIN_CS_GB01  4
#define PIN_CS_GB02  5
#define PIN_CS_GB03  16
#define PIN_CS_GB04  17
#define PIN_CS_GB05  25

// LED indikator HARDWARE per sensor - beda dengan LED "IN 5V"/"ESP32" yang cuma
// menunjukkan ada listrik. LED ini dikendalikan dari status FAULT MAX31865 (lihat
// bacaSemuaSensor()): menyala = sensor itu terbaca normal, mati = fault (kabel
// PT100 putus/short, dst) - jadi teknisi bisa langsung lihat sensor mana yang
// bermasalah tanpa buka dashboard.
#define PIN_LED_GB01  26
#define PIN_LED_GB02  27
#define PIN_LED_GB03  32
#define PIN_LED_GB04  33
#define PIN_LED_GB05  14

// Papan ini punya 5 kanal sensor. Berapa yang dipakai & nomor motornya diatur di config.h
// (JUMLAH_SENSOR, MOTOR_AWAL) - config.h lama tanpa pengaturan itu = 5 sensor m1..m5.
#define MAKS_SENSOR 5
#ifndef NODE_ID
  #define NODE_ID 1
#endif
#ifndef JUMLAH_SENSOR
  #define JUMLAH_SENSOR 5
#endif
#ifndef MOTOR_AWAL
  #define MOTOR_AWAL 1
#endif
#if JUMLAH_SENSOR < 1 || JUMLAH_SENSOR > MAKS_SENSOR
  #error "JUMLAH_SENSOR di config.h harus 1..5"
#endif
#if NODE_ID < 1 || NODE_ID > 99
  #error "NODE_ID di config.h harus 1..99"
#endif
#if MOTOR_AWAL < 1 || MOTOR_AWAL + JUMLAH_SENSOR - 1 > 999
  #error "MOTOR_AWAL di config.h tidak valid"
#endif
#ifndef MODE_KABEL_PT100
  #define MODE_KABEL_PT100 3
#endif
#if MODE_KABEL_PT100 == 2
  #define MODE_MAX31865 MAX31865_2WIRE
#elif MODE_KABEL_PT100 == 3
  #define MODE_MAX31865 MAX31865_3WIRE
#elif MODE_KABEL_PT100 == 4
  #define MODE_MAX31865 MAX31865_4WIRE
#else
  #error "MODE_KABEL_PT100 di config.h harus 2, 3, atau 4"
#endif

const int ledFaultPins[MAKS_SENSOR] = { PIN_LED_GB01, PIN_LED_GB02, PIN_LED_GB03, PIN_LED_GB04, PIN_LED_GB05 };

Adafruit_MAX31865 sensorGB01(PIN_CS_GB01, PIN_SDI, PIN_SDO, PIN_CLK);
Adafruit_MAX31865 sensorGB02(PIN_CS_GB02, PIN_SDI, PIN_SDO, PIN_CLK);
Adafruit_MAX31865 sensorGB03(PIN_CS_GB03, PIN_SDI, PIN_SDO, PIN_CLK);
Adafruit_MAX31865 sensorGB04(PIN_CS_GB04, PIN_SDI, PIN_SDO, PIN_CLK);
Adafruit_MAX31865 sensorGB05(PIN_CS_GB05, PIN_SDI, PIN_SDO, PIN_CLK);

Adafruit_MAX31865* sensors[MAKS_SENSOR] = { &sensorGB01, &sensorGB02, &sensorGB03, &sensorGB04, &sensorGB05 };
char    gbKeys[JUMLAH_SENSOR][8];   // "m1", "m2", ... diisi di setup() dari MOTOR_AWAL
float   suhu[JUMLAH_SENSOR];
uint8_t faultCode[JUMLAH_SENSOR];   // 0 = normal

// ============================================================
// 2. TOPIK & WAKTU (dibentuk otomatis dari config.h)
// ============================================================
// ID perangkat: ESP utama = CRANE_ID apa adanya, ESP tambahan = CRANE_ID + "_" + NODE_ID.
// Dipakai di topik, Client ID, login MQTT, dan URL OTA - jadi 2 ESP32 di crane yang sama
// tidak saling menendang di broker dan tidak saling menimpa status/Last Will.
const String DEVICE_ID      = NODE_ID == 1 ? String(CRANE_ID) : String(CRANE_ID) + "_" + String(NODE_ID);
const String TOPIC_TEMP     = String("pabrik/") + AREA + "/" + DEVICE_ID + "/temp";
const String TOPIC_STATUS   = String("pabrik/") + AREA + "/" + DEVICE_ID + "/status";
const String TOPIC_PERINTAH = String("pabrik/") + AREA + "/" + DEVICE_ID + "/perintah";
const String TOPIC_LOG      = String("pabrik/") + AREA + "/" + DEVICE_ID + "/log";   // Serial Monitor jarak jauh
const String CLIENT_ID      = String("ESP32-") + DEVICE_ID;   // wajib unik per alat

const long GMT_OFFSET_SEC = 7 * 3600;       // WIB = UTC+7
const time_t JAM_VALID_SETELAH = 1700000000; // < Nov 2023 berarti jam belum tersinkron

const unsigned long INTERVAL_BACA_MS   = 5000;
const unsigned long INTERVAL_STATUS_MS = 5000;   // sama dengan pembacaan sensor, supaya sinyal (RSSI) di dashboard ikut real-time
const unsigned long INTERVAL_RETRY_MS  = 5000;
const unsigned long INTERVAL_WIFI_RETRY_MS = 15000;  // beri WiFi.begin() waktu cukup untuk selesai menyambung sebelum dicoba ulang
// Pengaman terakhir: WiFi tampak tersambung tapi broker tidak terjangkau terus-menerus (tumpukan WiFi macet)
const unsigned long MQTT_MATI_RESET_WIFI_MS = 5UL * 60 * 1000;    // 5 menit -> putuskan WiFi & pilih ulang AP
const unsigned long MQTT_MATI_RESTART_MS    = 20UL * 60 * 1000;   // 20 menit -> restart ESP32 (backlog di flash aman)
unsigned long mqttTerakhirOk = 0;
const unsigned long INTERVAL_SINYAL_MS = 5000;   // cetak kekuatan sinyal WiFi ke Serial Monitor
unsigned long lastSinyal = 0;
const unsigned long WIFI_BOOT_TIMEOUT_MS = 20000;
// Watchdog = penjaga terakhir kalau program BENAR-BENAR macet (library hang, WiFi stack mati) - alat tanpa
// operator bisa reboot sendiri. BUKAN untuk jaringan yang lambat: panggilan jaringan (sambung MQTT, kirim
// data) boleh menunggu beberapa detik saat jaringan tersendat. Karena itu batasnya 45 detik, dan watchdog
// di-reset (esp_task_wdt_reset) di sela setiap panggilan jaringan yang bisa menunggu, supaya jaringan lambat
// tidak lagi memicu reboot. Batas tunggu tiap panggilan juga dipendekkan (lihat setSocketTimeout di setup).
const uint32_t WDT_TIMEOUT_SEC = 45;

// ============================================================
// 3. BUFFER OFFLINE (LittleFS)
// ============================================================
// Data yang terbaca saat WiFi/broker mati disimpan di flash lalu dikirim ulang
// sedikit demi sedikit setelah tersambung (tidak memblokir pembacaan sensor).
// Ukurannya dibatasi: kalau penuh, data PALING LAMA yang dibuang.
const char* BUFFER_FILE = "/buffer.jsonl";
const char* TEMP_FILE   = "/buffer_tmp.jsonl";
const size_t BUFFER_MAX_BYTES     = 600 * 1024; // ~ 1 hari data (tiap baris ~200 byte, tiap 5 detik)
const int    DRAIN_LINES_PER_LOOP = 3;          // baris backlog yang dikirim per putaran loop
const unsigned long DRAIN_GAP_MS  = 200;        // = ~15 pesan/detik: cukup cepat, tapi tidak membanjiri WiFi yang sedang lemah/tersendat

size_t drainOffset = 0;        // posisi baris backlog berikutnya yang belum terkirim
unsigned long lastDrain = 0;
unsigned long droppedCount = 0; // baris yang terpaksa dibuang (buffer penuh / jam belum sinkron)

WiFiClient espClient;
PubSubClient client(espClient);

// ============================================================
// SERIAL MONITOR JARAK JAUH
// ============================================================
// "Log" dipakai di seluruh program menggantikan "Serial": semua yang dicetak tetap keluar ke
// USB seperti biasa, DAN - hanya selama ada yang menonton dari dashboard (Status Sistem / Pengaturan
// -> tombol Serial Monitor) - tiap baris juga dikirim ke topik MQTT .../log.
// Dashboard mengirim perintah "log on" tiap 60 detik selama jendelanya terbuka; kalau tidak
// diperpanjang, streaming berhenti sendiri setelah LOG_STREAM_MS (jadi tidak membebani jaringan
// saat tidak ada yang melihat).
const unsigned long LOG_STREAM_MS = 120000;
unsigned long logStreamUntil = 0;   // millis() batas streaming; 0 = tidak aktif
bool logSending = false;            // cegah pengiriman log memicu log lagi
String logBuf;

bool logStreaming() { return logStreamUntil != 0 && (long)(logStreamUntil - millis()) > 0; }

class LogPrint : public Print {
 public:
  void begin(unsigned long baud) { Serial.begin(baud); }
  size_t write(uint8_t c) override {
    Serial.write(c);
    feed(c);
    return 1;
  }
  size_t write(const uint8_t* buf, size_t n) override {
    Serial.write(buf, n);
    for (size_t i = 0; i < n; i++) feed(buf[i]);
    return n;
  }
 private:
  void feed(uint8_t c) {
    if (!logStreaming()) { if (logBuf.length()) logBuf = ""; return; }
    if (c == '\n') { kirim(); return; }
    if (c != '\r' && logBuf.length() < 280) logBuf += (char)c;
  }
  void kirim() {
    if (logBuf.length() && !logSending && client.connected()) {
      logSending = true;
      client.publish(TOPIC_LOG.c_str(), logBuf.c_str());
      logSending = false;
    }
    logBuf = "";
  }
};
LogPrint Log;

// Kirim pesan MQTT, tapi kalau pengirimannya gagal atau terlalu lama (jaringan tersendat) soketnya LANGSUNG ditutup,
// sehingga loop() segera menyambung ulang. Tanpa ini, soket yang macet dibiarkan sampai keepalive habis
// (30-45 detik) dan selama itu data tidak sampai dan dashboard merah.
const unsigned long PUBLISH_LAMBAT_MS = 4000;
bool publishAman(const char* topic, const char* payload, bool retained = false) {
  unsigned long t0 = millis();
  bool ok = client.publish(topic, payload, retained);
  unsigned long dt = millis() - t0;
  if (!ok || dt > PUBLISH_LAMBAT_MS) {
    Log.printf("[MQTT] Kirim %s (%lu ms) - sambungan ditutup, menyambung ulang\n", ok ? "lambat" : "gagal", dt);
    espClient.stop();   // PubSubClient lalu mengira terputus; loop() yang menyambung ulang
  }
  return ok;
}

unsigned long lastMsg = 0;
unsigned long lastStatus = 0;
unsigned long lastReconnectAttempt = 0;
unsigned long lastWifiAttempt = 0;

// ---- Access point "lengket" ----
// Tiap WiFi putus lalu menyambung lagi, memilih ulang access point terkuat saat itu membuat alat
// berpindah-pindah AP tanpa perlu (sinyal beberapa AP hanya beda 2-5 dB dan terus naik-turun).
// Karena itu AP terakhir yang berhasil diingat dan dicoba LEBIH DULU; hanya kalau gagal berkali-kali
// baru memilih ulang yang terkuat. Pindah AP "sungguhan" diurus cekRoaming() (sinyal lemah + AP lain jauh lebih kuat).
uint8_t apTerakhir[6];
int  apChannel = 0;
bool apTersimpan = false;
int  apGagal = 0;
const int AP_GAGAL_MAKS = 3;   // setelah ini gagal menyambung ke AP yang diingat, pilih ulang yang terkuat

// ---- Kandidat AP berikutnya (disiapkan SEBELUM sinyal AP sekarang benar-benar lemah) ----
// ESP32 hanya punya satu radio: tidak bisa tersambung ke dua AP sekaligus, jadi pindah AP tetap memutus
// koneksi sesaat. Yang bisa disiapkan lebih dulu: tahu AP tujuan (MAC + channel) SEBELUM dibutuhkan,
// sehingga saat sinyal turun alat langsung menyambung ke AP itu tanpa pemindaian lagi (~1 detik saja).
uint8_t candBssid[6];
int  candChannel = 0;
int  candRssi = 0;
bool candValid = false;
unsigned long candAt = 0;       // millis() saat kandidat terakhir diperbarui
unsigned int roamCount = 0;     // berapa kali alat pindah AP sejak boot (dikirim ke dashboard)
String apAlasan = "boot";       // alasan koneksi WiFi terakhir (dikirim ke dashboard untuk riwayat pindah AP)
const int AP_PREFER_DB = 8;     // saat memilih ulang setelah putus: AP lama tetap dipilih kalau selisih sinyalnya < ini dari yang terbaik

// ---- Daftar access point yang DIKENAL (disimpan di flash, bertahan walau dicabut/restart) ----
// Isinya: MAC (BSSID), channel, dan sinyal terakhir tiap access point ber-SSID sama yang pernah dilihat.
// Sumbernya (1) daftar awal dari IT di config.h (AP_SEED, opsional), (2) dipelajari otomatis: tiap
// tersambung dan tiap pemindaian. Manfaatnya:
//   - Setelah restart langsung menyambung ke AP terakhir (MAC + channel sudah diketahui, tanpa scan)
//   - Pemindaian persiapan cukup di channel yang dikenal saja (~0,3 detik, bukan ~2 detik semua channel)
// Catatan jujur: sinyal tiap AP bergantung POSISI crane, jadi sinyal tersimpan hanya petunjuk -
// yang mana lebih kuat sekarang tetap harus diukur lewat pemindaian singkat itu.
struct ApRec { uint8_t bssid[6]; uint8_t ch; int8_t rssi; };
const int AP_TBL_MAKS = 8;
ApRec apTbl[AP_TBL_MAKS];
int apN = 0;
bool apTblKotor = false;
unsigned long apTblSimpanTerakhir = 0;
const unsigned long AP_TBL_SIMPAN_MS = 120000;   // tulis flash paling sering tiap 2 menit (hemat umur flash)
Preferences apPrefs;

int apTblCari(const uint8_t* b) {
  for (int i = 0; i < apN; i++) if (memcmp(apTbl[i].bssid, b, 6) == 0) return i;
  return -1;
}

void apTblTambah(const uint8_t* b, int ch, int rssi) {
  if (!b || ch < 1 || ch > 14) return;
  int i = apTblCari(b);
  if (i < 0) {
    if (apN < AP_TBL_MAKS) i = apN++;
    else {   // penuh: buang yang sinyal terakhirnya paling lemah
      i = 0;
      for (int k = 1; k < apN; k++) if (apTbl[k].rssi < apTbl[i].rssi) i = k;
    }
    memcpy(apTbl[i].bssid, b, 6);
    apTblKotor = true;
  }
  if (apTbl[i].ch != ch) { apTbl[i].ch = ch; apTblKotor = true; }
  apTbl[i].rssi = (int8_t)rssi;   // rssi berubah tiap saat: cukup diperbarui di memori, tidak memicu tulis flash
}

void apTblSimpan(bool paksa = false) {
  if (!apTblKotor) return;
  if (!paksa && millis() - apTblSimpanTerakhir < AP_TBL_SIMPAN_MS) return;
  apTblSimpanTerakhir = millis();
  apPrefs.putUChar("n", apN);
  apPrefs.putBytes("tbl", apTbl, apN * sizeof(ApRec));
  apTblKotor = false;
}

// Daftar awal dari IT (opsional), format di config.h: #define AP_SEED "0A:8D:DB:D9:25:07,11;32:56:FE:C8:19:05,1"
void apTblSeed() {
#ifdef AP_SEED
  const char* p = AP_SEED;
  while (*p) {
    unsigned int m[6]; int ch = 0, used = 0;
    if (sscanf(p, "%x:%x:%x:%x:%x:%x,%d%n", &m[0], &m[1], &m[2], &m[3], &m[4], &m[5], &ch, &used) == 7) {
      uint8_t b[6];
      for (int i = 0; i < 6; i++) b[i] = (uint8_t)m[i];
      if (apTblCari(b) < 0) { apTblTambah(b, ch, -100); }
      p += used;
    } else break;
    while (*p == ';' || *p == ' ') p++;
  }
#endif
}

void apTblMuat() {
  apPrefs.begin("apdb", false);
  apN = apPrefs.getUChar("n", 0);
  if (apN > AP_TBL_MAKS) apN = 0;
  if (apN > 0 && apPrefs.getBytes("tbl", apTbl, apN * sizeof(ApRec)) != apN * sizeof(ApRec)) apN = 0;
  apTblSeed();
  if (apPrefs.getBytes("last", apTerakhir, 6) == 6) {
    apChannel = apPrefs.getUChar("lastch", 0);
    apTersimpan = apChannel >= 1 && apChannel <= 14;   // AP terakhir sebelum restart/dicabut
  }
  Log.printf("[AP-DB] %d access point dikenal%s\n", apN, apTersimpan ? ", AP terakhir diingat (akan dicoba langsung tanpa scan)" : "");
}

void ingatAP() {
  uint8_t* b = WiFi.BSSID();
  if (!b) return;
  bool berubah = !apTersimpan || memcmp(apTerakhir, b, 6) != 0 || apChannel != WiFi.channel();
  memcpy(apTerakhir, b, 6);
  apChannel = WiFi.channel();
  apTersimpan = true;
  apGagal = 0;
  apTblTambah(b, apChannel, WiFi.RSSI());
  if (berubah) {   // simpan AP terakhir ke flash HANYA kalau berubah (bukan tiap sambung ulang)
    apPrefs.putBytes("last", apTerakhir, 6);
    apPrefs.putUChar("lastch", (uint8_t)apChannel);
  }
  apTblSimpan();
}
bool wifiWasConnected = false;

// ============================================================
// WAKTU
// ============================================================
bool jamValid() {
  return time(nullptr) > JAM_VALID_SETELAH;
}

// "2026-09-20T10:00:05+07:00" (jam WIB lengkap dengan zona waktunya)
String timestampNow() {
  time_t now = time(nullptr);
  struct tm t;
  localtime_r(&now, &t);
  char buf[32];
  strftime(buf, sizeof(buf), "%Y-%m-%dT%H:%M:%S+07:00", &t);
  return String(buf);
}

// ============================================================
// WIFI (tidak memblokir selamanya saat boot)
// ============================================================
void setup_wifi() {
  Log.println("\n----------------------------------");
  Log.print("Menghubungkan ke WiFi: ");
  Log.println(WIFI_SSID);
  WiFi.mode(WIFI_STA);
  // Pilih access point dengan sinyal TERKUAT (bukan yang pertama ditemukan) saat menyambung.
  // Hemat beban: pemindaian semua channel hanya terjadi sekali per proses menyambung
  // (~1-2 detik), TIDAK berjalan saat alat sudah tersambung. Setelan ini tersimpan dan
  // ikut dipakai tiap WiFi.begin() di loop() saat menyambung ulang.
  WiFi.setSleep(false);   // radio tidak "tidur" di sela paket: koneksi MQTT lebih stabil & OTA jauh lebih cepat
  WiFi.setScanMethod(WIFI_ALL_CHANNEL_SCAN);
  WiFi.setSortMethod(WIFI_CONNECT_AP_BY_SIGNAL);
  // Ada AP terakhir tersimpan di flash (dari sesi sebelum dicabut/restart): sambung LANGSUNG ke situ
  // (MAC + channel sudah diketahui, tanpa pemindaian). Kalau dalam 6 detik tidak berhasil
  // (mis. alat dipindah ke area lain), pilih AP terkuat seperti biasa.
  bool langsungAP = apTersimpan;
  if (langsungAP) {
    Log.println("[WiFi] Menyambung langsung ke AP terakhir (tanpa scan)...");
    WiFi.begin(WIFI_SSID, WIFI_PASSWORD, apChannel, apTerakhir);
  } else {
    WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  }

  unsigned long mulai = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - mulai < WIFI_BOOT_TIMEOUT_MS) {
    delay(500);
    Log.print(".");
    if (langsungAP && millis() - mulai > 6000) {
      langsungAP = false;
      apTersimpan = false;
      Log.println("\n[WiFi] AP terakhir tidak terjangkau, memilih AP terkuat...");
      WiFi.disconnect();
      WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
    }
  }

  if (WiFi.status() == WL_CONNECTED) {
    wifiWasConnected = true;
    ingatAP();
    Log.println("\n[STATUS] WiFi Terhubung!");
    Log.print("[INFO] MAC Address (buat dikasih ke IT): ");
    Log.println(WiFi.macAddress());
    Log.print("[INFO] IP ESP32: ");
    Log.println(WiFi.localIP());
  } else {
    // Tetap lanjut: sensor tetap dibaca & disimpan ke buffer, WiFi dicoba lagi di loop()
    Log.println("\n[WiFi] Belum tersambung, lanjut jalan & coba lagi di belakang.");
  }
  Log.println("----------------------------------");
}

// Mulai sinkron jam lewat NTP. Tidak menunggu lama: SNTP terus mencoba sendiri di
// belakang dan jam otomatis benar begitu server NTP bisa dihubungi.
void setup_time() {
  configTime(GMT_OFFSET_SEC, 0, NTP_SERVER_1, NTP_SERVER_2);
  Log.print("[NTP] Sinkronisasi waktu");
  for (int i = 0; i < 20 && !jamValid(); i++) {
    Log.print(".");
    delay(500);
  }
  if (jamValid()) Log.println("\n[NTP] Waktu tersinkron: " + timestampNow());
  else Log.println("\n[NTP] Belum tersinkron (dicoba terus di belakang). Cek NTP_SERVER_1 di config.h");
}

// ============================================================
// SENSOR
// ============================================================
void bacaSemuaSensor() {
  for (int i = 0; i < JUMLAH_SENSOR; i++) {
    uint16_t raw = sensors[i]->readRTD();
    float t = sensors[i]->calculateTemperature(raw, RNOMINAL, RREF);
    uint8_t fault = sensors[i]->readFault();
    // MAX31865 sering TIDAK menandai fault saat PT100 belum terpasang / SDO (MISO) putus:
    // register RTD terbaca 0 -> suhu -242 tapi readFault() = 0. Anggap itu fault juga
    // (0xFE) supaya dikirim null, bukan -242 yang menyesatkan. Rentang PT100 wajar: -200..850 C.
    if (!fault && (isnan(t) || t < -200.0 || t > 850.0)) fault = 0xFE;
    faultCode[i] = fault;
    // LED indikator hardware: menyala = sensor ini normal, mati = fault. Dicek
    // ulang tiap pembacaan (tiap 5 detik), jadi otomatis nyala lagi begitu
    // kabelnya dibetulkan - tidak perlu reset ESP32.
    digitalWrite(ledFaultPins[i], fault ? LOW : HIGH);
    if (fault) {
      // Hambatan terukur membantu cari penyebab di lapangan: PT100 normal ~100-140 ohm,
      // ~0 = short / kabel tertukar, ~RREF (430) = PT100 putus.
      Log.printf("[FAULT MAX31865 - %s] Code: 0x%02X, R=%.1f ohm\n", gbKeys[i], fault, raw * RREF / 32768.0);
      sensors[i]->clearFault();
    }
    suhu[i] = round(t * 10.0) / 10.0;
  }
}

// Satu baris payload JSON (dipakai untuk kirim langsung MAUPUN disimpan ke buffer)
String buildPayload() {
  StaticJsonDocument<448> doc;
  doc["crane_id"] = CRANE_ID;
  doc["plant"]    = PLANT_NAME;
  if (jamValid()) doc["timestamp"] = timestampNow(); // jam KEJADIAN, dipakai server untuk data backlog

  JsonObject temps = doc.createNestedObject("temps");
  bool adaFault = false;
  for (int i = 0; i < JUMLAH_SENSOR; i++) {
    if (faultCode[i]) {
      temps[gbKeys[i]] = serialized("null"); // nilai sensor fault tidak bisa dipercaya
      adaFault = true;
    } else {
      temps[gbKeys[i]] = suhu[i];
    }
  }
  if (adaFault) {
    JsonObject faults = doc.createNestedObject("faults");
    for (int i = 0; i < JUMLAH_SENSOR; i++) {
      if (!faultCode[i]) continue;
      char hex[6];
      snprintf(hex, sizeof(hex), "0x%02X", faultCode[i]);
      faults[gbKeys[i]] = String(hex);
    }
  }

  String out;
  serializeJson(doc, out);
  return out;
}

// ============================================================
// STATUS & PERINTAH
// ============================================================
size_t bufferSize() {
  if (!LittleFS.exists(BUFFER_FILE)) return 0;
  File f = LittleFS.open(BUFFER_FILE, "r");
  size_t s = f ? f.size() : 0;
  if (f) f.close();
  return s;
}

unsigned long mqttUpSince = 0;   // millis() saat MQTT tersambung (0 = sedang tidak tersambung)
String otaState = "idle";   // dikabarkan ke dashboard lewat pesan status
String otaErr   = "";

// Penyebab restart terakhir, dibaca dari chip (bertahan sampai restart berikutnya). Dikirim ke dashboard
// supaya kelihatan KENAPA alat restart: watchdog = loop() macet >20 detik (mis. jaringan tersendat),
// brownout = tegangan turun (catu daya/kabel USB lemah), crash = bug program, listrik-nyala = baru dicolok.
const char* alasanReset() {
  switch (esp_reset_reason()) {
    case ESP_RST_POWERON:   return "listrik-nyala";
    case ESP_RST_SW:        return "restart-program";
    case ESP_RST_PANIC:     return "crash";
    case ESP_RST_INT_WDT:
    case ESP_RST_TASK_WDT:
    case ESP_RST_WDT:       return "watchdog";
    case ESP_RST_BROWNOUT:  return "brownout";
    case ESP_RST_EXT:       return "tombol-reset";
    case ESP_RST_DEEPSLEEP: return "deep-sleep";
    default:                return "lainnya";
  }
}

void publishStatus() {
  StaticJsonDocument<1024> doc;
  doc["online"]       = true;
  doc["fw"]           = FW_VERSION;
  doc["ip"]           = WiFi.localIP().toString();
  doc["mac"]          = WiFi.macAddress();
  doc["rssi"]         = WiFi.RSSI();
  doc["ap"]           = WiFi.BSSIDstr();   // MAC access point yang sedang dipakai
  doc["ch"]           = WiFi.channel();
  doc["roams"]        = roamCount;
  doc["ap_db"]        = apN;               // jumlah access point yang dikenal (tersimpan di flash)
  doc["ap_why"]       = apAlasan;          // kenapa tersambung ke AP ini: "boot" | "sambung-ulang" | "roaming"
  doc["rst"]          = alasanReset();     // penyebab restart terakhir (watchdog / brownout / crash / listrik-nyala ...)
  if (candValid) {                       // AP cadangan yang sudah disiapkan (lihat cekRoaming)
    char cb[18];
    snprintf(cb, sizeof(cb), "%02X:%02X:%02X:%02X:%02X:%02X", candBssid[0], candBssid[1], candBssid[2], candBssid[3], candBssid[4], candBssid[5]);
    doc["cand"]       = cb;
    doc["cand_rssi"]  = candRssi;
  }
  doc["node"]         = NODE_ID;              // ESP ke berapa di crane ini (1 = utama)
  doc["sensors"]      = JUMLAH_SENSOR;
  doc["uptime_s"]     = millis() / 1000;
  doc["time_synced"]  = jamValid();
  doc["buffer_bytes"] = bufferSize() > drainOffset ? bufferSize() - drainOffset : 0;
  doc["dropped"]      = droppedCount;
  doc["ota"]          = otaState;                 // "idle" | "downloading" | "failed" - dibaca dashboard (Pengaturan)
  if (otaErr.length()) doc["ota_err"] = otaErr;

  // Daftar lengkap AP yang dikenal ("MAC,channel,sinyal;..."), cukup tiap ~30 detik (bukan tiap status)
  // karena jarang berubah dan cukup panjang. Dashboard menampilkannya saat sel Access Point diklik.
  static unsigned int statusKe = 0;
  if (statusKe++ % 6 == 0 && apN > 0) {
    String db;
    for (int i = 0; i < apN; i++) {
      char e[34];
      snprintf(e, sizeof(e), "%02X:%02X:%02X:%02X:%02X:%02X,%d,%d;", apTbl[i].bssid[0], apTbl[i].bssid[1], apTbl[i].bssid[2],
               apTbl[i].bssid[3], apTbl[i].bssid[4], apTbl[i].bssid[5], apTbl[i].ch, apTbl[i].rssi);
      db += e;
    }
    doc["apdb"] = db;
  }

  char buf[1024];
  serializeJson(doc, buf);
  esp_task_wdt_reset();   // publish bisa menunggu kalau jaringan tersendat
  publishAman(TOPIC_STATUS.c_str(), buf, true); // retained: server langsung tahu status terakhir
  esp_task_wdt_reset();
  lastStatus = millis();
}

// ============================================================
// OTA - update firmware lewat WiFi (dipicu dari halaman Pengaturan)
// ============================================================
// Firmware KHUSUS ESP32 ini (per ID perangkat, karena tiap ESP32 di crane yang sama
// dikompilasi dengan NODE_ID & motornya sendiri), diunduh dari server.js:
//   http://<MQTT_SERVER>:<HTTP_PORT>/firmware-ota/<ID perangkat>/GBXMQTT.bin
const String OTA_URL = String("http://") + MQTT_SERVER + ":" + String(HTTP_PORT) +
                        "/firmware-ota/" + DEVICE_ID + "/GBXMQTT.bin";

// Kalau berhasil, ESP32 restart sendiri dan menjalankan firmware baru (rebootOnUpdate).
// Kalau gagal (mis. belum ada firmware ter-upload untuk crane ini, atau WiFi putus
// di tengah unduhan), ESP32 lanjut jalan seperti biasa dengan firmware sekarang -
// coba lagi nanti lewat tombol "Update" di Pengaturan.
void performOta() {
  if (WiFi.status() != WL_CONNECTED) {
    Log.println("[OTA] Batal - WiFi tidak tersambung");
    return;
  }
  Log.println("[OTA] Mengunduh firmware dari: " + OTA_URL);
  // Kabari dashboard SEBELUM unduhan memblokir loop() - Pengaturan menampilkan "sedang mengunduh"
  otaState = "downloading";
  otaErr = "";
  if (client.connected()) { publishStatus(); client.loop(); }
  WiFiClient otaClient;
  httpUpdate.rebootOnUpdate(true);
  // Unduh + tulis flash memblokir loop() lebih lama dari WDT_TIMEOUT_SEC -> tanpa ini watchdog
  // menganggap alat hang dan me-reboot di tengah OTA. Watchdog dilepas selama OTA, dipasang lagi kalau gagal.
  esp_task_wdt_delete(NULL);
  // Mode hemat daya WiFi (modem sleep, bawaan ESP32) memperlambat unduhan sampai beberapa kali lipat
  // karena radio "tidur" di sela paket. Alat ini pakai listrik terus-menerus, jadi dimatikan.
  WiFi.setSleep(false);
  otaClient.setNoDelay(true);
  unsigned long otaMulai = millis();
  int otaPersenTerakhir = -10;
  httpUpdate.onProgress([&](int sudah, int total) {
    int persen = total > 0 ? (int)((long long)sudah * 100 / total) : 0;
    if (persen >= otaPersenTerakhir + 10) {   // cetak tiap 10% supaya kelihatan kecepatannya
      otaPersenTerakhir = persen;
      Log.printf("[OTA] %d%% (%d/%d byte) %lu detik\n", persen, sudah, total, (millis() - otaMulai) / 1000);
    }
  });
  t_httpUpdate_return hasil = httpUpdate.update(otaClient, OTA_URL);
  esp_task_wdt_add(NULL);   // hanya sampai sini kalau OTA gagal (kalau sukses, alat sudah restart)
  esp_task_wdt_reset();
  switch (hasil) {
    case HTTP_UPDATE_FAILED:
      Log.printf("[OTA] Gagal (%d): %s\n", httpUpdate.getLastError(), httpUpdate.getLastErrorString().c_str());
      otaState = "failed";
      otaErr = String(httpUpdate.getLastError()) + ": " + httpUpdate.getLastErrorString();
      otaErr = otaErr.substring(0, 60);
      break;
    case HTTP_UPDATE_NO_UPDATES:
      Log.println("[OTA] Server tidak mengirim firmware (cek apakah sudah di-upload untuk crane ini)");
      otaState = "failed";
      otaErr = "server tidak mengirim firmware";
      break;
    case HTTP_UPDATE_OK:
      Log.println("[OTA] Berhasil, restart..."); // rebootOnUpdate aktif -> biasanya tidak sampai baris ini
      break;
  }
}

// Pesan dari server/operator di topik .../perintah.
// "status" = kirim status sekarang. "ota" = unduh & pasang firmware terbaru.
void callback(char* topic, byte* payload, unsigned int length) {
  String pesan;
  for (unsigned int i = 0; i < length; i++) pesan += (char)payload[i];
  pesan.trim();
  Log.println("[PERINTAH] " + pesan);
  if (pesan == "status" && client.connected()) publishStatus();
  else if (pesan == "ota") performOta();
  else if (pesan == "log on") { logStreamUntil = millis() + LOG_STREAM_MS; if (!logStreamUntil) logStreamUntil = 1; Log.println("[LOG] Serial Monitor jarak jauh aktif"); }
  else if (pesan == "log off") { Log.println("[LOG] Serial Monitor jarak jauh dihentikan"); logStreamUntil = 0; }
}

// ============================================================
// BUFFER OFFLINE
// ============================================================
// Buang backlog yang sudah terkirim + data paling lama, sisakan setengah kapasitas terbaru
void trimBuffer() {
  File src = LittleFS.open(BUFFER_FILE, "r");
  if (!src) return;
  size_t size = src.size();
  size_t mulai = drainOffset < size ? drainOffset : size;
  if (size - mulai > BUFFER_MAX_BYTES / 2) mulai = size - BUFFER_MAX_BYTES / 2;
  src.seek(mulai);
  if (mulai > 0) src.readStringUntil('\n'); // mulai dari awal baris utuh

  File tmp = LittleFS.open(TEMP_FILE, "w");
  if (!tmp) {
    src.close();
    return;
  }
  uint8_t chunk[256];
  while (src.available()) {
    size_t n = src.read(chunk, sizeof(chunk));
    tmp.write(chunk, n);
  }
  tmp.close();
  src.close();

  LittleFS.remove(BUFFER_FILE);
  LittleFS.rename(TEMP_FILE, BUFFER_FILE);
  drainOffset = 0;
  droppedCount++;
  Log.printf("[BUFFER] Penuh, data paling lama dibuang (ukuran sekarang %u byte)\n", (unsigned) bufferSize());
}

void appendToBuffer(const String& line) {
  if (!jamValid()) {
    // Tanpa jam yang benar, data ini tidak bisa diletakkan di waktu yang tepat saat
    // dikirim ulang nanti -> lebih baik tidak disimpan daripada menyesatkan.
    droppedCount++;
    return;
  }
  if (bufferSize() + line.length() + 1 > BUFFER_MAX_BYTES) trimBuffer();

  File f = LittleFS.open(BUFFER_FILE, "a");
  if (!f) {
    Log.println("[BUFFER] Gagal buka file untuk menyimpan!");
    droppedCount++;
    return;
  }
  f.println(line);
  f.close();
  Log.println("[BUFFER] Disimpan offline -> " + line);
}

// Kirim backlog sedikit-sedikit tiap putaran loop, supaya pembacaan sensor &
// pengiriman data live tetap jalan. Kalau putus di tengah jalan, lanjut dari
// posisi terakhir begitu tersambung lagi.
void drainBufferStep() {
  if (millis() - lastDrain < DRAIN_GAP_MS) return;
  lastDrain = millis();
  if (!LittleFS.exists(BUFFER_FILE)) return;

  File f = LittleFS.open(BUFFER_FILE, "r");
  if (!f) return;
  if (drainOffset >= f.size()) {
    f.close();
    LittleFS.remove(BUFFER_FILE);   // semua backlog sudah terkirim
    drainOffset = 0;
    Log.println("===== BACKLOG OFFLINE SELESAI TERKIRIM =====");
    return;
  }

  f.seek(drainOffset);
  for (int i = 0; i < DRAIN_LINES_PER_LOOP && f.available(); i++) {
    esp_task_wdt_reset();   // tiap publish bisa menunggu kalau jaringan tersendat
    String line = f.readStringUntil('\n');
    line.trim();
    if (line.length() > 0 && !publishAman(TOPIC_TEMP.c_str(), line.c_str())) break; // coba lagi nanti
    drainOffset = f.position();
  }
  f.close();
}

// ============================================================
// SETUP & LOOP
// ============================================================
void setup() {
  Log.begin(SERIAL_BAUD);
  delay(1000);
  Log.printf("\n=== GBXMQTT v%s - %s (%s) ===\n", FW_TAG + 9, DEVICE_ID.c_str(), PLANT_NAME);  // FW_TAG + 9 = lewati "GBXFWVER="
  Log.printf("[BOOT] Penyebab restart: %s\n", alasanReset());

  // Nama key motor tiap sensor: MOTOR_AWAL, MOTOR_AWAL+1, ... (lihat config.h)
  for (int i = 0; i < JUMLAH_SENSOR; i++) snprintf(gbKeys[i], sizeof(gbKeys[i]), "m%d", MOTOR_AWAL + i);
  Log.printf("[BOOT] Crane %s, ESP ke-%d, %d sensor: %s..%s\n", CRANE_ID, NODE_ID, JUMLAH_SENSOR, gbKeys[0], gbKeys[JUMLAH_SENSOR - 1]);

  if (!LittleFS.begin(true)) Log.println("[LittleFS] Gagal mount filesystem!");
  else Log.printf("[LittleFS] Siap. Backlog tersimpan: %u byte\n", (unsigned) bufferSize());

  for (int i = 0; i < JUMLAH_SENSOR; i++) sensors[i]->begin(MODE_MAX31865);

  // LED fault per sensor: nyala dulu di awal (belum sempat dibaca = anggap OK),
  // baru bacaSemuaSensor() yang menentukan nyala/mati sebenarnya berdasarkan fault.
  for (int i = 0; i < JUMLAH_SENSOR; i++) {
    pinMode(ledFaultPins[i], OUTPUT);
    digitalWrite(ledFaultPins[i], HIGH);
  }

  apTblMuat();   // daftar AP yang dikenal + AP terakhir, dari flash
  setup_wifi();
  setup_time();

  client.setServer(MQTT_SERVER, MQTT_PORT);
  // Keepalive 30 detik (bawaan 15): broker baru menganggap alat mati setelah ~45 detik tanpa paket,
  // jadi jeda sesaat di jaringan (mis. jembatan antar band 2,4/5 GHz di access point) tidak langsung memutus.
  client.setKeepAlive(30);
  client.setSocketTimeout(10);  // menunggu balasan broker sampai 10 detik: di udara yang banyak kehilangan paket balasan sering telat (aman, watchdog 45 detik)
  client.setCallback(callback);
  client.setBufferSize(1280); // payload + status lebih dari batas bawaan 256 byte

  // LAPISAN 3: Watchdog - kalau loop() macet total (bukan cuma WiFi/MQTT putus,
  // tapi benar-benar hang, mis. library call yang blocking selamanya), ESP32
  // reboot sendiri setelah WDT_TIMEOUT_SEC detik tanpa "feed the dog" (lihat
  // esp_task_wdt_reset() di awal loop()). Core 2.x: esp_task_wdt_init(detik, panic);
  // core 3.x (IDF 5): esp_task_wdt_init(&config) dengan struct - dipilih otomatis di bawah.
#if defined(ESP_ARDUINO_VERSION_MAJOR) && ESP_ARDUINO_VERSION_MAJOR >= 3
  esp_task_wdt_config_t wdtCfg = {};
  wdtCfg.timeout_ms     = WDT_TIMEOUT_SEC * 1000;
  wdtCfg.idle_core_mask = 0;      // hanya task loop() yang diawasi
  wdtCfg.trigger_panic  = true;   // timeout -> reboot
  // Core 3.x sudah menyalakan watchdog sendiri -> init bisa "sudah ada", kalau begitu atur ulang
  if (esp_task_wdt_init(&wdtCfg) == ESP_ERR_INVALID_STATE) esp_task_wdt_reconfigure(&wdtCfg);
#else
  esp_task_wdt_init(WDT_TIMEOUT_SEC, true);
#endif
  esp_task_wdt_add(NULL);
  Log.printf("[Watchdog] Aktif, timeout %u detik\n", WDT_TIMEOUT_SEC);
}

bool connectMqtt() {
  const char* user = strlen(MQTT_USER) ? MQTT_USER : nullptr;
  const char* pass = strlen(MQTT_PASS) ? MQTT_PASS : nullptr;
  // Last Will: kalau ESP32 putus mendadak (mati listrik, WiFi hilang), broker yang
  // mengumumkan {"online":false} ke topik status.
  esp_task_wdt_reset();   // connect() bisa menunggu beberapa detik kalau broker lambat/tidak terjangkau
  bool ok = client.connect(CLIENT_ID.c_str(), user, pass,
                           TOPIC_STATUS.c_str(), 1, true, "{\"online\":false}");
  esp_task_wdt_reset();
  if (ok) {
    client.subscribe(TOPIC_PERINTAH.c_str());
    publishStatus();
  }
  return ok;
}

// Kekuatan sinyal ke access point (RSSI, dBm - makin dekat ke 0 makin kuat):
//   >= -50 sangat bagus | -60 bagus | -70 cukup | -80 lemah | < -80 buruk (sering putus)
// Tampil juga SSID, channel, dan MAC access point yang sedang dipakai, jadi
// kelihatan kalau ESP32 pindah (roaming) ke access point lain.
void cetakSinyalWiFi() {
  if (WiFi.status() != WL_CONNECTED) {
    Log.println("[SINYAL] WiFi belum tersambung");
    return;
  }
  int rssi = WiFi.RSSI();
  const char* label = rssi >= -50 ? "SANGAT BAGUS" : rssi >= -60 ? "BAGUS" : rssi >= -70 ? "CUKUP" : rssi >= -80 ? "LEMAH" : "BURUK";
  int persen = constrain(2 * (rssi + 100), 0, 100);  // perkiraan kasar: -50 dBm = 100%, -100 dBm = 0%
  char bar[11];
  int isi = persen / 10;
  for (int i = 0; i < 10; i++) bar[i] = i < isi ? '#' : '-';
  bar[10] = 0;
  Log.printf("[SINYAL] %d dBm (%d%%) [%s] %s | AP: %s ch%d %s\n",
                rssi, persen, bar, label, WiFi.SSID().c_str(), WiFi.channel(), WiFi.BSSIDstr().c_str());
}

// ============================================================
// ROAMING: siapkan AP cadangan lebih dulu, lalu pindah cepat saat sinyal melemah
// ============================================================
// Tahap 1 PERSIAPAN: begitu sinyal AP sekarang mulai turun (< ROAM_SIAP_AMBANG), alat memindai di
//   latar belakang tiap ROAM_SCAN_MS dan mencatat AP ber-SSID sama yang paling kuat sebagai KANDIDAT.
//   Pemindaian async, ringan, dan hanya jalan saat sinyal sudah mulai kurang bagus.
// Tahap 2 PINDAH: kalau sinyal < ROAM_RSSI_AMBANG dua kali cek berturut-turut DAN kandidat segar
//   minimal ROAM_SELISIH_DB lebih kuat -> langsung menyambung ke kandidat (MAC + channel sudah diketahui,
//   tanpa pemindaian lagi). Catatan: radio hanya satu, jadi tetap ada putus ~1-2 detik; pembacaan sensor
//   jalan terus dan data disimpan di buffer offline, lalu dikirim begitu tersambung.
// Setelah pindah ada jeda ROAM_COOLDOWN_MS supaya tidak bolak-balik.
const int ROAM_SIAP_AMBANG = -62;     // mulai menyiapkan kandidat
const int ROAM_RSSI_AMBANG = -70;     // batas CUKUP -> LEMAH: boleh pindah
const int ROAM_SELISIH_DB  = 10;
const unsigned long ROAM_CEK_MS      = 10000;
const unsigned long ROAM_SCAN_MS     = 20000;    // jarak antar pemindaian persiapan
const unsigned long ROAM_KANDIDAT_BASI_MS = 90000;
const unsigned long ROAM_COOLDOWN_MS = 120000;
int roamLemahCount = 0;
bool roamScanning = false;
unsigned long lastRoamCek = 0;
unsigned long lastRoamScan = 0;
unsigned long lastRoamAksi = 0;

// Pemindaian persiapan: hanya channel yang ada di daftar AP dikenal (maks 4), satu channel per putaran
// async (~150 ms/channel) - jauh lebih singkat daripada semua channel. Tiap 5 pemindaian sekali
// dipindai SEMUA channel supaya AP baru yang belum dikenal tetap ketemu dan masuk daftar.
int scanChs[4];
int scanChN = 0;
int scanChIdx = 0;
int scanKe = 0;
int accBestRssi = -127;
uint8_t accBssid[6];
int accCh = 0;

void mulaiScanPersiapan() {
  scanChN = 0;
  if (scanKe++ % 5 != 0) {
    for (int i = 0; i < apN && scanChN < 4; i++) {
      bool ada = false;
      for (int k = 0; k < scanChN; k++) if (scanChs[k] == apTbl[i].ch) ada = true;
      if (!ada) scanChs[scanChN++] = apTbl[i].ch;
    }
  }
  if (scanChN == 0) { scanChN = 1; scanChs[0] = 0; }   // 0 = semua channel
  scanChIdx = 0;
  accBestRssi = -127;
  accCh = 0;
  WiFi.scanNetworks(true, false, false, 150, scanChs[0]);
  roamScanning = true;
}

// Ambil hasil satu channel: pelajari AP baru ke daftar, catat yang terkuat (selain yang sekarang).
// Setelah channel terakhir, jadikan yang terkuat sebagai kandidat.
void ambilHasilScan() {
  int n = WiFi.scanComplete();
  if (n == WIFI_SCAN_RUNNING) return;
  if (n >= 0) {
    String bssidNow = WiFi.BSSIDstr();
    for (int i = 0; i < n; i++) {
      if (WiFi.SSID(i) != WIFI_SSID) continue;
      apTblTambah(WiFi.BSSID(i), WiFi.channel(i), WiFi.RSSI(i));   // belajar / perbarui daftar AP dikenal
      if (WiFi.BSSIDstr(i) == bssidNow) continue;
      if (WiFi.RSSI(i) > accBestRssi) {
        accBestRssi = WiFi.RSSI(i);
        memcpy(accBssid, WiFi.BSSID(i), 6);
        accCh = WiFi.channel(i);
      }
    }
  }
  WiFi.scanDelete();
  if (++scanChIdx < scanChN) {   // masih ada channel lain: lanjut
    WiFi.scanNetworks(true, false, false, 150, scanChs[scanChIdx]);
    return;
  }
  roamScanning = false;
  if (accCh) {
    memcpy(candBssid, accBssid, 6);
    candChannel = accCh;
    candRssi = accBestRssi;
    candValid = true;
    candAt = millis();
  } else {
    candValid = false;
  }
  apTblSimpan();   // AP baru yang dipelajari disimpan ke flash (dibatasi tiap 2 menit)
}

void pindahKeKandidat() {
  char cb[18];
  snprintf(cb, sizeof(cb), "%02X:%02X:%02X:%02X:%02X:%02X", candBssid[0], candBssid[1], candBssid[2], candBssid[3], candBssid[4], candBssid[5]);
  Log.printf("[ROAMING] Pindah AP: %d dBm (%s) -> %d dBm (%s) ch%d (kandidat sudah disiapkan, tanpa scan ulang)\n",
             WiFi.RSSI(), WiFi.BSSIDstr().c_str(), candRssi, cb, candChannel);
  memcpy(apTerakhir, candBssid, 6);   // AP tujuan jadi AP yang diingat, supaya loop() tidak menariknya balik
  apChannel = candChannel;
  apTersimpan = true;
  apGagal = 0;
  lastRoamAksi = millis();
  lastWifiAttempt = millis();         // beri waktu menyambung sebelum loop() mencoba ulang
  roamCount++;
  apAlasan = "roaming";
  candValid = false;
  roamLemahCount = 0;
  WiFi.disconnect();
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD, apChannel, apTerakhir);
}

void cekRoaming() {
  if (WiFi.status() != WL_CONNECTED) {
    roamScanning = false;
    roamLemahCount = 0;
    return;
  }
  if (roamScanning) { ambilHasilScan(); return; }

  if (millis() - lastRoamCek < ROAM_CEK_MS) return;
  lastRoamCek = millis();
  int rssi = WiFi.RSSI();

  // Sinyal masih bagus: tidak perlu kandidat
  if (rssi >= ROAM_SIAP_AMBANG) { roamLemahCount = 0; candValid = false; return; }

  // TAHAP 1 - persiapan: perbarui kandidat secara berkala selama sinyal mulai kurang bagus
  if (millis() - lastRoamScan > ROAM_SCAN_MS) {
    lastRoamScan = millis();
    mulaiScanPersiapan();   // async: hasil diambil di putaran berikutnya
  }

  // TAHAP 2 - pindah: sinyal lemah 2x berturut-turut + kandidat segar & jauh lebih kuat
  if (rssi >= ROAM_RSSI_AMBANG) { roamLemahCount = 0; return; }
  if (++roamLemahCount < 2) return;
  if (lastRoamAksi != 0 && millis() - lastRoamAksi < ROAM_COOLDOWN_MS) return;
  if (candValid && millis() - candAt < ROAM_KANDIDAT_BASI_MS && candRssi >= rssi + ROAM_SELISIH_DB) {
    pindahKeKandidat();
  } else if (!roamScanning) {
    Log.printf("[ROAMING] Sinyal lemah (%d dBm), belum ada kandidat AP yang jauh lebih kuat\n", rssi);
  }
}
// Dipanggil saat sambung ulang ke AP yang sama sudah gagal AP_GAGAL_MAKS kali. WiFi memang sedang putus,
// jadi pemindaian singkat (~2 detik) di sini tidak mengganggu apa pun. Aturan memilih:
//   - Pilih AP terkuat, KECUALI AP lama masih terlihat dan sinyalnya selisih kurang dari AP_PREFER_DB
//     dari yang terkuat -> tetap AP lama. (Sinyal dua AP yang beda 2-5 dB itu praktis sama; pindah
//     hanya karena "kebetulan lebih kuat sesaat" malah bikin putus tanpa untung.)
void sambungUlangPilihAP() {
  Log.println("[WiFi] AP sebelumnya tidak bisa dipakai, memindai untuk memilih AP...");
  esp_task_wdt_reset();
  int n = WiFi.scanNetworks(false, false, false, 150);   // blocking ~2 detik
  esp_task_wdt_reset();
  int best = -1, bestRssi = -127, lama = -1, lamaRssi = -127;
  for (int i = 0; i < max(n, 0); i++) {
    if (WiFi.SSID(i) != WIFI_SSID) continue;
    int r = WiFi.RSSI(i);
    apTblTambah(WiFi.BSSID(i), WiFi.channel(i), r);
    if (r > bestRssi) { best = i; bestRssi = r; }
    if (memcmp(WiFi.BSSID(i), apTerakhir, 6) == 0) { lama = i; lamaRssi = r; }
  }
  int pilih = best;
  if (lama >= 0 && lamaRssi >= bestRssi - AP_PREFER_DB) pilih = lama;
  if (pilih >= 0) {
    uint8_t b[6];
    memcpy(b, WiFi.BSSID(pilih), 6);
    int ch = WiFi.channel(pilih);
    int r = WiFi.RSSI(pilih);
    bool tetap = (pilih == lama);
    WiFi.scanDelete();
    memcpy(apTerakhir, b, 6);
    apChannel = ch;
    apTersimpan = true;
    apGagal = 0;
    Log.printf("[WiFi] %s: %02X:%02X:%02X:%02X:%02X:%02X ch%d (%d dBm)\n",
               tetap ? "Tetap di AP lama" : "Memilih AP terkuat", b[0], b[1], b[2], b[3], b[4], b[5], ch, r);
    WiFi.begin(WIFI_SSID, WIFI_PASSWORD, ch, b);
  } else {
    WiFi.scanDelete();
    apTersimpan = false;
    apGagal = 0;
    Log.println("[WiFi] Tidak ada AP ditemukan, mencoba sambung biasa...");
    WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  }
}

void loop() {
  esp_task_wdt_reset(); // "feed the dog" - lihat LAPISAN 3 di setup()

  // ---- LAPISAN 1: WiFi ----
  if (WiFi.status() != WL_CONNECTED) {
    if (wifiWasConnected) Log.println("[WiFi] Terputus!");
    wifiWasConnected = false;
    if (millis() - lastWifiAttempt > INTERVAL_WIFI_RETRY_MS) {
      lastWifiAttempt = millis();
      WiFi.disconnect();
      apAlasan = "sambung-ulang";
      if (apTersimpan && apGagal < AP_GAGAL_MAKS) {
        apGagal++;
        Log.printf("[WiFi] Menyambung ulang ke AP yang sama (%d/%d)...\n", apGagal, AP_GAGAL_MAKS);
        WiFi.begin(WIFI_SSID, WIFI_PASSWORD, apChannel, apTerakhir);
      } else {
        sambungUlangPilihAP();   // memindai, lalu pilih AP (AP lama diutamakan kalau sinyalnya tidak jauh tertinggal)
      }
    }
    // sengaja tidak return: sensor tetap dibaca & disimpan ke buffer di bawah
  } else {
    if (!wifiWasConnected) {
      wifiWasConnected = true;
      ingatAP();
      mqttTerakhirOk = millis();   // hitung pengaman "MQTT mati" mulai dari WiFi tersambung, bukan dari waktu WiFi masih putus
      Log.println("[WiFi] Tersambung! IP: " + WiFi.localIP().toString() + " | AP: " + WiFi.BSSIDstr());
    }

      // ---- LAPISAN 2: MQTT ----
      if (!client.connected()) {
        if (mqttUpSince) {   // baru saja terputus: catat penyebab & lama koneksi, untuk diagnosa jaringan
          // state: -4 = timeout (broker tidak membalas), -3 = koneksi terputus, -2 = gagal tersambung
          Log.printf("[MQTT] TERPUTUS setelah %lu detik (state=%d, RSSI=%d dBm, WiFi %s)\n",
                        (millis() - mqttUpSince) / 1000, client.state(), WiFi.RSSI(),
                        WiFi.status() == WL_CONNECTED ? "masih tersambung" : "putus");
          mqttUpSince = 0;
        }
        // Pengaman: broker tak terjangkau sangat lama padahal WiFi "tersambung" -> segarkan WiFi, lalu restart
        if (millis() - mqttTerakhirOk > MQTT_MATI_RESTART_MS) {
          Log.println("[PENGAMAN] MQTT mati > 20 menit, restart ESP32 (data di buffer flash tetap aman)");
          delay(200);
          ESP.restart();
        }
        if (millis() - mqttTerakhirOk > MQTT_MATI_RESET_WIFI_MS && millis() - lastWifiAttempt > MQTT_MATI_RESET_WIFI_MS) {
          Log.println("[PENGAMAN] MQTT mati > 5 menit, menyambung ulang WiFi & memilih ulang AP...");
          lastWifiAttempt = millis();
          apTersimpan = false;
          apAlasan = "sambung-ulang";
          WiFi.disconnect();
          WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
        }
        if (millis() - lastReconnectAttempt > INTERVAL_RETRY_MS) {
          lastReconnectAttempt = millis();
          Log.print("[MQTT] Mencoba terhubung ke broker... ");
          if (connectMqtt()) { Log.println("BERHASIL!"); mqttUpSince = millis(); }
          else { Log.print("GAGAL, kode="); Log.println(client.state()); }
        }
      } else {
        mqttTerakhirOk = millis();
        client.loop();
        drainBufferStep();
        if (millis() - lastStatus > INTERVAL_STATUS_MS) publishStatus();
      }
    }

  cekRoaming();

  if (millis() - lastSinyal > INTERVAL_SINYAL_MS) {
    lastSinyal = millis();
    cetakSinyalWiFi();
  }

  // ---- Baca sensor tiap 5 detik, jalan terus baik online maupun offline ----
  if (millis() - lastMsg > INTERVAL_BACA_MS) {
    lastMsg = millis();
    esp_task_wdt_reset();
    bacaSemuaSensor();
    String payload = buildPayload();

    if (client.connected() && publishAman(TOPIC_TEMP.c_str(), payload.c_str())) {
      Log.println("[KIRIM] " + payload);
    } else {
      appendToBuffer(payload); // WiFi / broker mati -> simpan, dikirim ulang nanti
    }
    esp_task_wdt_reset();
  }
}
