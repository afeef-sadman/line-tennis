// Main controller: screens, game modes (bot / online), loop, HUD, overlays.
import { COURT, createGame, setRacketTarget, step, snapshot, applySnapshot, resetForRematch } from './game-core.js';
import { Renderer } from './renderer.js';
import { Bot } from './bot.js';
import { Input } from './input.js';
import { NetClient } from './net.js';
import { sfx, unlockAudio, setSoundEnabled, soundEnabled } from './audio.js';

const $ = (id) => document.getElementById(id);
const screens = ['menu', 'lobby', 'bot', 'game', 'lost'];

const app = {
  mode: null,            // 'bot' | 'online'
  game: createGame(),
  mySide: 0,
  bot: null,
  net: null,
  paused: false,         // local (bot) pause
  netPausedBy: -1,       // online pause owner side
  opponentDown: false,
  running: false,
  lastCount: -1,
  names: ['YOU', 'BOT'],
  difficulty: 'medium',
  inputThrottle: 0,
  pendingTarget: null,
  rematchVoted: false,
  ended: false,
};

const canvas = $('court');
const renderer = new Renderer(canvas);
const input = new Input(canvas, renderer, (x, y, a) => {
  if (app.mode === 'bot') {
    setRacketTarget(app.game, app.mySide, x, y, a);
  } else if (app.mode === 'online') {
    app.pendingTarget = { x, y, a };
  }
});

function showScreen(name) {
  for (const s of screens) $(`screen-${s}`).classList.toggle('active', s === name);
  if (name === 'game') requestAnimationFrame(() => renderer.resize());
}

function toast(text, ms = 1800) {
  const t = $('toast');
  t.textContent = text;
  t.classList.remove('hidden');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.add('hidden'), ms);
}

// ---------------------------------------------------------------------------
// HUD / overlays
// ---------------------------------------------------------------------------
function updateHUD() {
  const g = app.game;
  const left = g.scores[app.mySide], right = g.scores[1 - app.mySide];
  const sl = $('score-left'), sr = $('score-right');
  if (sl.textContent !== String(left)) { sl.textContent = left; popScore(sl); }
  if (sr.textContent !== String(right)) { sr.textContent = right; popScore(sr); }
  $('name-left').textContent = app.names[app.mySide];
  $('name-right').textContent = app.names[1 - app.mySide];
  // Score colors always follow identity: YOU teal, opponent orange,
  // regardless of which side of the screen they sit on.
  sl.style.color = 'var(--accent)';
  sr.style.color = 'var(--accent2)';
  $('hud-rally').textContent = g.phase === 'rally' && g.rallyHits > 2 ? `Rally ${g.rallyHits}` : '';
}
function popScore(el) { el.classList.remove('pop'); void el.offsetWidth; el.classList.add('pop'); }

function setOverlay(id, visible) { $(id).classList.toggle('hidden', !visible); }

function showEnd(winner) {
  app.ended = true;
  updateHUD(); // ensure the final point is on the scoreboard behind the overlay
  const win = winner === app.mySide;
  const title = $('end-title');
  title.textContent = win ? '🏆 Victory!' : 'Defeat';
  title.className = win ? 'win' : 'lose';
  const g = app.game;
  $('end-score').textContent = `${g.scores[app.mySide]} – ${g.scores[1 - app.mySide]}`;
  $('end-sub').textContent = app.mode === 'bot'
    ? `Bot difficulty: ${app.difficulty}`
    : (g.scores[1 - app.mySide] >= COURT.WIN_SCORE && app.opponentDown ? 'Opponent forfeited' : 'Good match!');
  $('btn-rematch').disabled = false;
  $('rematch-status').textContent = '';
  app.rematchVoted = false;
  setOverlay('overlay-end', true);
  if (win) sfx.victory(); else sfx.defeat();
}

function hideAllOverlays() {
  ['overlay-pause', 'overlay-disconnect', 'overlay-end'].forEach(id => setOverlay(id, false));
}

// ---------------------------------------------------------------------------
// Game events -> sound + visuals
// ---------------------------------------------------------------------------
function handleEvent(ev) {
  renderer.handleEvent(ev, app.mySide);
  switch (ev.type) {
    case 'hit': sfx.hit(ev.speed); break;
    case 'bounce': sfx.bounce(); break;
    case 'net': sfx.net(); break;
    case 'wall': sfx.wall(); break;
    case 'serve': sfx.go(); break;
    case 'point': sfx.point(ev.winner === app.mySide); break;
    case 'matchover': showEnd(ev.winner); break;
    case 'forfeit':
      toast('Opponent forfeited the match');
      showEnd(ev.winner);
      break;
  }
}

// ---------------------------------------------------------------------------
// Bot mode
// ---------------------------------------------------------------------------
function startBotMode(difficulty) {
  app.mode = 'bot';
  app.difficulty = difficulty;
  app.mySide = 0;
  app.names = ['YOU', `BOT · ${difficulty.toUpperCase()}`];
  app.game = createGame();
  app.bot = new Bot(difficulty, 1);
  app.paused = false;
  app.ended = false;
  renderer.mirror = false;
  input.setSide(0);
  input.enabled = true;
  hideAllOverlays();
  $('hud-mode').textContent = 'FIRST TO 7 · VS BOT';
  $('btn-pause').style.display = '';
  showScreen('game');
  app.running = true;
}

// ---------------------------------------------------------------------------
// Online mode
// ---------------------------------------------------------------------------
function inviteUrl(code) {
  return `${location.origin}/join/${code}`;
}

function ensureNet() {
  if (app.net) return app.net;
  app.net = new NetClient({
    onCreated(m) {
      try { sessionStorage.setItem('lt-session', JSON.stringify({ code: m.code, token: m.token })); } catch {}
      $('lobby-choice').classList.add('hidden');
      $('lobby-waiting').classList.remove('hidden');
      $('invite-link').value = inviteUrl(m.code);
      $('room-code-display').textContent = m.code;
      $('lobby-error').textContent = '';
    },
    onJoined(m) {
      app.mySide = m.side;
      if (m.reconnect) {
        // Reclaiming our slot after a reload: persist the session token.
        try { sessionStorage.setItem('lt-session', JSON.stringify({ code: m.code, token: m.token })); } catch {}
        if (m.s) {
          applySnapshot(app.game, m.s);
          enterOnlineGame();
          toast('Reconnected');
        }
      }
      // Fresh joins wait for 'begin'.
    },
    onBegin(m) {
      // Fresh match on this page: persist OUR credentials for reload-reconnect
      // (overwrites any session left over from a previous room in this tab).
      try {
        sessionStorage.setItem('lt-session', JSON.stringify({ code: m.code, token: app.net.token }));
      } catch {}
      enterOnlineGame();
    },
    onState(m) {
      if (app.mode !== 'online') return;
      applySnapshot(app.game, m.s);
      app.netPausedBy = m.p;
      const down = m.d;
      if (down !== app.opponentDown) {
        app.opponentDown = down;
        setOverlay('overlay-disconnect', down && !app.ended);
      }
      // Match end arrives via state too (e.g. after reconnect).
      if (app.game.phase === 'over' && !app.ended && app.game.winner !== -1) showEnd(app.game.winner);
      updatePauseOverlay();
    },
    onEvent(ev) { if (app.mode === 'online') handleEvent(ev); },
    onPaused(by) { app.netPausedBy = by; updatePauseOverlay(); },
    onOpponent(m) {
      if (!m.connected) {
        if (m.permanent) {
          app.opponentDown = true;
          setOverlay('overlay-disconnect', false);
          // forfeit event/state follows from server
        } else {
          app.opponentDown = true;
          if (!app.ended) setOverlay('overlay-disconnect', true);
          startDcCountdown();
        }
      } else {
        app.opponentDown = false;
        setOverlay('overlay-disconnect', false);
        toast('Opponent reconnected');
      }
    },
    onRematchVote(votes) {
      const other = votes[1 - app.mySide];
      $('rematch-status').textContent = app.rematchVoted
        ? (other ? 'Starting rematch…' : 'Waiting for opponent to accept…')
        : (other ? 'Opponent wants a rematch!' : '');
    },
    onRematchGo() {
      app.ended = false;
      app.rematchVoted = false;
      resetForRematch(app.game);
      hideAllOverlays();
      toast('Rematch!');
    },
    onError(m) {
      $('lobby-error').textContent = m.msg || 'Something went wrong.';
      $('lobby-choice').classList.remove('hidden');
      $('lobby-waiting').classList.add('hidden');
      if (app.mode === 'online') { toast(m.msg || 'Connection error'); quitToMenu(); }
    },
    onLost() {
      if (app.mode === 'online' || $('screen-lobby').classList.contains('active')) {
        cleanupOnline();
        showScreen('lost');
      }
    },
  });
  return app.net;
}

let dcTimer = null;
function startDcCountdown() {
  clearInterval(dcTimer);
  let left = 20;
  const el = $('dc-countdown');
  el.textContent = `(${left}s)`;
  dcTimer = setInterval(() => {
    left--;
    el.textContent = left > 0 ? `(${left}s)` : '';
    if (left <= 0) clearInterval(dcTimer);
  }, 1000);
}

function enterOnlineGame() {
  app.mode = 'online';
  app.names = ['YOU', 'FRIEND'];
  if (!app.game || app.ended) app.game = createGame();
  app.ended = app.game.phase === 'over';
  app.bot = null;
  app.paused = false;
  app.opponentDown = false;
  renderer.mirror = app.mySide === 1;
  input.setSide(app.mySide);
  input.enabled = true;
  hideAllOverlays();
  $('hud-mode').textContent = `FIRST TO 7 · ROOM ${app.net.code}`;
  $('btn-pause').style.display = '';
  showScreen('game');
  if (app.ended) showEnd(app.game.winner);
  app.running = true;
}

function updatePauseOverlay() {
  if (app.mode !== 'online' || app.ended) return;
  const paused = app.netPausedBy !== -1;
  setOverlay('overlay-pause', paused && !app.opponentDown);
  if (paused) {
    const mine = app.netPausedBy === app.mySide;
    $('pause-title').textContent = 'Paused';
    $('pause-sub').textContent = mine ? 'Take a breath.' : 'Your opponent paused the game.';
    $('btn-resume').textContent = mine ? 'Resume' : 'Waiting for opponent…';
    $('btn-resume').disabled = !mine;
  }
}

function cleanupOnline() {
  app.net?.leave();
  try { sessionStorage.removeItem('lt-session'); } catch {}
  app.mode = null;
  app.running = false;
  input.enabled = false;
  clearInterval(dcTimer);
  hideAllOverlays();
}

function quitToMenu() {
  if (app.mode === 'online') cleanupOnline();
  app.mode = null;
  app.running = false;
  app.paused = false;
  input.enabled = false;
  hideAllOverlays();
  resetLobby();
  showScreen('menu');
}

function resetLobby() {
  $('lobby-choice').classList.remove('hidden');
  $('lobby-waiting').classList.add('hidden');
  $('lobby-error').textContent = '';
  $('copy-feedback').textContent = '';
  $('input-join-code').value = '';
}

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------
let lastT = performance.now();
function frame(now) {
  requestAnimationFrame(frame);

// Lightweight read-only handle for automated tests / debugging.
window.__lt = {
  get state() {
    return {
      mode: app.mode, phase: app.game.phase, scores: [...app.game.scores],
      ball: { ...app.game.ball }, mySide: app.mySide, ended: app.ended,
      paused: app.paused, netPausedBy: app.netPausedBy,
      rackets: app.game.rackets.map(r => ({ x: r.x, y: r.y, angle: r.angle })),
    };
  },
};
  let dt = (now - lastT) / 1000;
  lastT = now;
  dt = Math.min(dt, 0.05);
  if (!app.running || !$('screen-game').classList.contains('active')) return;

  input.update(dt);

  if (app.mode === 'bot') {
    if (!app.paused && !app.ended) {
      app.bot.update(app.game, dt);
      step(app.game, dt);
      const events = app.game.events.splice(0);
      for (const ev of events) handleEvent(ev);
      // Countdown beeps
      if (app.game.phase === 'countdown') {
        const n = Math.ceil(app.game.phaseT);
        if (n !== app.lastCount && n > 0) { app.lastCount = n; sfx.count(); }
      } else app.lastCount = -1;
    }
  } else if (app.mode === 'online') {
    // Stream input at ~30 Hz. Re-send the latest target even without new
    // pointer events so the server always holds our current racket pose.
    app.inputThrottle -= dt;
    if (app.inputThrottle <= 0) {
      app.inputThrottle = 1 / 30;
      const x = input.mirror ? 900 - input.pos.x : input.pos.x;
      const a = input.mirror ? -input.angle : input.angle;
      app.net.input(x, input.pos.y, a);
      app.pendingTarget = null;
    }
    if (app.game.phase === 'countdown') {
      const n = Math.ceil(app.game.phaseT);
      if (n !== app.lastCount && n > 0) { app.lastCount = n; sfx.count(); }
    } else app.lastCount = -1;
  }

  updateHUD();
  renderer.draw(app.game, dt, app.mySide, app.names);
}
requestAnimationFrame(frame);

// Lightweight read-only handle for automated tests / debugging.
window.__lt = {
  get state() {
    return {
      mode: app.mode, phase: app.game.phase, scores: [...app.game.scores],
      ball: { ...app.game.ball }, mySide: app.mySide, ended: app.ended,
      paused: app.paused, netPausedBy: app.netPausedBy,
      rackets: app.game.rackets.map(r => ({ x: r.x, y: r.y, angle: r.angle })),
    };
  },
};

window.addEventListener('resize', () => renderer.resize());

// ---------------------------------------------------------------------------
// UI wiring
// ---------------------------------------------------------------------------
function click(id, fn) {
  $(id).addEventListener('click', () => { unlockAudio(); sfx.click(); fn(); });
}

click('btn-friend', () => { resetLobby(); showScreen('lobby'); maybeAutoJoin(); });
click('btn-bot', () => showScreen('bot'));
click('btn-lobby-back', () => { cleanupOnline(); resetLobby(); showScreen('menu'); });
click('btn-bot-back', () => showScreen('menu'));
click('btn-lost-menu', () => { resetLobby(); showScreen('menu'); });

document.querySelectorAll('.diff-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    unlockAudio(); sfx.click();
    startBotMode(btn.dataset.diff);
  });
});

click('btn-create-room', async () => {
  $('lobby-error').textContent = 'Connecting…';
  try {
    const net = ensureNet();
    await net.connect();
    $('lobby-error').textContent = '';
    net.create();
  } catch {
    $('lobby-error').textContent = 'Could not reach the server. Is it running?';
  }
});

click('btn-join-room', async () => {
  const code = $('input-join-code').value.trim().toUpperCase();
  if (code.length < 4) { $('lobby-error').textContent = 'Enter the 6-character room code.'; return; }
  await joinRoom(code);
});
$('input-join-code').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') $('btn-join-room').click();
});

async function joinRoom(code) {
  $('lobby-error').textContent = 'Connecting…';
  try {
    const net = ensureNet();
    await net.connect();
    $('lobby-error').textContent = '';
    // Reclaim our slot after a page reload if we hold a session token.
    let token = null;
    try {
      const saved = JSON.parse(sessionStorage.getItem('lt-session') || 'null');
      if (saved && saved.code === code) token = saved.token;
    } catch {}
    if (token) net.send({ t: 'join', code, token });
    else net.join(code);
  } catch {
    $('lobby-error').textContent = 'Could not reach the server.';
  }
}

click('btn-copy-link', async () => {
  const link = $('invite-link').value;
  let ok = false;
  try {
    await navigator.clipboard.writeText(link);
    ok = true;
  } catch {
    // Fallback for non-secure contexts.
    const inp = $('invite-link');
    inp.select();
    try { ok = document.execCommand('copy'); } catch { ok = false; }
    window.getSelection()?.removeAllRanges();
  }
  $('copy-feedback').textContent = ok ? '✓ Link copied — send it to your friend!' : 'Copy failed — select the link manually.';
});

// Pause / resume
function togglePause() {
  if (app.ended) return;
  if (app.mode === 'bot') {
    app.paused = !app.paused;
    setOverlay('overlay-pause', app.paused);
    if (app.paused) {
      $('pause-title').textContent = 'Paused';
      $('pause-sub').textContent = 'Take a breath.';
      $('btn-resume').textContent = 'Resume';
      $('btn-resume').disabled = false;
    }
  } else if (app.mode === 'online') {
    app.net.pause();
  }
}
click('btn-pause', togglePause);
click('btn-resume', () => {
  if (app.mode === 'bot') { app.paused = false; setOverlay('overlay-pause', false); }
  else if (app.mode === 'online' && app.netPausedBy === app.mySide) app.net.pause();
});
click('btn-pause-quit', quitToMenu);
click('btn-quit', quitToMenu);
click('btn-dc-quit', quitToMenu);
click('btn-end-menu', quitToMenu);

click('btn-rematch', () => {
  if (app.mode === 'bot') {
    app.ended = false;
    resetForRematch(app.game);
    app.bot.reset();
    hideAllOverlays();
    toast('Rematch!');
  } else if (app.mode === 'online') {
    if (app.opponentDown) { toast('Opponent is not connected'); return; }
    app.rematchVoted = true;
    $('btn-rematch').disabled = true;
    $('rematch-status').textContent = 'Waiting for opponent to accept…';
    app.net.rematch();
  }
});

click('btn-sound', () => {
  const on = !soundEnabled();
  setSoundEnabled(on);
  $('btn-sound').textContent = on ? '🔊' : '🔇';
  try { localStorage.setItem('lt-sound', on ? '1' : '0'); } catch {}
});
try {
  if (localStorage.getItem('lt-sound') === '0') { setSoundEnabled(false); $('btn-sound').textContent = '🔇'; }
} catch {}

window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && $('screen-game').classList.contains('active')) togglePause();
});

// Auto-pause bot games when the tab is hidden.
document.addEventListener('visibilitychange', () => {
  if (document.hidden && app.mode === 'bot' && !app.paused && !app.ended && app.running) togglePause();
});

// ---------------------------------------------------------------------------
// Invitation links: /join/CODE
// ---------------------------------------------------------------------------
function joinCodeFromUrl() {
  const m = location.pathname.match(/^\/join\/([A-Za-z0-9]{4,8})\/?$/);
  return m ? m[1].toUpperCase() : null;
}
function maybeAutoJoin() {
  const code = joinCodeFromUrl();
  if (code && !app.net?.code) joinRoom(code);
}
// Landing directly on an invite link: go straight to the lobby and join.
if (joinCodeFromUrl()) {
  showScreen('lobby');
  maybeAutoJoin();
}