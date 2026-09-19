// ============================================================
// LAPORAN - query tren & ringkasan periode dari data/monitoring.db
// ============================================================
// Dipakai server.js untuk API halaman laporan (laporan.html):
//   trend()             -> grafik suhu satu gearbox (min / rata-rata / maks per interval)
//   periodReport()      -> ringkasan semua gearbox dalam satu periode
//   alarmOccurrences()  -> daftar kejadian alarm (mulai, selesai, durasi, siapa yang ack)

const AlarmRules = require('./alarm_rules');
const { MINUTE_MS, HOUR_MS, DAY_MS, MINUTE_RETENTION_DAYS } = require('./db');

const WIB_OFFSET_MS = 7 * HOUR_MS; // interval harian dihitung dari jam 00:00 WIB

// Ukuran interval grafik menyesuaikan panjang periode (maks ~600 titik)
function pickBucket(rangeMs) {
    if (rangeMs <= 6 * HOUR_MS) return MINUTE_MS;
    if (rangeMs <= 2 * DAY_MS) return 5 * MINUTE_MS;
    if (rangeMs <= 14 * DAY_MS) return HOUR_MS;
    if (rangeMs <= 120 * DAY_MS) return 6 * HOUR_MS;
    return DAY_MS;
}

// Ringkasan per menit hanya ada MINUTE_RETENTION_DAYS hari terakhir; di luar itu pakai per jam
function minuteDataCovers(from, nowMs) {
    return from >= nowMs - MINUTE_RETENTION_DAYS * DAY_MS;
}

const round1 = v => (v === null || v === undefined ? null : Math.round(v * 10) / 10);

function findSensor(db, craneId, gbKey) {
    return db.prepare('SELECT id FROM sensors WHERE crane_id = ? AND gb_key = ?').get(craneId, gbKey);
}

function trend(db, { craneId, gbKey, from, to, nowMs = Date.now() }) {
    const bucketMs = pickBucket(to - from);
    const sensor = findSensor(db, craneId, gbKey);
    if (!sensor) return { bucketMs, points: [] };

    const table = bucketMs < HOUR_MS && minuteDataCovers(from, nowMs) ? 'stats_minute' : 'stats_hour';
    const effectiveBucket = table === 'stats_hour' ? Math.max(bucketMs, HOUR_MS) : bucketMs;
    const rows = db.prepare(`
        SELECT ((ts + ${WIB_OFFSET_MS}) / ${effectiveBucket}) * ${effectiveBucket} - ${WIB_OFFSET_MS} AS t,
               MIN(temp_min) AS mn, MAX(temp_max) AS mx, SUM(temp_sum) AS s, SUM(n) AS n, SUM(errors) AS e
        FROM ${table}
        WHERE sensor_id = ? AND ts >= ? AND ts < ?
        GROUP BY t ORDER BY t`).all(sensor.id, from, to);

    return {
        bucketMs: effectiveBucket,
        points: rows.map(r => ({
            t: r.t,
            min: round1(r.mn),
            max: round1(r.mx),
            avg: r.n > 0 ? round1(r.s / r.n) : null,
            n: r.n,
            errors: r.e
        }))
    };
}

function periodReport(db, config, { from, to, nowMs = Date.now() }) {
    const useMinute = minuteDataCovers(from, nowMs);
    const table = useMinute ? 'stats_minute' : 'stats_hour';
    const end = Math.min(to, nowMs);

    const agg = db.prepare(`
        SELECT MIN(temp_min) AS mn, MAX(temp_max) AS mx, SUM(temp_sum) AS s, SUM(n) AS n, SUM(errors) AS e,
               SUM(n > 0) AS buckets_with_data
        FROM ${table} WHERE sensor_id = ? AND ts >= ? AND ts < ?`);
    const maxAt = db.prepare(`
        SELECT ts FROM ${table} WHERE sensor_id = ? AND ts >= ? AND ts < ? AND temp_max IS NOT NULL
        ORDER BY temp_max DESC LIMIT 1`);
    const overLimits = db.prepare(`
        SELECT SUM(temp_max > ? AND temp_max <= ?) AS warn, SUM(temp_max > ?) AS danger
        FROM stats_minute WHERE sensor_id = ? AND ts >= ? AND ts < ?`);
    const firstData = db.prepare('SELECT MIN(ts) AS ts FROM stats_hour WHERE sensor_id = ?');
    const alarmCounts = db.prepare(`
        SELECT type, severity, COUNT(*) AS c FROM alarm_events
        WHERE crane_id = ? AND gb_key = ? AND at >= ? AND at < ? AND event IN ('raised', 'escalated')
        GROUP BY type, severity`);
    const alarmDuration = db.prepare(`
        SELECT SUM(duration_ms) AS d FROM alarm_events
        WHERE crane_id = ? AND gb_key = ? AND at >= ? AND at < ? AND event = 'cleared'`);

    const rows = [];
    db.prepare('SELECT id, crane_id, gb_key FROM sensors ORDER BY crane_id, gb_key').all().forEach(sensor => {
        const a = agg.get(sensor.id, from, to);
        if (!a || (a.n === null && a.e === null)) return; // tidak ada data sama sekali di periode ini

        const limits = AlarmRules.getLimits(config, sensor.crane_id, sensor.gb_key);
        const over = useMinute ? overLimits.get(limits.warning, limits.danger, limits.danger, sensor.id, from, to) : null;

        // Ketersediaan data dihitung sejak sensor pertama kali mengirim (bukan sejak awal
        // periode), supaya crane yang baru dipasang tidak terlihat "banyak bolong".
        const since = Math.max(from, firstData.get(sensor.id).ts || from);
        const bucketSize = useMinute ? MINUTE_MS : HOUR_MS;
        const expected = Math.max(1, Math.ceil((end - since) / bucketSize));

        const alarms = { danger: 0, warning: 0, sensor: 0 };
        alarmCounts.all(sensor.crane_id, sensor.gb_key, from, to).forEach(c => {
            if (c.type === 'fault' || c.type === 'offline' || c.type === 'low') alarms.sensor += c.c;
            else alarms[c.severity] += c.c;
        });

        const max = maxAt.get(sensor.id, from, to);
        rows.push({
            craneId: sensor.crane_id,
            gbKey: sensor.gb_key,
            limits: { low: limits.low, warning: limits.warning, danger: limits.danger },
            min: round1(a.mn),
            avg: a.n > 0 ? round1(a.s / a.n) : null,
            max: round1(a.mx),
            maxAt: max ? max.ts : null,
            warningMinutes: over ? over.warn || 0 : null,
            dangerMinutes: over ? over.danger || 0 : null,
            alarms,
            alarmDurationMs: alarmDuration.get(sensor.crane_id, sensor.gb_key, from, to).d || 0,
            samples: a.n || 0,
            errorSamples: a.e || 0,
            availability: Math.min(1, (a.buckets_with_data || 0) / expected)
        });
    });

    return { from, to, resolution: useMinute ? 'minute' : 'hour', rows };
}

// Susun event (muncul / naik tingkat / ack / selesai) jadi satu baris per kejadian alarm
function alarmOccurrences(db, { from, to }) {
    // Mundur 30 hari supaya alarm yang MULAI sebelum periode tapi masih berjalan ikut terhitung
    const events = db.prepare('SELECT * FROM alarm_events WHERE at >= ? AND at < ? ORDER BY at, id')
        .all(from - 30 * DAY_MS, to);

    const open = new Map();
    const list = [];
    // Puncak = nilai terbesar yang tercatat di event mana pun dalam satu kejadian
    // (event lama belum punya kolom peak, jadi nilai saat itu juga ikut dihitung)
    const trackPeak = (occ, e) => {
        if (occ.type !== 'temp' && occ.type !== 'rise') return;
        [e.peak, parseFloat(e.value)].forEach(v => {
            if (Number.isFinite(v) && (occ.peak === null || v > occ.peak)) occ.peak = v;
        });
    };

    events.forEach(e => {
        let occ = open.get(e.alarm_id);
        if (e.event === 'raised' || (e.event === 'escalated' && !occ)) {
            occ = {
                alarmId: e.alarm_id, craneId: e.crane_id, gbKey: e.gb_key, type: e.type,
                severity: e.severity, start: e.at, end: null, limit: e.limit_value,
                peak: null, value: e.value, escalatedAt: null, ackedBy: null, ackedAt: null
            };
            trackPeak(occ, e);
            open.set(e.alarm_id, occ);
            list.push(occ);
            return;
        }
        if (!occ) return;
        trackPeak(occ, e);
        if (e.event === 'escalated') {
            occ.severity = e.severity;
            occ.escalatedAt = e.at;
            occ.limit = e.limit_value;
            occ.ackedBy = null; // ack sebelum naik tingkat tidak berlaku lagi
            occ.ackedAt = null;
        } else if (e.event === 'acked') {
            occ.ackedBy = e.by;
            occ.ackedAt = e.at;
        } else if (e.event === 'cleared') {
            occ.end = e.at;
            open.delete(e.alarm_id);
        }
    });

    return list
        .filter(o => o.start < to && (o.end === null || o.end >= from))
        .sort((a, b) => b.start - a.start);
}

module.exports = { trend, periodReport, alarmOccurrences, pickBucket };
