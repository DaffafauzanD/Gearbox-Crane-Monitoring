// ============================================================
// SIMULATOR ESP32 - kirim data suhu palsu ke broker, KHUSUS UNTUK TES
// ============================================================
// Meniru firmware GBXMQTT.ino versi 2 (folder firmware/):
//   pabrik/<area>/<crane>/temp    tiap 5 detik:
//       {"crane_id":"crane-01","plant":"TWB","timestamp":"2026-09-20T10:00:05+07:00",
//        "temps":{"gb01":55.2,...,"gb04":null},"faults":{"gb04":"0x80"}}
//   pabrik/<area>/<crane>/status  saat tersambung (retained):
//       {"online":true,"fw":"2.0.0","ip":"...","rssi":-60,...}
//   Last Will (dikirim BROKER kalau simulator mati mendadak): {"online":false}
//
// CARA PAKAI:
//     npm run simulate                              -> crane-01, 5 gearbox normal
//     node simulate_esp32.js --error gb04           -> gb04 fault MAX31865 (null + kode fault)
//     node simulate_esp32.js --dingin gb02          -> gb02 terbaca ~5 °C (alarm suhu rendah)
//     node simulate_esp32.js --mati gb05            -> gb05 tidak dikirim (jadi offline)
//     node simulate_esp32.js --crane crane-02 --area cbk   -> crane lain (uji deteksi perangkat baru)
//     node simulate_esp32.js --gearbox 6            -> kirim gb01..gb06 (uji gearbox baru)
//
// gb03 sengaja dibuat naik-turun pelan 55 -> 88 °C (siklus 10 menit) supaya
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
const CRANE_ID = arg('crane', 'crane-01');
const AREA = arg('area', 'twb');
const ERROR_GB = arg('error', null);
const COLD_GB = arg('dingin', null);
const DEAD_GB = arg('mati', null);
const GB_COUNT = Number(arg('gearbox', 5));
const INTERVAL_MS = 5000;
const TOPIC = `pabrik/${AREA}/${CRANE_ID}/temp`;
const STATUS_TOPIC = `pabrik/${AREA}/${CRANE_ID}/status`;
const FW_VERSION = '2.0.0-sim';

const gearboxes = Array.from({ length: GB_COUNT }, (_, i) => `gb${String(i + 1).padStart(2, '0')}`);
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
        } else if (gb === 'gb03') {
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

// Login seperti ESP32 asli: username = crane-id, password dari mqtt/credentials.json
function loadCredentials() {
    try {
        const creds = JSON.parse(fs.readFileSync(path.join(__dirname, 'mqtt', 'credentials.json'), 'utf-8'));
        if (creds[CRANE_ID]) return { username: CRANE_ID, password: creds[CRANE_ID] };
    } catch (e) { /* belum di-setup */ }
    return {};
}

const client = mqtt.connect(BROKER_URL, {
    clientId: `ESP32-${CRANE_ID}-sim`,
    reconnectPeriod: 3000,
    ...loadCredentials(),
    will: { topic: STATUS_TOPIC, payload: JSON.stringify({ online: false }), qos: 1, retain: true }
});

client.on('connect', () => {
    console.log(`[Sim] Terhubung ke ${BROKER_URL}, kirim ke ${TOPIC} tiap ${INTERVAL_MS / 1000} detik. Ctrl+C untuk berhenti.`);
    client.publish(STATUS_TOPIC, JSON.stringify({
        online: true, fw: FW_VERSION, ip: '127.0.0.1', mac: 'SIMULATOR', rssi: -55,
        sensors: gearboxes.length, uptime_s: Math.round((Date.now() - startMs) / 1000), buffer_bytes: 0
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
