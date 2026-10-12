// ============================================================
// SETUP LOGIN MQTT - bikin user & password untuk broker Mosquitto
// ============================================================
// Jalankan:  npm run setup-mqtt
//
// Hasilnya:
//   mqtt/credentials.json  -> daftar user & password (RAHASIA, jangan dibagikan).
//                             Dibaca mqtt_logger.js, simulate_esp32.js, dan server.js
//                             (server.js cuma meneruskan akun "dashboard" ke browser).
//   mqtt/passwd            -> versi ter-hash untuk Mosquitto (dibuat mosquitto_passwd)
//
// User yang dibuat:
//   logger     -> dipakai mqtt_logger.js
//   web        -> dipakai server.js (server alarm)
//   dashboard  -> dipakai browser (baca-saja, lihat mqtt/acl)
//   crane-XX   -> satu per crane di config/settings.json, dipakai ESP32
//
// Aman dijalankan berulang: password yang sudah ada TIDAK diganti, cuma user
// baru yang ditambahkan. Untuk ganti password satu user (mis. ESP32 hilang):
//     npm run setup-mqtt -- --reset crane-01
//
// ESP32 TAMBAHAN di crane yang sama (NODE_ID 2, 3, ... di config.h) login dengan ID
// perangkatnya sendiri, mis. "crane-01_2". Tambahkan sekali (bisa beberapa --add):
//     npm run setup-mqtt -- --add crane-01_2
//
// Setelah menjalankan ini, restart Mosquitto (atau npm run service) supaya
// password baru terbaca.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const MQTT_DIR = path.join(ROOT, 'mqtt');
const CRED_FILE = path.join(MQTT_DIR, 'credentials.json');
const PASSWD_FILE = path.join(MQTT_DIR, 'passwd');

function fail(msg) {
    console.error(`[Setup] ${msg}`);
    process.exit(1);
}

let config;
try {
    config = JSON.parse(fs.readFileSync(path.join(ROOT, 'service-config.json'), 'utf-8'));
} catch (e) {
    fail('service-config.json tidak ada/rusak. Isi "mosquittoDir" dengan folder tempat mosquitto.exe.');
}
const passwdExe = path.join(config.mosquittoDir || '', 'mosquitto_passwd.exe');
if (!fs.existsSync(passwdExe)) {
    fail(`mosquitto_passwd.exe tidak ditemukan di "${config.mosquittoDir}". Cek "mosquittoDir" di service-config.json.`);
}

const craneIds = require(path.join(ROOT, 'settings.js')).load().cranes.map(c => c.id);
if (craneIds.length === 0) fail('Tidak menemukan crane di config/settings.json.');

let creds = {};
if (fs.existsSync(CRED_FILE)) {
    try {
        creds = JSON.parse(fs.readFileSync(CRED_FILE, 'utf-8'));
    } catch (e) {
        fail(`${CRED_FILE} rusak. Perbaiki atau hapus file itu (semua password akan dibuat ulang).`);
    }
}

// ESP32 tambahan: --add crane-01_2 (boleh diulang). Yang sudah pernah ditambahkan tetap ada.
const { parseDeviceId } = require(path.join(ROOT, 'alarm_rules.js'));
const extraIds = process.argv.flatMap((a, i) => a === '--add' && process.argv[i + 1] ? [process.argv[i + 1]] : []);
extraIds.forEach(id => {
    const p = parseDeviceId(id);
    if (!p || p.node === 1) fail(`"${id}" bukan ID ESP tambahan. Formatnya <id-crane>_<node>, mis. crane-01_2.`);
    if (!craneIds.includes(p.craneId)) fail(`Crane "${p.craneId}" tidak ada di config/settings.json.`);
});

const resetIdx = process.argv.indexOf('--reset');
const resetUser = resetIdx > 0 ? process.argv[resetIdx + 1] : null;
if (resetUser) {
    if (!creds[resetUser]) fail(`User "${resetUser}" belum ada.`);
    delete creds[resetUser];
}

const newPassword = () => crypto.randomBytes(12).toString('base64url'); // 16 karakter acak
const added = [];
['logger', 'web', 'dashboard', ...craneIds, ...extraIds].forEach(user => {
    if (!creds[user]) {
        creds[user] = newPassword();
        added.push(user);
    }
});

fs.mkdirSync(MQTT_DIR, { recursive: true });
fs.writeFileSync(CRED_FILE, JSON.stringify(creds, null, 2) + '\n');

// Tulis "user:password" polos, lalu mosquitto_passwd -U mengubahnya jadi hash
fs.writeFileSync(PASSWD_FILE, Object.entries(creds).map(([u, p]) => `${u}:${p}`).join('\n') + '\n');
try {
    execFileSync(passwdExe, ['-U', PASSWD_FILE], { stdio: 'inherit' });
} catch (e) {
    fs.unlinkSync(PASSWD_FILE); // jangan tinggalkan password polos
    fail('mosquitto_passwd gagal membuat file password.');
}

console.log(`[Setup] ${Object.keys(creds).length} user MQTT siap (${added.length ? 'baru: ' + added.join(', ') : 'tidak ada user baru'}).`);
console.log(`[Setup] Password tersimpan di: ${CRED_FILE}`);
console.log('[Setup] Restart Mosquitto / npm run service supaya perubahan terbaca.');
