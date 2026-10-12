// ============================================================
// SERIAL MONITOR JARAK JAUH - menampilkan Serial Monitor sebuah ESP32 di browser
// ============================================================
// Dipakai di status.html dan pengaturan.html (khusus staf). Cara kerja:
//   1. openEspMonitor(craneId, nama) membuka jendela terminal.
//   2. Browser minta server mengirim "log on" ke ESP32 (api/esp/log/start). ESP32 lalu menyalin
//      semua yang ia cetak ke Serial ke topik MQTT .../log. Diulang tiap 60 detik selama jendela
//      terbuka - kalau browser ditutup, ESP32 berhenti sendiri dalam ~2 menit.
//   3. Browser mengambil baris baru dari server tiap detik (api/esp/log?after=...).
// Butuh firmware ESP32 yang sudah mendukung (lihat GBXMQTT.ino, "Serial Monitor jarak jauh").

(function () {
    const POLL_MS = 1000;
    const RENEW_MS = 15000;      // perpanjang "log on" tiap 15 detik (perintah MQTT bisa hilang kalau ESP32 sedang putus sesaat)
    const KICK_MS = 3000;        // selama BELUM ada baris sama sekali, kirim ulang tiap 3 detik
    const MAX_LINES = 600;
    let state = null;

    // Gaya jendela disuntik dari sini supaya status.html (yang berdiri sendiri, tanpa CSS_Monitoring.css) juga kebagian.
    const STYLE = `/* ---- Serial Monitor jarak jauh (espmon.js) ---- */
.esp-mon-modal {
    position: fixed; inset: 0; z-index: 3000; background: rgba(2, 6, 14, 0.72);
    display: flex; align-items: center; justify-content: center; padding: 16px;
}
.esp-mon-box {
    width: min(1100px, 100%); height: min(720px, 100%); display: flex; flex-direction: column;
    background: #0b1220; border: 1px solid #263349; border-radius: 12px; overflow: hidden;
    box-shadow: 0 24px 60px rgba(0, 0, 0, 0.55);
}
.esp-mon-head {
    display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap;
    padding: 10px 14px; background: #101a30; border-bottom: 1px solid #263349;
}
.esp-mon-title { color: #f1f5f9; font-size: 0.9rem; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.esp-mon-title i { color: #38bdf8; }
.esp-mon-title code { background: #0b1220; border: 1px solid #263349; border-radius: 4px; padding: 1px 7px; color: #7dd3fc; font-size: 0.72rem; }
.esp-mon-tools { display: flex; gap: 6px; }
.esp-mon-tools button {
    background: #141d33; color: #cbd5e1; border: 1px solid #263349; border-radius: 6px;
    padding: 5px 10px; font-size: 0.76rem; cursor: pointer; font-family: inherit;
}
.esp-mon-tools button:hover { background: #1c2740; color: #f8fafc; }
.esp-mon-info { padding: 6px 14px; font-size: 0.76rem; color: #94a3b8; background: #0e1627; border-bottom: 1px solid #1c2740; }
.esp-mon-info--ok { color: #4ade80; }
.esp-mon-info--warn { color: #fbbf24; }
.esp-mon-info--bad { color: #f87171; }
.esp-mon-body {
    flex: 1; overflow: auto; padding: 8px 14px 12px; background: #050a14;
    font-family: Consolas, 'Courier New', monospace; font-size: 0.78rem; line-height: 1.5; color: #cbd5e1;
}
.esp-line { white-space: pre-wrap; word-break: break-all; }
.esp-line-t { color: #475569; margin-right: 10px; user-select: none; }
.esp-line--bad { color: #f87171; }
.esp-line--warn { color: #fbbf24; }
.esp-line--ok { color: #86efac; }
.esp-line--dim { color: #64748b; }
.esp-mon-btn {
    display: inline-flex; align-items: center; gap: 6px; background: #141d33; color: #7dd3fc;
    border: 1px solid #263349; border-radius: 8px; padding: 6px 11px; font-size: 0.78rem; font-weight: 600;
    cursor: pointer; font-family: inherit; white-space: nowrap;
}
.esp-mon-btn:hover { background: #1c2740; color: #bae6fd; }
.esp-mon-btn:focus { outline: none; }
.esp-mon-btn:focus-visible { outline: 2px solid #38bdf8; outline-offset: 1px; }
.esp-mon-btn:active { background: #141d33; color: #7dd3fc; }
.esp-mon-btn i { line-height: 1; }`;
    function ensureStyle() {
        if (document.getElementById('espMonStyle')) return;
        const s = document.createElement('style');
        s.id = 'espMonStyle';
        s.textContent = STYLE;
        document.head.appendChild(s);
    }
    ensureStyle(); // langsung saat skrip dimuat: tombol di tabel/accordion sudah bergaya sebelum jendela pernah dibuka


    function esc(s) { return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

    // Warna baris menurut tag di depannya, mirip yang terlihat di Arduino IDE tapi lebih mudah dipindai
    function lineClass(text) {
        if (/\[(FAULT|PENGAMAN)|GAGAL|TERPUTUS|Terputus|Gagal/.test(text)) return 'esp-line--bad';
        if (/\[(OTA|ROAMING|BUFFER)\]/.test(text)) return 'esp-line--warn';
        if (/\[(SINYAL)\]/.test(text)) return 'esp-line--dim';
        if (/BERHASIL|Tersambung|Terhubung|\[KIRIM\]/.test(text)) return 'esp-line--ok';
        return '';
    }

    async function api(method, url, body) {
        const res = await fetch(url, {
            method, cache: 'no-store',
            headers: body ? { 'Content-Type': 'application/json' } : undefined,
            body: body ? JSON.stringify(body) : undefined
        });
        let data = {};
        try { data = await res.json(); } catch (e) { /* bukan JSON */ }
        if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
        return data;
    }

    function setInfo(text, cls) {
        const el = document.getElementById('espMonInfo');
        if (!el) return;
        el.textContent = text;
        el.className = 'esp-mon-info' + (cls ? ' ' + cls : '');
    }

    async function poll() {
        if (!state) return;
        if (!state.gotAny && Date.now() - state.lastKick > KICK_MS) { state.lastKick = Date.now(); renew(); }
        try {
            const d = await api('GET', `api/esp/log?craneId=${encodeURIComponent(state.craneId)}&after=${state.last}`);
            if (!state) return;
            if (d.last < state.last) { state.last = 0; } // server di-restart
            if (d.lines.length) {
                state.last = d.last;
                state.gotAny = true;
                if (!state.paused) append(d.lines);
                else state.pending.push(...d.lines);
            }
            if (!d.online) setInfo('ESP32 offline - menunggu tersambung...', 'esp-mon-info--bad');
            else if (!state.gotAny && Date.now() - state.openedAt > 8000) {
                setInfo(`Belum ada data${d.fw ? ` (firmware v${d.fw})` : ''}. Pastikan firmware ESP32 sudah versi terbaru yang mendukung Serial Monitor jarak jauh.`, 'esp-mon-info--warn');
            } else if (state.gotAny) setInfo('Terhubung - menampilkan Serial Monitor langsung', 'esp-mon-info--ok');
        } catch (e) {
            setInfo(e.message, 'esp-mon-info--bad');
        }
    }

    function append(lines) {
        const box = document.getElementById('espMonBody');
        if (!box) return;
        const atBottom = box.scrollTop + box.clientHeight >= box.scrollHeight - 30;
        const html = lines.map(l => {
            const t = new Date(l.t).toLocaleTimeString('id-ID', { timeZone: 'Asia/Jakarta', hour12: false });
            return `<div class="esp-line ${lineClass(l.text)}"><span class="esp-line-t">${t}</span>${esc(l.text)}</div>`;
        }).join('');
        box.insertAdjacentHTML('beforeend', html);
        while (box.childElementCount > MAX_LINES) box.removeChild(box.firstChild);
        if (atBottom) box.scrollTop = box.scrollHeight;
    }

    async function renew() {
        if (!state) return;
        try { await api('POST', 'api/esp/log/start', { craneId: state.craneId }); }
        catch (e) { setInfo(e.message, 'esp-mon-info--bad'); }
    }

    function close() {
        if (!state) return;
        const id = state.craneId;
        clearInterval(state.pollTimer);
        clearInterval(state.renewTimer);
        state = null;
        api('POST', 'api/esp/log/stop', { craneId: id }).catch(() => { /* alat akan berhenti sendiri dalam ~2 menit */ });
        const m = document.getElementById('espMonModal');
        if (m) m.remove();
        document.removeEventListener('keydown', onKey);
    }
    function onKey(e) { if (e.key === 'Escape') close(); }

    window.openEspMonitor = async function (craneId, name) {
        if (state) close();
        ensureStyle();
        const modal = document.createElement('div');
        modal.id = 'espMonModal';
        modal.className = 'esp-mon-modal';
        modal.innerHTML = `
            <div class="esp-mon-box" role="dialog" aria-label="Serial Monitor ${esc(craneId)}">
                <div class="esp-mon-head">
                    <div class="esp-mon-title"><i class="fa-solid fa-terminal"></i> Serial Monitor <strong>${esc(name || craneId)}</strong> <code>${esc(craneId)}</code></div>
                    <div class="esp-mon-tools">
                        <button type="button" id="espMonPause" title="Hentikan sementara gulir layar"><i class="fa-solid fa-pause"></i> Jeda</button>
                        <button type="button" id="espMonClear" title="Kosongkan layar"><i class="fa-solid fa-eraser"></i> Bersihkan</button>
                        <button type="button" id="espMonCopy" title="Salin semua baris ke clipboard"><i class="fa-solid fa-copy"></i> Salin</button>
                        <button type="button" id="espMonClose" title="Tutup (Esc)"><i class="fa-solid fa-xmark"></i></button>
                    </div>
                </div>
                <div class="esp-mon-info" id="espMonInfo">Meminta ESP32 mengirim Serial Monitor...</div>
                <div class="esp-mon-body" id="espMonBody"></div>
            </div>`;
        document.body.appendChild(modal);
        modal.addEventListener('mousedown', e => { if (e.target === modal) close(); });
        document.getElementById('espMonClose').addEventListener('click', close);
        document.getElementById('espMonClear').addEventListener('click', () => { document.getElementById('espMonBody').innerHTML = ''; });
        document.getElementById('espMonCopy').addEventListener('click', async () => {
            const text = [...document.querySelectorAll('#espMonBody .esp-line')].map(l => l.textContent).join('\n');
            try { await navigator.clipboard.writeText(text); setInfo('Tersalin ke clipboard', 'esp-mon-info--ok'); }
            catch (e) { setInfo('Gagal menyalin (izin clipboard ditolak)', 'esp-mon-info--bad'); }
        });
        document.getElementById('espMonPause').addEventListener('click', e => {
            state.paused = !state.paused;
            e.currentTarget.innerHTML = state.paused ? '<i class="fa-solid fa-play"></i> Lanjut' : '<i class="fa-solid fa-pause"></i> Jeda';
            if (!state.paused && state.pending.length) { append(state.pending); state.pending = []; }
        });
        document.addEventListener('keydown', onKey);

        state = { craneId, last: 0, gotAny: false, paused: false, pending: [], openedAt: Date.now(), lastKick: Date.now() };
        const me = state;
        // Mulai dari baris TERBARU di server: log sesi sebelumnya (yang masih tersimpan di memori server)
        // tidak boleh muncul lagi - tiap jendela dibuka layarnya bersih.
        try {
            const r = await api('POST', 'api/esp/log/start', { craneId });
            if (state === me) state.last = r.last || 0;
        } catch (e) { setInfo(e.message, 'esp-mon-info--bad'); }
        if (state !== me) return; // jendela sudah ditutup selagi menunggu
        state.pollTimer = setInterval(poll, POLL_MS);
        state.renewTimer = setInterval(renew, RENEW_MS);
        poll();
    };
    window.closeEspMonitor = close;
})();
