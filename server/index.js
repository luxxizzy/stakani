/* =========================================================
   TUMBLERS — сервер
   Транспорт и разбор сообщений. Правила лежат в game.js.
========================================================= */

const path = require("path");
const http = require("http");
const express = require("express");
const { WebSocketServer } = require("ws");

const game = require("./game");
const rooms = require("./rooms");
const store = require("./store");

const VERSION = "3.3.0";
const PORT = process.env.PORT || 3000;

const RATE_WINDOW_MS = 10000;
const RATE_LIMIT = 40;

const app = express();

app.use(express.static(path.join(__dirname, "..", "public")));
app.get("/healthz", (req, res) => res.json({ ok: true, version: VERSION }));

const server = http.createServer(app);
const wss = new WebSocketServer({ server });


/* ---------- рассылка ---------- */

function broadcast(room, fx) {
    const payload = fx || [];

    wss.clients.forEach(ws => {
        if (ws.roomCode === room.code && ws.readyState === ws.OPEN) {
            ws.send(JSON.stringify(game.viewFor(room, ws.playerId, payload, VERSION)));
        }
    });
}

function push(room, message) {
    const payload = JSON.stringify(message);

    wss.clients.forEach(ws => {
        if (ws.roomCode === room.code && ws.readyState === ws.OPEN) {
            ws.send(payload);
        }
    });
}

function reply(ws, message) {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(message));
}

const fail = (ws, msg) => reply(ws, { t: "error", msg });

rooms.setUpdateHandler(broadcast);


/* ---------- журнал ---------- */

function note(room, text) {
    console.log("[" + room.code + "] " + text);
}


/* ---------- соединения ---------- */

wss.on("connection", ws => {
    ws.isAlive = true;
    ws.hits = [];

    ws.on("pong", () => { ws.isAlive = true; });

    ws.on("message", raw => {
        const now = Date.now();
        ws.hits = ws.hits.filter(t => now - t < RATE_WINDOW_MS);

        if (ws.hits.length >= RATE_LIMIT) return;

        ws.hits.push(now);

        let msg;

        try {
            msg = JSON.parse(raw);
        } catch (e) {
            return;
        }

        try {
            handle(ws, msg);
        } catch (e) {
            console.error("ошибка обработки:", e);
            fail(ws, "Что-то пошло не так, обнови страницу");
        }
    });

    ws.on("close", () => {
        const room = rooms.get(ws.roomCode);

        if (!room) return;

        rooms.markOffline(room, ws.playerId);
        rooms.touch(room);
        broadcast(room, []);
    });
});


/* ---------- вход ---------- */

function handleEntry(ws, msg) {
    const name = String(msg.name || "").trim().slice(0, 20) || "Игрок";
    const playerId = String(msg.playerId || "").slice(0, 64);

    if (!playerId) return fail(ws, "Нет идентификатора игрока");

    let room;

    if (msg.t === "create") {
        room = rooms.create();
        room.hostId = playerId;
        note(room, "комната создана");
    } else {
        room = rooms.get(msg.code);
        if (!room) return fail(ws, "Комната не найдена");
    }

    const { role } = rooms.join(room, playerId, name, !!msg.watch);

    ws.roomCode = room.code;
    ws.playerId = playerId;

    note(room, name + " вошёл как " + (role === "player" ? "игрок" : "наблюдатель"));

    reply(ws, { t: "joined", code: room.code, role });

    rooms.touch(room);
    broadcast(room, []);
}


/* ---------- игровые сообщения ---------- */

function handle(ws, msg) {
    if (msg.t === "create" || msg.t === "join") return handleEntry(ws, msg);

    const room = rooms.get(ws.roomCode);

    if (!room) return fail(ws, "Комната не найдена, обнови страницу");

    const player = game.at(room, ws.playerId);
    const isHost = room.hostId === ws.playerId;
    const myMove = game.activePlayer(room) === ws.playerId;

    rooms.touch(room);

    if (msg.t === "react") {
        return push(room, {
            t: "fx",
            fx: [{
                kind: "react",
                playerId: ws.playerId,
                emoji: String(msg.emoji || "").slice(0, 4)
            }]
        });
    }

    if (msg.t === "leave") {
        reply(ws, { t: "left" });

        const fx = rooms.leave(room, ws.playerId);

        note(room, (player ? player.name : "наблюдатель") + " вышел");

        ws.roomCode = null;
        return broadcast(room, fx);
    }

    if (msg.t === "start") {
        if (!isHost) return fail(ws, "Игру начинает создатель комнаты");
        if (room.phase !== "lobby") return fail(ws, "Партия уже идёт");
        if (room.players.length < game.MIN_PLAYERS) return fail(ws, "Нужно минимум 2 игрока");

        const chips = Math.floor(Number(msg.startingChips));

        if (!Number.isFinite(chips) || chips < 10) return fail(ws, "Стартовый банк — от 10 фишек");

        game.startGame(room, chips);
        note(room, "партия началась, банк " + chips);

        return broadcast(room, []);
    }

    if (!player) return fail(ws, "Ты наблюдаешь за игрой");

    if (msg.t === "distribute") {
        if (room.phase !== "distribution") return fail(ws, "Не время раскладывать");
        if (!myMove) return fail(ws, "Раскладывает дилер");

        const values = Array.isArray(msg.values)
            ? msg.values.map(v => Math.floor(Number(v)))
            : null;

        const error = game.checkDistribution(room, values);

        if (error) return fail(ws, error);

        game.applyDistribution(room, values);
        return broadcast(room, []);
    }

    if (msg.t === "bid") {
        if (room.phase !== "auction") return fail(ws, "Торги не идут");
        if (!myMove) return fail(ws, "Сейчас не твой ход");

        if (msg.pass) {
            game.auctionAnswer(room, player.id, null);
            return broadcast(room, []);
        }

        const amount = Math.floor(Number(msg.amount));
        const floor = Math.min(room.betMin, player.chips);

        if (!Number.isFinite(amount) || amount < floor) return fail(ws, "Минимальная ставка — " + floor);
        if (amount > player.chips) return fail(ws, "Столько фишек нет");

        game.auctionAnswer(room, player.id, amount);
        return broadcast(room, []);
    }

    if (msg.t === "bet") {
        if (room.phase !== "betting") return fail(ws, "Ставки закрыты");
        if (!myMove) return fail(ws, "Сейчас не твой ход");

        if (msg.skip) {
            if (room.betting.pos === 0) return fail(ws, "Победитель торгов обязан поставить");

            game.skipBet(room);
            return broadcast(room, []);
        }

        const index = Number(msg.cup);
        const amount = Math.floor(Number(msg.amount));
        const floor = game.betFloor(room, player);

        if (!room.cups[index]) return fail(ws, "Нет такого стакана");
        if (!Number.isFinite(amount) || amount > player.chips) return fail(ws, "Столько фишек нет");
        if (amount < floor) return fail(ws, "Минимальная ставка — " + floor);

        game.applyBet(room, player.id, index, amount);
        return broadcast(room, []);
    }

    if (msg.t === "open") {
        if (room.phase !== "choosing") return fail(ws, "Сейчас не вскрывают стаканы");
        if (!myMove) return fail(ws, "Сейчас не твой ход");

        const index = Number(msg.cup);
        const cup = room.cups[index];

        if (!cup || cup.opened) return fail(ws, "Стакан уже вскрыт");
        if (game.closedCups(room) <= 1) return fail(ws, "Последний стакан за дилером");

        const fx = [];
        game.takeCup(room, player.id, index, fx);
        return broadcast(room, fx);
    }

    if (msg.t === "next") {
        if (room.phase !== "roundEnd") return fail(ws, "Раунд ещё идёт");

        const isDealer = game.dealer(room) && game.dealer(room).id === player.id;

        if (!isHost && !isDealer) return fail(ws, "Раунд запускает дилер или создатель комнаты");

        game.nextRound(room);
        return broadcast(room, []);
    }

    if (msg.t === "restart") {
        if (!isHost) return fail(ws, "Новую партию собирает создатель комнаты");

        Object.assign(room, {
            phase: "lobby",
            cups: [],
            order: [],
            orderPos: 0,
            auction: null,
            betting: null,
            results: null,
            standings: null,
            dealerIndex: 0,
            deadline: 0,
            revealAt: 0,
            departed: {},
            message: "",
            note: ""
        });

        room.players = room.players.filter(p => p.connected);
        room.players.forEach(p => { p.chips = room.startingChips; });

        room.spectators.forEach(s => {
            if (room.players.length < game.MAX_PLAYERS) {
                room.players.push({
                    id: s.id,
                    name: s.name,
                    chips: room.startingChips,
                    connected: true,
                    offlineAt: null
                });
            }
        });

        room.spectators = [];
        note(room, "стол пересобран");

        return broadcast(room, []);
    }
}


/* ---------- фоновое ---------- */

setInterval(() => {
    wss.clients.forEach(ws => {
        if (ws.isAlive === false) return ws.terminate();

        ws.isAlive = false;
        ws.ping();
    });
}, 30000);

process.on("SIGTERM", () => {
    store.save(rooms.snapshot());
    process.exit(0);
});

const restored = rooms.restore();

server.listen(PORT, () => {
    console.log("Tumblers " + VERSION + " — порт " + PORT
        + (restored ? ", восстановлено комнат: " + restored : ""));
});

module.exports = { VERSION };
