// ============================================================
// WORKER THREAD - membuat SATU file Excel log crane
// ============================================================
// Dijalankan server.js (lihat runExcelWorker) di thread terpisah, karena menyusun workbook
// ExcelJS berat (~1,3 detik CPU dan ~500 MB memori). Di thread ini server alarm & dashboard
// tetap responsif, dan memorinya dilepas begitu worker selesai.
//
// Membaca database dalam mode BACA-SAJA (aman berbarengan dengan logger yang menulis).

const { parentPort, workerData } = require('worker_threads');
const { DatabaseSync } = require('node:sqlite');
const { exportCraneExcel } = require('./excel_export');
const { DB_FILE } = require('./db');

(async () => {
    const db = new DatabaseSync(DB_FILE, { readOnly: true });
    try {
        db.exec('PRAGMA busy_timeout = 5000');
        const out = await exportCraneExcel({
            db,
            excelDir: workerData.excelDir,
            craneId: workerData.craneId,
            days: workerData.days,
            nowMs: workerData.nowMs
        });
        parentPort.postMessage({ ok: true, path: out });
    } catch (e) {
        parentPort.postMessage({ ok: false, error: e.message });
    } finally {
        db.close();
    }
})();