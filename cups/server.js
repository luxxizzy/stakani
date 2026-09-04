/* =========================================================
   СТАКАНЫ — игровой сервер
   Вся логика игры живёт здесь. Клиент только рисует.
========================================================= */

const path = require("path");
const http = require("http");
const express = require("express");
const { WebSocketServer } = require("ws");

const VERSION = "2.0.1";

const TURN_MS = Number(process.env.TURN_MS || 60000);        // время на ход
const RECONNECT_MS = Number(process.env.RECONNECT_MS || 90000); // время на возвращение
const LAST_CUP_DELAY = 1600;  // пауза перед вскрытием последнего стакана

const app = express();

app.use(express.static(path.join(__dirname, "public")));
app.get("/healthz", (req, res) => res.send("ok"));

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const PORT = process.env.PORT || 3000;


/* =========================================================
   КОМНАТЫ
========================================================= */

const rooms = new Map();

const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

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

function createRoom() {
    const room = {
        code: makeCode(),
        hostId: null,
        phase: "lobby",
        startingChips: 100,

        players: [],
        spectators: [],

        dealerIndex: 0,
        roundId: 0,

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
        timer: null,
        timerAction: null,
        delayTimer: null,
        turnSeq: 0,

        message: "",
        note: "",
        results: null,
        standings: null,

        lastActivity: Date.now()
    };

    rooms.set(room.code, room);
    return room;
}


/* =========================================================
   ВСПОМОГАТЕЛЬНОЕ
========================================================= */

function seat(room, id) {
    return room.players.findIndex(p => p.id === id);
}

function byId(room, id) {
    return room.players.find(p => p.id === id);
}

function dealer(room) {
    return room.players[room.dealerIndex];
}

function nameOf(room, id) {
    const p = byId(room, id);
    return p ? p.name : "—";
}

function randomSplit(total, parts) {
    const values = [];
    let left = total;

    for (let i = 0; i < parts; i++) {
        if (i === parts - 1) {
            values.push(left);
        } else {
            const v = Math.floor(Math.random() * (left + 1));
            values.push(v);
            left -= v;
        }
    }

    return values.sort(() => Math.random() - 0.5);
}

function clearTimers(room) {
    if (room.timer) {
        clearTimeout(room.timer);
        room.timer = null;
    }

    room.timerAction = null;
    room.deadline = 0;
}

function armTimer(room, action) {
    clearTimers(room);

    room.timerAction = action;
    room.turnSeq = (room.turnSeq || 0) + 1;
    room.deadline = Date.now() + TURN_MS;

    room.timer = setTimeout(() => {
        room.timer = null;
        room.timerAction = null;
        room.deadline = 0;

        const fx = [];
        action(fx);
        broadcast(room, fx);
    }, TURN_MS);
}

/* доигрывает ход за того, кто вышел, не дожидаясь таймера */
function forceTurn(room, fx) {
    const action = room.timerAction;

    clearTimers(room);

    if (action) action(fx);
}


/* =========================================================
   СОСТОЯНИЕ ДЛЯ КЛИЕНТА
========================================================= */

function stateFor(room, viewerId, fx) {
    const revealed = room.phase === "roundEnd"
        || room.phase === "over"
        || room.phase === "lobby";

    return {
        t: "state",
        version: VERSION,
        code: room.code,
        hostId: room.hostId,
        phase: room.phase,
        roundId: room.roundId,
        startingChips: room.startingChips,

        you: viewerId,
        spectator: !byId(room, viewerId),

        dealerId: dealer(room) ? dealer(room).id : null,

        players: room.players.map(p => ({
            id: p.id,
            name: p.name,
            chips: (revealed || p.id === viewerId)
                ? p.chips
                : (room.snapshot[p.id] !== undefined ? room.snapshot[p.id] : p.chips),
            exact: revealed || p.id === viewerId,
            delta: revealed && room.snapshot[p.id] !== undefined
                ? p.chips - room.snapshot[p.id]
                : null,
            connected: p.connected,
            isDealer: room.phase !== "lobby" && p.id === (dealer(room) || {}).id
        })),

        spectators: room.spectators.map(s => ({ name: s.name })),

        cups: room.cups.map(c => ({
            number: c.number,
            opened: c.opened,
            chips: c.opened ? c.chips : null,
            openedBy: c.openedBy,
            bets: c.bets.map(b => ({
                playerId: b.playerId,
                name: nameOf(room, b.playerId),
                amount: b.amount
            }))
        })),

        maxStack: room.maxStack,
        dealerMin: room.dealerMin,
        betMin: room.betMin,

        auction: room.auction && {
            currentId: room.auction.queue[room.auction.pos] || null,
            bids: room.auction.bids,
            highest: room.auction.bids.reduce(
                (m, b) => (b.amount !== null && b.amount > m ? b.amount : m), 0
            )
        },

        betting: room.betting && {
            currentId: room.betting.queue[room.betting.pos] || null,
            mandatory: room.betting.pos === 0,
            committed: room.betting.committed
        },

        activeId: activePlayer(room),
        order: room.order,

        deadlineIn: room.deadline ? Math.max(0, room.deadline - Date.now()) : 0,
        turnSeq: room.turnSeq || 0,

        message: room.message,
        note: room.note,
        results: room.results,
        standings: room.standings,

        fx: fx || []
    };
}

function activePlayer(room) {
    if (room.phase === "distribution") {
        return dealer(room) ? dealer(room).id : null;
    }

    if (room.phase === "auction" && room.auction) {
        return room.auction.queue[room.auction.pos] || null;
    }

    if (room.phase === "betting" && room.betting) {
        return room.betting.queue[room.betting.pos] || null;
    }

    if (room.phase === "choosing") {
        return room.order[room.orderPos] || null;
    }

    return null;
}

/* доигрывает ходы за тех, кто вышел, чтобы стол не ждал их по минуте */
function flushGone(room, fx) {
    let guard = 0;

    while (guard++ < 16) {
        const id = activePlayer(room);

        if (!id) break;

        const p = byId(room, id);

        if (!p || !p.left) break;

        forceTurn(room, fx);
    }
}

function broadcast(room, fx) {
    fx = fx || [];
    flushGone(room, fx);

    room.lastActivity = Date.now();

    wss.clients.forEach(ws => {
        if (ws.roomCode === room.code && ws.readyState === ws.OPEN) {
            ws.send(JSON.stringify(stateFor(room, ws.playerId, fx)));
        }
    });
}

function sendError(ws, msg) {
    if (ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify({ t: "error", msg }));
    }
}


/* =========================================================
   ЖИЗНЬ РАУНДА
========================================================= */

function startGame(room, startingChips) {
    room.startingChips = startingChips;

    room.players.forEach(p => { p.chips = startingChips; });

    room.dealerIndex = 0;
    room.standings = null;
    room.roundId = 0;

    startRound(room);
}

function startRound(room) {
    clearTimers(room);

    dropAbandoned(room);

    if (room.players.length < 2) {
        finishGame(room);
        return;
    }

    room.roundId++;
    room.results = null;
    room.cups = [];
    room.auction = null;
    room.betting = null;
    room.order = [];
    room.orderPos = 0;

    room.snapshot = {};
    room.players.forEach(p => { room.snapshot[p.id] = p.chips; });

    room.maxStack = room.players.reduce((m, p) => Math.max(m, p.chips), 0);
    room.dealerMin = Math.ceil(room.maxStack * 0.1);
    room.betMin = room.dealerMin * 2;

    room.phase = "distribution";
    room.message = dealer(room).name + " раскладывает фишки";
    room.note = "";

    armTimer(room, () => autoDistribute(room));
}

function requiredFromDealer(room) {
    return Math.min(room.dealerMin, dealer(room).chips);
}

function autoDistribute(room) {
    const values = randomSplit(requiredFromDealer(room), room.players.length);
    applyDistribution(room, values);
}

function applyDistribution(room, values) {
    const d = dealer(room);
    const total = values.reduce((s, v) => s + v, 0);

    d.chips -= total;

    room.cups = values.map((chips, i) => ({
        number: i + 1,
        chips,
        opened: false,
        openedBy: null,
        bets: []
    }));

    if (room.players.length === 2) {
        beginChoosing(room, [room.players[(room.dealerIndex + 1) % 2].id]);
        return;
    }

    beginAuction(room);
}


/* ---------- аукцион за очередь ---------- */

function beginAuction(room) {
    const queue = [];

    for (let i = 1; i < room.players.length; i++) {
        queue.push(room.players[(room.dealerIndex + i) % room.players.length].id);
    }

    room.auction = { queue, pos: 0, bids: [] };
    room.phase = "auction";
    room.message = "Торги за очередь хода";

    askAuction(room);
}

function askAuction(room) {
    const id = room.auction.queue[room.auction.pos];

    if (!id) {
        finishAuction(room);
        return;
    }

    room.note = nameOf(room, id) + " называет ставку или пасует";

    armTimer(room, () => auctionAnswer(room, id, null));
}

function auctionAnswer(room, playerId, amount) {
    room.auction.bids.push({
        playerId,
        name: nameOf(room, playerId),
        amount
    });

    room.auction.pos++;
    askAuction(room);
}

function finishAuction(room) {
    const bids = room.auction.bids;

    const bidders = bids
        .filter(b => b.amount !== null)
        .map((b, i) => ({ ...b, i }))
        .sort((a, b) => b.amount - a.amount || a.i - b.i);

    const passers = room.auction.queue.filter(
        id => !bidders.some(b => b.playerId === id)
    );

    const order = bidders.map(b => b.playerId).concat(passers);

    if (!bidders.length) {
        room.message = "Все спасовали — раунд без ставок";
        beginChoosing(room, order);
        return;
    }

    room.betting = {
        queue: bidders.map(b => b.playerId),
        pos: 0,
        committed: bidders[0].amount,
        order
    };

    room.phase = "betting";
    room.message = "Ставки на стаканы";

    askBet(room);
}


/* ---------- ставки на стаканы ---------- */

function askBet(room) {
    const id = room.betting.queue[room.betting.pos];

    if (!id) {
        beginChoosing(room, room.betting.order);
        return;
    }

    room.note = room.betting.pos === 0
        ? nameOf(room, id) + " обязан поставить не меньше " + room.betting.committed
        : nameOf(room, id) + " ставит или пропускает";

    armTimer(room, () => autoBet(room, id));
}

function minimumBet(room, player) {
    return Math.min(room.betMin, player.chips);
}

function autoBet(room, playerId) {
    if (room.betting.pos === 0) {
        const player = byId(room, playerId);
        const amount = Math.min(room.betting.committed, player.chips);
        const cup = Math.floor(Math.random() * room.cups.length);

        applyBet(room, playerId, cup, amount);
        return;
    }

    room.betting.pos++;
    askBet(room);
}

function applyBet(room, playerId, cupIndex, amount) {
    const player = byId(room, playerId);

    player.chips -= amount;
    room.cups[cupIndex].bets.push({ playerId, amount });

    room.betting.pos++;
    askBet(room);
}


/* ---------- вскрытие стаканов ---------- */

function beginChoosing(room, order) {
    room.order = order;
    room.orderPos = 0;
    room.betting = null;
    room.phase = "choosing";

    nextChooser(room);
}

function nextChooser(room) {
    const id = room.order[room.orderPos];

    if (!id) {
        scheduleLastCup(room);
        return;
    }

    room.message = nameOf(room, id) + " выбирает стакан";
    room.note = "";

    armTimer(room, fx => {
        if (room.cups.length - openedCount(room) <= 1) return;

        const free = room.cups
            .map((c, i) => (c.opened ? -1 : i))
            .filter(i => i >= 0);

        takeCup(room, id, free[Math.floor(Math.random() * free.length)], fx);
    });
}

function openedCount(room) {
    return room.cups.filter(c => c.opened).length;
}

function resolveBets(room, cup, openerId, fx) {
    let forfeited = 0;

    cup.bets.forEach(bet => {
        const bettor = byId(room, bet.playerId);

        if (!bettor) {
            forfeited += bet.amount;
            return;
        }

        if (cup.chips > bet.amount) {
            cup.chips -= bet.amount;
            bettor.chips += bet.amount * 2;

            fx.push({
                kind: "chips",
                cup: cup.number,
                to: bet.playerId,
                amount: bet.amount * 2
            });

        } else {
            forfeited += bet.amount;
        }
    });

    return forfeited;
}

function takeCup(room, playerId, cupIndex, fx) {
    const cup = room.cups[cupIndex];
    const player = byId(room, playerId);

    cup.opened = true;
    cup.openedBy = player.name;

    const forfeited = resolveBets(room, cup, playerId, fx);
    const gain = cup.chips + forfeited;

    player.chips += gain;

    fx.push({ kind: "chips", cup: cup.number, to: playerId, amount: gain });

    room.orderPos++;
    nextChooser(room);
}

function scheduleLastCup(room) {
    clearTimers(room);

    room.message = dealer(room).name + " вскрывает последний стакан";
    room.note = "";

    if (room.delayTimer) clearTimeout(room.delayTimer);

    room.delayTimer = setTimeout(() => {
        room.delayTimer = null;

        const fx = [];
        openLastCup(room, fx);
        broadcast(room, fx);
    }, LAST_CUP_DELAY);
}

function openLastCup(room, fx) {
    const cup = room.cups.find(c => !c.opened);

    if (!cup) {
        endRound(room);
        return;
    }

    const d = dealer(room);
    const n = room.players.length;
    const payer = room.players[(room.dealerIndex - 1 + n) % n];

    cup.opened = true;
    cup.openedBy = d.name;

    const forfeited = resolveBets(room, cup, d.id, fx);
    const inside = cup.chips;
    const payment = Math.ceil(inside / 2);

    d.chips += inside + forfeited;

    fx.push({ kind: "chips", cup: cup.number, to: d.id, amount: inside + forfeited });

    if (payer.id !== d.id && payer.chips >= payment && payment > 0) {
        payer.chips -= payment;
        d.chips += payment;

        fx.push({ kind: "chips", from: payer.id, to: d.id, amount: payment });

        room.message = payer.name + " доплатил дилеру " + payment;

    } else {
        room.message = "Последний стакан целиком ушёл дилеру";
    }

    endRound(room);
}


/* ---------- конец раунда ---------- */

function endRound(room) {
    clearTimers(room);

    room.results = room.players.map(p => ({
        playerId: p.id,
        name: p.name,
        chips: p.chips,
        delta: p.chips - (room.snapshot[p.id] || 0)
    }));

    const broke = room.players.some(p => p.chips <= 0);

    if (broke) {
        finishGame(room);
        return;
    }

    room.phase = "roundEnd";
    room.note = "Раунд сыгран";

    armTimer(room, () => nextRound(room));
}

function nextRound(room) {
    room.dealerIndex = (room.dealerIndex + 1) % room.players.length;
    startRound(room);
}

function finishGame(room) {
    clearTimers(room);

    room.phase = "over";
    room.message = "Игра окончена";
    room.note = "";

    const sorted = room.players
        .slice()
        .sort((a, b) => b.chips - a.chips);

    room.standings = sorted.map((p, i) => ({
        place: i + 1,
        name: p.name,
        chips: p.chips,
        bankrupt: p.chips <= 0
    }));
}


/* ---------- выбывшие ---------- */

function dropAbandoned(room) {
    const now = Date.now();

    const leaving = room.players.filter(
        p => !p.connected && p.offlineAt && now - p.offlineAt > RECONNECT_MS
    );

    leaving.forEach(p => removePlayer(room, p.id));
}

function removePlayer(room, playerId) {
    const index = seat(room, playerId);

    if (index < 0) return;

    const leaver = room.players[index];
    const pot = leaver.chips;

    room.players.splice(index, 1);

    if (index < room.dealerIndex) {
        room.dealerIndex--;
    }

    if (room.players.length) {
        room.dealerIndex = room.dealerIndex % room.players.length;
    }

    if (room.hostId === playerId && room.players.length) {
        room.hostId = room.players[0].id;
    }

    const count = room.players.length;

    if (count && pot > 0) {
        const share = Math.floor(pot / count);
        const rest = pot % count;

        room.players.forEach(p => { p.chips += share; });

        for (let i = 0; i < rest; i++) {
            room.players[i % count].chips += 1;
        }
    }

    room.message = leaver.name + " вышел из игры, его фишки разделены";
}


/* =========================================================
   СООБЩЕНИЯ ОТ КЛИЕНТОВ
========================================================= */

wss.on("connection", ws => {
    ws.isAlive = true;
    ws.on("pong", () => { ws.isAlive = true; });

    ws.on("message", raw => {
        let msg;

        try {
            msg = JSON.parse(raw);
        } catch (e) {
            return;
        }

        handleMessage(ws, msg);
    });

    ws.on("close", () => {
        const room = rooms.get(ws.roomCode);

        if (!room) return;

        const player = byId(room, ws.playerId);

        if (player) {
            if (room.phase === "lobby") {
                removePlayer(room, ws.playerId);
            } else {
                player.connected = false;
                player.offlineAt = Date.now();
            }
        }

        room.spectators = room.spectators.filter(s => s.id !== ws.playerId);

        broadcast(room, []);
    });
});

function handleMessage(ws, msg) {
    if (msg.t === "create" || msg.t === "join") {
        return handleEntry(ws, msg);
    }

    const room = rooms.get(ws.roomCode);

    if (!room) {
        return sendError(ws, "Комната не найдена, обнови страницу");
    }

    room.lastActivity = Date.now();

    const player = byId(room, ws.playerId);
    const isHost = room.hostId === ws.playerId;

    if (msg.t === "react") {
        const emoji = String(msg.emoji || "").slice(0, 4);

        const payload = JSON.stringify({
            t: "fx",
            fx: [{ kind: "react", playerId: ws.playerId, emoji }]
        });

        wss.clients.forEach(client => {
            if (client.roomCode === room.code && client.readyState === client.OPEN) {
                client.send(payload);
            }
        });

        return;
    }

    if (msg.t === "leave") {
        if (ws.readyState === ws.OPEN) {
            ws.send(JSON.stringify({ t: "left" }));
        }

        room.spectators = room.spectators.filter(s => s.id !== ws.playerId);

        if (!player) {
            ws.roomCode = null;
            return broadcast(room, []);
        }

        if (room.phase === "lobby" || room.phase === "over") {
            removePlayer(room, ws.playerId);
            ws.roomCode = null;
            return broadcast(room, []);
        }

        player.connected = false;
        player.left = true;
        player.offlineAt = Date.now() - RECONNECT_MS - 1000;
        room.message = player.name + " вышел из игры";

        const fx = [];

        if (activePlayer(room) === player.id) {
            forceTurn(room, fx);
        }

        ws.roomCode = null;
        return broadcast(room, fx);
    }

    if (msg.t === "start") {
        if (!isHost) return sendError(ws, "Игру начинает создатель комнаты");
        if (room.phase !== "lobby") return sendError(ws, "Игра уже идёт");
        if (room.players.length < 2) return sendError(ws, "Нужно минимум 2 игрока");

        const chips = Math.floor(Number(msg.startingChips));

        if (!Number.isFinite(chips) || chips < 10) {
            return sendError(ws, "Стартовый банк — от 10 фишек");
        }

        startGame(room, chips);
        return broadcast(room, []);
    }

    if (!player) {
        return sendError(ws, "Ты наблюдаешь за игрой");
    }

    if (msg.t === "distribute") {
        if (room.phase !== "distribution") return sendError(ws, "Не время раскладывать");
        if (player.id !== dealer(room).id) return sendError(ws, "Раскладывает дилер");

        const values = Array.isArray(msg.values) ? msg.values.map(v => Math.floor(Number(v))) : null;

        if (!values || values.length !== room.players.length || values.some(v => !Number.isFinite(v) || v < 0)) {
            return sendError(ws, "Неверная раскладка");
        }

        const total = values.reduce((s, v) => s + v, 0);
        const need = requiredFromDealer(room);

        if (total > player.chips) return sendError(ws, "Больше, чем есть в банке");
        if (total < need) return sendError(ws, "Нужно разложить минимум " + need);

        applyDistribution(room, values);
        return broadcast(room, []);
    }

    if (msg.t === "bid") {
        if (room.phase !== "auction") return sendError(ws, "Торги не идут");
        if (activePlayer(room) !== player.id) return sendError(ws, "Сейчас не твой ход");

        if (msg.pass) {
            auctionAnswer(room, player.id, null);
            return broadcast(room, []);
        }

        const amount = Math.floor(Number(msg.amount));
        const floor = minimumBet(room, player);

        if (!Number.isFinite(amount) || amount < floor) {
            return sendError(ws, "Минимальная ставка — " + floor);
        }

        if (amount > player.chips) return sendError(ws, "Столько фишек нет");

        auctionAnswer(room, player.id, amount);
        return broadcast(room, []);
    }

    if (msg.t === "bet") {
        if (room.phase !== "betting") return sendError(ws, "Ставки закрыты");
        if (activePlayer(room) !== player.id) return sendError(ws, "Сейчас не твой ход");

        if (msg.skip) {
            if (room.betting.pos === 0) return sendError(ws, "Победитель торгов обязан поставить");

            room.betting.pos++;
            askBet(room);
            return broadcast(room, []);
        }

        const index = Number(msg.cup);
        const amount = Math.floor(Number(msg.amount));

        if (!room.cups[index]) return sendError(ws, "Нет такого стакана");
        if (!Number.isFinite(amount) || amount > player.chips) return sendError(ws, "Столько фишек нет");

        const floor = room.betting.pos === 0
            ? Math.min(room.betting.committed, player.chips)
            : minimumBet(room, player);

        if (amount < floor) return sendError(ws, "Минимальная ставка — " + floor);

        applyBet(room, player.id, index, amount);
        return broadcast(room, []);
    }

    if (msg.t === "open") {
        if (room.phase !== "choosing") return sendError(ws, "Сейчас не вскрывают стаканы");
        if (activePlayer(room) !== player.id) return sendError(ws, "Сейчас не твой ход");

        const index = Number(msg.cup);
        const cup = room.cups[index];

        if (!cup || cup.opened) return sendError(ws, "Стакан уже вскрыт");
        if (room.cups.length - openedCount(room) <= 1) return sendError(ws, "Последний стакан за дилером");

        const fx = [];
        takeCup(room, player.id, index, fx);
        return broadcast(room, fx);
    }

    if (msg.t === "next") {
        if (room.phase !== "roundEnd") return sendError(ws, "Раунд ещё идёт");
        if (!isHost && player.id !== dealer(room).id) {
            return sendError(ws, "Раунд запускает дилер или создатель комнаты");
        }

        nextRound(room);
        return broadcast(room, []);
    }

    if (msg.t === "restart") {
        if (!isHost) return sendError(ws, "Новую игру собирает создатель комнаты");

        clearTimers(room);

        room.phase = "lobby";
        room.cups = [];
        room.order = [];
        room.auction = null;
        room.betting = null;
        room.results = null;
        room.standings = null;
        room.dealerIndex = 0;
        room.message = "";
        room.note = "";

        room.players = room.players.filter(p => p.connected);
        room.players.forEach(p => { p.chips = room.startingChips; });

        room.spectators.forEach(s => {
            if (room.players.length < 8) {
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

        return broadcast(room, []);
    }
}

function handleEntry(ws, msg) {
    const name = String(msg.name || "").trim().slice(0, 20) || "Игрок";
    const playerId = String(msg.playerId || "").slice(0, 64);

    if (!playerId) return sendError(ws, "Нет идентификатора игрока");

    let room;

    if (msg.t === "create") {
        room = createRoom();
        room.hostId = playerId;
    } else {
        room = rooms.get(String(msg.code || "").toUpperCase().trim());
        if (!room) return sendError(ws, "Комната не найдена");
    }

    ws.roomCode = room.code;
    ws.playerId = playerId;

    const existing = byId(room, playerId);

    if (existing) {
        existing.connected = true;
        existing.left = false;
        existing.offlineAt = null;
        existing.name = name;

    } else if (room.phase === "lobby" && room.players.length < 8 && !msg.watch) {
        room.players.push({
            id: playerId,
            name,
            chips: room.startingChips,
            connected: true,
            offlineAt: null
        });

        if (!room.hostId) room.hostId = playerId;

    } else {
        room.spectators = room.spectators.filter(s => s.id !== playerId);
        room.spectators.push({ id: playerId, name });
    }

    ws.send(JSON.stringify({ t: "joined", code: room.code, playerId }));
    broadcast(room, []);
}


/* =========================================================
   ФОНОВЫЕ ЗАДАЧИ
========================================================= */

setInterval(() => {
    wss.clients.forEach(ws => {
        if (ws.isAlive === false) return ws.terminate();

        ws.isAlive = false;
        ws.ping();
    });
}, 30000);

setInterval(() => {
    const now = Date.now();

    rooms.forEach((room, code) => {
        if (now - room.lastActivity > 2 * 60 * 60 * 1000) {
            clearTimers(room);
            if (room.delayTimer) clearTimeout(room.delayTimer);
            rooms.delete(code);
            return;
        }

        if (room.phase !== "roundEnd") return;

        const stale = room.players.some(
            p => !p.connected && p.offlineAt && now - p.offlineAt > RECONNECT_MS
        );

        if (stale) {
            room.players
                .filter(p => !p.connected && p.offlineAt && now - p.offlineAt > RECONNECT_MS)
                .forEach(p => removePlayer(room, p.id));

            if (room.players.length < 2) {
                finishGame(room);
            }

            broadcast(room, []);
        }
    });
}, 5000);


server.listen(PORT, () => {
    console.log("Стаканы " + VERSION + " — порт " + PORT);
});
