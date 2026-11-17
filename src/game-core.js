// Shared deterministic game simulation.
// Used by the Node server (authoritative online play) and the browser (bot mode).
// Pure logic: no rendering, no timers. All units are court units (900 x 500) and seconds.

export const COURT = {
  W: 900,
  H: 500,
  GROUND: 468,        // y of the court floor
  NET_X: 450,
  NET_TOP: 386,       // top of the net
  NET_HALF_W: 4,
  BALL_R: 10,
  GRAVITY: 1500,
  RESTITUTION_GROUND: 0.74,
  AIR_DRAG: 0.045,    // per second, linear drag on vx
  MIN_SPEED: 340,
  MAX_SPEED: 1150,
  RACKET_LEN: 110,
  RACKET_HALF_THICK: 5,
  WIN_SCORE: 7,
  COUNTDOWN: 2.4,     // seconds before each serve
  POINT_PAUSE: 1.2,   // seconds the "point" banner shows
  // Racket movement zones (each player owns one half)
  ZONES: [
    { minX: 30, maxX: 436, minY: 120, maxY: 440 },
    { minX: 464, maxX: 870, minY: 120, maxY: 440 },
  ],
};

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

export function createGame() {
  return {
    phase: 'countdown',           // countdown | rally | point | over
    phaseT: COURT.COUNTDOWN,
    scores: [0, 0],
    server: 0,                    // who serves next
    lastWinner: -1,
    winner: -1,
    rallyHits: 0,
    ball: { x: 0, y: 0, vx: 0, vy: 0, spin: 0 },
    rackets: [
      { x: 170, y: 330, angle: -0.35, vx: 0, vy: 0 },
      { x: 730, y: 330, angle: 0.35, vx: 0, vy: 0 },
    ],
    // Targets set by input; the sim eases rackets toward them (speed-limited).
    targets: [
      { x: 170, y: 330, angle: -0.35 },
      { x: 730, y: 330, angle: 0.35 },
    ],
    bounces: 0,                   // ground bounces on the receiving side since last hit
    lastHitter: -1,
    events: [],                   // drained by the host each tick
    serveDir: 1,
  };
}

export function setRacketTarget(g, side, x, y, angle) {
  const z = COURT.ZONES[side];
  const t = g.targets[side];
  t.x = clamp(x, z.minX, z.maxX);
  t.y = clamp(y, z.minY, z.maxY);
  t.angle = clamp(Number.isFinite(angle) ? angle : (side === 0 ? -0.35 : 0.35), -1.25, 1.25);
}

export function racketSegment(r) {
  const hx = Math.cos(r.angle) * COURT.RACKET_LEN / 2;
  const hy = Math.sin(r.angle) * COURT.RACKET_LEN / 2;
  return { ax: r.x - hx, ay: r.y - hy, bx: r.x + hx, by: r.y + hy };
}

function pushEvent(g, type, data) {
  g.events.push({ type, ...data });
}

function startPoint(g) {
  g.phase = 'countdown';
  g.phaseT = COURT.COUNTDOWN;
  g.bounces = 0;
  g.lastHitter = -1;
  g.rallyHits = 0;
  const s = g.server;
  const r = g.rackets[s];
  g.ball.x = r.x;
  g.ball.y = r.y - 40;
  g.ball.vx = 0; g.ball.vy = 0;
  g.serveDir = s === 0 ? 1 : -1;
}

export function resetForRematch(g) {
  g.scores = [0, 0];
  g.winner = -1;
  g.lastWinner = -1;
  g.server = 0;
  startPoint(g);
}

function awardPoint(g, winner, reason) {
  g.scores[winner] += 1;
  g.lastWinner = winner;
  g.server = 1 - winner; // loser serves next
  pushEvent(g, 'point', { winner, reason, scores: [...g.scores] });
  if (g.scores[winner] >= COURT.WIN_SCORE) {
    g.phase = 'over';
    g.winner = winner;
    pushEvent(g, 'matchover', { winner, scores: [...g.scores] });
  } else {
    g.phase = 'point';
    g.phaseT = COURT.POINT_PAUSE;
  }
}

// Resolve a point when the ball becomes dead. `deadSide` = half where it died.
function resolveDead(g, deadSide, reason) {
  // If the ball died on the hitter's own side (net dribble, whiffed self-hit),
  // the opponent wins the point.
  let winner;
  if (g.lastHitter === -1) {
    winner = 1 - deadSide; // serve fault: receiver wins
  } else if (deadSide === g.lastHitter) {
    winner = 1 - g.lastHitter;
  } else {
    winner = g.lastHitter; // ball died on receiver side: double bounce / out
  }
  awardPoint(g, winner, reason);
}

function closestPointOnSegment(px, py, s) {
  const dx = s.bx - s.ax, dy = s.by - s.ay;
  const len2 = dx * dx + dy * dy || 1e-6;
  const t = clamp(((px - s.ax) * dx + (py - s.ay) * dy) / len2, 0, 1);
  return { x: s.ax + dx * t, y: s.ay + dy * t, t };
}

function hitRacket(g, side) {
  const r = g.rackets[side];
  const b = g.ball;
  const seg = racketSegment(r);
  const cp = closestPointOnSegment(b.x, b.y, seg);
  const dx = b.x - cp.x, dy = b.y - cp.y;
  const dist = Math.hypot(dx, dy);
  const minDist = COURT.BALL_R + COURT.RACKET_HALF_THICK;
  if (dist >= minDist) return false;

  // Normal: from racket toward ball; fall back to segment normal.
  let nx, ny;
  if (dist > 1e-4) { nx = dx / dist; ny = dy / dist; }
  else { nx = -Math.sin(r.angle); ny = Math.cos(r.angle); }

  // Only hit when moving toward the racket (relative velocity), avoids sticky re-hits.
  const rvx = b.vx - r.vx, rvy = b.vy - r.vy;
  const approach = rvx * nx + rvy * ny;
  if (approach > 40) return false;

  // Reflect incoming velocity about the racket normal.
  const dot = b.vx * nx + b.vy * ny;
  let vx = b.vx - 2 * dot * nx;
  let vy = b.vy - 2 * dot * ny;

  // Swing momentum: racket velocity adds power.
  vx += r.vx * 0.55;
  vy += r.vy * 0.55;

  // Contact offset steers the shot (tip hits add lift/angle).
  const offset = (cp.t - 0.5) * 2; // -1..1 along the racket
  vy -= Math.abs(offset) * 90 * (side === 0 ? 1 : 1);

  // Guarantee the return travels toward the opponent and clears reasonably.
  const dir = side === 0 ? 1 : -1;
  if (vx * dir < 120) vx = dir * (160 + Math.abs(vx) * 0.4);
  if (vy > -120) vy = -120 - Math.random() * 60 - Math.abs(r.vy) * 0.2;

  let speed = Math.hypot(vx, vy);
  const target = clamp(speed * 1.04 + 30, COURT.MIN_SPEED, COURT.MAX_SPEED);
  vx = vx / speed * target;
  vy = vy / speed * target;

  b.vx = vx; b.vy = vy;
  // Push ball out of the racket to prevent double collision.
  b.x = cp.x + nx * (minDist + 1);
  b.y = cp.y + ny * (minDist + 1);

  g.lastHitter = side;
  g.bounces = 0;
  g.rallyHits += 1;
  pushEvent(g, 'hit', { side, x: b.x, y: b.y, speed: target });
  return true;
}

export function step(g, dt) {
  // Ease rackets toward targets with a max speed (feels responsive but fair).
  const MAX_RACKET_SPEED = 2600;
  for (let i = 0; i < 2; i++) {
    const r = g.rackets[i], t = g.targets[i];
    let dx = t.x - r.x, dy = t.y - r.y;
    const d = Math.hypot(dx, dy);
    const maxStep = MAX_RACKET_SPEED * dt;
    let mvx = 0, mvy = 0;
    if (d > 0.01) {
      const stepLen = Math.min(d, maxStep);
      mvx = dx / d * stepLen; mvy = dy / d * stepLen;
      r.x += mvx; r.y += mvy;
    }
    r.vx = mvx / dt; r.vy = mvy / dt;
    // Angle eases quickly.
    r.angle += (t.angle - r.angle) * Math.min(1, dt * 18);
  }

  if (g.phase === 'countdown') {
    g.phaseT -= dt;
    const r = g.rackets[g.server];
    g.ball.x = r.x; g.ball.y = r.y - 40;
    if (g.phaseT <= 0) {
      g.phase = 'rally';
      const dir = g.serveDir;
      g.ball.vx = dir * (430 + Math.random() * 60);
      g.ball.vy = -(430 + Math.random() * 90);
      g.lastHitter = g.server;
      g.bounces = 0;
      pushEvent(g, 'serve', { side: g.server });
    }
    return;
  }

  if (g.phase === 'point') {
    g.phaseT -= dt;
    if (g.phaseT <= 0) startPoint(g);
    return;
  }

  if (g.phase !== 'rally') return;

  const b = g.ball;
  // Integrate with substeps so fast balls never tunnel through rackets/net.
  const speed = Math.hypot(b.vx, b.vy);
  const sub = Math.max(1, Math.ceil((speed * dt) / 6));
  const h = dt / sub;

  for (let s = 0; s < sub; s++) {
    b.vy += COURT.GRAVITY * h;
    b.vx -= b.vx * COURT.AIR_DRAG * h;
    b.x += b.vx * h;
    b.y += b.vy * h;

    // Side walls: out of bounds -> point resolution.
    if (b.x < -COURT.BALL_R * 2 || b.x > COURT.W + COURT.BALL_R * 2) {
      const deadSide = b.x < 0 ? 0 : 1;
      // Long shot past the baseline: if it already bounced on that side, receiver failed.
      resolveDead(g, deadSide, 'out');
      return;
    }
    // Ceiling: soft bounce keeps rallies alive.
    if (b.y < COURT.BALL_R) {
      b.y = COURT.BALL_R;
      b.vy = Math.abs(b.vy) * 0.65;
      pushEvent(g, 'wall', { x: b.x, y: 0 });
    }

    // Net collision (vertical slab from NET_TOP to GROUND).
    const netL = COURT.NET_X - COURT.NET_HALF_W, netR = COURT.NET_X + COURT.NET_HALF_W;
    if (b.x + COURT.BALL_R > netL && b.x - COURT.BALL_R < netR && b.y + COURT.BALL_R > COURT.NET_TOP) {
      if (b.y < COURT.NET_TOP + COURT.BALL_R && b.vy > 0) {
        // Clipped the tape: small deflection upward.
        b.y = COURT.NET_TOP - COURT.BALL_R;
        b.vy = -Math.abs(b.vy) * 0.45;
        b.vx *= 0.55;
        pushEvent(g, 'net', { x: COURT.NET_X, y: COURT.NET_TOP });
      } else {
        b.x = b.vx > 0 ? netL - COURT.BALL_R : netR + COURT.BALL_R;
        b.vx = -b.vx * 0.35;
        pushEvent(g, 'net', { x: COURT.NET_X, y: b.y });
      }
    }

    // Ground bounce.
    if (b.y + COURT.BALL_R >= COURT.GROUND) {
      b.y = COURT.GROUND - COURT.BALL_R;
      b.vy = -Math.abs(b.vy) * COURT.RESTITUTION_GROUND;
      b.vx *= 0.96;
      const side = b.x < COURT.NET_X ? 0 : 1;
      pushEvent(g, 'bounce', { x: b.x, y: COURT.GROUND, side });
      if (g.lastHitter === -1) {
        resolveDead(g, side, 'fault');
        return;
      }
      if (side === g.lastHitter) {
        // Bounced back on the hitter's own side (net dribble) -> opponent point.
        resolveDead(g, side, 'net');
        return;
      }
      g.bounces += 1;
      if (g.bounces >= 2) {
        resolveDead(g, side, 'doublebounce');
        return;
      }
      if (Math.abs(b.vy) < 60 && Math.abs(b.vx) < 60) {
        resolveDead(g, side, 'dead');
        return;
      }
    }

    // Rackets: only the owner of the half the ball is in can hit it.
    const half = b.x < COURT.NET_X ? 0 : 1;
    hitRacket(g, half);
    if (g.phase !== 'rally') return;
  }
}

// Compact serialisable snapshot for the network (client renders from this).
export function snapshot(g) {
  return {
    ph: g.phase,
    pt: +g.phaseT.toFixed(2),
    sc: g.scores,
    sv: g.server,
    w: g.winner,
    lw: g.lastWinner,
    rh: g.rallyHits,
    b: { x: +g.ball.x.toFixed(1), y: +g.ball.y.toFixed(1), vx: +g.ball.vx.toFixed(1), vy: +g.ball.vy.toFixed(1) },
    r: g.rackets.map(r => ({ x: +r.x.toFixed(1), y: +r.y.toFixed(1), a: +r.angle.toFixed(3) })),
  };
}

export function applySnapshot(g, s) {
  g.phase = s.ph; g.phaseT = s.pt;
  g.scores = s.sc; g.server = s.sv; g.winner = s.w; g.lastWinner = s.lw;
  g.rallyHits = s.rh;
  g.ball.x = s.b.x; g.ball.y = s.b.y; g.ball.vx = s.b.vx; g.ball.vy = s.b.vy;
  for (let i = 0; i < 2; i++) {
    g.rackets[i].x = s.r[i].x; g.rackets[i].y = s.r[i].y; g.rackets[i].angle = s.r[i].a;
  }
}