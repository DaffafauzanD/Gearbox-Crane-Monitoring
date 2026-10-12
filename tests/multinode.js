// ============================================================
// TES SATUAN: beberapa ESP32 di satu crane  -  dijalankan oleh `npm test` (sebelum smoke.js)
// ============================================================
// Tanpa broker & tanpa server: menguji langsung logika yang menentukan
//   - ID perangkat ("crane-01" / "crane-01_2") -> crane induk + nomor node
//   - pembagian motor antar ESP32 (dipelajari dari data), sensor dipindah, key bentrok
//   - Last Will satu ESP32 hanya membuat motor milik ESP itu offline
// Database & folder alarm memakai salinan sementara - data asli tidak tersentuh.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const AlarmRules = require('../alarm_rules');
const { DeviceRegistry } = require('../devices');
const { AlarmEngine } = require('../alarm_engine');

let total = 0;
let failed = 0;
function check(name, ok, extra = '') {
    total++;
    if (!ok) failed++;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && extra ? '  -> ' + extra : ''}`);
}

// ---- ID perangkat ----
const p = AlarmRules.parseDeviceId;
check('ID crane biasa = ESP utama (node 1)', JSON.stringify(p('crane-01')) === JSON.stringify({ craneId: 'crane-01', node: 1 }));
check('crane-01_2 = crane-01 node 2', JSON.stringify(p('crane-01_2')) === JSON.stringify({ craneId: 'crane-01', node: 2 }));
check('crane-01_1 ditolak (node 1 tanpa akhiran)', p('crane-01_1') === null);
check('ID aneh ditolak', p('crane_01_2') === null && p('../x') === null && p('') === null && p('crane-01_100') === null);
check('deviceIdOf bolak-balik', AlarmRules.deviceIdOf('crane-01', 1) === 'crane-01' && AlarmRules.deviceIdOf('crane-01', 3) === 'crane-01_3');

// ---- registry: pembagian motor ----
const db = new DatabaseSync(':memory:');
const reg = new DeviceRegistry(db);
let t = 1_000_000;
reg.seenData('crane-01', 'ccc', ['m1', 'm2', 'm3'], t);
reg.seenData('crane-01_2', 'ccc', ['m4', 'm5'], t + 1000);
const a = reg.devices.get('crane-01');
const b = reg.devices.get('crane-01_2');
check('dua ESP32 tercatat terpisah', reg.ofCrane('crane-01').length === 2 && b.craneId === 'crane-01' && b.node === 2);
check('motor per ESP32 sesuai data', a.gbKeys.join() === 'm1,m2,m3' && b.gbKeys.join() === 'm4,m5');
check('tidak ada bentrok', !Object.keys(a.conflicts).length && !Object.keys(b.conflicts).length);

// Sensor m3 dipindah ke ESP 2 (ESP utama sudah > 2 menit tidak mengirim m3)
t += 5 * 60 * 1000;
reg.seenData('crane-01', 'ccc', ['m1', 'm2'], t);
reg.seenData('crane-01_2', 'ccc', ['m3', 'm4', 'm5'], t + 1000);
check('sensor dipindah: m3 ikut pindah ke ESP 2', a.gbKeys.join() === 'm1,m2' && b.gbKeys.join() === 'm3,m4,m5', `${a.gbKeys} | ${b.gbKeys}`);

// Dua ESP32 mengirim key yang sama bersamaan -> bentrok
reg.seenData('crane-01', 'ccc', ['m1', 'm2', 'm3'], t + 2000);
check('key sama dari 2 ESP32 = bentrok di keduanya', a.conflicts.m3 && a.conflicts.m3.with === 'crane-01_2' && b.conflicts.m3 && b.conflicts.m3.with === 'crane-01');

// Tersimpan & terbaca ulang dari database
reg.flush();
const reg2 = new DeviceRegistry(db);
check('dibaca ulang dari database: node & crane induk benar', reg2.devices.get('crane-01_2').node === 2 && reg2.devices.get('crane-01_2').craneId === 'crane-01');

// ---- Last Will per ESP32 ----
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gbx-multinode-'));
const config = {
    defaults: {},
    cranes: [{ id: 'crane-01', area: 'ccc', installed: true, gearboxes: ['m1', 'm2', 'm3', 'm4', 'm5'].map(key => ({ key, name: key })) }]
};
const engine = new AlarmEngine({ config, dir: tmp });
const now = Date.now();
['m1', 'm2', 'm3', 'm4', 'm5'].forEach(k => engine.ingest('crane-01', k, 50, now));
engine.deviceOffline('crane-01', now + 1000, ['m4', 'm5']);
const offline = engine.snapshot().active.filter(x => x.type === 'offline').map(x => x.gbKey).sort();
check('Last Will ESP 2 hanya membuat m4 & m5 offline', offline.join() === 'm4,m5', offline.join());
engine.deviceOffline('crane-01', now + 2000);
const all = engine.snapshot().active.filter(x => x.type === 'offline').length;
check('tanpa daftar motor (firmware lama) = semua motor crane offline', all === 5, String(all));
fs.rmSync(tmp, { recursive: true, force: true });

console.log(`\n${total - failed}/${total} lolos`);
process.exit(failed ? 1 : 0);
