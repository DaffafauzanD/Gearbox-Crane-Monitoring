// ============================================================
// HALAMAN TREN & LAPORAN (laporan.html)
// ============================================================
// Data diambil dari API server.js (sumbernya data/monitoring.db):
//   Tren suhu        -> /api/trend          grafik min / rata-rata / maks per gearbox
//   Laporan periode  -> /api/report         ringkasan semua gearbox dalam periode
//   Kejadian alarm   -> /api/report/alarms  daftar alarm: mulai, selesai, durasi, ack
// Semua waktu ditampilkan dalam WIB.

// Daftar crane & batas dari server (config/settings.json), diisi di init()
let settings = { defaults: {}, cranes: [] };
let CRANES = [];
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const WIB_OFFSET = 7 * HOUR;
const MAX_RANGE_DAYS = 400;
const TABS = ['trend', 'summary', 'alarms'];

let period = { from: 0, to: 0, days: 7 };
let currentTab = 'trend';
let trendData = null;     // { crane, results: [ { bucketMs, points } per gearbox ] }
let summaryData = null;
let alarmData = null;
let summarySort = { key: 'dangerMinutes', dir: -1 };
let trendRequest = 0;
const trendCharts = {};

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
    return String(value).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

const TZ = { timeZone: 'Asia/Jakarta' };
const fmtDateTime = ms => new Date(ms).toLocaleString('id-ID', { ...TZ, day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
const fmtDate = ms => new Date(ms).toLocaleDateString('id-ID', { ...TZ, day: '2-digit', month: 'short', year: 'numeric' });
const fmtShortDate = ms => new Date(ms).toLocaleDateString('id-ID', { ...TZ, day: '2-digit', month: 'short' });
const fmtTime = ms => new Date(ms).toLocaleTimeString('id-ID', { ...TZ, hour: '2-digit', minute: '2-digit' });
const fmtNum = v => (v === null || v === undefined ? '—' : Number(v).toFixed(1));
const wibDateStr = ms => new Date(ms + WIB_OFFSET).toISOString().slice(0, 10); // YYYY-MM-DD (WIB)
const excelDate = ms => new Date(ms + WIB_OFFSET); // ExcelJS menulis jam UTC -> geser supaya tampil WIB

function fmtDuration(ms) {
    const min = Math.round(ms / 60000);
    if (min < 1) return '< 1 menit';
    if (min < 60) return `${min} menit`;
    const h = Math.floor(min / 60);
    if (h < 48) return `${h} jam ${min % 60} menit`;
    return `${Math.floor(h / 24)} hari ${h % 24} jam`;
}

function craneOf(id) {
    return CRANES.find(c => c.id === id);
}

function names(craneId, gbKey) {
    const crane = craneOf(craneId);
    const gb = crane && crane.gearboxes.find(g => g.key === gbKey);
    return { craneName: crane ? crane.name : craneId, gbName: gb ? gb.name : gbKey };
}

async function api(path, params) {
    const res = await fetch(`${path}?${new URLSearchParams(params)}`, { cache: 'no-store' });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
    return body;
}

function errorBox(err) {
    return `<div class="report-empty"><i class="fa-solid fa-triangle-exclamation"></i> Gagal memuat data: ${escapeHTML(err.message)}.<br>Pastikan server (npm run service) sedang jalan.</div>`;
}

// ---------- periode ----------
function setPreset(days) {
    const now = Date.now();
    period = { from: now - days * DAY, to: now, days };
    storageSet('reportDays', String(days));
    onPeriodChanged();
}

function applyCustomPeriod() {
    const a = document.getElementById('customFrom').value;
    const b = document.getElementById('customTo').value;
    if (!a || !b) return alert('Isi tanggal awal dan akhir.');
    const from = Date.parse(`${a}T00:00:00+07:00`);
    const to = Date.parse(`${b}T00:00:00+07:00`) + DAY; // sampai akhir hari tanggal akhir
    if (to <= from) return alert('Tanggal akhir harus sama atau setelah tanggal awal.');
    if (to - from > MAX_RANGE_DAYS * DAY) return alert(`Periode maksimal ${MAX_RANGE_DAYS} hari.`);
    period = { from, to, days: null };
    onPeriodChanged();
}

function onPeriodChanged() {
    document.querySelectorAll('.period-btn[data-days]').forEach(btn => btn.classList.toggle('active', Number(btn.dataset.days) === period.days));
    const label = period.days
        ? `${period.days === 1 ? '24 jam' : period.days + ' hari'} terakhir · ${fmtDateTime(period.from)} – ${fmtDateTime(period.to)} WIB`
        : `${fmtDate(period.from)} – ${fmtDate(period.to - 1)}`;
    document.getElementById('periodLabel').innerText = label;
    summaryData = null;
    alarmData = null;
    loadCurrentTab();
}

// ---------- tab ----------
function setTab(tab, load = true) {
    currentTab = TABS.includes(tab) ? tab : 'trend';
    storageSet('reportTab', currentTab);
    document.querySelectorAll('.report-tab').forEach(btn => btn.classList.toggle('active', btn.dataset.tab === currentTab));
    TABS.forEach(t => { document.getElementById(`tab-${t}`).style.display = t === currentTab ? '' : 'none'; });
    if (load) loadCurrentTab();
}

function loadCurrentTab() {
    if (currentTab === 'trend') loadTrend();
    else if (currentTab === 'summary') (summaryData ? renderSummary() : loadSummary());
    else (alarmData ? renderAlarms() : loadAlarms());
}

// ============================================================
// TREN SUHU
// ============================================================
function initCraneSelect() {
    const select = document.getElementById('craneSelect');
    const sorted = [...CRANES].sort((a, b) => (b.installed - a.installed) || (a.number - b.number));
    select.innerHTML = sorted.map(c =>
        `<option value="${escapeHTML(c.id)}">${escapeHTML(c.name)}${c.installed ? '' : ' (belum terpasang)'}</option>`).join('');
    const saved = storageGet('reportCrane', '');
    select.value = craneOf(saved) ? saved : sorted[0].id;
}

function destroyTrendCharts() {
    Object.keys(trendCharts).forEach(key => {
        trendCharts[key].destroy();
        delete trendCharts[key];
    });
}

async function loadTrend() {
    const crane = craneOf(document.getElementById('craneSelect').value);
    storageSet('reportCrane', crane.id);
    const request = ++trendRequest;

    destroyTrendCharts();
    trendData = null;
    const grid = document.getElementById('trendGrid');
    grid.innerHTML = crane.gearboxes.map(gb => `
        <div class="trend-card">
            <div class="trend-card-header">
                <span class="gearbox-name"><i class="fa-solid fa-gear"></i> ${escapeHTML(gb.name)}</span>
                <span class="trend-stats" id="trend-stats-${gb.key}"><i class="fa-solid fa-spinner fa-spin"></i> memuat...</span>
            </div>
            <div class="trend-chart">
                <canvas id="trend-canvas-${gb.key}"></canvas>
                <div class="chart-placeholder" id="trend-empty-${gb.key}"></div>
            </div>
        </div>`).join('');

    try {
        const results = await Promise.all(crane.gearboxes.map(gb =>
            api('api/trend', { crane: crane.id, gb: gb.key, from: period.from, to: period.to })));
        if (request !== trendRequest) return; // crane / periode sudah diganti sebelum data datang
        trendData = { crane, results };
        crane.gearboxes.forEach((gb, i) => renderTrendCard(crane, gb, results[i]));
    } catch (err) {
        if (request === trendRequest) grid.innerHTML = errorBox(err);
    }
}

// Label sumbu waktu. Periode lebih dari sehari: dua baris (tanggal / jam) supaya
// tidak saling tumpuk di grafik yang sempit.
function trendLabel(t, bucketMs) {
    if (bucketMs >= DAY) return fmtShortDate(t);
    if (period.to - period.from <= DAY) return fmtTime(t);
    return [fmtShortDate(t), fmtTime(t)];
}

function renderTrendCard(crane, gb, data) {
    const statsEl = document.getElementById(`trend-stats-${gb.key}`);
    const emptyEl = document.getElementById(`trend-empty-${gb.key}`);
    const withData = data.points.filter(p => p.n > 0);

    if (withData.length === 0) {
        statsEl.innerText = '';
        emptyEl.innerHTML = crane.installed
            ? '<i class="fa-solid fa-circle-info"></i> Tidak ada data pada periode ini'
            : '<i class="fa-solid fa-ban"></i> Sensor belum terpasang';
        emptyEl.style.display = 'flex';
        return;
    }

    const limits = AlarmRules.getLimits(settings, crane.id, gb.key);
    const min = Math.min(...withData.map(p => p.min));
    const max = Math.max(...withData.map(p => p.max));
    const n = withData.reduce((s, p) => s + p.n, 0);
    const avg = withData.reduce((s, p) => s + p.avg * p.n, 0) / n;
    const errors = data.points.reduce((s, p) => s + p.errors, 0);
    const maxClass = AlarmRules.tempStatus(max, limits);
    const minClass = min < limits.low ? 'low' : '';
    statsEl.innerHTML = `<span class="text-${minClass}">Min ${fmtNum(min)}</span> · Rata² ${fmtNum(avg)} · <span class="text-${maxClass === 'normal' ? 'normal' : maxClass}">Maks ${fmtNum(max)} °C</span>` +
        (errors ? ` · <span class="text-fault">${errors} error</span>` : '');

    // Deret waktu lengkap: interval tanpa data jadi celah di grafik (bukan disambung)
    const b = data.bucketMs;
    const byTime = new Map(data.points.map(p => [p.t, p]));
    const labels = [], mins = [], maxs = [], avgs = [];
    for (let t = Math.floor((period.from + WIB_OFFSET) / b) * b - WIB_OFFSET; t < period.to; t += b) {
        const p = byTime.get(t);
        labels.push(trendLabel(t, b));
        mins.push(p && p.n ? p.min : null);
        maxs.push(p && p.n ? p.max : null);
        avgs.push(p && p.n ? p.avg : null);
    }
    const flat = value => labels.map(() => value);

    trendCharts[gb.key] = new Chart(document.getElementById(`trend-canvas-${gb.key}`), {
        type: 'line',
        data: {
            labels,
            datasets: [
                { label: 'Suhu tertinggi', data: maxs, borderColor: 'rgba(56,189,248,0.35)', backgroundColor: 'rgba(56,189,248,0.15)', borderWidth: 1, pointRadius: 0, fill: '+1' },
                { label: 'Suhu terendah', data: mins, borderColor: 'rgba(56,189,248,0.35)', borderWidth: 1, pointRadius: 0, fill: false },
                { label: 'Rata-rata', data: avgs, borderColor: '#38bdf8', borderWidth: 2, pointRadius: 0, fill: false },
                { label: 'Batas Min', data: flat(limits.low), borderColor: '#22d3ee', borderDash: [6, 4], borderWidth: 1, pointRadius: 0, fill: false },
                { label: 'Batas atas normal', data: flat(limits.warning), borderColor: '#f59e0b', borderDash: [6, 4], borderWidth: 1, pointRadius: 0, fill: false },
                { label: 'Batas Max', data: flat(limits.danger), borderColor: '#ef4444', borderDash: [6, 4], borderWidth: 1, pointRadius: 0, fill: false }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            animation: false,
            interaction: { mode: 'index', intersect: false },
            plugins: {
                legend: { display: false },
                tooltip: {
                    filter: item => item.parsed.y !== null,
                    callbacks: { label: ctx => `${ctx.dataset.label}: ${ctx.parsed.y.toFixed(1)} °C` }
                }
            },
            scales: {
                x: { grid: { color: '#1e293b' }, ticks: { color: '#94a3b8', maxTicksLimit: 6, maxRotation: 0, autoSkip: true, autoSkipPadding: 16 } },
                y: {
                    grid: { color: '#1e293b' },
                    ticks: { color: '#94a3b8' },
                    suggestedMin: Math.min(min, limits.low) - 5,
                    suggestedMax: Math.max(max, limits.danger) + 5
                }
            }
        }
    });
}

// ============================================================
// LAPORAN PERIODE
// ============================================================
const SUMMARY_COLUMNS = [
    { key: 'craneName', label: 'Crane', text: true },
    { key: 'gbName', label: 'Gearbox', text: true },
    { key: 'limitDanger', label: 'Batas Min / Normal / Max (°C)', html: r => `${r.limits.low} / ${r.limits.warning} / ${r.limits.danger}`, excel: r => `${r.limits.low} / ${r.limits.warning} / ${r.limits.danger}` },
    { key: 'min', label: 'Min (°C)', html: r => fmtNum(r.min) },
    { key: 'avg', label: 'Rata-rata (°C)', html: r => fmtNum(r.avg) },
    { key: 'max', label: 'Maks (°C)', html: r => r.max === null ? '—' : `<span class="text-${AlarmRules.tempStatus(r.max, r.limits)}">${fmtNum(r.max)}</span>` },
    { key: 'maxAt', label: 'Waktu maks', html: r => r.maxAt ? fmtDateTime(r.maxAt) : '—', excel: r => r.maxAt ? excelDate(r.maxAt) : null, date: true },
    { key: 'warningMinutes', label: 'Menit warning', html: r => r.warningMinutes ?? '—' },
    { key: 'dangerMinutes', label: 'Menit danger', html: r => r.dangerMinutes ? `<span class="text-danger">${r.dangerMinutes}</span>` : (r.dangerMinutes ?? '—') },
    { key: 'alarmDanger', label: 'Alarm danger', html: r => r.alarmDanger ? `<span class="text-danger">${r.alarmDanger}</span>` : r.alarmDanger },
    { key: 'alarmWarning', label: 'Alarm warning' },
    { key: 'alarmSensor', label: 'Alarm sensor / suhu rendah' },
    { key: 'alarmDurationMs', label: 'Durasi alarm', html: r => r.alarmDurationMs ? fmtDuration(r.alarmDurationMs) : '—', excel: r => Math.round(r.alarmDurationMs / 60000), excelLabel: 'Durasi alarm (menit)' },
    { key: 'errorSamples', label: 'Sampel error' },
    {
        key: 'availability', label: 'Data tersedia',
        html: r => {
            const pct = Math.round(r.availability * 100);
            return `<span class="${pct < 50 ? 'text-danger' : pct < 90 ? 'text-warning' : 'text-normal'}">${pct}%</span>`;
        },
        excel: r => Math.round(r.availability * 1000) / 10, excelLabel: 'Data tersedia (%)'
    }
];

async function loadSummary() {
    document.getElementById('summaryTable').innerHTML = '<tbody><tr><td class="report-empty"><i class="fa-solid fa-spinner fa-spin"></i> Memuat...</td></tr></tbody>';
    document.getElementById('summaryCards').innerHTML = '';
    try {
        summaryData = await api('api/report', { from: period.from, to: period.to });
        renderSummary();
    } catch (err) {
        document.getElementById('summaryTable').innerHTML = `<tbody><tr><td>${errorBox(err)}</td></tr></tbody>`;
    }
}

// Baris laporan + gearbox terpasang yang sama sekali tidak mengirim data di periode ini
// (supaya sensor yang mati selama periode tetap kelihatan).
function summaryRows() {
    const rows = summaryData.rows.map(r => ({
        ...r, ...names(r.craneId, r.gbKey),
        limitDanger: r.limits.danger,
        alarmDanger: r.alarms.danger, alarmWarning: r.alarms.warning, alarmSensor: r.alarms.sensor
    }));
    CRANES.filter(c => c.installed).forEach(crane => crane.gearboxes.forEach(gb => {
        if (rows.some(r => r.craneId === crane.id && r.gbKey === gb.key)) return;
        const limits = AlarmRules.getLimits(settings, crane.id, gb.key);
        rows.push({
            craneId: crane.id, gbKey: gb.key, craneName: crane.name, gbName: gb.name, noData: true,
            limits: { low: limits.low, warning: limits.warning, danger: limits.danger }, limitDanger: limits.danger,
            min: null, avg: null, max: null, maxAt: null, warningMinutes: null, dangerMinutes: null,
            alarmDanger: 0, alarmWarning: 0, alarmSensor: 0, alarmDurationMs: 0, errorSamples: 0, samples: 0, availability: 0
        });
    }));

    const { key, dir } = summarySort;
    const col = SUMMARY_COLUMNS.find(c => c.key === key);
    return rows.sort((a, b) => {
        const va = a[key], vb = b[key];
        if (va === null || va === undefined) return 1;   // kosong selalu di bawah
        if (vb === null || vb === undefined) return -1;
        const cmp = col && col.text ? String(va).localeCompare(String(vb), 'id', { numeric: true }) : va - vb;
        return cmp * dir || (b.max ?? -Infinity) - (a.max ?? -Infinity);
    });
}

function sortSummary(key) {
    const col = SUMMARY_COLUMNS.find(c => c.key === key);
    summarySort = summarySort.key === key ? { key, dir: -summarySort.dir } : { key, dir: col.text ? 1 : -1 };
    renderSummary();
}

function renderSummary() {
    const rows = summaryRows();
    const withData = rows.filter(r => !r.noData);
    const hottest = withData.reduce((h, r) => (h === null || r.max > h.max ? r : h), null);
    const totalDangerMinutes = withData.reduce((s, r) => s + (r.dangerMinutes || 0), 0);
    const totalDangerAlarms = withData.reduce((s, r) => s + r.alarmDanger, 0);
    const noDataCount = rows.length - withData.length;

    document.getElementById('summaryCards').innerHTML = `
        <div class="summary-card"><div class="summary-value">${withData.length}</div><div class="summary-label">Gearbox dengan data</div></div>
        <div class="summary-card"><div class="summary-value ${noDataCount ? 'text-warning' : ''}">${noDataCount}</div><div class="summary-label">Terpasang tapi tanpa data</div></div>
        <div class="summary-card"><div class="summary-value ${totalDangerAlarms ? 'text-danger' : ''}">${totalDangerAlarms}</div><div class="summary-label">Alarm danger</div></div>
        <div class="summary-card"><div class="summary-value ${totalDangerMinutes ? 'text-danger' : ''}">${summaryData.resolution === 'minute' ? totalDangerMinutes : '—'}</div><div class="summary-label">Menit di atas batas danger</div></div>
        <div class="summary-card wide"><div class="summary-value">${hottest ? fmtNum(hottest.max) + ' °C' : '—'}</div>
            <div class="summary-label">${hottest ? `Terpanas: ${escapeHTML(hottest.gbName)} · ${escapeHTML(hottest.craneName)}` : 'Terpanas'}</div></div>`;

    document.getElementById('summaryHint').innerText = summaryData.resolution === 'minute'
        ? 'Menit warning/danger = jumlah menit yang suhu maksimalnya melewati batas gearbox itu. Data tersedia = persentase menit yang ada datanya sejak sensor pertama kali mengirim. Klik judul kolom untuk mengurutkan.'
        : 'Periode ini melewati 90 hari: ringkasan per menit sudah dihapus, jadi kolom menit warning/danger tidak tersedia (min/maks/rata-rata dari ringkasan per jam).';

    const arrow = key => summarySort.key === key ? (summarySort.dir > 0 ? ' ▲' : ' ▼') : '';
    const head = `<thead><tr>${SUMMARY_COLUMNS.map(c =>
        `<th onclick="sortSummary('${c.key}')" class="${c.text ? '' : 'num'}">${c.label}${arrow(c.key)}</th>`).join('')}</tr></thead>`;
    const body = rows.length === 0
        ? `<tbody><tr><td colspan="${SUMMARY_COLUMNS.length}" class="report-empty">Belum ada data pada periode ini.</td></tr></tbody>`
        : `<tbody>${rows.map(r => `<tr class="${r.noData ? 'row-nodata' : ''}">${SUMMARY_COLUMNS.map(c => {
            const value = c.html ? c.html(r) : escapeHTML(r[c.key]);
            return `<td class="${c.text ? '' : 'num'}">${r.noData && c.key === 'min' ? '<span class="text-warning">tidak ada data</span>' : value}</td>`;
        }).join('')}</tr>`).join('')}</tbody>`;
    document.getElementById('summaryTable').innerHTML = head + body;
}

// ============================================================
// KEJADIAN ALARM
// ============================================================
const ALARM_TYPE_LABEL = { temp: 'Suhu tinggi', low: 'Suhu rendah', rise: 'Kenaikan cepat', fault: 'Sensor error', offline: 'Sensor offline' };

async function loadAlarms() {
    document.getElementById('alarmTable').innerHTML = '<tbody><tr><td class="report-empty"><i class="fa-solid fa-spinner fa-spin"></i> Memuat...</td></tr></tbody>';
    try {
        alarmData = (await api('api/report/alarms', { from: period.from, to: period.to })).occurrences;
        renderAlarms();
    } catch (err) {
        document.getElementById('alarmTable').innerHTML = `<tbody><tr><td>${errorBox(err)}</td></tr></tbody>`;
    }
}

function filteredAlarms() {
    const filter = document.getElementById('alarmFilter').value;
    return alarmData.filter(o => {
        if (filter === 'danger') return o.severity === 'danger';
        if (filter === 'sensor') return o.type === 'fault' || o.type === 'offline';
        if (filter === 'temp' || filter === 'rise' || filter === 'low') return o.type === filter;
        return true;
    });
}

// Nilai terparah selama alarm: suhu puncak (suhu tinggi), besar kenaikan (kenaikan cepat)
function alarmPeakText(o) {
    const peak = o.peak ?? parseFloat(o.value);
    if (o.type === 'temp') return Number.isFinite(peak) ? `${peak.toFixed(1)} °C` : '—';
    if (o.type === 'rise') return Number.isFinite(peak) ? `+${peak.toFixed(1)} °C` : '—';
    if (o.type === 'low') { const v = parseFloat(o.value); return Number.isFinite(v) ? `${v.toFixed(1)} °C` : '—'; }
    if (o.type === 'fault') return o.value ?? '—';
    return '—';
}

function alarmLimitText(o) {
    if (o.limit === null || o.limit === undefined) return '—';
    if (o.type === 'offline') return `${o.limit} menit`;
    return o.type === 'rise' ? `+${o.limit} °C` : `${o.limit} °C`;
}

function renderAlarms() {
    const list = filteredAlarms();
    const head = '<thead><tr><th>Mulai</th><th>Selesai</th><th class="num">Durasi</th><th>Crane</th><th>Gearbox</th><th>Jenis</th><th>Tingkat</th><th class="num">Puncak</th><th class="num">Batas</th><th>Di-ack oleh</th></tr></thead>';
    if (list.length === 0) {
        document.getElementById('alarmTable').innerHTML = head + '<tbody><tr><td colspan="10" class="report-empty"><i class="fa-solid fa-circle-check"></i> Tidak ada alarm pada periode ini.</td></tr></tbody>';
        return;
    }
    const now = Date.now();
    document.getElementById('alarmTable').innerHTML = head + `<tbody>${list.map(o => {
        const { craneName, gbName } = names(o.craneId, o.gbKey);
        const duration = (o.end ?? now) - o.start;
        return `<tr>
            <td>${fmtDateTime(o.start)}</td>
            <td>${o.end ? fmtDateTime(o.end) : '<span class="text-danger">masih aktif</span>'}</td>
            <td class="num">${fmtDuration(duration)}</td>
            <td>${escapeHTML(craneName)}</td>
            <td>${escapeHTML(gbName)}</td>
            <td>${escapeHTML(ALARM_TYPE_LABEL[o.type] || o.type)}</td>
            <td><span class="status-badge status-${o.severity}">${o.severity}</span></td>
            <td class="num">${escapeHTML(alarmPeakText(o))}</td>
            <td class="num">${escapeHTML(alarmLimitText(o))}</td>
            <td>${o.ackedBy ? `${escapeHTML(o.ackedBy)} · ${fmtTime(o.ackedAt)}` : '<span class="text-warning">belum di-ack</span>'}</td>
        </tr>`;
    }).join('')}</tbody>`;
}

// ============================================================
// DOWNLOAD EXCEL (ExcelJS baru dimuat saat tombol diklik, ~1 MB)
// ============================================================
let excelJsLoading = null;

function loadExcelJs() {
    if (window.ExcelJS) return Promise.resolve();
    if (!excelJsLoading) {
        excelJsLoading = new Promise((resolve, reject) => {
            const script = document.createElement('script');
            script.src = 'vendor/exceljs.min.js';
            script.onload = resolve;
            script.onerror = () => {
                excelJsLoading = null;
                reject(new Error('vendor/exceljs.min.js tidak ada - jalankan npm run vendor'));
            };
            document.head.appendChild(script);
        });
    }
    return excelJsLoading;
}

// sheets: [{ name, columns: [{ header, width, date }], rows: [[...]] }]
async function saveWorkbook(fileName, sheets) {
    try {
        await loadExcelJs();
    } catch (err) {
        return alert(err.message);
    }
    const wb = new ExcelJS.Workbook();
    sheets.forEach(sheet => {
        const ws = wb.addWorksheet(sheet.name.slice(0, 31), { views: [{ state: 'frozen', ySplit: 1 }] });
        ws.columns = sheet.columns.map(c => ({ header: c.header, width: c.width || 14 }));
        ws.getRow(1).font = { bold: true };
        sheet.rows.forEach(r => ws.addRow(r));
        sheet.columns.forEach((c, i) => { if (c.date) ws.getColumn(i + 1).numFmt = 'dd/mm/yyyy hh:mm'; });
    });
    const buffer = await wb.xlsx.writeBuffer();
    const link = document.createElement('a');
    link.href = URL.createObjectURL(new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
    link.download = fileName;
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 10000);
}

const periodFileTag = () => `${wibDateStr(period.from)}_sd_${wibDateStr(period.to - 1)}`;

function downloadTrend() {
    if (!trendData) return alert('Data tren belum dimuat.');
    const { crane, results } = trendData;
    return saveWorkbook(`tren_${crane.id}_${periodFileTag()}.xlsx`, crane.gearboxes.map((gb, i) => ({
        name: gb.key,
        columns: [
            { header: `Waktu (WIB) - ${gb.name}`, width: 24, date: true },
            { header: 'Min (°C)' }, { header: 'Rata-rata (°C)' }, { header: 'Maks (°C)' },
            { header: 'Jumlah sampel' }, { header: 'Sampel error' }
        ],
        rows: results[i].points.map(p => [excelDate(p.t), p.min, p.avg, p.max, p.n, p.errors])
    })));
}

function downloadSummary() {
    if (!summaryData) return alert('Laporan belum dimuat.');
    return saveWorkbook(`laporan-periode_${periodFileTag()}.xlsx`, [{
        name: 'Laporan periode',
        columns: SUMMARY_COLUMNS.map(c => ({ header: c.excelLabel || c.label, width: c.text ? 34 : 15, date: c.date })),
        rows: summaryRows().map(r => SUMMARY_COLUMNS.map(c => (c.excel ? c.excel(r) : r[c.key])))
    }]);
}

function downloadAlarms() {
    if (!alarmData) return alert('Data alarm belum dimuat.');
    return saveWorkbook(`kejadian-alarm_${periodFileTag()}.xlsx`, [{
        name: 'Kejadian alarm',
        columns: [
            { header: 'Mulai (WIB)', width: 18, date: true }, { header: 'Selesai (WIB)', width: 18, date: true },
            { header: 'Durasi (menit)' }, { header: 'Crane', width: 34 }, { header: 'Gearbox', width: 26 },
            { header: 'Jenis', width: 16 }, { header: 'Tingkat' }, { header: 'Puncak' }, { header: 'Batas' },
            { header: 'Di-ack oleh', width: 20 }, { header: 'Waktu ack (WIB)', width: 18, date: true }
        ],
        rows: filteredAlarms().map(o => {
            const { craneName, gbName } = names(o.craneId, o.gbKey);
            return [
                excelDate(o.start), o.end ? excelDate(o.end) : 'masih aktif',
                Math.round(((o.end ?? Date.now()) - o.start) / 60000), craneName, gbName,
                ALARM_TYPE_LABEL[o.type] || o.type, o.severity, alarmPeakText(o), alarmLimitText(o),
                o.ackedBy || '', o.ackedAt ? excelDate(o.ackedAt) : ''
            ];
        })
    }]);
}

// ============================================================
// MULAI
// ============================================================
// Bentuk daftar crane yang dipakai halaman ini (id, nama, status terpasang, gearbox)
function buildCraneList() {
    CRANES = settings.cranes.map((c, i) => ({
        id: c.id, number: i + 1, name: c.name, location: c.location, installed: c.installed === true,
        gearboxes: c.gearboxes.map(g => ({ key: g.key, name: g.name }))
    }));
}

async function init() {
    try {
        const res = await fetch('api/settings', { cache: 'no-store' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        settings = await res.json();
    } catch (e) {
        document.getElementById('trendGrid').innerHTML = errorBox(e);
        return;
    }
    buildCraneList();

    initCraneSelect();
    const today = wibDateStr(Date.now());
    document.getElementById('customTo').value = today;
    document.getElementById('customFrom').value = wibDateStr(Date.now() - 6 * DAY);

    setTab(storageGet('reportTab', 'trend'), false);
    setPreset(Number(storageGet('reportDays', '7')) || 7);
}

init();
