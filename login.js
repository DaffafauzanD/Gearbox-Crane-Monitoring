// ============================================================
// LOGIN - form di login.html
// ============================================================
// Akun dicek server.js lewat auth.js (master, maintenance, atau akun hasil pengajuan
// yang sudah disetujui). Sesi disimpan di cookie httpOnly oleh
// server (lihat POST /api/login) - halaman ini cuma kirim form & tampilkan
// pesan error, tidak menyimpan apa pun sendiri.

const form = document.getElementById('loginForm');
const errorBox = document.getElementById('loginError');
const btn = document.getElementById('loginBtn');

function showError(msg) {
    errorBox.textContent = msg;
    errorBox.style.display = 'block';
}

// Sudah login (sesi masih berlaku) -> langsung ke dashboard, tidak perlu login lagi
fetch('api/me', { cache: 'no-store' })
    .then(res => { if (res.ok) window.location.href = 'index.html'; })
    .catch(() => { /* belum login / server baru nyala - biarkan form login tampil */ });

form.addEventListener('submit', async (e) => {
    e.preventDefault();
    errorBox.style.display = 'none';
    btn.disabled = true;
    btn.textContent = 'Memeriksa...';

    try {
        const res = await fetch('api/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                username: document.getElementById('username').value.trim(),
                password: document.getElementById('password').value
            })
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
            showError(data.error || 'Username atau password salah');
            return;
        }
        window.location.href = 'index.html';
    } catch (e) {
        showError('Tidak bisa menghubungi server. Cek koneksi ke dashboard, lalu coba lagi.');
    } finally {
        btn.disabled = false;
        btn.textContent = 'Masuk';
    }
});

// ============================================================
// AJUKAN AKUN BARU
// ============================================================
// Pengajuan masuk antrian dan baru bisa dipakai login setelah disetujui
// maintenance. Validasi sebenarnya ada di server (POST /api/signup); di sini cuma
// pengecekan ringan supaya pesan salahnya cepat.
const loginCard = document.getElementById('loginForm');
const signupCard = document.getElementById('signupCard');
const signupError = document.getElementById('signupError');
const signupOk = document.getElementById('signupOk');
const signupBtn = document.getElementById('signupBtn');

// Isi kotak hijau setelah pengajuan terkirim. Ubah teksnya di sini (teks biasa).
const SIGNUP_OK_TEXT = 'Sabar nyakkk ntar di acc sama anak maintenance kok :), hubungi maintenance 1x24 jam aja soalnya sibuk, kalo masih belum gedor ae ke workshop';

function showCard(which) {
    loginCard.style.display = which === 'login' ? '' : 'none';
    signupCard.style.display = which === 'signup' ? 'block' : 'none';
    signupError.style.display = 'none';
    signupOk.style.display = 'none';
    errorBox.style.display = 'none';
}

document.getElementById('showSignup').addEventListener('click', () => showCard('signup'));
document.getElementById('showLogin').addEventListener('click', () => showCard('login'));

function showSignupError(msg) {
    signupOk.style.display = 'none';
    signupError.textContent = msg;
    signupError.style.display = 'block';
}

signupCard.addEventListener('submit', async (e) => {
    e.preventDefault();
    signupError.style.display = 'none';
    signupOk.style.display = 'none';

    const username = document.getElementById('suUsername').value.trim().toLowerCase();
    const password = document.getElementById('suPassword').value;
    if (password.length < 6) return showSignupError('Password minimal 6 karakter.');
    if (password !== document.getElementById('suPassword2').value) return showSignupError('Password dan ulangi password tidak sama.');

    signupBtn.disabled = true;
    signupBtn.textContent = 'Mengirim...';
    try {
        const res = await fetch('api/signup', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, password })
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
            showSignupError(data.error || 'Pengajuan gagal. Coba lagi.');
            return;
        }
        signupCard.reset();
        signupOk.textContent = SIGNUP_OK_TEXT;
        signupOk.style.display = 'block';
    } catch (err) {
        showSignupError('Tidak bisa menghubungi server. Cek koneksi ke dashboard, lalu coba lagi.');
    } finally {
        signupBtn.disabled = false;
        signupBtn.textContent = 'Kirim pengajuan';
    }
});
