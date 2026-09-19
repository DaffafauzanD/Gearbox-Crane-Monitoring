// ============================================================
// ATURAN STATUS & ALARM - satu sumber untuk browser dan Node
// ============================================================
// Di browser tersedia sebagai window.AlarmRules, di Node lewat require('./alarm_rules').
// Nilai batasnya sendiri disimpan di config/settings.json (diatur lewat halaman
// Pengaturan): batas default + batas khusus per crane / per gearbox.
//
// Rentang suhu satu gearbox:
//
//     low (Min)          warning (batas atas normal)     danger (Max)
//   ─────┼───────────────────────────┼───────────────────────┼──────────
//   SUHU RENDAH        NORMAL                  WARNING                 DANGER
//   (sensor lepas /    (gearbox bekerja        (mendekati Max)
//    terlalu dingin)    dengan baik)

(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.AlarmRules = factory();
})(typeof self !== 'undefined' ? self : this, function () {
    // Nilai di luar rentang ini bukan suhu yang masuk akal -> dianggap sensor error.
    // (PT100 + MAX31865 yang kabelnya putus terbaca sekitar -242 °C)
    const SENSOR_MIN_VALID = -20;
    const SENSOR_MAX_VALID = 200;

    // Dipakai kalau settings tidak menyebut suatu nilai
    const DEFAULTS = {
        low: 15,            // di bawah ini: alarm suhu rendah
        warning: 70,        // batas atas normal: di atas ini Warning
        danger: 80,         // Max: di atas ini Danger
        hysteresis: 2,      // alarm suhu baru selesai kalau sudah kembali sejauh ini dari batasnya
        riseDegrees: 10,    // alarm kenaikan cepat: naik >= ini ...
        riseMinutes: 10,    // ... dalam sekian menit
        offlineMinutes: 2   // tidak ada data selama ini -> offline
    };
    const LIMIT_KEYS = Object.keys(DEFAULTS);

    function findCrane(settings, craneId) {
        return ((settings && settings.cranes) || []).find(c => c.id === craneId);
    }

    // Batas untuk satu gearbox: default <- batas khusus crane <- batas khusus gearbox
    function getLimits(settings, craneId, gbKey) {
        const crane = findCrane(settings, craneId);
        const gb = crane && (crane.gearboxes || []).find(g => g.key === gbKey);
        return Object.assign({}, DEFAULTS, settings && settings.defaults, crane && crane.limits, gb && gb.limits);
    }

    function isValidTemp(v) {
        return typeof v === 'number' && Number.isFinite(v) && v >= SENSOR_MIN_VALID && v <= SENSOR_MAX_VALID;
    }

    // Status dari sisi atas saja (dipakai alarm suhu tinggi)
    function upperStatus(temp, limits) {
        if (temp > limits.danger) return 'danger';
        if (temp > limits.warning) return 'warning';
        return 'normal';
    }

    function tempStatus(temp, limits) {
        if (temp < limits.low) return 'low';
        return upperStatus(temp, limits);
    }

    // Cek satu set batas (yang sudah digabung dengan default). Kosong = aman.
    function validateLimits(limits, name) {
        const problems = [];
        LIMIT_KEYS.forEach(key => {
            if (typeof limits[key] !== 'number' || !Number.isFinite(limits[key])) problems.push(`${name}: ${key} harus angka`);
        });
        if (problems.length) return problems;
        if (!(limits.low < limits.warning)) problems.push(`${name}: Min (${limits.low}) harus lebih kecil dari batas atas normal (${limits.warning})`);
        if (!(limits.warning < limits.danger)) problems.push(`${name}: batas atas normal (${limits.warning}) harus lebih kecil dari Max (${limits.danger})`);
        if (limits.low < SENSOR_MIN_VALID || limits.danger > SENSOR_MAX_VALID) problems.push(`${name}: batas harus di antara ${SENSOR_MIN_VALID} dan ${SENSOR_MAX_VALID} °C`);
        if (limits.hysteresis < 0) problems.push(`${name}: hysteresis tidak boleh negatif`);
        if (limits.riseDegrees <= 0) problems.push(`${name}: kenaikan cepat (°C) harus lebih dari 0`);
        if (limits.riseMinutes < 1) problems.push(`${name}: waktu kenaikan cepat minimal 1 menit`);
        if (limits.offlineMinutes < 1) problems.push(`${name}: batas offline minimal 1 menit`);
        return problems;
    }

    return { SENSOR_MIN_VALID, SENSOR_MAX_VALID, DEFAULTS, LIMIT_KEYS, findCrane, getLimits, isValidTemp, upperStatus, tempStatus, validateLimits };
});
