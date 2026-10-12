// ============================================================
// MATIKAN SERVICE YANG JALAN DI BELAKANG LAYAR (npm run stop-service)
// ============================================================
// Karena "npm run service" (lihat scripts/start-service.js) menjalankan
// run-all.js tanpa jendela sama sekali, tidak ada Ctrl+C untuk mematikannya -
// skrip ini yang jadi tombol OFF-nya. Membaca PID dari run-all.lock, lalu
// mematikan run-all.js beserta seluruh anaknya (broker, logger, web) sekaligus
// lewat taskkill /T (kill satu pohon proses).
//
// Ini mematikan PAKSA (bukan Ctrl+C yang rapi) - tidak masalah, run-all.js
// sendiri sudah dirancang membersihkan sisa proses/lock file basi di
// awal jalan berikutnya (lihat cleanupOrphans() di run-all.js).

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const LOCK_FILE = path.join(__dirname, '..', 'run-all.lock');

const { isProcessAlive } = require('../common');

if (!fs.existsSync(LOCK_FILE)) {
    console.log('[Stop] run-all.js sepertinya tidak sedang jalan (run-all.lock tidak ada).');
    process.exit(0);
}

const pid = parseInt(fs.readFileSync(LOCK_FILE, 'utf-8'), 10);
if (!pid || !isProcessAlive(pid)) {
    console.log('[Stop] run-all.lock ada tapi PID di dalamnya sudah tidak jalan (basi). Tidak ada yang perlu dimatikan.');
    process.exit(0);
}

try {
    execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'inherit' });
    console.log(`[Stop] run-all.js (PID ${pid}) beserta broker/logger/web dimatikan.`);
} catch (e) {
    console.error(`[Stop] Gagal mematikan PID ${pid}:`, e.message);
    process.exit(1);
}
