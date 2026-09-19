// ============================================================
// DAFTAR PERANGKAT (ESP32) - dasar deteksi crane baru
// ============================================================
// server.js mencatat setiap crane yang PERNAH mengirim data ke broker, walau
// belum diaktifkan di pengaturan. Dari sini dashboard tahu ada "perangkat baru
// terdeteksi" yang tinggal diaktifkan dengan satu klik.
//
// Sumber informasinya:
//   pabrik/<area>/<crane>/temp    -> kapan terakhir kirim data, gearbox apa saja
//   pabrik/<area>/<crane>/status  -> online/offline (Last Will), versi firmware, IP,
//                                    kekuatan sinyal WiFi, dsb (firmware versi baru)
//
// Disimpan di tabel "devices" di data/monitoring.db.

const EventEmitter = require('events');

const FLUSH_MS = 30000; // "terakhir terlihat" ditulis ke database maksimal tiap 30 detik

class DeviceRegistry extends EventEmitter {
    constructor(db) {
        super();
        this.db = db;
        db.exec(`
            CREATE TABLE IF NOT EXISTS devices (
                crane_id   TEXT PRIMARY KEY,
                area       TEXT,
                first_seen INTEGER,
                last_seen  INTEGER,
                gb_keys    TEXT,     -- JSON array: gearbox yang pernah mengirim data
                online     INTEGER,  -- dari pesan status (NULL = firmware lama, tidak kirim status)
                info       TEXT,     -- JSON pesan status terakhir
                status_at  INTEGER,
                ignored_at INTEGER,
                ignored_by TEXT
            )`);
        this.upsert = db.prepare(`
            INSERT INTO devices (crane_id, area, first_seen, last_seen, gb_keys, online, info, status_at, ignored_at, ignored_by)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT (crane_id) DO UPDATE SET
                area = excluded.area, last_seen = excluded.last_seen, gb_keys = excluded.gb_keys,
                online = excluded.online, info = excluded.info, status_at = excluded.status_at,
                ignored_at = excluded.ignored_at, ignored_by = excluded.ignored_by`);

        this.devices = new Map();
        db.prepare('SELECT * FROM devices').all().forEach(r => {
            this.devices.set(r.crane_id, {
                craneId: r.crane_id, area: r.area, firstSeen: r.first_seen, lastSeen: r.last_seen,
                gbKeys: JSON.parse(r.gb_keys || '[]'),
                online: r.online === null ? null : !!r.online,
                info: r.info ? JSON.parse(r.info) : null, statusAt: r.status_at,
                ignoredAt: r.ignored_at, ignoredBy: r.ignored_by
            });
        });
        this.dirty = new Set();
        setInterval(() => this.flush(), FLUSH_MS).unref();
    }

    device(craneId, area, now) {
        let d = this.devices.get(craneId);
        if (!d) {
            d = { craneId, area, firstSeen: now, lastSeen: now, gbKeys: [], online: null, info: null, statusAt: null, ignoredAt: null, ignoredBy: null };
            this.devices.set(craneId, d);
            this.isNew = true;
        }
        return d;
    }

    persist(d) {
        this.upsert.run(d.craneId, d.area, d.firstSeen, d.lastSeen, JSON.stringify(d.gbKeys),
            d.online === null ? null : d.online ? 1 : 0, d.info ? JSON.stringify(d.info) : null,
            d.statusAt, d.ignoredAt, d.ignoredBy);
    }

    flush() {
        this.dirty.forEach(id => {
            try {
                this.persist(this.devices.get(id));
            } catch (e) {
                console.error('[Perangkat] Gagal simpan ke database:', e.message);
                return;
            }
            this.dirty.delete(id);
        });
    }

    // Pesan data suhu masuk
    seenData(craneId, area, gbKeys, now = Date.now()) {
        this.isNew = false;
        const d = this.device(craneId, area, now);
        const newGb = gbKeys.filter(k => !d.gbKeys.includes(k));
        d.lastSeen = now;
        d.area = area;
        if (newGb.length) d.gbKeys = [...d.gbKeys, ...newGb].sort();
        // Data masuk = perangkat hidup lagi (firmware lama tidak kirim pesan status)
        const cameBack = d.online === false;
        if (cameBack) d.online = true;

        if (this.isNew || newGb.length || cameBack) {
            this.persist(d); // perangkat / gearbox baru: langsung simpan & kabari dashboard
            this.emit('change');
        } else {
            this.dirty.add(craneId);
        }
    }

    // Pesan status dari firmware baru (termasuk Last Will saat ESP32 putus mendadak)
    seenStatus(craneId, area, info, now = Date.now()) {
        this.isNew = false;
        const d = this.device(craneId, area, now);
        d.area = area;
        d.online = info.online !== false;
        d.info = info;
        d.statusAt = now;
        if (d.online) d.lastSeen = now;
        this.persist(d);
        this.emit('change');
        return d;
    }

    ignore(craneId, by) {
        const d = this.devices.get(craneId);
        if (!d) return false;
        d.ignoredAt = Date.now();
        d.ignoredBy = by;
        this.persist(d);
        this.emit('change');
        return true;
    }

    unignore(craneId) {
        const d = this.devices.get(craneId);
        if (!d || !d.ignoredAt) return;
        d.ignoredAt = null;
        d.ignoredBy = null;
        this.persist(d);
        this.emit('change');
    }

    list() {
        return [...this.devices.values()].sort((a, b) => a.craneId.localeCompare(b.craneId, 'en', { numeric: true }));
    }
}

module.exports = { DeviceRegistry };
