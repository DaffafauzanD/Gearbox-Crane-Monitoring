// ============================================================
// WEB SERVER DASHBOARD + SERVER ALARM + PENGATURAN
// ============================================================
// 1. Menyajikan dashboard, halaman laporan & pengaturan, state.json, file Excel.
// 2. Mesin alarm (alarm_engine.js): ikut membaca data suhu dari broker, menyalakan
//    alarm, dan mengirimkannya ke semua dashboard secara real-time (Server-Sent Events).
// 3. Pengaturan (settings.js -> config/settings.json): nama crane/gearbox & batas suhu.
//    Perubahan dari halaman Pengaturan langsung berlaku di semua layar.
// 4. Deteksi perangkat (devices.js): ESP32 yang mengirim data tapi cranenya belum
//    diaktifkan tampil sebagai "perangkat baru terdeteksi" di dashboard.
//
// CARA PAKAI:
//     npm run web          (sama dengan: node server.js)
// lalu buka http://localhost:8080. Dari PC lain: http://<ip-pc-ini>:8080
//
// Hanya file yang memang dibutuhkan browser yang bisa diakses (lihat ALLOWED).
// Kode server, node_modules, password, database, dsb tidak ikut tersaji.
//
// API (semua POST/PUT wajib body JSON):
//     GET  /api/stream                 -> Server-Sent Events: "settings", "alarms", "devices"
//     GET  /api/alarms                 -> { active, history }
//     POST /api/alarms/ack             -> { id, by }
//     GET  /api/settings               -> pengaturan saat ini
//     PUT  /api/settings               -> { settings, by } (settings.revision harus sama dgn yang di server)
//     GET  /api/settings/audit         -> catatan perubahan pengaturan
//     GET  /api/devices                -> ESP32 yang pernah terlihat
//     POST /api/devices/activate       -> { craneId, by }  aktifkan crane dari perangkat terdeteksi
//     POST /api/devices/ignore         -> { craneId, by }  sembunyikan perangkat dari notifikasi
//     GET  /api/trend | /api/report | /api/report/alarms   -> laporan (lihat reports.js)

const http = require('http');
const fs = require('fs');
const path = require('path');
const mqtt = require('mqtt');
const Settings = require('./settings');
const { AlarmEngine } = require('./alarm_engine');
const { DeviceRegistry } = require('./devices');
const { openDb, alarmEventWriter } = require('./db');
const reports = require('./reports');

const PORT = Number(process.env.PORT) || 8080;
const ROOT = __dirname;
const BROKER_URL = process.env.MQTT_URL || 'mqtt://localhost:1883';
const WS_PORT = Number(process.env.MQTT_WS_PORT) || 9001; // port WebSocket broker untuk browser
const OFFLINE_CHECK_MS = 15000;
const MAX_REPORT_RANGE_MS = 400 * 24 * 60 * 60 * 1000;

const ALLOWED = /^(index\.html|laporan\.html|laporan\.js|pengaturan\.html|pengaturan\.js|CSS_Monitoring\.css|JS_Monitoring\.js|alarm_rules\.js|state\.json|vendor\/[\w\-./]+|excel\/[\w\-]+\.xlsx|logs\/[\w\-]+\.csv)$/;

const CONTENT_TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.csv': 'text/csv; charset=utf-8',
    '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    '.woff2': 'font/woff2',
    '.ttf': 'font/ttf'
};

// File yang isinya berubah terus - jangan di-cache browser
const NO_CACHE = /^(.*\.html|.*\.js|CSS_Monitoring\.css|state\.json|excel\/.*|logs\/.*)$/;

function readCredentials() {
    try {
        return JSON.parse(fs.readFileSync(path.join(ROOT, 'mqtt', 'credentials.json'), 'utf-8'));
    } catch (e) {
        return {}; // belum di-setup: konek tanpa login
    }
}

// ============================================================
// PENGATURAN
// ============================================================
let settings;
try {
    settings = Settings.load();
    const problems = Settings.validate(settings);
    if (problems.length) throw new Error(problems.join('; '));
} catch (e) {
    console.error(`[Web] config/settings.json tidak bisa dipakai: ${e.message}`);
    console.error('[Web] Perbaiki file itu (versi sebelumnya ada di config/settings.json.bak), lalu jalankan lagi.');
    process.exit(1);
}

const db = openDb();
const engine = new AlarmEngine({ config: settings, dir: path.join(ROOT, 'alarms') });
const devices = new DeviceRegistry(db);

const writeAlarmEvent = alarmEventWriter(db);
engine.on('event', entry => {
    try {
        writeAlarmEvent(entry);
    } catch (e) {
        console.error('[Alarm] Gagal simpan kejadian ke database:', e.message);
    }
});

const insertAudit = db.prepare('INSERT INTO settings_changes (at, by, action, changes) VALUES (?, ?, ?, ?)');

// Simpan pengaturan baru: validasi, catat perubahan, lalu kabari semua layar
function commitSettings(next, by, action) {
    const problems = Settings.validate(next);
    if (problems.length) {
        const err = new Error(problems.slice(0, 8).join('\n'));
        err.status = 400;
        throw err;
    }
    const changes = Settings.diff(settings, next);
    if (changes.length === 0) return { changes };

    next.revision = (settings.revision || 0) + 1;
    Settings.save(next);
    insertAudit.run(Date.now(), by || null, action, JSON.stringify(changes));
    console.log(`[Pengaturan] ${action}${by ? ' oleh ' + by : ''}: ${changes.length} perubahan`);
    applySettings(next);
    return { changes };
}

function applySettings(next) {
    settings = next;
    engine.config = next;
    engine.dropUnmonitored();
    broadcast('settings', settings);
    broadcast('devices', deviceList());
}

// File diedit manual (bukan lewat halaman Pengaturan) -> dibaca ulang kalau valid
fs.watchFile(Settings.SETTINGS_FILE, { interval: 3000 }, () => {
    let fromFile;
    try {
        fromFile = Settings.load();
    } catch (e) {
        return console.error('[Pengaturan] config/settings.json tidak bisa dibaca:', e.message);
    }
    if (JSON.stringify(fromFile) === JSON.stringify(settings)) return; // hasil simpan kita sendiri
    const problems = Settings.validate(fromFile);
    if (problems.length) {
        return console.error('[Pengaturan] config/settings.json bermasalah, perubahan TIDAK dipakai:\n  - ' + problems.join('\n  - '));
    }
    insertAudit.run(Date.now(), null, 'Edit manual config/settings.json', JSON.stringify(Settings.diff(settings, fromFile)));
    console.log('[Pengaturan] config/settings.json dibaca ulang (edit manual)');
    applySettings(fromFile);
});

// ============================================================
// PERANGKAT
// ============================================================
function deviceList() {
    return devices.list().map(d => {
        const crane = settings.cranes.find(c => c.id === d.craneId);
        return {
            ...d,
            configured: !!crane,                     // crane-id ini ada di daftar crane
            installed: !!crane && crane.installed,   // sudah diaktifkan (dipantau)
            unknownGearboxes: crane ? d.gbKeys.filter(k => !crane.gearboxes.some(g => g.key === k)) : d.gbKeys
        };
    });
}

let devicesTimer = null;
devices.on('change', () => {
    if (devicesTimer) return;
    devicesTimer = setTimeout(() => {
        devicesTimer = null;
        broadcast('devices', deviceList());
    }, 1000);
});

function activateDevice(craneId, by) {
    const device = devices.devices.get(craneId);
    if (!device) {
        const err = new Error(`Perangkat ${craneId} belum pernah terlihat`);
        err.status = 404;
        throw err;
    }
    const next = JSON.parse(JSON.stringify(settings));
    let crane = next.cranes.find(c => c.id === craneId);
    if (!crane) {
        // crane-id belum ada di daftar: tambahkan dengan nama sementara (ubah di Pengaturan)
        crane = {
            id: craneId,
            name: `${next.cranes.length + 1}. ${craneId} (baru terdeteksi)`,
            location: `Plant ${device.area.toUpperCase()}`,
            area: device.area,
            installed: true,
            gearboxes: []
        };
        next.cranes.push(crane);
    }
    crane.installed = true;
    crane.area = device.area;
    // Gearbox yang mengirim data tapi belum terdaftar ikut ditambahkan
    device.gbKeys.forEach(key => {
        if (!crane.gearboxes.some(g => g.key === key)) crane.gearboxes.push({ key, name: `GB ${key.slice(2)}`, sparepart: '' });
    });
    devices.unignore(craneId);
    return commitSettings(next, by, `Aktifkan perangkat ${craneId}`);
}

// Waktu data terakhir tiap gearbox dari state.json (hasil logger), supaya sensor
// yang sudah lama mati langsung ketahuan offline begitu server nyala.
try {
    const state = JSON.parse(fs.readFileSync(path.join(ROOT, 'state.json'), 'utf-8'));
    Object.entries(state).forEach(([craneId, gearboxes]) => {
        Object.entries(gearboxes).forEach(([gbKey, gb]) => {
            const ms = Date.parse(gb.lastUpdated);
            if (/^gb\d+$/.test(gbKey) && Number.isFinite(ms)) engine.seedLastSeen(craneId, gbKey, ms);
        });
    });
} catch (e) { /* state.json belum ada */ }

setInterval(() => engine.checkOffline(), OFFLINE_CHECK_MS);
setTimeout(() => engine.checkOffline(), 2000);

// ============================================================
// MQTT -> MESIN ALARM & DAFTAR PERANGKAT
// ============================================================
const credentials = readCredentials();
const mqttClient = mqtt.connect(BROKER_URL, {
    clientId: 'web-' + Math.random().toString(16).slice(2, 8),
    reconnectPeriod: 3000,
    ...(credentials.web ? { username: 'web', password: credentials.web } : {})
});

mqttClient.on('connect', () => {
    console.log('[Web] Terhubung ke broker');
    mqttClient.subscribe(['pabrik/+/+/temp', 'pabrik/+/+/status']);
});
mqttClient.on('error', err => console.error('[Web] MQTT error:', err.message));

mqttClient.on('message', (topic, payloadBuffer) => {
    const [, area, craneId, kind] = topic.split('/');
    if (!/^[a-z0-9-]{1,20}$/i.test(area || '') || !/^[a-z0-9][a-z0-9-]{0,39}$/i.test(craneId || '')) return;
    const text = payloadBuffer.toString();
    const now = Date.now();

    if (kind === 'status') {
        // Firmware baru: {"online":true, "fw":..., "ip":..., "rssi":...}
        // Last Will (dikirim broker saat ESP32 putus mendadak): {"online":false}
        if (text === '') return; // pesan retained dihapus
        let info;
        try {
            info = JSON.parse(text);
        } catch (e) {
            info = { online: text.trim().toLowerCase() !== 'offline' };
        }
        if (!info || typeof info !== 'object') return;
        devices.seenStatus(craneId, area, info, now);
        if (info.online === false) engine.deviceOffline(craneId, now);
        return;
    }

    let data;
    try {
        data = JSON.parse(text);
    } catch (e) {
        return;
    }
    // Sama seperti logger: crane_id di isi pesan harus cocok dengan topiknya
    if (!data || !data.temps || typeof data.temps !== 'object' || data.crane_id !== craneId) return;

    const gbKeys = Object.keys(data.temps).filter(k => /^gb\d{1,3}$/.test(k));
    devices.seenData(craneId, area, gbKeys, now);
    const faults = data.faults && typeof data.faults === 'object' ? data.faults : {};
    gbKeys.forEach(gbKey => engine.ingest(craneId, gbKey, data.temps[gbKey], now, typeof faults[gbKey] === 'string' ? faults[gbKey].slice(0, 10) : null));
});

// ============================================================
// SERVER-SENT EVENTS: dorong pengaturan, alarm & perangkat ke semua browser
// ============================================================
const sseClients = new Set();

function sendEvent(res, event, data) {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function broadcast(event, data) {
    sseClients.forEach(res => sendEvent(res, event, data));
}

// Nilai suhu di alarm aktif berubah tiap pesan - kirim ke browser maks 1x per detik
let alarmsTimer = null;
engine.on('change', () => {
    if (alarmsTimer) return;
    alarmsTimer = setTimeout(() => {
        alarmsTimer = null;
        broadcast('alarms', engine.snapshot());
    }, 1000);
});

setInterval(() => sseClients.forEach(res => res.write(': ping\n\n')), 25000);

// ============================================================
// HTTP
// ============================================================
function sendJson(res, status, body) {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(body));
}

// Body wajib JSON: browser dari situs lain tidak bisa mengirim JSON ke sini tanpa
// izin CORS (yang tidak pernah kita berikan), jadi permintaan palsu dari luar tertolak.
function readJson(req, res, maxBytes, handler) {
    if (!(req.headers['content-type'] || '').startsWith('application/json')) {
        return sendJson(res, 415, { error: 'Content-Type harus application/json' });
    }
    let body = '';
    let tooLarge = false;
    req.on('data', chunk => {
        body += chunk;
        if (body.length > maxBytes) {
            tooLarge = true;
            req.destroy();
        }
    });
    req.on('end', () => {
        if (tooLarge) return;
        let data;
        try {
            data = JSON.parse(body);
        } catch (e) {
            return sendJson(res, 400, { error: 'JSON tidak valid' });
        }
        try {
            handler(data || {});
        } catch (e) {
            if (!e.status) console.error('[Web] Error:', e);
            sendJson(res, e.status || 500, { error: e.status ? e.message : 'Terjadi kesalahan di server' });
        }
    });
}

const cleanName = v => (typeof v === 'string' ? v.trim().slice(0, 40) : '');

function handleApiWrite(req, res, relPath) {
    if (relPath === 'api/alarms/ack') {
        return readJson(req, res, 2000, data => {
            const by = cleanName(data.by);
            if (typeof data.id !== 'string' || !by) return sendJson(res, 400, { error: 'id dan nama operator wajib diisi' });
            if (!engine.ack(data.id, by)) return sendJson(res, 404, { error: 'Alarm tidak ada atau sudah di-ack' });
            sendJson(res, 200, { ok: true });
        });
    }
    if (relPath === 'api/settings') {
        return readJson(req, res, 500000, data => {
            if (!data.settings || typeof data.settings !== 'object') return sendJson(res, 400, { error: 'settings wajib diisi' });
            if (data.settings.revision !== settings.revision) {
                return sendJson(res, 409, { error: 'Pengaturan sudah diubah dari tempat lain sejak halaman ini dibuka. Muat ulang halaman, lalu ulangi perubahan.' });
            }
            const result = commitSettings(data.settings, cleanName(data.by), 'Ubah pengaturan');
            sendJson(res, 200, { ok: true, revision: settings.revision, changes: result.changes });
        });
    }
    if (relPath === 'api/devices/activate') {
        return readJson(req, res, 2000, data => {
            if (typeof data.craneId !== 'string') return sendJson(res, 400, { error: 'craneId wajib diisi' });
            const result = activateDevice(data.craneId, cleanName(data.by));
            sendJson(res, 200, { ok: true, changes: result.changes });
        });
    }
    if (relPath === 'api/devices/ignore') {
        return readJson(req, res, 2000, data => {
            if (typeof data.craneId !== 'string' || !devices.ignore(data.craneId, cleanName(data.by))) {
                return sendJson(res, 404, { error: 'Perangkat tidak ditemukan' });
            }
            sendJson(res, 200, { ok: true });
        });
    }
    sendJson(res, 404, { error: 'Tidak ditemukan' });
}

function handleReport(req, res, relPath) {
    const params = new URL(req.url, 'http://x').searchParams;
    const from = Number(params.get('from'));
    const to = Number(params.get('to'));
    if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from || to - from > MAX_REPORT_RANGE_MS) {
        return sendJson(res, 400, { error: 'Parameter from/to tidak valid (epoch ms, maks 400 hari)' });
    }
    try {
        if (relPath === 'api/trend') {
            const craneId = params.get('crane');
            const gbKey = params.get('gb');
            if (!craneId || !gbKey) return sendJson(res, 400, { error: 'Parameter crane dan gb wajib' });
            return sendJson(res, 200, reports.trend(db, { craneId, gbKey, from, to }));
        }
        if (relPath === 'api/report') return sendJson(res, 200, reports.periodReport(db, settings, { from, to }));
        return sendJson(res, 200, { occurrences: reports.alarmOccurrences(db, { from, to }) });
    } catch (e) {
        console.error('[Web] Gagal membuat laporan:', e.message);
        return sendJson(res, 500, { error: 'Gagal membaca database laporan' });
    }
}

function serveStatic(req, res, relPath) {
    if (!ALLOWED.test(relPath) || relPath.includes('..')) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end('Tidak ditemukan');
    }

    const filePath = path.join(ROOT, relPath);
    fs.stat(filePath, (err, stat) => {
        if (err || !stat.isFile()) {
            res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
            return res.end('Tidak ditemukan');
        }

        res.writeHead(200, {
            'Content-Type': CONTENT_TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
            'Content-Length': stat.size,
            'Cache-Control': NO_CACHE.test(relPath) ? 'no-store' : 'max-age=86400'
        });
        if (req.method === 'HEAD') return res.end();
        fs.createReadStream(filePath).pipe(res);
    });
}

const auditQuery = db.prepare('SELECT at, by, action, changes FROM settings_changes ORDER BY id DESC LIMIT 100');

const server = http.createServer((req, res) => {
    let relPath;
    try {
        relPath = decodeURIComponent(new URL(req.url, 'http://x').pathname).replace(/^\/+/, '');
    } catch (e) {
        res.writeHead(400);
        return res.end('Bad request');
    }
    if (relPath === '') relPath = 'index.html';

    if ((req.method === 'POST' || req.method === 'PUT') && relPath.startsWith('api/')) {
        if ((relPath === 'api/settings') !== (req.method === 'PUT')) return sendJson(res, 405, { error: 'Method tidak diizinkan' });
        return handleApiWrite(req, res, relPath);
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405, { Allow: 'GET, HEAD' });
        return res.end();
    }

    if (relPath === 'api/stream') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
        sendEvent(res, 'settings', settings);
        sendEvent(res, 'alarms', engine.snapshot());
        sendEvent(res, 'devices', deviceList());
        sseClients.add(res);
        req.on('close', () => sseClients.delete(res));
        return;
    }
    if (relPath === 'api/alarms') return sendJson(res, 200, engine.snapshot());
    if (relPath === 'api/settings') return sendJson(res, 200, settings);
    if (relPath === 'api/devices') return sendJson(res, 200, deviceList());
    if (relPath === 'api/settings/audit') {
        return sendJson(res, 200, auditQuery.all().map(r => ({ ...r, changes: JSON.parse(r.changes) })));
    }
    if (relPath === 'api/trend' || relPath === 'api/report' || relPath === 'api/report/alarms') {
        return handleReport(req, res, relPath);
    }

    // Akun MQTT untuk browser. Cuma akun "dashboard" (baca-saja, lihat mqtt/acl)
    // yang diteruskan - password logger, web & ESP32 tidak pernah keluar dari server.
    if (relPath === 'mqtt-config.json') {
        const creds = readCredentials();
        return sendJson(res, 200, { wsPort: WS_PORT, ...(creds.dashboard ? { username: 'dashboard', password: creds.dashboard } : {}) });
    }

    serveStatic(req, res, relPath);
});

server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
        console.error(`[Web] Port ${PORT} sudah dipakai program lain. Tutup program itu, atau jalankan dengan port lain, mis: set PORT=8081 && node server.js`);
    } else {
        console.error('[Web] Error:', err.message);
    }
    process.exit(1);
});

server.listen(PORT, () => {
    console.log(`[Web] Dashboard jalan di http://localhost:${PORT}`);
});
