// ============================================================
// DATABASE - ringkasan suhu & kejadian alarm untuk laporan tren
// ============================================================
// Pakai SQLite bawaan Node.js (node:sqlite) - tidak perlu install apa-apa.
// File: data/monitoring.db
//
// Isi:
//   stats_minute : ringkasan PER MENIT tiap gearbox (min, maks, rata-rata, jumlah
//                  sampel, sampel error). Disimpan MINUTE_RETENTION_DAYS hari.
//   stats_hour   : ringkasan PER JAM, disimpan selamanya (untuk tren jangka panjang).
//   alarm_events : semua kejadian alarm (muncul, naik tingkat, di-ack, selesai).
//   settings_changes : catatan siapa mengubah pengaturan apa & kapan.
//   devices      : ESP32 yang pernah mengirim data (dikelola devices.js).
//
// Data mentah (tiap 5 detik) tetap diarsipkan di logs/*.csv. Database ini yang
// dipakai grafik tren & laporan, karena data mentah 25 crane (~2 juta baris/hari)
// terlalu berat untuk dibuka sebagai grafik.
//
// Yang menulis: mqtt_logger.js (stats) dan server.js (alarm_events). Mode WAL
// membuat keduanya bisa menulis/membaca bersamaan dengan aman.

const { DatabaseSync } = require('node:sqlite');
const fs = require('fs');
const path = require('path');
const AlarmRules = require('./alarm_rules');

const DB_FILE = path.join(__dirname, 'data', 'monitoring.db');
const MINUTE_RETENTION_DAYS = 90;
const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

function openDb(file = DB_FILE) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const db = new DatabaseSync(file);
    db.exec(`
        PRAGMA journal_mode = WAL;
        PRAGMA busy_timeout = 5000;
        PRAGMA synchronous = NORMAL;

        CREATE TABLE IF NOT EXISTS sensors (
            id       INTEGER PRIMARY KEY,
            crane_id TEXT NOT NULL,
            gb_key   TEXT NOT NULL,
            UNIQUE (crane_id, gb_key)
        );

        CREATE TABLE IF NOT EXISTS stats_minute (
            sensor_id INTEGER NOT NULL,
            ts        INTEGER NOT NULL,          -- awal menit, epoch ms
            temp_min  REAL,                      -- NULL kalau semua sampel error
            temp_max  REAL,
            temp_sum  REAL    NOT NULL DEFAULT 0,
            n         INTEGER NOT NULL DEFAULT 0, -- jumlah sampel valid
            errors    INTEGER NOT NULL DEFAULT 0, -- jumlah sampel tidak valid
            PRIMARY KEY (sensor_id, ts)
        ) WITHOUT ROWID;

        CREATE TABLE IF NOT EXISTS stats_hour (
            sensor_id INTEGER NOT NULL,
            ts        INTEGER NOT NULL,          -- awal jam, epoch ms
            temp_min  REAL,
            temp_max  REAL,
            temp_sum  REAL    NOT NULL DEFAULT 0,
            n         INTEGER NOT NULL DEFAULT 0,
            errors    INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY (sensor_id, ts)
        ) WITHOUT ROWID;

        CREATE TABLE IF NOT EXISTS alarm_events (
            id          INTEGER PRIMARY KEY,
            at          INTEGER NOT NULL,        -- epoch ms
            event       TEXT NOT NULL,           -- raised | escalated | acked | cleared
            alarm_id    TEXT NOT NULL,           -- crane-01/gb03/temp
            crane_id    TEXT NOT NULL,
            gb_key      TEXT NOT NULL,
            type        TEXT NOT NULL,           -- temp | rise | fault | offline
            severity    TEXT NOT NULL,           -- warning | danger
            value       TEXT,
            peak        REAL,
            limit_value REAL,
            by          TEXT,
            duration_ms INTEGER
        );
        CREATE INDEX IF NOT EXISTS idx_alarm_events_at ON alarm_events (at);

        -- Catatan perubahan pengaturan (nama, batas suhu, aktivasi crane)
        CREATE TABLE IF NOT EXISTS settings_changes (
            id      INTEGER PRIMARY KEY,
            at      INTEGER NOT NULL,
            by      TEXT,
            action  TEXT NOT NULL,
            changes TEXT NOT NULL      -- JSON array berisi kalimat perubahan
        );
    `);
    return db;
}

// Gabung ringkasan baru ke baris yang sudah ada (menit/jam yang sama bisa
// ditulis berkali-kali: flush berkala, data backlog ESP32, dsb)
function upsertSql(table) {
    return `
        INSERT INTO ${table} (sensor_id, ts, temp_min, temp_max, temp_sum, n, errors)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (sensor_id, ts) DO UPDATE SET
            temp_min = COALESCE(MIN(${table}.temp_min, excluded.temp_min), ${table}.temp_min, excluded.temp_min),
            temp_max = COALESCE(MAX(${table}.temp_max, excluded.temp_max), ${table}.temp_max, excluded.temp_max),
            temp_sum = ${table}.temp_sum + excluded.temp_sum,
            n        = ${table}.n + excluded.n,
            errors   = ${table}.errors + excluded.errors`;
}

function sensorIdGetter(db) {
    const insert = db.prepare('INSERT OR IGNORE INTO sensors (crane_id, gb_key) VALUES (?, ?)');
    const select = db.prepare('SELECT id FROM sensors WHERE crane_id = ? AND gb_key = ?');
    const cache = new Map();
    return (craneId, gbKey) => {
        const key = `${craneId}/${gbKey}`;
        if (!cache.has(key)) {
            insert.run(craneId, gbKey);
            cache.set(key, select.get(craneId, gbKey).id);
        }
        return cache.get(key);
    };
}

// ============================================================
// PENULIS RINGKASAN (dipakai mqtt_logger.js)
// ============================================================
// Pembacaan dikumpulkan di memori, lalu ditulis ke database tiap flush() dalam
// satu transaksi - jauh lebih ringan daripada menulis tiap 5 detik per gearbox.
class StatsWriter {
    constructor(db) {
        this.db = db;
        this.sensorId = sensorIdGetter(db);
        this.upsertMinute = db.prepare(upsertSql('stats_minute'));
        this.upsertHour = db.prepare(upsertSql('stats_hour'));
        this.pending = new Map(); // "sensorId|m|ts" -> bucket
    }

    bucket(key) {
        let b = this.pending.get(key);
        if (!b) {
            b = { min: null, max: null, sum: 0, n: 0, errors: 0 };
            this.pending.set(key, b);
        }
        return b;
    }

    add(craneId, gbKey, ms, rawValue) {
        const sid = this.sensorId(craneId, gbKey);
        const temp = typeof rawValue === 'number' ? rawValue : parseFloat(rawValue);
        const valid = AlarmRules.isValidTemp(temp);
        [['m', ms - (ms % MINUTE_MS)], ['h', ms - (ms % HOUR_MS)]].forEach(([kind, ts]) => {
            const b = this.bucket(`${sid}|${kind}|${ts}`);
            if (!valid) {
                b.errors++;
                return;
            }
            b.min = b.min === null ? temp : Math.min(b.min, temp);
            b.max = b.max === null ? temp : Math.max(b.max, temp);
            b.sum += temp;
            b.n++;
        });
    }

    flush() {
        if (this.pending.size === 0) return 0;
        const count = this.pending.size;
        this.db.exec('BEGIN');
        try {
            this.pending.forEach((b, key) => {
                const [sid, kind, ts] = key.split('|');
                const stmt = kind === 'm' ? this.upsertMinute : this.upsertHour;
                stmt.run(Number(sid), Number(ts), b.min, b.max, b.sum, b.n, b.errors);
            });
            this.db.exec('COMMIT');
        } catch (e) {
            this.db.exec('ROLLBACK');
            throw e; // data tetap di pending, dicoba lagi di flush berikutnya
        }
        this.pending.clear();
        return count;
    }

    // Ringkasan per menit yang lebih tua dari MINUTE_RETENTION_DAYS dihapus
    // (ringkasan per jam tetap ada).
    prune(nowMs = Date.now()) {
        return this.db.prepare('DELETE FROM stats_minute WHERE ts < ?').run(nowMs - MINUTE_RETENTION_DAYS * DAY_MS).changes;
    }
}

// ============================================================
// KEJADIAN ALARM (dipakai server.js)
// ============================================================
function alarmEventWriter(db) {
    const stmt = db.prepare(`
        INSERT INTO alarm_events (at, event, alarm_id, crane_id, gb_key, type, severity, value, peak, limit_value, by, duration_ms)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    return entry => {
        const a = entry.alarm;
        const num = v => (typeof v === 'number' && Number.isFinite(v) ? v : null);
        stmt.run(entry.at, entry.event, a.id, a.craneId, a.gbKey, a.type, a.severity,
            a.value === undefined ? null : String(a.value), num(a.peak), num(a.limit),
            entry.by || null, num(entry.durationMs));
    };
}

module.exports = {
    DB_FILE, MINUTE_RETENTION_DAYS, MINUTE_MS, HOUR_MS, DAY_MS,
    openDb, upsertSql, sensorIdGetter, StatsWriter, alarmEventWriter
};
