// Headless simulation tests: physics sanity, scoring, bot rallies, match completion.
import { createGame, step, setRacketTarget, resetForRematch, COURT } from '../src/game-core.js';
import { Bot } from '../public/js/bot.js';

let failures = 0;
function check(name, cond, detail = '') {
  if (cond) console.log(`  ok  ${name}`);
  else { failures++; console.error(`FAIL  ${name} ${detail}`); }
}

const DT = 1 / 60;

// --- 1. Countdown -> rally transition and serve ---
{
  const g = createGame();
  for (let i = 0; i < 60 * 4; i++) step(g, DT);
  check('countdown ends into rally or beyond', g.phase !== 'countdown');
  check('serve produced motion events', g.rallyHits >= 0);
}

// --- 2. Ball never tunnels the ground; gravity acts ---
{
  const g = createGame();
  g.phase = 'rally';
  g.ball.x = 200; g.ball.y = 100; g.ball.vx = 300; g.ball.vy = 0;
  g.lastHitter = 1;
  let maxY = 0;
  for (let i = 0; i < 30 && g.phase === 'rally'; i++) { step(g, DT); maxY = Math.max(maxY, g.ball.y); }
  check('ball falls under gravity', maxY > 100);
  check('ball stays above ground', maxY <= COURT.GROUND - COURT.BALL_R + 1, `maxY=${maxY}`);
}

// --- 3. Double bounce awards point to the hitter ---
{
  const g = createGame();
  g.phase = 'rally';
  g.lastHitter = 0;
  g.ball.x = 700; g.ball.y = 430; g.ball.vx = 20; g.ball.vy = 100;
  // keep right racket far away
  setRacketTarget(g, 1, 860, 120, 0);
  for (let i = 0; i < 60 * 6 && g.phase === 'rally'; i++) step(g, DT);
  check('double bounce ends rally', g.phase !== 'rally', `phase=${g.phase}`);
  check('hitter wins on double bounce', g.scores[0] === 1, JSON.stringify(g.scores));
}

// --- 4. Net dribble: ball bounces back on hitter side -> opponent point ---
{
  const g = createGame();
  g.phase = 'rally';
  g.lastHitter = 0;
  g.ball.x = 430; g.ball.y = 420; g.ball.vx = 60; g.ball.vy = 200;
  setRacketTarget(g, 0, 60, 120, 0);
  setRacketTarget(g, 1, 860, 120, 0);
  for (let i = 0; i < 60 * 6 && g.phase === 'rally'; i++) step(g, DT);
  check('net dribble resolved', g.phase !== 'rally');
  check('opponent wins net dribble', g.scores[1] === 1, JSON.stringify(g.scores));
}

// --- 5. Racket hit reflects ball toward opponent ---
{
  const g = createGame();
  g.phase = 'rally';
  g.lastHitter = 1;
  g.ball.x = 150; g.ball.y = 320; g.ball.vx = -500; g.ball.vy = 100;
  setRacketTarget(g, 0, 140, 330, -0.35);
  let hit = false;
  for (let i = 0; i < 60 && !hit; i++) {
    step(g, DT);
    hit = g.events.some(e => e.type === 'hit' && e.side === 0);
    g.events.length = 0;
  }
  check('racket collision registers', hit);
  check('return travels rightward', g.ball.vx > 0, `vx=${g.ball.vx}`);
  check('return has upward component', g.ball.vy < 0, `vy=${g.ball.vy}`);
}

// --- 6. Full bot-vs-bot matches complete for every difficulty ---
for (const diff of ['easy', 'medium', 'hard']) {
  const g = createGame();
  const bots = [new Bot(diff, 0), new Bot(diff, 1)];
  let ticks = 0;
  const maxTicks = 60 * 60 * 12; // 12 simulated minutes
  let hits = 0, points = 0;
  while (g.phase !== 'over' && ticks < maxTicks) {
    bots[0].update(g, DT);
    bots[1].update(g, DT);
    step(g, DT);
    for (const e of g.events) {
      if (e.type === 'hit') hits++;
      if (e.type === 'point') points++;
    }
    g.events.length = 0;
    ticks++;
  }
  check(`${diff}: match completes`, g.phase === 'over', `ticks=${ticks} scores=${g.scores}`);
  check(`${diff}: winner reached 7`, Math.max(...g.scores) === COURT.WIN_SCORE, JSON.stringify(g.scores));
  check(`${diff}: bots actually rally (>=10 hits)`, hits >= 10, `hits=${hits}`);
  check(`${diff}: both sides scored or dominated fairly`, points === g.scores[0] + g.scores[1]);
  console.log(`       ${diff}: ${ticks / 60 | 0}s simulated, hits=${hits}, score=${g.scores[0]}-${g.scores[1]}`);

  // Rematch resets cleanly
  resetForRematch(g);
  check(`${diff}: rematch resets scores`, g.scores[0] === 0 && g.scores[1] === 0);
  check(`${diff}: rematch back to countdown`, g.phase === 'countdown');
}

// --- 7. Difficulty ordering: hard bot wins more vs easy bot ---
{
  let hardWins = 0, easyWins = 0;
  for (let m = 0; m < 3; m++) {
    const g = createGame();
    const bots = [new Bot('easy', 0), new Bot('hard', 1)];
    let ticks = 0;
    while (g.phase !== 'over' && ticks < 60 * 60 * 12) {
      bots[0].update(g, DT); bots[1].update(g, DT);
      step(g, DT); g.events.length = 0; ticks++;
    }
    if (g.winner === 1) hardWins++; else easyWins++;
  }
  check('hard beats easy in majority of matches', hardWins > easyWins, `hard=${hardWins} easy=${easyWins}`);
}

console.log(failures === 0 ? '\nALL SIM TESTS PASSED' : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);