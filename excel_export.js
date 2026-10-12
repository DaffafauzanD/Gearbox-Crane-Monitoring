// ============================================================
// EXCEL EXPORT - bikin file excel/<crane-id>.xlsx (log 7 hari terakhir)
// ============================================================
// Sumber data (dipakai server.js lewat excel_worker.js): ringkasan PER MENIT di SQLite
// (data/monitoring.db, tabel stats_minute) - satu query kecil, tidak perlu membaca ratusan
// ribu baris CSV. Kalau `db` tidak diberikan, cadangannya membaca file CSV di logs/.
// Data mentah (1 baris tiap 5 detik = ~17.000 baris/hari/gearbox) terlalu besar
// buat dibaca di Excel, jadi di sini diringkas PER MENIT: suhu min, rata-rata,
// maks, jumlah sampel, dan jumlah sampel error. CSV mentahnya tetap utuh di logs/.
//
// Dibuat SAAT DIKLIK (tombol download di dashboard -> GET /api/excel/<crane> di server.js),
// di thread terpisah (excel_worker.js), bukan lagi berkala oleh logger. Bisa juga dijalankan
// manual untuk membuat ulang semua crane sekaligus (dari database):
//     node excel_export.js
//
// Semua tanggal & jam di file Excel dalam WIB.

const ExcelJS = require('exceljs');
const fs = require('fs');
const path = require('path');
const AlarmRules = require('./alarm_rules');
const Settings = require('./settings');

const { WIB_OFFSET_MS, DAY_MS } = require('./common');

// Batas suhu per gearbox: sama dengan dashboard & alarm (config/settings.json)
function loadSettings() {
    try {
        return Settings.load();
    } catch (e) {
        return {}; // pakai batas bawaan di alarm_rules.js
    }
}

// "2026-09-18" (tanggal WIB) dari epoch ms
function wibDateStr(ms) {
    return new Date(ms + WIB_OFFSET_MS).toISOString().slice(0, 10);
}

// Epoch ms jam 00:00 WIB untuk tanggal "YYYY-MM-DD"
function wibMidnightMs(dateStr) {
    return Date.parse(`${dateStr}T00:00:00+07:00`);
}

// ExcelJS menulis Date sebagai jam UTC. Digeser +7 jam supaya yang tampil
// di Excel adalah jam WIB.
function excelWibDate(ms) {
    return new Date(ms + WIB_OFFSET_MS);
}

const isValidTemp = AlarmRules.isValidTemp;

function escapeRegExp(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Baca CSV satu crane untuk `days` hari terakhir (WIB), diringkas per menit.
// Hasil: { gb01: { minutes: Map(minuteMs -> bucket), samples, errors, lastMs }, ... }
async function readCraneMinutes(logDir, craneId, days, nowMs) {
    const dates = [];
    for (let i = days - 1; i >= 0; i--) dates.push(wibDateStr(nowMs - i * DAY_MS));
    const startMs = wibMidnightMs(dates[0]);

    const fileRe = new RegExp(`^${escapeRegExp(craneId)}_(.+)_(\\d{4}-\\d{2}-\\d{2})\\.csv$`);
    const files = (await fs.promises.readdir(logDir))
        .map(name => ({ name, match: name.match(fileRe) }))
        .filter(f => f.match && dates.includes(f.match[2]));

    const result = {};
    for (const file of files) {
        const gbKey = file.match[1];
        if (!result[gbKey]) result[gbKey] = { minutes: new Map(), samples: 0, errors: 0, lastMs: null, seen: new Set() };
        const gb = result[gbKey];

        const content = await fs.promises.readFile(path.join(logDir, file.name), 'utf-8');
        for (const line of content.split(/\r?\n/)) {
            const comma = line.indexOf(',');
            if (comma < 0) continue;
            const ms = Date.parse(line.slice(0, comma));
            if (!Number.isFinite(ms) || ms < startMs || ms > nowMs) continue; // juga melewati baris header

            // Log lama bisa berisi baris dobel (pesan yang sama tercatat 2-3x).
            // Pembacaan dengan timestamp yang sama persis cukup dihitung sekali.
            if (gb.seen.has(ms)) continue;
            gb.seen.add(ms);

            gb.samples++;
            if (gb.lastMs === null || ms > gb.lastMs) gb.lastMs = ms;

            const minuteMs = ms - (ms % 60000);
            let bucket = gb.minutes.get(minuteMs);
            if (!bucket) {
                bucket = { min: Infinity, max: -Infinity, sum: 0, count: 0, errors: 0 };
                gb.minutes.set(minuteMs, bucket);
            }

            const temp = parseFloat(line.slice(comma + 1));
            if (!isValidTemp(temp)) {
                bucket.errors++;
                gb.errors++;
                continue;
            }
            bucket.min = Math.min(bucket.min, temp);
            bucket.max = Math.max(bucket.max, temp);
            bucket.sum += temp;
            bucket.count++;
        }
    }

    Object.values(result).forEach(gb => delete gb.seen);
    return { dates, gearboxes: result };
}

// Sama bentuknya dengan hasil readCraneMinutes (CSV), tapi dari ringkasan per menit di SQLite.
// "Data Terakhir" jadi ketelitian menit (bukan detik) - selebihnya isinya sama.
function readCraneMinutesFromDb(db, craneId, days, nowMs) {
    const dates = [];
    for (let i = days - 1; i >= 0; i--) dates.push(wibDateStr(nowMs - i * DAY_MS));
    const startMs = wibMidnightMs(dates[0]);

    const rows = db.prepare(`
        SELECT s.gb_key AS gb, m.ts, m.temp_min, m.temp_max, m.temp_sum, m.n, m.errors
        FROM stats_minute m JOIN sensors s ON s.id = m.sensor_id
        WHERE s.crane_id = ? AND m.ts >= ? AND m.ts <= ?
        ORDER BY s.gb_key, m.ts`).all(craneId, startMs, nowMs);

    const result = {};
    rows.forEach(r => {
        const gb = result[r.gb] || (result[r.gb] = { minutes: new Map(), samples: 0, errors: 0, lastMs: null });
        gb.minutes.set(r.ts, {
            min: r.temp_min === null ? Infinity : r.temp_min,
            max: r.temp_max === null ? -Infinity : r.temp_max,
            sum: r.temp_sum, count: r.n, errors: r.errors
        });
        gb.samples += r.n + r.errors;
        gb.errors += r.errors;
        gb.lastMs = r.ts;
    });
    return { dates, gearboxes: result };
}

// Daftar crane-id yang punya ringkasan data di database
function listCranesWithData(db) {
    return db.prepare('SELECT DISTINCT crane_id FROM sensors ORDER BY crane_id').all().map(r => r.crane_id);
}

const round1 = v => Math.round(v * 10) / 10;

const FILL_WARNING = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFDE68A' } };
const FILL_LOW = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFBAE6FD' } };
const FILL_DANGER = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFCA5A5' } };
const FILL_HEADER = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E293B' } };
const FONT_HEADER = { bold: true, color: { argb: 'FFFFFFFF' } };

function styleHeaderRow(row) {
    row.eachCell(cell => {
        cell.fill = FILL_HEADER;
        cell.font = FONT_HEADER;
        cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
    });
    row.height = 30;
}

function tempFill(v, limits) {
    const status = AlarmRules.tempStatus(v, limits);
    if (status === 'danger') return FILL_DANGER;
    if (status === 'warning') return FILL_WARNING;
    if (status === 'low') return FILL_LOW;
    return null;
}

// `db` (DatabaseSync) diberikan -> data dari SQLite. Tanpa `db` -> membaca CSV di `logDir`.
async function exportCraneExcel({ db, logDir, excelDir, craneId, days = 7, nowMs = Date.now() }) {
    const { dates, gearboxes } = db
        ? readCraneMinutesFromDb(db, craneId, days, nowMs)
        : await readCraneMinutes(logDir, craneId, days, nowMs);
    const gbKeys = Object.keys(gearboxes).sort();
    if (gbKeys.length === 0) return null; // belum ada data sama sekali dalam periode ini

    const settings = loadSettings();
    const limitsOf = gbKey => AlarmRules.getLimits(settings, craneId, gbKey);
    const crane = AlarmRules.findCrane(settings, craneId);
    const gbName = gbKey => {
        const gb = crane && crane.gearboxes.find(g => g.key === gbKey);
        return gb ? `${gbKey} · ${gb.name}` : gbKey;
    };

    const wb = new ExcelJS.Workbook();
    wb.creator = 'Monitoring Gearbox Karawang Plant';
    wb.created = new Date();

    // ---- Sheet ringkasan ----
    const summary = wb.addWorksheet('Ringkasan');
    summary.addRow([`Log Suhu Gearbox - ${crane ? crane.name : craneId} (${craneId})`]).font = { bold: true, size: 14 };
    summary.addRow([`Periode: ${dates[0]} s/d ${dates[dates.length - 1]} (WIB)`]);
    summary.addRow([`Dibuat: ${new Date(nowMs + WIB_OFFSET_MS).toISOString().slice(0, 16).replace('T', ' ')} WIB`]);
    summary.addRow(['Batas tiap gearbox sesuai halaman Pengaturan (kolom Batas: Min / batas atas normal / Max). Warna: kuning = warning, merah = danger, biru = di bawah Min. Detail per menit ada di sheet per gearbox.']);
    summary.addRow([]);

    const summaryHeader = summary.addRow([
        'Gearbox', 'Suhu Min (°C)', 'Rata-rata (°C)', 'Suhu Maks (°C)', 'Waktu Maks (WIB)',
        'Batas Min / Normal / Max (°C)', 'Menit Warning', 'Menit Danger', 'Jumlah Sampel', 'Sampel Error', 'Data Terakhir (WIB)'
    ]);
    styleHeaderRow(summaryHeader);

    gbKeys.forEach(gbKey => {
        const gb = gearboxes[gbKey];
        const limits = limitsOf(gbKey);
        let min = Infinity, max = -Infinity, maxAt = null, sum = 0, count = 0, warnMinutes = 0, dangerMinutes = 0;
        gb.minutes.forEach((b, minuteMs) => {
            if (b.count === 0) return;
            min = Math.min(min, b.min);
            if (b.max > max) { max = b.max; maxAt = minuteMs; }
            sum += b.sum;
            count += b.count;
            const status = AlarmRules.tempStatus(b.max, limits);
            if (status === 'warning') warnMinutes++;
            if (status === 'danger') dangerMinutes++;
        });

        const hasData = count > 0;
        const row = summary.addRow([
            gbName(gbKey),
            hasData ? round1(min) : '-',
            hasData ? round1(sum / count) : '-',
            hasData ? round1(max) : '-',
            maxAt !== null ? excelWibDate(maxAt) : '-',
            `${limits.low} / ${limits.warning} / ${limits.danger}`,
            warnMinutes,
            dangerMinutes,
            gb.samples,
            gb.errors,
            gb.lastMs !== null ? excelWibDate(gb.lastMs) : '-'
        ]);
        row.getCell(5).numFmt = 'dd/mm/yyyy hh:mm';
        row.getCell(11).numFmt = 'dd/mm/yyyy hh:mm:ss';
        if (hasData) {
            const fill = tempFill(max, limits);
            if (fill) row.getCell(4).fill = fill;
        }
    });
    summary.columns.forEach((col, i) => { col.width = i === 0 ? 12 : 17; });
    summary.getColumn(1).width = 45; // judul panjang di baris atas; kolom gearbox tetap terbaca

    // ---- Sheet per gearbox (per menit) ----
    gbKeys.forEach(gbKey => {
        const gb = gearboxes[gbKey];
        const limits = limitsOf(gbKey);
        const sheet = wb.addWorksheet(gbKey, { views: [{ state: 'frozen', ySplit: 1 }] });
        sheet.columns = [
            { header: 'Waktu (WIB)', width: 18 },
            { header: 'Suhu Min (°C)', width: 14 },
            { header: 'Rata-rata (°C)', width: 14 },
            { header: 'Suhu Maks (°C)', width: 14 },
            { header: 'Jumlah Sampel', width: 14 },
            { header: 'Sampel Error', width: 13 }
        ];
        styleHeaderRow(sheet.getRow(1));

        [...gb.minutes.keys()].sort((a, b) => a - b).forEach(minuteMs => {
            const b = gb.minutes.get(minuteMs);
            const hasData = b.count > 0;
            const row = sheet.addRow([
                excelWibDate(minuteMs),
                hasData ? round1(b.min) : null,
                hasData ? round1(b.sum / b.count) : null,
                hasData ? round1(b.max) : null,
                b.count,
                b.errors
            ]);
            row.getCell(1).numFmt = 'dd/mm/yyyy hh:mm';
            if (hasData) {
                const fill = tempFill(b.max, limits);
                if (fill) row.getCell(4).fill = fill;
            }
        });
        sheet.autoFilter = { from: 'A1', to: 'F1' };
    });

    // Tulis ke file sementara dulu lalu rename, supaya orang yang sedang
    // download tidak pernah dapat file setengah jadi.
    await fs.promises.mkdir(excelDir, { recursive: true });
    const finalPath = path.join(excelDir, `${craneId}.xlsx`);
    const tmpPath = `${finalPath}.tmp`;
    await wb.xlsx.writeFile(tmpPath);
    await fs.promises.rename(tmpPath, finalPath);
    return finalPath;
}

// Daftar crane-id yang punya CSV di logs/
async function listCranesWithLogs(logDir) {
    const files = await fs.promises.readdir(logDir).catch(() => []);
    const ids = new Set();
    files.forEach(name => {
        const m = name.match(/^(.+)_[^_]+_\d{4}-\d{2}-\d{2}\.csv$/);
        if (m) ids.add(m[1]);
    });
    return [...ids].sort();
}

module.exports = { exportCraneExcel, listCranesWithLogs, listCranesWithData, wibDateStr };

// Jalankan manual: node excel_export.js  (membuat ulang Excel semua crane, dari database)
if (require.main === module) {
    (async () => {
        const { DatabaseSync } = require('node:sqlite');
        const { DB_FILE } = require('./db');
        const excelDir = path.join(__dirname, 'excel');
        const db = new DatabaseSync(DB_FILE, { readOnly: true });
        const cranes = listCranesWithData(db);
        if (cranes.length === 0) console.log('[Excel] Belum ada data di database.');
        for (const craneId of cranes) {
            const out = await exportCraneExcel({ db, excelDir, craneId });
            console.log(out ? `[Excel] ${craneId} -> ${out}` : `[Excel] ${craneId}: tidak ada data 7 hari terakhir`);
        }
        db.close();
    })().catch(err => {
        console.error('[Excel] Gagal:', err);
        process.exit(1);
    });
}
