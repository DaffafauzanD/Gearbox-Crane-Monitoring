// ============================================================
// ARSIP CSV - kompres file log harian yang sudah lama
// ============================================================
// logs/<crane>_<gb>_<YYYY-MM-DD>.csv yang lebih tua dari `olderThanDays` hari (tanggal WIB)
// dikompres jadi .csv.gz lalu aslinya dihapus. Dipanggil berkala oleh mqtt_logger.js.
//
// Aman karena file harian yang lama tidak akan ditulisi lagi: logger hanya menulis ke file
// tanggal kejadian, dan data backlog ESP32 yang lebih tua dari 7 hari ditolak (lihat
// MAX_BACKLOG_MS di mqtt_logger.js). Kompresi ditulis ke file .tmp dulu, baru diganti nama
// & aslinya dihapus - kalau berhenti di tengah jalan, CSV asli tetap utuh.

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { pipeline } = require('stream/promises');

const FILE_RE = /^(.+)_([a-z0-9]+)_(\d{4}-\d{2}-\d{2})\.csv$/;
const { WIB_OFFSET_MS, DAY_MS } = require('./common');

async function compactOldCsv({ logDir, olderThanDays = 8, nowMs = Date.now() }) {
    // tanggal WIB batas: file dengan tanggal LEBIH KECIL dari ini dikompres
    const cutoff = new Date(nowMs + WIB_OFFSET_MS - olderThanDays * DAY_MS).toISOString().slice(0, 10);

    let names;
    try {
        names = await fs.promises.readdir(logDir);
    } catch (e) {
        return { compressed: 0, savedBytes: 0 };
    }

    let compressed = 0;
    let savedBytes = 0;
    for (const name of names) {
        const m = name.match(FILE_RE);
        if (!m || m[3] >= cutoff) continue;

        const src = path.join(logDir, name);
        const dst = `${src}.gz`;
        const tmp = `${dst}.tmp`;
        try {
            const before = (await fs.promises.stat(src)).size;
            await pipeline(fs.createReadStream(src), zlib.createGzip({ level: 6 }), fs.createWriteStream(tmp));
            await fs.promises.rename(tmp, dst);
            await fs.promises.unlink(src);
            savedBytes += before - (await fs.promises.stat(dst)).size;
            compressed++;
        } catch (e) {
            await fs.promises.unlink(tmp).catch(() => {});
            console.error(`[Arsip] Gagal mengompres ${name}: ${e.message}`);
        }
        await new Promise(resolve => setImmediate(resolve)); // beri napas ke event loop tiap file
    }
    return { compressed, savedBytes };
}

module.exports = { compactOldCsv };