// ============================================================
// MQTT LOGGER - penyimpanan permanen buat dashboard Monitoring Gearbox
// ============================================================
// Fungsinya 3:
//   1. Nulis "state.json" - snapshot nilai TERAKHIR + 8 histori terbaru
//      tiap gearbox. File ini yang nanti "dibaca" oleh dashboard (JS_Monitoring.js)
//      begitu halaman dibuka/refresh.
//   2. Nulis log CSV harian per gearbox di folder "logs/" - ini rekam jejak
//      PERMANEN semua pembacaan sensor (bukan cuma 8 titik terakhir kayak
//      di dashboard). Nama file & kolom waktu pakai tanggal/jam WIB.
//   3. Mengompres CSV harian yang sudah lama (> 8 hari) jadi .csv.gz supaya folder
//      logs/ tidak membengkak (lihat csv_archive.js). File Excel untuk tombol
//      download di dashboard TIDAK lagi dibuat di sini: dibuat saat diklik oleh
//      server.js (lihat excel_worker.js).
//
// CARA PAKAI:
//   1. Install Node.js dulu kalau belum ada (https://nodejs.org, pilih versi LTS)
//   2. Buka folder ini di Command Prompt / PowerShell, jalankan:
//        npm install
//   3. Taruh file ini SATU FOLDER yang sama dengan index.html,
//      CSS_Monitoring.css, JS_Monitoring.js (folder yang di-serve oleh HFS)
//   4. Jalankan:
//        npm start          (sama dengan: node mqtt_logger.js)
//   5. Biarkan jendela ini tetap terbuka selama dashboard dipakai (sama
//      seperti broker Mosquitto - nanti bisa dibikin auto-jalan juga)
//
// Logger ini cuma boleh jalan SATU di satu waktu. Kalau dijalankan dua kali,
// yang kedua akan menolak jalan (lihat logger.lock) - dulu 2-3 logger yang jalan
// bareng bikin tiap pembacaan tercatat dobel/tripel di CSV.

const mqtt = require('mqtt');
const fs = require('fs');
const path = require('path');
const { compactOldCsv } = require('./csv_archive');
const { seedHistory } = require('./history_seed');
const { openDb, StatsWriter } = require('./db');
const { parseDeviceId } = require('./alarm_rules');

// ---- SESUAIKAN INI KALAU BEDA ----
// Mosquitto, logger ini, dan HFS jalan di PC yang sama -> cukup localhost.
const BROKER_URL = process.env.MQTT_URL || 'mqtt://localhost:1883';
const TOPIC_SUB  = 'pabrik/+/+/temp';           // wildcard, otomatis nangkep semua crane
const MAX_HISTORY = 10;                         // jumlah titik histori yang disimpan (samain sama dashboard)
const STATE_WRITE_INTERVAL = 30000;             // 30 detik - lihat catatan di bawah
const BACKLOG_DAYS = 7;
const CSV_KEEP_PLAIN_DAYS = 8;                  // CSV harian yang lebih tua dari ini dikompres (.csv.gz)
const CSV_COMPACT_INTERVAL = 6 * 60 * 60 * 1000;
// Timestamp dari ESP32 yang lebih tua dari ini (atau jauh di masa depan) dianggap
// jam ESP32-nya salah (mis. belum sinkron NTP, masih tahun 1970) -> pakai jam terima.
const MAX_BACKLOG_MS = BACKLOG_DAYS * 24 * 60 * 60 * 1000;
const MAX_CLOCK_AHEAD_MS = 5 * 60 * 1000;
const DB_FLUSH_INTERVAL = 30000;                // ringkasan per menit ditulis ke database tiap 30 detik
const DB_PRUNE_INTERVAL = 6 * 60 * 60 * 1000;   // bersihkan ringkasan per menit yang sudah > 90 hari
// -----------------------------------

const STATE_FILE  = path.join(__dirname, 'state.json');
const CSV_LOG_DIR = path.join(__dirname, 'logs');

const LOCK_FILE   = path.join(__dirname, 'logger.lock');

// ============================================================
// CEGAH LOGGER JALAN DOBEL
// ============================================================
const { isProcessAlive } = require('./common');

function acquireLock() {
    if (fs.existsSync(LOCK_FILE)) {
        const pid = parseInt(fs.readFileSync(LOCK_FILE, 'utf-8'), 10);
        if (pid && pid !== process.pid && isProcessAlive(pid)) {
            console.error(`[Logger] Logger lain sudah jalan (PID ${pid}). Tutup dulu jendela logger yang lama.`);
            console.error(`[Logger] Kalau yakin tidak ada logger lain yang jalan, hapus file ${LOCK_FILE} lalu coba lagi.`);
            process.exit(1);
        }
    }
    fs.writeFileSync(LOCK_FILE, String(process.pid));

    const release = () => {
        try {
            if (fs.readFileSync(LOCK_FILE, 'utf-8') === String(process.pid)) fs.unlinkSync(LOCK_FILE);
        } catch (e) { /* sudah terhapus */ }
    };
    process.on('exit', release);
    ['SIGINT', 'SIGTERM', 'SIGHUP'].forEach(sig => process.on(sig, () => process.exit(0)));
}

acquireLock();

// ============================================================
// WAKTU (WIB)
// ============================================================
const { WIB_OFFSET_MS } = require('./common');

// "2026-09-18T09:02:48.206+07:00" - tetap format ISO (bisa di-parse), tapi jamnya WIB
function toWibIso(ms) {
    return new Date(ms + WIB_OFFSET_MS).toISOString().replace('Z', '+07:00');
}

// Ambil waktu KEJADIAN dari payload ESP32 (field "timestamp") kalau ada & masuk akal.
// Ini yang bikin data backlog (dikirim ulang setelah ESP32 sempat offline) tetap
// tercatat sesuai jam kejadian aslinya. Terima ISO string atau epoch (detik/ms).
function resolveTimestamp(raw, receivedMs) {
    if (raw === undefined || raw === null || raw === '') return { ms: receivedMs, fromDevice: false };

    let ms;
    if (typeof raw === 'number' || /^\d+$/.test(String(raw))) {
        const n = Number(raw);
        ms = n < 1e12 ? n * 1000 : n; // < 1e12 berarti epoch dalam detik
    } else {
        ms = Date.parse(raw);
    }

    if (!Number.isFinite(ms) || ms > receivedMs + MAX_CLOCK_AHEAD_MS || ms < receivedMs - MAX_BACKLOG_MS) {
        console.warn(`[Logger] Timestamp dari ESP32 tidak masuk akal (${raw}), pakai jam terima.`);
        return { ms: receivedMs, fromDevice: false };
    }
    return { ms, fromDevice: true };
}

// ============================================================
// CEGAH BARIS DOBEL DI CSV
// ============================================================
// Pesan yang sama bisa sampai lebih dari sekali (ESP32 kirim ulang backlog, QoS
// retransmit). Kalau timestamp-nya dari ESP32, pembacaan dengan timestamp yang
// sama persis untuk gearbox yang sama cukup ditulis sekali.
const SEEN_LIMIT = 5000;           // ~7 jam data per gearbox (1 data / 5 detik)
const seenByCsv = new Map();       // csvPath -> Set(epoch ms)

function seedSeenFromCsv(csvPath) {
    const seen = new Set();
    if (fs.existsSync(csvPath)) {
        const lines = fs.readFileSync(csvPath, 'utf-8').split(/\r?\n/).slice(-SEEN_LIMIT);
        lines.forEach(line => {
            const ms = Date.parse(line.split(',')[0]);
            if (Number.isFinite(ms)) seen.add(ms);
        });
    }
    return seen;
}

function isDuplicate(csvPath, ms) {
    let seen = seenByCsv.get(csvPath);
    if (!seen) {
        seen = seedSeenFromCsv(csvPath);
        seenByCsv.set(csvPath, seen);
        // buang cache file hari-hari lama
        if (seenByCsv.size > 500) seenByCsv.delete(seenByCsv.keys().next().value);
    }
    if (seen.has(ms)) return true;
    seen.add(ms);
    if (seen.size > SEEN_LIMIT) seen.delete(seen.values().next().value);
    return false;
}

// ============================================================
// STATE
// ============================================================
let state = {};

// Kalau logger ini sendiri pernah mati & nyala lagi, jangan mulai dari kosong -
// lanjutkan dari state.json yang sudah ada (kalau ada).
if (fs.existsSync(STATE_FILE)) {
    try {
        state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
        console.log('[Logger] state.json lama ditemukan, melanjutkan dari situ.');
    } catch (e) {
        console.warn('[Logger] state.json lama rusak/tidak valid, mulai dari kosong.');
        state = {};
    }
}

if (!fs.existsSync(CSV_LOG_DIR)) fs.mkdirSync(CSV_LOG_DIR);

// Riwayat chart disusun ulang dari CSV hari ini (lihat history_seed.js): state.json bisa
// pendek/versi lama/tertinggal kalau logger sempat dimatikan paksa, CSV tidak.
const seededGearboxes = seedHistory({ logDir: CSV_LOG_DIR, state, maxHistory: MAX_HISTORY });
if (seededGearboxes) console.log(`[Logger] Riwayat chart disusun ulang dari CSV hari ini untuk ${seededGearboxes} gearbox`);

// ============================================================
// DATABASE (ringkasan per menit & per jam untuk laporan tren, lihat db.js)
// ============================================================
const db = openDb();
const stats = new StatsWriter(db);

function flushStats() {
    try {
        stats.flush();
    } catch (e) {
        console.error('[Logger] Gagal tulis ke database (dicoba lagi nanti):', e.message);
    }
}
setInterval(flushStats, DB_FLUSH_INTERVAL);
process.on('exit', flushStats); // sisa data di memori ikut tersimpan saat logger ditutup (Ctrl+C)

function pruneStats() {
    try {
        const removed = stats.prune();
        if (removed) console.log(`[Logger] ${removed} ringkasan per menit lama (> 90 hari) dihapus dari database`);
    } catch (e) {
        console.error('[Logger] Gagal membersihkan database:', e.message);
    }
}
pruneStats();
setInterval(pruneStats, DB_PRUNE_INTERVAL);

let stateIsDirty = false;


// ============================================================
// MQTT
// ============================================================
// Login broker pakai akun "logger" dari mqtt/credentials.json (dibuat: npm run setup-mqtt)
function loadCredentials() {
    try {
        const creds = JSON.parse(fs.readFileSync(path.join(__dirname, 'mqtt', 'credentials.json'), 'utf-8'));
        if (creds.logger) return { username: 'logger', password: creds.logger };
    } catch (e) { /* belum di-setup */ }
    console.warn('[Logger] mqtt/credentials.json belum ada - konek tanpa login. Jalankan: npm run setup-mqtt');
    return {};
}

console.log('[Logger] Menghubungkan ke broker:', BROKER_URL);
const client = mqtt.connect(BROKER_URL, {
    clientId: 'logger-' + Math.random().toString(16).slice(2, 8),
    reconnectPeriod: 3000,
    ...loadCredentials()
});

client.on('connect', () => {
    console.log('[Logger] Terhubung ke broker!');
    client.subscribe(TOPIC_SUB, (err) => {
        if (err) console.error('[Logger] Gagal subscribe:', err);
        else console.log('[Logger] Subscribe topik:', TOPIC_SUB);
    });
});

client.on('reconnect', () => console.log('[Logger] Reconnecting ke broker...'));
client.on('error', (err) => {
    if ([4, 5, 134, 135].includes(err.code)) {
        console.error('[Logger] Login ke broker DITOLAK. Cek mqtt/credentials.json & mqtt/passwd (npm run setup-mqtt), lalu restart Mosquitto.');
    } else {
        console.error('[Logger] MQTT error:', err.message);
    }
});

client.on('message', (topic, payloadBuffer) => {
    let data;
    try {
        data = JSON.parse(payloadBuffer.toString());
    } catch (e) {
        console.warn('[Logger] Payload bukan JSON valid dari topik', topic);
        return;
    }
    if (!data.crane_id || !data.temps) return;

    // Broker cuma mengizinkan tiap ESP32 kirim ke topiknya sendiri (mqtt/acl).
    // crane_id di dalam payload harus cocok dengan crane di topik itu, kalau tidak, ESP32
    // crane-01 bisa "mengaku" sebagai crane lain lewat isi pesannya. Segmen topik = ID
    // perangkat: "crane-01" atau "crane-01_2" (ESP tambahan crane-01) -> cranenya sama-sama
    // crane-01. Data dari semua ESP32 satu crane digabung di sini (CSV/state per crane+motor).
    const fromTopic = parseDeviceId(topic.split('/')[2]);
    const topicCraneId = fromTopic ? fromTopic.craneId : null;
    if (data.crane_id !== topicCraneId) {
        console.warn(`[Logger] crane_id "${data.crane_id}" tidak cocok dengan topik ${topic}, pesan diabaikan.`);
        return;
    }

    const { ms, fromDevice } = resolveTimestamp(data.timestamp, Date.now());
    const isoWib = toWibIso(ms);
    const dateStr = isoWib.slice(0, 10);                  // tanggal WIB: YYYY-MM-DD
    const timeLabel = isoWib.slice(11, 16).replace(':', '.'); // "17.01", sama dgn format dashboard

    if (!state[data.crane_id]) state[data.crane_id] = {};

    let written = 0;
    Object.entries(data.temps).forEach(([gbKey, tempVal]) => {
        // --- Log CSV permanen, 1 file per gearbox per hari (WIB) ---
        // Nilai mentah tetap dicatat apa adanya (termasuk nilai error sensor),
        // penilaian valid/tidaknya dilakukan di dashboard & Excel.
        const csvPath = path.join(CSV_LOG_DIR, `${data.crane_id}_${gbKey}_${dateStr}.csv`);
        if (fromDevice && isDuplicate(csvPath, ms)) return;

        if (!fs.existsSync(csvPath)) {
            fs.writeFileSync(csvPath, 'timestamp,suhu_celsius\n');
        }
        fs.appendFileSync(csvPath, `${isoWib},${tempVal}\n`);
        stats.add(data.crane_id, gbKey, ms, tempVal);
        written++;

        // --- State untuk dashboard: hanya maju ke depan ---
        // Data backlog (lebih tua dari yang sudah ada) tetap masuk CSV di atas,
        // tapi tidak boleh menimpa "nilai terakhir" dengan nilai lama.
        if (!state[data.crane_id][gbKey]) {
            state[data.crane_id][gbKey] = { temp: null, history: [] };
        }
        const gbState = state[data.crane_id][gbKey];
        const lastMs = gbState.lastUpdated ? Date.parse(gbState.lastUpdated) : NaN;
        if (Number.isFinite(lastMs) && ms < lastMs) return;

        gbState.temp = tempVal;
        gbState.lastUpdated = new Date(ms).toISOString();
        // 1 titik per MENIT (nilai terakhir menit itu) - sama dengan yang dicatat dashboard.
        // Dulu tiap pesan (5 detik) jadi satu titik, jadi 8 titik cuma ~40 detik data dan
        // label jamnya kembar di chart setelah halaman dibuka ulang.
        const lastPoint = gbState.history[gbState.history.length - 1];
        if (lastPoint && lastPoint.time === timeLabel) lastPoint.temp = tempVal;
        else gbState.history.push({ time: timeLabel, temp: tempVal });
        if (gbState.history.length > MAX_HISTORY) gbState.history.shift();
    });

    if (written === 0) {
        console.log(`[Logger] Pesan dobel dari ${data.crane_id} (${isoWib}) diabaikan.`);
        return;
    }

    stateIsDirty = true;          // tandain ada perubahan baru, biar interval di bawah yang nulis filenya

    console.log(`[Logger] Data diterima & disimpan - ${data.crane_id}: ${Object.keys(data.temps).join(', ')}`);
});

// PENTING: state.json SENGAJA cuma ditulis ke disk tiap STATE_WRITE_INTERVAL (bukan tiap
// pesan MQTT masuk). Kalau ditulis tiap 5 detik, aplikasi semacam VS Code Live Server yang
// auto-reload begitu ada file berubah akan reload TOTAL halaman dashboard tiap 5 detik juga -
// itu yang bikin "keluar sendiri". Data di memori (variabel `state`) tetap selalu paling baru;
// cuma penulisan ke FILE-nya yang dijarangin.
setInterval(() => {
    if (!stateIsDirty) return; // nggak ada perubahan baru, nggak usah nulis ulang
    stateIsDirty = false;

    fs.writeFile(STATE_FILE, JSON.stringify(state, null, 2), (err) => {
        if (err) console.error('[Logger] Gagal nulis state.json:', err.message);
        else console.log('[Logger] state.json diperbarui (snapshot berkala)');
    });
}, STATE_WRITE_INTERVAL);

// ============================================================
// ARSIP CSV: kompres file harian yang sudah lama
// ============================================================
// CSV mentah ~75 MB/hari untuk 25 crane. Yang lebih tua dari CSV_KEEP_PLAIN_DAYS hari tidak
// akan ditulisi lagi (data backlog ESP32 maksimal 7 hari), jadi aman dikompres jadi .csv.gz
// (~10x lebih kecil). Isinya tetap utuh & bisa dibaca ulang oleh npm run db-import.
async function compactCsv() {
    try {
        const r = await compactOldCsv({ logDir: CSV_LOG_DIR, olderThanDays: CSV_KEEP_PLAIN_DAYS });
        if (r.compressed) console.log(`[Logger] ${r.compressed} file CSV lama dikompres, hemat ${(r.savedBytes / 1048576).toFixed(1)} MB`);
    } catch (e) {
        console.error('[Logger] Gagal mengompres CSV lama:', e.message);
    }
}
setTimeout(compactCsv, 60 * 1000); // 1 menit setelah nyala, supaya tidak bersaing dengan start-up
setInterval(compactCsv, CSV_COMPACT_INTERVAL);
