// ============================================================
// DAFTAR PERANGKAT (ESP32) - dasar deteksi crane baru
// ============================================================
// server.js mencatat setiap crane yang PERNAH mengirim data ke broker, walau
// belum diaktifkan di pengaturan. Dari sini dashboard tahu ada "perangkat baru
// terdeteksi" yang tinggal diaktifkan dengan satu klik.
//
// Sumber informasinya:
//   pabrik/<area>/<id-perangkat>/temp    -> kapan terakhir kirim data, motor apa saja
//   pabrik/<area>/<id-perangkat>/status  -> online/offline (Last Will), versi firmware, IP,
//                                           kekuatan sinyal WiFi, dsb (firmware versi baru)
//
// SATU BARIS = SATU ESP32, bukan satu crane. Crane yang dipasangi beberapa ESP32 punya
// beberapa baris: "crane-01" (ESP utama) dan "crane-01_2", "crane-01_3" (ESP tambahan, lihat
// parseDeviceId di alarm_rules.js). d.id = ID perangkat itu, d.craneId = crane induknya,
// d.node = nomor ESP di crane itu (1 = utama).
//
// Pembagian motor antar ESP32 dipelajari dari data yang masuk (d.gbKeys): motor yang dikirim
// ESP32 X dianggap terpasang di ESP32 X. Kalau sensor sebuah motor dipindah ke ESP32 lain,
// catatannya ikut pindah. Kalau DUA ESP32 di crane yang sama mengirim key motor yang sama
// dalam waktu berdekatan, itu salah konfigurasi (dua sensor berbeda tercampur jadi satu
// motor) -> dicatat di d.conflicts dan ditampilkan di Pengaturan.
//
// Disimpan di tabel "devices" di data/monitoring.db. Kolom crane_id berisi ID PERANGKAT
// (nama kolomnya dipertahankan supaya database lama tetap terbaca apa adanya).

const EventEmitter = require('events');
const { parseDeviceId } = require('./alarm_rules');

const FLUSH_MS = 30000; // "terakhir terlihat" ditulis ke database maksimal tiap 30 detik
// Motor yang dikirim dua ESP32 dalam jendela ini = bentrok (bukan sensor yang dipindah)
const CONFLICT_WINDOW_MS = 2 * 60 * 1000;

class DeviceRegistry extends EventEmitter {
    constructor(db) {
        super();
        this.db = db;
        db.exec(`
            CREATE TABLE IF NOT EXISTS devices (
                crane_id   TEXT PRIMARY KEY, -- ID perangkat: "crane-01" atau "crane-01_2" (ESP tambahan)
                area       TEXT,
                first_seen INTEGER,
                last_seen  INTEGER,
                gb_keys    TEXT,     -- JSON array: motor yang dikirim ESP32 ini
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
        this.deleteStmt = db.prepare('DELETE FROM devices WHERE crane_id = ?');

        this.devices = new Map();
        db.prepare('SELECT * FROM devices').all().forEach(r => {
            const parsed = parseDeviceId(r.crane_id);
            if (!parsed) return;
            this.devices.set(r.crane_id, {
                id: r.crane_id, craneId: parsed.craneId, node: parsed.node, area: r.area,
                firstSeen: r.first_seen, lastSeen: r.last_seen,
                gbKeys: JSON.parse(r.gb_keys || '[]'),
                online: r.online === null ? null : !!r.online,
                info: r.info ? JSON.parse(r.info) : null, statusAt: r.status_at,
                ignoredAt: r.ignored_at, ignoredBy: r.ignored_by,
                keySeen: {}, conflicts: {}
            });
        });
        this.dirty = new Set();
        setInterval(() => this.flush(), FLUSH_MS).unref();
    }

    device(deviceId, area, now) {
        let d = this.devices.get(deviceId);
        if (!d) {
            const { craneId, node } = parseDeviceId(deviceId);
            d = {
                id: deviceId, craneId, node, area, firstSeen: now, lastSeen: now, gbKeys: [], online: null, info: null,
                statusAt: null, ignoredAt: null, ignoredBy: null, keySeen: {}, conflicts: {}
            };
            this.devices.set(deviceId, d);
            this.isNew = true;
        }
        return d;
    }

    // Semua ESP32 milik satu crane, ESP utama dulu
    ofCrane(craneId) {
        return [...this.devices.values()].filter(d => d.craneId === craneId).sort((a, b) => a.node - b.node);
    }

    persist(d) {
        this.upsert.run(d.id, d.area, d.firstSeen, d.lastSeen, JSON.stringify(d.gbKeys),
            d.online === null ? null : d.online ? 1 : 0, d.info ? JSON.stringify(d.info) : null,
            d.statusAt, d.ignoredAt, d.ignoredBy);
    }

    flush() {
        this.dirty.forEach(id => {
            const d = this.devices.get(id);
            if (!d) return this.dirty.delete(id);
            try {
                this.persist(d);
            } catch (e) {
                console.error('[Perangkat] Gagal simpan ke database:', e.message);
                return;
            }
            this.dirty.delete(id);
        });
    }

    // Pesan data suhu masuk dari ESP32 deviceId
    seenData(deviceId, area, gbKeys, now = Date.now()) {
        this.isNew = false;
        const d = this.device(deviceId, area, now);
        const newGb = gbKeys.filter(k => !d.gbKeys.includes(k));
        d.lastSeen = now;
        d.area = area;
        gbKeys.forEach(k => { d.keySeen[k] = now; });
        if (newGb.length) d.gbKeys = [...d.gbKeys, ...newGb].sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
        // Data masuk = perangkat hidup lagi (firmware lama tidak kirim pesan status)
        const cameBack = d.online === false;
        if (cameBack) d.online = true;

        // Motor yang sama juga tercatat di ESP32 lain crane ini?
        let ownershipChanged = false;
        this.ofCrane(d.craneId).forEach(other => {
            if (other === d) return;
            gbKeys.forEach(k => {
                if (!other.gbKeys.includes(k)) return;
                const otherSeen = other.keySeen[k] || 0;
                if (now - otherSeen < CONFLICT_WINDOW_MS) {
                    // dua ESP32 mengirim motor yang sama bersamaan -> bentrok, catat di keduanya
                    if (!d.conflicts[k]) ownershipChanged = true;
                    d.conflicts[k] = { with: other.id, at: now };
                    other.conflicts[k] = { with: d.id, at: now };
                } else {
                    // ESP32 lain sudah lama tidak mengirim motor ini -> sensornya dipindah ke sini
                    other.gbKeys = other.gbKeys.filter(x => x !== k);
                    delete other.keySeen[k];
                    delete other.conflicts[k];
                    this.persist(other);
                    ownershipChanged = true;
                }
            });
        });
        // Bentrok yang sudah tidak terulang dilupakan
        Object.entries(d.conflicts).forEach(([k, c]) => {
            if (now - c.at > CONFLICT_WINDOW_MS) {
                delete d.conflicts[k];
                ownershipChanged = true;
            }
        });

        if (this.isNew || newGb.length || cameBack || ownershipChanged) {
            this.persist(d); // perangkat / motor baru: langsung simpan & kabari dashboard
            this.emit('change');
        } else {
            this.dirty.add(deviceId);
        }
    }

    // Pesan status dari firmware baru (termasuk Last Will saat ESP32 putus mendadak)
    seenStatus(deviceId, area, info, now = Date.now()) {
        this.isNew = false;
        const d = this.device(deviceId, area, now);
        d.area = area;
        d.online = info.online !== false;
        d.info = info;
        d.statusAt = now;
        if (d.online) d.lastSeen = now;
        this.persist(d);
        this.emit('change');
        return d;
    }

    ignore(deviceId, by) {
        const d = this.devices.get(deviceId);
        if (!d) return false;
        d.ignoredAt = Date.now();
        d.ignoredBy = by;
        this.persist(d);
        this.emit('change');
        return true;
    }

    // Mengaktifkan crane = semua ESP32-nya tidak lagi diabaikan
    unignore(craneId) {
        this.ofCrane(craneId).forEach(d => {
            if (!d.ignoredAt) return;
            d.ignoredAt = null;
            d.ignoredBy = null;
            this.persist(d);
            this.emit('change');
        });
    }

    // Hapus dari daftar "perangkat terdeteksi" SAJA (tabel devices).
    // Tidak menyentuh config/settings.json (data crane & motor tetap ada).
    // Kalau ESP32 ini kirim data lagi, dia akan tercatat dari nol (muncul lagi di sini).
    remove(deviceId) {
        if (!this.devices.has(deviceId)) return false;
        this.devices.delete(deviceId);
        this.dirty.delete(deviceId);
        this.deleteStmt.run(deviceId);
        this.emit('change');
        return true;
    }

    list() {
        return [...this.devices.values()].sort((a, b) => a.craneId.localeCompare(b.craneId, 'en', { numeric: true }) || a.node - b.node);
    }
}

module.exports = { DeviceRegistry };
