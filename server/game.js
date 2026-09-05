/* =========================================================
   ПРАВИЛА ИГРЫ
   Чистая логика: принимает объект комнаты, меняет его.
   Ничего не знает про сокеты, таймеры и хранение.
========================================================= */

const TURN_MS = Number(process.env.TURN_MS || 60000);
const REVEAL_MS = Number(process.env.REVEAL_MS || 1800);

const MIN_PLAYERS = 2;
const MAX_PLAYERS = 8;

const DEALER_SHARE = 0.1;   // минимум дилера от наибольшего стека
const BET_MULTIPLIER = 2;   // минимальная ставка = две минимальные дилера


/* ---------- доступ к столу ---------- */

const at = (room, id) => room.players.find(p => p.id === id);
const seatOf = (room, id) => room.players.findIndex(p => p.id === id);
const dealer = room => room.players[room.dealerIndex];
const nameOf = (room, id) => (at(room, id) || {}).name || "выбывший";

function activePlayer(room) {
    if (room.phase === "distribution") {
        return dealer(room) ? dealer(room).id : null;
    }

    if (room.phase === "auction") {
        return room.auction.queue[room.auction.pos] || null;
    }

    if (room.phase === "betting") {
        return room.betting.queue[room.betting.pos] || null;
    }

    if (room.phase === "choosing") {
        return room.order[room.orderPos] || null;
    }

    return null;
}

function openCups(room) {
    return room.cups.filter(c => c.opened).length;
}

function closedCups(room) {
    return room.cups.length - openCups(room);
}


/* ---------- мелкие помощники ---------- */

function randomSplit(total, parts) {
    const values = [];
    let left = total;

    for (let i = 0; i < parts; i++) {
        if (i === parts - 1) values.push(left);
        else {
            const v = Math.floor(Math.random() * (left + 1));
            values.push(v);
            left -= v;
        }
    }

    return values.sort(() => Math.random() - 0.5);
}

/* делит сумму поровну между всеми, остаток — ближайшим к дилеру */
function spread(room, amount) {
    const count = room.players.length;

    if (!count || amount <= 0) return;

    const share = Math.floor(amount / count);
    const rest = amount % count;

    room.players.forEach(p => { p.chips += share; });

    for (let i = 0; i < rest; i++) {
        room.players[(room.dealerIndex + i) % count].chips += 1;
    }
}

function armTurn(room) {
    room.turnSeq++;
    room.deadline = Date.now() + TURN_MS;
    room.revealAt = 0;
}

function stopClock(room) {
    room.deadline = 0;
    room.revealAt = 0;
}

function log(room, text) {
    room.message = text;
}


/* =========================================================
   ЗАПУСК
========================================================= */

function startGame(room, startingChips) {
    room.startingChips = startingChips;
    room.players.forEach(p => { p.chips = startingChips; });

    room.dealerIndex = 0;
    room.roundId = 0;
    room.standings = null;

    startRound(room);
}

function startRound(room) {
    stopClock(room);

    if (room.players.length < MIN_PLAYERS) return finishGame(room);

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
    room.dealerMin = Math.ceil(room.maxStack * DEALER_SHARE);
    room.betMin = room.dealerMin * BET_MULTIPLIER;

    room.phase = "distribution";
    log(room, dealer(room).name + " раскладывает фишки");
    room.note = "";

    armTurn(room);
}

function dealerNeeds(room) {
    return Math.min(room.dealerMin, dealer(room).chips);
}


/* =========================================================
   РАСКЛАДКА
========================================================= */

function checkDistribution(room, values) {
    if (!Array.isArray(values) || values.length !== room.players.length) {
        return "Нужно указать сумму для каждого стакана";
    }

    if (values.some(v => !Number.isFinite(v) || v < 0)) {
        return "Отрицательных фишек не бывает";
    }

    const total = values.reduce((s, v) => s + v, 0);

    if (total > dealer(room).chips) return "Больше, чем есть в банке";
    if (total < dealerNeeds(room)) return "Нужно разложить минимум " + dealerNeeds(room);

    return null;
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
        const rival = room.players[(room.dealerIndex + 1) % 2].id;
        return beginChoosing(room, [rival]);
    }

    beginAuction(room);
}


/* =========================================================
   ТОРГИ ЗА ОЧЕРЕДЬ
========================================================= */

function beginAuction(room) {
    const queue = [];

    for (let i = 1; i < room.players.length; i++) {
        queue.push(room.players[(room.dealerIndex + i) % room.players.length].id);
    }

    room.auction = { queue, pos: 0, bids: [] };
    room.phase = "auction";

    log(room, "Торги за первый ход");
    askAuction(room);
}

function askAuction(room) {
    const id = room.auction.queue[room.auction.pos];

    if (!id) return finishAuction(room);

    room.note = nameOf(room, id) + " называет ставку или пасует";
    armTurn(room);
}

function auctionAnswer(room, playerId, amount) {
    room.auction.bids.push({ playerId, name: nameOf(room, playerId), amount });
    room.auction.pos++;
    askAuction(room);
}

function finishAuction(room) {
    const bidders = room.auction.bids
        .map((b, i) => ({ ...b, i }))
        .filter(b => b.amount !== null && at(room, b.playerId))
        .sort((a, b) => b.amount - a.amount || a.i - b.i);

    const passers = room.auction.queue.filter(
        id => at(room, id) && !bidders.some(b => b.playerId === id)
    );

    const order = bidders.map(b => b.playerId).concat(passers);

    if (!bidders.length) {
        log(room, "Все спасовали, раунд без ставок");
        return beginChoosing(room, order);
    }

    room.betting = {
        queue: bidders.map(b => b.playerId),
        pos: 0,
        committed: bidders[0].amount,
        order
    };

    room.phase = "betting";
    log(room, "Ставки на стаканы");

    askBet(room);
}


/* =========================================================
   СТАВКИ НА СТАКАНЫ
========================================================= */

function askBet(room) {
    const id = room.betting.queue[room.betting.pos];

    if (!id) return beginChoosing(room, room.betting.order);

    room.note = room.betting.pos === 0
        ? nameOf(room, id) + " обязан поставить не меньше " + room.betting.committed
        : nameOf(room, id) + " ставит или пропускает";

    armTurn(room);
}

function betFloor(room, player) {
    return room.betting && room.betting.pos === 0
        ? Math.min(room.betting.committed, player.chips)
        : Math.min(room.betMin, player.chips);
}

function applyBet(room, playerId, cupIndex, amount) {
    const player = at(room, playerId);

    player.chips -= amount;
    room.cups[cupIndex].bets.push({ playerId, amount });

    room.betting.pos++;
    askBet(room);
}

function skipBet(room) {
    room.betting.pos++;
    askBet(room);
}


/* =========================================================
   ВСКРЫТИЕ
========================================================= */

function beginChoosing(room, order) {
    room.order = order.filter(id => at(room, id));
    room.orderPos = 0;
    room.betting = null;
    room.phase = "choosing";

    nextChooser(room);
}

function nextChooser(room) {
    while (room.order[room.orderPos] && !at(room, room.order[room.orderPos])) {
        room.orderPos++;
    }

    const id = room.order[room.orderPos];

    if (!id || closedCups(room) <= 1) return scheduleReveal(room);

    log(room, nameOf(room, id) + " выбирает стакан");
    room.note = "";
    armTurn(room);
}

/* ставки разыгрываются по очереди, содержимое стакана тает */
function resolveBets(room, cup, fx) {
    let forfeited = 0;

    cup.bets.forEach(bet => {
        const bettor = at(room, bet.playerId);

        if (!bettor) return void (forfeited += bet.amount);

        if (cup.chips > bet.amount) {
            cup.chips -= bet.amount;
            bettor.chips += bet.amount * 2;

            fx.push({
                kind: "chips",
                cup: cup.number,
                to: bet.playerId,
                amount: bet.amount * 2,
                note: "ставка сыграла"
            });

        } else {
            forfeited += bet.amount;
        }
    });

    return forfeited;
}

function takeCup(room, playerId, cupIndex, fx) {
    const cup = room.cups[cupIndex];
    const player = at(room, playerId);

    cup.opened = true;
    cup.openedBy = player.name;

    const forfeited = resolveBets(room, cup, fx);
    const gain = cup.chips + forfeited;

    player.chips += gain;

    fx.push({ kind: "chips", cup: cup.number, to: playerId, amount: gain });

    room.orderPos++;
    nextChooser(room);
}

function scheduleReveal(room) {
    if (closedCups(room) === 0) return endRound(room, []);

    log(room, dealer(room).name + " вскрывает последний стакан");
    room.note = "";

    room.deadline = 0;
    room.revealAt = Date.now() + REVEAL_MS;
}

function openLastCup(room, fx) {
    const cup = room.cups.find(c => !c.opened);

    if (!cup) return endRound(room, fx);

    const d = dealer(room);
    const n = room.players.length;
    const payer = room.players[(room.dealerIndex - 1 + n) % n];

    cup.opened = true;
    cup.openedBy = d.name;

    const forfeited = resolveBets(room, cup, fx);
    const inside = cup.chips;
    const payment = Math.ceil(inside / 2);

    d.chips += inside + forfeited;
    fx.push({ kind: "chips", cup: cup.number, to: d.id, amount: inside + forfeited });

    if (payer.id !== d.id && payment > 0 && payer.chips >= payment) {
        payer.chips -= payment;
        d.chips += payment;

        fx.push({ kind: "chips", from: payer.id, to: d.id, amount: payment, note: "доплата" });
        log(room, payer.name + " доплатил дилеру " + payment);

    } else {
        log(room, "Последний стакан целиком ушёл дилеру");
    }

    endRound(room, fx);
}


/* =========================================================
   КОНЕЦ РАУНДА И ПАРТИИ
========================================================= */

function endRound(room, fx) {
    stopClock(room);

    room.results = room.players.map(p => ({
        playerId: p.id,
        name: p.name,
        chips: p.chips,
        delta: p.chips - (room.snapshot[p.id] || 0)
    }));

    if (room.players.some(p => p.chips <= 0)) return finishGame(room);

    room.phase = "roundEnd";
    room.note = "Раунд сыгран";

    armTurn(room);
}

function nextRound(room) {
    room.dealerIndex = (room.dealerIndex + 1) % room.players.length;
    startRound(room);
}

function finishGame(room) {
    stopClock(room);

    room.phase = "over";
    log(room, "Партия окончена");
    room.note = "";

    room.standings = room.players
        .slice()
        .sort((a, b) => b.chips - a.chips)
        .map((p, i) => ({
            place: i + 1,
            name: p.name,
            chips: p.chips,
            bankrupt: p.chips <= 0
        }));
}


/* =========================================================
   ВЫХОД ИГРОКА
   Фишки ушедшего сразу делятся между оставшимися.
========================================================= */

function dropPlayer(room, playerId, fx) {
    const index = seatOf(room, playerId);

    if (index < 0) return;

    const leaver = room.players[index];
    const wasDealer = index === room.dealerIndex;
    const active = activePlayer(room) === playerId;
    const pot = leaver.chips;

    room.players.splice(index, 1);
    room.departed[playerId] = true;

    if (index < room.dealerIndex) room.dealerIndex--;
    if (room.players.length) room.dealerIndex = room.dealerIndex % room.players.length;

    if (room.hostId === playerId && room.players.length) {
        room.hostId = room.players[0].id;
    }

    room.order = room.order.filter(id => id !== playerId);

    if (room.auction) {
        room.auction.queue = room.auction.queue.filter(id => id !== playerId);
        room.auction.pos = Math.min(room.auction.pos, room.auction.queue.length);
    }

    if (room.betting) {
        room.betting.queue = room.betting.queue.filter(id => id !== playerId);
        room.betting.order = room.betting.order.filter(id => id !== playerId);
        room.betting.pos = Math.min(room.betting.pos, room.betting.queue.length);
    }

    if (room.phase === "lobby") return;

    spread(room, pot);
    log(room, leaver.name + " вышел, его " + pot + " фишек разделены поровну");

    if (room.players.length < MIN_PLAYERS) return finishGame(room);
    if (room.phase === "over") return;

    // дилер ушёл посреди раздачи — стаканы возвращаются столу, раунд заново
    if (wasDealer && room.phase !== "roundEnd") {
        let orphan = 0;

        room.cups.filter(c => !c.opened).forEach(cup => {
            orphan += cup.chips;

            cup.bets.forEach(bet => {
                const bettor = at(room, bet.playerId);
                if (bettor) bettor.chips += bet.amount;
                else orphan += bet.amount;
            });
        });

        spread(room, orphan);
        log(room, "Дилер вышел из раздачи, стаканы разделены между столом");

        return startRound(room);
    }

    if (room.phase === "roundEnd" || room.phase === "distribution") return;

    if (active) resume(room, fx);
}

/* доигрывает застрявший этап, если ушёл тот, чей был ход */
function resume(room, fx) {
    if (room.phase === "auction") return askAuction(room);
    if (room.phase === "betting") return askBet(room);
    if (room.phase === "choosing") return nextChooser(room);
}


/* =========================================================
   ТАЙМЕРЫ
   Действие выводится из фазы, поэтому переживает перезапуск.
========================================================= */

function onTimeout(room, fx) {
    if (room.phase === "distribution") {
        return applyDistribution(room, randomSplit(dealerNeeds(room), room.players.length));
    }

    if (room.phase === "auction") {
        const id = activePlayer(room);
        return id ? auctionAnswer(room, id, null) : askAuction(room);
    }

    if (room.phase === "betting") {
        const id = activePlayer(room);
        const player = at(room, id);

        if (!player) return askBet(room);

        if (room.betting.pos === 0) {
            const amount = Math.min(room.betting.committed, player.chips);
            return applyBet(room, id, Math.floor(Math.random() * room.cups.length), amount);
        }

        return skipBet(room);
    }

    if (room.phase === "choosing") {
        const id = activePlayer(room);

        if (!id || closedCups(room) <= 1) return nextChooser(room);

        const free = room.cups.map((c, i) => (c.opened ? -1 : i)).filter(i => i >= 0);
        return takeCup(room, id, free[Math.floor(Math.random() * free.length)], fx);
    }

    if (room.phase === "roundEnd") return nextRound(room);
}

/* вызывается общим циклом каждые несколько сотен миллисекунд */
function tick(room, fx) {
    const now = Date.now();
    let changed = false;

    if (room.revealAt && now >= room.revealAt) {
        room.revealAt = 0;
        openLastCup(room, fx);
        changed = true;
    }

    if (room.deadline && now >= room.deadline) {
        room.deadline = 0;
        onTimeout(room, fx);
        changed = true;
    }

    return changed;
}


/* =========================================================
   ВИД ДЛЯ КЛИЕНТА
   Закрытые стаканы и чужие балансы наружу не уходят.
========================================================= */

function viewFor(room, viewerId, fx, version) {
    const open = room.phase === "roundEnd" || room.phase === "over" || room.phase === "lobby";

    return {
        t: "state",
        version,
        code: room.code,
        hostId: room.hostId,
        phase: room.phase,
        roundId: room.roundId,
        startingChips: room.startingChips,

        you: viewerId,
        spectator: !at(room, viewerId),

        dealerId: dealer(room) ? dealer(room).id : null,
        activeId: activePlayer(room),
        order: room.order,

        players: room.players.map(p => ({
            id: p.id,
            name: p.name,
            chips: (open || p.id === viewerId)
                ? p.chips
                : (room.snapshot[p.id] !== undefined ? room.snapshot[p.id] : p.chips),
            exact: open || p.id === viewerId,
            delta: open && room.snapshot[p.id] !== undefined ? p.chips - room.snapshot[p.id] : null,
            connected: p.connected,
            isDealer: room.phase !== "lobby" && dealer(room) && p.id === dealer(room).id
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
            bids: room.auction.bids
        },

        betting: room.betting && {
            currentId: room.betting.queue[room.betting.pos] || null,
            mandatory: room.betting.pos === 0,
            committed: room.betting.committed
        },

        deadlineIn: room.deadline ? Math.max(0, room.deadline - Date.now()) : 0,
        turnSeq: room.turnSeq,

        message: room.message,
        note: room.note,
        results: room.results,
        standings: room.standings,

        fx: fx || []
    };
}


module.exports = {
    TURN_MS, REVEAL_MS, MIN_PLAYERS, MAX_PLAYERS,
    at, seatOf, dealer, activePlayer, closedCups,
    startGame, startRound, dealerNeeds,
    checkDistribution, applyDistribution,
    auctionAnswer, betFloor, applyBet, skipBet,
    takeCup, nextRound, finishGame,
    dropPlayer, tick, viewFor, randomSplit
};
