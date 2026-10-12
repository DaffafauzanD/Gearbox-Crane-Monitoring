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
// 5. Login (auth.js -> data/auth.db, TERPISAH dari data/monitoring.db): dua akun
//    "master" & "maintenance" (bawaan) + akun viewer hasil pengajuan. Seluruh dashboard/API di
//    bawah ini WAJIB login, KECUALI login.html, login.js, dan firmware-ota/*
//    (ESP32 mengunduh firmware OTA tanpa login). Sesi disimpan di cookie
//    httpOnly, berlaku 30 hari sejak terakhir dipakai.
//
// API (semua POST/PUT wajib body JSON):
//     POST /api/login                  -> { username, password }  set cookie sesi
//     POST /api/logout                 -> hapus sesi & cookie
//     GET  /api/me                     -> { username, role } akun yang sedang login (role: master | maintenance | viewer)
//     POST /api/signup                 -> { username, password }  ajukan akun baru dari halaman login.
//                                          PUBLIK (tanpa login), dibatasi per IP. Baru bisa dipakai
//                                          login setelah disetujui.
//     GET  /api/signups                -> daftar pengajuan yang menunggu. KHUSUS master & maintenance.
//     POST /api/signups/decide         -> { id, action: "approve" | "reject" }. KHUSUS master & maintenance.
//                                          Akun yang disetujui berperan "viewer": HANYA boleh melihat
//                                          dashboard monitoring & indikatornya (semua endpoint lain
//                                          ditolak 403 - lihat viewerMayAccess).
//     GET  /api/accounts               -> daftar akun hasil pengajuan (viewer). KHUSUS master & maintenance.
//     POST /api/accounts/delete        -> { username }  hapus akun hasil pengajuan. KHUSUS master & maintenance.
//                                          Sesi login & koneksi live akun itu langsung diputus.
//                                          Akun bawaan (master, maintenance) tidak bisa dihapus.
//     GET  /api/sessions               -> daftar sesi login aktif (siapa online).
//                                          master: semua sesi. Akun lain: cuma sesi
//                                          sesama akunnya (sesi master tidak terlihat).
//     POST /api/sessions/terminate     -> { id }  matikan satu sesi. master: sesi akun lain
//                                          (bukan master). Akun lain: sesi sesama akunnya,
//                                          bukan sesi dirinya sendiri (pakai /api/logout).
//     GET  /api/health                 -> status.html - broker/logger/web BENERAN hidup
//                                          atau tidak (bukan cuma jendela run-all.js
//                                          kebuka). PUBLIK, tidak perlu login.
//     GET  /api/stream                 -> Server-Sent Events: "settings", "alarms", "devices"
//     GET  /api/alarms                 -> { active, history }
//     POST /api/alarms/ack             -> { id, by }
//     GET  /api/settings               -> pengaturan saat ini
//     PUT  /api/settings               -> { settings, by } (settings.revision harus sama dgn yang di server)
//     GET  /api/settings/audit         -> catatan perubahan pengaturan
//     POST /api/settings/audit/delete  -> { id } atau { all:true }  hapus catatan perubahan.
//                                          KHUSUS akun master. Berlaku untuk semua akun (data
//                                          di database yang sama) & langsung dikabarkan ke semua
//                                          halaman yang terbuka lewat event SSE "audit".
//     GET  /api/devices                -> ESP32 yang pernah terlihat, SATU BARIS PER ESP32:
//                                          { id, craneId, node, gbKeys, conflicts, ... }. Crane boleh
//                                          punya beberapa ESP32: id "crane-01" (utama) dan "crane-01_2",
//                                          "crane-01_3" (tambahan) - lihat parseDeviceId di alarm_rules.js.
//     Di endpoint perangkat, OTA & Serial Monitor di bawah, "craneId" berarti ID PERANGKAT itu
//     (untuk ESP utama sama persis dengan ID crane; nama field dipertahankan supaya pemanggil lama jalan).
//     POST /api/devices/activate       -> { craneId, by }  aktifkan crane dari perangkat terdeteksi
//     POST /api/devices/ignore         -> { craneId, by }  sembunyikan perangkat dari notifikasi
//     POST /api/devices/remove         -> { craneId, by }  hapus dari daftar "perangkat terdeteksi"
//                                          saja (data crane & gearbox di settings.json TIDAK ikut
//                                          terhapus). Kalau ESP32-nya kirim data lagi, dia akan
//                                          tercatat ulang dan muncul lagi di daftar.
//     GET  /api/trend | /api/report | /api/report/alarms   -> laporan (lihat reports.js)
//     GET  /api/excel/<craneId>         -> file Excel log 7 hari crane itu (tombol download di dashboard).
//                                          Dibuat SAAT DIKLIK dari ringkasan per menit di database, di
//                                          thread terpisah (excel_worker.js) supaya server alarm tidak
//                                          tersendat; hasilnya dipakai ulang 5 menit. Satu pembuatan
//                                          sekali jalan (antrian); antrian penuh -> 503. Akun viewer: 403.
//     GET  /api/ota/manifests           -> { [craneId]: manifest }  firmware ter-upload PER ESP32
//                                           (tiap ESP32 dikompilasi dengan config.h-nya sendiri:
//                                           NODE_ID & daftar motornya beda, jadi file .bin-nya juga beda)
//     GET  /api/ota/history[?craneId=]  -> { [craneId]: [{at,by,fileName,version}] } atau array
//                                           kalau craneId diisi - riwayat SEMUA upload (bukan cuma
//                                           yang sekarang ter-publish), disimpan di
//                                           firmware-ota/upload-history.json (lihat appendOtaHistory).
//     POST /api/ota/upload              -> ?craneId=crane-01&uploadedBy=Nama%20PIC&fileName=asli.bin,
//                                           body = file .bin mentah (dari accordion crane itu di
//                                           halaman Pengaturan). Firmware KHUSUS crane itu, disimpan
//                                           di firmware-ota/<craneId>/. uploadedBy WAJIB diisi (nama
//                                           PIC/operator yang meng-upload), dicatat di manifest.json
//                                           beserta releasedAt (timestamp lengkap ISO). Versi TIDAK
//                                           diisi manual - dibuat otomatis mulai dari 1.1.1, naik 1 di
//                                           angka patch tiap upload baru (lihat nextFirmwareVersion).
//     POST /api/ota/trigger            -> { craneId, by } atau { all:true, by }  suruh ESP32
//                                          update firmware lewat MQTT ("ota" di topik .../perintah).
//                                          Tiap crane unduh firmware-nya SENDIRI dari
//                                          /firmware-ota/<craneId>/GBXMQTT.bin. all:true cuma
//                                          menyasar crane yang sudah ada firmware ter-upload untuk
//                                          dirinya. Siapa & kapan dicatat di firmware-ota/trigger-log.json
//                                          (disajikan statis, sama seperti manifest.json)
//     POST /api/ota/remove             -> { craneId, by }  hapus firmware yang di-upload SELAMA
//                                          ESP32 belum konfirmasi menjalankan versi itu (dicek dari
//                                          devices.info.fw vs manifest.version). Hapus file .bin +
//                                          manifest.json dari firmware-ota/<craneId>/ dan hapus
//                                          entri crane itu dari trigger-log.json.

const http = require('http');
const os = require('os');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const mqtt = require('mqtt');
const Settings = require('./settings');
const AlarmRules = require('./alarm_rules');
const { AlarmEngine } = require('./alarm_engine');
const { DeviceRegistry } = require('./devices');
const { openDb, alarmEventWriter } = require('./db');
const Auth = require('./auth');
const reports = require('./reports');
const { Worker } = require('worker_threads');

// IP LAN PC ini (bukan sekadar host yang diketik di address bar browser -
// supaya tetap benar walau dashboard dibuka lewat "localhost"). Ambil IPv4
// non-internal pertama; kalau PC punya banyak network card, sesuaikan filter di bawah.
function localLanIp() {
    const nets = os.networkInterfaces();
    for (const name of Object.keys(nets)) {
        for (const net of nets[name]) {
            if (net.family === 'IPv4' && !net.internal) return net.address;
        }
    }
    return null;
}

const PORT = Number(process.env.PORT) || 8080;
const ROOT = __dirname;
const BROKER_URL = process.env.MQTT_URL || 'mqtt://localhost:1883';
const WS_PORT = Number(process.env.MQTT_WS_PORT) || 9001; // port WebSocket broker untuk browser
const OFFLINE_CHECK_MS = 15000;
const MAX_REPORT_RANGE_MS = 400 * 24 * 60 * 60 * 1000;

const ALLOWED = /^(index\.html|laporan\.html|laporan\.js|pengaturan\.html|pengaturan\.js|login\.html|login\.js|auth-ui\.js|status\.html|status\.js|espmon\.js|CSS_Monitoring\.css|JS_Monitoring\.js|mds\.js|alarm_rules\.js|state\.json|vendor\/[\w\-./]+|logs\/[\w\-]+\.csv|firmware-ota\/(?:[\w\-.]+\.(?:bin|json)|[\w\-]+\/[\w\-.]+\.(?:bin|json)))$/;

const CONTENT_TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.csv': 'text/csv; charset=utf-8',
    '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    '.woff2': 'font/woff2',
    '.ttf': 'font/ttf',
    '.bin': 'application/octet-stream'
};

// File yang isinya berubah terus - jangan di-cache browser
const NO_CACHE = /^(.*\.html|.*\.js|CSS_Monitoring\.css|state\.json|excel\/.*|logs\/.*|firmware-ota\/.*\.json)$/;

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

// ============================================================
// LOGIN (data/auth.db - TERPISAH dari data/monitoring.db di atas)
// ============================================================
const authDb = Auth.openAuthDb();
const authStore = new Auth.AuthStore(authDb);
const bootstrapped = Auth.bootstrapDefaultAccounts(authStore, path.join(ROOT, 'accounts-credentials.json'));
if (bootstrapped) {
    console.log('[Auth] Akun pertama dibuat otomatis (master & maintenance):');
    Object.entries(bootstrapped).forEach(([user, pass]) => console.log(`[Auth]   ${user} / ${pass}`));
    console.log('[Auth] Password ini juga tersimpan di accounts-credentials.json. Ganti kapan saja lewat:');
    console.log('[Auth]   npm run setup-accounts -- --set master "PasswordBaru"');
}
setInterval(() => authStore.prune(), 6 * 60 * 60 * 1000); // buang sesi kadaluarsa tiap 6 jam

// Path yang boleh diakses TANPA login: halaman login itu sendiri, dan firmware
// OTA (diunduh langsung oleh ESP32, yang tidak punya cookie/sesi browser).
function isPublicPath(relPath, method) {
    if (relPath === 'login.html' || relPath === 'login.js') return true;
    if (relPath === 'api/login' && method === 'POST') return true;
    if (relPath === 'api/logout' && method === 'POST') return true;
    if (relPath === 'api/signup' && method === 'POST') return true;
    if (/^firmware-ota\//.test(relPath)) return true;
    // api/health SENGAJA tetap publik (tanpa login) - supaya bisa dipantau Task
    // Scheduler/alat monitoring eksternal (Zabbix, dsb) tanpa perlu simpan cookie sesi.
    // Isinya cuma status hidup/mati layanan, tidak ada data suhu/pengaturan/rahasia.
    // status.html/status.js (halaman tampilannya) TIDAK publik - wajib login sebagai
    // master/maintenance (lihat VIEWER_GET: tidak didaftarkan di sana, jadi viewer pun
    // otomatis ditolak, sama seperti pengaturan.html/laporan.html).
    if (relPath === 'api/health') return true;
    return false;
}

// ---- Peran akun ----
// master & maintenance = staf (boleh semua fitur). viewer = akun hasil pengajuan yang
// disetujui: HANYA melihat dashboard monitoring & indikatornya. Yang boleh dibuka viewer
// didaftar SECARA EKSPLISIT di bawah; selain itu 403 (halaman .html -> dialihkan ke dashboard).
const VIEWER_GET = /^(index\.html|JS_Monitoring\.js|mds\.js|CSS_Monitoring\.css|auth-ui\.js|alarm_rules\.js|state\.json|mqtt-config\.json|vendor\/[\w\-./]+|api\/(me|stream|alarms|settings))$/;

function viewerMayAccess(relPath, method) {
    return (method === 'GET' || method === 'HEAD') && VIEWER_GET.test(relPath);
}

const isStaff = role => role === 'master' || role === 'maintenance';
const isApprover = req => isStaff(req.authRole);

// ---- Pembatasan pengajuan akun: maksimal beberapa kali per jam per IP ----
const SIGNUP_MAX_PER_HOUR = Number(process.env.SIGNUP_MAX_PER_HOUR) || 5; // bisa diubah lewat variabel lingkungan
const signupHits = new Map(); // ip -> [waktu percobaan]
function signupAllowed(ip) {
    const now = Date.now();
    const list = (signupHits.get(ip) || []).filter(t => now - t < 60 * 60 * 1000);
    if (list.length >= SIGNUP_MAX_PER_HOUR) {
        signupHits.set(ip, list);
        return false;
    }
    list.push(now);
    signupHits.set(ip, list);
    return true;
}
setInterval(() => signupHits.forEach((list, ip) => { if (!list.some(t => Date.now() - t < 60 * 60 * 1000)) signupHits.delete(ip); }), 60 * 60 * 1000);

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
    broadcastDevices();
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
        const { keySeen, ...pub } = d;
        return {
            ...pub,
            configured: !!crane,                     // crane induknya ada di daftar crane
            installed: !!crane && crane.installed,   // sudah diaktifkan (dipantau)
            nodeCount: devices.ofCrane(d.craneId).length, // jumlah ESP32 yang pernah terlihat di crane ini
            ota: otaPublic(d.id),                    // progres update firmware terakhir (null = belum pernah)
            unknownGearboxes: crane ? d.gbKeys.filter(k => !crane.gearboxes.some(g => g.key === k)) : d.gbKeys
        };
    });
}

// Motor yang terpasang di ESP32 ini. ESP utama yang belum pernah mengirim data (gbKeys kosong)
// dianggap memegang semua motor yang tidak dikirim ESP32 lain - sama seperti sebelum ada multi-ESP.
function gbKeysOfDevice(d) {
    if (d.gbKeys.length || d.node !== 1) return d.gbKeys;
    const crane = settings.cranes.find(c => c.id === d.craneId);
    const others = new Set(devices.ofCrane(d.craneId).flatMap(o => o.gbKeys));
    return crane ? crane.gearboxes.map(g => g.key).filter(k => !others.has(k)) : [];
}

// "NAMA CRANE" untuk ESP utama, "NAMA CRANE · ESP 2" untuk ESP tambahan
function deviceLabel(deviceId) {
    const p = AlarmRules.parseDeviceId(deviceId);
    const c = p && (settings.cranes || []).find(x => x.id === p.craneId);
    if (!c) return deviceId;
    return p.node > 1 ? `${c.name} · ESP ${p.node}` : c.name;
}

let devicesTimer = null;
devices.on('change', () => {
    if (devicesTimer) return;
    devicesTimer = setTimeout(() => {
        devicesTimer = null;
        broadcastDevices();
    }, 1000);
});

// deviceId = ESP32 mana pun di crane itu. Yang diaktifkan CRANE-nya; motor dari SEMUA ESP32
// crane itu yang belum terdaftar ikut ditambahkan.
function activateDevice(deviceId, by) {
    const device = devices.devices.get(deviceId);
    if (!device) {
        const err = new Error(`Perangkat ${deviceId} belum pernah terlihat`);
        err.status = 404;
        throw err;
    }
    const craneId = device.craneId;
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
    // Motor yang mengirim data tapi belum terdaftar ikut ditambahkan (dari semua ESP32 crane ini)
    devices.ofCrane(craneId).forEach(d => d.gbKeys.forEach(key => {
        if (!crane.gearboxes.some(g => g.key === key)) {
            crane.gearboxes.push({ key, name: `Motor ${key.replace(/\D/g, '')}${d.node > 1 ? ` (ESP ${d.node})` : ''}`, sparepart: '' });
        }
    }));
    devices.unignore(craneId);
    return commitSettings(next, by, `Aktifkan perangkat ${deviceId}`);
}

// Waktu data terakhir tiap gearbox dari state.json (hasil logger), supaya sensor
// yang sudah lama mati langsung ketahuan offline begitu server nyala.
try {
    const state = JSON.parse(fs.readFileSync(path.join(ROOT, 'state.json'), 'utf-8'));
    Object.entries(state).forEach(([craneId, gearboxes]) => {
        Object.entries(gearboxes).forEach(([gbKey, gb]) => {
            const ms = Date.parse(gb.lastUpdated);
            if (/^[a-z]{1,8}\d{1,3}$/.test(gbKey) && Number.isFinite(ms)) engine.seedLastSeen(craneId, gbKey, ms);
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

// Dicatat buat /api/health (lihat bagian STATUS/HEALTH CHECK di bawah) - supaya
// halaman status bisa bilang "broker terputus sejak jam segini", bukan cuma ya/tidak.
let mqttConnectedAt = null;
let mqttDisconnectedAt = null;

mqttClient.on('connect', () => {
    console.log('[Web] Terhubung ke broker');
    mqttConnectedAt = Date.now();
    mqttDisconnectedAt = null;
    mqttClient.subscribe(['pabrik/+/+/temp', 'pabrik/+/+/status', 'pabrik/+/+/log']);
});
mqttClient.on('close', () => { if (!mqttDisconnectedAt) mqttDisconnectedAt = Date.now(); });
mqttClient.on('error', err => console.error('[Web] MQTT error:', err.message));

mqttClient.on('message', (topic, payloadBuffer) => {
    // Segmen ke-3 topik = ID PERANGKAT: "crane-01" (ESP utama) atau "crane-01_2" (ESP tambahan
    // di crane yang sama). Semua yang per-alat (status, Last Will, log, OTA, restart, AP) memakai
    // ID perangkat; data suhu digabung ke crane induknya.
    const [, area, deviceId, kind] = topic.split('/');
    const parsed = AlarmRules.parseDeviceId(deviceId);
    if (!/^[a-z0-9-]{1,20}$/i.test(area || '') || !parsed) return;
    const craneId = parsed.craneId;
    const text = payloadBuffer.toString();
    const now = Date.now();

    // Baris Serial Monitor dari ESP32 (hanya dikirim alat kalau ada yang menonton, lihat api/esp/log/start)
    if (kind === 'log') {
        espLogPush(deviceId, text, now);
        return;
    }

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
        apChangeFromStatus(deviceId, info, now);
        restartFromStatus(deviceId, info, now);
        const d = devices.seenStatus(deviceId, area, info, now);
        otaFromStatus(deviceId, info, now);
        // Hanya motor milik ESP32 yang putus ini - ESP lain di crane yang sama tetap jalan
        if (info.online === false) engine.deviceOffline(craneId, now, gbKeysOfDevice(d));
        return;
    }

    let data;
    try {
        data = JSON.parse(text);
    } catch (e) {
        return;
    }
    // Sama seperti logger: crane_id di isi pesan harus cocok dengan crane di topiknya
    if (!data || !data.temps || typeof data.temps !== 'object' || data.crane_id !== craneId) return;

    const gbKeys = Object.keys(data.temps).filter(k => /^[a-z]{1,8}\d{1,3}$/.test(k));
    devices.seenData(deviceId, area, gbKeys, now);
    const faults = data.faults && typeof data.faults === 'object' ? data.faults : {};
    gbKeys.forEach(gbKey => engine.ingest(craneId, gbKey, data.temps[gbKey], now, typeof faults[gbKey] === 'string' ? faults[gbKey].slice(0, 10) : null));
});

// ============================================================
// STATUS / HEALTH CHECK - /api/health & status.html
// ============================================================
// Beda dengan sekadar "jendela run-all.js kebuka": ini mengecek TIAP layanan
// dari sinyal yang benar-benar membuktikan dia jalan, bukan cuma proses masih
// ada di Task Manager.
//   - broker : mqttClient.connected - koneksi MQTT NYATA dari server.js sendiri
//              ke broker. Kalau broker cuma "kelihatan jalan" tapi sudah tidak
//              menerima koneksi, ini akan false.
//   - logger : gabungan 2 sinyal - (1) logger.lock: PID logger masih hidup
//              (dicek sama seperti run-all.js/mqtt_logger.js sendiri), dan
//              (2) umur state.json: logger cuma menulis file ini kalau memang
//              memproses data MQTT (lihat mqtt_logger.js). Proses hidup tapi
//              tidak pernah menulis lagi = kemungkinan macet/hang.
//   - web    : proses ini sendiri, jadi kalau endpoint ini menjawab, ya "up".
const { isProcessAlive } = require('./common');

function loggerHealth() {
    let pid = null;
    let processAlive = false;
    try {
        pid = parseInt(fs.readFileSync(path.join(ROOT, 'logger.lock'), 'utf-8'), 10);
        processAlive = Number.isFinite(pid) && isProcessAlive(pid);
    } catch (e) { /* logger.lock belum ada - logger belum pernah/tidak sedang jalan */ }

    let stateAgeMs = null;
    try { stateAgeMs = Date.now() - fs.statSync(path.join(ROOT, 'state.json')).mtimeMs; } catch (e) { /* state.json belum ada */ }

    return { pid: Number.isFinite(pid) ? pid : null, processAlive, stateAgeMs };
}

function buildHealth() {
    const now = Date.now();
    const logger = loggerHealth();
    const installed = (settings.cranes || []).filter(c => c.installed);
    // "Melapor sekarang" = ada data masuk dalam batas "offline (menit)" yang diatur di halaman
    // Pengaturan (per crane / per gearbox) - sama persis dengan yang dipakai dashboard.
    // Kalau gearbox-nya beda-beda, dipakai yang terlonggar (crane dianggap melapor kalau ada yang masih baru).
    // SATU BARIS PER ESP32: crane dengan 2 ESP32 muncul 2 baris ("crane-01" & "crane-01_2"). Crane yang
    // belum pernah mengirim data tetap 1 baris (ESP utama, ID = ID crane) supaya kelihatan belum melapor.
    const rows = installed.flatMap(c => {
        const list = devices.ofCrane(c.id);
        return (list.length ? list : [null]).map(d => ({ c, d }));
    });
    const craneList = rows.map(({ c, d }, i) => {
        const id = d ? d.id : c.id;
        const lastSeen = d && d.lastSeen ? d.lastSeen : null;
        const info = d && d.info ? d.info : null;
        const keys = d ? gbKeysOfDevice(d) : c.gearboxes.map(g => g.key);
        const offlineMinutes = Math.max(...(keys.length ? keys : ['']).map(k => AlarmRules.getLimits(settings, c.id, k).offlineMinutes));
        return {
            offlineMinutes,
            no: i + 1, id, craneId: c.id, node: d ? d.node : 1, nodeCount: devices.ofCrane(c.id).length || 1, gbKeys: keys,
            name: devices.ofCrane(c.id).length > 1 ? `${c.name} · ESP ${d.node}` : c.name, location: c.location || '',
            topic: `pabrik/${c.area}/${id}/temp`, // topik MQTT tempat ESP32 ini kirim data suhu
            // d.online === false = Last Will dari broker (ESP32 putus mendadak) -> langsung offline, tidak perlu nunggu batas menit
            reporting: !!(lastSeen && d.online !== false && (now - lastSeen) < offlineMinutes * 60 * 1000), lastSeen,
            mac: info && info.mac ? info.mac : null,
            fw: info && info.fw ? info.fw : null,            rssi: info && typeof info.rssi === 'number' ? info.rssi : null,
            ap: info && typeof info.ap === 'string' ? info.ap.slice(0, 17) : null,   // MAC access point yang dipakai ESP32
            cand: info && typeof info.cand === 'string' ? info.cand.slice(0, 17) : null,          // AP cadangan yang sudah disiapkan ESP32
            candRssi: info && typeof info.cand_rssi === 'number' ? info.cand_rssi : null,
            roams: info && Number.isFinite(info.roams) ? info.roams : null,
            apKnown: info && Number.isFinite(info.ap_db) ? info.ap_db : null,   // jumlah AP yang dikenal ESP32 (tersimpan di flash)
            apDb: espApDb.get(id) || null,                                      // daftar lengkapnya (MAC, channel, sinyal terakhir)
            channel: info && Number.isFinite(info.ch) ? info.ch : null
        };
    }).sort((a, b) => a.craneId.localeCompare(b.craneId, 'en', { numeric: true }) || a.node - b.node)
      .map((c, i) => ({ ...c, no: i + 1 }));
    const reportingNow = craneList.filter(c => c.reporting).length;

    // Alamat broker MQTT dalam bentuk yang berguna buat orang lapangan (IP LAN + port),
    // bukan cuma BROKER_URL mentah (yang di PC server ini biasanya "mqtt://localhost:1883").
    let brokerPort = 1883;
    try { brokerPort = Number(new URL(BROKER_URL).port) || 1883; } catch (e) { /* biarkan default */ }

    return {
        checkedAt: now,
        web: {
            up: true,
            pid: process.pid,
            uptimeSec: Math.round(process.uptime()),
            memoryMb: Math.round(process.memoryUsage().rss / (1024 * 1024)),
            sseClients: sseClients.size
        },
        broker: {
            up: mqttClient.connected,
            url: BROKER_URL,
            ip: localLanIp(),
            port: brokerPort,
            connectedSince: mqttConnectedAt,
            disconnectedSince: mqttDisconnectedAt
        },
        logger: {
            up: logger.processAlive,
            pid: logger.pid,
            stateFileAgeSec: logger.stateAgeMs === null ? null : Math.round(logger.stateAgeMs / 1000)
        },
        devices: {
            // installed = jumlah crane; total = jumlah baris/ESP32 (bisa lebih banyak kalau ada crane ber-ESP ganda)
            installed: installed.length, total: craneList.length, reportingNow, list: craneList,
            // r.craneId di riwayat = ID perangkat (ESP32) yang restart / pindah AP
            restarts: restartLog.slice(0, 100).map(r => ({ ...r, craneName: deviceLabel(r.craneId) })),
            apChanges: apChanges.slice(0, 100).map(ch => ({ ...ch, craneName: deviceLabel(ch.craneId) }))
        }
    };
}

// ============================================================
// SERVER-SENT EVENTS: dorong pengaturan, alarm & perangkat ke semua browser
// ============================================================
const sseClients = new Set();

function sendEvent(res, event, data) {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

// audience (opsional): fungsi (role) -> boolean, untuk mengirim hanya ke sebagian klien
function broadcast(event, data, audience) {
    sseClients.forEach(res => { if (!audience || audience(res.gbxRole)) sendEvent(res, event, data); });
}

// Viewer cuma perlu tahu ESP32 mana yang online/offline dan motor mana yang dipegangnya
// (menentukan status tiap motor di dashboard), tanpa IP/MAC/versi firmware dan tanpa tombol aktivasi.
function deviceListFor(role) {
    if (isStaff(role)) return deviceList();
    return deviceList().map(d => ({
        id: d.id, craneId: d.craneId, node: d.node, nodeCount: d.nodeCount, area: d.area, online: d.online,
        installed: d.installed, configured: d.configured, lastSeen: d.lastSeen, ignoredAt: null,
        gbKeys: d.gbKeys, unknownGearboxes: [], conflicts: {}, info: null
    }));
}

function broadcastDevices() {
    sseClients.forEach(res => sendEvent(res, 'devices', deviceListFor(res.gbxRole)));
}

// Jumlah pengajuan yang menunggu -> hanya master & maintenance (untuk lencana di dashboard)
function broadcastSignups() {
    broadcast('signups', { pending: authStore.pendingCount() }, isStaff);
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

const OTA_DIR = path.join(ROOT, 'firmware-ota');
const OTA_LOG_FILE = path.join(OTA_DIR, 'trigger-log.json');

// Siapa & kapan terakhir MEMINTA update untuk tiap crane (bukan waktu ESP32 selesai
// flash - itu tidak bisa dipastikan dari sini, cuma waktu tombolnya diklik/dipicu).
function readOtaLog() {
    try { return JSON.parse(fs.readFileSync(OTA_LOG_FILE, 'utf-8')); } catch (e) { return {}; }
}
function recordOtaTrigger(craneIds, by) {
    const log = readOtaLog();
    const at = Date.now();
    craneIds.forEach(id => { log[id] = { at, by: by || null }; });
    fs.mkdirSync(OTA_DIR, { recursive: true });
    fs.writeFileSync(OTA_LOG_FILE, JSON.stringify(log, null, 2) + '\n');
}

// Progres update firmware per crane, supaya Pengaturan bisa menampilkan hasilnya:
//   requested -> downloading -> success | failed | timeout
// requested   = perintah "ota" sudah dikirim, ESP32 belum melapor
// downloading = ESP32 melapor sedang mengunduh (status MQTT "ota":"downloading")
// success     = ESP32 melapor firmware = versi yang diminta DAN baru saja restart (uptime_s kecil)
// failed      = ESP32 melapor gagal ("ota":"failed", alasannya di "ota_err")
// timeout     = tidak ada kabar apa pun dalam OTA_TIMEOUT_MS
const OTA_STATE_FILE = path.join(OTA_DIR, 'ota-state.json');
const OTA_TIMEOUT_MS = 3 * 60 * 1000;
const otaStates = (() => { try { return JSON.parse(fs.readFileSync(OTA_STATE_FILE, 'utf-8')); } catch (e) { return {}; } })();
function saveOtaStates() {
    try {
        fs.mkdirSync(OTA_DIR, { recursive: true });
        fs.writeFileSync(OTA_STATE_FILE, JSON.stringify(otaStates, null, 2) + '\n');
    } catch (e) { console.error('[OTA] gagal menyimpan ota-state.json:', e.message); }
}
function otaPublic(craneId) {
    return otaStates[craneId] || null;
}
function otaStart(craneId, by, version) {
    const dev = devices.devices.get(craneId);
    const fwBefore = dev && dev.info && dev.info.fw ? dev.info.fw : null;   // versi yang jalan SEBELUM update
    otaStates[craneId] = { state: 'requested', at: Date.now(), by: by || null, version, fwBefore, fwNow: null, error: null, finishedAt: null };
    saveOtaStates();
    devices.emit('change');
}
function otaClear(craneId) {
    if (!otaStates[craneId]) return;
    delete otaStates[craneId];
    saveOtaStates();
    devices.emit('change');
}
// Dipanggil tiap pesan status ESP32 masuk
function otaFromStatus(craneId, info, now) {
    const st = otaStates[craneId];
    if (!st || !['requested', 'downloading'].includes(st.state) || !info || typeof info !== 'object') return;
    if (info.ota === 'downloading' && st.state === 'requested') {
        st.state = 'downloading';
    } else if (info.ota === 'failed' && st.state === 'downloading') {
        st.state = 'failed';
        st.error = typeof info.ota_err === 'string' ? info.ota_err.slice(0, 80) : 'tidak diketahui';
        st.finishedAt = now;
    } else if (info.online !== false && Number.isFinite(info.uptime_s) && info.ota !== 'downloading' &&
               info.uptime_s * 1000 < (now - st.at) + 5000 &&               // sudah restart sejak perintah dikirim
               (info.fw === st.version ||                                    // menjalankan versi yang diminta, ATAU
                (st.state === 'downloading' && info.fw && info.fw !== st.fwBefore))) { // sempat mengunduh & versinya berubah
        // Nomor versi di dalam .bin (FW_VERSION) bisa beda dari nomor di dashboard kalau lupa disamakan:
        // tetap dianggap berhasil, fwNow dipakai Pengaturan untuk menampilkan versi yang benar-benar jalan.
        st.state = 'success';
        st.fwNow = info.fw;
        st.finishedAt = now;
    } else return;
    saveOtaStates();
}
setInterval(() => {
    const now = Date.now();
    let changed = false;
    Object.values(otaStates).forEach(st => {
        if (['requested', 'downloading'].includes(st.state) && now - st.at > OTA_TIMEOUT_MS) {
            st.state = 'timeout';
            st.finishedAt = now;
            changed = true;
        }
    });
    if (changed) { saveOtaStates(); devices.emit('change'); }
}, 10000).unref();

// Riwayat perpindahan access point: dicatat tiap kali MAC access point (info.ap) sebuah ESP32 berubah
// antar pesan status. Berlaku untuk perpindahan karena roaming maupun sambung-ulang ke AP lain.
const AP_CHANGES_FILE = path.join(ROOT, 'ap-changes.json');
const AP_CHANGES_MAX = 100;
const apChanges = (() => { try { const a = JSON.parse(fs.readFileSync(AP_CHANGES_FILE, 'utf-8')); return Array.isArray(a) ? a : []; } catch (e) { return []; } })();
const lastApByCrane = new Map(); // craneId -> { ap, rssi } terakhir yang dilaporkan (bertahan walau Last Will menimpa info perangkat)
// Riwayat restart ESP32: terdeteksi dari uptime_s yang tiba-tiba turun antar pesan status.
// "rst" = penyebab restart yang dilaporkan chip (watchdog / brownout / crash / listrik-nyala ...).
const RESTARTS_FILE = path.join(ROOT, 'restarts.json');
const RESTARTS_MAX = 100;
const restartLog = (() => { try { const a = JSON.parse(fs.readFileSync(RESTARTS_FILE, 'utf-8')); return Array.isArray(a) ? a : []; } catch (e) { return []; } })();
const lastUptimeByCrane = new Map(); // craneId -> uptime_s terakhir yang dilaporkan
function restartFromStatus(craneId, info, now) {
    if (!info || info.online === false || !Number.isFinite(info.uptime_s)) return;
    const prev = lastUptimeByCrane.get(craneId);
    lastUptimeByCrane.set(craneId, info.uptime_s);
    if (prev === undefined || info.uptime_s + 5 >= prev) return; // pesan pertama sejak server naik, atau uptime normal
    restartLog.unshift({
        at: now - info.uptime_s * 1000,                       // perkiraan kapan alat restart
        craneId,
        rst: typeof info.rst === 'string' ? info.rst.slice(0, 24) : null,
        ranMs: prev * 1000,                                    // sempat menyala berapa lama sebelum restart
        fw: typeof info.fw === 'string' ? info.fw.slice(0, 16) : null
    });
    restartLog.length = Math.min(restartLog.length, RESTARTS_MAX);
    try { fs.writeFileSync(RESTARTS_FILE, JSON.stringify(restartLog, null, 1) + '\n'); } catch (e) { console.error('[Restart] gagal menyimpan restarts.json:', e.message); }
}
const espApDb = new Map(); // craneId -> [{ mac, ch, rssi }] daftar AP yang dikenal ESP32 (dikirim firmware tiap ~30 detik)
function apChangeFromStatus(craneId, info, now) {
    if (info && typeof info.apdb === 'string') {
        const list = info.apdb.split(';').filter(Boolean).slice(0, 12).map(e => {
            const [mac, ch, rssi] = e.split(',');
            return { mac: (mac || '').slice(0, 17), ch: Number(ch) || null, rssi: Number.isFinite(Number(rssi)) ? Number(rssi) : null };
        });
        espApDb.set(craneId, list);
    }
    if (!info || info.online === false || typeof info.ap !== 'string' || !info.ap) return;
    const ap = info.ap.slice(0, 17);
    const prev = lastApByCrane.get(craneId);
    // since = kapan alat mulai di AP ini (dipertahankan selama AP-nya sama)
    lastApByCrane.set(craneId, { ap, rssi: typeof info.rssi === 'number' ? info.rssi : null, since: prev && prev.ap === ap ? prev.since : now });
    if (!prev || prev.ap === ap) return;
    apChanges.unshift({
        at: now, craneId, from: prev.ap, to: ap,
        fromRssi: prev.rssi, toRssi: typeof info.rssi === 'number' ? info.rssi : null,
        channel: Number.isFinite(info.ch) ? info.ch : null,
        why: typeof info.ap_why === 'string' ? info.ap_why.slice(0, 20) : null,   // "roaming" | "sambung-ulang" | "boot" (firmware 1.1.x terbaru)
        stayedMs: prev.since ? now - prev.since : null                              // berapa lama bertahan di AP sebelumnya
    });
    apChanges.length = Math.min(apChanges.length, AP_CHANGES_MAX);
    try { fs.writeFileSync(AP_CHANGES_FILE, JSON.stringify(apChanges, null, 1) + '\n'); } catch (e) { console.error('[AP] gagal menyimpan ap-changes.json:', e.message); }
}

// Serial Monitor jarak jauh: ESP32 mengirim baris log ke pabrik/<area>/<crane>/log SELAMA diminta
// ("log on" di topik perintah, otomatis berhenti sendiri dalam ~2 menit kalau tidak diperpanjang).
// Server hanya menyimpan sebentar di memori (ring buffer) - tidak ditulis ke disk.
const ESP_LOG_MAX = 400;
const espLogs = new Map(); // craneId -> { seq, lines: [{ n, t, text }] }
function espLogPush(craneId, text, now = Date.now()) {
    let b = espLogs.get(craneId);
    if (!b) { b = { seq: 0, lines: [] }; espLogs.set(craneId, b); }
    b.lines.push({ n: ++b.seq, t: now, text: text.slice(0, 400) });
    if (b.lines.length > ESP_LOG_MAX) b.lines.splice(0, b.lines.length - ESP_LOG_MAX);
}
// deviceId = ESP32 yang dituju ("crane-01" atau "crane-01_2"); area diambil dari crane induknya
function espLogTarget(deviceId) {
    const p = AlarmRules.parseDeviceId(deviceId);
    if (!p) return null;
    const c = (settings.cranes || []).find(x => x.id === p.craneId);
    const d = devices.devices.get(deviceId);
    // ESP tambahan harus sudah pernah terlihat - kalau tidak, perintahnya tidak sampai ke siapa pun
    if (p.node > 1 && !d) return null;
    const area = (c && c.area) || (d && d.area);
    return area ? { area } : null;
}

// ESP32 yang menjadi sasaran OTA untuk crane c: ESP utama (selalu, walau belum pernah terlihat)
// + semua ESP tambahan yang pernah terlihat
function otaDeviceIds(c) {
    const ids = devices.ofCrane(c.id).map(d => d.id);
    return ids.includes(c.id) ? ids : [c.id, ...ids];
}

// Riwayat SEMUA upload firmware per crane (PIC, waktu, nama file yang di-upload) - beda
// dari manifest.json yang cuma menyimpan firmware yang SEKARANG aktif. Disimpan terpisah
// dari folder firmware-ota/<craneId>/ supaya riwayatnya tidak ikut hilang kalau firmware
// yang sedang ter-upload dihapus (lihat api/ota/remove).
const OTA_HISTORY_FILE = path.join(OTA_DIR, 'upload-history.json');
const OTA_HISTORY_MAX_PER_CRANE = 50; // cukup buat audit, tidak perlu tak terbatas

function readOtaHistory() {
    try { return JSON.parse(fs.readFileSync(OTA_HISTORY_FILE, 'utf-8')); } catch (e) { return {}; }
}
function appendOtaHistory(craneId, entry) {
    const history = readOtaHistory();
    const list = history[craneId] || [];
    list.unshift(entry); // terbaru di depan
    history[craneId] = list.slice(0, OTA_HISTORY_MAX_PER_CRANE);
    fs.mkdirSync(OTA_DIR, { recursive: true });
    fs.writeFileSync(OTA_HISTORY_FILE, JSON.stringify(history, null, 2) + '\n');
}

// Versi firmware dibuat otomatis (tidak lagi diisi manual dari Pengaturan) - mulai dari
// 1.1.1 untuk crane yang belum pernah di-upload, lalu naik 1 di angka patch (X.Y.Z ->
// X.Y.(Z+1)) tiap kali upload baru untuk crane yang sama.
function nextFirmwareVersion(previousManifest) {
    if (!previousManifest || !/^\d+\.\d+\.\d+$/.test(previousManifest.version)) return '1.1.1';
    const parts = previousManifest.version.split('.').map(Number);
    parts[2] += 1;
    return parts.join('.');
}

const cleanName = v => (typeof v === 'string' ? v.trim().slice(0, 40) : '');

// Sama seperti readJson tapi untuk body mentah (binary) - dipakai upload firmware .bin
// dari halaman Pengaturan. Tidak mengecek Content-Type (browser mengirim
// application/octet-stream lewat fetch(..., {body: file}), tapi tidak semua browser sama).
function readBinary(req, res, maxBytes, handler) {
    const chunks = [];
    let total = 0;
    let responded = false;

    function tooLarge() {
        if (responded) return;
        responded = true;
        // Kirim respons DULU baru putus koneksi - kalau dibalik, client cuma lihat koneksi
        // mati mendadak tanpa pesan error yang jelas.
        sendJson(res, 413, { error: `File terlalu besar (maksimal ${Math.round(maxBytes / 1024 / 1024)} MB)` });
        req.destroy();
    }

    req.on('data', chunk => {
        total += chunk.length;
        if (total > maxBytes) return tooLarge();
        chunks.push(chunk);
    });
    req.on('end', () => {
        if (responded) return;
        if (total === 0) return sendJson(res, 400, { error: 'File kosong / tidak ada data terkirim' });
        try {
            handler(Buffer.concat(chunks));
        } catch (e) {
            if (!e.status) console.error('[Web] Error:', e);
            sendJson(res, e.status || 500, { error: e.status ? e.message : 'Terjadi kesalahan di server' });
        }
    });
    req.on('error', () => { /* koneksi diputus sendiri lewat req.destroy() di atas - abaikan */ });
}

function handleApiWrite(req, res, relPath) {
    if (relPath === 'api/login') {
        return readJson(req, res, 500, data => {
            const username = typeof data.username === 'string' ? data.username.trim().toLowerCase() : '';
            const password = typeof data.password === 'string' ? data.password : '';
            // Cuma dicatat untuk panel "siapa sedang online" (master saja) - lihat api/sessions.
            const ip = (req.socket.remoteAddress || '').replace(/^::ffff:/, '');
            const userAgent = (req.headers['user-agent'] || '').slice(0, 200) || null;
            const token = username && password ? authStore.login(username, password, ip, userAgent) : null;
            if (!token) {
                // Password BENAR tapi akunnya masih pengajuan -> kasih tahu statusnya.
                // Password salah tetap pesan umum (tidak membocorkan username mana yang ada).
                const st = username && password ? authStore.signupStatusFor(username, password) : null;
                if (st === 'pending') return sendJson(res, 403, { error: 'Pengajuan akun Anda masih menunggu persetujuan.' });
                if (st === 'rejected') return sendJson(res, 403, { error: 'Pengajuan akun Anda ditolak. Hubungi Maintenance.' });
                return sendJson(res, 401, { error: 'Username atau password salah' });
            }
            Auth.setCookie(res, Auth.COOKIE_NAME, token, Auth.SESSION_MS);
            sendJson(res, 200, { ok: true, username });
        });
    }
    if (relPath === 'api/signup') {
        return readJson(req, res, 1000, data => {
            const ip = (req.socket.remoteAddress || '').replace(/^::ffff:/, '');
            if (!signupAllowed(ip)) return sendJson(res, 429, { error: 'Terlalu banyak pengajuan dari perangkat ini. Coba lagi nanti.' });
            const username = typeof data.username === 'string' ? data.username.trim().toLowerCase() : '';
            const password = typeof data.password === 'string' ? data.password : '';
            const userAgent = (req.headers['user-agent'] || '').slice(0, 200) || null;
            const r = authStore.createSignup(username, password, ip, userAgent);
            if (r.error) return sendJson(res, r.code === 'exists' || r.code === 'pending' ? 409 : 400, { error: r.error });
            console.log(`[Auth] Pengajuan akun baru: "${username}" (${ip})`);
            broadcastSignups();
            sendJson(res, 200, { ok: true });
        });
    }
    if (relPath === 'api/accounts/delete') {
        // Dicek di server, bukan cuma disembunyikan di tombolnya.
        if (!isApprover(req)) return sendJson(res, 403, { error: 'Hanya staf yang boleh menghapus akun' });
        return readJson(req, res, 500, data => {
            const username = typeof data.username === 'string' ? data.username.trim().toLowerCase() : '';
            if (!username) return sendJson(res, 400, { error: 'username wajib diisi' });
            if (!authStore.deleteAccount(username)) {
                return sendJson(res, 404, { error: 'Akun tidak ditemukan, atau akun bawaan yang tidak boleh dihapus' });
            }
            // Koneksi live (SSE) akun itu ikut diputus, jadi dashboard-nya berhenti menerima data seketika
            sseClients.forEach(client => {
                if (client.gbxUser === username) {
                    sseClients.delete(client);
                    client.end();
                }
            });
            console.log(`[Auth] Akun "${username}" dihapus oleh ${req.authUser}`);
            sendJson(res, 200, { ok: true, username });
        });
    }
    if (relPath === 'api/signups/decide') {
        if (!isApprover(req)) return sendJson(res, 403, { error: 'Hanya staf yang boleh memutuskan pengajuan akun' });
        return readJson(req, res, 500, data => {
            const id = Number(data.id);
            if (!Number.isInteger(id) || (data.action !== 'approve' && data.action !== 'reject')) {
                return sendJson(res, 400, { error: 'id dan action ("approve" atau "reject") wajib diisi' });
            }
            const r = authStore.decideSignup(id, data.action, req.authUser);
            if (!r) return sendJson(res, 404, { error: 'Pengajuan tidak ditemukan atau sudah diputuskan' });
            console.log(`[Auth] Pengajuan akun "${r.username}" ${data.action === 'approve' ? 'disetujui' : 'ditolak'} oleh ${req.authUser}`);
            broadcastSignups();
            sendJson(res, 200, { ok: true, username: r.username, action: data.action });
        });
    }
    if (relPath === 'api/logout') {
        return readJson(req, res, 500, () => {
            authStore.logout(Auth.readCookie(req, Auth.COOKIE_NAME));
            Auth.clearCookie(res, Auth.COOKIE_NAME);
            sendJson(res, 200, { ok: true });
        });
    }
    if (relPath === 'api/sessions/terminate') {
        // Aturan (dicek di server, bukan cuma disembunyikan di tombolnya):
        //   - master   : boleh mematikan sesi akun LAIN (maintenance), tidak sesi master
        //   - akun lain: boleh mematikan sesi viewer & sesama akunnya, tapi bukan sesi dirinya
        //                sendiri (itu fungsi tombol Keluar). Sesi master tidak boleh disentuh.
        return readJson(req, res, 500, data => {
            const id = Number(data.id);
            if (!Number.isFinite(id)) return sendJson(res, 400, { error: 'id sesi wajib diisi' });
            const target = authStore.peekSessionUsername(id);
            if (req.authUser === 'master') {
                if (target === 'master') return sendJson(res, 400, { error: 'Tidak bisa mematikan sesi Anda sendiri lewat sini - pakai tombol Keluar' });
            } else {
                // Sesi master dijawab "tidak ditemukan" - keberadaannya tidak dibocorkan.
                // Sesi viewer & sesama maintenance boleh dimatikan.
                if (!target || target === 'master') return sendJson(res, 404, { error: 'Sesi tidak ditemukan atau sudah tidak aktif' });
                if (id === authStore.sessionIdOf(Auth.readCookie(req, Auth.COOKIE_NAME))) {
                    return sendJson(res, 400, { error: 'Ini sesi Anda sendiri - pakai tombol Keluar' });
                }
            }
            const username = authStore.terminateSession(id);
            if (!username) return sendJson(res, 404, { error: 'Sesi tidak ditemukan atau sudah tidak aktif' });
            console.log(`[Auth] Sesi "${username}" dimatikan oleh ${req.authUser}`);
            sendJson(res, 200, { ok: true, username });
        });
    }
    if (relPath === 'api/settings/audit/delete') {
        // Dicek di server, bukan cuma disembunyikan di tombolnya.
        if (!isStaff(req.authRole)) return sendJson(res, 403, { error: 'Cuma staf yang boleh menghapus riwayat perubahan' });
        return readJson(req, res, 500, data => {
            let removed;
            if (data.all === true) {
                removed = auditDeleteAll.run().changes;
            } else {
                const id = Number(data.id);
                if (!Number.isInteger(id)) return sendJson(res, 400, { error: 'id atau all:true wajib diisi' });
                removed = auditDeleteOne.run(id).changes;
                if (!removed) return sendJson(res, 404, { error: 'Catatan tidak ditemukan (mungkin sudah dihapus)' });
            }
            broadcast('audit', {}); // halaman Pengaturan yang terbuka (master & maintenance) memuat ulang daftarnya
            sendJson(res, 200, { ok: true, removed });
        });
    }
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
    if (relPath === 'api/devices/remove') {
        return readJson(req, res, 2000, data => {
            if (typeof data.craneId !== 'string' || !devices.remove(data.craneId)) {
                return sendJson(res, 404, { error: 'Perangkat tidak ditemukan' });
            }
            sendJson(res, 200, { ok: true });
        });
    }
    if (relPath === 'api/ota/upload') {
        const q = new URL(req.url, 'http://x').searchParams;
        const craneId = q.get('craneId') || '';
        const uploadedBy = cleanName(q.get('uploadedBy') || '');
        // Nama file asli yang dipilih user (buat ditampilkan di riwayat) - file yang
        // benar-benar disimpan di server TETAP GBXMQTT.bin, ini cuma label tampilan.
        const fileName = (q.get('fileName') || '').trim().slice(0, 120) || 'GBXMQTT.bin';
        // craneId = ID perangkat: "crane-01" (ESP utama) atau "crane-01_2" (ESP tambahan crane itu)
        const target = AlarmRules.parseDeviceId(craneId);
        if (!target || !(settings.cranes || []).some(c => c.id === target.craneId)) {
            return sendJson(res, 404, { error: `Crane "${craneId}" tidak ditemukan` });
        }
        // Nama PIC/operator WAJIB diisi, dicek juga di sini (bukan cuma di tombol
        // frontend) supaya tidak bisa dilewati dengan memanggil endpoint ini langsung.
        if (!uploadedBy) {
            return sendJson(res, 400, { error: 'Nama PIC/operator yang meng-upload wajib diisi' });
        }
        // 4 MB - firmware ESP32 biasanya 1-1.5 MB, ini sudah longgar
        return readBinary(req, res, 4 * 1024 * 1024, buf => {
            const craneDir = path.join(OTA_DIR, craneId);
            fs.mkdirSync(craneDir, { recursive: true });
            let previous = null;
            try { previous = JSON.parse(fs.readFileSync(path.join(craneDir, 'manifest.json'), 'utf-8')); } catch (e) { /* belum pernah ada */ }
            // Versi dibaca dari penanda "GBXFWVER=x.y.z" yang ditanam di dalam .bin (dari FW_VERSION
            // di GBXMQTT.ino), jadi angka di dashboard SELALU sama dengan yang dilaporkan ESP32.
            // Firmware lama tanpa penanda -> cadangan: otomatis mulai 1.1.1, naik 1 di angka patch
            // tiap upload baru untuk crane yang sama (lihat nextFirmwareVersion).
            const embedded = (buf.toString('latin1').match(/GBXFWVER=(\d+\.\d+\.\d+)/) || [])[1] || null;
            const version = embedded || nextFirmwareVersion(previous);
            fs.writeFileSync(path.join(craneDir, 'GBXMQTT.bin'), buf);
            const manifest = {
                craneId, version, versionSource: embedded ? 'firmware' : 'auto', file: 'GBXMQTT.bin', sizeBytes: buf.length,
                sha256: crypto.createHash('sha256').update(buf).digest('hex'),
                releasedAt: new Date().toISOString(), // timestamp lengkap (tanggal + jam) saat Publish diklik
                uploadedBy,                            // nama PIC/operator yang meng-upload firmware ini
                previousVersion: previous ? previous.version : null
            };
            fs.writeFileSync(path.join(craneDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
            appendOtaHistory(craneId, { at: Date.now(), by: uploadedBy, fileName, version });
            otaClear(craneId); // permintaan update lama sudah tidak relevan untuk firmware baru ini
            console.log(`[OTA] Firmware v${version} (${embedded ? 'dibaca dari .bin' : 'otomatis'}) untuk "${craneId}" di-upload oleh ${uploadedBy}`);
            sendJson(res, 200, { ok: true, manifest });
        });
    }
    if (relPath === 'api/history/clear') {
        // Hapus riwayat pindah access point dan/atau riwayat restart di halaman Status Sistem
        if (!isStaff(req.authRole)) return sendJson(res, 403, { error: 'Cuma staf yang boleh menghapus riwayat' });
        return readJson(req, res, 500, data => {
            const what = data.what;
            if (!['ap', 'restart', 'all'].includes(what)) return sendJson(res, 400, { error: 'Pilih riwayat yang dihapus: ap, restart, atau all' });
            if (what === 'ap' || what === 'all') {
                apChanges.length = 0;
                try { fs.writeFileSync(AP_CHANGES_FILE, '[]\n'); } catch (e) { console.error('[AP] gagal menulis ap-changes.json:', e.message); }
            }
            if (what === 'restart' || what === 'all') {
                restartLog.length = 0;
                try { fs.writeFileSync(RESTARTS_FILE, '[]\n'); } catch (e) { console.error('[Restart] gagal menulis restarts.json:', e.message); }
            }
            console.log(`[Riwayat] ${what === 'all' ? 'Semua riwayat' : what === 'ap' ? 'Riwayat pindah AP' : 'Riwayat restart'} dihapus oleh ${req.authUser}`);
            sendJson(res, 200, { ok: true });
        });
    }
    if (relPath === 'api/esp/log/start' || relPath === 'api/esp/log/stop') {
        // Hanya staf. (Viewer sudah ditolak di gerbang atas; ini lapis kedua.)
        if (!isStaff(req.authRole)) return sendJson(res, 403, { error: 'Cuma staf yang boleh membuka Serial Monitor' });
        return readJson(req, res, 500, data => {
            const target = typeof data.craneId === 'string' ? espLogTarget(data.craneId) : null;
            if (!target) return sendJson(res, 404, { error: 'Crane tidak ditemukan' });
            if (!mqttClient.connected) return sendJson(res, 503, { error: 'Belum terhubung ke broker MQTT, coba lagi sebentar' });
            const start = relPath === 'api/esp/log/start';
            mqttClient.publish(`pabrik/${target.area}/${data.craneId}/perintah`, start ? 'log on' : 'log off');
            const b = espLogs.get(data.craneId);
            sendJson(res, 200, { ok: true, last: b ? b.seq : 0 });
        });
    }
    if (relPath === 'api/ota/trigger') {
        return readJson(req, res, 2000, data => {
            // Crane tertentu, atau all:true = semua crane aktif yang SUDAH punya firmware
            // ter-upload untuk dirinya sendiri (yang belum, dilewati - tidak ada gunanya
            // disuruh update kalau belum ada file yang bisa diunduhnya).
            // Sasarannya per ESP32 (ID perangkat): crane dengan 2 ESP32 = 2 sasaran, masing-masing
            // mengunduh .bin-nya sendiri dari firmware-ota/<id-perangkat>/.
            const hasFirmware = id => fs.existsSync(path.join(OTA_DIR, id, 'manifest.json'));
            let targets;
            if (data.all) {
                targets = (settings.cranes || []).filter(c => c.installed)
                    .flatMap(c => otaDeviceIds(c).filter(hasFirmware).map(id => ({ id, area: c.area })));
            } else {
                const p = AlarmRules.parseDeviceId(data.craneId);
                const c = p && (settings.cranes || []).find(x => x.id === p.craneId);
                targets = c && (p.node === 1 || devices.devices.has(data.craneId)) ? [{ id: data.craneId, area: c.area }] : [];
            }
            if (targets.length === 0) {
                return sendJson(res, 404, { error: data.all ? 'Belum ada crane dengan firmware ter-upload' : 'Crane tidak ditemukan' });
            }
            if (!mqttClient.connected) return sendJson(res, 503, { error: 'Belum terhubung ke broker MQTT, coba lagi sebentar' });
            const by = cleanName(data.by);
            targets.forEach(t => {
                mqttClient.publish(`pabrik/${t.area}/${t.id}/perintah`, 'ota');
                let version = null;
                try { version = JSON.parse(fs.readFileSync(path.join(OTA_DIR, t.id, 'manifest.json'), 'utf-8')).version; } catch (e) { /* manifest tak terbaca */ }
                otaStart(t.id, by, version);
            });
            recordOtaTrigger(targets.map(t => t.id), by);
            sendJson(res, 200, { ok: true, triggered: targets.map(t => t.id) });
        });
    }
    if (relPath === 'api/ota/remove') {
        return readJson(req, res, 2000, data => {
            const craneId = data.craneId; // ID perangkat ("crane-01" / "crane-01_2")
            if (typeof craneId !== 'string') return sendJson(res, 400, { error: 'craneId wajib diisi' });
            if (!AlarmRules.parseDeviceId(craneId)) return sendJson(res, 400, { error: 'ID perangkat tidak valid' });

            const craneDir = path.join(OTA_DIR, craneId);
            let manifest;
            try {
                manifest = JSON.parse(fs.readFileSync(path.join(craneDir, 'manifest.json'), 'utf-8'));
            } catch (e) {
                return sendJson(res, 404, { error: `Belum ada firmware ter-upload untuk crane "${craneId}"` });
            }

            // Opsi B: selama ESP32 belum konfirmasi menjalankan versi ini, firmware
            // yang di-upload masih boleh dihapus. Dicek di server (bukan cuma
            // disembunyikan di tombol) supaya tidak bisa dilewati dengan memanggil
            // endpoint ini langsung sementara firmware itu sudah benar-benar terpasang.
            const device = devices.devices.get(craneId);
            const currentFw = device && device.info && device.info.fw;
            if (currentFw && currentFw === manifest.version) {
                return sendJson(res, 409, { error: `Firmware v${manifest.version} sudah terpasang di ESP32 "${craneId}" - tidak bisa dihapus. Upload versi baru untuk menggantinya.` });
            }

            try {
                fs.rmSync(craneDir, { recursive: true, force: true });
            } catch (e) {
                return sendJson(res, 500, { error: `Gagal menghapus file firmware: ${e.message}` });
            }

            // Riwayat "diminta update" untuk crane ini ikut dihapus - firmware yang
            // diminta itu sudah tidak jadi dipasang.
            const log = readOtaLog();
            if (log[craneId]) {
                delete log[craneId];
                fs.writeFileSync(OTA_LOG_FILE, JSON.stringify(log, null, 2) + '\n');
            }

            otaClear(craneId); // status progres update untuk firmware yang dihapus ikut dibersihkan

            console.log(`[OTA] Firmware v${manifest.version} untuk "${craneId}" dihapus${data.by ? ' oleh ' + cleanName(data.by) : ''}`);
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

// ============================================================
// EXCEL LOG PER CRANE - dibuat saat diklik
// ============================================================
// Berat (~1,3 detik CPU & ~500 MB memori per file), jadi: (1) dikerjakan di worker thread
// (server alarm tidak ikut macet, memorinya dilepas setelah selesai), (2) satu pembuatan
// sekali jalan lewat antrian, (3) hasilnya dipakai ulang EXCEL_CACHE_MS supaya klik berulang
// tidak menghitung ulang, (4) permintaan yang sama berbarengan berbagi satu pembuatan.
const EXCEL_DIR = path.join(ROOT, 'excel');
const EXCEL_CACHE_MS = 5 * 60 * 1000;
const EXCEL_TIMEOUT_MS = 90 * 1000;
const EXCEL_MAX_WAITING = 6;      // pembuatan yang menunggu/berjalan; lebih dari ini -> 503
const excelJobs = new Map();      // craneId -> Promise (dibagi antar permintaan yang sama)
let excelChain = Promise.resolve();
let excelWaiting = 0;

function excelFilePath(craneId) {
    return path.join(EXCEL_DIR, `${craneId}.xlsx`);
}

function excelIsFresh(file) {
    try {
        return Date.now() - fs.statSync(file).mtimeMs < EXCEL_CACHE_MS;
    } catch (e) {
        return false;
    }
}

function runExcelWorker(craneId) {
    return new Promise((resolve, reject) => {
        const worker = new Worker(path.join(ROOT, 'excel_worker.js'), {
            workerData: { craneId, excelDir: EXCEL_DIR, days: 7, nowMs: Date.now() }
        });
        const timer = setTimeout(() => {
            worker.terminate();
            reject(new Error('Pembuatan Excel terlalu lama'));
        }, EXCEL_TIMEOUT_MS);
        worker.once('message', msg => {
            clearTimeout(timer);
            if (msg.ok) resolve(msg.path);
            else reject(new Error(msg.error));
        });
        worker.once('error', err => { clearTimeout(timer); reject(err); });
        worker.once('exit', code => { clearTimeout(timer); if (code !== 0) reject(new Error(`worker berhenti (kode ${code})`)); });
    });
}

// Path file Excel crane itu (dibuat dulu kalau belum ada / kadaluarsa); null kalau belum ada data sama sekali
function getCraneExcel(craneId) {
    const file = excelFilePath(craneId);
    if (excelIsFresh(file)) return Promise.resolve(file);
    if (excelJobs.has(craneId)) return excelJobs.get(craneId);
    if (excelWaiting >= EXCEL_MAX_WAITING) {
        const err = new Error('Server sedang menyiapkan banyak file Excel, coba lagi sebentar');
        err.status = 503;
        return Promise.reject(err);
    }
    excelWaiting++;
    const job = excelChain.then(() => runExcelWorker(craneId)).finally(() => {
        excelWaiting--;
        excelJobs.delete(craneId);
    });
    excelChain = job.catch(() => { /* satu yang gagal tidak menghentikan antrian */ });
    excelJobs.set(craneId, job);
    return job;
}

function handleExcelDownload(req, res, craneId) {
    const crane = (settings.cranes || []).find(c => c.id === craneId);
    if (!crane || !crane.installed) return sendJson(res, 404, { error: 'Crane tidak ditemukan atau belum terpasang' });
    getCraneExcel(craneId).then(file => {
        if (!file) return sendJson(res, 404, { error: `Belum ada data ${crane.name} dalam 7 hari terakhir, jadi belum ada log yang bisa diunduh.` });
        fs.stat(file, (err, stat) => {
            if (err) return sendJson(res, 500, { error: 'File Excel tidak bisa dibaca' });
            res.writeHead(200, {
                'Content-Type': CONTENT_TYPES['.xlsx'],
                'Content-Length': stat.size,
                'Content-Disposition': `attachment; filename="${craneId}_log-7-hari.xlsx"`,
                'Cache-Control': 'no-store'
            });
            fs.createReadStream(file).pipe(res);
        });
    }).catch(err => {
        console.error(`[Excel] ${craneId}:`, err.message);
        sendJson(res, err.status || 500, { error: err.status ? err.message : 'Gagal membuat file Excel. Coba lagi sebentar.' });
    });
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

const auditQuery = db.prepare('SELECT id, at, by, action, changes FROM settings_changes ORDER BY id DESC LIMIT 100');
const auditDeleteAll = db.prepare('DELETE FROM settings_changes');
const auditDeleteOne = db.prepare('DELETE FROM settings_changes WHERE id = ?');

const server = http.createServer((req, res) => {
    let relPath;
    try {
        relPath = decodeURIComponent(new URL(req.url, 'http://x').pathname).replace(/^\/+/, '');
    } catch (e) {
        res.writeHead(400);
        return res.end('Bad request');
    }
    if (relPath === '') relPath = 'index.html';

    // Semua halaman/API di bawah ini wajib login, kecuali login.html sendiri &
    // firmware-ota/* (diunduh ESP32, tidak lewat browser/cookie).
    if (!isPublicPath(relPath, req.method)) {
        const username = authStore.resolveSession(Auth.readCookie(req, Auth.COOKIE_NAME));
        if (!username) {
            if (relPath.endsWith('.html') || relPath === 'index.html') {
                res.writeHead(302, { Location: '/login.html' });
                return res.end();
            }
            return sendJson(res, 401, { error: 'Belum login' });
        }
        req.authUser = username;
        req.authRole = authStore.roleOf(username);
        // viewer: HANYA halaman dashboard & datanya (lihat VIEWER_GET). Sisanya ditolak di sini,
        // sebelum sampai ke endpoint mana pun - bukan cuma disembunyikan di tampilannya.
        if (req.authRole === 'viewer' && !viewerMayAccess(relPath, req.method)) {
            if (relPath.endsWith('.html')) {
                res.writeHead(302, { Location: '/index.html' });
                return res.end();
            }
            return sendJson(res, 403, { error: 'Akun ini hanya bisa melihat dashboard monitoring' });
        }
    }

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
        res.gbxRole = req.authRole;
        res.gbxUser = req.authUser; // supaya koneksi live akun yang dihapus master bisa diputus
        sendEvent(res, 'devices', deviceListFor(req.authRole));
        if (isStaff(req.authRole)) sendEvent(res, 'signups', { pending: authStore.pendingCount() });
        sseClients.add(res);
        req.on('close', () => sseClients.delete(res));
        return;
    }
    const excelMatch = req.method === 'GET' && relPath.match(/^api\/excel\/([\w-]+)$/);
    if (excelMatch) return handleExcelDownload(req, res, excelMatch[1]);
    if (relPath === 'api/health') return sendJson(res, 200, buildHealth());
    // now = jam server (epoch ms): dashboard memakainya sebagai acuan jam, bukan jam perangkat
    if (relPath === 'api/me') return sendJson(res, 200, { username: req.authUser, role: req.authRole, now: Date.now() });
    if (relPath === 'api/accounts') {
        if (!isApprover(req)) return sendJson(res, 403, { error: 'Hanya staf yang boleh melihat daftar akun' });
        const online = new Set(authStore.listActiveSessions().map(s => s.username));
        return sendJson(res, 200, {
            accounts: authStore.listAccounts()
                .filter(a => a.role === 'viewer')
                .map(a => ({ username: a.username, createdAt: a.createdAt, online: online.has(a.username) }))
        });
    }
    if (relPath === 'api/signups') {
        if (!isApprover(req)) return sendJson(res, 403, { error: 'Hanya staf yang boleh melihat pengajuan akun' });
        return sendJson(res, 200, { signups: authStore.pendingSignups() });
    }
    if (relPath === 'api/sessions') {
        // Panel "siapa sedang online". Master melihat semua sesi; maintenance melihat
        // semua KECUALI sesi master (termasuk sesi viewer, supaya bisa dimatikan).
        // Difilter di sini, bukan di browser, supaya sesi master tidak pernah
        // terkirim ke akun lain.
        return sendJson(res, 200, {
            sessions: authStore.listActiveSessions({
                hideUsernames: req.authUser === 'master' ? [] : ['master'],
                currentToken: Auth.readCookie(req, Auth.COOKIE_NAME)
            })
        });
    }
    if (relPath === 'api/alarms') return sendJson(res, 200, engine.snapshot());
    if (relPath === 'api/settings') return sendJson(res, 200, settings);
    if (relPath === 'api/devices') return sendJson(res, 200, deviceList());
    if (relPath === 'api/ota/manifests') {
        // Per ESP32: folder firmware-ota/<id-perangkat>/ milik crane yang masih terdaftar
        const result = {};
        let dirs = [];
        try { dirs = fs.readdirSync(OTA_DIR, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name); } catch (e) { /* folder belum ada */ }
        dirs.forEach(id => {
            const p = AlarmRules.parseDeviceId(id);
            if (!p || !(settings.cranes || []).some(c => c.id === p.craneId)) return;
            try { result[id] = JSON.parse(fs.readFileSync(path.join(OTA_DIR, id, 'manifest.json'), 'utf-8')); }
            catch (e) { /* belum pernah upload firmware untuk ESP32 ini - wajar */ }
        });
        return sendJson(res, 200, result);
    }
    if (relPath === 'api/ota/history') {
        const q = new URL(req.url, 'http://x').searchParams;
        const craneId = q.get('craneId');
        const history = readOtaHistory();
        return sendJson(res, 200, craneId ? (history[craneId] || []) : history);
    }
    if (relPath === 'api/esp/log') {
        if (!isStaff(req.authRole)) return sendJson(res, 403, { error: 'Cuma staf yang boleh membuka Serial Monitor' });
        const q = new URL(req.url, 'http://x').searchParams;
        const craneId = q.get('craneId') || '';
        const after = Number(q.get('after')) || 0;
        const b = espLogs.get(craneId) || { seq: 0, lines: [] };
        const d = devices.devices.get(craneId);
        // after > seq = server di-restart sejak panel dibuka -> mulai dari awal lagi
        const lines = b.lines.filter(l => l.n > (after > b.seq ? 0 : after)).slice(-200);
        return sendJson(res, 200, { lines, last: b.seq, online: d ? d.online !== false : false, fw: d && d.info ? d.info.fw || null : null });
    }
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
        return sendJson(res, 200, {
            wsPort: WS_PORT, serverIp: localLanIp(),
            ...(creds.dashboard ? { username: 'dashboard', password: creds.dashboard } : {})
        });
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