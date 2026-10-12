// ============================================================
// APLIKASI MONITORING - dashboard sebagai jendela aplikasi, tanpa CMD
// ============================================================
// Dipanggil oleh "Monitoring Gearbox.bat" (lewat pintasan di Desktop):
//   1. Menyalakan broker + logger + web server di belakang layar (run-all.js --quiet).
//   2. Membuka dashboard sebagai JENDELA APLIKASI (Chrome / Edge mode --app: tanpa
//      tab & address bar) dengan profil browser khusus, jadi login-nya tersimpan
//      dan tidak bercampur dengan browser biasa.
//   3. Begitu jendela dashboard itu DITUTUP, semuanya dimatikan.
//
// Kalau monitoring ternyata sudah jalan (klik kedua, atau jalan di latar belakang
// lewat "npm run service" / autostart), skrip ini cuma membuka jendela dashboard dan
// TIDAK mematikan apa pun saat jendela ditutup - hanya yang dinyalakan skrip ini
// sendiri yang dimatikan.
//
// Kalau gagal (mis. mosquitto.exe tidak ketemu), muncul kotak pesan - tidak diam saja.

const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PORT = Number(process.env.PORT) || 8080;
const DASHBOARD_URL = `http://localhost:${PORT}`;
const LOCK_FILE = path.join(ROOT, 'app.lock');
const PROFILE_DIR = path.join(process.env.LOCALAPPDATA || os.tmpdir(), 'GearboxMonitoring', 'browser-profile');
const START_TIMEOUT_MS = 60000;
const HANDOFF_MS = 8000; // browser yang keluar secepat ini = tersambung ke jendela lama dengan profil yang sama

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const { isProcessAlive } = require('../common');

// Kunci basi (skrip ini dimatikan paksa) bisa menunjuk ke nomor proses yang sekarang dipakai
// program lain - pastikan proses itu memang node.exe.
function isNodeProcess(pid) {
    try {
        const out = execFileSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { encoding: 'utf-8', windowsHide: true });
        return /"node\.exe"/i.test(out);
    } catch (e) {
        return false;
    }
}

function healthUp() {
    return new Promise(resolve => {
        const req = http.get(`${DASHBOARD_URL}/api/health`, { timeout: 2000 }, res => {
            res.resume();
            resolve(res.statusCode === 200);
        });
        req.on('timeout', () => req.destroy());
        req.on('error', () => resolve(false));
    });
}

async function waitForHealth(timeoutMs, abortIf) {
    const until = Date.now() + timeoutMs;
    while (Date.now() < until) {
        if (abortIf && abortIf()) return false;
        if (await healthUp()) return true;
        await sleep(500);
    }
    return false;
}

function findBrowser() {
    const pf = process.env['ProgramFiles'] || 'C:\\Program Files';
    const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
    const local = process.env.LOCALAPPDATA || '';
    return [
        path.join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe'),
        path.join(pf86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
        path.join(local, 'Google', 'Chrome', 'Application', 'chrome.exe'),
        path.join(pf86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
        path.join(pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe')
    ].find(p => fs.existsSync(p)) || null;
}

// Kotak pesan Windows (tanpa jendela CMD). Teks lewat variabel lingkungan supaya
// tanda kutip / baris baru tidak merusak perintah PowerShell.
function showMessage(text) {
    return new Promise(resolve => {
        // Hanya tanda kutip TUNGGAL di dalam skrip PowerShell: tanda kutip ganda hilang saat
        // diteruskan lewat baris perintah dan skripnya gagal diparse (kotak pesan tidak muncul).
        const script = "Add-Type -AssemblyName System.Windows.Forms; " +
            "$f = New-Object System.Windows.Forms.Form; $f.TopMost = $true; " +
            "[void][System.Windows.Forms.MessageBox]::Show($f, $env:GBX_MESSAGE, 'Monitoring Gearbox Crane', 'OK', 'Warning')";
        const p = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
            windowsHide: true, stdio: 'ignore', env: { ...process.env, GBX_MESSAGE: text }
        });
        p.on('exit', resolve);
        p.on('error', resolve);
    });
}

function launchBrowser(exe) {
    fs.mkdirSync(PROFILE_DIR, { recursive: true });
    return spawn(exe, [
        `--app=${DASHBOARD_URL}`,
        `--user-data-dir=${PROFILE_DIR}`,
        '--start-maximized',
        '--autoplay-policy=no-user-gesture-required', // bunyi alarm tanpa harus diklik dulu
        '--disable-background-mode',                  // tidak tetap hidup di latar belakang setelah jendela ditutup
        '--no-first-run',
        '--no-default-browser-check'
    ], { stdio: 'ignore', detached: true }); // detached: tanpa ini Chrome ikut mati begitu skrip ini keluar
}

// Masih ada jendela browser yang memakai profil kita? (dipakai kalau browser "menitipkan"
// jendelanya ke proses lama dan proses yang kita jalankan langsung keluar)
function profileStillInUse() {
    try {
        const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
            "@(Get-CimInstance Win32_Process | Where-Object { $_.Name -in 'chrome.exe','msedge.exe' -and $_.CommandLine -like '*GearboxMonitoring*browser-profile*' }).Count"],
            { encoding: 'utf-8', windowsHide: true });
        return parseInt(out.trim(), 10) > 0;
    } catch (e) {
        return false;
    }
}

let runAll = null;      // proses run-all.js yang KITA nyalakan (null = bukan kita yang menyalakan)
let quitting = false;

function stopServices() {
    if (runAll && runAll.pid) {
        try {
            execFileSync('taskkill', ['/PID', String(runAll.pid), '/T', '/F'], { stdio: 'ignore' }); // run-all + broker + logger + web
        } catch (e) { /* sudah mati */ }
    }
    runAll = null;
}

function releaseLock() {
    try {
        if (fs.readFileSync(LOCK_FILE, 'utf-8') === String(process.pid)) fs.unlinkSync(LOCK_FILE);
    } catch (e) { /* sudah terhapus */ }
}

function quit(code) {
    quitting = true;
    stopServices();
    releaseLock();
    process.exit(code);
}

['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK'].forEach(sig => process.on(sig, () => quit(0)));

async function main() {
    const browser = findBrowser();
    if (!browser) {
        await showMessage('Google Chrome atau Microsoft Edge tidak ditemukan di komputer ini.\n\nPasang salah satunya, lalu klik lagi.');
        return 1;
    }

    // ---- Sudah jalan? (klik kedua, atau jalan di latar belakang) ----
    let otherPid = NaN;
    try { otherPid = parseInt(fs.readFileSync(LOCK_FILE, 'utf-8'), 10); } catch (e) { /* belum ada */ }
    const otherStarting = Number.isFinite(otherPid) && otherPid !== process.pid && isProcessAlive(otherPid) && isNodeProcess(otherPid);

    if (otherStarting || await healthUp()) {
        if (!(await waitForHealth(START_TIMEOUT_MS))) {
            await showMessage('Monitoring sedang dinyalakan tapi belum siap setelah 1 menit.\n\nCoba lagi sebentar, atau lihat folder service-logs.');
            return 1;
        }
        launchBrowser(browser).unref();
        return 0; // bukan kita yang menyalakan -> tidak mematikan apa pun
    }

    // ---- Nyalakan sendiri ----
    fs.writeFileSync(LOCK_FILE, String(process.pid));
    let tail = '';
    let exited = false;
    let serving = false;

    runAll = spawn(process.execPath, [path.join(ROOT, 'run-all.js'), '--quiet'], {
        cwd: ROOT, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']
    });
    const keep = chunk => { tail = (tail + chunk.toString()).slice(-600); };
    runAll.stdout.on('data', keep);
    runAll.stderr.on('data', keep);
    runAll.on('exit', async () => {
        exited = true;
        if (serving && !quitting) {
            // sudah jalan lalu berhenti sendiri (bukan karena jendela ditutup)
            await showMessage('Layanan monitoring berhenti tiba-tiba.\n\nCatatan ada di folder service-logs. Tutup jendela dashboard lalu klik lagi untuk menyalakan ulang.');
            quit(1);
        }
    });

    if (!(await waitForHealth(START_TIMEOUT_MS, () => exited))) {
        const why = tail.trim() || 'Tidak ada keterangan. Lihat folder service-logs.';
        stopServices();
        releaseLock();
        await showMessage(`Monitoring gagal menyala.\n\n${why}\n\nCek "mosquittoDir" di service-config.json, atau apakah port ${PORT} / 1883 dipakai program lain.`);
        return 1;
    }
    serving = true;

    // ---- Buka jendela dashboard; ditutup = semuanya dimatikan ----
    const startedAt = Date.now();
    const win = launchBrowser(browser);
    win.on('error', async () => {
        await showMessage('Gagal membuka jendela dashboard.');
        quit(1);
    });
    win.on('exit', async () => {
        if (Date.now() - startedAt < HANDOFF_MS) {
            // keluar terlalu cepat: jendelanya dititipkan ke proses browser lama -> tunggu sampai benar-benar tertutup
            while (profileStillInUse()) await sleep(3000);
        }
        quit(0);
    });
    return null; // tetap hidup menunggu jendela ditutup
}

main().then(code => {
    if (code !== null) process.exit(code);
}).catch(async err => {
    await showMessage(`Terjadi kesalahan: ${err.message}`);
    quit(1);
});