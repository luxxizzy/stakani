/* =========================================================
   СТАКАНЫ — игровой сервер
   Вся логика игры живёт здесь. Клиент только рисует.
========================================================= */

const path = require("path");
const http = require("http");
const express = require("express");
const { WebSocketServer } = require("ws");

const app = express();

app.use(express.static(path.join(__dirname, "public")));

// для пингов uptime-мониторов
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
        phase: "lobby",           // lobby | distribution | choosing | roundEnd | over
        startingChips: 100,
        players: [],              // { id, name, chips, connected }
        dealerIndex: 0,
        currentChooserIndex: 1,
        cups: [],                 // { number, chips, opened, takenBy }
        cupsRemaining: 0,
        roundId: 0,
        message: "",
        gameOverMessage: "",
        log: [],
        timer: null,
        lastActivity: Date.now()
    };

    rooms.set(room.code, room);
    return room;
}

function addLog(room, text) {
    room.log.unshift({
        time: new Date().toISOString(),
        text
    });

    if (room.log.length > 100) {
        room.log.length = 100;
    }
}


/* =========================================================
   ОТПРАВКА СОСТОЯНИЯ
========================================================= */

function publicState(room) {
    return {
        t: "state",
        code: room.code,
        hostId: room.hostId,
        phase: room.phase,
        startingChips: room.startingChips,
        players: room.players.map((p, i) => ({
            id: p.id,
            name: p.name,
            chips: p.chips,
            connected: p.connected,
            isDealer: room.phase !== "lobby" && i === room.dealerIndex
        })),
        dealerIndex: room.dealerIndex,
        currentChooserIndex: room.currentChooserIndex,
        currentChooserId:
            room.players[room.currentChooserIndex]
                ? room.players[room.currentChooserIndex].id
                : null,
        dealerId:
            room.players[room.dealerIndex]
                ? room.players[room.dealerIndex].id
                : null,

        // содержимое закрытых стаканов клиенту НЕ уходит
        cups: room.cups.map(c => ({
            number: c.number,
            opened: c.opened,
            chips: c.opened ? c.chips : null,
            takenBy: c.takenBy || null
        })),

        cupsRemaining: room.cupsRemaining,
        roundId: room.roundId,
        message: room.message,
        gameOverMessage: room.gameOverMessage,
        log: room.log
    };
}

function broadcast(room) {
    const payload = JSON.stringify(publicState(room));

    wss.clients.forEach(ws => {
        if (ws.roomCode === room.code && ws.readyState === ws.OPEN) {
            ws.send(payload);
        }
    });
}

function sendError(ws, msg) {
    if (ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify({ t: "error", msg }));
    }
}


/* =========================================================
   ХОД ИГРЫ
========================================================= */

function startGame(room, startingChips) {
    room.startingChips = startingChips;

    room.players.forEach(p => {
        p.chips = startingChips;
    });

    room.dealerIndex = 0;
    room.gameOverMessage = "";
    room.log = [];

    addLog(room, "Игра началась. Стартовый банк: " + startingChips + " фишек.");

    startRound(room);
}

function startRound(room) {
    if (room.timer) {
        clearTimeout(room.timer);
        room.timer = null;
    }

    const dealer = room.players[room.dealerIndex];

    // дилер с нулём фишек в начале раздачи — конец игры
    if (dealer.chips === 0) {
        finishGame(room);
        return;
    }

    room.cups = [];
    room.cupsRemaining = room.players.length;
    room.currentChooserIndex = (room.dealerIndex + 1) % room.players.length;
    room.roundId++;
    room.phase = "distribution";
    room.message = dealer.name + " распределяет фишки.";
}

function finishGame(room) {
    const dealer = room.players[room.dealerIndex];

    room.phase = "over";
    room.message = "";
    room.gameOverMessage =
        dealer.name + " стал дилером с нулевым балансом.";

    addLog(
        room,
        "ИГРА ОКОНЧЕНА: у " + dealer.name + " 0 фишек перед распределением."
    );
}

function confirmDistribution(room, values) {
    const dealer = room.players[room.dealerIndex];
    const n = room.players.length;

    let total = 0;

    for (let i = 0; i < n; i++) {
        let v = Math.floor(Number(values[i]));

        if (!Number.isFinite(v) || v < 0) {
            return "Нельзя использовать отрицательное количество фишек.";
        }

        values[i] = v;
        total += v;
    }

    if (total > dealer.chips) {
        return "Нельзя распределить больше фишек, чем есть у дилера.";
    }

    // дилер не положил ничего — весь его банк делится между всеми
    if (total === 0) {
        distributeDealerEvenly(room);
        return null;
    }

    dealer.chips -= total;

    room.cups = values.map((chips, i) => ({
        number: i + 1,
        chips,
        opened: false,
        takenBy: null
    }));

    room.phase = "choosing";

    addLog(room, dealer.name + " распределил " + total + " фишек по стаканам.");

    updateChooserMessage(room);

    return null;
}

function distributeDealerEvenly(room) {
    const dealer = room.players[room.dealerIndex];
    const amount = dealer.chips;
    const count = room.players.length;

    dealer.chips = 0;

    const share = Math.floor(amount / count);
    const remainder = amount % count;

    for (let i = 0; i < count; i++) {
        room.players[(room.dealerIndex + i) % count].chips += share;
    }

    for (let i = 0; i < remainder; i++) {
        room.players[(room.dealerIndex + i) % count].chips += 1;
    }

    addLog(
        room,
        dealer.name + " не положил ни одной фишки под стаканы. " +
        amount + " фишек распределены между игроками."
    );

    room.dealerIndex = (room.dealerIndex + 1) % count;

    addLog(room, "Дилером становится " + room.players[room.dealerIndex].name + ".");

    startRound(room);
}

function chooseCup(room, playerId, index) {
    if (room.phase !== "choosing") {
        return "Сейчас не выбирают стаканы.";
    }

    const chooser = room.players[room.currentChooserIndex];

    if (!chooser || chooser.id !== playerId) {
        return "Сейчас не твой ход.";
    }

    const cup = room.cups[index];

    if (!cup || cup.opened) {
        return "Этот стакан уже открыт.";
    }

    if (room.cupsRemaining <= 1) {
        return "Последний стакан открывает дилер.";
    }

    cup.opened = true;
    cup.takenBy = chooser.name;
    chooser.chips += cup.chips;
    room.cupsRemaining--;

    addLog(
        room,
        chooser.name + " выбрал стакан " + cup.number +
        " и получил " + cup.chips + " фишек."
    );

    // следующий игрок справа, дилер пропускается
    room.currentChooserIndex =
        (room.currentChooserIndex + 1) % room.players.length;

    if (room.currentChooserIndex === room.dealerIndex) {
        room.currentChooserIndex =
            (room.currentChooserIndex + 1) % room.players.length;
    }

    updateChooserMessage(room);

    return null;
}

function updateChooserMessage(room) {
    if (room.cupsRemaining === 1) {
        room.message =
            room.players[room.dealerIndex].name + " открывает последний стакан.";

        if (room.timer) {
            clearTimeout(room.timer);
        }

        room.timer = setTimeout(() => {
            room.timer = null;

            if (room.phase === "choosing" && room.cupsRemaining === 1) {
                openLastCup(room);
                broadcast(room);
            }
        }, 1500);

        return;
    }

    room.message = room.players[room.currentChooserIndex].name + ", выбирай стакан.";
}

function openLastCup(room) {
    const lastCup = room.cups.find(c => !c.opened);

    if (!lastCup) {
        return;
    }

    const amount = lastCup.chips;
    const n = room.players.length;

    // платит игрок слева от дилера
    const payer = room.players[(room.dealerIndex - 1 + n) % n];
    const dealer = room.players[room.dealerIndex];

    const requiredPayment = Math.ceil(amount / 2);

    lastCup.opened = true;
    lastCup.takenBy = dealer.name;
    room.cupsRemaining = 0;
    room.phase = "roundEnd";

    if (payer.chips >= requiredPayment) {
        payer.chips -= requiredPayment;
        dealer.chips += amount + requiredPayment;

        addLog(
            room,
            dealer.name + " открыл последний стакан (" + amount + " фишек). " +
            payer.name + " выплатил дилеру " + requiredPayment + " фишек."
        );

        room.message =
            dealer.name + " получил " + requiredPayment + " фишек от " + payer.name + ".";

    } else {
        dealer.chips += amount;

        addLog(
            room,
            dealer.name + " открыл последний стакан (" + amount + " фишек). " +
            payer.name + " не смог выплатить " + requiredPayment +
            " фишек. Все " + amount + " фишек возвращены дилеру."
        );

        room.message =
            dealer.name + " забрал обратно все " + amount + " фишек из последнего стакана.";
    }
}

function nextRound(room) {
    room.dealerIndex = (room.dealerIndex + 1) % room.players.length;

    addLog(room, "Дилером становится " + room.players[room.dealerIndex].name + ".");

    startRound(room);
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

        if (!room) {
            return;
        }

        const player = room.players.find(p => p.id === ws.playerId);

        if (!player) {
            return;
        }

        if (room.phase === "lobby") {
            // из лобби просто убираем
            room.players = room.players.filter(p => p.id !== ws.playerId);

            if (room.hostId === ws.playerId && room.players.length) {
                room.hostId = room.players[0].id;
            }

        } else {
            player.connected = false;
        }

        broadcast(room);
    });
});

function handleMessage(ws, msg) {
    if (msg.t === "create" || msg.t === "join") {
        const name = String(msg.name || "").trim().slice(0, 20) || "Игрок";
        const playerId = String(msg.playerId || "").slice(0, 64);

        if (!playerId) {
            return sendError(ws, "Нет идентификатора игрока.");
        }

        let room;

        if (msg.t === "create") {
            room = createRoom();
            room.hostId = playerId;
        } else {
            room = rooms.get(String(msg.code || "").toUpperCase().trim());

            if (!room) {
                return sendError(ws, "Комната не найдена.");
            }
        }

        const existing = room.players.find(p => p.id === playerId);

        if (existing) {
            // переподключение
            existing.connected = true;
            existing.name = name;

        } else {
            if (room.phase !== "lobby") {
                return sendError(ws, "Игра уже началась, присоединиться нельзя.");
            }

            if (room.players.length >= 8) {
                return sendError(ws, "В комнате уже 8 игроков.");
            }

            room.players.push({
                id: playerId,
                name,
                chips: room.startingChips,
                connected: true
            });

            if (!room.hostId) {
                room.hostId = playerId;
            }
        }

        ws.roomCode = room.code;
        ws.playerId = playerId;
        room.lastActivity = Date.now();

        ws.send(JSON.stringify({ t: "joined", code: room.code, playerId }));
        broadcast(room);
        return;
    }

    const room = rooms.get(ws.roomCode);

    if (!room) {
        return sendError(ws, "Комната не найдена. Обнови страницу.");
    }

    room.lastActivity = Date.now();

    const isHost = room.hostId === ws.playerId;
    const isDealer =
        room.players[room.dealerIndex] &&
        room.players[room.dealerIndex].id === ws.playerId;

    if (msg.t === "start") {
        if (!isHost) {
            return sendError(ws, "Игру начинает создатель комнаты.");
        }

        if (room.phase !== "lobby") {
            return sendError(ws, "Игра уже идёт.");
        }

        if (room.players.length < 3) {
            return sendError(ws, "Нужно минимум 3 игрока.");
        }

        const chips = Math.floor(Number(msg.startingChips));

        if (!Number.isFinite(chips) || chips < 1) {
            return sendError(ws, "Количество стартовых фишек должно быть больше 0.");
        }

        startGame(room, chips);
        broadcast(room);
        return;
    }

    if (msg.t === "distribute") {
        if (room.phase !== "distribution") {
            return sendError(ws, "Сейчас не этап распределения.");
        }

        if (!isDealer) {
            return sendError(ws, "Распределяет только дилер.");
        }

        if (!Array.isArray(msg.values) || msg.values.length !== room.players.length) {
            return sendError(ws, "Неверное распределение.");
        }

        const error = confirmDistribution(room, msg.values.slice());

        if (error) {
            return sendError(ws, error);
        }

        broadcast(room);
        return;
    }

    if (msg.t === "choose") {
        const error = chooseCup(room, ws.playerId, Number(msg.index));

        if (error) {
            return sendError(ws, error);
        }

        broadcast(room);
        return;
    }

    if (msg.t === "next") {
        if (room.phase !== "roundEnd") {
            return sendError(ws, "Раунд ещё не закончен.");
        }

        if (!isHost && !isDealer) {
            return sendError(ws, "Следующий раунд запускает дилер или создатель комнаты.");
        }

        nextRound(room);
        broadcast(room);
        return;
    }

    if (msg.t === "restart") {
        if (!isHost) {
            return sendError(ws, "Новую игру начинает создатель комнаты.");
        }

        room.phase = "lobby";
        room.cups = [];
        room.cupsRemaining = 0;
        room.dealerIndex = 0;
        room.gameOverMessage = "";
        room.message = "";
        room.players = room.players.filter(p => p.connected);
        room.players.forEach(p => { p.chips = room.startingChips; });

        broadcast(room);
        return;
    }
}


/* =========================================================
   ПИНГИ И УБОРКА
========================================================= */

// держим соединения живыми: прокси хостингов рвут неактивные ws
setInterval(() => {
    wss.clients.forEach(ws => {
        if (ws.isAlive === false) {
            return ws.terminate();
        }

        ws.isAlive = false;
        ws.ping();
    });
}, 30000);

// удаляем брошенные комнаты через 2 часа без активности
setInterval(() => {
    const now = Date.now();

    rooms.forEach((room, code) => {
        if (now - room.lastActivity > 2 * 60 * 60 * 1000) {
            if (room.timer) {
                clearTimeout(room.timer);
            }
            rooms.delete(code);
        }
    });
}, 10 * 60 * 1000);


server.listen(PORT, () => {
    console.log("Сервер запущен на порту " + PORT);
});
