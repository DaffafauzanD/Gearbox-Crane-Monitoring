// ============================================================
// HALAMAN PENGATURAN (pengaturan.html)
// ============================================================
// Mengubah config/settings.json lewat API server.js: nama crane/motor, status
// terpasang, dan batas suhu (default, per crane, per motor). Juga menampilkan
// perangkat (ESP32) yang terdeteksi dan riwayat perubahan.
//
// Cara kerja: semua perubahan di form masuk ke "draft" (salinan pengaturan).
// Tombol Simpan mengirim draft ke server; server memvalidasi, mencatat riwayat,
// lalu mengabarkan pengaturan baru ke semua dashboard yang terbuka.

let settings = null;   // versi yang tersimpan di server
let draft = null;      // versi yang sedang diedit
let dirty = false;
let saving = false;   // sedang menyimpan: event "settings" dari server adalah hasil simpan kita sendiri
let devices = [];
let otaManifests = {}; // { [craneId]: { version, file, sizeBytes, sha256, releasedAt, uploadedBy } } - firmware ter-upload PER CRANE
let otaLog = {}; // { [craneId]: { at, by } } - siapa & kapan TERAKHIR MEMINTA update crane itu (bukan waktu selesai flash)
let otaHistory = {}; // { [craneId]: [{ at, by, fileName, version }] } - riwayat SEMUA upload firmware crane itu (terbaru dulu)
const openCranes = new Set();

const LIMIT_LABELS = {
    low: ['Min (°C)', 'Di bawah ini: alarm suhu rendah (sensor lepas / terlalu dingin)'],
    warning: ['Batas atas normal (°C)', 'Di atas ini: Warning (mendekati Max)'],
    danger: ['Max (°C)', 'Di atas ini: Danger'],
    hysteresis: ['Hysteresis (°C)', 'Alarm suhu baru selesai kalau suhu sudah kembali sejauh ini dari batasnya'],
    riseDegrees: ['Kenaikan cepat (°C)', 'Alarm kalau suhu naik sebanyak ini...'],
    riseMinutes: ['... dalam (menit)', '...dalam rentang waktu ini'],
    offlineMinutes: ['Offline setelah (menit)', 'Motor dianggap offline kalau tidak ada data selama ini']
};
const PER_GEARBOX_LIMITS = ['low', 'warning', 'danger'];
// Header singkat khusus tabel motor (kolomnya sempit) - judul lengkap tetap ada lewat title=""
const TABLE_LIMIT_SHORT = { low: 'Min', warning: 'Warning', danger: 'Max' };

// Preset cepat batas suhu berdasarkan insulation class motor, dengan asumsi sensor
// ditempel di CASING motor (bukan winding), tipe rumah TEFC/IP54 (paling umum untuk
// motor crane industrial). Ini TITIK AWAL, bukan angka final - tetap sebaiknya
// dikalibrasi ulang dari data histori suhu motor yang sebenarnya (lihat halaman
// Laporan) setelah beberapa minggu berjalan normal.
//   - Class B & F sengaja sama: motor isolasi F yang dijalankan di rise-B (praktik
//     paling umum di motor industri modern) berperilaku termal seperti Class B,
//     cuma dengan margin jauh lebih besar sebelum insulasinya benar-benar rusak.
const INSULATION_PRESETS = {
    A: { low: 15, warning: 55, danger: 75 },
    B: { low: 15, warning: 85, danger: 100 },
    F: { low: 15, warning: 85, danger: 105 },
    H: { low: 15, warning: 95, danger: 120 }
};
const INSULATION_PRESET_HINT = 'Titik awal (pastikan jenis casing motor) - cek lagi ke nameplate motor & kalibrasi dari data histori suhu di halaman Laporan sebelum dipakai final.';

// ---------- utilitas ----------
function storageGet(key, fallback) {
    try {
        const v = localStorage.getItem(key);
        return v === null ? fallback : v;
    } catch (e) {
        return fallback;
    }
}

function storageSet(key, value) {
    try { localStorage.setItem(key, value); } catch (e) { /* mode privat dsb */ }
}

function escapeHTML(value) {
    return String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

const TZ = { timeZone: 'Asia/Jakarta' };
const fmtDateTime = ms => (ms ? new Date(ms).toLocaleString('id-ID', { ...TZ, day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—');

function fmtAgo(ms) {
    if (!ms) return '—';
    const min = Math.round((Date.now() - ms) / 60000);
    if (min < 1) return 'baru saja';
    if (min < 60) return `${min} menit lalu`;
    if (min < 48 * 60) return `${Math.floor(min / 60)} jam lalu`;
    return `${Math.floor(min / 1440)} hari lalu`;
}

async function requestJson(method, url, body) {
    const res = await fetch(url, {
        method,
        headers: body ? { 'Content-Type': 'application/json' } : {},
        body: body ? JSON.stringify(body) : undefined,
        cache: 'no-store'
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
        const err = new Error(data.error || `HTTP ${res.status}`);
        err.status = res.status;
        throw err;
    }
    return data;
}

function changedBy() {
    return document.getElementById('changedBy').value.trim();
}

function showErrors(message) {
    const box = document.getElementById('settingsErrors');
    if (!message) {
        box.style.display = 'none';
        return;
    }
    box.style.display = '';
    box.innerHTML = `<strong><i class="fa-solid fa-triangle-exclamation"></i> Belum bisa disimpan:</strong><ul>${
        message.split('\n').map(m => `<li>${escapeHTML(m)}</li>`).join('')}</ul>`;
    box.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// ---------- draft ----------
function setDirty(value) {
    dirty = value;
    document.getElementById('saveBar').classList.toggle('active', dirty);
    document.body.classList.toggle('has-save-bar', dirty);
}

function resetDraft() {
    draft = JSON.parse(JSON.stringify(settings));
    setDirty(false);
    showErrors('');
    renderAll();
}

function discardChanges() {
    if (!confirm('Batalkan semua perubahan yang belum disimpan?')) return;
    resetDraft();
}

// Semua input form memakai data-field, mis:
//   "default:low", "crane:3:name", "crane:3:installed", "climit:3:danger",
//   "gb:3:1:name", "glimit:3:1:warning"
function onField(el) {
    const [kind, ...rest] = el.dataset.field.split(':');
    const number = v => (v.trim() === '' ? undefined : Number(v.replace(',', '.')));
    const setLimit = (obj, key, value) => {
        if (value === undefined) delete obj[key];
        else obj[key] = value;
    };

    if (kind === 'default') {
        const v = number(el.value);
        setLimit(draft.defaults, rest[0], v === undefined ? AlarmRules.DEFAULTS[rest[0]] : v);
    } else {
        const crane = draft.cranes[Number(rest[0])];
        if (kind === 'crane') {
            const field = rest[1];
            crane[field] = field === 'installed' ? el.checked : el.value;
        } else if (kind === 'climit') {
            crane.limits = crane.limits || {};
            setLimit(crane.limits, rest[1], number(el.value));
            if (Object.keys(crane.limits).length === 0) delete crane.limits;
        } else {
            const gb = crane.gearboxes[Number(rest[1])];
            if (kind === 'gb') gb[rest[2]] = el.value;
            if (kind === 'gbon') {   // sakelar aktif/nonaktif motor: hanya "enabled": false yang ditulis, aktif = tidak ditulis
                if (el.checked) delete gb.enabled;
                else gb.enabled = false;
                const row = document.getElementById(`gb-row-${rest[0]}-${rest[1]}`);
                if (row) row.classList.toggle('gb-row-off', !el.checked);
                el.title = el.checked ? 'Sensor aktif - klik untuk menonaktifkan' : 'Sensor nonaktif - klik untuk mengaktifkan';
            }
            if (kind === 'glimit') {
                gb.limits = gb.limits || {};
                setLimit(gb.limits, rest[2], number(el.value));
                if (Object.keys(gb.limits).length === 0) delete gb.limits;
            }
        }
    }
    setDirty(true);
    updatePlaceholders();
    if (kind === 'crane' && (rest[1] === 'name' || rest[1] === 'installed')) updateCraneSummary(Number(rest[0]));
}

// Angka "yang sedang berlaku" ditampilkan sebagai placeholder di kolom yang kosong
function updatePlaceholders() {
    document.querySelectorAll('[data-field^="climit:"], [data-field^="glimit:"]').forEach(el => {
        const [kind, ci, a, b] = el.dataset.field.split(':');
        const crane = draft.cranes[Number(ci)];
        const key = kind === 'climit' ? a : b;
        const inherited = kind === 'climit'
            ? Object.assign({}, AlarmRules.DEFAULTS, draft.defaults)[key]
            : Object.assign({}, AlarmRules.DEFAULTS, draft.defaults, crane.limits)[key];
        el.placeholder = String(inherited);
    });
    document.querySelectorAll('[data-field$=":insulationClass"]').forEach(el => {
        const [, ci] = el.dataset.field.split(':');
        el.placeholder = draft.cranes[Number(ci)].insulationClass || '-';
    });
    // Tandai gearbox yang batas akhirnya tidak masuk akal
    draft.cranes.forEach((crane, ci) => crane.gearboxes.forEach((gb, gi) => {
        const row = document.getElementById(`gb-row-${ci}-${gi}`);
        if (!row) return;
        const problems = AlarmRules.validateLimits(AlarmRules.getLimits(draft, crane.id, gb.key), gb.key);
        row.classList.toggle('row-invalid', problems.length > 0);
        row.title = problems.join('\n');
    }));
}

// ---------- render ----------
function renderAll() {
    renderDefaults();
    renderCranes();
    renderDevices();
}

function limitInput(field, value, extra = '') {
    return `<input type="number" step="0.1" data-field="${field}" value="${value ?? ''}" oninput="onField(this)" ${extra}>`;
}

function renderDefaults() {
    const defaults = Object.assign({}, AlarmRules.DEFAULTS, draft.defaults);
    document.getElementById('defaultLimits').innerHTML = AlarmRules.LIMIT_KEYS.map(key => `
        <label class="limit-field" title="${escapeHTML(LIMIT_LABELS[key][1])}">
            <span>${LIMIT_LABELS[key][0]}</span>
            ${limitInput(`default:${key}`, defaults[key])}
            <small>${escapeHTML(LIMIT_LABELS[key][1])}</small>
        </label>`).join('');
}

// ESP32 milik satu crane (ESP utama dulu), dari daftar perangkat terdeteksi
function craneDevices(crane) {
    return devices.filter(d => d.craneId === crane.id).sort((a, b) => a.node - b.node);
}

// ID perangkat yang punya slot OTA di accordion crane ini: ESP utama (selalu ada, walau belum
// pernah mengirim data) + ESP tambahan yang sudah terlihat / sudah punya firmware ter-upload
function otaDeviceIds(crane) {
    const ids = new Set([crane.id, ...craneDevices(crane).map(d => d.id)]);
    Object.keys(otaManifests).forEach(id => {
        const p = AlarmRules.parseDeviceId(id);
        if (p && p.craneId === crane.id) ids.add(id);
    });
    return [...ids].sort((a, b) => AlarmRules.parseDeviceId(a).node - AlarmRules.parseDeviceId(b).node);
}

// Baris "ESP32 crane ini": satu baris per ESP - topik, status, motor yang dikirimnya
function craneNodesHTML(crane) {
    const list = craneDevices(crane);
    if (!list.length) {
        return `Topik: <code>pabrik/${escapeHTML(crane.area)}/${escapeHTML(crane.id)}/temp</code> · <span class="text-not-installed">belum pernah mengirim data</span>`;
    }
    const multi = list.length > 1;
    return `${multi ? `<strong>${list.length} ESP32 di crane ini</strong>` : 'ESP32'}<div class="node-list">${list.map(d => {
        const conflicts = Object.entries(d.conflicts || {});
        return `<div class="node-row">
            ${multi ? `<strong>ESP ${d.node}</strong>` : ''}
            <code>pabrik/${escapeHTML(d.area || crane.area)}/${escapeHTML(d.id)}/temp</code>
            <span class="${d.online === false ? 'text-danger' : 'text-normal'}"><i class="fa-solid fa-circle"></i> ${d.online === false ? 'offline' : 'mengirim data'}</span>
            · terakhir ${fmtAgo(d.lastSeen)}
            · motor ${escapeHTML(d.gbKeys.join(', ') || '-')}
            ${d.info && d.info.fw ? ` · firmware ${escapeHTML(d.info.fw)}` : ''}
            ${conflicts.length ? `<span class="text-danger"><i class="fa-solid fa-triangle-exclamation"></i> bentrok: ${conflicts.map(([k, c]) => `${escapeHTML(k)} juga dikirim ${escapeHTML(c.with)}`).join('; ')}</span>` : ''}
        </div>`;
    }).join('')}</div>`;
}

function craneSummaryHTML(crane, no) {
    // Versi firmware yang BENAR-BENAR jalan di ESP32 (dari pesan status), bukan yang ter-upload
    const list = craneDevices(crane);
    const fws = [...new Set(list.map(d => d.info && d.info.fw).filter(Boolean))];
    const nodes = list.length > 1 ? ` · ${list.length} ESP32` : '';
    return `
        <span class="crane-no-tag">${String(no).padStart(2, '0')}</span>
        <span class="crane-summary-name">${escapeHTML(crane.name || '(tanpa nama)')}</span>
        <small>${escapeHTML(crane.id)} · ${escapeHTML(crane.location)} · ${crane.gearboxes.length} motor${nodes} · firmware ${fws.length ? fws.map(v => 'v' + escapeHTML(v)).join(' / ') : '-'}</small>
        <span class="status-badge ${crane.installed ? 'status-normal' : 'status-not-installed'}">${crane.installed ? 'terpasang' : 'belum terpasang'}</span>`;
}

function updateCraneSummary(ci) {
    const el = document.getElementById(`crane-summary-${ci}`);
    if (el) el.innerHTML = craneSummaryHTML(draft.cranes[ci], ci + 1);
}

function renderCranes() {
    const query = document.getElementById('craneSearch').value.toLowerCase().trim();
    const onlyInstalled = document.getElementById('onlyInstalled').checked;

    document.getElementById('craneList').innerHTML = draft.cranes.map((crane, ci) => {
        const match = `${crane.id} ${crane.name} ${crane.location}`.toLowerCase().includes(query);
        if (!match || (onlyInstalled && !crane.installed)) return '';
        const lim = crane.limits || {};
        const deviceInfo = craneNodesHTML(crane);

        const statTile = (cls, label, field, value) => `
            <div class="crane-stat-tile ${cls}">
                <div class="crane-stat-label">${label}</div>
                <div class="crane-stat-value">${limitInput(field, value)}<span>°C</span></div>
            </div>`;

        return `
        <details class="crane-settings" data-ci="${ci}" ${openCranes.has(crane.id) ? 'open' : ''} ontoggle="toggleCraneOpen(this)">
            <summary id="crane-summary-${ci}">${craneSummaryHTML(crane, ci + 1)}</summary>
            <div class="crane-settings-body">
                <div class="crane-grid-top">
                    <div class="crane-card">
                        <div class="crane-card-title">Info crane</div>
                        <label>Nama crane<input type="text" maxlength="120" data-field="crane:${ci}:name" value="${escapeHTML(crane.name)}" oninput="onField(this)"></label>
                        <label>Lokasi<input type="text" maxlength="80" data-field="crane:${ci}:location" value="${escapeHTML(crane.location)}" oninput="onField(this)"></label>
                        <label>Area (topik MQTT)<input type="text" maxlength="20" data-field="crane:${ci}:area" value="${escapeHTML(crane.area)}" oninput="onField(this)"></label>
                        <label class="toggle-row">
                            <span>Terpasang (tampil di dashboard &amp; dipantau alarm)</span>
                            <input type="checkbox" class="toggle-checkbox" data-field="crane:${ci}:installed" ${crane.installed ? 'checked' : ''} onchange="onField(this)">
                        </label>
                    </div>

                    <div class="crane-card">
                        <div class="crane-card-title">Batas suhu default &middot; semua motor</div>
                        <div class="crane-stat-grid">
                            ${statTile('', 'Min', `climit:${ci}:low`, lim.low)}
                            ${statTile('warn', 'Warning', `climit:${ci}:warning`, lim.warning)}
                            ${statTile('danger', 'Max', `climit:${ci}:danger`, lim.danger)}
                        </div>
                        <div class="crane-card-divider"></div>
                        <div class="crane-card-subtitle">Preset kelas isolasi motor</div>
                        <div class="preset-buttons-grid">
                            ${Object.keys(INSULATION_PRESETS).map(klass => {
                                const p = INSULATION_PRESETS[klass];
                                return `<button type="button" class="preset-btn" onclick="applyInsulationPreset(${ci}, '${klass}')" title="Class ${klass}: Warning ≤${p.warning}°C, Max ${p.danger}°C. ${INSULATION_PRESET_HINT}">${klass}</button>`;
                            }).join('')}
                        </div>
                    </div>
                </div>

                <div class="ota-crane-block" id="ota-crane-${escapeHTML(crane.id)}" data-sig="${escapeHTML(otaDeviceIds(crane).join(','))}">
                    ${otaCraneSectionHTML(crane)}
                </div>
                <div class="device-line"><i class="fa-solid fa-satellite-dish"></i> ${deviceInfo}</div>

                <div class="crane-card">
                    <div class="crane-card-title">Motor <span class="crane-card-title-count">(${crane.gearboxes.length})</span></div>
                    <div class="table-wrap">
                        <table class="report-table settings-table settings-table-fixed">
                            <colgroup>
                                <col class="col-key"><col class="col-active"><col class="col-name"><col class="col-sparepart"><col class="col-class">
                                <col class="col-num"><col class="col-num"><col class="col-num">
                                <col class="col-preset"><col class="col-del">
                            </colgroup>
                            <thead><tr>
                                <th class="col-key">Key</th><th class="col-active" title="Matikan kalau PT100 motor ini belum terpasang: tidak ada alarm, kartunya tampil &quot;nonaktif&quot;">Aktif</th><th>Nama Motor</th><th>Kode Sparepart</th><th title="Kelas isolasi motor (A/B/F/H)">Class</th>
                                ${PER_GEARBOX_LIMITS.map(k => `<th class="num limit-cell-${k}" title="${escapeHTML(LIMIT_LABELS[k][0])}">${TABLE_LIMIT_SHORT[k]}</th>`).join('')}
                                <th>Preset</th>
                                <th></th>
                            </tr></thead>
                            <tbody>${crane.gearboxes.map((gb, gi) => `
                                <tr id="gb-row-${ci}-${gi}" class="${gb.enabled === false ? 'gb-row-off' : ''}">
                                    <td class="col-key"><code>${escapeHTML(gb.key)}</code></td>
                                    <td class="col-active"><input type="checkbox" class="toggle-checkbox" data-field="gbon:${ci}:${gi}" ${gb.enabled === false ? '' : 'checked'} onchange="onField(this)" title="${gb.enabled === false ? 'Sensor nonaktif - klik untuk mengaktifkan' : 'Sensor aktif - klik untuk menonaktifkan'}"></td>
                                    <td><input type="text" maxlength="80" data-field="gb:${ci}:${gi}:name" value="${escapeHTML(gb.name)}" oninput="onField(this)"></td>
                                    <td><input type="text" maxlength="80" data-field="gb:${ci}:${gi}:sparepart" value="${escapeHTML(gb.sparepart || '')}" oninput="onField(this)"></td>
                                    <td><input type="text" maxlength="10" data-field="gb:${ci}:${gi}:insulationClass" value="${escapeHTML(gb.insulationClass || '')}" oninput="onField(this)" placeholder="-"></td>
                                    ${PER_GEARBOX_LIMITS.map(k => `<td class="num limit-cell limit-cell-${k}">${limitInput(`glimit:${ci}:${gi}:${k}`, (gb.limits || {})[k])}</td>`).join('')}
                                    <td class="preset-cell">
                                        <button type="button" class="icon-btn" title="Ikuti preset crane (hapus batas &amp; kelas khusus motor ini)" onclick="applyInsulationPresetGb(${ci}, ${gi}, '')"><i class="fa-solid fa-rotate-left"></i></button>
                                        <select class="preset-select" title="${INSULATION_PRESET_HINT}" onchange="applyInsulationPresetGb(${ci}, ${gi}, this.value); this.value='';">
                                            <option value="">Preset...</option>
                                            ${Object.keys(INSULATION_PRESETS).map(klass => {
                                                const p = INSULATION_PRESETS[klass];
                                                return `<option value="${klass}">Class ${klass} (≤${p.warning}/${p.danger}°C)</option>`;
                                            }).join('')}
                                        </select>
                                    </td>
                                    <td><button class="icon-btn" title="Hapus motor ini" onclick="removeGearbox(${ci}, ${gi})"><i class="fa-solid fa-trash"></i></button></td>
                                </tr>`).join('')}
                            </tbody>
                        </table>
                    </div>
                    <div class="crane-actions">
                        <button class="device-btn" onclick="addGearbox(${ci})"><i class="fa-solid fa-plus"></i> Tambah motor</button>
                        <button class="device-btn danger" onclick="removeCrane(${ci})"><i class="fa-solid fa-trash"></i> Hapus crane</button>
                    </div>
                </div>
            </div>
        </details>`;
    }).join('') || '<div class="report-empty">Tidak ada crane yang cocok.</div>';
    updatePlaceholders();
}

function toggleCraneOpen(el) {
    const id = draft.cranes[Number(el.dataset.ci)].id;
    if (el.open) openCranes.add(id);
    else openCranes.delete(id);
}

// ---------- OTA (update firmware ESP32 lewat WiFi, PER ESP32) ----------
// Crane dengan beberapa ESP32 punya beberapa slot OTA: tiap ESP32 dikompilasi dengan config.h
// sendiri (NODE_ID & motornya beda), jadi file .bin-nya juga sendiri-sendiri. Semua state di
// bawah di-key dengan ID PERANGKAT ("crane-01", "crane-01_2", ...).
const otaSelectedFiles = new Map();  // id perangkat -> File yang sudah dipilih, belum di-publish
const otaFileVersions = new Map();   // id perangkat -> versi yang ditanam di dalam file .bin yang dipilih (kalau terbaca)
const otaPicValues = new Map();      // id perangkat -> nama PIC/operator yang sedang diketik (biar tidak hilang saat re-render)

// "NAMA CRANE" / "NAMA CRANE · ESP 2"
function deviceTitle(devId) {
    const p = AlarmRules.parseDeviceId(devId);
    const c = p && (draft && draft.cranes || []).find(x => x.id === p.craneId);
    const name = c ? c.name : (p ? p.craneId : devId);
    return p && p.node > 1 ? `${name} · ESP ${p.node}` : name;
}

// Isi blok OTA satu crane: satu bagian per ESP32 (judul "ESP n" cuma kalau lebih dari satu)
function otaCraneSectionHTML(crane) {
    const ids = otaDeviceIds(crane);
    return ids.map(id => {
        const p = AlarmRules.parseDeviceId(id);
        const d = devices.find(x => x.id === id);
        const title = ids.length > 1
            ? `<div class="ota-node-title"><i class="fa-solid fa-microchip"></i> ESP ${p.node} <code>${escapeHTML(id)}</code>${d && d.gbKeys.length ? ` <small>motor ${escapeHTML(d.gbKeys.join(', '))}</small>` : ''}</div>`
            : '';
        return title + otaBlockHTML(id) + otaUploaderHTML(id) + otaHistoryHTML(id);
    }).join('');
}

async function loadOtaManifests() {
    try {
        otaManifests = await requestJson('GET', 'api/ota/manifests');
    } catch (e) {
        otaManifests = {}; // server belum jalan dsb - wajar, jangan ganggu halaman lain
    }
    try {
        const res = await fetch('firmware-ota/trigger-log.json', { cache: 'no-store' });
        otaLog = res.ok ? await res.json() : {};
    } catch (e) {
        otaLog = {};
    }
    try {
        otaHistory = await requestJson('GET', 'api/ota/history');
    } catch (e) {
        otaHistory = {};
    }
    const anyPublished = Object.keys(otaManifests).length > 0;
    document.getElementById('otaTriggerToolbar').style.display = anyPublished ? '' : 'none';
}

// Delegasi 1x di container #craneList - supaya drag & drop tetap jalan walau
// accordion-nya di-render ulang berkali-kali (search, tambah gearbox, dst),
// tanpa perlu pasang ulang event listener tiap kali.
function setupOtaDropzones() {
    const container = document.getElementById('craneList');
    const zoneOf = el => el.closest('.ota-dropzone--mini');
    const devOf = zone => zone ? zone.dataset.dev : null;

    ['dragover', 'dragenter'].forEach(evt => container.addEventListener(evt, e => {
        const zone = zoneOf(e.target);
        if (!zone) return;
        e.preventDefault();
        zone.classList.add('drag-over');
    }));
    ['dragleave', 'dragend'].forEach(evt => container.addEventListener(evt, e => {
        const zone = zoneOf(e.target);
        if (zone) zone.classList.remove('drag-over');
    }));
    container.addEventListener('drop', e => {
        const zone = zoneOf(e.target);
        if (!zone) return;
        e.preventDefault();
        zone.classList.remove('drag-over');
        if (e.dataTransfer.files[0]) pickOtaFileFor(devOf(zone), e.dataTransfer.files[0]);
    });
    container.addEventListener('change', e => {
        if (!e.target.classList.contains('ota-file-input')) return;
        if (e.target.files[0]) pickOtaFileFor(e.target.dataset.dev, e.target.files[0]);
    });
}

function pickOtaFileFor(dev, file) {
    if (!file.name.toLowerCase().endsWith('.bin')) {
        alert('File harus .bin (di Arduino IDE: Sketch -> Export Compiled Binary).');
        return;
    }
    otaSelectedFiles.set(dev, file);
    otaFileVersions.delete(dev);
    // Baca versi yang ditanam di dalam .bin (penanda GBXFWVER=x.y.z) - sama dengan yang nanti dibaca server
    file.arrayBuffer().then(ab => {
        const m = new TextDecoder('latin1').decode(ab).match(/GBXFWVER=(\d+\.\d+\.\d+)/);
        if (otaSelectedFiles.get(dev) !== file) return; // file sudah diganti/dibatalkan
        if (m) otaFileVersions.set(dev, m[1]);
        const preview = document.getElementById(`ota-version-preview-${dev}`);
        if (preview) preview.textContent = otaPreviewText(dev);
    }).catch(() => { /* gagal baca file - biarkan pratinjau otomatis */ });
    const zone = document.getElementById(`ota-dropzone-${dev}`);
    const row = document.getElementById(`ota-upload-row-${dev}`);
    if (zone) zone.style.display = 'none';
    if (row) {
        row.style.display = '';
        document.getElementById(`ota-file-name-${dev}`).textContent = `${file.name} (${(file.size / 1024).toFixed(1)} KB)`;
        const picInput = document.getElementById(`ota-pic-${dev}`);
        if (picInput) picInput.focus();
    }
}

// Teks pratinjau versi: dari penanda di dalam .bin kalau ada, kalau tidak perkiraan otomatis
function otaPreviewText(dev) {
    const v = otaFileVersions.get(dev);
    return v ? `akan jadi v${v} (dibaca dari firmware)` : `akan jadi v${nextFirmwareVersionPreview(dev)} (otomatis)`;
}

function cancelOtaFileFor(dev) {
    otaFileVersions.delete(dev);
    otaSelectedFiles.delete(dev);
    otaPicValues.delete(dev);
    const zone = document.getElementById(`ota-dropzone-${dev}`);
    const row = document.getElementById(`ota-upload-row-${dev}`);
    const input = document.getElementById(`ota-file-${dev}`);
    if (input) input.value = '';
    if (row) row.style.display = 'none';
    if (zone) zone.style.display = '';
}

// Versi tidak lagi diisi manual - ditebak di sini cuma buat DITAMPILKAN sebelum upload
// (mis. "Versi berikutnya: v1.1.2"). Angka yang sebenarnya dipakai tetap dihitung ulang
// di server saat upload (lihat nextFirmwareVersion di server.js) - ini cuma preview.
function nextFirmwareVersionPreview(craneId) {
    const m = otaManifests[craneId];
    if (!m || !/^\d+\.\d+\.\d+$/.test(m.version)) return '1.1.1';
    const parts = m.version.split('.').map(Number);
    parts[2] += 1;
    return parts.join('.');
}

// Dipanggil tiap kali field Nama PIC diketik: menyimpan nilainya (biar tidak hilang
// kalau accordion di-render ulang) dan menyalakan/mematikan tombol Publish. Validasi
// FINAL tetap dicek lagi di server saat upload, ini cuma supaya orang tidak bisa klik
// Publish tanpa isi nama dulu.
function checkOtaPublishReady(dev) {
    const pic = document.getElementById(`ota-pic-${dev}`);
    const btn = document.getElementById(`ota-publish-${dev}`);
    if (!pic || !btn) return;
    otaPicValues.set(dev, pic.value);
    const ready = pic.value.trim().length > 0;
    btn.disabled = !ready;
    btn.title = ready ? 'Publish firmware ini' : 'Isi nama PIC/operator dulu';
}

async function uploadOtaFirmwareFor(dev) {
    const file = otaSelectedFiles.get(dev);
    const pic = (document.getElementById(`ota-pic-${dev}`) || {}).value?.trim();
    if (!file || !AlarmRules.parseDeviceId(dev)) return;
    if (!pic) {
        alert('Isi nama PIC/operator yang meng-upload firmware ini.');
        return;
    }
    const versionPreview = otaFileVersions.get(dev) || nextFirmwareVersionPreview(dev);
    const node = AlarmRules.parseDeviceId(dev).node;
    if (!confirm(`Publish "${file.name}" sebagai firmware v${versionPreview} KHUSUS "${deviceTitle(dev)}" (${dev})?\n\nDiupload oleh: ${pic}\n\n${node > 1 ? 'Pastikan .bin ini dikompilasi dengan NODE_ID ' + node + ' di config.h. ' : ''}Crane / ESP32 lain tidak ikut berubah. Ini belum mengirim ke ESP32 manapun - baru menyiapkan filenya di server.`)) return;
    try {
        const res = await fetch(`api/ota/upload?craneId=${encodeURIComponent(dev)}&uploadedBy=${encodeURIComponent(pic)}&fileName=${encodeURIComponent(file.name)}`, {
            method: 'POST',
            body: file
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
        otaSelectedFiles.delete(dev);
        otaFileVersions.delete(dev);
        otaPicValues.delete(dev);
storageSet('operatorName', pic); // ingat nama PIC terakhir supaya form lain (mis. Ack alarm) ikut terisi
        cancelOtaFileFor(dev); // balikin tampilan dropzone (sembunyikan upload-row, hapus input file)
        await loadOtaManifests();
        refreshOtaBlocks();
        alert(`Firmware v${data.manifest.version} untuk "${dev}" siap. Klik "Update" di accordion crane ini untuk mengirimkannya sekarang.`);
    } catch (e) {
        alert(`Gagal upload: ${e.message}`);
    }
}

// Bagian dropzone + upload-row untuk 1 crane (dipasang di accordion-nya).
// Tombol Publish sengaja disabled sampai Nama PIC dan Versi terisi valid.
function otaUploaderHTML(devId) {
    const dev = escapeHTML(devId); // ID perangkat hanya huruf/angka/-/_ - aman jadi id elemen & argumen
    const staged = otaSelectedFiles.get(devId);
    const picValue = otaPicValues.has(devId) ? otaPicValues.get(devId) : storageGet('operatorName', '');
    const ready = picValue.trim().length > 0;

    return `
        <label class="ota-dropzone ota-dropzone--mini" id="ota-dropzone-${dev}" data-dev="${dev}" for="ota-file-${dev}" style="display: ${staged ? 'none' : ''};" title="Tarik & lepas file .bin ke sini, atau klik untuk pilih file">
            <i class="fa-solid fa-cloud-arrow-up"></i>
            <span>Upload firmware <code>.bin</code></span>
        </label>
        <input type="file" class="ota-file-input" id="ota-file-${dev}" data-dev="${dev}" accept=".bin" hidden>
        <div class="ota-upload-row" id="ota-upload-row-${dev}" style="display: ${staged ? '' : 'none'};">
            <span id="ota-file-name-${dev}">${staged ? escapeHTML(staged.name) + ` (${(staged.size / 1024).toFixed(1)} KB)` : ''}</span>
            <span class="ota-version-preview" id="ota-version-preview-${dev}" title="Versi dibuat otomatis, naik 1 tiap upload - tidak perlu diisi manual">${escapeHTML(otaPreviewText(devId))}</span>
            <input type="text" class="ota-pic-input" id="ota-pic-${dev}" placeholder="Nama PIC/operator (wajib)" maxlength="40" value="${escapeHTML(picValue)}" oninput="checkOtaPublishReady('${dev}')">
            <button type="button" class="device-btn primary" id="ota-publish-${dev}" onclick="uploadOtaFirmwareFor('${dev}')" ${ready ? '' : 'disabled'} title="${ready ? 'Publish firmware ini' : 'Isi nama PIC/operator dulu'}"><i class="fa-solid fa-upload"></i> Publish</button>
            <button type="button" class="ota-cancel-btn" title="Batalkan, hapus file yang dipilih" onclick="cancelOtaFileFor('${dev}')"><i class="fa-solid fa-xmark"></i></button>
        </div>`;
}

// Baris "Firmware terpasang: ... · terakhir update ... · [Update] [Hapus]" untuk 1 crane
// Tombol Serial Monitor jarak jauh (espmon.js): melihat apa yang dicetak ESP32 crane ini langsung dari browser
function espMonitorBtn(craneId) {
    return `<button type="button" class="esp-mon-btn" data-id="${escapeHTML(craneId)}" data-name="${escapeHTML(deviceTitle(craneId))}" title="Lihat Serial Monitor ESP32 ini langsung dari dashboard" onclick="openEspMonitor(this.dataset.id, this.dataset.name)"><i class="fa-solid fa-terminal"></i> Serial Monitor</button>`;
}

// craneId = ID perangkat ("crane-01" / "crane-01_2")
function otaBlockHTML(craneId) {
    const manifest = otaManifests[craneId];
    if (!manifest) {
        return `<div class="ota-status-row" id="ota-block-${escapeHTML(craneId)}"><span class="ota-status-text"><i class="fa-solid fa-microchip"></i> Belum ada firmware yang di-upload untuk ESP32 ini</span> ${espMonitorBtn(craneId)}</div>`;
    }

    const device = devices.find(d => d.id === craneId);
    const currentFw = (device && device.info || {}).fw;
    const upToDate = currentFw && currentFw === manifest.version;
    const ota = device && device.ota;
    const otaBusy = !!ota && (ota.state === 'requested' || ota.state === 'downloading');

    const label = upToDate ? `Reflash v${escapeHTML(manifest.version)}` : `Update ke v${escapeHTML(manifest.version)}`;
    const cls = upToDate ? 'device-btn' : 'device-btn primary';
    const updateBtn = `<button class="${cls}" ${otaBusy ? 'disabled' : ''} data-id="${escapeHTML(craneId)}" title="${otaBusy ? 'Update sedang berjalan' : upToDate ? 'Sudah versi terbaru - tombol ini pasang ulang firmware yang sama' : 'Unduh & pasang firmware terbaru, lalu ESP32 restart sendiri'}" onclick="triggerOta(this.dataset.id)"><i class="fa-solid fa-cloud-arrow-up"></i> ${label}</button>`;

    // Opsi B: selama ESP32 belum konfirmasi menjalankan versi ini (upToDate === false),
    // firmware yang di-upload masih boleh dibatalkan/dihapus - misalnya salah upload
    // atau berubah pikiran sebelum sempat dipasang ke ESP32.
    const removeBtn = !upToDate
        ? `<button class="device-btn danger" data-id="${escapeHTML(craneId)}" title="Hapus firmware yang di-upload ini (belum terpasang di ESP32)" onclick="removeOtaFirmware(this.dataset.id)"><i class="fa-solid fa-trash"></i> Hapus</button>`
        : '';

    const fwLabel = currentFw ? `v${escapeHTML(currentFw)}` : 'tidak diketahui';
    const publishedAtMs = new Date(manifest.releasedAt).getTime();
    const publishedFull = fmtDateTime(publishedAtMs); // timestamp lengkap (tanggal + jam WIB) saat Publish diklik
    const publishedAgo = fmtAgo(publishedAtMs);
    const uploadedByLabel = manifest.uploadedBy
        ? `oleh <strong>${escapeHTML(manifest.uploadedBy)}</strong>`
        : '<span class="text-not-installed">tanpa nama PIC (upload lama)</span>';
    const last = otaLog[craneId];
    const lastLabel = last
        ? `Diminta update ${fmtAgo(last.at)}${last.by ? ` oleh ${escapeHTML(last.by)}` : ''}`
        : 'Belum pernah diminta update dari dashboard ini';

    return `
    <div class="ota-block${upToDate ? ' ota-block--uptodate' : ''}" id="ota-block-${escapeHTML(craneId)}">
        <div class="ota-block-info">
            <div class="ota-block-versions">
                <span title="Firmware yang benar-benar berjalan di ESP32 sekarang"><i class="fa-solid fa-microchip"></i> Terpasang <strong>${fwLabel}</strong></span>
                <i class="fa-solid fa-arrow-right-long ota-block-arrow"></i>
                <span>Ter-publish <strong>v${escapeHTML(manifest.version)}</strong></span>
                ${upToDate ? '<span class="status-badge status-normal">sudah terbaru</span>' : ''}
            </div>
            <div class="ota-block-meta">Di-upload ${publishedFull} WIB (${publishedAgo}) ${uploadedByLabel}</div>
            <div class="ota-block-meta">${lastLabel}</div>
            ${otaProgressHTML(ota)}
        </div>
        <div class="ota-block-actions">
            ${espMonitorBtn(craneId)}
            ${updateBtn}
            ${removeBtn}
        </div>
    </div>`;
}

// Indikator hasil update terakhir (dari server: requested -> downloading -> success/failed/timeout)
function otaProgressHTML(ota) {
    if (!ota) return '';
    const v = ota.version ? ` v${escapeHTML(ota.version)}` : '';
    const when = ota.finishedAt ? fmtAgo(ota.finishedAt) : fmtAgo(ota.at);
    const by = ota.by ? ` · diminta ${escapeHTML(ota.by)}` : '';
    const map = {
        requested:   ['ota-progress--busy', 'fa-solid fa-spinner fa-spin', `Perintah update${v} terkirim, menunggu ESP32 mulai mengunduh...`],
        downloading: ['ota-progress--busy', 'fa-solid fa-spinner fa-spin', `ESP32 sedang mengunduh & memasang${v} - jangan cabut power`],
        success:     ota.fwNow && ota.version && ota.fwNow !== ota.version
            ? ['ota-progress--warn', 'fa-solid fa-circle-check', `Update BERHASIL - ESP32 restart dengan firmware baru yang melapor v${escapeHTML(ota.fwNow)}, tapi nomor di dashboard v${escapeHTML(ota.version)}. Samakan FW_VERSION di .ino dengan nomor di pratinjau sebelum export .bin (${when})`]
            : ['ota-progress--ok', 'fa-solid fa-circle-check', `Update${v} BERHASIL - ESP32 sudah restart dengan firmware baru (${when}${by})`],
        failed:      ['ota-progress--fail', 'fa-solid fa-circle-xmark', `Update${v} GAGAL: ${escapeHTML(ota.error || 'tidak diketahui')} (${when}). ESP32 tetap pakai firmware lama.`],
        timeout:     ['ota-progress--warn', 'fa-solid fa-triangle-exclamation', `Update${v} belum terkonfirmasi - tidak ada kabar dari ESP32 selama 3 menit (${when}). Cek apakah alat online & lihat Serial Monitor.`]
    };
    const m = map[ota.state];
    if (!m) return '';
    return `<div class="ota-progress ${m[0]}"><i class="${m[1]}"></i> ${m[2]}</div>`;
}

// Update baris firmware di SEMUA accordion crane TANPA render ulang seluruh
// daftar - supaya kalau ada orang sedang mengetik di field lain, tidak
// kepotong/kehilangan fokus. Dipanggil tiap ada data devices baru masuk
// (bisa sering - status ESP32 masuk tiap ±60 detik per crane).
function refreshOtaBlocks() {
    draft.cranes.forEach((crane, ci) => {
        updateCraneSummary(ci); // versi firmware di baris ringkasan accordion ikut diperbarui
        const section = document.getElementById(`ota-crane-${crane.id}`);
        if (!section) return;
        // Baris daftar ESP32 (status, motor, bentrok) di bawah blok OTA
        const nodes = section.nextElementSibling;
        if (nodes && nodes.classList.contains('device-line')) nodes.innerHTML = `<i class="fa-solid fa-satellite-dish"></i> ${craneNodesHTML(crane)}`;
        // ESP32 baru muncul / hilang di crane ini -> susun ulang semua slot OTA-nya (file & nama PIC
        // yang sedang diisi tetap ada, disimpan di otaSelectedFiles/otaPicValues)
        const sig = otaDeviceIds(crane).join(',');
        if (section.dataset.sig !== sig) {
            section.dataset.sig = sig;
            section.innerHTML = otaCraneSectionHTML(crane);
            return;
        }
        otaDeviceIds(crane).forEach(id => {
            const block = document.getElementById(`ota-block-${id}`);
            if (block) block.outerHTML = otaBlockHTML(id);
            const history = document.getElementById(`ota-history-${id}`);
            if (history) history.outerHTML = otaHistoryHTML(id);
            // Pratinjau "akan jadi vX.Y.Z" juga harus ikut - kalau tidak, teksnya jadi basi
            // (mis. masih bilang v1.1.2 padahal firmware v1.1.1 baru saja dihapus dan
            // seharusnya kembali ke v1.1.1). Cuma update teksnya, bukan outerHTML, supaya
            // tidak mereset file/nama PIC yang mungkin sedang diisi di baris upload ini.
            const preview = document.getElementById(`ota-version-preview-${id}`);
            if (preview) preview.textContent = otaPreviewText(id);
        });
    });
}

// Riwayat SEMUA upload firmware untuk 1 crane (PIC, waktu, nama file) - beda dari
// otaBlockHTML yang cuma menunjukkan firmware yang SEKARANG ter-publish. Dilipat
// (collapsed) secara default supaya tidak bikin tiap accordion jadi panjang -
// baru diisi kalau memang ada riwayatnya.
function otaHistoryHTML(craneId) {
    const list = otaHistory[craneId] || [];
    if (!list.length) return `<div id="ota-history-${escapeHTML(craneId)}"></div>`;
    return `
    <details class="ota-history" id="ota-history-${escapeHTML(craneId)}">
        <summary>Riwayat upload firmware (${list.length})</summary>
        <div class="ota-history-list">
            ${list.map(h => `
                <div class="ota-history-row">
                    <span class="ota-history-version">v${escapeHTML(h.version)}</span>
                    <span class="ota-history-file" title="${escapeHTML(h.fileName)}"><i class="fa-solid fa-file-code"></i> ${escapeHTML(h.fileName)}</span>
                    <span class="ota-history-by"><i class="fa-solid fa-user"></i> ${escapeHTML(h.by)}</span>
                    <span class="ota-history-at">${fmtDateTime(h.at)} WIB · ${fmtAgo(h.at)}</span>
                </div>`).join('')}
        </div>
    </details>`;
}

async function triggerOta(craneId) {
    const manifest = otaManifests[craneId];
    const currentFw = (devices.find(d => d.id === craneId) || {}).info?.fw;
    const msg = currentFw && manifest && currentFw === manifest.version
        ? `Firmware "${craneId}" sudah v${manifest.version}. Pasang ulang versi yang sama & restart sekarang?`
        : `Update firmware "${craneId}" ke v${manifest ? manifest.version : '?'} sekarang?\n\nESP32 akan mengunduh lewat WiFi lalu restart sendiri - suhu tidak terpantau selama proses ini berlangsung (biasanya di bawah 1 menit).`;
    if (!confirm(msg)) return;
    try {
        await requestJson('POST', 'api/ota/trigger', { craneId, by: changedBy() || storageGet('operatorName', '') });
        await loadOtaManifests();
        refreshOtaBlocks();
        alert(`Perintah update terkirim ke "${craneId}". Cek Serial Monitor / status online-nya beberapa saat lagi untuk pastikan berhasil.`);
    } catch (e) {
        alert(`Gagal mengirim perintah update: ${e.message}`);
    }
}

async function triggerOtaAll() {
    // Dihitung per ESP32: crane dengan 2 ESP32 yang sama-sama punya firmware = 2 sasaran
    const targetCount = draft.cranes.filter(c => c.installed).flatMap(c => otaDeviceIds(c).filter(id => otaManifests[id])).length;
    if (targetCount === 0) {
        alert('Belum ada crane yang punya firmware ter-upload. Upload dulu lewat accordion crane-nya masing-masing.');
        return;
    }
    if (!confirm(`Update ${targetCount} ESP32 yang sudah punya firmware ter-upload sekarang?\n\nMasing-masing ESP32 pakai firmware yang sudah di-publish untuk dirinya sendiri. Semua ESP32 akan restart sendiri setelah update - suhu tidak terpantau selama proses ini berlangsung (biasanya di bawah 1 menit per ESP32).`)) return;
    try {
        const result = await requestJson('POST', 'api/ota/trigger', { all: true, by: changedBy() || storageGet('operatorName', '') });
        await loadOtaManifests();
        refreshOtaBlocks();
        alert(`Perintah update terkirim ke ${result.triggered.length} ESP32.`);
    } catch (e) {
        alert(`Gagal mengirim perintah update: ${e.message}`);
    }
}

// Batalkan firmware yang sudah di-upload tapi belum terpasang di ESP32 (Opsi B):
// hapus file .bin + manifest.json di server, dan hapus riwayat "diminta update"-nya.
// Server tetap menolak (409) kalau ternyata firmware ini sudah terpasang di ESP32,
// jadi aman walau status di layar sempat basi (mis. baru saja selesai update).
async function removeOtaFirmware(craneId) {
    const manifest = otaManifests[craneId];
    if (!manifest) return;
    if (!confirm(`Hapus firmware v${manifest.version} yang di-upload untuk "${craneId}"?\n\nFile firmware ini akan dihapus PERMANEN dari server, beserta riwayat permintaan update-nya. Ini TIDAK memengaruhi firmware yang sedang berjalan di ESP32 sekarang.`)) return;
    try {
        await requestJson('POST', 'api/ota/remove', { craneId, by: changedBy() || storageGet('operatorName', '') });
        await loadOtaManifests();
        refreshOtaBlocks();
    } catch (e) {
        alert(`Gagal menghapus firmware: ${e.message}`);
    }
}

function renderDevices() {
    const table = document.getElementById('deviceTable');
    const head = '<thead><tr><th>ID perangkat</th><th>Status di sistem</th><th>Koneksi</th><th>Terakhir kirim data</th><th>Motor</th><th>Firmware</th><th>IP</th><th class="num">Sinyal WiFi</th><th></th></tr></thead>';
    if (devices.length === 0) {
        table.innerHTML = head + '<tbody><tr><td colspan="9" class="report-empty">Belum ada perangkat yang mengirim data sejak fitur ini aktif.</td></tr></tbody>';
        return;
    }
    table.innerHTML = head + `<tbody>${devices.map(d => {
        const crane = (settings.cranes || []).find(c => c.id === d.craneId);
        let state, actions = '';
        const id = escapeHTML(d.id); // ID perangkat: "crane-01" atau "crane-01_2" (ESP tambahan)
        if (d.installed) {
            state = '<span class="status-badge status-normal">aktif</span>';
            if (d.unknownGearboxes.length) {
                state += ` <small class="text-warning">+ motor belum terdaftar: ${escapeHTML(d.unknownGearboxes.join(', '))}</small>`;
                actions = `<button class="device-btn primary" data-id="${id}" onclick="activateDevice(this.dataset.id)">Tambahkan motor</button>`;
            }
        } else if (d.ignoredAt) {
            state = `<span class="status-badge status-not-installed">diabaikan</span> <small>${escapeHTML(d.ignoredBy || '')}</small>`;
            actions = `<button class="device-btn" data-id="${id}" onclick="activateDevice(this.dataset.id)">Aktifkan</button>`;
        } else {
            state = `<span class="status-badge status-warning">${crane ? 'belum diaktifkan' : 'tidak dikenal'}</span>`;
            actions = `<button class="device-btn primary" data-id="${id}" onclick="activateDevice(this.dataset.id)"><i class="fa-solid fa-power-off"></i> Aktifkan</button>
                       <button class="device-btn" data-id="${id}" onclick="ignoreDevice(this.dataset.id)">Abaikan</button>`;
        }
        actions += ` <button class="device-btn danger" data-id="${id}" title="Hapus dari daftar perangkat terdeteksi (data crane & motor tidak ikut terhapus)" onclick="hapusDevice(this.dataset.id)"><i class="fa-solid fa-trash"></i></button>`;
        const conn = d.online === null ? '<small class="text-not-installed">firmware lama</small>'
            : d.online ? '<span class="text-normal"><i class="fa-solid fa-circle"></i> online</span>'
            : '<span class="text-danger"><i class="fa-solid fa-circle"></i> offline</span>';
        const info = d.info || {};
        const rssi = typeof info.rssi === 'number' ? `${info.rssi} dBm` : '—';
        return `<tr>
            <td><strong>${id}</strong>${d.nodeCount > 1 || d.node > 1 ? ` <span class="status-badge status-normal" title="ESP32 ke-${d.node} di crane ${escapeHTML(d.craneId)}">ESP ${d.node}</span>` : ''}<br><small>${crane ? escapeHTML(crane.name) : 'area ' + escapeHTML(d.area)}</small></td>
            <td>${state}</td>
            <td>${conn}</td>
            <td>${fmtAgo(d.lastSeen)}<br><small>${fmtDateTime(d.lastSeen)}</small></td>
            <td>${escapeHTML(d.gbKeys.join(', ') || '—')}${Object.keys(d.conflicts || {}).length ? `<br><small class="text-danger" title="Key motor yang sama dikirim ESP32 lain di crane ini"><i class="fa-solid fa-triangle-exclamation"></i> bentrok: ${escapeHTML(Object.entries(d.conflicts).map(([k, c]) => k + ' dgn ' + c.with).join(', '))}</small>` : ''}</td>
            <td>${escapeHTML(info.fw || '—')}</td>
            <td>${escapeHTML(info.ip || '—')}</td>
            <td class="num">${rssi}</td>
            <td>${actions}</td>
        </tr>`;
    }).join('')}</tbody>`;
}

// Tombol hapus riwayat tampil untuk master & maintenance. Ini soal tampilan saja - server
// menolak akun lain (403) juga. Role diambil sekali dari /api/me lalu diingat.
let meRole = null;
async function canDeleteAudit() {
    if (meRole === null) {
        try { meRole = (await requestJson('GET', 'api/me')).role; } catch (e) { return false; }
    }
    return meRole === 'master' || meRole === 'maintenance';
}

async function renderAudit() {
    let rows;
    try {
        rows = await requestJson('GET', 'api/settings/audit');
    } catch (e) {
        document.getElementById('auditList').innerHTML = `<div class="report-empty">Gagal memuat riwayat: ${escapeHTML(e.message)}</div>`;
        return;
    }
    const canDelete = await canDeleteAudit();
    document.getElementById('auditClearBtn').style.display = canDelete && rows.length ? '' : 'none';
    document.getElementById('auditList').innerHTML = rows.length === 0
        ? '<div class="report-empty">Belum ada perubahan.</div>'
        : rows.map(r => `
            <div class="audit-item">
                <div class="audit-head"><strong>${escapeHTML(r.action)}</strong> · ${fmtDateTime(r.at)} · ${r.by ? escapeHTML(r.by) : '<span class="text-not-installed">tanpa nama</span>'}${canDelete ? ` <button class="device-btn danger audit-del" data-id="${r.id}" title="Hapus catatan ini" onclick="deleteAuditEntry(Number(this.dataset.id))"><i class="fa-solid fa-trash"></i></button>` : ''}</div>
                <ul>${r.changes.slice(0, 30).map(c => `<li>${escapeHTML(c)}</li>`).join('')}${r.changes.length > 30 ? `<li>... dan ${r.changes.length - 30} perubahan lain</li>` : ''}</ul>
            </div>`).join('');
}

// Hapus riwayat perubahan (khusus master & maintenance). Berlaku untuk semua akun;
// halaman yang terbuka di layar lain diperbarui server lewat event "audit".
async function deleteAuditEntry(id) {
    if (!confirm('Hapus catatan perubahan ini?\n\nPermanen dan berlaku untuk semua orang yang melihat halaman ini.')) return;
    try {
        await requestJson('POST', 'api/settings/audit/delete', { id });
    } catch (e) {
        alert(`Gagal menghapus: ${e.message}`);
    }
    renderAudit();
}

async function clearAudit() {
    if (!confirm('Hapus SEMUA riwayat perubahan?\n\nPermanen dan berlaku untuk semua orang yang melihat halaman ini. Pengaturan crane & batas suhu sendiri TIDAK ikut terhapus.')) return;
    try {
        await requestJson('POST', 'api/settings/audit/delete', { all: true });
    } catch (e) {
        alert(`Gagal menghapus: ${e.message}`);
    }
    renderAudit();
}

// ---------- ubah daftar ----------
function applyInsulationPreset(ci, klass) {
    const preset = INSULATION_PRESETS[klass];
    if (!preset) return;
    const crane = draft.cranes[ci];
    crane.limits = crane.limits || {};
    PER_GEARBOX_LIMITS.forEach(k => { crane.limits[k] = preset[k]; });
    crane.insulationClass = klass;
    setDirty(true);
    renderCranes();
}

function applyInsulationPresetGb(ci, gi, klass) {
    const gb = draft.cranes[ci].gearboxes[gi];
    if (!klass) {
        // "Ikuti preset crane" - hapus override per-gearbox (batas & kelas isolasi),
        // jadi gearbox ini kembali ikut batas & kelas default crane-nya (lihat getLimits
        // di alarm_rules.js: kolom kosong = ikut crane, bukan default global).
        gb.limits = {};
        gb.insulationClass = '';
        setDirty(true);
        renderCranes();
        return;
    }
    const preset = INSULATION_PRESETS[klass];
    if (!preset) return;
    gb.limits = gb.limits || {};
    PER_GEARBOX_LIMITS.forEach(k => { gb.limits[k] = preset[k]; });
    gb.insulationClass = klass;
    setDirty(true);
    renderCranes();
}

function addGearbox(ci) {
    const crane = draft.cranes[ci];
    // Ambil digit di belakang key (independen dari panjang prefix hurufnya, mis. "m1" atau "gb01")
    const used = crane.gearboxes.map(g => parseInt(g.key.replace(/\D/g, ''), 10) || 0);
    const next = Math.max(0, ...used) + 1;
    const key = `m${next}`;
    crane.gearboxes.push({ key, name: `Motor ${next}`, sparepart: '' });
    openCranes.add(crane.id);
    setDirty(true);
    renderCranes();
}

function removeGearbox(ci, gi) {
    const crane = draft.cranes[ci];
    const gb = crane.gearboxes[gi];
    if (!confirm(`Hapus ${gb.key} (${gb.name}) dari ${crane.name}?\nData lamanya tetap tersimpan, tapi motor ini tidak lagi tampil & dipantau alarm.`)) return;
    crane.gearboxes.splice(gi, 1);
    setDirty(true);
    renderCranes();
}

function removeCrane(ci) {
    const crane = draft.cranes[ci];
    if (!confirm(`Hapus crane ${crane.name} (${crane.id}) dari daftar?\nData lamanya tetap tersimpan. Kalau hanya ingin berhenti memantau sementara, hilangkan centang "Terpasang" saja.`)) return;
    draft.cranes.splice(ci, 1);
    setDirty(true);
    renderCranes();
}

function addCrane() {
    const id = document.getElementById('newCraneId').value.trim();
    const area = document.getElementById('newCraneArea').value.trim().toLowerCase();
    const name = document.getElementById('newCraneName').value.trim();
    if (!id || !area || !name) return alert('Isi ID crane, area, dan nama.');
    if (draft.cranes.some(c => c.id === id)) return alert(`ID ${id} sudah ada.`);
    draft.cranes.push({
        id, name, area, location: `Plant ${area.toUpperCase()}`, installed: false,
        gearboxes: [1, 2, 3, 4, 5].map(n => ({ key: `m${n}`, name: `Motor ${n}`, sparepart: '' }))
    });
    ['newCraneId', 'newCraneArea', 'newCraneName'].forEach(i => { document.getElementById(i).value = ''; });
    openCranes.add(id);
    setDirty(true);
    renderCranes();
}

// ---------- simpan ----------
async function saveSettings() {
    const by = changedBy();
    storageSet('operatorName', by);
    const btn = document.getElementById('saveBtn');
    btn.disabled = true;
    saving = true;
    try {
        const result = await requestJson('PUT', 'api/settings', { settings: draft, by });
        showErrors('');
        // Server mengabarkan pengaturan baru lewat event "settings" (lihat connectStream)
        settings = JSON.parse(JSON.stringify(draft));
        settings.revision = result.revision;
        resetDraft();
        document.getElementById('saveBarText').innerHTML = '<i class="fa-solid fa-pen"></i> Ada perubahan yang belum disimpan';
        renderAudit();
    } catch (e) {
        showErrors(e.message); // termasuk 409: diubah dari tempat lain sejak halaman dibuka
    } finally {
        saving = false;
        btn.disabled = false;
    }
}

async function activateDevice(craneId) {
    if (dirty && !confirm('Ada perubahan yang belum disimpan di halaman ini. Mengaktifkan perangkat akan memuat ulang pengaturan dan perubahan itu hilang. Lanjutkan?')) return;
    try {
        await requestJson('POST', 'api/devices/activate', { craneId, by: changedBy() || storageGet('operatorName', '') });
        setDirty(false);
        const p = AlarmRules.parseDeviceId(craneId); // craneId = ID perangkat; yang dibuka accordion crane induknya
        openCranes.add(p ? p.craneId : craneId);
        renderAudit();
    } catch (e) {
        alert(`Gagal mengaktifkan ${craneId}: ${e.message}`);
    }
}

async function ignoreDevice(craneId) {
    try {
        await requestJson('POST', 'api/devices/ignore', { craneId, by: changedBy() || storageGet('operatorName', '') });
    } catch (e) {
        alert(`Gagal: ${e.message}`);
    }
}

async function hapusDevice(craneId) {
    if (!confirm(`Hapus "${craneId}" dari daftar perangkat terdeteksi?\n\nData crane & motor di Pengaturan TIDAK ikut terhapus. Kalau ESP32 ini kirim data lagi, dia akan muncul lagi di daftar ini dari nol.`)) return;
    try {
        await requestJson('POST', 'api/devices/remove', { craneId, by: changedBy() || storageGet('operatorName', '') });
    } catch (e) {
        alert(`Gagal menghapus ${craneId}: ${e.message}`);
    }
}

function downloadBackup() {
    const blob = new Blob([JSON.stringify(settings, null, 2)], { type: 'application/json' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `settings-backup_rev${settings.revision}_${new Date().toISOString().slice(0, 10)}.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 10000);
}

// ---------- real-time ----------
function connectStream() {
    const es = new EventSource('api/stream');
    es.addEventListener('settings', e => {
        const next = JSON.parse(e.data);
        if (settings && next.revision === settings.revision) return;
        settings = next;
        if (saving) return; // draft direset sendiri oleh saveSettings()
        if (!dirty) {
            resetDraft();
        } else {
            showErrors('Pengaturan baru saja diubah dari tempat lain. Perubahan Anda di halaman ini tidak bisa disimpan lagi - klik Batalkan untuk memuat versi terbaru, lalu ulangi perubahan.');
        }
        renderAudit();
    });
    es.addEventListener('audit', () => renderAudit()); // riwayat dihapus master -> daftar di layar ini ikut kosong
    es.addEventListener('devices', e => {
        devices = JSON.parse(e.data);
        renderDevices();
        refreshOtaBlocks(); // update halus per baris, bukan render ulang (field lain lagi diketik bisa kehilangan fokus)
    });
}

window.addEventListener('beforeunload', e => {
    if (dirty) {
        e.preventDefault();
        e.returnValue = '';
    }
});

async function init() {
    document.getElementById('changedBy').value = storageGet('operatorName', '');
    try {
        settings = await requestJson('GET', 'api/settings');
        devices = await requestJson('GET', 'api/devices');
    } catch (e) {
        showErrors(`Pengaturan tidak bisa dimuat dari server (${e.message}). Pastikan npm run service sedang jalan.`);
        return;
    }
    await loadOtaManifests();
    setupOtaDropzones();
    resetDraft();
    renderAudit();
    connectStream();
}

init();