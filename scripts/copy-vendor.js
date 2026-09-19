// Salin library front-end dari node_modules ke folder vendor/ supaya dashboard
// tidak butuh internet (CDN) - PC/TV di jaringan pabrik sering tanpa akses internet.
// Jalankan ulang setelah update versi library:  npm run vendor

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const copies = [
    ['node_modules/chart.js/dist/chart.umd.min.js', 'vendor/chart.umd.min.js'],
    ['node_modules/mqtt/dist/mqtt.min.js', 'vendor/mqtt.min.js'],
    ['node_modules/exceljs/dist/exceljs.min.js', 'vendor/exceljs.min.js'], // download Excel di halaman laporan
    ['node_modules/@fortawesome/fontawesome-free/css/all.min.css', 'vendor/fontawesome/css/all.min.css'],
    ['node_modules/@fortawesome/fontawesome-free/webfonts', 'vendor/fontawesome/webfonts']
];

copies.forEach(([src, dest]) => {
    const from = path.join(root, src);
    const to = path.join(root, dest);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.cpSync(from, to, { recursive: true });
    console.log(`[vendor] ${src} -> ${dest}`);
});
