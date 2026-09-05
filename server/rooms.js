/* =========================================================
   КОМНАТЫ
   Реестр столов, вход и выход игроков, общий тик.
========================================================= */

const game = require("./game");
const store = require("./store");

const RECONNECT_MS = Number(process.env.RECONNECT_MS || 90000);
const TICK_MS = 250;
const ROOM_TTL_MS = 3 * 60 * 60 * 1000;

const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

const rooms = new Map();

let onUpdate = () => {};

function setUpdateHandler(fn) { onUpdate = fn; }


/* ---------- создание ---------- */

function makeCode() {
    let code;

    do {
        code = "";
        for (let i = 0; i < 4; i++) {
            code += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
        }
    } while (rooms.has(code));

    return code;
}

function blankRoom(code) {
    return {
        code,
        hostId: null,
        phase: "lobby",
        startingChips: 100,

        players: [],
        spectators: [],
        departed: {},

        dealerIndex: 0,
        roundId: 0,
        turnSeq: 0,

        snapshot: {},
        maxStack: 0,
        dealerMin: 0,
        betMin: 0,

        cups: [],
        auction: null,
        betting: null,
        order: [],
        orderPos: 0,

        deadline: 0,
        revealAt: 0,

        message: "",
        note: "",
        results: null,
        standings: null,

        lastActivity: Date.now()
    };
}

function create() {
    const room = blankRoom(makeCode());
    rooms.set(room.code, room);
    return room;
}

function get(code) {
    return rooms.get(String(code || "").toUpperCase().trim());
}


/* ---------- вход ---------- */

function join(room, playerId, name, watch) {
    const existing = game.at(room, playerId);

    if (existing) {
        existing.connected = true;
        existing.offlineAt = null;
        existing.name = name;
        return { role: "player" };
    }

    const canSit = room.phase === "lobby"
        && room.players.length < game.MAX_PLAYERS
        && !watch
        && !room.departed[playerId];

    if (canSit) {
        room.players.push({
            id: playerId,
            name,
            chips: room.startingChips,
            connected: true,
            offlineAt: null
        });

        if (!room.hostId) room.hostId = playerId;

        return { role: "player" };
    }

    room.spectators = room.spectators.filter(s => s.id !== playerId);
    room.spectators.push({ id: playerId, name });

    return { role: "spectator" };
}

/* обрыв связи: место держится, пока идёт отсчёт возвращения */
function markOffline(room, playerId) {
    room.spectators = room.spectators.filter(s => s.id !== playerId);

    const player = game.at(room, playerId);

    if (!player) return;

    if (room.phase === "lobby") {
        const fx = [];
        game.dropPlayer(room, playerId, fx);
        delete room.departed[playerId];
        return;
    }

    player.connected = false;
    player.offlineAt = Date.now();
}

/* осознанный выход: место освобождается сразу и навсегда */
function leave(room, playerId) {
    room.spectators = room.spectators.filter(s => s.id !== playerId);

    const fx = [];
    game.dropPlayer(room, playerId, fx);

    return fx;
}


/* ---------- общий цикл ---------- */

function everyRoom(fn) {
    rooms.forEach(fn);
}

function tick() {
    const now = Date.now();

    rooms.forEach((room, code) => {
        if (now - room.lastActivity > ROOM_TTL_MS) {
            rooms.delete(code);
            return;
        }

        const fx = [];
        let changed = false;

        const lost = room.players.filter(
            p => !p.connected && p.offlineAt && now - p.offlineAt > RECONNECT_MS
        );

        lost.forEach(p => {
            game.dropPlayer(room, p.id, fx);
            changed = true;
        });

        if (game.tick(room, fx)) changed = true;

        if (changed) {
            room.lastActivity = now;
            onUpdate(room, fx);
            store.scheduleSave(snapshot);
        }
    });
}

function touch(room) {
    room.lastActivity = Date.now();
    store.scheduleSave(snapshot);
}


/* ---------- сохранение ---------- */

function snapshot() {
    return Array.from(rooms.values());
}

function restore() {
    const saved = store.load();
    let count = 0;

    saved.forEach(data => {
        if (!data || !data.code) return;

        const room = Object.assign(blankRoom(data.code), data);

        // после перезапуска все считаются отключившимися,
        // а ход продлевается, чтобы никто не вылетел по таймеру
        room.players.forEach(p => {
            p.connected = false;
            p.offlineAt = Date.now();
        });

        room.spectators = [];

        if (room.deadline) room.deadline = Date.now() + game.TURN_MS;
        if (room.revealAt) room.revealAt = Date.now() + game.REVEAL_MS;

        rooms.set(room.code, room);
        count++;
    });

    return count;
}

setInterval(tick, TICK_MS);

module.exports = {
    RECONNECT_MS,
    rooms, create, get, join, leave, markOffline,
    everyRoom, touch, restore, snapshot, setUpdateHandler
};
