// ============================================================
// SIMULATOR ESP32 - kirim data suhu palsu ke broker, KHUSUS UNTUK TES
// ============================================================
// Meniru firmware GBXMQTT.ino versi 2 (folder firmware/):
//   pabrik/<area>/<crane>/temp    tiap 5 detik:
//       {"crane_id":"crane-01","plant":"TWB","timestamp":"2026-09-20T10:00:05+07:00",
//        "temps":{"m1":55.2,...,"m4":null},"faults":{"m4":"0x80"}}
//   pabrik/<area>/<crane>/status  saat tersambung (retained):
//       {"online":true,"fw":"2.0.0","ip":"...","rssi":-60,...}
//   Last Will (dikirim BROKER kalau simulator mati mendadak): {"online":false}
//
// CARA PAKAI:
//     npm run simulate                              -> crane-01, 5 motor normal
//     node simulate_esp32.js --error m4             -> m4 fault MAX31865 (null + kode fault)
//     node simulate_esp32.js --dingin m2            -> m2 terbaca ~5 °C (alarm suhu rendah)
//     node simulate_esp32.js --mati m5              -> m5 tidak dikirim (jadi offline)
//     node simulate_esp32.js --crane crane-02 --area cbk   -> crane lain (uji deteksi perangkat baru)
//     node simulate_esp32.js --motor 6              -> kirim m1..m6 (uji motor baru)
//
// LEBIH DARI 1 ESP32 PER CRANE (jalankan di jendela terpisah, crane yang sama):
//     node simulate_esp32.js --crane crane-30 --motor 3                         -> ESP utama: m1..m3, topik pabrik/ccc/crane-30/...
//     node simulate_esp32.js --crane crane-30 --node 2 --motor-awal 4 --motor 2 -> ESP ke-2: m4..m5, topik pabrik/ccc/crane-30_2/...
//   --node N        nomor ESP di crane itu (1 = utama). N >= 2 -> ID perangkat "<crane>_N"
//   --motor-awal K  nomor motor sensor pertama ESP ini (bawaan 1). Nomor motor antar ESP
//                   dalam satu crane TIDAK boleh sama - dashboard menandainya "bentrok".
//
// m3 sengaja dibuat naik-turun pelan 55 -> 88 °C (siklus 10 menit) supaya
// status warning & danger ikut kelihatan di dashboard.
//
// Tutup dengan Ctrl+C = "dimatikan dengan sopan" (kirim status offline).
// Untuk menguji Last Will, matikan paksa prosesnya (mis. tutup jendelanya).
//
// INGAT: data simulasi ikut tercatat di logs/, state.json, excel/, dan database
// oleh mqtt_logger.js. Hapus sebelum dipakai dengan sensor asli.

const mqtt = require('mqtt');
const fs = require('fs');
const path = require('path');

function arg(name, fallback) {
    const i = process.argv.indexOf(`--${name}`);
    return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const BROKER_URL = arg('broker', 'mqtt://localhost:1883');
const CRANE_ID = arg('crane', 'crane-30',);
const AREA = arg('area', 'ccc');
const ERROR_GB = arg('error', null);
const COLD_GB = arg('dingin', null);
const DEAD_GB = arg('mati', null);
const GB_COUNT = Number(arg('motor', arg('gearbox', 5)));
const NODE = Number(arg('node', 1));
const MOTOR_START = Number(arg('motor-awal', 1));
// ID perangkat = ID crane untuk ESP utama, "<crane>_<node>" untuk ESP tambahan (sama dengan firmware)
const DEVICE_ID = NODE > 1 ? `${CRANE_ID}_${NODE}` : CRANE_ID;
const INTERVAL_MS = 5000;
const TOPIC = `pabrik/${AREA}/${DEVICE_ID}/temp`;
const STATUS_TOPIC = `pabrik/${AREA}/${DEVICE_ID}/status`;
const FW_VERSION = '2.0.0-sim';

const gearboxes = Array.from({ length: GB_COUNT }, (_, i) => `m${MOTOR_START + i}`);
const temps = {};
gearboxes.forEach((gb, i) => { temps[gb] = 48 + (i * 3) % 12; });
const startMs = Date.now();

// Sama seperti firmware: jam WIB dengan zona waktu (+07:00)
function timestampWib() {
    return new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(0, 19) + '+07:00';
}

function nextReading() {
    const out = {};
    const faults = {};
    gearboxes.forEach(gb => {
        if (gb === DEAD_GB) return;
        if (gb === ERROR_GB) {
            out[gb] = null;          // firmware v2 kirim null kalau MAX31865 melaporkan fault
            faults[gb] = '0x80';     // RTD high threshold (umumnya kabel PT100 putus)
            return;
        }
        if (gb === COLD_GB) {
            temps[gb] = 5 + (Math.random() - 0.5);
        } else if (gb === 'm3') {
            const phase = ((Date.now() - startMs) / 600000) * 2 * Math.PI; // siklus 10 menit
            temps[gb] = 71.5 - 16.5 * Math.cos(phase) + (Math.random() - 0.5);
        } else {
            temps[gb] += (Math.random() - 0.5) * 0.8; // jalan acak pelan di sekitar 45-65 °C
            temps[gb] = Math.min(65, Math.max(45, temps[gb]));
        }
        out[gb] = Math.round(temps[gb] * 10) / 10;
    });
    return { out, faults };
}

// Login seperti ESP32 asli: username = ID perangkat, password dari mqtt/credentials.json
function loadCredentials() {
    try {
        const creds = JSON.parse(fs.readFileSync(path.join(__dirname, 'mqtt', 'credentials.json'), 'utf-8'));
        if (creds[DEVICE_ID]) return { username: DEVICE_ID, password: creds[DEVICE_ID] };
    } catch (e) { /* belum di-setup */ }
    return {};
}

const client = mqtt.connect(BROKER_URL, {
    clientId: `ESP32-${DEVICE_ID}-sim`,   // wajib unik per alat - 2 ESP32 dengan Client ID sama saling menendang
    reconnectPeriod: 3000,
    ...loadCredentials(),
    will: { topic: STATUS_TOPIC, payload: JSON.stringify({ online: false }), qos: 1, retain: true }
});

client.on('connect', () => {
    console.log(`[Sim] Terhubung ke ${BROKER_URL}, kirim ke ${TOPIC} tiap ${INTERVAL_MS / 1000} detik. Ctrl+C untuk berhenti.`);
    client.publish(STATUS_TOPIC, JSON.stringify({
        online: true, fw: FW_VERSION, ip: '127.0.0.1', mac: `SIMULATOR-${NODE}`, rssi: -55,
        node: NODE, sensors: gearboxes.length, keys: gearboxes.join(','), uptime_s: Math.round((Date.now() - startMs) / 1000), buffer_bytes: 0
    }), { qos: 1, retain: true });
});
client.on('error', err => console.error('[Sim] MQTT error:', err.message));

setInterval(() => {
    if (!client.connected) return;
    const { out, faults } = nextReading();
    const payload = { crane_id: CRANE_ID, plant: AREA.toUpperCase(), timestamp: timestampWib(), temps: out };
    if (Object.keys(faults).length) payload.faults = faults;
    client.publish(TOPIC, JSON.stringify(payload));
    console.log('[Sim]', JSON.stringify(out));
}, INTERVAL_MS);

// Berhenti dengan sopan: kabari broker dulu bahwa perangkat offline
process.on('SIGINT', () => {
    client.publish(STATUS_TOPIC, JSON.stringify({ online: false, reason: 'shutdown' }), { qos: 1, retain: true }, () => {
        client.end(false, () => process.exit(0));
    });
    setTimeout(() => process.exit(0), 1500);
});
