// ============================================================
// AUTH UI - badge akun & tombol logout (dipasang di index.html, laporan.html,
// pengaturan.html - lihat class .auth-bar di CSS_Monitoring.css)
// ============================================================
// Login sendiri ditangani login.html + login.js. File ini cuma:
//   1. Menampilkan "Masuk sebagai <nama akun>" + tombol Keluar di pojok
//      kanan atas (nama tampilan diatur di DISPLAY_NAMES di bawah).
//   2. Cek ulang status login tiap SESSION_CHECK_MS - kalau ternyata sesi ini
//      sudah dimatikan (mis. di-terminate master lewat panel "Sesi Login", atau
//      memang sudah kedaluwarsa), langsung lempar ke login.html TANPA perlu
//      refresh manual.
// Server sudah menolak (redirect / 401) permintaan tanpa sesi valid - ini
// cuma lapisan tampilan, bukan satu-satunya penjaga.

const SESSION_CHECK_MS = 10000; // seberapa cepat browser sadar sesinya dimatikan

// Nama yang DITAMPILKAN di badge - tidak wajib sama persis dengan username
// login. Username yang tidak terdaftar di sini otomatis huruf awal dibesarkan
// (mis. "master" -> "Master"). Tambah/ubah baris di bawah kalau mau nama
// tampilannya beda dari usernamenya (mis. jabatan, bukan sekadar Capitalize).
const DISPLAY_NAMES = {
    master: 'Master',
    maintenance: 'Maintenance'
};

function displayName(username) {
    if (DISPLAY_NAMES[username]) return DISPLAY_NAMES[username];
    return username.charAt(0).toUpperCase() + username.slice(1);
}

(function () {
    async function init() {
        let me;
        try {
            const res = await fetch('api/me', { cache: 'no-store' });
            if (res.status === 401) return void (window.location.href = 'login.html');
            if (!res.ok) return; // gangguan sesaat - jangan ganggu halaman, cek lagi lain kali
            me = await res.json();
        } catch (e) {
            return; // offline sebentar
        }

        // Peran dipakai CSS untuk menyembunyikan menu yang bukan hak akun ini
        // (html[data-role="viewer"] .no-viewer). Ini cuma tampilan - yang menolak akses
        // sebenarnya adalah server (viewerMayAccess di server.js).
        // Peran tidak dikirim server (server lama yang belum di-restart) -> JANGAN dianggap viewer:
        // menu staf tetap tampil. Yang menentukan hak akses sebenarnya tetap server.
        document.documentElement.dataset.role = me.role || 'unknown';
        window.gbxRole = me.role || 'unknown';

        const bar = document.createElement('div');
        bar.className = 'auth-bar';
        bar.innerHTML = `<i class="fa-solid fa-user"></i> Masuk sebagai <strong>${escapeHTML(displayName(me.username))}</strong>
            <button type="button" id="authLogoutBtn" title="Keluar dari akun ini"><i class="fa-solid fa-right-from-bracket"></i> Keluar</button>`;
        // Kalau halaman punya #authSlot (index.html), badge masuk ke header
        // (tidak mengambang menutupi judul); halaman lain tetap mengambang.
        (document.getElementById('authSlot') || document.body).appendChild(bar);
        document.getElementById('authLogoutBtn').addEventListener('click', logout);

        // Elemen KHUSUS AKUN MASTER: dikasih attribute data-master-only="true" di
        // HTML-nya (contoh: tombol Deadman Switch di index.html), disembunyikan
        // lewat style="display:none" bawaan, baru dimunculkan di sini kalau yang
        // login memang master. Halaman lain yang tidak punya elemen ini aman saja.
        if (me.username === 'master') {
            document.querySelectorAll('[data-master-only]').forEach(el => {
                el.style.display = '';
                el.style.visibility = '';
                el.style.pointerEvents = '';
                el.removeAttribute('aria-hidden');
            });
        }

        // Cek ulang berkala - beda dengan cek sekali di atas (yang cuma jalan
        // saat halaman pertama dibuka). Ini yang bikin sesi yang di-terminate
        // master langsung ke-logout walau halamannya dibiarkan terbuka.
        // Cookie sesi dipakai bersama SEMUA tab browser. Kalau di tab lain login sebagai
        // akun berbeda (mis. master lalu maintenance), tab ini diam-diam ikut jadi akun
        // baru tapi badge-nya masih akun lama - jadi kalau akunnya beda, muat ulang.
        setInterval(async () => {
            try {
                const res = await fetch('api/me', { cache: 'no-store' });
                if (res.status === 401) return void (window.location.href = 'login.html');
                if (!res.ok) return;
                const now = await res.json();
                if (now.username !== me.username) window.location.reload();
            } catch (e) { /* jaringan sempat putus - jangan langsung logout, coba lagi nanti */ }
        }, SESSION_CHECK_MS);
    }

    function escapeHTML(value) {
        return String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    }

    async function logout() {
        try {
            await fetch('api/logout', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
        } catch (e) { /* tetap redirect walau gagal kirim - sesi lama akan kadaluarsa sendiri */ }
        window.location.href = 'login.html';
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();
})();
