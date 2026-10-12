// ============================================================
// FUNGSI & KONSTANTA BERSAMA (sisi server)
// ============================================================
// Dulu ditulis ulang di banyak berkas (isProcessAlive di 6 berkas, konstanta WIB di 5).
// Satu sumber di sini supaya perbaikannya cukup sekali.

// Apakah proses dengan PID ini masih hidup? (EPERM = ada, tapi milik akun lain)
function isProcessAlive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    } catch (e) {
        return e.code === 'EPERM';
    }
}

const WIB_OFFSET_MS = 7 * 60 * 60 * 1000; // WIB = UTC+7, tanpa daylight saving
const DAY_MS = 24 * 60 * 60 * 1000;

module.exports = { isProcessAlive, WIB_OFFSET_MS, DAY_MS };