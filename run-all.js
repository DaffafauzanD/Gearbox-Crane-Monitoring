// ============================================================
// RUN-ALL - nyalakan broker + logger + web server sekaligus, dan jaga tetap hidup
// ============================================================
// Jalankan:  npm run service          (sama dengan: node run-all.js)
//
// Yang dijalankan:
//   broker  -> mosquitto.exe -c mosquitto.conf (lokasi dari service-config.json)
//   logger  -> mqtt_logger.js
//   web     -> server.js (dashboard di http://localhost:8080)
// Kalau salah satu mati/crash, otomatis dinyalakan ulang (jeda makin lama kalau
// crash terus-terusan, maks 60 detik). Semua output juga ditulis ke folder
// service-logs/<nama>.log - berguna kalau jalan otomatis di belakang layar
// (lihat scripts/install-autostart.ps1).
//
// Kalau Mosquitto sudah jalan sendiri (mis. sebagai Windows Service), pakai:
//     node run-all.js --no-broker
//
// Mode senyap (dipakai "Monitoring Gearbox.bat"): tambahkan --quiet supaya log TIDAK
// dicetak ke jendela konsol, hanya ke service-logs/. Ini penting kalau jendelanya
// dibiarkan terbuka: konsol Windows yang kebanjiran teks, atau yang sempat diklik
// (QuickEdit), bisa menahan proses sampai ada tombol ditekan.
//     node run-all.js --quiet

const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const LOG_DIR = path.join(ROOT, 'service-logs');
const LOCK_FILE = path.join(ROOT, 'run-all.lock');
const CHILDREN_FILE = path.join(ROOT, 'run-all.children.json');
const MAX_LOG_BYTES = 5 * 1024 * 1024; // lebih dari ini -> file lama diganti nama jadi .log.1
const { WIB_OFFSET_MS } = require('./common');
const QUIET = process.argv.includes('--quiet'); // tidak mencetak log ke konsol (tetap ditulis ke file)

// ---- cegah run-all jalan dobel (sama seperti logger.lock) ----
const { isProcessAlive } = require('./common');
if (fs.existsSync(LOCK_FILE)) {
    const pid = parseInt(fs.readFileSync(LOCK_FILE, 'utf-8'), 10);
    if (pid && pid !== process.pid && isProcessAlive(pid)) {
        console.error(`[run-all] Sudah jalan (PID ${pid}). Tutup yang lama dulu.`);
        process.exit(1);
    }
}
fs.writeFileSync(LOCK_FILE, String(process.pid));

// ---- daftar layanan ----
let config = {};
try {
    config = JSON.parse(fs.readFileSync(path.join(ROOT, 'service-config.json'), 'utf-8'));
} catch (e) { /* dicek di bawah */ }

const services = [];
if (!process.argv.includes('--no-broker')) {
    const exe = path.join(config.mosquittoDir || '', 'mosquitto.exe');
    if (!config.mosquittoDir || !fs.existsSync(exe)) {
        console.error('[run-all] mosquitto.exe tidak ditemukan. Isi "mosquittoDir" di service-config.json, atau pakai --no-broker.');
        fs.unlinkSync(LOCK_FILE);
        process.exit(1);
    }
    // "mqttAuth": true -> login wajib (mosquitto.secure.conf). Default terbuka supaya
    // ESP32 yang firmware-nya belum kirim username/password tetap bisa masuk.
    const conf = config.mqttAuth === true ? 'mosquitto.secure.conf' : 'mosquitto.conf';
    services.push({ name: 'broker', cmd: exe, args: ['-c', conf] });
}
services.push({ name: 'logger', cmd: process.execPath, args: ['mqtt_logger.js'] });
services.push({ name: 'web', cmd: process.execPath, args: ['server.js'] });

// ---- log ----
fs.mkdirSync(LOG_DIR, { recursive: true });

function stamp() {
    return new Date(Date.now() + WIB_OFFSET_MS).toISOString().slice(0, 19).replace('T', ' ');
}

function writeLog(name, text) {
    const file = path.join(LOG_DIR, `${name}.log`);
    try {
        if (fs.statSync(file).size > MAX_LOG_BYTES) fs.renameSync(file, `${file}.1`);
    } catch (e) { /* file belum ada */ }
    fs.appendFileSync(file, text);
}

function log(name, message) {
    const line = `${stamp()} [${name}] ${message}`;
    if (!QUIET) console.log(line);
    writeLog(name, line + '\n');
}

// ---- bersihkan sisa proses dari run-all sebelumnya ----
// Di Windows, kalau run-all dimatikan paksa (mis. Task Scheduler "End"), proses
// anaknya (broker/logger/web) tetap hidup dan bikin bentrok port saat run-all
// jalan lagi. PID anak dicatat di run-all.children.json; yang masih hidup DAN
// memang proses kita (dicek dari command line-nya) dimatikan dulu.
function cleanupOrphans() {
    let pids = [];
    try {
        pids = JSON.parse(fs.readFileSync(CHILDREN_FILE, 'utf-8'));
    } catch (e) {
        return;
    }
    pids.forEach(pid => {
        if (!isProcessAlive(pid)) return;
        let cmdLine = '';
        try {
            cmdLine = execFileSync('powershell.exe', ['-NoProfile', '-Command',
                `(Get-CimInstance Win32_Process -Filter "ProcessId=${Number(pid)}").CommandLine`], { encoding: 'utf-8' });
        } catch (e) { /* tidak bisa dibaca -> jangan diapa-apakan */ }
        if (/mosquitto\.exe|mqtt_logger\.js|server\.js/i.test(cmdLine)) {
            try {
                execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
                log('run-all', `mematikan sisa proses lama PID ${pid}`);
            } catch (e) { /* sudah mati */ }
        }
    });
}

function saveChildren() {
    const pids = services.filter(svc => svc.child).map(svc => svc.child.pid);
    fs.writeFileSync(CHILDREN_FILE, JSON.stringify(pids));
}

// ---- jalankan & jaga ----
let stopping = false;

function start(svc) {
    const startedAt = Date.now();
    let ended = false;
    log(svc.name, `menjalankan: ${path.basename(svc.cmd)} ${svc.args.join(' ')}`);

    const child = spawn(svc.cmd, svc.args, { cwd: ROOT, windowsHide: true });
    svc.child = child;
    saveChildren();

    const onOutput = buf => buf.toString().split(/\r?\n/).forEach(l => { if (l.trim()) log(svc.name, l); });
    child.stdout.on('data', onOutput);
    child.stderr.on('data', onOutput);

    const onEnd = (reason) => {
        if (ended) return;
        ended = true;
        svc.child = null;
        if (stopping) return;
        saveChildren();

        // Jalan lama lalu mati -> cepat dinyalakan lagi. Mati terus-terusan
        // (mis. port dipakai program lain) -> jeda digandakan sampai 60 detik.
        svc.delay = (Date.now() - startedAt > 60000) ? 3000 : Math.min((svc.delay || 1500) * 2, 60000);
        log(svc.name, `berhenti (${reason}), dinyalakan ulang dalam ${svc.delay / 1000} detik`);
        setTimeout(() => start(svc), svc.delay);
    };
    child.on('exit', (code, signal) => onEnd(signal ? `sinyal ${signal}` : `kode ${code}`));
    child.on('error', err => onEnd(`gagal jalan: ${err.message}`));
}

function shutdown() {
    if (stopping) return;
    stopping = true;
    log('run-all', 'mematikan semua layanan...');
    services.forEach(svc => svc.child && svc.child.kill());
    try {
        if (fs.readFileSync(LOCK_FILE, 'utf-8') === String(process.pid)) fs.unlinkSync(LOCK_FILE);
        fs.unlinkSync(CHILDREN_FILE);
    } catch (e) { /* sudah terhapus */ }
    setTimeout(() => process.exit(0), 1000);
}
['SIGINT', 'SIGTERM', 'SIGHUP'].forEach(sig => process.on(sig, shutdown));

log('run-all', `mulai (PID ${process.pid}). Ctrl+C untuk mematikan semua.`);
cleanupOrphans();
services.forEach(start);
