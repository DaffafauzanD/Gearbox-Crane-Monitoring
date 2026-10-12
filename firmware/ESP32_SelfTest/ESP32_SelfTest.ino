/*
 * ESP32 Self-Test — uji fungsional board ESP32 (ESP32-32U / WROOM-32U)
 *
 * Cara pakai:
 *   1. Lepas SEMUA kabel dari pin header (kecuali USB) agar tes GPIO valid.
 *   2. Pastikan antena eksternal terpasang ke konektor U.FL (wajib untuk ESP32-32U).
 *   3. Board: "ESP32 Dev Module", Partition Scheme: "Huge APP (3MB No OTA/1MB SPIFFS)".
 *   4. Upload, buka Serial Monitor 115200 baud, lalu tekan tombol EN untuk mengulang tes.
 *   5. Saat diminta, tekan tombol BOOT untuk menguji tombol.
 */

#include <WiFi.h>
#include <Preferences.h>
#include <BLEDevice.h>
#include <BLEScan.h>

static int passCount = 0, failCount = 0, warnCount = 0;

static void result(const char *name, bool ok, const String &detail = "") {
  Serial.printf("  [%s] %s", ok ? "PASS" : "FAIL", name);
  if (detail.length()) Serial.printf("  -> %s", detail.c_str());
  Serial.println();
  ok ? passCount++ : failCount++;
}

static void warn(const char *name, const String &detail) {
  Serial.printf("  [WARN] %s  -> %s\n", name, detail.c_str());
  warnCount++;
}

static void header(const char *title) {
  Serial.printf("\n=== %s ===\n", title);
}

// ---------- 1. Info chip ----------
static void testChipInfo() {
  header("1. Info Chip");
  uint64_t mac = ESP.getEfuseMac();
  Serial.printf("  Model       : %s rev %d\n", ESP.getChipModel(), ESP.getChipRevision());
  Serial.printf("  Core        : %d @ %lu MHz\n", ESP.getChipCores(), (unsigned long)ESP.getCpuFreqMHz());
  Serial.printf("  MAC (eFuse) : %02X:%02X:%02X:%02X:%02X:%02X\n",
                (uint8_t)(mac), (uint8_t)(mac >> 8), (uint8_t)(mac >> 16),
                (uint8_t)(mac >> 24), (uint8_t)(mac >> 32), (uint8_t)(mac >> 40));
  Serial.printf("  Flash       : %lu MB @ %lu MHz\n",
                (unsigned long)(ESP.getFlashChipSize() / (1024 * 1024)),
                (unsigned long)(ESP.getFlashChipSpeed() / 1000000));
  Serial.printf("  PSRAM       : %s\n", psramFound() ? String(ESP.getPsramSize() / 1024).c_str() : "tidak ada (normal untuk WROOM)");
  Serial.printf("  SDK         : %s\n", ESP.getSdkVersion());

  result("Chip terbaca & dual-core", ESP.getChipCores() == 2);
  result("MAC eFuse valid", mac != 0 && mac != 0xFFFFFFFFFFFFULL);
  result("Ukuran flash >= 4MB", ESP.getFlashChipSize() >= 4 * 1024 * 1024,
         String(ESP.getFlashChipSize() / 1024) + " KB");
}

// ---------- 2. RAM ----------
static void testRam() {
  header("2. RAM (heap)");
  Serial.printf("  Heap total/bebas : %lu / %lu byte\n",
                (unsigned long)ESP.getHeapSize(), (unsigned long)ESP.getFreeHeap());
  Serial.printf("  Blok terbesar    : %lu byte\n", (unsigned long)ESP.getMaxAllocHeap());

  const size_t N = 64 * 1024;
  uint32_t *buf = (uint32_t *)malloc(N);
  if (!buf) { result("Alokasi 64KB", false); return; }
  bool ok = true;
  const uint32_t patterns[] = {0x00000000, 0xFFFFFFFF, 0xAAAAAAAA, 0x55555555};
  for (uint32_t p : patterns) {
    for (size_t i = 0; i < N / 4; i++) buf[i] = p ^ i;
    for (size_t i = 0; i < N / 4; i++) if (buf[i] != (p ^ i)) { ok = false; break; }
    if (!ok) break;
  }
  free(buf);
  result("Tulis/baca pola RAM 64KB", ok);
}

// ---------- 3. Flash / NVS ----------
static void testFlash() {
  header("3. Flash (NVS + baca sketch)");
  Preferences prefs;
  bool opened = prefs.begin("selftest", false);
  result("Buka NVS", opened);
  if (opened) {
    uint32_t boots = prefs.getUInt("boots", 0) + 1;
    prefs.putUInt("boots", boots);
    uint32_t rnd = esp_random();
    prefs.putUInt("rnd", rnd);
    bool ok = prefs.getUInt("rnd", 0) == rnd && prefs.getUInt("boots", 0) == boots;
    prefs.end();
    result("Tulis/baca NVS", ok, "boot ke-" + String(boots));
  }
  uint32_t t0 = millis();
  String md5 = ESP.getSketchMD5();   // membaca seluruh firmware dari flash
  result("Baca seluruh firmware dari flash", md5.length() == 32,
         "MD5 " + md5 + " (" + String(millis() - t0) + " ms)");
}

// ---------- 4. CPU dual-core ----------
static volatile uint32_t coreResult[2];
static volatile bool coreDone[2];

static void coreTask(void *arg) {
  int id = (int)(intptr_t)arg;
  uint32_t x = 0;
  for (uint32_t i = 0; i < 2000000; i++) x = x * 1103515245u + 12345u + i;
  coreResult[id] = x;
  coreDone[id] = true;
  vTaskDelete(NULL);
}

static void testCpu() {
  header("4. CPU (kedua core)");
  coreDone[0] = coreDone[1] = false;
  uint32_t t0 = millis();
  xTaskCreatePinnedToCore(coreTask, "c0", 4096, (void *)0, 1, NULL, 0);
  xTaskCreatePinnedToCore(coreTask, "c1", 4096, (void *)1, 1, NULL, 1);
  while ((!coreDone[0] || !coreDone[1]) && millis() - t0 < 5000) delay(10);
  bool ok = coreDone[0] && coreDone[1] && coreResult[0] == coreResult[1];
  result("Core 0 & Core 1 menghitung hasil sama", ok, String(millis() - t0) + " ms");
}

// ---------- 5. GPIO ----------
// Hanya pin output-capable yang aman diuji. GPIO 0 (BOOT), 1/3 (USB serial),
// 2 (LED/strap), 6-11 (flash internal) dilewati. 34-39 input-only tanpa pull.
static const uint8_t gpioPins[] = {4, 5, 12, 13, 14, 15, 16, 17, 18, 19, 21, 22, 23, 25, 26, 27, 32, 33};

static void testGpio() {
  header("5. GPIO (pull-up / pull-down internal + short antar pin)");
  String bad;
  for (uint8_t p : gpioPins) {
    pinMode(p, INPUT_PULLUP);   delayMicroseconds(200); int hi = digitalRead(p);
    pinMode(p, INPUT_PULLDOWN); delayMicroseconds(200); int lo = digitalRead(p);
    pinMode(p, INPUT);
    if (hi != 1 || lo != 0) bad += String(p) + "(H=" + hi + ",L=" + lo + ") ";
  }
  result("Semua GPIO merespons pull-up/down", bad.isEmpty(),
         bad.isEmpty() ? String(sizeof(gpioPins)) + " pin OK" : "bermasalah: " + bad);

  // Cek short antar pin: satu pin di-drive LOW, sisanya pull-up harus tetap HIGH
  String shorts;
  for (uint8_t a : gpioPins) {
    for (uint8_t b : gpioPins) if (b != a) pinMode(b, INPUT_PULLUP);
    pinMode(a, OUTPUT); digitalWrite(a, LOW);
    delayMicroseconds(200);
    for (uint8_t b : gpioPins) if (b != a && digitalRead(b) == LOW) shorts += String(a) + "-" + String(b) + " ";
    pinMode(a, INPUT);
  }
  for (uint8_t p : gpioPins) pinMode(p, INPUT);
  result("Tidak ada short antar pin", shorts.isEmpty(), shorts.isEmpty() ? "" : shorts);
}

// ---------- 6. ADC ----------
static void testAdc() {
  header("6. ADC");
  analogReadResolution(12);
  // Pin mengambang + pull-down -> nilai mendekati 0; pull-up -> mendekati 4095
  pinMode(32, INPUT_PULLUP);   delay(5); int hi = analogRead(32);
  pinMode(32, INPUT_PULLDOWN); delay(5); int lo = analogRead(32);
  pinMode(32, INPUT);
  result("ADC GPIO32 merespons (pull-up vs pull-down)", hi > 3000 && lo < 1000,
         "pull-up=" + String(hi) + ", pull-down=" + String(lo));
}

// ---------- 7. WiFi ----------
static void testWifi() {
  header("7. WiFi (radio + antena)");
  WiFi.mode(WIFI_STA);
  WiFi.disconnect();
  delay(100);
  Serial.printf("  MAC WiFi : %s\n", WiFi.macAddress().c_str());
  int n = WiFi.scanNetworks();
  if (n < 0) { result("Scan WiFi", false, "error " + String(n)); return; }
  int best = -127;
  for (int i = 0; i < n && i < 10; i++) {
    Serial.printf("    %2d. %-28s ch%2ld  %4ld dBm\n", i + 1, WiFi.SSID(i).c_str(),
                  (long)WiFi.channel(i), (long)WiFi.RSSI(i));
    if (WiFi.RSSI(i) > best) best = WiFi.RSSI(i);
  }
  result("Scan WiFi menemukan jaringan", n > 0, String(n) + " jaringan, terkuat " + String(best) + " dBm");
  if (n > 0 && best < -80) warn("Sinyal lemah", "cek antena/konektor U.FL");
  WiFi.scanDelete();
  WiFi.mode(WIFI_OFF);
}

// ---------- 8. Bluetooth LE ----------
static void testBle() {
  header("8. Bluetooth LE");
  BLEDevice::init("ESP32-SelfTest");
  Serial.printf("  MAC BT   : %s\n", BLEDevice::getAddress().toString().c_str());
  BLEScan *scan = BLEDevice::getScan();
  scan->setActiveScan(true);
  BLEScanResults *res = scan->start(5, false);
  int n = res ? res->getCount() : 0;
  result("Stack BLE berjalan", true);
  if (n > 0) result("Scan BLE menemukan perangkat", true, String(n) + " perangkat");
  else warn("Scan BLE 0 perangkat", "radio OK, tapi tidak ada perangkat BLE di sekitar (nyalakan BT HP untuk uji)");
  scan->clearResults();
  BLEDevice::deinit(false);
}

// ---------- 9. Tombol BOOT ----------
static void testBootButton() {
  header("9. Tombol BOOT (GPIO0)");
  pinMode(0, INPUT_PULLUP);
  Serial.println("  >>> Tekan tombol BOOT dalam 10 detik ...");
  uint32_t t0 = millis();
  bool pressed = false;
  while (millis() - t0 < 10000) {
    if (digitalRead(0) == LOW) { pressed = true; break; }
    delay(10);
  }
  if (pressed) result("Tombol BOOT terdeteksi", true);
  else warn("Tombol BOOT tidak ditekan", "dilewati");
}

void setup() {
  Serial.begin(115200);
  delay(1500);
  Serial.println("\n\n##########################################");
  Serial.println("#        ESP32 SELF-TEST FUNGSIONAL      #");
  Serial.println("##########################################");

  testChipInfo();
  testRam();
  testFlash();
  testCpu();
  testGpio();
  testAdc();
  testWifi();
  testBle();
  testBootButton();

  Serial.println("\n==========================================");
  Serial.printf("  HASIL: %d PASS, %d FAIL, %d WARN\n", passCount, failCount, warnCount);
  Serial.println(failCount == 0 ? "  >>> BOARD ESP32 BERFUNGSI DENGAN BAIK <<<"
                                : "  >>> ADA TES GAGAL, lihat detail di atas <<<");
  Serial.println("  Tekan tombol EN untuk mengulang tes.");
  Serial.println("==========================================");
}

void loop() {
  delay(1000);
}
