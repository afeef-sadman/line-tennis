// Canvas renderer: minimalist side-view court, rackets as glowing lines,
// ball with trail, particles and on-court banners. Pure drawing, no logic.
import { COURT, racketSegment } from './game-core.js';

const COLORS = {
  bgTop: '#152233',
  bgBottom: '#0f1826',
  court: '#16324a',
  courtLine: '#2e5f86',
  ground: '#1d4260',
  net: '#3d6d94',
  netTape: '#e6edf3',
  left: '#4fd1c5',
  right: '#f6ad55',
  ball: '#f5f0e6',
  text: '#e6edf3',
  dim: 'rgba(230,237,243,.55)',
};

export class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.particles = [];
    this.trail = [];
    this.flashes = [];      // boundary/net flash effects
    this.banner = null;     // { text, sub, t, dur, color }
    this.shake = 0;
    this.mirror = false;    // online guest views their own racket on the left
    this.resize();
  }

  resize() {
    const rect = this.canvas.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.canvas.width = Math.max(1, Math.round(rect.width * dpr));
    this.canvas.height = Math.max(1, Math.round(rect.height * dpr));
    this.scale = this.canvas.width / COURT.W;
  }

  // Convert a client (mouse/touch) position to DISPLAY court coords.
  // Mirroring happens at render time; input stays in display space so the
  // racket follows the pointer exactly. Input converts to server coords once.
  toCourt(clientX, clientY) {
    const rect = this.canvas.getBoundingClientRect();
    const x = (clientX - rect.left) / rect.width * COURT.W;
    const y = (clientY - rect.top) / rect.height * COURT.H;
    return { x, y };
  }

  addHitEffect(x, y, color, speed) {
    const n = Math.min(14, 6 + Math.floor(speed / 150));
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const v = 60 + Math.random() * 220;
      this.particles.push({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, life: 0.4 + Math.random() * 0.25, t: 0, color, size: 1.5 + Math.random() * 2.5 });
    }
    this.shake = Math.min(6, 2 + speed / 300);
  }

  addBounceEffect(x, y) {
    for (let i = 0; i < 6; i++) {
      const a = -Math.PI * (0.15 + Math.random() * 0.7);
      const v = 40 + Math.random() * 120;
      this.particles.push({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, life: 0.35, t: 0, color: COLORS.courtLine, size: 1.5 + Math.random() * 2 });
    }
  }

  addFlash(x, y, color) { this.flashes.push({ x, y, t: 0, dur: 0.35, color }); }

  showBanner(text, sub, dur, color) { this.banner = { text, sub, t: 0, dur, color: color || COLORS.text }; }

  handleEvent(ev, mySide) {
    const mine = (s) => s === mySide;
    switch (ev.type) {
      case 'hit':
        this.addHitEffect(ev.x, ev.y, mine(ev.side) ? COLORS.left : COLORS.right, ev.speed);
        break;
      case 'bounce': this.addBounceEffect(ev.x, ev.y); break;
      case 'net': this.addFlash(COURT.NET_X, ev.y, COLORS.netTape); break;
      case 'wall': this.addFlash(ev.x, 4, COLORS.courtLine); break;
      case 'point': {
        const win = mine(ev.winner);
        this.showBanner(win ? 'YOUR POINT' : 'OPPONENT POINT', this.reasonText(ev.reason), COURT.POINT_PAUSE + 0.4, win ? COLORS.left : COLORS.right);
        break;
      }
    }
  }

  reasonText(reason) {
    switch (reason) {
      case 'doublebounce': return 'Double bounce';
      case 'out': return 'Ball out';
      case 'net': return 'Into the net';
      case 'fault': return 'Service fault';
      default: return '';
    }
  }

  draw(g, dt, mySide, names) {
    const ctx = this.ctx;
    const S = this.scale;
    ctx.save();
    ctx.scale(S, S);

    // Camera shake
    if (this.shake > 0.1) {
      ctx.translate((Math.random() - 0.5) * this.shake, (Math.random() - 0.5) * this.shake);
      this.shake *= Math.pow(0.001, dt);
    }

    // Mirroring for the online guest so their racket is always on the left.
    if (this.mirror) { ctx.translate(COURT.W, 0); ctx.scale(-1, 1); }

    this.drawCourt(ctx);

    // Trail
    if (g.phase === 'rally') {
      this.trail.push({ x: g.ball.x, y: g.ball.y, t: 0 });
      if (this.trail.length > 16) this.trail.shift();
    } else if (g.phase !== 'point') {
      this.trail.length = 0;
    }
    for (const p of this.trail) p.t += dt;
    this.trail = this.trail.filter(p => p.t < 0.28);
    for (let i = 0; i < this.trail.length; i++) {
      const p = this.trail[i];
      const a = (1 - p.t / 0.28) * 0.25 * (i / this.trail.length);
      ctx.fillStyle = `rgba(245,240,230,${a.toFixed(3)})`;
      ctx.beginPath();
      ctx.arc(p.x, p.y, COURT.BALL_R * (0.4 + 0.6 * i / this.trail.length), 0, Math.PI * 2);
      ctx.fill();
    }

    // Rackets
    this.drawRacket(ctx, g.rackets[0], mySide === 0 ? COLORS.left : COLORS.right);
    this.drawRacket(ctx, g.rackets[1], mySide === 1 ? COLORS.left : COLORS.right);

    // Ball (hide during point banner)
    if (g.phase === 'rally' || g.phase === 'countdown') {
      const b = g.ball;
      // shadow
      const shAlpha = Math.max(0, 0.35 * (1 - (COURT.GROUND - b.y) / 400));
      ctx.fillStyle = `rgba(0,0,0,${shAlpha.toFixed(3)})`;
      ctx.beginPath();
      ctx.ellipse(b.x, COURT.GROUND + 4, COURT.BALL_R * 1.2, 3.5, 0, 0, Math.PI * 2);
      ctx.fill();

      ctx.save();
      ctx.shadowColor = 'rgba(245,240,230,.7)';
      ctx.shadowBlur = 14;
      ctx.fillStyle = COLORS.ball;
      ctx.beginPath();
      ctx.arc(b.x, b.y, COURT.BALL_R, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
      // seam
      ctx.strokeStyle = 'rgba(160,150,120,.5)';
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.arc(b.x - 3, b.y, COURT.BALL_R * 0.85, -0.9, 0.9);
      ctx.stroke();
    }

    // Particles
    for (const p of this.particles) {
      p.t += dt;
      p.x += p.vx * dt; p.y += p.vy * dt;
      p.vy += 500 * dt;
    }
    this.particles = this.particles.filter(p => p.t < p.life);
    for (const p of this.particles) {
      ctx.globalAlpha = 1 - p.t / p.life;
      ctx.fillStyle = p.color;
      ctx.fillRect(p.x - p.size / 2, p.y - p.size / 2, p.size, p.size);
    }
    ctx.globalAlpha = 1;

    // Flashes (net / boundary feedback)
    for (const f of this.flashes) f.t += dt;
    this.flashes = this.flashes.filter(f => f.t < f.dur);
    for (const f of this.flashes) {
      const k = f.t / f.dur;
      ctx.strokeStyle = f.color;
      ctx.globalAlpha = (1 - k) * 0.8;
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.arc(f.x, f.y, 6 + k * 34, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;

    // Countdown — drawn unmirrored for readable text.
    if (this.mirror) { ctx.scale(-1, 1); ctx.translate(-COURT.W, 0); }

    if (g.phase === 'countdown') {
      const n = Math.ceil(g.phaseT);
      const frac = g.phaseT - Math.floor(g.phaseT);
      ctx.save();
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = COLORS.text;
      ctx.globalAlpha = 0.5 + 0.5 * frac;
      ctx.font = `800 ${64 + (1 - frac) * 14}px "Segoe UI", system-ui, sans-serif`;
      ctx.fillText(n > 0 ? String(n) : 'GO', COURT.W / 2, 180);
      ctx.globalAlpha = 0.75;
      ctx.font = '600 17px "Segoe UI", system-ui, sans-serif';
      const servingName = g.server === mySide ? 'Your serve' : `${names[1 - mySide]} serves`;
      ctx.fillText(servingName, COURT.W / 2, 235);
      ctx.restore();
    }

    // Banner (point results)
    if (this.banner) {
      this.banner.t += dt;
      if (this.banner.t >= this.banner.dur) this.banner = null;
      else {
        const b = this.banner;
        const k = b.t / b.dur;
        const alpha = k < 0.1 ? k / 0.1 : k > 0.8 ? (1 - k) / 0.2 : 1;
        ctx.save();
        ctx.textAlign = 'center';
        ctx.globalAlpha = alpha;
        ctx.fillStyle = b.color;
        ctx.font = '800 40px "Segoe UI", system-ui, sans-serif';
        ctx.fillText(b.text, COURT.W / 2, 180);
        if (b.sub) {
          ctx.fillStyle = COLORS.dim;
          ctx.font = '600 17px "Segoe UI", system-ui, sans-serif';
          ctx.fillText(b.sub, COURT.W / 2, 215);
        }
        ctx.restore();
      }
    }

    ctx.restore();
  }

  drawCourt(ctx) {
    // Sky gradient
    const grad = ctx.createLinearGradient(0, 0, 0, COURT.H);
    grad.addColorStop(0, COLORS.bgTop);
    grad.addColorStop(1, COLORS.bgBottom);
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, COURT.W, COURT.H);

    // Court floor
    ctx.fillStyle = COLORS.court;
    ctx.fillRect(0, COURT.GROUND, COURT.W, COURT.H - COURT.GROUND);
    ctx.fillStyle = COLORS.ground;
    ctx.fillRect(0, COURT.GROUND, COURT.W, 4);

    // Court markings
    ctx.strokeStyle = COLORS.courtLine;
    ctx.lineWidth = 2;
    ctx.setLineDash([10, 12]);
    ctx.beginPath();
    ctx.moveTo(40, COURT.GROUND + 16);
    ctx.lineTo(COURT.W - 40, COURT.GROUND + 16);
    ctx.stroke();
    ctx.setLineDash([]);
    // service marks
    for (const x of [180, 360, 540, 720]) {
      ctx.beginPath();
      ctx.moveTo(x, COURT.GROUND + 8);
      ctx.lineTo(x, COURT.GROUND + 24);
      ctx.stroke();
    }

    // Net
    ctx.fillStyle = COLORS.net;
    ctx.fillRect(COURT.NET_X - COURT.NET_HALF_W, COURT.NET_TOP, COURT.NET_HALF_W * 2, COURT.GROUND - COURT.NET_TOP);
    // mesh hint
    ctx.strokeStyle = 'rgba(230,237,243,.14)';
    ctx.lineWidth = 1;
    for (let y = COURT.NET_TOP + 10; y < COURT.GROUND; y += 12) {
      ctx.beginPath();
      ctx.moveTo(COURT.NET_X - COURT.NET_HALF_W, y);
      ctx.lineTo(COURT.NET_X + COURT.NET_HALF_W, y);
      ctx.stroke();
    }
    // tape
    ctx.fillStyle = COLORS.netTape;
    ctx.fillRect(COURT.NET_X - COURT.NET_HALF_W - 2, COURT.NET_TOP - 4, COURT.NET_HALF_W * 2 + 4, 6);

    // Half-zone hint lines (very subtle)
    ctx.fillStyle = 'rgba(79,209,197,.05)';
    ctx.fillRect(0, 0, COURT.NET_X - 6, COURT.GROUND);
    ctx.fillStyle = 'rgba(246,173,85,.05)';
    ctx.fillRect(COURT.NET_X + 6, 0, COURT.W - COURT.NET_X - 6, COURT.GROUND);
  }

  drawRacket(ctx, r, color) {
    const seg = racketSegment(r);
    ctx.save();
    ctx.lineCap = 'round';
    ctx.shadowColor = color;
    ctx.shadowBlur = 16;
    ctx.strokeStyle = color;
    ctx.lineWidth = COURT.RACKET_HALF_THICK * 2;
    ctx.beginPath();
    ctx.moveTo(seg.ax, seg.ay);
    ctx.lineTo(seg.bx, seg.by);
    ctx.stroke();
    // grip dot at center
    ctx.shadowBlur = 0;
    ctx.fillStyle = 'rgba(13,17,23,.55)';
    ctx.beginPath();
    ctx.arc(r.x, r.y, 3.2, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }
}