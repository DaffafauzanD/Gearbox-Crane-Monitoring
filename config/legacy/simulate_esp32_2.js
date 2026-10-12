const mqtt = require('mqtt');
const fs = require('fs');
const path = require('path');

function arg(name, fallback ) {
    const i = process.argv.indexOf(`--${name}`);
    return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const BROKER_URL = arg('broker', 'mqtt://localhost:1883');
const CRANE_ID = arg('crane', 'crane-02');
const AREA = arg('area', 'ccc');
const ERROR_GB = arg('error', null);
const COLD_GB = arg('dingin', null);
const DEAD_GB = arg('mati', null);
const GB_COUNT = Number(arg('gearbox', 5));
const INTERVAL_MS = 5000;
const TOPIC = `pabrik/${AREA}/${CRANE_ID}/temp`;
const STATUS_TOPIC = `pabrik/${AREA}/${CRANE_ID}/status`;
const FW_VERSION = '2.0.0-sim';

const gearboxes = Array.from({ length: GB_COUNT }, (_, i) =>  `gb${String(i + 1).padStart(2, '0')}`);
const temps = {};
gearboxes.forEach((gb, i) => { temps[gb] = 48 + (i * 3) % 12; });
const startMs = Date.now();

function timestampWib() {
    const out  = {};
    const faults = {};
    gearboxes.forEach(gb => {
        if (gb === DEAD_GB) return;
        if (gb === ERROR_GB) {
            out[gb] = null;
            faults[gb] = '0x80';
            return;
        }
        if (gb === COLD_GB) {
            temps[gb] = 5 + (Math.random() - 0.5);
        } else if (gb === 'gb03') {
            const phase = ((Date.now() - startMs) / 600000) * 2 * Math.PI;
            temps [gb] = 71.5 - 16.5 * Math.cos(phase) + (Math.random() - 0.5);
        } else {
            temps[gb] += (Math.random() -0.5) * 0.8;
            temps[gb] = Math.min(65, Math.max(45, temps[gb]));
        }    
        out[gb] = Math.round(temps[gb] * 10) / 10;
    });
    return { out,faults };
}

function loadCredentials() {
    try {
        const creds = JSON.parse(fs.readFileSync(path.join(__dirname, 'mqtt', 'credentials.json'), 'utf-8'));
        if (creds[CRANE_ID]) return { username: CRANED_ID, password: creds[CRANE_ID] };
    } catch (e) { /*nanti diisi */ }
    return {};
}

const client = mqtt.connect(BROKER_URL, {
    clientId: `ESP32-${CRANE_ID}-sim`,
    reconnectPeriod: 3000,
    ...loadCredentials(),
    will: {topic: STATUS_TOPIC, payload: JSON.stringfly({ online: false }), qos: 1, retain:true }
   });

   client.on('connect', () => {
    console.log(`[Sim] Terhubung ke ${BROKER_URL}, kirim ke ${TOPIC} tiap ${INTERVAL_MS / 1000} detik. Ctrl+C untuk berhenti.`);
    client.publish(STATUS_TOPIC, JSON.stringify({
online: true, fw: FW_VERSION, ip: '127.0.0.1', mac: 'SIMULATOR', rssi: -55,
    }), { qos: 1, retain: true});

 });
   client.on('error', err => console.error('[Sim] MQTT error:', err.message));

   setInterval(() => {
     if (!client.connected) return;
    const { out, faults } = nextReading();
    const payload = { crane_id: CRANE_ID, plant: AREA.toUpperCase (), timestamp: timestampWib(), temps: out };
    if (Object.keys(faults).length) payload.faults = faults;
    client.publish(TOPIC, JSON.stringify(payload));
    console.log('[Sim]', JSON.stringify(out));
   }, INTERVAL_MS);

   process.on('SIGINT', () => {
    client.publish(STATUS_TOPIC, JSON.stringify({ online: false, reason: 'shutdown' }), { qos: 1, retain: true }, () => {
    });
    setTimeout(() => process.exit(0), 1500);
   });