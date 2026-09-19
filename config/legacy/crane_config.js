// ============================================================
// DAFTAR CRANE & GEARBOX - satu sumber untuk dashboard, halaman laporan, dan script Node
// ============================================================
// Di browser tersedia sebagai window.CraneConfig, di Node lewat require('./crane_config').
//
// - CUSTOM_CRANES : semua crane (nama, lokasi, nama gearbox). Urutan = nomor crane.
// - MQTT_CRANE_MAP: crane yang SUDAH terpasang sensor. Crane yang barisnya masih
//                   ter-comment tampil "Belum Terpasang" di dashboard.

(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.CraneConfig = factory();
})(typeof self !== 'undefined' ? self : this, function () {
    // Fallback kalau suatu saat ada crane baru ditambahkan tanpa properti "gearboxes"
    // sendiri. Untuk crane yang SUDAH ada di CUSTOM_CRANES, edit langsung "name" &
    // "sparepart" di masing-masing objek gearboxes-nya di bawah — bebas beda-beda
    // per crane, tidak lagi harus seragam.
    const DEFAULT_GEARBOXES = [
        { name: "GB 01 - Main Hoist"},
        { name: "GB 02 - Aux Hoist"},
        { name: "GB 03 - Trolley North"},
        { name: "GB 04 - Trolley South"},
        { name: "GB 05 - Bridge East"},
    ];

    // Data & topik MQTT persis mengikuti sheet "Crane ID": mqttId = kolom A,
    // mqttTopic = kolom B, name = kolom C, location = kolom D.
    const CUSTOM_CRANES = [
        {
            mqttId: "crane-01", mqttTopic: "pabrik/twb/crane-01/temp",
            name: "1. Crane 15 Ton Produksi - TWB", location: "Plant TWB",
            gearboxes: [
                { name: "GB 01 - East Travel"},
                { name: "GB 02 - West Travel"},
                { name: "GB 03 - South Travel"},
                { name: "GB 04 - North Travel"},
                { name: "GB 05 - Up and Down Travel"},
            ]
        },
        {
            mqttId: "crane-02", mqttTopic: "pabrik/cbk/crane-02/temp",
            name: "2. Crane Double Hoist 10/20 Ton Produksi - CB1", location: "Plant CBK",
            gearboxes: [
                { name: "GB 01 - Main Hoist"},
                { name: "GB 02 - Aux Hoist"},
                { name: "GB 03 - Trolley"},
                { name: "GB 04 - Long Travel A"},
                { name: "GB 05 - Long Travel B"},
            ]
        },
        {
            mqttId: "crane-03", mqttTopic: "pabrik/cbk/crane-03/temp",
            name: "3. Crane Double Hoist 10/20 Ton Produksi - CB2", location: "Plant CBK",
            gearboxes: [
                { name: "GB 01 - Main Hoist"},
                { name: "GB 02 - Aux Hoist"},
                { name: "GB 03 - Trolley"},
                { name: "GB 04 - Long Travel A"},
                { name: "GB 05 - Long Travel B"},
            ]
        },
        {
            mqttId: "crane-04", mqttTopic: "pabrik/cck/crane-04/temp",
            name: "4. Crane 15 Ton - MCY Tengah", location: "Plant CCK",
            gearboxes: [
                { name: "GB 01 - Main Hoist"},
                { name: "GB 02 - Aux Hoist"},
                { name: "GB 03 - Trolley"},
                { name: "GB 04 - Long Travel A"},
                { name: "GB 05 - Long Travel B"},
            ]
        },
        {
            mqttId: "crane-05", mqttTopic: "pabrik/cck/crane-05/temp",
            name: "5. Crane 3 Ton (Semy Gantry) - Produksi GS", location: "Plant CCK",
            gearboxes: [
                { name: "GB 01 - Main Hoist"},
                { name: "GB 02 - Aux Hoist"},
                { name: "GB 03 - Trolley"},
                { name: "GB 04 - Long Travel A"},
                { name: "GB 05 - Long Travel B"},
            ]
        },
        {
            mqttId: "crane-06", mqttTopic: "pabrik/cck/crane-06/temp",
            name: "6. Crane 5 Ton PDY Hoop", location: "Plant CCK",
            gearboxes: [
                { name: "GB 01 - Main Hoist"},
                { name: "GB 02 - Aux Hoist"},
                { name: "GB 03 - Trolley"},
                { name: "GB 04 - Long Travel A"},
                { name: "GB 05 - Long Travel B"},
            ]
        },
        {
            mqttId: "crane-07", mqttTopic: "pabrik/tkg/crane-07/temp",
            name: "7. Crane 25 Ton - MCY TKG", location: "Plant TKG",
            gearboxes: [
                { name: "GB 01 - Main Hoist"},
                { name: "GB 02 - Aux Hoist"},
                { name: "GB 03 - Trolley"},
                { name: "GB 04 - Long Travel A"},
                { name: "GB 05 - Long Travel B"},
            ]
        },
        {
            mqttId: "crane-08", mqttTopic: "pabrik/tkg/crane-08/temp",
            name: "8. Crane 15 Ton - Produksi", location: "Plant TKG",
            gearboxes: [
                { name: "GB 01 - Main Hoist"},
                { name: "GB 02 - Aux Hoist"},
                { name: "GB 03 - Trolley"},
                { name: "GB 04 - Long Travel A"},
                { name: "GB 05 - Long Travel B"},
            ]
        },
        {
            mqttId: "crane-09", mqttTopic: "pabrik/cck/crane-09/temp",
            name: "9. Crane 5 Ton (Single Girder)", location: "Plant CCK",
            gearboxes: [
                { name: "GB 01 - Main Hoist"},
                { name: "GB 02 - Aux Hoist"},
                { name: "GB 03 - Trolley"},
                { name: "GB 04 - Long Travel A"},
                { name: "GB 05 - Long Travel B"},
            ]
        },
        {
            mqttId: "crane-10", mqttTopic: "pabrik/tkg/crane-10/temp",
            name: "10. Crane 10 Ton - PDY TKG2", location: "Plant TKG",
            gearboxes: [
                { name: "GB 01 - Main Hoist"},
                { name: "GB 02 - Aux Hoist"},
                { name: "GB 03 - Trolley"},
                { name: "GB 04 - Long Travel A"},
                { name: "GB 05 - Long Travel B"},
            ]
        },
        {
            mqttId: "crane-11", mqttTopic: "pabrik/tkg/crane-11/temp",
            name: "11. Crane 10 Ton - PDY TKG", location: "Plant TKG",
            gearboxes: [
                { name: "GB 01 - Main Hoist"},
                { name: "GB 02 - Aux Hoist"},
                { name: "GB 03 - Trolley"},
                { name: "GB 04 - Long Travel A"},
                { name: "GB 05 - Long Travel B"},
            ]
        },
        {
            mqttId: "crane-12", mqttTopic: "pabrik/tkg/crane-12/temp",
            name: "12. Crane 15 Ton - MCY TKG", location: "Plant TKG",
            gearboxes: [
                { name: "GB 01 - Main Hoist"},
                { name: "GB 02 - Aux Hoist"},
                { name: "GB 03 - Trolley"},
                { name: "GB 04 - Long Travel A"},
                { name: "GB 05 - Long Travel B"},
            ]
        },
        {
            mqttId: "crane-13", mqttTopic: "pabrik/cck/crane-13/temp",
            name: "13. Nippon Hoist 3 Ton (Semy Gantry) Produksi LC/LD", location: "Plant CCK",
            gearboxes: [
                { name: "GB 01 - Main Hoist"},
                { name: "GB 02 - Aux Hoist"},
                { name: "GB 03 - Trolley"},
                { name: "GB 04 - Long Travel A"},
                { name: "GB 05 - Long Travel B"},
            ]
        },
        {
            mqttId: "crane-14", mqttTopic: "pabrik/cck/crane-14/temp",
            name: "14. Crane 5 Ton - PDY Sheet", location: "Plant CCK",
            gearboxes: [
                { name: "GB 01 - Main Hoist"},
                { name: "GB 02 - Aux Hoist"},
                { name: "GB 03 - Trolley"},
                { name: "GB 04 - Long Travel A"},
                { name: "GB 05 - Long Travel B"},
            ]
        },
        {
            mqttId: "crane-15", mqttTopic: "pabrik/cck/crane-15/temp",
            name: "15. Crane 15 Ton - MCY Slitter (SA)", location: "Plant CCK",
            gearboxes: [
                { name: "GB 01 - Main Hoist"},
                { name: "GB 02 - Aux Hoist"},
                { name: "GB 03 - Trolley"},
                { name: "GB 04 - Long Travel A"},
                { name: "GB 05 - Long Travel B"},
            ]
        },
        {
            mqttId: "crane-16", mqttTopic: "pabrik/cbk/crane-16/temp",
            name: "16. Crane 15 Ton - MCY Blanking", location: "Plant CBK",
            gearboxes: [
                { name: "GB 01 - Main Hoist"},
                { name: "GB 02 - Aux Hoist"},
                { name: "GB 03 - Trolley"},
                { name: "GB 04 - Long Travel A"},
                { name: "GB 05 - Long Travel B"},
            ]
        },
        {
            mqttId: "crane-17", mqttTopic: "pabrik/cbk/crane-17/temp",
            name: "17. Crane 15 Ton - PDY CB1", location: "Plant CBK",
            gearboxes: [
                { name: "GB 01 - Main Hoist"},
                { name: "GB 02 - Aux Hoist"},
                { name: "GB 03 - Trolley"},
                { name: "GB 04 - Long Travel A"},
                { name: "GB 05 - Long Travel B"},
            ]
        },
        {
            mqttId: "crane-18", mqttTopic: "pabrik/twb/crane-18/temp",
            name: "18. Crane 15 Ton (Single Girder) - PDY", location: "Plant TWB",
            gearboxes: [
                { name: "GB 01 - Main Hoist"},
                { name: "GB 02 - Aux Hoist"},
                { name: "GB 03 - Trolley"},
                { name: "GB 04 - Long Travel A"},
                { name: "GB 05 - Long Travel B"},
            ]
        },
        {
            mqttId: "crane-19", mqttTopic: "pabrik/cbk/crane-19/temp",
            name: "19. Nippon Hoist 5 Ton (Semy Gantry) - Turn Over CB1", location: "Plant CBK",
            gearboxes: [
                { name: "GB 01 - Main Hoist"},
                { name: "GB 02 - Aux Hoist"},
                { name: "GB 03 - Trolley"},
                { name: "GB 04 - Long Travel A"},
                { name: "GB 05 - Long Travel B"},
            ]
        },
        {
            mqttId: "crane-20", mqttTopic: "pabrik/cbk/crane-20/temp",
            name: "20. Crane 10 Ton - PDY CB2", location: "Plant CBK",
            gearboxes: [
                { name: "GB 01 - Main Hoist"},
                { name: "GB 02 - Aux Hoist"},
                { name: "GB 03 - Trolley"},
                { name: "GB 04 - Long Travel A"},
                { name: "GB 05 - Long Travel B"}
            ]
        },
        {
            mqttId: "crane-21", mqttTopic: "pabrik/cck/crane-21/temp",
            name: "21. Crane 5 Ton - Produksi LA", location: "Plant CCK",
            gearboxes: [
                { name: "GB 01 - Main Hoist"},
                { name: "GB 02 - Aux Hoist"},
                { name: "GB 03 - Trolley"},
                { name: "GB 04 - Long Travel A"},
                { name: "GB 05 - Long Travel B"}
            ]
        },
        {
            mqttId: "crane-22", mqttTopic: "pabrik/cck/crane-22/temp",
            name: "22. Crane 15 Ton - Produksi Slitter (SA)", location: "Plant CCK",
            gearboxes: [
                { name: "GB 01 - Main Hoist"},
                { name: "GB 02 - Aux Hoist"},
                { name: "GB 03 - Trolley"},
                { name: "GB 04 - Long Travel A"},
                { name: "GB 05 - Long Travel B"},
            ]
        },
        {
            mqttId: "crane-23", mqttTopic: "pabrik/cck/crane-23/temp",
            name: "23. Nippon Hoist 3 Ton (Semy Gantry) - Produksi SB", location: "Plant CCK",
            gearboxes: [
                { name: "GB 01 - Main Hoist"},
                { name: "GB 02 - Aux Hoist"},
                { name: "GB 03 - Trolley"},
                { name: "GB 04 - Long Travel A"},
                { name: "GB 05 - Long Travel B"},
            ]
        },
        {
            mqttId: "crane-24", mqttTopic: "pabrik/tkg/crane-24/temp",
            name: "24. Nippon Hoist 5 Ton (Semy Gantry) - Produksi GM", location: "Plant TKG",
            gearboxes: [
                { name: "GB 01 - Main Hoist"},
                { name: "GB 02 - Aux Hoist"},
                { name: "GB 03 - Trolley"},
                { name: "GB 04 - Long Travel A"},
                { name: "GB 05 - Long Travel B"},
            ]
        },
        {
            mqttId: "crane-25", mqttTopic: "pabrik/cbk/crane-25/temp",
            name: "25. Nippon Hoist 3 Ton (Semy Gantry) - Maintenance Dies - TOPY", location: "Plant CBK",
            gearboxes: [
                { name: "GB 01 - Main Hoist"},
                { name: "GB 02 - Aux Hoist"},
                { name: "GB 03 - Trolley"},
                { name: "GB 04 - Long Travel A"},
                { name: "GB 05 - Long Travel B"},
            ]
        }
    ];

    // Crane yang BELUM terpasang sensor sengaja dibiarkan ter-comment di sini -> tampil
    // "Belum Terpasang" di dashboard. Begitu sensornya dipasang, cukup un-comment barisnya.
    const MQTT_CRANE_MAP = {
        "crane-01": { craneId: 1, gbKeyMap: { "gb01": 1, "gb02": 2, "gb03": 3, "gb04": 4, "gb05": 5 } }

        // ,"crane-02": { craneId: 2,  gbKeyMap: { "gb01": 1, "gb02": 2, "gb03": 3, "gb04": 4, "gb05": 5 } }
        // ,"crane-03": { craneId: 3,  gbKeyMap: { "gb01": 1, "gb02": 2, "gb03": 3, "gb04": 4, "gb05": 5 } }
        // ,"crane-04": { craneId: 4,  gbKeyMap: { "gb01": 1, "gb02": 2, "gb03": 3, "gb04": 4, "gb05": 5 } }
        // ,"crane-05": { craneId: 5,  gbKeyMap: { "gb01": 1, "gb02": 2, "gb03": 3, "gb04": 4, "gb05": 5 } }
        // ,"crane-06": { craneId: 6,  gbKeyMap: { "gb01": 1, "gb02": 2, "gb03": 3, "gb04": 4, "gb05": 5 } }
        // ,"crane-07": { craneId: 7,  gbKeyMap: { "gb01": 1, "gb02": 2, "gb03": 3, "gb04": 4, "gb05": 5 } }
        // ,"crane-08": { craneId: 8,  gbKeyMap: { "gb01": 1, "gb02": 2, "gb03": 3, "gb04": 4, "gb05": 5 } }
        // ,"crane-09": { craneId: 9,  gbKeyMap: { "gb01": 1, "gb02": 2, "gb03": 3, "gb04": 4, "gb05": 5 } }
        // ,"crane-10": { craneId: 10, gbKeyMap: { "gb01": 1, "gb02": 2, "gb03": 3, "gb04": 4, "gb05": 5 } }
        // ,"crane-11": { craneId: 11, gbKeyMap: { "gb01": 1, "gb02": 2, "gb03": 3, "gb04": 4, "gb05": 5 } }
        // ,"crane-12": { craneId: 12, gbKeyMap: { "gb01": 1, "gb02": 2, "gb03": 3, "gb04": 4, "gb05": 5 } }
        // ,"crane-13": { craneId: 13, gbKeyMap: { "gb01": 1, "gb02": 2, "gb03": 3, "gb04": 4, "gb05": 5 } }
        // ,"crane-14": { craneId: 14, gbKeyMap: { "gb01": 1, "gb02": 2, "gb03": 3, "gb04": 4, "gb05": 5 } }
        // ,"crane-15": { craneId: 15, gbKeyMap: { "gb01": 1, "gb02": 2, "gb03": 3, "gb04": 4, "gb05": 5 } }
        // ,"crane-16": { craneId: 16, gbKeyMap: { "gb01": 1, "gb02": 2, "gb03": 3, "gb04": 4, "gb05": 5 } }
        // ,"crane-17": { craneId: 17, gbKeyMap: { "gb01": 1, "gb02": 2, "gb03": 3, "gb04": 4, "gb05": 5 } }
        // ,"crane-18": { craneId: 18, gbKeyMap: { "gb01": 1, "gb02": 2, "gb03": 3, "gb04": 4, "gb05": 5 } }
        // ,"crane-19": { craneId: 19, gbKeyMap: { "gb01": 1, "gb02": 2, "gb03": 3, "gb04": 4, "gb05": 5 } }
        // ,"crane-20": { craneId: 20, gbKeyMap: { "gb01": 1, "gb02": 2, "gb03": 3, "gb04": 4, "gb05": 5 } }
        // ,"crane-21": { craneId: 21, gbKeyMap: { "gb01": 1, "gb02": 2, "gb03": 3, "gb04": 4, "gb05": 5 } }
        // ,"crane-22": { craneId: 22, gbKeyMap: { "gb01": 1, "gb02": 2, "gb03": 3, "gb04": 4, "gb05": 5 } }
        // ,"crane-23": { craneId: 23, gbKeyMap: { "gb01": 1, "gb02": 2, "gb03": 3, "gb04": 4, "gb05": 5 } }
        // ,"crane-24": { craneId: 24, gbKeyMap: { "gb01": 1, "gb02": 2, "gb03": 3, "gb04": 4, "gb05": 5 } }
        // ,"crane-25": { craneId: 25, gbKeyMap: { "gb01": 1, "gb02": 2, "gb03": 3, "gb04": 4, "gb05": 5 } }
    };

    // Daftar crane siap pakai: id MQTT, nama, status terpasang, dan tiap gearbox
    // dengan key MQTT-nya (gb01, gb02, ...) - key inilah yang dipakai data & alarm.
    function listCranes() {
        return CUSTOM_CRANES.map((crane, index) => {
            const mapping = MQTT_CRANE_MAP[crane.mqttId];
            const keyByPosition = {};
            if (mapping) Object.entries(mapping.gbKeyMap).forEach(([key, pos]) => { keyByPosition[pos] = key; });
            return {
                id: crane.mqttId,
                number: index + 1,
                name: crane.name,
                location: crane.location,
                installed: !!mapping && mapping.craneId === index + 1,
                gearboxes: (crane.gearboxes || DEFAULT_GEARBOXES).map((gb, i) => ({
                    key: keyByPosition[i + 1] || `gb${String(i + 1).padStart(2, '0')}`,
                    name: gb.name
                }))
            };
        });
    }

    return { DEFAULT_GEARBOXES, CUSTOM_CRANES, MQTT_CRANE_MAP, listCranes };
});
