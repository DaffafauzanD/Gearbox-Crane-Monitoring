// ============================================================
// IMPORT DATA LAMA KE DATABASE
// ============================================================
// Membangun ulang data/monitoring.db dari arsip yang sudah ada:
//   logs/*.csv, *.csv.gz  -> ringkasan per menit & per jam (yang lama dikompres oleh logger)
//   alarms/history.jsonl  -> kejadian alarm
//
// Jalankan SEKALI setelah update ke versi yang pakai database, atau kapan pun
// database perlu dibangun ulang (mis. file-nya rusak/terhapus):
//     npm run db-import
//
// Logger & server HARUS dimatikan dulu (npm run service ditutup), karena isi
// database diganti total dari CSV.

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const AlarmRules = require('../alarm_rules');
const { openDb, upsertSql, sensorIdGetter, alarmEventWriter, MINUTE_MS, HOUR_MS, DAY_MS, MINUTE_RETENTION_DAYS } = require('../db');

const ROOT = path.join(__dirname, '..');
const LOG_DIR = path.join(ROOT, 'logs');
const HISTORY_FILE = path.join(ROOT, 'alarms', 'history.jsonl');

const { isProcessAlive } = require('../common');

for (const lock of ['logger.lock', 'run-all.lock']) {
    const file = path.join(ROOT, lock);
    if (!fs.existsSync(file)) continue;
    const pid = parseInt(fs.readFileSync(file, 'utf-8'), 10);
    if (pid && isProcessAlive(pid)) {
        console.error(`[Import] ${lock === 'logger.lock' ? 'Logger' : 'npm run service'} masih jalan (PID ${pid}). Matikan dulu, lalu jalankan lagi.`);
        process.exit(1);
    }
}

const db = openDb();
const sensorId = sensorIdGetter(db);
const upsertMinute = db.prepare(upsertSql('stats_minute'));
const upsertHour = db.prepare(upsertSql('stats_hour'));
const minuteCutoff = Date.now() - MINUTE_RETENTION_DAYS * DAY_MS;

// ---- CSV -> ringkasan ----
// File dikelompokkan per gearbox. Log lama bisa berisi baris dobel (dan dulu nama
// file-nya pakai tanggal UTC), jadi semua file satu gearbox dibaca bersama dan
// timestamp yang sama hanya dihitung sekali.
const groups = new Map();
(fs.existsSync(LOG_DIR) ? fs.readdirSync(LOG_DIR) : []).forEach(name => {
    const m = name.match(/^(.+)_([a-z0-9]+)_\d{4}-\d{2}-\d{2}\.csv(?:\.gz)?$/);
    if (!m) return;
    const key = `${m[1]}/${m[2]}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(name);
});

db.exec('BEGIN');
try {
    db.exec('DELETE FROM stats_minute; DELETE FROM stats_hour; DELETE FROM alarm_events;');

    let totalSamples = 0;
    groups.forEach((files, key) => {
        const [craneId, gbKey] = key.split('/');
        const sid = sensorId(craneId, gbKey);
        const seen = new Set();
        const buckets = new Map(); // "m|ts" / "h|ts" -> bucket

        files.forEach(name => {
            const raw = fs.readFileSync(path.join(LOG_DIR, name));
            (name.endsWith('.gz') ? zlib.gunzipSync(raw) : raw).toString('utf-8').split(/\r?\n/).forEach(line => {
                const comma = line.indexOf(',');
                if (comma < 0) return;
                const ms = Date.parse(line.slice(0, comma));
                if (!Number.isFinite(ms) || seen.has(ms)) return; // header / baris dobel
                seen.add(ms);

                const temp = parseFloat(line.slice(comma + 1));
                const valid = AlarmRules.isValidTemp(temp);
                [['m', ms - (ms % MINUTE_MS)], ['h', ms - (ms % HOUR_MS)]].forEach(([kind, ts]) => {
                    if (kind === 'm' && ts < minuteCutoff) return;
                    const k = `${kind}|${ts}`;
                    let b = buckets.get(k);
                    if (!b) buckets.set(k, b = { min: null, max: null, sum: 0, n: 0, errors: 0 });
                    if (!valid) return void b.errors++;
                    b.min = b.min === null ? temp : Math.min(b.min, temp);
                    b.max = b.max === null ? temp : Math.max(b.max, temp);
                    b.sum += temp;
                    b.n++;
                });
            });
        });

        buckets.forEach((b, k) => {
            const [kind, ts] = k.split('|');
            (kind === 'm' ? upsertMinute : upsertHour).run(sid, Number(ts), b.min, b.max, b.sum, b.n, b.errors);
        });
        totalSamples += seen.size;
        console.log(`[Import] ${key}: ${seen.size} sampel unik dari ${files.length} file`);
    });

    // ---- riwayat alarm ----
    let alarmEvents = 0;
    if (fs.existsSync(HISTORY_FILE)) {
        const write = alarmEventWriter(db);
        fs.readFileSync(HISTORY_FILE, 'utf-8').split('\n').filter(Boolean).forEach(line => {
            try {
                write(JSON.parse(line));
                alarmEvents++;
            } catch (e) { /* baris rusak dilewati */ }
        });
    }

    db.exec('COMMIT');
    console.log(`[Import] Selesai: ${groups.size} gearbox, ${totalSamples} sampel, ${alarmEvents} kejadian alarm.`);
} catch (e) {
    db.exec('ROLLBACK');
    console.error('[Import] Gagal, database tidak diubah:', e.message);
    process.exit(1);
}
db.close();
