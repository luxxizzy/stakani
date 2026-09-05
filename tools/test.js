/* =========================================================
   Тесты правил. Работают напрямую с game.js, без сети.
   Запуск: npm test
========================================================= */

const game = require("../server/game");

let passed = 0;
let failed = 0;

function check(label, condition, extra) {
    if (condition) {
        passed++;
        console.log("  ok   " + label);
    } else {
        failed++;
        console.log("  ПРОВАЛ " + label + (extra ? "  → " + extra : ""));
    }
}

function group(title) {
    console.log("\n" + title);
}

function table(names, chips) {
    return {
        code: "TEST",
        hostId: names[0],
        phase: "lobby",
        startingChips: chips,
        players: names.map(n => ({ id: n, name: n, chips, connected: true, offlineAt: null })),
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

const pot = room => room.players.reduce((s, p) => s + p.chips, 0)
    + room.cups.reduce((s, c) => s + (c.opened ? 0 : c.chips)
        + c.bets.reduce((b, x) => b + (c.opened ? 0 : x.amount), 0), 0);

/* вскрывает последний стакан, не дожидаясь паузы */
function reveal(room, fx) {
    room.revealAt = 1;
    game.tick(room, fx);
}

/* прогоняет раунд до конца, что бы ни происходило */
function playOut(room, fx) {
    for (let i = 0; i < 80; i++) {
        if (room.phase === "roundEnd" || room.phase === "over") return true;

        if (room.revealAt) { reveal(room, fx); continue; }

        room.deadline = 1;
        game.tick(room, fx);
    }

    return false;
}


/* ---------- 1. базовый раунд ---------- */

group("Раунд втроём");
{
    const room = table(["Аня", "Боря", "Вова"], 100);
    game.startGame(room, 100);

    check("минимум дилера — 10% от стека", room.dealerMin === 10, room.dealerMin);
    check("минимальная ставка — вдвое больше", room.betMin === 20, room.betMin);
    check("фаза раскладки", room.phase === "distribution");

    check("мало фишек не проходит", !!game.checkDistribution(room, [1, 1, 1]));
    check("больше банка не проходит", !!game.checkDistribution(room, [200, 0, 0]));
    check("верная раскладка проходит", !game.checkDistribution(room, [20, 5, 5]));

    game.applyDistribution(room, [20, 5, 5]);

    check("после раскладки идут торги", room.phase === "auction");
    check("у дилера списано ровно 30", room.players[0].chips === 70, room.players[0].chips);

    game.auctionAnswer(room, "Боря", 25);
    game.auctionAnswer(room, "Вова", null);

    check("победитель торгов ставит первым", room.betting.queue[0] === "Боря");
    check("обязан поставить названное", room.betting.committed === 25);

    game.applyBet(room, "Боря", 0, 25);

    check("ставка списана", room.players[1].chips === 75, room.players[1].chips);
    check("после ставок вскрытие", room.phase === "choosing");
    check("спасовавший ходит следом", room.order.join() === "Боря,Вова");

    const fx = [];
    game.takeCup(room, "Боря", 1, fx);
    game.takeCup(room, "Вова", 0, fx);

    check("сгоревшая ставка ушла вскрывшему", room.players[2].chips === 100 + 20 + 25,
        room.players[2].chips);

    reveal(room, fx);

    check("доплата за последний стакан снята", room.players[2].chips === 142,
        room.players[2].chips);
    check("раунд закрыт", room.phase === "roundEnd", room.phase);
    check("сумма фишек цела", pot(room) === 300, pot(room));
}


/* ---------- 2. выигравшая ставка ---------- */

group("Ставка меньше содержимого");
{
    const room = table(["Аня", "Боря", "Вова"], 100);
    game.startGame(room, 100);
    game.applyDistribution(room, [60, 0, 0]);

    game.auctionAnswer(room, "Боря", 20);
    game.auctionAnswer(room, "Вова", null);
    game.applyBet(room, "Боря", 0, 20);

    check("ставка списана", room.players[1].chips === 80);

    const fx = [];
    game.takeCup(room, "Боря", 1, fx);

    check("Боря вскрыл пустой", room.players[1].chips === 80);

    game.takeCup(room, "Вова", 0, fx);

    check("ставка вернулась и украла столько же", room.players[1].chips === 80 + 40,
        room.players[1].chips);
    check("вскрывший забрал остаток", room.players[2].chips === 100 + 40, room.players[2].chips);

    reveal(room, fx);

    check("раунд закрыт", room.phase === "roundEnd", room.phase);
    check("сумма фишек цела", pot(room) === 300, pot(room));
}


/* ---------- 3. вдвоём ---------- */

group("Игра вдвоём");
{
    const room = table(["Дима", "Егор"], 40);
    game.startGame(room, 40);

    check("минимум дилера от 40", room.dealerMin === 4);

    game.applyDistribution(room, [10, 6]);

    check("торгов нет", room.phase === "choosing" && room.auction === null);
    check("ходит соперник", game.activePlayer(room) === "Егор");

    const fx = [];
    game.takeCup(room, "Егор", 0, fx);
    reveal(room, fx);

    check("раунд закрыт", room.phase === "roundEnd", room.phase);
    check("сумма фишек цела", pot(room) === 80, pot(room));
}


/* ---------- 4. банкротство ---------- */

group("Банкротство");
{
    const room = table(["Аня", "Боря", "Вова"], 10);
    game.startGame(room, 10);
    game.applyDistribution(room, [1, 0, 0]);

    game.auctionAnswer(room, "Боря", 10);
    game.auctionAnswer(room, "Вова", null);
    game.applyBet(room, "Боря", 0, 10);

    check("ушёл ва-банк", room.players[1].chips === 0);

    const fx = [];
    game.takeCup(room, "Боря", 1, fx);
    game.takeCup(room, "Вова", 0, fx);
    reveal(room, fx);

    check("партия завершена", room.phase === "over", room.phase);
    check("места расставлены", room.standings.length === 3);
    check("банкрот последний", room.standings[2].bankrupt === true);
    check("первый — с наибольшим стеком",
        room.standings[0].chips >= room.standings[1].chips);
    check("сумма фишек цела", pot(room) === 30, pot(room));
}


/* ---------- 5. выход игрока ---------- */

group("Выход посреди партии");
{
    const room = table(["Аня", "Боря", "Вова", "Галя"], 100);
    game.startGame(room, 100);
    game.applyDistribution(room, [20, 10, 5, 5]);

    const fx = [];
    game.dropPlayer(room, "Боря", fx);

    check("игрок убран со стола", room.players.length === 3);
    check("нельзя вернуться", room.departed["Боря"] === true);
    check("его фишки разошлись поровну", pot(room) === 400, pot(room));
    check("очередь не сломалась", !room.order.includes("Боря")
        && (!room.auction || !room.auction.queue.includes("Боря")));

    check("раунд доигрывается до конца", playOut(room, fx), room.phase);
    check("сумма фишек цела", pot(room) === 400, pot(room));
}


/* ---------- 6. выход дилера ---------- */

group("Выход дилера из раздачи");
{
    const room = table(["Аня", "Боря", "Вова"], 100);
    game.startGame(room, 100);
    game.applyDistribution(room, [30, 10, 10]);

    const fx = [];
    game.dropPlayer(room, "Аня", fx);

    check("стол пересдан", room.phase === "distribution");
    check("осталось двое", room.players.length === 2);
    check("фишки со стола вернулись", pot(room) === 300, pot(room));
}


/* ---------- 7. таймеры ---------- */

group("Ходы по таймеру");
{
    const room = table(["Аня", "Боря", "Вова"], 100);
    game.startGame(room, 100);

    const fx = [];

    check("раунд доигрывается сам", playOut(room, fx), room.phase);
    check("сумма фишек цела", pot(room) === 300, pot(room));
    check("кто-то что-то получил", fx.some(f => f.kind === "chips"));
}


/* ---------- 8. сто партий подряд ---------- */

group("Сто партий подряд");
{
    let broken = 0;
    let hung = 0;
    let longest = 0;
    let finished = 0;
    let rounds = 0;

    for (let n = 0; n < 100; n++) {
        const size = 2 + Math.floor(Math.random() * 7);
        const names = Array.from({ length: size }, (_, i) => "И" + i);
        const room = table(names, 60);

        game.startGame(room, 60);

        let round = 0;

        while (room.phase !== "over" && round < 300) {
            const fx = [];

            if (!playOut(room, fx)) { hung++; break; }
            if (pot(room) !== size * 60) { broken++; break; }

            if (room.phase === "roundEnd") game.nextRound(room);

            round++;
        }

        rounds += round;
        longest = Math.max(longest, round);
        if (room.phase === "over") finished++;
    }

    check("нигде не потерялись фишки", broken === 0, broken + " партий с расхождением");
    check("нигде не зависло", hung === 0, hung + " зависших партий");

    console.log("  инфо  партий доиграно до банкротства: " + finished + " из 100"
        + ", в среднем раундов: " + Math.round(rounds / 100)
        + ", самая долгая: " + longest);
}

/* ---------- итог ---------- */

console.log("\n" + (failed ? "ПРОВАЛЕНО: " + failed + ", пройдено: " + passed
    : "все проверки пройдены: " + passed));

process.exit(failed ? 1 : 0);
