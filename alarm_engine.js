// ============================================================
// MESIN ALARM - dijalankan di server.js
// ============================================================
// Menilai setiap pembacaan suhu yang masuk lewat MQTT dan menyalakan/mematikan alarm.
// Alarm dinilai di SERVER (bukan di browser) supaya:
//   - alarm tetap tercatat walau tidak ada yang membuka dashboard,
//   - status "sudah di-ack oleh siapa" sama di semua layar (TV, PC, HP),
//   - riwayatnya tersimpan (alarms/history.jsonl).
//
// Jenis alarm (satu gearbox bisa punya beberapa sekaligus):
//   temp    : suhu > batas atas normal (warning) / Max (danger). Naik tingkat
//             warning -> danger = alarm baru lagi
//   low     : suhu < Min (kemungkinan sensor lepas / terlalu dingin)
//   rise    : suhu naik >= riseDegrees dalam riseMinutes terakhir
//   fault   : nilai sensor tidak valid (termasuk fault yang dilaporkan MAX31865)
//   offline : tidak ada data > offlineMinutes, atau ESP32 putus (Last Will)
// Batas-batasnya dari config/settings.json (lihat alarm_rules.js).
//
// Siklus alarm: MUNCUL (belum di-ack, dashboard bunyi) -> DI-ACK (operator sudah tahu,
// bunyi berhenti, alarm tetap tampil selama kondisinya masih ada) -> SELESAI (kondisi
// kembali normal, pindah ke riwayat).

const EventEmitter = require('events');
const fs = require('fs');
const path = require('path');
const AlarmRules = require('./alarm_rules');

const HISTORY_IN_MEMORY = 200;   // event riwayat yang disimpan di memori / dikirim ke dashboard
const SEVERITY_RANK = { warning: 1, danger: 2 };

class AlarmEngine extends EventEmitter {
    constructor({ config, dir }) {
        super();
        this.config = config || {};
        this.dir = dir;
        this.activeFile = path.join(dir, 'active.json');
        this.historyFile = path.join(dir, 'history.jsonl');
        this.active = new Map();     // id -> alarm
        this.history = [];           // event terbaru di depan
        this.gearboxes = new Map();  // "crane-01/gb01" -> { lastSeen, samples: [{ ms, temp }] }
        this.saveTimer = null;
        this.startedAt = Date.now();

        fs.mkdirSync(dir, { recursive: true });
        this.load();
    }

    // ---------- simpan & muat ----------
    load() {
        try {
            JSON.parse(fs.readFileSync(this.activeFile, 'utf-8')).forEach(a => this.active.set(a.id, a));
        } catch (e) { /* belum ada */ }
        try {
            const lines = fs.readFileSync(this.historyFile, 'utf-8').trim().split('\n').slice(-HISTORY_IN_MEMORY);
            this.history = lines.filter(Boolean).map(l => JSON.parse(l)).reverse();
        } catch (e) { /* belum ada */ }
    }

    scheduleSave() {
        if (this.saveTimer) return;
        this.saveTimer = setTimeout(() => {
            this.saveTimer = null;
            fs.writeFile(this.activeFile, JSON.stringify([...this.active.values()], null, 2), err => {
                if (err) console.error('[Alarm] Gagal simpan alarm aktif:', err.message);
            });
        }, 1000);
    }

    record(event, alarm, extra = {}) {
        const entry = { at: Date.now(), event, alarm: { ...alarm }, ...extra };
        this.history.unshift(entry);
        if (this.history.length > HISTORY_IN_MEMORY) this.history.pop();
        fs.appendFile(this.historyFile, JSON.stringify(entry) + '\n', err => {
            if (err) console.error('[Alarm] Gagal tulis riwayat:', err.message);
        });
        this.emit('event', entry); // server.js menyimpannya juga ke database untuk laporan
        console.log(`[Alarm] ${event.toUpperCase()} ${alarm.id} (${alarm.severity}) ${extra.by ? 'oleh ' + extra.by : ''}`.trim());
    }

    changed() {
        this.scheduleSave();
        this.emit('change');
    }

    // ---------- naik / turun alarm ----------
    raise(craneId, gbKey, type, severity, details) {
        const id = `${craneId}/${gbKey}/${type}`;
        const now = Date.now();
        const existing = this.active.get(id);

        // Nilai terparah selama alarm berlangsung (suhu / besar kenaikan), untuk laporan
        const numeric = typeof details.value === 'number' ? details.value : null;

        if (!existing) {
            const alarm = { id, craneId, gbKey, type, severity, raisedAt: now, updatedAt: now, ackedAt: null, ackedBy: null, ...details, peak: numeric };
            this.active.set(id, alarm);
            this.record('raised', alarm);
            this.changed();
            return;
        }

        const escalated = SEVERITY_RANK[severity] > SEVERITY_RANK[existing.severity];
        Object.assign(existing, details, { severity, updatedAt: now });
        if (numeric !== null) existing.peak = existing.peak === null || existing.peak === undefined ? numeric : Math.max(existing.peak, numeric);
        if (escalated) {
            // Naik tingkat (warning -> danger) harus diperhatikan lagi walau sudah di-ack
            existing.raisedAt = now;
            existing.ackedAt = null;
            existing.ackedBy = null;
            this.record('escalated', existing);
        }
        this.changed();
    }

    clear(craneId, gbKey, type) {
        const id = `${craneId}/${gbKey}/${type}`;
        const alarm = this.active.get(id);
        if (!alarm) return;
        this.active.delete(id);
        this.record('cleared', alarm, { durationMs: Date.now() - alarm.raisedAt });
        this.changed();
    }

    ack(id, by) {
        const alarm = this.active.get(id);
        if (!alarm || alarm.ackedAt) return false;
        alarm.ackedAt = Date.now();
        alarm.ackedBy = by;
        this.record('acked', alarm, { by });
        this.changed();
        return true;
    }

    // ---------- penilaian ----------
    gearbox(craneId, gbKey) {
        const key = `${craneId}/${gbKey}`;
        if (!this.gearboxes.has(key)) this.gearboxes.set(key, { lastSeen: null, samples: [] });
        return this.gearboxes.get(key);
    }

    // Dipanggil saat server baru nyala: waktu data terakhir tiap gearbox dari state.json,
    // supaya sensor yang sudah lama mati langsung ketahuan offline.
    seedLastSeen(craneId, gbKey, ms) {
        const gb = this.gearbox(craneId, gbKey);
        if (gb.lastSeen === null || ms > gb.lastSeen) gb.lastSeen = ms;
    }

    // Hanya crane yang sudah diaktifkan (terpasang) dan gearbox yang terdaftar di
    // pengaturan yang dinilai. Perangkat baru yang belum diaktifkan tidak memicu alarm.
    isMonitored(craneId, gbKey) {
        const crane = AlarmRules.findCrane(this.config, craneId);
        return !!crane && crane.installed === true && crane.gearboxes.some(g => g.key === gbKey);
    }

    // Setelah pengaturan berubah (mis. crane dinonaktifkan / gearbox dihapus):
    // alarm milik gearbox yang tidak lagi dipantau diselesaikan.
    dropUnmonitored() {
        [...this.active.values()].forEach(a => {
            if (!this.isMonitored(a.craneId, a.gbKey)) this.clear(a.craneId, a.gbKey, a.type);
        });
    }

    // faultCode: kode fault MAX31865 dari firmware v2 (mis. "0x80"), kalau ada
    ingest(craneId, gbKey, rawValue, nowMs = Date.now(), faultCode = null) {
        if (!this.isMonitored(craneId, gbKey)) return;
        const limits = AlarmRules.getLimits(this.config, craneId, gbKey);
        const gb = this.gearbox(craneId, gbKey);
        gb.lastSeen = nowMs;
        this.clear(craneId, gbKey, 'offline');

        const temp = typeof rawValue === 'number' ? rawValue : parseFloat(rawValue);
        if (!AlarmRules.isValidTemp(temp)) {
            this.raise(craneId, gbKey, 'fault', 'warning', { value: String(rawValue), code: faultCode });
            return; // status suhu tidak diketahui: alarm suhu yang ada dibiarkan
        }
        this.clear(craneId, gbKey, 'fault');

        this.evaluateTemp(craneId, gbKey, temp, limits);
        this.evaluateLow(craneId, gbKey, temp, limits);
        this.evaluateRise(craneId, gbKey, gb, temp, nowMs, limits);
    }

    evaluateLow(craneId, gbKey, temp, limits) {
        const existing = this.active.get(`${craneId}/${gbKey}/low`);
        if (temp < limits.low) {
            if (existing && existing.value === temp) return;
            this.raise(craneId, gbKey, 'low', 'warning', { value: temp, limit: limits.low });
        } else if (existing && temp >= limits.low + limits.hysteresis) {
            this.clear(craneId, gbKey, 'low');
        }
    }

    evaluateTemp(craneId, gbKey, temp, limits) {
        const existing = this.active.get(`${craneId}/${gbKey}/temp`);
        let severity = AlarmRules.upperStatus(temp, limits);

        // Hysteresis: turun tingkat / selesai baru kalau suhu sudah turun cukup jauh
        if (existing) {
            if (existing.severity === 'danger' && severity !== 'danger' && temp > limits.danger - limits.hysteresis) severity = 'danger';
            if (severity === 'normal' && temp > limits.warning - limits.hysteresis) severity = 'warning';
        }

        if (severity === 'normal') {
            this.clear(craneId, gbKey, 'temp');
            return;
        }
        const limit = severity === 'danger' ? limits.danger : limits.warning;
        if (existing && existing.severity === severity && existing.value === temp) return; // tidak ada yang berubah
        this.raise(craneId, gbKey, 'temp', severity, { value: temp, limit });
    }

    evaluateRise(craneId, gbKey, gb, temp, nowMs, limits) {
        const windowMs = limits.riseMinutes * 60 * 1000;
        gb.samples.push({ ms: nowMs, temp });
        while (gb.samples.length && gb.samples[0].ms < nowMs - windowMs) gb.samples.shift();

        const minTemp = Math.min(...gb.samples.map(s => s.temp));
        const rise = Math.round((temp - minTemp) * 10) / 10;
        const existing = this.active.get(`${craneId}/${gbKey}/rise`);

        if (rise >= limits.riseDegrees) {
            if (existing && existing.value === rise) return;
            this.raise(craneId, gbKey, 'rise', 'warning', { value: rise, limit: limits.riseDegrees, windowMinutes: limits.riseMinutes });
        } else if (existing && rise < limits.riseDegrees / 2) {
            this.clear(craneId, gbKey, 'rise');
        }
    }

    // Dipanggil berkala: gearbox yang pernah kirim data tapi sekarang diam -> offline.
    // Setelah server baru nyala (mis. PC restart), sensor diberi waktu offlineMinutes
    // dulu untuk melapor - kalau tidak, semua gearbox sempat "offline" palsu karena
    // data terakhir di state.json pasti sudah lama.
    checkOffline(nowMs = Date.now()) {
        this.gearboxes.forEach((gb, key) => {
            if (gb.lastSeen === null) return;
            const [craneId, gbKey] = key.split('/');
            if (!this.isMonitored(craneId, gbKey)) return;
            const limits = AlarmRules.getLimits(this.config, craneId, gbKey);
            const silentSince = Math.max(gb.lastSeen, this.startedAt);
            if (nowMs - silentSince > limits.offlineMinutes * 60 * 1000 && !this.active.has(`${key}/offline`)) {
                this.raise(craneId, gbKey, 'offline', 'warning', { lastSeen: gb.lastSeen, limit: limits.offlineMinutes });
            }
        });
    }

    // ESP32 mengabarkan dirinya putus (Last Will dari broker): semua gearbox crane
    // itu langsung offline, tanpa menunggu offlineMinutes.
    deviceOffline(craneId, nowMs = Date.now()) {
        this.gearboxes.forEach((gb, key) => {
            const [cId, gbKey] = key.split('/');
            if (cId !== craneId || this.active.has(`${key}/offline`) || !this.isMonitored(cId, gbKey)) return;
            const limits = AlarmRules.getLimits(this.config, cId, gbKey);
            this.raise(cId, gbKey, 'offline', 'warning', { lastSeen: gb.lastSeen || nowMs, limit: limits.offlineMinutes, reason: 'lwt' });
        });
    }

    snapshot() {
        const active = [...this.active.values()].sort((a, b) =>
            (a.ackedAt ? 1 : 0) - (b.ackedAt ? 1 : 0) ||
            SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] ||
            b.raisedAt - a.raisedAt);
        return { active, history: this.history.slice(0, 50) };
    }
}

module.exports = { AlarmEngine };
