// ============================================================
// START SERVICE DI BELAKANG LAYAR (npm run service)
// ============================================================
// Menjalankan run-all.js (broker + logger + web) sebagai proses TERPISAH,
// tanpa jendela sama sekali - beda dengan "node run-all.js" langsung, yang
// nempel ke terminal tempat dia dipanggil (tutup terminalnya = ikut mati).
//
// Setelah ini, "npm run service" langsung selesai dalam sedetik - itu normal,
// bukan berarti servicenya mati. Broker/logger/web tetap jalan di belakang.
//
//   Cek statusnya   : buka http://localhost:8080/status.html
//   Matikan lagi    : npm run stop-service
//   Lihat log       : folder service-logs/
//
// Opsi run-all.js (mis. --no-broker) tetap bisa dipakai:
//   npm run service -- --no-broker
//
// CATATAN: Task Scheduler (scripts/install-autostart.ps1) TIDAK lewat skrip
// ini - dia memanggil run-all.js langsung, karena Task Scheduler sendiri
// sudah jalan tanpa jendela DAN bisa mendeteksi + me-restart kalau crash
// (RestartCount/RestartInterval). Menambah lapisan detach di sini cuma akan
// bikin Task Scheduler mengira tugasnya "selesai" padahal proses sebenarnya
// masih di belakang, sehingga fitur auto-restart-nya tidak berfungsi lagi.

const { spawn } = require('child_process');
const path = require('path');

const ROOT = path.join(__dirname, '..');

const child = spawn(process.execPath, [path.join(ROOT, 'run-all.js'), ...process.argv.slice(2)], {
    cwd: ROOT,
    detached: true,
    windowsHide: true,
    stdio: 'ignore'
});
child.unref();

console.log(`[Start] run-all.js dijalankan di belakang layar (PID ${child.pid}), tanpa jendela.`);
console.log('[Start] Aman menutup terminal ini - broker/logger/web tetap jalan.');
console.log('[Start] Cek status: http://localhost:8080/status.html');
console.log('[Start] Matikan lagi: npm run stop-service');
