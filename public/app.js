/* =========================================================
   TUMBLERS — клиент
   Док внизу всегда на экране и показывает только то,
   что нужно для текущего решения.
========================================================= */

const EMOJI = ["😂", "😱", "🔥", "🤔", "😈", "🫡"];

const $ = id => document.getElementById(id);

let ws = null;
let state = null;
let roomCode = null;
let watching = false;
let quit = false;

let myId = localStorage.getItem("tumblersId");
let myName = localStorage.getItem("tumblersName") || "";

let slotsRound = -1;
let revealed = new Set();
let shownRound = -1;
let dealtRound = -1;
let lastPhase = null;
let pickedCup = null;
let retryIn = 1000;

if (!myId) {
    myId = Math.random().toString(36).slice(2) + Date.now().toString(36);
    localStorage.setItem("tumblersId", myId);
}

const calm = window.matchMedia("(prefers-reduced-motion: reduce)").matches;


/* =========================================================
   СВЯЗЬ
========================================================= */

function connect() {
    const scheme = location.protocol === "https:" ? "wss://" : "ws://";
    ws = new WebSocket(scheme + location.host);

    ws.onopen = () => {
        retryIn = 1000;
        setStatus("на связи", false);

        const code = quit ? null : (roomCode || sessionStorage.getItem("tumblersRoom"));

        if (code && myName) {
            send({ t: "join", code, name: myName, playerId: myId, watch: watching });
        }
    };

    ws.onclose = () => {
        setStatus("связь потеряна, переподключаемся", true);
        setTimeout(connect, retryIn);
        retryIn = Math.min(retryIn * 1.5, 10000);
    };

    ws.onmessage = event => {
        const msg = JSON.parse(event.data);

        if (msg.t === "joined") {
            roomCode = msg.code;
            watching = msg.role === "spectator";
            sessionStorage.setItem("tumblersRoom", msg.code);
            history.replaceState(null, "", "?table=" + msg.code);
            return;
        }

        if (msg.t === "error") return toast(msg.msg);
        if (msg.t === "fx") return playFx(msg.fx);
        if (msg.t === "left") return backToEntry();

        if (msg.t === "state" && !quit) {
            state = msg;
            roomCode = msg.code;
            render();
            playFx(msg.fx);
        }
    };
}

function send(payload) {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
    else toast("Нет связи с сервером, подожди секунду");
}

function setStatus(text, down) {
    const el = $("status");
    el.textContent = text;
    el.className = "status" + (down ? " down" : "");
}

let toastNode = null;
let toastTimer = null;

function toast(text, kind) {
    if (toastNode) toastNode.remove();

    toastNode = document.createElement("div");
    toastNode.className = "toast" + (kind === "info" ? " info" : "");
    toastNode.textContent = text;
    document.body.appendChild(toastNode);

    clearTimeout(toastTimer);

    toastTimer = setTimeout(() => {
        if (toastNode) toastNode.remove();
        toastNode = null;
    }, 4000);
}


/* =========================================================
   ВХОД И ВЫХОД
========================================================= */

function readName() {
    const name = $("nameInput").value.trim();

    if (!name) {
        toast("Впиши имя, чтобы тебя было видно за столом");
        return null;
    }

    myName = name;
    localStorage.setItem("tumblersName", name);
    return name;
}

function createTable() {
    const name = readName();
    if (!name) return;

    quit = false;
    watching = false;
    send({ t: "create", name, playerId: myId });
}

function joinTable(watch) {
    const name = readName();
    if (!name) return;

    const code = $("codeInput").value.trim().toUpperCase();

    if (code.length !== 4) return toast("Код стола состоит из 4 символов");

    quit = false;
    watching = !!watch;
    send({ t: "join", code, name, playerId: myId, watch: watching });
}

function leaveTable() {
    const mid = state && !state.spectator
        && state.phase !== "lobby" && state.phase !== "over";

    if (mid && !confirm("Выйти из партии? Фишки разойдутся между остальными, вернуться уже нельзя.")) {
        return;
    }

    quit = true;
    send({ t: "leave" });
    backToEntry();
}

function backToEntry() {
    quit = true;
    state = null;
    roomCode = null;
    pickedCup = null;
    slotsRound = -1;
    lastPhase = null;

    clearInterval(timerHandle);
    sessionStorage.removeItem("tumblersRoom");
    history.replaceState(null, "", location.pathname);

    show("entryScreen", true);
    show("lobbyScreen", false);
    show("tableArea", false);
    show("dock", false);
    show("tableTag", false);
    show("reactionTray", false);
}

function copyLink() {
    const link = location.origin + "/?table=" + roomCode;

    navigator.clipboard.writeText(link)
        .then(() => toast("Ссылка скопирована", "info"))
        .catch(() => toast(link, "info"));
}


/* =========================================================
   ХОДЫ
========================================================= */

function sendLayout() {
    const values = [];

    for (let i = 0; i < state.players.length; i++) {
        values.push(Number($("slot-" + i).value) || 0);
    }

    send({ t: "distribute", values });
}

function touchCup(index) {
    if (state.phase === "choosing") return send({ t: "open", cup: index });

    if (state.phase === "betting" && state.betting.currentId === myId) {
        pickedCup = index;
        render();
    }
}


/* =========================================================
   МЕЛОЧИ ОТРИСОВКИ
========================================================= */

const me = () => state.players.find(p => p.id === myId);
const amHost = () => state.hostId === myId;
const amDealer = () => state.dealerId === myId;
const myMove = () => state.activeId === myId;

function show(id, on) { $(id).classList.toggle("hidden", !on); }

function art(id) { return $(id).content.cloneNode(true); }

function esc(str) {
    return String(str).replace(/[&<>"']/g, c => ({
        "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    }[c]));
}

/* устойчивый цвет игрока по его идентификатору */
function hueOf(id) {
    let sum = 0;
    for (let i = 0; i < id.length; i++) sum = (sum * 31 + id.charCodeAt(i)) % 360;
    return sum;
}

/* стопка фишек: высота соответствует сумме */
function pile(amount, unit, cap) {
    const box = document.createElement("div");
    box.className = "hoard-pile";

    const count = Math.max(1, Math.min(cap || 7, Math.ceil(amount / Math.max(1, unit))));

    for (let i = 0; i < count; i++) {
        const disc = document.createElement("div");
        disc.className = "disc";
        disc.style.bottom = (i * 5) + "px";
        disc.style.marginLeft = (-13 + (i % 2 ? 1.5 : -1.5)) + "px";
        disc.style.animationDelay = (i * 45) + "ms";
        box.appendChild(disc);
    }

    return box;
}

/* число набегает от нуля */
function countUp(node, target) {
    if (calm || target <= 0) { node.textContent = target; return; }

    const started = performance.now();
    const span = 420;

    const step = now => {
        const k = Math.min(1, (now - started) / span);
        node.textContent = Math.round(target * (1 - (1 - k) * (1 - k)));

        if (k < 1) requestAnimationFrame(step);
        else node.textContent = target;
    };

    requestAnimationFrame(step);
}


/* =========================================================
   ОТРИСОВКА
========================================================= */

function render() {
    $("build").textContent = "v" + state.version;
    $("roomCode").textContent = state.code;
    show("tableTag", true);

    const lobby = state.phase === "lobby";

    show("entryScreen", false);
    show("lobbyScreen", lobby);
    show("tableArea", !lobby);
    show("dock", !lobby);

    if (lobby) {
        renderLobby();
        slotsRound = -1;
        lastPhase = state.phase;
        return;
    }

    if (shownRound !== state.roundId) {
        shownRound = state.roundId;
        revealed = new Set();
        pickedCup = null;
    }

    renderSeats();
    renderCups();
    renderCrest();
    renderDock();

    if (state.phase === "over" && lastPhase !== "over") crownWinner();

    lastPhase = state.phase;
}

function renderLobby() {
    const list = $("lobbyList");
    list.innerHTML = "";

    state.players.forEach(p => {
        const item = document.createElement("div");
        item.className = "tape-item";
        item.textContent = p.name + (p.id === state.hostId ? " · собрал стол" : "");
        list.appendChild(item);
    });

    const n = state.players.length;

    show("hostControls", amHost());

    $("lobbyStatus").textContent = amHost()
        ? (n < 2 ? "Пока только ты. Нужен хотя бы один соперник." : "За столом " + n + ", можно начинать.")
        : "Партию начинает тот, кто собрал стол. Сейчас за столом " + n + ".";

    if (amHost()) $("startButton").disabled = n < 2;
}

function renderSeats() {
    const arena = $("arena");

    arena.querySelectorAll(".seat").forEach(node => node.remove());

    const n = state.players.length;
    const mine = state.players.findIndex(p => p.id === myId);
    const anchor = mine >= 0 ? mine : 0;
    const narrow = window.innerWidth <= 720;

    const rx = narrow ? 41 : 47;
    const ry = narrow ? 43 : 42;

    state.players.forEach((p, i) => {
        const step = ((i - anchor) + n) % n;
        const angle = (90 + step * (360 / n)) * Math.PI / 180;

        const node = document.createElement("div");

        node.className = "seat"
            + (p.isDealer ? " dealer" : "")
            + (p.id === myId ? " me" : "")
            + (p.connected ? "" : " gone")
            + (p.id === state.activeId ? " acting" : "");

        node.id = "seat-" + p.id;
        node.style.left = (50 + rx * Math.cos(angle)) + "%";
        node.style.top = (50 + ry * Math.sin(angle)) + "%";

        const role = !p.connected ? "ждём"
            : p.id === state.activeId ? "ходит"
            : p.isDealer ? "дилер"
            : "фишек";

        const delta = p.delta
            ? '<div class="seat-delta ' + (p.delta > 0 ? "up" : "down") + '">'
                + (p.delta > 0 ? "+" : "") + p.delta + "</div>"
            : "";

        const ring = p.id === state.activeId
            ? '<svg class="avatar-ring" id="ring-' + p.id + '" viewBox="0 0 38 38">'
                + '<circle cx="19" cy="19" r="17.4" stroke-dasharray="109.3" stroke-dashoffset="0"></circle></svg>'
            : "";

        node.innerHTML =
            (p.isDealer ? '<div class="dealer-mark">D</div>' : "")
            + '<div class="avatar" style="--hue:' + hueOf(p.id) + '">'
            + '<div class="avatar-face">' + esc(p.name.slice(0, 1).toUpperCase()) + "</div>"
            + ring
            + "</div>"
            + '<div class="seat-name">' + esc(p.name) + (p.id === myId ? " · ты" : "") + "</div>"
            + '<div class="seat-chips' + (p.exact ? "" : " veiled") + '">' + p.chips + "</div>"
            + delta
            + '<div class="seat-role">' + role + "</div>";

        arena.appendChild(node);
    });
}

function renderCups() {
    const box = $("cups");
    box.innerHTML = "";

    const opening = state.phase === "choosing" && myMove();
    const staking = state.phase === "betting" && myMove();
    const closed = state.cups.filter(c => !c.opened).length;

    const placed = state.cups.length > 0;
    const dealing = placed && dealtRound !== state.roundId;

    if (dealing) dealtRound = state.roundId;

    const cups = placed
        ? state.cups
        : state.players.map((p, i) => ({ number: i + 1, opened: false, chips: null, bets: [] }));

    const unit = Math.max(1, Math.round((state.dealerMin || 10) / 4));

    cups.forEach((cup, index) => {
        const fresh = cup.opened && !revealed.has(cup.number);
        const live = !cup.opened && ((opening && closed > 1) || staking);

        const node = document.createElement("button");

        node.className = "cup"
            + (cup.opened ? " opened" : "")
            + (fresh ? " just" : "")
            + (cup.opened && !cup.chips ? " empty" : "")
            + (live ? " live" : "")
            + (dealing && !cup.opened ? " deal" : "")
            + (pickedCup === index ? " picked" : "")
            + (!cup.opened && cup.bets.length ? " targeted" : "");

        node.id = "cup-" + cup.number;
        node.disabled = !live;

        const stage = document.createElement("div");
        stage.className = "cup-stage";

        const shadow = document.createElement("div");
        shadow.className = "cup-shadow";

        const hoard = document.createElement("div");
        hoard.className = "hoard";

        if (cup.opened) {
            if (cup.chips > 0) hoard.appendChild(pile(cup.chips, unit));

            const sum = document.createElement("div");
            sum.className = "hoard-sum";
            sum.textContent = cup.chips;
            hoard.appendChild(sum);

            if (fresh) setTimeout(() => countUp(sum, cup.chips), 340);
        }

        const vessel = document.createElement("div");
        vessel.className = "vessel";
        vessel.appendChild(art("tumbler"));

        const glint = document.createElement("div");
        glint.className = "glint";

        stage.appendChild(shadow);
        stage.appendChild(hoard);
        stage.appendChild(vessel);
        stage.appendChild(glint);

        if (fresh && !cup.chips) {
            for (let d = 0; d < 5; d++) {
                const speck = document.createElement("div");
                speck.className = "dust";
                speck.style.setProperty("--dx", (d - 2) * 9 + "px");
                speck.style.animationDelay = (120 + d * 40) + "ms";
                stage.appendChild(speck);
            }
        }

        if (dealing && !cup.opened) {
            vessel.style.animationDelay = (index * 70) + "ms";
        }

        const label = document.createElement("div");
        label.className = "cup-label";
        label.textContent = cup.opened ? (cup.openedBy || "") : "№" + cup.number;

        node.appendChild(stage);
        node.appendChild(label);

        if (cup.bets.length) {
            const stakes = document.createElement("div");
            stakes.className = "stakes";

            cup.bets.forEach(bet => {
                const stake = document.createElement("div");
                stake.className = "stake";
                stake.style.setProperty("--hue", hueOf(bet.playerId));

                const stack = pile(bet.amount, unit * 2, 5);
                stack.className = "stake-pile";

                const tag = document.createElement("div");
                tag.className = "stake-tag";
                tag.textContent = bet.amount;
                tag.title = bet.name;

                stake.appendChild(stack);
                stake.appendChild(tag);
                stakes.appendChild(stake);
            });

            node.appendChild(stakes);
        }

        if (live) node.onclick = () => touchCup(index);

        box.appendChild(node);

        if (cup.opened) revealed.add(cup.number);
    });
}

function renderCrest() {
    const line = $("headline");

    line.textContent = state.message || "";
    line.classList.toggle("mine", myMove());

    $("subline").textContent = state.note || "";

    runTimer(state.deadlineIn, state.turnSeq);
}

let timerHandle = null;
let timerSeq = -1;
let timerEnd = 0;
let timerSpan = 0;

function runTimer(ms, seq) {
    const track = $("dockTimer");
    const bar = $("dockTimerBar");

    if (!ms) {
        clearInterval(timerHandle);
        timerSeq = -1;
        track.classList.add("hidden");
        return;
    }

    track.classList.remove("hidden");

    if (seq !== timerSeq) {
        clearInterval(timerHandle);
        timerSeq = seq;
        timerEnd = Date.now() + ms;
        timerSpan = ms;
        timerHandle = setInterval(paintTimer, 200);
    }

    paintTimer();
}

function paintTimer() {
    const track = $("dockTimer");
    const bar = $("dockTimerBar");
    const ring = state ? $("ring-" + state.activeId) : null;

    const left = Math.max(0, timerEnd - Date.now());
    const share = timerSpan ? left / timerSpan : 0;

    bar.style.width = (share * 100) + "%";
    track.classList.toggle("urgent", left < 10000);

    if (ring) {
        ring.querySelector("circle").style.strokeDashoffset = (109.3 * (1 - share)).toFixed(1);
        ring.classList.toggle("urgent", left < 10000);
    }

    if (left <= 0) clearInterval(timerHandle);
}


/* =========================================================
   ДОК: только текущее решение
========================================================= */

function renderDock() {
    const dock = $("dock");
    const body = $("dockBody");

    dock.classList.toggle("turn", myMove());

    if (state.spectator) {
        slotsRound = -1;
        body.innerHTML = brief("Ты смотришь со стороны. Сядешь играть в следующей партии.") + watchers();
        return;
    }

    if (state.phase === "over") return dockOver(body);
    if (state.phase === "roundEnd") return dockRoundEnd(body);
    if (state.phase === "distribution") return dockLayout(body);
    if (state.phase === "auction") return dockAuction(body);
    if (state.phase === "betting") return dockStake(body);

    slotsRound = -1;

    body.innerHTML = myMove()
        ? brief("Твой ход. Вскрой любой стакан на столе.", true)
        : brief("Ходит " + esc(nameOfActive()) + ". Стаканы вскрываются на глазах у всех.") + watchers();
}

function nameOfActive() {
    const p = state.players.find(x => x.id === state.activeId);
    return p ? p.name : "никто";
}

function brief(html, call) {
    return '<p class="dock-brief' + (call ? " call" : "") + '">' + html + "</p>";
}

function watchers() {
    return state.spectators.length
        ? '<div class="watchers">смотрят: ' + esc(state.spectators.map(s => s.name).join(", ")) + "</div>"
        : "";
}

function dockLayout(body) {
    if (!amDealer()) {
        slotsRound = -1;
        body.innerHTML = brief("Дилер прячет фишки. По правилам он обязан выложить не меньше <b>"
            + state.dealerMin + "</b>.") + watchers();
        return;
    }

    if (slotsRound === state.roundId && $("slot-0")) return updateTally();

    const need = Math.min(state.dealerMin, me().chips);

    body.innerHTML =
        brief("Ты дилер. Разложи минимум <b>" + need + "</b> фишек — соперники не увидят, где сколько.", true)
        + '<div class="slots" id="slots"></div>'
        + '<div class="tally" id="tally"></div>'
        + '<div class="dock-actions">'
        + '<button class="ghost" id="scatterButton">Наугад</button>'
        + '<button id="dealButton">Накрыть стаканы</button>'
        + "</div>";

    const slots = $("slots");

    for (let i = 0; i < state.players.length; i++) {
        const cell = document.createElement("div");
        cell.className = "slot";
        cell.appendChild(art("tumblerMini"));

        const counter = document.createElement("div");
        counter.className = "slot-count";

        const minus = document.createElement("button");
        minus.textContent = "−";
        minus.setAttribute("aria-label", "убрать фишки из стакана " + (i + 1));

        const input = document.createElement("input");
        input.type = "number";
        input.inputMode = "numeric";
        input.min = "0";
        input.value = "0";
        input.id = "slot-" + i;

        const plus = document.createElement("button");
        plus.textContent = "+";
        plus.setAttribute("aria-label", "добавить фишки в стакан " + (i + 1));

        const bump = direction => {
            const step = Math.max(1, Math.round(need / 10));
            input.value = Math.max(0, (Number(input.value) || 0) + direction * step);
            updateTally();
        };

        minus.onclick = () => bump(-1);
        plus.onclick = () => bump(1);
        input.addEventListener("input", updateTally);

        counter.appendChild(minus);
        counter.appendChild(input);
        counter.appendChild(plus);

        const label = document.createElement("div");
        label.className = "slot-name";
        label.textContent = "стакан " + (i + 1);

        cell.appendChild(counter);
        cell.appendChild(label);
        slots.appendChild(cell);
    }

    $("dealButton").onclick = sendLayout;
    $("scatterButton").onclick = scatter;

    slotsRound = state.roundId;
    updateTally();
}

function layoutTotal() {
    let total = 0;

    for (let i = 0; i < state.players.length; i++) {
        const input = $("slot-" + i);
        if (!input) continue;

        let v = Math.floor(Number(input.value));
        if (!(v > 0)) v = 0;

        total += v;
    }

    return total;
}

function updateTally() {
    const tally = $("tally");
    if (!tally) return;

    const total = layoutTotal();
    const bank = me().chips;
    const need = Math.min(state.dealerMin, bank);
    const bad = total > bank || total < need;

    tally.className = "tally" + (bad ? " bad" : "");

    tally.innerHTML = total > bank
        ? "под стаканами <b>" + total + "</b>, а в банке всего " + bank
        : total < need
            ? "под стаканами <b>" + total + "</b>, нужно хотя бы " + need
            : "под стаканами <b>" + total + "</b>, на руках останется <b>" + (bank - total) + "</b>";

    $("dealButton").disabled = bad;
}

function scatter() {
    const need = Math.min(state.dealerMin, me().chips);
    let left = need;
    const values = [];

    for (let i = 0; i < state.players.length; i++) {
        if (i === state.players.length - 1) values.push(left);
        else {
            const v = Math.floor(Math.random() * (left + 1));
            values.push(v);
            left -= v;
        }
    }

    values.sort(() => Math.random() - 0.5);

    for (let i = 0; i < state.players.length; i++) $("slot-" + i).value = values[i];

    updateTally();
}

let heldStake = null;
let heldSeq = -1;

function stakeControl(floor, ceiling, id) {
    if (heldSeq !== state.turnSeq) { heldStake = null; heldSeq = state.turnSeq; }

    const start = heldStake !== null && heldStake >= floor && heldStake <= ceiling
        ? heldStake
        : floor;

    return '<div class="stake-row">'
        + '<div class="stake-value" id="' + id + 'Value">' + start + "</div>"
        + '<div class="slider"><input type="range" id="' + id + '" min="' + floor
        + '" max="' + ceiling + '" value="' + start + '"></div>'
        + '<div class="quick">'
        + '<button data-set="' + floor + '">минимум</button>'
        + '<button data-set="' + Math.min(ceiling, floor * 2) + '">×2</button>'
        + '<button data-set="' + ceiling + '">всё</button>'
        + "</div></div>";
}

function wireStake(id) {
    const range = $(id);
    const value = $(id + "Value");

    const sync = () => {
        value.textContent = range.value;
        heldStake = Number(range.value);
    };

    range.addEventListener("input", sync);

    document.querySelectorAll(".quick button[data-set]").forEach(button => {
        button.onclick = () => { range.value = button.dataset.set; sync(); };
    });

    sync();
}

function dockAuction(body) {
    slotsRound = -1;

    const history = state.auction.bids.length
        ? '<div class="bidlog">'
            + esc(state.auction.bids.map(b => b.name + " — " + (b.amount === null ? "пас" : b.amount)).join(", "))
            + "</div>"
        : "";

    if (state.auction.currentId !== myId) {
        body.innerHTML = brief("Торги за первый ход. Кто назовёт больше, вскрывает первым "
            + "и обязан поставить названное на стакан.") + history;
        return;
    }

    const floor = Math.min(state.betMin, me().chips);

    body.innerHTML =
        brief("Сколько поставишь за право ходить первым?", true)
        + history
        + stakeControl(floor, me().chips, "bid")
        + '<div class="dock-actions">'
        + '<button class="ghost" id="passButton">Спасовать</button>'
        + '<button id="bidButton">Назвать ставку</button>'
        + "</div>";

    wireStake("bid");

    $("bidButton").onclick = () => send({ t: "bid", amount: Number($("bid").value) });
    $("passButton").onclick = () => send({ t: "bid", pass: true });
}

function dockStake(body) {
    slotsRound = -1;

    if (state.betting.currentId !== myId) {
        body.innerHTML = brief(esc(state.note)) + watchers();
        return;
    }

    const forced = state.betting.mandatory;
    const floor = forced
        ? Math.min(state.betting.committed, me().chips)
        : Math.min(state.betMin, me().chips);

    const head = pickedCup === null
        ? "Ткни в стакан на столе, потом двигай ставку."
        : "Ставка на стакан <b>№" + (pickedCup + 1) + "</b>. Угадаешь стакан пожирнее — вернёшь своё и утащишь столько же.";

    body.innerHTML =
        brief(head, true)
        + stakeControl(floor, me().chips, "stake")
        + '<div class="dock-actions">'
        + (forced ? "" : '<button class="ghost" id="skipButton">Пропустить</button>')
        + '<button id="stakeButton"' + (pickedCup === null ? " disabled" : "") + ">Поставить</button>"
        + "</div>";

    wireStake("stake");

    $("stakeButton").onclick = () => {
        send({ t: "bet", cup: pickedCup, amount: Number($("stake").value) });
        pickedCup = null;
    };

    if (!forced) $("skipButton").onclick = () => send({ t: "bet", skip: true });
}

function dockRoundEnd(body) {
    slotsRound = -1;

    const tape = (state.results || []).map(r =>
        '<div class="tape-item">' + esc(r.name) + ' <b class="'
        + (r.delta > 0 ? "up" : r.delta < 0 ? "down" : "") + '">'
        + (r.delta > 0 ? "+" : "") + r.delta + "</b></div>"
    ).join("");

    const allowed = amHost() || amDealer();

    body.innerHTML =
        '<div class="tape">' + tape + "</div>"
        + '<div class="dock-actions">'
        + '<button id="nextButton"' + (allowed ? "" : " disabled") + ">Раздать снова</button>"
        + "</div>";

    if (allowed) $("nextButton").onclick = () => send({ t: "next" });
}

function dockOver(body) {
    slotsRound = -1;

    const rows = (state.standings || []).map(s =>
        '<div class="standing' + (s.place === 1 ? " winner" : "") + (s.bankrupt ? " bust" : "") + '">'
        + '<div class="place">' + s.place + "</div>"
        + '<div class="grow">' + esc(s.name) + (s.bankrupt ? " · без фишек" : "") + "</div>"
        + '<div class="sum">' + s.chips + "</div>"
        + "</div>"
    ).join("");

    body.innerHTML =
        '<div class="standings">' + rows + "</div>"
        + '<div class="dock-actions">'
        + '<button id="restartButton"' + (amHost() ? "" : " disabled") + ">Пересобрать стол</button>"
        + "</div>";

    if (amHost()) $("restartButton").onclick = () => send({ t: "restart" });
}


/* =========================================================
   АНИМАЦИИ
========================================================= */

function playFx(list) {
    if (!list || !list.length) return;

    list.forEach((item, i) => {
        if (item.kind === "react") return showBurst(item);
        if (item.kind === "chips") return setTimeout(() => flyChips(item), 420 + i * 260);
    });
}

function showBurst(item) {
    const seat = $("seat-" + item.playerId);
    if (!seat) return;

    const bubble = document.createElement("div");
    bubble.className = "burst";
    bubble.textContent = item.emoji;
    seat.appendChild(bubble);

    setTimeout(() => bubble.remove(), 2500);
}

function flyChips(item) {
    const arena = $("arena");
    const target = $("seat-" + item.to);

    if (!target) return;

    const source = item.cup ? $("cup-" + item.cup) : $("seat-" + item.from);
    if (!source) return;

    const base = arena.getBoundingClientRect();
    const from = source.getBoundingClientRect();
    const to = target.getBoundingClientRect();

    const flier = document.createElement("div");
    flier.className = "flier";

    const disc = document.createElement("div");
    disc.className = "disc";
    flier.appendChild(disc);

    const label = document.createElement("span");
    label.textContent = "+" + item.amount;
    flier.appendChild(label);

    flier.style.left = (from.left - base.left + from.width / 2 - 22) + "px";
    flier.style.top = (from.top - base.top + from.height / 2 - 10) + "px";

    arena.appendChild(flier);

    const dx = (to.left - from.left) + (to.width - from.width) / 2;
    const dy = (to.top - from.top) + (to.height - from.height) / 2;

    requestAnimationFrame(() => {
        flier.style.transform = "translate(" + dx + "px," + dy + "px) scale(0.6)";
        flier.style.opacity = "0.1";
    });

    setTimeout(() => {
        flier.remove();
        target.classList.add("flash");
        setTimeout(() => target.classList.remove("flash"), 950);
    }, 820);
}

/* фишки съезжаются к победителю */
function crownWinner() {
    if (!state.standings || !state.standings.length || calm) return;

    const champion = state.players.find(p => p.name === state.standings[0].name);
    if (!champion) return;

    const seat = $("seat-" + champion.id);
    if (!seat) return;

    seat.classList.add("champion");

    state.players.forEach((p, i) => {
        if (p.id === champion.id) return;

        setTimeout(() => flyChips({
            kind: "chips",
            from: p.id,
            to: champion.id,
            amount: state.standings.find(s => s.name === p.name).chips
        }), i * 220);
    });
}


/* =========================================================
   ЗАПУСК
========================================================= */

function buildReactionTray() {
    const tray = $("reactionTray");

    EMOJI.forEach(emoji => {
        const button = document.createElement("button");
        button.textContent = emoji;
        button.setAttribute("aria-label", "реакция " + emoji);

        button.onclick = () => {
            send({ t: "react", emoji });
            show("reactionTray", false);
        };

        tray.appendChild(button);
    });
}

$("nameInput").value = myName;

const fromUrl = new URLSearchParams(location.search).get("table");
if (fromUrl) $("codeInput").value = fromUrl.toUpperCase();

$("createButton").onclick = createTable;
$("joinButton").onclick = () => joinTable(false);
$("watchButton").onclick = () => joinTable(true);
$("leaveButton").onclick = leaveTable;
$("copyButton").onclick = copyLink;
$("startButton").onclick = () => send({ t: "start", startingChips: Number($("startingChips").value) });

$("reactButton").onclick = () => $("reactionTray").classList.toggle("hidden");

$("codeInput").addEventListener("keydown", e => { if (e.key === "Enter") joinTable(false); });
$("nameInput").addEventListener("keydown", e => { if (e.key === "Enter") createTable(); });

document.addEventListener("click", e => {
    if (!e.target.closest("#reactionTray") && e.target !== $("reactButton")) {
        show("reactionTray", false);
    }
});

window.addEventListener("resize", () => {
    if (state && state.phase !== "lobby") renderSeats();
});

buildReactionTray();
connect();
