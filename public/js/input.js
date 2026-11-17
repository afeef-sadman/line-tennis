// Pointer input: the racket follows the pointer; angle via wheel, A/D keys,
// or a second touch finger (two-finger vertical offset tilts the racket).
export class Input {
  constructor(canvas, renderer, onTarget) {
    this.canvas = canvas;
    this.renderer = renderer;
    this.onTarget = onTarget;   // (x, y, angle) in *server-side* court coords
    this.angle = -0.35;
    this.pos = { x: 170, y: 330 };
    this.enabled = false;
    this.mirror = false;        // guest: screen-left is server-right
    this.touches = new Map();
    this.keys = new Set();
    this.dirty = true;

    canvas.addEventListener('pointermove', (e) => this.onPointer(e));
    canvas.addEventListener('pointerdown', (e) => {
      try { canvas.setPointerCapture?.(e.pointerId); } catch { /* synthetic or inactive pointer */ }
      this.onPointer(e);
    });
    canvas.addEventListener('pointerup', (e) => { this.touches.delete(e.pointerId); });
    canvas.addEventListener('pointercancel', (e) => { this.touches.delete(e.pointerId); });
    canvas.addEventListener('wheel', (e) => {
      if (!this.enabled) return;
      e.preventDefault();
      this.angle += Math.sign(e.deltaY) * 0.09 * (this.mirror ? -1 : 1);
      this.clampAngle();
      this.dirty = true;
    }, { passive: false });

    window.addEventListener('keydown', (e) => {
      if (!this.enabled) return;
      const k = e.key.toLowerCase();
      if (k === 'a' || k === 'd' || k === 'arrowleft' || k === 'arrowright') {
        this.keys.add(k);
        e.preventDefault();
      }
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.key.toLowerCase()));
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  clampAngle() { this.angle = Math.max(-1.25, Math.min(1.25, this.angle)); }

  onPointer(e) {
    if (!this.enabled) return;
    const rect = this.canvas.getBoundingClientRect();
    // Track raw screen-court position (unmirrored) for two-finger tilt math.
    const sx = (e.clientX - rect.left) / rect.width * 900;
    const sy = (e.clientY - rect.top) / rect.height * 500;

    if (e.pointerType === 'touch') {
      this.touches.set(e.pointerId, { x: sx, y: sy });
      if (this.touches.size >= 2) {
        // Second finger: tilt based on vertical offset between fingers.
        const pts = [...this.touches.values()];
        const dy = pts[1].y - pts[0].y;
        const dx = pts[1].x - pts[0].x;
        let a = Math.atan2(dy, dx);
        if (a > Math.PI / 2) a -= Math.PI;
        if (a < -Math.PI / 2) a += Math.PI;
        this.angle = a * (this.mirror ? -1 : 1);
        this.clampAngle();
        this.dirty = true;
        return; // don't move the racket while tilting
      }
    }

    const p = this.renderer.toCourt(e.clientX, e.clientY); // display coords
    this.pos.x = p.x; this.pos.y = p.y;
    this.dirty = true;
  }

  // Called every frame: apply key tilt and emit target in server coordinates.
  update(dt) {
    if (!this.enabled) return;
    const tilt = (this.keys.has('a') || this.keys.has('arrowleft') ? -1 : 0)
               + (this.keys.has('d') || this.keys.has('arrowright') ? 1 : 0);
    if (tilt) {
      this.angle += tilt * 2.2 * dt * (this.mirror ? -1 : 1);
      this.clampAngle();
      this.dirty = true;
    }
    if (!this.dirty) return;
    this.dirty = false;
    // Convert display coords -> server coords for mirrored guests.
    const x = this.mirror ? 900 - this.pos.x : this.pos.x;
    const a = this.mirror ? -this.angle : this.angle;
    this.onTarget(x, this.pos.y, a);
  }

  setSide(side) {
    this.mirror = side === 1;
    this.angle = side === 1 ? 0.35 : -0.35;
    this.pos = { x: 170, y: 330 };
    this.dirty = true;
  }
}