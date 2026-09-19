// ============================================================
// GBXMQTT v2 - ESP32 + 5x PT100 (MAX31865) -> MQTT
// Monitoring Suhu Gearbox Overhead Crane - Karawang Plant
// ============================================================
// Yang diubah untuk tiap alat HANYA config.h (identitas crane & broker) dan
// secrets.h (WiFi). File ini sama untuk semua crane.
//
// Pesan yang dikirim:
//   pabrik/<AREA>/<CRANE_ID>/temp    tiap 5 detik
//     {"crane_id":"crane-01","plant":"TWB","timestamp":"2026-09-20T10:00:05+07:00",
//      "temps":{"gb01":55.2,...,"gb04":null},"faults":{"gb04":"0x80"}}
//     - timestamp pakai zona waktu (+07:00); TIDAK dikirim kalau jam belum tersinkron
//       (server lalu memakai jam terima)
//     - suhu null + kode di "faults" kalau MAX31865 melaporkan fault (mis. PT100 putus)
//   pabrik/<AREA>/<CRANE_ID>/status  saat tersambung & tiap 60 detik (retained)
//     {"online":true,"fw":"2.0.0","ip":"...","mac":"...","rssi":-60,...}
//     Last Will: broker otomatis mengirim {"online":false} kalau ESP32 putus mendadak,
//     jadi dashboard langsung tahu tanpa menunggu 2 menit.
//
// Library: PubSubClient, ArduinoJson (v6 atau v7), Adafruit MAX31865.
// Board: ESP32 (LittleFS sudah termasuk di core ESP32).

#include <WiFi.h>
#include <PubSubClient.h>
#include <ArduinoJson.h>
#include <Adafruit_MAX31865.h>
#include <LittleFS.h>
#include <time.h>

#include "config.h"
#include "secrets.h"   // salin dari secrets.example.h kalau belum ada

#define FW_VERSION "2.0.0"

// ============================================================
// 1. PIN & MAX31865 (SOFTWARE SPI, 5 SENSOR)
// ============================================================
#define RREF      430.0
#define RNOMINAL  100.0

#define PIN_SDI   23  // MOSI (bareng)
#define PIN_SDO   19  // MISO (bareng)
#define PIN_CLK   18  // SCK  (bareng)

#define PIN_CS_GB01  4
#define PIN_CS_GB02  5
#define PIN_CS_GB03  16
#define PIN_CS_GB04  17
#define PIN_CS_GB05  25

#define JUMLAH_SENSOR 5

Adafruit_MAX31865 sensorGB01(PIN_CS_GB01, PIN_SDI, PIN_SDO, PIN_CLK);
Adafruit_MAX31865 sensorGB02(PIN_CS_GB02, PIN_SDI, PIN_SDO, PIN_CLK);
Adafruit_MAX31865 sensorGB03(PIN_CS_GB03, PIN_SDI, PIN_SDO, PIN_CLK);
Adafruit_MAX31865 sensorGB04(PIN_CS_GB04, PIN_SDI, PIN_SDO, PIN_CLK);
Adafruit_MAX31865 sensorGB05(PIN_CS_GB05, PIN_SDI, PIN_SDO, PIN_CLK);

Adafruit_MAX31865* sensors[JUMLAH_SENSOR] = { &sensorGB01, &sensorGB02, &sensorGB03, &sensorGB04, &sensorGB05 };
const char* gbKeys[JUMLAH_SENSOR]         = { "gb01", "gb02", "gb03", "gb04", "gb05" };
float   suhu[JUMLAH_SENSOR];
uint8_t faultCode[JUMLAH_SENSOR];   // 0 = normal

// ============================================================
// 2. TOPIK & WAKTU (dibentuk otomatis dari config.h)
// ============================================================
const String TOPIC_TEMP     = String("pabrik/") + AREA + "/" + CRANE_ID + "/temp";
const String TOPIC_STATUS   = String("pabrik/") + AREA + "/" + CRANE_ID + "/status";
const String TOPIC_PERINTAH = String("pabrik/") + AREA + "/" + CRANE_ID + "/perintah";
const String CLIENT_ID      = String("ESP32-") + CRANE_ID;   // wajib unik per alat

const long GMT_OFFSET_SEC = 7 * 3600;       // WIB = UTC+7
const time_t JAM_VALID_SETELAH = 1700000000; // < Nov 2023 berarti jam belum tersinkron

const unsigned long INTERVAL_BACA_MS   = 5000;
const unsigned long INTERVAL_STATUS_MS = 60000;
const unsigned long INTERVAL_RETRY_MS  = 5000;
const unsigned long WIFI_BOOT_TIMEOUT_MS = 20000;

// ============================================================
// 3. BUFFER OFFLINE (LittleFS)
// ============================================================
// Data yang terbaca saat WiFi/broker mati disimpan di flash lalu dikirim ulang
// sedikit demi sedikit setelah tersambung (tidak memblokir pembacaan sensor).
// Ukurannya dibatasi: kalau penuh, data PALING LAMA yang dibuang.
const char* BUFFER_FILE = "/buffer.jsonl";
const char* TEMP_FILE   = "/buffer_tmp.jsonl";
const size_t BUFFER_MAX_BYTES     = 600 * 1024; // ~ 1 hari data (tiap baris ~200 byte, tiap 5 detik)
const int    DRAIN_LINES_PER_LOOP = 10;         // baris backlog yang dikirim per putaran loop
const unsigned long DRAIN_GAP_MS  = 50;

size_t drainOffset = 0;        // posisi baris backlog berikutnya yang belum terkirim
unsigned long lastDrain = 0;
unsigned long droppedCount = 0; // baris yang terpaksa dibuang (buffer penuh / jam belum sinkron)

WiFiClient espClient;
PubSubClient client(espClient);

unsigned long lastMsg = 0;
unsigned long lastStatus = 0;
unsigned long lastReconnectAttempt = 0;
unsigned long lastWifiAttempt = 0;
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
  Serial.println("\n----------------------------------");
  Serial.print("Menghubungkan ke WiFi: ");
  Serial.println(WIFI_SSID);
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);

  unsigned long mulai = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - mulai < WIFI_BOOT_TIMEOUT_MS) {
    delay(500);
    Serial.print(".");
  }

  if (WiFi.status() == WL_CONNECTED) {
    wifiWasConnected = true;
    Serial.println("\n[STATUS] WiFi Terhubung!");
    Serial.print("[INFO] MAC Address (buat dikasih ke IT): ");
    Serial.println(WiFi.macAddress());
    Serial.print("[INFO] IP ESP32: ");
    Serial.println(WiFi.localIP());
  } else {
    // Tetap lanjut: sensor tetap dibaca & disimpan ke buffer, WiFi dicoba lagi di loop()
    Serial.println("\n[WiFi] Belum tersambung, lanjut jalan & coba lagi di belakang.");
  }
  Serial.println("----------------------------------");
}

// Mulai sinkron jam lewat NTP. Tidak menunggu lama: SNTP terus mencoba sendiri di
// belakang dan jam otomatis benar begitu server NTP bisa dihubungi.
void setup_time() {
  configTime(GMT_OFFSET_SEC, 0, NTP_SERVER_1, NTP_SERVER_2);
  Serial.print("[NTP] Sinkronisasi waktu");
  for (int i = 0; i < 20 && !jamValid(); i++) {
    Serial.print(".");
    delay(500);
  }
  if (jamValid()) Serial.println("\n[NTP] Waktu tersinkron: " + timestampNow());
  else Serial.println("\n[NTP] Belum tersinkron (dicoba terus di belakang). Cek NTP_SERVER_1 di config.h");
}

// ============================================================
// SENSOR
// ============================================================
void bacaSemuaSensor() {
  for (int i = 0; i < JUMLAH_SENSOR; i++) {
    float t = sensors[i]->temperature(RNOMINAL, RREF);
    uint8_t fault = sensors[i]->readFault();
    faultCode[i] = fault;
    if (fault) {
      Serial.printf("[FAULT MAX31865 - %s] Code: 0x%02X\n", gbKeys[i], fault);
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

void publishStatus() {
  StaticJsonDocument<320> doc;
  doc["online"]       = true;
  doc["fw"]           = FW_VERSION;
  doc["ip"]           = WiFi.localIP().toString();
  doc["mac"]          = WiFi.macAddress();
  doc["rssi"]         = WiFi.RSSI();
  doc["sensors"]      = JUMLAH_SENSOR;
  doc["uptime_s"]     = millis() / 1000;
  doc["time_synced"]  = jamValid();
  doc["buffer_bytes"] = bufferSize() > drainOffset ? bufferSize() - drainOffset : 0;
  doc["dropped"]      = droppedCount;

  char buf[320];
  serializeJson(doc, buf);
  client.publish(TOPIC_STATUS.c_str(), buf, true); // retained: server langsung tahu status terakhir
  lastStatus = millis();
}

// Pesan dari server/operator di topik .../perintah. Saat ini: "status" = kirim status sekarang.
void callback(char* topic, byte* payload, unsigned int length) {
  String pesan;
  for (unsigned int i = 0; i < length; i++) pesan += (char)payload[i];
  pesan.trim();
  Serial.println("[PERINTAH] " + pesan);
  if (pesan == "status" && client.connected()) publishStatus();
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
  Serial.printf("[BUFFER] Penuh, data paling lama dibuang (ukuran sekarang %u byte)\n", (unsigned) bufferSize());
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
    Serial.println("[BUFFER] Gagal buka file untuk menyimpan!");
    droppedCount++;
    return;
  }
  f.println(line);
  f.close();
  Serial.println("[BUFFER] Disimpan offline -> " + line);
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
    Serial.println("===== BACKLOG OFFLINE SELESAI TERKIRIM =====");
    return;
  }

  f.seek(drainOffset);
  for (int i = 0; i < DRAIN_LINES_PER_LOOP && f.available(); i++) {
    String line = f.readStringUntil('\n');
    line.trim();
    if (line.length() > 0 && !client.publish(TOPIC_TEMP.c_str(), line.c_str())) break; // coba lagi nanti
    drainOffset = f.position();
  }
  f.close();
}

// ============================================================
// SETUP & LOOP
// ============================================================
void setup() {
  Serial.begin(115200);
  delay(1000);
  Serial.printf("\n=== GBXMQTT v%s - %s (%s) ===\n", FW_VERSION, CRANE_ID, PLANT_NAME);

  if (!LittleFS.begin(true)) Serial.println("[LittleFS] Gagal mount filesystem!");
  else Serial.printf("[LittleFS] Siap. Backlog tersimpan: %u byte\n", (unsigned) bufferSize());

  for (int i = 0; i < JUMLAH_SENSOR; i++) sensors[i]->begin(MAX31865_3WIRE);

  setup_wifi();
  setup_time();

  client.setServer(MQTT_SERVER, MQTT_PORT);
  client.setCallback(callback);
  client.setBufferSize(512); // payload + status lebih dari batas bawaan 256 byte
}

bool connectMqtt() {
  const char* user = strlen(MQTT_USER) ? MQTT_USER : nullptr;
  const char* pass = strlen(MQTT_PASS) ? MQTT_PASS : nullptr;
  // Last Will: kalau ESP32 putus mendadak (mati listrik, WiFi hilang), broker yang
  // mengumumkan {"online":false} ke topik status.
  bool ok = client.connect(CLIENT_ID.c_str(), user, pass,
                           TOPIC_STATUS.c_str(), 1, true, "{\"online\":false}");
  if (ok) {
    client.subscribe(TOPIC_PERINTAH.c_str());
    publishStatus();
  }
  return ok;
}

void loop() {
  // ---- LAPISAN 1: WiFi ----
  if (WiFi.status() != WL_CONNECTED) {
    if (wifiWasConnected) Serial.println("[WiFi] Terputus!");
    wifiWasConnected = false;
    if (millis() - lastWifiAttempt > INTERVAL_RETRY_MS) {
      lastWifiAttempt = millis();
      Serial.println("[WiFi] Mencoba menyambung ulang...");
      WiFi.disconnect();
      WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
    }
    // sengaja tidak return: sensor tetap dibaca & disimpan ke buffer di bawah
  } else {
    if (!wifiWasConnected) {
      wifiWasConnected = true;
      Serial.println("[WiFi] Tersambung! IP: " + WiFi.localIP().toString());
    }

      // ---- LAPISAN 2: MQTT ----
      if (!client.connected()) {
        if (millis() - lastReconnectAttempt > INTERVAL_RETRY_MS) {
          lastReconnectAttempt = millis();
          Serial.print("[MQTT] Mencoba terhubung ke broker... ");
          if (connectMqtt()) Serial.println("BERHASIL!");
          else { Serial.print("GAGAL, kode="); Serial.println(client.state()); }
        }
      } else {
        client.loop();
        drainBufferStep();
        if (millis() - lastStatus > INTERVAL_STATUS_MS) publishStatus();
      }
    }

  // ---- Baca sensor tiap 5 detik, jalan terus baik online maupun offline ----
  if (millis() - lastMsg > INTERVAL_BACA_MS) {
    lastMsg = millis();
    bacaSemuaSensor();
    String payload = buildPayload();

    if (client.connected() && client.publish(TOPIC_TEMP.c_str(), payload.c_str())) {
      Serial.println("[KIRIM] " + payload);
    } else {
      appendToBuffer(payload); // WiFi / broker mati -> simpan, dikirim ulang nanti
    }
  }
}
