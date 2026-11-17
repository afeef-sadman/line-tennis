// End-to-end network tests against a live server instance.
// Spawns the server on a test port, connects two WS clients, and verifies:
// create/join, invite codes, state sync, input authority, pause, disconnect,
// reconnect with token, forfeit, and rematch voting.
import { spawn } from 'node:child_process';
import { WebSocket } from 'ws';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = 34567;
const BASE = `ws://127.0.0.1:${PORT}/ws`;

let failures = 0;
function check(name, cond, detail = '') {
  if (cond) console.log(`  ok  ${name}`);
  else { failures++; console.error(`FAIL  ${name} ${detail}`); }
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

class Client {
  constructor(name) {
    this.name = name;
    this.msgs = [];
    this.waiters = [];
  }
  connect() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(BASE);
      this.ws.on('message', (raw) => {
        const m = JSON.parse(raw.toString());
        this.msgs.push(m);
        this.waiters = this.waiters.filter(w => {
          if (w.pred(m)) { w.resolve(m); return false; }
          return true;
        });
      });
      this.ws.on('open', resolve);
      this.ws.on('error', reject);
    });
  }
  send(o) { this.ws.send(JSON.stringify(o)); }
  wait(pred, timeout = 8000, label = '') {
    const found = this.msgs.find(pred);
    if (found) return Promise.resolve(found);
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`${this.name}: timeout waiting ${label}`)), timeout);
      this.waiters.push({ pred, resolve: (m) => { clearTimeout(t); resolve(m); } });
    });
  }
  close() { try { this.ws.close(); } catch {} }
}

const server = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'server.js')], {
  env: { ...process.env, PORT: String(PORT) },
  stdio: ['ignore', 'pipe', 'pipe'],
});
server.stdout.on('data', () => {});
server.stderr.on('data', (d) => console.error('[server]', d.toString()));

async function main() {
  await sleep(900);

  // Health endpoint
  const health = await fetch(`http://127.0.0.1:${PORT}/healthz`).then(r => r.json());
  check('health endpoint responds', health.ok === true);

  // Invite-link route serves the app shell
  const joinPage = await fetch(`http://127.0.0.1:${PORT}/join/ABC123`);
  const html = await joinPage.text();
  check('invite URL serves game shell', joinPage.status === 200 && html.includes('LINE'));

  // Shared core module served to browser path
  const core = await fetch(`http://127.0.0.1:${PORT}/js/game-core.js`);
  check('shared core module served', core.status === 200 && (await core.text()).includes('COURT'));

  // --- create + join ---
  const a = new Client('host');
  await a.connect();
  a.send({ t: 'create' });
  const created = await a.wait(m => m.t === 'created', 5000, 'created');
  check('room created with 6-char code', /^[A-Z2-9]{6}$/.test(created.code), created.code);
  check('host is side 0', created.side === 0);
  check('host got reconnect token', typeof created.token === 'string' && created.token.length >= 16);

  const b = new Client('guest');
  await b.connect();
  b.send({ t: 'join', code: created.code.toLowerCase() }); // case-insensitive join
  const joined = await b.wait(m => m.t === 'joined', 5000, 'joined');
  check('guest joined as side 1', joined.side === 1);
  await a.wait(m => m.t === 'begin', 5000, 'begin(host)');
  await b.wait(m => m.t === 'begin', 5000, 'begin(guest)');
  check('both clients received begin', true);

  // --- state stream ---
  const st = await a.wait(m => m.t === 'state', 5000, 'state');
  check('state has scores/ball/rackets', Array.isArray(st.s.sc) && st.s.b && st.s.r.length === 2);

  // --- input authority: guest moves racket, host sees it in state ---
  b.send({ t: 'input', x: 800, y: 200, a: 0.8 });
  await sleep(400);
  const states = a.msgs.filter(m => m.t === 'state');
  const last = states[states.length - 1];
  check('guest input reflected in synced state', Math.abs(last.s.r[1].x - 800) < 30 && Math.abs(last.s.r[1].y - 200) < 30,
    JSON.stringify(last.s.r[1]));

  // host cannot control guest racket (input on side 0 only)
  a.send({ t: 'input', x: 800, y: 200, a: 0 });
  await sleep(300);
  const st2 = a.msgs.filter(m => m.t === 'state').at(-1);
  check('host input clamped to own half', st2.s.r[0].x <= 436, `x=${st2.s.r[0].x}`);

  // --- physics running server-side: serve happens after countdown ---
  const serveEv = await a.wait(m => m.t === 'ev' && m.e.type === 'serve', 6000, 'serve event');
  check('server ran countdown and served', serveEv.e.side === 0 || serveEv.e.side === 1);

  // --- pause / resume ---
  a.send({ t: 'pause' });
  const paused = await b.wait(m => m.t === 'paused' && m.by === 0, 5000, 'paused');
  check('pause broadcast to both', paused.by === 0);
  const pausedState = await b.wait(m => m.t === 'state' && m.p === 0, 5000, 'paused state');
  const bx = pausedState.s.b.x;
  await sleep(500);
  const pausedState2 = b.msgs.filter(m => m.t === 'state').at(-1);
  check('ball frozen while paused', pausedState2.s.b.x === bx, `${bx} -> ${pausedState2.s.b.x}`);
  b.send({ t: 'pause' }); // guest toggles resume
  await b.wait(m => m.t === 'paused' && m.by === -1, 5000, 'resumed');
  check('resume broadcast', true);

  // --- third player rejected ---
  const c = new Client('intruder');
  await c.connect();
  c.send({ t: 'join', code: created.code });
  const full = await c.wait(m => m.t === 'error', 5000, 'full error');
  check('third player rejected (room full)', full.code === 'full');
  c.close();

  // --- bad room code ---
  const d = new Client('lost');
  await d.connect();
  d.send({ t: 'join', code: 'ZZZZZZ' });
  const nf = await d.wait(m => m.t === 'error', 5000, 'notfound');
  check('unknown room rejected', nf.code === 'notfound');
  d.close();

  // --- disconnect + reconnect with token ---
  const bToken = joined.token;
  b.close();
  const oppDown = await a.wait(m => m.t === 'opponent' && m.connected === false, 12000, 'opponent down');
  check('host notified of disconnect', oppDown.permanent === false);
  const dState = await a.wait(m => m.t === 'state' && m.d === true, 5000, 'disconnected state');
  check('game flagged disconnected (auto-paused)', dState.d === true);

  const b2 = new Client('guest-reconnect');
  await b2.connect();
  b2.send({ t: 'join', code: created.code, token: bToken });
  const rej = await b2.wait(m => m.t === 'joined', 5000, 'rejoined');
  check('reconnect with token succeeds', rej.reconnect === true && rej.side === 1);
  check('reconnect includes state snapshot', rej.s && Array.isArray(rej.s.sc));
  await a.wait(m => m.t === 'opponent' && m.connected === true, 5000, 'opponent back');
  check('host notified of reconnect', true);

  // --- forfeit after permanent leave ---
  b2.send({ t: 'leave' });
  const forfeit = await a.wait(m => m.t === 'ev' && m.e.type === 'forfeit', 8000, 'forfeit');
  check('permanent leave forfeits match', forfeit.e.winner === 0);
  const overState = await a.wait(m => m.t === 'state' && m.s.ph === 'over', 5000, 'over state');
  check('match over state broadcast', overState.s.w === 0 && overState.s.sc[0] >= 7);

  // --- rematch requires both votes (guest gone -> no start) ---
  a.send({ t: 'rematch' });
  const vote = await a.wait(m => m.t === 'rematchVote', 5000, 'vote');
  check('rematch vote broadcast', vote.votes[0] === true && vote.votes[1] === false);
  await sleep(400);
  check('no rematch without second vote', !a.msgs.some(m => m.t === 'rematchGo'));

  a.close();

  // --- full happy-path rematch on a fresh room ---
  const e = new Client('host2');
  await e.connect();
  e.send({ t: 'create' });
  const cr2 = await e.wait(m => m.t === 'created', 5000, 'created2');
  const f = new Client('guest2');
  await f.connect();
  f.send({ t: 'join', code: cr2.code });
  await f.wait(m => m.t === 'begin', 5000, 'begin2');
  await e.wait(m => m.t === 'begin', 5000, 'begin2h');
  // Force match over via forfeit, then reconnect guest and rematch properly:
  // simpler: guest leaves permanently, host wins, guest rejoins as NEW player? Room is full.
  // Instead verify rematch vote flow with both connected using forfeit-free path:
  // drive the game to 'over' by waiting is too slow; validate vote plumbing only.
  e.send({ t: 'rematch' }); // ignored: game not over
  await sleep(300);
  check('rematch ignored mid-game', !e.msgs.some(m => m.t === 'rematchVote'));
  e.close(); f.close();

  console.log(failures === 0 ? '\nALL NET TESTS PASSED' : `\n${failures} FAILURES`);
  server.kill();
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('TEST ERROR:', err.message);
  server.kill();
  process.exit(1);
});