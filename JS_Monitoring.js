// Daftar crane, nama gearbox, dan batas suhu datang dari server (config/settings.json,
// diatur lewat halaman Pengaturan) - lihat loadSettings() & event "settings".
let settings = { defaults: {}, cranes: [] };

const cranesData = [];
const charts = {};
const overviewCharts = {};
let currentStatusFilter = 'all';

// ============================================================
// STATUS: crane yang SUDAH jalan vs yang SENGAJA BELUM jalan
// ============================================================
// Dashboard TIDAK lagi mengisi data simulasi/acak. Semua angka yang tampil
// berasal dari sensor asli (MQTT langsung, atau state.json dari mqtt_logger.js).
//
// Status per gearbox:
//   not-installed : crane belum diaktifkan di Pengaturan (sengaja belum jalan)
//   offline       : sudah terpasang, tapi tidak ada data baru > offlineMinutes
//   fault         : data masuk, tapi nilainya bukan suhu yang masuk akal
//                   (mis. PT100 putus ~ -242 °C, NaN, null / fault MAX31865)
//   low / normal / warning / danger : data live, dinilai dari suhunya
//                   (di bawah Min / rentang normal / di atas batas atas normal / di atas Max)
//
// Status crane = status terparah di antara gearbox yang LIVE. Gearbox yang
// offline/error tidak ikut dinilai, tapi jumlahnya ditampilkan di header crane.
//
// Batas tiap gearbox dari pengaturan (aturannya di alarm_rules.js, sama persis
// dengan yang dipakai server alarm).
const MAX_HISTORY = 8;                    // titik histori di chart (1 titik / menit)
const STATUS_REFRESH_MS = 15000;          // seberapa sering status offline dicek ulang

const STATUS_META = {
    'normal':        { label: 'normal',          class: 'status-normal',        color: '#38bdf8' },
    'low':           { label: 'suhu rendah',     class: 'status-low',           color: '#22d3ee' },
    'warning':       { label: 'warning',         class: 'status-warning',       color: '#f59e0b' },
    'danger':        { label: 'danger',          class: 'status-danger',        color: '#ef4444' },
    'fault':         { label: 'sensor error',    class: 'status-fault',         color: '#a855f7' },
    'offline':       { label: 'offline',         class: 'status-offline',       color: '#64748b' },
    'not-installed': { label: 'belum terpasang', class: 'status-not-installed', color: '#64748b' }
};
const LIVE_STATUSES = ['normal', 'low', 'warning', 'danger']; // urut dari yang paling ringan

// Kelompok untuk kartu statistik & filter: "sensor error" dihitung di Offline / Error,
// "suhu rendah" dihitung di Warning (perlu dicek, tapi belum bahaya)
function statusGroup(status) {
    if (status === 'fault') return 'offline';
    if (status === 'low') return 'warning';
    return status;
}

// Susun ulang cranesData dari pengaturan. Nilai live (suhu, histori, dsb) dari
// susunan sebelumnya dipertahankan, jadi aman dipanggil lagi saat pengaturan berubah.
function generateInitialData() {
    const previous = new Map();
    cranesData.forEach(c => c.gearboxes.forEach(gb => previous.set(`${c.mqttId}/${gb.key}`, gb)));
    const wasOpen = new Set(cranesData.filter(c => c.isOpen).map(c => c.mqttId));

    cranesData.length = 0;
    settings.cranes.forEach((item, index) => {
        const gearboxes = item.gearboxes.map((gbDef, idx) => {
            const old = previous.get(`${item.id}/${gbDef.key}`);
            return {
                id: idx + 1,
                key: gbDef.key,       // key MQTT (gb01, gb02, ...) - dipakai untuk data, alarm & batas
                name: gbDef.name,
                sparepart: gbDef.sparepart || '',
                temp: old ? old.temp : null,                   // nilai terakhir (NaN kalau tidak valid)
                rawValue: old ? old.rawValue : null,           // nilai mentah terakhir, untuk sensor error
                lastUpdatedMs: old ? old.lastUpdatedMs : null, // kapan terakhir data masuk
                history: old ? old.history : []                // titik suhu valid, maks MAX_HISTORY
            };
        });

        cranesData.push({
            id: index + 1,
            mqttId: item.id,
            name: item.name,
            location: item.location,
            installed: item.installed === true,
            isOpen: wasOpen.has(item.id),
            gearboxes: gearboxes
        });
    });
}

const isValidTemp = AlarmRules.isValidTemp;

function getLimits(crane, gb) {
    return AlarmRules.getLimits(settings, crane.mqttId, gb.key);
}

function getGearboxStatus(crane, gb) {
    if (!crane.installed) return 'not-installed';
    const limits = getLimits(crane, gb);
    if (gb.lastUpdatedMs === null || Date.now() - gb.lastUpdatedMs > limits.offlineMinutes * 60 * 1000) return 'offline';
    // ESP32 mengabarkan dirinya putus (Last Will, firmware v2): langsung offline
    const device = deviceList.find(d => d.craneId === crane.mqttId);
    if (device && device.online === false) return 'offline';
    if (!isValidTemp(gb.temp)) return 'fault';
    return AlarmRules.tempStatus(gb.temp, limits);
}

function getCraneSummary(crane) {
    if (!crane.installed) return { status: 'not-installed', offlineCount: 0, faultCount: 0 };

    const entries = crane.gearboxes.map(gb => ({ gb, status: getGearboxStatus(crane, gb) }));
    const live = entries.filter(e => LIVE_STATUSES.includes(e.status));
    const offlineCount = entries.filter(e => e.status === 'offline').length;
    const faultCount = entries.filter(e => e.status === 'fault').length;

    if (live.length > 0) {
        // Batas bisa beda per gearbox, jadi status crane = status terparah (bukan
        // sekadar status gearbox terpanas). Yang ditampilkan tetap gearbox terpanas.
        const worst = live.reduce((w, e) => LIVE_STATUSES.indexOf(e.status) > LIVE_STATUSES.indexOf(w) ? e.status : w, 'normal');
        const maxGb = live.reduce((max, e) => e.gb.temp > max.temp ? e.gb : max, live[0].gb);
        return { status: worst, maxGb, offlineCount, faultCount };
    }

    const lastSeenMs = Math.max(0, ...crane.gearboxes.map(gb => gb.lastUpdatedMs || 0)) || null;
    return { status: faultCount > 0 ? 'fault' : 'offline', offlineCount, faultCount, lastSeenMs };
}

function formatClock(ms) {
    const d = new Date(ms);
    const time = d.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' });
    if (d.toDateString() === new Date().toDateString()) return time;
    return d.toLocaleDateString('id-ID', { day: '2-digit', month: 'short' }) + ' ' + time;
}

function formatAgo(ms) {
    const sec = Math.max(0, Math.round((Date.now() - ms) / 1000));
    if (sec < 5) return 'baru saja';
    if (sec < 60) return `${sec} detik lalu`;
    const min = Math.floor(sec / 60);
    if (min < 60) return `${min} menit lalu`;
    const hr = Math.floor(min / 60);
    if (hr < 24) return `${hr} jam lalu`;
    return `${Math.floor(hr / 24)} hari lalu`;
}

function formatTemp(v) {
    return `${v.toFixed(1)} °C`;
}

function escapeHTML(value) {
    return String(value).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

function setStatValue(id, value) {
    const el = document.getElementById(id);
    if (el) el.innerText = value;
}

// ============================================================
// HYDRATE DARI state.json (hasil mqtt_logger.js)
// ============================================================
async function hydrateFromServerState() {
    let state;
    try {
        const res = await fetch('state.json', { cache: 'no-store' });
        if (!res.ok) return;
        state = await res.json();
    } catch (e) {
        console.warn('[Hydrate] Tidak bisa ambil state.json (logger mungkin belum pernah jalan):', e.message);
        return;
    }

    cranesData.forEach(crane => {
        if (!crane.installed) return;
        const craneState = state[crane.mqttId];
        if (!craneState) return;

        crane.gearboxes.forEach(gb => {
            const gbState = craneState[gb.key];
            if (!gbState) return;

            const lastUpdatedMs = Date.parse(gbState.lastUpdated);
            gb.rawValue = gbState.temp;
            gb.temp = parseFloat(gbState.temp);
            gb.lastUpdatedMs = isNaN(lastUpdatedMs) ? null : lastUpdatedMs;

            // Histori ditampilkan apa adanya (jam aslinya). Kalau datanya sudah lama,
            // gearbox otomatis berstatus "offline" dan kartunya menunjukkan kapan
            // data terakhir masuk - bukan dipoles seolah-olah data baru.
            gb.history = (Array.isArray(gbState.history) ? gbState.history : [])
                .filter(h => isValidTemp(h.temp))
                .slice(-MAX_HISTORY);
        });
    });

    console.log('[Hydrate] Data terakhir berhasil dimuat dari state.json');
}

// ============================================================
// RENDER
// ============================================================
function renderAccordion() {
    const container = document.getElementById('accordionContainer');
    if (!container) return;

    container.innerHTML = cranesData.map(craneItemHTML).join('');
    cranesData.forEach(updateCraneView);
    recomputeGlobalStats();
}

function craneItemHTML(crane) {
    const downloadBtn = crane.installed
        ? `<button class="btn-download-log" onclick="downloadCraneLog(${crane.id}, event)" title="Download log 7 hari (Excel)">
               <i class="fa-solid fa-download"></i>
           </button>`
        : '';
    const notice = crane.installed
        ? ''
        : `<div class="crane-notice">
               <i class="fa-solid fa-circle-info"></i>
               Sensor suhu untuk crane ini belum dipasang / belum diaktifkan. Data akan tampil otomatis
               setelah crane didaftarkan di sistem dan sensornya mulai mengirim data.
           </div>`;

    return `
        <div class="crane-item${crane.installed ? '' : ' crane-not-installed'}" id="crane-item-${crane.id}">
            <div class="crane-header" onclick="toggleCrane(${crane.id})">
                <div class="crane-title-area">
                    <div class="crane-icon"><i class="fa-solid fa-gears"></i></div>
                    <div>
                        <div class="crane-name">${crane.name}</div>
                        <div class="crane-sub"><i class="fa-solid fa-location-dot"></i> ${crane.location} • ${crane.gearboxes.length} Gearbox Motor</div>
                    </div>
                </div>
                <div class="crane-header-status">
                    <span class="crane-note" id="crane-note-${crane.id}"></span>
                    <div class="summary-temps" id="crane-summary-${crane.id}"></div>
                    <span class="status-badge" id="crane-status-${crane.id}"></span>
                    ${downloadBtn}
                    <i class="fa-solid fa-chevron-down toggle-icon"></i>
                </div>
            </div>
            <div class="crane-body">
                ${notice}
                <div class="gearbox-grid" id="gearbox-grid-${crane.id}">
                    ${crane.gearboxes.map(gb => gearboxCardHTML(crane, gb, '')).join('')}
                </div>
            </div>
        </div>
    `;
}

// prefix '' = kartu di accordion, 'ov-' = kartu di slide Overview
function gearboxCardHTML(crane, gb, prefix) {
    const id = `${prefix}${crane.id}-${gb.id}`;
    const sparepartHTML = gb.sparepart
        ? `<div class="gearbox-sparepart"><i class="fa-solid fa-barcode"></i> ${gb.sparepart}</div>`
        : '';
    return `
        <div class="gearbox-card" id="gb-card-${id}">
            <div class="gearbox-card-header">
                <span class="gearbox-name"><i class="fa-solid fa-gear"></i> ${gb.name}</span>
                <span class="status-badge" id="gb-status-${id}"></span>
            </div>
            ${sparepartHTML}
            <div class="temperature-display">
                <span class="temp-label" id="gb-label-${id}"></span>
                <span class="temp-value" id="gb-temp-${id}"></span>
            </div>
            <div class="gearbox-meta" id="gb-meta-${id}"></div>
            <div class="gearbox-limits" id="gb-limits-${id}"></div>
            <div class="chart-container">
                <canvas id="chart-${id}"></canvas>
                <div class="chart-placeholder" id="chart-ph-${id}"></div>
            </div>
        </div>
    `;
}

function updateGearboxView(crane, gb, prefix = '') {
    const id = `${prefix}${crane.id}-${gb.id}`;
    const card = document.getElementById(`gb-card-${id}`);
    if (!card) return;

    const status = getGearboxStatus(crane, gb);
    const meta = STATUS_META[status];
    card.className = `gearbox-card gb-${status} ${alarmCardClass(crane, gb)}`.trim();

    const badge = document.getElementById(`gb-status-${id}`);
    badge.className = `status-badge ${meta.class}`;
    badge.innerText = meta.label;

    let label = 'Suhu Real-Time';
    let value = '—';
    let info = '';
    if (status === 'not-installed') {
        label = 'Suhu';
    } else if (status === 'offline') {
        label = 'Suhu Terakhir';
        if (isValidTemp(gb.temp)) value = formatTemp(gb.temp);
        info = gb.lastUpdatedMs
            ? `<i class="fa-solid fa-plug-circle-xmark"></i> Tidak ada data sejak ${formatClock(gb.lastUpdatedMs)} (${formatAgo(gb.lastUpdatedMs)})`
            : `<i class="fa-solid fa-plug-circle-xmark"></i> Belum ada data dari sensor`;
    } else if (status === 'fault') {
        value = 'ERR';
        info = gb.faultCode
            ? `<i class="fa-solid fa-triangle-exclamation"></i> Fault MAX31865 ${escapeHTML(gb.faultCode)} - cek kabel PT100`
            : `<i class="fa-solid fa-triangle-exclamation"></i> Nilai sensor tidak valid: ${escapeHTML(gb.rawValue)}`;
    } else {
        value = formatTemp(gb.temp);
        info = `<i class="fa-solid fa-circle-dot"></i> Update terakhir ${formatAgo(gb.lastUpdatedMs)}`;
    }
    document.getElementById(`gb-label-${id}`).innerHTML = `<i class="fa-solid fa-thermometer-half"></i> ${label}`;
    document.getElementById(`gb-temp-${id}`).innerText = value;
    document.getElementById(`gb-meta-${id}`).innerHTML = info;

    // Batas gearbox ini (bisa beda per gearbox, diatur di halaman Pengaturan)
    const limits = getLimits(crane, gb);
    document.getElementById(`gb-limits-${id}`).innerHTML = status === 'not-installed' ? '' :
        `<span title="Di bawah ini: alarm suhu rendah">Min ${limits.low}</span>` +
        `<span title="Rentang kerja normal">Normal ≤ ${limits.warning}</span>` +
        `<span title="Di atas ini: Danger">Max ${limits.danger} °C</span>`;

    let placeholder = '';
    if (status === 'not-installed') placeholder = '<i class="fa-solid fa-ban"></i> Sensor belum terpasang';
    else if (gb.history.length === 0) placeholder = '<i class="fa-solid fa-hourglass-half"></i> Menunggu data sensor...';
    const ph = document.getElementById(`chart-ph-${id}`);
    ph.innerHTML = placeholder;
    ph.style.display = placeholder ? 'flex' : 'none';

    // Chart di accordion baru dibuat saat crane dibuka (canvas di elemen tersembunyi
    // ukurannya 0). Chart overview selalu terlihat, jadi boleh langsung dibuat.
    const store = prefix ? overviewCharts : charts;
    const allowCreate = prefix ? true : crane.isOpen;
    syncChart(store, id, gb, meta.color, allowCreate, limits);
}

// Skala grafik mengikuti batas gearbox (Min .. Max) supaya perubahan suhu terlihat
// jelas; kalau suhunya keluar dari rentang itu, skala ikut melebar.
function chartScale(limits) {
    return { suggestedMin: limits.low - 5, suggestedMax: limits.danger + 10 };
}

function syncChart(store, key, gb, color, allowCreate, limits) {
    const canvas = document.getElementById(`chart-${key}`);
    let chart = store[key];
    if (chart && chart.canvas !== canvas) {
        chart.destroy();
        delete store[key];
        chart = null;
    }
    if (!canvas) return;

    if (gb.history.length === 0) {
        if (chart) {
            chart.destroy();
            delete store[key];
        }
        return;
    }

    const labels = gb.history.map(h => h.time);
    const data = gb.history.map(h => h.temp);

    if (!chart) {
        if (!allowCreate) return;
        store[key] = new Chart(canvas.getContext('2d'), {
            type: 'line',
            data: {
                labels: labels,
                datasets: [{
                    data: data,
                    borderColor: color,
                    backgroundColor: color + '20',
                    borderWidth: 2,
                    fill: true,
                    tension: 0.3,
                    pointRadius: 2
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: { legend: { display: false } },
                scales: {
                    x: { grid: { color: '#1e293b' }, ticks: { color: '#f8fafc', font: { size: 9 } } },
                    y: { grid: { color: '#1e293b' }, ticks: { color: '#f8fafc', font: { size: 8 } }, ...chartScale(limits) }
                }
            }
        });
        return;
    }

    chart.data.labels = labels;
    const ds = chart.data.datasets[0];
    ds.data = data;
    ds.borderColor = color;
    ds.backgroundColor = color + '20';
    Object.assign(chart.options.scales.y, chartScale(limits));
    chart.update('none');
}

function updateCraneView(crane) {
    const summary = getCraneSummary(crane);
    const meta = STATUS_META[summary.status];

    const badge = document.getElementById(`crane-status-${crane.id}`);
    if (badge) {
        badge.className = `status-badge ${meta.class}`;
        badge.innerText = meta.label;
    }

    let summaryHTML;
    if (summary.status === 'not-installed') {
        summaryHTML = '<i class="fa-solid fa-ban"></i> Sensor belum terpasang';
    } else if (summary.status === 'offline') {
        summaryHTML = summary.lastSeenMs
            ? `<i class="fa-solid fa-plug-circle-xmark"></i> Tidak ada data sejak <strong>${formatClock(summary.lastSeenMs)}</strong>`
            : '<i class="fa-solid fa-plug-circle-xmark"></i> Belum ada data dari sensor';
    } else if (summary.status === 'fault') {
        summaryHTML = '<i class="fa-solid fa-triangle-exclamation"></i> Sensor error';
    } else {
        summaryHTML = `<i class="fa-solid fa-fire-flame-curved"></i> Max Suhu: <strong>${summary.maxGb.name} (${formatTemp(summary.maxGb.temp)})</strong>`;
    }
    const summaryElem = document.getElementById(`crane-summary-${crane.id}`);
    if (summaryElem) summaryElem.innerHTML = summaryHTML;

    // Crane yang sebagian gearbox-nya live tapi sisanya bermasalah: tetap dinilai dari
    // yang live, tapi masalahnya ditampilkan supaya tidak terlewat.
    const notes = [];
    if (LIVE_STATUSES.includes(summary.status)) {
        if (summary.offlineCount) notes.push(`${summary.offlineCount} GB offline`);
        if (summary.faultCount) notes.push(`${summary.faultCount} sensor error`);
    }
    const noteElem = document.getElementById(`crane-note-${crane.id}`);
    if (noteElem) {
        noteElem.innerHTML = notes.length ? `<i class="fa-solid fa-triangle-exclamation"></i> ${notes.join(' · ')}` : '';
        noteElem.style.display = notes.length ? '' : 'none';
    }

    crane.gearboxes.forEach(gb => updateGearboxView(crane, gb));
}

function recomputeGlobalStats() {
    const counts = { 'normal': 0, 'warning': 0, 'danger': 0, 'offline': 0, 'not-installed': 0 };
    cranesData.forEach(crane => counts[statusGroup(getCraneSummary(crane).status)]++);

    setStatValue('stat-total', cranesData.length);
    setStatValue('ov-stat-total', cranesData.length);
    Object.entries(counts).forEach(([key, value]) => {
        setStatValue(`stat-${key}`, value);
        setStatValue(`ov-stat-${key}`, value);
    });

    applyCombinedFilter();
}

function refreshAllViews() {
    cranesData.forEach(updateCraneView);
    recomputeGlobalStats();
    refreshOverviewSlide();
}

function toggleCrane(craneId) {
    const craneItem = document.getElementById(`crane-item-${craneId}`);
    const crane = cranesData.find(c => c.id === craneId);
    if (!craneItem || !crane) return;

    craneItem.classList.toggle('open');
    crane.isOpen = craneItem.classList.contains('open');

    if (crane.isOpen) {
        setTimeout(() => crane.gearboxes.forEach(gb => updateGearboxView(crane, gb)), 50);
    }
}

// Nilai suhu di kartu diperbarui begitu pesan MQTT masuk; titik chart dicatat
// 1x per menit (nilai terakhir). Status offline dicek ulang tiap STATUS_REFRESH_MS
// supaya sensor yang berhenti mengirim segera kelihatan.
function startLiveTimers() {
    function recordMinutePoint() {
        const timeLabel = new Date().toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' });

        cranesData.forEach(crane => {
            crane.gearboxes.forEach(gb => {
                if (!LIVE_STATUSES.includes(getGearboxStatus(crane, gb))) return;
                gb.history.push({ time: timeLabel, temp: parseFloat(gb.temp.toFixed(1)) });
                if (gb.history.length > MAX_HISTORY) gb.history.shift();
            });
        });

        refreshAllViews();
    }

    const msUntilNextMinute = 60000 - (Date.now() % 60000);
    setTimeout(() => {
        recordMinutePoint();
        setInterval(recordMinutePoint, 60000);
    }, msUntilNextMinute);

    setInterval(refreshAllViews, STATUS_REFRESH_MS);
}

// ============================================================
// MQTT
// ============================================================

// Broker Mosquitto jalan di PC yang sama dengan server dashboard, jadi alamatnya
// ikut host yang dibuka di browser: buka http://<ip-pc>:8080 -> broker
// ws://<ip-pc>:9001 (port dari mqtt-config.json). Tidak perlu ganti kode kalau IP berubah.
const MQTT_TOPIC_SUB  = "pabrik/+/+/temp";

let mqttClient = null;

// Indikator koneksi broker di header - buat membedakan "semua offline karena
// broker putus" dengan "sensor di crane tertentu yang mati".
function setConnectionStatus(state, text) {
    const el = document.getElementById('mqttConnStatus');
    if (!el) return;
    el.className = `conn-pill conn-${state}`;
    el.innerHTML = `<i class="fa-solid fa-circle"></i> ${text}`;
}

// Akun MQTT dashboard (baca-saja) diambil dari server.js, bukan ditulis di kode ini.
// Kalau server belum di-setup login-nya, hasilnya {} dan dashboard konek tanpa login.
async function loadMqttCredentials() {
    try {
        const res = await fetch('mqtt-config.json', { cache: 'no-store' });
        if (res.ok) return await res.json();
    } catch (e) { /* dibuka tanpa server.js */ }
    return {};
}

async function connectMQTT() {
    if (typeof mqtt === 'undefined') {
        console.error('[MQTT] Library mqtt.js belum termuat. Cek tag <script> di HTML.');
        setConnectionStatus('down', 'Library MQTT gagal dimuat');
        return;
    }

    setConnectionStatus('connecting', 'Menghubungkan ke broker...');
    const { wsPort, ...credentials } = await loadMqttCredentials();
    const brokerUrl = `ws://${window.location.hostname || 'localhost'}:${wsPort || 9001}`;
    let loginRejected = false;

    mqttClient = mqtt.connect(brokerUrl, {
        clientId: 'dashboard-' + Math.random().toString(16).slice(2, 8),
        reconnectPeriod: 3000,
        ...credentials
    });

    mqttClient.on('connect', () => {
        loginRejected = false;
        console.log('[MQTT] Terhubung ke broker:', brokerUrl);
        setConnectionStatus('up', 'Broker terhubung');
        mqttClient.subscribe(MQTT_TOPIC_SUB, (err) => {
            if (err) console.error('[MQTT] Gagal subscribe:', err);
            else console.log('[MQTT] Subscribe topik:', MQTT_TOPIC_SUB);
        });
    });

    mqttClient.on('reconnect', () => {
        console.log('[MQTT] Reconnecting...');
        setConnectionStatus('connecting', 'Menghubungkan ulang ke broker...');
    });
    mqttClient.on('close', () => {
        setConnectionStatus('down', loginRejected ? 'Login broker ditolak' : 'Broker terputus');
    });
    mqttClient.on('error', (err) => {
        // 4/5 = MQTT 3.1.1, 134/135 = MQTT 5: username/password salah atau tidak diizinkan
        if ([4, 5, 134, 135].includes(err.code)) loginRejected = true;
        console.error('[MQTT] Connection error:', err);
    });

    mqttClient.on('message', (topic, payloadBuffer) => {
        let data;
        try {
            data = JSON.parse(payloadBuffer.toString());
        } catch (e) {
            console.error('[MQTT] Payload bukan JSON valid dari topik', topic, payloadBuffer.toString());
            return;
        }
        // crane_id di payload harus sama dengan crane di topik (pabrik/<area>/<crane-id>/temp),
        // karena broker cuma menjamin tiap ESP32 kirim ke topik crane-nya sendiri.
        if (data.crane_id !== topic.split('/')[2]) {
            console.warn('[MQTT] crane_id tidak cocok dengan topik, diabaikan:', topic, data.crane_id);
            return;
        }
        handleMqttTemperature(data);
    });
}

function handleMqttTemperature(data) {
    // Crane yang belum diaktifkan diabaikan di sini - server yang mencatatnya
    // sebagai "perangkat baru terdeteksi" (lihat renderDeviceNotice).
    const crane = cranesData.find(c => c.mqttId === data.crane_id && c.installed);
    if (!crane) return;

    Object.entries(data.temps || {}).forEach(([gbKey, tempValue]) => {
        const gb = crane.gearboxes.find(g => g.key === gbKey);
        if (!gb) return; // gearbox belum terdaftar di Pengaturan

        gb.rawValue = tempValue;
        // kode fault MAX31865 dari firmware v2 (mis. "0x80"), null kalau sensor normal
        gb.faultCode = data.faults && typeof data.faults[gbKey] === 'string' ? data.faults[gbKey] : null;
        gb.temp = parseFloat(tempValue);
        // Pakai jam TERIMA (bukan data.timestamp dari ESP32) untuk menilai "masih hidup":
        // yang dicek di sini adalah apakah sensornya masih mengirim sekarang.
        gb.lastUpdatedMs = Date.now();
    });

    updateCraneView(crane);
    recomputeGlobalStats();
    if (overviewCraneId === crane.id) refreshOverviewSlide();
}

// ============================================================
// FILTER & SEARCH
// ============================================================
function applyCombinedFilter() {
    const query = document.getElementById('searchInput') ? document.getElementById('searchInput').value.toLowerCase().trim() : '';

    cranesData.forEach(crane => {
        const elem = document.getElementById(`crane-item-${crane.id}`);
        if (!elem) return;

        const craneGroup = statusGroup(getCraneSummary(crane).status);
        const matchSearch = crane.name.toLowerCase().includes(query) || crane.location.toLowerCase().includes(query);
        const matchStatus = (currentStatusFilter === 'all') || (craneGroup === currentStatusFilter);

        elem.style.display = (matchSearch && matchStatus) ? "block" : "none";
    });
}

function filterByStatus(status) {
    if (currentStatusFilter === status) {
        currentStatusFilter = 'all';
    } else {
        currentStatusFilter = status;
    }

    document.querySelectorAll('[data-status]').forEach(card => card.classList.remove('active'));
    document.querySelectorAll(`[data-status="${currentStatusFilter}"]`).forEach(card => card.classList.add('active'));

    applyCombinedFilter();

    const overlay = document.getElementById('overviewModalOverlay');
    if (overlay && overlay.classList.contains('active')) {
        overviewIndex = 0;
        renderOverviewSlide();
        startAutoSlide();
    }
}

function filterCranes() {
    applyCombinedFilter();
}

// Download log 7 hari terakhir dalam format Excel (ringkasan per menit), diambil
// dari file yang dibuat mqtt_logger.js lewat excel_export.js (folder
// excel/<mqttId>.xlsx, diperbarui tiap 10 menit) - bukan cuma 8 titik terakhir
// yang ada di memori browser. Kalau crane belum pernah dapat data sama sekali,
// file Excel-nya belum ada.
function downloadCraneLog(craneId, event) {
    if (event) event.stopPropagation();

    const crane = cranesData.find(c => c.id === craneId);
    if (!crane || !crane.installed) {
        alert('Crane ini belum terpasang sensor, jadi belum ada log yang bisa diunduh.');
        return;
    }

    const excelUrl = `excel/${crane.mqttId}.xlsx`;

    // Cek dulu file-nya beneran ada sebelum trigger download (biar nggak dapat
    // file kosong/404 kalau logger belum sempat generate untuk crane ini)
    fetch(excelUrl, { method: 'HEAD', cache: 'no-store' })
        .then(res => {
            if (!res.ok) {
                alert(`Belum ada file log untuk ${crane.name}. File Excel dibuat otomatis oleh mqtt_logger.js paling lambat 10 menit setelah data crane ini mulai masuk.`);
                return;
            }
            const today = new Date().toLocaleDateString('en-CA'); // YYYY-MM-DD
            const a = document.createElement('a');
            a.href = `${excelUrl}?t=${Date.now()}`; // hindari file versi lama dari cache browser
            a.download = `${crane.mqttId}_log-7-hari_${today}.xlsx`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
        })
        .catch(() => {
            alert('Gagal menghubungi server dashboard untuk mengambil file Excel.');
        });
}

// ============================================================
// OVERVIEW (slide fullscreen untuk layar monitor)
// ============================================================
let overviewIndex = 0;
let overviewCraneId = null; // crane yang sedang tampil di slide
let autoSlideTimer = null;

function openOverviewModal() {
    if (cranesData.length === 0) return;
    overviewIndex = 0;
    renderOverviewSlide();

    const overlay = document.getElementById('overviewModalOverlay');
    overlay.classList.add('active');
    mountAlarmUi(overlay);

    const requestFS = overlay.requestFullscreen || overlay.webkitRequestFullscreen || overlay.msRequestFullscreen;
    if (requestFS) {
        requestFS.call(overlay).catch(() => {});
    }

    startAutoSlide();
}

function hideOverview() {
    document.getElementById('overviewModalOverlay').classList.remove('active');
    mountAlarmUi(document.body);
    stopAutoSlide();
    destroyOverviewCharts();
    overviewCraneId = null;
}

function closeOverviewModal() {
    hideOverview();

    if (document.fullscreenElement) {
        document.exitFullscreen();
    } else if (document.webkitFullscreenElement) {
        document.webkitExitFullscreen();
    }
}

function startAutoSlide() {
    stopAutoSlide();
    autoSlideTimer = setInterval(nextOverviewSlide, 15000);
}

function stopAutoSlide() {
    if (autoSlideTimer) {
        clearInterval(autoSlideTimer);
        autoSlideTimer = null;
    }
}

document.addEventListener('fullscreenchange', () => {
    if (!document.fullscreenElement) {
        const overlay = document.getElementById('overviewModalOverlay');
        if (overlay && overlay.classList.contains('active')) hideOverview();
    }
});

function destroyOverviewCharts() {
    Object.keys(overviewCharts).forEach(key => {
        overviewCharts[key].destroy();
        delete overviewCharts[key];
    });
}

// Filter "semua" di overview hanya memutar crane yang sudah terpasang sensor -
// crane "belum terpasang" baru ikut tampil kalau filternya dipilih khusus.
function getOverviewCraneList() {
    return cranesData.filter(crane => {
        const group = statusGroup(getCraneSummary(crane).status);
        if (currentStatusFilter === 'all') return group !== 'not-installed';
        return group === currentStatusFilter;
    });
}

function renderOverviewSlide() {
    const list = getOverviewCraneList();
    const body = document.getElementById('overviewModalBody');
    const indicator = document.getElementById('overviewIndicator');
    if (!body) return;

    destroyOverviewCharts();

    if (list.length === 0) {
        overviewCraneId = null;
        indicator.innerText = '0 / 0';
        const message = currentStatusFilter === 'all'
            ? 'Belum ada crane yang terpasang sensor.'
            : `Tidak ada crane dengan status "${STATUS_META[currentStatusFilter].label}" saat ini.`;
        body.innerHTML = `
            <div style="text-align:center; padding: 60px 20px; color:#94a3b8;">
                <i class="fa-solid fa-circle-check" style="font-size:2rem; margin-bottom:12px; display:block;"></i>
                ${message}
            </div>
        `;
        return;
    }

    if (overviewIndex >= list.length) overviewIndex = 0;
    const crane = list[overviewIndex];
    overviewCraneId = crane.id;

    indicator.innerText = `${overviewIndex + 1} / ${list.length}`;

    body.innerHTML = `
        <div class="overview-crane-title">
            <h3>${crane.name} <span class="status-badge" id="ov-crane-status"></span></h3>
            <p><i class="fa-solid fa-location-dot"></i> ${crane.location}</p>
        </div>
        <div class="overview-gearbox-grid">
            ${crane.gearboxes.map(gb => gearboxCardHTML(crane, gb, 'ov-')).join('')}
        </div>
    `;

    refreshOverviewSlide();
}

function refreshOverviewSlide() {
    if (overviewCraneId === null) return;
    const crane = cranesData.find(c => c.id === overviewCraneId);
    if (!crane) return;

    const meta = STATUS_META[getCraneSummary(crane).status];
    const badge = document.getElementById('ov-crane-status');
    if (badge) {
        badge.className = `status-badge ${meta.class}`;
        badge.innerText = meta.label;
    }
    crane.gearboxes.forEach(gb => updateGearboxView(crane, gb, 'ov-'));
}

function nextOverviewSlide() {
    const list = getOverviewCraneList();
    if (list.length === 0) return;
    overviewIndex = (overviewIndex + 1) % list.length;
    renderOverviewSlide();
}

function prevOverviewSlide() {
    const list = getOverviewCraneList();
    if (list.length === 0) return;
    overviewIndex = (overviewIndex - 1 + list.length) % list.length;
    renderOverviewSlide();
}

// ============================================================
// ALARM (notifikasi di web app)
// ============================================================
// Alarm dinilai di SERVER (alarm_engine.js di server.js) lalu dikirim ke sini
// lewat Server-Sent Events. Dashboard hanya menampilkan, membunyikan, memunculkan
// notifikasi desktop, dan mengirim ack - jadi semua layar melihat alarm yang sama.
let alarmState = { active: [], history: [] };
let alarmStreamOk = false;
let firstAlarmSnapshot = true;
let alarmPanelTab = 'active';
const notifiedAlarms = new Set(); // "id|raisedAt" yang sudah dibunyikan/dinotifikasi

const ALARM_TYPE_LABEL = { temp: 'Suhu tinggi', low: 'Suhu rendah', rise: 'Kenaikan cepat', fault: 'Sensor error', offline: 'Sensor offline' };
const ALARM_EVENT_LABEL = { raised: 'Muncul', escalated: 'Naik ke danger', acked: 'Di-ack', cleared: 'Selesai' };

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

function setPill(id, state, text) {
    const el = document.getElementById(id);
    if (!el) return;
    el.className = `conn-pill conn-${state}`;
    el.innerHTML = `<i class="fa-solid fa-circle"></i> ${text}`;
}

function connectAlarmStream() {
    setPill('alarmConnStatus', 'connecting', 'Menghubungkan ke server alarm...');
    const es = new EventSource('api/stream');
    es.addEventListener('settings', e => applySettings(JSON.parse(e.data)));
    es.addEventListener('devices', e => {
        deviceList = JSON.parse(e.data);
        renderDeviceNotice();
        refreshAllViews(); // status online/offline ESP32 ikut menentukan status gearbox
    });
    es.addEventListener('alarms', e => {
        alarmStreamOk = true;
        setPill('alarmConnStatus', 'up', 'Server alarm terhubung');
        alarmState = JSON.parse(e.data);
        onAlarmsChanged();
    });
    // EventSource menyambung ulang sendiri; selama putus, alarm TIDAK bisa diterima
    es.onerror = () => {
        alarmStreamOk = false;
        setPill('alarmConnStatus', 'down', 'Server alarm terputus');
        renderAlarmIndicators();
    };
}

function unackedAlarms() {
    return alarmState.active.filter(a => !a.ackedAt);
}

function alarmNames(alarm) {
    const crane = cranesData.find(c => c.mqttId === alarm.craneId);
    const gb = crane && crane.gearboxes.find(g => g.key === alarm.gbKey);
    return { crane, craneName: crane ? crane.name : alarm.craneId, gbName: gb ? gb.name : alarm.gbKey };
}

function describeAlarm(a) {
    switch (a.type) {
        case 'temp': return `Suhu ${formatTemp(a.value)} melewati ${a.severity === 'danger' ? 'Max' : 'batas atas normal'} (${a.limit} °C)`;
        case 'low': return `Suhu ${formatTemp(a.value)} di bawah Min (${a.limit} °C) - cek sensor lepas / terlalu dingin`;
        case 'rise': return `Suhu naik ${Number(a.value).toFixed(1)} °C dalam ${a.windowMinutes} menit terakhir (batas ${a.limit} °C)`;
        case 'fault': return a.code
            ? `Sensor fault MAX31865 (kode ${a.code}) - cek kabel PT100 / modul MAX31865`
            : `Nilai sensor tidak valid: ${a.value}`;
        case 'offline': return a.reason === 'lwt'
            ? `ESP32 terputus dari broker (data terakhir ${formatClock(a.lastSeen)})`
            : `Tidak ada data sejak ${formatClock(a.lastSeen)}`;
        default: return a.type;
    }
}

function formatDuration(ms) {
    const min = Math.round(ms / 60000);
    if (min < 1) return '< 1 menit';
    if (min < 60) return `${min} menit`;
    return `${Math.floor(min / 60)} jam ${min % 60} menit`;
}

function alarmCardClass(crane, gb) {
    const list = alarmState.active.filter(a => a.craneId === crane.mqttId && a.gbKey === gb.key);
    if (list.some(a => !a.ackedAt)) return 'gb-alarm-unacked';
    return list.length ? 'gb-alarm-acked' : '';
}

function applyAlarmCardClasses() {
    cranesData.forEach(crane => crane.gearboxes.forEach(gb => {
        const cls = alarmCardClass(crane, gb);
        ['', 'ov-'].forEach(prefix => {
            const card = document.getElementById(`gb-card-${prefix}${crane.id}-${gb.id}`);
            if (!card) return;
            card.classList.remove('gb-alarm-unacked', 'gb-alarm-acked');
            if (cls) card.classList.add(cls);
        });
    }));
}

function onAlarmsChanged() {
    // Bunyi + notifikasi desktop hanya untuk alarm yang BARU muncul / naik tingkat
    // setelah halaman dibuka. Alarm lama yang belum di-ack tetap dibunyikan berkala.
    unackedAlarms().forEach(a => {
        const key = `${a.id}|${a.raisedAt}`;
        if (notifiedAlarms.has(key)) return;
        notifiedAlarms.add(key);
        if (!firstAlarmSnapshot) {
            showDesktopNotification(a);
            playAlarmSound(a.severity);
        }
    });
    firstAlarmSnapshot = false;

    renderAlarmIndicators();
    applyAlarmCardClasses();
    if (document.getElementById('alarmPanelOverlay').classList.contains('active')) renderAlarmPanel();
}

function renderAlarmIndicators() {
    const unacked = unackedAlarms();
    setStatValue('stat-alarm', alarmState.active.length);
    const statCard = document.getElementById('alarmStatCard');
    if (statCard) {
        statCard.classList.toggle('alarm-flash', unacked.length > 0);
        statCard.classList.toggle('alarm-danger', unacked.some(a => a.severity === 'danger'));
    }

    const banner = document.getElementById('alarmBanner');
    if (unacked.length === 0) {
        banner.classList.remove('active');
        document.body.classList.remove('has-alarm-banner');
        return;
    }

    const top = unacked[0]; // server sudah mengurutkan: belum di-ack, danger, terbaru
    const { craneName, gbName } = alarmNames(top);
    banner.className = `alarm-banner active alarm-${top.severity}`;
    banner.dataset.alarmId = top.id;
    document.body.classList.add('has-alarm-banner');
    document.getElementById('alarmBannerText').innerHTML =
        `<strong>${escapeHTML(ALARM_TYPE_LABEL[top.type] || top.type)} · ${escapeHTML(gbName)}</strong>` +
        `<span class="alarm-banner-crane">${escapeHTML(craneName)}</span>` +
        `<span>${escapeHTML(describeAlarm(top))}</span>` +
        (unacked.length > 1 ? `<span class="alarm-more">+${unacked.length - 1} alarm lain belum di-ack</span>` : '');
    document.getElementById('alarmBannerSound').style.display = soundBlocked() ? '' : 'none';
    updateBannerSpace();
}

// Tinggi banner berubah-ubah (isi teks, lebar layar) - halaman digeser sejauh itu
function updateBannerSpace() {
    const banner = document.getElementById('alarmBanner');
    document.documentElement.style.setProperty('--alarm-banner-h', `${banner.offsetHeight}px`);
}
window.addEventListener('resize', updateBannerSpace);

// ---------- panel alarm ----------
function openAlarmPanel() {
    document.getElementById('operatorName').value = storageGet('operatorName', '');
    document.getElementById('alarmPanelOverlay').classList.add('active');
    renderAlarmPanel();
}

function closeAlarmPanel() {
    document.getElementById('alarmPanelOverlay').classList.remove('active');
}

function setAlarmTab(tab) {
    alarmPanelTab = tab;
    renderAlarmPanel();
}

function setOperatorName(name) {
    storageSet('operatorName', name.trim());
}

function renderAlarmPanel() {
    document.querySelectorAll('.alarm-tab').forEach(btn => btn.classList.toggle('active', btn.dataset.tab === alarmPanelTab));
    document.getElementById('alarmTabActiveCount').innerText = alarmState.active.length;
    renderAlarmSettings();

    const list = document.getElementById('alarmList');
    if (!alarmStreamOk) {
        list.innerHTML = '<div class="alarm-empty"><i class="fa-solid fa-plug-circle-xmark"></i> Server alarm tidak terhubung - alarm tidak bisa ditampilkan. Pastikan server.js (npm run service) jalan.</div>';
        return;
    }

    if (alarmPanelTab === 'active') {
        if (alarmState.active.length === 0) {
            list.innerHTML = '<div class="alarm-empty"><i class="fa-solid fa-circle-check"></i> Tidak ada alarm aktif.</div>';
            return;
        }
        list.innerHTML = alarmState.active.map(a => {
            const { craneName, gbName } = alarmNames(a);
            const ackInfo = a.ackedAt
                ? `<span class="alarm-acked-label"><i class="fa-solid fa-check"></i> Di-ack ${escapeHTML(a.ackedBy)} · ${formatClock(a.ackedAt)}</span>`
                : `<button class="alarm-ack-btn" data-id="${escapeHTML(a.id)}" onclick="ackAlarm(this.dataset.id)"><i class="fa-solid fa-check"></i> Ack</button>`;
            return `
                <div class="alarm-item alarm-${a.severity}${a.ackedAt ? ' acked' : ''}">
                    <div class="alarm-item-main">
                        <div class="alarm-item-title">
                            <span class="status-badge status-${a.severity}">${a.severity}</span>
                            ${escapeHTML(ALARM_TYPE_LABEL[a.type] || a.type)} · ${escapeHTML(gbName)}
                        </div>
                        <div class="alarm-item-crane"><a href="#" data-crane="${escapeHTML(a.craneId)}" onclick="goToCrane(this.dataset.crane); return false;">${escapeHTML(craneName)}</a></div>
                        <div class="alarm-item-desc">${escapeHTML(describeAlarm(a))}</div>
                        <div class="alarm-item-time">Muncul ${formatClock(a.raisedAt)} (${formatAgo(a.raisedAt)})</div>
                    </div>
                    ${ackInfo}
                </div>`;
        }).join('');
        return;
    }

    if (alarmState.history.length === 0) {
        list.innerHTML = '<div class="alarm-empty">Belum ada riwayat alarm.</div>';
        return;
    }
    list.innerHTML = alarmState.history.map(h => {
        const { craneName, gbName } = alarmNames(h.alarm);
        const extra = h.event === 'acked' ? ` oleh ${escapeHTML(h.by)}`
            : h.event === 'cleared' && h.durationMs !== undefined ? ` setelah ${formatDuration(h.durationMs)}` : '';
        return `
            <div class="alarm-history-item">
                <span class="alarm-history-time">${formatClock(h.at)}</span>
                <span class="alarm-history-event event-${h.event}">${ALARM_EVENT_LABEL[h.event] || h.event}${extra}</span>
                <span class="alarm-history-what">
                    <span class="status-badge status-${h.alarm.severity}">${h.alarm.severity}</span>
                    ${escapeHTML(ALARM_TYPE_LABEL[h.alarm.type] || h.alarm.type)} · ${escapeHTML(gbName)} · ${escapeHTML(craneName)}
                    <small>${escapeHTML(describeAlarm(h.alarm))}</small>
                </span>
            </div>`;
    }).join('');
}

function renderAlarmSettings() {
    const soundBtn = document.getElementById('soundToggleBtn');
    soundBtn.innerHTML = soundEnabled()
        ? '<i class="fa-solid fa-volume-high"></i> Bunyi: aktif'
        : '<i class="fa-solid fa-volume-xmark"></i> Bunyi: mati';
    soundBtn.classList.toggle('off', !soundEnabled());

    const notifBtn = document.getElementById('desktopNotifBtn');
    if (!desktopNotifSupported()) {
        notifBtn.innerHTML = '<i class="fa-solid fa-bell-slash"></i> Notifikasi desktop tidak tersedia';
        notifBtn.title = 'Browser hanya mengizinkan notifikasi desktop di http://localhost atau HTTPS.';
        notifBtn.classList.add('off');
    } else if (Notification.permission === 'granted') {
        notifBtn.innerHTML = '<i class="fa-solid fa-bell"></i> Notifikasi desktop: aktif';
        notifBtn.classList.remove('off');
    } else if (Notification.permission === 'denied') {
        notifBtn.innerHTML = '<i class="fa-solid fa-bell-slash"></i> Notifikasi diblokir browser';
        notifBtn.title = 'Izinkan lewat ikon gembok di address bar browser.';
        notifBtn.classList.add('off');
    } else {
        notifBtn.innerHTML = '<i class="fa-regular fa-bell"></i> Aktifkan notifikasi desktop';
        notifBtn.classList.add('off');
    }
}

function goToCrane(mqttId) {
    const crane = cranesData.find(c => c.mqttId === mqttId);
    closeAlarmPanel();
    if (!crane) return;
    if (document.getElementById('overviewModalOverlay').classList.contains('active')) closeOverviewModal();
    if (currentStatusFilter !== 'all') filterByStatus('all');
    if (!crane.isOpen) toggleCrane(crane.id);
    document.getElementById(`crane-item-${crane.id}`).scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// Tombol "Lihat" di banner: saat mode Overview (TV) langsung pindah ke slide
// crane-nya, selain itu buka panel alarm.
function viewBannerAlarm() {
    const alarm = alarmState.active.find(a => a.id === document.getElementById('alarmBanner').dataset.alarmId);
    if (alarm && document.getElementById('overviewModalOverlay').classList.contains('active')) {
        const idx = getOverviewCraneList().findIndex(c => c.mqttId === alarm.craneId);
        if (idx >= 0) {
            overviewIndex = idx;
            renderOverviewSlide();
            startAutoSlide();
            return;
        }
    }
    openAlarmPanel();
}

function ackBannerAlarm() {
    ackAlarm(document.getElementById('alarmBanner').dataset.alarmId);
}

async function ackAlarm(id) {
    // Nama operator wajib (tercatat di riwayat). Sengaja tidak pakai prompt(): sering
    // diblokir di mode kiosk / fullscreen. Kalau belum diisi, buka panel & minta diisi.
    const input = document.getElementById('operatorName');
    const typed = input && input.value.trim();
    if (typed) setOperatorName(typed);
    const name = typed || storageGet('operatorName', '');
    if (!name) {
        openAlarmPanel();
        input.classList.add('needs-input');
        input.placeholder = 'Isi nama operator dulu, lalu klik Ack lagi';
        input.focus();
        return;
    }
    if (input) input.classList.remove('needs-input');
    try {
        const res = await fetch('api/alarms/ack', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id, by: name })
        });
        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            alert(err.error || 'Gagal ack alarm.');
        }
        // Status baru datang sendiri lewat stream alarm
    } catch (e) {
        alert('Server alarm tidak bisa dihubungi.');
    }
}

// ---------- bunyi ----------
// Browser baru mengizinkan suara setelah ada klik/ketikan di halaman. Selama
// belum, banner menampilkan petunjuk "klik di mana saja".
let audioCtx = null;

function soundEnabled() {
    return storageGet('alarmSound', 'on') === 'on';
}

function soundBlocked() {
    return soundEnabled() && (!audioCtx || audioCtx.state !== 'running');
}

function toggleSound() {
    storageSet('alarmSound', soundEnabled() ? 'off' : 'on');
    unlockAudio();
    renderAlarmSettings();
    renderAlarmIndicators();
}

function unlockAudio() {
    try {
        if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        if (audioCtx.state === 'suspended') audioCtx.resume().then(renderAlarmIndicators);
    } catch (e) { /* browser tanpa Web Audio */ }
}
document.addEventListener('pointerdown', unlockAudio);
document.addEventListener('keydown', unlockAudio);

function beep(freq, offset, duration) {
    const t = audioCtx.currentTime + offset;
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = 'square';
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(0.2, t + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + duration);
    osc.connect(gain).connect(audioCtx.destination);
    osc.start(t);
    osc.stop(t + duration + 0.05);
}

function playAlarmSound(severity) {
    if (!soundEnabled() || !audioCtx || audioCtx.state !== 'running') return;
    if (severity === 'danger') [0, 0.25, 0.5].forEach(o => beep(880, o, 0.18)); // tiga bip cepat
    else beep(660, 0, 0.35);                                                    // satu bip
}

// Selama masih ada alarm yang belum di-ack, bunyi diulang tiap 5 detik
setInterval(() => {
    const unacked = unackedAlarms();
    if (unacked.length) playAlarmSound(unacked.some(a => a.severity === 'danger') ? 'danger' : 'warning');
}, 5000);

// ---------- notifikasi desktop ----------
// Browser hanya mengizinkan ini di "secure context": http://localhost atau HTTPS.
// Dari PC lain lewat http://<ip>:8080 tidak tersedia - bunyi & banner tetap jalan.
function desktopNotifSupported() {
    return 'Notification' in window && window.isSecureContext;
}

async function enableDesktopNotifications() {
    if (!desktopNotifSupported()) {
        alert('Notifikasi desktop hanya bisa kalau dashboard dibuka lewat http://localhost (di PC server) atau HTTPS.\nDari PC lain, alarm tetap muncul lewat banner dan bunyi.');
        return;
    }
    await Notification.requestPermission();
    renderAlarmSettings();
}

function showDesktopNotification(a) {
    if (!desktopNotifSupported() || Notification.permission !== 'granted') return;
    const { craneName, gbName } = alarmNames(a);
    const n = new Notification(`${a.severity.toUpperCase()}: ${ALARM_TYPE_LABEL[a.type] || a.type} - ${gbName}`, {
        body: `${craneName}\n${describeAlarm(a)}`,
        tag: a.id,
        requireInteraction: a.severity === 'danger'
    });
    n.onclick = () => {
        window.focus();
        openAlarmPanel();
        n.close();
    };
}

// Banner & panel alarm harus ikut masuk ke elemen fullscreen saat mode Overview,
// karena browser hanya menampilkan isi elemen fullscreen.
function mountAlarmUi(parent) {
    ['alarmBanner', 'alarmPanelOverlay'].forEach(id => parent.appendChild(document.getElementById(id)));
}

// ============================================================
// PENGATURAN & PERANGKAT BARU
// ============================================================
async function loadSettings() {
    try {
        const res = await fetch('api/settings', { cache: 'no-store' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        settings = await res.json();
    } catch (e) {
        console.error('[Pengaturan] Gagal memuat daftar crane dari server:', e.message);
        document.getElementById('accordionContainer').innerHTML =
            '<div class="crane-notice"><i class="fa-solid fa-triangle-exclamation"></i> Daftar crane tidak bisa dimuat dari server. Pastikan npm run service sedang jalan, lalu muat ulang halaman.</div>';
    }
}

// Bagian pengaturan yang mengubah susunan dashboard (bukan sekadar batas suhu)
function settingsLayoutKey(s) {
    return JSON.stringify(s.cranes.map(c => [c.id, c.name, c.location, c.installed, c.gearboxes.map(g => [g.key, g.name, g.sparepart || ''])]));
}

// Pengaturan diubah (di halaman Pengaturan / aktivasi perangkat): batas suhu langsung
// dipakai; kalau daftar crane / nama berubah, tampilan disusun ulang tanpa memuat
// ulang halaman (nilai suhu live tetap dipertahankan).
function applySettings(next) {
    const layoutChanged = settingsLayoutKey(next) !== settingsLayoutKey(settings);
    settings = next;
    if (layoutChanged) {
        generateInitialData();
        renderAccordion();
        cranesData.filter(c => c.isOpen).forEach(c => {
            document.getElementById(`crane-item-${c.id}`).classList.add('open');
            setTimeout(() => c.gearboxes.forEach(gb => updateGearboxView(c, gb)), 50);
        });
        if (overviewCraneId !== null) renderOverviewSlide();
        renderDeviceNotice();
    } else {
        refreshAllViews();
    }
}

// Perangkat yang mengirim data tapi cranenya belum diaktifkan -> pemberitahuan
// di atas daftar crane, bisa langsung diaktifkan dengan satu klik.
let deviceList = [];

function renderDeviceNotice() {
    const box = document.getElementById('deviceNotice');
    if (!box) return;
    const pending = deviceList.filter(d => !d.installed && !d.ignoredAt);
    const newGearboxes = deviceList.filter(d => d.installed && d.unknownGearboxes.length);
    if (!pending.length && !newGearboxes.length) {
        box.style.display = 'none';
        return;
    }
    box.style.display = '';
    box.innerHTML = pending.map(d => {
        const crane = settings.cranes.find(c => c.id === d.craneId);
        const title = crane
            ? `${escapeHTML(crane.name)} <small>(${escapeHTML(d.craneId)})</small>`
            : `<strong>${escapeHTML(d.craneId)}</strong> <small>(belum ada di daftar crane)</small>`;
        const online = d.online === false ? ' · <span class="text-danger">offline</span>' : '';
        return `
            <div class="device-item">
                <i class="fa-solid fa-satellite-dish"></i>
                <div class="device-text">
                    <div><strong>Perangkat baru terdeteksi:</strong> ${title}</div>
                    <small>Area ${escapeHTML(d.area)} · ${d.gbKeys.length} gearbox mengirim data (${escapeHTML(d.gbKeys.join(', '))}) · terakhir ${formatAgo(d.lastSeen)}${online}</small>
                </div>
                <button class="device-btn primary" data-id="${escapeHTML(d.craneId)}" onclick="activateDevice(this.dataset.id)"><i class="fa-solid fa-power-off"></i> Aktifkan</button>
                <button class="device-btn" data-id="${escapeHTML(d.craneId)}" onclick="ignoreDevice(this.dataset.id)">Abaikan</button>
            </div>`;
    }).join('') + newGearboxes.map(d => `
            <div class="device-item">
                <i class="fa-solid fa-circle-info"></i>
                <div class="device-text">
                    <div><strong>${escapeHTML(d.craneId)}</strong> mengirim gearbox yang belum terdaftar: ${escapeHTML(d.unknownGearboxes.join(', '))}</div>
                    <small>Datanya tercatat, tapi belum tampil &amp; belum dipantau alarm.</small>
                </div>
                <button class="device-btn primary" data-id="${escapeHTML(d.craneId)}" onclick="activateDevice(this.dataset.id)"><i class="fa-solid fa-plus"></i> Tambahkan</button>
                <a class="device-btn" href="pengaturan.html">Pengaturan</a>
            </div>`).join('');
}

async function postJson(url, body) {
    const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
}

async function activateDevice(craneId) {
    try {
        await postJson('api/devices/activate', { craneId, by: storageGet('operatorName', '') });
        // Tampilan ikut diperbarui lewat event "settings" dari server
    } catch (e) {
        alert(`Gagal mengaktifkan ${craneId}: ${e.message}`);
    }
}

async function ignoreDevice(craneId) {
    try {
        await postJson('api/devices/ignore', { craneId, by: storageGet('operatorName', '') });
    } catch (e) {
        alert(`Gagal: ${e.message}`);
    }
}

window.onload = async () => {
    await loadSettings();
    generateInitialData();
    await hydrateFromServerState();
    renderAccordion();
    startLiveTimers();
    connectMQTT();
    connectAlarmStream();
};
