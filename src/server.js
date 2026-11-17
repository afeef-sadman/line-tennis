// Line Tennis — authoritative multiplayer server.
// Serves the static frontend and runs room-based WebSocket matches.
// The server owns the physics; clients send racket targets and render snapshots.

import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import { WebSocketServer } from 'ws';
import { createGame, setRacketTarget, step, snapshot, resetForRematch, COURT } from './game-core.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const PORT = Number(process.env.PORT) || 3000;
const TICK_HZ = 60;
const SNAPSHOT_HZ = 30;
const ROOM_TTL_MS = 10 * 60 * 1000;      // empty rooms expire
const DISCONNECT_GRACE_MS = 20 * 1000;   // wait for a reconnect before forfeiting
const MAX_MSG_BYTES = 2048;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/healthz') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, rooms: rooms.size }));
      return;
    }
    let rel = decodeURIComponent(url.pathname);
    if (rel === '/' || rel.startsWith('/join/')) rel = '/index.html';
    // Shared simulation module: one source of truth for server and browser.
    const filePath = rel === '/js/game-core.js'
      ? path.join(__dirname, 'game-core.js')
      : path.normalize(path.join(PUBLIC_DIR, rel));
    if (!filePath.startsWith(PUBLIC_DIR) && !filePath.startsWith(__dirname)) { res.writeHead(403); res.end('Forbidden'); return; }
    const data = await readFile(filePath);
    res.writeHead(200, {
      'content-type': MIME[path.extname(filePath)] || 'application/octet-stream',
      'cache-control': 'no-cache',
    });
    res.end(data);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('Not found');
  }
});

// ---------------------------------------------------------------------------
// Rooms
// ---------------------------------------------------------------------------
const rooms = new Map(); // code -> room

function newRoomCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do {
    code = Array.from(crypto.randomBytes(6), b => alphabet[b % alphabet.length]).join('');
  } while (rooms.has(code));
  return code;
}

function createRoom() {
  const room = {
    code: newRoomCode(),
    players: [null, null],   // { ws, token, connected, name, disconnectAt }
    game: null,
    loop: null,
    tickAcc: 0,
    snapAcc: 0,
    rematchVotes: [false, false],
    pause: { by: -1, until: 0 },
    createdAt: Date.now(),
    emptySince: Date.now(),
  };
  rooms.set(room.code, room);
  return room;
}

function send(ws, obj) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
}

function broadcast(room, obj, exceptSide = -1) {
  room.players.forEach((p, i) => { if (p && i !== exceptSide) send(p.ws, obj); });
}

function bothConnected(room) {
  return room.players.every(p => p && p.connected);
}

function startLoop(room) {
  if (room.loop) return;
  if (!room.game) room.game = createGame();
  let last = performance.now();
  let snapCounter = 0;
  const interval = 1000 / TICK_HZ;
  room.loop = setInterval(() => {
    const now = performance.now();
    let dt = (now - last) / 1000;
    last = now;
    dt = Math.min(dt, 0.1);

    const paused = room.pause.by !== -1 || !bothConnected(room);
    if (!paused) {
      step(room.game, dt);
      const events = room.game.events.splice(0);
      for (const ev of events) broadcast(room, { t: 'ev', e: ev });
    }

    snapCounter++;
    if (snapCounter >= TICK_HZ / SNAPSHOT_HZ) {
      snapCounter = 0;
      broadcast(room, {
        t: 'state',
        s: snapshot(room.game),
        p: room.pause.by,
        d: !bothConnected(room),
      });
    }
  }, interval);
}

function stopLoop(room) {
  if (room.loop) { clearInterval(room.loop); room.loop = null; }
}

function destroyRoom(room) {
  stopLoop(room);
  rooms.delete(room.code);
}

function opponentLeft(room, side, permanent) {
  const other = room.players[1 - side];
  if (!other) return;
  send(other.ws, { t: 'opponent', connected: false, permanent });
  if (permanent && room.game && room.game.phase !== 'over') {
    // Forfeit: remaining player wins the match.
    room.game.phase = 'over';
    room.game.winner = 1 - side;
    room.game.scores[1 - side] = Math.max(room.game.scores[1 - side], COURT.WIN_SCORE);
    broadcast(room, { t: 'ev', e: { type: 'forfeit', winner: 1 - side } });
    broadcast(room, { t: 'state', s: snapshot(room.game), p: -1, d: false });
  }
}

// Sweeper: expire empty rooms and forfeit long-disconnected players.
setInterval(() => {
  const now = Date.now();
  for (const room of rooms.values()) {
    const anyConnected = room.players.some(p => p && p.connected);
    if (!anyConnected) {
      if (now - room.emptySince > ROOM_TTL_MS) destroyRoom(room);
      continue;
    }
    room.players.forEach((p, i) => {
      if (p && !p.connected && p.disconnectAt && now - p.disconnectAt > DISCONNECT_GRACE_MS) {
        p.forfeited = true;
        opponentLeft(room, i, true);
        // Keep the slot so a fresh visitor cannot hijack a finished match;
        // the room dies once the remaining player leaves.
        p.disconnectAt = now; // reset timer; TTL handles the rest
      }
    });
  }
}, 5000).unref();

// ---------------------------------------------------------------------------
// WebSocket protocol
// ---------------------------------------------------------------------------
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: MAX_MSG_BYTES });

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  let room = null;
  let side = -1;

  const leave = (permanent) => {
    if (!room || side === -1) return;
    const p = room.players[side];
    if (p && p.ws === ws) {
      p.connected = false;
      p.ws = null;
      p.disconnectAt = Date.now();
      room.emptySince = Date.now();
      room.pause.by = -1; // clear pause so the grace state shows instead
      opponentLeft(room, side, permanent);
    }
    room = null; side = -1;
  };

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (!msg || typeof msg.t !== 'string') return;

    switch (msg.t) {
      case 'create': {
        if (room) return;
        room = createRoom();
        side = 0;
        const token = crypto.randomBytes(16).toString('hex');
        room.players[0] = { ws, token, connected: true, disconnectAt: 0 };
        send(ws, { t: 'created', code: room.code, side, token });
        break;
      }
      case 'join': {
        if (room) return;
        const code = String(msg.code || '').toUpperCase().trim();
        const target = rooms.get(code);
        if (!target) { send(ws, { t: 'error', code: 'notfound', msg: 'Room not found. It may have expired.' }); return; }

        // Reconnect with token?
        const slot = target.players.findIndex(p => p && msg.token && p.token === msg.token && !p.connected);
        if (slot !== -1 && !target.players[slot].forfeited) {
          room = target; side = slot;
          room.players[side].ws = ws;
          room.players[side].connected = true;
          room.players[side].disconnectAt = 0;
          send(ws, { t: 'joined', code, side, token: msg.token, reconnect: true, s: room.game ? snapshot(room.game) : null });
          broadcast(room, { t: 'opponent', connected: true }, side);
          if (bothConnected(room)) startLoop(room);
          return;
        }
        if (target.players[1]) { send(ws, { t: 'error', code: 'full', msg: 'This room already has two players.' }); return; }
        room = target; side = 1;
        const token = crypto.randomBytes(16).toString('hex');
        room.players[1] = { ws, token, connected: true, disconnectAt: 0 };
        room.game = createGame();
        room.rematchVotes = [false, false];
        send(ws, { t: 'joined', code, side, token });
        broadcast(room, { t: 'start', side: 1 }, -1);
        room.players.forEach((p, i) => send(p.ws, { t: 'begin', side: i, code }));
        startLoop(room);
        break;
      }
      case 'input': {
        if (!room || !room.game || side === -1) return;
        const x = Number(msg.x), y = Number(msg.y), a = Number(msg.a);
        if (!Number.isFinite(x) || !Number.isFinite(y)) return;
        setRacketTarget(room.game, side, x, y, Number.isFinite(a) ? a : undefined);
        break;
      }
      case 'pause': {
        if (!room || !room.game || side === -1) return;
        if (room.game.phase === 'over') return;
        room.pause.by = room.pause.by === -1 ? side : -1;
        broadcast(room, { t: 'paused', by: room.pause.by });
        break;
      }
      case 'rematch': {
        if (!room || !room.game || side === -1) return;
        if (room.game.phase !== 'over') return;
        room.rematchVotes[side] = true;
        broadcast(room, { t: 'rematchVote', votes: [...room.rematchVotes] }, -1);
        if (room.rematchVotes.every(Boolean) && bothConnected(room)) {
          resetForRematch(room.game);
          room.rematchVotes = [false, false];
          room.pause.by = -1;
          broadcast(room, { t: 'rematchGo' });
        }
        break;
      }
      case 'leave': {
        leave(true);
        send(ws, { t: 'left' });
        break;
      }
      case 'debug': {
        // Test hook: force match end so QA can exercise rematch flows.
        if (process.env.LT_DEBUG !== '1') return;
        let target = room;
        if (!target && msg.code) target = rooms.get(String(msg.code).toUpperCase());
        if (!target || !target.game) return;
        const w = msg.winner === 1 ? 1 : 0;
        target.game.phase = 'over';
        target.game.winner = w;
        target.game.scores[w] = COURT.WIN_SCORE;
        broadcast(target, { t: 'ev', e: { type: 'matchover', winner: w, scores: [...target.game.scores] } });
        broadcast(target, { t: 'state', s: snapshot(target.game), p: -1, d: false });
        break;
      }
      case 'ping': {
        send(ws, { t: 'pong', ts: msg.ts });
        break;
      }
    }
  });

  ws.on('close', () => leave(false));
  ws.on('error', () => leave(false));
});

// Heartbeat: drop dead sockets so disconnect handling fires promptly.
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    ws.ping();
  }
}, 8000).unref();

server.listen(PORT, () => {
  console.log(`Line Tennis server listening on http://0.0.0.0:${PORT}`);
});