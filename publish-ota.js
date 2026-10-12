// ============================================================
// PUBLISH FIRMWARE OTA (lewat terminal) - salin file .bin hasil compile Arduino
// IDE ke firmware-ota/<craneId>/, lalu perbarui manifest.json crane itu (versi,
// ukuran, checksum). Firmware KHUSUS crane yang disebut - crane lain tidak ikut
// berubah, supaya bisa uji coba di 1 crane dulu sebelum disebar ke yang lain.
// ============================================================
// Cara yang lebih gampang: buka halaman Pengaturan di dashboard, expand crane
// yang mau di-update, ada kotak drag-and-drop di situ - tidak perlu buka
// terminal sama sekali. Script ini cuma alternatif kalau kamu lebih suka lewat
// command line / mau diotomatisasi (mis. publish ke banyak crane sekaligus lewat
// script lain yang memanggil ini berulang).
//
// Cara pakai:
//   1. Di Arduino IDE: Sketch -> Export Compiled Binary (hasilnya .bin
//      muncul di folder sketch firmware/GBXMQTT/build/.../GBXMQTT.ino.bin)
//   2. npm run publish-ota -- "path/ke/GBXMQTT.ino.bin" crane-01 2.1.0 "Nama PIC"
//      (nama PIC opsional, tapi disarankan supaya tercatat sama seperti upload
//      lewat halaman Pengaturan)
//   3. Buka halaman Pengaturan -> expand crane itu -> klik "Update" - ESP32
//      akan mengunduh & memasang sendiri lewat WiFi.
//
// PENTING: naikkan FW_VERSION di firmware/GBXMQTT/GBXMQTT.ino SEBELUM compile,
// supaya versi yang tercatat di sini sama dengan yang benar-benar berjalan di
// ESP32 setelah update (dipakai buat bandingkan "sudah terbaru / belum" di
// halaman Pengaturan).

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const OTA_DIR = path.join(ROOT, 'firmware-ota');

function fail(msg) {
    console.error(`[publish-ota] ${msg}`);
    process.exit(1);
}

async function main() {
    const [, , srcPathArg, craneIdArg, versionArg, uploadedByArg] = process.argv;
    if (!srcPathArg || !craneIdArg || !versionArg) {
        fail('Cara pakai: npm run publish-ota -- "path/ke/GBXMQTT.ino.bin" crane-01 2.1.0 "Nama PIC"');
    }
    if (!/^[\w-]+$/.test(craneIdArg)) {
        fail(`ID crane "${craneIdArg}" tidak valid - cuma huruf, angka, "-", "_" (samakan dengan ID di halaman Pengaturan).`);
    }
    if (!/^\d+\.\d+\.\d+$/.test(versionArg)) {
        fail(`Format versi "${versionArg}" tidak dikenali - pakai format angka.angka.angka, contoh: 2.1.0`);
    }

    const srcPath = path.resolve(srcPathArg);
    if (!fs.existsSync(srcPath) || !fs.statSync(srcPath).isFile()) {
        fail(`File tidak ditemukan: ${srcPath}`);
    }
    if (path.extname(srcPath).toLowerCase() !== '.bin') {
        fail(`File harus .bin (hasil "Export Compiled Binary" di Arduino IDE), bukan: ${path.basename(srcPath)}`);
    }

    const craneDir = path.join(OTA_DIR, craneIdArg);
    const binTarget = path.join(craneDir, 'GBXMQTT.bin');
    const manifestFile = path.join(craneDir, 'manifest.json');

    fs.mkdirSync(craneDir, { recursive: true });
    fs.copyFileSync(srcPath, binTarget);

    const buf = fs.readFileSync(binTarget);
    const sha256 = crypto.createHash('sha256').update(buf).digest('hex');

    let previous = null;
    try { previous = JSON.parse(fs.readFileSync(manifestFile, 'utf-8')); } catch (e) { /* belum ada manifest sebelumnya untuk crane ini */ }

    const manifest = {
        craneId: craneIdArg,
        version: versionArg,
        file: 'GBXMQTT.bin',
        sizeBytes: buf.length,
        sha256,
        releasedAt: new Date().toISOString(),
        uploadedBy: (uploadedByArg || '').trim().slice(0, 40) || null,
        previousVersion: previous ? previous.version : null
    };
    fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2) + '\n');

    console.log(`[publish-ota] Firmware v${versionArg} untuk "${craneIdArg}" siap disebar (${(buf.length / 1024).toFixed(1)} KB).`);
    console.log(`[publish-ota] Tersimpan di: ${binTarget}`);
    console.log(`[publish-ota] Buka halaman Pengaturan -> expand "${craneIdArg}" -> klik "Update" untuk memicu.`);
}

main();