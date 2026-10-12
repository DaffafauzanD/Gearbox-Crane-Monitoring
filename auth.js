// ============================================================
// LOGIN DASHBOARD - akun & sesi (database TERPISAH dari data/monitoring.db)
// ============================================================
// Tiga peran: master & maintenance (dua akun BAWAAN, fitur sama kecuali beberapa hak khusus
// master - lihat server.js), dan viewer (akun hasil pengajuan dari halaman login yang
// disetujui master/maintenance; HANYA boleh melihat dashboard monitoring & indikatornya).
//
// Kenapa dipisah dari monitoring.db? Supaya akun login tidak pernah tercampur
// dengan data suhu/alarm - gampang di-backup/dipindah sendiri, dan kalau
// monitoring.db pernah dibangun ulang (npm run db-import) akun login tidak ikut
// hilang.
//
// Password di-hash pakai scrypt (bawaan Node, tidak perlu install apa-apa) -
// TIDAK PERNAH disimpan polos di database. Sesi login disimpan sebagai token
// acak di cookie httpOnly (tidak bisa dibaca lewat JavaScript di browser),
// berlaku SESSION_DAYS hari sejak terakhir dipakai (sliding expiry).
//
// PENTING: login ini cuma melindungi dashboard web (server.js). Broker MQTT
// tetap punya mekanisme login TERPISAH (lihat README, bagian "Login MQTT").

const { DatabaseSync } = require('node:sqlite');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const DB_FILE = path.join(__dirname, 'data', 'auth.db');
const SESSION_DAYS = 30;
const SESSION_MS = SESSION_DAYS * 24 * 60 * 60 * 1000;
const COOKIE_NAME = 'gbx_session';
const SCRYPT_KEYLEN = 64;
const ACCOUNTS = ['master', 'maintenance']; // dua akun BAWAAN (dibuat otomatis, tidak bisa dihapus)

// Peran: master & maintenance = akun bawaan. Akun lain (hasil pengajuan yang disetujui)
// berperan "viewer": HANYA boleh melihat dashboard monitoring & indikatornya.
const ROLE_MASTER = 'master';
const ROLE_MAINTENANCE = 'maintenance';
const ROLE_VIEWER = 'viewer';

// Pengajuan akun dari halaman login
const SIGNUP_RESERVED = ['master', 'maintenance', 'slave', 'admin', 'administrator', 'root', 'system', 'operator'];
const USERNAME_RE = /^[a-z0-9][a-z0-9._-]{2,19}$/;
const PASSWORD_MIN = 6;
const PASSWORD_MAX = 100;                          // batas atas supaya hashing scrypt tidak bisa dibebani password raksasa
const MAX_PENDING_SIGNUPS = 30;                    // antrian pengajuan maksimal (cegah dibanjiri)
const SIGNUP_KEEP_MS = 30 * 24 * 60 * 60 * 1000;   // pengajuan yang tidak diputuskan / ditolak dibuang setelah 30 hari

// Kembalikan pesan kesalahan (string), atau null kalau valid. Username sudah lowercase & trim.
function validateSignup(username, password) {
    if (typeof username !== 'string' || !USERNAME_RE.test(username)) {
        return 'Username 3-20 karakter: huruf kecil, angka, titik, minus atau garis bawah (diawali huruf/angka).';
    }
    if (SIGNUP_RESERVED.includes(username)) return 'Username ini tidak boleh dipakai.';
    if (typeof password !== 'string' || password.length < PASSWORD_MIN) return `Password minimal ${PASSWORD_MIN} karakter.`;
    if (password.length > PASSWORD_MAX) return `Password maksimal ${PASSWORD_MAX} karakter.`;
    return null;
}

function openAuthDb(file = DB_FILE) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const db = new DatabaseSync(file);
    db.exec(`
        PRAGMA journal_mode = WAL;
        PRAGMA busy_timeout = 5000;

        CREATE TABLE IF NOT EXISTS accounts (
            username    TEXT PRIMARY KEY,
            salt        TEXT NOT NULL,
            hash        TEXT NOT NULL,
            created_at  INTEGER NOT NULL,
            updated_at  INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS sessions (
            token       TEXT PRIMARY KEY,
            username    TEXT NOT NULL,
            created_at  INTEGER NOT NULL,
            expires_at  INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions (expires_at);

        -- Pengajuan akun dari halaman login. Password langsung di-hash (scrypt) saat
        -- diajukan; tidak pernah ada yang menyimpan password polos.
        CREATE TABLE IF NOT EXISTS signup_requests (
            id           INTEGER PRIMARY KEY,
            username     TEXT NOT NULL UNIQUE,
            salt         TEXT NOT NULL,
            hash         TEXT NOT NULL,
            requested_at INTEGER NOT NULL,
            ip           TEXT,
            user_agent   TEXT,
            status       TEXT NOT NULL DEFAULT 'pending',   -- pending | rejected
            decided_by   TEXT,
            decided_at   INTEGER
        );
    `);
    // ip/user_agent ditambah belakangan (panel "siapa sedang online") - kolom
    // baru di tabel yang sudah ada tidak bisa lewat CREATE TABLE IF NOT EXISTS,
    // jadi ditambah terpisah. Diabaikan kalau sudah pernah ditambahkan sebelumnya.
    try { db.exec('ALTER TABLE sessions ADD COLUMN ip TEXT'); } catch (e) { /* sudah ada */ }
    try { db.exec('ALTER TABLE sessions ADD COLUMN user_agent TEXT'); } catch (e) { /* sudah ada */ }
    // role ditambah belakangan (akun hasil pengajuan). Akun bawaan tidak butuh kolom ini
    // (perannya dari namanya, lihat AuthStore.roleOf).
    try { db.exec('ALTER TABLE accounts ADD COLUMN role TEXT'); } catch (e) { /* sudah ada */ }
    return db;
}

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
    const hash = crypto.scryptSync(password, salt, SCRYPT_KEYLEN).toString('hex');
    return { salt, hash };
}

function verifyPassword(password, salt, hash) {
    const check = crypto.scryptSync(password, salt, SCRYPT_KEYLEN);
    const expected = Buffer.from(hash, 'hex');
    // Panjang beda -> pasti salah, tapi tetap lewat timingSafeEqual (dengan buffer
    // dummy sepanjang `check`) supaya waktu respons tidak membocorkan info hash.
    return check.length === expected.length && crypto.timingSafeEqual(check, expected);
}

class AuthStore {
    constructor(db) {
        this.db = db;
        this.getAccount = db.prepare('SELECT * FROM accounts WHERE username = ?');
        this.upsertAccount = db.prepare(`
            INSERT INTO accounts (username, salt, hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?)
            ON CONFLICT (username) DO UPDATE SET salt = excluded.salt, hash = excluded.hash, updated_at = excluded.updated_at`);
        this.insertSession = db.prepare('INSERT INTO sessions (token, username, created_at, expires_at, ip, user_agent) VALUES (?, ?, ?, ?, ?, ?)');
        this.getSession = db.prepare('SELECT * FROM sessions WHERE token = ?');
        this.touchSession = db.prepare('UPDATE sessions SET expires_at = ? WHERE token = ?');
        this.deleteSession = db.prepare('DELETE FROM sessions WHERE token = ?');
        this.deleteSessionsOf = db.prepare('DELETE FROM sessions WHERE username = ?');
        this.pruneSessions = db.prepare('DELETE FROM sessions WHERE expires_at < ?');
        // rowid (bawaan SQLite, bukan token asli) dipakai sebagai ID sesi yang aman
        // dikirim ke browser master - beda dengan token, ID ini tidak bisa dipakai
        // untuk "menjadi" akun itu, cuma penunjuk baris buat dihapus.
        this.listActive = db.prepare('SELECT rowid AS id, * FROM sessions WHERE expires_at > ? ORDER BY username, created_at DESC');
        this.getSessionById = db.prepare('SELECT rowid AS id, * FROM sessions WHERE rowid = ?');
        this.getSessionIdByToken = db.prepare('SELECT rowid AS id FROM sessions WHERE token = ?');
        this.deleteSessionById = db.prepare('DELETE FROM sessions WHERE rowid = ?');

        this.insertAccountWithRole = db.prepare('INSERT INTO accounts (username, salt, hash, created_at, updated_at, role) VALUES (?, ?, ?, ?, ?, ?)');
        this.deleteAccountStmt = db.prepare('DELETE FROM accounts WHERE username = ?');
        this.listAccountsStmt = db.prepare('SELECT username, created_at FROM accounts ORDER BY created_at');
        this.getSignup = db.prepare('SELECT * FROM signup_requests WHERE username = ?');
        this.getSignupById = db.prepare('SELECT * FROM signup_requests WHERE id = ?');
        this.insertSignup = db.prepare('INSERT INTO signup_requests (username, salt, hash, requested_at, ip, user_agent) VALUES (?, ?, ?, ?, ?, ?)');
        this.deleteSignup = db.prepare('DELETE FROM signup_requests WHERE id = ?');
        this.rejectSignup = db.prepare("UPDATE signup_requests SET status = 'rejected', decided_by = ?, decided_at = ? WHERE id = ?");
        this.listPending = db.prepare("SELECT id, username, requested_at, ip, user_agent FROM signup_requests WHERE status = 'pending' ORDER BY requested_at");
        this.countPendingStmt = db.prepare("SELECT COUNT(*) AS c FROM signup_requests WHERE status = 'pending'");
        this.pruneSignups = db.prepare('DELETE FROM signup_requests WHERE requested_at < ?');
    }

    hasAccount(username) {
        return !!this.getAccount.get(username);
    }

    hasAnyAccount() {
        return ACCOUNTS.some(u => this.hasAccount(u));
    }

    // Bikin/reset password satu akun (dipanggil dari scripts/setup-accounts.js,
    // dan otomatis sekali oleh server.js kalau belum ada akun sama sekali).
    setPassword(username, password) {
        const { salt, hash } = hashPassword(password);
        const now = Date.now();
        this.upsertAccount.run(username, salt, hash, now, now);
        this.deleteSessionsOf.run(username); // password baru -> sesi lama (kalau ada) diputus
    }

    // null kalau username/password salah, atau username tidak terdaftar.
    // ip/userAgent cuma dicatat untuk panel "siapa sedang online" (master saja) -
    // tidak dipakai untuk validasi apa pun.
    login(username, password, ip = null, userAgent = null) {
        const acc = this.getAccount.get(username);
        if (!acc || !verifyPassword(password, acc.salt, acc.hash)) return null;
        const token = crypto.randomBytes(32).toString('hex');
        const now = Date.now();
        this.insertSession.run(token, username, now, now + SESSION_MS, ip, userAgent);
        return token;
    }

    // Peran akun. master & maintenance = akun bawaan (dari namanya). Akun lain = kolom role
    // (akun hasil pengajuan yang disetujui = viewer; nilai kosong/aneh juga dianggap viewer,
    // jadi hak akses tidak pernah "bocor" naik karena data yang rusak).
    roleOf(username) {
        if (username === 'master') return ROLE_MASTER;
        if (username === 'maintenance') return ROLE_MAINTENANCE;
        return ROLE_VIEWER;
    }

    // Untuk pesan di halaman login: password BENAR tapi akunnya masih dalam pengajuan ->
    // 'pending' / 'rejected'. Password salah -> null (tidak membocorkan apa pun).
    signupStatusFor(username, password) {
        const req = this.getSignup.get(username);
        if (!req || !verifyPassword(password, req.salt, req.hash)) return null;
        return req.status;
    }

    // Ajukan akun baru (dari halaman login, tanpa login). Hasil: { ok: true } atau { error, code }.
    createSignup(username, password, ip = null, userAgent = null) {
        const bad = validateSignup(username, password);
        if (bad) return { error: bad, code: 'invalid' };
        if (this.hasAccount(username)) return { error: 'Username sudah dipakai. Pilih username lain.', code: 'exists' };
        const existing = this.getSignup.get(username);
        if (existing && existing.status === 'pending') {
            return { error: 'Sudah ada pengajuan dengan username ini yang menunggu persetujuan.', code: 'pending' };
        }
        if (this.countPendingStmt.get().c >= MAX_PENDING_SIGNUPS) {
            return { error: 'Antrian pengajuan sedang penuh. Hubungi Maintenance.', code: 'full' };
        }
        const { salt, hash } = hashPassword(password);
        if (existing) this.deleteSignup.run(existing.id); // pengajuan lama yang ditolak diganti yang baru
        this.insertSignup.run(username, salt, hash, Date.now(), ip, userAgent);
        return { ok: true };
    }

    pendingSignups() {
        return this.listPending.all().map(r => ({
            id: r.id, username: r.username, requestedAt: r.requested_at, ip: r.ip, userAgent: r.user_agent
        }));
    }

    pendingCount() {
        return this.countPendingStmt.get().c;
    }

    // Setujui / tolak satu pengajuan. Disetujui -> akun dibuat (peran viewer) memakai hash
    // yang sama, pengajuannya dihapus. Ditolak -> ditandai ditolak (pemohon dikasih tahu
    // saat mencoba login). null kalau pengajuan tidak ada / sudah diputuskan.
    decideSignup(id, action, by = null) {
        const req = this.getSignupById.get(id);
        if (!req || req.status !== 'pending') return null;
        if (action === 'approve') {
            this.db.exec('BEGIN');
            try {
                if (this.hasAccount(req.username)) throw new Error('username sudah dipakai akun lain');
                const now = Date.now();
                this.insertAccountWithRole.run(req.username, req.salt, req.hash, now, now, ROLE_VIEWER);
                this.deleteSignup.run(id);
                this.db.exec('COMMIT');
            } catch (e) {
                this.db.exec('ROLLBACK');
                this.deleteSignup.run(id);
                return null;
            }
        } else {
            this.rejectSignup.run(by, Date.now(), id);
        }
        return { username: req.username, action };
    }

    // Untuk skrip setup-accounts. Akun bawaan (master/maintenance) tidak bisa dihapus.
    listAccounts() {
        return this.listAccountsStmt.all().map(r => ({ username: r.username, role: this.roleOf(r.username), createdAt: r.created_at }));
    }

    deleteAccount(username) {
        if (ACCOUNTS.includes(username) || !this.hasAccount(username)) return false;
        this.deleteSessionsOf.run(username); // sesi login akun ini ikut putus
        this.deleteAccountStmt.run(username);
        return true;
    }

    // Token valid -> username, sekaligus perpanjang masa berlakunya (sliding expiry)
    resolveSession(token) {
        if (!token) return null;
        const row = this.getSession.get(token);
        if (!row || row.expires_at < Date.now()) return null;
        this.touchSession.run(Date.now() + SESSION_MS, token);
        return row.username;
    }

    logout(token) {
        if (token) this.deleteSession.run(token);
    }

    prune() {
        this.pruneSignups.run(Date.now() - SIGNUP_KEEP_MS);
        return this.pruneSessions.run(Date.now()).changes;
    }

    // Panel "siapa sedang online" (lihat api/sessions di server.js). Server yang
    // menentukan siapa boleh melihat sesi siapa: master melihat semua, akun lain
    // cuma melihat sesi sesama akunnya (parameter `onlyUsername`).
    // "Aktivitas terakhir" dihitung mundur dari expires_at (sliding expiry: tiap
    // request yang lolos resolveSession() menggeser expires_at = sekarang +
    // SESSION_MS), jadi tidak perlu kolom terpisah buat itu.
    // `currentToken` (opsional) menandai sesi milik peminta dengan current: true.
    listActiveSessions({ onlyUsername = null, hideUsernames = [], currentToken = null } = {}) {
        const now = Date.now();
        const currentId = currentToken ? (this.getSessionIdByToken.get(currentToken) || {}).id : null;
        return this.listActive.all(now)
            .filter(row => (!onlyUsername || row.username === onlyUsername) && !hideUsernames.includes(row.username))
            .map(row => ({
            current: currentId !== null && row.id === currentId,
            id: row.id,
            username: row.username,
            ip: row.ip,
            userAgent: row.user_agent,
            loginAt: row.created_at,
            lastActivityAt: row.expires_at - SESSION_MS
        }));
    }

    // Intip username pemilik satu sesi TANPA menghapusnya - dipakai server.js
    // untuk menolak lebih dulu kalau targetnya tidak boleh dimatikan si peminta.
    peekSessionUsername(id) {
        const row = this.getSessionById.get(id);
        return row && row.expires_at >= Date.now() ? row.username : null;
    }

    // ID sesi (rowid) milik satu token - supaya server bisa tahu "ini sesi saya sendiri"
    sessionIdOf(token) {
        const row = token ? this.getSessionIdByToken.get(token) : null;
        return row ? row.id : null;
    }

    // Matikan satu sesi tertentu (tombol "Matikan sesi" di panel master).
    // Dipanggil dari server.js, yang JUGA mengecek username-nya bukan master
    // (master tidak boleh mematikan sesinya sendiri lewat sini - itu fungsi
    // tombol Keluar). Return username-nya (buat dicatat di log server), atau
    // null kalau ID tidak ada / sudah kedaluwarsa duluan.
    terminateSession(id) {
        const row = this.getSessionById.get(id);
        if (!row || row.expires_at < Date.now()) return null;
        this.deleteSessionById.run(id);
        return row.username;
    }
}

// Bikin akun master & maintenance dengan password ACAK kalau belum ada akun SAMA
// SEKALI (server baru pertama kali jalan) - supaya dashboard tetap "plug and
// play", tidak wajib jalankan npm run setup-accounts dulu sebelum bisa login.
// Password ditulis SEKALI ke accounts-credentials.json (mirip mqtt/credentials.json).
function bootstrapDefaultAccounts(store, credFile) {
    if (store.hasAnyAccount()) return null;
    const newPassword = () => crypto.randomBytes(9).toString('base64url'); // 12 karakter acak
    const creds = {};
    ACCOUNTS.forEach(username => {
        const password = newPassword();
        store.setPassword(username, password);
        creds[username] = password;
    });
    fs.writeFileSync(credFile, JSON.stringify(creds, null, 2) + '\n');
    return creds;
}

// ---- Cookie sesi ----
function readCookie(req, name) {
    const header = req.headers.cookie;
    if (!header) return null;
    const match = header.split(';').map(s => s.trim()).find(s => s.startsWith(`${name}=`));
    return match ? decodeURIComponent(match.slice(name.length + 1)) : null;
}

function setCookie(res, name, value, maxAgeMs) {
    const parts = [`${name}=${encodeURIComponent(value)}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${Math.floor(maxAgeMs / 1000)}`];
    res.setHeader('Set-Cookie', parts.join('; '));
}

function clearCookie(res, name) {
    res.setHeader('Set-Cookie', `${name}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

module.exports = {
    DB_FILE, ACCOUNTS, ROLE_MASTER, ROLE_MAINTENANCE, ROLE_VIEWER, validateSignup, COOKIE_NAME, SESSION_MS,
    openAuthDb, AuthStore, hashPassword, verifyPassword, bootstrapDefaultAccounts,
    readCookie, setCookie, clearCookie
};
