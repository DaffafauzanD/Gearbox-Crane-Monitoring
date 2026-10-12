// ============================================================
// STATUS SISTEM - status.html
// ============================================================
// Ambil /api/health (publik, tidak perlu login - lihat server.js) tiap 5 detik
// dan tampilkan sebagai kartu. Beda dengan sekadar "run-all.js kebuka": tiap
// layanan dicek dari sinyal yang membuktikan dia BENERAN jalan (lihat komentar
// buildHealth() di server.js).

const REFRESH_MS = 5000;
const STATE_STALE_WARN_SEC = 5 * 60; // logger.state.json tidak ditulis > ini -> warning (kuning), bukan langsung merah

function fmtAgo(sec) {
    if (sec === null || sec === undefined) return 'belum pernah';
    if (sec < 5) return 'baru saja';
    if (sec < 60) return `${sec} detik lalu`;
    const min = Math.floor(sec / 60);
    if (min < 60) return `${min} menit lalu`;
    const h = Math.floor(min / 60);
    return `${h} jam ${min % 60} menit lalu`;
}

function fmtDuration(sec) {
    if (sec < 60) return `${sec} detik`;
    const min = Math.floor(sec / 60);
    if (min < 60) return `${min} menit`;
    const h = Math.floor(min / 60);
    return `${h} jam ${min % 60} menit`;
}

function fmtClock(ms) {
    return new Date(ms).toLocaleTimeString('id-ID', { timeZone: 'Asia/Jakarta', hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function setDot(id, state) {
    document.getElementById(id).className = `dot dot-${state}`;
}

function row(label, value) {
    return `<div><span>${label}</span><span>${value}</span></div>`;
}

// Nama/IP/MAC crane masuk lewat innerHTML di halaman ini yang PUBLIK (tanpa login) -
// escape dulu supaya tidak bisa dipakai untuk menyisipkan HTML/script.
function escapeHTML(value) {
    return String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

let serverOffsetMs = 0; // selisih jam server - jam perangkat, diisi dari health.checkedAt

// Jam berjalan sendiri di browser (tidak menunggu refresh 5 detik) - pill di kanan atas,
// lengkap dengan tanggal supaya berguna juga buat orang yang screenshot halaman ini.
function startLiveClock() {
    const el = document.getElementById('liveClock');
    if (!el) return;
    function tick() {
        // jam server (selisihnya diperbarui tiap refresh dari health.checkedAt), zona WIB
        const now = new Date(Date.now() + serverOffsetMs);
        const tanggal = now.toLocaleDateString('id-ID', { day: '2-digit', month: 'long', year: 'numeric', timeZone: 'Asia/Jakarta' });
        const jam = now.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit', second: '2-digit', timeZone: 'Asia/Jakarta' });
        el.innerHTML = `<i class="fa-solid fa-clock"></i> ${tanggal} &bull; ${jam}`;
    }
    tick();
    setInterval(tick, 1000);
}

// ---- Daftar access point yang dikenal sebuah ESP32 (klik sel Access Point di tabel) ----
let latestCraneList = [];
let apPopupCrane = null;

function apPopupHTML(c) {
    const db = (c.apDb || []).slice().sort((a, b) => (b.rssi ?? -127) - (a.rssi ?? -127));
    const rows = db.length ? db.map(a => {
        const isNow = c.ap && a.mac.toUpperCase() === c.ap.toUpperCase();
        const isCand = c.cand && a.mac.toUpperCase() === c.cand.toUpperCase();
        const tag = isNow ? '<span class="ap-tag ap-tag--now">dipakai sekarang</span>'
            : isCand ? '<span class="ap-tag ap-tag--cand">cadangan siap</span>' : '';
        const r = a.rssi !== null && a.rssi > -100 ? `${a.rssi} dBm` : '-';
        return `<tr><td><code>${escapeHTML(a.mac)}</code> ${tag}</td><td>${a.ch ? 'ch' + a.ch : '-'}</td><td>${escapeHTML(r)}</td></tr>`;
    }).join('') : '<tr><td colspan="3" class="devices-empty">Belum ada data (firmware terbaru mengirim daftarnya tiap ~30 detik)</td></tr>';
    return `
        <div class="ap-pop-box" role="dialog">
            <div class="ap-pop-head"><span>Access point yang dikenal <strong>${escapeHTML(c.name)}</strong> <code>${escapeHTML(c.id)}</code></span>
                <button type="button" class="ap-pop-close" onclick="closeApPopup()"><i class="fa-solid fa-xmark"></i></button></div>
            <p class="ap-pop-note">Daftar ini milik ESP32 itu sendiri (dipelajari saat tersambung &amp; memindai, disimpan di flash). Sinyal = pembacaan terakhir di posisi crane waktu itu, bukan sinyal sekarang.</p>
            <table class="device-table ap-pop-table"><thead><tr><th>MAC (BSSID)</th><th>Channel</th><th>Sinyal terakhir</th></tr></thead><tbody>${rows}</tbody></table>
        </div>`;
}
function renderApPopup() {
    const el = document.getElementById('apPopup');
    if (!el) return;
    const c = latestCraneList.find(x => x.id === apPopupCrane);
    if (c) el.innerHTML = apPopupHTML(c);
}
function openApPopup(craneId) {
    apPopupCrane = craneId;
    let el = document.getElementById('apPopup');
    if (!el) {
        el = document.createElement('div');
        el.id = 'apPopup';
        el.className = 'ap-pop';
        el.addEventListener('mousedown', e => { if (e.target === el) closeApPopup(); });
        document.body.appendChild(el);
    }
    renderApPopup();
}
function closeApPopup() {
    apPopupCrane = null;
    const el = document.getElementById('apPopup');
    if (el) el.remove();
}
document.addEventListener('keydown', e => { if (e.key === 'Escape' && apPopupCrane) closeApPopup(); });
document.addEventListener('click', e => {
    const td = e.target.closest && e.target.closest('td.col-ap');
    if (td && td.dataset.id) openApPopup(td.dataset.id);
});

// Tombol "Hapus riwayat" (pindah AP / restart): minta konfirmasi, hapus di server, lalu segarkan tampilan
async function clearHistory(what) {
    const nama = what === 'ap' ? 'riwayat pindah access point' : 'riwayat restart alat';
    if (!confirm(`Hapus semua ${nama}? Ini tidak bisa dibatalkan.`)) return;
    try {
        const res = await fetch('api/history/clear', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ what })
        });
        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            alert(err.error || 'Gagal menghapus riwayat.');
            return;
        }
        refresh();
    } catch (e) {
        alert('Server tidak bisa dihubungi.');
    }
}

// Kolom "Alasan" di riwayat pindah AP: pindah sengaja karena sinyal lemah vs. sekadar sambung ulang setelah putus
function apWhyHTML(ch) {
    const map = {
        'roaming':       ['ap-why--roaming', 'Sinyal lemah (roaming)', 'Alat sengaja pindah karena sinyal AP lama melemah'],
        'sambung-ulang': ['ap-why--ulang', 'Sambung ulang setelah putus', 'WiFi putus lalu menyambung lagi; AP bisa berbeda dari sebelumnya'],
        'boot':          ['ap-why--boot', 'Alat baru menyala', 'Alat baru dinyalakan/restart dan memilih AP']
    };
    const m = map[ch.why];
    const dur = ch.stayedMs ? Math.max(1, Math.round(ch.stayedMs / 60000)) : null;
    const stay = dur ? `<span class="ap-stay">bertahan ${dur >= 60 ? Math.floor(dur / 60) + ' jam ' + (dur % 60) + ' mnt' : dur + ' mnt'} di AP sebelumnya</span>` : '';
    if (!m) return `<span class="ap-why ap-why--none" title="Firmware belum melaporkan alasan (upload versi terbaru)">-</span>${stay}`;
    return `<span class="ap-why ${m[0]}" title="${escapeHTML(m[2])}">${escapeHTML(m[1])}</span>${stay}`;
}

function signalIcon(rssi) {
    if (rssi === null || rssi === undefined) return { icon: 'fa-solid fa-wifi', color: '#64748b', label: '-' };
    if (rssi >= -60) return { icon: 'fa-solid fa-wifi', color: '#4ade80', label: `${rssi} dBm` };
    if (rssi >= -75) return { icon: 'fa-solid fa-wifi', color: '#fbbf24', label: `${rssi} dBm` };
    return { icon: 'fa-solid fa-wifi', color: '#f87171', label: `${rssi} dBm` };
}

async function refresh() {
    let health;
    try {
        const res = await fetch('api/health', { cache: 'no-store' });
        if (!res.ok) throw new Error('status ' + res.status);
        health = await res.json();
        serverOffsetMs = health.checkedAt - Date.now();
        document.getElementById('errorBox').style.display = 'none';
    } catch (e) {
        document.getElementById('errorBox').style.display = 'block';
        document.getElementById('overallBox').textContent = 'Tidak bisa menghubungi web server sama sekali.';
        setDot('dotBroker', 'down');
        setDot('dotLogger', 'down');
        setDot('dotWeb', 'down');
        return;
    }

    // ---- Broker ----
    setDot('dotBroker', health.broker.up ? 'up' : 'down');
    const brokerAddr = health.broker.ip ? `${health.broker.ip}:${health.broker.port}` : `- : ${health.broker.port || ''}`;
    document.getElementById('rowsBroker').innerHTML = [
        row('Status', health.broker.up ? 'Terhubung' : 'Terputus'),
        row('Alamat broker', `<span class="addr-pill"><i class="fa-solid fa-network-wired"></i>${escapeHTML(brokerAddr)}</span>`),
        health.broker.up
            ? row('Sejak', health.broker.connectedSince ? fmtAgo(Math.round((health.checkedAt - health.broker.connectedSince) / 1000)) : '-')
            : row('Terputus sejak', health.broker.disconnectedSince ? fmtAgo(Math.round((health.checkedAt - health.broker.disconnectedSince) / 1000)) : '-')
    ].join('');

    // ---- Logger ----
    const stateAge = health.logger.stateFileAgeSec;
    const loggerStale = health.logger.up && stateAge !== null && stateAge > STATE_STALE_WARN_SEC;
    setDot('dotLogger', !health.logger.up ? 'down' : (loggerStale ? 'warn' : 'up'));
    const staleWarning = loggerStale
        ? ' <span title="Tidak menulis data lebih dari 5 menit - cek apakah macet atau memang tidak ada crane yang mengirim data">&#9888;&#65039;</span>'
        : '';
    document.getElementById('rowsLogger').innerHTML = [
        row('Proses', health.logger.up ? `Jalan (PID ${health.logger.pid})` : 'Tidak jalan'),
        row('Terakhir tulis data', fmtAgo(stateAge) + staleWarning)
    ].join('');

    // ---- Web ----
    setDot('dotWeb', 'up'); // kalau ini kebaca, prosesnya sendiri pasti hidup
    document.getElementById('rowsWeb').innerHTML = [
        row('Proses', `Jalan (PID ${health.web.pid})`),
        row('Uptime', fmtDuration(health.web.uptimeSec)),
        row('Memori', `${health.web.memoryMb} MB`),
        row('Dashboard terbuka', `${health.web.sseClients} sesi`)
    ].join('');

    // ---- Devices: tabel asli, satu baris <tr> per ESP32 (crane dengan 2 ESP32 = 2 baris) ----
    const totalEsp = health.devices.total ?? health.devices.installed;
    document.getElementById('devicesBig').textContent = `${health.devices.reportingNow}/${totalEsp}`
        + (totalEsp !== health.devices.installed ? ` ESP32 · ${health.devices.installed} crane` : '');
    const list = health.devices.list || [];
    latestCraneList = list;
    if (apPopupCrane) renderApPopup();   // popup yang sedang terbuka ikut diperbarui
    const limitSet = [...new Set(list.map(c => c.offlineMinutes).filter(Boolean))].sort((a, b) => a - b);
    document.getElementById('devicesLabel').textContent = limitSet.length
        ? `mengirim data dalam ${limitSet.length === 1 ? limitSet[0] : `${limitSet[0]}-${limitSet[limitSet.length - 1]}`} menit terakhir (sesuai batas offline di Pengaturan)`
        : 'mengirim data dalam batas offline';
    const listEl = document.getElementById('devicesList');
    if (list.length === 0) {
        listEl.innerHTML = '<tr><td colspan="11" class="devices-empty">Belum ada crane terpasang</td></tr>';
    } else {
        listEl.innerHTML = list.map(c => {
            const sig = signalIcon(c.reporting ? c.rssi : null); // offline -> tidak ada sinyal ditampilkan
            return `
            <tr class="${c.reporting ? 'is-reporting' : 'is-offline'}">
                <td class="col-no">${c.no}</td>
                <td class="col-name">
                    <div class="device-name-cell">
                        <span class="device-dot" style="background:${c.reporting ? '#22c55e' : '#ef4444'}"></span>
                        <span class="device-name" title="${escapeHTML(c.name)}">${escapeHTML(c.name)}</span>
                    </div>
                </td>
                <td class="col-loc device-location" style="text-align:center" title="${escapeHTML(c.location)}">${escapeHTML(c.location)}</td>
                <td class="col-id"><code>${escapeHTML(c.id)}</code></td>
                <td class="col-topic" style="text-align:center"><code title="${escapeHTML(c.topic)}">${escapeHTML(c.topic)}</code></td>
                <td class="col-mac"><code>${escapeHTML(c.mac || '-')}</code></td>
                <td class="col-fw" style="text-align:center">${c.fw ? 'v' + escapeHTML(c.fw) : '-'}</td>
                <td class="col-sig" style="text-align:center">
                    <span class="device-signal" style="color:${sig.color}"><i class="${sig.icon}" style="color:${sig.color}"></i>${escapeHTML(sig.label)}</span>
                </td>
                <td class="col-ap ap-clickable" data-id="${escapeHTML(c.id)}"><code title="${[c.channel ? 'channel ' + c.channel : '', c.apKnown !== null && c.apKnown !== undefined ? 'daftar ESP32 ini: ' + c.apKnown + ' AP dikenal (bukan jumlah AP di pabrik)' : '', c.roams ? 'pindah ' + c.roams + 'x sejak boot' : ''].filter(Boolean).join(' · ')}">${escapeHTML(c.reporting && c.ap ? c.ap : '-')}</code>${c.reporting && c.cand ? `<span class="ap-cand" title="Access point cadangan yang sudah disiapkan ESP32 (sinyal sekarang mulai lemah)${c.roams ? ' · sudah pindah ' + c.roams + 'x sejak boot' : ''}"><i class="fa-solid fa-arrow-right-arrow-left"></i>siap: ${escapeHTML(c.cand)} (${c.candRssi} dBm)</span>` : ''}</td>
                <td class="col-ago">${c.reporting ? 'baru saja' : fmtAgo(c.lastSeen ? Math.round((health.checkedAt - c.lastSeen) / 1000) : null)}</td>
                <td class="col-mon"><button type="button" class="esp-mon-btn" data-id="${escapeHTML(c.id)}" data-name="${escapeHTML(c.name)}" title="Lihat Serial Monitor ESP32 ini" onclick="openEspMonitor(this.dataset.id, this.dataset.name)"><i class="fa-solid fa-terminal"></i></button></td>
            </tr>`;
        }).join('');
    }

    // ---- Riwayat pindah access point ----
    const apList = document.getElementById('apChangesList');
    const changes = health.devices.apChanges || [];
    document.getElementById('apCount').textContent = changes.length ? `${changes.length} kejadian (terbaru di atas)` : '';
    document.getElementById('apClearBtn').disabled = !changes.length;
    apList.innerHTML = changes.length
        ? changes.map(ch => {
            const t = new Date(ch.at).toLocaleString('id-ID', { timeZone: 'Asia/Jakarta', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
            const rssi = ch.toRssi !== null && ch.toRssi !== undefined ? `${ch.toRssi} dBm` : '-';
            return `<tr>
                <td>${escapeHTML(t)} WIB</td>
                <td style="text-align:center">${escapeHTML(ch.craneName)} <code>${escapeHTML(ch.craneId)}</code></td>
                <td class="ap-arrow-from"><code>${escapeHTML(ch.from)}</code></td>
                <td class="ap-arrow-to"><code>${escapeHTML(ch.to)}</code></td>
                <td>${escapeHTML(rssi)}${ch.channel ? ` · ch${ch.channel}` : ''}</td>
                <td>${apWhyHTML(ch)}</td>
            </tr>`;
        }).join('')
        : '<tr><td colspan="6" class="devices-empty">Belum ada perpindahan access point yang tercatat</td></tr>';

    // ---- Riwayat restart alat ----
    const rsMap = {
        'watchdog':        ['ap-why--bad', 'Watchdog', 'Program macet lebih dari 20 detik (mis. jaringan tersendat saat mengirim data)'],
        'brownout':        ['ap-why--bad', 'Kurang daya (brownout)', 'Tegangan turun sesaat: catu daya atau kabel USB kurang kuat'],
        'crash':           ['ap-why--bad', 'Crash program', 'Program berhenti karena kesalahan (panic)'],
        'listrik-nyala':   ['ap-why--boot', 'Listrik baru menyala', 'Alat baru dicolok / listrik sempat putus'],
        'restart-program': ['ap-why--boot', 'Restart oleh program', 'Restart yang diminta program (mis. selesai update OTA atau pengaman)'],
        'tombol-reset':    ['ap-why--boot', 'Tombol reset', 'Tombol EN/reset ditekan'],
        'lainnya':         ['ap-why--ulang', 'Lainnya', 'Penyebab tidak dikenali']
    };
    const fmtRan = ms => {
        const m = Math.round(ms / 60000);
        if (m < 1) return `${Math.round(ms / 1000)} detik`;
        return m >= 60 ? `${Math.floor(m / 60)} jam ${m % 60} mnt` : `${m} mnt`;
    };
    const restarts = health.devices.restarts || [];
    document.getElementById('restartCount').textContent = restarts.length ? `${restarts.length} kejadian (terbaru di atas)` : '';
    document.getElementById('restartClearBtn').disabled = !restarts.length;
    document.getElementById('restartList').innerHTML = restarts.length
        ? restarts.map(r => {
            const t = new Date(r.at).toLocaleString('id-ID', { timeZone: 'Asia/Jakarta', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
            const m = rsMap[r.rst];
            const why = m ? `<span class="ap-why ${m[0]}" title="${escapeHTML(m[2])}">${escapeHTML(m[1])}</span>`
                : '<span class="ap-why ap-why--none" title="Firmware belum melaporkan penyebab (upload versi terbaru)">-</span>';
            return `<tr><td>${escapeHTML(t)} WIB</td><td style="text-align:center">${escapeHTML(r.craneName)} <code>${escapeHTML(r.craneId)}</code></td><td>${why}</td><td>${r.ranMs ? escapeHTML(fmtRan(r.ranMs)) : '-'}</td></tr>`;
        }).join('')
        : '<tr><td colspan="4" class="devices-empty">Belum ada restart yang tercatat</td></tr>';

    // ---- Ringkasan ----
    const allUp = health.broker.up && health.logger.up && !loggerStale;
    const overall = document.getElementById('overallBox');
    overall.textContent = allUp ? '✅ Semua layanan berjalan normal' : '⚠️ Ada layanan yang bermasalah - lihat detail di bawah';
    overall.style.color = allUp ? '#4ade80' : '#fbbf24';

    document.getElementById('lastChecked').innerHTML = `<i class="fa-solid fa-rotate"></i> Terakhir dicek ${fmtClock(health.checkedAt)} WIB`;
}

startLiveClock();
refresh();
setInterval(refresh, REFRESH_MS);
