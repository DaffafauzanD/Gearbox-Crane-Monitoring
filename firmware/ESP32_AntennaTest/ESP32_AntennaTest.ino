/*
 * ESP32 Antenna Test — bandingkan kekuatan sinyal WiFi DENGAN vs TANPA antena
 *
 * Memakai PASSIVE scan: ESP32 hanya mendengarkan beacon dari router, tidak
 * memancarkan apa pun, sehingga aman saat antena dilepas.
 *
 * Buka Serial Monitor 115200 baud, line ending bebas, lalu ketik perintah:
 *   a  = ukur & simpan sebagai "DENGAN antena"
 *   b  = ukur & simpan sebagai "TANPA antena"
 *   c  = tampilkan perbandingan a vs b
 *   m  = monitor live RSSI router terkuat (ketik huruf apa saja untuk berhenti)
 *   s  = scan sekali (tanpa disimpan)
 *
 * Tips: jangan pindahkan posisi board di antara pengukuran a dan b.
 * Lepas/pasang antena di ulir SMA, bukan di konektor U.FL (U.FL hanya tahan ~30x cabut-pasang).
 */

#include <WiFi.h>

static const int ROUNDS = 5;          // jumlah scan per pengukuran (dirata-rata)
static const int MAX_AP = 40;
static const uint32_t MS_PER_CHAN = 250;

struct ApStat {
  uint8_t bssid[6];
  char ssid[33];
  int channel;
  long sum;
  int hits;
  int best;
};

struct Measurement {
  ApStat ap[MAX_AP];
  int count = 0;
  bool valid = false;
};

static Measurement withAnt, withoutAnt;

static int findAp(Measurement &m, const uint8_t *bssid) {
  for (int i = 0; i < m.count; i++)
    if (memcmp(m.ap[i].bssid, bssid, 6) == 0) return i;
  return -1;
}

static float avgRssi(const ApStat &a) { return a.hits ? (float)a.sum / a.hits : -127; }

static const char *quality(float rssi) {
  if (rssi >= -50) return "sangat baik";
  if (rssi >= -67) return "baik";
  if (rssi >= -75) return "cukup";
  if (rssi >= -85) return "lemah";
  return "sangat lemah";
}

static String bar(float rssi) {
  int n = constrain((int)((rssi + 100) / 2.5), 0, 28);   // -100 dBm = 0, -30 dBm = 28
  String s;
  for (int i = 0; i < n; i++) s += '#';
  for (int i = n; i < 28; i++) s += '.';
  return s;
}

static int passiveScan() {
  return WiFi.scanNetworks(false, true, true, MS_PER_CHAN);
}

static void measure(Measurement &m, const char *label) {
  m.count = 0;
  Serial.printf("\nMengukur \"%s\" (%d kali passive scan, ~%d detik)...\n",
                label, ROUNDS, ROUNDS * 4);
  for (int r = 0; r < ROUNDS; r++) {
    int n = passiveScan();
    Serial.printf("  scan %d/%d: %d jaringan\n", r + 1, ROUNDS, n < 0 ? 0 : n);
    for (int i = 0; i < n; i++) {
      const uint8_t *b = WiFi.BSSID(i);
      int idx = findAp(m, b);
      if (idx < 0) {
        if (m.count >= MAX_AP) continue;
        idx = m.count++;
        ApStat &a = m.ap[idx];
        memcpy(a.bssid, b, 6);
        String ss = WiFi.SSID(i);
        if (ss.isEmpty()) ss = "<tersembunyi>";
        strlcpy(a.ssid, ss.c_str(), sizeof(a.ssid));
        a.channel = WiFi.channel(i);
        a.sum = 0; a.hits = 0; a.best = -127;
      }
      ApStat &a = m.ap[idx];
      int rssi = WiFi.RSSI(i);
      a.sum += rssi; a.hits++;
      if (rssi > a.best) a.best = rssi;
    }
    WiFi.scanDelete();
  }
  m.valid = true;

  // urutkan dari sinyal terkuat
  for (int i = 0; i < m.count; i++)
    for (int j = i + 1; j < m.count; j++)
      if (avgRssi(m.ap[j]) > avgRssi(m.ap[i])) { ApStat t = m.ap[i]; m.ap[i] = m.ap[j]; m.ap[j] = t; }

  Serial.printf("\nHasil \"%s\": %d jaringan terdeteksi\n", label, m.count);
  Serial.println("  SSID                          ch   rata2  terbaik  terlihat  kualitas");
  for (int i = 0; i < m.count; i++) {
    ApStat &a = m.ap[i];
    Serial.printf("  %-28.28s %3d  %5.1f   %4d     %d/%d     %s\n", a.ssid, a.channel,
                  avgRssi(a), a.best, a.hits, ROUNDS, quality(avgRssi(a)));
  }
}

static void compare() {
  if (!withAnt.valid || !withoutAnt.valid) {
    Serial.println("\nBelum lengkap. Jalankan 'a' (dengan antena) dan 'b' (tanpa antena) dulu.");
    return;
  }
  Serial.println("\n================ PERBANDINGAN ANTENA ================");
  Serial.println("  SSID                          DENGAN   TANPA   SELISIH");
  float sumDelta = 0;
  int both = 0, lost = 0;
  for (int i = 0; i < withAnt.count; i++) {
    ApStat &a = withAnt.ap[i];
    int j = findAp(withoutAnt, a.bssid);
    if (j >= 0) {
      float d = avgRssi(a) - avgRssi(withoutAnt.ap[j]);
      Serial.printf("  %-28.28s %6.1f  %6.1f   %+5.1f dB\n", a.ssid, avgRssi(a), avgRssi(withoutAnt.ap[j]), d);
      sumDelta += d; both++;
    } else {
      Serial.printf("  %-28.28s %6.1f   ----    hilang tanpa antena\n", a.ssid, avgRssi(a));
      lost++;
    }
  }
  int onlyB = 0;
  for (int j = 0; j < withoutAnt.count; j++)
    if (findAp(withAnt, withoutAnt.ap[j].bssid) < 0) onlyB++;

  Serial.println("-----------------------------------------------------");
  Serial.printf("  Jaringan terlihat  : DENGAN antena %d, TANPA antena %d\n", withAnt.count, withoutAnt.count);
  Serial.printf("  Hilang tanpa antena: %d jaringan\n", lost);
  if (onlyB) Serial.printf("  Hanya muncul tanpa antena: %d (fluktuasi normal)\n", onlyB);
  if (both) {
    float avg = sumDelta / both;
    Serial.printf("  Rata-rata penguatan antena: %+.1f dB (dari %d jaringan yang sama)\n", avg, both);
    if (avg >= 15)      Serial.println("  >>> Antena & konektor BEKERJA BAIK (penguatan besar, sesuai harapan)");
    else if (avg >= 6)  Serial.println("  >>> Antena bekerja, tapi penguatan kurang dari biasanya - cek kekencangan SMA/U.FL");
    else                Serial.println("  >>> Hampir tidak ada perbedaan - curigai antena/pigtail/U.FL rusak atau tidak terpasang");
  } else {
    Serial.println("  Tidak ada jaringan yang sama untuk dibandingkan.");
    if (withAnt.count > 0 && withoutAnt.count == 0)
      Serial.println("  >>> Tanpa antena radio buta total - antena jelas berfungsi.");
  }
  Serial.println("=====================================================");
}

static void liveMonitor() {
  Serial.println("\nMencari router terkuat...");
  int n = passiveScan();
  if (n <= 0) { Serial.println("Tidak ada jaringan."); WiFi.scanDelete(); return; }
  int best = 0;
  for (int i = 1; i < n; i++) if (WiFi.RSSI(i) > WiFi.RSSI(best)) best = i;
  uint8_t bssid[6];
  memcpy(bssid, WiFi.BSSID(best), 6);
  String ssid = WiFi.SSID(best);
  int ch = WiFi.channel(best);
  WiFi.scanDelete();

  Serial.printf("Monitor \"%s\" ch%d. Cabut/pasang antena sambil melihat angka.\n", ssid.c_str(), ch);
  Serial.println("Ketik huruf apa saja + Enter untuk berhenti.\n");
  while (Serial.available()) Serial.read();
  while (!Serial.available()) {
    // passive scan hanya di satu channel & satu BSSID -> cepat (~0.3 detik)
    int k = WiFi.scanNetworks(false, true, true, 300, ch, nullptr, bssid);
    if (k > 0) {
      float r = WiFi.RSSI(0);
      Serial.printf("  %6lus  %4.0f dBm  [%s]  %s\n", millis() / 1000, r, bar(r).c_str(), quality(r));
    } else {
      Serial.printf("  %6lus   ---- dBm  [%s]  tidak terdengar\n", millis() / 1000, bar(-127).c_str());
    }
    WiFi.scanDelete();
    delay(200);
  }
  while (Serial.available()) Serial.read();
  Serial.println("Monitor berhenti.");
}

static void menu() {
  Serial.println("\n---------------- ESP32 ANTENNA TEST ----------------");
  Serial.println("  a = ukur DENGAN antena     b = ukur TANPA antena");
  Serial.println("  c = bandingkan a vs b      m = monitor live RSSI");
  Serial.println("  s = scan sekali");
  Serial.print("Perintah > ");
}

void setup() {
  Serial.begin(115200);
  delay(1500);
  WiFi.mode(WIFI_STA);
  WiFi.disconnect();
  Serial.printf("\nMAC WiFi: %s\n", WiFi.macAddress().c_str());
  menu();
}

void loop() {
  if (!Serial.available()) { delay(20); return; }
  char c = tolower(Serial.read());
  if (c == '\r' || c == '\n' || c == ' ') return;
  Serial.println(c);
  switch (c) {
    case 'a': measure(withAnt, "DENGAN antena"); break;
    case 'b': measure(withoutAnt, "TANPA antena"); break;
    case 'c': compare(); break;
    case 'm': liveMonitor(); break;
    case 's': { Measurement tmp; measure(tmp, "scan sekali"); break; }
    default: Serial.println("Perintah tidak dikenal.");
  }
  menu();
}
