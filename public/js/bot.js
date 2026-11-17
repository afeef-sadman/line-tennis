// Bot opponent with human-like limitations.
// Predicts the ball trajectory, moves toward an intercept point with limited
// speed and reaction delay, and aims its racket with difficulty-scaled error.
import { COURT, setRacketTarget } from './game-core.js';

const PROFILES = {
  easy: {
    reaction: 0.45,       // seconds before reacting to a new shot
    speed: 380,           // max racket travel speed (court units/s)
    aimError: 95,         // px of positional noise
    angleError: 0.5,      // radians of racket tilt noise
    predictHorizon: 0.35, // how far ahead it predicts (s)
    missChance: 0.16,     // chance to misjudge a shot outright
    idleX: 720, idleY: 330,
  },
  medium: {
    reaction: 0.24,
    speed: 640,
    aimError: 48,
    angleError: 0.26,
    predictHorizon: 0.55,
    missChance: 0.07,
    idleX: 720, idleY: 320,
  },
  hard: {
    reaction: 0.11,
    speed: 980,
    aimError: 20,
    angleError: 0.12,
    predictHorizon: 0.8,
    missChance: 0.025,
    idleX: 710, idleY: 310,
  },
};

export class Bot {
  constructor(difficulty = 'medium', side = 1) {
    this.p = PROFILES[difficulty] || PROFILES.medium;
    this.side = side;
    this.reset();
  }

  reset() {
    this.reactT = 0;
    this.plan = null;        // { x, y, angle }
    this.errX = 0; this.errY = 0; this.errA = 0;
    this.willMiss = false;
    this.lastRallyHits = -1;
    this.pos = { x: this.p.idleX, y: this.p.idleY };
    this.angle = 0.35;
    this.replanT = 0;
  }

  // Simulate ball forward to find where it will be reachable on the bot's half.
  predict(ball, horizon) {
    let { x, y, vx, vy } = ball;
    const h = 1 / 90;
    let best = null;
    for (let t = 0; t < horizon; t += h) {
      vy += COURT.GRAVITY * h;
      vx -= vx * COURT.AIR_DRAG * h;
      x += vx * h; y += vy * h;
      if (y + COURT.BALL_R >= COURT.GROUND) {
        y = COURT.GROUND - COURT.BALL_R;
        vy = -Math.abs(vy) * COURT.RESTITUTION_GROUND;
        vx *= 0.96;
      }
      // Net block in prediction
      if (Math.abs(x - COURT.NET_X) < COURT.NET_HALF_W + COURT.BALL_R && y > COURT.NET_TOP) {
        vx = -vx * 0.35;
        x = x < COURT.NET_X ? COURT.NET_X - 14 : COURT.NET_X + 14;
      }
      const onMySide = this.side === 1 ? x > COURT.NET_X + 30 : x < COURT.NET_X - 30;
      if (onMySide && vx * (this.side === 1 ? 1 : -1) > -50) {
        // Prefer intercepting at a comfortable strike height.
        const score = Math.abs(y - 330) + t * 120;
        if (!best || score < best.score) best = { x, y: Math.min(y, COURT.GROUND - 30), t, score };
      }
    }
    return best;
  }

  update(g, dt) {
    const p = this.p;
    const incoming = g.phase === 'rally' && g.lastHitter !== this.side;

    // New shot detected -> start reaction timer and roll a fresh error budget.
    if (g.rallyHits !== this.lastRallyHits) {
      this.lastRallyHits = g.rallyHits;
      this.reactT = p.reaction * (0.7 + Math.random() * 0.6);
      this.errX = (Math.random() * 2 - 1) * p.aimError;
      this.errY = (Math.random() * 2 - 1) * p.aimError * 0.7;
      this.errA = (Math.random() * 2 - 1) * p.angleError;
      this.willMiss = Math.random() < p.missChance;
      this.plan = null;
    }

    let tx = p.idleX, ty = p.idleY, ta = this.side === 1 ? 0.35 : -0.35;

    if (g.phase === 'countdown' && g.server === this.side) {
      // Move to a sane serving spot.
      tx = this.side === 1 ? 740 : 160; ty = 300;
    } else if (incoming) {
      this.reactT -= dt;
      if (this.reactT <= 0) {
        this.replanT -= dt;
        if (this.replanT <= 0 || !this.plan) {
          this.replanT = 0.09;
          const pred = this.predict(g.ball, p.predictHorizon);
          if (pred) {
            this.plan = {
              x: pred.x + this.errX + (this.willMiss ? 130 * (this.side === 1 ? 1 : -1) : 0),
              y: pred.y + this.errY + (this.willMiss ? 90 : 0),
            };
          }
        }
        if (this.plan) {
          tx = this.plan.x; ty = this.plan.y;
          // Aim: tilt racket to send the ball up and over toward the other half.
          // Steeper tilt when the ball is low or close to the net.
          const nearNet = Math.abs(g.ball.x - COURT.NET_X) < 160;
          const base = this.side === 1 ? 0.42 : -0.42;
          ta = base + (nearNet ? (this.side === 1 ? 0.25 : -0.25) : 0) + this.errA;
        }
      }
    } else if (g.phase === 'rally') {
      // Ball on our side after our own hit: recover toward idle.
      tx = p.idleX; ty = p.idleY;
    }

    // Move our virtual pointer toward the target with limited speed.
    const z = COURT.ZONES[this.side];
    tx = Math.max(z.minX, Math.min(z.maxX, tx));
    ty = Math.max(z.minY, Math.min(z.maxY, ty));
    const dx = tx - this.pos.x, dy = ty - this.pos.y;
    const d = Math.hypot(dx, dy);
    const maxStep = p.speed * dt;
    if (d > 1) {
      const s = Math.min(d, maxStep);
      this.pos.x += dx / d * s;
      this.pos.y += dy / d * s;
    }
    this.angle += (ta - this.angle) * Math.min(1, dt * 8);
    setRacketTarget(g, this.side, this.pos.x, this.pos.y, this.angle);
  }
}