// ============================================================
// HALAMAN PENGATURAN (pengaturan.html)
// ============================================================
// Mengubah config/settings.json lewat API server.js: nama crane/gearbox, status
// terpasang, dan batas suhu (default, per crane, per gearbox). Juga menampilkan
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
const openCranes = new Set();

const LIMIT_LABELS = {
    low: ['Min (°C)', 'Di bawah ini: alarm suhu rendah (sensor lepas / terlalu dingin)'],
    warning: ['Batas atas normal (°C)', 'Di atas ini: Warning (mendekati Max)'],
    danger: ['Max (°C)', 'Di atas ini: Danger'],
    hysteresis: ['Hysteresis (°C)', 'Alarm suhu baru selesai kalau suhu sudah kembali sejauh ini dari batasnya'],
    riseDegrees: ['Kenaikan cepat (°C)', 'Alarm kalau suhu naik sebanyak ini...'],
    riseMinutes: ['... dalam (menit)', '...dalam rentang waktu ini'],
    offlineMinutes: ['Offline setelah (menit)', 'Gearbox dianggap offline kalau tidak ada data selama ini']
};
const PER_GEARBOX_LIMITS = ['low', 'warning', 'danger'];

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

function craneSummaryHTML(crane) {
    return `
        <span class="crane-summary-name">${escapeHTML(crane.name || '(tanpa nama)')}</span>
        <small>${escapeHTML(crane.id)} · ${escapeHTML(crane.location)} · ${crane.gearboxes.length} gearbox</small>
        <span class="status-badge ${crane.installed ? 'status-normal' : 'status-not-installed'}">${crane.installed ? 'terpasang' : 'belum terpasang'}</span>`;
}

function updateCraneSummary(ci) {
    const el = document.getElementById(`crane-summary-${ci}`);
    if (el) el.innerHTML = craneSummaryHTML(draft.cranes[ci]);
}

function renderCranes() {
    const query = document.getElementById('craneSearch').value.toLowerCase().trim();
    const onlyInstalled = document.getElementById('onlyInstalled').checked;

    document.getElementById('craneList').innerHTML = draft.cranes.map((crane, ci) => {
        const match = `${crane.id} ${crane.name} ${crane.location}`.toLowerCase().includes(query);
        if (!match || (onlyInstalled && !crane.installed)) return '';
        const device = devices.find(d => d.craneId === crane.id);
        const lim = crane.limits || {};
        const deviceInfo = device
            ? `<span class="${device.online === false ? 'text-danger' : 'text-normal'}"><i class="fa-solid fa-circle"></i> ${device.online === false ? 'offline' : 'mengirim data'}</span> · terakhir ${fmtAgo(device.lastSeen)}${device.info && device.info.fw ? ` · firmware ${escapeHTML(device.info.fw)}` : ''}`
            : '<span class="text-not-installed">belum pernah mengirim data</span>';

        return `
        <details class="crane-settings" data-ci="${ci}" ${openCranes.has(crane.id) ? 'open' : ''} ontoggle="toggleCraneOpen(this)">
            <summary id="crane-summary-${ci}">${craneSummaryHTML(crane)}</summary>
            <div class="crane-settings-body">
                <div class="crane-fields">
                    <label>Nama crane<input type="text" maxlength="120" data-field="crane:${ci}:name" value="${escapeHTML(crane.name)}" oninput="onField(this)"></label>
                    <label>Lokasi<input type="text" maxlength="80" data-field="crane:${ci}:location" value="${escapeHTML(crane.location)}" oninput="onField(this)"></label>
                    <label>Area (topik MQTT)<input type="text" maxlength="20" data-field="crane:${ci}:area" value="${escapeHTML(crane.area)}" oninput="onField(this)"></label>
                    <label class="check-inline big"><input type="checkbox" data-field="crane:${ci}:installed" ${crane.installed ? 'checked' : ''} onchange="onField(this)"> Terpasang (tampil di dashboard & dipantau alarm)</label>
                </div>
                <p class="device-line"><i class="fa-solid fa-satellite-dish"></i> Topik: <code>pabrik/${escapeHTML(crane.area)}/${escapeHTML(crane.id)}/temp</code> · ${deviceInfo}</p>

                <div class="crane-limits">
                    <span>Batas khusus crane ini (semua gearbox-nya):</span>
                    ${PER_GEARBOX_LIMITS.map(k => `<label>${LIMIT_LABELS[k][0]}${limitInput(`climit:${ci}:${k}`, lim[k])}</label>`).join('')}
                </div>

                <div class="table-wrap">
                    <table class="report-table settings-table">
                        <thead><tr>
                            <th>Key</th><th>Nama gearbox</th><th>Kode sparepart</th>
                            ${PER_GEARBOX_LIMITS.map(k => `<th class="num">${LIMIT_LABELS[k][0]}</th>`).join('')}
                            <th></th>
                        </tr></thead>
                        <tbody>${crane.gearboxes.map((gb, gi) => `
                            <tr id="gb-row-${ci}-${gi}">
                                <td><code>${escapeHTML(gb.key)}</code></td>
                                <td><input type="text" maxlength="80" data-field="gb:${ci}:${gi}:name" value="${escapeHTML(gb.name)}" oninput="onField(this)"></td>
                                <td><input type="text" maxlength="80" data-field="gb:${ci}:${gi}:sparepart" value="${escapeHTML(gb.sparepart || '')}" oninput="onField(this)"></td>
                                ${PER_GEARBOX_LIMITS.map(k => `<td class="num">${limitInput(`glimit:${ci}:${gi}:${k}`, (gb.limits || {})[k])}</td>`).join('')}
                                <td><button class="icon-btn" title="Hapus gearbox ini" onclick="removeGearbox(${ci}, ${gi})"><i class="fa-solid fa-trash"></i></button></td>
                            </tr>`).join('')}
                        </tbody>
                    </table>
                </div>
                <div class="crane-actions">
                    <button class="device-btn" onclick="addGearbox(${ci})"><i class="fa-solid fa-plus"></i> Tambah gearbox</button>
                    <button class="device-btn danger" onclick="removeCrane(${ci})"><i class="fa-solid fa-trash"></i> Hapus crane</button>
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

function renderDevices() {
    const table = document.getElementById('deviceTable');
    const head = '<thead><tr><th>Crane ID</th><th>Status di sistem</th><th>Koneksi</th><th>Terakhir kirim data</th><th>Gearbox</th><th>Firmware</th><th>IP</th><th class="num">Sinyal WiFi</th><th></th></tr></thead>';
    if (devices.length === 0) {
        table.innerHTML = head + '<tbody><tr><td colspan="9" class="report-empty">Belum ada perangkat yang mengirim data sejak fitur ini aktif.</td></tr></tbody>';
        return;
    }
    table.innerHTML = head + `<tbody>${devices.map(d => {
        const crane = (settings.cranes || []).find(c => c.id === d.craneId);
        let state, actions = '';
        const id = escapeHTML(d.craneId);
        if (d.installed) {
            state = '<span class="status-badge status-normal">aktif</span>';
            if (d.unknownGearboxes.length) {
                state += ` <small class="text-warning">+ gearbox belum terdaftar: ${escapeHTML(d.unknownGearboxes.join(', '))}</small>`;
                actions = `<button class="device-btn primary" data-id="${id}" onclick="activateDevice(this.dataset.id)">Tambahkan gearbox</button>`;
            }
        } else if (d.ignoredAt) {
            state = `<span class="status-badge status-not-installed">diabaikan</span> <small>${escapeHTML(d.ignoredBy || '')}</small>`;
            actions = `<button class="device-btn" data-id="${id}" onclick="activateDevice(this.dataset.id)">Aktifkan</button>`;
        } else {
            state = `<span class="status-badge status-warning">${crane ? 'belum diaktifkan' : 'tidak dikenal'}</span>`;
            actions = `<button class="device-btn primary" data-id="${id}" onclick="activateDevice(this.dataset.id)"><i class="fa-solid fa-power-off"></i> Aktifkan</button>
                       <button class="device-btn" data-id="${id}" onclick="ignoreDevice(this.dataset.id)">Abaikan</button>`;
        }
        const conn = d.online === null ? '<small class="text-not-installed">firmware lama</small>'
            : d.online ? '<span class="text-normal"><i class="fa-solid fa-circle"></i> online</span>'
            : '<span class="text-danger"><i class="fa-solid fa-circle"></i> offline</span>';
        const info = d.info || {};
        const rssi = typeof info.rssi === 'number' ? `${info.rssi} dBm` : '—';
        return `<tr>
            <td><strong>${id}</strong><br><small>${crane ? escapeHTML(crane.name) : 'area ' + escapeHTML(d.area)}</small></td>
            <td>${state}</td>
            <td>${conn}</td>
            <td>${fmtAgo(d.lastSeen)}<br><small>${fmtDateTime(d.lastSeen)}</small></td>
            <td>${escapeHTML(d.gbKeys.join(', ') || '—')}</td>
            <td>${escapeHTML(info.fw || '—')}</td>
            <td>${escapeHTML(info.ip || '—')}</td>
            <td class="num">${rssi}</td>
            <td>${actions}</td>
        </tr>`;
    }).join('')}</tbody>`;
}

async function renderAudit() {
    let rows;
    try {
        rows = await requestJson('GET', 'api/settings/audit');
    } catch (e) {
        document.getElementById('auditList').innerHTML = `<div class="report-empty">Gagal memuat riwayat: ${escapeHTML(e.message)}</div>`;
        return;
    }
    document.getElementById('auditList').innerHTML = rows.length === 0
        ? '<div class="report-empty">Belum ada perubahan.</div>'
        : rows.map(r => `
            <div class="audit-item">
                <div class="audit-head"><strong>${escapeHTML(r.action)}</strong> · ${fmtDateTime(r.at)} · ${r.by ? escapeHTML(r.by) : '<span class="text-not-installed">tanpa nama</span>'}</div>
                <ul>${r.changes.slice(0, 30).map(c => `<li>${escapeHTML(c)}</li>`).join('')}${r.changes.length > 30 ? `<li>... dan ${r.changes.length - 30} perubahan lain</li>` : ''}</ul>
            </div>`).join('');
}

// ---------- ubah daftar ----------
function addGearbox(ci) {
    const crane = draft.cranes[ci];
    const used = crane.gearboxes.map(g => parseInt(g.key.slice(2), 10));
    const next = Math.max(0, ...used) + 1;
    const key = `gb${String(next).padStart(2, '0')}`;
    crane.gearboxes.push({ key, name: `GB ${String(next).padStart(2, '0')}`, sparepart: '' });
    openCranes.add(crane.id);
    setDirty(true);
    renderCranes();
}

function removeGearbox(ci, gi) {
    const crane = draft.cranes[ci];
    const gb = crane.gearboxes[gi];
    if (!confirm(`Hapus ${gb.key} (${gb.name}) dari ${crane.name}?\nData lamanya tetap tersimpan, tapi gearbox ini tidak lagi tampil & dipantau alarm.`)) return;
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
        gearboxes: [1, 2, 3, 4, 5].map(n => ({ key: `gb0${n}`, name: `GB 0${n}`, sparepart: '' }))
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
        openCranes.add(craneId);
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
    es.addEventListener('devices', e => {
        devices = JSON.parse(e.data);
        renderDevices();
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
    resetDraft();
    renderAudit();
    connectStream();
}

init();
