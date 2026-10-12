// ============================================================
// RIWAYAT CHART DARI CSV - dipakai mqtt_logger.js saat mulai
// ============================================================
// Chart dashboard menampilkan riwayat singkat (state.json -> history: 1 titik per menit,
// nilai terakhir menit itu). state.json cuma snapshot berkala: kalau logger dimatikan paksa
// atau state.json dari versi lama, riwayatnya bisa kosong/pendek walau datanya sendiri aman
// di CSV. CSV ditulis di SETIAP pesan, jadi paling bisa diandalkan - riwayat chart disusun
// ulang dari ekor CSV hari ini.

const fs = require('fs');
const path = require('path');
const { WIB_OFFSET_MS } = require('./common');

const TAIL_BYTES = 24 * 1024; // ~650 baris (~50 menit data) - jauh lebih dari cukup untuk beberapa titik per menit

function readTailLines(file) {
    const fd = fs.openSync(file, 'r');
    try {
        const size = fs.fstatSync(fd).size;
        const len = Math.min(size, TAIL_BYTES);
        const buf = Buffer.alloc(len);
        fs.readSync(fd, buf, 0, len, size - len);
        const lines = buf.toString('utf-8').split(/\r?\n/);
        if (size > TAIL_BYTES) lines.shift(); // baris pertama bisa terpotong di tengah
        return lines;
    } finally {
        fs.closeSync(fd);
    }
}

// Susun ulang state[crane][gb].history dari CSV hari ini (tanggal WIB). Mengembalikan jumlah gearbox yang diisi.
function seedHistory({ logDir, state, maxHistory, nowMs = Date.now() }) {
    const today = new Date(nowMs + WIB_OFFSET_MS).toISOString().slice(0, 10);
    const fileRe = new RegExp(`^(.+)_([a-z0-9]+)_${today}\\.csv$`);
    let names;
    try {
        names = fs.readdirSync(logDir);
    } catch (e) {
        return 0;
    }

    let seeded = 0;
    for (const name of names) {
        const m = name.match(fileRe);
        if (!m) continue;

        // "13.20" -> sampel TERBARU menit itu (berdasarkan waktu kejadian, BUKAN urutan baris: data
        // backlog ESP32 yang dikirim ulang setelah offline masuk ke CSV belakangan walau waktunya lama)
        const points = new Map();
        let last = null;
        for (const line of readTailLines(path.join(logDir, name))) {
            const comma = line.indexOf(',');
            if (comma < 0) continue;
            const ts = line.slice(0, comma);
            const ms = Date.parse(ts);
            if (!Number.isFinite(ms)) continue; // header / baris rusak
            const v = parseFloat(line.slice(comma + 1));
            const temp = Number.isFinite(v) ? v : null;
            const time = ts.slice(11, 16).replace(':', '.');
            const prev = points.get(time);
            if (!prev || ms >= prev.ms) points.set(time, { ms, temp, time });
            if (!last || ms > last.ms) last = { ms, temp };
        }
        if (!last) continue;

        const crane = state[m[1]] || (state[m[1]] = {});
        const gb = crane[m[2]] || (crane[m[2]] = { temp: null, history: [] });
        gb.history = [...points.values()].sort((a, b) => a.ms - b.ms).slice(-maxHistory).map(p => ({ time: p.time, temp: p.temp }));
        const prevMs = gb.lastUpdated ? Date.parse(gb.lastUpdated) : NaN;
        if (!Number.isFinite(prevMs) || last.ms > prevMs) {
            gb.temp = last.temp;
            gb.lastUpdated = new Date(last.ms).toISOString();
        }
        seeded++;
    }
    return seeded;
}

module.exports = { seedHistory };
