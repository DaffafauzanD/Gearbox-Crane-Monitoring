// ============================================================
// SETUP AKUN LOGIN DASHBOARD - bikin/ganti password "master" & "maintenance"
// ============================================================
// Biasanya TIDAK perlu dijalankan manual: begitu server.js pertama kali jalan
// dan belum ada akun sama sekali, akun master & maintenance otomatis dibuatkan
// dengan password acak (dicatat di accounts-credentials.json, dan dicetak
// sekali di layar - lihat log "[Auth] Akun pertama dibuat" saat menjalankan
// npm run service / npm run web).
//
// Jalankan skrip ini kalau mau GANTI password sendiri:
//     npm run setup-accounts -- --set master "PasswordBaru123"
//     npm run setup-accounts -- --set maintenance "PasswordLainnya456"
//
// Atau bikin ulang password acak untuk satu akun (mis. dicurigai bocor):
//     npm run setup-accounts -- --reset master
//
// Password disimpan HASH (scrypt) di data/auth.db - tidak pernah disimpan
// polos di database. accounts-credentials.json cuma catatan supaya operator
// bisa lihat/bagikan passwordnya - file itu RAHASIA, jangan commit/bagikan
// sembarangan (sudah masuk .gitignore).

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { openAuthDb, AuthStore, ACCOUNTS } = require('../auth');

const ROOT = path.join(__dirname, '..');
const CRED_FILE = path.join(ROOT, 'accounts-credentials.json');

function fail(msg) {
    console.error(`[Setup] ${msg}`);
    process.exit(1);
}

function newPassword() {
    return crypto.randomBytes(9).toString('base64url'); // 12 karakter acak
}

function loadCreds() {
    if (!fs.existsSync(CRED_FILE)) return {};
    try {
        return JSON.parse(fs.readFileSync(CRED_FILE, 'utf-8'));
    } catch (e) {
        return {};
    }
}

function saveCreds(creds) {
    fs.writeFileSync(CRED_FILE, JSON.stringify(creds, null, 2) + '\n');
}

const db = openAuthDb();
const store = new AuthStore(db);
const creds = loadCreds();

const setIdx = process.argv.indexOf('--set');
const resetIdx = process.argv.indexOf('--reset');

// Daftar semua akun & perannya:      npm run setup-accounts -- --list
// Hapus akun hasil pengajuan (mis. orangnya sudah tidak bertugas):
//                                    npm run setup-accounts -- --delete namaakun
// Akun bawaan (master, maintenance) tidak bisa dihapus. Sesi login akun yang dihapus ikut putus.
if (process.argv.includes('--list')) {
    store.listAccounts().forEach(a => console.log(`  ${a.username.padEnd(22)} ${a.role}`));
    process.exit(0);
}
const delIdx = process.argv.indexOf('--delete');
if (delIdx > 0) {
    const username = process.argv[delIdx + 1];
    if (!store.deleteAccount(username)) fail(`Akun "${username}" tidak ditemukan, atau akun bawaan yang tidak boleh dihapus.`);
    console.log(`[Setup] Akun "${username}" dihapus. Sesi login-nya ikut diputus.`);
    process.exit(0);
}

if (setIdx > 0) {
    const username = process.argv[setIdx + 1];
    const password = process.argv[setIdx + 2];
    if (!ACCOUNTS.includes(username)) fail(`Akun harus "${ACCOUNTS.join('" atau "')}", bukan "${username}".`);
    if (!password || password.length < 6) fail('Password wajib diisi, minimal 6 karakter.');

    store.setPassword(username, password);
    creds[username] = password;
    saveCreds(creds);
    console.log(`[Setup] Password akun "${username}" diperbarui. Sesi login lama untuk akun ini otomatis logout.`);
    process.exit(0);
}

if (resetIdx > 0) {
    const username = process.argv[resetIdx + 1];
    if (!ACCOUNTS.includes(username)) fail(`Akun harus "${ACCOUNTS.join('" atau "')}", bukan "${username}".`);

    const password = newPassword();
    store.setPassword(username, password);
    creds[username] = password;
    saveCreds(creds);
    console.log(`[Setup] Password akun "${username}" diganti acak: ${password}`);
    console.log(`[Setup] Tersimpan juga di: ${CRED_FILE}`);
    process.exit(0);
}

// Tanpa --set / --reset: pastikan kedua akun ADA (bikin yang belum ada dengan
// password acak), tanpa mengubah yang sudah ada.
const added = [];
ACCOUNTS.forEach(username => {
    if (store.hasAccount(username)) return;
    const password = newPassword();
    store.setPassword(username, password);
    creds[username] = password;
    added.push(username);
});

if (added.length) {
    saveCreds(creds);
    console.log(`[Setup] Akun baru dibuat: ${added.join(', ')}`);
    console.log(`[Setup] Password tersimpan di: ${CRED_FILE} (RAHASIA, jangan commit/bagikan sembarangan)`);
} else {
    console.log('[Setup] Akun master & maintenance sudah ada, tidak ada yang diubah.');
    console.log('[Setup] Ganti password: npm run setup-accounts -- --set master "PasswordBaru"');
    console.log('[Setup] Bikin ulang password acak: npm run setup-accounts -- --reset master');
}
