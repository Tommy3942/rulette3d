const http = require("http");
const WebSocket = require("ws");

const PORT = process.env.PORT || 8080;

// ====== 룰렛 데이터 ======
const WHEEL_ORDER = [
  0, 32, 15, 19, 4, 21, 2, 25, 17, 34,
  6, 27, 13, 36, 11, 30, 8, 23, 10, 5,
  24, 16, 33, 1, 20, 14, 31, 9, 22, 18,
  29, 7, 28, 12, 35, 3, 26
];

const RED_SET = new Set([1,3,5,7,9,12,14,16,18,19,21,23,25,27,30,32,34,36]);
function colorOf(n) {
  if (n === 0) return "GREEN";
  return RED_SET.has(n) ? "RED" : "BLACK";
}
function isEven(n) { return n !== 0 && n % 2 === 0; }
function isOdd(n) { return n % 2 === 1; }

const START_BALANCE = 1000;

// ====== HTTP 서버(헬스체크/루트) ======
const server = http.createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
  res.end("Roulette WS server is running. Connect via WebSocket.");
});

// ====== WebSocket 서버(HTTP 업그레이드 기반) ======
const wss = new WebSocket.Server({ server });

// ====== 룸/라운드 상태 ======
let clients = new Map(); // ws -> {id,balance}
let room = {
  phase: "BETTING",
  endsAt: Date.now() + 15000,
  resultNumber: null,
  resultWheelIndex: null,
  bets: new Map(), // clientId -> [{type,value,amount}]
};

function send(ws, msg) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}
function broadcast(msg) {
  const data = JSON.stringify(msg);
  for (const ws of clients.keys()) {
    if (ws.readyState === WebSocket.OPEN) ws.send(data);
  }
}

function startRound() {
  room.phase = "BETTING";
  room.endsAt = Date.now() + 15000;
  room.resultNumber = null;
  room.resultWheelIndex = null;
  room.bets = new Map();

  broadcast({ type: "PHASE", phase: room.phase, endsAt: room.endsAt });
  setTimeout(lockBets, 15000);
}

function lockBets() {
  room.phase = "LOCKED";
  broadcast({ type: "PHASE", phase: room.phase, endsAt: Date.now() + 2000 });
  setTimeout(spin, 2000);
}

function spin() {
  room.phase = "SPIN";

  const idx = Math.floor(Math.random() * WHEEL_ORDER.length);
  room.resultWheelIndex = idx;
  room.resultNumber = WHEEL_ORDER[idx];

  broadcast({
    type: "SPIN",
    resultNumber: room.resultNumber,
    resultWheelIndex: room.resultWheelIndex,
    wheelOrder: WHEEL_ORDER
  });

  setTimeout(payout, 7000);
}

// 배당(원금 포함 지급)
// EVEN MONEY: 2x, DOZEN/COLUMN: 3x, NUMBER: 36x
function payout() {
  room.phase = "PAYOUT";

  const n = room.resultNumber;
  const c = colorOf(n);

  for (const [ws, info] of clients.entries()) {
    const bets = room.bets.get(info.id) || [];
    let win = 0;

    for (const b of bets) {
      // 0이면 outside 베팅은 모두 패
      if (n === 0) {
        if (b.type === "NUMBER" && b.value === 0) win += b.amount * 36;
        continue;
      }

      if (b.type === "NUMBER") {
        if (n === b.value) win += b.amount * 36;
      } else if (b.type === "COLOR") {
        if (c === b.value) win += b.amount * 2;
      } else if (b.type === "PARITY") {
        if (b.value === "ODD" && isOdd(n)) win += b.amount * 2;
        if (b.value === "EVEN" && isEven(n)) win += b.amount * 2;
      } else if (b.type === "RANGE") {
        if (b.value === "LOW" && n >= 1 && n <= 18) win += b.amount * 2;
        if (b.value === "HIGH" && n >= 19 && n <= 36) win += b.amount * 2;
      } else if (b.type === "DOZEN") {
        if (b.value === "D1" && n >= 1 && n <= 12) win += b.amount * 3;
        if (b.value === "D2" && n >= 13 && n <= 24) win += b.amount * 3;
        if (b.value === "D3" && n >= 25 && n <= 36) win += b.amount * 3;
      } else if (b.type === "COLUMN") {
        const col = ((n - 1) % 3) + 1;
        if (b.value === "C1" && col === 1) win += b.amount * 3;
        if (b.value === "C2" && col === 2) win += b.amount * 3;
        if (b.value === "C3" && col === 3) win += b.amount * 3;
      }
    }

    info.balance += win;
    send(ws, { type: "BALANCE", balance: info.balance });
  }

  broadcast({ type: "RESULT", resultNumber: n, color: c });
  setTimeout(startRound, 3000);
}

// ====== 연결 처리 ======
wss.on("connection", (ws) => {
  const id = Math.random().toString(16).slice(2, 10);
  clients.set(ws, { id, balance: START_BALANCE });

  send(ws, {
    type: "WELCOME",
    id,
    balance: clients.get(ws).balance,
    phase: room.phase,
    endsAt: room.endsAt
  });

  ws.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    const info = clients.get(ws);
    if (!info) return;

    if (msg.type !== "BET") return;
    if (room.phase !== "BETTING") return;

    const amount = Math.floor(msg.amount || 0);
    if (amount <= 0) return;
    if (info.balance < amount) return;

    function acceptBet(type, value) {
      info.balance -= amount;
      const arr = room.bets.get(info.id) || [];
      arr.push({ type, value, amount });
      room.bets.set(info.id, arr);
      send(ws, { type: "BALANCE", balance: info.balance });
    }

    if (msg.betType === "NUMBER") {
      const v = Number(msg.value);
      if (!Number.isInteger(v) || v < 0 || v > 36) return;
      return acceptBet("NUMBER", v);
    }
    if (msg.betType === "COLOR") {
      if (msg.value !== "RED" && msg.value !== "BLACK") return;
      return acceptBet("COLOR", msg.value);
    }
    if (msg.betType === "PARITY") {
      if (msg.value !== "ODD" && msg.value !== "EVEN") return;
      return acceptBet("PARITY", msg.value);
    }
    if (msg.betType === "RANGE") {
      if (msg.value !== "LOW" && msg.value !== "HIGH") return;
      return acceptBet("RANGE", msg.value);
    }
    if (msg.betType === "DOZEN") {
      if (!["D1","D2","D3"].includes(msg.value)) return;
      return acceptBet("DOZEN", msg.value);
    }
    if (msg.betType === "COLUMN") {
      if (!["C1","C2","C3"].includes(msg.value)) return;
      return acceptBet("COLUMN", msg.value);
    }
  });

  ws.on("close", () => clients.delete(ws));
});

server.listen(PORT, () => {
  console.log(`HTTP/WS listening on port ${PORT}`);
  startRound();
});
