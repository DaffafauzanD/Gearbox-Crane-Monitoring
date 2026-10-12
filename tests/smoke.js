// ============================================================
// TES ASAP (smoke test) - jalankan:  npm test
// ============================================================
// Menyalin proyek ke folder sementara (database & akun BARU - data asli tidak tersentuh), menyalakan
// run-all.js --no-broker (logger + web) di port 5619, lalu memeriksa perilaku penting lewat HTTP:
// login & peran, pengajuan akun, pembatasan akun "hanya lihat"
// Jalankan lagi SETIAP selesai merapikan/mengubah kode: semuanya harus PASS. (Khusus Windows.)

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const PORT = 5619;
const BASE = `http://localhost:${PORT}`;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gbx-smoke-'));
let child = null;
let total = 0;
let failed = 0;

const sleep = ms => new Promise(r => setTimeout(r, ms));
function check(name, ok, extra = '') {
    total++;
    if (!ok) failed++;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && extra ? '  -> ' + extra : ''}`);
}

function prepareCopy() {
    const skip = ['package-lock.json', 'state.json', 'accounts-credentials.json', 'run-all.children.json', 'service-config.json'];
    fs.readdirSync(ROOT, { withFileTypes: true }).forEach(e => {
        if (e.isFile() && /\.(js|html|css|json)$/.test(e.name) && !skip.includes(e.name)) fs.copyFileSync(path.join(ROOT, e.name), path.join(tmp, e.name));
    });
    ['scripts', 'config'].forEach(n => fs.cpSync(path.join(ROOT, n), path.join(tmp, n), { recursive: true }));
    ['node_modules', 'vendor'].forEach(n => fs.symlinkSync(path.join(ROOT, n), path.join(tmp, n), 'junction'));
}

async function waitUp() {
    for (let i = 0; i < 60; i++) {
        try { if ((await fetch(`${BASE}/api/health`)).ok) return true; } catch (e) { /* belum naik */ }
        await sleep(500);
    }
    return false;
}

async function call(method, url, { cookie, body } = {}) {
    const res = await fetch(BASE + url, {
        method, redirect: 'manual', signal: AbortSignal.timeout(20000), // tidak boleh menggantung selamanya
        headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}) },
        body: body !== undefined ? JSON.stringify(body) : undefined
    });
    const text = await res.text();
    let json = {};
    try { json = JSON.parse(text); } catch (e) { /* bukan JSON */ }
    return { status: res.status, json, text, headers: res.headers };
}
async function login(u, p) {
    const r = await call('POST', '/api/login', { body: { username: u, password: p } });
    return { status: r.status, json: r.json, cookie: (r.headers.get('set-cookie') || '').split(';')[0] };
}

async function run() {
    const creds = JSON.parse(fs.readFileSync(path.join(tmp, 'accounts-credentials.json'), 'utf-8'));
    let r;

    // ---- dasar & login ----
    r = await call('GET', '/api/health');
    check('health publik: web, broker, logger terbaca', r.status === 200 && r.json.web && r.json.web.up && 'logger' in r.json, String(r.status));
    check('tanpa login: /api/me 401', (await call('GET', '/api/me')).status === 401);
    check('tanpa login: dashboard dialihkan ke login (302)', (await call('GET', '/index.html')).status === 302);
    check('halaman login publik (200)', (await call('GET', '/login.html')).status === 200);
    check('login salah -> 401', (await login('master', 'salah')).status === 401);
    const master = await login('master', creds.master);
    const maint = await login('maintenance', creds.maintenance);
    check('login maintenance berhasil', master.status === 200 && maint.status === 200);
    check('peran: maintenance',
        (await call('GET', '/api/me', { cookie: master.cookie })).json.role === 'master' && (await call('GET', '/api/me', { cookie: maint.cookie })).json.role === 'maintenance');

    // ---- pengajuan akun ----
    check('pengajuan akun diterima (200)', (await call('POST', '/api/signup', { body: { username: 'Budi', password: 'rahasia1' } })).status === 200);
    check('username terlarang ditolak (400)', (await call('POST', '/api/signup', { body: { username: 'admin', password: 'rahasia1' } })).status === 400);
    check('password pendek ditolak (400)', (await call('POST', '/api/signup', { body: { username: 'citra', password: '123' } })).status === 400);
    r = await login('budi', 'rahasia1');
    check('login sebelum disetujui -> 403 "menunggu"', r.status === 403 && /menunggu/i.test(r.json.error || ''), r.json.error);
    r = await call('GET', '/api/signups', { cookie: maint.cookie });
    const pending = r.json.signups || [];
    check('maintenance melihat pengajuan (tanpa hash/password)', pending.length === 1 && !/hash|salt|password/i.test(r.text));
    check('menyetujui pengajuan (200)', (await call('POST', '/api/signups/decide', { cookie: maint.cookie, body: { id: pending[0].id, action: 'approve' } })).status === 200);
    const viewer = await login('budi', 'rahasia1');
    check('setelah disetujui: login berhasil, peran viewer', viewer.status === 200 && (await call('GET', '/api/me', { cookie: viewer.cookie })).json.role === 'viewer');

    // ---- akun "hanya lihat" ----
    for (const u of ['/api/me', '/api/alarms', '/api/settings', '/index.html', '/JS_Monitoring.js', '/mqtt-config.json']) {
        check(`viewer boleh GET ${u}`, (await call('GET', u, { cookie: viewer.cookie })).status === 200);
    }
    for (const u of ['/api/devices', '/api/signups', '/api/sessions', '/api/accounts', '/api/settings/audit', '/api/ota/history', '/api/excel/crane-01', '/laporan.js', '/server.js', '/data/auth.db']) {
        check(`viewer ditolak GET ${u} (403)`, (await call('GET', u, { cookie: viewer.cookie })).status === 403);
    }
    check('viewer: halaman pengaturan dialihkan ke dashboard', (await call('GET', '/pengaturan.html', { cookie: viewer.cookie })).status === 302);
    for (const [m, u, b] of [['POST', '/api/alarms/ack', { id: 'x', by: 'b' }], ['PUT', '/api/settings', { settings: {} }], ['POST', '/api/devices/activate', { craneId: 'crane-01' }],
        ['POST', '/api/ota/trigger', { all: true }], ['POST', '/api/signups/decide', { id: 1, action: 'approve' }], ['POST', '/api/accounts/delete', { username: 'budi' }],
        ['POST', '/api/settings/audit/delete', { all: true }]]) {
        check(`viewer ditolak ${m} ${u} (403)`, (await call(m, u, { cookie: viewer.cookie, body: b })).status === 403);
    }

    // ---- Serial Monitor jarak jauh: khusus staf ----
    check('viewer ditolak GET /api/esp/log (403)', (await call('GET', '/api/esp/log?craneId=crane-01', { cookie: viewer.cookie })).status === 403);
    check('viewer ditolak POST /api/esp/log/start (403)', (await call('POST', '/api/esp/log/start', { cookie: viewer.cookie, body: { craneId: 'crane-01' } })).status === 403);
    check('viewer ditolak espmon.js (403)', (await call('GET', '/espmon.js', { cookie: viewer.cookie })).status === 403);
    r = await call('GET', '/api/esp/log?craneId=crane-01&after=0', { cookie: maint.cookie });
    check('maintenance boleh GET /api/esp/log (kosong dulu)', r.status === 200 && Array.isArray(r.json.lines) && r.json.lines.length === 0, String(r.status));
    r = await call('GET', '/api/ota/history', { cookie: maint.cookie });
    check('maintenance boleh GET /api/ota/history (200)', r.status === 200 && typeof r.json === 'object', String(r.status));
    check('log/start crane tidak dikenal -> 404', (await call('POST', '/api/esp/log/start', { cookie: maint.cookie, body: { craneId: 'crane-xx' } })).status === 404);

    // ---- hapus riwayat pindah AP / restart (Status Sistem): khusus staf ----
    check('viewer ditolak hapus riwayat (403)', (await call('POST', '/api/history/clear', { cookie: viewer.cookie, body: { what: 'all' } })).status === 403);
    check('hapus riwayat: pilihan tidak valid -> 400', (await call('POST', '/api/history/clear', { cookie: maint.cookie, body: { what: 'xx' } })).status === 400);
    check('maintenance boleh hapus riwayat pindah AP & restart (200)', (await call('POST', '/api/history/clear', { cookie: maint.cookie, body: { what: 'all' } })).status === 200);

    // ---- sakelar aktif/nonaktif per motor ----
    let cfg = (await call('GET', '/api/settings', { cookie: maint.cookie })).json;
    cfg.cranes[0].gearboxes[0].enabled = 'ya';
    r = await call('PUT', '/api/settings', { cookie: maint.cookie, body: { settings: cfg, by: 'tes' } });
    check('motor enabled bukan boolean ditolak (400)', r.status === 400, `${r.status} ${r.json.error || ''}`);
    cfg = (await call('GET', '/api/settings', { cookie: maint.cookie })).json;
    cfg.cranes[0].gearboxes[0].enabled = false;
    r = await call('PUT', '/api/settings', { cookie: maint.cookie, body: { settings: cfg, by: 'tes' } });
    check('maintenance mematikan satu motor (200)', r.status === 200, `${r.status} ${r.json.error || ''}`);
    check('perubahan sensor nonaktif tercatat', (r.json.changes || []).some(c => /sensor: aktif → nonaktif/.test(c)), JSON.stringify(r.json.changes));
    cfg = (await call('GET', '/api/settings', { cookie: maint.cookie })).json;
    check('motor yang dimatikan tersimpan (enabled=false)', cfg.cranes[0].gearboxes[0].enabled === false);
    delete cfg.cranes[0].gearboxes[0].enabled;
    check('motor dinyalakan lagi (200)', (await call('PUT', '/api/settings', { cookie: maint.cookie, body: { settings: cfg, by: 'tes' } })).status === 200);

    // ---- hak maintenance ----
    check('maintenance boleh hapus riwayat perubahan (200)', (await call('POST', '/api/settings/audit/delete', { cookie: maint.cookie, body: { all: true } })).status === 200);
    check('maintenance boleh hapus riwayat perubahan (200)', (await call('POST', '/api/settings/audit/delete', { cookie: master.cookie, body: { all: true } })).status === 200);
    r = await call('GET', '/api/sessions', { cookie: maint.cookie });
    check('maintenance melihat sesi viewer', (r.json.sessions || []).some(s => s.username === 'budi'));
    check('maintenance tidak melihat sesi master', (r.json.sessions || []).every(s => s.username !== 'master'));
    const viewerSession = (r.json.sessions || []).find(s => s.username === 'budi');
    r = await call('GET', '/api/sessions', { cookie: master.cookie });
    check('master melihat semua sesi (termasuk viewer)', (r.json.sessions || []).some(s => s.username === 'budi'));
    const masterSession = (r.json.sessions || []).find(s => s.username === 'master');
    check('maintenance tidak bisa mematikan sesi master (404)', (await call('POST', '/api/sessions/terminate', { cookie: maint.cookie, body: { id: masterSession.id } })).status === 404);
    check('maintenance mematikan sesi viewer (200)', (await call('POST', '/api/sessions/terminate', { cookie: maint.cookie, body: { id: viewerSession.id } })).status === 200);
    check('sesi viewer yang dimatikan langsung 401', (await call('GET', '/api/me', { cookie: viewer.cookie })).status === 401);

    // ---- Excel ----
    check('Excel tanpa login -> 401', (await call('GET', '/api/excel/crane-01')).status === 401);
    check('Excel crane tidak ada -> 404', (await call('GET', '/api/excel/crane-99', { cookie: master.cookie })).status === 404);
    r = await call('GET', '/api/excel/crane-01', { cookie: master.cookie }); // database uji kosong: belum terpasang / belum ada data
    check('Excel crane tanpa data -> 404 dengan pesan', r.status === 404 && !!r.json.error, `${r.status} ${r.json.error || ''}`);

    // ---- hapus akun & keamanan berkas ----
    check('akun bawaan tidak bisa dihapus (404)', (await call('POST', '/api/accounts/delete', { cookie: maint.cookie, body: { username: 'master' } })).status === 404);
    check('maintenance menghapus akun viewer (200)', (await call('POST', '/api/accounts/delete', { cookie: maint.cookie, body: { username: 'budi' } })).status === 200);
    check('sesi akun yang dihapus langsung mati (401)', (await call('GET', '/api/me', { cookie: viewer.cookie })).status === 401);
    check('kode server tidak bisa diunduh walau login maintenance (404)', (await call('GET', '/server.js', { cookie: master.cookie })).status === 404);
    check('logout berhasil, sesi mati', (await call('POST', '/api/logout', { cookie: maint.cookie, body: {} })).status === 200 && (await call('GET', '/api/me', { cookie: maint.cookie })).status === 401);
}

async function cleanup() {
    if (child && child.pid) {
        try { execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch (e) { /* sudah mati */ }
    }
    await sleep(800);
    ['node_modules', 'vendor'].forEach(n => { try { fs.rmdirSync(path.join(tmp, n)); } catch (e) { /* tidak ada */ } }); // lepas junction dulu
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { console.log(`(folder sementara tidak terhapus: ${tmp})`); }
}

(async () => {
    try {
        prepareCopy();
        child = spawn(process.execPath, ['run-all.js', '--no-broker', '--quiet'], {
            cwd: tmp, windowsHide: true, stdio: 'ignore',
            env: { ...process.env, PORT: String(PORT), MQTT_URL: 'mqtt://127.0.0.1:1', SIGNUP_MAX_PER_HOUR: '1000' }
        });
        if (await waitUp()) await run();
        else check('server naik dalam 30 detik (run-all + logger + web)', false);
    } catch (e) {
        check('tes berjalan tanpa error', false, e.message);
    }
    if (failed) { // bantu menelusuri: apakah server masih menjawab + log server terakhir dari salinan sementara
        const t0 = Date.now();
        try { const h = await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(5000) }); console.log(`\nserver setelah gagal: health ${h.status} dalam ${Date.now() - t0} ms`); } catch (e) { console.log(`\nserver setelah gagal: TIDAK menjawab (${e.message})`); }
        try { console.log('\n--- web.log (akhir) ---\n' + fs.readFileSync(path.join(tmp, 'service-logs', 'web.log'), 'utf-8').split('\n').filter(l => !/ECONNREFUSED/.test(l)).slice(-8).join('\n')); } catch (e) { /* belum ada */ }
    }
    await cleanup();
    console.log(`\n${total - failed}/${total} lolos`);
    process.exit(failed ? 1 : 0);
})();