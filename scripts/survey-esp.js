// ============================================================
// SURVEI JARINGAN PAKAI ESP32 SEBAGAI ALAT UKUR (1 ESP32 + powerbank dibawa keliling crane)
// ============================================================
// PC server tetap di tempat dan merekam semua yang dilaporkan ESP32 itu. Dua langkah:
//
//  1) REKAM  - biarkan jalan di PC selama survei (jangan ditutup):
//        node scripts\survey-esp.js rekam crane-30
//     Mencatat tiap pesan status (sinyal, access point, channel, uptime, penyebab restart) dan
//     waktu tiap pesan data suhu yang sampai. Hasil: survey-esp-crane-30.csv
//
//  2) RINGKAS - setelah selesai. Catat JAM tiba & pergi di tiap titik (pakai jam HP), lalu:
//        node scripts\survey-esp.js ringkas crane-30 "10:05-10:15=0m" "10:20-10:30=25m" "10:35-10:45=50m"
//     Tiap jendela waktu dinilai BAIK / CUKUP / BURUK dari: sinyal rata-rata, persen pesan data yang
//     sampai (ESP32 mengirim tiap 5 detik), jeda terpanjang, perpindahan access point, dan restart.
//
// Tips: biarkan ESP32 diam 10 menit di tiap titik, di ketinggian dan posisi yang sama dengan rencana pasang.
// Jangan dimasukkan ke box logam. Powerbank: pilih yang tidak mati sendiri saat arus kecil.

const fs = require('fs');
const path = require('path');
const mqtt = require(path.join(__dirname, '..', 'node_modules', 'mqtt'));

const [cmd, craneId, ...rest] = process.argv.slice(2);
if (!['rekam', 'ringkas'].includes(cmd) || !craneId) {
    console.log('Pakai:\n  node scripts\\survey-esp.js rekam crane-30\n  node scripts\\survey-esp.js ringkas crane-30 "10:05-10:15=0m" "10:20-10:30=25m"');
    process.exit(1);
}
const FILE = path.join(__dirname, '..', `survey-esp-${craneId}.csv`);

if (cmd === 'rekam') {
    if (!fs.existsSync(FILE)) fs.writeFileSync(FILE, 'ms,tipe,rssi,ap,ch,uptime_s,rst\n');
    const c = mqtt.connect('mqtt://127.0.0.1:1883', { clientId: 'survey-' + Math.random().toString(16).slice(2, 8) });
    let n = 0;
    c.on('connect', () => {
        console.log(`Merekam ${craneId} -> ${FILE}\n(Ctrl+C untuk berhenti)`);
        c.subscribe([`pabrik/+/${craneId}/status`, `pabrik/+/${craneId}/temp`]);
    });
    c.on('message', (t, p) => {
        const now = Date.now();
        if (t.endsWith('/temp')) {
            fs.appendFileSync(FILE, `${now},temp,,,,,\n`);
        } else {
            let i = {};
            try { i = JSON.parse(p.toString()); } catch (e) { return; }
            if (i.online === false) { fs.appendFileSync(FILE, `${now},putus,,,,,\n`); return; }
            fs.appendFileSync(FILE, `${now},status,${i.rssi ?? ''},${i.ap ?? ''},${i.ch ?? ''},${i.uptime_s ?? ''},${i.rst ?? ''}\n`);
        }
        if (++n % 12 === 0) process.stdout.write(`\r${new Date().toLocaleTimeString('sv-SE')}  ${n} pesan tercatat   `);
    });
    c.on('error', e => console.error('MQTT error:', e.message));
    return;
}

// ---- ringkas ----
if (!fs.existsSync(FILE)) { console.error(`Belum ada ${FILE}. Jalankan "rekam" dulu selama survei.`); process.exit(1); }
const rows = fs.readFileSync(FILE, 'utf-8').trim().split('\n').slice(1).map(l => {
    const [ms, tipe, rssi, ap, ch, up, rst] = l.split(',');
    return { ms: Number(ms), tipe, rssi: rssi === '' ? null : Number(rssi), ap, ch, up: up === '' ? null : Number(up), rst };
});
const today = new Date();
const hm = s => {
    const [h, m] = s.split(':').map(Number);
    return new Date(today.getFullYear(), today.getMonth(), today.getDate(), h, m, 0).getTime();
};

console.log(`\nRingkasan survei ${craneId}  (${rows.length} baris data)\n`);
const out = [];
for (const w of rest) {
    const m = w.match(/^(\d{1,2}:\d{2})-(\d{1,2}:\d{2})=(.+)$/);
    if (!m) { console.log(`Format salah: "${w}" (harus "10:05-10:15=nama")`); continue; }
    const from = hm(m[1]), to = hm(m[2]), label = m[3];
    const inWin = rows.filter(r => r.ms >= from && r.ms <= to);
    const temps = inWin.filter(r => r.tipe === 'temp').map(r => r.ms).sort((a, b) => a - b);
    const sts = inWin.filter(r => r.tipe === 'status');
    const rssis = sts.map(r => r.rssi).filter(v => v !== null);
    const expected = Math.max(1, Math.floor((to - from) / 5000));
    const received = Math.min(temps.length, expected);
    let maxGap = 0, gaps = 0;
    for (let i = 1; i < temps.length; i++) { const g = temps[i] - temps[i - 1]; if (g > 12000) { gaps++; maxGap = Math.max(maxGap, g); } }
    if (temps.length && temps[0] - from > 12000) { gaps++; maxGap = Math.max(maxGap, temps[0] - from); }
    if (temps.length && to - temps[temps.length - 1] > 12000) { gaps++; maxGap = Math.max(maxGap, to - temps[temps.length - 1]); }
    if (!temps.length) { gaps = 1; maxGap = to - from; }
    const aps = [...new Set(sts.map(r => r.ap).filter(Boolean))];
    let restarts = 0;
    for (let i = 1; i < sts.length; i++) if (sts[i].up !== null && sts[i - 1].up !== null && sts[i].up + 5 < sts[i - 1].up) restarts++;
    const putus = inWin.filter(r => r.tipe === 'putus').length;
    const avg = rssis.length ? Math.round(rssis.reduce((a, b) => a + b, 0) / rssis.length) : null;
    const min = rssis.length ? Math.min(...rssis) : null;
    const pct = Math.round(100 * received / expected);
    let nilai = 'BURUK';
    if (avg !== null && avg >= -67 && pct >= 97 && restarts === 0 && putus === 0 && maxGap <= 15000) nilai = 'BAIK';
    else if (avg !== null && avg >= -75 && pct >= 90 && restarts <= 1) nilai = 'CUKUP';
    out.push({ label, nilai, avg, min, pct, gaps, maxGap: Math.round(maxGap / 1000), aps, restarts, putus, rst: [...new Set(sts.map(r => r.rst).filter(Boolean))].join('/') });
}
for (const o of out) {
    console.log(`${o.label.padEnd(16)} ${o.nilai.padEnd(6)} sinyal rata-rata ${o.avg} dBm (terlemah ${o.min}) | data sampai ${o.pct}% | jeda terpanjang ${o.maxGap} dtk (${o.gaps}x) | AP: ${o.aps.length ? o.aps.join(', ') : '-'}${o.aps.length > 1 ? '  <- pindah AP' : ''} | restart ${o.restarts}${o.rst ? ' (' + o.rst + ')' : ''}${o.putus ? ' | putus ' + o.putus + 'x' : ''}`);
}
if (!out.length) console.log('Tidak ada jendela waktu. Contoh: "10:05-10:15=0m"');
