// ============================================================
// DEADMAN SWITCH (khusus akun master - lihat auth-ui.js, dipasang di index.html)
// ============================================================
// PRANK: setelah ketik HAPUS & tekan Ya, cuma muncul pop-up "PRANK!" -
// tidak ada yang benar-benar dihapus / dikirim ke server atau ESP32.
// Butuh showConfirmModal() dari JS_Monitoring.js - script ini WAJIB dimuat
// SESUDAHNYA (lihat urutan <script> di index.html).
function deadmanSwitchClick() {
    showConfirmModal('Apakah Anda Yakin?', showPrankModal,
        'Ini akan menghapus semua program yang ada dan akan mengganti program pada ESP32 menjadi dummy.', 'HAPUS');
}

function showPrankModal() {
    document.getElementById('prankModalOverlay').classList.add('active');
}

function closePrankModal() {
    document.getElementById('prankModalOverlay').classList.remove('active');
}
