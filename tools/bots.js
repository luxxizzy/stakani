/* =========================================================
   Боты для локального просмотра.
   Запуск: npm run bots -- КОД [сколько] [адрес]
   Пример: npm run bots -- ABCD 2
========================================================= */

const WebSocket = require("ws");

const code = (process.argv[2] || "").toUpperCase();
const count = Number(process.argv[3] || 2);
const host = process.argv[4] || "ws://localhost:3000";

if (code.length !== 4) {
    console.log("Укажи код стола: npm run bots -- ABCD 2");
    process.exit(1);
}

const NAMES = ["Тень", "Крупье", "Шулер", "Барон", "Фарт", "Гость", "Хмурый"];

const pause = ms => new Promise(r => setTimeout(r, ms));
const pick = list => list[Math.floor(Math.random() * list.length)];

function spawn(index) {
    const name = NAMES[index % NAMES.length];
    const id = "bot-" + name + "-" + Math.random().toString(36).slice(2, 7);
    const ws = new WebSocket(host);

    let busy = false;

    ws.on("open", () => {
        console.log(name + " садится за стол " + code);
        ws.send(JSON.stringify({ t: "join", code, name, playerId: id }));
    });

    ws.on("message", async raw => {
        const msg = JSON.parse(raw);

        if (msg.t === "error") return console.log(name + ": " + msg.msg);
        if (msg.t !== "state") return;

        if (msg.activeId !== id || busy) return;

        busy = true;
        await pause(900 + Math.random() * 1600);

        const me = msg.players.find(p => p.id === id);

        if (!me) { busy = false; return; }

        if (msg.phase === "distribution") {
            const need = Math.min(msg.dealerMin, me.chips);
            const values = new Array(msg.players.length).fill(0);

            let left = need;

            for (let i = 0; i < values.length && left > 0; i++) {
                const v = i === values.length - 1 ? left : Math.floor(Math.random() * (left + 1));
                values[i] = v;
                left -= v;
            }

            values[Math.floor(Math.random() * values.length)] += left;
            ws.send(JSON.stringify({ t: "distribute", values }));
        }

        if (msg.phase === "auction") {
            const floor = Math.min(msg.betMin, me.chips);

            if (Math.random() < 0.45) ws.send(JSON.stringify({ t: "bid", pass: true }));
            else ws.send(JSON.stringify({ t: "bid", amount: floor }));
        }

        if (msg.phase === "betting") {
            const closed = msg.cups.map((c, i) => (c.opened ? -1 : i)).filter(i => i >= 0);

            if (!msg.betting.mandatory && Math.random() < 0.5) {
                ws.send(JSON.stringify({ t: "bet", skip: true }));
            } else {
                const floor = msg.betting.mandatory
                    ? Math.min(msg.betting.committed, me.chips)
                    : Math.min(msg.betMin, me.chips);

                ws.send(JSON.stringify({ t: "bet", cup: pick(closed), amount: floor }));
            }
        }

        if (msg.phase === "choosing") {
            const closed = msg.cups.map((c, i) => (c.opened ? -1 : i)).filter(i => i >= 0);

            if (closed.length > 1) ws.send(JSON.stringify({ t: "open", cup: pick(closed) }));
        }

        if (msg.phase === "roundEnd" && Math.random() < 0.3) {
            ws.send(JSON.stringify({ t: "react", emoji: pick(["😂", "😱", "🔥", "🤔", "😈", "🫡"]) }));
        }

        busy = false;
    });

    ws.on("close", () => console.log(name + " ушёл"));
    ws.on("error", e => console.log(name + ": " + e.message));
}

for (let i = 0; i < count; i++) spawn(i);

console.log("Боты подключаются. Останови их через Ctrl+C.");
