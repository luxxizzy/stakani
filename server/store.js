/* =========================================================
   ХРАНЕНИЕ
   Комнаты пишутся в обычный json-файл рядом с проектом,
   чтобы перезапуск сервера не убивал партию.
========================================================= */

const fs = require("fs");
const path = require("path");

const FILE = process.env.STATE_FILE
    || path.join(__dirname, "..", "data", "rooms.json");

let saveTimer = null;

function load() {
    try {
        const raw = fs.readFileSync(FILE, "utf8");
        const data = JSON.parse(raw);

        if (!data || !Array.isArray(data.rooms)) return [];

        return data.rooms;

    } catch (e) {
        return [];
    }
}

/* пишем не чаще раза в секунду: партия меняется часто, диск медленный */
function scheduleSave(getRooms) {
    if (saveTimer) return;

    saveTimer = setTimeout(() => {
        saveTimer = null;
        save(getRooms());
    }, 1000);
}

function save(rooms) {
    try {
        fs.mkdirSync(path.dirname(FILE), { recursive: true });

        const payload = JSON.stringify({
            savedAt: Date.now(),
            rooms
        });

        fs.writeFileSync(FILE + ".tmp", payload);
        fs.renameSync(FILE + ".tmp", FILE);

    } catch (e) {
        console.error("не удалось сохранить состояние:", e.message);
    }
}

module.exports = { load, save, scheduleSave, FILE };
