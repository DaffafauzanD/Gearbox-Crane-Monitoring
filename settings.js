// ============================================================
// PENGATURAN - daftar crane, nama gearbox, dan batas suhu
// ============================================================
// Semua disimpan di config/settings.json. Biasanya diubah lewat halaman
// Pengaturan di web app (pengaturan.html -> API server.js), tapi file-nya juga
// boleh diedit manual - server membaca ulang otomatis kalau isinya valid.
//
// Bentuk file:
// {
//   "revision": 3,                       <- naik tiap disimpan (cegah saling timpa)
//   "defaults": { low, warning, danger, hysteresis, riseDegrees, riseMinutes, offlineMinutes },
//   "cranes": [
//     { "id": "crane-01", "name": "...", "location": "Plant TWB", "area": "twb",
//       "installed": true,               <- false = "Belum Terpasang" di dashboard
//       "limits": { },                   <- batas khusus crane ini (opsional)
//       "gearboxes": [
//         { "key": "gb01", "name": "GB 01 - ...", "sparepart": "", "limits": { } }
//       ] }
//   ]
// }
// "key" gearbox (gb01, gb02, ...) harus sama dengan key yang dikirim ESP32.

const fs = require('fs');
const path = require('path');
const AlarmRules = require('./alarm_rules');

const SETTINGS_FILE = path.join(__dirname, 'config', 'settings.json');

function load(file = SETTINGS_FILE) {
    return JSON.parse(fs.readFileSync(file, 'utf-8'));
}

// Kembalikan daftar masalah (kosong = valid)
function validate(settings) {
    const problems = [];
    if (!settings || typeof settings !== 'object') return ['Format pengaturan tidak valid'];
    if (!Array.isArray(settings.cranes)) return ['"cranes" harus berupa daftar'];

    const checkLimitKeys = (limits, name) => {
        if (limits === undefined) return;
        if (!limits || typeof limits !== 'object' || Array.isArray(limits)) return problems.push(`${name}: batas tidak valid`);
        Object.entries(limits).forEach(([k, v]) => {
            if (!AlarmRules.LIMIT_KEYS.includes(k)) problems.push(`${name}: batas "${k}" tidak dikenal`);
            else if (typeof v !== 'number' || !Number.isFinite(v)) problems.push(`${name}: ${k} harus angka`);
        });
    };

    checkLimitKeys(settings.defaults, 'Batas default');
    problems.push(...AlarmRules.validateLimits(Object.assign({}, AlarmRules.DEFAULTS, settings.defaults), 'Batas default'));

    const craneIds = new Set();
    settings.cranes.forEach((crane, i) => {
        const label = crane && crane.id ? crane.id : `crane ke-${i + 1}`;
        if (!crane || typeof crane !== 'object') return problems.push(`${label}: data tidak valid`);
        if (typeof crane.id !== 'string' || !/^[a-z0-9][a-z0-9-]{0,39}$/i.test(crane.id)) problems.push(`${label}: ID crane hanya boleh huruf, angka, dan "-"`);
        else if (craneIds.has(crane.id)) problems.push(`${label}: ID crane dipakai dua kali`);
        craneIds.add(crane.id);
        if (typeof crane.name !== 'string' || !crane.name.trim() || crane.name.length > 120) problems.push(`${label}: nama crane wajib diisi (maks 120 karakter)`);
        if (typeof crane.location !== 'string' || crane.location.length > 80) problems.push(`${label}: lokasi maks 80 karakter`);
        if (typeof crane.area !== 'string' || !/^[a-z0-9-]{1,20}$/i.test(crane.area)) problems.push(`${label}: area (bagian topik MQTT) hanya boleh huruf, angka, dan "-"`);
        if (typeof crane.installed !== 'boolean') problems.push(`${label}: status terpasang harus true/false`);
        checkLimitKeys(crane.limits, label);
        if (!Array.isArray(crane.gearboxes) || crane.gearboxes.length === 0) return problems.push(`${label}: minimal 1 gearbox`);

        const keys = new Set();
        crane.gearboxes.forEach((gb, j) => {
            const gbLabel = `${label}/${gb && gb.key ? gb.key : 'gearbox ke-' + (j + 1)}`;
            if (!gb || typeof gb !== 'object') return problems.push(`${gbLabel}: data tidak valid`);
            if (typeof gb.key !== 'string' || !/^gb\d{1,3}$/.test(gb.key)) problems.push(`${gbLabel}: key harus berbentuk gb01, gb02, ...`);
            else if (keys.has(gb.key)) problems.push(`${gbLabel}: key dipakai dua kali`);
            keys.add(gb.key);
            if (typeof gb.name !== 'string' || !gb.name.trim() || gb.name.length > 80) problems.push(`${gbLabel}: nama gearbox wajib diisi (maks 80 karakter)`);
            if (gb.sparepart !== undefined && (typeof gb.sparepart !== 'string' || gb.sparepart.length > 80)) problems.push(`${gbLabel}: kode sparepart maks 80 karakter`);
            checkLimitKeys(gb.limits, gbLabel);
            // Batas akhir (default + crane + gearbox) harus masuk akal
            problems.push(...AlarmRules.validateLimits(AlarmRules.getLimits(settings, crane.id, gb.key), gbLabel));
        });
    });
    return problems;
}

// Tulis ke file sementara lalu rename (file tidak pernah setengah jadi).
// Versi sebelumnya disimpan sebagai settings.json.bak.
function save(settings, file = SETTINGS_FILE) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (fs.existsSync(file)) fs.copyFileSync(file, `${file}.bak`);
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(settings, null, 2) + '\n');
    fs.renameSync(tmp, file);
}

// Daftar perbedaan yang mudah dibaca, untuk catatan perubahan.
// Mis. "crane-01/gb03 · batas danger: 80 → 85", "crane-02 · terpasang: tidak → ya"
function diff(before, after) {
    const changes = [];
    const fmt = v => (v === undefined || v === null || v === '' ? '(kosong)' : v === true ? 'ya' : v === false ? 'tidak' : String(v));
    const FIELD = { name: 'nama', location: 'lokasi', area: 'area', installed: 'terpasang', sparepart: 'sparepart' };
    const LIMIT = { low: 'Min', warning: 'batas atas normal', danger: 'Max', hysteresis: 'hysteresis', riseDegrees: 'kenaikan cepat (°C)', riseMinutes: 'kenaikan cepat (menit)', offlineMinutes: 'offline (menit)' };
    const limitDiff = (target, a = {}, b = {}) => {
        new Set([...Object.keys(a), ...Object.keys(b)]).forEach(k => {
            if (a[k] !== b[k]) changes.push(`${target} · ${LIMIT[k] || k}: ${fmt(a[k])} → ${fmt(b[k])}`);
        });
    };

    limitDiff('Batas default', before.defaults, after.defaults);
    const beforeCranes = new Map((before.cranes || []).map(c => [c.id, c]));
    const afterCranes = new Map((after.cranes || []).map(c => [c.id, c]));
    afterCranes.forEach((c, id) => {
        const old = beforeCranes.get(id);
        if (!old) return changes.push(`${id} · crane baru ditambahkan (${c.name})`);
        Object.keys(FIELD).forEach(f => { if (f !== 'sparepart' && old[f] !== c[f]) changes.push(`${id} · ${FIELD[f]}: ${fmt(old[f])} → ${fmt(c[f])}`); });
        limitDiff(id, old.limits, c.limits);
        const oldGbs = new Map(old.gearboxes.map(g => [g.key, g]));
        c.gearboxes.forEach(g => {
            const og = oldGbs.get(g.key);
            if (!og) return changes.push(`${id}/${g.key} · gearbox baru ditambahkan (${g.name})`);
            ['name', 'sparepart'].forEach(f => { if ((og[f] || '') !== (g[f] || '')) changes.push(`${id}/${g.key} · ${FIELD[f]}: ${fmt(og[f])} → ${fmt(g[f])}`); });
            limitDiff(`${id}/${g.key}`, og.limits, g.limits);
            oldGbs.delete(g.key);
        });
        oldGbs.forEach(g => changes.push(`${id}/${g.key} · gearbox dihapus (${g.name})`));
    });
    beforeCranes.forEach((c, id) => { if (!afterCranes.has(id)) changes.push(`${id} · crane dihapus (${c.name})`); });
    return changes;
}

module.exports = { SETTINGS_FILE, load, validate, save, diff };
